'use client';

/**
 * Purchase Report (/reports/purchases) — management-only.
 *
 * Purchase SPEND over a date range, broken down by month, vendor, category,
 * super-category, payment mode, and top items. Reads GET /api/reports/purchases
 * (isManagement-gated); CSV export is built client-side from the aggregates.
 * Reconciles with the Purchases page (same data set).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { todayIST } from '@/lib/format-date';
import { ShoppingCart, TrendingUp, Building2, Package, AlertTriangle, Download, CalendarDays } from 'lucide-react';

interface Row { spend: number; count: number; [k: string]: any }
interface Report {
  from: string; to: string; vendor: string; category: string;
  summary: { purchase_count: number; total_spend: number; vendor_count: number; item_count: number; day_count: number; emergency_spend: number; emergency_count: number };
  by_vendor: Row[]; by_category: Row[]; by_super_category: Row[]; by_month: Row[]; by_payment_mode: Row[];
  by_item: { material_name: string; category: string; unit: string; qty: number; spend: number; count: number; avg_rate: number; last_date: string }[];
  vendors: string[]; categories: string[];
}

const fmtINR = (n: number) => '₹' + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-IN');
const fmtNum = (n: number) => (Number(n) || 0).toLocaleString('en-IN');

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
