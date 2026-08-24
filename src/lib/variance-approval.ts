/**
 * Variance approval workflow.
 *
 * A closing physical count that disagrees with the system NEVER changes stock on
 * its own. Instead it creates a PENDING `variance_approvals` row. An admin then
 * reviews it (records the staff's reason) and either:
 *   - APPROVES  → the counted DELTA is posted to the rail the count belongs to,
 *                 and logged (central: inventory_transactions; liquor: a
 *                 store_stock_ledger movement; department: a signed
 *                 department_material_transactions 'adjustment').
 *   - REJECTS   → nothing moves on any rail; the variance stands as an open loss
 *                 to investigate (theft / spillage / miscount).
 *
 * A DELTA, NEVER AN ABSOLUTE SET. This is the whole shape of the file and the
 * one thing not to "simplify" back. An approval is deferred by hours — the count
 * happens at 10am and the admin clears the queue at 4pm — and stock keeps moving
 * in between. `SET current_stock = physical_stock` (what this used to do) writes
 * the 10am shelf over the 4pm book, so a noon issue of 40 kg to a kitchen is
 * silently un-issued: central gets it back on paper while the department still
 * physically holds it, and the same 40 kg then exists twice. Posting
 * (physical − system-at-count-time) instead leaves every movement made after the
 * count standing, which is the only reading under which stock moves exactly once.
 *
 * THREE RAILS, AND A COUNT ONLY EVER TOUCHES ITS OWN:
 *   source='liquor'                  → store_stock_ledger  (TGBCL store rail)
 *   source='central', dept = ''      → raw_materials.current_stock (central store)
 *   source='central', dept = <id>    → department_material_transactions
 * A department count must never reach central and a central count must never
 * reach a department. Crossing them is the "department clobber" that
 * varianceApprovalBlock() has guarded since the queue shipped.
 *
 * ONE COUNT PER ITEM MAY BE APPROVED — THE LATEST ONE. The delta above is frozen
 * at count time, which is right for a single count and wrong for two: a second
 * count on a second DATE freezes the SAME baseline again, so approving both
 * applies the baseline correction TWICE. The pending-uniqueness index is keyed
 * per date and cannot see that. supersedeWhere() below is the rule that can, and
 * approveVariance() refuses anything it flags. See that comment for the measured
 * case; it is the reason this file grew a second guard.
 */
import type Database from 'better-sqlite3';
import { generateId } from '@/lib/db';
import { qcHoldBlockForCount } from '@/lib/grn-qc';
import { postLedger, isStoreMappedMaterial } from '@/lib/store-engine';
import { deptOnHand, postDeptLedger } from '@/lib/dept-ledger';
import { packFactor, type PackMeta } from '@/lib/pack-units';
import {
  getCentralStoreCutoverDate,
  getCentralStoreCutoverCommittedAt,
} from '@/lib/central-cutover';

export type VarianceSource = 'central' | 'liquor';

export interface CreateVarianceInput {
  source: VarianceSource;
  material_id: string;
  store_id?: string;         // liquor only
  department_id?: string;    // central only ('' = Store/Overall)
  date: string;
  system_stock: number;
  physical_stock: number;
  unit?: string;
  counted_by?: string;
  count_note?: string;
  outlet_id?: string | null;
  /**
   * ADDITIVE (2026-08). The SUBMIT this count arrived in — one id per upload /
   * sheet save, stamped on every row it produces. This is what makes the queue a
   * MONTHLY activity: closing stock is uploaded weekly, so "clear last month"
   * means "clear these four uploads", and without an id per upload the only
   * handle on a batch is a date range that also sweeps up anything else counted
   * that day. Empty string = a save made before this existed, or one that did
   * not bother; it never changes behaviour, only what can be filtered.
   */
  batch_id?: string | null;
  /** Human label for that submit ("All-departments CSV", "Liquor store sheet"). */
  batch_label?: string | null;
}

const norm = (v?: string | null): string => (v == null ? '' : String(v).trim());

/* ════════════════════════════════════════════════════════════════════════════
 * 1. THE ONE `counted` CONCEPT — BLANK IS NOT A COUNT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *      BLANK = NOT COUNTED.      0 = COUNTED AND FOUND EMPTY.
 *
 * THE DEFECT THIS CLOSES. Every intake path read a physical count with a bare
 * `Number(x)`, and `Number('') === 0`, `Number('   ') === 0`, `Number(null) === 0`
 * — all finite, all non-negative, so all sailed past the `isNaN || < 0` guard and
 * were STORED AS A REAL COUNTED ZERO. Only a MISSING KEY (`undefined`) yielded
 * NaN, so "the cell was empty" and "the counter wrote 0" were the same event on
 * four of the five writers. A weekly sheet carrying 793 blanks-typed-as-0
 * therefore produced 793 "we have zero" counts, each with a full-shelf variance
 * and each demanding an admin decision.
 *
 * A blank is worse than an extra approval: the upsert-delete on every writer
 * fires for any line that passes validation, so a blank-become-0 DELETES the
 * real count already stored for that (date, material, department) and replaces
 * it with 0. And on department rows dept-ledger's latestCount() anchors the
 * department balance on the newest closing_stock row, so the phantom zero moves
 * that department's on-hand to nil at SAVE time, before anyone approves.
 *
 * THE REPRESENTATION IS ROW ABSENCE, NOT A NULL. closing_stock.physical_stock,
 * closing_stock_semi.physical_stock and store_closing_counts.physical_qty are
 * all `REAL NOT NULL DEFAULT 0` — NULL is not merely unused there, it is
 * impossible. Every READER already speaks the tri-state through row presence:
 * semi/route.ts:146 `const counted = r.count_id != null` → `:165 physical_stock:
 * counted ? Number(...) : null`, dept-sheet/route.ts:317 `counted: !!saved`,
 * overview's `counted_items`, by-location's LEFT JOIN. Making the column
 * nullable would rebuild a NOT NULL column across live history AND silently
 * break eleven `|| 0` readers (dept-ledger:508/611, dept-stock:333/337,
 * store-engine:1522/1527/1730/1732, closing-valuation:122/145, …), all of which
 * would turn "not counted" back into a hard zero one layer down.
 *
 * So NOT_COUNTED means: write NOTHING. No INSERT, and — this is the half that is
 * easy to miss — NO DELETE and NO `ON CONFLICT` upsert either, or "not counted"
 * would erase the count that IS stored for that day. No variance, no approval,
 * no error line.
 *
 * MODELLED ON THE TWO PLACES THAT ALREADY GOT IT RIGHT: semi/route.ts:165 (the
 * `counted` concept) and dept-sheet/import/route.ts:230 `parseCount()` (which
 * already returns null for a blank and refuses "1,200"/"3 kg" rather than
 * mis-reading them as 1 and 3). This is the same RULE as one CALL, not a second
 * scheme beside them — the importer now calls this and deletes its local copy.
 * ═════════════════════════════════════════════════════════════════════════ */

/** What one physical-count cell turned out to be. Three states, never two. */
export type CountInput =
  /** The cell was empty. Not a zero. Write nothing at all for this line. */
  | { kind: 'not_counted' }
  /** A real measurement, `qty >= 0`. **A counted 0 lands here**, like any number. */
  | { kind: 'count'; qty: number }
  /** Something was typed and it is not a count. Name it; never guess. */
  | { kind: 'error'; reason: string };

const NOT_COUNTED: CountInput = { kind: 'not_counted' };

/**
 * THE ONE READER of a physical-count cell. Every writer calls THIS — the same
 * call, not a copied rule — so blank can never mean two things again.
 *
 * | input                                   | result                          |
 * |-----------------------------------------|---------------------------------|
 * | `undefined`, `null`                     | not_counted                     |
 * | `''`, `'   '`, `'\t'`                   | not_counted                     |
 * | `0`, `'0'`, `'0.00'`                    | **count 0** (a real measurement) |
 * | `12.5`, `'12.5'`, `'1,200'`             | count                           |
 * | `'abc'`, `'3 kg'`, `'1,20'`, `'1e3'`    | error                           |
 * | `-5`, `'-5'`                            | error                           |
 * | `NaN`, `Infinity`                       | error                           |
 * | `true`, `[]`, `[5]`, `{}`               | error                           |
 *
 * The last row matters more than it looks: `Number(true) === 1`, `Number([]) === 0`
 * and `Number([5]) === 5`, so every one of those used to store a count. They are
 * refused by TYPE here, before any coercion can invent a number from them.
 *
 * Grouping separators are accepted only in the exact `1,200,000.5` shape — the
 * rule parseCount() already applied in the CSV importer, kept byte-for-byte so
 * the two doors read one file identically. A malformed group (`1,20`) is an
 * error rather than a silent 120 or 1.
 */
export function readPhysicalCount(raw: unknown): CountInput {
  if (raw === undefined || raw === null) return NOT_COUNTED;

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { kind: 'error', reason: 'physical count is not a number' };
    if (raw < 0) return { kind: 'error', reason: 'physical count cannot be negative' };
    return { kind: 'count', qty: raw };
  }

  if (typeof raw !== 'string') {
    // Booleans, arrays and objects all coerce to a NUMBER in JS and would
    // otherwise be stored as a count. Refuse the type, never the coercion.
    return { kind: 'error', reason: 'physical count must be a number' };
  }

  let s = raw.trim();
  if (s === '') return NOT_COUNTED;               // ← the whole point of this file
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) {
    return {
      kind: 'error',
      reason: raw.trim().startsWith('-')
        ? `physical count cannot be negative ("${raw.trim()}")`
        : `invalid physical count "${raw.trim()}" — write a plain number (0 means counted and empty; leave the cell blank if it was not counted)`,
    };
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return { kind: 'error', reason: `invalid physical count "${raw.trim()}"` };
  return { kind: 'count', qty: n };
}

/* ════════════════════════════════════════════════════════════════════════════
 * 2. THE UPLOAD PATTERN GUARD — refuse on the PATTERN, never on the value.
 * ═══════════════════════════════════════════════════════════════════════════
 * A 0 is a legitimate count and must stay one, so nothing here rejects a zero.
 * What it rejects is an IMPLAUSIBLE SHARE of them arriving at once, which is the
 * signature of a sheet whose blanks were filled in by a spreadsheet, an export
 * `defval`, or a fill-down. The incident was 793 zeros in 1,033 rows — 77%.
 *
 * It refuses BEFORE anything is written and NAMES THE COUNT, and a genuine
 * all-zero stocktake is still possible: the caller re-submits with an explicit
 * confirmation. This is a pattern check, not a value check — the same 793 zeros
 * typed deliberately go through on the second submit.
 *
 * The floors are deliberately generous so ordinary work never trips it: a
 * department counting a handful of items, an EOD keypad entry, a single-material
 * correction. Only a bulk sheet can reach the thresholds at all.
 */
export const ZERO_GUARD_MIN_COUNTS = 25;   // below this, a submit is not a "sheet"
export const ZERO_GUARD_MIN_ZEROS = 15;    // a handful of real zeros is normal
export const ZERO_GUARD_SHARE = 0.6;       // 60% of counted lines reading 0

export interface ZeroPatternVerdict {
  /** Lines that carried a real count (blanks are not counted and not included). */
  counted: number;
  /** How many of those were exactly 0. */
  zeros: number;
  /** zeros / counted, 0..1. */
  share: number;
  /** true ⇒ refuse the write unless the caller explicitly confirmed. */
  suspicious: boolean;
  /** The sentence to show. Empty when not suspicious. */
  message: string;
}

/**
 * Judge a whole submit's zero pattern. `counts` is every value that parsed as a
 * real count — blanks must already have been dropped, since a blank is not a
 * zero and including them would make the guard fire on an ordinary sparse sheet.
 */
export function zeroPatternGuard(counts: number[]): ZeroPatternVerdict {
  const counted = counts.length;
  let zeros = 0;
  for (const n of counts) if (n === 0) zeros++;
  const share = counted > 0 ? zeros / counted : 0;
  const suspicious =
    counted >= ZERO_GUARD_MIN_COUNTS &&
    zeros >= ZERO_GUARD_MIN_ZEROS &&
    share >= ZERO_GUARD_SHARE;
  return {
    counted,
    zeros,
    share: Math.round(share * 1000) / 1000,
    suspicious,
    message: suspicious
      ? `${zeros} of ${counted} counted lines (${Math.round(share * 100)}%) are 0. ` +
        `A 0 is recorded as "counted and found empty" and will be held or applied like any other count — ` +
        `blank cells are what mean "not counted". If those cells were meant to be BLANK, fix the file and ` +
        `upload again. If the shelves really were empty, confirm and this will be saved as counted zeros.`
      : '',
  };
}

/* ════════════════════════════════════════════════════════════════════════════
 * 3. THE BAR — how big a difference is worth an admin's attention.
 * ═══════════════════════════════════════════════════════════════════════════
 * Until now there was NO tolerance at all: upsertVarianceApproval() cleared the
 * row at `variance === 0` exactly and raised one for anything else, so a 0.001 kg
 * flour difference became an admin decision. That is what filled the queue.
 *
 * BELOW THE BAR the variance APPLIES IMMEDIATELY and simply shows up on the
 * report. ABOVE THE BAR the count is recorded and visible but THE STOCK IS HELD
 * — the figure does not move until an admin approves it, so a wrong count can
 * never reach the books.
 *
 * BOTH AXES MUST AGREE THAT IT IS SMALL. `variance_value` is
 * `variance × raw_materials.average_price`, and average_price is 0 for
 * unpriced materials — so a rupee-only bar reads EVERY unpriced variance as ₹0,
 * i.e. under the bar, whatever the quantity. That is the mechanical reason the
 * owner's "value and/or quantity" is a requirement and not a preference, and it
 * is closed two ways: a configured rupee bar can only pass a material that
 * actually has a price basis, and a configured quantity bar must pass too.
 *
 * THE QUANTITY BAR IS IN PURCHASE UNITS (owner rule). "2" means 2 BTL / 2 kg,
 * not 2 ml — a recipe-unit bar would mean 2 ml on one material and 2 pcs on the
 * next. Converted per material through packFactor().
 *
 * DEFAULT IS OFF — every key defaults to 0 and 0 means "no bar". A fresh deploy
 * behaves EXACTLY as today (everything above zero is held) until an admin sets a
 * number. That is deliberate: this ships onto a live queue of 1,472 rows.
 *
 * HARD CLAMPS, NOT JUST DEFAULTS — AND A CEILING BENEATH THEM. The generic
 * PUT /api/settings is manager-or-admin; these four keys are now registered in
 * its KEY_POLICY table as write:'admin' (src/app/api/settings/route.ts), so the
 * self-lift door is shut. The clamps below are the braces to that belt, and
 * AUTO_APPLY_HARD_VALUE_CEILING is a third layer, because the clamps alone were
 * NOT enough: they bound quantity and percentage, never money, so a qty-only
 * bar auto-applied ₹1.27 lakh on one bottle line. See that constant.
 */
export const VARIANCE_BAR_KEYS = {
  /** ₹ of variance value at or under which a count applies itself. 0 = off. */
  value: 'closing_variance_bar_value',
  /** PURCHASE-unit variance at or under which a count applies itself. 0 = off. */
  qty: 'closing_variance_bar_qty',
  /** ₹ of variance value at or over which the immediate alert fires. 0 = off. */
  alertValue: 'closing_variance_alert_value',
  /** % of the item's own system stock at or over which the alert fires. 0 = off. */
  alertPct: 'closing_variance_alert_pct',
} as const;

export const VARIANCE_BAR_MAX_VALUE = 5000;   // ₹ — ceiling on the auto-apply bar
export const VARIANCE_BAR_MAX_QTY = 100;      // purchase units — ditto
export const VARIANCE_ALERT_MAX_VALUE = 10_000_000;
export const VARIANCE_ALERT_MAX_PCT = 1000;

/**
 * THE HARD RUPEE CEILING ON ANY AUTO-APPLY, whatever the bar says.
 * ═══════════════════════════════════════════════════════════════════════════
 * The clamps above were documented as meaning "the most a badly-written bar can
 * auto-apply is small on any single item". THAT WAS FALSE FOR THE QUANTITY AXIS
 * and it was measured: `valueOk` is `bar.value <= 0 || …`, so a bar with ONLY
 * `closing_variance_bar_qty` set leaves the rupee axis unconditionally true.
 * 100 purchase units of RESERVA DE DON JULIO (₹12,716.83/unit) auto-applied at
 * **₹1,271,683** with nobody in the loop — a qty bar has no rupee opinion at
 * all, and VARIANCE_BAR_MAX_QTY bounds bottles, not money.
 *
 * So the ceiling is enforced HERE instead of being asserted in a comment: no
 * variance worth more than VARIANCE_BAR_MAX_VALUE may EVER apply itself,
 * whichever axis the admin configured and whatever they typed. An unpriced
 * material values at ₹0 and is unaffected — the qty axis still governs it, as
 * `priced` below requires.
 *
 * This does NOT constrain the admin's own "Adjust system stock" tick
 * (`force_apply`): that is a person deciding, in an admin-only surface, with
 * the figure in front of them. It constrains the machine.
 */
export const AUTO_APPLY_HARD_VALUE_CEILING = VARIANCE_BAR_MAX_VALUE;

/* ── The materiality floor under the ALERT's share axis ──────────────────────
 * MEASURED ON THE OWNER'S OWN SHEETS (~/Downloads/closing-stock-history-
 * 2026-07-05_2026-08-03.csv, the 2026-08-01 closing: 1,026 counted lines, 311
 * of them holding stock, with real per-line rates):
 *
 *   per-line stock value   p25 ₹428 · p50 ₹907 · p75 ₹2,550 · p90 ₹6,480 ·
 *                          p95 ₹13,000 · max ₹131,425
 *   per-line stock qty     p50 5 purchase units · 48% hold ≤ 4 · 75% hold ≤ 10
 *
 * Two consequences, and they are why a percentage ALONE cannot be an alert:
 *
 *   1. A COUNTED 0 IS ALWAYS EXACTLY 100%. variance = 0 − system, so
 *      |variance|/|system| = 1 by arithmetic, on every "shelf is empty" line.
 *      Two thirds of every real sheet is counted 0 (715 of 1,026 on 2026-08-01;
 *      793 of 1,033 in the incident), so an unfloored share axis fires on
 *      roughly 70-100% of an upload and is muted inside one cycle.
 *   2. ONE PURCHASE UNIT OF MISCOUNT IS ≥25% FOR HALF THE CATALOGUE, because
 *      half the catalogue holds ≤4 purchase units. That is the rounding case,
 *      not an emergency.
 *
 * The floor is a VALUE floor: a difference has to be worth ALERT_MIN_VALUE
 * before a percentage of it means anything. Simulated against the same sheet,
 * a total-vanish count on every stocked line: 311 fire unfloored, 43 fire at
 * ₹5,000 (14%). On a 1-purchase-unit miscount of every line: 311 unfloored,
 * ONE at ₹5,000. That is the difference between a bell and wallpaper.
 *
 * ALERT_MIN_QTY is the stand-in for materials with NO price at all
 * (average_price 0 ⇒ variance_value ₹0, so the value floor would suppress them
 * for ever). It is not a second axis — it is the same floor, measured in the
 * only unit those rows have. Purchase units, per the owner's unit rule.
 *
 * DELIBERATELY CONSTANTS, NOT SETTINGS KEYS. A floor can only ever SUPPRESS an
 * alert, never raise one, so shipping it armed is safe in a way a bar is not;
 * and a tunable with no UI is a trap (the admin panel on /variance-approvals
 * shows the four bar keys and would not show these). If they need tuning, that
 * is a settings key plus a field on that panel, together.
 */
export const ALERT_MIN_VALUE = 5000;   // ₹ — under this, a percentage is noise
export const ALERT_MIN_QTY = 10;       // purchase units — for UNPRICED materials

/* ── THE CIRCUIT-BREAKER ON ONE UPLOAD ───────────────────────────────────────
 * Every control above is PER LINE. Nothing bounded a SUBMIT, and a submit is
 * how this system is actually used: one CSV, a thousand lines. Measured before
 * this existed — a 20-row all-zero submit is below the zero-guard's floor (25
 * counted lines), so no guard saw it at all, and it applied straight through:
 * 3 materials zeroed, ₹6,230, no admin. Scale that to 200 lines under a ₹5,000
 * bar and one upload could move ₹1,000,000 with nobody in the loop.
 *
 * So an upload gets a budget. Once a batch has auto-applied more than
 * AUTO_APPLY_BATCH_VALUE (₹, absolute) or AUTO_APPLY_BATCH_ROWS lines, the REST
 * OF THAT UPLOAD IS HELD — recorded, visible, pending, with the reason on the
 * row. Nothing is undone; the breaker only stops the machine going further.
 *
 * ORDER-DEPENDENT, AND THAT IS THE POINT. Which lines land before the breaker
 * trips depends on their order in the file. That would be indefensible for a
 * BUDGET ("you may spend ₹25,000 per sheet") and is exactly right for a
 * BREAKER: the question it answers is "is this upload behaving like an ordinary
 * weekly sheet?", and the answer is the same whichever line asks it. An upload
 * that trips it needs a human, and after it trips one is guaranteed to get one.
 *
 * Sized against the owner's real sheets: routine weekly noise on a 1,000-line
 * sheet is a few hundred rupees a line on a few dozen lines. ₹25,000 / 200 rows
 * is generous for that and a hard stop on a wholesale event.
 */
export const AUTO_APPLY_BATCH_VALUE = 25_000;  // ₹ of auto-applied |variance| per upload
export const AUTO_APPLY_BATCH_ROWS = 200;      // lines auto-applied per upload

/**
 * How long an AUTO-APPLIED row stays in the immediate alert.
 *
 * A pending row leaves the alert when the admin DECIDES it — approve or reject,
 * either way an action ends it. An auto-applied row has no decision left to
 * make: it is already `approved`, so with no window it would sit in the alert
 * for ever and the number could only climb. One week matches the upload cadence
 * — an auto-applied difference nobody looked at inside a week is history, and
 * it is still in the queue's approved tab and on every variance report.
 */
export const ALERT_AUTO_APPLIED_WINDOW_DAYS = 7;

export interface VarianceBar {
  /** ₹. 0 = this axis is off. */
  value: number;
  /** Purchase units. 0 = this axis is off. */
  qty: number;
  /** ₹. 0 = the value alert is off. */
  alertValue: number;
  /** Percent of the item's system stock. 0 = the share alert is off. */
  alertPct: number;
}

/** 0 for anything unreadable, negative, or non-finite; clamped to `max`. */
function tunable(db: Database.Database, key: string, max: number): number {
  let raw: string | undefined;
  try {
    raw = (db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value?: string } | undefined)?.value;
  } catch { /* no settings table yet ⇒ the bar is off, which is the safe answer */ }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(max, n);
}

/**
 * The effective bar. Read fresh on every save — NEVER cached and NEVER swept
 * over rows that already exist. See the requirement-7 note on
 * recordCountVariance(): changing this tomorrow cannot move a gram of yesterday's
 * held stock.
 */
export function varianceBar(db: Database.Database): VarianceBar {
  return {
    value: tunable(db, VARIANCE_BAR_KEYS.value, VARIANCE_BAR_MAX_VALUE),
    qty: tunable(db, VARIANCE_BAR_KEYS.qty, VARIANCE_BAR_MAX_QTY),
    alertValue: tunable(db, VARIANCE_BAR_KEYS.alertValue, VARIANCE_ALERT_MAX_VALUE),
    alertPct: tunable(db, VARIANCE_BAR_KEYS.alertPct, VARIANCE_ALERT_MAX_PCT),
  };
}

/**
 * THE IMMEDIATE ALERT — rupee value OR share of that item's own stock,
 * WHICHEVER FIRES FIRST. Both tunable, both off by default.
 *
 * THIS IS AN ALERT, NEVER A SECOND GATE. Whether the stock moved was already
 * decided by the bar above; this only decides whether the admin should be told
 * TODAY instead of at month end. Nothing downstream of it writes stock.
 *
 * The share axis needs a denominator, and `system_stock` is 0 on a great many
 * live materials. `|variance| / 0` is not "infinitely big", it is UNDEFINED —
 * and treating it as a hit would fire on the ordinary first count of every
 * never-stocked item and bury the real ones. When the book says nothing, the
 * rupee axis is the one that can speak, so the share axis abstains.
 *
 * AND IT ALSO NEEDS A FLOOR. A percentage has no magnitude of its own: a
 * counted 0 is exactly 100% by arithmetic, and one purchase unit is ≥25% for
 * half this catalogue. ALERT_MIN_VALUE / ALERT_MIN_QTY are what stop the share
 * axis firing on 70-100% of every upload — see those constants for the measured
 * numbers. The RUPEE axis carries no floor because a rupee threshold IS a
 * magnitude; floor-ing it would just be a second, quieter threshold.
 *
 * `purchaseQty` is the variance in PURCHASE units (owner rule). Omitted, the
 * floor falls back to recipe units, which for a packed material is a BIGGER
 * number and therefore the noisier direction — pass it wherever it is known.
 */
export function isBigVariance(
  bar: VarianceBar, variance: number, varianceValue: number, systemStock: number,
  purchaseQty?: number,
): boolean {
  const val = Math.abs(Number(varianceValue) || 0);
  if (bar.alertValue > 0 && val >= bar.alertValue) return true;
  if (bar.alertPct > 0) {
    const base = Math.abs(Number(systemStock) || 0);
    if (base <= 0) return false;
    if ((Math.abs(Number(variance) || 0) / base) * 100 < bar.alertPct) return false;
    // THE MATERIALITY FLOOR. Value where there is a value; quantity only where
    // the material is unpriced and rupees genuinely cannot speak.
    if (val > 0) return val >= ALERT_MIN_VALUE;
    const qty = Math.abs(Number(purchaseQty ?? variance) || 0);
    return qty >= ALERT_MIN_QTY;
  }
  return false;
}

/**
 * packFactor() as SQL, against a `raw_materials` alias. The queue-wide alert
 * has to apply the SAME purchase-unit floor as the per-save one, and it cannot
 * call packFactor() on a thousand rows one at a time. Kept beside its JS twin
 * so the two are read together; if pack-units.ts's rule changes, change both.
 */
const PACK_FACTOR_SQL = (rm: string) => `
  CASE WHEN ${rm}.pack_size > 1
         AND LOWER(TRIM(${rm}.unit)) <> LOWER(TRIM(COALESCE(NULLIF(${rm}.purchase_unit, ''), ${rm}.unit)))
       THEN ${rm}.pack_size ELSE 1 END`;

/**
 * ₹ value of a variance, in the ONE basis this table has always stored:
 * `variance × raw_materials.average_price` (₹ per RECIPE unit). Extracted so the
 * bar and the stored `variance_value` column can never be computed two ways.
 *
 * Deliberately NOT closing-valuation.ts's ladder. That prices the COUNT at
 * ₹/purchase-unit for the closing sheet's rupee total; this prices the
 * DIFFERENCE, and it is the figure the queue, the bell and every variance report
 * already display. Two rupee figures on one row is how a bar starts disagreeing
 * with the number the admin is looking at.
 */
function varianceRupees(db: Database.Database, materialId: string, variance: number): {
  value: number; avgPrice: number;
} {
  let avg = 0;
  try {
    const mat = db.prepare('SELECT average_price FROM raw_materials WHERE id = ?').get(materialId) as
      { average_price: number } | undefined;
    avg = Number(mat?.average_price) || 0;
  } catch { /* unpriced ⇒ 0, and `priced` below then refuses a rupee-only bar */ }
  return { value: Math.round(variance * avg * 100) / 100, avgPrice: avg };
}

/**
 * Create or refresh a PENDING variance approval. Idempotent per
 * (source, material, store, dept, date): re-counting the same item before it is
 * approved updates the SAME pending row instead of stacking duplicates. A zero
 * variance is a no-op (nothing to approve) and returns null.
 *
 * PARKING ONLY. It does not read the bar and it never moves stock — that
 * decision belongs to recordCountVariance() below, which is what every writer
 * now calls. Kept exported because it is the narrow, side-effect-free half.
 */
export function upsertVarianceApproval(db: Database.Database, inp: CreateVarianceInput): string | null {
  const variance = Math.round((Number(inp.physical_stock) - Number(inp.system_stock)) * 1000) / 1000;
  const storeId = norm(inp.store_id);
  const deptId = norm(inp.department_id);
  const outletId = norm(inp.outlet_id);

  // A corrected re-count that now matches the system clears any stale PENDING
  // approval for this key (nothing left to approve). Already-decided rows stay.
  if (variance === 0) {
    db.prepare(`
      DELETE FROM variance_approvals
      WHERE status = 'pending' AND source = ? AND material_id = ? AND store_id = ? AND department_id = ? AND date = ? AND outlet_id = ?
    `).run(inp.source, inp.material_id, storeId, deptId, inp.date, outletId);
    return null;
  }

  const varianceValue = varianceRupees(db, inp.material_id, variance).value;
  const batchId = norm(inp.batch_id);
  const batchLabel = norm(inp.batch_label);

  const existing = db.prepare(`
    SELECT id FROM variance_approvals
    WHERE status = 'pending' AND source = ? AND material_id = ? AND store_id = ? AND department_id = ? AND date = ? AND outlet_id = ?
  `).get(inp.source, inp.material_id, storeId, deptId, inp.date, outletId) as { id: string } | undefined;

  if (existing) {
    // The batch moves to the LATEST submit that touched this pending row. A
    // re-count belongs to the upload that re-counted it, or "clear last week's
    // upload" would silently clear a row corrected this week.
    db.prepare(`
      UPDATE variance_approvals SET
        system_stock = ?, physical_stock = ?, variance = ?, variance_value = ?, unit = ?,
        counted_by = ?, count_note = ?, batch_id = ?, batch_label = ?, created_at = datetime('now')
      WHERE id = ?
    `).run(
      inp.system_stock, inp.physical_stock, variance, varianceValue, norm(inp.unit),
      norm(inp.counted_by), norm(inp.count_note), batchId, batchLabel, existing.id,
    );
    return existing.id;
  }

  const id = generateId();
  db.prepare(`
    INSERT INTO variance_approvals
      (id, source, material_id, store_id, department_id, date, system_stock, physical_stock,
       variance, variance_value, unit, counted_by, count_note, status, outlet_id,
       batch_id, batch_label, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, datetime('now'))
  `).run(
    id, inp.source, inp.material_id, storeId, deptId, inp.date, inp.system_stock, inp.physical_stock,
    variance, varianceValue, norm(inp.unit), norm(inp.counted_by), norm(inp.count_note), outletId,
    batchId, batchLabel,
  );
  return id;
}

/* ════════════════════════════════════════════════════════════════════════════
 * 4. THE DECISION — the ONE door from "a count was saved" to "stock moved".
 * ═══════════════════════════════════════════════════════════════════════════
 * Every writer calls THIS instead of upsertVarianceApproval(). It parks the row,
 * reads the bar, and — when the difference is under the bar — grants that same
 * approval immediately through approveVariance(), the identical function the
 * admin queue calls.
 *
 * ONE PATH TO raw_materials, NOT TWO. The auto-apply is NOT a second
 * `UPDATE raw_materials SET current_stock`; it is the queue's own approval,
 * fired a few milliseconds earlier. So the delta posted, the negative-stock
 * behaviour, the inventory_transactions log, the cutover floor, the QC-hold
 * floor and the supersede guard are byte-for-byte what "approve next month"
 * produces. Nothing here can drift from the reviewed path, because nothing here
 * writes stock.
 *
 * WHY AUTO-APPLY IS ONLY SAFE AT SAVE TIME. A pending row FREEZES system_stock
 * and approveVariance posts (physical − that frozen figure) onto LIVE stock.
 * Called here, inside the save, `system_stock` IS live current_stock this
 * instant, so `before + delta == physical` exactly. A later batch sweep of
 * "small" rows would post a stale delta on top of everything that moved since —
 * the double-apply supersedeWhere() exists to stop. Hence the next paragraph,
 * which is a REQUIREMENT and not an implementation note:
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ CHANGING THE BAR MUST NOT RETROACTIVELY MOVE STOCK.                      ║
 * ║ The bar is read HERE and only here, at save time, for the row being      ║
 * ║ saved. Nothing anywhere sweeps existing rows against it. A row already   ║
 * ║ pending stays pending until a human decides it, and lowering the bar     ║
 * ║ tomorrow cannot silently apply yesterday's held variances. If a sweep is ║
 * ║ ever added it must re-read each row's rail and re-run the supersede      ║
 * ║ guard — do not add one because it "looks equivalent".                    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * AUTO-APPLY MAY FAIL, AND THAT IS A FEATURE. The cutover floor and the QC-hold
 * floor refuse small variances too, and they should. When they do, the count
 * still saves, the approval stays PENDING, and `apply_error` carries the reason
 * — the existing precedent at closing-stock/route.ts:597-606.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ DEPARTMENT ROWS ARE NOT PARKED AT ALL, BECAUSE THEY CANNOT BE HELD.      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 * dept-ledger's latestCount() anchors a department balance on the newest
 * closing_stock row with NO approval-status test, so a department count has
 * ALREADY moved that department's on-hand the moment it was SAVED — before any
 * bar, any hold, any approval. MEASURED: opening 5000 → save an UNAPPROVED
 * count of 4800 → deptOnHand returns 4800 with the approval still 'pending'.
 *
 * A pending row on that rail was therefore a claim the system could not honour:
 *   · it said "stock is held pending your approval" when the balance had
 *     already moved;
 *   · it could never be APPROVED — varianceApprovalBlock() refuses every one of
 *     them (anchorSource === 'count'), and approveVariance()'s post-condition
 *     would throw if it somehow got through, because the correction would land
 *     on top of the anchor and double;
 *   · REJECT did not recover anything either — measured: reject a department
 *     count of 0 against an on-hand of 40 and the balance stays 0. The only
 *     honest verb the queue offered was one that changed nothing.
 * So the row was pure noise with a false label on it, and thousands of them
 * were the bulk of the queue this whole build exists to drain.
 *
 * WHAT HAPPENS NOW: the count still SAVES (closing_stock keeps the dated record,
 * with its variance and variance_value, which is what /api/department-variance
 * reports from). No pending approval is created — outcome 'anchored', and
 * `dept_anchored` is true. A matching re-count still CLEARS a stale pending row
 * exactly as it always did, so the legacy rows drain the way they always have;
 * nothing here rewrites or deletes an existing decision.
 *
 * THIS IS NOT THE FIX, IT IS THE HONEST STATE. The real fix is in
 * src/lib/dept-ledger.ts: latestCount() must not let a count re-base a balance
 * before it is approved. That change re-bases every department balance in the
 * system retroactively (every historical count carries an approval row) and has
 * a mandated twin in dept-stock.ts's computeDeptStock, so it is its own build
 * with its own cutover — not something to slip into a safety pass. Until it
 * lands, requirement 3 ("above the bar the stock is HELD") is simply NOT
 * DELIVERED on the department rail, and no screen may pretend otherwise.
 */

/** Recorded as `reviewed_by` when the BAR applied a count, never a person. */
export const AUTO_REVIEWER = 'system:auto-apply';

export interface RecordVarianceInput extends CreateVarianceInput {
  /**
   * Pack meta of the material, so the QUANTITY bar can be read in PURCHASE
   * units (owner rule). Omit it and the qty axis falls back to recipe units,
   * which is stricter for packed materials and never looser: packFactor >= 1
   * always, so a missing pack meta can only make a variance look BIGGER
   * against the bar, i.e. more likely to be held.
   */
  pack?: PackMeta | null;
  /**
   * The admin's "Adjust system stock" tick — apply regardless of the bar. Still
   * goes through approveVariance() and is still refused by every floor.
   */
  force_apply?: boolean;
  /** Who to record on a forced apply. Defaults to AUTO_REVIEWER. */
  applied_by?: string | null;
  /** Reason recorded on a forced apply. Defaults to a self-describing sentence. */
  applied_reason?: string | null;
}

export interface RecordVarianceResult {
  /**
   *  'match'    — the count agrees with the book. Nothing parked, nothing moved.
   *  'applied'  — under the bar (or force-applied): stock has ALREADY moved.
   *  'held'     — above the bar: recorded and visible, stock NOT moved, waiting
   *               for an admin. The default, and the safe one.
   *  'anchored' — A DEPARTMENT ROW. The department's own balance moved the
   *               instant the closing_stock row was written, before this
   *               function was even called. Nothing is parked, because there is
   *               nothing left to hold and nothing an approval could do. NEVER
   *               report this as 'held': it is the opposite. See the department
   *               section of the header block above recordCountVariance().
   */
  outcome: 'match' | 'applied' | 'held' | 'anchored';
  approval_id: string | null;
  variance: number;
  variance_value: number;
  /** The variance in PURCHASE units — the basis the qty bar is written in. */
  variance_purchase_qty: number;
  /**
   * Why the stock did not move even though the bar would otherwise have moved
   * it. Admin-facing text, and admin-only on every surface (it names the system
   * figure's provenance — blind counts).
   *
   * Two causes, deliberately sharing one field because they read identically to
   * the admin ("the count saved; the figure did not move; here is why"):
   *   · an apply was ATTEMPTED and a floor refused it (cutover, QC hold, a
   *     newer count) — the count stays pending;
   *   · the difference passed the configured bar but is worth more than
   *     AUTO_APPLY_HARD_VALUE_CEILING, so no apply was attempted at all.
   */
  apply_error: string | null;
  /** true when the bar (not a force tick) is what applied it. */
  auto_applied: boolean;
  /** true on a department row — its balance already moved at save. See above. */
  dept_anchored: boolean;
  /** true when the immediate-alert thresholds fired for this row. */
  alert: boolean;
}

export function recordCountVariance(
  db: Database.Database, inp: RecordVarianceInput,
): RecordVarianceResult {
  const variance = Math.round((Number(inp.physical_stock) - Number(inp.system_stock)) * 1000) / 1000;
  const deptId = norm(inp.department_id);
  const isDept = String(inp.source) === 'central' && deptId !== '';
  const pf = packFactor((inp.pack || {}) as PackMeta);
  const purchaseQty = Math.round((variance / (pf > 0 ? pf : 1)) * 1000) / 1000;

  const base = {
    variance,
    variance_purchase_qty: purchaseQty,
    dept_anchored: isDept,
    apply_error: null as string | null,
    auto_applied: false,
    alert: false,
  };

  /* ── THE DEPARTMENT RAIL: NOTHING IS PARKED, BECAUSE NOTHING CAN BE HELD ──
   * Taken BEFORE the upsert, on purpose. The full argument is in the header
   * block above; the short version is that the closing_stock row written by the
   * caller a few lines ago has ALREADY re-anchored this department's balance
   * (dept-ledger latestCount(), no status test), so a "pending" row here would
   * be a hold that does not exist — un-approvable by varianceApprovalBlock()
   * and un-rejectable in any sense that restores the figure.
   *
   * A ZERO VARIANCE STILL GOES THROUGH upsertVarianceApproval(). That call is
   * the DELETE that clears a stale pending row for this exact key when a
   * corrected re-count now matches — the one way the legacy department rows
   * leave the queue on their own, and shipped behaviour we are not taking away.
   * It cannot insert: upsertVarianceApproval returns null without writing when
   * variance === 0.
   *
   * NOTHING ELSE IS DELETED. A non-matching re-count leaves any existing
   * pending row exactly where it is — stale figures and all. Widening the
   * delete would have the system quietly clearing the owner's queue behind him
   * with no audit row, and clearing that queue is his to do (bulk reject, which
   * records status='rejected' and a reason). Do not "tidy" this.
   *
   * `alert` is computed identically to every other rail and is deliberately
   * unchanged here — the alert thresholds and their wiring are owned elsewhere.
   * ──────────────────────────────────────────────────────────────────────── */
  if (isDept) {
    if (variance === 0) {
      upsertVarianceApproval(db, inp);   // clear-only; returns null, writes nothing new
      return { ...base, outcome: 'match', approval_id: null, variance_value: 0 };
    }
    const { value: deptValue } = varianceRupees(db, inp.material_id, variance);
    return {
      ...base,
      outcome: 'anchored',
      approval_id: null,
      variance_value: deptValue,
      // apply_error stays NULL. It is the "an apply was attempted and a floor
      // refused it" channel, and every caller pushes it into a per-line error
      // list — filling that list with one identical sentence per line on a
      // 900-row department sheet would bury the real errors. The rail-level
      // fact belongs in ONE sentence per save, off `dept_anchored`.
      apply_error: null,
      alert: isBigVariance(
        varianceBar(db), variance, deptValue, Number(inp.system_stock) || 0, purchaseQty,
      ),
    };
  }

  // A count that agrees with the book clears any stale pending row and is done.
  const approvalId = upsertVarianceApproval(db, inp);
  if (approvalId === null) {
    return { ...base, outcome: 'match', approval_id: null, variance_value: 0 };
  }

  const { value: varianceValue, avgPrice } = varianceRupees(db, inp.material_id, variance);
  const bar = varianceBar(db);
  const alert = isBigVariance(bar, variance, varianceValue, Number(inp.system_stock) || 0, purchaseQty);

  // ── UNDER THE BAR? Both CONFIGURED axes must agree that it is small. ──────
  // `priced` is the unvalued-item trap: average_price 0 makes variance_value ₹0,
  // which is under ANY rupee bar however many kilos moved. An unpriced material
  // can therefore only pass on the QUANTITY axis.
  const priced = avgPrice > 0;
  const anyAxis = bar.value > 0 || bar.qty > 0;
  const valueOk = bar.value <= 0 || (priced && Math.abs(varianceValue) <= bar.value);
  const qtyOk = bar.qty <= 0 || Math.abs(purchaseQty) <= bar.qty;
  // THE HARD RUPEE CEILING, and it is not redundant with `valueOk`. When the
  // admin configured ONLY the quantity axis, `valueOk` is unconditionally true
  // and nothing else in this expression has a rupee opinion — that is how a
  // 100-bottle bar auto-applied ₹1.27 lakh. Nothing may apply ITSELF above this
  // figure, whatever is configured. See AUTO_APPLY_HARD_VALUE_CEILING.
  const ceilingOk = Math.abs(varianceValue) <= AUTO_APPLY_HARD_VALUE_CEILING;
  const underBar = anyAxis && valueOk && qtyOk && ceilingOk;

  const forced = inp.force_apply === true;
  // THE PER-UPLOAD BREAKER. Read only when the bar would otherwise apply this
  // line, so an unarmed bar and a forced admin apply both cost nothing. The
  // aggregate is over rows the BAR applied in this same batch — never over a
  // human's decisions, and never across uploads. An unstamped batch ('') is a
  // single-line save (every bulk writer stamps one); it is skipped rather than
  // aggregated, because '' would otherwise pool every unbatched row ever
  // written into one budget and trip permanently.
  const batchKey = norm(inp.batch_id);
  let breaker: string | null = null;
  if (!isDept && !forced && underBar && batchKey) {
    const so = db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(ABS(variance_value)), 0) AS v
        FROM variance_approvals
       WHERE batch_id = ? AND auto_applied = 1 AND status = 'approved'
    `).get(batchKey) as { n: number; v: number } | undefined;
    const rows = Number(so?.n) || 0;
    const spent = Number(so?.v) || 0;
    if (rows >= AUTO_APPLY_BATCH_ROWS || spent + Math.abs(varianceValue) > AUTO_APPLY_BATCH_VALUE) {
      breaker =
        `this upload has already applied ${rows} differences worth ₹${Math.round(spent * 100) / 100} on its own. ` +
        `That is past the ${AUTO_APPLY_BATCH_ROWS}-line / ₹${AUTO_APPLY_BATCH_VALUE} limit for ONE upload, so the ` +
        `rest of it is being held for you instead of applied. Nothing already applied was undone.`;
    }
  }
  // Department rows are excluded from BOTH doors — see the header note.
  const attempt = !isDept && (forced || (underBar && !breaker));

  if (attempt) {
    const reviewer = norm(inp.applied_by) || AUTO_REVIEWER;
    const reason = norm(inp.applied_reason) || autoApplyReason(bar, varianceValue, purchaseQty, inp.unit);
    try {
      const res = approveVariance(db, approvalId, reviewer, reason, { auto: !forced });
      if (res.ok) {
        return {
          ...base, outcome: 'applied', approval_id: approvalId,
          variance_value: varianceValue, auto_applied: !forced, alert,
        };
      }
      return {
        ...base, outcome: 'held', approval_id: approvalId, variance_value: varianceValue,
        apply_error: res.error || 'approval refused', alert,
      };
    } catch (e) {
      // approveVariance rolls its own SAVEPOINT back; the saved count row
      // survives and the approval simply stays pending.
      return {
        ...base, outcome: 'held', approval_id: approvalId, variance_value: varianceValue,
        apply_error: (e as Error)?.message || 'approval failed', alert,
      };
    }
  }

  // Held. When the CEILING is the only thing that held it, say so — otherwise
  // an admin who set a 100-unit bar sees a ₹200,000 row sitting in the queue
  // with no explanation and concludes the bar is broken.
  const ceilingHeld = !isDept && !forced && anyAxis && valueOk && qtyOk && !ceilingOk;
  return {
    ...base, outcome: 'held', approval_id: approvalId, variance_value: varianceValue, alert,
    apply_error: breaker || (ceilingHeld
      ? `this difference is worth ₹${Math.abs(varianceValue)}, over the ₹${AUTO_APPLY_HARD_VALUE_CEILING} ` +
        `ceiling on anything that may apply itself. It passed the bar you set, but nothing this large moves ` +
        `stock without an admin approving it.`
      : null),
  };
}

/** The audit sentence a machine-applied row carries, naming the bar it passed. */
function autoApplyReason(bar: VarianceBar, varianceValue: number, purchaseQty: number, unit?: string): string {
  const bits: string[] = [];
  if (bar.value > 0) bits.push(`₹${Math.abs(varianceValue)} within the ₹${bar.value} value bar`);
  if (bar.qty > 0) bits.push(`${Math.abs(purchaseQty)} within the ${bar.qty}-unit quantity bar`);
  return (
    `Applied automatically at count time: ${bits.join(' and ') || 'under the configured bar'}` +
    `${unit ? ` (counted in ${unit})` : ''}. No admin reviewed this — it was below the bar an admin set, ` +
    `and it appears on the variance report like any other difference.`
  );
}

/**
 * Which outlets a queue read covers.
 *   'outlet' → rows stamped with the reader's own outlet, plus rows stamped
 *              with no outlet at all (''). The DEFAULT, and byte-for-byte what
 *              every caller got before this type existed.
 *   'all'    → every outlet. OPT-IN ONLY, never inferred.
 *
 * WHY 'all' HAD TO EXIST. A pending row carries the outlet of whoever COUNTED,
 * but the queue is read under the outlet of whoever REVIEWS, and those are two
 * different people. POST /api/outlets/switch moves any signed-in user to any
 * active outlet with no role gate, so a count saved from outlet B is invisible
 * to an admin sitting in outlet A — and pendingVarianceCount carried the
 * identical filter, so the badge read zero too and nothing hinted the row was
 * there. A variance nobody can see is a variance nobody reviews, which is the
 * one failure this whole queue exists to prevent.
 *
 * 'all' makes those rows REACHABLE. It does not remove outlet isolation: the
 * default stays 'outlet', so a single-outlet day looks exactly as it did.
 */
export type VarianceOutletScope = 'outlet' | 'all';

/**
 * Count of pending approvals, scoped like the list below.
 *
 * `scope` and `outletId` must be read together: 'all' ignores `outletId`
 * entirely. Passing no outlet at all has always meant "every outlet" here, but
 * that is implicit and easy to hit by accident — say `'all'` when you mean it.
 */
export function pendingVarianceCount(
  db: Database.Database,
  outletId?: string | null,
  scope: VarianceOutletScope = 'outlet',
): number {
  // The INNER JOIN mirrors listVarianceApprovals. Without it the two disagree:
  // a pending row whose material was deleted is COUNTED here but can never be
  // LISTED there, so the bell would show "3 waiting" over a queue rendering
  // "All counts reconcile with the system — no variances to review." Counting
  // only what the admin can actually open keeps the badge honest; a row orphaned
  // that way is unreviewable and nagging about it helps nobody.
  const oid = scope === 'all' ? '' : norm(outletId);
  const row = oid
    ? db.prepare(`SELECT COUNT(*) AS n FROM variance_approvals va JOIN raw_materials m ON m.id = va.material_id WHERE va.status='pending' AND (va.outlet_id = ? OR va.outlet_id = '')`).get(oid) as { n: number }
    : db.prepare(`SELECT COUNT(*) AS n FROM variance_approvals va JOIN raw_materials m ON m.id = va.material_id WHERE va.status='pending'`).get() as { n: number };
  return row?.n || 0;
}

/* ────────────────────────────────────────────────────────────────────────────
 * SUPERSEDED COUNTS — why an OLDER count may not be approved after a NEWER one.
 * ──────────────────────────────────────────────────────────────────────────*/

/** The newest count competing with a given row. */
export interface SupersedingCount {
  /** Count date of that newer row (YYYY-MM-DD). */
  date: string;
  /** Where it stands. 'rejected' is deliberately not a member — see below. */
  status: 'pending' | 'approved';
}

/** The key fields the supersede test reads. A whole variance_approvals row fits. */
export interface VarianceKeyRow {
  id?: string | null;
  source: string;
  material_id?: string | null;
  store_id?: string | null;
  department_id?: string | null;
  outlet_id?: string | null;
  date?: string | null;
  created_at?: string | null;
}

/**
 * THE SUPERSEDE PREDICATE. Written ONCE on purpose — read this before touching
 * either of its two callers.
 *
 * A pending row FREEZES system_stock at count time and approveVariance() posts
 * (physical − that frozen system) on top of LIVE stock. Correct for ONE count.
 * Wrong the instant two counts on two DATES exist for the same item, because
 * both froze the SAME baseline and the baseline correction is then applied
 * TWICE. Measured on the owner's data — Testing Curd 2 (g, pack 1000), live
 * stock −997 g:
 *     07-08  system −997  counted    997  → delta  +1,994
 *     08-08  system −997  counted 11,000  → delta +11,997
 * Approving 08-08 lands −997 + 11,997 = 11,000 g = 11 kg, which is the shelf.
 * Approving 07-08 on top of that lands 12,994 g — overstated by exactly the
 * −997 baseline, a second time. The reverse order is equally wrong. And it
 * overstates, i.e. it inflates in the direction that HIDES a shortage.
 *
 * uq_variance_appr_pending DOES NOT STOP THIS. It is keyed per DATE, so two
 * dates are two independent pending rows and neither supersedes the other.
 *
 * The rule: only the LATEST-dated count per (source, material, store,
 * department, outlet) may be approved. Older ones are REFUSED and left sitting
 * in the queue — nothing is auto-decided, because rejecting is a judgement
 * about a real count a real person made.
 *
 * 'pending' AND 'approved' both supersede. 'rejected' does NOT: a rejection
 * moves no stock, so the older count's frozen baseline is still the live one
 * and approving it is still exactly right.
 *
 * THE SAME-DATE TIE-BREAK IS LOAD-BEARING, not padding. The pending-unique index
 * covers PENDING rows only, so an APPROVED row and a newer PENDING row can
 * legitimately share a date — which is precisely what "save with Adjust system
 * stock, then re-count the same day" produces. created_at decides those, and it
 * must decide them the right way round or that ordinary flow breaks.
 *
 * `self` is the alias of the row being judged, so this ONE text serves both the
 * correlated subquery in listVarianceApprovals (self = the outer `va`) and the
 * point lookup in findSupersedingCount (self = a one-row CTE of bound params).
 * If those two ever drift, the queue offers an Approve button the API refuses —
 * the most likely way this whole fix fails in practice. Do not inline either.
 *
 * COALESCE on the three key columns even though all are NOT NULL DEFAULT '':
 * a stray NULL would make the key never match itself (NULL = NULL is NULL), and
 * a supersede test that silently matches nothing fails OPEN.
 */
function supersedeWhere(self: string): string {
  return `
    nv.id <> ${self}.id
    AND nv.source      = ${self}.source
    AND nv.material_id = ${self}.material_id
    AND COALESCE(nv.store_id, '')      = COALESCE(${self}.store_id, '')
    AND COALESCE(nv.department_id, '') = COALESCE(${self}.department_id, '')
    -- OUTLET IS PART OF THE KEY ONLY WHERE THE STOCK RAIL IS ACTUALLY
    -- OUTLET-SEPARATED, WHICH FOR CENTRAL IT IS NOT.
    -- raw_materials.current_stock is ONE global pool: the central branch of
    -- approveVariance writes that single column with no outlet dimension. Keying
    -- the supersede test on outlet_id therefore reopens the exact double-apply
    -- this guard exists to stop, one axis over — and it is reachable today, not
    -- theoretical. variance_approvals is NOT in TABLES_NEEDING_OUTLET (db.ts), so
    -- rows written before outlet stamping keep outlet_id = '' and sit in the SAME
    -- admin queue as stamped rows (the scope filter matches the current outlet
    -- OR the empty one). Two counts
    -- of one material, one '' and one 'main', would each report "not superseded",
    -- both be approvable, and both post their frozen delta to the same pool.
    -- Liquor and department rows are genuinely partitioned — by store_id and
    -- department_id above, which are already in the key — so they keep the outlet
    -- term and are unaffected.
    AND (
      (COALESCE(${self}.source, '') = 'central' AND COALESCE(${self}.department_id, '') = '')
      OR COALESCE(nv.outlet_id, '') = COALESCE(${self}.outlet_id, '')
    )
    AND nv.status IN ('pending', 'approved')
    AND (
          nv.date > ${self}.date
       OR (nv.date = ${self}.date
           AND REPLACE(SUBSTR(nv.created_at, 1, 19), 'T', ' ')
             > REPLACE(SUBSTR(${self}.created_at, 1, 19), 'T', ' '))
    )
  `;
}

/**
 * Newest competing row first. `nv.id` is the last tie-break so an exact
 * (date, created_at) collision still resolves to ONE deterministic row — the
 * date and the status reported for it have to describe the same row.
 *
 * The SUBSTR/REPLACE normalisation in the predicate above is mirrored nowhere
 * here on purpose: every writer of this table is upsertVarianceApproval(), which
 * stamps datetime('now'), so created_at is uniformly 'YYYY-MM-DD HH:MM:SS' and
 * plain DESC orders it correctly. The normalisation exists only so a future
 * import path stamping ISO 'T' timestamps cannot silently shift a whole day
 * ('T' > ' ') in the comparison, which is the same trap deptMovementsAfter()
 * below already guards.
 */
const SUPERSEDE_ORDER = 'ORDER BY nv.date DESC, nv.created_at DESC, nv.id DESC';

/**
 * The newest count that supersedes `row`, or null when `row` IS the newest.
 * One indexed lookup (idx_variance_appr_material carries the material equality).
 *
 * A row with no `id` is still safe: the self-exclusion is belt-and-braces, since
 * a row can never satisfy a STRICT date/created_at inequality against itself.
 */
export function findSupersedingCount(
  db: Database.Database,
  row: VarianceKeyRow,
): SupersedingCount | null {
  const hit = db.prepare(`
    WITH self AS (
      SELECT ? AS id, ? AS source, ? AS material_id, ? AS store_id,
             ? AS department_id, ? AS outlet_id, ? AS date, ? AS created_at
    )
    SELECT nv.date AS date, nv.status AS status
      FROM variance_approvals nv, self
     WHERE ${supersedeWhere('self')}
     ${SUPERSEDE_ORDER}
     LIMIT 1
  `).get(
    norm(row.id), norm(row.source), norm(row.material_id), norm(row.store_id),
    norm(row.department_id), norm(row.outlet_id), norm(row.date), norm(row.created_at),
  ) as { date: string; status: string } | undefined;
  if (!hit) return null;
  return { date: String(hit.date), status: hit.status === 'approved' ? 'approved' : 'pending' };
}

/**
 * The refusal, worded in ONE place so the queue's amber notice and the API's
 * error are the same sentence. It names the date and tells the admin the two
 * ways out, because "refused" without a next step just moves the confusion.
 */
function supersededMessage(s: SupersedingCount): string {
  return (
    `A newer count dated ${s.date} was already ${s.status} for this item. ` +
    `Approve that one instead, or reject it first — approving this older count ` +
    `applies the same correction a second time.`
  );
}

/** `date|status` as packed by the list query, back into a SupersedingCount. */
function parseSuperseded(packed?: string | null): SupersedingCount | null {
  const s = String(packed ?? '');
  const cut = s.indexOf('|');
  // `< 0`, not `<= 0`: a packed "|pending" (a superseding row whose date is
  // somehow empty) means SUPERSEDED WITH AN UNKNOWN DATE, not "not superseded".
  // Reading it as the latter is the one drift this design exists to prevent —
  // the list would render Approve enabled on a row approveVariance refuses.
  // Empty dates are not reachable through either writer today; this is about
  // which way the parse fails if one ever becomes reachable.
  if (cut < 0) return null;
  const status = s.slice(cut + 1);
  if (status !== 'pending' && status !== 'approved') return null;
  return { date: s.slice(0, cut), status };
}

/** One material with more than one pending count stacked on a single key. */
export interface StackedPendingItem {
  material_id: string;
  material_name: string;
  /** How many pending rows are involved in the stack(s) for this material. */
  pending_count: number;
  /** Newest count date among them — the one that is actually approvable. */
  latest_date: string;
}

/**
 * Items whose pending queue holds MORE THAN ONE count on the same key, newest
 * first. This is the queue-level warning: it is what makes 963 pending rows
 * readable as "these N items will double-apply if you just work down the list".
 *
 * GROUPED BY THE SUPERSEDE KEY, NOT BY MATERIAL, then rolled up to the material
 * for display. Grouping by material_id alone would flag Curd counted in the
 * kitchen AND Curd counted centrally as a stack — two different rails, two
 * independent baselines, both legitimately approvable. That is a false alarm on
 * a banner whose whole job is to be believed. Counting only rows that really
 * share a key can never miss a real stack and never invents one.
 *
 * Scoped exactly like listVarianceApprovals: same INNER JOIN raw_materials (an
 * orphaned row is unreviewable, so warning about it helps nobody) and the same
 * outlet filter. `status` is honoured too — the field is called pending_count,
 * so a queue filtered to approved/rejected has no stack to warn about and gets
 * an empty array rather than a count of something else.
 */
export function stackedPendingCounts(
  db: Database.Database,
  opts: { status?: string; outletId?: string | null; outletScope?: VarianceOutletScope } = {},
): StackedPendingItem[] {
  const status = opts.status || 'pending';
  if (status !== 'pending' && status !== 'all') return [];

  const scope: VarianceOutletScope = opts.outletScope === 'all' ? 'all' : 'outlet';
  const oid = scope === 'all' ? '' : norm(opts.outletId);
  const params: unknown[] = [];
  let outletWhere = '';
  if (oid) { outletWhere = "AND (va.outlet_id = ? OR va.outlet_id = '')"; params.push(oid); }

  return db.prepare(`
    SELECT g.material_id            AS material_id,
           rm.name                  AS material_name,
           SUM(g.n)                 AS pending_count,
           MAX(g.latest_date)       AS latest_date
      FROM (
            SELECT va.material_id   AS material_id,
                   COUNT(*)         AS n,
                   MAX(va.date)     AS latest_date
              FROM variance_approvals va
              JOIN raw_materials rmk ON rmk.id = va.material_id
             WHERE va.status = 'pending' ${outletWhere}
             -- Grouped on the SAME key supersedeWhere() uses, including its
             -- central carve-out: outlet collapses to '' for central Store/
             -- Overall rows because that rail is one global pool. Without the
             -- CASE, a '' row and a 'main' row for one material form two groups
             -- of one, HAVING COUNT(*) > 1 never fires, and the banner reads
             -- clean over precisely the pair that double-applies. The banner and
             -- the guard have to agree or the banner is worse than absent.
             GROUP BY va.source, va.material_id, COALESCE(va.store_id, ''),
                      COALESCE(va.department_id, ''),
                      CASE WHEN va.source = 'central' AND COALESCE(va.department_id, '') = ''
                           THEN '' ELSE COALESCE(va.outlet_id, '') END
            HAVING COUNT(*) > 1
           ) g
      JOIN raw_materials rm ON rm.id = g.material_id
     GROUP BY g.material_id
     ORDER BY latest_date DESC, material_name COLLATE NOCASE
  `).all(...params) as StackedPendingItem[];
}

export interface VarianceRow {
  id: string; source: VarianceSource; material_id: string; material_name: string; material_sku: string;
  store_id: string; store_name: string; department_id: string; department_name: string;
  date: string; system_stock: number; physical_stock: number; variance: number; variance_value: number;
  unit: string; counted_by: string; count_note: string;
  status: string; reviewed_by: string; reviewed_at: string; review_reason: string; created_at: string;
  /**
   * ADDITIVE (2026-08). 1 ⇒ the BAR applied this row at count time; no human
   * decided it. Read it before rendering `reviewed_by` as a person: on these
   * rows it is AUTO_REVIEWER, and "approved by system:auto-apply" is the literal
   * truth rather than a name. 0 on every pending row and on every human
   * decision, including the admin's "Adjust system stock" tick — that one is a
   * person choosing, so it is NOT auto.
   */
  auto_applied?: number;
  /** ADDITIVE (2026-08). The submit this count arrived in. '' = unbatched. */
  batch_id?: string;
  /** ADDITIVE (2026-08). Human label for that submit. */
  batch_label?: string;
  /** Set only when approval is refused — the reason. See varianceApprovalBlock(). */
  approve_blocked?: string | null;
  /**
   * ADDITIVE (2026-08). The newest count competing with this one — see
   * supersedeWhere(). Non-null ⇒ approveVariance() WILL refuse this row, and
   * `approve_blocked` already carries the sentence saying so; these two fields
   * exist so the page can also say WHICH count wins without re-parsing it.
   */
  superseded_by_date?: string | null;
  superseded_by_status?: 'pending' | 'approved' | null;
  /**
   * ADDITIVE (2026-08). Live on-hand for THIS ROW'S OWN RAIL, in the SAME unit
   * basis as system_stock / physical_stock beside it (recipe units) — so the
   * page can finally show the real projection (live + variance) instead of the
   * unconditional "only if nothing moved since" caveat.
   *
   * null on department rows, and that is the honest answer, not a gap to fill:
   * a department balance comes from deptOnHand(), which is per-row machinery
   * (opening + anchor + ledger window) with no set-based form. Dragging it into
   * this query would be an N+1 over a queue that already runs to 963 rows. Do
   * NOT substitute rm.current_stock there — that is the CENTRAL pool and would
   * look authoritative while being wrong on every department row.
   *
   * Optional like approve_blocked above, for the same reason: only
   * listVarianceApprovals() computes these. A raw `SELECT *` row (approveVariance)
   * has none of them.
   */
  live_stock?: number | null;
}

export interface VarianceListResult {
  rows: VarianceRow[];
  /** Rows matching the SAME filters with no LIMIT — what `rows` is a slice of. */
  total: number;
  /** True when the LIMIT cut rows off the end, i.e. `rows` is not the whole story. */
  truncated: boolean;
  /** The limit actually applied, after clamping. */
  limit: number;
  /** The scope the rows were read under, echoed so a caller cannot mislabel them. */
  outletScope: VarianceOutletScope;
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE MONTHLY BATCH — how a queue of 1,472 becomes a once-a-month job.
 * ──────────────────────────────────────────────────────────────────────────
 * Closing stock is uploaded WEEKLY and reviewed ONCE A MONTH, so the queue has
 * to be addressable as "this upload" and "this period", not just "everything
 * pending". Until now listVarianceApprovals() took status, outlet and limit and
 * nothing else — there was no way to say "last month's four uploads" and no way
 * to act on them together, which is why clearing a bad sheet meant 1,472 clicks.
 *
 * ONE shared filter shape, used by the list, the count, the batch index and the
 * bulk reject — so what an admin PREVIEWS and what the bulk call ACTS ON are
 * described by the same object and cannot select different rows.
 */
export interface VarianceQueryOpts {
  /** 'pending' (default at the call sites) | 'approved' | 'rejected' | 'all'. */
  status?: string;
  /** Count date >= this (YYYY-MM-DD). Inclusive. */
  from?: string | null;
  /** Count date <= this (YYYY-MM-DD). Inclusive. */
  to?: string | null;
  /** Exactly one upload. '' is a REAL value here — it selects unbatched rows. */
  batchId?: string | null;
  /** 'central' | 'liquor'. Omit for both rails. */
  source?: string | null;
  outletId?: string | null;
  outletScope?: VarianceOutletScope;
}

/**
 * Append the period / upload / rail clauses. `where` and `params` are appended
 * in lockstep; the caller adds its outlet clause AFTER this and binds the same
 * array to every statement it runs.
 *
 * `batchId` uses `!= null` rather than truthiness on purpose: '' is a real
 * selector (rows saved before batches existed, or by a path that did not stamp
 * one), and reading it as "no filter" would make "clear the unbatched rows"
 * silently mean "clear everything".
 */
function applyScopeWhere(opts: VarianceQueryOpts, where: string[], params: unknown[]): void {
  const from = norm(opts.from);
  const to = norm(opts.to);
  if (from) { where.push('va.date >= ?'); params.push(from); }
  if (to) { where.push('va.date <= ?'); params.push(to); }
  if (opts.batchId != null) { where.push("COALESCE(va.batch_id,'') = ?"); params.push(norm(opts.batchId)); }
  const src = norm(opts.source);
  if (src) { where.push('va.source = ?'); params.push(src); }
}

/**
 * List approvals (default: pending first, newest first) WITH the honest total.
 *
 * WHY THIS RETURNS A TOTAL AND NOT JUST ROWS. The LIMIT here is not a page —
 * there is no offset to fetch the remainder with, so whatever falls past it is
 * simply absent from the admin's screen with nothing saying so. ORDER BY puts
 * pending first and then date DESC, so what overflows is the OLDEST pending
 * counts: precisely the ones that have waited longest and most need a decision.
 * With ~950 raw materials one closing sheet can fill the limit by itself. The
 * caller cannot be honest about that without knowing how many rows actually
 * matched, so it is counted here.
 *
 * The count runs the IDENTICAL FROM/JOIN/WHERE as the list — that is the whole
 * point of `fromWhere` below, and it must stay shared. Counting over a
 * different shape would report truncation that never happened: the JOIN on
 * raw_materials is an INNER join, so a row whose material was deleted is
 * dropped from BOTH here, and a count without that join would sit permanently
 * above the row count and pin `truncated` to true forever.
 */
export function listVarianceApprovals(
  db: Database.Database,
  opts: VarianceQueryOpts & { limit?: number } = {},
): VarianceListResult {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.status && opts.status !== 'all') { where.push('va.status = ?'); params.push(opts.status); }
  // ── PERIOD + UPLOAD (2026-08). Appended AFTER the status clause and BEFORE
  // the outlet clause, and pushed onto `params` in the same order they are
  // appended — both the list and the COUNT bind this one array, so a clause
  // added out of order silently shifts every later `?`.
  applyScopeWhere(opts, where, params);
  // Outlet scope. 'all' drops the filter entirely so rows stamped with ANOTHER
  // outlet become reachable — see VarianceOutletScope for why that is needed
  // and why it is opt-in.
  const scope: VarianceOutletScope = opts.outletScope === 'all' ? 'all' : 'outlet';
  const oid = scope === 'all' ? '' : norm(opts.outletId);
  if (oid) { where.push("(va.outlet_id = ? OR va.outlet_id = '')"); params.push(oid); }
  // FLOOR, not just clamp. `limit` is interpolated straight into `LIMIT ${limit}`
  // below (it cannot be bound as a parameter there), and SQLite throws
  // "datatype mismatch" on a fractional LIMIT — so `?limit=1.5` from the API
  // would 500 the entire queue and show the admin an empty list. Clamping alone
  // does not stop that; 1.5 is already inside 1..1000.
  const limit = Math.floor(Math.min(Math.max(Number(opts.limit) || 200, 1), 1000));

  // ONE source of truth for the row set. Both queries below bind `params` in
  // this same order, so they can only ever describe the same rows.
  const fromWhere = `
    FROM variance_approvals va
    JOIN raw_materials rm ON rm.id = va.material_id
    LEFT JOIN store_locations sl ON sl.id = va.store_id
    LEFT JOIN departments d ON d.id = va.department_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
  `;

  // THE TWO ADDITIONS BELOW ARE SELECT-LIST ONLY. `fromWhere` and `params` are
  // untouched, so the count still describes exactly these rows and the `?`
  // binding order is unchanged — both correlated subqueries reference the outer
  // `va` and bind nothing of their own. Adding a parameter to either would
  // silently shift every existing bind.
  const raw = db.prepare(`
    SELECT va.*, rm.name AS material_name, rm.sku AS material_sku,
           COALESCE(NULLIF(TRIM(rm.purchase_unit),''), rm.unit) AS material_purchase_unit,
           COALESCE(rm.pack_size, 1) AS material_pack_size,
           COALESCE(sl.name, '')  AS store_name,
           COALESCE(d.name, '')   AS department_name,
           -- ONE subquery packing both fields, not two returning one each. Two
           -- would each resolve the tie independently and could report the date
           -- of one competing row beside the status of another. '|' separates
           -- them because neither a YYYY-MM-DD date nor pending/approved can
           -- contain it. Correlated rather than a per-row findSupersedingCount()
           -- call: SQLite still evaluates it once per row, but inside the one
           -- statement and on an index seek, instead of 500 prepared-statement
           -- round trips out through JS. Measured at 963 pending rows: ~6 ms for
           -- the whole list, both new columns included.
           (SELECT nv.date || '|' || nv.status
              FROM variance_approvals nv
             WHERE ${supersedeWhere('va')}
             ${SUPERSEDE_ORDER}
             LIMIT 1) AS superseded_by,
           -- LIVE ON-HAND, RESOLVED PER RAIL — the one shortcut that must not be
           -- taken here is a single materials lookup for all three. See the
           -- live_stock note on VarianceRow. Liquor with no ledger row at all is
           -- genuinely 0 on hand, not unknown; department is NULL because there
           -- is no set-based source for it.
           CASE
             WHEN va.source = 'liquor' THEN (
               SELECT COALESCE(SUM(l.quantity), 0)
                 FROM store_stock_ledger l
                WHERE l.store_id = va.store_id AND l.material_id = va.material_id
             )
             WHEN COALESCE(va.department_id, '') = '' THEN rm.current_stock
             ELSE NULL
           END AS live_stock
    ${fromWhere}
    ORDER BY (va.status = 'pending') DESC, va.date DESC, va.created_at DESC
    LIMIT ${limit}
  `).all(...params) as (VarianceRow & { superseded_by?: string | null })[];

  // The packed column is an implementation detail of the query above; it is
  // destructured OFF the row so the wire shape stays exactly the documented one.
  const rows: VarianceRow[] = raw.map(r => {
    const { superseded_by, ...rest } = r;
    const superseding = parseSuperseded(superseded_by);
    return {
      ...rest,
      superseded_by_date: superseding?.date ?? null,
      superseded_by_status: superseding?.status ?? null,
      live_stock: r.live_stock == null ? null : Number(r.live_stock),
      // Additive: tell the queue up front which rows approveVariance() will
      // refuse, so the admin sees the reason instead of discovering it on click.
      // The supersede verdict is HANDED IN rather than looked up again — same
      // predicate, and one query for the whole page instead of one per row.
      approve_blocked: varianceApprovalBlock(db, r, r.department_name, { superseding }),
    };
  });

  // The two LEFT JOINs are kept in the count even though they cannot change its
  // value (both join on a primary key, so no fan-out) — carrying the identical
  // FROM is what makes "same rows" true by construction rather than by review.
  const total = Number(
    (db.prepare(`SELECT COUNT(*) AS n ${fromWhere}`).get(...params) as { n: number } | undefined)?.n,
  ) || 0;

  return {
    rows,
    total,
    truncated: total > rows.length,
    limit,
    outletScope: scope,
  };
}

export interface DecisionResult { ok: boolean; error?: string; applied?: boolean }

/**
 * Can this variance safely be APPROVED? Returns null when yes, otherwise the
 * reason to refuse (shown verbatim to the admin, and surfaced on the queue by
 * listVarianceApprovals so the refusal is visible before the click).
 *
 * FIRST, AND ON ALL THREE RAILS: IS A NEWER COUNT ALREADY IN PLAY? Approving an
 * older count after a newer one applies the same frozen baseline correction
 * twice — see supersedeWhere() for the measured case. That is not a department
 * problem, it is a delta problem, so this check runs BEFORE the central/liquor
 * early-out below and not after it. It is also the reason this function gained a
 * fourth parameter: the queue resolves the verdict for every row in one query
 * and hands it in, so the page and the API can never disagree about which rows
 * are approvable.
 *
 * The remaining reasons are department-only.
 *
 * A department count is now APPROVABLE — it posts a signed 'adjustment' to that
 * department's own ledger and leaves central alone (see approveVariance). What
 * survives here are the three states in which that posting would be a lie:
 *
 *  1. STORE-MAPPED (liquor). Store-mapped materials live on the TGBCL rail and
 *     are skipped by BOTH the central debit and the department credit at issue,
 *     so they never have a department ledger balance to correct. Posting one
 *     here would invent the department rail's only liquor row and put the same
 *     bottle on two rails. This carve-out is deliberate, not an oversight —
 *     do not "complete" it.
 *  2. NEVER COUNTED. No cutover `opening` row and no anchor, so the department
 *     has no balance to take a delta FROM. The first measurement of a
 *     department is an OPENING, which is an admin action with its own
 *     idempotency (POST /api/department-ledger/cutover) — minting one from the
 *     approval queue would stack a second opening and skip that guard.
 *  3. THE DOUBLE-ANCHOR. dept-ledger's latestCount() anchors a department
 *     balance on the newest closing_stock row, so the count re-bases the
 *     balance the moment it is SAVED — measured: an opening of 5000 plus a
 *     PENDING count of 4800 already reads 4800, with anchorSource flipping to
 *     'count', before anyone approves. While that is true, the count and this
 *     adjustment are two mechanisms for one correction and applying both takes
 *     the difference off twice (4800 → 4600). It also makes Reject a lie: the
 *     balance already moved. Refusing is the honest state until the anchor is
 *     resolved; see the handoff on dept-ledger.ts. The post-condition assert in
 *     approveVariance is the second line of defence and must stay even after
 *     this one is retired.
 *
 * Central Store/Overall rows (department_id '') are blocked by ONE thing and
 * only one: the central cutover floor — see centralCutoverBlock() below. Before
 * a cutover is committed that returns null and they are never blocked, which is
 * what this comment used to say outright and is no longer the whole truth.
 * Liquor rows are still never blocked here: they post a delta to the store
 * ledger, which no central cutover touches.
 */
/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ THE CENTRAL CUTOVER FLOOR — the central twin of the department refusal.  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A pending central row FREEZES system_stock at count time, and the central
 * branch of approveVariance() posts (physical − that frozen system) onto LIVE
 * raw_materials.current_stock. Correct while the book it was frozen against is
 * still the book. A central-store cutover REPLACES that book: commitBatch SETs
 * current_stock to the physically counted figure and stamps the date.
 *
 * Approving a pre-cutover row after that posts a delta measured against the
 * OLD, drifted book on top of the freshly corrected one — it re-injects exactly
 * the drift the cutover just eliminated, ONE CLICK AT A TIME, and 963 pending
 * rows is 963 chances to undo it silently. Nothing about the row looks wrong on
 * screen; the arithmetic is simply against a baseline that no longer exists.
 *
 * THIS IS THE SAME REFUSAL THE DEPARTMENT BRANCH ALREADY MAKES ("This count is
 * dated before the department's opening balance, so it cannot be applied — it
 * would reach back past the cutover"). Central had no equivalent.
 *
 * WHICH INSTANT DECIDES. The question is not "which day was counted" but "was
 * this row's frozen system figure read from the old book or the new one", so
 * the boundary is central_store_cutover_committed_at — the real UTC instant
 * current_stock was re-based — and NOT central_store_cutover_at, which is a
 * business date at midnight and would wave through everything typed on the
 * cutover day before the commit. The count instant is the same MIN(IST day-end
 * of the count date, when it was saved) the department branch uses, so a count
 * dated the 5th and typed on the 12th is judged on the 5th.
 *
 * FALLBACKS, BOTH FAIL CLOSED:
 *   · committed-at missing (a stamp written by hand) → fall back to comparing
 *     business dates, which still catches every count dated before the cutover.
 *   · no usable count instant at all → refuse. A row whose age cannot be
 *     established cannot be proven to post against the current book, and
 *     Reject is always available.
 *
 * Returns the sentence to show, or null when there is nothing to refuse —
 * including on every install with no cutover committed, where
 * getCentralStoreCutoverDate() is null and this is a no-op.
 */
export function centralCutoverBlock(
  db: Database.Database,
  row: VarianceKeyRow,
): string | null {
  const cutDate = getCentralStoreCutoverDate(db);
  if (!cutDate) return null;

  const committedAt = getCentralStoreCutoverCommittedAt(db);
  const countAt = deptCountInstant(String(row.date ?? '').trim(), String(row.created_at ?? '').trim());
  const rowDate = String(row.date ?? '').trim().slice(0, 10);

  const stale = committedAt
    ? (!countAt || countAt < committedAt)
    : (!rowDate || rowDate < cutDate);
  if (!stale) return null;

  return (
    `The central store was cut over on ${cutDate} — its stock was re-based onto a physical count that day. ` +
    `This count (${rowDate || 'undated'}) was taken against the OLD book, so its difference of ` +
    `(counted − system-at-count-time) no longer describes anything: approving it would post months of ` +
    `pre-cutover drift back onto the corrected stock. Reject it. If the shelf is wrong TODAY, count it again ` +
    `and approve that count instead.`
  );
}

export function varianceApprovalBlock(
  db: Database.Database,
  row: VarianceKeyRow,
  deptName?: string | null,
  /**
   * The supersede verdict, already resolved. Pass it (with an explicit `null`
   * for "nothing supersedes this") from a caller that has just computed it in
   * bulk; omit the whole object and this looks it up itself. The property is
   * REQUIRED inside the object on purpose — an optional one would let a typo'd
   * or undefined field read as "not superseded" and fail OPEN.
   */
  precomputed?: { superseding: SupersedingCount | null },
): string | null {
  const superseding = precomputed ? precomputed.superseding : findSupersedingCount(db, row);
  if (superseding) return supersededMessage(superseding);

  if (String(row.source) !== 'central') return null;
  const deptId = norm(row.department_id);
  if (!deptId) {
    // CENTRAL STORE (no department): the cutover floor. Placed here, in the
    // shared block, so the queue disables Approve on exactly the rows the
    // approval will refuse — a list that renders Approve on a row the server
    // then rejects is how an admin ends up clicking 963 times.
    const cut = centralCutoverBlock(db, row);
    if (cut) return cut;
    // THE SECOND WAY THE BOOK CAN LAG THE SHELF, and the newer one. A GRN held
    // for a kitchen quality check has its goods on the shelf and off the book
    // ON PURPOSE, so a count taken in that window bakes the whole delivery into
    // its variance — and the sign-off then adds the same crate again. Exactly
    // the cutover argument at a smaller scale; see qcHoldBlockForCount() in
    // src/lib/grn-qc.ts for the worked example. Returns null on a database that
    // has never held anything, which is every database until this feature is
    // armed.
    return qcHoldBlockForCount(db, norm(row.material_id),
      deptCountInstant(String(row.date ?? '').trim(), String(row.created_at ?? '').trim()));
  }

  const who = norm(deptName) || 'this department';
  const matId = norm(row.material_id);
  if (!matId) return 'Count has no material — cannot be approved.';

  if (isStoreMappedMaterial(db, matId)) {
    return (
      `Liquor / store-mapped item — cannot be approved as a department count. This item is tracked on the ` +
      `liquor store ledger, not on ${who}'s raw-material stock, so there is no department balance to correct. ` +
      `Reject it and record the count against the store it belongs to.`
    );
  }

  const bal = deptOnHand(db, deptId, matId);
  if (bal.neverCounted || bal.onHand === null) {
    return (
      `${who} has no opening balance for this item yet, so a counted difference cannot be worked out. ` +
      `Record the department's opening stock first (the cutover count), then re-count. ` +
      `Reject this one — nothing moves.`
    );
  }
  if (bal.anchorSource === 'count') {
    return (
      `${who}'s balance is already anchored on a closing count, so this count has ALREADY moved the ` +
      `department's stock on its own. Approving would take the difference off a second time. ` +
      `REJECTING DOES NOT PUT IT BACK EITHER — the balance moved when the count was saved, and reject ` +
      `only closes this row. Reject it to clear the queue, then correct the figure with a fresh count. ` +
      `New department counts are no longer parked here at all (they cannot be held, so claiming a hold ` +
      `was the lie this row is left over from); the underlying fix is in the department ledger, where a ` +
      `count must not re-base a balance before it is approved.`
    );
  }
  return null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The department delta, as of the COUNT — not as of the approval.
 * ──────────────────────────────────────────────────────────────────────────*/

/** 3 dp, the rounding this table has always stored variances in. */
const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Floating-point slack. Below this a delta is nothing, not a movement. */
const EPS = 1e-6;

/**
 * The instant a count speaks for, in the ledger's UTC basis.
 *
 * MIRRORS dept-ledger's countAnchorAt(): MIN(IST day-end of the count date,
 * when it was saved). MIN, not MAX, and both directions of getting it wrong
 * lose real movement — a count typed at 3pm must not swallow the 5pm issue that
 * followed it, and a count for the 1st typed on the 5th must not swallow four
 * days. 23:59:59 IST = 18:29:59 UTC on the SAME day (IST = UTC+5:30), so no
 * date rollover.
 *
 * This is a DUPLICATE of a rule that should have one home. It exists only
 * because deptOnHand() has no `asOf` parameter; when it gets one, delete this
 * and the query below. Do not let the two definitions drift in the meantime.
 */
function deptCountInstant(date: string, createdAt: string): string {
  const raw = String(createdAt || '').trim();
  // Same bare-date rule as dept-ledger's normTs(): a date with no time means the
  // START of that day. An import path that stamps created_at as 'YYYY-MM-DD'
  // would otherwise compare as a 10-char string and sort BEFORE the same day's
  // 00:00:00 here while sorting AT 00:00:00 there — the two windows would then
  // disagree on exactly the rows an import creates.
  const saved = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw} 00:00:00` : raw.slice(0, 19).replace('T', ' ');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '').trim())) return saved;
  const dayEnd = `${String(date).trim()} 18:29:59`;
  return saved && saved < dayEnd ? saved : dayEnd;
}

/**
 * Signed department movement strictly after `instant`. Same normalisation as
 * dept-ledger (19 chars, 'T' → ' '): comparing a raw ISO 'T' timestamp against
 * a raw ledger timestamp silently shifts a whole day, because 'T' > ' '.
 *
 * Deliberately NOT wrapped in a try/catch. A swallowed error here would return
 * 0, which reads as "nothing moved since the count" and would put every
 * post-count movement into the adjustment — the very overwrite this file exists
 * to stop. Throwing rolls the caller's transaction back instead.
 */
function deptMovementsAfter(db: Database.Database, deptId: string, matId: string, instant: string): number {
  if (!instant) return 0;
  const row = db.prepare(`
    SELECT COALESCE(SUM(quantity), 0) AS s
      FROM department_material_transactions
     WHERE department_id = ? AND material_id = ?
       AND REPLACE(SUBSTR(created_at, 1, 19), 'T', ' ') > ?
  `).get(deptId, matId, instant) as { s: number } | undefined;
  return r3(Number(row?.s) || 0);
}

/**
 * Approve a pending variance → move stock to the physical count and log it.
 * `reason` is the explanation the admin recorded after asking the staff.
 */
export function approveVariance(
  db: Database.Database, id: string, reviewer: string, reason: string,
  /**
   * ADDITIVE (2026-08). `auto: true` stamps auto_applied = 1 — this row was
   * applied by the BAR at count time, not decided by a person. It changes
   * NOTHING about what is written to stock: same delta, same floors, same
   * supersede guard, same inventory_transactions row. It only stops the audit
   * trail claiming a human reviewed it. Default false, so every existing caller
   * (the queue's approve route, and the admin's "Adjust system stock" tick,
   * which IS a person choosing) keeps recording a human decision.
   */
  opts?: { auto?: boolean },
): DecisionResult {
  const row = db.prepare(`SELECT * FROM variance_approvals WHERE id = ?`).get(id) as (VarianceRow & Record<string, unknown>) | undefined;
  if (!row) return { ok: false, error: 'Variance approval not found' };
  if (row.status !== 'pending') return { ok: false, error: `Already ${row.status}` };

  // Refuse the department-clobber case AND the superseded-count case BEFORE
  // anything is written. See varianceApprovalBlock().
  //
  // THE GUARD LIVES HERE, NOT IN THE ROUTE, because the route is not the only
  // caller: POST /api/closing-stock calls approveVariance() directly for the
  // admin "Adjust system stock" tick. That path normally passes — the count it
  // just saved IS the newest, and a same-date row approved earlier today has an
  // OLDER created_at so it does not supersede. What it now refuses is a
  // BACKDATED save made after a newer count already corrected the item: there
  // the count still saves, the approval stays pending, and the admin is told
  // why. That refusal is the fix working, not a regression — it is exactly the
  // double-application this guard exists to stop.
  //
  // No precomputed verdict is passed, so this does its own one-row lookup.
  let deptName = '';
  if (norm(row.department_id)) {
    try {
      deptName = (db.prepare(`SELECT name FROM departments WHERE id = ?`).get(row.department_id) as
        { name?: string } | undefined)?.name || '';
    } catch { /* name is cosmetic */ }
  }
  const blocked = varianceApprovalBlock(db, row, deptName);
  if (blocked) return { ok: false, error: blocked };

  const apply = db.transaction(() => {
    if (row.source === 'liquor') {
      // Reconcile the store ledger to the physical count as of the count date.
      const ledgerId = postLedger(db, {
        store_id: row.store_id,
        material_id: row.material_id,
        txn_type: 'adjustment',
        quantity: row.variance,        // signed (physical − system), recipe units
        unit_cost: 0,
        ref: `variance-approval:${row.date}`,
        notes: `Approved variance ${row.date}: system ${row.system_stock} → physical ${row.physical_stock} ${row.unit}`,
        created_by: reviewer,
      });
      /* ══════════════════════════════════════════════════════════════════════
       * THE CORRECTION IS STAMPED IN THE PERIOD IT CORRECTS, NOT TODAY.
       * ══════════════════════════════════════════════════════════════════════
       * THE LIQUOR RAIL IS THE ONE PATH WHERE `system_stock` IS NOT LIVE. It is
       * the ledger AS OF THE COUNT DATE — asOfStats() in
       * src/app/api/stores/[id]/closing/route.ts:39 sums
       * `WHERE date(created_at) <= date(?)`. postLedger() stamps
       * `created_at = datetime('now')` (store-engine.ts:365) and takes no date,
       * so a correction for a BACKDATED count landed OUTSIDE its own as-of
       * window: the next read of that date, and of every date between it and
       * today, saw the same stale baseline and raised the same variance again.
       *
       * MEASURED — three weekly counts, shelf genuinely 73,500 all month:
       *   08-02 system 75000 counted 73500 → applied → live 73500
       *   08-09 system 75000 (stale!)      → applied → live 72000
       *   08-16 system 75000 (stale!)      → applied → live 70500
       *   shelf 73500, book 70500 — over-corrected by 3,000, nobody in the loop.
       * It corrupted the reviewed path too: an auto-applied week-1 row left a
       * stale baseline frozen into a HELD week-2 row, and supersedeWhere()
       * cannot catch that (the poisoning row is OLDER, so it does not supersede).
       *
       * Re-stamping the row it just wrote closes it at the source, for every
       * reader rather than for this function only: the next as-of read of any
       * date on or after the count date now includes the correction, so a
       * re-count of that week reports `match` instead of the same difference a
       * second time. It is one UPDATE of one column on the ONE row postLedger
       * returned — postLedger keeps every validation it has (store active,
       * material known, signed non-zero quantity); nothing here writes a ledger
       * row of its own.
       *
       * NEVER INTO THE FUTURE: MIN(count-date day-end, now). A count dated today
       * or (impossibly) later keeps `now`, so the ordinary same-day correction
       * is stamped exactly as it always was and only backdated counts move.
       * The central rail is deliberately NOT given this treatment — it has no
       * as-of read at all (its system figure is live current_stock), so there is
       * nothing there for a stamp to line up with.
       * ──────────────────────────────────────────────────────────────────── */
      const countDate = String(row.date ?? '').trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(countDate)) {
        db.prepare(`
          UPDATE store_stock_ledger
             SET created_at = MIN(?, datetime('now'))
           WHERE id = ?
        `).run(`${countDate} 23:59:59`, ledgerId);
      }
    } else if (norm(row.department_id)) {
      // ── DEPARTMENT count → the department's own ledger. CENTRAL IS NOT TOUCHED.
      //
      // The count says: at count time this department's shelf held `physical`,
      // while its ledger said `baseline`. The correction is that difference, and
      // ONLY that difference — every movement the department made after the
      // count (the lunch service it cooked while the approval sat in the queue)
      // has to survive, exactly as on the central branch above.
      //
      //   baseline = balance_now − movements_since_the_count
      //   delta    = counted − baseline
      //   result   = counted + movements_since_the_count
      //
      // Forcing the balance to `counted` instead would erase that service and
      // book it as a correction, which is the department-side twin of the
      // absolute-set bug.
      const deptId = norm(row.department_id);
      const counted = Number(row.physical_stock) || 0;

      const bal = deptOnHand(db, deptId, row.material_id);
      // varianceApprovalBlock() has already refused neverCounted; belt-and-braces
      // so a future caller that skips the block cannot post against a null.
      if (bal.onHand === null) throw new Error(`${deptName || 'Department'} has no opening balance for this item`);

      const countAt = deptCountInstant(String(row.date), String(row.created_at));

      // A COUNT THAT PREDATES THE ANCHOR CANNOT BE APPLIED. `baseline` below
      // rewinds the balance by the movements made after the count, which only
      // means anything while the count sits INSIDE the current window. For a
      // count dated before the opening row (or before the cutover floor), the
      // rewind subtracts movement the balance never included and the arithmetic
      // is nonsense — measured on a backdated count: a −200 correction came out
      // as +4800. It is also decision D: nothing dated before the cutover may
      // enter a department balance, and a backdated count is exactly how that
      // floor gets walked around. Refuse, and say which date wins.
      //
      // Strictly before, not `<=`: a count stamped in the SAME second as the
      // opening is the cutover day itself — the ordinary "count the kitchen,
      // enter it as opening, count again" morning — and is legitimately
      // approvable against that opening.
      if (countAt < bal.windowFrom) {
        throw new Error(
          `This count (${row.date}) is dated before ${deptName || 'the department'}'s opening balance ` +
          `(${bal.windowFrom}), so it cannot be applied — it would reach back past the cutover. ` +
          `Reject it and re-count.`,
        );
      }

      const movedSince = deptMovementsAfter(db, deptId, row.material_id, countAt);
      const baseline = r3(bal.onHand - movedSince);
      const delta = r3(counted - baseline);

      if (Math.abs(delta) > EPS) {
        // NO inventory_transactions ROW HERE. That table is the CENTRAL rail and
        // is what the Variance and Sales-vs-Purchase reports read; writing this
        // department correction into it would fabricate a central adjustment out
        // of stock that never left the store. The two writes below/above look
        // parallel and are not — do not merge them.
        postDeptLedger(db, {
          departmentId: deptId,
          materialId: row.material_id,
          type: 'adjustment',
          quantity: delta,              // SIGNED. − = the shelf held less than the ledger said.
          outletId: norm(row.outlet_id as string) || null,
          referenceId: id,
          source: 'variance-approval',
          user: norm(reviewer),
          notes:
            `Approved department count ${row.date}: counted ${counted} ${row.unit} vs ledger ${baseline} ` +
            `at count time (${movedSince === 0 ? 'no movement since' : `${movedSince} moved since`})`,
        });

        // POST-CONDITION, and the reason this branch can never double-correct.
        // If some other mechanism also re-bases a department balance from a
        // count (see the double-anchor note in varianceApprovalBlock), the
        // arithmetic below will not land and this throws, rolling the whole
        // approval back. Keep it even when that anchor is fixed: it is what
        // makes "the ledger is the one truth" checkable rather than asserted.
        const after = deptOnHand(db, deptId, row.material_id);
        const expected = r3(counted + movedSince);
        if (after.onHand === null || Math.abs(after.onHand - expected) > EPS) {
          throw new Error(
            `Department balance did not land where the count says it should ` +
            `(expected ${expected}, got ${after.onHand}). Nothing was changed. ` +
            `Another mechanism is re-basing this balance from the same count.`,
          );
        }
      }
    } else {
      // ── CENTRAL STORE count → raw_materials.current_stock.
      //
      // Post the COUNT-TIME delta (physical − system-as-counted) on top of
      // whatever central holds now. Recomputed from the two stored figures
      // rather than read off the stored `variance` column, so a row whose
      // variance was written by some other path still applies its own
      // definition.
      //
      // WHY NOT `SET current_stock = physical_stock`: count the store at 100 at
      // 10am, issue 40 kg to a kitchen at noon, approve at 4pm. The absolute set
      // writes 100 back — un-issuing the 40 kg that a department is standing
      // there holding, so the same 40 kg is on two rails at once. The delta
      // lands at 60 and the issue survives, which is the invariant: every gram
      // leaves central exactly once.
      //
      // NO FLOOR AT ZERO. If the delta takes central negative, central goes
      // negative and says so. Clamping would manufacture stock that nobody
      // bought, and hide the very gap a count exists to reveal.
      // THE CUTOVER FLOOR, a second time. varianceApprovalBlock() above already
      // refused this row, and this is the belt-and-braces copy for the same
      // reason the department branch keeps its own windowFrom check: this
      // function is not only reached through the queue (POST /api/closing-stock
      // calls it directly for the admin "Adjust system stock" tick), and the
      // failure mode here is silent — a stale delta posted onto a re-based book
      // looks like an ordinary correction and undoes the cutover one row at a
      // time. Throwing rolls the whole approval back.
      const floorMsg = centralCutoverBlock(db, row as VarianceKeyRow);
      if (floorMsg) throw new Error(floorMsg);
      // THE QC-HOLD FLOOR, belt-and-braces for the same reason and in the same
      // place: POST /api/closing-stock calls approveVariance() DIRECTLY for the
      // admin "Adjust system stock" tick, with no queue and no second click, so
      // varianceApprovalBlock() above is not on that path at all. Without this
      // copy, ticking that box on a day a delivery was held posts the delivery
      // onto the book a second time, silently, inside the save.
      const qcHoldMsg = qcHoldBlockForCount(db, norm(row.material_id),
        deptCountInstant(String(row.date ?? '').trim(), String(row.created_at ?? '').trim()));
      if (qcHoldMsg) throw new Error(qcHoldMsg);

      const cur = db.prepare(`SELECT current_stock FROM raw_materials WHERE id = ?`).get(row.material_id) as { current_stock: number } | undefined;
      const before = r3(Number(cur?.current_stock) || 0);
      const appliedDelta = r3(Number(row.physical_stock) - Number(row.system_stock));
      const after = r3(before + appliedDelta);
      if (Math.abs(appliedDelta) > EPS) {
        db.prepare(`UPDATE raw_materials SET current_stock = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(after, row.material_id);
        db.prepare(`
          INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at)
          VALUES (?, ?, 'adjustment', ?, ?, ?, datetime('now'))
        `).run(
          generateId(), row.material_id, appliedDelta, id,
          `Approved variance ${row.date}: counted ${row.physical_stock} ${row.unit} against count-time system ` +
          `${row.system_stock} (delta ${appliedDelta}); central ${before} → ${after}`,
        );
      }
    }
    db.prepare(`
      UPDATE variance_approvals SET status='approved', reviewed_by=?, reviewed_at=datetime('now'),
             review_reason=?, auto_applied=? WHERE id=?
    `).run(norm(reviewer), norm(reason), opts?.auto === true ? 1 : 0, id);
  });

  try { apply(); } catch (e) { return { ok: false, error: (e as Error).message }; }
  return { ok: true, applied: true };
}

/**
 * Reject a pending variance → stock unchanged; variance stands as an open loss.
 *
 * DELIBERATELY NOT SUPERSEDE-GATED. Rejecting is how a superseded count leaves
 * the queue, so gating it would strand every stale row permanently — and it
 * moves no stock, so there is nothing to double-apply. Only approveVariance()
 * carries that guard.
 */
export function rejectVariance(
  db: Database.Database, id: string, reviewer: string, reason: string,
): DecisionResult {
  const row = db.prepare(`SELECT status FROM variance_approvals WHERE id = ?`).get(id) as { status: string } | undefined;
  if (!row) return { ok: false, error: 'Variance approval not found' };
  if (row.status !== 'pending') return { ok: false, error: `Already ${row.status}` };
  db.prepare(`
    UPDATE variance_approvals SET status='rejected', reviewed_by=?, reviewed_at=datetime('now'), review_reason=? WHERE id=?
  `).run(norm(reviewer), norm(reason), id);
  return { ok: true, applied: false };
}

/* ════════════════════════════════════════════════════════════════════════════
 * 5. BULK REJECT — and why there is deliberately no bulk approve.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *      REJECT MEANS DISCARD THE COUNT AND LEAVE STOCK EXACTLY AS IT IS.
 *
 * That is not a claim, it is the shape of the code: the function below runs ONE
 * statement, an UPDATE of variance_approvals.status, and it references no other
 * table. There is no call to approveVariance, postLedger, postDeptLedger or
 * raw_materials anywhere in it or below it. Nothing it can do moves a gram.
 * (rejectVariance() above is deliberately not supersede-gated for the same
 * reason — rejecting is how a stale count leaves the queue, and it moves
 * nothing, so there is nothing to double-apply.)
 *
 * THE ASYMMETRY IS THE POINT. Approving 793 rows that read "we have zero" would
 * write 793 empty shelves into the books in one click — the single most
 * destructive action this module can perform. Rejecting the same 793 changes no
 * number anywhere; it only stops them nagging. So bulk exists on exactly one
 * side, and the caller cannot cross over: the HTTP route that fronts this
 * (src/app/api/variance-approvals/bulk/route.ts) does not import approveVariance
 * at all, so there is no argument, typo or `action` string that reaches an
 * approval from there. Keep it that way — the day someone adds "and approve too"
 * for symmetry is the day this becomes the most dangerous endpoint in the app.
 *
 * ONLY PENDING ROWS MOVE. `status = 'pending'` is in the UPDATE's own WHERE, not
 * merely in the preview that selected the ids, so a row decided between the
 * preview and the execute is skipped rather than re-decided.
 */
export interface BulkRejectResult {
  ok: boolean;
  /** How many pending rows were actually rejected. */
  rejected: number;
  /** How many of the requested ids were not pending (already decided / gone). */
  skipped: number;
  error?: string;
}

/**
 * Reject many pending variances in one call. Stock is untouched — see above.
 *
 * Exactly one of `ids` or `filter` selects the rows. Both, or neither, is a
 * refusal rather than a guess: "ids plus a filter" has two obvious meanings
 * (intersection or union) and picking one silently is how a bulk action rejects
 * rows nobody looked at.
 */
export function rejectVarianceBulk(
  db: Database.Database,
  sel: { ids?: string[]; filter?: VarianceQueryOpts },
  reviewer: string,
  reason: string,
): BulkRejectResult {
  const ids = Array.isArray(sel.ids) ? sel.ids.map(v => norm(v)).filter(Boolean) : null;
  const hasIds = !!ids && ids.length > 0;
  const hasFilter = !!sel.filter;
  if (hasIds === hasFilter) {
    return { ok: false, rejected: 0, skipped: 0, error: 'Select rows either by id list or by filter — not both, and not neither.' };
  }
  const why = norm(reason);
  if (why.length < 2) {
    return { ok: false, rejected: 0, skipped: 0, error: 'A reason is required to reject (why are these counts being discarded?).' };
  }

  const run = db.transaction((): BulkRejectResult => {
    // ── THE ONLY WRITE IN THIS FUNCTION, on the only table it names. ────────
    const upd = db.prepare(`
      UPDATE variance_approvals
         SET status='rejected', reviewed_by=?, reviewed_at=datetime('now'), review_reason=?
       WHERE id = ? AND status = 'pending'
    `);
    let rejected = 0;
    let target: string[];

    if (hasIds) {
      target = ids!;
    } else {
      // Resolve the filter to ids FIRST, then reject them one by one through the
      // same statement. A single `UPDATE ... WHERE <filter>` would be one query
      // shorter and would also make `rejected` unverifiable and the row set
      // unreportable — and this is the call that clears a thousand rows.
      target = pendingIdsForFilter(db, sel.filter!);
    }
    for (const id of target) rejected += upd.run(norm(reviewer), why, id).changes;
    return { ok: true, rejected, skipped: Math.max(0, target.length - rejected) };
  });

  try { return run(); } catch (e) { return { ok: false, rejected: 0, skipped: 0, error: (e as Error).message }; }
}

/**
 * The pending ids a filter selects, in queue order. Shared by the bulk preview
 * and the bulk execute, so "you are about to reject 793" and "793 were
 * rejected" are the same query and cannot describe different rows.
 *
 * Status is FORCED to pending regardless of what the caller passed: an
 * approved row cannot be rejected (approveVariance already moved stock), and
 * letting a filter reach one would silently mark a completed decision as
 * discarded while the stock stayed moved.
 */
export function pendingIdsForFilter(db: Database.Database, filter: VarianceQueryOpts): string[] {
  const where: string[] = ["va.status = 'pending'"];
  const params: unknown[] = [];
  applyScopeWhere(filter, where, params);
  const scope: VarianceOutletScope = filter.outletScope === 'all' ? 'all' : 'outlet';
  const oid = scope === 'all' ? '' : norm(filter.outletId);
  if (oid) { where.push("(va.outlet_id = ? OR va.outlet_id = '')"); params.push(oid); }
  return (db.prepare(`
    SELECT va.id AS id
      FROM variance_approvals va
      JOIN raw_materials rm ON rm.id = va.material_id
     WHERE ${where.join(' AND ')}
     ORDER BY va.date DESC, va.created_at DESC
  `).all(...params) as { id: string }[]).map(r => r.id);
}

/** One upload, as the monthly review sees it. */
export interface CountBatch {
  batch_id: string;
  batch_label: string;
  /** Earliest and latest COUNT date in the batch. */
  first_date: string;
  last_date: string;
  /** When the upload happened. */
  uploaded_at: string;
  pending: number;
  approved: number;
  rejected: number;
  /** Sum of |variance_value| over the PENDING rows — what is still undecided. */
  pending_value: number;
}

/**
 * The uploads, newest first — the index the monthly review picks from.
 *
 * Unbatched rows (batch_id '') are reported as their own entry rather than
 * hidden: on the owner's live data every existing row is unbatched, so dropping
 * them would render an empty batch list over a queue of 1,472 and read as
 * "nothing to review".
 */
export function listCountBatches(
  db: Database.Database,
  opts: { outletId?: string | null; outletScope?: VarianceOutletScope; limit?: number } = {},
): CountBatch[] {
  const scope: VarianceOutletScope = opts.outletScope === 'all' ? 'all' : 'outlet';
  const oid = scope === 'all' ? '' : norm(opts.outletId);
  const params: unknown[] = [];
  let outletWhere = '';
  if (oid) { outletWhere = "WHERE (va.outlet_id = ? OR va.outlet_id = '')"; params.push(oid); }
  const limit = Math.floor(Math.min(Math.max(Number(opts.limit) || 60, 1), 500));
  return (db.prepare(`
    SELECT COALESCE(va.batch_id,'')                                        AS batch_id,
           COALESCE(MAX(NULLIF(va.batch_label,'')),'')                     AS batch_label,
           MIN(va.date)                                                    AS first_date,
           MAX(va.date)                                                    AS last_date,
           MAX(va.created_at)                                              AS uploaded_at,
           SUM(CASE WHEN va.status='pending'  THEN 1 ELSE 0 END)           AS pending,
           SUM(CASE WHEN va.status='approved' THEN 1 ELSE 0 END)           AS approved,
           SUM(CASE WHEN va.status='rejected' THEN 1 ELSE 0 END)           AS rejected,
           SUM(CASE WHEN va.status='pending' THEN ABS(va.variance_value) ELSE 0 END) AS pending_value
      FROM variance_approvals va
      JOIN raw_materials rm ON rm.id = va.material_id
      ${outletWhere}
     GROUP BY COALESCE(va.batch_id,'')
     ORDER BY uploaded_at DESC
     LIMIT ${limit}
  `).all(...params) as CountBatch[]).map(b => ({
    ...b,
    pending: Number(b.pending) || 0,
    approved: Number(b.approved) || 0,
    rejected: Number(b.rejected) || 0,
    pending_value: Math.round((Number(b.pending_value) || 0) * 100) / 100,
  }));
}

/* ════════════════════════════════════════════════════════════════════════════
 * 6. THE IMMEDIATE ALERT — "this one should not wait for month end".
 * ═══════════════════════════════════════════════════════════════════════════
 * AN ALERT, NEVER A SECOND GATE. Whether the stock moved was already decided by
 * the bar at save time; this only decides whether the admin hears about it
 * TODAY. Nothing below writes anything.
 *
 * The predicate is the SQL twin of isBigVariance() and must stay in step with
 * it: rupee value OR share of the item's own system stock, whichever fires
 * first, both tunable, both off (0) by default, and the share axis carrying the
 * SAME materiality floor (ALERT_MIN_VALUE / ALERT_MIN_QTY). `ABS(va.system_stock)
 * > 0` guards the denominator — see isBigVariance for why an undefined share
 * must not count as an infinite one. Both halves live in bigVarianceWhere()
 * below so the badge and the list cannot drift apart.
 *
 * OFF BY DEFAULT IS LOAD-BEARING HERE. This ships onto a live queue of 1,472
 * pending rows; any non-zero shipped default would badge hundreds of historical
 * counts on the first boot after deploy, which is how a bell stops being read.
 * The FLOORS ship armed and the thresholds do not, because a floor can only
 * ever suppress.
 *
 * WHICH ROWS THE ALERT CAN SEE — and the two corrections here:
 *
 *   · SUPERSEDED ROWS ARE EXCLUDED. Counts are weekly and approvals monthly, so
 *     one genuine shortage counted four Fridays running raised FOUR pending
 *     rows, three of which approveVariance refuses as superseded. The alert
 *     counted all four, so its number could only climb through the month and
 *     could not fall except by review — the shape of a badge people learn to
 *     ignore. Only the newest count per item is actionable, so only it alerts.
 *
 *   · AUTO-APPLIED ROWS ARE INCLUDED, for a window. `alert` was computed at
 *     save time on EVERY outcome, but every surface filtered `status='pending'`
 *     — and a row the bar applied is `approved`. So the one class of row where
 *     stock moved with NOBODY in the loop was precisely the class whose alert
 *     was unreachable. Measured: 10 of 19 auto-applied rows raised an alert
 *     that no query could return. They are visible for
 *     ALERT_AUTO_APPLIED_WINDOW_DAYS and then age out — see that constant.
 *     `auto_applied = 1` only, never a human-approved row: a person already
 *     looked at those.
 */

/** The shared row-set + threshold predicate. `SELECT … FROM variance_approvals va JOIN raw_materials rm …`. */
function bigVarianceWhere(
  bar: VarianceBar, outletId: string,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [`-${ALERT_AUTO_APPLIED_WINDOW_DAYS} days`];
  // Thresholds: value axis, then share axis + floor.
  params.push(bar.alertValue, bar.alertValue, bar.alertPct, bar.alertPct, ALERT_MIN_VALUE, ALERT_MIN_QTY);
  let sql = `
       (
         (va.status = 'pending' AND NOT EXISTS (
            SELECT 1 FROM variance_approvals nv WHERE ${supersedeWhere('va')}
         ))
         OR (va.status = 'approved' AND COALESCE(va.auto_applied, 0) = 1
             AND COALESCE(va.reviewed_at, '') >= datetime('now', ?))
       )
       AND (
             (? > 0 AND ABS(va.variance_value) >= ?)
          OR (? > 0 AND ABS(va.system_stock) > 0
              AND (ABS(va.variance) / ABS(va.system_stock)) * 100 >= ?
              AND (CASE WHEN ABS(va.variance_value) > 0
                        THEN ABS(va.variance_value) >= ?
                        ELSE ABS(va.variance) / (${PACK_FACTOR_SQL('rm')}) >= ?
                   END))
       )`;
  if (outletId) { sql += `\n       AND (va.outlet_id = ? OR va.outlet_id = '')`; params.push(outletId); }
  return { sql, params };
}

export function bigVarianceCount(
  db: Database.Database, outletId?: string | null, scope: VarianceOutletScope = 'outlet',
): number {
  const bar = varianceBar(db);
  // Unconfigured ⇒ no alert, and no query either.
  if (bar.alertValue <= 0 && bar.alertPct <= 0) return 0;
  const { sql, params } = bigVarianceWhere(bar, scope === 'all' ? '' : norm(outletId));
  const row = db.prepare(`
    SELECT COUNT(*) AS n
      FROM variance_approvals va
      JOIN raw_materials rm ON rm.id = va.material_id
     WHERE ${sql}
  `).get(...params) as { n: number } | undefined;
  return row?.n || 0;
}

/**
 * The big variances themselves, worst rupee first — what the alert links to.
 * Same predicate as bigVarianceCount() through the same function, so the badge
 * and the list can never disagree about which rows are "big".
 */
export function listBigVariances(
  db: Database.Database,
  opts: { outletId?: string | null; outletScope?: VarianceOutletScope; limit?: number } = {},
): VarianceRow[] {
  const bar = varianceBar(db);
  if (bar.alertValue <= 0 && bar.alertPct <= 0) return [];
  const scope: VarianceOutletScope = opts.outletScope === 'all' ? 'all' : 'outlet';
  const { sql, params } = bigVarianceWhere(bar, scope === 'all' ? '' : norm(opts.outletId));
  const limit = Math.floor(Math.min(Math.max(Number(opts.limit) || 100, 1), 500));
  return db.prepare(`
    SELECT va.*, rm.name AS material_name, rm.sku AS material_sku,
           COALESCE(sl.name,'') AS store_name, COALESCE(d.name,'') AS department_name
      FROM variance_approvals va
      JOIN raw_materials rm ON rm.id = va.material_id
 LEFT JOIN store_locations sl ON sl.id = va.store_id
 LEFT JOIN departments d ON d.id = va.department_id
     WHERE ${sql}
     ORDER BY ABS(va.variance_value) DESC, va.date DESC
     LIMIT ${limit}
  `).all(...params) as VarianceRow[];
}
