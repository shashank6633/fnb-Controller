import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { ensureBohSchema } from '@/lib/boh-schema';
import { voidBoh, BohError } from '@/lib/boh';
import { canVoidBoh } from '@/lib/boh-access';

/**
 * POST /api/boh/[id]/void — mark a BOH as created in error. ADMIN ONLY.
 *
 * ── A VOID KEEPS THE HISTORY ───────────────────────────────────────────────
 * The owner said twice that no follow-up or status history may be overwritten
 * or deleted. So this sets a STATUS and deletes nothing: every assignment,
 * follow-up, payment, reminder and audit row stays exactly where it was, and
 * the timeline still renders in full for the voided record.
 *
 * The unique index is ux_boh_bills_order_live ON boh_bills(order_id)
 * WHERE status <> 'void' — partial precisely so a corrected record can be
 * created for the same bill afterwards WITHOUT the mistaken one being deleted
 * to make room.
 *
 * Refused while money has been collected against it: a voided record carrying
 * payments would be collected money with no ledger.
 *
 * AND REFUSED ONCE MONEY HAS *EVER* MOVED — reversing the payments does NOT
 * unlock the void, and this paragraph replaces earlier advice that said it did.
 * A reversal is an append-only NEGATIVE row, so it drives the balance to zero
 * while leaving the collection on the record; a balance-only guard could
 * therefore be satisfied by undoing the payment, and the void would then erase
 * the only ledger saying that money arrived and was given back. Worse, a BOH
 * whose clearing payment SETTLED the POS bill keeps order_sync = 'settled' and
 * leaves the bill settled after a reversal, so voiding it would detach a paid
 * order from its explanation and free the partial unique index for a second
 * live BOH on a bill the books already call paid. voidBoh() therefore refuses
 * on the HISTORY — any collection ever recorded, or any record that cleared its
 * own bill — and both refusals come back as 409s through the catch below.
 *
 * WHAT TO DO INSTEAD: close the record with a reason (POST /api/boh/[id]/close),
 * which keeps the payments, the reversal and the timeline visible. Void remains
 * what it was built for — a record created in error that never took a rupee and
 * never touched its order.
 *
 * VOIDING A BOH DOES NOT TOUCH THE BILL. The POS order stays on hold and is
 * still owed — voiding the accountability record does not forgive the debt, and
 * an admin who wants that uses the write-off on /close, which says so.
 *
 * There is no DELETE method on this route, deliberately. A normal user cannot
 * permanently delete a BOH record or its follow-up history, and neither can an
 * admin: nothing in this module removes a row.
 */
export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const gate = canVoidBoh(me);
    if (!gate.allowed) return Response.json({ error: gate.message }, { status: gate.status });

    const db = getDb();
    if (!ensureBohSchema(db)) return Response.json({ error: 'The Bills on Hold tables are unavailable on this database.' }, { status: 503 });
    const { id } = await params;
    const b = await req.json().catch(() => ({}));

    const boh = voidBoh(db, id, String(b?.reason || ''), { id: me.id, email: me.email, name: me.name, role: me.role });
    return Response.json({ boh, note: 'The record is voided. Its full history is kept and the underlying bill is unchanged.' });
  } catch (e: any) {
    if (e instanceof BohError) return Response.json({ error: e.message }, { status: e.status });
    console.error('[/api/boh/[id]/void POST]', e);
    return Response.json({ error: e?.message || 'Failed to void' }, { status: 500 });
  }
}
