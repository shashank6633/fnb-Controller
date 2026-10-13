'use client';

/**
 * BILLS ON HOLD — DASHBOARD
 * =========================
 *
 * The owner's objective for the module is "a complete BOH lifecycle and
 * accountability system — from the moment a POS bill is placed on hold until
 * the entire payment is collected and the BOH is officially closed". This
 * screen is the "where does it stand" half of that: every figure he named, over
 * the bills a filter selects, with the rows behind the figures on the same
 * page so no number has to be taken on trust.
 *
 * ── WHY IT IS ITS OWN PAGE, AND MANAGEMENT ONLY ────────────────────────────
 * Every tile here is a cross-user money total and every row carries a
 * customer's phone number. src/lib/boh-access.ts's third tier puts exactly that
 * behind isManagement(); a cashier's OWN bills live on the register (/boh).
 * page-catalog's mgmtOnly runs before the null-map backward-compat grant, so it
 * is a real page-level lock — but the gate that actually matters is
 * GET /api/boh/dashboard's own 403, because proxy.ts guards pages, not APIs.
 *
 * ── NOTHING HERE MAY LOOK LIVE WHEN IT IS NOT ──────────────────────────────
 * The figures are a snapshot taken when the request was served. The header
 * prints the exact time they were counted and how long ago that was, and turns
 * amber past five minutes. There is no auto-refresh: a number that changes
 * under a manager's eyes without him asking is worse than an old number he can
 * see the age of.
 *
 * ── AN EMPTY SCREEN IS NOT AN ERROR ────────────────────────────────────────
 * Three different nothings, three different sentences:
 *   · no BOH records exist at all      → "Nothing is on hold."
 *   · records exist, filters hide them → "No bill matches these filters."
 *   · the request failed               → a red panel that says so.
 * They are never the same panel, because "nothing is pending" read as a failure
 * (or a failure read as "nothing is pending") is how money gets left uncollected.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Wallet, RefreshCw, Loader2, Lock, AlertTriangle, Search, X, Clock,
  CalendarClock, PhoneOff, TriangleAlert, CheckCircle2, Users, Filter,
  BadgeIndianRupee, CalendarX2, HandCoins, FileClock,
} from 'lucide-react';
import { api } from '@/lib/api';

/* ─────────────────────────────── shapes ─────────────────────────────────── */

interface Figures {
  rows_in_view: number;
  total_boh_amount: number;
  total_pending_bills: number;
  pending_amount: number;
  due_today_count: number; due_today_amount: number;
  overdue_count: number; overdue_amount: number;
  worst_overdue_days: number;
  followups_due: number; followups_missed: number; followups_missed_amount: number;
  payments_expected_today: number;
  payments_received_today: number; payments_received_total: number;
  partially_paid_count: number; partially_paid_amount: number;
  closed_count: number; closed_paid_in_full: number;
  written_off_count: number; written_off_amount: number;
  no_date_count: number; no_date_amount: number;
  contact_missing_count: number;
  reconcile_needed_count: number;
}

interface Row {
  id: string; order_id: string;
  bill_number: string; bill_date: string; table_label: string;
  customer_name: string; customer_mobile: string; customer_company: string;
  responsible_user_id: string; responsible_name: string;
  expected_payment_date: string;
  principal_amount: number; paid_amount: number; balance_amount: number;
  status: string; close_kind: string;
  followup_state: string;
  overdue_days: number | null;
  reconcile_needed: boolean; order_status: string;
  reason: string;
}

interface Payload {
  figures: Figures;
  rows: Row[];
  row_total: number;
  display_cap: number;
  truncated: boolean;
  users: { id: string; name: string }[];
  today: string;
  generated_at: string;
  filter_active: boolean;
  any_records: number;
}

/** Exactly the keys GET /api/boh/dashboard reads. Anything else is dropped there. */
interface FilterState {
  from: string; to: string;
  exp_from: string; exp_to: string;
  q: string;
  user: string;
  status: string;
  followup: string;
  bucket: string;
  amt_min: string; amt_max: string;
  overdue_min: string; overdue_max: string;
}

const EMPTY: FilterState = {
  from: '', to: '', exp_from: '', exp_to: '', q: '', user: '',
  status: '', followup: '', bucket: '', amt_min: '', amt_max: '',
  overdue_min: '', overdue_max: '',
};

/* ─────────────────────────────── format ─────────────────────────────────── */

const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (n: unknown) => '₹' + inr.format(Number(n) || 0);
const int = new Intl.NumberFormat('en-IN');

/** 'Thu 18 Sep 2026' from an IST YYYY-MM-DD, without touching timezones. */
function fmtDate(d: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) return '—';
  const [y, m, dd] = d.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${dd} ${months[m - 1]} ${y}`;
}

function fmtClockIST(iso: string): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(t));
}

function fmtAge(sec: number): string {
  if (sec < 5) return 'just now';
  if (sec < 60) return `${Math.floor(sec)}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m ago`;
}

const FOLLOWUP_LABEL: Record<string, string> = {
  due: 'Follow-up due today',
  missed: 'Follow-up MISSED',
  overdue: 'Chased, still unpaid',
  scheduled: 'Scheduled',
  none: '—',
};

/* ──────────────────────────────── tile ──────────────────────────────────── */

function Tile(props: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'plain' | 'warn' | 'bad' | 'good';
  icon?: React.ElementType;
  active?: boolean;
  onClick?: () => void;
  title?: string;
}) {
  const { label, value, sub, tone = 'plain', icon: Icon, active, onClick, title } = props;
  const tones: Record<string, string> = {
    plain: 'bg-white border-[#E8D5C4] text-[#2D1B0E]',
    good: 'bg-emerald-50 border-emerald-200 text-emerald-900',
    warn: 'bg-amber-50 border-amber-200 text-amber-900',
    bad: 'bg-red-50 border-red-200 text-red-900',
  };
  const body = (
    <>
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide opacity-70">
        {Icon ? <Icon className="w-3.5 h-3.5" /> : null}
        <span className="truncate">{label}</span>
      </div>
      <div className="text-xl font-bold mt-1 tabular-nums">{value}</div>
      {sub ? <div className="text-[11px] mt-0.5 opacity-75">{sub}</div> : null}
    </>
  );
  const cls = `rounded-xl border p-3 text-left ${tones[tone]} ${active ? 'ring-2 ring-[#af4408] ring-offset-1 ring-offset-[#FFF8F0]' : ''}`;
  if (!onClick) return <div className={cls} title={title}>{body}</div>;
  return (
    <button type="button" onClick={onClick} title={title || 'Filter the list by this'}
            className={`${cls} hover:shadow-sm transition-shadow cursor-pointer w-full`}>
      {body}
    </button>
  );
}

/* ──────────────────────────────── page ──────────────────────────────────── */

export default function BohDashboardPage() {
  const [me, setMe] = useState<any | null | undefined>(undefined);   // undefined = loading
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [denied, setDenied] = useState('');
  const [f, setF] = useState<FilterState>(EMPTY);
  const [fetchedAt, setFetchedAt] = useState<number>(0);
  const [nowTick, setNowTick] = useState<number>(Date.now());

  const isMgmt = !!me && (me.role === 'admin' || me.role === 'manager' || !!me.is_head_chef);

  useEffect(() => {
    api('/api/auth/me').then(r => r.json()).then(j => setMe(j.user || null)).catch(() => setMe(null));
  }, []);

  // Carry a filter in from a link (the accountability screen sends one).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const p = new URLSearchParams(window.location.search);
    if (![...p.keys()].length) return;
    setF(prev => {
      const next = { ...prev };
      (Object.keys(EMPTY) as (keyof FilterState)[]).forEach(k => {
        const v = p.get(k); if (v != null) next[k] = v;
      });
      return next;
    });
  }, []);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    (Object.entries(f) as [keyof FilterState, string][]).forEach(([k, v]) => {
      if (String(v || '').trim()) p.set(k, String(v).trim());
    });
    return p.toString();
  }, [f]);

  const load = useCallback(async (query: string) => {
    setLoading(true); setError('');
    try {
      const r = await api(`/api/boh/dashboard${query ? `?${query}` : ''}`);
      const j = await r.json();
      if (r.status === 403) { setDenied(j.error || 'Management only.'); setData(null); return; }
      if (!r.ok) { setError(j.error || `Could not load the dashboard (HTTP ${r.status}).`); return; }
      setDenied('');
      setData(j as Payload);
      setFetchedAt(Date.now());
    } catch {
      setError('Could not reach the server. The figures below, if any, are from the last successful load.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isMgmt) return;
    const t = setTimeout(() => { void load(qs); }, 250);   // debounce typing
    return () => clearTimeout(t);
  }, [isMgmt, qs, load]);

  // Age ticker — the only thing on this page that moves on its own, and it
  // moves so the numbers can be seen NOT to.
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  const ageSec = fetchedAt ? Math.max(0, (nowTick - fetchedAt) / 1000) : 0;
  const stale = fetchedAt > 0 && ageSec > 300;

  const set = (k: keyof FilterState, v: string) => setF(prev => ({ ...prev, [k]: v }));
  const toggleBucket = (b: string) => setF(prev => ({ ...prev, bucket: prev.bucket === b ? '' : b, followup: '' }));
  const toggleFollowup = (s: string) => setF(prev => ({ ...prev, followup: prev.followup === s ? '' : s, bucket: '' }));
  const anyFilter = Object.values(f).some(v => String(v || '').trim() !== '');

  /* ── gates ─────────────────────────────────────────────────────────────── */
  if (me === undefined) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-[#8B7355]" />
      </div>
    );
  }
  if (!isMgmt || denied) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] flex items-center justify-center p-6">
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 max-w-md text-center">
          <Lock className="w-10 h-10 text-[#af4408] mx-auto mb-3" />
          <h1 className="text-lg font-semibold text-[#2D1B0E] mb-1">Managers, Admins &amp; HODs only</h1>
          <p className="text-sm text-[#8B7355]">
            {denied || 'This dashboard shows what every bill on hold is worth across all users, and a customer phone number on each row, so it is restricted to management. Your own bills on hold are on the Bills on Hold register.'}
          </p>
        </div>
      </div>
    );
  }

  const g = data?.figures;

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">

        {/* ── header ─────────────────────────────────────────────────────── */}
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-3">
              <Wallet className="w-7 h-7" /> Bills on Hold — Dashboard
            </h1>
            <p className="text-[#8B7355] text-sm mt-1">
              Every bill the POS is holding, what is still owed on it, and whether anybody chased it.
              Money is not re-booked here — revenue and stock were recorded the moment the bill was held.
            </p>
          </div>
          <div className="flex flex-col items-start sm:items-end gap-1.5">
            <button onClick={() => void load(qs)} disabled={loading}
                    className="inline-flex items-center gap-2 px-3 py-2 border border-[#E8D5C4] rounded-lg text-sm text-[#6B5744] hover:bg-white disabled:opacity-50">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Refresh
            </button>
            {/* THE STALENESS STAMP. Never says "live". */}
            <div className={`text-[11px] px-2 py-1 rounded-md border ${
              stale ? 'bg-amber-50 border-amber-300 text-amber-900 font-semibold'
                    : 'bg-white border-[#E8D5C4] text-[#8B7355]'}`}>
              {fetchedAt === 0 ? 'Not counted yet' : (
                <>
                  Counted at {fmtClockIST(data?.generated_at || '')} IST · {fmtAge(ageSec)}
                  {stale ? ' · may be out of date, refresh' : ''}
                </>
              )}
            </div>
          </div>
        </div>

        {/* ── error (never doubles as an empty state) ────────────────────── */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-[13px] text-red-900 flex gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {error}
          </div>
        )}
        {data?.truncated && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-[13px] text-amber-900 flex gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            More bills match than this screen reads in one pass. Narrow the filters — the figures below
            cover only what was read.
          </div>
        )}

        {/* ── filters ───────────────────────────────────────────────────── */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-[#2D1B0E]">
              <Filter className="w-4 h-4 text-[#af4408]" /> Filters
            </div>
            {anyFilter && (
              <button onClick={() => setF(EMPTY)}
                      className="inline-flex items-center gap-1 text-[12px] text-[#af4408] hover:underline">
                <X className="w-3.5 h-3.5" /> Clear all
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <label className="block">
              <span className="text-[11px] font-semibold text-[#6B5744] uppercase tracking-wide">Search</span>
              <div className="relative mt-1">
                <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-[#8B7355]" />
                <input value={f.q} onChange={e => set('q', e.target.value)}
                       placeholder="Bill no · customer · company · mobile"
                       className="w-full border border-[#E8D5C4] rounded-lg pl-8 pr-2 py-2 text-sm bg-white" />
              </div>
            </label>

            <label className="block">
              <span className="text-[11px] font-semibold text-[#6B5744] uppercase tracking-wide">Responsible user</span>
              <select value={f.user} onChange={e => set('user', e.target.value)}
                      className="mt-1 w-full border border-[#E8D5C4] rounded-lg px-2 py-2 text-sm bg-white">
                <option value="">Everyone</option>
                {(data?.users || []).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </label>

            <label className="block">
              <span className="text-[11px] font-semibold text-[#6B5744] uppercase tracking-wide">Status</span>
              <select value={f.status} onChange={e => set('status', e.target.value)}
                      className="mt-1 w-full border border-[#E8D5C4] rounded-lg px-2 py-2 text-sm bg-white">
                <option value="">Open and closed</option>
                <option value="open">Open only</option>
                <option value="closed">Closed only</option>
              </select>
            </label>

            <label className="block">
              <span className="text-[11px] font-semibold text-[#6B5744] uppercase tracking-wide">Follow-up state</span>
              <select value={f.followup} onChange={e => setF(prev => ({ ...prev, followup: e.target.value, bucket: '' }))}
                      className="mt-1 w-full border border-[#E8D5C4] rounded-lg px-2 py-2 text-sm bg-white">
                <option value="">Any</option>
                <option value="due">Due today</option>
                <option value="missed">Missed</option>
                <option value="overdue">Chased, still unpaid</option>
                <option value="scheduled">Scheduled (future date)</option>
              </select>
            </label>

            <label className="block">
              <span className="text-[11px] font-semibold text-[#6B5744] uppercase tracking-wide">Bill date from</span>
              <input type="date" value={f.from} onChange={e => set('from', e.target.value)}
                     className="mt-1 w-full border border-[#E8D5C4] rounded-lg px-2 py-2 text-sm bg-white" />
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold text-[#6B5744] uppercase tracking-wide">Bill date to</span>
              <input type="date" value={f.to} onChange={e => set('to', e.target.value)}
                     className="mt-1 w-full border border-[#E8D5C4] rounded-lg px-2 py-2 text-sm bg-white" />
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold text-[#6B5744] uppercase tracking-wide">Expected payment from</span>
              <input type="date" value={f.exp_from} onChange={e => set('exp_from', e.target.value)}
                     className="mt-1 w-full border border-[#E8D5C4] rounded-lg px-2 py-2 text-sm bg-white" />
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold text-[#6B5744] uppercase tracking-wide">Expected payment to</span>
              <input type="date" value={f.exp_to} onChange={e => set('exp_to', e.target.value)}
                     className="mt-1 w-full border border-[#E8D5C4] rounded-lg px-2 py-2 text-sm bg-white" />
            </label>

            <label className="block">
              <span className="text-[11px] font-semibold text-[#6B5744] uppercase tracking-wide">Bill amount ₹ min</span>
              <input type="number" inputMode="decimal" value={f.amt_min} onChange={e => set('amt_min', e.target.value)}
                     className="mt-1 w-full border border-[#E8D5C4] rounded-lg px-2 py-2 text-sm bg-white" />
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold text-[#6B5744] uppercase tracking-wide">Bill amount ₹ max</span>
              <input type="number" inputMode="decimal" value={f.amt_max} onChange={e => set('amt_max', e.target.value)}
                     className="mt-1 w-full border border-[#E8D5C4] rounded-lg px-2 py-2 text-sm bg-white" />
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold text-[#6B5744] uppercase tracking-wide">Overdue days min</span>
              <input type="number" inputMode="numeric" value={f.overdue_min} onChange={e => set('overdue_min', e.target.value)}
                     placeholder="0 = due today"
                     className="mt-1 w-full border border-[#E8D5C4] rounded-lg px-2 py-2 text-sm bg-white" />
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold text-[#6B5744] uppercase tracking-wide">Overdue days max</span>
              <input type="number" inputMode="numeric" value={f.overdue_max} onChange={e => set('overdue_max', e.target.value)}
                     className="mt-1 w-full border border-[#E8D5C4] rounded-lg px-2 py-2 text-sm bg-white" />
            </label>
          </div>

          <p className="text-[11px] text-[#8B7355]">
            Every figure on this page counts only the bills these filters select. Bills voided as a mistake are
            never included, on any filter.
            {' '}An overdue-days filter also hides bills with no expected payment date, because they have no age.
          </p>
        </div>

        {/* ── the figures ───────────────────────────────────────────────── */}
        {loading && !data ? (
          <div className="flex items-center justify-center py-16 text-[#8B7355]">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
        ) : !g ? null : (
          <>
            <section className="space-y-2">
              <h2 className="text-[12px] font-bold uppercase tracking-wide text-[#8B7355]">Money</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                <Tile label="Total BOH amount" value={money(g.total_boh_amount)} icon={BadgeIndianRupee}
                      sub={`${int.format(g.rows_in_view)} bill${g.rows_in_view === 1 ? '' : 's'} in view`}
                      title="The frozen bill total of every BOH record in view — open and closed. This is what was ever put on hold, not what is still owed." />
                <Tile label="Still pending" value={money(g.pending_amount)} icon={Wallet}
                      tone={g.pending_amount > 0 ? 'warn' : 'good'}
                      sub={`${int.format(g.total_pending_bills)} open bill${g.total_pending_bills === 1 ? '' : 's'}`}
                      active={f.status === 'open'}
                      onClick={() => set('status', f.status === 'open' ? '' : 'open')}
                      title="Bill total minus everything collected, across open BOH records." />
                <Tile label="Received today" value={money(g.payments_received_today)} icon={HandCoins}
                      tone={g.payments_received_today > 0 ? 'good' : 'plain'}
                      sub={`${money(g.payments_received_total)} collected in total`}
                      title="Payments recorded against these bills with today's IST date. Recorded as collections, never as new sales." />
                <Tile label="Expected today" value={money(g.payments_expected_today)} icon={CalendarClock}
                      sub={`${int.format(g.due_today_count)} bill${g.due_today_count === 1 ? '' : 's'} dated today`}
                      active={f.bucket === 'due_today'}
                      onClick={() => toggleBucket('due_today')}
                      title="The outstanding balance of the bills whose expected payment date is today. Same figure as Due today." />
                <Tile label="Partly paid" value={money(g.partially_paid_amount)} icon={FileClock}
                      tone={g.partially_paid_count > 0 ? 'warn' : 'plain'}
                      sub={`${int.format(g.partially_paid_count)} bill${g.partially_paid_count === 1 ? '' : 's'} still short`}
                      active={f.bucket === 'partially_paid'}
                      onClick={() => toggleBucket('partially_paid')}
                      title="Something was collected but a balance remains. These continue as active BOH until the balance reaches zero." />
              </div>
            </section>

            <section className="space-y-2">
              <h2 className="text-[12px] font-bold uppercase tracking-wide text-[#8B7355]">Timing</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                <Tile label="Due today" value={int.format(g.due_today_count)} icon={CalendarClock}
                      tone={g.due_today_count > 0 ? 'warn' : 'plain'}
                      sub={money(g.due_today_amount)}
                      active={f.bucket === 'due_today'}
                      onClick={() => toggleBucket('due_today')} />
                <Tile label="Overdue" value={int.format(g.overdue_count)} icon={TriangleAlert}
                      tone={g.overdue_count > 0 ? 'bad' : 'good'}
                      sub={g.overdue_count > 0 ? `${money(g.overdue_amount)} · oldest ${g.worst_overdue_days}d` : 'Nothing past its date'}
                      active={f.bucket === 'overdue'}
                      onClick={() => toggleBucket('overdue')}
                      title="Open bills whose expected payment date has passed, whether or not anyone chased them." />
                <Tile label="No date set" value={int.format(g.no_date_count)} icon={CalendarX2}
                      tone={g.no_date_count > 0 ? 'warn' : 'plain'}
                      sub={g.no_date_count > 0 ? money(g.no_date_amount) : 'Every open bill has a date'}
                      active={f.bucket === 'no_date'}
                      onClick={() => toggleBucket('no_date')}
                      title="Open bills nobody promised a date for. They can never be due, overdue or missed — which is exactly why they are shown." />
                <Tile label="No phone number" value={int.format(g.contact_missing_count)} icon={PhoneOff}
                      tone={g.contact_missing_count > 0 ? 'warn' : 'plain'}
                      sub={g.contact_missing_count > 0 ? 'Cannot be chased' : 'Every open bill is reachable'}
                      active={f.bucket === 'contact_missing'}
                      onClick={() => toggleBucket('contact_missing')}
                      title="Open bills with no customer mobile on record. Add one from the BOH record before the reminder is any use." />
                <Tile label="Needs reconciling" value={int.format(g.reconcile_needed_count)} icon={AlertTriangle}
                      tone={g.reconcile_needed_count > 0 ? 'bad' : 'plain'}
                      sub={g.reconcile_needed_count > 0 ? 'POS bill is no longer on hold' : 'All POS bills still held'}
                      active={f.bucket === 'reconcile'}
                      onClick={() => toggleBucket('reconcile')}
                      title="The BOH is open but the POS bill behind it is no longer 'on_hold' — it was settled or changed at the till. A person must decide what happened." />
              </div>
            </section>

            <section className="space-y-2">
              <h2 className="text-[12px] font-bold uppercase tracking-wide text-[#8B7355]">Follow-ups and closure</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                <Tile label="Follow-ups due" value={int.format(g.followups_due)} icon={Clock}
                      tone={g.followups_due > 0 ? 'warn' : 'plain'}
                      sub="Dated today, nothing logged yet"
                      active={f.followup === 'due'}
                      onClick={() => toggleFollowup('due')} />
                <Tile label="Follow-ups MISSED" value={int.format(g.followups_missed)} icon={TriangleAlert}
                      tone={g.followups_missed > 0 ? 'bad' : 'good'}
                      sub={g.followups_missed > 0 ? `${money(g.followups_missed_amount)} unchased` : 'Every lapsed date was chased'}
                      active={f.followup === 'missed'}
                      onClick={() => toggleFollowup('missed')}
                      title="The date someone promised to chase this bill has gone by and nobody wrote down what happened." />
                <Tile label="Closed" value={int.format(g.closed_count)} icon={CheckCircle2}
                      tone="plain"
                      sub={`${int.format(g.closed_paid_in_full)} paid in full`}
                      active={f.status === 'closed'}
                      onClick={() => set('status', f.status === 'closed' ? '' : 'closed')} />
                <Tile label="Written off" value={int.format(g.written_off_count)} icon={AlertTriangle}
                      tone={g.written_off_count > 0 ? 'bad' : 'plain'}
                      sub={g.written_off_count > 0 ? money(g.written_off_amount) : 'Nothing written off'}
                      title="Closed by a manager with a balance still outstanding. Always a judgement, always audited." />
                <div className="rounded-xl border border-[#E8D5C4] bg-[#FFF1E3] p-3 flex flex-col justify-between">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-[#6B5744] flex items-center gap-1.5">
                    <Users className="w-3.5 h-3.5" /> Who is chasing
                  </div>
                  <Link href={`/boh/accountability${qs ? `?${qs}` : ''}`}
                        className="mt-2 inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-[#af4408] text-white text-sm font-semibold">
                    User-wise view
                  </Link>
                </div>
              </div>
            </section>

            {/* ── the rows behind the figures ─────────────────────────────── */}
            <section className="space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-[12px] font-bold uppercase tracking-wide text-[#8B7355]">
                  Bills in view ({int.format(data!.row_total)})
                </h2>
                {data!.row_total > data!.rows.length && (
                  <span className="text-[11px] text-[#8B7355]">
                    Showing the first {int.format(data!.rows.length)}. The figures above count all {int.format(data!.row_total)}.
                  </span>
                )}
              </div>

              {data!.row_total === 0 ? (
                /* THE THREE NOTHINGS — never an error panel */
                <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center">
                  <CheckCircle2 className="w-10 h-10 text-emerald-600 mx-auto mb-3" />
                  {data!.any_records === 0 ? (
                    <>
                      <p className="font-semibold text-[#2D1B0E]">Nothing is on hold.</p>
                      <p className="text-sm text-[#8B7355] mt-1">
                        No bill has been placed on hold yet, so there is nothing to chase. A BOH record opens
                        automatically the moment a bill is put on hold at the Cashier screen.
                      </p>
                    </>
                  ) : data!.filter_active ? (
                    <>
                      <p className="font-semibold text-[#2D1B0E]">No bill matches these filters.</p>
                      <p className="text-sm text-[#8B7355] mt-1">
                        {int.format(data!.any_records)} BOH record{data!.any_records === 1 ? ' exists' : 's exist'} in total — widen or clear the filters to see them.
                      </p>
                      <button onClick={() => setF(EMPTY)}
                              className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#E8D5C4] text-sm text-[#6B5744] hover:bg-[#FFF8F0]">
                        <X className="w-3.5 h-3.5" /> Clear filters
                      </button>
                    </>
                  ) : (
                    /* Records exist for this account but none belongs to the
                       outlet now selected. Saying "nothing is pending" here
                       would be a false all-clear, so it says what is actually
                       true instead. */
                    <>
                      <p className="font-semibold text-[#2D1B0E]">No bill is on hold for this outlet.</p>
                      <p className="text-sm text-[#8B7355] mt-1">
                        Nothing is pending here. Bills on hold recorded against another outlet are not shown —
                        switch outlet to see them.
                      </p>
                    </>
                  )}
                </div>
              ) : (
                <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-[#FFF1E3] text-[#6B5744]">
                        <tr className="text-left">
                          <th className="px-3 py-2 font-semibold">Bill</th>
                          <th className="px-3 py-2 font-semibold">Customer</th>
                          <th className="px-3 py-2 font-semibold">Responsible</th>
                          <th className="px-3 py-2 font-semibold">Expected</th>
                          <th className="px-3 py-2 font-semibold text-right">Bill ₹</th>
                          <th className="px-3 py-2 font-semibold text-right">Paid ₹</th>
                          <th className="px-3 py-2 font-semibold text-right">Balance ₹</th>
                          <th className="px-3 py-2 font-semibold">Follow-up</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data!.rows.map(r => {
                          const od = r.overdue_days;
                          const isOverdue = r.status === 'open' && od != null && od > 0;
                          return (
                            <tr key={r.id} className="border-t border-[#F0E4D8] align-top">
                              <td className="px-3 py-2">
                                <div className="font-semibold">{r.bill_number || '—'}</div>
                                <div className="text-[11px] text-[#8B7355]">
                                  {fmtDate(r.bill_date)}{r.table_label ? ` · ${r.table_label}` : ''}
                                </div>
                                {r.status !== 'open' && (
                                  <span className="inline-block mt-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border border-[#E8D5C4] bg-[#FFF8F0] text-[#6B5744]">
                                    {r.close_kind === 'write_off' ? 'WRITTEN OFF'
                                      : r.close_kind === 'settled_outside_boh' ? 'SETTLED AT TILL'
                                      : 'CLOSED'}
                                  </span>
                                )}
                                {r.reconcile_needed && (
                                  <span className="inline-block mt-1 ml-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border border-red-200 bg-red-50 text-red-800">
                                    POS bill is {r.order_status || 'gone'}
                                  </span>
                                )}
                              </td>
                              <td className="px-3 py-2">
                                <div>{r.customer_name || <span className="text-[#B9A48F]">No name</span>}</div>
                                <div className="text-[11px] text-[#8B7355]">
                                  {r.customer_mobile || <span className="text-amber-700 font-semibold">No number</span>}
                                  {r.customer_company ? ` · ${r.customer_company}` : ''}
                                </div>
                              </td>
                              <td className="px-3 py-2">{r.responsible_name || '—'}</td>
                              <td className="px-3 py-2 whitespace-nowrap">
                                <div>{r.expected_payment_date ? fmtDate(r.expected_payment_date)
                                  : <span className="text-amber-700 font-semibold">No date</span>}</div>
                                {isOverdue && (
                                  <div className="text-[11px] font-semibold text-red-700">{od}d overdue</div>
                                )}
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums">{inr.format(r.principal_amount)}</td>
                              <td className="px-3 py-2 text-right tabular-nums">{inr.format(r.paid_amount)}</td>
                              <td className={`px-3 py-2 text-right tabular-nums font-semibold ${r.balance_amount > 0 ? 'text-[#af4408]' : 'text-emerald-700'}`}>
                                {inr.format(r.balance_amount)}
                              </td>
                              <td className="px-3 py-2">
                                <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${
                                  r.followup_state === 'missed' ? 'bg-red-50 border-red-200 text-red-800'
                                  : r.followup_state === 'due' ? 'bg-amber-50 border-amber-200 text-amber-900'
                                  : r.followup_state === 'overdue' ? 'bg-orange-50 border-orange-200 text-orange-900'
                                  : 'bg-[#FFF8F0] border-[#E8D5C4] text-[#6B5744]'}`}>
                                  {FOLLOWUP_LABEL[r.followup_state] || r.followup_state}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </section>

            {/* ── how a miss is counted ───────────────────────────────────── */}
            <details className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl p-3 text-[12px] text-[#6B5744]">
              <summary className="cursor-pointer font-semibold text-[#2D1B0E]">How these figures are counted</summary>
              <ul className="mt-2 space-y-1 list-disc pl-5">
                <li><b>A follow-up is MISSED</b> when the day someone promised to chase a bill has gone by and nobody wrote down what happened — the bill is still open, its expected payment date is before today, and no follow-up was recorded against that date.</li>
                <li><b>Due</b> is the same with the date being today. A due follow-up becomes missed at midnight if nothing is logged, so the two can never both count the same bill.</li>
                <li><b>Chased, still unpaid</b> is the third state: the date passed <i>and</i> somebody logged what happened. It is a different problem from a miss and is never counted as one.</li>
                <li><b>Overdue</b> counts every open bill past its date, chased or not — so an overdue bill may or may not also be a missed follow-up.</li>
                <li>All dates are read on the Indian clock, so nothing turns overdue before the day starts here.</li>
                <li><b>Payments are collections, not sales.</b> The revenue and the stock for these bills were booked when the bill was put on hold; recording a payment moves no sale and no inventory.</li>
                <li>Bills voided as a mistake are excluded from every figure.</li>
              </ul>
            </details>
          </>
        )}
      </div>
    </div>
  );
}
