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
export interface SeatParty { party_unique_id?: string; fp_id?: string; event_date?: string; status?: string }

/** A Cancelled F&P (F&P Records status) — the same test the What's On board
 *  uses (src/lib/ct/whats-on.ts isCancelled): startsWith, so "Cancelled" and
 *  "Canceled" count, "Confirmed (cancellation waived)" does not. */
export function isCancelledStatus(status: string | undefined): boolean {
  return String(status || '').trim().toLowerCase().startsWith('cancel');
}

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
 * THE RULE: the Final Total counts on ONE row — the LATEST NOT-CANCELLED F&P
 * carrying the id (owner ruling 51, 2026-10-21, refining 43):
 *   0. a Cancelled F&P never takes the seat while the booking has an F&P that is
 *      not Cancelled (isCancelledStatus). Only when EVERY F&P of the booking is
 *      Cancelled is the seat the latest of them — and its gate withholds the
 *      revenue, as production's gate did on each such row. A Draft (or any other
 *      status) is a row like any other: a future Draft still holds the revenue
 *      until it is Approved and over (production's gate, unchanged);
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
 * as holders of an id. A Cancelled F&P stays a row (it still shows its own
 * costs and names the seat: "revenue counted on FP-81"); it only cannot BE the
 * seat while a not-cancelled F&P carries the id (rule 0 above). Round 4 seated
 * the revenue on a Cancelled latest F&P, whose gate then withheld it, so the
 * booking counted on NO row (AK-88: FP-81 Approved 09-10, FP-82 Cancelled
 * 10-10); now it counts once on FP-81, as production's board did.
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
    // Ruling 51: the seat is chosen among the F&Ps that are NOT Cancelled; only
    // a booking whose every F&P is Cancelled falls back to all of them.
    const live = holders.filter(i => !isCancelledStatus(parties[i].status));
    const pool = live.length ? live : holders;
    const latest = pool.reduce((a, i) => (dateOf(i) > a ? dateOf(i) : a), dateOf(pool[0]));
    const tied = pool.filter(i => dateOf(i) === latest);       // ascending sheet order
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
 * WHICH cached party a requisition event row (its trimmed event_name + date) is:
 * the first party on that date carrying the name among its candidates — or,
 * when that party's AKAN id is on two or more F&P rows (`seats`), the SEATED
 * F&P of that same id if it too carries the name that evening. -1 = none.
 * Lifted out of resolveBookingRevenue unchanged, so the seat-only rows below
 * resolve an event row to the very party the revenue column does.
 */
function resolveEventParty(parties: CachedParty[], en: string, eventDate: string,
                           seats?: Map<number, RevenueSeat>): number {
  let idx = parties.findIndex(x => x.event_date === eventDate && candidateNames(x).includes(en));
  if (idx >= 0 && seats && parties[idx].party_unique_id) {
    const id = parties[idx].party_unique_id;
    const seated = parties.findIndex((x, i) => x.party_unique_id === id && seats.get(i)?.here === true
      && x.event_date === eventDate && candidateNames(x).includes(en));
    if (seated >= 0) idx = seated;
  }
  return idx;
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
 *
 * On such an other-F&P row ONLY, `seat_withheld_reason` says whether the seat
 * itself counts it yet: null = it does; 'cancelled' (every F&P of the booking is
 * Cancelled, so the seat is a Cancelled one); 'no booking row' (no Final Total
 * on the Party Bookings sheet); else the seat's gate reason ('awaiting
 * confirmation', 'party not over yet'). So "revenue counted on FP-92" is never
 * read as "already in the total" while FP-92 still withholds it. Absent on
 * every other row, so an id on one F&P returns exactly what it did.
 */
export function resolveBookingRevenue(
  bookings: Map<string, number>, parties: CachedParty[],
  eventName: string, eventDate: string, today: string,
  canonicalOnly = false,
  seats?: Map<number, RevenueSeat>,
): { party_unique_id: string | null; booking_total: number; revenue: number; withheld_reason: string | null;
     seat_withheld_reason?: string | null } {
  const en = String(eventName || '').trim();
  const idx = resolveEventParty(parties, en, eventDate, seats);
  const p = idx >= 0 ? parties[idx] : undefined;
  if (!p || !p.party_unique_id) return { party_unique_id: null, booking_total: 0, revenue: 0, withheld_reason: 'no booking row' };
  // A party can have requisitions raised under several names (contact person AND
  // company). To avoid attributing its one booking Final Total to every such event
  // row, only the party's canonical name (contact_person-first) carries the revenue.
  if (canonicalOnly && en !== String(p.event_name || '').trim()) {
    return { party_unique_id: p.party_unique_id, booking_total: 0, revenue: 0, withheld_reason: 'counted on the primary event row' };
  }
  // Ruling 43/51: the booking counts once, on its latest not-cancelled F&P —
  // not on this one.
  const seat = seats?.get(idx);
  if (seat && !seat.here) {
    const id = p.party_unique_id;
    const at = parties.findIndex((x, i) => x.party_unique_id === id && seats?.get(i)?.here === true);
    const sp = at >= 0 ? parties[at] : undefined;
    const seatTotal = bookings.get(id) || 0;
    const seat_withheld_reason = !sp ? null
      : isCancelledStatus(sp.status) ? 'cancelled'
      : !(seatTotal > 0) ? 'no booking row'
      : revenueGate(sp.status, sp.event_date, today).reason;
    return { party_unique_id: id, booking_total: 0, revenue: 0, withheld_reason: `revenue counted on ${seat.fp_id}`,
             seat_withheld_reason };
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

/**
 * OWNER RULING 51 ON /api/party-events — THE COUNTING F&P'S OWN ROW.
 *
 * That page's rows are requisition events (event_name + date), so an F&P with no
 * party requisition has no row there. A booking's revenue is carried only by the
 * event row that resolves to the F&P the P&L board counts it on — the F&P itself
 * for an id on ONE F&P, the SEATED F&P (ruling 43/51) for an id on two or more —
 * and only under that F&P's canonical name. So a booking whose counting F&P has
 * no such row showed ₹0 on every row of the page while the board, the single
 * P&L and /parties counted it once, on that F&P:
 *   - its F&P has no requisition row under its own name (no requisitions yet, or
 *     raised under the company name; for a seat, a second function the store has
 *     issued nothing for, or an F&P re-created under a corrected contact name);
 *   - its requisition row under its own name and date resolves to ANOTHER F&P
 *     carrying that name that evening, higher in the sheet (resolveEventParty
 *     takes the first).
 * (Production showed such a single-F&P booking on no row, and a booking on two
 * or more F&Ps on the event row of EVERY F&P that had requisitions.)
 *
 * This returns ONE revenue-only row per such F&P, named and dated as the F&P
 * itself — its canonical name (contact_person-first, loadUpcomingParties: the
 * event_name a requisition raised from it with Raise Req carries) on its Date
 * of Event — so /party-events shows the booking once, on the same F&P as the
 * board. An F&P is CARRIED, and gets no extra row, when a requisition event row
 * resolves to it (resolveEventParty) under its canonical name: exactly the row
 * resolveBookingRevenue gives the booking to. Only an F&P whose revenue COUNTS
 * gets a row — a Final Total above 0 and the gate open (Approved and over,
 * revenueGate): a withheld booking has nothing to count on the page, and gets
 * its row once it has, or once a requisition under its name resolves to it.
 * Every existing row is untouched: this only ADDS rows, so no rupee on a
 * requisition row changes.
 *
 * `eventKeys` = every (event_name, event_date) the page lists as a row (the
 * list's own GROUP BY: purpose = 'party' AND event_name != ''), with the fp_id
 * each requisition under it was raised from (one entry per distinct triple).
 * The drill-down finds a row by name + date, so a revenue-only row takes a key
 * no requisition event uses — not even with spaces at either end, so it never
 * reads as a twin of a requisition row: the canonical name, else
 * '<name> (<FP id>)', else the FP id, else '<FP id> (revenue only[ n])'. So it
 * always gets a row, and never one that would open another party's
 * requisitions.
 *
 * `listed_under` = the requisition rows that ARE the F&P's, under a key that
 * does not carry its revenue: those resolving to it under a name that is not its
 * canonical one (raised under the company name, say); those raised from it
 * (fp_id) whose name + date resolve elsewhere (renamed or re-dated after
 * raising, or under its own name + date while resolveEventParty gives that row
 * to ANOTHER F&P of that name that evening — `same_name_matched_to`); and, by ruling 43's
 * "else the F&P on its date" (claimPartyRequisitions' rule), those carrying its
 * id and no fp_id of a listed F&P, dated on its date while it is the one F&P of
 * the id that evening. Empty = no party requisition is the F&P's by those
 * rules — the board costs none on it either — so the page may say "no
 * requisition matched to it". (One carrying its id that no rule gives it —
 * another date, or two F&Ps of the id on its date — is costed on no party and
 * listed on /party-pnl, not here.)
 */
export interface SeatListedUnder {
  event_name: string;
  event_date: string;
  /** Set only when this row is under the F&P's OWN name and date: the page
   *  matches the row to another F&P of that name that evening (resolveEventParty)
   *  — its fp_id ('' when it has none). null = another name or date. */
  same_name_matched_to: string | null;
}

export interface SeatOnlyEvent {
  /** The F&P the booking counts on, an index into `parties`. */
  index: number;
  event_name: string;
  event_date: string;
  fp_id: string;
  party_unique_id: string;
  /** How many cached F&Ps carry the booking's id: 1 = the F&P is the booking's
   *  only one; 2+ = it is the seat (latest not-cancelled F&P, ruling 51). */
  fp_count: number;
  booking_total: number;
  revenue: number;
  listed_under: SeatListedUnder[];
}

export function seatOnlyEvents(
  bookings: Map<string, number>, parties: CachedParty[], seats: Map<number, RevenueSeat>,
  eventKeys: { event_name: string; event_date: string; fp_id?: string | null; party_unique_id?: string | null }[],
  today: string,
): SeatOnlyEvent[] {
  const keyOf = (name: string, date: string) => JSON.stringify([name, date]);
  const taken = new Set<string>();
  const carried = new Set<number>();
  const resolved: number[] = [];
  for (const k of eventKeys) {
    taken.add(keyOf(String(k.event_name ?? ''), String(k.event_date ?? '')));
    // …and its trimmed form, so a revenue-only row is never 'Kapoor' beside a
    // requisition row 'Kapoor ' (two rows that read the same).
    taken.add(keyOf(String(k.event_name ?? '').trim(), String(k.event_date ?? '')));
    const en = String(k.event_name || '').trim();
    const idx = resolveEventParty(parties, en, k.event_date, seats);
    resolved.push(idx);
    // The row carries the booking when it resolves, under that F&P's canonical
    // name, to the F&P the booking counts on: an F&P whose id is on no other
    // row, or the seat (resolveBookingRevenue gives every other F&P of a
    // multi-F&P booking ₹0).
    if (idx >= 0 && (seats.get(idx)?.here ?? true) && en === String(parties[idx].event_name || '').trim()) carried.add(idx);
  }
  const listedFps = new Set(parties.map(x => x.fp_id));
  const listedUnder = (i: number) => {
    const p = parties[i];
    const fp = String(p.fp_id || '').trim();
    const id = String(p.party_unique_id || '').trim();
    const name = String(p.event_name || '').trim();
    const date = String(p.event_date || '');
    // claimPartyRequisitions: an id-bearing requisition whose fp_id names no
    // listed F&P goes by its date — to the ONE holder of its id on that date.
    const listedFp = (f: string) => listedFps.has(f);
    const soleOnDate = parties.filter(x => String(x.party_unique_id || '').trim() === id
      && String(x.event_date || '').trim() === date.trim()).length === 1;
    const seen = new Set<string>(); const out: SeatListedUnder[] = [];
    eventKeys.forEach((k, n) => {
      const kfp = String(k.fp_id ?? '').trim();
      const kid = String(k.party_unique_id ?? '').trim();
      const mine = resolved[n] === i
        || (!!fp && kfp === fp)
        || (!!id && kid === id && (!kfp || !listedFp(kfp)) && soleOnDate && String(k.event_date ?? '') === date.trim());
      if (!mine) return;
      const key = keyOf(String(k.event_name ?? ''), String(k.event_date ?? ''));
      if (seen.has(key)) return;
      seen.add(key);
      // Under its own name and date, yet not carried: the row resolves to
      // another F&P of that name that evening (resolveEventParty takes the
      // first on the sheet; one of the seat's own id would have been the seat).
      const own = String(k.event_name || '').trim() === name && String(k.event_date ?? '') === date;
      const other = resolved[n];
      out.push({ event_name: String(k.event_name ?? ''), event_date: String(k.event_date ?? ''),
                 same_name_matched_to: own && other >= 0 && other !== i ? String(parties[other].fp_id || '') : null });
    });
    return out;
  };
  const out: SeatOnlyEvent[] = [];
  // Sheet order, so the higher F&P takes the plain name when two need one.
  parties.forEach((p, i) => {
    if (!p || !p.party_unique_id) return;
    const seat = seats.get(i);
    // A booking on two or more F&Ps counts on its seat only (the board's
    // revenue_counted_here); one on a single F&P counts on that F&P.
    if ((seat && !seat.here) || carried.has(i)) return;
    const total = bookings.get(p.party_unique_id) || 0;
    if (!(total > 0) || !revenueGate(p.status, p.event_date, today).allow) return;
    const date = String(p.event_date || '');
    const name = String(p.event_name || '').trim();
    const fp = String(p.fp_id || '').trim();
    let choice = [name, name && fp ? `${name} (${fp})` : '', fp].find(n => n && !taken.has(keyOf(n, date)));
    for (let k = 1; !choice; k++) {
      const n = `${fp || name || String(p.party_unique_id).trim()} (revenue only${k > 1 ? ` ${k}` : ''})`;
      if (!taken.has(keyOf(n, date))) choice = n;
    }
    taken.add(keyOf(choice, date));
    out.push({ index: i, event_name: choice, event_date: date, fp_id: p.fp_id || '',
               party_unique_id: p.party_unique_id, fp_count: seat ? seat.fp_ids.length : 1,
               booking_total: total, revenue: total, listed_under: listedUnder(i) });
  });
  return out;
}
