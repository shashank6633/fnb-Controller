import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { emitKds } from '@/lib/kds-bus';

/**
 * POST — ask the counter print-agent to print this order's bill.
 *
 * The Captain runs on a tablet that can't reach the on-counter print bridge
 * directly, so instead of printing locally we emit a `bill.print` event on the
 * KDS bus. The print-agent page (open on the counter PC, next to the bridge)
 * picks it up over SSE and prints via its local outbox.
 *
 * Purely additive: this does NOT settle the order and the desktop POS never
 * calls it, so existing bill printing is unchanged (no double-print).
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id } = await params;
    const db = getDb();
    const order = db.prepare(`
      SELECT o.*, t.table_number, t.zone FROM orders o
      LEFT JOIN restaurant_tables t ON o.table_id = t.id WHERE o.id = ?
    `).get(id) as any;
    if (!order) return Response.json({ error: 'Order not found' }, { status: 404 });
    const items = db.prepare(
      'SELECT name, quantity, unit_price, line_total FROM order_items WHERE order_id = ? ORDER BY created_at ASC'
    ).all(id) as any[];
    if (items.length === 0) return Response.json({ error: 'Order has no items' }, { status: 400 });

    const bill = {
      id: order.id,
      order_number: order.order_number,
      table_number: order.table_number || null,
      zone: order.zone || null,
      order_type: order.order_type,
      server_name: order.server_name || undefined,
      subtotal: order.subtotal, tax_total: order.tax_total, discount: order.discount, total: order.total,
      payment_method: order.payment_method || undefined,
      items,
    };
    emitKds({ type: 'bill.print', outlet_id: order.outlet_id, station: 'bill', bill });
    return Response.json({ success: true });
  } catch (e: any) {
    console.error('[/api/dine-in/orders/[id]/print-bill]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
