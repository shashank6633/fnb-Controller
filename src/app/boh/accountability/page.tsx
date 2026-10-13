'use client';

/**
 * BILLS ON HOLD — USER-WISE ACCOUNTABILITY
 * ========================================
 *
 * The owner's stated purpose, verbatim: "identify who is actively following up
 * and where pending BOH bills are getting delayed." Those are two different
 * questions and this screen answers both in one look:
 *
 *   · WHO IS ACTIVELY FOLLOWING UP  → the two ACTIVITY columns, "Logged 30d"
 *     and "Last follow-up". They count what the person themselves wrote down,
 *     on any bill, by email. A row can carry twenty bills and still show zero
 *     here; that is the finding, not a gap.
 *   · WHERE BILLS ARE GETTING DELAYED → Pending ₹, Overdue ₹, Oldest overdue,
 *     and Missed. Sorted worst-first by money outstanding.
 *
 * ── THIS SCREEN JUDGES PEOPLE, SO EVERY NUMBER IS DEFENSIBLE ───────────────
 * Three things are on the screen itself rather than in someone's head:
 *   1. ATTRIBUTION. Assignment figures belong to the CURRENT responsible user.
 *      "Inherited" says how many of those bills were handed over by somebody
 *      else — without it, a manager can be blamed for a backlog they were given
 *      this morning. Nothing in the history is rewritten by a reassignment.
 *   2. MISSED has one definition and it is printed at the bottom of the page,
 *      word for word, in the same terms the register and the reminder job use.
 *      It comes from one place in the code and is never re-derived here.
 *   3. "No date" is a column, not a silence. A bill nobody promised a date for
 *      can never be due, overdue or missed — so it would otherwise vanish from
 *      the one screen meant to find neglected money.
 *
 * MANAGEMENT ONLY. The gate that matters is GET /api/boh/accountability's own
 * 403 (proxy.ts guards pages, not APIs, and canAccessPage fails open four ways);
 * page-catalog's mgmtOnly is the second lock, not the first.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Users, RefreshCw, Loader2, Lock, AlertTriangle, ArrowLeft, CheckCircle2,
  ArrowUpDown, TriangleAlert, PhoneOff, CalendarX2,
} from 'lucide-react';
import { api } from '@/lib/api';

interface UserRow {
  user_id: string; user_name: string; user_email: string;
  total_assigned: number; total_assigned_amount: number;
  pending_amount: number;
  overdue_count: number; overdue_amount: number; oldest_overdue_days: number;
  followups_due: number; followups_missed: number; followups_missed_amount: number;
  /** Money THIS PERSON recorded, attributed from boh_payments.created_by. */
  payments_collected: number;
  /** The different question: recovered on the bills they now hold, by anyone. */
  collected_on_assigned_bills: number;
  /** Present only because they collected — they hold no bill in this view. */
  collector_only?: boolean;
  followups_logged_30d: number; last_followup_at: string;
  inherited_count: number; no_date_count: number; contact_missing_count: number;
}

interface Payload {
  users: UserRow[];
  figures: { pending_amount: number; overdue_amount: number; followups_missed: number; total_pending_bills: number; payments_received_total: number };
  row_total: number;
  truncated: boolean;
  today: string;
  generated_at: string;
  filter_active: boolean;
  any_records: number;
}

const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = new Intl.NumberFormat('en-IN');
const money = (n: unknown) => '₹' + inr.format(Number(n) || 0);

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
/** 'datetime(now)' text from SQLite is UTC; show it on the owner's clock. */
function fmtWhen(sqlUtc: string): string {
  if (!sqlUtc) return 'Never';
  const t = Date.parse(sqlUtc.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(t)) return sqlUtc;
  const days = Math.floor((Date.now() - t) / 86_400_000);
  const d = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short',
  }).format(new Date(t));
  return days <= 0 ? `${d} (today)` : `${d} (${days}d ago)`;
}

type SortKey =
  | 'user_name' | 'total_assigned' | 'pending_amount' | 'overdue_amount'
  | 'oldest_overdue_days' | 'followups_due' | 'followups_missed'
  | 'payments_collected' | 'followups_logged_30d';

const COLS: { key: SortKey; label: string; help: string; align: 'left' | 'right' }[] = [
  { key: 'user_name', label: 'Responsible user', align: 'left', help: 'The person the bill is assigned to RIGHT NOW.' },
  { key: 'total_assigned', label: 'Assigned', align: 'right', help: 'Open bills currently assigned to them, and what those bills were worth when held.' },
  { key: 'pending_amount', label: 'Pending ₹', align: 'right', help: 'Bill total minus everything collected, across their open bills.' },
  { key: 'overdue_amount', label: 'Overdue ₹', align: 'right', help: 'Of the pending money, how much is past its expected payment date.' },
  { key: 'oldest_overdue_days', label: 'Oldest', align: 'right', help: 'How many days the oldest overdue bill has been sitting past its date.' },
  { key: 'followups_due', label: 'Due', align: 'right', help: 'Bills dated today with nothing logged yet. Still in time.' },
  { key: 'followups_missed', label: 'Missed', align: 'right', help: 'The date went by and nobody wrote down what happened. This is the accountability figure.' },
  { key: 'payments_collected', label: 'Collected ₹', align: 'right', help: 'Money THIS PERSON recorded, on any bill in this view — attributed from who entered each payment, not from who holds the bill now. A collection, never a new sale.' },
  { key: 'followups_logged_30d', label: 'Logged 30d', align: 'right', help: 'Follow-ups THIS PERSON wrote, on any bill, in the last 30 days. This is activity, not assignment.' },
];

export default function BohAccountabilityPage() {
  const [me, setMe] = useState<any | null | undefined>(undefined);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [denied, setDenied] = useState('');
  const [qs, setQs] = useState('');
  const [fetchedAt, setFetchedAt] = useState(0);
  const [nowTick, setNowTick] = useState(Date.now());
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'pending_amount', dir: 'desc' });

  const isMgmt = !!me && (me.role === 'admin' || me.role === 'manager' || !!me.is_head_chef);

  useEffect(() => {
    api('/api/auth/me').then(r => r.json()).then(j => setMe(j.user || null)).catch(() => setMe(null));
  }, []);

  // The dashboard hands its filters across in the query string so the two
  // screens can be reconciled against each other row for row.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setQs(window.location.search.replace(/^\?/, ''));
  }, []);

  const load = useCallback(async (query: string) => {
    setLoading(true); setError('');
    try {
      const r = await api(`/api/boh/accountability${query ? `?${query}` : ''}`);
      const j = await r.json();
      if (r.status === 403) { setDenied(j.error || 'Management only.'); setData(null); return; }
      if (!r.ok) { setError(j.error || `Could not load the accountability view (HTTP ${r.status}).`); return; }
      setDenied('');
      setData(j as Payload);
      setFetchedAt(Date.now());
    } catch {
      setError('Could not reach the server. Anything shown below is from the last successful load.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (isMgmt) void load(qs); }, [isMgmt, qs, load]);
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  const ageSec = fetchedAt ? Math.max(0, (nowTick - fetchedAt) / 1000) : 0;
  const stale = fetchedAt > 0 && ageSec > 300;

  const rows = useMemo(() => {
    const list = [...(data?.users || [])];
    const { key, dir } = sort;
    list.sort((a, b) => {
      const av = a[key] as any, bv = b[key] as any;
      const cmp = typeof av === 'string' ? String(av).localeCompare(String(bv)) : (Number(av) - Number(bv));
      return dir === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [data, sort]);

  const totals = useMemo(() => rows.reduce((t, r) => ({
    total_assigned: t.total_assigned + r.total_assigned,
    pending_amount: t.pending_amount + r.pending_amount,
    overdue_amount: t.overdue_amount + r.overdue_amount,
    followups_due: t.followups_due + r.followups_due,
    followups_missed: t.followups_missed + r.followups_missed,
    payments_collected: t.payments_collected + r.payments_collected,
    followups_logged_30d: t.followups_logged_30d + r.followups_logged_30d,
  }), { total_assigned: 0, pending_amount: 0, overdue_amount: 0, followups_due: 0, followups_missed: 0, payments_collected: 0, followups_logged_30d: 0 }), [rows]);

  const toggleSort = (key: SortKey) =>
    setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'user_name' ? 'asc' : 'desc' });

  if (me === undefined) {
    return <div className="min-h-screen bg-[#FFF8F0] flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-[#8B7355]" /></div>;
  }
  if (!isMgmt || denied) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] flex items-center justify-center p-6">
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 max-w-md text-center">
          <Lock className="w-10 h-10 text-[#af4408] mx-auto mb-3" />
          <h1 className="text-lg font-semibold text-[#2D1B0E] mb-1">Managers, Admins &amp; HODs only</h1>
          <p className="text-sm text-[#8B7355]">
            {denied || 'The user-wise accountability view compares what every member of staff is carrying and collecting, so it is restricted to management.'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">

        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
          <div>
            <Link href={`/boh/dashboard${qs ? `?${qs}` : ''}`}
                  className="inline-flex items-center gap-1.5 text-[12px] text-[#af4408] hover:underline">
              <ArrowLeft className="w-3.5 h-3.5" /> Back to the dashboard
            </Link>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-3 mt-1">
              <Users className="w-7 h-7" /> Bills on Hold — Who is chasing
            </h1>
            <p className="text-[#8B7355] text-sm mt-1">
              Who is carrying which bills, what has gone past its date, and who is actually writing follow-ups down.
            </p>
          </div>
          <div className="flex flex-col items-start sm:items-end gap-1.5">
            <button onClick={() => void load(qs)} disabled={loading}
                    className="inline-flex items-center gap-2 px-3 py-2 border border-[#E8D5C4] rounded-lg text-sm text-[#6B5744] hover:bg-white disabled:opacity-50">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Refresh
            </button>
            <div className={`text-[11px] px-2 py-1 rounded-md border ${
              stale ? 'bg-amber-50 border-amber-300 text-amber-900 font-semibold'
                    : 'bg-white border-[#E8D5C4] text-[#8B7355]'}`}>
              {fetchedAt === 0 ? 'Not counted yet'
                : <>Counted at {fmtClockIST(data?.generated_at || '')} IST · {fmtAge(ageSec)}{stale ? ' · may be out of date, refresh' : ''}</>}
            </div>
          </div>
        </div>

        {qs && (
          <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl p-3 text-[12px] text-[#6B5744] flex items-center justify-between gap-2">
            <span>These figures are narrowed by the filters carried over from the dashboard.</span>
            <button onClick={() => setQs('')} className="text-[#af4408] font-semibold hover:underline">Show everyone</button>
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-[13px] text-red-900 flex gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {error}
          </div>
        )}
        {data?.truncated && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-[13px] text-amber-900 flex gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            More bills match than this screen reads in one pass — the per-user figures cover only what was read.
          </div>
        )}

        {loading && !data ? (
          <div className="flex items-center justify-center py-16 text-[#8B7355]"><Loader2 className="w-6 h-6 animate-spin" /></div>
        ) : !data ? null : rows.length === 0 ? (
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center">
            <CheckCircle2 className="w-10 h-10 text-emerald-600 mx-auto mb-3" />
            {data.any_records === 0 ? (
              <>
                <p className="font-semibold text-[#2D1B0E]">Nothing is on hold.</p>
                <p className="text-sm text-[#8B7355] mt-1">
                  No bill has been placed on hold yet, so there is nobody to hold accountable. A BOH record opens
                  automatically the moment a bill is put on hold at the Cashier screen.
                </p>
              </>
            ) : data.filter_active ? (
              <>
                <p className="font-semibold text-[#2D1B0E]">No bill matches these filters.</p>
                <p className="text-sm text-[#8B7355] mt-1">
                  {int.format(data.any_records)} BOH record{data.any_records === 1 ? '' : 's'} exist in total.
                </p>
                <button onClick={() => setQs('')}
                        className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#E8D5C4] text-sm text-[#6B5744] hover:bg-[#FFF8F0]">
                  Show everyone
                </button>
              </>
            ) : (
              /* Records exist but none for the outlet now selected — saying
                 "nothing is pending" would be a false all-clear. */
              <>
                <p className="font-semibold text-[#2D1B0E]">No bill is on hold for this outlet.</p>
                <p className="text-sm text-[#8B7355] mt-1">
                  Nobody here is carrying a bill on hold. Records against another outlet are not shown —
                  switch outlet to see them.
                </p>
              </>
            )}
          </div>
        ) : (
          <>
            {/* Headline, so the table can be checked against one number */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-[#8B7355]">People carrying bills</div>
                <div className="text-xl font-bold mt-1 tabular-nums">{int.format(rows.length)}</div>
              </div>
              <div className={`rounded-xl border p-3 ${totals.pending_amount > 0 ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-white border-[#E8D5C4]'}`}>
                <div className="text-[11px] font-semibold uppercase tracking-wide opacity-70">Pending across everyone</div>
                <div className="text-xl font-bold mt-1 tabular-nums">{money(totals.pending_amount)}</div>
              </div>
              <div className={`rounded-xl border p-3 ${totals.overdue_amount > 0 ? 'bg-red-50 border-red-200 text-red-900' : 'bg-white border-[#E8D5C4]'}`}>
                <div className="text-[11px] font-semibold uppercase tracking-wide opacity-70">Overdue across everyone</div>
                <div className="text-xl font-bold mt-1 tabular-nums">{money(totals.overdue_amount)}</div>
              </div>
              <div className={`rounded-xl border p-3 ${totals.followups_missed > 0 ? 'bg-red-50 border-red-200 text-red-900' : 'bg-emerald-50 border-emerald-200 text-emerald-900'}`}>
                <div className="text-[11px] font-semibold uppercase tracking-wide opacity-70">Missed follow-ups</div>
                <div className="text-xl font-bold mt-1 tabular-nums">{int.format(totals.followups_missed)}</div>
              </div>
            </div>

            <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-[#FFF1E3] text-[#6B5744]">
                    <tr>
                      {COLS.map(c => (
                        <th key={c.key} title={c.help}
                            className={`px-3 py-2 font-semibold whitespace-nowrap ${c.align === 'right' ? 'text-right' : 'text-left'}`}>
                          <button onClick={() => toggleSort(c.key)}
                                  className={`inline-flex items-center gap-1 hover:text-[#af4408] ${sort.key === c.key ? 'text-[#af4408]' : ''}`}>
                            {c.label}
                            <ArrowUpDown className="w-3 h-3 opacity-60" />
                          </button>
                        </th>
                      ))}
                      <th className="px-3 py-2 font-semibold text-left whitespace-nowrap"
                          title="The most recent follow-up this person logged, anywhere.">Last follow-up</th>
                      <th className="px-3 py-2 font-semibold text-left whitespace-nowrap"
                          title="Facts that keep the rest of the row fair: bills handed over from somebody else, bills with no promised date, bills with no phone number.">Context</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => (
                      <tr key={r.user_id || r.user_name} className="border-t border-[#F0E4D8]">
                        <td className="px-3 py-2">
                          <div className="font-semibold">{r.user_name}</div>
                          {r.user_email && <div className="text-[11px] text-[#8B7355]">{r.user_email}</div>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          <div>{int.format(r.total_assigned)}</div>
                          <div className="text-[11px] text-[#8B7355]">{inr.format(r.total_assigned_amount)}</div>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums font-semibold">{inr.format(r.pending_amount)}</td>
                        <td className={`px-3 py-2 text-right tabular-nums ${r.overdue_amount > 0 ? 'text-red-700 font-semibold' : ''}`}>
                          {inr.format(r.overdue_amount)}
                          {r.overdue_count > 0 && <div className="text-[11px] font-normal text-[#8B7355]">{int.format(r.overdue_count)} bill{r.overdue_count === 1 ? '' : 's'}</div>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {r.oldest_overdue_days > 0
                            ? <span className="text-red-700 font-semibold">{r.oldest_overdue_days}d</span>
                            : <span className="text-[#B9A48F]">—</span>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {r.followups_due > 0
                            ? <span className="inline-block px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-900 font-semibold">{int.format(r.followups_due)}</span>
                            : <span className="text-[#B9A48F]">0</span>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {r.followups_missed > 0 ? (
                            <>
                              <span className="inline-block px-2 py-0.5 rounded-full bg-red-50 border border-red-200 text-red-800 font-semibold">{int.format(r.followups_missed)}</span>
                              <div className="text-[11px] text-[#8B7355] mt-0.5">{inr.format(r.followups_missed_amount)} unchased</div>
                            </>
                          ) : <span className="text-emerald-700 font-semibold">0</span>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {inr.format(r.payments_collected)}
                          {/* The other question, when the two answers differ:
                              money recovered on the bills they now hold, taken
                              by anyone. Shown only when it is NOT the same
                              number, so an ordinary row stays one figure. */}
                          {Math.abs(r.collected_on_assigned_bills - r.payments_collected) > 0.005 && (
                            <div className="text-[11px] font-normal text-[#8B7355]" title="Recovered on the bills this person now holds, whoever took the money.">
                              {inr.format(r.collected_on_assigned_bills)} on their bills
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {r.followups_logged_30d > 0
                            ? int.format(r.followups_logged_30d)
                            : <span className="text-amber-700 font-semibold" title="Nothing written down in 30 days.">0</span>}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap text-[12px] text-[#6B5744]">{fmtWhen(r.last_followup_at)}</td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            {r.collector_only && (
                              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full border border-sky-200 bg-sky-50 text-sky-900"
                                    title="This person holds no bill in this view. They are listed because they collected money on a bill that has since been handed on or closed — dropping them would lose that collection from the table.">
                                collected only
                              </span>
                            )}
                            {r.inherited_count > 0 && (
                              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full border border-[#E8D5C4] bg-[#FFF8F0] text-[#6B5744]"
                                    title="Bills handed to this person by somebody else. The earlier owner is kept in the bill's history.">
                                {r.inherited_count} inherited
                              </span>
                            )}
                            {r.no_date_count > 0 && (
                              <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border border-amber-200 bg-amber-50 text-amber-900"
                                    title="Open bills with no expected payment date. They cannot be due, overdue or missed — so they are counted nowhere else on this row.">
                                <CalendarX2 className="w-3 h-3" /> {r.no_date_count} no date
                              </span>
                            )}
                            {r.contact_missing_count > 0 && (
                              <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border border-amber-200 bg-amber-50 text-amber-900"
                                    title="Open bills with no customer phone number — this person cannot chase them at all.">
                                <PhoneOff className="w-3 h-3" /> {r.contact_missing_count} no number
                              </span>
                            )}
                            {r.inherited_count === 0 && r.no_date_count === 0 && r.contact_missing_count === 0 && (
                              <span className="text-[11px] text-[#B9A48F]">—</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-[#FFF1E3] text-[#2D1B0E] font-semibold">
                    <tr className="border-t-2 border-[#E8D5C4]">
                      <td className="px-3 py-2">All {int.format(rows.length)} people</td>
                      <td className="px-3 py-2 text-right tabular-nums">{int.format(totals.total_assigned)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{inr.format(totals.pending_amount)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{inr.format(totals.overdue_amount)}</td>
                      <td className="px-3 py-2" />
                      <td className="px-3 py-2 text-right tabular-nums">{int.format(totals.followups_due)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{int.format(totals.followups_missed)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{inr.format(totals.payments_collected)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{int.format(totals.followups_logged_30d)}</td>
                      <td className="px-3 py-2" colSpan={2} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl p-3 text-[12px] text-[#6B5744] space-y-2">
              <p className="font-semibold text-[#2D1B0E] flex items-center gap-1.5">
                <TriangleAlert className="w-4 h-4 text-[#af4408]" /> Read this before using the Missed column about a person
              </p>
              <ul className="space-y-1 list-disc pl-5">
                <li><b>MISSED</b> means the day someone promised to chase a bill has gone by and nobody wrote down what happened: the bill is still open, its expected payment date is before today, and no follow-up was recorded against <i>that date</i>. A follow-up logged early still counts — it is matched to the date it answered, not to the day it was typed.</li>
                <li>A date that passed <b>and was chased</b> is not a miss. It shows as pending and overdue money, never in this column.</li>
                <li>Every assigned figure belongs to the person the bill is assigned to <b>right now</b>. Check the <b>inherited</b> badge before drawing a conclusion — a bill handed over this morning carries its whole history with it, and none of that history is rewritten by the hand-over.</li>
                <li><b>Logged 30d</b> and <b>Last follow-up</b> are attributed differently on purpose: they count what the person themselves wrote, on any bill. Somebody with bills but a zero here is not following up, whatever the rest of the row says.</li>
                <li>Bills with <b>no date</b> or <b>no number</b> cannot be chased and cannot be missed. They are badged rather than counted, because holding someone to a date nobody set, or a customer nobody has a number for, is not accountability.</li>
                <li>All dates are read on the Indian clock.</li>
              </ul>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
