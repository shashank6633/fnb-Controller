'use client';

/**
 * CRM — WhatsApp Broadcasts (/crm-calls/broadcasts). Management only.
 *
 * The operator face of the queued-broadcast engine (src/lib/wa-broadcast.ts):
 *
 *   LIST     — every campaign with its state, honest per-state counts
 *              (sent/delivered/read/replied AND capped/failed/skipped) and the
 *              cost line (estimate captured at start → actual so far).
 *   WIZARD   — audience builder (all guests / lapsed window / regulars /
 *              birthday month / loyalty tier / pasted numbers) → LIVE preview
 *              with every exclusion itemised and why → approved-template picker
 *              with variable mapping and a rendered sample for a real guest →
 *              cost line → explicit confirmation, TYPED above the threshold.
 *   DETAIL   — live progress under the throttle, pause/resume/cancel (take
 *              effect within one message), per-recipient report with state
 *              filters, wamids, timestamps and the provider's error text.
 *   CONSENT  — the marketing opt-out register: look a number up, see the
 *              audit history, and the ONLY door back in after a STOP
 *              (inbound re-opt-in keywords are deliberately not honoured).
 *
 * SENDING IS ALWAYS A DELIBERATE ACT. Creating a campaign writes a draft;
 * starting one needs confirm + an expected-count the server re-checks (409 if
 * the list moved); delivery then happens from the scheduler-driven drain,
 * throttled, with consent/cooldown/daily-cap re-checked per message. Nothing
 * on this page sends on mount, on poll, or on tab change.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { formatPhone } from '@/lib/ct/phone';
import {
  Megaphone, Send, AlertCircle, Loader2, RefreshCw, CheckCircle, XCircle,
  ChevronLeft, ShieldAlert, Info, Trash2, MessageSquare, Users, Pause, Play,
  Ban, IndianRupee, Search, ShieldOff, ShieldCheck, Clock, FileText, Plus, Minus,
} from 'lucide-react';

/* ───────────────────────── types (mirror the APIs) ───────────────────────── */

interface Settings {
  enabled: boolean;
  msgs_per_min: number;
  cooldown_days: number;
  daily_cap: number;
  cost_per_msg: number;
  confirm_threshold: number;
}

interface Counts {
  queued: number; sending: number; sent: number; delivered: number; read: number;
  replied: number; failed: number; capped: number;
  skipped_optout: number; skipped_cooldown: number; cancelled: number;
  total: number; sent_total: number;
}

interface Cost { rate: number; estimate: number; actual: number }

interface AudienceMeta {
  kind?: string; days?: number; include_never?: boolean; visits?: number;
  month?: number; tier?: string; phones?: string[];
  resolved?: { total_candidates: number; no_phone: number; deduped: number; queued: number };
}

interface Campaign {
  id: string; name: string; template_name: string; language: string;
  param_order: string[]; preview_body: string; audience: AudienceMeta;
  state: 'draft' | 'scheduled' | 'sending' | 'paused' | 'done' | 'cancelled';
  throttle_per_min: number; cost_rate: number; cost_estimate: number;
  started_at: string | null; finished_at: string | null;
  created_by: string; created_at: string;
  counts: Counts; unconfirmed: number; cost: Cost;
}

interface Tpl {
  id: string; name: string; category: string; language: string; body: string;
  provider_template_name: string; provider_language: string; param_order: string;
  send_as_template: number;
}

interface ListResp {
  campaigns?: Campaign[];
  flag?: { key: string; enabled: boolean };
  settings?: Settings;
  templates?: Tpl[];
  venue?: string;
  wa?: { configured: boolean };
  can_configure?: boolean;
  error?: string;
}

interface Preview {
  total_candidates: number;
  queued: number;
  eligible_now: number;
  excluded: { no_phone: number; deduped: number; opted_out: number; cooldown: number };
  sample: Array<{ name: string; phone_e164: string }>;
  cost: { rate: number; estimate: number };
  note: string;
}

interface RecipRow {
  id: string; guest_id: string | null; phone_e164: string; phone_key: string; name: string;
  state: string; wamid: string | null; error_detail: string;
  queued_at: string; sent_at: string | null; delivered_at: string | null;
  read_at: string | null; replied_at: string | null; failed_at: string | null;
}

interface ConsentRow {
  phone_key: string; status: 'opted_out' | 'opted_in';
  source: string; detail: string; changed_by: string;
  /** Standing rows carry changed_at; audit-log rows carry created_at. */
  changed_at?: string; created_at?: string;
}

/* ───────────────────────── helpers ───────────────────────── */

const money = (n: number) => `₹${(Math.round((n || 0) * 100) / 100).toLocaleString('en-IN')}`;

function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/** Server timestamps are UTC 'YYYY-MM-DD HH:MM:SS' — render in IST. */
function istDateTime(s: string | null | undefined): string {
  if (!s) return '—';
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s.replace(' ', 'T') + 'Z' : s;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function audienceLabel(a: AudienceMeta | null | undefined): string {
  if (!a || !a.kind) return 'audience unknown';
  switch (a.kind) {
    case 'all_guests': return 'All guests';
    case 'winback': return `Lapsed ${a.days || 60}+ days${a.include_never ? ' (incl. never-visited)' : ''}`;
    case 'min_visits': return `Regulars — ${a.visits || 1}+ visits`;
    case 'birthday_month': return `${MONTHS[(a.month || 1) - 1]} birthdays`;
    case 'tier': return `${a.tier || ''} loyalty tier`;
    case 'phones': return `Pasted list (${a.phones?.length ?? a.resolved?.total_candidates ?? '?'} numbers)`;
    default: return a.kind;
  }
}

const BROADCAST_VARS = ['name', 'venue', 'phone'] as const;
type BVar = (typeof BROADCAST_VARS)[number];

/** Client mirror of renderCampaignBody: positional {{1}}… then named vars. */
function renderSample(body: string, slots: string[], vars: Record<string, string>): string {
  let out = body || '';
  slots.forEach((k, i) => { out = out.split(`{{${i + 1}}}`).join(vars[k] ?? ''); });
  for (const [k, v] of Object.entries(vars)) out = out.split(`{{${k}}}`).join(v);
  return out;
}

const CAMP_STYLE: Record<string, string> = {
  draft: 'bg-[#EFEAE4] text-[#6B5744] border-[#DED3C6]',
  scheduled: 'bg-sky-50 text-sky-700 border-sky-200',
  sending: 'bg-amber-50 text-amber-800 border-amber-200',
  paused: 'bg-orange-50 text-orange-800 border-orange-200',
  done: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  cancelled: 'bg-red-50 text-red-700 border-red-200',
};

const REC_STATES = [
  'queued', 'sending', 'sent', 'delivered', 'read', 'replied',
  'failed', 'capped', 'skipped_optout', 'skipped_cooldown', 'cancelled',
] as const;

const REC_STYLE: Record<string, string> = {
  queued: 'bg-[#EFEAE4] text-[#6B5744] border-[#DED3C6]',
  sending: 'bg-amber-50 text-amber-800 border-amber-200',
  sent: 'bg-sky-50 text-sky-700 border-sky-200',
  delivered: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  read: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  replied: 'bg-violet-50 text-violet-700 border-violet-200',
  failed: 'bg-red-50 text-red-700 border-red-200',
  capped: 'bg-orange-50 text-orange-800 border-orange-200',
  skipped_optout: 'bg-red-50 text-red-600 border-red-100',
  skipped_cooldown: 'bg-[#FFF1E3] text-[#8a5a1f] border-[#F0D9BE]',
  cancelled: 'bg-[#EFEAE4] text-[#8B7355] border-[#DED3C6]',
};

const REC_LABEL: Record<string, string> = {
  queued: 'queued', sending: 'unconfirmed', sent: 'sent', delivered: 'delivered',
  read: 'read', replied: 'replied', failed: 'failed', capped: 'capped',
  skipped_optout: 'opted out', skipped_cooldown: 'cooldown', cancelled: 'cancelled',
};

/* ───────────────────────── page ───────────────────────── */

export default function BroadcastsPage() {
  const [tab, setTab] = useState<'campaigns' | 'consent'>('campaigns');
  const [data, setData] = useState<ListResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);

  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Campaign | null>(null);
  const [recips, setRecips] = useState<RecipRow[]>([]);
  const [recipFilter, setRecipFilter] = useState<string>('');
  const [showWizard, setShowWizard] = useState(false);

  const detailIdRef = useRef<string | null>(null);
  detailIdRef.current = detailId;

  // The recipient filter the poller should use — a ref so the 5s poll always
  // reads the CURRENT chip without re-arming the interval.
  const recipFilterRef = useRef('');
  recipFilterRef.current = recipFilter;

  const loadList = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      const res = await api('/api/crm-calls/broadcasts');
      const j: ListResp = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j);
      setError('');
    } catch (e) {
      setError(errMsg(e, 'Could not load broadcasts'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (id: string, opts?: { silent?: boolean }) => {
    if (!opts?.silent) setBusy(true);
    try {
      const [dRes, rRes] = await Promise.all([
        api(`/api/crm-calls/broadcasts/${id}`),
        api(`/api/crm-calls/broadcasts/${id}/recipients${recipFilterRef.current ? `?state=${recipFilterRef.current}` : ''}`),
      ]);
      const d = await dRes.json();
      const r = await rRes.json();
      if (detailIdRef.current !== id) return;
      if (!dRes.ok) throw new Error(d.error || `HTTP ${dRes.status}`);
      setDetail({ ...d.campaign, counts: d.counts, unconfirmed: d.unconfirmed, cost: d.cost });
      if (rRes.ok) setRecips(Array.isArray(r.recipients) ? r.recipients : []);
      setError('');
    } catch (e) {
      if (detailIdRef.current === id && !opts?.silent) setError(errMsg(e, 'Could not load the campaign'));
    } finally {
      if (!opts?.silent) setBusy(false);
    }
  }, []);

  useEffect(() => { loadList(); }, [loadList]);

  useEffect(() => {
    if (!detailId) { setDetail(null); setRecips([]); setRecipFilter(''); return; }
    loadDetail(detailId);
  }, [detailId, loadDetail]);

  // Refetch recipients when the filter chip changes.
  useEffect(() => {
    if (detailId) loadDetail(detailId, { silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipFilter]);

  // Live progress: poll every 5s while the open campaign is actually moving.
  useEffect(() => {
    if (!detailId || !detail || (detail.state !== 'sending' && detail.counts.sending === 0)) return;
    const t = setInterval(() => {
      loadDetail(detailId, { silent: true });
      loadList({ silent: true });
    }, 5000);
    return () => clearInterval(t);
  }, [detailId, detail, loadDetail, loadList]);

  const doAction = useCallback(async (id: string, action: string, extra?: Record<string, unknown>) => {
    setBusy(true); setError(''); setNotice(''); setWarnings([]);
    try {
      const res = await api(`/api/crm-calls/broadcasts/${id}/action`, {
        method: 'POST', body: { action, ...(extra || {}) },
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      if (Array.isArray(j.warnings) && j.warnings.length) setWarnings(j.warnings);
      if (j.note) setNotice(j.note);
      else setNotice(action === 'pause' ? 'Campaign paused — the drain stops within one message.'
        : action === 'resume' ? 'Campaign resumed.'
        : action === 'cancel' ? 'Campaign cancelled. Remaining queued guests will not be messaged.' : 'Done.');
      await loadDetail(id, { silent: true });
      await loadList({ silent: true });
      return true;
    } catch (e) {
      setError(errMsg(e, `Could not ${action}`));
      await loadDetail(id, { silent: true });
      return false;
    } finally {
      setBusy(false);
    }
  }, [loadDetail, loadList]);

  const deleteDraft = useCallback(async (id: string) => {
    if (!confirm('Discard this draft campaign? It has not messaged anyone.')) return;
    setBusy(true); setError('');
    try {
      const res = await api(`/api/crm-calls/broadcasts/${id}`, { method: 'DELETE' });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setDetailId(null);
      setNotice('Draft discarded.');
      await loadList({ silent: true });
    } catch (e) {
      setError(errMsg(e, 'Could not discard the draft'));
    } finally {
      setBusy(false);
    }
  }, [loadList]);

  /* ── render ── */

  if (loading && !data) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] p-6 animate-pulse">
        <div className="max-w-[100rem] mx-auto space-y-6">
          <div className="h-9 w-72 bg-[#FFF1E3] rounded-lg" />
          <div className="h-24 bg-white border border-[#E8D5C4] rounded-2xl" />
          <div className="bg-white border border-[#E8D5C4] rounded-2xl h-96" />
        </div>
      </div>
    );
  }

  const flagOn = !!data?.flag?.enabled;
  const waOk = !!data?.wa?.configured;
  const s = data?.settings;
  const campaigns = data?.campaigns || [];

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-[100rem] mx-auto px-3 sm:px-6 py-5 sm:py-6 space-y-4 sm:space-y-5">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold text-[#6B5744] uppercase tracking-wider">CRM · Call to Table</p>
            <h1 className="text-2xl sm:text-3xl font-bold mt-0.5 flex items-center gap-2">
              <Megaphone className="w-7 h-7 text-[#af4408]" /> WhatsApp Broadcasts
            </h1>
            <p className="text-sm text-[#6B5744] mt-1">
              Queued marketing campaigns — throttled, consent-checked on every message, and honest about what happened to each guest.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => (detailId ? loadDetail(detailId) : loadList({ silent: true }))}
              disabled={busy}
              className="flex items-center gap-2 px-3 py-2.5 bg-white border border-[#E0D0BE] hover:border-[#af4408] hover:bg-[#FFF1E3] text-[#6B5744] rounded-xl text-sm font-medium shadow-sm transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} /> Refresh
            </button>
            <button
              onClick={() => setShowWizard(true)}
              className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-xl text-sm font-semibold shadow-sm transition-colors"
            >
              <Megaphone className="w-4 h-4" /> New campaign
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 bg-white border border-[#E8D5C4] rounded-xl p-1 w-fit shadow-sm">
          {(['campaigns', 'consent'] as const).map(t => (
            <button
              key={t}
              onClick={() => { setTab(t); setDetailId(null); }}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
                tab === t ? 'bg-[#af4408] text-white' : 'text-[#6B5744] hover:bg-[#FFF1E3]'
              }`}
            >
              {t === 'campaigns' ? 'Campaigns' : 'Marketing consent'}
            </button>
          ))}
        </div>

        {/* Safety banner — the truth about whether anything can deliver */}
        <div className={`rounded-2xl border p-4 ${flagOn ? 'bg-amber-50 border-amber-200' : 'bg-white border-[#E8D5C4]'}`}>
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
            <div className="flex items-start gap-2.5">
              {flagOn ? <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" /> : <Info className="w-5 h-5 text-[#8B7355] shrink-0 mt-0.5" />}
              <div className="text-sm">
                <p className="font-semibold">
                  {flagOn ? 'Broadcast sending is ENABLED' : 'Broadcast sending is OFF'}
                </p>
                <p className="text-[#6B5744] mt-0.5">
                  {flagOn
                    ? 'Started campaigns drain from the queue — throttled, with consent, cooldown and the daily cap re-checked on every single message.'
                    : 'You can build, preview and even start campaigns; the queue will not move until an admin enables sending.'}
                  {' '}WhatsApp provider:{' '}
                  <span className={waOk ? 'text-emerald-700 font-medium' : 'text-red-700 font-medium'}>
                    {waOk ? 'configured' : 'not configured'}
                  </span>.
                </p>
                {s && (
                  <p className="text-xs text-[#8B7355] mt-1">
                    ~{s.msgs_per_min}/min · {s.cooldown_days}-day per-guest cooldown · {s.daily_cap > 0 ? `${s.daily_cap}/day cap` : 'no daily cap'} · {money(s.cost_per_msg)}/message · typed confirmation over {s.confirm_threshold} recipients
                  </p>
                )}
              </div>
            </div>
            {data?.can_configure ? (
              <a href="/settings/integrations/whatsapp" className="text-xs font-semibold text-[#af4408] hover:underline shrink-0">
                Broadcast settings →
              </a>
            ) : (
              <span className="text-xs text-[#8B7355] shrink-0">Only an admin can change these knobs</span>
            )}
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 p-4 bg-red-50 border border-red-200 rounded-xl">
            <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
            <p className="text-sm text-red-700">{error}</p>
            <button onClick={() => setError('')} className="ml-auto text-red-700 text-xs underline shrink-0">dismiss</button>
          </div>
        )}
        {notice && (
          <div className="flex items-start gap-2 p-4 bg-emerald-50 border border-emerald-200 rounded-xl">
            <CheckCircle className="w-5 h-5 text-emerald-600 shrink-0" />
            <p className="text-sm text-emerald-800">{notice}</p>
            <button onClick={() => setNotice('')} className="ml-auto text-emerald-700 text-xs underline shrink-0">dismiss</button>
          </div>
        )}
        {warnings.map((w, i) => (
          <div key={i} className="flex items-start gap-2 p-4 bg-amber-50 border border-amber-200 rounded-xl">
            <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0" />
            <p className="text-sm text-amber-800">{w}</p>
          </div>
        ))}

        {/* ─── CAMPAIGNS ─── */}
        {tab === 'campaigns' && !detailId && (
          <CampaignList campaigns={campaigns} onOpen={id => setDetailId(id)} />
        )}

        {tab === 'campaigns' && detailId && detail && (
          <CampaignDetail
            campaign={detail}
            recips={recips}
            recipFilter={recipFilter}
            setRecipFilter={setRecipFilter}
            busy={busy}
            settings={s}
            onBack={() => setDetailId(null)}
            onAction={doAction}
            onDelete={() => deleteDraft(detail.id)}
          />
        )}
        {tab === 'campaigns' && detailId && !detail && (
          <div className="bg-white border border-[#E8D5C4] rounded-2xl py-16 text-center">
            <Loader2 className="w-8 h-8 text-[#af4408] animate-spin mx-auto" />
          </div>
        )}

        {/* ─── CONSENT ─── */}
        {tab === 'consent' && <ConsentPanel />}
      </div>

      {showWizard && data && (
        <Wizard
          settings={data.settings!}
          templates={data.templates || []}
          venue={data.venue || ''}
          flagOn={flagOn}
          waOk={waOk}
          onClose={() => setShowWizard(false)}
          onDone={async (id, startedNote, warns) => {
            setShowWizard(false);
            setNotice(startedNote);
            setWarnings(warns);
            setTab('campaigns');
            setDetailId(id);
            await loadList({ silent: true });
          }}
        />
      )}
    </div>
  );
}

/* ───────────────────────── shared bits ───────────────────────── */

function Stat({ label, value, accent, sub }: { label: string; value: string; accent?: boolean; sub?: string }) {
  return (
    <div className={`rounded-xl border p-3 ${accent ? 'bg-[#FFF1E3] border-[#F0D9BE]' : 'bg-[#FFFBF6] border-[#EFE1D0]'}`}>
      <p className="text-[11px] uppercase tracking-wider text-[#8B7355]">{label}</p>
      <p className={`text-xl font-bold tabular-nums ${accent ? 'text-[#af4408]' : 'text-[#2D1B0E]'}`}>{value}</p>
      {sub && <p className="text-[11px] text-[#8B7355] mt-0.5">{sub}</p>}
    </div>
  );
}

function StateChip({ state }: { state: string }) {
  return (
    <span className={`inline-block px-2 py-0.5 rounded-lg border text-xs font-semibold ${CAMP_STYLE[state] || CAMP_STYLE.draft}`}>
      {state}
    </span>
  );
}

/** Stacked progress bar — every recipient lands in exactly one band. */
function ProgressBar({ counts }: { counts: Counts }) {
  const total = counts.total || 1;
  const bands: Array<[number, string, string]> = [
    [counts.sent_total, 'bg-emerald-500', 'left the building (sent/delivered/read/replied)'],
    [counts.sending, 'bg-amber-400', 'claimed, unconfirmed'],
    [counts.capped, 'bg-orange-400', 'capped by Meta limits'],
    [counts.failed, 'bg-red-500', 'failed'],
    [counts.skipped_optout + counts.skipped_cooldown, 'bg-[#C4B09A]', 'skipped (opt-out / cooldown)'],
    [counts.cancelled, 'bg-[#8B7355]', 'cancelled'],
  ];
  const processed = total - counts.queued;
  return (
    <div>
      <div className="flex h-3 w-full rounded-full overflow-hidden bg-[#F3EADF] border border-[#EFE1D0]">
        {bands.map(([n, cls, title], i) =>
          n > 0 ? <div key={i} className={cls} style={{ width: `${(n / total) * 100}%` }} title={`${n} ${title}`} /> : null,
        )}
      </div>
      <p className="text-[11px] text-[#8B7355] mt-1 tabular-nums">
        {processed} of {counts.total} processed · {counts.queued} still queued
      </p>
    </div>
  );
}

/* ───────────────────────── campaign list ───────────────────────── */

function CampaignList({ campaigns, onOpen }: { campaigns: Campaign[]; onOpen: (id: string) => void }) {
  if (campaigns.length === 0) {
    return (
      <div className="bg-white border border-[#E8D5C4] rounded-2xl py-16 text-center">
        <Megaphone className="w-10 h-10 text-[#D8C3A8] mx-auto mb-3" />
        <p className="text-[#6B5744] font-medium">No broadcast campaigns yet.</p>
        <p className="text-sm text-[#8B7355] mt-1">Press “New campaign” to build an audience and preview exactly who would hear from you.</p>
      </div>
    );
  }
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-[#FFF1E3] border-b border-[#E8D5C4]">
            <tr className="text-left text-[11px] uppercase tracking-wider text-[#6B5744]">
              <th className="px-3 py-3">Campaign</th>
              <th className="px-3 py-3">State</th>
              <th className="px-3 py-3 text-right">Recipients</th>
              <th className="px-3 py-3 text-right">Sent</th>
              <th className="px-3 py-3 text-right">Delivered</th>
              <th className="px-3 py-3 text-right">Read</th>
              <th className="px-3 py-3 text-right">Replied</th>
              <th className="px-3 py-3 text-right">Problems</th>
              <th className="px-3 py-3 text-right">Cost</th>
              <th className="px-3 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[#F0E4D6]">
            {campaigns.map(c => {
              const problems = c.counts.failed + c.counts.capped + c.unconfirmed;
              return (
                <tr key={c.id} className="hover:bg-[#FFFBF6] cursor-pointer" onClick={() => onOpen(c.id)}>
                  <td className="px-3 py-3">
                    <div className="font-medium">{c.name}</div>
                    <div className="text-xs text-[#8B7355]">
                      {audienceLabel(c.audience)} · template <code className="text-[#6B5744]">{c.template_name || '—'}</code> · {istDateTime(c.created_at)}
                    </div>
                  </td>
                  <td className="px-3 py-3"><StateChip state={c.state} /></td>
                  <td className="px-3 py-3 text-right tabular-nums">{c.counts.total}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{c.counts.sent_total}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{c.counts.delivered + c.counts.read + c.counts.replied}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{c.counts.read + c.counts.replied}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{c.counts.replied}</td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {problems > 0
                      ? <span className="text-red-700 font-medium">{problems}</span>
                      : <span className="text-[#B7A48C]">—</span>}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {c.state === 'draft'
                      ? <span className="text-[#B7A48C]">—</span>
                      : (
                        <div>
                          <div>{money(c.cost.actual)}</div>
                          <div className="text-[10px] text-[#8B7355]">est. {money(c.cost.estimate)}</div>
                        </div>
                      )}
                  </td>
                  <td className="px-3 py-3 text-right text-[#af4408] text-xs font-medium whitespace-nowrap">Open →</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ───────────────────────── campaign detail ───────────────────────── */

function CampaignDetail({
  campaign: c, recips, recipFilter, setRecipFilter, busy, settings, onBack, onAction, onDelete,
}: {
  campaign: Campaign;
  recips: RecipRow[];
  recipFilter: string;
  setRecipFilter: (s: string) => void;
  busy: boolean;
  settings: Settings | undefined;
  onBack: () => void;
  onAction: (id: string, action: string, extra?: Record<string, unknown>) => Promise<boolean>;
  onDelete: () => void;
}) {
  const [confirmStart, setConfirmStart] = useState(false);
  const counts = c.counts;
  const resolved = c.audience?.resolved;

  const chipsWithCounts = REC_STATES.map(st => ({ st, n: counts[st as keyof Counts] as number })).filter(x => x.n > 0);

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="flex items-center gap-1 text-sm text-[#af4408] hover:underline">
        <ChevronLeft className="w-4 h-4" /> All campaigns
      </button>

      <div className="bg-white border border-[#E8D5C4] rounded-2xl p-4 shadow-sm space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold flex items-center gap-2 flex-wrap">{c.name} <StateChip state={c.state} /></h2>
            <p className="text-sm text-[#6B5744] mt-0.5">
              {audienceLabel(c.audience)} · template <code>{c.template_name}</code> ({c.language})
              {c.param_order.length > 0 && <> · params {c.param_order.join(', ')}</>}
              {' '}· created by {c.created_by || 'unknown'}
            </p>
            <p className="text-xs text-[#8B7355] mt-0.5">
              {c.started_at ? `Started ${istDateTime(c.started_at)}` : 'Not started'}
              {c.finished_at ? ` · finished ${istDateTime(c.finished_at)}` : ''}
              {c.throttle_per_min > 0 ? ` · own throttle ${c.throttle_per_min}/min` : settings ? ` · global throttle ~${settings.msgs_per_min}/min` : ''}
            </p>
            {resolved && (
              <p className="text-xs text-[#8B7355] mt-0.5">
                Audience build: {resolved.total_candidates} candidate(s) → {resolved.queued} queued
                {resolved.no_phone > 0 && ` · ${resolved.no_phone} had no usable number`}
                {resolved.deduped > 0 && ` · ${resolved.deduped} duplicate number(s) collapsed`}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {c.state === 'draft' && (
              <>
                <button onClick={onDelete} disabled={busy}
                        className="flex items-center gap-2 px-3 py-2.5 bg-white border border-[#E0D0BE] hover:border-red-400 hover:text-red-700 text-[#6B5744] rounded-xl text-sm font-medium disabled:opacity-50">
                  <Trash2 className="w-4 h-4" /> Discard draft
                </button>
                <button onClick={() => setConfirmStart(true)} disabled={busy || counts.queued === 0}
                        title={counts.queued === 0 ? 'Nothing queued to send' : ''}
                        className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-40 text-white rounded-xl text-sm font-semibold shadow-sm">
                  <Send className="w-4 h-4" /> Start campaign
                </button>
              </>
            )}
            {c.state === 'sending' && (
              <button onClick={() => onAction(c.id, 'pause')} disabled={busy}
                      className="flex items-center gap-2 px-4 py-2.5 bg-white border border-amber-300 hover:bg-amber-50 text-amber-800 rounded-xl text-sm font-semibold disabled:opacity-50">
                <Pause className="w-4 h-4" /> Pause
              </button>
            )}
            {c.state === 'paused' && (
              <button onClick={() => onAction(c.id, 'resume')} disabled={busy}
                      className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-xl text-sm font-semibold disabled:opacity-50">
                <Play className="w-4 h-4" /> Resume
              </button>
            )}
            {['sending', 'paused', 'scheduled'].includes(c.state) && (
              <button
                onClick={() => { if (confirm(`Cancel this campaign? ${counts.queued} queued guest(s) will NOT be messaged. Messages already sent cannot be recalled.`)) onAction(c.id, 'cancel'); }}
                disabled={busy}
                className="flex items-center gap-2 px-3 py-2.5 bg-white border border-[#E0D0BE] hover:border-red-400 hover:text-red-700 text-[#6B5744] rounded-xl text-sm font-medium disabled:opacity-50">
                <Ban className="w-4 h-4" /> Cancel
              </button>
            )}
          </div>
        </div>

        {(c.state === 'sending' || c.state === 'paused' || counts.total > counts.queued) && (
          <ProgressBar counts={counts} />
        )}

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <Stat label="Recipients" value={String(counts.total)} />
          <Stat label="Sent" value={String(counts.sent_total)} accent />
          <Stat label="Delivered" value={String(counts.delivered + counts.read + counts.replied)} />
          <Stat label="Read" value={String(counts.read + counts.replied)} />
          <Stat label="Replied" value={String(counts.replied)} />
          {c.state === 'draft'
            ? <Stat label="Est. cost" value={settings ? money(counts.queued * settings.cost_per_msg) : '—'} sub={settings ? `${counts.queued} × ${money(settings.cost_per_msg)}` : undefined} />
            : <Stat label="Cost so far" value={money(c.cost.actual)} sub={`estimated ${money(c.cost.estimate)} @ ${money(c.cost.rate)}/msg`} />}
        </div>

        {(counts.failed > 0 || counts.capped > 0 || counts.skipped_optout > 0 || counts.skipped_cooldown > 0) && (
          <div className="text-xs text-[#6B5744] bg-[#FFFBF6] border border-[#EFE1D0] rounded-xl p-3 space-y-1">
            <p className="font-semibold text-[#2D1B0E]">Not everyone was messaged — and that is the point:</p>
            {counts.skipped_optout > 0 && <p>· <strong>{counts.skipped_optout}</strong> skipped — opted out of marketing (STOP or manual). Never messaged by any campaign until manually opted back in.</p>}
            {counts.skipped_cooldown > 0 && <p>· <strong>{counts.skipped_cooldown}</strong> skipped — already got a marketing message inside the cooldown window (any campaign, either rail).</p>}
            {counts.capped > 0 && <p>· <strong>{counts.capped}</strong> capped — Meta refused for rate/limit reasons (per-row error text below). These guests were NOT charged for.</p>}
            {counts.failed > 0 && <p>· <strong>{counts.failed}</strong> failed — the provider rejected the send; the exact error is on each row below.</p>}
          </div>
        )}

        {c.unconfirmed > 0 && c.state !== 'sending' && (
          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            {c.unconfirmed} message(s) were claimed but never confirmed (the provider call was interrupted mid-send). They are deliberately
            NOT retried automatically — a retry could double-message the guest. Check the provider log before deciding anything about them.
          </p>
        )}
      </div>

      {/* Recipient report */}
      <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm overflow-hidden">
        <div className="p-3 border-b border-[#F0E4D6] flex items-center gap-1.5 flex-wrap">
          <button
            onClick={() => setRecipFilter('')}
            className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-colors ${!recipFilter ? 'bg-[#af4408] text-white border-[#8a3506]' : 'bg-white text-[#6B5744] border-[#E0D0BE] hover:bg-[#FFF1E3]'}`}
          >
            All {counts.total}
          </button>
          {chipsWithCounts.map(({ st, n }) => (
            <button
              key={st}
              onClick={() => setRecipFilter(recipFilter === st ? '' : st)}
              className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-colors ${recipFilter === st ? 'bg-[#af4408] text-white border-[#8a3506]' : `${REC_STYLE[st]} hover:opacity-80`}`}
            >
              {REC_LABEL[st]} {n}
            </button>
          ))}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-[#FFF1E3] border-b border-[#E8D5C4]">
              <tr className="text-left text-[11px] uppercase tracking-wider text-[#6B5744]">
                <th className="px-3 py-2.5">Guest</th>
                <th className="px-3 py-2.5">State</th>
                <th className="px-3 py-2.5">Sent</th>
                <th className="px-3 py-2.5">Delivered</th>
                <th className="px-3 py-2.5">Read</th>
                <th className="px-3 py-2.5">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F0E4D6]">
              {recips.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-10 text-center text-sm text-[#8B7355]">
                  {recipFilter ? `No recipients in state “${REC_LABEL[recipFilter] || recipFilter}”.` : 'No recipients.'}
                </td></tr>
              )}
              {recips.map(r => (
                <tr key={r.id} className="hover:bg-[#FFFBF6]">
                  <td className="px-3 py-2.5">
                    <div className="font-medium">{r.name || 'Unnamed guest'}</div>
                    <div className="text-xs text-[#8B7355]">{formatPhone(r.phone_e164) || r.phone_e164}</div>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`inline-block px-2 py-0.5 rounded-lg border text-xs font-semibold ${REC_STYLE[r.state] || REC_STYLE.queued}`}>
                      {REC_LABEL[r.state] || r.state}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-[#6B5744] whitespace-nowrap">{istDateTime(r.sent_at)}</td>
                  <td className="px-3 py-2.5 text-xs text-[#6B5744] whitespace-nowrap">{istDateTime(r.delivered_at)}</td>
                  <td className="px-3 py-2.5 text-xs text-[#6B5744] whitespace-nowrap">{istDateTime(r.replied_at || r.read_at)}</td>
                  <td className="px-3 py-2.5 text-xs max-w-[24rem]">
                    {r.error_detail
                      ? <span className={r.state === 'failed' ? 'text-red-700' : 'text-[#8a5a1f]'} title={r.error_detail}>{r.error_detail}</span>
                      : r.wamid
                        ? <span className="text-[#B7A48C] font-mono text-[10px] break-all" title={r.wamid}>{r.wamid.slice(0, 28)}{r.wamid.length > 28 ? '…' : ''}</span>
                        : <span className="text-[#B7A48C]">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {confirmStart && settings && (
        <StartConfirm
          count={counts.queued}
          costRate={settings.cost_per_msg}
          threshold={settings.confirm_threshold}
          templateName={c.template_name}
          language={c.language}
          previewBody={c.preview_body}
          busy={busy}
          onCancel={() => setConfirmStart(false)}
          onConfirm={async () => {
            const ok = await onAction(c.id, 'start', { confirm: true, expect_count: counts.queued });
            if (ok) setConfirmStart(false);
          }}
        />
      )}
    </div>
  );
}

/** The last gate before guests' phones buzz — typed above the threshold. */
function StartConfirm({
  count, costRate, threshold, templateName, language, previewBody, busy, onCancel, onConfirm,
}: {
  count: number; costRate: number; threshold: number;
  templateName: string; language: string; previewBody: string;
  busy: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  const needTyped = count > threshold;
  const phrase = `SEND ${count}`;
  const [typed, setTyped] = useState('');
  const [checked, setChecked] = useState(false);
  const confirmed = needTyped ? typed.trim().toUpperCase() === phrase : checked;

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="bg-white rounded-2xl border border-[#E8D5C4] shadow-xl max-w-lg w-full p-5 space-y-4">
        <h3 className="text-lg font-bold flex items-center gap-2">
          <Send className="w-5 h-5 text-[#af4408]" /> Start sending to {count} guest{count === 1 ? '' : 's'}?
        </h3>

        {previewBody && (
          <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-xl p-3">
            <p className="text-[11px] uppercase tracking-wider text-[#8B7355] mb-1.5">Message body (local copy)</p>
            <p className="text-sm whitespace-pre-wrap">{previewBody}</p>
          </div>
        )}

        <ul className="text-xs text-[#6B5744] space-y-1">
          <li>· Template <code className="text-[#2D1B0E]">{templateName}</code> ({language}) — must already be APPROVED (MARKETING) at the provider.</li>
          <li>· <strong>Meta will bill approximately {money(count * costRate)}</strong> ({count} × {money(costRate)}).</li>
          <li>· Delivery is queued and throttled — consent, cooldown and the daily cap are re-checked on every message, so the final sent count can be lower. That is by design.</li>
          <li>· Pause or cancel any time; it takes effect within one message.</li>
        </ul>

        {needTyped ? (
          <label className="block">
            <span className="text-xs font-semibold text-[#6B5744] uppercase tracking-wider">
              This is over the {threshold}-recipient threshold — type <code className="text-[#af4408]">{phrase}</code> to confirm
            </span>
            <input
              value={typed}
              onChange={e => setTyped(e.target.value)}
              placeholder={phrase}
              autoFocus
              className="mt-1 w-full px-3 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#af4408]/40"
            />
          </label>
        ) : (
          <label className="flex items-start gap-2 text-sm text-[#2D1B0E]">
            <input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} className="accent-[#af4408] mt-0.5" />
            <span>I confirm sending this marketing broadcast to {count} guest{count === 1 ? '' : 's'}.</span>
          </label>
        )}

        <div className="flex gap-2 justify-end">
          <button onClick={onCancel} className="px-4 py-2.5 text-sm font-medium text-[#6B5744] hover:bg-[#FFF1E3] rounded-xl">Cancel</button>
          <button
            onClick={onConfirm}
            disabled={!confirmed || busy}
            className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl text-sm font-semibold"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Start campaign
          </button>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── wizard ───────────────────────── */

type AudKind = 'all_guests' | 'winback' | 'min_visits' | 'birthday_month' | 'tier' | 'phones';

function Wizard({
  settings, templates, venue, flagOn, waOk, onClose, onDone,
}: {
  settings: Settings;
  templates: Tpl[];
  venue: string;
  flagOn: boolean;
  waOk: boolean;
  onClose: () => void;
  onDone: (id: string, notice: string, warnings: string[]) => void;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Step 1 — audience
  const [kind, setKind] = useState<AudKind>('winback');
  const [days, setDays] = useState(60);
  const [includeNever, setIncludeNever] = useState(false);
  const [minVisits, setMinVisits] = useState(3);
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [tier, setTier] = useState('Gold');
  const [phonesText, setPhonesText] = useState('');

  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewErr, setPreviewErr] = useState('');

  // Step 2 — message
  const [templateName, setTemplateName] = useState('');
  const [language, setLanguage] = useState('en');
  const [previewBody, setPreviewBody] = useState('');
  const [slots, setSlots] = useState<BVar[]>(['name']);
  const [pickedTpl, setPickedTpl] = useState('');

  // Step 3 — review
  const [name, setName] = useState(
    `Broadcast · ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}`,
  );
  const [throttleOverride, setThrottleOverride] = useState(0);
  const [typed, setTyped] = useState('');
  const [checked, setChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');

  const audienceDef = useMemo((): Record<string, unknown> | null => {
    switch (kind) {
      case 'all_guests': return { kind };
      case 'winback': return { kind, days, include_never: includeNever };
      case 'min_visits': return minVisits >= 1 ? { kind, visits: minVisits } : null;
      case 'birthday_month': return { kind, month };
      case 'tier': return { kind, tier };
      case 'phones': {
        const phones = phonesText.split(/[\n,;]+/).map(p => p.trim()).filter(Boolean);
        return phones.length ? { kind, phones } : null;
      }
    }
  }, [kind, days, includeNever, minVisits, month, tier, phonesText]);

  // Live preview — debounced 500ms on every audience change.
  const defJson = JSON.stringify(audienceDef);
  useEffect(() => {
    if (!audienceDef) { setPreview(null); setPreviewErr(''); return; }
    let cancelled = false;
    setPreviewBusy(true);
    const t = setTimeout(async () => {
      try {
        const res = await api('/api/crm-calls/broadcasts/preview', { method: 'POST', body: { audience: audienceDef } });
        const j = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
        setPreview(j.preview);
        setPreviewErr('');
      } catch (e) {
        if (!cancelled) { setPreview(null); setPreviewErr(errMsg(e, 'Preview failed')); }
      } finally {
        if (!cancelled) setPreviewBusy(false);
      }
    }, 500);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defJson]);

  const marketingTpls = templates.filter(t => t.category === 'marketing');
  const otherTpls = templates.filter(t => t.category !== 'marketing');

  const applyTemplate = (tplName: string) => {
    setPickedTpl(tplName);
    const t = templates.find(x => x.name === tplName);
    if (!t) return;
    setTemplateName((t.provider_template_name || t.name).trim());
    setLanguage((t.provider_language || t.language || 'en').trim());
    setPreviewBody(t.body || '');
    try {
      const order = JSON.parse(t.param_order || '[]');
      if (Array.isArray(order)) {
        const usable = order.map(String).filter((k): k is BVar => (BROADCAST_VARS as readonly string[]).includes(k));
        setSlots(usable.length ? usable : []);
      }
    } catch { /* keep current slots */ }
  };

  const pickedTplRow = templates.find(x => x.name === pickedTpl);
  const droppedVars = useMemo(() => {
    if (!pickedTplRow) return [];
    try {
      const order = JSON.parse(pickedTplRow.param_order || '[]');
      return Array.isArray(order) ? order.map(String).filter(k => !(BROADCAST_VARS as readonly string[]).includes(k)) : [];
    } catch { return []; }
  }, [pickedTplRow]);

  const sample = preview?.sample?.[0];
  const sampleVars: Record<string, string> = {
    name: sample?.name || 'Guest',
    venue: venue || 'our venue',
    phone: sample?.phone_e164 || '',
  };
  const rendered = renderSample(previewBody, slots, sampleVars);

  const templateNameOk = /^[a-z0-9_]{1,512}$/.test(templateName.trim());
  const eligible = preview?.eligible_now ?? 0;
  const needTyped = eligible > settings.confirm_threshold;
  const phrase = `SEND ${eligible}`;
  const confirmed = needTyped ? typed.trim().toUpperCase() === phrase : checked;

  const create = async (start: boolean) => {
    if (!audienceDef) return;
    setSubmitting(true); setErr('');
    try {
      const res = await api('/api/crm-calls/broadcasts', {
        method: 'POST',
        body: {
          name,
          template_name: templateName.trim(),
          language: language.trim() || 'en',
          param_order: slots,
          preview_body: previewBody,
          audience: audienceDef,
          throttle_per_min: throttleOverride,
        },
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      const id: string = j.campaign.id;
      if (!start) {
        onDone(id, 'Draft created. Nothing has been sent — start it from the campaign screen when ready.', []);
        return;
      }
      const sRes = await api(`/api/crm-calls/broadcasts/${id}/action`, {
        method: 'POST',
        body: { action: 'start', confirm: true, expect_count: j.queued },
      });
      const sj = await sRes.json();
      if (!sRes.ok) {
        onDone(id, '', [
          `The draft was created but NOT started: ${sj.error || `HTTP ${sRes.status}`} You can start it from the campaign screen.`,
        ]);
        return;
      }
      onDone(id, sj.note || 'Campaign started — the throttled queue is doing the rest.', Array.isArray(sj.warnings) ? sj.warnings : []);
    } catch (e) {
      setErr(errMsg(e, 'Could not create the campaign'));
    } finally {
      setSubmitting(false);
    }
  };

  const stepOk = step === 1
    ? !!audienceDef && !!preview && preview.queued > 0
    : step === 2
      ? templateNameOk
      : confirmed && !!name.trim();

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-start sm:items-center justify-center p-3 sm:p-4 overflow-y-auto" role="dialog" aria-modal="true">
      <div className="bg-white rounded-2xl border border-[#E8D5C4] shadow-xl max-w-3xl w-full my-4 sm:my-8">
        {/* Head */}
        <div className="p-4 sm:p-5 border-b border-[#F0E4D6] flex items-start justify-between gap-2">
          <div>
            <h3 className="text-lg font-bold flex items-center gap-2">
              <Megaphone className="w-5 h-5 text-[#af4408]" /> New broadcast campaign
            </h3>
            <div className="flex items-center gap-1.5 mt-2 text-[11px] font-semibold">
              {[1, 2, 3].map(n => (
                <span key={n} className={`px-2.5 py-1 rounded-full border ${step === n
                  ? 'bg-[#af4408] text-white border-[#8a3506]'
                  : step > n ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-[#FFF8F0] text-[#8B7355] border-[#EFE1D0]'}`}>
                  {n}. {n === 1 ? 'Audience' : n === 2 ? 'Message' : 'Review & confirm'}
                </span>
              ))}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg hover:bg-[#FFF1E3] text-[#6B5744]">
            <XCircle className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 sm:p-5 space-y-4">
          {(!flagOn || !waOk) && (
            <p className="text-xs text-[#8a4408] bg-[#FFF1E3] border border-[#F0D9BE] rounded-xl p-3">
              {!flagOn && <>Broadcast sending is currently <strong>OFF</strong> — you can build and even start this campaign, but the queue will not move until an admin enables sending. </>}
              {!waOk && <>The WhatsApp provider is <strong>not configured</strong> — nothing can deliver until Settings → Integrations → WhatsApp is completed.</>}
            </p>
          )}

          {/* ── STEP 1: AUDIENCE ── */}
          {step === 1 && (
            <div className="grid lg:grid-cols-2 gap-4">
              <div className="space-y-3">
                <p className="text-xs font-semibold text-[#6B5744] uppercase tracking-wider">Who should hear from you?</p>
                {([
                  ['winback', 'Lapsed guests', 'Not seen in a while — the win-back window'],
                  ['min_visits', 'Regulars', 'Guests with at least N visits (loyalty or dining)'],
                  ['birthday_month', 'Birthday month', 'Guests with a recorded birthday in a month'],
                  ['tier', 'Loyalty tier', 'Bronze / Silver / Gold by loyalty points'],
                  ['all_guests', 'All guests', 'Everyone we know with a phone number'],
                  ['phones', 'Paste numbers', 'A manual list, one per line'],
                ] as Array<[AudKind, string, string]>).map(([k, label, hint]) => (
                  <label key={k} className={`flex items-start gap-2.5 p-3 rounded-xl border cursor-pointer transition-colors ${kind === k ? 'bg-[#FFF1E3] border-[#af4408]' : 'bg-white border-[#E0D0BE] hover:border-[#af4408]/50'}`}>
                    <input type="radio" name="aud" checked={kind === k} onChange={() => setKind(k)} className="accent-[#af4408] mt-0.5" />
                    <span>
                      <span className="text-sm font-semibold block">{label}</span>
                      <span className="text-xs text-[#8B7355]">{hint}</span>
                    </span>
                  </label>
                ))}

                {kind === 'winback' && (
                  <div className="flex flex-wrap items-center gap-2 pl-1">
                    {[30, 60, 90, 120].map(b => (
                      <button key={b} onClick={() => setDays(b)}
                              className={`px-3 py-1.5 rounded-lg text-xs font-semibold border ${days === b ? 'bg-[#af4408] text-white border-[#8a3506]' : 'bg-white text-[#6B5744] border-[#E0D0BE] hover:bg-[#FFF1E3]'}`}>
                        {b}+ days
                      </button>
                    ))}
                    <label className="flex items-center gap-1.5 text-xs text-[#6B5744]">
                      <input type="checkbox" checked={includeNever} onChange={e => setIncludeNever(e.target.checked)} className="accent-[#af4408]" />
                      include never-visited
                    </label>
                  </div>
                )}
                {kind === 'min_visits' && (
                  <label className="block pl-1 text-xs text-[#6B5744]">
                    At least{' '}
                    <input type="number" min={1} max={1000} value={minVisits}
                           onChange={e => setMinVisits(Math.max(1, Math.min(1000, Number(e.target.value) || 1)))}
                           className="w-20 px-2 py-1.5 mx-1 bg-white border border-[#E0D0BE] rounded-lg text-sm" />
                    visits
                  </label>
                )}
                {kind === 'birthday_month' && (
                  <select value={month} onChange={e => setMonth(Number(e.target.value))}
                          className="ml-1 px-3 py-2 bg-white border border-[#E0D0BE] rounded-xl text-sm">
                    {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                  </select>
                )}
                {kind === 'tier' && (
                  <div className="flex gap-2 pl-1">
                    {['Bronze', 'Silver', 'Gold'].map(t => (
                      <button key={t} onClick={() => setTier(t)}
                              className={`px-3 py-1.5 rounded-lg text-xs font-semibold border ${tier === t ? 'bg-[#af4408] text-white border-[#8a3506]' : 'bg-white text-[#6B5744] border-[#E0D0BE] hover:bg-[#FFF1E3]'}`}>
                        {t}
                      </button>
                    ))}
                  </div>
                )}
                {kind === 'phones' && (
                  <textarea value={phonesText} onChange={e => setPhonesText(e.target.value)} rows={5}
                            placeholder={'One number per line:\n98490 12345\n+91 91234 56789'}
                            className="w-full px-3 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#af4408]/40" />
                )}
              </div>

              {/* Live preview panel */}
              <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-xl p-4 space-y-3 h-fit">
                <p className="text-xs font-semibold text-[#6B5744] uppercase tracking-wider flex items-center gap-1.5">
                  <Users className="w-3.5 h-3.5" /> Live audience preview
                  {previewBusy && <Loader2 className="w-3.5 h-3.5 animate-spin text-[#af4408]" />}
                </p>
                {previewErr && <p className="text-xs text-red-700">{previewErr}</p>}
                {!audienceDef && <p className="text-xs text-[#8B7355]">Complete the audience choice to see who it reaches.</p>}
                {preview && (
                  <>
                    <div>
                      <p className="text-3xl font-bold text-[#af4408] tabular-nums">{preview.eligible_now}</p>
                      <p className="text-xs text-[#6B5744]">would be messaged today</p>
                    </div>
                    <div className="text-xs text-[#6B5744] space-y-1">
                      <p className="font-semibold text-[#2D1B0E]">Excluded, and why:</p>
                      <p>· {preview.excluded.opted_out} opted out of marketing</p>
                      <p>· {preview.excluded.cooldown} inside the {settings.cooldown_days}-day cooldown (already messaged)</p>
                      <p>· {preview.excluded.no_phone} with no usable number</p>
                      <p>· {preview.excluded.deduped} duplicate number(s) collapsed</p>
                      <p className="text-[#8B7355]">{preview.total_candidates} candidate(s) → {preview.queued} queueable → {preview.eligible_now} eligible now</p>
                    </div>
                    <p className="text-sm font-semibold text-[#2D1B0E] flex items-center gap-1.5">
                      <IndianRupee className="w-4 h-4 text-[#af4408]" />
                      Meta will bill approximately {money(preview.cost.estimate)}
                      <span className="font-normal text-xs text-[#8B7355]">({preview.eligible_now} × {money(preview.cost.rate)})</span>
                    </p>
                    {preview.sample.length > 0 && (
                      <div className="text-xs text-[#6B5744]">
                        <p className="font-semibold text-[#2D1B0E] mb-0.5">Sample:</p>
                        {preview.sample.slice(0, 5).map((g, i) => (
                          <p key={i}>{g.name || 'Unnamed'} · {formatPhone(g.phone_e164) || g.phone_e164}</p>
                        ))}
                      </div>
                    )}
                    <p className="text-[10px] text-[#8B7355]">{preview.note}</p>
                  </>
                )}
                {preview && preview.queued === 0 && (
                  <p className="text-xs text-red-700">This audience resolves to nobody with a usable WhatsApp number — adjust it before continuing.</p>
                )}
              </div>
            </div>
          )}

          {/* ── STEP 2: MESSAGE ── */}
          {step === 2 && (
            <div className="space-y-3">
              <div className="rounded-xl bg-[#FFF1E3] border border-[#F0D9BE] p-3 text-xs text-[#6B5744] space-y-1">
                <p className="font-semibold text-[#8a4408]">A broadcast is marketing</p>
                <p>Meta only delivers it from a template your venue has submitted and had <strong>approved in the MARKETING category</strong>. Put the exact approved name below — a wrong name is rejected by the provider, never silently sent as text.</p>
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-xs font-semibold text-[#6B5744] uppercase tracking-wider">Start from a saved template</span>
                  <select value={pickedTpl} onChange={e => applyTemplate(e.target.value)}
                          className="mt-1 w-full px-3 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm">
                    <option value="">— none —</option>
                    {marketingTpls.length > 0 && (
                      <optgroup label="Marketing (what a broadcast should be)">
                        {marketingTpls.map(t => <option key={t.name} value={t.name}>{t.name}</option>)}
                      </optgroup>
                    )}
                    {otherTpls.length > 0 && (
                      <optgroup label="Other saved templates">
                        {otherTpls.map(t => <option key={t.name} value={t.name}>{t.name} ({t.category})</option>)}
                      </optgroup>
                    )}
                  </select>
                </label>
                <label className="block">
                  <span className="text-xs font-semibold text-[#6B5744] uppercase tracking-wider">Approved template name *</span>
                  <input value={templateName} onChange={e => setTemplateName(e.target.value)} placeholder="akan_offer_july"
                         className={`mt-1 w-full px-3 py-2.5 bg-white border rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#af4408]/40 ${templateName && !templateNameOk ? 'border-red-400' : 'border-[#E0D0BE]'}`} />
                  {templateName && !templateNameOk && (
                    <span className="text-[11px] text-red-700">Lowercase letters, digits and underscores only (Meta naming rules).</span>
                  )}
                </label>
                <label className="block">
                  <span className="text-xs font-semibold text-[#6B5744] uppercase tracking-wider">Language code</span>
                  <input value={language} onChange={e => setLanguage(e.target.value)} placeholder="en"
                         className="mt-1 w-full px-3 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm" />
                </label>
                <div className="block">
                  <span className="text-xs font-semibold text-[#6B5744] uppercase tracking-wider">Body variables → {'{{1}}, {{2}}'}, …</span>
                  <div className="mt-1 space-y-1.5">
                    {slots.map((slot, i) => (
                      <div key={i} className="flex items-center gap-1.5">
                        <span className="text-xs text-[#8B7355] font-mono w-10">{`{{${i + 1}}}`}</span>
                        <select value={slot}
                                onChange={e => setSlots(prev => prev.map((x, j) => (j === i ? e.target.value as BVar : x)))}
                                className="flex-1 px-2.5 py-1.5 bg-white border border-[#E0D0BE] rounded-lg text-sm">
                          {BROADCAST_VARS.map(v => <option key={v} value={v}>{v === 'name' ? 'Guest name' : v === 'venue' ? 'Venue name' : 'Guest phone'}</option>)}
                        </select>
                        <button onClick={() => setSlots(prev => prev.filter((_, j) => j !== i))}
                                aria-label={`Remove variable ${i + 1}`}
                                className="p-1.5 rounded-lg hover:bg-red-50 text-[#8B7355] hover:text-red-700">
                          <Minus className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                    {slots.length < 5 && (
                      <button onClick={() => setSlots(prev => [...prev, 'name'])}
                              className="flex items-center gap-1 text-xs font-medium text-[#af4408] hover:underline">
                        <Plus className="w-3.5 h-3.5" /> Add variable
                      </button>
                    )}
                  </div>
                  {droppedVars.length > 0 && (
                    <p className="text-[11px] text-[#8a5a1f] mt-1">
                      This template stored variable(s) a broadcast cannot fill ({droppedVars.join(', ')}) — they were dropped. Broadcasts know only: guest name, venue, guest phone.
                    </p>
                  )}
                </div>
              </div>

              <label className="block">
                <span className="text-xs font-semibold text-[#6B5744] uppercase tracking-wider">Local copy of the approved body (for previews and the guest thread)</span>
                <textarea value={previewBody} onChange={e => setPreviewBody(e.target.value)} rows={3}
                          placeholder="Hi {{1}}, we miss you at {{2}}! Show this message this week for a complimentary dessert."
                          className="mt-1 w-full px-3 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm" />
              </label>

              <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-xl p-3">
                <p className="text-[11px] uppercase tracking-wider text-[#8B7355] mb-1.5 flex items-center gap-1.5">
                  <MessageSquare className="w-3.5 h-3.5" />
                  Preview for {sample ? `${sample.name || 'an unnamed guest'} (${formatPhone(sample.phone_e164) || sample.phone_e164})` : 'the first eligible guest'}
                </p>
                {rendered
                  ? <p className="text-sm whitespace-pre-wrap">{rendered}</p>
                  : <p className="text-sm text-[#8B7355] italic">No local copy of the body — the approved template at the provider decides the wording. Params sent: {slots.join(', ') || 'none'}.</p>}
              </div>
            </div>
          )}

          {/* ── STEP 3: REVIEW ── */}
          {step === 3 && preview && (
            <div className="space-y-3">
              <label className="block">
                <span className="text-xs font-semibold text-[#6B5744] uppercase tracking-wider">Campaign name</span>
                <input value={name} onChange={e => setName(e.target.value)}
                       className="mt-1 w-full px-3 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]/40" />
              </label>

              <div className="grid sm:grid-cols-2 gap-3">
                <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-xl p-3 text-sm space-y-1.5">
                  <p className="text-[11px] uppercase tracking-wider text-[#8B7355]">Audience</p>
                  <p className="font-semibold">{audienceLabel(audienceDef as AudienceMeta)}</p>
                  <p className="text-xs text-[#6B5744]">
                    {preview.queued} will be queued · {preview.eligible_now} eligible today ·{' '}
                    {preview.excluded.opted_out + preview.excluded.cooldown} excluded (opt-out / cooldown), {preview.excluded.no_phone} no number, {preview.excluded.deduped} duplicates
                  </p>
                </div>
                <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-xl p-3 text-sm space-y-1.5">
                  <p className="text-[11px] uppercase tracking-wider text-[#8B7355]">Message</p>
                  <p className="font-semibold font-mono text-xs">{templateName} ({language})</p>
                  <p className="text-xs text-[#6B5744] whitespace-pre-wrap line-clamp-3">{rendered || 'Provider template decides the wording.'}</p>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between bg-[#FFF1E3] border border-[#F0D9BE] rounded-xl p-3">
                <p className="text-sm font-semibold flex items-center gap-1.5">
                  <IndianRupee className="w-4 h-4 text-[#af4408]" />
                  Meta will bill approximately {money(preview.cost.estimate)}
                  <span className="font-normal text-xs text-[#8B7355]">({preview.eligible_now} × {money(preview.cost.rate)})</span>
                </p>
                <label className="text-xs text-[#6B5744] flex items-center gap-1.5">
                  Own throttle (0 = global {settings.msgs_per_min}/min):
                  <input type="number" min={0} max={240} value={throttleOverride}
                         onChange={e => setThrottleOverride(Math.max(0, Math.min(240, Number(e.target.value) || 0)))}
                         className="w-16 px-2 py-1 bg-white border border-[#E0D0BE] rounded-lg text-sm" />
                </label>
              </div>

              <ul className="text-xs text-[#6B5744] space-y-1">
                <li>· Consent, cooldown and the daily cap are re-checked when each message is actually sent — a STOP that arrives after this preview still wins.</li>
                <li>· You can pause or cancel while it runs; it takes effect within one message.</li>
              </ul>

              {needTyped ? (
                <label className="block">
                  <span className="text-xs font-semibold text-[#6B5744] uppercase tracking-wider">
                    Over the {settings.confirm_threshold}-recipient threshold — type <code className="text-[#af4408]">{phrase}</code> to arm the Start button
                  </span>
                  <input value={typed} onChange={e => setTyped(e.target.value)} placeholder={phrase}
                         className="mt-1 w-full px-3 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#af4408]/40" />
                </label>
              ) : (
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} className="accent-[#af4408] mt-0.5" />
                  <span>I confirm sending this marketing broadcast to up to {preview.eligible_now} guest{preview.eligible_now === 1 ? '' : 's'}.</span>
                </label>
              )}
            </div>
          )}

          {err && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl p-3">{err}</p>}
        </div>

        {/* Footer */}
        <div className="p-4 sm:p-5 border-t border-[#F0E4D6] flex items-center justify-between gap-2">
          <button
            onClick={() => (step === 1 ? onClose() : setStep((step - 1) as 1 | 2))}
            className="px-4 py-2.5 text-sm font-medium text-[#6B5744] hover:bg-[#FFF1E3] rounded-xl"
          >
            {step === 1 ? 'Cancel' : '← Back'}
          </button>
          <div className="flex items-center gap-2">
            {step === 3 && (
              <button
                onClick={() => create(false)}
                disabled={submitting || !name.trim() || !templateNameOk}
                className="px-4 py-2.5 bg-white border border-[#E0D0BE] hover:border-[#af4408] text-[#6B5744] rounded-xl text-sm font-medium disabled:opacity-40"
              >
                Save as draft
              </button>
            )}
            {step < 3 ? (
              <button
                onClick={() => setStep((step + 1) as 2 | 3)}
                disabled={!stepOk}
                className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl text-sm font-semibold"
              >
                Continue →
              </button>
            ) : (
              <button
                onClick={() => create(true)}
                disabled={submitting || !confirmed || !name.trim() || !templateNameOk}
                className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl text-sm font-semibold"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                Create &amp; start
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── consent panel ───────────────────────── */

function ConsentPanel() {
  const [rows, setRows] = useState<ConsentRow[]>([]);
  const [loadingRows, setLoadingRows] = useState(true);
  const [q, setQ] = useState('');
  const [lookup, setLookup] = useState<{ phone_key: string; opted_out: boolean; consent: ConsentRow | null; history: ConsentRow[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  // Inline reason form (never a native prompt — the reason lands in the audit log).
  const [flipAction, setFlipAction] = useState<'opt_out' | 'opt_in' | null>(null);
  const [flipReason, setFlipReason] = useState('');

  const loadRows = useCallback(async () => {
    setLoadingRows(true);
    try {
      const res = await api('/api/crm-calls/broadcasts/consent');
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setRows(Array.isArray(j.consent) ? j.consent : []);
    } catch (e) {
      setErr(errMsg(e, 'Could not load the consent register'));
    } finally {
      setLoadingRows(false);
    }
  }, []);

  useEffect(() => { loadRows(); }, [loadRows]);

  const search = async () => {
    if (!q.trim()) return;
    setBusy(true); setErr(''); setNote(''); setLookup(null); setFlipAction(null);
    try {
      const res = await api(`/api/crm-calls/broadcasts/consent?phone=${encodeURIComponent(q.trim())}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setLookup(j);
    } catch (e) {
      setErr(errMsg(e, 'Lookup failed'));
    } finally {
      setBusy(false);
    }
  };

  const flip = async () => {
    if (!lookup || !flipAction) return;
    setBusy(true); setErr(''); setNote('');
    try {
      const res = await api('/api/crm-calls/broadcasts/consent', {
        method: 'POST', body: { phone: lookup.phone_key, action: flipAction, reason: flipReason.trim() },
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      const done = flipAction;
      setFlipAction(null); setFlipReason('');
      await search();
      await loadRows();
      setNote(done === 'opt_out' ? 'Guest opted OUT — every broadcast now skips this number.' : 'Guest opted back IN.');
    } catch (e) {
      setErr(errMsg(e, 'Could not record the change'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-white border border-[#E8D5C4] rounded-2xl p-4 shadow-sm space-y-3">
        <p className="text-sm text-[#6B5744]">
          A guest with <strong>no entry here is messageable</strong> — rows exist only for explicit opt-outs (STOP, Meta error, manual)
          and manual opt-ins. Inbound “START” keywords are deliberately not honoured: the webhook is public, so the only road back in
          after a STOP is a manager recording the guest&apos;s own request here.
        </p>
        <div className="flex gap-2">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8B7355]" />
            <input
              value={q}
              onChange={e => setQ(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') search(); }}
              placeholder="Look up a phone number…"
              className="w-full pl-9 pr-3 py-2.5 bg-[#FFF8F0] border border-[#E0D0BE] rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]/40"
            />
          </div>
          <button onClick={search} disabled={busy || !q.trim()}
                  className="px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-40 text-white rounded-xl text-sm font-semibold">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Look up'}
          </button>
        </div>

        {err && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl p-3">{err}</p>}
        {note && <p className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl p-3">{note}</p>}

        {lookup && (
          <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <p className="text-sm font-semibold flex items-center gap-2">
                {lookup.opted_out
                  ? <ShieldOff className="w-4 h-4 text-red-600" />
                  : <ShieldCheck className="w-4 h-4 text-emerald-600" />}
                {formatPhone('+91' + lookup.phone_key) || lookup.phone_key} —{' '}
                {lookup.opted_out ? <span className="text-red-700">opted OUT of marketing</span>
                  : lookup.consent ? <span className="text-emerald-700">explicitly opted in</span>
                  : <span className="text-[#6B5744]">default (messageable)</span>}
              </p>
              {lookup.opted_out ? (
                <button onClick={() => { setFlipAction('opt_in'); setFlipReason(''); }} disabled={busy}
                        className="px-3 py-1.5 bg-white border border-emerald-300 hover:bg-emerald-50 text-emerald-700 rounded-lg text-xs font-semibold disabled:opacity-50">
                  Opt back in (guest asked)
                </button>
              ) : (
                <button onClick={() => { setFlipAction('opt_out'); setFlipReason(''); }} disabled={busy}
                        className="px-3 py-1.5 bg-white border border-red-300 hover:bg-red-50 text-red-700 rounded-lg text-xs font-semibold disabled:opacity-50">
                  Opt out
                </button>
              )}
            </div>
            {flipAction && (
              <div className="bg-white border border-[#E0D0BE] rounded-lg p-2.5 space-y-2">
                <p className="text-xs text-[#6B5744]">
                  {flipAction === 'opt_in'
                    ? 'Record HOW the guest asked to hear from you again (goes into the audit log — this is the only road back in after a STOP):'
                    : 'Reason for opting this guest OUT of marketing (goes into the audit log):'}
                </p>
                <input
                  value={flipReason}
                  onChange={e => setFlipReason(e.target.value)}
                  placeholder={flipAction === 'opt_in' ? 'e.g. guest asked at the desk on 07 Sep' : 'e.g. guest complained on the phone'}
                  autoFocus
                  className="w-full px-3 py-2 bg-[#FFF8F0] border border-[#E0D0BE] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]/40"
                />
                <div className="flex gap-2 justify-end">
                  <button onClick={() => { setFlipAction(null); setFlipReason(''); }}
                          className="px-3 py-1.5 text-xs font-medium text-[#6B5744] hover:bg-[#FFF1E3] rounded-lg">Cancel</button>
                  <button onClick={flip} disabled={busy || !flipReason.trim()}
                          className={`px-3 py-1.5 rounded-lg text-xs font-semibold text-white disabled:opacity-40 ${flipAction === 'opt_in' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-red-600 hover:bg-red-700'}`}>
                    {busy ? 'Recording…' : flipAction === 'opt_in' ? 'Record opt-in' : 'Record opt-out'}
                  </button>
                </div>
              </div>
            )}
            {lookup.history.length > 0 && (
              <div className="text-xs text-[#6B5744]">
                <p className="font-semibold text-[#2D1B0E] mb-0.5 flex items-center gap-1"><Clock className="w-3 h-3" /> History</p>
                {lookup.history.map((h, i) => (
                  <p key={i}>
                    {istDateTime(h.created_at || h.changed_at)} · <strong>{h.status === 'opted_out' ? 'opted out' : 'opted in'}</strong> via {h.source}
                    {h.detail ? ` (${h.detail})` : ''}{h.changed_by ? ` — by ${h.changed_by}` : ''}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-[#F0E4D6] flex items-center gap-2">
          <FileText className="w-4 h-4 text-[#8B7355]" />
          <p className="text-sm font-semibold">Explicit consent register</p>
          <span className="text-xs text-[#8B7355]">({rows.length} row{rows.length === 1 ? '' : 's'})</span>
        </div>
        {loadingRows ? (
          <div className="py-10 text-center"><Loader2 className="w-6 h-6 text-[#af4408] animate-spin mx-auto" /></div>
        ) : rows.length === 0 ? (
          <p className="py-10 text-center text-sm text-[#8B7355]">No explicit opt-outs or opt-ins recorded yet — everyone is messageable by default.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[#FFF1E3] border-b border-[#E8D5C4]">
                <tr className="text-left text-[11px] uppercase tracking-wider text-[#6B5744]">
                  <th className="px-3 py-2.5">Phone</th>
                  <th className="px-3 py-2.5">Standing</th>
                  <th className="px-3 py-2.5">Via</th>
                  <th className="px-3 py-2.5">Detail</th>
                  <th className="px-3 py-2.5">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F0E4D6]">
                {rows.map(r => (
                  <tr key={r.phone_key} className="hover:bg-[#FFFBF6] cursor-pointer" onClick={() => { setQ(r.phone_key); setLookup(null); }}>
                    <td className="px-3 py-2.5 font-medium">{formatPhone('+91' + r.phone_key) || r.phone_key}</td>
                    <td className="px-3 py-2.5">
                      <span className={`inline-block px-2 py-0.5 rounded-lg border text-xs font-semibold ${r.status === 'opted_out' ? 'bg-red-50 text-red-700 border-red-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'}`}>
                        {r.status === 'opted_out' ? 'opted out' : 'opted in'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-[#6B5744]">{r.source}</td>
                    <td className="px-3 py-2.5 text-xs text-[#6B5744] max-w-[18rem] truncate" title={r.detail}>{r.detail || '—'}</td>
                    <td className="px-3 py-2.5 text-xs text-[#6B5744] whitespace-nowrap">{istDateTime(r.changed_at || r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
