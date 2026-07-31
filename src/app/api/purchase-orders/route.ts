import { getDb, generateId, updateMaterialPrice } from '@/lib/db';
import { getCurrentOutletId, getCurrentUser } from '@/lib/auth';
import { centralFlowBlock } from '@/lib/store-engine';
import { effectiveRole, effectiveActor, recalcTotal, poWriteGate, duplicateLineError } from '@/lib/po-helpers';
import { vendorMappingError, vendorResolver, resolveVendorRef } from '@/lib/vendor-mapping';

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

      // Fold in the GRN item rows by po_item_id so callers (print page, detail
      // UI) can show received-vs-ordered without a second round-trip. po_items
      // themselves keep the original ORDERED numbers; the received numbers live
      // on the GRN.
      //
      // EVERY GRN ON THE PO, not `purchase_orders.grn_id`. A mixed-vendor PO is
      // received ONE VENDOR AT A TIME, each with their own bill and their own
      // GRN, and grn_id holds only the LATEST of them — so keying the fold on it
      // dropped every earlier vendor's lines, and the print page's "Grand Total
      // (Final, post-receive)" showed the LAST vendor's bill as though it were
      // the whole order. `g.po_id` is the honest link: this route's receive
      // handler is the only writer of PO-linked GRN lines (/api/grn writes
      // po_id = NULL and po_item_id = NULL on ad-hoc GRNs), and the receive
      // route's per-line claim means one po_item can appear under at most one
      // GRN — so the rows below never double-count a line.
      const grnItems = db.prepare(`
        SELECT gi.po_item_id, gi.quantity_received, gi.quantity_accepted, gi.quantity_rejected,
               gi.unit_price AS received_unit_price, gi.rejection_reason,
               gi.discount AS received_discount, gi.delivery_charges AS received_delivery,
               g.grn_number, g.date AS received_on, g.vendor AS received_from,
               g.invoice_number AS received_bill_no
        FROM goods_receipt_note_items gi
        JOIN goods_receipt_notes g ON g.id = gi.grn_id
        WHERE g.po_id = ? AND gi.po_item_id IS NOT NULL AND TRIM(gi.po_item_id) != ''
        ORDER BY g.date, g.created_at, g.grn_number
      `).all(id) as any[];
      if (grnItems.length > 0) {
        const byPoi = new Map<string, any>();
        for (const g of grnItems) if (g.po_item_id) byPoi.set(String(g.po_item_id), g);
        for (const it of items) {
          const g = byPoi.get(String(it.id));
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
            // WHOSE delivery this line came in on. On a mixed PO the reader
            // cannot otherwise tell which of three bills a received line sits on.
            it.received_grn_number   = g.grn_number;
            it.received_on           = g.received_on;
            it.received_from         = g.received_from;
            it.received_bill_no      = g.received_bill_no || '';
          }
        }
      }

      // ── ONE ROW PER VENDOR RECEIPT ────────────────────────────────────────
      // po_vendor_bills IS the per-vendor record (one row per vendor bill taken
      // in against this PO); the money for that bill lives on its GRN. Paired
      // here so a mixed-vendor PO prints a total that can be reconciled invoice
      // by invoice instead of one unattributable number.
      //   net = Σ ROUND(accepted × gross rate, 2) − Σ allocated discount
      // — byte-for-byte the expression the receive route accumulates into
      // purchase_orders.total_cost, so Σ net over these rows IS the stored
      // total. Delivery is carried but never added: it is recorded only and
      // never enters item cost.
      const receipts = db.prepare(`
        SELECT g.id AS grn_id, g.grn_number, g.date AS date, g.vendor, g.vendor_id,
               g.invoice_number AS bill_no, g.invoice_date AS bill_date,
               g.received_by, g.status,
               COUNT(gi.id) AS line_count,
               COALESCE(SUM(ROUND(gi.quantity_accepted * gi.unit_price, 2)), 0) AS gross,
               COALESCE(SUM(gi.discount), 0)         AS discount,
               COALESCE(SUM(gi.delivery_charges), 0) AS delivery
        FROM goods_receipt_notes g
        LEFT JOIN goods_receipt_note_items gi ON gi.grn_id = g.id
        WHERE g.po_id = ?
        GROUP BY g.id
        ORDER BY g.date, g.created_at, g.grn_number
      `).all(id) as any[];
      // The bill rows themselves — bill_date and who signed for it are recorded
      // there, and on a legacy/blank-invoice GRN they are the only copy. Matched
      // on the GRN number the receive txn writes into notes ('GRN <number>[ — …]'),
      // falling back to vendor+bill number.
      let vendorBills: any[] = [];
      try {
        vendorBills = db.prepare(`
          SELECT id, vendor_id, vendor_name, bill_no, bill_date, received_by, notes, created_at
          FROM po_vendor_bills WHERE po_id = ? ORDER BY created_at, id
        `).all(id) as any[];
      } catch { /* table absent on an un-migrated DB — receipts above still stand */ }
      const billKey = (vendor: string, no: string) => `${String(vendor || '').trim().toLowerCase()}|${String(no || '').trim()}`;
      const billByGrn = new Map<string, any>();
      const billByKey = new Map<string, any>();
      for (const b of vendorBills) {
        const m = /^GRN\s+(\S+)/.exec(String(b.notes || ''));
        if (m && !billByGrn.has(m[1])) billByGrn.set(m[1], b);
        const k = billKey(b.vendor_name, b.bill_no);
        if (!billByKey.has(k)) billByKey.set(k, b);
      }
      for (const r of receipts) {
        const b = billByGrn.get(String(r.grn_number)) || billByKey.get(billKey(r.vendor, r.bill_no)) || null;
        r.gross     = Math.round(Number(r.gross) * 100) / 100;
        r.discount  = Math.round(Number(r.discount) * 100) / 100;
        r.delivery  = Math.round(Number(r.delivery) * 100) / 100;
        r.net       = Math.round((r.gross - r.discount) * 100) / 100;
        r.vendor_bill_id = b?.id || null;
        if (b) {
          // The bill row is the authority on the vendor's own document.
          r.bill_no    = r.bill_no || b.bill_no || '';
          r.bill_date  = r.bill_date || b.bill_date || '';
          r.vendor     = r.vendor || b.vendor_name || '';
          r.received_by = r.received_by || b.received_by || '';
        }
      }
      const receivedNet = Math.round(receipts.reduce((s, r) => s + Number(r.net || 0), 0) * 100) / 100;

      // Role travels at the TOP level (session-derived), exactly as the list
      // branch returns it — never nested on the row, where it looked like PO data.
      return Response.json({
        purchase_order: { ...po, items },
        // Additive; nothing that read this endpoint before knows these exist.
        // `receipts` is EVERY vendor receipt on the PO (empty until the first
        // one), `received_net` their sum — the figure a post-receive print must
        // show, and equal to purchase_orders.total_cost once anything is in.
        receipts,
        received_net: receivedNet,
        vendor_bills: vendorBills,
        viewer_role: await effectiveRole(),
      });
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
    // STRICT VENDOR ↔ ITEM MAPPING (owner rule). The composer filters both
    // dropdowns off the same `vendor_materials` rows, but a filtered <select> is
    // a convenience — this is the rule. Runs AFTER lineSanityError so an unknown
    // item is named as such rather than as an unmapped pair.
    //
    // The header vendor is handed over because a line that carries no vendor of
    // its own is not unchecked: receive files it under the header
    // (api/purchase-orders/[id]/receive) and stocks and bills it under that
    // name, so the rule has to check THAT pair.
    const badPair = vendorMappingError(db, items, { headerVendor: { vendor_id, vendor } });
    if (badPair) return Response.json({ error: badPair }, { status: 400 });

    // Resolve the header vendor through the same resolver the rule used, so the
    // identity checked is the identity stored — id first, and the master row's
    // own spelling of the name, never the caller's. An unresolvable header is
    // left exactly as it arrived (deriveHeaderVendor usually rewrites it anyway).
    const hdr = resolveVendorRef(db, { vendor_id, vendor });
    const resolvedVendorId: string | null = hdr.status === 'known' ? hdr.id : (vendor_id || null);
    const resolvedVendorName: string = hdr.status === 'known' ? hdr.name : (vendor || '');

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
      // THE SAME RESOLVER vendorMappingError() just used. What it returns is
      // what gets stored — id AND the master row's own spelling of the name —
      // so the pairing that was checked is the pairing that is filed. Storing
      // `it.vendor` verbatim instead let a payload carrying vendor_id X with
      // vendor "Y" pass the check on X and be received, stocked and paid under
      // Y, because receive / purchases / po_vendor_bills all key on the NAME.
      const lineVendorOf = vendorResolver(db);
      for (const it of items) {
        // Validated by lineSanityError above — no `|| 0` fallback, which would
        // silently rewrite a bad value instead of surfacing it.
        const qty = Number(it.quantity);
        const px  = Number(it.unit_price);
        const lv = lineVendorOf(it);
        // 'unknown' is unreachable — the rule above refuses it — but if it ever
        // arrived, keep what came in rather than blanking the line silently.
        const lineVendor   = lv.status === 'known' ? lv.name : (lv.status === 'empty' ? '' : lv.shown);
        const lineVendorId = lv.status === 'known' ? lv.id   : (String(it.vendor_id ?? '').trim() || null);
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
    // vendor/vendor_id come along because they decide what a line carrying no
    // vendor of its own is filed under — see the header-vendor block below.
    const po = db.prepare('SELECT status, vendor, vendor_id FROM purchase_orders WHERE id = ?').get(id) as any;
    if (!po) return Response.json({ error: 'Not found' }, { status: 404 });
    if (po.status !== 'draft') return Response.json({ error: 'Only drafts can be edited' }, { status: 400 });

    // THE HEADER VENDOR THIS REQUEST LEAVES BEHIND. The UPDATE below is a
    // COALESCE, so a field the request omits keeps its stored value; the vendor a
    // blank line will inherit is therefore the request's header when it sends
    // one, else the PO's own.
    const headerGiven = String(vendor_id ?? '').trim() !== '' || String(vendor ?? '').trim() !== '';
    const headerRef   = headerGiven ? { vendor_id, vendor } : { vendor_id: po.vendor_id, vendor: po.vendor };
    const hdr = resolveVendorRef(db, headerRef);

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
      // Same strict pair rule as create — this handler REPLACES the whole item
      // set, so skipping it here would make "edit the draft" the way around it.
      // Header vendor included for the same reason as in POST: a line with no
      // vendor of its own is received under it.
      const badPair = vendorMappingError(db, items, { headerVendor: headerRef });
      if (badPair) return Response.json({ error: badPair }, { status: 400 });
    } else if (headerGiven) {
      // A HEADER-ONLY EDIT MOVES THE INHERITING LINES. No item set means
      // deriveHeaderVendor() never runs, so this new header stands as written and
      // every line already on the PO that carries no vendor of its own is now
      // pointed at it. Only those lines are checked (the rest are passed as nulls
      // so the numbering still matches the PO's own rows, and a pair that was
      // fine before cannot be re-litigated by an unrelated header edit), and only
      // when the header actually changes identity.
      const stored = resolveVendorRef(db, { vendor_id: po.vendor_id, vendor: po.vendor });
      const moved = hdr.status !== stored.status
        || (hdr.id ?? hdr.shown.toLowerCase()) !== (stored.id ?? stored.shown.toLowerCase());
      if (moved) {
        const rows = db.prepare(`
          SELECT material_id, vendor, vendor_id FROM purchase_order_items WHERE po_id = ? ORDER BY rowid
        `).all(id) as any[];
        const inheriting = rows.map(r =>
          String(r.vendor ?? '').trim() === '' && String(r.vendor_id ?? '').trim() === '' ? r : null);
        if (inheriting.some(Boolean)) {
          const badPair = vendorMappingError(db, inheriting, { headerVendor: headerRef, headerIsFinal: true });
          if (badPair) return Response.json({ error: badPair }, { status: 400 });
        }
      }
    }

    // Header stored exactly as it was resolved and checked — id first, master
    // spelling of the name. See the POST handler.
    const resolvedVendorName = hdr.status === 'known' && headerGiven ? hdr.name : vendor;
    const resolvedVendorId   = hdr.status === 'known' && headerGiven ? hdr.id   : (vendor_id ?? null);

    const txn = db.transaction(() => {
      db.prepare(`
        UPDATE purchase_orders SET
          date      = COALESCE(?, date),
          vendor_id = COALESCE(?, vendor_id),
          vendor    = COALESCE(?, vendor),
          notes     = COALESCE(?, notes),
          updated_at = datetime('now')
        WHERE id = ?
      `).run(date ?? null, resolvedVendorId ?? null, resolvedVendorName ?? null, notes ?? null, id);

      if (Array.isArray(items)) {
        db.prepare('DELETE FROM purchase_order_items WHERE po_id = ?').run(id);
        const ins = db.prepare(`
          INSERT INTO purchase_order_items (id, po_id, material_id, quantity, unit_price, total_price, vendor, vendor_id, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        // Checked identity == stored identity — see the POST handler.
        const lineVendorOf = vendorResolver(db);
        for (const it of items) {
          // Validated by lineSanityError above — see the POST handler.
          const qty = Number(it.quantity);
          const px  = Number(it.unit_price);
          const lv = lineVendorOf(it);
          const lineVendor   = lv.status === 'known' ? lv.name : (lv.status === 'empty' ? '' : lv.shown);
          const lineVendorId = lv.status === 'known' ? lv.id   : (String(it.vendor_id ?? '').trim() || null);
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
