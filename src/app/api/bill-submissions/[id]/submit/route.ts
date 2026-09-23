import { getCurrentUser } from '@/lib/auth';
import { logAuditEvent } from '@/lib/db';
import { billHandoverDb, canRecordBillHandover, submitBillHandover } from '@/lib/bill-handover';

/**
 * STORE CLICKS "SUBMITTED TO ACCOUNTS"
 * ====================================
 *
 *   POST /api/bill-submissions/:id/submit   { note? }
 *     -> { handover }
 *
 * Pending Submission -> "Submitted - Awaiting Accounts Confirmation", stamping
 * who and when. The timestamp is written by SQLite's datetime('now') (UTC) and
 * rendered in IST through src/lib/format-date.ts — this stamp is half of the
 * evidence the whole feature exists to produce, so it is never taken from the
 * client clock.
 *
 * GATE: canRecordBillHandover — Management or the Store Manager (the same
 * membership as poWriteGate, i.e. the people who receive deliveries), and
 * explicitly NOT an Accounts-role holder. The person who submits must not be the
 * person who confirms, and that starts here.
 *
 * Self-gating (the proxy guards pages, not APIs). CSRF is inherited from the
 * '/api/bill-submissions' prefix registered in src/proxy.ts.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canRecordBillHandover(me)) {
    return Response.json(
      {
        error:
          'Only Management or the Store Manager can mark a vendor bill as submitted to Accounts.',
      },
      { status: 403 },
    );
  }

  try {
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const db = billHandoverDb();

    const result = submitBillHandover(db, id, me, String(body?.note ?? ''));
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });

    logAuditEvent(db, {
      event_type: 'bill_handover.submit',
      entity_type: 'bill_handover',
      entity_id: id,
      actor_email: me.email,
      outlet_id: result.value.outlet_id,
      after: {
        bill_no: result.value.bill_no,
        vendor: result.value.vendor_name,
        bill_value: result.value.bill_value,
        submitted_at: result.value.submitted_at,
      },
      note: 'Store submitted the vendor bill to Accounts',
    });

    return Response.json({ handover: result.value });
  } catch (e) {
    console.error('POST /api/bill-submissions/[id]/submit failed:', e);
    return Response.json({ error: 'Could not mark that bill as submitted.' }, { status: 500 });
  }
}
