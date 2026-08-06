import type DatabaseT from 'better-sqlite3';
import { getDb } from './db';
import { packFactor, toPurchaseQty, type PackMeta } from './pack-units';
import { lineFactor } from './issue-stock';
import { resolvePurchaseLogRange } from './purchase-log';

/**
 * END-TO-END TRACEABILITY LOG — one material followed all the way through:
 *
 *   RECEIPT -> REQUISITION -> ISSUE (full or partial) -> CONSUMPTION
 *                                  \-> REVERSAL        \-> CONSUMPTION (skipped)
 *
 * in one chronological list, every row stamped with its document number and its
 * link key, downloadable as a single CSV. The owner's words: "I need proper log
 * from purchase to department requestitions, issueings, partial and normal
 * everything." The cutover spec sharpened that into a requirement this report
 * has to be able to satisfy literally: "preserve a clear, auditable movement
 * history for every issue, consumption and reversal."
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * READ src/lib/purchase-log.ts FIRST. This file is its sibling and inherits
 * its one hard-won discipline: TOTALS ARE RETURNED PER STAGE AND ARE NEVER
 * SUMMED. There is deliberately NO grand total anywhere in the payload.
 * ═══════════════════════════════════════════════════════════════════════════
 * purchase-log had to solve that for three tables holding the SAME money. This
 * report is worse exposed, not better, because its seven stages disagree about
 * BOTH the unit AND the event:
 *
 *   RECEIPT      purchase units, rupees      goods arriving at the store
 *   REQUISITION  the LINE's own unit         a request, not a movement
 *   ISSUE        recipe units                goods leaving the store
 *   REVERSAL     recipe units                goods going back, department->store
 *   CONSUMPTION  recipe units                goods being cooked, days later
 *   CONS. SKIP   recipe units                a cook that moved NOTHING, and why
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
 *   delta_recipe_qty     the subset of that which moved current_stock
 * The deduct is UNCONDITIONAL since the department cutover, so the two now
 * agree on an ordinary line — but they still part company on the three
 * carve-outs applyIssueDelta stamps a skip_reason for (party, store-mapped
 * liquor, an ambiguous line unit), and on every row written before the cutover
 * while the old setting was off. Reading delta_recipe_qty here would zero the
 * issue leg for all of those and push their grams into the pre-ledger
 * remainder, where they do not belong. `stock_moved` carries the second fact in
 * its own column, so the log can say "handed over, stock not deducted" instead
 * of pretending one of the two did not happen. A future engineer narrowing this
 * report to rows that moved stock would erase most of the log — that separation
 * is the point of the ledger, not an oversight.
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
 *   REVERSAL                       "<req_number>#<req_item_id>"  (same as its ISSUE)
 *   CONSUMPTION / CONS. SKIP       "<material_id>"
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
 * CONSUMPTION still keys on the material ALONE, and says so on the row's own
 * face. What CHANGED at the department cutover is WHICH question that answers.
 *
 *   BEFORE  recipe consumption fired at KOT-complete against CENTRAL stock, and
 *           nothing in the schema tied a cooked gram to anything but a material.
 *           This report printed department_id NULL and stock_moved 1 as literals
 *           because there was nothing else honest to print.
 *   NOW     the gram leaves CENTRAL at the requisition issue and leaves the
 *           DEPARTMENT at consumption. deductInventoryForSale resolves the
 *           department from order_items.station through the owner-editable
 *           station_departments map, and postDeptLedger stamps that department
 *           — plus the station that resolved it and the order line it came from
 *           — on a signed department_material_transactions row.
 *
 * SO THE STATION MAP IS THE LINK, and this report reads it rather than
 * recomputing it: the department on a CONSUMPTION row is the one the LEDGER
 * recorded at cook time, matched on (material_id, reference_id). A later remap
 * in Settings therefore cannot retro-rewrite what a past cook was charged to —
 * the same stamped-fact discipline as effective_line_qty on an ISSUE row.
 *
 * WHAT IS STILL NOT KNOWABLE, AND IS STILL NOT INVENTED. The link is to a
 * DEPARTMENT, never to a specific ISSUE. Without lot tracking the grams on a
 * kitchen's shelf are genuinely fungible — requisition A's flour and
 * requisition B's flour are the same flour — so "this dish consumed that issue"
 * remains the one kind of number this report refuses to print. The link key
 * stays the material, deliberately.
 *
 * AND WHEN THE MAP CANNOT ANSWER, THE ROW SAYS SO. An unmapped station (sushi,
 * terracegrill), a blank one, the 'kitchen' sentinel, or a store-mapped liquor
 * material means NOTHING moved on any department rail — applyDeduct writes a
 * consumption_skips row instead. Those surface here twice over: as
 * stock_moved 0 with the skip reason on the CONSUMPTION row itself, and as
 * their own CONSUMPTION (skipped) stage naming the station and the quantity
 * that did not move. Printing `1 AS stock_moved` over them, as this file used
 * to, is a lie in an audit trail, and it is the lie that would make a data gap
 * look like a balanced book.
 *
 * PRE-CUTOVER CONSUMPTION IS NOT REINTERPRETED. Rows dated before
 * settings.dept_ledger_cutover_at DID debit central, and still read
 * stock_moved 1 with no department — exactly as they always did. There is no
 * backfill and no retro-attribution; the cutover stamp is the boundary.
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
 *   department_id  -> RECEIPT and CONSUMPTION (skipped) drop out. A receipt
 *                     lands in the CENTRAL store and has no department; a SKIP
 *                     is BY DEFINITION the case where no department could be
 *                     named, so filtering skips by department would always
 *                     return nothing and read as "this kitchen skipped none".
 *   req_number     -> RECEIPT, CONSUMPTION and CONSUMPTION (skipped) drop out
 *                     (a cook answers to an order, never to a requisition)
 *   vendor         -> only RECEIPT survives (only a purchase has a vendor)
 *
 * CONSUMPTION NOW ANSWERS A DEPARTMENT FILTER, and that is the point of this
 * change. Before the cutover it dropped out beside RECEIPT, so "show me
 * everything for Akan Continental" listed what the kitchen ASKED FOR and what
 * it RECEIVED and then stopped — the department's outflow, the half the
 * variance question actually turns on, was missing from its own log. Filtered
 * to one department the chain now reads: ISSUE in (+), REVERSAL back out (−),
 * CONSUMPTION out (−) — the same three movements the department ledger sums,
 * which is what makes this log checkable against a balance instead of merely
 * suggestive. (Their quantities are printed as positive magnitudes per the
 * convention below; the DIRECTION is the stage, not the sign.)
 *
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
  | 'CONSUMPTION'
  | 'REVERSAL'
  | 'CONSUMPTION_SKIP';

/**
 * ?stage= filter values accepted on the wire.
 *
 * `issue` and `preledger` are SEPARATE deliberately: both are hand-overs, but
 * one is a recorded ledger row with an actor and a time, and the other is an
 * arithmetic remainder with neither. Folding them into one value would let a
 * reader ask for "issues" and be handed rows that look sourced but are derived.
 *
 * `reversal` is SEPARATE from `issue` for the same reason inverted: the ISSUE
 * stage already carries a give-back as a NEGATIVE ledger row, so asking for
 * "issues" correctly nets them. The REVERSAL stage is the DEPARTMENT side of
 * that same event, and folding the two together would count one give-back
 * twice. See STAGE_BASIS.REVERSAL.
 *
 * `skip` is SEPARATE from `consumption` because a skip moved NOTHING. It is a
 * cook that happened with no stock behind it, and a reader who asks for
 * consumption must not be handed rows that look like movement.
 */
export type IssueLogStageFilter =
  | 'all' | 'receipt' | 'requisition' | 'issue' | 'pre_ledger' | 'preledger'
  | 'consumption' | 'reversal' | 'skip' | 'consumption_skip';

/** Which basis `qty`/`unit` are stated in. NEVER add across two of these. */
export type IssueLogQtyBasis = 'purchase' | 'line' | 'recipe';

/** What `value` may be used for. 'memo' must never be added to 'spend'. */
export type IssueLogValueBasis = 'spend' | 'memo' | '';

/**
 * '' means nothing was skipped. 'pre_ledger' means it is unknowable.
 *
 * The ISSUE leg's reasons come off requisition_issue_ledger.skip_reason
 * ('party' | 'store_mapped' | 'unit_review'). The CONSUMPTION leg's come off
 * consumption_skips.reason, written by applyDeduct when it could not name a
 * department it was entitled to debit ('blank' | 'unmapped' | 'inactive' |
 * 'store_mapped' | 'store_check_unavailable' | 'dept_post_failed' |
 * 'no_department'). Two writers, one column, and the union is open on purpose —
 * a reason this file has never heard of must still reach the screen verbatim
 * rather than being normalised into a shrug.
 */
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
  /**
   * The kitchen station that ATTRIBUTED this row to its department, as stamped
   * at the time — never re-resolved on read.
   *
   * Populated on CONSUMPTION (off the department ledger row) and on
   * CONSUMPTION (skipped) (off consumption_skips, where it is the whole point
   * of the row: it NAMES the station nobody has mapped). '' everywhere else,
   * and '' on a consumption whose line carried no station at all — which is
   * itself the answer, and is why the skip reason beside it reads 'blank'.
   *
   * The station→department map is owner-editable. Reading the station off the
   * stored row rather than looking it up again is what stops a remap in
   * Settings from retro-rewriting what a past cook was charged to.
   */
  station: string;
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

  /**
   * true moved stock, false did not, null unknowable — and all three values
   * are load-bearing on a CONSUMPTION row since the department cutover:
   *
   *   true   pre-cutover (it debited central, as it always did), or a
   *          department ledger row exists for the event (the kitchen lost it)
   *   false  a consumption_skips row exists: nothing moved, and `skip_reason`
   *          says why
   *   null   post-cutover, and NEITHER record exists. Genuinely unknowable
   *          here, not zero: the opt-in floor-store rail (tm_floor_autodeduct)
   *          posts to store_stock_ledger and writes neither, so printing
   *          `false` would assert that stock stood still when it may not have.
   *
   * Which rail is a property of the stage, not of this flag — a `true` on a
   * CONSUMPTION row after the cutover means the DEPARTMENT lost the gram, and
   * on an ISSUE row it means CENTRAL did.
   */
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
  /**
   * How many of this stage's rows actually moved stock on some rail. Non-null
   * on the three movement stages (ISSUE, CONSUMPTION, REVERSAL) and null on the
   * stages where the question does not arise — a REQUISITION is a request, a
   * RECEIPT always moved, and a CONSUMPTION (skipped) never did.
   *
   * A shortfall against `lines` is the number that matters: on ISSUE it counts
   * the party / liquor / unit-review carve-outs, and on CONSUMPTION it counts
   * the cooks whose station nobody has mapped.
   */
  stock_moved_lines: number | null;
  /** Printed VERBATIM beneath the card. Never paraphrased on screen. */
  basis: string;
}

/**
 * PER STAGE, and ONLY per stage.
 *
 * THERE IS DELIBERATELY NO GRAND TOTAL FIELD, and adding one is the bug this
 * whole file is shaped around — re-read purchase-log.ts:222-224. The seven
 * stages are different units and different events; any single number "covering
 * everything" is wrong in both, and it is the number that would get quoted.
 *
 * The same totals are exposed TWICE, as named fields and as an array. Both
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
  reversal: IssueLogStageTotal;
  consumption_skip: IssueLogStageTotal;
  /** The same objects, in STAGE_ORDER, for callers that would rather map. */
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
  + 'days later, and comes out of the DEPARTMENT, not central. REVERSAL is the department side of a '
  + 'give-back the ISSUE figure has ALREADY netted as a negative row — two views of one event, never '
  + 'to be added. CONSUMPTION (skipped) moved no stock at all: it is a data gap (an unmapped station, '
  + 'or liquor on its own rail), never a loss. The ISSUE rupee figure is a VALUED MEMO at average '
  + 'price, not a spend — the spend was booked at RECEIPT. There is deliberately no grand total.';

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
    + 'inventory_transactions. A separate event from the issue, days later. Since the department '
    + 'cutover this comes out of the DEPARTMENT the station map named, not out of central — the '
    + 'Department column is the one the ledger stamped at cook time. It is attributable to a '
    + 'department, and still NOT to any specific issue: without lot tracking a kitchen\'s grams are '
    + 'fungible, so this report will not invent that link. Rows dated before the cutover debited '
    + 'central and are shown exactly as they always were.',
  REVERSAL:
    'Goods handed BACK by a department to the central store — the department side of an undo or a '
    + 'store rejection, in RECIPE units, from the department ledger. Shown as the positive quantity '
    + 'that went back. THIS IS THE SAME EVENT the ISSUE stage already carries as a NEGATIVE row: two '
    + 'views of one give-back, so never add them and never count a reversal twice. It carries no '
    + 'money for that reason — the ISSUE memo already nets it.',
  CONSUMPTION_SKIP:
    'A cook that moved NO STOCK ANYWHERE, and the reason, in RECIPE units — the quantity that WOULD '
    + 'have been deducted. Written when the sold line\'s station is blank, unmapped (sushi, '
    + 'terracegrill), switched off, or the material is store-mapped liquor on the TGBCL rail. These '
    + 'are a DATA GAP, not a loss: nothing was taken from any department, so nothing here may be read '
    + 'as shrinkage. Map the station in Settings and the same cook starts deducting.',
};

/**
 * Only reversing an ISSUE row through its own pack_factor is exact; everything
 * else here is a comparison. 1e-6 matches the rounding applyIssueDelta() puts
 * on deltaRecipe, so a remainder smaller than this is float dust, not stock.
 */
const EPS = 1e-6;

/**
 * THE TWO NEW STAGES ARE APPENDED, NOT INSERTED IN FLOW ORDER, AND THAT IS
 * DELIBERATE — do not "tidy" REVERSAL up next to ISSUE here.
 *
 * src/app/reports/issue-log/page.tsx holds its own copy of this list and its
 * own normStage(), whose fallback for a stage string it does not recognise is
 * the literal 'CONSUMPTION'. It then picks each stage card with
 * `totals.find(x => normStage(x.stage) === st)` over THIS array's order. Put
 * REVERSAL ahead of CONSUMPTION and an un-updated page renders the reversal
 * total inside the Consumption card — a wrong number under a right heading,
 * which is the exact failure this whole file is built to prevent. Appended,
 * the worst an un-updated page can do is not show them.
 *
 * (The page still needs its own stages added — see the handoff. This ordering
 * is the seatbelt for the window where it has not been.)
 *
 * ROW ordering inside the chain is stage_rank, set per branch, and it is
 * unaffected: a REVERSAL shares its link key with its ISSUE and sorts after it.
 */
const STAGE_ORDER: IssueLogStage[] =
  ['RECEIPT', 'REQUISITION', 'ISSUE', 'ISSUE_PRELEDGER', 'CONSUMPTION',
   'REVERSAL', 'CONSUMPTION_SKIP'];

const STAGE_QTY_BASIS: Record<IssueLogStage, IssueLogQtyBasis> = {
  RECEIPT: 'purchase',
  REQUISITION: 'line',
  ISSUE: 'recipe',
  ISSUE_PRELEDGER: 'line',
  CONSUMPTION: 'recipe',
  // Both read the department rail, which is RECIPE units throughout
  // (dept-ledger.ts: "Every quantity in this file is RECIPE units").
  REVERSAL: 'recipe',
  CONSUMPTION_SKIP: 'recipe',
};

const STAGE_VALUE_BASIS: Record<IssueLogStage, IssueLogValueBasis> = {
  RECEIPT: 'spend',
  REQUISITION: '',
  ISSUE: 'memo',
  ISSUE_PRELEDGER: '',
  CONSUMPTION: '',
  // NO MONEY ON A REVERSAL, and this is not an omission. A give-back writes a
  // NEGATIVE requisition_issue_ledger row too, so the ISSUE stage's valued memo
  // has ALREADY netted these rupees. Valuing them again here would put the same
  // money on the report twice, under two headings, with nothing to say they are
  // one event.
  REVERSAL: '',
  // A skip moved nothing, so there is nothing to value.
  CONSUMPTION_SKIP: '',
};

/** Human label for the CSV and any plain-text surface. */
const STAGE_LABEL: Record<IssueLogStage, string> = {
  RECEIPT: 'RECEIPT',
  REQUISITION: 'REQUISITION',
  ISSUE: 'ISSUE',
  ISSUE_PRELEDGER: 'ISSUE (pre-ledger)',
  CONSUMPTION: 'CONSUMPTION',
  REVERSAL: 'REVERSAL (department -> store)',
  CONSUMPTION_SKIP: 'CONSUMPTION (skipped — no stock moved)',
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

/* ─────────────────────────────────────────────────────────────────────────────
 * SCHEMA TOLERANCE — what this database can actually be asked
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * Which of the department-rail objects exist HERE, probed once per call.
 *
 * NOT decoration, and not defensive noise. consumption_skips and
 * station_departments are created by the cutover block at the tail of db.ts's
 * migration, and department_material_transactions gained req_item_id / station
 * / source as PRAGMA-guarded ALTERs in the same block — dept-ledger.ts probes
 * for exactly the same reason (see its "SCHEMA TOLERANCE" note). Three things
 * reach this function with a handle that has not run that block: a restored
 * backup, a test fixture, and getIssueLog's own `dbArg` escape hatch. Naming a
 * missing table inside a compound SELECT is a hard SQLite error, and it would
 * take down the WHOLE report — every stage, including the five that have
 * nothing to do with departments.
 *
 * So a missing object DROPS ITS STAGE (and `stages_present` then says the
 * filter set could not answer it) rather than blanking the report or, worse,
 * printing a zero. This is a pure read: it never creates anything.
 */
interface IssueLogSchema {
  /** department_material_transactions exists (shipped long before the cutover). */
  deptLedger: boolean;
  /** …and carries the additive audit columns req_item_id / station / source. */
  deptTrace: boolean;
  /** consumption_skips exists (created by the cutover migration block). */
  skips: boolean;
}

function probeSchema(db: DatabaseT.Database): IssueLogSchema {
  const has = (name: string): boolean => {
    try {
      return !!db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
      ).get(name);
    } catch { return false; }
  };
  const deptLedger = has('department_material_transactions');
  let deptTrace = false;
  if (deptLedger) {
    try {
      const cols = db.prepare(
        'PRAGMA table_info(department_material_transactions)',
      ).all() as Array<{ name: string }>;
      const names = new Set(cols.map(c => String(c.name)));
      deptTrace = names.has('req_item_id') && names.has('station') && names.has('source');
    } catch { deptTrace = false; }
  }
  return { deptLedger, deptTrace, skips: has('consumption_skips') };
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
  schema: IssueLogSchema;
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
  // CONSUMPTION sits between the two since the cutover: the department ledger
  // names a department for it, but a cook still answers to an order and never
  // to a requisition, and never to a vendor.
  const cooked = !f.vendor && !f.reqNumber;
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
        -- A receipt has no kitchen station; goods land in the central store.
        ''                                                AS station,
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
        -- A requisition names a DEPARTMENT directly; no station is involved.
        ''                                                AS station,
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
        -- An issue is addressed to a department on the requisition itself. The
        -- station map is only ever consulted the other way round, at cook time.
        ''                                                AS station,
        -- recorded_recipe_qty, NOT delta_recipe_qty. See the header: the first
        -- is what was handed over, the second is only the part that also moved
        -- current_stock. The deduct is UNCONDITIONAL since the cutover, so the
        -- two agree on an ordinary line — but they still part company on every
        -- carve-out (party, store-mapped liquor, an ambiguous line unit) and on
        -- every row written while the old setting was off, where delta is 0.
        -- Reading delta here would empty the issue leg for all of those and
        -- push their grams into the pre-ledger remainder, breaking the exact
        -- partition the header depends on. stock_moved carries that second fact
        -- in its own column; do not fold the two together. (No backticks in
        -- this comment: it lives INSIDE a SQL template literal and one would
        -- end the literal — rule 5 of this repo, and it bit here once already.)
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
        ''                                                AS station,
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
  // Still sourced from inventory_transactions, and that is deliberate: those
  // rows are what the Variance Report, the Daily Roll-up and Sales-vs-Purchase
  // read, they cover every consuming event (sale, nc, party, staff meal,
  // wastage) rather than only the recipe path, and they are the ONLY record of
  // the years of consumption that predate the department rail. Re-sourcing this
  // stage from the department ledger would silently drop all three.
  //
  // What is NEW is the ATTRIBUTION laid over them — see the block below.
  if (want('consumption', cooked)) {
    stages.push('CONSUMPTION');

    /* ── ATTRIBUTION, BY SCALAR SUBQUERY AND NEVER BY A JOIN ────────────────
     * Read a column off the department ledger row that the SAME event wrote,
     * matched on (material_id, reference_id) — the sale id / wastage id that
     * both rails stamp (deductInventoryForSale passes referenceId: saleId,
     * /api/wastage passes the wastage id, and each writes its
     * inventory_transactions row with the identical reference).
     *
     * DO NOT "SIMPLIFY" THIS INTO A LEFT JOIN. One sale writes TWO
     * inventory_transactions rows for one material when it appears both as a
     * direct ingredient and inside a sub-recipe (db.ts's two applyDeduct
     * loops), and the ledger gets two matching rows. A join fans those 2x2 and
     * DOUBLES the CONSUMPTION stage quantity — a wrong number, on the stage
     * whose whole purpose is to be checkable against a department balance. A
     * scalar subquery returns at most one value per row and cannot fan out.
     *
     * The ±1 day bound on created_at costs nothing in accuracy — both rows are
     * written microseconds apart inside ONE db.transaction() — and it lets
     * SQLite range-scan idx_dept_mat_tx_created for each outer row instead of
     * scanning the whole ledger once per row. Correlated, so it adds no
     * parameter and cannot disturb the positional param order below.
     *
     * quantity < 0 picks the OUTFLOW. A party 'received' credit shares neither
     * the sign nor the meaning and must not be mistaken for a cook. */
    const consDept = (col: string) => (f.schema.deptLedger ? `(
          SELECT dmt.${col}
            FROM department_material_transactions dmt
           WHERE dmt.material_id = it.material_id
             AND TRIM(COALESCE(it.reference_id, '')) <> ''
             AND dmt.reference_id = it.reference_id
             AND dmt.quantity < 0
             AND dmt.created_at >= datetime(it.created_at, '-1 day')
             AND dmt.created_at <= datetime(it.created_at, '+1 day')
           ORDER BY dmt.created_at ASC, dmt.id ASC
           LIMIT 1)` : 'NULL');
    const consDeptId = consDept('department_id');
    // `station` is one of the PRAGMA-guarded additive columns; on a database
    // that has not run the cutover block it simply is not there yet.
    const consStation = f.schema.deptTrace ? consDept('station') : `''`;

    /* WHY nothing MOVED, read off consumption_skips.
     *
     * TRAP, STATED SO IT IS FIXABLE AND NOT MERELY SURPRISING: consumption_skips
     * has no sale/reference column. db.ts's recordSkip() puts the sale id in the
     * NOTES, as the literal tail `sale:<saleId>`, so that tail is the only join
     * key that exists and this LIKE is coupled to that exact wording. If the
     * note format ever changes, this match stops finding rows and stock_moved
     * degrades from `false` to `null` — "unknowable" instead of "did not move".
     * That is a SAFE degradation (the log gets vaguer, never wrong), which is
     * why a fragile key is tolerable here and would not be anywhere that a
     * number came out of it. The real fix is a reference_id column on
     * consumption_skips — see the handoff.
     *
     * cs.date is the IST calendar day while it.created_at is UTC, so the window
     * is widened a day each way; it is bounded at all only so the leading edge
     * of idx_consumption_skips_date_station can be used. */
    const consSkipReason = f.schema.skips ? `COALESCE((
          SELECT cs.reason
            FROM consumption_skips cs
           WHERE cs.material_id = it.material_id
             AND TRIM(COALESCE(it.reference_id, '')) <> ''
             AND cs.notes LIKE '%sale:' || it.reference_id
             AND cs.date >= date(it.created_at, '-1 day')
             AND cs.date <= date(it.created_at, '+1 day')
           ORDER BY cs.created_at ASC, cs.id ASC
           LIMIT 1), '')` : `''`;

    /* THE CUTOVER BOUNDARY, AND WHY IT IS NOT OPTIONAL.
     *
     * Before settings.dept_ledger_cutover_at, recipe consumption debited
     * CENTRAL — that is what the code did and what the books recorded. There is
     * no department ledger row for any of it, by decision (no backfill). Judge
     * those rows by the presence of a ledger row and every one of them flips
     * from "moved stock" to "moved nothing", which is this report rewriting
     * history on a shipped page. So the boundary is read here and pre-cutover
     * rows keep reading exactly as they always have.
     *
     * SUBSTR(...,1,19) + T->space is dept-ledger.ts's LEDGER_TS_SQL normaliser,
     * repeated rather than imported because it is one SQL expression: the stamp
     * is written with milliseconds (nowMs()) and inventory_transactions.
     * created_at is second-resolution datetime('now'), and 'T' (0x54) sorts
     * ABOVE ' ' (0x20), so comparing raw stamps shifts a whole day.
     *
     * '' (the seeded value, meaning "the owner has not cut over yet") is
     * handled by its own arm: `x < ''` is false for every timestamp, so without
     * it a pre-cutover database would report all consumption as unattributed. */
    const CUTOVER = `REPLACE(SUBSTR((SELECT COALESCE(value, '') FROM settings
                                      WHERE key = 'dept_ledger_cutover_at'), 1, 19), 'T', ' ')`;

    parts.push(`
      SELECT
        'CONSUMPTION'                                     AS stage,
        5                                                 AS stage_rank,
        it.id                                             AS row_id,
        substr(it.created_at, 1, 10)                      AS date,
        COALESCE(it.created_at, '')                       AS at,
        COALESCE(it.reference_id, '')                     AS doc_no,
        -- Material ALONE, still. The department is now known (see below) but
        -- the ISSUE it came from is not: without lot tracking a kitchen's grams
        -- are fungible and "this dish ate that issue" is unknowable. Keying on
        -- the material keeps a material's whole chain together without claiming
        -- an attribution the schema cannot support.
        COALESCE(it.material_id, '')                      AS link_raw,
        ''                                                AS ref_no,
        COALESCE(it.material_id, '')                      AS material_id,
        COALESCE(rm.name, '(unknown item)')               AS material,
        COALESCE(rm.sku, '')                              AS sku,
        COALESCE(rm.category, '')                         AS category,
        -- THE DEPARTMENT THAT LOST THE GRAM, as the ledger stamped it at cook
        -- time — NOT re-resolved through today's station map, which the owner
        -- can edit. NULL where the map could not answer, or before the cutover;
        -- a NULL here is an honest "no department", never a zero.
        ${consDeptId}                                     AS department_id,
        COALESCE((SELECT dp.name FROM departments dp WHERE dp.id = ${consDeptId}), '') AS department,
        ''                                                AS vendor,
        -- The station that RESOLVED that department, kept for the audit.
        COALESCE(${consStation}, '')                      AS station,
        -- Stock-reducing rows are stored negative; negated here so a consumption
        -- reads positive and a reversal keeps its minus sign.
        -COALESCE(it.quantity, 0)                         AS qty,
        COALESCE(rm.unit, '')                             AS unit,
        NULL                                              AS value,
        -- WAS THE LITERAL 1. It is now a question with three answers, and the
        -- middle one is the reason this changed: a cook whose station nobody has
        -- mapped moved NOTHING, and stamping "yes, stock moved" on it is a lie
        -- in an audit trail — the lie that makes a data gap look like a
        -- balanced book. Order matters; the first arm wins.
        CASE
          -- Pre-cutover (or no cutover yet): it debited CENTRAL, as it always
          -- did. Not reinterpreted. See the CUTOVER note above.
          WHEN ${CUTOVER} = '' OR COALESCE(it.created_at, '') < ${CUTOVER} THEN 1
          -- A department ledger row exists: the DEPARTMENT lost it.
          WHEN ${consDeptId} IS NOT NULL THEN 1
          -- A skip was recorded: nothing moved, on any rail, and we know why.
          WHEN ${consSkipReason} <> '' THEN 0
          -- Neither record. NOT zero: the opt-in floor-store rail
          -- (tm_floor_autodeduct) posts to store_stock_ledger and writes
          -- neither of the two above, so 0 would assert stock stood still when
          -- it may well not have. Unknowable is the honest answer.
          ELSE NULL
        END                                               AS stock_moved,
        ${consSkipReason}                                 AS skip_reason,
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
             || CASE WHEN ${consDeptId} IS NOT NULL
                     THEN ' | department attributed from station '''
                          || COALESCE(NULLIF(${consStation}, ''), '(none)')
                          || ''' at cook time'
                     ELSE '' END
             || CASE WHEN ${consSkipReason} <> ''
                     THEN ' | NO STOCK MOVED (' || ${consSkipReason} || ') — station '''
                          || COALESCE(NULLIF(${consStation}, ''), '(none recorded on the line)')
                          || ''' could not be charged; map it in Settings'
                     ELSE '' END
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
        ${matFilter('it.material_id')}${deptFilter(consDeptId)}
    `);
    params.push(f.from, f.to);
    if (f.materialId) params.push(f.materialId);
    // The department filter is applied to the ATTRIBUTED department, so a
    // department sees only the cooks its own kitchen was charged for. Pushed
    // AFTER the material param because deptFilter() is appended after
    // matFilter() in the WHERE above — compound-SELECT params are positional
    // and this file has no other guard against getting that pairing wrong.
    if (f.departmentId) params.push(f.departmentId);
  }

  // ── REVERSAL (department -> central) ──────────────────────────────────────
  // The give-back leg the spec asks for by name: "reversing an issue moves
  // stock back Department -> Central for the reversed quantity."
  //
  // WHY THIS IS A STAGE AT ALL, given the ISSUE stage already shows a reversal
  // as a NEGATIVE requisition_issue_ledger row: because that row is the CENTRAL
  // side of the event, and it is exactly the shape the department rail was
  // built to stop being the only record. postDeptLedger stamps the department
  // side under its own type — `issue_reversal`, added precisely because
  // creditDepartment used to write a give-back as type 'issued' with a negative
  // quantity, and every report grouping by type read it as another issue.
  //
  // TWO VIEWS OF ONE EVENT, THEREFORE. They must never be added, which is why
  // this stage carries no money (the ISSUE memo has already netted the rupees)
  // and why STAGE_BASIS.REVERSAL says so in the words printed under the card.
  if (want('reversal', reqChain && f.schema.deptLedger)) {
    stages.push('REVERSAL');
    // req_item_id is one of the additive columns. Without it the row still
    // reports the movement honestly; it just cannot name the requisition LINE,
    // so the link key degrades to the requisition header.
    const revLine = f.schema.deptTrace ? `COALESCE(dmt.req_item_id, '')` : `''`;
    parts.push(`
      SELECT
        'REVERSAL'                                        AS stage,
        6                                                 AS stage_rank,
        dmt.id                                            AS row_id,
        substr(dmt.created_at, 1, 10)                     AS date,
        COALESCE(dmt.created_at, '')                      AS at,
        COALESCE(rq.req_number, '')                       AS doc_no,
        -- THE SAME KEY SHAPE AS ITS ISSUE, on purpose: filter or sort by the
        -- link key and a line's issue and its undo sit together, which is the
        -- whole point of asking for the reversal in the log.
        CASE WHEN ${revLine} <> ''
             THEN COALESCE(rq.req_number, '') || '#' || ${revLine}
             ELSE COALESCE(rq.req_number, '') END         AS link_raw,
        ''                                                AS ref_no,
        COALESCE(dmt.material_id, '')                     AS material_id,
        COALESCE(rm.name, '(unknown item)')               AS material,
        COALESCE(rm.sku, '')                              AS sku,
        COALESCE(rm.category, '')                         AS category,
        dmt.department_id                                 AS department_id,
        COALESCE(d.name, '')                              AS department,
        ''                                                AS vendor,
        ''                                                AS station,
        -- The ledger stores this SIGNED and negative (out of the department).
        -- Negated to the positive magnitude that went back, matching the
        -- CONSUMPTION convention: quantities read positive and the DIRECTION is
        -- the stage, never the sign. Do not "restore" the minus — a column that
        -- is sometimes signed and sometimes not is unsummable by anyone.
        -COALESCE(dmt.quantity, 0)                        AS qty,
        COALESCE(rm.unit, '')                             AS unit,
        -- No money. See STAGE_VALUE_BASIS.REVERSAL: the ISSUE stage's valued
        -- memo already went negative for this same give-back.
        NULL                                              AS value,
        -- A reversal row is only ever written when the stock actually moved:
        -- applyIssueDelta calls postDeptLedger inside its stockQty-non-zero
        -- branch, so there is no such thing as a recorded-but-unmoved reversal.
        1                                                 AS stock_moved,
        ''                                                AS skip_reason,
        0                                                 AS needs_unit_review,
        NULL                                              AS requested_qty,
        NULL                                              AS effective_qty,
        NULL                                              AS issued_qty,
        1                                                 AS snapshot_factor,
        'issue_reversal'                                  AS status,
        ''                                                AS raised_at,
        ''                                                AS chef_approved_at,
        ''                                                AS mgmt_approved_at,
        COALESCE(dmt.user, '')                            AS actor,
        TRIM(COALESCE(dmt.notes, '')
             || ' | returned to the central store; the ISSUE stage carries the '
             || 'same give-back as a negative row — do not count it twice') AS notes,
        COALESCE(rq.req_number, '')                       AS req_number,
        ${revLine}                                        AS req_item_id,
        COALESCE(rm.unit, '')                             AS rm_unit,
        COALESCE(rm.purchase_unit, '')                    AS rm_purchase_unit,
        COALESCE(rm.pack_size, 1)                         AS rm_pack_size,
        ''                                                AS line_unit
      FROM department_material_transactions dmt
      LEFT JOIN raw_materials rm ON rm.id = dmt.material_id
      LEFT JOIN departments d ON d.id = dmt.department_id
      LEFT JOIN requisitions rq ON rq.id = dmt.reference_id
      WHERE substr(dmt.created_at, 1, 10) >= ? AND substr(dmt.created_at, 1, 10) <= ?
        AND dmt.type = 'issue_reversal'
        ${deptFilter('dmt.department_id')}${matFilter('dmt.material_id')}${reqFilter("COALESCE(rq.req_number, '')")}
    `);
    params.push(f.from, f.to);
    if (f.departmentId) params.push(f.departmentId);
    if (f.materialId) params.push(f.materialId);
    if (f.reqNumber) params.push(f.reqNumber);
  }

  // ── CONSUMPTION (skipped) ─────────────────────────────────────────────────
  // Cooks that moved NO STOCK ANYWHERE, and why. Without this stage "we sold
  // forty sushi rolls and nothing came off any shelf" is indistinguishable in
  // the log from "nothing was sold" — the silence reads as a balanced book.
  //
  // A SKIP HAS NO DEPARTMENT, BY DEFINITION — that is the whole event: no
  // department could be named, so none was charged. It therefore drops out
  // under a department filter (stages_present says so) rather than matching
  // nothing and implying this kitchen skipped none. Do not "fix" that by
  // attributing a skip to a guessed department: guessing is the thing the skip
  // exists to refuse.
  if (want('skip', central && f.schema.skips)) {
    stages.push('CONSUMPTION_SKIP');
    parts.push(`
      SELECT
        'CONSUMPTION_SKIP'                                AS stage,
        7                                                 AS stage_rank,
        cs.id                                             AS row_id,
        -- cs.date is the IST calendar day the skip happened (the column
        -- defaults to date('now','+330 minutes')), where the other stages window
        -- on a UTC timestamp. Filtering on it is what lets
        -- idx_consumption_skips_date_station carry this scan, and a skip is a
        -- service-day fact, so the IST day is the right one to file it under.
        COALESCE(cs.date, substr(cs.created_at, 1, 10))   AS date,
        COALESCE(cs.created_at, '')                       AS at,
        COALESCE(cs.order_id, '')                         AS doc_no,
        -- Keyed on the material, like CONSUMPTION, so a skipped cook sits in the
        -- same chain as the cooks that did move stock for that item.
        COALESCE(cs.material_id, '')                      AS link_raw,
        ''                                                AS ref_no,
        COALESCE(cs.material_id, '')                      AS material_id,
        COALESCE(rm.name, '(unknown item)')               AS material,
        COALESCE(rm.sku, '')                              AS sku,
        COALESCE(rm.category, '')                         AS category,
        NULL                                              AS department_id,
        ''                                                AS department,
        ''                                                AS vendor,
        -- THE POINT OF THE ROW. '' means the sold line carried no station at
        -- all, which is itself the finding and is why the reason reads 'blank'.
        COALESCE(cs.station, '')                          AS station,
        -- What WOULD have been deducted. Stored positive already; not negated.
        COALESCE(cs.quantity, 0)                          AS qty,
        COALESCE(rm.unit, '')                             AS unit,
        NULL                                              AS value,
        0                                                 AS stock_moved,
        COALESCE(NULLIF(TRIM(cs.reason), ''), 'unmapped') AS skip_reason,
        0                                                 AS needs_unit_review,
        NULL                                              AS requested_qty,
        NULL                                              AS effective_qty,
        NULL                                              AS issued_qty,
        1                                                 AS snapshot_factor,
        COALESCE(cs.source, '')                           AS status,
        ''                                                AS raised_at,
        ''                                                AS chef_approved_at,
        ''                                                AS mgmt_approved_at,
        ''                                                AS actor,
        TRIM('NO STOCK MOVED. Station '''
             || COALESCE(NULLIF(TRIM(cs.station), ''), '(none on the sold line)')
             || ''' could not be charged ('
             || COALESCE(NULLIF(TRIM(cs.reason), ''), 'unmapped')
             || '). This is a DATA GAP, not a loss — nothing was taken from any '
             || 'department, so none of it is shrinkage. '
             || COALESCE(NULLIF(TRIM(cs.notes), ''), '')) AS notes,
        ''                                                AS req_number,
        ''                                                AS req_item_id,
        COALESCE(rm.unit, '')                             AS rm_unit,
        COALESCE(rm.purchase_unit, '')                    AS rm_purchase_unit,
        COALESCE(rm.pack_size, 1)                         AS rm_pack_size,
        ''                                                AS line_unit
      FROM consumption_skips cs
      LEFT JOIN raw_materials rm ON rm.id = cs.material_id
      WHERE COALESCE(cs.date, substr(cs.created_at, 1, 10)) >= ?
        AND COALESCE(cs.date, substr(cs.created_at, 1, 10)) <= ?
        ${matFilter('cs.material_id')}
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
  // EVERY spelling of a token is accepted and normalised to ONE.
  //
  // The route maps its wire values to 'pre_ledger' and the page sends
  // 'preledger'; a token this function does not recognise falls back to 'all',
  // which means an unmapped spelling would quietly return EVERY stage under a
  // heading that says "pre-ledger only". Accepting both closes that hole, and
  // bookmarked report URLs outlive any later tidy-up of the spelling.
  //
  // The underscore strip is why this is a MAP and not a `switch` on the raw
  // token: it collapses 'pre_ledger'->'preledger' and
  // 'consumption_skip'->'consumptionskip', so the keys below are the STRIPPED
  // forms. Note 'consumptionskip' cannot collide with 'consumption' — these are
  // exact lookups, not prefixes — and a wrong answer there would be the report
  // handing back real movements when asked for skipped ones.
  const STAGE_TOKENS: Record<string, IssueLogStageFilter> = {
    receipt: 'receipt',
    requisition: 'requisition',
    issue: 'issue',
    preledger: 'preledger',
    consumption: 'consumption',
    reversal: 'reversal',
    skip: 'skip',
    consumptionskip: 'skip',
  };
  const rawStage = s(filters.stage).toLowerCase().replace(/_/g, '');
  const stage: IssueLogStageFilter = STAGE_TOKENS[rawStage] ?? 'all';

  // Probed ONCE and handed down, so a stage that names a table this database
  // has not migrated yet is dropped rather than killing the whole compound
  // SELECT. See probeSchema().
  const schema = probeSchema(db);

  const { sql: union, params, stages } = buildUnion({
    from, to, departmentId, materialId, vendor, reqNumber, stage, schema,
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
    // Non-null on the three MOVEMENT stages only. null is not "none moved" —
    // it is "this stage does not move stock, so the count would be noise": a
    // REQUISITION is a request, a RECEIPT always moved, and a CONSUMPTION
    // (skipped) never did (its `lines` IS its count). Same 0-vs-null discipline
    // as `value` directly above.
    stock_moved_lines:
      st === 'ISSUE' || st === 'CONSUMPTION' || st === 'REVERSAL' ? 0 : null,
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
    REVERSAL: blankTotal('REVERSAL'),
    CONSUMPTION_SKIP: blankTotal('CONSUMPTION_SKIP'),
  };
  const totals: IssueLogTotals = {
    receipt: byName.RECEIPT,
    requisition: byName.REQUISITION,
    issue: byName.ISSUE,
    pre_ledger: byName.ISSUE_PRELEDGER,
    consumption: byName.CONSUMPTION,
    reversal: byName.REVERSAL,
    consumption_skip: byName.CONSUMPTION_SKIP,
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
    // Only where blankTotal() already opened the field — the null-vs-0 meaning
    // is decided there and must not be re-decided here. Note the aggregate
    // counts `stock_moved = 1` strictly, so a CONSUMPTION row whose rail is
    // UNKNOWABLE (NULL) is excluded from `moved` rather than counted either
    // way, and `lines - stock_moved_lines` is therefore "did not move OR we
    // cannot say", not "did not move".
    if (t.stock_moved_lines !== null) t.stock_moved_lines = num(a.moved);
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
      // Lower-cased at the source (resolveStationDepartment normalises the key
      // before it is stamped), so it is passed through verbatim rather than
      // re-cased here — a display that title-cases 'pan-asian' into 'Pan-Asian'
      // stops matching what an owner types into the Settings map.
      station: s(r.station),
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
  // Beside Department deliberately: on a CONSUMPTION row this is the station
  // that PRODUCED the department to its left, and on a skipped one it is the
  // station that produced nothing. Read apart they are two facts; read together
  // they are the attribution and its evidence.
  { key: 'station',           label: 'Station (attributed via)' },
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
      // "moved stock", not "moved CENTRAL stock". Since the department cutover
      // the rail depends on the stage — an ISSUE debits central, a CONSUMPTION
      // debits the department — and naming the wrong one in the artefact that
      // gets mailed around is how a reader concludes the store is short.
      const moved = t.stock_moved_lines === null || t.stock_moved_lines === undefined
        ? ''
        : ` | ${t.stock_moved_lines} of ${t.lines} moved stock on this stage's rail`;
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
