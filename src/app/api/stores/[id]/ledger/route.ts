import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { getStoreById, userStoreAccess, LEDGER_TXN_TYPES } from '@/lib/store-engine';

/**
 * GET /api/stores/[id]/ledger — filterable store ledger, newest first.
 * Gate: userStoreAccess(...).can_view.
 *
 * Query params: ?type=purchase|adjustment|… &material_id=… &q=<material name
 * search> &from=YYYY-MM-DD &to=YYYY-MM-DD &limit=N (default 300, max 1000)
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id: storeId } = await params;
    const db = getDb();

    const store = getStoreById(db, storeId);
    if (!store) return Response.json({ error: 'Store not found' }, { status: 404 });

    const access = userStoreAccess(db, user, storeId);
    if (!access.can_view) {
      return Response.json({ error: `You are not authorized to view ${store.name}` }, { status: 403 });
    }

    const url = new URL(request.url);
    const type = (url.searchParams.get('type') || '').trim();
    const materialId = (url.searchParams.get('material_id') || '').trim();
    const q = (url.searchParams.get('q') || '').trim();
    const from = (url.searchParams.get('from') || '').trim();
    const to = (url.searchParams.get('to') || '').trim();
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 300, 1), 1000);

    const where: string[] = ['l.store_id = ?'];
    const args: any[] = [storeId];
    if (type && (LEDGER_TXN_TYPES as readonly string[]).includes(type)) {
      where.push('l.txn_type = ?'); args.push(type);
    }
    if (materialId) { where.push('l.material_id = ?'); args.push(materialId); }
    if (q) { where.push('rm.name LIKE ?'); args.push(`%${q}%`); }
    if (from) { where.push("date(l.created_at) >= date(?)"); args.push(from); }
    if (to)   { where.push("date(l.created_at) <= date(?)"); args.push(to); }

    const rows = db.prepare(`
      SELECT l.id, l.txn_type, l.quantity, l.unit_cost, l.batch_no, l.supplier,
             l.vendor_id, l.expiry_date, l.ref, l.notes, l.created_by, l.created_at,
             rm.name AS material_name, rm.unit, rm.purchase_unit, rm.pack_size
      FROM store_stock_ledger l
      JOIN raw_materials rm ON rm.id = l.material_id
      WHERE ${where.join(' AND ')}
      ORDER BY l.created_at DESC, l.rowid DESC
      LIMIT ?
    `).all(...args, limit);

    return Response.json({ store: { id: store.id, name: store.name }, ledger: rows });
  } catch (e: any) {
    console.error('[/api/stores/[id]/ledger GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
