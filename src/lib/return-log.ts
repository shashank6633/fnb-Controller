import type DatabaseT from 'better-sqlite3';
import { getDb } from './db';
import { toPurchaseQty, type PackMeta } from './pack-units';
import { materialRate, rateMap } from './closing-valuation';
import { resolvePurchaseLogRange } from './purchase-log';

/**
 * RETURN REPORT (requirement 79) — every return line, vendor and internal, in
 * one chronological list the owner can download as a single CSV.
 *
 * The owner's words, verbatim from row 79 of the spreadsheet: "Generate a
 * Return Report with Item Name, PO No., GRN No., Return Ticket Raised By, Date
 * & Time, Approved By, Reason, Status, and Quantity. Include both Vendor
 * Returns and Internal Department Returns." Every one of those nine fields is a
 * column below, and the two kinds share one list — which is exactly why the
 * totals do not.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * READ src/lib/purchase-log.ts AND src/lib/issue-log.ts FIRST. This file is
 * their third sibling and inherits their one hard-won discipline:
 * TOTALS ARE RETURNED PER SOURCE AND ARE NEVER SUMMED. There is deliberately
 * NO GRAND TOTAL FIELD anywhere in the payload.
 * ═══════════════════════════════════════════════════════════════════════════
 * purchase-log had to solve that for three tables holding the SAME money.
 * issue-log had to solve it for seven stages in different units. This report is
 * worse exposed than either, because its two sources do not merely fail to add
 * — THEY POINT IN OPPOSITE DIRECTIONS:
 *
 *   VENDOR RETURN    goods go BACK TO THE VENDOR. They leave the building.
 *                    CENTRAL STOCK DECREASES. The money is a CREDIT NOTE the
 *                    vendor owes us — a claim, not a spend.
 *   INTERNAL RETURN  goods go from a DEPARTMENT back to the CENTRAL STORE. They
 *                    stay in the building. DEPARTMENT STOCK DECREASES and
 *                    CENTRAL STOCK INCREASES. The money is a valued memo.
 *
 * Add 40 kg of vendor return to 40 kg of internal return and the answer is not
 * 80 kg of anything: one is 40 kg the store lost and one is 40 kg the store
 * gained, and the true net effect on central stock is zero. That single number
 * is the one an owner would quote. So each source carries its own
 * `ReturnLogSourceTotal`, each of those carries a `basis` sentence stating its
 * stock direction in plain English and meant to be printed VERBATIM, and there
 * is no field on `ReturnLogResult` that covers both.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * STOCK MOVES ONLY ON STORE ACCEPT. NOWHERE ELSE.
 * ═══════════════════════════════════════════════════════════════════════════
 * The approval chain is draft -> submitted -> hod_approved -> verified. A
 * ticket sitting at `submitted` or `hod_approved` has moved NOTHING: the goods
 * may physically be on the store counter, but no ledger row exists and no
 * stock scalar has changed. A ticket at `hod_rejected` or `cancelled`, and any
 * LINE the store rejected, leaves stock exactly where it was.
 *
 * So a row in this report is NOT a movement. `stock_moved` is the column that
 * says whether it was one, and `stock_effect` says in which direction. Reading
 * this report as a movement log without those two columns would count
 * every pending request as though the grams had already travelled. The
 * `accepted_*` quantities are the moved ones; the plain quantities are what was
 * ASKED for, which is a different fact and is frequently a different number.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PO No. / GRN No. — PRINTED BLANK WHEN ABSENT, NEVER A NEAREST MATCH
 * ═══════════════════════════════════════════════════════════════════════════
 * A vendor ticket is raised FROM a GRN LINE, so its PO and GRN are a real join
 * off `material_return_items.grn_item_id` -> goods_receipt_note_items ->
 * goods_receipt_notes -> purchase_orders. That chain is exact.
 *
 * It is also frequently INCOMPLETE, and the report says so rather than
 * guessing. 9 of 29 live GRNs were raised ad hoc with no purchase order behind
 * them at all, so a vendor return against one of those has a GRN number and NO
 * PO number, and the PO cell is empty. Substituting the material's most recent
 * PO instead would file a Sugar return against a purchase order it never came
 * from — measured, that is a Rs 10 line reported against a Rs 200 PO, a credit
 * note wrong by 20x. An empty cell is a fact; a nearest match is a fabrication.
 *
 * For INTERNAL returns both cells are ordinarily empty and that is correct, not
 * a gap to be filled: department_material_transactions carries no grn_id and no
 * purchase_id, 2,134 of 2,165 `purchases` rows carry no grn_id, and department
 * stock is pooled per (department, material) with no lot tracking — so the
 * grams a kitchen hands back genuinely cannot be traced to one delivery. The
 * columns stay on internal rows because a ticket MAY carry an optional
 * reference the raiser typed, and where it does the report prints it.
 *
 * The line's own `grn_item_id` wins over the ticket header's `grn_id`; the
 * header is the fallback. That is not a nearest match — the header anchor is
 * the ticket's own declared one, chosen by the person who raised it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * UNITS — three quantities per line, because one is not enough
 * ═══════════════════════════════════════════════════════════════════════════
 *   qty / unit            AS TYPED, in the line's own unit. `qty_basis` = 'line'.
 *   recipe_qty            RECIPE units (g / ml). The only number stock ever
 *                         moved by, and the only one dept-ledger and
 *                         inventory_transactions ever saw.
 *   purchase_qty          PURCHASE units (kg / L / BTL). What every Purchase
 *                         and Inventory surface leads with, per the owner rule.
 *
 * The conversion to purchase units goes through toPurchaseQty() and nothing
 * else. This file never re-derives the pack rule and never divides by pack_size
 * by hand — the both-halves guard (pack_size > 1 AND unit !== purchase_unit)
 * lives in packFactor(), which is why PICKLED GINGER 1.5KG (unit kg,
 * purchase_unit kg, pack 1.5) does not convert and must not.
 *
 * A QUANTITY TOTAL IS RETURNED ONLY WHEN A SINGLE MATERIAL IS FILTERED. Across
 * materials it would add ml to g to pcs, which pack-units rule 4 forbids
 * outright. `qty_unit` travels with the figure so no surface can print it bare,
 * and it is '' precisely when the figure is null.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * MONEY — two legitimate rates, both stated in Rs PER PURCHASE UNIT
 * ═══════════════════════════════════════════════════════════════════════════
 * VENDOR rows are valued at THE GRN LINE'S OWN unit_price. That is the rate the
 * goods actually came in at on that delivery, which is the only rate a credit
 * note can honestly be claimed at. It is Rs per purchase unit by canon
 * (see scripts/check-rate-basis.js), and it is multiplied by a PURCHASE-unit
 * quantity. A vendor line whose GRN line cannot be resolved gets rate null,
 * value null and rate_source 'none' — it does NOT fall through to the internal
 * rate ladder, because substituting a valuation rate for a document rate turns
 * "what the vendor owes us" into a guess with a rupee sign on it.
 *
 * INTERNAL rows are a VALUED MEMO, not a spend — no money changes hands when a
 * kitchen walks onions back to the store. They are valued through
 * closing-valuation.ts, THE SANCTIONED RATE LADDER (latest purchases.unit_price,
 * then average_price x packFactor, then none), whose materialRate() returns
 * `ratePerPurchaseUnit` and is likewise paired with a PURCHASE-unit quantity.
 *
 * raw_materials.last_purchase_price is NEVER read, here or anywhere. It is
 * stored in MIXED bases on live data — 105 rows hold Rs per recipe unit against
 * 87 holding the canon, and MALA STRAWBERRY CRUSH 5 LTR stores 0.13 where the
 * real rate is Rs 674.10. There is no conversion that is right for both halves
 * of that column, so the column may not be read. That is the LPP ban, rule 1 of
 * the rate-basis lock.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DISPOSAL AND WASTAGE (requirement 78's "separate reports")
 * ═══════════════════════════════════════════════════════════════════════════
 * `disposition` is a column on the LINE — reusable | wastage | disposal — not a
 * second ledger, because disposal is not a distinct economic event in this
 * codebase (kitchen-production's dispose route already treats wasted and
 * disposed as siblings and its own reports sum them together as "Waste &
 * Disposal"). Requirement 78's separate report is therefore this report with
 * `disposition` filtered, plus the wastage_lines / disposal_lines counts on
 * each source total. A line marked wastage or disposal that the store accepted
 * took the department down and DID NOT credit central — unusable goods never
 * re-enter the sellable pool — which is why `stock_effect` has a third value
 * and does not simply mirror `source`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SHAPE
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE QUERY LAYER. No authorisation logic lives here — requirement 79's report
 * is management-gated (isManagement) and that gate belongs in the route, the
 * same way purchase-log and issue-log leave theirs to /api/reports/*. This
 * module also performs NO WRITES of any kind: it is a SELECT layer and nothing
 * else, which is how it honours the standing never-backfill rule structurally
 * rather than by promise.
 *
 * The tables are probed before they are read. This report ships alongside the
 * module that creates material_returns, and a database that has not run the
 * boot migration yet must get an empty report rather than a 500 — the same
 * defence issue-log's probeSchema() puts in front of the department ledger.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE FORK, carried on every single row. Rows are NEVER additive across it —
 * the two sources move central stock in OPPOSITE directions.
 */
export type ReturnLogSource = 'VENDOR' | 'INTERNAL';

/** ?source= filter values accepted on the wire. */
export type ReturnLogSourceFilter = 'all' | 'vendor' | 'internal';

/** Requirement 78. A disposition code on the line, not a second ledger. */
export type ReturnLogDisposition = 'reusable' | 'wastage' | 'disposal';

/** ?disposition= filter values accepted on the wire. */
export type ReturnLogDispositionFilter = 'all' | ReturnLogDisposition;

/**
 * What this line DID to stock, once the store had verified the ticket. Derived,
 * never stored — and it is not a synonym for `source`, because a wastage or
 * disposal line takes the department down without crediting central.
 *
 *   CENTRAL_DOWN     vendor return accepted: the goods left the building.
 *   CENTRAL_UP       internal return accepted, reusable: department down,
 *                    central up, one gram moving exactly once.
 *   DEPARTMENT_DOWN  internal return accepted but written off (wastage /
 *                    disposal): department down, central NOT credited.
 *   NONE             nothing moved. Every status short of `verified`, every
 *                    store-rejected line, every cancelled or HOD-rejected
 *                    ticket. THIS IS THE COMMON CASE on a live board.
 */
export type ReturnLogStockEffect = 'CENTRAL_DOWN' | 'CENTRAL_UP' | 'DEPARTMENT_DOWN' | 'NONE';

/**
 * The LINE's outcome, which is not always the ticket's. A verified ticket can
 * hold an accepted line and a rejected line side by side, and requirement 74
 * makes the store state a reason per rejection, so the per-line answer is the
 * one the report has to print.
 *
 * VERIFIED_NO_MOVEMENT is a detectable integrity fault, not a normal state: the
 * store closed the ticket, did not reject this line, and yet nothing moved.
 * Naming it is the point — the alternative is it reading as an ordinary
 * acceptance with a zero beside it.
 */
export type ReturnLogLineStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'HOD_APPROVED'
  | 'HOD_REJECTED'
  | 'CANCELLED'
  | 'ACCEPTED'
  | 'STORE_REJECTED'
  | 'VERIFIED_NO_MOVEMENT'
  | string;

/** Which basis a rate is stated in. '' when there is no rate at all. */
export type ReturnLogRateBasis = 'purchase' | '';

/**
 * Where a rate came from.
 *   grn_line      the GRN line's own unit_price — the document rate. VENDOR.
 *   last_purchase / average_cost / none — closing-valuation's ladder. INTERNAL.
 */
export type ReturnLogRateSource = 'grn_line' | 'last_purchase' | 'average_cost' | 'none';

// ─────────────────────────────────────────────────────────────────────────────
// Row
// ─────────────────────────────────────────────────────────────────────────────

export interface ReturnLogRow {
  /** VENDOR or INTERNAL. Never add a figure across this. */
  source: ReturnLogSource;

  // ── Identity ───────────────────────────────────────────────────────────────
  /** RET-YYYY-NNNN. The ticket this line sits on. */
  ret_number: string;
  return_id: string;
  /** material_return_items.id — the stable key for one line of one ticket. */
  line_id: string;

  // ── Requirement 79: Date & Time ────────────────────────────────────────────
  /** YYYY-MM-DD, the ticket's own IST date. What the range filter runs on. */
  date: string;
  /** The moment it was RAISED (submitted_at, or created_at on a draft). */
  raised_at: string;

  // ── Requirement 79: the people ─────────────────────────────────────────────
  /** "Return Ticket Raised By" — submitted_by, falling back to drafted_by. */
  raised_by: string;
  /**
   * "Approved By" — the DEPARTMENT HEAD / MANAGER of requirement 73, i.e. the
   * approval that let the ticket reach the store. NOT the store verifier: that
   * is a separate act by a separate person and has its own column, because
   * collapsing the two would let a report show a ticket as "approved" when only
   * the store had touched it.
   */
  approved_by: string;
  approved_at: string;
  /** Requirement 74's store verification — who accepted or rejected, and when. */
  verified_by: string;
  verified_at: string;

  // ── Requirement 79: Status ─────────────────────────────────────────────────
  /** The LINE's outcome. See ReturnLogLineStatus. */
  status: ReturnLogLineStatus;
  /** The raw header status underneath it, unmapped, for the audit. */
  ticket_status: string;

  // ── Who the goods moved between ────────────────────────────────────────────
  /** '' on a vendor ticket, which has no department by construction. */
  department_id: string | null;
  department: string;
  /** '' on an internal ticket. */
  vendor: string;

  // ── Requirement 79: PO No. / GRN No. Blank when absent, never a guess. ─────
  po_no: string;
  grn_no: string;

  // ── Requirement 79: Item Name ──────────────────────────────────────────────
  material_id: string;
  /** "(unknown item)" where the raw_materials row is gone — never a blank. */
  material: string;
  sku: string;
  category: string;

  // ── Requirement 79: Quantity, in all three bases it is honest to state ─────
  /** AS TYPED, in `unit`. Never comparable across `qty_basis`. */
  qty: number;
  unit: string;
  /** Always 'line' on this report — the stored quantity is in the line's unit. */
  qty_basis: 'line';
  /** RECIPE units. The number stock would move by if the store accepts it all. */
  recipe_qty: number;
  recipe_unit: string;
  /** PURCHASE units, via toPurchaseQty(). What a Purchase surface leads with. */
  purchase_qty: number;
  purchase_unit: string;

  // ── What the store actually accepted (requirement 74 / 76). MOVED grams. ───
  accepted_qty: number;
  accepted_recipe_qty: number;
  accepted_purchase_qty: number;

  // ── Requirement 79: Reason ─────────────────────────────────────────────────
  /** The raiser's reason. Mandatory at creation. */
  reason: string;
  /** Requirement 74's MANDATORY store rejection reason. '' when not rejected. */
  store_reject_reason: string;
  /** Requirement 78. reusable | wastage | disposal. */
  disposition: ReturnLogDisposition;

  // ── Money. Both bases are PURCHASE; see the header. ───────────────────────
  /** Rs per PURCHASE unit. null when no rate could be established. */
  rate: number | null;
  rate_basis: ReturnLogRateBasis;
  rate_source: ReturnLogRateSource;
  /** rate x purchase_qty — the value ASKED to be returned. */
  requested_value: number | null;
  /** rate x accepted_purchase_qty — the value that actually moved. 0 until accepted. */
  accepted_value: number | null;
  /**
   * VENDOR: a credit-note claim on the vendor, not a spend.
   * INTERNAL: a valued memo — no money changed hands.
   * Print it; never let a rupee figure off this report stand unlabelled.
   */
  value_basis: 'credit_note' | 'memo' | '';

  // ── Movement, and the receipts that prove it ──────────────────────────────
  /** True only where the store accepted this line and grams actually moved. */
  stock_moved: boolean;
  stock_effect: ReturnLogStockEffect;
  /** department_material_transactions.id. Internal accepted lines only. */
  dept_txn_id: string;
  /** inventory_transactions.id. Written on both kinds when stock moved. */
  inv_txn_id: string;
  /**
   * TRUE when this line claims accepted quantity but is missing a movement
   * receipt IT SHOULD HAVE. That is an integrity fault worth surfacing rather
   * than a zero to be shrugged at — the whole promise of the module is that a
   * returned kilogram leaves the department exactly once and re-enters the
   * store exactly once, and a missing receipt is the shape a broken half of
   * that takes.
   *
   * WHICH receipts are owed depends on the DIRECTION, not on the source — see
   * expectedReceipts(). Asking every accepted line for an inventory_transactions
   * row would light this flag on every wastage line in the system, because a
   * write-off posts to the DEPARTMENT rail alone and deliberately writes no
   * central row. A false integrity alarm on a whole category of correct rows is
   * worse than no flag: it teaches the reader to ignore the column.
   */
  receipt_missing: boolean;

  notes: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Totals — PER SOURCE, and only per source
// ─────────────────────────────────────────────────────────────────────────────

export interface ReturnLogSourceTotal {
  source: ReturnLogSource;
  /** Lines matching the filters, over the FULL set (the row cap never bites). */
  lines: number;
  /** Distinct tickets behind those lines. A ticket can hold many lines. */
  tickets: number;
  /** Of `lines`, how many actually moved stock (store-accepted). */
  moved_lines: number;
  /** Requirement 78's separate cut. Subsets of `lines`, not extra lines. */
  wastage_lines: number;
  disposal_lines: number;

  /**
   * PURCHASE units. NON-NULL ONLY when a single material is filtered — across
   * materials this would add ml to g to pcs. `qty_unit` is '' exactly when
   * these are null, so no surface can print the figure bare.
   */
  requested_qty: number | null;
  /** The subset that the store accepted, i.e. the grams that moved. */
  accepted_qty: number | null;
  qty_unit: string;
  /** Always 'purchase'. Stated so a reader never has to infer it. */
  qty_basis: 'purchase';

  /** Rs. Computed over the FULL filtered set, so the row cap cannot understate. */
  requested_value: number;
  accepted_value: number;
  /** credit_note on VENDOR, memo on INTERNAL. Never 'spend' — neither is one. */
  value_basis: 'credit_note' | 'memo';

  /**
   * ONE SENTENCE, printed VERBATIM beneath the card and never paraphrased. It
   * states this source's direction on central stock, which is the fact that
   * makes the two totals un-addable.
   */
  basis: string;
}

/**
 * PER SOURCE, and ONLY per source.
 *
 * THERE IS DELIBERATELY NO GRAND TOTAL FIELD, and adding one is the bug this
 * whole file is shaped around — re-read purchase-log.ts:222-224 and
 * issue-log.ts:443-448. A vendor return DECREASES central stock and an internal
 * return INCREASES it; the two are also captured in different unit bases and
 * carry different kinds of money (a claim on a vendor versus a memo). Any
 * single number "covering all returns" is wrong in direction, in unit and in
 * meaning at once, and it is precisely the number that would get quoted.
 *
 * The same totals are exposed TWICE, as named fields and as an array, HOLDING
 * THE SAME OBJECTS so the two views cannot disagree — issue-log's pattern,
 * because a route reads `totals.vendor` while a page would rather map.
 */
export interface ReturnLogTotals {
  vendor: ReturnLogSourceTotal;
  internal: ReturnLogSourceTotal;
  /** The same objects, in SOURCE_ORDER, for callers that would rather map. */
  by_source: ReturnLogSourceTotal[];
  /**
   * Rows matching the filters BEFORE any truncation — the CAP CHECK ONLY. It is
   * a count of lines, never a quantity and never money, and it is the one
   * figure here that spans both sources precisely because counting rows is the
   * one operation that survives the direction problem.
   */
  lines: number;
  /** The sentence that says what may not be added. Render it verbatim. */
  basis: string;
  /** Which sources the current filter set can answer at all. */
  sources_present: ReturnLogSource[];
}

export interface ReturnLogResult {
  rows: ReturnLogRow[];
  totals: ReturnLogTotals;
  /** true when `totals.lines` exceeded RETURN_LOG_MAX_ROWS and rows were capped. */
  truncated: boolean;
  from: string;
  to: string;
}

export interface ReturnLogFilters {
  from?: string | null;
  to?: string | null;
  source?: ReturnLogSourceFilter | null;
  material_id?: string | null;
  department_id?: string | null;
  vendor?: string | null;
  /** Header status: draft | submitted | hod_approved | verified | … */
  status?: string | null;
  disposition?: ReturnLogDispositionFilter | null;
  /** RET-YYYY-NNNN, exact. */
  ret_number?: string | null;
}

/**
 * Hard cap on returned rows. A silently truncated report is a wrong report, so
 * `truncated` is reported alongside and every total is computed over the FULL
 * filtered set — the cap never distorts a number.
 */
export const RETURN_LOG_MAX_ROWS = 50_000;

const SOURCE_ORDER: ReturnLogSource[] = ['VENDOR', 'INTERNAL'];

/**
 * The two basis sentences. They MUST read differently and must never be
 * concatenated into one caption — the difference between them IS the reason the
 * two totals cannot be added.
 */
const SOURCE_BASIS: Record<ReturnLogSource, string> = {
  VENDOR:
    'VENDOR RETURN — goods left the building, central stock DECREASED. '
    + 'Quantities are PURCHASE units. Money is valued at the GRN line rate '
    + '(Rs per purchase unit) and is a CREDIT NOTE the vendor owes, not a spend.',
  INTERNAL:
    'INTERNAL DEPARTMENT RETURN — goods came back from a department, central '
    + 'stock INCREASED. Quantities are PURCHASE units. Money is a VALUED MEMO at '
    + 'the sanctioned rate ladder; no money changed hands.',
};

const TOTALS_BASIS =
  'VENDOR and INTERNAL returns move central stock in OPPOSITE directions — a vendor '
  + 'return takes stock OUT of the building, an internal return puts stock BACK into the '
  + 'store. These two DO NOT add up, and there is deliberately no combined figure. '
  + 'Stock moves ONLY when the Store ACCEPTS a line; every other row on this report '
  + 'moved nothing.';

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers — same spellings as the two sibling logs
// ─────────────────────────────────────────────────────────────────────────────

const r2 = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;
const r6 = (n: unknown) => Math.round((Number(n) || 0) * 1e6) / 1e6;
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const s = (v: unknown): string => String(v ?? '').trim();

/**
 * The window is resolved by purchase-log's own function, IMPORTED rather than
 * copied — the same reason issue-log imports it. The three reports have to
 * agree on what "last 30 days" means or a reader cross-checking a return
 * against its receipt sees two different windows for a reason nobody can find.
 * (Last 30 days inclusive of today IST, reversed ranges swapped, invalid values
 * falling back rather than throwing.)
 */
export function resolveReturnLogRange(
  from?: string | null,
  to?: string | null,
): { from: string; to: string } {
  return resolvePurchaseLogRange(from, to);
}

/**
 * Both tables, or nothing. This report ships alongside the module that creates
 * them; a database that has not run the boot migration yet must get an empty
 * report rather than a 500 on a missing table.
 */
function tablesPresent(db: DatabaseT.Database): boolean {
  const has = (name: string): boolean => {
    try {
      return !!db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
      ).get(name);
    } catch { return false; }
  };
  return has('material_returns') && has('material_return_items');
}

const DISPOSITIONS = new Set<string>(['reusable', 'wastage', 'disposal']);
function disposition(v: unknown): ReturnLogDisposition {
  const d = s(v).toLowerCase();
  return (DISPOSITIONS.has(d) ? d : 'reusable') as ReturnLogDisposition;
}

/**
 * The LINE's outcome from the header status and the line's own verification
 * columns. Order matters — the first arm wins, and a store rejection outranks
 * an accepted quantity because a rejected line must never read as a movement
 * however its quantity columns were left.
 */
function lineStatus(
  ticketStatus: string,
  storeRejected: boolean,
  acceptedRecipeQty: number,
): ReturnLogLineStatus {
  const st = ticketStatus.toLowerCase();
  if (st !== 'verified') return (st ? st.toUpperCase() : 'DRAFT');
  if (storeRejected) return 'STORE_REJECTED';
  if (acceptedRecipeQty > 0) return 'ACCEPTED';
  return 'VERIFIED_NO_MOVEMENT';
}

/**
 * Which way the grams went. Not a synonym for `source`: an internal line marked
 * wastage or disposal took the department down and did NOT credit central,
 * because unusable goods must never re-enter the sellable pool.
 */
function stockEffect(
  source: ReturnLogSource,
  moved: boolean,
  disp: ReturnLogDisposition,
): ReturnLogStockEffect {
  if (!moved) return 'NONE';
  if (source === 'VENDOR') return 'CENTRAL_DOWN';
  return disp === 'reusable' ? 'CENTRAL_UP' : 'DEPARTMENT_DOWN';
}

/**
 * Which movement receipts a line OUGHT to carry, given what it did to stock.
 * Derived from the direction, never from the source — the three cases genuinely
 * write different rails:
 *
 *   CENTRAL_DOWN     vendor accept. Central stock is debited and an
 *                    inventory_transactions row records it. There is no
 *                    department leg at all: the goods never belonged to one.
 *   CENTRAL_UP       internal accept, reusable. BOTH legs exist — a signed
 *                    department_material_transactions row taking the department
 *                    down, and an inventory_transactions row putting the grams
 *                    back into central. One gram, two ledgers, one movement.
 *   DEPARTMENT_DOWN  internal accept, written off as wastage or disposal. The
 *                    department rail ONLY. Central is deliberately not credited
 *                    (unusable goods never re-enter the sellable pool) and the
 *                    central variance report's wastage term is already filtered
 *                    to department-less rows, so a central row here would be
 *                    wrong twice over. Asking this line for one would flag every
 *                    correct write-off in the system as an integrity fault.
 *   NONE             nothing moved, so nothing is owed.
 */
function expectedReceipts(effect: ReturnLogStockEffect): { dept: boolean; inv: boolean } {
  switch (effect) {
    case 'CENTRAL_DOWN':    return { dept: false, inv: true };
    case 'CENTRAL_UP':      return { dept: true,  inv: true };
    case 'DEPARTMENT_DOWN': return { dept: true,  inv: false };
    default:                return { dept: false, inv: false };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The query
// ─────────────────────────────────────────────────────────────────────────────

interface WhereSpec { sql: string; params: any[] }

/**
 * ONE filtered join, built once and reused by both passes so the totals and the
 * rows can never be computed over different sets.
 *
 * Every join is a LEFT join on purpose. raw_materials is LEFT-joined for
 * purchase-log's stated reason — a log that silently drops a line because its
 * material row was deleted is a wrong log, and such rows show "(unknown item)".
 * The GRN / PO chain is LEFT-joined because it is legitimately absent on every
 * internal ticket and on the ad-hoc half of the vendor ones.
 *
 * The GRN is resolved from THE LINE's grn_item_id first and the ticket header's
 * grn_id second; the PO from that GRN's po_id first and the header's po_id
 * second. Both fallbacks are the ticket's OWN declared anchor, not a nearest
 * match — see the header. No third fallback exists, and none should be added.
 */
const FROM_JOIN = `
       FROM material_return_items li
       JOIN material_returns      r  ON r.id  = li.return_id
  LEFT JOIN raw_materials         rm ON rm.id = li.material_id
  LEFT JOIN departments           d  ON d.id  = r.department_id
  LEFT JOIN vendors               vn ON vn.id = r.vendor_id
  LEFT JOIN goods_receipt_note_items gi ON gi.id = li.grn_item_id
  LEFT JOIN goods_receipt_notes   g  ON g.id  = COALESCE(gi.grn_id, r.grn_id)
  LEFT JOIN purchase_orders       po ON po.id = COALESCE(g.po_id, r.po_id)
`;

/**
 * A line MOVED stock when, and only when, the store verified the ticket, did
 * not reject the line, and accepted a positive recipe quantity. Written once,
 * as SQL, and reused by every count and every sum — the definition of "moved"
 * drifting between the row list and the totals is how a report starts
 * contradicting itself.
 */
const MOVED_SQL = `(r.status = 'verified' AND COALESCE(li.store_rejected, 0) = 0 AND COALESCE(li.accepted_recipe_qty, 0) > 0)`;

function buildWhere(f: {
  from: string; to: string;
  source: ReturnLogSourceFilter;
  materialId: string; departmentId: string; vendor: string;
  status: string; disp: ReturnLogDispositionFilter; retNumber: string;
}): WhereSpec {
  const w: string[] = ['r.date >= ?', 'r.date <= ?'];
  const params: any[] = [f.from, f.to];

  if (f.source === 'vendor')   { w.push(`r.kind = 'vendor'`); }
  if (f.source === 'internal') { w.push(`r.kind = 'internal'`); }
  if (f.materialId)   { w.push('li.material_id = ?');  params.push(f.materialId); }
  if (f.departmentId) { w.push('r.department_id = ?'); params.push(f.departmentId); }
  if (f.status)       { w.push('LOWER(TRIM(r.status)) = ?'); params.push(f.status.toLowerCase()); }
  if (f.disp !== 'all') {
    w.push(`LOWER(TRIM(COALESCE(li.disposition, 'reusable'))) = ?`);
    params.push(f.disp);
  }
  if (f.retNumber)    { w.push('r.ret_number = ?'); params.push(f.retNumber); }
  // CONTAINS, not equality — purchase-log's lesson verbatim. The vendor filter
  // on screen is a free-text box with a datalist, and a datalist constrains
  // nothing: typing "Metro" against a stored "Metro Cash & Carry Pvt Ltd"
  // matched zero rows there and rendered a page of confident zeros.
  if (f.vendor) {
    w.push(`LOWER(TRIM(COALESCE(NULLIF(r.vendor, ''), vn.name, ''))) LIKE '%' || LOWER(TRIM(?)) || '%'`);
    params.push(f.vendor);
  }
  return { sql: w.join(' AND '), params };
}

// ─────────────────────────────────────────────────────────────────────────────
// The report
// ─────────────────────────────────────────────────────────────────────────────

/** Narrow projection used for the totals pass. Numbers only; no formatting. */
interface TotalsRaw {
  kind: string;
  return_id: string;
  material_id: string;
  recipe_qty: number;
  accepted_recipe_qty: number;
  moved: number;
  disposition: string;
  grn_rate: number | null;
  rm_unit: string | null;
  rm_purchase_unit: string | null;
  rm_pack_size: number | null;
  rm_average_price: number | null;
}

export function getReturnLog(
  filters: ReturnLogFilters = {},
  dbArg?: DatabaseT.Database,
): ReturnLogResult {
  const db = dbArg || getDb();
  const { from, to } = resolveReturnLogRange(filters.from, filters.to);

  const rawSource = s(filters.source).toLowerCase();
  const source: ReturnLogSourceFilter =
    rawSource === 'vendor' || rawSource === 'internal' ? rawSource : 'all';
  const rawDisp = s(filters.disposition).toLowerCase();
  const disp: ReturnLogDispositionFilter =
    DISPOSITIONS.has(rawDisp) ? (rawDisp as ReturnLogDisposition) : 'all';

  const materialId   = s(filters.material_id);
  const departmentId = s(filters.department_id);
  const vendor       = s(filters.vendor);
  const status       = s(filters.status);
  const retNumber    = s(filters.ret_number);

  const blank = (src: ReturnLogSource): ReturnLogSourceTotal => ({
    source: src,
    lines: 0,
    tickets: 0,
    moved_lines: 0,
    wastage_lines: 0,
    disposal_lines: 0,
    // null, not 0: a cross-material quantity total is WITHHELD, and 0 would
    // read as "nothing came back" on a window full of returns.
    requested_qty: null,
    accepted_qty: null,
    qty_unit: '',
    qty_basis: 'purchase',
    // 0, not null: both sources always carry money by nature, so an empty
    // window is genuinely Rs 0 and must render as one.
    requested_value: 0,
    accepted_value: 0,
    value_basis: src === 'VENDOR' ? 'credit_note' : 'memo',
    basis: SOURCE_BASIS[src],
  });

  const byName: Record<ReturnLogSource, ReturnLogSourceTotal> = {
    VENDOR: blank('VENDOR'),
    INTERNAL: blank('INTERNAL'),
  };
  const sourcesPresent: ReturnLogSource[] =
    source === 'all' ? [...SOURCE_ORDER]
      : source === 'vendor' ? ['VENDOR'] : ['INTERNAL'];

  const totals: ReturnLogTotals = {
    vendor: byName.VENDOR,
    internal: byName.INTERNAL,
    // THE SAME OBJECTS, not copies — the two views cannot drift apart.
    by_source: SOURCE_ORDER.map(src => byName[src]),
    lines: 0,
    basis: TOTALS_BASIS,
    sources_present: sourcesPresent,
  };

  const empty: ReturnLogResult = { rows: [], totals, truncated: false, from, to };
  if (!tablesPresent(db)) return empty;

  const where = buildWhere({
    from, to, source, materialId, departmentId, vendor, status, disp, retNumber,
  });

  // ── TOTALS FIRST, over the FULL filtered set ──────────────────────────────
  // purchase-log and issue-log do this with a SQL aggregate so the row cap can
  // never quietly understate a figure. THIS report cannot finish the job in
  // SQL: the internal rate ladder lives in closing-valuation.ts and re-deriving
  // it (or the pack rule) in SQL is exactly the duplication the rate-basis lock
  // exists to prevent. So the totals pass is an UNCAPPED NARROW PROJECTION —
  // eleven scalars per line, no joins beyond the ones the filter already needs
  // — folded in JS through the sanctioned helpers. Same guarantee, same set,
  // and the rate rule stays in one place.
  const rawTotals = db.prepare(`
    SELECT
      LOWER(TRIM(COALESCE(r.kind, '')))                     AS kind,
      COALESCE(r.id, '')                                    AS return_id,
      COALESCE(li.material_id, '')                          AS material_id,
      COALESCE(li.recipe_qty, 0)                            AS recipe_qty,
      COALESCE(li.accepted_recipe_qty, 0)                   AS accepted_recipe_qty,
      CASE WHEN ${MOVED_SQL} THEN 1 ELSE 0 END              AS moved,
      LOWER(TRIM(COALESCE(li.disposition, 'reusable')))     AS disposition,
      -- rate-basis: purchase
      -- goods_receipt_note_items.unit_price is Rs per PURCHASE unit by canon.
      -- Projected raw and multiplied in JS against a PURCHASE-unit quantity, so
      -- both halves of every product below share one basis.
      gi.unit_price                                         AS grn_rate,
      rm.unit                                               AS rm_unit,
      rm.purchase_unit                                      AS rm_purchase_unit,
      rm.pack_size                                          AS rm_pack_size,
      rm.average_price                                      AS rm_average_price
    ${FROM_JOIN}
     WHERE ${where.sql}
  `).all(...where.params) as TotalsRaw[];

  // One SELECT for the latest priced purchase per material, so the internal
  // ladder does not run a query per line. closing-valuation's own batching
  // contract; a material with no purchase history is simply absent from the map
  // and materialRate() falls through to average cost for it.
  const rates = rawTotals.length > 0 ? rateMap(db) : new Map();

  const ticketsSeen: Record<ReturnLogSource, Set<string>> = {
    VENDOR: new Set<string>(),
    INTERNAL: new Set<string>(),
  };
  // Summed in RECIPE units and converted to purchase units ONCE at the end, via
  // toPurchaseQty. Converting per line and then adding would round 50,000 times
  // instead of twice.
  const recipeSums: Record<ReturnLogSource, { req: number; acc: number }> = {
    VENDOR: { req: 0, acc: 0 },
    INTERNAL: { req: 0, acc: 0 },
  };
  // Only meaningful under a single-material filter, which is the only case the
  // quantity totals are published in at all.
  let qtyMeta: PackMeta | null = null;
  let qtyUnit = '';

  for (const t of rawTotals) {
    const src: ReturnLogSource = t.kind === 'vendor' ? 'VENDOR' : 'INTERNAL';
    const acc = byName[src];
    const moved = num(t.moved) === 1;
    const d = disposition(t.disposition);

    acc.lines += 1;
    if (t.return_id) ticketsSeen[src].add(t.return_id);
    if (moved) acc.moved_lines += 1;
    if (d === 'wastage') acc.wastage_lines += 1;
    if (d === 'disposal') acc.disposal_lines += 1;

    const meta: PackMeta = {
      unit: s(t.rm_unit),
      purchase_unit: s(t.rm_purchase_unit),
      pack_size: Number(t.rm_pack_size) || 1,
    };
    if (materialId && !qtyMeta) {
      qtyMeta = meta;
      qtyUnit = s(t.rm_purchase_unit) || s(t.rm_unit);
    }

    const reqRecipe = num(t.recipe_qty);
    const accRecipe = moved ? num(t.accepted_recipe_qty) : 0;
    recipeSums[src].req += reqRecipe;
    recipeSums[src].acc += accRecipe;

    // ── MONEY. Both halves purchase basis, every time. ──────────────────────
    // The quantity is converted to PURCHASE units through toPurchaseQty(),
    // which carries the both-halves guard; the rate is Rs per PURCHASE unit
    // from either the GRN document (vendor) or the sanctioned ladder
    // (internal). raw_materials.last_purchase_price is never consulted.
    const reqPu = toPurchaseQty(reqRecipe, meta);
    const accPu = toPurchaseQty(accRecipe, meta);
    const { rate } = rowRate(db, src, t.grn_rate, t.material_id, meta, t.rm_average_price, rates);
    if (rate !== null) {
      // rate-basis: purchase  (Rs per purchase unit x purchase-unit quantity)
      acc.requested_value += reqPu * rate;
      // rate-basis: purchase
      acc.accepted_value += accPu * rate;
    }
  }

  for (const src of SOURCE_ORDER) {
    const acc = byName[src];
    acc.tickets = ticketsSeen[src].size;
    acc.requested_value = r2(acc.requested_value);
    acc.accepted_value = r2(acc.accepted_value);
    // A quantity total only means something inside ONE material. Across
    // materials it would add ml to g to pcs — pack-units rule 4 — and it is
    // exactly the kind of confident wrong number this report exists to avoid.
    // qty_unit follows it so no surface can print the figure bare.
    if (materialId && qtyMeta) {
      acc.requested_qty = r6(toPurchaseQty(recipeSums[src].req, qtyMeta));
      acc.accepted_qty = r6(toPurchaseQty(recipeSums[src].acc, qtyMeta));
      acc.qty_unit = qtyUnit;
    }
    totals.lines += acc.lines;
  }

  // ── ROWS, capped and deterministically ordered ────────────────────────────
  // Ordered by day, then by the ticket number so one ticket's lines sit
  // together, then by the line id so the cap takes a deterministic prefix
  // rather than an arbitrary one.
  const raw = db.prepare(`
    SELECT
      LOWER(TRIM(COALESCE(r.kind, '')))                     AS kind,
      COALESCE(r.id, '')                                    AS return_id,
      COALESCE(r.ret_number, '')                            AS ret_number,
      COALESCE(li.id, '')                                   AS line_id,
      COALESCE(r.date, '')                                  AS date,
      COALESCE(NULLIF(r.submitted_at, ''), r.created_at, '') AS raised_at,
      COALESCE(NULLIF(r.submitted_by, ''), r.drafted_by, '') AS raised_by,
      COALESCE(r.hod_approved_by, '')                       AS approved_by,
      COALESCE(r.hod_approved_at, '')                       AS approved_at,
      COALESCE(r.store_verified_by, '')                     AS verified_by,
      COALESCE(r.store_verified_at, '')                     AS verified_at,
      LOWER(TRIM(COALESCE(r.status, '')))                   AS ticket_status,
      COALESCE(r.department_id, '')                         AS department_id,
      COALESCE(d.name, '')                                  AS department,
      COALESCE(NULLIF(r.vendor, ''), vn.name, '')           AS vendor,
      -- BLANK when absent, never a nearest match. See the header: 9 of 29 live
      -- GRNs have no purchase order behind them at all, and an internal return
      -- has neither by construction.
      COALESCE(po.po_number, '')                            AS po_no,
      COALESCE(g.grn_number, '')                            AS grn_no,
      COALESCE(li.material_id, '')                          AS material_id,
      COALESCE(rm.name, '(unknown item)')                   AS material,
      COALESCE(rm.sku, '')                                  AS sku,
      COALESCE(rm.category, '')                             AS category,
      COALESCE(li.quantity, 0)                              AS qty,
      COALESCE(li.unit, '')                                 AS unit,
      COALESCE(li.recipe_qty, 0)                            AS recipe_qty,
      COALESCE(li.accepted_qty, 0)                          AS accepted_qty,
      COALESCE(li.accepted_recipe_qty, 0)                   AS accepted_recipe_qty,
      COALESCE(li.reason, '')                               AS reason,
      COALESCE(li.store_reject_reason, '')                  AS store_reject_reason,
      CASE WHEN COALESCE(li.store_rejected, 0) = 0 THEN 0 ELSE 1 END AS store_rejected,
      LOWER(TRIM(COALESCE(li.disposition, 'reusable')))     AS disposition,
      CASE WHEN ${MOVED_SQL} THEN 1 ELSE 0 END              AS moved,
      COALESCE(li.dept_txn_id, '')                          AS dept_txn_id,
      COALESCE(li.inv_txn_id, '')                           AS inv_txn_id,
      COALESCE(li.notes, '')                                AS notes,
      -- rate-basis: purchase
      -- The GRN line's own document rate, Rs per PURCHASE unit by canon. Paired
      -- in JS with a PURCHASE-unit quantity and with nothing else.
      gi.unit_price                                         AS grn_rate,
      rm.unit                                               AS rm_unit,
      rm.purchase_unit                                      AS rm_purchase_unit,
      rm.pack_size                                          AS rm_pack_size,
      rm.average_price                                      AS rm_average_price
    ${FROM_JOIN}
     WHERE ${where.sql}
     ORDER BY r.date ASC,
              r.ret_number ASC,
              rm.name COLLATE NOCASE ASC,
              li.id ASC
     LIMIT ?
  `).all(...where.params, RETURN_LOG_MAX_ROWS) as any[];

  const rows: ReturnLogRow[] = raw.map((r) => {
    const src: ReturnLogSource = s(r.kind) === 'vendor' ? 'VENDOR' : 'INTERNAL';
    const meta: PackMeta = {
      unit: s(r.rm_unit),
      purchase_unit: s(r.rm_purchase_unit),
      pack_size: Number(r.rm_pack_size) || 1,
    };
    const recipeQty = r6(r.recipe_qty);
    const accRecipeQty = r6(r.accepted_recipe_qty);
    const purchaseQty = r6(toPurchaseQty(recipeQty, meta));
    const accPurchaseQty = r6(toPurchaseQty(accRecipeQty, meta));

    const moved = num(r.moved) === 1;
    const storeRejected = num(r.store_rejected) === 1;
    const d = disposition(r.disposition);
    const ticketStatus = s(r.ticket_status);

    const { rate, source: rateSrc } =
      rowRate(db, src, r.grn_rate, s(r.material_id), meta, r.rm_average_price, rates);

    const effect = stockEffect(src, moved, d);
    const owed = expectedReceipts(effect);
    const deptTxnId = s(r.dept_txn_id);
    const invTxnId = s(r.inv_txn_id);

    return {
      source: src,
      ret_number: s(r.ret_number),
      return_id: s(r.return_id),
      line_id: s(r.line_id),
      date: s(r.date),
      raised_at: s(r.raised_at),
      raised_by: s(r.raised_by),
      approved_by: s(r.approved_by),
      approved_at: s(r.approved_at),
      verified_by: s(r.verified_by),
      verified_at: s(r.verified_at),
      status: lineStatus(ticketStatus, storeRejected, accRecipeQty),
      ticket_status: ticketStatus,
      department_id: s(r.department_id) || null,
      department: s(r.department),
      vendor: s(r.vendor),
      po_no: s(r.po_no),
      grn_no: s(r.grn_no),
      material_id: s(r.material_id),
      material: s(r.material),
      sku: s(r.sku),
      category: s(r.category),
      qty: r6(r.qty),
      unit: s(r.unit),
      qty_basis: 'line',
      recipe_qty: recipeQty,
      recipe_unit: s(r.rm_unit),
      purchase_qty: purchaseQty,
      purchase_unit: s(r.rm_purchase_unit) || s(r.rm_unit),
      accepted_qty: r6(r.accepted_qty),
      accepted_recipe_qty: accRecipeQty,
      accepted_purchase_qty: accPurchaseQty,
      reason: s(r.reason),
      store_reject_reason: s(r.store_reject_reason),
      disposition: d,
      rate: rate === null ? null : r2(rate),
      rate_basis: rate === null ? '' : 'purchase',
      rate_source: rateSrc,
      // rate-basis: purchase  (Rs per purchase unit x purchase-unit quantity)
      requested_value: rate === null ? null : r2(purchaseQty * rate),
      // rate-basis: purchase
      accepted_value: rate === null ? null : r2(accPurchaseQty * rate),
      value_basis: rate === null ? '' : (src === 'VENDOR' ? 'credit_note' : 'memo'),
      stock_moved: moved,
      stock_effect: effect,
      dept_txn_id: deptTxnId,
      inv_txn_id: invTxnId,
      // Only the receipts this line's DIRECTION actually owes. See
      // expectedReceipts() and the note on ReturnLogRow.receipt_missing.
      receipt_missing: (owed.dept && !deptTxnId) || (owed.inv && !invTxnId),
      notes: s(r.notes),
    };
  });

  return { rows, totals, truncated: totals.lines > rows.length, from, to };
}

/**
 * Rs per PURCHASE unit for one line, WITH the provenance of that rate. THE ONLY
 * PLACE A RATE IS CHOSEN, and it hands back both facts from one call so the row
 * list, the totals and the "Rate Source" column cannot ever disagree about the
 * same line.
 *
 * VENDOR takes the GRN line's own unit_price — the document rate the goods
 * actually arrived at, which is the only rate a credit note can honestly be
 * claimed at. A vendor line whose GRN line cannot be resolved returns NULL and
 * DOES NOT fall through to the ladder below: substituting a valuation rate for
 * a document rate turns "what the vendor owes us" into a guess wearing a rupee
 * sign.
 *
 * INTERNAL takes closing-valuation's sanctioned ladder (latest
 * purchases.unit_price, then average_price x packFactor, then none), whose
 * materialRate() already returns a per-PURCHASE-unit figure.
 * raw_materials.last_purchase_price is never read — mixed basis.
 */
function rowRate(
  db: DatabaseT.Database,
  source: ReturnLogSource,
  grnRate: unknown,
  materialId: string,
  meta: PackMeta,
  averagePrice: unknown,
  rates: Map<string, { unit_price: number; date: string }>,
): { rate: number | null; source: ReturnLogRateSource } {
  if (source === 'VENDOR') {
    const v = Number(grnRate);
    // rate-basis: purchase
    return Number.isFinite(v) && v > 0
      ? { rate: v, source: 'grn_line' }
      : { rate: null, source: 'none' };
  }
  const mr = materialRate(
    db,
    {
      id: materialId,
      unit: meta.unit,
      purchase_unit: meta.purchase_unit,
      pack_size: meta.pack_size,
      average_price: Number(averagePrice) || 0,
    },
    rates.get(materialId) ?? null,
  );
  // rate-basis: purchase  (MaterialRate.ratePerPurchaseUnit, by its own contract)
  return {
    rate: mr.source === 'none' ? null : mr.ratePerPurchaseUnit,
    source: mr.source,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV — shared so the download and the on-screen table cannot drift apart
// ─────────────────────────────────────────────────────────────────────────────

export interface ReturnLogColumn {
  key: keyof ReturnLogRow;
  label: string;
  /** Numeric columns skip the spreadsheet-formula guard (it would break "-12.5"). */
  numeric?: boolean;
}

/**
 * The column order requirement 79 asked for, in its own words, comes first —
 * Item Name, PO No., GRN No., Raised By, Date & Time, Approved By, Reason,
 * Status, Quantity — with the columns that keep those nine honest immediately
 * around them. Exported so the route's CSV and the page's table are the same
 * list and cannot drift.
 */
export const RETURN_LOG_COLUMNS: ReturnLogColumn[] = [
  // The fork, first, because every number to its right depends on it.
  { key: 'source',                label: 'Source (VENDOR = stock out / INTERNAL = stock back in)' },
  { key: 'ret_number',            label: 'Return No' },
  { key: 'date',                  label: 'Date' },
  { key: 'raised_at',             label: 'Date & Time Raised' },
  { key: 'material',              label: 'Item Name' },
  { key: 'sku',                   label: 'SKU' },
  { key: 'category',              label: 'Category' },
  { key: 'po_no',                 label: 'PO No' },
  { key: 'grn_no',                label: 'GRN No' },
  { key: 'department',            label: 'Department' },
  { key: 'vendor',                label: 'Vendor' },
  { key: 'raised_by',             label: 'Return Ticket Raised By' },
  { key: 'approved_by',           label: 'Approved By (Dept Head / Manager)' },
  { key: 'approved_at',           label: 'Approved At' },
  { key: 'verified_by',           label: 'Store Verified By' },
  { key: 'verified_at',           label: 'Store Verified At' },
  { key: 'status',                label: 'Status (line)' },
  { key: 'ticket_status',         label: 'Ticket Status' },
  { key: 'reason',                label: 'Reason' },
  { key: 'disposition',           label: 'Disposition (reusable / wastage / disposal)' },
  { key: 'store_reject_reason',   label: 'Store Reject Reason' },
  // Quantity in all three honest bases. The purchase-unit figure leads on
  // screen per the owner rule; the recipe figure is what stock moves by.
  { key: 'qty',                   label: 'Qty (as entered)', numeric: true },
  { key: 'unit',                  label: 'Entered Unit' },
  { key: 'purchase_qty',          label: 'Qty (purchase units)', numeric: true },
  { key: 'purchase_unit',         label: 'Purchase Unit' },
  { key: 'recipe_qty',            label: 'Qty (recipe units)', numeric: true },
  { key: 'recipe_unit',           label: 'Recipe Unit' },
  { key: 'accepted_purchase_qty', label: 'Accepted Qty (purchase units)', numeric: true },
  { key: 'accepted_recipe_qty',   label: 'Accepted Qty (recipe units)', numeric: true },
  { key: 'rate',                  label: 'Rate (Rs/purchase unit)', numeric: true },
  { key: 'rate_source',           label: 'Rate Source' },
  { key: 'requested_value',       label: 'Value Requested (Rs)', numeric: true },
  { key: 'accepted_value',        label: 'Value Accepted (Rs)', numeric: true },
  { key: 'value_basis',           label: 'Value Basis (credit note / memo)' },
  // The movement facts. Without these three a reader counts pending requests
  // as though the grams had already travelled.
  { key: 'stock_moved',           label: 'Stock Moved' },
  { key: 'stock_effect',          label: 'Stock Effect' },
  { key: 'receipt_missing',       label: 'Movement Receipt Missing' },
  { key: 'dept_txn_id',           label: 'Dept Ledger Txn' },
  { key: 'inv_txn_id',            label: 'Inventory Txn' },
  { key: 'line_id',               label: 'Return Line ID' },
  { key: 'notes',                 label: 'Notes' },
];

/**
 * Escape one CSV field. Free-text (vendor, item, reason, notes) gets the
 * leading `=+-@` guard — Excel executes those as formulas, and a return reason
 * is user-entered text that reaches this file unfiltered.
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
  while (cells.length < RETURN_LOG_COLUMNS.length) cells.push('');
  return cells.join(',');
}

/**
 * Serialise to CSV: a basis banner, the column header, then the rows.
 *
 * ACCEPTS EITHER the row array or the whole result, matching issueLogToCsv, so
 * a route that appends its own totals block can hand over `result.rows` while a
 * direct caller hands over the result and gets the per-source totals written
 * here. Given a bare array it writes no totals block, so the route's output has
 * one block and not two.
 *
 * The banner leads because the CSV is the artefact that gets mailed around and
 * pasted into a deck, stripped of every caption the screen had — and the two
 * misreadings that matter are adding the sources together and reading a pending
 * ticket as a movement.
 *
 * Returns the body WITHOUT the UTF-8 BOM: the route prepends it, and exactly
 * once. Two BOMs is worse than none — the second is ordinary data and leaves a
 * zero-width character inside the first header cell.
 */
export function returnLogToCsv(input: ReturnLogRow[] | ReturnLogResult): string {
  const result: ReturnLogResult | null = Array.isArray(input) ? null : input;
  const rows: ReturnLogRow[] = Array.isArray(input)
    ? input
    : (Array.isArray(input?.rows) ? input.rows : []);
  const out: string[] = [];

  const window = result ? `  ${s(result.from)} to ${s(result.to)}` : '';
  out.push(csvBanner(`RETURN REPORT${window}`));
  out.push(csvBanner(result?.totals?.basis || TOTALS_BASIS));
  if (result?.truncated) {
    out.push(csvBanner(
      'WARNING: this list was TRUNCATED by the server and is NOT the full report. '
      + 'The per-source totals are still computed over the full filtered set.',
    ));
  }
  out.push(RETURN_LOG_COLUMNS.map(c => csvCell(c.label)).join(','));

  for (const r of rows) {
    out.push(RETURN_LOG_COLUMNS.map(c => csvCell(r[c.key], !!c.numeric)).join(','));
  }

  // ── PER-SOURCE TOTALS, each with its own basis sentence and NO grand total.
  // Only when the caller handed over the whole result; the route builds its own
  // and a second block would read as a contradiction.
  const bySource = result && Array.isArray(result.totals?.by_source) ? result.totals.by_source : [];
  if (bySource.length > 0) {
    out.push('');
    out.push(csvBanner(
      'TOTALS PER SOURCE — opposite directions on central stock. DO NOT ADD THEM.',
    ));
    for (const t of bySource) {
      const qty = t.requested_qty === null || t.requested_qty === undefined
        ? 'qty totals withheld (more than one item in view — a cross-item quantity sum is meaningless)'
        : `requested ${t.requested_qty} ${t.qty_unit}, accepted ${t.accepted_qty} ${t.qty_unit} (${t.qty_basis} basis)`;
      const val = `Rs ${t.requested_value} requested / Rs ${t.accepted_value} accepted `
        + `(${t.value_basis === 'credit_note' ? 'CREDIT NOTE claim, not a spend' : 'VALUED MEMO, not a spend'})`;
      // "moved stock" is stated as a COUNT out of the total, not as a share,
      // because the number that matters is how many lines the store has NOT yet
      // accepted — those moved nothing at all.
      const moved = `${t.moved_lines} of ${t.lines} lines moved stock (Store Accept is the only step that moves it)`;
      const waste = `${t.wastage_lines} wastage / ${t.disposal_lines} disposal`;
      out.push(csvBanner(
        `${t.source}: ${t.lines} lines across ${t.tickets} tickets | ${qty} | ${val} | ${moved} | ${waste}`,
      ));
      out.push(csvBanner(`    ${t.basis}`));
    }
  }

  return out.join('\r\n');
}

/** Filename the download must use: return-log-<from>_<to>.csv */
export function returnLogFilename(from: string, to: string): string {
  return `return-log-${from}_${to}.csv`;
}
