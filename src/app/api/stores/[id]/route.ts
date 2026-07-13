import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { getStoreById, getStoreByName } from '@/lib/store-engine';

/**
 * PUT /api/stores/[id]   { name?, code?, description?, is_active?, requires_authorization? }
 *   Rename / retag / toggle a store location.                    admin only
 *
 * Deliberately NO DELETE: a store may own ledger history (store_stock_ledger
 * is the source of truth) — deactivate (is_active = 0) instead. A deactivated
 * store also releases its category claims (materialStoreId only matches
 * active stores), so its materials fall back to Central behaviour.
 */
export const dynamic = 'force-dynamic';

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireRole('admin');
    if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });
    const { id } = await params;
    const db = getDb();

    const store = getStoreById(db, id);
    if (!store) return Response.json({ error: 'Store not found' }, { status: 404 });

    const b = await request.json();
    const next = {
      name: b.name !== undefined ? String(b.name).trim() : store.name,
      code: b.code !== undefined ? String(b.code).trim() : store.code,
      description: b.description !== undefined ? String(b.description).trim() : store.description,
      is_active: b.is_active !== undefined ? (b.is_active ? 1 : 0) : store.is_active,
      requires_authorization: b.requires_authorization !== undefined ? (b.requires_authorization ? 1 : 0) : store.requires_authorization,
    };
    if (!next.name) return Response.json({ error: 'Store name cannot be empty' }, { status: 400 });
    const clash = getStoreByName(db, next.name);
    if (clash && clash.id !== id) {
      return Response.json({ error: `A store named "${next.name}" already exists` }, { status: 409 });
    }

    db.prepare(`
      UPDATE store_locations
      SET name = ?, code = ?, description = ?, is_active = ?, requires_authorization = ?
      WHERE id = ?
    `).run(next.name, next.code, next.description, next.is_active, next.requires_authorization, id);

    return Response.json({ ok: true, store: getStoreById(db, id) });
  } catch (e: any) {
    console.error('[/api/stores/[id] PUT]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
