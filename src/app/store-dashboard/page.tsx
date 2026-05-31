'use client';

/**
 * Store-Manager Dashboard — "what do I need to buy right now?"
 *
 * Lists every raw_material whose current_stock dipped below its declared
 * reorder_level (buffer stock). For each row we show:
 *   - how much to buy (in recipe-units AND purchase-unit packs)
 *   - last vendor + last unit price + estimated cost to restock
 *   - severity (critical = out of stock, low = below buffer, ok = OK)
 *   - days since last purchase (spot dead-stock items wrongly flagged)
 *
 * Top summary cards: total items below buffer, critical out-of-stocks,
 * total estimated restock spend, and stale-vendor count (no purchase in 60d).
 *
 * Tools:
 *   - Filter by category, search, include OK toggle
 *   - Download CSV (one-click handoff to procurement / WhatsApp)
 *   - "Raise Requisition" deep-link to /requisitions
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle, Loader2, Search, RefreshCw, Download, ShoppingCart, Package,
  CheckCircle2, Calendar, IndianRupee,
} from 'lucide-react';

interface BuyRow {
  id: string; sku?: string; name: string; category: string;
  recipe_unit: string; purchase_unit: string;
  pack_size: number; case_size: number;
  current_stock: number; reorder_level: number; deficit: number;
  suggest_recipe_qty: number; suggest_purchase_qty: number;
  last_vendor: string; last_unit_price: number;
  last_purchase_date: string; days_since_last_purchase: number | null;
  est_cost: number;
  severity: 'critical' | 'low' | 'ok';
}

interface DashData {
  items: BuyRow[];
  summary: { total: number; critical: number; low: number; total_est_cost: number; stale_vendor_count: number };
  categories: string[];
}

const fmt = (v: number) => '₹' + (v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const fmtNum = (v: number, d = 2) => (v || 0).toLocaleString('en-IN', { maximumFractionDigits: d });

function csvEscape(v: any): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export default function StoreDashboardPage() {
  const [data, setData] = useState<DashData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [includeOk, setIncludeOk] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [severityFilter, setSeverityFilter] = useState<'all' | 'critical' | 'low'>('all');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams();
    if (search) qs.set('q', search);
    if (category) qs.set('category', category);
    if (includeOk) qs.set('include_ok', '1');
    fetch(`/api/store-dashboard?${qs}`)
      .then(r => r.json())
      .then(j => {
        if (cancelled) return;
        if (j.error) { setError(j.error); setData(null); }
        else setData(j);
      })
      .catch(e => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [search, category, includeOk, refreshKey]);

  const filtered = useMemo(() => {
    if (!data) return [];
    if (severityFilter === 'all') return data.items;
    return data.items.filter(i => i.severity === severityFilter);
  }, [data, severityFilter]);

  const downloadCsv = () => {
    if (!data) return;
    const headers = ['SKU', 'Material', 'Category', 'Current Stock', 'Recipe Unit',
      'Buffer (Reorder Level)', 'Suggested Buy (recipe)', 'Suggested Buy (packs)',
      'Purchase Unit', 'Pack Size', 'Last Vendor', 'Last Unit ₹', 'Est. Cost ₹',
      'Last Purchase Date', 'Days Since', 'Severity'];
    const lines = [headers.join(',')];
    for (const r of filtered) {
      lines.push([
        r.sku, r.name, r.category,
        r.current_stock, r.recipe_unit,
        r.reorder_level, r.suggest_recipe_qty, r.suggest_purchase_qty,
        r.purchase_unit, r.pack_size,
        r.last_vendor, r.last_unit_price.toFixed(2), r.est_cost.toFixed(2),
        r.last_purchase_date, r.days_since_last_purchase ?? '',
        r.severity,
      ].map(csvEscape).join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `low-stock-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const sev = data?.summary || { total: 0, critical: 0, low: 0, total_est_cost: 0, stale_vendor_count: 0 };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
            <ShoppingCart className="w-6 h-6 text-[#af4408]" /> Store — Low-Stock Buy List
          </h1>
          <p className="text-xs text-[#6B5744] mt-0.5">
            Items whose stock has dropped below the declared <b>buffer (reorder level)</b>.
            Suggested buy qty restores you to buffer. Last vendor + price are pulled from
            the most recent purchase so you can ballpark spend before raising a PO.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={downloadCsv} disabled={!data || filtered.length === 0}
                  className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm flex items-center gap-2 disabled:opacity-50"
                  title="Hand off to procurement / WhatsApp">
            <Download className="w-4 h-4" /> Download CSV
          </button>
          <Link href="/requisitions"
                className="px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm flex items-center gap-2"
                title="Raise an internal requisition for these items">
            <Package className="w-4 h-4" /> Raise Requisition
          </Link>
          <button onClick={() => setRefreshKey(k => k + 1)}
                  className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm flex items-center gap-2">
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Items below buffer" value={sev.total.toLocaleString('en-IN')}
                  tone="bg-amber-50 border-amber-200 text-amber-900" icon={<AlertTriangle className="w-4 h-4" />} />
        <StatCard label="Critical (out of stock)" value={sev.critical.toLocaleString('en-IN')}
                  tone="bg-red-50 border-red-200 text-red-900" icon={<AlertTriangle className="w-4 h-4" />} />
        <StatCard label="Est. restock spend" value={fmt(sev.total_est_cost)}
                  tone="bg-emerald-50 border-emerald-200 text-emerald-900" icon={<IndianRupee className="w-4 h-4" />} />
        <StatCard label="Stale vendor (>60d)" value={sev.stale_vendor_count.toLocaleString('en-IN')}
                  tone="bg-[#FFF1E3] border-[#D4B896] text-[#6B5744]" icon={<Calendar className="w-4 h-4" />} />
      </div>

      {/* Severity tabs */}
      <div className="flex gap-2 flex-wrap text-xs">
        {([
          { k: 'all',      label: 'All',      n: sev.total },
          { k: 'critical', label: 'Critical', n: sev.critical },
          { k: 'low',      label: 'Low',      n: sev.low },
        ] as const).map(t => (
          <button key={t.k} onClick={() => setSeverityFilter(t.k)}
                  className={`px-3 py-1.5 rounded border ${
                    severityFilter === t.k
                      ? (t.k === 'critical' ? 'bg-red-600 text-white border-red-600'
                        : t.k === 'low' ? 'bg-amber-600 text-white border-amber-600'
                        : 'bg-[#af4408] text-white border-[#af4408]')
                      : 'bg-white text-[#6B5744] border-[#E8D5C4]'
                  }`}>
            {t.label} <span className="ml-1 font-mono">{t.n}</span>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 bg-white border border-[#E8D5C4] rounded-xl p-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-2 top-2 text-[#8B7355]" />
          <input value={search} onChange={e => setSearch(e.target.value)}
                 placeholder="Search SKU or name…"
                 className="w-full pl-8 pr-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0]" />
        </div>
        <select value={category} onChange={e => setCategory(e.target.value)}
                className="px-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0] min-w-[160px]">
          <option value="">All categories</option>
          {(data?.categories || []).map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <label className="text-xs text-[#6B5744] flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={includeOk} onChange={e => setIncludeOk(e.target.checked)} />
          Show OK items too
        </label>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{error}</div>
      )}

      {/* Table */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-sm text-[#8B7355]">
            <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center text-sm text-[#8B7355]">
            <CheckCircle2 className="w-7 h-7 mx-auto mb-2 text-emerald-500" />
            All clear — no items below buffer in this slice.
            {severityFilter !== 'all' && <> Try the "All" tab.</>}
          </div>
        ) : (
          <div className="overflow-x-auto max-h-[70vh] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-[#FFF1E3] text-[#6B5744] sticky top-0">
                <tr>
                  <th className="text-left  py-2 px-2 font-medium">Material</th>
                  <th className="text-left  py-2 px-2 font-medium">Category</th>
                  <th className="text-right py-2 px-2 font-medium" title="What's on hand right now">Current</th>
                  <th className="text-right py-2 px-2 font-medium" title="Buffer / reorder level — alert if stock drops below this">Buffer</th>
                  <th className="text-right py-2 px-2 font-medium" title="How much to buy to restore buffer (in recipe units)">To Buy (recipe)</th>
                  <th className="text-right py-2 px-2 font-medium" title="How many purchase-unit packs that equates to">Packs</th>
                  <th className="text-left  py-2 px-2 font-medium">Last Vendor</th>
                  <th className="text-right py-2 px-2 font-medium">Last ₹</th>
                  <th className="text-right py-2 px-2 font-medium">Est. Cost</th>
                  <th className="text-right py-2 px-2 font-medium" title="Days since last purchase">Last Buy</th>
                  <th className="text-left  py-2 px-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => {
                  const sevColor = r.severity === 'critical' ? 'bg-red-50/50'
                                  : r.severity === 'low' ? 'bg-amber-50/30' : '';
                  return (
                    <tr key={r.id} className={`border-t border-[#E8D5C4]/50 ${sevColor}`}>
                      <td className="py-1.5 px-2">
                        <div className="font-medium text-[#2D1B0E]">{r.name}</div>
                        {r.sku && <div className="text-[9px] font-mono text-[#8B7355]">{r.sku}</div>}
                      </td>
                      <td className="py-1.5 px-2 text-[#6B5744]">{r.category || '—'}</td>
                      <td className="py-1.5 px-2 text-right font-mono">
                        <span className={r.current_stock <= 0 ? 'text-red-700 font-semibold' : 'text-[#6B5744]'}>
                          {fmtNum(r.current_stock)} {r.recipe_unit}
                        </span>
                      </td>
                      <td className="py-1.5 px-2 text-right font-mono text-[#6B5744]">
                        {fmtNum(r.reorder_level)} {r.recipe_unit}
                      </td>
                      <td className="py-1.5 px-2 text-right font-mono font-semibold text-[#af4408]">
                        {fmtNum(r.suggest_recipe_qty)} {r.recipe_unit}
                      </td>
                      <td className="py-1.5 px-2 text-right font-mono text-[#6B5744]">
                        {r.pack_size > 1
                          ? <>{r.suggest_purchase_qty} <span className="text-[9px]">{r.purchase_unit}</span></>
                          : <span className="text-[#C0A98F]">—</span>}
                      </td>
                      <td className="py-1.5 px-2 text-[#6B5744]">{r.last_vendor || <span className="text-[#C0A98F]">—</span>}</td>
                      <td className="py-1.5 px-2 text-right font-mono">{r.last_unit_price > 0 ? fmt(r.last_unit_price) : '—'}</td>
                      <td className="py-1.5 px-2 text-right font-mono font-semibold text-emerald-700">
                        {r.est_cost > 0 ? fmt(r.est_cost) : '—'}
                      </td>
                      <td className="py-1.5 px-2 text-right text-[#8B7355]">
                        {r.days_since_last_purchase != null
                          ? <span className={r.days_since_last_purchase > 60 ? 'text-amber-700' : ''}>{r.days_since_last_purchase}d</span>
                          : <span className="text-[#C0A98F]">never</span>}
                      </td>
                      <td className="py-1.5 px-2">
                        <SevBadge s={r.severity} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="bg-[#FFF1E3]/60 text-[#6B5744] font-semibold">
                <tr>
                  <td colSpan={8} className="py-2 px-2 text-right">Total estimated spend</td>
                  <td className="py-2 px-2 text-right font-mono text-emerald-800">
                    {fmt(filtered.reduce((s, r) => s + r.est_cost, 0))}
                  </td>
                  <td colSpan={2}></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      <p className="text-[10px] text-[#8B7355]">
        Tip: buffer stock (reorder level) is set per item on the <Link href="/inventory" className="underline">Inventory</Link> page.
        Items with buffer = 0 never appear here — set a non-zero buffer to opt-in to alerts.
      </p>
    </div>
  );
}

function StatCard({ label, value, tone, icon }: { label: string; value: string; tone: string; icon: React.ReactNode }) {
  return (
    <div className={`border rounded-xl p-3 ${tone}`}>
      <div className="text-[10px] uppercase tracking-wide opacity-80 flex items-center gap-1">{icon} {label}</div>
      <div className="text-xl font-bold font-mono mt-0.5">{value}</div>
    </div>
  );
}

function SevBadge({ s }: { s: 'critical' | 'low' | 'ok' }) {
  if (s === 'critical') return <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-800 border border-red-200">Out of stock</span>;
  if (s === 'low')      return <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200">Below buffer</span>;
  return                       <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 border border-emerald-200">OK</span>;
}
