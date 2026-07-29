'use client';

/**
 * Closing Stock Overview — the READ-ONLY board for the non-liquor side
 * (Grocery Store, Chillers, Kitchen, and every other storage area), pivoted
 * storage area × department for one date. Mirrors the Consolidated Stock board
 * (/inventory/stock-overview) in structure, styling and gate handling.
 *
 * This page NEVER writes. There are already two closing-count writers and they
 * have drifted; a third would make it three. Every cell and every drill-down
 * row deep-links into the existing record flow at /closing-stock instead.
 *
 * Source: GET /api/closing-stock/overview
 *   ?date=YYYY-MM-DD                          → PIVOT (departments + rows)
 *   &location=<name|__unassigned__>           → ITEMS (per-material drill-down)
 *   [&department_id=<key>] [&include_uncounted=1]
 * The gate is server-side (the blind-count rule strips system/variance for
 * non-admins, and a 403 renders the 🔒 notice here rather than redirecting).
 *
 * Blind count: system_stock / variance arrive as NULL for non-admins. Those
 * columns stay VISIBLE and print "—" with the reason in the tooltip — hiding
 * them silently would make an admin and a counter disagree about what the
 * report even contains.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import Papa from 'papaparse';
import {
  ClipboardCheck, Loader2, AlertCircle, Download, PackageX, IndianRupee,
  Layers, Warehouse, ArrowUpRight, X, CalendarDays, ClipboardX,
} from 'lucide-react';
import Toggle from '@/components/Toggle';
import Qty from '@/components/Qty';
import { csvQty, dualQty, toPurchaseQty, type PackMeta } from '@/lib/pack-units';
import { todayIST, fmtIST } from '@/lib/format-date';

/* ── Types (the /api/closing-stock/overview contract) ──────────────────── */

interface DeptCol {
  key: string;            // '__store__' | department uuid
  name: string;
  sub_count?: number | null;
}

interface Cell {
  counted: number;
  physical_value: number;
  system_value: number | null;
  variance_value: number | null;
  /** Item counts (not ₹): how many lines came in under / over the system. */
  shortage: number | null;
  excess: number | null;
  /** Optional per-cell denominator; older payloads fall back to row.total_items. */
  total?: number | null;
}

interface BoardRow {
  location: string;
  total_items: number;
  counted_items: number;
  by_dept: Record<string, Cell | undefined>;
  total: {
    counted: number;
    physical_value: number;
    system_value: number | null;
    variance_value: number | null;
  };
}

interface Overview {
  date: string;
  departments: DeptCol[];
  rows: BoardRow[];
  totals: {
    areas: number; items: number; counted: number;
    physical_value: number; variance_value: number | null;
  };
  generated_at?: string;
  /** Optional convenience list; the chip row is skipped when absent. */
  recent_dates?: unknown;
  dates?: unknown;
}

/** ITEMS mode. Field names are read defensively — this payload is produced by a
 *  route being written in parallel, and a cached PWA response may predate it. */
interface ItemRow {
  material_id?: string | null;
  material_name?: string | null;
  name?: string | null;
  sku?: string | null;
  category?: string | null;
  department_id?: string | null;
  department_name?: string | null;
  /** false = an include_uncounted filler row: every figure below is null. */
  counted?: boolean;
  physical_stock?: number | null;
  system_stock?: number | null;
  variance?: number | null;
  variance_value?: number | null;
  value?: number | null;
  unit?: string | null;
  purchase_unit?: string | null;
  pack_size?: number | null;
  case_size?: number | null;
}

interface ItemsSummary {
  items?: number; counted?: number;
  physical_value?: number | null;
  system_value?: number | null;
  variance_value?: number | null;
}

/* ── Helpers ───────────────────────────────────────────────────────────── */

const inr = (v: number, dp = 0) =>
  '₹' + (Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: dp });
const n = (v: unknown) => Number(v) || 0;
/** null/undefined survive as null — a blind-count blank is NOT a zero. */
const nz = (v: unknown): number | null =>
  v === null || v === undefined || v === '' ? null : Number(v) || 0;

const UNASSIGNED = '__unassigned__';
const BLIND_HINT = 'System stock and variance are admin-only (blind count)';

/** The API's blank-location bucket. The board may label it either way. */
const locParam = (loc: string) => {
  const s = String(loc || '').trim();
  return !s || s === UNASSIGNED || /^—?\s*unassigned\s*—?$/i.test(s) ? UNASSIGNED : s;
};
const locLabel = (loc: string) => (locParam(loc) === UNASSIGNED ? '— Unassigned —' : loc);

/** THE deep link into the record flow. Total column → no department_id. */
function recordHref(date: string, location: string, deptKey?: string | null) {
  const qs = new URLSearchParams({ date, location: locParam(location) });
  if (deptKey) qs.set('department_id', deptKey);
  return `/closing-stock?${qs.toString()}`;
}

const packMeta = (r: ItemRow): PackMeta => ({
  unit: r.unit, purchase_unit: r.purchase_unit,
  pack_size: r.pack_size, case_size: r.case_size,
});

const itemName = (r: ItemRow) => r.material_name || r.name || 'Unnamed material';
/** Uncounted filler rows carry no department — say so rather than inventing one. */
const itemDept = (r: ItemRow) => r.department_name || '—';
const isCounted = (r: ItemRow) =>
  r.counted !== false && r.physical_stock !== null && r.physical_stock !== undefined;

/* ── Page ──────────────────────────────────────────────────────────────── */

export default function ClosingOverviewPage() {
  const [date, setDate] = useState(todayIST);
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');

  // Drill-down = one (location, department) cell of the board.
  const [drill, setDrill] = useState<{ location: string; deptKey: string | null } | null>(null);
  const [items, setItems] = useState<ItemRow[]>([]);
  const [itemsSummary, setItemsSummary] = useState<ItemsSummary | null>(null);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemsError, setItemsError] = useState('');
  const [includeUncounted, setIncludeUncounted] = useState(false);

  /* Board */
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true); setError('');
      try {
        const res = await fetch(`/api/closing-stock/overview?date=${encodeURIComponent(date)}`,
                                { credentials: 'same-origin' });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
        if (!alive) return;
        setData({
          date: json?.date || date,
          departments: Array.isArray(json?.departments) ? json.departments : [],
          rows: Array.isArray(json?.rows) ? json.rows : [],
          totals: json?.totals || { areas: 0, items: 0, counted: 0, physical_value: 0, variance_value: null },
          generated_at: json?.generated_at || '',
          recent_dates: json?.recent_dates,
          dates: json?.dates,
        });
      } catch (e: unknown) {
        if (alive) { setError((e as Error)?.message || 'Failed to load'); setData(null); }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [date]);

  /* Drill-down. Re-fires on date / toggle changes too, so an open panel always
   * matches the board above it. */
  useEffect(() => {
    if (!drill) { setItems([]); setItemsSummary(null); setItemsError(''); return; }
    let alive = true;
    (async () => {
      setItemsLoading(true); setItemsError('');
      try {
        const qs = new URLSearchParams({ date, location: locParam(drill.location) });
        if (drill.deptKey) qs.set('department_id', drill.deptKey);
        if (includeUncounted) qs.set('include_uncounted', '1');
        const res = await fetch(`/api/closing-stock/overview?${qs.toString()}`, { credentials: 'same-origin' });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
        if (!alive) return;
        // The route may name the collection either way; take whichever arrives.
        setItems(Array.isArray(json?.items) ? json.items : Array.isArray(json?.rows) ? json.rows : []);
        setItemsSummary(json?.summary && typeof json.summary === 'object' ? json.summary : null);
      } catch (e: unknown) {
        if (alive) {
          setItemsError((e as Error)?.message || 'Failed to load items');
          setItems([]); setItemsSummary(null);
        }
      } finally {
        if (alive) setItemsLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [drill, date, includeUncounted]);

  // Memoised so the `?? []` fallback can't hand a fresh array to the memos below.
  const departments = useMemo(() => data?.departments ?? [], [data]);
  const rows = useMemo(() => data?.rows ?? [], [data]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(r => locLabel(r.location).toLowerCase().includes(needle));
  }, [rows, q]);

  /* Summary over the FILTERED set (what the user is looking at). Variance stays
   * null unless at least one row actually carries one — blind counters must not
   * see a fabricated ₹0. */
  const summary = useMemo(() => {
    let items_ = 0, counted = 0, value = 0, variance = 0, sawVariance = false;
    for (const r of filtered) {
      items_ += n(r.total_items);
      counted += n(r.counted_items);
      value += n(r.total?.physical_value);
      const v = nz(r.total?.variance_value);
      if (v !== null) { variance += v; sawVariance = true; }
    }
    return {
      areas: filtered.length,
      items: items_,
      counted,
      uncounted: Math.max(0, items_ - counted),
      value,
      variance: sawVariance ? variance : null,
    };
  }, [filtered]);

  /* Recent count dates — rendered only if the API volunteers them. */
  const recentDates = useMemo(() => {
    const raw = (data?.recent_dates ?? data?.dates) as unknown;
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const e of raw) {
      const d = typeof e === 'string' ? e : (e as { date?: string })?.date;
      if (d && !out.includes(d)) out.push(d);
      if (out.length >= 10) break;
    }
    return out;
  }, [data]);

  const openCell = (location: string, deptKey: string | null) => {
    setDrill(prev =>
      prev && prev.location === location && prev.deptKey === deptKey ? null : { location, deptKey });
  };

  const drillDeptName = useMemo(() => {
    if (!drill?.deptKey) return 'All departments';
    return departments.find(d => d.key === drill.deptKey)?.name || drill.deptKey;
  }, [drill, departments]);

  /* ── CSV ─────────────────────────────────────────────────────────────── */

  const download = (csv: string, filename: string) => {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportBoard = () => {
    const header = [
      'Storage Area', 'Items', 'Counted', 'Uncounted',
      ...departments.flatMap(d => [`${d.name} — Counted`, `${d.name} — Value`]),
      'Total Counted', 'Total Value', 'Total Variance',
    ];
    const body: (string | number)[][] = filtered.map(r => [
      locLabel(r.location), n(r.total_items), n(r.counted_items),
      Math.max(0, n(r.total_items) - n(r.counted_items)),
      ...departments.flatMap(d => {
        const c = r.by_dept?.[d.key];
        return [c ? n(c.counted) : 0, c ? n(c.physical_value) : 0];
      }),
      n(r.total?.counted), n(r.total?.physical_value),
      nz(r.total?.variance_value) ?? '',
    ]);
    download(Papa.unparse([header, ...body]), `closing-overview-${date}.csv`);
  };

  const exportItems = () => {
    if (!drill) return;
    // House dual-basis convention: PURCHASE columns lead (what the store reads),
    // the RECIPE figures follow (the exact stored truth the ₹ column uses).
    const header = [
      'Storage Area', 'Material', 'SKU', 'Category', 'Department', 'Counted',
      'Purchase Unit', 'Counted Qty', 'System Qty', 'Variance Qty',
      'Recipe Unit', 'Counted Qty (recipe)', 'System Qty (recipe)', 'Variance Qty (recipe)',
      'Value', 'Variance Value',
    ];
    const body: (string | number)[][] = items.map(r => {
      const meta = packMeta(r);
      const phys = nz(r.physical_stock);
      const sys = nz(r.system_stock);
      const varq = nz(r.variance);
      const val = nz(r.value);
      return [
        locLabel(drill.location), itemName(r), r.sku || '', r.category || '',
        r.department_name || '', isCounted(r) ? 'yes' : 'no',
        r.purchase_unit || r.unit || '',
        phys === null ? '' : csvQty(toPurchaseQty(phys, meta)),
        sys === null ? '' : csvQty(toPurchaseQty(sys, meta)),
        varq === null ? '' : csvQty(toPurchaseQty(varq, meta)),
        r.unit || '',
        phys === null ? '' : csvQty(phys),
        sys === null ? '' : csvQty(sys),
        varq === null ? '' : csvQty(varq),
        val ?? '',
        nz(r.variance_value) ?? '',
      ];
    });
    const slug = locParam(drill.location).replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    download(Papa.unparse([header, ...body]), `closing-items-${slug}-${date}.csv`);
  };

  /* ── Render ──────────────────────────────────────────────────────────── */

  if (loading && !data) {
    return (
      <div className="p-6 max-w-3xl mx-auto text-sm text-[#6B5744]">
        <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading closing stock overview…
      </div>
    );
  }

  if (error && !data) {
    const denied = /limited to|limited|authoriz|not authorized/i.test(error);
    return (
      <div className="p-6 max-w-3xl mx-auto space-y-3">
        <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
          <ClipboardCheck className="w-6 h-6 text-[#af4408]" /> Closing Stock Overview
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
        <div className="flex-1 min-w-[220px]">
          <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
            <ClipboardCheck className="w-6 h-6 text-[#af4408]" /> Closing Stock Overview
          </h1>
          <p className="text-xs text-[#6B5744] mt-0.5">
            Counted physical stock by storage area and department.
            {data?.generated_at && (
              <span className="text-[#B9A896]"> · as of {fmtIST(data.generated_at)}</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <CalendarDays className="w-4 h-4 text-[#8B7355]" />
          <input
            type="date" value={date} onChange={e => setDate(e.target.value || todayIST())}
            className="px-2.5 py-2 border border-[#E8D5C4] rounded-lg text-sm bg-white text-[#2D1B0E]"
          />
        </div>
        <button onClick={exportBoard} disabled={filtered.length === 0}
                className="px-3 py-2 bg-white border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 disabled:opacity-40 rounded-lg text-sm font-medium flex items-center gap-1.5">
          <Download className="w-4 h-4" /> Export CSV
        </button>
      </div>

      {/* Recent count dates — only when the API volunteers them */}
      {recentDates.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-[#8B7355] font-medium">Recent counts:</span>
          {recentDates.map(d => (
            <button key={d} onClick={() => setDate(d)}
                    className={`px-2 py-1 rounded-full text-[11px] border transition-colors ${
                      d === date
                        ? 'bg-[#af4408] border-[#903905] text-white'
                        : 'bg-white border-[#E8D5C4] text-[#6B5744] hover:bg-[#FFF8F0]'}`}>
              {d}
            </button>
          ))}
        </div>
      )}

      {/* A refresh that failed while an older board is still on screen. */}
      {error && data && (
        <div className="rounded-lg p-3 text-sm flex items-center gap-2 bg-red-50 border border-red-200 text-red-700">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {/* Summary cards */}
      <div className={`grid grid-cols-2 md:grid-cols-3 gap-2.5 ${summary.variance !== null ? 'lg:grid-cols-5' : 'lg:grid-cols-4'}`}>
        <SummaryCard icon={<Warehouse className="w-4 h-4" />} label="Areas" value={summary.areas.toLocaleString('en-IN')} />
        <SummaryCard icon={<Layers className="w-4 h-4" />} label="Items counted"
                     value={`${summary.counted.toLocaleString('en-IN')} / ${summary.items.toLocaleString('en-IN')}`} />
        <SummaryCard icon={<ClipboardX className="w-4 h-4" />} label="Uncounted"
                     value={summary.uncounted.toLocaleString('en-IN')}
                     tone={summary.uncounted > 0 ? 'warn' : 'muted'} />
        <SummaryCard icon={<IndianRupee className="w-4 h-4" />} label="Counted value" value={inr(summary.value)} />
        {summary.variance !== null && (
          <SummaryCard icon={<IndianRupee className="w-4 h-4" />} label="Variance"
                       value={inr(summary.variance)} tone={summary.variance < 0 ? 'warn' : 'muted'} />
        )}
      </div>

      {/* Area filter */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px] max-w-md">
          <Warehouse className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8B7355]" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter storage area…"
                 className="w-full pl-8 pr-8 py-2 border border-[#E8D5C4] rounded-lg text-sm bg-white" />
          {q && (
            <button onClick={() => setQ('')} aria-label="Clear filter"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-[#8B7355] hover:text-[#2D1B0E]">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        {loading && <Loader2 className="w-4 h-4 animate-spin text-[#8B7355]" />}
        <span className="text-[11px] text-[#B9A896]">Read-only · click any cell for the item list</span>
      </div>

      {/* Board */}
      {filtered.length === 0 ? (
        <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-8 text-center text-sm text-[#8B7355]">
          <PackageX className="w-6 h-6 mx-auto mb-2 text-[#B9A896]" />
          {rows.length === 0
            ? `Nothing to show for ${date} — no counts recorded, and no materials carry a storage location.`
            : 'No storage area matches your filter.'}
          {rows.length === 0 && (
            <div className="mt-3">
              <div className="text-xs text-[#B9A896] mb-2">
                Storage locations are set per material on the Inventory page.
              </div>
              <Link href={`/closing-stock?date=${encodeURIComponent(date)}`}
                    className="text-[#af4408] hover:underline text-xs font-medium">
                Go to Closing Stock →
              </Link>
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Desktop / wide: the pivot. Scrolls inside its own box so the PAGE
              never scrolls sideways. */}
          <div className="hidden sm:block overflow-x-auto border border-[#E8D5C4] rounded-lg bg-white">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-[#FFF1E3] text-[#6B5744] text-xs">
                  <th className="text-left font-semibold px-3 py-2 sticky left-0 bg-[#FFF1E3] z-10 min-w-[190px]">
                    Storage area
                  </th>
                  {departments.map(d => (
                    <th key={d.key} className="text-right font-semibold px-3 py-2 min-w-[110px] whitespace-nowrap">
                      {d.name}
                      {n(d.sub_count) > 0 && (
                        <div className="text-[9px] font-normal text-[#B9A896] leading-none">
                          {n(d.sub_count)} sub-dept{n(d.sub_count) === 1 ? '' : 's'}
                        </div>
                      )}
                    </th>
                  ))}
                  <th className="text-right font-semibold px-3 py-2 min-w-[110px] bg-[#FBE7D3]">Total</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => {
                  const tint = rowTint(n(r.counted_items), n(r.total_items));
                  const denom = n(r.total_items);
                  return (
                    <tr key={r.location || UNASSIGNED} className={`border-t border-[#F0E4D6] ${tint.row}`}>
                      <td className={`px-3 py-2 sticky left-0 z-10 ${tint.sticky}`}>
                        <div className="font-medium text-[#2D1B0E] leading-tight">{locLabel(r.location)}</div>
                        <div className="text-[10px] text-[#8B7355]">
                          {n(r.counted_items).toLocaleString('en-IN')} / {denom.toLocaleString('en-IN')} counted
                        </div>
                      </td>
                      {departments.map(d => (
                        <td key={d.key} className="px-2 py-1.5 align-top relative group">
                          <CellButton
                            cell={r.by_dept?.[d.key]}
                            denom={n(r.by_dept?.[d.key]?.total) || denom}
                            onClick={() => openCell(r.location, d.key)}
                            active={drill?.location === r.location && drill?.deptKey === d.key}
                            label={`${locLabel(r.location)} · ${d.name}`}
                          />
                          <Link href={recordHref(date, r.location, d.key)}
                                title="Record closing stock for this area / department"
                                className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 focus:opacity-100 text-[#af4408]">
                            <ArrowUpRight className="w-3 h-3" />
                          </Link>
                        </td>
                      ))}
                      <td className="px-2 py-1.5 align-top relative group bg-[#FEF6EE]">
                        <CellButton
                          cell={{
                            counted: n(r.total?.counted),
                            physical_value: n(r.total?.physical_value),
                            system_value: nz(r.total?.system_value),
                            variance_value: nz(r.total?.variance_value),
                            shortage: null, excess: null,
                          }}
                          denom={denom}
                          strong
                          onClick={() => openCell(r.location, null)}
                          active={drill?.location === r.location && drill?.deptKey === null}
                          label={`${locLabel(r.location)} · all departments`}
                        />
                        <Link href={recordHref(date, r.location)}
                              title="Record closing stock for this area"
                              className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 focus:opacity-100 text-[#af4408]">
                          <ArrowUpRight className="w-3 h-3" />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                {/* Item COUNTS sum legitimately (they are line counts, not
                    quantities). Material quantities are never totalled anywhere
                    on this page — see the drill-down tfoot. */}
                <tr className="border-t-2 border-[#E8D5C4] bg-[#FFF1E3] font-semibold text-[#2D1B0E]">
                  <td className="px-3 py-2 sticky left-0 bg-[#FFF1E3] z-10">
                    Total · {summary.areas} area{summary.areas === 1 ? '' : 's'}
                  </td>
                  {departments.map(d => {
                    let counted = 0, value = 0;
                    for (const r of filtered) {
                      const c = r.by_dept?.[d.key];
                      if (!c) continue;
                      counted += n(c.counted); value += n(c.physical_value);
                    }
                    return (
                      <td key={d.key} className="px-3 py-2 text-right tabular-nums">
                        <div className="text-xs">{counted.toLocaleString('en-IN')}</div>
                        <div className="text-[11px] font-normal text-[#8B7355]">{inr(value)}</div>
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-right tabular-nums bg-[#FBE7D3]">
                    <div className="text-xs">
                      {summary.counted.toLocaleString('en-IN')} / {summary.items.toLocaleString('en-IN')}
                    </div>
                    <div className="text-[11px] font-normal text-[#af4408]">{inr(summary.value)}</div>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Mobile: one card per storage area, dept cells as chips */}
          <div className="sm:hidden space-y-2.5">
            {filtered.map(r => {
              const tint = rowTint(n(r.counted_items), n(r.total_items));
              const denom = n(r.total_items);
              return (
                <div key={r.location || UNASSIGNED} className={`border border-[#E8D5C4] rounded-lg p-3 ${tint.sticky}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-[#2D1B0E] leading-tight">{locLabel(r.location)}</div>
                      <div className="text-[11px] text-[#8B7355]">
                        {n(r.counted_items).toLocaleString('en-IN')} / {denom.toLocaleString('en-IN')} counted
                      </div>
                    </div>
                    <button onClick={() => openCell(r.location, null)} className="text-right shrink-0">
                      <div className="text-[10px] text-[#8B7355] uppercase tracking-wide">Total</div>
                      <div className="text-sm font-semibold text-[#2D1B0E] tabular-nums">
                        {n(r.total?.counted).toLocaleString('en-IN')}
                      </div>
                      <div className="text-[11px] text-[#af4408] font-medium">{inr(n(r.total?.physical_value))}</div>
                    </button>
                  </div>
                  <div className="mt-2 pt-2 border-t border-[#F0E4D6] grid grid-cols-2 gap-x-3 gap-y-1">
                    {departments.map(d => {
                      const c = r.by_dept?.[d.key];
                      return (
                        <button key={d.key} onClick={() => openCell(r.location, d.key)}
                                className="flex items-center justify-between gap-2 text-xs min-w-0">
                          <span className="text-[#6B5744] truncate min-w-0">{d.name}</span>
                          <span className="tabular-nums text-right shrink-0">
                            {c && n(c.counted) > 0 ? (
                              <>
                                <span className="text-[#2D1B0E]">{n(c.counted)}</span>
                                <span className="block text-[10px] text-[#8B7355]">{inr(n(c.physical_value))}</span>
                              </>
                            ) : <span className="text-[#B9A896]">—</span>}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <Link href={recordHref(date, r.location)}
                        className="mt-2 inline-flex items-center gap-1 text-[11px] text-[#af4408] hover:underline">
                    Record closing stock <ArrowUpRight className="w-3 h-3" />
                  </Link>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ── Drill-down ───────────────────────────────────────────────────── */}
      {drill && (
        <div className="border border-[#E8D5C4] rounded-lg bg-white">
          <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 border-b border-[#F0E4D6] bg-[#FFF8F0] rounded-t-lg">
            <div className="flex-1 min-w-[180px]">
              <div className="text-sm font-semibold text-[#2D1B0E]">
                {locLabel(drill.location)} <span className="text-[#B9A896] font-normal">·</span>{' '}
                <span className="text-[#6B5744] font-medium">{drillDeptName}</span>
              </div>
              <div className="text-[11px] text-[#8B7355]">
                {date} · {items.length.toLocaleString('en-IN')} item{items.length === 1 ? '' : 's'}
                {itemsSummary?.counted !== undefined && ` · ${n(itemsSummary.counted)} counted`}
                {itemsSummary?.physical_value !== undefined && itemsSummary.physical_value !== null &&
                  ` · ${inr(n(itemsSummary.physical_value))}`}
                {/* Variance is admin-only; absent for a blind counter. */}
                {nz(itemsSummary?.variance_value) !== null &&
                  ` · variance ${inr(n(itemsSummary?.variance_value))}`}
              </div>
            </div>
            <span className="flex items-center gap-1.5 text-xs text-[#6B5744]">
              <Toggle size="sm" checked={includeUncounted} onChange={setIncludeUncounted}
                      label="Include uncounted items" />
              Include uncounted
            </span>
            <button onClick={exportItems} disabled={items.length === 0}
                    className="px-2.5 py-1.5 bg-white border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 disabled:opacity-40 rounded-lg text-xs font-medium flex items-center gap-1">
              <Download className="w-3.5 h-3.5" /> CSV
            </button>
            <Link href={recordHref(date, drill.location, drill.deptKey)}
                  className="px-2.5 py-1.5 bg-[#af4408] text-white rounded-lg text-xs font-medium flex items-center gap-1 hover:bg-[#903905]">
              Record <ArrowUpRight className="w-3.5 h-3.5" />
            </Link>
            <button onClick={() => setDrill(null)} aria-label="Close item list"
                    className="text-[#8B7355] hover:text-[#2D1B0E] p-1">
              <X className="w-4 h-4" />
            </button>
          </div>

          {itemsLoading ? (
            <div className="p-8 text-center text-sm text-[#6B5744]">
              <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading items…
            </div>
          ) : itemsError ? (
            <div className={`m-3 rounded-lg p-3 text-sm flex items-center gap-2 ${
              /limited to|limited|authoriz|not authorized/i.test(itemsError)
                ? 'bg-amber-50 border border-amber-200 text-amber-900'
                : 'bg-red-50 border border-red-200 text-red-700'}`}>
              <AlertCircle className="w-4 h-4 shrink-0" />
              {/limited to|limited|authoriz|not authorized/i.test(itemsError) ? `🔒 ${itemsError}` : itemsError}
            </div>
          ) : items.length === 0 ? (
            <div className="p-8 text-center text-sm text-[#8B7355]">
              <PackageX className="w-6 h-6 mx-auto mb-2 text-[#B9A896]" />
              No counted items here for {date}.
              {!includeUncounted && (
                <div className="text-xs mt-1">Turn on “Include uncounted” to see everything stored in this area.</div>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-[#FFF1E3] text-[#6B5744] text-xs">
                    <th className="text-left font-semibold px-3 py-2 sticky left-0 bg-[#FFF1E3] z-10 min-w-[180px]">Material</th>
                    <th className="text-left font-semibold px-3 py-2 min-w-[110px]">Category</th>
                    <th className="text-left font-semibold px-3 py-2 min-w-[110px]">Department</th>
                    <th className="text-right font-semibold px-3 py-2 min-w-[110px]">Counted</th>
                    <th className="text-right font-semibold px-3 py-2 min-w-[100px]">System</th>
                    <th className="text-right font-semibold px-3 py-2 min-w-[100px]">Variance</th>
                    <th className="text-right font-semibold px-3 py-2 min-w-[90px] bg-[#FBE7D3]">Value</th>
                    <th className="px-2 py-2 w-8" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((r, i) => {
                    const meta = packMeta(r);
                    const phys = nz(r.physical_stock);
                    const sys = nz(r.system_stock);
                    const varq = nz(r.variance);
                    const val = nz(r.value);
                    const done = isCounted(r);
                    return (
                      <tr key={`${r.material_id || itemName(r)}-${r.department_id || ''}-${i}`}
                          className={`border-t border-[#F0E4D6] hover:bg-[#FFF8F0] ${done ? '' : 'bg-[#FDFBF8]'}`}>
                        <td className={`px-3 py-2 sticky left-0 z-10 ${done ? 'bg-white' : 'bg-[#FDFBF8]'}`}>
                          <div className="font-medium text-[#2D1B0E] leading-tight">{itemName(r)}</div>
                          {r.sku && <div className="text-[10px] text-[#B9A896]">{r.sku}</div>}
                        </td>
                        <td className="px-3 py-2 text-[#6B5744] text-xs">{r.category || '—'}</td>
                        <td className="px-3 py-2 text-[#6B5744] text-xs">{itemDept(r)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-[#2D1B0E]">
                          {phys === null
                            ? <span className="text-[#B9A896] text-xs" title="Not counted on this date">Not counted</span>
                            : <Qty d={dualQty(phys, meta)} meta={meta} strong />}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-[#6B5744]">
                          {sys === null
                            ? <span className="text-[#B9A896]" title={BLIND_HINT}>—</span>
                            : <Qty d={dualQty(sys, meta)} meta={meta} />}
                        </td>
                        <td className={`px-3 py-2 text-right tabular-nums ${
                          varq === null ? '' : varq < 0 ? 'text-red-700' : varq > 0 ? 'text-emerald-700' : 'text-[#6B5744]'}`}>
                          {varq === null
                            ? <span className="text-[#B9A896]" title={BLIND_HINT}>—</span>
                            : <Qty d={dualQty(varq, meta)} meta={meta} />}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums bg-[#FEF6EE] text-[#2D1B0E]">
                          {val === null ? <span className="text-[#B9A896]">—</span> : inr(val)}
                        </td>
                        <td className="px-2 py-2 text-right">
                          <Link href={recordHref(date, drill.location, r.department_id || drill.deptKey)}
                                title="Open this area in the record flow"
                                className="text-[#af4408] inline-flex">
                            <ArrowUpRight className="w-3.5 h-3.5" />
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-[#E8D5C4] bg-[#FFF1E3] font-semibold text-[#2D1B0E]">
                    <td className="px-3 py-2 sticky left-0 bg-[#FFF1E3] z-10">Total</td>
                    <td className="px-3 py-2" />
                    <td className="px-3 py-2" />
                    {/* Quantity totals stay "—": summing ml + g + pcs across
                        materials is meaningless in ANY unit basis. The ₹ total
                        (right) is the only valid aggregate. */}
                    <td className="px-3 py-2 text-right text-xs text-[#B9A896]">—</td>
                    <td className="px-3 py-2 text-right text-xs text-[#B9A896]">—</td>
                    <td className="px-3 py-2 text-right text-xs text-[#B9A896]">—</td>
                    <td className="px-3 py-2 text-right tabular-nums bg-[#FBE7D3]">
                      {inr(nz(itemsSummary?.physical_value) ?? items.reduce((a, r) => a + n(r.value), 0))}
                    </td>
                    <td className="px-2 py-2" />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Pieces ────────────────────────────────────────────────────────────── */

/** Progress tint. The sticky first cell needs an OPAQUE class of its own or the
 *  scrolled columns show through it. */
function rowTint(counted: number, total: number) {
  if (total > 0 && counted >= total) return { row: 'bg-emerald-50/70', sticky: 'bg-emerald-50' };
  if (counted > 0) return { row: 'bg-amber-50/70', sticky: 'bg-amber-50' };
  return { row: 'bg-red-50/60', sticky: 'bg-red-50' };
}

function CellButton({ cell, denom, onClick, active, strong, label }: {
  cell: Cell | undefined;
  denom: number;
  onClick: () => void;
  active?: boolean;
  strong?: boolean;
  label: string;
}) {
  const counted = n(cell?.counted);
  const value = n(cell?.physical_value);
  const empty = !cell || (counted === 0 && value === 0);
  const shortage = nz(cell?.shortage);
  const excess = nz(cell?.excess);
  return (
    <button
      type="button" onClick={onClick} title={`${label} — open item list`}
      className={`w-full text-right rounded px-1.5 py-1 transition-colors ${
        active ? 'ring-1 ring-[#af4408] bg-white' : 'hover:bg-white/70'}`}
    >
      {empty ? (
        <span className="text-[#B9A896] text-xs">—</span>
      ) : (
        <>
          <div className={`text-xs tabular-nums text-[#2D1B0E] ${strong ? 'font-semibold' : ''}`}>
            {counted.toLocaleString('en-IN')}
            <span className="text-[#B9A896] font-normal"> / {denom.toLocaleString('en-IN')}</span>
          </div>
          <div className="text-[11px] tabular-nums text-[#8B7355] leading-tight">{inr(value)}</div>
          {(shortage !== null && shortage > 0) || (excess !== null && excess > 0) ? (
            <div className="flex items-center justify-end gap-1 mt-0.5">
              {shortage !== null && shortage > 0 && (
                <span title={`${shortage} item${shortage === 1 ? '' : 's'} short of system`}
                      className="px-1 rounded bg-red-100 text-red-700 text-[9px] font-medium leading-4">
                  ▼ {shortage}
                </span>
              )}
              {excess !== null && excess > 0 && (
                <span title={`${excess} item${excess === 1 ? '' : 's'} over system`}
                      className="px-1 rounded bg-emerald-100 text-emerald-700 text-[9px] font-medium leading-4">
                  ▲ {excess}
                </span>
              )}
            </div>
          ) : null}
        </>
      )}
    </button>
  );
}

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
