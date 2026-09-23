import { getCurrentUser } from '@/lib/auth';
import { logAuditEvent } from '@/lib/db';
import {
  billHandoverDb,
  canConfirmBillHandover,
  confirmBillHandover,
  accountsRoleState,
  ACCOUNTS_ROLE_NAME,
} from '@/lib/bill-handover';

/**
 * ACCOUNTS CLICKS "CONFIRM RECEIVED"
 * ==================================
 *
 *   POST /api/bill-submissions/:id/confirm   { note? }
 *     -> { handover }
 *
 * "Submitted - Awaiting Accounts Confirmation" -> "Received by Accounts",
 * recording Received/Confirmed By and the Accounts Confirmation Date & Time.
 *
 * ── THREE RULES, ENFORCED HERE AND NOWHERE ELSE ────────────────────────────
 *
 * 1. NOTHING AUTO-CONFIRMS. This handler is the ONLY caller of
 *    confirmBillHandover(), which is the only function in the app that writes
 *    status='received'. There is no cron, no backfill, no "auto-confirm after N
 *    days". A machine-set confirmation would be a lie in exactly the place the
 *    owner asked for the truth: "prevent situations where there is confusion
 *    about whether a vendor bill was actually handed over".
 *
 * 2. THE SUBMITTER CANNOT CONFIRM THEIR OWN SUBMISSION. Checked in TypeScript
 *    (selfConfirmRefusal) and re-stated in the UPDATE's WHERE clause, against
 *    BOTH created_by_id and submitted_by_id, with NO admin exemption. Two people
 *    or it is not evidence.
 *
 * 3. THE ROLE GATE, BY NAME. canConfirmBillHandover = admin OR a user whose
 *    resolved role_name matches "Accounts" case-insensitively. The role does not
 *    exist yet — the owner creates it himself in Settings -> Roles; production
 *    config is his and we never create one. Admin is the fail-safe so the
 *    Accounts side is not dead on arrival, and it is the ONLY fallback: no tier
 *    fallback, no isManagement(), no "if the role is missing let managers in".
 *
 *    A 403 from here carries `accounts_role` so the screen can tell the owner,
 *    in plain words, that the role is missing and exactly what to type.
 *
 * Self-gating (the proxy guards pages, not APIs). CSRF is inherited from the
 * '/api/bill-submissions' prefix in src/proxy.ts.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  if (!canConfirmBillHandover(me)) {
    // Diagnosis (never the gate) so the refusal is actionable rather than a wall.
    let accounts_role: ReturnType<typeof accountsRoleState> | undefined;
    try {
      accounts_role = accountsRoleState(billHandoverDb());
    } catch {
      /* the 403 stands regardless */
    }
    return Response.json(
      {
        error: `Only the ${ACCOUNTS_ROLE_NAME} team (or an Administrator) can confirm that a bill was received.`,
        accounts_role,
      },
      { status: 403 },
    );
  }

  try {
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const db = billHandoverDb();

    const result = confirmBillHandover(db, id, me, String(body?.note ?? ''));
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });

    logAuditEvent(db, {
      event_type: 'bill_handover.confirm',
      entity_type: 'bill_handover',
      entity_id: id,
      actor_email: me.email,
      outlet_id: result.value.outlet_id,
      after: {
        bill_no: result.value.bill_no,
        vendor: result.value.vendor_name,
        bill_value: result.value.bill_value,
        submitted_by: result.value.submitted_by_email,
        submitted_at: result.value.submitted_at,
        confirmed_at: result.value.confirmed_at,
      },
      note: 'Accounts confirmed receipt of the vendor bill',
    });

    return Response.json({ handover: result.value });
  } catch (e) {
    console.error('POST /api/bill-submissions/[id]/confirm failed:', e);
    return Response.json({ error: 'Could not confirm receipt of that bill.' }, { status: 500 });
  }
}
