/**
 * VALET ↔ FNB dining links (spec §9). OPTIONAL and informational: a car works
 * exactly the same with no link, and after the bill closes.
 *
 * THE LINK IS TO THE ORDER (the dining visit), never to the table alone:
 *   - a table TRANSFER keeps the order id and changes orders.table_id, so the
 *     link follows the guests and the current table is always read live;
 *   - a bill SPLIT keeps the order id (split tenders are payments);
 *   - a table MERGE closes the source order as 'merged' WITHOUT recording where
 *     it went (POS code, deliberately not changed here) — such a link shows
 *     "bill merged — re-link" and staff re-link it;
 *   - linking or looking up BY TABLE resolves the table's CURRENT open order,
 *     so a car can never attach to, or show under, the previous guests' bill.
 * Nothing here ever requests, moves or releases a car. Bill print / settle /
 * table close only show a prompt (the cashier chip); the guest's confirmation
 * is what requests the car.
 */
import type { DB, Actor, OutletValet } from './core';
import { fail, getSession, logEvent, withTx, writeSession } from './core';
import { isHeld } from './states';
import { nowIso, normTagCode } from './config';

export interface DiningRef { order_id: string; order_number: number | null; table_id: string | null; table_number: string; status: string }

/**
 * The table's CURRENT open bill. The POS keeps one open order per table (it
 * reuses an existing one), but nothing in storage enforces that — the measured
 * database has a table with four open orders. So two or more is reported as
 * AMBIGUOUS and the caller refuses, rather than guessing and attaching a car to
 * a stale bill. Table numbers match ignoring case and spaces ("t 4" = "T4").
 */
export function openOrderForTable(db: DB, outletId: string, tableRef: string): { ref: DiningRef | null; ambiguous: boolean } {
  const t = String(tableRef || '').trim();
  if (!t) return { ref: null, ambiguous: false };
  const rows = db.prepare(`SELECT o.id AS order_id, o.order_number, o.table_id, rt.table_number, o.status FROM orders o
                           JOIN restaurant_tables rt ON rt.id = o.table_id
                           WHERE o.status = 'open' AND rt.outlet_id = ?
                             AND (rt.id = ? OR upper(replace(rt.table_number, ' ', '')) = upper(replace(?, ' ', '')))
                           ORDER BY o.created_at DESC LIMIT 2`).all(outletId, t, t) as DiningRef[];
  return { ref: rows.length === 1 ? rows[0] : null, ambiguous: rows.length > 1 };
}

export function diningRef(db: DB, orderId: string | null): DiningRef | null {
  if (!orderId) return null;
  return (db.prepare(`SELECT o.id AS order_id, o.order_number, o.table_id, COALESCE(rt.table_number, '') AS table_number, o.status
                      FROM orders o LEFT JOIN restaurant_tables rt ON rt.id = o.table_id WHERE o.id = ?`).get(orderId) as DiningRef) ?? null;
}

/** Link a car (by session id or tag) to a dining visit (by order id or table). */
export function linkDining(
  db: DB, ov: OutletValet, actor: Actor, input: { session_id?: string; tag_code?: string; order_id?: string; table?: string }, now: Date = new Date(),
) {
  const at = nowIso(now);
  return withTx(db, () => {
    let sid = String(input.session_id || '');
    if (!sid && input.tag_code) {
      const r = db.prepare(`SELECT s.id FROM valet_vehicle_sessions s JOIN valet_tags t ON t.id = s.tag_id
                            WHERE s.outlet_id = ? AND t.code_norm = ? AND s.state NOT IN ('HANDED_OVER','VOIDED')`).get(ov.outlet_id, normTagCode(input.tag_code)) as { id: string } | undefined;
      if (!r) fail(404, 'not_found', 'No car with that tag is at this outlet.');
      sid = r!.id;
    }
    const s = getSession(db, sid, ov.outlet_id);
    if (!isHeld(s.state)) fail(409, 'closed', 'This car has already left.');
    let ref: DiningRef | null = null;
    if (input.order_id) {
      ref = diningRef(db, String(input.order_id));
      const outlet = ref ? (db.prepare('SELECT outlet_id FROM orders WHERE id = ?').get(ref.order_id) as { outlet_id: string | null }).outlet_id : null;
      // Strict: a bill with no outlet recorded belongs to no outlet here.
      if (!ref || outlet !== ov.outlet_id) fail(404, 'no_order', 'That bill was not found at this outlet.');
      if (ref!.status !== 'open') fail(409, 'order_closed', 'That bill is already closed — link the guest\'s current bill.');
    } else {
      const found = openOrderForTable(db, ov.outlet_id, String(input.table || ''));
      if (found.ambiguous) fail(409, 'ambiguous_table', 'That table has more than one open bill. Link the car from the bill itself on the Cashier screen.');
      ref = found.ref;
      if (!ref) fail(404, 'no_open_order', 'That table has no open bill right now.');
    }
    const booking = (db.prepare('SELECT booking_id FROM orders WHERE id = ?').get(ref!.order_id) as { booking_id: string | null } | undefined)?.booking_id ?? null;
    writeSession(db, s, { order_id: ref!.order_id, table_id: ref!.table_id, booking_id: booking }, at);
    logEvent(db, { outlet_id: ov.outlet_id, session_id: s.id, event_type: 'dining.linked', actor, at, data: { order_number: ref!.order_number, table: ref!.table_number } });
    return { session_id: s.id, dining: ref };
  });
}

export function unlinkDining(db: DB, ov: OutletValet, actor: Actor, sessionId: string, now: Date = new Date()) {
  const at = nowIso(now);
  return withTx(db, () => {
    const s = getSession(db, sessionId, ov.outlet_id);
    writeSession(db, s, { order_id: null, table_id: null, booking_id: null }, at);
    logEvent(db, { outlet_id: ov.outlet_id, session_id: s.id, event_type: 'dining.unlinked', actor, at });
    return { session_id: s.id };
  });
}

/** Cars linked to this order that the venue still holds. */
export function carsForOrder(db: DB, outletId: string, orderId: string) {
  return db.prepare(`SELECT s.id, s.version, s.tag_code, s.ticket_no, s.state, s.make, s.model, s.colour,
                       (SELECT p.state FROM valet_pickups p WHERE p.session_id = s.id AND p.state IN ('SCHEDULED','QUEUED','ASSIGNED','IN_PROGRESS','READY')) AS pickup_state
                     FROM valet_vehicle_sessions s WHERE s.outlet_id = ? AND s.order_id = ? AND s.state NOT IN ('HANDED_OVER','VOIDED')
                     ORDER BY s.checked_in_at`).all(outletId, orderId);
}
