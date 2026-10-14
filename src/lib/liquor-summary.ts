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
 * SIBLING DEPENDENCIES. L1 (liquor-recon), L2 (liquor-wallet) and L3
 * (liquor-retail) are consumed as libraries — §E in particular calls L3's
 * retailExcessSummary rather than re-deriving it, so "excess" and "unreimbursed"
 * have exactly one definition. L4 (withdrawals) has no library L5 needs: its rows
 * are self-contained (frozen figures), so L5 reads lq_withdrawals directly.
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
} from './liquor-wallet';
import {
  allocateIndentBill, pickBrandMap, rateMovementForStore,
  type LqIndentLine, type LqRateVarianceRow,
} from './liquor-recon';
import { retailExcessSummary, type RetailExcessSummary } from './liquor-retail';
import { getBillChargesForStore } from './store-engine';

/* ── rounding, mirrored from the deployed register + the wallet lib ──────────── */
const r2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;
const r4 = (n: number): number => Math.round((Number(n) || 0) * 1e4) / 1e4;
/** ₹ equal to the paisa — the same tolerance the wallet's portal check uses. */
const eqPaise = (a: number, b: number): boolean =>
  Math.round((Number(a) || 0) * 100) === Math.round((Number(b) || 0) * 100);
const safeDiv = (a: number, b: number): number | null =>
  b > 0 ? (Number(a) || 0) / b : null;

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
  /** invoiceValue + levies — analytics-only landed value (never a valuation). */
  landedValue: number;
  /** landedValue ÷ invoiceValue — the workbook's per-category "uplift". null when
   *  nothing was purchased in the bucket. */
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
  /** IML + Duty Paid rolled up. */
  spirits: { bottles: number; cases: number; invoiceValue: number; landedValue: number; lines: number };
  unmapped: LqTypeBucket;
  mappedLines: number;
  totalLines: number;
  pending: LqPending | null;
}

/* ── §D derived factors — every one COMPUTED, never assumed ──────────────────── */
export interface LqSectionD {
  bottles: number;
  cases: number;
  invoice_value: number;
  levies_total: number;
  landed_value: number;
  /** landed ÷ invoice, overall. */
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
  /** Σ landed ÷ Σ bottles. Analytics only. */
  avg_landed_per_bottle: number | null;
  /** bottles on case-packed lines (case_size > 1) — `cases` counts these alone. */
  case_packed_bottles: number;
  /** bottles bought loose (no outer case). They are NOT in `cases`. */
  loose_bottles: number;
  pending: LqPending | null;
}

/* ── §E emergency wine-shop purchases ────────────────────────────────────────── */
export interface LqRetailRow {
  id: string;
  date: string;
  shop_name: string;
  bottles: number;
  rate_paid_per_bottle: number;
  depot_landed_per_bottle: number;
  excess_per_bottle: number;
  excess_total: number;
  excess_pct: number;
  paid_by: string;
  reimbursement_status: string;
  reason: string;
}
export interface LqSectionE {
  rows: LqRetailRow[];
  bottles: number;
  spend: number;
  depot_equivalent: number;
  /** Σ excess over buys with a KNOWN depot rate. A buy we could not price never
   *  masquerades as a zero-excess buy (L3's rule, and L3's figure). */
  excess_total: number;
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
export interface LqSectionF {
  depot_net_indent: number;
  retail_spend: number;
  total: number;
  retail_share_pct: number | null;
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
  mapReason: string;
}
export interface LqSectionG {
  rows: LqRateMoveRow[];
  moved_lines: number;
  scanned_lines: number;
  unmapped_lines: number;
  total_variance_value: number;
  pending: LqPending | null;
}

/* ── §H non-sale issues (stock withdrawals) ──────────────────────────────────── */
export interface LqWithdrawalBucket {
  category: string;
  count: number;
  landed_value: number;
  mrp_value: number;
  recoverable: number;
  recovered: number;
  outstanding: number;
}
export interface LqSectionH {
  buckets: LqWithdrawalBucket[];
  total_landed_value: number;
  total_outstanding: number;
  /** total landed value ÷ depot Net Indent × 100 — like-for-like, store-scoped. */
  pct_of_purchases: number | null;
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
  checks: LqCheck[];
  /** Which sibling phases still owe live data, for the page's dependency panel. */
  dependencies: Array<{ phase: LqPhase; label: string; live: boolean; note: string }>;
}

export interface LqSummaryOpts {
  storeId: string;
  storeName?: string;
  from: string;
  to: string;
  /** §A2 planned next indent value (₹). Omitted → the planner reports the
   *  balance only. */
  plannedIndent?: number | null;
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

  // product_type per material, cached — a material maps to one product type
  // across its pack variants, so this is cheap and stable.
  const bucketByMaterial = new Map<string, LqBucketKey>();
  const bucketFor = (materialId: string): LqBucketKey => {
    const hit = bucketByMaterial.get(materialId);
    if (hit) return hit;
    let bucket: LqBucketKey = 'Unmapped';
    try {
      const pick = pickBrandMap(db, materialId);
      if (pick.row) {
        const pt = String(pick.row.product_type || '');
        bucket = pt === 'BEER' || pt === 'IML' || pt === 'Duty Paid' ? (pt as LqBucketKey) : 'Unmapped';
      }
    } catch { bucket = 'Unmapped'; }
    bucketByMaterial.set(materialId, bucket);
    return bucket;
  };

  const lines = raw.map(r => {
    const meta: PackMeta = {
      unit: r.unit, purchase_unit: r.purchase_unit,
      pack_size: r.pack_size, case_size: r.case_size,
    };
    const pf = packFactor(meta);
    const cf = caseFactor(meta);
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
      bucket: bucketFor(String(r.materialId)),
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
  const indents: LqIndentRow[] = refOrder.map(ref => {
    const k = ref.toLowerCase();
    const bc = billCharges[k];
    const myLines = linesByRef.get(k) || [];
    const lineInvoice = r2(myLines.reduce((s, l) => s + l.subtotal, 0));
    const firstLine = myLines[0];
    const partial_in_range = (wholeBillLines.get(k) ?? myLines.length) > myLines.length;
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
  for (const ln of lines) {
    const bkt = buckets[ln.bucket];
    bkt.lines += 1;
    bkt.bottles += ln.bottles;
    bkt.cases += ln.cases;
    bkt.invoiceValue += ln.subtotal;
    bkt.levies += ln.levies;
    bkt.landedValue += ln.subtotal + ln.levies;
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
    b.landedValue = r2(b.landedValue);
    b.uplift = b.invoiceValue > 0 ? r4(b.landedValue / b.invoiceValue) : null;
  }
  // Non-case-packed lines contribute 0 cases (see readLines), so this IS totCases —
  // spelled out because cess_per_case divides case-packed cess by it and the two
  // halves must stay on one basis.
  const casePackedCases = lines.reduce((s, l) => s + (l.caseSized ? l.cases : 0), 0);

  const spirits = {
    bottles: r4(buckets.IML.bottles + buckets['Duty Paid'].bottles),
    cases: r4(buckets.IML.cases + buckets['Duty Paid'].cases),
    invoiceValue: r2(buckets.IML.invoiceValue + buckets['Duty Paid'].invoiceValue),
    landedValue: r2(buckets.IML.landedValue + buckets['Duty Paid'].landedValue),
    lines: buckets.IML.lines + buckets['Duty Paid'].lines,
  };
  const C: LqSectionC = {
    buckets: LQ_BUCKETS.map(k => buckets[k]),
    beer: buckets.BEER,
    spirits,
    unmapped: buckets.Unmapped,
    mappedLines,
    totalLines: lines.length,
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
    landed_value: r2(totLanded),
    uplift_overall: totInvoice > 0 ? r4(totLanded / totInvoice) : null,
    uplift_by_type: LQ_BUCKETS.filter(k => k !== 'Unmapped').map(k => ({ key: k, uplift: buckets[k].uplift })),
    effective_tcs_pct: totInvoice > 0 ? r4((totTcs / totInvoice) * 100) : null,
    cess_per_case: (() => { const v = safeDiv(casePackedCess, casePackedCases); return v == null ? null : r4(v); })(),
    cess_per_bottle: (() => { const v = safeDiv(totCess, totBottles); return v == null ? null : r4(v); })(),
    mrp_rounding_per_bottle: (() => { const v = safeDiv(totMrp, totBottles); return v == null ? null : r4(v); })(),
    avg_landed_per_bottle: (() => { const v = safeDiv(totLanded, totBottles); return v == null ? null : r4(v); })(),
    case_packed_bottles: r4(casePackedBottles),
    loose_bottles: r4(looseBottles),
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
  const retailRows: LqRetailRow[] = (rx?.rows ?? []).map(r => ({
    id: String(r.id),
    date: String(r.date || ''),
    shop_name: String(r.shop_name || ''),
    bottles: Number(r.bottles) || 0,
    rate_paid_per_bottle: Number(r.rate_paid_per_bottle) || 0,
    depot_landed_per_bottle: Number(r.depot_landed_per_bottle) || 0,
    excess_per_bottle: Number(r.excess_per_bottle) || 0,
    excess_total: Number(r.excess_total) || 0,
    excess_pct: Number(r.excess_pct) || 0,
    paid_by: String(r.paid_by || ''),
    reimbursement_status: String(r.reimbursement_status || ''),
    reason: String(r.reason || ''),
  }));
  const retailBottles = r4(rx?.totalBottles ?? 0);
  const retailSpend = r2(rx?.wineShopSpend ?? 0);
  const retailDepotEq = r2(retailRows.reduce((s, r) => s + r.depot_landed_per_bottle * r.bottles, 0));
  const retailExcess = r2(rx?.excessTotal ?? 0);
  const unreimbursed = r2(rx?.unreimbursedStaffSpend ?? 0);
  const E: LqSectionE = {
    rows: retailRows,
    bottles: retailBottles,
    spend: retailSpend,
    depot_equivalent: retailDepotEq,
    excess_total: retailExcess,
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

  /* ── §F total liquor cost ────────────────────────────────────────────────── */
  const totalCost = r2(depotNetIndent + retailSpend);
  const F: LqSectionF = {
    depot_net_indent: depotNetIndent,
    retail_spend: retailSpend,
    total: totalCost,
    retail_share_pct: totalCost > 0 ? r4((retailSpend / totalCost) * 100) : null,
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
  const gRows: LqRateMoveRow[] = moved
    .sort((a, b) => Math.abs(b.varianceValue ?? 0) - Math.abs(a.varianceValue ?? 0))
    .map(r => ({
      ledgerId: r.ledgerId,
      invoiceRef: r.invoiceRef,
      inwardDate: r.inwardDate,
      materialName: r.materialName,
      category: r.category,
      bottles: r.bottles,
      indentRate: r.indentRate,
      masterRate: r.masterRate,
      variance: r.variance,
      varianceValue: r.varianceValue,
      proposedRatePerCase: r.proposedRatePerCase,
      mapReason: r.mapReason,
    }));
  const G: LqSectionG = {
    rows: gRows,
    moved_lines: moved.length,
    scanned_lines: moveRows.length,
    unmapped_lines: unmappedG,
    total_variance_value: r2(moved.reduce((s, r) => s + (r.varianceValue ?? 0), 0)),
    pending: gErr
      ? unavailable('L1', 'The rate-movement watch')
      : ((moveRows.length > 0 && moveRows.every(r => r.masterRate == null))
        ? { phase: 'L1', reason: 'Indents recorded, but no brand is mapped — rate movement needs the TGBCL Brand Map master rates.' }
        : (moveRows.length === 0
          ? { phase: 'L1', reason: 'No liquor indents recorded in this range.' }
          : null)),
  };

  /* ── §H non-sale issues (lq_withdrawals — L4 writes them) ─────────────────── */
  const wdRead = readOr<any[]>(() => db.prepare(`
    SELECT category,
           COUNT(*) AS count,
           COALESCE(SUM(landed_value), 0) AS landed_value,
           COALESCE(SUM(mrp_value), 0) AS mrp_value,
           COALESCE(SUM(recoverable), 0) AS recoverable,
           COALESCE(SUM(recovered), 0) AS recovered,
           COALESCE(SUM(recoverable - recovered), 0) AS outstanding
    FROM lq_withdrawals
    WHERE store_id = ? AND date >= ? AND date <= ?
    GROUP BY category
    ORDER BY landed_value DESC
  `).all(storeId, from, to) as any[], []);
  const wdRaw = wdRead.value;
  const wdBuckets: LqWithdrawalBucket[] = wdRaw.map(r => ({
    category: String(r.category || ''),
    count: Number(r.count) || 0,
    landed_value: r2(Number(r.landed_value) || 0),
    mrp_value: r2(Number(r.mrp_value) || 0),
    recoverable: r2(Number(r.recoverable) || 0),
    recovered: r2(Number(r.recovered) || 0),
    outstanding: r2(Number(r.outstanding) || 0),
  }));
  const wdLanded = r2(wdBuckets.reduce((s, b) => s + b.landed_value, 0));
  const wdOutstanding = r2(wdBuckets.reduce((s, b) => s + b.outstanding, 0));
  const H: LqSectionH = {
    buckets: wdBuckets,
    total_landed_value: wdLanded,
    total_outstanding: wdOutstanding,
    pct_of_purchases: depotNetIndent > 0 ? r4((wdLanded / depotNetIndent) * 100) : null,
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
  let bMismatch = 0, bMatched = 0, bMissing = 0, bWorstDiff = 0;
  for (const pc of indentReadings) {
    const ref = String(pc.reference || '').trim();
    const bc = billCharges[ref.toLowerCase()];
    if (!bc) { bMissing += 1; continue; }
    const net = Number(bc.net_indent_value) || 0;
    const portal = Number(pc.portal_amount) || 0;
    if (eqPaise(net, portal)) bMatched += 1;
    else { bMismatch += 1; if (Math.abs(net - portal) > Math.abs(bWorstDiff)) bWorstDiff = r2(portal - net); }
  }
  if (indentReadings.length === 0) {
    checks.push({
      key: 'B', label: 'Per-indent value vs portal', state: 'no_data',
      detail: indentChecksRead.error
        ? 'Portal readings could not be read on this database yet.'
        // Nothing in the app records an indent-value reading yet (the wallet
        // page's portal check files a wallet_balance one), so say what this is
        // waiting for rather than implying nobody has typed one in.
        : 'No per-indent portal reading in this range — this check waits on an indent-value reading; the wallet page records the wallet-balance reading only.',
      computed: null, observed: null, difference: null,
    });
  } else {
    checks.push({
      key: 'B', label: 'Per-indent value vs portal',
      state: bMismatch > 0 ? 'fail' : (bMissing > 0 ? 'warn' : 'pass'),
      detail: bMismatch > 0
        ? `${bMismatch} of ${indentReadings.length} indent(s) differ from portal`
        : (bMissing > 0
          ? `${bMatched} matched; ${bMissing} reading(s) name no indent recorded in this store`
          : `${bMatched} indent(s) match portal`),
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
        : (eqPaise(retailExcess, 0) ? 'No premium paid over depot' : 'Premium paid buying retail')),
    computed: retailExcess, observed: null, difference: null,
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
          ? `${A.row_count} wallet movement(s) recorded — §A, §A2 and checks A/C are live. Check B additionally needs a per-indent portal reading, which nothing records yet.`
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
    checks,
    dependencies,
  };
}

/* ── CSV export, per section — well-formed, Excel-safe (csvCell from L2) ──────── */

const CSV_SECTIONS = ['A', 'A2', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'checks'] as const;
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
        'Lines outside range']));
      for (const i of b.indents) {
        lines.push(row([i.invoice_ref, i.date, i.supplier, i.lines, i.invoice_value, i.mrp_rounding,
          i.excise_turnover_tax, i.special_excise_cess, i.tcs, i.net_indent_value,
          i.has_charges ? 'yes' : 'no', i.partial_in_range ? 'yes (counted whole)' : 'no']));
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
      lines.push(row([head, 'Section C — Beer / spirit split']));
      lines.push(row(['Product type', 'Lines', 'Bottles', 'Cases (case-packed only)', 'Invoice value',
        'Levies', 'Landed value', 'Uplift']));
      for (const b of c.buckets) {
        lines.push(row([b.key, b.lines, b.bottles, b.cases, b.invoiceValue, b.levies, b.landedValue, num(b.uplift)]));
      }
      lines.push(row(['SPIRITS (IML + Duty Paid)', c.spirits.lines, c.spirits.bottles, c.spirits.cases,
        c.spirits.invoiceValue, '', c.spirits.landedValue, '']));
      break;
    }
    case 'D': {
      const d = res.sections.D;
      lines.push(row([head, 'Section D — Derived factors (computed, not assumed)']));
      lines.push(row(['Factor', 'Value']));
      lines.push(row(['Bottles', d.bottles]));
      lines.push(row(['Cases (case-packed lines only)', d.cases]));
      lines.push(row(['Bottles bought loose (no outer case)', d.loose_bottles]));
      lines.push(row(['Invoice value (Rs)', d.invoice_value]));
      lines.push(row(['Levies total (Rs)', d.levies_total]));
      lines.push(row(['Landed value (Rs)', d.landed_value]));
      lines.push(row(['Uplift overall (landed / invoice)', num(d.uplift_overall)]));
      for (const u of d.uplift_by_type) lines.push(row([`Uplift — ${u.key}`, num(u.uplift)]));
      lines.push(row(['Effective TCS %', num(d.effective_tcs_pct)]));
      lines.push(row(['Cess per case (Rs)', num(d.cess_per_case)]));
      lines.push(row(['Cess per bottle (Rs)', num(d.cess_per_bottle)]));
      lines.push(row(['MRP rounding per bottle (Rs)', num(d.mrp_rounding_per_bottle)]));
      lines.push(row(['Avg landed per bottle (Rs)', num(d.avg_landed_per_bottle)]));
      if (res.basis.note) lines.push(row(['BASIS', res.basis.note]));
      break;
    }
    case 'E': {
      const e = res.sections.E;
      lines.push(row([head, 'Section E — Emergency wine-shop purchases']));
      lines.push(row(['Date', 'Shop', 'Bottles', 'Rate paid/bottle', 'Depot landed/bottle',
        'Excess/bottle', 'Excess total', 'Excess %', 'Paid by', 'Reimbursement', 'Reason']));
      for (const r of e.rows) {
        lines.push(row([r.date, r.shop_name, r.bottles, r.rate_paid_per_bottle, r.depot_landed_per_bottle,
          r.excess_per_bottle, r.excess_total, r.excess_pct, r.paid_by, r.reimbursement_status, r.reason]));
      }
      lines.push(row(['TOTAL', '', e.bottles, '', '', '', e.excess_total, '', '', '', '']));
      lines.push(row(['Retail spend (Rs)', e.spend]));
      lines.push(row(['Depot equivalent (Rs)', e.depot_equivalent]));
      lines.push(row(['Unreimbursed staff spend (Rs)', e.unreimbursed_staff_spend]));
      lines.push(row(['  of which claims whose payout was deleted', e.reopened_claim_count]));
      lines.push(row(['Buys with an unknown depot rate (excluded from excess)', e.unknown_depot_count]));
      lines.push(row(['  bottles', e.unknown_depot_bottles]));
      break;
    }
    case 'F': {
      const f = res.sections.F;
      lines.push(row([head, 'Section F — Total liquor cost']));
      lines.push(row(['Component', 'Value (Rs)']));
      lines.push(row(['Depot net indent', f.depot_net_indent]));
      lines.push(row(['Retail spend', f.retail_spend]));
      lines.push(row(['Total', f.total]));
      lines.push(row(['Retail share %', num(f.retail_share_pct)]));
      break;
    }
    case 'G': {
      const g = res.sections.G;
      lines.push(row([head, 'Section G — Rate-movement watch']));
      lines.push(row(['Date', 'Invoice ref', 'Material', 'Category', 'Bottles', 'Indent rate',
        'Master rate', 'Variance', 'Variance value', 'Proposed rate/case']));
      for (const r of g.rows) {
        lines.push(row([r.inwardDate, r.invoiceRef, r.materialName, r.category, r.bottles, r.indentRate,
          num(r.masterRate), num(r.variance), num(r.varianceValue), num(r.proposedRatePerCase)]));
      }
      lines.push(row(['Moved lines', g.moved_lines]));
      lines.push(row(['Scanned lines', g.scanned_lines]));
      lines.push(row(['Unmapped lines', g.unmapped_lines]));
      lines.push(row(['Total variance value (Rs)', g.total_variance_value]));
      break;
    }
    case 'H': {
      const h = res.sections.H;
      lines.push(row([head, 'Section H — Non-sale issues (withdrawals)']));
      lines.push(row(['Category', 'Count', 'Landed value', 'MRP value', 'Recoverable', 'Recovered', 'Outstanding']));
      for (const b of h.buckets) {
        lines.push(row([b.category, b.count, b.landed_value, b.mrp_value, b.recoverable, b.recovered, b.outstanding]));
      }
      lines.push(row(['TOTAL', '', h.total_landed_value, '', '', '', h.total_outstanding]));
      lines.push(row(['% of purchases', num(h.pct_of_purchases)]));
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
