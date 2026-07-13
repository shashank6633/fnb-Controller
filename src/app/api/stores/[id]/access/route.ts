import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { getStoreById } from '@/lib/store-engine';

/**
 * Per-user access grants for one store ("Authorized Liquor Users").
 * Admin / HOD / Store Manager / 'bar manager' titles bypass these rows
 * entirely (see userStoreAccess in src/lib/store-engine.ts) — grants here are
 * for everyone else.
 *
 * POST   /api/stores/[id]/access  { user_id, can_view?, can_procure?, can_adjust?, can_close_stock? }
 *        upsert (missing flags default: view=1, others=0)              admin
 * DELETE /api/stores/[id]/access  { user_id }   (or ?user_id=)  remove admin
 */
export const dynamic = 'force-dynamic';

async function gate(params: Promise<{ id: string }>) {
  const auth = await requireRole('admin');
  if (!auth.ok) return { err: Response.json({ error: auth.message }, { status: auth.status }) };
  const { id } = await params;
  const db = getDb();
  const store = getStoreById(db, id);
  if (!store) return { err: Response.json({ error: 'Store not found' }, { status: 404 }) };
  return { db, store };
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const g = await gate(params);
    if ('err' in g) return g.err;
    const b = await request.json();
    const userId = String(b.user_id || '').trim();
    if (!userId) return Response.json({ error: 'user_id is required' }, { status: 400 });
    const user = g.db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(userId);
    if (!user) return Response.json({ error: 'User not found or inactive' }, { status: 404 });

    const flags = {
      can_view: b.can_view === undefined ? 1 : (b.can_view ? 1 : 0),
      can_procure: b.can_procure ? 1 : 0,
      can_adjust: b.can_adjust ? 1 : 0,
      can_close_stock: b.can_close_stock ? 1 : 0,
    };
    g.db.prepare(`
      INSERT INTO store_user_access (id, store_id, user_id, can_view, can_procure, can_adjust, can_close_stock)
      VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?)
      ON CONFLICT(store_id, user_id) DO UPDATE SET
        can_view = excluded.can_view,
        can_procure = excluded.can_procure,
        can_adjust = excluded.can_adjust,
        can_close_stock = excluded.can_close_stock
    `).run(g.store.id, userId, flags.can_view, flags.can_procure, flags.can_adjust, flags.can_close_stock);

    return Response.json({ ok: true, user_id: userId, ...flags });
  } catch (e: any) {
    console.error('[/api/stores/[id]/access POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const g = await gate(params);
    if ('err' in g) return g.err;
    let userId = new URL(request.url).searchParams.get('user_id') || '';
    if (!userId) {
      try { userId = String((await request.json())?.user_id || ''); } catch { /* no body */ }
    }
    userId = userId.trim();
    if (!userId) return Response.json({ error: 'user_id is required' }, { status: 400 });

    const r = g.db.prepare('DELETE FROM store_user_access WHERE store_id = ? AND user_id = ?')
      .run(g.store.id, userId);
    if (r.changes === 0) return Response.json({ error: 'No grant found for that user' }, { status: 404 });
    return Response.json({ ok: true });
  } catch (e: any) {
    console.error('[/api/stores/[id]/access DELETE]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
