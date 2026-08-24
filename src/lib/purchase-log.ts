import type DatabaseT from 'better-sqlite3';
import { getDb } from './db';
import { todayIST } from './format-date';
import { claimJoin } from './po-receipts';

/**
 * PURCHASE LOG — one row per ITEM per BILL, across all three procurement
 * sources (direct purchases, purchase orders, goods receipt notes), in one
 * chronological list the owner can download as a single CSV.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MODEL — WHY THESE THREE SOURCES ARE **NOT** ADDITIVE
 * ═══════════════════════════════════════════════════════════════════════════
 * Receiving a PO (src/app/api/purchase-orders/[id]/receive/route.ts) writes,
 * inside ONE transaction, for a single physical delivery:
 *
 *   1 × po_vendor_bills       — the vendor's bill event on that PO
 *   1 × goods_receipt_notes   — the GRN header (grn_number = GRN-<yyyy>-####)
 *   N × goods_receipt_note_items — one per received line, at GROSS bill rates
 *   N × purchases             — one per line with accepted > 0, at NET rates
 *
 * The ad-hoc path (POST /api/grn) does the same minus the PO: a GRN header,
 * GRN items, and a mirrored `purchases` row per accepted line.
 *
 * So a received PO line exists THREE times in the database:
 *   • purchase_order_items — what we ORDERED   (a commitment, not a spend)
 *   • goods_receipt_note_items — what the vendor BILLED (gross, the document)
 *   • purchases            — what we BOOKED    (net, the cost/stock entry)
 *
 * They are the same money. A naive UNION total would read ~2–3× the real
 * spend, and that is exactly the number an owner would quote. Hence:
 *   → totals are returned PER SOURCE and never summed (see PurchaseLogTotals),
 *   → every row carries `source`,
 *   → every row that belongs to one receipt event carries the same `link_key`.
 *
 * ── THE LINK. There is NO foreign key from `purchases` back to its GRN. ──
 * The only tie that exists in the schema is the GRN NUMBER, written literally
 * into `purchases.notes` by both writers, in the same transaction that minted
 * it (so it is always present and always correct):
 *
 *   PO receive : "Received against PO-2026-0001 (GRN GRN-2026-0007)"
 *                                                    ^^^^^^^^^^^^^
 *   Ad-hoc GRN : "Ad-hoc GRN GRN-2026-0007 · invoice 4841"
 *   Correction : "BACK-CORRECTION GRN GRN-2026-0007 · invoice 4841"
 *
 * A PO line reaches its GRN line through goods_receipt_note_items.po_item_id.
 * Chaining the two gives the receipt-event key used here:
 *
 *   link_key = "<grn_number>#<material_id>"
 *
 * present on the GRN line, on the `purchases` row it created, and on the PO
 * line it was received against. Sort or filter a download by link_key and the
 * three faces of one delivery sit together — the duplication is VISIBLE, which
 * is the whole point, rather than silently resolved by dropping a source.
 * link_key is null on a direct purchase (no GRN) and on a PO line not yet
 * received (or received outside the requested date window).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * UNITS — the standing error in this codebase, avoided here deliberately
 * ═══════════════════════════════════════════════════════════════════════════
 * purchases.quantity, purchase_order_items.quantity and the GRN quantity
 * columns are ALL ALREADY IN PURCHASE UNITS, and all three unit_price columns
 * are ₹ PER PURCHASE UNIT. pack_size / packFactor MUST NOT be applied to any
 * of them — that conversion belongs only on the way into raw_materials
 * .current_stock (recipe units). This file therefore never imports pack-units.
 * `purchase_unit` is printed beside every quantity so no reader can mistake a
 * "3" for 3 recipe units when it is 3 cases.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * RATES — two legitimate rates for the same line
 * ═══════════════════════════════════════════════════════════════════════════
 * GRN rate is GROSS (what the bill document says, discount in its own column).
 * purchases.unit_price is NET of the allocated discount, because
 * updateMaterialPrice() averages SUM(qty × unit_price)/SUM(qty) and never
 * reads a discount column. The receive route therefore writes purchases
 * .discount as a LITERAL 0 on that path — a zero in the Discount column of a
 * PURCHASE row does NOT mean "no discount was given", it means the discount is
 * already inside the rate and lives, itemised, on the GRN row that shares this
 * row's link_key. The report shows both rates, labelled by source, and never
 * reconciles them silently.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * OTHER DECISIONS, STATED SO THEY CAN BE ARGUED WITH
 * ═══════════════════════════════════════════════════════════════════════════
 * • invoice_id vs bill_no are different things and get their own columns:
 *   invoice_id = OUR generated PINV-<yyyy>-#### (one per vendor bill, purchases
 *   only — POs and GRNs never mint one). bill_no = the VENDOR's own number.
 *   There is NO third fallback: purchases.invoice_number is not in this schema
 *   (see the note on the PURCHASE branch below). goods_receipt_notes DOES have
 *   an invoice_number — that one is real and is used on the GRN branch.
 * • The 8 per-line charges (discount, cgst, sgst, special_excise_cess,
 *   compensation_cess, tcs, delivery_charges, mrp_round_off) are RECORDED-ONLY.
 *   `value` is the item value and does NOT include them. They are null — not 0
 *   — on PO rows, because purchase_order_items has no such columns at all.
 *   compensation_cess is GST COMPENSATION CESS (the levy under the GST
 *   (Compensation to States) Act — aerated drinks, tobacco). It is NOT
 *   special_excise_cess, which means TGBCL Special Excise Cess everywhere it is
 *   read or labelled, and it is NOT part of the cgst + sgst invariant: it is a
 *   separate levy, never halved, and adding it to that pair would misstate the
 *   GST on a return. It exists on BOTH `purchases` and goods_receipt_note_items,
 *   so it is reported on PURCHASE rows and on GRN rows alike; it stays null on
 *   PO rows, which genuinely have no charge columns.
 *   ITS TAXABLE BASE IS NOT THE GST BASE, and a reader comparing the two
 *   figures on one GRN row will assume it is. GST is charged on the line value
 *   AFTER the discount; compensation cess is charged on the GROSS line value
 *   BEFORE the discount. On 10 kg @ Rs 100 with a Rs 100 discount that is GST
 *   18% on Rs 900 = Rs 162 but cess 12% on Rs 1,000 = Rs 120. The two bases
 *   differ deliberately — do not "reconcile" them, here or at the writers.
 * • GRN qty is quantity_ACCEPTED (what became stock and became a purchases
 *   row), so qty × rate = value holds. quantity_rejected rides in its own
 *   column; received = qty + qty_rejected.
 * • PO rows exclude status draft / cancelled / rejected — a draft was never
 *   placed and a cancelled/rejected order will never be spend. Every other
 *   status is included with the status stamped into `notes`.
 * • raw_materials is LEFT JOINed, not inner JOINed (which /api/reports/purchases
 *   does): a log that silently drops a purchase because its material row was
 *   deleted is a wrong log. Such rows show "(unknown item)".
 * • No outlet scoping, matching the sibling /api/reports/purchases, so the two
 *   reports reconcile.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TOTALS — WHAT MAY BE ADDED, WHAT MAY NOT, AND WHY EACH REFUSAL IS PRINTED
 * ═══════════════════════════════════════════════════════════════════════════
 * The owner asked for a total and never said which one, so BOTH are produced
 * and both are labelled, per source, and never merged into one "Total":
 *
 *   GOODS VALUE  = SUM(value). Goods only — before tax, before every charge.
 *   TOTAL AMOUNT = SUM(value - discount + cgst + sgst + special_excise_cess
 *                      + compensation_cess + tcs + delivery_charges
 *                      + mrp_round_off)
 *                  i.e. the app's OWN per-line total, the identical expression
 *                  /api/grn, /api/purchases and the Purchases page already use.
 *                  Carried per row as `total_amount` so the column and the
 *                  total cannot drift, and so the footer foots the column.
 *
 * Everything above is summed WITHIN ONE SOURCE and never across sources — the
 * double-count in the block at the top of this file is unchanged by any of it.
 *
 * COLUMNS THAT GET NO TOTAL, AND THE REASON THAT SHIPS WITH EACH:
 *   • qty  — every row is in ITS OWN purchase unit. 3 CASE + 12 kg is not 15.
 *   • rate — Rs per purchase unit, and GROSS on GRN rows vs NET on PURCHASE
 *            rows. Summing rates adds prices, not money.
 *   • discount, on PURCHASE rows only — the column is a literal 0 on every row
 *            a receipt wrote (PO receive puts the reduction inside the rate at
 *            receive/route.ts:1080; the ad-hoc GRN writer binds no discount at
 *            all, grn/route.ts:438), so a total of it would read "Rs 0 discount"
 *            on bills that plainly carried one. It IS totalled on the GRN
 *            block, where both writers share one basis (gross value + the real
 *            allocated share). What each PURCHASE row does carry is still
 *            netted off inside Total Amount, and the figure netted is published
 *            as `discount_netted` so the arithmetic on screen always foots.
 * These refusals are DATA, not prose in a component: PURCHASE_LOG_NO_TOTAL_NOTES
 * ships on every payload so the screen and the CSV state them identically.
 *
 * KNOWN, DISCLOSED IMPRECISION (a writer defect, not a reporting choice): an
 * ad-hoc GRN mirrors GROSS value into `purchases` and copies no discount, so
 * Total Amount on those PURCHASE rows is high by the discount their GRN line
 * records. The GRN block states that discount in full. Fixing it means changing
 * grn/route.ts, which this report does not own.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠ GOODS VALUE ON PURCHASE ROWS IS NOT RELIABLY TAX-EXCLUSIVE — READ BEFORE
 *   TRUSTING A GOODS VALUE OR TOTAL AMOUNT FIGURE ON A PURCHASE ROW
 * ═══════════════════════════════════════════════════════════════════════════
 * `value` on the PURCHASE branch is `COALESCE(p.total_price, p.quantity *
 * p.unit_price)`. That column is supposed to hold the GOODS figure only. It
 * does not, for a large share of the table: the bulk inward-import path (see
 * src/app/api/inward-import/commit/route.ts:214-219, whose own comment
 * documents the fix) used to bind `total_price` from the vendor sheet's
 * TAX-INCLUSIVE total instead of quantity × rate, and no CGST/SGST split was
 * ever recorded for those rows. That binding is now fixed for NEW rows, but
 * nothing backfilled the ones already written — measured on the full table:
 * 2,165 PURCHASE rows total, 2,118 of them from that import path (April 2026),
 * SUM(total_price) = Rs 6,926,866.40 vs SUM(quantity × unit_price) =
 * Rs 6,770,245.24 — a Rs 156,621.16 gap that is tax sitting inside a column
 * labelled "goods only, before tax".
 *
 * Because those same rows carry cgst = sgst = 0 (never split out), TOTAL
 * AMOUNT — goods value + tax — computes to the exact SAME number as GOODS
 * VALUE for them. The two figures this report exists to keep apart are, on
 * the owner's most likely view, identical, and the tax is inside both.
 *
 * A SECOND, separate effect on PURCHASE rows created by receiving a GRN: those
 * rows carry no GST/cess/TCS/round-off of their own (the tax lives only on
 * the GRN line, per the "RATES" section above), so TOTAL AMOUNT on a mirrored
 * PURCHASE row reads goods value only — measured on the mirrored lines in this
 * database at roughly 17.6% LOW against the true GRN bill. For those
 * deliveries the GRN block's own Total Amount is the trustworthy figure, not
 * the PURCHASE mirror.
 *
 * THIS IS A DATA PROBLEM, NOT A DISPLAY BUG, and re-deriving the contaminated
 * rows is a separate, unapproved job. `goods_value_tax_suspect` /
 * `goods_value_tax_suspect_lines` on PurchaseLogSourceMoney and
 * `PurchaseLogTotals.goods_value_caveat` exist so this report SURFACES the
 * problem, quantified for whatever window is on screen, rather than hiding it
 * behind a total that foots to the paisa and is still wrong. Render
 * `goods_value_caveat` verbatim, prominently, wherever GOODS VALUE or TOTAL
 * AMOUNT is shown — screen and download alike.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types (the route and the page import these — keep the shape stable)
// ─────────────────────────────────────────────────────────────────────────────

export type PurchaseLogSource = 'PURCHASE' | 'PO' | 'GRN';

/** ?source= filter values accepted on the wire. */
export type PurchaseLogSourceFilter = 'all' | 'purchase' | 'po' | 'grn';

export interface PurchaseLogRow {
  /** Which table this row came from. Rows are NEVER additive across sources. */
  source: PurchaseLogSource;
  /** YYYY-MM-DD (IST calendar date as stored). */
  date: string;
  /** PINV-… / PO-… / GRN-… — the document this line sits on. */
  doc_no: string;
  /** OUR number (PINV-yyyy-####). Purchases only; '' on PO/GRN rows. */
  invoice_id: string;
  /** The VENDOR'S own bill number. Never conflate with invoice_id. */
  bill_no: string;
  vendor: string;
  material: string;
  sku: string;
  category: string;
  /** ALREADY in purchase units — never multiplied by pack_size. */
  qty: number;
  purchase_unit: string;
  /** ₹ per PURCHASE unit. GROSS on GRN rows, NET of discount on PURCHASE rows. */
  rate: number;
  /** qty × rate. Excludes the 8 recorded-only charges below. */
  value: number;
  /**
   * THE BILL FIGURE for this line: value − discount + cgst + sgst
   * + special_excise_cess + compensation_cess + tcs + delivery_charges
   * + mrp_round_off — the same expression /api/grn, /api/purchases and the
   * Purchases page use, so this report foots against them.
   *
   * null on PO rows, and null rather than 0 deliberately: purchase_order_items
   * has no charge columns at all, so an ordered line has a goods value and no
   * bill amount. A 0 there would assert "this order will cost nothing extra".
   */
  total_amount: number | null;
  /** GRN rows only (units turned away at QC); null on PURCHASE/PO rows. */
  qty_rejected: number | null;
  // ── Recorded-only charges. null on PO rows (no such columns exist there).
  discount: number | null;
  cgst: number | null;
  sgst: number | null;
  special_excise_cess: number | null;
  /**
   * GST compensation cess. PURCHASE and GRN rows — null on PO rows.
   * Charged on the GROSS line value, BEFORE discount — NOT on the
   * post-discount base cgst/sgst use. See the header note.
   */
  compensation_cess: number | null;
  tcs: number | null;
  delivery_charges: number | null;
  mrp_round_off: number | null;
  /** "<grn_number>#<material_id>" — the one receipt event behind up to 3 rows. */
  link_key: string | null;
  notes: string;
}

/**
 * One source's money, totalled over the FULL filtered set (never the capped
 * rows). Every figure is in rupees and every one of them is a total of ONE
 * basis — nothing here may be added to the same field of another source.
 *
 * `null` means "deliberately not totalled", never "zero". Two cases produce it:
 *   • the whole PO block, which has no charge columns to total, and
 *   • `discount` on PURCHASE, where a 0 means three different things.
 * The reason for every null ships beside it in PURCHASE_LOG_NO_TOTAL_NOTES.
 */
export interface PurchaseLogSourceMoney {
  source: PurchaseLogSource;
  lines: number;
  /** SUM(value). Goods only — before tax, before every charge, before discount. */
  goods_value: number;
  /** SUM(discount). null on PURCHASE — see the note; totalled on GRN. */
  discount: number | null;
  /**
   * What was ACTUALLY deducted inside bill_amount on this source. Published
   * even where `discount` is refused, so goods_value − discount_netted + tax
   * + other_charges always re-adds to bill_amount on screen and in the file.
   * It is the deduction, NOT a statement of discount received.
   */
  discount_netted: number;
  cgst: number | null;
  sgst: number | null;
  /**
   * cgst + sgst — the house invariant tax_value = cgst + sgst. Compensation
   * cess is NOT in here: different levy, different taxable base (gross, before
   * discount), never halved, and folding it in would misstate a GST return.
   */
  tax_cgst_sgst: number | null;
  special_excise_cess: number | null;
  compensation_cess: number | null;
  tcs: number | null;
  delivery_charges: number | null;
  /** Signed — a bill can round down. */
  mrp_round_off: number | null;
  /** special_excise_cess + compensation_cess + tcs + delivery + round-off. */
  other_charges: number | null;
  /**
   * THE bill total: goods_value − discount_netted + tax_cgst_sgst
   * + other_charges. null on PO (an order is not a bill).
   */
  bill_amount: number | null;
  /**
   * SUM(value) − SUM(quantity × rate) for THIS source, over this window.
   * Should be 0 — `value` IS quantity × rate (or falls back to it) on every
   * branch. Nonzero means the stored value disagrees with the line's own
   * quantity × rate. The known cause, on PURCHASE, is `total_price` written
   * by the pre-fix inward-import path (see the file header) — never 0 on its
   * own, always the tax/charges sitting inside a "goods value" that should
   * not contain them. Real for GRN/PO too if it ever appears there, by the
   * same arithmetic — nothing here is source-specific except the known cause.
   */
  goods_value_tax_suspect: number;
  /** Lines behind goods_value_tax_suspect — value ≠ quantity × rate (2dp). */
  goods_value_tax_suspect_lines: number;
}

/** A column left without a total on purpose, and the reason, shipped as data. */
export interface PurchaseLogNoTotalNote {
  /** Column heading as the reader sees it. */
  column: string;
  /** One or two sentences. Render VERBATIM — a silent omission is the bug. */
  reason: string;
}

/**
 * Printed under every totals block, on screen and in the CSV alike. A column
 * with no total must SAY it has no total and why; a reader who cannot find a
 * figure assumes the report lost it, and then adds the wrong column instead.
 */
export const PURCHASE_LOG_NO_TOTAL_NOTES: PurchaseLogNoTotalNote[] = [
  {
    column: 'Qty',
    reason:
      'No total. Every line is in its own purchase unit — cases, bottles, kg, litres — so '
      + 'adding them gives a number with no unit. Total by item, or filter to one item.',
  },
  {
    column: 'Rate',
    reason:
      'No total. A rate is rupees PER purchase unit, and the same delivery carries two of them: '
      + 'GRN rows hold the vendor’s gross rate, PURCHASE rows the rate net of the allocated '
      + 'discount. Adding rates adds prices, not money.',
  },
  {
    column: 'Discount (on PURCHASE rows)',
    reason:
      'No total on the PURCHASE block. That column is a literal 0 on every row a receipt wrote — '
      + 'a PO receive puts the reduction inside the rate, and the ad-hoc GRN writer copies no '
      + 'discount at all — so a total would read ₹0 discount on bills that plainly carried one. '
      + 'It IS totalled on the GRN block, where every row shares one basis. Whatever a PURCHASE row '
      + 'does record is still netted off inside Total Amount, and that deduction is shown.',
  },
  {
    column: 'Every charge column, across sources (discount, delivery, CGST, SGST, cess, excise, TCS, round-off)',
    reason:
      'These are BILL-level figures split across the lines of one bill, so they total correctly '
      + 'inside a single source and only there. A GRN receipt writes the SAME allocated figure '
      + 'onto both the GRN line and the purchases row mirroring it, so the PURCHASE block and the '
      + 'GRN block state ONE payment twice — never add a figure from one to the same figure in '
      + 'the other. This used to be true of Discount and Delivery alone, because those were the '
      + 'only charges a GRN-mirrored purchases row carried; every GRN writer now mirrors all '
      + 'eight, so the whole set is duplicated across the two blocks and the whole set is listed '
      + 'here. Read one block or the other for a bill total, never the sum.',
  },
  {
    column: 'Compensation Cess',
    reason:
      'Totalled on its own line and never folded into CGST + SGST. It is a separate levy on a '
      + 'different base — the gross line value, before discount, where GST is charged after it — '
      + 'so the two will not agree with each other’s rate arithmetic, and they are not meant to.',
  },
  {
    column: 'Total Amount (on PO rows)',
    reason:
      'Blank, not zero. purchase_order_items stores no charge columns at all, so an ordered line '
      + 'has a goods value and no bill amount until the delivery is received and billed.',
  },
  {
    column: 'All three sources together',
    reason:
      'There is no grand total and there never will be. Receiving a PO writes a GRN line AND the '
      + 'purchases row mirroring it, so PURCHASE + GRN + PO reads roughly double the real spend. '
      + 'Spend = the PURCHASE totals. Use the Link key to see the same delivery on two rows.',
  },
];

export interface PurchaseLogTotals {
  /** Rows matching the filters BEFORE any truncation. */
  lines: number;
  /**
   * SPEND. This is the only figure that equals money booked against cost —
   * `purchases` is the table every cost report and the weighted-average price
   * read back. Do not add the two below to it.
   */
  purchase_value: number;
  /**
   * ORDERED, not spent. A commitment on purchase_order_items; the matching
   * spend, once received, is already inside purchase_value.
   */
  po_value: number;
  /**
   * BILLED at gross bill rates. The SAME money as the mirrored part of
   * purchase_value, restated as the vendor's document states it.
   */
  grn_value: number;
  // ── Additive detail (beyond the agreed four) — this is what makes the
  //    double-count arithmetic checkable instead of a claim in a header.
  purchase_lines: number;
  po_lines: number;
  grn_lines: number;
  /** Part of purchase_value that is a mirror of a GRN line (link_key set). */
  purchase_value_mirrored_from_grn: number;
  /** Part of purchase_value entered directly, with no GRN behind it. */
  purchase_value_direct: number;
  /**
   * Plain-English statement of what may and may not be added. Render this
   * verbatim next to any total; it is the guard against the one misreading
   * that matters.
   */
  basis: string;
  /**
   * The full money breakdown, PER SOURCE. `money.PURCHASE.goods_value` is the
   * same figure as `purchase_value` above (kept, so nothing that reads the old
   * shape breaks); everything else here is new. Always all three keys, so a
   * consumer can render a block per source without existence checks — a source
   * the filter excluded reads 0 lines / 0 goods value.
   */
  money: Record<PurchaseLogSource, PurchaseLogSourceMoney>;
  /** Why the columns that have no total have none. Render verbatim. */
  no_total_notes: PurchaseLogNoTotalNote[];
  /**
   * ⚠ Render verbatim, prominently, wherever GOODS VALUE or TOTAL AMOUNT is
   * shown — screen and CSV alike. Explains why GOODS VALUE on PURCHASE rows
   * is not reliably tax-exclusive (see the file header), then states the
   * LIVE figure for the window actually being viewed — computed once, here,
   * so every consumer shows the identical words and the identical number
   * instead of two hand-written copies drifting apart.
   */
  goods_value_caveat: string;
}

export interface PurchaseLogResult {
  rows: PurchaseLogRow[];
  totals: PurchaseLogTotals;
  /** true when `lines` exceeded PURCHASE_LOG_MAX_ROWS and rows were capped. */
  truncated: boolean;
  from: string;
  to: string;
}

export interface PurchaseLogFilters {
  from?: string | null;
  to?: string | null;
  vendor?: string | null;
  material_id?: string | null;
  source?: PurchaseLogSourceFilter | null;
}

/**
 * Hard cap on returned rows. A silently truncated report is a wrong report, so
 * `truncated` is reported alongside and `totals` are computed by SQL aggregate
 * over the FULL filtered set — the cap never distorts a number.
 */
export const PURCHASE_LOG_MAX_ROWS = 50_000;

const TOTALS_BASIS =
  'PURCHASE = money booked (the spend). GRN = the same money restated at gross bill rates. '
  + 'PO = ordered, not spent. These three DO NOT add up — adding them roughly doubles the spend.';

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const isYmd = (s: unknown): s is string => typeof s === 'string' && YMD.test(s);
const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const nullNum = (v: unknown): number | null =>
  v === null || v === undefined ? null : (Number.isFinite(Number(v)) ? r2(Number(v)) : null);

/**
 * Calendar arithmetic on a YYYY-MM-DD string via UTC, deliberately.
 * `new Date('2026-08-02')` parses as UTC midnight and then renders in the
 * server's local zone, which lands on the previous day west of Greenwich —
 * that is how a "last 30 days" default silently becomes 29 or 31.
 */
function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

/**
 * Resolve the requested window, defaulting to the last 30 days INCLUSIVE of
 * today in IST (today − 29 … today). Invalid or missing values fall back to
 * the default rather than throwing, and a reversed range is swapped — a report
 * that returns nothing because from > to looks identical to "no purchases".
 */
export function resolvePurchaseLogRange(
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
 * Pull "GRN-yyyy-####" out of the tail SQL handed us (the substring of
 * purchases.notes starting at the first 'GRN-'). Anchored, so an unrelated note
 * that merely mentions GRN cannot fabricate a link.
 */
const GRN_TOKEN = /^(GRN-\d{4}-\d+)/;
function grnFromNoteTail(tail: unknown): string | null {
  const m = GRN_TOKEN.exec(String(tail || '').trim());
  return m ? m[1] : null;
}

/** null → 0, for the one place a charge is ADDED rather than reported. */
const n0 = (v: number | null | undefined): number => (v == null ? 0 : v);

/**
 * The per-line bill figure. ONE definition, used for the row column and (as the
 * identical SQL expression in the aggregate) for the totals, so the footer
 * always foots the column it sits under.
 *
 * Identical in shape to /api/grn's register formula, /api/purchases' total and
 * the Purchases page's line total — this report must reconcile with all three.
 * PO rows get null: purchase_order_items carries no charge columns, so an order
 * has a goods value and no bill amount.
 */
function lineTotalAmount(r: {
  source: PurchaseLogSource; value: number;
  discount: number | null; cgst: number | null; sgst: number | null;
  special_excise_cess: number | null; compensation_cess: number | null;
  tcs: number | null; delivery_charges: number | null; mrp_round_off: number | null;
}): number | null {
  if (r.source === 'PO') return null;
  return r2(
    r.value - n0(r.discount) + n0(r.cgst) + n0(r.sgst)
    + n0(r.special_excise_cess) + n0(r.compensation_cess)
    + n0(r.tcs) + n0(r.delivery_charges) + n0(r.mrp_round_off),
  );
}

/** A source with nothing in it. Zero lines and zero goods — never a fake total. */
function emptyMoney(source: PurchaseLogSource): PurchaseLogSourceMoney {
  const noCharges = source === 'PO';
  return {
    source,
    lines: 0,
    goods_value: 0,
    // PURCHASE refuses a discount total by basis, PO by having no column at all.
    discount: source === 'PURCHASE' || noCharges ? null : 0,
    discount_netted: 0,
    cgst: noCharges ? null : 0,
    sgst: noCharges ? null : 0,
    tax_cgst_sgst: noCharges ? null : 0,
    special_excise_cess: noCharges ? null : 0,
    compensation_cess: noCharges ? null : 0,
    tcs: noCharges ? null : 0,
    delivery_charges: noCharges ? null : 0,
    mrp_round_off: noCharges ? null : 0,
    other_charges: noCharges ? null : 0,
    bill_amount: noCharges ? null : 0,
    goods_value_tax_suspect: 0,
    goods_value_tax_suspect_lines: 0,
  };
}

/**
 * The static half of PurchaseLogTotals.goods_value_caveat — the explanation,
 * unchanging across every request. See the file header for the measurement
 * behind each sentence. Kept short enough to sit as one on-screen banner and
 * one CSV caption row without wrapping into an essay.
 */
const GOODS_VALUE_CAVEAT_HEADLINE =
  'GOODS VALUE is NOT reliably tax-exclusive on PURCHASE rows. A large share of purchase rows '
  + '(bulk-imported in April 2026) had the vendor’s tax-INCLUSIVE bill total written into the '
  + 'same column this report reads as "goods value", with no CGST/SGST split recorded and no '
  + 'backfill since. On those rows GOODS VALUE and TOTAL AMOUNT print the IDENTICAL number, and '
  + 'that number still has tax hidden inside it — do not treat GOODS VALUE as pre-tax spend '
  + 'without checking further. Separately, and now HISTORICAL ONLY: PURCHASE rows created by '
  + 'receiving a GRN used to carry no GST/cess/TCS/round-off of their own, so their TOTAL AMOUNT '
  + 'read roughly 17.6% LOW against the true GRN bill. Every GRN writer now mirrors all eight '
  + 'charge columns — ad-hoc receipt, QC sign-off and amendment alike — so rows recorded from '
  + 'that change onward reconcile to the paisa against their GRN, and the PURCHASE row is the '
  + 'one to trust. OLDER GRN-mirrored rows are still thin, and they are NOT being rewritten. '
  + 'This is a data problem, not a display bug; it is disclosed here, not fixed here.';

/**
 * The live half — how much of THIS filtered window is affected, not just that
 * the problem exists somewhere in the table. `0 affected lines` is reported
 * honestly too: it means this window happens to be clean, not that the wider
 * table is.
 */
function goodsValueCaveatDetail(m: PurchaseLogSourceMoney): string {
  if (m.lines === 0) return 'No PURCHASE lines in this window.';
  const plural = m.lines === 1 ? '' : 's';
  if (m.goods_value_tax_suspect_lines === 0) {
    return `In THIS window: all ${m.lines} PURCHASE line${plural} have GOODS VALUE = quantity × rate `
      + '— no sign of the import contamination in this filter (the issue is still real elsewhere '
      + 'in the table; it simply is not present here).';
  }
  const amt = m.goods_value_tax_suspect.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const lp = m.goods_value_tax_suspect_lines === 1 ? '' : 's';
  return `In THIS window: ${m.goods_value_tax_suspect_lines} of ${m.lines} PURCHASE line${lp} have a `
    + `GOODS VALUE that does not equal quantity × rate — Rs ${amt} of tax/charges is sitting `
    + 'inside GOODS VALUE (and therefore inside TOTAL AMOUNT too) on those lines.';
}

// ─────────────────────────────────────────────────────────────────────────────
// The query
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every branch of the UNION must project the SAME columns in the SAME order —
 * SQLite matches compound SELECTs positionally, so a column added to one branch
 * and not the others silently shifts every value to its right.
 *
 * SHAPE / EFFICIENCY. One compound SELECT, wrapped once for the ordered+capped
 * row fetch and once for the GROUP BY totals. Each branch is driven by its
 * table's indexed date column (idx_purchases_date, idx_po_date, idx_grn_date),
 * so the range — not the table size — bounds the scan. The only lookups that
 * are not a plain index seek are two CORRELATED SCALAR subqueries on the PO and
 * GRN branches; both start from idx_po_vendor_bills_po / idx_grn_po, i.e. the
 * handful of bills or GRNs belonging to ONE po_id, then idx_grni_grn inside it.
 * That keeps them O(receipts-of-this-PO) per row instead of the full scan a
 * LEFT JOIN on the unindexed goods_receipt_note_items.po_item_id would cost —
 * and, being scalar, they cannot fan a PO line into one row per GRN the way a
 * multi-vendor PO would with a join.
 */
function buildUnion(f: {
  from: string; to: string; vendor: string; materialId: string; source: PurchaseLogSourceFilter;
}): { sql: string; params: any[] } {
  const parts: string[] = [];
  const params: any[] = [];
  const want = (s: PurchaseLogSourceFilter) => f.source === 'all' || f.source === s;

  // Shared fragments. Bound per-branch (each takes its own copy of the params).
  const matFilter = (col: string) => (f.materialId ? ` AND ${col} = ?` : '');
  // CONTAINS, not equality. The filter on screen is a free-text box with a
  // datalist, and a datalist constrains nothing — typing "Metro" against a
  // stored "Metro Cash & Carry Pvt Ltd" matched zero rows and the page rendered
  // three Rs 0 totals. A silent wrong answer is worse than an error, and worse
  // than a slightly loose match.
  const venFilter = (expr: string) => (f.vendor ? ` AND LOWER(TRIM(${expr})) LIKE '%' || LOWER(TRIM(?)) || '%'` : '');

  // ── PURCHASE ──────────────────────────────────────────────────────────────
  if (want('purchase')) {
    parts.push(`
      SELECT
        'PURCHASE'                                        AS source,
        3                                                 AS source_rank,
        p.id                                              AS row_id,
        COALESCE(p.material_id, '')                       AS material_id,
        p.date                                            AS date,
        -- DO NOT add p.invoice_number back as a fallback here. That column is
        -- NOT part of this schema: CREATE TABLE purchases never declares it
        -- and no ALTER adds it, unlike the eight columns that are migrated at
        -- db.ts:2134-2155. Databases that happen to carry it got it out of band,
        -- and it is empty in every row even there — so referencing it bought
        -- nothing and made this whole report a hard 500 ("no such column:
        -- p.invoice_number") on any database without it. The vendor's own
        -- number lives in p.bill_no; ours is p.invoice_id.
        COALESCE(NULLIF(TRIM(p.invoice_id), ''),
                 NULLIF(TRIM(p.bill_no), ''), '')         AS doc_no,
        COALESCE(TRIM(p.invoice_id), '')                  AS invoice_id,
        COALESCE(TRIM(p.bill_no), '')                     AS bill_no,
        COALESCE(TRIM(p.vendor), '')                      AS vendor,
        COALESCE(rm.name, '(unknown item)')               AS material,
        COALESCE(rm.sku, '')                              AS sku,
        COALESCE(rm.category, '')                         AS category,
        p.quantity                                        AS qty,
        COALESCE(NULLIF(rm.purchase_unit, ''), rm.unit, '') AS purchase_unit,
        p.unit_price                                      AS rate,
        COALESCE(p.total_price, p.quantity * p.unit_price) AS value,
        NULL                                              AS qty_rejected,
        -- ALIASED EXPLICITLY, all eight. The totals aggregate below reads these
        -- names from OUTSIDE this subquery (SUM(discount), SUM(cgst), and so
        -- on), and a bare p.discount leaves the projected name to SQLite's
        -- short_column_names setting rather than to this file. Naming them here
        -- makes the charge totals independent of a compile-time pragma.
        -- NOTE: no backticks anywhere inside this SQL — the whole statement is a
        -- JS template literal, so one would end the string mid-query.
        p.discount AS discount, p.cgst AS cgst, p.sgst AS sgst,
        p.special_excise_cess AS special_excise_cess,
        -- GST compensation cess. A DIFFERENT levy from special_excise_cess
        -- (which is TGBCL's) and deliberately outside the cgst + sgst pair —
        -- it is never split into halves and must not be folded into the GST
        -- figure a return is filed on. Recorded-only, like its 7 siblings.
        p.compensation_cess AS compensation_cess,
        p.tcs AS tcs, p.delivery_charges AS delivery_charges,
        p.mrp_round_off AS mrp_round_off,
        -- Tail of the note starting at the GRN number, if any. The regex that
        -- turns this into a link_key lives in JS; SQLite has no REGEXP here.
        CASE WHEN instr(COALESCE(p.notes, ''), 'GRN-') > 0
             THEN substr(p.notes, instr(p.notes, 'GRN-'))
             ELSE '' END                                  AS link_raw,
        -- MUST agree with grnFromNoteTail()'s anchored /^GRN-\d{4}-\d+/ regex.
        -- A bare instr(notes,'GRN-') also matched a free-text note that merely
        -- mentions a GRN, so a purchase counted as "mirrored from a GRN" while
        -- link_key stayed null — money moved between
        -- purchase_value_mirrored_from_grn and _direct with nothing tying it to
        -- a receipt. GLOB gives the same digit-shape test SQLite-side.
        CASE WHEN COALESCE(p.notes, '') GLOB '*GRN-[0-9][0-9][0-9][0-9]-[0-9]*'
             THEN 1 ELSE 0 END AS is_mirror,
        COALESCE(p.notes, '')                             AS notes
      FROM purchases p
      LEFT JOIN raw_materials rm ON rm.id = p.material_id
      WHERE p.date >= ? AND p.date <= ?${venFilter('p.vendor')}${matFilter('p.material_id')}
    `);
    params.push(f.from, f.to);
    if (f.vendor) params.push(f.vendor);
    if (f.materialId) params.push(f.materialId);
  }

  // ── GRN ───────────────────────────────────────────────────────────────────
  if (want('grn')) {
    parts.push(`
      SELECT
        'GRN'                                             AS source,
        2                                                 AS source_rank,
        gi.id                                             AS row_id,
        COALESCE(gi.material_id, '')                      AS material_id,
        g.date                                            AS date,
        g.grn_number                                      AS doc_no,
        ''                                                AS invoice_id,
        -- The GRN header carries the bill number on both writers; po_vendor_bills
        -- is the fallback for older PO receives that left invoice_number blank.
        COALESCE(NULLIF(TRIM(g.invoice_number), ''),
                 (SELECT TRIM(b.bill_no) FROM po_vendor_bills b
                   WHERE b.po_id = g.po_id
                     AND LOWER(TRIM(b.vendor_name)) = LOWER(TRIM(COALESCE(g.vendor, '')))
                   ORDER BY b.created_at LIMIT 1), '')    AS bill_no,
        COALESCE(TRIM(g.vendor), '')                      AS vendor,
        COALESCE(rm.name, '(unknown item)')               AS material,
        COALESCE(rm.sku, '')                              AS sku,
        COALESCE(rm.category, '')                         AS category,
        -- ACCEPTED, not received: this is the qty that became stock and became
        -- the mirrored purchases row, so qty × rate = value holds.
        gi.quantity_accepted                              AS qty,
        COALESCE(NULLIF(rm.purchase_unit, ''), rm.unit, '') AS purchase_unit,
        gi.unit_price                                     AS rate,
        ROUND(gi.quantity_accepted * gi.unit_price, 2)    AS value,
        gi.quantity_rejected                              AS qty_rejected,
        -- Aliased for the same reason as the PURCHASE branch: the totals
        -- aggregate SUMs these by name from outside the subquery.
        gi.discount AS discount, gi.cgst AS cgst, gi.sgst AS sgst,
        gi.special_excise_cess AS special_excise_cess,
        -- GST compensation cess, now REAL on this branch: the GRN item carries
        -- its own compensation_cess column and PO Receive / ad-hoc GRN book the
        -- levy onto the GRN line (the bill document), not onto the tax-free
        -- purchases mirror. Reporting NULL here printed a blank for a cess
        -- that was actually levied and stored.
        -- ITS BASE IS NOT THE GST BASE, and the two sit side by side on this
        -- row: gi.cgst/gi.sgst are charged on the line value AFTER discount,
        -- gi.compensation_cess on the GROSS line value BEFORE it. They will not
        -- agree with each other's rate arithmetic and are not meant to.
        -- Aliased explicitly — with ?source=grn this branch is the FIRST of the
        -- compound SELECT and its names become the outer SELECT *'s names.
        gi.compensation_cess AS compensation_cess,
        gi.tcs AS tcs, gi.delivery_charges AS delivery_charges,
        gi.mrp_round_off AS mrp_round_off,
        g.grn_number                                      AS link_raw,
        0                                                 AS is_mirror,
        COALESCE(NULLIF(TRIM(gi.notes), ''), TRIM(COALESCE(g.notes, ''))) AS notes
      FROM goods_receipt_note_items gi
      JOIN goods_receipt_notes g ON g.id = gi.grn_id
      LEFT JOIN raw_materials rm ON rm.id = gi.material_id
      WHERE g.date >= ? AND g.date <= ?
        -- A VOIDED bill is money that was NOT spent. Voiding a GRN reverses the
        -- stock it added and DELETES its purchases rows, so it already leaves
        -- the PURCHASE branch on its own — but its goods_receipt_note_items are
        -- kept (they are the document) and this branch reads them, so the same
        -- delivery counted on one rail and not the other. That gave two answers
        -- for one bill on the GOODS VALUE vs TOTAL AMOUNT split, and made the
        -- GRN↔PURCHASE reconciliation report it as billed-but-never-booked,
        -- which is indistinguishable from a genuine missing-cost-row defect.
        -- Stronger than the PO branch's own exclusion below: a cancelled order
        -- was never received, a voided GRN was received and then undone.
        --
        -- 'awaiting_qc' IS EXCLUDED FOR THE SAME REASON, AND IT IS NOT OPTIONAL.
        -- A GRN held for a kitchen quality check (src/lib/grn-qc.ts) carries
        -- quantity_accepted = 0 on every line — the ABSENCE of a decision, not a
        -- rejection — while its cgst / sgst / cess / tcs / delivery_charges are
        -- stored in full, because the store may not pre-reject a gated line. So
        -- the row valued GOODS VALUE at ₹0 and still summed the whole bill's tax
        -- into TOTAL AMOUNT: a ₹4,000 delivery at 5% with ₹200 delivery reported
        -- ₹0 of goods carrying ₹400 of charges, and NEGATIVE with a bill
        -- discount. The report's own integrity check cannot catch it either —
        -- goods_value_tax_suspect compares value against qty × rate, and 0 − 0×r
        -- is 0, so the guard stays silent on the one shape it should shout at.
        -- Excluding it also keeps the two rails AGREEING: a held GRN has no
        -- purchases row yet, so leaving it on this branch alone reported the
        -- delivery as billed-but-never-booked, which is indistinguishable from a
        -- genuine missing-cost-row defect. It appears here in full the moment the
        -- kitchen signs, dated the delivery day — see the hand-over note about a
        -- bill landing inside a period that may already have been downloaded.
        AND COALESCE(g.status, '') NOT IN ('void', 'awaiting_qc')
        ${venFilter('g.vendor')}${matFilter('gi.material_id')}
    `);
    params.push(f.from, f.to);
    if (f.vendor) params.push(f.vendor);
    if (f.materialId) params.push(f.materialId);
  }

  // ── PO ────────────────────────────────────────────────────────────────────
  if (want('po')) {
    parts.push(`
      SELECT
        'PO'                                              AS source,
        1                                                 AS source_rank,
        poi.id                                            AS row_id,
        COALESCE(poi.material_id, '')                     AS material_id,
        po.date                                           AS date,
        po.po_number                                      AS doc_no,
        ''                                                AS invoice_id,
        COALESCE((SELECT TRIM(b.bill_no) FROM po_vendor_bills b
                   WHERE b.po_id = po.id
                     AND LOWER(TRIM(b.vendor_name)) =
                         LOWER(TRIM(COALESCE(NULLIF(TRIM(poi.vendor), ''), po.vendor, '')))
                   ORDER BY b.created_at LIMIT 1), '')    AS bill_no,
        COALESCE(NULLIF(TRIM(poi.vendor), ''), TRIM(COALESCE(po.vendor, '')), '') AS vendor,
        COALESCE(rm.name, '(unknown item)')               AS material,
        COALESCE(rm.sku, '')                              AS sku,
        COALESCE(rm.category, '')                         AS category,
        poi.quantity                                      AS qty,
        COALESCE(NULLIF(rm.purchase_unit, ''), rm.unit, '') AS purchase_unit,
        poi.unit_price                                    AS rate,
        COALESCE(poi.total_price, poi.quantity * poi.unit_price) AS value,
        NULL                                              AS qty_rejected,
        -- purchase_order_items has NO charge columns. NULL, not 0: an order
        -- carries no bill charges, it is not "a bill with zero charges".
        -- Aliased explicitly — with ?source=po this branch is the FIRST of the
        -- compound SELECT and its names become the outer SELECT *'s names.
        NULL AS discount, NULL AS cgst, NULL AS sgst,
        NULL AS special_excise_cess, NULL AS compensation_cess, NULL AS tcs,
        NULL AS delivery_charges, NULL AS mrp_round_off,
        -- The GRN this ordered line was received on, via po_item_id. NULL until
        -- it is received (or when the receipt fell outside this date window).
        --
        -- THROUGH claimJoin(), WHICH IS THE POINT. This was the eighth copy of
        -- the PO↔GRN claim derivation and the only one left unfiltered after
        -- src/lib/po-receipts.ts collected the rest. A voided GRN keeps its line
        -- rows, and the ORDER BY ... LIMIT 1 below picks the OLDEST — which after
        -- a void-and-re-receive is ALWAYS the voided one. Measured: a PO line
        -- voided on GRN-2026-0001 and re-received as GRN-2026-0030 reported
        -- GRN-2026-0001, a bill the GRN branch above already excludes, so the
        -- ordered line was grouped with a receipt event that has no other rows
        -- and separated from the delivery it actually arrived on. link_raw
        -- becomes link_key below and is the report's whole reconciliation
        -- promise. Money was never affected — the PO branch's value column is
        -- the ORDERED value — but the link was pointing at a dead row.
        COALESCE((SELECT g2.grn_number
                    FROM goods_receipt_note_items gi2
                    ${claimJoin({ grn: 'g2', item: 'gi2', poIdCol: 'po.id' })}
                   WHERE gi2.po_item_id = poi.id
                   ORDER BY g2.date LIMIT 1), '')         AS link_raw,
        0                                                 AS is_mirror,
        -- Status is stamped in because a PO row is a COMMITMENT, and whether it
        -- is still pending or already received changes what the line means.
        TRIM('PO ' || COALESCE(po.status, '')
             || CASE WHEN TRIM(COALESCE(poi.notes, '')) <> ''
                     THEN ' · ' || TRIM(poi.notes) ELSE '' END) AS notes
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.po_id
      LEFT JOIN raw_materials rm ON rm.id = poi.material_id
      WHERE po.date >= ? AND po.date <= ?
        -- A draft was never placed; a cancelled/rejected order will never be
        -- spend. Including them would inflate po_value with money nobody owes.
        AND COALESCE(po.status, '') NOT IN ('draft', 'cancelled', 'rejected')
        ${venFilter("COALESCE(NULLIF(TRIM(poi.vendor), ''), po.vendor, '')")}${matFilter('poi.material_id')}
    `);
    params.push(f.from, f.to);
    if (f.vendor) params.push(f.vendor);
    if (f.materialId) params.push(f.materialId);
  }

  return { sql: parts.join('\nUNION ALL\n'), params };
}

/**
 * Build the purchase log for a date range.
 *
 * Caller (the route) is responsible for the management gate — this is a pure
 * query layer and applies no authorisation of its own.
 */
export function getPurchaseLog(
  filters: PurchaseLogFilters = {},
  dbArg?: DatabaseT.Database,
): PurchaseLogResult {
  const db = dbArg || getDb();
  const { from, to } = resolvePurchaseLogRange(filters.from, filters.to);
  const vendor = String(filters.vendor || '').trim();
  const materialId = String(filters.material_id || '').trim();
  const rawSource = String(filters.source || 'all').toLowerCase();
  const source: PurchaseLogSourceFilter =
    rawSource === 'purchase' || rawSource === 'po' || rawSource === 'grn'
      ? (rawSource as PurchaseLogSourceFilter)
      : 'all';

  const { sql: union, params } = buildUnion({ from, to, vendor, materialId, source });

  const empty: PurchaseLogTotals = {
    lines: 0, purchase_value: 0, po_value: 0, grn_value: 0,
    purchase_lines: 0, po_lines: 0, grn_lines: 0,
    purchase_value_mirrored_from_grn: 0, purchase_value_direct: 0,
    basis: TOTALS_BASIS,
    money: {
      PURCHASE: emptyMoney('PURCHASE'),
      GRN: emptyMoney('GRN'),
      PO: emptyMoney('PO'),
    },
    no_total_notes: PURCHASE_LOG_NO_TOTAL_NOTES,
    goods_value_caveat: `${GOODS_VALUE_CAVEAT_HEADLINE} ${goodsValueCaveatDetail(emptyMoney('PURCHASE'))}`,
  };
  // buildUnion returns '' only if `source` matched nothing, which the
  // normalisation above makes impossible — but an empty compound SELECT is a
  // syntax error, so never hand one to SQLite.
  if (!union) return { rows: [], totals: empty, truncated: false, from, to };

  // ── TOTALS FIRST, over the FULL filtered set ──────────────────────────────
  // Computed by the database, not by summing the (possibly capped) rows, so the
  // cap can never quietly understate the spend.
  // `bill_amount` is SUM(<the per-row expression>), not a combination of the
  // column sums, so it is the same arithmetic in the same order as
  // lineTotalAmount() does per row. Anything else and the footer stops footing
  // the column above it by a paisa or two, which is exactly the kind of drift
  // that makes an owner distrust the whole report.
  const agg = db.prepare(`
    SELECT source,
           COUNT(*)                                                  AS lines,
           COALESCE(SUM(value), 0)                                   AS value,
           COALESCE(SUM(CASE WHEN is_mirror = 1 THEN value ELSE 0 END), 0) AS mirrored,
           COALESCE(SUM(discount), 0)                                AS discount,
           COALESCE(SUM(cgst), 0)                                    AS cgst,
           COALESCE(SUM(sgst), 0)                                    AS sgst,
           COALESCE(SUM(special_excise_cess), 0)                     AS special_excise_cess,
           COALESCE(SUM(compensation_cess), 0)                       AS compensation_cess,
           COALESCE(SUM(tcs), 0)                                     AS tcs,
           COALESCE(SUM(delivery_charges), 0)                        AS delivery_charges,
           COALESCE(SUM(mrp_round_off), 0)                           AS mrp_round_off,
           COALESCE(SUM(
             COALESCE(value, 0) - COALESCE(discount, 0)
             + COALESCE(cgst, 0) + COALESCE(sgst, 0)
             + COALESCE(special_excise_cess, 0) + COALESCE(compensation_cess, 0)
             + COALESCE(tcs, 0) + COALESCE(delivery_charges, 0)
             + COALESCE(mrp_round_off, 0)
           ), 0)                                                     AS bill_amount,
           -- The GOODS VALUE integrity check (see the file header's
           -- GOODS VALUE section): value is SUPPOSED to equal qty x rate
           -- on every branch. qty_rate_value is that expectation, computed
           -- independently of whatever value actually holds, so the gap
           -- between the two columns is measured rather than assumed.
           COALESCE(SUM(COALESCE(qty, 0) * COALESCE(rate, 0)), 0)        AS qty_rate_value,
           COALESCE(SUM(CASE
             WHEN ROUND(COALESCE(value, 0) - COALESCE(qty, 0) * COALESCE(rate, 0), 2) <> 0
             THEN 1 ELSE 0 END), 0)                                  AS value_mismatch_lines
    FROM (${union})
    GROUP BY source
  `).all(...params) as Array<Record<string, number> & { source: string }>;

  const totals: PurchaseLogTotals = {
    ...empty,
    money: {
      PURCHASE: emptyMoney('PURCHASE'),
      GRN: emptyMoney('GRN'),
      PO: emptyMoney('PO'),
    },
  };
  for (const a of agg) {
    if (a.source === 'PURCHASE') {
      totals.purchase_lines = num(a.lines);
      totals.purchase_value = r2(a.value);
      totals.purchase_value_mirrored_from_grn = r2(a.mirrored);
      totals.purchase_value_direct = r2(num(a.value) - num(a.mirrored));
    } else if (a.source === 'PO') {
      totals.po_lines = num(a.lines);
      totals.po_value = r2(a.value);
    } else if (a.source === 'GRN') {
      totals.grn_lines = num(a.lines);
      totals.grn_value = r2(a.value);
    }
    totals.lines += num(a.lines);

    const src = a.source as PurchaseLogSource;
    if (src !== 'PURCHASE' && src !== 'GRN' && src !== 'PO') continue;
    // PO has no charge columns anywhere in its branch (they are bound NULL),
    // so its whole charge block stays null — a 0 would read as "this order
    // carries no tax", which nobody has established yet.
    const noCharges = src === 'PO';
    const other = r2(
      num(a.special_excise_cess) + num(a.compensation_cess)
      + num(a.tcs) + num(a.delivery_charges) + num(a.mrp_round_off),
    );
    totals.money[src] = {
      source: src,
      lines: num(a.lines),
      goods_value: r2(a.value),
      // Refused on PURCHASE by basis (see PURCHASE_LOG_NO_TOTAL_NOTES), refused
      // on PO for want of a column. Real, and one basis, on GRN.
      discount: src === 'GRN' ? r2(a.discount) : null,
      discount_netted: r2(a.discount),
      cgst: noCharges ? null : r2(a.cgst),
      sgst: noCharges ? null : r2(a.sgst),
      tax_cgst_sgst: noCharges ? null : r2(num(a.cgst) + num(a.sgst)),
      special_excise_cess: noCharges ? null : r2(a.special_excise_cess),
      compensation_cess: noCharges ? null : r2(a.compensation_cess),
      tcs: noCharges ? null : r2(a.tcs),
      delivery_charges: noCharges ? null : r2(a.delivery_charges),
      mrp_round_off: noCharges ? null : r2(a.mrp_round_off),
      other_charges: noCharges ? null : other,
      bill_amount: noCharges ? null : r2(a.bill_amount),
      // Independent of noCharges: this checks `value` against the line's own
      // qty × rate, which is meaningful on every source, not only the ones
      // with charge columns.
      goods_value_tax_suspect: r2(num(a.value) - num(a.qty_rate_value)),
      goods_value_tax_suspect_lines: num(a.value_mismatch_lines),
    };
  }

  // ── THE CAVEAT, static explanation + this window's live figure, computed
  //    ONCE so every consumer (CSV, screen) renders the identical string. ──
  totals.goods_value_caveat =
    `${GOODS_VALUE_CAVEAT_HEADLINE} ${goodsValueCaveatDetail(totals.money.PURCHASE)}`;

  // ── ROWS ──────────────────────────────────────────────────────────────────
  // Ordered so ONE receipt event reads as one event: within a day and a vendor,
  // the three faces of the same item sit on consecutive lines in the order they
  // happened — PO (ordered) → GRN (billed) → PURCHASE (booked) — with unlinked
  // direct purchases first.
  //
  // substr(link_raw, 1, 13), not link_raw: on GRN/PO rows link_raw is the bare
  // "GRN-2026-0007" (13 chars) but on a PURCHASE row it is the TAIL of the note,
  // e.g. "GRN-2026-0007)" or "GRN-2026-0007 · invoice 4841". Sorting the raw
  // value puts the booked row after the whole rest of the group instead of
  // beside its own item. The exact key is still link_key, computed below —
  // this substring only drives the grouping of the sort.
  //
  // row_id is the final tie-break so the LIMIT takes a deterministic prefix
  // rather than an arbitrary one.
  const raw = db.prepare(`
    SELECT * FROM (${union})
    ORDER BY date ASC,
             vendor COLLATE NOCASE ASC,
             substr(link_raw, 1, 13) ASC,
             material COLLATE NOCASE ASC,
             source_rank ASC,
             doc_no ASC,
             row_id ASC
    LIMIT ?
  `).all(...params, PURCHASE_LOG_MAX_ROWS) as any[];

  const rows: PurchaseLogRow[] = raw.map((r) => {
    const src = r.source as PurchaseLogSource;
    // PURCHASE rows carry a note TAIL that must be parsed; GRN/PO rows already
    // hold the bare grn_number (or '' when the line was never received).
    const grn = src === 'PURCHASE' ? grnFromNoteTail(r.link_raw) : (String(r.link_raw || '') || null);
    const materialId2 = String(r.material_id ?? '');
    // Charges first — total_amount is derived from these exact values, so the
    // row's own column and the SQL total are the same arithmetic on the same
    // numbers rather than two readings of the database.
    const charges = {
      discount: nullNum(r.discount),
      cgst: nullNum(r.cgst),
      sgst: nullNum(r.sgst),
      special_excise_cess: nullNum(r.special_excise_cess),
      compensation_cess: nullNum(r.compensation_cess),
      tcs: nullNum(r.tcs),
      delivery_charges: nullNum(r.delivery_charges),
      mrp_round_off: nullNum(r.mrp_round_off),
    };
    const value = r2(r.value);
    return {
      source: src,
      date: String(r.date || ''),
      doc_no: String(r.doc_no || ''),
      invoice_id: String(r.invoice_id || ''),
      bill_no: String(r.bill_no || ''),
      vendor: String(r.vendor || ''),
      material: String(r.material || ''),
      sku: String(r.sku || ''),
      category: String(r.category || ''),
      qty: num(r.qty),
      purchase_unit: String(r.purchase_unit || ''),
      rate: num(r.rate),
      value,
      total_amount: lineTotalAmount({ source: src, value, ...charges }),
      qty_rejected: r.qty_rejected == null ? null : num(r.qty_rejected),
      ...charges,
      // Material is part of the key so the PO line, the GRN line and the
      // purchases row of the SAME item pair up, not just the same delivery.
      // (Falls back to the bare GRN number if the material row was purged.)
      link_key: grn ? (materialId2 ? `${grn}#${materialId2}` : grn) : null,
      notes: String(r.notes || '').trim(),
    };
  });

  return { rows, totals, truncated: totals.lines > rows.length, from, to };
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV — shared so the download and the on-screen table cannot drift apart
// ─────────────────────────────────────────────────────────────────────────────

export interface PurchaseLogColumn {
  key: keyof PurchaseLogRow;
  label: string;
  /** Numeric columns skip the spreadsheet-formula guard (it would break "-12.5"). */
  numeric?: boolean;
}

/**
 * ⚠ THIS IS **NOT** THE LIST THE DOWNLOAD USES. The served CSV is built from the
 * COLUMNS array inside src/app/api/reports/purchase-log/route.ts — that one owns
 * the header wording, the totals rows and the caption block. Nothing in src/
 * imports PURCHASE_LOG_COLUMNS, purchaseLogToCsv or purchaseLogFilename today;
 * they are kept only so a second consumer has a plain serialiser to reach for.
 * Editing this array changes nothing the owner will ever open — if you came here
 * to change a download, you are in the wrong file.
 */
export const PURCHASE_LOG_COLUMNS: PurchaseLogColumn[] = [
  { key: 'date',                label: 'Date' },
  { key: 'source',              label: 'Source' },
  { key: 'doc_no',              label: 'Document No' },
  { key: 'invoice_id',          label: 'Invoice ID (ours)' },
  { key: 'bill_no',             label: 'Bill No (vendor)' },
  { key: 'vendor',              label: 'Vendor' },
  { key: 'material',            label: 'Item' },
  { key: 'sku',                 label: 'SKU' },
  { key: 'category',            label: 'Category' },
  { key: 'qty',                 label: 'Qty', numeric: true },
  { key: 'purchase_unit',       label: 'Purchase Unit' },
  { key: 'rate',                label: 'Rate (Rs/purchase unit)', numeric: true },
  { key: 'value',               label: 'Value (Rs)', numeric: true },
  { key: 'total_amount',        label: 'Total Amount (Rs, incl. tax & charges)', numeric: true },
  { key: 'qty_rejected',        label: 'Qty Rejected', numeric: true },
  { key: 'discount',            label: 'Discount', numeric: true },
  { key: 'cgst',                label: 'CGST', numeric: true },
  { key: 'sgst',                label: 'SGST', numeric: true },
  { key: 'special_excise_cess', label: 'Spl Excise Cess', numeric: true },
  { key: 'compensation_cess',   label: 'Compensation Cess', numeric: true },
  { key: 'tcs',                 label: 'TCS', numeric: true },
  { key: 'delivery_charges',    label: 'Delivery Charges', numeric: true },
  { key: 'mrp_round_off',       label: 'MRP Round Off', numeric: true },
  { key: 'link_key',            label: 'Link Key (same receipt)' },
  { key: 'notes',               label: 'Notes' },
];

/**
 * Escape one CSV field. Free-text (vendor, item, notes) gets the leading
 * `=+-@` guard — Excel executes those as formulas, and a vendor name is
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
export function purchaseLogToCsv(rows: PurchaseLogRow[]): string {
  const out: string[] = [PURCHASE_LOG_COLUMNS.map(c => csvCell(c.label, false)).join(',')];
  for (const r of rows) {
    out.push(PURCHASE_LOG_COLUMNS.map(c => csvCell(r[c.key], !!c.numeric)).join(','));
  }
  return out.join('\r\n');
}

/** Filename the download must use: purchase-log-<from>_<to>.csv */
export function purchaseLogFilename(from: string, to: string): string {
  return `purchase-log-${from}_${to}.csv`;
}
