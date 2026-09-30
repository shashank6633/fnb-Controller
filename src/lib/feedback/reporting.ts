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
 * 🔴 AND THAT WAS NOT ENOUGH. A clean per-person TABLE does not save a page
 * whose PERSON FILTER narrows the sentiment sections. Measured on the P5
 * fixtures, `?gre=<name>`, the SAME person, the SAME five visits, the SAME
 * 41.7 % coverage - the only thing changed being what she wrote down:
 *
 *      records what the guests said   Excellent 1 . Average 4 (80%) . Negative 4
 *      records "everything good"      Excellent 5 (100%)            . Negative 0
 *
 * and both of those printed into a downloadable workbook headed with her name.
 * The honest GRE looked worse than the silent one, under her own name. That is
 * exactly the incentive the ruling forbids, so the fix is structural and it is
 * section 6's TWO-LAYER SCOPE: the person filter no longer touches a single
 * aggregate. It selects a person and answers, separately and only, the five
 * things the owner named.
 *
 * AND THE DENOMINATOR NOBODY HAD - THE OWNER HAS NOW SUPPLIED IT. There used to
 * be no column assigning a table to a GRE, so coverage per person had no honest
 * denominator. His ruling of 2026-09-23 settles it: **the floor is a default,
 * not a restriction** - a GRE assigned to a floor is MEASURED against that
 * floor, may still work any other floor, and is never blocked. So a person who
 * holds `users.preferred_zones` now has a real denominator (the eligible tables
 * on their own floor, inside the current filters) and gets a real coverage %;
 * a person with NO assignment keeps the old honest answer - counts, a share of
 * what was covered, and `COVERAGE_PER_GRE_UNAVAILABLE` on screen. Visits made
 * off their own floor are counted as work in `off_area_visits`, never dropped.
 * `src/lib/feedback/zones.ts` holds the rule and the reason it is not
 * `captain-area.ts`.
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
 * 6. THE TWO-LAYER SCOPE - the same shape commit 7158feb proved on Page 3
 * ════════════════════════════════════════════════════════════════════════════
 * The Tracker hit this first and the fix there is ratified, so Page 4 MIRRORS
 * it rather than inventing a second rule:
 *
 *   LAYER 1 - **Floor / Section / Captain** describe a part of the ROOM, so
 *     they move EVERY number on the page: the coverage denominator, the rating
 *     split, the tiles, the menu items, the recovery block, the daily rows.
 *     Asking about the Terrace means asking about the Terrace's tables AND the
 *     Terrace's visits, and that is a question about the restaurant.
 *
 *   LAYER 2 - **GRE / Manager** select a PERSON, and a person is not a part of
 *     the room. They therefore narrow **nothing at all** in the aggregates.
 *     What they do instead is fill in `person`, which carries exactly the five
 *     figures the owner named - Feedback Coverage, Tables Visited, Follow-Ups
 *     Completed, Issues Properly Recorded, Guest Recovery Follow-Up - and not
 *     one sentiment number beside them.
 *
 *     ⚠️ THE OLD BEHAVIOUR AND WHY IT WAS A DEFECT, not a preference. The
 *     person filter used to narrow the VISITS, which fed the rating split, the
 *     four red/amber tiles, Most Complained and Service Recovery. Every one of
 *     those improves when a GRE records LESS. Section 4 carries the measurement.
 *     `person` moves under the flip only in the direction the owner wants -
 *     `issues_recorded` 4 vs 0, which is a CREDIT - and nothing else moves at
 *     all. Seven of the eight downloads take `&gre=`, so this had to be fixed
 *     in THIS file, where the screen and the exports share one computation.
 *
 *   - **Food/Drinks / Menu Item** narrow the ITEM-LEVEL rows only. They do not
 *     touch coverage at all: a table was still visited whether or not the guest
 *     mentioned a drink.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 7. TWO COUNTS OF "FEEDBACKS", AND THEY ARE NOT THE SAME COUNT
 * ════════════════════════════════════════════════════════════════════════════
 * A visit can exist on a table that never became ELIGIBLE - the trigger is an
 * admin setting that can be raised mid-service, and a GRE may simply choose to
 * visit a two-item table. That visit is real work and its rating is real
 * feedback, but it is not coverage of a table anybody was owed.
 *
 * The first cut had ONE field, `feedback_taken`, used for both, and the two
 * disagreed inside a single exported workbook: the Summary sheet read
 * "Feedbacks taken 9" while the Rating split sheet accounted for 10. So there
 * are now two named numbers and an invariant that is asserted, not assumed:
 *
 *     feedbacks_recorded      every visit in scope        <- the rating split
 *     eligible_tables_covered visits on ELIGIBLE tables   <- coverage numerator
 *     extra_visits            the difference, always >= 0
 *
 *     excellent + good + average + poor + unrated === feedbacks_recorded
 *     eligible_tables_covered + extra_visits      === feedbacks_recorded
 *
 * `coverage_pct` is `eligible_tables_covered / eligible_tables`, and the extra
 * visits are in NEITHER side of it - which is what makes the ratio mean what it
 * says. Page 3 (`tracker/query.ts`) computes the identical pair from the
 * identical rule; before this change it put the extra visit in BOTH sides and
 * the two pages reported 13/10/76.9 % against 12/9/75.0 % for one service with
 * no filters set.
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
import { GRE_ROLE_NAME } from './access';
import {
  areaCovers,
  readGreAreas,
  AREA_ASSIGNED_NOTE,
  AREA_UNASSIGNED,
  AREA_UNASSIGNED_NOTE,
} from './zones';

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
  /** `gf_visits.gre_name` - narrows the RECORD-LEVEL sections only, and never
   *  the order universe or any venue aggregate (see 6 and `VenueFilters`). */
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

/* ────────────────────────────────────────────────────────────────────────────
   2b. THE TWO SCOPES, MADE STRUCTURAL — D11(a)
   ────────────────────────────────────────────────────────────────────────────
   The owner's ruling: the GRE / Manager filter narrows ONLY the RECORD-LEVEL
   sections (the comments, the menu items, the recovery queue). The RATING SPLIT
   and the four red/amber negative tiles stay VENUE-WIDE no matter whose name is
   picked, because "the system should not judge GRE performance based on
   positive feedback" and "a GRE should never avoid recording negative feedback
   because it affects their performance".

   His word for how strong that has to be was STRUCTURALLY IMPOSSIBLE, so it is
   not a convention and not a comment. Two things below enforce it:

     · `VenueFilters` — an `AnalyticsFilters` whose `gre` and `manager` are typed
       `never`. A computation handed one of these CANNOT read a person out of it,
       because there is nothing there to read. `venueFilters()` is the only way
       to make one and it deletes both keys.

     · `VenueRows<T>` / `RecordRows<T>` — the row arrays, branded. The venue
       aggregates (`venueSummary`, `venueCategories`, `venueDaily`,
       `grePerformance`) accept `VenueRows` and nothing else; the record
       sections accept `RecordRows` and nothing else. Handing the narrowed
       array to the rating split is a COMPILE ERROR, not a review miss.

   Before this, one line (`const visits = allVisits`) was the whole protection,
   and it protected by never narrowing anything at all — which also left the
   half of the ruling that SHOULD narrow unbuilt. Now both halves exist and
   neither can leak into the other.

   ⚠️ THE BRANDS COVER FUNCTION BOUNDARIES. They do NOT, on their own, cover a
   fresh expression written inline over a row's own fields — and that is exactly
   where the next defect landed. Read 2c: a RATE can mix the two scopes without
   either lane ever being handed to the wrong function.
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Filters with the person REMOVED AT THE TYPE LEVEL — the "filter that cannot
 * carry a person". Everything that must stay venue-wide is computed from one of
 * these, so narrowing a venue figure to a name is not something a later edit
 * can do by forgetting: `f.gre` on a `VenueFilters` is `never`.
 */
export type VenueFilters = Omit<AnalyticsFilters, 'gre' | 'manager'> & {
  gre?: never;
  manager?: never;
};

/** The only constructor. It DELETES the two keys rather than blanking them, so
 *  a value that somehow survives the type system still cannot be read back. */
export function venueFilters(f: AnalyticsFilters): VenueFilters {
  const { gre: _gre, manager: _manager, ...rest } = f;
  return rest as VenueFilters;
}

declare const VENUE_SCOPE: unique symbol;
declare const RECORD_SCOPE: unique symbol;

/** Rows covering the whole ROOM — the selected period, floor, section and
 *  captain, and EVERY recorder in it. The venue aggregates take only these. */
export type VenueRows<T> = readonly T[] & { readonly [VENUE_SCOPE]: true };

/** Rows narrowed to the selected person (identical to `VenueRows` content when
 *  no name is picked). The record-level sections take only these. */
export type RecordRows<T> = readonly T[] & { readonly [RECORD_SCOPE]: true };

/** The two brands, applied. These two lines are the ONLY casts: every other
 *  place in this file is checked. Keep them next to each other so a reader can
 *  see that neither one filters — the narrowing happens once, in `analytics()`,
 *  and is visible there. */
const asVenue = <T,>(rows: readonly T[]): VenueRows<T> => rows as VenueRows<T>;
const asRecord = <T,>(rows: readonly T[]): RecordRows<T> => rows as RecordRows<T>;

/* ─── 2c. THE THIRD SHAPE THE BRAND HAS TO COVER: A RATE ─────────────────────
   D11(a) branded the row ARRAYS, which stopped a narrowed array being handed to
   a venue aggregate — and that guard is real (negative control: TS2345). It did
   NOT stop the other half of the same mistake: a rate whose NUMERATOR is read
   off a narrowed row while its DENOMINATOR is a venue cell on the same row.

   That is exactly what shipped. `MenuItemRow` carried `returned_qty` /
   `remade_qty` (narrowed under a person filter, because `buildMenuItems` is fed
   the record rows) next to `sold` (always the venue's plates), and three call
   sites wrote `rate(m.returned_qty + m.remade_qty, m.sold)`. One dish printed
   three different Return / Remake Rates depending on whose name was picked —
   measured on a fixture where Steady Gre returned 2 plates of Paneer Tikka, the
   venue sold 12, and Probe Gre had merely cancelled one:

       no filter        16.7%   (2 venue / 12 venue)   correct
       &gre=Probe Gre    0.0%   (0 HERS  / 12 venue)   two populations
       &gre=Steady Gre  16.7%

   Return / Remake Rate is a VENUE statistic: a GRE does not sell plates, so
   neither side of the ratio is hers, and a narrowed numerator can only ever
   UNDER-report the dish. So the rate is computed ONCE, from the venue rows, and
   travels on the row as a finished number:

     · `returned_qty` / `remade_qty` are GONE from `MenuItemRow`. They existed
       only to feed this rate, so removing them removes the ingredients: an edit
       that tries the old expression now fails with TS2339 rather than printing
       a wrong percentage.
     · `VenueRate` is a branded number. `return_remake_pct` is typed as one, so
       assigning a plain `rate(...)` computed anywhere else raises TS2322 even if
       someone re-adds per-person quantities to the row.
     · `venueReturnRemakeRates()` is the only constructor, and it takes
       `VenueRows<ItemFeedbackRow>`. Handing it the record rows is TS2345, the
       same negative control the row brands already pass.

   Neg % is NOT this bug and is deliberately untouched: `rate(m.negative,
   m.feedbacks)` narrows on BOTH sides, so it is one population either way.
   ──────────────────────────────────────────────────────────────────────────── */

/** A percentage whose numerator AND denominator both came from `VenueRows`.
 *  `null` keeps the "no denominator" answer distinct from 0% — see `rate()`.
 *  The brand is phantom: it survives `JSON.stringify` as a plain number, so the
 *  screen reads the same field the sheets do. */
export type VenueRate = (number & { readonly [VENUE_SCOPE]: true }) | null;

/** The venue's Return / Remake Rate for every dish in scope, keyed by
 *  `item_key`. Built once by `venueReturnRemakeRates()` and stamped onto every
 *  menu-item row in BOTH lanes, so the record lane cannot compute its own. */
export type VenueRrRates = ReadonlyMap<string, VenueRate>;

/** The filters as sentences. Written into EVERY export - a spreadsheet that
 *  does not say it is one floor on one night is a spreadsheet that will be
 *  read as the whole venue for the month.
 *
 *  The GRE / Manager line says what it narrows AND what it does not, sentence
 *  by sentence. ALL EIGHT downloads accept `&gre=`, and a file headed only
 *  "GRE: <name>" reads as that person's scorecard - which is precisely the
 *  reading the fairness ruling forbids. Under D11(a) the filter now DOES narrow
 *  three sections, so this line can no longer say "nothing else": it has to say
 *  which sheets moved and which did not, or a reader will apply the wrong scope
 *  to whichever half they happen to look at. */
export function filterLines(r: ResolvedRange, f: AnalyticsFilters): string[] {
  const out = [`Period: ${r.label}`];
  if (r.note) out.push(`Period note: ${r.note}`);
  out.push(`Business-day rollover: ${r.cutoff} IST (${r.cutoffSource === 'hr_day_cutoff' ? 'from hr_day_cutoff' : 'module default'})`);
  out.push(`Floor: ${isAll(f.floor) ? 'All floors' : String(f.floor)}`);
  out.push(`Section: ${isAll(f.section) ? 'All sections' : String(f.section)}`);
  out.push(`Captain: ${isAll(f.captain) ? 'All captains' : String(f.captain)}`);
  const person = !isAll(f.gre) ? String(f.gre).trim() : !isAll(f.manager) ? String(f.manager).trim() : '';
  out.push(`GRE: ${isAll(f.gre) ? 'All' : String(f.gre)}`);
  out.push(`Manager: ${isAll(f.manager) ? 'All' : String(f.manager)}`);
  if (person) {
    out.push(
      `What the ${isAll(f.gre) ? 'Manager' : 'GRE'} filter NARROWED to ${person}: the "What ${person} `
      + 'did" sheet, the menu-item sheets (Menu item analysis, Most complained, Most appreciated, '
      + 'Most common problems, By item) and the Service recovery sheet. Those list what THIS PERSON '
      + 'wrote down - EXCEPT the two columns marked * on Menu item analysis and By item. Sold* and '
      + 'R/R %* are the VENUE\'S figures for that dish, because nobody records a plate being sold and '
      + 'a return rate is not a measure of whoever wrote the complaint down. The rest of each row is '
      + 'this person\'s.',
    );
    out.push(
      `What the ${isAll(f.gre) ? 'Manager' : 'GRE'} filter did NOT narrow: the Summary tiles, the `
      + 'Rating split sheet, the Category ratings sheet and the By day sheet. Those cover the WHOLE '
      + 'selected floor, section, captain and period, whoever recorded them, and they do not move '
      + 'when a name is picked. That is deliberate: no rating and no complaint count in this file '
      + `is a judgement of ${person}, so recording what a guest actually said can never make their `
      + 'numbers look worse. Do not read this file as an appraisal of them.',
    );
  }
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

/**
 * The coverage denominator. It takes `VenueFilters`, NOT `AnalyticsFilters`:
 * the order universe is the ROOM and a person is not a part of the room, so the
 * person is removed from the argument before it arrives rather than merely left
 * unread inside. `f.gre` in here is `never` — there is nothing to narrow by.
 */
export function loadUniverse(
  db: Database.Database,
  outletId: string,
  r: ResolvedRange,
  f: VenueFilters,
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
  /** `gf_visits.gre_user_id` — the key the floor assignment is read by. */
  gre_user_id: string;
  table_id: string;
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
  /** Plates sold in scope - SUM(order_items.quantity), not a row count.
   *
   *  ⚠️ ALWAYS THE VENUE'S, in both lanes. A GRE does not sell plates, so there
   *  is no person-scoped version of this number to have. Under a person filter
   *  this cell and `return_remake_pct` are the only two venue cells in a row
   *  whose others are her records, and both the sheet columns and the table note
   *  say so — see the `Sold*` / `R/R %*` headings in `buildReport`. */
  sold: number;
  feedbacks: number;
  negative: number;
  returned: number;
  remade: number;
  replaced: number;
  cancelled: number;
  /** THE VENUE'S Return / Remake Rate for this dish: (plates returned + plates
   *  remade) / plates sold, both sides counted over every recorder in scope.
   *
   *  Branded, and computed only by `venueReturnRemakeRates()` from
   *  `VenueRows<ItemFeedbackRow>`. This replaces the `returned_qty` /
   *  `remade_qty` pair that used to sit here: those were narrowed by the person
   *  filter while `sold` was not, so the three call sites that divided one by
   *  the other printed a person-over-venue ratio under a venue-over-venue
   *  sentence. Read 2c before adding a quantity column back. */
  return_remake_pct: VenueRate;
  happy_after: number;
  still_unhappy: number;
  good: number;
  comments: number;
}

export interface GrePerformanceRow {
  person_id: string;
  person: string;
  role: string;
  /** 'gre' recorded carrying the GRE role · 'management' recorded as
   *  management · 'assigned' holds the GRE role and recorded NOTHING in this
   *  period — the row a management page most needs and the one a visit-driven
   *  query cannot produce. Same three values as Page 3's `kind`. */
  kind: 'gre' | 'management' | 'assigned';
  /** DISTINCT eligible tables they recorded on — Page 3's "Tables", same rule. */
  tables_visited: number;
  /** Their visits on eligible tables — Page 3's "Taken", same rule. Differs
   *  from `tables_visited` only when one table seated twice in a service. */
  taken: number;
  /** Every visit of theirs in scope, eligible table or not. */
  feedbacks_recorded: number;
  issues_recorded: number;
  follow_ups_raised: number;
  follow_ups_completed: number;
  follow_ups_open: number;
  /** Completed / raised. A process measure - see section 4. */
  recovery_pct: number | null;
  /** Their share of the tables that WERE covered. Not a coverage %. */
  share_pct: number | null;
  /* ── the owner's floor ruling (section 4). Null when unassigned. ───────── */
  /** Floors assigned to this person, or [] when none. */
  area_zones: string[];
  area_assigned: boolean;
  /** Eligible tables on THEIR floor, inside the current filters. */
  area_eligible: number | null;
  /** Of those, the ones they recorded on. */
  area_covered: number | null;
  /** `area_covered / area_eligible`. Null when there is no assignment — the
   *  honest "no denominator" answer, which is what shipped before. */
  area_coverage_pct: number | null;
  /** Visits they made on tables that are NOT theirs. Counted, never dropped:
   *  helping on another floor is work, and the owner's rule is that nobody is
   *  ever blocked from it. They are inside `tables_visited`. */
  off_area_visits: number;
}

/**
 * What the GRE / Manager filter answers, and the ONLY thing it answers.
 * Every field here is one of the five the owner named, or the provenance of
 * one. There is deliberately no rating, no negative count, no ratio of
 * complaints, and no happiness column.
 */
export interface PersonScope extends GrePerformanceRow {
  /** Human sentence naming the floors this person is measured against. */
  area_label: string;
  /** Why the coverage figure is the shape it is — printed on screen and into
   *  every export that carries this block. */
  coverage_basis: string;
}

/* ── 🔒 THE FAIRNESS RULING, ENFORCED BY THE COMPILER ────────────────────────
   "The system should not judge GRE performance based on positive feedback. A
   GRE should never avoid recording negative feedback because it affects their
   performance."

   The defence of that ruling is a NEGATIVE: this payload has 21 keys and not
   one of them is a rating, a sentiment or a happiness count. A negative is the
   easiest thing in a codebase to lose, because losing it looks like adding a
   useful column. A comment saying "no rating here" cannot stop that; these
   three lines can, and they cost nothing at runtime — they are types.

   `npx tsc --noEmit` FAILS if a key is added, removed or renamed without the
   list below being changed in the same edit, and fails outright if any key name
   carries a sentiment word. Both halves were exercised, not assumed: adding
   `guest_rating_avg` to PersonScope raises TS2344 on _KeysCarryNoSentiment, and
   deleting one entry from the list raises TS2344 on _KeysAreExactly21.
   If you are here because the build broke: adding a SENTIMENT key is the thing
   the ruling forbids. Adding a WORK key (something the GRE did) is allowed —
   put it in the list and change the 21. */
type _True<T extends true> = T;
type _Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Every key of `PersonScope`, in declaration order. Length is the 21. */
type PersonScopeKeys = [
  'person_id', 'person', 'role', 'kind',
  'tables_visited', 'taken', 'feedbacks_recorded',
  'issues_recorded', 'follow_ups_raised', 'follow_ups_completed', 'follow_ups_open',
  'recovery_pct', 'share_pct',
  'area_zones', 'area_assigned', 'area_eligible', 'area_covered', 'area_coverage_pct',
  'off_area_visits', 'area_label', 'coverage_basis',
];

/** A key whose NAME is about how the guest felt, rather than what the GRE did. */
type SentimentWord =
  | 'rating' | 'rated' | 'excellent' | 'good' | 'average' | 'poor' | 'unrated'
  | 'happy' | 'unhappy' | 'negative' | 'positive' | 'sentiment' | 'score'
  | 'star' | 'complaint' | 'comment';
type CarriesSentiment<K extends string> =
  K extends `${string}${SentimentWord}${string}` ? K : never;

type _KeysAreExactly21 = _True<_Exact<keyof PersonScope, PersonScopeKeys[number]>>;
type _CountIs21 = _True<_Exact<PersonScopeKeys['length'], 21>>;
type _KeysCarryNoSentiment = _True<_Exact<CarriesSentiment<keyof PersonScope & string>, never>>;
export type PersonScopeIsFair = [_KeysAreExactly21, _CountIs21, _KeysCarryNoSentiment];

export const ISSUES_RECORDED_IS_NOT_A_PENALTY =
  'Issues Recorded counts complaints a GRE wrote down. It is a CREDIT, never a penalty: '
  + "the owner's ruling is that a GRE must never have a reason to avoid recording a complaint. "
  + 'Nothing on this page ranks a GRE by the ratings guests gave.';

export const COVERAGE_PER_GRE_UNAVAILABLE =
  'A person with NO floor assigned shows "-" rather than a coverage %: nothing else in this app '
  + 'assigns a table to a GRE, so there would be no honest denominator, and an invented one in a '
  + 'performance table is worse than no number. Their figures are counts, and the coverage % beside '
  + 'them is the venue\'s for the current filters.';

export const RECOVERY_IS_A_QUEUE =
  'Guest recovery is printed as a QUEUE, not a score: "1/3" means one of the three complaints '
  + 'this person raised has been closed, and "none raised" means they raised none in this period. '
  + 'Never read "none raised" as better than an open queue - it is the OPPOSITE way round. A GRE '
  + 'who records two complaints and has not revisited them yet has work to do; a GRE who recorded '
  + 'nothing has nothing to show for the same tables.';

/**
 * 🔒 THE OWNER'S METRIC, PRINTED SO IT CANNOT BE READ BACKWARDS.
 *
 * Guest Recovery Follow-Up is one of the five figures the owner named, so it
 * stays on the page. What had to change is how it PRINTS. Measured on the
 * fairness flip: a GRE who recorded two complaints and had not yet revisited
 * them printed `0.0%`, while a GRE who recorded NOTHING printed `-` in the same
 * column. Side by side, the honest one looks worse and the silent one looks
 * clean - and `-` sorts above `0.0%` in a spreadsheet, which puts the silent
 * one on top. Both readings are the incentive the fairness ruling forbids.
 *
 * So a ratio is never printed alone. `completed/raised` carries its own
 * denominator, and an empty queue says so in words instead of with a dash that
 * looks like a better number.
 */
export function recoveryCell(completed: number, raised: number): string {
  if (!raised) return 'none raised';
  return `${Math.round(completed)}/${Math.round(raised)} · ${pctText(rate(completed, raised))}`;
}

/** The same figure with room to explain itself - for the person block and the
 *  "What <name> did" sheet, where the column is a sentence wide. */
export function recoveryLong(completed: number, raised: number): string {
  // Short on purpose: this string lands in the person sheet's Value column
  // (115.9pt usable at the shipped weights) and a truncated explanation is
  // worse than a brief one. The full reading is in RECOVERY_IS_A_QUEUE under
  // the table.
  if (!raised) return 'none raised';
  // 🐞 THE QUEUE LEADS. THE RATE FOLLOWS. This line used to read
  // "0.0% - 0 of 2 closed", and it was the last place in the module where the
  // RATIO came first. Everywhere else the queue leads - the tile prints `0/2`,
  // the By person cell prints `0/2 · 0.0%` - and in a RIGHT-ALIGNED column the
  // leading token is what the eye lands on. So the honest GRE's row opened with
  // "0.0%" while the GRE who raised nothing opened with a word, which is the
  // same misreading the dash used to cause, one step milder.
  // Identical characters, identical width (measured: 70.70pt for "0 of 2
  // closed - 0.0%", exactly what the old order measured), so nothing about the
  // geometry moves - only what is read first.
  return `${Math.round(completed)} of ${Math.round(raised)} closed - ${pctText(rate(completed, raised))}`;
}

/** The seven rows of the recovery queue, by stable identity rather than wording. */
export type RecoveryKey =
  'negative' | 'returned' | 'remade' | 'replaced' | 'happy' | 'partial' | 'unhappy';

export interface AnalyticsPayload {
  range: ResolvedRange;
  filters: AnalyticsFilters;
  summary: {
    eligible_tables: number;
    all_tables: number;
    /** EVERY visit in scope. The rating split's population — see section 7. */
    feedbacks_recorded: number;
    /** Visits on ELIGIBLE tables. The coverage numerator — see section 7. */
    eligible_tables_covered: number;
    /** `feedbacks_recorded - eligible_tables_covered`. Always >= 0. */
    extra_visits: number;
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
  /**
   * WHICH POPULATION THE RECORD-LEVEL SECTIONS BELOW DESCRIBE — D11(a).
   *
   * `menu_items`, `common_problems`, `most_complained`, `most_appreciated` and
   * `recovery` are RECORD-level: the owner ruled that a GRE / Manager filter
   * narrows them to that person's own records. `summary`, `categories` and
   * `daily` are VENUE-level and never narrow. Two scopes in one payload need a
   * label or a reader will apply the wrong one, and the two rate denominators
   * here exist so a narrowed numerator is never divided by a venue total.
   *
   * THIS IS NOT THE PERSON PAYLOAD. `PersonScope` / `GrePerformanceRow` stay at
   * 21 keys with ZERO sentiment keys - that is the fairness ruling and it is
   * unchanged. This block describes the SECTIONS, not the person: it carries no
   * per-person score, nothing here is ordered by anybody, and it says the same
   * words whether the person recorded everything or nothing.
   */
  records: {
    /** 'venue' with no name picked; 'person' when one is. */
    scope: 'venue' | 'person';
    /** The name the record sections were narrowed to. '' when scope is 'venue'. */
    person: string;
    /** Item feedbacks BEHIND these sections. The `Neg %`-style denominator. */
    item_feedbacks: number;
    /** Negative item feedbacks behind these sections - the "Share of negatives"
     *  denominator. NOT `summary.negative_item_feedbacks`, which is the venue
     *  tile: dividing a narrowed count by the venue total printed shares that
     *  did not add to 100 %. */
    negative_item_feedbacks: number;
    /** Distinct items SOLD in the room. Stays venue even when the rows narrow,
     *  because "of N items sold" is a fact about the kitchen, not the recorder. */
    items_sold: number;
    /** One sentence naming the scope, for the screen and every sheet. '' when
     *  scope is 'venue'. */
    note: string;
  };
  menu_items: MenuItemRow[];
  common_problems: { label: string; count: number }[];
  most_complained: { label: string; count: number; feedbacks: number; negative_pct: number | null }[];
  most_appreciated: { label: string; count: number; feedbacks: number }[];
  /** THE RECOVERY QUEUE — record-level under D11(a). `key` is stable across both
   *  scopes so a caller can read one outcome without matching on the label, which
   *  changes wording when a name is picked (see `analytics()`). */
  recovery: { key: RecoveryKey; label: string; count: number }[];
  gre_performance: GrePerformanceRow[];
  /** Filled ONLY when a GRE / Manager filter is set. Null otherwise. When it is
   *  set, the ONLY other things that move are the record-level sections named in
   *  `records` — section 6, layer 2, as the owner amended it in D11(a). */
  person: PersonScope | null;
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
    /** Guest recovery is a WORK QUEUE, not a score - printed on screen and in
     *  every export that carries the per-person table. */
    recovery_is_a_queue: string;
    negative_pct_basis: string;
    return_remake_basis: string;
    /** The `Sold*` / `R/R %*` sentence (2c), or '' when no name is picked and
     *  there is no second scope in the row to distinguish. The SCREEN cannot
     *  import a constant out of this file — it is a client component and this
     *  module pulls in better-sqlite3 — so the sentence travels in the payload,
     *  which is also what keeps the screen and all eight downloads saying the
     *  same words. Its truthiness is the single switch for the `*` marks. */
    venue_columns_basis: string;
    generated_at: string;
    /** The sentence section 6 is about, printed on screen and into every
     *  export: which layer of the scope each number on the page belongs to. */
    counts_scope: string;
    /** True when a GRE / Manager filter is in force. It changes `person` and
     *  NOTHING else — the flag exists so the screen can say so, never so a
     *  reader has to infer it. */
    person_filter_active: boolean;
    /** The three reconciliations of section 7, evaluated on this payload. All
     *  true is the only acceptable value; a false is a defect signal that
     *  travels with the data instead of living in a test. */
    reconciles: { rating_split: boolean; coverage_split: boolean; taken_subset: boolean };
  };
}

const NOTE_SECTIONS_EMPTY =
  'No sections defined on the tables in this period - restaurant_tables.section is empty for '
  + 'every table in scope, so there is nothing to filter by.';

export const NEGATIVE_PCT_BASIS =
  'Negative % = negative feedbacks / feedbacks received for that item. Both sides count feedback '
  + 'rows, so a dish nobody was asked about cannot look good and a popular dish cannot look bad.';

/* The sentence and the number it sits beside MUST agree about the population.
   This one said "both sides are quantities" of "plates SOLD" — a venue-over-
   venue sentence — while the cell next to it divided ONE RECORDER's plates by
   the venue's. It now names the scope out loud, so a manager reading a GRE's
   e-mailed workbook cannot read the dish's rate as that GRE's rate. See 2c. */
export const RETURN_REMAKE_BASIS =
  'Return / Remake Rate = plates returned + remade / plates SOLD. Both sides are quantities: the '
  + 'numerator sums gf_item_feedback.quantity, so one feedback on a line of three counts three. '
  + 'BOTH SIDES ARE THE WHOLE VENUE, always: every recorder on the selected floor, section, captain '
  + 'and period. It is a fact about the DISH and never a measure of whoever wrote the feedback down, '
  + 'so it does not change when a GRE or Manager name is picked.';

/** Attached to the menu-item sheets ONLY under a person filter, where the table
 *  genuinely mixes two scopes row by row. The `*` it defines is put on those two
 *  headings in the same case: the headings are width-measured against the PDF
 *  renderer's own font (see the `menuTable` note), and 'Sold (venue)' / 'R/R %
 *  (venue)' do not fit the measured columns, whereas one asterisk does. */
export const VENUE_COLUMNS_IN_RECORD_TABLE =
  'THE TWO COLUMNS MARKED * ARE THE VENUE\'S, NOT THIS PERSON\'S. Sold* is every plate the venue '
  + 'sold of that dish and R/R %* is the venue\'s return / remake rate for it; every other cell in '
  + 'the row counts only what this person recorded. The two are kept side by side deliberately - a '
  + 'rate with no denominator beside it cannot be checked - but neither is a figure about them.';

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
  // The VENUE filter, built once. Section 2b: everything that must not move when
  // a name is picked is computed from this, and it has no person in it to move to.
  const vf = venueFilters(f);
  const u = loadUniverse(db, opts.outletId, r, vf);

  const orderById = new Map(u.orders.map((o) => [o.order_id, o]));
  const eligibleIds = new Set(u.eligible.map((o) => o.order_id));

  /* -- visits ---------------------------------------------------------- */
  const visitRows = selectIn(
    db,
    `SELECT id, order_id, table_id, table_number, floor, gre_user_id, gre_name, gre_role,
            overall_rating, cat_food, cat_drinks, cat_service, cat_ambience, everything_good,
            comment, status, has_negative, created_at
       FROM gf_visits WHERE order_id IN (@@)`,
    u.orders.map((o) => o.order_id),
  );

  const allVisits: VisitRow[] = visitRows.map((v: any) => {
    const o = orderById.get(String(v.order_id));
    return {
      visit_id: String(v.id),
      order_id: String(v.order_id),
      gre_user_id: String(v.gre_user_id ?? ''),
      table_id: String(o?.table_id ?? v.table_id ?? ''),
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
  // `greNamesRecorded` is only HALF of the GRE list: the silent role holders are
  // unioned in below, once the per-person table has been built. See there.
  const greNamesRecorded = uniqSorted(allVisits.filter((v) => !isManagementRole(v.gre_role)).map((v) => v.gre_name).filter(Boolean));
  const managers = uniqSorted(allVisits.filter((v) => isManagementRole(v.gre_role)).map((v) => v.gre_name).filter(Boolean));

  // 🔒 SECTION 6, LAYER 2, AS THE OWNER AMENDED IT IN D11(a). THIS IS THE ONLY
  // PLACE IN THE FILE WHERE A PERSON NARROWS ANYTHING. Read 2b first.
  //
  // `visits` is the ROOM and stays the room: the rating split, the four
  // red/amber negative tiles, the category ratings, the daily rows, the coverage
  // denominators and the per-person table are all computed from it, and none of
  // them moves when a name is picked. It is branded `VenueRows` so that cannot
  // change by accident — see 2b.
  //
  // `recordVisits` is the same list narrowed to the selected person, and it
  // feeds ONLY the three sections the owner named: the menu items, the recovery
  // queue and (in `itemComments()`) the comments. It is branded `RecordRows`, so
  // handing it to a venue aggregate does not compile.
  //
  // Measured on the earlier tip, `?gre=<name>`, the same person and the same
  // five visits: recording honestly gave Excellent 1 / Average 4 / Negative 4;
  // recording "everything good" gave Excellent 5 (100 %) / Negative 0 — in a
  // downloadable workbook headed with her name. The venue lane below is what
  // makes that unreachable, and it is unreachable for the RATINGS whatever the
  // record lane does.
  //
  // ⚠️ THE FILTER IS A NAME, NOT AN ID. `f.gre` carries `gf_visits.gre_name`,
  // which is what the dropdown offers, what `personScope()` looks up and what
  // `filterLines()` prints, so the narrowing matches by name too — anything else
  // would silently drop the records of a second person sharing a display name.
  // `grePerformance()` keys by USER ID where it has one, so two people with one
  // display name get two rows there and the person block shows the first; when
  // that happens `records.note` says so rather than leaving the reader to
  // discover that the two halves count different people.
  const personName = !isAll(f.gre) ? String(f.gre).trim() : !isAll(f.manager) ? String(f.manager).trim() : '';
  const visits = asVenue(allVisits);
  const recordVisits = asRecord(
    personName ? allVisits.filter((v) => v.gre_name === personName) : allVisits,
  );
  const recordVisitIds = new Set(recordVisits.map((v) => v.visit_id));

  // Section 7's coverage numerator is derived INSIDE `venueSummary()` and
  // `venueDaily()` from the venue rows, so there is no narrowed numerator lying
  // around for a later edit to pick up by name. See those two functions.
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

  // VENUE: the Food/Drinks and Menu Item filters narrow items for everyone,
  // because those are properties of the DISH, not of the recorder.
  const items = asVenue(
    allItems.filter(
      (x) =>
        (!groupWanted || x.group === groupWanted)
        && (!itemWanted || x.item_name.toLowerCase().includes(itemWanted)),
    ),
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
  const followUps = asVenue(
    groupWanted || itemWanted
      ? allFollowUps.filter((x) => keptItemIds.has(x.item_feedback_id))
      : allFollowUps,
  );

  /* -- THE RECORD LANE -------------------------------------------------- */
  // D11(a): the same rows, narrowed to the selected person, for the three
  // sections the owner said the filter should narrow — and for nothing else.
  // With no name picked these are the venue rows, element for element, so the
  // record sections are the venue's own records by default and the two lanes
  // are provably identical in the unfiltered case (measured: byte-identical).
  const recordItems = asRecord(items.filter((x) => recordVisitIds.has(x.visit_id)));
  const recordFollowUps = asRecord(followUps.filter((x) => recordVisitIds.has(x.visit_id)));

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

  // 🔒 THE RETURN / REMAKE RATE, ONCE, FROM THE ROOM (2c). Built here, from the
  // VENUE rows and the venue's plates, and handed to BOTH lanes below — so the
  // cell is the same percentage whether or not a name is picked, and there are
  // no per-person quantities left on a row for a later edit to divide by `sold`.
  const rrRates = venueReturnRemakeRates(items, soldByKey);

  /* -- aggregates ------------------------------------------------------ */
  // 🔒 THE VENUE AGGREGATES NO LONGER LIVE HERE. The rating split, the four
  // red/amber negative tiles, the coverage denominators and the daily rows are
  // computed by `venueSummary()`, `venueCategories()` and `venueDaily()` further
  // down, which take `VenueFilters` + `VenueRows` and therefore cannot see a
  // person at all. They used to be inline `ratingCount` / `act` / `happy` /
  // `partial` / `unhappy` locals sitting beside the record-level ones — two sets
  // of near-identical names in one scope, where pointing the wrong one at the
  // rating split was a one-character mistake that compiled. Those locals are
  // gone deliberately; do not reintroduce them here.
  const openNowAllTime = countOpenFollowUpsNow(db);

  /* -- the record-level sections (D11(a)) ------------------------------- */
  // `menuItems` is what the screen and the sheets DRAW, so it is the narrowed
  // one. `venueMenuItemNames` exists for the Menu item DROPDOWN only: picking a
  // GRE must not empty the list the next filter is chosen from, which is the
  // same law the GRE dropdown itself already follows a few lines below.
  //
  // The sold-but-uncommented rows are seeded ONLY in the venue list. Under a
  // person filter a row reading "Sold 12 · Feedbacks 0" is neither that person's
  // record nor a fact about the dish — it is 45 rows of fabricated silence that
  // make a narrowed table look like an unnarrowed one, which is exactly the
  // "recorded nothing, therefore looks clean" reading the owner ruled against.
  //
  // `rrRates` goes to BOTH calls unchanged: it is the venue's rate either way,
  // which is the whole of the 2c fix.
  const menuItems = buildMenuItems(recordItems, recordFollowUps, soldByKey, groupWanted, itemWanted, !personName, rrRates);
  const venueMenuItems = personName
    ? buildMenuItems(items, followUps, soldByKey, groupWanted, itemWanted, true, rrRates)
    : menuItems;

  const recAct = (a: ActionTaken) => recordItems.filter((x) => x.action_taken === a).length;
  const recNegatives = recordItems.filter((x) => x.is_negative).length;
  const recHappy = recordFollowUps.filter((x) => x.happiness === 'happy').length;
  const recPartial = recordFollowUps.filter((x) => x.happiness === 'partial').length;
  const recUnhappy = recordFollowUps.filter((x) => x.happiness === 'unhappy').length;

  // The per-person table. Seeded from the people who HOLD the role, not from
  // the visits, so a GRE who recorded nothing still has a row — total silence
  // is the one behaviour a management page must be able to see. Section 4's
  // floor denominator is applied here.
  const gre = grePerformance(db, u, visits, items, followUps, eligibleIds);

  // 🐞 THE FILTER THAT EXAMINES ONE PERSON MUST OFFER THE SILENT ONE. The table
  // above is seeded from the people who HOLD the GRE role, so a GRE who recorded
  // nothing all night still has a row — but this dropdown was built from visits
  // alone, so that same person could not be PICKED. Measured on the tip before
  // this change, one fixture night: the grid read [Ambika(gre), Bhavna(gre),
  // Chandra(gre), Manjula(management), Divya(assigned), Silent Gre(assigned)]
  // while the dropdown offered [Ambika, Bhavna, Chandra] — and for that same
  // night PAGE 3 OFFERED 5 NAMES AND PAGE 4 OFFERED 3. The two missing were
  // exactly the role holders who recorded nothing: the row this page's own sheet
  // note calls the point of the table. Her data was always correct and always
  // reachable by typing the URL, so this was reachability, never arithmetic.
  //
  // Page 3 unions its progress table into its own list for this reason and in
  // these words (tracker/query.ts:744). Page 4 now does the same, from the same
  // two sources and with Page 3's own predicate, so total silence is both
  // VISIBLE and REACHABLE and the two pages cannot offer different names.
  //
  // `kind !== 'management'` is that predicate: a person who recorded carrying a
  // management role belongs in the Manager dropdown, so this cannot leak a
  // manager into the GRE list. Rows with kind 'gre' are already in
  // `greNamesRecorded`, so in practice the union adds exactly the 'assigned'
  // ones. `managers` stays visit-derived on BOTH pages because nothing in the
  // app seeds a management roster — offering a name there that no query can
  // answer for would be the opposite of this fix.
  //
  // Neither half is narrowed by the person filter — `greNamesRecorded` is built
  // from `allVisits` and `gre` from `visits`, and section 6 layer 2 keeps those
  // the same list — so picking a name still cannot empty the list it came from.
  const gres = uniqSorted([
    ...greNamesRecorded,
    ...gre.filter((g) => g.kind !== 'management').map((g) => g.person).filter(Boolean),
  ]);

  // 🔒 THE VENUE LANE, BEHIND A FUNCTION BOUNDARY. `venueSummary` takes the
  // VENUE filter and the VENUE rows and nothing else — there is no `personName`
  // and no `recordItems` inside its body to reach for, so the rating split and
  // the four negative tiles cannot be narrowed to a person by any edit that
  // still compiles. That is the owner's "structurally impossible".
  const summary = venueSummary(vf, u, visits, items, followUps, eligibleIds, platesSold, openNowAllTime);

  const recordScopeNote = personName
    ? recordScopeSentence(personName, gre)
    : '';

  return {
    range: r,
    filters: f,
    summary,
    categories: venueCategories(vf, visits),
    records: {
      scope: personName ? 'person' : 'venue',
      person: personName,
      item_feedbacks: recordItems.length,
      negative_item_feedbacks: recNegatives,
      items_sold: venueMenuItems.length,
      note: recordScopeNote,
    },
    menu_items: menuItems,
    common_problems: commonProblems(recordItems),
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
    // 🐞 RISK 3, CLOSED IN THE LABEL. Row 0 used to BE
    // `summary.negative_item_feedbacks` — the venue tile. Now the queue is
    // record-scoped while the tile stays venue, so the two would print
    // DIFFERENT numbers under the SAME words in one workbook. Under a person
    // filter every label here says whose records it counts, so a reader cannot
    // read the queue as the venue's or the tile as the person's.
    recovery: ([
      { key: 'negative', label: 'Negative feedbacks', count: recNegatives },
      { key: 'returned', label: 'Items returned', count: recAct('returned') },
      { key: 'remade', label: 'Items remade', count: recAct('remade') },
      { key: 'replaced', label: 'Items replaced', count: recAct('replaced_same') + recAct('replaced_other') },
      { key: 'happy', label: 'Guest happy after correction', count: recHappy },
      { key: 'partial', label: 'Partially happy', count: recPartial },
      { key: 'unhappy', label: 'Still unhappy', count: recUnhappy },
    ] as { key: RecoveryKey; label: string; count: number }[]).map((x) => (
      personName ? { ...x, label: `${x.label} — ${personName}'s records` } : x
    )),
    gre_performance: gre,
    person: personScope(gre, personName),
    daily: venueDaily(vf, r, u, visits, items, followUps, eligibleIds),
    options: {
      floors: u.floors,
      sections: u.sections,
      captains: u.captains,
      gres,
      managers,
      // VENUE, deliberately. Picking a GRE must not shorten the Menu item
      // dropdown — it is the list the NEXT filter is chosen from, and the same
      // law already governs `gres` above ("picking a name does not empty the
      // list it came from"). `venueMenuItems` is `menuItems` itself when no name
      // is picked, so this costs a second pass only while a filter is on.
      items: uniqSorted(venueMenuItems.map((m) => m.menu_item)).slice(0, 500),
      sections_available: u.sections.length > 0,
      sections_note: u.sections.length > 0 ? '' : NOTE_SECTIONS_EMPTY,
    },
    meta: {
      item_threshold: u.itemThreshold,
      item_threshold_is_default: u.itemThresholdIsDefault,
      excluded: u.excluded,
      fairness_note: ISSUES_RECORDED_IS_NOT_A_PENALTY,
      coverage_per_gre_unavailable: COVERAGE_PER_GRE_UNAVAILABLE,
      recovery_is_a_queue: RECOVERY_IS_A_QUEUE,
      negative_pct_basis: NEGATIVE_PCT_BASIS,
      return_remake_basis: RETURN_REMAKE_BASIS,
      // '' with no name picked: the menu table is then the venue's throughout,
      // there is no second scope in the row, and the screen draws no `*`. See 2c.
      venue_columns_basis: personName ? VENUE_COLUMNS_IN_RECORD_TABLE : '',
      generated_at: new Date().toISOString(),
      counts_scope: personName ? COUNTS_SCOPE_PERSON : COUNTS_SCOPE_ROOM,
      person_filter_active: !!personName,
      reconciles: {
        rating_split:
          summary.excellent + summary.good + summary.average + summary.poor + summary.unrated
          === summary.feedbacks_recorded,
        coverage_split:
          summary.eligible_tables_covered + summary.extra_visits === summary.feedbacks_recorded,
        taken_subset: summary.eligible_tables_covered <= summary.eligible_tables,
      },
    },
  };
}

/* ════════════════════════════════════════════════════════════════════════════
   THE VENUE LANE — WHAT A PERSON FILTER CANNOT REACH
   ════════════════════════════════════════════════════════════════════════════
   The owner's ruling in D11(a): "The RATING SPLIT and the four red/amber
   negative tiles stay VENUE-WIDE no matter whose name is picked." These three
   functions are that sentence, compiled.

   Each one takes a `VenueFilters` — which has no `gre` and no `manager`, at the
   type level — and `VenueRows` arrays. Neither `personName` nor the narrowed
   arrays are in scope inside any of them. A future edit that tries to narrow a
   rating to a person has nothing here to narrow BY, and passing the record
   arrays in from outside does not type-check.

   The `vf` parameter is not decoration: it is the only filter these bodies can
   see, so the day one of them needs to read a filter, the filter it reads is
   provably person-free.
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * THE RATING SPLIT, THE FOUR NEGATIVE TILES AND THE COVERAGE DENOMINATORS.
 *
 * Section 7: coverage counts only visits on tables that were ELIGIBLE —
 * otherwise a visit to a two-item table would push coverage over 100 %. The rest
 * are `extra_visits`, counted and named rather than dropped. The numerator is
 * derived HERE, from the venue rows, so no narrowed numerator exists anywhere
 * for a later edit to reach for.
 */
function venueSummary(
  vf: VenueFilters,
  u: Universe,
  visits: VenueRows<VisitRow>,
  items: VenueRows<ItemFeedbackRow>,
  followUps: VenueRows<FollowUpRow>,
  eligibleIds: Set<string>,
  platesSold: number,
  openNowAllTime: number,
): AnalyticsPayload['summary'] {
  void vf; // the person-free filter; see the block comment above
  const covered = visits.filter((v) => eligibleIds.has(v.order_id)).length;
  const ratingCount = (v: string) => visits.filter((x) => x.overall_rating === v).length;
  const act = (a: ActionTaken) => items.filter((x) => x.action_taken === a).length;
  const replaced = act('replaced_same') + act('replaced_other');

  return {
    eligible_tables: u.eligible.length,
    all_tables: u.orders.length,
    feedbacks_recorded: visits.length,
    eligible_tables_covered: covered,
    extra_visits: visits.length - covered,
    coverage_pct: rate(covered, u.eligible.length),
    // ── THE RATING SPLIT. Venue-wide, whoever recorded it. ──
    excellent: ratingCount('excellent'),
    good: ratingCount('good'),
    average: ratingCount('average'),
    poor: ratingCount('poor'),
    unrated: visits.filter((x) => !x.overall_rating).length,
    everything_good: visits.filter((x) => x.everything_good).length,
    // ── NEGATIVE TILE 1. Venue-wide. ──
    negative_item_feedbacks: items.filter((x) => x.is_negative).length,
    item_feedbacks: items.length,
    // ── NEGATIVE TILE 2. Venue-wide. ──
    returned: act('returned'),
    remade: act('remade'),
    replaced,
    cancelled: act('cancelled'),
    // ── NEGATIVE TILE 3. Venue-wide. ──
    happy_after_replacement: followUps.filter((x) => x.happiness === 'happy').length,
    partially_happy: followUps.filter((x) => x.happiness === 'partial').length,
    still_unhappy: followUps.filter((x) => x.happiness === 'unhappy').length,
    // ── NEGATIVE TILE 4. Venue-wide. ──
    pending_follow_ups: followUps.filter((x) => x.status === 'open').length,
    follow_ups_raised: followUps.length,
    follow_ups_completed: followUps.filter((x) => x.status === 'closed').length,
    open_follow_ups_now: openNowAllTime,
    plates_sold: platesSold,
  };
}

/** THE CATEGORY RATINGS (Food / Drinks / Service / Ambience). Pure sentiment,
 *  therefore venue-wide without exception. */
function venueCategories(vf: VenueFilters, visits: VenueRows<VisitRow>): AnalyticsPayload['categories'] {
  void vf;
  return CATEGORIES.map((c) => {
    const col = `cat_${c.v}` as 'cat_food' | 'cat_drinks' | 'cat_service' | 'cat_ambience';
    const n = (val: string) => visits.filter((x) => x[col] === val).length;
    return { key: c.v, label: c.label, excellent: n('excellent'), good: n('good'), average: n('average'), poor: n('poor') };
  });
}

/** THE DAILY ROWS. Both halves are venue: `.eligible` / `.taken` /
 *  `.coverage_pct` are the coverage denominators, and `.negative` /
 *  `.returned_remade` / `.open` express sentiment. Neither may narrow. */
function venueDaily(
  vf: VenueFilters,
  r: ResolvedRange,
  u: Universe,
  visits: VenueRows<VisitRow>,
  items: VenueRows<ItemFeedbackRow>,
  followUps: VenueRows<FollowUpRow>,
  eligibleIds: Set<string>,
): AnalyticsPayload['daily'] {
  void vf;
  const covered = visits.filter((v) => eligibleIds.has(v.order_id));
  return daysInRange(r).map((d) => {
    const el = u.eligible.filter((o) => o.business_day === d).length;
    const tk = covered.filter((v) => v.business_day === d).length;
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
  });
}

/**
 * The one sentence that tells a reader which sections moved. It goes on the
 * screen under the narrowed sections and into every sheet note that carries
 * record-level data, so the two scopes in one payload are never left to be
 * inferred from a heading.
 *
 * ⚠️ THE SHARED-NAME CASE, NAMED RATHER THAN HIDDEN. The filter is a NAME;
 * `grePerformance()` keys by USER ID where it has one. Two active people with
 * one display name therefore get TWO rows in the per-person table while
 * `personScope()` returns the first — so the record sections below (which match
 * by name, because dropping the second person's records would be a silent loss)
 * count both people while the person block describes one. That is a real
 * divergence and it says so out loud instead of printing two numbers that
 * quietly count different populations.
 */
function recordScopeSentence(personName: string, rows: GrePerformanceRow[]): string {
  const shared = rows.filter((g) => g.person === personName).length;
  const base =
    `Narrowed to ${personName}: the menu items, the problems, the recovery queue and the item `
    + `comments below list what ${personName} wrote down. The rating split, the category ratings, `
    + 'the day-by-day rows and every Summary tile above them still cover the WHOLE selected floor, '
    + 'section, captain and period — they do not move when a name is picked, so nothing a guest '
    + `actually said can make ${personName}'s numbers look worse.`;
  return shared > 1
    ? `${base} NOTE: ${shared} active people share the name "${personName}", so these sections count `
      + `all ${shared} of them while the "What ${personName} did" block describes one. Tell the owner `
      + 'two staff records carry the same display name.'
    : base;
}

export const COUNTS_SCOPE_ROOM =
  'Every figure on this page covers the selected period, floor, section and captain.';

export const COUNTS_SCOPE_PERSON =
  'A GRE / Manager filter selects a PERSON, and this page then shows TWO scopes at once. It '
  + 'narrows the RECORDS: the menu items, the most-complained and most-appreciated lists, the '
  + 'problems, the service-recovery queue and the item comments are what THIS PERSON wrote down. '
  + 'It does NOT narrow the JUDGEMENT: the rating split, the four negative tiles, the category '
  + 'ratings, the coverage figures and the day-by-day rows still cover the whole selected floor, '
  + 'section, captain and period, whoever recorded them. That split is deliberate and it is the '
  + "owner's fairness ruling - narrowing the ratings to one name made the same GRE on the same "
  + 'tables read "Excellent 100%, Negative 0" when she recorded nothing and "Average 100%, '
  + 'Negative 4" when she recorded what the guests said. Recording a complaint fills in the lists '
  + 'below and can never move a rating, so it can never cost the person anything.';

/**
 * The person block — section 6, layer 2. It is a PROJECTION of the row the
 * per-person table already computed, never a second computation: if it were
 * computed separately the two could disagree, and a management page that
 * disagrees with its own table is worse than one with no table.
 */
function personScope(rows: GrePerformanceRow[], personName: string): PersonScope | null {
  if (!personName) return null;
  const row = rows.find((g) => g.person === personName);
  const base: GrePerformanceRow = row ?? {
    person_id: '', person: personName, role: '', kind: 'gre',
    tables_visited: 0, taken: 0, feedbacks_recorded: 0, issues_recorded: 0,
    follow_ups_raised: 0, follow_ups_completed: 0, follow_ups_open: 0,
    recovery_pct: null, share_pct: null,
    area_zones: [], area_assigned: false,
    area_eligible: null, area_covered: null, area_coverage_pct: null, off_area_visits: 0,
  };
  return {
    ...base,
    // Two floors fit the person sheet's Value column at the shipped weights and
    // three do not (measured: 123.0pt into 115.9pt), so a longer list is summed
    // instead of being silently chopped. The full list is in `area_zones`.
    area_label: base.area_assigned
      ? (base.area_zones.length > 2
        ? `${base.area_zones[0]} +${base.area_zones.length - 1} more`
        : base.area_zones.join(' · ') || 'assigned tables')
      : 'All floors (no assignment)',
    coverage_basis: base.area_assigned ? AREA_ASSIGNED_NOTE : AREA_UNASSIGNED_NOTE,
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

/**
 * THE RETURN / REMAKE RATE, BUILT FROM THE ROOM. Read 2c first.
 *
 * The ONLY constructor of a `VenueRate`, and it takes `VenueRows` — so the rate
 * cannot be built from the narrowed rows by any edit that still compiles.
 * Negative control (run, not assumed): passing `recordItems` here fails with
 * TS2345, "Property '[VENUE_SCOPE]' is missing".
 *
 * Both sides are the venue's. The numerator comes from `items`, which the Food /
 * Drinks and Menu Item filters DO narrow — those are properties of the dish, not
 * of a recorder — and the denominator is that dish's plates over every order in
 * scope. Keyed by `item_key` so the record lane can look its rows up without
 * holding any quantities of its own.
 */
function venueReturnRemakeRates(
  items: VenueRows<ItemFeedbackRow>,
  soldByKey: ReadonlyMap<string, { name: string; sold: number }>,
): VenueRrRates {
  const qty = new Map<string, number>();
  for (const x of items) {
    if (!x.item_key) continue;
    if (x.action_taken !== 'returned' && x.action_taken !== 'remade') continue;
    qty.set(x.item_key, (qty.get(x.item_key) ?? 0) + x.quantity);
  }
  const out = new Map<string, VenueRate>();
  for (const key of new Set<string>([...qty.keys(), ...soldByKey.keys()])) {
    // `rate()` already answers null on a zero denominator, which is the honest
    // "this dish was never sold in scope" rather than a 0% that reads as clean.
    out.set(key, rate(qty.get(key) ?? 0, soldByKey.get(key)?.sold ?? 0) as VenueRate);
  }
  return out;
}

/**
 * The menu-item table. RECORD-LEVEL under D11(a): `analytics()` calls it once
 * with the person-narrowed rows for what the page draws, and once with the venue
 * rows for the Menu item dropdown. It takes plain arrays deliberately — it is
 * the one function both lanes share, so branding its parameters would force a
 * cast at each call and prove nothing.
 *
 * `seedUnmentioned` is the scope switch: see the call site.
 *
 * `rr` is the venue's Return / Remake Rate per dish, ALREADY COMPUTED (2c). This
 * function no longer accumulates returned/remade quantities at all, because in
 * the record lane its `items` are one person's and that rate is the venue's.
 * Both lanes get the same map, so the cell does not move when a name is picked.
 */
function buildMenuItems(
  items: readonly ItemFeedbackRow[],
  followUps: readonly FollowUpRow[],
  soldByKey: Map<string, { name: string; sold: number }>,
  groupWanted: string,
  itemWanted: string,
  seedUnmentioned: boolean,
  rr: VenueRrRates,
): MenuItemRow[] {
  const by = new Map<string, MenuItemRow>();

  const blank = (key: string, name: string, group: ItemGroup): MenuItemRow => ({
    item_key: key,
    menu_item: name,
    menu_item_id: '',
    group,
    sold: soldByKey.get(key)?.sold ?? 0,
    feedbacks: 0, negative: 0, returned: 0, remade: 0, replaced: 0, cancelled: 0,
    // The venue's rate, looked up — never accumulated here. See 2c.
    return_remake_pct: rr.get(key) ?? null,
    happy_after: 0, still_unhappy: 0, good: 0, comments: 0,
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
    // ⚠️ COUNTS ONLY. These are rows this person wrote, and they are printed as
    // counts in columns of their own. Do NOT add a quantity accumulator back:
    // the Return / Remake Rate is the venue's and arrives via `rr` (2c).
    if (x.action_taken === 'returned') row.returned++;
    if (x.action_taken === 'remade') row.remade++;
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

  // Dishes that SOLD but drew no comment belong in the VENUE table: a manager
  // scanning for the problem dish also needs to see what nobody mentioned, and
  // leaving them out would make "Feedbacks 0" unrepresentable.
  //
  // They do NOT belong in a table narrowed to one person (`seedUnmentioned`
  // false): "nobody mentioned this dish" is a venue fact, while "this GRE did
  // not mention this dish" is not a record of anything and would pad a narrowed
  // table with zeros until it read like the unnarrowed one.
  for (const [key, s] of soldByKey) {
    if (!seedUnmentioned) break;
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

/** RECORD-LEVEL under D11(a) — `analytics()` hands it the person-narrowed rows.
 *  Its counts are divided by `records.negative_item_feedbacks`, never by the
 *  venue tile: see the "Share of negatives" column in `buildReport`. */
function commonProblems(items: readonly ItemFeedbackRow[]): { label: string; count: number }[] {
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
  db: Database.Database,
  u: Universe,
  // VENUE ROWS ONLY, enforced by section 2b's brand. This table has one row per
  // PERSON and it is the source of the GRE dropdown, so narrowing its input to
  // the selected person would empty every other row, hide the silent role
  // holders the table exists for, and make picking a name empty the list the
  // name came from. `RecordRows` does not type-check here.
  visits: VenueRows<VisitRow>,
  items: VenueRows<ItemFeedbackRow>,
  followUps: VenueRows<FollowUpRow>,
  eligibleIds: Set<string>,
): GrePerformanceRow[] {
  const by = new Map<string, GrePerformanceRow>();
  const visitPerson = new Map<string, string>();
  const key = (id: string, name: string) => (id ? `id:${id}` : `nm:${name.toLowerCase()}`);

  const blank = (
    person_id: string, person: string, role: string, kind: GrePerformanceRow['kind'],
  ): GrePerformanceRow => ({
    person_id, person, role, kind,
    tables_visited: 0, taken: 0, feedbacks_recorded: 0, issues_recorded: 0,
    follow_ups_raised: 0, follow_ups_completed: 0, follow_ups_open: 0,
    recovery_pct: null, share_pct: null,
    area_zones: [], area_assigned: false,
    area_eligible: null, area_covered: null, area_coverage_pct: null, off_area_visits: 0,
  });

  // ── seed from the people who HOLD the role ────────────────────────────────
  // Page 3 already does exactly this and for exactly this reason: a GRE who
  // recorded nothing all night has no visit, so a visit-driven query cannot
  // produce their row — and total silence is the single behaviour this page
  // exists to make visible. Measured before this change: a GRE with the role
  // assigned and 0 visits appeared on Page 3 and was ABSENT from Page 4 and
  // from the GRE/Manager Performance workbook.
  //
  // A failure to read users/roles degrades to "only the people who recorded
  // something" — the previous behaviour — never to an exception.
  const seeded: { id: string; name: string; role: string }[] = [];
  try {
    const people = db
      .prepare(
        `SELECT u.id AS id, u.name AS name, r.name AS role_name
           FROM users u
           JOIN roles r ON r.id = u.role_id
          WHERE LOWER(TRIM(r.name)) = LOWER(TRIM(?))
            AND COALESCE(r.is_active, 1) = 1
            AND COALESCE(u.is_active, 1) = 1`,
      )
      .all(GRE_ROLE_NAME) as any[];
    for (const p of people) {
      const id = String(p.id ?? '');
      const name = String(p.name ?? '').trim() || '(unnamed)';
      seeded.push({ id, name, role: String(p.role_name ?? GRE_ROLE_NAME) });
      by.set(key(id, name), blank(id, name, String(p.role_name ?? GRE_ROLE_NAME), 'assigned'));
    }
  } catch {
    /* degrade to visit-derived rows only */
  }

  const keyOfVisit = new Map<string, string>();
  // 🐞 THE SAME COLUMN NAME MUST MEAN THE SAME THING ON BOTH PAGES. Page 3's
  // progress table has carried TWO numbers since 7158feb — "Tables" = the
  // DISTINCT tables a person recorded on, and "Taken" = their visits on
  // eligible tables — and Page 4 had one field, `tables_visited`, computed as
  // Page 3's `taken`. They agree on every ordinary night and disagree the
  // moment a table seats twice in one service (two eligible orders, one table:
  // Page 3 says Tables 1 / Taken 2, Page 4 said Tables 2). Two screens the
  // owner reads side by side, disagreeing under one heading, is the defect the
  // coverage split was just fixed for. So Page 4 now computes BOTH by Page 3's
  // own rule, and `share_pct` uses the visit count, exactly as Page 3 does.
  const tablesByPerson = new Map<string, Set<string>>();
  for (const v of visits) {
    const name = v.gre_name || '(unnamed)';
    const k = key(v.gre_user_id, name);
    visitPerson.set(v.visit_id, k);
    keyOfVisit.set(v.visit_id, k);
    const kind: GrePerformanceRow['kind'] = isManagementRole(v.gre_role) ? 'management' : 'gre';
    const row = by.get(k) ?? blank(v.gre_user_id, name, v.gre_role || '', kind);
    if (row.kind === 'assigned') row.kind = kind;
    if (!row.role) row.role = v.gre_role || row.role;
    row.feedbacks_recorded++;
    if (eligibleIds.has(v.order_id)) {
      row.taken++;
      const set = tablesByPerson.get(k) ?? new Set<string>();
      // `table_id` is the order's, falling back to the visit's snapshot — the
      // same id Page 3 keys its set by.
      set.add(v.table_id || v.order_id);
      tablesByPerson.set(k, set);
    }
    by.set(k, row);
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

  // ── the owner's floor ruling: a real denominator, for whoever has one ─────
  const ids = [
    ...seeded.map((p) => p.id),
    ...visits.map((v) => v.gre_user_id),
  ].filter(Boolean);
  const areas = readGreAreas(db, ids);

  // Eligible tables per assignment. Computed from the SAME `u.eligible` the
  // venue denominator uses, so a person's floor total can never exceed it.
  const eligibleOrders = u.eligible;

  for (const [k, row] of by) {
    row.tables_visited = tablesByPerson.get(k)?.size ?? 0;
    const area = (row.person_id ? areas.get(row.person_id) : undefined) ?? AREA_UNASSIGNED;
    row.area_zones = area.zones;
    row.area_assigned = area.assigned;

    if (area.assigned) {
      const mine = eligibleOrders.filter((o) => areaCovers(area, o.floor, o.table_id));
      const mineIds = new Set(mine.map((o) => o.order_id));
      const myVisits = visits.filter((v) => keyOfVisit.get(v.visit_id) === k);
      const covered = myVisits.filter((v) => mineIds.has(v.order_id)).length;
      row.area_eligible = mine.length;
      row.area_covered = covered;
      row.area_coverage_pct = rate(covered, mine.length);
      // Everything they recorded on an ELIGIBLE table that is not theirs.
      // It stays inside tables_visited; this names it so the help is visible.
      row.off_area_visits = myVisits.filter(
        (v) => eligibleIds.has(v.order_id) && !mineIds.has(v.order_id),
      ).length;
    }

    row.recovery_pct = rate(row.follow_ups_completed, row.follow_ups_raised);
  }

  // Page 3's rule exactly: a person's share of the VISITS that covered an
  // eligible table, so the column sums to 100 % across the people on it.
  const totalCovered = visits.filter((v) => eligibleIds.has(v.order_id)).length;
  for (const row of by.values()) {
    row.share_pct = totalCovered ? rate(row.taken, totalCovered) : null;
  }

  // Most active first, then alphabetical — NEVER by rating, and never ordered
  // such that recording complaints sinks a name (section 4).
  return Array.from(by.values()).sort(
    (a, b) => b.tables_visited - a.tables_visited
      || b.taken - a.taken
      || b.feedbacks_recorded - a.feedbacks_recorded
      || a.person.localeCompare(b.person),
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
  // The universe is the ROOM: `venueFilters()` strips the person before it is
  // read, so the order list behind the comments is never narrowed by a name.
  const u = loadUniverse(db, opts.outletId, r, venueFilters(opts.filters));
  const visitRows = selectIn(
    db,
    `SELECT id, order_id, table_number, floor, gre_name, gre_role, created_at
       FROM gf_visits WHERE order_id IN (@@)`,
    u.orders.map((o) => o.order_id),
  );
  const orderById = new Map(u.orders.map((o) => [o.order_id, o]));

  // 🔒 D11(a) — THE COMMENTS ARE A RECORD-LEVEL SECTION, SO THEY NARROW.
  //
  // The owner named them: the filter narrows "comments, menu items, the recovery
  // queue". An earlier cut of this function narrowed them, was reverted because
  // the comment list then disagreed with the row that had been clicked (that row
  // was room-scoped), and the note left behind said the list must never narrow.
  // Both halves have now moved: `payload.menu_items` IS the narrowed table, so
  // narrowing here is what makes the list AGREE with the clicked row again. The
  // arithmetic is the same either way; only which of the two it matches changed.
  //
  // What still cannot narrow is anything that carries a rating: `payload.summary`
  // and `payload.categories` above come out of the venue lane, and the person is
  // stripped from the universe query by `venueFilters()`.
  //
  // Every row keeps `gre_name` so the screen can show who wrote each one, which
  // is what makes an UNFILTERED list readable as the venue's.
  const personName = !isAll(opts.filters.gre)
    ? String(opts.filters.gre).trim()
    : !isAll(opts.filters.manager) ? String(opts.filters.manager).trim() : '';

  const visitMeta = new Map<string, { table: string; floor: string; gre: string; captain: string; day: string }>();
  for (const v of visitRows as any[]) {
    const gre = String(v.gre_name ?? '').trim();
    // By NAME, exactly as `analytics()` narrows the other record sections — see
    // the "THE FILTER IS A NAME, NOT AN ID" note there.
    if (personName && gre !== personName) continue;
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

export interface ReportColumn {
  label: string;
  width?: number;
  align?: 'left' | 'right' | 'center';
  /**
   * This column carries a FREE-TEXT NAME that the PDF renderer will hard-
   * truncate to one line. `reports/route.ts` replaces the cell text of such a
   * column with a printed label that is guaranteed UNIQUE at the width the
   * column actually gets; the xlsx keeps the full string, because a spreadsheet
   * cell does not truncate.
   *
   * Measured on the 628 real menu items: at the shipped widths the renderer
   * truncated 151 of them and collapsed 58 DISTINCT dishes into 28 identical
   * printed strings — "AG FORTYSEVEN CHARDONNAY BOTTLE" and
   * "…CHARDONNAY GLASS" both printed as "AG FORTYSEVEN CHAR…". A chef reading
   * that acts on the wrong item.
   */
  fitPrint?: boolean;
}

export interface ReportTable {
  name: string;
  columns: ReportColumn[];
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

  /* ── D11(a): TWO SCOPES IN ONE FILE, SAID ON EVERY SHEET ──────────────────
     A workbook headed "GRE: <name>" in which some sheets are that person's
     records and others are the venue's ratings is unreadable unless each sheet
     says which it is. `filterLines` says it once at the top of every file; these
     two notes say it again ON the sheet, because a reader who prints page 3 or
     opens one tab never sees the cover.

     Both are '' when no name is picked, and `withNote` then leaves every note
     exactly as it was — so an unfiltered download is byte-identical to before
     (measured). */
  const recordNote = p.records.note;
  const venueNote = p.records.scope === 'person'
    ? `THIS SHEET IS THE WHOLE VENUE, NOT ${p.records.person}. It covers every recorder on the `
      + 'selected floor, section, captain and period, and it does not change when a name is picked. '
      + `No figure on it is a judgement of ${p.records.person}.`
    : '';
  const withNote = (base: string | undefined, extra: string): string | undefined => {
    if (!extra) return base;
    return base ? `${base} ${extra}` : extra;
  };

  // Section 7: the two counts are both printed, with their relationship on the
  // face of the sheet. The Summary used to say "Feedbacks taken 9" beside a
  // Rating split sheet that accounted for 10, inside ONE workbook.

  /* 🐞 A VENUE NUMBER ON A PERSON'S CARD, and it carried no words at all.
     `open_follow_ups_now` is deliberately NOT range-bound (§ the header note)
     and it is also not person-bound — but when a GRE filter is set the whole
     workbook is headed with that person's name, so the tile read as hers.
     Measured on one service with three open complaints: filtered to a GRE who
     had raised NONE, the tile printed `3` with an EMPTY sub, i.e. a file headed
     "GRE: <name>" told a manager she had three complaints outstanding. The
     number is worth keeping — it is the venue's live queue — so it now says
     whose it is, and names the person's own figure beside it rather than
     leaving the reader to assume.

     A KPI `sub` is ONE hard-truncated line (see coverageKpis below), and a
     person's NAME cannot be fitted into it — "Nisha Sharma" alone pushed the
     sentence to 178pt against a 153pt tile, so it printed as "not Nisha Sha…".
     The tile therefore says the SHORT, name-free truth and the naming sentence
     goes into `footnotes`, which wrap. */
  const openNowTile = {
    label: 'Follow-ups open now (all dates)',
    value: n0(s.open_follow_ups_now),
    sub: p.person
      ? 'Whole venue, all dates - NOT this person\'s.'
      : 'Whole venue, right now - every date.',
  };

  /** The naming half of the tile above, for `footnotes` (which wrap). */
  const openNowFootnote = p.person
    ? `"Follow-ups open now (all dates)" is the WHOLE VENUE's open queue, not ${p.person.person}'s: `
      + `${n0(p.person.follow_ups_open)} of those ${p.person.follow_ups_open === 1 ? 'is' : 'are'} theirs. `
      + `Their own figures are on the "What ${p.person.person} did" sheet.`
    : '';

  /* ⚠️ A KPI `sub` IS ONE HARD-TRUNCATED LINE, 153.09pt WIDE. `report-pdf.ts`
     lays the tiles out three to a row (cellW 165.09pt) and renders the sub with
     `fit(doc, k.sub, cellW - 12)` at Helvetica 7.5 — no wrapping. Measured at
     the owner's real scale (292 tables), two of these sentences were being cut
     mid-word in the PDF while looking perfect in the spreadsheet:

       "threshold 4 items (default), or bill asked / printed"   159.8pt
            printed as "... or bill asked / pri…"  — losing the word PRINTED,
            i.e. one of the owner's three eligibility triggers.
       "213 on eligible tables + 79 on tables that never met the trigger" 205pt
            printed as "... + 79 on tables that n…" — and that sentence is the
            one that reconciles this tile against the Rating split sheet.

     Every sub below is now measured against 153.09pt at its WORST-CASE numbers
     (four digits everywhere), so none of them can be cut. Anything that needs
     more words belongs in `footnotes`, which DO wrap. */
  const coverageKpis = [
    { label: 'Eligible tables', value: n0(s.eligible_tables), sub: `${p.meta.item_threshold}+ items${p.meta.item_threshold_is_default ? ' (default)' : ''}, or bill asked / printed` },
    {
      label: 'Feedbacks recorded',
      value: n0(s.feedbacks_recorded),
      sub: s.extra_visits
        ? `${n0(s.eligible_tables_covered)} on eligible tables + ${n0(s.extra_visits)} on others`
        : 'all of them on eligible tables',
    },
    {
      label: 'Coverage',
      value: pctText(s.coverage_pct),
      sub: `${n0(s.eligible_tables_covered)} of ${n0(s.eligible_tables)} eligible tables covered`,
    },
    { label: 'Negative item feedbacks', value: n0(s.negative_item_feedbacks), sub: `of ${n0(s.item_feedbacks)} item feedbacks` },
  ];

  const base = {
    period: p.range.label,
    filters,
    footnotes: [
      p.meta.counts_scope,
      NEGATIVE_PCT_BASIS,
      RETURN_REMAKE_BASIS,
      'Feedbacks recorded counts EVERY visit in scope; Coverage counts only the visits on tables '
      + 'that met the eligibility trigger, over the tables that met it. A visit to a table nobody '
      + 'was owed is real work and is in the first number, never in the second - so the two can '
      + 'differ, and the Summary sheet says by how much.',
      `Dates are IST business days with a ${p.range.cutoff} rollover - the same convention the floor board uses, so a complaint taken at 01:30 belongs to the previous evening's service.`,
      ISSUES_RECORDED_IS_NOT_A_PENALTY,
      // Empty string when no person is selected; filtered out below so the PDF
      // never prints a bare bullet.
      openNowFootnote,
    ].filter(Boolean),
  };

  /** The "What <name> did" sheet. Present ONLY when a person filter is set, and
   *  it is the ONLY thing that filter changes. Every column is one of the five
   *  the owner named. */
  const personTables: ReportTable[] = p.person
    ? [{
      name: `What ${p.person.person} did`,
      // Value carries a FLOOR NAME as well as numbers, and "First Floor · Terrace"
      // does not fit 73pt. Measured at the renderer's own Helvetica 8: every cell
      // in all three columns fits at these weights, for one floor and for two.
      columns: [{ label: 'Measure', width: 3 }, { label: 'Value', width: 1.9, align: 'right' }, { label: 'Basis', width: 3.0 }],
      rows: [
        ['Tables visited (distinct eligible tables they covered)', p.person.tables_visited, "Owner metric. Same rule as the Tracker's Tables."],
        ['Feedbacks taken on eligible tables', p.person.taken, "The coverage numerator. The Tracker's Taken."],
        ['Feedbacks recorded (all their visits in scope)', p.person.feedbacks_recorded, 'Includes tables that never met the trigger'],
        ['Floor they are measured against', p.person.area_label, p.person.area_assigned ? 'users.preferred_zones' : 'No assignment - measured against every eligible table in scope'],
        ['Coverage of their own floor',
          p.person.area_assigned ? pctText(p.person.area_coverage_pct) : '-',
          p.person.area_assigned
            ? `${n0(p.person.area_covered ?? 0)} of ${n0(p.person.area_eligible ?? 0)} eligible tables on their floor`
            : COVERAGE_PER_GRE_UNAVAILABLE],
        ['Helped on another floor', p.person.off_area_visits, 'Work, never a shortfall - see the note below.'],
        ['Share of the tables that were covered', pctText(p.person.share_pct), "Their part of the room's covered tables"],
        ['Issues properly recorded', p.person.issues_recorded, 'Owner metric. A CREDIT, never a penalty.'],
        ['Follow-ups raised', p.person.follow_ups_raised, 'Complaints they opened'],
        ['Follow-ups completed', p.person.follow_ups_completed, 'Owner metric: Follow-Ups Completed'],
        ['Follow-ups still open', p.person.follow_ups_open, 'A work queue, not a score'],
        // The BASIS says it in words on the row itself, not only in the note
        // under the table: a reader who scans the Value column and stops sees
        // "none raised" beside the sentence that forbids reading it as a good
        // score. Measured at the renderer's own LINE LAYOUT (not widthOfString
        // - see labels.ts): 179.7pt into the 187.7pt Basis column, one line,
        // no ellipsis.
        ['Guest recovery follow-up',
          recoveryLong(p.person.follow_ups_completed, p.person.follow_ups_raised),
          p.person.follow_ups_raised
            ? 'Completed / raised. A QUEUE, not a score.'
            : 'Nothing to close - NOT better than an open queue.'],
      ] as (string | number)[][],
      note: `${ISSUES_RECORDED_IS_NOT_A_PENALTY} ${RECOVERY_IS_A_QUEUE} ${p.person.coverage_basis} `
        + 'Nothing in this sheet is a rating, and no other sheet in this file is about this person.',
      emptyNote: 'This person recorded nothing in this period.',
    }]
    : [];

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
    // VENUE on both halves — the coverage columns AND the sentiment columns.
    note: withNote('Open = follow-ups raised on that day that are still open. A day with no eligible table shows "-" for coverage rather than 0%, which would read as "we covered nothing".', venueNote),
    emptyNote: 'No business days in this period.',
  };

  const recoveryTable: ReportTable = {
    name: 'Service recovery',
    columns: [{ label: 'Outcome', width: 3 }, { label: 'Count', width: 1, align: 'right' }],
    // RECORD-level: the owner named the recovery queue. Under a person filter the
    // row LABELS themselves name the recorder (see `recovery` in `analytics()`),
    // so this sheet cannot be confused with the venue tile of the same name.
    rows: p.recovery.map((x) => [x.label, x.count]),
    note: withNote('What happened AFTER a negative feedback. "Guest happy after correction" closes the complaint; "partially happy" and "still unhappy" leave it open for the manager.', recordNote),
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
    // (Helvetica-Bold 8 / Helvetica 8, PAD 4, CONTENT_W 515.28).
    //
    // 🐞 THE SECOND MEASUREMENT, AND THE ONE THAT MATTERED. The HEADINGS fit;
    // the ITEM NAMES did not. Over the 628 real menu items, 151 truncated and
    // 58 DISTINCT dishes printed as 28 IDENTICAL strings — "AG FORTYSEVEN
    // CHARDONNAY BOTTLE" and "AG FORTYSEVEN CHARDONNAY GLASS" both came out
    // "AG FORTYSEVEN CHAR…", i.e. a bottle of wine and a glass of it are the
    // same row. Two things fix it, and BOTH are applied:
    //   (1) the weights below are now the MEASURED MINIMUM for every other
    //       column (heading at Helvetica-Bold 8 vs worst-case cell at
    //       Helvetica 8, + 2*PAD) with EVERY remaining point given to Item:
    //       103.2pt -> 127.1pt usable, 477 -> 562 of 628 printed in full;
    //   (2) `fitPrint` (see ReportColumn) hands the column to the unique-label
    //       pass in `reports/route.ts`, which head-and-tail elides instead of
    //       chopping the tail off — so the BOTTLE/GLASS distinction survives —
    //       and guarantees no two distinct items print the same string.
    // Re-measured with both applied: 628 of 628 printed strings distinct.
    //
    // 🔒 THE TWO SCOPES INSIDE ONE ROW, MARKED (2c). Under a person filter this
    // table is HER records — except `Sold` and `R/R %`, which are the venue's and
    // have no person-scoped version to have. The owner's rule is that a mixed row
    // must say so, so the two venue headings carry a `*` that
    // `VENUE_COLUMNS_IN_RECORD_TABLE` defines in the note below.
    //
    // THE MARK IS ONLY ADDED UNDER A FILTER, for two reasons. Unfiltered there is
    // no second scope to distinguish and the download stays byte-identical to
    // what already ships; and the widths here are MEASURED (see above), so the
    // headings cannot simply grow. Re-measured on the renderer's own pdfkit
    // document at Helvetica-Bold 8 with PAD 4: 'Sold*' is 20.45pt of ink into
    // 38.03pt usable, and 'R/R %*' is 26.22pt into 28.02pt — both fit without
    // truncation, where 'Sold (venue)' (47.93pt) and 'R/R % (venue)' (53.70pt)
    // would not, and buying them would have to come out of `Item`, the column the
    // measurement above was fought for. The `R/R %` cell's own ceiling, '100.0%'
    // at Helvetica 8, is 27.13pt, so the column still holds both.
    columns: [
      { label: 'Item', width: 135, fitPrint: true },
      { label: 'Group', width: 52 },
      { label: recordNote ? 'Sold*' : 'Sold', width: 46, align: 'right' },
      { label: 'Feedbacks', width: 50, align: 'right' },
      { label: 'Negative', width: 42, align: 'right' },
      { label: 'Neg %', width: 36, align: 'right' },
      { label: 'Returned', width: 44, align: 'right' },
      { label: 'Remade', width: 40, align: 'right' },
      { label: recordNote ? 'R/R %*' : 'R/R %', width: 36, align: 'right' },
      { label: 'Happy', width: 34, align: 'right' },
    ],
    // Neg % narrows on BOTH sides (her negatives over her feedbacks), so it is
    // one population and stays inline. R/R % is the venue's on both sides and
    // arrives PRE-COMPUTED on the row — there is no numerator here to pair with
    // `m.sold` by mistake any more. Read 2c.
    rows: rows.map((m) => [
      m.menu_item, groupLabel(m), qtyText(m.sold), m.feedbacks, m.negative,
      pctText(rate(m.negative, m.feedbacks)), m.returned, m.remade,
      pctText(m.return_remake_pct), m.happy_after,
    ]),
    note: withNote(
      `${NEGATIVE_PCT_BASIS} ${RETURN_REMAKE_BASIS} ${GROUP_UNKNOWN_BASIS}`,
      recordNote ? `${VENUE_COLUMNS_IN_RECORD_TABLE} ${recordNote}` : '',
    ),
    emptyNote: recordNote
      ? `${p.records.person} recorded no item feedback in this period. The dishes the venue sold are not listed here, because "this person did not mention it" is not a record of anything - the venue's own menu-item sheet is the unfiltered download.`
      : 'No menu items matched these filters.',
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
          openNowTile,
        ],
        tables: [
          ...personTables,
          dailyTable,
          {
            name: 'Rating split',
            columns: [{ label: 'Overall rating', width: 2 }, { label: 'Feedbacks', width: 1.1, align: 'right' }, { label: 'Share', width: 1, align: 'right' }],
            // Every share is over the SAME denominator — every visit in scope,
            // `feedbacks_recorded` — and the Total row prints it, so the sheet
            // reconciles against the Summary on its own face. The first cut
            // divided the four ratings by "rated only" and Not rated by
            // "rated + unrated", so the column did not add to 100 %, and the
            // whole sheet counted a different population from the Summary's
            // "Feedbacks taken".
            rows: (() => {
              const total = s.feedbacks_recorded;
              const out: (string | number)[][] = OVERALL_RATINGS.map((o) => {
                const v = o.v === 'excellent' ? s.excellent : o.v === 'good' ? s.good : o.v === 'average' ? s.average : s.poor;
                return [o.label, v, pctText(rate(v, total))];
              });
              out.push(['Not rated', s.unrated, pctText(rate(s.unrated, total))]);
              out.push(['Total feedbacks recorded', total, pctText(rate(total, total))]);
              return out;
            })(),
            note: withNote('"Everything Good" submissions are counted under their overall rating; a visit '
              + 'recorded with no overall rating is listed as Not rated. The Total is the same '
              + '"Feedbacks recorded" figure as the Summary sheet - every visit in scope, '
              + 'including any on a table that never met the eligibility trigger.', venueNote),
            emptyNote: 'No feedback was recorded in this period.',
          },
          {
            name: 'Category ratings',
            note: venueNote || undefined,
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
          // `records.items_sold` is the VENUE count of dishes sold, not
          // `p.menu_items.length`: under a person filter the table lists only the
          // dishes THEY commented on, so "of 3 items sold" would have replaced the
          // kitchen's real 45 with the length of a narrowed list.
          { label: 'Items with feedback', value: n0(p.menu_items.filter((m) => m.feedbacks > 0).length), sub: `of ${n0(p.records.items_sold)} items sold` },
          { label: 'Plates sold', value: qtyText(s.plates_sold) },
          // NEGATIVE TILE 1: venue, always. `records.negative_item_feedbacks` is
          // the record-scoped twin and is used only as a rate denominator below.
          { label: 'Negative item feedbacks', value: n0(s.negative_item_feedbacks) },
          { label: 'Returned + remade', value: n0(s.returned + s.remade) },
        ],
        tables: [
          ...personTables,
          menuTable(p.menu_items),
          {
            name: 'Most complained',
            columns: [{ label: 'Item', width: 3, fitPrint: true }, { label: 'Negative', width: 1.1, align: 'right' }, { label: 'Feedbacks', width: 1.2, align: 'right' }, { label: 'Neg %', width: 1, align: 'right' }],
            rows: p.most_complained.map((x) => [x.label, x.count, x.feedbacks, pctText(x.negative_pct)]),
            note: withNote('Ordered by absolute count, deliberately: a rate alone hides a high-volume dish with many complaints, and a count alone hides a rarely-ordered one that is always wrong. Read this beside Negative %.', recordNote),
            emptyNote: recordNote
              ? `${p.records.person} recorded no complaint against any item in this period. An empty sheet here is NOT a clean venue - the Negative item feedbacks tile on the Report sheet is the venue's figure and it is unaffected by this filter.`
              : 'No negative item feedback in this period.',
          },
          {
            name: 'Most appreciated',
            columns: [{ label: 'Item', width: 3, fitPrint: true }, { label: 'Good ratings', width: 1.4, align: 'right' }, { label: 'Feedbacks', width: 1.2, align: 'right' }],
            rows: p.most_appreciated.map((x) => [x.label, x.count, x.feedbacks]),
            note: recordNote || undefined,
            emptyNote: recordNote
              ? `${p.records.person} recorded no positive item feedback in this period.`
              : 'No positive item feedback in this period.',
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
          ...personTables,
          {
            name: 'By item',
            // Same two venue cells in a record row, same mark, same note (2c).
            // These widths are WEIGHTS, not points, and both columns have room:
            // 'Sold*' 20.45pt into 38.38pt usable, 'R/R %*' 26.22pt into 40.95pt.
            columns: [
              { label: 'Item', width: 2.8, fitPrint: true }, { label: recordNote ? 'Sold*' : 'Sold', width: 0.9, align: 'right' },
              { label: 'Returned', width: 1.1, align: 'right' }, { label: 'Remade', width: 1, align: 'right' },
              { label: 'Replaced', width: 1.1, align: 'right' }, { label: 'Cancelled', width: 1.2, align: 'right' },
              { label: recordNote ? 'R/R %*' : 'R/R %', width: 0.95, align: 'right' }, { label: 'Happy', width: 0.95, align: 'right' },
            ],
            rows: p.menu_items
              .filter((m) => m.returned + m.remade + m.replaced + m.cancelled > 0)
              .sort((a, b) => (b.returned + b.remade) - (a.returned + a.remade))
              .map((m) => [
                m.menu_item, qtyText(m.sold), m.returned, m.remade, m.replaced, m.cancelled,
                pctText(m.return_remake_pct), m.happy_after,
              ]),
            note: withNote(
              RETURN_REMAKE_BASIS,
              recordNote ? `${VENUE_COLUMNS_IN_RECORD_TABLE} ${recordNote}` : '',
            ),
            emptyNote: recordNote
              ? `${p.records.person} recorded nothing returned, remade, replaced or cancelled in this period. The Returned / Remade / Replaced / Cancelled tiles on the Report sheet are the venue's and are unaffected by this filter.`
              : 'Nothing was returned, remade, replaced or cancelled in this period.',
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
          ...personTables,
          {
            name: 'Most common problems',
            columns: [{ label: 'Problem', width: 3 }, { label: 'Count', width: 1, align: 'right' }, { label: 'Share of negatives', width: 1.5, align: 'right' }],
            // 🐞 BOTH SIDES OF A RATE MUST COUNT THE SAME POPULATION.
            // `p.common_problems` is RECORD-level, so its denominator must be
            // `p.records.negative_item_feedbacks` and not the venue tile
            // `s.negative_item_feedbacks`. Dividing one person's issue counts by
            // the venue's negatives printed shares that do not add to 100 % and
            // made an honest recorder's problems look like a rounding error.
            rows: p.common_problems.map((x) => [x.label, x.count, pctText(rate(x.count, p.records.negative_item_feedbacks))]),
            // The basis sentence is attached ONLY under a person filter, where
            // the sheet's scope and the venue tile of the same name differ. With
            // no name picked the two coincide, the sentence is redundant, and
            // leaving it off keeps every unfiltered download byte-identical to
            // what this module already ships (measured, all eight, old vs new).
            note: recordNote
              ? `Share of negatives is each problem over the negative feedbacks in the SAME scope as this sheet, so the column adds to 100%. ${recordNote}`
              : undefined,
            emptyNote: recordNote
              ? `${p.records.person} recorded no issue against any item in this period.`
              : 'No issue was recorded against any item in this period.',
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
          { label: 'Venue coverage', value: pctText(s.coverage_pct), sub: `${n0(s.eligible_tables_covered)} of ${n0(s.eligible_tables)} eligible tables` },
          { label: 'Follow-ups raised', value: n0(s.follow_ups_raised) },
          { label: 'Follow-ups completed', value: n0(s.follow_ups_completed) },
          { label: 'Still open', value: n0(s.pending_follow_ups) },
        ],
        tables: [
          ...personTables,
          {
            name: 'By person',
            // Measured widths (see the menuTable note). "Follow-ups
            // completed" and "Recovery follow-up %" both truncated to
            // "Follow-ups co…" / "Recovery follo…" at the old widths; the
            // note below carries the full meaning of each short heading.
            //
            // 🐞 AND THEN A TRUNCATED PERCENTAGE INVERTED ITS OWN MEANING.
            // Sizing the free-text columns first and giving the numbers "the
            // measured minimum" used the HEADING as the minimum, which for a
            // right-aligned number column is the wrong bound: the heading is
            // short and the cell is long. `Their floor` got 45.0pt usable,
            // and `report-pdf.ts` tail-chops, so on the owner's real floors
            // (First Floor 188 tables, Second Floor 100, Terrace 4):
            //
            //     "188/188 100.0%"  printed as  "188/188 1…"
            //     "142/188 75.5%"   printed as  "142/188 7…"
            //
            // A GRE who covered EVERY table on her floor printed a coverage
            // of "1…", which a manager reads as 1%. The best possible row
            // printed as the worst possible number, in a file that gets
            // e-mailed — the fairness ruling breached by the renderer rather
            // than by the query. `Recovery` did the same past 100 complaints.
            //
            // Every width below is now the CEILING CELL, not the heading:
            // max(heading at Helvetica-Bold 8, worst-case cell at Helvetica 8)
            // + 2*PAD, measured with `doc.widthOfString()` on the renderer's
            // own document, with the remainder to Person and Floor. The
            // ceilings are provable, not guessed: 292 tables is the whole
            // venue, so "292/292 100.0%" (58.3pt) is the widest `Their floor`
            // cell that can ever exist. Re-measured: 0 of 10 columns overflow,
            // and all 9 real `Their floor` cells print in full.
            columns: [
              { label: 'Person', width: 82, fitPrint: true }, { label: 'Floor', width: 66, fitPrint: true },
              { label: 'Tables', width: 34, align: 'right' },
              { label: 'Their floor', width: 68, align: 'right' },
              { label: 'Off-floor', width: 42, align: 'right' },
              { label: 'Issues', width: 34, align: 'right' },
              { label: 'Raised', width: 36, align: 'right' },
              { label: 'Completed', width: 51, align: 'right' },
              { label: 'Open', width: 30, align: 'right' },
              // Not "Recovery %": a bare ratio in this column printed `0.0%`
              // for the GRE with two complaints still to revisit and `-` for
              // the one who recorded none, so the honest row read worse AND
              // sorted below. `recoveryCell()` carries its denominator.
              // 72, not 62: "999/999 · 100.0%" is 62.7pt, so 62 tail-chopped a
              // three-digit recovery rate to "100/100 · 10…" — see above.
              { label: 'Recovery', width: 72, align: 'right' },
            ],
            rows: p.gre_performance.map((g) => [
              g.person,
              g.area_assigned ? g.area_zones.join(' / ') : 'all',
              g.tables_visited,
              g.area_assigned ? `${g.area_covered ?? 0}/${g.area_eligible ?? 0} ${pctText(g.area_coverage_pct)}` : '-',
              g.area_assigned ? g.off_area_visits : '-',
              g.issues_recorded,
              g.follow_ups_raised, g.follow_ups_completed, g.follow_ups_open,
              recoveryCell(g.follow_ups_completed, g.follow_ups_raised),
            ]),
            note: 'Tables = eligible tables this person recorded feedback on, anywhere. '
              + '"Their floor" is coverage of the eligible tables on the floor assigned to them '
              + '(users.preferred zones) - the owner\'s ruling: the floor is a DEFAULT, not a '
              + 'restriction, so a person with no assignment shows "-" rather than an invented '
              + 'denominator. "Off-floor" is visits they made helping on someone else\'s floor; '
              + 'it is counted as work and is already inside Tables. Issues = complaints they '
              + 'wrote down. Raised / Completed / Open = follow-ups they created, closed and '
              + `still owe. ${ISSUES_RECORDED_IS_NOT_A_PENALTY} ${RECOVERY_IS_A_QUEUE} `
              + 'A person listed with 0 everywhere holds the GRE role and recorded nothing in '
              + 'this period - that row is the point of this table, not an error.'
              // EVERY person, even when one name is picked: this table is where a
              // manager compares, so narrowing it to one row would destroy the
              // only thing it is for. The leading space lives INSIDE the ternary,
              // so with no name picked this note is character-for-character the
              // one this module already ships.
              + (venueNote ? ' EVERY person in scope is listed here, including when a GRE / Manager '
                + 'filter is set - this sheet never narrows to one name.' : ''),
            emptyNote: 'Nobody holds the GRE role and nobody recorded feedback in this period.',
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
          ...personTables,
          recoveryTable,
          {
            name: 'By item',
            columns: [
              { label: 'Item', width: 2.8, fitPrint: true }, { label: 'Negative', width: 1.1, align: 'right' },
              { label: 'Returned', width: 1.1, align: 'right' }, { label: 'Remade', width: 1, align: 'right' },
              { label: 'Replaced', width: 1.1, align: 'right' },
              { label: 'Happy', width: 0.95, align: 'right' }, { label: 'Still unhappy', width: 1.3, align: 'right' },
            ],
            rows: p.menu_items
              .filter((m) => m.negative + m.happy_after + m.still_unhappy > 0)
              .map((m) => [m.menu_item, m.negative, m.returned, m.remade, m.replaced, m.happy_after, m.still_unhappy]),
            note: recordNote || undefined,
            emptyNote: recordNote
              ? `No complaint ${p.records.person} recorded needed recovery in this period. The venue's own recovery figures are the unfiltered download.`
              : 'No complaint needed recovery in this period.',
          },
          {
            name: 'Open complaints now (all dates)',
            columns: [{ label: 'Measure', width: 3 }, { label: 'Count', width: 1, align: 'right' }],
            // Two rows when a person is selected, never one: this figure is the
            // VENUE's and the workbook is headed with a person's name, so a
            // single row read as theirs (measured: 3 printed against a GRE who
            // had raised none).
            rows: p.person
              ? [
                ['Follow-ups still open, every date - THE WHOLE VENUE', s.open_follow_ups_now],
                [`Of those, raised by ${p.person.person}`, p.person.follow_ups_open],
              ]
              : [['Follow-ups still open, every date', s.open_follow_ups_now]],
            note: 'Deliberately NOT bound by the period filter: an unresolved complaint from last week is still unresolved today, and a manager reading "Today" must not be told there are none.'
              + (p.person ? ' The first row is the whole venue, not this person.' : ''),
          },
        ],
      };
  }
}
