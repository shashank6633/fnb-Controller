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
 * STORED IN THE APP-WIDE `settings` TABLE — the same row db.ts seeds
 * (`INSERT OR IGNORE INTO settings … 'reservation_band_lead_in_minutes','120'`)
 * and the same row the importer reads through appSetting() before it hands a
 * slot to pickBandForSlot(). It used to be read out of the CRM's `ct_settings`
 * instead, which nothing writes this key to: the owner's configured value was
 * ignored, the hard-coded default below was permanent, and the Query tab and
 * relinkBands() would have answered with two different lead-ins the moment
 * anybody tuned it. Read it where the house keeps it.
 */
export const BAND_LEAD_IN_KEY = 'reservation_band_lead_in_minutes';
export const BAND_LEAD_IN_DEFAULT_MINUTES = 120;
/** Clamped: a negative lead-in would search forwards, and a day-long one makes the filter meaningless. */
const BAND_LEAD_IN_MAX_MINUTES = 12 * 60;

/** A row of the app-wide `settings` table, or '' — same shape as the importer's
 *  appSetting(). A database with no settings table (a bare test db) gets the
 *  default rather than a throw. */
function appSetting(db: DB, key: string): string {
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value?: unknown } | undefined;
    return String(row?.value ?? '');
  } catch { return ''; }
}

export function bandLeadInMinutes(db: DB): number {
  // The blank check is load-bearing and was caught in test against the real
  // archive: an unset key reads '' and Number('') is 0, which
  // is perfectly finite — so a bare Number() check turned "not configured" into
  // "no lead-in at all" and a 21:00 band matched only from 21:00, losing 84 of
  // the 152 bookings on the busiest Saturday in the archive.
  const raw = appSetting(db, BAND_LEAD_IN_KEY).trim();
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

/**
 * HOW MANY OF A BAND'S NIGHTS ONE QUESTION MAY OR TOGETHER.
 *
 * A band filter builds one `(night = ? AND slot_time >= ?)` term per night the
 * act played — `night` being the reserved date, see buildWhere() — so a
 * resident band is a long OR chain and two bound
 * parameters per night. 400 nights is a Friday-and-Saturday residency running
 * for four years — past that the statement text stops being free and the
 * question has stopped being a question.
 *
 * The cap keeps the MOST RECENT nights (the calendar is read newest-first) and
 * is REPORTED, never silent: `nights_capped` rides in the response echo so the
 * page can tell the reader to add a date range instead of quietly answering a
 * narrower question than the one asked. Undated calendar rows sort oldest under
 * that ordering, so they are the first to fall out when the cap bites — which
 * is also why the cap has to be visible.
 */
export const MAX_BAND_NIGHTS = 400;

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

/**
 * ONE OPTION IN THE BAND PICKER — a row of ct_bands, the band MASTER.
 *
 * Deliberately NOT a calendar row. `liveBandId` on the wire is a ct_bands id
 * (that is what /api/crm-calls/bands hands the page, and what the page has
 * always sent), and the whole bug this shape exists to prevent was one type
 * standing in for both a master row and a nightly calendar row — the resolver
 * looked the picker's id up in ct_entertainment, missed every time, and refused
 * every band anyone chose. A master row has no date and a calendar row has no
 * is_active, so keeping them as two types with no optional fields is what makes
 * the compiler catch the confusion instead of the user.
 */
export interface BandOption {
  id: string;
  name: string;
  is_active: number;
}

/** One night on ct_entertainment — one act, one date. Never a picker option. */
export interface BandNight {
  id: string;
  name: string;
  type: string;
  event_date: string;
  start_time: string;
  end_time: string;
  area: string;
}

/**
 * The bands the Query tab can filter by — ct_bands, the owner's curated band
 * master, which is the same list /api/crm-calls/bands serves the picker.
 *
 * RETIRED BANDS STAY IN THE LIST (no is_active filter). An act that stopped
 * playing last year still has every one of its nights in the archive, and
 * hiding it here would make exactly those nights unaskable; the flag ships so
 * the caller can label rather than drop. Same reason the page asks for
 * include_inactive=1.
 *
 * NOT ct_entertainment, which is what this read until the band filter moved to
 * the master: the calendar holds one row per act per NIGHT, so it is both the
 * wrong grain for a picker and — since resolveBandWindow() now only accepts
 * master ids — a list of ids the POST would refuse.
 *
 * A database without ct_bands yet answers "no bands", not 500. Measured on a
 * copy of production (2026-08-13) the live database had ct_entertainment but
 * not ct_bands; db.ts creates it on the next boot, and until then an empty
 * picker is the honest answer. Same defence as loadBandCalendar().
 *
 * ONLY a missing table, though — the same distinction resolveBandWindow() draws
 * on both of its reads. A corrupt b-tree or a half-applied migration answered as
 * `[]` is the sentence "there are no bands" said with total confidence about a
 * table full of bands, and an empty picker gives the reader no way to tell the
 * two apart. Anything that is not "no such table" is re-thrown.
 */
export function listLiveBands(db: DB, limit = 200): BandOption[] {
  try {
    return db.prepare(`
      SELECT id, name, COALESCE(is_active, 1) AS is_active
        FROM ct_bands
       ORDER BY name COLLATE NOCASE ASC
       LIMIT ?
    `).all(Math.min(1000, Math.max(1, limit))) as BandOption[];
  } catch (e) {
    if (!/no such table/i.test(e instanceof Error ? e.message : String(e))) throw e;
    return [];
  }
}

/** One night's worth of "who was in the room for this act". */
export interface BandWindow {
  /** ct_entertainment.id — which calendar row produced this window. */
  calendarId: string;
  eventDate: string;
  /** ct_entertainment.type, verbatim — see resolveBandWindow() on why it is not filtered. */
  type: string;
  startTime: string;
  endTime: string;
  /** The earliest slot_time on eventDate that counts as "for the band". */
  matchFrom: string;
  /** True when the lead-in ran off the front of the day and was clamped to 00:00. */
  clamped: boolean;
}

/**
 * A calendar row that could not become a window, and why. Never dropped
 * silently — this is carried verbatim into the response echo and printed by the
 * page, which is why it is spelt in the wire's snake_case rather than this
 * module's internal camelCase.
 */
export interface BandSkip {
  calendar_id: string;
  event_date: string;
  start_time: string;
  reason: string;
}

/** Everything one chosen band contributes to the question. */
export interface BandWindows {
  bandId: string;
  bandName: string;
  leadInMinutes: number;
  /** One per usable night, oldest first. Empty is legal — see buildWhere(). */
  windows: BandWindow[];
  /** Calendar rows this band has that could not be used, with the reason. */
  skipped: BandSkip[];
  /** True when the band has more than MAX_BAND_NIGHTS nights and older ones were dropped. */
  capped: boolean;
}

/**
 * 'HH:MM' → minutes, or null if the calendar row holds free text.
 *
 * A MERIDIEM IS REFUSED, NOT IGNORED. The prefix match below reads "9:00 PM" as
 * 09:00 — a twelve-hour error that runs the WRONG WAY: a 21:00 band's window
 * opens at 07:00 instead of 19:00 and the act is credited with the whole day's
 * lunches, with an empty skipped[] and nothing on screen to say so. That is
 * exactly the SILENT WIDENING resolveBandWindow()'s skip exists to prevent
 * (measured on a fixture: 10 of that day's 10 bookings credited instead of 4),
 * and the mirror case narrows just as quietly — "12:30 AM" reads as 10:30
 * rather than clamping at 00:00. The What's On start-time box is a plain text
 * input with no format check on either side, so a meridiem is ordinary typing
 * rather than corruption: skipped and REPORTED, with the reason already written
 * below telling the reader to set it as HH:mm.
 *
 * Deliberately narrow, so the forms proved correct still are: '19:00:00',
 * '9:30', ' 21:00' and '21:00 - 23:00' carry no meridiem and are unaffected.
 */
function hhmmToMinutes(t: string): number | null {
  if (/\d\s*[ap]\.?\s*m\b/i.test(String(t || ''))) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '').trim());
  if (!m) return null;
  const h = Number(m[1]); const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}
const minutesToHHMM = (n: number): string =>
  `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

/**
 * PICK A BAND, GET EVERY NIGHT THAT BAND PLAYED.
 *
 * `bandId` is a ct_bands id — the band MASTER, which is what the picker offers
 * and what the page has always sent. ct_entertainment has NO band foreign key;
 * the ONLY link between the master and the nightly calendar is the NAME. So the
 * resolution is: id → master name → every calendar row carrying that name → one
 * window per night. The question the owner asks is "how did this band do", not
 * "how did this one night do", and one band is many nights.
 *
 * (Before this, the resolver looked the picker's id up in ct_entertainment.
 * Master ids and calendar ids are different ids in different tables, so the
 * lookup missed every time and the filter refused every band ever chosen with
 * "That act is not on the entertainment calendar".)
 *
 * ── MATCHING THE NAME ─────────────────────────────────────────────────────
 * `TRIM(name) = ? COLLATE NOCASE`, and every word of that is load-bearing.
 *
 * COLLATE NOCASE is written EXPLICITLY, not inherited. ct_bands.name is UNIQUE
 * COLLATE NOCASE — 'Agnee' and 'AGNEE' cannot both be bands — but
 * ct_entertainment.name is plain BINARY TEXT, and in SQLite the LEFT operand's
 * column collation wins. Proved on a throwaway db holding AGNEE/Agnee/agnee:
 * `e.name = b.name` returns 1 row and `b.name = e.name` returns 3, for the same
 * data. Relying on operand order would make the answer depend on how the
 * comparison happened to be typed. Same collation the uniqueness was enforced
 * under, stated so it survives a reorder. (NOCASE folds ASCII A–Z only; a band
 * named in Devanagari is matched exactly, which SQLite cannot improve on here.)
 *
 * TRIM on the calendar side because the master name is the trusted spelling and
 * a legacy calendar row written before the What's On editor trimmed its input
 * would otherwise resolve to nothing at all — loadBandCalendar() trims the name
 * when it READS it but joins it untrimmed, and inherits exactly that gap. Two
 * acts whose names differ only in surrounding whitespace are one act, so the
 * trim can only ever recover a night, never merge two bands. It does cost any
 * future index on ct_entertainment(name) — there is none today, and this is a
 * scan either way.
 *
 * ── `type` IS NOT FILTERED, AND THAT IS A DECISION ────────────────────────
 * relinkBands()/loadBandCalendar() only credit rows with type='band', because
 * only those feed ct_bookings.live_band_id. This resolver deliberately takes
 * EVERY row carrying the name — a 'live_music' or 'dj' row named for the act is
 * still that act on that night, and the approved behaviour is "every night that
 * band played". The cost is that this surface can report more nights than the
 * live_band_id backfill credits, so each window ships its `type` and the echo
 * carries it to the page rather than hiding the difference.
 *
 * ── THE WINDOW, PER NIGHT (unchanged) ─────────────────────────────────────
 * From (start − lead-in) to the END OF SERVICE, which here means "no upper
 * bound inside that night's date" — see BAND_LEAD_IN_KEY for why the band's
 * end_time is not the ceiling. The lead-in clamps at 00:00 rather than reaching
 * back into the previous calendar day: the night is a date column, and a
 * 00:30 act reaching back to 22:30 of the day before would pull in the whole of
 * the previous evening, which is a different night's business. The lead-in is
 * read ONCE for the whole band, so every night in one answer shares it.
 *
 * ── AN UNUSABLE NIGHT IS SKIPPED AND REPORTED, NOT REFUSED ────────────────
 * ct_entertainment.start_time is free text ('HH:mm' by convention; the write
 * path only does .trim().slice(0,10) and validates no format at all), so an
 * unreadable one is an ORDINARY row, not corruption. It used to be a refusal
 * because there was one night to refuse. Under "every night that band played" a
 * refusal scales wrong: one fat-fingered start time in 2024 would make a band's
 * ENTIRE history permanently unaskable until someone edits the calendar.
 *
 * The hazard the refusal existed for does not apply to a skip. That hazard is
 * silently treating an unreadable time as 00:00 and returning the whole day
 * under a band's name — a SILENT WIDENING. A skip only ever narrows, and it is
 * not silent: every skipped row rides back in `skipped[]` with its reason, and
 * the page prints them. The house already prefers this — pickBandForSlot()
 * treats an untimed act as a fallback and resolveLiveBand() sorts untimed rows
 * last; neither throws.
 *
 * A row with no usable event_date is skipped the same way but with its own
 * reason, because it means something different: both write paths validate
 * event_date against /^\d{4}-\d{2}-\d{2}$/ and 400 on failure, so an undated
 * row cannot arrive through the app at all. It is a corruption signal, and
 * naming it separately is what lets a reader tell a typo from a broken import.
 *
 * ZERO usable nights is a legal answer, not an error — see buildWhere(), which
 * turns it into an always-false predicate rather than no predicate.
 */
export function resolveBandWindow(db: DB, bandId: string): BandWindows {
  let master: BandOption | undefined;
  try {
    master = db.prepare(`
      SELECT id, name, COALESCE(is_active, 1) AS is_active FROM ct_bands WHERE id = ?
    `).get(bandId) as BandOption | undefined;
  } catch (e) {
    // ONLY A MISSING TABLE IS "NOT SET UP YET" — the same test the calendar read
    // below applies, and for the same reason. This catch used to be bare, so a
    // corrupt b-tree, a half-applied migration (initializeSchema swallows schema
    // errors, so a missing column is an ordinary state here), a garbled file and
    // a locked database ALL came back as the one confident sentence "the band
    // list has not been set up on this database yet" — about a table that exists
    // and holds the band. Reproduced on fixture copies for SQLITE_CORRUPT,
    // "no such column: is_active", SQLITE_NOTADB and SQLITE_BUSY. Fail loud with
    // the real reason instead; this route is admin-only and the person reading
    // it is the person who has to fix the database.
    const why = e instanceof Error ? e.message : String(e);
    if (!/no such table/i.test(why)) {
      throw new ReservationQueryError(
        `The band list could not be read, so no band can be looked up — the answer would be wrong rather than empty (${why})`,
        500,
      );
    }
    throw new ReservationQueryError(
      'The band list has not been set up on this database yet, so no band can be looked up',
      404,
    );
  }
  if (!master) throw new ReservationQueryError('That band is not in the band list', 404);

  const bandName = String(master.name || '').trim();
  if (!bandName) {
    // Blocked by the band master's own write path; refused rather than run,
    // because an empty name would match every unnamed calendar row.
    throw new ReservationQueryError('That band has no name on the band list, so its nights cannot be found');
  }

  // Newest first so the cap, when it bites, keeps the nights someone is most
  // likely to be asking about. `id` breaks the tie so that a capped band's set
  // is the SAME set on every request — without it two acts sharing a date and
  // start time could swap places across the cap boundary and the same question
  // would quietly answer differently twice running.
  //
  // TRIM TAKES AN EXPLICIT CHARACTER SET because bare SQL TRIM() strips U+0020
  // and NOTHING ELSE, while the master name above went through JS .trim(),
  // which also strips tab, newline, CR, VT, FF, NBSP and BOM. Left asymmetric,
  // a calendar row pasted in as ' Agnee' — an ordinary WhatsApp/Word paste
  // artefact, and the calendar's write path never normalises whitespace the way
  // the band master's does — matches NOTHING, and because it never becomes a
  // row this loop can see, it lands in neither `windows` nor `skipped[]`: the
  // night simply disappears from the band's history with nothing on screen
  // saying so. Measured on a copy: 3 of one band's 4 nights vanished that way.
  // This set is JS .trim()'s set for every character that reaches a name in
  // practice; verified equal to .trim() on tab/LF/CR/NBSP/BOM and on names with
  // interior spaces, quotes, % and Devanagari, so it can only recover a night,
  // never merge two acts. (A name of nothing but whitespace trims to '' on both
  // sides, and an empty master name is already refused above.)
  let nights: BandNight[] = [];
  try {
    nights = db.prepare(`
      SELECT id, name, type, event_date, start_time, end_time, area
        FROM ct_entertainment
       WHERE TRIM(name, char(32,9,10,13,11,12,160,65279)) = ? COLLATE NOCASE
       ORDER BY event_date DESC, start_time DESC, id DESC
       LIMIT ?
    `).all(bandName, MAX_BAND_NIGHTS + 1) as BandNight[];
  } catch (e) {
    // ONLY A MISSING TABLE IS "THIS BAND HAS NO NIGHTS". That is the
    // half-migrated database listLiveBands() defends, and an empty answer is
    // honest there.
    //
    // ANY OTHER failure must NOT be answered as zero nights. Zero windows makes
    // buildWhere() emit `1 = 0`, the echo carries nights_matched: 0 with an
    // EMPTY skipped[], and the page then prints the positive claim "… is on the
    // band list but has no nights on the entertainment calendar" — a confident,
    // wrong, narrowing answer indistinguishable from a band genuinely never put
    // on the calendar, with no channel by which the reader learns the database
    // failed. Reproduced on copies of the database: a corrupt ct_entertainment
    // b-tree, and a single dropped column, each turned a healthy 39-row answer
    // into a clean 0. Fail LOUD instead — the reason rides in the message
    // because this route is admin-only and the person reading it is the person
    // who has to fix the calendar.
    const why = e instanceof Error ? e.message : String(e);
    if (!/no such table/i.test(why)) {
      throw new ReservationQueryError(
        `The entertainment calendar could not be read, so this band's nights are unknown — the answer would be wrong rather than empty (${why})`,
        500,
      );
    }
    nights = [];
  }

  // One row over the cap is how the cap is DETECTED without a second scan.
  const capped = nights.length > MAX_BAND_NIGHTS;
  if (capped) nights = nights.slice(0, MAX_BAND_NIGHTS);
  nights.reverse();  // oldest → newest, the order a person reads a history in

  const leadInMinutes = bandLeadInMinutes(db);
  const windows: BandWindow[] = [];
  const skipped: BandSkip[] = [];

  for (const n of nights) {
    const eventDate = String(n.event_date || '').trim();
    const startTime = String(n.start_time || '');
    const calendarId = String(n.id || '');
    // isRealDate as well as the shape, the same pair parseReservationFilter()
    // applies to from/to: 2026-02-31 and 2026-13-01 pass /^\d{4}-\d{2}-\d{2}$/
    // and can never match a stored night, so on the shape check alone they
    // became OR terms that inflated nights_matched and pushed an impossible
    // date into first_night/last_night on screen, while being absent from
    // skipped[]. Both write paths validate shape only, so this is the check
    // that keeps an impossible date a REPORTED skip instead of a phantom night.
    if (!eventDate || !DATE_RE.test(eventDate) || !isRealDate(eventDate)) {
      skipped.push({
        calendar_id: calendarId,
        event_date: eventDate,
        start_time: startTime,
        reason: 'no usable date on the calendar row',
      });
      continue;
    }
    const start = hhmmToMinutes(startTime);
    if (start === null) {
      skipped.push({
        calendar_id: calendarId,
        event_date: eventDate,
        start_time: startTime,
        reason: `start time ${JSON.stringify(startTime)} is not readable — set it as HH:mm to include this night`,
      });
      continue;
    }
    const raw = start - leadInMinutes;
    windows.push({
      calendarId,
      eventDate,
      type: String(n.type || ''),
      startTime,
      endTime: String(n.end_time || ''),
      matchFrom: minutesToHHMM(Math.max(0, raw)),
      clamped: raw < 0,
    });
  }

  return { bandId: String(master.id), bandName, leadInMinutes, windows, skipped, capped };
}

/* ── the statement ────────────────────────────────────────────────────────── */

interface BuiltWhere { sql: string; params: unknown[] }

/**
 * Every clause is ANDed. Two filters that overlap (a band and a time range, a
 * meal period and a time range) INTERSECT rather than one winning — the caller
 * asked for both, and a filter that quietly stops applying is the bug that
 * makes a number untrustworthy.
 *
 * `opts.band` is resolved ONCE by the caller and handed in, not looked up here:
 * this runs three times per request (rows, aggregates, duplicates) and all
 * three must describe the same set of nights. It also keeps the refusal for an
 * unknown band outside db.transaction(), where the duplicate pass lives.
 */
function buildWhere(f: ReservationFilter, opts: { forAggregate: boolean; band: BandWindows | null }): BuiltWhere {
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

  if (f.liveBandId) {
    const nights = opts.band?.windows ?? [];
    if (!nights.length) {
      // ZERO NIGHTS IS NOT "NO BAND FILTER". A band on the master with nothing
      // on the calendar — the default state of every act the owner adds before
      // it plays, and the state left when every one of its nights was skipped —
      // must return NOTHING, not the whole archive under that band's name. An
      // empty OR chain pushed as an empty string would drop the clause
      // entirely, which is the worst outcome this engine has: a narrow question
      // answered with every row in the table. Spelt as an explicit always-false
      // predicate so it can never be optimised away by accident, and reported
      // as nights_matched: 0 so the page can say why the answer is empty.
      where.push('1 = 0');
    } else {
      // ONE WINDOW PER NIGHT, ORed: that night's date, and everything from the
      // lead-in onwards.
      //
      // THE NIGHT, NOT THE DAY THE PHONE RANG — the same correction as the
      // weekday and date clauses above, and for the same reason. This clause
      // used to test b.booking_date, which is the moment the booking was
      // CREATED (reservego.ts slotStampOf: "booking_date is when it was BOOKED,
      // reserved_date is the night they were coming"), while pairing it with
      // b.slot_time, which is the time half of the NIGHT's stamp. Mixing the two
      // stamps is wrong in both directions at once: a guest who booked six weeks
      // ahead and was in the room is dropped, and a guest who merely phoned on
      // the gig night to book a table for May is counted as audience. Measured
      // on a fixture of 8 bookings around one 21:00 night, 3 were wrong. The
      // house's own band-attribution tool agrees with this expression —
      // relinkBands() (src/lib/reservego-import.ts) resolves the night with the
      // identical COALESCE before handing the slot to pickBandForSlot().
      //
      // ── WHY TWO DISJUNCTS PER NIGHT AND NOT ONE COALESCE ──────────────────
      // The night is `COALESCE(NULLIF(reserved_date,''), booking_date)`, and
      // written that way it is also UNINDEXABLE: a function of a column cannot
      // use idx_ct_bookings_resv_date, so every night's term is evaluated
      // against every row. MEASURED on an archive-sized fixture (84,000
      // bookings, 400-night residency, warm cache): the COALESCE form plans as
      // SCAN b and takes 2,079ms for ONE of the three passes this request
      // makes — and better-sqlite3 is synchronous, so that is the whole server
      // stopped for seconds on one click. Spelt as the two cases instead, both
      // operands are bare columns, SQLite plans MULTI-INDEX OR, and the same
      // 400-night question costs 13.9ms — faster than the 33.6ms the wrong
      // column used to manage. Counts verified identical to the COALESCE form
      // at 1 / 10 / 50 / 200 / 400 nights on that fixture.
      //
      // The two cases are exhaustive and disjoint. reserved_date is either a
      // real date — the Reservego rows, where the first disjunct answers and
      // '' can never equal a validated event_date — or blank/NULL, which is how
      // the 40 phone/CRM bookings are stored (they write booking_date only), and
      // then the guarded second disjunct answers. Dropping the fallback would
      // make every phone booking unfindable by band.
      //
      // ORDER OF MAGNITUDE, NOT ORDER OF PREFERENCE: a row satisfies at most one
      // disjunct, so the OR cannot double-count.
      //
      // THE CAP IS WHAT KEEPS THIS LEGAL. Two OR terms per night against
      // SQLite's expression-depth ceiling of 1000: measured, this form prepares
      // and runs at 495 nights and throws "Expression tree is too large" at 498.
      // MAX_BAND_NIGHTS is 400, so there is ~24% headroom — RE-MEASURE BEFORE
      // RAISING THAT CAP; the one-disjunct form's own cliff was 996 nights.
      //
      // The OUTER parentheses are mandatory: without them the OR chain binds
      // looser than the ANDs around it and would absorb every preceding clause,
      // so the weekday, date, status and outlet filters would silently stop
      // applying the moment a band was picked.
      //
      // Only the placeholder run is interpolated, sized to a list this module
      // bounded at MAX_BAND_NIGHTS — every value stays bound, same discipline
      // as the dow/status/source lists above.
      const perNight = "(b.reserved_date = ? AND b.slot_time >= ?)"
        + " OR (COALESCE(b.reserved_date, '') = '' AND b.booking_date = ? AND b.slot_time >= ?)";
      where.push(`(${nights.map(() => perNight).join(' OR ')})`);
      for (const w of nights) params.push(w.eventDate, w.matchFrom, w.eventDate, w.matchFrom);
    }
  }

  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
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
  /**
   * WHAT THE BAND FILTER ACTUALLY DID — the page renders this.
   *
   * Plural by construction, because one band is many nights. It reports the
   * SHAPE of the answer (how many nights, over what range) rather than any one
   * night, and it carries everything that was left out: rows skipped for an
   * unreadable time or a broken date, and whether the night cap dropped the
   * older end of a long residency. Those are the only channel by which a
   * skipped night reaches a human, so nothing here is optional.
   */
  band: {
    /** ct_bands.id, exactly as asked for. */
    id: string;
    /** ct_bands.name — the master spelling, not the calendar's. */
    name: string;
    lead_in_minutes: number;
    /** Distinct dates in the filter. 0 is a real answer: on the master, never on the calendar. */
    nights_matched: number;
    /** OR terms in the statement — more than nights_matched when an act played twice on a date. */
    windows_used: number;
    first_night: string | null;
    last_night: string | null;
    /** True when ANY night's lead-in ran off the front of the day and clamped to 00:00. */
    lead_in_clamped: boolean;
    /** True when the band has more nights than the cap and the oldest were dropped. */
    nights_capped: boolean;
    nights_cap: number;
    nights: Array<{
      calendar_id: string;
      event_date: string;
      type: string;
      start_time: string;
      end_time: string;
      match_from: string;
      lead_in_clamped: boolean;
    }>;
    skipped: BandSkip[];
  } | null;
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

  // ONCE, not once per pass. buildWhere runs three times below and a band with
  // 200 nights is a full scan of ct_entertainment (no index on name) each time;
  // resolving here also means the three passes cannot disagree about which
  // nights they are counting, and that an unknown band is refused before the
  // transaction rather than from inside it.
  const band = f.liveBandId ? resolveBandWindow(db, f.liveBandId) : null;

  const rowsWhere = buildWhere(f, { forAggregate: false, band });
  const aggWhere = buildWhere(f, { forAggregate: true, band });

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
    const dupWhere = buildWhere({ ...f, duplicates: 'only' }, { forAggregate: false, band });
    const duplicateTotal = Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM ct_bookings b ${dupWhere.sql}`).get(...dupWhere.params) as any)?.n ?? 0,
    );

    const total = f.duplicates === 'exclude' ? bookings
      : f.duplicates === 'only' ? duplicateTotal
        : bookings + duplicateTotal;

    if (f.offset >= total) return { rows: [] as ReservationQueryRow[], total, duplicateTotal, aggregates };

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
    if (!ids.length) return { rows: [] as ReservationQueryRow[], total, duplicateTotal, aggregates };

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
    return { rows, total, duplicateTotal, aggregates };
  })();

  // The band echo is built from the ONE resolution above, outside the closure,
  // so every exit from it — offset past the end, no ids, a full page — reports
  // the same nights. Threading it through each return is how the two used to
  // drift apart.
  const dates = band ? [...new Set(band.windows.map((w) => w.eventDate))].sort() : [];

  return {
    rows: out.rows,
    total: out.total,
    duplicate_total: out.duplicateTotal,
    aggregates: out.aggregates,
    band: band
      ? {
        id: band.bandId,
        name: band.bandName,
        lead_in_minutes: band.leadInMinutes,
        nights_matched: dates.length,
        windows_used: band.windows.length,
        first_night: dates[0] ?? null,
        last_night: dates[dates.length - 1] ?? null,
        lead_in_clamped: band.windows.some((w) => w.clamped),
        nights_capped: band.capped,
        nights_cap: MAX_BAND_NIGHTS,
        nights: band.windows.map((w) => ({
          calendar_id: w.calendarId,
          event_date: w.eventDate,
          type: w.type,
          start_time: w.startTime,
          end_time: w.endTime,
          match_from: w.matchFrom,
          lead_in_clamped: w.clamped,
        })),
        skipped: band.skipped,
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
    { table: 'ct_bands', label: 'Band master', description: "The owner's curated list of acts. The live-band filter is picked from here; ct_bands.name is the only link into the calendar." },
    { table: 'ct_entertainment', label: 'Entertainment calendar', description: 'Bands, DJs and events by date. Matched to a band by NAME (there is no band id on it) — one window per night the act played.' },
  ],
  fields: [
    { table: 'ct_bookings', column: 'booking_date', type: 'date', label: 'Booked on (date)', note: 'When the booking was MADE, not the night it was for. Reservego\'s column names read the other way round; this one is identity (the dedupe key) and is only used as a fallback when reserved_date is blank.' },
    { table: 'ct_bookings', column: 'reserved_date', type: 'date', label: 'Reserved date (the night)', filter: 'from / to / dow / liveBandId', note: 'The night the guest was coming — what every date filter here means. Falls back to booking_date when blank.' },
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
    { table: 'ct_bands', column: 'id', type: 'text', label: 'Band', filter: 'liveBandId', note: 'What the picker sends. Resolved to the band name, then to every night that name is on the calendar.' },
    { table: 'ct_bands', column: 'name', type: 'text', label: 'Band name', filter: 'liveBandId', note: 'Matched to ct_entertainment.name case-insensitively (COLLATE NOCASE) and trimmed.' },
    { table: 'ct_entertainment', column: 'name', type: 'text', label: 'Act name', filter: 'liveBandId', note: 'The only link back to the band master — the calendar has no band id.' },
    { table: 'ct_entertainment', column: 'event_date', type: 'date', label: 'Act date', filter: 'liveBandId', note: 'One booking_date window per night the band played, ORed together.' },
    { table: 'ct_entertainment', column: 'start_time', type: 'time', label: 'Act start', filter: 'liveBandId', note: 'The band filter reaches back from here by the lead-in, clamped at 00:00. A night whose start time is not readable as HH:mm is skipped and reported, never guessed at.' },
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
