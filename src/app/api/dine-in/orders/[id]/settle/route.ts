import { getDb, recordSale } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { todayIST } from '@/lib/format-date';

const VALID_METHODS = ['cash', 'upi', 'card'];

/**
 * Settle an open order: write one `sales` row per line item (deducting inventory
 * via recordSale) and close the order — all in one transaction so a failure can't
 * half-write. Body: { payment_method: 'cash' | 'upi' | 'card' }.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id } = await params;
    const db = getDb();
    const outletId = await getCurrentOutletId();

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as any;
    if (!order) return Response.json({ error: 'Order not found' }, { status: 404 });
    if (order.status !== 'open') return Response.json({ error: 'Order is not open' }, { status: 409 });

    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(id) as any[];
    if (items.length === 0) return Response.json({ error: 'Order has no items' }, { status: 400 });

    const b = await req.json().catch(() => ({}));
    const method = String(b.payment_method || '').toLowerCase();
    if (!VALID_METHODS.includes(method)) {
      return Response.json({ error: `payment_method must be one of ${VALID_METHODS.join(', ')}` }, { status: 400 });
    }

    const date = todayIST();
    const saleTime = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date());

    const settle = db.transaction(() => {
      for (const it of items) {
        // pos_id from the menu item (stable link); fall back to none.
        const mi = it.menu_item_id
          ? db.prepare('SELECT pos_id FROM menu_items WHERE id = ?').get(it.menu_item_id) as any
          : null;
        recordSale(db, {
          item_name: it.name,
          recipe_id: it.recipe_id,
          quantity_sold: it.quantity,
          bill_type: order.bill_type || 'normal',
          selling_price: it.unit_price,
          date,
          sale_time: saleTime,
          order_id: order.id,
          category: it.station || null,
          server: order.server_name || null,
          order_type: order.order_type || 'dine-in',
          pos_item_id: mi?.pos_id || null,
          pos_item_name: it.name,
          outlet_id: outletId,
        });
      }
      db.prepare(`
        UPDATE orders SET status = 'settled', payment_method = ?, settled_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `).run(method, id);
    });
    settle();

    return Response.json({ success: true, order_id: id, total: order.total, payment_method: method, lines: items.length });
  } catch (e: any) {
    console.error('[/api/dine-in/orders/[id]/settle]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
