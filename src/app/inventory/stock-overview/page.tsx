'use client';

/**
 * Consolidated Stock — the ADMIN multi-floor bar board (multi-floor bar,
 * Phase 1, Slice A). A pivot of every material against EVERY active store
 * (Liquor Store + each floor bar) with a Total qty + Total value column.
 *
 * Source: GET /api/stores/overview → consolidatedStock() (each store's own
 * weighted-avg valuation, matching the per-store pages). Gate is server-side
 * (admin / manager / store-manager / HOD); a 403 renders the 🔒 notice here.
 *
 * Quantities are RECIPE units on the ledger; where a material packs (pack_size
 * > 1) we show the bar Cases + Bottles + loose (CBL) breakdown beneath the raw
 * qty, reusing pack-units (tripleToRecipe/fmtBreakdown) so the math never
 * drifts from the Liquor Store / closing pages.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Wine, Search, X, Loader2, AlertCircle, Download, Layers,
  IndianRupee, Store as StoreIcon, AlertTriangle, PackageX, Warehouse,
} from 'lucide-react';
import Papa from 'papaparse';
import { fmtBreakdown, PackMeta } from '@/lib/pack-units';

/* ── Types ─────────────────────────────────────────────────────────────── */

interface StoreCol { id: string; name: string; code: string; }
interface Row {
  material_id: string;
  name: string;
  category: string;
  unit: string;
  pack_size: number;
  case_size: number;
  sku: string;
  purchase_unit: string;
  by_store: Record<string, number>;
  /** Central grocery backstock (recipe units) = raw_materials.current_stock. */
  grocery_qty: number;
  /** grocery_qty × raw_materials.average_price. Folded into total_value. */
  grocery_value: number;
  total_qty: number;
  total_value: number;
}

/* ── Helpers ───────────────────────────────────────────────────────────── */

const fq = (v: number, dp = 2) =>
  Number((Number(v) || 0).toFixed(dp)).toLocaleString('en-IN');
const inr = (v: number, dp = 0) =>
  '₹' + (Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: dp });
const packMeta = (r: Row): PackMeta => ({
  unit: r.unit, purchase_unit: r.purchase_unit, pack_size: r.pack_size, case_size: r.case_size,
});
const PAGE_SIZE = 50;

/* One qty cell: raw recipe qty, with the CBL breakdown beneath when packed. */
function QtyCell({ qty, r, strong }: { qty: number; r: Row; strong?: boolean }) {
  const neg = qty < 0;
  const dual = (r.pack_size > 1 || (r.case_size ?? 1) > 1) ? fmtBreakdown(qty, packMeta(r)) : null;
  const zero = qty === 0;
  return (
    <div className={`text-right tabular-nums ${neg ? 'text-red-700' : zero ? 'text-[#B9A896]' : 'text-[#2D1B0E]'}`}>
      <span className={strong ? 'font-semibold' : ''}>{fq(qty)}</span>
      {dual && <div className="text-[10px] text-[#8B7355] font-normal leading-tight">{dual}</div>}
    </div>
  );
}

/* ── Page ──────────────────────────────────────────────────────────────── */

export default function StockOverviewPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [stores, setStores] = useState<StoreCol[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [generatedAt, setGeneratedAt] = useState('');

  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true); setError('');
      try {
        const res = await fetch('/api/stores/overview', { credentials: 'same-origin' });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        if (!alive) return;
        setStores(Array.isArray(data.stores) ? data.stores : []);
        setRows(Array.isArray(data.rows) ? data.rows : []);
        setGeneratedAt(data.generated_at || '');
      } catch (e: any) {
        if (alive) setError(e?.message || 'Failed to load');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.category) set.add(r.category);
    return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }, [rows]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter(r => {
      if (cat && r.category !== cat) return false;
      if (!needle) return true;
      return r.name.toLowerCase().includes(needle) || (r.sku || '').toLowerCase().includes(needle);
    });
  }, [rows, q, cat]);

  // Reset to page 1 whenever the filter set changes.
  useEffect(() => { setPage(1); }, [q, cat]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageSafe = Math.min(page, totalPages);
  const paged = useMemo(
    () => filtered.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE),
    [filtered, pageSafe],
  );

  // Summary over the FILTERED set (what the user is looking at).
  const summary = useMemo(() => {
    let value = 0, grocery = 0, negative = 0, out = 0;
    for (const r of filtered) {
      value += r.total_value;
      grocery += r.grocery_value;
      if (r.total_qty < 0) negative++;
      else if (r.total_qty === 0) out++;
    }
    return { value, grocery, negative, out, items: filtered.length };
  }, [filtered]);

  const exportCsv = () => {
    const header = ['Material', 'SKU', 'Category', 'Unit', 'Grocery (central)', ...stores.map(s => s.name), 'Total Qty', 'Total Value'];
    const body = filtered.map(r => [
      r.name, r.sku || '', r.category || '', r.unit || '',
      Number(r.grocery_qty),
      ...stores.map(s => Number(r.by_store[s.id] ?? 0)),
      Number(r.total_qty), Number(r.total_value),
    ]);
    const csv = Papa.unparse([header, ...body]);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `consolidated-stock-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /* ── Render ──────────────────────────────────────────────────────────── */

  if (loading) {
    return (
      <div className="p-6 max-w-3xl mx-auto text-sm text-[#6B5744]">
        <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading consolidated stock…
      </div>
    );
  }
  if (error) {
    const denied = /limited to|authoriz|not authorized/i.test(error);
    return (
      <div className="p-6 max-w-3xl mx-auto space-y-3">
        <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
          <Wine className="w-6 h-6 text-[#af4408]" /> Consolidated Stock
        </h1>
        <div className={`rounded-lg p-4 text-sm flex items-center gap-2 ${
          denied ? 'bg-amber-50 border border-amber-200 text-amber-900' : 'bg-red-50 border border-red-200 text-red-700'}`}>
          <AlertCircle className="w-4 h-4 shrink-0" /> {denied ? `🔒 ${error}` : error}
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex-1 min-w-[200px]">
          <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
            <Wine className="w-6 h-6 text-[#af4408]" /> Consolidated Stock
          </h1>
          <p className="text-xs text-[#6B5744] mt-0.5">
            Central grocery backstock plus every material across the Liquor Store and each floor bar, with total qty and value.
            {generatedAt && <span className="text-[#B9A896]"> · as of {new Date(generatedAt).toLocaleString('en-IN')}</span>}
          </p>
        </div>
        <button onClick={exportCsv} disabled={filtered.length === 0}
                className="px-3 py-2 bg-white border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 disabled:opacity-40 rounded-lg text-sm font-medium flex items-center gap-1.5">
          <Download className="w-4 h-4" /> Export CSV
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2.5">
        <SummaryCard icon={<IndianRupee className="w-4 h-4" />} label="Total value" value={inr(summary.value)} />
        <SummaryCard icon={<Warehouse className="w-4 h-4" />} label="Grocery value" value={inr(summary.grocery)} />
        <SummaryCard icon={<StoreIcon className="w-4 h-4" />} label="Locations" value={String(stores.length)} />
        <SummaryCard icon={<Layers className="w-4 h-4" />} label="Materials" value={summary.items.toLocaleString('en-IN')} />
        <SummaryCard
          icon={<AlertTriangle className="w-4 h-4" />}
          label="Flags"
          value={`${summary.negative} neg · ${summary.out} out`}
          tone={summary.negative > 0 ? 'warn' : 'muted'}
        />
      </div>

      {/* Search + category filter */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px] max-w-md">
          <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8B7355]" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name or SKU…"
                 className="w-full pl-8 pr-8 py-2 border border-[#E8D5C4] rounded-lg text-sm bg-white" />
          {q && (
            <button onClick={() => setQ('')} aria-label="Clear search"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-[#8B7355] hover:text-[#2D1B0E]">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <select value={cat} onChange={e => setCat(e.target.value)}
                className="px-2.5 py-2 border border-[#E8D5C4] rounded-lg text-sm bg-white text-[#2D1B0E] max-w-[220px]">
          <option value="">All categories</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        {(q || cat) && (
          <button onClick={() => { setQ(''); setCat(''); }}
                  className="text-xs text-[#af4408] hover:underline">Reset</button>
        )}
      </div>

      {/* Empty */}
      {filtered.length === 0 ? (
        <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-8 text-center text-sm text-[#8B7355]">
          <PackageX className="w-6 h-6 mx-auto mb-2 text-[#B9A896]" />
          {rows.length === 0
            ? 'No stock across any store yet. Purchases and transfers will appear here.'
            : 'No materials match your search.'}
        </div>
      ) : (
        <>
          {/* Desktop / wide: pivot table (horizontal scroll) */}
          <div className="hidden sm:block overflow-x-auto border border-[#E8D5C4] rounded-lg bg-white">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-[#FFF1E3] text-[#6B5744] text-xs">
                  <th className="text-left font-semibold px-3 py-2 sticky left-0 bg-[#FFF1E3] z-10 min-w-[200px]">Material</th>
                  <th className="text-left font-semibold px-3 py-2 min-w-[110px]">Category</th>
                  <th className="text-right font-semibold px-3 py-2 min-w-[90px] whitespace-nowrap bg-[#FBF0E6] border-l border-[#F0E4D6]">
                    Grocery
                    <div className="text-[9px] font-normal text-[#B9A896] leading-none">central</div>
                  </th>
                  {stores.map(s => (
                    <th key={s.id} className="text-right font-semibold px-3 py-2 min-w-[90px] whitespace-nowrap">{s.name}</th>
                  ))}
                  <th className="text-right font-semibold px-3 py-2 min-w-[90px] bg-[#FBE7D3]">Total</th>
                  <th className="text-right font-semibold px-3 py-2 min-w-[100px] bg-[#FBE7D3]">Value</th>
                </tr>
              </thead>
              <tbody>
                {paged.map(r => (
                  <tr key={r.material_id} className="border-t border-[#F0E4D6] hover:bg-[#FFF8F0]">
                    <td className="px-3 py-2 sticky left-0 bg-white z-10">
                      <div className="font-medium text-[#2D1B0E] leading-tight">{r.name}</div>
                      {r.sku && <div className="text-[10px] text-[#B9A896]">{r.sku}</div>}
                    </td>
                    <td className="px-3 py-2 text-[#6B5744] text-xs">{r.category}</td>
                    <td className="px-3 py-2 bg-[#FDF7F1] border-l border-[#F0E4D6]"><QtyCell qty={r.grocery_qty} r={r} /></td>
                    {stores.map(s => (
                      <td key={s.id} className="px-3 py-2"><QtyCell qty={Number(r.by_store[s.id] ?? 0)} r={r} /></td>
                    ))}
                    <td className="px-3 py-2 bg-[#FEF6EE]"><QtyCell qty={r.total_qty} r={r} strong /></td>
                    <td className="px-3 py-2 bg-[#FEF6EE] text-right tabular-nums text-[#2D1B0E]">{inr(r.total_value)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-[#E8D5C4] bg-[#FFF1E3] font-semibold text-[#2D1B0E]">
                  <td className="px-3 py-2 sticky left-0 bg-[#FFF1E3] z-10">Page total</td>
                  <td className="px-3 py-2" />
                  <td className="px-3 py-2 text-right tabular-nums text-xs text-[#6B5744] bg-[#FBF0E6] border-l border-[#F0E4D6]">
                    {fq(paged.reduce((a, r) => a + r.grocery_qty, 0))}
                  </td>
                  {stores.map(s => (
                    <td key={s.id} className="px-3 py-2 text-right tabular-nums text-xs text-[#6B5744]">
                      {fq(paged.reduce((a, r) => a + Number(r.by_store[s.id] ?? 0), 0))}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right tabular-nums text-xs bg-[#FBE7D3]">
                    {fq(paged.reduce((a, r) => a + r.total_qty, 0))}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums bg-[#FBE7D3]">
                    {inr(paged.reduce((a, r) => a + r.total_value, 0))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Mobile: stacked cards */}
          <div className="sm:hidden space-y-2.5">
            {paged.map(r => (
              <div key={r.material_id} className="border border-[#E8D5C4] rounded-lg bg-white p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-[#2D1B0E] leading-tight">{r.name}</div>
                    <div className="text-[11px] text-[#8B7355]">{r.category}{r.sku ? ` · ${r.sku}` : ''}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-[10px] text-[#8B7355] uppercase tracking-wide">Total</div>
                    <QtyCell qty={r.total_qty} r={r} strong />
                    <div className="text-[11px] text-[#af4408] font-medium">{inr(r.total_value)}</div>
                  </div>
                </div>
                <div className="mt-2 pt-2 border-t border-[#F0E4D6] grid grid-cols-2 gap-x-3 gap-y-1">
                  <div className="flex items-center justify-between gap-2 text-xs min-w-0">
                    <span className="text-[#8B7355] font-medium truncate min-w-0">Grocery</span>
                    <QtyCell qty={r.grocery_qty} r={r} />
                  </div>
                  {stores.map(s => (
                    <div key={s.id} className="flex items-center justify-between gap-2 text-xs min-w-0">
                      <span className="text-[#6B5744] truncate min-w-0">{s.name}</span>
                      <QtyCell qty={Number(r.by_store[s.id] ?? 0)} r={r} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="text-xs text-[#8B7355]">
                Showing {(pageSafe - 1) * PAGE_SIZE + 1}–{Math.min(pageSafe * PAGE_SIZE, filtered.length)} of {filtered.length}
              </span>
              <div className="flex items-center gap-1.5">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={pageSafe <= 1}
                        className="px-3 py-1.5 border border-[#E8D5C4] rounded-lg text-sm disabled:opacity-40 hover:bg-[#FFF8F0]">Prev</button>
                <span className="text-xs text-[#6B5744] px-1">{pageSafe} / {totalPages}</span>
                <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={pageSafe >= totalPages}
                        className="px-3 py-1.5 border border-[#E8D5C4] rounded-lg text-sm disabled:opacity-40 hover:bg-[#FFF8F0]">Next</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ── Summary card ──────────────────────────────────────────────────────── */

function SummaryCard({ icon, label, value, tone = 'muted' }: {
  icon: React.ReactNode; label: string; value: string; tone?: 'muted' | 'warn';
}) {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
      <div className={`flex items-center gap-1.5 text-[11px] font-medium ${tone === 'warn' ? 'text-amber-700' : 'text-[#8B7355]'}`}>
        {icon} {label}
      </div>
      <div className="mt-1 text-lg font-bold text-[#2D1B0E] tabular-nums">{value}</div>
    </div>
  );
}
