'use client';

/**
 * REQUESTED → ORDERED → RECEIVED (/reports/requested-vs-received)
 * Management + store manager (the API refuses everyone else).
 *
 * The owner's model is his "October 2026 kitchen requests and receipts" sheet:
 * one row per item and unit, requested vs received, with ₹. He asked for it for
 * any date range or month, and picked (2026-11-09): Requested → Ordered →
 * Received with the short / extra at each step, matched BY ITEM with a
 * drill-down to the documents, a department picker (default Kitchen with its
 * sections), and an Excel download.
 *
 * Every figure comes from GET /api/reports/requested-vs-received, built in
 * src/lib/req-recon.ts. This page converts nothing and adds no quantities
 * across items: each row's quantities are already in that item's PURCHASE unit,
 * and the only totals here are rupees. The rule sentences are imported from
 * src/lib/req-recon-types.ts, the same text the Excel file prints.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { todayIST } from '@/lib/format-date';
import { fitFigureStyle } from '@/lib/fit-figure';
import {
  RATE_BASIS_WORDS, RATE_BASIS_WORDS_MID, RULE_REQUESTED, RULE_ORDERED, RULE_RECEIVED, RULE_VALUES, RULE_SHARED, NO_RATE_WORDS,
  plural, humanDate, periodWords, deptViewWords, deptOptionWords, heldCardWords,
  type ReqReconResponse, type ReqReconItem, type ReqReconDetail,
} from '@/lib/req-recon-types';
import {
  ClipboardList, ShoppingCart, PackageCheck, Hourglass, Download, Loader2, Info, AlertTriangle,
  Search, X, CheckCircle2, Users,
} from 'lucide-react';

/* ═══════════════════════════════ formatting ═══════════════════════════════ */

const fmtINR = (n: number) => {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const body = '₹' + Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `−${body}` : body;
};
const fmtSignedINR = (n: number) => {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return v > 0 ? `+${fmtINR(v)}` : fmtINR(v);
};
const fmtQty = (n: number) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const fmtSignedQty = (n: number) => {
  const v = Math.round((Number(n) || 0) * 1000) / 1000;
  if (v === 0) return '0';
  return v > 0 ? `+${fmtQty(v)}` : `−${fmtQty(-v)}`;
};
const fmtRate = (n: number) => '₹' + (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const EPS = 0.0005;

/** Extra (more than the step before) is highlighted for review, as on the owner's sheet; short reads in red. */
function diffClass(v: number): string {
  if (v > EPS) return 'bg-amber-50 text-amber-900 font-semibold';
  if (v < -EPS) return 'text-rose-700 font-semibold';
  return 'text-[#8B7355]';
}

/* ═══════════════════════════════ dates ════════════════════════════════════ */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function lastDayOf(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}
function monthOptions(today: string): { value: string; label: string }[] {
  const [y, m] = today.split('-').map(Number);
  const out: { value: string; label: string }[] = [];
  for (let i = 0; i < 24; i++) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    const value = d.toISOString().slice(0, 7);
    out.push({ value, label: `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}${i === 0 ? ' (to date)' : ''}` });
  }
  return out;
}
/** A picked month's window: the whole month, or 1st → today for the current one. */
function monthWindow(ym: string, today: string): { from: string; to: string } {
  const from = `${ym}-01`;
  const end = lastDayOf(ym);
  return { from, to: end > today ? today : end };
}

/* ═══════════════════════════════ the page ═════════════════════════════════ */

type ItemFilter = 'all' | 'diff' | 'shared';
type SortKey = 'name' | 'rec_ord' | 'ord_req';

export default function RequestedVsReceivedPage() {
  const today = todayIST();
  const months = useMemo(() => monthOptions(today), [today]);
  const thisMonth = today.slice(0, 7);
  const [month, setMonth] = useState<string>(thisMonth);
  const [from, setFrom] = useState(`${thisMonth}-01`);
  const [to, setTo] = useState(today);
  /** '' until the first answer names the default department (Kitchen); then an id or 'all'. */
  const [dept, setDept] = useState('');

  const [data, setData] = useState<ReqReconResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);

  const [q, setQ] = useState('');
  const [itemFilter, setItemFilter] = useState<ItemFilter>('all');
  const [sort, setSort] = useState<SortKey>('name');
  const [openItem, setOpenItem] = useState<ReqReconItem | null>(null);

  const seq = useRef(0);
  /** Set when the first answer tells us the default department: adopting it must not fetch the same report again. */
  const adopted = useRef(false);
  const query = useCallback((extra: Record<string, string> = {}) => {
    const p = new URLSearchParams({ from, to, ...extra });
    if (dept) p.set('dept', dept);
    return p.toString();
  }, [from, to, dept]);

  const load = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true); setError('');
    try {
      const res = await fetch(`/api/reports/requested-vs-received?${query()}`, { cache: 'no-store' });
      const j = await res.json().catch(() => ({} as { error?: string }));
      if (my !== seq.current) return;
      if (!res.ok) {
        setError((j as { error?: string })?.error || `Could not load the report (HTTP ${res.status}).`);
        setData(null);
        return;
      }
      const body = j as ReqReconResponse;
      setData({ ...body, items: Array.isArray(body.items) ? body.items : [] });
      // "Also asked by others" exists only in a one-department view: the All view
      // offers no such option, so drop it there instead of filtering on it.
      if (!body.department) setItemFilter(f => (f === 'shared' ? 'all' : f));
      if (!dept) { adopted.current = true; setDept(body.department ? body.department.id : 'all'); }
    } catch {
      if (my === seq.current) { setError('Network error — please try again.'); setData(null); }
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [query, dept]);

  useEffect(() => {
    if (adopted.current) { adopted.current = false; return; }
    load();
  }, [load]);

  const pickMonth = (ym: string) => {
    setMonth(ym);
    if (ym === 'custom') return;
    const w = monthWindow(ym, today);
    setFrom(w.from); setTo(w.to);
  };
  const setDates = (f: string, t: string) => {
    setFrom(f); setTo(t);
    const match = months.find(m => { const w = monthWindow(m.value, today); return w.from === f && w.to === t; });
    setMonth(match ? match.value : 'custom');
  };

  const download = async () => {
    setDownloading(true); setError('');
    try {
      const res = await fetch(`/api/reports/requested-vs-received?${query({ format: 'xlsx' })}`, { cache: 'no-store' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as { error?: string }));
        setError(j?.error || `Download failed (HTTP ${res.status}).`);
        return;
      }
      const cd = res.headers.get('Content-Disposition') || '';
      const name = /filename="([^"]+)"/.exec(cd)?.[1] || `requested-vs-received_${from}_${to}.xlsx`;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; a.click();
      URL.revokeObjectURL(url);
    } catch { setError('Network error — download failed.'); }
    finally { setDownloading(false); }
  };

  const items = useMemo(() => data?.items || [], [data]);
  const showHeld = items.some(i => i.held_qty > 0);
  /** The filter in force: 'shared' never applies (nor shows) without a department. */
  const effFilter: ItemFilter = !data?.department && itemFilter === 'shared' ? 'all' : itemFilter;
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = items.filter(i => !needle
      || i.item.toLowerCase().includes(needle) || i.sku.toLowerCase().includes(needle) || i.category.toLowerCase().includes(needle));
    if (effFilter === 'diff') {
      list = list.filter(i => Math.abs(i.ordered_minus_requested) > EPS || Math.abs(i.received_minus_ordered) > EPS || i.held_qty > 0);
    } else if (effFilter === 'shared') list = list.filter(i => i.others.length > 0);
    if (sort === 'rec_ord') {
      list = [...list].sort((a, b) => Math.abs(b.received_value - b.ordered_value) - Math.abs(a.received_value - a.ordered_value));
    } else if (sort === 'ord_req') {
      const d = (i: ReqReconItem) => (i.requested_value == null ? -1 : Math.abs(i.ordered_value - i.requested_value));
      list = [...list].sort((a, b) => d(b) - d(a));
    }
    return list;
  }, [items, q, effFilter, sort]);
  const shownTotals = useMemo(() => shown.reduce((t, i) => ({
    req: t.req + (i.requested_value ?? 0), ord: t.ord + i.ordered_value, rec: t.rec + i.received_value, held: t.held + i.held_value,
  }), { req: 0, ord: 0, rec: 0, held: 0 }), [shown]);
  /**
   * ₹ Ordered and ₹ Received keep a genuine fraction of a paisa (₹ Received must
   * equal the Purchase Report's own SUM), so the rows AS PRINTED — each rounded
   * to the paisa by fmtINR — can add up to a paisa or two more or less than
   * the total printed under them. This is that printed sum, in paise, so the
   * footer can say so whenever, and only when, it happens. (₹ Requested is
   * rounded per item on the server, so its rows always add up.)
   */
  const shownRowPaise = useMemo(() => shown.reduce((t, i) => ({
    ord: t.ord + Math.round((Number(i.ordered_value) || 0) * 100), rec: t.rec + Math.round((Number(i.received_value) || 0) * 100),
  }), { ord: 0, rec: 0 }), [shown]);
  const ordDrift = shownRowPaise.ord !== Math.round(shownTotals.ord * 100);
  const recDrift = shownRowPaise.rec !== Math.round(shownTotals.rec * 100);

  const deptName = data ? (data.department ? data.department.name : 'All departments') : '';
  // "(with its sections)" only for a department that has sections — the same words as the Excel Summary.
  const viewWords = data ? deptViewWords(data.department) : '';
  const t = data?.totals;
  const c = data?.counts;
  const filtered = shown.length !== items.length;

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E] overflow-x-hidden">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 py-5 sm:py-6 space-y-5">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">Reports</p>
            <h1 className="text-2xl sm:text-3xl font-bold mt-0.5 flex items-center gap-2">
              <ClipboardList className="w-6 h-6 text-[#af4408] shrink-0" /> Requested → Ordered → Received
            </h1>
            <p className="text-xs text-[#8B7355] mt-1">
              What a department asked for, what was ordered, and what came in — item by item, with ₹ at each step.
            </p>
          </div>
          <Link href="/reports/purchases" className="text-sm font-medium text-[#af4408] hover:underline shrink-0">Purchase Report →</Link>
        </div>

        {/* Filters */}
        <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm p-4">
          <div className="grid grid-cols-2 sm:flex sm:flex-wrap sm:items-end gap-3">
            <label className="block col-span-2 sm:col-span-1 sm:min-w-[190px]"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">Month</span>
              <select value={month} onChange={e => pickMonth(e.target.value)}
                className="mt-1 block w-full px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408]">
                {months.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                <option value="custom">Custom dates</option>
              </select></label>
            <label className="block min-w-0"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">From</span>
              <input type="date" value={from} max={to} onChange={e => e.target.value && setDates(e.target.value, to)}
                className="mt-1 block w-full px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408]" /></label>
            <label className="block min-w-0"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">To</span>
              <input type="date" value={to} min={from} onChange={e => e.target.value && setDates(from, e.target.value)}
                className="mt-1 block w-full px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408]" /></label>
            <label className="block col-span-2 sm:col-span-1 sm:min-w-[200px]"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">Department</span>
              <select value={dept} onChange={e => setDept(e.target.value)} disabled={!data && !dept}
                className="mt-1 block w-full px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408] disabled:opacity-60">
                {!dept && <option value="">{loading ? 'Loading…' : '—'}</option>}
                {(data?.departments || []).map(d => (
                  <option key={d.id} value={d.id}>{deptOptionWords(d)}</option>
                ))}
                <option value="all">All departments</option>
              </select></label>
            <button onClick={download} disabled={downloading || !data}
              className="col-span-2 sm:col-span-1 inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-60 text-white">
              {downloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />} Download Excel
            </button>
          </div>
          {data && (
            <p className="text-xs text-[#6B5744] mt-3">
              Showing <strong>{viewWords}</strong>, {periodWords(data.from, data.to)}.
              {loading && <span className="inline-flex items-center gap-1 ml-2 text-[#8B7355]"><Loader2 className="w-3 h-3 animate-spin" />Updating…</span>}
            </p>
          )}
        </div>

        {error && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800 flex gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /><span>{error}</span>
          </div>
        )}
        {loading && !data && !error && (
          <div className="flex items-center gap-2 text-sm text-[#8B7355]"><Loader2 className="w-4 h-4 animate-spin" />Loading the report…</div>
        )}

        {data && t && c && (
          <>
            {/* ₹ at each step — rupees only; quantities never add up across items. */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <Card icon={<ClipboardList className="w-4 h-4" />} label="₹ Requested (estimate)" value={fmtINR(t.requested_value)}
                sub={<>{plural(c.request_lines, 'request line', 'request lines')} · {plural(c.requisitions, 'requisition', 'requisitions')}{t.items_without_rate > 0 ? <> · {plural(t.items_without_rate, 'item', 'items')} with no rate not included</> : null}</>} />
              <Card icon={<ShoppingCart className="w-4 h-4" />} label="₹ Ordered" value={fmtINR(t.ordered_value)}
                sub={<>{plural(c.po_lines, 'PO line', 'PO lines')} · {plural(c.purchase_orders, 'purchase order', 'purchase orders')}</>} />
              <Card icon={<PackageCheck className="w-4 h-4" />} label="₹ Received (booked into stock)" value={fmtINR(t.received_value)} tone="accent"
                sub={plural(c.receipt_lines, 'purchase entry', 'purchase entries')} />
              <Card icon={<Hourglass className="w-4 h-4" />} label="₹ Held for QC (not booked yet)" value={fmtINR(t.held_value)}
                tone={t.held_value > 0 ? 'warn' : undefined}
                sub={heldCardWords(c.held_lines, !!data.department)} />
            </div>

            <div className="bg-white border border-[#E8D5C4] rounded-xl px-4 py-3 text-sm space-y-1.5">
              <p className="flex flex-wrap gap-x-5 gap-y-1">
                {/* whitespace-nowrap: at 320 px the sign broke onto its own line, away from its amount. */}
                <span>Ordered − Requested: <strong className="tabular-nums whitespace-nowrap">{fmtSignedINR(t.ordered_value - t.requested_value)}</strong> <span className="text-[11px] text-[#8B7355]">(against the estimate)</span></span>
                <span>Received − Ordered: <strong className="tabular-nums whitespace-nowrap">{fmtSignedINR(t.received_value - t.ordered_value)}</strong></span>
              </p>
              {data.matches_purchase_report === true && (
                <p className="text-xs text-emerald-800 flex items-start gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-[1px]" />
                  <span>₹ Received matches the Purchase Report for these dates to the paisa ({fmtINR(data.purchase_report_booked)} booked into stock).</span></p>
              )}
              {data.matches_purchase_report === false && (
                <p className="text-xs text-rose-700 font-semibold flex items-start gap-1.5"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-[1px]" />
                  <span>₹ Received ({fmtINR(t.received_value)}) does NOT match the Purchase Report ({fmtINR(data.purchase_report_booked)}) for these dates. Please report this.</span></p>
              )}
              {data.department && c.items > 0 && (
                <p className="text-xs text-[#6B5744] flex items-start gap-1.5"><Info className="w-3.5 h-3.5 shrink-0 mt-[1px] text-[#8B7355]" />
                  <span>
                    The Purchase Report books {fmtINR(data.purchase_report_booked)} into stock for these dates across all items;
                    {' '}{fmtINR(t.received_value)} of it is for the {plural(c.items, 'item', 'items')} {deptName} asked for.
                    Ordered and Received are whole-outlet figures for each item.
                    {c.shared_items > 0 && <> {plural(c.shared_items, 'item was', 'items were')} also asked for by another department — marked <SharedTag />.</>}
                  </span></p>
              )}
              {(c.unconverted_lines > 0 || c.unit_assumed_lines > 0 || c.closed_lines > 0) && (
                <p className="text-xs text-[#6B5744] flex items-start gap-1.5"><Info className="w-3.5 h-3.5 shrink-0 mt-[1px] text-[#8B7355]" />
                  <span>
                    {c.unconverted_lines > 0 && <>{plural(c.unconverted_lines, 'request line is', 'request lines are')} in a unit that cannot be converted to the item’s purchase unit and {c.unconverted_lines === 1 ? 'is' : 'are'} left out of Requested. </>}
                    {c.unit_assumed_lines > 0 && <>{plural(c.unit_assumed_lines, 'request line has', 'request lines have')} no unit recorded and {c.unit_assumed_lines === 1 ? 'is' : 'are'} read in the item’s purchase unit. </>}
                    {c.closed_lines > 0 && <>{plural(c.closed_lines, 'PO line’s vendor was', 'PO lines’ vendors were')} closed on the order before anything arrived, so {c.closed_lines === 1 ? 'that line is' : 'those lines are'} not in Ordered. </>}
                    Open an item to see which.
                  </span></p>
              )}
            </div>

            <details className="bg-white border border-[#E8D5C4] rounded-xl px-4 py-3 text-xs text-[#6B5744] group">
              <summary className="cursor-pointer font-semibold text-[#2D1B0E] text-sm">How this report counts</summary>
              <ul className="mt-2 space-y-1.5 list-disc pl-4">
                {[RULE_REQUESTED, RULE_ORDERED, RULE_RECEIVED, RULE_VALUES, RULE_SHARED].map(r => <li key={r}>{r}</li>)}
                <li>Quantities are never added across items (2 kg + 3 bottles is not 5 of anything), so every total is in ₹.</li>
              </ul>
            </details>

            {/* Items */}
            <div className="bg-white border border-[#E8D5C4] rounded-xl shadow-sm p-3 sm:p-4 min-w-0">
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-2 mb-3">
                <h2 className="text-sm font-bold">
                  Items <span className="text-[11px] text-[#8B7355] font-normal">
                    ({filtered ? `${shown.length.toLocaleString('en-IN')} of ${plural(items.length, 'item', 'items')}` : plural(items.length, 'item', 'items')}){items.length > 0 ? ' · tap an item to see its documents' : ''}
                  </span>
                </h2>
                <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-2">
                  <label className="col-span-2 sm:col-span-1 relative block">
                    <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#B8A590]" />
                    <input value={q} onChange={e => setQ(e.target.value)} placeholder="Find an item…" aria-label="Find an item"
                      className="w-full sm:w-52 pl-8 pr-3 py-1.5 rounded-lg border border-[#E0D0BE] bg-white text-xs outline-none focus:border-[#af4408]" />
                  </label>
                  <select value={effFilter} onChange={e => setItemFilter(e.target.value as ItemFilter)} aria-label="Which items"
                    className="min-w-0 px-2 py-1.5 rounded-lg border border-[#E0D0BE] bg-white text-xs outline-none focus:border-[#af4408]">
                    <option value="all">All items</option>
                    <option value="diff">Short, extra or held only</option>
                    {data.department && <option value="shared">Also asked by others</option>}
                  </select>
                  <select value={sort} onChange={e => setSort(e.target.value as SortKey)} aria-label="Sort"
                    className="min-w-0 px-2 py-1.5 rounded-lg border border-[#E0D0BE] bg-white text-xs outline-none focus:border-[#af4408]">
                    <option value="name">Sort: Item A–Z</option>
                    <option value="rec_ord">Sort: ₹ Received vs Ordered</option>
                    <option value="ord_req">Sort: ₹ Ordered vs Requested</option>
                  </select>
                </div>
              </div>

              {items.length === 0 ? (
                <p className="py-8 text-center text-sm text-[#8B7355]">
                  {data.department
                    ? `No requests from ${deptName} dated ${periodWords(data.from, data.to)}.`
                    : `No requests, orders or receipts dated ${periodWords(data.from, data.to)}.`}
                </p>
              ) : (
                <div className="overflow-x-auto -mx-3 sm:mx-0 border-y sm:border sm:rounded-lg border-[#F0E4D6]">
                  <table className="min-w-full text-xs">
                    <thead className="bg-[#FFF8F0]">
                      <tr className="text-left text-[10px] uppercase text-[#8B7355] border-b border-[#F0E4D6]">
                        <th className="py-2 pl-3 pr-2 min-w-[140px]">Item</th>
                        <th className="py-2 px-1.5">Unit</th>
                        <th className="py-2 px-1.5 text-right">Requested</th>
                        <th className="py-2 px-1.5 text-right">Ordered</th>
                        <th className="py-2 px-1.5 text-right" title="Ordered − Requested. + = ordered more than asked; − = ordered less.">Ordered − Req.</th>
                        <th className="py-2 px-1.5 text-right">Received</th>
                        <th className="py-2 px-1.5 text-right" title="Received − Ordered. + = more came in than was ordered; − = less.">Received − Ord.</th>
                        {showHeld && <th className="py-2 px-1.5 text-right" title="Delivered, waiting for the kitchen’s quality check — not in Received yet">Held for QC</th>}
                        <th className="py-2 px-1.5 text-right" title="₹ per purchase unit used for the estimate — hover a rate to see where it came from">Rate</th>
                        <th className="py-2 px-1.5 text-right">₹ Requested (est.)</th>
                        <th className="py-2 px-1.5 text-right">₹ Ordered</th>
                        <th className="py-2 pl-2 pr-3 text-right">₹ Received</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.length === 0 ? (
                        <tr><td colSpan={showHeld ? 12 : 11} className="py-6 text-center text-[#8B7355]">No items match.</td></tr>
                      ) : shown.map(i => (
                        <tr key={i.material_id} tabIndex={0} role="button" aria-label={`Show the documents for ${i.item}`}
                          onClick={() => setOpenItem(i)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenItem(i); } }}
                          className="border-b border-[#F6EDE3] hover:bg-[#FFF6EE] focus:bg-[#FFF6EE] outline-none cursor-pointer align-top">
                          <td className="py-2 pl-3 pr-2">
                            <p className="font-semibold text-[#2D1B0E] break-words">{i.item}</p>
                            <p className="text-[10px] text-[#8B7355] flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                              {i.sku && <span>{i.sku}</span>}{i.category && <span>{i.category}</span>}
                              {i.others.length > 0 && <SharedTag />}
                              {i.requested_unconverted > 0 && <span className="text-amber-700">a unit not converted</span>}
                              {i.requested_unit_assumed > 0 && <span className="text-amber-700">no unit — read as {i.unit || 'purchase unit'}</span>}
                              {i.closed_lines > 0 && <span className="text-amber-700">vendor closed on a PO</span>}
                            </p>
                          </td>
                          <td className="py-2 px-1.5 whitespace-nowrap">{i.unit || '—'}</td>
                          <td className="py-2 px-1.5 text-right tabular-nums whitespace-nowrap">{fmtQty(i.requested_qty)}</td>
                          <td className="py-2 px-1.5 text-right tabular-nums whitespace-nowrap">{fmtQty(i.ordered_qty)}</td>
                          <td className={`py-2 px-1.5 text-right tabular-nums whitespace-nowrap ${diffClass(i.ordered_minus_requested)}`}>{fmtSignedQty(i.ordered_minus_requested)}</td>
                          <td className="py-2 px-1.5 text-right tabular-nums whitespace-nowrap">{fmtQty(i.received_qty)}</td>
                          <td className={`py-2 px-1.5 text-right tabular-nums whitespace-nowrap ${diffClass(i.received_minus_ordered)}`}>{fmtSignedQty(i.received_minus_ordered)}</td>
                          {showHeld && <td className="py-2 px-1.5 text-right tabular-nums whitespace-nowrap">{i.held_qty > 0 ? fmtQty(i.held_qty) : '—'}</td>}
                          <td className="py-2 px-1.5 text-right tabular-nums whitespace-nowrap"
                            title={i.rate_basis ? `${RATE_BASIS_WORDS[i.rate_basis]}${i.rate_as_of ? ` (${humanDate(i.rate_as_of)})` : ''}` : 'No rate for this item'}>
                            {i.rate == null ? '—' : fmtRate(i.rate)}
                          </td>
                          <td className="py-2 px-1.5 text-right tabular-nums whitespace-nowrap">{i.requested_value == null ? '—' : fmtINR(i.requested_value)}</td>
                          <td className="py-2 px-1.5 text-right tabular-nums whitespace-nowrap">{fmtINR(i.ordered_value)}</td>
                          <td className="py-2 pl-2 pr-3 text-right tabular-nums whitespace-nowrap font-semibold">{fmtINR(i.received_value)}</td>
                        </tr>
                      ))}
                    </tbody>
                    {shown.length > 0 && (
                      <tfoot>
                        <tr className="bg-[#FFF8F0] font-semibold">
                          <td className="py-2 pl-3 pr-2" colSpan={showHeld ? 9 : 8}>
                            {filtered ? `Total of the ${plural(shown.length, 'item', 'items')} shown` : `Total, ${plural(shown.length, 'item', 'items')}`}
                            <span className="block text-[10px] font-normal text-[#8B7355]">Rupees only — quantities are in each item’s own unit and are not added up.</span>
                            {ordDrift && (
                              <span className="block text-[10px] font-normal text-[#8B7355]">
                                ₹ Ordered: the rows as shown add up to {fmtINR(shownRowPaise.ord / 100)}; the total is {fmtINR(shownTotals.ord)} because some amounts carry a fraction of a paisa and the total adds the exact amounts.
                              </span>
                            )}
                            {recDrift && (
                              <span className="block text-[10px] font-normal text-[#8B7355]">
                                ₹ Received: the rows as shown add up to {fmtINR(shownRowPaise.rec / 100)}; the total is {fmtINR(shownTotals.rec)} because some amounts carry a fraction of a paisa and the total adds the exact amounts, as the Purchase Report does.
                              </span>
                            )}
                          </td>
                          <td className="py-2 px-1.5 text-right tabular-nums whitespace-nowrap">{fmtINR(shownTotals.req)}</td>
                          <td className="py-2 px-1.5 text-right tabular-nums whitespace-nowrap">{fmtINR(shownTotals.ord)}</td>
                          <td className="py-2 pl-2 pr-3 text-right tabular-nums whitespace-nowrap">{fmtINR(shownTotals.rec)}</td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {openItem && data && (
        <ItemDetail
          item={openItem}
          url={`/api/reports/requested-vs-received?${new URLSearchParams({
            from: data.from, to: data.to, dept: data.department ? data.department.id : 'all', material_id: openItem.material_id,
          }).toString()}`}
          viewWords={viewWords}
          onClose={() => setOpenItem(null)}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════════ pieces ═══════════════════════════════════ */

function SharedTag() {
  return (
    <span className="inline-flex items-center gap-0.5 px-1.5 py-[1px] rounded-full bg-[#EAF2F8] text-[#2F5D7C] border border-[#C9DCEA] text-[10px] font-semibold whitespace-nowrap">
      <Users className="w-2.5 h-2.5" />also asked by others
    </span>
  );
}

/** A summary card; the figure is sized off the card's own width so it never spills (ruling 115 (d)). */
function Card({ icon, label, value, sub, tone }: { icon: React.ReactNode; label: string; value: string; sub?: React.ReactNode; tone?: 'accent' | 'warn' }) {
  const ring = tone === 'accent' ? 'border-[#af4408]/30 bg-[#FFF6EE]' : tone === 'warn' ? 'border-amber-200 bg-amber-50' : 'border-[#E8D5C4] bg-white';
  return (
    <div className={`@container min-w-0 rounded-xl border shadow-sm p-3.5 ${ring}`}>
      <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wide break-words"><span className="inline-block align-[-4px] mr-1.5 text-[#af4408]">{icon}</span>{label}</p>
      <p className="font-bold mt-1 text-[#2D1B0E] tabular-nums whitespace-nowrap leading-snug" style={fitFigureStyle(value)}>{value}</p>
      {sub && <p className="text-[11px] text-[#8B7355] mt-0.5 break-words">{sub}</p>}
    </div>
  );
}

function NotCounted() {
  return <span className="inline-block px-1.5 py-[1px] rounded bg-[#F4EFE9] text-[#6B5744] text-[10px] font-semibold whitespace-nowrap">not counted</span>;
}

/** The documents behind one item: its requests, purchase orders and receipts. */
function ItemDetail({ item, url, viewWords, onClose }: { item: ReqReconItem; url: string; viewWords: string; onClose: () => void }) {
  const [d, setD] = useState<ReqReconDetail | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        const j = await res.json().catch(() => ({} as { error?: string }));
        if (!live) return;
        if (!res.ok) { setErr((j as { error?: string })?.error || `Could not load the documents (HTTP ${res.status}).`); return; }
        setD(j as ReqReconDetail);
      } catch { if (live) setErr('Network error — please try again.'); }
    })();
    return () => { live = false; };
  }, [url]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const u = item.unit;
  const reqs = d?.requests || [];
  const own = reqs.filter(r => r.in_view);
  const ownCounted = own.filter(r => r.counted).length;
  const others = reqs.filter(r => !r.in_view);
  const pos = d?.purchase_orders || [];
  const posCounted = pos.filter(p => p.counted).length;
  const recs = d?.receipts || [];
  const recsCounted = recs.filter(r => r.counted).length;
  const countWords = (n: number, counted: number, one: string, many: string) =>
    n === counted ? plural(n, one, many) : `${plural(n, one, many)}, ${counted.toLocaleString('en-IN')} counted`;

  return (
    <div className="fixed inset-0 z-50 flex items-stretch sm:items-center justify-center bg-black/40 sm:p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={`Documents for ${item.item}`}
        className="bg-[#FFF8F0] w-full max-w-6xl sm:rounded-2xl shadow-xl overflow-y-auto overflow-x-hidden max-h-full"
        onClick={e => e.stopPropagation()}>
        {/* flex-nowrap: globals.css rule 9 wraps `.flex.gap-3` rows on phones, which dropped the close button under the title. */}
        <div className="sticky top-0 z-10 bg-white border-b border-[#E8D5C4] px-4 py-3 flex flex-nowrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base sm:text-lg font-bold break-words">{item.item}</h2>
            <p className="text-[11px] text-[#8B7355]">{[item.sku, item.category, u && `in ${u}`].filter(Boolean).join(' · ')} — {viewWords}, {d ? periodWords(d.from, d.to) : '…'}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="shrink-0 p-1.5 rounded-lg hover:bg-[#FFF1E3] text-[#6B5744]"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-3 sm:p-5 space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <Step label="Requested" qty={item.requested_qty} unit={u} money={item.requested_value} moneyNote="estimate" />
            <Step label="Ordered" qty={item.ordered_qty} unit={u} money={item.ordered_value} diff={item.ordered_minus_requested} diffWords="vs requested" />
            <Step label="Received" qty={item.received_qty} unit={u} money={item.received_value} diff={item.received_minus_ordered} diffWords="vs ordered" />
            <Step label="Held for QC" qty={item.held_qty} unit={u} money={item.held_value} moneyNote="not booked yet" />
          </div>
          {item.rate != null && item.rate_basis && (
            <p className="text-[11px] text-[#8B7355]">
              ₹ Requested uses {fmtRate(item.rate)} per {u || 'unit'} — {RATE_BASIS_WORDS_MID[item.rate_basis]}{item.rate_as_of ? ` (${humanDate(item.rate_as_of)})` : ''}.
            </p>
          )}
          {item.requested_qty > 0 && item.rate == null && (
            <p className="text-[11px] text-amber-800">{NO_RATE_WORDS} Lines marked “not counted” below give no rate.</p>
          )}
          {item.others.length > 0 && (
            <div className="bg-[#EAF2F8] border border-[#C9DCEA] rounded-xl px-3 py-2 text-xs text-[#2F5D7C]">
              <strong>Also asked for by other departments in this period:</strong>{' '}
              {item.others.map(o => `${o.department} ${o.qty == null ? '(unit cannot be converted)' : `${fmtQty(o.qty)} ${u}`} (${plural(o.lines, 'line', 'lines')})`).join('; ')}.
              {' '}Ordered and Received are for the whole outlet, so part of them may be for these requests.
            </div>
          )}

          {err && <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">{err}</div>}
          {!d && !err && <div className="flex items-center gap-2 text-sm text-[#8B7355]"><Loader2 className="w-4 h-4 animate-spin" />Loading the documents…</div>}

          {d && (
            <>
              <Section title="Requests" count={countWords(own.length, ownCounted, 'request line', 'request lines')}
                empty="No requests in this period.">
                {own.length > 0 && <RequestTable rows={own} unit={u} />}
              </Section>
              {others.length > 0 && (
                <Section title="Other departments’ requests" count={`${plural(others.length, 'line', 'lines')} — not counted in this view`} empty="">
                  <RequestTable rows={others} unit={u} />
                </Section>
              )}
              <Section title="Purchase orders" count={countWords(pos.length, posCounted, 'PO line', 'PO lines')} empty="No purchase orders for this item in this period.">
                {pos.length > 0 && (
                  <Table heads={['Date', 'PO No', 'Vendor', `Qty (${u || 'unit'})`, 'Rate', 'Value', 'Status', 'Accepted on this line so far', 'Raised for', '']}
                    right={[3, 4, 5, 7]}>
                    {pos.map((p, k) => (
                      <tr key={k} className={`border-b border-[#F6EDE3] align-top ${p.counted ? '' : 'text-[#8B7355]'}`}>
                        <td className="py-1.5 px-2 whitespace-nowrap">{humanDate(p.date)}</td>
                        <td className="py-1.5 px-2 whitespace-nowrap font-medium">{p.po_number}</td>
                        <td className="py-1.5 px-2 min-w-[120px]">{p.vendor}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums">{fmtQty(p.qty)}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums whitespace-nowrap">{fmtRate(p.rate)}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums whitespace-nowrap">{fmtINR(p.value)}</td>
                        <td className="py-1.5 px-2 whitespace-nowrap">{p.status_label}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums">{fmtQty(p.received_on_line)}</td>
                        <td className="py-1.5 px-2 min-w-[140px]">{p.raised_for || '—'}</td>
                        <td className="py-1.5 px-2 min-w-[160px]">{!p.counted && <NotCounted />} {p.note && !p.counted ? <span className="block text-[10px]">{p.note}</span> : null}</td>
                      </tr>
                    ))}
                  </Table>
                )}
              </Section>
              <Section title="Receipts" count={countWords(recs.length, recsCounted, 'receipt line', 'receipt lines')} empty="Nothing received for this item in this period.">
                {recs.length > 0 && (
                  <Table heads={['Date', 'GRN / entry', 'Our invoice no', 'Vendor', `Qty (${u || 'unit'})`, 'Rejected', 'Rate', 'Value', 'Status']}
                    right={[4, 5, 6, 7]}>
                    {recs.map((r, k) => (
                      <tr key={k} className={`border-b border-[#F6EDE3] align-top ${r.counted ? '' : 'text-[#8B7355]'}`}>
                        <td className="py-1.5 px-2 whitespace-nowrap">{humanDate(r.date)}</td>
                        <td className="py-1.5 px-2 whitespace-nowrap font-medium">
                          {r.grn_number || 'Direct entry'}
                          {r.po_number && <span className="block text-[10px] font-normal text-[#8B7355]">PO {r.po_number}</span>}
                          {r.bill_no && <span className="block text-[10px] font-normal text-[#8B7355]">Bill {r.bill_no}</span>}
                        </td>
                        <td className="py-1.5 px-2 whitespace-nowrap">{r.invoice_id || '—'}</td>
                        <td className="py-1.5 px-2 min-w-[120px]">{r.vendor}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums">{fmtQty(r.qty)}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums">{r.rejected_qty > 0 ? fmtQty(r.rejected_qty) : '—'}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums whitespace-nowrap">{fmtRate(r.rate)}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums whitespace-nowrap">{fmtINR(r.value)}</td>
                        <td className="py-1.5 px-2 min-w-[170px]">{!r.counted && <NotCounted />} <span className={r.counted ? '' : 'block text-[10px]'}>{r.status_label}</span></td>
                      </tr>
                    ))}
                  </Table>
                )}
              </Section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function RequestTable({ rows, unit }: { rows: ReqReconDetail['requests']; unit: string }) {
  return (
    <Table heads={['Date', 'Req No', 'Department', 'Raised by', 'Asked', `In ${unit || 'purchase unit'}`, 'HOD approved', 'Status', '']} right={[4, 5, 6]}>
      {rows.map((r, k) => (
        <tr key={k} className={`border-b border-[#F6EDE3] align-top ${r.counted ? '' : 'text-[#8B7355]'}`}>
          <td className="py-1.5 px-2 whitespace-nowrap">{humanDate(r.date)}</td>
          <td className="py-1.5 px-2 whitespace-nowrap font-medium">{r.req_number}{r.party && <span className="block text-[10px] font-normal text-[#8B7355]">Party</span>}</td>
          <td className="py-1.5 px-2 min-w-[120px]">{r.main_department === r.department ? r.department : <>{r.main_department} › {r.department}</>}</td>
          <td className="py-1.5 px-2 min-w-[90px]">{r.raised_by}</td>
          <td className="py-1.5 px-2 text-right tabular-nums whitespace-nowrap">{fmtQty(r.qty)} {r.line_unit || <span className="text-[10px] text-[#8B7355]">(no unit)</span>}</td>
          <td className="py-1.5 px-2 text-right tabular-nums whitespace-nowrap">{r.qty_purchase == null ? '—' : fmtQty(r.qty_purchase)}</td>
          <td className="py-1.5 px-2 text-right tabular-nums whitespace-nowrap">{r.approved_qty == null ? '—' : `${fmtQty(r.approved_qty)}${r.line_unit ? ` ${r.line_unit}` : ''}`}</td>
          <td className="py-1.5 px-2 whitespace-nowrap">{r.status_label}</td>
          <td className="py-1.5 px-2 min-w-[160px]">{!r.counted && <NotCounted />} {r.note ? <span className="block text-[10px]">{r.note}</span> : null}</td>
        </tr>
      ))}
    </Table>
  );
}

function Step({ label, qty, unit, money, moneyNote, diff, diffWords }: {
  label: string; qty: number; unit: string; money: number | null; moneyNote?: string; diff?: number; diffWords?: string;
}) {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-2.5 min-w-0">
      <p className="text-[10px] font-semibold uppercase text-[#8B7355]">{label}</p>
      <p className="font-bold tabular-nums text-sm break-words">{fmtQty(qty)} {unit}</p>
      <p className="text-[11px] tabular-nums text-[#6B5744]">{money == null ? '₹ —' : fmtINR(money)}{moneyNote ? <span className="text-[#8B7355]"> · {moneyNote}</span> : null}</p>
      {diff != null && <p className={`text-[11px] tabular-nums mt-0.5 inline-block px-1 rounded ${diffClass(diff)}`}>{fmtSignedQty(diff)} {unit} {diffWords}</p>}
    </div>
  );
}

function Section({ title, count, empty, children }: { title: string; count: string; empty: string; children: React.ReactNode }) {
  const hasRows = !!children;
  return (
    <section className="bg-white border border-[#E8D5C4] rounded-xl p-3 min-w-0">
      <h3 className="text-sm font-bold mb-2">{title} <span className="text-[11px] font-normal text-[#8B7355]">({count})</span></h3>
      {hasRows ? children : <p className="text-xs text-[#8B7355]">{empty}</p>}
    </section>
  );
}

function Table({ heads, right, children }: { heads: string[]; right: number[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto max-w-full">
      <table className="min-w-full text-xs">
        <thead>
          <tr className="text-left text-[10px] uppercase text-[#8B7355] border-b border-[#F0E4D6]">
            {heads.map((h, k) => <th key={k} className={`py-1.5 px-2 whitespace-nowrap ${right.includes(k) ? 'text-right' : ''}`}>{h}</th>)}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
