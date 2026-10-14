'use client';

/**
 * LIQUOR BRAND MAP (TGBCL) — phase L1 of the Liquor Purchase Reconciliation
 * (docs/liquor-reconciliation-plan.md).
 *
 * WHAT THIS SCREEN IS FOR. TGBCL prices a brand BY THE CASE, under a brand code
 * and a pack letter — 9740-PP and 9740-NN are the same whisky in two bottle
 * sizes, at two different case rates. Nothing in this app knew that. This page
 * is where a material is told which TGBCL code(s) it is, so three things
 * become possible:
 *   · RATE MOVEMENT — an indent that arrives at a rate the master does not hold
 *     is visible (red) instead of quietly becoming the new normal.
 *   · LANDED COST — the master rate per bottle plus that line's share of the
 *     recorded TGBCL levies. Phases L3/L4/L5 read it.
 *   · THE BEER / SPIRIT SPLIT — product_type drives Summary §C and the §D
 *     uplift factors.
 *
 * ONE MATERIAL MAY HOLD SEVERAL ROWS. The key is (brand code, pack), never the
 * material, so the list groups by material and shows every pack under it.
 *
 * THIS PAGE CHANGES NO VALUATION, AND SAYS SO ON SCREEN. Plan decision 1(a):
 * the TGBCL levies stay recorded-only, and landed cost is an analytics figure
 * that lives inside this module. Nothing here writes average_price,
 * last_purchase_price or a ledger unit_cost — pour costs, recipe costs and
 * every variance value hang off those.
 *
 * "ACCEPT NEW RATE" IS A REAL WRITE AND IT IS AUDITED. It replaces the master
 * rate the brand is compared against from then on, so the confirmation says
 * what it is replacing, and the server re-reads the line rather than trusting
 * the number this page is holding.
 *
 * ADMIN ONLY — in page-catalog AND server-side on every route
 * (src/app/api/liquor/brand-map/_lib/guard.ts). The proxy gates PAGES, not
 * APIs, so the lock panel below is a courtesy, never the boundary.
 *
 * API CONTRACT
 *   GET    /api/liquor/brand-map[?q=&include_inactive=1]      list + pickables
 *   POST   /api/liquor/brand-map                              create
 *   PUT    /api/liquor/brand-map                              update
 *   DELETE /api/liquor/brand-map?id=                          remove
 *   POST   /api/liquor/brand-map/import[?commit=1]            CSV preview/commit
 *   GET    /api/liquor/brand-map/variance?store_id=&from=&to= rate movement
 *   POST   /api/liquor/brand-map/variance                     accept a rate
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import Toggle from '@/components/Toggle';
import MaterialTypeahead, { type MaterialLite } from '@/components/MaterialTypeahead';
import {
  Link2, Wine, Loader2, RefreshCw, AlertTriangle, CheckCircle2, Info, Lock,
  Plus, Save, Search, Trash2, Upload, TrendingUp, X, FileDown, ArrowRight,
} from 'lucide-react';

/* ── Types (mirror the routes) ────────────────────────────────────────────── */

interface MapRow {
  id: string;
  material_id: string;
  material_name: string;
  material_sku: string | null;
  material_category: string | null;
  material_purchase_unit: string | null;
  tgbcl_brand_code: string;
  size_code: string;
  size_ml: number;
  bottles_per_case: number;
  rate_per_case_master: number;
  rate_per_bottle_master: number;
  product_type: string;
  is_active: number;
  note: string;
  updated_at: string;
}

interface Payload {
  ok?: boolean;
  rows?: MapRow[];
  materials?: MaterialLite[];
  product_types?: string[];
  csv_header?: string;
  counts?: { total: number; active: number; materials_mapped: number; materials_available: number };
  error?: string;
}

interface VarianceRow {
  ledgerId: string;
  storeId: string;
  invoiceRef: string;
  inwardDate: string;
  supplier: string;
  materialId: string;
  materialName: string;
  bottles: number;
  indentRate: number;
  masterRate: number | null;
  variance: number | null;
  varianceValue: number | null;
  landedPerBottle: number | null;
  leviesPerBottle: number;
  brandMapId: string;
  tgbclBrandCode: string;
  sizeCode: string;
  proposedRatePerCase: number | null;
  /** Mirrors LqMapReason in src/lib/liquor-recon.ts — keep the two in step. */
  mapReason: 'ok' | 'not_mapped' | 'ambiguous_pack' | 'pack_not_mapped' | 'no_master_rate';
}

interface VariancePayload {
  ok?: boolean;
  stores?: Array<{ id: string; name: string; code: string }>;
  rows?: VarianceRow[];
  summary?: { lines: number; moved: number; unmapped: number; moved_value: number };
  error?: string;
}

interface ImportIssue { line: number; message: string }
interface ImportPreview {
  ok?: boolean;
  total_rows?: number;
  valid?: number;
  creates?: number;
  updates?: number;
  unchanged?: number;
  errors?: ImportIssue[];
  warnings?: Array<{ line?: number; message: string }>;
  rate_changes?: Array<{ line: number; material: string; code: string; size_code: string; from: number | null; to: number }>;
  rate_changes_total?: number;
  /** A pack whose (code, size) is already mapped to a DIFFERENT material: the
   *  import moves it, and the old material loses its landed cost. Shown on its
   *  own, because "1 update" does not say which material lost its mapping. */
  material_changes?: MaterialMove[];
  material_changes_total?: number;
  error?: string;
  expected_header?: string;
}
interface MaterialMove {
  line: number; code: string; size_code: string;
  from_material: string | null; to_material: string;
}
interface ImportResult {
  ok?: boolean;
  created?: number;
  updated?: number;
  unchanged?: number;
  skipped?: ImportIssue[];
  rate_changes_total?: number;
  material_changes?: MaterialMove[];
  material_changes_total?: number;
  error?: string;
}

/* ── Formatters ───────────────────────────────────────────────────────────── */

const nf = (n: number) => Number(n || 0).toLocaleString('en-IN');
/** ₹ with 2dp — money, never a quantity. */
const money = (n: number) =>
  '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** ₹ with up to 4dp — a per-bottle rate divided out of a case rate. */
const money4 = (n: number) =>
  '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const signedMoney4 = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '') + money4(Math.abs(n));

/** A rate has moved when it has moved by at least a paisa per bottle — the
 *  SAME test the variance route and L5 §G apply (see the long comment on
 *  hasMoved in src/app/api/liquor/brand-map/variance/route.ts). At 1e-6 an
 *  accepted rate could not always clear its own red row, because the master
 *  stores ₹/case at 2dp and the watch reads it back as ₹/bottle. */
const hasMoved = (v: number | null): boolean =>
  v !== null && Math.round((Number(v) || 0) * 100) !== 0;

/** What a blank master rate means, in the operator's words rather than the
 *  wire token. Mirrors LqMapReason. */
const MAP_REASON_LABEL: Record<string, string> = {
  ambiguous_pack: 'which pack?',
  pack_not_mapped: 'pack not mapped',
  no_master_rate: 'no master rate',
  not_mapped: 'not mapped',
};

const emptyDraft = () => ({
  id: '',
  material_id: '',
  tgbcl_brand_code: '',
  size_code: '',
  size_ml: '',
  bottles_per_case: '',
  rate_per_case_master: '',
  product_type: 'IML',
  is_active: 1,
  note: '',
});
type Draft = ReturnType<typeof emptyDraft>;

function TypeChip({ t }: { t: string }) {
  const cls = t === 'BEER'
    ? 'bg-amber-50 text-amber-800 border-amber-200'
    : t === 'Duty Paid'
      ? 'bg-sky-50 text-sky-800 border-sky-200'
      : 'bg-violet-50 text-violet-800 border-violet-200';
  return <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold border ${cls}`}>{t}</span>;
}

export default function LiquorBrandMapPage() {
  const [tab, setTab] = useState<'map' | 'movement' | 'import'>('map');
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [data, setData] = useState<Payload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const flash = useCallback((ok: boolean, text: string) => {
    setMsg({ ok, text });
    window.setTimeout(() => setMsg(null), 6000);
  }, []);

  const load = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true); else setLoading(true);
    setLoadError(null);
    try {
      const p = new URLSearchParams();
      if (includeInactive) p.set('include_inactive', '1');
      const res = await api(`/api/liquor/brand-map?${p.toString()}`);
      if (res.status === 403) { setForbidden(true); return; }
      const j = (await res.json().catch(() => ({}))) as Payload;
      if (!res.ok) { setLoadError(j?.error || `Could not load (HTTP ${res.status}).`); return; }
      setData(j);
    } catch {
      setLoadError('Network error — nothing was loaded.');
    } finally { setLoading(false); setRefreshing(false); }
  }, [includeInactive]);

  useEffect(() => { load(); }, [load]);

  /* ── Editor ─────────────────────────────────────────────────────────────── */
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  const saveDraft = useCallback(async () => {
    if (!draft || saving) return;
    setSaving(true);
    try {
      const body = {
        id: draft.id || undefined,
        material_id: draft.material_id,
        tgbcl_brand_code: draft.tgbcl_brand_code,
        size_code: draft.size_code,
        size_ml: Number(draft.size_ml || 0),
        bottles_per_case: Number(draft.bottles_per_case),
        rate_per_case_master: Number(draft.rate_per_case_master || 0),
        product_type: draft.product_type,
        is_active: draft.is_active,
        note: draft.note,
      };
      const res = await api('/api/liquor/brand-map', { method: draft.id ? 'PUT' : 'POST', body });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) { flash(false, j?.error || `Could not save (HTTP ${res.status}).`); return; }
      flash(true, draft.id ? 'Mapping updated.' : 'Mapping added.');
      setDraft(null);
      load(true);
    } catch {
      flash(false, 'Network error — nothing was saved.');
    } finally { setSaving(false); }
  }, [draft, saving, flash, load]);

  const removeRow = useCallback(async (row: MapRow) => {
    const label = `${row.tgbcl_brand_code}${row.size_code ? '-' + row.size_code : ''}`;
    if (!window.confirm(
      `Remove the mapping ${label} → ${row.material_name}?\n\n`
      + 'Landed cost and rate variance for this pack stop being available until it is mapped again. '
      + 'No stock, price or purchase record is touched.',
    )) return;
    try {
      const res = await api(`/api/liquor/brand-map?id=${encodeURIComponent(row.id)}`, { method: 'DELETE' });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) { flash(false, j?.error || `Could not remove (HTTP ${res.status}).`); return; }
      flash(true, `${label} removed.`);
      load(true);
    } catch { flash(false, 'Network error — nothing was removed.'); }
  }, [flash, load]);

  // Memoised so the `filtered` memo below is not invalidated on every render by
  // a fresh [] from the `||` (react-hooks/exhaustive-deps).
  const rows = useMemo<MapRow[]>(() => data?.rows || [], [data]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r =>
      r.material_name.toLowerCase().includes(q)
      || String(r.material_sku || '').toLowerCase().includes(q)
      || r.tgbcl_brand_code.toLowerCase().includes(q)
      || r.size_code.toLowerCase().includes(q));
  }, [rows, search]);

  /** Grouped by material so a brand's packs sit together (9740-PP beside -NN). */
  const grouped = useMemo(() => {
    const g = new Map<string, { material_id: string; material_name: string; sku: string; packs: MapRow[] }>();
    for (const r of filtered) {
      const cur = g.get(r.material_id);
      if (cur) cur.packs.push(r);
      else g.set(r.material_id, {
        material_id: r.material_id, material_name: r.material_name,
        sku: String(r.material_sku || ''), packs: [r],
      });
    }
    return [...g.values()].sort((a, b) => a.material_name.localeCompare(b.material_name));
  }, [filtered]);

  const multiPack = grouped.filter(g => g.packs.length > 1).length;

  /* ── Rate movement ──────────────────────────────────────────────────────── */
  const [vLoading, setVLoading] = useState(false);
  const [vData, setVData] = useState<VariancePayload | null>(null);
  const [storeId, setStoreId] = useState('');
  const [vFrom, setVFrom] = useState('');
  const [vTo, setVTo] = useState('');
  const [onlyMoved, setOnlyMoved] = useState(true);
  const [accepting, setAccepting] = useState('');

  const loadVariance = useCallback(async () => {
    setVLoading(true);
    try {
      const p = new URLSearchParams();
      if (storeId) p.set('store_id', storeId);
      if (vFrom) p.set('from', vFrom);
      if (vTo) p.set('to', vTo);
      const res = await api(`/api/liquor/brand-map/variance?${p.toString()}`);
      if (res.status === 403) { setForbidden(true); return; }
      const j = (await res.json().catch(() => ({}))) as VariancePayload;
      if (!res.ok) { flash(false, j?.error || `Could not load rate movement (HTTP ${res.status}).`); return; }
      setVData(j);
      if (!storeId && j.stores && j.stores.length === 1) setStoreId(j.stores[0].id);
    } catch { flash(false, 'Network error — rate movement was not loaded.'); }
    finally { setVLoading(false); }
  }, [storeId, vFrom, vTo, flash]);

  useEffect(() => { if (tab === 'movement') loadVariance(); }, [tab, loadVariance]);

  const acceptRate = useCallback(async (r: VarianceRow) => {
    if (!r.brandMapId || r.masterRate === null || r.proposedRatePerCase === null) return;
    const label = `${r.tgbclBrandCode}${r.sizeCode ? '-' + r.sizeCode : ''}`;
    if (!window.confirm(
      `Accept ${money4(r.indentRate)} per bottle as the new TGBCL master rate for ${label} (${r.materialName})?\n\n`
      + `The master goes from ${money4(r.masterRate)} to ${money4(r.indentRate)} per bottle `
      + `(${money(r.proposedRatePerCase)} per case).\n\n`
      + 'Every later variance and landed cost is measured against the new figure. '
      + 'Stock values, average price and recipe costs are NOT affected. This is recorded in the audit log.',
    )) return;
    setAccepting(r.ledgerId);
    try {
      const res = await api('/api/liquor/brand-map/variance', {
        method: 'POST', body: { ledger_id: r.ledgerId, brand_map_id: r.brandMapId },
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string; unchanged?: boolean; rate_per_case_master?: number };
      if (!res.ok) { flash(false, j?.error || `Could not accept the rate (HTTP ${res.status}).`); return; }
      flash(true, j?.unchanged
        ? 'The master already held that rate — nothing changed.'
        : `Master rate for ${label} is now ${money(Number(j?.rate_per_case_master || 0))} per case.`);
      loadVariance();
      load(true);
    } catch { flash(false, 'Network error — the master was not changed.'); }
    finally { setAccepting(''); }
  }, [flash, loadVariance, load]);

  const vRows = useMemo(() => {
    const all = vData?.rows || [];
    return onlyMoved ? all.filter(r => hasMoved(r.variance)) : all;
  }, [vData, onlyMoved]);

  /* ── CSV import ─────────────────────────────────────────────────────────── */
  const [csvText, setCsvText] = useState('');
  const [csvName, setCsvName] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);

  const sendCsv = useCallback(async (commit: boolean) => {
    if (!csvText.trim() || busy) return;
    setBusy(true);
    if (commit) setResult(null); else { setPreview(null); setResult(null); }
    try {
      const res = await api(`/api/liquor/brand-map/import?commit=${commit ? '1' : '0'}`, {
        method: 'POST', body: { csv: csvText },
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (commit) setResult(j as ImportResult); else setPreview(j as ImportPreview);
        flash(false, (j as any)?.error || `HTTP ${res.status}`);
        return;
      }
      if (commit) {
        setResult(j as ImportResult);
        const r = j as ImportResult;
        flash(true, `Imported — ${nf(r.created || 0)} added, ${nf(r.updated || 0)} updated, ${nf(r.unchanged || 0)} unchanged.`);
        load(true);
      } else {
        setPreview(j as ImportPreview);
      }
    } catch { flash(false, 'Network error.'); }
    finally { setBusy(false); }
  }, [csvText, busy, flash, load]);

  const downloadTemplate = useCallback(() => {
    const header = data?.csv_header
      || 'material,material_id,sku,tgbcl_brand_code,size_code,size_ml,bottles_per_case,rate_per_case_master,product_type,is_active,note';
    const blob = new Blob([header + '\n'], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'tgbcl-brand-master-template.csv';
    a.click(); URL.revokeObjectURL(url);
  }, [data]);

  /* ── Render ─────────────────────────────────────────────────────────────── */

  if (forbidden) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] flex items-center justify-center p-6">
        <div className="max-w-sm text-center text-[#6B5744]">
          <Lock className="w-10 h-10 mx-auto mb-3 text-[#af4408]" />
          <h1 className="text-lg font-bold text-[#2D1B0E]">Admins only</h1>
          <p className="text-sm mt-1">
            One row here re-prices a TGBCL brand for every future indent, every landed cost and the
            rate-movement watch, so the brand master is restricted to admin accounts.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-6xl mx-auto px-3 sm:px-6 py-5 space-y-4">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">Inventory · Liquor</p>
            <h1 className="text-2xl sm:text-3xl font-bold mt-0.5 flex items-center gap-2.5">
              <Link2 className="w-7 h-7 text-[#af4408] shrink-0" />
              <span className="min-w-0">Liquor Brand Map (TGBCL)</span>
            </h1>
            <p className="text-sm text-[#8B7355] mt-1">
              Tell each bottle which TGBCL brand code and pack it is. That is what makes an indent&apos;s
              rate comparable to the master, and what a landed cost per bottle is built from. A brand
              bought in two packs holds <b>two rows</b> — the key is the code + pack, not the material.
            </p>
          </div>
          <button
            onClick={() => { load(true); if (tab === 'movement') loadVariance(); }}
            className="shrink-0 self-start sm:self-auto flex items-center gap-2 px-3 py-2.5 bg-white border border-[#E0D0BE]
                       hover:bg-[#FFF1E3] text-[#6B5744] rounded-xl text-sm font-medium shadow-sm"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />Refresh
          </button>
        </div>

        {/* The standing promise this module makes, said once, at the top. */}
        <div className="flex items-start gap-2 p-3 bg-white border border-[#E8D5C4] rounded-xl text-[12px] text-[#6B5744]">
          <Info className="w-4 h-4 shrink-0 mt-0.5 text-[#af4408]" />
          <p>
            <b>Nothing on this page changes a stock value.</b> The TGBCL levies stay recorded-only, exactly as they
            are today, and landed cost is an analytics figure used inside the reconciliation module. Average price,
            last purchase price, recipe costs and every variance value are untouched by everything here.
          </p>
        </div>

        {msg && (
          <div className={`flex items-start gap-2 p-3 rounded-xl text-sm border ${msg.ok
            ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
            : 'bg-red-50 border-red-200 text-red-700'}`}>
            {msg.ok ? <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" /> : <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />}
            <span>{msg.text}</span>
          </div>
        )}
        {loadError && (
          <div className="flex items-start gap-2 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /><span>{loadError}</span>
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-1.5 flex-wrap">
          {([
            { k: 'map', label: 'Mappings', Icon: Link2 },
            { k: 'movement', label: 'Rate Movement', Icon: TrendingUp },
            { k: 'import', label: 'Import Brand Master', Icon: Upload },
          ] as const).map(t => (
            <button
              key={t.k}
              onClick={() => setTab(t.k)}
              className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold border ${tab === t.k
                ? 'bg-[#af4408] text-white border-[#af4408]'
                : 'bg-white text-[#6B5744] border-[#E0D0BE] hover:bg-[#FFF1E3]'}`}
            >
              <t.Icon className="w-4 h-4" />{t.label}
            </button>
          ))}
        </div>

        {/* ══ MAPPINGS ══════════════════════════════════════════════════════ */}
        {tab === 'map' && (
          <>
            {data?.counts && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                {[
                  { label: 'Mappings', value: nf(data.counts.total), sub: `${nf(data.counts.active)} active` },
                  { label: 'Materials mapped', value: nf(data.counts.materials_mapped), sub: `of ${nf(data.counts.materials_available)} liquor materials` },
                  { label: 'Bought in 2+ packs', value: nf(multiPack), sub: 'one brand, several case rates' },
                  {
                    label: 'Still unmapped',
                    value: nf(Math.max(0, data.counts.materials_available - data.counts.materials_mapped)),
                    sub: 'no landed cost, no rate watch',
                  },
                ].map(c => (
                  <div key={c.label} className="bg-white border border-[#E8D5C4] rounded-2xl px-3 py-2.5 shadow-sm">
                    <p className="text-[10px] text-[#8B7355] leading-tight">{c.label}</p>
                    <p className="text-xl font-bold mt-0.5">{c.value}</p>
                    <p className="text-[9px] text-[#B8A590] leading-tight mt-0.5">{c.sub}</p>
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 bg-white border border-[#E8D5C4] rounded-2xl p-3 shadow-sm">
              <div className="relative flex-1 min-w-[180px]">
                <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-[#8B7355]" />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search material, SKU, brand code or pack…"
                  className="w-full pl-8 pr-2 py-2 border border-[#E8D5C4] rounded-xl text-sm bg-[#FFF8F0]"
                />
              </div>
              <label className="flex items-center gap-2 text-xs text-[#6B5744]">
                <Toggle size="sm" checked={includeInactive} onChange={setIncludeInactive} label="Show inactive" />
                Show inactive
              </label>
              <button
                onClick={() => setDraft(emptyDraft())}
                className="px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-xl text-sm font-semibold flex items-center gap-1.5"
              >
                <Plus className="w-4 h-4" />Add mapping
              </button>
            </div>

            {/* Editor */}
            {draft && (
              <div className="bg-white border-2 border-[#af4408]/30 rounded-2xl p-4 shadow-sm space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="font-bold flex items-center gap-2">
                    <Wine className="w-4 h-4 text-[#af4408]" />{draft.id ? 'Edit mapping' : 'New mapping'}
                  </h2>
                  <button onClick={() => setDraft(null)} className="text-[#8B7355] hover:text-[#2D1B0E]">
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-[#8B7355] mb-1">Material</label>
                  <MaterialTypeahead
                    materials={data?.materials || []}
                    value={draft.material_id}
                    onPick={id => setDraft(d => (d ? { ...d, material_id: id } : d))}
                    showStock={false}
                    compact={false}
                    placeholder="Type the bottle's name or SKU…"
                  />
                  <p className="text-[10px] text-[#B8A590] mt-1">
                    Only materials on a store-mapped liquor shelf are offered — a TGBCL code has no meaning on a
                    grocery line.
                  </p>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
                  {([
                    { k: 'tgbcl_brand_code', label: 'Brand code', ph: '9740', hint: 'TGBCL' },
                    { k: 'size_code', label: 'Pack code', ph: 'PP', hint: 'PP / NN / QQ' },
                    { k: 'size_ml', label: 'Size (ml)', ph: '750', hint: '0 = unknown' },
                    { k: 'bottles_per_case', label: 'Bottles / case', ph: '12', hint: 'required, > 0' },
                    { k: 'rate_per_case_master', label: 'Rate / case (₹)', ph: '9600', hint: 'TGBCL issue price' },
                  ] as const).map(f => (
                    <div key={f.k}>
                      <label className="block text-[11px] font-semibold text-[#8B7355] mb-1">{f.label}</label>
                      <input
                        value={(draft as any)[f.k]}
                        onChange={e => setDraft(d => (d ? { ...d, [f.k]: e.target.value } : d))}
                        placeholder={f.ph}
                        className="w-full px-2.5 py-2 border border-[#E8D5C4] rounded-xl text-sm bg-[#FFF8F0]"
                      />
                      <p className="text-[9px] text-[#B8A590] mt-0.5">{f.hint}</p>
                    </div>
                  ))}
                  <div>
                    <label className="block text-[11px] font-semibold text-[#8B7355] mb-1">Product type</label>
                    <select
                      value={draft.product_type}
                      onChange={e => setDraft(d => (d ? { ...d, product_type: e.target.value } : d))}
                      className="w-full px-2.5 py-2 border border-[#E8D5C4] rounded-xl text-sm bg-[#FFF8F0]"
                    >
                      {(data?.product_types || ['BEER', 'IML', 'Duty Paid']).map(t => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                    <p className="text-[9px] text-[#B8A590] mt-0.5">drives the beer/spirit split</p>
                  </div>
                </div>

                {/* Derived, shown as it will be computed — never stored. */}
                {Number(draft.bottles_per_case) > 0 && Number(draft.rate_per_case_master) > 0 && (
                  <p className="text-[12px] text-[#6B5744] bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl px-3 py-2">
                    Rate per bottle works out to{' '}
                    <b>{money4(Number(draft.rate_per_case_master) / Number(draft.bottles_per_case))}</b>{' '}
                    — derived from the case rate, never stored.
                  </p>
                )}

                <div className="flex flex-wrap items-center gap-3">
                  <input
                    value={draft.note}
                    onChange={e => setDraft(d => (d ? { ...d, note: e.target.value } : d))}
                    placeholder="Note (optional)"
                    className="flex-1 min-w-[180px] px-2.5 py-2 border border-[#E8D5C4] rounded-xl text-sm bg-[#FFF8F0]"
                  />
                  <label className="flex items-center gap-2 text-xs text-[#6B5744]">
                    <Toggle
                      size="sm"
                      checked={draft.is_active === 1}
                      onChange={v => setDraft(d => (d ? { ...d, is_active: v ? 1 : 0 } : d))}
                      label="Active"
                    />
                    Active
                  </label>
                  <button
                    onClick={saveDraft}
                    disabled={saving}
                    className="px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-xl text-sm font-semibold
                               flex items-center gap-1.5 disabled:opacity-40"
                  >
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                    {draft.id ? 'Save changes' : 'Add mapping'}
                  </button>
                </div>
              </div>
            )}

            {loading ? (
              <div className="space-y-2">
                {[0, 1, 2].map(i => <div key={i} className="bg-white border border-[#E8D5C4] rounded-2xl h-20 animate-pulse" />)}
              </div>
            ) : grouped.length === 0 ? (
              <div className="bg-white border border-[#E8D5C4] rounded-2xl py-14 text-center text-[#8B7355]">
                <Info className="w-9 h-9 mx-auto mb-3 text-[#C9B49C]" />
                <p className="font-medium text-[#2D1B0E]">Nothing mapped yet</p>
                <p className="text-xs mt-1 max-w-md mx-auto">
                  Add mappings one at a time, or upload the Brand Master sheet on the Import tab — that is the
                  one-time migration path off the workbook.
                </p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {grouped.map(g => (
                  <div key={g.material_id} className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm overflow-hidden">
                    <div className="px-3.5 py-2.5 border-b border-[#F0E4D6] flex flex-wrap items-baseline gap-2">
                      <span className="font-semibold text-[#2D1B0E]">{g.material_name}</span>
                      {g.sku && <span className="text-[10px] text-[#B8A590] font-mono">{g.sku}</span>}
                      {g.packs.length > 1 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#FFF1E3] text-[#8B4A1E] border border-[#E8D5C4] font-semibold">
                          {g.packs.length} packs
                        </span>
                      )}
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-[10px] uppercase tracking-wide text-[#8B7355] bg-[#FFFBF6]">
                            <th className="text-left font-semibold px-3.5 py-1.5">Code · pack</th>
                            <th className="text-right font-semibold px-2 py-1.5">Size</th>
                            <th className="text-right font-semibold px-2 py-1.5">Btl / case</th>
                            <th className="text-right font-semibold px-2 py-1.5">Rate / case</th>
                            <th className="text-right font-semibold px-2 py-1.5">Rate / bottle</th>
                            <th className="text-left font-semibold px-2 py-1.5">Type</th>
                            <th className="px-2 py-1.5"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {g.packs.map(p => (
                            <tr key={p.id} className={`border-t border-[#F5EDE3] ${p.is_active ? '' : 'opacity-50'}`}>
                              <td className="px-3.5 py-2 font-mono text-[12px]">
                                {p.tgbcl_brand_code}{p.size_code ? <span className="text-[#af4408]">-{p.size_code}</span> : null}
                                {!p.is_active && <span className="ml-2 text-[10px] text-[#8B7355]">inactive</span>}
                                {p.note && <div className="text-[10px] text-[#B8A590] font-sans">{p.note}</div>}
                              </td>
                              <td className="px-2 py-2 text-right text-[12px] text-[#6B5744]">
                                {p.size_ml > 0 ? `${nf(p.size_ml)} ml` : <span className="text-[#C9B49C]">—</span>}
                              </td>
                              <td className="px-2 py-2 text-right text-[12px]">{nf(p.bottles_per_case)}</td>
                              <td className="px-2 py-2 text-right text-[12px]">{money(p.rate_per_case_master)}</td>
                              <td className="px-2 py-2 text-right text-[12px] font-semibold">{money4(p.rate_per_bottle_master)}</td>
                              <td className="px-2 py-2"><TypeChip t={p.product_type} /></td>
                              <td className="px-2 py-2 text-right whitespace-nowrap">
                                <button
                                  onClick={() => setDraft({
                                    id: p.id, material_id: p.material_id,
                                    tgbcl_brand_code: p.tgbcl_brand_code, size_code: p.size_code,
                                    size_ml: String(p.size_ml || ''), bottles_per_case: String(p.bottles_per_case),
                                    rate_per_case_master: String(p.rate_per_case_master),
                                    product_type: p.product_type, is_active: p.is_active, note: p.note || '',
                                  })}
                                  className="text-[11px] px-2 py-1 rounded-lg border border-[#E0D0BE] hover:bg-[#FFF1E3] text-[#6B5744]"
                                >Edit</button>
                                <button
                                  onClick={() => removeRow(p)}
                                  title="Remove this mapping"
                                  className="ml-1.5 text-[11px] px-2 py-1 rounded-lg border border-red-200 hover:bg-red-50 text-red-600"
                                ><Trash2 className="w-3.5 h-3.5" /></button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* ══ RATE MOVEMENT ═════════════════════════════════════════════════ */}
        {tab === 'movement' && (
          <>
            <div className="flex flex-wrap items-end gap-2 bg-white border border-[#E8D5C4] rounded-2xl p-3 shadow-sm">
              <div>
                <label className="block text-[11px] font-semibold text-[#8B7355] mb-1">Store</label>
                <select
                  value={storeId}
                  onChange={e => setStoreId(e.target.value)}
                  className="px-2.5 py-2 border border-[#E8D5C4] rounded-xl text-sm bg-[#FFF8F0]"
                >
                  <option value="">All stores</option>
                  {(vData?.stores || []).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-[#8B7355] mb-1">From</label>
                <input type="date" value={vFrom} onChange={e => setVFrom(e.target.value)}
                  className="px-2.5 py-2 border border-[#E8D5C4] rounded-xl text-sm bg-[#FFF8F0]" />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-[#8B7355] mb-1">To</label>
                <input type="date" value={vTo} onChange={e => setVTo(e.target.value)}
                  className="px-2.5 py-2 border border-[#E8D5C4] rounded-xl text-sm bg-[#FFF8F0]" />
              </div>
              <button
                onClick={loadVariance}
                className="px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-xl text-sm font-semibold flex items-center gap-1.5"
              >
                {vLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}Show
              </button>
              <label className="flex items-center gap-2 text-xs text-[#6B5744] ml-auto">
                <Toggle size="sm" checked={onlyMoved} onChange={setOnlyMoved} label="Only lines where the rate moved" />
                Only lines where the rate moved
              </label>
            </div>

            {vData?.summary && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                {[
                  { label: 'Inward lines', value: nf(vData.summary.lines), cls: 'text-[#2D1B0E]', sub: 'in range' },
                  { label: 'Rate moved', value: nf(vData.summary.moved), cls: vData.summary.moved > 0 ? 'text-red-700' : 'text-emerald-700', sub: 'indent ≠ master' },
                  { label: 'Worth', value: money(vData.summary.moved_value), cls: 'text-[#2D1B0E]', sub: 'Σ |difference × bottles|' },
                  { label: 'Not mapped', value: nf(vData.summary.unmapped), cls: vData.summary.unmapped > 0 ? 'text-amber-700' : 'text-emerald-700', sub: 'no master to compare' },
                ].map(c => (
                  <div key={c.label} className="bg-white border border-[#E8D5C4] rounded-2xl px-3 py-2.5 shadow-sm">
                    <p className="text-[10px] text-[#8B7355] leading-tight">{c.label}</p>
                    <p className={`text-xl font-bold mt-0.5 ${c.cls}`}>{c.value}</p>
                    <p className="text-[9px] text-[#B8A590] leading-tight mt-0.5">{c.sub}</p>
                  </div>
                ))}
              </div>
            )}

            <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wide text-[#8B7355] bg-[#FFFBF6]">
                      <th className="text-left font-semibold px-3 py-2">Date · indent</th>
                      <th className="text-left font-semibold px-2 py-2">Item</th>
                      <th className="text-right font-semibold px-2 py-2">Bottles</th>
                      <th className="text-right font-semibold px-2 py-2">Indent rate</th>
                      <th className="text-right font-semibold px-2 py-2">Master rate</th>
                      <th className="text-right font-semibold px-2 py-2">Variance</th>
                      <th className="text-right font-semibold px-2 py-2">Landed / bottle</th>
                      <th className="px-2 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {vLoading ? (
                      <tr><td colSpan={8} className="py-10 text-center text-[#8B7355]">
                        <Loader2 className="w-5 h-5 animate-spin mx-auto" />
                      </td></tr>
                    ) : vRows.length === 0 ? (
                      <tr><td colSpan={8} className="py-12 text-center text-[#8B7355]">
                        <Info className="w-8 h-8 mx-auto mb-2 text-[#C9B49C]" />
                        <p className="font-medium text-[#2D1B0E]">
                          {onlyMoved ? 'No rate movement in this range' : 'No inward lines in this range'}
                        </p>
                        <p className="text-xs mt-1">
                          {onlyMoved
                            ? 'Every mapped line arrived at the rate the master holds.'
                            : 'Record a liquor bill on the Liquor Store page and it appears here.'}
                        </p>
                      </td></tr>
                    ) : vRows.map(r => {
                      const moved = hasMoved(r.variance);
                      return (
                        <tr key={r.ledgerId} className="border-t border-[#F5EDE3] align-top">
                          <td className="px-3 py-2 text-[12px] whitespace-nowrap">
                            {r.inwardDate}
                            <div className="text-[10px] text-[#B8A590] font-mono">{r.invoiceRef || '—'}</div>
                          </td>
                          <td className="px-2 py-2 text-[12px]">
                            {r.materialName}
                            {r.tgbclBrandCode && (
                              <div className="text-[10px] text-[#B8A590] font-mono">
                                {r.tgbclBrandCode}{r.sizeCode ? '-' + r.sizeCode : ''}
                              </div>
                            )}
                          </td>
                          <td className="px-2 py-2 text-right text-[12px]">{nf(Math.round(r.bottles * 100) / 100)}</td>
                          <td className="px-2 py-2 text-right text-[12px]">{money4(r.indentRate)}</td>
                          <td className="px-2 py-2 text-right text-[12px]">
                            {r.masterRate === null
                              ? <span className="text-amber-700 text-[11px]">
                                  {MAP_REASON_LABEL[r.mapReason] || 'not mapped'}
                                </span>
                              : money4(r.masterRate)}
                          </td>
                          <td className={`px-2 py-2 text-right text-[12px] font-semibold ${moved ? 'text-red-600' : 'text-[#8B7355]'}`}>
                            {r.variance === null
                              ? <span className="text-[#C9B49C]">—</span>
                              : (<>
                                  {signedMoney4(r.variance)}
                                  {moved && r.varianceValue !== null && (
                                    <div className="text-[10px] font-normal">{money(r.varianceValue)} on this line</div>
                                  )}
                                </>)}
                          </td>
                          <td className="px-2 py-2 text-right text-[12px]">
                            {r.landedPerBottle === null
                              ? <span className="text-[#C9B49C]">—</span>
                              : (<>
                                  {money4(r.landedPerBottle)}
                                  <div className="text-[10px] text-[#B8A590]">levies {signedMoney4(r.leviesPerBottle)}</div>
                                </>)}
                          </td>
                          <td className="px-2 py-2 text-right whitespace-nowrap">
                            {moved && r.brandMapId ? (
                              <button
                                onClick={() => acceptRate(r)}
                                disabled={accepting === r.ledgerId}
                                className="text-[11px] px-2.5 py-1.5 rounded-lg bg-[#af4408] hover:bg-[#8a3506] text-white
                                           font-semibold disabled:opacity-40 inline-flex items-center gap-1"
                              >
                                {accepting === r.ledgerId
                                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  : <ArrowRight className="w-3.5 h-3.5" />}
                                Accept into master
                              </button>
                            ) : r.masterRate === null ? (
                              <Link href="#" onClick={e => { e.preventDefault(); setTab('map'); setSearch(r.materialName); }}
                                className="text-[11px] underline text-[#af4408]">Map it</Link>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <p className="text-[11px] text-[#8B7355] px-1">
              <b>Landed / bottle</b> = the master rate for the pack + this line&apos;s share of the bill&apos;s TGBCL
              levies (MRP rounding shared out by <b>bottles</b>, turnover tax / cess / TCS by <b>line value</b>, as the
              workbook does it). It is an analytics figure: it does not enter stock valuation or recipe costing.
            </p>
          </>
        )}

        {/* ══ IMPORT ════════════════════════════════════════════════════════ */}
        {tab === 'import' && (
          <div className="space-y-3">
            <div className="bg-white border border-[#E8D5C4] rounded-2xl p-4 shadow-sm space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-bold flex items-center gap-2"><Upload className="w-4 h-4 text-[#af4408]" />Brand Master CSV</h2>
                <button
                  onClick={downloadTemplate}
                  className="flex items-center gap-1.5 px-3 py-2 bg-white border border-[#E0D0BE] hover:bg-[#FFF1E3]
                             text-[#6B5744] rounded-xl text-xs font-medium"
                ><FileDown className="w-4 h-4" />Download template</button>
              </div>
              <p className="text-[12px] text-[#6B5744]">
                Upload the Brand Master sheet once and the mapping is done. Columns are matched by name, in any order:
                {' '}<code className="text-[11px]">material</code> (or <code className="text-[11px]">material_id</code> /
                {' '}<code className="text-[11px]">sku</code>), <code className="text-[11px]">tgbcl_brand_code</code>,
                {' '}<code className="text-[11px]">size_code</code>, <code className="text-[11px]">size_ml</code>,
                {' '}<code className="text-[11px]">bottles_per_case</code>, <code className="text-[11px]">rate_per_case_master</code>,
                {' '}<code className="text-[11px]">product_type</code>, <code className="text-[11px]">is_active</code>,
                {' '}<code className="text-[11px]">note</code>.
              </p>
              <p className="text-[11px] text-[#8B7355]">
                Re-uploading the same file is safe: a code + pack already mapped is <b>updated</b>, never duplicated, and a
                row identical to what is stored is left alone. Rows with errors are reported by their line number and
                simply do not import — the rest still do.
              </p>

              <input
                type="file"
                accept=".csv,text/csv"
                onChange={async e => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  setCsvName(f.name);
                  setCsvText(await f.text());
                  setPreview(null); setResult(null);
                }}
                className="block w-full text-sm text-[#6B5744] file:mr-3 file:py-2 file:px-3 file:rounded-xl
                           file:border file:border-[#E0D0BE] file:bg-[#FFF1E3] file:text-[#6B5744] file:text-sm"
              />
              <textarea
                value={csvText}
                onChange={e => { setCsvText(e.target.value); setPreview(null); setResult(null); }}
                placeholder="…or paste the CSV here (header row first)"
                rows={5}
                className="w-full px-2.5 py-2 border border-[#E8D5C4] rounded-xl text-[12px] font-mono bg-[#FFF8F0]"
              />
              {csvName && <p className="text-[11px] text-[#B8A590]">Loaded <b>{csvName}</b></p>}

              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => sendCsv(false)}
                  disabled={busy || !csvText.trim()}
                  className="px-4 py-2 bg-white border border-[#E0D0BE] hover:bg-[#FFF1E3] text-[#6B5744]
                             rounded-xl text-sm font-semibold disabled:opacity-40 flex items-center gap-1.5"
                >{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}Check the file</button>
                <button
                  onClick={() => sendCsv(true)}
                  disabled={busy || !preview?.ok || !(preview?.valid ?? 0)}
                  className="px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-xl text-sm font-semibold
                             disabled:opacity-40 flex items-center gap-1.5"
                >{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                  Import {preview?.ok ? `${nf((preview.creates || 0) + (preview.updates || 0))} row(s)` : ''}</button>
              </div>
              {preview && !preview.ok && preview.error && (
                <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <div>
                    {preview.error}
                    {preview.expected_header && (
                      <p className="mt-1 font-mono text-[11px] break-words">{preview.expected_header}</p>
                    )}
                  </div>
                </div>
              )}
            </div>

            {preview?.ok && (
              <div className="bg-white border border-[#E8D5C4] rounded-2xl p-4 shadow-sm space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
                  {[
                    { label: 'Rows in file', value: nf(preview.total_rows || 0), cls: 'text-[#2D1B0E]' },
                    { label: 'Will add', value: nf(preview.creates || 0), cls: 'text-emerald-700' },
                    { label: 'Will update', value: nf(preview.updates || 0), cls: 'text-amber-700' },
                    { label: 'Unchanged', value: nf(preview.unchanged || 0), cls: 'text-[#8B7355]' },
                    { label: 'Errors', value: nf(preview.errors?.length || 0), cls: (preview.errors?.length || 0) > 0 ? 'text-red-700' : 'text-emerald-700' },
                  ].map(c => (
                    <div key={c.label} className="bg-[#FFFBF6] border border-[#F0E4D6] rounded-xl px-3 py-2">
                      <p className="text-[10px] text-[#8B7355]">{c.label}</p>
                      <p className={`text-lg font-bold ${c.cls}`}>{c.value}</p>
                    </div>
                  ))}
                </div>

                {(preview.material_changes_total || 0) > 0 && (
                  <div className="p-3 bg-red-50 border border-red-300 rounded-xl text-[12px] text-red-900">
                    <b>{nf(preview.material_changes_total || 0)} mapping(s) will MOVE to a different material.</b>
                    <p className="mt-0.5">
                      The material each one leaves keeps its stock and its purchase history, but loses its
                      TGBCL master rate and its landed cost until something maps it again.
                    </p>
                    <ul className="mt-1 space-y-0.5">
                      {(preview.material_changes || []).map(c => (
                        <li key={`mv-${c.line}-${c.code}-${c.size_code}`} className="font-mono text-[11px]">
                          line {c.line} · {c.code}{c.size_code ? '-' + c.size_code : ''}:
                          {' '}{c.from_material || '(deleted material)'} → {c.to_material}
                        </li>
                      ))}
                    </ul>
                    {(preview.material_changes_total || 0) > (preview.material_changes || []).length && (
                      <p className="mt-1">…and {nf((preview.material_changes_total || 0) - (preview.material_changes || []).length)} more.</p>
                    )}
                  </div>
                )}

                {(preview.rate_changes_total || 0) > 0 && (
                  <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-[12px] text-amber-900">
                    <b>{nf(preview.rate_changes_total || 0)} master rate(s) will change.</b>
                    <ul className="mt-1 space-y-0.5">
                      {(preview.rate_changes || []).map(c => (
                        <li key={`${c.line}-${c.code}-${c.size_code}`} className="font-mono text-[11px]">
                          line {c.line} · {c.code}{c.size_code ? '-' + c.size_code : ''} · {c.material}:
                          {' '}{money(c.from || 0)} → {money(c.to)} per case
                        </li>
                      ))}
                    </ul>
                    {(preview.rate_changes_total || 0) > (preview.rate_changes || []).length && (
                      <p className="mt-1">…and {nf((preview.rate_changes_total || 0) - (preview.rate_changes || []).length)} more.</p>
                    )}
                  </div>
                )}

                {(preview.errors?.length || 0) > 0 && (
                  <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-[12px] text-red-800">
                    <b>These rows will NOT import:</b>
                    <ul className="mt-1 space-y-0.5 max-h-64 overflow-y-auto">
                      {(preview.errors || []).map((e, i) => (
                        <li key={i}>Line {e.line}: {e.message}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {(preview.warnings?.length || 0) > 0 && (
                  <div className="p-3 bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl text-[12px] text-[#6B5744]">
                    <b>Warnings — these rows still import:</b>
                    <ul className="mt-1 space-y-0.5 max-h-48 overflow-y-auto">
                      {(preview.warnings || []).map((w, i) => (
                        <li key={i}>{w.line ? `Line ${w.line}: ` : ''}{w.message}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {result?.ok && (
              <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-2xl text-sm text-emerald-900">
                <b>Imported.</b> {nf(result.created || 0)} added, {nf(result.updated || 0)} updated,
                {' '}{nf(result.unchanged || 0)} already identical.
                {(result.material_changes_total || 0) > 0 && (
                  <div className="mt-2 text-red-900">
                    <b>{nf(result.material_changes_total || 0)} mapping(s) moved to a different material</b>
                    {' '}(recorded in the audit log):
                    <ul className="mt-1 space-y-0.5 font-mono text-[11px]">
                      {(result.material_changes || []).map(c => (
                        <li key={`mvr-${c.line}-${c.code}-${c.size_code}`}>
                          {c.code}{c.size_code ? '-' + c.size_code : ''}: {c.from_material || '(deleted material)'} → {c.to_material}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {(result.skipped?.length || 0) > 0 && (
                  <div className="mt-2">
                    <b>{nf(result.skipped?.length || 0)} row(s) skipped:</b>
                    <ul className="mt-1 space-y-0.5 max-h-48 overflow-y-auto text-[12px]">
                      {(result.skipped || []).map((s, i) => <li key={i}>Line {s.line}: {s.message}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
