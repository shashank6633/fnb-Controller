'use client';

/**
 * /boh — THE BILLS ON HOLD REGISTER.
 *
 * The owner's words for what this page is for: "from the moment a POS bill is
 * placed on hold until the entire payment is collected and the BOH is
 * officially closed." This is the first half — finding the bill you have to
 * chase today. The chasing itself happens on /boh/[id].
 *
 * ── WHAT THIS PAGE IS NOT ──────────────────────────────────────────────────
 * It does not create a hold. The POS already does that: a bill goes on hold
 * through /cashier, and src/app/api/dine-in/orders/[id]/hold/route.ts opens the
 * BOH record in the same breath. There is deliberately no "New BOH" button here
 * — a second way to put a bill on hold would be a second truth about what is
 * owed.
 *
 * It also records no money. Every rupee moves through /boh/[id], which posts to
 * /api/boh/[id]/payments — the one path that writes a boh_payments row and,
 * critically, NEVER writes a `sales` row or moves stock. Revenue and stock were
 * both booked the moment the bill was held (src/lib/station-master.ts:430).
 *
 * ── VISIBILITY ─────────────────────────────────────────────────────────────
 * Decided by the SERVER, never here. GET /api/boh pins a non-management caller
 * to their own responsible_user_id whatever this page sends, and only honours
 * ?user= after it has proved isManagement itself. So the "Whose bills" picker
 * below is a convenience for a manager, not a permission: a cashier who forged
 * the same query string would still get exactly their own rows back. The page
 * reads `is_management` off the response to decide what to SHOW, and nothing
 * here is the gate.
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import {
  Banknote, Search, RefreshCw, AlertTriangle, CalendarClock, PhoneOff,
  ArrowLeft, Loader2, Users,
} from 'lucide-react';
import { money, niceDate } from './shared';

interface BohRow {
  id: string; order_id: string; bill_number: string; bill_date: string; held_at: string;
  table_label: string; customer_name: string; customer_mobile: string; customer_company: string;
  reason: string; responsible_user_id: string; responsible_name: string; responsible_email: string;
  expected_payment_date: string; principal_amount: number; status: string;
  close_kind: string; paid_amount: number; balance_amount: number;
  days_pending: number; followup_state: string; order_status: string; reconcile_needed: boolean;
}
interface Directory { id: string; name: string; email: string }

/**
 * THE NUMBER HE CARES ABOUT, in words as well as a colour.
 *
 * days_pending is (today − expected payment date) in IST, so a positive number
 * is days PAST the promise and a negative one is a promise still in the future.
 * A colour alone fails a colour-blind manager and a phone in daylight, so every
 * state pairs its colour with a sentence — the same rule /cashier follows for
 * its waiting-table tiles.
 */
function pendingLabel(r: BohRow): { big: string; sub: string; tone: string } {
  if (r.status !== 'open') return { big: '—', sub: r.status === 'closed' ? 'Closed' : 'Void', tone: 'text-[#8B7355]' };
  if (!r.expected_payment_date) return { big: '—', sub: 'No date set', tone: 'text-amber-700' };
  const d = Number(r.days_pending) || 0;
  if (d > 0) return { big: String(d), tone: 'text-rose-700', sub: d === 1 ? 'day over' : 'days over' };
  if (d === 0) return { big: '0', tone: 'text-amber-700', sub: 'due today' };
  return { big: String(Math.abs(d)), tone: 'text-[#8B7355]', sub: Math.abs(d) === 1 ? 'day to go' : 'days to go' };
}

/** The follow-up chip. Plain words — a manager should not need a legend. */
function stateChip(r: BohRow) {
  if (r.status === 'closed') {
    const written = r.close_kind === 'write_off';
    return <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded shrink-0 ${written ? 'text-purple-700 bg-purple-50' : 'text-emerald-700 bg-emerald-50'}`}>{written ? 'Written off' : 'Closed'}</span>;
  }
  if (r.status === 'void') return <span className="text-[10px] uppercase px-1.5 py-0.5 rounded shrink-0 text-[#8B7355] bg-[#F5EDE2]">Void</span>;
  const map: Record<string, [string, string]> = {
    missed:    ['Follow-up missed', 'text-rose-700 bg-rose-100'],
    due:       ['Follow-up due',    'text-amber-700 bg-amber-100'],
    overdue:   ['Chased, unpaid',   'text-orange-700 bg-orange-50'],
    scheduled: ['Scheduled',        'text-sky-700 bg-sky-50'],
    none:      ['No date',          'text-amber-700 bg-amber-50'],
  };
  const [label, cls] = map[r.followup_state] || map.none;
  return <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded shrink-0 ${cls}`}>{label}</span>;
}

type Filter =
  | 'active' | 'due_today' | 'overdue' | 'missed' | 'partially_paid'
  | 'contact_missing' | 'reconcile' | 'closed' | 'all';

/**
 * Each chip is one server query, never a client-side re-filter of a truncated
 * page. The list is capped at 200 rows server-side, so filtering in the browser
 * would quietly answer "how many are overdue?" with "how many of the first 200".
 */
const FILTERS: { key: Filter; label: string; qs: string }[] = [
  { key: 'active',           label: 'Still owing',        qs: 'status=open' },
  { key: 'due_today',        label: 'Due today',          qs: 'bucket=due_today' },
  { key: 'overdue',          label: 'Overdue',            qs: 'bucket=overdue' },
  { key: 'missed',           label: 'Follow-up missed',   qs: 'followup=missed' },
  { key: 'partially_paid',   label: 'Part paid',          qs: 'bucket=partially_paid' },
  { key: 'contact_missing',  label: 'No phone number',    qs: 'bucket=contact_missing' },
  { key: 'reconcile',        label: 'Needs reconciling',  qs: 'bucket=reconcile' },
  { key: 'closed',           label: 'Closed',             qs: 'status=closed' },
  { key: 'all',              label: 'Everything',         qs: '' },
];

export default function BohListPage() {
  const [rows, setRows] = useState<BohRow[]>([]);
  const [isMgmt, setIsMgmt] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState<Filter>('active');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [user, setUser] = useState('');
  const [dir, setDir] = useState<Directory[]>([]);
  // The search box types fast; the server should not. Debounced below.
  const [qLive, setQLive] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setQ(qLive.trim()), 350);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [qLive]);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const f = FILTERS.find(x => x.key === filter)!;
      const p = new URLSearchParams(f.qs);
      if (q) p.set('q', q);
      if (from) p.set('from', from);
      if (to) p.set('to', to);
      if (user) p.set('user', user);
      const r = await api(`/api/boh?${p.toString()}`);
      const j = await r.json();
      if (!r.ok) { setErr(j?.error || `Could not load the register (HTTP ${r.status})`); setRows([]); }
      else { setRows(j.rows || []); setIsMgmt(!!j.is_management); }
    } catch {
      setErr('Could not reach the server. Check the connection and try again.');
      setRows([]);
    } finally { setLoading(false); }
  }, [filter, q, from, to, user]);

  useEffect(() => { load(); }, [load]);

  // The responsible-user picker is a MANAGER's convenience. It is only fetched
  // once we know the server called this person management — asking for the
  // directory otherwise would put a staff list on a screen that cannot use it.
  useEffect(() => {
    if (!isMgmt || dir.length) return;
    api('/api/tasks/users').then(r => r.json())
      .then(j => setDir((j.users || []).map((u: any) => ({ id: u.id, name: u.name || u.email, email: u.email }))))
      .catch(() => {});
  }, [isMgmt, dir.length]);

  const outstanding = rows.filter(r => r.status === 'open').reduce((s, r) => s + (Number(r.balance_amount) || 0), 0);
  const openCount = rows.filter(r => r.status === 'open').length;
  const noNumber = rows.filter(r => r.status === 'open' && !String(r.customer_mobile || '').trim()).length;
  const needsRecon = rows.filter(r => r.reconcile_needed).length;

  return (
    <div className="min-h-screen bg-[#FFF8F0]">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-5">

        {/* HEADER */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <Link href="/cashier" aria-label="Back to Cashier" className="p-2 rounded-lg border border-[#af4408]/30 text-[#af4408] hover:bg-[#af4408]/10"><ArrowLeft className="w-5 h-5" /></Link>
            <div className="p-2 bg-[#af4408]/10 rounded-lg"><Banknote className="w-6 h-6 text-[#af4408]" /></div>
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408]">Bills on Hold</h1>
              <p className="text-sm text-[#8B7355]">Bills that left the till unpaid — who is chasing each one, and what is still owed.</p>
            </div>
          </div>
          <button onClick={load} className="flex items-center gap-1.5 text-[#af4408] border border-[#af4408]/40 hover:bg-[#af4408]/10 px-3 py-2 rounded-lg text-sm font-medium">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>

        {/* THE HEADLINE FIGURES.
            These are the totals of the rows ON SCREEN, which is why the label
            says so. For a cashier the server has already pinned the list to
            their own bills, so "Your bills" is literally true; a manager sees
            the whole register and the label changes with it. Nothing here is a
            second opinion about what anyone may see. */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
            <div className="text-xs text-[#8B7355]">{isMgmt ? 'Still owed (all staff)' : 'Still owed (your bills)'}</div>
            <div className="text-2xl font-bold text-[#af4408] tabular-nums">{money(outstanding)}</div>
            <div className="text-[11px] text-[#8B7355]">across {openCount} bill{openCount === 1 ? '' : 's'} shown</div>
          </div>
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
            <div className="text-xs text-[#8B7355]">Follow-up missed</div>
            <div className="text-2xl font-bold text-rose-700 tabular-nums">{rows.filter(r => r.followup_state === 'missed').length}</div>
            <div className="text-[11px] text-[#8B7355]">promised day gone, nothing written down</div>
          </div>
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
            <div className="text-xs text-[#8B7355]">Due today</div>
            <div className="text-2xl font-bold text-amber-700 tabular-nums">{rows.filter(r => r.followup_state === 'due').length}</div>
            <div className="text-[11px] text-[#8B7355]">chase these before you go home</div>
          </div>
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
            <div className="text-xs text-[#8B7355]">No phone number</div>
            <div className="text-2xl font-bold text-[#2D1B0E] tabular-nums">{noNumber}</div>
            <div className="text-[11px] text-[#8B7355]">cannot be chased until someone adds one</div>
          </div>
        </div>

        {needsRecon > 0 && (
          <div className="bg-amber-50 border border-amber-300 rounded-xl px-4 py-3 text-sm text-amber-900 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>
              <b>{needsRecon} bill{needsRecon === 1 ? '' : 's'} on this list {needsRecon === 1 ? 'was' : 'were'} paid or changed at the till</b>, outside this register.
              Open {needsRecon === 1 ? 'it' : 'them'} and have a manager reconcile — recording another payment here would count the same money twice.
            </span>
          </div>
        )}

        {/* SEARCH + FILTERS.
            "Permanent searchability by bill number, customer, mobile, date,
            responsible user" — his list, and every one of them is answered by
            the server, not by filtering what happens to be loaded. */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="w-4 h-4 text-[#8B7355] absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                value={qLive} onChange={e => setQLive(e.target.value)}
                placeholder="Search bill number, customer, company or mobile"
                className="w-full pl-9 pr-3 py-2 text-sm border border-[#D4B896] rounded-lg bg-white text-[#2D1B0E] placeholder:text-[#B9A48C] outline-none focus:border-[#af4408]"
              />
            </div>
            <label className="flex items-center gap-1.5 text-sm border border-[#D4B896] rounded-lg px-2.5 py-2 bg-white">
              <CalendarClock className="w-4 h-4 text-[#af4408]" />
              <span className="text-[#8B7355]">Bill date</span>
              <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="bg-transparent text-[#2D1B0E] outline-none" />
              <span className="text-[#8B7355]">to</span>
              <input type="date" value={to} onChange={e => setTo(e.target.value)} className="bg-transparent text-[#2D1B0E] outline-none" />
            </label>
            {isMgmt && (
              <label className="flex items-center gap-1.5 text-sm border border-[#D4B896] rounded-lg px-2.5 py-2 bg-white">
                <Users className="w-4 h-4 text-[#af4408]" />
                <span className="text-[#8B7355]">Chased by</span>
                <select value={user} onChange={e => setUser(e.target.value)} className="bg-transparent text-[#2D1B0E] font-medium outline-none max-w-[160px]">
                  <option value="">Everyone</option>
                  {dir.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </label>
            )}
            {(q || from || to || user) && (
              <button onClick={() => { setQLive(''); setQ(''); setFrom(''); setTo(''); setUser(''); }}
                className="text-sm text-[#8B7355] hover:text-[#af4408] underline">Clear</button>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {FILTERS.map(f => (
              <button key={f.key} onClick={() => setFilter(f.key)}
                className={`text-sm px-3 py-1.5 rounded-full ${filter === f.key ? 'bg-[#af4408] text-white' : 'bg-[#FFF1E3] text-[#6B5744] hover:bg-[#F5EDE2]'}`}>
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {err && (
          <div className="bg-rose-50 border border-rose-300 rounded-xl px-4 py-3 text-sm text-rose-900 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /><span>{err}</span>
          </div>
        )}

        {/* THE REGISTER */}
        {loading && rows.length === 0 ? (
          <div className="bg-white border border-[#E8D5C4] rounded-xl py-16 text-center text-[#8B7355]">
            <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> Loading the register…
          </div>
        ) : rows.length === 0 && !err ? (
          <div className="bg-white border border-[#E8D5C4] rounded-xl py-16 text-center">
            <Banknote className="w-8 h-8 text-[#D4B896] mx-auto mb-2" />
            <p className="font-semibold text-[#2D1B0E]">
              {q || from || to || user ? 'Nothing matches that search.' : filter === 'active' ? 'No bills are on hold.' : 'Nothing in this list.'}
            </p>
            <p className="text-sm text-[#8B7355] mt-1">
              {q || from || to || user
                ? 'Try a shorter search, or widen the dates.'
                : 'A bill lands here the moment it is put on hold at the till.'}
            </p>
          </div>
        ) : (
          <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
            <div className="hidden md:grid grid-cols-[1.4fr_1.6fr_1fr_0.9fr_0.8fr_1.1fr] gap-3 px-4 py-2 bg-[#F5EDE2] text-[11px] uppercase font-semibold text-[#6B5744]">
              <div>Bill</div><div>Customer</div><div>Chased by</div><div>Expected</div><div className="text-center">Days</div><div className="text-right">Balance</div>
            </div>
            <div className="divide-y divide-[#F0E6D8]">
              {rows.map(r => {
                const p = pendingLabel(r);
                const part = r.status === 'open' && Number(r.paid_amount) > 0;
                return (
                  <Link key={r.id} href={`/boh/${r.id}`}
                    className="grid grid-cols-1 md:grid-cols-[1.4fr_1.6fr_1fr_0.9fr_0.8fr_1.1fr] gap-1.5 md:gap-3 px-4 py-3 hover:bg-[#FFF8F0] items-center">

                    {/* Bill */}
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-bold text-[#2D1B0E]">{r.bill_number || '—'}</span>
                        {stateChip(r)}
                      </div>
                      <div className="text-[11px] text-[#8B7355]">{niceDate(r.bill_date)}{r.table_label ? ` · ${r.table_label}` : ''}</div>
                      {r.reconcile_needed && (
                        <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 mt-1 inline-flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3" /> Paid at the till — needs reconciling
                        </div>
                      )}
                    </div>

                    {/* Customer */}
                    <div className="min-w-0">
                      <div className="text-[#2D1B0E] truncate">{r.customer_name || r.customer_company || <span className="text-[#B9A48C]">No name</span>}</div>
                      {String(r.customer_mobile || '').trim()
                        ? <div className="text-[11px] text-[#8B7355] tabular-nums">{r.customer_mobile}{r.customer_company && r.customer_name ? ` · ${r.customer_company}` : ''}</div>
                        : <div className="text-[11px] text-amber-800 inline-flex items-center gap-1"><PhoneOff className="w-3 h-3" /> No phone number</div>}
                    </div>

                    {/* Responsible */}
                    <div className="min-w-0 text-sm text-[#2D1B0E] truncate md:text-[13px]">
                      <span className="md:hidden text-[11px] text-[#8B7355]">Chased by </span>
                      {r.responsible_name || r.responsible_email || '—'}
                    </div>

                    {/* Expected date */}
                    <div className="text-[13px] text-[#2D1B0E]">
                      <span className="md:hidden text-[11px] text-[#8B7355]">Expected </span>
                      {r.expected_payment_date ? niceDate(r.expected_payment_date) : <span className="text-amber-700">Not set</span>}
                    </div>

                    {/* DAYS PENDING — the number he asked to see first. */}
                    <div className="md:text-center">
                      <span className={`text-2xl font-bold tabular-nums ${p.tone}`}>{p.big}</span>
                      <span className={`text-[11px] ml-1 md:ml-0 md:block ${p.tone}`}>{p.sub}</span>
                    </div>

                    {/* Money */}
                    <div className="md:text-right">
                      <div className={`font-bold tabular-nums ${r.status === 'open' ? 'text-[#af4408]' : 'text-[#8B7355]'}`}>{money(r.balance_amount)}</div>
                      {part
                        ? <div className="text-[11px] text-emerald-700">{money(r.paid_amount)} paid of {money(r.principal_amount)}</div>
                        : <div className="text-[11px] text-[#8B7355]">bill {money(r.principal_amount)}</div>}
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        )}

        <p className="text-[11px] text-[#8B7355] text-center">
          Showing up to 200 bills. Narrow the search or the dates if the one you want is not here.
        </p>
      </div>
    </div>
  );
}
