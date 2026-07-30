'use client';

/**
 * DEPARTMENT CLOSING SHEET — every active department on ONE sheet, for physical
 * stock entry and reporting (owner requirement 5).
 *
 * ── WHY A SIBLING OF /inventory/closing-overview, NOT AN EXTENSION ─────────
 * closing-overview is a READ-ONLY board whose rows are STORAGE AREAS and whose
 * columns are MAIN departments, with sub-departments folded into their parent.
 * It states in its own header that it never writes, and the fold is what makes
 * it readable. This sheet is the opposite shape on all three counts: rows are
 * MATERIALS, sub-departments stay separate (a count belongs to exactly ONE
 * department — folding "Akan Tandoori" into "Kitchen" would make entry
 * ambiguous), and it WRITES. Bolting entry onto the pivot would have meant one
 * page with two axes and two verbs. They deep-link to each other instead.
 *
 * ── DEPARTMENTS ARE READ AT RUNTIME ────────────────────────────────────────
 * The department list comes from the `departments` table via the API — nothing
 * here is hardcoded. Create "Cold Room" on /departments and it appears on this
 * sheet at the next load, with an empty item set until something is issued to
 * it or counted in it.
 *
 * ── UNITS ──────────────────────────────────────────────────────────────────
 * Every quantity LEADS in the PURCHASE unit (the unit the counter is holding),
 * with the recipe figure as the small declared hint. Entry is in purchase units
 * and converts through packFactor before posting; the wire and the DB stay in
 * RECIPE units, unchanged.
 *
 * ── MONEY vs QUANTITY TOTALS ───────────────────────────────────────────────
 * Rupees total. Quantities do NOT: 2 BTL + 3 kg + 400 pcs is not a number in
 * any basis, so every quantity subtotal on this page prints an em-dash.
 *
 * ── BLIND COUNTS ───────────────────────────────────────────────────────────
 * System stock and variance are ADMIN-ONLY and are stripped by the API — for a
 * non-admin those keys never arrive, so the columns are not rendered at all.
 * `data.is_admin` (server-decided) is the only switch; there is no client-side
 * role guess anywhere on this page.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import Papa from 'papaparse';
import {
  ClipboardCheck, Loader2, AlertCircle, Download, Save, Search, X,
  CalendarDays, IndianRupee, Layers, Building2, ChevronDown, ChevronRight,
  PackageX, ArrowUpRight, CheckCircle2,
} from 'lucide-react';
import Toggle from '@/components/Toggle';
import Qty from '@/components/Qty';
// /api/closing-stock is a CSRF-required prefix in proxy.ts, and this route sits
// under it — a raw fetch POST is rejected 403. Always post through api().
import { api } from '@/lib/api';
import {
  csvQty, dualQty, fmtQtyNum, packFactor, toPurchaseQty, type PackMeta,
} from '@/lib/pack-units';
import { todayIST, fmtIST } from '@/lib/format-date';

/* ── Wire types (the /api/closing-stock/dept-sheet contract) ─────────────── */

interface SheetItem {
  material_id: string;
  name: string;
  sku: string;
  category: string;
  unit: string;
  purchase_unit: string;
  pack_size: number | null;
  case_size: number | null;
  pack_factor: number;
  is_active: boolean;
  counted: boolean;
  /** RECIPE units, as stored. */
  physical_stock: number | null;
  rate_per_purchase_unit: number | null;
  rate_source: string;
  rate_as_of: string | null;
  rate_at_count: boolean;
  value: number | null;
  notes: string;
  recorded_by: string;
  /** Admin-only — absent from the payload for everyone else. */
  system_stock?: number | null;
  variance?: number | null;
  variance_value?: number | null;
}

interface SheetDept {
  id: string;
  name: string;
  parent_id: string | null;
  parent_name: string;
  group: string;
  area: string;
  is_active: boolean;
  items: SheetItem[];
  totals: {
    items: number; counted: number; uncounted: number;
    value: number; unpriced: number; variance_value?: number;
  };
}

interface Sheet {
  date: string;
  is_admin: boolean;
  scope: 'all' | 'limited';
  departments: SheetDept[];
  totals: {
    departments: number; items: number; counted: number; uncounted: number;
    value: number; unpriced: number; variance_value?: number;
  };
  generated_at?: string;
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

const inr = (v: number, dp = 0) =>
  '₹' + (Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: dp });
const inr2 = (v: number) => inr(v, 2);
const EM = '—';

const packMeta = (r: SheetItem): PackMeta => ({
  unit: r.unit, purchase_unit: r.purchase_unit,
  pack_size: r.pack_size, case_size: r.case_size,
});

/**
 * Purchase-unit entry → RECIPE units, the stored basis. Goes through the shared
 * packFactor guard (pack_size > 1 AND recipe unit ≠ purchase unit); never a
 * local `* pack_size`, which mis-converts kg/kg materials like PICKLED GINGER.
 */
const toRecipeQty = (purchaseQty: number, m: PackMeta) =>
  Math.round((Number(purchaseQty) || 0) * packFactor(m) * 1000) / 1000;

const key = (deptId: string, materialId: string) => `${deptId}|${materialId}`;

const RATE_LABEL: Record<string, string> = {
  last_purchase: 'last purchase',
  average_cost: 'average cost',
  none: 'no basis',
};

const BLIND_NOTE = 'System stock and variance are admin-only (blind count).';

/* ── Page ────────────────────────────────────────────────────────────────── */

export default function ClosingSheetPage() {
  const [date, setDate] = useState(todayIST);
  const [data, setData] = useState<Sheet | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  /** Keyed dept|material → the count as typed, in PURCHASE units. */
  const [entries, setEntries] = useState<Record<string, string>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState('');
  const [onlyUncounted, setOnlyUncounted] = useState(false);
  const [hideEmpty, setHideEmpty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});

  /* Load. Seeds the entry boxes from whatever is already recorded for the date,
   * converted to purchase units so the box reads in the same basis it posts. */
  const load = useCallback(async (d: string) => {
    setLoading(true); setError('');
    try {
      const res = await fetch(`/api/closing-stock/dept-sheet?date=${encodeURIComponent(d)}`,
                              { credentials: 'same-origin' });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      const sheet: Sheet = {
        date: json?.date || d,
        is_admin: !!json?.is_admin,
        scope: json?.scope === 'limited' ? 'limited' : 'all',
        departments: Array.isArray(json?.departments) ? json.departments : [],
        totals: json?.totals || { departments: 0, items: 0, counted: 0, uncounted: 0, value: 0, unpriced: 0 },
        generated_at: json?.generated_at || '',
      };
      const seed: Record<string, string> = {};
      for (const dept of sheet.departments) {
        for (const it of dept.items) {
          if (it.counted && it.physical_stock != null) {
            seed[key(dept.id, it.material_id)] = String(toPurchaseQty(it.physical_stock, packMeta(it)));
          }
        }
      }
      setData(sheet);
      setEntries(seed);
    } catch (e: unknown) {
      // Keep the sheet that is already on screen: blanking it on a flaky refresh
      // would throw away typed-but-unsaved counts.
      setError((e as Error)?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(date); }, [date, load]);

  const isAdmin = !!data?.is_admin;
  const departments = useMemo(() => data?.departments ?? [], [data]);

  /* Filtered view — what the user is actually looking at. */
  const view = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return departments.map(d => {
      const items = d.items.filter(it => {
        if (onlyUncounted && it.counted) return false;
        if (!needle) return true;
        return it.name.toLowerCase().includes(needle)
          || (it.sku || '').toLowerCase().includes(needle)
          || (it.category || '').toLowerCase().includes(needle);
      });
      return { dept: d, items };
    }).filter(x => !(hideEmpty && x.items.length === 0));
  }, [departments, q, onlyUncounted, hideEmpty]);

  /**
   * LIVE per-department figures over the filtered rows, including counts typed
   * but not yet saved. Rupees only — quantities are never summed across
   * materials anywhere on this page.
   */
  const deptCalc = useMemo(() => {
    const out = new Map<string, { counted: number; value: number; unpriced: number; dirty: number }>();
    for (const { dept, items } of view) {
      let counted = 0, value = 0, unpriced = 0, dirty = 0;
      for (const it of items) {
        const meta = packMeta(it);
        const raw = entries[key(dept.id, it.material_id)];
        const typed = raw !== undefined && raw !== '' && isFinite(Number(raw));
        const recipeQty = typed ? toRecipeQty(Number(raw), meta) : null;
        const changed = typed && (!it.counted || Math.abs(recipeQty! - (it.physical_stock ?? 0)) > 1e-6);
        if (changed) dirty++;
        if (!typed && !it.counted) continue;
        counted++;
        // No rate basis at all → the row carries no rupee figure. Counting a
        // confident 0 into a department total is exactly the lie to avoid.
        if (it.rate_per_purchase_unit == null) { unpriced++; continue; }
        if (changed) value += toPurchaseQty(recipeQty!, meta) * it.rate_per_purchase_unit;
        else value += it.value ?? 0;
      }
      out.set(dept.id, { counted, value: Math.round(value * 100) / 100, unpriced, dirty });
    }
    return out;
  }, [view, entries]);

  const sheetCalc = useMemo(() => {
    let items = 0, counted = 0, value = 0, unpriced = 0, dirty = 0;
    for (const { dept, items: rows } of view) {
      const c = deptCalc.get(dept.id);
      items += rows.length;
      counted += c?.counted ?? 0;
      value += c?.value ?? 0;
      unpriced += c?.unpriced ?? 0;
      dirty += c?.dirty ?? 0;
    }
    return { items, counted, value: Math.round(value * 100) / 100, unpriced, dirty };
  }, [view, deptCalc]);

  /* ── Save ──────────────────────────────────────────────────────────────── */

  const saveAll = async () => {
    if (!data) return;
    const payload: { department_id: string; material_id: string; physical_stock: number }[] = [];
    for (const dept of departments) {
      for (const it of dept.items) {
        const raw = entries[key(dept.id, it.material_id)];
        if (raw === undefined || raw === '' || !isFinite(Number(raw))) continue;
        const n = Number(raw);
        if (n < 0) continue;
        const recipeQty = toRecipeQty(n, packMeta(it));
        if (it.counted && Math.abs(recipeQty - (it.physical_stock ?? 0)) <= 1e-6) continue;
        payload.push({ department_id: dept.id, material_id: it.material_id, physical_stock: recipeQty });
      }
    }
    if (payload.length === 0) { setFlash({ tone: 'warn', text: 'Nothing new to save.' }); return; }
    setSaving(true); setFlash(null);
    try {
      const res = await api('/api/closing-stock/dept-sheet', {
        method: 'POST',
        body: { date, entries: payload },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      const errs: string[] = Array.isArray(json?.errors) ? json.errors : [];
      setFlash({
        tone: errs.length ? 'warn' : 'ok',
        text: `Saved ${json?.saved ?? 0} count${json?.saved === 1 ? '' : 's'}`
          + (json?.pending ? ` · ${json.pending} sent for variance approval` : '')
          + (errs.length ? ` · ${errs.length} skipped: ${errs.slice(0, 2).join(' | ')}` : ''),
      });
      await load(date);
    } catch (e: unknown) {
      setFlash({ tone: 'warn', text: (e as Error)?.message || 'Save failed' });
    } finally {
      setSaving(false);
    }
  };

  /* ── CSV ───────────────────────────────────────────────────────────────── */

  const exportCsv = () => {
    // Purchase columns lead (what the store reads); the recipe figures follow as
    // the exact stored truth the rupee column is derived from.
    const header = [
      'Department', 'Material', 'SKU', 'Category', 'Counted',
      'Purchase Unit', 'Counted Qty', 'Recipe Unit', 'Counted Qty (recipe)',
      'Rate (₹/purchase unit)', 'Rate Source', 'Rate at count time', 'Value (₹)',
      ...(isAdmin ? ['System Qty', 'System Qty (recipe)', 'Variance Qty', 'Variance Qty (recipe)', 'Variance (₹)'] : []),
    ];
    const body: (string | number)[][] = [];
    for (const { dept, items } of view) {
      for (const it of items) {
        const meta = packMeta(it);
        const phys = it.physical_stock;
        const sys = it.system_stock ?? null;
        const varq = it.variance ?? null;
        body.push([
          dept.name, it.name, it.sku, it.category, it.counted ? 'yes' : 'no',
          it.purchase_unit,
          phys == null ? '' : csvQty(toPurchaseQty(phys, meta)),
          it.unit,
          phys == null ? '' : csvQty(phys),
          it.rate_per_purchase_unit ?? '',
          RATE_LABEL[it.rate_source] || it.rate_source,
          it.counted ? (it.rate_at_count ? 'yes' : 'no') : '',
          it.value ?? '',
          ...(isAdmin ? [
            sys == null ? '' : csvQty(toPurchaseQty(sys, meta)),
            sys == null ? '' : csvQty(sys),
            varq == null ? '' : csvQty(toPurchaseQty(varq, meta)),
            varq == null ? '' : csvQty(varq),
            it.variance_value ?? '',
          ] : []),
        ]);
      }
      // Quantity subtotals are deliberately blank — see the tfoot comment.
      body.push([
        `${dept.name} — TOTAL`, '', '', '', String(deptCalc.get(dept.id)?.counted ?? 0),
        '', '', '', '', '', '', '', deptCalc.get(dept.id)?.value ?? 0,
        ...(isAdmin ? ['', '', '', '', dept.totals.variance_value ?? ''] : []),
      ]);
    }
    const csv = Papa.unparse([header, ...body]);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `department-closing-sheet-${date}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  /* ── Render ────────────────────────────────────────────────────────────── */

  if (loading && !data) {
    return (
      <div className="p-6 max-w-3xl mx-auto text-sm text-[#6B5744]">
        <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading department closing sheet…
      </div>
    );
  }

  if (error && !data) {
    const denied = /limited|authoriz/i.test(error);
    return (
      <div className="p-6 max-w-3xl mx-auto space-y-3">
        <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
          <ClipboardCheck className="w-6 h-6 text-[#af4408]" /> Department Closing Sheet
        </h1>
        <div className={`rounded-lg p-4 text-sm flex items-center gap-2 ${
          denied ? 'bg-amber-50 border border-amber-200 text-amber-900'
                 : 'bg-red-50 border border-red-200 text-red-700'}`}>
          <AlertCircle className="w-4 h-4 shrink-0" /> {denied ? `🔒 ${error}` : error}
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto space-y-4 pb-24">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex-1 min-w-[240px]">
          <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
            <ClipboardCheck className="w-6 h-6 text-[#af4408]" /> Department Closing Sheet
          </h1>
          <p className="text-xs text-[#6B5744] mt-0.5">
            Every active department on one sheet — count each item where it sits.
            {data?.generated_at && <span className="text-[#B9A896]"> · as of {fmtIST(data.generated_at)}</span>}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <CalendarDays className="w-4 h-4 text-[#8B7355]" />
          <input type="date" value={date} onChange={e => setDate(e.target.value || todayIST())}
                 className="px-2.5 py-2 border border-[#E8D5C4] rounded-lg text-sm bg-white text-[#2D1B0E]" />
        </div>
        <button onClick={exportCsv} disabled={sheetCalc.items === 0}
                className="px-3 py-2 bg-white border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 disabled:opacity-40 rounded-lg text-sm font-medium flex items-center gap-1.5">
          <Download className="w-4 h-4" /> Export CSV
        </button>
        <button onClick={saveAll} disabled={saving || sheetCalc.dirty === 0}
                className="px-3 py-2 bg-[#af4408] text-white hover:bg-[#903905] disabled:opacity-40 rounded-lg text-sm font-medium flex items-center gap-1.5">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Save {sheetCalc.dirty > 0 ? `${sheetCalc.dirty} count${sheetCalc.dirty === 1 ? '' : 's'}` : 'counts'}
        </button>
      </div>

      {flash && (
        <div className={`rounded-lg p-3 text-sm flex items-center gap-2 ${
          flash.tone === 'ok' ? 'bg-emerald-50 border border-emerald-200 text-emerald-800'
                              : 'bg-amber-50 border border-amber-200 text-amber-900'}`}>
          {flash.tone === 'ok' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
          {flash.text}
        </div>
      )}
      {error && data && (
        <div className="rounded-lg p-3 text-sm flex items-center gap-2 bg-red-50 border border-red-200 text-red-700">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}
      {data?.scope === 'limited' && (
        <div className="rounded-lg p-3 text-xs flex items-center gap-2 bg-[#FFF8F0] border border-[#E8D5C4] text-[#6B5744]">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 text-[#8B7355]" />
          Showing only the departments you are assigned to or have been granted.
        </div>
      )}

      {/* Sheet summary */}
      <div className={`grid grid-cols-2 md:grid-cols-3 gap-2.5 ${isAdmin ? 'lg:grid-cols-5' : 'lg:grid-cols-4'}`}>
        <SummaryCard icon={<Building2 className="w-4 h-4" />} label="Departments"
                     value={view.length.toLocaleString('en-IN')} />
        <SummaryCard icon={<Layers className="w-4 h-4" />} label="Items counted"
                     value={`${sheetCalc.counted.toLocaleString('en-IN')} / ${sheetCalc.items.toLocaleString('en-IN')}`} />
        <SummaryCard icon={<PackageX className="w-4 h-4" />} label="Uncounted"
                     value={Math.max(0, sheetCalc.items - sheetCalc.counted).toLocaleString('en-IN')}
                     tone={sheetCalc.items - sheetCalc.counted > 0 ? 'warn' : 'muted'} />
        <SummaryCard icon={<IndianRupee className="w-4 h-4" />} label="Sheet value"
                     value={inr(sheetCalc.value)}
                     note={sheetCalc.unpriced > 0 ? `${sheetCalc.unpriced} item${sheetCalc.unpriced === 1 ? '' : 's'} have no rate basis — excluded` : undefined} />
        {isAdmin && (
          <SummaryCard icon={<IndianRupee className="w-4 h-4" />} label="Variance (admin)"
                       value={inr(data?.totals.variance_value ?? 0)}
                       tone={(data?.totals.variance_value ?? 0) < 0 ? 'warn' : 'muted'} />
        )}
      </div>

      {/* Department strip — EVERY department in scope, including empty ones. A
          department created later (e.g. Cold Room) shows up here on next load. */}
      <div className="bg-white border border-[#E8D5C4] rounded-lg p-2.5">
        <div className="text-[11px] font-medium text-[#8B7355] mb-1.5">
          Departments on this sheet ({departments.length}) — read live from the Departments list
        </div>
        <div className="flex flex-wrap gap-1.5">
          {departments.map(d => {
            const c = deptCalc.get(d.id);
            const total = d.totals.items;
            const done = total > 0 && (c?.counted ?? 0) >= total;
            return (
              <button key={d.id}
                      onClick={() => {
                        setCollapsed(p => ({ ...p, [d.id]: false }));
                        sectionRefs.current[d.id]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      }}
                      className={`px-2 py-1 rounded-full text-[11px] border transition-colors ${
                        total === 0 ? 'bg-[#FDFBF8] border-[#EFE3D6] text-[#B9A896]'
                        : done ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                        : (c?.counted ?? 0) > 0 ? 'bg-amber-50 border-amber-200 text-amber-800'
                        : 'bg-white border-[#E8D5C4] text-[#6B5744] hover:bg-[#FFF8F0]'}`}>
                {d.name}
                <span className="opacity-70"> · {total === 0 ? 'no items yet' : `${c?.counted ?? 0}/${total}`}</span>
                {!d.is_active && <span className="ml-1 text-[9px] uppercase text-red-700">inactive</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8B7355]" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter material, SKU or category…"
                 className="w-full pl-8 pr-8 py-2 border border-[#E8D5C4] rounded-lg text-sm bg-white" />
          {q && (
            <button onClick={() => setQ('')} aria-label="Clear filter"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-[#8B7355] hover:text-[#2D1B0E]">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <span className="flex items-center gap-1.5 text-xs text-[#6B5744]">
          <Toggle size="sm" checked={onlyUncounted} onChange={setOnlyUncounted} label="Only uncounted" />
          Only uncounted
        </span>
        <span className="flex items-center gap-1.5 text-xs text-[#6B5744]">
          <Toggle size="sm" checked={hideEmpty} onChange={setHideEmpty} label="Hide empty departments" />
          Hide empty departments
        </span>
        <button onClick={() => setCollapsed(Object.fromEntries(departments.map(d => [d.id, true])))}
                className="text-xs text-[#af4408] hover:underline">Collapse all</button>
        <button onClick={() => setCollapsed({})} className="text-xs text-[#af4408] hover:underline">Expand all</button>
        {loading && <Loader2 className="w-4 h-4 animate-spin text-[#8B7355]" />}
        {!isAdmin && <span className="text-[11px] text-[#B9A896]">{BLIND_NOTE}</span>}
      </div>

      {/* Sections — one per department */}
      {view.length === 0 ? (
        <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-8 text-center text-sm text-[#8B7355]">
          <PackageX className="w-6 h-6 mx-auto mb-2 text-[#B9A896]" />
          Nothing to show. {q ? 'No material matches your filter.' : 'No departments are in scope for you.'}
        </div>
      ) : view.map(({ dept, items }) => {
        const c = deptCalc.get(dept.id);
        const open = !collapsed[dept.id];
        return (
          <div key={dept.id}
               ref={el => { sectionRefs.current[dept.id] = el; }}
               className="border border-[#E8D5C4] rounded-lg bg-white scroll-mt-4">
            {/* Department header */}
            <button onClick={() => setCollapsed(p => ({ ...p, [dept.id]: !open }))}
                    className="w-full flex flex-wrap items-center gap-2 px-3 py-2.5 bg-[#FFF1E3] rounded-t-lg text-left">
              {open ? <ChevronDown className="w-4 h-4 text-[#8B7355]" /> : <ChevronRight className="w-4 h-4 text-[#8B7355]" />}
              <div className="flex-1 min-w-[160px]">
                <div className="text-sm font-semibold text-[#2D1B0E]">
                  {dept.name}
                  {dept.parent_name && <span className="text-[#B9A896] font-normal"> · {dept.parent_name}</span>}
                  {!dept.is_active && <span className="ml-1.5 text-[9px] uppercase px-1 rounded bg-red-100 text-red-700">inactive</span>}
                </div>
                <div className="text-[11px] text-[#8B7355]">
                  {(c?.counted ?? 0).toLocaleString('en-IN')} / {items.length.toLocaleString('en-IN')} counted
                  {/* A filtered section must never read like an empty department:
                      "0 / 0 counted" on Akan Main Kitchen (249 items) is a lie. */}
                  {items.length !== dept.totals.items && (
                    <span className="text-[#B9A896]"> · filtered from {dept.totals.items.toLocaleString('en-IN')}</span>
                  )}
                  {(c?.dirty ?? 0) > 0 && <span className="text-amber-700"> · {c?.dirty} unsaved</span>}
                </div>
              </div>
              <div className="text-right">
                <div className="text-[10px] text-[#8B7355] uppercase tracking-wide">Department value</div>
                <div className="text-sm font-semibold text-[#af4408] tabular-nums">{inr2(c?.value ?? 0)}</div>
              </div>
            </button>

            {open && (items.length === 0 ? (
              // Two different nothings, and conflating them misleads: a department
              // filtered down to zero rows still has its full item set.
              dept.totals.items > 0 ? (
                <div className="p-5 text-center text-xs text-[#8B7355]">
                  {`No item here matches the current filter — ${dept.totals.items.toLocaleString('en-IN')} item${dept.totals.items === 1 ? '' : 's'} on this department's sheet.`}
                </div>
              ) : (
                <div className="p-5 text-center text-xs text-[#8B7355]">
                  No items on this department&apos;s sheet yet — nothing has been issued to it or counted in it.
                  <div className="mt-1 text-[#B9A896]">
                    Issue stock on{' '}
                    <Link href="/store-requisitions" className="text-[#af4408] hover:underline">Issue Requisitions</Link>
                    {' '}and it will appear here.
                  </div>
                </div>
              )
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="bg-[#FFF8F0] text-[#6B5744]">
                      <th className="text-left font-semibold px-3 py-2 min-w-[190px]">Material</th>
                      <th className="text-left font-semibold px-3 py-2 min-w-[90px]">Category</th>
                      {/* Blind count: rendered only when the API says admin. For
                          everyone else these keys never arrive at all. */}
                      {isAdmin && <th className="text-right font-semibold px-3 py-2 min-w-[100px]">System <span className="font-normal text-[9px] text-[#B9A896]">(central)</span></th>}
                      <th className="text-left font-semibold px-3 py-2 min-w-[170px]">Physical count</th>
                      <th className="text-right font-semibold px-3 py-2 min-w-[110px]">Rate</th>
                      <th className="text-right font-semibold px-3 py-2 min-w-[90px] bg-[#FBE7D3]">Value</th>
                      {isAdmin && <th className="text-right font-semibold px-3 py-2 min-w-[100px]">Variance</th>}
                      <th className="text-left font-semibold px-3 py-2 min-w-[80px]">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map(it => {
                      const meta = packMeta(it);
                      const pf = packFactor(meta);
                      const k = key(dept.id, it.material_id);
                      const raw = entries[k] ?? '';
                      const typed = raw !== '' && isFinite(Number(raw));
                      const pv = typed ? Number(raw) : 0;
                      const recipeQty = typed ? toRecipeQty(pv, meta) : null;
                      const changed = typed && (!it.counted || Math.abs(recipeQty! - (it.physical_stock ?? 0)) > 1e-6);
                      const rate = it.rate_per_purchase_unit;
                      const liveValue = rate == null || !typed
                        ? null
                        : Math.round(toPurchaseQty(recipeQty!, meta) * rate * 100) / 100;
                      const shownValue = changed ? liveValue : (it.counted ? it.value : liveValue);
                      return (
                        <tr key={it.material_id}
                            className={`border-t border-[#F0E4D6] ${it.counted ? '' : 'bg-[#FDFBF8]'} hover:bg-[#FFF8F0]`}>
                          <td className="px-3 py-1.5">
                            <div className="font-medium text-[#2D1B0E] leading-tight">{it.name}</div>
                            <div className="flex items-center gap-1.5">
                              <span className="text-[9px] font-mono text-[#B9A896]">{it.sku || '·'}</span>
                              {!it.is_active && <span className="text-[9px] px-1 rounded bg-red-100 text-red-700">inactive</span>}
                            </div>
                          </td>
                          <td className="px-3 py-1.5 text-[10px] text-[#6B5744]">{it.category || EM}</td>

                          {isAdmin && (
                            <td className="px-3 py-1.5 text-right tabular-nums text-[#6B5744]">
                              {it.system_stock == null
                                ? <span className="text-[#B9A896]">{EM}</span>
                                : <Qty d={dualQty(it.system_stock, meta)} meta={meta} />}
                            </td>
                          )}

                          {/* Entry LEADS in the purchase unit — the unit the
                              counter is physically holding. The recipe figure
                              below is the number that is actually posted. */}
                          <td className="px-3 py-1.5">
                            <div className="flex items-center gap-1">
                              <input type="number" step="any" min={0} value={raw}
                                     onChange={e => setEntries(p => ({ ...p, [k]: e.target.value }))}
                                     placeholder="0"
                                     className="w-24 px-2 py-1 border border-[#D4B896] rounded text-xs text-right font-mono bg-white focus:outline-none focus:ring-1 focus:ring-[#af4408]" />
                              <span className="text-[10px] text-[#8B7355]">{it.purchase_unit}</span>
                            </div>
                            {pf > 1 && typed && (
                              <div className="text-[9px] text-[#B8A590]">= {fmtQtyNum(recipeQty ?? 0)} {it.unit}</div>
                            )}
                          </td>

                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {rate == null ? (
                              <span className="text-[#B9A896]" title="No purchase and no average cost — this item cannot be valued yet.">{EM}</span>
                            ) : (
                              <>
                                <span className="text-[#2D1B0E]">{inr2(rate)}</span>
                                <span className="text-[9px] text-[#B9A896]"> / {it.purchase_unit}</span>
                                <div className="text-[9px] text-[#B8A590]">
                                  {RATE_LABEL[it.rate_source] || it.rate_source}
                                  {it.counted && !it.rate_at_count && <span className="text-amber-700"> · today&apos;s rate</span>}
                                  {it.rate_as_of && <span> · {it.rate_as_of}</span>}
                                </div>
                              </>
                            )}
                          </td>

                          <td className="px-3 py-1.5 text-right tabular-nums bg-[#FEF6EE] text-[#2D1B0E]">
                            {shownValue == null ? <span className="text-[#B9A896]">{EM}</span> : inr2(shownValue)}
                          </td>

                          {isAdmin && (
                            <td className={`px-3 py-1.5 text-right tabular-nums ${
                              it.variance == null ? '' : it.variance < 0 ? 'text-red-700' : it.variance > 0 ? 'text-emerald-700' : 'text-[#6B5744]'}`}>
                              {it.variance == null
                                ? <span className="text-[#B9A896]" title="Recorded once the count is saved.">{EM}</span>
                                : <Qty d={dualQty(it.variance, meta)} meta={meta} />}
                            </td>
                          )}

                          <td className="px-3 py-1.5">
                            {changed ? (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">↻ unsaved</span>
                            ) : it.counted ? (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700"
                                    title={it.recorded_by ? `By ${it.recorded_by}` : undefined}>✓ counted</span>
                            ) : (
                              <span className="text-[10px] text-[#B9A896]">pending</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    {/* Quantity subtotals stay em-dashed on purpose: adding
                        BTL + kg + pcs across materials is not a number in any
                        basis. Rupees are the only valid cross-material total. */}
                    <tr className="border-t-2 border-[#E8D5C4] bg-[#FFF1E3] font-semibold text-[#2D1B0E]">
                      <td className="px-3 py-2">{dept.name} — total</td>
                      <td className="px-3 py-2 text-[10px] font-normal text-[#8B7355]">
                        {(c?.counted ?? 0)} of {items.length} counted
                        {(c?.unpriced ?? 0) > 0 && <div className="text-[9px] text-amber-700">{c?.unpriced} unpriced</div>}
                      </td>
                      {isAdmin && <td className="px-3 py-2 text-right text-[#B9A896] font-normal">{EM}</td>}
                      <td className="px-3 py-2 text-right text-[#B9A896] font-normal">{EM}</td>
                      <td className="px-3 py-2 text-right text-[#B9A896] font-normal">{EM}</td>
                      <td className="px-3 py-2 text-right tabular-nums bg-[#FBE7D3]">{inr2(c?.value ?? 0)}</td>
                      {isAdmin && (
                        <td className="px-3 py-2 text-right tabular-nums text-[#6B5744]">
                          {inr2(dept.totals.variance_value ?? 0)}
                        </td>
                      )}
                      <td className="px-3 py-2" />
                    </tr>
                  </tfoot>
                </table>
              </div>
            ))}
          </div>
        );
      })}

      {/* Whole-sheet total */}
      {view.length > 0 && (
        <div className="sticky bottom-3 z-20 border border-[#af4408]/40 rounded-lg bg-white shadow-lg px-3 py-2.5 flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-[180px]">
            <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">Whole sheet</div>
            <div className="text-sm font-semibold text-[#2D1B0E]">
              {view.length} department{view.length === 1 ? '' : 's'} ·{' '}
              {sheetCalc.counted.toLocaleString('en-IN')} / {sheetCalc.items.toLocaleString('en-IN')} counted
              {/* Say so when the figures describe a filtered subset, not the sheet. */}
              {(q.trim() !== '' || onlyUncounted) && (
                <span className="font-normal text-[#B9A896]"> · filtered view</span>
              )}
            </div>
          </div>
          {/* Quantities: em-dash, always. */}
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">Total quantity</div>
            <div className="text-sm text-[#B9A896]" title="Quantities cannot be added across different materials.">{EM}</div>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">Total value</div>
            <div className="text-lg font-bold text-[#af4408] tabular-nums">{inr2(sheetCalc.value)}</div>
          </div>
          <Link href={`/inventory/closing-overview?date=${encodeURIComponent(date)}`}
                className="px-2.5 py-1.5 bg-white border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 rounded-lg text-xs font-medium flex items-center gap-1">
            Overview board <ArrowUpRight className="w-3.5 h-3.5" />
          </Link>
          <button onClick={saveAll} disabled={saving || sheetCalc.dirty === 0}
                  className="px-3 py-2 bg-[#af4408] text-white hover:bg-[#903905] disabled:opacity-40 rounded-lg text-sm font-medium flex items-center gap-1.5">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Pieces ──────────────────────────────────────────────────────────────── */

function SummaryCard({ icon, label, value, tone = 'muted', note }: {
  icon: React.ReactNode; label: string; value: string; tone?: 'muted' | 'warn'; note?: string;
}) {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
      <div className={`flex items-center gap-1.5 text-[11px] font-medium ${tone === 'warn' ? 'text-amber-700' : 'text-[#8B7355]'}`}>
        {icon} {label}
      </div>
      <div className="mt-1 text-lg font-bold text-[#2D1B0E] tabular-nums">{value}</div>
      {note && <div className="text-[9px] text-amber-700 leading-tight mt-0.5">{note}</div>}
    </div>
  );
}
