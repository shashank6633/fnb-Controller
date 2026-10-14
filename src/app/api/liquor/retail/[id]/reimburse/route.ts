import { getDb } from '@/lib/db';
import { getCurrentOutletId } from '@/lib/auth';
import { closeReimbursementWithPettyCash, retailErrorResponse } from '@/lib/liquor-retail';
import { requireRetailReimburse, gateResponse } from '../../_lib/guard';

/**
 * POST /api/liquor/retail/[id]/reimburse — close a pending wine-shop
 * reimbursement by paying the staff member back out of the petty cash box.
 *
 * Writes ONE petty_cash_ledger 'out' row and flips the flag to 'reimbursed',
 * linked by lq_retail_flags.petty_cash_id (ON DELETE SET NULL — deleting the
 * payout reopens the claim, and a reopened claim can be paid again). Gated at
 * the petty-cash write level, CSRF-checked here because '/api/liquor' is not in
 * the proxy's CSRF prefix list. See src/lib/liquor-retail.ts
 * closeReimbursementWithPettyCash() for the rules.
 *
 * body (all optional): { amount?, date?, notes? }
 *   amount — a CONFIRMATION of the figure owed (bottles × rate paid), not a free
 *            amount: the record has nowhere to store a part-payment, so a payout
 *            closes a claim only in full and a mismatch is refused.
 *   date   — the day the cash left the box; defaults to today (IST).
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const gate = await requireRetailReimburse(request);
    if (!gate.ok) return gateResponse(gate);

    const { id } = await params;
    if (!id) return Response.json({ error: 'A wine-shop record id is required.' }, { status: 400 });

    const db = getDb();
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    // Only a number or a numeric STRING is an amount. Without this, Number()
    // coerces JSON that is not a figure at all into one — `true` becomes ₹1.00
    // and `[5]` becomes ₹5.00 — and the ledger records a payment nobody typed.
    // The petty-cash door states this rule (route.ts:238-242); this is the third
    // door into the same ledger and it must not be softer than the other two.
    let amountOverride: number | null = null;
    if (body.amount !== undefined && body.amount !== null && String(body.amount).trim() !== '') {
      if (typeof body.amount !== 'number' && typeof body.amount !== 'string') {
        return Response.json({ error: 'amount must be a number.' }, { status: 400 });
      }
      amountOverride = Number(body.amount);
      if (!Number.isFinite(amountOverride) || amountOverride <= 0) {
        return Response.json({ error: 'amount, when given, must be a number greater than 0.' }, { status: 400 });
      }
    }

    // Passed as a FALLBACK only: the library debits the box of the outlet the
    // CLAIM belongs to (its purchase's outlet), never the browsing session's.
    const outletId = await getCurrentOutletId();
    const result = closeReimbursementWithPettyCash(db, {
      flagId: id,
      actorEmail: gate.user.email,
      outletId,
      date: body.date === undefined || body.date === null ? undefined : String(body.date),
      notes: body.notes ? String(body.notes) : undefined,
      amountOverride,
    });

    return Response.json({
      ok: true,
      petty_cash_id: result.pettyCashId,
      flag_id: result.flagId,
      amount: result.amount,
      outlet_id: result.outletId,
      date: result.date,
      ...(result.warning ? { warning: result.warning, overdrawn: true } : {}),
    }, { status: 201 });
  } catch (e: any) {
    // "Already reimbursed" is a 409, "no such record" a 404, "wrong amount" a
    // 400 — not the blanket 500 that reads as a crash on a money route and
    // invites the retry the duplicate guard then has to refuse.
    return retailErrorResponse(e, 'Could not record the reimbursement.');
  }
}
