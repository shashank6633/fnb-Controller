/**
 * Guest Feedback — THE WRITER.  (P3 Lane A)
 *
 * THE ONLY PLACE IN THE REPOSITORY THAT WRITES `gf_visits`, `gf_item_feedback`
 * OR `gf_follow_ups`. Before this file existed the module had a complete read
 * side and no write side at all: `readOrderForFeedback()`, the floor board, the
 * tracker, 3,147 lines of reporting and 526 assertions — and `grep -rn "INSERT
 * INTO gf_" src/` returned NOTHING. The module could display, report and analyse
 * feedback and could not CAPTURE any. That is the defect the owner hit:
 * `/feedback/take/[orderId]` rendered `src/app/feedback/placeholder.ts`, so
 * table FA3's two real dishes (Idli, Masala Dosa) were replaced on screen by
 * invented ones, and Submit did nothing.
 *
 * ── WHAT THIS FILE IS ALLOWED TO TOUCH ──────────────────────────────────────
 * 🔒 `gf_visits`, `gf_item_feedback`, `gf_follow_ups`. NOTHING ELSE. It reads
 * `orders`, `order_items`, `restaurant_tables` and `menu_items` (through
 * `knownStations()`) and it writes none of them. The owner's list is explicit:
 * the GRE "cannot place orders · cancel items · change quantity · modify KOT ·
 * modify bill · apply discounts", and "Item Cancelled" / "Fresh Item Replaced"
 * on Page 2 are RECORDS OF WHAT THE KITCHEN DID, not commands. So an action of
 * `cancelled` writes one `gf_item_feedback` row and does not go near
 * `order_items.status`; a `replaced_other` does not add a line to the order.
 * There is no money on this surface either — no unit price, no line total, no
 * bill value is read, stored or returned.
 *
 * ── WHY A FUNCTION AND NOT A ROUTE ──────────────────────────────────────────
 * Same reason `read.ts` takes an explicit `db`: the route owns the session and
 * the HTTP shape, this owns the transaction and the rules, and the test suite
 * can drive the rules against a snapshot without a server. `import type
 * Database` only — this file pulls in no `@/lib/db`, so it stays a leaf.
 *
 * ── ONE TRANSACTION PER SUBMIT ──────────────────────────────────────────────
 * better-sqlite3 is SYNCHRONOUS, so `db.transaction()` is the whole story: no
 * awaits inside, nothing can interleave, and a throw anywhere rolls back the
 * visit, its item rows and its follow-ups together. A visit row whose item rows
 * failed would be worse than no visit at all — the table would read "Feedback
 * Taken" with the complaint missing.
 *
 * ── THE FOUR RULES THE BRIEF NAMES, AND WHERE THEY LIVE ─────────────────────
 *  1. ONE `gf_visits` ROW PER ORDER VISITED. Enforced by the database
 *     (`uq_gf_visits_order`) as well as by the pre-check below, because a
 *     tablet double-tap is two requests and a check without a constraint is a
 *     race. §3's cycle makes a REVISIT write `gf_follow_ups`, never a second
 *     visit, so coverage (Feedback Taken ÷ Eligible Tables) stays a straight
 *     COUNT and cannot be inflated by visiting the same table twice.
 *  2. SILENCE IS NOT A NEGATIVE RATING. The screen says "tap an item only if
 *     there is a problem", so an item the GRE never tapped gets NO ROW — not a
 *     row with `rating: ''`, which would land in Page 4's "Feedbacks" count and
 *     make every clean plate look measured. `recordable()` below is the gate,
 *     and an entry that carries nothing but `action: 'none'` is dropped by it:
 *     "No Action Required" with no rating, no issue and no comment says nothing
 *     about the dish.
 *  3. REMADE / REPLACED ⇒ FOLLOW-UP REQUIRED, AND IT STAYS OPEN. The rule is
 *     `requiresFollowUp()` in `src/lib/feedback.ts` — not re-spelled here, so
 *     Pages 1, 3 and 4 and this writer cannot disagree. A follow-up is born
 *     `status: 'open'`; only `closesIssue(happiness)` — an outright "Yes -
 *     Happy" — closes it; "Partially Happy" and "No - Still Unhappy" stay OPEN
 *     and stamp `escalated_at`, which is the owner's "stays open for Manager
 *     attention".
 *  4. AN ITEM MUST BE ON THAT ORDER. Every `order_item_id` in the body is
 *     matched against a SELECT over `order_items` for THIS order, and an
 *     unknown one refuses the whole submit before the transaction opens. A
 *     client must not be able to attach a complaint to a dish nobody ordered —
 *     which is exactly what the placeholder was doing to the screen.
 *
 * ── FOOD vs DRINKS IS DECIDED HERE, SERVER-SIDE ─────────────────────────────
 * `item_group` comes from `classifyStation(order_items.station, knownStations)`
 * — the module's own classifier over `BAR_STATIONS`, the same authority the KDS
 * uses — and NEVER from the request body or from an item's name. The raw
 * station is stored beside the verdict so Page 4 can count how often a drink
 * was mis-filed as Food instead of letting it vanish.
 *
 * ── THE CACHED COUNTERS ARE WRITTEN TO AGREE WITH THEIR CONSUMER ────────────
 * `gf_visits.has_negative` / `follow_ups_total` / `open_follow_ups` are
 * documented CACHES, and `src/app/api/feedback/tracker/query.ts:603-607`
 * RECOUNTS them from the rows and reports every disagreement as
 * `meta.cache_mismatch`. So they are computed here from the rows actually
 * inserted, with `has_negative` meaning exactly what the tracker recounts:
 * at least one `gf_item_feedback` row with `is_negative = 1`. Not "the overall
 * rating was poor" — that would make the tracker report a defect on every
 * honest visit.
 *
 * ⚠️ ONE CONSEQUENCE, SAID OUT LOUD RATHER THAN LEFT TO BE FOUND. A guest who
 * grumbles about the SERVICE — overall Poor, no dish tapped — produces a visit
 * with `has_negative = 0`, so Page 1 shows that table as "Feedback Taken" and
 * not "Issue Raised". The rating itself is NOT lost: `overall_rating` is 'poor'
 * and Page 4's rating split counts it. Widening `has_negative` to include a poor
 * OVERALL rating would make `meta.cache_mismatch` non-zero on every such visit,
 * which is a worse failure — the tracker would start reporting a defect it had
 * been given. If the owner wants that table to read "Issue Raised", the change
 * belongs in `tableStatus()` and in the tracker's recount TOGETHER, not here
 * alone. `scripts/feedback-capture-tests.js` gate N asserts the behaviour as it
 * stands so the decision is visible rather than inherited.
 */

import type Database from 'better-sqlite3';
import {
  ACTIONS_TAKEN, CATEGORIES, HAPPINESS, ITEM_ISSUES, ITEM_RATINGS, OVERALL_RATINGS,
  REVISIT_RATINGS, closesIssue, isNegative, requiresFollowUp,
  type ActionTaken, type Category, type Happiness, type ItemGroup, type ItemIssue,
  type ItemRating, type OverallRating, type RevisitRating,
} from '@/lib/feedback';
import { classifyStation, floorLabel, knownStations } from './read';

/* ════════════════════════════════════════════════════════════════════════════
   1. THE WIRE SHAPES
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * Who is recording. Built by the route from the SESSION and nothing else — the
 * DDL says so in as many words ("Recorded from the SESSION, never from the
 * request body"), because a body-supplied recorder would let one GRE's tablet
 * post coverage under another's name, and Page 4 ranks named staff.
 */
export interface FeedbackRecorder {
  user_id: string;
  email: string;
  name: string;
  /** `role_name` at visit time, falling back to the tier when no role is named. */
  role: string;
}

/** One ordered line the GRE tapped. Every field optional — that is the point of
 *  the screen; see `recordable()`. */
export interface SubmitItemInput {
  order_item_id: string;
  rating?: string;
  issue?: string;
  comment?: string;
  action?: string;
  /** §7 Q3 — WHICH item was given instead, for `replaced_other`. Recorded, not
   *  ordered: nothing here adds a line to the order. */
  replacement_menu_item_id?: string;
  replacement_item_name?: string;
  /** The revisit, if it happened in the same sitting. Only meaningful for an
   *  action that raises a follow-up. */
  revisit?: {
    rating?: string;
    happiness?: string;
    comment?: string;
  };
}

export interface SubmitFeedbackInput {
  order_id: string;
  /** The 10-second path. Coerced to 0 if any negative item row is recorded —
   *  see `everythingGoodStored` below. */
  everything_good?: boolean;
  overall_rating?: string;
  categories?: Partial<Record<Category, string>>;
  comment?: string;
  items?: SubmitItemInput[];
}

/** Why a submit was refused. One machine-readable token per cause, so the
 *  screen can react and the log can be grepped. */
export type FeedbackWriteRefusal =
  | 'order_id_required'
  | 'order_not_found'
  | 'not_a_table_visit'
  | 'bad_value'
  | 'item_not_on_order'
  | 'duplicate_item'
  | 'nothing_to_record'
  | 'already_taken'
  | 'write_failed';

export interface SubmitFeedbackOk {
  ok: true;
  visit_id: string;
  order_id: string;
  /** True when this request found the GRE's OWN earlier visit and wrote nothing
   *  — a double-tap on a tablet. The counts below are the EXISTING row's. */
  duplicate: boolean;
  status: 'taken' | 'issue' | 'follow_up';
  has_negative: boolean;
  items_recorded: number;
  /** Entries that carried no rating, no issue, no comment and no action other
   *  than "No Action Required". Reported rather than silently dropped. */
  items_ignored_empty: number;
  follow_ups_created: number;
  follow_ups_open: number;
  follow_ups_closed: number;
  /** True when "Everything Good" was asserted alongside a negative item and was
   *  therefore stored as 0. The screen should not be able to produce this; if it
   *  ever does, the data stays honest and the caller is told. */
  everything_good_overridden: boolean;
}

export interface SubmitFeedbackErr {
  ok: false;
  /** The HTTP status the route should answer with. */
  status: 400 | 404 | 409 | 500;
  reason: FeedbackWriteRefusal;
  error: string;
  /** Present on `already_taken`: who holds the one row this order is allowed. */
  taken_by?: string;
  taken_at?: string;
  /** Present on `item_not_on_order` / `duplicate_item`: the offending ids. */
  offending_item_ids?: string[];
}

export type SubmitFeedbackResult = SubmitFeedbackOk | SubmitFeedbackErr;

/* ════════════════════════════════════════════════════════════════════════════
   2. VALIDATION HELPERS
   ════════════════════════════════════════════════════════════════════════════ */

const MAX_COMMENT = 2000;

const str = (v: unknown): string => String(v ?? '').trim();
const clip = (v: unknown): string => str(v).slice(0, MAX_COMMENT);

const OVERALL_SET = new Set<string>(OVERALL_RATINGS.map((r) => r.v));
const ITEM_RATING_SET = new Set<string>(ITEM_RATINGS.map((r) => r.v));
const ISSUE_SET = new Set<string>(ITEM_ISSUES.map((r) => r.v));
const ACTION_SET = new Set<string>(ACTIONS_TAKEN.map((r) => r.v));
const REVISIT_SET = new Set<string>(REVISIT_RATINGS.map((r) => r.v));
const HAPPINESS_SET = new Set<string>(HAPPINESS.map((r) => r.v));

/**
 * An unknown enum value is a REFUSAL, never a silent `''`. Coercing it would
 * make a complaint disappear into a column that reads "no opinion recorded",
 * and Page 4 would print a smaller negative count than the night actually had.
 */
function enumOrFail(
  value: unknown,
  allowed: ReadonlySet<string>,
  field: string,
  bag: string[],
): string {
  const s = str(value);
  if (s === '') return '';
  if (allowed.has(s)) return s;
  bag.push(`${field}: ${JSON.stringify(s)} is not one of ${[...allowed].join(' · ')}`);
  return '';
}

/**
 * Does this entry say anything about the dish? THE SILENCE RULE, in one place.
 *
 * `action: 'none'` alone does NOT count: "No Action Required" with no rating, no
 * issue and no comment is a mis-tap on a sheet the GRE opened and closed, and
 * storing it would put an unrated plate into Page 4's "Feedbacks" denominator.
 */
function recordable(it: NormalItem): boolean {
  return !!it.rating || !!it.issue || !!it.comment || (!!it.action && it.action !== 'none');
}

interface NormalItem {
  order_item_id: string;
  rating: ItemRating | '';
  issue: ItemIssue | '';
  comment: string;
  action: ActionTaken;
  replacement_menu_item_id: string;
  replacement_item_name: string;
  revisit_rating: RevisitRating | '';
  happiness: Happiness | '';
  revisit_comment: string;
}

/** One ordered line, as the writer needs it. `menu_item_id` is why this file
 *  reads `order_items` itself rather than leaning on `readOrderForFeedback()`,
 *  whose projection deliberately omits it. */
interface OrderLine {
  id: string;
  menu_item_id: string;
  name: string;
  station: string;
  group: ItemGroup;
  quantity: number;
}

const fail = (
  status: SubmitFeedbackErr['status'],
  reason: FeedbackWriteRefusal,
  error: string,
  extra?: Partial<SubmitFeedbackErr>,
): SubmitFeedbackErr => ({ ok: false, status, reason, error, ...extra });

/* ════════════════════════════════════════════════════════════════════════════
   3. THE SUBMIT
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * Record one GRE visit to one table. Returns a RESULT OBJECT, never a Response
 * and never a throw for an expected refusal — the route maps `status` onto HTTP.
 *
 * @param db        an open better-sqlite3 handle (the caller's, so a test can
 *                  hand in a snapshot)
 * @param input     the body, untrusted
 * @param recorder  from the session, trusted
 * @param outletId  the caller's outlet, for the snapshot column and the scope
 *                  of the order lookup
 */
export function submitFeedback(
  db: Database.Database,
  input: SubmitFeedbackInput,
  recorder: FeedbackRecorder,
  outletId: string | null,
): SubmitFeedbackResult {
  const orderId = str(input?.order_id);
  if (!orderId) return fail(400, 'order_id_required', 'order_id is required.');

  /* ── (a) the order, in THIS outlet, not voided ──────────────────────────── */
  // The module's own narrow SELECT, for the same reason the GET route gives: the
  // POS handler that returns an order is the same file that exports PATCH with
  // add_item · set_qty · remove_item · fire on it. A voided order, another
  // outlet's order and a typo'd id collapse to ONE answer so nothing here lets a
  // caller probe which order ids exist.
  const order = db
    .prepare(
      `SELECT o.id, o.order_type, o.table_id, o.covers, o.server_name,
              t.id AS t_id, t.table_number AS table_number, t.zone AS zone
         FROM orders o
         LEFT JOIN restaurant_tables t ON t.id = o.table_id
        WHERE o.id = ?
          AND o.voided_at IS NULL
          AND o.status <> 'void'
          AND (o.outlet_id = ? OR o.outlet_id IS NULL OR o.outlet_id = '')`,
    )
    .get(orderId, outletId ?? '') as any;
  if (!order) return fail(404, 'order_not_found', 'Order not found.');

  // ⚠️ A ROW NO REPORT COULD EVER READ IS WORSE THAN A REFUSAL. Every reader in
  // this module drops an order that is not `dine-in` or has no `restaurant_tables`
  // row: `loadUniverse()` (reporting.ts:819-820) counts them in
  // `excluded.not_dine_in` / `excluded.table_row_missing`, and the tracker does
  // the same (query.ts:520-521). So a visit recorded against a takeaway order, or
  // against an order whose table was deleted, would sit in `gf_visits` forever,
  // invisible to Page 3 and Page 4 and impossible to explain. Guest feedback is a
  // TABLE VISIT; this says so instead of storing something unreadable.
  if (String(order.order_type ?? '') !== 'dine-in' || !str(order.t_id)) {
    return fail(
      400,
      'not_a_table_visit',
      'Guest feedback is recorded on a table visit, and this order is not one — it is either not '
      + 'a dine-in order or its table no longer exists. Nothing was recorded, because a visit '
      + 'without a table cannot appear on the Tracker or in the reports.',
    );
  }

  /* ── (b) its lines, with the group resolved server-side ─────────────────── */
  const known = knownStations(db);
  const lineRows = db
    .prepare(
      `SELECT id, menu_item_id, name, station, quantity
         FROM order_items
        WHERE order_id = ?`,
    )
    .all(orderId) as any[];

  const lines = new Map<string, OrderLine>();
  for (const r of lineRows) {
    const verdict = classifyStation(r.station, known);
    lines.set(String(r.id), {
      id: String(r.id),
      menu_item_id: str(r.menu_item_id),
      name: str(r.name),
      station: verdict.station,
      group: verdict.group,
      quantity: Number(r.quantity) || 0,
    });
  }

  /* ── (c) normalise and validate the body ───────────────────────────────── */
  const bad: string[] = [];
  const overall = enumOrFail(input?.overall_rating, OVERALL_SET, 'overall_rating', bad) as OverallRating | '';

  // The four categories. The screen offers Good · Average · Poor; the column is
  // documented as the wider Excellent · Good · Average · Poor, and ITEM_RATINGS
  // is a subset of OVERALL_RATINGS, so accepting the wider set accepts the
  // screen and the fixture both without widening what a column may hold.
  const cats: Record<Category, string> = { food: '', drinks: '', service: '', ambience: '' };
  for (const c of CATEGORIES) {
    cats[c.v] = enumOrFail(input?.categories?.[c.v], OVERALL_SET, `categories.${c.v}`, bad);
  }

  const seen = new Set<string>();
  const dupes: string[] = [];
  const unknownIds: string[] = [];
  const normal: NormalItem[] = [];

  for (const raw of Array.isArray(input?.items) ? input.items : []) {
    const id = str(raw?.order_item_id);
    if (!id) { bad.push('items[]: order_item_id is required on every entry'); continue; }
    if (!lines.has(id)) { unknownIds.push(id); continue; }
    if (seen.has(id)) { dupes.push(id); continue; }
    seen.add(id);

    normal.push({
      order_item_id: id,
      rating: enumOrFail(raw?.rating, ITEM_RATING_SET, `items[${id}].rating`, bad) as ItemRating | '',
      issue: enumOrFail(raw?.issue, ISSUE_SET, `items[${id}].issue`, bad) as ItemIssue | '',
      comment: clip(raw?.comment),
      action: (enumOrFail(raw?.action, ACTION_SET, `items[${id}].action`, bad) || 'none') as ActionTaken,
      replacement_menu_item_id: str(raw?.replacement_menu_item_id).slice(0, 64),
      replacement_item_name: clip(raw?.replacement_item_name).slice(0, 200),
      revisit_rating: enumOrFail(raw?.revisit?.rating, REVISIT_SET, `items[${id}].revisit.rating`, bad) as RevisitRating | '',
      happiness: enumOrFail(raw?.revisit?.happiness, HAPPINESS_SET, `items[${id}].revisit.happiness`, bad) as Happiness | '',
      revisit_comment: clip(raw?.revisit?.comment),
    });
  }

  // The item checks come BEFORE the generic enum bag so the message names the
  // real problem: a body aimed at the wrong order is not a typo in a rating.
  if (unknownIds.length) {
    return fail(
      400,
      'item_not_on_order',
      `${unknownIds.length} item${unknownIds.length === 1 ? ' is' : 's are'} not on this order. `
      + 'Feedback can only be recorded against the items the guest actually ordered.',
      { offending_item_ids: unknownIds },
    );
  }
  if (dupes.length) {
    return fail(
      400,
      'duplicate_item',
      'The same ordered line appears twice in this submission. One feedback row per line — '
      + 'a second would double-count the complaint in every Page 4 rate.',
      { offending_item_ids: dupes },
    );
  }
  if (bad.length) {
    return fail(400, 'bad_value', `Unrecognised value — ${bad.join('; ')}.`);
  }

  const toRecord = normal.filter(recordable);
  const ignoredEmpty = normal.length - toRecord.length;
  const comment = clip(input?.comment);
  const everythingGood = input?.everything_good === true;

  // Mirrors the screen's own `canSubmit` (overall set OR at least one item
  // noted) and adds the two other ways a GRE can say something. An abandoned
  // form must never become a row — `gf_visits` counts as coverage.
  const saysSomething = everythingGood
    || !!overall
    || CATEGORIES.some((c) => !!cats[c.v])
    || !!comment
    || toRecord.length > 0;
  if (!saysSomething) {
    return fail(
      400,
      'nothing_to_record',
      'Nothing was recorded. Tap Everything Good, or give an overall rating, a category, '
      + 'a comment, or at least one item.',
    );
  }

  /* ── (d) one visit per order ────────────────────────────────────────────── */
  const existing = db
    .prepare(
      `SELECT id, gre_user_id, gre_name, status, has_negative, follow_ups_total, open_follow_ups,
              created_at
         FROM gf_visits WHERE order_id = ?`,
    )
    .get(orderId) as any;
  if (existing) return alreadyTaken(existing, recorder, orderId);

  /* ── (e) the write ──────────────────────────────────────────────────────── */
  // ONE stamp for every column in this submit, taken from SQLite itself so the
  // stored format is exactly the `datetime('now')` the DDL defaults to and the
  // readers parse (`sqlUtcToIso`). Computing it in JS would risk an ISO string
  // in a column the business-day rollover reads as SQL-UTC.
  const now = String((db.prepare(`SELECT datetime('now') AS t`).get() as any)?.t ?? '');

  const visitId = newId();
  const negatives = toRecord.filter((it) => isNegative(it.rating)).length;
  const hasNegative = negatives > 0;
  // "Everything Good" and a Poor plate in the same submit is self-contradictory.
  // The screen clears item detail when the button is tapped, so this should be
  // unreachable; if a client ever sends it, the ROW stays honest (0) and the
  // caller is told rather than Page 4 counting a complaint visit as a clean one.
  const everythingGoodStored = everythingGood && !hasNegative;

  const followUpSeeds = toRecord
    .map((it) => ({ it, needs: requiresFollowUp(it.action) }))
    .filter((x) => x.needs);
  const followUpsTotal = followUpSeeds.length;
  const followUpsClosed = followUpSeeds.filter((x) => closesIssue(x.it.happiness)).length;
  const followUpsOpen = followUpsTotal - followUpsClosed;

  // `tableStatus()`'s own ordering, restricted to the three states a RECORDED
  // visit can be in: an open follow-up outranks a raised issue, which outranks a
  // plain "taken".
  const status: SubmitFeedbackOk['status'] =
    followUpsOpen > 0 ? 'follow_up' : hasNegative ? 'issue' : 'taken';

  const insertVisit = db.prepare(
    `INSERT INTO gf_visits
       (id, outlet_id, order_id, table_id, table_number, floor, covers, captain_name,
        items_ordered, gre_user_id, gre_email, gre_name, gre_role,
        everything_good, overall_rating, cat_food, cat_drinks, cat_service, cat_ambience,
        comment, status, has_negative, follow_ups_total, open_follow_ups,
        created_at, updated_at)
     VALUES
       (@id, @outlet_id, @order_id, @table_id, @table_number, @floor, @covers, @captain_name,
        @items_ordered, @gre_user_id, @gre_email, @gre_name, @gre_role,
        @everything_good, @overall_rating, @cat_food, @cat_drinks, @cat_service, @cat_ambience,
        @comment, @status, @has_negative, @follow_ups_total, @open_follow_ups,
        @created_at, @updated_at)`,
  );

  const insertItem = db.prepare(
    `INSERT INTO gf_item_feedback
       (id, visit_id, order_id, order_item_id, menu_item_id, item_name, station, item_group,
        quantity, rating, issue, comment, action_taken,
        replacement_menu_item_id, replacement_item_name, is_negative,
        created_by, created_at, updated_at)
     VALUES
       (@id, @visit_id, @order_id, @order_item_id, @menu_item_id, @item_name, @station, @item_group,
        @quantity, @rating, @issue, @comment, @action_taken,
        @replacement_menu_item_id, @replacement_item_name, @is_negative,
        @created_by, @created_at, @updated_at)`,
  );

  const insertFollowUp = db.prepare(
    `INSERT INTO gf_follow_ups
       (id, visit_id, item_feedback_id, order_id, table_id, item_name, action_taken, status,
        revisit_rating, happiness, revisit_comment, revisited_at, revisited_by,
        closed_at, closed_by, escalated_at, created_at, updated_at)
     VALUES
       (@id, @visit_id, @item_feedback_id, @order_id, @table_id, @item_name, @action_taken, @status,
        @revisit_rating, @happiness, @revisit_comment, @revisited_at, @revisited_by,
        @closed_at, @closed_by, @escalated_at, @created_at, @updated_at)`,
  );

  const tableId = str(order.table_id);

  const run = db.transaction(() => {
    insertVisit.run({
      id: visitId,
      outlet_id: str(outletId),
      order_id: orderId,
      table_id: tableId,
      table_number: str(order.table_number),
      // The ZONE, through the same labeller every reader uses, so '' and 'Floor'
      // are one bucket here as well as on the board (`floorLabel` is idempotent).
      floor: floorLabel(order.zone),
      covers: Number(order.covers) || 0,
      captain_name: str(order.server_name),
      // What the table had ordered AT VISIT TIME — a snapshot, so a line added
      // after the GRE walked away cannot retro-change what she saw.
      items_ordered: lineRows.length,
      gre_user_id: recorder.user_id,
      gre_email: recorder.email,
      gre_name: recorder.name,
      gre_role: recorder.role,
      everything_good: everythingGoodStored ? 1 : 0,
      overall_rating: overall,
      cat_food: cats.food,
      cat_drinks: cats.drinks,
      cat_service: cats.service,
      cat_ambience: cats.ambience,
      comment,
      status,
      has_negative: hasNegative ? 1 : 0,
      follow_ups_total: followUpsTotal,
      open_follow_ups: followUpsOpen,
      created_at: now,
      updated_at: now,
    });

    for (const it of toRecord) {
      const line = lines.get(it.order_item_id)!;
      const itemFeedbackId = newId();
      insertItem.run({
        id: itemFeedbackId,
        visit_id: visitId,
        order_id: orderId,
        order_item_id: line.id,
        menu_item_id: line.menu_item_id,
        item_name: line.name,
        // RAW station plus the verdict, both. The classifier is TOTAL — a blank
        // or typo'd station silently returns Food — so the raw value is the only
        // way Page 4 can count a mis-filed drink instead of losing it.
        station: line.station,
        item_group: line.group,
        // The ORDERED quantity, always. Page 4's own sheet note says "the
        // numerator sums gf_item_feedback.quantity, so one feedback on a line of
        // three counts three"; a client-supplied plate count would quietly make
        // that sentence false, and the screen has no control for it.
        quantity: line.quantity,
        rating: it.rating,
        issue: it.issue,
        comment: it.comment,
        action_taken: it.action,
        replacement_menu_item_id: it.replacement_menu_item_id,
        replacement_item_name: it.replacement_item_name,
        // The DDL's own rule: rating IN (poor, average). An issue or an action
        // with no rating is a recorded event, not a rating — `isNegative()` is
        // the single authority and is not re-spelled here.
        is_negative: isNegative(it.rating) ? 1 : 0,
        created_by: recorder.user_id,
        created_at: now,
        updated_at: now,
      });

      // No follow-up for an action that does not raise one — and the revisit
      // fields that came with it are therefore dropped, deliberately: there is
      // nothing to revisit on a dish that was cancelled or simply returned. The
      // screen only offers the revisit block for the three actions that DO raise
      // one (`requiresFollowUp`), so a body carrying one here is a client bug,
      // and inventing a follow-up for it would put a complaint in Page 3's queue
      // that no rule says belongs there.
      if (!requiresFollowUp(it.action)) continue;

      const revisited = !!it.happiness || !!it.revisit_rating;
      const closed = closesIssue(it.happiness);
      insertFollowUp.run({
        id: newId(),
        visit_id: visitId,
        item_feedback_id: itemFeedbackId,
        order_id: orderId,
        table_id: tableId,
        item_name: line.name,
        action_taken: it.action,
        status: closed ? 'closed' : 'open',
        revisit_rating: it.revisit_rating,
        happiness: it.happiness,
        revisit_comment: it.revisit_comment,
        revisited_at: revisited ? now : '',
        revisited_by: revisited ? recorder.user_id : '',
        closed_at: closed ? now : '',
        closed_by: closed ? recorder.user_id : '',
        // A revisit that did NOT close it escalates to the manager — the owner's
        // "Partially Happy and Still Unhappy stay open for Manager attention".
        // An untouched follow-up is merely open, never escalated.
        escalated_at: revisited && !closed ? now : '',
        created_at: now,
        updated_at: now,
      });
    }
  });

  try {
    run();
  } catch (e: any) {
    // The UNIQUE index is the real guard against a double-tap: two requests can
    // both pass the pre-check in (d) before either inserts. Losing that race is
    // not an error for the GRE — her feedback IS recorded — so it answers the
    // same way the pre-check does.
    if (String(e?.code ?? '') === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed: gf_visits/.test(String(e?.message ?? ''))) {
      const row = db
        .prepare(
          `SELECT id, gre_user_id, gre_name, status, has_negative, follow_ups_total,
                  open_follow_ups, created_at
             FROM gf_visits WHERE order_id = ?`,
        )
        .get(orderId) as any;
      if (row) return alreadyTaken(row, recorder, orderId);
    }
    console.error('[feedback/write submitFeedback]', e);
    return fail(500, 'write_failed', e?.message || 'Could not record the feedback.');
  }

  return {
    ok: true,
    visit_id: visitId,
    order_id: orderId,
    duplicate: false,
    status,
    has_negative: hasNegative,
    items_recorded: toRecord.length,
    items_ignored_empty: ignoredEmpty,
    follow_ups_created: followUpsTotal,
    follow_ups_open: followUpsOpen,
    follow_ups_closed: followUpsClosed,
    everything_good_overridden: everythingGood && !everythingGoodStored,
  };
}

/* ════════════════════════════════════════════════════════════════════════════
   4. THE SECOND SUBMIT
   ════════════════════════════════════════════════════════════════════════════
   `uq_gf_visits_order` allows ONE visit row per order, and that is the rule that
   keeps coverage honest. So a second submit has exactly two meanings:

     · THE SAME GRE, again — a double-tap, a retried request, a back button. Her
       feedback is already recorded, so this answers OK with `duplicate: true`
       and the EXISTING row's counts, and writes nothing. A 409 here would show
       an error for a submit that actually succeeded.

     · A DIFFERENT PERSON — someone else already took this table. Refused, 409,
       and the refusal NAMES them and when, because the honest next action is a
       revisit (which writes `gf_follow_ups`), not a second visit row that would
       count the table twice in Feedback Taken.

   Nothing is merged in either case. Overwriting a colleague's record, or
   quietly folding a different payload into an existing row, would both lose
   what the first person wrote. */
function alreadyTaken(
  row: any,
  recorder: FeedbackRecorder,
  orderId: string,
): SubmitFeedbackResult {
  const open = Number(row.open_follow_ups) || 0;
  const total = Number(row.follow_ups_total) || 0;

  if (str(row.gre_user_id) && str(row.gre_user_id) === str(recorder.user_id)) {
    return {
      ok: true,
      visit_id: str(row.id),
      order_id: orderId,
      duplicate: true,
      status: (str(row.status) || 'taken') as SubmitFeedbackOk['status'],
      has_negative: !!Number(row.has_negative),
      items_recorded: 0,
      items_ignored_empty: 0,
      follow_ups_created: 0,
      follow_ups_open: open,
      follow_ups_closed: Math.max(0, total - open),
      everything_good_overridden: false,
    };
  }

  const who = str(row.gre_name) || 'another user';
  return fail(
    409,
    'already_taken',
    `Feedback for this table was already recorded by ${who}. One feedback record per table, `
    + 'so the table is not counted twice — if the guest has something new to say, record it as '
    + 'a revisit on the open follow-up.',
    { taken_by: who, taken_at: str(row.created_at) },
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   5. IDS
   ════════════════════════════════════════════════════════════════════════════ */

/** `crypto.randomUUID()`, the same id shape `generateId()` in `src/lib/db.ts`
 *  produces — written here so this file keeps its single `import type`
 *  dependency and does not pull `@/lib/db` (and better-sqlite3's runtime) into
 *  anything that imports it. */
function newId(): string {
  return crypto.randomUUID();
}
