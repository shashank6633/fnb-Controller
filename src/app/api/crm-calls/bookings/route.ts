/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { attributeBooking } from '@/lib/ct/ingest';
import { refreshGuestMetrics } from '@/lib/ct/guest-metrics';
import {
  ensureLiveBandSchema, normalizeBookingPreference, resolveLiveBand, PREF_LIVE_BAND,
} from '@/lib/ct/live-band';

/**
 * CRM Call-to-Table — Bookings collection (/api/crm-calls/bookings).
 *
 * GET  → paged list with guest name + phone joined. Reservego same-day
 *        duplicates (is_duplicate = 1) are excluded from both the page and the
 *        total; a booking fetched by id is still returned, duplicate or not.
 *        Filters: ?status= ?from= ?to= (booking_date range, YYYY-MM-DD)
 *                 ?guest_id= ?channel= ?page= ?page_size=
 * POST → quick-booking create { guest_id, booking_date, slot_time, party_size,
 *        occasion, section_pref, preference?, notes, source_call_id?,
 *        channel='call' }.
 *        created_by = current user's email; then attributeBooking(newId) links
 *        the booking to its source call / open recovery (call-to-table proof).
 *        preference = Live Band also stamps that date's band onto the booking —
 *        see § PREFERENCE below and src/lib/ct/live-band.ts.
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

/** The four party-menu lookups + the guest join, given some source of `b` rows.
 *  Correlated subqueries cost one index seek EACH per row of `b`, so `b` must
 *  never be the whole table — see LIST_SQL, which feeds it exactly one page. */
const DECORATE = (from: string) => `
  SELECT b.*, g.name AS guest_name, g.phone_e164 AS guest_phone, g.tags AS guest_tags,
    (SELECT pm.id      FROM party_menus pm WHERE pm.booking_id = b.id ORDER BY pm.updated_at DESC LIMIT 1) AS party_menu_id,
    (SELECT pm.name    FROM party_menus pm WHERE pm.booking_id = b.id ORDER BY pm.updated_at DESC LIMIT 1) AS party_menu_name,
    (SELECT pm.note    FROM party_menus pm WHERE pm.booking_id = b.id ORDER BY pm.updated_at DESC LIMIT 1) AS party_menu_note,
    (SELECT pm.enabled FROM party_menus pm WHERE pm.booking_id = b.id ORDER BY pm.updated_at DESC LIMIT 1) AS party_menu_enabled
  FROM ${from}
  LEFT JOIN ct_guests g ON g.id = b.guest_id
`;

/** Single row by id — `b` is one PK seek, so decorating it directly is free. */
const GUEST_JOIN_SELECT = DECORATE('ct_bookings b');

// Reservego duplicates are marked, not deleted (db.ts § A2 / markDuplicateGroups):
// one visit that Reservego re-emitted keeps its rows so the import stays
// auditable, and every surface that shows or counts bookings hides them. The
// filter goes on the page AND on the total — on the seeded copy that is 82,128
// stored rows, 6,910 of them marked, so a total taken without it would head a
// list of 75,218 rows with the number 82,128.
const LIVE_ONLY = 'b.is_duplicate = 0';

/**
 * PAGE FIRST, DECORATE SECOND. Measured on a copy of production seeded to the
 * archive's shape (82,128 bookings / 70,324 guests): decorating before the
 * LIMIT ran the four party_menus subqueries against every scanned row and
 * sorted all 82k in a temp b-tree — 32ms for page 1, 89ms for page 200. Taking
 * the page inside a subquery first (the is_duplicate=0 equality lets
 * idx_ct_bookings_dup_date supply the booking_date order, leaving only the last
 * two ORDER BY terms to sort) costs 0.2ms and 7.5ms. The outer ORDER BY is
 * repeated because a join does not have to preserve the subquery's order.
 */
const LIST_SQL = (whereSql: string) => `
  ${DECORATE(`(
    SELECT b.* FROM ct_bookings b
    ${whereSql}
    ORDER BY b.booking_date DESC, b.slot_time DESC, b.created_at DESC
    LIMIT ? OFFSET ?
  ) b`)}
  ORDER BY b.booking_date DESC, b.slot_time DESC, b.created_at DESC
`;

export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  const db = getDb();
  const sp = new URL(req.url).searchParams;

  const where: string[] = [LIVE_ONLY];
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

  const whereSql = `WHERE ${where.join(' AND ')}`;

  const page = Math.max(1, parseInt(sp.get('page') || '1', 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(sp.get('page_size') || '25', 10) || 25));
  const offset = (page - 1) * pageSize;

  const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM ct_bookings b ${whereSql}`).get(...params) as any;
  const bookings = db.prepare(LIST_SQL(whereSql)).all(...params, pageSize, offset);

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

  // ── PREFERENCE ────────────────────────────────────────────────────────────
  // What the guest is coming FOR (Live Band / DJ / Dining / Other) — a third
  // field beside occasion and section_pref, not a rename of either. Refused
  // rather than coerced when it is not in the vocabulary: the relink backfill
  // finds Live Band bookings by exact equality, so a "live band" stored in the
  // wrong case would never be re-resolved again.
  const preference = normalizeBookingPreference(body.preference);
  if (preference === null) {
    return Response.json({ error: 'preference must be Live Band, DJ, Dining or Other' }, { status: 400 });
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

  // Live Band bookings carry the band that was scheduled when the promise was
  // made. Resolved SERVER-side, from the same outlet-scoped calendar the What's
  // On board reads, so what gets stored cannot depend on a stale modal. No band
  // on the calendar stores blank — the booking is never blocked over it, and
  // the modal has already told the GRE to follow up.
  ensureLiveBandSchema(db);
  let liveBand = { id: '', name: '' };
  let bandFound = false;
  if (preference === PREF_LIVE_BAND) {
    const band = resolveLiveBand(db, bookingDate, await getCurrentOutletId());
    if (band) {
      bandFound = true;
      // band_id can be '' for an act the ct_bands master does not hold yet —
      // the name is still what was promised, and the relink backfill attaches
      // the id once management adds the act. See resolveLiveBand § UNMASTERED.
      liveBand = { id: band.band_id, name: band.name };
    }
  }

  const id = generateId();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO ct_bookings (
      id, guest_id, source_call_id, booking_date, slot_time, party_size,
      occasion, section_pref, preference, live_band, live_band_id,
      status, created_by, channel, advance_amount,
      notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
  `).run(
    id, guestId, sourceCallId, bookingDate, slotTime, partySize,
    String(body.occasion || '').trim().slice(0, 200),
    String(body.section_pref || '').trim().slice(0, 200),
    preference, liveBand.name, liveBand.id,
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

  // A NEW BOOKING CHANGES THE GUEST'S LIFETIME NUMBERS, so refresh them here
  // too. The status PUT, the Seat board and order settle already do this; only
  // creation did not, which meant a guest's very first booking left them on
  // total_bookings = 0 until an unrelated CSV import happened to touch them —
  // and the Customers list and the guest 360 (which computes live) then
  // disagreed from the moment the profile existed.
  if (guestId) {
    try { refreshGuestMetrics(db, guestId); }
    catch (e) { console.warn('[ct] refreshGuestMetrics failed after create', id, e); }
  }

  const booking = db.prepare(`${GUEST_JOIN_SELECT} WHERE b.id = ?`).get(id);
  // Stated separately from the blank live_band on the row so a caller can tell
  // "no band was asked for" apart from "a band was asked for and none is
  // scheduled" — the second one is a callback the GRE owes the guest.
  const liveBandMissing = preference === PREF_LIVE_BAND && !bandFound;
  return Response.json({ success: true, booking, live_band_missing: liveBandMissing }, { status: 201 });
}
