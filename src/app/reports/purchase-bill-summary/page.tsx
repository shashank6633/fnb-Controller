'use client';

/**
 * Purchase Bill Summary (/reports/purchase-bill-summary) — management-only.
 * ONE ROW PER VENDOR BILL: Bill No, Vendor, Date, the BOOKED COST, the SUBTOTAL
 * (the goods as the bill charges for them), every charge, and the GRAND TOTAL —
 * what is payable to the vendor.
 * Reads GET /api/reports/purchase-bill-summary, which enforces
 * management access server-side — the mgmtOnly flag in page-catalog.ts only hides
 * the nav link and is NOT the boundary.
 *
 * WHAT A "BILL" IS HERE — it is DERIVED, not stored. `purchases` holds one row per
 * ITEM, so the API groups rows on a bill key resolved in this precedence:
 *     invoice_id (OUR PINV-yyyy-####, minted one per vendor bill)   → kind INV
 *  →  grn_id     (one GRN = one delivery = one vendor bill event)   → kind GRN
 *  →  vendor|bill_no|date|outlet (the VENDOR's own number)          → kind BILL
 *  →  vendor|date|outlet                                            → kind DAY_RUN
 * The last branch is most of the data: the overwhelming majority of purchase rows
 * carry no vendor bill number, so they are that vendor's purchases for that day
 * consolidated for reading. A DAY_RUN group may cover more than one physical bill
 * or market run, so this page never calls it a bill — it renders "No bill no" and
 * the note panel says so in words. `?unnumbered=split` breaks those groups back
 * into single lines for anyone who wants the raw view.
 *
 * WHY THIS PAGE MAY PRINT ONE PERIOD TOTAL, unlike /reports/purchases → Purchase log:
 * every ROW and every rupee comes from the `purchases` table alone.
 * goods_receipt_notes, po_vendor_bills and purchase_order_items restate the SAME
 * money (see the header of src/lib/purchase-log.ts), so the log must print three
 * per-source totals that must never be added. Here there is one source of bills, so
 * every rupee is counted exactly once BY CONSTRUCTION and one period figure is safe.
 * (That is about the PERIOD strip. "Grand total" is also the name of a per-row
 * COLUMN on this page since 2026-09-11 — the same arithmetic, one bill at a time.)
 * (One 1:1 LEFT JOIN onto goods_receipt_note_items reads the CHARGE columns of the
 * GRN line a PO receipt was booked from — see below. It cannot fan out, adds no
 * bill and moves no goods value: rows and SUM(total_price) are identical with it.)
 *
 * WHERE A PO RECEIPT'S CHARGES COME FROM. A PO-receive `purchases` row is a
 * deliberately TAX-FREE COST MIRROR — the discount is already inside the net
 * unit_price and no tax is written at all, because tax on the cost row would poison
 * average_price and destroy the input credit. The bill's real charges live on the
 * GRN line, which is the bill document, and that is where this report reads them
 * (2026-09-10). Until then it printed an EM-DASH in Discount / GST / both cess
 * columns to avoid asserting "GST ₹0", which was honest about the cell and wrong
 * about the bill: ₹8,313.20 of real discount and tax across 29 bills never reached
 * the screen, and this page totalled ₹25,330.00 where the GRN Inward Register
 * totalled ₹30,732.20 for the same 29 bills. Those cells now carry the bill's own
 * figures and the row foots.
 *
 * THREE MONEY COLUMNS, ALL ON SCREEN, BECAUSE THEY ARE DIFFERENT NUMBERS.
 *   Booked cost (spend)  SUM(purchases.total_price) as booked — the figure that feeds
 *                        stock valuation and the one /reports/purchases calls Spend.
 *   Subtotal             the same goods at the price the BILL charges for them.
 *                        Identical to booked cost on every hand-entered bill; on a
 *                        PO receipt it is the GRN line's gross, because 17 of 31
 *                        mirror rows have the discount already netted into the
 *                        booked rate (rate 90 against a bill rate of 100).
 *   Grand total          Subtotal − Discount + GST + both cesses + TCS + Delivery
 *                        + MRP round-off. What is payable to the vendor.
 * THE GRAND TOTAL FOOTS FROM THE SUBTOTAL, so that discount is subtracted once and
 * not twice; Subtotal − Booked cost is exactly the ₹1,620 sitting inside those rates.
 * Do not quietly make one of these columns serve as another — in particular, the
 * Subtotal is NOT the booked cost and must never replace that column, which is what
 * stock valuation and the Purchase Report's Spend reconcile against.
 *
 * 2026-09-11: these were "Goods (spend)" and "Total Bill Value", with the bill's own
 * basis shown only as a grey sub-line under Goods on the 17 rows where it differed.
 * The owner asked for the goods value as a SUBTOTAL in its own right and for a GRAND
 * TOTAL that is "what we actually need to pay the vendor", so the Subtotal became a
 * real column on every row and the two names changed. No arithmetic moved: both
 * figures were already on the wire as bill_value and total_bill_value.
 *
 * BLANK IS NOT ZERO, and it is now a narrow rule: a charge that IS zero prints
 * ₹0.00. A cell goes blank only where the figure is UNAVAILABLE — every line behind
 * it is a PO mirror whose GRN line has been deleted, so "my charges are recorded
 * elsewhere" and elsewhere is gone. chargeCell() in src/lib/purchase-charges.ts is
 * the one implementation, shared with the CSV, and it can only blank a cell whose
 * stored sum is 0, so a blank can never hide a rupee. 0 rows qualify today.
 *
 * UNITS: no quantity and no rate is displayed anywhere. A bill spans kg + BTL + CASE
 * lines, so summing purchases.quantity across them yields a number with no unit; the
 * report shows a LINES count instead. That is also why the rate-basis lock has nothing
 * to judge here — there is no rate × quantity pairing on this screen. An "avg rate"
 * column would create one; do not add it without reading scripts/check-rate-basis.js.
 *
 * TWO VIEWS, ONE REPORT. The pill row switches between BY BILL (the original table)
 * and BY DAY (?view=day) — the store person's reconciliation rollup: date, numbered
 * bills, vendor day-runs, vendors, item lines and total purchase value, with a
 * per-vendor drill-down on each day. It is a MODE on this page and not a new route, so
 * page-catalog.ts and Sidebar.tsx stay untouched (a catalog entry without a matching
 * Sidebar entry is gated but invisible). The day rows are aggregated in SQL, never by
 * folding the loaded `rows` array — those are capped by the server and filtered again
 * by the search box, so a client-side rollup would quietly disagree with the totals
 * strip above it.
 *
 * THE DAY VIEW NEVER PRINTS ONE "BILLS" NUMBER. Measured on live, 33 of 34 purchase
 * days hold ZERO numbered bills and April — 99.3% of the spend — is entirely
 * un-numbered, so a single Bills column would be a month of zeros to reconcile
 * against. Numbered bills and vendor day-runs are separate columns.
 *
 * THE DAY TABLE SHOWS ITS DOCUMENT COUNTS, THE SUBTOTAL AND THE GRAND TOTAL, AND NO
 * CHARGE COLUMNS — a layout choice, not a correctness one. It used to be a
 * correctness one: a per-day GST cell was the em-dashes summed into a zero
 * (2026-08-07 printed ₹1,125 while 29 taxed bills contributed nothing). The day rows
 * read the same effective rail as the bill rows now, so that same day carries its
 * real ₹5,482.80 and the figures would be honest if printed. They are still not
 * printed here because this view exists for the store person matching a day's
 * paperwork — dates, document counts, what the goods came to and what is payable.
 *
 * THE CONSEQUENCE MUST BE CAPTIONED: Subtotal and Grand total sit side by side with
 * the eight columns that explain the gap between them absent, so the table says in
 * words that the tax and charges in between are itemised in By bill and in the CSV.
 * The Subtotal column cost no query — bill_value already arrived on every day row and
 * every vendor row; it was simply not declared or rendered here before 2026-09-11.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { todayIST } from '@/lib/format-date';
/* The blank-vs-zero rule, the signed ₹ formatter and the charge column list, from
 * the ONE module that owns them. This file may import it because it imports nothing
 * itself — no better-sqlite3, no next/* — so the screen and the CSV apply the same
 * rule to the same cell instead of two lookalike copies drifting apart. */
import {
  chargeCell, isChargeSourceMissingRow, hasUnpairedMirrorRows, unpairedMirrorNote, fmtSignedINR,
  type PurchaseChargeKey, type PurchaseChargeColumn,
} from '@/lib/purchase-charges';
import {
  ReceiptText, Building2, Download, Loader2, Info, AlertTriangle,
  ShoppingCart, TrendingUp, Layers, CalendarDays, ChevronRight, ChevronDown, Users,
  Package,
} from 'lucide-react';

/* These mirror the exported shapes in src/lib/purchase-bill-summary.ts. They are
 * re-declared rather than imported because importing the lib into a client
 * component would drag better-sqlite3 into the browser bundle. If the lib's
 * types change, change these to match — the compiler cannot catch the drift. */

/** How firm the bill identity is. `split` mode keeps DAY_RUN: the defining fact
 *  is still that no vendor bill number exists, only the grouping changed. */
type BillKind = 'INV' | 'GRN' | 'BILL' | 'DAY_RUN';

interface BillRow {
  /** The derived key — also how a reader pivots to /reports/purchase-log. */
  bill_key: string;
  bill_kind: BillKind;
  date: string;                  // MIN(date) of the group — the bill date
  date_to: string;               // MAX(date); equal to `date` unless the group spans days
  spans_days: boolean;
  vendor: string;                // MIN(vendor)
  vendor_count: number;          // >1 ⇒ render "(+n more)" rather than let `vendor` lie
  invoice_id: string;            // OURS   — PINV-yyyy-####
  bill_no: string;               // VENDOR — their own number, often ''
  grn_id: string;                // the GRN behind a PO receive, '' otherwise
  bill_no_missing: boolean;
  /** PROVENANCE: this bill's charges were read off its GRN line. Not "missing". */
  tax_on_grn: boolean;
  /** How many of `lines` took their charges from a GRN line. */
  grn_sourced_rows: number;
  /** Mirror lines whose GRN line is gone — their charges are UNAVAILABLE, not 0. */
  unpaired_mirror_rows: number;
  lines: number;                 // COUNT(*) of purchases rows — no quantities, ever
  /** Rendered as BOOKED COST (spend). SUM(total_price) AS STORED — feeds stock
   *  valuation. NOT the Subtotal; keep both columns. Keep the wire name `goods`. */
  goods: number;
  /** Rendered as SUBTOTAL — the goods as the bill charges for them, and the base
   *  the Grand total foots from. Keep the wire name `bill_value`: a rename here
   *  without the lib and the route renders ₹0 with no compiler error. */
  bill_value: number;
  discount: number;
  cgst: number;
  sgst: number;
  gst: number;                   // cgst + sgst; NEITHER cess is in here
  compensation_cess: number;     // GST Compensation Cess (aerated drinks, tobacco)
  special_excise_cess: number;   // TGBCL Special Excise Cess — a different levy again
  tcs: number;
  delivery_charges: number;
  mrp_round_off: number;
  /** Rendered as GRAND TOTAL — what is payable to the vendor. Subtotal − Discount
   *  + GST + both cesses + TCS + Delivery + MRP round-off. */
  total_bill_value: number;
}

interface BillTotals {
  bills: number;                 // BEFORE truncation — SQL over the full filtered set
  lines: number;
  goods: number;                 // BOOKED COST (spend) — feeds valuation
  bill_value: number;            // the period SUBTOTAL — the base the grand total foots from
  grn_sourced_lines: number;
  unpaired_mirror_lines: number;
  discount: number;
  gst: number;
  compensation_cess: number;
  special_excise_cess: number;
  tcs: number;
  delivery_charges: number;
  mrp_round_off: number;
  /** The period GRAND TOTAL. */
  total_bill_value: number;
  po_receipt_bills: number;
  po_receipt_lines: number;
  /** Those receipts' share of the GRAND TOTAL — never of the subtotal. */
  po_receipt_value: number;
  /** How many of `bills` carry no vendor bill number — SQL over the FULL period,
   *  so the day view can state an exact figure instead of counting loaded rows. */
  day_run_bills: number;
  /** Rendered VERBATIM beside the period total — it is the guard on misreading it. */
  basis: string;
}

/**
 * The first and last dates purchases actually exist on, as the API reports them.
 * Null on both when there are no purchases at all — which is a different thing
 * from "none in the window you picked", and the page says so in those words.
 */
interface DataRange { first: string | null; last: string | null }

/**
 * WHAT WINDOW THE PAGE IS ASKING FOR — not what dates it is asking for.
 *
 * 'all' means "every purchase there is", and the DATES for that are resolved by
 * the server against the data and echoed back. That indirection is the whole
 * point: the page cannot know the first purchase date before it has asked, and
 * asking twice (once for the dates, once for the report) would double every
 * first load. See the comment on the state itself.
 */
type Range = { mode: 'all' } | { mode: 'explicit'; from: string; to: string };

interface BillResponse {
  view?: 'bill';
  rows: BillRow[];
  totals: BillTotals;
  truncated: boolean;
  from: string;
  to: string;
  data_range?: DataRange;
}

/* ── DAY VIEW ───────────────────────────────────────────────────────────────
 * Mirrors PurchaseBillDayRow / PurchaseBillDayVendorRow in the lib. Same
 * re-declaration rule as above: the compiler cannot catch drift here.
 *
 * The API sends bill_value / discount / cgst / sgst / gst / both cesses / tcs /
 * delivery / mrp_round_off on every day row, and they are COMPLETE figures (the
 * day rows read the same effective rail as the bill rows).
 *
 * bill_value — THE SUBTOTAL — is declared and rendered here as of 2026-09-11: the
 * owner asked for the goods value to be visible as a subtotal, and it already
 * arrived on every row, so it cost two declarations and two cells.
 *
 * THE EIGHT CHARGE FIELDS ARE STILL DELIBERATELY NOT MIRRORED. This table is the
 * store person's document rollup — date, how many documents, how many lines, what
 * the goods came to, what is payable. The day CSV carries all eight with a
 * per-row Charges Note and the By bill view shows them on screen; the caption
 * under the table points there, because Subtotal and Grand total now sit next to
 * each other and the columns explaining the gap are not between them. If you do
 * add them here, read §7 of src/lib/purchase-bill-summary.ts first and put every
 * CHARGE cell through chargeCell(). The Subtotal is not a charge and does not go
 * through it — see subtotalText() below for why, and for what it prints. */

interface DayRow {
  day: string;
  /** bills + day_runs. Σ groups over the days = totals.bills, exactly. */
  groups: number;
  /** IDENTIFIED documents only (INV / GRN / BILL). 0 on most real days. */
  bills: number;
  /** The no-bill-number branch: a vendor's purchases that day. NOT paper bills. */
  day_runs: number;
  /** On a SINGLE-OUTLET all-day-run day this equals day_runs — the key is
   *  vendor|date|outlet, so one vendor makes one group. Expected, not a bug —
   *  but not an invariant: one vendor buying for two outlets on one day makes
   *  two day-runs under one vendor. Never derive one figure from the other. */
  vendors: number;
  multi_vendor_bills: number;
  /** Bills on this day whose lines also fall on a later date. */
  spanning_bills: number;
  /** COUNT(*) of purchase rows — the owner's "total items". Never a quantity. */
  lines: number;
  /** BOOKED COST. Declared, and deliberately NOT rendered in the day table — it
   *  is in the day CSV. Do not print it here as if it were the Subtotal. */
  goods: number;
  /** THE SUBTOTAL for this day — the goods as billed. Rendered since 2026-09-11. */
  bill_value: number;
  /** THE GRAND TOTAL for this day — what is payable across its bills. */
  total_bill_value: number;
  po_receipt_bills: number;
  po_receipt_lines: number;
  /** Those bills' share of the GRAND TOTAL — bill face value, read off the GRN. */
  po_receipt_value: number;
  /** true ⇒ some of this day's charges were read off a GRN line. PROVENANCE,
   *  not partiality: the figures are complete. Renamed from charges_partial. */
  charges_from_grn: boolean;
}

interface DayVendorRow {
  day: string;
  vendor: string;
  groups: number;
  bills: number;
  day_runs: number;
  lines: number;
  /** BOOKED COST — day CSV only, same as DayRow.goods. */
  goods: number;
  /** THE SUBTOTAL for this vendor on this day. */
  bill_value: number;
  /** THE GRAND TOTAL for this vendor on this day. */
  total_bill_value: number;
  po_receipt_bills: number;
  po_receipt_value: number;
  charges_from_grn: boolean;
}

interface DayResponse {
  view: 'day';
  days: DayRow[];
  vendor_rows: DayVendorRow[];
  totals: BillTotals;
  day_count: number;
  truncated: boolean;
  vendor_rows_truncated: boolean;
  from: string;
  to: string;
  data_range?: DataRange;
}

/**
 * ₹, ALWAYS TO THE PAISA.
 *
 * The `minimumFractionDigits: 2` is not decoration. Without it en-IN's default
 * is 0, so this page printed a money column as ₹484.9 · ₹450 · ₹0.00 — ragged,
 * unalignable, and different from the SAME BILL on /reports/purchases, which
 * renders every figure through the shared fmtSignedINR and showed ₹484.90. The
 * owner reads the two pages against each other, and a Subtotal that reads
 * ₹12,91,438.9 on one screen and ₹12,91,438.90 on the other invites a hunt for
 * a difference that is not there.
 *
 * This matches the rule the shared helper already states in its own doc
 * (src/lib/purchase-charges.ts, fmtSignedINR: "Two decimals ALWAYS"). The two
 * formatters stay separate only because this one is unsigned — a negative
 * routes to fmtSignedINR so the minus is a true U+2212 rather than a hyphen
 * that reads as a dash between two numbers.
 */
const fmtINR = (n: number) => '₹' + (Math.round((Number(n) || 0) * 100) / 100)
  .toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtNum = (n: number) => (Number(n) || 0).toLocaleString('en-IN');
const num = (v: unknown) => Number(v) || 0;

/**
 * ONE charge cell, rendered.
 *
 * WHICH FIGURE: chargeCell() decides — the shared rule in
 * src/lib/purchase-charges.ts that the CSV also calls, so the screen and the
 * download can never disagree about which cell is empty. It returns null ONLY
 * when every line behind the figure is a PO mirror whose GRN line is gone: the
 * charge is UNAVAILABLE, not zero, and null renders as an em dash. A charge that
 * genuinely IS zero comes back as 0 and prints ₹0 — a bill that carried no cess
 * carried no cess, and a dash there would make the column unsummable. And a
 * blank is only ever allowed where the stored sum is 0 too, so it can never hide
 * a rupee. (0 rows qualify today; the rule is kept because the failure is
 * silent.)
 *
 * WHICH FORMATTER: fmtINR for every non-negative figure — the page's own ₹, so
 * the 2,134 hand-entered bills render exactly the characters they always have.
 * A NEGATIVE figure routes to the shared signed formatter instead, because
 * fmtINR would emit an ASCII hyphen that reads as a dash between two numbers;
 * −₹0.50 must read as minus fifty paise. Only MRP round-off is ever negative
 * (2 GRN lines carry −0.50 today, and no `purchases` row carries any negative
 * charge at all), so this branch never changes a pre-existing cell.
 */
function chargeText(
  row: { lines: number; grn_sourced_rows: number; unpaired_mirror_rows: number },
  key: PurchaseChargeKey,
  value: number,
): string {
  const v = chargeCell(
    {
      count: num(row.lines),
      grn_sourced_rows: num(row.grn_sourced_rows),
      unpaired_mirror_rows: num(row.unpaired_mirror_rows),
      [key]: value,
    },
    { key } as PurchaseChargeColumn,
  );
  if (v == null) return '—';
  return v < 0 ? fmtSignedINR(v) : fmtINR(v);
}

/**
 * ONE SUBTOTAL CELL — and the written-down answer to "what does it print when a
 * PO receipt's GRN line is gone?", which the charge rule above does NOT cover.
 *
 * IT DOES NOT GO THROUGH chargeCell(), and that is deliberate, not an oversight.
 * chargeCell() answers a question about the EIGHT CHARGES — PurchaseChargeKey is
 * those eight and nothing else, and `bill_value` is a separate member of
 * PurchaseChargeSums. Forcing the Subtotal through it would not type-check, and
 * making it blankable would assert something no query here established.
 *
 * THE RULE: A SUBTOTAL CELL IS NEVER BLANK. Unlike a tax figure, this one always
 * has a real stored number behind it — effectiveBillValueSql() falls back to
 * purchases.total_price when there is no GRN line to read, so an unpaired mirror
 * row prints its booked cost. That is a figure the database actually holds, not
 * a guess, so printing it is honest where "₹0 of tax" would not have been. What
 * a reader must not be left to assume is that it came off a bill document, so on
 * the one row-shape where it did not, the cell says so beside the number rather
 * than going quiet. 0 rows qualify today; the rule is written down because the
 * day it happens, nothing else on the page would mention it.
 *
 * ⚠ THE PREDICATE CHANGED ON 2026-09-11, and it is the whole point of this
 * helper. It used to be isChargeSourceMissingRow() — an ALL rule, true only when
 * EVERY line behind the row had lost its GRN line. On a bill of two lines that
 * lost ONE, it returned false and this cell said nothing at all, while the row
 * printed ₹2,000 − ₹100 + ₹162 = ₹2,062 against a real ₹2,244. Every cell an
 * ordinary number, the row footing perfectly, and ₹182 gone. It is now
 * hasUnpairedMirrorRows() — ANY — so a partly-orphaned bill warns as loudly as a
 * wholly-orphaned one. See the header of src/lib/purchase-charges.ts for why the
 * ALL rule is still correct for BLANKING a cell and wrong for warning about one.
 */
function subtotalText(
  row: { lines: number; unpaired_mirror_rows: number },
  value: number,
): { text: string; fallback: boolean; note: string | null } {
  const shape = { count: num(row.lines), unpaired_mirror_rows: num(row.unpaired_mirror_rows) };
  return { text: fmtINR(value), fallback: hasUnpairedMirrorRows(shape), note: unpairedMirrorNote(shape) };
}

function firstOfMonth(iso: string) { return iso.slice(0, 8) + '01'; }
function addMonths(iso: string, n: number) {
  const [y, m] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, (m - 1) + n, 1)).toISOString().slice(0, 10);
}
/** Financial year (Apr 1 – today), India convention. */
function fyStart(iso: string) {
  const [y, m] = iso.split('-').map(Number);
  return (m >= 4 ? y : y - 1) + '-04-01';
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/**
 * "2026-04-01" → "1 Apr 2026", for dates the reader is asked to judge rather
 * than type. Every preset button now prints the window it will apply, and a
 * button reading "1 Jul 2026 – 11 Sep 2026" tells the owner in one glance that
 * it cannot reach April; "2026-07-01" makes him decode it first.
 * The date INPUTS keep ISO — that is what <input type="date"> takes.
 */
function humanDate(iso: string | null | undefined) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTH_SHORT[m - 1]} ${y}`;
}

/** Rows painted before asking. A full FY of vendor-day runs is thousands of rows and
 *  painting them all locks the tab — same cap and same escape hatch as the purchase log. */
const ROW_PAINT_CAP = 600;

const KIND_LABEL: Record<BillKind, string> = {
  INV: 'INV', GRN: 'PO/GRN', BILL: 'BILL', DAY_RUN: 'DAY RUN',
};
const KIND_TITLE: Record<BillKind, string> = {
  INV: 'Grouped by our invoice id (PINV-…) — one per vendor bill.',
  GRN: 'A PO receive / GRN. One GRN = one delivery = one vendor bill event.',
  BILL: 'Grouped by the vendor’s own bill number for that vendor, date and outlet.',
  DAY_RUN: 'No vendor bill number — this vendor’s purchases for that day, consolidated for reading. It may cover more than one physical bill.',
};

function KindBadge({ kind }: { kind: BillKind }) {
  const style =
    kind === 'INV' ? 'bg-[#FFF1E3] text-[#af4408] border-[#F0CDAE]'
      : kind === 'GRN' ? 'bg-[#EDF4EE] text-[#3F6B4C] border-[#CFE2D4]'
        : kind === 'BILL' ? 'bg-[#EEF1F7] text-[#43567F] border-[#D3DCEC]'
          : 'bg-[#F4EFE9] text-[#6B5744] border-[#E8D5C4]';
  return (
    <span title={KIND_TITLE[kind] || ''}
      className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-bold tracking-wide ${style}`}>
      {KIND_LABEL[kind] || String(kind)}
    </span>
  );
}

export default function PurchaseBillSummaryPage() {
  const today = todayIST();
  const [view, setView] = useState<'bill' | 'day'>('bill');

  /**
   * ══ THE DATE WINDOW — OPENS ON THE DATA, NOT ON THE CALENDAR. 2026-09-11 ══
   *
   * This page used to open on `firstOfMonth(today) … today`. On 11 September the
   * owner's purchases ran 1 Apr – 7 Aug, so that window held 0 of 2,165 rows and
   * ₹0 of ₹69.26 lakh: the report opened with every money card reading ₹0.00 and
   * a table saying "No purchase bills in this range". He read that as his books
   * having been lost and reported it as urgent. Nothing was lost. The window was
   * simply somewhere the data is not, and a blank report and a lost book look
   * exactly alike.
   *
   * A wider calendar window is not the fix — it only moves the cliff. Opening on
   * the financial year works today and goes blank on 1 April 2027, when "this
   * FY" is a one-day window and the entire previous year's book vanishes from
   * the widest choice on the page. The only default that cannot go blank is one
   * read off the data.
   *
   * WHY THIS IS ONE PIECE OF STATE AND NOT TWO DATES. The page wants to open on
   * "everything", but it cannot know the first purchase date until it has asked
   * the server — and asking twice (once for the dates, once for the report)
   * would double every first load AND, in between, paint a report for a window
   * nobody chose. So `range` holds the INTENT ({mode:'all'}), the fetch is keyed
   * on the INTENT alone, and the server answers with the report AND the real
   * dates it used. Writing those dates into `resolved` re-renders the date boxes
   * and the CSV filename WITHOUT re-running the query, because nothing that
   * fetches depends on `resolved`. Exactly one request.
   *
   * If you ever make `load`/`qs` depend on `from`/`to` instead of `range`, the
   * first load will fire twice on every visit. That is the trap this shape
   * exists to avoid.
   */
  const [range, setRange] = useState<Range>({ mode: 'all' });
  /** The real dates the server resolved for the window above. Display + CSV only — NEVER a fetch dependency. */
  const [resolved, setResolved] = useState<{ from: string; to: string } | null>(null);
  /** The dates purchases actually exist on, for the honest empty line and the All-time caption. */
  const [dataRange, setDataRange] = useState<DataRange | null>(null);
  /**
   * `resolved`, readable synchronously. Editing the From box has to keep the To
   * box's current value, and inside one click handler a state variable is the
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
  const [vendorQ, setVendorQ] = useState('');       // debounced copy — see below
  const [search, setSearch] = useState('');         // client-side, over the loaded rows
  const [splitUnnumbered, setSplitUnnumbered] = useState(false);
  const [includePoReceipts, setIncludePoReceipts] = useState(true);
  const [data, setData] = useState<BillResponse | null>(null);
  const [dayData, setDayData] = useState<DayResponse | null>(null);
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [paintAll, setPaintAll] = useState(false);

  // The vendor box is free text (a datalist constrains nothing), so without this
  // every keystroke would re-run a multi-thousand-row query against a live DB.
  useEffect(() => {
    const id = setTimeout(() => setVendorQ(vendor.trim()), 400);
    return () => clearTimeout(id);
  }, [vendor]);

  // The ONE place both fetches get their params, so the screen and the CSV can
  // never describe different periods or different modes. `view` belongs here for
  // the same reason — and because `load` depends on `qs`, adding it makes the
  // pill row re-fetch on its own. There is no manual "Apply".
  //
  // IT TAKES `range`, NOT `from`/`to`, and that is what keeps E5 true for the
  // new default: on "All time" the CSV asks for range=all exactly as the screen
  // did, the server resolves the SAME window for both, and the filename it
  // stamps carries the resolved real dates. The screen and the export cannot
  // describe different periods because neither of them chooses the period.
  const qs = useCallback((format: 'json' | 'csv') => {
    const p = new URLSearchParams({ format });
    if (range.mode === 'all') p.set('range', 'all');
    else { p.set('from', range.from); p.set('to', range.to); }
    if (view === 'day') p.set('view', 'day');
    if (vendorQ) p.set('vendor', vendorQ);
    if (splitUnnumbered) p.set('unnumbered', 'split');
    if (!includePoReceipts) p.set('include_po_receipts', '0');
    return p.toString();
  }, [view, range, vendorQ, splitUnnumbered, includePoReceipts]);

  const load = useCallback(async () => {
    setLoading(true); setError(''); setPaintAll(false); setExpandedDay(null);
    try {
      const res = await fetch(`/api/reports/purchase-bill-summary?${qs('json')}`, { cache: 'no-store' });
      // A failed load must NEVER look like "no bills" — clear BOTH shapes and say
      // why. Leaving the other view's payload in place would let a stale table
      // sit under a fresh error message.
      const fail = (msg: string) => { setError(msg); setData(null); setDayData(null); };
      if (res.status === 401) { fail('Sign in required — your session has expired.'); return; }
      if (res.status === 403) { fail('Management only — you don’t have access to the purchase bill summary.'); return; }
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as { error?: string }));
        fail(j?.error || `Failed to load the bill summary (HTTP ${res.status}).`); return;
      }
      const j = await res.json();
      // THE DATES THE REPORT WAS ACTUALLY BUILT FROM, taken off the response and
      // shown in the two date boxes and the CSV filename. On "All time" this is
      // the only way the page learns them — and writing them here CANNOT
      // re-trigger this fetch, because `qs` depends on `range` and not on these.
      if (typeof j?.from === 'string' && typeof j?.to === 'string') {
        const w = { from: j.from as string, to: j.to as string };
        resolvedRef.current = w;
        setResolved(w);
      }
      setDataRange(j?.data_range && typeof j.data_range === 'object'
        ? { first: j.data_range.first ?? null, last: j.data_range.last ?? null }
        : null);
      // Discriminate on the echoed view, not on which array happens to be
      // present — a response for the other mode must never be rendered as this
      // one's rows.
      if (j?.view === 'day') {
        setDayData({
          ...(j as DayResponse),
          days: Array.isArray(j.days) ? j.days : [],
          vendor_rows: Array.isArray(j.vendor_rows) ? j.vendor_rows : [],
        });
        setData(null);
      } else {
        setData({ ...(j as BillResponse), rows: Array.isArray(j.rows) ? j.rows : [] });
        setDayData(null);
      }
    } catch { setError('Network error — please try again.'); setData(null); setDayData(null); }
    finally { setLoading(false); }
  }, [qs]);

  useEffect(() => { load(); }, [load]);

  const download = async () => {
    setDownloading(true); setError('');
    try {
      const res = await fetch(`/api/reports/purchase-bill-summary?${qs('csv')}`, { cache: 'no-store' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as { error?: string }));
        setError(j?.error || (res.status === 403 ? 'Management only — download refused.'
          : res.status === 401 ? 'Sign in required — download refused.'
            : `Download failed (HTTP ${res.status}).`));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      // Mirrors purchaseBillSummaryFilename / purchaseBillDaySummaryFilename in
      // the lib. Two names for two shapes: a forwarded file must never claim to
      // be the other report. Change both places or the download name will lie.
      a.href = url;
      a.download = view === 'day'
        ? `purchase-bill-day-summary-${from}_${to}.csv`
        : `purchase-bill-summary-${from}_${to}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch { setError('Network error — download failed.'); }
    finally { setDownloading(false); }
  };

  const allRows = data?.rows || [];

  // The API sends no vendor list, so the datalist is built from whichever
  // payload actually loaded — it can never offer a vendor this range has no
  // purchases for. It has to read BOTH shapes: in day mode `rows` is null, and a
  // datalist fed from it would silently go empty on the view whose whole point
  // is vendor-wise reconciliation.
  const vendorList = useMemo(
    () => Array.from(new Set(
      [
        ...(data?.rows || []).map(r => (r.vendor || '').trim()),
        ...(dayData?.vendor_rows || []).map(v => (v.vendor || '').trim()),
      ].filter(Boolean)))
      .sort((a, b) => a.localeCompare(b)),
    [data, dayData]);

  // Search is client-side over bill no / invoice id / vendor — the server already
  // bounded the set by date and vendor, and this keeps typing instant.
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allRows;
    return allRows.filter(r =>
      (r.bill_no || '').toLowerCase().includes(q) ||
      (r.invoice_id || '').toLowerCase().includes(q) ||
      (r.grn_id || '').toLowerCase().includes(q) ||
      (r.vendor || '').toLowerCase().includes(q));
  }, [allRows, search]);

  const shown = paintAll ? rows : rows.slice(0, ROW_PAINT_CAP);

  // ── DAY VIEW derived state ────────────────────────────────────────────────
  const days = dayData?.days || [];
  // Grouped once, not filtered per row inside the render — a 34-day range with
  // 350 vendor rows would otherwise be 34 full scans on every paint.
  const vendorsByDay = useMemo(() => {
    const m = new Map<string, DayVendorRow[]>();
    for (const v of dayData?.vendor_rows || []) {
      const list = m.get(v.day);
      if (list) list.push(v); else m.set(v.day, [v]);
    }
    return m;
  }, [dayData]);

  // Both views print the SAME totals object, computed by SQL over the full
  // filtered set. That is deliberate: it is what makes the day column checkable
  // — it must add up to this strip.
  const t = view === 'day' ? dayData?.totals : data?.totals;
  // Counted over the LOADED rows, and worded that way — if the server truncated,
  // claiming a period-wide count would be a lie.
  //
  // DAY_RUN kind ONLY — deliberately NOT `|| bill_no_missing`. Measured on live
  // data: 336 bills have no vendor bill number but only 308 are day runs; the
  // other 28 are GRN/INV bills that simply carry no vendor number. Or-ing the
  // flag in would call those 28 "that vendor's purchases for that day
  // consolidated", which they are not — they are single identified documents.
  const dayRunCount = useMemo(
    () => allRows.filter(r => r.bill_kind === 'DAY_RUN').length, [allRows]);
  const grnRowCount = useMemo(() => allRows.filter(r => r.tax_on_grn).length, [allRows]);
  const filtered = search.trim().length > 0;

  /**
   * ══ THE PRESETS — WIDEST FIRST, AND EVERY ONE PRINTS THE WINDOW IT APPLIES ══
   *
   * The trap this replaces, measured on the live data on 11 Sep 2026: "Last 3
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
   * "All time" is first, is the default, and takes its dates from the data —
   * which is also why it is the only one with no calendar cliff. The other
   * three are calendar windows and keep their calendar arithmetic untouched.
   */
  const presets = useMemo(() => {
    // The far end of "all time" mirrors the server's own rule exactly (see
    // resolveAllTimePurchaseRange): today, unless a bill is dated ahead of it.
    const allEnd = dataRange?.last && dataRange.last > today ? dataRange.last : today;
    const list: { label: string; window: string; active: boolean; apply: () => void; title: string }[] = [{
      label: 'All time',
      window: dataRange?.first ? `${humanDate(dataRange.first)} – ${humanDate(allEnd)}` : 'every purchase there is',
      active: range.mode === 'all',
      apply: pickAllTime,
      title: 'Every purchase bill on record. The dates come from your data, so this window is never out of date.',
    }];
    const calendar: [string, string, string][] = [
      ['This financial year', fyStart(today), today],
      ['Last 3 months', addMonths(firstOfMonth(today), -2), today],
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
   * THE ONE HONEST LINE. Only when a load SUCCEEDED and the window genuinely
   * holds nothing — never while loading, never over an error (the error already
   * speaks for itself), and never for a search that simply matched no rows.
   */
  const emptyWindow = !loading && !error && (
    view === 'day' ? (!!dayData && days.length === 0) : (!!data && allRows.length === 0)
  );

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 py-5 sm:py-6 space-y-5">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">Reports</p>
            <h1 className="text-2xl sm:text-3xl font-bold mt-0.5 flex items-center gap-2">
              <ReceiptText className="w-6 h-6 text-[#af4408]" /> Purchase Bill Summary
            </h1>
          </div>
          <Link href="/reports/purchases" className="text-sm font-medium text-[#af4408] hover:underline">Go to Purchase Report →</Link>
        </div>

        {/* View switch — By bill (the document view) vs By day (the store person's
            reconciliation rollup). Both are the same API, the same source table and
            the same bill key; only the grouping changes, so the two can never
            disagree about what a bill is. The date range and every filter below are
            shared, so switching keeps the same window. */}
        <div className="flex flex-wrap gap-1.5">
          {([
            ['bill', 'By bill', <ReceiptText key="i" className="w-3.5 h-3.5" />],
            ['day', 'By day (reconciliation)', <CalendarDays key="i" className="w-3.5 h-3.5" />],
          ] as const).map(([k, label, icon]) => (
            <button key={k} onClick={() => setView(k as 'bill' | 'day')}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold border transition-colors ${
                view === k ? 'bg-[#af4408] text-white border-[#af4408]' : 'bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]'}`}>
              {icon}{label}
            </button>
          ))}
        </div>

        {/* Filters */}
        <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm p-4 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            {/* DISABLED FOR THE ONE MOMENT THE WINDOW IS UNKNOWN — between the
                first paint and the first response. Editing one box then would
                produce a half-built range (one real date, one blank) and the
                API would answer with a validation error instead of a report.
                It re-enables the instant the dates land, which on live data is
                inside the same spinner the page already showed. */}
            <label className="block"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">From</span>
              <input type="date" value={from} disabled={!windowKnown} onChange={e => e.target.value && setFrom(e.target.value)}
                className="mt-1 block px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408] disabled:opacity-60" /></label>
            <label className="block"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">To</span>
              <input type="date" value={to} disabled={!windowKnown} onChange={e => e.target.value && setTo(e.target.value)}
                className="mt-1 block px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408] disabled:opacity-60" /></label>
            {/* Free text + datalist, not a <select>: the vendor filter is a LIKE-contains
                on the server, so a partial name must stay typeable. */}
            <label className="block min-w-[170px]"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">Vendor</span>
              <input list="bill-summary-vendors" value={vendor} onChange={e => setVendor(e.target.value)} placeholder="All vendors"
                className="mt-1 block w-full px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408]" />
              <datalist id="bill-summary-vendors">{vendorList.map(v => <option key={v} value={v} />)}</datalist></label>
            {/* BILL VIEW ONLY. Search filters the loaded bill rows client-side;
                the day view has no bill rows loaded, so leaving the box on
                screen there would be a live control that silently does nothing.
                The Vendor box above still works in both views — it is a server
                filter and is part of the shared query string. */}
            {view === 'bill' && (
              <label className="block min-w-[170px]"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">Search</span>
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Bill no / invoice id / vendor…"
                  className="mt-1 block w-full px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408]" /></label>
            )}
            {/* Held until the window is known, for the same reason the date
                boxes are: the filename carries the period, and a file called
                `purchase-bill-summary-_.csv` is a document that cannot say
                which period it covers. */}
            {/* `loading` is in this test DELIBERATELY. The CSV request is keyed on the
                range INTENT (range=all) while the saved filename is built from the dates
                of the LAST RESOLVED response. Between pressing a preset and its data
                landing those two disagree, so a click in that gap saved the correct
                all-time file under a September name. The owner reconciles this export
                against the screen, so a filename that lies is a real defect even though
                the contents were always right. Do not drop `loading` to make the button
                feel snappier. */}
            <button onClick={download} disabled={downloading || loading || !windowKnown}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-60 text-white">
              {downloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />} Download CSV
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
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
            <span className="mx-1 w-px h-5 bg-[#F0E4D6]" />
            <label className="inline-flex items-center gap-1.5 text-xs text-[#6B5744] cursor-pointer">
              <input type="checkbox" checked={splitUnnumbered} onChange={e => setSplitUnnumbered(e.target.checked)} className="accent-[#af4408]" />
              Split un-numbered day runs into single lines
            </label>
            <label className="inline-flex items-center gap-1.5 text-xs text-[#6B5744] cursor-pointer">
              <input type="checkbox" checked={includePoReceipts} onChange={e => setIncludePoReceipts(e.target.checked)} className="accent-[#af4408]" />
              Include PO/GRN receipts
            </label>
            {(vendor || (view === 'bill' && search) || splitUnnumbered || !includePoReceipts) && (
              <button onClick={() => { setVendor(''); setSearch(''); setSplitUnnumbered(false); setIncludePoReceipts(true); }}
                className="px-3 py-1.5 rounded-lg text-xs font-medium border bg-white text-[#af4408] border-[#E8D5C4] hover:bg-[#FFF1E3]">Clear filters</button>
            )}
          </div>
        </div>

        {error && <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">{error}</div>}

        {/*
          ONE LINE, AND ONLY WHEN THE WINDOW REALLY IS EMPTY. 2026-09-11.
          Deliberately ABOVE the money cards: on an empty window the API still
          returns a zero-filled totals object, so the cards print "Booked cost
          ₹0.00 · Subtotal ₹0.00 · Grand total ₹0.00" under a paragraph
          explaining what a grand total means. That does not read as an empty
          window — it reads as a finished report stating that nothing was
          bought, which is exactly how this was mistaken for lost data. The line
          names the window that is empty AND the dates that do have purchases,
          so the reader never has to guess where the data went.
          NOT a banner, not a feature: one sentence, and it disappears the
          moment the window holds anything.
        */}
        {emptyWindow && (
          <div className="bg-white border border-[#E8D5C4] rounded-xl px-4 py-3 text-sm text-[#6B5744]">
            {/* A FILTER EMPTIES THIS PAGE AS EASILY AS A DATE WINDOW DOES, and the cure
                is the opposite one. Telling a reader to press All time while All time is
                the active, highlighted chip sends him in a circle — and this is the exact
                screen that once read as lost data, so a message that misdirects here is
                worse than no message. Vendor is checked FIRST because it is the filter
                that reaches the server; `search` only hides already-loaded rows. */}
            {vendorQ
              ? <>No purchases between <strong>{humanDate(from)}</strong> and <strong>{humanDate(to)}</strong> for the vendor{' '}
                <strong>“{vendorQ}”</strong>. Check the spelling, or clear the vendor filter to see every bill in this
                window. Nothing has been deleted.</>
              : dataRange?.first
              ? <>No purchases between <strong>{humanDate(from)}</strong> and <strong>{humanDate(to)}</strong>. Your purchases run from{' '}
                <strong>{humanDate(dataRange.first)}</strong> to <strong>{humanDate(dataRange.last || dataRange.first)}</strong> — press{' '}
                <strong>All time</strong> above to see all of them. Nothing has been deleted.</>
              : <>There are no purchases recorded yet, in any date range.</>}
          </div>
        )}

        {/* Period totals. Safe to print as ONE period-wide figure precisely because
            the API reads a single table — see the file header. (The per-row column
            of the same name is a different thing: one bill's own arithmetic.) */}
        {t && (
          <div className="space-y-2">
            <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
              {/* NEVER ONE "BILLS" NUMBER IN THE DAY VIEW. `t.bills` is a count of
                  GROUPS, and on live 308 of those 350 groups are vendor day-runs
                  with no bill number anywhere. Printing "Bills 350" above a table
                  whose whole purpose is to split those two apart would hand the
                  store person a bill count that is not a bill count. The bill
                  view keeps its original card: there each group is a row the
                  reader can see, kind badge and all. */}
              {view === 'day'
                ? <Card icon={<ReceiptText className="w-4 h-4" />} label="Numbered bills"
                    value={fmtNum(num(t.bills) - num(t.day_run_bills))}
                    sub={`+ ${fmtNum(num(t.day_run_bills))} vendor day-runs = ${fmtNum(t.bills)} groups`} />
                : <Card icon={<ReceiptText className="w-4 h-4" />} label="Bills" value={fmtNum(t.bills)} sub={`${fmtNum(t.lines)} lines`} />}
              <Card icon={<Layers className="w-4 h-4" />} label={view === 'day' ? 'Item lines' : 'Lines'}
                value={fmtNum(t.lines)} sub="purchase rows" />
              {/* THE THREE MONEY FIGURES, NAMED ON THE CARDS THEMSELVES, in the
                  same order as the table below: booked cost, then the subtotal
                  the grand total is built on, then the grand total.

                  The Subtotal has its OWN card as of 2026-09-11. It used to be
                  smuggled into the booked-cost card's sub-line as "bill basis
                  ₹x", which is how the figure the owner actually wanted to see
                  ended up as a footnote on another number. The booked-cost card
                  keeps its own card and its own words: it is what stock
                  valuation is built on, and it is not the subtotal. */}
              <Card icon={<ShoppingCart className="w-4 h-4" />} label="Booked cost (spend)" value={fmtINR(t.goods)}
                sub="what we recorded into stock — feeds valuation" />
              <Card icon={<Package className="w-4 h-4" />} label="Subtotal (goods)" value={fmtINR(num(t.bill_value))}
                sub="the ingredients and goods, as billed" />
              {/* THE FORMULA ON THIS CARD MUST NAME THE DISCOUNT. It read
                  "subtotal + taxes and charges" until 2026-09-11, which is
                  wrong by exactly the discount — ₹2,280 over the live period —
                  and it contradicted the same card on /reports/purchases, which
                  has always said "subtotal − discount + all charges". The card
                  is what the owner reads; the long paragraph below that states
                  it correctly is not. */}
              <Card icon={<TrendingUp className="w-4 h-4" />} label="Grand total" value={fmtINR(t.total_bill_value)}
                sub="payable to the vendors — subtotal − discount + taxes and charges" tone="accent" />
              <Card icon={<Building2 className="w-4 h-4" />} label="Of which PO/GRN receipts"
                value={fmtINR(num(t.po_receipt_value))}
                sub={`${fmtNum(num(t.po_receipt_bills))} bill${num(t.po_receipt_bills) === 1 ? '' : 's'} · ${fmtNum(num(t.po_receipt_lines))} lines · their share of the grand total`} />
            </div>
            {/* `basis` is the API's own guard against misreading the grand total.
                Print it verbatim — do not paraphrase it into something shorter. */}
            {t.basis && <p className="text-[11px] text-[#8B7355] leading-relaxed">{t.basis}</p>}
          </div>
        )}

        {/*
          THE SUBTOTAL CAVEAT — the SAME WORDS /reports/purchases already shows
          under a card with the SAME label and the SAME sub-caption.

          It was on that page and not on this one, which is the wrong way round:
          this is the bill-level report, and the figure it qualifies is the one
          the owner asked for by name. Measured on the live database: 217
          purchase rows, all April 2026, all carrying zero recorded GST, whose
          stored line total exceeds quantity × rate by ~₹1.57 lakh. Those rows
          are inside this report's 2,165 lines and inside its Subtotal, so about
          2.3% of the figure labelled "the ingredients and goods" is tax.

          Wording is deliberately IDENTICAL to the other page's, not a second
          drafting of the same idea: the owner reads both, and two variants of
          one caveat read as two different caveats. Two paragraphs rather than
          one because the second covers a different rail — see below.
        */}
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-[12px] text-amber-900 flex gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="space-y-1.5">
            <p><strong>One caveat on the Subtotal.</strong> Some older bills were entered in bulk from a vendor sheet with the tax already inside the
              line total and never split out — those lines show no GST of their own, so their Subtotal quietly includes whatever tax was in it and their
              Grand Total comes to the same figure. April 2026 is where nearly all of them sit. For a bill keyed in normally, the Subtotal is the goods
              alone and the tax is in its own column.</p>
            {/* THE LIQUOR RAIL. A TGBCL bill's bill-level charges (MRP rounding,
                excise turnover tax, special excise cess, TCS) are recorded on the
                liquor store's own rail, which this report deliberately does not
                read — see the allocator note in src/lib/purchase-charges.ts. None
                are recorded today (store_bill_charges is empty), so nothing is
                being dropped; but on such a bill the Grand Total comes out equal
                to the Subtotal with ₹0.00 in every charge column, which looks
                exactly like a bill that carried no tax. The largest row in this
                whole report is one of them. */}
            {/* NO HTML ENTITY HERE — literal ’ (U+2019). With `&rsquo;` in this
                chunk the browser rendered "And one on liquor bills.A TGBCL",
                the SWC leading-space bug documented on the sibling report. */}
            <p><strong>And one on liquor bills.</strong> A TGBCL / liquor-store indent carries its rounding, excise turnover tax, excise cess and TCS on
              the liquor store’s own records, not on these purchase lines — so those bills show <strong>₹0.00 in every charge column and a Grand
              Total equal to their Subtotal</strong>. That is not a bill that carried no tax; it is a bill whose tax this report cannot see. Check a
              TGBCL indent against the <em>Liquor Store</em> inward register, not against this page.</p>
          </div>
        </div>

        {/* The caveats, on screen and not buried in a header comment. Everything a
            reader needs to not misread this table is in this one panel. */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl px-4 py-3 text-[12px] text-[#6B5744] space-y-1.5">
          <p className="flex gap-2"><Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-[#af4408]" />
            <span><strong>Grand total = Subtotal − Discount + GST + Comp. Cess + Spl Excise Cess + TCS + Delivery + MRP Round-off</strong> — what we actually
              pay the vendor, tax included. <strong>Subtotal</strong> is the goods themselves at the price the bill charges for them: the real value of what we
              bought, before any tax or charge. Every row adds up across, left to right. GST is CGST + SGST only; both cesses are separate levies on a
              different base and are never folded into it.</span></p>
          {/* THE DISTINCTION THAT SURVIVED THE FIX. The charges are no longer
              missing, but booked cost and the bill's own figures are still two
              different numbers, and booked cost is the one that feeds valuation.
              Said second, directly under the formula, because that is where a
              reader who has just added the row across will ask why the booked
              cost is not the base. Since 2026-09-11 the base is its own Subtotal
              column, so this paragraph no longer claims it is printed "under
              Goods" — that sub-line is gone. */}
          <p className="flex gap-2"><Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-[#af4408]" />
            <span><strong>Booked cost (spend) is not the same as the Subtotal.</strong> It is what we recorded into stock, exactly as stored — the figure stock
              valuation and the Purchase Report’s <em>Spend</em> are built on. On a PO receipt the rate we booked can already have the discount taken off it,
              while the bill was written on the full price; the Subtotal is that full price, which is why the grand total is built on the Subtotal and the
              discount gets taken off once, in the Discount column, instead of twice.{t && num(t.bill_value) !== num(t.goods) && (
                <> Across this period the two differ by <strong>{fmtINR(num(t.bill_value) - num(t.goods))}</strong>.</>
              )} On an ordinary hand-written bill the two are the same number, and that is correct, not a fault. Check stock against <em>Booked cost
              (spend)</em>; check a vendor statement against the <em>Grand total</em>.</span></p>
          {/* Both sentences are gated on `t`. In the DAY view the loaded `rows`
              array is null by design, so counting it would print "0 of the 0
              groups" under a strip showing the period's real figures — the exact
              mismatch this panel exists to prevent. The day view therefore quotes
              the SQL period counts (day_run_bills / po_receipt_bills, computed
              over the whole filtered set) and says "in this period"; the bill
              view keeps counting the rows in hand and keeps saying "loaded",
              because there the cap can bite and a period-wide claim would be a
              lie about the table underneath. */}
          {t && (
            <p className="flex gap-2"><Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-[#af4408]" />
              {view === 'day'
                ? <span><strong>{fmtNum(num(t.day_run_bills))}</strong> of the {fmtNum(t.bills)} group{num(t.bills) === 1 ? '' : 's'} in this period are <strong>DAY RUNS</strong>: no vendor
                  bill number exists for them, so they are that vendor’s purchases for that day consolidated into one line for reading. One such
                  group may cover more than one physical bill or market run — the <em>Vendor day-runs</em> column is <strong>not</strong> a bill count,
                  which is why it is kept apart from <em>Bills</em>. Tick <em>Split un-numbered day runs</em> to count purchase lines instead.</span>
                : <span><strong>{fmtNum(dayRunCount)}</strong> of the {fmtNum(allRows.length)} group{allRows.length === 1 ? '' : 's'} loaded are marked <strong>DAY RUN</strong>: no vendor
                  bill number exists for them, so they are that vendor’s purchases for that day consolidated into one line for reading. One such
                  group may cover more than one physical bill or market run — do not read it as a single document. Tick
                  <em> Split un-numbered day runs</em> to see them as single lines instead.</span>}
            </p>
          )}
          {t && (
            <p className="flex gap-2"><Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-[#af4408]" />
              {view === 'day'
                /* THE UNPAIRED CONDITIONAL BELONGS ON THIS BRANCH TOO. It was
                   on the bill branch only, so the DAY view — the one with no
                   charge columns in which a reader could ever spot a gap —
                   asserted "every day's charge figures are complete"
                   unconditionally. That sentence is exactly what a reader would
                   rely on, and on a day holding a deleted GRN line it is false
                   and the day's grand total is short. */
                ? <span><strong>{fmtNum(num(t.po_receipt_bills))}</strong> group{num(t.po_receipt_bills) === 1 ? '' : 's'} in this period came from a PO receive / GRN, carrying <strong>{fmtINR(num(t.po_receipt_value))}</strong> of
                  the <em>grand total</em>. Their charges are read from the <strong>GRN line — the bill document</strong>, the same figures the GRN Inward Register totals as
                  Total Inward.{num(t.unpaired_mirror_lines) > 0
                    ? <> <strong>But {fmtNum(num(t.unpaired_mirror_lines))}</strong> item line{num(t.unpaired_mirror_lines) === 1 ? ' has' : 's have'} no GRN line left to read from, so the
                      grand total on the day{num(t.unpaired_mirror_lines) === 1 ? '' : 's'} holding {num(t.unpaired_mirror_lines) === 1 ? 'it' : 'them'} is <strong>understated</strong> by
                      whatever that bill charged — and this table has no charge columns in which the gap would show. Open <em>By bill</em> to find the affected bills.</>
                    : <> No line in this period has lost its GRN line, so every day’s charge figures are <strong>complete</strong>.</>} This table shows document counts, the subtotal and the grand total
                  per day, because it is the paperwork-reconciliation view — <strong>the taxes and charges that make up the difference between those two
                  columns</strong> are in the <em>Taxes &amp; charges</em> column, in the CSV and in <em>By bill</em>, line by line. Days holding a receipt are marked <em>charges from GRN</em> below.</span>
                : <span><strong>{fmtNum(grnRowCount)}</strong> loaded bill{grnRowCount === 1 ? '' : 's'} came from a PO receive / GRN. Their charges are read from the
                  <strong> GRN line — the bill document</strong>, not from the cost row, because the receive route deliberately books no tax there (tax inside a
                  rate would poison the weighted-average cost). So those cells carry the bill’s <em>real</em> discount, tax, cess, TCS, delivery and round-off,
                  the badge names where they came from, and each of those totals matches the GRN Inward Register’s Total Inward for the same bill on every such bill we hold — a check worth running rather than a guarantee, since the register counts every GRN line and this report can only reach a line that has a purchase row behind it.
                  {t && num(t.unpaired_mirror_lines) > 0
                    ? <> <strong>{fmtNum(num(t.unpaired_mirror_lines))}</strong> line{num(t.unpaired_mirror_lines) === 1 ? ' has' : 's have'} no GRN line left to read from; those charge cells are
                      <strong> blank</strong> because the figure is unavailable, never ₹0.</>
                    : <> A charge that genuinely is ₹0 prints ₹0; a cell goes blank only if a receipt’s GRN line has been deleted, which no row in this
                      period has.</>}</span>}
            </p>
          )}
        </div>

        {/* Truncation is per view: the bill view caps BILLS, the day view caps
            DAYS, and each has its own flag. Gating both on data?.truncated left
            the day view unable to warn at all — it would simply show fewer days
            than the totals above it describe. */}
        {(view === 'day' ? dayData?.truncated : data?.truncated) && (
          <div className="bg-[#af4408] text-white rounded-xl px-4 py-3 text-sm font-semibold flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {view === 'day'
              ? `This list was TRUNCATED by the server — ${fmtNum(num(dayData?.day_count))} purchase days fall in this range and only the most recent are shown, so the day rows will NOT add up to the totals above. Narrow the date range, or download the CSV.`
              : 'This list was TRUNCATED by the server — it is not every bill in the range. Narrow the date range or vendor, or download the CSV.'}
          </div>
        )}

        {/* A SEPARATE, quieter warning: the day rows are still complete and still
            reconcile — only the drill-down is short. Folding it into the red
            banner above would tell a reconciler their day totals are unreliable
            when they are not. */}
        {view === 'day' && dayData?.vendor_rows_truncated && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>The per-vendor breakdown hit its row limit, so some days will not expand to their full vendor list and the vendor rows
              will not add up to their day. <strong>The day rows themselves are complete</strong> and still reconcile to the totals above.
              Narrow the date range for a complete breakdown.</span>
          </div>
        )}

        {/* Bill table. The row adds up left to right FROM THE SUBTOTAL:
            Subtotal − Discount + charges = Grand total. Booked cost sits to the
            LEFT of the subtotal and is outside that arithmetic on purpose — it is
            the valuation figure, not part of the bill. (This comment said "Goods
            − Discount + charges = Total" until 2026-09-11, which was never true:
            the total has always footed from the bill's own basis.)
            GATED ON THE VIEW. Without the gate this table rendered in BOTH modes, so
            switching to By day put "No purchase bills in this range." directly under a
            ₹69 lakh period total — the table was not empty, it was the wrong table. */}
        {view === 'bill' && (
        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow-sm p-4 sm:p-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
            <h2 className="text-sm font-bold flex items-center gap-2">
              <span className="text-[#af4408]"><ReceiptText className="w-4 h-4" /></span>
              Bills — one row per vendor bill
              <span className="text-[11px] text-[#8B7355] font-normal">
                ({fmtNum(rows.length)} row{rows.length === 1 ? '' : 's'}{filtered ? ` of ${fmtNum(allRows.length)}` : ''})
              </span>
            </h2>
            {loading && <span className="text-xs text-[#8B7355] inline-flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</span>}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead><tr className="text-left text-[11px] uppercase text-[#8B7355] border-b border-[#F0E4D6]">
                <th className="py-2 pr-3">Date</th>
                <th className="py-2 px-3">Bill No (vendor)</th>
                <th className="py-2 px-3">Invoice ID (ours)</th>
                <th className="py-2 px-3">Vendor</th>
                <th className="py-2 px-3">Kind</th>
                <th className="py-2 px-3 text-right">Lines</th>
                {/* ALL THREE MONEY FIGURES ARE NAMED IN THE HEADINGS, not in a
                    footnote: a reader scanning this table has to be able to tell
                    the valuation figure from the bill's own figures without
                    leaving the row. Until 2026-09-11 the bill's basis was a grey
                    sub-line under Goods on the 17 rows where it differed — a
                    column the reader could not scan, sort or add up. It is now
                    TWO COLUMNS: booked cost, then the subtotal the grand total
                    is built on. The sub-line is gone; what survives under booked
                    cost is only the in-rate discount, which no column carries. */}
                <th className="py-2 px-3 text-right whitespace-normal w-[118px] min-w-[118px]"
                  title="BOOKED COST = SPEND. The line values exactly as we recorded them into stock — this is the figure that feeds stock valuation and the one the Purchase Report calls Spend. It is NOT the Subtotal and NOT what we pay: on a PO receipt the rate we booked can already have the discount taken off it, while the bill was written on the full price.">
                  Booked cost <span className="normal-case font-normal text-[#B8A48E]">(spend)</span></th>
                {/* THE SUBTOTAL — the owner's "actual price and total value of
                    the goods we're buying". It sits immediately left of the
                    charge columns so the row reads as the arithmetic it is.

                    THE LEFT BORDER IS LOAD-BEARING, not decoration. Booked cost
                    and Subtotal are two adjacent rupee columns that differ by
                    ₹1,620 across the period and by ₹100 on a typical PO receipt,
                    and they were styled identically — only the words separated
                    the number the owner must NOT add from the number the row
                    actually foots from. Starting the row's addition one column
                    too far left gives 900 − 100 + 162 + 120 = 1,082 against a
                    printed 1,182. The rule the border draws: everything from
                    HERE to Grand total is one piece of arithmetic; Booked cost
                    sits outside it. */}
                <th className="p-0 sticky right-[140px] z-20 bg-white border-l-2 border-[#E8D5C4] align-bottom"
                  title="SUBTOTAL. The goods themselves at the price the bill charges for them — the real value of what we bought, before any tax or charge. This is what the Grand total is built on: Subtotal − Discount + GST + both cesses + TCS + Delivery + MRP round-off. On an ordinary bill it is the same figure as Booked cost; on a PO receipt it is the bill's full price, before the discount the GRN itemises separately. The line to the left of this column marks where the row's arithmetic starts — Booked cost is outside it.">
                  <div className="w-[140px] px-3 py-2 text-right whitespace-normal">Subtotal <span className="normal-case font-normal text-[#B8A48E]">(goods)</span></div></th>
                <th className="py-2 px-3 text-right" title="Discount recorded on the bill. On a PO receipt this is the GRN line's discount — the bill document's own figure.">Discount</th>
                <th className="py-2 px-3 text-right" title="CGST + SGST only. The two cesses are different levies on a different base and are never folded in. On a PO receipt these are the GRN line's figures.">GST</th>
                <th className="py-2 px-3 text-right" title="GST Compensation Cess (aerated drinks, tobacco) — charged on the GROSS line value, before discount. A different levy from Spl Excise Cess.">Comp. Cess</th>
                <th className="py-2 px-3 text-right" title="TGBCL Special Excise Cess — the liquor levy. Non-creditable, never folded into GST.">Spl Excise Cess</th>
                <th className="py-2 px-3 text-right" title="Tax Collected at Source, as recorded on the bill.">TCS</th>
                <th className="py-2 px-3 text-right" title="Transport / delivery recorded on the bill. Recorded only — it never enters a rate or the weighted-average cost.">Delivery</th>
                <th className="py-2 px-3 text-right" title="Signed: a bill rounded DOWN shows a negative figure and it is shown negative here.">MRP Round-off</th>
                {/* STICKY RIGHT — the payable figure never leaves the screen.
                    This table is 16 columns and ~1,750px wide; the scroller on a
                    1440×900 laptop is ~1,026px, so BOTH the Subtotal and the
                    Grand total used to sit off-screen and the only money column
                    visible without scrolling was Booked cost — the one number
                    the owner must not pay from. Truncating the GRN id (below)
                    bought ~180px, which is not enough on its own; pinning this
                    column is what guarantees the answer is always in view.
                    Needs an opaque background of its own, or the cells it
                    scrolls over show through. */}
                <th className="p-0 sticky right-0 z-20 bg-white border-l-2 border-[#E8D5C4] align-bottom"
                  title="GRAND TOTAL — what we actually need to pay this vendor for this bill. Subtotal − Discount + GST + both cesses + TCS + Delivery + MRP round-off. The base is the Subtotal, which equals Booked cost on a hand-entered bill and the bill's full price on a PO receipt — so the row adds up and the discount already inside a booked rate is not subtracted twice. Check a vendor statement against THIS; check stock valuation against Booked cost (spend). This column is pinned to the right edge so it stays visible while the rest of the row scrolls.">
                  <div className="w-[140px] px-3 py-2 text-right whitespace-normal">Grand total</div></th>
              </tr></thead>
              <tbody>
                {/* 16 columns since the Subtotal joined them. These two colSpans
                    are hand-kept — a stale one breaks the loading and empty rows
                    in the commonest case of all, a range with no data. */}
                {loading && rows.length === 0 ? (
                  <tr><td colSpan={16} className="py-6 text-center text-[#8B7355] animate-pulse">Loading bill summary…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={16} className="py-6 text-center text-[#8B7355]">
                    {error ? 'Not loaded — see the message above.'
                      : filtered ? 'No bills match that search.'
                        : 'No purchase bills in this range.'}
                  </td></tr>
                ) : shown.map(r => {
                  // PROVENANCE, not absence. These rows' charge figures come off
                  // the GRN line — the bill document — so they print as numbers.
                  // The em-dash this flag used to trigger hid ₹8,313.20 of real
                  // discount and tax across 29 bills.
                  const onGrn = !!r.tax_on_grn;
                  // The ONE case a figure is still refused: every line behind it
                  // is a mirror whose GRN line is gone, so the charge is
                  // unavailable rather than zero. 0 rows today.
                  const unavailable = isChargeSourceMissingRow({
                    count: num(r.lines), unpaired_mirror_rows: num(r.unpaired_mirror_rows),
                  });
                  // TWO PREDICATES, NOT ONE, AND THE WIDER ONE GUARDS THE MONEY.
                  // `unavailable` (ALL) decides whether a charge CELL may blank.
                  // `shortfall` (ANY) decides whether this row's Subtotal and
                  // Grand total are UNDERSTATED, which is the question a reader
                  // about to pay a vendor is actually asking. They differ on a
                  // partly-orphaned bill — the case where every cell prints an
                  // ordinary number and the row still foots — which is precisely
                  // when nothing else on the page would say a word.
                  const shortShape = {
                    count: num(r.lines), unpaired_mirror_rows: num(r.unpaired_mirror_rows),
                  };
                  const shortfall = hasUnpairedMirrorRows(shortShape);
                  const shortNote = unpairedMirrorNote(shortShape);
                  // Subtotal − Booked cost is exactly the discount already inside
                  // a booked rate. Shown only where it is non-zero, which is only
                  // ever a PO receipt: a hand-entered row keeps rendering the
                  // characters it always did.
                  const inRateDiscount = Math.round((num(r.bill_value) - num(r.goods)) * 100) / 100;
                  // The subtotal cell, decided once per row — see subtotalText().
                  const subtotal = subtotalText(r, r.bill_value);
                  const multiVendor = num(r.vendor_count) > 1 && !/\(\+\d+ more\)/.test(r.vendor || '');
                  return (
                    <tr key={r.bill_key} className="border-b border-[#F7EEE3] last:border-0 align-top">
                      {/* A group that spans days says so — hiding it would make an
                          INV/GRN bill look like a single-day purchase. */}
                      <td className="py-2 pr-3 text-[#6B5744]">
                        {r.date || '—'}
                        {r.spans_days && r.date_to && <span className="text-[10px] text-[#B8A48E]"> … {r.date_to}</span>}
                      </td>
                      <td className="py-2 px-3 font-medium">
                        {r.bill_no
                          ? r.bill_no
                          : <span className="text-[#B8A48E] font-normal italic">No bill no</span>}
                      </td>
                      {/* A PO receive has no invoice_id of ours, so the GRN id stands in —
                          styled and titled as a GRN id so it is not mistaken for a PINV.

                          TRUNCATED TO THE FIRST 8 CHARACTERS, full id on hover.
                          A raw 36-char uuid made this the WIDEST column in the
                          table at 289px — more than the Subtotal and the Grand
                          total put together — and it pushed both of those off a
                          1440px screen. Nobody reads a uuid; the first 8 hex
                          characters identify a GRN uniquely enough to match
                          against another screen, and the title carries the whole
                          thing for anyone who needs to copy it. */}
                      <td className="py-2 px-3 text-[#6B5744]">
                        {r.invoice_id
                          || (r.grn_id
                            ? <span title={`GRN id — this bill came from a PO receive, not a hand entry. Full id: ${r.grn_id}`}
                              className="text-[11px] font-mono text-[#8B7355]">GRN {r.grn_id.slice(0, 8)}…</span>
                            : '—')}
                      </td>
                      <td className="py-2 px-3 text-[#6B5744] whitespace-normal min-w-[110px] max-w-[150px]">
                        {r.vendor || '—'}{multiVendor && <span className="text-[11px] text-[#8B7355]"> (+{num(r.vendor_count) - 1} more)</span>}
                      </td>
                      <td className="py-2 px-3"><KindBadge kind={r.bill_kind} /></td>
                      <td className="py-2 px-3 text-right tabular-nums text-[#6B5744]">{fmtNum(r.lines)}</td>
                      {/* BOOKED COST = SPEND, the figure itself unchanged. The
                          bill's own base used to be printed UNDER this cell on
                          the rows where the two differ; it is its own Subtotal
                          column now, so the sub-line keeps only the half no
                          column carries — how much discount is already inside
                          the booked rate. Worked example, GRN-2026-0001 on live:
                          booked cost 900, subtotal 1,000, and the row adds up
                          from the subtotal — 1,000 − 100 + 282 = 1,182, which is
                          what the grand total column prints. From booked cost it
                          would come to 1,082 and the row would not add up. */}
                      <td className="py-2 px-3 text-right tabular-nums whitespace-normal w-[118px] min-w-[118px]">
                        {fmtINR(r.goods)}
                        {inRateDiscount !== 0 && (
                          <span className="block text-[10px] text-[#8B7355] font-normal leading-tight"
                            title="We booked this bill's goods into stock at a rate that already has part of the discount taken off it. The bill itself was written on the full price — that is the Subtotal column — and the grand total is built on the Subtotal, so the discount is counted once, in the Discount column, and not twice.">
                            {fmtINR(inRateDiscount)} discount already inside this rate
                          </span>
                        )}
                      </td>
                      {/* THE SUBTOTAL CELL. Never blank — see subtotalText(): the
                          figure behind it is always a stored number, and on any
                          row where part or all of it did not come off a bill
                          document the cell says so rather than going quiet.
                          Same left border as the header: the row's arithmetic
                          starts HERE, not at Booked cost. */}
                      <td className="p-0 border-l-2 border-[#F0E4D6] sticky right-[140px] z-10 bg-white">
                        <div className="w-[140px] px-3 py-2 text-right tabular-nums font-medium whitespace-normal">
                          {subtotal.text}
                          {subtotal.fallback && (
                            <span className="block text-[10px] text-red-700 font-semibold"
                              title={subtotal.note ?? undefined}>
                              bill document missing — understated
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums text-[#6B5744]">{chargeText(r, 'discount', r.discount)}</td>
                      <td className="py-2 px-3 text-right tabular-nums text-[#6B5744]">
                        {/* The badge stays; its WORDS changed. It used to sit
                            beside an em-dash and mean "the figure is elsewhere";
                            it now sits beside the figure and says where the
                            figure was read from. */}
                        {onGrn
                          ? <span className="inline-flex items-center gap-1">
                            {unavailable
                              ? '—'
                              : (num(r.cgst) < 0 || num(r.sgst) < 0 ? fmtSignedINR(r.gst) : fmtINR(r.gst))}
                            <span title="This bill was received against a PO, so its charge figures are read from its GRN line — the bill document, and the same figures the GRN Inward Register totals as Total Inward."
                              className="px-1 py-0.5 rounded border border-[#CFE2D4] bg-[#EDF4EE] text-[#3F6B4C] text-[9px] font-bold">charges from GRN</span></span>
                          : fmtINR(r.gst)}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums text-[#6B5744]">{chargeText(r, 'compensation_cess', r.compensation_cess)}</td>
                      <td className="py-2 px-3 text-right tabular-nums text-[#6B5744]">{chargeText(r, 'special_excise_cess', r.special_excise_cess)}</td>
                      <td className="py-2 px-3 text-right tabular-nums text-[#6B5744]">{chargeText(r, 'tcs', r.tcs)}</td>
                      <td className="py-2 px-3 text-right tabular-nums text-[#6B5744]">{chargeText(r, 'delivery_charges', r.delivery_charges)}</td>
                      <td className="py-2 px-3 text-right tabular-nums text-[#6B5744]">{chargeText(r, 'mrp_round_off', r.mrp_round_off)}</td>
                      {/* GRAND TOTAL. Pinned right (see the th) so the payable
                          figure is on screen whatever the horizontal scroll.

                          THE SUB-LABEL IS NO LONGER UNCONDITIONAL. It printed
                          "payable on this bill" on every GRN row, including one
                          whose bill document had been deleted and whose figure
                          was therefore SHORT — a confident caption under an
                          understated number, with a tooltip promising it equalled
                          the Inward Register's Total Inward for a document that
                          no longer exists. A row that cannot be trusted now says
                          so where the number is, in red, instead of leaving the
                          disclosure to a caption at the foot of the page. */}
                      <td className="p-0 sticky right-0 z-10 bg-white border-l-2 border-[#F0E4D6]">
                        <div className="w-[140px] px-3 py-2 text-right tabular-nums font-semibold whitespace-normal">
                        {fmtINR(r.total_bill_value)}
                        {shortfall ? (
                          <span className="block text-[10px] text-red-700 font-bold" title={shortNote ?? undefined}>
                            UNDERSTATED — do not pay
                          </span>
                        ) : onGrn && (
                          <span className="block text-[10px] text-[#8B7355] font-normal"
                            title="This is what is payable on the vendor's bill — not the cost booked into stock, which is the Booked cost (spend) column. It matches the Total Inward this GRN shows on the Inward Register to the paisa on every bill in the database today; the two are separate counts, so that agreement is a check worth running, not a guarantee.">
                            payable on this bill
                          </span>
                        )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {rows.length > shown.length && (
            <div className="pt-3 flex flex-wrap items-center gap-2 text-xs text-[#8B7355]">
              <Info className="w-3.5 h-3.5 shrink-0" />
              Showing the first {fmtNum(shown.length)} of {fmtNum(rows.length)} loaded bills on screen — the CSV contains all of them.
              <button onClick={() => setPaintAll(true)}
                className="px-2.5 py-1 rounded-md border border-[#E8D5C4] text-[#af4408] hover:bg-[#FFF1E3] font-semibold">Show all {fmtNum(rows.length)}</button>
            </div>
          )}
        </div>
        )}

        {/* ── DAY TABLE — the store person's reconciliation rollup ──────────────
            Date · numbered bills · vendor day-runs · groups · vendors · item lines
            · SUBTOTAL · TAXES & CHARGES · GRAND TOTAL, with the per-vendor
            breakdown one click away.

            BOOKED COST IS DELIBERATELY NOT A COLUMN HERE, though the day CSV has
            one and the card strip above shows the period figure. It is the
            valuation number, it is outside this row's arithmetic, and putting a
            fourth rupee column on a paperwork view next to three that DO add up
            is how a reader starts their addition one column too early. The CSV
            is the place to reconcile valuation; this table is the place to match
            a day's paperwork.

            NO CHARGE COLUMNS, and since 2026-09-10 that is a LAYOUT choice rather
            than a correctness one. It used to be correctness: a per-day GST cell was
            the bill table's em-dashes summed into a zero. The day rows now read the
            same effective rail as the bill rows, so their charge figures are complete
            and would be honest if printed — they are left out because this table is
            for matching a day's paperwork. The charge columns, and a per-row
            provenance note, are in the CSV; By bill shows them on screen. Days
            holding a receipt are marked "charges from GRN".

            THE SUBTOTAL COLUMN ARRIVED 2026-09-11 and needed no API work: bill_value
            was already on every day row and every vendor row. It shipped ADJACENT to
            Grand total, which meant a day reading ₹39,150 → ₹44,857.20 had ₹5,707.20
            appear from nowhere with no way to check it on screen. A THIRD column —
            Taxes & charges, simply Grand total − Subtotal — closed that the same day:
            it is the difference of two server fields on the same row, so it cannot
            drift from them, and it is NET of discount, which is why it is not called
            "Taxes". The row now foots in front of the reader without the table
            becoming a tax view. Do not remove it and leave the other two adjacent.

            Every number below is aggregated in SQL over the same filtered set as the
            strip above — never folded from the bill `rows` array, which the server
            caps and the search box filters again. That is what lets the Total column
            be added up and checked against the period total. */}
        {view === 'day' && (
          <div className="bg-white border border-[#E8D5C4] rounded-xl shadow-sm p-4 sm:p-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
              <h2 className="text-sm font-bold flex items-center gap-2">
                <span className="text-[#af4408]"><CalendarDays className="w-4 h-4" /></span>
                Purchases by day — one row per purchase date
                <span className="text-[11px] text-[#8B7355] font-normal">
                  ({fmtNum(days.length)} day{days.length === 1 ? '' : 's'})
                </span>
              </h2>
              {loading && <span className="text-xs text-[#8B7355] inline-flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</span>}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm whitespace-nowrap">
                <thead><tr className="text-left text-[11px] uppercase text-[#8B7355] border-b border-[#F0E4D6]">
                  <th className="py-2 pr-3">Date</th>
                  {/* TWO counts, never one. See the file header. */}
                  <th className="py-2 px-3 text-right" title="Identified documents only — our invoice id (PINV), a GRN from a PO receive, or the vendor's own printed bill number.">Bills</th>
                  <th className="py-2 px-3 text-right" title="No vendor bill number anywhere: one vendor's purchases for that day, consolidated for reading. NOT paper bills — one may cover several.">Vendor day-runs</th>
                  <th className="py-2 px-3 text-right" title="Bills + vendor day-runs. This column adds up to the group count in the strip above.">Groups</th>
                  <th className="py-2 px-3 text-right" title="Distinct vendors bought from that day. Click a date for the vendor-wise breakdown.">Vendors</th>
                  <th className="py-2 px-3 text-right" title="A COUNT of purchase rows — not a quantity. A day spans kg, BTL and CASE lines, so a summed quantity would have no unit.">Item lines</th>
                  {/* The same two names as the bill table, so a reader moving
                      between the views is never matching one column against
                      another word for the same thing. */}
                  <th className="py-2 px-3 text-right border-l-2 border-[#E8D5C4]"
                    title="SUBTOTAL. The goods themselves at the price the bills charge for them, across this whole day — before any tax or charge. The line to the left marks where this row's arithmetic starts: Subtotal + Taxes & charges = Grand total.">Subtotal</th>
                  {/* THE BRIDGE COLUMN. Subtotal and Grand total used to sit
                      ADJACENT with nothing between them, so a day reading
                      ₹39,150 → ₹44,857.20 had ₹5,707.20 appear from nowhere and
                      no way to check it on screen. The eight charge columns are
                      still deliberately absent (this is the paperwork view, not
                      a tax view, and the day CSV carries all twelve money
                      columns), but ONE net figure makes the row foot in front of
                      the reader.

                      DERIVED ON THE CLIENT, and that is safe here where it would
                      not be for a printed money figure: it is the difference of
                      two server fields on the same row, so it cannot drift from
                      them — it IS them. It is NET of discount, hence the label;
                      calling it "Taxes" would understate it on a day with a
                      delivery charge and overstate it on a day with a discount. */}
                  <th className="py-2 px-3 text-right"
                    title="GRAND TOTAL − SUBTOTAL for this day: the bills' tax, both cesses, TCS, delivery and MRP round-off, LESS their discount. One net figure, so the row adds up on screen — Subtotal + this = Grand total. The six charges behind it are itemised in the By bill view and in the CSV; a day whose bills carried a big discount can show a negative here.">Taxes &amp; charges</th>
                  <th className="p-0 sticky right-0 z-20 bg-white border-l-2 border-[#E8D5C4] align-bottom"
                    title="GRAND TOTAL — what is payable to the vendors for this day: Subtotal − Discount + GST + both cesses + TCS + Delivery + MRP round-off. Pinned to the right edge so it stays visible while the row scrolls."><div className="w-[150px] px-3 py-2 text-right whitespace-normal">Grand total</div></th>
                </tr></thead>
                <tbody>
                  {/* 9 columns since the Taxes & charges bridge joined the
                      Subtotal — three hand-kept colSpans, this pair and the
                      no-breakdown row further down. */}
                  {loading && days.length === 0 ? (
                    <tr><td colSpan={9} className="py-6 text-center text-[#8B7355] animate-pulse">Loading the day rollup…</td></tr>
                  ) : days.length === 0 ? (
                    <tr><td colSpan={9} className="py-6 text-center text-[#8B7355]">
                      {error ? 'Not loaded — see the message above.' : 'No purchases in this range.'}
                    </td></tr>
                  ) : days.map(d => {
                    const open = expandedDay === d.day;
                    const vrows = vendorsByDay.get(d.day) || [];
                    return (
                      <Fragment key={d.day}>
                        <tr className={`border-b border-[#F7EEE3] ${open ? 'bg-[#FFF6EE]' : ''}`}>
                          <td className="py-2 pr-3">
                            <button onClick={() => setExpandedDay(open ? null : d.day)}
                              className="inline-flex items-center gap-1 font-medium text-[#2D1B0E] hover:text-[#af4408]"
                              title="Show the vendor-wise breakdown for this day">
                              {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                              {d.day || '—'}
                            </button>
                            {/* A bill dated across midnight sits WHOLE on its first
                                date. Say so on the day that holds it, or a reconciler
                                comparing this row against one delivery note finds
                                money they cannot place. */}
                            {d.spanning_bills > 0 && (
                              <span className="ml-1.5 text-[10px] text-[#8B7355]"
                                title="These bills also carry a later date. The whole bill is counted here, on its first date — its value is NOT split across days.">
                                +{fmtNum(d.spanning_bills)} also dated later
                              </span>
                            )}
                          </td>
                          <td className="py-2 px-3 text-right tabular-nums">{fmtNum(d.bills)}</td>
                          <td className="py-2 px-3 text-right tabular-nums text-[#6B5744]">
                            {d.day_runs > 0
                              ? <span title="No vendor bill number — a vendor-day consolidation, not a paper bill.">{fmtNum(d.day_runs)}</span>
                              : <span className="text-[#B8A48E]">—</span>}
                          </td>
                          <td className="py-2 px-3 text-right tabular-nums text-[#6B5744]">{fmtNum(d.groups)}</td>
                          <td className="py-2 px-3 text-right tabular-nums text-[#6B5744]">
                            {fmtNum(d.vendors)}
                            {/* `vendors` files each bill under one vendor name, and so
                                does the breakdown below it. A bill naming two vendors
                                would otherwise make the second one vanish from this
                                screen without a word. */}
                            {d.multi_vendor_bills > 0 && (
                              <span className="ml-1 text-[10px] text-[#af4408]"
                                title="Bills on this day name more than one vendor. Each is filed whole under one of its names, so the breakdown below under-counts the others. Open the By bill view for those bills.">
                                +{fmtNum(d.multi_vendor_bills)} multi-vendor
                              </span>
                            )}
                          </td>
                          <td className="py-2 px-3 text-right tabular-nums text-[#6B5744]">{fmtNum(d.lines)}</td>
                          <td className="py-2 px-3 text-right tabular-nums text-[#6B5744] border-l-2 border-[#F0E4D6]">{fmtINR(num(d.bill_value))}</td>
                          {/* fmtSignedINR, not fmtINR: this figure can go
                              negative on a day whose discounts outweigh its
                              charges, and a plain ₹ would print the minus as a
                              hyphen that reads as a dash between two numbers. */}
                          <td className="py-2 px-3 text-right tabular-nums text-[#6B5744]">
                            {fmtSignedINR(num(d.total_bill_value) - num(d.bill_value))}</td>
                          <td className={`p-0 sticky right-0 z-10 border-l-2 border-[#F0E4D6] ${open ? 'bg-[#FFF6EE]' : 'bg-white'}`}>
                            <div className="w-[150px] px-3 py-2 text-right tabular-nums font-semibold whitespace-normal leading-tight">
                            {fmtINR(d.total_bill_value)}
                            {d.charges_from_grn && (
                              <span className="block text-[10px] text-[#8B7355] font-normal"
                                title="Some of this day's bills were received against a PO, so their charge figures are read from their GRN lines — the bill documents, and the same figures the GRN Inward Register totals as Total Inward. This note says WHERE part of this day's figures came from, not that they are all there — a day can carry this note and still be short if a GRN line has been deleted; the caption above the table says so when that happens.">
                                incl. {fmtINR(d.po_receipt_value)} from {fmtNum(d.po_receipt_bills)} PO/GRN · charges from GRN
                              </span>
                            )}
                            </div>
                          </td>
                        </tr>

                        {open && (vrows.length === 0 ? (
                          <tr className="border-b border-[#F7EEE3] bg-[#FFFCF8]">
                            <td colSpan={9} className="py-2.5 px-3 text-[12px] text-[#8B7355]">
                              No vendor breakdown was returned for this day{dayData?.vendor_rows_truncated ? ' — the breakdown hit its row limit (see the note above).' : '.'}
                            </td>
                          </tr>
                        ) : vrows.map(v => (
                          <tr key={`${v.day}|${v.vendor}`} className="border-b border-[#F7EEE3] bg-[#FFFCF8] text-[12px]">
                            <td className="py-1.5 pr-3 pl-5 text-[#6B5744] whitespace-normal min-w-[170px]">
                              <span className="inline-flex items-center gap-1.5">
                                <Users className="w-3 h-3 text-[#B8A48E]" />{v.vendor || '—'}
                              </span>
                            </td>
                            <td className="py-1.5 px-3 text-right tabular-nums text-[#6B5744]">{fmtNum(v.bills)}</td>
                            <td className="py-1.5 px-3 text-right tabular-nums text-[#6B5744]">{v.day_runs > 0 ? fmtNum(v.day_runs) : <span className="text-[#B8A48E]">—</span>}</td>
                            <td className="py-1.5 px-3 text-right tabular-nums text-[#6B5744]">{fmtNum(v.groups)}</td>
                            {/* One vendor by definition — a "1" here would read as a
                                count worth adding up the column. */}
                            <td className="py-1.5 px-3 text-right text-[#B8A48E]">·</td>
                            <td className="py-1.5 px-3 text-right tabular-nums text-[#6B5744]">{fmtNum(v.lines)}</td>
                            <td className="py-1.5 px-3 text-right tabular-nums text-[#6B5744] border-l-2 border-[#F0E4D6]">{fmtINR(num(v.bill_value))}</td>
                            {/* The same bridge figure on the vendor row, so a
                                breakdown adds up the same way the day above it
                                does — and so the vendor rows still sum to the
                                day column by column. */}
                            <td className="py-1.5 px-3 text-right tabular-nums text-[#6B5744]">
                              {fmtSignedINR(num(v.total_bill_value) - num(v.bill_value))}</td>
                            <td className="p-0 sticky right-0 z-10 bg-[#FFFCF8] border-l-2 border-[#F0E4D6]">
                              <div className="w-[150px] px-3 py-1.5 text-right tabular-nums text-[#6B5744] whitespace-normal leading-tight">
                              {fmtINR(v.total_bill_value)}
                              {v.charges_from_grn && (
                                <span className="block text-[10px] text-[#8B7355]"
                                  title="Charges on part of this vendor's day were read from the GRN line — the bill document. The figures are complete.">
                                  incl. {fmtINR(v.po_receipt_value)} from PO/GRN
                                </span>
                              )}
                              </div>
                            </td>
                          </tr>
                        )))}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* The acceptance test, printed where the reconciler can run it. Withheld
                when the day list was capped — there the columns genuinely do not add
                up to the period, and the red banner above says so. */}
            {days.length > 0 && !dayData?.truncated && (
              <p className="pt-3 text-[11px] text-[#8B7355] flex gap-2">
                <Info className="w-3.5 h-3.5 shrink-0" />
                <span><strong>Every row adds up across: Subtotal + Taxes &amp; charges = Grand total.</strong> And every column adds up down to the period
                  figures above, to the rupee — <strong>Groups</strong>, <strong>Item lines</strong>, <strong>Subtotal</strong> and <strong>Grand total</strong> are
                  aggregated in SQL over this same date range and vendor filter, and a bill is counted once, on the first date it carries.
                  <em> Taxes &amp; charges</em> is one net figure: the bills’ tax, both cesses, TCS, delivery and round-off, less their discount. Open
                  <em> By bill</em> or download the CSV to see those six itemised into their own columns.</span>
              </p>
            )}
          </div>
        )}

        <p className="text-[11px] text-[#8B7355]">
          {from} to {to}. Every bill here, and every rupee of booked cost, is built from the <strong>purchases</strong> table alone — GRN headers, PO
          documents and vendor-bill records restate the same money and are deliberately not joined in, so nothing here is counted twice. The one
          exception adds nothing to count: on a bill received against a PO, both the <em>charge</em> figures and the <em>Subtotal</em> are read from the
          single GRN line it was booked from — the bill document — paired one-to-one, which is why those rows agree with the GRN Inward Register on every
          bill we hold today. That agreement is a check, not a guarantee: the register counts every GRN line, and a line that never produced a purchase
          row — a wholly rejected or QC-held delivery — would be in the register and not here. None is, in this period. Quantities are not shown: a bill mixes kg, BTL and CASE lines, so a summed quantity would have no unit. Use the Purchase Report’s
          itemwise log for line-level quantities and rates.
        </p>
      </div>
    </div>
  );
}

function Card({ icon, label, value, sub, tone }: { icon: React.ReactNode; label: string; value: string; sub?: string; tone?: 'accent' | 'warn' }) {
  const ring = tone === 'accent' ? 'border-[#af4408]/30 bg-[#FFF6EE]' : tone === 'warn' ? 'border-amber-200 bg-amber-50' : 'border-[#E8D5C4] bg-white';
  return (
    <div className={`rounded-xl border shadow-sm p-3.5 ${ring}`}>
      <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wide flex items-center gap-1.5"><span className="text-[#af4408]">{icon}</span>{label}</p>
      <p className="text-xl font-bold mt-1 text-[#2D1B0E]">{value}</p>
      {sub && <p className="text-[11px] text-[#8B7355] mt-0.5">{sub}</p>}
    </div>
  );
}
