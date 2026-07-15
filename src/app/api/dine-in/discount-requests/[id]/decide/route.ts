import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { round2 } from '@/lib/bill-calc';
import { canDecideDiscount, listDiscountRequests } from '@/lib/discount-requests';
import { notifyEvent } from '@/lib/whatsapp';

/**
 * POST /api/dine-in/discount-requests/[id]/decide  { approve: boolean, note? }
 *
 * Approver gate: admin | manager tier | is_head_chef (the remote counterpart of
 * the sync route's on-the-spot verifyApprover + canApproveTableOp gate).
 *
 * approve → apply the discount to the order EXACTLY as the sync route
 * (POST /api/dine-in/orders/[id]/discount) does — same columns, same math:
 *     discount_pct         = requested pct
 *     discount             = round2(subtotal × pct / 100)
 *     discount_approved_by = approver's display name
 *     updated_at           = datetime('now')
 * …inside one transaction with the request being marked approved.
 *
 * reject → mark the request rejected (order untouched).
 *
 * If the order is no longer open (settled/void) → 409 with a clear message,
 * and the stale request is auto-closed as rejected so it can't linger in the
 * approval queue / bell counts forever.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canDecideDiscount(me)) {
      return Response.json({ error: 'Manager, Admin or HOD access required' }, { status: 403 });
    }
    const { id } = await params;
    const db = getDb();

    const request = db.prepare('SELECT * FROM discount_requests WHERE id = ?').get(id) as any;
    if (!request) return Response.json({ error: 'Discount request not found' }, { status: 404 });
    if (request.status !== 'pending') {
      return Response.json({ error: `This request was already ${request.status}` }, { status: 409 });
    }

    const b = await req.json().catch(() => ({}));
    const approve = b.approve === true;
    const note = String(b.note || '').trim();

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(request.order_id) as any;
    if (!order) return Response.json({ error: 'Order not found' }, { status: 404 });
    if (order.status !== 'open') {
      // Close the stale request so it doesn't stay pending forever.
      db.prepare(`
        UPDATE discount_requests SET status = 'rejected', decided_by = ?, decided_note = ?, decided_at = datetime('now')
        WHERE id = ?
      `).run(me.name, 'Order was already settled/closed before a decision', id);
      return Response.json(
        { error: 'This order has already been settled — the discount can no longer be applied' },
        { status: 409 },
      );
    }

    const kind = request.kind === 'service_charge' ? 'service_charge' : 'discount';
    if (approve) {
      // Apply + mark approved atomically. Discount → same columns/math as the
      // sync route. Service-charge waiver → set service_charge_reason (which
      // computeBill/settle/print all honour to zero the charge).
      const tx = db.transaction(() => {
        if (kind === 'service_charge') {
          db.prepare(`
            UPDATE orders SET service_charge_reason = ?, updated_at = datetime('now')
            WHERE id = ?
          `).run(request.reason || `Waived (approved by ${me.name})`, order.id);
        } else {
          const pct = Number(request.requested_pct);
          const amount = round2((Number(order.subtotal) || 0) * pct / 100);
          db.prepare(`
            UPDATE orders SET discount_pct = ?, discount = ?, discount_approved_by = ?, updated_at = datetime('now')
            WHERE id = ?
          `).run(pct, amount, me.name, order.id);
        }
        db.prepare(`
          UPDATE discount_requests SET status = 'approved', decided_by = ?, decided_note = ?, decided_at = datetime('now')
          WHERE id = ?
        `).run(me.name, note, id);
      });
      tx();
    } else {
      db.prepare(`
        UPDATE discount_requests SET status = 'rejected', decided_by = ?, decided_note = ?, decided_at = datetime('now')
        WHERE id = ?
      `).run(me.name, note, id);
    }

    // WhatsApp ping (fire-and-forget, AFTER the decision committed). The
    // requester's mobile isn't captured on discount_requests (requested_by is
    // an email), so this goes to the configured 'discount_decided' recipients.
    // Gated by the Notifications-tab toggles inside notifyEvent(); must NEVER
    // block or fail the decision.
    try {
      void notifyEvent('discount_decided', {
        order: order.order_number || order.id,
        pct: Number(request.requested_pct),
        decision: approve ? 'approved' : 'rejected',
        decided_by: me.name,
      });
    } catch { /* notification must never break the action */ }

    const rows = listDiscountRequests(db, 'WHERE dr.id = ?', [id]);
    return Response.json({ request: rows[0] || null });
  } catch (e: any) {
    console.error('[/api/dine-in/discount-requests/[id]/decide]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
