import { getCurrentUser } from '@/lib/auth';
import {
  billHandoverDb,
  billHandoverSummary,
  canConfirmBillHandover,
  canRecordBillHandover,
  canViewBillHandovers,
  accountsRoleState,
  ACCOUNTS_ROLE_NAME,
  BH_STATUS_LABEL,
  BH_STATUS_SHORT,
} from '@/lib/bill-handover';

/**
 * THE DASHBOARD — Pending Submission / Submitted to Accounts / Received by Accounts
 * ================================================================================
 *
 *   GET /api/bill-submissions/summary
 *     -> { counts, values, not_yet_recorded, oldest_pending_date,
 *          oldest_submitted_date, cutoff, labels, accounts_role, can }
 *
 * ── WHY THE DAY-ONE BACKLOG CANNOT APPEAR HERE ─────────────────────────────
 * `counts` is a GROUP BY over bill_handovers ONLY, bounded by
 * received_date >= the recorded cutoff. Nothing on this route reads `purchases`.
 * The owner's database holds 2,165 purchase rows of which 2,121 have no bill
 * identity at all; none of them can reach this response, because none of them is
 * a bill_handovers row and the table starts empty. Proven on a real snapshot:
 * with the cutoff set, Pending Submission = 0.
 *
 * `not_yet_recorded` is the one figure derived from elsewhere — goods receipts
 * on/after the cutoff with no handover record — and it is returned as its OWN
 * number, never folded into Pending. It is the leak detector for a store person
 * who skipped the quality-check prompt. Measured on the real snapshot it is 0:
 * all 29 goods receipts are dated 2026-08-07, long before any realistic cutoff.
 *
 * Self-gating: the proxy does not guard API routes.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canViewBillHandovers(me)) {
    return Response.json(
      { error: `Only the Store team or the ${ACCOUNTS_ROLE_NAME} team can view vendor bill submissions.` },
      { status: 403 },
    );
  }

  try {
    const db = billHandoverDb();
    const summary = billHandoverSummary(db);
    return Response.json({
      ...summary,
      // The owner's own words for the three states — shipped with the data so
      // the two screens cannot paraphrase them differently.
      labels: { long: BH_STATUS_LABEL, short: BH_STATUS_SHORT },
      accounts_role: accountsRoleState(db),
      can: { record: canRecordBillHandover(me), confirm: canConfirmBillHandover(me) },
    });
  } catch (e) {
    console.error('GET /api/bill-submissions/summary failed:', e);
    return Response.json({ error: 'Could not load the bill submission dashboard.' }, { status: 500 });
  }
}
