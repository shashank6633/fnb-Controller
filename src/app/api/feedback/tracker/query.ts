/**
 * Page 3 — THE FEEDBACK TRACKER READ.  (P4 Lane A)
 *
 * SELECT-ONLY, like every other read in this module. There is not one INSERT,
 * UPDATE or DELETE below, and the route that calls it exports `GET` and nothing
 * else — so the read-only guarantee stays structural rather than a check
 * somebody could forget.
 *
 * ── WHY THIS FILE IS HERE AND NOT IN `src/lib/feedback/read.ts` ─────────────
 * `read.ts` is the FLOOR BOARD's library and a concurrent lane owns it. The
 * tracker asks a different question over a different universe (see §1), so it
 * gets its own file, colocated with its only caller. Next only treats
 * `route.ts` / `page.tsx` as routes, so a plain module in an `app/api/...`
 * folder is just a module. It imports `read.ts` for the primitives that MUST
 * agree across pages — `sqlUtcToIso`, `readTunables`, `feedbackBoardCutoff`,
 * `floorLabel` and the Food/Drinks classifier — because a second copy of any of
 * those is how Page 1 and Page 3 end up disagreeing about the same table.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 1. THE UNIVERSE — and why it is NOT the floor board's
 * ════════════════════════════════════════════════════════════════════════════
 * Page 1 answers "which tables should I walk to NOW", so it shows open tables
 * plus a short grace after settling, and it drops anything older than the
 * current service.
 *
 * Page 3 answers the Floor Manager's question — the owner's own words about the
 * coverage table: "This helps the Floor Manager ensure that GREs are actually
 * visiting tables." That question cannot be answered over the live board,
 * because THE TABLES A GRE MISSED ARE EXACTLY THE ONES THAT HAVE SETTLED AND
 * LEFT IT. A coverage figure computed over "tables currently on the floor"
 * would read 100 % on a night where half the room walked out unvisited.
 *
 * So the tracker's universe is ONE WHOLE BUSINESS DAY: every dine-in order of
 * that service, settled or not, that met the owner's eligibility trigger.
 *   - eligible = COUNT(order_items) >= feedback_item_threshold
 *                OR bill_requested_at OR bill_printed_at — the same three
 *                triggers as Page 1, read through the same readTunables().
 *   - voided orders are excluded (both markers, as Page 1 does).
 *   - takeaway / no-table-row orders are excluded and COUNTED in meta.excluded.
 *   - an order that never became eligible is excluded and counted as
 *     not_yet_eligible — it is Page 1's "Not Ready" and was never owed a visit.
 *
 * THE DAY IS THE 04:00 IST BUSINESS DAY, ANCHORED ON created_at. Both halves of
 * that sentence are decisions:
 *   (a) IST, not UTC. Every stamp in this database is UTC (datetime('now')) and
 *       the restaurant runs IST. A UTC-bucketed "today" would cut the service in
 *       half at 05:30 IST and file the last two hours of dinner under tomorrow.
 *       The rule used is the app's existing one — HRMS's businessDateOf() with
 *       the hr_day_cutoff convention, reached through feedbackBoardCutoff() so
 *       the night-window guard (a cutoff is only honoured at 00:00-07:59) and
 *       the `source` provenance are identical to Page 1's. One venue, one idea
 *       of where the night ends.
 *   (b) Anchored on orders.created_at, i.e. a table belongs to the service it
 *       OPENED in. Page 1 dates a row by its LAST ACTIVITY because it is asking
 *       whether the table is still alive; a ledger must not move rows between
 *       days as the evening goes on, or last night's coverage % changes while
 *       you read it. A table opened 03:55 IST therefore belongs to the previous
 *       business day even if its bill printed at 05:30 — which is the whole
 *       point of a 04:00 rollover.
 *
 * CARRIED-OVER COMPLAINTS. An open follow-up from an earlier service is a guest
 * still owed a revisit, and a screen that hides it is the one disappearance
 * nobody would forgive. Those records are INCLUDED, flagged carried_over: true,
 * and deliberately kept OUT of the day's active/due/taken/coverage arithmetic —
 * they belong to their own day's denominator and adding them would silently
 * change yesterday's coverage. counts.carried_over_follow_up reports them as
 * their own number, and the follow_up FILTER shows them (a revisit owed is
 * work, whatever day it came from). That asymmetry is stated on screen rather
 * than smoothed over.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 2. THE FAIRNESS RULING — the owner's, verbatim, and it is law here
 * ════════════════════════════════════════════════════════════════════════════
 *   "The system should NOT judge GRE performance based on positive feedback. A
 *    GRE should never avoid recording negative feedback because it affects
 *    their performance."
 *
 * Measured per person, and NOTHING else: Feedback Coverage - Tables Visited -
 * Follow-Ups Completed - Issues Properly Recorded - Guest Recovery Follow-Up.
 * So the coverage table carries no average rating, no complaint ratio, no score
 * and no ranking by sentiment. `issues_recorded` IS in the owner's allowed list
 * ("Issues Properly Recorded") and is labelled as an ACTIVITY — a GRE who
 * recorded ten complaints and one who recorded none must never be orderable
 * such that the first looks worse. Any column added later that makes recording
 * a complaint look bad for the recorder is a DEFECT, not a feature.
 *
 * WHAT CANNOT HONESTLY BE COMPUTED PER PERSON, and is therefore not.
 * "Eligible tables" is a property of the FLOOR, not of a person: nothing in this
 * app assigns a table to a GRE, so there is no data from which to say table 24
 * was Priya's to visit. Dividing the room by the number of GREs on shift would
 * be an invented denominator, and an invented denominator in a performance
 * table is worse than no number at all. So Eligible / Pending / Coverage % are
 * reported on the FLOOR TOTAL row (`totals`), which is a real, checkable fact,
 * and each person's row carries their real activity plus `share_pct` — their
 * share of the tables that WERE covered. `coverage_scope: 'floor'` says so in
 * the payload, and the page prints it.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 3. COUNTS ARE COMPUTED WHERE THE ROWS ARE
 * ════════════════════════════════════════════════════════════════════════════
 * Both the header tiles and the filter chips are derived server-side from
 * EXACTLY the rows the list will draw, after the Floor / GRE / Manager / Captain
 * scope is applied. Lane B measured the alternative on Page 1: chips counting
 * the whole venue above a grid showing one floor, on the numbers a GRE is
 * measured by. `counts` is the header (today's eligible tables only);
 * `filter_counts` is what each chip will show (carried-over rows included).
 * They are different questions and they are labelled as different questions.
 */

import type Database from 'better-sqlite3';
import {
  classifyStation,
  feedbackBoardCutoff,
  floorLabel,
  knownStations,
  readTunables,
  sqlUtcToIso,
  type BoardDay,
} from '@/lib/feedback/read';
import { GRE_ROLE_NAME } from '@/lib/feedback/access';
import { businessDateOf } from '@/lib/hr-attendance';
import {
  isNegative,
  isResolved,
  tableStatus,
  TRACKER_FILTERS,
  type ItemGroup,
  type TableStatus,
  type TrackerFilter,
} from '@/lib/feedback';

/* ════════════════════════════════════════════════════════════════════════════
   4. THE WIRE SHAPES
   ════════════════════════════════════════════════════════════════════════════ */

/** One complained-about / acted-on line inside a record. Money is NOT here and
 *  never will be: unit_price, line_total and every tax column stay behind in
 *  order_items, exactly as Page 1's ordered-items read leaves them. */
export interface TrackerItemRow {
  id: string;
  item_name: string;
  item_group: ItemGroup | string;
  station: string;
  quantity: number;
  rating: string;
  issue: string;
  comment: string;
  action_taken: string;
  replacement_item_name: string;
  is_negative: boolean;
  /** The follow-up this line raised, when it raised one. */
  follow_up: {
    id: string;
    status: string;
    revisit_rating: string;
    happiness: string;
    revisit_comment: string;
    revisited_at: string | null;
    revisited_by: string;
    closed_at: string | null;
    escalated_at: string | null;
  } | null;
}

/** One table's record for the service. The owner's example line —
 *  "Table 24 - Chicken Tikka - Poor - Issue: Dry - Action: Remade - Status:
 *  Follow-Up Required - GRE: Priya - Captain: Ramesh" — is this row plus its
 *  `items`. */
export interface TrackerRecordRow {
  order_id: string;
  order_number: string;
  table_id: string;
  table_number: string;
  /** restaurant_tables.zone, '' bucketed to 'Floor' (captain-area.ts:30). */
  floor: string;
  covers: number | null;
  captain_name: string;
  order_status: string;
  opened_at: string | null;
  settled_at: string | null;
  bill_requested_at: string | null;
  bill_printed_at: string | null;
  item_count: number;
  food_count: number;
  drinks_count: number;
  eligible_by: { items: boolean; bill_requested: boolean; bill_printed: boolean };
  status: TableStatus;
  /** Null until a visit exists — which is the point of the Pending filter. */
  visit_id: string | null;
  gre_user_id: string;
  gre_name: string;
  /** roles.name AS AT THE VISIT, not as it is today. A rename or a
   *  re-assignment later must not rewrite who took last week's feedback. */
  gre_role: string;
  taken_at: string | null;
  overall: string;
  everything_good: boolean;
  categories: { food: string; drinks: string; service: string; ambience: string };
  visit_comment: string;
  /** Negative ITEM lines. has_negative on the visit is a cache; this is counted. */
  issues: number;
  follow_ups_total: number;
  open_follow_ups: number;
  items: TrackerItemRow[];
  /** True when this record belongs to an EARLIER business day and is on screen
   *  only because a revisit is still owed. Excluded from the day's arithmetic. */
  carried_over: boolean;
  business_date: string;
}

/** One line of the GRE / Manager progress table. See §2 for what is absent. */
export interface TrackerCoverageRow {
  person_id: string;
  person: string;
  role: string;
  /** 'gre' = recorded carrying the assigned GRE role - 'management' = recorded
   *  as management - 'assigned' = holds the GRE role but recorded nothing
   *  today, which is precisely the case the Floor Manager opened this page to
   *  see. */
  kind: 'gre' | 'management' | 'assigned';
  tables_visited: number;
  taken: number;
  issues_recorded: number;
  follow_ups_opened: number;
  follow_ups_completed: number;
  follow_ups_open: number;
  /** Share of the tables that WERE covered. Not a coverage %. */
  share_pct: number | null;
}

export interface TrackerTotals {
  /** Eligible tables in scope for the business day = the coverage denominator. */
  eligible: number;
  taken: number;
  pending: number;
  coverage_pct: number | null;
  /** Always 'floor' — see §2. Named in the payload so the page cannot quietly
   *  start printing this number in a per-person row. */
  coverage_scope: 'floor';
}

export interface TrackerScope {
  floor: string;
  gre: string;
  manager: string;
  captain: string;
  filter: TrackerFilter;
  date: string;
}

export interface TrackerMeta {
  generated_at: string;
  business_date: string;
  board_cutoff: string;
  board_cutoff_source: BoardDay['source'];
  /** The business date "now" falls in — so a page showing an older date says so. */
  today_business_date: string;
  /** Set when the requested `date` was unusable and today was served instead. */
  date_note: string;
  item_threshold: number;
  item_threshold_is_default: boolean;
  item_threshold_clamped: boolean;
  scope: TrackerScope;
  excluded: {
    takeaway_or_other: number;
    table_row_missing: number;
    not_yet_eligible: number;
  };
  /** Which filters the header tiles, the floor total and the progress table
   *  reflect — Floor and Captain, never GRE/Manager. Filtering a coverage
   *  figure by a person deletes every unvisited table and reads 100 %. */
  counts_scope: string;
  /** Why there is no Section filter. restaurant_tables.section exists but is
   *  unpopulated on this database; a dropdown that returns nothing is worse
   *  than no dropdown. Measured live, never assumed. */
  section_filter: string;
  /** gf_visits.open_follow_ups / has_negative are documented CACHES. This is
   *  the number of visits in scope whose cache disagrees with the rows it
   *  counts — 0 is the expected value and a non-zero is a real defect signal,
   *  not something to hide. The records always report the COUNTED truth. */
  cache_mismatch: number;
}

export interface TrackerOptions {
  floors: string[];
  gres: string[];
  managers: string[];
  captains: string[];
}

export interface TrackerPayload {
  records: TrackerRecordRow[];
  counts: Record<string, number>;
  filter_counts: Record<string, number>;
  coverage: TrackerCoverageRow[];
  totals: TrackerTotals;
  options: TrackerOptions;
  meta: TrackerMeta;
}

/* ════════════════════════════════════════════════════════════════════════════
   5. THE BUSINESS-DAY WINDOW
   ════════════════════════════════════════════════════════════════════════════ */

const IST_OFFSET_MIN = 330;
const DAY_MS = 86_400_000;

/** 'HH:MM' -> minutes. feedbackBoardCutoff() has already validated and
 *  night-window-guarded its answer, so this only has to parse it; anything else
 *  falls back to 04:00 rather than throwing. */
function cutoffMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  if (!m) return 4 * 60;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return 4 * 60;
  return h * 60 + min;
}

/**
 * businessDateOf() THROWS on an unparseable stamp — right for an attendance
 * punch, wrong here: a row we cannot date must be VISIBLE and flagged, never
 * silently filed under a guessed day. Null means "unknown".
 */
function businessDateOfSafe(atUtc: unknown, cutoff: string): string | null {
  const s = String(atUtc ?? '').trim();
  if (!s) return null;
  try {
    const d = businessDateOf(s, cutoff);
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
  } catch {
    return null;
  }
}

/** Epoch ms -> the storage shape (YYYY-MM-DD HH:MM:SS, UTC). */
function utcStamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * The UTC window a business date covers, WIDENED BY A DAY ON EACH SIDE.
 *
 * The widening is deliberate. This window is only a cheap SQL PREFILTER (there
 * is no index on orders.created_at, so it is a scan filter either way); the
 * exact decision is made in JS by businessDateOfSafe(). Two reasons not to
 * trust the string comparison alone: a stamp written in the ISO T form would
 * sort above the space form at the boundary ('T' 0x54 > ' ' 0x20), and a column
 * written by a different code path could carry fractional seconds. Over-select,
 * then decide precisely.
 */
function dayWindow(businessDate: string, cutoff: string): { from: string; to: string } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(businessDate);
  if (!m) return null;
  const midnight = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(midnight)) return null;
  const start = midnight + (cutoffMinutes(cutoff) - IST_OFFSET_MIN) * 60_000;
  return { from: utcStamp(start - DAY_MS), to: utcStamp(start + 2 * DAY_MS) };
}

/** A requested `date`, or null. Format-checked AND real-date-checked, so
 *  2026-02-31 is refused rather than silently normalised by Date. */
export function validBusinessDate(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, mo, d] = s.split('-').map(Number);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    return null;
  }
  return s;
}

/* ════════════════════════════════════════════════════════════════════════════
   6. THE READ
   ════════════════════════════════════════════════════════════════════════════ */

const ORDER_COLUMNS = `
        o.id                AS order_id,
        o.order_number      AS order_number,
        o.order_type        AS order_type,
        o.status            AS order_status,
        o.covers            AS covers,
        o.server_name       AS server_name,
        o.created_at        AS opened_at,
        o.settled_at        AS settled_at,
        o.bill_requested_at AS bill_requested_at,
        o.bill_printed_at   AS bill_printed_at,
        t.id                AS t_id,
        t.table_number      AS table_number,
        t.zone              AS zone,
        v.id                AS visit_id,
        v.gre_user_id       AS gre_user_id,
        v.gre_name          AS gre_name,
        v.gre_role          AS gre_role,
        v.created_at        AS visited_at,
        v.overall_rating    AS overall_rating,
        v.everything_good   AS everything_good,
        v.comment           AS visit_comment,
        v.cat_food          AS cat_food,
        v.cat_drinks        AS cat_drinks,
        v.cat_service       AS cat_service,
        v.cat_ambience      AS cat_ambience,
        v.has_negative      AS cached_has_negative,
        v.follow_ups_total  AS cached_follow_ups_total,
        v.open_follow_ups   AS cached_open_follow_ups`;

interface ItemAgg {
  total: number;
  food: number;
  drinks: number;
}

export function readTracker(
  db: Database.Database,
  opts: { outletId: string | null; scope: Partial<TrackerScope> },
): TrackerPayload {
  const t = readTunables(db);
  const day = feedbackBoardCutoff(db);
  const outletId = opts.outletId ?? '';

  // ── the day being reported ────────────────────────────────────────────────
  const asked = validBusinessDate(opts.scope.date);
  let dateNote = '';
  let target = day.businessDate;
  if (opts.scope.date && !asked) {
    dateNote = `"${String(opts.scope.date).slice(0, 32)}" is not a date (YYYY-MM-DD) - showing today's service instead.`;
  } else if (asked && day.businessDate && asked > day.businessDate) {
    dateNote = `${asked} has not happened yet - showing today's service instead.`;
  } else if (asked) {
    target = asked;
  }

  const scope: TrackerScope = {
    floor: String(opts.scope.floor ?? 'all') || 'all',
    gre: String(opts.scope.gre ?? 'all') || 'all',
    manager: String(opts.scope.manager ?? 'all') || 'all',
    captain: String(opts.scope.captain ?? 'all') || 'all',
    filter: (TRACKER_FILTERS.some((f) => f.v === opts.scope.filter)
      ? opts.scope.filter
      : 'all') as TrackerFilter,
    date: target,
  };

  const win = dayWindow(target, day.cutoff);

  // ── (a) the day's orders ──────────────────────────────────────────────────
  const dayRows: any[] = win
    ? (db
      .prepare(
        `SELECT ${ORDER_COLUMNS}
           FROM orders o
           LEFT JOIN restaurant_tables t ON t.id = o.table_id
           LEFT JOIN gf_visits         v ON v.order_id = o.id
          WHERE o.voided_at IS NULL
            AND o.status <> 'void'
            AND (o.outlet_id = ? OR o.outlet_id IS NULL OR o.outlet_id = '')
            AND o.created_at >= ? AND o.created_at < ?`,
      )
      .all(outletId, win.from, win.to) as any[])
    : [];

  // ── (b) day membership, and the exclusions, COUNTED ───────────────────────
  const excluded = { takeaway_or_other: 0, table_row_missing: 0, not_yet_eligible: 0 };
  const kept: { raw: any; carried: boolean; businessDate: string }[] = [];

  for (const r of dayRows) {
    const bd = businessDateOfSafe(r.opened_at, day.cutoff);
    // An UNDATEABLE order is kept (shown) rather than dropped — a coverage
    // ledger must over-show, never under-show.
    if (bd && bd !== target) continue;
    if (String(r.order_type ?? '') !== 'dine-in') { excluded.takeaway_or_other++; continue; }
    if (!r.t_id) { excluded.table_row_missing++; continue; }
    kept.push({ raw: r, carried: false, businessDate: bd ?? '' });
  }

  // ── (c) the carried-over complaints ───────────────────────────────────────
  // Prefiltered from gf_follow_ups ITSELF, not from the gf_visits
  // open_follow_ups cache: if the cache were ever wrong, a cache-driven query
  // would hide the very row it is most important not to hide. (The cache is
  // still read, and any disagreement is reported in meta.cache_mismatch.)
  //
  // ⚠️ THE DEDUPE MUST BE AGAINST THE ROWS THAT SURVIVED (b), NOT AGAINST THE
  // SQL PREFILTER. Measured: the prefilter window is deliberately a day wider
  // on each side, so LAST NIGHT'S order is inside it, was therefore already in
  // `seen`, and its carried-over row was skipped — and then (b) dropped it for
  // belonging to another business day. The open complaint vanished from both
  // paths at once. `seen` is now built from `kept`.
  const openVisitIds = (db
    .prepare(`SELECT DISTINCT visit_id AS id FROM gf_follow_ups WHERE status = 'open'`)
    .all() as any[]).map((r) => String(r.id)).filter(Boolean);

  const seen = new Set(kept.map((k) => String(k.raw.order_id)));
  for (const chunk of chunked(openVisitIds, 400)) {
    const rows = db
      .prepare(
        `SELECT ${ORDER_COLUMNS}
           FROM gf_visits v
           JOIN orders o                 ON o.id = v.order_id
           LEFT JOIN restaurant_tables t ON t.id = o.table_id
          WHERE v.id IN (${chunk.map(() => '?').join(',')})
            AND o.voided_at IS NULL
            AND o.status <> 'void'
            AND (o.outlet_id = ? OR o.outlet_id IS NULL OR o.outlet_id = '')`,
      )
      .all(...chunk, outletId) as any[];
    for (const r of rows) {
      if (seen.has(String(r.order_id))) continue;     // already in the day's set
      if (String(r.order_type ?? '') !== 'dine-in') continue;
      if (!r.t_id) continue;
      const bd = businessDateOfSafe(r.opened_at, day.cutoff);
      // EARLIER services only. Looking at last Tuesday must not show a
      // complaint raised on Thursday — "carried over" means the guest was
      // already waiting when this service began, and a ledger that showed the
      // future would make yesterday's page unreadable. An undateable row (bd
      // null) is still shown: over-show, never under-show.
      if (bd && bd >= target) continue;
      seen.add(String(r.order_id));
      kept.push({ raw: r, carried: true, businessDate: bd ?? '' });
    }
  }

  // ── (d) the item aggregate, for the eligibility trigger ───────────────────
  const agg = itemCounts(db, kept.map((k) => String(k.raw.order_id)));

  // ── (e) item feedback + follow-ups for every visit in hand ────────────────
  const visitIds = kept.map((k) => k.raw.visit_id).filter(Boolean).map(String);
  const itemsByVisit = itemFeedback(db, visitIds);

  // ── (f) build the records ─────────────────────────────────────────────────
  let cacheMismatch = 0;
  const all: TrackerRecordRow[] = [];

  for (const k of kept) {
    const r = k.raw;
    const a = agg.get(String(r.order_id)) ?? { total: 0, food: 0, drinks: 0 };
    const billRequested = !!sqlUtcToIso(r.bill_requested_at);
    const billPrinted = !!sqlUtcToIso(r.bill_printed_at);
    const byItems = a.total >= t.itemThreshold;
    const eligible = byItems || billRequested || billPrinted;
    const visitId = r.visit_id ? String(r.visit_id) : null;

    // A carried-over record is on screen because a revisit is owed, whatever
    // its item count says; the DAY's records must be eligible.
    //
    // ⚠️ `|| visitId` IS AN INVARIANT, NOT A KINDNESS. A table somebody
    // actually visited belongs in the ledger even if it never met the trigger
    // (the threshold is an admin setting and can be raised mid-service). Drop
    // it and `taken` would count a visit whose table is missing from
    // `eligible` — coverage could then read above 100 %, which is how a
    // coverage number stops being believed. taken ⊆ active always holds.
    if (!eligible && !k.carried && !visitId) { excluded.not_yet_eligible++; continue; }

    const lines = visitId ? (itemsByVisit.get(visitId) ?? []) : [];
    const issues = lines.filter((l) => l.is_negative).length;
    const followTotal = lines.filter((l) => l.follow_up).length;
    const openFollow = lines.filter((l) => l.follow_up && l.follow_up.status === 'open').length;

    if (visitId) {
      const cachedOpen = Number(r.cached_open_follow_ups) || 0;
      const cachedTotal = Number(r.cached_follow_ups_total) || 0;
      const cachedNeg = !!Number(r.cached_has_negative);
      if (cachedOpen !== openFollow || cachedTotal !== followTotal || cachedNeg !== (issues > 0)) {
        cacheMismatch++;
      }
    }

    all.push({
      order_id: String(r.order_id),
      order_number: String(r.order_number ?? ''),
      table_id: String(r.t_id),
      table_number: String(r.table_number ?? ''),
      floor: floorLabel(r.zone),
      covers: r.covers == null ? null : Number(r.covers),
      captain_name: String(r.server_name ?? ''),
      order_status: String(r.order_status ?? ''),
      opened_at: sqlUtcToIso(r.opened_at),
      settled_at: sqlUtcToIso(r.settled_at),
      bill_requested_at: sqlUtcToIso(r.bill_requested_at),
      bill_printed_at: sqlUtcToIso(r.bill_printed_at),
      item_count: a.total,
      food_count: a.food,
      drinks_count: a.drinks,
      eligible_by: { items: byItems, bill_requested: billRequested, bill_printed: billPrinted },
      status: tableStatus({
        hasVisit: !!visitId,
        eligible,
        openFollowUps: openFollow,
        hasNegative: issues > 0,
      }),
      visit_id: visitId,
      gre_user_id: String(r.gre_user_id ?? ''),
      gre_name: String(r.gre_name ?? ''),
      gre_role: String(r.gre_role ?? ''),
      taken_at: sqlUtcToIso(r.visited_at),
      overall: String(r.overall_rating ?? ''),
      everything_good: !!Number(r.everything_good),
      categories: {
        food: String(r.cat_food ?? ''),
        drinks: String(r.cat_drinks ?? ''),
        service: String(r.cat_service ?? ''),
        ambience: String(r.cat_ambience ?? ''),
      },
      visit_comment: String(r.visit_comment ?? ''),
      issues,
      follow_ups_total: followTotal,
      open_follow_ups: openFollow,
      items: lines,
      carried_over: k.carried,
      business_date: k.businessDate,
    });
  }

  // ── (g) the scope, in TWO layers, and the split is a correctness fix ──────
  // FLOOR + CAPTAIN describe a part of the ROOM, so every number on the page is
  // computed inside them: tiles, chips, list and coverage all agree.
  //
  // 🐞 GRE / MANAGER CANNOT WORK THE SAME WAY, and the first cut of this file
  // got it wrong. Filtering the whole page by a person removes every UNVISITED
  // table — nobody recorded them, so they carry no name — which made `due` 0
  // and coverage 100 % for whoever was selected. Measured: `?gre=TR Gre One`
  // answered `active 2, taken 2, coverage 100%` on a floor whose real coverage
  // was 50 %. That is precisely the invented per-person coverage figure §2
  // refuses to produce, and it would have appeared under the person's own name.
  // So a person filter narrows the RECORD LIST (and its chip counts) only; the
  // header tiles, the floor total and the progress table stay on the room.
  // `meta.counts_scope` says this in words and the page prints it.
  const roomScope = all.filter((r) => {
    if (scope.floor !== 'all' && r.floor !== scope.floor) return false;
    if (scope.captain !== 'all' && (r.captain_name || '—') !== scope.captain) return false;
    return true;
  });
  const inScope = roomScope.filter((r) => {
    if (scope.gre !== 'all' && !(isGreRole(r.gre_role) && r.gre_name === scope.gre)) return false;
    if (scope.manager !== 'all' && !(!isGreRole(r.gre_role) && r.gre_name === scope.manager)) {
      return false;
    }
    return true;
  });

  // ── (h) the day's arithmetic — carried-over rows deliberately excluded ────
  const today = roomScope.filter((r) => !r.carried_over);
  const counts: Record<string, number> = {
    active: today.length,
    due: today.filter((r) => !r.visit_id).length,
    taken: today.filter((r) => !!r.visit_id).length,
    issues: today.filter((r) => r.issues > 0).length,
    follow_up: today.filter((r) => r.open_follow_ups > 0).length,
    carried_over_follow_up: roomScope.filter((r) => r.carried_over).length,
  };

  const filter_counts: Record<string, number> = {};
  for (const f of TRACKER_FILTERS) filter_counts[f.v] = inScope.filter((r) => matches(r, f.v)).length;

  const records = inScope
    .filter((r) => matches(r, scope.filter))
    .sort(recordOrder);

  // ── (i) coverage ──────────────────────────────────────────────────────────
  const coverage = buildCoverage(db, today);
  const totals: TrackerTotals = {
    eligible: counts.active,
    taken: counts.taken,
    pending: counts.active - counts.taken,
    coverage_pct: counts.active ? round1((counts.taken / counts.active) * 100) : null,
    coverage_scope: 'floor',
  };

  // ── (j) the filter option lists ───────────────────────────────────────────
  const options: TrackerOptions = {
    floors: uniqSorted(all.map((r) => r.floor)),
    // Everyone who holds the GRE role is offered, not only those who recorded
    // something — "who has taken nothing today" is the question this page
    // exists to answer, and a name that vanishes when the count is 0 cannot
    // answer it.
    gres: uniqSorted([
      ...all.filter((r) => r.gre_name && isGreRole(r.gre_role)).map((r) => r.gre_name),
      ...coverage.filter((c) => c.kind !== 'management').map((c) => c.person),
    ]),
    managers: uniqSorted(all.filter((r) => r.gre_name && !isGreRole(r.gre_role)).map((r) => r.gre_name)),
    captains: uniqSorted(all.map((r) => r.captain_name || '—')),
  };

  return {
    records,
    counts,
    filter_counts,
    coverage,
    totals,
    options,
    meta: {
      generated_at: new Date().toISOString(),
      business_date: target,
      board_cutoff: day.cutoff,
      board_cutoff_source: day.source,
      today_business_date: day.businessDate,
      date_note: dateNote,
      item_threshold: t.itemThreshold,
      item_threshold_is_default: !t.itemThresholdIsSet,
      item_threshold_clamped: t.itemThresholdClamped,
      scope,
      excluded,
      counts_scope:
        scope.gre !== 'all' || scope.manager !== 'all'
          ? 'Header counts, coverage % and the progress table cover the whole floor for this service. The GRE / Manager filter narrows the record list only — an unvisited table carries nobody\'s name, so filtering coverage by a person would always read 100%.'
          : 'Header counts, coverage % and the progress table cover the selected Floor and Captain for this service.',
      section_filter: sectionFilterNote(db),
      cache_mismatch: cacheMismatch,
    },
  };
}

/* ── the six filters, in ONE place ────────────────────────────────────────── */
/**
 * So "Completed" cannot mean one thing in a chip count and another in the list.
 *
 * `negative` is deliberately WIDER than the overall rating: a table rated
 * "Good" overall with one dish marked Poor is negative feedback, and a filter
 * that only read overall_rating would hide exactly the item complaints Page 4
 * is built to analyse.
 */
export function matches(r: TrackerRecordRow, f: TrackerFilter): boolean {
  switch (f) {
    case 'all': return true;
    case 'pending': return !r.visit_id;
    case 'completed': return !!r.visit_id && r.open_follow_ups === 0;
    case 'negative': return isNegative(r.overall) || r.issues > 0;
    case 'follow_up': return r.open_follow_ups > 0;
    case 'resolved':
      return isResolved({ followUpsTotal: r.follow_ups_total, openFollowUps: r.open_follow_ups });
    default: return true;
  }
}

/** Work first, then history. A revisit owed outranks an unvisited table (the
 *  guest is already unhappy and waiting), and inside a group the guests about
 *  to leave come first — the same rule Page 1 sorts by. */
const STATUS_ORDER: Record<TableStatus, number> = {
  follow_up: 0, due: 1, issue: 2, taken: 3, not_ready: 4,
};

function recordOrder(a: TrackerRecordRow, b: TrackerRecordRow): number {
  const leaving = (x: TrackerRecordRow) => (x.bill_requested_at || x.bill_printed_at ? 0 : 1);
  return STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
    || leaving(a) - leaving(b)
    || String(a.opened_at ?? '').localeCompare(String(b.opened_at ?? ''))
    || a.table_number.localeCompare(b.table_number, undefined, { numeric: true });
}

/* ── coverage ─────────────────────────────────────────────────────────────── */

/**
 * The progress table. Seeded from the PEOPLE WHO HOLD THE GRE ROLE — not from
 * the visits — because a GRE who recorded nothing all night is the single most
 * important row on this page, and a visit-driven query cannot produce it.
 *
 * A failure to read users / roles degrades to "only the people who recorded
 * something", never to an exception: the tracker still answers.
 */
function buildCoverage(db: Database.Database, rows: TrackerRecordRow[]): TrackerCoverageRow[] {
  const out = new Map<string, TrackerCoverageRow>();
  const key = (id: string, name: string) => (id ? `id:${id}` : `nm:${name.toLowerCase()}`);

  const blank = (
    person_id: string,
    person: string,
    role: string,
    kind: TrackerCoverageRow['kind'],
  ): TrackerCoverageRow => ({
    person_id, person, role, kind,
    tables_visited: 0, taken: 0, issues_recorded: 0,
    follow_ups_opened: 0, follow_ups_completed: 0, follow_ups_open: 0,
    share_pct: null,
  });

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
      out.set(key(id, name), blank(id, name, String(p.role_name ?? GRE_ROLE_NAME), 'assigned'));
    }
  } catch {
    /* degrade to visit-derived rows only */
  }

  const tablesByPerson = new Map<string, Set<string>>();

  for (const r of rows) {
    if (!r.visit_id) continue;
    const name = r.gre_name.trim() || '(unnamed)';
    const k = key(r.gre_user_id, name);
    const kind: TrackerCoverageRow['kind'] = isGreRole(r.gre_role) ? 'gre' : 'management';
    const row = out.get(k) ?? blank(r.gre_user_id, name, r.gre_role || '—', kind);
    // A seeded row becomes 'gre' the moment it records something; a row that
    // recorded as management stays 'management'.
    if (row.kind === 'assigned') row.kind = kind;
    if (!row.role || row.role === '—') row.role = r.gre_role || row.role;
    row.taken += 1;
    row.issues_recorded += r.issues;
    for (const line of r.items) {
      if (!line.follow_up) continue;
      row.follow_ups_opened += 1;
      if (line.follow_up.status === 'open') row.follow_ups_open += 1;
      else row.follow_ups_completed += 1;
    }
    const set = tablesByPerson.get(k) ?? new Set<string>();
    set.add(r.table_id);
    tablesByPerson.set(k, set);
    out.set(k, row);
  }

  const totalTaken = rows.filter((r) => !!r.visit_id).length;
  for (const [k, row] of out) {
    row.tables_visited = (tablesByPerson.get(k)?.size) ?? 0;
    row.share_pct = totalTaken ? round1((row.taken / totalTaken) * 100) : null;
  }

  // Most active first, then alphabetical — NEVER by rating, and never ordered
  // such that recording complaints sinks a name (§2).
  return Array.from(out.values()).sort(
    (a, b) => b.taken - a.taken || a.person.localeCompare(b.person),
  );
}

/* ── the per-order item aggregate (eligibility trigger) ───────────────────── */

function itemCounts(db: Database.Database, orderIds: string[]): Map<string, ItemAgg> {
  const out = new Map<string, ItemAgg>();
  if (orderIds.length === 0) return out;
  const known = knownStations(db);

  for (const chunk of chunked(orderIds, 400)) {
    const rows = db
      .prepare(
        `SELECT order_id, LOWER(TRIM(COALESCE(station,''))) AS st, COUNT(*) AS n
           FROM order_items
          WHERE order_id IN (${chunk.map(() => '?').join(',')})
          GROUP BY order_id, st`,
      )
      .all(...chunk) as any[];
    for (const r of rows) {
      const id = String(r.order_id);
      const n = Number(r.n) || 0;
      const a = out.get(id) ?? { total: 0, food: 0, drinks: 0 };
      a.total += n;
      if (classifyStation(r.st, known).group === 'drinks') a.drinks += n;
      else a.food += n;
      out.set(id, a);
    }
  }
  return out;
}

/* ── item feedback + its follow-up ────────────────────────────────────────── */

function itemFeedback(db: Database.Database, visitIds: string[]): Map<string, TrackerItemRow[]> {
  const out = new Map<string, TrackerItemRow[]>();
  if (visitIds.length === 0) return out;

  for (const chunk of chunked(visitIds, 400)) {
    const rows = db
      .prepare(
        `SELECT f.id, f.visit_id, f.item_name, f.item_group, f.station, f.quantity,
                f.rating, f.issue, f.comment, f.action_taken, f.replacement_item_name,
                f.is_negative,
                fu.id AS fu_id, fu.status AS fu_status, fu.revisit_rating, fu.happiness,
                fu.revisit_comment, fu.revisited_at, fu.revisited_by, fu.closed_at,
                fu.escalated_at
           FROM gf_item_feedback f
           LEFT JOIN gf_follow_ups fu ON fu.item_feedback_id = f.id
          WHERE f.visit_id IN (${chunk.map(() => '?').join(',')})
          ORDER BY f.created_at`,
      )
      .all(...chunk) as any[];

    for (const r of rows) {
      const list = out.get(String(r.visit_id)) ?? [];
      list.push({
        id: String(r.id),
        item_name: String(r.item_name ?? ''),
        item_group: String(r.item_group ?? 'food'),
        station: String(r.station ?? ''),
        quantity: Number(r.quantity) || 0,
        rating: String(r.rating ?? ''),
        issue: String(r.issue ?? ''),
        comment: String(r.comment ?? ''),
        action_taken: String(r.action_taken ?? 'none'),
        replacement_item_name: String(r.replacement_item_name ?? ''),
        is_negative: !!Number(r.is_negative),
        follow_up: r.fu_id
          ? {
            id: String(r.fu_id),
            status: String(r.fu_status ?? ''),
            revisit_rating: String(r.revisit_rating ?? ''),
            happiness: String(r.happiness ?? ''),
            revisit_comment: String(r.revisit_comment ?? ''),
            revisited_at: sqlUtcToIso(r.revisited_at),
            revisited_by: String(r.revisited_by ?? ''),
            closed_at: sqlUtcToIso(r.closed_at),
            escalated_at: sqlUtcToIso(r.escalated_at),
          }
          : null,
      });
      out.set(String(r.visit_id), list);
    }
  }
  return out;
}

/* ── small helpers ────────────────────────────────────────────────────────── */

/** gf_visits.gre_role is the role name AS AT THE VISIT. Matching is trimmed and
 *  case-folded, exactly as isNamedGre() matches roles.name, so " gre " and
 *  "Gre" are the same person's role and a manager who took feedback is not
 *  filed under the GRE filter. */
function isGreRole(role: unknown): boolean {
  return String(role ?? '').trim().toLowerCase() === GRE_ROLE_NAME.trim().toLowerCase();
}

function* chunked<T>(xs: T[], n: number): Generator<T[]> {
  for (let i = 0; i < xs.length; i += n) yield xs.slice(i, i + n);
}

function uniqSorted(xs: string[]): string[] {
  return Array.from(new Set(xs.filter((x) => x !== ''))).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Whether a Section filter would return anything — MEASURED, on every request,
 * never assumed. restaurant_tables.section exists; on the measured database 0 of
 * 15 rows carry a value, so offering the dropdown would hand the Floor Manager a
 * control that silently empties the page. If the owner ever populates it, this
 * string starts saying so and the filter can be built on evidence.
 */
function sectionFilterNote(db: Database.Database): string {
  try {
    const r = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN COALESCE(section,'') <> '' THEN 1 ELSE 0 END) AS filled
           FROM restaurant_tables`,
      )
      .get() as any;
    const filled = Number(r?.filled) || 0;
    const total = Number(r?.total) || 0;
    return filled > 0
      ? `Sections are defined on ${filled} of ${total} tables.`
      : `No sections defined (0 of ${total} tables carry restaurant_tables.section), so no Section filter is offered. Floor is restaurant_tables.zone.`;
  } catch {
    return 'Section could not be read; no Section filter is offered.';
  }
}
