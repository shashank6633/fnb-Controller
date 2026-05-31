'use client';

/**
 * Daily Closing Roll-up — Phase 1 §6 report.
 * Opening · Received · Consumed (Recipe + Wastage) · Closing · Counted · Variance
 * per material per day. Useful for the EOD close routine.
 */

import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, Download, Filter, Loader2 } from 'lucide-react';

const fmt  = (v: number) => '₹' + Math.round(v || 0).toLocaleString('en-IN');
const fmt2 = (v: number | null) => v == null ? '—' : v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0,10);
const minusDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0,10); };

interface RollupRow {
  date: string; material_id: string; material_name: string; material_sku?: string;
  unit: string; pack_size?: number; purchase_unit?: string; average_price: number;
  opening: number; received: number;
  consumed_recipe: number; consumed_wastage: number; consumed: number;
  closing: number; counted: number | null; variance: number | null; loss_value: number | null;
}

export default function DailyRollupPage() {
  const [data, setData] = useState<{ rows: RollupRow[]; summary: any; range: any } | null>(null);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState(minusDays(7));
  const [to, setTo]     = useState(today());
  const [onlyCounted, setOnlyCounted] = useState(false);
  const [materialFilter, setMaterialFilter] = useState('');
  const [materials, setMaterials] = useState<any[]>([]);

  const reload = async () => {
    setLoading(true);
    const qs = new URLSearchParams({ from, to });
    if (onlyCounted) qs.set('only_counted', '1');
    if (materialFilter) qs.set('material_id', materialFilter);
    const j = await fetch(`/api/daily-rollup?${qs}`).then(r => r.json());
    setData(j);
    setLoading(false);
  };
  useEffect(() => {
    fetch('/api/inventory').then(r => r.json()).then(d => setMaterials(d.materials || []));
  }, []);
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [from, to, onlyCounted, materialFilter]);

  const rows = data?.rows || [];
  // Group rows by date for the rendered output
  const grouped = useMemo(() => {
    const out: Record<string, RollupRow[]> = {};
    for (const r of rows) (out[r.date] ||= []).push(r);
    return out;
  }, [rows]);

  const exportCsv = () => {
    if (rows.length === 0) return;
    const head = ['date','sku','material','unit','opening','received','consumed_recipe','consumed_wastage','consumed','closing','counted','variance','loss_value'];
    const lines = [head.join(',')];
    for (const r of rows) {
      lines.push(head.map(k => {
        const map: any = { sku: 'material_sku', material: 'material_name' };
        const v = (r as any)[map[k] ?? k];
        if (v == null) return '';
        const s = String(v).replace(/"/g, '""');
        return s.includes(',') ? `"${s}"` : s;
      }).join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `daily-rollup-${from}_to_${to}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
            <CalendarClock className="w-6 h-6 text-[#af4408]" /> Daily Closing Roll-up
          </h1>
          <p className="text-xs text-[#6B5744] mt-1">
            <code>Opening + Received − Recipe − Wastage = Closing</code>. When you record a physical count for the day, variance = Closing − Counted (positive = leakage).
          </p>
        </div>
        <button onClick={exportCsv} disabled={rows.length === 0}
                className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] rounded-lg text-sm flex items-center gap-2 disabled:opacity-50">
          <Download className="w-4 h-4" /> Export CSV
        </button>
      </div>

      {/* Filters */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 flex flex-wrap items-end gap-2 text-xs">
        <div className="inline-flex items-center gap-1 text-[#6B5744]"><Filter className="w-3.5 h-3.5" /> Filter</div>
        <label className="flex flex-col text-[#6B5744]">From
          <input type="date" value={from} onChange={e => setFrom(e.target.value)}
                 className="px-2 py-1 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
        </label>
        <label className="flex flex-col text-[#6B5744]">To
          <input type="date" value={to} onChange={e => setTo(e.target.value)}
                 className="px-2 py-1 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
        </label>
        <label className="flex flex-col text-[#6B5744]">Material
          <select value={materialFilter} onChange={e => setMaterialFilter(e.target.value)}
                  className="px-2 py-1 border border-[#E8D5C4] rounded bg-[#FFF8F0] min-w-[200px]">
            <option value="">All</option>
            {materials.slice(0, 500).map((m: any) => <option key={m.id} value={m.id}>{m.sku ? `${m.sku} — ` : ''}{m.name}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-[#6B5744]">
          <input type="checkbox" checked={onlyCounted} onChange={e => setOnlyCounted(e.target.checked)} />
          Only days with a physical count
        </label>
      </div>

      {data?.summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <Stat label="Days in range"          value={String(data.range.days)} />
          <Stat label="Material × day rows"   value={String(data.summary.rows)} />
          <Stat label="Days with count"       value={String(data.summary.days_with_count)} />
          <Stat label="Σ Variance value"      value={fmt(data.summary.total_loss_value || 0)}
                tone={(data.summary.total_loss_value || 0) > 0 ? 'red' : 'emerald'} />
        </div>
      )}

      {loading ? (
        <div className="text-center text-sm text-[#8B7355] py-10"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…</div>
      ) : rows.length === 0 ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center text-sm text-[#8B7355]">
          No activity / counts in this range. Try a wider window, or pick a material.
        </div>
      ) : (
        Object.entries(grouped).map(([date, dayRows]) => (
          <div key={date} className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
            <div className="px-4 py-2 border-b border-[#E8D5C4] bg-[#FFF1E3]/50 flex items-center gap-2">
              <h3 className="font-semibold text-[#2D1B0E]">{date}</h3>
              <span className="text-[10px] text-[#8B7355]">{dayRows.length} materials</span>
              {(() => {
                const dayLoss = dayRows.reduce((s, r) => s + (r.loss_value || 0), 0);
                if (dayLoss === 0) return null;
                return <span className={`ml-auto text-xs font-mono font-semibold ${dayLoss > 0 ? 'text-red-700' : 'text-emerald-700'}`}>
                  Day variance: {fmt(dayLoss)}
                </span>;
              })()}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-[#FFF8F0] text-[#6B5744]">
                  <tr>
                    <th className="text-left  py-1.5 px-3 font-medium">SKU</th>
                    <th className="text-left  py-1.5 px-3 font-medium">Material</th>
                    <th className="text-right py-1.5 px-3 font-medium">Opening</th>
                    <th className="text-right py-1.5 px-3 font-medium">Received</th>
                    <th className="text-right py-1.5 px-3 font-medium" title="Sales · Parties · Staff meals">Recipe</th>
                    <th className="text-right py-1.5 px-3 font-medium" title="Spoilage / Expiry / Damage / etc.">Wastage</th>
                    <th className="text-right py-1.5 px-3 font-medium">Closing</th>
                    <th className="text-right py-1.5 px-3 font-medium">Counted</th>
                    <th className="text-right py-1.5 px-3 font-medium">Variance</th>
                    <th className="text-right py-1.5 px-3 font-medium">Loss ₹</th>
                  </tr>
                </thead>
                <tbody>
                  {dayRows.map((r, i) => {
                    const hasVar = r.variance != null;
                    const isLeak = hasVar && r.variance! > 0.01;
                    const isOver = hasVar && r.variance! < -0.01;
                    return (
                      <tr key={i} className={`border-t border-[#E8D5C4]/50 ${isLeak ? 'bg-red-50/20' : isOver ? 'bg-indigo-50/20' : ''}`}>
                        <td className="py-1.5 px-3 font-mono text-[10px] text-[#8B7355]">{r.material_sku || '·'}</td>
                        <td className="py-1.5 px-3">{r.material_name}</td>
                        <td className="py-1.5 px-3 text-right font-mono">{fmt2(r.opening)}</td>
                        <td className="py-1.5 px-3 text-right font-mono text-emerald-700">{fmt2(r.received)}</td>
                        <td className="py-1.5 px-3 text-right font-mono text-blue-700">{fmt2(r.consumed_recipe)}</td>
                        <td className="py-1.5 px-3 text-right font-mono text-amber-700">{fmt2(r.consumed_wastage)}</td>
                        <td className="py-1.5 px-3 text-right font-mono font-semibold text-[#2D1B0E]">{fmt2(r.closing)}</td>
                        <td className="py-1.5 px-3 text-right font-mono text-[#6B5744]">{r.counted != null ? fmt2(r.counted) : '—'}</td>
                        <td className={`py-1.5 px-3 text-right font-mono font-semibold ${isLeak ? 'text-red-700' : isOver ? 'text-indigo-700' : 'text-[#8B7355]'}`}>
                          {r.variance == null ? '—' : (r.variance >= 0 ? '+' : '') + fmt2(r.variance)}
                        </td>
                        <td className={`py-1.5 px-3 text-right font-mono font-semibold ${isLeak ? 'text-red-700' : isOver ? 'text-indigo-700' : 'text-[#8B7355]'}`}>
                          {r.loss_value == null ? '—' : (r.loss_value >= 0 ? '+' : '') + fmt(r.loss_value)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'red' | 'emerald' }) {
  const c = tone === 'red' ? 'text-red-700' : tone === 'emerald' ? 'text-emerald-700' : 'text-[#2D1B0E]';
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-lg p-3">
      <div className="text-[10px] text-[#8B7355] uppercase tracking-wide">{label}</div>
      <div className={`text-lg font-bold ${c} mt-0.5`}>{value}</div>
      {hint && <div className="text-[10px] text-[#8B7355] mt-0.5">{hint}</div>}
    </div>
  );
}
