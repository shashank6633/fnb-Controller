/**
 * Shared party revenue/attribution helpers, used by BOTH /api/party-events (the
 * sales-era P&L page) and /api/party-events/pnl (the booking-based P&L / Food
 * Consumption). Single source of truth so the two never drift.
 *
 * Revenue for a party = the AKAN Party Manager "Party Bookings" sheet Final Total
 * Amount (col U), matched by party_unique_id, but only counted once the party is
 * confirmed AND its date has passed (revenueGate). Party requisitions carry no
 * party_unique_id — they link to a party only by event_name+date, and the name
 * they were raised under may be the contact person, company or FP id — hence
 * candidateNames() + the resolver below match on date + ANY candidate name.
 */
import type { getDb } from '@/lib/db';

type DB = ReturnType<typeof getDb>;

export interface CachedParty {
  party_unique_id?: string; fp_id?: string; event_name?: string; event_date?: string;
  guest_name?: string; company?: string; contact_person?: string;
  pax_expected?: number; min_guarantee?: number; status?: string;
}

/** party_unique_id -> Final Total Amount, from settings['party_bookings_cache']. */
export function loadBookingsCache(db: DB): Map<string, number> {
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'party_bookings_cache'`).get() as { value: string } | undefined;
    if (!row) return new Map();
    const parsed = JSON.parse(row.value);
    const m = new Map<string, number>();
    for (const b of parsed.bookings || []) m.set(b.party_unique_id, Number(b.final_total) || 0);
    return m;
  } catch { return new Map(); }
}

/** All parties from settings['upcoming_parties_cache'] (F&P Records). */
export function loadUpcomingParties(db: DB): CachedParty[] {
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'upcoming_parties_cache'`).get() as { value: string } | undefined;
    if (!row) return [];
    const parsed = JSON.parse(row.value);
    return (parsed.parties || []).map((p: any) => ({
      party_unique_id: p.party_unique_id,
      fp_id: p.fp_id,
      // Match how "Raise Req" derives the requisition's event_name (contact_person first).
      event_name: p.contact_person || p.guest_name || p.company || p.fp_id,
      event_date: p.date_of_event,
      guest_name: p.guest_name,
      company: p.company,
      contact_person: p.contact_person,
      pax_expected: p.pax_expected,
      min_guarantee: p.min_guarantee,
      status: p.status,               // F&P Records status: Approved | Draft (sheet's real values)
    }));
  } catch { return []; }
}

/**
 * Final Total counts as revenue only when the party is locked-in — status
 * 'Approved' (the value the sheet uses; Confirmed/Done accepted as synonyms) — AND
 * the event date is over (event_date <= today). Returns the withheld reason or null.
 */
export function revenueGate(status: string | undefined, eventDate: string | undefined, today: string): { allow: boolean; reason: string | null } {
  const s = String(status || '').trim().toLowerCase();
  const confirmed = s === 'approved' || s === 'confirmed' || s === 'done';
  if (!confirmed) return { allow: false, reason: 'awaiting confirmation' };
  if (!eventDate || eventDate > today) return { allow: false, reason: 'party not over yet' };
  return { allow: true, reason: null };
}

/** What the revenue seat reads of a cached F&P row (both loaders carry it). */
export interface SeatParty { party_unique_id?: string; fp_id?: string; event_date?: string }

/* ────────────────────────────────────────────────────────────────────────────
 * OWNER RULING 43 (2026-10-15) — A BOOKING'S REVENUE COUNTS ONCE.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * One AKAN id can sit on two or three F&P rows (Party Manager can create a second
 * F&P for a booking — two functions on two dates, or a re-created F&P beside the
 * old one; pm_fp_records is unique on fp_id only). Revenue was read once PER ROW
 * (`bookings.get(id)` in pnlFor, /api/party-events/pnl), so the booking's one
 * Final Total showed on every row carrying the id and /parties added it up two or
 * three times — and /api/party-events (resolveBookingRevenue below), which reads
 * it once per requisition event row (event_name + date), showed it on the event
 * row of EACH F&P date.
 *
 * THE RULE: the Final Total counts on ONE row — the LATEST F&P carrying the id:
 *   1. the latest Date of Event ('YYYY-MM-DD', F&P Records col H, as toIsoDate()
 *      writes it — so a string compare is a date compare);
 *   2. on the same date, the row CREATED LAST — F&P Records col C "Created At"
 *      (UpcomingParty.created_at), read in the one format Party Manager writes
 *      it: en-IN 'd/m/yyyy, h:mm:ss am/pm' (day FIRST — the sheet hands the
 *      text back as written, see createdAtMs). Used only when EVERY row tied on
 *      that date carries a stamp in that format; otherwise (a blank or
 *      hand-edited stamp), and between equal stamps, the LOWER row in the sheet
 *      wins — Party Manager appends new F&Ps at the bottom, so sheet order is
 *      creation order. Never a guessed format: an unreadable stamp falls back to
 *      sheet order, it is not read month-first.
 * Every other row with the id shows ₹0 revenue and booking_total 0, says where
 * the revenue is ("revenue counted on FP-73"), and is never revenue-eligible —
 * so the board, the single-party GET and /parties add each booking up once, and
 * /api/party-events carries it only on the event row that resolves to that F&P.
 * MOVED HERE UNCHANGED from /api/party-events/pnl so both surfaces seat a booking
 * on the very same F&P.
 * The revenue gate (Approved + date over) is then applied on THAT row alone: a
 * booking whose latest F&P is not yet over, or is not Approved, shows its
 * revenue as withheld there, and on none of its other rows.
 *
 * WHICH ROWS ARE ROWS: every cached F&P row, whatever its status — exactly the
 * rows the requisition and consumption claims in src/lib/party-liquor.ts treat
 * as holders of an id. A Cancelled F&P is NOT skipped (that call is the owner's,
 * not this fix's): when it is the latest row carrying the id, the revenue is
 * seated on it and its gate withholds it ('awaiting confirmation').
 *
 * An id on ONE row (the normal case) gets no seat: pnlFor and
 * resolveBookingRevenue compute exactly what they did before, and the row
 * carries none of the extra fields.
 */
export interface RevenueSeat {
  /** This row carries the booking's revenue. */
  here: boolean;
  /** The row that carries it (this one when `here`). */
  fp_id: string;
  event_date: string;
  /** Every F&P carrying the id, in sheet order (this one included). */
  fp_ids: string[];
}

/**
 * Party Manager's Created At stamp → a comparable number, or null when it is not
 * in Party Manager's own format. It writes
 * new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) — e.g.
 * "21/10/2026, 10:12:05 am" — DAY first. The sheet stores such text either as
 * text (day > 12) or, reading it month-first, as a serial formatted
 * 'm/d/yyyy, h:mm:ss AM/PM' (day ≤ 12) — which readSheet's FORMATTED_STRING
 * hands back as the very digits written ("3/4/2026, 10:23:45 AM" = 3 April). So
 * day-first is right for both. IST wall-clock, compared as such (Date.UTC only
 * makes it a number; every stamp is in the same zone). Seconds and the meridiem
 * are optional (24-hour without it); anything else — or an impossible date —
 * is null.
 */
export function createdAtMs(raw: unknown): number | null {
  const m = String(raw ?? '').trim()
    .match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(?:([ap])\.?\s*m\.?)?$/i);
  if (!m) return null;
  const [day, month, year, hour, min, sec] = [m[1], m[2], m[3], m[4], m[5], m[6] || '0'].map(Number);
  const mer = m[7]?.toLowerCase();
  if (mer ? (hour < 1 || hour > 12) : hour > 23) return null;
  if (min > 59 || sec > 59) return null;
  const h24 = mer ? (hour % 12) + (mer === 'p' ? 12 : 0) : hour;
  const ms = Date.UTC(year, month - 1, day, h24, min, sec);
  const d = new Date(ms);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return ms;
}

/**
 * Created At per cached row, index-aligned with loadPnlParties() /
 * loadUpcomingParties() — both map settings['upcoming_parties_cache'].parties in
 * order, and neither carries it. Read from the same settings row in the same
 * synchronous stretch of the request; a stamp is used only when the raw entry at
 * that index is the same F&P (fp_id) as the party there, else null (→ sheet
 * order decides).
 */
export function loadCreatedAt(db: DB, parties: SeatParty[]): (string | undefined)[] {
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'upcoming_parties_cache'`).get() as { value: string } | undefined;
    const raw: any[] = row ? (JSON.parse(row.value).parties || []) : [];
    return parties.map((p, i) => (raw[i] && raw[i].fp_id === p.fp_id) ? raw[i].created_at : undefined);
  } catch {
    return parties.map(() => undefined);
  }
}

/** THE RULE. index → seat, for the rows whose id is on two or more cached rows
 *  only. Ids are grouped exactly as both P&Ls look the booking up (the raw
 *  string: bookings.get(party_unique_id)). */
export function revenueSeats(parties: SeatParty[], createdAt: (string | undefined)[]): Map<number, RevenueSeat> {
  const seats = new Map<number, RevenueSeat>();
  const byId = new Map<string, number[]>();
  parties.forEach((p, i) => {
    if (!p.party_unique_id) return;
    const list = byId.get(p.party_unique_id);
    if (list) list.push(i); else byId.set(p.party_unique_id, [i]);
  });
  const dateOf = (i: number) => String(parties[i].event_date || '').trim();
  for (const holders of byId.values()) {
    if (holders.length < 2) continue;
    const latest = holders.reduce((a, i) => (dateOf(i) > a ? dateOf(i) : a), dateOf(holders[0]));
    const tied = holders.filter(i => dateOf(i) === latest);   // ascending sheet order
    const stamps = tied.map(i => createdAtMs(createdAt[i]));
    let owner = tied[tied.length - 1];                         // the lower sheet row
    if (tied.length > 1 && stamps.every(s => s !== null)) {
      let best = 0;
      stamps.forEach((s, k) => { if ((s as number) >= (stamps[best] as number)) best = k; });
      owner = tied[best];                                      // equal stamps → lower row
    }
    const fp_ids = holders.map(i => parties[i].fp_id || '');
    for (const i of holders) {
      seats.set(i, { here: i === owner, fp_id: parties[owner].fp_id || '', event_date: dateOf(owner), fp_ids });
    }
  }
  return seats;
}

/** Every name a party's requisition might have been raised under. */
export function candidateNames(p: CachedParty): string[] {
  return [...new Set([p.contact_person, p.guest_name, p.company, p.event_name, p.fp_id]
    .map(x => String(x || '').trim()).filter(Boolean))];
}

/**
 * Resolve the booking revenue for a party requisition event (event_name+date):
 * find the cached party whose date matches AND whose candidate names include the
 * event_name, then apply the gate to its booking Final Total.
 *
 * `seats` (revenueSeats over the SAME `parties`, owner ruling 43): when the
 * party's AKAN id is on two or more F&P rows, only the row the seat names
 * carries the booking — the event row of any other F&P of that booking gets ₹0,
 * booking_total 0 and "revenue counted on FP-xx". When two F&Ps of the booking
 * match this very evening and name, the seated one is the party (it used to be
 * the first in sheet order, so a booking whose later-created F&P shares the
 * date would have landed on none). Only an F&P carrying the SAME id as the first
 * match is preferred, so which booking an event row resolves to never changes.
 * Without `seats`, or for an id on one row, exactly as before.
 */
export function resolveBookingRevenue(
  bookings: Map<string, number>, parties: CachedParty[],
  eventName: string, eventDate: string, today: string,
  canonicalOnly = false,
  seats?: Map<number, RevenueSeat>,
): { party_unique_id: string | null; booking_total: number; revenue: number; withheld_reason: string | null } {
  const en = String(eventName || '').trim();
  let idx = parties.findIndex(x => x.event_date === eventDate && candidateNames(x).includes(en));
  if (idx >= 0 && seats && parties[idx].party_unique_id) {
    const id = parties[idx].party_unique_id;
    const seated = parties.findIndex((x, i) => x.party_unique_id === id && seats.get(i)?.here === true
      && x.event_date === eventDate && candidateNames(x).includes(en));
    if (seated >= 0) idx = seated;
  }
  const p = idx >= 0 ? parties[idx] : undefined;
  if (!p || !p.party_unique_id) return { party_unique_id: null, booking_total: 0, revenue: 0, withheld_reason: 'no booking row' };
  // A party can have requisitions raised under several names (contact person AND
  // company). To avoid attributing its one booking Final Total to every such event
  // row, only the party's canonical name (contact_person-first) carries the revenue.
  if (canonicalOnly && en !== String(p.event_name || '').trim()) {
    return { party_unique_id: p.party_unique_id, booking_total: 0, revenue: 0, withheld_reason: 'counted on the primary event row' };
  }
  // Ruling 43: the booking counts once, on its latest F&P — not on this one.
  const seat = seats?.get(idx);
  if (seat && !seat.here) {
    return { party_unique_id: p.party_unique_id, booking_total: 0, revenue: 0, withheld_reason: `revenue counted on ${seat.fp_id}` };
  }
  const total = bookings.get(p.party_unique_id) || 0;
  const gate = revenueGate(p.status, p.event_date, today);
  return {
    party_unique_id: p.party_unique_id,
    booking_total: total,
    revenue: gate.allow ? total : 0,
    withheld_reason: gate.allow ? null : gate.reason,
  };
}
