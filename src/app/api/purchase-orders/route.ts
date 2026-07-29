import { getDb, generateId, updateMaterialPrice } from '@/lib/db';
import { getCurrentOutletId, getCurrentUser } from '@/lib/auth';
import { centralFlowBlock } from '@/lib/store-engine';
import { effectiveRole, effectiveActor, recalcTotal, poWriteGate, duplicateLineError } from '@/lib/po-helpers';

/** Phase B store guard for PO composition (create/edit are interactive, so we
 *  reject the request with a clear message instead of silently dropping lines).
 *  Store-mapped materials (liquor) are procured on the store ledger, never on
 *  Central Store POs. Historical POs are untouched (receive skips their lines). */
function storeBlockedError(db: ReturnType<typeof getDb>, items: any[]): string | null {
  for (const it of items || []) {
    const msg = centralFlowBlock(db, String(it?.material_id || ''));
    if (msg) return msg;
  }
  return null;
}

/**
 * Purchase Orders REST API.
 *
 * GET    /api/purchase-orders                  → list (filter by ?status=…&vendor=…&from=&to=)
 * GET    /api/purchase-orders?id=<uuid>        → detail with items
 * POST   /api/purchase-orders                  → create draft
 *                                                body: { date, vendor, notes, items: [{material_id, quantity, unit_price, notes?}] }
 * PUT    /api/purchase-orders                  → update draft (replaces items if provided)
 *                                                body: { id, date?, vendor?, notes?, items? }
 * DELETE /api/purchase-orders?id=<uuid>        → delete draft
 *
 * Action endpoints in /api/purchase-orders/[id]/[action]:
 *   submit, approve, receive, reject, cancel
 */

// effectiveRole / currentRole / effectiveActor / recalcTotal live in
// @/lib/po-helpers (route modules may only export HTTP handlers, so the
// helpers shared with the [id]/* action routes cannot be re-exported here).

function nextPoNumber(db: ReturnType<typeof getDb>, isoDate: string): string {
  const year = isoDate.slice(0, 4);
  const lastRow = db.prepare(`
    SELECT po_number FROM purchase_orders
    WHERE po_number LIKE 'PO-' || ? || '-%'
    ORDER BY po_number DESC LIMIT 1
  `).get(year) as any;
  const last = lastRow?.po_number ? parseInt(lastRow.po_number.split('-').pop() || '0', 10) : 0;
  return `PO-${year}-${String(last + 1).padStart(4, '0')}`;
}

/**
 * Per-line sanity gate for PO items.
 *
 * The composers clamp their inputs, but a clamp is cosmetic: a stale tab or a
 * crafted request can still post a negative quantity, and a negative order line
 * credits NEGATIVE stock the moment the PO is received. Reject at the door.
 *
 * NaN-safe on purpose — the old `Number(x) || 0` turned "abc" into a silent
 * zero-qty line that passed every downstream check.
 *
 * Quantities are PURCHASE units and prices are ₹ per PURCHASE unit here; this
 * gate deliberately does not convert, it only rejects impossible values.
 */
function lineSanityError(db: ReturnType<typeof getDb>, items: any[]): string | null {
  const matExists = db.prepare('SELECT 1 FROM raw_materials WHERE id = ?');
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const n = i + 1;
    const materialId = String(it?.material_id || '').trim();
    if (!it || !materialId) return `Line ${n}: pick an item`;
    // purchase_order_items.material_id carries an enforced FK (foreign_keys = ON),
    // so an unknown id aborts the whole INSERT transaction and the composer shows
    // the raw driver text "FOREIGN KEY constraint failed". Same probe the
    // edit-approved endpoint runs; name the offending line instead.
    if (!matExists.get(materialId)) return `Line ${n}: unknown item (${materialId})`;

    const qty = Number(it.quantity);
    if (!Number.isFinite(qty)) return `Line ${n}: quantity is not a number`;
    if (qty <= 0)              return `Line ${n}: quantity must be greater than 0 (got ${qty})`;

    // A rate of 0 is ALLOWED on purpose: Smart Reorder legitimately drafts lines
    // whose ₹/purchase-unit is not known yet (crm-reorder-po.ts accepts px ≥ 0),
    // and a 0 rate can never reach the books — [id]/receive rejects a 0/blank
    // effective rate on every accepted line. Only a negative rate is impossible.
    const px = Number(it.unit_price);
    if (!Number.isFinite(px)) return `Line ${n}: rate is not a number`;
    if (px < 0)               return `Line ${n}: rate cannot be negative (got ${px})`;
  }
  return null;
}

/**
 * Recompute the PO's header vendor from its line items.
 * - If all lines share one vendor → that's the PO vendor.
 * - If multiple → header reads "Mixed (N)" so reports/printouts make sense.
 * - If no items have vendors → leave header vendor untouched (manual entry case).
 */
function deriveHeaderVendor(db: ReturnType<typeof getDb>, poId: string) {
  const rows = db.prepare(`
    SELECT vendor, vendor_id, COUNT(*) AS n
    FROM purchase_order_items
    WHERE po_id = ? AND vendor IS NOT NULL AND TRIM(vendor) != ''
    GROUP BY vendor, vendor_id
    ORDER BY n DESC
  `).all(poId) as any[];
  if (rows.length === 0) return;
  if (rows.length === 1) {
    db.prepare(`UPDATE purchase_orders SET vendor = ?, vendor_id = ? WHERE id = ?`)
      .run(rows[0].vendor, rows[0].vendor_id, poId);
  } else {
    db.prepare(`UPDATE purchase_orders SET vendor = ?, vendor_id = NULL WHERE id = ?`)
      .run(`Mixed (${rows.length} vendors)`, poId);
  }
}

// ---------- GET ----------
export async function GET(request: Request) {
  try {
    // POST/PUT/DELETE all gate on poWriteGate(); GET did not gate at all, so PO
    // pricing + vendor terms were readable by any request that reached the route.
    // Reads stay open to any signed-in user, but no further.
    const viewer = await getCurrentUser();
    if (!viewer) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const url = new URL(request.url);
    const id = url.searchParams.get('id');

    if (id) {
      // No settings-based role here: this used to ship settings.current_role
      // (which seeds to 'admin') as `viewer_role`, the same field name the list
      // branch uses for the SESSION-derived role — po-helpers.ts removed that
      // fallback precisely because it treated a forged/expired cookie as admin.
      const po = db.prepare(`
        SELECT po.* FROM purchase_orders po WHERE po.id = ?
      `).get(id) as any;
      if (!po) return Response.json({ error: 'Not found' }, { status: 404 });
      const items = db.prepare(`
        -- A PO is raised in PURCHASE units at ₹/purchase-unit, so the UI must
        -- label qty/rate with material_purchase_unit (kg), NOT the recipe unit
        -- (g) — those differ by pack_size and mislabelling them misreads the PO.
        SELECT poi.*, rm.name AS material_name, rm.sku AS material_sku, rm.unit AS material_unit,
               COALESCE(NULLIF(TRIM(rm.purchase_unit), ''), rm.unit) AS material_purchase_unit,
               rm.pack_size AS material_pack_size,
               rm.average_price AS current_avg_price, rm.last_purchase_price,
               rm.primary_vendor AS material_default_vendor
        FROM purchase_order_items poi
        JOIN raw_materials rm ON rm.id = poi.material_id
        WHERE poi.po_id = ?
      `).all(id) as any[];

      // If this PO has been received, fold in the GRN item rows by po_item_id
      // so callers (print page, detail UI) can show received-vs-ordered without
      // a second round-trip. po_items themselves keep the original ORDERED
      // numbers; the received numbers live on the GRN.
      if (po.grn_id) {
        const grnItems = db.prepare(`
          SELECT po_item_id, quantity_received, quantity_accepted, quantity_rejected,
                 unit_price AS received_unit_price, rejection_reason,
                 discount AS received_discount, delivery_charges AS received_delivery
          FROM goods_receipt_note_items
          WHERE grn_id = ?
        `).all(po.grn_id) as any[];
        const byPoi = new Map<string, any>();
        for (const g of grnItems) if (g.po_item_id) byPoi.set(g.po_item_id, g);
        for (const it of items) {
          const g = byPoi.get(it.id);
          if (g) {
            it.quantity_received     = g.quantity_received;
            it.quantity_accepted     = g.quantity_accepted;
            it.quantity_rejected     = g.quantity_rejected;
            it.received_unit_price   = g.received_unit_price;
            it.rejection_reason      = g.rejection_reason;
            // GRN rates are GROSS (the bill document). The bill-level discount +
            // delivery ride along per line so the print can reconcile the gross
            // received subtotal with purchase_orders.total_cost, which is NET.
            it.received_discount     = Number(g.received_discount) || 0;
            it.received_delivery     = Number(g.received_delivery) || 0;
            it.received_line_total   = Math.round(g.quantity_accepted * g.received_unit_price * 100) / 100;
          }
        }
      }
      // Role travels at the TOP level (session-derived), exactly as the list
      // branch returns it — never nested on the row, where it looked like PO data.
      return Response.json({ purchase_order: { ...po, items }, viewer_role: await effectiveRole() });
    }

    const status = url.searchParams.get('status');
    const vendor = url.searchParams.get('vendor');
    const from   = url.searchParams.get('from');
    const to     = url.searchParams.get('to');

    const where: string[] = ['1=1'];
    const params: any[] = [];

    // Outlet scoping — only show POs for the user's currently-selected outlet
    const outletId = await getCurrentOutletId();
    if (outletId) { where.push('po.outlet_id = ?'); params.push(outletId); }

    if (status) { where.push('po.status = ?'); params.push(status); }
    if (vendor) { where.push('po.vendor LIKE ?'); params.push(`%${vendor}%`); }
    if (from)   { where.push('po.date >= ?'); params.push(from); }
    if (to)     { where.push('po.date <= ?'); params.push(to); }

    const rows = db.prepare(`
      SELECT po.*, (SELECT COUNT(*) FROM purchase_order_items WHERE po_id = po.id) AS item_count
      FROM purchase_orders po
      WHERE ${where.join(' AND ')}
      ORDER BY po.date DESC, po.created_at DESC
    `).all(...params);

    const role = await effectiveRole();
    const actor = await effectiveActor();
    return Response.json({ purchase_orders: rows, viewer_role: role, viewer_email: actor });
  } catch (error: any) {
    console.error('[/api/purchase-orders GET]', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}

// ---------- POST (create draft) ----------
export async function POST(request: Request) {
  try {
    // effectiveRole() collapses staff → 'manager', so the old truthiness check
    // only proved a session existed and let any signed-in captain write POs.
    const gate = await poWriteGate();
    if (gate === 'anon')   return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (gate === 'denied') return Response.json({ error: 'Only Management or the store manager can create POs' }, { status: 403 });
    const db = getDb();
    const body = await request.json();
    const { date, vendor_id, vendor, notes, items } = body;

    const isoDate = String(date || new Date().toISOString().slice(0, 10));
    if (!Array.isArray(items) || items.length === 0) {
      return Response.json({ error: 'items array required' }, { status: 400 });
    }
    const blocked = storeBlockedError(db, items);
    if (blocked) return Response.json({ error: blocked }, { status: 400 });
    const badLine = lineSanityError(db, items);
    if (badLine) return Response.json({ error: badLine }, { status: 400 });
    const dupLine = duplicateLineError(items);
    if (dupLine) return Response.json({ error: dupLine }, { status: 400 });

    // Resolve vendor — prefer vendor_id, cache name for display
    let resolvedVendorId: string | null = vendor_id || null;
    let resolvedVendorName = vendor || '';
    if (resolvedVendorId) {
      const v = db.prepare('SELECT id, name FROM vendors WHERE id = ?').get(resolvedVendorId) as any;
      if (v) resolvedVendorName = v.name;
    }

    const id = generateId();
    const poNumber = nextPoNumber(db, isoDate);
    const actor = await effectiveActor();
    const outletId = await getCurrentOutletId();

    const txn = db.transaction(() => {
      db.prepare(`
        INSERT INTO purchase_orders (id, po_number, date, vendor_id, vendor, status, notes, drafted_by, outlet_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, datetime('now'), datetime('now'))
      `).run(id, poNumber, isoDate, resolvedVendorId, resolvedVendorName, notes || '', actor, outletId);

      const insItem = db.prepare(`
        INSERT INTO purchase_order_items (id, po_id, material_id, quantity, unit_price, total_price, vendor, vendor_id, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const lookupVendorId   = db.prepare('SELECT id FROM vendors WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) LIMIT 1');
      const lookupVendorName = db.prepare('SELECT name FROM vendors WHERE id = ?');
      for (const it of items) {
        // Validated by lineSanityError above — no `|| 0` fallback, which would
        // silently rewrite a bad value instead of surfacing it.
        const qty = Number(it.quantity);
        const px  = Number(it.unit_price);
        let lineVendor   = String(it.vendor || '').trim();
        let lineVendorId = it.vendor_id || null;
        if (!lineVendorId && lineVendor) {
          const v = lookupVendorId.get(lineVendor) as any;
          if (v) lineVendorId = v.id;
        } else if (lineVendorId && !lineVendor) {
          // The composer now sends an id from the vendor dropdown; backfill the
          // display name so deriveHeaderVendor (which skips blank names) can
          // still resolve the header, and the line reads correctly everywhere.
          const v = lookupVendorName.get(lineVendorId) as any;
          if (v) lineVendor = String(v.name || '').trim();
        }
        insItem.run(generateId(), id, it.material_id, qty, px,
                    Math.round(qty * px * 100) / 100,
                    lineVendor, lineVendorId, it.notes || '');
      }
      recalcTotal(db, id);
      deriveHeaderVendor(db, id);
    });
    txn();

    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id);
    return Response.json({ purchase_order: po }, { status: 201 });
  } catch (error: any) {
    console.error('[/api/purchase-orders POST]', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}

// ---------- PUT (update draft items / metadata) ----------
export async function PUT(request: Request) {
  try {
    // Tier-accurate gate — see the POST handler (effectiveRole() reports
    // 'manager' for the staff tier, so truthiness is only "has a session").
    const gate = await poWriteGate();
    if (gate === 'anon')   return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (gate === 'denied') return Response.json({ error: 'Only Management or the store manager can edit POs' }, { status: 403 });
    const db = getDb();
    const body = await request.json();
    const { id, date, vendor_id, vendor, notes, items } = body;
    if (!id) return Response.json({ error: 'id required' }, { status: 400 });
    const po = db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(id) as any;
    if (!po) return Response.json({ error: 'Not found' }, { status: 404 });
    if (po.status !== 'draft') return Response.json({ error: 'Only drafts can be edited' }, { status: 400 });
    if (Array.isArray(items)) {
      // An items array that is present but empty would delete every line and
      // leave a submittable draft with nothing on it. The composer already
      // requires one line; hold the same line here.
      if (items.length === 0) return Response.json({ error: 'A purchase order needs at least one line' }, { status: 400 });
      const blocked = storeBlockedError(db, items);
      if (blocked) return Response.json({ error: blocked }, { status: 400 });
      const badLine = lineSanityError(db, items);
      if (badLine) return Response.json({ error: badLine }, { status: 400 });
      const dupLine = duplicateLineError(items);
      if (dupLine) return Response.json({ error: dupLine }, { status: 400 });
    }

    let resolvedVendorName = vendor;
    if (vendor_id) {
      const v = db.prepare('SELECT name FROM vendors WHERE id = ?').get(vendor_id) as any;
      if (v) resolvedVendorName = v.name;
    }

    const txn = db.transaction(() => {
      db.prepare(`
        UPDATE purchase_orders SET
          date      = COALESCE(?, date),
          vendor_id = COALESCE(?, vendor_id),
          vendor    = COALESCE(?, vendor),
          notes     = COALESCE(?, notes),
          updated_at = datetime('now')
        WHERE id = ?
      `).run(date ?? null, vendor_id ?? null, resolvedVendorName ?? null, notes ?? null, id);

      if (Array.isArray(items)) {
        db.prepare('DELETE FROM purchase_order_items WHERE po_id = ?').run(id);
        const ins = db.prepare(`
          INSERT INTO purchase_order_items (id, po_id, material_id, quantity, unit_price, total_price, vendor, vendor_id, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const lookupVendorId   = db.prepare('SELECT id FROM vendors WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) LIMIT 1');
        const lookupVendorName = db.prepare('SELECT name FROM vendors WHERE id = ?');
        for (const it of items) {
          // Validated by lineSanityError above — see the POST handler.
          const qty = Number(it.quantity);
          const px  = Number(it.unit_price);
          let lineVendor   = String(it.vendor || '').trim();
          let lineVendorId = it.vendor_id || null;
          if (!lineVendorId && lineVendor) {
            const v = lookupVendorId.get(lineVendor) as any;
            if (v) lineVendorId = v.id;
          } else if (lineVendorId && !lineVendor) {
            // Backfill the name from the id — see the POST handler.
            const v = lookupVendorName.get(lineVendorId) as any;
            if (v) lineVendor = String(v.name || '').trim();
          }
          ins.run(generateId(), id, it.material_id, qty, px,
                  Math.round(qty * px * 100) / 100,
                  lineVendor, lineVendorId, it.notes || '');
        }
        recalcTotal(db, id);
        deriveHeaderVendor(db, id);
      }
    });
    txn();

    const fresh = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id);
    return Response.json({ purchase_order: fresh });
  } catch (error: any) {
    console.error('[/api/purchase-orders PUT]', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}

// ---------- DELETE (drafts only) ----------
export async function DELETE(request: Request) {
  try {
    // Tier-accurate gate — see the POST handler.
    const gate = await poWriteGate();
    if (gate === 'anon')   return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (gate === 'denied') return Response.json({ error: 'Only Management or the store manager can delete POs' }, { status: 403 });
    const db = getDb();
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (!id) return Response.json({ error: 'id required' }, { status: 400 });
    const po = db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(id) as any;
    if (!po) return Response.json({ error: 'Not found' }, { status: 404 });
    if (po.status !== 'draft') return Response.json({ error: 'Only drafts can be deleted' }, { status: 400 });
    db.prepare('DELETE FROM purchase_orders WHERE id = ?').run(id);  // items cascade
    return Response.json({ success: true });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
