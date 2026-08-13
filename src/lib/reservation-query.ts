/**
 * Reservation CRM — THE GUIDED QUERY ENGINE (/crm-calls/database → Query).
 *
 * A validated FILTER OBJECT in, a bounded page of ct_bookings plus the
 * aggregates that answer the question out. The caller never supplies SQL: the
 * statement is assembled here from an allowlist, every value is bound, and the
 * only text ever interpolated is a placeholder run `(?,?,?)` sized to a
 * validated array or an ORDER BY fragment picked from SORTABLE below.
 *
 * WHY A FILTER OBJECT RATHER THAN SQL. The whole point of the tab is that the
 * owner asks "how did Friday and Saturday do?" without typing SQL, and the
 * answer is the same one the rest of the CRM would give. A free-text SQL box on
 * an admin page holding 70,342 guests' phone numbers is also a data-exfiltration
 * tool with a UI; this module is the reason that box does not exist.
 *
 * ── MEASURED SHAPE OF THE ARCHIVE (the owner's 129 real exports, imported into
 *    a copy of production on 2026-08-13) ─────────────────────────────────────
 *   85,598 bookings (85,558 Reservego + 40 phone), 3,576 flagged duplicates,
 *   82,022 live rows, 70,342 guests.
 *   By weekday, live rows: Sun 14,026 · Mon 5,074 · Tue 5,681 · Wed 7,826 ·
 *   Thu 11,381 · Fri 18,328 · Sat 19,706. Fri+Sat alone is 38,034 — 46% of the
 *   archive, which is why "Fri+Sat" is the query this engine was built for.
 *   Outlet is spelt two ways ("Akan Hyderabad" 85,523 rows / 81,980 live,
 *   "AKAN HYDERABAD" 35 / 2 live) for the one venue, so the outlet filter is
 *   case-insensitive — see the note on it below.
 *   bill_amount is recorded on very few rows (19 of the 38,034 Fri+Sat live
 *   rows), so average spend is reported over BILLED bookings only and ships its
 *   own denominator — see the aggregate block.
 *
 * ── DUPLICATES ─────────────────────────────────────────────────────────────
 * A duplicate is never counted. markDuplicateGroups() (src/lib/reservego.ts)
 * already decided, per (outlet, mobile, date), which stored row IS the visit;
 * every aggregate here filters is_duplicate = 0 UNCONDITIONALLY, whatever the
 * caller asks for the row list. The row list defaults to the same clean set
 * because a counting tool whose rows disagree with its own totals is worse than
 * useless, and `duplicates: 'include' | 'only'` is there for the audit view.
 * duplicate_total always ships, so nothing is hidden either way.
 *
 * Reads only. Nothing in this file writes.
 */
import type Database from 'better-sqlite3';
import { ctSetting } from '@/lib/ct/settings';

type DB = Database.Database;

/* ── vocabularies ─────────────────────────────────────────────────────────── */

/** The live ct_bookings status vocabulary — exactly what mapStatus() returns. */
export const STATUSES = ['pending', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show'] as const;
export type Status = (typeof STATUSES)[number];

/** 0 = Sunday, matching both SQLite's strftime('%w') and JS getDay(). */
export const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/**
 * MEAL PERIODS, cut from the measured slot_time histogram of the live archive
 * rather than from a menu card. Live rows by period:
 *   lunch      11:00–16:59   28,078
 *   dinner     17:00–23:59   44,073
 *   late_night 00:00–04:59    4,046
 *   morning    05:00–10:59    5,825
 *
 * Disjoint on purpose, and dinner deliberately STOPS at midnight. The 00:00–
 * 04:59 rows belong to the previous evening's service but carry the FOLLOWING
 * calendar date in booking_date, so folding them into "dinner" would put 4,046
 * bookings on the wrong weekday — a Saturday-night guest counted as Sunday.
 * They get their own period instead, and the page can say so.
 *
 * `morning` is mostly not a meal at all: slot_time falls back to the booking's
 * creation time for a walk-in (mapRow: reservedTime || bookingTime), so those
 * hours are largely office-hours data entry. Named honestly and left selectable
 * rather than hidden.
 *
 * end is INCLUSIVE, and both bounds are 'HH:MM' strings compared
 * lexicographically — legal because slot_time is always zero-padded 'HH:MM'
 * (src/lib/reservego.ts stampTime), measured: 0 rows empty or malformed.
 */
export const MEAL_PERIODS = [
  { id: 'lunch', label: 'Lunch', start: '11:00', end: '16:59' },
  { id: 'dinner', label: 'Dinner', start: '17:00', end: '23:59' },
  { id: 'late_night', label: 'Late night (after midnight)', start: '00:00', end: '04:59' },
  { id: 'morning', label: 'Morning', start: '05:00', end: '10:59' },
] as const;
export type MealPeriodId = (typeof MEAL_PERIODS)[number]['id'];

export type DuplicateMode = 'exclude' | 'include' | 'only';

/* ── the band lead-in ─────────────────────────────────────────────────────── */

/**
 * HOW LONG BEFORE A BAND STARTS ITS AUDIENCE IS ALREADY IN THE ROOM.
 *
 * A 21:00 band's guests book from about 19:00. Matching only the band's own
 * hours would answer "who was seated while it played", which is not the
 * question anyone asks — the question is "did the band fill the room", and most
 * of that room walked in before the first note. So a band filter matches
 * bookings from (start − lead-in) through the END OF SERVICE, not through the
 * band's end_time: guests who arrived for the band are still the band's guests
 * after it stops.
 *
 * Stored in ct_settings so it can be tuned per venue without a deploy. Not
 * listed in CT_SETTING_DEFAULTS — ctSetting() returns '' for an unset key, and
 * the default below is applied here, so the key is optional and adding it to
 * that map later changes nothing.
 */
export const BAND_LEAD_IN_KEY = 'reservation_band_lead_in_minutes';
export const BAND_LEAD_IN_DEFAULT_MINUTES = 120;
/** Clamped: a negative lead-in would search forwards, and a day-long one makes the filter meaningless. */
const BAND_LEAD_IN_MAX_MINUTES = 12 * 60;

export function bandLeadInMinutes(db: DB): number {
  // The blank check is load-bearing and was caught in test against the real
  // archive: ctSetting() returns '' for an unset key and Number('') is 0, which
  // is perfectly finite — so a bare Number() check turned "not configured" into
  // "no lead-in at all" and a 21:00 band matched only from 21:00, losing 84 of
  // the 152 bookings on the busiest Saturday in the archive.
  const raw = ctSetting(db, BAND_LEAD_IN_KEY).trim();
  if (!raw) return BAND_LEAD_IN_DEFAULT_MINUTES;
  const n = Number(raw);
  if (!Number.isFinite(n)) return BAND_LEAD_IN_DEFAULT_MINUTES;
  return Math.min(BAND_LEAD_IN_MAX_MINUTES, Math.max(0, Math.round(n)));
}

/* ── limits ───────────────────────────────────────────────────────────────── */

export const DEFAULT_LIMIT = 50;
/** Same hard cap as the Bookings list. Bulk extraction is the streaming export. */
export const MAX_LIMIT = 200;
export const MAX_VALUES_PER_LIST = 40;
const MAX_VALUE_LEN = 120;

/* ── the filter ───────────────────────────────────────────────────────────── */

export interface ReservationFilter {
  /** 0=Sun … 6=Sat. Empty = every day. Fri+Sat is [5, 6]. */
  dow: number[];
  mealPeriod: MealPeriodId | null;
  /** booking_date bounds — the RESERVED date, what a human means by "January". */
  from: string | null;
  to: string | null;
  /** slot_time bounds, 'HH:MM' inclusive. timeFrom > timeTo wraps past midnight. */
  timeFrom: string | null;
  timeTo: string | null;
  status: Status[];
  source: string[];
  liveBandId: string | null;
  outlet: string | null;
  duplicates: DuplicateMode;
  sort: SortKey;
  dir: 'asc' | 'desc';
  limit: number;
  offset: number;
}

/** Thrown for anything the caller could fix; `status` is the HTTP code to send. */
export class ReservationQueryError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ReservationQueryError';
    this.status = status;
  }
}

/**
 * Sortable columns as an allowlist keyed to an ORDER BY fragment. Interpolated
 * into SQL, which is safe ONLY because the key is checked with hasOwnProperty
 * against this object — `sort=__proto__` finds something on Object.prototype
 * and a bare lookup would sail straight past a truthiness check.
 *
 * booking_date carries slot_time with it: a date alone shuffles an evening's
 * bookings randomly between requests.
 */
const SORTABLE = {
  booking_date: (d: string) => `b.booking_date ${d}, b.slot_time ${d}`,
  slot_time: (d: string) => `b.slot_time ${d}, b.booking_date ${d}`,
  party_size: (d: string) => `b.party_size ${d}`,
  bill_amount: (d: string) => `b.bill_amount ${d}`,
  status: (d: string) => `b.status ${d}`,
} as const;
export type SortKey = keyof typeof SORTABLE;
const isSortable = (k: string): k is SortKey => Object.prototype.hasOwnProperty.call(SORTABLE, k);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** True only for a real calendar date — rejects 2026-13-40 and 2026-02-31. */
function isRealDate(d: string): boolean {
  const dt = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === d;
}

function asString(v: unknown, field: string): string {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string' && typeof v !== 'number') {
    throw new ReservationQueryError(`${field} must be a string`);
  }
  return String(v).trim();
}

function asStringList(v: unknown, field: string): string[] {
  if (v === null || v === undefined || v === '') return [];
  const arr = Array.isArray(v) ? v : [v];
  if (arr.length > MAX_VALUES_PER_LIST) {
    throw new ReservationQueryError(`${field} accepts at most ${MAX_VALUES_PER_LIST} values`);
  }
  const out: string[] = [];
  for (const item of arr) {
    const s = asString(item, field);
    if (!s) continue;
    if (s.length > MAX_VALUE_LEN) throw new ReservationQueryError(`${field} value is too long`);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * THE GATE. Everything downstream trusts the object this returns, so nothing
 * that is not checked here reaches the SQL builder.
 *
 * Unrecognised values are REFUSED, never coerced to a default. A typo in
 * `status` silently treated as "no status filter" would hand back the whole
 * archive under the label of a narrow question, and the reader has no way to
 * tell. The one deliberate exception is `sort`/`dir`, where an unknown value
 * falls back to the default ordering — ordering cannot change WHICH rows the
 * numbers describe.
 */
export function parseReservationFilter(input: unknown): ReservationFilter {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ReservationQueryError('filter must be a JSON object');
  }
  const raw = input as Record<string, unknown>;

  // dow — the reason this engine exists. Integers 0-6, deduped and sorted so
  // [6,5,5] and [5,6] produce the identical statement and cache key.
  const dow: number[] = [];
  if (raw.dow !== null && raw.dow !== undefined && raw.dow !== '') {
    const list = Array.isArray(raw.dow) ? raw.dow : [raw.dow];
    if (list.length > 7) throw new ReservationQueryError('dow accepts at most 7 values');
    for (const d of list) {
      const n = typeof d === 'number' ? d : Number(String(d).trim());
      if (!Number.isInteger(n) || n < 0 || n > 6) {
        throw new ReservationQueryError('dow values must be integers 0 (Sun) to 6 (Sat)');
      }
      if (!dow.includes(n)) dow.push(n);
    }
    dow.sort((a, b) => a - b);
  }

  const mealRaw = asString(raw.mealPeriod, 'mealPeriod');
  if (mealRaw && !MEAL_PERIODS.some((m) => m.id === mealRaw)) {
    throw new ReservationQueryError(`mealPeriod must be one of ${MEAL_PERIODS.map((m) => m.id).join(', ')}`);
  }
  const mealPeriod = (mealRaw || null) as MealPeriodId | null;

  const date = (v: unknown, field: string): string | null => {
    const s = asString(v, field);
    if (!s) return null;
    if (!DATE_RE.test(s) || !isRealDate(s)) {
      throw new ReservationQueryError(`${field} must be a real YYYY-MM-DD date`);
    }
    return s;
  };
  const from = date(raw.from, 'from');
  const to = date(raw.to, 'to');
  // Refused rather than swapped: from > to is a mistake in the question, and
  // silently answering the reversed one is how a wrong number gets believed.
  if (from && to && from > to) throw new ReservationQueryError('from must not be after to');

  const time = (v: unknown, field: string): string | null => {
    const s = asString(v, field);
    if (!s) return null;
    if (!TIME_RE.test(s)) throw new ReservationQueryError(`${field} must be HH:MM (00:00–23:59)`);
    return s;
  };
  const timeFrom = time(raw.timeFrom, 'timeFrom');
  const timeTo = time(raw.timeTo, 'timeTo');
  // No from>to check here — that is the legal way to ask for a window that
  // crosses midnight (21:00 → 02:00), which this venue's service does nightly.

  const status = asStringList(raw.status, 'status') as Status[];
  for (const s of status) {
    if (!(STATUSES as readonly string[]).includes(s)) {
      throw new ReservationQueryError(`status must be one of ${STATUSES.join(', ')}`);
    }
  }

  const source = asStringList(raw.source, 'source');
  const outlet = asString(raw.outlet, 'outlet') || null;
  if (outlet && outlet.length > MAX_VALUE_LEN) throw new ReservationQueryError('outlet is too long');

  const liveBandId = asString(raw.liveBandId, 'liveBandId') || null;
  if (liveBandId && liveBandId.length > MAX_VALUE_LEN) throw new ReservationQueryError('liveBandId is too long');

  const dupRaw = asString(raw.duplicates, 'duplicates') || 'exclude';
  if (!['exclude', 'include', 'only'].includes(dupRaw)) {
    throw new ReservationQueryError('duplicates must be exclude, include or only');
  }

  let sortRaw = asString(raw.sort, 'sort');
  let dirRaw = asString(raw.dir, 'dir').toLowerCase();
  if (sortRaw.startsWith('-')) { sortRaw = sortRaw.slice(1); if (!dirRaw) dirRaw = 'desc'; }
  const sort: SortKey = isSortable(sortRaw) ? sortRaw : 'booking_date';
  const dir: 'asc' | 'desc' = dirRaw === 'asc' ? 'asc' : 'desc';

  const limitRaw = raw.limit === null || raw.limit === undefined || raw.limit === '' ? DEFAULT_LIMIT : Number(raw.limit);
  const offsetRaw = raw.offset === null || raw.offset === undefined || raw.offset === '' ? 0 : Number(raw.offset);
  if (!Number.isFinite(limitRaw) || !Number.isFinite(offsetRaw)) {
    throw new ReservationQueryError('limit and offset must be numbers');
  }

  return {
    dow,
    mealPeriod,
    from,
    to,
    timeFrom,
    timeTo,
    status,
    source,
    liveBandId,
    outlet,
    duplicates: dupRaw as DuplicateMode,
    sort,
    dir,
    limit: Math.min(MAX_LIMIT, Math.max(1, Math.round(limitRaw) || DEFAULT_LIMIT)),
    offset: Math.max(0, Math.round(offsetRaw) || 0),
  };
}

/* ── live bands ───────────────────────────────────────────────────────────── */

export interface BandOption {
  id: string;
  name: string;
  type: string;
  event_date: string;
  start_time: string;
  end_time: string;
  area: string;
}

/**
 * The acts the Query tab can filter by — ct_entertainment, the manager's
 * "What's On" calendar. Bounded and newest-first: this feeds a picker, not a
 * report, and the calendar grows one row per act forever.
 */
export function listLiveBands(db: DB, limit = 200): BandOption[] {
  return db.prepare(`
    SELECT id, name, type, event_date, start_time, end_time, area
      FROM ct_entertainment
     WHERE event_date <> ''
     ORDER BY event_date DESC, start_time DESC
     LIMIT ?
  `).all(Math.min(1000, Math.max(1, limit))) as BandOption[];
}

export interface BandWindow {
  band: BandOption;
  leadInMinutes: number;
  /** The earliest slot_time on the band's date that counts as "for the band". */
  matchFrom: string;
  /** True when the lead-in ran off the front of the day and was clamped to 00:00. */
  clamped: boolean;
}

/** 'HH:MM' → minutes, or null if the calendar row holds free text. */
function hhmmToMinutes(t: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '').trim());
  if (!m) return null;
  const h = Number(m[1]); const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}
const minutesToHHMM = (n: number): string =>
  `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

/**
 * Resolve a band into the window its audience actually books into.
 *
 * From (start − lead-in) to the END OF SERVICE, which here means "no upper
 * bound inside the band's own date" — see BAND_LEAD_IN_KEY for why the band's
 * end_time is not the ceiling. The lead-in clamps at 00:00 rather than reaching
 * back into the previous calendar day: booking_date is a date column, and a
 * 00:30 act reaching back to 22:30 of the day before would pull in the whole of
 * the previous evening, which is a different night's business.
 *
 * ct_entertainment.start_time is free text ('HH:mm' by convention but nothing
 * enforces it). An unreadable one is a refusal, not a guess — silently treating
 * it as 00:00 would return the entire day under a band's name.
 */
export function resolveBandWindow(db: DB, bandId: string): BandWindow {
  const band = db.prepare(`
    SELECT id, name, type, event_date, start_time, end_time, area
      FROM ct_entertainment WHERE id = ?
  `).get(bandId) as BandOption | undefined;
  if (!band) throw new ReservationQueryError('That act is not on the entertainment calendar', 404);
  if (!band.event_date || !DATE_RE.test(band.event_date)) {
    throw new ReservationQueryError(`"${band.name || band.id}" has no usable date on the calendar`);
  }
  const start = hhmmToMinutes(band.start_time);
  if (start === null) {
    throw new ReservationQueryError(
      `"${band.name || band.id}" has no readable start time (${JSON.stringify(band.start_time)}) — set it as HH:mm to filter by it`,
    );
  }
  const leadInMinutes = bandLeadInMinutes(db);
  const raw = start - leadInMinutes;
  return {
    band,
    leadInMinutes,
    matchFrom: minutesToHHMM(Math.max(0, raw)),
    clamped: raw < 0,
  };
}

/* ── the statement ────────────────────────────────────────────────────────── */

interface BuiltWhere { sql: string; params: unknown[]; band: BandWindow | null }

/**
 * Every clause is ANDed. Two filters that overlap (a band and a time range, a
 * meal period and a time range) INTERSECT rather than one winning — the caller
 * asked for both, and a filter that quietly stops applying is the bug that
 * makes a number untrustworthy.
 */
function buildWhere(db: DB, f: ReservationFilter, opts: { forAggregate: boolean }): BuiltWhere {
  const where: string[] = [];
  const params: unknown[] = [];

  // Aggregates NEVER count a duplicate, whatever the row list is showing.
  if (opts.forAggregate || f.duplicates === 'exclude') where.push('COALESCE(b.is_duplicate, 0) = 0');
  else if (f.duplicates === 'only') where.push('COALESCE(b.is_duplicate, 0) = 1');

  if (f.dow.length && f.dow.length < 7) {
    // strftime on booking_date, which is stored 'YYYY-MM-DD'. A malformed date
    // yields NULL and the row drops out — correct: it has no weekday to be.
    // THE NIGHT, NOT THE DAY THE PHONE RANG.
    //
    // Reservego's column names are the reverse of what they read like, which is
    // the whole reason this comment exists: "Booking Time" is the SLOT the guest
    // is coming for, and "Reserved Time" is when the reservation was created.
    // Measured on a real export (BookingsService_01-02-2025, 245 rows), the two
    // fall on DIFFERENT calendar days for 76 of them — 31%.
    //
    // So filtering the weekday off booking_date answered "bookings CREATED on a
    // Sunday", not "Sunday dinners". reserved_date and its precomputed dow are
    // the night; they exist for exactly this query and are indexed for it.
    // Prefer the stored dow and fall back to deriving it, so a row imported
    // before the derived columns landed still answers correctly.
    where.push(`COALESCE(b.dow, CAST(strftime('%w', COALESCE(NULLIF(b.reserved_date, ''), b.booking_date)) AS INTEGER)) IN (${f.dow.map(() => '?').join(',')})`);
    params.push(...f.dow);
  }

  // Same correction as the weekday above: a date range means nights, not the
  // days the bookings happened to be taken.
  if (f.from) { where.push("COALESCE(NULLIF(b.reserved_date, ''), b.booking_date) >= ?"); params.push(f.from); }
  if (f.to) { where.push("COALESCE(NULLIF(b.reserved_date, ''), b.booking_date) <= ?"); params.push(f.to); }

  if (f.mealPeriod) {
    const m = MEAL_PERIODS.find((p) => p.id === f.mealPeriod)!;
    where.push('b.slot_time >= ? AND b.slot_time <= ?');
    params.push(m.start, m.end);
  }

  if (f.timeFrom && f.timeTo) {
    if (f.timeFrom <= f.timeTo) {
      where.push('b.slot_time >= ? AND b.slot_time <= ?');
      params.push(f.timeFrom, f.timeTo);
    } else {
      // Crosses midnight: 21:00 → 02:00 is late evening OR small hours.
      where.push('(b.slot_time >= ? OR b.slot_time <= ?)');
      params.push(f.timeFrom, f.timeTo);
    }
  } else if (f.timeFrom) {
    where.push('b.slot_time >= ?'); params.push(f.timeFrom);
  } else if (f.timeTo) {
    where.push('b.slot_time <= ?'); params.push(f.timeTo);
  }

  if (f.status.length) {
    where.push(`b.status IN (${f.status.map(() => '?').join(',')})`);
    params.push(...f.status);
  }

  if (f.source.length) {
    where.push(`b.source IN (${f.source.map(() => '?').join(',')})`);
    params.push(...f.source);
  }

  if (f.outlet) {
    // CASE-INSENSITIVE, and this is not politeness: the live archive holds
    // "Akan Hyderabad" (85,523 rows) and "AKAN HYDERABAD" (35) for one venue.
    // An exact match on the common spelling drops the other 35 — 2 of them live
    // rows that belong in the count — and nobody would ever notice the gap.
    where.push('LOWER(b.outlet_name) = LOWER(?)');
    params.push(f.outlet);
  }

  let band: BandWindow | null = null;
  if (f.liveBandId) {
    band = resolveBandWindow(db, f.liveBandId);
    where.push('b.booking_date = ? AND b.slot_time >= ?');
    params.push(band.band.event_date, band.matchFrom);
  }

  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params, band };
}

export interface ReservationAggregates {
  bookings: number;
  arrived: number;
  cancelled: number;
  no_show: number;
  total_pax: number;
  total_spend: number;
  /** Bookings carrying a bill — the denominator of average_spend. */
  billed_bookings: number;
  /** total_spend / billed_bookings, or null when nothing was billed. */
  average_spend: number | null;
  /** arrived / bookings as a 0–100 percentage, or null when there are no bookings. */
  arrival_rate: number | null;
}

export interface ReservationQueryRow {
  id: string;
  guest_id: string;
  guest_name: string | null;
  guest_phone: string | null;
  guest_phone10: string | null;
  booking_date: string;
  slot_time: string;
  dow: number | null;
  reserved_time: string | null;
  booking_time: string | null;
  party_size: number;
  status: string;
  reservego_status: string | null;
  arrived: number;
  is_duplicate: number;
  bill_amount: number | null;
  bill_number: string | null;
  source: string | null;
  booking_type: string | null;
  outlet_name: string | null;
  sections: string | null;
  tables_csv: string | null;
}

export interface ReservationQueryResult {
  rows: ReservationQueryRow[];
  /** How many rows this filter paginates over (respects `duplicates`). */
  total: number;
  /** Duplicates inside the filter, always reported, never counted. */
  duplicate_total: number;
  aggregates: ReservationAggregates;
  band: { id: string; name: string; event_date: string; start_time: string; end_time: string; lead_in_minutes: number; match_from: string; lead_in_clamped: boolean } | null;
  filter: ReservationFilter;
  took_ms: number;
}

/**
 * Run the query. One deferred read transaction so the counts, the aggregates
 * and the page describe the same instant — an import committing between the
 * count and the page would otherwise return a window off by a row.
 *
 * Cost, measured end to end on the real archive (82,022 live rows / 70,342
 * guests, better-sqlite3, warm cache): Fri+Sat with no date bound — the widest
 * question the tab can ask, 38,034 matching bookings — 46ms for the aggregate
 * pass, the duplicate count and the first page together; 57ms for Sunday
 * dinner; 92ms for a page at offset 37,000. The weekday filter is a scan
 * (strftime cannot use an index) and that is the floor for this shape of
 * question. better-sqlite3 is synchronous, so those milliseconds are the whole
 * server's — which is why limit is capped and the page must debounce rather
 * than re-run this per keystroke.
 */
export function runReservationQuery(db: DB, f: ReservationFilter): ReservationQueryResult {
  const t0 = Date.now();

  const rowsWhere = buildWhere(db, f, { forAggregate: false });
  const aggWhere = buildWhere(db, f, { forAggregate: true });

  const out = db.transaction(() => {
    // Aggregates in ONE pass. The CASE sums are free once the rows are walked;
    // a second COUNT(*) would double the most expensive query on the page.
    const agg = db.prepare(`
      SELECT COUNT(*) AS bookings,
             SUM(CASE WHEN COALESCE(b.arrived, 0) = 1 THEN 1 ELSE 0 END) AS arrived,
             SUM(CASE WHEN b.status = 'cancelled' THEN 1 ELSE 0 END)     AS cancelled,
             SUM(CASE WHEN b.status = 'no_show' THEN 1 ELSE 0 END)       AS no_show,
             SUM(COALESCE(b.party_size, 0))                              AS total_pax,
             -- NULL ≠ 0 on bill_amount: "no bill recorded" is not "spent
             -- nothing", so the average divides by the billed rows only.
             SUM(CASE WHEN b.bill_amount IS NOT NULL THEN b.bill_amount ELSE 0 END) AS total_spend,
             SUM(CASE WHEN b.bill_amount IS NOT NULL THEN 1 ELSE 0 END)  AS billed_bookings
        FROM ct_bookings b ${aggWhere.sql}
    `).get(...aggWhere.params) as Record<string, number | null>;

    const bookings = Number(agg?.bookings ?? 0);
    const billed = Number(agg?.billed_bookings ?? 0);
    const spend = Number(agg?.total_spend ?? 0);
    const arrived = Number(agg?.arrived ?? 0);
    const aggregates: ReservationAggregates = {
      bookings,
      arrived,
      cancelled: Number(agg?.cancelled ?? 0),
      no_show: Number(agg?.no_show ?? 0),
      total_pax: Number(agg?.total_pax ?? 0),
      total_spend: Math.round(spend * 100) / 100,
      billed_bookings: billed,
      average_spend: billed > 0 ? Math.round((spend / billed) * 100) / 100 : null,
      arrival_rate: bookings > 0 ? Math.round((arrived / bookings) * 1000) / 10 : null,
    };

    // How many of the matching rows are duplicates — reported so the screen can
    // say "3,576 duplicates excluded" instead of leaving a gap between the row
    // count and the booking count.
    const dupWhere = buildWhere(db, { ...f, duplicates: 'only' }, { forAggregate: false });
    const duplicateTotal = Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM ct_bookings b ${dupWhere.sql}`).get(...dupWhere.params) as any)?.n ?? 0,
    );

    const total = f.duplicates === 'exclude' ? bookings
      : f.duplicates === 'only' ? duplicateTotal
        : bookings + duplicateTotal;

    if (f.offset >= total) return { rows: [] as ReservationQueryRow[], total, duplicateTotal, aggregates, band: rowsWhere.band };

    // ID pass then hydrate by primary key — the same shape as the Bookings list
    // and for the same reason: LIMIT/OFFSET must still PRODUCE every skipped
    // row, and producing them as bare ids rather than 20 columns plus a joined
    // guest is what keeps a deep page cheap. `, b.id` makes the ordering total
    // so page 2 cannot repeat a row from page 1 when a busy Saturday shares a
    // date and slot across dozens of bookings.
    const d = f.dir === 'asc' ? 'ASC' : 'DESC';
    const ids = (db.prepare(`
      SELECT b.id FROM ct_bookings b ${rowsWhere.sql}
      ORDER BY ${SORTABLE[f.sort](d)}, b.id ${d}
      LIMIT ? OFFSET ?
    `).all(...rowsWhere.params, f.limit, f.offset) as Array<{ id: string }>).map((r) => String(r.id));
    if (!ids.length) return { rows: [] as ReservationQueryRow[], total, duplicateTotal, aggregates, band: rowsWhere.band };

    const hydrated = db.prepare(`
      SELECT b.id, b.guest_id, b.booking_date, b.slot_time, b.reserved_time, b.booking_time,
             b.party_size, b.status, b.reservego_status, b.arrived, b.is_duplicate,
             b.bill_amount, b.bill_number, b.source, b.booking_type, b.outlet_name,
             b.sections, b.tables_csv,
             COALESCE(b.dow, CAST(strftime('%w', COALESCE(NULLIF(b.reserved_date, ''), b.booking_date)) AS INTEGER)) AS dow,
             g.name AS guest_name, g.phone_e164 AS guest_phone, g.phone10 AS guest_phone10
        FROM ct_bookings b
        LEFT JOIN ct_guests g ON g.id = b.guest_id
       WHERE b.id IN (${ids.map(() => '?').join(',')})
    `).all(...ids) as ReservationQueryRow[];

    // IN (…) returns SQLite's order, not the id list's — put the page back into
    // the order that was asked for.
    const byId = new Map(hydrated.map((r) => [String(r.id), r]));
    const rows = ids.map((id) => byId.get(id)).filter(Boolean) as ReservationQueryRow[];
    return { rows, total, duplicateTotal, aggregates, band: rowsWhere.band };
  })();

  return {
    rows: out.rows,
    total: out.total,
    duplicate_total: out.duplicateTotal,
    aggregates: out.aggregates,
    band: out.band
      ? {
        id: out.band.band.id,
        name: out.band.band.name,
        event_date: out.band.band.event_date,
        start_time: out.band.band.start_time,
        end_time: out.band.band.end_time,
        lead_in_minutes: out.band.leadInMinutes,
        match_from: out.band.matchFrom,
        lead_in_clamped: out.band.clamped,
      }
      : null,
    filter: f,
    took_ms: Date.now() - t0,
  };
}

/* ── what the page renders ────────────────────────────────────────────────── */

export interface SchemaField {
  table: string;
  column: string;
  type: 'text' | 'date' | 'time' | 'number' | 'boolean';
  label: string;
  /** Which filter key targets this column, if any. */
  filter?: string;
  note?: string;
}

/**
 * THE SCHEMA THE QUERY TAB RENDERS.
 *
 * Named columns of named tables, so the page can show the owner what he is
 * actually filtering and the answer to "where does that number come from" is on
 * screen rather than in this file. Only columns this engine reads or returns
 * are listed — advertising a column the filter cannot use is a promise the
 * engine does not keep.
 */
export const RESERVATION_QUERY_SCHEMA: { tables: Array<{ table: string; label: string; description: string }>; fields: SchemaField[] } = {
  tables: [
    { table: 'ct_bookings', label: 'Bookings', description: 'One row per booking — Reservego imports and phone/CRM bookings in one table.' },
    { table: 'ct_guests', label: 'Guests', description: 'The customer master. Joined for the name and number on each row.' },
    { table: 'ct_entertainment', label: 'Entertainment calendar', description: 'Bands, DJs and events by date — the source of the live-band filter.' },
  ],
  fields: [
    { table: 'ct_bookings', column: 'booking_date', type: 'date', label: 'Reserved date', filter: 'from / to / dow', note: 'The date the table was booked FOR, not when the booking was made.' },
    { table: 'ct_bookings', column: 'slot_time', type: 'time', label: 'Slot time', filter: 'mealPeriod / timeFrom / timeTo / liveBandId', note: "HH:MM. Falls back to the booking's creation time for a walk-in." },
    { table: 'ct_bookings', column: 'booking_time', type: 'text', label: 'Booked at', note: 'When the booking was created — Reservego\'s unique record.' },
    { table: 'ct_bookings', column: 'reserved_time', type: 'text', label: 'Reserved for (full stamp)' },
    { table: 'ct_bookings', column: 'status', type: 'text', label: 'Status', filter: 'status', note: STATUSES.join(' · ') },
    { table: 'ct_bookings', column: 'reservego_status', type: 'text', label: 'Reservego status (raw)' },
    { table: 'ct_bookings', column: 'arrived', type: 'boolean', label: 'Arrived', note: 'Counted as "arrived" in the aggregates.' },
    { table: 'ct_bookings', column: 'party_size', type: 'number', label: 'Pax', note: 'Summed as total pax.' },
    { table: 'ct_bookings', column: 'bill_amount', type: 'number', label: 'Bill amount', note: 'NULL means no bill recorded, which is not zero — average spend divides by billed bookings only.' },
    { table: 'ct_bookings', column: 'bill_number', type: 'text', label: 'Bill number' },
    { table: 'ct_bookings', column: 'source', type: 'text', label: 'Source of booking', filter: 'source' },
    { table: 'ct_bookings', column: 'booking_type', type: 'text', label: 'Booking type' },
    { table: 'ct_bookings', column: 'outlet_name', type: 'text', label: 'Outlet', filter: 'outlet', note: 'Matched case-insensitively.' },
    { table: 'ct_bookings', column: 'sections', type: 'text', label: 'Section(s)' },
    { table: 'ct_bookings', column: 'tables_csv', type: 'text', label: 'Table(s)' },
    { table: 'ct_bookings', column: 'is_duplicate', type: 'boolean', label: 'Duplicate', filter: 'duplicates', note: 'Never counted in any aggregate.' },
    { table: 'ct_guests', column: 'name', type: 'text', label: 'Guest name' },
    { table: 'ct_guests', column: 'phone_e164', type: 'text', label: 'Guest phone' },
    { table: 'ct_guests', column: 'phone10', type: 'text', label: 'Guest phone (10-digit)' },
    { table: 'ct_entertainment', column: 'event_date', type: 'date', label: 'Act date', filter: 'liveBandId' },
    { table: 'ct_entertainment', column: 'start_time', type: 'time', label: 'Act start', filter: 'liveBandId', note: 'The band filter reaches back from here by the lead-in.' },
  ],
};

export interface QueryOptions {
  schema: typeof RESERVATION_QUERY_SCHEMA;
  statuses: readonly string[];
  meal_periods: typeof MEAL_PERIODS;
  dow: Array<{ value: number; label: string }>;
  sources: Array<{ value: string; count: number }>;
  outlets: Array<{ value: string; count: number }>;
  bands: BandOption[];
  band_lead_in_minutes: number;
  sortable: SortKey[];
  limits: { default: number; max: number };
}

/**
 * The pickers, filled from what is actually in the table — a source list typed
 * out by hand goes stale the first time Reservego adds a channel, and a filter
 * offering a value that matches nothing is indistinguishable from a broken
 * filter. Duplicates are excluded so the counts beside each option match what
 * choosing it will report.
 *
 * Both GROUP BYs are full scans of the 82,022 live rows (measured together with
 * the band list: 80ms). That is why this is a separate GET the page calls once
 * on mount, not something bundled into every query response.
 */
export function queryOptions(db: DB): QueryOptions {
  const sources = db.prepare(`
    SELECT source AS value, COUNT(*) AS count
      FROM ct_bookings
     WHERE COALESCE(is_duplicate, 0) = 0 AND source IS NOT NULL AND source <> ''
     GROUP BY source ORDER BY count DESC LIMIT 50
  `).all() as Array<{ value: string; count: number }>;

  // Grouped case-insensitively to match how the filter compares them, so the
  // list shows one "Akan Hyderabad" rather than two spellings of one venue.
  const outlets = db.prepare(`
    SELECT MIN(outlet_name) AS value, COUNT(*) AS count
      FROM ct_bookings
     WHERE COALESCE(is_duplicate, 0) = 0 AND outlet_name IS NOT NULL AND outlet_name <> ''
     GROUP BY LOWER(outlet_name) ORDER BY count DESC LIMIT 50
  `).all() as Array<{ value: string; count: number }>;

  return {
    schema: RESERVATION_QUERY_SCHEMA,
    statuses: STATUSES,
    meal_periods: MEAL_PERIODS,
    dow: DOW_LABELS.map((label, value) => ({ value, label })),
    sources,
    outlets,
    bands: listLiveBands(db),
    band_lead_in_minutes: bandLeadInMinutes(db),
    sortable: Object.keys(SORTABLE) as SortKey[],
    limits: { default: DEFAULT_LIMIT, max: MAX_LIMIT },
  };
}
