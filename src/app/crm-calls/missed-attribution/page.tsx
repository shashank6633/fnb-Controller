'use client';

/**
 * CRM — Missed-Call Attribution (/crm-calls/missed-attribution). Management only.
 *
 * ── THE ONE RULE THIS PAGE EXISTS TO ENFORCE ───────────────────────────────
 * A missed call has no answering agent, so this page never prints a person's
 * name next to a miss unless the CDR itself carried one. The question it was
 * asked — "how many calls has each GRE missed?" — is not answerable from
 * telephony data: a ring group rings several handsets and the CDR records the
 * GROUP, not whose phone was in whose pocket. Answering it anyway would be a
 * personnel accusation built on a field that does not exist.
 *
 * So the page is ordered by what the data can actually support:
 *   1. BY TEAM      — the ring group that rang. The honest primary view.
 *   2. RECOVERY     — of the calls missed, how many were won back and how
 *                     long that took. The actionable number.
 *   3. BY AGENT     — only the minority of missed calls that name an agent,
 *                     under a heading that says so before the numbers appear.
 *
 * Every caveat block on this screen is load-bearing. The three counters in the
 * footer (unanswered outbound attempts, unsettled ringing rows, unmeasurable
 * recovery times) exist so that a figure can never be quietly absent — if the
 * data cannot say something, the page says that instead of showing a smaller
 * number with no explanation. Do not "tidy" them away.
 *
 * WORDS THIS PAGE DOES NOT USE: it never calls a team or an agent's number a
 * failure, a fault, or a score. The column is "Missed", the arithmetic is
 * stated, and the reader draws the conclusion.
 *
 * Gating: the route behind it (/api/crm-calls/missed-attribution) answers 403
 * to anyone outside isManagement(); the catalog entry (mgmtOnly) and the
 * Sidebar row are what stop a non-manager reaching it in the first place. A
 * 403 still renders a plain "Management only" card rather than an error.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  PhoneMissed, PhoneOutgoing, Users, Clock, RefreshCw, Lock, Info,
  ChevronLeft, AlertTriangle, CheckCircle2, Loader2, ListTree,
} from 'lucide-react';

// ── Types (mirror the API response) ─────────────────────────────────────────

interface Breakdown {
  missed: number;
  recovered: number;
  open: number;
  stalled: number;
  untracked: number;
  recovered_pct: number;
  timed: number;
  avg_minutes: number | null;
}
interface TeamRow extends Breakdown { team: string }
interface AgentRow extends Breakdown { agent: string; agent_label: string; mapped: boolean }

interface Report {
  range: { from: string; to: string; days: number; max_days: number; timezone: string };
  totals: Breakdown & {
    by_call_status: { missed: number; abandoned: number; voicemail: number };
    with_team: number; without_team: number; teams: number;
    with_agent: number; without_agent: number;
  };
  timing: {
    timed: number; untimed_recovered: number; negative_span: number; unparseable: number;
    median_minutes: number | null; avg_minutes: number | null; max_minutes: number | null;
    bands: { under_15m: number; m15_60: number; h1_4: number; h4_24: number; over_24h: number };
  };
  by_team: TeamRow[];
  by_team_truncated: boolean;
  by_agent: AgentRow[];
  by_agent_truncated: boolean;
  by_agent_coverage: { partial: boolean; attributed: number; unattributed: number; attributed_pct: number };
  outbound_unanswered: number;
  unsettled_ringing: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 330 * 60_000;

/** Today's IST calendar date — the same clock the API buckets by. */
function istToday(): string {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}
function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Minutes → "42 m" / "1 h 26 m" / "1 d 3 h". Null stays a dash. */
function fmtMinutes(mins: number | null | undefined): string {
  if (mins === null || mins === undefined || !Number.isFinite(mins)) return '—';
  const m = Math.round(mins);
  if (m < 60) return `${m} m`;
  if (m < 1440) {
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem ? `${h} h ${rem} m` : `${h} h`;
  }
  const d = Math.floor(m / 1440);
  const h = Math.round((m % 1440) / 60);
  return h ? `${d} d ${h} h` : `${d} d`;
}

const PRESETS = [
  { label: '7 days', days: 7 },
  { label: '14 days', days: 14 },
  { label: '30 days', days: 30 },
];

// ── Page ────────────────────────────────────────────────────────────────────

export default function MissedAttributionPage() {
  const today = istToday();
  const [from, setFrom] = useState(() => shiftDate(today, -6));
  const [to, setTo] = useState(today);
  const [data, setData] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  // Date pickers fire fast; without this an older window's response can land
  // after a newer one and repaint the page with the wrong range.
  const fetchSeq = useRef(0);

  const load = useCallback(async () => {
    // A half-typed or cleared date input must not silently refetch the default
    // window while the field on screen says something else. Keep what we have.
    if (!from || !to) return;
    const seq = ++fetchSeq.current;
    setFetching(true);
    setError(null);
    try {
      const sp = new URLSearchParams({ from, to });
      const res = await fetch(`/api/crm-calls/missed-attribution?${sp.toString()}`);
      if (seq !== fetchSeq.current) return;
      if (res.status === 403) { setForbidden(true); setData(null); return; }
      const json = await res.json().catch(() => ({}));
      if (seq !== fetchSeq.current) return;
      if (!res.ok) { setError(json?.error || `Couldn't load the report (HTTP ${res.status})`); return; }
      setData(json as Report);
    } catch {
      if (seq === fetchSeq.current) setError("Couldn't load the report");
    } finally {
      if (seq === fetchSeq.current) { setFetching(false); setLoading(false); }
    }
  }, [from, to]);

  useEffect(() => { load(); }, [load]);

  const applyPreset = (days: number) => {
    const end = istToday();
    setTo(end);
    setFrom(shiftDate(end, -(days - 1)));
  };

  if (forbidden) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] flex items-center justify-center p-6">
        <div className="max-w-sm text-center text-[#6B5744]">
          <Lock className="w-10 h-10 mx-auto mb-3 text-[#af4408]" />
          <h1 className="text-lg font-bold text-[#2D1B0E]">Management only</h1>
          <p className="text-sm mt-1">Missed-call attribution is restricted to managers, HODs and admins.</p>
          <Link href="/crm-calls" className="inline-block mt-4 text-sm font-semibold text-[#af4408] hover:underline">
            Back to CRM
          </Link>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] p-6 animate-pulse">
        <div className="max-w-7xl mx-auto space-y-6">
          <div className="h-9 w-80 bg-[#FFF1E3] rounded-lg" />
          <div className="h-12 w-full max-w-2xl bg-[#FFF1E3] rounded-xl" />
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            {[...Array(5)].map((_, i) => <div key={i} className="h-24 bg-white border border-[#E8D5C4] rounded-xl" />)}
          </div>
          <div className="h-64 bg-white border border-[#E8D5C4] rounded-xl" />
        </div>
      </div>
    );
  }

  const t = data?.totals;
  const timing = data?.timing;

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 py-5 sm:py-6 space-y-4">

        {/* Header */}
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-3">
          <div>
            <Link href="/crm-calls" className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider hover:text-[#af4408]">
              <ChevronLeft className="w-3.5 h-3.5" />CRM — Call-to-Table
            </Link>
            <h1 className="text-2xl sm:text-3xl font-bold mt-0.5 flex items-center gap-2.5">
              <PhoneMissed className="w-7 h-7 text-[#af4408]" />
              Missed-Call Attribution
            </h1>
            <p className="text-sm text-[#8B7355] mt-1">
              Which team rang, how many of those calls we won back, and how long it took.
            </p>
          </div>
          <button
            onClick={load}
            disabled={fetching}
            className="flex items-center gap-2 px-4 py-2.5 bg-white border border-[#E0D0BE] hover:bg-[#FFF1E3] disabled:opacity-60 text-[#6B5744] rounded-xl text-sm font-medium shadow-sm transition-colors self-start"
          >
            {fetching ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Refresh
          </button>
        </div>

        {/* Date range */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 sm:p-4 flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="ma-from" className="block text-[11px] font-semibold text-[#6B5744] uppercase tracking-wider mb-1">From</label>
            <input id="ma-from" type="date" value={from} max={to} onChange={e => setFrom(e.target.value)}
              className="px-3 py-2 border border-[#E0D0BE] rounded-lg text-sm bg-white" />
          </div>
          <div>
            <label htmlFor="ma-to" className="block text-[11px] font-semibold text-[#6B5744] uppercase tracking-wider mb-1">To</label>
            <input id="ma-to" type="date" value={to} min={from} onChange={e => setTo(e.target.value)}
              className="px-3 py-2 border border-[#E0D0BE] rounded-lg text-sm bg-white" />
          </div>
          <div className="flex items-center gap-1.5">
            {PRESETS.map(p => (
              <button key={p.days} onClick={() => applyPreset(p.days)}
                className="px-3 py-2 rounded-lg text-xs font-semibold border border-[#E0D0BE] bg-white hover:bg-[#FFF1E3] text-[#6B5744] transition-colors">
                Last {p.label}
              </button>
            ))}
          </div>
          {data && (
            <p className="text-[11px] text-[#8B7355] ml-auto">
              {data.range.days} day{data.range.days === 1 ? '' : 's'}, IST calendar days, both ends included.
              Maximum {data.range.max_days}.
            </p>
          )}
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl px-4 py-3 text-sm flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* What this report can and cannot say — first, before any number. */}
        <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl px-4 py-3 text-[13px] text-[#6B5744] flex items-start gap-2.5">
          <Info className="w-4 h-4 mt-0.5 shrink-0 text-[#af4408]" />
          <div className="space-y-1">
            <p>
              <span className="font-semibold text-[#2D1B0E]">This report cannot tell you how many calls each GRE missed.</span>{' '}
              Nobody answered a missed call, so the phone system has no agent to name on it — it records the ring
              group. Where a team rings several handsets, the data does not say whose phone rang.
            </p>
            <p>
              Counted here: <span className="font-semibold">incoming</span> calls that ended missed, abandoned or in
              voicemail. Outbound calls the guest didn&apos;t pick up are counted separately at the bottom and are
              never added in.
            </p>
          </div>
        </div>

        {t && timing && (
          <>
            {/* Headline tiles */}
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
              <Tile label="Missed (incoming)" value={t.missed} tone="amber"
                sub={`${t.by_call_status.missed} missed · ${t.by_call_status.abandoned} abandoned · ${t.by_call_status.voicemail} voicemail`} />
              <Tile label="Recovered" value={t.recovered} tone="green"
                sub={`${t.recovered_pct}% of the calls missed`} />
              <Tile label="Still open" value={t.open} tone="plain"
                sub="In the recovery queue now" />
              {/* NOT "closed". The Recovery Queue still offers Attempt, WhatsApp
                  and Mark recovered on every one of these, and 'expired' is set
                  by a clock at 2x SLA with nobody having touched the row. */}
              <Tile label="Stalled" value={t.stalled} tone="plain"
                sub="Past SLA or unreachable — still workable" />
              <Tile label="Teams involved" value={t.teams} tone="plain"
                sub={t.without_team > 0 ? `${t.without_team} call${t.without_team === 1 ? '' : 's'} name no team` : 'Every call named a team'} />
            </div>

            {/* 1 — BY TEAM */}
            <Section
              icon={<Users className="w-4 h-4 text-[#af4408]" />}
              title="Missed calls by team"
              subtitle="The ring group the phone system recorded on the call. This is what the data actually attributes a missed call to."
            >
              {data && data.by_team.length === 0 ? (
                <Empty>No incoming calls were missed in this window.</Empty>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-[42rem]">
                    <thead>
                      <tr className="text-[11px] uppercase tracking-wider text-[#6B5744] border-b border-[#F0E4D6]">
                        <Th align="left">Team</Th>
                        <Th>Missed</Th>
                        <Th>Recovered</Th>
                        <Th>Recovered %</Th>
                        <Th>Still open</Th>
                        <Th>Stalled</Th>
                        <Th>Avg time to recover</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {data?.by_team.map(row => (
                        <tr key={row.team || '(none)'} className="border-b border-[#F7EEE4] last:border-0">
                          <td className="py-2.5 pr-3 font-semibold">
                            {row.team || <span className="text-[#8B7355] italic font-normal">No team recorded</span>}
                          </td>
                          <Td>{row.missed}</Td>
                          <Td>{row.recovered}</Td>
                          <Td>{row.recovered_pct}%</Td>
                          <Td>{row.open}</Td>
                          <Td>{row.stalled}</Td>
                          <Td>
                            {fmtMinutes(row.avg_minutes)}
                            {row.timed < row.recovered && (
                              <span className="block text-[10px] text-[#8B7355]">over {row.timed} of {row.recovered}</span>
                            )}
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {data?.by_team_truncated && (
                <Note tone="warn">More teams exist than this table shows — the list is capped. Narrow the date range.</Note>
              )}
            </Section>

            {/* 2 — RECOVERY */}
            <Section
              icon={<Clock className="w-4 h-4 text-[#af4408]" />}
              title="Recovery — of the calls missed, how many came back"
              subtitle="Recovered means exactly what the Recovery Queue means by it: the callback reached the guest, or the guest rang back and we answered."
            >
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="space-y-2.5">
                  <Stat label="Recovered" value={`${t.recovered} of ${t.missed}`} strong />
                  <Stat label="Median time to recover" value={fmtMinutes(timing.median_minutes)} strong />
                  <Stat label="Average time to recover" value={fmtMinutes(timing.avg_minutes)} />
                  <Stat label="Longest" value={fmtMinutes(timing.max_minutes)} />
                  <p className="text-[12px] text-[#6B5744] bg-[#FFFBF5] border border-[#F0E4D6] rounded-lg px-3 py-2">
                    Timings cover the <span className="font-semibold">{timing.timed}</span> recovered call
                    {timing.timed === 1 ? '' : 's'} that carry a recovery timestamp.
                    {timing.untimed_recovered > 0 && (
                      <>
                        {' '}Another <span className="font-semibold">{timing.untimed_recovered}</span> closed with no
                        recovery timestamp at all — mostly the guest ringing back and us answering, which records the
                        outcome but not a time. They count as recovered and stay out of the averages.
                      </>
                    )}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold text-[#6B5744] uppercase tracking-wider mb-2">How long it took</p>
                  <div className="space-y-1.5">
                    <Band label="Under 15 minutes" n={timing.bands.under_15m} total={timing.timed} />
                    <Band label="15 – 60 minutes" n={timing.bands.m15_60} total={timing.timed} />
                    <Band label="1 – 4 hours" n={timing.bands.h1_4} total={timing.timed} />
                    <Band label="4 – 24 hours" n={timing.bands.h4_24} total={timing.timed} />
                    <Band label="Over 24 hours" n={timing.bands.over_24h} total={timing.timed} />
                  </div>
                </div>
              </div>
              {t.untracked > 0 && (
                <Note tone="warn">
                  {t.untracked} missed call{t.untracked === 1 ? ' has' : 's have'} no recovery record at all, so
                  {t.untracked === 1 ? ' it is' : ' they are'} counted as missed but not as recovered or open.
                  Two things cause this, and the second is the more likely one: a caller who withheld their number
                  cannot be queued for a callback, and a call the live feed marked missed never enters the queue if
                  its CDR never arrived. If this number is not small, check the CDR webhook before you go looking
                  for anonymous callers.
                </Note>
              )}
              {(timing.negative_span > 0 || timing.unparseable > 0) && (
                <Note tone="warn">
                  {timing.negative_span > 0 && `${timing.negative_span} recovery timestamp${timing.negative_span === 1 ? ' sits' : 's sit'} before the call it recovers. `}
                  {timing.unparseable > 0 && `${timing.unparseable} timestamp${timing.unparseable === 1 ? ' could' : 's could'} not be read. `}
                  Excluded from the timings above rather than counted as instant.
                </Note>
              )}
            </Section>

            {/* 3 — BY AGENT (partial, and says so first).
                The "partial list" half of the subtitle is conditional on the
                MEASURED coverage — the day every missed CDR names an agent,
                saying "only some" over a figure reading 100% makes the
                disclaimer visibly false and the whole warning easy to dismiss.
                The "not a per-GRE miss count" half is unconditional: a ring
                group rings several phones, and even at full coverage the id
                says whose phone rang, not who let it ring. */}
            <Section
              icon={<ListTree className="w-4 h-4 text-[#af4408]" />}
              title="Missed calls that named an agent"
              subtitle={(data?.by_agent_coverage.partial
                ? 'The phone system names an agent on only some missed calls, so this is a partial list. '
                : 'The phone system named an agent on every missed call in this window. ')
                + 'It is still not a per-GRE miss count — a ring group rings several phones at once, and the '
                + 'call record does not say who was at which one.'}
            >
              <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg px-3 py-2 text-[12px] text-[#6B5744] mb-3">
                <span className="font-semibold text-[#2D1B0E]">
                  {data?.by_agent_coverage.attributed ?? 0} of {t.missed}
                </span>{' '}
                missed calls ({data?.by_agent_coverage.attributed_pct ?? 0}%) carry an agent id.
                The remaining <span className="font-semibold">{data?.by_agent_coverage.unattributed ?? 0}</span> name
                only a team. Do not read the table below as a ranking of who let calls ring.
              </div>
              {data && data.by_agent.length === 0 ? (
                <Empty>
                  No missed call in this window named an agent. That is the normal case — nobody answered, so the
                  phone system had nobody to record. Use the team table above.
                </Empty>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-[38rem]">
                    <thead>
                      <tr className="text-[11px] uppercase tracking-wider text-[#6B5744] border-b border-[#F0E4D6]">
                        <Th align="left">Agent</Th>
                        <Th>Missed</Th>
                        <Th>Recovered</Th>
                        <Th>Recovered %</Th>
                        <Th>Still open</Th>
                        <Th>Avg time to recover</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {data?.by_agent.map(row => (
                        <tr key={row.agent} className="border-b border-[#F7EEE4] last:border-0">
                          <td className="py-2.5 pr-3 font-semibold">
                            {row.agent_label}
                            {!row.mapped && (
                              <span className="ml-2 text-[10px] font-normal text-[#8B7355] border border-[#E0D0BE] rounded px-1.5 py-0.5">
                                unmapped id
                              </span>
                            )}
                          </td>
                          <Td>{row.missed}</Td>
                          <Td>{row.recovered}</Td>
                          <Td>{row.recovered_pct}%</Td>
                          <Td>{row.open}</Td>
                          <Td>{fmtMinutes(row.avg_minutes)}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {data?.by_agent_truncated && (
                <Note tone="warn">More agents exist than this table shows — the list is capped. Narrow the date range.</Note>
              )}
              <Note>
                An agent the admin has not mapped shows as the raw id the phone system sent, never as a dash. Map ids
                to staff in <Link href="/crm-calls/settings" className="font-semibold text-[#af4408] hover:underline">CRM Call Settings</Link>.
              </Note>
            </Section>

            {/* Footer — what is deliberately not in the numbers above */}
            <Section
              icon={<PhoneOutgoing className="w-4 h-4 text-[#af4408]" />}
              title="Not counted above"
              subtitle="Kept separate so nothing is silently absent from the totals."
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[13px]">
                <div className="bg-[#FFFBF5] border border-[#F0E4D6] rounded-lg px-3 py-2.5">
                  <p className="font-semibold text-[#2D1B0E]">
                    {data?.outbound_unanswered ?? 0} outbound call{(data?.outbound_unanswered ?? 0) === 1 ? '' : 's'} the guest didn&apos;t answer
                  </p>
                  <p className="text-[#6B5744] mt-0.5">
                    We rang them and nobody picked up. Where the CDR names the GRE who dialled, that is exactly why
                    they are not in the tables above — they measure the guest&apos;s availability, not ours.
                  </p>
                </div>
                <div className="bg-[#FFFBF5] border border-[#F0E4D6] rounded-lg px-3 py-2.5">
                  <p className="font-semibold text-[#2D1B0E]">
                    {data?.unsettled_ringing ?? 0} call{(data?.unsettled_ringing ?? 0) === 1 ? '' : 's'} still marked ringing
                  </p>
                  <p className="text-[#6B5744] mt-0.5">
                    Neither answered nor missed yet, so in no bucket on this page. A call normally settles the moment
                    the phone system delivers its call record; the safety net that marks a stuck ring as missed runs
                    when someone opens the CRM dashboard or the recovery queue. A number that stays here points at a
                    delivery gap.
                  </p>
                </div>
              </div>
              <Note>
                <span className="font-semibold">Definitions.</span> Missed = an incoming call that ended missed,
                abandoned or in voicemail. Recovered = the recovery record for that call is marked recovered or was
                auto-closed by the guest calling back — the same definition the{' '}
                <Link href="/crm-calls/recovery" className="font-semibold text-[#af4408] hover:underline">Recovery Queue</Link>{' '}
                uses. Days are IST calendar days.
              </Note>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

// ── Presentational bits ─────────────────────────────────────────────────────

function Tile({ label, value, sub, tone }: { label: string; value: number; sub?: string; tone: 'amber' | 'green' | 'plain' }) {
  const valueCls = tone === 'amber' ? 'text-[#af4408]' : tone === 'green' ? 'text-emerald-700' : 'text-[#2D1B0E]';
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-3.5">
      <p className="text-[11px] font-semibold text-[#6B5744] uppercase tracking-wider">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${valueCls}`}>{value}</p>
      {sub && <p className="text-[11px] text-[#8B7355] mt-1 leading-snug">{sub}</p>}
    </div>
  );
}

function Section({ icon, title, subtitle, children }: {
  icon: React.ReactNode; title: string; subtitle: string; children: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 sm:p-5">
      <div className="mb-3">
        <h2 className="text-base font-bold flex items-center gap-2">{icon}{title}</h2>
        <p className="text-[12px] text-[#8B7355] mt-1 max-w-3xl">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

function Th({ children, align = 'right' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return <th className={`py-2 ${align === 'left' ? 'text-left pr-3' : 'text-right pl-3'} font-semibold`}>{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="py-2.5 pl-3 text-right tabular-nums">{children}</td>;
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-[#F7EEE4] pb-1.5 last:border-0">
      <span className="text-[13px] text-[#6B5744]">{label}</span>
      <span className={strong ? 'text-lg font-bold' : 'text-sm font-semibold'}>{value}</span>
    </div>
  );
}

function Band({ label, n, total }: { label: string; n: number; total: number }) {
  const width = total > 0 ? Math.round((n / total) * 100) : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-[12px] text-[#6B5744]">
        <span>{label}</span>
        <span className="tabular-nums font-semibold text-[#2D1B0E]">{n}</span>
      </div>
      <div className="h-1.5 bg-[#F7EEE4] rounded-full overflow-hidden mt-0.5">
        <div className="h-full bg-[#af4408] rounded-full" style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-[13px] text-[#6B5744] bg-[#FFFBF5] border border-[#F0E4D6] rounded-lg px-3 py-2.5">
      <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-[#8B7355]" />
      <span>{children}</span>
    </div>
  );
}

function Note({ children, tone = 'plain' }: { children: React.ReactNode; tone?: 'plain' | 'warn' }) {
  const cls = tone === 'warn'
    ? 'bg-amber-50 border-amber-200 text-amber-900'
    : 'bg-[#FFFBF5] border-[#F0E4D6] text-[#6B5744]';
  return <p className={`text-[12px] border rounded-lg px-3 py-2 mt-3 ${cls}`}>{children}</p>;
}
