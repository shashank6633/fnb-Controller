import { getDb } from '@/lib/db';
import { getCurrentUser, canApproveTableOp } from '@/lib/auth';
import type Database from 'better-sqlite3';

/**
 * Load an order with its table info, line items (incl. prep timer fields) and
 * KOTs — same shape the main [id] route returns so the captain UI can refresh
 * from a single { order } payload after the service charge is removed.
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
 * POST — remove the service charge from an open order.
 *
 * A cashier/manager/admin may waive the auto-applied service charge; recording
 * a non-empty reason on the order is what marks it removed (computeBill and the
 * printed bill both treat service_charge_reason as the "removed" flag).
 *
 * Body: { remove: true, reason }.
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

    // Only a Cashier / Manager / Admin may waive the service charge.
    if (!(canApproveTableOp(me) || me.role_name === 'Cashier')) {
      return Response.json({ error: 'Only a Cashier or Manager can remove the service charge' }, { status: 403 });
    }

    const b = await req.json().catch(() => ({}));
    if (!b.remove) return Response.json({ error: 'remove must be true' }, { status: 400 });
    const reason = String(b.reason || '').trim();
    if (!reason) return Response.json({ error: 'A reason is required to remove the service charge' }, { status: 400 });

    db.prepare(`UPDATE orders SET service_charge_reason = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(reason, id);

    return Response.json({ order: loadOrder(db, id) });
  } catch (e: any) {
    console.error('[/api/dine-in/orders/[id]/service-charge]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
