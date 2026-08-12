'use client';

/**
 * Daily Closing Roll-up — Phase 1 §6 report.
 * Opening · Received · Consumed (Recipe + Wastage) · Closing · Counted · Variance
 * per material per day. Useful for the EOD close routine.
 */

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarClock, Download, Filter, Loader2 } from 'lucide-react';
import { packFactor, toPurchaseQty, fmtQtyNum, csvQty, type PackMeta } from '@/lib/pack-units';

const fmt  = (v: number) => '₹' + Math.round(v || 0).toLocaleString('en-IN');
const today = () => new Date().toISOString().slice(0,10);
const minusDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0,10); };

/**
 * ONE quantity cell for this report — every one of the seven columns goes
 * through it, so no cell can revert to grams while its siblings read bottles.
 *
 * /api/daily-rollup ships every quantity in RECIPE units and says so in its own
 * comments ("Opening in RECIPE units: scale purchases-before by the factor").
 * The owner rule for Inventory surfaces is that the PURCHASE unit LEADS, with
 * the recipe figure kept only as the small declared hint — otherwise KAHLUA
 * LIQUEUR (750 ML) prints a closing of "6,630", which reads as 6,630 bottles
 * against a real 8.84 BTL.
 *
 * Conversion is the shared pack layer only (packFactor's two-half guard), never
 * re-derived here: PICKLED GINGER 1.5KG is kg/kg with pack_size 1.5, so it must
 * keep printing 6 kg, not "4 kg".
 */
function Qty({ v, m, signed }: { v: number | null | undefined; m: PackMeta; signed?: boolean }) {
  if (v == null) return <>—</>;
  const pf = packFactor(m);
  const pq = toPurchaseQty(v, m);
  const pu = String(m.purchase_unit || m.unit || '').trim();
  // The sign must come from the STORED value, never from the rounded purchase
  // figure. A -0.3 ml variance divides to -0.0004 BTL, which rounds to NEGATIVE
  // ZERO — and (-0 >= 0) is true in JS, so keying the sign off pq printed
  // "+0 BTL" directly above a hint reading "= -0.3 ml", on a row the page had
  // already tinted as a loss.
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  const show = (n: number) => (signed ? `${sign}${fmtQtyNum(Math.abs(n))}` : fmtQtyNum(n === 0 ? 0 : n));
  return (
    <>
      <span className="whitespace-nowrap">{show(pq)} <span className="text-[10px] font-normal text-[#8B7355]">{pu}</span></span>
      {pf > 1 && (
        // Declared recipe HINT (house style) — the purchase lead is on the line above.
        <div className="text-[9px] text-[#B8A590] font-normal whitespace-nowrap">= {show(v)} {m.unit}</div>
      )}
    </>
  );
}

interface RollupRow {
  date: string; material_id: string; material_name: string; material_sku?: string;
  unit: string; pack_size?: number; purchase_unit?: string; average_price: number;
  opening: number; received: number;
  consumed_recipe: number; consumed_wastage: number; consumed: number;
  closing: number; counted: number | null; variance: number | null; loss_value: number | null;
  /** Which opening this material's running balance came from. Present ONLY once
   *  a cutover is committed: 'cutover' = seeded from the counted figure,
   *  'all_time' = the material was never counted, so its Opening still carries
   *  pre-cutover drift and its Variance is not comparable with the rest. */
  basis?: 'cutover' | 'all_time';
}

export default function DailyRollupPage() {
  // `cutover` is present ONLY once a central-store cutover has been committed;
  // the API omits the key entirely until then.
  const [data, setData] = useState<{
    rows: RollupRow[]; summary: any; range: any;
    cutover?: {
      date: string;
      /** The earliest reportable day — the day AFTER the count, because the
       *  counted figure is the cutover day's closing position. Quote this as
       *  the floor, never `date`. Optional so a payload from an older build
       *  still renders (the date inputs then fall back to `date`). */
      first_day?: string;
      requested_from: string;
      materials_opened_from_count?: number;
      note: string;
    };
  } | null>(null);
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
    // The original 13 columns are UNCHANGED (still recipe-basis, still labelled by
    // the `unit` column) so any existing sheet keeps working. The purchase-basis
    // mirror of the seven quantity columns is APPENDED, matching what the screen
    // now leads with — a sheet that read "6,630" for KAHLUA is otherwise as
    // misleading on paper as it was on screen.
    const head = ['date','sku','material','unit','opening','received','consumed_recipe','consumed_wastage','consumed','closing','counted','variance','loss_value'];
    const QCOLS = ['opening','received','consumed_recipe','consumed_wastage','consumed','closing','counted','variance'] as const;
    const puHead = ['purchase_unit','pack_factor', ...QCOLS.map(k => `${k}_purchase`)];
    // The floor must travel with the file — a sheet that silently omits every
    // pre-cutover day reads as "nothing happened then". One quoted preamble
    // line, and ONLY when a cutover is stamped; otherwise the CSV is
    // byte-identical to before.
    const lines = data?.cutover
      ? ['"' + String(data.cutover.note).replace(/"/g, '""') + '"', [...head, ...puHead].join(',')]
      : [[...head, ...puHead].join(',')];
    for (const r of rows) {
      const cells = head.map(k => {
        const map: any = { sku: 'material_sku', material: 'material_name' };
        const v = (r as any)[map[k] ?? k];
        if (v == null) return '';
        const s = String(v).replace(/"/g, '""');
        return s.includes(',') ? `"${s}"` : s;
      });
      const pu = String(r.purchase_unit || r.unit || '').replace(/"/g, '""');
      cells.push(pu.includes(',') ? `"${pu}"` : pu);
      cells.push(String(packFactor(r)));
      // Convert each stored recipe figure once, through the shared helper; never
      // sum these across materials (BTL + kg has no meaning).
      for (const k of QCOLS) {
        const v = (r as any)[k];
        cells.push(v == null ? '' : String(csvQty(toPurchaseQty(v, r))));
      }
      lines.push(cells.join(','));
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
            {' '}Every quantity below reads in the material&apos;s <strong>purchase unit</strong> (kg · L · BTL · CASE); the small grey line under each figure is the same quantity in recipe units.
          </p>
        </div>
        <button onClick={exportCsv} disabled={rows.length === 0}
                className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] rounded-lg text-sm flex items-center gap-2 disabled:opacity-50">
          <Download className="w-4 h-4" /> Export CSV
        </button>
      </div>

      {/* Cutover floor. Rendered ONLY when a cutover has been committed — the
          API omits `cutover` entirely otherwise, so this block disappears and
          the page is unchanged. The wording comes from the payload so the
          screen can never drift from the clamp that produced the rows. */}
      {data?.cutover && (
        <div className="bg-amber-50 border border-amber-300 rounded-xl p-3 text-xs text-amber-900 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <p className="leading-relaxed">{data.cutover.note}</p>
        </div>
      )}

      {/* Filters */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 flex flex-wrap items-end gap-2 text-xs">
        <div className="inline-flex items-center gap-1 text-[#6B5744]"><Filter className="w-3.5 h-3.5" /> Filter</div>
        <label className="flex flex-col text-[#6B5744]">From
          <input type="date" value={from} min={data?.cutover?.first_day || data?.cutover?.date || undefined}
                 onChange={e => setFrom(e.target.value)}
                 className="px-2 py-1 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
        </label>
        <label className="flex flex-col text-[#6B5744]">To
          <input type="date" value={to} min={data?.cutover?.first_day || data?.cutover?.date || undefined}
                 onChange={e => setTo(e.target.value)}
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
                    <th className="text-left  py-1.5 px-3 font-medium" title="The unit every quantity column below is printed in (the material's purchase unit), and the recipe unit it converts from">Unit</th>
                    {/* All seven quantity columns lead in the material's PURCHASE unit
                        (kg / L / BTL / CASE); the small grey "= …" line under each is
                        the recipe figure the API actually ships. State the basis here
                        so nobody has to infer it from the numbers. */}
                    <th className="text-right py-1.5 px-3 font-medium" title="Stock at start of day — in the material's purchase unit (kg, L, BTL, CASE)">Opening <span className="block font-normal text-[9px] text-[#B8A590]">(purchase units)</span></th>
                    <th className="text-right py-1.5 px-3 font-medium" title="Purchases received on the day — in the material's purchase unit (kg, L, BTL, CASE)">Received <span className="block font-normal text-[9px] text-[#B8A590]">(purchase units)</span></th>
                    <th className="text-right py-1.5 px-3 font-medium" title="Sales · Parties · Staff meals — in the material's purchase unit (kg, L, BTL, CASE)">Recipe <span className="block font-normal text-[9px] text-[#B8A590]">(purchase units)</span></th>
                    <th className="text-right py-1.5 px-3 font-medium" title="Spoilage / Expiry / Damage / etc. — in the material's purchase unit (kg, L, BTL, CASE)">Wastage <span className="block font-normal text-[9px] text-[#B8A590]">(purchase units)</span></th>
                    <th className="text-right py-1.5 px-3 font-medium" title="Opening + Received − Recipe − Wastage — in the material's purchase unit (kg, L, BTL, CASE)">Closing <span className="block font-normal text-[9px] text-[#B8A590]">(purchase units)</span></th>
                    <th className="text-right py-1.5 px-3 font-medium" title="Physical count recorded for the day — in the material's purchase unit (kg, L, BTL, CASE)">Counted <span className="block font-normal text-[9px] text-[#B8A590]">(purchase units)</span></th>
                    <th className="text-right py-1.5 px-3 font-medium" title="Closing − Counted, positive = leakage — in the material's purchase unit (kg, L, BTL, CASE)">Variance <span className="block font-normal text-[9px] text-[#B8A590]">(purchase units)</span></th>
                    <th className="text-right py-1.5 px-3 font-medium" title="Variance valued at the material's average cost">Loss ₹</th>
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
                        <td className="py-1.5 px-3">
                          {r.material_name}
                          {/* Only ever rendered after a cutover: the API omits
                              `basis` entirely until one is committed. A row on
                              the old opening sitting silently beside re-based
                              rows is the whole reason the cutover looked like
                              it had done nothing. */}
                          {r.basis === 'all_time' && (
                            <span className="ml-1.5 text-[9px] px-1 py-0.5 rounded border bg-amber-50 border-amber-200 text-amber-900 whitespace-nowrap"
                                  title="This material was not counted in the cutover, so its Opening is still derived from all-time history and carries pre-cutover drift.">
                              all-time opening
                            </span>
                          )}
                        </td>
                        <td className="py-1.5 px-3 text-[10px] text-[#6B5744] whitespace-nowrap">
                          {r.purchase_unit || r.unit}
                          {/* State the pack rule outright when the two bases differ, so the
                              "= …" hint under every figure is self-explanatory. */}
                          {packFactor(r) > 1 && <div className="text-[9px] text-[#B8A590]">1 {r.purchase_unit} = {fmtQtyNum(packFactor(r))} {r.unit}</div>}
                        </td>
                        <td className="py-1.5 px-3 text-right font-mono"><Qty v={r.opening} m={r} /></td>
                        <td className="py-1.5 px-3 text-right font-mono text-emerald-700"><Qty v={r.received} m={r} /></td>
                        <td className="py-1.5 px-3 text-right font-mono text-blue-700"><Qty v={r.consumed_recipe} m={r} /></td>
                        <td className="py-1.5 px-3 text-right font-mono text-amber-700"><Qty v={r.consumed_wastage} m={r} /></td>
                        <td className="py-1.5 px-3 text-right font-mono font-semibold text-[#2D1B0E]"><Qty v={r.closing} m={r} /></td>
                        <td className="py-1.5 px-3 text-right font-mono text-[#6B5744]"><Qty v={r.counted} m={r} /></td>
                        <td className={`py-1.5 px-3 text-right font-mono font-semibold ${isLeak ? 'text-red-700' : isOver ? 'text-indigo-700' : 'text-[#8B7355]'}`}>
                          <Qty v={r.variance} m={r} signed />
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
