import { getDb, deductInventoryForSale } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { emitKds } from '@/lib/kds-bus';
import { resolveFloorStore } from '@/lib/store-engine';

const FLOW = ['new', 'preparing', 'ready', 'served'];

/**
 * POST — advance a KOT one step along new → preparing → ready → served. Body may
 * pass { to } to set a specific status; otherwise it advances by one. On 'served'
 * the ticket drops off the active board. Broadcasts a kot.bumped event.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id } = await params;
    const db = getDb();
    const kot = db.prepare('SELECT * FROM kots WHERE id = ?').get(id) as any;
    if (!kot) return Response.json({ error: 'KOT not found' }, { status: 404 });

    const b = await req.json().catch(() => ({}));
    let next: string;
    if (b.to && FLOW.includes(b.to)) {
      next = b.to;
    } else {
      const i = FLOW.indexOf(kot.status);
      next = FLOW[Math.min(i + 1, FLOW.length - 1)];
    }
    if (next === kot.status) return Response.json({ status: next, kot });

    const apply = db.transaction(() => {
      db.prepare("UPDATE kots SET status = ?, updated_at = datetime('now') WHERE id = ?").run(next, id);
      // When the ticket is COMPLETE (served), the food is consumed → deduct each
      // recipe-linked item's ingredients from stock, exactly once (idempotent via
      // recipe_deducted_at). This is the "consume on KOT complete" model: settle
      // later records revenue but skips inventory for these already-deducted items.
      //   - non-chargeable / complimentary orders STILL consume (deduct runs);
      //   - a cancelled item never reaches a fired KOT, so it never deducts here;
      //   - a voided order is skipped (nothing was really cooked/served).
      if (next === 'served') {
        // Stamp served_at once (item-journey tracking) and advance status. A line
        // already scanned 'kitchen_sent' still moves to 'served' here (terminal).
        db.prepare("UPDATE order_items SET status = 'served', served_at = COALESCE(served_at, datetime('now')) WHERE kot_id = ?").run(id);
        const order = db.prepare(`
          SELECT o.bill_type, o.status, t.zone AS zone
          FROM orders o
          LEFT JOIN restaurant_tables t ON t.id = o.table_id
          WHERE o.id = ?
        `).get(kot.order_id) as any;
        if (order && order.status !== 'void') {
          // FAIL-SAFE floor routing: map this order's table zone → floor bar store
          // once. Any failure (or an unmapped zone) → undefined → central deduct.
          // deductInventoryForSale still gates the store path on tm_floor_autodeduct.
          let floorStoreId: string | undefined;
          try {
            floorStoreId = resolveFloorStore(db, order.zone) || undefined;
          } catch (e) {
            console.error('[kds bump floor-resolve]', kot.order_id, e);
            floorStoreId = undefined;
          }
          const cook = db.prepare(`
            SELECT id, recipe_id, quantity FROM order_items
            WHERE kot_id = ? AND recipe_id IS NOT NULL AND recipe_id != '' AND recipe_deducted_at IS NULL
          `).all(id) as any[];
          const stamp = db.prepare("UPDATE order_items SET recipe_deducted_at = datetime('now') WHERE id = ?");
          for (const it of cook) {
            try {
              deductInventoryForSale(
                db, it.recipe_id, it.quantity, it.id, order.bill_type || 'normal',
                floorStoreId ? { storeId: floorStoreId } : undefined,
              );
              stamp.run(it.id);   // stamp only on success → settle backstops any that threw
            } catch (e) { console.error('[kds bump recipe-deduct]', it.id, e); }
          }
        }
      }
    });
    apply();

    emitKds({ type: 'kot.bumped', outlet_id: kot.outlet_id, station: kot.station, kot: { id, status: next, order_id: kot.order_id } });
    return Response.json({ status: next });
  } catch (e: any) {
    console.error('[/api/dine-in/kds/[id]/bump]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
