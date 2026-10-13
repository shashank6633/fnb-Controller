import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { ensureBohSchema } from '@/lib/boh-schema';
import { getBoh, reassignBoh, BohError } from '@/lib/boh';
import { canViewBoh, canReassignBoh } from '@/lib/boh-access';

/**
 * POST /api/boh/[id]/reassign — hand the BOH to a different responsible user.
 *
 * A BOH MUST NEVER EXIST WITHOUT A RESPONSIBLE USER, so this is a HAND-OVER and
 * never a clear: the new user is validated (exists, still active) before
 * anything is written, and the column is NOT NULL besides.
 *
 * EVERY REASSIGNMENT IS RECORDED — previous user, new user, changed by, when,
 * why — as an append-only boh_assignments row written BEFORE the update, so a
 * crash between the two leaves the evidence rather than the silent change. A
 * reason is mandatory. Nothing in that table is ever updated or deleted.
 *
 * WHO MAY: management, the CURRENT responsible user (handing their own bill on
 * is not a till operation, and someone who can no longer reach the bill cannot
 * be held accountable for it either), or anyone settleAuthority would let close
 * the bill.
 */
export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    if (!ensureBohSchema(db)) return Response.json({ error: 'The Bills on Hold tables are unavailable on this database.' }, { status: 503 });
    const { id } = await params;
    const outletId = await getCurrentOutletId();

    const boh = getBoh(db, id);
    if (!boh) return Response.json({ error: 'BOH not found' }, { status: 404 });
    if (!canViewBoh(me, boh)) return Response.json({ error: 'This bill on hold is not yours.' }, { status: 403 });
    const gate = canReassignBoh(db, me, boh, outletId);
    if (!gate.allowed) return Response.json({ error: gate.message, ...(gate.detail || {}) }, { status: gate.status });

    const b = await req.json().catch(() => ({}));
    const updated = reassignBoh(db, id, String(b?.user_id || ''), String(b?.reason || ''), {
      id: me.id, email: me.email, name: me.name, role: me.role,
    });
    return Response.json({ boh: updated });
  } catch (e: any) {
    if (e instanceof BohError) return Response.json({ error: e.message }, { status: e.status });
    console.error('[/api/boh/[id]/reassign POST]', e);
    return Response.json({ error: e?.message || 'Failed to reassign' }, { status: 500 });
  }
}
