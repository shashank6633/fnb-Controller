import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { getStoreById, userStoreAccess, getStoreInwardRegister } from '@/lib/store-engine';

/**
 * GET /api/stores/[id]/inward-register?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Flat inward register (one row per purchase LINE) in the TGBCL sheet's column
 * order. Per-line charges ride the ledger row; the four bill-level charges are
 * allocated per line so Σ(total_inward) = the bill's Net Indent Value.
 * Gate: userStoreAccess(...).can_view.
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
    if (!access.can_view) return Response.json({ error: `You are not authorized to view ${store.name}` }, { status: 403 });

    const url = new URL(request.url);
    const from = (url.searchParams.get('from') || '').trim();
    const to = (url.searchParams.get('to') || '').trim();
    const rows = getStoreInwardRegister(db, storeId, from || undefined, to || undefined);
    return Response.json({ store: { id: store.id, name: store.name }, rows });
  } catch (e: any) {
    console.error('[/api/stores/[id]/inward-register GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
