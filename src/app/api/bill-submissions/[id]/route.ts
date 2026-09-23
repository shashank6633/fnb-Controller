import { getCurrentUser } from '@/lib/auth';
import {
  billHandoverDb,
  canConfirmBillHandover,
  canRecordBillHandover,
  canViewBillHandovers,
  canVoidConfirmedBillHandover,
  getBillHandover,
  getBillHandoverTrail,
  selfConfirmRefusal,
  cutoffState,
  ACCOUNTS_ROLE_NAME,
  BH_SUBMITTED,
} from '@/lib/bill-handover';

/**
 * ONE BILL + ITS FULL HANDOVER HISTORY
 * ====================================
 *
 *   GET /api/bill-submissions/:id
 *     -> { handover, trail, cutoff, can }
 *
 * `trail` is every status change with who and when — the audit trail the owner
 * asked for, in the order it happened. Nothing is ever deleted from it, and a
 * voided record keeps its whole history.
 *
 * `can.confirm_this` is the per-row answer, not the per-user one: it is false
 * when the viewer is the person who recorded or submitted this bill, so the
 * screen can explain the refusal instead of rendering a button that 403s.
 *
 * DELETE is deliberately NOT implemented. The owner asked for an audit trail;
 * withdraw a record with POST :id/void and a reason.
 */
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canViewBillHandovers(me)) {
    return Response.json(
      { error: `Only the Store team or the ${ACCOUNTS_ROLE_NAME} team can view vendor bill submissions.` },
      { status: 403 },
    );
  }

  try {
    const { id } = await params;
    const db = billHandoverDb();
    const handover = getBillHandover(db, id);
    if (!handover) return Response.json({ error: 'That bill record no longer exists.' }, { status: 404 });

    const refusal = selfConfirmRefusal(handover, me);
    return Response.json({
      handover,
      trail: getBillHandoverTrail(db, id),
      cutoff: cutoffState(db),
      can: {
        record: canRecordBillHandover(me),
        confirm: canConfirmBillHandover(me),
        // The button the Accounts screen should actually render for THIS row.
        confirm_this: canConfirmBillHandover(me) && !refusal && handover.status === BH_SUBMITTED,
        confirm_blocked_reason: refusal,
        void_confirmed: canVoidConfirmedBillHandover(me),
      },
    });
  } catch (e) {
    console.error('GET /api/bill-submissions/[id] failed:', e);
    return Response.json({ error: 'Could not load that bill record.' }, { status: 500 });
  }
}
