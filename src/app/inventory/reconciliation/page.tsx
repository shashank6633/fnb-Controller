'use client';

/**
 * Sales-vs-Consumption RECONCILIATION per floor bar — THE leak catcher
 * (multi-floor bar, Phase 2). For each floor store + material it lines up:
 *
 *   EXPECTED = sold-through from `sales` (recipe exploded to materials → pegs),
 *   ACTUAL   = the floor's physical stock decrease (opening + inflow − closing),
 *              or, when auto-deduct is ON, the ledger outward sale rows,
 *   VARIANCE = actual − expected. A positive variance means more stock left the
 *              floor than sales explain — the unbilled gap / leak, flagged red.
 *
 * Source: GET /api/stores/reconciliation → floorReconciliation(). Gate is
 * server-side (admin / manager / store-manager / HOD); a 403 renders the 🔒
 * notice here. Quantities are RECIPE units; packed materials (bottles) show the
 * Cases/Bottles/pegs (CBL) breakdown beneath via pack-units fmtBreakdown, so the
 * peg math never drifts from the Liquor Store / closing pages.
 *
 * party_consumption has no floor attribution → shown separately, never folded
 * into per-floor variance.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Scale, Search, X, Loader2, AlertCircle, Download, Layers,
  IndianRupee, Store as StoreIcon, AlertTriangle, PackageX, TrendingUp,
  TrendingDown, PartyPopper, Info, ChevronDown, ChevronRight, CheckCircle2, Stethoscope,
} from 'lucide-react';
import Papa from 'papaparse';
import { fmtBreakdown, PackMeta } from '@/lib/pack-units';

/* ── Types (mirror FloorReconRow + route enrichment) ───────────────────────── */

interface FloorStore { id: string; name: string; code: string; floor_label: string; }

interface ReconRow {
  store_id: string;
  store_name: string;
  floor_label: string;
  material_id: string;
  material_name: string;
  category: string;
  unit: string;
  pack_size: number;
  case_size: number;
  purchase_unit: string;
  sku: string;
  expected_qty: number;
  actual_qty: number;
  opening_qty: number;
  inflow_qty: number;
  closing_qty: number;
  opening_counted: boolean;
  closing_counted: boolean;
  ledger_out_qty: number;
  known_non_sale_qty: number;
  variance_qty: number;
  avg_price: number;
  expected_value: number;
  actual_value: number;
  known_non_sale_value: number;
  variance_value: number;
  mode: 'physical' | 'ledger';
}

interface PartyRow {
  material_id: string;
  material_name: string;
  category: string;
  unit: string;
  pack_size?: number;
  case_size: number;
  purchase_unit: string;
  qty: number;
  value: number;
}

interface ReconResult {
  from: string;
  to: string;
  store_id: string | null;
  autodeduct: boolean;
  mode: 'physical' | 'ledger';
  rows: ReconRow[];
  summary: {
    stores: number;
    materials: number;
    total_expected_qty: number;
    total_actual_qty: number;
    total_variance_qty: number;
    total_expected_value: number;
    total_actual_value: number;
    total_variance_value: number;
    total_known_non_sale_qty: number;
    total_known_non_sale_value: number;
    unbilled_value: number;
  };
  unattributed_party: PartyRow[];
}

/* ── Helpers ───────────────────────────────────────────────────────────────── */

const fq = (v: number, dp = 2) =>
  Number((Number(v) || 0).toFixed(dp)).toLocaleString('en-IN');
const inr = (v: number, dp = 0) =>
  '₹' + (Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: dp });
const packMetaOf = (r: { unit: string; purchase_unit: string; pack_size?: number; case_size: number }): PackMeta => ({
  unit: r.unit, purchase_unit: r.purchase_unit, pack_size: r.pack_size ?? 1, case_size: r.case_size,
});
const localDate = (d: Date) => {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};
const PAGE_SIZE = 50;

/* One qty cell: raw recipe qty + CBL breakdown beneath when packed. */
function QtyCell({ qty, r, strong, tone }: {
  qty: number; r: { unit: string; purchase_unit: string; pack_size?: number; case_size: number };
  strong?: boolean; tone?: 'expected' | 'actual' | 'variance';
}) {
  const packed = (r.pack_size ?? 1) > 1 || (r.case_size ?? 1) > 1;   // incl. piece-counted cases (cb)
  const dual = packed ? fmtBreakdown(qty, packMetaOf(r)) : null;
  const zero = qty === 0;
  let color = 'text-[#2D1B0E]';
  if (tone === 'variance') color = qty > 0 ? 'text-red-700' : qty < 0 ? 'text-blue-700' : 'text-[#B9A896]';
  else if (zero) color = 'text-[#B9A896]';
  else if (qty < 0) color = 'text-red-700';
  return (
    <div className={`text-right tabular-nums ${color}`}>
      <span className={strong ? 'font-semibold' : ''}>{(tone === 'variance' && qty > 0 ? '+' : '') + fq(qty)}</span>
      {dual && <div className="text-[10px] text-[#8B7355] font-normal leading-tight">{dual}</div>}
    </div>
  );
}

/* ── Page ──────────────────────────────────────────────────────────────────── */

/* ── Floor setup health — read-only diagnostic for why variance is off ─────── */

interface FloorReadiness {
  ready: boolean;
  autodeduct: { enabled: boolean; mode: 'ledger' | 'physical'; needs: string[] };
  floor_stores: { id: string; name: string; code: string; labels: string[]; held_materials: number; has_stock: boolean; closing_counts: number; last_count_date: string | null }[];
  zones: { zone: string; tables: number; mapped: boolean; store_id: string | null; store_name: string | null }[];
  unmapped_zones: { zone: string; tables: number }[];
  orphan_labels: { store: string; label: string }[];
  recipe_coverage: { liquor_materials: number; in_recipe: number; missing_recipe: number; sample_missing: string[] };
  issues: { severity: 'error' | 'warn' | 'info'; message: string }[];
}

function FloorHealthPanel() {
  const [data, setData] = useState<FloorReadiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/stores/floor-readiness', { credentials: 'same-origin' });
        const j = await r.json();
        if (!alive) return;
        if (!r.ok) { setErr(j?.error || `HTTP ${r.status}`); return; }
        setData(j);
        if (!j.ready) setOpen(true);   // auto-expand when something needs attention
      } catch (e: any) { if (alive) setErr(e?.message || 'Failed to load'); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, []);

  const errors = data?.issues.filter(i => i.severity === 'error').length ?? 0;
  const warns = data?.issues.filter(i => i.severity === 'warn').length ?? 0;
  const tone = !data ? 'muted' : data.ready && warns === 0 ? 'ok' : errors > 0 ? 'error' : 'warn';
  const toneCls = {
    ok: 'bg-emerald-50 border-emerald-200 text-emerald-800',
    warn: 'bg-amber-50 border-amber-200 text-amber-900',
    error: 'bg-red-50 border-red-200 text-red-800',
    muted: 'bg-[#FFF8F0] border-[#E8D5C4] text-[#6B5744]',
  }[tone];

  return (
    <div className={`border rounded-lg ${toneCls}`}>
      <button onClick={() => setOpen(o => !o)} aria-expanded={open} className="w-full flex items-center gap-2 px-3 py-2.5 text-left">
        {open ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />}
        <Stethoscope className="w-4 h-4 shrink-0" />
        <span className="text-sm font-semibold">Floor setup health</span>
        {loading ? (
          <Loader2 className="w-4 h-4 animate-spin ml-1" />
        ) : err ? (
          <span className="text-xs">— {err}</span>
        ) : data ? (
          <span className="ml-1 text-xs font-medium inline-flex items-center gap-1.5">
            {data.ready && warns === 0
              ? <><CheckCircle2 className="w-3.5 h-3.5" /> Ready — pours will attribute to floors</>
              : <>{errors > 0 && <span className="inline-flex items-center gap-0.5"><AlertCircle className="w-3.5 h-3.5" /> {errors} to fix</span>}
                  {warns > 0 && <span className="inline-flex items-center gap-0.5"><AlertTriangle className="w-3.5 h-3.5" /> {warns} to review</span>}</>}
          </span>
        ) : null}
        <span className="ml-auto text-[11px] opacity-70">
          {data && `auto-deduct ${data.autodeduct.enabled ? 'ON' : 'OFF'} · ${data.autodeduct.mode} mode`}
        </span>
      </button>

      {open && data && (
        <div className="px-3 pb-3 space-y-3 text-[#2D1B0E]">
          {/* Issues */}
          {data.issues.length > 0 ? (
            <div className="space-y-1.5">
              {data.issues.map((it, i) => (
                <div key={i} className={`text-xs flex items-start gap-1.5 rounded px-2 py-1.5 border ${
                  it.severity === 'error' ? 'bg-red-50 border-red-200 text-red-700'
                  : it.severity === 'warn' ? 'bg-amber-50 border-amber-200 text-amber-800'
                  : 'bg-white border-[#E8D5C4] text-[#6B5744]'}`}>
                  {it.severity === 'error' ? <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> : <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />}
                  <span>{it.message}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-emerald-700 flex items-center gap-1.5 bg-white border border-emerald-200 rounded px-2 py-1.5">
              <CheckCircle2 className="w-3.5 h-3.5" /> Every table zone maps to a floor bar and the reconciliation has what it needs.
            </div>
          )}

          <div className="grid md:grid-cols-2 gap-3">
            {/* Zone → floor mapping */}
            <div className="bg-white rounded-lg border border-[#E8D5C4] overflow-hidden">
              <div className="px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-[#8B7355] bg-[#FFF7EF] border-b border-[#F0E4D6]">Table zone → floor bar</div>
              {data.zones.length === 0 ? (
                <div className="px-3 py-2 text-xs text-[#8B7355]">No table zones defined.</div>
              ) : (
                <table className="w-full text-xs">
                  <tbody className="divide-y divide-[#F0E4D6]">
                    {data.zones.map(z => (
                      <tr key={z.zone}>
                        <td className="px-3 py-1.5 text-[#2D1B0E]">{z.zone} <span className="text-[10px] text-[#8B7355]">· {z.tables} table{z.tables === 1 ? '' : 's'}</span></td>
                        <td className="px-3 py-1.5 text-right">
                          {z.mapped
                            ? <span className="text-emerald-700 inline-flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> {z.store_name}</span>
                            : <span className="text-red-700 inline-flex items-center gap-1"><AlertCircle className="w-3 h-3" /> unmapped</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Floor stores */}
            <div className="bg-white rounded-lg border border-[#E8D5C4] overflow-hidden">
              <div className="px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-[#8B7355] bg-[#FFF7EF] border-b border-[#F0E4D6]">Floor bars</div>
              {data.floor_stores.length === 0 ? (
                <div className="px-3 py-2 text-xs text-[#8B7355]">No floor bars — set a Floor label on Settings → Store Locations.</div>
              ) : (
                <table className="w-full text-xs">
                  <tbody className="divide-y divide-[#F0E4D6]">
                    {data.floor_stores.map(s => (
                      <tr key={s.id}>
                        <td className="px-3 py-1.5">
                          <div className="text-[#2D1B0E] font-medium">{s.name}</div>
                          <div className="text-[10px] text-[#8B7355]">label: {s.labels.join(', ') || '—'}</div>
                        </td>
                        <td className="px-3 py-1.5 text-right text-[10px] text-[#6B5744] whitespace-nowrap">
                          {s.has_stock ? `${s.held_materials} items held` : <span className="text-amber-700">no stock</span>}
                          <div>{s.closing_counts > 0 ? `${s.closing_counts} counts` : <span className="text-amber-700">no counts</span>}</div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* Recipe coverage + mode help */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[#6B5744]">
            <span>Liquor items in a recipe: <b className="text-[#2D1B0E]">{data.recipe_coverage.in_recipe}/{data.recipe_coverage.liquor_materials}</b></span>
            {data.recipe_coverage.missing_recipe > 0 && (
              <span className="text-amber-800" title={data.recipe_coverage.sample_missing.join(', ')}>
                {data.recipe_coverage.missing_recipe} not in any recipe (hover)
              </span>
            )}
            <span className="ml-auto">This {data.autodeduct.mode} mode needs: {data.autodeduct.needs.join(' · ')}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ReconciliationPage() {
  const today = useMemo(() => localDate(new Date()), []);
  const weekAgo = useMemo(() => localDate(new Date(Date.now() - 6 * 86400000)), []);

  const [from, setFrom] = useState(weekAgo);
  const [to, setTo] = useState(today);
  const [storeId, setStoreId] = useState('__overall__');   // default to the whole-outlet view

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [stores, setStores] = useState<FloorStore[]>([]);
  const [result, setResult] = useState<ReconResult | null>(null);
  const [generatedAt, setGeneratedAt] = useState('');

  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [onlyLeaks, setOnlyLeaks] = useState(false);
  const [page, setPage] = useState(1);
  const [showParty, setShowParty] = useState(false);

  // Load whenever the filters change (from/to/storeId).
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true); setError('');
      try {
        const params = new URLSearchParams();
        if (from) params.set('from', from);
        if (to) params.set('to', to);
        if (storeId) params.set('storeId', storeId);
        const res = await fetch(`/api/stores/reconciliation?${params.toString()}`, { credentials: 'same-origin' });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        if (!alive) return;
        setStores(Array.isArray(data.stores) ? data.stores : []);
        setResult(data.result || null);
        setGeneratedAt(data.generated_at || '');
      } catch (e: any) {
        if (alive) setError(e?.message || 'Failed to load');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [from, to, storeId]);

  const rows = result?.rows ?? [];

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.category) set.add(r.category);
    return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }, [rows]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter(r => {
      if (cat && r.category !== cat) return false;
      if (onlyLeaks && r.variance_qty <= 0) return false;
      if (!needle) return true;
      return r.material_name.toLowerCase().includes(needle)
        || (r.sku || '').toLowerCase().includes(needle)
        || r.store_name.toLowerCase().includes(needle);
    });
  }, [rows, q, cat, onlyLeaks]);

  useEffect(() => { setPage(1); }, [q, cat, onlyLeaks, from, to, storeId]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageSafe = Math.min(page, totalPages);
  const paged = useMemo(
    () => filtered.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE),
    [filtered, pageSafe],
  );

  // Summary over the FILTERED set.
  const summary = useMemo(() => {
    let exp = 0, act = 0, unbilled = 0, leaks = 0, known = 0;
    for (const r of filtered) {
      exp += r.expected_value;
      act += r.actual_value;
      known += r.known_non_sale_value;
      if (r.variance_qty > 0) { unbilled += r.variance_value; leaks++; }
    }
    return { exp, act, unbilled, leaks, known, items: filtered.length };
  }, [filtered]);

  const mode = result?.mode ?? 'physical';

  const exportCsv = () => {
    const header = [
      'Floor', 'Material', 'SKU', 'Category', 'Unit',
      'Expected Qty', 'Actual Qty',
      ...(mode === 'physical'
        ? ['Opening', 'Inflow', 'Closing', 'Known Loss (breakage/spillage)', 'Opening Counted', 'Closing Counted']
        : ['Ledger Outward']),
      'Variance Qty', 'Avg ₹/unit', 'Expected ₹', 'Actual ₹', 'Variance ₹', 'Unbilled Gap ₹',
    ];
    const body = filtered.map(r => [
      r.store_name, r.material_name, r.sku || '', r.category || '', r.unit || '',
      Number(r.expected_qty), Number(r.actual_qty),
      ...(mode === 'physical'
        ? [Number(r.opening_qty), Number(r.inflow_qty), Number(r.closing_qty), Number(r.known_non_sale_qty),
           r.opening_counted ? 'yes' : 'no (system)', r.closing_counted ? 'yes' : 'no (system)']
        : [Number(r.ledger_out_qty)]),
      Number(r.variance_qty), Number(r.avg_price),
      Number(r.expected_value), Number(r.actual_value), Number(r.variance_value),
      r.variance_qty > 0 ? Number(r.variance_value) : 0,
    ]);
    const csv = Papa.unparse([header, ...body]);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reconciliation-${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /* ── Render ────────────────────────────────────────────────────────────── */

  if (error) {
    const denied = /limited to|authoriz|not authorized/i.test(error);
    return (
      <div className="p-6 max-w-3xl mx-auto space-y-3">
        <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
          <Scale className="w-6 h-6 text-[#af4408]" /> Sales vs Consumption
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
            <Scale className="w-6 h-6 text-[#af4408]" /> Sales vs Consumption
          </h1>
          <p className="text-xs text-[#6B5744] mt-0.5">
            {storeId === '__overall__'
              ? 'Whole outlet: total liquor poured from all sales (Expected) versus total stock that actually left across every store (Actual). Inter-store transfers net out. A positive variance is stock unaccounted for by sales — the unbilled gap.'
              : 'Per floor bar: what sales should have poured (Expected) versus what actually left the floor (Actual). A positive variance is stock unaccounted for by sales — the unbilled gap.'}
            {generatedAt && <span className="text-[#B9A896]"> · as of {new Date(generatedAt).toLocaleString('en-IN')}</span>}
          </p>
        </div>
        <button onClick={exportCsv} disabled={filtered.length === 0}
                className="px-3 py-2 bg-white border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 disabled:opacity-40 rounded-lg text-sm font-medium flex items-center gap-1.5">
          <Download className="w-4 h-4" /> Export CSV
        </button>
      </div>

      {/* Setup health — surfaces why floor variance might be wrong/missing. */}
      <FloorHealthPanel />

      {/* Filters: floor + date range */}
      <div className="flex flex-wrap items-end gap-2 bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3">
        <label className="flex flex-col gap-1 text-xs text-[#6B5744] font-medium">
          Floor bar
          <select value={storeId} onChange={e => setStoreId(e.target.value)}
                  className="px-2.5 py-2 border border-[#E8D5C4] rounded-lg text-sm bg-white text-[#2D1B0E] min-w-[180px]">
            <option value="__overall__">🌐 Overall (whole outlet)</option>
            <option value="">All floors (per floor)</option>
            {stores.map(s => <option key={s.id} value={s.id}>{s.name}{s.floor_label ? ` (${s.floor_label})` : ''}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-[#6B5744] font-medium">
          From
          <input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)}
                 className="px-2.5 py-2 border border-[#E8D5C4] rounded-lg text-sm bg-white text-[#2D1B0E]" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[#6B5744] font-medium">
          To
          <input type="date" value={to} min={from} max={today} onChange={e => setTo(e.target.value)}
                 className="px-2.5 py-2 border border-[#E8D5C4] rounded-lg text-sm bg-white text-[#2D1B0E]" />
        </label>
        <div className="flex-1" />
        {result && (
          <div className={`text-xs px-2.5 py-1.5 rounded-lg border flex items-center gap-1.5 ${
            mode === 'ledger'
              ? 'bg-[#EAF4EC] border-green-200 text-green-800'
              : 'bg-[#FFF1E3] border-[#E8D5C4] text-[#6B5744]'}`}>
            <Info className="w-3.5 h-3.5 shrink-0" />
            {mode === 'ledger'
              ? 'Auto-deduct ON — Actual = floor ledger outward'
              : 'Auto-deduct OFF — Actual = opening + inflow − closing (physical count)'}
          </div>
        )}
      </div>

      {loading ? (
        <div className="p-6 text-sm text-[#6B5744]">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading reconciliation…
        </div>
      ) : !result ? (
        <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-8 text-center text-sm text-[#8B7355]">
          Pick a date range to run the reconciliation.
        </div>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2.5">
            <SummaryCard icon={<TrendingUp className="w-4 h-4" />} label="Expected value" value={inr(summary.exp)} />
            <SummaryCard icon={<IndianRupee className="w-4 h-4" />} label="Actual value" value={inr(summary.act)} />
            <SummaryCard
              icon={<AlertTriangle className="w-4 h-4" />}
              label="Unbilled gap"
              value={inr(summary.unbilled)}
              tone={summary.unbilled > 0 ? 'warn' : 'muted'}
            />
            <SummaryCard icon={<TrendingDown className="w-4 h-4" />} label="Leak rows"
                         value={summary.leaks.toLocaleString('en-IN')}
                         tone={summary.leaks > 0 ? 'warn' : 'muted'} />
            {mode === 'physical'
              ? <SummaryCard icon={<PackageX className="w-4 h-4" />} label="Known loss" value={inr(summary.known)} />
              : <SummaryCard icon={<StoreIcon className="w-4 h-4" />} label="Floors" value={String(result.summary.stores)} />}
            <SummaryCard icon={<Layers className="w-4 h-4" />} label="Materials" value={summary.items.toLocaleString('en-IN')} />
          </div>

          {/* Search + category + leaks-only */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[180px] max-w-md">
              <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8B7355]" />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search material, SKU or floor…"
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
            <label className="flex items-center gap-1.5 text-xs text-[#6B5744] font-medium px-2.5 py-2 border border-[#E8D5C4] rounded-lg bg-white cursor-pointer">
              <input type="checkbox" checked={onlyLeaks} onChange={e => setOnlyLeaks(e.target.checked)} className="accent-[#af4408]" />
              Leaks only
            </label>
            {(q || cat || onlyLeaks) && (
              <button onClick={() => { setQ(''); setCat(''); setOnlyLeaks(false); }}
                      className="text-xs text-[#af4408] hover:underline">Reset</button>
            )}
          </div>

          {/* Empty */}
          {filtered.length === 0 ? (
            <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-8 text-center text-sm text-[#8B7355]">
              <PackageX className="w-6 h-6 mx-auto mb-2 text-[#B9A896]" />
              {rows.length === 0
                ? (storeId === '__overall__'
                    ? 'No liquor sales or stock movement in this period. Ring drinks up on POS (with recipes) and take opening + closing counts to see consumption vs stock.'
                    : 'No floor-attributed sales or movement in this period. Map each floor bar’s zone (Settings → Stores) so sales attribute to a floor.')
                : 'No rows match your filters.'}
            </div>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden sm:block overflow-x-auto border border-[#E8D5C4] rounded-lg bg-white">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="bg-[#FFF1E3] text-[#6B5744] text-xs">
                      <th className="text-left font-semibold px-3 py-2 sticky left-0 bg-[#FFF1E3] z-10 min-w-[190px]">Material</th>
                      <th className="text-left font-semibold px-3 py-2 min-w-[120px]">Floor</th>
                      <th className="text-right font-semibold px-3 py-2 min-w-[100px] whitespace-nowrap">Expected</th>
                      <th className="text-right font-semibold px-3 py-2 min-w-[100px] whitespace-nowrap">Actual</th>
                      <th className="text-right font-semibold px-3 py-2 min-w-[100px] whitespace-nowrap bg-[#FBE7D3]">Variance</th>
                      <th className="text-right font-semibold px-3 py-2 min-w-[100px] whitespace-nowrap bg-[#FBE7D3]">Variance ₹</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paged.map(r => {
                      const leak = r.variance_qty > 0;
                      return (
                        <tr key={`${r.store_id}:${r.material_id}`}
                            className={`border-t border-[#F0E4D6] hover:bg-[#FFF8F0] ${leak ? 'bg-red-50/40' : ''}`}>
                          <td className="px-3 py-2 sticky left-0 bg-white z-10">
                            <div className="font-medium text-[#2D1B0E] leading-tight">{r.material_name}</div>
                            <div className="text-[10px] text-[#B9A896]">
                              {r.category}{r.sku ? ` · ${r.sku}` : ''}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-[#6B5744] text-xs">
                            {r.store_name}
                            {mode === 'physical' && (
                              <div className="text-[10px] text-[#B9A896] leading-tight">
                                open {fq(r.opening_qty)}{!r.opening_counted && '*'} + in {fq(r.inflow_qty)} − close {fq(r.closing_qty)}{!r.closing_counted && '*'}{r.known_non_sale_qty > 0 && ` − loss ${fq(r.known_non_sale_qty)}`}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2"><QtyCell qty={r.expected_qty} r={r} tone="expected" /></td>
                          <td className="px-3 py-2"><QtyCell qty={r.actual_qty} r={r} tone="actual" /></td>
                          <td className="px-3 py-2 bg-[#FEF6EE]"><QtyCell qty={r.variance_qty} r={r} strong tone="variance" /></td>
                          <td className={`px-3 py-2 bg-[#FEF6EE] text-right tabular-nums font-medium ${leak ? 'text-red-700' : r.variance_value < 0 ? 'text-blue-700' : 'text-[#B9A896]'}`}>
                            {leak ? inr(r.variance_value) : r.variance_value === 0 ? '—' : inr(r.variance_value)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-[#E8D5C4] bg-[#FFF1E3] font-semibold text-[#2D1B0E]">
                      <td className="px-3 py-2 sticky left-0 bg-[#FFF1E3] z-10">Page total</td>
                      <td className="px-3 py-2" />
                      <td className="px-3 py-2 text-right tabular-nums text-xs text-[#6B5744]">{inr(paged.reduce((a, r) => a + r.expected_value, 0))}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-xs text-[#6B5744]">{inr(paged.reduce((a, r) => a + r.actual_value, 0))}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-xs bg-[#FBE7D3]">{inr(paged.reduce((a, r) => a + r.variance_value, 0))}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-xs bg-[#FBE7D3]">{inr(paged.reduce((a, r) => a + (r.variance_qty > 0 ? r.variance_value : 0), 0))}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Mobile cards */}
              <div className="sm:hidden space-y-2.5">
                {paged.map(r => {
                  const leak = r.variance_qty > 0;
                  return (
                    <div key={`${r.store_id}:${r.material_id}`}
                         className={`border rounded-lg bg-white p-3 ${leak ? 'border-red-200' : 'border-[#E8D5C4]'}`}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-semibold text-[#2D1B0E] leading-tight">{r.material_name}</div>
                          <div className="text-[11px] text-[#8B7355]">{r.store_name}{r.sku ? ` · ${r.sku}` : ''}</div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-[10px] text-[#8B7355] uppercase tracking-wide">Variance</div>
                          <QtyCell qty={r.variance_qty} r={r} strong tone="variance" />
                          <div className={`text-[11px] font-medium ${leak ? 'text-red-700' : r.variance_value < 0 ? 'text-blue-700' : 'text-[#B9A896]'}`}>
                            {r.variance_value === 0 ? '—' : inr(r.variance_value)}
                          </div>
                        </div>
                      </div>
                      <div className="mt-2 pt-2 border-t border-[#F0E4D6] grid grid-cols-2 gap-x-3 gap-y-1">
                        <div className="flex items-center justify-between gap-2 text-xs min-w-0">
                          <span className="text-[#8B7355] font-medium">Expected</span>
                          <QtyCell qty={r.expected_qty} r={r} />
                        </div>
                        <div className="flex items-center justify-between gap-2 text-xs min-w-0">
                          <span className="text-[#8B7355] font-medium">Actual</span>
                          <QtyCell qty={r.actual_qty} r={r} />
                        </div>
                      </div>
                      {mode === 'physical' && (
                        <div className="mt-1 text-[10px] text-[#B9A896]">
                          open {fq(r.opening_qty)}{!r.opening_counted && '*'} + in {fq(r.inflow_qty)} − close {fq(r.closing_qty)}{!r.closing_counted && '*'}{r.known_non_sale_qty > 0 && ` − loss ${fq(r.known_non_sale_qty)}`}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {mode === 'physical' && (
                <p className="text-[11px] text-[#B9A896]">* opening/closing fell back to the ledger system quantity (no physical count on that boundary) — treat Actual as indicative until counted.</p>
              )}

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

          {/* Unattributed party liquor — no floor attribution, never in variance */}
          {result.unattributed_party.length > 0 && (
            <div className="border border-[#E8D5C4] rounded-lg bg-white">
              <button onClick={() => setShowParty(s => !s)}
                      className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left">
                <span className="flex items-center gap-2 text-sm font-medium text-[#2D1B0E]">
                  <PartyPopper className="w-4 h-4 text-[#af4408]" /> Party liquor draw (no floor attribution)
                </span>
                <span className="text-xs text-[#8B7355]">
                  {result.unattributed_party.length} items · {inr(result.unattributed_party.reduce((a, p) => a + p.value, 0))}
                  <span className="ml-1">{showParty ? '▲' : '▼'}</span>
                </span>
              </button>
              {showParty && (
                <div className="border-t border-[#F0E4D6] px-3 py-2">
                  <p className="text-[11px] text-[#8B7355] mb-2">
                    party_consumption is a P&L register with no zone/floor, so it is shown here separately and is NOT folded into any floor variance.
                  </p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                      <thead>
                        <tr className="text-[#6B5744] text-xs">
                          <th className="text-left font-semibold px-2 py-1.5">Material</th>
                          <th className="text-left font-semibold px-2 py-1.5">Category</th>
                          <th className="text-right font-semibold px-2 py-1.5">Qty</th>
                          <th className="text-right font-semibold px-2 py-1.5">Value</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.unattributed_party.map(p => (
                          <tr key={p.material_id} className="border-t border-[#F0E4D6]">
                            <td className="px-2 py-1.5 text-[#2D1B0E]">{p.material_name}</td>
                            <td className="px-2 py-1.5 text-[#6B5744] text-xs">{p.category}</td>
                            <td className="px-2 py-1.5"><QtyCell qty={p.qty} r={p} /></td>
                            <td className="px-2 py-1.5 text-right tabular-nums text-[#2D1B0E]">{inr(p.value)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ── Summary card ──────────────────────────────────────────────────────────── */

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
