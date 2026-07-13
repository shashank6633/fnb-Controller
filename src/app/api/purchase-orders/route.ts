import { getDb, generateId, updateMaterialPrice } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { centralFlowBlock } from '@/lib/store-engine';

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

/** Role of the CURRENT SESSION, or null when there is no valid session.
 *  SECURITY: never falls back to a privileged role. The old settings-based
 *  `current_role` fallback meant a forged/expired cookie was treated as admin
 *  on every PO money/stock action — removed. Callers MUST 401 on null.
 *  Collapses 'staff' → 'manager' for the legacy two-tier callers in this file. */
async function effectiveRole(): Promise<'admin' | 'manager' | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  return user.role === 'admin' ? 'admin' : 'manager';
}
/** Back-compat shim for callers that used the old sync currentRole(db): now
 *  session-based and nullable. */
async function currentRole(): Promise<'admin' | 'manager' | null> {
  return effectiveRole();
}

async function effectiveActor(): Promise<string> {
  const user = await getCurrentUser();
  return user ? user.email : 'system';
}

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

function recalcTotal(db: ReturnType<typeof getDb>, poId: string) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(total_price), 0) AS t FROM purchase_order_items WHERE po_id = ?
  `).get(poId) as any;
  db.prepare(`UPDATE purchase_orders SET total_cost = ?, updated_at = datetime('now') WHERE id = ?`).run(r.t, poId);
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
    const db = getDb();
    const url = new URL(request.url);
    const id = url.searchParams.get('id');

    if (id) {
      const po = db.prepare(`
        SELECT po.*, role.value AS viewer_role
        FROM purchase_orders po
        LEFT JOIN settings role ON role.key = 'current_role'
        WHERE po.id = ?
      `).get(id) as any;
      if (!po) return Response.json({ error: 'Not found' }, { status: 404 });
      const items = db.prepare(`
        SELECT poi.*, rm.name AS material_name, rm.sku AS material_sku, rm.unit AS material_unit,
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
                 unit_price AS received_unit_price, rejection_reason
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
            it.received_line_total   = Math.round(g.quantity_accepted * g.received_unit_price * 100) / 100;
          }
        }
      }
      return Response.json({ purchase_order: { ...po, items } });
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
    if (!(await effectiveRole())) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const body = await request.json();
    const { date, vendor_id, vendor, notes, items } = body;

    const isoDate = String(date || new Date().toISOString().slice(0, 10));
    if (!Array.isArray(items) || items.length === 0) {
      return Response.json({ error: 'items array required' }, { status: 400 });
    }
    const blocked = storeBlockedError(db, items);
    if (blocked) return Response.json({ error: blocked }, { status: 400 });

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
      const lookupVendorId = db.prepare('SELECT id FROM vendors WHERE LOWER(name) = LOWER(?) LIMIT 1');
      for (const it of items) {
        const qty = Number(it.quantity) || 0;
        const px  = Number(it.unit_price) || 0;
        let lineVendor   = String(it.vendor || '').trim();
        let lineVendorId = it.vendor_id || null;
        if (!lineVendorId && lineVendor) {
          const v = lookupVendorId.get(lineVendor) as any;
          if (v) lineVendorId = v.id;
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
    if (!(await effectiveRole())) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const body = await request.json();
    const { id, date, vendor_id, vendor, notes, items } = body;
    if (!id) return Response.json({ error: 'id required' }, { status: 400 });
    const po = db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(id) as any;
    if (!po) return Response.json({ error: 'Not found' }, { status: 404 });
    if (po.status !== 'draft') return Response.json({ error: 'Only drafts can be edited' }, { status: 400 });
    if (Array.isArray(items)) {
      const blocked = storeBlockedError(db, items);
      if (blocked) return Response.json({ error: blocked }, { status: 400 });
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
        const lookupVendorId = db.prepare('SELECT id FROM vendors WHERE LOWER(name) = LOWER(?) LIMIT 1');
        for (const it of items) {
          const qty = Number(it.quantity) || 0;
          const px  = Number(it.unit_price) || 0;
          let lineVendor   = String(it.vendor || '').trim();
          let lineVendorId = it.vendor_id || null;
          if (!lineVendorId && lineVendor) {
            const v = lookupVendorId.get(lineVendor) as any;
            if (v) lineVendorId = v.id;
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
    if (!(await effectiveRole())) return Response.json({ error: 'Sign in required' }, { status: 401 });
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

// Re-exported helpers for action routes
export { currentRole, effectiveRole, effectiveActor, recalcTotal };
