'use client';

/**
 * CRM — Call-to-Table · Dashboard (/crm-calls)
 *
 * Read-only analytics over the ct_ tables via GET /api/crm-calls/dashboard.
 * Sections (master spec 5.6):
 *   · Today stat bar — calls / answered % / missed / bookings-from-calls +
 *     pending-recoveries chip (links to the Recovery Queue, 🔴 when any
 *     open recovery has breached its SLA — computed from the recoveries
 *     queue's sla_state).
 *   · Conversion funnel  Calls → Answered → Booking → Seated
 *   · Recovery funnel    Missed → Attempted → Recovered → Booked
 *   · Call volume by IST day (stacked CSS bars, no chart lib) + hour heat strip
 *   · GRE leaderboard (calls handled, bookings, recoveries, avg callback)
 *   · Lapsed guests win-back widget (links into Guest 360)
 *
 * Data refetches on window focus so the numbers stay honest when a GRE
 * tabs back after working the queue. All timestamps from the API are UTC
 * ISO; day/hour buckets are already IST on the server.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { formatPhone } from '@/lib/ct/phone';
import {
  AlertTriangle,
  BarChart3,
  CalendarCheck,
  ChevronRight,
  Clock3,
  Phone,
  PhoneMissed,
  PhoneOutgoing,
  TrendingUp,
  Trophy,
  UserX,
} from 'lucide-react';

// ─── API shapes (mirror src/lib/ct/metrics.ts DashboardStats) ───────────────

interface TodayStats {
  calls: number;
  answered: number;
  missed: number;
  answered_pct: number;        // 0–100
  pending_recoveries: number;  // current pending|attempting
  bookings_from_calls: number;
}
interface DayPoint { date: string; total: number; answered: number; missed: number }
interface HourPoint { hour: number; total: number; missed: number }
interface FunnelStats { calls: number; answered: number; booked: number; seated: number }
interface RecoveryFunnelStats { missed: number; attempted: number; recovered: number; booked: number }
interface AgentStat {
  agent: string;
  agent_display?: string;
  handled: number;
  bookings: number;
  recoveries_handled: number;
  avg_callback_min: number;
}
interface LapsedGuest { guest_id: string; name: string; phone_e164: string; last_visit_at: string | null }

interface DashboardStats {
  today: TodayStats;
  byDay: DayPoint[];
  byHour: HourPoint[];
  funnel: FunnelStats;
  recoveryFunnel: RecoveryFunnelStats;
  agents: AgentStat[];
  avg_time_to_first_callback_min: number;
  missed_rate: number;   // 0–100
  recovery_rate: number; // 0–100
  lapsed: LapsedGuest[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-07-18…" → "18 Jul" (string math only — no timezone surprises). */
function shortDate(dateStr: string | null | undefined): string {
  const s = (dateStr || '').slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return s || '—';
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] || ''}`;
}

function fmtNum(n: number): string {
  return (Number(n) || 0).toLocaleString('en-IN');
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function CrmDashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [breached, setBreached] = useState(0);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [dRes, rRes] = await Promise.all([
        fetch(`/api/crm-calls/dashboard?days=${days}`),
        // Default queue = pending+attempting rows, each carrying sla_state.
        fetch('/api/crm-calls/recoveries'),
      ]);
      if (dRes.ok) {
        const j = (await dRes.json()) as DashboardStats;
        if (j && j.today) { setStats(j); setFailed(false); }
      } else if (!silent) {
        setFailed(true);
      }
      if (rRes.ok) {
        const j = (await rRes.json()) as { recoveries?: { sla_state?: string }[] };
        const rows = Array.isArray(j?.recoveries) ? j.recoveries : [];
        setBreached(rows.filter(r => r?.sla_state === 'breached').length);
      }
    } catch {
      if (!silent) setFailed(true);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [days]);

  useEffect(() => { load(); }, [load]);

  // Refetch (silently) whenever the tab regains focus.
  useEffect(() => {
    const onFocus = () => load(true);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const maxDay = useMemo(
    () => Math.max(1, ...(stats?.byDay || []).map(d => d.total)),
    [stats]
  );
  const maxHour = useMemo(
    () => Math.max(1, ...(stats?.byHour || []).map(h => h.total)),
    [stats]
  );

  if (loading && !stats) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] p-6 animate-pulse">
        <div className="max-w-[100rem] mx-auto space-y-5">
          <div className="h-9 w-64 bg-[#FFF1E3] rounded-lg" />
          <div className="h-24 bg-white border border-[#E8D5C4] rounded-2xl" />
          <div className="grid md:grid-cols-2 gap-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="bg-white border border-[#E8D5C4] rounded-xl h-64" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] p-6">
        <div className="max-w-xl mx-auto mt-16 bg-white border border-[#E8D5C4] rounded-xl p-8 text-center">
          <AlertTriangle className="w-8 h-8 text-amber-500 mx-auto" />
          <p className="mt-3 font-semibold text-[#2D1B0E]">
            {failed ? 'Could not load the CRM dashboard' : 'No dashboard data yet'}
          </p>
          <p className="mt-1 text-sm text-[#8B7355]">Check that you are signed in, then try again.</p>
          <button
            onClick={() => load()}
            className="mt-5 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-xl text-sm font-semibold transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const { today, funnel, recoveryFunnel } = stats;

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-[100rem] mx-auto px-3 sm:px-6 py-5 sm:py-6 space-y-4 sm:space-y-5">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">CRM — Call-to-Table</p>
            <h1 className="text-2xl sm:text-3xl font-bold mt-0.5">Dashboard</h1>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded-xl border border-[#E0D0BE] bg-white overflow-hidden shadow-sm">
              {[7, 30].map(d => (
                <button
                  key={d}
                  onClick={() => setDays(d)}
                  className={`px-3.5 py-2 text-sm font-medium transition-colors ${
                    days === d ? 'bg-[#af4408] text-white' : 'text-[#6B5744] hover:bg-[#FFF1E3]'
                  }`}
                >
                  {d}d
                </button>
              ))}
            </div>
            <Link
              href="/crm-calls/recovery"
              className="flex items-center gap-2 px-3 sm:px-4 py-2 bg-white border border-[#E0D0BE] hover:border-[#af4408] hover:bg-[#FFF1E3] rounded-xl text-sm font-medium text-[#af4408] shadow-sm transition-colors"
            >
              <PhoneMissed className="w-4 h-4" />
              <span className="hidden sm:inline">Recovery Queue</span>
              <span className="sm:hidden">Recovery</span>
              {today.pending_recoveries > 0 && (
                <span className={`min-w-5 h-5 px-1.5 inline-flex items-center justify-center rounded-full text-[11px] font-bold text-white ${breached > 0 ? 'bg-red-500' : 'bg-amber-500'}`}>
                  {today.pending_recoveries}
                </span>
              )}
            </Link>
          </div>
        </div>

        {/* Today stat bar */}
        <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm overflow-hidden grid grid-cols-2 sm:grid-cols-5">
          <Stat icon={<Phone className="w-3.5 h-3.5" />} label="Calls Today" value={fmtNum(today.calls)} className="text-[#2D1B0E]" />
          <Stat icon={<PhoneOutgoing className="w-3.5 h-3.5" />} label="Answered" value={`${today.answered_pct}%`} sub={`${fmtNum(today.answered)} calls`} className="text-green-600" />
          <Stat icon={<PhoneMissed className="w-3.5 h-3.5" />} label="Missed Today" value={fmtNum(today.missed)} className={today.missed > 0 ? 'text-red-500' : 'text-[#2D1B0E]'} />
          <Stat icon={<CalendarCheck className="w-3.5 h-3.5" />} label="Bookings from Calls" value={fmtNum(today.bookings_from_calls)} className="text-[#af4408]" />
          {/* Pending recoveries chip → Recovery Queue */}
          <Link
            href="/crm-calls/recovery"
            className="px-2 sm:px-3 py-3 text-center border-r border-b sm:border-b-0 border-[#F0E4D6] hover:bg-[#FFF8F0] transition-colors col-span-2 sm:col-span-1"
            title="Open Recovery Queue"
          >
            <p className="text-[10px] sm:text-[11px] text-[#8B7355] uppercase tracking-wide truncate flex items-center justify-center gap-1">
              <PhoneMissed className="w-3.5 h-3.5" /> Pending Recoveries
            </p>
            <p className={`text-xl sm:text-2xl font-bold mt-1 ${today.pending_recoveries > 0 ? 'text-amber-600' : 'text-green-600'}`}>
              {breached > 0 && <span aria-hidden className="mr-1 text-base align-middle">🔴</span>}
              {fmtNum(today.pending_recoveries)}
            </p>
            <p className={`text-[11px] mt-0.5 ${breached > 0 ? 'text-red-600 font-semibold' : 'text-[#B9A48C]'}`}>
              {breached > 0 ? `${breached} breached SLA` : today.pending_recoveries > 0 ? 'within SLA' : 'all clear'}
            </p>
          </Link>
        </div>

        {/* SLA breach banner */}
        {breached > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 bg-red-50 border border-red-200 rounded-2xl px-4 py-3">
            <span className="flex items-center gap-2 text-sm font-semibold text-red-800">
              <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />
              {breached} missed-call {breached === 1 ? 'recovery has' : 'recoveries have'} breached the SLA
            </span>
            <Link href="/crm-calls/recovery" className="ml-auto text-sm font-medium text-[#af4408] hover:underline whitespace-nowrap">
              Work the queue →
            </Link>
          </div>
        )}

        {/* Funnels */}
        <div className="grid lg:grid-cols-2 gap-4">
          <Card icon={<TrendingUp className="w-4 h-4" />} title="Conversion Funnel" subtitle={`Inbound · last ${days} days`}>
            <FunnelChart
              stages={[
                { label: 'Calls', value: funnel.calls },
                { label: 'Answered', value: funnel.answered },
                { label: 'Booking', value: funnel.booked },
                { label: 'Seated', value: funnel.seated },
              ]}
              barClasses={['bg-[#E8D5C4]', 'bg-[#d98e5f]', 'bg-[#c4682b]', 'bg-[#af4408]']}
            />
            <p className="mt-3 pt-3 border-t border-[#F0E4D6] text-xs text-[#8B7355]">
              Missed-call rate <span className="font-semibold text-[#2D1B0E]">{stats.missed_rate}%</span> of inbound calls
            </p>
          </Card>

          <Card icon={<PhoneMissed className="w-4 h-4" />} title="Recovery Funnel" subtitle={`Missed calls · last ${days} days`}>
            <FunnelChart
              stages={[
                { label: 'Missed', value: recoveryFunnel.missed },
                { label: 'Attempted', value: recoveryFunnel.attempted },
                { label: 'Recovered', value: recoveryFunnel.recovered },
                { label: 'Booked', value: recoveryFunnel.booked },
              ]}
              barClasses={['bg-red-200', 'bg-amber-300', 'bg-emerald-400', 'bg-emerald-600']}
            />
            <p className="mt-3 pt-3 border-t border-[#F0E4D6] text-xs text-[#8B7355]">
              Recovery rate <span className="font-semibold text-[#2D1B0E]">{stats.recovery_rate}%</span>
              <span className="mx-1.5 text-[#E0D0BE]">·</span>
              Avg first callback{' '}
              <span className="font-semibold text-[#2D1B0E] inline-flex items-center gap-1">
                <Clock3 className="w-3 h-3" />{stats.avg_time_to_first_callback_min} min
              </span>
            </p>
          </Card>
        </div>

        {/* Call volume */}
        <Card icon={<BarChart3 className="w-4 h-4" />} title="Call Volume" subtitle={`By day (IST) · last ${days} days`}>
          {stats.byDay.every(d => d.total === 0) ? (
            <Empty text="No calls in this window yet." />
          ) : (
            <>
              <div className="flex items-end gap-[2px] h-36">
                {stats.byDay.map(d => {
                  const hPct = (d.total / maxDay) * 100;
                  const other = Math.max(0, d.total - d.answered - d.missed);
                  const seg = (n: number) => (d.total > 0 ? (n / d.total) * 100 : 0);
                  return (
                    <div
                      key={d.date}
                      className="flex-1 min-w-0 h-full flex flex-col justify-end"
                      title={`${shortDate(d.date)} — ${d.total} calls · ${d.answered} answered · ${d.missed} missed`}
                    >
                      <div
                        className="w-full rounded-t-sm overflow-hidden flex flex-col"
                        style={{ height: `${hPct}%`, minHeight: d.total > 0 ? '3px' : '0' }}
                      >
                        <div className="w-full bg-red-400" style={{ height: `${seg(d.missed)}%` }} />
                        <div className="w-full bg-[#E8D5C4]" style={{ height: `${seg(other)}%` }} />
                        <div className="w-full bg-[#af4408]" style={{ height: `${seg(d.answered)}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="flex gap-[2px] mt-1">
                {stats.byDay.map((d, i) => {
                  const step = stats.byDay.length > 10 ? 5 : 1;
                  const show = i % step === 0 || i === stats.byDay.length - 1;
                  return (
                    <div key={d.date} className="flex-1 min-w-0 text-center text-[9px] sm:text-[10px] text-[#B9A48C] truncate">
                      {show ? shortDate(d.date) : ''}
                    </div>
                  );
                })}
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-[11px] text-[#8B7355]">
                <LegendDot className="bg-[#af4408]" label="Answered" />
                <LegendDot className="bg-red-400" label="Missed" />
                <LegendDot className="bg-[#E8D5C4]" label="Other" />
              </div>
            </>
          )}

          {/* Hour heat strip */}
          <div className="mt-5 pt-4 border-t border-[#F0E4D6]">
            <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wide mb-2">
              By hour of day (IST) — staffing view
            </p>
            <div className="flex gap-[2px]">
              {stats.byHour.map(h => {
                const alpha = h.total > 0 ? 0.15 + (h.total / maxHour) * 0.8 : 0;
                return (
                  <div
                    key={h.hour}
                    className="flex-1 min-w-0 h-8 sm:h-9 rounded-sm relative border border-[#F0E4D6]"
                    style={{ backgroundColor: h.total > 0 ? `rgba(175, 68, 8, ${alpha})` : '#FAF3EA' }}
                    title={`${String(h.hour).padStart(2, '0')}:00 — ${h.total} calls, ${h.missed} missed`}
                  >
                    {h.missed > 0 && (
                      <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-red-500" aria-hidden />
                    )}
                  </div>
                );
              })}
            </div>
            <div className="flex gap-[2px] mt-1">
              {stats.byHour.map(h => (
                <div key={h.hour} className="flex-1 min-w-0 text-center text-[9px] text-[#B9A48C]">
                  {h.hour % 6 === 0 || h.hour === 23 ? h.hour : ''}
                </div>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-[#B9A48C]">
              Darker = more calls · <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500 align-middle" /> = missed calls in that hour
            </p>
          </div>
        </Card>

        {/* Leaderboard + lapsed guests */}
        <div className="grid lg:grid-cols-2 gap-4">
          <Card icon={<Trophy className="w-4 h-4" />} title="GRE Leaderboard" subtitle={`Last ${days} days`}>
            {stats.agents.length === 0 ? (
              <Empty text="No agent activity in this window." />
            ) : (
              <>
                {/* Desktop table */}
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-[11px] text-[#8B7355] uppercase tracking-wide border-b border-[#F0E4D6]">
                        <th className="py-2 pr-2 font-semibold">#</th>
                        <th className="py-2 pr-3 font-semibold">GRE</th>
                        <th className="py-2 pr-3 font-semibold text-right">Handled</th>
                        <th className="py-2 pr-3 font-semibold text-right">Bookings</th>
                        <th className="py-2 pr-3 font-semibold text-right">Recoveries</th>
                        <th className="py-2 font-semibold text-right">Avg Callback</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#F7EEE3]">
                      {stats.agents.map((a, i) => (
                        <tr key={a.agent} className="hover:bg-[#FFF8F0]">
                          <td className="py-2.5 pr-2"><RankBadge rank={i + 1} /></td>
                          <td className="py-2.5 pr-3 font-medium truncate max-w-[180px]">{a.agent_display || a.agent}</td>
                          <td className="py-2.5 pr-3 text-right font-semibold">{fmtNum(a.handled)}</td>
                          <td className="py-2.5 pr-3 text-right text-[#af4408] font-semibold">{fmtNum(a.bookings)}</td>
                          <td className="py-2.5 pr-3 text-right">{fmtNum(a.recoveries_handled)}</td>
                          <td className="py-2.5 text-right text-[#8B7355]">
                            {a.recoveries_handled > 0 ? `${a.avg_callback_min} min` : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {/* Mobile cards */}
                <div className="md:hidden space-y-2">
                  {stats.agents.map((a, i) => (
                    <div key={a.agent} className="flex items-center gap-3 p-3 rounded-lg border border-[#F0E4D6] bg-[#FFFDFA]">
                      <RankBadge rank={i + 1} />
                      <div className="min-w-0 flex-1">
                        <p className="font-medium truncate">{a.agent_display || a.agent}</p>
                        <p className="text-[11px] text-[#8B7355] mt-0.5">
                          {fmtNum(a.handled)} handled · {fmtNum(a.bookings)} bookings · {fmtNum(a.recoveries_handled)} recoveries
                          {a.recoveries_handled > 0 ? ` · ${a.avg_callback_min} min avg CB` : ''}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </Card>

          <Card icon={<UserX className="w-4 h-4" />} title="Lapsed Guests" subtitle="Converted, but no visit in 45+ days — win-back list">
            {stats.lapsed.length === 0 ? (
              <Empty text="No lapsed guests. Everyone converted has visited recently." />
            ) : (
              <div className="max-h-80 overflow-y-auto -mx-1 px-1 divide-y divide-[#F7EEE3]">
                {stats.lapsed.map(g => (
                  <Link
                    key={g.guest_id}
                    href={`/crm-calls/guests/${g.guest_id}`}
                    className="flex items-center gap-3 py-2.5 hover:bg-[#FFF8F0] rounded-lg px-2 -mx-2 transition-colors"
                  >
                    <GuestAvatar name={g.name || g.phone_e164} />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium truncate">{g.name || 'Unnamed guest'}</p>
                      <p className="text-xs text-[#8B7355] truncate">{formatPhone(g.phone_e164)}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-[11px] text-[#8B7355]">Last visit</p>
                      <p className="text-xs font-medium text-red-500">{g.last_visit_at ? shortDate(g.last_visit_at) : '—'}</p>
                    </div>
                    <ChevronRight className="w-4 h-4 text-[#C4B09A] shrink-0" />
                  </Link>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

// ─── Presentational bits ────────────────────────────────────────────────────

function Stat({ icon, label, value, sub, className }: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  className: string;
}) {
  return (
    <div className="px-2 sm:px-3 py-3 text-center border-r border-b sm:border-b-0 border-[#F0E4D6]">
      <p className="text-[10px] sm:text-[11px] text-[#8B7355] uppercase tracking-wide truncate flex items-center justify-center gap-1">
        {icon}{label}
      </p>
      <p className={`text-xl sm:text-2xl font-bold mt-1 ${className}`}>{value}</p>
      {sub ? <p className="text-[11px] text-[#B9A48C] mt-0.5">{sub}</p> : null}
    </div>
  );
}

function Card({ icon, title, subtitle, children }: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl shadow-sm p-4 sm:p-5">
      <div className="flex items-baseline justify-between gap-2 mb-4">
        <h2 className="text-sm font-bold text-[#2D1B0E] flex items-center gap-2">
          <span className="text-[#af4408]">{icon}</span>{title}
        </h2>
        {subtitle ? <p className="text-[11px] text-[#B9A48C] truncate">{subtitle}</p> : null}
      </div>
      {children}
    </div>
  );
}

/**
 * Horizontal funnel — each stage a bar sized against the widest stage,
 * with % of stage 1 and step-conversion % vs the previous stage.
 */
function FunnelChart({ stages, barClasses }: {
  stages: { label: string; value: number }[];
  barClasses: string[];
}) {
  const max = Math.max(1, ...stages.map(s => s.value));
  const first = stages[0]?.value || 0;
  if (stages.every(s => s.value === 0)) return <Empty text="No data in this window yet." />;
  return (
    <div className="space-y-2.5">
      {stages.map((s, i) => {
        const width = Math.max(s.value > 0 ? 2 : 0, (s.value / max) * 100);
        const ofFirst = first > 0 ? Math.round((s.value / first) * 100) : 0;
        const prev = i > 0 ? stages[i - 1].value : 0;
        const step = i > 0 && prev > 0 ? Math.round((s.value / prev) * 100) : null;
        return (
          <div key={s.label}>
            <div className="flex items-baseline justify-between text-xs mb-1">
              <span className="font-medium text-[#6B5744]">{s.label}</span>
              <span className="text-[#8B7355]">
                <span className="font-bold text-[#2D1B0E]">{fmtNum(s.value)}</span>
                <span className="ml-1.5">{i === 0 ? '100%' : `${ofFirst}%`}</span>
                {step !== null && <span className="ml-1.5 text-[10px] text-[#B9A48C]">({step}% of prev)</span>}
              </span>
            </div>
            <div className="h-5 bg-[#FAF3EA] rounded-md overflow-hidden">
              <div
                className={`h-full rounded-md transition-all ${barClasses[i] || 'bg-[#af4408]'}`}
                style={{ width: `${width}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RankBadge({ rank }: { rank: number }) {
  const tone =
    rank === 1 ? 'bg-amber-100 text-amber-700 border-amber-300'
    : rank === 2 ? 'bg-gray-100 text-gray-600 border-gray-300'
    : rank === 3 ? 'bg-orange-50 text-orange-700 border-orange-200'
    : 'bg-white text-[#8B7355] border-[#E8D5C4]';
  return (
    <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full border text-[11px] font-bold shrink-0 ${tone}`}>
      {rank}
    </span>
  );
}

function GuestAvatar({ name }: { name: string }) {
  const initials = (name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0])
    .join('')
    .toUpperCase() || '?';
  return (
    <div className="w-9 h-9 rounded-full bg-[#F3E2D0] text-[#a8632b] flex items-center justify-center text-[11px] font-bold shrink-0">
      {initials}
    </div>
  );
}

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`w-2.5 h-2.5 rounded-sm ${className}`} />{label}
    </span>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="py-8 text-center text-sm text-[#B9A48C]">{text}</p>;
}
