import { getDb } from '@/lib/db';
import { getCurrentUser, canProcessAsStore } from '@/lib/auth';
import type { PoReqLink, PoVendorClosure, PoVendorIdentity, PoVendorViewPayload } from '@/lib/po-vendor-view';

/**
 * GET /api/purchase-orders/vendor-view — READ-ONLY. The per-vendor facts the PO
 * screens need beyond GET /api/purchase-orders?id= (rulings #63-#70):
 *
 *   ?id=<po_id>      → PoVendorViewPayload: the requisition lines behind every PO
 *                      line (department, REQ number, share in PURCHASE units),
 *                      which vendors were closed (po_vendor_closures), each line
 *                      vendor's master identity (the vendor copy's address/GSTIN
 *                      block), whether "Send PO to vendor" is on, and whether the
 *                      viewer may close a vendor.
 *   ?ids=<a,b,…>     → { by_po: { [po_id]: { merged, closures[] } } } for the PO
 *                      list (the "1 vendor closed" note). Bounded to 500 ids.
 *
 * WRITES NOTHING. It never decides what a PO line, a receipt or a closure IS —
 * po_requisition_lines and po_vendor_closures are written by the merge and
 * close-vendor routes; this only joins them to names for display.
 *
 * Auth: any signed-in user, exactly like GET /api/purchase-orders (the PO detail
 * this decorates is readable by the same set). proxy.ts guards pages, not APIs,
 * so the session is verified here.
 *
 * TABLE-ABSENT SAFE. The link/closure tables are additive migrations; on a DB
 * that has not run them this answers links_available:false with empty lists, so
 * the screens degrade to exactly what they showed before.
 */

const tableExists = (db: ReturnType<typeof getDb>, name: string): boolean =>
  !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
const hasColumn = (db: ReturnType<typeof getDb>, table: string, col: string): boolean => {
  try { return (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).some(c => c.name === col); }
  catch { return false; }
};
const num = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export async function GET(request: Request) {
  try {
    const viewer = await getCurrentUser();
    if (!viewer) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const url = new URL(request.url);
    const id = (url.searchParams.get('id') || '').trim();
    const idsParam = (url.searchParams.get('ids') || '').trim();

    const hasClosures = tableExists(db, 'po_vendor_closures');
    const hasLinks = tableExists(db, 'po_requisition_lines');
    const hasMerged = hasColumn(db, 'purchase_orders', 'merged');

    const closuresFor = (poIds: string[]): Map<string, PoVendorClosure[]> => {
      const out = new Map<string, PoVendorClosure[]>();
      if (!hasClosures || poIds.length === 0) return out;
      const ph = poIds.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT c.po_id, c.vendor_id,
               -- The closure's own record of the name first (what the close
               -- route filed it under), the master's current name as fallback.
               COALESCE(NULLIF(TRIM(c.vendor_name), ''), v.name, '') AS vendor_name,
               COALESCE(c.reason, '') AS reason, COALESCE(c.closed_by, '') AS closed_by,
               COALESCE(c.closed_at, '') AS closed_at
        FROM po_vendor_closures c
        LEFT JOIN vendors v ON v.id = c.vendor_id
        WHERE c.po_id IN (${ph})
        ORDER BY c.closed_at, c.rowid
      `).all(...poIds) as any[];
      for (const r of rows) {
        const list = out.get(String(r.po_id)) || [];
        list.push({
          vendor_id: String(r.vendor_id || ''), vendor_name: String(r.vendor_name || ''),
          reason: String(r.reason || ''), closed_by: String(r.closed_by || ''), closed_at: String(r.closed_at || ''),
        });
        out.set(String(r.po_id), list);
      }
      return out;
    };

    // ── LIST MODE ────────────────────────────────────────────────────────────
    if (!id) {
      const ids = [...new Set(idsParam.split(',').map(s => s.trim()).filter(Boolean))].slice(0, 500);
      const closures = closuresFor(ids);
      const mergedRows = hasMerged && ids.length
        ? db.prepare(`SELECT id, COALESCE(merged, 0) AS merged FROM purchase_orders WHERE id IN (${ids.map(() => '?').join(',')})`)
            .all(...ids) as any[]
        : [];
      const by_po: Record<string, { merged: boolean; closures: PoVendorClosure[] }> = {};
      for (const pid of ids) by_po[pid] = { merged: false, closures: closures.get(pid) || [] };
      for (const r of mergedRows) if (by_po[String(r.id)]) by_po[String(r.id)].merged = Number(r.merged) === 1;
      return Response.json({ by_po, links_available: hasLinks });
    }

    // ── DETAIL MODE ──────────────────────────────────────────────────────────
    const po = db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(id) as any;
    if (!po) return Response.json({ error: 'Not found' }, { status: 404 });

    const items = db.prepare(`
      SELECT id, material_id, vendor, vendor_id, req_item_id
      FROM purchase_order_items WHERE po_id = ? ORDER BY rowid
    `).all(id) as any[];

    // Vendor master identity for every vendor a line (or the header) names.
    const vendorIds = [...new Set(
      [...items.map(i => i.vendor_id), po.vendor_id].map(v => String(v || '').trim()).filter(Boolean),
    )];
    const vendors: PoVendorIdentity[] = vendorIds.length === 0 ? [] : (db.prepare(`
      SELECT id, name, contact_person, phone, email, address, gstin, payment_terms
      FROM vendors WHERE id IN (${vendorIds.map(() => '?').join(',')})
    `).all(...vendorIds) as any[]).map(v => ({
      id: String(v.id), name: String(v.name || ''), contact_person: String(v.contact_person || ''),
      phone: String(v.phone || ''), email: String(v.email || ''), address: String(v.address || ''),
      gstin: String(v.gstin || ''), payment_terms: String(v.payment_terms || ''),
    }));

    // The requisition lines behind each PO line.
    const links_by_item: Record<string, PoReqLink[]> = {};
    if (hasLinks) {
      const rows = db.prepare(`
        SELECT l.*, COALESCE(r.req_number, '') AS req_number,
               COALESCE(r.purpose, 'internal') AS req_purpose, COALESCE(r.event_name, '') AS req_event_name,
               COALESCE(d.name, '') AS department_name
        FROM po_requisition_lines l
        LEFT JOIN requisitions r ON r.id = l.requisition_id
        LEFT JOIN departments  d ON d.id = l.department_id
        WHERE l.po_id = ?
        ORDER BY l.created_at, l.rowid
      `).all(id) as any[];
      for (const r of rows) {
        const key = String(r.po_item_id || '');
        if (!key) continue;
        (links_by_item[key] ||= []).push({
          id: String(r.id), po_item_id: key,
          requisition_id: r.requisition_id ? String(r.requisition_id) : null,
          req_number: String(r.req_number || ''),
          req_item_id: r.req_item_id ? String(r.req_item_id) : null,
          department_id: r.department_id ? String(r.department_id) : null,
          department_name: String(r.department_name || ''),
          qty_purchase: num(r.qty_purchase),
          qty_line: num(r.qty_line),
          line_unit: String(r.line_unit || ''),
          is_party: Number(r.is_party) === 1 || String(r.req_purpose) === 'party',
          event_name: String(r.req_event_name || ''),
          delivered_direct: Number(r.delivered_direct) === 1,
          vendor_closed: Number(r.vendor_closed) === 1,
          created_at: String(r.created_at || ''),
          source: 'merge',
        });
      }
    }
    // LEGACY: the per-requisition "Also raise a vendor PO" tick stamps
    // purchase_order_items.req_item_id (and never writes a link row). Shown so
    // that PO's lines also name the department behind them — REQ number and
    // department only: that path stores no per-department share, so no
    // quantity is claimed for it.
    const legacyStmt = db.prepare(`
      SELECT ri.id AS req_item_id, ri.req_id, ri.created_at,
             COALESCE(ri.department_id, r.department_id) AS department_id,
             COALESCE(r.req_number, '') AS req_number, COALESCE(r.purpose, 'internal') AS purpose,
             COALESCE(r.event_name, '') AS event_name, COALESCE(d.name, '') AS department_name
      FROM requisition_items ri
      LEFT JOIN requisitions r ON r.id = ri.req_id
      LEFT JOIN departments  d ON d.id = COALESCE(ri.department_id, r.department_id)
      WHERE ri.id = ?
    `);
    for (const it of items) {
      const key = String(it.id);
      if (links_by_item[key]?.length || !it.req_item_id) continue;
      const r = legacyStmt.get(String(it.req_item_id)) as any;
      if (!r) continue;
      links_by_item[key] = [{
        id: `legacy-${key}`, po_item_id: key,
        requisition_id: r.req_id ? String(r.req_id) : null, req_number: String(r.req_number || ''),
        req_item_id: String(r.req_item_id), department_id: r.department_id ? String(r.department_id) : null,
        department_name: String(r.department_name || ''), qty_purchase: null, qty_line: null, line_unit: '',
        is_party: String(r.purpose) === 'party', event_name: String(r.event_name || ''),
        delivered_direct: false, vendor_closed: false, created_at: String(r.created_at || ''), source: 'legacy',
      }];
    }

    const setting = db.prepare(`SELECT value FROM settings WHERE key = 'po_send_to_vendor'`).get() as any;
    const payload: PoVendorViewPayload = {
      po_id: String(po.id),
      merged: hasMerged ? Number(po.merged) === 1 : false,
      send_to_vendor: String(setting?.value ?? '').trim() === '1',
      can_close_vendor: canProcessAsStore(viewer),
      links_available: hasLinks,
      closures: closuresFor([String(po.id)]).get(String(po.id)) || [],
      vendors,
      links_by_item,
    };
    return Response.json(payload);
  } catch (e: any) {
    console.error('[/api/purchase-orders/vendor-view GET]', e);
    return Response.json({ error: e?.message || 'Failed' }, { status: 500 });
  }
}
