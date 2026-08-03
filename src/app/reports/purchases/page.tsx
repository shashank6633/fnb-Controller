'use client';

/**
 * Purchase Report (/reports/purchases) — management-only. Two views:
 *
 *  1. Summary — purchase SPEND over a date range, broken down by month, vendor,
 *     category, super-category, payment mode, and top items. Reads
 *     GET /api/reports/purchases (isManagement-gated); CSV built client-side.
 *     Reconciles with the Purchases page (same data set).
 *
 *  2. Purchase log (itemwise) — one row per ITEM per BILL from all three
 *     document sources (purchases / PO bills / GRN bills) in ONE downloadable
 *     file. Reads GET /api/reports/purchase-log.
 *
 * WHY THE LOG SHOWS THREE SEPARATE TOTALS AND NEVER A GRAND TOTAL:
 * receiving a purchase order writes BOTH a GRN and `purchases` rows — the same
 * physical goods recorded twice, for two different purposes. Adding the three
 * source values together would roughly double the real spend, so this page
 * prints them side by side, each labelled, with an explicit warning, and never
 * sums them. `link_key` on each row ties a GRN line to the purchase row it
 * created so the overlap is visible instead of silently resolved.
 *
 * UNITS: quantities and rates on all three sources are already in PURCHASE
 * units (₹ per purchase unit) — no pack-factor conversion here, ever.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { todayIST } from '@/lib/format-date';
import MaterialTypeahead, { type MaterialLite } from '@/components/MaterialTypeahead';
import {
  ShoppingCart, TrendingUp, Building2, Package, AlertTriangle, Download, CalendarDays,
  ScrollText, Info, Loader2, BarChart3,
} from 'lucide-react';

interface Row { spend: number; count: number; [k: string]: any }
interface Report {
  from: string; to: string; vendor: string; category: string;
  summary: { purchase_count: number; total_spend: number; vendor_count: number; item_count: number; day_count: number; emergency_spend: number; emergency_count: number };
  by_vendor: Row[]; by_category: Row[]; by_super_category: Row[]; by_month: Row[]; by_payment_mode: Row[];
  by_item: { material_name: string; category: string; unit: string; qty: number; spend: number; count: number; avg_rate: number; last_date: string }[];
  vendors: string[]; categories: string[];
}

/** One row per ITEM per BILL, from whichever document source recorded it. */
type LogSource = 'PURCHASE' | 'PO' | 'GRN';
interface LogRow {
  source: LogSource;
  date: string; doc_no: string;
  invoice_id: string;            // OURS   — PINV-yyyy-####, one per vendor bill
  bill_no: string;               // VENDOR — the number printed on their bill
  vendor: string;
  material: string; sku: string; category: string;
  qty: number; purchase_unit: string; rate: number; value: number;
  qty_rejected: number | null;   // GRN lines only
  discount: number; cgst: number; sgst: number;
  // compensation_cess is GST Compensation Cess (aerated drinks, tobacco) — a SEPARATE
  // levy from special_excise_cess, which means TGBCL Special Excise Cess everywhere it
  // is read or labelled. Never fold it into cgst/sgst: it is not halved and it must not
  // join the tax_value === cgst + sgst invariant.
  compensation_cess: number;
  special_excise_cess: number; tcs: number; delivery_charges: number; mrp_round_off: number;
  link_key: string;              // ties a GRN line to the purchases row it created
  notes: string;
}
interface LogResponse {
  rows: LogRow[];
  totals: { lines: number; purchase_value: number; po_value: number; grn_value: number };
  truncated: boolean; from: string; to: string;
}

const fmtINR = (n: number) => '₹' + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-IN');
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

/** Client-side CSV download with a formula-injection guard. */
function downloadCsv(filename: string, header: string[], rows: (string | number)[][]) {
  const esc = (v: any) => {
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

export default function PurchaseReportPage() {
  const today = todayIST();
  const [from, setFrom] = useState(firstOfMonth(today));
  const [to, setTo] = useState(today);
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
      const qs = new URLSearchParams({ from, to });
      if (vendor) qs.set('vendor', vendor);
      if (category) qs.set('category', category);
      const res = await fetch(`/api/reports/purchases?${qs.toString()}`);
      if (res.status === 403) { setError('Management only — you don’t have access to purchase reports.'); setData(null); return; }
      if (!res.ok) { setError((await res.json().catch(() => ({}))).error || 'Failed to load report'); setData(null); return; }
      setData(await res.json());
    } catch { setError('Network error — please try again.'); }
    finally { setLoading(false); }
  }, [from, to, vendor, category]);

  useEffect(() => { load(); }, [load]);

  const preset = (f: string, t: string) => { setFrom(f); setTo(t); };
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

        {view === 'log' && <PurchaseLog from={from} to={to} setFrom={setFrom} setTo={setTo} vendors={data?.vendors || []} />}

        {view === 'summary' && (<>
        {/* Filters */}
        <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm p-4 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="block"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">From</span>
              <input type="date" value={from} onChange={e => e.target.value && setFrom(e.target.value)} className="mt-1 block px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408]" /></label>
            <label className="block"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">To</span>
              <input type="date" value={to} onChange={e => e.target.value && setTo(e.target.value)} className="mt-1 block px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408]" /></label>
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
            {[
              ['This month', firstOfMonth(today), today],
              ['Last month', firstOfMonth(addMonths(today, -1)), firstOfMonth(today).slice(0, 8) + '01' === firstOfMonth(today) ? addMonths(firstOfMonth(today), 0).slice(0, 10) : today],
              ['Last 3 months', addMonths(firstOfMonth(today), -2), today],
              ['This FY', fyStart(today), today],
            ].map(([label, f, t]) => (
              <button key={label} onClick={() => preset(f as string, t as string)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium border bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]">{label}</button>
            ))}
            {/* Last-month end fix: from first-of-last-month to last day of last month */}
            <button onClick={() => { const fom = firstOfMonth(today); setFrom(addMonths(fom, -1)); setTo(addMonths(fom, 0)); setTimeout(() => setTo(new Date(new Date(fom + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10)), 0); }}
              className="hidden" aria-hidden />
          </div>
        </div>

        {error && <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">{error}</div>}
        {loading && !data && <div className="text-sm text-[#8B7355] py-8 text-center animate-pulse">Loading purchase report…</div>}

        {data && s && (
          <>
            {/* Summary cards */}
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
              <Card icon={<TrendingUp className="w-4 h-4" />} label="Total Spend" value={fmtINR(s.total_spend)} tone="accent" />
              <Card icon={<ShoppingCart className="w-4 h-4" />} label="Purchases" value={fmtNum(s.purchase_count)} sub={`${fmtNum(s.day_count)} days`} />
              <Card icon={<Building2 className="w-4 h-4" />} label="Vendors" value={fmtNum(s.vendor_count)} />
              <Card icon={<Package className="w-4 h-4" />} label="Items" value={fmtNum(s.item_count)} />
              <Card icon={<AlertTriangle className="w-4 h-4" />} label="Emergency Spend" value={fmtINR(s.emergency_spend)} sub={`${fmtNum(s.emergency_count)} purchases`} tone={s.emergency_spend > 0 ? 'warn' : undefined} />
            </div>

            {s.total_spend === 0 ? (
              <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center text-sm text-[#8B7355]">
                No purchases in this range. Try a wider date range or clear the filters.
              </div>
            ) : (
              <>
                <div className="grid lg:grid-cols-2 gap-4">
                  <BarTable title="Spend by Month" icon={<CalendarDays className="w-4 h-4" />} keyName="month" rows={data.by_month} total={s.total_spend}
                    onExport={() => downloadCsv(`purchases-by-month_${from}_${to}.csv`, ['Month', 'Spend', 'Purchases'], data.by_month.map(r => [r.month, r.spend, r.count]))} />
                  <BarTable title="Spend by Vendor" icon={<Building2 className="w-4 h-4" />} keyName="vendor" rows={data.by_vendor} total={s.total_spend} limit={12}
                    onExport={() => downloadCsv(`purchases-by-vendor_${from}_${to}.csv`, ['Vendor', 'Spend', 'Purchases'], data.by_vendor.map(r => [r.vendor, r.spend, r.count]))} />
                  <BarTable title="Spend by Category" icon={<Package className="w-4 h-4" />} keyName="category" rows={data.by_category} total={s.total_spend} limit={12}
                    onExport={() => downloadCsv(`purchases-by-category_${from}_${to}.csv`, ['Category', 'Spend', 'Purchases'], data.by_category.map(r => [r.category, r.spend, r.count]))} />
                  <BarTable title="Spend by Super-category" icon={<Package className="w-4 h-4" />} keyName="super_category" rows={data.by_super_category} total={s.total_spend}
                    onExport={() => downloadCsv(`purchases-by-supercategory_${from}_${to}.csv`, ['Super-category', 'Spend', 'Purchases'], data.by_super_category.map(r => [r.super_category, r.spend, r.count]))} />
                </div>

                {data.by_payment_mode.length > 0 && (
                  <BarTable title="Spend by Payment Mode" icon={<TrendingUp className="w-4 h-4" />} keyName="payment_mode" rows={data.by_payment_mode} total={s.total_spend}
                    onExport={() => downloadCsv(`purchases-by-payment_${from}_${to}.csv`, ['Payment Mode', 'Spend', 'Purchases'], data.by_payment_mode.map(r => [r.payment_mode, r.spend, r.count]))} />
                )}

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
                      <button onClick={() => downloadCsv(`purchase-report-itemwise_${from}_${to}.csv`,
                        ['Item', 'Category', 'Unit', 'Total Qty', 'Purchases', 'Avg Rate (₹/unit)', 'Total Spend (₹)', 'Last Purchased'],
                        items.map(r => [r.material_name, r.category, r.unit, r.qty, r.count, Math.round(r.avg_rate * 100) / 100, Math.round(r.spend * 100) / 100, r.last_date]))}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#af4408] hover:bg-[#8a3506] text-white shrink-0"><Download className="w-3.5 h-3.5" /> CSV</button>
                    </div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead><tr className="text-left text-[11px] uppercase text-[#8B7355] border-b border-[#F0E4D6]">
                        <th className="py-2 pr-3">Item</th><th className="py-2 px-3">Category</th>
                        <th className="py-2 px-3 text-right">Total Qty</th><th className="py-2 px-3 text-right">Purchases</th>
                        <th className="py-2 px-3 text-right">Avg Rate</th><th className="py-2 px-3">Last</th><th className="py-2 pl-3 text-right">Spend</th>
                      </tr></thead>
                      <tbody>
                        {items.length === 0 ? (
                          <tr><td colSpan={7} className="py-6 text-center text-[#8B7355]">No items match.</td></tr>
                        ) : items.map((r, i) => (
                          <tr key={i} className="border-b border-[#F7EEE3] last:border-0">
                            <td className="py-2 pr-3 font-medium">{r.material_name}</td>
                            <td className="py-2 px-3 text-[#8B7355]">{r.category}</td>
                            <td className="py-2 px-3 text-right">{fmtNum(r.qty)} {r.unit}</td>
                            <td className="py-2 px-3 text-right">{fmtNum(r.count)}</td>
                            <td className="py-2 px-3 text-right">{fmtINR(r.avg_rate)}</td>
                            <td className="py-2 px-3 text-[#8B7355] whitespace-nowrap">{r.last_date}</td>
                            <td className="py-2 pl-3 text-right font-semibold">{fmtINR(r.spend)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
            <p className="text-[11px] text-[#8B7355]">Spend = invoice total of purchase entries in the range. Matches the Purchases page. {data.vendor && `Vendor: ${data.vendor}. `}{data.category && `Category: ${data.category}.`}</p>
          </>
        )}
        </>)}
      </div>
    </div>
  );
}

/* ────────────────────────── Purchase log (itemwise) ──────────────────────────
 * A LOG, not an aggregate: one row per item per bill, with Purchases, PO bills
 * and GRN bills interleaved and each row stamped with the source it came from.
 * The date range is shared with the Summary view so switching tabs keeps the
 * same window; every other filter is local to this section.
 */

const SOURCE_OPTIONS = [
  { k: 'all', label: 'All sources' },
  { k: 'purchase', label: 'Purchases' },
  { k: 'po', label: 'PO bills' },
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

function PurchaseLog({ from, to, setFrom, setTo, vendors }: {
  from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void; vendors: string[];
}) {
  const today = todayIST();
  const [vendor, setVendor] = useState('');
  const [vendorQ, setVendorQ] = useState('');   // debounced copy — see below
  const [materialId, setMaterialId] = useState('');
  const [source, setSource] = useState<SourceFilter>('all');
  const [materials, setMaterials] = useState<MaterialLite[]>([]);
  const [data, setData] = useState<LogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [showCharges, setShowCharges] = useState(false);
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
  const CHARGE_COLS: { k: keyof LogRow; label: string }[] = [
    { k: 'discount', label: 'Discount' }, { k: 'cgst', label: 'CGST' }, { k: 'sgst', label: 'SGST' },
    { k: 'special_excise_cess', label: 'Excise/Cess' }, { k: 'compensation_cess', label: 'Comp. Cess' },
    { k: 'tcs', label: 'TCS' },
    { k: 'delivery_charges', label: 'Delivery' }, { k: 'mrp_round_off', label: 'MRP Round-off' },
  ];
  const colCount = 13 + (showCharges ? CHARGE_COLS.length : 0);

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
          owner reads roughly twice the real spend. */}
      {t && (
        <div className="space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Card icon={<ShoppingCart className="w-4 h-4" />} label="Purchases value" value={fmtINR(t.purchase_value)} sub="source = PURCHASE" tone="accent" />
            <Card icon={<Package className="w-4 h-4" />} label="PO bills value" value={fmtINR(t.po_value)} sub="source = PO" />
            <Card icon={<Building2 className="w-4 h-4" />} label="GRN bills value" value={fmtINR(t.grn_value)} sub="source = GRN" />
          </div>
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-900 flex gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <p>
              <strong>Do not add these three totals together.</strong> Receiving a purchase order records
              <em> both</em> a GRN <em>and</em> purchase entries for the same goods, so the same physical purchase
              appears under two sources. Each total is what that document type says on its own — the sum would
              roughly double your real spend. Use the <strong>Link key</strong> column to see which GRN line and
              purchase row are the same delivery.
            </p>
          </div>
          <p className="text-[11px] text-[#8B7355]">
            {fmtNum(t.lines)} line{t.lines === 1 ? '' : 's'} · {from} to {to}. Quantities and rates are in PURCHASE units.
            GRN rates are gross (as the vendor bill reads); purchase rates are net of the allocated discount, so the same
            delivery can legitimately show two rates. The {CHARGE_COLS.length} per-line charges are recorded only — they
            are NOT folded into Value.
          </p>
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
              <th className="py-2 pr-3">Source</th>
              <th className="py-2 px-3">Date</th>
              <th className="py-2 px-3">Doc No</th>
              <th className="py-2 px-3">Invoice ID (ours)</th>
              <th className="py-2 px-3">Bill No (vendor)</th>
              <th className="py-2 px-3">Vendor</th>
              <th className="py-2 px-3">Item</th>
              <th className="py-2 px-3">Category</th>
              <th className="py-2 px-3 text-right">Qty</th>
              <th className="py-2 px-3 text-right">Rate</th>
              <th className="py-2 px-3 text-right">Value</th>
              <th className="py-2 px-3 text-right">Rejected</th>
              {showCharges && CHARGE_COLS.map(c => <th key={String(c.k)} className="py-2 px-3 text-right">{c.label}</th>)}
              <th className="py-2 pl-3">Link key</th>
            </tr></thead>
            <tbody>
              {loading && rows.length === 0 ? (
                <tr><td colSpan={colCount} className="py-6 text-center text-[#8B7355] animate-pulse">Loading purchase log…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={colCount} className="py-6 text-center text-[#8B7355]">{error ? 'Not loaded — see the message above.' : 'No purchase, PO or GRN lines in this range.'}</td></tr>
              ) : shown.map((r, i) => (
                <tr key={`${r.source}-${r.doc_no}-${r.link_key}-${i}`} className="border-b border-[#F7EEE3] last:border-0 align-top">
                  <td className="py-2 pr-3"><SourceBadge source={r.source} /></td>
                  <td className="py-2 px-3 text-[#6B5744]">{r.date || '—'}</td>
                  <td className="py-2 px-3 font-medium">{r.doc_no || '—'}</td>
                  <td className="py-2 px-3 text-[#6B5744]">{r.invoice_id || '—'}</td>
                  <td className="py-2 px-3 text-[#6B5744]">{r.bill_no || '—'}</td>
                  <td className="py-2 px-3 text-[#6B5744]">{r.vendor || '—'}</td>
                  <td className="py-2 px-3 font-medium whitespace-normal min-w-[180px]">{r.material || '—'}
                    {r.sku && <span className="block text-[10px] text-[#8B7355] font-normal">{r.sku}</span>}</td>
                  <td className="py-2 px-3 text-[#8B7355]">{r.category || '—'}</td>
                  <td className="py-2 px-3 text-right tabular-nums">{fmtQty(r.qty)} <span className="text-[11px] text-[#8B7355]">{r.purchase_unit || ''}</span></td>
                  <td className="py-2 px-3 text-right tabular-nums">{fmtINR(r.rate)}</td>
                  <td className="py-2 px-3 text-right tabular-nums font-semibold">{fmtINR(r.value)}</td>
                  <td className="py-2 px-3 text-right tabular-nums">{r.qty_rejected == null ? '—' : <span className={Number(r.qty_rejected) > 0 ? 'text-amber-700 font-semibold' : ''}>{fmtQty(r.qty_rejected)} {r.purchase_unit || ''}</span>}</td>
                  {showCharges && CHARGE_COLS.map(c => <td key={String(c.k)} className="py-2 px-3 text-right tabular-nums text-[#6B5744]">{fmtINR(Number(r[c.k]) || 0)}</td>)}
                  <td className="py-2 pl-3 text-[11px] text-[#8B7355] font-mono">{r.link_key || '—'}
                    {r.notes && <span className="block text-[10px] text-[#B8A48E] font-sans whitespace-normal max-w-[220px]">{r.notes}</span>}</td>
                </tr>
              ))}
            </tbody>
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

function BarTable({ title, icon, keyName, rows, total, limit, onExport }: {
  title: string; icon: React.ReactNode; keyName: string; rows: Row[]; total: number; limit?: number; onExport: () => void;
}) {
  const shown = limit ? rows.slice(0, limit) : rows;
  const max = Math.max(1, ...rows.map(r => r.spend));
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl shadow-sm p-4 sm:p-5">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h2 className="text-sm font-bold flex items-center gap-2"><span className="text-[#af4408]">{icon}</span>{title}</h2>
        <button onClick={onExport} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-[#E8D5C4] text-[#6B5744] hover:bg-[#FFF1E3] text-xs"><Download className="w-3 h-3" /> CSV</button>
      </div>
      {shown.length === 0 ? <p className="text-sm text-[#B8A48E] py-4 text-center">No data.</p> : (
        <div className="space-y-2">
          {shown.map((r, i) => (
            <div key={i}>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="truncate font-medium">{r[keyName]}</span>
                <span className="shrink-0 tabular-nums">{fmtINR(r.spend)} <span className="text-[11px] text-[#8B7355]">({total > 0 ? Math.round((r.spend / total) * 100) : 0}% · {fmtNum(r.count)})</span></span>
              </div>
              <div className="h-2 bg-[#FAF3EA] rounded-full overflow-hidden mt-0.5"><div className="h-full bg-[#af4408] rounded-full" style={{ width: `${Math.max(2, Math.round((r.spend / max) * 100))}%` }} /></div>
            </div>
          ))}
          {limit && rows.length > limit && <p className="text-[11px] text-[#8B7355] pt-1">+{rows.length - limit} more — export CSV for the full list.</p>}
        </div>
      )}
    </div>
  );
}
