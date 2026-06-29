import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';

/**
 * GET — active Kitchen Order Tickets for the KDS. Returns tickets that aren't
 * yet served, outlet-scoped, optionally filtered by ?station=. Each ticket
 * carries its order/table context + line items + age. Used for the initial KDS
 * load and for catch-up after an SSE reconnect.
 */
export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const outletId = await getCurrentOutletId();
    const station = new URL(request.url).searchParams.get('station');

    let where = "k.status != 'served' AND (k.outlet_id = ? OR k.outlet_id IS NULL)";
    const params: any[] = [outletId];
    if (station && station !== 'all') { where += ' AND k.station = ?'; params.push(station); }

    const kots = db.prepare(`
      SELECT k.*, o.order_number, o.order_type, o.server_name, t.table_number, t.zone
      FROM kots k
      JOIN orders o ON k.order_id = o.id
      LEFT JOIN restaurant_tables t ON o.table_id = t.id
      WHERE ${where}
      ORDER BY k.created_at ASC
    `).all(...params) as any[];

    const itemStmt = db.prepare('SELECT name, quantity, notes, status FROM order_items WHERE kot_id = ? ORDER BY created_at ASC');
    const result = kots.map((k) => ({ ...k, items: itemStmt.all(k.id) }));

    // Distinct stations (for the KDS station picker).
    const stations = db.prepare(`
      SELECT DISTINCT station FROM kots WHERE status != 'served' AND (outlet_id = ? OR outlet_id IS NULL) ORDER BY station
    `).all(outletId).map((r: any) => r.station);

    return Response.json({ items: result, stations });
  } catch (e: any) {
    console.error('[/api/dine-in/kds GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
