import type DatabaseT from 'better-sqlite3';
import { getDb } from './db';
import { packFactor, toPurchaseQty, type PackMeta } from './pack-units';
import { lineFactor } from './issue-stock';
import { resolvePurchaseLogRange } from './purchase-log';

/**
 * END-TO-END TRACEABILITY LOG — one material followed all the way through:
 *
 *   RECEIPT -> REQUISITION -> ISSUE (full or partial) -> CONSUMPTION
 *
 * in one chronological list, every row stamped with its document number and its
 * link key, downloadable as a single CSV. The owner's words: "I need proper log
 * from purchase to department requestitions, issueings, partial and normal
 * everything."
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * READ src/lib/purchase-log.ts FIRST. This file is its sibling and inherits
 * its one hard-won discipline: TOTALS ARE RETURNED PER STAGE AND ARE NEVER
 * SUMMED. There is deliberately NO grand total anywhere in the payload.
 * ═══════════════════════════════════════════════════════════════════════════
 * purchase-log had to solve that for three tables holding the SAME money. This
 * report is worse exposed, not better, because its five stages disagree about
 * BOTH the unit AND the event:
 *
 *   RECEIPT      purchase units, rupees      goods arriving at the store
 *   REQUISITION  the LINE's own unit         a request, not a movement
 *   ISSUE        recipe units                goods leaving the store
 *   CONSUMPTION  recipe units                goods being cooked, days later
 *
 * Add any two of those and the number is wrong in its unit AND in its meaning.
 * A 5 kg receipt plus a 5,000 g issue is not 10 of anything. So each stage
 * carries its own line count in `totals.by_stage`, each of those carries a
 * `basis` sentence meant to be printed verbatim, and quantity totals appear
 * ONLY when a single material is filtered — a cross-material quantity sum adds
 * ml to g to pcs, which rule 4 of pack-units.ts forbids outright.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ISSUE LEG, AND THE ONE PIECE OF ARITHMETIC THAT COULD DOUBLE-COUNT
 * ═══════════════════════════════════════════════════════════════════════════
 * 14,148 requisition lines carry quantity_issued > 0 and were issued before
 * requisition_issue_ledger ever received a row (one flag gated RECORDING as
 * well as deducting — see the header of src/lib/issue-stock.ts). Their
 * issue_history JSON is the literal empty array on 14,144 of them, so
 * /api/store-issued-log, which unrolls that JSON, shows nothing for them. A log
 * that is empty on day one is useless to an owner with 14k historical issues.
 *
 * So the ISSUE leg is emitted in TWO parts that PARTITION the hand-over — they
 * never overlap and they never leave a gap:
 *
 *   ISSUE             one row per ledger row, quantity = recorded_recipe_qty
 *   ISSUE_PRELEDGER   at most ONE derived row per requisition line:
 *
 *       legacy_line_qty = quantity_issued - SUM(recorded_recipe_qty / pack_factor)
 *
 *       emitted only when that is positive.
 *
 * Reversing each ledger row through ITS OWN stored pack_factor is what makes
 * the partition exact: pack_factor is stamped per row precisely because a later
 * Unit Audit rebase changes a material's factor, and reversing with today's
 * factor would corrupt the remainder for every historically issued line. So for
 * EVERY line, forever:
 *
 *       (ISSUE rows, converted back to line units) + (pre-ledger remainder)
 *         === requisition_items.quantity_issued
 *
 * A line issued 5 before this shipped and 2 after reads 5 pre-ledger + 2 ledger.
 * Never 7 twice, never just 2.
 *
 * THE PRE-LEDGER ROW IS DERIVED ON READ. This module performs no writes of any
 * kind — it is a SELECT layer and nothing else, which is how it honours the
 * standing "never backfill, never rewrite existing rows" rule structurally
 * rather than by promise. Do not "fix" the gap by writing ledger rows for
 * history: the moment history has ledger rows, the partition above breaks.
 *
 * WHY recorded_recipe_qty AND NOT delta_recipe_qty. They are two different
 * facts and the log wants the first one:
 *   recorded_recipe_qty  what was physically handed over (always written)
 *   delta_recipe_qty     the subset of that which moved current_stock (0 while
 *                        the deduct flag is off, which is production today)
 * Reading delta_recipe_qty here would make the whole issue leg read zero and
 * push every gram into the pre-ledger remainder. `stock_moved` carries the
 * second fact in its own column, so the log can say "handed over, stock not
 * deducted" instead of pretending one of the two did not happen. A future
 * engineer narrowing this report to rows that moved stock would erase most of
 * the log — that separation is the point of the ledger, not an oversight.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FULL vs PART — a stamped fact, not a live recomputation
 * ═══════════════════════════════════════════════════════════════════════════
 * The owner's case: 7 kg requested, 5 kg issued. `effective_line_qty`
 * (chef_approved_qty ?? quantity_requested) is SNAPSHOTTED on the ledger row at
 * issue time, so a chef editing the approved quantity next week cannot
 * retro-rewrite what the store did that morning. `fulfilment` on an ISSUE row
 * is derived from that snapshot, never from today's requisition_items.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LINK KEYS — sort or filter by these and one material's chain sits together
 * ═══════════════════════════════════════════════════════════════════════════
 *   RECEIPT                        "<grn_number>#<material_id>"
 *   REQUISITION / ISSUE / PRELEDGER "<req_number>#<req_item_id>"
 *   CONSUMPTION                    "<material_id>"
 *
 * The RECEIPT key is the SAME SHAPE purchase-log.ts mints, so the two reports
 * reconcile line for line on a delivery. Its source is now the hard column
 * purchases.grn_id; the anchored note regex is kept as the fallback for rows
 * written before that column existed, because those rows will never be
 * backfilled and a sentence is all they have.
 *
 * The requisition key names the LINE (req_item_id), not just the header. That
 * is the owner's "issue id" doubt answered: a 7-requested / 5-issued line is
 * traceable as one line, and its issues, its remainder and its shortfall PO all
 * carry the same key.
 *
 * CONSUMPTION keys on the material ALONE and says so on the row's own face.
 * Recipe consumption fires at KOT-complete against central stock; nothing in
 * the schema ties a cooked gram back to the issue it came from. Guessing an
 * attribution would be the one kind of number this report refuses to print.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * UNITS — three bases in one list, never converted into each other
 * ═══════════════════════════════════════════════════════════════════════════
 * Every row prints its own quantity in its own unit and declares that unit's
 * basis in `qty_basis` ('purchase' | 'line' | 'recipe'). No total ever crosses
 * a basis.
 *
 * Per the owner rule (pack-units.ts), every row ALSO carries `purchase_qty`,
 * the same physical quantity in PURCHASE units. It is derived only through the
 * IMPORTED packFactor / toPurchaseQty / lineFactor — never re-derived here — so
 * the both-halves guard holds:
 *
 *     pack_size > 1  AND  lower(trim(unit)) !== lower(trim(purchase_unit))
 *
 * PICKLED GINGER 1.5KG (unit kg, purchase_unit kg, pack_size 1.5) therefore has
 * packFactor 1 and shows purchase_qty === qty, where a local `pack_size > 1`
 * copy would have divided it into "4.00 kg". An ambiguous line unit (blank on a
 * packed material — the same lines lineFactor refuses to convert for stock)
 * gets purchase_qty null rather than a guess.
 *
 * ONE CONVERSION IS DELIBERATE AND MUST NOT BE REMOVED: on an ISSUE row the
 * quantity is recipe units but the fulfilment snapshot (effective_line_qty,
 * after_line_qty) is in the LINE's unit. Reported side by side they would label
 * "5 of 7 kg" as grams. So the snapshot is restated into recipe units through
 * THAT ROW'S OWN pack_factor, making every number on an ISSUE row one basis.
 * FULL/PART is a ratio, so scaling both sides cannot change the verdict.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * MONEY, AND THE TAX RULE
 * ═══════════════════════════════════════════════════════════════════════════
 * Only RECEIPT carries real money: purchases.total_price, the goods figure the
 * books read (`value_basis` = 'spend'). GST, cess and the other recorded-only
 * charges NEVER enter any rate or value here — they are reclaimable and belong
 * nowhere near a cost.
 *
 * ISSUE rows carry a VALUED MEMO (`value_basis` = 'memo'), labelled as such on
 * the row, in its own stage total, and in the CSV. It is a memo because an
 * issue is a MOVEMENT, not a spend: those rupees were booked at RECEIPT and
 * adding the two counts the same money twice. It is priced from
 * raw_materials.average_price (Rs per RECIPE unit, the canon) and deliberately
 * NOT from last_purchase_price, which is stored in mixed bases on 105 rows and
 * is up to 5,000x out.
 *
 * REQUISITION, pre-ledger and CONSUMPTION rows carry no money at all.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FILTERS THAT NARROW THE STAGE SET, STATED SO NOBODY READS A GAP AS A ZERO
 * ═══════════════════════════════════════════════════════════════════════════
 * A filter a stage cannot answer removes that stage rather than silently
 * matching nothing:
 *   department_id / req_number  -> RECEIPT and CONSUMPTION drop out (neither
 *                                  carries a department or a requisition)
 *   vendor                      -> only RECEIPT survives (only a purchase has
 *                                  a vendor)
 * `totals.stages_present` reports which stages the filter set can answer, so a
 * reader cannot mistake "this filter cannot see receipts" for "there were none".
 *
 * No authorisation logic lives here. This is a pure query layer; the route owns
 * the management gate.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WIRE CONTRACT — shared with the route and the page, which hold their own
 * copies of these names. src/app/reports/issue-log/page.tsx documents the same
 * field list; the names ARE the contract and must not drift. If you rename a
 * field here, rename it there in the same change.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types (the route and the page mirror these — keep the shape stable)
// ─────────────────────────────────────────────────────────────────────────────

export type IssueLogStage =
  | 'RECEIPT'
  | 'REQUISITION'
  | 'ISSUE'
  | 'ISSUE_PRELEDGER'
  | 'CONSUMPTION';

/**
 * ?stage= filter values accepted on the wire.
 *
 * `issue` and `preledger` are SEPARATE deliberately: both are hand-overs, but
 * one is a recorded ledger row with an actor and a time, and the other is an
 * arithmetic remainder with neither. Folding them into one value would let a
 * reader ask for "issues" and be handed rows that look sourced but are derived.
 */
export type IssueLogStageFilter =
  | 'all' | 'receipt' | 'requisition' | 'issue' | 'pre_ledger' | 'preledger' | 'consumption';

/** Which basis `qty`/`unit` are stated in. NEVER add across two of these. */
export type IssueLogQtyBasis = 'purchase' | 'line' | 'recipe';

/** What `value` may be used for. 'memo' must never be added to 'spend'. */
export type IssueLogValueBasis = 'spend' | 'memo' | '';

/** '' means nothing was skipped. 'pre_ledger' means it is unknowable. */
export type IssueLogSkipReason = '' | 'flag_off' | 'party' | 'unit_review' | 'pre_ledger' | string;

export interface IssueLogRow {
  /** Which leg of the chain this row is. Rows are NEVER additive across stages. */
  stage: IssueLogStage;
  /** YYYY-MM-DD (IST calendar date as stored). */
  date: string;
  /** Full timestamp when one genuinely exists; null on reconstructed rows. */
  at: string | null;

  /** GRN-… / PINV-… / REQ-… — the document this line sits on. */
  doc_no: string;
  /** The chain key. See "LINK KEYS" in the header. '' when nothing to link to. */
  link_key: string;
  /** Cross-reference printed beside the row: the PO number, on both ends. */
  ref_no: string;

  material_id: string;
  material: string;
  sku: string;
  category: string;

  department_id: string | null;
  department: string;
  /** RECEIPT rows only — no other stage has a vendor. */
  vendor: string;

  /** The row's own quantity, in `unit`. Never comparable across `qty_basis`. */
  qty: number;
  unit: string;
  qty_basis: IssueLogQtyBasis;
  /**
   * The SAME value as `qty_basis`, under the other name.
   *
   * TWO NAMES ON PURPOSE, AND DO NOT DELETE EITHER. The lib, the route and the
   * page for this report were authored in parallel and settled on different
   * spellings: the page reads `qty_basis`, the route resolves its CSV totals
   * column by the key `unit_basis`. Both are live consumers. Dropping one does
   * not "tidy" anything — it puts a totals figure under the wrong heading, or
   * makes the page print a quantity with no basis beside it, and a quantity
   * with no basis is the exact misreading this report exists to prevent.
   */
  unit_basis: IssueLogQtyBasis;
  /** Same physical quantity in PURCHASE units. null when the unit is ambiguous. */
  purchase_qty: number | null;
  purchase_unit: string;

  /** Rs. Real spend on RECEIPT, a labelled memo on ISSUE, null elsewhere. */
  value: number | null;
  value_basis: IssueLogValueBasis;

  /* Fulfilment — stamped facts, not live recomputation. On ISSUE rows these are
   * the issue-time snapshot, restated into recipe units through the row's own
   * pack_factor so they agree with `unit`. See the header. */
  requested_qty: number | null;
  effective_qty: number | null;
  issued_qty: number | null;
  still_open: number | null;
  fulfilment: 'FULL' | 'PART' | 'OPEN' | null;

  /** true moved current_stock, false did not, null unknowable. */
  stock_moved: boolean | null;
  skip_reason: IssueLogSkipReason;
  needs_unit_review: boolean;

  req_number: string;
  req_item_id: string;
  actor: string;
  notes: string;

  /** The document's own status: GRN status / requisition status / txn type. */
  status: string;
  /** REQUISITION rows: the approval trail. '' where the stage has none. */
  raised_at: string;
  chef_approved_at: string;
  mgmt_approved_at: string;
}

export interface IssueLogStageTotal {
  stage: IssueLogStage;
  lines: number;
  /**
   * Quantity in this stage's own basis. NON-NULL ONLY when a single material is
   * filtered — across materials it would add ml to g to pcs.
   */
  qty: number | null;
  /** Unit of `qty`, so a UI can never print it bare. '' when qty is null. */
  unit: string;
  qty_basis: IssueLogQtyBasis;
  /** Same value as `qty_basis`. See the note on IssueLogRow.unit_basis. */
  unit_basis: IssueLogQtyBasis;
  /** Rs. Real spend on RECEIPT, a memo on ISSUE, null elsewhere. */
  value: number | null;
  value_basis: IssueLogValueBasis;
  /** ISSUE only: how many of those rows actually moved current_stock. */
  stock_moved_lines: number | null;
  /** Printed VERBATIM beneath the card. Never paraphrased on screen. */
  basis: string;
}

/**
 * PER STAGE, and ONLY per stage.
 *
 * THERE IS DELIBERATELY NO GRAND TOTAL FIELD, and adding one is the bug this
 * whole file is shaped around — re-read purchase-log.ts:222-224. The five
 * stages are different units and different events; any single number "covering
 * everything" is wrong in both, and it is the number that would get quoted.
 *
 * The same five totals are exposed TWICE, as named fields and as an array. Both
 * views hold THE SAME OBJECTS, so they cannot disagree. This is not indecision:
 * the route reads `totals.receipt`, the page iterates `totals.by_stage`, and
 * both shipped alongside this file. Removing either view breaks a live surface.
 */
export interface IssueLogTotals {
  receipt: IssueLogStageTotal;
  requisition: IssueLogStageTotal;
  issue: IssueLogStageTotal;
  pre_ledger: IssueLogStageTotal;
  consumption: IssueLogStageTotal;
  /** The same five objects, in flow order, for callers that would rather map. */
  by_stage: IssueLogStageTotal[];
  /** Rows matching the filters BEFORE any truncation, for the cap check only. */
  lines: number;
  /** The one sentence that says what may not be added. Render it verbatim. */
  basis: string;
  /** Which stages the current filter set can answer at all. See the header. */
  stages_present: IssueLogStage[];
}

export interface IssueLogResult {
  rows: IssueLogRow[];
  totals: IssueLogTotals;
  /** true when `lines` exceeded ISSUE_LOG_MAX_ROWS and rows were capped. */
  truncated: boolean;
  from: string;
  to: string;
}

export interface IssueLogFilters {
  from?: string | null;
  to?: string | null;
  department_id?: string | null;
  material_id?: string | null;
  vendor?: string | null;
  req_number?: string | null;
  stage?: IssueLogStageFilter | null;
}

/**
 * Hard cap on returned rows. A silently truncated report is a wrong report, so
 * `truncated` is reported alongside and `totals` are computed by SQL aggregate
 * over the FULL filtered set — the cap can never distort a figure.
 */
export const ISSUE_LOG_MAX_ROWS = 50_000;

const TOTALS_BASIS =
  'These stages are DIFFERENT UNITS and DIFFERENT EVENTS and must never be added. '
  + 'RECEIPT is purchase units and rupees (goods arriving). REQUISITION is the line unit '
  + '(a request, not a movement). ISSUE and ISSUE (pre-ledger) are the goods leaving the store '
  + 'and together count each hand-over exactly once. CONSUMPTION is a separate event (cooking), '
  + 'days later. The ISSUE rupee figure is a VALUED MEMO at average price, not a spend — the '
  + 'spend was booked at RECEIPT. There is deliberately no grand total.';

/** The per-stage sentence printed under each card, and in the CSV totals block. */
const STAGE_BASIS: Record<IssueLogStage, string> = {
  RECEIPT:
    'Goods received into the central store. Quantity in PURCHASE units; value is the goods '
    + 'figure (purchases.total_price) with GST, cess and the other recorded-only charges excluded. '
    + 'This is the only real spend in this report.',
  REQUISITION:
    'What a department ASKED FOR, in the line unit it was raised in. A requisition moves no '
    + 'stock and carries no money; it is shown so a shortfall and an unfulfilled line are visible.',
  ISSUE:
    'Goods HANDED OVER by the store, recorded in the issue ledger, in RECIPE units. Recorded '
    + 'is not the same as deducted: the Stock Moved column says whether central stock was also '
    + 'debited. The rupee figure is a VALUED MEMO at average price, never a spend.',
  ISSUE_PRELEDGER:
    'Hand-overs that predate the issue ledger, RECONSTRUCTED as quantity_issued minus everything '
    + 'the ledger records for the line, in the line unit. No actor and no time exist for these. '
    + 'They and the ISSUE rows partition each hand-over exactly once — never add them to a '
    + 'requisition figure.',
  CONSUMPTION:
    'Stock consumed by cooking, sales, wastage and the like, in RECIPE units, from '
    + 'inventory_transactions. A separate event from the issue, days later, and NOT attributable '
    + 'to any specific issue — the schema records no such link and this report will not invent one.',
};

/**
 * Only reversing an ISSUE row through its own pack_factor is exact; everything
 * else here is a comparison. 1e-6 matches the rounding applyIssueDelta() puts
 * on deltaRecipe, so a remainder smaller than this is float dust, not stock.
 */
const EPS = 1e-6;

const STAGE_ORDER: IssueLogStage[] =
  ['RECEIPT', 'REQUISITION', 'ISSUE', 'ISSUE_PRELEDGER', 'CONSUMPTION'];

const STAGE_QTY_BASIS: Record<IssueLogStage, IssueLogQtyBasis> = {
  RECEIPT: 'purchase',
  REQUISITION: 'line',
  ISSUE: 'recipe',
  ISSUE_PRELEDGER: 'line',
  CONSUMPTION: 'recipe',
};

const STAGE_VALUE_BASIS: Record<IssueLogStage, IssueLogValueBasis> = {
  RECEIPT: 'spend',
  REQUISITION: '',
  ISSUE: 'memo',
  ISSUE_PRELEDGER: '',
  CONSUMPTION: '',
};

/** Human label for the CSV and any plain-text surface. */
const STAGE_LABEL: Record<IssueLogStage, string> = {
  RECEIPT: 'RECEIPT',
  REQUISITION: 'REQUISITION',
  ISSUE: 'ISSUE',
  ISSUE_PRELEDGER: 'ISSUE (pre-ledger)',
  CONSUMPTION: 'CONSUMPTION',
};

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

const r2 = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;
const r6 = (n: unknown) => Math.round((Number(n) || 0) * 1e6) / 1e6;
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const nullNum = (v: unknown): number | null =>
  v === null || v === undefined ? null : (Number.isFinite(Number(v)) ? r6(Number(v)) : null);
const s = (v: unknown): string => String(v ?? '').trim();

/**
 * The window is resolved by purchase-log's own function, IMPORTED rather than
 * copied. The two reports have to agree on what "last 30 days" means or the
 * receipt reconciliation between them stops holding for a reason nobody can
 * see; one implementation makes that structural. (Last 30 days inclusive of
 * today IST, reversed ranges swapped, invalid values falling back rather than
 * throwing.)
 */
export function resolveIssueLogRange(
  from?: string | null,
  to?: string | null,
): { from: string; to: string } {
  return resolvePurchaseLogRange(from, to);
}

/**
 * Pull "GRN-yyyy-####" out of either a bare grn_number or the tail of a
 * purchases note. Anchored, matching purchase-log.ts's grnFromNoteTail, so an
 * unrelated note that merely mentions a GRN cannot fabricate a link.
 */
const GRN_TOKEN = /^(GRN-\d{4}-\d+)/;
function grnToken(raw: unknown): string | null {
  const m = GRN_TOKEN.exec(s(raw));
  return m ? m[1] : null;
}

/**
 * qty (in `basis`) -> purchase units, through the IMPORTED helpers only.
 *
 * DO NOT "simplify" this into a single division. Each basis needs a different
 * answer and one of the three must NOT be divided at all:
 *   purchase  purchases.quantity is ALREADY purchase units. Dividing it by the
 *             pack factor is the standing unit bug of this codebase.
 *   recipe    the honest conversion: toPurchaseQty (packFactor, both halves).
 *   line      Option B — the line is stored in its OWN unit, which may be
 *             either basis. lineFactor() decides, and refuses on a blank unit
 *             over a packed material rather than guess between g and kg.
 */
function toPu(qty: number, basis: IssueLogQtyBasis, lineUnit: string, m: PackMeta): number | null {
  if (basis === 'purchase') return r6(qty);
  if (basis === 'recipe') return toPurchaseQty(qty, m);
  const lf = lineFactor(lineUnit, m);
  if (lf.needsReview) return null;
  return toPurchaseQty(qty * lf.factor, m);
}

/**
 * FULL / PART / OPEN against the effective quantity. On an ISSUE row that
 * effective quantity is the SNAPSHOT taken at issue time — see the header.
 * A negative issued figure is a reversal (undo / store reject) and gets no
 * fulfilment verdict at all rather than a misleading "PART".
 */
function fulfilmentOf(issued: number, effective: number | null): 'FULL' | 'PART' | 'OPEN' | null {
  if (effective === null || effective <= 0) return null;
  if (issued < -EPS) return null;
  if (issued <= EPS) return 'OPEN';
  return issued + EPS >= effective ? 'FULL' : 'PART';
}

// ─────────────────────────────────────────────────────────────────────────────
// The query
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every branch of the compound SELECT must project the SAME columns in the SAME
 * order AND alias every one of them — SQLite matches compound SELECTs
 * POSITIONALLY, and the names of the FIRST branch become the outer SELECT *'s
 * names. Any branch here can be the first one (the stage filter omits the
 * others), so an unaliased literal in one branch renames a column for the whole
 * report. purchase-log.ts learned this the expensive way; do not drop an alias.
 *
 * Each branch is driven by its own table's indexed date column, so the window —
 * not the table size — bounds the scan. The pre-ledger branch carries the only
 * correlated aggregate in the file, over idx_req_issue_ledger_item, i.e. the
 * handful of ledger rows belonging to ONE requisition line.
 */
function buildUnion(f: {
  from: string; to: string;
  departmentId: string; materialId: string; vendor: string; reqNumber: string;
  stage: IssueLogStageFilter;
}): { sql: string; params: unknown[]; stages: IssueLogStage[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  const stages: IssueLogStage[] = [];

  // A stage runs only when it is asked for AND it can answer every active
  // filter. Dropping the stage is the honest move: a receipt has no department,
  // so a department filter that "matched no receipts" would read as "this
  // department received nothing", which is a different and false claim.
  const reqChain = !f.vendor;                       // no stage here has a vendor
  const central = !f.departmentId && !f.reqNumber;  // no dept, no requisition
  const want = (k: IssueLogStageFilter, ok: boolean) =>
    ok && (f.stage === 'all' || f.stage === k);

  const matFilter = (col: string) => (f.materialId ? ` AND ${col} = ?` : '');
  // CONTAINS, not equality, exactly as purchase-log does it: the vendor box on
  // screen is free text with a datalist, and a datalist constrains nothing —
  // "Metro" against a stored "Metro Cash & Carry Pvt Ltd" matched zero rows and
  // rendered a page of confident zeroes.
  const venFilter = (expr: string) =>
    (f.vendor ? ` AND LOWER(TRIM(${expr})) LIKE '%' || LOWER(TRIM(?)) || '%'` : '');
  const deptFilter = (col: string) => (f.departmentId ? ` AND ${col} = ?` : '');
  const reqFilter = (col: string) =>
    (f.reqNumber ? ` AND LOWER(TRIM(${col})) LIKE '%' || LOWER(TRIM(?)) || '%'` : '');

  // ── RECEIPT ───────────────────────────────────────────────────────────────
  if (want('receipt', central)) {
    stages.push('RECEIPT');
    parts.push(`
      SELECT
        'RECEIPT'                                         AS stage,
        1                                                 AS stage_rank,
        p.id                                              AS row_id,
        p.date                                            AS date,
        COALESCE(p.created_at, '')                        AS at,
        COALESCE(NULLIF(TRIM(g.grn_number), ''),
                 NULLIF(TRIM(p.invoice_id), ''),
                 NULLIF(TRIM(p.bill_no), ''), '')         AS doc_no,
        -- purchases.grn_id is the HARD link added for this work; the note tail
        -- is the fallback for rows written before that column existed. Those
        -- rows are never backfilled, so the regex is not dead code. The JS side
        -- applies the same anchored test to both shapes.
        CASE
          WHEN TRIM(COALESCE(g.grn_number, '')) <> '' THEN TRIM(g.grn_number)
          WHEN instr(COALESCE(p.notes, ''), 'GRN-') > 0
            THEN substr(p.notes, instr(p.notes, 'GRN-'))
          ELSE ''
        END                                               AS link_raw,
        COALESCE((SELECT po.po_number FROM purchase_orders po WHERE po.id = g.po_id), '') AS ref_no,
        COALESCE(p.material_id, '')                       AS material_id,
        COALESCE(rm.name, '(unknown item)')               AS material,
        COALESCE(rm.sku, '')                              AS sku,
        COALESCE(rm.category, '')                         AS category,
        NULL                                              AS department_id,
        ''                                                AS department,
        COALESCE(TRIM(p.vendor), '')                      AS vendor,
        -- ALREADY purchase units. Never multiplied or divided by pack_size.
        COALESCE(p.quantity, 0)                           AS qty,
        COALESCE(NULLIF(rm.purchase_unit, ''), rm.unit, '') AS unit,
        -- The goods figure. The 8 recorded-only charges (GST, cess, TCS and the
        -- rest) are reclaimable and stay out of every value in this report.
        COALESCE(p.total_price, p.quantity * p.unit_price, 0) AS value,
        1                                                 AS stock_moved,
        ''                                                AS skip_reason,
        0                                                 AS needs_unit_review,
        NULL                                              AS requested_qty,
        NULL                                              AS effective_qty,
        NULL                                              AS issued_qty,
        1                                                 AS snapshot_factor,
        COALESCE(NULLIF(TRIM(g.status), ''), 'received')  AS status,
        ''                                                AS raised_at,
        ''                                                AS chef_approved_at,
        ''                                                AS mgmt_approved_at,
        COALESCE(NULLIF(TRIM(g.received_by), ''), '')     AS actor,
        COALESCE(p.notes, '')                             AS notes,
        ''                                                AS req_number,
        ''                                                AS req_item_id,
        COALESCE(rm.unit, '')                             AS rm_unit,
        COALESCE(rm.purchase_unit, '')                    AS rm_purchase_unit,
        COALESCE(rm.pack_size, 1)                         AS rm_pack_size,
        ''                                                AS line_unit
      FROM purchases p
      LEFT JOIN goods_receipt_notes g ON g.id = p.grn_id
      LEFT JOIN raw_materials rm ON rm.id = p.material_id
      WHERE p.date >= ? AND p.date <= ?${venFilter('p.vendor')}${matFilter('p.material_id')}
    `);
    params.push(f.from, f.to);
    if (f.vendor) params.push(f.vendor);
    if (f.materialId) params.push(f.materialId);
  }

  // ── REQUISITION ───────────────────────────────────────────────────────────
  if (want('requisition', reqChain)) {
    stages.push('REQUISITION');
    parts.push(`
      SELECT
        'REQUISITION'                                     AS stage,
        2                                                 AS stage_rank,
        ri.id                                             AS row_id,
        r.date                                            AS date,
        COALESCE(NULLIF(r.submitted_at, ''), r.created_at, '') AS at,
        r.req_number                                      AS doc_no,
        r.req_number || '#' || ri.id                      AS link_raw,
        -- BREAK 3, answered: the shortfall PO raised for THIS requisition LINE,
        -- through the new purchase_order_items.req_item_id (idx_poi_req_item).
        -- Before that column the only survivor was the words "From REQ-…" in the
        -- PO line notes, which name the requisition, not the line.
        -- KNOWN LIMIT: mergeDuplicateLines() folds two requisition lines for one
        -- material into a single PO line keeping the first line's fields, so on
        -- that path the PO names the FIRST line. The joined notes carry both.
        COALESCE((SELECT po2.po_number
                    FROM purchase_order_items poi2
                    JOIN purchase_orders po2 ON po2.id = poi2.po_id
                   WHERE poi2.req_item_id = ri.id
                   ORDER BY po2.date LIMIT 1), '')        AS ref_no,
        COALESCE(ri.material_id, '')                      AS material_id,
        COALESCE(rm.name, '(unknown item)')               AS material,
        COALESCE(rm.sku, '')                              AS sku,
        COALESCE(rm.category, '')                         AS category,
        COALESCE(NULLIF(ri.department_id, ''), r.department_id) AS department_id,
        COALESCE(d.name, '')                              AS department,
        ''                                                AS vendor,
        -- The headline quantity is the EFFECTIVE one (what the chef approved,
        -- falling back to what was asked). Requested, issued and still-open ride
        -- in their own columns so nothing has to be inferred from this number.
        COALESCE(ri.chef_approved_qty, ri.quantity_requested, 0) AS qty,
        COALESCE(NULLIF(TRIM(ri.unit), ''), rm.unit, '')  AS unit,
        NULL                                              AS value,
        -- A requisition is a REQUEST. It moves nothing, ever. NULL rather than
        -- 0 so the page does not print a "stock not moved" banner on a document
        -- that was never going to move any.
        NULL                                              AS stock_moved,
        ''                                                AS skip_reason,
        0                                                 AS needs_unit_review,
        COALESCE(ri.quantity_requested, 0)                AS requested_qty,
        COALESCE(ri.chef_approved_qty, ri.quantity_requested, 0) AS effective_qty,
        COALESCE(ri.quantity_issued, 0)                   AS issued_qty,
        1                                                 AS snapshot_factor,
        COALESCE(
          CASE WHEN COALESCE(ri.is_rejected, 0) = 1 THEN 'chef_rejected'
               WHEN COALESCE(ri.store_rejected, 0) = 1 THEN 'store_rejected'
               ELSE NULLIF(TRIM(r.status), '') END, '')   AS status,
        COALESCE(NULLIF(r.submitted_at, ''), r.created_at, '') AS raised_at,
        COALESCE(r.chef_approved_at, '')                  AS chef_approved_at,
        COALESCE(r.mgmt_approved_at, '')                  AS mgmt_approved_at,
        COALESCE(NULLIF(TRIM(r.submitted_by), ''), TRIM(COALESCE(r.drafted_by, '')), '') AS actor,
        TRIM(COALESCE(ri.notes, ''))                      AS notes,
        r.req_number                                      AS req_number,
        ri.id                                             AS req_item_id,
        COALESCE(rm.unit, '')                             AS rm_unit,
        COALESCE(rm.purchase_unit, '')                    AS rm_purchase_unit,
        COALESCE(rm.pack_size, 1)                         AS rm_pack_size,
        COALESCE(NULLIF(TRIM(ri.unit), ''), '')           AS line_unit
      FROM requisition_items ri
      JOIN requisitions r ON r.id = ri.req_id
      LEFT JOIN raw_materials rm ON rm.id = ri.material_id
      LEFT JOIN departments d ON d.id = COALESCE(NULLIF(ri.department_id, ''), r.department_id)
      WHERE r.date >= ? AND r.date <= ?
        ${deptFilter("COALESCE(NULLIF(ri.department_id, ''), r.department_id)")}${matFilter('ri.material_id')}${reqFilter('r.req_number')}
    `);
    params.push(f.from, f.to);
    if (f.departmentId) params.push(f.departmentId);
    if (f.materialId) params.push(f.materialId);
    if (f.reqNumber) params.push(f.reqNumber);
  }

  // ── ISSUE ─────────────────────────────────────────────────────────────────
  if (want('issue', reqChain)) {
    stages.push('ISSUE');
    parts.push(`
      SELECT
        'ISSUE'                                           AS stage,
        3                                                 AS stage_rank,
        l.id                                              AS row_id,
        substr(l.created_at, 1, 10)                       AS date,
        COALESCE(l.created_at, '')                        AS at,
        COALESCE(r.req_number, '')                        AS doc_no,
        COALESCE(r.req_number, '') || '#' || l.req_item_id AS link_raw,
        ''                                                AS ref_no,
        COALESCE(l.material_id, '')                       AS material_id,
        COALESCE(rm.name, '(unknown item)')               AS material,
        COALESCE(rm.sku, '')                              AS sku,
        COALESCE(rm.category, '')                         AS category,
        l.department_id                                   AS department_id,
        COALESCE(d.name, '')                              AS department,
        ''                                                AS vendor,
        -- recorded_recipe_qty, NOT delta_recipe_qty. See the header: the first
        -- is what was handed over, the second is only the part that also moved
        -- current_stock, which is 0 on every row while the deduct flag is off.
        -- Reading delta here would empty the entire issue leg of this report.
        COALESCE(l.recorded_recipe_qty, 0)                AS qty,
        COALESCE(rm.unit, '')                             AS unit,
        -- VALUED MEMO, never a spend. average_price is Rs per RECIPE unit (the
        -- canon); last_purchase_price is stored in mixed bases on 105 rows and
        -- must not be used to value anything.
        ROUND(COALESCE(l.recorded_recipe_qty, 0) * COALESCE(rm.average_price, 0), 2) AS value,
        COALESCE(l.stock_applied, 0)                      AS stock_moved,
        COALESCE(l.skip_reason, '')                       AS skip_reason,
        COALESCE(l.needs_unit_review, 0)                  AS needs_unit_review,
        NULL                                              AS requested_qty,
        -- SNAPSHOTTED at issue time. This is the FULL/PART yardstick and it must
        -- NOT be recomputed from today's requisition_items.
        l.effective_line_qty                              AS effective_qty,
        COALESCE(l.after_line_qty, 0)                     AS issued_qty,
        -- Both of the two above are in the LINE's unit while this row's qty is
        -- in recipe units. snapshot_factor restates them, in JS, through THIS
        -- ROW'S OWN pack_factor, so every number on the row shares one basis and
        -- a later Unit Audit rebase cannot corrupt an old row.
        COALESCE(NULLIF(l.pack_factor, 0), 1)             AS snapshot_factor,
        ''                                                AS status,
        ''                                                AS raised_at,
        ''                                                AS chef_approved_at,
        ''                                                AS mgmt_approved_at,
        COALESCE(l.actor, '')                             AS actor,
        TRIM('issue reason: ' || COALESCE(l.reason, '')
             || CASE WHEN COALESCE(l.store_mapped, 0) = 1
                     THEN ' | store-ledger material, reconcile on the liquor rail'
                     ELSE '' END)                         AS notes,
        COALESCE(r.req_number, '')                        AS req_number,
        l.req_item_id                                     AS req_item_id,
        COALESCE(rm.unit, '')                             AS rm_unit,
        COALESCE(rm.purchase_unit, '')                    AS rm_purchase_unit,
        COALESCE(rm.pack_size, 1)                         AS rm_pack_size,
        COALESCE(l.line_unit, '')                         AS line_unit
      FROM requisition_issue_ledger l
      LEFT JOIN requisitions r ON r.id = l.req_id
      LEFT JOIN raw_materials rm ON rm.id = l.material_id
      LEFT JOIN departments d ON d.id = l.department_id
      WHERE substr(l.created_at, 1, 10) >= ? AND substr(l.created_at, 1, 10) <= ?
        ${deptFilter('l.department_id')}${matFilter('l.material_id')}${reqFilter("COALESCE(r.req_number, '')")}
    `);
    params.push(f.from, f.to);
    if (f.departmentId) params.push(f.departmentId);
    if (f.materialId) params.push(f.materialId);
    if (f.reqNumber) params.push(f.reqNumber);
  }

  // ── ISSUE (pre-ledger) ────────────────────────────────────────────────────
  // The derived remainder. READ ONLY — nothing is written by this branch or by
  // this module. See "THE ISSUE LEG" in the header for why the partition with
  // the ISSUE branch above is exact and cannot double-count.
  if (want('preledger', reqChain)) {
    stages.push('ISSUE_PRELEDGER');
    // Reversing each ledger row through ITS OWN pack_factor is the whole trick.
    // NULLIF guards a 0 factor (impossible from lineFactor, cheap to survive).
    const LEDGER_IN_LINE_UNITS = `
      COALESCE((SELECT SUM(l2.recorded_recipe_qty / NULLIF(l2.pack_factor, 0))
                  FROM requisition_issue_ledger l2
                 WHERE l2.req_item_id = ri.id), 0)`;
    const REMAINDER = `(COALESCE(ri.quantity_issued, 0) - ${LEDGER_IN_LINE_UNITS})`;
    // issued_at is blank on essentially every historical line, so the date falls
    // back to when the store processed the requisition and then to the
    // requisition's own date. Stated on the row rather than guessed silently.
    const PRE_DATE = `COALESCE(NULLIF(substr(ri.issued_at, 1, 10), ''),
                               NULLIF(substr(r.store_processed_at, 1, 10), ''),
                               r.date)`;
    parts.push(`
      SELECT
        'ISSUE_PRELEDGER'                                 AS stage,
        4                                                 AS stage_rank,
        ri.id                                             AS row_id,
        ${PRE_DATE}                                       AS date,
        -- No time beyond issued_at exists for these, and none is invented.
        COALESCE(NULLIF(ri.issued_at, ''), '')            AS at,
        r.req_number                                      AS doc_no,
        r.req_number || '#' || ri.id                      AS link_raw,
        ''                                                AS ref_no,
        COALESCE(ri.material_id, '')                      AS material_id,
        COALESCE(rm.name, '(unknown item)')               AS material,
        COALESCE(rm.sku, '')                              AS sku,
        COALESCE(rm.category, '')                         AS category,
        COALESCE(NULLIF(ri.department_id, ''), r.department_id) AS department_id,
        COALESCE(d.name, '')                              AS department,
        ''                                                AS vendor,
        ${REMAINDER}                                      AS qty,
        COALESCE(NULLIF(TRIM(ri.unit), ''), rm.unit, '')  AS unit,
        NULL                                              AS value,
        -- Unknowable, and left unknown. Whether these pre-ledger hand-overs
        -- moved central stock depends on what the deduct setting held at the
        -- time, and that value is unrecoverable. 0 would be a guess.
        NULL                                              AS stock_moved,
        'pre_ledger'                                      AS skip_reason,
        0                                                 AS needs_unit_review,
        COALESCE(ri.quantity_requested, 0)                AS requested_qty,
        COALESCE(ri.chef_approved_qty, ri.quantity_requested, 0) AS effective_qty,
        COALESCE(ri.quantity_issued, 0)                   AS issued_qty,
        1                                                 AS snapshot_factor,
        ''                                                AS status,
        ''                                                AS raised_at,
        ''                                                AS chef_approved_at,
        ''                                                AS mgmt_approved_at,
        -- No actor. issued_by is blank on essentially all of these and this
        -- report does not invent one.
        ''                                                AS actor,
        'Reconstructed: handed over before the issue ledger existed. Derived from '
          || 'quantity_issued minus everything the ledger records for this line. '
          || 'No actor and no exact time were ever recorded for it.' AS notes,
        r.req_number                                      AS req_number,
        ri.id                                             AS req_item_id,
        COALESCE(rm.unit, '')                             AS rm_unit,
        COALESCE(rm.purchase_unit, '')                    AS rm_purchase_unit,
        COALESCE(rm.pack_size, 1)                         AS rm_pack_size,
        COALESCE(NULLIF(TRIM(ri.unit), ''), '')           AS line_unit
      FROM requisition_items ri
      JOIN requisitions r ON r.id = ri.req_id
      LEFT JOIN raw_materials rm ON rm.id = ri.material_id
      LEFT JOIN departments d ON d.id = COALESCE(NULLIF(ri.department_id, ''), r.department_id)
      WHERE ${PRE_DATE} >= ? AND ${PRE_DATE} <= ?
        AND COALESCE(ri.quantity_issued, 0) <> 0
        AND ${REMAINDER} > ${EPS}
        ${deptFilter("COALESCE(NULLIF(ri.department_id, ''), r.department_id)")}${matFilter('ri.material_id')}${reqFilter('r.req_number')}
    `);
    params.push(f.from, f.to);
    if (f.departmentId) params.push(f.departmentId);
    if (f.materialId) params.push(f.materialId);
    if (f.reqNumber) params.push(f.reqNumber);
  }

  // ── CONSUMPTION ───────────────────────────────────────────────────────────
  if (want('consumption', central)) {
    stages.push('CONSUMPTION');
    parts.push(`
      SELECT
        'CONSUMPTION'                                     AS stage,
        5                                                 AS stage_rank,
        it.id                                             AS row_id,
        substr(it.created_at, 1, 10)                      AS date,
        COALESCE(it.created_at, '')                       AS at,
        COALESCE(it.reference_id, '')                     AS doc_no,
        -- Material ALONE. Recipe consumption fires at KOT-complete against
        -- central stock and nothing in the schema ties a cooked gram back to the
        -- issue it came from. The row says so in its notes rather than guessing.
        COALESCE(it.material_id, '')                      AS link_raw,
        ''                                                AS ref_no,
        COALESCE(it.material_id, '')                      AS material_id,
        COALESCE(rm.name, '(unknown item)')               AS material,
        COALESCE(rm.sku, '')                              AS sku,
        COALESCE(rm.category, '')                         AS category,
        NULL                                              AS department_id,
        ''                                                AS department,
        ''                                                AS vendor,
        -- Stock-reducing rows are stored negative; negated here so a consumption
        -- reads positive and a reversal keeps its minus sign.
        -COALESCE(it.quantity, 0)                         AS qty,
        COALESCE(rm.unit, '')                             AS unit,
        NULL                                              AS value,
        1                                                 AS stock_moved,
        ''                                                AS skip_reason,
        0                                                 AS needs_unit_review,
        NULL                                              AS requested_qty,
        NULL                                              AS effective_qty,
        NULL                                              AS issued_qty,
        1                                                 AS snapshot_factor,
        COALESCE(it.type, '')                             AS status,
        ''                                                AS raised_at,
        ''                                                AS chef_approved_at,
        ''                                                AS mgmt_approved_at,
        ''                                                AS actor,
        TRIM(COALESCE(it.notes, '')
             || ' | not attributable to a specific issue')  AS notes,
        ''                                                AS req_number,
        ''                                                AS req_item_id,
        COALESCE(rm.unit, '')                             AS rm_unit,
        COALESCE(rm.purchase_unit, '')                    AS rm_purchase_unit,
        COALESCE(rm.pack_size, 1)                         AS rm_pack_size,
        ''                                                AS line_unit
      FROM inventory_transactions it
      LEFT JOIN raw_materials rm ON rm.id = it.material_id
      WHERE substr(it.created_at, 1, 10) >= ? AND substr(it.created_at, 1, 10) <= ?
        AND it.type IN ('sale', 'nc', 'party_consumption', 'staff_meal', 'wastage')
        ${matFilter('it.material_id')}
    `);
    params.push(f.from, f.to);
    if (f.materialId) params.push(f.materialId);
  }

  return { sql: parts.join('\nUNION ALL\n'), params, stages };
}

/**
 * Build the end-to-end traceability log for a date range.
 *
 * Caller (the route) is responsible for the management gate — this is a pure
 * query layer and applies no authorisation of its own.
 */
export function getIssueLog(
  filters: IssueLogFilters = {},
  dbArg?: DatabaseT.Database,
): IssueLogResult {
  const db = dbArg || getDb();
  const { from, to } = resolveIssueLogRange(filters.from, filters.to);
  const departmentId = s(filters.department_id);
  const materialId = s(filters.material_id);
  const vendor = s(filters.vendor);
  const reqNumber = s(filters.req_number);
  // BOTH spellings of the pre-ledger token are accepted and normalised to one.
  // The route maps its wire values to 'pre_ledger' and the page sends
  // 'preledger'; a token this function does not recognise falls back to 'all',
  // which means an unmapped spelling would quietly return EVERY stage under a
  // heading that says "pre-ledger only". Accepting both closes that hole, and
  // bookmarked report URLs outlive any later tidy-up of the spelling.
  const rawStage = s(filters.stage).toLowerCase().replace(/_/g, '');
  const stage: IssueLogStageFilter =
    rawStage === 'receipt' || rawStage === 'requisition' || rawStage === 'issue'
      || rawStage === 'consumption'
      ? (rawStage as IssueLogStageFilter)
      : rawStage === 'preledger' ? 'preledger'
      : 'all';

  const { sql: union, params, stages } = buildUnion({
    from, to, departmentId, materialId, vendor, reqNumber, stage,
  });

  const blankTotal = (st: IssueLogStage): IssueLogStageTotal => ({
    stage: st,
    lines: 0,
    qty: null,
    unit: '',
    qty_basis: STAGE_QTY_BASIS[st],
    unit_basis: STAGE_QTY_BASIS[st],
    // null means "this stage carries no money at all", 0 means "it does and
    // there was none in this window". A stage that CAN hold money must start at
    // 0, or an empty window makes the receipt total render as a blank instead
    // of a zero — and stops it reconciling with purchase-log, which returns 0.
    value: STAGE_VALUE_BASIS[st] === '' ? null : 0,
    value_basis: STAGE_VALUE_BASIS[st],
    stock_moved_lines: st === 'ISSUE' ? 0 : null,
    basis: STAGE_BASIS[st],
  });
  // Every stage gets a total object even when the filters excluded it, so a
  // consumer reading totals.receipt never has to null-check and never renders a
  // blank where a zero belongs. stages_present is what distinguishes "excluded
  // by the filter" from "nothing happened" — see the header.
  const byName: Record<IssueLogStage, IssueLogStageTotal> = {
    RECEIPT: blankTotal('RECEIPT'),
    REQUISITION: blankTotal('REQUISITION'),
    ISSUE: blankTotal('ISSUE'),
    ISSUE_PRELEDGER: blankTotal('ISSUE_PRELEDGER'),
    CONSUMPTION: blankTotal('CONSUMPTION'),
  };
  const totals: IssueLogTotals = {
    receipt: byName.RECEIPT,
    requisition: byName.REQUISITION,
    issue: byName.ISSUE,
    pre_ledger: byName.ISSUE_PRELEDGER,
    consumption: byName.CONSUMPTION,
    // THE SAME OBJECTS, not copies — the two views cannot drift apart.
    by_stage: STAGE_ORDER.map(st => byName[st]),
    lines: 0,
    basis: TOTALS_BASIS,
    stages_present: stages,
  };

  // An empty compound SELECT is a syntax error — never hand one to SQLite. This
  // is reachable: a stage filter combined with a filter that stage cannot answer
  // (stage=receipt with a department, say) legitimately leaves nothing to run.
  if (!union) return { rows: [], totals, truncated: false, from, to };

  // ── TOTALS FIRST, over the FULL filtered set ──────────────────────────────
  // Computed by the database, not by summing the (possibly capped) rows, so the
  // cap can never quietly understate a figure. purchase-log's pattern, verbatim.
  const agg = db.prepare(`
    SELECT stage,
           COUNT(*)                                                  AS lines,
           SUM(value)                                                AS value,
           COALESCE(SUM(qty), 0)                                     AS qty,
           MAX(unit)                                                 AS unit,
           COALESCE(SUM(CASE WHEN stock_moved = 1 THEN 1 ELSE 0 END), 0) AS moved
    FROM (${union})
    GROUP BY stage
  `).all(...params) as Array<{
    stage: string; lines: number; value: number | null; qty: number; unit: string; moved: number;
  }>;

  for (const a of agg) {
    const t = byName[a.stage as IssueLogStage];
    if (!t) continue;
    t.lines = num(a.lines);
    // Whether a stage HAS money is a property of the stage, never of whatever
    // SQL happened to return: SUM() over an all-NULL value column is NULL, and
    // reading that as "no money on this stage" would make a receipt window with
    // no rows indistinguishable from a requisition, which has no money by
    // nature. STAGE_VALUE_BASIS is the authority.
    t.value = STAGE_VALUE_BASIS[t.stage] === '' ? null : r2(a.value ?? 0);
    // A quantity total only means something inside ONE material. Across
    // materials it would add ml to g to pcs — forbidden by pack-units rule 4,
    // and exactly the kind of confident wrong number this report exists to
    // avoid. `unit` follows it so no surface can print the figure bare.
    t.qty = materialId ? r6(a.qty) : null;
    t.unit = materialId ? s(a.unit) : '';
    if (a.stage === 'ISSUE') t.stock_moved_lines = num(a.moved);
    totals.lines += num(a.lines);
  }

  // ── ROWS ──────────────────────────────────────────────────────────────────
  // Ordered so one material's chain reads as a chain: by day, then by the moment
  // within the day, then by link key so a requisition line's own issues and its
  // remainder sit together, then by the stage's natural order in the flow.
  // row_id is the final tie-break so the cap takes a deterministic prefix rather
  // than an arbitrary one.
  const raw = db.prepare(`
    SELECT * FROM (${union})
    ORDER BY date ASC,
             at ASC,
             link_raw ASC,
             stage_rank ASC,
             material COLLATE NOCASE ASC,
             row_id ASC
    LIMIT ?
  `).all(...params, ISSUE_LOG_MAX_ROWS) as any[];

  const rows: IssueLogRow[] = raw.map((r) => {
    const st = r.stage as IssueLogStage;
    const meta: PackMeta = {
      unit: s(r.rm_unit),
      purchase_unit: s(r.rm_purchase_unit),
      pack_size: Number(r.rm_pack_size) || 1,
    };
    const basis = STAGE_QTY_BASIS[st];
    const qty = r6(r.qty);
    const lineUnit = s(r.line_unit);

    // RECEIPT link keys must be the SAME SHAPE purchase-log mints or the two
    // reports stop reconciling on a delivery. Requisition-chain keys name the
    // LINE. Consumption keys the material alone, deliberately.
    let linkKey = '';
    if (st === 'RECEIPT') {
      const grn = grnToken(r.link_raw);
      linkKey = grn ? (s(r.material_id) ? `${grn}#${s(r.material_id)}` : grn) : '';
    } else {
      linkKey = s(r.link_raw);
    }

    // On an ISSUE row the fulfilment snapshot is in the LINE's unit while `qty`
    // is recipe units. Restated through THAT ROW'S stored pack_factor so the row
    // reads in one basis. 1 on every other stage, so this is a no-op there.
    const sf = Number(r.snapshot_factor) || 1;
    const requested = nullNum(r.requested_qty);
    const effective = r.effective_qty === null || r.effective_qty === undefined
      ? null : r6(Number(r.effective_qty) * sf);
    const issued = r.issued_qty === null || r.issued_qty === undefined
      ? null : r6(Number(r.issued_qty) * sf);

    const stillOpen = effective === null || issued === null
      ? null : Math.max(0, r6(effective - issued));

    return {
      stage: st,
      date: s(r.date),
      at: s(r.at) || null,
      doc_no: s(r.doc_no) || (st === 'RECEIPT' ? (grnToken(r.link_raw) || '') : ''),
      link_key: linkKey,
      ref_no: s(r.ref_no),
      material_id: s(r.material_id),
      material: s(r.material),
      sku: s(r.sku),
      category: s(r.category),
      department_id: s(r.department_id) || null,
      department: s(r.department),
      vendor: s(r.vendor),
      qty,
      unit: s(r.unit),
      qty_basis: basis,
      unit_basis: basis,
      purchase_qty: toPu(qty, basis, lineUnit, meta),
      purchase_unit: s(r.rm_purchase_unit) || s(r.rm_unit),
      value: r.value === null || r.value === undefined ? null : r2(r.value),
      value_basis: STAGE_VALUE_BASIS[st],
      // NOT scaled by sf: requested_qty is non-null only on REQUISITION and
      // pre-ledger rows, whose qty is already the LINE basis it is stated in.
      requested_qty: requested,
      effective_qty: effective,
      issued_qty: issued,
      still_open: stillOpen,
      fulfilment: fulfilmentOf(issued ?? 0, effective),
      stock_moved: r.stock_moved === null || r.stock_moved === undefined
        ? null : Number(r.stock_moved) === 1,
      skip_reason: s(r.skip_reason),
      needs_unit_review: Number(r.needs_unit_review) === 1,
      req_number: s(r.req_number),
      req_item_id: s(r.req_item_id),
      actor: s(r.actor),
      notes: s(r.notes),
      status: s(r.status),
      raised_at: s(r.raised_at),
      chef_approved_at: s(r.chef_approved_at),
      mgmt_approved_at: s(r.mgmt_approved_at),
    };
  });

  return { rows, totals, truncated: totals.lines > rows.length, from, to };
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV — shared so the download and the on-screen table cannot drift apart
// ─────────────────────────────────────────────────────────────────────────────

export interface IssueLogColumn {
  key: keyof IssueLogRow;
  label: string;
  /** Numeric columns skip the spreadsheet-formula guard (it would break "-12.5"). */
  numeric?: boolean;
}

/**
 * The ONE column list. The screen renders from it and the CSV serialises from
 * it, so the two cannot disagree about what a column means.
 *
 * "Qty" and "Unit" are followed immediately by "Unit Basis" on purpose: a
 * reader who sorts this file by Qty and sums the column must be able to see, in
 * the very next cell, that they have just added purchase units to grams.
 */
export const ISSUE_LOG_COLUMNS: IssueLogColumn[] = [
  { key: 'date',              label: 'Date' },
  { key: 'at',                label: 'Time' },
  { key: 'stage',             label: 'Stage' },
  { key: 'doc_no',            label: 'Document No' },
  { key: 'ref_no',            label: 'Ref (PO)' },
  { key: 'link_key',          label: 'Link Key' },
  { key: 'material',          label: 'Item' },
  { key: 'sku',               label: 'SKU' },
  { key: 'category',          label: 'Category' },
  { key: 'department',        label: 'Department' },
  { key: 'vendor',            label: 'Vendor' },
  { key: 'qty',               label: 'Qty', numeric: true },
  { key: 'unit',              label: 'Unit' },
  // Keyed 'unit_basis', not 'qty_basis'. The route resolves its CSV totals
  // column by THIS key (colIndex('unit_basis')) and writes each stage's basis
  // into it; keyed the other way that lookup returns -1 and every totals
  // caption loses its basis while still printing a number. The row carries both
  // names with the same value, so the cell content is identical either way.
  { key: 'unit_basis',        label: 'Unit Basis (never add across bases)' },
  { key: 'purchase_qty',      label: 'Qty (purchase units)', numeric: true },
  { key: 'purchase_unit',     label: 'Purchase Unit' },
  { key: 'value',             label: 'Value (Rs)', numeric: true },
  { key: 'value_basis',       label: 'Value Basis (spend / memo)' },
  { key: 'stock_moved',       label: 'Stock Moved' },
  { key: 'skip_reason',       label: 'Stock Skip Reason' },
  { key: 'fulfilment',        label: 'Full / Part' },
  { key: 'requested_qty',     label: 'Requested', numeric: true },
  { key: 'effective_qty',     label: 'Approved / Effective', numeric: true },
  { key: 'issued_qty',        label: 'Issued To Date', numeric: true },
  { key: 'still_open',        label: 'Still Open', numeric: true },
  { key: 'needs_unit_review', label: 'Needs Unit Review' },
  { key: 'status',            label: 'Document Status' },
  { key: 'req_number',        label: 'Requisition No' },
  { key: 'req_item_id',       label: 'Requisition Line ID' },
  { key: 'raised_at',         label: 'Raised At' },
  { key: 'chef_approved_at',  label: 'Chef Approved At' },
  { key: 'mgmt_approved_at',  label: 'Mgmt Approved At' },
  { key: 'actor',             label: 'By' },
  { key: 'notes',             label: 'Notes' },
];

/**
 * Escape one CSV field. Free-text (vendor, item, notes) gets the leading
 * `=+-@` guard — Excel executes those as formulas, and a vendor name is
 * user-entered text that reaches this file unfiltered.
 */
function csvCell(v: unknown, numeric = false): string {
  if (v === null || v === undefined) return '';
  let str = typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v);
  if (!numeric && /^[=+\-@\t\r]/.test(str)) str = `'${str}`;
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/** Pad a caption row out to the column count so it lands under the right heading. */
function csvBanner(text: string): string {
  const cells = [csvCell(text)];
  while (cells.length < ISSUE_LOG_COLUMNS.length) cells.push('');
  return cells.join(',');
}

/**
 * Serialise to CSV: a basis banner, the column header, then the rows.
 *
 * ACCEPTS EITHER the row array or the whole result, because both callers exist:
 * the route hands it `result.rows` and appends its own totals block (built from
 * ISSUE_LOG_COLUMNS, exported for exactly that), while a direct caller can hand
 * it the whole result and get the totals block written here. Given a result it
 * appends the per-stage totals; given a bare array it does not, so the route's
 * output has one totals block, not two.
 *
 * The banner leads because the CSV is the artefact that gets mailed around and
 * pasted into a deck, stripped of every caption the screen had — and the one
 * misreading that matters is someone adding these stages together.
 *
 * Returns the body WITHOUT the UTF-8 BOM: the route prepends it, and exactly
 * once. Two BOMs is worse than none — the second is ordinary data and leaves a
 * zero-width character inside the first header cell.
 */
export function issueLogToCsv(input: IssueLogRow[] | IssueLogResult): string {
  const result: IssueLogResult | null = Array.isArray(input) ? null : input;
  const rows: IssueLogRow[] = Array.isArray(input)
    ? input
    : (Array.isArray(input?.rows) ? input.rows : []);
  const out: string[] = [];

  const window = result ? `  ${s(result.from)} to ${s(result.to)}` : '';
  out.push(csvBanner(`END-TO-END TRACEABILITY LOG${window}`));
  out.push(csvBanner(result?.totals?.basis || TOTALS_BASIS));
  if (result?.truncated) {
    out.push(csvBanner(
      'WARNING: this list was TRUNCATED by the server and is NOT the full log. '
      + 'The stage totals are still computed over the full filtered set.',
    ));
  }
  out.push(ISSUE_LOG_COLUMNS.map(c => csvCell(c.label)).join(','));

  for (const r of rows) {
    out.push(ISSUE_LOG_COLUMNS.map(c => csvCell(r[c.key], !!c.numeric)).join(','));
  }

  // ── PER-STAGE TOTALS, each with its own basis sentence and NO grand total.
  // Only when the caller handed over the whole result; the route builds its own
  // and a second block would read as a contradiction.
  const byStage = result && Array.isArray(result.totals?.by_stage) ? result.totals.by_stage : [];
  if (byStage.length > 0) {
    out.push('');
    out.push(csvBanner('TOTALS PER STAGE — different units, different events. DO NOT ADD THEM.'));
    for (const t of byStage) {
      const qty = t.qty === null || t.qty === undefined
        ? 'qty total withheld (more than one item in view — a cross-item quantity sum is meaningless)'
        : `qty ${t.qty} ${t.unit} (${t.qty_basis} basis)`;
      const val = t.value === null || t.value === undefined
        ? 'no money on this stage'
        : `Rs ${t.value} (${t.value_basis === 'memo' ? 'VALUED MEMO, not a spend' : 'spend'})`;
      const moved = t.stock_moved_lines === null || t.stock_moved_lines === undefined
        ? ''
        : ` | ${t.stock_moved_lines} of ${t.lines} also moved central stock`;
      out.push(csvBanner(`${STAGE_LABEL[t.stage]}: ${t.lines} lines | ${qty} | ${val}${moved}`));
      out.push(csvBanner(`    ${t.basis}`));
    }
  }

  return out.join('\r\n');
}

/** Filename the download must use: issue-log-<from>_<to>.csv */
export function issueLogFilename(from: string, to: string): string {
  return `issue-log-${from}_${to}.csv`;
}
