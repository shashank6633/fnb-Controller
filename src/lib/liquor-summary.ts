/**
 * LIQUOR PURCHASE RECONCILIATION — SUMMARY (phase L5, the read-only report).
 *
 * Plan: docs/liquor-reconciliation-plan.md (§L5). Contract + vocab: liquor-recon.ts.
 *
 * This is the workbook's Summary sheet as a live computation over a date range:
 * sections A / A2 / B / C / D / E / F / G / H plus the FOUR named checks. It is a
 * READER AND RENDERER and NOTHING ELSE — every function here only SELECTs. It
 * writes no lq_ row, moves no stock, touches no money, and (rule 1 of the L0
 * header) never feeds landed cost into a valuation column.
 *
 * WHERE THE NUMBERS COME FROM — every figure is computed from recorded lines, per
 * the sheet's own "computed, not assumed" stance. Not one rate is hardcoded.
 *
 *   §A  wallet reconciliation      ← L2 buildWalletView (SUM over lq_wallet_txns)
 *   §A2 top-up planner             ← L2 topUpPlan + getTopUpStep
 *   §B  purchase totals + value    ← store_bill_charges (deployed inward register)
 *   §C  beer / spirit split        ← indent lines classified by L1 lq_brand_map
 *   §D  derived factors            ← recorded levies ÷ recorded case/bottle counts
 *   §E  wine-shop excess           ← L3 retailExcessSummary (ONE definition)
 *   §F  total liquor cost          ← §B depot spend + §E retail spend
 *   §G  rate-movement watch        ← L1 rateMovementForStore
 *   §H  non-sale issues            ← lq_withdrawals (L4 writes them)
 *
 *   check A  wallet balance vs portal      ← newest lq_portal_checks(wallet_balance)
 *                                            at/before `to` vs L2 walletBalanceAsOf
 *   check B  per-indent value vs portal    ← lq_portal_checks(indent_value) vs Net Indent,
 *                                            newest reading per indent, inside the range
 *   check C  bank-unconfirmed deposits     ← wallet summary (type='deposit' & pending)
 *   check D  retail excess                 ← L3 retailExcessSummary().excessTotal
 *
 * TWO BASES, ONE SCREEN. §B/§F read whole recorded BILLS; §C/§D sum the recorded
 * LINES inside the range. See LqBasis — the divergence is measured and printed,
 * never left for the reader to notice.
 *
 * VALUE AT: RECORDED (DEFAULT) OR LANDED — owner decision 1 (2026-08-31): "both
 * bases behind a toggle; reports default to the EXISTING recorded basis; landed
 * is opt-in; nothing silently revalues." See LqValueBasis. The setting
 * (LQ_VALUE_BASIS_KEY) picks the report's default and the page's "Value at"
 * switch overrides it for one view; absent or unreadable, it is RECORDED. On the
 * recorded basis every landed-only figure in §C/§D/§F/§H is null, not merely
 * hidden, so neither the page nor the CSV can lead with one; each of those
 * sections carries the basis it was built on and one sentence naming it. The
 * switch changes what this REPORT shows and nothing else — no valuation column,
 * recipe cost or pour cost reads it (L0 rule 1).
 *
 * VENDOR NAME REVIEW (owner decision 3) rides along as `vendor_review`: flags
 * only, from liquor-vendor-review.ts — nothing merges.
 *
 * SIBLING DEPENDENCIES. L1 (liquor-recon), L2 (liquor-wallet) and L3
 * (liquor-retail) are consumed as libraries — §E in particular calls L3's
 * retailExcessSummary rather than re-deriving it, so "excess" and "unreimbursed"
 * have exactly one definition. L4's rows are self-contained (frozen figures), so
 * L5 reads lq_withdrawals directly for §H's buckets, but takes §H's
 * "% of purchases" from L4's withdrawalSummary so the two screens agree.
 *
 * §G's MASTER RATES ARE ADMIN-ONLY (LqSummaryOpts.revealMasterRates, LqSectionG),
 * and so is every §E figure built on a wine-shop buy's depot rate (LqSectionE) —
 * that rate is the master per bottle plus an indent's levies.
 *
 * NOTHING HERE CRASHES A PAGE. A section with no rows degrades to a CLEARLY
 * LABELLED "pending" state naming the phase that will populate it, and a section
 * whose TABLE is not on this database yet says THAT instead (readOr/unavailable)
 * — db.ts creates each lq_ table in its own try/catch, so a table that failed to
 * create used to 500 this whole page for ever. It never shows a fabricated zero
 * as if it were real.
 */

import type { Database } from 'better-sqlite3';
import { packFactor, caseFactor, type PackMeta } from './pack-units';
import {
  buildWalletView, topUpPlan, getTopUpStep, walletBalanceAsOf,
  csvCell, type TopUpPlan, type WalletView,
  indentMembersForStore, registerCoverFor, type IndentMemberLink,
} from './liquor-wallet';
import {
  allocateIndentBill, pickBrandMap, rateMovementForStore,
  type LqIndentLine, type LqRateVarianceRow,
} from './liquor-recon';
import { retailExcessSummary, RETAIL_DEPOT_WITHHELD_NOTE, type RetailExcessSummary } from './liquor-retail';
import { withdrawalSummary, type WithdrawalSummary } from './liquor-withdrawals';
import { getBillChargesForStore } from './store-engine';
import { vendorNameReview, type VendorReview } from './liquor-vendor-review';

/** The catalog path this report and its API are gated on (mgmtOnly). */
export const LQ_RECON_PAGE = '/inventory/liquor-reconciliation';

/* ── owner decision 1: the report's VALUE-AT basis ───────────────────────────── */

/**
 * 'recorded' — the platform's EXISTING basis: what the store ledger and the
 *   bills record as the value of the stock (bill invoice value / ledger
 *   unit_cost; the TGBCL levies stay recorded-only). THE DEFAULT.
 * 'landed'   — opt-in analytics: rate paid + that line's share of the four
 *   TGBCL levies (L1), so §C uplift, §D avg landed per bottle, §F on the Net
 *   Indent and §H's frozen landed values.
 * Report-only either way: recipe and pour costing stay on the existing basis.
 */
export const LQ_VALUE_BASES = ['recorded', 'landed'] as const;
export type LqValueBasis = (typeof LQ_VALUE_BASES)[number];
export const isLqValueBasis = (v: unknown): v is LqValueBasis => v === 'recorded' || v === 'landed';

/** settings.key holding the report's DEFAULT basis. Absent = 'recorded'. */
export const LQ_VALUE_BASIS_KEY = 'lq_report_value_basis';

/** The report's default basis. Anything absent, unreadable or unrecognised is
 *  RECORDED — the existing basis is what a broken setting falls back to, never
 *  the opt-in one. Read-only (the one writer is PUT /api/liquor/reconciliation,
 *  admin + CSRF + audited). */
export function getReportValueBasis(db: Database): LqValueBasis {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(LQ_VALUE_BASIS_KEY) as { value?: string } | undefined;
    const v = String(row?.value ?? '').trim();
    return isLqValueBasis(v) ? v : 'recorded';
  } catch { return 'recorded'; }
}

/** What the report was built on, for the page's switch and every CSV. */
export interface LqValueBasisInfo {
  /** The basis THIS result was built on. */
  active: LqValueBasis;
  /** The report's default (the setting) — what a view with no override shows. */
  default_basis: LqValueBasis;
  /** true when this view asked for a basis other than the default. */
  overridden: boolean;
  note: string;
}

/* ── rounding, mirrored from the deployed register + the wallet lib ──────────── */
const r2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;
const r4 = (n: number): number => Math.round((Number(n) || 0) * 1e4) / 1e4;
/** ₹ equal to the paisa — the same tolerance the wallet's portal check uses. */
const eqPaise = (a: number, b: number): boolean =>
  Math.round((Number(a) || 0) * 100) === Math.round((Number(b) || 0) * 100);
const safeDiv = (a: number, b: number): number | null =>
  b > 0 ? (Number(a) || 0) / b : null;
/** ₹ for a sentence (basis notes), Indian grouping, at most 2dp. */
const rs = (n: number): string =>
  '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

/* ── which sibling phase still owes the data behind an empty section ─────────── */
export type LqPhase = 'L1' | 'L2' | 'L3' | 'L4';
export interface LqPending {
  phase: LqPhase;
  /** Plain sentence for the page's pending banner. */
  reason: string;
}

export type LqBucketKey = 'BEER' | 'IML' | 'Duty Paid' | 'Unmapped';
export const LQ_BUCKETS: LqBucketKey[] = ['BEER', 'IML', 'Duty Paid', 'Unmapped'];

export interface LqTypeBucket {
  key: LqBucketKey;
  lines: number;
  bottles: number;
  cases: number;
  /** Σ line subtotal (bottles × indent rate). */
  invoiceValue: number;
  /** Σ of the four allocated bill-level levies. */
  levies: number;
  /** invoiceValue + levies — analytics-only landed value (never a valuation).
   *  null on the RECORDED basis (owner decision 1: landed is opt-in). */
  landedValue: number | null;
  /** landedValue ÷ invoiceValue — the workbook's per-category "uplift". null when
   *  nothing was purchased in the bucket, and on the RECORDED basis. */
  uplift: number | null;
}

/* ── §A wallet reconciliation ────────────────────────────────────────────────── */
export interface LqSectionA {
  balance: number;
  overdrawn: boolean;
  working_capital_parked: number;
  funded_in: number;
  utilised_out: number;
  deposits_utilised_pct: number | null;
  opening_total: number;
  deposit_total: number;
  indent_debit_total: number;
  adjustment_net: number;
  window_opening_balance: number;
  window_closing_balance: number;
  row_count: number;
  bank_unconfirmed_count: number;
  bank_unconfirmed_total: number;
  pending: LqPending | null;
}

/* ── §A2 top-up planner ──────────────────────────────────────────────────────── */
export interface LqSectionA2 extends TopUpPlan {
  /** true when the caller supplied a planned indent to plan against. */
  planned: boolean;
  /** Set when there is no wallet to plan against — a challan sized off a ₹0
   *  balance is a plan, and an unlabelled one is a plan that gets acted on. */
  pending: LqPending | null;
}

/* ── §B purchase totals + per-indent Value Check ─────────────────────────────── */
export interface LqIndentRow {
  invoice_ref: string;
  date: string;
  supplier: string;
  lines: number;
  invoice_value: number;
  mrp_rounding: number;
  excise_turnover_tax: number;
  special_excise_cess: number;
  tcs: number;
  net_indent_value: number;
  /** true when store_bill_charges carried a row; false = no TGBCL levies recorded
   *  (net = invoice value). */
  has_charges: boolean;
  /** true when this bill has lines OUTSIDE the selected range. The row still
   *  carries the WHOLE bill's recorded value (a bill's levies belong to the
   *  bill, not to a filter), so the same bill counts in full in every window it
   *  touches — §B is therefore not month-additive across a straddling bill, and
   *  §C/§D, which sum only the in-range lines, will read lower. Flagged rather
   *  than silently split. */
  partial_in_range: boolean;
  /** REGISTER UPLOAD: the inward numbers (as filed) whose lines this row's
   *  levies, Net Indent and wallet debit cover — a /procure-bulk register CSV
   *  posts each line under its own inward_no but keys the levies on the header
   *  ref (lq_indent_members). Their lines are counted in THIS row, and they get
   *  no row of their own. [] for an ordinary bill. */
  covers: string[];
}
export interface LqSectionB {
  indents: LqIndentRow[];
  totals: {
    indents: number;
    invoice_value: number;
    mrp_rounding: number;
    excise_turnover_tax: number;
    special_excise_cess: number;
    tcs: number;
    net_indent_value: number;
  };
  pending: LqPending | null;
}

/**
 * THE TWO BASES, STATED OUT LOUD.
 *
 * §B (and §F, and §H's "% of purchases") reads the RECORDED BILL: the header
 * figures in store_bill_charges, whole, for any bill with at least one line in
 * the range. §C/§D sum the RECORDED LINES that fall inside the range. Both are
 * right on their own basis and they disagree whenever
 *   · a bill straddles the range edge (counted whole by §B, part by §D),
 *   · a purchase line carries no invoice ref (invisible to §B, counted by §D), or
 *   · a bill header's invoice_value was typed differently from its own line sum.
 * Two "purchase value" totals on one screen with nothing to tell them apart is
 * how a month gets reconciled against the wrong one, so the divergence is
 * measured and reported instead of left for the reader to notice.
 */
export interface LqBasis {
  /** §B — Σ recorded bill headers (whole bills). */
  bill_invoice_value: number;
  /** §D — Σ recorded ledger lines inside the range. */
  line_invoice_value: number;
  /** bill − line. */
  difference: number;
  diverges: boolean;
  /** Refs whose bill has lines outside the range (counted whole by §B). */
  straddling_indents: string[];
  /** In-range purchase lines carrying no invoice ref — counted by §C/§D, and
   *  invisible to §B/§F/§G, which key on the ref. */
  unattributed_lines: number;
  unattributed_value: number;
  /** One sentence for the page and the CSV; '' when the two bases agree. */
  note: string;
}

/* ── §C beer / spirit split ──────────────────────────────────────────────────── */
export interface LqSectionC {
  buckets: LqTypeBucket[];
  beer: LqTypeBucket;
  /** IML + Duty Paid rolled up. landedValue is null on the RECORDED basis. */
  spirits: { bottles: number; cases: number; invoiceValue: number; landedValue: number | null; lines: number };
  unmapped: LqTypeBucket;
  mappedLines: number;
  totalLines: number;
  /** The basis the value columns were built on (owner decision 1). */
  value_basis: LqValueBasis;
  /** One sentence naming it, for the page and the CSV. */
  basis_note: string;
  pending: LqPending | null;
}

/* ── §D derived factors — every one COMPUTED, never assumed ──────────────────── */
export interface LqSectionD {
  bottles: number;
  cases: number;
  invoice_value: number;
  levies_total: number;
  /** invoice + levies. null on the RECORDED basis (landed is opt-in). */
  landed_value: number | null;
  /** landed ÷ invoice, overall. null on the RECORDED basis. */
  uplift_overall: number | null;
  uplift_by_type: Array<{ key: LqBucketKey; uplift: number | null }>;
  /** Σ tcs ÷ Σ invoice value × 100. */
  effective_tcs_pct: number | null;
  /** Cess allocated to CASE-PACKED lines ÷ their cases. Both halves are on the
   *  same basis on purpose: dividing ALL the cess (loose bottles included) by
   *  case-packed cases only overstates the per-case figure. */
  cess_per_case: number | null;
  /** Σ special excise cess ÷ Σ bottles — robust when case size is unknown. */
  cess_per_bottle: number | null;
  /** Σ mrp rounding ÷ Σ bottles (a per-bottle rounding, per the sheet). */
  mrp_rounding_per_bottle: number | null;
  /** Σ landed ÷ Σ bottles. Analytics only. null on the RECORDED basis. */
  avg_landed_per_bottle: number | null;
  /** Σ invoice value ÷ Σ bottles — the RECORDED-basis average a bottle was
   *  bought at (the rate paid, no levies). Always present. */
  avg_recorded_per_bottle: number | null;
  /** The basis the value figures were built on (owner decision 1). The levy
   *  factors (TCS %, cess, MRP rounding) are recorded levy facts and are shown
   *  on both bases. */
  value_basis: LqValueBasis;
  basis_note: string;
  /** bottles on case-packed lines (a case of more than 1 bottle) — `cases`
   *  counts these alone. */
  case_packed_bottles: number;
  /** bottles bought loose (no outer case). They are NOT in `cases`. */
  loose_bottles: number;
  /** Where each line's case size came from: the TGBCL brand master
   *  (lq_brand_map.bottles_per_case — preferred), the material's own
   *  raw_materials.case_size (no usable master row), or neither (loose). */
  case_source: { master_lines: number; material_lines: number; loose_lines: number };
  pending: LqPending | null;
}

/* ── §E emergency wine-shop purchases ────────────────────────────────────────── */
export interface LqRetailRow {
  id: string;
  date: string;
  shop_name: string;
  bottles: number;
  rate_paid_per_bottle: number;
  /** null when the depot figures are withheld (non-admin) — see LqSectionE. */
  depot_landed_per_bottle: number | null;
  excess_per_bottle: number | null;
  excess_total: number | null;
  excess_pct: number | null;
  /** A depot rate is frozen on this buy (> 0). Never a money figure. */
  priced: boolean;
  paid_by: string;
  reimbursement_status: string;
  reason: string;
}
/**
 * §E. THE DEPOT FIGURES ARE ADMIN-ONLY, under the same switch as §G's master
 * rates (LqSummaryOpts.revealMasterRates). A buy's depot rate is L1's
 * landedPerBottle frozen at entry: the TGBCL master ÷ bottles itself for a brand
 * with no recorded indent ('master_only'), and — on every row frozen before
 * owner decision 2 moved L1 onto the rate paid — the master plus the latest
 * indent's levies, which §B serves to the same viewer (measured: a manager
 * re-derived the master §G withholds to the paisa, depot 4,014.69 − levies
 * 264.69 = 3,750 = the ₹45,000 master ÷ 12). A row stores no basis, so all are
 * treated alike. Withheld, with everything it can be
 * re-derived from: each row's depot rate, excess per bottle / total / %, and
 * the section's depot_equivalent and excess_total (with one buy in range each
 * IS that buy's figure). What a non-admin keeps: every buy, its bottles, the
 * rate paid, retail spend, who paid, what is still owed, and the counts.
 */
export interface LqSectionE {
  rows: LqRetailRow[];
  bottles: number;
  spend: number;
  /** null when withheld (non-admin). */
  depot_equivalent: number | null;
  /** Σ excess over buys with a KNOWN depot rate. A buy we could not price never
   *  masquerades as a zero-excess buy (L3's rule, and L3's figure). null when
   *  withheld (non-admin). */
  excess_total: number | null;
  /** true for an admin; false → the depot-derived figures above are null. */
  depot_figures_visible: boolean;
  /** When withheld, one sentence saying so and where an admin sees them. */
  depot_figures_note: string | null;
  /** Still owed to staff who fronted it: pending claims PLUS any claim marked
   *  reimbursed whose petty-cash payout was deleted. */
  unreimbursed_staff_spend: number;
  /** Buys whose depot rate is unknown — counted, never folded into excess_total. */
  unknown_depot_count: number;
  unknown_depot_bottles: number;
  /** Claims marked reimbursed with no payout behind them (a deleted payout);
   *  already inside unreimbursed_staff_spend, surfaced so the page can say why. */
  reopened_claim_count: number;
  pending: LqPending | null;
}

/* ── §F total liquor cost ────────────────────────────────────────────────────── */
/**
 * §F. ONE BASIS PER CARD (owner decision 1). The card's `total` and `share_pct`
 * are built on the SAME denominator, the active value basis:
 *   RECORDED (default) — total = recorded depot purchase value + wine-shop
 *     spend (L3's liquorSpend), share = retail ÷ that = L3's wineShopSharePct,
 *     the retail register's own figure to the digit.
 *   LANDED (opt-in)    — total = depot Net Indent + wine-shop spend (the
 *     workbook's cash figure: the Net Indent IS the bills' landed value), share
 *     = retail ÷ that.
 * The card used to print the Net-Indent total beside a share computed on the
 * recorded denominator, which it never showed (measured: total ₹1,69,222, share
 * 6.43% — a reader dividing ₹10,400 by the total on the card got 6.15%).
 * `depot_net_indent` is §B's recorded bill figure and is present on both bases;
 * the landed TOTAL and SHARE are null on the recorded basis.
 */
export interface LqSectionF {
  value_basis: LqValueBasis;
  /** §B — Σ Net Indent of the bills in range (what TGBCL was paid, levies
   *  included). A recorded bill figure, present on both bases. */
  depot_net_indent: number;
  retail_spend: number;
  /** Recorded depot purchase value in range (L3's depotSpend: Σ store-ledger
   *  purchase lines, IST day). */
  depot_recorded_value: number;
  /** depot_recorded_value + retail_spend (L3's liquorSpend). */
  total_recorded: number;
  /** depot_net_indent + retail_spend. null on the RECORDED basis. */
  total_landed: number | null;
  /** THE CARD'S TOTAL, on the active basis: total_recorded or total_landed. */
  total: number;
  /** RECORDED basis: retail_spend ÷ total_recorded × 100 — identical to L3's
   *  wineShopSharePct. null when there is nothing to divide by. */
  retail_share_pct: number | null;
  /** LANDED basis: retail_spend ÷ total_landed × 100. null on the RECORDED basis. */
  retail_share_pct_of_total: number | null;
  /** THE CARD'S SHARE — same denominator as `total`. */
  share_pct: number | null;
  /** One sentence naming the card's total and its share's denominator. */
  retail_share_basis: string;
  pending: LqPending | null;
}

/* ── §G rate-movement watch ──────────────────────────────────────────────────── */
export interface LqRateMoveRow {
  ledgerId: string;
  invoiceRef: string;
  inwardDate: string;
  materialName: string;
  category: string;
  bottles: number;
  indentRate: number;
  masterRate: number | null;
  variance: number | null;
  varianceValue: number | null;
  proposedRatePerCase: number | null;
  /** Which way the indent rate moved against the master — the one thing a
   *  non-admin is told about a moved line (it names no rate). */
  direction: 'above_master' | 'below_master';
  mapReason: string;
}
/**
 * §G. THE MASTER RATES ARE ADMIN-ONLY. The TGBCL brand master is admin on every
 * verb of its own API, GET included (brand-map/_lib/guard.ts), and §G is the
 * same rows. So unless LqSummaryOpts.revealMasterRates is set (the route sets it
 * for an admin only), every field the master rate can be RE-DERIVED from is
 * withheld, not just the rate itself:
 *   masterRate          — the rate;
 *   variance            — indentRate − masterRate, so master = indent − variance;
 *   varianceValue       — variance × bottles, so master = indent − value ÷ bottles;
 *   proposedRatePerCase — what an accept would write into the master;
 *   total_variance_value — with one moved line it IS that line's varianceValue.
 * Hiding only the first and the last of those would be a redaction in name only.
 * What a non-admin keeps: which lines moved, their indent rate (the rate paid —
 * on the bill already), the bottles, the direction, and the counts.
 *
 * NOT THE ONLY DOOR. The master also sat inside §E: a wine-shop buy's depot
 * rate can be the master per bottle itself, or the master plus levies §B
 * prints, so §E's depot figures go under the same switch (LqSectionE). And
 * inside §H: a withdrawal's frozen landed value is L1's landed cost at issue,
 * which for a brand never indented IS the master per bottle (measured: Gin,
 * one bottle, ₹760.28 = the ₹9,123.36 master ÷ 12, served to a manager as §H
 * landed value AND — on the default basis — as the recoverable of a
 * withdrawal recovered "at landed cost"; the bottle count is on the store
 * ledger). So §H's landed values, and every recoverable / recovered /
 * outstanding figure that contains a landed-cost recovery, go under the same
 * switch too (LqSectionH).
 */
export interface LqSectionG {
  rows: LqRateMoveRow[];
  moved_lines: number;
  scanned_lines: number;
  unmapped_lines: number;
  /** null when the master rates are withheld (non-admin). */
  total_variance_value: number | null;
  /** true for an admin; false → the master-derived fields above are null. */
  master_rates_visible: boolean;
  /** When withheld, one sentence saying so and where an admin sees them. */
  master_rates_note: string | null;
  pending: LqPending | null;
}

/* ── §H non-sale issues (stock withdrawals) ──────────────────────────────────── */
export interface LqWithdrawalBucket {
  category: string;
  count: number;
  /** RECORDED basis: Σ qty × the store's recorded weighted-average unit cost
   *  as of each withdrawal's date (priced inflows only — the basis storeStock()
   *  values the store at). Present on both bases. */
  recorded_value: number;
  /** Withdrawals in this bucket the store had no recorded cost for on their
   *  date — counted here, never valued at a silent 0. */
  recorded_unpriced: number;
  /** Σ the landed value frozen on each withdrawal. null on the RECORDED basis,
   *  and null for a non-admin on EITHER basis (see LqSectionH). */
  landed_value: number | null;
  mrp_value: number;
  /** Σ recoverable / recovered / outstanding. null for a non-admin when this
   *  bucket holds a withdrawal recovered AT LANDED COST: that row's recoverable
   *  IS its frozen landed value (the master per bottle for a brand never
   *  indented), and recovered/outstanding re-derive it. A partial sum under the
   *  same heading would read as the whole debt, so the cell is withheld, not
   *  shrunk; `landed_recovery_withheld` counts the rows behind it. */
  recoverable: number | null;
  recovered: number | null;
  outstanding: number | null;
  /** Withdrawals in this bucket recovered at landed cost whose ₹ are withheld
   *  from this viewer. Always 0 for an admin. */
  landed_recovery_withheld: number;
}
/**
 * §H. ONE BASIS PER CARD (owner decision 1). The card's `total_value` and
 * `pct` are numerator and denominator on the SAME basis:
 *   RECORDED (default) — withdrawn stock at the store's recorded average cost
 *     ÷ the recorded purchase value in range (`pct_of_purchases`);
 *   LANDED (opt-in)    — the landed value frozen on each withdrawal ÷ the §B
 *     Net Indent, the bills' landed value (`pct_of_net_indent`).
 * It used to divide the frozen LANDED value by the RECORDED purchase value
 * (L4's withdrawalSummary figure — measured: ₹4,480.13 ÷ ₹1,51,440 = 2.96%), a
 * landed numerator over a recorded denominator, with nothing on screen saying
 * so. The Withdrawals page still prints that L4 ratio; `pct_basis` says how
 * the two differ.
 *
 * THE LANDED FIGURES ARE ADMIN-ONLY, under §G's switch
 * (LqSummaryOpts.revealMasterRates), exactly as §E's depot rate is. A
 * withdrawal's landed value is L1's landed cost FROZEN at issue: the master per
 * bottle itself for a brand with no recorded indent (L1 basis 'master_only'),
 * the master + levies on a row frozen before owner decision 2, the rate paid +
 * levies after it — and the row stores no basis, so all are treated alike, as
 * §E treats its rows. Category totals were no protection: the bottle count is
 * on the store ledger (the withdrawal's WD ref, −750 ml), so one withdrawal in
 * a bucket IS its own per-bottle figure (measured: Gin ₹760.28 = the admin-only
 * master to the paisa, via both the landed column and the default basis's
 * recoverable). Withheld from a non-admin, with everything that re-derives it:
 *   · landed_value per bucket, total_landed_value, the landed basis's card
 *     total and %, and the L4 "% of purchases" quoted in pct_basis (landed ÷ a
 *     recorded denominator this card prints);
 *   · recoverable / recovered / outstanding of any bucket holding a withdrawal
 *     recovered AT LANDED COST (its recoverable IS its landed value), and
 *     total_outstanding when any is held back.
 * What a non-admin keeps: every bucket and its count, the recorded value (the
 * store's own average cost, never the master), MRP values, and what is still
 * owed on withdrawals recovered at MRP or a typed amount
 * (total_outstanding_shown), with the number of landed-cost recoveries
 * withheld so a blank is never read as ₹0. An admin sees everything.
 */
export interface LqSectionH {
  value_basis: LqValueBasis;
  buckets: LqWithdrawalBucket[];
  /** Σ recorded_value — present on both bases. */
  total_recorded_value: number;
  /** Withdrawals with no recorded cost on their date (excluded from the value). */
  recorded_unpriced_count: number;
  /** Σ frozen landed value. null on the RECORDED basis, and for a non-admin. */
  total_landed_value: number | null;
  /** THE CARD'S VALUE, on the active basis. null only for a non-admin viewing
   *  the LANDED basis (the landed values are admin-only). */
  total_value: number | null;
  /** Σ outstanding over EVERY withdrawal in range. null for a non-admin when
   *  any withdrawal in range is recovered at landed cost. */
  total_outstanding: number | null;
  /** Σ outstanding over the withdrawals recovered at MRP or a typed amount —
   *  the part of the debt that carries no landed cost. Equals total_outstanding
   *  for an admin, and whenever nothing is withheld. */
  total_outstanding_shown: number;
  /** Withdrawals in range recovered at landed cost whose ₹ are withheld from
   *  this viewer. 0 for an admin. */
  landed_recovery_withheld_count: number;
  /** true for an admin; false → every landed-derived figure above is null. */
  landed_figures_visible: boolean;
  /** When withheld, one sentence saying so and where an admin sees them. */
  landed_figures_note: string | null;
  /** The RECORDED denominator: recorded purchase value in range (L4's — Σ
   *  store-ledger purchase/inward lines, IST day). */
  purchases_value: number;
  /** RECORDED basis: total_recorded_value ÷ purchases_value × 100. null when
   *  there were no purchases. */
  pct_of_purchases: number | null;
  /** LANDED basis: total_landed_value ÷ depot Net Indent (§B) × 100. null on
   *  the RECORDED basis. */
  pct_of_net_indent: number | null;
  /** THE CARD'S %, same basis as total_value. */
  pct: number | null;
  /** One sentence naming numerator and denominator, for the page/CSV. */
  pct_basis: string;
  pending: LqPending | null;
}

/* ── the four checks ─────────────────────────────────────────────────────────── */
export type LqCheckState = 'pass' | 'fail' | 'warn' | 'no_data';
export interface LqCheck {
  key: 'A' | 'B' | 'C' | 'D';
  label: string;
  state: LqCheckState;
  /** Headline figure for the card (₹ or a count), already formatted upstream is
   *  avoided — the page formats. */
  detail: string;
  computed: number | null;
  observed: number | null;
  difference: number | null;
}

export interface LqSummaryResult {
  store: { id: string; name: string };
  range: { from: string; to: string };
  generated_at: string;
  sections: {
    A: LqSectionA;
    A2: LqSectionA2;
    B: LqSectionB;
    C: LqSectionC;
    D: LqSectionD;
    E: LqSectionE;
    F: LqSectionF;
    G: LqSectionG;
    H: LqSectionH;
  };
  /** How §B and §C/§D each measure the same purchases, and by how much they
   *  differ on this range. */
  basis: LqBasis;
  /** Owner decision 1 — what §C/§D/§F/§H were valued at, and the default. */
  value_basis: LqValueBasisInfo;
  checks: LqCheck[];
  /** Which sibling phases still owe live data, for the page's dependency panel. */
  dependencies: Array<{ phase: LqPhase; label: string; live: boolean; note: string }>;
  /** Owner decision 3 — near-duplicate vendor names, FLAGS ONLY (nothing
   *  merges). null when it could not be read on this database. Not bounded by
   *  the date range or the store: it reviews the vendor master as it stands. */
  vendor_review: VendorReview | null;
}

export interface LqSummaryOpts {
  storeId: string;
  storeName?: string;
  from: string;
  to: string;
  /** §A2 planned next indent value (₹). Omitted → the planner reports the
   *  balance only. */
  plannedIndent?: number | null;
  /** §G: include the TGBCL brand master's rates and the figures derived from
   *  them — and §E's depot rate / excess figures and §H's frozen landed values
   *  (with every recoverable that is one), which re-derive the same master.
   *  ADMIN ONLY — the route passes `role === 'admin'`. Omitted → false: a
   *  caller that forgets this withholds the rates rather than leaking them. */
  revealMasterRates?: boolean;
  /** Owner decision 1: the basis to value §C/§D/§F/§H at for THIS view.
   *  Omitted → 'recorded' (the existing basis; landed is opt-in). */
  valueBasis?: LqValueBasis;
  /** The report's default basis (the setting), reported back so the page can
   *  say whether this view overrides it. Omitted → 'recorded'. */
  valueBasisDefault?: LqValueBasis;
}

/* ── one recorded indent line, in the date window, with its allocated levies ──── */
interface LineRow {
  ledgerId: string;
  materialId: string;
  materialName: string;
  category: string;
  invoiceRef: string;
  inwardDate: string;
  bottles: number;
  cases: number;
  caseSized: boolean;
  subtotal: number;
  levies: number;          // Σ of the four allocated levies (workbook bases)
  cess: number;
  tcs: number;
  mrp: number;
  turnover: number;
  bucket: LqBucketKey;
  /** true when the case size came from the TGBCL brand master's
   *  bottles_per_case (including a master of 1, i.e. sold loose). */
  caseFromMaster: boolean;
}

interface LinesRead {
  lines: LineRow[];
  /** lower-cased invoice ref → how many lines the WHOLE bill has (L1 allocates
   *  over the whole bill). More than the in-range count ⇒ the bill straddles the
   *  range edge. */
  wholeBillLines: Map<string, number>;
}

/**
 * Read the recorded indent lines in [from,to] for one store and attach each
 * line's allocated bill-level levies (from L1's allocateIndentBill, which uses
 * the workbook's two bases and the WHOLE bill so a straddling bill still splits
 * correctly) and its product-type bucket (from L1's lq_brand_map).
 */
function readLines(db: Database, storeId: string, from: string, to: string): LinesRead {
  const raw = db.prepare(`
    SELECT l.id AS ledgerId, l.material_id AS materialId, TRIM(l.ref) AS invoiceRef,
           substr(l.created_at, 1, 10) AS inwardDate,
           l.quantity, l.unit_cost,
           rm.name AS materialName, rm.category,
           rm.unit, rm.purchase_unit, rm.pack_size, rm.case_size
    FROM store_stock_ledger l
    JOIN raw_materials rm ON rm.id = l.material_id
    WHERE l.store_id = ? AND l.txn_type = 'purchase'
      AND date(l.created_at) >= date(?) AND date(l.created_at) <= date(?)
    ORDER BY l.created_at DESC, l.rowid DESC
  `).all(storeId, from, to) as any[];

  // Allocate levies once per distinct bill (whole bill), then match by ledgerId.
  const allocByLedger = new Map<string, LqIndentLine>();
  const wholeBillLines = new Map<string, number>();
  const seenRef = new Set<string>();
  for (const r of raw) {
    const ref = String(r.invoiceRef || '');
    const k = ref.toLowerCase();
    if (!ref || seenRef.has(k)) continue;
    seenRef.add(k);
    const alloc = allocateIndentBill(db, storeId, ref);
    wholeBillLines.set(k, alloc.lines.length);
    for (const ln of alloc.lines) allocByLedger.set(ln.ledgerId, ln);
  }

  // product_type AND the TGBCL case size per material, cached — a material maps
  // to one product type across its pack variants, so this is cheap and stable.
  //
  // CASES COME FROM THE TGBCL BRAND MASTER FIRST. TGBCL indents in cases, and
  // lq_brand_map.bottles_per_case is the master's own case (CHECKed > 0, set by
  // the brand import). raw_materials.case_size is the store's pack metadata and
  // is 1 on almost every liquor material (measured: 2 of 127 store-mapped
  // materials carry a case), so reading only it reported 0 cases and a null
  // cess-per-case even after the master said 24 and 12. Order:
  //   1. the picked brand-map row's bottles_per_case;
  //   2. when the pack is ambiguous but every candidate pack agrees on one
  //      bottles_per_case, that figure (the case is not what is ambiguous);
  //   3. only when the master has NO figure for the material (bpc 0 — the
  //      CHECK makes a real row > 0), raw_materials.case_size via caseFactor.
  // The master wins whenever it has a figure, INCLUDING 1: a master that says
  // one bottle per case is a pack TGBCL sells loose, and the store's own
  // case_size must not turn it back into cases. A case of 1 is "no outer case"
  // on every path — the loose-bottle rule below.
  const metaByMaterial = new Map<string, { bucket: LqBucketKey; bpc: number }>();
  const metaFor = (materialId: string): { bucket: LqBucketKey; bpc: number } => {
    const hit = metaByMaterial.get(materialId);
    if (hit) return hit;
    let bucket: LqBucketKey = 'Unmapped';
    let bpc = 0;
    try {
      const pick = pickBrandMap(db, materialId);
      if (pick.row) {
        const pt = String(pick.row.product_type || '');
        bucket = pt === 'BEER' || pt === 'IML' || pt === 'Duty Paid' ? (pt as LqBucketKey) : 'Unmapped';
        bpc = Number(pick.row.bottles_per_case) || 0;
      } else if (pick.candidates.length > 0) {
        const sizes = new Set(pick.candidates.map(c => Number(c.bottles_per_case) || 0));
        if (sizes.size === 1) bpc = [...sizes][0];
      }
    } catch { bucket = 'Unmapped'; bpc = 0; }
    const m = { bucket, bpc };
    metaByMaterial.set(materialId, m);
    return m;
  };

  const lines = raw.map(r => {
    const meta: PackMeta = {
      unit: r.unit, purchase_unit: r.purchase_unit,
      pack_size: r.pack_size, case_size: r.case_size,
    };
    const pf = packFactor(meta);
    const mm = metaFor(String(r.materialId));
    const cf = mm.bpc > 0 ? mm.bpc : caseFactor(meta);
    const qty = Number(r.quantity) || 0;
    const uc = Number(r.unit_cost) || 0;
    const bottles = pf > 1 ? qty / pf : qty;
    const caseSized = cf > 1;
    // A material with no outer case contributes ZERO cases, not its bottle
    // count. TGBCL is a case-priced trade and this figure is read as "cases
    // indented": adding loose bottles into it inflated the headline and every
    // per-case factor that divides by it. The loose bottles are still counted —
    // as bottles (§D.loose_bottles).
    const cases = caseSized ? bottles / cf : 0;
    const subtotal = r2(qty * uc);
    const ln = allocByLedger.get(String(r.ledgerId));
    const a = ln ? ln.allocated : { mrp_rounding: 0, excise_turnover_tax: 0, special_excise_cess: 0, tcs: 0 };
    const levies = ln ? ln.leviesLine : 0;
    return {
      ledgerId: String(r.ledgerId),
      materialId: String(r.materialId),
      materialName: String(r.materialName || ''),
      category: String(r.category || ''),
      invoiceRef: String(r.invoiceRef || ''),
      inwardDate: String(r.inwardDate || ''),
      bottles,
      cases,
      caseSized,
      subtotal,
      levies,
      cess: a.special_excise_cess,
      tcs: a.tcs,
      mrp: a.mrp_rounding,
      turnover: a.excise_turnover_tax,
      bucket: mm.bucket,
      caseFromMaster: mm.bpc > 0,
    };
  });
  return { lines, wholeBillLines };
}

function emptyBucket(key: LqBucketKey): LqTypeBucket {
  return { key, lines: 0, bottles: 0, cases: 0, invoiceValue: 0, levies: 0, landedValue: 0, uplift: null };
}

/**
 * A read whose backing table may not be on this database yet.
 *
 * db.ts wraps each lq_ DDL statement in its own try/catch, so a table that
 * fails to create leaves the app booting normally — and left THIS page
 * returning HTTP 500 for ever, every section of it, because one unguarded
 * SELECT threw. A section that cannot be read now degrades to a pending banner
 * that SAYS it could not be read; the fallback is never rendered as if it were
 * recorded data.
 */
function readOr<T>(fn: () => T, fallback: T): { value: T; error: string | null } {
  try { return { value: fn(), error: null }; } catch (e: any) {
    // The driver's message names internal tables and columns: it belongs in the
    // server log, not in a banner on the page (same rule the route's 500 keeps).
    console.error('[liquor-summary] section read failed', e);
    return { value: fallback, error: String(e?.message || e || 'unavailable') };
  }
}

/** The pending banner for "this table is not here", as distinct from "nothing
 *  has been recorded yet" — the two look identical on screen and mean opposite
 *  things. */
const unavailable = (phase: LqPhase, what: string): LqPending => ({
  phase,
  reason: `${what} could not be read on this database yet — the ${phase} tables are not deployed here. Every other section is unaffected; the details are in the server log.`,
});

/**
 * BUILD THE WHOLE SUMMARY. Pure read — pass a live db or a copy; it behaves the
 * same and mutates neither.
 */
export function buildLiquorSummary(db: Database, opts: LqSummaryOpts): LqSummaryResult {
  const { storeId, from, to } = opts;
  const storeName = opts.storeName || (() => {
    const r = db.prepare('SELECT name FROM store_locations WHERE id = ?').get(storeId) as any;
    return r?.name || storeId;
  })();
  // Owner decision 1. Fail to the EXISTING basis: anything but an explicit
  // 'landed' is recorded, so a caller that forgets the option never opts in.
  const valueBasis: LqValueBasis = opts.valueBasis === 'landed' ? 'landed' : 'recorded';
  const landed = valueBasis === 'landed';
  const valueBasisDefault: LqValueBasis = opts.valueBasisDefault === 'landed' ? 'landed' : 'recorded';

  /* ── §A + §A2 + check C (wallet) ─────────────────────────────────────────── */
  const walletRead = readOr<WalletView | null>(() => buildWalletView(db, from, to), null);
  const wallet = walletRead.value;
  const ws = wallet ? wallet.summary : null;
  const A: LqSectionA = {
    balance: ws?.balance ?? 0,
    overdrawn: ws?.overdrawn ?? false,
    working_capital_parked: ws?.working_capital_parked ?? 0,
    funded_in: ws?.funded_in ?? 0,
    utilised_out: ws?.utilised_out ?? 0,
    deposits_utilised_pct: ws?.deposits_utilised_pct ?? null,
    opening_total: ws?.opening_total ?? 0,
    deposit_total: ws?.deposit_total ?? 0,
    indent_debit_total: ws?.indent_debit_total ?? 0,
    adjustment_net: ws?.adjustment_net ?? 0,
    window_opening_balance: wallet?.opening_balance ?? 0,
    window_closing_balance: wallet?.closing_balance ?? 0,
    row_count: ws?.row_count ?? 0,
    bank_unconfirmed_count: ws?.bank_unconfirmed_count ?? 0,
    bank_unconfirmed_total: ws?.bank_unconfirmed_total ?? 0,
    pending: walletRead.error
      ? unavailable('L2', 'The TGBCL wallet ledger')
      : ((ws?.row_count ?? 0) === 0
        ? { phase: 'L2', reason: 'No TGBCL wallet movements recorded yet — record the opening balance, challans and indent debits on the Liquor Wallet page.' }
        : null),
  };
  /** true when there is a wallet to reconcile at all. */
  const walletLive = !walletRead.error && A.row_count > 0;

  const step = getTopUpStep(db);
  const planned = opts.plannedIndent != null && Number.isFinite(Number(opts.plannedIndent));
  const A2: LqSectionA2 = {
    ...topUpPlan({ planned_indent: planned ? Number(opts.plannedIndent) : 0, balance: A.balance, step }),
    planned,
    // Without a wallet there is no balance to plan against, and a challan sized
    // off a silent ₹0 is a number somebody acts on.
    pending: walletRead.error
      ? unavailable('L2', 'The TGBCL wallet ledger')
      : (A.row_count === 0
        ? { phase: 'L2', reason: 'No wallet balance to plan against — the challan below is sized off ₹0 until the wallet opening balance is recorded on the Liquor Wallet page.' }
        : null),
  };

  /* ── recorded indent lines in window (feeds C, D and part of B/F) ────────── */
  const linesRead = readOr<LinesRead>(
    () => readLines(db, storeId, from, to),
    { lines: [], wholeBillLines: new Map<string, number>() },
  );
  const lines = linesRead.value.lines;
  const wholeBillLines = linesRead.value.wholeBillLines;

  /* ── §B purchase totals + per-indent value ──────────────────────────────── */
  const billRead = readOr<Record<string, any>>(() => getBillChargesForStore(db, storeId), {});
  const billCharges = billRead.value;
  const linesErr = linesRead.error || billRead.error;
  // Distinct in-window invoice refs, keeping first-seen order (newest first).
  const refOrder: string[] = [];
  const refSeen = new Set<string>();
  const linesByRef = new Map<string, LineRow[]>();
  for (const ln of lines) {
    const ref = ln.invoiceRef;
    const k = ref.toLowerCase();
    if (!ref) continue;
    if (!refSeen.has(k)) { refSeen.add(k); refOrder.push(ref); }
    const arr = linesByRef.get(k) || [];
    arr.push(ln);
    linesByRef.set(k, arr);
  }
  // REGISTER UPLOADS. A /procure-bulk register CSV posts each line under its own
  // inward_no while the four levies, the Net Indent and the wallet debit are
  // keyed on the upload's HEADER ref (linkIndentMembers records which inward
  // numbers it covers). Keyed only on a line's own ref, §B listed every covered
  // inward at bottle value with "no charges" and the header — which has no line
  // of its own — nowhere: measured, §B short by exactly the register's levies
  // (₹2,012) and disagreeing with §A's utilised_out. So a covered inward is
  // folded under its header: the register is ONE row with its levies, and the
  // inward numbers it covers ride on it (`covers`). An inward that carries its
  // own charges row is its own indent and is never folded.
  const memberRead = readOr<IndentMemberLink[]>(() => indentMembersForStore(db, storeId), []);
  const headersOf = new Map<string, string[]>();   // inward key → covering header keys, oldest first
  const coversOf = new Map<string, string[]>();    // header key → inward numbers it covers, as filed
  for (const m of memberRead.value) {
    if (billCharges[m.ref_key] || !billCharges[m.header_key]) continue;
    const hs = headersOf.get(m.ref_key) || [];
    if (!hs.includes(m.header_key)) hs.push(m.header_key);
    headersOf.set(m.ref_key, hs);
    const cs = coversOf.get(m.header_key) || [];
    if (!cs.some(x => x.trim().toLowerCase() === m.ref_key)) cs.push(m.ref);
    coversOf.set(m.header_key, cs);
  }
  // Rows in first-seen order. A covered inward contributes its header(s), not
  // itself; its lines count under the OLDEST header that covers it (the same
  // inward number in two register uploads is the only way to have two).
  const groupOrder: string[] = [];
  const groupSeen = new Set<string>();
  const ownSpelling = new Map<string, string>();
  for (const ref of refOrder) {
    const k = ref.toLowerCase();
    const hs = headersOf.get(k);
    if (!hs) ownSpelling.set(k, ownSpelling.get(k) || ref);
    for (const g of (hs && hs.length ? hs : [k])) {
      if (!groupSeen.has(g)) { groupSeen.add(g); groupOrder.push(g); }
    }
  }
  const groupLines = new Map<string, LineRow[]>();
  for (const ln of lines) {
    if (!ln.invoiceRef) continue;
    const k = ln.invoiceRef.toLowerCase();
    const g = (headersOf.get(k) || [k])[0];
    const arr = groupLines.get(g) || [];
    arr.push(ln);
    groupLines.set(g, arr);
  }
  // Whole-register line counts (every covered inward, in range or not), for
  // partial_in_range — readLines only counted the refs it saw in the window.
  const coverCountRead = readOr<Map<string, number>>(() => {
    const keys = new Set<string>();
    for (const g of groupOrder) {
      const cs = coversOf.get(g);
      if (!cs) continue;
      keys.add(g);
      for (const c of cs) keys.add(c.trim().toLowerCase());
    }
    const out = new Map<string, number>();
    if (keys.size === 0) return out;
    const ks = [...keys];
    for (const r of db.prepare(`
      SELECT LOWER(TRIM(ref)) AS k, COUNT(*) AS n FROM store_stock_ledger
       WHERE store_id = ? AND txn_type = 'purchase' AND LOWER(TRIM(ref)) IN (${ks.map(() => '?').join(',')})
       GROUP BY LOWER(TRIM(ref))
    `).all(storeId, ...ks) as Array<{ k: string; n: number }>) out.set(r.k, Number(r.n) || 0);
    return out;
  }, new Map<string, number>());
  const indents: LqIndentRow[] = groupOrder.map(k => {
    const bc = billCharges[k];
    const covers = coversOf.get(k) || [];
    const ref = ownSpelling.get(k) || String(bc?.invoice_ref || '').trim() || k;
    const myLines = groupLines.get(k) || [];
    const lineInvoice = r2(myLines.reduce((s, l) => s + l.subtotal, 0));
    const firstLine = myLines[0];
    const whole = covers.length
      ? [k, ...covers.map(c => c.trim().toLowerCase())].reduce((s, x) => s + (coverCountRead.value.get(x) || 0), 0)
      : (wholeBillLines.get(k) ?? myLines.length);
    const partial_in_range = whole > myLines.length;
    if (bc) {
      return {
        partial_in_range,
        invoice_ref: ref,
        date: String(bc.date || firstLine?.inwardDate || ''),
        supplier: String(bc.supplier || ''),
        lines: myLines.length,
        invoice_value: r2(Number(bc.invoice_value) || 0),
        mrp_rounding: r2(Number(bc.mrp_rounding) || 0),
        excise_turnover_tax: r2(Number(bc.excise_turnover_tax) || 0),
        special_excise_cess: r2(Number(bc.special_excise_cess) || 0),
        tcs: r2(Number(bc.tcs) || 0),
        net_indent_value: r2(Number(bc.net_indent_value) || 0),
        has_charges: true,
        covers,
      };
    }
    // No store_bill_charges row → the bill was recorded with no TGBCL levies.
    return {
      partial_in_range,
      invoice_ref: ref,
      date: String(firstLine?.inwardDate || ''),
      supplier: '',
      lines: myLines.length,
      invoice_value: lineInvoice,
      mrp_rounding: 0, excise_turnover_tax: 0, special_excise_cess: 0, tcs: 0,
      net_indent_value: lineInvoice,
      has_charges: false,
      covers,
    };
  });
  const bTotals = indents.reduce((a, i) => ({
    indents: a.indents + 1,
    invoice_value: a.invoice_value + i.invoice_value,
    mrp_rounding: a.mrp_rounding + i.mrp_rounding,
    excise_turnover_tax: a.excise_turnover_tax + i.excise_turnover_tax,
    special_excise_cess: a.special_excise_cess + i.special_excise_cess,
    tcs: a.tcs + i.tcs,
    net_indent_value: a.net_indent_value + i.net_indent_value,
  }), { indents: 0, invoice_value: 0, mrp_rounding: 0, excise_turnover_tax: 0, special_excise_cess: 0, tcs: 0, net_indent_value: 0 });
  const B: LqSectionB = {
    indents,
    totals: {
      indents: bTotals.indents,
      invoice_value: r2(bTotals.invoice_value),
      mrp_rounding: r2(bTotals.mrp_rounding),
      excise_turnover_tax: r2(bTotals.excise_turnover_tax),
      special_excise_cess: r2(bTotals.special_excise_cess),
      tcs: r2(bTotals.tcs),
      net_indent_value: r2(bTotals.net_indent_value),
    },
    pending: linesErr
      ? unavailable('L1', 'The recorded indent lines')
      : (indents.length === 0
        ? { phase: 'L1', reason: 'No liquor indents recorded in this range — record purchases through the Liquor Store inward register.' }
        : null),
  };
  const depotNetIndent = B.totals.net_indent_value;

  /* ── §C beer / spirit split + §D factors (shared line aggregation) ───────── */
  const buckets: Record<LqBucketKey, LqTypeBucket> = {
    BEER: emptyBucket('BEER'), IML: emptyBucket('IML'),
    'Duty Paid': emptyBucket('Duty Paid'), Unmapped: emptyBucket('Unmapped'),
  };
  let totBottles = 0, totCases = 0, totInvoice = 0, totLevies = 0, totLanded = 0;
  let totCess = 0, totTcs = 0, totMrp = 0, casePackedBottles = 0, mappedLines = 0;
  let casePackedCess = 0, looseBottles = 0;
  // Landed per bucket, accumulated apart: it is published only on the landed
  // basis (owner decision 1), and null otherwise.
  const landedBy: Record<LqBucketKey, number> = { BEER: 0, IML: 0, 'Duty Paid': 0, Unmapped: 0 };
  for (const ln of lines) {
    const bkt = buckets[ln.bucket];
    bkt.lines += 1;
    bkt.bottles += ln.bottles;
    bkt.cases += ln.cases;
    bkt.invoiceValue += ln.subtotal;
    bkt.levies += ln.levies;
    landedBy[ln.bucket] += ln.subtotal + ln.levies;
    totBottles += ln.bottles;
    totCases += ln.cases;
    totInvoice += ln.subtotal;
    totLevies += ln.levies;
    totLanded += ln.subtotal + ln.levies;
    totCess += ln.cess;
    totTcs += ln.tcs;
    totMrp += ln.mrp;
    if (ln.caseSized) { casePackedBottles += ln.bottles; casePackedCess += ln.cess; }
    else looseBottles += ln.bottles;
    if (ln.bucket !== 'Unmapped') mappedLines += 1;
  }
  for (const k of LQ_BUCKETS) {
    const b = buckets[k];
    b.bottles = r4(b.bottles);
    b.cases = r4(b.cases);
    b.invoiceValue = r2(b.invoiceValue);
    b.levies = r2(b.levies);
    const lv = r2(landedBy[k]);
    b.landedValue = landed ? lv : null;
    b.uplift = landed && b.invoiceValue > 0 ? r4(lv / b.invoiceValue) : null;
  }
  // Non-case-packed lines contribute 0 cases (see readLines), so this IS totCases —
  // spelled out because cess_per_case divides case-packed cess by it and the two
  // halves must stay on one basis.
  const casePackedCases = lines.reduce((s, l) => s + (l.caseSized ? l.cases : 0), 0);

  const spirits = {
    bottles: r4(buckets.IML.bottles + buckets['Duty Paid'].bottles),
    cases: r4(buckets.IML.cases + buckets['Duty Paid'].cases),
    invoiceValue: r2(buckets.IML.invoiceValue + buckets['Duty Paid'].invoiceValue),
    landedValue: landed ? r2(landedBy.IML + landedBy['Duty Paid']) : null,
    lines: buckets.IML.lines + buckets['Duty Paid'].lines,
  };
  const C: LqSectionC = {
    buckets: LQ_BUCKETS.map(k => buckets[k]),
    beer: buckets.BEER,
    spirits,
    unmapped: buckets.Unmapped,
    mappedLines,
    totalLines: lines.length,
    value_basis: valueBasis,
    basis_note: landed
      ? 'Valued LANDED (opt-in): Landed = the invoice value (rate paid) + each line\'s share of the four TGBCL levies; '
        + 'Uplift = landed ÷ invoice. Analytics only — no stock value, recipe or pour cost moves.'
      : 'Valued at the RECORDED basis (the default): the invoice value is the rate paid on each line, as the store '
        + 'ledger records it. Landed value and uplift are opt-in — switch Value at to Landed.',
    pending: linesErr
      ? unavailable('L1', 'The recorded indent lines')
      : (lines.length > 0 && mappedLines === 0
        ? { phase: 'L1', reason: 'Indents recorded, but no brand is mapped yet — the beer/spirit split needs the TGBCL Brand Map (populate it on the Liquor Brand Map page).' }
        : (lines.length === 0
          ? { phase: 'L1', reason: 'No liquor indents recorded in this range.' }
          : null)),
  };

  const D: LqSectionD = {
    bottles: r4(totBottles),
    cases: r4(totCases),
    invoice_value: r2(totInvoice),
    levies_total: r2(totLevies),
    landed_value: landed ? r2(totLanded) : null,
    uplift_overall: landed && totInvoice > 0 ? r4(totLanded / totInvoice) : null,
    uplift_by_type: LQ_BUCKETS.filter(k => k !== 'Unmapped').map(k => ({ key: k, uplift: buckets[k].uplift })),
    effective_tcs_pct: totInvoice > 0 ? r4((totTcs / totInvoice) * 100) : null,
    cess_per_case: (() => { const v = safeDiv(casePackedCess, casePackedCases); return v == null ? null : r4(v); })(),
    cess_per_bottle: (() => { const v = safeDiv(totCess, totBottles); return v == null ? null : r4(v); })(),
    mrp_rounding_per_bottle: (() => { const v = safeDiv(totMrp, totBottles); return v == null ? null : r4(v); })(),
    avg_landed_per_bottle: landed ? (() => { const v = safeDiv(totLanded, totBottles); return v == null ? null : r4(v); })() : null,
    avg_recorded_per_bottle: (() => { const v = safeDiv(totInvoice, totBottles); return v == null ? null : r4(v); })(),
    value_basis: valueBasis,
    basis_note: landed
      ? 'LANDED (opt-in): uplift and avg landed per bottle include each line\'s share of the TGBCL levies. '
        + 'The levy factors (TCS %, cess, MRP rounding) are recorded levy facts, the same on both bases.'
      : 'RECORDED basis (the default): avg per bottle is the invoice value (rate paid) ÷ bottles, no levies. '
        + 'The levy factors (TCS %, cess, MRP rounding) are recorded levy facts; uplift and avg landed per bottle are '
        + 'opt-in — switch Value at to Landed.',
    case_packed_bottles: r4(casePackedBottles),
    loose_bottles: r4(looseBottles),
    case_source: {
      master_lines: lines.filter(l => l.caseSized && l.caseFromMaster).length,
      material_lines: lines.filter(l => l.caseSized && !l.caseFromMaster).length,
      loose_lines: lines.filter(l => !l.caseSized).length,
    },
    pending: linesErr
      ? unavailable('L1', 'The recorded indent lines')
      : (lines.length === 0
        ? { phase: 'L1', reason: 'No liquor indents recorded in this range — nothing to derive factors from.' }
        : null),
  };

  /* ── the two bases, measured and stated (see LqBasis) ─────────────────────── */
  const straddling = indents.filter(i => i.partial_in_range).map(i => i.invoice_ref);
  const unrefLines = lines.filter(l => !l.invoiceRef);
  const unrefValue = r2(unrefLines.reduce((s, l) => s + l.subtotal, 0));
  const basisDiff = r2(B.totals.invoice_value - D.invoice_value);
  const basis: LqBasis = {
    bill_invoice_value: B.totals.invoice_value,
    line_invoice_value: D.invoice_value,
    difference: basisDiff,
    diverges: !eqPaise(basisDiff, 0),
    straddling_indents: straddling,
    unattributed_lines: unrefLines.length,
    unattributed_value: unrefValue,
    note: eqPaise(basisDiff, 0) ? '' : [
      `§B/§F read whole recorded BILLS (₹${B.totals.invoice_value}); §C/§D sum the ledger LINES inside the range (₹${D.invoice_value}) — a gap of ₹${basisDiff}.`,
      straddling.length ? `${straddling.length} bill(s) straddle the range edge and count whole in §B: ${straddling.join(', ')}.` : '',
      unrefLines.length ? `${unrefLines.length} purchase line(s) worth ₹${unrefValue} carry no invoice ref — counted by §C/§D, invisible to §B/§F/§G.` : '',
      'Neither figure is wrong; they are different measurements. Reconcile a month against §B.',
    ].filter(Boolean).join(' '),
  };

  /* ── §E emergency wine-shop purchases (lq_retail_flags — L3 writes them) ─── */
  // L3's retailExcessSummary is THE definition of these figures (its own header
  // says so). This used to re-query lq_retail_flags and re-derive them, and the
  // two disagreed on the two rules L3 added after: a buy with an UNKNOWN depot
  // rate was folded in as excess (measured: excess ₹5,300 against ₹1,700), and a
  // claim marked reimbursed whose petty-cash payout was later DELETED was
  // reported as settled (₹5,400 owed against ₹9,400). One definition now.
  const retailRead = readOr<RetailExcessSummary | null>(
    () => retailExcessSummary(db, { from, to, storeId }), null);
  const rx = retailRead.value;
  // Admin-only depot figures (see LqSectionE) — the SAME switch as §G, because
  // the depot rate re-derives the same master. Computed in full first (check D
  // needs the total's sign), withheld on the way out.
  const revealDepot = opts.revealMasterRates === true;
  const retailRows: LqRetailRow[] = (rx?.rows ?? []).map(r => ({
    id: String(r.id),
    date: String(r.date || ''),
    shop_name: String(r.shop_name || ''),
    bottles: Number(r.bottles) || 0,
    rate_paid_per_bottle: Number(r.rate_paid_per_bottle) || 0,
    depot_landed_per_bottle: revealDepot ? (Number(r.depot_landed_per_bottle) || 0) : null,
    excess_per_bottle: revealDepot ? (Number(r.excess_per_bottle) || 0) : null,
    excess_total: revealDepot ? (Number(r.excess_total) || 0) : null,
    excess_pct: revealDepot ? (Number(r.excess_pct) || 0) : null,
    priced: (Number(r.depot_landed_per_bottle) || 0) > 0,
    paid_by: String(r.paid_by || ''),
    reimbursement_status: String(r.reimbursement_status || ''),
    reason: String(r.reason || ''),
  }));
  const retailBottles = r4(rx?.totalBottles ?? 0);
  const retailSpend = r2(rx?.wineShopSpend ?? 0);
  const retailDepotEq = r2((rx?.rows ?? []).reduce(
    (s, r) => s + (Number(r.depot_landed_per_bottle) || 0) * (Number(r.bottles) || 0), 0));
  const retailExcess = r2(rx?.excessTotal ?? 0);
  const unreimbursed = r2(rx?.unreimbursedStaffSpend ?? 0);
  const E: LqSectionE = {
    rows: retailRows,
    bottles: retailBottles,
    spend: retailSpend,
    depot_equivalent: revealDepot ? retailDepotEq : null,
    excess_total: revealDepot ? retailExcess : null,
    depot_figures_visible: revealDepot,
    depot_figures_note: revealDepot ? null : RETAIL_DEPOT_WITHHELD_NOTE,
    unreimbursed_staff_spend: unreimbursed,
    unknown_depot_count: rx?.unknownDepotCount ?? 0,
    unknown_depot_bottles: r4(rx?.unknownDepotBottles ?? 0),
    reopened_claim_count: rx?.reopenedClaimCount ?? 0,
    pending: retailRead.error
      ? unavailable('L3', 'The emergency retail flags')
      : (retailRows.length === 0
        ? { phase: 'L3', reason: 'No emergency wine-shop purchases recorded — L3 writes these as a side record on the existing purchase flow (vendor = the wine shop).' }
        : null),
  };

  /* ── §F total liquor cost — one basis per card (see LqSectionF) ────────────── */
  const totalLanded = r2(depotNetIndent + retailSpend);
  // The recorded-basis share is L3's, read off the same retailExcessSummary §E
  // already called — one definition, so the two screens cannot drift apart.
  const depotRecorded = r2(rx?.depotSpend ?? 0);
  const totalRecorded = r2(rx?.liquorSpend ?? 0);
  const shareRecorded = rx && totalRecorded > 0 ? rx.wineShopSharePct : null;
  const shareLanded = totalLanded > 0 ? r4((retailSpend / totalLanded) * 100) : null;
  const F: LqSectionF = {
    value_basis: valueBasis,
    depot_net_indent: depotNetIndent,
    retail_spend: retailSpend,
    depot_recorded_value: depotRecorded,
    total_recorded: totalRecorded,
    total_landed: landed ? totalLanded : null,
    total: landed ? totalLanded : totalRecorded,
    retail_share_pct: shareRecorded,
    retail_share_pct_of_total: landed ? shareLanded : null,
    share_pct: landed ? shareLanded : shareRecorded,
    retail_share_basis: landed
      ? `LANDED (opt-in): Total = depot Net Indent ${rs(depotNetIndent)} (the bills' invoice value plus the four `
        + `TGBCL levies — their landed value) + wine-shop spend ${rs(retailSpend)}; Retail share = wine-shop spend ÷ `
        + `that total. On the default recorded basis the total is ${rs(totalRecorded)}.`
      : `RECORDED basis (the default): Total = recorded depot purchase value ${rs(depotRecorded)} (the store `
        + `ledger's purchase lines at the rate paid, no levies) + wine-shop spend ${rs(retailSpend)}; Retail share = `
        + `wine-shop spend ÷ that total — the retail register's own figure. The Net Indent paid to TGBCL `
        + `(${rs(depotNetIndent)}, levies included) is the landed basis — switch Value at to Landed.`,
    pending: linesErr
      ? unavailable('L1', 'The recorded indent lines')
      : ((indents.length === 0 && retailRows.length === 0)
        ? { phase: 'L1', reason: 'No depot indents and no retail buys recorded in this range.' }
        : null),
  };

  /* ── §G rate-movement watch (L1 rateMovementForStore) ────────────────────── */
  let moveRows: LqRateVarianceRow[] = [];
  let gErr: string | null = null;
  try { moveRows = rateMovementForStore(db, storeId, from, to); }
  catch (e: any) { moveRows = []; gErr = String(e?.message || e || 'unavailable'); }
  const moved = moveRows.filter(r => r.variance != null && !eqPaise(r.variance, 0));
  const unmappedG = moveRows.filter(r => r.masterRate == null).length;
  // Admin-only master rates (see LqSectionG). Fail closed: anything but an
  // explicit true withholds them.
  const revealMaster = opts.revealMasterRates === true;
  const gRows: LqRateMoveRow[] = moved
    // Ordered by the size of the move whoever is looking, so an admin and a
    // manager see the same lines in the same order.
    .sort((a, b) => Math.abs(b.varianceValue ?? 0) - Math.abs(a.varianceValue ?? 0))
    .map(r => ({
      ledgerId: r.ledgerId,
      invoiceRef: r.invoiceRef,
      inwardDate: r.inwardDate,
      materialName: r.materialName,
      category: r.category,
      bottles: r.bottles,
      indentRate: r.indentRate,
      masterRate: revealMaster ? r.masterRate : null,
      variance: revealMaster ? r.variance : null,
      varianceValue: revealMaster ? r.varianceValue : null,
      proposedRatePerCase: revealMaster ? r.proposedRatePerCase : null,
      direction: (r.variance ?? 0) > 0 ? 'above_master' as const : 'below_master' as const,
      mapReason: r.mapReason,
    }));
  const G: LqSectionG = {
    rows: gRows,
    moved_lines: moved.length,
    scanned_lines: moveRows.length,
    unmapped_lines: unmappedG,
    total_variance_value: revealMaster ? r2(moved.reduce((s, r) => s + (r.varianceValue ?? 0), 0)) : null,
    master_rates_visible: revealMaster,
    master_rates_note: revealMaster
      ? null
      : 'TGBCL master rates are admin-only, so the master rate, the variance against it, the variance value and the '
        + 'proposed rate per case are withheld here. The lines that moved, and which way, are listed; an admin sees '
        + 'the figures here and on the Brand Map\'s Rate Movement tab.',
    pending: gErr
      ? unavailable('L1', 'The rate-movement watch')
      : ((moveRows.length > 0 && moveRows.every(r => r.masterRate == null))
        ? { phase: 'L1', reason: 'Indents recorded, but no brand is mapped — rate movement needs the TGBCL Brand Map master rates.' }
        : (moveRows.length === 0
          ? { phase: 'L1', reason: 'No liquor indents recorded in this range.' }
          : null)),
  };

  /* ── §H non-sale issues (lq_withdrawals — L4 writes them) ─────────────────── */
  // One row per withdrawal, with the store's RECORDED weighted-average unit cost
  // for that material AS OF the withdrawal's date: priced inflows only
  // (quantity > 0 AND unit_cost > 0 — the basis storeStock() and L4's own
  // store_avg fallback use), IST business day like L4's denominator. The
  // ledger row a withdrawal posts carries unit_cost 0 by L0 rule 1, so the
  // recorded value is read off the store's own inflows, never off that row.
  const wdRead = readOr<any[]>(() => db.prepare(`
    SELECT w.category, w.qty_recipe_units,
           w.landed_value, w.mrp_value, w.recoverable, w.recovered,
           (SELECT SUM(l.quantity * l.unit_cost) / SUM(l.quantity)
              FROM store_stock_ledger l
             WHERE l.store_id = w.store_id AND l.material_id = w.material_id
               AND l.quantity > 0 AND l.unit_cost > 0
               AND date(l.created_at, '+330 minutes') <= w.date) AS rec_unit_cost
    FROM lq_withdrawals w
    WHERE w.store_id = ? AND w.date >= ? AND w.date <= ?
  `).all(storeId, from, to) as any[], []);
  const byCat = new Map<string, { count: number; rec: number; unpriced: number; landed: number; mrp: number;
    recoverable: number; recovered: number }>();
  for (const r of wdRead.value) {
    const k = String(r.category || '');
    const b = byCat.get(k) ?? { count: 0, rec: 0, unpriced: 0, landed: 0, mrp: 0, recoverable: 0, recovered: 0 };
    const uc = Number(r.rec_unit_cost);
    b.count += 1;
    if (Number.isFinite(uc) && uc > 0) b.rec += (Number(r.qty_recipe_units) || 0) * uc;
    else b.unpriced += 1;
    b.landed += Number(r.landed_value) || 0;
    b.mrp += Number(r.mrp_value) || 0;
    b.recoverable += Number(r.recoverable) || 0;
    b.recovered += Number(r.recovered) || 0;
    byCat.set(k, b);
  }
  const wdBuckets: LqWithdrawalBucket[] = [...byCat].map(([category, b]) => ({
    category,
    count: b.count,
    recorded_value: r2(b.rec),
    recorded_unpriced: b.unpriced,
    landed_value: landed ? r2(b.landed) : null,
    mrp_value: r2(b.mrp),
    recoverable: r2(b.recoverable),
    recovered: r2(b.recovered),
    outstanding: r2(b.recoverable - b.recovered),
  }))
    // Largest first ON THE BASIS SHOWN, so the order never ranks by a hidden figure.
    .sort((x, y) => (landed ? (y.landed_value ?? 0) - (x.landed_value ?? 0) : y.recorded_value - x.recorded_value)
      || x.category.localeCompare(y.category));
  const wdRecorded = r2(wdBuckets.reduce((s, b) => s + b.recorded_value, 0));
  const wdUnpriced = wdBuckets.reduce((s, b) => s + b.recorded_unpriced, 0);
  const wdLanded = r2([...byCat.values()].reduce((s, b) => s + b.landed, 0));
  const wdOutstanding = r2(wdBuckets.reduce((s, b) => s + b.outstanding, 0));
  // L4's own summary, for the RECORDED denominator it uses — one definition of
  // "recorded purchase value in range".
  const wdSumRead = readOr<WithdrawalSummary | null>(
    () => withdrawalSummary(db, { from, to, store_id: storeId }), null);
  const wdSum = wdSumRead.value;
  const purchasesValue = r2(wdSum?.purchases_value ?? 0);
  const pctRecorded = purchasesValue > 0 ? r2((wdRecorded / purchasesValue) * 100) : null;
  const pctLanded = depotNetIndent > 0 ? r4((wdLanded / depotNetIndent) * 100) : null;
  const H: LqSectionH = {
    value_basis: valueBasis,
    buckets: wdBuckets,
    total_recorded_value: wdRecorded,
    recorded_unpriced_count: wdUnpriced,
    total_landed_value: landed ? wdLanded : null,
    total_value: landed ? wdLanded : wdRecorded,
    total_outstanding: wdOutstanding,
    purchases_value: purchasesValue,
    pct_of_purchases: pctRecorded,
    pct_of_net_indent: landed ? pctLanded : null,
    pct: landed ? pctLanded : pctRecorded,
    pct_basis: (landed
      ? `LANDED (opt-in): the landed value frozen on each withdrawal (${rs(wdLanded)}) ÷ the §B Net Indent `
        + `${rs(depotNetIndent)} — the bills' landed value, so both halves include the TGBCL levies.`
      : `RECORDED basis (the default): withdrawn stock at the store's recorded average cost on each withdrawal's date `
        + `(${rs(wdRecorded)}) ÷ the recorded purchase value in range ${rs(purchasesValue)} (store-ledger purchase and `
        + `inward lines, IST day) — both halves at the store ledger's recorded cost, no levies. The frozen landed `
        + `values are opt-in — switch Value at to Landed.`)
      + (wdUnpriced > 0
        ? ` ${wdUnpriced} withdrawal(s) had no recorded store cost on their date and are left out of the recorded value, not counted as ₹0.`
        : '')
      + (wdSum && wdSum.pct_of_purchases != null
        ? ` The Withdrawals page's "% of purchases" (${wdSum.pct_of_purchases}%) divides the frozen LANDED value by the `
          + 'RECORDED purchase value — a landed numerator over a recorded denominator — so it differs from this card.'
        : ''),
    pending: wdRead.error
      ? unavailable('L4', 'The stock-withdrawal register')
      : (wdBuckets.length === 0
        ? { phase: 'L4', reason: 'No non-sale issues recorded — L4 writes stock withdrawals (management use, staff welfare, marketing, breakage) and moves the stock.' }
        : null),
  };

  /* ── the four checks ─────────────────────────────────────────────────────── */
  const checks: LqCheck[] = [];

  // A — wallet balance vs portal: latest recorded portal reading at/before `to`.
  //
  // The reading is picked IN SQL (ORDER BY … LIMIT 1). It used to page the 100
  // newest readings and filter in JS, so ~100 days of daily readings pushed the
  // in-range one off the page and the check went quietly grey — "never checked"
  // instead of passed or failed — on any earlier month. The balance beside it is
  // L2's own walletBalanceAsOf, the same function listPortalChecks uses, so the
  // figures are identical to the wallet page's.
  const walletReadingRead = readOr<{ as_of_date: string; portal_amount: number; computed: number } | null>(() => {
    const row = db.prepare(`
      SELECT as_of_date, portal_amount
        FROM lq_portal_checks
       WHERE kind = 'wallet_balance' AND as_of_date <= ?
       ORDER BY as_of_date DESC, created_at DESC
       LIMIT 1
    `).get(to) as any;
    if (!row) return null;
    return {
      as_of_date: String(row.as_of_date || ''),
      portal_amount: r2(Number(row.portal_amount) || 0),
      computed: walletBalanceAsOf(db, { date: String(row.as_of_date || '') }).balance,
    };
  }, null);
  const walletReading = walletReadingRead.value;
  if (!walletReading) {
    checks.push({
      key: 'A', label: 'Wallet balance vs portal', state: 'no_data',
      detail: walletReadingRead.error
        ? 'Portal readings could not be read on this database yet.'
        : 'No TGBCL portal reading recorded yet.',
      computed: A.balance, observed: null, difference: null,
    });
  } else {
    const diff = r2(walletReading.portal_amount - walletReading.computed);
    checks.push({
      key: 'A', label: 'Wallet balance vs portal',
      state: eqPaise(diff, 0) ? 'pass' : 'fail',
      detail: `Portal ${walletReading.as_of_date}: observed vs computed`,
      computed: walletReading.computed,
      observed: walletReading.portal_amount,
      difference: diff,
    });
  }

  // B — per-indent value vs portal: lq_portal_checks(indent_value) vs Net Indent.
  //
  // Bounded on BOTH ends of the range the page is showing (it used to evaluate
  // every reading ever taken, so a July mismatch failed an August report), and
  // only the NEWEST reading per indent counts: the upsert key includes
  // as_of_date, so re-reading the portal on a later day files a SECOND row, and
  // counting the superseded typo alongside its own correction left the check
  // failing for ever with nothing in the UI able to clear it.
  const indentChecksRead = readOr<any[]>(() => db.prepare(`
    SELECT reference, as_of_date, portal_amount
    FROM lq_portal_checks
    WHERE kind = 'indent_value' AND as_of_date >= ? AND as_of_date <= ?
    ORDER BY as_of_date DESC, created_at DESC
  `).all(from, to) as any[], []);
  const latestByRef = new Map<string, any>();
  for (const pc of indentChecksRead.value) {
    const key = String(pc.reference || '').trim().toLowerCase();
    if (!latestByRef.has(key)) latestByRef.set(key, pc);
  }
  const indentReadings = [...latestByRef.values()];
  // bInRegister: a reading for an inward number a REGISTER upload covers (see
  // §B). Its levies were typed once for the whole register, so its own Net
  // Indent is not on record and it cannot be checked alone — counted as that,
  // not as "names no indent". When the register covers ONLY that inward, the
  // header's Net Indent is its own and it is compared like any other indent.
  // registerCoverFor is the same reading liquor-wallet's portal-check reply
  // uses, so this card and the reading's own receipt cannot disagree.
  let bMismatch = 0, bMatched = 0, bMissing = 0, bWorstDiff = 0, bInRegister = 0;
  for (const pc of indentReadings) {
    const ref = String(pc.reference || '').trim();
    const bc = billCharges[ref.toLowerCase()];
    let recordedNet: number | null = bc ? (Number(bc.net_indent_value) || 0) : null;
    if (!bc) {
      const cover = readOr(() => registerCoverFor(db, ref, storeId), null).value;
      if (cover && cover.sole) recordedNet = cover.net_indent_value;
      else if (cover) { bInRegister += 1; continue; }
    }
    if (recordedNet === null) { bMissing += 1; continue; }
    const net = recordedNet;
    const portal = Number(pc.portal_amount) || 0;
    if (eqPaise(net, portal)) bMatched += 1;
    else { bMismatch += 1; if (Math.abs(net - portal) > Math.abs(bWorstDiff)) bWorstDiff = r2(portal - net); }
  }
  if (indentReadings.length === 0) {
    checks.push({
      key: 'B', label: 'Per-indent value vs portal', state: 'no_data',
      detail: indentChecksRead.error
        ? 'Portal readings could not be read on this database yet.'
        // The writer is POST /api/liquor/wallet/portal-check with
        // kind 'indent_value' (liquor-wallet recordIndentPortalCheck).
        : 'No per-indent portal reading recorded in this range — record what the TGBCL portal shows for an indent as an indent-value portal reading.',
      computed: null, observed: null, difference: null,
    });
  } else {
    checks.push({
      key: 'B', label: 'Per-indent value vs portal',
      state: bMismatch > 0 ? 'fail' : (bMissing > 0 || bInRegister > 0 ? 'warn' : 'pass'),
      detail: (bMismatch > 0
        ? `${bMismatch} of ${indentReadings.length} indent(s) differ from portal`
        : (bMissing > 0 || bInRegister > 0
          ? `${bMatched} matched`
            + (bMissing > 0 ? `; ${bMissing} reading(s) name no indent recorded in this store` : '')
          : `${bMatched} indent(s) match portal`))
        + (bInRegister > 0
          ? `; ${bInRegister} reading(s) name an inward inside a multi-inward register upload — its levies were typed once for the whole register, so it cannot be checked alone (record a reading for the register's own ref)`
          : ''),
      computed: null, observed: null,
      // Only a mismatch has a difference to show; a bare "Δ ₹0" on a passing
      // card reads as a measurement rather than as nothing to report.
      difference: bMismatch > 0 ? bWorstDiff : null,
    });
  }

  // C — bank-unconfirmed deposits (from the wallet summary). The wallet is a
  // POSITION, not a window: this counts every recorded deposit, as §A does.
  checks.push({
    key: 'C', label: 'Bank-unconfirmed deposits',
    state: !walletLive ? 'no_data' : (A.bank_unconfirmed_count > 0 ? 'warn' : 'pass'),
    detail: walletRead.error
      ? 'The wallet ledger could not be read on this database yet.'
      : (A.row_count === 0
        ? 'No wallet deposits recorded yet.'
        : (A.bank_unconfirmed_count > 0
          ? `${A.bank_unconfirmed_count} deposit(s) not yet bank-matched (all recorded deposits, not range-bounded)`
          : 'All deposits bank-matched (all recorded deposits, not range-bounded)')),
    computed: A.bank_unconfirmed_total, observed: null, difference: null,
  });

  // D — retail excess (the price of running out).
  checks.push({
    key: 'D', label: 'Retail excess',
    state: retailRows.length === 0 ? 'no_data' : (eqPaise(retailExcess, 0) ? 'pass' : 'warn'),
    detail: retailRead.error
      ? 'The retail flags could not be read on this database yet.'
      : (retailRows.length === 0
        ? 'No emergency retail buys recorded.'
        : ((eqPaise(retailExcess, 0) ? 'No premium paid over depot' : 'Premium paid buying retail')
          + (revealDepot ? '' : ' (the amount is admin-only — it re-derives the TGBCL master rate)'))),
    // The ₹ is §E's excess_total, withheld from a non-admin with it (LqSectionE).
    computed: revealDepot ? retailExcess : null, observed: null, difference: null,
  });

  /* ── sibling dependency panel ────────────────────────────────────────────── */
  const brandMapRead = readOr<number>(
    () => Number((db.prepare('SELECT COUNT(*) AS n FROM lq_brand_map').get() as any)?.n) || 0, -1);
  const brandMapCount = brandMapRead.value;
  const dependencies: LqSummaryResult['dependencies'] = [
    {
      phase: 'L1', label: 'TGBCL Brand Map',
      live: brandMapCount > 0,
      note: brandMapRead.error
        ? `Not on this database yet — §C split, §D per-category uplift and §G rate movement stay provisional.`
        : (brandMapCount > 0
          ? `${brandMapCount} brand(s) mapped — beer/spirit split, uplift-by-category and rate movement are live.`
          : 'Not populated — §C split, §D per-category uplift and §G rate movement stay provisional until brands are mapped.'),
    },
    {
      phase: 'L2', label: 'TGBCL Wallet',
      live: walletLive,
      note: walletRead.error
        ? `Not on this database yet — §A/§A2 and checks A/C are unavailable.`
        : (A.row_count > 0
          ? `${A.row_count} wallet movement(s) recorded — §A, §A2 and checks A/C are live. `
            + (indentReadings.length > 0
              ? `Check B is live on ${indentReadings.length} per-indent portal reading(s) in range.`
              : 'Check B additionally needs a per-indent portal reading in range (none recorded yet).')
          : 'No wallet movements yet — §A/§A2 and checks A/C wait on the first recorded opening balance.'),
    },
    {
      phase: 'L3', label: 'Emergency retail flags',
      live: retailRows.length > 0,
      note: retailRead.error
        ? `Not on this database yet — §E and check D are unavailable.`
        : (retailRows.length > 0
          ? `${retailRows.length} retail buy(s) in range — §E and check D are live.`
          : 'None recorded — §E and check D populate once L3 flags a wine-shop purchase.'),
    },
    {
      phase: 'L4', label: 'Stock withdrawals',
      live: wdBuckets.length > 0,
      note: wdRead.error
        ? `Not on this database yet — §H is unavailable.`
        : (wdBuckets.length > 0
          ? `${wdBuckets.reduce((s, b) => s + b.count, 0)} withdrawal(s) in range — §H is live.`
          : 'None recorded — §H populates once L4 records a non-sale issue.'),
    },
  ];

  return {
    store: { id: storeId, name: storeName },
    range: { from, to },
    generated_at: new Date().toISOString(),
    sections: { A, A2, B, C, D, E, F, G, H },
    basis,
    value_basis: {
      active: valueBasis,
      default_basis: valueBasisDefault,
      overridden: valueBasis !== valueBasisDefault,
      note: landed
        ? 'Valued LANDED (opt-in): §C/§D/§F/§H include each line\'s share of the four TGBCL levies. Report only — '
          + 'no stock value, recipe cost or pour cost reads this switch.'
        : 'Valued at the RECORDED basis (the default, owner decision 1): §C/§D/§F/§H use what the store ledger and the '
          + 'bills record, rate paid, no levies. Landed figures are opt-in — switch Value at to Landed.',
    },
    checks,
    dependencies,
    // Owner decision 3 — flags only. Global (the vendor master), not the range.
    vendor_review: readOr<VendorReview | null>(() => vendorNameReview(db), null).value,
  };
}

/* ── CSV export, per section — well-formed, Excel-safe (csvCell from L2) ──────── */

const CSV_SECTIONS = ['A', 'A2', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'checks', 'vendors'] as const;
export type LqCsvSection = (typeof CSV_SECTIONS)[number];
export const isLqCsvSection = (s: unknown): s is LqCsvSection =>
  typeof s === 'string' && (CSV_SECTIONS as readonly string[]).includes(s);

/**
 * One cell. csvCell (L2) prefixes anything starting `= + - @` with a quote to
 * neutralise Excel formulas — correct for free text, and it was being applied
 * to NUMBERS too, so every negative figure (a Δ, a variance, an overdrawn
 * balance) shipped as TEXT and a reader's selection-sum silently skipped it.
 * A finite number cannot be a formula, so it goes out bare; everything else
 * still goes through the guard. Same numeric exemption the mature house
 * exporters use (purchase-log, purchase-bill-summary, hr/reports, crm export).
 */
const cell = (v: unknown): string =>
  typeof v === 'number' && Number.isFinite(v) ? String(v) : csvCell(v);
const num = (v: number | null): number | string => (v == null ? '' : v);

/** Rows padded to the widest row, so a caption or a footer never makes the file
 *  ragged — pandas (and every sheet template) reads a 2-cell banner above an
 *  11-cell table as an 11-level index. The house reference exporter
 *  (api/reports/purchase-log) pads for exactly this reason. */
const render = (rows: unknown[][]): string => {
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  return rows
    .map(r => (r.length === width ? r : r.concat(Array(width - r.length).fill(''))).map(cell).join(','))
    .join('\r\n') + '\r\n';
};

/** One section of the summary as CSV text. */
export function liquorSummaryCsv(res: LqSummaryResult, section: LqCsvSection): string {
  const lines: unknown[][] = [];
  // Rows are collected as CELLS and joined at the end by render(), which needs
  // to know the widest row before it can pad. `row` stays as the identity so
  // every section below reads exactly as it did.
  const row = (cells: unknown[]) => cells;
  const head = `Liquor Reconciliation — ${res.store.name} — ${res.range.from} to ${res.range.to}`;
  switch (section) {
    case 'A': {
      const a = res.sections.A;
      lines.push(row([head, 'Section A — Wallet reconciliation']));
      lines.push(row(['Metric', 'Value (Rs)']));
      lines.push(row(['Basis', 'Wallet position over ALL recorded movements — not bounded by the date range (the two window figures below are).']));
      lines.push(row(['Wallet balance', a.balance]));
      lines.push(row(['Overdrawn', a.overdrawn ? 'yes' : 'no']));
      lines.push(row(['Working capital parked', a.working_capital_parked]));
      lines.push(row(['Funded in (opening + deposits)', a.funded_in]));
      lines.push(row(['Utilised out (indent debits)', a.utilised_out]));
      lines.push(row(['Deposits utilised %', num(a.deposits_utilised_pct)]));
      lines.push(row(['Opening total', a.opening_total]));
      lines.push(row(['Deposit total', a.deposit_total]));
      lines.push(row(['Indent debit total', a.indent_debit_total]));
      lines.push(row(['Adjustment net', a.adjustment_net]));
      lines.push(row(['Window opening balance', a.window_opening_balance]));
      lines.push(row(['Window closing balance', a.window_closing_balance]));
      lines.push(row(['Bank-unconfirmed deposits (count)', a.bank_unconfirmed_count]));
      lines.push(row(['Bank-unconfirmed deposits (Rs)', a.bank_unconfirmed_total]));
      break;
    }
    case 'A2': {
      const a = res.sections.A2;
      lines.push(row([head, 'Section A2 — Top-up planner']));
      lines.push(row(['Metric', 'Value (Rs)']));
      lines.push(row(['Planned next indent', a.planned ? a.planned_indent : '(not supplied)']));
      lines.push(row(['Current balance', a.balance]));
      lines.push(row(['Shortfall', a.shortfall]));
      lines.push(row(['Rounding step', a.step]));
      lines.push(row(['Recommended challan', a.recommended_challan]));
      lines.push(row(['Rounding added', a.rounding_add]));
      lines.push(row(['Balance after', a.balance_after]));
      lines.push(row(['Surplus', a.surplus]));
      break;
    }
    case 'B': {
      const b = res.sections.B;
      lines.push(row([head, 'Section B — Purchase totals + per-indent value']));
      lines.push(row(['Invoice ref', 'Date', 'Supplier', 'Lines', 'Invoice value', 'MRP rounding',
        'Excise turnover tax', 'Special excise cess', 'TCS', 'Net indent', 'Charges recorded',
        'Lines outside range', 'Covers inward nos (register upload)']));
      for (const i of b.indents) {
        lines.push(row([i.invoice_ref, i.date, i.supplier, i.lines, i.invoice_value, i.mrp_rounding,
          i.excise_turnover_tax, i.special_excise_cess, i.tcs, i.net_indent_value,
          i.has_charges ? 'yes' : 'no', i.partial_in_range ? 'yes (counted whole)' : 'no',
          (i.covers || []).join(' | ')]));
      }
      // Σ LINES under the "Lines" header — it carried the indent COUNT, which
      // totals nothing in that column. The indent count is named in the label.
      lines.push(row([`TOTAL (${b.totals.indents} indent(s))`, '', '',
        b.indents.reduce((s, i) => s + i.lines, 0), b.totals.invoice_value, b.totals.mrp_rounding,
        b.totals.excise_turnover_tax, b.totals.special_excise_cess, b.totals.tcs, b.totals.net_indent_value, '']));
      if (res.basis.note) lines.push(row(['BASIS', res.basis.note]));
      break;
    }
    case 'C': {
      const c = res.sections.C;
      lines.push(row([head, `Section C — Beer / spirit split — value at ${c.value_basis.toUpperCase()}`]));
      // Owner decision 1: the landed columns exist only on the landed basis —
      // an empty "Landed value" column invites the question of where it went.
      if (c.value_basis === 'landed') {
        lines.push(row(['Product type', 'Lines', 'Bottles', 'Cases (case-packed only)', 'Invoice value',
          'Levies', 'Landed value', 'Uplift']));
        for (const b of c.buckets) {
          lines.push(row([b.key, b.lines, b.bottles, b.cases, b.invoiceValue, b.levies, num(b.landedValue), num(b.uplift)]));
        }
        lines.push(row(['SPIRITS (IML + Duty Paid)', c.spirits.lines, c.spirits.bottles, c.spirits.cases,
          c.spirits.invoiceValue, '', num(c.spirits.landedValue), '']));
      } else {
        lines.push(row(['Product type', 'Lines', 'Bottles', 'Cases (case-packed only)', 'Invoice value (recorded)', 'Levies (recorded only)']));
        for (const b of c.buckets) {
          lines.push(row([b.key, b.lines, b.bottles, b.cases, b.invoiceValue, b.levies]));
        }
        lines.push(row(['SPIRITS (IML + Duty Paid)', c.spirits.lines, c.spirits.bottles, c.spirits.cases,
          c.spirits.invoiceValue, '']));
      }
      lines.push(row(['BASIS', c.basis_note]));
      break;
    }
    case 'D': {
      const d = res.sections.D;
      lines.push(row([head, `Section D — Derived factors (computed, not assumed) — value at ${d.value_basis.toUpperCase()}`]));
      lines.push(row(['Factor', 'Value']));
      lines.push(row(['Bottles', d.bottles]));
      lines.push(row(['Cases (case-packed lines only)', d.cases]));
      lines.push(row(['Bottles bought loose (no outer case)', d.loose_bottles]));
      lines.push(row(['Invoice value (Rs)', d.invoice_value]));
      lines.push(row(['Levies total (Rs)', d.levies_total]));
      lines.push(row(['Avg recorded per bottle (Rs, rate paid)', num(d.avg_recorded_per_bottle)]));
      if (d.value_basis === 'landed') {
        lines.push(row(['Landed value (Rs)', num(d.landed_value)]));
        lines.push(row(['Uplift overall (landed / invoice)', num(d.uplift_overall)]));
        for (const u of d.uplift_by_type) lines.push(row([`Uplift — ${u.key}`, num(u.uplift)]));
        lines.push(row(['Avg landed per bottle (Rs)', num(d.avg_landed_per_bottle)]));
      }
      lines.push(row(['Effective TCS %', num(d.effective_tcs_pct)]));
      lines.push(row(['Cess per case (Rs)', num(d.cess_per_case)]));
      lines.push(row(['Cess per bottle (Rs)', num(d.cess_per_bottle)]));
      lines.push(row(['MRP rounding per bottle (Rs)', num(d.mrp_rounding_per_bottle)]));
      lines.push(row(['VALUE BASIS', d.basis_note]));
      if (res.basis.note) lines.push(row(['BASIS', res.basis.note]));
      break;
    }
    case 'E': {
      const e = res.sections.E;
      lines.push(row([head, 'Section E — Emergency wine-shop purchases']));
      // A non-admin's file leaves the depot columns OUT (as §G's does its
      // master columns) rather than printing blanks a reader might take for 0.
      if (e.depot_figures_visible) {
        lines.push(row(['Date', 'Shop', 'Bottles', 'Rate paid/bottle', 'Depot landed/bottle',
          'Excess/bottle', 'Excess total', 'Excess %', 'Paid by', 'Reimbursement', 'Reason']));
        for (const r of e.rows) {
          lines.push(row([r.date, r.shop_name, r.bottles, r.rate_paid_per_bottle, num(r.depot_landed_per_bottle),
            num(r.excess_per_bottle), num(r.excess_total), num(r.excess_pct), r.paid_by, r.reimbursement_status, r.reason]));
        }
        lines.push(row(['TOTAL', '', e.bottles, '', '', '', num(e.excess_total), '', '', '', '']));
      } else {
        lines.push(row(['Date', 'Shop', 'Bottles', 'Rate paid/bottle', 'Depot rate', 'Paid by', 'Reimbursement', 'Reason']));
        for (const r of e.rows) {
          lines.push(row([r.date, r.shop_name, r.bottles, r.rate_paid_per_bottle, r.priced ? 'priced' : 'unknown',
            r.paid_by, r.reimbursement_status, r.reason]));
        }
        lines.push(row(['TOTAL', '', e.bottles, '', '', '', '', '']));
      }
      lines.push(row(['Retail spend (Rs)', e.spend]));
      if (e.depot_figures_visible) lines.push(row(['Depot equivalent (Rs)', num(e.depot_equivalent)]));
      lines.push(row(['Unreimbursed staff spend (Rs)', e.unreimbursed_staff_spend]));
      lines.push(row(['  of which claims whose payout was deleted', e.reopened_claim_count]));
      lines.push(row(['Buys with an unknown depot rate (excluded from excess)', e.unknown_depot_count]));
      lines.push(row(['  bottles', e.unknown_depot_bottles]));
      if (e.depot_figures_note) lines.push(row(['NOTE', e.depot_figures_note]));
      break;
    }
    case 'F': {
      const f = res.sections.F;
      lines.push(row([head, `Section F — Total liquor cost — value at ${f.value_basis.toUpperCase()}`]));
      lines.push(row(['Component', 'Value (Rs)']));
      // ONE BASIS PER BLOCK (owner decision 1): the total and the share beside
      // it are built on the same denominator, and say which.
      if (f.value_basis === 'landed') {
        lines.push(row(['Depot net indent (landed: invoice + TGBCL levies)', f.depot_net_indent]));
        lines.push(row(['Retail spend', f.retail_spend]));
        lines.push(row(['Total (landed)', f.total]));
        lines.push(row(['Retail share % (of the landed total above)', num(f.share_pct)]));
        lines.push(row(['Recorded total (depot purchase value + retail) — for reference', f.total_recorded]));
      } else {
        lines.push(row(['Recorded depot purchase value (rate paid, no levies)', f.depot_recorded_value]));
        lines.push(row(['Retail spend', f.retail_spend]));
        lines.push(row(['Total (recorded)', f.total]));
        lines.push(row(['Retail share % (of the recorded total above)', num(f.share_pct)]));
        lines.push(row(['Depot net indent paid to TGBCL (levies included) — for reference', f.depot_net_indent]));
      }
      lines.push(row(['BASIS', f.retail_share_basis]));
      break;
    }
    case 'G': {
      const g = res.sections.G;
      lines.push(row([head, 'Section G — Rate-movement watch']));
      if (g.master_rates_visible) {
        lines.push(row(['Date', 'Invoice ref', 'Material', 'Category', 'Bottles', 'Indent rate',
          'Master rate', 'Variance', 'Variance value', 'Proposed rate/case', 'Direction']));
        for (const r of g.rows) {
          lines.push(row([r.inwardDate, r.invoiceRef, r.materialName, r.category, r.bottles, r.indentRate,
            num(r.masterRate), num(r.variance), num(r.varianceValue), num(r.proposedRatePerCase), r.direction]));
        }
      } else {
        // No master-rate columns at all for a non-admin — an empty column
        // headed "Master rate" invites the question of where the figure went.
        lines.push(row(['Date', 'Invoice ref', 'Material', 'Category', 'Bottles', 'Indent rate', 'Direction']));
        for (const r of g.rows) {
          lines.push(row([r.inwardDate, r.invoiceRef, r.materialName, r.category, r.bottles, r.indentRate, r.direction]));
        }
      }
      lines.push(row(['Moved lines', g.moved_lines]));
      lines.push(row(['Scanned lines', g.scanned_lines]));
      lines.push(row(['Unmapped lines', g.unmapped_lines]));
      if (g.master_rates_visible) lines.push(row(['Total variance value (Rs)', num(g.total_variance_value)]));
      if (g.master_rates_note) lines.push(row(['NOTE', g.master_rates_note]));
      break;
    }
    case 'H': {
      const h = res.sections.H;
      lines.push(row([head, `Section H — Non-sale issues (withdrawals) — value at ${h.value_basis.toUpperCase()}`]));
      // ONE BASIS PER BLOCK (owner decision 1): the value column and the % are
      // the same basis, and the file says which.
      if (h.value_basis === 'landed') {
        lines.push(row(['Category', 'Count', 'Landed value', 'MRP value', 'Recoverable', 'Recovered', 'Outstanding']));
        for (const b of h.buckets) {
          lines.push(row([b.category, b.count, num(b.landed_value), b.mrp_value, b.recoverable, b.recovered, b.outstanding]));
        }
        lines.push(row(['TOTAL', '', num(h.total_landed_value), '', '', '', h.total_outstanding]));
        lines.push(row(['Depot net indent in range (Rs) — the landed denominator', res.sections.F.depot_net_indent]));
        lines.push(row(['% of Net Indent (landed ÷ landed)', num(h.pct)]));
      } else {
        lines.push(row(['Category', 'Count', 'Recorded value', 'Not priced (no store cost on the date)', 'MRP value',
          'Recoverable', 'Recovered', 'Outstanding']));
        for (const b of h.buckets) {
          lines.push(row([b.category, b.count, b.recorded_value, b.recorded_unpriced, b.mrp_value, b.recoverable,
            b.recovered, b.outstanding]));
        }
        lines.push(row(['TOTAL', '', h.total_recorded_value, h.recorded_unpriced_count, '', '', '', h.total_outstanding]));
        lines.push(row(['Recorded purchase value in range (Rs)', h.purchases_value]));
        lines.push(row(['% of purchases (recorded ÷ recorded)', num(h.pct)]));
      }
      lines.push(row(['BASIS', h.pct_basis]));
      break;
    }
    case 'vendors': {
      // Owner decision 3 — flags only. Names exactly as stored.
      const v = res.vendor_review;
      lines.push(row([head, 'Vendor name review — near-duplicate names (flag only, nothing merged)']));
      if (!v) {
        lines.push(row(['NOTE', 'The vendor review could not be read on this database.']));
        break;
      }
      lines.push(row(['Distance', 'Kind', 'Name A', 'Source A', 'Vendor id A', 'Active A', 'Uses A',
        'Name B', 'Source B', 'Vendor id B', 'Active B', 'Uses B']));
      const act = (x: boolean | null) => (x == null ? '' : x ? 'yes' : 'no');
      for (const p of v.pairs) {
        lines.push(row([p.distance, p.kind, p.a.name, p.a.source, p.a.vendor_id ?? '', act(p.a.is_active), p.a.uses,
          p.b.name, p.b.source, p.b.vendor_id ?? '', act(p.b.is_active), p.b.uses]));
      }
      lines.push(row(['Pairs flagged', v.pairs_total]));
      lines.push(row(['Vendors scanned', v.scanned.vendors]));
      lines.push(row(['Free-text spellings scanned', v.scanned.free_text_spellings]));
      lines.push(row(['NOTE', v.note]));
      break;
    }
    case 'checks': {
      lines.push(row([head, 'The four checks']));
      lines.push(row(['Check', 'State', 'Detail', 'Computed', 'Observed', 'Difference']));
      for (const c of res.checks) {
        lines.push(row([`${c.key} — ${c.label}`, c.state, c.detail, num(c.computed), num(c.observed), num(c.difference)]));
      }
      break;
    }
  }
  return render(lines);
}
