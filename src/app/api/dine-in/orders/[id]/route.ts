import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import type Database from 'better-sqlite3';

/** Recompute and persist order totals from its line items + discount. */
function recomputeTotals(db: Database.Database, orderId: string) {
  const items = db.prepare('SELECT quantity, unit_price, tax_value FROM order_items WHERE order_id = ?').all(orderId) as any[];
  let subtotal = 0, tax = 0;
  for (const it of items) {
    const line = it.unit_price * it.quantity;
    subtotal += line;
    tax += line * (it.tax_value || 0) / 100;
  }
  const order = db.prepare('SELECT discount FROM orders WHERE id = ?').get(orderId) as any;
  const discount = order?.discount || 0;
  const r = (n: number) => Math.round(n * 100) / 100;
  const total = Math.max(0, r(subtotal + tax - discount));
  db.prepare(`UPDATE orders SET subtotal = ?, tax_total = ?, total = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(r(subtotal), r(tax), total, orderId);
}

function loadOrder(db: Database.Database, id: string) {
  const order = db.prepare(`
    SELECT o.*, t.table_number, t.zone FROM orders o
    LEFT JOIN restaurant_tables t ON o.table_id = t.id WHERE o.id = ?
  `).get(id) as any;
  if (!order) return null;
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY created_at ASC').all(id);
  return { ...order, items };
}

/** GET — order with its line items. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id } = await params;
    const db = getDb();
    const order = loadOrder(db, id);
    if (!order) return Response.json({ error: 'Order not found' }, { status: 404 });
    return Response.json({ order });
  } catch (e: any) {
    console.error('[/api/dine-in/orders/[id] GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

/** PATCH — line-item operations + order meta. Body: { action, ... }. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id } = await params;
    const db = getDb();
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as any;
    if (!order) return Response.json({ error: 'Order not found' }, { status: 404 });
    if (order.status !== 'open') return Response.json({ error: 'Order is not open' }, { status: 409 });

    const b = await req.json();
    const action = b.action;

    const run = db.transaction(() => {
      switch (action) {
        case 'add_item': {
          const mi = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(b.menu_item_id) as any;
          if (!mi) throw new Error('Menu item not found');
          if (!(mi.selling_price > 0)) throw new Error(`"${mi.name}" has no price — set it on the Menu Items page first`);
          const qty = Number(b.quantity) > 0 ? Number(b.quantity) : 1;
          // If the same item already exists on the order, bump its quantity.
          const existing = db.prepare('SELECT * FROM order_items WHERE order_id = ? AND menu_item_id = ?').get(id, mi.id) as any;
          if (existing) {
            const newQty = existing.quantity + qty;
            db.prepare('UPDATE order_items SET quantity = ?, line_total = ? WHERE id = ?')
              .run(newQty, Math.round(existing.unit_price * newQty * 100) / 100, existing.id);
          } else {
            db.prepare(`
              INSERT INTO order_items (id, order_id, menu_item_id, recipe_id, name, station, quantity, unit_price, tax_value, line_total, status, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
            `).run(generateId(), id, mi.id, mi.recipe_id || null, mi.name, mi.station || '', qty,
                   mi.selling_price, mi.tax_value || 0, Math.round(mi.selling_price * qty * 100) / 100);
          }
          break;
        }
        case 'set_qty': {
          const qty = Number(b.quantity);
          const item = db.prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?').get(b.item_id, id) as any;
          if (!item) throw new Error('Line item not found');
          if (qty <= 0) db.prepare('DELETE FROM order_items WHERE id = ?').run(b.item_id);
          else db.prepare('UPDATE order_items SET quantity = ?, line_total = ? WHERE id = ?')
            .run(qty, Math.round(item.unit_price * qty * 100) / 100, b.item_id);
          break;
        }
        case 'remove_item':
          db.prepare('DELETE FROM order_items WHERE id = ? AND order_id = ?').run(b.item_id, id);
          break;
        case 'set_meta':
          db.prepare(`UPDATE orders SET covers = ?, discount = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(b.covers === undefined ? order.covers : Number(b.covers) || 0,
                 b.discount === undefined ? order.discount : Math.max(0, Number(b.discount) || 0),
                 b.notes === undefined ? order.notes : String(b.notes), id);
          break;
        default:
          throw new Error(`Unknown action: ${action}`);
      }
      recomputeTotals(db, id);
    });
    run();

    return Response.json({ order: loadOrder(db, id) });
  } catch (e: any) {
    console.error('[/api/dine-in/orders/[id] PATCH]', e);
    return Response.json({ error: e.message }, { status: 400 });
  }
}
