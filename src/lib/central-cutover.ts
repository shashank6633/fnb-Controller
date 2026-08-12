import type Database from 'better-sqlite3';
import { generateId } from './db';
import { centralFlowBlock, catNorm } from './store-engine';
import { packFactor, toPurchaseQty, type PackMeta } from './pack-units';
import { rateMap, materialRate, valueCount } from './closing-valuation';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ CENTRAL STORE CUTOVER — re-base the book on one physical count.          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * SERVER ONLY. Imports better-sqlite3 through ./db; never import this from a
 * "use client" file.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────
 * raw_materials.current_stock is a RUNNING BALANCE, never an observation:
 *
 *     opening + SUM(recorded inflows) - SUM(recorded outflows)
 *
 * Every term is a RECORDING EVENT and the shelf is never consulted. The two
 * sides are not enforced equally — an outflow records itself (issuing writes a
 * row, recipe consumption fires at KOT-complete) while an inflow needs a human
 * to type a purchase or a GRN. Cash-market runs, a vendor leaving a crate at
 * the kitchen door and emergency top-ups all arrive physically and none get
 * typed. The error is therefore ONE-DIRECTIONAL and CUMULATIVE.
 *
 * The consequence is the point of this module: every variance report today
 * measures DRIFT, not LOSS, so nobody can separate a real 2 kg shortage from
 * six months of missing paperwork and nobody can act on the report. Counting
 * the shelf once, setting the book to it, and stamping the date fixes that from
 * that date forward.
 *
 * ── THE OWNER'S TWO RULINGS ────────────────────────────────────────────────
 * RULING 1 — the drift is a NON-FINANCIAL correction. No purchases row, no
 *   change to average_price or last_purchase_price, nothing that lands in
 *   consumption, P&L or the variance/loss reports. The rupee figures here are
 *   INFORMATION ONLY. It is not a gain; it is months of missing paperwork
 *   written off in one stroke, and booking it as income would overstate one
 *   month's profit and understate every prior month's cost.
 * RULING 1b — "we need to have a alert for every single variance". Every line
 *   whose counted figure differs from the book gets its OWN durable record
 *   (alert = 1 on its central_cutover_lines row), listed line by line on the
 *   review screen. The BELL gets ONE notification for the batch — because ~600
 *   bell rows would destroy the bell. That is unreviewedAlertBatches() below,
 *   consumed by the admin-gated `cutover_alerts:<batch>` bucket in
 *   src/app/api/notifications/inbox/route.ts (count = 1 per batch; the numbers
 *   ride in the label).
 *
 * ── SET, NOT ADD — AND THE GATE THAT MAKES THAT SAFE ───────────────────────
 * src/lib/variance-approval.ts deliberately applies a DELTA rather than
 * SET = physical, because a count taken at 10am and approved at 4pm would
 * otherwise erase the noon issue. That reasoning is sound and it applies here
 * too. A cutover still SETS (the brief requires it, and an absolute set is the
 * only form that cannot inherit a drifted base), so the safety the delta gave
 * away is bought back explicitly: commitBatch REFUSES any line whose material
 * moved between staging and commit (MOVED_SINCE_COUNT), naming the movements.
 * Re-stage that line with a fresh count and the refusal clears. previewBatch
 * surfaces the same signal live so it is never a surprise at commit.
 *
 * ── COUNTED ZERO IS NOT UNCOUNTED ──────────────────────────────────────────
 * The single worst outcome this module could have is silently zeroing hundreds
 * of uncounted materials. So:
 *   • a material with NO LINE is left completely untouched — never zeroed,
 *     never assumed;
 *   • a line EXISTS only because a human typed a number, and 0 is a number
 *     ("we looked and found none"), applied like any other;
 *   • a blank / whitespace / non-numeric cell is REFUSED at staging and
 *     reported, never coerced. parseCountedQty() below is the one place that
 *     decision is made, and it never uses the Number(x) || 0 idiom, which is
 *     exactly how a blank cell becomes a zero.
 *
 * ── SCOPE: CENTRAL ONLY ────────────────────────────────────────────────────
 * Store-mapped (liquor) materials are excluded and REPORTED, following the
 * centralFlowBlock precedent in api/purchases/opening-stock. They live on the
 * TGBCL rail (store_locations / store_stock_ledger) with their own closing and
 * adjustment flows. Note for the screen: that exclusion is by CATEGORY
 * (store_category_map, matched through catNorm), so a mis-categorised bottle
 * stays central — say the rule out loud rather than implying the sheet is
 * liquor-free by name.
 *
 * Sub-recipes are out of scope by construction, not by choice: they have no
 * running balance to re-base (closing_stock.material_id is NOT NULL with an FK
 * to raw_materials, so a sub-recipe id cannot even be stored against one).
 *
 * ── RUNBOOK ORDER (say this on screen) ─────────────────────────────────────
 * Finish /unit-audit BEFORE counting. api/unit-audit rescales current_stock by
 * fNew/fOld when a lock changes a pack factor, so a unit correction made after
 * a cutover multiplies the counted figure. commitBatch defends the window it
 * can see (PACK_FACTOR_CHANGED, per line) but it cannot defend a change made
 * after the commit.
 */

// ── errors ──────────────────────────────────────────────────────────────────

/** Machine-readable failure. `code` is what an API route should map to a
 *  status; `details` carries the offending rows so the screen can name them. */
export class CutoverError extends Error {
  code: CutoverErrorCode;
  details: unknown;
  constructor(code: CutoverErrorCode, message: string, details: unknown = null) {
    super(message);
    this.name = 'CutoverError';
    this.code = code;
    this.details = details;
  }
}

export type CutoverErrorCode =
  | 'UNKNOWN_BATCH'
  | 'NOT_DRAFT'            // already committed or cancelled — the idempotency guard
  | 'NO_LINES'
  | 'FUTURE_DATE'
  | 'CUTOVER_BEFORE_STAMP'
  | 'STORE_MAPPED_MATERIAL'
  | 'UNKNOWN_MATERIAL'
  | 'PACK_FACTOR_CHANGED'
  | 'MOVED_SINCE_COUNT'
  | 'WRITE_FAILED';

// ── small helpers ───────────────────────────────────────────────────────────

/** 6 dp — quantities. Matches the department cutover's r6. */
const r6 = (n: number) => Math.round((Number(n) || 0) * 1e6) / 1e6;
/** 2 dp — rupees. */
const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
/** Quantities below this are treated as equal (float noise, not a variance). */
const EPS = 1e-6;

const norm = (v: unknown) => String(v ?? '').trim();
const normUnit = (v: unknown) => String(v ?? '').trim().toLowerCase();

/**
 * Normalise a stored timestamp for string comparison: 19 chars, 'T' -> ' '.
 * Byte-identical in behaviour to dept-stock.ts normTs, and for the same reason
 * — 'T' sorts above ' ', so comparing a raw ISO stamp against a raw
 * datetime('now') stamp silently shifts a whole day. Returns '' for junk, which
 * every caller here treats as "no bound".
 */
function normTs(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s + ' 00:00:00';
  return s.slice(0, 19).replace('T', ' ');
}

/** SQL form of normTs for a column. Keep in step with normTs above. */
const TS_SQL = (col: string) => "REPLACE(SUBSTR(" + col + ", 1, 19), 'T', ' ')";

/** Minutes IST runs ahead of UTC. The house convention — istToday() below uses
 *  the same +330 through SQLite's date(). */
const IST_OFFSET_MIN = 330;

/**
 * The IST business date a stored UTC timestamp falls on.
 *
 * Pure JS on purpose: this runs once per staged line inside the commit's
 * validation loop (~825 of them), and a SQLite round trip per line to compute
 * a value that is a fixed offset away would be a query for arithmetic. Returns
 * '' for junk, which every caller treats as "no bound".
 */
function istDateOfUtc(v: unknown): string {
  const s = normTs(v);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return '';
  const t = Date.parse(s.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(t)) return '';
  return new Date(t + IST_OFFSET_MIN * 60000).toISOString().slice(0, 10);
}

/**
 * The UTC instant at which an IST business date BEGINS — 'YYYY-MM-DD 00:00:00'
 * IST is 18:30:00 UTC on the PREVIOUS day.
 *
 * This is the only correct lower bound for "everything recorded on or after the
 * count date". Using 'D 00:00:00' as if it were UTC would miss every row
 * recorded between 00:00 and 05:30 IST on day D — a real window, because the
 * night audit and the late bar close both land in it. Returns '' for junk.
 */
function istDayStartUtc(date: unknown): string {
  const d = String(date ?? '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return '';
  const t = Date.parse(d + 'T00:00:00Z');
  if (!Number.isFinite(t)) return '';
  return new Date(t - IST_OFFSET_MIN * 60000).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Every store-mapped (liquor) material id, in ONE query.
 *
 * Same rule as store-engine's materialStoreId — a material's CATEGORY matched
 * against store_category_map for an ACTIVE store, through catNorm so
 * 'Single-Malt Whiskey' / 'single malt whiskey' compare equal. Used for the
 * bulk scans; the per-line path still calls centralFlowBlock() because that is
 * the precedent and it returns the human sentence naming the right store.
 *
 * THE LEAK IS REAL AND MUST BE SAID ON SCREEN: the rule is category-based, so a
 * bottle filed under a non-liquor category is NOT store-mapped and stays on the
 * central sheet. Nothing here guesses liquor from a name — a name heuristic
 * would mislabel innocent rows, and a wrong exclusion is worse than a listed one.
 */
export function storeMappedIds(db: Database.Database): Set<string> {
  try {
    const rows = db.prepare(`
      SELECT m.id
        FROM raw_materials m
       WHERE EXISTS (
         SELECT 1 FROM store_category_map scm
           JOIN store_locations s ON s.id = scm.store_id
          WHERE s.is_active = 1 AND ${catNorm('scm.category')} = ${catNorm('m.category')}
       )
    `).all() as Array<{ id: string }>;
    return new Set(rows.map((r) => r.id));
  } catch { return new Set(); }
}

/** IST calendar day — the house convention. A cutover typed at 11pm belongs to
 *  tonight's business date, not tomorrow's UTC one. */
export function istToday(db: Database.Database): string {
  try {
    return String((db.prepare("SELECT date('now', '+330 minutes') AS d").get() as { d: string }).d);
  } catch { return new Date().toISOString().slice(0, 10); }
}

// ── THE STAMP ───────────────────────────────────────────────────────────────

/**
 * The central-store cutover stamp, or null when no cutover has been committed.
 *
 * Mirrors getDeptLedgerCutoverAt() in dept-stock.ts exactly, including the
 * null-on-junk behaviour, and for the same reason: an explicit null makes the
 * "unstamped install behaves exactly as before" branch visible at every call
 * site. EVERY CONSUMER MUST TREAT null AS "behave exactly as before" — no extra
 * WHERE clause, no changed label, byte-identical SQL.
 *
 * Written ONCE, by commitBatch, and never by a boot migration: opening
 * balances are admin-owned state and scripts/check-boot-migrations.js exists to
 * keep deploys out of them. Unlike dept_ledger_cutover_at this row is not even
 * seeded — absent and '' both mean "no cutover", and both return null.
 *
 * WHAT THIS VALUE IS, AND WHAT IT IS NOT. It is the COUNT DATE, normalised to
 * 'YYYY-MM-DD 00:00:00' — a BUSINESS-DATE stamp, not a UTC instant. It has to
 * be: four strings on /inventory/central-cutover promise the operator that the
 * cutover date is the day the shelf was counted, and this row is what every one
 * of them reads back. Stamping the commit time instead put a UTC clock reading
 * here, so a sheet counted on the 11th and committed at 01:00 IST on the 12th
 * (19:30 UTC on the 11th) stamped a date the screen never mentioned.
 *
 * DO NOT COMPARE THIS AGAINST created_at. It is midnight on a business date,
 * not the moment anything happened. For "was this recorded before the cutover
 * was applied?" use getCentralStoreCutoverCommittedAt() below, which is the
 * real UTC instant of the write.
 */
export function getCentralStoreCutoverAt(db: Database.Database): string | null {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'central_store_cutover_at'")
      .get() as { value?: string } | undefined;
    return normTs(row?.value) || null;
  } catch { return null; }
}

/**
 * The same stamp as a bare IST-ish business DATE ('YYYY-MM-DD'), or null.
 *
 * USE THIS — NOT the timestamp — for every comparison against closing_stock.date
 * and any other business-date column. Those columns hold 'YYYY-MM-DD', and
 * lexically '2026-08-20' < '2026-08-20 00:00:00', so comparing a date column
 * against the full stamp silently drops the cutover day itself from a >= filter
 * while including it in a <= filter. That off-by-one-day is invisible in review
 * and obvious only in production.
 *
 * Prefer  cs.date >= cutoverDate  (inclusive): the cutover writes no
 * closing_stock row of its own, so a genuine same-day recount should still show.
 */
export function getCentralStoreCutoverDate(db: Database.Database): string | null {
  const at = getCentralStoreCutoverAt(db);
  return at ? at.slice(0, 10) : null;
}

/**
 * The UTC instant the cutover was actually APPLIED, or null.
 *
 * A SECOND KEY, because the two questions are different and one value cannot
 * answer both. 'central_store_cutover_at' is the business date the shelf was
 * counted — what the screen promises and what every business-date filter needs.
 * This one is the wall-clock moment current_stock was re-based, and it is the
 * only honest answer to "was this row recorded against the old book or the new
 * one?" — which is exactly what a pending variance approval has to be judged
 * on (see approveVariance's central floor in src/lib/variance-approval.ts).
 *
 * Written by commitBatch beside the date stamp, under the same write-once
 * guard, and — like the date stamp — deliberately NOT seeded by the boot
 * migration. Absent and '' both mean "no cutover" and both return null.
 */
export function getCentralStoreCutoverCommittedAt(db: Database.Database): string | null {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'central_store_cutover_committed_at'")
      .get() as { value?: string } | undefined;
    return normTs(row?.value) || null;
  } catch { return null; }
}

/**
 * The committed batch that OWNS the boundary — the one whose commit wrote the
 * stamp — or null.
 *
 * ONE definition, exported, because three surfaces need the same batch and a
 * second copy of this query is how /api/variance-report and /api/daily-rollup
 * would end up opening from different counts. `stamped = 1` holds for at most
 * one batch by construction (the stamp UPDATE in commitBatch only fires on a
 * blank value, so exactly one commit can ever set it); the ORDER BY is there so
 * a hand-edited database returns a deterministic row instead of an arbitrary one.
 */
export function stampedCutoverBatch(
  db: Database.Database,
): { id: string; cutover_date: string; committed_at: string } | null {
  try {
    const row = db.prepare(`
      SELECT id, cutover_date, committed_at
        FROM central_cutover_batches
       WHERE stamped = 1 AND status = 'committed'
       ORDER BY cutover_date DESC, committed_at DESC
       LIMIT 1
    `).get() as { id: string; cutover_date: string; committed_at: string } | undefined;
    return row ?? null;
  } catch { return null; }
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ THE REPORTING BASIS — what a variance is measured FROM after a cutover.  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * null means NO CUTOVER IS IN FORCE, and every caller must then behave exactly
 * as it did before this module existed: no extra clause, no extra column, no
 * extra bound parameter, byte-identical SQL and payload. That is the whole
 * contract of this return value and it is why it is a nullable object rather
 * than a struct of empty strings — an empty string is easy to interpolate by
 * accident, a null is not.
 *
 * ── WHY THE REPORTS NEED THIS AT ALL ───────────────────────────────────────
 * Filtering pre-cutover COUNT ROWS out of a report (which is all the first pass
 * did) hides the old rows and changes nothing about the arithmetic: both
 * /api/variance-report and /api/daily-rollup rebuild the expected figure from
 * ALL-TIME purchases minus ALL-TIME outflows with no lower bound, and neither
 * reads raw_materials.current_stock — the one column a cutover actually
 * re-bases. So a cutover moved ZERO numbers on either report, and every
 * post-cutover count was still being measured against months of pre-cutover
 * drift while the screen implied it had been cleaned up.
 *
 * The fix both reports now apply:
 *     expected = the cutover's counted figure                (OPENING TERM)
 *              + purchases dated AFTER the cutover date
 *              − outflows  dated AFTER the cutover date
 *
 * ── STRICTLY AFTER, AND WHY THAT IS SAFE ───────────────────────────────────
 * The count is the shelf as it stood ON the cutover date, so the opening term
 * is that day's closing position and only later days add to it. Nothing dated
 * ON the cutover date can be double-counted, because the commit's movement
 * fence refuses a backdated batch outright when anything is recorded on or
 * after the count date (see movedSince) — a committed cutover therefore has no
 * same-day rows behind it. The choice only shows up on a row backdated onto the
 * cutover day AFTER the commit, where either convention is a guess.
 *
 * ── A MATERIAL WITH NO CUTOVER LINE KEEPS THE OLD BASIS, ROW BY ROW ────────
 * The cutover re-bases what was counted and leaves everything else alone, so an
 * uncounted material has no trustworthy opening. Giving it 0 would invent a
 * shortage of its entire stock; giving it a floored window without an opening
 * would do the same more quietly. Both reports therefore fall back to the
 * all-time formula for those materials specifically, and label the row, rather
 * than reporting a number they cannot stand behind.
 *
 * REQUIRES BOTH the settings stamp AND the batch that wrote it. A stamp with no
 * batch behind it (hand-edited settings) would floor every window with no
 * opening term available for anyone — the worst of both bases — so it is
 * treated as no cutover, and the routes say so in a warning.
 */
export interface CutoverReportBasis {
  /** The boundary business date. Windows open strictly after this. */
  date: string;
  /** The batch whose counted lines ARE the opening balances. */
  batchId: string;
}

export function cutoverReportBasis(db: Database.Database): CutoverReportBasis | null {
  const date = getCentralStoreCutoverDate(db);
  if (!date) return null;
  const batch = stampedCutoverBatch(db);
  if (!batch) return null;
  return { date, batchId: batch.id };
}

/** True when a stamp exists but the batch behind it does not — the one state in
 *  which the reports keep the old basis DESPITE a cutover being stamped, and so
 *  the one that has to be said out loud rather than left to look like a bug. */
export function cutoverStampedWithoutBatch(db: Database.Database): boolean {
  return getCentralStoreCutoverDate(db) !== null && stampedCutoverBatch(db) === null;
}

// ── types ───────────────────────────────────────────────────────────────────

export type BatchStatus = 'draft' | 'committed' | 'cancelled';

export interface CutoverBatch {
  id: string;
  cutover_date: string;
  status: BatchStatus;
  note: string;
  created_by: string;
  created_at: string;
  committed_by: string;
  committed_at: string;
  cancelled_by: string;
  cancelled_at: string;
  /** Frozen at commit; 0 on a draft. */
  counted_lines: number;
  variance_lines: number;
  net_variance_value: number;
  shortage_value: number;
  excess_value: number;
  /** 1 only for the batch whose commit actually wrote settings.central_store_cutover_at. */
  stamped: number;
}

export interface CutoverLine {
  id: string;
  batch_id: string;
  material_id: string;
  material_name: string;
  /** AS ENTERED, in counted_unit. */
  counted_qty: number;
  counted_unit: string;
  counted_basis: 'purchase' | 'recipe';
  pack_factor: number;
  counted_qty_recipe: number;
  book_qty_at_stage: number;
  staged_at: string;
  /** Snapshot taken inside the commit transaction. 0 until committed. */
  book_qty_recipe: number;
  variance_recipe: number;
  recipe_unit: string;
  purchase_unit: string;
  /** Rs per PURCHASE unit, from the valuation ladder. */
  unit_value: number;
  rate_source: string;
  /** Rs — INFORMATION ONLY (Ruling 1). */
  variance_value: number;
  note: string;
  alert: number;
  reviewed_by: string;
  reviewed_at: string;
  review_note: string;
  created_at: string;
}

/** A material as it appears on the count sheet. Quantities lead in PURCHASE
 *  units per the owner rule; the recipe figure travels alongside, labelled. */
export interface CutoverSheetRow {
  material_id: string;
  name: string;
  sku: string;
  category: string;
  /** RECIPE units — the stored truth. */
  book_qty: number;
  /** PURCHASE units — derived, display-only, never summed across materials. */
  book_qty_purchase: number;
  unit: string;
  purchase_unit: string;
  pack_factor: number;
  /** Rs per PURCHASE unit + where it came from. */
  unit_value: number;
  rate_source: string;
  /** book_qty valued through the ladder. Rs. */
  book_value: number;
  /** false = no purchase, no requisition line, no stock movement and no stock,
   *  ever. Default the sheet to active rows and hide these behind a toggle: a
   *  long tail of dead masters invites a rushed counter to give an obsolete
   *  duplicate a balance for the first time. */
  has_activity: boolean;
  /** This material already has a line in the open draft (and what it says). */
  staged: boolean;
  staged_qty: number | null;
  staged_unit: string;
}

export interface CutoverSheet {
  rows: CutoverSheetRow[];
  summary: {
    total_materials: number;
    /** Excluded because store-mapped (liquor). */
    store_excluded: number;
    /** Rows returned after the store exclusion. */
    central_materials: number;
    with_activity: number;
    inert: number;
    /** Rs, book value of the returned rows. */
    book_value: number;
    /** Copy the screen must show, so the exclusion never reads as a bug. */
    store_excluded_reason: string;
  };
}

/** One staged count, as it arrives from a CSV row or a form field. */
export interface StageLineInput {
  material_id?: string | null;
  /** Fallbacks for a CSV: sku first, then exact (case-insensitive) name. */
  sku?: string | null;
  name?: string | null;
  /** The typed value. May be a string straight off a CSV. A blank is REFUSED,
   *  never read as 0 — see parseCountedQty. */
  counted_qty?: unknown;
  /** REQUIRED whenever the material has a real pack factor; guessing is refused. */
  counted_unit?: string | null;
  note?: string | null;
  /**
   * "I HAVE JUST RE-COUNTED THIS SHELF." An explicit human assertion, and the
   * only thing that moves a line's count instant forward when the number has
   * not changed — see stageLines. A plain re-send (the same sheet uploaded
   * twice) must never clear a MOVED_SINCE_COUNT refusal on its own.
   */
  recount?: boolean;
}

export interface StageRejection {
  row: number;
  material_id: string;
  name: string;
  reason:
    | 'blank'
    | 'not_a_number'
    | 'negative'
    | 'unknown_material'
    | 'unit_required'
    | 'unknown_unit'
    /** The material declares a pack factor the house rule cannot honour — see
     *  resolveCountBasis. Refused rather than converted by the wrong factor. */
    | 'unconvertible_unit'
    | 'store_mapped';
  detail: string;
}

export interface StageResult {
  accepted: number;
  updated: number;
  /**
   * Lines that arrived again with the SAME figure and no re-count assertion.
   * The row is left exactly as it was — same quantity, same staged_at — so a
   * re-upload of the same sheet cannot silently refresh a stale count. Counted
   * separately from `updated` because the operator has to be told the
   * difference: "recorded again" and "left alone" are not the same answer.
   */
  unchanged: number;
  rejected: StageRejection[];
  store_blocked: Array<{ row: number; material_id: string; name: string; error: string }>;
}

export interface PreviewLine {
  material_id: string;
  name: string;
  counted_qty: number;
  counted_unit: string;
  counted_basis: 'purchase' | 'recipe';
  pack_factor: number;
  counted_qty_recipe: number;
  /**
   * LIVE current_stock, recipe units — recomputed on every preview. The value
   * actually recorded is snapshotted again inside the commit transaction.
   *
   * NULL MEANS "THERE IS NO BOOK TO READ" — the counted material has been
   * deleted since it was staged. Every book-derived field on this interface is
   * nullable for that one row and for no other reason; see previewBatch. A 0
   * there would read as a real observation of an empty shelf, which is the one
   * thing this module refuses to fabricate anywhere else.
   */
  book_qty_recipe: number | null;
  variance_recipe: number | null;
  /** Both sides in purchase units, for the screen. The COUNTED figure is always
   *  a real number — it is the human's own measurement, converted through the
   *  pack factor frozen on the line — even when the material is gone. */
  counted_qty_purchase: number;
  book_qty_purchase: number | null;
  variance_purchase: number | null;
  unit: string;
  purchase_unit: string;
  unit_value: number | null;
  rate_source: string;
  /** Rs — INFORMATION ONLY. */
  variance_value: number | null;
  /** This line will raise an alert record at commit. */
  will_alert: boolean;
  /**
   * The counted material no longer exists in raw_materials. The line is blocked
   * and NONE of the book-derived fields above are readable, so the screen must
   * say "this material is gone, remove the line" rather than offering the
   * re-count that its blocked sibling flags imply.
   */
  material_missing: boolean;

  /* Blocking conditions, surfaced BEFORE commit so they are never a surprise.
   * `blocked` is the one to gate the UI on — the three signals below are for
   * explaining WHY, and record_edited alone is deliberately NOT a blocker. */
  blocked: boolean;
  /** Recorded movement rows (inventory_transactions + purchases) since staging. */
  moved_since_stage: number;
  /** current_stock differs from the figure captured when the line was staged. */
  stock_changed: boolean;
  /** updated_at advanced — may be only a rename; not blocking on its own. */
  record_edited: boolean;
  pack_factor_changed: boolean;
  now_store_mapped: boolean;
  staged_at: string;
  /**
   * The instant this line's count SPEAKS FOR, and the lower bound the movement
   * probe actually measured from. On a same-day count that is staged_at; on a
   * BACKDATED batch it is the start of the count date, which is the whole
   * point — see movedSince.
   */
  counted_as_of: string;
  /**
   * The count date is earlier than the day this line was typed in, so the
   * fence runs from the count date and RE-STAGING CANNOT CLEAR IT. The screen
   * must say that instead of offering a re-count that will not work.
   */
  backdated: boolean;
}

export interface CutoverPreview {
  batch: CutoverBatch;
  lines: PreviewLine[];
  summary: {
    counted_lines: number;
    variance_lines: number;
    zero_counts: number;
    net_variance_value: number;
    shortage_value: number;
    excess_value: number;
    /** Materials with NO line — these will be left completely untouched. */
    uncounted_materials: number;
    /** Lines that would block the commit right now. */
    blocked_lines: number;
    no_rate_lines: number;
  };
  /** True when commitBatch would succeed as things stand. */
  can_commit: boolean;
  blockers: string[];
}

export interface CommitResult {
  batch_id: string;
  cutover_date: string;
  committed_at: string;
  applied: number;
  variance_lines: number;
  net_variance_value: number;
  shortage_value: number;
  excess_value: number;
  /** settings.central_store_cutover_at as it stands AFTER the commit. A
   *  BUSINESS DATE at midnight ('YYYY-MM-DD 00:00:00'), never a clock reading. */
  cutover_at: string;
  /** The date half of the boundary — quote THIS on screen, never `cutover_at`,
   *  whose ' 00:00:00' tail is storage detail an operator should not read. */
  cutover_boundary_date: string;
  /** True when THIS commit wrote the stamp (the first committed cutover). */
  stamp_written: boolean;
}

// ── the count sheet ─────────────────────────────────────────────────────────

/**
 * Every material that belongs on a central count sheet.
 *
 * Store-mapped (liquor) materials are dropped and counted in the summary. The
 * activity flag is computed from four independent signals — a purchase, a
 * requisition line, an inventory transaction, or non-zero stock — so a material
 * that has ever been real anywhere shows up even if its stock reads 0 today.
 *
 * `draftBatchId` folds the open draft's staged quantities into the rows, so one
 * fetch drives the whole screen.
 */
export function listCutoverSheet(
  db: Database.Database,
  opts?: { draftBatchId?: string | null; includeInert?: boolean },
): CutoverSheet {
  const mats = db.prepare(`
    SELECT m.id, m.name, COALESCE(m.sku,'') AS sku, COALESCE(m.category,'') AS category,
           COALESCE(m.current_stock,0) AS current_stock,
           COALESCE(m.unit,'') AS unit, COALESCE(m.purchase_unit,'') AS purchase_unit,
           COALESCE(m.pack_size,1) AS pack_size, COALESCE(m.average_price,0) AS average_price,
           (
             COALESCE(m.current_stock,0) <> 0
             OR EXISTS (SELECT 1 FROM purchases p WHERE p.material_id = m.id)
             OR EXISTS (SELECT 1 FROM inventory_transactions it WHERE it.material_id = m.id)
             OR EXISTS (SELECT 1 FROM requisition_items ri WHERE ri.material_id = m.id)
           ) AS has_activity
      FROM raw_materials m
     WHERE COALESCE(m.is_active, 1) = 1
     ORDER BY m.name COLLATE NOCASE
  `).all() as Array<{
    id: string; name: string; sku: string; category: string; current_stock: number;
    unit: string; purchase_unit: string; pack_size: number; average_price: number;
    has_activity: number;
  }>;

  const staged = new Map<string, { qty: number; unit: string }>();
  if (opts?.draftBatchId) {
    const rows = db.prepare(
      'SELECT material_id, counted_qty, counted_unit FROM central_cutover_lines WHERE batch_id = ?',
    ).all(opts.draftBatchId) as Array<{ material_id: string; counted_qty: number; counted_unit: string }>;
    for (const r of rows) staged.set(r.material_id, { qty: Number(r.counted_qty), unit: r.counted_unit });
  }

  const rates = rateMap(db);
  const storeMapped = storeMappedIds(db);
  const rows: CutoverSheetRow[] = [];
  let storeExcluded = 0;
  let withActivity = 0;
  let bookValue = 0;

  for (const m of mats) {
    if (storeMapped.has(m.id)) { storeExcluded++; continue; }
    const active = !!Number(m.has_activity);
    if (active) withActivity++;
    if (!active && !opts?.includeInert) continue;

    const valued = valueCount(db, m, Number(m.current_stock) || 0, rates.get(m.id) ?? null);
    bookValue += valued.totalValue;
    const s = staged.get(m.id);
    rows.push({
      material_id: m.id,
      name: m.name,
      sku: m.sku,
      category: m.category,
      book_qty: r6(m.current_stock),
      book_qty_purchase: toPurchaseQty(Number(m.current_stock) || 0, m as PackMeta),
      unit: m.unit,
      purchase_unit: m.purchase_unit || m.unit,
      pack_factor: packFactor(m as PackMeta),
      unit_value: valued.ratePerPurchaseUnit,
      rate_source: valued.source,
      book_value: valued.totalValue,
      has_activity: active,
      staged: !!s,
      staged_qty: s ? s.qty : null,
      staged_unit: s ? s.unit : '',
    });
  }

  const central = mats.length - storeExcluded;
  return {
    rows,
    summary: {
      total_materials: mats.length,
      store_excluded: storeExcluded,
      central_materials: central,
      with_activity: withActivity,
      inert: central - withActivity,
      book_value: r2(bookValue),
      store_excluded_reason:
        storeExcluded + ' store-mapped material(s) are excluded: liquor is counted on the TGBCL store ledger '
        + '(Inventory -> Liquor Store -> Record Closing Stock), not here. The rule matches a material CATEGORY '
        + 'against the store map, so a bottle filed under a non-liquor category will still appear on this sheet — '
        + 're-categorise it before counting rather than counting it twice.',
    },
  };
}

// ── batches ─────────────────────────────────────────────────────────────────

const BATCH_COLS = `id, cutover_date, status, note, created_by, created_at,
  committed_by, committed_at, cancelled_by, cancelled_at,
  counted_lines, variance_lines, net_variance_value, shortage_value, excess_value, stamped`;

export function getBatch(db: Database.Database, batchId: string): CutoverBatch | null {
  const row = db.prepare('SELECT ' + BATCH_COLS + ' FROM central_cutover_batches WHERE id = ?')
    .get(batchId) as CutoverBatch | undefined;
  return row ?? null;
}

export function listBatches(db: Database.Database, limit = 50): CutoverBatch[] {
  return db.prepare(
    'SELECT ' + BATCH_COLS + ' FROM central_cutover_batches ORDER BY created_at DESC LIMIT ?',
  ).all(limit) as CutoverBatch[];
}

/** The open draft, if there is one. At most one draft is expected at a time;
 *  the newest wins so a stale abandoned draft can never hide a fresh one. */
export function getOpenDraft(db: Database.Database): CutoverBatch | null {
  const row = db.prepare(
    'SELECT ' + BATCH_COLS + " FROM central_cutover_batches WHERE status = 'draft' ORDER BY created_at DESC LIMIT 1",
  ).get() as CutoverBatch | undefined;
  return row ?? null;
}

/**
 * Open a draft batch. Nothing is applied until commitBatch.
 *
 * cutover_date is the day the shelf was PHYSICALLY COUNTED. It may not be in
 * the future (a count cannot be taken tomorrow) and it may not predate an
 * existing stamp (the book has already been declared true from that date;
 * re-basing it from an earlier count would reopen a window that was closed).
 */
export function createBatch(
  db: Database.Database,
  input: { cutover_date?: string | null; note?: string | null; actor?: string | null },
): CutoverBatch {
  const today = istToday(db);
  const date = norm(input.cutover_date) ? norm(input.cutover_date).slice(0, 10) : today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new CutoverError('FUTURE_DATE', 'cutover_date must be YYYY-MM-DD');
  }
  if (date > today) {
    throw new CutoverError(
      'FUTURE_DATE',
      'The count date ' + date + ' is in the future (today is ' + today + ' IST) — a physical count cannot be dated ahead.',
    );
  }
  const stampDate = getCentralStoreCutoverDate(db);
  if (stampDate && date < stampDate) {
    throw new CutoverError(
      'CUTOVER_BEFORE_STAMP',
      'The central store was cut over on ' + stampDate + '; a later cutover cannot be dated before it (' + date + ').',
      { cutover_at: getCentralStoreCutoverAt(db) },
    );
  }
  const id = generateId();
  db.prepare(`
    INSERT INTO central_cutover_batches (id, cutover_date, status, note, created_by)
    VALUES (?, ?, 'draft', ?, ?)
  `).run(id, date, norm(input.note), norm(input.actor));
  return getBatch(db, id)!;
}

/** Abandon a draft. Committed batches are permanent records and are refused. */
export function cancelBatch(db: Database.Database, batchId: string, actor?: string | null): CutoverBatch {
  const b = getBatch(db, batchId);
  if (!b) throw new CutoverError('UNKNOWN_BATCH', 'No such cutover batch');
  if (b.status !== 'draft') {
    throw new CutoverError('NOT_DRAFT', 'This cutover is already ' + b.status + ' — it cannot be cancelled.');
  }
  db.prepare(`
    UPDATE central_cutover_batches
       SET status = 'cancelled', cancelled_by = ?, cancelled_at = datetime('now')
     WHERE id = ? AND status = 'draft'
  `).run(norm(actor), batchId);
  return getBatch(db, batchId)!;
}

// ── staging ─────────────────────────────────────────────────────────────────

/**
 * Read a typed count. THE ONE PLACE a blank is distinguished from a zero.
 *
 * Never `Number(v) || 0`: that idiom turns '', null, undefined, ' ' and 'abc'
 * all into 0, which on this screen means "the shelf is empty" and would wipe a
 * material's stock because a cell was left alone. Every non-number is refused
 * by name and reported back to the operator.
 *
 * A negative count is refused too, not clamped — you cannot physically hold
 * minus 3 kg, so a minus sign is a typo, and clamping it to 0 would silently
 * empty the shelf.
 */
export function parseCountedQty(v: unknown):
  | { ok: true; qty: number }
  | { ok: false; reason: 'blank' | 'not_a_number' | 'negative'; detail: string } {
  if (v === null || v === undefined) {
    return { ok: false, reason: 'blank', detail: 'no quantity was entered — a blank is not a zero, so nothing was staged' };
  }
  if (typeof v === 'boolean') {
    return { ok: false, reason: 'not_a_number', detail: 'expected a number, got ' + String(v) };
  }
  let n: number;
  if (typeof v === 'number') {
    n = v;
  } else {
    // Strip thousands separators a spreadsheet export may have baked in
    // ("1,250"), but nothing else — a stray unit suffix must still fail loudly.
    const s = String(v).trim().replace(/,/g, '');
    if (s === '') {
      return { ok: false, reason: 'blank', detail: 'the cell is empty — a blank is not a zero, so nothing was staged' };
    }
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) {
      return { ok: false, reason: 'not_a_number', detail: '"' + String(v) + '" is not a number' };
    }
    n = Number(s);
  }
  if (!Number.isFinite(n)) {
    return { ok: false, reason: 'not_a_number', detail: '"' + String(v) + '" is not a finite number' };
  }
  if (n < 0) {
    return { ok: false, reason: 'negative', detail: 'a physical count cannot be negative (' + n + ')' };
  }
  return { ok: true, qty: r6(n) };
}

/**
 * Resolve which unit a typed quantity is in, and convert to recipe units.
 *
 * packFactor() carries the BOTH-HALVES guard (pack_size > 1 AND recipe unit
 * differs from purchase unit), so PICKLED GINGER 1.5KG — unit kg, purchase_unit
 * kg, pack_size 1.5 — converts x1 and is not inflated by half.
 *
 * The unit is REQUIRED whenever a real factor exists and guessing is REFUSED.
 * Purchase and inventory screens lead with the purchase unit, so a bare number
 * is genuinely ambiguous on exactly those materials, and the wrong guess on a
 * 1,000 g/kg pack is a 1,000x error that lands invisibly.
 *
 * ── THE ONE SHAPE THE HOUSE RULE CANNOT HONOUR, AND WHY IT IS REFUSED ──────
 * packFactor()'s both-halves guard is `pack_size > 1 && recipe unit differs`.
 * Read literally, that pins the factor to 1 for a material whose two unit
 * strings differ while pack_size sits strictly BETWEEN 0 and 1 — the inverted
 * shape, where the purchase unit is SMALLER than the recipe unit (unit 'kg',
 * purchase_unit 'g', pack_size 0.001). The count sheet still offers the
 * purchase unit, so a figure typed in grams would be written to current_stock
 * as kilograms: a 1,000x error, in the one flow that SETS the book rather than
 * displaying it.
 *
 * The rule is not bent for it — bending it is how PICKLED GINGER (kg/kg,
 * pack_size 1.5) got divided by 1.5, and every other consumer of packFactor
 * would still disagree with whatever this one function decided. Instead the
 * line is REFUSED, in the idiom this module already uses for a count it cannot
 * read honestly (parseCountedQty on a blank, unit_required on an ambiguous
 * one). Counting in the RECIPE unit is still accepted, because that needs no
 * conversion at all and is exactly what current_stock holds.
 *
 * MEASURED on a copy of the live database (2026-08-12, 952 materials): ZERO
 * rows have 0 < pack_size < 1, and zero have a NULL/0 pack_size with differing
 * units. The 14 active rows with differing units and pack_size <= 1 all have
 * pack_size EXACTLY 1 (e.g. BUDWEISER 330ML, unit 'pcs', purchase_unit 'BTL'),
 * and for those the x1 conversion is CORRECT, not unhonoured: pack_size 1
 * means one recipe unit per purchase unit, so 3 BTL genuinely is 3 pcs. All 14
 * are store-mapped besides, so they are dropped from the count sheet and
 * refused at staging and at commit. This guard therefore changes nothing on
 * today's data; it closes the hole one bad pack_size edit would open.
 * NULL / 0 pack_size is NOT caught here: COALESCE(pack_size, 1) is the house
 * default everywhere in this codebase, so absent means 1, not "unknown".
 */
export function resolveCountBasis(
  m: PackMeta & { unit?: string | null; purchase_unit?: string | null },
  qty: number,
  givenUnit?: string | null,
):
  | { ok: true; basis: 'purchase' | 'recipe'; unit: string; packFactor: number; recipeQty: number }
  | { ok: false; reason: 'unit_required' | 'unknown_unit' | 'unconvertible_unit'; detail: string } {
  const pf = packFactor(m);
  const ru = normUnit(m.unit);
  const pu = normUnit(m.purchase_unit || m.unit);
  const given = normUnit(givenUnit);

  // A declared factor the both-halves guard pins to 1. Refuse anything except
  // an explicit recipe-unit count, which needs no factor.
  const declared = Number(m.pack_size);
  if (ru !== pu && Number.isFinite(declared) && declared > 0 && declared < 1 && given !== ru) {
    return {
      ok: false,
      reason: 'unconvertible_unit',
      detail: "this material says 1 " + (m.purchase_unit || '') + ' = ' + declared + ' ' + (m.unit || '')
        + ", and a pack size below 1 is not applied anywhere in this app — a count in '"
        + (m.purchase_unit || '') + "' would be written to stock unconverted. Fix the pack size on the "
        + "material (Unit Audit) before counting it, or enter the count in '" + (m.unit || '') + "'",
    };
  }

  if (!given) {
    if (pf > 1) {
      return {
        ok: false,
        reason: 'unit_required',
        detail: '1 ' + (m.purchase_unit || '') + ' = ' + pf + ' ' + (m.unit || '')
          + " — say which unit the count is in ('" + (m.unit || '') + "' or '" + (m.purchase_unit || '') + "')",
      };
    }
    // One basis only; there is nothing to guess. Report it as recipe because
    // that is the column current_stock lives in.
    return { ok: true, basis: 'recipe', unit: String(m.unit || ''), packFactor: pf, recipeQty: r6(qty) };
  }
  // Purchase first: when the two strings are equal the factor is 1 either way,
  // and labelling it 'purchase' matches what the operator actually typed.
  if (given === pu) {
    return { ok: true, basis: 'purchase', unit: String(m.purchase_unit || m.unit || ''), packFactor: pf, recipeQty: r6(qty * pf) };
  }
  if (given === ru) {
    return { ok: true, basis: 'recipe', unit: String(m.unit || ''), packFactor: pf, recipeQty: r6(qty) };
  }
  return {
    ok: false,
    reason: 'unknown_unit',
    detail: "'" + String(givenUnit) + "' is neither the recipe unit ('" + (m.unit || '')
      + "') nor the purchase unit ('" + (m.purchase_unit || m.unit || '') + "')",
  };
}

/**
 * Stage counted lines onto a DRAFT batch, from a CSV or from the form.
 *
 * Per-line refusals are REPORTED, never fatal: a 700-row sheet must not be
 * thrown away because six cells are unreadable. Nothing here touches stock.
 *
 * ── A RE-SEND IS NOT A RE-COUNT ────────────────────────────────────────────
 * staged_at is the instant the commit's movement fence measures from, so
 * whatever refreshes it can clear a MOVED_SINCE_COUNT / PACK_FACTOR_CHANGED
 * refusal. Refreshing it on EVERY re-stage made the refusal advisory: it names
 * the fix as "re-count these materials, stage them again", and uploading the
 * identical sheet a second time — the first thing anyone does after a rejected
 * commit — satisfied that literally, for all 700 lines at once, with no shelf
 * revisited and nothing distinguishing it from a genuine re-count.
 *
 * So a line's count instant now moves ONLY on evidence:
 *   · THE TYPED FIGURE CHANGED (quantity or unit). Self-evidently a new
 *     observation.
 *   · recount: true — an explicit human assertion that the shelf was just
 *     looked at again and still reads the same. The UI attaches this to a
 *     dedicated per-line action, never to a bulk save.
 * Anything else leaves counted_qty, pack_factor, book_qty_at_stage AND
 * staged_at exactly as they were and is reported as `unchanged`. The note is
 * still updated: a comment is not a count.
 *
 * A BACKDATED batch's fence cannot be cleared by either route, because it runs
 * from the count date rather than from staged_at. That is deliberate — see
 * movedSince.
 */
export function stageLines(
  db: Database.Database,
  batchId: string,
  lines: StageLineInput[],
): StageResult {
  const batch = getBatch(db, batchId);
  if (!batch) throw new CutoverError('UNKNOWN_BATCH', 'No such cutover batch');
  if (batch.status !== 'draft') {
    throw new CutoverError('NOT_DRAFT', 'This cutover is ' + batch.status + ' — its counts can no longer be edited.');
  }

  const mats = db.prepare(`
    SELECT id, sku, name, COALESCE(unit,'') AS unit, COALESCE(purchase_unit,'') AS purchase_unit,
           COALESCE(pack_size,1) AS pack_size, COALESCE(current_stock,0) AS current_stock
      FROM raw_materials
  `).all() as Array<{ id: string; sku: string | null; name: string; unit: string; purchase_unit: string; pack_size: number; current_stock: number }>;
  const byId = new Map(mats.map((m) => [m.id, m]));
  const bySku = new Map<string, typeof mats[number]>();
  const byName = new Map<string, typeof mats[number]>();
  for (const m of mats) {
    if (m.sku) bySku.set(String(m.sku).toLowerCase().trim(), m);
    byName.set(String(m.name).toLowerCase().trim(), m);
  }

  // The staged figure, not just the id: the "is this actually a new count?"
  // test below compares against what is already on the row.
  const existing = new Map<string, { qty: number; unit: string }>(
    (db.prepare(
      'SELECT material_id, counted_qty, counted_unit FROM central_cutover_lines WHERE batch_id = ?',
    ).all(batchId) as Array<{ material_id: string; counted_qty: number; counted_unit: string }>)
      .map((r) => [r.material_id, { qty: r6(Number(r.counted_qty) || 0), unit: normUnit(r.counted_unit) }]),
  );

  const ins = db.prepare(`
    INSERT INTO central_cutover_lines
      (id, batch_id, material_id, material_name, counted_qty, counted_unit, counted_basis,
       pack_factor, counted_qty_recipe, book_qty_at_stage, staged_at, recipe_unit, purchase_unit, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?)
  `);
  const upd = db.prepare(`
    UPDATE central_cutover_lines
       SET counted_qty = ?, counted_unit = ?, counted_basis = ?, pack_factor = ?,
           counted_qty_recipe = ?, book_qty_at_stage = ?, staged_at = datetime('now'),
           material_name = ?, recipe_unit = ?, purchase_unit = ?, note = ?
     WHERE batch_id = ? AND material_id = ?
  `);
  // The same figure arriving again. Everything the fence depends on —
  // counted_qty, pack_factor, book_qty_at_stage, staged_at — is deliberately
  // absent from this statement. Only the note and the display labels move.
  const touch = db.prepare(`
    UPDATE central_cutover_lines
       SET material_name = ?, recipe_unit = ?, purchase_unit = ?, note = ?
     WHERE batch_id = ? AND material_id = ?
  `);

  const rejected: StageRejection[] = [];
  const store_blocked: StageResult['store_blocked'] = [];
  let accepted = 0;
  let updated = 0;
  let unchanged = 0;

  const run = db.transaction(() => {
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i] || {};
      const rowNo = i + 1;

      const idKey = norm(raw.material_id);
      const skuKey = norm(raw.sku).toLowerCase();
      const nameKey = norm(raw.name).toLowerCase();
      const m = (idKey && byId.get(idKey))
        || (skuKey && bySku.get(skuKey))
        || (nameKey && byName.get(nameKey))
        || null;

      if (!m) {
        // A fully blank template row is not an error — skip it silently. Any
        // row carrying an identifier OR a quantity is a real attempt and is
        // reported, so a typo'd name can never be mistaken for an empty row.
        const q = raw.counted_qty;
        const hasQty = !(q === null || q === undefined || String(q).trim() === '');
        if (!idKey && !skuKey && !nameKey && !hasQty) continue;
        rejected.push({
          row: rowNo, material_id: idKey, name: norm(raw.name),
          reason: 'unknown_material',
          detail: 'no material matches id/sku/name (sku="' + norm(raw.sku) + '" name="' + norm(raw.name) + '")',
        });
        continue;
      }

      const blocked = centralFlowBlock(db, m.id);
      if (blocked) {
        store_blocked.push({ row: rowNo, material_id: m.id, name: m.name, error: blocked });
        continue;
      }

      const parsed = parseCountedQty(raw.counted_qty);
      if (!parsed.ok) {
        rejected.push({ row: rowNo, material_id: m.id, name: m.name, reason: parsed.reason, detail: parsed.detail });
        continue;
      }

      const basis = resolveCountBasis(m, parsed.qty, raw.counted_unit);
      if (!basis.ok) {
        rejected.push({ row: rowNo, material_id: m.id, name: m.name, reason: basis.reason, detail: basis.detail });
        continue;
      }

      const prior = existing.get(m.id);
      if (prior) {
        // Is this a NEW observation, or the same sheet arriving twice? Only the
        // human's own two inputs count — the typed quantity and the unit it was
        // typed in. Everything else on the row is derived, and a derived value
        // moving (a pack factor re-based by /unit-audit) is a reason to keep the
        // refusal, not to clear it.
        const sameFigure = Math.abs(prior.qty - parsed.qty) <= EPS && prior.unit === normUnit(basis.unit);
        if (sameFigure && raw.recount !== true) {
          touch.run(m.name, m.unit, m.purchase_unit || m.unit, norm(raw.note), batchId, m.id);
          unchanged++;
        } else {
          upd.run(
            parsed.qty, basis.unit, basis.basis, basis.packFactor, basis.recipeQty,
            r6(m.current_stock), m.name, m.unit, m.purchase_unit || m.unit, norm(raw.note),
            batchId, m.id,
          );
          existing.set(m.id, { qty: parsed.qty, unit: normUnit(basis.unit) });
          updated++;
        }
      } else {
        ins.run(
          generateId(), batchId, m.id, m.name, parsed.qty, basis.unit, basis.basis,
          basis.packFactor, basis.recipeQty, r6(m.current_stock), m.unit, m.purchase_unit || m.unit, norm(raw.note),
        );
        existing.set(m.id, { qty: parsed.qty, unit: normUnit(basis.unit) });
        accepted++;
      }
    }
  });
  run();

  return { accepted, updated, unchanged, rejected, store_blocked };
}

/** Drop one staged count. Returns false when there was nothing to drop. */
export function removeLine(db: Database.Database, batchId: string, materialId: string): boolean {
  const batch = getBatch(db, batchId);
  if (!batch) throw new CutoverError('UNKNOWN_BATCH', 'No such cutover batch');
  if (batch.status !== 'draft') {
    throw new CutoverError('NOT_DRAFT', 'This cutover is ' + batch.status + ' — its counts can no longer be edited.');
  }
  const res = db.prepare('DELETE FROM central_cutover_lines WHERE batch_id = ? AND material_id = ?')
    .run(batchId, materialId);
  return res.changes > 0;
}

export function listLines(db: Database.Database, batchId: string): CutoverLine[] {
  return db.prepare(
    'SELECT * FROM central_cutover_lines WHERE batch_id = ? ORDER BY material_name COLLATE NOCASE',
  ).all(batchId) as CutoverLine[];
}

// ── movement probe ──────────────────────────────────────────────────────────

/**
 * Has this material actually MOVED since its line was staged?
 *
 * WHY IT MATTERS. The commit SETS current_stock. If an issue or a purchase
 * lands between the count and the commit, an absolute set erases it — the exact
 * bug variance-approval.ts:14-22 was written to kill (count at 10am, issue at
 * noon, submit at 4pm, and the noon issue is gone from central while the
 * department still physically holds the goods).
 *
 * TWO SIGNALS, AND ONLY ONE OF THEM IS A MOVEMENT ON ITS OWN:
 *
 *   ledgerRows  — an inventory_transactions or purchases row created after
 *                 staged_at. A recorded movement. ALWAYS blocks.
 *   recordTouched — raw_materials.updated_at advanced past staged_at. This is
 *                 NOT a movement by itself: PUT /api/inventory bumps updated_at
 *                 for a pure metadata edit (rename, reorder level, brand, tax
 *                 %) while leaving current_stock alone. Blocking on it would
 *                 refuse a 700-line cutover because somebody fixed a spelling,
 *                 and would tell the operator the material "moved" — untrue,
 *                 and it sends them to re-count a shelf that never changed.
 *                 So it blocks only together with stockChanged.
 *   stockChanged — current_stock now differs from what it was when the line was
 *                 staged. This is the direct observation, and it blocks even if
 *                 no row was written anywhere (a hand-edited database).
 *
 * BLOCKING = ledgerRows > 0 OR stockChanged. That covers every business writer:
 * of the 39 `SET current_stock` sites in src/, every real one either writes an
 * inventory_transactions row in the same transaction or changes the number that
 * stockChanged compares. A net-zero round trip (+5 then −5) leaves stockChanged
 * false but still writes two ledger rows, so it is caught by the first signal.
 * NOT covered: /unit-audit's rescale — caught separately by the pack-factor
 * check, because a rescale is a pack-factor change by definition.
 *
 * ── WHERE THE WINDOW STARTS, AND WHY IT IS NOT ALWAYS staged_at ────────────
 * A count speaks for the moment the SHELF WAS LOOKED AT, which is only the same
 * thing as staged_at when the sheet is typed in on the day it was counted.
 *
 * Measured on a copy of this database: open a draft dated 20 days ago, stage a
 * material today, and a 30 kg purchase recorded in between is INVISIBLE to a
 * probe anchored on staged_at — the commit SETs the book to a figure taken
 * before that crate arrived and the 30 kg is gone, with no transaction row
 * behind its disappearance and no way to reconstruct it. That is the single
 * most likely operator mistake this module can make (typing up a sheet days
 * later is the normal way a 700-line count gets entered) and it was unguarded.
 *
 * So the window starts at:
 *   · staged_at                     when the count date IS the day the line was
 *                                   staged. Same-day: staged_at is a genuinely
 *                                   better anchor than midnight, and anchoring
 *                                   at midnight would refuse every cutover run
 *                                   on a day that had a single morning purchase.
 *   · IST START OF THE COUNT DATE   when the batch is BACKDATED. Everything
 *                                   recorded from that day on is movement the
 *                                   count cannot have seen.
 * istDayStartUtc() converts, because the count date is an IST business date and
 * created_at is UTC — 'D 00:00:00' read as UTC would miss the 00:00–05:30 IST
 * window on day D entirely.
 *
 * A BACKDATED FENCE CANNOT BE CLEARED BY RE-STAGING, and that is correct rather
 * than unhelpful: re-counting a shelf today does not make a count dated the
 * 23rd true. The honest fixes are to drop that line, or to cancel the draft and
 * open one dated today. Both refusals say so in those words.
 */
interface MovementProbe {
  /** Recorded movement rows created after the count. */
  ledgerRows: number;
  /** current_stock differs from the figure captured at staging. */
  stockChanged: boolean;
  /** updated_at advanced — may be nothing more than a rename. */
  recordTouched: boolean;
  bookNow: number;
  /** The commit refuses this line. */
  blocking: boolean;
  /** The lower bound actually used. Quoted in the refusal so it is checkable. */
  countedAsOf: string;
  /** The window starts at the count date, not at staging. Re-staging is futile. */
  backdated: boolean;
}

function movedSince(
  db: Database.Database,
  materialId: string,
  stagedAt: string,
  bookAtStage: number,
  cutoverDate: string,
): MovementProbe {
  const bookNow = r6(
    Number((db.prepare('SELECT COALESCE(current_stock,0) q FROM raw_materials WHERE id = ?')
      .get(materialId) as { q: number } | undefined)?.q ?? 0),
  );
  const stockChanged = Math.abs(bookNow - r6(bookAtStage)) > EPS;
  const stagedTs = normTs(stagedAt);

  // BACKDATED = the count date is earlier than the IST day the line was typed
  // in. Strictly earlier: a count dated today and staged today is the ordinary
  // same-day run and keeps staged_at, which is both tighter and truer.
  const stagedIstDay = istDateOfUtc(stagedTs);
  const cutDay = String(cutoverDate ?? '').trim().slice(0, 10);
  const dayStart = istDayStartUtc(cutDay);
  const backdated = !!(dayStart && stagedIstDay && cutDay < stagedIstDay);
  // With no usable staged_at the count date is the ONLY bound available, and
  // falling back to "no bound at all" is what let the backdated case through.
  const at = backdated || !stagedTs ? dayStart : stagedTs;

  if (!at) {
    return {
      ledgerRows: 0, stockChanged, recordTouched: false, bookNow,
      blocking: stockChanged, countedAsOf: '', backdated,
    };
  }
  const row = db.prepare(`
    SELECT
      (
        (SELECT COUNT(*) FROM inventory_transactions it
          WHERE it.material_id = ? AND ${TS_SQL('it.created_at')} > ?)
        + (SELECT COUNT(*) FROM purchases p
          WHERE p.material_id = ? AND ${TS_SQL('p.created_at')} > ?)
      ) AS ledger_rows,
      (SELECT COUNT(*) FROM raw_materials m
        WHERE m.id = ? AND ${TS_SQL('m.updated_at')} > ?) AS record_touched
  `).get(materialId, at, materialId, at, materialId, at) as
    { ledger_rows: number; record_touched: number } | undefined;

  const ledgerRows = Number(row?.ledger_rows) || 0;
  return {
    ledgerRows,
    stockChanged,
    recordTouched: (Number(row?.record_touched) || 0) > 0,
    bookNow,
    blocking: ledgerRows > 0 || stockChanged,
    countedAsOf: at,
    backdated,
  };
}

// ── preview ─────────────────────────────────────────────────────────────────

/**
 * The whole batch as it would land: book vs counted vs difference vs rupees,
 * per line, plus every condition that would block the commit.
 *
 * book_qty_recipe here is LIVE current_stock, read now. The value recorded is
 * snapshotted again inside the commit transaction, so a preview and a commit
 * taken minutes apart can legitimately differ — and when they do, the
 * moved_since_stage flag on the line is what explains it.
 */
export function previewBatch(db: Database.Database, batchId: string): CutoverPreview {
  const batch = getBatch(db, batchId);
  if (!batch) throw new CutoverError('UNKNOWN_BATCH', 'No such cutover batch');

  const lines = listLines(db, batchId);
  const rates = rateMap(db);
  const storeMappedSet = storeMappedIds(db);

  const out: PreviewLine[] = [];
  let varianceLines = 0;
  let zeroCounts = 0;
  let net = 0;
  let shortage = 0;
  let excess = 0;
  let blocked = 0;
  let noRate = 0;
  let gone = 0;

  for (const ln of lines) {
    const m = db.prepare(`
      SELECT id, name, COALESCE(unit,'') AS unit, COALESCE(purchase_unit,'') AS purchase_unit,
             COALESCE(pack_size,1) AS pack_size, COALESCE(current_stock,0) AS current_stock,
             COALESCE(average_price,0) AS average_price
        FROM raw_materials WHERE id = ?
    `).get(ln.material_id) as any;

    // A material deleted after staging: report it as a blocker rather than
    // dropping the line, so the count is not silently lost.
    //
    // NOTHING BOOK-DERIVED IS EMITTED AS A NUMBER HERE. There is no
    // raw_materials row, so the book, the difference and the rupee value are
    // not zero — they are UNKNOWN, and every one of them ships as null.
    // Emitting 0 was actively misleading twice over on the review screen: the
    // page prefers the server's purchase figure whenever it is a number, and 0
    // is a number, so a line somebody genuinely counted printed 0; and a
    // variance of 0 satisfied the "counted equals book" test, so a deleted
    // material was badged "matches".
    //
    // The COUNTED figure is not unknown and is not withheld: it is the human's
    // own measurement. Its purchase-basis form is derived from the units and
    // pack factor FROZEN on the line at staging — the same three values the
    // screen would fall back to — so it stays a real number.
    if (!m) {
      blocked++;
      gone++;
      const frozen: PackMeta = {
        unit: ln.recipe_unit,
        purchase_unit: ln.purchase_unit || ln.recipe_unit,
        pack_size: Number(ln.pack_factor) || 1,
      };
      out.push({
        material_id: ln.material_id, name: ln.material_name,
        counted_qty: ln.counted_qty, counted_unit: ln.counted_unit,
        counted_basis: ln.counted_basis, pack_factor: ln.pack_factor,
        counted_qty_recipe: ln.counted_qty_recipe,
        book_qty_recipe: null, variance_recipe: null,
        counted_qty_purchase: toPurchaseQty(ln.counted_qty_recipe, frozen),
        book_qty_purchase: null, variance_purchase: null,
        unit: ln.recipe_unit, purchase_unit: ln.purchase_unit,
        unit_value: null, rate_source: 'none', variance_value: null,
        will_alert: false, blocked: true, moved_since_stage: 0, stock_changed: false,
        record_edited: false, pack_factor_changed: false,
        now_store_mapped: false, material_missing: true, staged_at: ln.staged_at,
        counted_as_of: ln.staged_at, backdated: false,
      });
      continue;
    }

    const book = r6(m.current_stock);
    const variance = r6(ln.counted_qty_recipe - book);
    const valued = valueCount(db, m, variance, rates.get(m.id) ?? null);
    const rate = materialRate(db, m, rates.get(m.id) ?? null);
    const isVariance = Math.abs(variance) > EPS;

    const pfNow = packFactor(m as PackMeta);
    const pfChanged = Math.abs(pfNow - (Number(ln.pack_factor) || 1)) > EPS;
    const moved = movedSince(db, m.id, ln.staged_at, Number(ln.book_qty_at_stage) || 0, batch.cutover_date);
    const storeMapped = storeMappedSet.has(m.id);
    const lineBlocked = moved.blocking || pfChanged || storeMapped;

    if (isVariance) {
      varianceLines++;
      net += valued.totalValue;
      if (variance < 0) shortage += Math.abs(valued.totalValue);
      else excess += valued.totalValue;
    }
    if (Math.abs(ln.counted_qty_recipe) <= EPS) zeroCounts++;
    if (rate.source === 'none') noRate++;
    if (lineBlocked) blocked++;

    out.push({
      material_id: m.id,
      name: m.name,
      counted_qty: ln.counted_qty,
      counted_unit: ln.counted_unit,
      counted_basis: ln.counted_basis,
      pack_factor: pfNow,
      counted_qty_recipe: ln.counted_qty_recipe,
      book_qty_recipe: book,
      variance_recipe: variance,
      counted_qty_purchase: toPurchaseQty(ln.counted_qty_recipe, m as PackMeta),
      book_qty_purchase: toPurchaseQty(book, m as PackMeta),
      variance_purchase: toPurchaseQty(variance, m as PackMeta),
      unit: m.unit,
      purchase_unit: m.purchase_unit || m.unit,
      unit_value: rate.ratePerPurchaseUnit,
      rate_source: rate.source,
      variance_value: valued.totalValue,
      will_alert: isVariance,
      blocked: lineBlocked,
      moved_since_stage: moved.ledgerRows,
      stock_changed: moved.stockChanged,
      record_edited: moved.recordTouched,
      pack_factor_changed: pfChanged,
      now_store_mapped: storeMapped,
      material_missing: false,
      staged_at: ln.staged_at,
      counted_as_of: moved.countedAsOf,
      backdated: moved.backdated,
    });
  }

  // Uncounted = every central material with no line. Stated plainly because it
  // is the number that reassures: those materials are left untouched.
  const activeIds = db.prepare(
    'SELECT id FROM raw_materials WHERE COALESCE(is_active,1) = 1',
  ).all() as Array<{ id: string }>;
  const centralCount = activeIds.filter((r) => !storeMappedSet.has(r.id)).length;

  const blockers: string[] = [];
  if (batch.status !== 'draft') blockers.push('This cutover is already ' + batch.status + '.');
  if (lines.length === 0) blockers.push('No counts have been entered yet.');
  // Split by WHICH fix actually works. One sentence covering both would send
  // the operator of a backdated batch round a loop that cannot terminate:
  // re-staging never clears a fence anchored on the count date.
  const movedLines = out.filter((l) => l.moved_since_stage > 0 || l.stock_changed);
  const movedFresh = movedLines.filter((l) => !l.backdated).length;
  const movedBack = movedLines.filter((l) => l.backdated).length;
  if (movedFresh > 0) {
    blockers.push(
      movedFresh + ' material(s) have moved since they were counted. Setting the book from a stale count would erase '
      + 'those movements — re-count just those materials and stage them again.',
    );
  }
  if (movedBack > 0) {
    blockers.push(
      movedBack + ' material(s) have movement recorded on or after ' + batch.cutover_date + ', the date this count '
      + 'is dated. RE-STAGING WILL NOT CLEAR THIS: a count dated ' + batch.cutover_date + ' cannot account for goods '
      + 'that arrived or left after it, however recently it was typed in. Either remove those lines (their stock is '
      + 'then left untouched) or cancel this draft and open one dated today.',
    );
  }
  const pfN = out.filter((l) => l.pack_factor_changed).length;
  if (pfN > 0) {
    blockers.push(pfN + ' material(s) had their pack size changed after they were counted (see Unit Audit) — re-enter those counts.');
  }
  const smN = out.filter((l) => l.now_store_mapped).length;
  if (smN > 0) blockers.push(smN + ' material(s) are now store-mapped (liquor) — remove those lines.');
  if (gone > 0) blockers.push(gone + ' counted material(s) no longer exist — remove those lines.');

  return {
    batch,
    lines: out,
    summary: {
      counted_lines: lines.length,
      variance_lines: varianceLines,
      zero_counts: zeroCounts,
      net_variance_value: r2(net),
      shortage_value: r2(shortage),
      excess_value: r2(excess),
      uncounted_materials: Math.max(0, centralCount - lines.length),
      blocked_lines: blocked,
      no_rate_lines: noRate,
    },
    can_commit: batch.status === 'draft' && lines.length > 0 && blocked === 0,
    blockers,
  };
}

// ── COMMIT ──────────────────────────────────────────────────────────────────

/**
 * Apply the batch. THE DANGEROUS PART — read the guarantees before editing.
 *
 *  a. SETS current_stock to the counted figure in RECIPE units. Not adds. The
 *     conversion from the typed unit happened at staging through packFactor's
 *     both-halves guard and is re-validated here.
 *  b. A MATERIAL WITH NO LINE IS NEVER TOUCHED. The write loop iterates lines,
 *     never materials, so "not counted" cannot become 0 by omission. A counted
 *     0 has a line and IS applied.
 *  c. book_qty_recipe is snapshotted INSIDE this transaction, immediately
 *     before the row is overwritten, so the recorded before-value is the one
 *     that was actually replaced. current_stock has no history of its own and
 *     is not reconstructible from inventory_transactions on this database —
 *     these rows are the only record of the pre-cutover book. Take a file
 *     backup (scripts/backup-db.sh) before running this for real.
 *  d. ONE transaction for the whole batch. Half a cutover is worse than none.
 *     Any refusal throws before a single row is written; a stock UPDATE that
 *     does not affect exactly one row throws too, so a recorded line can never
 *     exist without the stock move it claims.
 *  e. IDEMPOTENT: status is re-read INSIDE the transaction and anything other
 *     than 'draft' throws NOT_DRAFT, so a double-submit cannot apply twice.
 *  f. Stamps settings.central_store_cutover_at WITH THE BATCH'S COUNT DATE —
 *     once, ever. The count date, not the commit clock: the screen promises the
 *     operator that the boundary is the day the shelf was counted, and a commit
 *     typed at 01:00 IST would otherwise stamp the previous UTC day. A
 *     companion key, central_store_cutover_committed_at, carries the real UTC
 *     instant for the one question a date cannot answer. A later cutover is
 *     recorded but does not move the boundary (mirroring the department rail),
 *     because moving it forward would quietly un-gate the window in between.
 *  g. RULING 1: no purchases row, no inventory_transactions row, no call to
 *     updateMaterialPrice, no touch of average_price or last_purchase_price.
 *     The rupee columns are information. (An inventory_transactions row would
 *     NOT be inert here: analytics, inventory/priority and crm-analyst-data all
 *     filter on quantity < 0 with no type predicate, so a downward re-base
 *     would surface as consumption — which Ruling 1 forbids.)
 */
export function commitBatch(
  db: Database.Database,
  batchId: string,
  actor?: string | null,
): CommitResult {
  const pre = getBatch(db, batchId);
  if (!pre) throw new CutoverError('UNKNOWN_BATCH', 'No such cutover batch');
  if (pre.status !== 'draft') {
    throw new CutoverError(
      'NOT_DRAFT',
      'This cutover was already ' + pre.status
        + (pre.committed_at ? ' at ' + pre.committed_at : '') + ' — it cannot be applied again.',
      { status: pre.status, committed_at: pre.committed_at },
    );
  }

  const rates = rateMap(db);

  // The transaction RETURNS the result rather than assigning to an outer
  // variable: better-sqlite3 carries the callback's return type through, so the
  // caller gets a real CommitResult and there is no half-populated object to
  // read if the transaction rolls back.
  const run = db.transaction((): CommitResult => {
    // (e) idempotency — re-read the status inside the transaction. Two
    // simultaneous submits both passed the check above; only one gets here
    // first, and the second finds 'committed'.
    const batch = db.prepare("SELECT status, cutover_date FROM central_cutover_batches WHERE id = ?")
      .get(batchId) as { status: string; cutover_date: string } | undefined;
    if (!batch) throw new CutoverError('UNKNOWN_BATCH', 'No such cutover batch');
    if (batch.status !== 'draft') {
      throw new CutoverError('NOT_DRAFT', 'This cutover was already ' + batch.status + ' — it cannot be applied again.');
    }

    const lines = db.prepare(
      'SELECT * FROM central_cutover_lines WHERE batch_id = ? ORDER BY material_name COLLATE NOCASE',
    ).all(batchId) as CutoverLine[];
    if (lines.length === 0) {
      throw new CutoverError('NO_LINES', 'This cutover has no counts — nothing to apply.');
    }

    // ── refusals first, all of them, before a single write ────────────────
    const unknown: Array<{ material_id: string; name: string }> = [];
    const storeMapped: Array<{ material_id: string; name: string; error: string }> = [];
    const pfChanged: Array<{ material_id: string; name: string; staged: number; now: number }> = [];
    const moved: Array<{
      material_id: string; name: string; rows: number; staged_at: string;
      book_at_stage: number; book_now: number; counted_as_of: string; backdated: boolean;
    }> = [];

    const mats = new Map<string, any>();
    for (const ln of lines) {
      const m = db.prepare(`
        SELECT id, name, COALESCE(unit,'') AS unit, COALESCE(purchase_unit,'') AS purchase_unit,
               COALESCE(pack_size,1) AS pack_size, COALESCE(current_stock,0) AS current_stock,
               COALESCE(average_price,0) AS average_price
          FROM raw_materials WHERE id = ?
      `).get(ln.material_id) as any;
      if (!m) { unknown.push({ material_id: ln.material_id, name: ln.material_name }); continue; }
      mats.set(ln.material_id, m);

      const blockMsg = centralFlowBlock(db, m.id);
      if (blockMsg) { storeMapped.push({ material_id: m.id, name: m.name, error: blockMsg }); continue; }

      const pfNow = packFactor(m as PackMeta);
      if (Math.abs(pfNow - (Number(ln.pack_factor) || 1)) > EPS) {
        pfChanged.push({ material_id: m.id, name: m.name, staged: Number(ln.pack_factor) || 1, now: pfNow });
        continue;
      }

      const probe = movedSince(db, m.id, ln.staged_at, Number(ln.book_qty_at_stage) || 0, batch.cutover_date);
      if (probe.blocking) {
        moved.push({
          material_id: m.id, name: m.name, rows: probe.ledgerRows, staged_at: ln.staged_at,
          book_at_stage: r6(Number(ln.book_qty_at_stage) || 0), book_now: probe.bookNow,
          counted_as_of: probe.countedAsOf, backdated: probe.backdated,
        });
      }
    }

    if (unknown.length) {
      throw new CutoverError(
        'UNKNOWN_MATERIAL',
        unknown.length + ' counted material(s) no longer exist. Remove those lines and apply again.',
        unknown,
      );
    }
    if (storeMapped.length) {
      throw new CutoverError(
        'STORE_MAPPED_MATERIAL',
        storeMapped.length + ' line(s) are store-mapped (liquor) materials. Liquor is not central stock — it is counted on the '
          + 'TGBCL store ledger (Inventory -> Liquor Store -> Record Closing Stock). Remove these lines and apply again.',
        storeMapped,
      );
    }
    if (pfChanged.length) {
      throw new CutoverError(
        'PACK_FACTOR_CHANGED',
        pfChanged.length + ' material(s) had their pack size changed after they were counted, so the typed quantity no longer '
          + 'converts to the same figure. Re-enter those counts and apply again. (Finish Unit Audit before a cutover, never after.)',
        pfChanged,
      );
    }
    if (moved.length) {
      // The instruction has to match the fence that produced the refusal. On a
      // BACKDATED batch the window runs from the count date, so "re-count and
      // stage again" is not merely unhelpful, it is false — staged_at moves and
      // the refusal comes straight back.
      const backdatedN = moved.filter((m) => m.backdated).length;
      throw new CutoverError(
        'MOVED_SINCE_COUNT',
        moved.length + ' material(s) have moved since they were counted. Setting the book from a stale count would erase those '
          + 'movements — the goods would leave central while the department still physically holds them. '
          + (backdatedN > 0
            ? backdatedN + ' of them have movement recorded on or after ' + batch.cutover_date + ', the date this count is '
              + 'dated, and RE-STAGING WILL NOT CLEAR THAT: a count dated ' + batch.cutover_date + ' cannot account for goods '
              + 'that moved after it. Remove those lines, or cancel this draft and open one dated today. '
            : '')
          + (moved.length - backdatedN > 0
            ? 'Re-count the rest, stage them again, and apply.'
            : ''),
        moved,
      );
    }

    // ── the write ─────────────────────────────────────────────────────────
    const setStock = db.prepare(
      "UPDATE raw_materials SET current_stock = ?, updated_at = datetime('now') WHERE id = ?",
    );
    const updLine = db.prepare(`
      UPDATE central_cutover_lines
         SET book_qty_recipe = ?, variance_recipe = ?, unit_value = ?, rate_source = ?,
             variance_value = ?, alert = ?, recipe_unit = ?, purchase_unit = ?, material_name = ?
       WHERE id = ?
    `);

    let applied = 0;
    let varianceLines = 0;
    let net = 0;
    let shortage = 0;
    let excess = 0;

    for (const ln of lines) {
      const m = mats.get(ln.material_id);

      // (c) SNAPSHOT INSIDE THE TRANSACTION, immediately before the overwrite.
      // Re-read rather than trusting the row fetched during validation, so the
      // recorded before-value is unambiguously the one replaced.
      const beforeRow = db.prepare('SELECT COALESCE(current_stock,0) AS q FROM raw_materials WHERE id = ?')
        .get(ln.material_id) as { q: number } | undefined;
      if (!beforeRow) {
        throw new CutoverError('WRITE_FAILED', 'Material ' + ln.material_name + ' vanished mid-commit — nothing was applied.');
      }
      const before = r6(beforeRow.q);
      const after = r6(ln.counted_qty_recipe);

      // (a) SET, never add. NO FLOOR AT ZERO and no clamp: a counted 0 is a
      // real 0, and clamping would invent stock that is not on the shelf.
      const res = setStock.run(after, ln.material_id);
      if (res.changes !== 1) {
        // Belt and braces after the existence check above — a stock row that
        // does not move must never leave a cutover line claiming it did.
        throw new CutoverError(
          'WRITE_FAILED',
          'Stock write for ' + ln.material_name + ' affected ' + res.changes + ' rows — the whole cutover was rolled back.',
        );
      }

      const variance = r6(after - before);
      const rate = materialRate(db, m, rates.get(ln.material_id) ?? null);
      const valued = valueCount(db, m, variance, rates.get(ln.material_id) ?? null);
      const isVariance = Math.abs(variance) > EPS;

      // (i) THE ALERT RECORD — one per line whose counted figure differs from
      // the book. Nothing is aggregated away; the bell gets one notification
      // for the batch (see unreviewedAlertBatches).
      updLine.run(
        before, variance, rate.ratePerPurchaseUnit, rate.source, valued.totalValue,
        isVariance ? 1 : 0, m.unit, m.purchase_unit || m.unit, m.name, ln.id,
      );

      applied++;
      if (isVariance) {
        varianceLines++;
        net += valued.totalValue;
        if (variance < 0) shortage += Math.abs(valued.totalValue);
        else excess += valued.totalValue;
      }
    }

    // (f) THE STAMP — written once, ever.
    //
    // THE VALUE IS THE COUNT DATE, NOT THE COMMIT CLOCK. This row is the one
    // boundary the whole module exists to establish, and four strings on
    // /inventory/central-cutover tell the operator it is the day the shelf was
    // counted ("counted {date}", "replaced with the counts taken on {date}",
    // "This also sets the central-store cutover date to {date}", and the
    // committed-batch line "set the cutover date"). Stamping datetime('now')
    // stated one date and stored another: a sheet counted on the 11th and
    // committed at 01:00 IST on the 12th stamped 2026-08-11 19:30:00 UTC —
    // whose DATE half, which is what every business-date filter reads through
    // getCentralStoreCutoverDate(), is the 11th only by accident of the UTC
    // offset. Commit at 06:00 IST instead and it lands on the 12th, a day the
    // screen never mentioned. Normalised to midnight so the value is
    // unmistakably a business date rather than a clock reading.
    //
    // The guarded UPDATE + INSERT OR IGNORE pair is the department cutover's
    // shape and it is what makes "once" true under concurrency: the UPDATE only
    // fires on a blank value, and the INSERT cannot overwrite an existing row.
    // Two admins committing simultaneously therefore cannot move the boundary.
    // A settings row may not exist at all here (unlike dept_ledger_cutover_at
    // this key is deliberately NOT seeded by the migration), so the INSERT runs
    // first and the UPDATE fills it.
    const commitAt = String((db.prepare("SELECT datetime('now') AS t").get() as { t: string }).t);
    const stampValue = String(batch.cutover_date).slice(0, 10) + ' 00:00:00';
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('central_store_cutover_at', '')").run();
    const stampRes = db.prepare(`
      UPDATE settings SET value = ?
       WHERE key = 'central_store_cutover_at' AND TRIM(COALESCE(value, '')) = ''
    `).run(stampValue);
    const stampWritten = stampRes.changes === 1;

    // THE COMPANION KEY — the real UTC instant the book was re-based. Written
    // under the same write-once guard and only when the date stamp was actually
    // taken, so the two can never describe different cutovers. It answers the
    // one question the date cannot: whether a row recorded at some timestamp
    // was measured against the old book or the new one. approveVariance's
    // central floor is built on exactly that, and a business date normalised to
    // midnight would answer it wrongly for everything recorded on the day.
    if (stampWritten) {
      db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('central_store_cutover_committed_at', '')").run();
      db.prepare(`
        UPDATE settings SET value = ?
         WHERE key = 'central_store_cutover_committed_at' AND TRIM(COALESCE(value, '')) = ''
      `).run(commitAt);
    }

    db.prepare(`
      UPDATE central_cutover_batches
         SET status = 'committed', committed_by = ?, committed_at = ?,
             counted_lines = ?, variance_lines = ?, net_variance_value = ?,
             shortage_value = ?, excess_value = ?, stamped = ?
       WHERE id = ? AND status = 'draft'
    `).run(
      norm(actor), commitAt, applied, varianceLines, r2(net), r2(shortage), r2(excess),
      stampWritten ? 1 : 0, batchId,
    );

    const finalStamp = db.prepare("SELECT value FROM settings WHERE key = 'central_store_cutover_at'")
      .get() as { value?: string } | undefined;

    return {
      batch_id: batchId,
      cutover_date: batch.cutover_date,
      committed_at: commitAt,
      applied,
      variance_lines: varianceLines,
      net_variance_value: r2(net),
      shortage_value: r2(shortage),
      excess_value: r2(excess),
      /** The BOUNDARY as stored: a business date at midnight, not a clock
       *  reading. On the first cutover this is this batch's own count date; on
       *  a later one it is the earlier batch's, unchanged. */
      cutover_at: normTs(finalStamp?.value) || stampValue,
      /** The date half, which is what the screen should quote. */
      cutover_boundary_date: (normTs(finalStamp?.value) || stampValue).slice(0, 10),
      stamp_written: stampWritten,
    };
  });

  return run();
}

// ── the alert records ───────────────────────────────────────────────────────

/**
 * Every line that raised an alert, newest batch first. THIS IS THE "alert for
 * every single variance" surface — one row per varying material, nothing
 * aggregated away, with book, counted, difference and rupee value on each.
 */
export function listAlertLines(
  db: Database.Database,
  opts?: { batchId?: string | null; unreviewedOnly?: boolean; limit?: number },
): Array<CutoverLine & { cutover_date: string }> {
  const where: string[] = ['l.alert = 1', "b.status = 'committed'"];
  const params: unknown[] = [];
  if (opts?.batchId) { where.push('l.batch_id = ?'); params.push(opts.batchId); }
  if (opts?.unreviewedOnly) where.push("TRIM(COALESCE(l.reviewed_at,'')) = ''");
  params.push(Math.max(1, Math.min(5000, opts?.limit ?? 2000)));
  return db.prepare(`
    SELECT l.*, b.cutover_date
      FROM central_cutover_lines l
      JOIN central_cutover_batches b ON b.id = l.batch_id
     WHERE ${where.join(' AND ')}
     ORDER BY b.cutover_date DESC, ABS(l.variance_value) DESC
     LIMIT ?
  `).all(...params) as Array<CutoverLine & { cutover_date: string }>;
}

/** Unreviewed alert LINES. For the review screen's own badge. */
export function unreviewedCutoverAlertCount(db: Database.Database): number {
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS n
        FROM central_cutover_lines l
        JOIN central_cutover_batches b ON b.id = l.batch_id
       WHERE l.alert = 1 AND b.status = 'committed' AND TRIM(COALESCE(l.reviewed_at,'')) = ''
    `).get() as { n: number } | undefined;
    return Number(row?.n) || 0;
  } catch { return 0; }
}

/**
 * Committed batches that still hold unreviewed alerts — ONE entry per batch.
 *
 * This is the BELL's unit, deliberately. The owner asked for an alert on every
 * single variance and gets one: a durable record per line, listed on the review
 * screen. But ~600 bell notifications would destroy the bell as a tool, so the
 * bell carries one item per cutover batch with the counts in its label.
 */
export function unreviewedAlertBatches(db: Database.Database): Array<{
  batch_id: string;
  cutover_date: string;
  counted_lines: number;
  variance_lines: number;
  unreviewed: number;
  net_variance_value: number;
  label: string;
}> {
  try {
    const rows = db.prepare(`
      SELECT b.id AS batch_id, b.cutover_date, b.counted_lines, b.variance_lines,
             b.net_variance_value,
             SUM(CASE WHEN TRIM(COALESCE(l.reviewed_at,'')) = '' THEN 1 ELSE 0 END) AS unreviewed
        FROM central_cutover_batches b
        JOIN central_cutover_lines l ON l.batch_id = b.id AND l.alert = 1
       WHERE b.status = 'committed'
       GROUP BY b.id
      HAVING unreviewed > 0
       ORDER BY b.cutover_date DESC
    `).all() as Array<{
      batch_id: string; cutover_date: string; counted_lines: number;
      variance_lines: number; net_variance_value: number; unreviewed: number;
    }>;
    return rows.map((r) => ({
      ...r,
      label: 'Stock cutover ' + r.cutover_date + ' — ' + r.counted_lines + ' counted, '
        + r.variance_lines + ' with a variance, net Rs '
        + Math.round(r.net_variance_value).toLocaleString('en-IN') + ' (information only)',
    }));
  } catch { return []; }
}

/** Mark alert lines reviewed. Returns how many rows changed. */
export function reviewAlertLines(
  db: Database.Database,
  batchId: string,
  materialIds: string[],
  actor?: string | null,
  note?: string | null,
): number {
  if (!Array.isArray(materialIds) || materialIds.length === 0) return 0;
  const stmt = db.prepare(`
    UPDATE central_cutover_lines
       SET reviewed_by = ?, reviewed_at = datetime('now'), review_note = ?
     WHERE batch_id = ? AND material_id = ? AND alert = 1 AND TRIM(COALESCE(reviewed_at,'')) = ''
  `);
  let n = 0;
  const run = db.transaction(() => {
    for (const id of materialIds) n += stmt.run(norm(actor), norm(note), batchId, String(id)).changes;
  });
  run();
  return n;
}
