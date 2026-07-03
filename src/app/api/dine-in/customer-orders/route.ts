import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';

/**
 * GET /api/dine-in/customer-orders   (STAFF)
 *
 * The Captain's approval queue: customer-submitted orders awaiting review
 * (status 'pending_approval', origin 'customer'). Each carries its line items
 * and the table it came from.
 */
export async function GET() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const outletId = await getCurrentOutletId();

    const orders = db.prepare(`
      SELECT o.id, o.status, o.subtotal, o.total, o.notes, o.created_at,
             o.table_id, rt.table_number, rt.zone
      FROM orders o
      LEFT JOIN restaurant_tables rt ON rt.id = o.table_id
      WHERE o.status = 'pending_approval'
        AND (o.outlet_id = ? OR o.outlet_id IS NULL)
      ORDER BY o.created_at ASC
    `).all(outletId) as any[];

    const itemStmt = db.prepare(`
      SELECT id, menu_item_id, name, station, quantity, unit_price, tax_value, line_total
      FROM order_items WHERE order_id = ? ORDER BY created_at ASC
    `);

    const out = orders.map(o => ({
      id: o.id,
      status: o.status,
      subtotal: o.subtotal,
      total: o.total,
      note: o.notes || '',
      created_at: o.created_at,
      table: { id: o.table_id, number: o.table_number || '—', zone: o.zone || '' },
      items: (itemStmt.all(o.id) as any[]).map(i => ({
        id: i.id, menu_item_id: i.menu_item_id, name: i.name, station: i.station,
        qty: i.quantity, unit_price: i.unit_price, tax_value: i.tax_value, line_total: i.line_total,
      })),
    }));

    return Response.json({ orders: out }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    console.error('[/api/dine-in/customer-orders GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
