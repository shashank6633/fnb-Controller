/**
 * Guest Feedback — THE READ RAIL.  (P2 Lane A)
 *
 * 🔒 EVERY FUNCTION HERE IS A `SELECT`. There is not one INSERT / UPDATE /
 * DELETE in this file and there must never be one. The owner's constraint on a
 * GRE is read-only access to orders, and the cheapest way to keep a promise
 * like that is to make the module that serves the data structurally incapable
 * of breaking it: the whole Page-1 surface is this file plus two `GET` route
 * handlers, so there is no write path to audit.
 *
 * ── ⚠️ A RESOLUTION TRAP THAT NOW EXISTS IN THIS MODULE ─────────────────────
 * `src/lib/feedback.ts` (the shared vocabulary) and `src/lib/feedback/` (this
 * directory) BOTH exist. TS and Node try the FILE before the directory, so
 * `@/lib/feedback` is always `feedback.ts` and a `src/lib/feedback/index.ts`
 * would be silently unreachable — never create one. Deep paths
 * (`@/lib/feedback/access`, `@/lib/feedback/read`) are unambiguous, which is
 * why every import in this module uses one. The carve grep
 * (`src/lib/feedback`) matches both spellings, so the deploy gate is unharmed.
 *
 * ── THE MEASURED FACTS THIS FILE ENCODES ────────────────────────────────────
 * Re-measured on the worktree snapshot 2026-09-22, not inherited from prose:
 *
 *  1. TIMESTAMPS ARE UTC WITH A SPACE, AND THAT IS A BUG WAITING TO HAPPEN.
 *     `orders.created_at` defaults to `datetime('now')` → `2026-08-11 19:05:14`
 *     (UTC, no `T`, no `Z`). V8 parses that space form as LOCAL time:
 *         Date.parse('2026-08-11 19:05:14')  →  2026-08-11T13:35:14Z   (IST)
 *         Date.parse('2026-08-11T19:05:14Z') →  2026-08-11T19:05:14Z   ✔
 *     A table open 10 minutes would have rendered "5h 40m" on the card. Every
 *     timestamp leaving this file therefore goes through `sqlUtcToIso()`, the
 *     same repair `src/lib/bill-pdf.ts:32` and `src/lib/central-cutover.ts:164`
 *     already apply. The CLIENT must never see the raw column.
 *
 *  2. FLOOR IS `restaurant_tables.zone`. There is no `floor` column — selecting
 *     one errors. Measured: 3/3 tables have a zone, 2 distinct values
 *     (Ground Floor, Rooftop). `section` is 0/3 populated, so a `section`
 *     filter would ship dead and is deliberately not built.
 *     An EMPTY zone renders as the literal "Floor" in the Captain UI, and
 *     `captain-area.ts:30` buckets `'Floor'` with `''` — `floorLabel()` does the
 *     same so the two surfaces cannot disagree.
 *
 *  3. FOOD vs DRINKS IS `BAR_STATIONS`, NOT `station_departments`. Measured on
 *     this snapshot: `station_departments` maps `bar · cocktail · liquor ·
 *     mocktail` to the Bar department — but `menu_items.station` also holds
 *     `beer/wine/beverage/beverages` shapes in production, and the shipped
 *     KDS/printing authority is `BAR_STATIONS` in `src/lib/kot-section.ts`.
 *     That list is what `sectionMatchesStation()` uses to route tickets, so it
 *     is the one that already decides what a bartender sees.
 *     ⚠️ `BAR_STATIONS` is TOTAL AND SILENT: anything not in it — including a
 *     blank station — is Food, with no error. Measured: 3 of 35 `order_items`
 *     rows carry a blank station. So this file does NOT just classify; it also
 *     reports `unclassified`, per row and in aggregate, naming the raw station
 *     value and where it landed. A mis-filed drink is then visible on screen
 *     instead of quietly becoming a food complaint.
 *
 *  4. `COUNT(order_items)` IS THE LIVE TRUTH FOR "ITEMS ORDERED". Removing an
 *     item is a hard `DELETE` (`api/dine-in/orders/[id]/route.ts:164`), not a
 *     status flip, so there is no cancelled-row class to exclude. Measured
 *     `order_items.status` on this snapshot: only `pending` and `served`.
 *
 *  5. TAKEAWAY HAS NO TABLE TO WALK TO. Measured: 33 dine-in / 4 takeaway. And
 *     some open orders point at a `table_id` whose `restaurant_tables` row no
 *     longer exists (hard-deleted). Both are excluded — and COUNTED in `meta`,
 *     because an order that silently vanishes from a coverage board is exactly
 *     how coverage numbers start lying.
 *
 *  6. AN ORDER NOBODY EVER SETTLES NEVER LEAVES. P2 gave the board an exit for
 *     a SETTLED table (the grace window) and for a VOIDED one (the WHERE
 *     clause), and none at all for the commonest case of the three: an `open`
 *     order a captain simply forgot. `stale-tables.ts` measured eleven of them
 *     on the live database — one idle 765 hours, 32 days — and nothing in this
 *     app has ever closed one. Without an exit, each of those sits on the GRE's
 *     board forever, and a queue that never empties is a queue nobody trusts.
 *     §6 below is that exit. It is a FILTER, never a write: the module stays
 *     SELECT-only, the order keeps its status, and the drop is counted in
 *     `meta.excluded` like every other exclusion here.
 */

import type Database from 'better-sqlite3';
import { BAR_STATIONS } from '@/lib/kot-section';
// The business-day rule is the HRMS engine's — see §6. Server-only, which this
// file already is (its two callers are route handlers; `page.tsx` takes its
// types with `import type`, which is erased).
import { businessDateOf, getHrDayCutoff } from '@/lib/hr-attendance';
import {
  FEEDBACK_ITEM_THRESHOLD_DEFAULT,
  FEEDBACK_ITEM_THRESHOLD_KEY,
  FEEDBACK_SETTLED_GRACE_DEFAULT,
  FEEDBACK_SETTLED_GRACE_KEY,
  tableStatus,
  tunable,
  type ItemGroup,
  type TableStatus,
} from '@/lib/feedback';

/* ════════════════════════════════════════════════════════════════════════════
   1. TIME — the repair described in fact (1) above
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * SQLite `datetime('now')` output → real ISO-8601 UTC.
 *
 * `'2026-08-11 19:05:14'` → `'2026-08-11T19:05:14Z'`. A value that already
 * carries a `T` or a zone designator is passed through untouched (some columns
 * in this database were written by `new Date().toISOString()`), and a blank /
 * null / unparseable value returns `null` rather than an Invalid Date the UI
 * would have to guess about.
 */
export function sqlUtcToIso(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) return s.includes('T') ? s : s.replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) return `${s.replace(' ', 'T')}Z`;
  // Anything else (a date with no time, a free-text stamp): hand it back as-is
  // rather than inventing a timezone for it.
  return s;
}

/* ════════════════════════════════════════════════════════════════════════════
   2. TUNABLES — read from `settings`, CODE-defaulted
   ════════════════════════════════════════════════════════════════════════════ */

export interface FeedbackTunables {
  /** §7 Q2 — "4-5 items". Admin setting `feedback_item_threshold`, default 4.
   *  Never below 1 — see `MIN_ITEM_THRESHOLD`. */
  itemThreshold: number;
  /** §7 Q4 — minutes after `settled_at` during which a table still accepts a visit. */
  graceMinutes: number;
  /** True when the key is actually present, so the UI can say "default" honestly. */
  itemThresholdIsSet: boolean;
  graceIsSet: boolean;
  /** The stored threshold was below 1 and has been raised to `MIN_ITEM_THRESHOLD`.
   *  Reported so a fat-fingered `0` is visible on screen instead of silently
   *  re-creating the bug P2 fixed. */
  itemThresholdClamped: boolean;
}

/**
 * THE FLOOR UNDER `feedback_item_threshold`, and it is not pedantry.
 *
 * `tunable()` accepts any value ≥ 0, so an admin typing `0` into
 * `PUT /api/settings` reproduces EXACTLY the defect P2 measured and fixed: with
 * the threshold at 0, `item_count >= 0` is true for every row, so a table with
 * nothing on it at all becomes "Feedback Due" and `Not Ready` becomes
 * unreachable. The difference is only in how it got there — a blank key then, a
 * typed zero now — and the board is just as wrong either way.
 *
 * "At least one item was ordered" is the weakest trigger that still means
 * anything; below it the word "eligible" stops carrying information. So 0 is
 * raised to 1 and `meta.item_threshold_clamped` says so, rather than being
 * accepted silently or rejected with an error the admin never sees.
 */
export const MIN_ITEM_THRESHOLD = 1;

/**
 * Both keys are CODE-defaulted on purpose — `captain_area_lock` is the
 * cautionary tale in BUILD-STATE §4: a gate written against a key nothing ever
 * seeded was dead from the day it shipped. An ABSENT key here means the
 * documented default, never "off".
 *
 * There is no write path for these in this module. `PUT /api/settings` already
 * accepts an arbitrary key behind an admin-or-manager floor
 * (`api/settings/route.ts:264`) and neither key is in that route's `KEY_POLICY`,
 * so an admin can tune the threshold today with no deploy and this lane does not
 * need — and must not have — a mutating endpoint to offer it.
 */
export function readTunables(db: Database.Database): FeedbackTunables {
  const get = (key: string): unknown => {
    try {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any;
      return row?.value;
    } catch {
      return undefined;              // fail to the documented default, never throw
    }
  };
  const rawThreshold = get(FEEDBACK_ITEM_THRESHOLD_KEY);
  const rawGrace = get(FEEDBACK_SETTLED_GRACE_KEY);
  const parsedThreshold = tunable(rawThreshold, FEEDBACK_ITEM_THRESHOLD_DEFAULT);
  return {
    itemThreshold: Math.max(MIN_ITEM_THRESHOLD, parsedThreshold),
    graceMinutes: tunable(rawGrace, FEEDBACK_SETTLED_GRACE_DEFAULT),
    itemThresholdIsSet: usable(rawThreshold),
    graceIsSet: usable(rawGrace),
    itemThresholdClamped: parsedThreshold < MIN_ITEM_THRESHOLD,
  };
}

/**
 * Did the stored value actually DECIDE anything?
 *
 * "Is the key present" is the wrong question, and answering it was a small lie
 * on screen: store `feedback_item_threshold = 'abc'` and `tunable()` correctly
 * falls back to 4, but a present-key test then dropped the "(default)" marker
 * from the footer — so the board read "becomes Feedback Due at 4 items" with
 * nothing to suggest the value the admin typed had been discarded. A key whose
 * value cannot be used is, for the reader, exactly the same situation as no key
 * at all, and the screen should say so. (`tunable()` accepts 0, so the zero the
 * `MIN_ITEM_THRESHOLD` clamp then raises is still reported as SET — it was a
 * real instruction, just an unusable one, and `item_threshold_clamped` is the
 * field that says what happened to it.)
 */
function usable(raw: unknown): boolean {
  const s = String(raw ?? '').trim();
  if (s === '') return false;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0;
}

/* ════════════════════════════════════════════════════════════════════════════
   2b. THE BUSINESS DAY — the exit an order that is never settled needs
   ════════════════════════════════════════════════════════════════════════════

   THE PROBLEM, restated so the rule below is judged against it. `orders.status`
   leaves the board three ways: 'void' (excluded in the WHERE), 'settled' (kept
   only inside `graceMinutes`), and… nothing. An order that stays 'open' has no
   exit at all, and `stale-tables.ts` measured what that means in practice on
   the live database: eleven open orders, one of them idle 765 hours. Every one
   of those would sit on a GRE's floor board tonight, tomorrow and next month.

   WHY A BUSINESS DAY AND NOT AN IDLE TIMER. The board answers one question —
   "which tables should I walk to NOW" — and the honest boundary for that is the
   SERVICE, not an elapsed-hours number someone has to tune. The owner already
   has a convention for where one service ends and the next begins, and it is
   not midnight: `hr_day_cutoff`, default '04:00' (src/lib/hr-attendance.ts:60,
   src/lib/db.ts:7841). A 1 a.m. table belongs to the night before, which is
   exactly the answer a floor board wants. So:

       A STILL-OPEN ORDER LEAVES THE BOARD WHEN ITS LAST ACTIVITY FALLS BEFORE
       THE START OF THE CURRENT BUSINESS DAY.

   Four things that rule deliberately does NOT do:

   · IT DOES NOT WRITE. No void, no settle, no status change, nothing. This
     module is SELECT-only and stays that way; `stale-tables.ts` owns closing
     orders and is explicit that a table WITH ITEMS must never be closed by a
     timer, because auto-settling invents revenue and auto-voiding writes off
     food that was eaten. Our rule touches neither — the order is exactly as
     stale after this filter as before it. It only stops being on a list of
     tables to walk to.

   · IT DOES NOT TOUCH SETTLED TABLES. Those already have their exit (the grace
     window), and applying a day boundary to them would break it: a table
     settled at 03:59 IST is in yesterday's business day, so at 04:05 it would
     vanish six minutes into a thirty-minute grace. The grace window wins for
     settled orders; this rule is for `open` ones, which is precisely the case
     that had no exit.

   · IT DOES NOT MEASURE FROM `created_at`. Idle is measured from the LAST
     ACTIVITY, the same definition `stale-tables.ts:110` uses — a table that
     punched an item ten minutes ago is not stale because it opened at seven.
     We widen that definition by the two bill stamps: asking for the bill is
     somebody at the table, so it counts as activity.

   · IT DOES NOT SILENTLY CLOSE A COMPLAINT. `gf_follow_ups.status` is untouched
     — an open follow-up stays open, on the Tracker and in the Analytics, for a
     manager to deal with. What ends is the pretence that a GRE can still walk
     over and ask. `meta.excluded.stale_with_open_issue` counts those separately
     so the drop is a number on screen, never a disappearance. */

/** The cutoff used when `hr_day_cutoff` is absent or outside the night window
 *  below. Same value HRMS defaults to. */
export const BOARD_CUTOFF_FALLBACK = '04:00';

/** A rollover may only be set in the small hours. See `feedbackBoardCutoff()`. */
const BOARD_CUTOFF_MAX_HOUR = 8;

export interface BoardDay {
  /** 'HH:MM' actually used. */
  cutoff: string;
  /** Where it came from — printed on screen, so the rule is never a mystery. */
  source: 'hr_day_cutoff' | 'default';
  /** The business date the board is showing, 'YYYY-MM-DD'. */
  businessDate: string;
}

/**
 * The cutoff this board rolls over on.
 *
 * It READS `hr_day_cutoff` — one venue, one idea of where the night ends, and
 * no new settings key for the owner to discover — but it does not accept it
 * blindly. HR owns that key for payroll reasons, and a value like '09:00' is
 * perfectly sensible for an attendance day while being catastrophic here: the
 * floor board would reset at 9 a.m. … and, worse, a value like '20:00' would
 * roll the board over in the middle of dinner service and blank it while the
 * GRE was standing on the floor. So only a NIGHT rollover (00:00–07:59) is
 * honoured; anything else falls back to 04:00 and `source` says 'default'.
 *
 * Never throws: an unreadable settings table degrades to the fallback, the same
 * direction `getStaleTableWindowHours()` degrades in.
 */
export function feedbackBoardCutoff(db: Database.Database, nowMs?: number): BoardDay {
  let cutoff = BOARD_CUTOFF_FALLBACK;
  let source: BoardDay['source'] = 'default';
  try {
    // `getHrDayCutoff()` already returns '04:00' for an absent or invalid key,
    // so its answer alone cannot tell "the owner set 04:00" from "nobody ever
    // set anything" — and `source` would then claim a provenance the settings
    // table does not have. (`hr_day_cutoff` is NOT seeded on the measured
    // database: `SELECT ... WHERE key='hr_day_cutoff'` returns no row.) So the
    // raw value is read too, and the key is only credited when it supplied it.
    const stored = String(
      (db.prepare('SELECT value FROM settings WHERE key = ?').get('hr_day_cutoff') as any)?.value ?? '',
    ).trim();
    const hr = getHrDayCutoff(db);                 // already validates 'HH:MM'
    const hour = parseInt(String(hr).slice(0, 2), 10);
    if (Number.isFinite(hour) && hour >= 0 && hour < BOARD_CUTOFF_MAX_HOUR) {
      cutoff = hr;
      if (stored !== '' && stored === hr) source = 'hr_day_cutoff';
    }
  } catch {
    /* fall back */
  }
  const businessDate = businessDateOfSafe(utcStamp(nowMs ?? Date.now()), cutoff) ?? '';
  return { cutoff, source, businessDate };
}

/** Epoch ms → the storage shape `businessDateOf()` parses ('YYYY-MM-DD HH:MM:SS' UTC). */
function utcStamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * `businessDateOf()` THROWS on an unparseable timestamp — correct for an
 * attendance punch, wrong for us: a row we cannot date must stay on the board,
 * not fall off it. Null here means "unknown", and every caller treats unknown
 * as KEEP.
 */
function businessDateOfSafe(atUtc: string, cutoff: string): string | null {
  try {
    const d = businessDateOf(atUtc, cutoff);
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
  } catch {
    return null;
  }
}

/**
 * Is this still-open order part of the CURRENT service?
 *
 * `lastActivityUtc` is the raw column value (UTC, space-separated). Unknown or
 * unparseable ⇒ true: a coverage board must over-show, never under-show.
 * `>=` rather than `===` so a clock-skewed future stamp is kept too.
 */
export function isCurrentBusinessDay(
  lastActivityUtc: unknown,
  day: BoardDay,
): boolean {
  if (!day.businessDate) return true;                  // could not date "now" → keep everything
  const s = String(lastActivityUtc ?? '').trim();
  if (!s) return true;
  const bd = businessDateOfSafe(s, day.cutoff);
  if (!bd) return true;
  return bd >= day.businessDate;
}

/* ════════════════════════════════════════════════════════════════════════════
   3. FOOD vs DRINKS — and the stations that fit neither
   ════════════════════════════════════════════════════════════════════════════ */

const BAR_SET: ReadonlySet<string> = new Set(BAR_STATIONS.map((s) => s.toLowerCase()));

/**
 * Every station the menu master actually uses, lower-cased, plus `BAR_STATIONS`
 * itself. This is ONLY used to decide whether a station is RECOGNISED — never
 * to decide the bucket. The bucket is always `BAR_STATIONS` (fact 3), so a
 * station that is recognised-but-not-a-bar-station is Food because the shipped
 * KDS authority says so, not because we guessed.
 *
 * Measured on the snapshot: 12 distinct `menu_items.station` values —
 * liquor · cocktail · continental · pan-asian · indian · tandoor · mocktail ·
 * sushi · pizza · bakery · terracegrill · bar.
 */
export function knownStations(db: Database.Database): ReadonlySet<string> {
  const set = new Set<string>(BAR_SET);
  try {
    const rows = db
      .prepare(`SELECT DISTINCT LOWER(TRIM(station)) AS st FROM menu_items WHERE TRIM(COALESCE(station,'')) <> ''`)
      .all() as any[];
    for (const r of rows) if (r?.st) set.add(String(r.st));
  } catch {
    /* menu master unreadable → everything off BAR_STATIONS is reported as
       unclassified, which over-reports rather than hiding anything. */
  }
  return set;
}

export interface StationVerdict {
  group: ItemGroup;
  /** False ⇒ the station is blank or not on the menu master. It STILL lands in
   *  `group` (Food), and the caller must surface that rather than drop it. */
  recognised: boolean;
  /** The raw value, lower-cased and trimmed; `''` for a blank station. */
  station: string;
}

/** The single classifier. `known` comes from `knownStations()`. */
export function classifyStation(raw: unknown, known: ReadonlySet<string>): StationVerdict {
  const station = String(raw ?? '').trim().toLowerCase();
  if (BAR_SET.has(station)) return { group: 'drinks', recognised: true, station };
  return { group: 'food', recognised: !!station && known.has(station), station };
}

/** The sentence the UI prints for an unrecognised station, so the reason travels
 *  with the number instead of living only in this file's comments. */
export const UNCLASSIFIED_REASON =
  'Station is blank or not on the menu master. The shipped KDS rule (BAR_STATIONS in '
  + 'src/lib/kot-section.ts) treats every non-bar station as Kitchen, so these items are '
  + 'counted under Food. Set the station on the menu item to file them correctly.';

/* ════════════════════════════════════════════════════════════════════════════
   4. FLOOR
   ════════════════════════════════════════════════════════════════════════════ */

/** `restaurant_tables.zone` → the label the Captain app already shows. An empty
 *  zone IS "Floor" there (CaptainShell.tsx:31 / captain-area.ts:30). */
export function floorLabel(zone: unknown): string {
  return String(zone ?? '').trim() || 'Floor';
}

/* ════════════════════════════════════════════════════════════════════════════
   5. THE FLOOR BOARD
   ════════════════════════════════════════════════════════════════════════════ */

export interface FloorRow {
  order_id: string;
  order_number: string;
  table_id: string;
  table_number: string;
  /** restaurant_tables.zone, with '' bucketed to 'Floor'. */
  floor: string;
  covers: number | null;
  server_name: string | null;
  /** COUNT(order_items) — the owner's "4-5 items ordered" trigger. */
  item_count: number;
  food_count: number;
  drinks_count: number;
  /** Items whose station is blank/unknown. They are INSIDE `food_count`. */
  unclassified_count: number;
  /** ISO-8601 UTC. orders.created_at, repaired. */
  opened_at: string | null;
  /** The newest of: last item punched · opened · bill requested · bill printed ·
   *  settled. The "is this table still live" clock (§6), ISO-8601 UTC. */
  last_activity_at: string | null;
  settled_at: string | null;
  bill_requested_at: string | null;
  bill_printed_at: string | null;
  order_status: string;
  /** True when the order is settled and inside the grace window. */
  in_grace: boolean;
  /** Why this table is eligible — shown on the card because the GRE is measured
   *  on coverage and deserves to see the trigger. */
  eligible: boolean;
  eligible_by: { items: boolean; bill_requested: boolean; bill_printed: boolean };
  status: TableStatus;
  /** gf_visits, once a visit exists. Null while the table is still due. */
  visit_id: string | null;
  gre_name: string | null;
  visited_at: string | null;
  has_negative: boolean;
  follow_ups_total: number;
  open_follow_ups: number;
}

export interface FloorMeta {
  generated_at: string;
  item_threshold: number;
  item_threshold_key: string;
  item_threshold_is_default: boolean;
  /** The stored value was below 1 and was raised — see `MIN_ITEM_THRESHOLD`. */
  item_threshold_clamped: boolean;
  grace_minutes: number;
  grace_is_default: boolean;
  /** §6 — the service this board is showing, and the rollover that bounds it. */
  business_date: string;
  board_cutoff: string;
  board_cutoff_source: BoardDay['source'];
  counts: Record<string, number>;
  floors: string[];
  /** Aggregate of every unrecognised station on the board, so a mis-stationed
   *  dish is a number on screen and not a silent reclassification. */
  unclassified: { station: string; items: number }[];
  unclassified_reason: string;
  /** Orders deliberately kept off the board, counted rather than dropped.
   *  `stale_open_order` is §6's exit: a still-`open` order whose last activity
   *  predates the current business day. `stale_with_open_issue` is the subset of
   *  those that still carry an unresolved complaint — named separately because
   *  an open complaint leaving a board without a number beside it is the one
   *  disappearance nobody would forgive. */
  excluded: {
    takeaway_or_other: number;
    table_row_missing: number;
    stale_open_order: number;
    stale_with_open_issue: number;
  };
}

/** Sort weight. Lower sorts first. Two of the five statuses are a call to
 *  action and they lead: an OPEN COMPLAINT outranks an unvisited table because
 *  the guest is already unhappy and waiting on the remake. */
const STATUS_PRIORITY: Record<TableStatus, number> = {
  follow_up: 0,
  due: 1,
  issue: 2,
  taken: 3,
  not_ready: 4,
};

/**
 * The board. ONE `SELECT` over `orders` + `restaurant_tables` + `gf_visits`,
 * and ONE aggregate over `order_items`.
 *
 * WHICH ORDERS APPEAR
 *   · `order_type = 'dine-in'` — a takeaway has no table to visit.
 *   · not voided (`status <> 'void'` AND `voided_at IS NULL` — both, because a
 *     void that only set one of them must not leak onto a GRE's board).
 *   · `status = 'open'`, OR `settled` within `graceMinutes` of `settled_at`.
 *     §7 Q4: a table settled before the GRE arrives is the commonest way
 *     coverage is lost, so a short grace keeps it visitable. `graceMinutes = 0`
 *     disables the grace entirely and the board shows open tables only.
 *   · the table row must still exist — counted in `meta.excluded` when it does not.
 *
 * ORDERING — the lane's requirement is that a GRE sees instantly which tables
 * still need visiting, so the board is NOT chronological. Action-needed first
 * (`follow_up`, then `due`), and inside a group the tables whose guests are
 * ABOUT TO LEAVE (bill requested or printed) come before the rest, then oldest
 * open first. A table that has asked for its bill is minutes from walking out;
 * one that has merely been open a long time is not.
 */
export function listFloorTables(
  db: Database.Database,
  opts: { outletId: string | null },
): { rows: FloorRow[]; meta: FloorMeta } {
  const t = readTunables(db);
  const day = feedbackBoardCutoff(db);
  const outletId = opts.outletId ?? '';

  const raw = db
    .prepare(
      `SELECT o.id                AS order_id,
              o.order_number      AS order_number,
              o.order_type        AS order_type,
              o.table_id          AS order_table_id,
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
              v.gre_name          AS gre_name,
              v.created_at        AS visited_at,
              v.has_negative      AS has_negative,
              v.follow_ups_total  AS follow_ups_total,
              v.open_follow_ups   AS open_follow_ups,
              -- §6. The newest stamp that means "somebody was at this table".
              -- MAX() is the SCALAR form and returns NULL if ANY argument is
              -- NULL, so every one is COALESCEd to '' first — '' sorts below
              -- every real 'YYYY-...' value, which is exactly what we want.
              -- NOTE this is a STRING max, sound only because all five columns
              -- are written in one shape. Measured on this database: 100% of
              -- orders.created_at / settled_at / bill_requested_at /
              -- bill_printed_at and order_items.created_at are the SQLite
              -- datetime-now form YYYY-MM-DD HH:MM:SS -- zero ISO T values and
              -- zero fractional seconds. Were one column ever written with a
              -- T separator, T (0x54) sorts above space (0x20) and that column
              -- would always win. Re-measure before adding a sixth.
              MAX(COALESCE((SELECT MAX(oi_a.created_at) FROM order_items oi_a
                             WHERE oi_a.order_id = o.id), ''),
                  COALESCE(o.created_at, ''),
                  COALESCE(o.bill_requested_at, ''),
                  COALESCE(o.bill_printed_at, ''),
                  COALESCE(o.settled_at, ''))        AS last_activity_at
         FROM orders o
         LEFT JOIN restaurant_tables t ON t.id = o.table_id
         LEFT JOIN gf_visits         v ON v.order_id = o.id
        WHERE o.voided_at IS NULL
          AND o.status <> 'void'
          AND (o.outlet_id = ? OR o.outlet_id IS NULL OR o.outlet_id = '')
          AND (
                o.status = 'open'
                OR (o.status = 'settled'
                    AND ? > 0
                    AND o.settled_at IS NOT NULL
                    AND (julianday('now') - julianday(o.settled_at)) * 1440.0 <= ?)
              )`,
    )
    .all(outletId, t.graceMinutes, t.graceMinutes) as any[];

  const excluded = {
    takeaway_or_other: 0,
    table_row_missing: 0,
    stale_open_order: 0,
    stale_with_open_issue: 0,
  };
  const kept: any[] = [];
  for (const r of raw) {
    if (String(r.order_type ?? '') !== 'dine-in') { excluded.takeaway_or_other++; continue; }
    if (!r.t_id) { excluded.table_row_missing++; continue; }
    // §6 — the exit for an order nobody ever settled. `open` ONLY: a settled
    // order is already bounded by the grace window, and applying a day boundary
    // to it would cut that window short for anything settled just before 04:00.
    if (String(r.order_status ?? '') === 'open'
        && !isCurrentBusinessDay(r.last_activity_at, day)) {
      excluded.stale_open_order++;
      if ((Number(r.open_follow_ups) || 0) > 0) excluded.stale_with_open_issue++;
      continue;
    }
    kept.push(r);
  }

  const byOrder = itemCountsByOrder(db, kept.map((r) => String(r.order_id)));

  const rows: FloorRow[] = kept.map((r) => {
    const agg = byOrder.get(String(r.order_id)) ?? emptyAgg();
    const billRequested = !!sqlUtcToIso(r.bill_requested_at);
    const billPrinted = !!sqlUtcToIso(r.bill_printed_at);
    const byItems = agg.total >= t.itemThreshold;
    const eligible = byItems || billRequested || billPrinted;

    const openFollowUps = Number(r.open_follow_ups) || 0;
    const hasNegative = !!Number(r.has_negative);
    const status = tableStatus({
      hasVisit: !!r.visit_id,
      eligible,
      openFollowUps,
      hasNegative,
    });

    return {
      order_id: String(r.order_id),
      order_number: String(r.order_number ?? ''),
      table_id: String(r.t_id),
      table_number: String(r.table_number ?? ''),
      floor: floorLabel(r.zone),
      covers: r.covers == null ? null : Number(r.covers),
      server_name: r.server_name ? String(r.server_name) : null,
      item_count: agg.total,
      food_count: agg.food,
      drinks_count: agg.drinks,
      unclassified_count: agg.unclassified,
      opened_at: sqlUtcToIso(r.opened_at),
      last_activity_at: sqlUtcToIso(r.last_activity_at),
      settled_at: sqlUtcToIso(r.settled_at),
      bill_requested_at: sqlUtcToIso(r.bill_requested_at),
      bill_printed_at: sqlUtcToIso(r.bill_printed_at),
      order_status: String(r.order_status ?? ''),
      in_grace: String(r.order_status ?? '') === 'settled',
      eligible,
      eligible_by: { items: byItems, bill_requested: billRequested, bill_printed: billPrinted },
      status,
      visit_id: r.visit_id ? String(r.visit_id) : null,
      gre_name: r.gre_name ? String(r.gre_name) : null,
      visited_at: sqlUtcToIso(r.visited_at),
      has_negative: hasNegative,
      follow_ups_total: Number(r.follow_ups_total) || 0,
      open_follow_ups: openFollowUps,
    };
  });

  const leavingSoon = (x: FloorRow) => (x.bill_requested_at || x.bill_printed_at ? 0 : 1);
  rows.sort((a, b) =>
    STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status]
    || leavingSoon(a) - leavingSoon(b)
    || String(a.opened_at ?? '').localeCompare(String(b.opened_at ?? ''))
    || a.table_number.localeCompare(b.table_number, undefined, { numeric: true }));

  const counts: Record<string, number> = { all: rows.length };
  for (const k of Object.keys(STATUS_PRIORITY)) counts[k] = 0;
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;

  const unclassified = new Map<string, number>();
  for (const id of kept.map((r) => String(r.order_id))) {
    const agg = byOrder.get(id);
    if (!agg) continue;
    for (const [station, n] of agg.unknownStations) {
      unclassified.set(station, (unclassified.get(station) || 0) + n);
    }
  }

  return {
    rows,
    meta: {
      generated_at: new Date().toISOString(),
      item_threshold: t.itemThreshold,
      item_threshold_key: FEEDBACK_ITEM_THRESHOLD_KEY,
      item_threshold_is_default: !t.itemThresholdIsSet,
      item_threshold_clamped: t.itemThresholdClamped,
      grace_minutes: t.graceMinutes,
      grace_is_default: !t.graceIsSet,
      business_date: day.businessDate,
      board_cutoff: day.cutoff,
      board_cutoff_source: day.source,
      counts,
      floors: Array.from(new Set(rows.map((r) => r.floor))).sort((a, b) => a.localeCompare(b)),
      unclassified: Array.from(unclassified.entries())
        .map(([station, items]) => ({ station: station || '(blank)', items }))
        .sort((a, b) => b.items - a.items),
      unclassified_reason: UNCLASSIFIED_REASON,
      excluded,
    },
  };
}

/* ── the per-order item aggregate ─────────────────────────────────────────── */

interface ItemAgg {
  total: number;
  food: number;
  drinks: number;
  unclassified: number;
  /** raw station (lower-cased, '' for blank) → count, unrecognised ones only. */
  unknownStations: Map<string, number>;
}

const emptyAgg = (): ItemAgg => ({
  total: 0, food: 0, drinks: 0, unclassified: 0, unknownStations: new Map(),
});

/**
 * One grouped read for the whole board. Chunked at 400 ids: SQLite's default
 * `SQLITE_MAX_VARIABLE_NUMBER` is 999 on older builds and a busy Friday can
 * legitimately have more open tables than that.
 */
function itemCountsByOrder(db: Database.Database, orderIds: string[]): Map<string, ItemAgg> {
  const out = new Map<string, ItemAgg>();
  if (orderIds.length === 0) return out;
  const known = knownStations(db);

  for (let i = 0; i < orderIds.length; i += 400) {
    const chunk = orderIds.slice(i, i + 400);
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
      const agg = out.get(id) ?? emptyAgg();
      const verdict = classifyStation(r.st, known);
      agg.total += n;
      if (verdict.group === 'drinks') agg.drinks += n;
      else agg.food += n;
      if (!verdict.recognised) {
        agg.unclassified += n;
        agg.unknownStations.set(verdict.station, (agg.unknownStations.get(verdict.station) || 0) + n);
      }
      out.set(id, agg);
    }
  }
  return out;
}

/* ════════════════════════════════════════════════════════════════════════════
   6. THE ORDERED-ITEMS READ  (one order)
   ════════════════════════════════════════════════════════════════════════════
   This is the module's OWN narrow read and it exists precisely so the module
   never has to call a POS route to see what a table ordered. The POS route that
   returns an order (`PATCH/GET /api/dine-in/orders/[id]`) is the same handler
   that yields add_item · set_qty · remove_item · fire, and re-exporting or
   proxying it would put a write-capable surface one typo away from the GRE.

   It returns NO MONEY — no unit_price, no line_total, no discount, no bill. The
   GRE is recording how the food was, not auditing the cheque, and a read that
   cannot see a price cannot leak one. */

export interface FeedbackOrderItem {
  id: string;
  name: string;
  quantity: number;
  station: string;
  group: ItemGroup;
  /** False ⇒ blank/unknown station; the item is counted under Food. */
  station_recognised: boolean;
  /** Kitchen progress, useful context when a guest says "it never came". */
  kitchen_status: string;
  fired_at: string | null;
  served_at: string | null;
  created_at: string | null;
}

export interface FeedbackOrderView {
  order_id: string;
  order_number: string;
  table_id: string;
  table_number: string;
  floor: string;
  covers: number | null;
  server_name: string | null;
  opened_at: string | null;
  order_status: string;
  bill_requested_at: string | null;
  bill_printed_at: string | null;
  item_count: number;
  food: FeedbackOrderItem[];
  drinks: FeedbackOrderItem[];
  unclassified_count: number;
  unclassified_reason: string;
}

/** Null when the order does not exist, is voided, or belongs to another outlet. */
export function readOrderForFeedback(
  db: Database.Database,
  orderId: string,
  outletId: string | null,
): FeedbackOrderView | null {
  const o = db
    .prepare(
      `SELECT o.id, o.order_number, o.table_id, o.status, o.covers, o.server_name,
              o.created_at, o.bill_requested_at, o.bill_printed_at,
              t.table_number AS table_number, t.zone AS zone
         FROM orders o
         LEFT JOIN restaurant_tables t ON t.id = o.table_id
        WHERE o.id = ?
          AND o.voided_at IS NULL
          AND o.status <> 'void'
          AND (o.outlet_id = ? OR o.outlet_id IS NULL OR o.outlet_id = '')`,
    )
    .get(orderId, outletId ?? '') as any;
  if (!o) return null;

  const known = knownStations(db);
  const items = db
    .prepare(
      `SELECT id, name, station, quantity, status, fired_at, served_at, created_at
         FROM order_items
        WHERE order_id = ?
        ORDER BY created_at, name`,
    )
    .all(orderId) as any[];

  const food: FeedbackOrderItem[] = [];
  const drinks: FeedbackOrderItem[] = [];
  let unclassified = 0;

  for (const it of items) {
    const verdict = classifyStation(it.station, known);
    if (!verdict.recognised) unclassified++;
    const row: FeedbackOrderItem = {
      id: String(it.id),
      name: String(it.name ?? ''),
      quantity: Number(it.quantity) || 0,
      station: verdict.station,
      group: verdict.group,
      station_recognised: verdict.recognised,
      kitchen_status: String(it.status ?? ''),
      fired_at: sqlUtcToIso(it.fired_at),
      served_at: sqlUtcToIso(it.served_at),
      created_at: sqlUtcToIso(it.created_at),
    };
    (verdict.group === 'drinks' ? drinks : food).push(row);
  }

  return {
    order_id: String(o.id),
    order_number: String(o.order_number ?? ''),
    table_id: String(o.table_id ?? ''),
    table_number: String(o.table_number ?? ''),
    floor: floorLabel(o.zone),
    covers: o.covers == null ? null : Number(o.covers),
    server_name: o.server_name ? String(o.server_name) : null,
    opened_at: sqlUtcToIso(o.created_at),
    order_status: String(o.status ?? ''),
    bill_requested_at: sqlUtcToIso(o.bill_requested_at),
    bill_printed_at: sqlUtcToIso(o.bill_printed_at),
    item_count: items.length,
    food,
    drinks,
    unclassified_count: unclassified,
    unclassified_reason: UNCLASSIFIED_REASON,
  };
}
