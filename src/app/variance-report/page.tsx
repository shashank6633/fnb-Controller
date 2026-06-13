'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  ClipboardCheck, Download, RefreshCw, AlertTriangle, Calendar, Search,
  TrendingDown, TrendingUp, Loader2,
} from 'lucide-react';

const fmt = (v: number) => '₹' + (v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const fmt2 = (v: number) => (v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const dateLabel = (s?: string | null) =>
  s ? new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

function defaultRange() {
  const d = new Date(); d.setDate(d.getDate() - 30);
  return { from: d.toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) };
}

export default function VarianceReportPage() {
  const [from, setFrom]       = useState(defaultRange().from);
  const [to, setTo]           = useState(defaultRange().to);
  const [singleDate, setSingleDate] = useState<string>('');
  const [category, setCategory]     = useState('');
  const [search, setSearch]         = useState('');
  const [data, setData]             = useState<any>(null);
  const [loading, setLoading]       = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (singleDate) qs.set('date', singleDate);
      else { qs.set('from', from); qs.set('to', to); }
      if (category) qs.set('category', category);
      const r = await fetch(`/api/variance-report?${qs}`).then(r => r.json());
      setData(r);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [from, to, singleDate, category]);

  const filtered = useMemo(() => {
    if (!data?.rows) return [];
    let l = data.rows;
    if (search) {
      const q = search.toLowerCase();
      l = l.filter((r: any) =>
        r.material_name.toLowerCase().includes(q) ||
        (r.material_sku || '').toLowerCase().includes(q));
    }
    return l;
  }, [data, search]);

  const exportCsv = () => {
    if (filtered.length === 0) return;
    const headers = ['date','sku','material','category','unit',
                     'purchases_to_date','recipe_to_date','theoretical_stock',
                     'physical_stock','loss','avg_price','loss_value','recorded_by','notes'];
    const lines = [headers.join(',')];
    for (const r of filtered) {
      const v = headers.map(h => {
        const map: any = { sku: 'material_sku', material: 'material_name', unit: 'material_unit', avg_price: 'average_price' };
        const k = map[h] ?? h;
        const x = r[k];
        if (x === null || x === undefined) return '';
        const s = String(x).replace(/"/g, '""');
        return s.includes(',') ? `"${s}"` : s;
      });
      lines.push(v.join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `variance-${singleDate || from + '_to_' + to}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const summary = data?.summary || {};
  const shrinkage = summary.shrinkage || 0;
  const overcount = summary.overcount || 0;
  const net = summary.net_variance || 0;
  const counted = summary.counted_stock_value || 0;
  const shrinkPct = counted > 0 ? (shrinkage / counted) * 100 : 0;

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-2">
              <ClipboardCheck className="w-6 h-6" /> Closing-Stock Variance
            </h1>
            <p className="text-[#8B7355] text-sm mt-1">
              Physical count vs theoretical stock. Internal transfers are excluded — only purchases and recipe consumption move the books.
            </p>
            <div className="mt-2 inline-flex flex-wrap gap-2 text-[11px] font-mono">
              <span className="px-2 py-1 rounded bg-[#FFF1E3] border border-[#D4B896] text-[#6B5744]">
                <b className="text-[#2D1B0E]">Theoretical</b> = Purchases − Recipe
              </span>
              <span className="px-2 py-1 rounded bg-red-50 border border-red-200 text-red-800">
                <b>Loss</b> = Purchases − Recipe − Closing Stock
              </span>
            </div>
          </div>
          <button onClick={exportCsv} disabled={filtered.length === 0}
                  className="inline-flex items-center gap-2 px-3 py-2 bg-[#FFF1E3] text-[#6B5744] hover:bg-[#FFE9D4] border border-[#D4B896] rounded-lg text-sm disabled:opacity-50">
            <Download className="w-4 h-4" /> Export CSV
          </button>
        </div>

        {/* Filter bar */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 shadow flex flex-wrap items-center gap-3">
          {!singleDate ? (
            <>
              <label className="text-xs text-[#6B5744] flex items-center gap-1">
                <Calendar className="w-3 h-3" /> From
                <input type="date" value={from} onChange={e => setFrom(e.target.value)}
                       className="ml-1 px-2 py-1 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-xs" />
              </label>
              <label className="text-xs text-[#6B5744] flex items-center gap-1">
                <Calendar className="w-3 h-3" /> To
                <input type="date" value={to} onChange={e => setTo(e.target.value)}
                       className="ml-1 px-2 py-1 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-xs" />
              </label>
            </>
          ) : (
            <span className="text-xs text-[#6B5744]">Showing single date: <b>{dateLabel(singleDate)}</b></span>
          )}
          {data?.dates?.length > 0 && (
            <label className="text-xs text-[#6B5744] flex items-center gap-1">
              Pick a date
              <select value={singleDate} onChange={e => setSingleDate(e.target.value)}
                      className="ml-1 px-2 py-1 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-xs">
                <option value="">— Range above —</option>
                {data.dates.map((d: any) => (
                  <option key={d.date} value={d.date}>{dateLabel(d.date)} ({d.items_counted} items, net ₹{Math.round(d.net_variance)})</option>
                ))}
              </select>
            </label>
          )}
          <label className="text-xs text-[#6B5744]">
            Category
            <select value={category} onChange={e => setCategory(e.target.value)}
                    className="ml-1 px-2 py-1 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-xs">
              <option value="">All</option>
              {['veg','non-veg','bar','grocery','dairy','bakery','spices','beverages','packaging','other'].map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <div className="flex items-center gap-1 flex-1 min-w-[180px]">
            <Search className="w-3 h-3 text-[#8B7355]" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search material…"
                   className="flex-1 px-2 py-1 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-xs" />
          </div>
          <button onClick={() => load()} className="text-xs text-[#6B5744] hover:text-[#af4408] flex items-center gap-1">
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>

        {/* Summary tiles */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <SummaryTile icon={<TrendingDown className="w-4 h-4 text-red-600" />}
                       label="Shrinkage |₹|" value={fmt(shrinkage)}
                       sub={shrinkPct > 0 ? `${shrinkPct.toFixed(2)}% of counted stock value` : undefined}
                       color="text-red-600" />
          <SummaryTile icon={<TrendingUp className="w-4 h-4 text-indigo-600" />}
                       label="Over-count |₹|" value={fmt(overcount)}
                       color="text-indigo-600" />
          <SummaryTile icon={<AlertTriangle className="w-4 h-4 text-amber-600" />}
                       label="Net variance ₹" value={(net >= 0 ? '+' : '') + fmt(net)}
                       sub={net >= 0 ? 'over-counted overall' : 'under-counted overall'}
                       color={net < 0 ? 'text-red-600' : net > 0 ? 'text-indigo-600' : 'text-[#8B7355]'} />
          <SummaryTile icon={<ClipboardCheck className="w-4 h-4 text-[#af4408]" />}
                       label="Lines counted" value={String(summary.lines || 0)}
                       sub={`${summary.count_dates || 0} closing-count date(s)`}
                       color="text-[#af4408]" />
        </div>

        {/* By category */}
        {data?.by_category?.length > 0 && (
          <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
            <div className="px-4 py-2 border-b border-[#E8D5C4] bg-[#FFF1E3]/50">
              <h3 className="text-sm font-semibold text-[#2D1B0E]">By category</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-[#FFF1E3] text-[#6B5744]">
                  <tr>
                    <th className="text-left  py-1.5 px-3 font-medium">Category</th>
                    <th className="text-right py-1.5 px-3 font-medium">Items counted</th>
                    <th className="text-right py-1.5 px-3 font-medium">Shrinkage |₹|</th>
                    <th className="text-right py-1.5 px-3 font-medium">Over-count |₹|</th>
                    <th className="text-right py-1.5 px-3 font-medium">Net ₹</th>
                  </tr>
                </thead>
                <tbody>
                  {data.by_category.map((c: any, i: number) => (
                    <tr key={i} className="border-t border-[#E8D5C4]/50">
                      <td className="py-1.5 px-3 capitalize">{c.category}</td>
                      <td className="py-1.5 px-3 text-right font-mono">{c.items_counted}</td>
                      <td className="py-1.5 px-3 text-right font-mono text-red-600">{fmt(c.shrinkage)}</td>
                      <td className="py-1.5 px-3 text-right font-mono text-indigo-600">{fmt(c.overcount)}</td>
                      <td className={`py-1.5 px-3 text-right font-mono font-semibold ${c.net_variance < 0 ? 'text-red-600' : c.net_variance > 0 ? 'text-indigo-600' : 'text-[#8B7355]'}`}>
                        {(c.net_variance >= 0 ? '+' : '') + fmt(c.net_variance)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Repeat offenders */}
        {data?.repeat_offenders?.length > 0 && (
          <div className="bg-white border border-amber-200 rounded-xl shadow overflow-hidden">
            <div className="px-4 py-2 border-b border-amber-200 bg-amber-50">
              <h3 className="text-sm font-semibold text-amber-900">Repeat offenders — variance over multiple counts</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-amber-50/50 text-[#6B5744]">
                  <tr>
                    <th className="text-left  py-1.5 px-3 font-medium">SKU</th>
                    <th className="text-left  py-1.5 px-3 font-medium">Material</th>
                    <th className="text-right py-1.5 px-3 font-medium">Times counted</th>
                    <th className="text-right py-1.5 px-3 font-medium">Σ |variance| ₹</th>
                    <th className="text-right py-1.5 px-3 font-medium">Net ₹</th>
                    <th className="text-left  py-1.5 px-3 font-medium">Last count</th>
                  </tr>
                </thead>
                <tbody>
                  {data.repeat_offenders.map((r: any) => (
                    <tr key={r.id} className="border-t border-amber-100/50 hover:bg-amber-50/30">
                      <td className="py-1.5 px-3 font-mono text-[10px] text-[#8B7355]">{r.sku || '·'}</td>
                      <td className="py-1.5 px-3">{r.name}</td>
                      <td className="py-1.5 px-3 text-right font-mono">{r.times_counted}</td>
                      <td className="py-1.5 px-3 text-right font-mono text-red-600">{fmt(r.total_abs_variance)}</td>
                      <td className={`py-1.5 px-3 text-right font-mono ${r.net_variance < 0 ? 'text-red-600' : 'text-indigo-600'}`}>
                        {(r.net_variance >= 0 ? '+' : '') + fmt(r.net_variance)}
                      </td>
                      <td className="py-1.5 px-3">{dateLabel(r.last_count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Per-line table */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
          <div className="px-4 py-2 border-b border-[#E8D5C4] bg-[#FFF1E3]/50 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[#2D1B0E]">All variance lines ({filtered.length})</h3>
          </div>
          {loading ? (
            <div className="p-6 text-center text-xs text-[#8B7355] inline-flex items-center gap-2 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-center text-xs text-[#8B7355]">
              No closing-stock counts in this range. Use Raw Materials → Closing Stock to record one.
            </div>
          ) : (
            <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-[#FFF1E3] sticky top-0 z-10 text-[#6B5744]">
                  <tr>
                    <th className="text-left  py-1.5 px-3 font-medium">Date</th>
                    <th className="text-left  py-1.5 px-3 font-medium">SKU</th>
                    <th className="text-left  py-1.5 px-3 font-medium">Material</th>
                    <th className="text-right py-1.5 px-3 font-medium" title="Σ purchase quantities up to count date">Purchases</th>
                    <th className="text-right py-1.5 px-3 font-medium" title="Σ recipe-driven consumption up to count date (sales + parties + staff meals)">Recipe</th>
                    <th className="text-right py-1.5 px-3 font-medium" title="Purchases − Recipe">Theoretical</th>
                    <th className="text-right py-1.5 px-3 font-medium" title="Physical closing-stock count">Closing</th>
                    <th className="text-right py-1.5 px-3 font-medium" title="Theoretical − Closing (positive = loss)">Loss</th>
                    <th className="text-right py-1.5 px-3 font-medium" title="Loss × material avg price">Loss ₹</th>
                    <th className="text-left  py-1.5 px-3 font-medium">By</th>
                    <th className="text-left  py-1.5 px-3 font-medium">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r: any) => {
                    // Loss = Theoretical − Physical = Purchases − Recipe − Closing Stock
                    // Positive loss → leakage / shrinkage. Negative → surplus.
                    const loss = r.loss != null ? r.loss : (r.system_stock - r.physical_stock);
                    const lossValue = r.loss_value != null ? r.loss_value : (loss * (r.average_price || 0));
                    const isLoss = loss > 0;
                    const isSurplus = loss < 0;
                    return (
                      <tr key={r.id} className={`border-t border-[#E8D5C4]/50 ${isLoss ? 'bg-red-50/20' : isSurplus ? 'bg-indigo-50/20' : ''}`}>
                        <td className="py-1.5 px-3">{dateLabel(r.date)}</td>
                        <td className="py-1.5 px-3 font-mono text-[10px] text-[#8B7355]">{r.material_sku || '·'}</td>
                        <td className="py-1.5 px-3">{r.material_name}</td>
                        <td className="py-1.5 px-3 text-right font-mono text-emerald-700">
                          {r.purchases_to_date != null ? fmt2(r.purchases_to_date) : '—'} <span className="text-[#8B7355]">{r.material_unit}</span>
                        </td>
                        <td className="py-1.5 px-3 text-right font-mono text-blue-700">
                          {r.recipe_to_date != null ? fmt2(r.recipe_to_date) : '—'} <span className="text-[#8B7355]">{r.material_unit}</span>
                        </td>
                        <td className="py-1.5 px-3 text-right font-mono text-[#2D1B0E]">
                          {fmt2(r.theoretical_stock ?? r.system_stock)} <span className="text-[#8B7355]">{r.material_unit}</span>
                        </td>
                        <td className="py-1.5 px-3 text-right font-mono text-[#6B5744]">
                          {fmt2(r.physical_stock)} <span className="text-[#8B7355]">{r.material_unit}</span>
                        </td>
                        <td className={`py-1.5 px-3 text-right font-mono font-semibold ${isLoss ? 'text-red-600' : isSurplus ? 'text-indigo-600' : 'text-[#8B7355]'}`}>
                          {(loss >= 0 ? '+' : '') + fmt2(loss)} {r.material_unit}
                        </td>
                        <td className={`py-1.5 px-3 text-right font-mono font-semibold ${isLoss ? 'text-red-600' : isSurplus ? 'text-indigo-600' : 'text-[#8B7355]'}`}>
                          {(lossValue >= 0 ? '+' : '') + fmt(lossValue)}
                        </td>
                        <td className="py-1.5 px-3 text-[#8B7355]">{r.recorded_by || '—'}</td>
                        <td className="py-1.5 px-3 text-[#6B5744]">{r.notes || ''}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryTile({ icon, label, value, sub, color }: { icon: React.ReactNode; label: string; value: string; sub?: string; color: string }) {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 shadow">
      <p className="text-[10px] uppercase tracking-wider text-[#8B7355] flex items-center gap-1">
        {icon} {label}
      </p>
      <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
      {sub && <p className="text-[10px] text-[#8B7355] mt-1">{sub}</p>}
    </div>
  );
}
