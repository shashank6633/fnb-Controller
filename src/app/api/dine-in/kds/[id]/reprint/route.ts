import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * POST — reprint a KOT. Bumps its reprint_count (0 = original, 1 = DUPLICATE,
 * 2 = DUPLICATE 2 …) and returns the full KOT payload so the Print Agent can
 * print it again with the right copy label. Records who asked for the reprint.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id } = await params;
    const db = getDb();
    const kot = db.prepare(`
      SELECT k.*, o.order_number, o.order_type, o.server_name, t.table_number, t.zone
      FROM kots k JOIN orders o ON k.order_id = o.id
      LEFT JOIN restaurant_tables t ON o.table_id = t.id
      WHERE k.id = ?
    `).get(id) as any;
    if (!kot) return Response.json({ error: 'KOT not found' }, { status: 404 });

    const reprintCount = (kot.reprint_count || 0) + 1;
    db.prepare(`UPDATE kots SET reprint_count = ?, updated_at = datetime('now') WHERE id = ?`).run(reprintCount, id);

    const items = db.prepare(`
      SELECT oi.name, oi.quantity, oi.notes, mi.item_type
      FROM order_items oi LEFT JOIN menu_items mi ON oi.menu_item_id = mi.id
      WHERE oi.kot_id = ? ORDER BY oi.created_at ASC
    `).all(id) as any[];

    return Response.json({
      kot: {
        id: kot.id, outlet_id: kot.outlet_id, order_id: kot.order_id, kot_number: kot.kot_number,
        station: kot.station, status: kot.status,
        order_number: kot.order_number, order_type: kot.order_type,
        table_number: kot.table_number || null, zone: kot.zone || null,
        captain: kot.server_name || null, fired_by: kot.fired_by || null,
        reprint_count: reprintCount,                 // ≥1 → DUPLICATE label
        reprinted_by: me.name || me.email,
        items: items.map((x) => ({ name: x.name, quantity: x.quantity, notes: x.notes, item_type: x.item_type })),
      },
    });
  } catch (e: any) {
    console.error('[/api/dine-in/kds/[id]/reprint]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
