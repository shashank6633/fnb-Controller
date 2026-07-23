/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Reservation → table seating (Part A) + table party / multi-guest (Part B).
 *
 * The ONE place that links a booking to a physical table + order, and that
 * records every diner at a table. Pure DB logic (takes `db`); API routes pass
 * outlet/actor context. Best-effort helpers never throw to their caller.
 *
 * Storage contract mirrors the rest of the app:
 *   • a booking is seated to a table → orders.booking_id set, order guest
 *     pre-filled from the booking's ct_guest, ct_bookings.status='seated'.
 *   • every diner → an order_guests row (primary = the reserved/registered
 *     member) AND a CRM guest+visit via autoSaveCrmGuest.
 */
import { norm10 } from '@/lib/ct/guest-unify';
import { autoSaveCrmGuest } from '@/lib/ct/guest-autosave';

/** Add / update one diner in a table's party. Idempotent per (order, phone).
 *  Also mirrors the diner into the CRM (guest + dining visit). Best-effort. */
export function addOrderGuest(
  db: any,
  opts: { orderId: string; mobile?: string; name?: string; isPrimary?: boolean; source?: string },
): void {
  try {
    const orderId = String(opts?.orderId || '');
    if (!orderId) return;
    const mobile = String(opts?.mobile ?? '').trim();
    const name = String(opts?.name ?? '').trim();
    const phone10 = norm10(mobile);
    if (!phone10 && !name) return;                 // nothing to record
    const isPrimary = !!opts?.isPrimary;
    const source = String(opts?.source || 'walk-in');

    // A new primary demotes any previous primary for this order.
    if (isPrimary) db.prepare('UPDATE order_guests SET is_primary = 0 WHERE order_id = ?').run(orderId);

    if (phone10) {
      const existing = db.prepare('SELECT id FROM order_guests WHERE order_id = ? AND phone10 = ?')
        .get(orderId, phone10) as { id: string } | undefined;
      if (existing) {
        // Backfill a blank name; promote to primary if asked; keep latest stored mobile.
        db.prepare(`UPDATE order_guests
          SET name = CASE WHEN name = '' THEN ? ELSE name END,
              is_primary = CASE WHEN ? = 1 THEN 1 ELSE is_primary END,
              mobile = ?
          WHERE id = ?`).run(name, isPrimary ? 1 : 0, mobile, existing.id);
      } else {
        db.prepare(`INSERT INTO order_guests (id, order_id, phone10, mobile, name, is_primary, source)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(crypto.randomUUID(), orderId, phone10, mobile, name, isPrimary ? 1 : 0, source);
      }
      // Mirror into the CRM (guest + dining visit) — same rule as order capture.
      autoSaveCrmGuest(db, { phone: mobile, name, source: 'dine-in' });
    } else {
      // Name-only diner (partial unique index allows multiple '' phones).
      db.prepare(`INSERT INTO order_guests (id, order_id, phone10, mobile, name, is_primary, source)
        VALUES (?, ?, '', '', ?, ?, ?)`)
        .run(crypto.randomUUID(), orderId, name, isPrimary ? 1 : 0, source);
    }
  } catch (e: any) {
    if (!String(e?.message || '').includes('UNIQUE')) console.warn('[addOrderGuest]', e?.message || e);
  }
}

/** Every diner at a table for this order, primary first. */
export function listOrderGuests(db: any, orderId: string): any[] {
  return db.prepare(`SELECT id, phone10, mobile, name, is_primary, source, created_at
    FROM order_guests WHERE order_id = ? ORDER BY is_primary DESC, created_at ASC`).all(String(orderId || '')) as any[];
}

export interface SeatResult { ok: boolean; error?: string; status?: number; orderId?: string; orderNumber?: number; reused?: boolean; }

/** Seat a booking (the PARTY) onto a table: reuse the table's open order or
 *  open one, link booking_id, pre-fill the guest, mark the booking 'seated',
 *  and add the booking's guest as the party PRIMARY. */
export function seatBooking(
  db: any,
  opts: { bookingId: string; tableId: string; outletId: string | null; serverId?: string; serverName?: string },
): SeatResult {
  const bookingId = String(opts?.bookingId || '');
  const tableId = String(opts?.tableId || '');
  if (!bookingId || !tableId) return { ok: false, error: 'bookingId and tableId are required', status: 400 };

  const booking = db.prepare(`
    SELECT b.*, g.name AS g_name, g.phone_e164 AS g_phone
    FROM ct_bookings b LEFT JOIN ct_guests g ON g.id = b.guest_id
    WHERE b.id = ?`).get(bookingId) as any;
  if (!booking) return { ok: false, error: 'Booking not found', status: 404 };
  if (['cancelled', 'no_show', 'completed'].includes(String(booking.status))) {
    return { ok: false, error: `Booking is ${booking.status} — can't seat`, status: 400 };
  }

  const table = db.prepare('SELECT id, outlet_id FROM restaurant_tables WHERE id = ? AND is_active = 1').get(tableId) as any;
  if (!table) return { ok: false, error: 'Table not found', status: 404 };
  const outletId = opts.outletId ?? table.outlet_id ?? null;

  const guestName = String(booking.g_name || '').trim();
  const guestMobile = String(booking.g_phone || '').trim();   // E.164; +91 numbers normalize fine downstream

  const txn = db.transaction((): SeatResult => {
    // Reuse the table's open order if any, else open a fresh one.
    const open = db.prepare("SELECT id, order_number, guest_name, guest_mobile FROM orders WHERE table_id = ? AND status = 'open' LIMIT 1").get(tableId) as any;
    let orderId: string; let orderNumber: number; let reused: boolean;
    if (open) {
      orderId = open.id; orderNumber = open.order_number; reused = true;
      db.prepare(`UPDATE orders SET booking_id = ?,
          guest_name = CASE WHEN COALESCE(guest_name,'') = '' THEN ? ELSE guest_name END,
          guest_mobile = CASE WHEN COALESCE(guest_mobile,'') = '' THEN ? ELSE guest_mobile END,
          covers = CASE WHEN COALESCE(covers,0) = 0 THEN ? ELSE covers END,
          updated_at = datetime('now')
        WHERE id = ?`).run(bookingId, guestName, guestMobile, Number(booking.party_size) || 0, orderId);
    } else {
      orderId = crypto.randomUUID();
      const seq = db.prepare(`SELECT COALESCE(MAX(order_number),0)+1 AS n FROM orders
        WHERE (outlet_id = ? OR outlet_id IS NULL) AND date(created_at) = date('now')`).get(outletId) as any;
      orderNumber = seq?.n || 1; reused = false;
      db.prepare(`INSERT INTO orders (id, outlet_id, order_number, table_id, status, order_type, bill_type,
          covers, server_id, server_name, guest_name, guest_mobile, booking_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'open', 'dine-in', 'normal', ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`)
        .run(orderId, outletId, orderNumber, tableId, Number(booking.party_size) || 0,
             opts.serverId || '', opts.serverName || '', guestName, guestMobile, bookingId);
    }

    db.prepare("UPDATE ct_bookings SET status = 'seated', table_id = ?, seated_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
      .run(tableId, bookingId);

    // The booking's guest becomes the party primary.
    addOrderGuest(db, { orderId, mobile: guestMobile, name: guestName, isPrimary: true, source: 'reservation' });

    return { ok: true, orderId, orderNumber, reused };
  });

  try { return txn(); }
  catch (e: any) { return { ok: false, error: e?.message || 'Seat failed', status: 500 }; }
}

/** On settle: if the order came from a reservation, flip that booking
 *  seated → completed. Best-effort. */
export function completeBookingForOrder(db: any, orderId: string): void {
  try {
    const row = db.prepare("SELECT booking_id FROM orders WHERE id = ?").get(String(orderId || '')) as any;
    const bid = row && String(row.booking_id || '');
    if (!bid) return;
    db.prepare("UPDATE ct_bookings SET status = 'completed', updated_at = datetime('now') WHERE id = ? AND status = 'seated'").run(bid);
  } catch (e: any) { console.warn('[completeBookingForOrder]', e?.message || e); }
}
