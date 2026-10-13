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
// THE TIME PARSER IS IMPORTED, NOT COPIED. This module and reservego.ts each
// used to carry their own reading of ct_entertainment.start_time and they
// disagreed by twelve hours on the same row — see minutesOfDay's own comment.
// reservego.ts is a pure leaf module (it imports nothing), so this edge cannot
// cycle, and this file stays read-only: nothing on that side touches a database.
import { minutesOfDay } from '@/lib/reservego';

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

/* ── repeat customers ─────────────────────────────────────────────────────── */

/**
 * WHAT COUNTS AS A VISIT, AND IT IS NOT THE `arrived` COLUMN.
 *
 * A visit is a booking whose status says THE GUEST TURNED UP: 'completed' or
 * 'seated'. The owner was shown that 43,944 of his 99,386 bookings are
 * CANCELLED and chose this definition over the flattering one, so a guest who
 * booked five times and cancelled four is NOT a repeat customer.
 *
 * DELIBERATELY NOT `COALESCE(arrived, 0) = 1`, which is what the existing
 * "arrived" stat card counts. They are not the same rule. `arrived` is
 * ARRIVED_SQL / isArrived() (src/lib/reservego.ts), which counts a THIRD case
 * this one does not: a row whose status is 'pending' or 'confirmed' but which
 * carries a non-empty seated_at. So the two sets differ on exactly
 *   status IN ('pending','confirmed') AND TRIM(COALESCE(seated_at,'')) <> ''
 * and nowhere else. MEASURED on the live database: 0 such rows, and 0 rows
 * disagreeing in either direction. (The production-shaped fixture this feature
 * was proven on also shows 0, but that one agrees BY CONSTRUCTION — the seeder
 * writes status and arrived together — so only the live-database figure is
 * evidence about real data.)
 *
 * Anchoring on the STATUS is the choice because the number on screen can then
 * be re-derived by a human from the status column in the row list beside it,
 * and it cannot drift when a stale Reservego "Seated Time" lands on a pending
 * row. If the two ever part company the "arrived" card and the repeat cards
 * will differ, and that is honest: they answer two different questions.
 */
export const VISIT_STATUSES = ['completed', 'seated'] as const satisfies readonly Status[];

/** Two arrivals make a repeat customer. One does not. */
export const REPEAT_VISIT_THRESHOLD = 2;

/**
 * THE REPEAT DIMENSION — Everyone / repeat only / first-timers only.
 *
 * 'all' is the default and must stay the default: at 'all' this filter adds no
 * clause and no statement changes, so every number that was on the screen
 * before this feature existed is the same number afterwards.
 *
 * 'repeat' and 'first' SPLIT THE GUESTS THE ARCHIVE CAN IDENTIFY, and they do
 * not cover everyone. Over the ids that have a phone number they are an exact
 * partition — every such booking belongs to a guest who either has more than
 * one lifetime visit or does not, which is why the predicate is written as
 * IN / NOT IN against the same id list rather than as two independently built
 * tests. Over the ids that do NOT, they claim nothing: a phone-less id is a
 * merged bucket whose re-uploads never collapse (see identifiedGuestSql), so
 * calling it a repeat customer is a false claim about a person and calling it a
 * first-timer is the same false claim pointing the other way. Those rows appear
 * under 'all' only, they are counted by `unidentified_customers`, and each one
 * is marked on screen — a third bucket that is reported rather than a row that
 * falls through. A booking whose guest_id matches no ct_guests row at all (an
 * orphan) has no phone10 to read and lands there too.
 */
export const REPEAT_MODES = ['all', 'repeat', 'first'] as const;
export type RepeatMode = (typeof REPEAT_MODES)[number];

/**
 * WHEN THE ARCHIVE CAN ACTUALLY NAME THE PERSON — ct_guests.phone10, and
 * nothing else will do.
 *
 * This is the gate on every per-person claim the screen makes, and it exists
 * because of ONE measured fact about the import, not out of caution:
 *
 *   markDuplicateGroups() (src/lib/reservego.ts:983, and the same line in
 *   collapseSameDayDuplicates at :861) pushes a row with no phone10 straight
 *   onto primaryIds BEFORE it builds a group key. A guest id with no phone10
 *   therefore has NO row that is ever flagged is_duplicate, so for that id a
 *   re-uploaded booking IS counted as a second visit — the one place in the
 *   archive where the re-upload collapse never happens.
 *
 * And the same ids are the ones the importer keys on EMAIL or NAME
 * (reservego-import.ts:1020 — `email:<addr>` / `name:<name>` when there is no
 * number), so one id absorbs every unrelated human the desk typed "Guest" or
 * "Walk in" for. MEASURED on a production-shaped fixture: a phone-less
 * "Walk in" id holding 47 unrelated bookings rendered visit_count 47,
 * visit_number 47, and sat at the top of Repeat only — the screen called it the
 * venue's biggest regular. The importer's own comment measures 47 such guests
 * in production.
 *
 * THE TWO DEFECTS COMPOUND, which is why one test gates both claims: the merged
 * bucket is also the bucket whose re-uploads never collapse, so its visit
 * figures are wrong in both the "who" and the "how many".
 *
 * phone10, NOT phone_e164, and that is deliberate. src/lib/ct/guest-autosave.ts
 * inserts a ct_guests row with a real phone_e164 and NO phone10 at all, and
 * markDuplicateGroups reads phone10 (via reservego-import.ts:1420, `g.phone10`
 * joined on b.guest_id). Such a guest is a real person with a real number whom
 * the archive still cannot match, so their re-uploads still never collapse.
 * Testing phone_e164 would call them identified and re-admit the inflated count.
 * The test here is EXACTLY the condition markDuplicateGroups needs and no
 * weaker.
 *
 * WHAT THE SCREEN DOES WITH IT — keep the data, drop the claim:
 *   · the row still appears, and still carries its booking count;
 *   · it gets NO visit ordinal (visit_number is NULL) — see ReservationQueryRow;
 *   · it carries `guest_identified` so the page can mark it, and the owner can
 *     see WHICH rows are affected from the screen alone;
 *   · it is counted in `customers` but NOT in `repeat_customers`, and
 *     `unidentified_customers` reports how many there are so the arithmetic on
 *     the cards stays explainable — customers = identified + unidentified;
 *   · the Repeat only / First-timers only modes do not claim it either way.
 * Excluding it silently would have hidden real guests behind an unexplainable
 * total; counting it as-is printed a false claim about a person.
 *
 * NOT A FIX FOR THE ARCHIVE, and not trying to be. Re-keying guest identity, or
 * changing how 99,386 bookings are deduplicated, is a decision about the guest
 * master that the owner has not asked for. This only stops the screen stating
 * what the archive cannot support.
 */
function identifiedGuestSql(alias: string): string {
  return `COALESCE(${alias}.phone10, '') <> ''`;
}

/**
 * The same test for a bookings row that has no ct_guests join to hand.
 *
 * An EXISTS against the primary key, NOT `guest_id IN (SELECT id FROM
 * ct_guests WHERE …)`: the IN form materialises a list of ~84,000 ids on every
 * query, the EXISTS form is one primary-key seek per row. It is also correct for
 * an ORPHAN guest_id — a booking whose guest matches no ct_guests row at all —
 * which has no phone10 to read and so is NOT identified, which is the honest
 * answer about a guest the master has never heard of.
 */
function identifiedByGuestIdSql(guestIdExpr: string): string {
  return `EXISTS (SELECT 1 FROM ct_guests ig`
    + ` WHERE ig.id = ${guestIdExpr} AND ${identifiedGuestSql('ig')})`;
}

/**
 * WHO COUNTS AS ONE CUSTOMER — ct_bookings.guest_id, and the limits of that.
 *
 * Every count here keys on b.guest_id. That is the app's OWN notion of which
 * customer a booking belongs to, it is what the rest of this screen already
 * joins on, and it needs no join to ct_guests to evaluate — which is what keeps
 * the lifetime pass affordable (see lifetimeVisitsSql).
 *
 * THE IMPORTER ALREADY UNIFIES ON THE LAST 10 DIGITS. reservego-import.ts
 * resolves a guest by `SELECT … WHERE phone10 = ?` FIRST and only then by
 * phone_e164, so for the Reservego rows that are ~all of the archive, one human
 * with one mobile number holds one guest_id. This is the same last-10-digit
 * rule the rest of the CRM uses.
 *
 * WHERE IT CAN STILL BE WRONG, both directions, because the owner should know
 * what caps the number rather than trusting a figure with no stated error:
 *
 *  1. UNDERCOUNT — one human, two guest ids. ct_guests.phone_e164 is UNIQUE but
 *     phone10 is NOT (there is an index on it, not a constraint), and not every
 *     writer fills phone10 in: ct/guest-autosave.ts inserts id/phone_e164/name
 *     only. A CRM-created guest therefore has phone10 NULL, the importer's
 *     phone10 lookup misses it, and a second profile can be created for the
 *     same person under a differently-formatted number. Their visits then split
 *     across two ids and a genuine regular reads as two first-timers. This
 *     direction UNDERSTATES repeat customers, which is the same way the owner
 *     already chose to be wrong when he picked arrivals over bookings for D1.
 *     Measured on the live database: 0 phone10 values are shared by two guest
 *     ids — but all 27 of its guests have phone10 NULL, so that 0 means "no
 *     evidence here", not "does not happen".
 *     The phone10-NULL half of this is no longer counted as a person at all:
 *     identifiedGuestSql() excludes it from every per-person claim, so a
 *     CRM-created guest is reported as unidentified rather than as a
 *     first-timer the screen is sure about.
 *
 *  2. OVERCOUNT — two humans, one guest id. This is the one that is NOT
 *     conservative, so it is worth stating loudly. reservego-import.ts falls
 *     back to matching on EMAIL and then on NAME, for phone-less guests only
 *     (phone_e164 empty or an 'email:' / 'name:' placeholder). The reservation
 *     desk types "Guest" and "Walk in" all day, so one such id can absorb many
 *     unrelated people and show up as the venue's biggest regular. The
 *     importer's own comment measures the exposure: 128 weak-keyed rows in
 *     217,805, resolving to 47 phone-less guests.
 *     THIS USED TO BE LEFT TO ANNOUNCE ITSELF, on the theory that a bucket
 *     reading "Guest — 47th visit" is visibly not a person. It was measured and
 *     it is not: a planted phone-less "Walk in" id holding 47 unrelated
 *     bookings rendered an ordinal of 47, a repeat badge, and the top row of
 *     Repeat only. It read as the venue's biggest regular, not as a bucket.
 *     So the claim is gone instead: identifiedGuestSql() gates it, the row is
 *     MARKED on screen, and unidentified_customers says how many there are. The
 *     rows to inspect are
 *       SELECT * FROM ct_guests WHERE COALESCE(phone10, '') = '';
 *     which is deliberately WIDER than the importer's own phone-less test — it
 *     also catches the guest-autosave rows that have a real phone_e164 and no
 *     phone10, because those are matched no better. See identifiedGuestSql().
 *
 * STILL NOT RE-KEYED, and that is a separate decision. Re-keying identity onto
 * phone10 would change what every other number on this screen means, and it
 * cannot be done naively: 27 of 27 live guests have phone10 NULL, so grouping
 * on phone10 alone would collapse every one of them into a single bucket and
 * invent a 40-visit regular. That is a decision about the guest master, not
 * about this query tab. What this module does is narrower and safer: it refuses
 * to make a per-person claim about an id that cannot support one.
 *
 * There is deliberately no GUEST_IDENTITY constant to swap: every statement
 * below says `guest_id` literally, because a single symbol would advertise that
 * identity is one edit away when in truth it is spread across the row shape,
 * the aggregates and the other screens that must agree with them.
 */

/**
 * THE LIFETIME VISIT COUNT — one row per guest, visits over their WHOLE
 * HISTORY, deliberately ignoring every filter the caller set.
 *
 * THIS IS D2, AND IT IS THE SUBTLE PART OF THE FEATURE. "Repeat customers in
 * July" means bookings in July belonging to guests who have EVER arrived more
 * than once — so a guest who came in June and again in July IS a repeat
 * customer inside a July-only filter. The split is therefore:
 *   · WHO IS A REPEAT CUSTOMER — judged here, unfiltered, whole archive.
 *   · WHICH ROWS AND TOTALS YOU SEE — judged by buildWhere, filtered as asked.
 * Nothing from ReservationFilter may ever leak into this statement; the moment
 * a date bound reaches it, "repeat" silently degrades into "booked twice inside
 * the window", which is a different and much smaller number.
 *
 * DUPLICATES ARE EXCLUDED UNCONDITIONALLY — TRAP 1, and the reason this
 * function takes no duplicates argument at all. The screen's own subtitle
 * promises "Same booking uploaded twice stays one booking", and
 * markDuplicateGroups() (src/lib/reservego.ts) has already decided, per
 * (outlet, phone10, booking_date), which stored row IS the visit. Counting the
 * re-uploaded copy would manufacture a second visit out of one evening and
 * promote a first-timer to a regular — on 3,578 rows of a
 * production-shaped archive, which would inflate every repeat number on the
 * page. So the answer to "how does the repeat count behave under each of the
 * three duplicate modes" is: IDENTICALLY. `duplicates` picks which rows are
 * LISTED; it never changes who is a repeat customer, exactly as it never
 * changes any other aggregate (see buildWhere's forAggregate).
 *
 * The status list is BOUND, not interpolated, like every other value in this
 * module — callers pass LIFETIME_VISITS_PARAMS positionally ahead of their own.
 */
function lifetimeVisitsSql(): string {
  return `SELECT v.guest_id AS guest_id, COUNT(*) AS visits
            FROM ct_bookings v
           WHERE v.status IN (${VISIT_STATUSES.map(() => '?').join(',')})
             AND COALESCE(v.is_duplicate, 0) = 0
           GROUP BY v.guest_id`;
}

/** The bound parameters lifetimeVisitsSql() expects, in order. */
const LIFETIME_VISITS_PARAMS: readonly string[] = VISIT_STATUSES;

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
  /**
   * Everyone / repeat only / first-timers only. Judged over the guest's WHOLE
   * history, never over the filtered window — see repeatGuestIdsSql().
   */
  repeat: RepeatMode;
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
  /**
   * The guest's LIFETIME visit count — "show me my regulars first".
   *
   * `lvs` is the lifetime-visits derived table, which only the id pass joins
   * and only when THIS key is the one chosen (see runReservationQuery). Every
   * other key's statement is textually unchanged, so picking a sort can never
   * make the rest of the page slower. booking_date/slot_time break the tie so
   * that the hundreds of rows sharing a visit count hold a stable order.
   */
  visit_count: (d: string) => `COALESCE(lvs.visits, 0) ${d}, b.booking_date ${d}, b.slot_time ${d}`,
} as const;
export type SortKey = keyof typeof SORTABLE;
const isSortable = (k: string): k is SortKey => Object.prototype.hasOwnProperty.call(SORTABLE, k);
/** Sort keys whose ORDER BY fragment references the `lvs` join. */
const SORT_NEEDS_LIFETIME: ReadonlySet<string> = new Set<SortKey>(['visit_count']);

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

  // REFUSED, not coerced, exactly like status and duplicates above: a typo in
  // `repeat` silently read as "Everyone" would label the whole archive as an
  // answer about repeat customers, and the reader has no way to tell.
  const repeatRaw = asString(raw.repeat, 'repeat') || 'all';
  if (!(REPEAT_MODES as readonly string[]).includes(repeatRaw)) {
    throw new ReservationQueryError(`repeat must be one of ${REPEAT_MODES.join(', ')}`);
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
    repeat: repeatRaw as RepeatMode,
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
  /**
   * True when this night's own start_time could not be read and `matchFrom` is
   * the SLOT TIME THE USER TYPED instead. Not inferrable from matchFrom — a
   * borrowed floor and a real one are the same kind of string — and the notice
   * has to be able to say which nights these were, so it is carried explicitly.
   * A fallback night never subtracts the lead-in, so `clamped` is always false
   * on one: nothing was offset, nothing ran off the front of the day.
   */
  usedFilterTime: boolean;
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
 * ONE LINE, AND THAT IS THE POINT. This used to be a second, hand-kept copy of
 * the write path's parser, and the copies disagreed: reservego.ts read
 * "09:00pm" as 09:00 (a twelve-hour error the WRONG WAY — a 21:00 band's window
 * opening at 07:00 and taking the whole day's lunches with it), while this one
 * REFUSED every meridiem outright to stop that silent widening reaching the
 * Query tab. Refusing was the safe half of the answer and the wrong whole one:
 * a band whose calendar rows all carry a meridiem had every night skipped and
 * became unqueryable, while the write path went on stamping those same nights
 * twelve hours early. Both now read the string the same way, because there is
 * only one reading left. See minutesOfDay() in src/lib/reservego.ts for what is
 * understood, what is refused, and why an out-of-range meridiem hour is not
 * retried as a 24-hour time.
 *
 * The local name is kept so the call site below still reads in this file's own
 * vocabulary, and so the diff that introduced the shared parser is one import
 * plus one line rather than a rename across a module nothing else may touch.
 * (src/lib/hr-attendance.ts has an unrelated private function of this name for
 * HR shift strings — a different function on a different table. Not this one.)
 */
function hhmmToMinutes(t: string): number | null {
  return minutesOfDay(t);
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
 *
 * ── …UNLESS THE CALLER TYPED A TIME OF THEIR OWN ──────────────────────────
 * `filterTimeFrom` is the Slot "from" box on the Query tab (ReservationFilter
 * .timeFrom), already hard-validated to zero-padded 24-hour 'HH:MM' or null —
 * the identical shape as matchFrom, so it drops in with no conversion.
 *
 * THE BAND SAYS WHICH NIGHTS; THE START TIME ONLY SAYS WHERE THE NIGHT STARTS.
 * When a night cannot say that for itself and the caller HAS said it, dropping
 * the night answers a narrower question than the one asked: the act played, the
 * bookings exist, and the only thing missing is a floor the caller has already
 * supplied. So the night is included with the caller's own time as its floor.
 *
 * WHY THIS CANNOT WIDEN, WHICH IS THE WHOLE REASON IT IS ALLOWED. buildWhere()
 * ANDs `b.slot_time >= f.timeFrom` GLOBALLY, outside the band's parenthesised OR
 * chain, so every row this fallback can return was already floored at that time
 * by the caller's own filter. The fallback's real work is emitting the night's
 * OR disjunct at all — a night absent from that chain can never match, whatever
 * the slot filter says. Storing the caller's time as matchFrom rather than
 * '00:00' changes no row; it is stored so the echo can PRINT the floor it
 * actually used and have that be true.
 *
 * NO LEAD-IN IS SUBTRACTED. The lead-in means "this many minutes before the act
 * starts", and on these nights there is no act start — subtracting 120 minutes
 * from a time the caller typed would answer from 17:00 when they said 19:00,
 * silently, which is the same class of lie as the twelve-hour parse. They said
 * what they wanted; it is used as given.
 *
 * `timeFrom` ONLY. `timeTo` alone is not a floor — a night admitted under it
 * would run from 00:00, exactly the silent widening the skip guard exists for,
 * so that case stays a reported skip. `mealPeriod` is not a floor either: its
 * 17:00 would be equally SAFE by the AND argument above, but "Dinner" is a
 * service band, not a time anybody typed, and treating it as consent to include
 * nights whose calendar is broken is a widening nobody asked for.
 *
 * A WRAPPED SLOT FILTER (timeFrom 21:00 → timeTo 02:00, which this venue asks
 * for nightly) makes the global clause an OR, and a per-night `>= 21:00` floor
 * keeps only the late half on a fallback night. That is exactly how a PARSED
 * night already behaves — matchFrom is a plain floor with no wrap awareness —
 * and the 00:00–04:59 rows carry the FOLLOWING calendar date anyway (see
 * MEAL_PERIODS), so they were never on this night's date term. Matching the
 * parsed behaviour is the consistent call and is chosen deliberately.
 *
 * A FALLBACK NIGHT IS NOT A SILENT ONE. It rides back flagged
 * (BandWindow.usedFilterTime) and the page names every one of them beside the
 * skipped list. Substituting a different floor without saying so would be the
 * same failure as the parser bug this fix exists to close.
 *
 * The parameter is REQUIRED, not defaulted: a future caller that forgets it
 * would quietly go back to dropping those nights, and this file's whole
 * discipline is that a filter which stops applying is the bug that makes a
 * number untrustworthy. Pass null explicitly to mean "no time was typed".
 */
export function resolveBandWindow(db: DB, bandId: string, filterTimeFrom: string | null): BandWindows {
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
      // THE CALLER'S OWN SLOT TIME IS THIS NIGHT'S FLOOR, when they set one.
      // See the header: additive at the night level, already floored by the
      // global timeFrom clause, no lead-in subtracted, and flagged so the page
      // can say which nights these were. Without a typed time it stays a skip.
      if (filterTimeFrom) {
        windows.push({
          calendarId,
          eventDate,
          type: String(n.type || ''),
          startTime,
          endTime: String(n.end_time || ''),
          matchFrom: filterTimeFrom,
          clamped: false,
          usedFilterTime: true,
        });
        continue;
      }
      skipped.push({
        calendar_id: calendarId,
        event_date: eventDate,
        start_time: startTime,
        // "a Slot time" named a control that is TWO boxes — the Slot label sits
        // over a from/to pair — and only the FROM box reaches here (see the
        // header: timeTo alone is not a floor). A reader who typed into the
        // second box got this identical line back with nothing changed and no
        // way to tell why, so the box is named exactly.
        reason: `start time ${JSON.stringify(startTime)} is not readable — set it as HH:mm to include this night, or set the first Slot time (the "from" box) to count it from that instead`,
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
      usedFilterTime: false,
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

  // ── THE REPEAT DIMENSION, LAST ON PURPOSE ───────────────────────────────────
  // At the default 'all' this block pushes NOTHING — no clause, no parameter —
  // so the statement is character-for-character the one that ran before this
  // feature existed and every number on the screen is unchanged. That is the
  // regression that matters, and it is guaranteed structurally here rather than
  // by testing it afterwards. It is also appended AFTER the band clause so that
  // no existing clause's parameter position moves even when it does fire.
  //
  // WHO is a repeat customer comes from lifetimeVisitsSql() — the whole
  // archive, every filter above deliberately absent (D2). WHICH rows you see is
  // every clause above. The two are composed here and nowhere else.
  //
  // IN / NOT IN AGAINST THE SAME ID LIST, which is what makes the two modes an
  // exact partition of the IDENTIFIED guests: every such booking's guest either
  // appears in that list or does not. Written as two independent tests (say, a
  // `visits >= 2` join versus a `visits < 2` join) a guest with no lifetime row
  // would fall through BOTH, since a LEFT JOIN miss satisfies neither
  // comparison — and that booking would then be in neither answer and silently
  // missing from the screen.
  //
  // `AND guest_id IS NOT NULL` is belt-and-braces: ct_bookings.guest_id is
  // declared NOT NULL so the list cannot contain one, but a single NULL inside a
  // NOT IN list makes the whole predicate UNKNOWN and would return an EMPTY
  // first-timers page — a silent-empty failure, the worst kind on a counting
  // screen. One cheap, always-true condition buys immunity from it.
  //
  // THE IDENTITY CLAUSE IS ON BOTH MODES, NOT ONE. Putting it on 'repeat' alone
  // would have been the tidy-looking half-fix: the 47-booking "Walk in" bucket
  // stops being called a regular and silently becomes a FIRST-TIMER instead,
  // which is the same false claim about a person with the sign flipped. Both
  // modes therefore answer only about guests the archive can name, and the rows
  // it cannot name are reported as their own bucket — see REPEAT_MODES and
  // identifiedGuestSql(). Appended AFTER the lifetime clause so that clause's
  // parameter positions do not move.
  if (f.repeat !== 'all') {
    where.push(
      `b.guest_id ${f.repeat === 'repeat' ? 'IN' : 'NOT IN'} (`
      + `SELECT guest_id FROM (${lifetimeVisitsSql()}) WHERE visits >= ? AND guest_id IS NOT NULL)`,
    );
    params.push(...LIFETIME_VISITS_PARAMS, REPEAT_VISIT_THRESHOLD);
    where.push(identifiedByGuestIdSql('b.guest_id'));
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

  /**
   * DISTINCT CUSTOMERS IN THE FILTERED SET — and THE DENOMINATOR OF
   * repeat_rate. It ships for exactly that reason: a rate whose denominator is
   * unclear is worse than no rate, so the screen never has to guess and can
   * label the card in full — "412 of 3,106 customers came back".
   *
   * Counted as COUNT(DISTINCT b.guest_id) over the same rows `bookings`
   * counts, so it is "customers with a booking matching this filter",
   * INCLUDING customers whose every booking was cancelled. Those people are
   * real customers of the filtered window and dropping them would quietly
   * inflate the rate.
   */
  customers: number;
  /**
   * Of those, the ones the archive can actually NAME — a phone number on file
   * (identifiedGuestSql). THE DENOMINATOR OF repeat_rate, and the reason it
   * ships as its own figure rather than being left for the page to subtract:
   * the card has to print the number it divided by, and a denominator the page
   * computed is a denominator that can disagree with the numerator.
   */
  identified_customers: number;
  /**
   * customers − identified_customers: matching guests with NO phone number on
   * file, so the archive cannot tell one person's visits from another's and
   * their re-uploaded bookings were never collapsed.
   *
   * ON SCREEN, NOT SWALLOWED. These people are real customers of the filtered
   * window — they are counted in `customers` — but no per-person claim is made
   * about them, so the screen owes the reader the size of the gap. It is what
   * makes customers = identified + unidentified check out by eye, and it is how
   * the owner learns "roughly how many" rows are affected without running a
   * query. Usually small (the importer measures 47 such guests in production);
   * if it is ever large, that is the most important number on the screen.
   */
  unidentified_customers: number;
  /**
   * IDENTIFIED distinct customers in the filtered set who have EVER arrived
   * more than once — lifetime, whole archive, regardless of the date filter
   * (D2).
   *
   * So in a July-only filter this counts guests with a July booking who are
   * repeat customers overall, NOT guests who came twice during July.
   *
   * IDENTIFIED ONLY, and that bound is the F1 fix rather than a nicety. A
   * phone-less guest id is a merged bucket whose re-uploads never collapse, so
   * including one would be counting "a person who came back" where there is
   * neither one person nor a reliable count — measured, one such id contributed
   * 47 visits. They are in `unidentified_customers` instead.
   */
  repeat_customers: number;
  /**
   * repeat_customers / identified_customers as a 0–100 percentage, null when
   * the filter matched no identifiable customer at all.
   *
   * THE DENOMINATOR IS THE IDENTIFIED COUNT, NOT `customers`, because both
   * halves of a rate have to be answering the same question. Dividing a
   * repeat count that excludes unidentified guests by a total that includes
   * them would quietly understate the rate by however many of them there are,
   * and the card would be printing a denominator it did not use. The card
   * states this one on its face.
   *
   * SHARE OF PEOPLE, NOT OF BOOKINGS. Both halves are distinct-guest counts, so
   * a regular with eleven bookings in the window moves this number exactly as
   * much as a regular with one. The bookings-weighted version is a different
   * and much larger figure; this is the one that answers "how much of my custom
   * is repeat custom".
   */
  repeat_rate: number | null;
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

  /**
   * 1 when the archive can NAME this guest — a phone number on file — and 0
   * when it cannot. identifiedGuestSql() is the rule; see it for why that is
   * phone10 and not phone_e164.
   *
   * SHIPPED SO THE PAGE DOES NOT RE-DERIVE IT. `guest_phone10` is already on
   * the row, so a client could test it and get the same answer today — and
   * would silently stop agreeing with the cards the first time the server's
   * rule moved. One flag, decided once, in the same statement that decides
   * visit_number.
   *
   * It is a COLUMN of the results grid, not just a hint for the visit cells,
   * because the owner has to be able to see WHICH rows are affected from the
   * screen alone, and it rides the CSV export for the same reason.
   */
  guest_identified: number;
  /**
   * The guest's LIFETIME visit count across the whole archive, ignoring the
   * filter (D2). 0 for a guest who has booked but never turned up, and for an
   * orphan guest_id.
   *
   * WHAT IT COUNTS DEPENDS ON guest_identified, and the page labels it
   * accordingly rather than printing one word over two different things:
   *   · identified → how many times THIS PERSON has arrived.
   *   · not identified → how many arrival-status bookings sit in a bucket that
   *     may hold many unrelated people, and whose re-uploads were never
   *     collapsed. A count of rows, not of visits by anyone.
   * The NUMBER is kept either way. Blanking it would have hidden the 47-booking
   * bucket that makes this worth saying, and the owner cannot act on a figure he
   * cannot see; what is withdrawn is the claim about a person, not the data.
   *
   * `guest_identified = 1 AND visit_count >= REPEAT_VISIT_THRESHOLD` is exactly
   * the test the repeat filter and the repeat cards apply, so the row list can
   * always be checked against the cards by eye — the screen never has to
   * re-derive the rule.
   */
  visit_count: number;
  /**
   * WHICH VISIT THIS BOOKING WAS for that guest — 4 means "their 4th visit",
   * counted chronologically over their whole history.
   *
   * NULL WHEN THIS BOOKING IS NOT A VISIT, and that is the deliberate choice
   * the brief asks to be documented. A cancelled, no-show, pending or confirmed
   * booking never happened as a visit, so it has no ordinal, and a duplicate
   * row is the same evening uploaded twice and must not claim an ordinal of its
   * own. Printing 0, or carrying the previous visit's number forward, would put
   * a number in that column that reads as a fact and is not one; the page shows
   * a dash. The honest ordinal is therefore null for ~44% of the archive
   * (the cancelled rows), which is a true statement about this venue's data.
   *
   * ALSO NULL WHEN guest_identified IS 0, which is the F1 fix in one column. An
   * ordinal is the most personal claim on the whole screen — "this was their
   * 47th visit" names a human and counts their evenings — and on a phone-less
   * bucket both halves are wrong: it is not one human, and the count includes
   * re-uploads that were never collapsed. MEASURED before this bound existed: a
   * planted "Walk in" id printed "47th visit" with a repeat badge. There is no
   * honest ordinal to print for such a row, so none is sent.
   *
   * The counting rule is "visits at or before this one", so for a row that IS a
   * visit by an identified guest this is always between 1 and visit_count
   * inclusive.
   */
  visit_number: number | null;
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
    /**
     * True when at least one night could not read its own start time and was
     * counted from the Slot time the caller typed instead. The page MUST say so:
     * without it those nights read as ordinary ones and the answer quietly
     * describes a floor nobody was told about.
     */
    filter_time_used: boolean;
    /** The floor those nights actually used, '' when none did. Read back out of
     *  the resolved windows, not off the filter, so it cannot disagree with the
     *  SQL that produced the rows. */
    filter_time: string;
    nights: Array<{
      calendar_id: string;
      event_date: string;
      type: string;
      start_time: string;
      end_time: string;
      match_from: string;
      lead_in_clamped: boolean;
      /** True when match_from is the caller's Slot time, not this night's own. */
      used_filter_time: boolean;
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
  // f.timeFrom rides along so a night whose calendar start time is unreadable
  // can still be counted from the Slot time the caller typed — see
  // resolveBandWindow(). Passed here and only here, so the rows pass, the
  // aggregate pass and the duplicate pass all describe the same nights.
  const band = f.liveBandId ? resolveBandWindow(db, f.liveBandId, f.timeFrom) : null;

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

    // ── THE TWO REPEAT CARDS, IN THEIR OWN PASS ──────────────────────────────
    // A SEPARATE STATEMENT ON PURPOSE, for two reasons.
    //
    // 1. THE NINE EXISTING NUMBERS KEEP THEIR OWN SQL, character for character.
    //    Folding these two cards into the statement above would have made every
    //    pre-existing number on the screen the output of a statement this
    //    feature edited. Left alone, "the default must not change" stops being
    //    a thing to test and becomes a thing you can read.
    //
    // 2. IT IS THE FASTER SHAPE, because the two grains are different: the
    //    sums above are per BOOKING, these two are per CUSTOMER. Reducing to
    //    DISTINCT guests FIRST and then testing each one is strictly less work
    //    than carrying a join through all the booking rows and distinct-ing
    //    twice at the end. MEASURED on the production-shaped archive
    //    (99,405 live bookings / 84,173 guests, warm cache, median of 7):
    //      one combined statement, LEFT JOIN + 2x COUNT(DISTINCT) … 114ms
    //      DISTINCT-first, joining the lifetime derived table    …  82ms
    //      DISTINCT-first + EXISTS, this one                     …  63ms
    //    and on a July-only filter 55ms / 58ms / 23ms. All three forms were
    //    verified to return IDENTICAL customers and repeat_customers on the
    //    whole archive, on Fri+Sat and on July before this one was chosen.
    //
    // WHY `EXISTS … LIMIT 1 OFFSET ?` AND NOT `COUNT(*) >= 2`. The question is
    // not "how many times did they come" but "did they come more than once",
    // so the probe can stop at the second row instead of counting all 43 of a
    // regular's bookings. It reads as the threshold it implements: skip
    // THRESHOLD-1 rows and ask whether anything is left. The planner uses
    // idx_ct_bookings_guest for it (SEARCH v USING INDEX idx_ct_bookings_guest)
    // — NO new index is needed for this feature, measured, and none was added.
    //
    // This also means the cost scales with the FILTERED customer count, not the
    // size of the archive, which is the right way round: the owner's narrow
    // questions stay cheap as the archive grows.
    //
    // `COUNT(*)` over the already-DISTINCT subquery is `customers`, so the
    // denominator and the numerator come from one pass and cannot disagree.
    //
    // ALL THREE COUNTS COME OUT OF THIS ONE STATEMENT, including the identity
    // split, and that is the point: customers, identified and repeat are then
    // three sums over ONE list of distinct guests, so customers = identified +
    // unidentified is true by construction rather than by two queries agreeing.
    // The identity probe is another primary-key seek per distinct guest and
    // carries no bound parameter, so the parameter order below is unchanged.
    const rep = db.prepare(`
      SELECT COUNT(*) AS customers,
             SUM(CASE WHEN ${identifiedByGuestIdSql('dg.guest_id')} THEN 1 ELSE 0 END)
               AS identified_customers,
             SUM(CASE WHEN ${identifiedByGuestIdSql('dg.guest_id')} AND EXISTS (
                   SELECT 1 FROM ct_bookings v
                    WHERE v.guest_id = dg.guest_id
                      AND v.status IN (${VISIT_STATUSES.map(() => '?').join(',')})
                      AND COALESCE(v.is_duplicate, 0) = 0
                    LIMIT 1 OFFSET ?
                 ) THEN 1 ELSE 0 END) AS repeat_customers
        FROM (SELECT DISTINCT b.guest_id FROM ct_bookings b ${aggWhere.sql}) dg
    `).get(
      // Positional: the correlated subquery appears before the FROM in the text.
      ...LIFETIME_VISITS_PARAMS, REPEAT_VISIT_THRESHOLD - 1, ...aggWhere.params,
    ) as Record<string, number | null>;

    const bookings = Number(agg?.bookings ?? 0);
    const billed = Number(agg?.billed_bookings ?? 0);
    const spend = Number(agg?.total_spend ?? 0);
    const arrived = Number(agg?.arrived ?? 0);
    const customers = Number(rep?.customers ?? 0);
    // Clamped into [0, customers] before it is subtracted: `identified` is a
    // SUM over the same list `customers` counted so it cannot legitimately
    // exceed it, but an unidentified count that came out NEGATIVE would be
    // printed on the card as a fact, and a card is the wrong place to discover
    // an arithmetic slip.
    const identified = Math.min(customers, Math.max(0, Number(rep?.identified_customers ?? 0)));
    const repeatCustomers = Number(rep?.repeat_customers ?? 0);
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
      customers,
      identified_customers: identified,
      unidentified_customers: customers - identified,
      repeat_customers: repeatCustomers,
      // Over the IDENTIFIED count, which is what repeat_customers was counted
      // out of — see the field's own comment. Rounded to one decimal, the same
      // way arrival_rate is, so the two percentages on the screen agree on
      // precision.
      repeat_rate: identified > 0 ? Math.round((repeatCustomers / identified) * 1000) / 10 : null,
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
    // The lifetime join is added ONLY when the chosen sort key's ORDER BY
    // fragment actually references `lvs`. Every other sort — which is every
    // sort the page opens on — prepares the identical statement it did before
    // this feature, so choosing "newest first" can never pay for a join it does
    // not use. SORT_NEEDS_LIFETIME is the single list that decides, so a future
    // sort key that reaches for `lvs` without being added to it fails loudly on
    // "no such column" rather than quietly sorting by something else.
    const needsLifetime = SORT_NEEDS_LIFETIME.has(f.sort);
    const lifetimeJoin = needsLifetime
      ? `LEFT JOIN (${lifetimeVisitsSql()}) lvs ON lvs.guest_id = b.guest_id`
      : '';
    const ids = (db.prepare(`
      SELECT b.id FROM ct_bookings b ${lifetimeJoin} ${rowsWhere.sql}
      ORDER BY ${SORTABLE[f.sort](d)}, b.id ${d}
      LIMIT ? OFFSET ?
    `).all(
      ...(needsLifetime ? LIFETIME_VISITS_PARAMS : []),
      ...rowsWhere.params, f.limit, f.offset,
    ) as Array<{ id: string }>).map((r) => String(r.id));
    if (!ids.length) return { rows: [] as ReservationQueryRow[], total, duplicateTotal, aggregates };

    // ── THE PER-ROW VISIT NUMBERS, AND WHY THEY ARE NOT AN N+1 ───────────────
    // Both are correlated subqueries, which is normally the thing to avoid on a
    // 99,386-row table — but they are evaluated HERE, in the hydrate pass,
    // against the ids of ONE PAGE only. The work is therefore bounded by
    // MAX_LIMIT (200) regardless of how big the filter's result set is, and each
    // probe is an index seek on idx_ct_bookings_guest over one guest's handful
    // of bookings. Putting them in the id pass instead would have computed them
    // for every matching row and thrown all but a page away.
    //
    // THE CHRONOLOGICAL KEY IS A STRING COMPARE, deliberately. The ordinal is
    // "visits at or before this one", so it needs a total order over a guest's
    // visits: night, then slot, then id as the final tiebreak so two bookings
    // identical on both still get distinct ordinals and the same ones on every
    // run. Lexicographic ordering is chronological here because the night is
    // 'YYYY-MM-DD' and slot_time is zero-padded 'HH:MM' (stampTime, measured: 0
    // rows malformed in the archive). A row with a blank slot_time sorts to the
    // front of its own night — '#' < '0' — which is deterministic, and the id
    // tiebreak keeps the order total even if a date were malformed.
    //
    // visit_number is NULL for a row that is not a visit; see the field's own
    // comment on ReservationQueryRow for why that is a dash and not a 0.
    const visitPredicate = (t: string) =>
      `${t}.status IN (${VISIT_STATUSES.map(() => '?').join(',')}) AND COALESCE(${t}.is_duplicate, 0) = 0`;
    const visitOrderKey = (t: string) =>
      `(COALESCE(NULLIF(${t}.reserved_date, ''), ${t}.booking_date) || 'T'`
      + ` || COALESCE(${t}.slot_time, '') || '#' || ${t}.id)`;
    const hydrated = db.prepare(`
      SELECT b.id, b.guest_id, b.booking_date, b.slot_time, b.reserved_time, b.booking_time,
             b.party_size, b.status, b.reservego_status, b.arrived, b.is_duplicate,
             b.bill_amount, b.bill_number, b.source, b.booking_type, b.outlet_name,
             b.sections, b.tables_csv,
             COALESCE(b.dow, CAST(strftime('%w', COALESCE(NULLIF(b.reserved_date, ''), b.booking_date)) AS INTEGER)) AS dow,
             g.name AS guest_name, g.phone_e164 AS guest_phone, g.phone10 AS guest_phone10,
             -- Off the join that is already here, so the flag costs nothing and
             -- cannot disagree with the guest_phone10 printed beside it.
             CASE WHEN ${identifiedGuestSql('g')} THEN 1 ELSE 0 END AS guest_identified,
             (SELECT COUNT(*) FROM ct_bookings v
               WHERE v.guest_id = b.guest_id AND ${visitPredicate('v')}) AS visit_count,
             -- The identity test is ANDed into the ordinal's own CASE rather
             -- than applied by the page: an ordinal that exists in the payload
             -- and is suppressed in the markup is one render away from being
             -- printed again, and it would still go out in the CSV.
             CASE WHEN ${visitPredicate('b')} AND ${identifiedGuestSql('g')}
               THEN (SELECT COUNT(*) FROM ct_bookings v2
                      WHERE v2.guest_id = b.guest_id AND ${visitPredicate('v2')}
                        AND ${visitOrderKey('v2')} <= ${visitOrderKey('b')})
               ELSE NULL END AS visit_number
        FROM ct_bookings b
        LEFT JOIN ct_guests g ON g.id = b.guest_id
       WHERE b.id IN (${ids.map(() => '?').join(',')})
    `).all(
      // Positional, in the order the placeholders appear in the text above:
      // visit_count's statuses, the CASE's own test, then the inner ordinal.
      ...LIFETIME_VISITS_PARAMS, ...LIFETIME_VISITS_PARAMS, ...LIFETIME_VISITS_PARAMS,
      ...ids,
    ) as ReservationQueryRow[];

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
  // THE BORROWED-FLOOR NIGHTS, read back off the windows that produced the SQL
  // rather than off f.timeFrom. Same reason `dates` is derived here: the echo
  // must describe what the query DID, and a value taken from the filter would
  // still print '19:00' on a run where no night actually needed it. Every
  // fallback window carries the same matchFrom (they all borrow the one typed
  // time), so the first is the floor they all used.
  const borrowed = band ? band.windows.filter((w) => w.usedFilterTime) : [];

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
        filter_time_used: borrowed.length > 0,
        filter_time: borrowed[0]?.matchFrom ?? '',
        nights: band.windows.map((w) => ({
          calendar_id: w.calendarId,
          event_date: w.eventDate,
          type: w.type,
          start_time: w.startTime,
          end_time: w.endTime,
          match_from: w.matchFrom,
          lead_in_clamped: w.clamped,
          used_filter_time: w.usedFilterTime,
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
    // DERIVED, NOT STORED — and the panel says so, because "where does that
    // number come from" is the question this panel exists to answer and
    // ct_bookings has no visit-count column to point at. reservego_visit_count
    // IS a stored column, but it is Reservego's own figure for its own
    // definition; these two are computed here from status.
    {
      table: 'ct_bookings', column: 'status → visit count (derived)', type: 'number',
      label: 'Repeat customer / visit count', filter: 'repeat',
      note: `A visit is a booking whose status is ${VISIT_STATUSES.join(' or ')} — the guest arrived. `
        + `A repeat customer has ${REPEAT_VISIT_THRESHOLD} or more visits over their WHOLE history, `
        + 'counted per guest and never counting the same booking twice. '
        + 'The date filter chooses which bookings you see; it never changes who counts as a repeat customer, '
        + 'so a guest who came in June and again in July is a repeat customer inside a July-only filter.',
    },
    {
      table: 'ct_bookings', column: 'guest_id', type: 'text', label: 'Customer identity',
      note: 'How bookings are grouped into one customer. The importer resolves a guest by the last 10 digits '
        + 'of the mobile number first, so one number is one customer; a customer created without a stored '
        + '10-digit number can still split across two records, which understates repeat customers.',
    },
    { table: 'ct_guests', column: 'name', type: 'text', label: 'Guest name' },
    { table: 'ct_guests', column: 'phone_e164', type: 'text', label: 'Guest phone' },
    { table: 'ct_guests', column: 'phone10', type: 'text', label: 'Guest phone (10-digit)', note: 'The identity key, and the limit on every per-person figure here. Blank means the archive cannot tell this guest apart from another, and that the importer never collapsed their re-uploaded bookings — those rows are marked Not identified and are left out of the repeat count.' },
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
  /**
   * The three values of the repeat control, with the labels the owner asked
   * for. Shipped as data rather than hard-coded in the page so the wire value
   * and the words beside it can never drift apart — the page renders
   * `label`, sends `value`, and parseReservationFilter refuses anything else.
   */
  repeat_modes: Array<{ value: RepeatMode; label: string; help: string }>;
  /** What makes a visit and what makes a repeat customer, for the control's caption. */
  repeat_definition: {
    visit_statuses: readonly string[];
    threshold: number;
    /**
     * WHAT THE ARCHIVE IDENTIFIES A GUEST BY, in the owner's words, so the
     * sentence on screen cannot describe a rule the engine is not using. The
     * page prints it inside the one-line approximation notice beside the cards;
     * if this ever becomes something other than a phone number, that notice
     * changes with it instead of going stale.
     */
    identity_basis: string;
    /**
     * WHAT RE-UPLOADS ARE GROUPED BY — the day the booking was MADE, which is
     * the F2/F3 limit in four words. markDuplicateGroups() keys on
     * (outlet, phone10, booking_date) and booking_date is the creation day, not
     * the night; the repo measures the two columns disagreeing on 23,407 of
     * 83,658 rows. Shipped for the same reason as identity_basis: the
     * disclosure is a quote, not a guess.
     */
    duplicate_grouping: string;
  };
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
    // No query behind these — they are the vocabulary, not data — but they ride
    // the options call so the control is built from the same constants the
    // filter validates against.
    // Both non-default modes say "with a phone number on file" out loud. The
    // chips used to promise a clean two-way split of every customer, which is a
    // promise the archive cannot keep — see REPEAT_MODES.
    repeat_modes: [
      {
        value: 'all', label: 'Everyone',
        help: 'No repeat filter — every customer, including the ones with no phone number on file.',
      },
      {
        value: 'repeat', label: 'Repeat only',
        help: `Customers with a phone number on file who have arrived ${REPEAT_VISIT_THRESHOLD} or more times, ever.`,
      },
      {
        value: 'first', label: 'First-timers only',
        help: 'Customers with a phone number on file who have arrived at most once, ever — including those who have never arrived.',
      },
    ],
    repeat_definition: {
      visit_statuses: VISIT_STATUSES,
      threshold: REPEAT_VISIT_THRESHOLD,
      identity_basis: 'phone number',
      duplicate_grouping: 'the day the booking was made',
    },
  };
}
