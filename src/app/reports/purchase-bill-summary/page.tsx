'use client';

/**
 * Purchase Bill Summary (/reports/purchase-bill-summary) — management-only.
 * ONE ROW PER VENDOR BILL: Bill No, Vendor, Date, goods, every charge, and the
 * Total Bill Value. Reads GET /api/reports/purchase-bill-summary, which enforces
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
 * WHY THIS PAGE MAY PRINT ONE GRAND TOTAL, unlike /reports/purchases → Purchase log:
 * the API reads the `purchases` table ALONE. goods_receipt_note_items,
 * goods_receipt_notes, po_vendor_bills and purchase_order_items restate the SAME
 * money (see the header of src/lib/purchase-log.ts), so the log must print three
 * per-source totals that must never be added. Here there is one source, so every
 * rupee is counted exactly once BY CONSTRUCTION and a grand total is safe.
 *
 * THE HONESTY PROBLEM THAT REMAINS: a PO-receive `purchases` row is a deliberately
 * TAX-FREE COST MIRROR — the discount is already inside the net unit_price and the
 * tax lives on the GRN line, because tax on the cost row would poison average_price
 * and destroy the input credit. Printing "GST ₹0" on those bills would assert that
 * no tax was charged. So rows flagged tax_on_grn render an EM-DASH, never ₹0, in
 * Discount / GST / both cess columns, carry a "tax on GRN" badge, and their total is
 * labelled BOOKED COST — goods plus allocated delivery, NOT the vendor's bill face
 * value. Do not "fix" this by joining the GRN table back in: that is exactly the
 * double-count the purchase-log header exists to prevent.
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
 * against. Numbered bills and vendor day-runs are separate columns. And the day table
 * shows NO charge columns at all: on a day mixing PO/GRN receipts with hand-entered
 * bills the tax is partial (it lives on the GRN), so a clean per-day GST cell would be
 * the em-dash summed into a zero. The CSV carries the charges with a per-row note.
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { todayIST } from '@/lib/format-date';
import {
  ReceiptText, Building2, Download, Loader2, Info, AlertTriangle,
  ShoppingCart, TrendingUp, Layers, CalendarDays, ChevronRight, ChevronDown, Users,
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
  tax_on_grn: boolean;
  lines: number;                 // COUNT(*) of purchases rows — no quantities, ever
  goods: number;                 // SUM(total_price) AS STORED
  discount: number;
  cgst: number;
  sgst: number;
  gst: number;                   // cgst + sgst; NEITHER cess is in here
  compensation_cess: number;     // GST Compensation Cess (aerated drinks, tobacco)
  special_excise_cess: number;   // TGBCL Special Excise Cess — a different levy again
  tcs: number;
  delivery_charges: number;
  mrp_round_off: number;
  total_bill_value: number;
}

interface BillTotals {
  bills: number;                 // BEFORE truncation — SQL over the full filtered set
  lines: number;
  goods: number;
  discount: number;
  gst: number;
  compensation_cess: number;
  special_excise_cess: number;
  tcs: number;
  delivery_charges: number;
  mrp_round_off: number;
  total_bill_value: number;
  po_receipt_bills: number;
  po_receipt_lines: number;
  po_receipt_value: number;
  /** How many of `bills` carry no vendor bill number — SQL over the FULL period,
   *  so the day view can state an exact figure instead of counting loaded rows. */
  day_run_bills: number;
  /** Rendered VERBATIM beside the grand total — it is the guard on misreading it. */
  basis: string;
}

interface BillResponse {
  view?: 'bill';
  rows: BillRow[];
  totals: BillTotals;
  truncated: boolean;
  from: string;
  to: string;
}

/* ── DAY VIEW ───────────────────────────────────────────────────────────────
 * Mirrors PurchaseBillDayRow / PurchaseBillDayVendorRow in the lib. Same
 * re-declaration rule as above: the compiler cannot catch drift here.
 *
 * The API also sends discount / cgst / sgst / gst / both cesses / tcs / delivery
 * / mrp_round_off on every day row. They are DELIBERATELY not mirrored here and
 * deliberately not rendered: on a day holding a PO/GRN receipt those figures are
 * PARTIAL — the receipt's tax lives on the GRN — so a clean per-day GST cell
 * would be exactly the em-dash-summed-into-a-zero this report exists to avoid.
 * The CSV carries them, with a per-row Charges Note attached. Do not add them to
 * this table without reading §7 of src/lib/purchase-bill-summary.ts first. */

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
  goods: number;
  total_bill_value: number;
  po_receipt_bills: number;
  po_receipt_lines: number;
  /** BOOKED COST share of total_bill_value — not vendor bill face value. */
  po_receipt_value: number;
  /** true ⇒ this day's charge figures are PARTIAL. See the file header. */
  charges_partial: boolean;
}

interface DayVendorRow {
  day: string;
  vendor: string;
  groups: number;
  bills: number;
  day_runs: number;
  lines: number;
  goods: number;
  total_bill_value: number;
  po_receipt_bills: number;
  po_receipt_value: number;
  charges_partial: boolean;
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
}

const fmtINR = (n: number) => '₹' + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-IN');
const fmtNum = (n: number) => (Number(n) || 0).toLocaleString('en-IN');
const num = (v: unknown) => Number(v) || 0;

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
  const [from, setFrom] = useState(firstOfMonth(today));
  const [to, setTo] = useState(today);
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
  const qs = useCallback((format: 'json' | 'csv') => {
    const p = new URLSearchParams({ from, to, format });
    if (view === 'day') p.set('view', 'day');
    if (vendorQ) p.set('vendor', vendorQ);
    if (splitUnnumbered) p.set('unnumbered', 'split');
    if (!includePoReceipts) p.set('include_po_receipts', '0');
    return p.toString();
  }, [view, from, to, vendorQ, splitUnnumbered, includePoReceipts]);

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
            <label className="block"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">From</span>
              <input type="date" value={from} onChange={e => e.target.value && setFrom(e.target.value)}
                className="mt-1 block px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408]" /></label>
            <label className="block"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">To</span>
              <input type="date" value={to} onChange={e => e.target.value && setTo(e.target.value)}
                className="mt-1 block px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408]" /></label>
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
            <button onClick={download} disabled={downloading}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-60 text-white">
              {downloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />} Download CSV
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {([
              ['This month', firstOfMonth(today), today],
              ['Last 3 months', addMonths(firstOfMonth(today), -2), today],
              ['This FY', fyStart(today), today],
            ] as const).map(([label, f, tt]) => (
              <button key={label} onClick={() => { setFrom(f); setTo(tt); }}
                className="px-3 py-1.5 rounded-lg text-xs font-medium border bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]">{label}</button>
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

        {/* Period totals. Safe to print as ONE grand total precisely because the API
            reads a single table — see the file header. */}
        {t && (
          <div className="space-y-2">
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
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
              <Card icon={<ShoppingCart className="w-4 h-4" />} label="Goods" value={fmtINR(t.goods)} sub="before charges" />
              <Card icon={<TrendingUp className="w-4 h-4" />} label="Total Bill Value" value={fmtINR(t.total_bill_value)} tone="accent" />
              <Card icon={<Building2 className="w-4 h-4" />} label="Of which PO/GRN receipts"
                value={fmtINR(num(t.po_receipt_value))}
                sub={`${fmtNum(num(t.po_receipt_bills))} bill${num(t.po_receipt_bills) === 1 ? '' : 's'} · ${fmtNum(num(t.po_receipt_lines))} lines · tax sits on the GRN`} />
            </div>
            {/* `basis` is the API's own guard against misreading the grand total.
                Print it verbatim — do not paraphrase it into something shorter. */}
            {t.basis && <p className="text-[11px] text-[#8B7355] leading-relaxed">{t.basis}</p>}
          </div>
        )}

        {/* The caveats, on screen and not buried in a header comment. Everything a
            reader needs to not misread this table is in this one panel. */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl px-4 py-3 text-[12px] text-[#6B5744] space-y-1.5">
          <p className="flex gap-2"><Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-[#af4408]" />
            <span><strong>Total Bill Value = Goods − Discount + GST + Comp. Cess + Spl Excise Cess + TCS + Delivery + MRP Round-off.</strong>{' '}
              Goods is the stored line value. GST is CGST + SGST only — both cesses are separate levies and are never folded into it.</span></p>
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
                ? <span><strong>{fmtNum(num(t.po_receipt_bills))}</strong> group{num(t.po_receipt_bills) === 1 ? '' : 's'} in this period came from a PO receive / GRN, carrying <strong>{fmtINR(num(t.po_receipt_value))}</strong> of
                  the total. Their discount and tax are recorded on the GRN, not on these cost rows, so that share is <strong>booked cost</strong> (goods +
                  allocated delivery), not vendor bill face value — and it is why this table shows <strong>no charge columns at all</strong>: a clean per-day
                  GST cell would be those “—” cells summed into a zero. The CSV carries the charges with a per-row note. Days holding one are
                  marked <em>partial charges</em> below.</span>
                : <span><strong>{fmtNum(grnRowCount)}</strong> loaded bill{grnRowCount === 1 ? '' : 's'} came from a PO receive / GRN. Their discount and tax are recorded on the
                  GRN, not on this cost row, so those cells read “—” rather than ₹0 — the bill <em>was</em> taxed. For those rows the total is the
                  <strong> booked cost</strong> (goods + allocated delivery), not the vendor’s bill face value.</span>}
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

        {/* Bill table. The row reconciles left to right: Goods − Discount + charges = Total.
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
                <th className="py-2 px-3 text-right">Goods</th>
                <th className="py-2 px-3 text-right">Discount</th>
                <th className="py-2 px-3 text-right">GST</th>
                <th className="py-2 px-3 text-right">Comp. Cess</th>
                <th className="py-2 px-3 text-right">Spl Excise Cess</th>
                <th className="py-2 px-3 text-right">TCS</th>
                <th className="py-2 px-3 text-right">Delivery</th>
                <th className="py-2 px-3 text-right">MRP Round-off</th>
                <th className="py-2 pl-3 text-right">Total Bill Value</th>
              </tr></thead>
              <tbody>
                {loading && rows.length === 0 ? (
                  <tr><td colSpan={15} className="py-6 text-center text-[#8B7355] animate-pulse">Loading bill summary…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={15} className="py-6 text-center text-[#8B7355]">
                    {error ? 'Not loaded — see the message above.'
                      : filtered ? 'No bills match that search.'
                        : 'No purchase bills in this range.'}
                  </td></tr>
                ) : shown.map(r => {
                  // tax_on_grn rows: an em-dash, never ₹0. ₹0 would assert "no tax was
                  // charged" on a bill that WAS taxed — the tax is on the GRN line.
                  const onGrn = !!r.tax_on_grn;
                  const dash = <span className="text-[#B8A48E]">—</span>;
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
                          styled and titled as a GRN id so it is not mistaken for a PINV. */}
                      <td className="py-2 px-3 text-[#6B5744]">
                        {r.invoice_id
                          || (r.grn_id
                            ? <span title="GRN id — this bill came from a PO receive, not a hand entry"
                              className="text-[11px] font-mono text-[#8B7355]">GRN {r.grn_id}</span>
                            : '—')}
                      </td>
                      <td className="py-2 px-3 text-[#6B5744] whitespace-normal min-w-[150px]">
                        {r.vendor || '—'}{multiVendor && <span className="text-[11px] text-[#8B7355]"> (+{num(r.vendor_count) - 1} more)</span>}
                      </td>
                      <td className="py-2 px-3"><KindBadge kind={r.bill_kind} /></td>
                      <td className="py-2 px-3 text-right tabular-nums text-[#6B5744]">{fmtNum(r.lines)}</td>
                      <td className="py-2 px-3 text-right tabular-nums">{fmtINR(r.goods)}</td>
                      <td className="py-2 px-3 text-right tabular-nums text-[#6B5744]">{onGrn ? dash : fmtINR(r.discount)}</td>
                      <td className="py-2 px-3 text-right tabular-nums text-[#6B5744]">
                        {onGrn
                          ? <span className="inline-flex items-center gap-1">{dash}
                            <span className="px-1 py-0.5 rounded border border-[#CFE2D4] bg-[#EDF4EE] text-[#3F6B4C] text-[9px] font-bold">tax on GRN</span></span>
                          : fmtINR(r.gst)}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums text-[#6B5744]">{onGrn ? dash : fmtINR(r.compensation_cess)}</td>
                      <td className="py-2 px-3 text-right tabular-nums text-[#6B5744]">{onGrn ? dash : fmtINR(r.special_excise_cess)}</td>
                      <td className="py-2 px-3 text-right tabular-nums text-[#6B5744]">{fmtINR(r.tcs)}</td>
                      <td className="py-2 px-3 text-right tabular-nums text-[#6B5744]">{fmtINR(r.delivery_charges)}</td>
                      <td className="py-2 px-3 text-right tabular-nums text-[#6B5744]">{fmtINR(r.mrp_round_off)}</td>
                      <td className="py-2 pl-3 text-right tabular-nums font-semibold">
                        {fmtINR(r.total_bill_value)}
                        {onGrn && <span className="block text-[10px] text-[#8B7355] font-normal">booked cost</span>}
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
            · total purchase value, with the per-vendor breakdown one click away.

            NO CHARGE COLUMNS, deliberately. On a day mixing PO/GRN receipts with
            hand-entered bills the tax is partial — the receipts' tax is on the GRN —
            so a clean per-day GST cell would be exactly the em-dashes of the bill
            table summed into a zero. Such days are marked "partial charges" and the
            CSV carries the figures with a per-row note.

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
                  <th className="py-2 pl-3 text-right">Total purchase value</th>
                </tr></thead>
                <tbody>
                  {loading && days.length === 0 ? (
                    <tr><td colSpan={7} className="py-6 text-center text-[#8B7355] animate-pulse">Loading the day rollup…</td></tr>
                  ) : days.length === 0 ? (
                    <tr><td colSpan={7} className="py-6 text-center text-[#8B7355]">
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
                          <td className="py-2 pl-3 text-right tabular-nums font-semibold">
                            {fmtINR(d.total_bill_value)}
                            {d.charges_partial && (
                              <span className="block text-[10px] text-[#8B7355] font-normal"
                                title="Their tax and gross discount are recorded on the GRN, not on these cost rows, so this day's charge figures are partial and that share of the value is booked cost.">
                                incl. {fmtINR(d.po_receipt_value)} booked cost · {fmtNum(d.po_receipt_bills)} PO/GRN · partial charges
                              </span>
                            )}
                          </td>
                        </tr>

                        {open && (vrows.length === 0 ? (
                          <tr className="border-b border-[#F7EEE3] bg-[#FFFCF8]">
                            <td colSpan={7} className="py-2.5 px-3 text-[12px] text-[#8B7355]">
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
                            <td className="py-1.5 pl-3 text-right tabular-nums text-[#6B5744]">
                              {fmtINR(v.total_bill_value)}
                              {v.charges_partial && (
                                <span className="block text-[10px] text-[#8B7355]">
                                  incl. {fmtINR(v.po_receipt_value)} booked cost
                                </span>
                              )}
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
                <span>Add the columns up and they equal the period figures above, to the rupee: <strong>Groups</strong>, <strong>Item lines</strong> and
                  <strong> Total purchase value</strong> are aggregated in SQL over this same date range and vendor filter. A bill is counted once, on the
                  first date it carries.</span>
              </p>
            )}
          </div>
        )}

        <p className="text-[11px] text-[#8B7355]">
          {from} to {to}. Built from the <strong>purchases</strong> table alone — GRN and PO documents restate the same money and are
          deliberately not joined in, so nothing here is counted twice. Quantities are not shown: a bill mixes kg, BTL and CASE lines,
          so a summed quantity would have no unit. Use the Purchase Report’s itemwise log for line-level quantities and rates.
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
