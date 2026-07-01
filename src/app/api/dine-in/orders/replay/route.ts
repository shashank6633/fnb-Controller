import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';

/**
 * POST /api/dine-in/orders/replay
 *
 * Replays offline-fired KOTs (captured by the counter's offline mini-POS during
 * an internet outage) into the cloud once connectivity returns. Each FIRE was
 * ALREADY printed to the kitchen offline, so this route ONLY reconstructs the
 * database state — it does NOT emitKds and does NOT reprint anything.
 *
 * Idempotent by orders.client_ref: if an order with the same client_ref already
 * exists, we skip creating it and return its ids with alreadyExisted:true. Each
 * order's work is wrapped in its own transaction so a bad row can't poison the
 * whole batch.
 *
 * Body: { orders: [ FIRE-with-localNumber, ... ] } where each FIRE is:
 *   { clientRef, createdAt, captainName, table:{id,label,zone},
 *     guest:{name,mobile,covers}, localNumber,
 *     items:[{menuId,name,qty,price,station,item_type,prep_minutes,notes?}] }
 */
export async function POST(request: Request) {
  try {
    // Same auth guard the neighboring dine-in routes use.
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const outletId = await getCurrentOutletId();

    const body = await request.json();
    const fires: any[] = Array.isArray(body?.orders) ? body.orders : [];

    const results: {
      clientRef: string;
      orderId: string | null;
      orderNumber: number | null;
      alreadyExisted: boolean;
    }[] = [];

    for (const fire of fires) {
      const clientRef = String(fire?.clientRef || '').trim();
      if (!clientRef) {
        results.push({ clientRef: '', orderId: null, orderNumber: null, alreadyExisted: false });
        continue;
      }

      // Idempotency: an order with this client_ref already replayed — return its ids.
      const existing = db.prepare('SELECT id, order_number FROM orders WHERE client_ref = ?').get(clientRef) as any;
      if (existing) {
        results.push({
          clientRef,
          orderId: existing.id,
          orderNumber: existing.order_number,
          alreadyExisted: true,
        });
        continue;
      }

      const table = fire?.table || {};
      const guest = fire?.guest || {};
      const captainName = String(fire?.captainName || '').trim();
      const createdAt = String(fire?.createdAt || '').trim();
      const items: any[] = Array.isArray(fire?.items) ? fire.items : [];

      // Reconstruct order + fired items + kots in one transaction. Returns the
      // new order id + number (or the existing ones, if a concurrent replay of
      // the same client_ref beat us inside the txn).
      const create = db.transaction(() => {
        // Re-check inside the txn to stay idempotent under concurrency.
        const dup = db.prepare('SELECT id, order_number FROM orders WHERE client_ref = ?').get(clientRef) as any;
        if (dup) return { id: dup.id, orderNumber: dup.order_number, alreadyExisted: true };

        // Next daily order number — SAME MAX(order_number)+1-per-outlet/day logic
        // as src/app/api/dine-in/orders/route.ts.
        // Number against the FIRE's own day (createdAt), not replay time, so an
        // outage that straddles midnight can't collide with a genuine same-day order.
        const seq = db.prepare(`
          SELECT COALESCE(MAX(order_number), 0) + 1 AS n FROM orders
          WHERE (outlet_id = ? OR outlet_id IS NULL) AND date(created_at) = date(COALESCE(?, 'now'))
        `).get(outletId, createdAt || null) as any;
        const orderNumber = seq?.n || 1;

        const orderId = generateId();
        // Mirror the orders columns written by the online create route, plus the
        // offline provenance columns. Status 'open' (active), origin 'offline',
        // client_ref = idempotency key, server_name = captain who fired offline.
        db.prepare(`
          INSERT INTO orders (id, outlet_id, order_number, table_id, status, order_type, bill_type, covers,
                              server_id, server_name, guest_name, guest_mobile,
                              origin, client_ref, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'open', 'dine-in', 'normal', ?, ?, ?, ?, ?, 'offline', ?, ?, ?)
        `).run(
          orderId, outletId, orderNumber, table.id || null, Number(guest.covers) || 0,
          me.id, captainName, String(guest.name || '').trim(), String(guest.mobile || '').trim(),
          clientRef, createdAt || null, createdAt || null,
        );

        // Group items by station — one KOT per station, mirroring the 'fire'
        // action in src/app/api/dine-in/orders/[id]/route.ts.
        const byStation: Record<string, any[]> = {};
        for (const it of items) {
          const st = (it?.station && String(it.station).trim()) || 'kitchen';
          (byStation[st] ||= []).push(it);
        }

        // status 'served' (NOT 'new') is deliberate: these KOTs were already
        // printed in the kitchen offline. The Print Agent's backup poll prints
        // every kot with status != 'served', so a 'new' row here would REPRINT
        // the ticket the moment it syncs. 'served' keeps it off the reprint poll
        // and off the live kitchen display while still recording the KOT.
        const insertKot = db.prepare(`
          INSERT INTO kots (id, outlet_id, order_id, kot_number, station, status, fired_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'served', ?, ?, ?)
        `);
        const insertItem = db.prepare(`
          INSERT INTO order_items (id, order_id, menu_item_id, name, station, quantity, unit_price, line_total,
                                   status, notes, prep_minutes, fired_at, kot_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'fired', ?, ?, ?, ?, ?)
        `);

        let subtotal = 0;
        for (const [station, its] of Object.entries(byStation)) {
          // Per-outlet, per-day KOT number — SAME logic as the 'fire' action.
          const kseq = db.prepare(`
            SELECT COALESCE(MAX(kot_number), 0) + 1 AS n FROM kots
            WHERE (outlet_id = ? OR outlet_id IS NULL) AND date(created_at) = date(COALESCE(?, 'now'))
          `).get(outletId, createdAt || null) as any;
          const kotId = generateId();
          insertKot.run(kotId, outletId, orderId, kseq?.n || 1, station, captainName, createdAt || null, createdAt || null);
          for (const it of its) {
            const qty = Number(it?.qty) || 0;
            const price = Number(it?.price) || 0;
            const lineTotal = Math.round(price * qty * 100) / 100;
            subtotal += lineTotal;
            insertItem.run(
              generateId(), orderId, it?.menuId || null, String(it?.name || ''), station,
              qty, price, lineTotal,
              String(it?.notes || ''), Number(it?.prep_minutes) || 0, createdAt || null, kotId, createdAt || null,
            );
          }
        }

        // Roll the line items up onto the order. CRITICAL: the settle route bills
        // from the STORED order.subtotal (then adds service charge + CGST/SGST via
        // computeBill) — it does NOT re-sum the items. Without this the order would
        // settle at Rs 0. tax stays 0 here (settle applies the configured taxes).
        const subTotalR = Math.round(subtotal * 100) / 100;
        db.prepare(`UPDATE orders SET subtotal = ?, tax_total = 0, total = ?, updated_at = ? WHERE id = ?`)
          .run(subTotalR, subTotalR, createdAt || null, orderId);

        return { id: orderId, orderNumber, alreadyExisted: false };
      });

      // Isolate each fire: one bad row must NOT 500 the whole batch (which would
      // leave every good fire un-synced and retrying forever). A UNIQUE(client_ref)
      // violation from a concurrent replayer just means "already done".
      let out;
      try {
        out = create();
      } catch (e: any) {
        if (/UNIQUE constraint failed:\s*orders\.client_ref/i.test(String(e?.message))) {
          const ex = db.prepare('SELECT id, order_number FROM orders WHERE client_ref = ?').get(clientRef) as any;
          results.push({ clientRef, orderId: ex?.id || null, orderNumber: ex?.order_number ?? null, alreadyExisted: true });
        } else {
          // Quarantine: empty clientRef so the counter never marks it synced (it
          // stays in the bridge outbox and can be retried / investigated).
          console.error('[/api/dine-in/orders/replay] fire failed', clientRef, e?.message);
          results.push({ clientRef: '', orderId: null, orderNumber: null, alreadyExisted: false });
        }
        continue;
      }
      results.push({
        clientRef,
        orderId: out.id,
        orderNumber: out.orderNumber,
        alreadyExisted: out.alreadyExisted,
      });
    }

    // CRITICAL: no emitKds and no reprint — the kitchen already got these offline.
    return Response.json({ results });
  } catch (e: any) {
    console.error('[/api/dine-in/orders/replay POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
