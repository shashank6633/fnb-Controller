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
 *
 * ── WHAT CHANGED WHEN STOCK STARTED MOVING AT ISSUE ────────────────────────
 * raw_materials.current_stock used to be, loosely, "what the outlet owns":
 * goods stayed on it until a recipe consumed them, so a kitchen's working
 * stock was still counted here. It is not that any more. Central now loses the
 * gram the moment the storekeeper issues a requisition, and the department
 * carries it until recipe consumption (or wastage / a staff meal) removes it.
 *
 * So the old "Grocery" column is now, precisely, the CENTRAL STORE ONLY — and
 * it is renamed to say so. On its own it is NOT the outlet's inventory, and a
 * Total built from central + stores would quietly under-count the building by
 * everything sitting on the kitchens' shelves. Hence the Departments column.
 *
 * ── THE DEPARTMENTS COLUMN ────────────────────────────────────────────────
 * Sourced from GET /api/department-variance, whose `ledger_balance` is
 * deptOnHandBulk()'s onHand verbatim — the ONE derivation of a department
 * balance in the codebase. This page deliberately does not re-derive it and
 * must never read department_materials.on_hand (that column is a maintained
 * CACHE, not a truth). Two derivations of one number is how a kitchen ends up
 * holding 4,000 g on one screen and −1,000 g on another.
 *
 * FOUR RULES A FUTURE ENGINEER WILL WANT TO "SIMPLIFY". DO NOT:
 *  1. BEFORE THE CUTOVER THE COLUMN READS "not started", NEVER 0. The route
 *     answers 400 with cutover_at: null until the opening balances exist. A 0
 *     there would read as "the kitchens hold nothing", which is a claim about
 *     the building; "not started" is a claim about the system, and only the
 *     second one is true. Same for a (dept, material) pair that has never been
 *     counted: null → "not counted", never 0.
 *  2. WHEN DEPARTMENTS ARE MISSING, THE TOTAL IS RELABELLED, NOT PATCHED. If
 *     the cutover has not run, or the viewer is a store manager (the dept
 *     report is isManagement-only, this board is not), the Total column and
 *     the Total value card say "central + stores". They must not keep reading
 *     as the outlet total while the kitchens' holdings have silently left it.
 *  3. THE LIQUOR CARVE-OUT. Store-mapped (TGBCL) materials never enter the
 *     department raw-material rail — they are skipped by the central debit at
 *     issue and by applyDeduct at consumption, and the variance route drops
 *     them from its row set. Their Departments cell is a dash, not a zero, and
 *     the footnote says how many were excluded. Do not "fill it in" from the
 *     store columns: those grams are already counted there.
 *  4. AN UNMAPPED STATION IS A VISIBLE WARNING, NOT A ROUNDING ERROR. Sales at
 *     a station with no department mapping record a consumption_skip and debit
 *     nobody, so those kitchens read HIGH here. The banner names the stations
 *     rather than letting the number pass as a count.
 *
 * The department leg is fetched in PARALLEL and rendered independently: the
 * board must still load if the dept report is slow, forbidden or unmigrated.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Wine, Search, X, Loader2, AlertCircle, Download, Layers,
  IndianRupee, Store as StoreIcon, AlertTriangle, PackageX, Warehouse, ChefHat,
} from 'lucide-react';
import Papa from 'papaparse';
import { fmtBreakdown, PackMeta, toPurchaseQty, fmtQtyNum } from '@/lib/pack-units';

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
  /** CENTRAL STORE ONLY (recipe units) = raw_materials.current_stock. Since
   *  deduct-at-issue this excludes everything already issued to a kitchen —
   *  see the header block. Field name kept as the API ships it. */
  grocery_qty: number;
  /** grocery_qty × raw_materials.average_price. Folded into total_value. */
  grocery_value: number;
  /** Central + every store. Does NOT include departments — the page adds
   *  those on top, because /api/stores/overview knows nothing about them. */
  total_qty: number;
  total_value: number;
}

/** One material's holding across ALL departments, from the department ledger. */
interface DeptAgg {
  /** Σ ledger_balance over the departments that HAVE a baseline. Recipe units. */
  qty: number;
  /** Σ balance_value (₹, at average_price) over those same departments. */
  value: number;
  /** How many (dept, material) pairs contributed a number… */
  counted: number;
  /** …and how many are still never_counted (excluded from qty/value). */
  uncounted: number;
}

type DeptState =
  | { kind: 'loading' }
  /** The cut-over has not been run: there are no opening balances, so there is
   *  no department position to show. NOT the same as "the kitchens are empty". */
  | { kind: 'not_started'; detail: string }
  /** This board is admin/manager/store-manager/HOD; the dept report is
   *  isManagement only. A store manager sees the board minus this column. */
  | { kind: 'restricted' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready';
      byMaterial: Map<string, DeptAgg>;
      cutoverAt: string;
      /** Σ balance_value across every department — the reconciliation figure. */
      totalValue: number;
      /** (dept, material) pairs with no baseline yet. */
      uncountedPairs: number;
      /** Store-mapped (TGBCL) materials the dept rail excludes by design. */
      liquorExcluded: number;
      /** Live stations with no usable department mapping (deliberate ones —
       *  'liquor', 'kitchen' — filtered out; they must never be mapped). */
      unmappedStations: string[];
      consumptionSkips: number;
    };

/* ── Helpers ───────────────────────────────────────────────────────────── */

// (quantities all format through fmtQtyNum — one 3-dp rule, shared with every
//  other converted surface; the local 2-dp helper it replaced is gone)
const inr = (v: number, dp = 0) =>
  '₹' + (Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: dp });
const packMeta = (r: Row): PackMeta => ({
  unit: r.unit, purchase_unit: r.purchase_unit, pack_size: r.pack_size, case_size: r.case_size,
});
const PAGE_SIZE = 50;

/** The department leg of one material, or null when it cannot be shown. A
 *  material absent from the map is NOT a zero — it is a material the
 *  department rail has never carried (liquor, or simply never issued). */
const deptFor = (d: DeptState, materialId: string): DeptAgg | null =>
  d.kind === 'ready' ? (d.byMaterial.get(materialId) || null) : null;

/** Contributable ₹/qty: only departments with a baseline. `counted === 0`
 *  means every pair is never_counted, so qty is 0 by absence of evidence and
 *  must not be summed into a total that reads as a position. */
const deptQtyOf = (a: DeptAgg | null) => (a && a.counted > 0 ? a.qty : 0);
const deptValueOf = (a: DeptAgg | null) => (a && a.counted > 0 ? a.value : 0);

/** Short label for the state a Departments cell / header is in. */
const deptStateLabel = (d: DeptState) =>
  d.kind === 'loading' ? 'loading…'
    : d.kind === 'not_started' ? 'not started'
      : d.kind === 'restricted' ? 'restricted'
        : d.kind === 'error' ? 'unavailable'
          : 'kitchens';

/* One qty cell — owner rule: the PURCHASE figure leads ("2 l", "3 BTL"); the
 * cases+bottles+loose breakdown stays as the hint for bar materials; the exact
 * recipe number lives in the tooltip (it is the stored truth the ₹ column and
 * the deductions use). qty stays recipe-basis in state — display converts here
 * and ONLY here on this page. */
function QtyCell({ qty, r, strong, note }: { qty: number; r: Row; strong?: boolean; note?: string }) {
  const neg = qty < 0;
  const meta = packMeta(r);
  const dual = (r.pack_size > 1 || (r.case_size ?? 1) > 1) ? fmtBreakdown(qty, meta) : null;
  const zero = qty === 0;
  const puQty = toPurchaseQty(qty, meta);
  const puLbl = r.purchase_unit || r.unit || '';
  const converts = puQty !== qty || String(r.purchase_unit || '').toLowerCase().trim() !== String(r.unit || '').toLowerCase().trim();
  const exact = converts ? `= ${fmtQtyNum(qty)} ${r.unit || ''} (exact stored balance)` : '';
  const title = [exact, note].filter(Boolean).join(' · ') || undefined;
  return (
    <div className={`text-right tabular-nums ${neg ? 'text-red-700' : zero ? 'text-[#B9A896]' : 'text-[#2D1B0E]'}`}
         title={title}>
      <span className={strong ? 'font-semibold' : ''}>{fmtQtyNum(puQty)}{puLbl ? ' ' + puLbl : ''}</span>
      {dual && <div className="text-[10px] text-[#8B7355] font-normal leading-tight">{dual}</div>}
    </div>
  );
}

/* The Departments cell. Every non-numeric outcome prints WORDS, never 0 —
 * "not started" (no cutover), "not counted" (no baseline for this pair), "—"
 * (never on the department rail, e.g. every TGBCL bottle). */
function DeptCell({ r, dept, right = true }: { r: Row; dept: DeptState; right?: boolean }) {
  const cls = `text-[11px] text-[#B9A896] ${right ? 'text-right' : ''}`;
  if (dept.kind !== 'ready') {
    return (
      <div className={cls} title={
        dept.kind === 'not_started'
          ? 'Department opening balances have not been recorded yet, so there is no department position to show. This is not a claim that the kitchens are empty.'
          : dept.kind === 'restricted'
            ? 'Department holdings need management access (admin / manager / HOD).'
            : dept.kind === 'error' ? dept.message : undefined
      }>{deptStateLabel(dept)}</div>
    );
  }
  const a = deptFor(dept, r.material_id);
  if (!a) {
    return (
      <div className={cls} title="This material has never been on the department rail. Store-mapped (TGBCL / liquor) materials never enter it by design — their grams are already in the store columns.">—</div>
    );
  }
  if (a.counted === 0) {
    return (
      <div className={cls} title={`${a.uncounted} department(s) hold this material but none has an opening count yet — reported as "not counted", never as 0.`}>not counted</div>
    );
  }
  const partial = a.uncounted > 0
    ? `${a.uncounted} more department(s) hold this material with no opening count yet — not included`
    : undefined;
  return (
    <>
      <QtyCell qty={a.qty} r={r} note={partial} />
      {a.uncounted > 0 && (
        <div className="text-[10px] text-amber-700 leading-tight text-right" title={partial}>+{a.uncounted} not counted</div>
      )}
    </>
  );
}

/* ── Page ──────────────────────────────────────────────────────────────── */

export default function StockOverviewPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [stores, setStores] = useState<StoreCol[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [generatedAt, setGeneratedAt] = useState('');
  const [dept, setDept] = useState<DeptState>({ kind: 'loading' });

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

  // Department leg — its own request, its own failure mode. A slow, forbidden
  // or pre-cutover department report must never stop the store board loading;
  // it downgrades the Total label instead (rule 2 in the header block).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/department-variance', { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({} as any));
        if (!alive) return;
        if (res.status === 403) { setDept({ kind: 'restricted' }); return; }
        // The route answers 400 + cutover_at: null until opening balances
        // exist. That is a STATE, not an error — anything else with a 400 is.
        if (res.status === 400 && data?.cutover_at === null) {
          setDept({ kind: 'not_started', detail: String(data?.detail || '') });
          return;
        }
        if (!res.ok) { setDept({ kind: 'error', message: String(data?.error || `HTTP ${res.status}`) }); return; }

        const byMaterial = new Map<string, DeptAgg>();
        let totalValue = 0, uncountedPairs = 0;
        for (const row of (Array.isArray(data.rows) ? data.rows : [])) {
          const id = String(row?.material_id || '');
          if (!id) continue;
          let a = byMaterial.get(id);
          if (!a) { a = { qty: 0, value: 0, counted: 0, uncounted: 0 }; byMaterial.set(id, a); }
          const bal = row?.ledger_balance;
          // null = never_counted. Excluded from every sum on purpose: a
          // balance we do not have is not a balance of zero.
          if (bal === null || bal === undefined) { a.uncounted++; uncountedPairs++; continue; }
          a.qty += Number(bal) || 0;
          a.value += Number(row?.balance_value) || 0;
          a.counted++;
          totalValue += Number(row?.balance_value) || 0;
        }
        const cov = data?.coverage || {};
        const unmapped: string[] = Array.isArray(cov.unmapped_station_detail)
          // 'liquor' and 'kitchen' are unmapped ON PURPOSE (the store rail, and
          // kot-fire's blank-station sentinel). Naming them as a gap would send
          // an owner to map two stations that must never be mapped.
          ? cov.unmapped_station_detail
              .filter((u: any) => !u?.deliberate && Number(u?.menu_items) > 0)
              .map((u: any) => String(u?.station || ''))
              .filter(Boolean)
          : [];
        setDept({
          kind: 'ready',
          byMaterial,
          cutoverAt: String(data?.cutover_at || ''),
          totalValue,
          uncountedPairs,
          liquorExcluded: Number(cov.liquor_materials_excluded) || 0,
          unmappedStations: unmapped,
          consumptionSkips: Number(cov.consumption_skips_since_cutover) || 0,
        });
      } catch (e: any) {
        if (alive) setDept({ kind: 'error', message: e?.message || 'Failed to load department holdings' });
      }
    })();
    return () => { alive = false; };
  }, []);

  const deptReady = dept.kind === 'ready';

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

  /* THE WHOLE-BUILDING TOTAL, built as one identity so it reconciles against
   * the columns beside it:  central + stores + departments.
   * `r.total_value` is the API's central+stores figure; the department leg is
   * added HERE because /api/stores/overview cannot see it. When the department
   * leg is missing the addend is 0 AND the label changes — the number is never
   * left to pass as an outlet total. */
  const rowTotalQty = (r: Row) => r.total_qty + deptQtyOf(deptFor(dept, r.material_id));
  const rowTotalValue = (r: Row) => r.total_value + deptValueOf(deptFor(dept, r.material_id));

  // Summary over the FILTERED set (what the user is looking at).
  const summary = useMemo(() => {
    let value = 0, central = 0, deptValue = 0, negative = 0, out = 0;
    for (const r of filtered) {
      const dv = deptValueOf(deptFor(dept, r.material_id));
      value += r.total_value + dv;
      central += r.grocery_value;
      deptValue += dv;
      const tq = r.total_qty + deptQtyOf(deptFor(dept, r.material_id));
      if (tq < 0) negative++;
      else if (tq === 0) out++;
    }
    // Stores = the residual of the same identity, so the four cards always add
    // up on screen. Deriving it (rather than re-summing per store) keeps ONE
    // definition of "stores" — the API's.
    return { value, central, deptValue, stores: value - central - deptValue, negative, out, items: filtered.length };
  }, [filtered, dept]);

  const exportCsv = () => {
    // Both bases, named columns: purchase leads (what the store reads), the
    // recipe figures follow (the exact stored truth the ₹ column uses).
    // "Grocery" is gone from the header row on purpose — the column is the
    // CENTRAL STORE only now, and a sheet that still said Grocery would be
    // re-summed by someone as the outlet's stock.
    const header = ['Material', 'SKU', 'Category', 'Purchase Unit', 'Central store',
                    ...stores.map(s => s.name), 'Departments', 'Total Qty',
                    'Recipe Unit', 'Central store (recipe)', 'Departments (recipe)', 'Total Qty (recipe)',
                    'Central Value', 'Departments Value', 'Total Value'];
    const body = filtered.map(r => {
      const meta = packMeta(r);
      const a = deptFor(dept, r.material_id);
      const dq = deptQtyOf(a);
      const dv = deptValueOf(a);
      // Words, not zeros, for every non-numeric department state — the CSV
      // carries the same honesty as the screen (rule 1).
      const deptText = !deptReady ? deptStateLabel(dept)
        : !a ? ''
          : a.counted === 0 ? 'not counted'
            : null;
      return [
        r.name, r.sku || '', r.category || '', r.purchase_unit || r.unit || '',
        toPurchaseQty(Number(r.grocery_qty), meta),
        ...stores.map(s => toPurchaseQty(Number(r.by_store[s.id] ?? 0), meta)),
        deptText ?? toPurchaseQty(dq, meta),
        toPurchaseQty(Number(r.total_qty) + dq, meta),
        r.unit || '', Number(r.grocery_qty), deptText ?? dq, Number(r.total_qty) + dq,
        Number(r.grocery_value), deptText ?? dv, Number(r.total_value) + dv,
      ];
    });
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

  const totalLabel = deptReady ? 'Central + stores + departments' : 'Central + stores';

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex-1 min-w-[200px]">
          <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
            <Wine className="w-6 h-6 text-[#af4408]" /> Consolidated Stock
          </h1>
          <p className="text-xs text-[#6B5744] mt-0.5">
            Every material across the <b>central store</b>, the Liquor Store and each floor bar, plus what the
            <b> departments</b> are holding — stock leaves central at issue, so the kitchens&apos; shelves are a separate column now.
            {' '}Every quantity reads in <b>purchase units</b> (kg / BTL / CASE); the small line beneath is the cases + bottles + loose
            breakdown, and hovering a figure shows the exact recipe-unit balance the ₹ column is computed from.
            {generatedAt && <span className="text-[#B9A896]"> · as of {new Date(generatedAt).toLocaleString('en-IN')}</span>}
          </p>
        </div>
        <button onClick={exportCsv} disabled={filtered.length === 0}
                className="px-3 py-2 bg-white border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 disabled:opacity-40 rounded-lg text-sm font-medium flex items-center gap-1.5">
          <Download className="w-4 h-4" /> Export CSV
        </button>
      </div>

      {/* Summary cards — Total = Central + Stores + Departments, and the three
          addends are on screen beside it so the identity is checkable by eye. */}
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-2.5">
        <SummaryCard icon={<IndianRupee className="w-4 h-4" />}
                     label={deptReady ? 'Total value' : 'Total value (central + stores)'}
                     value={inr(summary.value)} />
        <SummaryCard icon={<Warehouse className="w-4 h-4" />} label="Central store" value={inr(summary.central)} />
        <SummaryCard icon={<StoreIcon className="w-4 h-4" />} label="Stores (bars)" value={inr(summary.stores)} />
        <SummaryCard icon={<ChefHat className="w-4 h-4" />} label="Departments"
                     value={deptReady ? inr(summary.deptValue) : deptStateLabel(dept)}
                     tone={deptReady ? 'muted' : 'warn'} />
        <SummaryCard icon={<StoreIcon className="w-4 h-4" />} label="Locations" value={String(stores.length)} />
        <SummaryCard icon={<Layers className="w-4 h-4" />} label="Materials" value={summary.items.toLocaleString('en-IN')} />
        <SummaryCard
          icon={<AlertTriangle className="w-4 h-4" />}
          label="Flags"
          value={`${summary.negative} neg · ${summary.out} out`}
          tone={summary.negative > 0 ? 'warn' : 'muted'}
        />
      </div>

      {/* The department leg's state, said out loud. An absent column is a
          caveat on the TOTAL, not a detail of one column. */}
      {dept.kind === 'not_started' && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 text-amber-900 p-3 text-xs flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            <b>Departments: not started.</b> {dept.detail
              || 'Department opening balances have not been recorded yet. Take a complete department closing count and record the opening balances (Settings → Department Ledger → Cutover).'}
            {' '}Until then the totals here are <b>central + stores only</b> — they do not include what the kitchens are holding.
            This is not a statement that the kitchens are empty.
          </div>
        </div>
      )}
      {dept.kind === 'restricted' && (
        <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] text-[#6B5744] p-3 text-xs flex items-start gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>Department holdings are limited to admins, managers and HODs, so the totals below are <b>central + stores only</b>.</div>
        </div>
      )}
      {dept.kind === 'error' && (
        <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 p-3 text-xs flex items-start gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>Department holdings could not be loaded ({dept.message}). Totals below are <b>central + stores only</b>.</div>
        </div>
      )}
      {dept.kind === 'ready' && (dept.unmappedStations.length > 0 || dept.uncountedPairs > 0) && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 text-amber-900 p-3 text-xs flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            {dept.unmappedStations.length > 0 && (
              <div>
                <b>{dept.unmappedStations.length} station(s) are not mapped to a department</b> ({dept.unmappedStations.join(', ')}).
                Sales at those stations deduct from no kitchen{dept.consumptionSkips > 0 ? ` (${dept.consumptionSkips.toLocaleString('en-IN')} skipped since the cut-over)` : ''},
                so those departments read HIGH here. Map them in Settings → Station → Department.
              </div>
            )}
            {dept.uncountedPairs > 0 && (
              <div>{dept.uncountedPairs.toLocaleString('en-IN')} department/material pair(s) have no opening count yet — shown as “not counted”, never as 0, and excluded from the totals.</div>
            )}
          </div>
        </div>
      )}

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
                  <th className="text-right font-semibold px-3 py-2 min-w-[100px] whitespace-nowrap bg-[#FBF0E6] border-l border-[#F0E4D6]">
                    Central store
                    <div className="text-[9px] font-normal text-[#B9A896] leading-none">store shelf only</div>
                  </th>
                  {stores.map(s => (
                    <th key={s.id} className="text-right font-semibold px-3 py-2 min-w-[90px] whitespace-nowrap">{s.name}</th>
                  ))}
                  <th className="text-right font-semibold px-3 py-2 min-w-[110px] whitespace-nowrap bg-[#FBF0E6] border-l border-[#F0E4D6]">
                    Departments
                    <div className={`text-[9px] font-normal leading-none ${deptReady ? 'text-[#B9A896]' : 'text-amber-700'}`}>
                      {deptStateLabel(dept)}
                    </div>
                  </th>
                  <th className="text-right font-semibold px-3 py-2 min-w-[90px] bg-[#FBE7D3] whitespace-nowrap">
                    Total
                    <div className="text-[9px] font-normal text-[#B9A896] leading-none">{totalLabel}</div>
                  </th>
                  <th className="text-right font-semibold px-3 py-2 min-w-[100px] bg-[#FBE7D3] whitespace-nowrap">
                    Value
                    <div className="text-[9px] font-normal text-[#B9A896] leading-none">{totalLabel}</div>
                  </th>
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
                    <td className="px-3 py-2 bg-[#FDF7F1] border-l border-[#F0E4D6]"><DeptCell r={r} dept={dept} /></td>
                    <td className="px-3 py-2 bg-[#FEF6EE]"><QtyCell qty={rowTotalQty(r)} r={r} strong /></td>
                    <td className="px-3 py-2 bg-[#FEF6EE] text-right tabular-nums text-[#2D1B0E]">{inr(rowTotalValue(r))}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-[#E8D5C4] bg-[#FFF1E3] font-semibold text-[#2D1B0E]">
                  <td className="px-3 py-2 sticky left-0 bg-[#FFF1E3] z-10">Page total</td>
                  <td className="px-3 py-2" />
                  {/* Quantity totals removed: summing ml + g + pcs across
                      materials was meaningless in ANY unit basis. The ₹ total
                      (right) is the valid aggregate. */}
                  <td className="px-3 py-2 text-right text-xs text-[#B9A896] bg-[#FBF0E6] border-l border-[#F0E4D6]">—</td>
                  {stores.map(s => (
                    <td key={s.id} className="px-3 py-2 text-right text-xs text-[#B9A896]">—</td>
                  ))}
                  <td className="px-3 py-2 text-right text-xs text-[#B9A896] bg-[#FBF0E6] border-l border-[#F0E4D6]">—</td>
                  <td className="px-3 py-2 text-right text-xs text-[#B9A896] bg-[#FBE7D3]">—</td>
                  <td className="px-3 py-2 text-right tabular-nums bg-[#FBE7D3]">
                    {inr(paged.reduce((a, r) => a + rowTotalValue(r), 0))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Mobile: stacked cards. The location breakdown stays a 2-column
              grid with truncating labels — the added Departments line must not
              push the card into a horizontal scroll. */}
          <div className="sm:hidden space-y-2.5">
            {paged.map(r => (
              <div key={r.material_id} className="border border-[#E8D5C4] rounded-lg bg-white p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-[#2D1B0E] leading-tight">{r.name}</div>
                    <div className="text-[11px] text-[#8B7355]">{r.category}{r.sku ? ` · ${r.sku}` : ''}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-[10px] text-[#8B7355] uppercase tracking-wide">{deptReady ? 'Total' : 'Central + stores'}</div>
                    <QtyCell qty={rowTotalQty(r)} r={r} strong />
                    <div className="text-[11px] text-[#af4408] font-medium">{inr(rowTotalValue(r))}</div>
                  </div>
                </div>
                <div className="mt-2 pt-2 border-t border-[#F0E4D6] grid grid-cols-2 gap-x-3 gap-y-1">
                  <div className="flex items-center justify-between gap-2 text-xs min-w-0">
                    <span className="text-[#8B7355] font-medium truncate min-w-0">Central</span>
                    <QtyCell qty={r.grocery_qty} r={r} />
                  </div>
                  {stores.map(s => (
                    <div key={s.id} className="flex items-center justify-between gap-2 text-xs min-w-0">
                      <span className="text-[#6B5744] truncate min-w-0">{s.name}</span>
                      <QtyCell qty={Number(r.by_store[s.id] ?? 0)} r={r} />
                    </div>
                  ))}
                  <div className="flex items-center justify-between gap-2 text-xs min-w-0">
                    <span className="text-[#8B7355] font-medium truncate min-w-0">Departments</span>
                    <div className="min-w-0"><DeptCell r={r} dept={dept} /></div>
                  </div>
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

          {/* What the numbers exclude, on the page rather than in a wiki. */}
          {dept.kind === 'ready' && (
            <p className="text-[11px] text-[#8B7355] leading-relaxed">
              Departments = each kitchen&apos;s own holding from the department ledger, anchored on its latest count and
              counted from the cut-over{dept.cutoverAt ? ` (${new Date(dept.cutoverAt.replace(' ', 'T') + 'Z').toLocaleDateString('en-IN')})` : ''}.
              Requisition issues before that date are <b>not backfilled</b> and are in no column here.
              {dept.liquorExcluded > 0 && <> Store-mapped (TGBCL / liquor) materials never enter the department rail — {dept.liquorExcluded.toLocaleString('en-IN')} excluded; their stock is already in the store columns.</>}
            </p>
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
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 min-w-0">
      <div className={`flex items-center gap-1.5 text-[11px] font-medium ${tone === 'warn' ? 'text-amber-700' : 'text-[#8B7355]'}`}>
        <span className="shrink-0">{icon}</span> <span className="truncate min-w-0">{label}</span>
      </div>
      <div className="mt-1 text-lg font-bold text-[#2D1B0E] tabular-nums truncate">{value}</div>
    </div>
  );
}
