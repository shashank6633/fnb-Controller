'use client';

/**
 * Menu Engineering — popularity × profitability matrix (Stars / Plowhorses /
 * Puzzles / Dogs) over a 7/30/90-day sales window.
 *
 * Gate: admin or HOD (is_head_chef) — financial data, same pattern as
 * /crm/settings. Data from GET /api/menu-engineering?days=N.
 *
 * Mobile-first: quadrant grid stacks 1-col on phones, table scrolls sideways,
 * days selector is a scrollable pill strip.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, BarChart3, Loader2, AlertCircle, ChevronDown, ChevronRight,
  ArrowUpDown, ArrowUp, ArrowDown,
} from 'lucide-react';

type Quadrant = 'star' | 'plowhorse' | 'puzzle' | 'dog';

interface Item {
  name: string;
  category: string;
  qty_sold: number;
  revenue: number;
  avg_price: number;
  cost_unit: number;
  margin_unit: number;
  margin_pct: number;
  contribution: number;
  quadrant: Quadrant;
}

interface UncostedItem {
  name: string;
  category: string;
  qty_sold: number;
  revenue: number;
  reason: 'no_recipe' | 'no_cost';
}

interface Report {
  days: number;
  medians: { qty: number; margin_pct: number };
  items: Item[];
  quadrants: Record<Quadrant, Item[]>;
  uncosted: UncostedItem[];
  freshness: { latest_sale_date: string | null };
}

const DAY_OPTIONS = [7, 30, 90] as const;

const QUADRANT_META: Record<Quadrant, {
  title: string; emoji: string; advice: string;
  card: string; badge: string; accentText: string;
}> = {
  star: {
    title: 'Stars', emoji: '⭐', advice: 'High sales, high margin — promote & protect',
    card: 'bg-emerald-50 border-emerald-200', badge: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    accentText: 'text-emerald-800',
  },
  plowhorse: {
    title: 'Plowhorses', emoji: '🐴', advice: 'Popular but thin margin — reprice or reduce cost',
    card: 'bg-amber-50 border-amber-200', badge: 'bg-amber-100 text-amber-800 border-amber-200',
    accentText: 'text-amber-800',
  },
  puzzle: {
    title: 'Puzzles', emoji: '🧩', advice: 'Profitable but slow — promote or reposition',
    card: 'bg-sky-50 border-sky-200', badge: 'bg-sky-100 text-sky-800 border-sky-200',
    accentText: 'text-sky-800',
  },
  dog: {
    title: 'Dogs', emoji: '🐶', advice: 'Low sales, low margin — consider dropping',
    card: 'bg-rose-50 border-rose-200', badge: 'bg-rose-100 text-rose-800 border-rose-200',
    accentText: 'text-rose-800',
  },
};

const QUADRANT_ORDER: Quadrant[] = ['star', 'plowhorse', 'puzzle', 'dog'];

const inr = (n: number) =>
  '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const inr2 = (n: number) =>
  '₹' + (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (n: number) =>
  (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

/** Sales considered stale when the latest sale predates yesterday. */
function staleDays(latest: string | null): number | null {
  if (!latest) return null;
  const ms = Date.now() - new Date(latest + 'T00:00:00').getTime();
  const d = Math.floor(ms / 86400000);
  return d > 1 ? d : null;
}

type SortKey = keyof Pick<Item,
  'name' | 'qty_sold' | 'revenue' | 'cost_unit' | 'margin_unit' | 'margin_pct' | 'contribution' | 'quadrant'>;

const COLUMNS: { key: SortKey; label: string; numeric?: boolean }[] = [
  { key: 'name',         label: 'Item' },
  { key: 'qty_sold',     label: 'Qty',            numeric: true },
  { key: 'revenue',      label: 'Revenue',        numeric: true },
  { key: 'cost_unit',    label: 'Cost/unit',      numeric: true },
  { key: 'margin_unit',  label: 'Margin/unit',    numeric: true },
  { key: 'margin_pct',   label: 'Margin %',       numeric: true },
  { key: 'contribution', label: 'Contribution ₹', numeric: true },
  { key: 'quadrant',     label: 'Quadrant' },
];

export default function MenuEngineeringPage() {
  const router = useRouter();
  const [me, setMe] = useState<any>(undefined);   // undefined = loading, null = signed out
  const [days, setDays] = useState<number>(30);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('contribution');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [showUncosted, setShowUncosted] = useState(false);

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.json())
      .then(d => setMe(d?.user ?? null))
      .catch(() => setMe(null));
  }, []);

  const load = useCallback(async (d: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/menu-engineering?days=${d}`, { credentials: 'same-origin' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      setReport(json as Report);
    } catch (e: any) {
      setError(e?.message || 'Failed to load report');
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const allowed = me && (me.role === 'admin' || me.is_head_chef);

  useEffect(() => {
    if (allowed) load(days);
  }, [allowed, days, load]);

  const sortedItems = useMemo(() => {
    if (!report) return [];
    const items = [...report.items];
    items.sort((a, b) => {
      const av = a[sortKey]; const bv = b[sortKey];
      let cmp: number;
      if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
      else cmp = String(av).localeCompare(String(bv));
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return items;
  }, [report, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(key === 'name' || key === 'quadrant' ? 'asc' : 'desc'); }
  };

  /* ── gates ── */
  if (me === undefined) {
    return (
      <div className="p-8 text-center text-sm text-[#8B7355]">
        <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…
      </div>
    );
  }
  if (!allowed) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
          🔒 Admins and HODs only. Menu engineering shows recipe costs and margins.
        </div>
      </div>
    );
  }

  const stale = report ? staleDays(report.freshness?.latest_sale_date ?? null) : null;

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-6xl mx-auto">
      {/* Header */}
      <div>
        <button
          onClick={() => router.back()}
          className="inline-flex items-center gap-1 text-sm text-[#6B5744] hover:text-[#2D1B0E] transition-colors mb-2"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
          <BarChart3 className="w-6 h-6 text-[#af4408]" /> Menu Engineering
        </h1>
        <p className="text-xs text-[#6B5744] mt-0.5">
          Popularity × profitability matrix — classify dishes vs the window medians and act per quadrant.
        </p>
      </div>

      {/* Days selector — scrollable pill strip (mobile pattern) */}
      <div
        className="flex gap-2 overflow-x-auto flex-nowrap [&::-webkit-scrollbar]:hidden"
        style={{ scrollbarWidth: 'none' }}
      >
        {DAY_OPTIONS.map(d => (
          <button
            key={d}
            onClick={() => setDays(d)}
            className={`shrink-0 px-3 py-1.5 rounded-lg text-sm border transition-colors ${
              days === d
                ? 'bg-[#af4408] border-[#af4408] text-white'
                : 'bg-white border-[#E8D5C4] text-[#6B5744] hover:bg-[#FFF1E3]'
            }`}
          >
            Last {d} days
          </button>
        ))}
      </div>

      {/* Freshness warning */}
      {stale != null && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          Sales data looks stale — last sale on record is {report?.freshness.latest_sale_date} ({stale} days ago). Upload recent sales for an accurate matrix.
        </div>
      )}

      {/* States */}
      {loading && (
        <div className="p-10 text-center text-sm text-[#8B7355]">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Crunching the matrix…
        </div>
      )}
      {!loading && error && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg p-4 text-sm text-rose-900 flex items-center justify-between gap-3">
          <span className="flex items-center gap-2"><AlertCircle className="w-4 h-4" /> {error}</span>
          <button
            onClick={() => load(days)}
            className="shrink-0 px-3 py-1 rounded-lg border border-rose-300 text-rose-800 text-xs hover:bg-rose-100"
          >
            Retry
          </button>
        </div>
      )}
      {!loading && !error && report && report.items.length === 0 && (
        <div className="bg-white border border-[#E8D5C4] rounded-lg p-8 text-center text-sm text-[#6B5744]">
          No costed sales in the last {report.days} days.
          {report.uncosted.length > 0
            ? ` ${report.uncosted.length} sold item(s) have no recipe cost — see “Uncosted items” below.`
            : ' Upload sales and add recipes to build the matrix.'}
        </div>
      )}

      {!loading && !error && report && report.items.length > 0 && (
        <>
          {/* Medians line */}
          <p className="text-xs text-[#8B7355]">
            {report.items.length} items classified · median qty {num(report.medians.qty)} · median margin {num(report.medians.margin_pct)}% · “high” = at or above median
          </p>

          {/* 2×2 quadrant grid (1-col on phones) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {QUADRANT_ORDER.map(q => {
              const meta = QUADRANT_META[q];
              const list = report.quadrants[q] || [];
              return (
                <div key={q} className={`rounded-xl border p-4 ${meta.card}`}>
                  <div className="flex items-baseline justify-between gap-2">
                    <h2 className={`font-semibold ${meta.accentText}`}>
                      {meta.emoji} {meta.title}
                      <span className="ml-1.5 text-xs font-normal opacity-70">({list.length})</span>
                    </h2>
                  </div>
                  <p className={`text-[11px] mt-0.5 ${meta.accentText} opacity-80`}>{meta.advice}</p>
                  {list.length === 0 ? (
                    <p className="text-xs text-[#8B7355] mt-3">No items in this quadrant.</p>
                  ) : (
                    <ul className="mt-3 space-y-1.5">
                      {list.slice(0, 6).map(it => (
                        <li key={it.name} className="flex items-center justify-between gap-2 text-sm">
                          <span className="flex-1 min-w-0 truncate text-[#2D1B0E]">{it.name}</span>
                          <span className="shrink-0 text-xs text-[#6B5744] tabular-nums">
                            {num(it.qty_sold)} sold · {num(it.margin_pct)}% · {inr(it.contribution)}
                          </span>
                        </li>
                      ))}
                      {list.length > 6 && (
                        <li className="text-[11px] text-[#8B7355]">+ {list.length - 6} more in the table below</li>
                      )}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>

          {/* Full sortable table */}
          <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[720px]">
                <thead>
                  <tr className="bg-[#FFF1E3] text-[#6B5744] text-xs">
                    {COLUMNS.map(col => (
                      <th key={col.key} className={`px-3 py-2 font-medium ${col.numeric ? 'text-right' : 'text-left'}`}>
                        <button
                          onClick={() => toggleSort(col.key)}
                          className="inline-flex items-center gap-1 hover:text-[#2D1B0E]"
                        >
                          {col.label}
                          {sortKey === col.key
                            ? (sortDir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)
                            : <ArrowUpDown className="w-3 h-3 opacity-40" />}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedItems.map(it => {
                    const meta = QUADRANT_META[it.quadrant];
                    return (
                      <tr key={it.name} className="border-t border-[#F3E6D8]">
                        <td className="px-3 py-2 text-[#2D1B0E]">{it.name}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{num(it.qty_sold)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{inr(it.revenue)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{inr2(it.cost_unit)}</td>
                        <td className={`px-3 py-2 text-right tabular-nums ${it.margin_unit < 0 ? 'text-rose-700' : ''}`}>{inr2(it.margin_unit)}</td>
                        <td className={`px-3 py-2 text-right tabular-nums ${it.margin_pct < 0 ? 'text-rose-700' : ''}`}>{num(it.margin_pct)}%</td>
                        <td className="px-3 py-2 text-right tabular-nums">{inr(it.contribution)}</td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] ${meta.badge}`}>
                            {meta.emoji} {meta.title.slice(0, -1)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* Uncosted items — collapsible */}
      {!loading && !error && report && report.uncosted.length > 0 && (
        <div className="bg-white border border-[#E8D5C4] rounded-xl">
          <button
            onClick={() => setShowUncosted(v => !v)}
            className="w-full flex items-center justify-between px-4 py-3 text-sm text-[#2D1B0E]"
          >
            <span className="font-medium">
              Uncosted items <span className="text-xs font-normal text-[#8B7355]">({report.uncosted.length} sold without a recipe cost)</span>
            </span>
            {showUncosted ? <ChevronDown className="w-4 h-4 text-[#8B7355]" /> : <ChevronRight className="w-4 h-4 text-[#8B7355]" />}
          </button>
          {showUncosted && (
            <div className="px-4 pb-4 space-y-2">
              <p className="text-xs text-[#6B5744]">
                These sold in the window but have no matching recipe (or the recipe has no cost), so they can’t be classified. Add or cost a recipe with the exact item name on the <span className="font-medium">Recipes</span> page to include them.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[420px]">
                  <thead>
                    <tr className="bg-[#FFF1E3] text-[#6B5744] text-xs">
                      <th className="px-3 py-2 text-left font-medium">Item</th>
                      <th className="px-3 py-2 text-right font-medium">Qty</th>
                      <th className="px-3 py-2 text-right font-medium">Revenue</th>
                      <th className="px-3 py-2 text-left font-medium">Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.uncosted.map(u => (
                      <tr key={u.name} className="border-t border-[#F3E6D8]">
                        <td className="px-3 py-2 text-[#2D1B0E]">{u.name}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{num(u.qty_sold)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{inr(u.revenue)}</td>
                        <td className="px-3 py-2 text-xs text-[#6B5744]">
                          {u.reason === 'no_recipe' ? 'No recipe with this name' : 'Recipe has no cost'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
