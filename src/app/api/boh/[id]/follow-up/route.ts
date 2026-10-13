import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { ensureBohSchema } from '@/lib/boh-schema';
import { getBoh, addFollowUp, BohError } from '@/lib/boh';
import { canViewBoh, canActOnBoh } from '@/lib/boh-access';
import { BOH_OUTCOMES } from '@/lib/boh-schema';

/**
 * POST /api/boh/[id]/follow-up — log what happened when someone chased the bill.
 *
 * The owner's outcome list, verbatim: Payment Received · Not Received ·
 * Customer Requested More Time · Customer Not Responding · Payment Processing ·
 * Dispute/Clarification Required · Other.
 *
 * WHEN THE PAYMENT WAS NOT RECEIVED, remarks AND a new expected date are BOTH
 * mandatory, and writing that date opens the next reminder slot — the loop
 * continues "until settled". The engine enforces it; the route only shapes the
 * input, so the rule cannot be bypassed by a different caller.
 *
 * A FOLLOW-UP NEVER MOVES MONEY. 'payment_received' here is a statement about
 * the conversation, not a collection; the collection is a boh_payments row
 * through POST /api/boh/[id]/payments, which is the only path that can change a
 * balance. Keeping them apart is what stops a phone call from closing a bill.
 *
 * NOTHING IS EVER OVERWRITTEN: each follow-up is a new append-only row carrying
 * the expected date it was ANSWERING, which is what makes "missed follow-up"
 * countable after three re-dates.
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
    const gate = canActOnBoh(db, me, boh, outletId);
    if (!gate.allowed) return Response.json({ error: gate.message, ...(gate.detail || {}) }, { status: gate.status });

    const b = await req.json().catch(() => ({}));
    const updated = addFollowUp(db, id, {
      outcome: String(b?.outcome || ''),
      remarks: b?.remarks,
      nextExpectedDate: b?.next_expected_date,
    }, { id: me.id, email: me.email, name: me.name, role: me.role });

    return Response.json({ boh: updated, outcomes: BOH_OUTCOMES });
  } catch (e: any) {
    if (e instanceof BohError) return Response.json({ error: e.message }, { status: e.status });
    console.error('[/api/boh/[id]/follow-up POST]', e);
    return Response.json({ error: e?.message || 'Failed to log the follow-up' }, { status: 500 });
  }
}
