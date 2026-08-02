'use client';

/**
 * CLOSING STOCK HISTORY — "a detailed closing stock where I can see the PREVIOUS
 * closing stocks also, with download option." (owner, 2026-08-02)
 *
 * ── WHY A SEPARATE PAGE FROM /inventory/closing-sheet ──────────────────────
 * closing-sheet is an ENTRY surface: one date, every department, boxes you type
 * into. It already hands out a flat history CSV, but nothing on screen answers
 * the question the owner actually asks — "is this month's figure sane?" — which
 * is only ever answered by last month's figure for the SAME item. That needs a
 * MATRIX (rows = items, columns = count dates), which is the opposite shape to
 * an entry sheet and cannot be bolted onto it without giving one page two axes
 * and two verbs. So: sheet writes one date, this page reads many.
 *
 * ── THE POINT OF THE DEFAULT VIEW ──────────────────────────────────────────
 * "Compare dates" puts the newest count in the FIRST date column and the same
 * item's earlier counts to its right, with a Change column pinned next to the
 * item name so it survives horizontal scrolling. A date on which an item was
 * NOT counted renders as an em-dash on a shaded cell; a date on which it WAS
 * counted and the count was zero renders as "0 <unit>" in full-strength text.
 * Those two are different facts — "nobody looked" vs "we looked and there is
 * none" — and conflating them is the exact error this view exists to prevent.
 * There is a legend above the table saying so, because a colour difference
 * nobody has been told about is not information.
 *
 * ── UNITS: DISPLAY ONLY, NEVER RE-DERIVED HERE ─────────────────────────────
 * unit-lock: every quantity on the wire is ALREADY in PURCHASE units — the
 * history route converts closing_stock.physical_stock (stored in RECIPE units)
 * through toPurchaseQty() before it ever reaches this file, and ships the
 * matching purchase_unit string alongside. This page therefore formats and
 * prints; it must NEVER call toPurchaseQty / packFactor on these numbers again,
 * because a second division would silently show a 6 kg stock as 4 kg for every
 * material whose pack_size > 1. A SUB (sub-recipe) row has no purchase unit and
 * no pack factor at all — it is counted in its own yield unit, which the route
 * puts in the very same purchase_unit field, so it prints unchanged and no
 * conversion is implied anywhere on this page.
 *
 * ── MONEY vs QUANTITY TOTALS ───────────────────────────────────────────────
 * Rupees total, per date, in the footer. Quantities NEVER do: 2 BTL + 3 kg is
 * not a number in any basis, so every quantity subtotal prints an em-dash. The
 * "latest value" column is likewise NOT totalled — each row's latest count can
 * be on a different date, so a column sum would be a valuation of no day.
 *
 * ── BLIND COUNTS ───────────────────────────────────────────────────────────
 * There is no system-stock and no variance column here for ANYONE, admin
 * included. That is not an omission: /api/closing-stock/history deliberately
 * carries neither field for any caller (variance lives on /variance-approvals),
 * so this page cannot leak a blind count even to a user whose role would allow
 * it — there is nothing in the payload to leak. Nothing on this page keys off a
 * client-side role guess.
 *
 * ── FILTERS AND THE DOWNLOAD MUST AGREE ────────────────────────────────────
 * Every filter (dates, department, item search) is applied SERVER-SIDE, and the
 * CSV is the very same request with format=csv. There is deliberately no
 * client-side row filtering anywhere in this file: the moment the page narrows
 * rows the server did not, "Download CSV" stops being what is on screen, and a
 * download that quietly differs from the report above it is worse than no
 * download at all. The one thing the file can hold that the screen cannot is
 * the truncation warning line — and truncation is shouted about on screen too.
 *
 * ── PERMISSIONS ────────────────────────────────────────────────────────────
 * The route is the authority (canSeeAllDeptStock / allowedDeptSetExpanded) and
 * answers 403 with wording this page matches on to render a lock panel rather
 * than a red crash. A department the caller may not read is a 403 — never an
 * empty table, which would read as "nobody counted anything there".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  History, Loader2, AlertCircle, Download, Search, X, CalendarDays,
  IndianRupee, Layers, PackageX, ArrowUpRight, ArrowDownRight, Minus,
  ClipboardCheck, LayoutGrid, List, Building2, AlertTriangle,
} from 'lucide-react';
import { fmtQtyNum } from '@/lib/pack-units';
import { todayIST, fmtISTDate } from '@/lib/format-date';

/* ── Wire types — /api/closing-stock/history ─────────────────────────────── */

/** One item's count on one date. `null` in `counts` means NOT COUNTED. */
interface CountCell {
  /** unit-lock: PURCHASE units already (SUB rows: the yield unit). */
  qty: number;
  value: number | null;
  rate: number | null;
}

interface MatrixRow {
  material_id: string | null;
  sub_recipe_id: string | null;
  type: 'RAW' | 'SUB';
  material: string;
  sku: string;
  category: string;
  department: string;
  department_id: string;
  purchase_unit: string;
  /** date → cell, or null for "no count taken on that date". */
  counts: Record<string, CountCell | null>;
  latest_qty: number | null;
  previous_qty: number | null;
  change_qty: number | null;
  change_pct: number | null;
  latest_value: number | null;
}

interface MatrixResp {
  mode: 'matrix';
  /** Count dates, NEWEST FIRST. */
  dates: string[];
  rows: MatrixRow[];
  totals_by_date: Record<string, { lines: number; value: number }>;
  truncated: boolean;
  from: string;
  to: string;
  /** Present on the flat mode today; read defensively so either mode may send it. */
  scope?: string;
  note?: string | null;
}

/** The existing flat row (kept byte-compatible with the deployed route). */
interface FlatRow {
  date: string;
  department: string;
  material: string;
  sku: string;
  category: string;
  purchase_unit: string;
  /** unit-lock: already converted server-side; NULL only on a malformed row. */
  counted_purchase: number | null;
  rate: number | null;
  rate_source: string;
  value: number | null;
  recorded_by: string;
  type: 'RAW' | 'SUB';
}

interface FlatResp {
  mode: 'flat';
  rows: FlatRow[];
  totals: { count: number; value: number };
  truncated: boolean;
  from: string;
  to: string;
  scope?: string;
  note?: string | null;
}

interface DeptOption { id: string; name: string; is_active: boolean; parent_name?: string }

/* ── Helpers ─────────────────────────────────────────────────────────────── */

const EM = '—';
const inr = (v: number, dp = 0) =>
  '₹' + (Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: dp });
const inr2 = (v: number) => inr(v, 2);

/** The Store / Overall bucket — counts that belong to no department. Same key
 *  the API uses; a department-scoped user gets a 403 for it, by design. */
const STORE_KEY = '__store__';

const RATE_LABEL: Record<string, string> = {
  last_purchase: 'last purchase',
  average_cost: 'average cost',
  sub_recipe_cost: 'sub-recipe cost',
  not_recorded: 'not recorded at count time',
  none: 'no basis',
};

/**
 * Calendar arithmetic on an IST date-only string. Built from UTC PARTS on
 * purpose: `new Date('2026-08-01')` read back with local getters lands on 31 Jul
 * for anyone west of Greenwich, which would shift the default window by a day.
 */
const shiftDays = (isoDate: string, days: number): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ''));
  if (!m) return isoDate;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]) + days * 86400000);
  if (isNaN(d.getTime())) return isoDate;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};

/** Default window: the last 90 days inclusive (today counts as day 1). */
const defaultFrom = () => shiftDays(todayIST(), -89);

/** Content-Disposition → filename, so the saved file keeps the server's name. */
const filenameFrom = (cd: string | null, fallback: string): string => {
  if (!cd) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (star) { try { return decodeURIComponent(star[1]); } catch { /* fall through */ } }
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  return plain ? plain[1].trim() : fallback;
};

/* Defensive readers — the payload is shaped by a route written in parallel, so
 * a missing key must degrade to a blank cell, never blow the whole report up. */
const rec = (v: unknown): Record<string, unknown> =>
  (v && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, unknown> : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (v == null ? '' : String(v));
/** Numbers that are allowed to be absent. `0` must survive; only null/''/NaN don't. */
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
};
const num = (v: unknown): number => numOrNull(v) ?? 0;

const normaliseCell = (v: unknown): CountCell | null => {
  if (v == null) return null;                       // the "not counted" signal
  const o = rec(v);
  const qty = numOrNull(o.qty);
  if (qty == null) return null;                     // a cell with no qty is not a count
  return { qty, value: numOrNull(o.value), rate: numOrNull(o.rate) };
};

const normaliseMatrix = (payload: unknown, from: string, to: string): MatrixResp => {
  const j = rec(payload);
  const dates = arr(j.dates).map(str).filter(Boolean);
  const totals: MatrixResp['totals_by_date'] = {};
  const tb = rec(j.totals_by_date);
  for (const d of dates) {
    const t = rec(tb[d]);
    totals[d] = { lines: num(t.lines), value: num(t.value) };
  }
  return {
    mode: 'matrix',
    dates,
    rows: arr(j.rows).map((r): MatrixRow => {
      const o = rec(r);
      const counts: Record<string, CountCell | null> = {};
      const c = rec(o.counts);
      for (const d of dates) counts[d] = normaliseCell(c[d]);
      return {
        material_id: o.material_id == null ? null : str(o.material_id),
        sub_recipe_id: o.sub_recipe_id == null ? null : str(o.sub_recipe_id),
        type: str(o.type) === 'SUB' ? 'SUB' : 'RAW',
        material: str(o.material),
        sku: str(o.sku),
        category: str(o.category),
        department: str(o.department),
        department_id: str(o.department_id),
        purchase_unit: str(o.purchase_unit),
        counts,
        latest_qty: numOrNull(o.latest_qty),
        previous_qty: numOrNull(o.previous_qty),
        change_qty: numOrNull(o.change_qty),
        change_pct: numOrNull(o.change_pct),
        latest_value: numOrNull(o.latest_value),
      };
    }),
    totals_by_date: totals,
    truncated: !!j.truncated,
    from: str(j.from) || from,
    to: str(j.to) || to,
    scope: j.scope == null ? undefined : str(j.scope),
    note: j.note == null ? null : str(j.note),
  };
};

const normaliseFlat = (payload: unknown, from: string, to: string): FlatResp => {
  const j = rec(payload);
  const rows = arr(j.rows).map((r): FlatRow => {
    const o = rec(r);
    return {
      date: str(o.date),
      department: str(o.department),
      material: str(o.material),
      sku: str(o.sku),
      category: str(o.category),
      purchase_unit: str(o.purchase_unit),
      counted_purchase: numOrNull(o.counted_purchase),
      rate: numOrNull(o.rate),
      rate_source: str(o.rate_source),
      value: numOrNull(o.value),
      recorded_by: str(o.recorded_by),
      type: str(o.type) === 'SUB' ? 'SUB' : 'RAW',
    };
  });
  const t = rec(j.totals);
  return {
    mode: 'flat',
    rows,
    totals: { count: numOrNull(t.count) ?? rows.length, value: num(t.value) },
    truncated: !!j.truncated,
    from: str(j.from) || from,
    to: str(j.to) || to,
    scope: j.scope == null ? undefined : str(j.scope),
    note: j.note == null ? null : str(j.note),
  };
};

/* ── Page ────────────────────────────────────────────────────────────────── */

type ViewMode = 'matrix' | 'flat';

export default function ClosingHistoryPage() {
  const [view, setView] = useState<ViewMode>('matrix');
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(todayIST);
  const [deptId, setDeptId] = useState('');
  /** What the user is typing. `qSent` is what actually went to the server — the
   *  table and the CSV are both answers to `qSent`, never to the live keystroke. */
  const [q, setQ] = useState('');
  const [qSent, setQSent] = useState('');

  const [matrix, setMatrix] = useState<MatrixResp | null>(null);
  const [flat, setFlat] = useState<FlatResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [depts, setDepts] = useState<DeptOption[]>([]);
  const [dlBusy, setDlBusy] = useState(false);
  const [dlErr, setDlErr] = useState('');

  /** Only the newest request may write state. Without this a slow response to an
   *  earlier search can land after a newer one and put stale rows under a filter
   *  that no longer matches them — a wrong report that looks perfectly fine. */
  const reqId = useRef(0);

  const rangeInverted = !!from && !!to && from > to;

  /* Debounce the search box. 350 ms is a typed word, not a keystroke. */
  useEffect(() => {
    const t = setTimeout(() => setQSent(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);

  /* Department options for the filter. The route re-checks scope on every call,
   * so this list is a convenience only — picking a department out of scope gets
   * an explicit 403 message rather than a misleading empty table. */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/departments', { credentials: 'same-origin' });
        if (!res.ok) return;                       // the filter is optional; the page still works
        const json = await res.json();
        if (!alive) return;
        setDepts(arr(json?.departments).map((d): DeptOption => {
          const o = rec(d);
          return {
            id: str(o.id),
            name: str(o.name),
            is_active: o.is_active == null ? true : !!Number(o.is_active),
            parent_name: str(o.parent_name) || undefined,
          };
        }).filter(d => d.id && d.name));
      } catch { /* filter stays as "All departments" — not worth an error banner */ }
    })();
    return () => { alive = false; };
  }, []);

  /** The exact query the table AND the download are both built from. */
  const params = useMemo(() => {
    const p = new URLSearchParams({ view, from, to });
    if (deptId) p.set('department_id', deptId);
    if (qSent) p.set('q', qSent);
    return p;
  }, [view, from, to, deptId, qSent]);

  const load = useCallback(async () => {
    // An inverted range is never fetched — but the old table must go with it.
    // Leaving last query's rows under a "swap the dates" banner invites reading
    // them as the answer to a range that was never asked.
    if (rangeInverted) {
      reqId.current++;                             // orphan any request still in flight
      setMatrix(null); setFlat(null); setError(''); setLoading(false);
      return;
    }
    const id = ++reqId.current;
    setLoading(true); setError('');
    try {
      const res = await fetch(`/api/closing-stock/history?${params.toString()}`,
                              { credentials: 'same-origin' });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      if (id !== reqId.current) return;            // a newer request already won
      if (view === 'matrix') { setMatrix(normaliseMatrix(json, from, to)); setFlat(null); }
      else { setFlat(normaliseFlat(json, from, to)); setMatrix(null); }
    } catch (e: unknown) {
      if (id !== reqId.current) return;
      // Drop the stale table with the error. Leaving last minute's rows under a
      // banner invites reading them as the answer to the filter that just failed.
      setMatrix(null); setFlat(null);
      setError((e as Error)?.message || 'Failed to load closing stock history');
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [params, view, from, to, rangeInverted]);

  useEffect(() => { load(); }, [load]);

  const resp: MatrixResp | FlatResp | null = view === 'matrix' ? matrix : flat;
  const truncated = !!resp?.truncated;
  const limitedScope = resp?.scope === 'limited';
  const filtered = !!deptId || !!qSent;

  /**
   * Download. Deliberately the SAME URL as the table, plus format=csv — so the
   * file cannot disagree with the screen. Every failure path throws so the page
   * can SAY so: a 403 saved as "closing-stock-matrix-….csv" containing
   * {"error":…} is worse than no download, because the user only finds out when
   * they open it. A JSON body counts as a failure even on a 200 — this endpoint
   * only ever answers JSON to complain.
   */
  const download = async () => {
    if (rangeInverted) { setDlErr('“From” is after “To” — swap the dates.'); return; }
    setDlBusy(true); setDlErr('');
    try {
      const p = new URLSearchParams(params);
      p.set('format', 'csv');
      const res = await fetch(`/api/closing-stock/history?${p.toString()}`,
                              { credentials: 'same-origin' });
      const ct = res.headers.get('content-type') || '';
      if (!res.ok || ct.includes('application/json')) {
        let msg = res.ok ? 'The server did not return a CSV.' : `HTTP ${res.status}`;
        try {
          const j = await res.json();
          if (j?.error) msg = String(j.error);
        } catch {
          // A Next error page answers in HTML — pasting that into the banner
          // tells the user nothing, so keep the status line instead.
          const t = (await res.text().catch(() => '')).trim();
          if (t && !t.startsWith('<') && t.length <= 300) msg = t;
        }
        throw new Error(msg);
      }
      const blob = await res.blob();
      if (blob.size === 0) throw new Error('The server returned an empty file.');
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = filenameFrom(
        res.headers.get('content-disposition'),
        view === 'matrix'
          ? `closing-stock-matrix-${from}_${to}.csv`
          : `closing-stock-history-${from}_${to}.csv`,
      );
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(href);
    } catch (e: unknown) {
      setDlErr((e as Error)?.message || 'Download failed');
    } finally {
      setDlBusy(false);
    }
  };

  const resetFilters = () => {
    setFrom(defaultFrom()); setTo(todayIST()); setDeptId(''); setQ(''); setDlErr('');
  };

  /* ── Access lock ───────────────────────────────────────────────────────── */

  // Same wording contract the entry sheet uses: the history route answers 403
  // with "…limited to admins, managers, HODs and store managers…", which is a
  // permission state, not a fault. A red crash banner would send the user
  // hunting for a bug that does not exist.
  const denied = !!error && /limited|authoriz/i.test(error);
  if (denied && !resp) {
    return (
      <div className="p-6 max-w-3xl mx-auto space-y-3">
        <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
          <History className="w-6 h-6 text-[#af4408]" /> Closing Stock History
        </h1>
        <div className="rounded-lg p-4 text-sm flex items-start gap-2 bg-amber-50 border border-amber-200 text-amber-900">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> <span>🔒 {error}</span>
        </div>
      </div>
    );
  }

  /* ── Render ────────────────────────────────────────────────────────────── */

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto space-y-4 pb-16">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex-1 min-w-[240px]">
          <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
            <History className="w-6 h-6 text-[#af4408]" /> Closing Stock History
          </h1>
          <p className="text-xs text-[#6B5744] mt-0.5">
            Every closing count already recorded — each item beside what the same item
            counted last time. All quantities in purchase units.
          </p>
        </div>
        <Link href="/inventory/closing-sheet"
              className="px-3 py-2 bg-white border border-[#8B7355] text-[#6B5744] hover:bg-[#FFF8F0] rounded-lg text-sm font-medium flex items-center gap-1.5">
          <ClipboardCheck className="w-4 h-4" /> Closing sheet <ArrowUpRight className="w-3.5 h-3.5" />
        </Link>
        <button onClick={download} disabled={dlBusy || rangeInverted}
                title="Downloads exactly what is on screen — the same view, dates, department and search."
                className="px-3 py-2 bg-[#af4408] text-white hover:bg-[#903905] disabled:opacity-40 rounded-lg text-sm font-medium flex items-center gap-1.5">
          {dlBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          Download CSV
        </button>
      </div>

      {/* View toggle — one page, two shapes of the same filtered data. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-[#E8D5C4] bg-white overflow-hidden">
          <ViewTab active={view === 'matrix'} onClick={() => setView('matrix')}
                   icon={<LayoutGrid className="w-3.5 h-3.5" />} label="Compare dates"
                   title="One row per item, one column per count date — newest first." />
          <ViewTab active={view === 'flat'} onClick={() => setView('flat')}
                   icon={<List className="w-3.5 h-3.5" />} label="All entries"
                   title="Every recorded count as its own line: date, department, item, quantity, rate, value." />
        </div>
        <span className="text-[11px] text-[#8B7355] leading-tight max-w-[560px]">
          {view === 'matrix'
            ? 'Newest count on the left. The Change column compares the latest count with the one before it.'
            : 'One line per recorded count, newest first.'}
        </span>
        {loading && <Loader2 className="w-4 h-4 animate-spin text-[#8B7355]" />}
      </div>

      {/* Filters — every one of them is applied by the server, so the download
          below can never be a different set of rows to the table above. */}
      <div className="bg-white border border-[#E8D5C4] rounded-lg p-3 flex flex-wrap items-end gap-2">
        <label className="text-[10px] text-[#8B7355]">
          <div className="mb-0.5 flex items-center gap-1"><CalendarDays className="w-3 h-3" /> From</div>
          <input type="date" value={from} max={to || undefined}
                 onChange={e => { setFrom(e.target.value); setDlErr(''); }}
                 className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg text-xs bg-white text-[#2D1B0E]" />
        </label>
        <label className="text-[10px] text-[#8B7355]">
          <div className="mb-0.5">To</div>
          <input type="date" value={to} min={from || undefined}
                 onChange={e => { setTo(e.target.value); setDlErr(''); }}
                 className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg text-xs bg-white text-[#2D1B0E]" />
        </label>
        <label className="text-[10px] text-[#8B7355]">
          <div className="mb-0.5 flex items-center gap-1"><Building2 className="w-3 h-3" /> Department</div>
          <select value={deptId} onChange={e => { setDeptId(e.target.value); setDlErr(''); }}
                  className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg text-xs bg-white text-[#2D1B0E] max-w-[220px]">
            <option value="">All departments in your scope</option>
            <option value={STORE_KEY}>Store / Overall (no department)</option>
            {depts.map(d => (
              <option key={d.id} value={d.id}>
                {d.name}{d.parent_name ? ` · ${d.parent_name}` : ''}{d.is_active ? '' : ' (inactive)'}
              </option>
            ))}
          </select>
        </label>
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <div className="text-[10px] text-[#8B7355] mb-0.5">Item</div>
          <Search className="w-4 h-4 absolute left-2.5 top-[26px] text-[#8B7355]" />
          <input value={q} onChange={e => { setQ(e.target.value); setDlErr(''); }}
                 placeholder="Search item, SKU or category…"
                 className="w-full pl-8 pr-8 py-1.5 border border-[#E8D5C4] rounded-lg text-xs bg-white text-[#2D1B0E]" />
          {q && (
            <button onClick={() => setQ('')} aria-label="Clear item search"
                    className="absolute right-2 top-[26px] text-[#8B7355] hover:text-[#2D1B0E]">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-2 pb-0.5">
          <button type="button" onClick={() => { setFrom(shiftDays(todayIST(), -29)); setTo(todayIST()); setDlErr(''); }}
                  className="text-[11px] text-[#af4408] hover:underline">Last 30 days</button>
          <button type="button" onClick={() => { setFrom(shiftDays(todayIST(), -364)); setTo(todayIST()); setDlErr(''); }}
                  className="text-[11px] text-[#af4408] hover:underline">Last 12 months</button>
          <button type="button" onClick={resetFilters}
                  className="text-[11px] text-[#8B7355] hover:underline">Reset</button>
        </div>
      </div>

      {rangeInverted && (
        <div className="rounded-lg p-3 text-sm flex items-center gap-2 bg-amber-50 border border-amber-200 text-amber-900">
          <AlertCircle className="w-4 h-4 shrink-0" />
          “From” ({from}) is after “To” ({to}) — swap the dates. Nothing is being loaded until you do,
          because an empty table here would read as “no counts were taken”.
        </div>
      )}

      {error && !denied && (
        <div className="rounded-lg p-3 text-sm flex items-start gap-2 bg-red-50 border border-red-200 text-red-700">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> <span>{error}</span>
        </div>
      )}
      {denied && (
        <div className="rounded-lg p-3 text-sm flex items-start gap-2 bg-amber-50 border border-amber-200 text-amber-900">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> <span>🔒 {error}</span>
        </div>
      )}
      {dlErr && (
        <div className="rounded-lg p-3 text-sm flex items-start gap-2 bg-red-50 border border-red-200 text-red-700">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> <span>Download failed — {dlErr}</span>
        </div>
      )}

      {/* A silently shortened history is a WRONG history: the reader cannot tell
          a missing month from a month nobody counted. Shout, above the table. */}
      {truncated && (
        <div className="rounded-lg p-3 text-sm flex items-start gap-2 bg-amber-100 border-2 border-amber-400 text-amber-900">
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold">This history is INCOMPLETE — it was cut short.</div>
            <div className="text-xs mt-0.5">
              {resp?.note
                || 'The range holds more counts than can be sent at once. Narrow the dates, pick one department, or search for an item to see the rest.'}
              {' '}The CSV download is cut at the same point.
            </div>
          </div>
        </div>
      )}

      {limitedScope && (
        <div className="rounded-lg p-3 text-xs flex items-center gap-2 bg-[#FFF8F0] border border-[#E8D5C4] text-[#6B5744]">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 text-[#8B7355]" />
          Showing only the departments you are assigned to or have been granted.
        </div>
      )}

      {/* Summary */}
      {resp && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
          {resp.mode === 'matrix' ? (
            <>
              <SummaryCard icon={<CalendarDays className="w-4 h-4" />} label="Count dates"
                           value={resp.dates.length.toLocaleString('en-IN')}
                           note={`${fmtISTDate(resp.from)} → ${fmtISTDate(resp.to)}`} />
              <SummaryCard icon={<Layers className="w-4 h-4" />} label="Items tracked"
                           value={resp.rows.length.toLocaleString('en-IN')}
                           note={filtered ? 'filtered view' : undefined} />
              <SummaryCard icon={<ClipboardCheck className="w-4 h-4" />} label="Latest count"
                           value={resp.dates[0] ? fmtISTDate(resp.dates[0]) : EM}
                           note={resp.dates[0]
                             ? `${(resp.totals_by_date[resp.dates[0]]?.lines ?? 0).toLocaleString('en-IN')} lines`
                             : undefined} />
              <SummaryCard icon={<IndianRupee className="w-4 h-4" />} label="Latest count value"
                           value={resp.dates[0] ? inr(resp.totals_by_date[resp.dates[0]]?.value ?? 0) : EM}
                           note="valued at the rate stored when it was counted" />
            </>
          ) : (
            <>
              <SummaryCard icon={<CalendarDays className="w-4 h-4" />} label="Range"
                           value={`${fmtISTDate(resp.from)}`} note={`to ${fmtISTDate(resp.to)}`} />
              <SummaryCard icon={<List className="w-4 h-4" />} label="Entries"
                           value={resp.totals.count.toLocaleString('en-IN')}
                           note={filtered ? 'filtered view' : undefined} />
              <SummaryCard icon={<Layers className="w-4 h-4" />} label="Count dates"
                           value={new Set(resp.rows.map(r => r.date)).size.toLocaleString('en-IN')} />
              <SummaryCard icon={<IndianRupee className="w-4 h-4" />} label="Value in range"
                           value={inr(resp.totals.value)}
                           note="every count in the range added together" />
            </>
          )}
        </div>
      )}

      {/* Table */}
      {loading && !resp ? (
        <div className="bg-white border border-[#E8D5C4] rounded-lg p-8 text-center text-sm text-[#6B5744]">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading closing stock history…
        </div>
      ) : !resp ? null
        : resp.mode === 'matrix'
          ? <MatrixTable data={resp} filtered={filtered} />
          : <FlatTable data={resp} filtered={filtered} />}
    </div>
  );
}

/* ── Compare dates (the matrix) ──────────────────────────────────────────── */

function MatrixTable({ data, filtered }: { data: MatrixResp; filtered: boolean }) {
  const { dates, rows, totals_by_date } = data;

  if (rows.length === 0 || dates.length === 0) {
    return <EmptyState filtered={filtered} from={data.from} to={data.to} />;
  }

  return (
    <div className="space-y-2">
      {/* A colour difference nobody has been told about is not information. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[#6B5744]">
        <span className="flex items-center gap-1.5">
          <span className="inline-block px-1.5 py-0.5 rounded bg-[#F7F1EA] text-[#B9A896] border border-[#EFE3D6]">{EM}</span>
          not counted on that date
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block px-1.5 py-0.5 rounded bg-white border border-[#E8D5C4] text-[#2D1B0E] font-medium tabular-nums">0 kg</span>
          counted, and the count was zero
        </span>
        {dates.length > 8 && (
          <span className="text-[#8B7355]">
            {dates.length.toLocaleString('en-IN')} count dates — scroll the table sideways for older ones.
          </span>
        )}
      </div>

      {/* Wide by nature: the table scrolls inside this box, the page never does. */}
      <div className="bg-white border border-[#E8D5C4] rounded-lg overflow-x-auto">
        <table className="text-xs border-collapse min-w-full">
          <thead>
            <tr className="bg-[#FFF1E3] text-[#6B5744]">
              <th className="sticky left-0 z-20 bg-[#FFF1E3] text-left font-semibold px-3 py-2 min-w-[220px] border-r border-[#E8D5C4]">
                Item
              </th>
              <th className="text-right font-semibold px-3 py-2 min-w-[130px]"
                  title="Latest count compared with the count before it.">
                Change
              </th>
              <th className="text-right font-semibold px-3 py-2 min-w-[100px]"
                  title="Value of the latest count, at the rate stored when it was counted.">
                Latest value
              </th>
              {dates.map((d, i) => (
                <th key={d}
                    className={`text-right font-semibold px-3 py-2 min-w-[110px] ${
                      i === 0 ? 'bg-[#FBE7D3] text-[#2D1B0E]' : ''}`}>
                  {fmtISTDate(d)}
                  <div className="text-[9px] font-normal text-[#8B7355]">
                    {i === 0 ? 'latest' : i === 1 ? 'previous' : `${i} counts ago`}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => {
              const rowKey = `${r.type}:${r.material_id || r.sub_recipe_id || ri}:${r.department_id}`;
              return (
                <tr key={rowKey} className="border-t border-[#F0E4D6] group hover:bg-[#FFF8F0]">
                  {/* The sticky cell carries its own background — a transparent
                      one lets the scrolled date columns show through it. */}
                  <td className="sticky left-0 z-10 bg-white group-hover:bg-[#FFF8F0] px-3 py-1.5 border-r border-[#E8D5C4]">
                    <div className="font-medium text-[#2D1B0E] leading-tight">
                      {r.material || EM}
                      {r.type === 'SUB' && (
                        <span className="ml-1.5 text-[9px] uppercase px-1 rounded bg-[#FFF1E3] text-[#8B7355] align-middle"
                              title="Sub-recipe — counted in its own yield unit, not a purchase unit.">sub</span>
                      )}
                    </div>
                    <div className="text-[10px] text-[#8B7355] leading-tight">
                      {r.department || EM}
                      {r.category && <span className="text-[#B9A896]"> · {r.category}</span>}
                    </div>
                    {r.sku && <div className="text-[9px] font-mono text-[#B9A896]">{r.sku}</div>}
                  </td>

                  <td className="px-3 py-1.5 text-right">
                    <ChangeCell row={r} />
                  </td>

                  <td className="px-3 py-1.5 text-right tabular-nums text-[#2D1B0E]">
                    {r.latest_value == null
                      ? <span className="text-[#B9A896]" title="This count has no rate basis, so it carries no value.">{EM}</span>
                      : inr2(r.latest_value)}
                  </td>

                  {dates.map((d, i) => {
                    const c = r.counts[d];
                    // NOT COUNTED and COUNTED-ZERO are different facts. The
                    // shaded cell + pale em-dash says "nobody looked here";
                    // "0 <unit>" in full-strength text says "we looked, there
                    // is none". Never let one render as the other.
                    if (!c) {
                      return (
                        <td key={d}
                            className="px-3 py-1.5 text-right bg-[#F7F1EA] text-[#B9A896]"
                            title={`Not counted on ${fmtISTDate(d)}`}>
                          {EM}
                        </td>
                      );
                    }
                    const money = c.value == null ? 'no value (no rate basis)' : inr2(c.value);
                    const rateTxt = c.rate == null ? 'no rate recorded' : `${inr2(c.rate)} / ${r.purchase_unit || 'unit'}`;
                    return (
                      <td key={d}
                          title={`${fmtISTDate(d)} · ${fmtQtyNum(c.qty)} ${r.purchase_unit} · ${money} · ${rateTxt}`}
                          className={`px-3 py-1.5 text-right tabular-nums ${
                            i === 0 ? 'bg-[#FEF6EE] font-medium text-[#2D1B0E]' : 'text-[#2D1B0E]'}`}>
                        {/* unit-lock: qty arrives in purchase units from the
                            route; printing r.purchase_unit beside it is the
                            whole conversion — nothing is divided here. */}
                        {fmtQtyNum(c.qty)} <span className="text-[9px] text-[#B9A896]">{r.purchase_unit}</span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-[#E8D5C4] bg-[#FFF1E3] font-semibold text-[#2D1B0E]">
              <td className="sticky left-0 z-10 bg-[#FFF1E3] px-3 py-2 border-r border-[#E8D5C4]">
                Total value per count date
                <div className="text-[9px] font-normal text-[#8B7355]">
                  {rows.length.toLocaleString('en-IN')} item{rows.length === 1 ? '' : 's'}
                  {filtered && ' · filtered view'}
                </div>
              </td>
              {/* Quantities are never added across materials, in any column. */}
              <td className="px-3 py-2 text-right text-[#B9A896] font-normal"
                  title="Quantities cannot be added across different materials.">{EM}</td>
              <td className="px-3 py-2 text-right text-[#B9A896] font-normal"
                  title="Not totalled: each row's latest count can be on a different date, so the sum would be the valuation of no single day. Use the per-date totals.">
                {EM}
              </td>
              {dates.map((d, i) => {
                const t = totals_by_date[d] || { lines: 0, value: 0 };
                return (
                  <td key={d}
                      className={`px-3 py-2 text-right tabular-nums ${i === 0 ? 'bg-[#FBE7D3]' : ''}`}>
                    {inr(t.value)}
                    <div className="text-[9px] font-normal text-[#8B7355]">
                      {t.lines.toLocaleString('en-IN')} line{t.lines === 1 ? '' : 's'}
                    </div>
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="text-[11px] text-[#8B7355]">
        Every count is valued at the rate stored when it was taken, so a past total never
        changes when a purchase price moves today.
      </p>
    </div>
  );
}

/**
 * Latest vs previous. A null change is an em-dash and NEVER "0%": an item
 * counted only once in this range has no previous figure, and printing 0%
 * claims it held perfectly steady — a statement nobody made.
 */
function ChangeCell({ row }: { row: MatrixRow }) {
  const dq = row.change_qty;
  if (dq == null) {
    return (
      <span className="text-[#B9A896]"
            title="Counted only once in this range — there is no earlier count to compare against.">
        {EM}
      </span>
    );
  }
  const up = dq > 0;
  const down = dq < 0;
  const tone = up ? 'text-emerald-700' : down ? 'text-red-700' : 'text-[#6B5744]';
  const Icon = up ? ArrowUpRight : down ? ArrowDownRight : Minus;
  const pct = row.change_pct;
  const prev = row.previous_qty;
  const now = row.latest_qty;
  // unit-lock: latest/previous are the route's purchase-basis figures.
  const title = prev == null || now == null
    ? 'Change since the previous count.'
    : `Previous ${fmtQtyNum(prev)} ${row.purchase_unit} → latest ${fmtQtyNum(now)} ${row.purchase_unit}`;
  return (
    <span className={`inline-flex items-center justify-end gap-1 tabular-nums ${tone}`} title={title}>
      <Icon className="w-3.5 h-3.5 shrink-0" />
      <span>
        {up ? '+' : down ? '−' : ''}{fmtQtyNum(Math.abs(dq))} <span className="text-[9px] text-[#B9A896]">{row.purchase_unit}</span>
      </span>
      <span className="text-[10px] opacity-80">
        {/* A percentage off a zero previous count is not a number — dash it. */}
        {pct == null ? EM : `${pct > 0 ? '+' : pct < 0 ? '−' : ''}${Math.abs(pct).toLocaleString('en-IN', { maximumFractionDigits: 1 })}%`}
      </span>
    </span>
  );
}

/* ── All entries (the existing flat list) ────────────────────────────────── */

function FlatTable({ data, filtered }: { data: FlatResp; filtered: boolean }) {
  const { rows } = data;
  if (rows.length === 0) return <EmptyState filtered={filtered} from={data.from} to={data.to} />;

  return (
    <div className="space-y-2">
      <div className="bg-white border border-[#E8D5C4] rounded-lg overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="bg-[#FFF1E3] text-[#6B5744]">
              <th className="text-left font-semibold px-3 py-2 min-w-[110px]">Date</th>
              <th className="text-left font-semibold px-3 py-2 min-w-[130px]">Department</th>
              <th className="text-left font-semibold px-3 py-2 min-w-[200px]">Item</th>
              <th className="text-right font-semibold px-3 py-2 min-w-[110px]">Counted</th>
              <th className="text-right font-semibold px-3 py-2 min-w-[120px]">Rate</th>
              <th className="text-right font-semibold px-3 py-2 min-w-[100px] bg-[#FBE7D3]">Value</th>
              <th className="text-left font-semibold px-3 py-2 min-w-[110px]">Recorded by</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.date}-${r.department}-${r.material}-${i}`}
                  className="border-t border-[#F0E4D6] hover:bg-[#FFF8F0]">
                <td className="px-3 py-1.5 text-[#2D1B0E] whitespace-nowrap">{fmtISTDate(r.date)}</td>
                <td className="px-3 py-1.5 text-[#6B5744]">{r.department || EM}</td>
                <td className="px-3 py-1.5">
                  <div className="font-medium text-[#2D1B0E] leading-tight">
                    {r.material || EM}
                    {r.type === 'SUB' && (
                      <span className="ml-1.5 text-[9px] uppercase px-1 rounded bg-[#FFF1E3] text-[#8B7355] align-middle"
                            title="Sub-recipe — counted in its own yield unit.">sub</span>
                    )}
                  </div>
                  <div className="text-[9px] text-[#B9A896]">
                    <span className="font-mono">{r.sku || '·'}</span>
                    {r.category && <span> · {r.category}</span>}
                  </div>
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-[#2D1B0E]">
                  {/* unit-lock: counted_purchase is already in purchase units. */}
                  {r.counted_purchase == null
                    ? <span className="text-[#B9A896]">{EM}</span>
                    : <>{fmtQtyNum(r.counted_purchase)} <span className="text-[9px] text-[#B9A896]">{r.purchase_unit}</span></>}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {r.rate == null ? (
                    <span className="text-[#B9A896]"
                          title="No rate was recorded for this count, so it carries no value.">{EM}</span>
                  ) : (
                    <>
                      <span className="text-[#2D1B0E]">{inr2(r.rate)}</span>
                      <span className="text-[9px] text-[#B9A896]"> / {r.purchase_unit}</span>
                      <div className="text-[9px] text-[#B8A590]">{RATE_LABEL[r.rate_source] || r.rate_source}</div>
                    </>
                  )}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums bg-[#FEF6EE] text-[#2D1B0E]">
                  {r.value == null ? <span className="text-[#B9A896]">{EM}</span> : inr2(r.value)}
                </td>
                <td className="px-3 py-1.5 text-[10px] text-[#6B5744]">{r.recorded_by || EM}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-[#E8D5C4] bg-[#FFF1E3] font-semibold text-[#2D1B0E]">
              <td className="px-3 py-2" colSpan={3}>
                Total
                <span className="ml-1.5 text-[10px] font-normal text-[#8B7355]">
                  {data.totals.count.toLocaleString('en-IN')} entr{data.totals.count === 1 ? 'y' : 'ies'}
                  {filtered && ' · filtered view'}
                </span>
              </td>
              {/* 2 BTL + 3 kg is not a number in any basis. */}
              <td className="px-3 py-2 text-right text-[#B9A896] font-normal"
                  title="Quantities cannot be added across different materials.">{EM}</td>
              <td className="px-3 py-2 text-right text-[#B9A896] font-normal">{EM}</td>
              <td className="px-3 py-2 text-right tabular-nums bg-[#FBE7D3]">{inr2(data.totals.value)}</td>
              <td className="px-3 py-2" />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="text-[11px] text-[#8B7355]">
        Every count is valued at the rate stored when it was taken, so a past total never
        changes when a purchase price moves today.
      </p>
    </div>
  );
}

/* ── Pieces ──────────────────────────────────────────────────────────────── */

function ViewTab({ active, onClick, icon, label, title }: {
  active: boolean; onClick: () => void; icon: React.ReactNode; label: string; title: string;
}) {
  return (
    <button type="button" onClick={onClick} title={title} aria-pressed={active}
            className={`px-3 py-1.5 text-xs font-medium flex items-center gap-1.5 transition-colors ${
              active ? 'bg-[#af4408] text-white' : 'bg-white text-[#6B5744] hover:bg-[#FFF1E3]'}`}>
      {icon} {label}
    </button>
  );
}

/**
 * Two different nothings, and conflating them misleads: "your filter matched
 * nothing" is a filter problem, "nothing was counted in this range" is a
 * counting problem, and the fix for each is the opposite of the other.
 */
function EmptyState({ filtered, from, to }: { filtered: boolean; from: string; to: string }) {
  return (
    <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-8 text-center text-sm text-[#8B7355]">
      <PackageX className="w-6 h-6 mx-auto mb-2 text-[#B9A896]" />
      {filtered ? (
        <>
          No closing count matches these filters between {fmtISTDate(from)} and {fmtISTDate(to)}.
          <div className="text-xs text-[#B9A896] mt-1">
            Clear the department or the item search, or widen the dates.
          </div>
        </>
      ) : (
        <>
          No closing stock was recorded between {fmtISTDate(from)} and {fmtISTDate(to)}.
          <div className="text-xs text-[#B9A896] mt-1">
            Counts recorded on the{' '}
            <Link href="/inventory/closing-sheet" className="text-[#af4408] hover:underline">
              Department Closing Sheet
            </Link>{' '}
            appear here from the moment they are saved.
          </div>
        </>
      )}
    </div>
  );
}

function SummaryCard({ icon, label, value, note }: {
  icon: React.ReactNode; label: string; value: string; note?: string;
}) {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-[#8B7355]">
        {icon} {label}
      </div>
      <div className="mt-1 text-lg font-bold text-[#2D1B0E] tabular-nums">{value}</div>
      {note && <div className="text-[9px] text-[#B9A896] leading-tight mt-0.5">{note}</div>}
    </div>
  );
}
