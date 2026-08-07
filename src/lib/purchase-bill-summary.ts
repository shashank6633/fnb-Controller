import type DatabaseT from 'better-sqlite3';
import { getDb } from './db';
import { todayIST } from './format-date';

/**
 * PURCHASE BILL SUMMARY — one row per VENDOR BILL, money only.
 *
 * Requirement 69: "one row per purchase bill with Bill No., Vendor, Date, Total
 * Bill Value, GST, Discount, and Delivery Charges."
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 1. ONE SOURCE, THEREFORE ONE GRAND TOTAL IS LEGAL
 * ═══════════════════════════════════════════════════════════════════════════
 * This file reads the `purchases` table and NOTHING ELSE. No join to the GRN
 * header table, the GRN line table, the PO-bill table or the PO line table. No
 * join to raw_materials either.
 *
 * That is the whole design. src/lib/purchase-log.ts must return THREE totals
 * that may never be added, because a single delivery is written into three
 * tables inside one transaction and a UNION over them reads ~2-3x the real
 * spend. This report sidesteps that entirely: with one source, every rupee is
 * counted exactly once BY CONSTRUCTION, and the cross-source sum that ruins the
 * log's arithmetic is not even expressible here.
 *
 *   ⚠ DO NOT "IMPROVE" THIS BY UNIONING THE GRN LINE TABLE BACK IN so that
 *     PO-received bills show their tax. The instant a GRN column is summed
 *     beside a `purchases` column, this report is one careless edit away from
 *     the doubled number that the purchase-log header exists to prevent, and
 *     the single grand total below stops being defensible. If a tax-inclusive
 *     purchase register is ever wanted, build it as a SEPARATE report with its
 *     own per-source totals — do not graft it onto this one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 2. WHAT A "BILL" IS HERE — the key, and why grn_id outranks bill_no
 * ═══════════════════════════════════════════════════════════════════════════
 * `purchases` holds ONE ROW PER ITEM; a vendor bill spans several rows. The key
 * is derived, in this precedence (see billKeyExpr below):
 *
 *   1. invoice_id  → 'INV:<invoice_id>'
 *      PINV-yyyy-#### is OUR number, minted ONE PER VENDOR BILL by the
 *      hand-entry path. Where present it IS the bill. Measured: 0 rows carry
 *      both an invoice_id and a grn_id, so branches 1 and 2 cannot fight.
 *
 *   2. grn_id      → 'GRN:<grn_id>'
 *      DELIBERATELY AHEAD OF bill_no. A PO receive / ad-hoc GRN mints one GRN
 *      per delivery inside one transaction and stamps grn_id on every
 *      `purchases` row it writes (see the insPurchase prepare and its last bind
 *      in src/app/api/purchase-orders/[id]/receive/route.ts). One GRN = exactly
 *      one vendor bill event, and it is a HARD COLUMN, not a sentence parsed
 *      back out of `notes` the way purchase-log.ts still has to. The vendor's
 *      own number is blank on 26 of those 31 rows, so keying on bill_no would
 *      have dumped them into the DAY branch and merged real deliveries with
 *      unrelated market runs from the same vendor that day. Measured: grn_id
 *      and the notes GLOB agree 31/31, so nothing the regex would have caught
 *      is lost. purchase-log.ts's is_mirror GLOB is left untouched — this
 *      report simply uses the better column that now exists.
 *
 *   3. bill_no     → 'BILL:<vendor>|<bill_no>|<date>|<outlet>'
 *      The VENDOR'S own printed number. This is /api/purchases' own duplicate-
 *      guard tuple minus its wildcard case. Empty on today's data (0 bills) and
 *      kept anyway: a hand entry carrying a vendor bill number but no
 *      invoice_id is legal, and historical rows may acquire one.
 *
 *   4. else        → 'DAY:<vendor>|<date>|<outlet>'   (or 'ROW:<id>', see §3)
 *
 * outlet_id is IN the key on branches 3 and 4 even though there is one outlet
 * today — a second outlet must never merge into another outlet's bill.
 *
 * MEASURED on a copy of live (2,165 rows): 350 bills —
 *   INV 13 bills / 13 lines · GRN 29 / 31 · BILL 0 / 0 · DAY_RUN 308 / 2,121.
 *
 * NOT READ: purchases.invoice_number. It exists in some database files but is
 * absent from db.ts's CREATE and from every ALTER, so referencing it turns the
 * whole report into a hard 500 on a database that lacks it. Same trap
 * purchase-log.ts documents on its PURCHASE branch. Ours is invoice_id; the
 * vendor's is bill_no; there is no third.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 3. THE DAY_RUN CAVEAT — 308 of 350 "bills" are not paper bills
 * ═══════════════════════════════════════════════════════════════════════════
 * 2,151 of 2,165 rows carry no vendor bill number at all, so branch 4 IS this
 * report. Those rows are grouped by vendor + date + outlet and are NOT
 * presented as a document: bill_kind is 'DAY_RUN', bill_no_missing is true, and
 * the caller MUST label them as what they are — that vendor's purchases for
 * that day consolidated into one readable line, which may cover more than one
 * physical bill or market run. Do not print them as if they were invoices.
 *
 * Rejected alternative: one bill per row for the unnumbered case. That yields
 * 2,121 one-line "bills", i.e. a line log — which /reports/purchase-log already
 * is, and better. An escape hatch is provided instead: unnumbered = 'split'
 * swaps branch 4 to 'ROW:<id>' and gives the per-line view on demand without
 * making it the default. bill_kind stays 'DAY_RUN' under split — the defining
 * fact (no vendor bill number, so this is not a paper bill) has not changed,
 * only the grouping granularity, which `lines` = 1 makes visible.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 4. PO-RECEIVED BILLS APPEAR, AND THEIR CHARGE COLUMNS ARE NOT ZERO —
 *    THEY ARE NOT APPLICABLE. RENDER AN EM-DASH, NOT A 0.
 * ═══════════════════════════════════════════════════════════════════════════
 * A delivery received against a PO is a real vendor bill, so excluding it would
 * understate the period (29 bills / 31 lines / Rs 25,280 of goods on live).
 * They are in.
 *
 * But a PO-receive `purchases` row is a deliberately TAX-FREE COST MIRROR. The
 * receive route binds discount to the LITERAL 0 (the discount is already inside
 * the net rate) and binds no cgst/sgst at all (tax there would poison
 * average_price and destroy the input credit). The tax and the gross discount
 * live on the GRN line, which is the bill document. MEASURED across all 31
 * mirror rows: SUM(cgst + sgst) = 0, SUM(discount) = 0, SUM(delivery_charges)
 * = 50 (the allocated delivery share IS carried onto the mirror),
 * SUM(total_price) = 25,280.
 *
 * So printing "GST Rs 0" on those bills would assert "no tax was charged" on
 * bills that were taxed. This layer returns the figures AS STORED (they are the
 * honest content of the source table) and ships `tax_on_grn` = true beside
 * them. Every consumer must use that flag:
 *   · screen  — em-dash, not 0, in Discount / GST / both cess columns, with a
 *               "tax on GRN" badge on the row;
 *   · CSV     — a note column saying the charges are recorded on the GRN;
 *   · the row's total_bill_value is BOOKED COST (goods + allocated delivery),
 *     which is NOT the vendor's bill face value. Say so on the row, not only in
 *     a header comment.
 * Period totals carry po_receipt_bills / po_receipt_value so a footer can print
 * the split and the grand total can never be mistaken for tax-inclusive.
 * include_po_receipts = false drops them for anyone who wants hand-entered
 * bills alone; the default is to include.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 5. GOODS = SUM(total_price) AS STORED
 * ═══════════════════════════════════════════════════════════════════════════
 * Never recomputed from the line's own count x rate. MEASURED: 217 of 2,165
 * rows disagree by more than a paisa (Rs 6,926,866.40 stored vs Rs 6,770,245.24
 * recomputed — Rs 156,621 apart). SUM(total_price) is exactly what
 * /api/reports/purchases sums as total_spend, so the two reports reconcile to
 * the rupee. (That sibling INNER JOINs raw_materials and this one joins
 * nothing; 0 orphan purchases today, and if a material is ever deleted THIS
 * report is the one that stays right.)
 *
 * TOTAL BILL VALUE is the existing Total Inward definition, per bill, unchanged:
 *   SUM(total_price) - SUM(discount) + SUM(cgst) + SUM(sgst)
 *   + SUM(compensation_cess) + SUM(special_excise_cess) + SUM(tcs)
 *   + SUM(delivery_charges) + SUM(mrp_round_off)
 *
 * GST is cgst + sgst ONLY — the house invariant. compensation_cess (the GST
 * (Compensation to States) levy) and special_excise_cess (TGBCL's) get their
 * OWN columns and are NEVER folded into GST: different levy, different taxable
 * base, and a return filed on the folded figure would be wrong.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 6. NO COUNTS AND NO PER-UNIT RATES ARE READ ANYWHERE — SO THERE IS NO PAIRING
 * ═══════════════════════════════════════════════════════════════════════════
 * A bill spans kg + BTL + CASE lines, so adding up its item counts produces a
 * number with no unit. This report shows a `lines` count instead and reads
 * neither the per-line count column nor the Rs-per-purchase-unit rate column on
 * `purchases`. It therefore writes no rate x count product at all, and the
 * rate-basis lock (scripts/check-rate-basis.js) has nothing to judge — no
 * `rate-basis:` declaration and no ALLOW entry are needed, and none should be
 * added to "be safe".
 *
 *   ⚠ ADDING AN "AVG RATE" OR "TOTAL QTY" COLUMN CREATES A PAIRING THAT DOES
 *     NOT EXIST TODAY. If you ever do, the two halves must both be purchase
 *     basis (per the canon: the count column on `purchases` is in PURCHASE
 *     units, its rate column is Rs per PURCHASE unit) and the site must declare
 *     `-- rate-basis: purchase`. Do not reach for raw_materials.average_price,
 *     which is Rs per RECIPE unit, and never read the mixed-basis LPP column at
 *     all (see src/lib/closing-valuation.ts).
 *
 * READ-ONLY. This file issues SELECTs and nothing else: no write statement of
 * any kind, no migration. Keep it that way — a report that mutates is a report
 * nobody can safely re-run, and a grep for the three SQL write verbs finding
 * nothing in this file is part of its acceptance, so do not name them here
 * either.
 *
 * The caller (the route) owns the management gate. This is a pure query layer
 * and applies no authorisation of its own.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types (the route and the page import these — keep the shape stable)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How firm this bill's identity is. Shown on screen so a reader is never handed
 * 350 rows that all claim to be paper bills.
 *   INV     — our PINV number: one per vendor bill. Firm.
 *   GRN     — a PO receive / ad-hoc GRN: one delivery. Firm, but see §4.
 *   BILL    — the vendor's own printed number. Firm.
 *   DAY_RUN — no bill number anywhere: a vendor-day consolidation. NOT a bill.
 */
export type PurchaseBillKind = 'INV' | 'GRN' | 'BILL' | 'DAY_RUN';

/** How rows with no vendor bill number are grouped. */
export type UnnumberedMode = 'group' | 'split';

export interface PurchaseBillRow {
  /** The derived key. Also lets a reader pivot to /reports/purchase-log. */
  bill_key: string;
  bill_kind: PurchaseBillKind;
  /** MIN(date) of the group — the bill date. YYYY-MM-DD as stored. */
  date: string;
  /** MAX(date). Equal to `date` unless an INV/GRN group spans days. */
  date_to: string;
  /** true when date_to > date — render "<date>…<date_to>", do not hide it. */
  spans_days: boolean;
  /** MIN(vendor) of the group. */
  vendor: string;
  /**
   * COUNT(DISTINCT vendor). Measured 0 multi-vendor groups today; if one ever
   * appears, render "VENDOR (+n more)" rather than letting `vendor` lie.
   */
  vendor_count: number;
  /** OUR number (PINV-yyyy-####). '' when the bill was not hand-entered. */
  invoice_id: string;
  /** The VENDOR'S own number. Often '' — never conflate with invoice_id. */
  bill_no: string;
  /** The GRN behind a PO receive. '' on hand-entered bills. */
  grn_id: string;
  /** true when the vendor's own number is absent. Drives the CSV YES/NO. */
  bill_no_missing: boolean;
  /**
   * true on GRN-keyed bills: the discount and the four tax figures below are
   * stored as 0 on the cost mirror because the real ones live on the GRN. Show
   * an em-dash, NOT a zero, and label total_bill_value as booked cost. See §4.
   */
  tax_on_grn: boolean;
  /** COUNT(*) of `purchases` rows in the group. No item counts — see §6. */
  lines: number;
  /** SUM(total_price) AS STORED. Never recomputed. See §5. */
  goods: number;
  discount: number;
  cgst: number;
  sgst: number;
  /** cgst + sgst. Neither cess is in here — different levy, different base. */
  gst: number;
  compensation_cess: number;
  special_excise_cess: number;
  tcs: number;
  delivery_charges: number;
  mrp_round_off: number;
  /** goods − discount + gst + both cesses + tcs + delivery + round-off. */
  total_bill_value: number;
}

export interface PurchaseBillTotals {
  /** Distinct bills matching the filters BEFORE any truncation. */
  bills: number;
  /** `purchases` rows behind them. */
  lines: number;
  goods: number;
  discount: number;
  cgst: number;
  sgst: number;
  gst: number;
  compensation_cess: number;
  special_excise_cess: number;
  tcs: number;
  delivery_charges: number;
  mrp_round_off: number;
  /** The one grand total this report may legitimately print. See §1. */
  total_bill_value: number;
  /** How many of `bills` are PO/GRN receipts whose tax sits on the GRN. */
  po_receipt_bills: number;
  /** `purchases` rows behind those receipts. */
  po_receipt_lines: number;
  /** Their share of total_bill_value — booked cost, not bill face value. */
  po_receipt_value: number;
  /**
   * How many of `bills` carry no vendor bill number at all (the DAY branch,
   * §3). Computed by SQL over the FULL filtered set, so a footnote can state
   * the period's real figure instead of counting the capped rows in hand.
   */
  day_run_bills: number;
  /** Render verbatim beside the grand total. It is the guard on misreading. */
  basis: string;
}

export interface PurchaseBillSummaryResult {
  rows: PurchaseBillRow[];
  totals: PurchaseBillTotals;
  /** true when `bills` exceeded BILL_SUMMARY_MAX_BILLS and rows were capped. */
  truncated: boolean;
  from: string;
  to: string;
  /** Echoed back so the page can show which mode produced these rows. */
  unnumbered: UnnumberedMode;
  include_po_receipts: boolean;
}

export interface PurchaseBillFilters {
  from?: string | null;
  to?: string | null;
  vendor?: string | null;
  /** 'split' gives one bill per row for unnumbered purchases. See §3. */
  unnumbered?: string | null;
  /** Default true. Pass '0' / 'false' / false to drop PO receipts. See §4. */
  include_po_receipts?: boolean | string | number | null;
}

/**
 * Hard cap on returned BILLS (not lines). A silently truncated report is a
 * wrong report, so `truncated` rides alongside and every figure in `totals` is
 * computed by SQL over the FULL filtered set — the cap can never distort one.
 */
export const BILL_SUMMARY_MAX_BILLS = 5_000;

const TOTALS_BASIS =
  'One source (the purchases table), so this grand total counts every rupee exactly once. '
  + 'PO/GRN receipts are included at BOOKED COST: their tax and gross discount are recorded on '
  + 'the GRN, not on this cost row, so the total is NOT a tax-inclusive purchase register.';

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const isYmd = (s: unknown): s is string => typeof s === 'string' && YMD.test(s);
const r2 = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/**
 * Calendar arithmetic on a YYYY-MM-DD string via UTC, deliberately.
 * `new Date('2026-08-02')` parses as UTC midnight and then renders in the
 * server's local zone, which lands on the previous day west of Greenwich —
 * that is how a "last 30 days" default silently becomes 29 or 31.
 * (Same helper, same reason, as src/lib/purchase-log.ts.)
 */
function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

/**
 * Resolve the requested window, defaulting to the last 30 days INCLUSIVE of
 * today in IST (today − 29 … today). Invalid or missing values fall back to the
 * default rather than throwing, and a reversed range is swapped — a report that
 * returns nothing because from > to looks identical to "no purchases".
 */
export function resolveBillSummaryRange(
  from?: string | null,
  to?: string | null,
): { from: string; to: string } {
  const today = todayIST();
  let f = isYmd(from) ? from : addDaysYmd(today, -29);
  let t = isYmd(to) ? to : today;
  if (f > t) [f, t] = [t, f];
  return { from: f, to: t };
}

/**
 * The kind is read back off the key's own prefix rather than re-derived from
 * the columns, so the two can never disagree about which branch matched.
 * 'ROW:' is the unnumbered = 'split' form of the DAY branch and reports the
 * same kind — it is still a purchase with no vendor bill number (see §3).
 */
function kindFromKey(billKey: string): PurchaseBillKind {
  const i = billKey.indexOf(':');
  switch (i > 0 ? billKey.slice(0, i) : '') {
    case 'INV': return 'INV';
    case 'GRN': return 'GRN';
    case 'BILL': return 'BILL';
    default: return 'DAY_RUN';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The query
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ONE base SELECT over `purchases`, wrapped twice: once for the period totals
 * (an aggregate over the FULL filtered set) and once for the ordered, capped
 * per-bill rows. Both bind the same parameter list, in the same order.
 *
 * Driven by idx_purchases_date, so the requested range — not the table size —
 * bounds the scan.
 */
function buildBase(f: {
  from: string;
  to: string;
  vendor: string;
  unnumbered: UnnumberedMode;
  includePoReceipts: boolean;
}): { sql: string; params: any[] } {
  const params: any[] = [f.from, f.to];

  // CONTAINS, not equality — same reasoning as purchase-log's venFilter. The
  // filter on screen is a free-text box with a datalist, and a datalist
  // constrains nothing: typing "Metro" against a stored "Metro Cash & Carry Pvt
  // Ltd" matched zero rows and the page rendered a Rs 0 total. A silent wrong
  // answer is worse than a slightly loose match.
  const venFilter = f.vendor
    ? ` AND LOWER(TRIM(p.vendor)) LIKE '%' || LOWER(TRIM(?)) || '%'`
    : '';
  if (f.vendor) params.push(f.vendor);

  // A PO-receive cost mirror: no invoice_id of ours, but a hard grn_id. Must
  // stay identical to branch 2 of the key below, or the flag and the grouping
  // would describe different rows.
  const isPoReceiptExpr = `CASE WHEN TRIM(COALESCE(p.invoice_id, '')) = ''
                                 AND TRIM(COALESCE(p.grn_id, '')) <> ''
                                THEN 1 ELSE 0 END`;

  const poFilter = f.includePoReceipts
    ? ''
    : ` AND NOT (TRIM(COALESCE(p.invoice_id, '')) = '' AND TRIM(COALESCE(p.grn_id, '')) <> '')`;

  // Branch 4. 'group' consolidates a vendor's unnumbered purchases for one day
  // into one readable line; 'split' gives one bill per row. See §3.
  const elseBranch = f.unnumbered === 'split'
    ? `'ROW:' || p.id`
    : `'DAY:' || LOWER(TRIM(p.vendor)) || '|' || p.date || '|' || COALESCE(p.outlet_id, '')`;

  // Precedence: invoice_id (ours) > grn_id (one delivery) > vendor bill number
  // > vendor-day. grn_id sits AHEAD of bill_no on purpose — see §2.
  const billKeyExpr = `CASE
        WHEN TRIM(COALESCE(p.invoice_id, '')) <> '' THEN 'INV:' || TRIM(p.invoice_id)
        WHEN TRIM(COALESCE(p.grn_id, '')) <> ''     THEN 'GRN:' || TRIM(p.grn_id)
        WHEN TRIM(COALESCE(p.bill_no, '')) <> ''    THEN 'BILL:' || LOWER(TRIM(p.vendor)) || '|' || LOWER(TRIM(p.bill_no)) || '|' || p.date || '|' || COALESCE(p.outlet_id, '')
        ELSE ${elseBranch}
      END`;

  // The settled Total Inward definition, evaluated per LINE so that both the
  // per-bill SUM and the period SUM are the same arithmetic. COALESCE despite
  // the NOT NULL DEFAULT 0 declarations: older rows predate several of those
  // ALTERs and a single NULL would turn a whole bill's total into NULL.
  const lineTotalExpr = `COALESCE(p.total_price, 0)
                       - COALESCE(p.discount, 0)
                       + COALESCE(p.cgst, 0)
                       + COALESCE(p.sgst, 0)
                       + COALESCE(p.compensation_cess, 0)
                       + COALESCE(p.special_excise_cess, 0)
                       + COALESCE(p.tcs, 0)
                       + COALESCE(p.delivery_charges, 0)
                       + COALESCE(p.mrp_round_off, 0)`;

  const sql = `
    SELECT
      ${billKeyExpr}                            AS bill_key,
      ${isPoReceiptExpr}                        AS is_po_receipt,
      p.date                                    AS row_date,
      COALESCE(TRIM(p.vendor), '')              AS vendor,
      COALESCE(TRIM(p.invoice_id), '')          AS invoice_id,
      COALESCE(TRIM(p.bill_no), '')             AS bill_no,
      COALESCE(TRIM(p.grn_id), '')              AS grn_id,
      COALESCE(p.total_price, 0)                AS goods,
      COALESCE(p.discount, 0)                   AS discount,
      COALESCE(p.cgst, 0)                       AS cgst,
      COALESCE(p.sgst, 0)                       AS sgst,
      COALESCE(p.compensation_cess, 0)          AS compensation_cess,
      COALESCE(p.special_excise_cess, 0)        AS special_excise_cess,
      COALESCE(p.tcs, 0)                        AS tcs,
      COALESCE(p.delivery_charges, 0)           AS delivery_charges,
      COALESCE(p.mrp_round_off, 0)              AS mrp_round_off,
      ${lineTotalExpr}                          AS line_total
    FROM purchases p
    WHERE p.date >= ? AND p.date <= ?${venFilter}${poFilter}
  `;

  return { sql, params };
}

/**
 * Build the purchase bill summary for a date range.
 *
 * SELECT only. The caller owns the management gate.
 */
export function getPurchaseBillSummary(
  filters: PurchaseBillFilters = {},
  dbArg?: DatabaseT.Database,
): PurchaseBillSummaryResult {
  const db = dbArg || getDb();
  const { from, to } = resolveBillSummaryRange(filters.from, filters.to);
  const vendor = String(filters.vendor || '').trim();
  const unnumbered: UnnumberedMode =
    String(filters.unnumbered || '').trim().toLowerCase() === 'split' ? 'split' : 'group';

  // Default INCLUDED. Only an explicit off value drops PO receipts, so a typo
  // in the query string cannot silently understate the period.
  const rawInc = filters.include_po_receipts;
  const incStr = String(rawInc === undefined || rawInc === null ? '' : rawInc).trim().toLowerCase();
  const includePoReceipts = !(rawInc === false || incStr === '0' || incStr === 'false' || incStr === 'no');

  const { sql: base, params } = buildBase({ from, to, vendor, unnumbered, includePoReceipts });

  // ── TOTALS FIRST, over the FULL filtered set ──────────────────────────────
  // Computed by the database, never by summing the (possibly capped) rows, so
  // the cap can never quietly understate the spend.
  const agg = db.prepare(`
    SELECT
      COUNT(DISTINCT bill_key)                                        AS bills,
      COUNT(*)                                                        AS lines,
      COALESCE(SUM(goods), 0)                                         AS goods,
      COALESCE(SUM(discount), 0)                                      AS discount,
      COALESCE(SUM(cgst), 0)                                          AS cgst,
      COALESCE(SUM(sgst), 0)                                          AS sgst,
      COALESCE(SUM(compensation_cess), 0)                             AS compensation_cess,
      COALESCE(SUM(special_excise_cess), 0)                           AS special_excise_cess,
      COALESCE(SUM(tcs), 0)                                           AS tcs,
      COALESCE(SUM(delivery_charges), 0)                              AS delivery_charges,
      COALESCE(SUM(mrp_round_off), 0)                                 AS mrp_round_off,
      COALESCE(SUM(line_total), 0)                                    AS total_bill_value,
      COUNT(DISTINCT CASE WHEN is_po_receipt = 1 THEN bill_key END)   AS po_receipt_bills,
      COALESCE(SUM(CASE WHEN is_po_receipt = 1 THEN 1 ELSE 0 END), 0) AS po_receipt_lines,
      COALESCE(SUM(CASE WHEN is_po_receipt = 1 THEN line_total ELSE 0 END), 0) AS po_receipt_value,
      COUNT(DISTINCT CASE WHEN substr(bill_key, 1, 4) IN ('DAY:', 'ROW:') THEN bill_key END) AS day_run_bills
    FROM (${base})
  `).get(...params) as any;

  const cgstT = num(agg?.cgst);
  const sgstT = num(agg?.sgst);
  const totals: PurchaseBillTotals = {
    bills: num(agg?.bills),
    lines: num(agg?.lines),
    goods: r2(agg?.goods),
    discount: r2(agg?.discount),
    cgst: r2(cgstT),
    sgst: r2(sgstT),
    gst: r2(cgstT + sgstT),
    compensation_cess: r2(agg?.compensation_cess),
    special_excise_cess: r2(agg?.special_excise_cess),
    tcs: r2(agg?.tcs),
    delivery_charges: r2(agg?.delivery_charges),
    mrp_round_off: r2(agg?.mrp_round_off),
    total_bill_value: r2(agg?.total_bill_value),
    po_receipt_bills: num(agg?.po_receipt_bills),
    po_receipt_lines: num(agg?.po_receipt_lines),
    po_receipt_value: r2(agg?.po_receipt_value),
    day_run_bills: num(agg?.day_run_bills),
    basis: TOTALS_BASIS,
  };

  // ── ROWS ──────────────────────────────────────────────────────────────────
  // Newest bill first. vendor then bill_key are the tie-breaks, so the LIMIT
  // takes a deterministic prefix rather than an arbitrary one.
  const raw = db.prepare(`
    SELECT
      bill_key,
      MIN(row_date)                         AS date_from,
      MAX(row_date)                         AS date_to,
      MIN(vendor)                           AS vendor,
      COUNT(DISTINCT LOWER(vendor))         AS vendor_count,
      MAX(invoice_id)                       AS invoice_id,
      MAX(bill_no)                          AS bill_no,
      MAX(grn_id)                           AS grn_id,
      MAX(is_po_receipt)                    AS is_po_receipt,
      COUNT(*)                              AS lines,
      COALESCE(SUM(goods), 0)               AS goods,
      COALESCE(SUM(discount), 0)            AS discount,
      COALESCE(SUM(cgst), 0)                AS cgst,
      COALESCE(SUM(sgst), 0)                AS sgst,
      COALESCE(SUM(compensation_cess), 0)   AS compensation_cess,
      COALESCE(SUM(special_excise_cess), 0) AS special_excise_cess,
      COALESCE(SUM(tcs), 0)                 AS tcs,
      COALESCE(SUM(delivery_charges), 0)    AS delivery_charges,
      COALESCE(SUM(mrp_round_off), 0)       AS mrp_round_off,
      COALESCE(SUM(line_total), 0)          AS total_bill_value
    FROM (${base})
    GROUP BY bill_key
    ORDER BY date_from DESC,
             vendor COLLATE NOCASE ASC,
             bill_key ASC
    LIMIT ?
  `).all(...params, BILL_SUMMARY_MAX_BILLS) as any[];

  const rows: PurchaseBillRow[] = raw.map((r) => {
    const billKey = String(r.bill_key || '');
    const kind = kindFromKey(billKey);
    const dateFrom = String(r.date_from || '');
    const dateTo = String(r.date_to || '');
    const cgst = num(r.cgst);
    const sgst = num(r.sgst);
    return {
      bill_key: billKey,
      bill_kind: kind,
      date: dateFrom,
      date_to: dateTo,
      spans_days: dateTo > dateFrom,
      vendor: String(r.vendor || ''),
      vendor_count: num(r.vendor_count),
      invoice_id: String(r.invoice_id || ''),
      bill_no: String(r.bill_no || ''),
      grn_id: String(r.grn_id || ''),
      bill_no_missing: String(r.bill_no || '').trim() === '',
      // Derived from the KIND, not from "the tax happens to be 0" — a
      // hand-entered bill that genuinely carried no tax is a real zero and must
      // keep printing 0, not borrow the em-dash. See §4.
      tax_on_grn: kind === 'GRN',
      lines: num(r.lines),
      goods: r2(r.goods),
      discount: r2(r.discount),
      cgst: r2(cgst),
      sgst: r2(sgst),
      gst: r2(cgst + sgst),
      compensation_cess: r2(r.compensation_cess),
      special_excise_cess: r2(r.special_excise_cess),
      tcs: r2(r.tcs),
      delivery_charges: r2(r.delivery_charges),
      mrp_round_off: r2(r.mrp_round_off),
      total_bill_value: r2(r.total_bill_value),
    };
  });

  return {
    rows,
    totals,
    truncated: totals.bills > rows.length,
    from,
    to,
    unnumbered,
    include_po_receipts: includePoReceipts,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV — shared so the download and the on-screen table cannot drift apart
// ─────────────────────────────────────────────────────────────────────────────

export interface PurchaseBillColumn {
  /** Stable machine name. Not necessarily a field on the row. */
  key: string;
  label: string;
  /** Numeric columns skip the spreadsheet-formula guard (it breaks "-12.5"). */
  numeric?: boolean;
  value: (r: PurchaseBillRow) => unknown;
}

/**
 * The columns, in the order the screen shows them, so a row reconciles
 * left-to-right: goods − discount + GST + cesses + TCS + delivery + round-off
 * = Total Bill Value.
 *
 * The three trailing columns exist because a CSV gets forwarded and opened cold
 * in Excel by someone who never saw the screen's badges or footnote. "Bill No
 * Present" keeps the DAY_RUN caveat (§3) attached to the data, and the charges
 * note keeps the PO-mirror caveat (§4) attached to the zeros.
 */
export const PURCHASE_BILL_COLUMNS: PurchaseBillColumn[] = [
  { key: 'date',                label: 'Date',                    value: r => (r.spans_days ? `${r.date}…${r.date_to}` : r.date) },
  { key: 'bill_no',             label: 'Bill No (vendor)',        value: r => r.bill_no },
  { key: 'bill_no_present',     label: 'Bill No Present',         value: r => (r.bill_no_missing ? 'NO' : 'YES') },
  { key: 'invoice_id',          label: 'Invoice ID (ours)',       value: r => r.invoice_id },
  { key: 'grn_id',              label: 'GRN ID',                  value: r => r.grn_id },
  { key: 'vendor',              label: 'Vendor',                  value: r => (r.vendor_count > 1 ? `${r.vendor} (+${r.vendor_count - 1} more)` : r.vendor) },
  { key: 'bill_kind',           label: 'Bill Identity',           value: r => r.bill_kind },
  { key: 'lines',               label: 'Lines', numeric: true,    value: r => r.lines },
  { key: 'goods',               label: 'Goods (Rs)', numeric: true,             value: r => r.goods },
  { key: 'discount',            label: 'Discount (Rs)', numeric: true,          value: r => r.discount },
  { key: 'gst',                 label: 'GST = CGST+SGST (Rs)', numeric: true,   value: r => r.gst },
  { key: 'cgst',                label: 'CGST (Rs)', numeric: true,              value: r => r.cgst },
  { key: 'sgst',                label: 'SGST (Rs)', numeric: true,              value: r => r.sgst },
  { key: 'compensation_cess',   label: 'Compensation Cess (Rs)', numeric: true, value: r => r.compensation_cess },
  { key: 'special_excise_cess', label: 'Spl Excise Cess (Rs)', numeric: true,   value: r => r.special_excise_cess },
  { key: 'tcs',                 label: 'TCS (Rs)', numeric: true,               value: r => r.tcs },
  { key: 'delivery_charges',    label: 'Delivery Charges (Rs)', numeric: true,  value: r => r.delivery_charges },
  { key: 'mrp_round_off',       label: 'MRP Round Off (Rs)', numeric: true,     value: r => r.mrp_round_off },
  { key: 'total_bill_value',    label: 'Total Bill Value (Rs)', numeric: true,  value: r => r.total_bill_value },
  {
    key: 'charges_note',
    label: 'Charges Note',
    value: r => (r.tax_on_grn
      ? 'Charges recorded on GRN, not on this cost row — total is BOOKED COST, not bill face value'
      : ''),
  },
  { key: 'bill_key',            label: 'Bill Key',                value: r => r.bill_key },
];

/**
 * Escape one CSV field. Free-text (vendor, bill numbers, notes) gets the
 * leading `=+-@` guard — Excel executes those as formulas, and a vendor name is
 * user-entered text that reaches this file unfiltered.
 */
function csvCell(v: unknown, numeric: boolean): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (!numeric && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Serialise rows to CSV. Returns the body WITHOUT the UTF-8 BOM — the caller
 * prepends '﻿' when writing the HTTP response (prepending it twice puts a
 * stray glyph in the first header cell).
 */
export function purchaseBillSummaryToCsv(rows: PurchaseBillRow[]): string {
  const out: string[] = [PURCHASE_BILL_COLUMNS.map(c => csvCell(c.label, false)).join(',')];
  for (const r of rows) {
    out.push(PURCHASE_BILL_COLUMNS.map(c => csvCell(c.value(r), !!c.numeric)).join(','));
  }
  return out.join('\r\n');
}

/** Filename the download must use: purchase-bill-summary-<from>_<to>.csv */
export function purchaseBillSummaryFilename(from: string, to: string): string {
  return `purchase-bill-summary-${from}_${to}.csv`;
}
