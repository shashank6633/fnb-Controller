import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import {
  materialsForVendor, vendorsForMaterial, vendorMappingIndex, vendorsWithNoItems,
} from '@/lib/vendor-mapping';

/**
 * vendor_materials — simple (vendor, material) MAPPING.
 *   "This vendor sells this material." No price, no contract.
 *
 * GET    /api/vendor-materials?vendor_id=X        → list materials mapped to vendor
 * GET    /api/vendor-materials?material_id=Y      → list vendors mapped to material
 * GET    /api/vendor-materials?index=1            → the WHOLE map, one payload:
 *        { by_vendor: {vendor_id: [material_id…]}, vendor_names, vendors_no_items }
 *        The PO composer filters BOTH directions off this single object, so its
 *        two dropdowns can never disagree with each other — nor with the server,
 *        which checks the same rows through @/lib/vendor-mapping.
 * POST   /api/vendor-materials                    → upsert one (idempotent)
 *        body: { vendor_id, material_id, notes? }
 * POST   /api/vendor-materials  (bulk)            → bulk upsert
 *        body: { vendor_id, material_ids: [...] }
 * DELETE /api/vendor-materials?vendor_id=X&material_id=Y → remove a mapping
 *
 * Contracts (prices) live in /api/vendor-contracts and are independent.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const url = new URL(request.url);
    const vendorId = url.searchParams.get('vendor_id');
    const materialId = url.searchParams.get('material_id');
    const wantIndex = url.searchParams.get('index') === '1';

    // Whole-map mode. Additive: the two filtered modes below are untouched.
    if (wantIndex) {
      const index = vendorMappingIndex(db);
      return Response.json({ ...index, vendors_no_items: vendorsWithNoItems(db) });
    }

    if (!vendorId && !materialId) {
      return Response.json({ error: 'vendor_id, material_id or index=1 required' }, { status: 400 });
    }
    // Same resolver the PO server-side rule uses — a mapping listed here is a
    // mapping that will pass vendorMappingError(), by construction.
    let rows = vendorId ? materialsForVendor(db, vendorId) : vendorsForMaterial(db, materialId!);
    if (vendorId && materialId) rows = rows.filter(r => r.material_id === materialId);
    // Response shape is unchanged for existing callers (/grn, the PO composer,
    // /vendors/materials): vendor_id, material_id, notes, created_at, created_by,
    // vendor_name, material_name, material_sku, material_unit — plus the pack
    // meta and `source` the Vendor Items screen now shows.
    return Response.json({ mappings: rows });
  } catch (e: any) {
    console.error('[/api/vendor-materials GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const b = await request.json();

    if (!b.vendor_id) return Response.json({ error: 'vendor_id required' }, { status: 400 });

    // This table now GATES purchasing (a PO line is refused unless its pair is
    // here), so a write that silently does nothing is expensive: the buyer maps
    // an item, the PO still refuses it, and there is nothing on screen to
    // explain why. Both FKs are enforced, so an unknown id would otherwise come
    // back as the driver's raw "FOREIGN KEY constraint failed".
    const vendorRow = db.prepare('SELECT id, name FROM vendors WHERE id = ?').get(b.vendor_id) as any;
    if (!vendorRow) return Response.json({ error: `Unknown vendor (${b.vendor_id}) — add them under Vendors first.` }, { status: 400 });
    const matExists = db.prepare('SELECT 1 FROM raw_materials WHERE id = ?');

    const ins = db.prepare(`
      INSERT OR IGNORE INTO vendor_materials (vendor_id, material_id, notes, created_by)
      VALUES (?, ?, ?, ?)
    `);

    // Bulk path: { vendor_id, material_ids: [...] }
    if (Array.isArray(b.material_ids)) {
      const ids = b.material_ids.map((m: any) => String(m || '').trim()).filter(Boolean);
      const unknown = ids.filter((mid: string) => !matExists.get(mid));
      if (unknown.length) {
        return Response.json({ error: `${unknown.length} unknown item id(s): ${unknown.slice(0, 3).join(', ')}${unknown.length > 3 ? '…' : ''}` }, { status: 400 });
      }
      let added = 0;
      const txn = db.transaction(() => {
        for (const mid of ids) {
          const r = ins.run(b.vendor_id, mid, b.notes || '', me.email);
          if (r.changes > 0) added += 1;
        }
      });
      txn();
      return Response.json({ added, skipped_existing: ids.length - added, vendor_name: vendorRow.name });
    }

    // Single path: { vendor_id, material_id }
    if (!b.material_id) return Response.json({ error: 'material_id (or material_ids) required' }, { status: 400 });
    const materialId = String(b.material_id).trim();
    if (!matExists.get(materialId)) return Response.json({ error: `Unknown item (${materialId}).` }, { status: 400 });
    const r = ins.run(b.vendor_id, materialId, b.notes || '', me.email);
    return Response.json({ added: r.changes, success: true, vendor_name: vendorRow.name }, { status: 201 });
  } catch (e: any) {
    console.error('[/api/vendor-materials POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const url = new URL(request.url);
    const vendorId = url.searchParams.get('vendor_id');
    const materialId = url.searchParams.get('material_id');
    if (!vendorId || !materialId) {
      return Response.json({ error: 'vendor_id + material_id required' }, { status: 400 });
    }
    // Unmapping now has a consequence beyond this screen: a PO that is still
    // open on that exact pair can no longer be edited or re-saved (the PO write
    // routes refuse an unmapped pair). Count them so the caller can say so
    // instead of the buyer discovering it at the next edit. Counting, not
    // blocking — the admin may be unmapping precisely because it was wrong.
    const openLines = db.prepare(`
      SELECT COUNT(*) AS c
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.po_id
      WHERE poi.material_id = ? AND poi.vendor_id = ?
        AND po.status IN ('draft', 'pending', 'pending_reapproval', 'approved')
    `).get(materialId, vendorId) as any;
    const r = db.prepare(`DELETE FROM vendor_materials WHERE vendor_id = ? AND material_id = ?`).run(vendorId, materialId);
    return Response.json({ removed: r.changes, open_po_lines: Number(openLines?.c) || 0 });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
