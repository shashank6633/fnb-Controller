'use client';

/**
 * CRM — Scheduled WhatsApp Reports (/crm-calls/reports). Management reads;
 * only an admin may change anything.
 *
 * ── WHAT THIS PAGE IS FOR, AND WHAT IT IS NOT ───────────────────────────────
 * It is the switchboard for reports that leave the building on their own: the
 * daily ops PDF, the stock differences, the CRM overview, and the three alerts
 * that fire off a business action. It is NOT the WhatsApp settings page — that
 * one owns the provider credentials, the master switch and the Notifications
 * tab, and nothing here writes a key it owns. The separation is deliberate:
 * saving the Notifications tab REBUILDS `wa_notify_recipients` wholesale, which
 * is the documented way a recipient list has silently vanished in this app
 * before. Report recipients live under wa_report_<key>_* where that save cannot
 * reach them.
 *
 * ── THE ONE THING THIS PAGE REFUSES TO HIDE ─────────────────────────────────
 * A recipient group is not a promise that anyone will receive anything. Tick
 * "Management" and the preview resolves it, right there, to names and numbers —
 * AND to the people it could not reach, in amber, by name. An admin who saves
 * without looking still gets told on the row ("2 unreachable"). The failure
 * this exists to prevent is the quiet one: a tidy green tick, a saved setting,
 * and three people who never receive a report because nobody ever put a number
 * against their login.
 *
 * ── SEND TEST GOES TO YOU ───────────────────────────────────────────────────
 * Always, and only. The number comes from your own login, server-side; the
 * button sends no destination and the API accepts none. See the route.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ChevronLeft, ChevronDown, ChevronRight, Send, Save, Clock, Users, FileText,
  AlertTriangle, CheckCircle2, Loader2, Lock, Info, Phone, Zap, CalendarClock,
  XCircle, Ban, RefreshCw, Play, IndianRupee,
} from 'lucide-react';
import Toggle from '@/components/Toggle';
// EVERY WRITE FROM THIS PAGE GOES THROUGH api(), NOT bare fetch(). proxy.ts
// enforces a CSRF header on POST/PUT/PATCH/DELETE, so a plain fetch() is
// refused 403 — which is how the first cut of this page shipped a Save button
// that silently did nothing. GETs stay on fetch(): they carry no token and need
// none.
import { api } from '@/lib/api';

/* ── Types (mirror /api/crm-calls/reports/config) ──────────────────────────── */

interface Resolved {
  recipients: Array<{ number: string; label: string; via: string; source: string; userId: string }>;
  unreachable: Array<{ userId: string; name: string; via: string; reason: string }>;
  empty_tokens: string[];
  capped: boolean;
  count: number;
}

interface RunRow {
  id: number; report_key: string; outlet_id: string; run_date: string; period: string;
  status: string; detail: string; recipients: string; sent_count: number;
  failed_count: number; file_id: number | null; trigger_source: string;
  actor: string; attempts: number; claimed_at: string; finished_at: string;
}

/* What a report will cost — mirrors src/lib/wa-report-cost.ts. */
interface CostLine {
  key: string; label: string; kind: 'scheduled' | 'event';
  audience: 'management' | 'guest';
  enabled: boolean; recipients: number; outlets: number;
  per_send: number; per_day: number; ceiling: boolean; daily_cap: number | null;
  cost_per_day: number; cost_per_month: number; basis: string;
}

interface CostEstimate {
  rate: number; rate_source: string; month_days: number; max_daily_cap: number;
  lines: CostLine[];
  messages_per_day: number; cost_per_day: number; cost_per_month: number;
  potential_messages_per_day: number; potential_cost_per_month: number;
}

interface ReportRow {
  key: string; label: string; kind: 'scheduled' | 'event';
  audience_kind: 'management' | 'guest';
  attachment: 'never' | 'always' | 'sometimes';
  template_category: string; param_order: string[];
  unimplemented: boolean; unimplemented_reason: string;
  scheduled: boolean;
  config: {
    enabled: boolean; recipients: string[]; audience: string[];
    template: string; lang: string; offset_days: number; time: string; outlets: string[];
    daily_cap: number;
  };
  /** Messages this alert has already had billed today (IST). */
  sent_today: number;
  resolved: Resolved | null;
  runs_for_outlets: string[];
  last_run: RunRow | null;
  history: RunRow[];
  next_due: string;
}

interface Payload {
  reports: ReportRow[];
  outlets: Array<{ id: string; name: string; is_default: number }>;
  audience_options: {
    groups: Array<{ token: string; label: string; count: number }>;
    users: Array<{ token: string; label: string; number: string; source: string; role: string }>;
  };
  cost: CostEstimate;
  max_recipients: number;
  max_daily_cap: number;
  default_time: string;
  ist_now: string;
  ist_date: string;
  can_edit: boolean;
}

type Draft = ReportRow['config'];

/* ── Small shared bits ─────────────────────────────────────────────────────── */

const CARD = 'bg-white border border-[#E8D5C4] rounded-xl';
const BTN = 'inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

/** ₹, the way the broadcast page writes it — the two must read alike. */
const money = (n: number) =>
  `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * WHAT THIS WILL COST — the panel that was missing.
 *
 * Every message here is a billable Meta template conversation. This page arms
 * standing daily traffic across every outlet, and used to say only "N
 * recipients" while doing it — the broadcast page beside it has always shown
 * the money. Figures come from the server (src/lib/wa-report-cost.ts) at the
 * rate the broadcast rail bills against, so the two screens cannot disagree.
 */
function CostPanel({ cost }: { cost: CostEstimate }) {
  const on = cost.lines.filter(l => l.enabled);
  const off = cost.lines.filter(l => !l.enabled);
  return (
    <div className={`${CARD} p-4`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-sm font-bold uppercase tracking-wider text-[#8B7355] flex items-center gap-2">
          <IndianRupee className="w-4 h-4" />What this costs
        </h2>
        <span className="text-[11px] text-[#8B7355]">
          {money(cost.rate)}/message · {cost.rate_source}
        </span>
      </div>

      <div className="mt-3 grid sm:grid-cols-3 gap-3">
        <div className="rounded-lg border border-[#E8D5C4] bg-[#FFFDFA] p-3">
          <div className="text-[11px] uppercase tracking-wider text-[#8B7355]">Switched on now</div>
          <div className="text-xl font-bold">{money(cost.cost_per_month)}<span className="text-xs font-normal text-[#8B7355]"> / month</span></div>
          <div className="text-[11px] text-[#6B5744]">
            {cost.messages_per_day} message(s)/day · {money(cost.cost_per_day)}/day · {cost.month_days}-day month
          </div>
        </div>
        <div className="rounded-lg border border-[#E8D5C4] bg-[#FFFDFA] p-3">
          <div className="text-[11px] uppercase tracking-wider text-[#8B7355]">If everything here were on</div>
          <div className="text-xl font-bold">{money(cost.potential_cost_per_month)}<span className="text-xs font-normal text-[#8B7355]"> / month</span></div>
          <div className="text-[11px] text-[#6B5744]">{cost.potential_messages_per_day} message(s)/day at most</div>
        </div>
        <div className="rounded-lg border border-[#E8D5C4] bg-[#FFFDFA] p-3">
          <div className="text-[11px] uppercase tracking-wider text-[#8B7355]">How it adds up</div>
          <div className="text-[11px] text-[#6B5744] leading-relaxed">
            A scheduled report costs <strong>recipients × outlets</strong>, once a day. An event alert is
            counted at its <strong>enforced daily cap</strong> — the most it can cost, however busy the day.
          </div>
        </div>
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-[#8B7355] text-left">
            <tr>
              <th className="py-1 pr-3">Report</th><th className="pr-3">Messages/day</th>
              <th className="pr-3">Per day</th><th className="pr-3">Per month</th><th>How</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#F0E4D6]">
            {[...on, ...off].map(l => (
              <tr key={l.key} className={l.enabled ? '' : 'opacity-55'}>
                <td className="py-1 pr-3 whitespace-nowrap font-medium">
                  {l.label}
                  {!l.enabled && <span className="ml-1.5 text-[10px] uppercase tracking-wider text-[#8B7355]">off</span>}
                </td>
                <td className="pr-3 whitespace-nowrap">{l.ceiling ? 'up to ' : ''}{l.per_day}</td>
                <td className="pr-3 whitespace-nowrap">{l.ceiling ? 'up to ' : ''}{money(l.cost_per_day)}</td>
                <td className="pr-3 whitespace-nowrap font-semibold">{l.ceiling ? 'up to ' : ''}{money(l.cost_per_month)}</td>
                <td className="text-[#6B5744]">{l.basis}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-[#8B7355] mt-2">
        A projection, not an invoice: a {cost.month_days}-day month at the rate configured for broadcasts. Reports that
        find nothing to say are skipped and cost nothing, so a real month is usually lower than the figure above.
      </p>
    </div>
  );
}

function StatusPill({ run }: { run: RunRow | null }) {
  if (!run) {
    return <span className="text-xs text-[#8B7355] italic">never run</span>;
  }
  const map: Record<string, { bg: string; fg: string; icon: React.ReactNode; text: string }> = {
    sent: { bg: 'bg-[#E8F5E9]', fg: 'text-[#1B5E20]', icon: <CheckCircle2 className="w-3.5 h-3.5" />, text: 'sent' },
    partial: { bg: 'bg-[#FFF3E0]', fg: 'text-[#E65100]', icon: <AlertTriangle className="w-3.5 h-3.5" />, text: 'partly sent' },
    failed: { bg: 'bg-[#FFEBEE]', fg: 'text-[#B71C1C]', icon: <XCircle className="w-3.5 h-3.5" />, text: 'failed' },
    refused: { bg: 'bg-[#FFEBEE]', fg: 'text-[#B71C1C]', icon: <Ban className="w-3.5 h-3.5" />, text: 'refused' },
    error: { bg: 'bg-[#FFEBEE]', fg: 'text-[#B71C1C]', icon: <XCircle className="w-3.5 h-3.5" />, text: 'error' },
    nothing_to_report: { bg: 'bg-[#FFF1E3]', fg: 'text-[#6B5744]', icon: <Info className="w-3.5 h-3.5" />, text: 'nothing to report' },
    skipped: { bg: 'bg-[#FFF1E3]', fg: 'text-[#6B5744]', icon: <Clock className="w-3.5 h-3.5" />, text: 'starts tomorrow' },
    running: { bg: 'bg-[#E3F2FD]', fg: 'text-[#0D47A1]', icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />, text: 'running' },
  };
  const s = map[run.status] || { bg: 'bg-[#FFF1E3]', fg: 'text-[#6B5744]', icon: <Info className="w-3.5 h-3.5" />, text: run.status };
  const when = (run.finished_at || run.claimed_at || '').replace('T', ' ').slice(0, 16);
  return (
    <span className="inline-flex flex-col gap-0.5">
      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-semibold ${s.bg} ${s.fg}`}>
        {s.icon}{s.text}
        {run.trigger_source !== 'scheduler' && (
          <span className="opacity-70 font-normal">· {run.trigger_source}</span>
        )}
      </span>
      <span className="text-[10px] text-[#8B7355]">
        {when} UTC{run.sent_count ? ` · ${run.sent_count} sent` : ''}{run.failed_count ? ` · ${run.failed_count} failed` : ''}
      </span>
    </span>
  );
}

/* ── The page ──────────────────────────────────────────────────────────────── */

export default function ScheduledReportsPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState('');
  const [open, setOpen] = useState<string>('');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [preview, setPreview] = useState<Record<string, Resolved | null>>({});
  const [busy, setBusy] = useState<string>('');
  const [flash, setFlash] = useState<{ key: string; kind: 'ok' | 'err'; text: string } | null>(null);
  const [myNumber, setMyNumber] = useState<{ number: string; source: string } | null>(null);
  const [myDraft, setMyDraft] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/crm-calls/reports/config', { cache: 'no-store' });
      if (r.status === 401 || r.status === 403) {
        const j = await r.json().catch(() => ({}));
        setForbidden(j.error || 'Management access required.');
        setLoading(false);
        return;
      }
      const j: Payload = await r.json();
      setData(j);
      setDrafts(Object.fromEntries(j.reports.map(x => [x.key, { ...x.config }])));
      setPreview(Object.fromEntries(j.reports.map(x => [x.key, x.resolved])));
    } catch {
      setForbidden('Could not load the report settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/crm-calls/reports/numbers', { cache: 'no-store' });
        if (r.ok) { const j = await r.json(); setMyNumber({ number: j.number || '', source: j.source || '' }); setMyDraft(j.number || ''); }
      } catch { /* the panel simply does not appear */ }
    })();
  }, []);

  const setDraft = (key: string, patch: Partial<Draft>) =>
    setDrafts(d => ({ ...d, [key]: { ...d[key], ...patch } }));

  /* Resolve the DRAFT audience, so the list shown is the list that would be
   * saved — not the list that was saved last time.
   *
   * The draft is passed IN, never read from state here. Reading `drafts[key]`
   * inside this callback resolves whatever React had rendered before the tick
   * that triggered it, so the preview showed the audience as it was ONE EDIT
   * AGO — tick "Management" and it still said "Nobody". A preview that lags the
   * thing it previews is worse than none: it is confidently wrong. */
  const resolveDraft = useCallback(async (key: string, draft: Draft) => {
    try {
      const r = await api('/api/crm-calls/reports/resolve', {
        method: 'POST', body: { audience: draft.audience, manual: draft.recipients },
      });
      if (!r.ok) return;
      const next: Resolved = await r.json();
      setPreview(p => ({ ...p, [key]: next }));
    } catch { /* keep the last preview rather than blanking it */ }
  }, []);

  const save = async (key: string) => {
    if (!data?.can_edit) return;
    setBusy(key); setFlash(null);
    try {
      // The daily cap belongs to EVENT alerts only — a scheduled report already
      // sends once a day, and a guest confirmation is never capped. Sending it
      // for those would write a settings row nothing ever reads.
      const row = data.reports.find(x => x.key === key);
      const config: Partial<Draft> = { ...drafts[key] };
      if (row?.scheduled || row?.audience_kind === 'guest') delete config.daily_cap;
      const r = await api('/api/crm-calls/reports/config', {
        method: 'PUT', body: { key, config },
      });
      const j = await r.json();
      if (!r.ok) { setFlash({ key, kind: 'err', text: j.error || 'Could not save.' }); return; }
      setFlash({ key, kind: 'ok', text: j.first_send ? `Saved — first send ${j.first_send}.` : 'Saved.' });
      if (j.resolved) setPreview(p => ({ ...p, [key]: j.resolved }));
      await load();
      setOpen(key);
    } catch (e) {
      setFlash({ key, kind: 'err', text: (e as Error).message });
    } finally { setBusy(''); }
  };

  const sendTest = async (key: string) => {
    setBusy(`test:${key}`); setFlash(null);
    try {
      const r = await api('/api/crm-calls/reports/test', { method: 'POST', body: { key } });
      const j = await r.json();
      if (!r.ok) { setFlash({ key, kind: 'err', text: j.error || 'The test could not be sent.' }); return; }
      const res = j.result || {};
      setFlash({
        key, kind: j.ok ? 'ok' : 'err',
        text: j.ok
          ? `Test sent to ${j.sent_to} (${j.sent_to_name}) — and to nobody else.`
          : `Not sent — ${res.status}${res.detail ? ': ' + res.detail : ''}`,
      });
      await load();
    } catch (e) {
      setFlash({ key, kind: 'err', text: (e as Error).message });
    } finally { setBusy(''); }
  };

  const runNow = async (key: string) => {
    if (!data?.can_edit) return;
    if (!confirm('Send this report NOW, to its real recipients?')) return;
    setBusy(`run:${key}`); setFlash(null);
    try {
      const r = await api('/api/crm-calls/reports/run', { method: 'POST', body: { key } });
      const j = await r.json();
      const res = j.result || {};
      setFlash({
        key, kind: j.ok ? 'ok' : 'err',
        text: j.ok ? `Sent to ${res.sent} recipient(s).` : `${res.status || 'refused'}${res.detail ? ': ' + res.detail : (j.error ? ': ' + j.error : '')}`,
      });
      await load();
    } catch (e) {
      setFlash({ key, kind: 'err', text: (e as Error).message });
    } finally { setBusy(''); }
  };

  const saveMyNumber = async () => {
    setBusy('mynumber');
    try {
      const r = await api('/api/crm-calls/reports/numbers', { method: 'PUT', body: { mobile: myDraft } });
      const j = await r.json();
      if (!r.ok) { setFlash({ key: '_me', kind: 'err', text: j.error }); return; }
      setMyNumber({ number: j.number, source: j.source });
      setFlash({ key: '_me', kind: 'ok', text: j.number ? `Your number is ${j.number}.` : 'Your number was cleared.' });
      await load();
    } catch (e) {
      setFlash({ key: '_me', kind: 'err', text: (e as Error).message });
    } finally { setBusy(''); }
  };

  const scheduled = useMemo(() => data?.reports.filter(r => r.scheduled) || [], [data]);
  const events = useMemo(() => data?.reports.filter(r => !r.scheduled) || [], [data]);

  if (forbidden) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] flex items-center justify-center p-6">
        <div className="max-w-sm text-center text-[#6B5744]">
          <Lock className="w-10 h-10 mx-auto mb-3 text-[#af4408]" />
          <h1 className="text-lg font-bold text-[#2D1B0E]">Management only</h1>
          <p className="text-sm mt-1">{forbidden}</p>
          <Link href="/crm-calls" className="inline-block mt-4 text-sm font-semibold text-[#af4408] hover:underline">
            Back to CRM
          </Link>
        </div>
      </div>
    );
  }

  if (loading || !data) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] p-6 animate-pulse">
        <div className="max-w-6xl mx-auto space-y-4">
          <div className="h-9 w-80 bg-[#FFF1E3] rounded-lg" />
          {[...Array(4)].map((_, i) => <div key={i} className={`h-24 ${CARD}`} />)}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-6xl mx-auto px-3 sm:px-6 py-5 sm:py-6 space-y-4">

        {/* Header */}
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-3">
          <div>
            <Link href="/crm-calls" className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider hover:text-[#af4408]">
              <ChevronLeft className="w-3.5 h-3.5" />CRM — Call-to-Table
            </Link>
            <h1 className="text-2xl sm:text-3xl font-bold mt-0.5 flex items-center gap-2.5">
              <CalendarClock className="w-7 h-7 text-[#af4408]" />
              Scheduled WhatsApp Reports
            </h1>
            <p className="text-sm text-[#8B7355] mt-1">
              Each report has its own time, its own recipients and its own switch. Everything here is
              off until you turn it on. Times are IST — it is <strong>{data.ist_now}</strong> now.
            </p>
          </div>
          <button onClick={() => void load()} className={`${BTN} bg-white border border-[#E0D0BE] hover:bg-[#FFF1E3] text-[#6B5744] self-start`}>
            <RefreshCw className="w-4 h-4" />Refresh
          </button>
        </div>

        {!data.can_edit && (
          <div className={`${CARD} p-3 flex items-start gap-2.5 bg-[#FFF3E0] border-[#FFCC80]`}>
            <Info className="w-4 h-4 text-[#E65100] mt-0.5 shrink-0" />
            <p className="text-sm text-[#6B5744]">
              You can read this page and send yourself a test. Changing who receives a report, or when,
              is admin-only — it redirects the restaurant&apos;s figures to a phone number.
            </p>
          </div>
        )}

        {/* My number — the thing Send Test needs */}
        <div className={`${CARD} p-3.5`}>
          <div className="flex flex-wrap items-center gap-3">
            <Phone className="w-4 h-4 text-[#af4408]" />
            <div className="text-sm font-semibold">My WhatsApp number</div>
            <input
              value={myDraft}
              onChange={e => setMyDraft(e.target.value)}
              placeholder="9876543210"
              className="px-3 py-1.5 border border-[#E0D0BE] rounded-lg text-sm w-48 bg-[#FFFDFA]"
            />
            <button onClick={() => void saveMyNumber()} disabled={busy === 'mynumber'}
              className={`${BTN} bg-[#af4408] hover:bg-[#963a06] text-white`}>
              {busy === 'mynumber' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}Save
            </button>
            <span className="text-xs text-[#8B7355]">
              {myNumber?.number
                ? `Tests go to ${myNumber.number}${myNumber.source === 'hr_phone' ? ' (from your HR record)' : ''}.`
                : 'Send Test has nowhere to go until this is set.'}
            </span>
          </div>
          {flash?.key === '_me' && (
            <p className={`text-xs mt-2 ${flash.kind === 'ok' ? 'text-[#1B5E20]' : 'text-[#B71C1C]'}`}>{flash.text}</p>
          )}
        </div>

        {/* WHAT IT COSTS — before the switches, not after the invoice */}
        {data.cost && <CostPanel cost={data.cost} />}

        {/* Scheduled */}
        <SectionHeading icon={<Clock className="w-4 h-4" />} title="Scheduled reports"
          sub="Sent by the app itself, once a day per outlet, at the time you set. A restart or a second cron tick cannot send one twice." />
        <div className="space-y-3">
          {scheduled.map(r => (
            <ReportCard
              key={r.key} row={r} data={data} draft={drafts[r.key]} resolved={preview[r.key]}
              open={open === r.key} onToggleOpen={() => setOpen(open === r.key ? '' : r.key)}
              onDraft={p => setDraft(r.key, p)}
              onResolve={next => resolveDraft(r.key, next || drafts[r.key])}
              onSave={() => void save(r.key)} onTest={() => void sendTest(r.key)} onRun={() => void runNow(r.key)}
              busy={busy} flash={flash?.key === r.key ? flash : null}
            />
          ))}
        </div>

        {/* Events */}
        <SectionHeading icon={<Zap className="w-4 h-4" />} title="Event alerts"
          sub="Fired by the business action itself — a bill saved, a discount decided, a table confirmed. They never block or delay that action: if WhatsApp is down, the purchase, the decision and the booking all still complete." />
        <div className="space-y-3">
          {events.map(r => (
            <ReportCard
              key={r.key} row={r} data={data} draft={drafts[r.key]} resolved={preview[r.key]}
              open={open === r.key} onToggleOpen={() => setOpen(open === r.key ? '' : r.key)}
              onDraft={p => setDraft(r.key, p)}
              onResolve={next => resolveDraft(r.key, next || drafts[r.key])}
              onSave={() => void save(r.key)} onTest={() => void sendTest(r.key)} onRun={() => void runNow(r.key)}
              busy={busy} flash={flash?.key === r.key ? flash : null}
            />
          ))}
        </div>

        <div className={`${CARD} p-4 text-xs text-[#6B5744] space-y-1.5`}>
          <p className="font-semibold text-[#2D1B0E] text-sm">Before any of this can send</p>
          <p>
            Every report needs an <strong>approved template at Meta</strong>, created by hand in Meta Business
            Manager. A report that carries a PDF needs that template to have been created with a
            <strong> DOCUMENT header</strong> — the header format cannot be added to a template after approval,
            and the send refuses rather than delivering a broken attachment slot.
          </p>
          <p>Reports go out only on the Meta Cloud provider, and only while WhatsApp is configured and switched on.</p>
        </div>
      </div>
    </div>
  );
}

function SectionHeading({ icon, title, sub }: { icon: React.ReactNode; title: string; sub: string }) {
  return (
    <div className="pt-2">
      <h2 className="text-sm font-bold uppercase tracking-wider text-[#8B7355] flex items-center gap-2">{icon}{title}</h2>
      <p className="text-xs text-[#8B7355] mt-1 max-w-3xl">{sub}</p>
    </div>
  );
}

/* ── One report ────────────────────────────────────────────────────────────── */

function ReportCard({
  row, data, draft, resolved, open, onToggleOpen, onDraft, onResolve, onSave, onTest, onRun, busy, flash,
}: {
  row: ReportRow; data: Payload; draft: Draft; resolved: Resolved | null;
  open: boolean; onToggleOpen: () => void;
  onDraft: (p: Partial<Draft>) => void; onResolve: (next?: Draft) => void;
  onSave: () => void; onTest: () => void; onRun: () => void;
  busy: string; flash: { kind: 'ok' | 'err'; text: string } | null;
}) {
  const guest = row.audience_kind === 'guest';
  const editable = data.can_edit && !row.unimplemented;
  const cost = data.cost?.lines?.find(l => l.key === row.key) || null;

  if (row.unimplemented) {
    return (
      <div className={`${CARD} p-4 border-dashed`}>
        <div className="flex items-start gap-3">
          <Ban className="w-5 h-5 text-[#8B7355] mt-0.5 shrink-0" />
          <div>
            <div className="font-semibold">{row.label} <span className="text-xs font-normal text-[#8B7355]">— not built</span></div>
            <p className="text-xs text-[#6B5744] mt-1 max-w-3xl">{row.unimplemented_reason}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={CARD}>
      {/* Row */}
      <div className="p-3.5 flex flex-wrap items-center gap-x-4 gap-y-2">
        <button onClick={onToggleOpen} className="flex items-center gap-2 min-w-[220px] text-left">
          {open ? <ChevronDown className="w-4 h-4 text-[#8B7355]" /> : <ChevronRight className="w-4 h-4 text-[#8B7355]" />}
          <span className="font-semibold">{row.label}</span>
          {guest && <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-[#E3F2FD] text-[#0D47A1]">guest</span>}
        </button>

        <Toggle
          checked={draft?.enabled ?? false}
          disabled={!editable}
          onChange={next => onDraft({ enabled: next })}
          label={`Enable ${row.label}`}
          size="sm"
        />

        {row.scheduled ? (
          <label className="flex items-center gap-1.5 text-sm">
            <Clock className="w-3.5 h-3.5 text-[#8B7355]" />
            <input
              type="time" value={draft?.time || data.default_time} disabled={!editable}
              onChange={e => onDraft({ time: e.target.value })}
              className="px-2 py-1 border border-[#E0D0BE] rounded-lg text-sm bg-[#FFFDFA] disabled:opacity-60"
            />
            <span className="text-[10px] text-[#8B7355]">IST</span>
          </label>
        ) : (
          <span className="text-xs text-[#8B7355] inline-flex items-center gap-1"><Zap className="w-3.5 h-3.5" />on the event</span>
        )}

        <span className="text-xs text-[#6B5744] inline-flex items-center gap-1.5 min-w-[150px]">
          <FileText className="w-3.5 h-3.5 text-[#8B7355]" />
          {draft?.template ? <code className="text-[11px]">{draft.template}</code> : <em className="text-[#B71C1C]">no template</em>}
        </span>

        <span className="text-xs text-[#6B5744] inline-flex items-center gap-1.5 min-w-[150px]">
          <Users className="w-3.5 h-3.5 text-[#8B7355]" />
          {guest ? (
            <span>the guest on the booking</span>
          ) : (
            <>
              <span>{resolved?.count ?? 0} recipient{(resolved?.count ?? 0) === 1 ? '' : 's'}</span>
              {!!resolved?.unreachable?.length && (
                <span className="text-[#E65100] font-semibold">· {resolved.unreachable.length} unreachable</span>
              )}
            </>
          )}
        </span>

        {/* THE MONEY, on the row itself — a recipient count is not a cost. */}
        {!!cost && (
          <span className="text-xs text-[#6B5744] inline-flex items-center gap-1 min-w-[170px]" title={cost.basis}>
            <IndianRupee className="w-3.5 h-3.5 text-[#8B7355]" />
            <span>
              {cost.ceiling ? 'up to ' : ''}{cost.per_day} msg/day ·{' '}
              <strong>{cost.ceiling ? 'up to ' : ''}{money(cost.cost_per_month)}/month</strong>
            </span>
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          <StatusPill run={row.last_run} />
          <button onClick={onTest} disabled={!!busy}
            title="Send this report to your own number only"
            className={`${BTN} bg-white border border-[#E0D0BE] hover:bg-[#FFF1E3] text-[#6B5744]`}>
            {busy === `test:${row.key}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Send test
          </button>
        </div>
      </div>

      {flash && (
        <div className={`px-3.5 pb-2 text-xs ${flash.kind === 'ok' ? 'text-[#1B5E20]' : 'text-[#B71C1C]'}`}>{flash.text}</div>
      )}
      {row.scheduled && draft?.enabled && row.next_due && (
        <div className="px-3.5 pb-2.5 text-[11px] text-[#8B7355]">Next scheduled send: {row.next_due}.</div>
      )}

      {/* Editor */}
      {open && (
        <div className="border-t border-[#F0E4D6] p-4 space-y-4 bg-[#FFFDFA] rounded-b-xl">

          {guest && (
            <div className="flex items-start gap-2 text-xs text-[#6B5744] bg-[#E3F2FD] border border-[#BBDEFB] rounded-lg p-2.5">
              <Info className="w-4 h-4 text-[#0D47A1] mt-0.5 shrink-0" />
              <p>
                This one goes to <strong>the guest on the booking</strong> and to nobody else — management is never
                copied in. It fires when a booking becomes <strong>confirmed</strong>, never when it is created
                (a new booking is &ldquo;pending&rdquo;, which is a request nobody has accepted yet). The template must be
                a <strong>UTILITY</strong> template at Meta, never MARKETING.
              </p>
            </div>
          )}

          {/* Recipients */}
          {!guest && (
            <div className="grid lg:grid-cols-2 gap-4">
              <div className="space-y-3">
                <div className="text-xs font-bold uppercase tracking-wider text-[#8B7355]">Who receives it</div>

                {/* Scrolls. An install with 19 departments otherwise pushes the
                    recipient PREVIEW — the whole point of this panel — a screen
                    and a half below the checkbox that changes it. */}
                <div className="space-y-1.5 max-h-52 overflow-y-auto pr-1 border border-[#F0E4D6] rounded-lg p-2 bg-white">
                  {data.audience_options.groups.map(g => {
                    const on = (draft?.audience || []).includes(g.token);
                    return (
                      <label key={g.token} className="flex items-center gap-2 text-sm cursor-pointer">
                        <input
                          type="checkbox" checked={on} disabled={!editable}
                          onChange={e => {
                            const audience = e.target.checked
                              ? [...(draft.audience || []), g.token]
                              : (draft.audience || []).filter(t => t !== g.token);
                            onDraft({ audience });
                            onResolve({ ...draft, audience });
                          }}
                          className="accent-[#af4408]"
                        />
                        <span>{g.label}</span>
                        <span className={`text-[11px] ${g.count ? 'text-[#8B7355]' : 'text-[#E65100] font-semibold'}`}>
                          ({g.count} {g.count === 1 ? 'person' : 'people'})
                        </span>
                      </label>
                    );
                  })}
                </div>

                <details className="text-sm">
                  <summary className="cursor-pointer text-xs font-bold uppercase tracking-wider text-[#8B7355]">
                    …or pick people by name
                  </summary>
                  <div className="mt-2 space-y-1 max-h-56 overflow-y-auto pr-1">
                    {data.audience_options.users.map(u => {
                      const on = (draft?.audience || []).includes(u.token);
                      return (
                        <label key={u.token} className="flex items-center gap-2 text-sm cursor-pointer">
                          <input
                            type="checkbox" checked={on} disabled={!editable}
                            onChange={e => {
                              const audience = e.target.checked
                                ? [...(draft.audience || []), u.token]
                                : (draft.audience || []).filter(t => t !== u.token);
                              onDraft({ audience });
                              onResolve({ ...draft, audience });
                            }}
                            className="accent-[#af4408]"
                          />
                          <span>{u.label}</span>
                          <span className="text-[11px] text-[#8B7355]">{u.role}</span>
                          {!u.number && <span className="text-[11px] text-[#E65100] font-semibold">no number</span>}
                        </label>
                      );
                    })}
                  </div>
                </details>

                <label className="block">
                  <span className="text-xs font-bold uppercase tracking-wider text-[#8B7355]">
                    …plus these numbers (for people with no login)
                  </span>
                  <input
                    value={(draft?.recipients || []).join(', ')} disabled={!editable}
                    onChange={e => onDraft({ recipients: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                    onBlur={e => {
                      const recipients = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
                      onResolve({ ...draft, recipients });
                    }}
                    placeholder="9876543210, 9123456789"
                    className="mt-1 w-full px-3 py-2 border border-[#E0D0BE] rounded-lg text-sm bg-white disabled:opacity-60"
                  />
                </label>
              </div>

              {/* THE PREVIEW — the point of the whole panel */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-bold uppercase tracking-wider text-[#8B7355]">
                    Who that actually is, right now
                  </div>
                  <button onClick={() => onResolve(draft)} className="text-[11px] font-semibold text-[#af4408] hover:underline">recheck</button>
                </div>

                <div className="border border-[#E8D5C4] rounded-lg divide-y divide-[#F0E4D6] max-h-72 overflow-y-auto bg-white">
                  {(resolved?.recipients || []).map(p => (
                    <div key={p.number} className="px-3 py-1.5 flex items-center justify-between gap-2 text-sm">
                      <span>{p.label}</span>
                      <span className="text-[11px] text-[#8B7355] font-mono">{p.number}</span>
                    </div>
                  ))}
                  {!resolved?.recipients?.length && (
                    <div className="px-3 py-3 text-sm text-[#B71C1C]">
                      Nobody. Saved like this, this report will never be delivered to anyone.
                    </div>
                  )}
                </div>

                {!!resolved?.unreachable?.length && (
                  <div className="border border-[#FFCC80] bg-[#FFF3E0] rounded-lg p-2.5">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-[#E65100] flex items-center gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5" />Chosen, but unreachable
                    </div>
                    <ul className="mt-1 space-y-0.5">
                      {resolved.unreachable.map(u => (
                        <li key={u.userId} className="text-xs text-[#6B5744]">
                          <strong>{u.name}</strong> — no WhatsApp number on their login.
                        </li>
                      ))}
                    </ul>
                    <p className="text-[11px] text-[#6B5744] mt-1.5">
                      They are picked but will receive nothing. An admin can add a number against each login.
                    </p>
                  </div>
                )}

                {!!resolved?.empty_tokens?.length && (
                  <p className="text-xs text-[#E65100]">
                    These groups matched nobody: {resolved.empty_tokens.join(', ')}.
                  </p>
                )}
                {resolved?.capped && (
                  <p className="text-xs text-[#E65100]">
                    Trimmed to the first {data.max_recipients} recipients.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Template + timing */}
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <label className="block">
              <span className="text-xs font-bold uppercase tracking-wider text-[#8B7355]">Meta template name</span>
              <input
                value={draft?.template || ''} disabled={!editable}
                onChange={e => onDraft({ template: e.target.value })}
                placeholder="akan_daily_report"
                className="mt-1 w-full px-3 py-2 border border-[#E0D0BE] rounded-lg text-sm bg-white font-mono disabled:opacity-60"
              />
              <span className="text-[10px] text-[#8B7355]">
                {row.attachment === 'never'
                  ? 'A text template. UTILITY category.'
                  : row.attachment === 'always'
                    ? 'Must have been created with a DOCUMENT header.'
                    : 'Needs a DOCUMENT header when more than one item is listed.'}
              </span>
            </label>

            <label className="block">
              <span className="text-xs font-bold uppercase tracking-wider text-[#8B7355]">Language</span>
              <input
                value={draft?.lang || 'en'} disabled={!editable}
                onChange={e => onDraft({ lang: e.target.value })}
                className="mt-1 w-full px-3 py-2 border border-[#E0D0BE] rounded-lg text-sm bg-white disabled:opacity-60"
              />
            </label>

            {row.scheduled && (
              <label className="block">
                <span className="text-xs font-bold uppercase tracking-wider text-[#8B7355]">Which day</span>
                <select
                  value={draft?.offset_days ?? 1} disabled={!editable}
                  onChange={e => onDraft({ offset_days: Number(e.target.value) })}
                  className="mt-1 w-full px-3 py-2 border border-[#E0D0BE] rounded-lg text-sm bg-white disabled:opacity-60"
                >
                  <option value={1}>Yesterday (recommended)</option>
                  <option value={0}>Today so far</option>
                  <option value={2}>Two days ago</option>
                </select>
                <span className="text-[10px] text-[#8B7355]">
                  A morning report on a part-finished day panics about numbers that fix themselves by lunch.
                </span>
              </label>
            )}

            {/* THE DAILY CAP — an event alert is the only thing here that can
                fire many times a day, so it is the only thing that needs one.
                It cannot be switched off; 0 means "leave it at the default". */}
            {!row.scheduled && !guest && (
              <label className="block">
                <span className="text-xs font-bold uppercase tracking-wider text-[#8B7355]">Messages a day, at most</span>
                <input
                  type="number" min={1} max={data.max_daily_cap} disabled={!editable}
                  value={draft?.daily_cap ?? 0}
                  onChange={e => onDraft({ daily_cap: Number(e.target.value) })}
                  className="mt-1 w-full px-3 py-2 border border-[#E0D0BE] rounded-lg text-sm bg-white disabled:opacity-60"
                />
                <span className="text-[10px] text-[#8B7355]">
                  {row.sent_today} sent today. Counted in MESSAGES (one alert to {cost?.recipients ?? 0} people is {cost?.recipients ?? 0}).
                  An alert that would cross the cap is not sent at all. Max {data.max_daily_cap}; the cap cannot be removed.
                </span>
              </label>
            )}

            {row.scheduled && data.outlets.length > 1 && (
              <div>
                <span className="text-xs font-bold uppercase tracking-wider text-[#8B7355]">Outlets</span>
                <div className="mt-1 space-y-1">
                  {data.outlets.map(o => {
                    const on = (draft?.outlets || []).includes(o.id);
                    return (
                      <label key={o.id} className="flex items-center gap-2 text-sm cursor-pointer">
                        <input
                          type="checkbox" checked={on} disabled={!editable}
                          onChange={e => onDraft({
                            outlets: e.target.checked
                              ? [...(draft.outlets || []), o.id]
                              : (draft.outlets || []).filter(x => x !== o.id),
                          })}
                          className="accent-[#af4408]"
                        />
                        {o.name}{o.is_default ? ' (default)' : ''}
                      </label>
                    );
                  })}
                </div>
                <span className="text-[10px] text-[#8B7355]">None ticked = the default outlet. One send per outlet per day.</span>
              </div>
            )}
          </div>

          {/* Actions + history */}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button onClick={onSave} disabled={!editable || busy === row.key}
              className={`${BTN} bg-[#af4408] hover:bg-[#963a06] text-white`}>
              {busy === row.key ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}Save
            </button>
            {row.scheduled && (
              <button onClick={onRun} disabled={!editable || !!busy}
                title="Send now, to the real recipients"
                className={`${BTN} bg-white border border-[#E0D0BE] hover:bg-[#FFF1E3] text-[#6B5744]`}>
                {busy === `run:${row.key}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                Run now (real recipients)
              </button>
            )}
            <span className="text-[11px] text-[#8B7355]">
              Template variables, in order: {row.param_order.join(', ') || '—'}
            </span>
          </div>

          {!!row.history.length && (
            <div>
              <div className="text-xs font-bold uppercase tracking-wider text-[#8B7355] mb-1">Recent runs</div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-[#8B7355] text-left">
                    <tr><th className="py-1 pr-3">When</th><th className="pr-3">Slot</th><th className="pr-3">By</th>
                      <th className="pr-3">Status</th><th className="pr-3">Sent</th><th>Detail</th></tr>
                  </thead>
                  <tbody className="divide-y divide-[#F0E4D6]">
                    {row.history.map(h => (
                      <tr key={h.id}>
                        <td className="py-1 pr-3 whitespace-nowrap">{(h.finished_at || h.claimed_at || '').slice(0, 16)}</td>
                        <td className="pr-3 whitespace-nowrap">{h.run_date}</td>
                        <td className="pr-3">{h.trigger_source}{h.actor ? ` (${h.actor})` : ''}</td>
                        <td className="pr-3 font-semibold">{h.status}</td>
                        <td className="pr-3">{h.sent_count}{h.failed_count ? ` / ${h.failed_count} failed` : ''}</td>
                        <td className="text-[#6B5744]">{h.detail?.slice(0, 120)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
