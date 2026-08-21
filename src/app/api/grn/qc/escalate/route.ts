import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { overdueQcCount, qcEscalationHours } from '@/lib/grn-qc';
import { escalateOverdueQc } from '@/lib/grn-qc-notify';

/**
 * "THIS HAS WAITED TOO LONG" — the escalation sweep.
 *
 *   POST /api/grn/qc/escalate → pings the head chefs + admins about every held
 *                               receipt past the threshold that has not been
 *                               pinged yet, and stamps it so it is not pinged
 *                               again.
 *
 * THERE IS NO SCHEDULER IN THIS APP. Nothing runs on a timer server-side, so
 * the sweep has to be poked. Two callers are expected and both are safe:
 *   · the Pending Quality Checks page, on load / on its poll;
 *   · an external cron (`curl -X POST …`) if the venue ever wants one.
 *
 * IDEMPOTENT BY CONSTRUCTION, which is what makes that acceptable: a GRN is
 * escalated only while qc_escalated_at IS NULL, and the stamp is taken in the
 * SAME conditional UPDATE that claims it — so a page polling every 45 seconds
 * pings once, not eighty times an hour. Running two sweeps concurrently is safe
 * for the same reason (better-sqlite3 writes are serialised by SQLite's write
 * lock, and the loser's claim matches zero rows).
 *
 * SELF-AUTHENTICATES: any signed-in user may poke it, which is the same bar as
 * reading the queue it sweeps. It moves no stock, writes no money and cannot
 * ping anyone who is not a head chef or an admin — the worst a hostile caller
 * achieves is making an already-overdue delivery escalate a few seconds sooner
 * than the next page load would have. A tighter gate would mean the sweep only
 * runs when an admin happens to open the page, which is precisely when the
 * escalation is least needed.
 *
 * NEVER FAILS THE CALLER. escalateOverdueQc swallows its own errors; this
 * returns what it managed to do.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    // Outlet-scoped like the queue: another outlet's overdue delivery is not
    // this session's to escalate, and its own users' sweep will catch it.
    const outletId = await getCurrentOutletId();
    const res = await escalateOverdueQc(db, { outletId });
    return Response.json({
      success: true,
      escalated: res.escalated,
      grns: res.grns,
      // The standing overdue population, which is NOT the same number: a GRN
      // already escalated stays overdue and stays in this count, but is never
      // pinged twice. Reporting only `escalated` would read as "nothing is
      // overdue" the second time anyone looks.
      overdue_count: overdueQcCount(db, outletId),
      escalation_hours: qcEscalationHours(db),
    });
  } catch (e: any) {
    console.error('[/api/grn/qc/escalate]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
