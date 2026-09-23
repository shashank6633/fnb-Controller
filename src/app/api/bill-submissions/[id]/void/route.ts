import { getCurrentUser } from '@/lib/auth';
import { logAuditEvent } from '@/lib/db';
import {
  billHandoverDb,
  canRecordBillHandover,
  canVoidConfirmedBillHandover,
  voidBillHandover,
} from '@/lib/bill-handover';

/**
 * WITHDRAW A BILL RECORD — VOID WITH A REASON, NEVER A DELETE
 * ==========================================================
 *
 *   POST /api/bill-submissions/:id/void   { reason }
 *     -> { handover }
 *
 * The owner asked for an audit trail, so a record entered in error must remain
 * visible as having existed and been withdrawn. A DELETE is the one operation
 * that turns "we can prove what happened" back into "we think we remember", so
 * there is no DELETE verb anywhere in this module.
 *
 * The row keeps every stamp it already had — who recorded it, who submitted it,
 * when — and gains voided_by / voided_at / void_reason. Its history rows are
 * untouched and a 'voided' event is appended.
 *
 * GATES:
 *   pending / submitted  — canRecordBillHandover (Management or Store Manager).
 *   received             — ADMIN ONLY. Undoing a confirmation Accounts already
 *                          gave is undoing the evidence itself.
 *   reason               — mandatory, minimum 3 characters. A void with no
 *                          reason is just a delete that left a gap.
 *
 * Voiding a GRN-backed record RELEASES that goods receipt: the unique index is
 * partial on status <> 'void', so the receipt can be recorded again, and until it
 * is, billHandoverSummary().not_yet_recorded counts it. A voided record cannot
 * strand a bill.
 *
 * Self-gating. CSRF inherited from the '/api/bill-submissions' prefix.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  // The coarse gate. voidBillHandover() applies the stricter admin-only rule for
  // an already-confirmed record, because that depends on the row, not the user.
  if (!canRecordBillHandover(me) && !canVoidConfirmedBillHandover(me)) {
    return Response.json(
      { error: 'Only Management or the Store Manager can void a vendor bill record.' },
      { status: 403 },
    );
  }

  try {
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const reason = String(body?.reason ?? '');
    const db = billHandoverDb();

    const result = voidBillHandover(db, id, me, reason);
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });

    logAuditEvent(db, {
      event_type: 'bill_handover.void',
      entity_type: 'bill_handover',
      entity_id: id,
      actor_email: me.email,
      outlet_id: result.value.outlet_id,
      after: {
        bill_no: result.value.bill_no,
        vendor: result.value.vendor_name,
        bill_value: result.value.bill_value,
        void_reason: result.value.void_reason,
        voided_at: result.value.voided_at,
      },
      note: 'Vendor bill handover record voided',
    });

    return Response.json({ handover: result.value });
  } catch (e) {
    console.error('POST /api/bill-submissions/[id]/void failed:', e);
    return Response.json({ error: 'Could not void that bill record.' }, { status: 500 });
  }
}
