/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { attributeBooking } from '@/lib/ct/ingest';

/**
 * CRM Call-to-Table — Bookings collection (/api/crm-calls/bookings).
 *
 * GET  → paged list with guest name + phone joined.
 *        Filters: ?status= ?from= ?to= (booking_date range, YYYY-MM-DD)
 *                 ?guest_id= ?channel= ?page= ?page_size=
 * POST → quick-booking create { guest_id, booking_date, slot_time, party_size,
 *        occasion, section_pref, notes, source_call_id?, channel='call' }.
 *        created_by = current user's email; then attributeBooking(newId) links
 *        the booking to its source call / open recovery (call-to-table proof).
 *
 * Any signed-in user (GRE access is governed by page-access). CSRF on POST is
 * enforced by the client `api()` helper + proxy.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const BOOKING_STATUSES = ['pending', 'confirmed', 'seated', 'completed', 'no_show', 'cancelled'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** True only if `d` (already DATE_RE-shaped) is a real calendar date — rejects
 *  2026-13-40, 2026-02-31, 0000-00-00, etc. that the regex alone lets through. */
function isRealDate(d: string): boolean {
  const dt = new Date(`${d}T00:00:00Z`);
  return !isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === d;
}

const GUEST_JOIN_SELECT = `
  SELECT b.*, g.name AS guest_name, g.phone_e164 AS guest_phone, g.tags AS guest_tags
  FROM ct_bookings b
  LEFT JOIN ct_guests g ON g.id = b.guest_id
`;

export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  const db = getDb();
  const sp = new URL(req.url).searchParams;

  const where: string[] = [];
  const params: any[] = [];

  const status = (sp.get('status') || '').trim();
  if (status) {
    if (!(BOOKING_STATUSES as readonly string[]).includes(status)) {
      return Response.json({ error: `status must be one of ${BOOKING_STATUSES.join(', ')}` }, { status: 400 });
    }
    where.push('b.status = ?');
    params.push(status);
  }
  const guestId = (sp.get('guest_id') || '').trim();
  if (guestId) { where.push('b.guest_id = ?'); params.push(guestId); }
  const channel = (sp.get('channel') || '').trim();
  if (channel) { where.push('b.channel = ?'); params.push(channel); }
  const from = (sp.get('from') || '').trim();
  if (from) {
    if (!DATE_RE.test(from)) return Response.json({ error: 'from must be YYYY-MM-DD' }, { status: 400 });
    where.push('b.booking_date >= ?');
    params.push(from);
  }
  const to = (sp.get('to') || '').trim();
  if (to) {
    if (!DATE_RE.test(to)) return Response.json({ error: 'to must be YYYY-MM-DD' }, { status: 400 });
    where.push('b.booking_date <= ?');
    params.push(to);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const page = Math.max(1, parseInt(sp.get('page') || '1', 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(sp.get('page_size') || '25', 10) || 25));
  const offset = (page - 1) * pageSize;

  const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM ct_bookings b ${whereSql}`).get(...params) as any;
  const bookings = db.prepare(`
    ${GUEST_JOIN_SELECT}
    ${whereSql}
    ORDER BY b.booking_date DESC, b.slot_time DESC, b.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  return Response.json({
    bookings,
    total: totalRow?.n ?? 0,
    page,
    page_size: pageSize,
  });
}

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return Response.json({ error: 'Invalid body' }, { status: 400 });
  }

  const guestId = String(body.guest_id || '').trim();
  if (!guestId) return Response.json({ error: 'guest_id required' }, { status: 400 });

  const db = getDb();
  const guest = db.prepare('SELECT id, phone_e164 FROM ct_guests WHERE id = ?').get(guestId) as any;
  if (!guest) return Response.json({ error: 'Guest not found' }, { status: 404 });

  const bookingDate = String(body.booking_date || '').trim();
  if (!bookingDate) return Response.json({ error: 'booking_date required' }, { status: 400 });
  if (!DATE_RE.test(bookingDate) || !isRealDate(bookingDate)) {
    return Response.json({ error: 'booking_date must be a real calendar date (YYYY-MM-DD)' }, { status: 400 });
  }

  const slotTime = String(body.slot_time || '').trim().slice(0, 32);

  let partySize = 2;
  if (body.party_size != null && body.party_size !== '') {
    const n = Number(body.party_size);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 500) {
      return Response.json({ error: 'party_size must be a whole number between 1 and 500' }, { status: 400 });
    }
    partySize = n;
  }

  // Optional link to the call that produced this booking (screen-pop / recovery flow).
  // The call MUST belong to this guest — either already linked by guest_id, or
  // sharing the guest's phone number — otherwise a stray id would mis-credit the
  // conversion (and its agent) to the wrong call.
  let sourceCallId: string | null = null;
  if (body.source_call_id != null && String(body.source_call_id).trim() !== '') {
    sourceCallId = String(body.source_call_id).trim();
    const call = db.prepare('SELECT id, guest_id, phone_e164 FROM ct_calls WHERE id = ?').get(sourceCallId) as any;
    if (!call) return Response.json({ error: 'source_call_id: call not found' }, { status: 400 });
    const belongs = call.guest_id === guestId
      || (!!call.phone_e164 && call.phone_e164 === guest.phone_e164);
    if (!belongs) {
      return Response.json({ error: 'source_call_id: call does not belong to this guest' }, { status: 400 });
    }
  }

  let advanceAmount = 0;
  if (body.advance_amount != null && body.advance_amount !== '') {
    const a = Number(body.advance_amount);
    if (!Number.isFinite(a) || a < 0) {
      return Response.json({ error: 'advance_amount must be a non-negative number' }, { status: 400 });
    }
    advanceAmount = a;
  }

  const id = generateId();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO ct_bookings (
      id, guest_id, source_call_id, booking_date, slot_time, party_size,
      occasion, section_pref, status, created_by, channel, advance_amount,
      notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
  `).run(
    id, guestId, sourceCallId, bookingDate, slotTime, partySize,
    String(body.occasion || '').trim().slice(0, 200),
    String(body.section_pref || '').trim().slice(0, 200),
    me.email,
    String(body.channel || 'call').trim().slice(0, 40) || 'call',
    advanceAmount,
    String(body.notes || '').trim().slice(0, 2000),
    now, now,
  );

  // Call-to-table attribution: fill source_call_id from the latest answered
  // inbound call in the attribution window (if not explicitly linked) and mark
  // any open recovery on that call as recovered. Never let attribution failure
  // break the booking itself.
  try {
    attributeBooking(id);
  } catch (e) {
    console.warn('[ct] attributeBooking failed for booking', id, e);
  }

  const booking = db.prepare(`${GUEST_JOIN_SELECT} WHERE b.id = ?`).get(id);
  return Response.json({ success: true, booking }, { status: 201 });
}
