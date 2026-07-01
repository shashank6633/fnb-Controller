import { getDb } from '@/lib/db';
import { getCurrentUser, verifyApprover, canApproveTableOp } from '@/lib/auth';
import { round2 } from '@/lib/bill-calc';
import type Database from 'better-sqlite3';

/**
 * Load an order with its table info, line items (incl. prep timer fields) and
 * KOTs — same shape the main [id] route returns so the captain UI can refresh
 * from a single { order } payload after a discount is applied.
 */
function loadOrder(db: Database.Database, id: string) {
  const order = db.prepare(`
    SELECT o.*, t.table_number, t.zone FROM orders o
    LEFT JOIN restaurant_tables t ON o.table_id = t.id WHERE o.id = ?
  `).get(id) as any;
  if (!order) return null;
  const items = db.prepare(`
    SELECT oi.*, oi.prep_minutes, oi.fired_at, oi.completed_at, k.status AS kot_status
    FROM order_items oi
    LEFT JOIN kots k ON k.id = oi.kot_id
    WHERE oi.order_id = ? ORDER BY oi.created_at ASC
  `).all(id);
  const kots = db.prepare(`
    SELECT k.id, k.kot_number, k.station, k.status, k.created_at, k.reprint_count
    FROM kots k WHERE k.order_id = ? ORDER BY k.kot_number ASC
  `).all(id);
  return { ...order, items, kots };
}

/**
 * POST — apply a percentage discount to an open order.
 *
 * Two gates:
 *   1. The CURRENT user's role must allow requesting a discount
 *      (roles.can_request_discount = 1) and the requested pct must be within
 *      their role's cap (roles.max_discount_pct).
 *   2. A Manager/Admin must authorize it on the spot — verified via their
 *      login (approver_email + approver_password) + canApproveTableOp().
 *
 * On success: store discount_pct, the approver's name, and the recomputed
 * discount amount (subtotal * pct / 100). Returns { order }.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id } = await params;
    const db = getDb();

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as any;
    if (!order) return Response.json({ error: 'Order not found' }, { status: 404 });
    if (order.status !== 'open') return Response.json({ error: 'Order is not open' }, { status: 409 });

    const b = await req.json().catch(() => ({}));
    const pct = Number(b.pct);
    if (!(pct > 0)) return Response.json({ error: 'pct must be a positive number' }, { status: 400 });

    // Resolve the requester's discount permission from their assigned role.
    const perm = me.role_id
      ? db.prepare('SELECT can_request_discount, max_discount_pct FROM roles WHERE id = ?').get(me.role_id) as any
      : null;
    const canRequest = !!perm && Number(perm.can_request_discount) === 1;
    if (!canRequest) {
      return Response.json({ error: 'Your role is not allowed to request a discount' }, { status: 403 });
    }
    const maxPct = Number(perm.max_discount_pct) || 0;
    if (pct > maxPct) {
      return Response.json({ error: `Discount exceeds your limit of ${maxPct}%` }, { status: 400 });
    }

    // A Manager/Admin must approve — verify their login on the spot.
    const approver = await verifyApprover(b.approver_email, b.approver_password);
    if (!approver || !canApproveTableOp(approver)) {
      return Response.json(
        { error: 'A Manager must approve this discount. Enter their login to continue.', needs_approval: true },
        { status: 403 },
      );
    }

    const amount = round2((Number(order.subtotal) || 0) * pct / 100);
    db.prepare(`
      UPDATE orders SET discount_pct = ?, discount = ?, discount_approved_by = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(pct, amount, approver.name, id);

    return Response.json({ order: loadOrder(db, id) });
  } catch (e: any) {
    console.error('[/api/dine-in/orders/[id]/discount]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
