'use client';

/**
 * Receiving Variance Report — Phase 1 §4.
 * Shows GRN lines where physical receipt did not match the PO ordered qty,
 * or where some quantity was rejected at QC. Helps spot vendor short-supply,
 * over-supply, and chronic quality issues.
 *
 * SCOPE: quantity and QC variance ONLY. The API filter is
 * `quantity_received != quantity_ordered OR quantity_rejected > 0`, so a line
 * received in full at a rate that differs from the PO does NOT appear here —
 * that deviation is captured by the receive route's admin alert / audit event
 * ('po.received_deviation') and is reviewed on /audit.
 *
 * ── FILTERING (2026-07-31) ────────────────────────────────────────────────
 * Owner: "Receiving Variance need search option, date and items, like keep a
 * filter option for all search."
 *
 * WHERE EACH FILTER RUNS, and why:
 *   • Date range + Vendor  → SERVER (?from/?to/?vendor_id, already supported).
 *     These bound how much comes down the wire, so they must be upstream.
 *   • Text search, Variance type, Reject reason → CLIENT, over the rows the
 *     server already returned.
 *
 *   The report is not a list of receipts — it is the *exception* subset of
 *   PO-linked GRN lines (received != ordered, or something was rejected). A
 *   date-bounded load is tens of rows, not thousands; the whole payload is
 *   already in memory for the summary cards and the vendor roll-up. Filtering
 *   it client-side means the box responds on every keystroke with no debounce,
 *   no request storm and no chance of a stale response overwriting a newer
 *   one. Anything that could actually make the payload big — the date window
 *   and the vendor — is still narrowed server-side before it is sent.
 *
 * WHAT THE THREE VARIANCE TYPES MEAN (this page's own vocabulary — the four
 * summary cards — NOT invented categories):
 *   • Short supply  → accept_delta < 0  (accepted less than ordered)
 *   • Excess supply → accept_delta > 0  (accepted more than ordered)
 *   • Rejected at QC→ quantity_rejected > 0
 * A line can be BOTH short and rejected (rejecting stock is what makes it
 * short), so the type filter is a "matches this trait" filter, not a partition.
 * "Rate mismatch" is NOT a variance type here — it is one of the QC
 * `rejection_reason` values (see REASON_TONE), so it is reachable through the
 * Reject-reason filter. An off-PO rate on a line received in full is not in
 * this report at all; it is on /audit.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, TrendingDown, TrendingUp, XCircle, Loader2, Search, X } from 'lucide-react';
import { todayIST } from '@/lib/format-date';

const fmt = (v: number) => '₹' + Math.round(v || 0).toLocaleString('en-IN');

/**
 * "Today" is the IST calendar day, not the UTC one. `new Date().toISOString()`
 * — what this file used before the presets existed — returns yesterday's date
 * for the whole 00:00–05:30 IST window, so an early-morning "Today" preset
 * would have shown the previous day's receipts and the default 30-day window
 * was off by one until half past five. todayIST() is the shared helper the
 * purchase/closing screens already use.
 */
const today = () => todayIST();
/** Shift a YYYY-MM-DD calendar date by n days without re-entering local time. */
const shiftDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
};
const minusDays = (n: number) => shiftDays(today(), -n);
const monthStart = () => today().slice(0, 8) + '01';

const DEFAULT_FROM = () => minusDays(30);
const DEFAULT_TO   = () => today();

/**
 * Quick date presets. `range()` is evaluated on click, never cached, so the
 * page cannot go stale over a midnight rollover.
 *
 * ORDER MATTERS: the highlight uses the FIRST preset whose range equals the
 * current one, and on the 31st of a month "This month" and "Last 30 days" are
 * the same two dates. Listing 'Last 30 days' first means the default view
 * always lights up the preset that IS the default.
 */
const DATE_PRESETS: { key: string; label: string; range: () => [string, string] }[] = [
  { key: 'today', label: 'Today',        range: () => [today(), today()] },
  { key: '7d',    label: 'Last 7 days',  range: () => [minusDays(6), today()] },
  { key: '30d',   label: 'Last 30 days', range: () => [minusDays(30), today()] },
  { key: 'month', label: 'This month',   range: () => [monthStart(), today()] },
  { key: '90d',   label: 'Last 90 days', range: () => [minusDays(90), today()] },
];

type VType = 'all' | 'short' | 'excess' | 'rejected';
const VTYPE_LABEL: Record<VType, string> = {
  all:      'All variance',
  short:    'Short supply',
  excess:   'Excess supply',
  rejected: 'Rejected at QC',
};

interface Row {
  grn_id: string; grn_number: string; date: string; vendor: string; po_number?: string;
  material_id: string; material_name: string; material_sku?: string; material_unit: string;
  pack_size?: number; purchase_unit?: string;
  quantity_ordered: number; quantity_received: number; quantity_accepted: number;
  quantity_rejected: number; rejection_reason?: string;
  unit_price: number; average_price: number;
  receive_delta: number; accept_delta: number; accept_delta_value: number;
}

interface Resp {
  range: { from: string | null; to: string | null };
  summary: {
    lines: number; net_value_short: number; net_value_excess: number; total_rejected_value: number;
    reason_stats: Record<string, { count: number; qty: number; value: number }>;
    /**
     * How many PO-linked GRN lines exist in the range at all (variance or not).
     * OPTIONAL: older/other builds of /api/receiving-variance do not send it. It
     * is only used to tell "nothing was received" apart from "received, nothing
     * deviated" in the empty state — when it is absent we fall back to wording
     * that is true either way rather than guessing.
     */
    receipts_in_range?: number;
  };
  rows: Row[];
}

/**
 * The rate this report values a line at. The API computes Δ ₹ as
 * `delta * COALESCE(NULLIF(gi.unit_price,0), rm.average_price * packGuard)` —
 * quantities are PURCHASE units while average_price is ₹ per RECIPE unit, so the
 * average has to be lifted by pack_size, and only when BOTH halves of the guard
 * hold (pack_size > 1 AND recipe unit <> purchase unit). Mirrored here so the
 * Rejected ₹ roll-up cannot disagree with the Δ ₹ column on a line whose stored
 * unit_price is 0 (legacy / imported GRNs).
 */
const effectiveRate = (r: Row) => {
  if (r.unit_price) return r.unit_price;
  const recipeUnit   = (r.material_unit || '').toLowerCase().trim();
  const purchaseUnit = (r.purchase_unit || r.material_unit || '').toLowerCase().trim();
  const pack = Number(r.pack_size || 1);
  return (r.average_price || 0) * (pack > 1 && recipeUnit !== purchaseUnit ? pack : 1);
};

const REASON_TONE: Record<string, string> = {
  damage:        'bg-orange-100 text-orange-700',
  short_weight:  'bg-amber-100 text-amber-800',
  expired:       'bg-red-100 text-red-700',
  quality:       'bg-red-50 text-red-700',
  rate_mismatch: 'bg-purple-100 text-purple-700',
};
const prettyReason = (r: string) => r.replace(/_/g, ' ');

/** One chip in the active-filter summary. */
function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full bg-[#FFF1E3] border border-[#E8D5C4] text-[11px] text-[#6B5744]">
      {label}
      <button
        type="button"
        onClick={onClear}
        title={`Clear ${label}`}
        aria-label={`Clear ${label}`}
        className="rounded-full p-0.5 hover:bg-[#E8D5C4] text-[#8B7355] hover:text-[#af4408]"
      >
        <X size={11} />
      </button>
    </span>
  );
}

export default function ReceivingVariancePage() {
  // ── server-side filters (re-fetch) ──
  const [from, setFrom]   = useState(DEFAULT_FROM);
  const [to,   setTo]     = useState(DEFAULT_TO);
  const [vendor, setVendor] = useState('');
  // ── client-side filters (no re-fetch) ──
  const [q, setQ]         = useState('');
  const [vtype, setVtype] = useState<VType>('all');
  const [reason, setReason] = useState('');

  const [vendors, setVendors] = useState<{ id: string; name: string }[]>([]);
  const [data, setData]   = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Only the newest in-flight request may write state — rapid filter changes
  // fire overlapping fetches and they do not necessarily resolve in order.
  const reqSeq = useRef(0);

  useEffect(() => {
    fetch('/api/vendors').then(r => r.json()).then(d => setVendors(d.vendors || d || [])).catch(() => {});
  }, []);

  const reload = async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    const qs = new URLSearchParams({ from, to });
    if (vendor) qs.set('vendor_id', vendor);
    try {
      const res = await fetch(`/api/receiving-variance?${qs}`);
      const d = await res.json().catch(() => null);
      if (seq !== reqSeq.current) return;          // superseded by a newer filter change
      // An error body (401 'Sign in required' from the proxy, 500 from the route)
      // has no `rows` key — storing it would make every `data.rows` / `data.summary`
      // read below throw. Keep the payload only when it is actually a report.
      if (d && Array.isArray(d.rows)) { setData(d); setError(''); }
      else { setData(null); setError((d && d.error) || `Could not load the report (HTTP ${res.status}).`); }
    } catch (e) {
      if (seq !== reqSeq.current) return;
      setData(null);
      setError((e instanceof Error && e.message) || 'Could not reach the server.');
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  };
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [from, to, vendor]);

  const allRows = useMemo(() => data?.rows || [], [data]);
  const vendorName = useMemo(
    () => vendors.find(v => v.id === vendor)?.name || (vendor ? 'selected vendor' : ''),
    [vendors, vendor],
  );

  /**
   * Reject reasons actually present in the loaded range, so the dropdown never
   * offers a reason this date window has never seen. Built from the API's
   * reason_stats (which is computed over every loaded row) with a fallback to
   * the rows themselves for builds that do not send it.
   */
  const reasonOptions = useMemo(() => {
    const keys = new Set<string>(Object.keys(data?.summary?.reason_stats || {}));
    for (const r of allRows) if (r.rejection_reason) keys.add(r.rejection_reason);
    return [...keys].sort();
  }, [data, allRows]);

  /**
   * The <select> must always contain its own value. Narrow the date window to a
   * range with no "expired" rejections while "expired" is picked and the option
   * disappears — the control then renders BLANK while still silently hiding
   * every row. Keeping the orphaned choice in the list (labelled as such) means
   * the filter is always visible and always clearable, and the empty state can
   * explain the zero instead of the page looking broken.
   */
  const orphanReason = reason !== '' && !reasonOptions.includes(reason);
  const reasonSelectOptions = orphanReason ? [...reasonOptions, reason].sort() : reasonOptions;

  /**
   * ONE box, four fields — material name, SKU / item code, PO number and
   * vendor (plus the GRN number, which sits in the same cell as the PO number
   * and would be baffling to type in and get nothing). Case-insensitive, and
   * multi-word input is AND-ed term by term so "amul 5kg" narrows instead of
   * needing the words adjacent.
   */
  const terms = useMemo(() => q.trim().toLowerCase().split(/\s+/).filter(Boolean), [q]);

  const typeOrTextOn = terms.length > 0 || vtype !== 'all';
  const clientFiltered = typeOrTextOn || reason !== '';

  /** The single client-side predicate. `skipReason` powers the reason facets. */
  const matches = useCallback((r: Row, skipReason = false) => {
    if (vtype === 'short'    && !(r.accept_delta < 0))      return false;
    if (vtype === 'excess'   && !(r.accept_delta > 0))      return false;
    if (vtype === 'rejected' && !(r.quantity_rejected > 0)) return false;
    if (!skipReason && reason && r.rejection_reason !== reason) return false;
    if (terms.length) {
      const hay = [
        r.material_name, r.material_sku, r.po_number, r.vendor, r.grn_number,
      ].map(v => String(v ?? '')).join(' • ').toLowerCase();
      if (!terms.every(t => hay.includes(t))) return false;
    }
    return true;
  }, [vtype, reason, terms]);

  const filtered = useMemo(() => allRows.filter(r => matches(r)), [allRows, matches]);

  /**
   * Summary over the VISIBLE rows, using the exact formulas the API uses so a
   * narrowed view can never be valued on a different basis than the full one.
   *   short  = −Σ accept_delta_value where accept_delta < 0   (API: net_value_short)
   *   excess =  Σ accept_delta_value where accept_delta > 0   (API: net_value_excess)
   *   reject =  Σ quantity_rejected × effectiveRate           (API: total_rejected_value)
   * Field names carry `_value` because they are rupees, not stock quantities.
   */
  const subsetSummary = useMemo(() => {
    let short_value = 0, excess_value = 0, rejected_value = 0;
    for (const r of filtered) {
      if (r.accept_delta < 0) short_value += -(r.accept_delta_value || 0);
      else if (r.accept_delta > 0) excess_value += (r.accept_delta_value || 0);
      if (r.quantity_rejected > 0) rejected_value += (r.quantity_rejected * effectiveRate(r));
    }
    return { lines: filtered.length, short_value, excess_value, rejected_value };
  }, [filtered]);

  /**
   * Reason tiles are a FACET picker, not a summary: they are computed over the
   * rows that pass every filter EXCEPT the reason itself. Without that, picking
   * "damage" made every other reason tile disappear and there was no way to
   * switch to "expired" without first clearing. With no text/type filter on,
   * the server's own reason_stats is used verbatim, so the default view is
   * unchanged from before the filters existed.
   */
  const reasonFacets = useMemo(() => {
    if (!typeOrTextOn) return data?.summary?.reason_stats || {};
    const stats: Record<string, { count: number; qty: number; value: number }> = {};
    for (const r of allRows) {
      if (!r.rejection_reason || !matches(r, true)) continue;
      const slot = stats[r.rejection_reason] || (stats[r.rejection_reason] = { count: 0, qty: 0, value: 0 });
      slot.count += 1; slot.qty += r.quantity_rejected; slot.value += (r.quantity_rejected * effectiveRate(r));
    }
    return stats;
  }, [data, allRows, typeOrTextOn, matches]);

  /**
   * When no CLIENT filter is on, the cards show the server's own numbers
   * verbatim — byte-for-byte the behaviour this page had before the filters
   * existed. Only a narrowed view falls back to the locally recomputed subset
   * (identical formulas, fewer rows), and then every card also states the
   * unfiltered total it was drawn from.
   */
  const cards = clientFiltered ? subsetSummary : {
    lines:          data?.summary?.lines ?? 0,
    short_value:    data?.summary?.net_value_short ?? 0,
    excess_value:   data?.summary?.net_value_excess ?? 0,
    rejected_value: data?.summary?.total_rejected_value ?? 0,
  };

  const activePreset = DATE_PRESETS.find(p => { const [f, t] = p.range(); return f === from && t === to; });
  const isDefaultRange = from === DEFAULT_FROM() && to === DEFAULT_TO();
  const anyFilter = clientFiltered || !!vendor || !isDefaultRange;

  const clearAll = () => {
    setQ(''); setVtype('all'); setReason(''); setVendor('');
    setFrom(DEFAULT_FROM()); setTo(DEFAULT_TO());
  };
  const clearClientFilters = () => { setQ(''); setVtype('all'); setReason(''); };

  // Group by vendor for the secondary view — over the VISIBLE rows, so the
  // roll-up and the line detail below it can never describe different sets.
  const vendorRoll = useMemo(() => {
    const m: Record<string, { vendor: string; lines: number; short: number; excess: number; rejected: number }> = {};
    for (const r of filtered) {
      const k = r.vendor || '—';
      const slot = m[k] || (m[k] = { vendor: k, lines: 0, short: 0, excess: 0, rejected: 0 });
      slot.lines += 1;
      if (r.accept_delta < 0) slot.short += -(r.accept_delta_value || 0);
      else if (r.accept_delta > 0) slot.excess += (r.accept_delta_value || 0);
      if (r.quantity_rejected > 0) slot.rejected += (r.quantity_rejected * effectiveRate(r));
    }
    return Object.values(m).sort((a, b) => (b.short + b.rejected) - (a.short + a.rejected));
  }, [filtered]);

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center gap-3">
        <AlertTriangle className="text-[#af4408]" size={24} />
        <div>
          <h1 className="text-xl font-semibold text-[#2D1B0E]">Receiving Variance</h1>
          <p className="text-xs text-[#8B7355]">
            PO ordered vs GRN received vs QC accepted — spot vendor short-supply, over-supply &amp; quality issues.
            {' '}Quantity &amp; QC variance only; a line received in full at an off-PO <em>rate</em> is not listed here — those are logged on{' '}
            <a href="/audit" className="text-[#af4408] hover:underline">/audit</a>.
          </p>
        </div>
      </div>

      {/* ── Filters ─────────────────────────────────────────────────────── */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 space-y-3">
        {/* Row 1 — quick date presets */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-[#8B7355] mr-1">Quick range</span>
          {DATE_PRESETS.map(p => {
            const on = activePreset?.key === p.key;
            return (
              <button
                key={p.key}
                type="button"
                aria-pressed={on}
                onClick={() => { const [f, t] = p.range(); setFrom(f); setTo(t); }}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                  on ? 'bg-[#af4408] text-white' : 'text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] hover:bg-[#FFF1E3]'
                }`}
              >
                {p.label}
              </button>
            );
          })}
        </div>

        {/* Row 2 — the filters themselves */}
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-[#6B5744] flex flex-col gap-1">
            From
            <input type="date" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} className="px-2 py-1.5 border border-[#D4B896] rounded text-sm" />
          </label>
          <label className="text-xs text-[#6B5744] flex flex-col gap-1">
            To
            <input type="date" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} className="px-2 py-1.5 border border-[#D4B896] rounded text-sm" />
          </label>
          <label className="text-xs text-[#6B5744] flex flex-col gap-1 min-w-0 max-w-full">
            Vendor
            <select value={vendor} onChange={e => setVendor(e.target.value)} className="px-2 py-1.5 border border-[#D4B896] rounded text-sm w-full max-w-full min-w-0 sm:w-auto sm:min-w-[200px]">
              <option value="">All vendors</option>
              {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </label>
          <label className="text-xs text-[#6B5744] flex flex-col gap-1">
            Variance type
            <select value={vtype} onChange={e => setVtype(e.target.value as VType)} className="px-2 py-1.5 border border-[#D4B896] rounded text-sm">
              {(Object.keys(VTYPE_LABEL) as VType[]).map(k => <option key={k} value={k}>{VTYPE_LABEL[k]}</option>)}
            </select>
          </label>
          <label className="text-xs text-[#6B5744] flex flex-col gap-1">
            Reject reason
            <select
              value={reason}
              onChange={e => setReason(e.target.value)}
              disabled={reasonSelectOptions.length === 0}
              className="px-2 py-1.5 border border-[#D4B896] rounded text-sm capitalize disabled:bg-[#F5EDE2] disabled:text-[#B8A590]"
            >
              <option value="">{reasonOptions.length ? 'Any reason' : 'No rejections in range'}</option>
              {reasonSelectOptions.map(k => (
                <option key={k} value={k}>
                  {prettyReason(k)}{k === reason && orphanReason ? ' — none in this range' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-[#6B5744] flex flex-col gap-1 flex-1 min-w-[220px]">
            Search
            <span className="flex items-center gap-1.5 px-2 py-1 border border-[#D4B896] rounded bg-[#FFF8F0]">
              <Search className="w-3.5 h-3.5 text-[#8B7355] shrink-0" />
              <input
                value={q}
                onChange={e => setQ(e.target.value)}
                placeholder="Material, item code, PO / GRN no. or vendor…"
                aria-label="Search material, item code, PO number, GRN number or vendor"
                className="flex-1 min-w-0 bg-transparent text-sm outline-none py-0.5"
              />
              {q && (
                <button type="button" onClick={() => setQ('')} aria-label="Clear search" className="text-[#8B7355] hover:text-[#af4408] shrink-0">
                  <X size={13} />
                </button>
              )}
            </span>
          </label>
        </div>

        {/* Row 3 — active-filter summary + row count + one-click clear */}
        <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-[#E8D5C4]/70">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wide text-[#8B7355]">Filters</span>
            {!anyFilter && <span className="text-[11px] text-[#8B7355]">Default view — last 30 days, all vendors</span>}
            {!isDefaultRange && (
              <FilterChip
                label={activePreset ? activePreset.label : `${from || '…'} → ${to || '…'}`}
                onClear={() => { setFrom(DEFAULT_FROM()); setTo(DEFAULT_TO()); }}
              />
            )}
            {vendor  && <FilterChip label={`Vendor: ${vendorName}`}       onClear={() => setVendor('')} />}
            {vtype !== 'all' && <FilterChip label={VTYPE_LABEL[vtype]}     onClear={() => setVtype('all')} />}
            {reason  && <FilterChip label={`Reason: ${prettyReason(reason)}`} onClear={() => setReason('')} />}
            {q.trim() && <FilterChip label={`“${q.trim()}”`}               onClear={() => setQ('')} />}
            {anyFilter && (
              <button
                type="button"
                onClick={clearAll}
                className="text-[11px] px-2 py-0.5 rounded-full border border-[#D4B896] text-[#af4408] hover:bg-[#FFF1E3] font-medium"
              >
                Clear all
              </button>
            )}
          </div>
          {/* Row count — states BOTH numbers so an empty table reads as a
              filter, never as a broken report. */}
          <div className="ml-auto text-xs text-[#6B5744]">
            {loading ? (
              <Loader2 className="animate-spin" size={16} />
            ) : error ? '—' : clientFiltered ? (
              <>Showing <b className="text-[#2D1B0E]">{filtered.length}</b> of {allRows.length} variance {allRows.length === 1 ? 'line' : 'lines'} in range</>
            ) : (
              <><b className="text-[#2D1B0E]">{allRows.length}</b> variance {allRows.length === 1 ? 'line' : 'lines'} in range</>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700 flex flex-wrap items-center justify-between gap-3">
          <span>{error}</span>
          <button onClick={reload} className="px-3 py-1 rounded border border-red-300 text-red-700 hover:bg-red-100 text-xs">Retry</button>
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4">
          <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">Lines flagged</div>
          <div className="text-2xl font-semibold text-[#2D1B0E] mt-1">{cards.lines}</div>
          {clientFiltered && <div className="text-[10px] text-[#B8A590] mt-0.5">of {data?.summary?.lines ?? 0} unfiltered</div>}
        </div>
        <div className="bg-white border border-amber-200 rounded-xl p-4">
          <div className="text-[10px] uppercase tracking-wide text-amber-700 flex items-center gap-1"><TrendingDown size={11} /> Net short-supply value</div>
          <div className="text-2xl font-semibold text-amber-800 mt-1">{fmt(cards.short_value)}</div>
          {clientFiltered && <div className="text-[10px] text-[#B8A590] mt-0.5">of {fmt(data?.summary?.net_value_short || 0)} unfiltered</div>}
        </div>
        <div className="bg-white border border-blue-200 rounded-xl p-4">
          <div className="text-[10px] uppercase tracking-wide text-blue-700 flex items-center gap-1"><TrendingUp size={11} /> Net excess-supply value</div>
          <div className="text-2xl font-semibold text-blue-800 mt-1">{fmt(cards.excess_value)}</div>
          {clientFiltered && <div className="text-[10px] text-[#B8A590] mt-0.5">of {fmt(data?.summary?.net_value_excess || 0)} unfiltered</div>}
        </div>
        <div className="bg-white border border-red-200 rounded-xl p-4">
          <div className="text-[10px] uppercase tracking-wide text-red-700 flex items-center gap-1"><XCircle size={11} /> Rejected at QC</div>
          <div className="text-2xl font-semibold text-red-800 mt-1">{fmt(cards.rejected_value)}</div>
          {clientFiltered && <div className="text-[10px] text-[#B8A590] mt-0.5">of {fmt(data?.summary?.total_rejected_value || 0)} unfiltered</div>}
        </div>
      </div>

      {/* Rejection reasons — each tile is also a one-click Reject-reason filter.
          Counts are facets: they answer "what would I get if I clicked this",
          so they respect the date / vendor / text / type filters but not the
          reason filter itself. */}
      {data && Object.keys(reasonFacets).length > 0 && (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4">
          <h2 className="text-sm font-semibold text-[#2D1B0E] mb-3">
            Rejection reasons <span className="font-normal text-[11px] text-[#8B7355]">— click one to filter</span>
          </h2>
          <div className="flex flex-wrap gap-2">
            {Object.entries(reasonFacets).map(([r, s]) => (
              <button
                key={r}
                type="button"
                aria-pressed={reason === r}
                onClick={() => setReason(reason === r ? '' : r)}
                className={`text-left px-3 py-2 rounded-lg transition-shadow ${REASON_TONE[r] || 'bg-[#F5EDE2] text-[#6B5744]'} ${
                  reason === r ? 'ring-2 ring-[#af4408] ring-offset-1' : 'hover:shadow-sm'
                }`}
              >
                <div className="text-xs font-semibold capitalize">{prettyReason(r)}</div>
                <div className="text-[10px] mt-0.5">{s.count} {s.count === 1 ? 'line' : 'lines'} · {fmt(s.value)}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Vendor roll-up */}
      {vendorRoll.length > 0 && (
        <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[#E8D5C4] bg-[#FFF1E3]/50">
            <h2 className="text-sm font-semibold text-[#2D1B0E]">
              By vendor
              {clientFiltered && <span className="ml-2 font-normal text-[11px] text-[#8B7355]">(filtered lines only)</span>}
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-[#FFF8F0] text-[#8B7355]">
                <tr>
                  <th className="text-left  py-2 px-4 font-medium">Vendor</th>
                  <th className="text-right py-2 px-4 font-medium">Lines</th>
                  <th className="text-right py-2 px-4 font-medium">Short ₹</th>
                  <th className="text-right py-2 px-4 font-medium">Excess ₹</th>
                  <th className="text-right py-2 px-4 font-medium">Rejected ₹</th>
                </tr>
              </thead>
              <tbody>
                {vendorRoll.map(v => (
                  <tr key={v.vendor} className="border-t border-[#E8D5C4]/50">
                    <td className="py-1.5 px-4 font-medium text-[#2D1B0E]">{v.vendor}</td>
                    <td className="py-1.5 px-4 text-right font-mono">{v.lines}</td>
                    <td className="py-1.5 px-4 text-right font-mono text-amber-800">{v.short ? fmt(v.short) : '—'}</td>
                    <td className="py-1.5 px-4 text-right font-mono text-blue-800">{v.excess ? fmt(v.excess) : '—'}</td>
                    <td className="py-1.5 px-4 text-right font-mono text-red-700">{v.rejected ? fmt(v.rejected) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Line detail */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        <div className="px-4 py-2.5 border-b border-[#E8D5C4] bg-[#FFF1E3]/50 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-[#2D1B0E]">Line detail</h2>
          {!loading && !error && (
            <span className="text-[11px] text-[#8B7355]">
              {clientFiltered ? `${filtered.length} of ${allRows.length} shown` : `${allRows.length} shown`}
            </span>
          )}
        </div>
        {loading ? (
          <div className="p-6 text-center text-sm text-[#8B7355]"><Loader2 className="animate-spin inline mr-1" size={14} /> Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="p-6 text-center text-sm">
            {/* Three genuinely different empty states, in the order that keeps
                each claim true:
                  1. the report failed to load — claim nothing;
                  2. rows WERE loaded and the filters hid them all — say so and
                     offer the way back, so an empty table never reads as a bug;
                  3. nothing was flagged at all — and only call the receipts
                     clean when the API confirms there WERE receipts. */}
            {error ? (
              <span className="text-[#8B7355]">Report not loaded — see the message above.</span>
            ) : clientFiltered && allRows.length > 0 ? (
              <div className="space-y-2">
                <div className="text-[#6B5744]">
                  No line matches these filters. {allRows.length} variance {allRows.length === 1 ? 'line was' : 'lines were'} loaded for {from} → {to}
                  {vendor ? ` · ${vendorName}` : ''}.
                </div>
                <button onClick={clearClientFilters} className="text-xs px-3 py-1 rounded border border-[#D4B896] text-[#af4408] hover:bg-[#FFF1E3] font-medium">
                  Clear search &amp; type filters
                </button>
              </div>
            ) : data?.summary?.receipts_in_range === 0 ? (
              <span className="text-[#8B7355]">No PO-linked receipts in this range — nothing to compare.</span>
            ) : (
              <span className="text-emerald-700">✓ No variance flagged — no PO-linked receipt in this range differed from its ordered qty or had a QC rejection.</span>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-[#FFF8F0] text-[#8B7355]">
                <tr>
                  <th className="text-left  py-2 px-3 font-medium">Date</th>
                  <th className="text-left  py-2 px-3 font-medium">GRN · PO</th>
                  <th className="text-left  py-2 px-3 font-medium">Vendor</th>
                  <th className="text-left  py-2 px-3 font-medium">Material</th>
                  {/* Every quantity column below is in the material's PURCHASE unit
                      (kg / L / BTL / CASE) and each cell carries that unit — say so
                      in the header too, so the basis is stated before the numbers. */}
                  <th className="text-right py-2 px-3 font-medium" title="In the material's purchase unit — kg, L, BTL, CASE">Ordered <span className="font-normal text-[9px] text-[#B8A590]">(purchase units)</span></th>
                  <th className="text-right py-2 px-3 font-medium" title="In the material's purchase unit — kg, L, BTL, CASE">Received <span className="font-normal text-[9px] text-[#B8A590]">(purchase units)</span></th>
                  <th className="text-right py-2 px-3 font-medium" title="In the material's purchase unit — kg, L, BTL, CASE">Accepted <span className="font-normal text-[9px] text-[#B8A590]">(purchase units)</span></th>
                  <th className="text-right py-2 px-3 font-medium" title="Accepted − Ordered, in the material's purchase unit">Δ</th>
                  <th className="text-right py-2 px-3 font-medium">Δ ₹</th>
                  <th className="text-left  py-2 px-3 font-medium">Reject reason</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, idx) => {
                  // Ordered / received / accepted are PURCHASE units — a PO is raised
                  // in kg / BTL / CASE and the GRN keeps those numbers — so label them
                  // with the purchase unit. Showing the recipe unit (g, ml) read as a
                  // pack_size-sized error to anyone checking the sheet.
                  // CAVEAT: this is the material's CURRENT purchase_unit (the API joins
                  // live raw_materials); the quantities were frozen at receive time. If
                  // the unit is later changed on Unit Audit, historical rows here are
                  // relabelled. Fixing that needs a unit snapshot on the GRN line.
                  const u = r.purchase_unit || r.material_unit;
                  const dShort = r.accept_delta < 0;
                  const dExcess = r.accept_delta > 0;
                  return (
                    <tr key={r.grn_id + '-' + r.material_id + '-' + idx} className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF8F0]">
                      <td className="py-1.5 px-3 whitespace-nowrap text-[#6B5744]">{r.date}</td>
                      <td className="py-1.5 px-3 whitespace-nowrap">
                        <a href={`/grn/print/${r.grn_id}`} target="_blank" className="text-[#af4408] font-mono hover:underline">{r.grn_number}</a>
                        {r.po_number && <div className="text-[10px] font-mono text-[#8B7355]">{r.po_number}</div>}
                      </td>
                      <td className="py-1.5 px-3 text-[#6B5744]">{r.vendor}</td>
                      <td className="py-1.5 px-3">
                        <div className="font-medium text-[#2D1B0E]">{r.material_name}</div>
                        <div className="text-[10px] font-mono text-[#8B7355]">{r.material_sku || '·'}</div>
                      </td>
                      <td className="py-1.5 px-3 text-right font-mono">{r.quantity_ordered} {u}</td>
                      <td className="py-1.5 px-3 text-right font-mono">{r.quantity_received} {u}</td>
                      <td className="py-1.5 px-3 text-right font-mono">{r.quantity_accepted} {u}</td>
                      <td className={`py-1.5 px-3 text-right font-mono ${dShort ? 'text-amber-800' : dExcess ? 'text-blue-800' : 'text-[#6B5744]'}`}>
                        {r.accept_delta > 0 ? '+' : ''}{r.accept_delta} {u}
                      </td>
                      <td className={`py-1.5 px-3 text-right font-mono ${dShort ? 'text-amber-800' : dExcess ? 'text-blue-800' : 'text-[#6B5744]'}`}>
                        {/* .replace already supplies the sign — prefixing '+' too rendered '++₹1,200'. */}
                        {r.accept_delta_value ? fmt(Math.abs(r.accept_delta_value)).replace('₹', dShort ? '-₹' : '+₹') : '—'}
                      </td>
                      <td className="py-1.5 px-3">
                        {r.rejection_reason ? (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded capitalize ${REASON_TONE[r.rejection_reason] || 'bg-[#F5EDE2] text-[#6B5744]'}`}>
                            {prettyReason(r.rejection_reason)} · {r.quantity_rejected} {u}
                          </span>
                        ) : <span className="text-[#8B7355]">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
