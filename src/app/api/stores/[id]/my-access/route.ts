import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { getStoreById, userStoreAccess } from '@/lib/store-engine';

/**
 * GET /api/stores/[id]/my-access — the CALLER's resolved permissions for one
 * store. Any signed-in user (it only ever reveals their own grants — this is
 * what the store inventory page uses for its 🔒 gate, so it must not 403).
 */
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id: storeId } = await params;
    const db = getDb();

    const store = getStoreById(db, storeId);
    if (!store) return Response.json({ error: 'Store not found' }, { status: 404 });

    return Response.json({
      store: { id: store.id, name: store.name, code: store.code, is_active: store.is_active },
      access: userStoreAccess(db, user, storeId),
    });
  } catch (e: any) {
    console.error('[/api/stores/[id]/my-access GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
