'use client';

/**
 * Purchase Report (/reports/purchases) — management-only. Two views:
 *
 *  1. Summary — purchase SPEND over a date range, broken down by month, vendor,
 *     category, super-category, payment mode, and top items. Reads
 *     GET /api/reports/purchases (isManagement-gated); CSV built client-side.
 *     Reconciles with the Purchases page (same data set).
 *
 *  2. Purchase log (itemwise) — since owner ruling 115 (2026-11-05) it opens on
 *     ITEM-WISE PURCHASES: one line per `purchases` row, the very rows the
 *     Summary adds up, so every money column foots to the Summary card of the
 *     same name; downloads as a four-sheet Excel file built server-side. Reads
 *     GET /api/reports/purchase-itemwise. The old three-document log below is
 *     kept, unchanged, as the secondary "All documents (audit)" view.
 *
 *     All documents (audit) — one row per ITEM per BILL from all three
 *     document sources (purchases / purchase orders / GRN bills) in ONE downloadable
 *     file. Reads GET /api/reports/purchase-log.
 *
 * RULING 115 ON THE SUMMARY TAB: the first card is the GRAND TOTAL ("Total
 * Purchases"), with the booked cost as its sub-line, and every bar list ranks,
 * shows and adds up by Grand Total, its % share taken of that headline. The
 * breakdown CSVs keep every column; only their row order follows Grand Total.
 *
 * WHY THE LOG SHOWS THREE SEPARATE TOTALS AND NEVER A GRAND TOTAL ACROSS THEM:
 * receiving a purchase order writes BOTH a GRN and `purchases` rows — the same
 * physical goods recorded twice, for two different purposes. Adding the three
 * source values together would count those goods more than once, so this page
 * prints them side by side, each labelled, with an explicit warning, and never
 * sums them. `link_key` on each row ties a GRN line to the purchase row it
 * created so the overlap is visible instead of silently resolved. (The Grand
 * Total COLUMN, owner ruling 98, is one line's own final amount, totalled
 * within one source only — it is not that sum.)
 *
 * THE SUMMARY TAB'S THREE MONEY COLUMNS (2026-09-11). The owner asked for the
 * goods value to be shown as a subtotal and for a grand total that is "what we
 * actually need to pay the vendor", so the Summary tab names them in his words.
 * All three figures already existed; only the labels changed:
 *   SPEND (booked cost)  `total_spend`  — what was recorded into stock. The
 *                        figure stock valuation reconciles against. UNCHANGED,
 *                        still goods-only, and never replaced by either below.
 *   SUBTOTAL             `bill_value`   — the same goods at the price the bill
 *                        charges for them. Equal to Spend except on PO receipts.
 *   GRAND TOTAL          `total_amount` — Subtotal − discount + every charge.
 * The Summary tab reads ONE table (`purchases`), so that grand total is safe. The
 * PURCHASE LOG tab below is a different matter and keeps its own vocabulary —
 * see the next paragraph and the "do not add these three totals" warning.
 *
 * WHY EVERY MONEY FIGURE IS NAMED, AND NOTHING IS CALLED JUST "TOTAL":
 * "Total Amount" has two honest readings — the goods value, and the goods value
 * plus tax and every bill charge — and they differ by the whole tax bill. So the
 * log shows them apart, per source, on the cards, in a totals panel, and in the
 * table's own <tfoot>. Owner ruling 98 (2026-11-01) named the log's columns:
 * TOTAL AMOUNT = value − discount, BEFORE tax; GRAND TOTAL, right beside it =
 * the final amount (the figure TOTAL AMOUNT carried before that ruling). Those labels were
 * deliberately NOT renamed to Subtotal / Grand Total on the screen alone: the log's CSV headings are
 * built server-side in /api/reports/purchase-log, and renaming the screen alone
 * would leave the file and the table using different words for one column — so
 * ruling 98's Grand Total column was added to the screen and the CSV together. Columns that cannot
 * be totalled in one basis (Qty, Rate, Discount on PURCHASE rows) print an em
 * dash and the REASON, straight from the server's no_total_notes, rather than
 * quietly having no figure — a missing total that says why beats a wrong one.
 *
 * THE FOOTER IS NOT A FOOTER OF WHAT YOU SEE. Rows are painted up to
 * ROW_PAINT_CAP, but every total is a SQL aggregate over the full filtered set,
 * so the tfoot can legitimately exceed the visible rows. It says so on screen.
 *
 * UNITS: quantities and rates on all three sources are already in PURCHASE
 * units (₹ per purchase unit) — no pack-factor conversion here, ever.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { todayIST } from '@/lib/format-date';
import MaterialTypeahead, { type MaterialLite } from '@/components/MaterialTypeahead';
/**
 * THE charge spec — imported, never re-listed here. The column order on screen,
 * the headings in the CSV, which cells are blank rather than 0, and which
 * column is signed all come from this one module, which the API route also
 * imports for its SQL. A column added there appears in the table AND in the
 * file with no edit on this page.
 */
import {
  PURCHASE_CHARGE_COLUMNS,
  appendChargeCsvHeader, appendChargeCsvRow, chargeCell, chargeTotals,
  hasGrnSourcedCharges, isChargeSourceMissingRow, hasUnpairedMirrorRows, unpairedMirrorNote,
  fmtSignedINR, r2,
  type PurchaseChargeRow, type PurchaseChargeSums,
} from '@/lib/purchase-charges';
/**
 * TAX ACTUALLY CHARGED — the owner's "Tax Value" and "Tax % Applied", GST only,
 * on this TRANSACTION report and on no stock-balance surface. The arithmetic,
 * the blank-not-zero rule and the 2-decimal formatting live in ONE module so
 * this screen, its CSV, the purchase log, the bill summary and the GRN inward
 * register cannot drift into five roundings. See src/lib/tax-applied.ts for why
 * the base is the post-discount subtotal of the GST-BEARING lines only.
 */
import {
  TAX_VALUE_LABEL, TAX_PERCENT_LABEL, TAX_VALUE_TITLE, TAX_PERCENT_TITLE,
  TAX_VALUE_CSV_HEADER, TAX_PERCENT_CSV_HEADER,
  gstValue, taxAppliedPercent, fmtTaxPercent, taxCsvNumber, taxAppliedNote,
} from '@/lib/tax-applied';
// The Purchase log's Tax % on a part-rejected PO receipt is struck on the
// ACCEPTED value (the GRN Inward Register's basis) — the shared wording for
// saying so, used by the Purchases register too.
import { acceptedBaseRowNote, acceptedBaseTotalNote } from '@/lib/purchase-gst-base';
// Owner ruling 115 (2026-11-05): the item-wise list's column spec, shared with
// the server route that builds its Excel file, and the card-figure sizing that
// keeps every number inside its card at every width.
import {
  ITEMWISE_MONEY_COLUMNS, ITEMWISE_RATE_TITLE, billMatchSentence, billsDoNot,
  type ItemwiseResponse, type ItemwiseRow,
} from '@/lib/purchase-itemwise-columns';
import { fitFigureStyle } from '@/lib/fit-figure';
import {
  ShoppingCart, TrendingUp, Building2, Package, AlertTriangle, Download, CalendarDays,
  ScrollText, Info, Loader2, BarChart3, Sigma, Receipt, Truck, FileSpreadsheet, CheckCircle2,
} from 'lucide-react';

interface Row extends PurchaseChargeRow { spend: number; count: number; [k: string]: any }

/**
 * One dimension of the summary: what it is called, which field names the group,
 * its rows, and the CSV it produces. Declared as a type so the bar cards, the
 * charge table and the export function are all handed the identical object —
 * three renderers, one source of truth for what "by vendor" means.
 */
interface BreakdownSpec {
  k: 'month' | 'vendor' | 'category' | 'super_category' | 'payment_mode';
  title: string;
  /** The rows' own word, plural — "All 32 vendors together …" under the bar list. */
  plural: string;
  /** …and singular — "The 1 month: …" when the list has one row. */
  singular: string;
  /** The row field carrying the dimension's own label. */
  keyName: string;
  icon: React.ReactNode;
  rows: Row[];
  /** CSV filename — unchanged from before the charge columns existed. */
  file: string;
  /** CSV lead columns — unchanged, and always the first columns of the file. */
  head: string[];
  limit?: number;
}

/**
 * The on-page proof that this report is showing every bill. Mirrored from
 * src/lib/purchase-reconciliation.ts — the FIELD NAMES are the contract.
 *
 * `unexplained` is the one that matters: rows and rupees the report lost for a
 * reason nobody declared. It must be 0/₹0, and the panel goes red if it is not.
 */
interface ReconTally { rows: number; rupees: number }
interface Reconciliation {
  source: ReconTally;
  shown: ReconTally;
  excluded: { reason: string; detail: string; rows: number; rupees: number }[];
  unexplained: ReconTally;
  balanced: boolean;
  defects: { unlinked_material_rows: number; unlinked_material_rupees: number };
}
interface BillIdentity {
  rows_in_range: number; identified_rows: number; unidentified_rows: number;
  merged_lines: number; hidden_bills: number; hidden_bill_rupees: number;
  repair_available: boolean;
}

/**
 * The first and last dates purchases actually exist on, as the API reports them.
 * Null on both when there are no purchases at all — a different thing from
 * "none in the window you picked", and the page says so in those words.
 */
interface DataRange { first: string | null; last: string | null }

/**
 * WHAT WINDOW THE PAGE IS ASKING FOR — not what dates it is asking for.
 * 'all' means "every purchase there is"; the DATES for that are resolved by the
 * server against the data and echoed back, because the page cannot know the
 * first purchase date before it has asked. See the state comment below.
 */
type Range = { mode: 'all' } | { mode: 'explicit'; from: string; to: string };

/**
 * One date-range button. Built ONCE in the page and handed to the Purchase log
 * tab as well, so the two tabs of this report can no longer offer different
 * windows — they used to, and the log tab was missing "Last month" entirely.
 * `window` is the range the button will apply, printed on the button itself.
 */
interface PresetChip { label: string; window: string; active: boolean; apply: () => void; title: string }

interface Report {
  from: string; to: string; vendor: string; category: string;
  data_range?: DataRange;
  summary: PurchaseChargeSums & {
    purchase_count: number; total_spend: number; vendor_count: number; item_count: number;
    day_count: number; emergency_spend: number; emergency_count: number;
    count?: number; po_receipt_rows?: number;
    grn_sourced_rows?: number; unpaired_mirror_rows?: number;
    /** The "Tax % Applied (GST)" base: post-discount subtotal of the GST-bearing
     *  lines only, and how many lines that was. See src/lib/tax-applied.ts. */
    taxed_bill_value?: number; taxed_lines?: number;
  };
  by_vendor: Row[]; by_category: Row[]; by_super_category: Row[]; by_month: Row[]; by_payment_mode: Row[];
  // taxed_bill_value / taxed_lines ride on every aggregate row the route
  // returns — the "Tax % Applied (GST)" base and its line count. Declared here
  // because this row type, unlike Row, has no index signature.
  by_item: (PurchaseChargeRow & { material_name: string; unlinked?: number; category: string; unit: string; qty: number; spend: number; count: number; avg_rate: number; last_date: string; taxed_bill_value?: number; taxed_lines?: number })[];
  vendors: string[]; categories: string[];
  reconciliation?: Reconciliation;
  bill_identity?: BillIdentity;
  /**
   * Server-side proof that every breakdown adds up to the summary on every
   * charge. EMPTY is the healthy state. A non-empty list is a defect in this
   * report and the page prints it in red rather than showing figures that do
   * not foot.
   */
  charge_footing?: { breakdown: string; charge: string; rows: number; summary: number }[];
}

/** One row per ITEM per BILL, from whichever document source recorded it. */
type LogSource = 'PURCHASE' | 'PO' | 'GRN';

/**
 * The eight recorded-only charges. ONE key list, used for the row cells, the
 * table headings and the tfoot totals — the names are identical on LogRow and
 * on SourceMoney, so the column and the figure under it cannot drift apart.
 */
type ChargeKey =
  | 'discount' | 'cgst' | 'sgst' | 'special_excise_cess'
  | 'compensation_cess' | 'tcs' | 'delivery_charges' | 'mrp_round_off';

interface LogRow {
  source: LogSource;
  date: string; doc_no: string;
  invoice_id: string;            // OURS   — PINV-yyyy-####, one per vendor bill
  bill_no: string;               // VENDOR — the number printed on their bill
  vendor: string;
  material: string; sku: string; category: string;
  qty: number; purchase_unit: string; rate: number; value: number;
  /**
   * TOTAL AMOUNT — value − discount, BEFORE tax (owner ruling 98), computed
   * server-side in src/lib/purchase-log.ts. ⚠ On some PURCHASE lines (dated
   * April 2026, from the old bulk import) value may already hold the vendor's
   * tax and charges, and then so does this.
   * null on PO rows — an order has no charge columns and so no bill amount.
   */
  total_amount: number | null;
  /**
   * GRAND TOTAL — value − discount + CGST + SGST + both cesses + TCS + delivery
   * + round-off (this log's "Total Amount" until ruling 98), computed
   * server-side in src/lib/purchase-log.ts so this page, the CSV, the GRN
   * inward register and the Purchases page all use ONE formula.
   * null on PO rows. Optional so an older cached payload degrades to an em dash.
   */
  grand_total?: number | null;
  qty_rejected: number | null;   // GRN lines only
  // null (not 0) on PO rows: purchase_order_items has no charge columns at all,
  // and a 0 would assert "no tax was charged" on an order nobody has billed yet.
  discount: number | null; cgst: number | null; sgst: number | null;
  // compensation_cess is GST Compensation Cess (aerated drinks, tobacco) — a SEPARATE
  // levy from special_excise_cess, which means TGBCL Special Excise Cess everywhere it
  // is read or labelled. Never fold it into cgst/sgst: it is not halved and it must not
  // join the tax_value === cgst + sgst invariant.
  compensation_cess: number | null;
  special_excise_cess: number | null; tcs: number | null;
  delivery_charges: number | null; mrp_round_off: number | null;
  link_key: string;              // ties a GRN line to the purchases row it created
  notes: string;
  /**
   * THE OWNER'S TAX COLUMNS (#5, ruling 93), computed server-side in
   * src/lib/purchase-log.ts off the BILL DOCUMENT: the row's own CGST + SGST,
   * except on a PURCHASE row booked by a PO receive, whose GST lives on its GRN
   * line (tax_from_grn; usually only there — an amendment of that line can also
   * write it onto the row). null = BLANK, never ₹0 / 0.00%: no GST typed, or a
   * PO line. Optional so an older cached payload degrades to an em dash.
   */
  tax_value?: number | null;
  tax_percent?: number | null;
  tax_from_grn?: boolean;
  /** Tax % struck on the ACCEPTED value of a part-rejected PO receipt (GRN Inward Register basis). */
  tax_base_accepted?: boolean;
  /** A PO receipt's purchase row whose GRN line is gone: tax UNAVAILABLE, not "no GST". */
  tax_unavailable?: boolean;
  /**
   * BILL GRAND TOTAL — the WHOLE bill this line sits on (Subtotal − discount +
   * every tax and charge), the Purchase Bill Summary's own figure for that bill.
   * The SAME number on every line of the bill, so it is never added down.
   * null on PO lines and where no bill can be quoted — the reason says why.
   */
  bill_grand_total?: number | null;
  bill_key?: string | null;
  bill_label?: string | null;
  bill_lines?: number | null;
  bill_grand_total_reason?: string;
  /** Lines of that bill whose GRN line was deleted — > 0 means the figure is SHORT (the Bill Summary flags it too). */
  bill_unpaired_lines?: number | null;
  /** The UNDERSTATED warning for that figure; '' / absent when the bill is sound. */
  bill_understated_note?: string;
}

/**
 * One source's money, mirrored from PurchaseLogSourceMoney in
 * src/lib/purchase-log.ts. Mirrored rather than imported because that module
 * pulls in better-sqlite3 and this is a client component — keep the two in step
 * by hand; the FIELD NAMES are the contract.
 *
 * null NEVER means zero here. It means "deliberately not totalled", and the
 * reason is in no_total_notes: `discount` on PURCHASE (a 0 in that column means
 * three different things) and every charge on PO (no such columns exist).
 */
interface SourceMoney {
  source: LogSource;
  lines: number;
  goods_value: number;
  discount: number | null;
  /** What was actually deducted inside total_amount and bill_amount, published so the row foots. */
  discount_netted: number;
  cgst: number | null; sgst: number | null; tax_cgst_sgst: number | null;
  special_excise_cess: number | null; compensation_cess: number | null;
  tcs: number | null; delivery_charges: number | null; mrp_round_off: number | null;
  other_charges: number | null;
  /** The Total Amount column's total — Σ(value − discount), before tax. Optional for a cached payload. */
  total_amount?: number | null;
  /** The Grand Total column's total — goods − discount + every tax and charge. */
  bill_amount: number | null;
  /**
   * SUM(value) − SUM(qty × rate) for this source/window, NET over every line —
   * should be 0. Nonzero on PURCHASE is the measured contamination behind
   * goods_value_caveat below: mostly tax sitting inside a column this report
   * reads as "goods value", plus a few paise of rate rounding either way.
   */
  goods_value_tax_suspect: number;
  /** Lines behind goods_value_tax_suspect — value ≠ qty × rate (2dp). */
  goods_value_tax_suspect_lines: number;
  /**
   * The "Tax % Applied (GST)" base for this source — Σ(value − discount) over
   * the lines that CARRIED GST — and how many lines that was. Restricted to the
   * taxed lines because 2,158 of 2,165 PURCHASE lines record no GST, so a rate
   * over the whole source would print 0.01% for an 18% bill. See
   * src/lib/tax-applied.ts and PurchaseLogSourceMoney.
   */
  taxed_bill_value: number;
  taxed_lines: number;
  /**
   * The Tax Value (GST) / Tax % Applied (GST) columns' totals, on the same
   * bill-document basis as the row cells (see LogRow.tax_value). Can differ
   * from tax_cgst_sgst only on PURCHASE rows whose GST is read off their GRN
   * line (tax_from_grn), and not once an amendment has written that GST onto
   * the row. Optional for a
   * cached payload.
   */
  gst_value?: number | null;
  gst_taxed_bill_value?: number;
  gst_taxed_lines?: number;
  gst_from_grn_lines?: number;
  /** GST-bearing lines whose Tax % base is the ACCEPTED value (part-rejected PO receipt). */
  gst_base_accepted_lines?: number;
}

interface LogResponse {
  rows: LogRow[];
  totals: {
    lines: number; purchase_value: number; po_value: number; grn_value: number;
    money: Record<LogSource, SourceMoney>;
    no_total_notes: { column: string; reason: string }[];
    /**
     * ⚠ Render verbatim, prominently, wherever GOODS VALUE, TOTAL AMOUNT or GRAND
     * TOTAL is shown. Computed server-side (src/lib/purchase-log.ts) so the screen and
     * the downloaded CSV state the identical words and the identical number.
     */
    goods_value_caveat: string;
    /**
     * How the Bill Grand Total column was proved against the Purchase Bill
     * Summary for this response. mismatched > 0 is a DEFECT: those bills print
     * blank and the page says so in red.
     */
    bill_grand_total_check?: { bills: number; matched: number; unverified: number; mismatched: number };
  };
  truncated: boolean; from: string; to: string;
}

/**
 * ₹, ALWAYS TO THE PAISA — the same rule the shared fmtSignedINR states
 * (src/lib/purchase-charges.ts: "Two decimals ALWAYS").
 *
 * `minimumFractionDigits: 2` added 2026-09-11. Without it en-IN defaults to 0
 * and this formatter printed Spend as ₹69,26,866.4 in a footer whose very next
 * cells — Subtotal and Grand Total, rendered through fmtSignedINR — read
 * ₹69,28,486.40 and ₹69,34,193.60. Three figures of one row, two spellings of
 * money. The sibling report's own ₹ formatter was corrected in the same pass.
 */
const fmtINR = (n: number) => '₹' + (Math.round((Number(n) || 0) * 100) / 100)
  .toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/**
 * The SAME rupee formatting, but null survives as an em dash instead of
 * collapsing to ₹0. Every "no total" and every not-applicable charge on this
 * page goes through here — printing ₹0 for "we deliberately did not total this"
 * is the exact confident-wrong-number the report exists to avoid.
 */
const fmtINRorDash = (n: number | null | undefined) => (n == null ? '—' : fmtINR(n));
const fmtNum = (n: number) => (Number(n) || 0).toLocaleString('en-IN');
/** Quantities can be fractional (0.5 CTN etc.) — never round them away. */
const fmtQty = (n: number) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });

function firstOfMonth(iso: string) { return iso.slice(0, 8) + '01'; }
function addMonths(iso: string, n: number) {
  const [y, m] = iso.split('-').map(Number);
  const d = new Date(Date.UTC(y, (m - 1) + n, 1));
  return d.toISOString().slice(0, 10);
}
/** Financial year (Apr 1 – today), India convention. */
function fyStart(iso: string) {
  const [y, m] = iso.split('-').map(Number);
  return (m >= 4 ? y : y - 1) + '-04-01';
}
/** Last day of the month BEFORE the one `iso` falls in. */
function endOfPrevMonth(iso: string) {
  const [y, m] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/**
 * "2026-04-01" → "1 Apr 2026", for dates the reader is asked to JUDGE rather
 * than type. Every preset button now prints the window it will apply, and
 * "1 Jul 2026 – 11 Sep 2026" tells the owner in one glance that it cannot reach
 * April; "2026-07-01" makes him decode it first.
 * The date INPUTS keep ISO — that is what <input type="date"> takes.
 */
function humanDate(iso: string | null | undefined) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTH_SHORT[m - 1]} ${y}`;
}

/**
 * Client-side CSV download with a formula-injection guard.
 *
 * ⚠ THE GUARD DOES NOT APPLY TO NUMBERS, AND THAT IS THE POINT.
 *
 * A JS number can never be a spreadsheet formula, but its string form can start
 * with a minus — and `MRP Round-off` is SIGNED: a bill rounded down carries
 * −0.50. Passing that through the `^[=+\-@]` guard writes `'-0.5`, which Excel
 * reads as TEXT, so the reader's own SUM over the column silently stops
 * counting the negative rows. The server's CSV route hit the identical trap and
 * solved it the identical way (its `numeric: true` flag); here the type of the
 * value IS the flag, so a new numeric column can never forget to set it.
 * Strings — vendor names, item names, notes — keep the guard.
 */
function downloadCsv(filename: string, header: string[], rows: (string | number)[][]) {
  const esc = (v: any) => {
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;          // neutralise CSV formula injection
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const csv = [header, ...rows].map(r => r.map(esc).join(',')).join('\n') + '\n';
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

/**
 * RECONCILIATION PANEL — "is this report showing me everything?", answered on
 * the page, every load, in rows and rupees.
 *
 * 2026-09-10. The owner found this report showing ₹0 while /purchases showed
 * ₹69,26,866.40, and nothing on screen admitted a gap existed. The numbers were
 * not wrong; the page just had no way to say what it was NOT showing. So:
 *
 *   • It always states shown-vs-source, even when they match. "Every purchase
 *     row in the system is on this page" is information the owner never had.
 *   • Every difference is a NAMED line with its own rupee figure. A gap the
 *     user caused (their own date range, their own filter) reads as a choice.
 *   • Anything left over lands in UNEXPLAINED and turns the panel red. That is
 *     a defect in this report, and it says so in those words.
 *
 * Rendered ABOVE the "no purchases in this range" empty state on purpose: an
 * empty report is exactly when the reader most needs to be told that 2,165 rows
 * are sitting just outside the window they picked.
 */
function ReconciliationPanel({ recon, bills, grandTotal, onWiden }: {
  /** summary.total_amount — the headline card's own figure, printed beside the booked one (agreed with the owner 2026-11-07). */
  recon: Reconciliation; bills?: BillIdentity; grandTotal: number | null; onWiden: () => void;
}) {
  const bad = !recon.balanced;
  const gapRows = recon.source.rows - recon.shown.rows;

  return (
    <div className={`rounded-2xl border shadow-sm overflow-hidden ${
      bad ? 'bg-red-50 border-red-300' : 'bg-white border-[#E8D5C4]'}`}>
      <div className={`px-4 py-2.5 flex items-center gap-2 border-b ${
        bad ? 'border-red-200 text-red-800' : 'border-[#F0E4D6] text-[#2D1B0E]'}`}>
        {bad ? <AlertTriangle className="w-4 h-4 shrink-0" /> : <Sigma className="w-4 h-4 shrink-0 text-[#af4408]" />}
        <h2 className="text-sm font-bold">Reconciliation — what this page is showing you</h2>
      </div>

      <div className="p-4 space-y-3">
        {/* The two figures being compared, side by side — stacked until the
            panel is 36rem wide (round 3). Side by side on a phone the boxes
            were ~140px, too narrow for "(Grand Total) ₹45,74,951.78" below, so
            "(Grand Total)" ended a line alone (measured at 375-414px). From
            36rem each box has 258px of text width, room for the whole
            "Total Purchases (Grand Total) ₹1,15,09,145.38" (ruling 115 d). */}
        <div className="@container">
        <div className="grid grid-cols-1 @xl:grid-cols-2 gap-3">
          <div className="@container min-w-0 rounded-xl border border-[#E8D5C4] bg-[#FFFCF8] px-3 py-2.5">
            {/* BOTH FIGURES ARE SPEND (booked into stock), and the sub-lines say so. This panel
                compares goods value against goods value — it is a row-coverage
                proof, not a bill total. Since the charge columns landed, the
                page also carries a GRAND TOTAL (what is payable, tax included),
                which is a LARGER number; an unlabelled ₹ here would read as a
                report that disagrees with its own footer. */}
            {/* Sized off the box (ruling 115 d): a fixed text-lg spilled a lakh
                figure out of a narrow box. */}
            <p className="text-[10px] font-semibold uppercase tracking-wide text-[#8B7355]">Shown on this page</p>
            <p className="font-bold tabular-nums whitespace-nowrap leading-snug" style={fitFigureStyle(fmtINR(recon.shown.rupees), 1.125)}>{fmtINR(recon.shown.rupees)}</p>
            {/* "(goods value)" is one inline-block, so it never splits as "(goods / value)". */}
            <p className="text-[11px] text-[#6B5744]">{`${fmtNum(recon.shown.rows)} purchase row${recon.shown.rows === 1 ? '' : 's'} · booked into stock `}<span className="inline-block">(goods value)</span></p>
            {/* AGREED WITH THE OWNER 2026-11-07: the booked figure above sat next
                to a larger headline and read like a mismatch. This line names the
                headline's own figure (summary.total_amount, formatted as the card
                formats it) so the two read as two different things. No new
                query; the row reconciliation above and below is unchanged.
                "(Grand Total)" and its amount are one inline-block: they move to
                a new line together, and split (at a space, never inside the
                figure) only where the box is narrower than the pair. */}
            <p className="text-[11px] text-[#6B5744] mt-1.5 pt-1.5 border-t border-dashed border-[#E8D5C4]">Total Purchases <span className="inline-block">{`(Grand Total) ${fmtSignedINR(grandTotal)}`}</span> incl. GST and charges = the figure at the top</p>
          </div>
          <div className="@container min-w-0 rounded-xl border border-[#E8D5C4] bg-[#FFFCF8] px-3 py-2.5">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-[#8B7355]">In the source (all purchases)</p>
            <p className="font-bold tabular-nums whitespace-nowrap leading-snug" style={fitFigureStyle(fmtINR(recon.source.rupees), 1.125)}>{fmtINR(recon.source.rupees)}</p>
            <p className="text-[11px] text-[#6B5744]">{`${fmtNum(recon.source.rows)} purchase row${recon.source.rows === 1 ? '' : 's'} · booked into stock `}<span className="inline-block">(goods value)</span></p>
          </div>
        </div>
        </div>

        {/* The verdict — never left for the reader to work out by subtraction. */}
        {gapRows === 0 && recon.balanced ? (
          <p className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
            <strong>They match.</strong> Every purchase row in the system is included on this page.
          </p>
        ) : (
          <div className="space-y-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8B7355]">
              The difference, in full
            </p>
            {recon.excluded.map((x, i) => (
              <div key={i} className="flex items-start justify-between gap-3 text-sm border-b border-dashed border-[#F0E4D6] pb-1.5">
                <div className="min-w-0">
                  <p className="font-medium text-[#2D1B0E]">{x.reason}</p>
                  <p className="text-[11px] text-[#8B7355]">{x.detail}</p>
                </div>
                <div className="text-right shrink-0 tabular-nums">
                  <p className="font-semibold">{fmtINR(x.rupees)}</p>
                  <p className="text-[11px] text-[#8B7355]">{fmtNum(x.rows)} rows</p>
                </div>
              </div>
            ))}

            {/* THE ALARM. Red, named, and it does not pretend to know the cause. */}
            {bad && (
              <div className="flex items-start justify-between gap-3 text-sm bg-red-100 border border-red-300 rounded-lg px-3 py-2 mt-2">
                <div className="min-w-0">
                  <p className="font-bold text-red-900">UNEXPLAINED — this report is dropping rows</p>
                  <p className="text-[11px] text-red-800">
                    These rows are inside your date range and pass your filters, yet the report did not
                    count them. This is a defect in the report, not in your data. Report it — do not
                    reconcile the difference by hand.
                  </p>
                </div>
                <div className="text-right shrink-0 tabular-nums">
                  <p className="font-bold text-red-900">{fmtINR(recon.unexplained.rupees)}</p>
                  <p className="text-[11px] text-red-800">{fmtNum(recon.unexplained.rows)} rows</p>
                </div>
              </div>
            )}

            {recon.excluded.some(x => x.reason.startsWith('Outside')) && (
              <button onClick={onWiden}
                className="mt-1 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#af4408] hover:bg-[#8a3506] text-white">
                <CalendarDays className="w-3.5 h-3.5" /> Show every bill (widen to all dates)
              </button>
            )}
          </div>
        )}

        {/* Data defects worth naming even when they cost nothing today. */}
        {recon.defects.unlinked_material_rows > 0 && (
          <p className="text-[12px] text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            <strong>{fmtNum(recon.defects.unlinked_material_rows)} row(s)</strong> worth{' '}
            {fmtINR(recon.defects.unlinked_material_rupees)} point at a material record that no longer
            exists. They ARE counted above and appear in the item table as
            “(material not linked · id …)”. Relink the item to give them a name.
          </p>
        )}

        {bills?.repair_available && (
          <p className="text-[12px] text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            <strong>{fmtNum(bills.hidden_bills)} separate vendor bill(s)</strong> in this range are merged
            into {fmtNum(bills.merged_lines)} vendor-day line(s) on the bill views, because{' '}
            {fmtNum(bills.unidentified_rows)} row(s) carry no invoice number in their own column —
            the importer left it in the notes text instead. Spend totals on THIS page are unaffected
            (every row is counted); the bill COUNT is what understates. An admin can repair the stored
            data from <code className="font-mono">/api/admin/repair-purchase-bill-no</code> — dry-run first.
          </p>
        )}
      </div>
    </div>
  );
}

export default function PurchaseReportPage() {
  const today = todayIST();
  /**
   * DEFAULT RANGE = FINANCIAL YEAR, not this month. 2026-09-10 ruling.
   *
   * This one line was the whole of the owner's "the report is missing bills".
   * The report opened on 1st-of-this-month → today; the Purchases page it was
   * being compared against defaults to NO date filter at all. On the live data
   * that window held 0 of 2,165 rows and ₹0 of ₹69,26,866.40 — every bill in
   * the system was outside the default view, and the page said only "₹0".
   *
   * fyStart() was already defined here and already offered as a preset; the
   * default simply never used it. Purchases are read by financial year in this
   * business, so the FY is also the range the owner actually wants.
   *
   * The date default is a convenience, NOT the safety net. The safety net is
   * the reconciliation panel below, which names every row outside the window in
   * rupees — so even a hand-picked empty range now explains itself instead of
   * looking like missing data. Keep both.
   *
   * ── 2026-09-11 AMENDMENT: THE DEFAULT NOW COMES OFF THE DATA, NOT THE CALENDAR.
   * The FY default above was right about the problem and one calendar cliff away
   * from being right about the fix. fyStart() returns 2026-04-01 today, which
   * happens to equal the first purchase — and returns 2027-04-01 on 1 April
   * 2027, when this page would go completely blank again and the whole 2026-27
   * book would be unreachable from the widest preset on it. Same incident, on a
   * date certain. A default read off MIN(purchases.date) has no such date.
   * The FY window is kept, as a preset, with its dates printed on it.
   *
   * WHY THIS IS ONE PIECE OF STATE AND NOT TWO DATES. The page wants to open on
   * "everything" but cannot know the first purchase date until it has asked the
   * server — and asking twice (once for the dates, once for the report) would
   * double every first load AND, in between, paint a report for a window nobody
   * chose. So `range` holds the INTENT ({mode:'all'}), the fetch is keyed on the
   * INTENT alone, and the server answers with the report AND the real dates it
   * used. Writing those into `resolved` re-renders the date boxes and the CSV
   * filenames WITHOUT re-running the query, because nothing that fetches depends
   * on `resolved`. Exactly one request.
   *
   * If you ever make `load` depend on `from`/`to` instead of `range`, the first
   * load fires twice on every visit. That is the trap this shape avoids.
   */
  const [range, setRange] = useState<Range>({ mode: 'all' });
  /** The real dates the server resolved for the window above. Display + CSV only — NEVER a fetch dependency. */
  const [resolved, setResolved] = useState<{ from: string; to: string } | null>(null);
  /** The dates purchases actually exist on, for the empty-range line and the All-time caption. */
  const [dataRange, setDataRange] = useState<DataRange | null>(null);
  /**
   * `resolved`, readable synchronously. Editing the From box must keep the To
   * box's current value, and inside one handler a state variable is still the
   * pre-render one — so the setters below read the window off the PREVIOUS
   * range, with this ref as the fallback for the 'all' case. Without it,
   * setFrom() followed by setTo() in the same tick would clobber the first.
   */
  const resolvedRef = useRef<{ from: string; to: string } | null>(null);

  /** The window as currently displayed: the chosen dates, or the ones the server resolved. */
  const from = range.mode === 'explicit' ? range.from : (resolved?.from || '');
  const to = range.mode === 'explicit' ? range.to : (resolved?.to || '');
  /** False for the one moment between the first paint and the first response. */
  const windowKnown = !!from && !!to;

  const windowOf = useCallback((r: Range) => (
    r.mode === 'explicit' ? { from: r.from, to: r.to } : (resolvedRef.current || { from: '', to: '' })
  ), []);
  const setFrom = useCallback((v: string) => setRange(prev => ({ mode: 'explicit', from: v, to: windowOf(prev).to })), [windowOf]);
  const setTo = useCallback((v: string) => setRange(prev => ({ mode: 'explicit', from: windowOf(prev).from, to: v })), [windowOf]);
  /** A preset with fixed calendar dates. */
  const pickRange = useCallback((f: string, t: string) => setRange({ mode: 'explicit', from: f, to: t }), []);
  /** "All time" — the server works out the dates, so this can never go stale. */
  const pickAllTime = useCallback(() => setRange({ mode: 'all' }), []);

  const [vendor, setVendor] = useState('');
  const [category, setCategory] = useState('');
  const [data, setData] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [itemSearch, setItemSearch] = useState('');
  const [itemSort, setItemSort] = useState<'spend' | 'qty' | 'count' | 'avg' | 'name'>('spend');
  const [view, setView] = useState<'summary' | 'log'>('summary');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      // range=all asks for "every purchase" WITHOUT naming dates; the server
      // resolves them off the data and echoes the real ones back below. Keyed on
      // `range`, never on from/to — see the state comment.
      const qs = new URLSearchParams();
      if (range.mode === 'all') qs.set('range', 'all');
      else { qs.set('from', range.from); qs.set('to', range.to); }
      if (vendor) qs.set('vendor', vendor);
      if (category) qs.set('category', category);
      const res = await fetch(`/api/reports/purchases?${qs.toString()}`);
      if (res.status === 403) { setError('Management only — you don’t have access to purchase reports.'); setData(null); return; }
      if (!res.ok) { setError((await res.json().catch(() => ({}))).error || 'Failed to load report'); setData(null); return; }
      const j = (await res.json()) as Report;
      // THE DATES THE REPORT WAS ACTUALLY BUILT FROM, shown in the two date
      // boxes and stamped into every CSV filename on this page. On "All time"
      // this is the only way the page learns them — and writing them here
      // CANNOT re-trigger this fetch, because `load` depends on `range`.
      if (typeof j?.from === 'string' && typeof j?.to === 'string') {
        const w = { from: j.from, to: j.to };
        resolvedRef.current = w;
        setResolved(w);
      }
      setDataRange(j?.data_range
        ? { first: j.data_range.first ?? null, last: j.data_range.last ?? null }
        : null);
      setData(j);
    } catch { setError('Network error — please try again.'); }
    finally { setLoading(false); }
  }, [range, vendor, category]);

  useEffect(() => { load(); }, [load]);

  const s = data?.summary;

  // Item-wise report: filter (name/category) + sort, computed client-side over
  // the full item list the API returns.
  const items = useMemo(() => {
    const list = data?.by_item || [];
    const q = itemSearch.trim().toLowerCase();
    const filtered = q ? list.filter(r => r.material_name.toLowerCase().includes(q) || (r.category || '').toLowerCase().includes(q)) : list;
    return [...filtered].sort((a, b) => {
      if (itemSort === 'name') return a.material_name.localeCompare(b.material_name);
      const key = itemSort === 'avg' ? 'avg_rate' : itemSort;
      return (Number((b as any)[key]) || 0) - (Number((a as any)[key]) || 0);
    });
  }, [data, itemSearch, itemSort]);

  /** Charge totals over the item rows currently listed (search-filtered). */
  const itemTotals = useMemo(() => chargeTotals(items), [items]);
  /**
   * The same rows' TAX footer — Σ(cgst), Σ(sgst) and Σ(taxed base), so the
   * period rate is money-weighted rather than an average of the rows' own
   * percentages. Same shape the charge breakdown's footer uses.
   */
  const itemTaxTotals = useMemo(() => ({
    cgst: itemTotals.cgst, sgst: itemTotals.sgst,
    taxed_bill_value: r2(items.reduce((n, r) => n + (Number((r as any).taxed_bill_value) || 0), 0)),
    taxed_lines: items.reduce((n, r) => n + (Number((r as any).taxed_lines) || 0), 0),
    count: items.reduce((n, r) => n + (Number(r.count) || 0), 0),
  }), [items, itemTotals]);

  /**
   * ══ THE PRESETS — WIDEST FIRST, AND EVERY ONE PRINTS THE WINDOW IT APPLIES ══
   *
   * The trap this replaces, measured on live data on 11 Sep 2026: "Last 3
   * months" reads as the generous choice and opens 1 Jul – 11 Sep, which holds
   * 46 of 2,165 rows — and 34 of those 46 are QA test rows, so it shows 12 real
   * purchases worth ₹9,350 out of ₹68.9 lakh. A reader who clicks it sees a
   * populated table and has no reason to suspect 99.9% of the money is missing.
   *
   * TWO CHANGES, BOTH NEEDED — neither is sufficient alone:
   *  1. ORDER. Widest first, left to right, so the maximal choice is the one the
   *     eye lands on. Reordering alone would not have helped here: "This FY"
   *     already sat to the RIGHT of "Last 3 months" and was still passed over,
   *     because nothing on a bare label says which window is bigger.
   *  2. THE DATES, ON THE BUTTON. Each preset states the window it will apply,
   *     in words a reader can judge at a glance — "1 Jul 2026 – 11 Sep 2026"
   *     cannot be mistaken for something that reaches April. This is what makes
   *     it structurally impossible for a preset to look maximal while hiding the
   *     data: the button says where it goes.
   *
   * "All time" is first, is the default, and takes its dates from the data — so
   * it is also the only one with no calendar cliff. The other three keep their
   * calendar arithmetic exactly as it was, with ONE correction: "Last month"
   * ended on the 1st of THIS month, i.e. it quietly included one day of the
   * current month (and its end-date ternary compared a value against itself, so
   * the other branch could never run). With the dates now printed on the button
   * that off-by-one would read as a bug on screen, so it ends on the true last
   * day of last month. Flagged to the owner — it is a correction, not a
   * re-decision.
   */
  const presets = useMemo(() => {
    // The far end of "all time" mirrors the server's own rule exactly (see
    // resolveAllTimePurchaseRange): today, unless a bill is dated ahead of it.
    const allEnd = dataRange?.last && dataRange.last > today ? dataRange.last : today;
    const list: PresetChip[] = [{
      label: 'All time',
      window: dataRange?.first ? `${humanDate(dataRange.first)} – ${humanDate(allEnd)}` : 'every purchase there is',
      active: range.mode === 'all',
      apply: pickAllTime,
      title: 'Every purchase on record. The dates come from your data, so this window is never out of date.',
    }];
    const calendar: [string, string, string][] = [
      ['This financial year', fyStart(today), today],
      ['Last 3 months', addMonths(firstOfMonth(today), -2), today],
      ['Last month', addMonths(firstOfMonth(today), -1), endOfPrevMonth(today)],
      ['This month', firstOfMonth(today), today],
    ];
    for (const [label, f, t] of calendar) {
      list.push({
        label,
        window: `${humanDate(f)} – ${humanDate(t)}`,
        active: range.mode === 'explicit' && range.from === f && range.to === t,
        apply: () => pickRange(f, t),
        title: `Sets the dates to ${humanDate(f)} – ${humanDate(t)}. Anything outside those dates is not counted.`,
      });
    }
    return list;
  }, [dataRange, range, today, pickAllTime, pickRange]);

  /**
   * THE FIVE BREAKDOWNS, declared ONCE — title, group key, rows, CSV filename
   * and CSV lead columns together.
   *
   * Two things used to be able to drift and now cannot: the bar card and the
   * charge table showing different rows for the same dimension, and the CSV
   * header listing columns the row builder does not fill. The lead columns here
   * are EXACTLY the ones the pre-change export had, in the same order — the
   * charge columns are appended by appendChargeCsvHeader / appendChargeCsvRow.
   */
  /*
   * OWNER RULING 115 (2026-11-05): THE LISTS RANK BY GRAND TOTAL. The server
   * still orders vendor / category / super-category / payment mode by booked
   * spend (its SQL is shared with nothing here and stays as it was); the page
   * re-ranks them by Grand Total — what was actually bought, tax and charges in
   * — so the bar list, the charge table and the CSV all read in the order of the
   * headline card. A stable sort: equal Grand Totals keep the server's order.
   * Months stay in calendar order — a month list ranked by size is not a
   * timeline. Every column of every CSV is unchanged; only the row order moved.
   */
  const breakdowns: BreakdownSpec[] = useMemo(() => {
    const byGrandTotal = (rows: Row[] | undefined) =>
      [...(rows || [])].sort((a, b) => (Number(b.total_amount) || 0) - (Number(a.total_amount) || 0));
    return [
      { k: 'month', title: 'Month', plural: 'months', singular: 'month', keyName: 'month', icon: <CalendarDays className="w-4 h-4" />,
        rows: data?.by_month || [], file: `purchases-by-month_${from}_${to}.csv`, head: ['Month', 'Spend', 'Purchases'] },
      { k: 'vendor', title: 'Vendor', plural: 'vendors', singular: 'vendor', keyName: 'vendor', icon: <Building2 className="w-4 h-4" />, limit: 12,
        rows: byGrandTotal(data?.by_vendor), file: `purchases-by-vendor_${from}_${to}.csv`, head: ['Vendor', 'Spend', 'Purchases'] },
      { k: 'category', title: 'Category', plural: 'categories', singular: 'category', keyName: 'category', icon: <Package className="w-4 h-4" />, limit: 12,
        rows: byGrandTotal(data?.by_category), file: `purchases-by-category_${from}_${to}.csv`, head: ['Category', 'Spend', 'Purchases'] },
      { k: 'super_category', title: 'Super-category', plural: 'super-categories', singular: 'super-category', keyName: 'super_category', icon: <Package className="w-4 h-4" />,
        rows: byGrandTotal(data?.by_super_category), file: `purchases-by-supercategory_${from}_${to}.csv`, head: ['Super-category', 'Spend', 'Purchases'] },
      { k: 'payment_mode', title: 'Payment Mode', plural: 'payment modes', singular: 'payment mode', keyName: 'payment_mode', icon: <TrendingUp className="w-4 h-4" />,
        rows: byGrandTotal(data?.by_payment_mode), file: `purchases-by-payment_${from}_${to}.csv`, head: ['Payment Mode', 'Spend', 'Purchases'] },
    ];
  }, [data, from, to]);

  /**
   * One export path for a dimension, whichever button is pressed.
   *
   * THE TWO TAX COLUMNS ARE APPENDED LAST — after the charge block's own note
   * column — for the reason src/lib/purchase-charges.ts states about every
   * column it appends: a saved spreadsheet or a formula pointing at column D of
   * last month's file keeps working only if nothing that already existed moves.
   * They are also DERIVED, so they belong after the arithmetic they are derived
   * from (Subtotal − Discount + charges = Grand Total) rather than inside it,
   * where a reader adding the money columns across a row would count GST twice.
   *
   * Both cells come from the SAME two functions the screen renders, so the file
   * and the table are the same figure to the paisa and to the same 2 decimals.
   */
  const exportBreakdown = useCallback((b: BreakdownSpec) => {
    downloadCsv(b.file,
      [...appendChargeCsvHeader(b.head), TAX_VALUE_CSV_HEADER, TAX_PERCENT_CSV_HEADER],
      b.rows.map(r => [
        ...appendChargeCsvRow([r[b.keyName], r.spend, r.count], r),
        taxCsvNumber(gstValue(r)),
        taxCsvNumber(taxAppliedPercent(r)),
      ]));
  }, []);

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 py-5 sm:py-6 space-y-5">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">Reports</p>
            <h1 className="text-2xl sm:text-3xl font-bold mt-0.5 flex items-center gap-2"><ShoppingCart className="w-6 h-6 text-[#af4408]" /> Purchase Report</h1>
          </div>
          <Link href="/purchases" className="text-sm font-medium text-[#af4408] hover:underline">Go to Purchases →</Link>
        </div>

        {/* View switch — Summary (spend analysis) vs Purchase log (itemwise document log) */}
        <div className="flex flex-wrap gap-1.5">
          {([
            ['summary', 'Summary', <BarChart3 key="i" className="w-3.5 h-3.5" />],
            ['log', 'Purchase log (itemwise)', <ScrollText key="i" className="w-3.5 h-3.5" />],
          ] as const).map(([k, label, icon]) => (
            <button key={k} onClick={() => setView(k as 'summary' | 'log')}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold border transition-colors ${
                view === k ? 'bg-[#af4408] text-white border-[#af4408]' : 'bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]'}`}>
              {icon}{label}
            </button>
          ))}
        </div>

        {/* The log tab shares the parent's window, so it inherits the All-time
            default and writes back to it — switching tabs keeps the period. It
            is held back for the one moment the window is still unknown, because
            its own API is a different route that would 400 on a blank date
            rather than answer. On live data that moment is inside the same
            spinner the page already showed. */}
        {view === 'log' && (windowKnown
          ? <LogTab from={from} to={to} setFrom={setFrom} setTo={setTo}
              vendors={data?.vendors || []} categories={data?.categories || []} presets={presets} />
          : <div className="text-sm text-[#8B7355] py-8 text-center animate-pulse">Loading purchase log…</div>)}

        {view === 'summary' && (<>
        {/* Filters */}
        <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm p-4 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            {/* DISABLED FOR THE ONE MOMENT THE WINDOW IS UNKNOWN — between the
                first paint and the first response. Editing one box then would
                produce a half-built range (one real date, one blank) and the
                API would answer with a validation error instead of a report. */}
            <label className="block"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">From</span>
              <input type="date" value={from} disabled={!windowKnown} onChange={e => e.target.value && setFrom(e.target.value)} className="mt-1 block px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408] disabled:opacity-60" /></label>
            <label className="block"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">To</span>
              <input type="date" value={to} disabled={!windowKnown} onChange={e => e.target.value && setTo(e.target.value)} className="mt-1 block px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408] disabled:opacity-60" /></label>
            <label className="block min-w-[160px]"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">Vendor</span>
              <select value={vendor} onChange={e => setVendor(e.target.value)} className="mt-1 block w-full px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408]">
                <option value="">All vendors</option>{(data?.vendors || []).map(v => <option key={v} value={v}>{v}</option>)}
              </select></label>
            <label className="block min-w-[160px]"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">Category</span>
              <select value={category} onChange={e => setCategory(e.target.value)} className="mt-1 block w-full px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408]">
                <option value="">All categories</option>{(data?.categories || []).map(c => <option key={c} value={c}>{c}</option>)}
              </select></label>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {/* See the `presets` memo above for why these are widest-first and
                why each one prints the window it applies. */}
            {presets.map(p => (
              <button key={p.label} onClick={p.apply} title={p.title}
                className={`px-3 py-1.5 rounded-lg text-xs border text-left ${p.active
                  ? 'bg-[#af4408] text-white border-[#af4408]'
                  : 'bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]'}`}>
                <span className="block font-semibold">{p.label}</span>
                <span className={`block text-[10px] tabular-nums ${p.active ? 'text-white/85' : 'text-[#8B7355]'}`}>{p.window}</span>
              </button>
            ))}
          </div>
        </div>

        {error && <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">{error}</div>}
        {loading && !data && <div className="text-sm text-[#8B7355] py-8 text-center animate-pulse">Loading purchase report…</div>}

        {data && s && (
          <>
            {/* Summary cards. Ruling 115 (d): the row re-flows on the width it
                ACTUALLY has, not the window's — with the sidebar open a 1024px
                window leaves ~650px, and five cards there were 121px wide. Two,
                then three from 576px, six tracks from 896px of room. The
                headline card takes TWO tracks at every width, so the headline
                is never the smallest figure in its row (it was 14px beside 20px
                counts at 1280px) and every row is full: H H / P V / I E on a
                phone, H H P / V I E, then H H P V I E. */}
            <div className="@container">
            <div className="grid grid-cols-2 @xl:grid-cols-3 @4xl:grid-cols-6 gap-3">
              {/* OWNER RULING 115 (2026-11-05): THE HEADLINE IS THE GRAND TOTAL.
                  "The Total Cost Booked Cost Should be Grand Total." This card
                  read "Total Spend (booked cost)" — goods only, what was recorded
                  into stock — and the owner reads the first card as what October's
                  purchases came to. It now prints summary.total_amount, the SAME
                  figure as the Grand Total card at the end of the strip below
                  (Subtotal − Discount + every tax and charge), and the booked
                  cost stays on the card as its sub-line, unchanged: it is still
                  what stock valuation reconciles against. Every bar list below
                  adds up to this figure. */}
              <Card icon={<TrendingUp className="w-4 h-4" />} label="Total Purchases (Grand Total)" value={fmtSignedINR(s.total_amount)}
                sub={<>incl. GST and every charge · <span className="inline-block">{`booked into stock ${fmtINR(s.total_spend)}`}</span></>} tone="accent" className="col-span-2" />
              <Card icon={<ShoppingCart className="w-4 h-4" />} label="Purchases" value={fmtNum(s.purchase_count)} sub={`${fmtNum(s.day_count)} day${s.day_count === 1 ? '' : 's'}`} />
              <Card icon={<Building2 className="w-4 h-4" />} label="Vendors" value={fmtNum(s.vendor_count)} />
              <Card icon={<Package className="w-4 h-4" />} label="Items" value={fmtNum(s.item_count)} />
              <Card icon={<AlertTriangle className="w-4 h-4" />} label="Emergency Spend" value={fmtINR(s.emergency_spend)} sub={`${fmtNum(s.emergency_count)} purchases`} tone={s.emergency_spend > 0 ? 'warn' : undefined} />
            </div>
            </div>

            {/*
              THE OWNER'S FOUR, ON THE FIRST SCREEN, between the SUBTOTAL they
              are added to and the GRAND TOTAL they add up to.
              Deliberately a SECOND row of cards rather than folded into "Total
              Spend": spend is goods value and always has been, and quietly
              making it tax-inclusive would move a number the whole business
              reads. The Grand Total sits at the end as the other honest reading
              of "total", named so it can never be mistaken for the first.
            */}
            <ChargeCards s={s} />

            {/*
              THE ONE THING THE WORD "SUBTOTAL" COULD OVERPROMISE, SAID OUT LOUD.
              Calling this figure the ingredients cost is right on the bills that
              were keyed in with their tax split out. It is NOT right on the rows
              that came in from a vendor sheet in bulk, where the line total was
              bound TAX-INCLUSIVE and no CGST/SGST was ever separated — measured
              on the live database: 221 purchase rows whose stored line total
              differs from quantity × rate, of which 219 are April 2026 and carry
              zero recorded GST, together ~Rs 1.57 lakh (Rs 156,621.22). The
              other 2 are August and are float noise worth −Rs 0.02. On those
              April rows the Subtotal quietly contains the tax and the Grand Total
              equals it exactly. (The earlier figure written here was "217 rows,
              all April": 217 is the count under the tighter GST-is-zero filter,
              not the count of rows where the product disagrees, and "all April"
              was never true. The rupees were right; the counts were not.)

              The Purchase log tab has carried this caveat from the server since
              it was found (t.goods_value_caveat, src/lib/purchase-log.ts, which
              orders it shown "wherever GOODS VALUE or TOTAL AMOUNT is shown").
              THIS tab showed no equivalent. A static sentence is used rather than
              a live figure because this route computes no such count today and
              inventing one here would be new arithmetic on a naming change —
              flagged for the owner instead. If it is ever wanted per-window, the
              figure belongs in the API beside `reconciliation`, not in the page.
            */}
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-[12px] text-amber-900 flex gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <p><strong>One caveat on the Subtotal.</strong> Some older bills were entered in bulk from a vendor sheet with the tax already inside the
                line total and never split out — those lines show no GST of their own, so their Subtotal quietly includes whatever tax was in it and their
                Grand Total comes to the same figure. April 2026 is where nearly all of them sit. For a bill keyed in normally, the Subtotal is the goods
                alone and the tax is in its own column.</p>
            </div>

            {/*
              ALWAYS RENDERED, and deliberately ABOVE the empty state. An empty
              report is precisely when the reader needs to be told how many rows
              are sitting just outside the window they chose. 2026-09-10.
            */}
            {data.reconciliation && (
              <ReconciliationPanel
                recon={data.reconciliation}
                bills={data.bill_identity}
                grandTotal={s.total_amount}
                /* "Show everything" must mean EVERYTHING, in both directions.
                   Capping the far end at today left a future-dated bill — a
                   delivery entered ahead of its date, which this app allows —
                   outside the widened window, so the panel would report rows the
                   button could not then reveal and the reader looped. The panel
                   exists to end that loop, not to restage it.

                   2026-09-11: THAT REASONING IS KEPT, THE 1970/2099 SENTINELS
                   ARE NOT. This button wrote those two literals straight into
                   the From and To boxes above, so pressing it made the page
                   display a period the business has never had and stamped
                   `..._1970-01-01_2099-12-31.csv` on every export taken
                   afterwards — and the owner reconciles what he reads against
                   what he exports. It now presses the same "All time" the page
                   opens on, whose far end is today OR the last recorded bill,
                   whichever is later — so a future-dated bill is still inside
                   it, by construction, and both boxes still show real dates.
                   One "show everything" control on the page, one window. */
                onWiden={pickAllTime}
              />
            )}

            {s.total_spend === 0 ? (
              /* THE SAME EMPTY STATE, NOW NAMING THE DATES THAT DO HAVE
                 PURCHASES. 2026-09-11. "Try a wider date range" was true and
                 useless: it did not say how much wider, and the owner had no
                 way to tell an empty window from lost books. One sentence of
                 fact — your purchases run from X to Y — ends that. */
              <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center text-sm text-[#8B7355]">
                {dataRange?.first
                  ? <>No purchases between <strong>{humanDate(from)}</strong> and <strong>{humanDate(to)}</strong>
                    {(vendor || category) ? ' with these filters' : ''}. Your purchases run from{' '}
                    <strong>{humanDate(dataRange.first)}</strong> to <strong>{humanDate(dataRange.last || dataRange.first)}</strong> — press{' '}
                    <strong>All time</strong> above{(vendor || category) ? ', or clear the filters' : ''}. Nothing has been deleted.</>
                  : <>There are no purchases recorded yet, in any date range.</>}
              </div>
            ) : (
              <>
                {/*
                  EVERY CSV ON THIS PAGE NOW CARRIES THE CHARGE COLUMNS, APPENDED.
                  ONE export function per dimension, called by BOTH the bar card
                  and the charge table below, so the file a reader gets is the
                  same file whichever button they press, and the table on screen
                  and the file cannot list different columns. The old columns keep
                  their old positions (proved by a byte-diff of the shared prefix
                  against a pre-change export); the eight charges, Total Amount
                  and the tax-on-GRN note are APPENDED on the right. Never insert
                  a column into the middle of one of these lists — somebody's
                  saved pivot points at column C.
                */}
                {/* RULING 115: each list shows, ranks and adds up by GRAND TOTAL,
                    its % share is of the headline card, and its foot says what
                    the whole list adds up to — the Total Purchases figure. */}
                <div className="grid lg:grid-cols-2 gap-4">
                  {breakdowns.filter(b => b.k !== 'payment_mode').map(b => (
                    <BarTable key={b.k} title={`Purchases by ${b.title}`} plural={b.plural} singular={b.singular} icon={b.icon} keyName={b.keyName}
                      rows={b.rows} total={Number(s.total_amount) || 0} limit={b.limit} onExport={() => exportBreakdown(b)} />
                  ))}
                </div>

                {data.by_payment_mode.length > 0 && (() => {
                  const b = breakdowns.find(x => x.k === 'payment_mode')!;
                  return <BarTable title={`Purchases by ${b.title}`} plural={b.plural} singular={b.singular} icon={b.icon} keyName={b.keyName}
                    rows={b.rows} total={Number(s.total_amount) || 0} onExport={() => exportBreakdown(b)} />;
                })()}

                {/* THE CHARGE COLUMNS ON SCREEN — the owner's four, per dimension,
                    with a footer that has to equal the cards above it. */}
                <ChargeBreakdown breakdowns={breakdowns} summary={s} footing={data.charge_footing}
                  onExport={exportBreakdown} />


                {/* Item-wise purchase report — every item purchased in the range */}
                <div className="bg-white border border-[#E8D5C4] rounded-xl shadow-sm p-4 sm:p-5">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
                    <h2 className="text-sm font-bold flex items-center gap-2"><span className="text-[#af4408]"><Package className="w-4 h-4" /></span>Item-wise Purchase Report <span className="text-[11px] text-[#8B7355] font-normal">({fmtNum(items.length)} item{items.length === 1 ? '' : 's'})</span></h2>
                    <div className="flex items-center gap-2">
                      <input value={itemSearch} onChange={e => setItemSearch(e.target.value)} placeholder="Search item / category…"
                        className="px-3 py-1.5 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408] w-48" />
                      <select value={itemSort} onChange={e => setItemSort(e.target.value as any)}
                        className="px-2 py-1.5 rounded-lg border border-[#E0D0BE] bg-white text-xs outline-none focus:border-[#af4408]">
                        <option value="spend">Sort: Spend</option><option value="qty">Sort: Qty</option>
                        <option value="count">Sort: Purchases</option><option value="avg">Sort: Avg rate</option><option value="name">Sort: Name</option>
                      </select>
                      {/* The two tax columns are APPENDED here for the same reason
                          they are on every other export on this page: nothing that
                          already had a column position moves, and a derived figure
                          sits after the arithmetic it is derived from. */}
                      <button onClick={() => downloadCsv(`purchase-report-itemwise_${from}_${to}.csv`,
                        [...appendChargeCsvHeader(['Item', 'Category', 'Unit', 'Total Qty', 'Purchases', 'Avg Rate (₹/unit)', 'Total Spend (₹)', 'Last Purchased']),
                          TAX_VALUE_CSV_HEADER, TAX_PERCENT_CSV_HEADER],
                        items.map(r => [
                          ...appendChargeCsvRow([r.material_name, r.category, r.unit, r.qty, r.count, Math.round(r.avg_rate * 100) / 100, Math.round(r.spend * 100) / 100, r.last_date], r),
                          taxCsvNumber(gstValue(r)),
                          taxCsvNumber(taxAppliedPercent(r)),
                        ]))}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#af4408] hover:bg-[#8a3506] text-white shrink-0"><Download className="w-3.5 h-3.5" /> CSV</button>
                    </div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead><tr className="text-left text-[11px] uppercase text-[#8B7355] border-b border-[#F0E4D6]">
                        <th className="py-2 pr-3">Item</th><th className="py-2 px-3">Category</th>
                        <th className="py-2 px-3 text-right">Total Qty</th><th className="py-2 px-3 text-right">Purchases</th>
                        <th className="py-2 px-3 text-right">Avg Rate</th><th className="py-2 px-3">Last</th><th className="py-2 px-3 text-right">Spend</th>
                        {/* The charge columns, on the item table itself. Same spec,
                            same order, same blank-vs-zero rule as the panel above
                            and as the CSV this table's own button writes. */}
                        {PURCHASE_CHARGE_COLUMNS.map(c => (
                          <th key={c.key} className="py-2 px-3 text-right" title={c.title}>{c.label}</th>
                        ))}
                        <th className="py-2 px-3 text-right"
                            title="SUBTOTAL. The goods and ingredients at the price the bill charges for them, before any tax or charge. Same as Spend on a hand-entered bill; on a PO receipt it is the bill's full price.">Subtotal</th>
                        <th className="py-2 pl-3 text-right"
                            title="GRAND TOTAL — what we actually pay the vendor. Subtotal − discount + CGST + SGST + both cesses + TCS + delivery + round-off.">Grand Total</th>
                        {/* Derived, so after the Grand Total — see the identical
                            pair on the charge breakdown table below. */}
                        <th className="py-2 px-3 text-right border-l-2 border-[#E8D5C4]" title={TAX_VALUE_TITLE}>{TAX_VALUE_LABEL}</th>
                        <th className="py-2 pl-3 text-right" title={TAX_PERCENT_TITLE}>{TAX_PERCENT_LABEL}</th>
                      </tr></thead>
                      <tbody>
                        {items.length === 0 ? (
                          <tr><td colSpan={11 + PURCHASE_CHARGE_COLUMNS.length} className="py-6 text-center text-[#8B7355]">No items match.</td></tr>
                        ) : items.map((r, i) => (
                          // An unlinked-material row is TINTED, not hidden. Before
                          // 2026-09-10 the INNER JOIN removed it from this table and
                          // from every total above; it now shows its spend under a
                          // label that names the broken link. Amber = "this money is
                          // real and counted, the item record behind it is not".
                          <tr key={i} className={`border-b border-[#F7EEE3] last:border-0 ${r.unlinked ? 'bg-amber-50' : ''}`}>
                            <td className="py-2 pr-3 font-medium">{r.material_name}</td>
                            <td className="py-2 px-3 text-[#8B7355]">{r.category}</td>
                            <td className="py-2 px-3 text-right">{fmtNum(r.qty)} {r.unit}</td>
                            <td className="py-2 px-3 text-right">{fmtNum(r.count)}</td>
                            <td className="py-2 px-3 text-right">{fmtINR(r.avg_rate)}</td>
                            <td className="py-2 px-3 text-[#8B7355] whitespace-nowrap">{r.last_date}</td>
                            <td className="py-2 px-3 text-right font-semibold">{fmtINR(r.spend)}</td>
                            {PURCHASE_CHARGE_COLUMNS.map(c => {
                              const v = chargeCell(r, c);
                              return (
                                <td key={c.key} className={`py-2 px-3 text-right tabular-nums ${
                                  c.signed && (v || 0) < 0 ? 'text-red-700 font-semibold' : 'text-[#6B5744]'}`}>
                                  {fmtSignedINR(v)}
                                </td>
                              );
                            })}
                            <td className="py-2 px-3 text-right tabular-nums text-[#6B5744]">{fmtSignedINR(Number(r.bill_value) || 0)}</td>
                            <td className="py-2 pl-3 text-right font-bold text-[#af4408]">{fmtSignedINR(Number(r.total_amount) || 0)}</td>
                            <td className="py-2 px-3 text-right tabular-nums text-[#6B5744] border-l-2 border-[#F0E4D6]">{fmtSignedINR(gstValue(r))}</td>
                            <td className="py-2 pl-3 text-right tabular-nums font-semibold text-[#6B5744]"
                                title={TAX_PERCENT_TITLE + taxAppliedNote(r)}>{fmtTaxPercent(taxAppliedPercent(r))}</td>
                          </tr>
                        ))}
                      </tbody>
                      {/*
                        A FOOTER OVER THE ROWS THAT ARE ACTUALLY LISTED — which is
                        the search box's filtered set, not the period. It says so,
                        because a subtotal that looks like a total is how a reader
                        ends up quoting a filtered figure as the year's tax. With
                        the search box empty these are the period figures and they
                        equal the cards at the top of the page to the paisa.
                      */}
                      {items.length > 0 && (
                        <tfoot className="border-t-2 border-[#E8D5C4]">
                          <tr className="bg-[#FFFBF6] text-[12px]">
                            <td colSpan={6} className="py-2 pr-3 text-right font-bold text-[#6B5744]">
                              {itemSearch.trim()
                                ? `SUBTOTAL · the ${fmtNum(items.length)} item(s) matching “${itemSearch.trim()}”`
                                : `TOTAL · all ${fmtNum(items.length)} items in this range`}
                            </td>
                            <td className="py-2 px-3 text-right tabular-nums font-bold">{fmtINR(items.reduce((n, r) => n + (Number(r.spend) || 0), 0))}</td>
                            {PURCHASE_CHARGE_COLUMNS.map(c => (
                              <td key={c.key} className="py-2 px-3 text-right tabular-nums font-bold">
                                {fmtSignedINR(itemTotals[c.key])}
                              </td>
                            ))}
                            <td className="py-2 px-3 text-right tabular-nums font-bold">{fmtSignedINR(itemTotals.bill_value)}</td>
                            <td className="py-2 pl-3 text-right tabular-nums font-bold text-[#af4408]">{fmtSignedINR(itemTotals.total_amount)}</td>
                            {/* Σ(GST) and Σ(GST) ÷ Σ(taxed base) over the LISTED
                                items — the same money-weighted rate the breakdown
                                footer prints, never an average of percentages. */}
                            <td className="py-2 px-3 text-right tabular-nums font-bold border-l-2 border-[#E8D5C4]">{fmtSignedINR(gstValue(itemTaxTotals))}</td>
                            <td className="py-2 pl-3 text-right tabular-nums font-bold" title={TAX_PERCENT_TITLE + taxAppliedNote(itemTaxTotals)}>{fmtTaxPercent(taxAppliedPercent(itemTaxTotals))}</td>
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </div>
                </div>
              </>
            )}
            {/* "Spend = invoice total" was fine while Spend was the only money
                word on the page. With a Subtotal and a Grand Total beside it,
                "invoice total" reads like one of those two, so the three are
                named apart here instead. */}
            {/* RULING 115: the headline and the lists are the Grand Total now,
                so this line names that first. One line of text, no entity, no
                interpolation beside a source newline (see the SWC notes below). */}
            {/* Round 2: the sentences about the bar lists, the charge table and the
                item table are said only when those are on screen — an empty
                window shows none of them (same test as the branch above). */}
            <p className="text-[11px] text-[#8B7355]">Total Purchases = the Grand Total: what is payable to the vendors — subtotal − discount + every tax and charge. {s.total_spend === 0 ? '' : 'The bar lists and the taxes, cess and transport table above add up to it, and list vendors, categories, super-categories and payment modes largest Grand Total first (months stay in calendar order); their CSV files keep every column they had, Spend included, and only the order of their rows now follows the Grand Total. The Item-wise Purchase Report table keeps its own sort. '}Spend (booked into stock) = the booked cost of the purchase entries in the range — goods only, what stock valuation uses, and the figure the Purchases page shows. Subtotal = the same goods at the price the bill charges for them. {data.vendor && `Vendor: ${data.vendor}. `}{data.category && `Category: ${data.category}.`}</p>
          </>
        )}
        </>)}
      </div>
    </div>
  );
}

/* ───────────────────── Purchase log tab: the two views ─────────────────────
 * OWNER RULING 115 (2026-11-05). He downloaded this tab's file, added up its
 * Grand Total column for October and got ~₹1.36 crore against a Summary of
 * ₹45.7 lakh — "some Entries are Double". Nothing was saved twice: that file
 * lists the purchase order, the GRN bill AND the purchase entry for the same
 * goods, so any column added down counts one delivery two or three times.
 *
 * So the tab now OPENS on ITEM-WISE PURCHASES — one line per item bought, the
 * very lines the Summary adds up, each money column footing to its Summary
 * card — and the three-document log is kept, unchanged, one click away as
 * "All documents (audit)" for checking documents against each other.
 */
function LogTab({ from, to, setFrom, setTo, vendors, categories, presets }: {
  from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void;
  vendors: string[]; categories: string[]; presets: PresetChip[];
}) {
  const [mode, setMode] = useState<'itemwise' | 'audit'>('itemwise');
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => setMode('itemwise')}
          className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold border transition-colors ${
            mode === 'itemwise' ? 'bg-[#2D1B0E] text-white border-[#2D1B0E]' : 'bg-white text-[#2D1B0E] border-[#E8D5C4] hover:bg-[#FFF1E3]'}`}>
          <Package className="w-3.5 h-3.5" /> Item-wise purchases
        </button>
        {/* Deliberately the quieter button: it is the audit trail, not a total. */}
        <button onClick={() => setMode('audit')}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium border transition-colors ${
            mode === 'audit' ? 'bg-[#F4EFE9] text-[#2D1B0E] border-[#CDB9A4]' : 'bg-transparent text-[#8B7355] border-dashed border-[#D9C6B2] hover:bg-[#FFF1E3]'}`}>
          <ScrollText className="w-3.5 h-3.5" /> All documents (audit)
        </button>
        <p className="text-[11px] text-[#8B7355] basis-full sm:basis-auto">
          {mode === 'itemwise'
            ? 'One line per item bought. With no item filter set, every money column adds up to the Summary tab for the same dates and filters (the Summary has no item filter).'
            : 'Purchase orders, GRN bills and purchase entries side by side, for checking documents. The same goods appear more than once here — never add these up.'}
        </p>
      </div>
      {mode === 'itemwise'
        ? <ItemwisePurchases from={from} to={to} setFrom={setFrom} setTo={setTo} vendors={vendors} categories={categories} presets={presets} />
        : <PurchaseLog from={from} to={to} setFrom={setFrom} setTo={setTo} vendors={vendors} presets={presets} />}
    </div>
  );
}

/** Rows the browser paints before asking — same cap and same reason as the audit log's ROW_PAINT_CAP below. */
const ITEMWISE_PAINT_CAP = 600;

/** The money columns before GST %, and after it — the order the Excel file uses. */
const IW_BEFORE_PCT = ITEMWISE_MONEY_COLUMNS.filter(c => c.key === 'subtotal' || c.key === 'discount' || c.key === 'taxable');
const IW_AFTER_PCT = ITEMWISE_MONEY_COLUMNS.filter(c => !IW_BEFORE_PCT.includes(c));
/** Date … Rate: the text/quantity columns before the money. The footer's label spans these. */
const IW_LEAD_HEADS: { label: string; right?: boolean; title?: string }[] = [
  { label: 'Date' }, { label: 'Vendor' }, { label: 'Vendor Bill No' }, { label: 'GRN No' }, { label: 'Our Invoice ID' },
  { label: 'Item' }, { label: 'SKU' }, { label: 'Category' }, { label: 'Qty', right: true }, { label: 'Purchase Unit' },
  { label: 'Rate', right: true, title: ITEMWISE_RATE_TITLE },
];

/**
 * ITEM-WISE PURCHASES — the Purchase log tab's default view (ruling 115).
 *
 * Reads /api/reports/purchase-itemwise: one line per `purchases` row in the
 * window, through the Summary's own FROM / WHERE, so the footer IS the Summary
 * cards. The server also checks that, figure by figure, on every load and the
 * page prints the verdict — green with the Grand Total, or red naming what
 * disagrees. Vendor and category are the Summary's exact-match filters (not
 * the audit log's "contains"), because the point is that the two agree.
 */
function ItemwisePurchases({ from, to, setFrom, setTo, vendors, categories, presets }: {
  from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void;
  vendors: string[]; categories: string[]; presets: PresetChip[];
}) {
  const [vendor, setVendor] = useState('');
  const [category, setCategory] = useState('');
  const [materialId, setMaterialId] = useState('');
  const [materials, setMaterials] = useState<MaterialLite[]>([]);
  const [materialsError, setMaterialsError] = useState(false);
  const [data, setData] = useState<ItemwiseResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [downloadingInward, setDownloadingInward] = useState(false);
  const [paintAll, setPaintAll] = useState(false);
  /** Only the latest request may paint — a slow answer for old filters must not overwrite a newer one. */
  const seq = useRef(0);

  // Item filter needs ids — the same list, and the same non-fatal failure, as the audit log.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/inventory?scope=all', { cache: 'no-store' });
        if (!res.ok) { setMaterialsError(true); return; }
        const j = await res.json();
        setMaterials(Array.isArray(j.materials) ? j.materials : []);
      } catch { setMaterialsError(true); }
    })();
  }, []);

  const qs = useCallback((format: 'json' | 'xlsx') => {
    const p = new URLSearchParams({ from, to, format });
    if (vendor) p.set('vendor', vendor);
    if (category) p.set('category', category);
    if (materialId) p.set('material_id', materialId);
    return p.toString();
  }, [from, to, vendor, category, materialId]);

  const load = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true); setError(''); setPaintAll(false);
    try {
      const res = await fetch(`/api/reports/purchase-itemwise?${qs('json')}`, { cache: 'no-store' });
      if (my !== seq.current) return;
      // A failed load must never look like "no purchases" — clear the rows and say why.
      if (res.status === 401) { setError('Sign in required.'); setData(null); return; }
      if (res.status === 403) { setError('Management only — you don’t have access to purchase reports.'); setData(null); return; }
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as { error?: string }));
        if (my !== seq.current) return;
        setError(j?.error || `Failed to load the item-wise purchases (HTTP ${res.status}).`); setData(null); return;
      }
      const j = (await res.json()) as ItemwiseResponse;
      if (my !== seq.current) return;
      setData({ ...j, rows: Array.isArray(j.rows) ? j.rows : [] });
    } catch {
      if (my === seq.current) { setError('Network error — please try again.'); setData(null); }
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [qs]);

  useEffect(() => { load(); }, [load]);

  const download = async () => {
    setDownloading(true); setError('');
    try {
      const res = await fetch(`/api/reports/purchase-itemwise?${qs('xlsx')}`, { cache: 'no-store' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as { error?: string }));
        setError(j?.error || (res.status === 403 ? 'Management only — download refused.' : `Download failed (HTTP ${res.status}).`));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `purchases-itemwise-${from}_${to}.xlsx`; a.click();
      URL.revokeObjectURL(url);
    } catch { setError('Network error — download failed.'); }
    finally { setDownloading(false); }
  };

  // Owner ruling 127: the Recaho-style 38-column inward list for the selected
  // dates (all vendors, all items), built server-side by /api/reports/purchase-inward.
  const downloadInward = async () => {
    setDownloadingInward(true); setError('');
    try {
      const res = await fetch(`/api/reports/purchase-inward?${new URLSearchParams({ from, to }).toString()}`, { cache: 'no-store' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as { error?: string }));
        setError(j?.error || (res.status === 403 ? 'Management only — download refused.' : `Download failed (HTTP ${res.status}).`));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `purchase-inward_${from}_${to}.xlsx`; a.click();
      URL.revokeObjectURL(url);
    } catch { setError('Network error — download failed.'); }
    finally { setDownloadingInward(false); }
  };

  const rows = data?.rows || [];
  const shown = paintAll ? rows : rows.slice(0, ITEMWISE_PAINT_CAP);
  const t = data?.totals;
  const proof = data?.proof;
  const colCount = IW_LEAD_HEADS.length + ITEMWISE_MONEY_COLUMNS.length + 1;
  const itemFilter = !!data?.material_id;
  const bad = proof ? proof.checks.filter(c => !c.ok) : [];
  const bc = data?.bill_check;
  const fmtCheck = (kind: 'money' | 'count', v: number) => (kind === 'money' ? fmtSignedINR(v) : fmtNum(v));
  // Composed as whole strings: no interpolation ever sits beside a source newline (SWC).
  // The sentence names its BASIS — the dates and the vendor / category the
  // server applied — because the Summary tab keeps filters of its own, and a
  // bare "= Summary Grand Total" would point at whatever that tab shows.
  const iwFilters = [data?.vendor && `vendor ${data.vendor}`, data?.category && `category ${data.category}`].filter(Boolean).join(' and ');
  // One line reads "this 1 line", never "these 1 line"; no lines at all says
  // plainly that there is nothing to add up (round 2).
  const iwLines = proof ? (proof.lines === 1 ? 'this 1 line' : `these ${fmtNum(proof.lines)} lines`) : '';
  const proofText = proof
    ? (proof.lines === 0
      ? (itemFilter
        ? `No purchase lines for this item in these dates${iwFilters ? ` with ${iwFilters}` : ''} — nothing to add up.`
        : iwFilters
          ? `No purchase lines in these dates with ${iwFilters} — nothing to add up.`
          : 'No purchase lines in these dates (all vendors, all categories) — nothing to add up.')
      : itemFilter
      ? `Grand Total of ${iwLines} = ${fmtSignedINR(proof.grand_total)} — the Summary’s own arithmetic gives the same for this item${iwFilters ? ` with ${iwFilters}` : ''} (the Summary tab has no item filter). Every money column below adds up the same way (Taxable Value = Subtotal − Discount).`
      : iwFilters
        ? `Grand Total of ${iwLines} = ${fmtSignedINR(proof.grand_total)} = the Summary’s Grand Total for these dates with ${iwFilters} (set the same filter on the Summary tab to see it). Every money column below adds up to its Summary figure the same way (Taxable Value = Subtotal − Discount).`
        : `Grand Total of ${iwLines} = ${fmtSignedINR(proof.grand_total)} = Summary Grand Total for these dates (all vendors, all categories). Every money column below adds up to its Summary figure (Taxable Value = Subtotal − Discount).`)
    : '';
  const billText = bc
    ? (bc.compared
      ? (bc.differences.length === 0
        // With no bills the sentence above already says there is nothing to add up.
        ? (bc.bills === 0 ? '' : billMatchSentence(bc, false, fmtNum))
        : `${billsDoNot(bc.differences.length, fmtNum)} match the Purchase Bill Summary for the same dates — report it.`)
      // Round 3: with no lines there are no bills, and why bills were not
      // compared says nothing — the sentence above already says so plainly.
      : (bc.bills === 0 ? '' : bc.reason))
    : '';

  return (
    <div className="space-y-4">
      {/* Filters — the shared window, then this view's own vendor / category / item. */}
      <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">From</span>
            <input type="date" value={from} onChange={e => e.target.value && setFrom(e.target.value)} className="mt-1 block px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408]" /></label>
          <label className="block"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">To</span>
            <input type="date" value={to} onChange={e => e.target.value && setTo(e.target.value)} className="mt-1 block px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408]" /></label>
          <label className="block min-w-[160px]"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">Vendor</span>
            <select value={vendor} onChange={e => setVendor(e.target.value)} className="mt-1 block w-full px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408]">
              <option value="">All vendors</option>{vendors.map(v => <option key={v} value={v}>{v}</option>)}
            </select></label>
          <label className="block min-w-[160px]"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">Category</span>
            <select value={category} onChange={e => setCategory(e.target.value)} className="mt-1 block w-full px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408]">
              <option value="">All categories</option>{categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select></label>
          <div className="block min-w-[240px] flex-1"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">Item</span>
            <div className="mt-1"><MaterialTypeahead materials={materials} value={materialId} onPick={setMaterialId} compact={false} showStock={false} placeholder="All items — type name, SKU or category…" /></div>
            {materialsError && <p className="text-[10px] text-amber-700 mt-0.5">Item list didn’t load — showing all items.</p>}</div>
          <button onClick={download} disabled={downloading || !data}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-60 text-white">
            {downloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileSpreadsheet className="w-3.5 h-3.5" />} Download Excel
          </button>
          <div className="flex flex-col items-start">
            <span className="text-[10px] text-[#8B7355] mb-1 max-w-[320px]">Recaho's 38 columns + our PINV · these dates, no filters · total = Grand Total · Liquor Store bills on their own sheet</span>
            <button onClick={downloadInward} disabled={downloadingInward || !from || !to}
              title="Purchase Inward data in the Recaho layout for the From–To dates (all vendors, all items). Its TOTAL INWARD AMOUNT column adds up to the Purchase Report Grand Total for those dates. Liquor (TGBCL) bills recorded in the Liquor Store go on a separate “Liquor Inward” sheet whose total is their Net Indent — never added to that Grand Total. Liquor booked as an ordinary purchase is a purchase line, so it stays in the Grand Total, as on this report."
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold border border-[#af4408] text-[#af4408] bg-white hover:bg-[#FFF1E3] disabled:opacity-60">
              {downloadingInward ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileSpreadsheet className="w-3.5 h-3.5" />} Purchase Inward (Excel)
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {presets.map(p => (
            <button key={p.label} onClick={p.apply} title={p.title}
              className={`px-3 py-1.5 rounded-lg text-xs border text-left ${p.active
                ? 'bg-[#af4408] text-white border-[#af4408]'
                : 'bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]'}`}>
              <span className="block font-semibold">{p.label}</span>
              <span className={`block text-[10px] tabular-nums ${p.active ? 'text-white/85' : 'text-[#8B7355]'}`}>{p.window}</span>
            </button>
          ))}
          {(vendor || category || materialId) && (
            <button onClick={() => { setVendor(''); setCategory(''); setMaterialId(''); }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium border bg-white text-[#af4408] border-[#E8D5C4] hover:bg-[#FFF1E3]">Clear filters</button>
          )}
        </div>
      </div>

      {error && <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">{error}</div>}

      {/* THE PROOF — computed on the server from the same query, every load. */}
      {proof && (proof.ok ? (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm text-emerald-900 flex gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-700" />
          <div className="min-w-0">
            <p><strong>{proofText}</strong></p>
            {billText && <p className={`text-[12px] mt-1 ${bc?.compared && bc.differences.length > 0 ? 'text-red-800 font-semibold' : 'text-emerald-800'}`}>{billText}</p>}
          </div>
        </div>
      ) : (
        <div className="bg-red-50 border-2 border-red-300 rounded-xl px-4 py-3 text-sm text-red-900 flex gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-red-600" />
          <div className="min-w-0">
            <p><strong>These lines do not add up to the Summary.</strong> Report it — do not reconcile it by hand. The figures that differ:</p>
            <ul className="mt-1 space-y-0.5 font-mono text-[12px]">
              {bad.map(c => <li key={c.figure}>{`${c.figure}: lines ${fmtCheck(c.kind, c.lines)} vs Summary ${fmtCheck(c.kind, c.summary)}`}</li>)}
            </ul>
          </div>
        </div>
      ))}

      {/* Round 3: the row re-flows on the width it actually has, so a label
          and its amount ("booked into stock ₹44,21,109.49") always share one
          line: one card per row on a phone, two from 28rem of room, four from
          56rem. In four columns from the window's 768px the cards had ~126px of
          text width and "booked into stock" ended a line alone (measured at
          768, 1024, 375 and 320px). The Taxes pairs stay inline-blocks, so
          when both cannot share a line the second pair moves down whole. */}
      {data && t && (
        <div className="@container">
        <div className="grid grid-cols-1 @md:grid-cols-2 @4xl:grid-cols-4 gap-3">
          <Card icon={<ShoppingCart className="w-4 h-4" />} label="Lines" value={fmtNum(data.lines)}
            sub={`${fmtNum(data.bills)} bill${data.bills === 1 ? '' : 's'} · ${fmtNum(data.days)} day${data.days === 1 ? '' : 's'}`} />
          <Card icon={<Package className="w-4 h-4" />} label="Subtotal" value={fmtSignedINR(t.subtotal)}
            sub={`less discount ${fmtSignedINR(t.discount)}`} />
          <Card icon={<Receipt className="w-4 h-4" />} label="Taxes (CGST+SGST)" value={fmtSignedINR(r2(t.cgst + t.sgst))}
            sub={<><span className="inline-block">{`CGST ${fmtSignedINR(t.cgst)}\u00A0·`}</span>{' '}<span className="inline-block">{`SGST ${fmtSignedINR(t.sgst)}`}</span></>} />
          <Card icon={<Sigma className="w-4 h-4" />} label="Grand Total" value={fmtSignedINR(t.grand_total)}
            sub={`booked into stock ${fmtSignedINR(t.booked)}`} tone="accent" />
        </div>
        </div>
      )}

      {data && data.understated_lines > 0 && (
        <div className="bg-red-50 border-2 border-red-300 rounded-xl px-4 py-3 text-sm text-red-900 flex gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-red-600" />
          {/* Round 3: plural forms for many lines, and only the GRN line's own
              tax and charges are missing — a charge stored on the purchase row
              itself (a delivery share) still shows on the line. */}
          <p>{data.understated_lines === 1
            ? '1 line was booked from a goods receipt whose GRN line (the bill document) has since been deleted. The tax and any charges recorded only on that GRN line are missing, so the Grand Total is UNDERSTATED by an amount that cannot be known from here — the Summary shows the same short figure. Do not pay a vendor against it; report it.'
            : `${fmtNum(data.understated_lines)} lines were booked from goods receipts whose GRN lines (the bill documents) have since been deleted. The tax and any charges recorded only on those GRN lines are missing, so the Grand Total is UNDERSTATED by an amount that cannot be known from here — the Summary shows the same short figure. Do not pay a vendor against it; report it.`}</p>
        </div>
      )}

      {data?.truncated && (
        <div className="bg-[#af4408] text-white rounded-xl px-4 py-3 text-sm font-semibold flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {`Only the first ${fmtNum(data.row_cap)} of ${fmtNum(data.lines)} lines were sent to the screen. The totals and the Excel file still cover every line — narrow the dates or filters to see the rest here.`}
        </div>
      )}

      <div className="bg-white border border-[#E8D5C4] rounded-xl shadow-sm p-4 sm:p-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
          <h2 className="text-sm font-bold flex items-center gap-2"><span className="text-[#af4408]"><Package className="w-4 h-4" /></span>
            Item-wise purchases — one line per item bought
            <span className="text-[11px] text-[#8B7355] font-normal">{`(${fmtNum(data?.lines ?? 0)} line${(data?.lines ?? 0) === 1 ? '' : 's'})`}</span></h2>
          {loading && <span className="text-xs text-[#8B7355] inline-flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</span>}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm whitespace-nowrap">
            <thead><tr className="text-left text-[11px] uppercase text-[#8B7355] border-b border-[#F0E4D6]">
              {IW_LEAD_HEADS.map((h, i) => (
                <th key={h.label} className={`py-2 ${i === 0 ? 'pr-3' : 'px-3'}${h.right ? ' text-right' : ''}`} title={h.title}>{h.label}</th>
              ))}
              {IW_BEFORE_PCT.map(c => <th key={c.key} className="py-2 px-3 text-right" title={c.title}>{c.header}</th>)}
              <th className="py-2 px-3 text-right" title="GST charged on this line as a % of the value it was charged on. Shows — where no GST was recorded, never 0%.">GST %</th>
              {IW_AFTER_PCT.map(c => (
                <th key={c.key} className={`py-2 ${c.key === 'booked' ? 'pl-3' : 'px-3'} text-right${c.key === 'grand_total' ? ' text-[#af4408]' : ''}`} title={c.title}>{c.header}</th>
              ))}
            </tr></thead>
            <tbody>
              {loading && rows.length === 0 ? (
                <tr><td colSpan={colCount} className="py-6 text-center text-[#8B7355] animate-pulse">Loading item-wise purchases…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={colCount} className="py-6 text-center text-[#8B7355]">{error ? 'Not loaded — see the message above.' : 'No purchases match these dates and filters.'}</td></tr>
              ) : shown.map((r: ItemwiseRow, i) => (
                <tr key={i} className={`border-b border-[#F7EEE3] last:border-0 ${r.unlinked ? 'bg-amber-50' : ''}`}>
                  <td className="py-2 pr-3 text-[#6B5744] tabular-nums">{r.date || '—'}</td>
                  <td className="py-2 px-3 font-medium">{r.vendor || '—'}</td>
                  <td className="py-2 px-3 text-[#6B5744]">{r.bill_no || '—'}</td>
                  <td className="py-2 px-3 text-[#6B5744]">{r.grn_no || '—'}</td>
                  <td className="py-2 px-3 text-[#6B5744]">{r.invoice_id || '—'}</td>
                  <td className="py-2 px-3 font-medium whitespace-normal min-w-[180px]">{r.item || '—'}</td>
                  <td className="py-2 px-3 text-[11px] text-[#8B7355]">{r.sku || '—'}</td>
                  <td className="py-2 px-3 text-[#8B7355]">{r.category || '—'}</td>
                  <td className="py-2 px-3 text-right tabular-nums">{fmtQty(r.qty)}</td>
                  <td className="py-2 px-3 text-[#8B7355]">{r.unit || '—'}</td>
                  <td className="py-2 px-3 text-right tabular-nums">{fmtINR(r.rate)}</td>
                  {IW_BEFORE_PCT.map(c => <td key={c.key} className="py-2 px-3 text-right tabular-nums text-[#6B5744]">{fmtSignedINR(r[c.key])}</td>)}
                  <td className="py-2 px-3 text-right tabular-nums font-semibold text-[#6B5744]"
                      title={r.understated
                        ? `GST unknown: this line was booked from a goods receipt whose GRN line (the bill document) has since been deleted, so its GST cannot be read from here.${r.gst_percent == null ? ' Shown as —, never 0%.' : ''}`
                        : r.gst_percent == null ? 'No GST was recorded on this line — shown as —, never 0%.' : (r.gst_base_accepted ? acceptedBaseRowNote(undefined, undefined, true) : undefined)}>
                    {fmtTaxPercent(r.gst_percent)}
                  </td>
                  {IW_AFTER_PCT.map(c => {
                    const v = r[c.key];
                    if (c.key === 'grand_total') {
                      return (
                        <td key={c.key} className={`py-2 px-3 text-right tabular-nums font-bold ${r.understated ? 'text-red-700' : 'text-[#af4408]'}`}
                            title={r.understated ? 'UNDERSTATED — this line was booked from a goods receipt whose GRN line has been deleted, so the tax and any charges recorded only on that GRN line are missing. Report it.' : undefined}>
                          {fmtSignedINR(v)}
                          {r.understated && <span className="block text-[10px] font-bold">UNDERSTATED</span>}
                        </td>
                      );
                    }
                    return (
                      <td key={c.key} className={`py-2 ${c.key === 'booked' ? 'pl-3' : 'px-3'} text-right tabular-nums ${
                        c.signed && v < 0 ? 'text-red-700 font-semibold' : 'text-[#6B5744]'}`}>{fmtSignedINR(v)}</td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
            {/* THE FOOTER IS THE SUMMARY. Server totals over EVERY line in the
                window, not a sum of the rows painted above — so with the row cap
                it can exceed what is on screen, and it says so. */}
            {t && rows.length > 0 && (
              <tfoot className="border-t-2 border-[#E8D5C4]">
                <tr className="bg-[#FFFBF6] text-[12px]">
                  <td colSpan={IW_LEAD_HEADS.length} className="py-2 pr-3 text-right font-bold text-[#6B5744]">
                    {(data?.lines ?? 0) === 1 ? 'TOTAL · the 1 line' : `TOTAL · all ${fmtNum(data?.lines ?? 0)} lines`}
                  </td>
                  {IW_BEFORE_PCT.map(c => <td key={c.key} className="py-2 px-3 text-right tabular-nums font-bold">{fmtSignedINR(t[c.key])}</td>)}
                  <td className="py-2 px-3" title="A rate is not added up." />
                  {IW_AFTER_PCT.map(c => (
                    <td key={c.key} className={`py-2 ${c.key === 'booked' ? 'pl-3' : 'px-3'} text-right tabular-nums font-bold${c.key === 'grand_total' ? ' text-[#af4408]' : ''}`}>{fmtSignedINR(t[c.key])}</td>
                  ))}
                </tr>
                <tr>
                  <td colSpan={colCount} className="pt-2 text-[11px] text-[#8B7355] whitespace-normal leading-relaxed">
                    {/* Round 3: "not only the rows painted above" is said only when
                        some lines really are not painted (screen cap or server cap). */}
                    {(data?.lines ?? 0) === 1
                      ? 'Totals are over the 1 line in these dates and filters.'
                      : shown.length < (data?.lines ?? 0)
                        ? `Totals are over all ${fmtNum(data?.lines ?? 0)} lines in these dates and filters, not only the rows painted above.`
                        : `Totals are over all ${fmtNum(data?.lines ?? 0)} lines in these dates and filters.`}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        {rows.length > shown.length && (
          <div className="pt-3 flex flex-wrap items-center gap-2 text-xs text-[#8B7355]">
            <Info className="w-3.5 h-3.5 shrink-0" />
            {`Showing the first ${fmtNum(shown.length)} of ${fmtNum(rows.length)} lines on screen — the Excel file has all of them.`}
            <button onClick={() => setPaintAll(true)} className="px-2.5 py-1 rounded-md border border-[#E8D5C4] text-[#af4408] hover:bg-[#FFF1E3] font-semibold">{`Show all ${fmtNum(rows.length)}`}</button>
          </div>
        )}
      </div>

      {/* WHAT A LINE IS, in plain words. Every sentence is a whole string (no
          interpolation beside a source newline, no HTML entity — SWC). */}
      <div className="text-[11px] text-[#8B7355] leading-relaxed space-y-1">
        <p>One line = one item on one purchase entry. With no item filter set, these are the same lines the Summary tab adds up for the same dates and filters, nothing added and nothing left out. Purchase orders are not listed — an order is not a purchase — and goods received against a PO appear once, with the GRN bill’s tax and charges on the line, so nothing is counted twice.</p>
        <p>Grand Total = Subtotal − Discount + CGST + SGST + both cesses + TCS + Delivery + MRP Round-off: what is payable to the vendor. Booked into stock = what was recorded into stock for the line, exactly as stored — the figure stock valuation uses; on goods received against a PO it can be lower than the Subtotal: where the discount was taken off the booked rate, or where part of the delivery was rejected at the door (the GRN bill’s Subtotal counts everything received). Rate is the rate booked into stock, so on those lines Qty × Rate can differ from the Subtotal. GST % shows — where no GST was recorded, never 0% (in the Excel file that cell is empty).</p>
        <p>As on the Summary tab: some older bills were entered in bulk from a vendor sheet with the tax already inside the line total and never split out. Those lines show no GST of their own, so their Subtotal includes that tax.</p>
        {data && data.part_rejected_lines > 0 && <p>{`GST %: ${acceptedBaseTotalNote(data.part_rejected_lines, true)}`}</p>}
        <p>Download Excel gives this list plus Date-wise, Bill-wise and Totals sheets, each adding up to the same figures. To see purchase orders, GRN bills and purchase entries side by side, use All documents (audit) above.</p>
      </div>
    </div>
  );
}

/* ────────────────────────── Purchase log (itemwise) ──────────────────────────
 * A LOG, not an aggregate: one row per item per bill, with Purchases, purchase
 * orders and GRN bills interleaved and each row stamped with the source it came
 * from. ("Purchase orders", not "PO bills", on screen: an order is not a bill.)
 * The date range is shared with the Summary view so switching tabs keeps the
 * same window; every other filter is local to this section.
 */

const SOURCE_OPTIONS = [
  { k: 'all', label: 'All sources' },
  { k: 'purchase', label: 'Purchases' },
  { k: 'po', label: 'Purchase orders' },
  { k: 'grn', label: 'GRN bills' },
] as const;
type SourceFilter = (typeof SOURCE_OPTIONS)[number]['k'];

/** Visual stamp so a row's origin is unmistakable when the three are interleaved. */
function SourceBadge({ source }: { source: LogSource }) {
  const style = source === 'PURCHASE' ? 'bg-[#FFF1E3] text-[#af4408] border-[#F0CDAE]'
    : source === 'PO' ? 'bg-[#F4EFE9] text-[#6B5744] border-[#E8D5C4]'
    : 'bg-[#EDF4EE] text-[#3F6B4C] border-[#CFE2D4]';
  return <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-bold tracking-wide ${style}`}>{source}</span>;
}

/** Rows the browser will paint before asking for confirmation — a full year of
 *  purchases is thousands of lines and painting them all locks the tab. */
const ROW_PAINT_CAP = 600;

/**
 * THE TABLE'S COLUMN ORDER (owner #5, ruling 93, 2026-10-29): Date and Doc No,
 * then the owner's three — Tax % Applied (GST), Tax Value (GST) and the per-BILL
 * Grand Total — at the FRONT, then everything that used to follow Doc No, in
 * its old order. On screen only: the CSV keeps its column order and appends
 * the bill total at the end (src/app/api/reports/purchase-log/route.ts).
 *
 * FRONT_HEADS lead the table; the tfoot's first cell spans exactly these.
 * The owner's three are rendered explicitly right after them.
 */
const FRONT_HEADS: { label: string }[] = [
  { label: 'Source' }, { label: 'Date' }, { label: 'Doc No' },
];

/**
 * The columns between the owner's three and Value, in order. The tfoot's label
 * cell spans exactly these, right-aligned against the Value figure, so
 * inserting a column here keeps every totals figure under its own heading. A
 * hard-coded colSpan would put the Value total under Vendor the first time
 * somebody adds a column.
 */
const LEAD_HEADS: { label: string; right?: boolean }[] = [
  { label: 'Invoice ID (ours)' }, { label: 'Bill No (vendor)' }, { label: 'Vendor' },
  { label: 'Item' }, { label: 'Category' },
  // Right-aligned but NEVER totalled: qty is in each line's own purchase unit
  // and a rate is Rs per unit. See the no-total notes under the table.
  { label: 'Qty', right: true }, { label: 'Rate', right: true },
];

/** The owner's three front columns, counted once for colCount. */
const OWNER_FRONT_COLS = 3;

/**
 * Hover text for the Bill Grand Total column. Literal glyphs only (see the
 * SWC note in the paragraph under the cards).
 */
const BILL_GT_TITLE =
  'GRAND TOTAL OF THE WHOLE BILL this line sits on: Subtotal − discount + CGST + SGST + both cesses + TCS + '
  + 'delivery + MRP round-off, over every line of that bill — the Purchase Bill Summary’s Grand Total for the '
  + 'same bill and period. The SAME figure repeats on every line of the bill (and on the PURCHASE and the GRN '
  + 'row of one delivery), so never add this column down; it has no total. Blank on PO lines: an order is not a bill.';

/** Per-cell hover for Bill Grand Total: which bill, how many lines — or why it is blank. */
function billGtTitle(r: LogRow): string {
  if (r.bill_grand_total == null) return r.bill_grand_total_reason || BILL_GT_TITLE;
  const n = r.bill_lines ?? 0;
  // A vendor-day group (no bill number anywhere) is the Bill Summary's "bill"
  // for that vendor's unnumbered purchases of the day — said as such.
  const where = isVendorDayBill(r) ? 'in this vendor-day group' : 'on this bill';
  const head = `${r.bill_label ? `${r.bill_label} — ` : ''}${n} line${n === 1 ? '' : 's'} ${where}.`;
  // A SHORT figure says so first, before anything that describes it as a total.
  return `${r.bill_understated_note ? `${r.bill_understated_note}\n\n` : ''}${head}\n\n${BILL_GT_TITLE}`;
}

/** The Bill Summary keys an unnumbered vendor-day group 'DAY:…' (src/lib/purchase-log.ts BILL_KEY_SQL). */
function isVendorDayBill(r: LogRow): boolean {
  return String(r.bill_key || '').startsWith('DAY:');
}

/**
 * The Tax Value column's hover IN THIS LOG. The shared text closes by saying
 * an em dash means "unavailable (a PO line …)" — true on the reports that print
 * ₹0 for an untaxed line, but this log prints a dash there too (ruling 93), so
 * on its own it would explain every untaxed line as a PO line. Said once, here,
 * on the header and every cell; the cell adds which case it is.
 */
const LOG_TAX_VALUE_TITLE = `${TAX_VALUE_TITLE}\n\nIN THIS LOG an em dash ALSO means NO GST WAS ENTERED on the `
  + 'line — shown blank, not ₹0, because a zero would claim the vendor charged none. Hover a dash for which it is.';

/** Why one row's tax cell is blank — the THIS ROW line under the column's hover. */
function blankTaxWhy(r: LogRow, kind: 'value' | 'percent'): string {
  if (r.source === 'PO') {
    return 'THIS ROW: a PO line — an order is not a bill, so it has no tax figures at all. Blank, never ₹0 / 0.00%.';
  }
  if (r.tax_unavailable) {
    return 'THIS ROW: UNAVAILABLE, not zero — a purchase booked straight from a goods receipt whose GRN line (the bill '
      + 'document, where its GST is recorded) has since been deleted, so its tax cannot be read.';
  }
  if (kind === 'percent' && r.tax_value != null) {
    return 'THIS ROW: GST was recorded, but the value less discount is zero or negative, so a percentage would mean nothing.';
  }
  return 'THIS ROW: no GST was entered on this line — shown blank, not ₹0 / 0.00%, because a zero would claim the '
    + 'vendor charged none. On a line from the old tax-inclusive import any tax sits inside Value and was never split out.';
}

/**
 * Per-cell hover for the two tax columns: the column's text, then what is
 * true of THIS row — why it is blank (no GST entered, a PO line, or a deleted
 * GRN line), that a PURCHASE row booked by a PO receive read its figure off the
 * GRN line (its own CGST / SGST columns further right show the row's recorded
 * ₹0, unless an amendment of the GRN line wrote GST onto the row), and that a
 * part-rejected receipt's rate is struck on the
 * ACCEPTED value — so no two cells ever read as a contradiction.
 */
function taxCellTitle(r: LogRow, kind: 'value' | 'percent'): string {
  const base = kind === 'value' ? LOG_TAX_VALUE_TITLE : TAX_PERCENT_TITLE;
  const notes: string[] = [];
  const blank = kind === 'value' ? r.tax_value == null : r.tax_percent == null;
  if (blank) notes.push(blankTaxWhy(r, kind));
  if (r.tax_from_grn) {
    const ownGst = (r.cgst ?? 0) + (r.sgst ?? 0);
    notes.push(`THIS ROW: read off its GRN line${r.link_key ? ` (${r.link_key})` : ''} — the bill document. `
      + 'This purchase row was booked straight from a goods receipt with no invoice number of ours (as a PO receive '
      + 'books its lines), so the GST is read from the GRN line. '
      + (ownGst === 0
        ? 'The row recorded none of its own: its CGST / SGST columns show what the row itself recorded (₹0).'
        : 'An amendment of that GRN line has since written CGST / SGST onto this row as well, and its own CGST / SGST '
          + 'columns show what the row recorded.'));
  }
  if (kind === 'percent' && !blank && r.tax_base_accepted) notes.push(acceptedBaseRowNote());
  return notes.length ? `${base}\n\n${notes.join('\n\n')}` : base;
}

/**
 * A source's Tax Value / Tax % totals as a TaxAppliedRow, on the same
 * bill-document basis as the row cells. Blank, never ₹0, when the source
 * carried no GST at all (ruling 93).
 */
function sourceTax(mm: SourceMoney) {
  return {
    gst: mm.gst_value == null || mm.gst_value === 0 ? null : mm.gst_value,
    taxed_bill_value: mm.gst_taxed_bill_value ?? null,
    taxed_lines: mm.gst_taxed_lines ?? null,
    lines: mm.lines,
  };
}

/** The charge columns. `k` indexes BOTH LogRow (the cell) and SourceMoney (the total). */
const CHARGE_COLS: { k: ChargeKey; label: string }[] = [
  { k: 'discount', label: 'Discount' }, { k: 'cgst', label: 'CGST' }, { k: 'sgst', label: 'SGST' },
  { k: 'special_excise_cess', label: 'Excise/Cess' }, { k: 'compensation_cess', label: 'Comp. Cess' },
  { k: 'tcs', label: 'TCS' },
  { k: 'delivery_charges', label: 'Delivery' }, { k: 'mrp_round_off', label: 'MRP Round-off' },
];

/** Source order everywhere on this page: spend first, then its bill, then intent. */
const SOURCE_ORDER: LogSource[] = ['PURCHASE', 'GRN', 'PO'];

const SOURCE_MEANING: Record<LogSource, string> = {
  PURCHASE: 'booked spend',
  GRN: 'the vendor bills behind those purchases',
  PO: 'ordered, not spent',
};

function PurchaseLog({ from, to, setFrom, setTo, vendors, presets }: {
  from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void; vendors: string[];
  /** Built by the parent so BOTH tabs offer the same windows. See PresetChip. */
  presets: PresetChip[];
}) {
  const [vendor, setVendor] = useState('');
  const [vendorQ, setVendorQ] = useState('');   // debounced copy — see below
  const [materialId, setMaterialId] = useState('');
  const [source, setSource] = useState<SourceFilter>('all');
  const [materials, setMaterials] = useState<MaterialLite[]>([]);
  const [data, setData] = useState<LogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);
  /**
   * DEFAULT ON, 2026-09-10. The charge columns existed on this log before today
   * but arrived hidden, so the owner opened the page, did not see tax anywhere,
   * and concluded the report did not have it. A column nobody knows to tick is
   * not a column. The checkbox stays — the table is wide and somebody reading
   * quantities wants it back — but the default now shows the figures.
   */
  const [showCharges, setShowCharges] = useState(true);
  const [paintAll, setPaintAll] = useState(false);

  // Item filter needs ids, not names — the API filters on material_id.
  // Non-fatal: if the list fails the log still loads unfiltered, but say so
  // rather than leave an item picker that silently finds nothing.
  const [materialsError, setMaterialsError] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/inventory?scope=all', { cache: 'no-store' });
        if (!res.ok) { setMaterialsError(true); return; }
        const j = await res.json();
        setMaterials(Array.isArray(j.materials) ? j.materials : []);
      } catch { setMaterialsError(true); }
    })();
  }, []);

  // The vendor box is free text, so without this every keystroke would re-run a
  // multi-thousand-row query against a live production DB.
  useEffect(() => {
    const id = setTimeout(() => setVendorQ(vendor.trim()), 400);
    return () => clearTimeout(id);
  }, [vendor]);

  const qs = useCallback((format: 'json' | 'csv') => {
    const p = new URLSearchParams({ from, to, source, format });
    if (vendorQ) p.set('vendor', vendorQ);
    if (materialId) p.set('material_id', materialId);
    return p.toString();
  }, [from, to, source, vendorQ, materialId]);

  const load = useCallback(async () => {
    setLoading(true); setError(''); setPaintAll(false);
    try {
      const res = await fetch(`/api/reports/purchase-log?${qs('json')}`, { cache: 'no-store' });
      // A failed load must never look like "no purchases" — clear the rows and say why.
      if (res.status === 401) { setError('Sign in required.'); setData(null); return; }
      if (res.status === 403) { setError('Management only — you don’t have access to the purchase log.'); setData(null); return; }
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as any));
        setError(j?.error || `Failed to load the purchase log (HTTP ${res.status}).`); setData(null); return;
      }
      const j = (await res.json()) as LogResponse;
      setData({ ...j, rows: Array.isArray(j.rows) ? j.rows : [] });
    } catch { setError('Network error — please try again.'); setData(null); }
    finally { setLoading(false); }
  }, [qs]);

  useEffect(() => { load(); }, [load]);

  const download = async () => {
    setDownloading(true); setError('');
    try {
      const res = await fetch(`/api/reports/purchase-log?${qs('csv')}`, { cache: 'no-store' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as any));
        setError(j?.error || (res.status === 403 ? 'Management only — download refused.' : `Download failed (HTTP ${res.status}).`));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `purchase-log-${from}_${to}.csv`; a.click();
      URL.revokeObjectURL(url);
    } catch { setError('Network error — download failed.'); }
    finally { setDownloading(false); }
  };

  const rows = data?.rows || [];
  const shown = paintAll ? rows : rows.slice(0, ROW_PAINT_CAP);
  const t = data?.totals;
  const money = t?.money;
  // FRONT_HEADS + the owner's three (Tax % Applied (GST), Tax Value (GST), Bill
  // Grand Total) + LEAD_HEADS + Value + Total Amount + Grand Total + Rejected +
  // charges + Link key. The owner's three are OUTSIDE the showCharges condition
  // because they render whether or not the charge block is shown — see the <th> trio.
  const colCount = FRONT_HEADS.length + OWNER_FRONT_COLS + LEAD_HEADS.length + 4
    + (showCharges ? CHARGE_COLS.length : 0) + 1;
  // The Bill Grand Total proof. mismatched > 0 is a defect and is said in red.
  const billCheck = t?.bill_grand_total_check;
  // Only sources that actually have lines get a totals row. A source the filter
  // excluded has no business printing "0 lines, ₹0" under a spend column.
  const footSources = SOURCE_ORDER.filter(s => (money?.[s]?.lines ?? 0) > 0);

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">From</span>
            <input type="date" value={from} onChange={e => e.target.value && setFrom(e.target.value)} className="mt-1 block px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408]" /></label>
          <label className="block"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">To</span>
            <input type="date" value={to} onChange={e => e.target.value && setTo(e.target.value)} className="mt-1 block px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408]" /></label>
          {/* Free text + datalist, not a <select>: PO and GRN bills carry vendors
              that may never appear on a `purchases` row, so a fixed list would hide them. */}
          <label className="block min-w-[180px]"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">Vendor</span>
            <input list="purchase-log-vendors" value={vendor} onChange={e => setVendor(e.target.value)} placeholder="All vendors"
              className="mt-1 block w-full px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408]" />
            <datalist id="purchase-log-vendors">{vendors.map(v => <option key={v} value={v} />)}</datalist></label>
          <div className="block min-w-[240px] flex-1"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">Item</span>
            <div className="mt-1"><MaterialTypeahead materials={materials} value={materialId} onPick={setMaterialId} compact={false} showStock={false} placeholder="All items — type name, SKU or category…" /></div>
            {materialsError && <p className="text-[10px] text-amber-700 mt-0.5">Item list didn’t load — showing all items.</p>}</div>
          <label className="block min-w-[150px]"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">Source</span>
            <select value={source} onChange={e => setSource(e.target.value as SourceFilter)} className="mt-1 block w-full px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408]">
              {SOURCE_OPTIONS.map(o => <option key={o.k} value={o.k}>{o.label}</option>)}
            </select></label>
          <button onClick={download} disabled={downloading}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-60 text-white">
            {downloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />} Download CSV
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {/* THE PARENT'S PRESETS, NOT A SECOND LIST OF THIS TAB'S OWN. They
              used to be a shorter, differently-ordered copy — same page, two
              tabs, three presets here and four there — which is how a window
              that looked identical on both tabs could quietly differ. Widest
              first, each printing the dates it applies; see the parent memo. */}
          {presets.map(p => (
            <button key={p.label} onClick={p.apply} title={p.title}
              className={`px-3 py-1.5 rounded-lg text-xs border text-left ${p.active
                ? 'bg-[#af4408] text-white border-[#af4408]'
                : 'bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]'}`}>
              <span className="block font-semibold">{p.label}</span>
              <span className={`block text-[10px] tabular-nums ${p.active ? 'text-white/85' : 'text-[#8B7355]'}`}>{p.window}</span>
            </button>
          ))}
          <span className="mx-1 w-px h-5 bg-[#F0E4D6]" />
          <label className="inline-flex items-center gap-1.5 text-xs text-[#6B5744] cursor-pointer">
            <input type="checkbox" checked={showCharges} onChange={e => setShowCharges(e.target.checked)} className="accent-[#af4408]" />
            Show charge columns
          </label>
          {(vendor || materialId || source !== 'all') && (
            <button onClick={() => { setVendor(''); setMaterialId(''); setSource('all'); }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium border bg-white text-[#af4408] border-[#E8D5C4] hover:bg-[#FFF1E3]">Clear filters</button>
          )}
        </div>
      </div>

      {error && <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">{error}</div>}

      {/* THE three totals — deliberately never added up. This warning is the most
          important text on the page: without it the totals get summed and the
          same goods get counted more than once. */}
      {t && (
        <div className="space-y-2">
          {/* THE caveat. Placed BEFORE the numbers it qualifies, in red (not the
              amber used for the "don't add these totals" note below) so it reads
              as a data-quality warning, not routine guidance. Wording + the live
              figure for this exact window both come from the server
              (t.goods_value_caveat, src/lib/purchase-log.ts) — the CSV download
              renders the identical string, so screen and file cannot drift. */}
          {t.goods_value_caveat && (
            <div className="bg-red-50 border-2 border-red-300 rounded-xl px-4 py-3 text-sm text-red-900 flex gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-red-600" />
              <p><strong>⚠ Read before using the figures below.</strong> {t.goods_value_caveat}</p>
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {/* Two PURCHASE cards, never one. "Total" was ambiguous and that
                ambiguity is the whole reason the figure looked missing: goods
                value and the after-tax figure differ by the tax and charges the
                rows record, and only naming both makes either safe to quote. */}
            <Card icon={<ShoppingCart className="w-4 h-4" />} label="Purchases — goods value" value={fmtINR(t.purchase_value)} sub="source = PURCHASE · before tax & charges · ⚠ see caveat above" tone="accent" />
            {/* money?.X?.y, both links optional: an older/cached payload without
                `money` must degrade to an em dash, never to a thrown render that
                blanks the whole report. */}
            {/* "grand total", not "total amount" (owner ruling 98): these two
                figures are the Grand Total column's totals — the tax and charges
                each row records included (a PO-booked purchase row usually
                records no GST of its own, hence "see caveat"). Total Amount is
                now the before-tax column. */}
            <Card icon={<Sigma className="w-4 h-4" />} label="Purchases — grand total" value={fmtINRorDash(money?.PURCHASE?.bill_amount)} sub="incl. the tax & charges the purchase rows record · ⚠ see caveat above" tone="accent" />
            <Card icon={<Building2 className="w-4 h-4" />} label="GRN bills — grand total" value={fmtINRorDash(money?.GRN?.bill_amount)} sub={`source = GRN · goods ${fmtINR(t.grn_value)}`} />
            <Card icon={<Package className="w-4 h-4" />} label="Purchase orders — goods value" value={fmtINR(t.po_value)} sub="source = PO · ordered, no bill amount yet" />
          </div>

          {money && <TotalsPanel money={money} notes={t.no_total_notes || []} /> }
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-900 flex gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <p>
              <strong>Do not add these three totals together.</strong> Receiving a purchase order usually records
              <em> both</em> a GRN <em>and</em> purchase entries for the same goods, so the same physical purchase
              can appear under two sources. Each total is what that document type says on its own — adding them
              counts those goods more than once. Use the <strong>Link key</strong> column to see which GRN line and
              purchase row are the same delivery.
            </p>
          </div>
          <p className="text-[11px] text-[#8B7355]">
            {fmtNum(t.lines)} line{t.lines === 1 ? '' : 's'} · {from} to {to}. Quantities and rates are in PURCHASE units.
            GRN rates are gross (as the vendor bill reads); purchase rates are usually net of the discount, so the same
            delivery can show two rates. The {CHARGE_COLS.length} charge columns are not added into <strong>Value</strong>,
            the goods figure (normally quantity × rate).
            <strong> Total Amount</strong> is Value less the line’s Discount column — the
            amount before tax. Where the discount is already inside the rate, that column is 0 and Total Amount equals Value. The
            line’s <strong>Grand Total</strong> adds the tax and charges recorded on the line — its final amount as recorded there.
            On some lines Value can already hold the vendor’s tax and charges, and then so does Total Amount — see the red caveat above.
            {/* ⚠ THIS PARAGRAPH SAID THE OPPOSITE UNTIL 2026-09-11, and it was
                the most expensive sentence on the page. It told the owner that
                this log's Goods value and Total Amount were the Summary tab's
                Subtotal and Grand Total — "the same arithmetic". They are not,
                and the owner flips between the two tabs with ONE shared date
                range, so he saw two different answers to "what do we owe" and
                had been assured they could not differ. Measured on the live
                database, 2026-04-01..2026-08-07, same 2,165 lines both sides:

                  log  Goods value  6,926,866.40  Total Amount  6,928,791.40
                  Summary  Spend    6,926,866.40  Subtotal 6,928,486.40
                                                  Grand Total  6,934,193.60

                Goods value = the Summary's TOTAL SPEND, not its Subtotal (₹1,620
                apart). Total Amount is ₹5,402.20 BELOW the Grand Total, because
                this log sums the charge columns stored on each `purchases` row —
                and on the 31 GRN-paired lines (20 from a PO receive, 11 older
                ad-hoc) those carried no GST of their own, while the Summary
                reads that bill's real charges off the GRN line.

                NO RUPEE FIGURE IS PRINTED BELOW ON PURPOSE: the gap moves with
                the date range, and this component holds only the log's own
                totals — the Summary tab's figures are fetched by a different
                component from a different endpoint and are not in scope here.
                A stale hard-coded number would be a worse lie than the one this
                replaces. Naming the DIRECTION and the CAUSE is exact at every
                window. ("Total Amount" in this note is the figure owner ruling
                98 renamed Grand Total; Total Amount is now value − discount.) */}
            {/* NO HTML ENTITY IN THIS PARAGRAPH — every apostrophe is a literal
                ’ (U+2019). This is the second SWC face the comment above warns
                about, and it BIT HERE when this paragraph was first written:
                `<strong>not</strong> the Summary tab&rsquo;s.` followed by a
                source newline rendered in the browser as "its numbers are
                notthe Summary tab’s". The chunk after </strong> carried both an
                entity and a newline, so its leading space was dropped. Caught by
                reading the rendered DOM, not by tsc — which type-checks it clean.
                Keep the literal glyphs. */}
            {' '}<strong>Goods value</strong> here is the booked cost — the Summary tab shows that as <em>booked into stock</em> under <em>Total Purchases</em>, not as <em>Subtotal</em>.
            <strong> Grand Total</strong> here counts only the tax each purchase row carries itself, so on a bill received against a PO
            it can come out <strong>lower</strong> than the Summary’s <em>Grand Total</em>, which reads that bill’s tax off the GRN.
            Use the <strong>Summary</strong> tab for what is payable to a vendor; use this log to see which document each line came from.
            This log also lists three document types that must never be added up, so no money figure on it — Grand Total included — is ever added across all three.
            {/* OWNER #5 / RULING 93 — the three front columns, said in words.
                Literal glyphs only, no HTML entity (see the SWC note above). */}
            {' '}The three columns after <strong>Doc No</strong> read the bill document:
            <strong> Tax % Applied</strong> and <strong>Tax Value</strong> are the GST the bill charged — on a purchase booked straight
            from a goods receipt, as a PO receive books it, that is read off its GRN line, as the Summary tab does — and are blank where no GST was entered.
            <strong> Bill Grand Total</strong> is the whole bill’s total (Subtotal − discount + every tax and charge): the Purchase
            Bill Summary’s figure for that bill, or for a vendor’s unnumbered purchases of the day, repeated on each of its lines, so never add it down.
          </p>
        </div>
      )}

      {/* THE BILL GRAND TOTAL PROOF, when it failed. Every bill figure on this
          log is checked against the Purchase Bill Summary on every load; a bill
          that disagreed is printed BLANK, and an unexplained blank would read as
          "no bill". The CSV carries the same sentence. */}
      {billCheck && billCheck.mismatched > 0 && (
        <div className="bg-red-50 border-2 border-red-300 rounded-xl px-4 py-3 text-sm text-red-900 flex gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-red-600" />
          <p><strong>Bill Grand Total: {fmtNum(billCheck.mismatched)} of {fmtNum(billCheck.bills)} bills did not reconcile with the Purchase Bill Summary</strong>
            {' '}and are left blank rather than printed with a figure that disagrees. This is a defect — please report it.</p>
        </div>
      )}

      {data?.truncated && (
        <div className="bg-[#af4408] text-white rounded-xl px-4 py-3 text-sm font-semibold flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          This list was TRUNCATED by the server — it is not the full log. Narrow the date range or filters, or download the CSV.
        </div>
      )}

      {/* Log table */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl shadow-sm p-4 sm:p-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
          <h2 className="text-sm font-bold flex items-center gap-2"><span className="text-[#af4408]"><ScrollText className="w-4 h-4" /></span>
            Purchase log — one row per item per bill
            <span className="text-[11px] text-[#8B7355] font-normal">({fmtNum(rows.length)} row{rows.length === 1 ? '' : 's'})</span></h2>
          {loading && <span className="text-xs text-[#8B7355] inline-flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</span>}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm whitespace-nowrap">
            <thead><tr className="text-left text-[11px] uppercase text-[#8B7355] border-b border-[#F0E4D6]">
              {FRONT_HEADS.map((h, i) => (
                <th key={h.label} className={`py-2 ${i === 0 ? 'pr-3' : 'px-3'}`}>{h.label}</th>
              ))}
              {/* THE OWNER'S THREE, AT THE FRONT (#5, ruling 93). Rendered
                  ALWAYS, not behind the charge toggle: they are the tax and
                  grand-total question itself. Per LINE the percentage is exact
                  — one document line, nothing to blend. The bill total is the
                  WHOLE bill's, repeated per line, and is never totalled. */}
              <th className="py-2 px-3 text-right border-l-2 border-[#E8D5C4]" title={TAX_PERCENT_TITLE}>{TAX_PERCENT_LABEL}</th>
              <th className="py-2 px-3 text-right" title={LOG_TAX_VALUE_TITLE}>{TAX_VALUE_LABEL}</th>
              <th className="py-2 px-3 text-right border-r-2 border-[#E8D5C4]" title={BILL_GT_TITLE}>Bill Grand Total</th>
              {LEAD_HEADS.map(h => (
                <th key={h.label} className={`py-2 px-3${h.right ? ' text-right' : ''}`}>{h.label}</th>
              ))}
              <th className="py-2 px-3 text-right">Value</th>
              {/* The columns the owner went looking for (ruling 98): Total
                  Amount BEFORE tax, and Grand Total — the final amount — right
                  beside it. Kept next to Value so the readings of "total" are
                  read together, never mistaken. Literal glyphs in the titles. */}
              <th className="py-2 px-3 text-right" title="Value − discount: this line’s amount BEFORE tax and charges. Blank on PO lines: an order carries no charge columns. ⚠ On some PURCHASE lines Value can already hold the vendor’s tax and charges, and then so does this figure — see the red caveat above.">Total Amount</th>
              <th className="py-2 px-3 text-right" title="Total Amount + CGST + SGST + cesses + TCS + delivery + MRP round-off — this line’s final amount as this row records it. Blank on PO lines: an order carries no charge columns. It counts only the GST this row recorded itself (its CGST and SGST columns, shown with the charge columns), so it can leave out GST that the Tax Value column read off the GRN line. This line’s own figure, totalled per source below — not the Bill Grand Total near the front, which is the whole bill’s.">Grand Total</th>
              <th className="py-2 px-3 text-right">Rejected</th>
              {showCharges && CHARGE_COLS.map(c => <th key={String(c.k)} className="py-2 px-3 text-right">{c.label}</th>)}
              <th className="py-2 pl-3">Link key</th>
            </tr></thead>
            <tbody>
              {loading && rows.length === 0 ? (
                <tr><td colSpan={colCount} className="py-6 text-center text-[#8B7355] animate-pulse">Loading purchase log…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={colCount} className="py-6 text-center text-[#8B7355]">{error ? 'Not loaded — see the message above.' : 'No purchase, PO or GRN lines match these dates and filters.'}</td></tr>
              ) : shown.map((r, i) => (
                <tr key={`${r.source}-${r.doc_no}-${r.link_key}-${i}`} className="border-b border-[#F7EEE3] last:border-0 align-top">
                  <td className="py-2 pr-3"><SourceBadge source={r.source} /></td>
                  <td className="py-2 px-3 text-[#6B5744]">{r.date || '—'}</td>
                  <td className="py-2 px-3 font-medium">{r.doc_no || '—'}</td>
                  {/* An em dash on a PO line (no charge columns exist there) and
                      on a line where no GST was entered — never ₹0 and never
                      0.00% (ruling 93). The figures come from the server off the
                      bill document; on a PO receipt's purchase row that is its
                      GRN line, and the cell's hover says so. On a PURCHASE row
                      from the old tax-inclusive import the tax IS inside Value
                      and was never split out, so blank is the honest answer. */}
                  <td className="py-2 px-3 text-right tabular-nums font-semibold text-[#6B5744] border-l-2 border-[#F0E4D6]"
                      title={taxCellTitle(r, 'percent')}>{fmtTaxPercent(r.tax_percent ?? null)}</td>
                  <td className="py-2 px-3 text-right tabular-nums text-[#6B5744]"
                      title={taxCellTitle(r, 'value')}>{fmtSignedINR(r.tax_value ?? null)}</td>
                  {/* The WHOLE bill's grand total, the same on every line of it
                      — said under the figure, so a column of repeats reads as
                      one bill and not as line amounts to add. */}
                  <td className="py-2 px-3 text-right tabular-nums font-semibold text-[#2D1B0E] border-r-2 border-[#F0E4D6] cursor-help"
                      title={billGtTitle(r)}>
                    {fmtSignedINR(r.bill_grand_total ?? null)}
                    {r.bill_grand_total != null && (
                      <span className="block text-[10px] font-normal text-[#8B7355]">{isVendorDayBill(r) ? 'vendor-day' : 'whole bill'} · {fmtNum(r.bill_lines ?? 0)} line{r.bill_lines === 1 ? '' : 's'}</span>
                    )}
                    {/* SHORT — a GRN line behind one of this bill's cost rows was
                        deleted. Said in red where the number is, as the Bill
                        Summary and the Purchases register say it; the hover
                        carries the sentence. */}
                    {r.bill_grand_total != null && r.bill_understated_note && (
                      <span className="block text-[10px] font-semibold text-red-700">understated — see note</span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-[#6B5744]">{r.invoice_id || '—'}</td>
                  <td className="py-2 px-3 text-[#6B5744]">{r.bill_no || '—'}</td>
                  <td className="py-2 px-3 text-[#6B5744]">{r.vendor || '—'}</td>
                  <td className="py-2 px-3 font-medium whitespace-normal min-w-[180px]">{r.material || '—'}
                    {r.sku && <span className="block text-[10px] text-[#8B7355] font-normal">{r.sku}</span>}</td>
                  <td className="py-2 px-3 text-[#8B7355]">{r.category || '—'}</td>
                  <td className="py-2 px-3 text-right tabular-nums">{fmtQty(r.qty)} <span className="text-[11px] text-[#8B7355]">{r.purchase_unit || ''}</span></td>
                  <td className="py-2 px-3 text-right tabular-nums">{fmtINR(r.rate)}</td>
                  <td className="py-2 px-3 text-right tabular-nums font-semibold">{fmtINR(r.value)}</td>
                  <td className="py-2 px-3 text-right tabular-nums font-semibold">{fmtINRorDash(r.total_amount)}</td>
                  <td className="py-2 px-3 text-right tabular-nums font-semibold text-[#af4408]">{fmtINRorDash(r.grand_total ?? null)}</td>
                  <td className="py-2 px-3 text-right tabular-nums">{r.qty_rejected == null ? '—' : <span className={Number(r.qty_rejected) > 0 ? 'text-amber-700 font-semibold' : ''}>{fmtQty(r.qty_rejected)} {r.purchase_unit || ''}</span>}</td>
                  {/* Dash, not ₹0, when the source has no such column at all —
                      the PO branch stores none, and a 0 there reads as "no tax
                      was charged" on an order nobody has billed yet. */}
                  {/* fmtSignedINR, not the page's plain ₹ formatter: MRP Round-off
                      is signed, and "₹-0.5" puts the minus on the wrong side of the
                      symbol. This prints −₹0.50, to the paisa, and still an em dash
                      for a charge the source does not carry. */}
                  {showCharges && CHARGE_COLS.map(c => <td key={String(c.k)} className="py-2 px-3 text-right tabular-nums text-[#6B5744]">{fmtSignedINR(r[c.k])}</td>)}
                  <td className="py-2 pl-3 text-[11px] text-[#8B7355] font-mono">{r.link_key || '—'}
                    {r.notes && <span className="block text-[10px] text-[#B8A48E] font-sans whitespace-normal max-w-[220px]">{r.notes}</span>}</td>
                </tr>
              ))}
            </tbody>
            {/* ── TOTALS, one row per source, each figure under its own column ──
                These are SERVER totals over the FULL filtered set, not a sum of
                the rows painted above, so with a truncated or capped list the
                footer legitimately exceeds what is on screen. The caption under
                the table says so; without it a reader "corrects" the footer by
                adding the visible rows and gets a smaller, wrong number. */}
            {money && footSources.length > 0 && (
              <tfoot className="border-t-2 border-[#E8D5C4]">
                {footSources.map(src => {
                  const mm = money[src];
                  const tax = sourceTax(mm);
                  return (
                    <tr key={src} className="text-[12px] bg-[#FFFBF6]">
                      {/* The front block's label: badge + TOTAL against the two
                          tax totals. The full label sits again against Value
                          below, so whichever end of the table is in view, its
                          figures are named. */}
                      <td colSpan={FRONT_HEADS.length} className="py-2 pr-3 text-right font-semibold text-[#6B5744]">
                        <SourceBadge source={src} />
                        <span className="ml-2">TOTAL</span>
                      </td>
                      {/* THE SOURCE'S TAX FIGURES — server totals over the full
                          filtered set, like every other figure on this row, so
                          they exceed the painted rows when the list is capped.
                          Same bill-document basis as the cells above them, so
                          each foots its own column. The rate is Σ(GST) ÷
                          Σ(taxed base), money-weighted, and the base counts only
                          the lines that carried GST: over all 2,165 PURCHASE
                          lines an 18% bill would read 0.01%. Blank, never ₹0,
                          when the source carried no GST at all. */}
                      <td className="py-2 px-3 text-right tabular-nums font-bold border-l-2 border-[#F0E4D6]"
                          title={TAX_PERCENT_TITLE + taxAppliedNote(tax)
                            + ((mm.gst_base_accepted_lines || 0) > 0 ? `\n\n${acceptedBaseTotalNote(mm.gst_base_accepted_lines || 0)}` : '')}>
                        {fmtTaxPercent(taxAppliedPercent(tax))}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums font-bold"
                          title={src === 'PURCHASE' && (mm.gst_from_grn_lines || 0) > 0
                            ? `${LOG_TAX_VALUE_TITLE}\n\n${fmtNum(mm.gst_from_grn_lines || 0)} of these lines were booked straight from a goods receipt with no invoice number of ours (as a PO receive books its lines), whose GST is read off the GRN line — so this total can exceed the CGST + SGST columns further right, which hold what the purchase rows themselves recorded.`
                            : LOG_TAX_VALUE_TITLE}>
                        {fmtSignedINR(tax.gst)}
                      </td>
                      {/* NEVER A TOTAL. Each figure in this column is a whole
                          bill's, repeated on each of its lines — adding them
                          counts every bill once per line. */}
                      <td className="py-2 px-3 text-right border-r-2 border-[#F0E4D6] cursor-help" title={BILL_GT_TITLE}>
                        <span className="text-[10px] font-normal text-[#8B7355]">per bill · not added</span>
                      </td>
                      {/* RIGHT-aligned, and NOT sticky. This cell spans seven
                          columns (~1,100px), so `position: sticky; left: 0`
                          pins a cell wider than the scroll box and its opaque
                          background paints over every figure to its right —
                          measured, not guessed. Right-aligned instead puts the
                          label hard against the Value figure, so the label and
                          its numbers come into view together however far the
                          reader has scrolled. The totals panel above the table
                          carries the same figures for anyone who never scrolls. */}
                      <td colSpan={LEAD_HEADS.length} className="py-2 pr-3 text-right font-semibold text-[#6B5744]">
                        <SourceBadge source={src} />
                        <span className="ml-2">TOTAL · {SOURCE_MEANING[src]}</span>
                        <span className="ml-1 font-normal text-[#8B7355]">({fmtNum(mm.lines)} line{mm.lines === 1 ? '' : 's'})</span>
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums font-bold">
                        {fmtINR(mm.goods_value)}
                        {src === 'PURCHASE' && (
                          <span title="⚠ Not reliably tax-exclusive — see the caveat above the cards." className="ml-1 text-red-600 cursor-help">⚠</span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums font-bold">
                        {fmtINRorDash(mm.total_amount ?? null)}
                        {src === 'PURCHASE' && (
                          <span title="⚠ Not reliably before tax: on some lines Value can hold the vendor’s tax and charges, and then so does this total — see the caveat above the cards." className="ml-1 text-red-600 cursor-help">⚠</span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums font-bold text-[#af4408]">
                        {fmtINRorDash(mm.bill_amount)}
                        {src === 'PURCHASE' && (
                          <span title="⚠ May equal Goods value exactly on the affected lines, and can differ from the bill (usually lower) where a row’s GST sits on its GRN line only — see the caveat above the cards." className="ml-1 text-red-600 cursor-help">⚠</span>
                        )}
                      </td>
                      {/* Rejected is a quantity in each line's own purchase unit — not summable. */}
                      <td className="py-2 px-3" />
                      {showCharges && CHARGE_COLS.map(c => (
                        <td key={String(c.k)} className="py-2 px-3 text-right tabular-nums text-[#6B5744]">{fmtSignedINR(mm[c.k])}</td>
                      ))}
                      <td className="py-2 pl-3" />
                    </tr>
                  );
                })}
                <tr>
                  <td colSpan={colCount} className="pt-2 text-[11px] text-[#8B7355] whitespace-normal leading-relaxed">
                    Totals are computed by the server over <strong>all {fmtNum(t?.lines || 0)} matching line{(t?.lines || 0) === 1 ? '' : 's'}</strong>, not
                    over the rows painted above — so they can be larger than what you can see, and the row cap can never understate them.
                    Each source is totalled on its own; the three are never added. <strong>Qty</strong> and <strong>Rate</strong> have
                    no total by design{showCharges ? ', and neither does Discount on the PURCHASE row' : ''}; nor does <strong>Bill Grand Total</strong>,
                    which repeats each whole bill’s total on every one of its lines — see “Why some columns have no total” above.
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        {rows.length > shown.length && (
          <div className="pt-3 flex items-center gap-2 text-xs text-[#8B7355]">
            <Info className="w-3.5 h-3.5 shrink-0" />
            Showing the first {fmtNum(shown.length)} of {fmtNum(rows.length)} loaded rows on screen — the CSV contains all of them.
            <button onClick={() => setPaintAll(true)} className="px-2.5 py-1 rounded-md border border-[#E8D5C4] text-[#af4408] hover:bg-[#FFF1E3] font-semibold">Show all {fmtNum(rows.length)}</button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The money breakdown, one row per source, so a reader can see exactly how the
 * goods value becomes the total amount and then the grand total, and check the
 * arithmetic across the row (owner ruling 98 — Total Amount before tax):
 *
 *   goods value − discount netted = TOTAL AMOUNT
 *   TOTAL AMOUNT + CGST/SGST + other charges = GRAND TOTAL
 *
 * Discount is shown TWICE on purpose and they are not the same thing:
 *   • "Discount" is the reportable total, and it is an em dash on PURCHASE rows
 *     because a 0 in that column means three different things (see the notes);
 *   • "less discount" is what was actually deducted inside Total Amount (and so
 *     Grand Total), printed so the row always foots even where the column total
 *     is refused.
 */
function TotalsPanel({ money, notes }: { money: Record<LogSource, SourceMoney>; notes: { column: string; reason: string }[] }) {
  const present = SOURCE_ORDER.filter(s => (money[s]?.lines ?? 0) > 0);
  if (present.length === 0) return null;
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl shadow-sm p-4 sm:p-5 space-y-3">
      <h3 className="text-sm font-bold flex items-center gap-2">
        <span className="text-[#af4408]"><Sigma className="w-4 h-4" /></span>
        Totals — goods value, total amount and grand total, per source
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm whitespace-nowrap">
          <thead><tr className="text-left text-[11px] uppercase text-[#8B7355] border-b border-[#F0E4D6]">
            <th className="py-2 pr-3">Source</th>
            <th className="py-2 px-3 text-right">Lines</th>
            <th className="py-2 px-3 text-right">Goods value</th>
            <th className="py-2 px-3 text-right">Discount</th>
            <th className="py-2 px-3 text-right">less discount</th>
            <th className="py-2 px-3 text-right" title="Goods value less discount — before tax and charges.">Total amount</th>
            <th className="py-2 px-3 text-right">CGST + SGST</th>
            <th className="py-2 px-3 text-right">Other charges</th>
            <th className="py-2 pl-3 text-right">Grand total</th>
          </tr></thead>
          <tbody>
            {present.map(src => {
              const m = money[src];
              return (
                <tr key={src} className="border-b border-[#F7EEE3] last:border-0">
                  <td className="py-2 pr-3"><SourceBadge source={src} />
                    <span className="block text-[10px] text-[#8B7355] mt-0.5">{SOURCE_MEANING[src]}</span></td>
                  <td className="py-2 px-3 text-right tabular-nums text-[#6B5744]">{fmtNum(m.lines)}</td>
                  <td className="py-2 px-3 text-right tabular-nums font-semibold">
                    {fmtINR(m.goods_value)}
                    {/* PURCHASE only — GRN/PO derive value directly from qty × rate
                        and are not subject to the imported total_price defect. */}
                    {src === 'PURCHASE' && (
                      <span title={`⚠ Not reliably tax-exclusive — see the caveat above the cards. Lines in this view whose Goods value differs from quantity × rate: ${fmtNum(m.goods_value_tax_suspect_lines)} of ${fmtNum(m.lines)}. Goods value minus quantity × rate over the whole view: ${fmtINR(m.goods_value_tax_suspect)} (tax, charges or rate rounding).`}
                            className="ml-1 text-red-600 cursor-help">⚠</span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums text-[#6B5744]">{fmtINRorDash(m.discount)}</td>
                  <td className="py-2 px-3 text-right tabular-nums text-[#8B7355]">{m.discount_netted ? `− ${fmtINR(m.discount_netted)}` : '—'}</td>
                  <td className="py-2 px-3 text-right tabular-nums font-semibold">
                    {fmtINRorDash(m.total_amount ?? null)}
                    {src === 'PURCHASE' && (
                      <span title="⚠ Not reliably before tax: on some lines Goods value can hold the vendor’s tax and charges, and then so does this figure. See the caveat above the cards."
                            className="ml-1 text-red-600 cursor-help">⚠</span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums text-[#6B5744]">{fmtINRorDash(m.tax_cgst_sgst)}</td>
                  <td className="py-2 px-3 text-right tabular-nums text-[#6B5744]"
                      title="Special excise cess + GST compensation cess + TCS + delivery + MRP round-off. Compensation cess is a separate levy on a different base and is never folded into CGST+SGST.">
                    {fmtINRorDash(m.other_charges)}</td>
                  <td className="py-2 pl-3 text-right tabular-nums font-bold text-[#af4408]">
                    {fmtINRorDash(m.bill_amount)}
                    {src === 'PURCHASE' && (
                      <span title="⚠ May equal Goods value exactly on the affected lines, and can differ from the bill (usually lower) where a row’s GST sits on its GRN line only. See the caveat above the cards."
                            className="ml-1 text-red-600 cursor-help">⚠</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {notes.length > 0 && (
        <details className="rounded-lg border border-[#F0E4D6] bg-[#FFFBF6] px-3 py-2">
          <summary className="text-[11px] font-semibold text-[#6B5744] cursor-pointer select-none">
            Why some columns have no total ({notes.length}) — an “—” above is deliberate, not a missing number
          </summary>
          <ul className="mt-2 space-y-1.5">
            {notes.map(n => (
              <li key={n.column} className="text-[11px] text-[#6B5744] leading-relaxed">
                <span className="font-semibold text-[#2D1B0E]">{n.column}</span> — {n.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/* ───────────────────────── Bill charges: cards + table ─────────────────────
 * The owner asked for TAXES, CESS, TRANSPORTATION CHARGES and ROUND OFF as
 * columns. They live on `purchases` per LINE, so nothing is allocated and
 * nothing is re-derived here — src/lib/purchase-charges.ts owns the column
 * list, the blank-vs-zero rule and the signed round-off, and the API sums the
 * same expression the bill summary and the purchase log sum.
 */

/**
 * Period totals for the owner's four, between the SUBTOTAL they are added to and
 * the GRAND TOTAL they add up to. The row reads left to right as the arithmetic:
 * Subtotal → taxes, cess, transport, round-off → Grand total.
 *
 * The Subtotal card arrived 2026-09-11. The figure was already here, buried in
 * the Grand total card's sub-line as "bill value ₹x" — which is how the number
 * the owner actually asked to see ("the ingredients cost … as a subtotal") ended
 * up as a footnote on a different card.
 */
function ChargeCards({ s }: { s: Report['summary'] }) {
  const taxes = r2((Number(s.cgst) || 0) + (Number(s.sgst) || 0));
  const cess = r2((Number(s.compensation_cess) || 0) + (Number(s.special_excise_cess) || 0));
  return (
    /*
      EIGHT CARDS, AND THE STRIP NOW LITERALLY ADDS UP LEFT TO RIGHT.
      It was six, and the six DID NOT FOOT: with no Discount card and no TCS
      card, the five money cards left of the Grand Total summed to ₹69,36,465.60
      against a Grand Total of ₹69,34,193.60 — ₹2,272.00 out, being the ₹2,280
      discount less the ₹8 TCS. Both figures were already on the wire and simply
      had no card. The owner's instruction was that the grand total is the
      subtotal plus the rest of the charges; the headline strip was the one place
      on the page where that failed to be true.

      Discount renders NEGATED — −₹2,280.00, not ₹2,280.00 — because the cards
      are read as a running sum and a discount is subtracted. Cards in formula
      order: Subtotal − Discount + Taxes + Cess + TCS + Transport + Round-off
      = Grand Total. Measured on the live period: 6928486.40 − 2280 + 5482.80
      + 2425.40 + 8 + 72 − 1 = 6934193.60, exactly the last card.
    */
    /*
      RULING 115 (d), 2026-11-05: TWO ROWS OF FOUR, NOT ONE ROW OF EIGHT. The page
      is never wider than 1280px, so eight cards in a row left each ~143px and
      the owner saw "₹44,21,404.73" and "₹45,74,951.78" spill out of the Subtotal
      and Grand Total cards. Four to a row from tablet width up, two on a phone
      (where Taxes and Cess take a row each — round 3, below); the strip still
      reads in formula order, left to right, top to bottom, and
      each figure is sized off its own card (see Card).
    */
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {/* FIRST, because it is the base everything after it is added to. */}
      <Card icon={<Package className="w-4 h-4" />} label="Subtotal (goods)" value={fmtSignedINR(s.bill_value)}
        sub="the ingredients and goods, as billed" />
      {/* NEGATED ON PURPOSE — see above. fmtSignedINR renders the true minus. */}
      <Card icon={<Sigma className="w-4 h-4" />} label="Less: Discount" value={fmtSignedINR(-(Number(s.discount) || 0))}
        sub="taken off the subtotal" />
      {/* Round 3: Taxes and Cess carry two label-and-amount pairs, so below
          640px they take the whole row (they sit 3rd and 4th, so the strip
          still reads in formula order). Half a 320px phone left ~100px of
          text width and "GST comp. ₹2,425.40" needs more, so "GST comp." ended
          a line alone (measured, All time). */}
      <Card icon={<Receipt className="w-4 h-4" />} label="Taxes (CGST+SGST)" value={fmtSignedINR(taxes)} className="col-span-2 sm:col-span-1"
        sub={<><span className="inline-block">{`CGST ${fmtSignedINR(s.cgst)}\u00A0·`}</span>{' '}<span className="inline-block">{`SGST ${fmtSignedINR(s.sgst)}`}</span></>} />
      {/* TWO cess figures behind one card, never one merged number — the two
          levies sit on different taxable bases and a return filed on the sum
          would be wrong. The table below gives each its own column.
          Round 2: each label and its amount is one inline-block, so when the
          two pairs cannot share a line the second moves down whole; a no-break
          space alone let break-words split the figure ("less discount ₹0.0" /
          "0" at 320px, measured). The separating dot rides at the end of the
          first pair, held to its amount by a no-break space, so it never sits
          on a line of its own. */}
      <Card icon={<Receipt className="w-4 h-4" />} label="Cess" value={fmtSignedINR(cess)} className="col-span-2 sm:col-span-1"
        sub={<><span className="inline-block">{`GST comp. ${fmtSignedINR(s.compensation_cess)}\u00A0·`}</span>{' '}<span className="inline-block">{`Spl. excise ${fmtSignedINR(s.special_excise_cess)}`}</span></>} />
      <Card icon={<Receipt className="w-4 h-4" />} label="TCS" value={fmtSignedINR(s.tcs)}
        sub="tax collected at source, as billed" />
      <Card icon={<Truck className="w-4 h-4" />} label="Transport / Delivery" value={fmtSignedINR(s.delivery_charges)}
        sub="recorded only — never inside a rate" />
      {/* SIGNED. A bill rounded DOWN shows −₹x here and must never read +₹x. */}
      <Card icon={<Sigma className="w-4 h-4" />} label="MRP Round-off" value={fmtSignedINR(s.mrp_round_off)}
        sub={Number(s.mrp_round_off) < 0 ? 'negative — rounded down on the bill' : 'signed: a rounded-down bill reads\u00A0−'} />
      {/* The sub-label names the BASE, because it is the Subtotal and not Spend
          on a PO receipt, and a reader who assumes otherwise cannot foot the
          card. It points at the Subtotal card rather than repeating its rupees:
          the same figure printed twice under two names is what this rename set
          out to end. */}
      <Card icon={<Sigma className="w-4 h-4" />} label="Grand Total" value={fmtSignedINR(s.total_amount)}
        sub="payable to the vendor — the seven cards before it, added up" tone="accent" />
    </div>
  );
}

/**
 * The charge columns, per dimension, on screen — with a footer that has to
 * equal the cards above.
 *
 * WHY A SEPARATE TABLE AND NOT EIGHT MORE COLUMNS ON THE BAR CARDS: a bar card
 * answers "who did we spend the most with", one figure per row. Tax is a
 * different question with nine figures per row, and cramming them into the bar
 * list would have destroyed the one thing that card does well. Same rows, same
 * export, second view.
 *
 * WHY THE FOOTER IS COMPUTED HERE AND NOT TAKEN FROM THE SUMMARY: it is the
 * check. chargeTotals() adds up the rows the reader can actually see the top of;
 * the summary card above came from an independent SQL aggregate. When the two
 * agree, the green line says so; when they do not, the red line names the
 * charge and both figures. The server runs the same comparison over every
 * breakdown and ships `charge_footing`, which is rendered here too — so a
 * mismatch is visible even on the four dimensions not currently selected.
 */
function ChargeBreakdown({ breakdowns, summary, footing, onExport }: {
  breakdowns: BreakdownSpec[];
  summary: Report['summary'];
  footing?: { breakdown: string; charge: string; rows: number; summary: number }[];
  onExport: (b: BreakdownSpec) => void;
}) {
  const [dim, setDim] = useState<BreakdownSpec['k']>('vendor');
  const b = breakdowns.find(x => x.k === dim) || breakdowns[0];
  // Memoised on `b`, not on `b?.rows || []` — that fallback allocates a fresh
  // array on every render, so the memo would recompute every time and stop
  // being a memo at all.
  const foot = useMemo(() => chargeTotals(b?.rows || []), [b]);
  const rows = b?.rows || [];
  /**
   * The footer's tax row, as a TaxAppliedRow: the summed GST and the summed
   * TAXED base. Σ(gst) ÷ Σ(base) — a money-weighted period rate. Averaging the
   * rows' own percentages instead would give a ₹100 line the same weight as a
   * ₹1,00,000 one and would not foot against anything.
   */
  const footTax = useMemo(() => ({
    cgst: foot.cgst, sgst: foot.sgst,
    taxed_bill_value: r2(rows.reduce((n, r) => n + (Number(r.taxed_bill_value) || 0), 0)),
    taxed_lines: rows.reduce((n, r) => n + (Number(r.taxed_lines) || 0), 0),
    count: rows.reduce((n, r) => n + (Number(r.count) || 0), 0),
  }), [foot, rows]);
  const summaryTotal = r2(Number(summary.total_amount) || 0);
  // Paise-exact comparison — never a float ===.
  const foots = Math.round(foot.total_amount * 100) === Math.round(summaryTotal * 100)
    && PURCHASE_CHARGE_COLUMNS.every(c =>
      Math.round((foot[c.key] || 0) * 100) === Math.round((Number(summary[c.key]) || 0) * 100));
  // ANY row, not every row. The predicate this replaced asked whether the WHOLE
  // group was PO receipts, which was false on every month, category,
  // super-category and payment-mode group on the live data — so the four
  // breakdowns whose charges came mostly off GRNs were the four that said
  // nothing about it. See src/lib/purchase-charges.ts.
  const grnSourcedRows = rows.filter(hasGrnSourcedCharges).length;
  const grnSourcedLines = rows.reduce((n, r) => n + (Number(r.grn_sourced_rows) || 0), 0);
  const unpairedLines = rows.reduce((n, r) => n + (Number(r.unpaired_mirror_rows) || 0), 0);

  if (!b) return null;

  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl shadow-sm p-4 sm:p-5 space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <h2 className="text-sm font-bold flex items-center gap-2">
          <span className="text-[#af4408]"><Receipt className="w-4 h-4" /></span>
          Taxes, cess, transport &amp; round-off — by {b.title}
        </h2>
        <button onClick={() => onExport(b)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#af4408] hover:bg-[#8a3506] text-white shrink-0">
          <Download className="w-3.5 h-3.5" /> CSV
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {breakdowns.map(x => (
          <button key={x.k} onClick={() => setDim(x.k)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
              dim === x.k ? 'bg-[#af4408] text-white border-[#af4408]' : 'bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]'}`}>
            {x.title}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm whitespace-nowrap">
          <thead><tr className="text-left text-[11px] uppercase text-[#8B7355] border-b border-[#F0E4D6]">
            <th className="py-2 pr-3">{b.title}</th>
            <th className="py-2 px-3 text-right">Purchases</th>
            <th className="py-2 px-3 text-right">Spend</th>
            {PURCHASE_CHARGE_COLUMNS.map(c => (
              <th key={c.key} className="py-2 px-3 text-right" title={c.title}>{c.label}</th>
            ))}
            {/* The SUBTOTAL earns a column because the Grand Total is not
                footable without it: on a PO-receipt row Spend is BOOKED COST and
                the bill's own goods value is what the discount was struck
                against. Renamed from "Bill Value" 2026-09-11 — same figure. */}
            {/* THE BASE SITS AFTER THE CHARGES ON THIS TABLE — the opposite of
                the order on /reports/purchase-bill-summary, where Subtotal is
                left of them. Not an oversight: the CSV column positions are
                pinned by a test in another lane's file (see the note at the foot
                of src/lib/purchase-charges.ts), and moving the screen alone
                would break screen/file agreement here to fix cross-report
                agreement there. The title says so rather than leaving the owner
                to wonder which of the two reports is wrong. */}
            <th className="py-2 px-3 text-right border-l-2 border-[#E8D5C4]"
                title="SUBTOTAL. The goods and ingredients at the price the bill charges for them, before any tax or charge. Same as Spend on a hand-entered bill; on a PO receipt it is the bill's full price, because the rate we booked there may already have the discount taken off it. NOTE: on this table the Subtotal sits AFTER the charge columns and on the Purchase Bill Summary report it sits BEFORE them. Same figure, same arithmetic, different column order — read each table's own row, do not match them column by column.">Subtotal</th>
            <th className="py-2 pl-3 text-right" title="GRAND TOTAL — what we actually pay the vendor. Subtotal − discount + CGST + SGST + both cesses + TCS + delivery + round-off. On a PO receipt this is the same figure the GRN inward register prints as Total Inward.">Grand Total</th>
            {/* THE OWNER'S TWO COLUMNS, and they sit AFTER the Grand Total on
                purpose. Both are DERIVED from the CGST and SGST columns already
                on this row, so putting them inside the Subtotal − Discount +
                charges = Grand Total chain would let a reader adding the money
                columns across the row count the same GST twice. Behind the
                double border they read as what they are: a restatement, not a
                further charge. */}
            <th className="py-2 px-3 text-right border-l-2 border-[#E8D5C4]" title={TAX_VALUE_TITLE}>{TAX_VALUE_LABEL}</th>
            <th className="py-2 pl-3 text-right" title={TAX_PERCENT_TITLE}>{TAX_PERCENT_LABEL}</th>
          </tr></thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={PURCHASE_CHARGE_COLUMNS.length + 7} className="py-6 text-center text-[#8B7355]">No purchases in this range.</td></tr>
            ) : rows.map((r, i) => {
              const fromGrn = hasGrnSourcedCharges(r);
              const missing = isChargeSourceMissingRow(r);
              // ANY, beside the ALL. `missing` decides whether the CELLS blank;
              // `short` decides whether this row's Subtotal and Grand Total are
              // UNDERSTATED, which is a wider set. A vendor row of 40 lines that
              // lost one GRN line blanks nothing, prints eight ordinary numbers,
              // foots perfectly and is still short — and until 2026-09-11 it
              // carried no badge at all, because the only badge here fired on
              // the ALL rule. See src/lib/purchase-charges.ts.
              const short = hasUnpairedMirrorRows(r);
              const shortNote = unpairedMirrorNote(r);
              return (
                <tr key={i} className="border-b border-[#F7EEE3] last:border-0">
                  <td className="py-2 pr-3 font-medium whitespace-normal min-w-[160px]">
                    {String(r[b.keyName] ?? '—')}
                    {/* PROVENANCE, not absence. It says where the figures on this
                        row were read from — and it fires on a MIXED row, which
                        is the case the old all-or-nothing badge stayed silent
                        for on every month and every category. */}
                    {fromGrn && !missing && (
                      <span className="ml-1.5 inline-block px-1.5 py-0.5 rounded border border-[#E8D5C4] bg-[#F4EFE9] text-[10px] font-bold text-[#6B5744]"
                            title={`${Number(r.grn_sourced_rows) || 0} of ${Number(r.count) || 0} purchase lines behind this row are PO receipts. Their charges and bill value are read from the GRN line — the bill document — which is also what the GRN inward register totals as Total Inward.`}>
                        {Number(r.grn_sourced_rows) || 0}/{Number(r.count) || 0} from GRN
                      </span>
                    )}
                    {/* ONE badge, fired by the WIDER rule, worded by how bad it
                        is. The old badge fired only when EVERY line was
                        orphaned; a mixed row — the silent, self-consistent,
                        arithmetically convincing case — got nothing. */}
                    {short && (
                      <span className="ml-1.5 inline-block px-1.5 py-0.5 rounded border border-red-300 bg-red-100 text-[10px] font-bold text-red-900"
                            title={shortNote ?? undefined}>
                        {missing ? 'charges unavailable — understated' : 'understated — bill document missing'}
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums text-[#6B5744]">{fmtNum(r.count)}</td>
                  <td className="py-2 px-3 text-right tabular-nums font-semibold">{fmtINR(r.spend)}</td>
                  {PURCHASE_CHARGE_COLUMNS.map(c => {
                    const v = chargeCell(r, c);
                    return (
                      <td key={c.key} className={`py-2 px-3 text-right tabular-nums ${
                        c.signed && (v || 0) < 0 ? 'text-red-700 font-semibold' : 'text-[#6B5744]'}`}>
                        {/* ONE formatter for every charge figure: paise always, the
                            minus kept on a signed column, and an em dash — never
                            "₹0" — when the charge does not apply to this row. */}
                        {fmtSignedINR(v)}
                      </td>
                    );
                  })}
                  <td className="py-2 px-3 text-right tabular-nums text-[#6B5744] border-l-2 border-[#F0E4D6]">{fmtSignedINR(Number(r.bill_value) || 0)}</td>
                  {/* A Grand Total that may be short says so AT THE NUMBER. The
                      row badge is at the far left of a 17-column table and is
                      off-screen by the time the eye reaches this cell. */}
                  <td className={`py-2 pl-3 text-right tabular-nums font-bold ${short ? 'text-red-700' : 'text-[#af4408]'}`}
                      title={shortNote ?? undefined}>
                    {fmtSignedINR(Number(r.total_amount) || 0)}
                    {short && <span className="block text-[10px] font-bold">UNDERSTATED</span>}
                  </td>
                  {/* TAX VALUE (GST) — cgst + sgst off this row, nothing else.
                      fmtSignedINR gives it the same paise-always formatting as
                      every other money cell on the table. */}
                  <td className="py-2 px-3 text-right tabular-nums text-[#6B5744] border-l-2 border-[#F0E4D6]">
                    {fmtSignedINR(gstValue(r))}
                  </td>
                  {/* TAX % APPLIED (GST) — an em dash, never 0.00%, when the row
                      recorded no GST. The title says how many of the row's lines
                      the rate was computed over, so a blended figure can never
                      be read as one vendor's single rate. */}
                  <td className="py-2 pl-3 text-right tabular-nums font-semibold text-[#6B5744]"
                      title={TAX_PERCENT_TITLE + taxAppliedNote(r)}>
                    {fmtTaxPercent(taxAppliedPercent(r))}
                  </td>
                </tr>
              );
            })}
          </tbody>
          {rows.length > 0 && (
            <tfoot className="border-t-2 border-[#E8D5C4]">
              <tr className="bg-[#FFFBF6] text-[12px]">
                <td className="py-2 pr-3 font-bold text-[#6B5744]">TOTAL · {fmtNum(rows.length)} {b.title.toLowerCase()} row{rows.length === 1 ? '' : 's'}</td>
                <td className="py-2 px-3 text-right tabular-nums font-bold">{fmtNum(rows.reduce((n, r) => n + (Number(r.count) || 0), 0))}</td>
                <td className="py-2 px-3 text-right tabular-nums font-bold">{fmtINR(rows.reduce((n, r) => n + (Number(r.spend) || 0), 0))}</td>
                {PURCHASE_CHARGE_COLUMNS.map(c => (
                  <td key={c.key} className="py-2 px-3 text-right tabular-nums font-bold">
                    {fmtSignedINR(foot[c.key])}
                  </td>
                ))}
                <td className="py-2 px-3 text-right tabular-nums font-bold border-l-2 border-[#E8D5C4]">{fmtSignedINR(foot.bill_value)}</td>
                <td className="py-2 pl-3 text-right tabular-nums font-bold text-[#af4408]">{fmtSignedINR(foot.total_amount)}</td>
                {/* THE FOOTER'S OWN TAX FIGURES, from the summed rows — so the
                    Tax Value column foots like every other money column, and the
                    period rate is Σ(GST) ÷ Σ(taxed base) rather than an average
                    of percentages, which would weight a ₹100 line the same as a
                    ₹1,00,000 one. */}
                <td className="py-2 px-3 text-right tabular-nums font-bold border-l-2 border-[#E8D5C4]">{fmtSignedINR(gstValue(footTax))}</td>
                <td className="py-2 pl-3 text-right tabular-nums font-bold" title={TAX_PERCENT_TITLE + taxAppliedNote(footTax)}>{fmtTaxPercent(taxAppliedPercent(footTax))}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* THE ARITHMETIC, STATED. Not "trust me" — the two figures and the verdict. */}
      {rows.length > 0 && (
        foots ? (
          <p className="text-[12px] text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
            <strong>The footer foots.</strong> Every charge column above adds up, to the paisa, to the
            period figure on the cards at the top of this page ({fmtSignedINR(summaryTotal)} grand total) — and the
            server checked the same thing against all {fmtNum(breakdowns.length)} breakdowns before sending them.
          </p>
        ) : (
          <div className="text-[12px] text-red-900 bg-red-100 border border-red-300 rounded-lg px-3 py-2">
            <strong>THESE ROWS DO NOT ADD UP to the period totals above.</strong> Report it — do not
            reconcile it by hand. The column(s) that disagree, with both figures:
            <ul className="mt-1 space-y-0.5 font-mono">
              {/* Name the OFFENDING column. An alarm that only prints the grand
                  total is unactionable when the grand total happens to match and
                  a single charge is what drifted. */}
              {[...PURCHASE_CHARGE_COLUMNS.map(c => ({ label: c.label, rows: foot[c.key], sum: Number(summary[c.key]) || 0 })),
                { label: 'Grand Total', rows: foot.total_amount, sum: summaryTotal }]
                .filter(x => Math.round((x.rows || 0) * 100) !== Math.round((x.sum || 0) * 100))
                .map(x => (
                  <li key={x.label}>{x.label}: rows {fmtSignedINR(x.rows)} vs period {fmtSignedINR(x.sum)}</li>
                ))}
            </ul>
          </div>
        )
      )}

      {footing && footing.length > 0 && (
        <div className="text-[12px] text-red-900 bg-red-100 border border-red-300 rounded-lg px-3 py-2">
          <strong>Server-side footing check FAILED</strong> on {footing.length} figure(s):
          <ul className="mt-1 space-y-0.5">
            {footing.map((f, i) => (
              <li key={i} className="font-mono">{f.breakdown} · {f.charge}: rows {f.rows} vs period {f.summary}</li>
            ))}
          </ul>
        </div>
      )}

      {/* THE PROVENANCE LINE. It renders whenever ANY line behind ANY row on
          this breakdown took its charges off a GRN — which is the case on the
          month, category, super-category and payment-mode views, none of which
          said a word before, because the rule it replaced only fired when a
          whole group was PO receipts. */}
      {grnSourcedLines > 0 && (
        <p className="text-[12px] text-[#2D1B0E] bg-[#FFF6EE] border border-[#E8D5C4] rounded-lg px-3 py-2 leading-relaxed">
          {/* NO INTERPOLATION TOUCHES A LINE BREAK IN THIS PARAGRAPH.
              SWC drops the single space between `{expr}` and the word beside it
              when the two are split by a source newline — in EITHER direction.
              This paragraph rendered "the 4rows above" in the browser while
              type-checking clean, and adding {' '} on one side only moved the
              missing space to the other. The counts are therefore composed into
              plain strings first, so every interpolation is a whole phrase with
              text before and after it on the SAME line.

              2026-09-11 — AND NO COMMENT BLOCK EITHER. A {'{'}/* … *{'/'}{'}'} placed
              BETWEEN two text chunks splits them the same way an interpolation
              does, and the trailing space dies with it: dropping an explanatory
              comment mid-paragraph rendered "reads them from there.That is why".
              Notes about this paragraph belong in THIS block, at the top, never
              inside it.

              TWO MORE SPELLINGS PROVED IN THE BROWSER, not inferred — tsc
              type-checks every one of them clean:
                · "…Total Inward</strong>\n on every such bill" glued to
                  "Total Inwardon". The original survived only because a COMMA
                  sat immediately after the tag, so no space was needed. A word
                  after a closing tag stays on the SAME line as the tag.
                · "…are <strong>not</strong> the Summary tab&rsquo;s." on the
                  Purchase-log tab rendered "notthe". That chunk carried both an
                  entity and a newline; it uses a literal ’ now. */}
          <strong>{`${fmtNum(grnSourcedLines)} of ${fmtNum(rows.reduce((n, r) => n + (Number(r.count) || 0), 0))} purchase lines here are PO receipts`}</strong>
          {`, spread across ${fmtNum(grnSourcedRows)} of the ${fmtNum(rows.length)} rows above. `}
          A PO receipt&rsquo;s purchase row is a tax-free cost mirror — its charges are recorded on
          the <strong>GRN line</strong>, which is the bill document — so this report reads them from there.
          That is why <strong>the Grand Total on those rows matches the GRN inward register&rsquo;s Total Inward</strong> on every such
          bill in the database today, and why it can exceed Spend by more than the columns shown: on a PO receipt the
          booked rate may already be net of the discount the GRN itemises, so the <strong>Subtotal</strong>,
          not Spend, is the base the arithmetic runs on. The two are separate counts — the register sums every GRN line
          and this report can only reach a line that has a purchase row behind it — so treat that agreement as a check
          worth running rather than a guarantee.
        </p>
      )}

      {unpairedLines > 0 && (
        <p className="text-[12px] text-red-900 bg-red-100 border border-red-300 rounded-lg px-3 py-2 leading-relaxed">
          <strong>{`${fmtNum(unpairedLines)} PO-receipt line(s) have no GRN line left to read charges from.`}</strong>{' '}
          Their charge figures are <strong>unavailable, not zero</strong>. Report it — a cost mirror
          outliving its bill document means a GRN was deleted without unwinding the purchase row.
        </p>
      )}

      {/* NO HTML ENTITY APPEARS IN THIS PARAGRAPH — the curly quotes are literal ’ (U+2019).
          Second face of the same SWC whitespace bug documented above, isolated exactly:
          SWC drops the LEADING space of a JSX text chunk that contains BOTH an HTML entity
          AND a source newline. Either alone is harmless — the chunk after <strong>Spend</strong>
          spans a newline and keeps its space; a one-line chunk keeps its space even with an
          entity. Together they glue the words: `&rsquo;` on these lines rendered
          "recorded only— they are" and (on the column-defining sentence below, whatever that
          column is named) "…Valueis the goods value" in the browser while it type-checked
          clean, exactly like "the 4rows above". {' '} does NOT fix it (it is the
          chunk's own leading space that is eaten); a literal ’ does, because it leaves no
          entity in the chunk. Keep the quotes literal here, and if you add an entity to this
          paragraph, keep its chunk on ONE line. */}
      <p className="text-[11px] text-[#8B7355] leading-relaxed">
        All eight columns are <strong>recorded only</strong> — they are what the bill said, and none of
        them moves an item’s cost or the weighted-average price. <strong>Spend</strong> is the booked goods
        cost, what we recorded into stock and what stock valuation is built on; <strong>Subtotal</strong> is
        the goods and ingredients at the price the bill charges for them; <strong>Grand Total</strong> is
        subtotal − discount + every charge, which is what we actually pay the vendor. The two
        cess columns are <em>different levies</em> on different taxable bases and are never added together.
        <strong> MRP Round-off is signed</strong>: a bill rounded down reads −₹, and the CSV carries the
        minus as a number, not as text.
      </p>
    </div>
  );
}

/**
 * A summary card. RULING 115 (d): the card is a size CONTAINER and its figure is
 * sized off the card's own width (fitFigureStyle, src/lib/fit-figure.ts), never
 * wrapped and never cut — so "₹45,74,951.78" fits whether eight cards share a
 * row or two do on a phone. The label and sub-line wrap; the figure is capped
 * at the old text-xl, so a short figure looks exactly as it did.
 *
 * The icon sits INLINE in the label, not in a flex column beside it, so a
 * label's second line runs the card's full width and a word like
 * "(CGST+SGST)" moves down whole instead of being split in a 320px card.
 * `className` places the card in its grid (the headline's two tracks).
 */
function Card({ icon, label, value, sub, tone, className = '' }: { icon: React.ReactNode; label: string; value: string; sub?: React.ReactNode; tone?: 'accent' | 'warn'; className?: string }) {
  const ring = tone === 'accent' ? 'border-[#af4408]/30 bg-[#FFF6EE]' : tone === 'warn' ? 'border-amber-200 bg-amber-50' : 'border-[#E8D5C4] bg-white';
  return (
    <div className={`@container min-w-0 rounded-xl border shadow-sm p-3.5 ${ring} ${className}`}>
      <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wide break-words"><span className="inline-block align-[-4px] mr-1.5 text-[#af4408]">{icon}</span>{label}</p>
      <p className="font-bold mt-1 text-[#2D1B0E] tabular-nums whitespace-nowrap leading-snug" style={fitFigureStyle(value)}>{value}</p>
      {sub && <p className="text-[11px] text-[#8B7355] mt-0.5 break-words">{sub}</p>}
    </div>
  );
}

/**
 * One bar list of the Summary. RULING 115 (2026-11-05): it shows, ranks (the
 * rows arrive ranked — see the `breakdowns` memo) and adds up by GRAND TOTAL,
 * `total_amount`, and its % share is of the headline Total Purchases card
 * (`total`). Its foot adds up EVERY row, the hidden "+N more" included, and
 * says so against the headline — in red, naming both figures, if they ever
 * disagree. Before this ruling the list summed booked spend while the owner
 * read the page's first card as the period's purchases.
 */
function BarTable({ title, plural, singular, icon, keyName, rows, total, limit, onExport }: {
  title: string; plural: string; singular: string; icon: React.ReactNode; keyName: string; rows: Row[]; total: number; limit?: number; onExport: () => void;
}) {
  const gt = (r: Row) => Number(r.total_amount) || 0;
  const shown = limit ? rows.slice(0, limit) : rows;
  const max = Math.max(1, ...rows.map(gt));
  const sum = r2(rows.reduce((n, r) => n + gt(r), 0));
  const adds = Math.round(sum * 100) === Math.round((Number(total) || 0) * 100);
  // One row reads "The 1 month", never "All 1 months".
  const one = rows.length === 1;
  const all = one ? `The 1 ${singular}` : `All ${fmtNum(rows.length)} ${plural}`;
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl shadow-sm p-4 sm:p-5">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="min-w-0">
          <h2 className="text-sm font-bold flex items-center gap-2"><span className="text-[#af4408]">{icon}</span>{title}</h2>
          <p className="text-[11px] text-[#8B7355] mt-0.5">Grand Total, incl. GST and charges · (share of Total Purchases · purchase lines)</p>
        </div>
        <button onClick={onExport} className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-[#E8D5C4] text-[#6B5744] hover:bg-[#FFF1E3] text-xs"><Download className="w-3 h-3" /> CSV</button>
      </div>
      {shown.length === 0 ? <p className="text-sm text-[#B8A48E] py-4 text-center">No data.</p> : (
        <div className="space-y-2">
          {shown.map((r, i) => (
            <div key={i}>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="truncate font-medium">{r[keyName]}</span>
                <span className="shrink-0 tabular-nums">{fmtSignedINR(gt(r))} <span className="text-[11px] text-[#8B7355]">({total > 0 ? Math.round((gt(r) / total) * 100) : 0}% · {fmtNum(r.count)})</span></span>
              </div>
              <div className="h-2 bg-[#FAF3EA] rounded-full overflow-hidden mt-0.5"><div className="h-full bg-[#af4408] rounded-full" style={{ width: `${Math.max(2, Math.round((gt(r) / max) * 100))}%` }} /></div>
            </div>
          ))}
          {limit && rows.length > limit && <p className="text-[11px] text-[#8B7355] pt-1">+{rows.length - limit} more — export CSV for the full list.</p>}
          {adds
            ? <p className="text-[11px] text-[#6B5744] pt-1 border-t border-dashed border-[#F0E4D6]">{`${all}${one ? '' : ' together'}: ${fmtSignedINR(sum)} — the Total Purchases figure at the top.`}</p>
            : <p className="text-[11px] font-semibold text-red-800 bg-red-50 border border-red-200 rounded-md px-2 py-1">{`${all} ${one ? 'adds' : 'add'} up to ${fmtSignedINR(sum)}, but Total Purchases is ${fmtSignedINR(total)}. Report it — do not reconcile it by hand.`}</p>}
        </div>
      )}
    </div>
  );
}
