import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId, canApproveTableOp } from '@/lib/auth';
import { canDecideDiscount, listDiscountRequests } from '@/lib/discount-requests';

/**
 * Remote bill-discount approval — REQUEST side.
 *
 * This is the parallel path beside the synchronous at-the-till flow
 * (POST /api/dine-in/orders/[id]/discount with verifyApprover), which stays
 * unchanged. Here the cashier files a request; a Manager/Admin/HOD later
 * approves it from /dine-in/discount-approvals (see [id]/decide).
 *
 * POST { order_id, pct, reason? }
 *   Requester rules — IDENTICAL to the sync route's gate 1:
 *     - session user's can_request_discount must be true
 *     - pct must be > 0 and within their max_discount_pct cap
 *   Plus: order must exist and be open; only ONE pending request per order.
 *
 * GET ?order_id=X  → { request } latest request for that order (any signed-in
 *                    user — powers the captain's pending/rejected chip poll).
 * GET (no param)   → approver gate (admin | manager tier | is_head_chef):
 *                    { pending: [...], history: [last 20 decided] } with
 *                    order/table/bill context for the approvals page.
 */
export async function GET(req: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const url = new URL(req.url);
    const orderId = url.searchParams.get('order_id');

    // Requester poll: latest request for one order (no approver gate — it only
    // exposes the discount state of an order the caller can already open).
    if (orderId) {
      // Return recent requests for the order so a caller can see BOTH a pending
      // discount and a pending service-charge waiver at once. `request` (latest)
      // is kept for the captain's existing single-request poll.
      const rows = listDiscountRequests(db, 'WHERE dr.order_id = ? ORDER BY dr.created_at DESC, dr.rowid DESC LIMIT 6', [orderId]);
      return Response.json({ request: rows[0] || null, requests: rows });
    }

    // Approver queue.
    if (!canDecideDiscount(me)) {
      return Response.json({ error: 'Manager, Admin or HOD access required' }, { status: 403 });
    }
    const outletId = await getCurrentOutletId();
    const outletSql = ' AND (dr.outlet_id = ? OR dr.outlet_id IS NULL)';
    const pending = listDiscountRequests(
      db,
      `WHERE dr.status = 'pending' AND o.status = 'open'${outletSql} ORDER BY dr.created_at ASC`,
      [outletId],
    );
    const history = listDiscountRequests(
      db,
      `WHERE dr.status != 'pending'${outletSql} ORDER BY dr.decided_at DESC, dr.rowid DESC LIMIT 20`,
      [outletId],
    );
    return Response.json({ pending, history });
  } catch (e: any) {
    console.error('[/api/dine-in/discount-requests GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();

    const b = await req.json().catch(() => ({}));
    const kind = b.kind === 'service_charge' ? 'service_charge' : 'discount';
    const orderId = String(b.order_id || '');
    const pct = Number(b.pct);
    const reason = String(b.reason || '').trim();
    if (!orderId) return Response.json({ error: 'order_id is required' }, { status: 400 });
    if (kind === 'discount' && !(pct > 0)) return Response.json({ error: 'pct must be a positive number' }, { status: 400 });
    if (kind === 'service_charge' && !reason) return Response.json({ error: 'A reason is required to waive the service charge' }, { status: 400 });

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any;
    if (!order) return Response.json({ error: 'Order not found' }, { status: 404 });
    if (order.status !== 'open') return Response.json({ error: 'Order is not open' }, { status: 409 });

    if (kind === 'discount') {
      // Requester rules — same semantics as the sync discount route's gate 1,
      // read from the resolved SessionUser (admin → true / 100).
      if (!me.can_request_discount) {
        return Response.json({ error: 'Your role is not allowed to request a discount' }, { status: 403 });
      }
      const maxPct = Number(me.max_discount_pct) || 0;
      if (pct > maxPct) {
        return Response.json({ error: `Discount exceeds your limit of ${maxPct}%` }, { status: 400 });
      }
    } else {
      // Service-charge waiver: any cashier-console operator may REQUEST; a
      // manager/admin/HOD is still the gate at decide time (approval always).
      if (!canApproveTableOp(me) && !me.can_request_discount) {
        return Response.json({ error: 'Your role is not allowed to request a service-charge waiver' }, { status: 403 });
      }
      if (order.service_charge_reason) {
        return Response.json({ error: 'Service charge is already waived on this bill' }, { status: 409 });
      }
    }

    // One pending request per order PER KIND (a table can have both a discount
    // and a service-charge waiver awaiting approval).
    const dup = db.prepare(
      `SELECT id FROM discount_requests WHERE order_id = ? AND COALESCE(kind,'discount') = ? AND status = 'pending'`
    ).get(orderId, kind) as any;
    if (dup) {
      return Response.json({ error: `A ${kind === 'service_charge' ? 'service-charge waiver' : 'discount'} request for this order is already awaiting approval` }, { status: 409 });
    }

    const id = generateId();
    db.prepare(`
      INSERT INTO discount_requests (id, order_id, outlet_id, requested_by, requested_pct, reason, kind)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, orderId, order.outlet_id || null, me.email, kind === 'discount' ? pct : 0, reason, kind);

    const rows = listDiscountRequests(db, 'WHERE dr.id = ?', [id]);
    return Response.json({ request: rows[0] || null });
  } catch (e: any) {
    console.error('[/api/dine-in/discount-requests POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
