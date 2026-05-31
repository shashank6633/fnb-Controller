import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * vendor_materials — simple (vendor, material) MAPPING.
 *   "This vendor sells this material." No price, no contract.
 *
 * GET    /api/vendor-materials?vendor_id=X        → list materials mapped to vendor
 * GET    /api/vendor-materials?material_id=Y      → list vendors mapped to material
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
    if (!vendorId && !materialId) {
      return Response.json({ error: 'vendor_id or material_id required' }, { status: 400 });
    }
    const where: string[] = [];
    const params: any[] = [];
    if (vendorId)   { where.push('vm.vendor_id = ?');   params.push(vendorId); }
    if (materialId) { where.push('vm.material_id = ?'); params.push(materialId); }
    const rows = db.prepare(`
      SELECT vm.vendor_id, vm.material_id, vm.notes, vm.created_at, vm.created_by,
             v.name  AS vendor_name,
             rm.name AS material_name, rm.sku AS material_sku, rm.unit AS material_unit
      FROM vendor_materials vm
      JOIN vendors v       ON v.id  = vm.vendor_id
      JOIN raw_materials rm ON rm.id = vm.material_id
      WHERE ${where.join(' AND ')}
      ORDER BY rm.name
    `).all(...params);
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

    const ins = db.prepare(`
      INSERT OR IGNORE INTO vendor_materials (vendor_id, material_id, notes, created_by)
      VALUES (?, ?, ?, ?)
    `);

    // Bulk path: { vendor_id, material_ids: [...] }
    if (Array.isArray(b.material_ids)) {
      let added = 0;
      const txn = db.transaction(() => {
        for (const mid of b.material_ids) {
          if (!mid) continue;
          const r = ins.run(b.vendor_id, mid, b.notes || '', me.email);
          if (r.changes > 0) added += 1;
        }
      });
      txn();
      return Response.json({ added, skipped_existing: b.material_ids.length - added });
    }

    // Single path: { vendor_id, material_id }
    if (!b.material_id) return Response.json({ error: 'material_id (or material_ids) required' }, { status: 400 });
    const r = ins.run(b.vendor_id, b.material_id, b.notes || '', me.email);
    return Response.json({ added: r.changes, success: true }, { status: 201 });
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
    const r = db.prepare(`DELETE FROM vendor_materials WHERE vendor_id = ? AND material_id = ?`).run(vendorId, materialId);
    return Response.json({ removed: r.changes });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
