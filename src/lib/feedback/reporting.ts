/**
 * Guest Feedback — PAGE 4's COMPUTATION.  (P5 Lane B)
 *
 * SELECT-ONLY, like every other file under `src/lib/feedback/`. There is no
 * INSERT, UPDATE or DELETE in here and there must never be one: Page 4 is a
 * management read over data the GRE wrote, and the module's whole promise is
 * that it never mutates the POS.
 *
 * ── WHY SCREEN AND DOWNLOADS SHARE ONE FILE ─────────────────────────────────
 * The eight exports and the eight sections of the page are computed by the SAME
 * functions. A number that appears on a PDF must have come from the function
 * the screen called, or the first time the two disagree nobody will be able to
 * say which one is the restaurant's actual coverage. `analytics()` produces the
 * whole dashboard; `buildReport()` slices that same object into rows. The only
 * thing the export layer adds is formatting.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 1. THE DATE BUCKETS ARE IST BUSINESS DAYS, AND THEY MATCH PAGE 1
 * ════════════════════════════════════════════════════════════════════════════
 * THE DATABASE IS UTC. `orders.created_at` is `datetime('now')` →
 * `'2026-09-23 19:05:14'`, UTC, space-separated, no zone. The restaurant runs
 * on IST (+5:30). This module has already been bitten by that once: `elapsed()`
 * rendered a table opened ten minutes ago as "5h 40m" because V8 parses the
 * space form as LOCAL time.
 *
 * So "Today" here does NOT mean `date('now')`, and it does not mean the IST
 * calendar day either. It means the **business day**, the same one Page 1's
 * board rolls over on: `feedbackBoardCutoff()` -> `hr_day_cutoff` honoured ONLY
 * as a night rollover (00:00-07:59), otherwise 04:00. That is the convention
 * HRMS and `stale-tables.ts` already use, and it is the only choice that makes
 * the two pages agree - a dinner service that runs past midnight is ONE night's
 * work, and a complaint recorded at 01:30 IST belongs to the evening the guest
 * was actually sitting there, not to the next morning's report.
 *
 * THE WINDOW IS COMPUTED, NOT SCANNED. `businessDateOf(atUtc, cutoff)` is
 * `UTC-date(ms + 330min - cutoffMin)`, which inverts exactly: business day D is
 * the half-open UTC interval
 *     [ D*00:00Z - (330 - cutoff)min , +24h )
 * `businessDayWindowUtc()` returns those two bounds as the storage shape, so
 * every query filters with `created_at >= ? AND created_at < ?` and rides
 * `idx_gf_visits_created`. No per-row date arithmetic, no `date(created_at)`
 * wrapped around an indexed column, and no 330-minute lie.
 *
 * Week = Monday to Sunday of the current business day. Month = the calendar
 * month of the current business day. Both are stated on screen so nobody has to
 * guess whether "This Week" started on Sunday.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 2. WHICH TIMESTAMP EACH THING IS ANCHORED ON
 * ════════════════════════════════════════════════════════════════════════════
 *   - An ORDER belongs to the business day of `orders.created_at` - the night
 *     the guests sat down. An order opened 23:40 and settled 01:10 is one
 *     night's table, counted once, on the night it opened.
 *   - A VISIT and an ITEM FEEDBACK belong to the day of the ORDER they are
 *     about, not the day they were typed. They are always the same night in
 *     practice, and anchoring them to the order is what keeps the coverage
 *     numerator a strict subset of its denominator.
 *   - A FOLLOW-UP belongs to the day of the complaint that created it, even
 *     when it is closed the following morning. "Guest Happy After Replacement"
 *     for Tuesday means the Tuesday guests who ended up happy.
 *   - `open_follow_ups_now` is the ONE figure that is deliberately NOT range
 *     bound: an unresolved complaint from last week is still unresolved today,
 *     and a manager filtering to "Today" must not be told there are none.
 *     It is labelled "open now (all dates)" everywhere it appears.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 3. THE TWO RATES THE OWNER NAMED, AND THEIR DENOMINATORS
 * ════════════════════════════════════════════════════════════════════════════
 * His words: *"This is important because total complaints alone can be
 * misleading."* A dish sold 500 times with 7 complaints is not the dish sold 12
 * times with 5, and a count alone cannot tell them apart.
 *
 *   - **Negative Feedback %** = negative feedbacks / feedbacks RECEIVED for
 *     that item. Both sides are counts of feedback rows, so the units match. A
 *     QUALITY measure: of the guests who were asked about this dish, what share
 *     disliked it. Using quantity sold as the denominator here would reward a
 *     dish nobody was asked about and punish a popular one.
 *   - **Return / Remake Rate** = plates returned+remade / plates SOLD. Both
 *     sides are quantities, so the units match here too - the numerator sums
 *     `gf_item_feedback.quantity`, NOT a row count, because one feedback row
 *     can cover a line of three. An OPERATIONS measure: of the plates that left
 *     the kitchen, what share came back.
 *
 * Two different denominators on purpose, and both printed next to their counts.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 4. THE FAIRNESS RULING IS ENFORCED HERE, NOT JUST DOCUMENTED
 * ════════════════════════════════════════════════════════════════════════════
 * Owner, verbatim: *"The system should NOT judge GRE performance based on
 * positive feedback. A GRE should never avoid recording negative feedback
 * because it affects their performance."*
 *
 * `grePerformance()` below returns Tables Visited, Follow-Ups Completed,
 * Follow-Ups Open, Issues Recorded and Recovery Follow-Up % - and it is
 * physically incapable of returning a rating, because it never reads
 * `overall_rating`, never scores `is_negative`, and never credits a happiness
 * column to the recorder. `ISSUES_RECORDED_IS_NOT_A_PENALTY` says so in a
 * string that ships to the screen and into every export, so the next person to
 * add a column to that table reads the rule before they do it.
 *
 * AND THE DENOMINATOR NOBODY HAS: there is no column anywhere that assigns a
 * table to a GRE. Coverage per GRE therefore has no honest denominator, and
 * inventing one - dividing by the venue's eligible tables, say - would make
 * every GRE look bad on a busy night and reward whoever clocked in alone. The
 * per-person table reports COUNTS and a recovery rate; venue coverage is shown
 * beside it as context, labelled as venue-wide. `COVERAGE_PER_GRE_UNAVAILABLE`
 * carries the reason to the screen.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 5. THE MENU-ITEM JOIN KEY IS THE NAME, AND THAT IS A MEASURED DECISION
 * ════════════════════════════════════════════════════════════════════════════
 * The obvious key is `menu_item_id`. It does not work. Measured on the working
 * snapshot 2026-09-23:
 *
 *     SELECT COUNT(*), SUM(COALESCE(menu_item_id,'')='') FROM order_items;
 *     ->  104 | 72
 *
 * **69% of order lines carry a BLANK `menu_item_id`.** Keying on it would split
 * one dish into two rows - "Chicken Tikka" with an id and "Chicken Tikka"
 * without - and the Negative % of each half would be computed against half a
 * denominator. `item_name` is populated on 100% of lines on both sides
 * (`gf_item_feedback.item_name` is a snapshot of `order_items.name`), so the
 * key is `LOWER(TRIM(name))`. `menu_item_id` is carried along for whoever needs
 * to click through to the menu master, taking the first non-blank value.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 6. WHAT EACH FILTER ACTUALLY FILTERS - they are not all the same rail
 * ════════════════════════════════════════════════════════════════════════════
 *   - **Floor / Section / Captain** narrow the ORDER universe, so they move the
 *     coverage denominator as well as the numerator. Asking about the Rooftop
 *     means asking about the Rooftop's tables AND the Rooftop's visits.
 *   - **GRE / Manager** narrow the VISITS ONLY. If they narrowed the orders
 *     too, the denominator would collapse to "tables this person visited" and
 *     coverage would read 100% for everybody, always. Filtered to a person,
 *     "coverage" is *their* share of the scope's eligible tables and the screen
 *     says so.
 *   - **Food/Drinks / Menu Item** narrow the ITEM-LEVEL rows only. They do not
 *     touch coverage at all: a table was still visited whether or not the guest
 *     mentioned a drink.
 *
 * FLOOR IS `restaurant_tables.zone` - there is no `floor` column and
 * `SELECT floor` errors. SECTION is `restaurant_tables.section`, and the owner
 * supplied the production census on 2026-09-23: 7 sections across 3 floors
 * (First Floor FA/FB/FBR, Second Floor SA/SB/SO, Terrace TC, 292 tables). The
 * working snapshot has 15 tables and NOT ONE populated section, so the section
 * filter is built to appear only when the data has sections and to say "no
 * sections defined" when it does not - a dropdown that returns nothing is worse
 * than no dropdown. Neither list is ever hard-coded: both are derived from the
 * rows in scope, every time.
 */

import type Database from 'better-sqlite3';
import {
  ACTIONS_TAKEN,
  CATEGORIES,
  ITEM_ISSUES,
  OVERALL_RATINGS,
  type ActionTaken,
  type ItemGroup,
} from '@/lib/feedback';
import {
  feedbackBoardCutoff,
  floorLabel,
  readTunables,
  sqlUtcToIso,
  type BoardDay,
} from './read';

/* ════════════════════════════════════════════════════════════════════════════
   1. TIME - IST business days, as exact UTC windows
   ════════════════════════════════════════════════════════════════════════════ */

/** IST = UTC + 5:30. The same +330 convention as `hr-attendance.ts:58`. */
const IST_OFFSET_MIN = 330;
const DAY_MS = 86_400_000;

/** 'HH:MM' -> minutes past midnight. The cutoff has already been validated by
 *  `feedbackBoardCutoff()`; this is the arithmetic, not a second gate. */
function cutoffMinutes(hhmm: string): number {
  const m = String(hhmm ?? '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 4 * 60;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/** The storage shape every timestamp column in this database is written in. */
function utcStamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** 'YYYY-MM-DD' -> epoch ms of that date at 00:00:00 UTC. */
function ymdToUtcMs(ymd: string): number {
  return Date.parse(`${ymd}T00:00:00Z`);
}

function utcMsToYmd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export interface DayWindow {
  /** Inclusive lower bound, storage shape, UTC. */
  startUtc: string;
  /** EXCLUSIVE upper bound. */
  endUtc: string;
}

/**
 * The half-open UTC interval covering business days `fromDate`..`toDate`
 * inclusive, under `cutoff`.
 *
 * This is the exact inverse of `businessDateOf()`: that function shifts a UTC
 * instant by `(330 - cutoff)` minutes and takes the UTC date, so the instants
 * whose shifted date is D are exactly
 *     [ D*00:00Z - (330 - cutoff)min , that + 24h )
 * The P5 evidence feeds every boundary instant back through `businessDateOf()`
 * and checks it lands on the expected day.
 */
export function businessDayWindowUtc(fromDate: string, toDate: string, cutoff: string): DayWindow {
  const shift = (IST_OFFSET_MIN - cutoffMinutes(cutoff)) * 60_000;
  const startMs = ymdToUtcMs(fromDate) - shift;
  const endMs = ymdToUtcMs(toDate) + DAY_MS - shift;
  return { startUtc: utcStamp(startMs), endUtc: utcStamp(endMs) };
}

/** Business day of a stored UTC stamp, computed the same way - used to bucket
 *  rows into days for the Daily/Weekly/Monthly breakdowns without a second
 *  query per day. Returns '' for a value that cannot be dated. */
export function businessDayOfStamp(raw: unknown, cutoff: string): string {
  const iso = sqlUtcToIso(raw);
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return utcMsToYmd(ms + (IST_OFFSET_MIN - cutoffMinutes(cutoff)) * 60_000);
}

export type RangeKey = 'today' | 'yesterday' | 'week' | 'month' | 'custom';

export interface ResolvedRange {
  key: RangeKey;
  /** First business day in the range, 'YYYY-MM-DD'. */
  fromDate: string;
  /** Last business day, inclusive. */
  toDate: string;
  window: DayWindow;
  /** 'HH:MM' rollover actually applied, and where it came from. */
  cutoff: string;
  cutoffSource: BoardDay['source'];
  /** The business day "now" falls in - the anchor every relative range is off. */
  businessDate: string;
  /** Human sentence, printed on screen AND written into every export. */
  label: string;
  /** Set when a custom range was asked for and could not be used as given. */
  note: string;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Monday of the ISO week containing `ymd`. */
function weekStart(ymd: string): string {
  const ms = ymdToUtcMs(ymd);
  const dow = new Date(ms).getUTCDay();           // 0 = Sunday
  const back = (dow + 6) % 7;                     // Monday = 0
  return utcMsToYmd(ms - back * DAY_MS);
}

function addDays(ymd: string, n: number): string {
  return utcMsToYmd(ymdToUtcMs(ymd) + n * DAY_MS);
}

/**
 * Turn the request's range into real dates.
 *
 * A custom range is CLAMPED, never rejected: a reversed pair is swapped, a
 * missing end means "to today", and a missing start means "the single day the
 * end names". A filter whose effect the reader cannot see is how a report gets
 * quietly read as the whole month, so `note` says what happened and the label
 * carries the dates that were actually used.
 */
export function resolveRange(
  db: Database.Database,
  input: { range?: string; from?: string; to?: string },
  nowMs?: number,
): ResolvedRange {
  const day = feedbackBoardCutoff(db, nowMs);
  const anchor = day.businessDate || utcMsToYmd(
    (nowMs ?? Date.now()) + (IST_OFFSET_MIN - cutoffMinutes(day.cutoff)) * 60_000,
  );

  const raw = String(input.range ?? 'today').trim().toLowerCase();
  const key: RangeKey =
    raw === 'yesterday' || raw === 'week' || raw === 'month' || raw === 'custom'
      ? (raw as RangeKey)
      : 'today';

  let fromDate = anchor;
  let toDate = anchor;
  let note = '';

  if (key === 'yesterday') {
    fromDate = toDate = addDays(anchor, -1);
  } else if (key === 'week') {
    fromDate = weekStart(anchor);
    toDate = anchor;
  } else if (key === 'month') {
    fromDate = `${anchor.slice(0, 7)}-01`;
    toDate = anchor;
  } else if (key === 'custom') {
    const f = String(input.from ?? '').trim();
    const t = String(input.to ?? '').trim();
    const okF = YMD.test(f);
    const okT = YMD.test(t);
    if (!okF && !okT) {
      note = 'No custom dates given - showing today.';
    } else if (okF && !okT) {
      fromDate = f; toDate = anchor;
      if (toDate < fromDate) { toDate = fromDate; note = 'No end date - showing that single day.'; }
      else note = 'No end date - showing up to today.';
    } else if (!okF && okT) {
      fromDate = toDate = t;
      note = 'No start date - showing that single day.';
    } else {
      fromDate = f; toDate = t;
      if (fromDate > toDate) {
        [fromDate, toDate] = [toDate, fromDate];
        note = 'Start was after end - the dates were swapped.';
      }
    }
  }

  const label =
    fromDate === toDate
      ? `${humanDay(fromDate)} (business day, ${day.cutoff} rollover)`
      : `${humanDay(fromDate)} to ${humanDay(toDate)} (business days, ${day.cutoff} rollover)`;

  return {
    key,
    fromDate,
    toDate,
    window: businessDayWindowUtc(fromDate, toDate, day.cutoff),
    cutoff: day.cutoff,
    cutoffSource: day.source,
    businessDate: anchor,
    label,
    note,
  };
}

/** 'Wed 23 Sep 2026' from a business date. Noon UTC so the IST shift cannot
 *  move the printed day - the same guard `report-pdf.ts:humanDate()` uses. */
export function humanDay(ymd: string): string {
  if (!YMD.test(String(ymd ?? ''))) return String(ymd ?? '');
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
  }).format(new Date(`${ymd}T12:00:00Z`));
}

/** Every business day in the range, oldest first - the spine of the Daily /
 *  Weekly / Monthly breakdown, so a day with no feedback shows as a zero row
 *  instead of being missing. */
export function daysInRange(r: ResolvedRange): string[] {
  const out: string[] = [];
  for (let d = r.fromDate; d <= r.toDate; d = addDays(d, 1)) {
    out.push(d);
    if (out.length > 400) break;                 // a pathological custom range
  }
  return out;
}

/* ════════════════════════════════════════════════════════════════════════════
   2. FILTERS
   ════════════════════════════════════════════════════════════════════════════ */

export interface AnalyticsFilters {
  range?: string;
  from?: string;
  to?: string;
  /** `restaurant_tables.zone`, bucketed through `floorLabel()`. */
  floor?: string;
  /** `restaurant_tables.section`. */
  section?: string;
  /** `orders.server_name`. */
  captain?: string;
  /** `gf_visits.gre_name` - narrows VISITS, never the order universe (see 6). */
  gre?: string;
  /** Same column, for a recorder whose role is management. */
  manager?: string;
  group?: string;
  /** Menu item name, substring, case-insensitive. */
  item?: string;
}

const ALL = 'all';
const isAll = (v: unknown) => {
  const s = String(v ?? '').trim();
  return s === '' || s.toLowerCase() === ALL;
};

/**
 * The query string, as filters. It lives HERE rather than in a route file so
 * that both `/api/feedback/analytics` and `/api/feedback/reports` read the
 * request the same way — a download that parsed `from`/`to` differently from
 * the screen would silently export a different period from the one on display,
 * which is the worst kind of export bug because the file looks right.
 *
 * Every value is text the caller controls, compared with `===` against values
 * read out of the database. Nothing here is interpolated into SQL: the only
 * caller-supplied strings that reach a statement are the two range bounds,
 * which are computed from a validated 'YYYY-MM-DD', and they go in as bound
 * parameters.
 */
export function filtersFromQuery(sp: URLSearchParams): AnalyticsFilters {
  const g = (k: string) => (sp.get(k) ?? '').trim();
  return {
    range: g('range') || 'today',
    from: g('from'),
    to: g('to'),
    floor: g('floor') || 'all',
    section: g('section') || 'all',
    captain: g('captain') || 'all',
    gre: g('gre') || 'all',
    manager: g('manager') || 'all',
    group: g('group') || 'all',
    item: g('item'),
  };
}

/** The filters as sentences. Written into EVERY export - a spreadsheet that
 *  does not say it is one floor on one night is a spreadsheet that will be
 *  read as the whole venue for the month. */
export function filterLines(r: ResolvedRange, f: AnalyticsFilters): string[] {
  const out = [`Period: ${r.label}`];
  if (r.note) out.push(`Period note: ${r.note}`);
  out.push(`Business-day rollover: ${r.cutoff} IST (${r.cutoffSource === 'hr_day_cutoff' ? 'from hr_day_cutoff' : 'module default'})`);
  out.push(`Floor: ${isAll(f.floor) ? 'All floors' : String(f.floor)}`);
  out.push(`Section: ${isAll(f.section) ? 'All sections' : String(f.section)}`);
  out.push(`Captain: ${isAll(f.captain) ? 'All captains' : String(f.captain)}`);
  out.push(`GRE: ${isAll(f.gre) ? 'All' : String(f.gre)}`);
  out.push(`Manager: ${isAll(f.manager) ? 'All' : String(f.manager)}`);
  out.push(`Food / Drinks: ${isAll(f.group) ? 'Both' : String(f.group)}`);
  out.push(`Menu item: ${isAll(f.item) ? 'All items' : String(f.item)}`);
  return out;
}

/* ════════════════════════════════════════════════════════════════════════════
   3. THE ORDER UNIVERSE - the coverage denominator
   ════════════════════════════════════════════════════════════════════════════
   Eligibility mirrors Page 1's rule EXACTLY (`read.ts:listFloorTables`): a
   dine-in order, not voided, on a table that exists, that has reached the item
   threshold OR has had its bill requested OR printed. What is deliberately NOT
   carried over is the two LIVE-only rules - the settled grace window and the
   stale-day exit - because those answer "is this table still worth walking to
   right now", which is not a question a report about last Tuesday can ask. */

export interface UniverseOrder {
  order_id: string;
  order_number: string;
  table_id: string;
  table_number: string;
  floor: string;
  section: string;
  captain: string;
  covers: number;
  item_rows: number;
  eligible: boolean;
  eligible_by_items: boolean;
  eligible_by_bill: boolean;
  business_day: string;
  created_at: string;
  status: string;
}

export interface UniverseExclusions {
  not_dine_in: number;
  table_row_missing: number;
  voided: number;
}

export interface Universe {
  orders: UniverseOrder[];
  eligible: UniverseOrder[];
  excluded: UniverseExclusions;
  itemThreshold: number;
  itemThresholdIsDefault: boolean;
  /** Every floor / section / captain seen in the RANGE before the scope
   *  filters were applied - that is what the dropdowns must offer, or picking
   *  a floor would delete every other floor from its own list. */
  floors: string[];
  sections: string[];
  captains: string[];
}

export function loadUniverse(
  db: Database.Database,
  outletId: string,
  r: ResolvedRange,
  f: AnalyticsFilters,
): Universe {
  const t = readTunables(db);

  const rows = db
    .prepare(
      `SELECT o.id                AS order_id,
              o.order_number      AS order_number,
              o.order_type        AS order_type,
              o.status            AS status,
              o.voided_at         AS voided_at,
              o.covers            AS covers,
              o.server_name       AS server_name,
              o.created_at        AS created_at,
              o.bill_requested_at AS bill_requested_at,
              o.bill_printed_at   AS bill_printed_at,
              t.id                AS t_id,
              t.table_number      AS table_number,
              t.zone              AS zone,
              t.section           AS section,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_rows
         FROM orders o
         LEFT JOIN restaurant_tables t ON t.id = o.table_id
        WHERE (o.outlet_id = ? OR o.outlet_id IS NULL OR o.outlet_id = '')
          AND o.created_at >= ? AND o.created_at < ?`,
    )
    .all(outletId, r.window.startUtc, r.window.endUtc) as any[];

  const excluded: UniverseExclusions = { not_dine_in: 0, table_row_missing: 0, voided: 0 };
  const all: UniverseOrder[] = [];

  for (const x of rows) {
    if (x.voided_at != null || String(x.status ?? '') === 'void') { excluded.voided++; continue; }
    if (String(x.order_type ?? '') !== 'dine-in') { excluded.not_dine_in++; continue; }
    if (!x.t_id) { excluded.table_row_missing++; continue; }

    const itemRows = Number(x.item_rows) || 0;
    const byItems = itemRows >= t.itemThreshold;
    const byBill = !!sqlUtcToIso(x.bill_requested_at) || !!sqlUtcToIso(x.bill_printed_at);

    all.push({
      order_id: String(x.order_id),
      order_number: String(x.order_number ?? ''),
      table_id: String(x.t_id),
      table_number: String(x.table_number ?? ''),
      floor: floorLabel(x.zone),
      section: String(x.section ?? '').trim(),
      captain: String(x.server_name ?? '').trim(),
      covers: Number(x.covers) || 0,
      item_rows: itemRows,
      eligible: byItems || byBill,
      eligible_by_items: byItems,
      eligible_by_bill: byBill,
      business_day: businessDayOfStamp(x.created_at, r.cutoff),
      created_at: sqlUtcToIso(x.created_at) ?? '',
      status: String(x.status ?? ''),
    });
  }

  // The dropdown options come from the whole range, NOT from the filtered set.
  const floors = uniqSorted(all.map((o) => o.floor));
  const sections = uniqSorted(all.map((o) => o.section).filter(Boolean));
  const captains = uniqSorted(all.map((o) => o.captain).filter(Boolean));

  const scoped = all.filter(
    (o) =>
      (isAll(f.floor) || o.floor === String(f.floor).trim())
      && (isAll(f.section) || o.section === String(f.section).trim())
      && (isAll(f.captain) || o.captain === String(f.captain).trim()),
  );

  return {
    orders: scoped,
    eligible: scoped.filter((o) => o.eligible),
    excluded,
    itemThreshold: t.itemThreshold,
    itemThresholdIsDefault: !t.itemThresholdIsSet,
    floors,
    sections,
    captains,
  };
}

function uniqSorted(xs: string[]): string[] {
  return Array.from(new Set(xs)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/* ════════════════════════════════════════════════════════════════════════════
   4. THE DASHBOARD
   ════════════════════════════════════════════════════════════════════════════ */

export interface VisitRow {
  visit_id: string;
  order_id: string;
  table_number: string;
  floor: string;
  section: string;
  captain: string;
  gre_name: string;
  gre_role: string;
  overall_rating: string;
  cat_food: string;
  cat_drinks: string;
  cat_service: string;
  cat_ambience: string;
  everything_good: boolean;
  comment: string;
  status: string;
  has_negative: boolean;
  business_day: string;
  created_at: string;
}

export interface ItemFeedbackRow {
  id: string;
  visit_id: string;
  order_id: string;
  item_key: string;
  item_name: string;
  menu_item_id: string;
  group: ItemGroup;
  station: string;
  quantity: number;
  rating: string;
  issue: string;
  comment: string;
  action_taken: string;
  replacement_item_name: string;
  is_negative: boolean;
  /** Carried down from the visit, so an item row can be filtered by floor. */
  floor: string;
  section: string;
  captain: string;
  gre_name: string;
  table_number: string;
  business_day: string;
  created_at: string;
}

export interface FollowUpRow {
  id: string;
  visit_id: string;
  item_feedback_id: string;
  item_name: string;
  item_key: string;
  table_number: string;
  action_taken: string;
  status: string;
  revisit_rating: string;
  happiness: string;
  revisit_comment: string;
  revisited_at: string;
  closed_at: string;
  escalated_at: string;
  gre_name: string;
  floor: string;
  business_day: string;
  created_at: string;
}

export interface MenuItemRow {
  item_key: string;
  menu_item: string;
  menu_item_id: string;
  group: ItemGroup;
  /** Plates sold in scope - SUM(order_items.quantity), not a row count. */
  sold: number;
  feedbacks: number;
  negative: number;
  returned: number;
  remade: number;
  replaced: number;
  cancelled: number;
  /** Plates, not rows - the Return/Remake numerator. See section 3. */
  returned_qty: number;
  remade_qty: number;
  happy_after: number;
  still_unhappy: number;
  good: number;
  comments: number;
}

export interface GrePerformanceRow {
  person: string;
  role: string;
  tables_visited: number;
  issues_recorded: number;
  follow_ups_raised: number;
  follow_ups_completed: number;
  follow_ups_open: number;
  /** Completed / raised. A process measure - see section 4. */
  recovery_pct: number | null;
}

export const ISSUES_RECORDED_IS_NOT_A_PENALTY =
  'Issues Recorded counts complaints a GRE wrote down. It is a CREDIT, never a penalty: '
  + "the owner's ruling is that a GRE must never have a reason to avoid recording a complaint. "
  + 'Nothing on this page ranks a GRE by the ratings guests gave.';

export const COVERAGE_PER_GRE_UNAVAILABLE =
  'No column assigns a table to a GRE, so coverage per person has no honest denominator. '
  + 'Per-person figures are counts; the coverage % shown is venue-wide for the current filters.';

export interface AnalyticsPayload {
  range: ResolvedRange;
  filters: AnalyticsFilters;
  summary: {
    eligible_tables: number;
    all_tables: number;
    feedback_taken: number;
    coverage_pct: number | null;
    excellent: number;
    good: number;
    average: number;
    poor: number;
    unrated: number;
    everything_good: number;
    negative_item_feedbacks: number;
    item_feedbacks: number;
    returned: number;
    remade: number;
    replaced: number;
    cancelled: number;
    happy_after_replacement: number;
    partially_happy: number;
    still_unhappy: number;
    pending_follow_ups: number;
    follow_ups_raised: number;
    follow_ups_completed: number;
    open_follow_ups_now: number;
    plates_sold: number;
  };
  categories: { key: string; label: string; excellent: number; good: number; average: number; poor: number }[];
  menu_items: MenuItemRow[];
  common_problems: { label: string; count: number }[];
  most_complained: { label: string; count: number; feedbacks: number; negative_pct: number | null }[];
  most_appreciated: { label: string; count: number; feedbacks: number }[];
  recovery: { label: string; count: number }[];
  gre_performance: GrePerformanceRow[];
  daily: {
    day: string; label: string; eligible: number; taken: number;
    coverage_pct: number | null; negative: number; returned_remade: number; open: number;
  }[];
  options: {
    floors: string[];
    sections: string[];
    captains: string[];
    gres: string[];
    managers: string[];
    items: string[];
    sections_available: boolean;
    sections_note: string;
  };
  meta: {
    item_threshold: number;
    item_threshold_is_default: boolean;
    excluded: UniverseExclusions;
    fairness_note: string;
    coverage_per_gre_unavailable: string;
    negative_pct_basis: string;
    return_remake_basis: string;
    generated_at: string;
    gre_filter_is_numerator_only: boolean;
  };
}

const NOTE_SECTIONS_EMPTY =
  'No sections defined on the tables in this period - restaurant_tables.section is empty for '
  + 'every table in scope, so there is nothing to filter by.';

export const NEGATIVE_PCT_BASIS =
  'Negative % = negative feedbacks / feedbacks received for that item. Both sides count feedback '
  + 'rows, so a dish nobody was asked about cannot look good and a popular dish cannot look bad.';

export const RETURN_REMAKE_BASIS =
  'Return / Remake Rate = plates returned + remade / plates SOLD. Both sides are quantities: the '
  + 'numerator sums gf_item_feedback.quantity, so one feedback on a line of three counts three.';

/** Percentage, or null when the denominator is zero - never NaN, never a 0%
 *  that reads as "we covered nothing" when the truth is "there was nothing". */
export function rate(n: number, d: number): number | null {
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return null;
  return Math.round((n / d) * 1000) / 10;
}

export function itemKeyOf(name: unknown): string {
  return String(name ?? '').trim().toLowerCase();
}

/**
 * THE WHOLE DASHBOARD, in one pass over five queries.
 *
 * Everything the page draws and everything the eight reports contain comes out
 * of this object, so the screen and the spreadsheet cannot disagree.
 */
export function analytics(
  db: Database.Database,
  opts: { outletId: string; filters: AnalyticsFilters; nowMs?: number },
): AnalyticsPayload {
  const f = opts.filters;
  const r = resolveRange(db, f, opts.nowMs);
  const u = loadUniverse(db, opts.outletId, r, f);

  const orderById = new Map(u.orders.map((o) => [o.order_id, o]));
  const eligibleIds = new Set(u.eligible.map((o) => o.order_id));

  /* -- visits ---------------------------------------------------------- */
  const visitRows = selectIn(
    db,
    `SELECT id, order_id, table_number, floor, gre_name, gre_role, overall_rating,
            cat_food, cat_drinks, cat_service, cat_ambience, everything_good,
            comment, status, has_negative, created_at
       FROM gf_visits WHERE order_id IN (@@)`,
    u.orders.map((o) => o.order_id),
  );

  const allVisits: VisitRow[] = visitRows.map((v: any) => {
    const o = orderById.get(String(v.order_id));
    return {
      visit_id: String(v.id),
      order_id: String(v.order_id),
      table_number: String(v.table_number ?? o?.table_number ?? ''),
      floor: o?.floor ?? floorLabel(v.floor),
      section: o?.section ?? '',
      captain: o?.captain ?? '',
      gre_name: String(v.gre_name ?? '').trim(),
      gre_role: String(v.gre_role ?? '').trim(),
      overall_rating: String(v.overall_rating ?? ''),
      cat_food: String(v.cat_food ?? ''),
      cat_drinks: String(v.cat_drinks ?? ''),
      cat_service: String(v.cat_service ?? ''),
      cat_ambience: String(v.cat_ambience ?? ''),
      everything_good: !!Number(v.everything_good),
      comment: String(v.comment ?? ''),
      status: String(v.status ?? ''),
      has_negative: !!Number(v.has_negative),
      business_day: o?.business_day ?? businessDayOfStamp(v.created_at, r.cutoff),
      created_at: sqlUtcToIso(v.created_at) ?? '',
    };
  });

  // The dropdowns list everyone who recorded anything in the range, BEFORE the
  // person filter - so picking a name does not empty the list it came from.
  const gres = uniqSorted(allVisits.filter((v) => !isManagementRole(v.gre_role)).map((v) => v.gre_name).filter(Boolean));
  const managers = uniqSorted(allVisits.filter((v) => isManagementRole(v.gre_role)).map((v) => v.gre_name).filter(Boolean));

  // Section 6: the person filters narrow VISITS ONLY. The order universe above
  // is untouched, so coverage stays "their share of the scope's eligible
  // tables" instead of collapsing to a guaranteed 100%.
  const person = !isAll(f.gre) ? String(f.gre).trim() : !isAll(f.manager) ? String(f.manager).trim() : '';
  const visits = person ? allVisits.filter((v) => v.gre_name === person) : allVisits;

  // Coverage counts only visits on tables that were ELIGIBLE - otherwise a
  // visit to a two-item table would push coverage over 100%.
  const coveredVisits = visits.filter((v) => eligibleIds.has(v.order_id));
  const visitById = new Map(visits.map((v) => [v.visit_id, v]));

  /* -- item feedback --------------------------------------------------- */
  const itemRaw = selectIn(
    db,
    `SELECT id, visit_id, order_id, order_item_id, menu_item_id, item_name, station,
            item_group, quantity, rating, issue, comment, action_taken,
            replacement_item_name, is_negative, created_at
       FROM gf_item_feedback WHERE visit_id IN (@@)`,
    visits.map((v) => v.visit_id),
  );

  const groupWanted = isAll(f.group) ? '' : String(f.group).trim().toLowerCase();
  const itemWanted = isAll(f.item) ? '' : String(f.item).trim().toLowerCase();

  const allItems: ItemFeedbackRow[] = itemRaw.map((x: any) => {
    const v = visitById.get(String(x.visit_id));
    return {
      id: String(x.id),
      visit_id: String(x.visit_id),
      order_id: String(x.order_id ?? v?.order_id ?? ''),
      item_key: itemKeyOf(x.item_name),
      item_name: String(x.item_name ?? '').trim(),
      menu_item_id: String(x.menu_item_id ?? '').trim(),
      group: String(x.item_group ?? 'food') === 'drinks' ? 'drinks' : 'food',
      station: String(x.station ?? '').trim(),
      quantity: Number(x.quantity) || 0,
      rating: String(x.rating ?? ''),
      issue: String(x.issue ?? ''),
      comment: String(x.comment ?? '').trim(),
      action_taken: String(x.action_taken ?? 'none'),
      replacement_item_name: String(x.replacement_item_name ?? '').trim(),
      is_negative: !!Number(x.is_negative),
      floor: v?.floor ?? '',
      section: v?.section ?? '',
      captain: v?.captain ?? '',
      gre_name: v?.gre_name ?? '',
      table_number: v?.table_number ?? '',
      business_day: v?.business_day ?? businessDayOfStamp(x.created_at, r.cutoff),
      created_at: sqlUtcToIso(x.created_at) ?? '',
    };
  });

  const items = allItems.filter(
    (x) =>
      (!groupWanted || x.group === groupWanted)
      && (!itemWanted || x.item_name.toLowerCase().includes(itemWanted)),
  );

  /* -- follow-ups ------------------------------------------------------ */
  const fuRaw = selectIn(
    db,
    `SELECT id, visit_id, item_feedback_id, item_name, table_id, action_taken, status,
            revisit_rating, happiness, revisit_comment, revisited_at, closed_at,
            escalated_at, created_at
       FROM gf_follow_ups WHERE visit_id IN (@@)`,
    visits.map((v) => v.visit_id),
  );

  const itemById = new Map(allItems.map((x) => [x.id, x]));
  const allFollowUps: FollowUpRow[] = fuRaw.map((x: any) => {
    const v = visitById.get(String(x.visit_id));
    const it = itemById.get(String(x.item_feedback_id));
    return {
      id: String(x.id),
      visit_id: String(x.visit_id),
      item_feedback_id: String(x.item_feedback_id ?? ''),
      item_name: String(x.item_name ?? it?.item_name ?? '').trim(),
      item_key: itemKeyOf(x.item_name ?? it?.item_name),
      table_number: v?.table_number ?? '',
      action_taken: String(x.action_taken ?? ''),
      status: String(x.status ?? ''),
      revisit_rating: String(x.revisit_rating ?? ''),
      happiness: String(x.happiness ?? ''),
      revisit_comment: String(x.revisit_comment ?? '').trim(),
      revisited_at: sqlUtcToIso(x.revisited_at) ?? '',
      closed_at: sqlUtcToIso(x.closed_at) ?? '',
      escalated_at: sqlUtcToIso(x.escalated_at) ?? '',
      gre_name: v?.gre_name ?? '',
      floor: v?.floor ?? '',
      business_day: v?.business_day ?? businessDayOfStamp(x.created_at, r.cutoff),
      created_at: sqlUtcToIso(x.created_at) ?? '',
    };
  });

  // The Food/Drinks and Menu Item filters narrow items, so they must narrow the
  // follow-ups ABOUT those items too, or "Guest Happy" would answer for drinks
  // while the table above it answered for food.
  const keptItemIds = new Set(items.map((x) => x.id));
  const followUps =
    groupWanted || itemWanted
      ? allFollowUps.filter((x) => keptItemIds.has(x.item_feedback_id))
      : allFollowUps;

  /* -- plates sold, keyed by name (section 5) -------------------------- */
  const soldRows = selectIn(
    db,
    `SELECT LOWER(TRIM(COALESCE(name,''))) AS item_key,
            MAX(TRIM(COALESCE(name,'')))   AS item_name,
            SUM(COALESCE(quantity,0))      AS sold
       FROM order_items WHERE order_id IN (@@) GROUP BY item_key`,
    u.orders.map((o) => o.order_id),
  );
  // One chunk per 400 orders, so the same dish can arrive in several groups.
  const soldByKey = new Map<string, { name: string; sold: number }>();
  let platesSold = 0;
  for (const s of soldRows as any[]) {
    const k = String(s.item_key ?? '');
    if (!k) continue;
    const q = Number(s.sold) || 0;
    const prev = soldByKey.get(k);
    soldByKey.set(k, { name: prev?.name || String(s.item_name ?? ''), sold: (prev?.sold ?? 0) + q });
    platesSold += q;
  }

  /* -- aggregates ------------------------------------------------------ */
  const ratingCount = (v: string) => visits.filter((x) => x.overall_rating === v).length;

  const act = (a: ActionTaken) => items.filter((x) => x.action_taken === a).length;
  const replaced = act('replaced_same') + act('replaced_other');

  const happy = followUps.filter((x) => x.happiness === 'happy').length;
  const partial = followUps.filter((x) => x.happiness === 'partial').length;
  const unhappy = followUps.filter((x) => x.happiness === 'unhappy').length;
  const openNowAllTime = countOpenFollowUpsNow(db);

  const menuItems = buildMenuItems(items, followUps, soldByKey, groupWanted, itemWanted);

  const summary: AnalyticsPayload['summary'] = {
    eligible_tables: u.eligible.length,
    all_tables: u.orders.length,
    feedback_taken: coveredVisits.length,
    coverage_pct: rate(coveredVisits.length, u.eligible.length),
    excellent: ratingCount('excellent'),
    good: ratingCount('good'),
    average: ratingCount('average'),
    poor: ratingCount('poor'),
    unrated: visits.filter((x) => !x.overall_rating).length,
    everything_good: visits.filter((x) => x.everything_good).length,
    negative_item_feedbacks: items.filter((x) => x.is_negative).length,
    item_feedbacks: items.length,
    returned: act('returned'),
    remade: act('remade'),
    replaced,
    cancelled: act('cancelled'),
    happy_after_replacement: happy,
    partially_happy: partial,
    still_unhappy: unhappy,
    pending_follow_ups: followUps.filter((x) => x.status === 'open').length,
    follow_ups_raised: followUps.length,
    follow_ups_completed: followUps.filter((x) => x.status === 'closed').length,
    open_follow_ups_now: openNowAllTime,
    plates_sold: platesSold,
  };

  return {
    range: r,
    filters: f,
    summary,
    categories: CATEGORIES.map((c) => {
      const col = `cat_${c.v}` as 'cat_food' | 'cat_drinks' | 'cat_service' | 'cat_ambience';
      const n = (val: string) => visits.filter((x) => x[col] === val).length;
      return { key: c.v, label: c.label, excellent: n('excellent'), good: n('good'), average: n('average'), poor: n('poor') };
    }),
    menu_items: menuItems,
    common_problems: commonProblems(items),
    most_complained: menuItems
      .filter((m) => m.negative > 0)
      .sort((a, b) => b.negative - a.negative || (rate(b.negative, b.feedbacks) ?? 0) - (rate(a.negative, a.feedbacks) ?? 0))
      .slice(0, 8)
      .map((m) => ({ label: m.menu_item, count: m.negative, feedbacks: m.feedbacks, negative_pct: rate(m.negative, m.feedbacks) })),
    most_appreciated: menuItems
      .filter((m) => m.good > 0)
      .sort((a, b) => b.good - a.good || b.feedbacks - a.feedbacks)
      .slice(0, 8)
      .map((m) => ({ label: m.menu_item, count: m.good, feedbacks: m.feedbacks })),
    recovery: [
      { label: 'Negative feedbacks', count: summary.negative_item_feedbacks },
      { label: 'Items returned', count: summary.returned },
      { label: 'Items remade', count: summary.remade },
      { label: 'Items replaced', count: summary.replaced },
      { label: 'Guest happy after correction', count: happy },
      { label: 'Partially happy', count: partial },
      { label: 'Still unhappy', count: unhappy },
    ],
    gre_performance: grePerformance(visits, items, followUps, eligibleIds),
    daily: daysInRange(r).map((d) => {
      const el = u.eligible.filter((o) => o.business_day === d).length;
      const tk = coveredVisits.filter((v) => v.business_day === d).length;
      return {
        day: d,
        label: humanDay(d),
        eligible: el,
        taken: tk,
        coverage_pct: rate(tk, el),
        negative: items.filter((x) => x.business_day === d && x.is_negative).length,
        returned_remade: items.filter(
          (x) => x.business_day === d && (x.action_taken === 'returned' || x.action_taken === 'remade'),
        ).length,
        open: followUps.filter((x) => x.business_day === d && x.status === 'open').length,
      };
    }),
    options: {
      floors: u.floors,
      sections: u.sections,
      captains: u.captains,
      gres,
      managers,
      items: uniqSorted(menuItems.map((m) => m.menu_item)).slice(0, 500),
      sections_available: u.sections.length > 0,
      sections_note: u.sections.length > 0 ? '' : NOTE_SECTIONS_EMPTY,
    },
    meta: {
      item_threshold: u.itemThreshold,
      item_threshold_is_default: u.itemThresholdIsDefault,
      excluded: u.excluded,
      fairness_note: ISSUES_RECORDED_IS_NOT_A_PENALTY,
      coverage_per_gre_unavailable: COVERAGE_PER_GRE_UNAVAILABLE,
      negative_pct_basis: NEGATIVE_PCT_BASIS,
      return_remake_basis: RETURN_REMAKE_BASIS,
      generated_at: new Date().toISOString(),
      gre_filter_is_numerator_only: !!person,
    },
  };
}

/** A role name that means management for the purpose of splitting the GRE and
 *  Manager dropdowns. `gf_visits.gre_role` is the role NAME at visit time, and
 *  the module's own gate has already decided who may record; this only decides
 *  which of two dropdowns a name appears in, so a wrong guess costs a label,
 *  never an access decision. */
function isManagementRole(roleName: string): boolean {
  const s = String(roleName ?? '').trim().toLowerCase();
  if (!s) return false;
  return s !== 'gre';
}

/** `WHERE col IN (?, ?, ...)` in chunks, because SQLite caps host parameters at
 *  999 and a month on 292 tables goes well past that. */
function selectIn(db: Database.Database, sql: string, ids: string[]): any[] {
  const uniq = Array.from(new Set(ids.filter(Boolean)));
  if (uniq.length === 0) return [];
  const out: any[] = [];
  for (let i = 0; i < uniq.length; i += 400) {
    const chunk = uniq.slice(i, i + 400);
    const stmt = db.prepare(sql.replace('@@', chunk.map(() => '?').join(',')));
    out.push(...(stmt.all(...chunk) as any[]));
  }
  return out;
}

/** Open complaints as of NOW, across every date - section 2's exception. */
function countOpenFollowUpsNow(db: Database.Database): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM gf_follow_ups WHERE status = 'open'`).get() as any;
    return Number(row?.n) || 0;
  } catch {
    return 0;
  }
}

function buildMenuItems(
  items: ItemFeedbackRow[],
  followUps: FollowUpRow[],
  soldByKey: Map<string, { name: string; sold: number }>,
  groupWanted: string,
  itemWanted: string,
): MenuItemRow[] {
  const by = new Map<string, MenuItemRow>();

  const blank = (key: string, name: string, group: ItemGroup): MenuItemRow => ({
    item_key: key,
    menu_item: name,
    menu_item_id: '',
    group,
    sold: soldByKey.get(key)?.sold ?? 0,
    feedbacks: 0, negative: 0, returned: 0, remade: 0, replaced: 0, cancelled: 0,
    returned_qty: 0, remade_qty: 0, happy_after: 0, still_unhappy: 0, good: 0, comments: 0,
  });

  for (const x of items) {
    if (!x.item_key) continue;
    let row = by.get(x.item_key);
    if (!row) {
      row = blank(x.item_key, x.item_name || soldByKey.get(x.item_key)?.name || x.item_key, x.group);
      by.set(x.item_key, row);
    }
    if (!row.menu_item_id && x.menu_item_id) row.menu_item_id = x.menu_item_id;
    row.feedbacks++;
    if (x.is_negative) row.negative++;
    if (x.rating === 'good') row.good++;
    if (x.comment) row.comments++;
    if (x.action_taken === 'returned') { row.returned++; row.returned_qty += x.quantity; }
    if (x.action_taken === 'remade') { row.remade++; row.remade_qty += x.quantity; }
    if (x.action_taken === 'replaced_same' || x.action_taken === 'replaced_other') row.replaced++;
    if (x.action_taken === 'cancelled') row.cancelled++;
  }

  const itemKeyById = new Map(items.map((x) => [x.id, x.item_key]));
  for (const fu of followUps) {
    const key = itemKeyById.get(fu.item_feedback_id) ?? fu.item_key;
    const row = by.get(key);
    if (!row) continue;
    if (fu.happiness === 'happy') row.happy_after++;
    if (fu.happiness === 'unhappy') row.still_unhappy++;
  }

  // Dishes that SOLD but drew no comment belong in the table: a manager
  // scanning for the problem dish also needs to see what nobody mentioned, and
  // leaving them out would make "Feedbacks 0" unrepresentable.
  for (const [key, s] of soldByKey) {
    if (by.has(key)) continue;
    if (itemWanted && !s.name.toLowerCase().includes(itemWanted)) continue;
    // The Food/Drinks answer is stored on the FEEDBACK row, not on the order
    // line, so an item with no feedback has no group and cannot honestly be
    // included when a Food/Drinks filter is on.
    if (groupWanted) continue;
    by.set(key, blank(key, s.name || key, 'food'));
  }

  return Array.from(by.values()).sort(
    (a, b) =>
      (rate(b.negative, b.feedbacks) ?? -1) - (rate(a.negative, a.feedbacks) ?? -1)
      || b.negative - a.negative
      || b.feedbacks - a.feedbacks
      || a.menu_item.localeCompare(b.menu_item),
  );
}

function commonProblems(items: ItemFeedbackRow[]): { label: string; count: number }[] {
  const labels = new Map(ITEM_ISSUES.map((i) => [i.v as string, i.label]));
  const n = new Map<string, number>();
  for (const x of items) {
    if (!x.issue) continue;
    n.set(x.issue, (n.get(x.issue) ?? 0) + 1);
  }
  return Array.from(n.entries())
    .map(([k, count]) => ({ label: labels.get(k) ?? k, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, 8);
}

/**
 * THE FAIRNESS RULING, IN CODE. Read section 4 before adding a column here.
 * This function does not touch `overall_rating`, does not count how many of the
 * complaints were bad, and returns no score. Every figure is a COUNT of work
 * done plus one process rate (follow-ups completed / follow-ups raised), which
 * rises when a GRE goes back and closes a complaint - the exact behaviour the
 * owner wants encouraged.
 */
function grePerformance(
  visits: VisitRow[],
  items: ItemFeedbackRow[],
  followUps: FollowUpRow[],
  eligibleIds: Set<string>,
): GrePerformanceRow[] {
  const by = new Map<string, GrePerformanceRow>();
  const visitPerson = new Map<string, string>();

  for (const v of visits) {
    const name = v.gre_name || '(unnamed)';
    visitPerson.set(v.visit_id, name);
    let row = by.get(name);
    if (!row) {
      row = {
        person: name, role: v.gre_role || '',
        tables_visited: 0, issues_recorded: 0,
        follow_ups_raised: 0, follow_ups_completed: 0, follow_ups_open: 0,
        recovery_pct: null,
      };
      by.set(name, row);
    }
    if (eligibleIds.has(v.order_id)) row.tables_visited++;
  }

  for (const x of items) {
    if (!x.is_negative) continue;
    const row = by.get(visitPerson.get(x.visit_id) ?? '');
    if (row) row.issues_recorded++;
  }

  for (const fu of followUps) {
    const row = by.get(visitPerson.get(fu.visit_id) ?? '');
    if (!row) continue;
    row.follow_ups_raised++;
    if (fu.status === 'closed') row.follow_ups_completed++;
    else row.follow_ups_open++;
  }

  for (const row of by.values()) row.recovery_pct = rate(row.follow_ups_completed, row.follow_ups_raised);

  return Array.from(by.values()).sort(
    (a, b) => b.tables_visited - a.tables_visited || a.person.localeCompare(b.person),
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   5. THE COMMENTS BEHIND ONE ITEM
   ════════════════════════════════════════════════════════════════════════════
   The owner asked for this by name: "management can CLICK AN ITEM TO SEE THE
   ACTUAL COMMENTS". A count tells a chef that something is wrong; the sentence
   the guest said is what tells them what to change. */

export interface ItemCommentRow {
  when: string;
  business_day: string;
  table_number: string;
  floor: string;
  gre_name: string;
  captain: string;
  rating: string;
  issue: string;
  issue_label: string;
  action_taken: string;
  action_label: string;
  replacement_item_name: string;
  quantity: number;
  comment: string;
  happiness: string;
  follow_up_status: string;
  revisit_comment: string;
}

export function itemComments(
  db: Database.Database,
  opts: { outletId: string; filters: AnalyticsFilters; itemKey: string; nowMs?: number },
): { item: MenuItemRow | null; rows: ItemCommentRow[]; range: ResolvedRange } {
  // Run the same computation the dashboard ran, so the header numbers in the
  // sheet match the row the manager clicked on. One authority - see "WHY
  // SCREEN AND DOWNLOADS SHARE ONE FILE".
  const payload = analytics(db, { outletId: opts.outletId, filters: opts.filters, nowMs: opts.nowMs });
  const key = itemKeyOf(opts.itemKey);
  const item = payload.menu_items.find((m) => m.item_key === key) ?? null;

  const r = payload.range;
  const u = loadUniverse(db, opts.outletId, r, opts.filters);
  const visitRows = selectIn(
    db,
    `SELECT id, order_id, table_number, floor, gre_name, gre_role, created_at
       FROM gf_visits WHERE order_id IN (@@)`,
    u.orders.map((o) => o.order_id),
  );
  const orderById = new Map(u.orders.map((o) => [o.order_id, o]));
  const person = !isAll(opts.filters.gre)
    ? String(opts.filters.gre).trim()
    : !isAll(opts.filters.manager) ? String(opts.filters.manager).trim() : '';

  const visitMeta = new Map<string, { table: string; floor: string; gre: string; captain: string; day: string }>();
  for (const v of visitRows as any[]) {
    const gre = String(v.gre_name ?? '').trim();
    if (person && gre !== person) continue;
    const o = orderById.get(String(v.order_id));
    visitMeta.set(String(v.id), {
      table: String(v.table_number ?? o?.table_number ?? ''),
      floor: o?.floor ?? floorLabel(v.floor),
      gre,
      captain: o?.captain ?? '',
      day: o?.business_day ?? businessDayOfStamp(v.created_at, r.cutoff),
    });
  }

  const raw = selectIn(
    db,
    `SELECT id, visit_id, item_name, rating, issue, comment, action_taken,
            replacement_item_name, quantity, created_at
       FROM gf_item_feedback WHERE visit_id IN (@@)`,
    Array.from(visitMeta.keys()),
  );

  const fu = selectIn(
    db,
    `SELECT item_feedback_id, status, happiness, revisit_comment
       FROM gf_follow_ups WHERE visit_id IN (@@)`,
    Array.from(visitMeta.keys()),
  );
  const fuByItem = new Map(fu.map((x: any) => [String(x.item_feedback_id), x]));

  const issueLabels = new Map(ITEM_ISSUES.map((i) => [i.v as string, i.label]));
  const actionLabels = new Map(ACTIONS_TAKEN.map((a) => [a.v as string, a.label]));

  const rows: ItemCommentRow[] = (raw as any[])
    .filter((x) => itemKeyOf(x.item_name) === key)
    .map((x) => {
      const m = visitMeta.get(String(x.visit_id));
      const flw = fuByItem.get(String(x.id));
      return {
        when: sqlUtcToIso(x.created_at) ?? '',
        business_day: m?.day ?? '',
        table_number: m?.table ?? '',
        floor: m?.floor ?? '',
        gre_name: m?.gre ?? '',
        captain: m?.captain ?? '',
        rating: String(x.rating ?? ''),
        issue: String(x.issue ?? ''),
        issue_label: issueLabels.get(String(x.issue ?? '')) ?? String(x.issue ?? ''),
        action_taken: String(x.action_taken ?? ''),
        action_label: actionLabels.get(String(x.action_taken ?? '')) ?? String(x.action_taken ?? ''),
        replacement_item_name: String(x.replacement_item_name ?? '').trim(),
        quantity: Number(x.quantity) || 0,
        comment: String(x.comment ?? '').trim(),
        happiness: String(flw?.happiness ?? ''),
        follow_up_status: String(flw?.status ?? ''),
        revisit_comment: String(flw?.revisit_comment ?? '').trim(),
      };
    })
    // A commented row is the point of this view, so those come first; the rest
    // are kept because a rating with no words is still evidence.
    .sort((a, b) => (b.comment ? 1 : 0) - (a.comment ? 1 : 0) || b.when.localeCompare(a.when));

  return { item, rows, range: r };
}

/* ════════════════════════════════════════════════════════════════════════════
   6. THE EIGHT REPORTS - ONE SHAPE, TWO RENDERERS
   ════════════════════════════════════════════════════════════════════════════
   A report is a title, the filters it was run under, some KPIs and a list of
   tables. The xlsx writer turns each table into a sheet; the PDF writer hands
   the same tables to `buildReportPdf()`. Neither computes anything. */

export interface ReportTable {
  name: string;
  columns: { label: string; width?: number; align?: 'left' | 'right' | 'center' }[];
  rows: (string | number)[][];
  note?: string;
  emptyNote?: string;
}

export interface ReportDoc {
  key: string;
  title: string;
  subtitle: string;
  period: string;
  /** The filters, as sentences - written into the file, never only the UI. */
  filters: string[];
  kpis: { label: string; value: string; sub?: string }[];
  tables: ReportTable[];
  footnotes: string[];
  /** Safe for a filename: no spaces, no slashes. */
  slug: string;
}

export const REPORT_KEYS = [
  'daily', 'weekly', 'monthly', 'menu-item', 'returned-remade',
  'negative', 'gre-performance', 'guest-recovery',
] as const;

export type ReportKeyName = (typeof REPORT_KEYS)[number];

export function isReportKey(v: unknown): v is ReportKeyName {
  return (REPORT_KEYS as readonly string[]).includes(String(v ?? ''));
}

/** Daily/Weekly/Monthly are the same report over a different period. When the
 *  caller asks for one of those, the period is FORCED, so a "Monthly" download
 *  can never quietly contain one day because a chip was left on Today. */
export function rangeForReport(key: ReportKeyName, f: AnalyticsFilters): AnalyticsFilters {
  if (key === 'daily') return { ...f, range: 'today', from: '', to: '' };
  if (key === 'weekly') return { ...f, range: 'week', from: '', to: '' };
  if (key === 'monthly') return { ...f, range: 'month', from: '', to: '' };
  return f;
}

const pctText = (v: number | null): string => (v == null ? '-' : `${v.toFixed(1)}%`);
const n0 = (v: number): string => String(Math.round(v));
const qtyText = (v: number): string => String(Math.round(v * 1000) / 1000);

export const GROUP_UNKNOWN_BASIS =
  'An item with no feedback has no Food/Drinks answer to print: the classifier runs at WRITE time '
  + 'and stores its verdict on the feedback row, not on the order line, so an item nobody commented '
  + 'on is shown as "no feedback" rather than guessed at.';

/**
 * The Food/Drinks label for one row.
 *
 * NOT `group === 'drinks' ? 'Drinks' : 'Food'`. `buildMenuItems()` seeds a
 * sold-but-uncommented item with the placeholder group 'food' because the type
 * demands a value, and the real answer simply does not exist for that row —
 * `stationKdsSection()` ran at write time and there was no write. Printing
 * "Food" there put a beer in the Food column of the exported workbook,
 * measured on the P5 fixtures ("Kingfisher", station `beer`, 0 feedbacks).
 * The screen already says "no feedback" for these; the file must agree.
 */
function groupLabel(m: MenuItemRow): string {
  if (m.feedbacks === 0) return 'no feedback';
  return m.group === 'drinks' ? 'Drinks' : 'Food';
}

export function buildReport(p: AnalyticsPayload, key: ReportKeyName): ReportDoc {
  const filters = filterLines(p.range, p.filters);
  const s = p.summary;

  const coverageKpis = [
    { label: 'Eligible tables', value: n0(s.eligible_tables), sub: `threshold ${p.meta.item_threshold} items${p.meta.item_threshold_is_default ? ' (default)' : ''}` },
    { label: 'Feedbacks taken', value: n0(s.feedback_taken) },
    { label: 'Coverage', value: pctText(s.coverage_pct) },
    { label: 'Negative item feedbacks', value: n0(s.negative_item_feedbacks), sub: `of ${n0(s.item_feedbacks)} item feedbacks` },
  ];

  const base = {
    period: p.range.label,
    filters,
    footnotes: [
      NEGATIVE_PCT_BASIS,
      RETURN_REMAKE_BASIS,
      `Dates are IST business days with a ${p.range.cutoff} rollover - the same convention the floor board uses, so a complaint taken at 01:30 belongs to the previous evening's service.`,
      ISSUES_RECORDED_IS_NOT_A_PENALTY,
    ],
  };

  const dailyTable: ReportTable = {
    name: 'By day',
    columns: [
      { label: 'Business day', width: 2.2 },
      { label: 'Eligible', width: 1.05, align: 'right' },
      { label: 'Taken', width: 0.9, align: 'right' },
      { label: 'Coverage', width: 1.1, align: 'right' },
      { label: 'Negative', width: 1.1, align: 'right' },
      { label: 'Ret/Rem', width: 1, align: 'right' },
      { label: 'Open', width: 0.85, align: 'right' },
    ],
    rows: p.daily.map((d) => [d.label, d.eligible, d.taken, pctText(d.coverage_pct), d.negative, d.returned_remade, d.open]),
    note: 'Open = follow-ups raised on that day that are still open. A day with no eligible table shows "-" for coverage rather than 0%, which would read as "we covered nothing".',
    emptyNote: 'No business days in this period.',
  };

  const recoveryTable: ReportTable = {
    name: 'Service recovery',
    columns: [{ label: 'Outcome', width: 3 }, { label: 'Count', width: 1, align: 'right' }],
    rows: p.recovery.map((x) => [x.label, x.count]),
    note: 'What happened AFTER a negative feedback. "Guest happy after correction" closes the complaint; "partially happy" and "still unhappy" leave it open for the manager.',
    emptyNote: 'No service recovery activity in this period.',
  };

  const menuTable = (rows: MenuItemRow[]): ReportTable => ({
    name: 'Menu item analysis',
    // ⚠️ THESE WIDTHS ARE MEASURED, NOT GUESSED. `report-pdf.ts` truncates every
    // cell to one line with an ellipsis rather than wrapping, so a label that
    // does not fit becomes unreadable IN THE PRINTED REPORT while looking fine
    // in the spreadsheet. The first cut of this table rendered "Negative" and
    // "Negative %" as "Negativ…" and "Negativ…" — two different columns with
    // the SAME visible heading. Every label and a worst-case cell were measured
    // against `doc.widthOfString()` at the renderer's real font
    // (Helvetica-Bold 8 / Helvetica 8, PAD 4, CONTENT_W 515.28); the P5
    // evidence carries the check. Headings match the SCREEN's wording
    // ("Neg %", "R/R %", "Happy") so a manager reading the file and a manager
    // reading the page are looking at the same words.
    columns: [
      { label: 'Item', width: 2.6 },
      { label: 'Group', width: 1.35 },
      { label: 'Sold', width: 0.85, align: 'right' },
      { label: 'Feedbacks', width: 1.2, align: 'right' },
      { label: 'Negative', width: 1.1, align: 'right' },
      { label: 'Neg %', width: 0.95, align: 'right' },
      { label: 'Returned', width: 1.1, align: 'right' },
      { label: 'Remade', width: 1, align: 'right' },
      { label: 'R/R %', width: 0.95, align: 'right' },
      { label: 'Happy', width: 0.95, align: 'right' },
    ],
    rows: rows.map((m) => [
      m.menu_item, groupLabel(m), qtyText(m.sold), m.feedbacks, m.negative,
      pctText(rate(m.negative, m.feedbacks)), m.returned, m.remade,
      pctText(rate(m.returned_qty + m.remade_qty, m.sold)), m.happy_after,
    ]),
    note: `${NEGATIVE_PCT_BASIS} ${RETURN_REMAKE_BASIS} ${GROUP_UNKNOWN_BASIS}`,
    emptyNote: 'No menu items matched these filters.',
  });

  switch (key) {
    case 'daily':
    case 'weekly':
    case 'monthly': {
      const title = key === 'daily' ? 'Daily Feedback Report'
        : key === 'weekly' ? 'Weekly Feedback Report' : 'Monthly Feedback Report';
      return {
        ...base, key, slug: key, title,
        subtitle: 'Coverage, ratings and service recovery for the period.',
        kpis: [
          ...coverageKpis,
          { label: 'Returned / remade / replaced', value: n0(s.returned + s.remade + s.replaced), sub: `${s.returned} returned, ${s.remade} remade, ${s.replaced} replaced` },
          { label: 'Guest happy after correction', value: n0(s.happy_after_replacement) },
          { label: 'Still unhappy', value: n0(s.still_unhappy) },
          { label: 'Follow-ups open now (all dates)', value: n0(s.open_follow_ups_now) },
        ],
        tables: [
          dailyTable,
          {
            name: 'Rating split',
            columns: [{ label: 'Overall rating', width: 2 }, { label: 'Feedbacks', width: 1.1, align: 'right' }, { label: 'Share', width: 1, align: 'right' }],
            rows: (() => {
              const total = s.excellent + s.good + s.average + s.poor;
              const out: (string | number)[][] = OVERALL_RATINGS.map((o) => {
                const v = o.v === 'excellent' ? s.excellent : o.v === 'good' ? s.good : o.v === 'average' ? s.average : s.poor;
                return [o.label, v, pctText(rate(v, total))];
              });
              out.push(['Not rated', s.unrated, pctText(rate(s.unrated, total + s.unrated))]);
              return out;
            })(),
            note: '"Everything Good" submissions are counted under their overall rating; a visit recorded with no overall rating is listed as Not rated.',
            emptyNote: 'No feedback was recorded in this period.',
          },
          {
            name: 'Category ratings',
            columns: [
              { label: 'Category', width: 2 }, { label: 'Excellent', width: 1.1, align: 'right' },
              { label: 'Good', width: 1, align: 'right' }, { label: 'Average', width: 1.05, align: 'right' },
              { label: 'Poor', width: 1, align: 'right' },
            ],
            rows: p.categories.map((c) => [c.label, c.excellent, c.good, c.average, c.poor]),
            emptyNote: 'No category ratings in this period.',
          },
          recoveryTable,
        ],
      };
    }

    case 'menu-item':
      return {
        ...base, key, slug: 'menu-item', title: 'Menu Item Feedback Report',
        subtitle: 'Every item ordered in the period, with the rates beside the counts.',
        kpis: [
          { label: 'Items with feedback', value: n0(p.menu_items.filter((m) => m.feedbacks > 0).length), sub: `of ${n0(p.menu_items.length)} items sold` },
          { label: 'Plates sold', value: qtyText(s.plates_sold) },
          { label: 'Negative item feedbacks', value: n0(s.negative_item_feedbacks) },
          { label: 'Returned + remade', value: n0(s.returned + s.remade) },
        ],
        tables: [
          menuTable(p.menu_items),
          {
            name: 'Most complained',
            columns: [{ label: 'Item', width: 3 }, { label: 'Negative', width: 1.1, align: 'right' }, { label: 'Feedbacks', width: 1.2, align: 'right' }, { label: 'Neg %', width: 1, align: 'right' }],
            rows: p.most_complained.map((x) => [x.label, x.count, x.feedbacks, pctText(x.negative_pct)]),
            note: 'Ordered by absolute count, deliberately: a rate alone hides a high-volume dish with many complaints, and a count alone hides a rarely-ordered one that is always wrong. Read this beside Negative %.',
            emptyNote: 'No negative item feedback in this period.',
          },
          {
            name: 'Most appreciated',
            columns: [{ label: 'Item', width: 3 }, { label: 'Good ratings', width: 1.4, align: 'right' }, { label: 'Feedbacks', width: 1.2, align: 'right' }],
            rows: p.most_appreciated.map((x) => [x.label, x.count, x.feedbacks]),
            emptyNote: 'No positive item feedback in this period.',
          },
        ],
      };

    case 'returned-remade':
      return {
        ...base, key, slug: 'returned-remade', title: 'Returned / Remade / Replaced Report',
        subtitle: 'Every plate that went back to the kitchen, and what was done about it.',
        kpis: [
          { label: 'Returned', value: n0(s.returned) },
          { label: 'Remade', value: n0(s.remade) },
          { label: 'Replaced', value: n0(s.replaced) },
          { label: 'Cancelled', value: n0(s.cancelled) },
        ],
        tables: [
          {
            name: 'By item',
            columns: [
              { label: 'Item', width: 2.8 }, { label: 'Sold', width: 0.9, align: 'right' },
              { label: 'Returned', width: 1.1, align: 'right' }, { label: 'Remade', width: 1, align: 'right' },
              { label: 'Replaced', width: 1.1, align: 'right' }, { label: 'Cancelled', width: 1.2, align: 'right' },
              { label: 'R/R %', width: 0.95, align: 'right' }, { label: 'Happy', width: 0.95, align: 'right' },
            ],
            rows: p.menu_items
              .filter((m) => m.returned + m.remade + m.replaced + m.cancelled > 0)
              .sort((a, b) => (b.returned + b.remade) - (a.returned + a.remade))
              .map((m) => [
                m.menu_item, qtyText(m.sold), m.returned, m.remade, m.replaced, m.cancelled,
                pctText(rate(m.returned_qty + m.remade_qty, m.sold)), m.happy_after,
              ]),
            note: RETURN_REMAKE_BASIS,
            emptyNote: 'Nothing was returned, remade, replaced or cancelled in this period.',
          },
          recoveryTable,
        ],
      };

    case 'negative':
      return {
        ...base, key, slug: 'negative-feedback', title: 'Negative Feedback Report',
        subtitle: 'The complaints, with the rate beside the count.',
        kpis: [
          { label: 'Negative item feedbacks', value: n0(s.negative_item_feedbacks), sub: `of ${n0(s.item_feedbacks)} item feedbacks` },
          { label: 'Negative rate', value: pctText(rate(s.negative_item_feedbacks, s.item_feedbacks)) },
          { label: 'Poor overall', value: n0(s.poor) },
          { label: 'Follow-ups still open', value: n0(s.pending_follow_ups) },
        ],
        tables: [
          {
            name: 'Most common problems',
            columns: [{ label: 'Problem', width: 3 }, { label: 'Count', width: 1, align: 'right' }, { label: 'Share of negatives', width: 1.5, align: 'right' }],
            rows: p.common_problems.map((x) => [x.label, x.count, pctText(rate(x.count, s.negative_item_feedbacks))]),
            emptyNote: 'No issue was recorded against any item in this period.',
          },
          menuTable(p.menu_items.filter((m) => m.negative > 0)),
          recoveryTable,
        ],
      };

    case 'gre-performance':
      return {
        ...base, key, slug: 'gre-manager-performance', title: 'GRE / Manager Performance Report',
        subtitle: 'Coverage and follow-through only. No rating the guests gave appears in this report.',
        kpis: [
          { label: 'Venue coverage', value: pctText(s.coverage_pct), sub: `${n0(s.feedback_taken)} of ${n0(s.eligible_tables)} eligible tables` },
          { label: 'Follow-ups raised', value: n0(s.follow_ups_raised) },
          { label: 'Follow-ups completed', value: n0(s.follow_ups_completed) },
          { label: 'Still open', value: n0(s.pending_follow_ups) },
        ],
        tables: [
          {
            name: 'By person',
            // Measured widths (see the menuTable note). "Follow-ups
            // completed" and "Recovery follow-up %" both truncated to
            // "Follow-ups co…" / "Recovery follo…" at the old widths; the
            // note below carries the full meaning of each short heading.
            columns: [
              { label: 'Person', width: 2.0 }, { label: 'Role', width: 1.1 },
              { label: 'Tables', width: 0.9, align: 'right' },
              { label: 'Issues', width: 0.9, align: 'right' },
              { label: 'Raised', width: 0.9, align: 'right' },
              { label: 'Completed', width: 1.2, align: 'right' },
              { label: 'Open', width: 0.8, align: 'right' },
              { label: 'Recovery %', width: 1.2, align: 'right' },
            ],
            rows: p.gre_performance.map((g) => [
              g.person, g.role || '-', g.tables_visited, g.issues_recorded,
              g.follow_ups_raised, g.follow_ups_completed, g.follow_ups_open, pctText(g.recovery_pct),
            ]),
            note: 'Tables = eligible tables this person recorded feedback on. Issues = complaints '
              + 'they wrote down. Raised / Completed / Open = follow-ups they created, closed and '
              + `still owe. Recovery % = completed / raised. ${ISSUES_RECORDED_IS_NOT_A_PENALTY} `
              + `${COVERAGE_PER_GRE_UNAVAILABLE}`,
            emptyNote: 'Nobody recorded feedback in this period.',
          },
          dailyTable,
        ],
      };

    case 'guest-recovery':
    default:
      return {
        ...base, key: 'guest-recovery', slug: 'guest-recovery', title: 'Guest Recovery Report',
        subtitle: 'What happened after a guest complained - the follow-up, and whether it closed.',
        kpis: [
          { label: 'Follow-ups raised', value: n0(s.follow_ups_raised) },
          { label: 'Guest happy after correction', value: n0(s.happy_after_replacement) },
          { label: 'Partially happy', value: n0(s.partially_happy) },
          { label: 'Still unhappy', value: n0(s.still_unhappy) },
        ],
        tables: [
          recoveryTable,
          {
            name: 'By item',
            columns: [
              { label: 'Item', width: 2.8 }, { label: 'Negative', width: 1.1, align: 'right' },
              { label: 'Returned', width: 1.1, align: 'right' }, { label: 'Remade', width: 1, align: 'right' },
              { label: 'Replaced', width: 1.1, align: 'right' },
              { label: 'Happy', width: 0.95, align: 'right' }, { label: 'Still unhappy', width: 1.3, align: 'right' },
            ],
            rows: p.menu_items
              .filter((m) => m.negative + m.happy_after + m.still_unhappy > 0)
              .map((m) => [m.menu_item, m.negative, m.returned, m.remade, m.replaced, m.happy_after, m.still_unhappy]),
            emptyNote: 'No complaint needed recovery in this period.',
          },
          {
            name: 'Open complaints now (all dates)',
            columns: [{ label: 'Measure', width: 3 }, { label: 'Count', width: 1, align: 'right' }],
            rows: [['Follow-ups still open, every date', s.open_follow_ups_now]],
            note: 'Deliberately NOT bound by the period filter: an unresolved complaint from last week is still unresolved today, and a manager reading "Today" must not be told there are none.',
          },
        ],
      };
  }
}
