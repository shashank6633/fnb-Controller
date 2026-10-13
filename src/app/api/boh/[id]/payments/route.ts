import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { ensureBohSchema } from '@/lib/boh-schema';
import { getBoh, recordBohPayment, reverseBohPayment, BohError } from '@/lib/boh';
import { canViewBoh, canActOnBoh, canVoidBoh } from '@/lib/boh-access';

/**
 * POST   /api/boh/[id]/payments — record a collection. PARTIALS SUPPORTED.
 * DELETE /api/boh/[id]/payments — REVERSE a payment recorded in error. Admin
 *                                 only, and it does NOT delete: it appends a
 *                                 negative row carrying reverses_payment_id.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * A BOH PAYMENT IS A PAYMENT RECORD. IT IS NOT A SALE.
 * ════════════════════════════════════════════════════════════════════════════
 * Revenue was booked and stock was deducted AT THE MOMENT OF HOLD — hold writes
 * the `sales` rows, posts the department ledger and the central inventory
 * transactions, and freezes the totals; settle-from-hold then skips its own
 * item loop entirely. So this route writes ONE boh_payments row and nothing
 * else. It does not call recordSale. It does not move stock. It does not touch
 * the order's frozen totals.
 *
 * That is not left to this comment: recordBohPayment() snapshots six rails
 * (sales, inventory_transactions, department_material_transactions,
 * consumption_skips, store_stock_ledger, order_items' deduction stamps) plus
 * the order's frozen money columns INSIDE the transaction, and THROWS — rolling
 * the payment back — if any of them moved.
 *
 * ── THE FINAL CLEARING PAYMENT ─────────────────────────────────────────────
 * The payment that takes the balance to zero — and ONLY that one — closes the
 * BOH and settles the underlying order, mirroring settle/route.ts's fromHold
 * branch exactly (the same four columns, the same Math.round(order.total), the
 * same order_payments DELETE + re-INSERT, the same 'split' rule). Everything
 * before it leaves the POS untouched and the bill on hold.
 *
 * Gated by settleAuthority through canActOnBoh — the SAME call the hold route
 * makes. Collecting against a bill someone already finalised is strictly less
 * power than finalising it, and sharing the function means the two cannot drift.
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
    const res = recordBohPayment(db, id, {
      amount: Number(b?.amount),
      mode: String(b?.mode || ''),
      paidOn: b?.paid_on,
      reference: b?.reference,
      remarks: b?.remarks,
    }, { id: me.id, email: me.email, name: me.name, role: me.role });

    return Response.json({
      boh: res.boh,
      payment_id: res.payment_id,
      closed: res.closed,
      order_sync: res.order_sync,
      order_sync_note: res.order_sync_note,
    });
  } catch (e: any) {
    if (e instanceof BohError) return Response.json({ error: e.message }, { status: e.status });
    // A money-rule violation surfaces as a 500 with its own sentence. That is
    // deliberate: it means a code path tried to write a sale, and the operator
    // must see something has gone badly wrong rather than a tidy 400.
    console.error('[/api/boh/[id]/payments POST]', e);
    return Response.json({ error: e?.message || 'Failed to record the payment' }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    // ADMIN ONLY. Un-recording collected money is not a till correction.
    const gate = canVoidBoh(me);
    if (!gate.allowed) return Response.json({ error: gate.message }, { status: gate.status });

    const db = getDb();
    if (!ensureBohSchema(db)) return Response.json({ error: 'The Bills on Hold tables are unavailable on this database.' }, { status: 503 });
    const { id } = await params;
    const b = await req.json().catch(() => ({}));
    const paymentId = String(b?.payment_id || '').trim();
    if (!paymentId) return Response.json({ error: 'payment_id is required' }, { status: 400 });

    const boh = reverseBohPayment(db, id, paymentId, String(b?.reason || ''), {
      id: me.id, email: me.email, name: me.name, role: me.role,
    });
    return Response.json({ boh });
  } catch (e: any) {
    if (e instanceof BohError) return Response.json({ error: e.message }, { status: e.status });
    console.error('[/api/boh/[id]/payments DELETE]', e);
    return Response.json({ error: e?.message || 'Failed to reverse the payment' }, { status: 500 });
  }
}
