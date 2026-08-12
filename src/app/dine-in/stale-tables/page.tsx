'use client';

/**
 * IDLE TABLES — a manager's decision screen for open orders nobody closed.
 *
 * WHY THIS IS ITS OWN PAGE AND NOT A TAB SOMEWHERE.
 * The two obvious homes are wrong for it. /dine-in/tables is the floor plan any
 * captain uses, and /cashier is a till surface scoped to the floor the cashier
 * has checked into — this screen instead lists what EVERY open table is worth
 * across the outlet and offers the buttons that take the money or write it off,
 * which is management work. A standalone path is also the only thing the access
 * system can gate: page-catalog's mgmtOnly applies to a PATH, so a tab inside an
 * already-open page could not be restricted without narrowing that page for
 * everyone. It sits directly under Cashier in the Dine-In section, where the
 * person who closes bills will look for it.
 *
 * WHAT IT SHOWS, AND WHY THE TWO LISTS ARE NEVER MERGED.
 *   · HAS ITEMS AND IDLE — money is attached. Never closed by a timer, under any
 *     setting. Longest idle first; a person decides each one. Shown FIRST,
 *     because it is the list that costs money to ignore.
 *   · EMPTY AND IDLE — zero items, so no bill and nothing consumed. Once the
 *     window is on, the sweep closes these on its own (as a void, which for an
 *     empty order is literally true). Shown so the manager can see what the
 *     sweep is doing, and close them by hand now.
 * The screen says that difference out loud, because a manager who assumes the
 * system tidies up will leave money on the floor for weeks — which is exactly
 * the state this was built in: two tables idle 32 and 22 days.
 *
 * WHERE EACH BUTTON GOES.
 *   Settle → POST /api/dine-in/orders/[id]/settle       (existing route)
 *   Void   → POST /api/dine-in/orders/[id]/void         (existing route)
 *   Close  → POST /api/dine-in/stale-tables { action: 'close_empty' }, which
 *            forwards to closeEmptyOrdersByHand() — the SAME guarded statement
 *            the timed sweep uses, and the only writer in this feature. It
 *            cannot select an order that has a line, so the empty-close button
 *            is incapable of touching a bill even if this page's list were
 *            stale.
 * Nothing here re-implements settling or voiding.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Clock, Loader2, RefreshCw, Lock, AlertTriangle, ShieldCheck, Timer,
  Wallet, XCircle, Info, Table2, ChevronDown, CheckCircle2,
} from 'lucide-react';
import { api } from '@/lib/api';

/** Payment methods the settle route accepts. Kept in step with VALID_METHODS in
 *  src/app/api/dine-in/orders/[id]/settle/route.ts — that route validates the
 *  value and rejects anything else, so a drift here surfaces as a 400, never as
 *  a wrong tender being recorded. */
const METHODS = ['cash', 'upi', 'card', 'zomato', 'swiggy', 'dineout', 'cheque', 'other'];

/** Review thresholds offered in the picker, in hours. 0 = every open table. */
const THRESHOLDS = [1, 3, 6, 12, 24, 72, 0];

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const money = (n: number) => '₹' + inr.format(Number(n) || 0);

/** "32d 5h" / "16h 45m" / "22m". Idle is counted from the last item punched. */
function fmtIdle(hours: number): string {
  const h = Math.max(0, Number(hours) || 0);
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 24) return `${Math.floor(h)}h ${Math.round((h - Math.floor(h)) * 60)}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${Math.round(h - d * 24)}h`;
}

/** Where the guest is sitting, in the words the floor uses. */
function placeOf(r: Row): string {
  if (!r.table_id) {
    const t = (r.order_type || '').trim();
    return t && t !== 'dine-in' ? t.charAt(0).toUpperCase() + t.slice(1) : 'No table';
  }
  return `Table ${r.table_number || '—'}`;
}

/** A row from /api/dine-in/stale-tables: src/lib/stale-tables.ts's IdleOpenOrder
 *  plus the money the route works out. Every field is optional-tolerant at the
 *  point of use — the lib and this page ship together but need not deploy
 *  together. */
interface Row {
  id: string;
  order_number: number;
  order_type: string;
  table_id: string | null;
  table_number: string | null;
  floor: string | null;
  section: string | null;
  server_name: string;
  opened_by: string;
  guest_name: string;
  covers: number;
  created_at: string;
  last_activity_at: string;
  idle_hours: number;
  item_count: number;
  order_total: number;
  is_empty: boolean;
  would_auto_close: boolean;
  items: { name: string; quantity: number; line_total: number }[];
  more_items: number;
  value: number;
  cooked_items: number;
}

interface Payload {
  empty: Row[];
  with_items: Row[];
  window_hours: number;
  window_enabled: boolean;
  review_hours: number;
  review_widened_to_window: boolean;
  can_change_window: boolean;
  can_act: boolean;
  totals: {
    empty_count: number; with_items_count: number; with_items_value: number;
    would_auto_close: number; open_total: number;
  };
  sweep: { closed: number; skipped: string | null };
}

export default function StaleTablesPage() {
  const [me, setMe] = useState<any | null | undefined>(undefined);   // undefined = still loading
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hours, setHours] = useState<number>(3);                     // review threshold
  const [busy, setBusy] = useState<string | null>(null);             // order id (or 'bulk') being acted on
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  const [payFor, setPayFor] = useState<string | null>(null);         // row with the tender picker open
  const [voidFor, setVoidFor] = useState<string | null>(null);       // row with the reason box open
  const [voidReason, setVoidReason] = useState('');
  const [winDraft, setWinDraft] = useState('');                      // admin's window edit
  const [winSaving, setWinSaving] = useState(false);
  /** True once the admin has typed in the window box: stop overwriting their
   *  keystrokes from the 60s poll. */
  const winDirty = useRef(false);

  const flash = (ok: boolean, msg: string) => { setToast({ ok, msg }); setTimeout(() => setToast(null), 4500); };

  const isMgmt = !!me && (me.role === 'admin' || me.role === 'manager' || !!me.is_head_chef);

  const load = useCallback(async (h: number) => {
    try {
      const r = await api(`/api/dine-in/stale-tables?hours=${h}`);
      const j = await r.json();
      if (r.status === 403) { setDenied(true); return; }
      if (!r.ok) { setError(j.error || 'Could not load the list.'); return; }
      setData(j);
      setError(null);
      if (!winDirty.current) setWinDraft(String(j.window_hours ?? 0));
    } catch {
      setError('Could not reach the server. This is the last list that loaded.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    api('/api/auth/me').then(r => r.json()).then(j => setMe(j.user || null)).catch(() => setMe(null));
  }, []);

  useEffect(() => {
    if (!isMgmt) return;
    load(hours);
    // A minute is plenty: the shortest thing on this screen is measured in
    // hours, and a manager mid-decision should not have rows move under them.
    const t = setInterval(() => load(hours), 60000);
    // Named handler — an inline arrow would be a NEW function at removal time,
    // so the listener would survive every threshold change and stack one extra
    // refetch per click for the life of the tab.
    const onFocus = () => load(hours);
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(t); window.removeEventListener('focus', onFocus); };
  }, [isMgmt, hours, load]);

  /** Settle through the existing route. One tender — a discount, a
   *  service-charge waiver or a split payment belongs on the Cashier page, and
   *  this screen sends the manager there rather than rebuilding any of it. */
  async function settle(row: Row, method: string) {
    setBusy(row.id);
    try {
      const r = await api(`/api/dine-in/orders/${row.id}/settle`, {
        method: 'POST', body: { payment_method: method },
      });
      const j = await r.json();
      if (!r.ok) flash(false, j.error || 'Settle refused — nothing was charged.');
      else flash(true, `#${row.order_number} settled · ${money(j.total ?? row.value)} · ${method.toUpperCase()}`);
      setPayFor(null);
      await load(hours);
    } catch { flash(false, 'Settle failed — nothing was charged.'); }
    finally { setBusy(null); }
  }

  /** Void through the existing route. It refuses once the kitchen has cooked a
   *  ticket; the sentence it returns is shown verbatim. */
  async function voidOrder(row: Row, reason: string) {
    setBusy(row.id);
    try {
      const r = await api(`/api/dine-in/orders/${row.id}/void`, { method: 'POST', body: { reason } });
      const j = await r.json();
      if (!r.ok) flash(false, j.error || 'Void refused — the order is unchanged.');
      else flash(true, `#${row.order_number} voided — no sale recorded, table freed.`);
      setVoidFor(null); setVoidReason('');
      await load(hours);
    } catch { flash(false, 'Void failed — the order is unchanged.'); }
    finally { setBusy(null); }
  }

  /** Close empty tables now, through the guarded closer. `ids` only ever comes
   *  from the `empty` array, and the server statement re-checks emptiness as it
   *  writes, so a table that took an order since this list rendered is simply
   *  not closed and is reported back as skipped. */
  async function closeEmpty(ids: string[], label: string) {
    if (!ids.length) return;
    setBusy(ids.length === 1 ? ids[0] : 'bulk');
    try {
      const r = await api('/api/dine-in/stale-tables', {
        method: 'POST', body: { action: 'close_empty', ids },
      });
      const j = await r.json();
      if (!r.ok) flash(false, j.error || 'Could not close.');
      else if (j.closed === ids.length) flash(true, `${label} closed. ${j.freed_tables?.length ? `Freed: ${j.freed_tables.join(', ')}.` : ''}`);
      else flash(false, `${j.closed} of ${ids.length} closed. The rest had an order on them or were already closed.`);
      await load(hours);
    } catch { flash(false, 'Could not reach the server — nothing was closed.'); }
    finally { setBusy(null); }
  }

  async function closeAllEmpty() {
    const rows = data?.empty || [];
    if (!rows.length) return;
    if (!confirm(`Close ${rows.length} empty table${rows.length === 1 ? '' : 's'} now?\n\nThere is no bill on any of them — nothing was ordered. Each is recorded as a void.`)) return;
    await closeEmpty(rows.map(r => r.id), `${rows.length} empty table${rows.length === 1 ? '' : 's'}`);
  }

  async function saveWindow(next: number) {
    setWinSaving(true);
    try {
      const r = await api('/api/dine-in/stale-tables/window', { method: 'POST', body: { hours: next } });
      const j = await r.json();
      if (!r.ok) { flash(false, j.error || 'Could not change the window'); return; }
      winDirty.current = false;
      flash(true, j.hours === 0
        ? 'Auto-close is OFF. No table closes on its own.'
        : `Empty tables idle over ${j.hours}h will now close on their own. Tables with items are untouched.`
          + (j.adjusted_from != null ? ` (${j.adjusted_from} was out of range — stored ${j.hours}.)` : ''));
      await load(hours);
    } catch { flash(false, 'Could not reach the server.'); }
    finally { setWinSaving(false); }
  }

  const nothingIdle = useMemo(
    () => !!data && data.empty.length === 0 && data.with_items.length === 0,
    [data],
  );

  // ── Gates ────────────────────────────────────────────────────────────────
  if (me === undefined) {
    return <div className="min-h-screen bg-[#FFF8F0] flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-[#8B7355]" /></div>;
  }
  if (!isMgmt || denied) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] flex items-center justify-center p-6">
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 max-w-md text-center">
          <Lock className="w-10 h-10 text-[#af4408] mx-auto mb-3" />
          <h1 className="text-lg font-semibold text-[#2D1B0E] mb-1">Managers, Admins &amp; HODs only</h1>
          <p className="text-sm text-[#8B7355]">This page lists what every open table is worth and can settle or write off a bill, so it is restricted to management.</p>
        </div>
      </div>
    );
  }

  const canAct = data?.can_act ?? (me.role === 'admin' || me.role === 'manager');

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-5">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-3">
              <Timer className="w-7 h-7" /> Idle Tables
            </h1>
            <p className="text-[#8B7355] text-sm mt-1">
              Open tables where nothing has been punched for a while. Idle time is counted from the last item added, not from when the table was opened.
            </p>
          </div>
          <button onClick={() => load(hours)} disabled={loading}
                  className="self-start inline-flex items-center gap-2 px-3 py-2 border border-[#E8D5C4] rounded-lg text-sm text-[#6B5744] hover:bg-white disabled:opacity-50">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Refresh
          </button>
        </div>

        {/* THE STANDING RULE. Above every list, because the whole failure mode
            is a manager assuming the system tidies up after him. */}
        <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl p-3 text-[13px] text-[#6B5744] flex gap-2">
          <ShieldCheck className="w-4 h-4 text-[#af4408] shrink-0 mt-0.5" />
          <span>
            <b>A table with items is never closed automatically.</b> No setting on this page or anywhere else lets a timer settle or void a bill that has food on it —
            that would either invent money nobody collected or write off food that was eaten. Those tables wait here until a person decides.
            Only <b>empty</b> tables, where nothing was ordered at all, can close on their own.
          </span>
        </div>

        {error && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-[13px] text-amber-900 flex gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {error}
          </div>
        )}

        {/* Auto-close window */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <Clock className="w-4 h-4 text-[#af4408]" />
                <span className="font-semibold">Auto-close for empty tables</span>
                <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${
                  data?.window_enabled
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                    : 'bg-[#FFF8F0] border-[#E8D5C4] text-[#8B7355]'}`}>
                  {data?.window_enabled ? `ON · ${data.window_hours}h` : 'OFF'}
                </span>
              </div>
              <p className="text-[12px] text-[#8B7355] mt-1">
                {data?.window_enabled
                  ? `An empty table idle for more than ${data.window_hours} hour${data.window_hours === 1 ? '' : 's'} closes on its own and frees the table. Tables with items are not touched.`
                  : 'Auto-close is off. Nothing closes on its own — every table below, empty or not, stays open until someone here acts on it.'}
              </p>
            </div>

            {data?.can_change_window ? (
              <div className="flex items-center gap-2">
                <label className="text-[12px] text-[#6B5744]" htmlFor="win">Close empty after</label>
                <input id="win" type="number" min={0} step={1} value={winDraft}
                       onChange={(e) => { winDirty.current = true; setWinDraft(e.target.value); }}
                       className="w-20 border border-[#E8D5C4] rounded-lg px-2 py-1.5 text-sm bg-white" />
                <span className="text-[12px] text-[#6B5744]">hours</span>
                <button onClick={() => saveWindow(Number(winDraft))} disabled={winSaving}
                        className="px-3 py-1.5 rounded-lg bg-[#af4408] text-white text-sm font-semibold disabled:opacity-50">
                  {winSaving ? 'Saving…' : 'Save'}
                </button>
                {data.window_enabled && (
                  <button onClick={() => { winDirty.current = false; setWinDraft('0'); saveWindow(0); }} disabled={winSaving}
                          className="px-3 py-1.5 rounded-lg border border-[#E8D5C4] text-sm text-[#6B5744] disabled:opacity-50">
                    Turn off
                  </button>
                )}
              </div>
            ) : (
              <span className="text-[12px] text-[#8B7355]">Only an admin can change this window.</span>
            )}
          </div>
        </div>

        {/* Review threshold */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] text-[#6B5744] inline-flex items-center gap-1"><Info className="w-3.5 h-3.5" /> Show tables idle over</span>
          {THRESHOLDS.map(h => (
            <button key={h} onClick={() => { setHours(h); setLoading(true); }}
                    className={`px-2.5 py-1 rounded-full text-[12px] border ${
                      hours === h ? 'bg-[#af4408] text-white border-[#af4408]' : 'bg-white text-[#6B5744] border-[#E8D5C4]'}`}>
              {h === 0 ? 'All open' : `${h}h`}
            </button>
          ))}
          {data?.review_widened_to_window && (
            <span className="text-[11px] text-amber-900 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
              Showing everything idle over {data.review_hours}h — widened to match the {data.window_hours}h auto-close window
            </span>
          )}
          {!!data?.sweep?.closed && (
            <span className="text-[11px] text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">
              {data.sweep.closed} empty table{data.sweep.closed === 1 ? '' : 's'} closed automatically just now
            </span>
          )}
        </div>

        {loading && !data && (
          <div className="flex items-center justify-center py-16 text-[#8B7355]"><Loader2 className="w-6 h-6 animate-spin" /></div>
        )}

        {/* EMPTY STATE */}
        {data && nothingIdle && (
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center">
            <CheckCircle2 className="w-10 h-10 text-emerald-600 mx-auto mb-3" />
            <p className="font-semibold text-[#2D1B0E]">No idle tables.</p>
            <p className="text-sm text-[#8B7355] mt-1">
              {data.totals.open_total === 0
                ? 'Nothing is open right now.'
                : data.review_hours === 0
                  ? 'Every open table has had activity.'
                  : `${data.totals.open_total} open table${data.totals.open_total === 1 ? '' : 's'}, all with activity in the last ${data.review_hours} hour${data.review_hours === 1 ? '' : 's'}.`}
            </p>
          </div>
        )}

        {/* ── HAS ITEMS. First, because it is the list that costs money. ─────── */}
        {data && data.with_items.length > 0 && (
          <section className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-bold text-[#2D1B0E] flex items-center gap-2">
                <Wallet className="w-5 h-5 text-[#af4408]" />
                Has items and idle — needs a person
              </h2>
              <span className="text-[12px] text-[#6B5744]">
                {data.with_items.length} table{data.with_items.length === 1 ? '' : 's'} · {money(data.totals.with_items_value)} sitting open
              </span>
            </div>
            <p className="text-[12px] text-[#8B7355] -mt-1">
              These are never closed automatically, however long they sit. Longest idle first.
              <b> Settle</b> takes the money and writes the sale. <b>Void</b> records that it never happened and writes no sale — the kitchen having cooked any part of it blocks the void.
            </p>

            {data.with_items.map(row => {
              const cooked = (row.cooked_items || 0) > 0;
              return (
                <div key={row.id} className="bg-white border border-[#E8D5C4] rounded-xl p-4 shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold inline-flex items-center gap-1"><Table2 className="w-4 h-4 text-[#af4408]" /> {placeOf(row)}</span>
                        <span className="text-[11px] text-[#B0987F]">#{row.order_number}</span>
                        {row.floor && (
                          <span className="text-[11px] px-1.5 py-0.5 rounded border bg-[#FFF8F0] border-[#E8D5C4] text-[#6B5744]">
                            {row.floor}{row.section ? ` · ${row.section}` : ''}
                          </span>
                        )}
                        <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full border bg-[#FFF1E3] border-[#E8D5C4] text-[#af4408]">
                          idle {fmtIdle(row.idle_hours)}
                        </span>
                      </div>
                      <div className="text-[12px] text-[#8B7355] mt-1">
                        {row.server_name ? `Captain ${row.server_name}` : 'No captain recorded'}
                        {row.guest_name ? ` · ${row.guest_name}` : ''}
                        {row.covers ? ` · ${row.covers} cover${row.covers === 1 ? '' : 's'}` : ''}
                        {` · last item ${row.last_activity_at || '—'}`}
                      </div>
                      <div className="text-[12px] text-[#6B5744] mt-2">
                        {(row.items || []).map((it, i) => (
                          <span key={i} className="inline-block mr-2">
                            {it.quantity}× {it.name}
                            <span className="text-[#B0987F]"> {money(it.line_total)}</span>
                          </span>
                        ))}
                        {row.more_items > 0 && <span className="text-[#B0987F]">+{row.more_items} more</span>}
                      </div>
                    </div>

                    <div className="text-right shrink-0">
                      <div className="text-lg font-bold text-[#2D1B0E]">{money(row.value)}</div>
                      <div className="text-[11px] text-[#8B7355]">{row.item_count} item{row.item_count === 1 ? '' : 's'} · if settled now</div>
                    </div>
                  </div>

                  {canAct && (
                    <div className="mt-3 pt-3 border-t border-[#F0E4D8] flex flex-wrap items-center gap-2">
                      <button onClick={() => { setPayFor(payFor === row.id ? null : row.id); setVoidFor(null); }}
                              disabled={busy === row.id}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#af4408] text-white text-sm font-semibold disabled:opacity-50">
                        <Wallet className="w-4 h-4" /> Settle {money(row.value)} <ChevronDown className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => { setVoidFor(voidFor === row.id ? null : row.id); setPayFor(null); setVoidReason(''); }}
                              disabled={busy === row.id || cooked}
                              title={cooked ? 'The kitchen already cooked part of this order' : 'Void — no sale is recorded'}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#E8D5C4] text-sm text-[#6B5744] disabled:opacity-40">
                        <XCircle className="w-4 h-4" /> Void
                      </button>
                      {cooked && (
                        <span className="text-[11px] text-amber-900 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                          {row.cooked_items} item{row.cooked_items === 1 ? '' : 's'} already cooked — this can be settled, not voided.
                        </span>
                      )}
                      {busy === row.id && <Loader2 className="w-4 h-4 animate-spin text-[#8B7355]" />}
                    </div>
                  )}

                  {canAct && payFor === row.id && (
                    <div className="mt-3 bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3">
                      <div className="text-[12px] text-[#6B5744] mb-2">
                        How was {money(row.value)} paid? This writes the sale and deducts stock, exactly as the Cashier page would.
                        For a discount, a service-charge waiver or a split payment, use the Cashier page instead.
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {METHODS.map(m => (
                          <button key={m} onClick={() => settle(row, m)} disabled={busy === row.id}
                                  className="px-3 py-1.5 rounded-lg border border-[#E8D5C4] bg-white text-sm text-[#2D1B0E] hover:border-[#af4408] disabled:opacity-50 uppercase">
                            {m}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {canAct && voidFor === row.id && (
                    <div className="mt-3 bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3">
                      <div className="text-[12px] text-[#6B5744] mb-2">
                        Voiding records that this order never happened — no sale, no money. {money(row.value)} of food will not appear in sales. Why?
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <input value={voidReason} onChange={e => setVoidReason(e.target.value)}
                               placeholder="Reason (e.g. table left, opened by mistake)"
                               className="flex-1 min-w-[220px] border border-[#E8D5C4] rounded-lg px-3 py-1.5 text-sm bg-white" />
                        <button onClick={() => voidOrder(row, voidReason.trim() || 'idle table')}
                                disabled={busy === row.id}
                                className="px-3 py-1.5 rounded-lg bg-[#8B2E00] text-white text-sm font-semibold disabled:opacity-50">
                          Void #{row.order_number}
                        </button>
                        <button onClick={() => { setVoidFor(null); setVoidReason(''); }}
                                className="px-3 py-1.5 rounded-lg border border-[#E8D5C4] text-sm text-[#6B5744]">Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        )}

        {/* ── EMPTY ──────────────────────────────────────────────────────────── */}
        {data && data.empty.length > 0 && (
          <section className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-bold text-[#2D1B0E] flex items-center gap-2">
                <Clock className="w-5 h-5 text-[#8B7355]" />
                Empty and idle — nothing ordered
              </h2>
              {canAct && (
                <button onClick={closeAllEmpty} disabled={busy === 'bulk'}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#E8D5C4] bg-white text-sm text-[#6B5744] hover:border-[#af4408] disabled:opacity-50">
                  {busy === 'bulk' ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
                  Close all {data.empty.length} now
                </button>
              )}
            </div>
            <p className="text-[12px] text-[#8B7355] -mt-1">
              {data.window_enabled
                ? `No bill and nothing consumed on any of these, so they close on their own once idle past ${data.window_hours}h. Listed here so you can see what is about to go, or close them now.`
                : 'No bill and nothing consumed on any of these. They would close on their own if auto-close were on — it is off, so they will sit here until someone closes them.'}
            </p>

            <div className="bg-white border border-[#E8D5C4] rounded-xl divide-y divide-[#F0E4D8]">
              {data.empty.map(row => (
                <div key={row.id} className="p-3 flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 flex items-center gap-2 flex-wrap">
                    <span className="font-medium inline-flex items-center gap-1"><Table2 className="w-4 h-4 text-[#B0987F]" /> {placeOf(row)}</span>
                    <span className="text-[11px] text-[#B0987F]">#{row.order_number}</span>
                    {row.floor && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded border bg-[#FFF8F0] border-[#E8D5C4] text-[#6B5744]">
                        {row.floor}{row.section ? ` · ${row.section}` : ''}
                      </span>
                    )}
                    <span className="text-[11px] px-2 py-0.5 rounded-full border bg-[#FFF8F0] border-[#E8D5C4] text-[#8B7355]">idle {fmtIdle(row.idle_hours)}</span>
                    {row.would_auto_close && (
                      <span className="text-[11px] px-2 py-0.5 rounded-full border bg-emerald-50 border-emerald-200 text-emerald-800">closes on its own</span>
                    )}
                    <span className="text-[12px] text-[#8B7355]">
                      {row.opened_by ? `opened by ${row.opened_by}` : 'no captain recorded'} · opened {row.created_at || '—'}
                    </span>
                  </div>
                  {canAct && (
                    <button onClick={() => closeEmpty([row.id], `${placeOf(row)} (#${row.order_number})`)}
                            disabled={busy === row.id || busy === 'bulk'}
                            className="px-3 py-1.5 rounded-lg border border-[#E8D5C4] text-sm text-[#6B5744] hover:border-[#af4408] disabled:opacity-50">
                      {busy === row.id ? 'Closing…' : 'Close now'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {data && !canAct && (data.empty.length > 0 || data.with_items.length > 0) && (
          <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl p-3 text-[12px] text-[#6B5744]">
            You can see this list, but settling, voiding and closing are limited to a Manager or an Admin. Ask one to clear these.
          </div>
        )}
      </div>

      {toast && (
        <div className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-lg text-sm shadow-lg max-w-[92vw] text-center ${
          toast.ok ? 'bg-emerald-700 text-white' : 'bg-[#8B2E00] text-white'}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
