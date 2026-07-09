import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { sectionStationClause } from '@/lib/kot-section';

/**
 * GET — active Kitchen Order Tickets for the KDS. Returns tickets that aren't
 * yet served, outlet-scoped, optionally filtered by ?station= and by the
 * caller's Parent Role / Section. Each ticket carries its order/table context +
 * line items + age. Used for the initial KDS load and SSE reconnect catch-up.
 */
export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const outletId = await getCurrentOutletId();
    const url = new URL(request.url);
    const station = url.searchParams.get('station');
    // Section gate: admins/managers/HOD may view any section (honor ?section=);
    // plain staff with a section are LOCKED to it (can't peek at other sections).
    const privileged = me.role === 'admin' || me.role === 'manager' || !!me.is_head_chef;
    const section = (!privileged && me.section) ? me.section : (url.searchParams.get('section') || '');
    const secMain = sectionStationClause(section, 'k.station');

    let where = "k.status != 'served' AND (k.outlet_id = ? OR k.outlet_id IS NULL)";
    const params: any[] = [outletId];
    where += secMain.sql; params.push(...secMain.params);
    if (station && station !== 'all') { where += ' AND k.station = ?'; params.push(station); }

    const kots = db.prepare(`
      SELECT k.*, o.order_number, o.order_type, o.server_name, t.table_number, t.zone
      FROM kots k
      JOIN orders o ON k.order_id = o.id
      LEFT JOIN restaurant_tables t ON o.table_id = t.id
      WHERE ${where}
      ORDER BY k.created_at ASC
    `).all(...params) as any[];

    const itemStmt = db.prepare(`
      SELECT oi.name, oi.quantity, oi.notes, oi.status, mi.item_type
      FROM order_items oi LEFT JOIN menu_items mi ON oi.menu_item_id = mi.id
      WHERE oi.kot_id = ? ORDER BY oi.created_at ASC
    `);
    const result = kots.map((k) => ({ ...k, items: itemStmt.all(k.id) }));

    // Distinct stations for the picker — scoped to the caller's section too, so a
    // Bar user only sees bar-station pills.
    const secPick = sectionStationClause(section, 'station');
    const stations = db.prepare(`
      SELECT DISTINCT station FROM kots
      WHERE status != 'served' AND (outlet_id = ? OR outlet_id IS NULL)${secPick.sql}
      ORDER BY station
    `).all(outletId, ...secPick.params).map((r: any) => r.station);

    return Response.json({ items: result, stations, section });
  } catch (e: any) {
    console.error('[/api/dine-in/kds GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
