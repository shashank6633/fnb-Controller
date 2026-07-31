'use client';

/**
 * PETTY CASH — the store cash box (owner requirement 5).
 *
 * "Need petty cash system for store: how much in hand is there and how much is
 *  used for cash purchases or delivery amount. Need to maintain a clear purchase
 *  credit and debit logs in the Purchasing sub page."
 *
 * CASH IN HAND is the headline; the debit/credit log sits under it with a
 * running balance on every row. Nothing on this page is stored — every figure is
 * Σ(in) − Σ(out) from petty_cash_ledger, computed server-side in
 * src/lib/petty-cash.ts, so the headline and the log can never disagree.
 *
 * THREE THINGS THIS PAGE REFUSES TO DO:
 *   1. Show a running balance computed over a FILTERED set of rows. The running
 *      balance column is always the true cash box, whatever the filter.
 *   2. Print a period summary that does not add up. opened + in − out = closing
 *      is asserted server-side; if it ever fails, the page prints the reason
 *      instead of the numbers.
 *   3. Record a payment the box cannot fund. The API refuses it and this page
 *      shows the refusal verbatim — physical cash cannot be negative.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Banknote, ArrowDownCircle, ArrowUpCircle, Download, Loader2, AlertTriangle,
  Plus, X, ShieldAlert, Info, RefreshCw,
} from 'lucide-react';
import { api } from '@/lib/api';

// ── types mirroring /api/petty-cash ─────────────────────────────────────────
interface CategoryDef {
  key: string;
  label: string;
  allows: ('in' | 'out')[];
  help: string;
  managementOnly?: boolean;
}
interface Row {
  id: string;
  date: string;
  direction: string;
  amount: number;
  category: string;
  category_label: string;
  vendor: string;
  reference: string;
  notes: string;
  recorded_by: string;
  created_at: string;
  purchase_id: string | null;
  signed: number;
  running_balance: number;
  anomaly: string | null;
}
interface Summary {
  from: string; to: string;
  opening: number; total_in: number; total_out: number; closing: number;
  reconciles: boolean; reconcile_note: string;
  rows_in_period: number; excluded_rows: number; excluded_notes: string[];
}
interface Filtered {
  category: string; category_label: string; rows: number;
  total_in: number; total_out: number; net: number;
}
interface Payload {
  outlet: { id: string; name: string } | null;
  today: string;
  cash_in_hand: number;
  can_record: boolean;
  can_adjust: boolean;
  range: { from: string; to: string };
  category: string;
  categories: CategoryDef[];
  summary: Summary;
  filtered: Filtered | null;
  rows: Row[];
  warnings: string[];
}

const rs = (v: number) =>
  (v < 0 ? '−₹' : '₹') +
  Math.abs(Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const minusDays = (iso: string, n: number) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const monthStart = (iso: string) => iso.slice(0, 8) + '01';

export default function PettyCashPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Filters. Seeded from the server's own defaults on first load so the client
  // never has to guess "today" in IST.
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [category, setCategory] = useState('');
  const [ready, setReady] = useState(false);

  // Record form
  const [formOpen, setFormOpen] = useState(false);
  const [fDate, setFDate] = useState('');
  const [fCategory, setFCategory] = useState('cash_purchase');
  const [fDirection, setFDirection] = useState<'in' | 'out'>('out');
  const [fAmount, setFAmount] = useState('');
  const [fVendor, setFVendor] = useState('');
  const [fReference, setFReference] = useState('');
  const [fNotes, setFNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [formOk, setFormOk] = useState('');
  /** Set when the API returns 409 duplicate — the next submit confirms it. */
  const [confirmDup, setConfirmDup] = useState(false);

  const [vendors, setVendors] = useState<string[]>([]);
  const reqSeq = useRef(0);
  /** from|to|category of the last successful load — stops the filter effect from
   *  re-fetching the range the server just handed back on the first load. */
  const lastKey = useRef('');
  /** The form's date is seeded from the server's IST "today" exactly once, so a
   *  reload after recording never clobbers a date the user deliberately chose. */
  const dateSeeded = useRef(false);

  const load = useCallback(async (f: string, t: string, c: string) => {
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (f) qs.set('from', f);
      if (t) qs.set('to', t);
      if (c) qs.set('category', c);
      const res = await fetch(`/api/petty-cash?${qs}`, { credentials: 'same-origin' });
      const d = await res.json().catch(() => null);
      if (seq !== reqSeq.current) return;              // superseded by a newer filter
      if (res.ok && d && d.summary && Array.isArray(d.rows)) {
        setData(d);
        setError('');
        // Adopt the server's resolved range so the inputs show what was actually
        // queried (it fills the defaults and swaps a reversed range).
        lastKey.current = `${d.range.from}|${d.range.to}|${d.category || ''}`;
        setFrom(d.range.from); setTo(d.range.to);
        if (!dateSeeded.current) { dateSeeded.current = true; setFDate(d.today); }
        setReady(true);
      } else {
        setData(null);
        setError((d && d.error) || `Could not load the petty cash book (HTTP ${res.status}).`);
        setReady(true);
      }
    } catch (e) {
      if (seq !== reqSeq.current) return;
      setData(null);
      setError((e instanceof Error && e.message) || 'Could not reach the server.');
      setReady(true);
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, []);

  // First load with no range → server picks (last 7 days, IST).
  useEffect(() => { load('', '', ''); }, [load]);
  // Subsequent loads whenever a filter actually changes.
  useEffect(() => {
    if (!ready) return;
    if (`${from}|${to}|${category}` === lastKey.current) return;
    load(from, to, category);
  }, [ready, from, to, category, load]);

  useEffect(() => {
    fetch('/api/vendors', { credentials: 'same-origin' })
      .then(r => r.json())
      .then(d => setVendors(((d?.vendors || []) as { name?: string }[]).map(v => v?.name).filter((n): n is string => !!n)))
      .catch(() => {});
  }, []);

  // Memoised so it is a stable reference — `data?.categories || []` would be a
  // brand-new array every render and re-run every hook that depends on it.
  const cats = useMemo<CategoryDef[]>(() => data?.categories || [], [data]);
  const activeCat = useMemo(() => cats.find(c => c.key === fCategory) || null, [cats, fCategory]);

  // A category dictates its direction (all but 'adjustment' allow exactly one),
  // so picking one snaps the direction. That is what makes "float top-up, out" —
  // a nonsense that would still balance — impossible to submit by accident.
  useEffect(() => {
    if (!activeCat) return;
    if (!activeCat.allows.includes(fDirection)) setFDirection(activeCat.allows[0]);
  }, [activeCat, fDirection]);

  const resetForm = () => {
    setFAmount(''); setFVendor(''); setFReference(''); setFNotes('');
    setFormError(''); setConfirmDup(false);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setFormError(''); setFormOk('');
    const amt = Number(fAmount);
    // Client-side mirror of the server's rules — the server is still the
    // authority (it re-checks all of this); this only saves a round trip.
    if (!fAmount.trim() || !Number.isFinite(amt)) { setFormError('Enter an amount.'); return; }
    if (amt <= 0) { setFormError('Amount must be more than zero — the In/Out choice carries the sign, never a minus.'); return; }
    if (!fCategory) { setFormError('Pick a category — an unlabelled cash movement cannot be reconciled later.'); return; }
    if (fDate > (data?.today || fDate)) { setFormError('That date is in the future. Cash is recorded when it moves.'); return; }

    setSaving(true);
    try {
      const res = await api('/api/petty-cash', {
        method: 'POST',
        body: {
          date: fDate, direction: fDirection, amount: amt, category: fCategory,
          vendor: fVendor.trim(), reference: fReference.trim(), notes: fNotes.trim(),
          confirm_duplicate: confirmDup || undefined,
        },
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) {
        setFormError((d && d.error) || `Could not record the movement (HTTP ${res.status}).`);
        // 409 = looks like a double-submit. Arm the confirm so a second press
        // records it deliberately rather than by accident.
        if (res.status === 409 && d?.duplicate) setConfirmDup(true);
        return;
      }
      setFormOk(`Recorded — ${fDirection === 'in' ? 'cash in' : 'cash out'} ${rs(amt)}. Cash in hand is now ${rs(d.cash_in_hand)}.`);
      resetForm();
      await load(from, to, category);
    } catch (err) {
      setFormError((err instanceof Error && err.message) || 'Could not reach the server.');
    } finally {
      setSaving(false);
    }
  };

  const csvHref = useMemo(() => {
    const qs = new URLSearchParams({ format: 'csv' });
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    if (category) qs.set('category', category);
    return `/api/petty-cash?${qs}`;
  }, [from, to, category]);

  const s = data?.summary;
  const today = data?.today || '';

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">

        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-3">
              <Banknote className="w-8 h-8" />
              Petty Cash
            </h1>
            <p className="text-[#8B7355] text-sm mt-1">
              The store cash box — every rupee in and out, with a running balance.
              {data?.outlet?.name && <> Outlet: <span className="font-medium text-[#6B5744]">{data.outlet.name}</span>.</>}
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => load(from, to, category)}
              className="flex items-center gap-2 px-3 py-2.5 border border-[#D4B896] text-[#6B5744] hover:bg-[#FFF1E3] rounded-lg text-sm font-medium"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </button>
            <a
              href={csvHref}
              className="flex items-center gap-2 px-4 py-2.5 border border-green-600 text-green-700 hover:bg-green-50 rounded-lg text-sm font-medium"
              title="Download this period's log as CSV — opening line, every movement, running balance and the closing figure"
            >
              <Download className="w-4 h-4" /> Download CSV
            </a>
            {data?.can_record && (
              <button
                onClick={() => { setFormOpen(o => !o); setFormOk(''); }}
                className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium"
              >
                {formOpen ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                {formOpen ? 'Close' : 'Record movement'}
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700 flex flex-wrap items-center justify-between gap-3">
            <span className="flex items-center gap-2"><AlertTriangle size={16} /> {error}</span>
            <button onClick={() => load(from, to, category)} className="px-3 py-1 rounded border border-red-300 text-red-700 hover:bg-red-100 text-xs">Retry</button>
          </div>
        )}

        {/* ── CASH IN HAND — the headline ─────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className={`lg:col-span-1 rounded-2xl p-6 border shadow-sm ${
            (data?.cash_in_hand ?? 0) < 0 ? 'bg-red-50 border-red-300' : 'bg-white border-[#E8D5C4]'
          }`}>
            <div className="text-[11px] uppercase tracking-wider text-[#8B7355] font-semibold">Cash in hand</div>
            <div className={`text-4xl font-bold mt-2 tabular-nums ${
              (data?.cash_in_hand ?? 0) < 0 ? 'text-red-700' : 'text-[#2D1B0E]'
            }`}>
              {loading && !data ? <span className="text-[#B8A590] text-2xl">…</span> : rs(data?.cash_in_hand ?? 0)}
            </div>
            <div className="text-[11px] text-[#8B7355] mt-2 leading-relaxed">
              Every recorded movement, not just the dates filtered below.
              Derived live as cash in − cash out; never stored, so it cannot drift from the log.
              {today && <> As at {today}.</>}
            </div>
            {(data?.cash_in_hand ?? 0) < 0 && (
              <div className="mt-3 text-[11px] text-red-700 bg-red-100 border border-red-200 rounded-lg px-3 py-2">
                A physical cash box cannot hold negative cash. New payments are already blocked;
                this figure means rows were written directly to the database, bypassing this page.
              </div>
            )}
          </div>

          {/* Period summary — the four figures that must reconcile */}
          <div className="lg:col-span-2 bg-white border border-[#E8D5C4] rounded-2xl p-5">
            <div className="flex items-center justify-between gap-2 mb-3">
              <h2 className="text-sm font-semibold text-[#2D1B0E]">
                Period summary{s && <span className="font-normal text-[#8B7355]"> · {s.from} → {s.to}</span>}
              </h2>
              {s && (
                <span className="text-[11px] text-[#8B7355]">{s.rows_in_period} movement{s.rows_in_period === 1 ? '' : 's'}</span>
              )}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <SummaryTile label="Opened with" value={s?.opening} tone="neutral" />
              <SummaryTile label="Cash in" value={s?.total_in} tone="in" />
              <SummaryTile label="Cash out" value={s?.total_out} tone="out" />
              <SummaryTile label="Closing" value={s?.closing} tone="closing" />
            </div>
            {s && (
              s.reconciles ? (
                <div className="mt-3 text-[11px] text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg px-3 py-2 tabular-nums">
                  {rs(s.opening)} opened + {rs(s.total_in)} in − {rs(s.total_out)} out = <strong>{rs(s.closing)}</strong> closing.
                  {s.to === today && <> Because this period ends today, the closing figure is the cash in hand shown alongside.</>}
                </div>
              ) : (
                <div className="mt-3 text-xs text-red-800 bg-red-50 border border-red-300 rounded-lg px-3 py-2 flex gap-2">
                  <ShieldAlert size={16} className="shrink-0 mt-0.5" />
                  <span><strong>These figures do not reconcile.</strong> {s.reconcile_note}</span>
                </div>
              )
            )}
            {!!s?.excluded_rows && (
              <div className="mt-3 text-xs text-amber-900 bg-amber-50 border border-amber-300 rounded-lg px-3 py-2">
                <div className="font-semibold flex items-center gap-2"><AlertTriangle size={14} /> {s.excluded_rows} row{s.excluded_rows === 1 ? '' : 's'} excluded from the balance</div>
                <ul className="mt-1 list-disc list-inside space-y-0.5">
                  {s.excluded_notes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
                <div className="mt-1 text-[11px]">
                  A row that cannot be signed honestly contributes zero rather than a guessed sign.
                  Fix it in the ledger before trusting the closing figure.
                </div>
              </div>
            )}
            {data?.filtered && (
              <div className="mt-3 text-[11px] text-blue-900 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
                <Info size={12} className="inline mr-1 -mt-0.5" />
                The four figures above cover <strong>all categories</strong> in the period — that is what makes them reconcile.
                The log below is filtered to <strong>{data.filtered.category_label}</strong>:
                {' '}{data.filtered.rows} movement{data.filtered.rows === 1 ? '' : 's'},
                {' '}in {rs(data.filtered.total_in)}, out {rs(data.filtered.total_out)} (net {rs(data.filtered.net)}).
              </div>
            )}
          </div>
        </div>

        {/* ── Record a movement ────────────────────────────────────────────── */}
        {formOk && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm text-emerald-800">{formOk}</div>
        )}
        {data && !data.can_record && (
          <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl px-4 py-3 text-xs text-[#6B5744]">
            You can view the cash book but not record movements. Recording is limited to Management and the Store Manager.
          </div>
        )}
        {formOpen && data?.can_record && (
          <form onSubmit={submit} className="bg-white border border-[#E8D5C4] rounded-2xl p-5 space-y-4">
            <h2 className="text-sm font-semibold text-[#2D1B0E]">Record a cash movement</h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <label className="text-xs text-[#6B5744] flex flex-col gap-1">
                Date
                <input type="date" value={fDate} max={today || undefined} onChange={e => setFDate(e.target.value)}
                       className="px-2 py-2 border border-[#D4B896] rounded text-sm" required />
              </label>

              <label className="text-xs text-[#6B5744] flex flex-col gap-1 sm:col-span-2">
                Category <span className="text-red-600">*</span>
                <select value={fCategory} onChange={e => { setFCategory(e.target.value); setConfirmDup(false); }}
                        className="px-2 py-2 border border-[#D4B896] rounded text-sm">
                  {cats.map(c => (
                    <option key={c.key} value={c.key} disabled={!!c.managementOnly && !data.can_adjust}>
                      {c.label}{c.managementOnly && !data.can_adjust ? ' (management only)' : ''}
                    </option>
                  ))}
                </select>
              </label>

              <label className="text-xs text-[#6B5744] flex flex-col gap-1">
                Amount (₹) <span className="text-red-600">*</span>
                <input
                  type="number" step="0.01" min="0.01" inputMode="decimal"
                  value={fAmount}
                  onChange={e => { setFAmount(e.target.value); setConfirmDup(false); }}
                  placeholder="0.00"
                  className="px-2 py-2 border border-[#D4B896] rounded text-sm tabular-nums" required
                />
              </label>
            </div>

            {/* Direction. Locked by the category unless the category allows both. */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-[#6B5744]">Direction</span>
              {(['in', 'out'] as const).map(d => {
                const allowed = !activeCat || activeCat.allows.includes(d);
                const on = fDirection === d;
                return (
                  <button
                    key={d} type="button" disabled={!allowed}
                    onClick={() => setFDirection(d)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      on
                        ? d === 'in' ? 'bg-emerald-600 border-emerald-600 text-white' : 'bg-[#af4408] border-[#af4408] text-white'
                        : allowed ? 'bg-white border-[#D4B896] text-[#6B5744] hover:bg-[#FFF1E3]' : 'bg-[#F5EDE2] border-[#E8D5C4] text-[#B8A590] cursor-not-allowed'
                    }`}
                  >
                    {d === 'in' ? 'Cash IN (credit)' : 'Cash OUT (debit)'}
                  </button>
                );
              })}
              {activeCat && (
                <span className="text-[11px] text-[#8B7355]">
                  {activeCat.help}
                  {activeCat.allows.length === 1 && ' This category is always ' + (activeCat.allows[0] === 'in' ? 'cash IN.' : 'cash OUT.')}
                </span>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <label className="text-xs text-[#6B5744] flex flex-col gap-1">
                Vendor / paid to
                <input list="petty-vendors" value={fVendor} onChange={e => setFVendor(e.target.value)}
                       placeholder="e.g. TARKARI, local kirana" className="px-2 py-2 border border-[#D4B896] rounded text-sm" />
                <datalist id="petty-vendors">{vendors.map(v => <option key={v} value={v} />)}</datalist>
              </label>
              <label className="text-xs text-[#6B5744] flex flex-col gap-1">
                Reference (bill / voucher no.)
                <input value={fReference} onChange={e => { setFReference(e.target.value); setConfirmDup(false); }}
                       placeholder="Bill no. the cash box is reconciled against" className="px-2 py-2 border border-[#D4B896] rounded text-sm" />
              </label>
              <label className="text-xs text-[#6B5744] flex flex-col gap-1">
                Notes
                <input value={fNotes} onChange={e => setFNotes(e.target.value)}
                       placeholder="Optional" className="px-2 py-2 border border-[#D4B896] rounded text-sm" />
              </label>
            </div>

            {formError && (
              <div className="text-xs text-red-800 bg-red-50 border border-red-300 rounded-lg px-3 py-2 flex gap-2">
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <span>{formError}</span>
              </div>
            )}
            {confirmDup && (
              <div className="text-xs text-amber-900 bg-amber-50 border border-amber-300 rounded-lg px-3 py-2">
                Press <strong>Record</strong> again to confirm this really is a second, separate movement.
              </div>
            )}

            <div className="flex items-center gap-3">
              <button type="submit" disabled={saving}
                      className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 text-white rounded-lg text-sm font-medium">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                {confirmDup ? 'Record anyway' : 'Record'}
              </button>
              <button type="button" onClick={() => { resetForm(); setFormOpen(false); }}
                      className="px-4 py-2.5 border border-[#D4B896] text-[#6B5744] hover:bg-[#FFF1E3] rounded-lg text-sm">
                Cancel
              </button>
              <span className="text-[11px] text-[#8B7355]">
                Entries are append-only. A mistake is corrected with an Adjustment row, never by deleting history.
              </span>
            </div>
          </form>
        )}

        {/* ── Filters ──────────────────────────────────────────────────────── */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 flex flex-wrap items-end gap-3">
          <label className="text-xs text-[#6B5744] flex flex-col gap-1">
            From
            <input type="date" value={from} onChange={e => setFrom(e.target.value)}
                   className="px-2 py-1.5 border border-[#D4B896] rounded text-sm" />
          </label>
          <label className="text-xs text-[#6B5744] flex flex-col gap-1">
            To
            <input type="date" value={to} onChange={e => setTo(e.target.value)}
                   className="px-2 py-1.5 border border-[#D4B896] rounded text-sm" />
          </label>
          <label className="text-xs text-[#6B5744] flex flex-col gap-1 min-w-0">
            Category
            <select value={category} onChange={e => setCategory(e.target.value)}
                    className="px-2 py-1.5 border border-[#D4B896] rounded text-sm sm:min-w-[180px]">
              <option value="">All categories</option>
              {cats.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </label>
          <div className="flex flex-wrap gap-1.5">
            {today && ([
              ['Today', today, today],
              ['7 days', minusDays(today, 6), today],
              ['30 days', minusDays(today, 29), today],
              ['This month', monthStart(today), today],
            ] as const).map(([label, f, t]) => (
              <button key={label} onClick={() => { setFrom(f); setTo(t); }}
                      className={`px-2.5 py-1.5 rounded-lg text-[11px] border ${
                        from === f && to === t
                          ? 'bg-[#FFF1E3] border-[#D4B896] text-[#2D1B0E] font-medium'
                          : 'bg-white border-[#E8D5C4] text-[#6B5744] hover:bg-[#FFF8F0]'
                      }`}>
                {label}
              </button>
            ))}
          </div>
          <div className="ml-auto text-xs text-[#6B5744] flex items-center gap-2">
            {loading ? <Loader2 className="animate-spin" size={16} /> : `${data?.rows?.length || 0} row${(data?.rows?.length || 0) === 1 ? '' : 's'} shown`}
          </div>
        </div>

        {!!data?.warnings?.length && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 text-xs text-amber-900">
            {data.warnings.map((w, i) => <div key={i}>{w}</div>)}
          </div>
        )}

        {/* ── The log ──────────────────────────────────────────────────────── */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[#E8D5C4] bg-[#FFF1E3]/50 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-[#2D1B0E]">Debit &amp; credit log</h2>
            <span className="text-[11px] text-[#8B7355]">
              Running balance is the whole cash box, in date order — never just the filtered rows.
            </span>
          </div>

          {loading && !data ? (
            <div className="p-6 text-center text-sm text-[#8B7355]"><Loader2 className="animate-spin inline mr-1" size={14} /> Loading…</div>
          ) : (data?.rows?.length || 0) === 0 ? (
            <div className="p-6 text-center text-sm text-[#8B7355]">
              {error
                ? 'Log not loaded — see the message above.'
                : data?.category
                  ? `No ${cats.find(c => c.key === data.category)?.label || data.category} movements between ${s?.from} and ${s?.to}.`
                  : `No cash movements recorded between ${s?.from} and ${s?.to}. Opening and closing both stand at ${rs(s?.opening ?? 0)}.`}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-[#FFF8F0] text-[#8B7355]">
                  <tr>
                    <th className="text-left  py-2 px-3 font-medium whitespace-nowrap">Date</th>
                    <th className="text-left  py-2 px-3 font-medium">In / Out</th>
                    <th className="text-right py-2 px-3 font-medium">Amount</th>
                    <th className="text-left  py-2 px-3 font-medium">Category</th>
                    <th className="text-left  py-2 px-3 font-medium">Vendor / paid to</th>
                    <th className="text-left  py-2 px-3 font-medium">Reference</th>
                    <th className="text-left  py-2 px-3 font-medium">Recorded by</th>
                    <th className="text-right py-2 px-3 font-medium whitespace-nowrap">Running balance</th>
                  </tr>
                </thead>
                <tbody>
                  {/* Opening line, so the column of running balances starts from a
                      stated figure instead of appearing out of nowhere. */}
                  <tr className="bg-[#FFF8F0]/60 border-t border-[#E8D5C4]/50">
                    <td className="py-1.5 px-3 text-[#8B7355] whitespace-nowrap">{s?.from}</td>
                    <td className="py-1.5 px-3 text-[#8B7355] italic" colSpan={6}>Opening balance for this period</td>
                    <td className="py-1.5 px-3 text-right font-mono font-semibold text-[#2D1B0E]">{rs(s?.opening ?? 0)}</td>
                  </tr>
                  {data!.rows.map(r => {
                    const isIn = r.direction === 'in';
                    return (
                      <tr key={r.id} className={`border-t border-[#E8D5C4]/50 hover:bg-[#FFF8F0] ${r.anomaly ? 'bg-amber-50/60' : ''}`}>
                        <td className="py-1.5 px-3 whitespace-nowrap text-[#6B5744]">{r.date}</td>
                        <td className="py-1.5 px-3">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                            isIn ? 'bg-emerald-100 text-emerald-800' : r.direction === 'out' ? 'bg-orange-100 text-orange-800' : 'bg-red-100 text-red-800'
                          }`}>
                            {isIn ? <ArrowDownCircle size={11} /> : <ArrowUpCircle size={11} />}
                            {isIn ? 'IN' : r.direction === 'out' ? 'OUT' : r.direction || '?'}
                          </span>
                        </td>
                        {/* An anomalous row contributes NOTHING to the balance, so
                            it must not be painted with a +/− that implies it did.
                            Show the stored figure struck through instead. */}
                        <td className={`py-1.5 px-3 text-right font-mono font-semibold ${
                          r.anomaly ? 'text-[#B8A590] line-through' : isIn ? 'text-emerald-700' : 'text-[#af4408]'
                        }`}>
                          {r.anomaly
                            ? rs(Number(r.amount) || 0)
                            : (isIn ? '+' : '−') + rs(Math.abs(Number(r.amount) || 0))}
                        </td>
                        <td className="py-1.5 px-3 text-[#6B5744] whitespace-nowrap">{r.category_label}</td>
                        <td className="py-1.5 px-3 text-[#6B5744]">{r.vendor || '—'}</td>
                        <td className="py-1.5 px-3 font-mono text-[#8B7355]">{r.reference || '—'}</td>
                        <td className="py-1.5 px-3 text-[#8B7355]">
                          {r.recorded_by || '—'}
                          {r.notes && <div className="text-[10px] text-[#B8A590] max-w-[220px] truncate" title={r.notes}>{r.notes}</div>}
                          {r.anomaly && (
                            <div className="text-[10px] text-amber-800 font-medium">⚠ {r.anomaly}</div>
                          )}
                        </td>
                        <td className="py-1.5 px-3 text-right font-mono font-semibold text-[#2D1B0E] tabular-nums">
                          {rs(r.running_balance)}
                        </td>
                      </tr>
                    );
                  })}
                  <tr className="border-t-2 border-[#D4B896] bg-[#FFF1E3]/50">
                    <td className="py-2 px-3 text-[#8B7355] whitespace-nowrap">{s?.to}</td>
                    <td className="py-2 px-3 text-[#6B5744] font-semibold" colSpan={6}>
                      Closing balance for this period
                      {data?.filtered && <span className="font-normal italic"> (all categories — the rows above are filtered)</span>}
                    </td>
                    <td className="py-2 px-3 text-right font-mono font-bold text-[#2D1B0E]">{rs(s?.closing ?? 0)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>

        <p className="text-[11px] text-[#8B7355] pb-4">
          This ledger is append-only: there is no edit and no delete. Corrections are recorded as an
          Adjustment, which is itself visible, dated and attributed. Payments that the box cannot fund
          are refused at the moment of entry, so the running balance can never go below zero.
        </p>
      </div>
    </div>
  );
}

function SummaryTile({ label, value, tone }: { label: string; value?: number; tone: 'neutral' | 'in' | 'out' | 'closing' }) {
  const toneCls =
    tone === 'in' ? 'text-emerald-700' :
    tone === 'out' ? 'text-[#af4408]' :
    tone === 'closing' ? 'text-[#2D1B0E]' : 'text-[#6B5744]';
  const boxCls =
    tone === 'closing' ? 'bg-[#FFF1E3] border-[#D4B896]' : 'bg-[#FFF8F0] border-[#E8D5C4]';
  return (
    <div className={`rounded-xl border p-3 ${boxCls}`}>
      <div className="text-[10px] uppercase tracking-wide text-[#8B7355] font-medium">{label}</div>
      <div className={`text-lg font-semibold mt-0.5 tabular-nums ${toneCls}`}>
        {/* "Cash out" is stored as a positive total; show it with a leading minus
            so the four tiles read as the equation they are. */}
        {value === undefined ? '—' : (tone === 'out' && value > 0 ? '−' + rs(value) : rs(value))}
      </div>
    </div>
  );
}
