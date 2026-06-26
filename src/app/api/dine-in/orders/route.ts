import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';

/** GET — list orders for the active outlet. ?status=open (default) | settled | all. */
export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const outletId = await getCurrentOutletId();
    const status = new URL(request.url).searchParams.get('status') || 'open';

    let where = '(o.outlet_id = ? OR o.outlet_id IS NULL)';
    const params: any[] = [outletId];
    if (status !== 'all') { where += ' AND o.status = ?'; params.push(status); }

    const orders = db.prepare(`
      SELECT o.*, t.table_number, t.zone,
             (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
      FROM orders o
      LEFT JOIN restaurant_tables t ON o.table_id = t.id
      WHERE ${where}
      ORDER BY o.created_at DESC
    `).all(...params);
    return Response.json({ items: orders });
  } catch (e: any) {
    console.error('[/api/dine-in/orders GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

/** POST — open a new order on a table (or takeaway). Returns the order id. */
export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const outletId = await getCurrentOutletId();
    const b = await request.json();
    const tableId = b.table_id || null;
    const orderType = String(b.order_type || 'dine-in');

    // A table can hold only one open order at a time — reuse it if present.
    if (tableId) {
      const existing = db.prepare("SELECT id FROM orders WHERE table_id = ? AND status = 'open'").get(tableId) as any;
      if (existing) return Response.json({ id: existing.id, reused: true });
    }

    // Per-outlet, per-day running order number.
    const seq = db.prepare(`
      SELECT COALESCE(MAX(order_number), 0) + 1 AS n FROM orders
      WHERE (outlet_id = ? OR outlet_id IS NULL) AND date(created_at) = date('now')
    `).get(outletId) as any;

    const id = generateId();
    db.prepare(`
      INSERT INTO orders (id, outlet_id, order_number, table_id, status, order_type, bill_type, covers,
                          server_id, server_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'open', ?, 'normal', ?, ?, ?, datetime('now'), datetime('now'))
    `).run(id, outletId, seq?.n || 1, tableId, orderType, Number(b.covers) || 0, me.id, me.name || me.email);

    return Response.json({ id, order_number: seq?.n || 1, success: true }, { status: 201 });
  } catch (e: any) {
    console.error('[/api/dine-in/orders POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
