'use client';

/**
 * CRM — Telephony console (admin only).
 *
 * The owner-facing view of the TeleCMI ACCOUNT itself, as opposed to
 * /crm-calls/settings which configures how this app reacts to calls. Five
 * things live here because each of them fails silently in production:
 *
 *   1 Account balance — TeleCMI simply stops connecting calls when the wallet
 *     empties. Nothing in the app announces that; the phones just go quiet.
 *   2 Call analysis vs OUR ct_calls — the single most valuable number on this
 *     page is the GAP between them. TeleCMI's own count is ground truth; ours
 *     comes from the CDR webhook. When they diverge, webhooks are not arriving
 *     and every downstream feature (recovery queue, attribution, win-back) is
 *     quietly working off half the calls.
 *   3 Agents — extensions, working hours and SMS notify, plus whether each one
 *     is mapped to an FNB user (an unmapped GRE cannot click-to-call).
 *   4 Caller ID — which outbound number an agent presents.
 *   5 Recordings — whether a CDR webhook has EVER arrived, and what TeleCMI
 *     actually puts in its recording field. Read-only. The player fails with a
 *     flat "invalid" that cannot distinguish three completely different
 *     problems: a value that is a filename rather than a URL, an account with
 *     recording switched off, and a CDR webhook that has never reached us at
 *     all. The last of those is not a code problem, and only this panel can
 *     say so.
 *   6 Recording retention — the one WRITABLE control on this page that is not
 *     a TeleCMI account setting: how long a recording stays reachable through
 *     this app (7 / 15 / 30 days). It sits here rather than in CRM Settings
 *     because it belongs beside the recording diagnostic it constrains, and
 *     because the panel has to state plainly what it does and does not do —
 *     no audio is stored on this server, so the window governs playability,
 *     not files. See src/lib/ct/retention.ts.
 *
 * WHY CALLER ID NEEDS A PASSWORD: TeleCMI scopes caller-ID to the USER, not the
 * account, so the app secret cannot read or set it (see src/lib/ct/telecmi-api.ts
 * — the "two auth worlds" note). It needs a 30-day user token minted from that
 * agent's own id + password. The password is typed here, posted once, and never
 * kept in the browser; the token lives server-side.
 *
 * APIs (all admin-gated, all POSTs CSRF-protected via @/lib/api):
 *   GET  /api/telecmi/balance
 *   GET  /api/telecmi/analysis?days=N
 *   GET  /api/telecmi/agents      POST /api/telecmi/agents   (add|update|refresh)
 *   POST /api/telecmi/callerid    (login|list|set)
 *   GET  /api/telecmi/recording-diagnostic
 *   GET  /api/telecmi/recording-retention   PUT /api/telecmi/recording-retention
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Phone, Wallet, BarChart3, Users, PhoneOutgoing, Loader2, AlertCircle,
  AlertTriangle, CheckCircle2, RefreshCw, Lock, Plus, Pencil, KeyRound,
  Link2Off, PlugZap, X, Save, Info, FileAudio, Timer,
} from 'lucide-react';
import { api } from '@/lib/api';
import Toggle from '@/components/Toggle';

/* ── Contracts (mirrors the API routes; kept loose where TeleCMI is loose) ── */

type BalanceResp = {
  configured: boolean;
  balance: number | null;
  sms: number | null;
  expire: number | null;
  error?: string;
};

type AnalysisResp = {
  configured: boolean;
  days: number;
  start: number;
  end: number;
  total: number | null;
  answered: number | null;
  missed: number | null;
  /** 0..100, one decimal. null when TeleCMI reported no calls at all. */
  answer_rate: number | null;
  local: { total: number; answered: number; missed: number };
  error?: string;
};

type AgentRow = {
  agent_id: string;
  name: string;
  extension: number | null;
  phone: string;
  notify: boolean | null;
  start_time: number | null;
  end_time: number | null;
  /** The FNB user this TeleCMI agent is mapped to, from ct_settings.agent_map. */
  mapped_email: string | null;
  /**
   * Set when THIS row alone failed to enrich (the route keeps one dead agent id
   * from blanking the whole roster). It must be rendered: without it the row
   * shows empty name/phone/hours, which reads as "this agent has no details"
   * when the truth is we never got an answer from TeleCMI about them.
   */
  error: string | null;
};

type AgentsResp = { configured: boolean; agents: AgentRow[]; error?: string };

type CallerIdEntry = { pstn: number; price: number; capacity: number; profile: string };

/** Per-agent caller-ID session. The password is deliberately NOT in here — it
 *  lives in a field-local state that is wiped the moment the login returns. */
type CallerIdSession = {
  expires_at: number | string | null;
  callerids: CallerIdEntry[] | null;
  selected: number | null;
  busy: 'login' | 'list' | 'set' | null;
  error: string | null;
  flash: string | null;
};

const DAY_CHOICES = [1, 7, 30, 90] as const;

/** Below this the wallet is close enough to empty that calls will start
 *  failing before anyone thinks to check — worth an amber shout. */
const LOW_BALANCE_INR = 500;

/* ── Recording diagnostic contracts (GET /api/telecmi/recording-diagnostic) ──
 * Everything is optional because that route answers 200-with-`error` rather
 * than a 500, exactly as /balance does: a diagnostic that dies silently is
 * worse than no diagnostic. */

type DiagField = {
  /** Original spelling as TeleCMI sent it, e.g. filename or data.filename. */
  path: string;
  recording_key: boolean;
  /** The one the mapper actually used (first recognised key wins). */
  winner: boolean;
  value: string;
  redacted: boolean;
  truncated: boolean;
  /** Type + length + a coarse hint. Never the value — see the route's leak note. */
  shape: string;
};

type DiagCdr = {
  log_id: string;
  received_at: string;
  telecmi_call_id: string;
  processed: boolean;
  ingest_error: string;
  payload_readable: boolean;
  field_count: number;
  recording_fields: DiagField[];
  other_fields: { path: string; shape: string }[];
  normalized_recording_url: string;
  /** none | passthrough (already a URL) | joined (filename + base) | dropped. */
  transform: 'none' | 'passthrough' | 'joined' | 'dropped';
  applied_base: string;
  validation: { checked: boolean; ok: boolean; error: string; host: string };
  /** Plain-language verdict. Owned by the ROUTE so there is one wording, not two. */
  headline: string;
};

type RecordingDiagResp = {
  generated_at: string;
  error?: string;
  webhooks?: {
    cdr_count: number;
    cdr_newest_at: string;
    cdr_processed: number;
    cdr_errored: number;
    live_count: number;
    live_newest_at: string;
    token_configured: boolean;
    headline: string;
  };
  latest_cdr?: DiagCdr | null;
  recording_scan?: {
    limit: number;
    scanned: number;
    with_recording_value: number;
    sample: DiagCdr | null;
    sample_is_latest: boolean;
  };
  allowlist?: string[];
  stored?: {
    calls_total: number;
    with_recording_url: number;
    fixture_recordings: number;
    real_recordings: number;
    headline: string;
  };
};

/* ── Recording retention (GET/PUT /api/telecmi/recording-retention) ────────
 * `stores_audio` is the one field the copy in this panel hangs off: it is the
 * server saying whether any recording bytes are kept on this box. It is false
 * today, and the panel must SAY so rather than imply files are being deleted
 * on a schedule that never deletes anything. */
type RetentionResp = {
  days: number;
  choices: number[];
  default_days: number;
  source: 'db' | 'default';
  swept_to: string | null;
  local_store: string;
  stores_audio: boolean;
  /** `capped` = the real number is higher; the count stops early on purpose. */
  expired_recordings: { count: number; capped: boolean };
  error?: string;
};

/* ── Formatting helpers ───────────────────────────────────────────────────── */

const money = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const count = (n: number) => Number(n || 0).toLocaleString('en-IN');

/** TeleCMI is inconsistent about epochs (seconds vs ms) and our own routes may
 *  pass an ISO string through, so accept all three rather than print "Invalid
 *  Date" at an owner who is trying to work out when a login stops working. */
function fmtWhen(v: number | string | null | undefined): string {
  if (v == null || v === '') return '—';
  let ms: number;
  if (typeof v === 'number') ms = v < 1e11 ? v * 1000 : v;
  else {
    const asNum = Number(v);
    if (Number.isFinite(asNum) && String(v).trim() !== '') ms = asNum < 1e11 ? asNum * 1000 : asNum;
    else ms = Date.parse(v);
  }
  if (!Number.isFinite(ms)) return String(v);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

/** Working hours as TeleCMI stores them. It returns bare numbers whose meaning
 *  is the 24-hour clock, so 9 → 9:00 and 22 → 22:00; anything that is clearly
 *  not an hour is shown raw instead of being mangled into a fake time. */
function fmtHour(h: number | null | undefined): string | null {
  if (h == null || !Number.isFinite(Number(h))) return null;
  const n = Number(h);
  if (n >= 0 && n <= 24 && Number.isInteger(n)) return `${String(n).padStart(2, '0')}:00`;
  return String(n);
}

function fmtHours(a: AgentRow): string {
  const s = fmtHour(a.start_time);
  const e = fmtHour(a.end_time);
  if (!s && !e) return '—';
  return `${s ?? '—'} – ${e ?? '—'}`;
}

/** A percentage we may genuinely not know. Never render "0%" for "no calls" —
 *  a zero answer-rate reads as a catastrophe when it actually means silence. */
function fmtPct(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(Number(p))) return '—';
  return `${Number(p).toFixed(1)}%`;
}

/** Coerce whatever the route sends into a usable AgentRow (TeleCMI's own
 *  payload is loosely typed and a missing extension must not print "NaN"). */
function normalizeAgent(a: any): AgentRow {
  const num = (v: any): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    agent_id: String(a?.agent_id ?? ''),
    name: String(a?.name ?? ''),
    extension: num(a?.extension),
    phone: String(a?.phone ?? ''),
    // NULLABLE ON PURPOSE. TeleCMI omits `notify` when it does not know, and
    // collapsing that to false here would make the edit form show SMS alerts as
    // OFF and then POST sms_alert:false — silently disabling a real agent's
    // alerts as a side effect of renaming them. Unknown must stay unknown until
    // the admin actually chooses.
    notify: a?.notify == null ? null : Boolean(a.notify),
    start_time: num(a?.start_time),
    end_time: num(a?.end_time),
    mapped_email: a?.mapped_email ? String(a.mapped_email) : null,
    error: a?.error ? String(a.error) : null,
  };
}

type GetResult<T> = { ok: true; data: T } | { ok: false; error: string; locked?: boolean };

/** One GET path for every section: a failed load must never fall through and
 *  render as a tidy empty success state ("0 agents", "₹0 balance"). */
async function getJson<T>(url: string): Promise<GetResult<T>> {
  try {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (r.status === 401 || r.status === 403) return { ok: false, error: 'Admin only', locked: true };
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: (j as any)?.error || `HTTP ${r.status}` };
    return { ok: true, data: j as T };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Network error' };
  }
}

/* ── Small presentational pieces ──────────────────────────────────────────── */

function SectionCard({
  icon, title, subtitle, right, children,
}: {
  icon: React.ReactNode; title: string; subtitle?: string;
  right?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
      <div className="px-3 sm:px-4 py-2.5 bg-[#FFF1E3] border-b border-[#E8D5C4] flex flex-wrap items-center gap-2">
        {icon}
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-[#2D1B0E]">{title}</h2>
          {subtitle && <p className="text-[10px] text-[#6B5744] mt-0.5">{subtitle}</p>}
        </div>
        {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
      </div>
      <div className="p-3 sm:p-4">{children}</div>
    </section>
  );
}

/** "Not configured" is a state, not a failure — say what to do about it. */
function NotConfigured({ what }: { what: string }) {
  return (
    <div className="border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] p-3 flex items-start gap-2">
      <PlugZap className="w-4 h-4 text-[#8B7355] shrink-0 mt-0.5" />
      <p className="text-xs text-[#6B5744]">
        <strong className="text-[#2D1B0E]">TeleCMI is not configured</strong> — {what} needs the
        account App ID and Secret. Add them under{' '}
        <a href="/crm-calls/settings" className="text-[#af4408] underline underline-offset-2">CRM Settings</a>{' '}
        (TeleCMI connection), then reload this page. Nothing here is guessed while it is unset:
        an invented balance or call count is worse than an honest blank.
      </p>
    </div>
  );
}

function ErrorBox({ msg, onRetry }: { msg: string; onRetry?: () => void }) {
  return (
    <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm flex items-center gap-2">
      <AlertCircle className="w-4 h-4 shrink-0" />
      <span className="min-w-0 break-words">{msg}</span>
      {onRetry && (
        <button onClick={onRetry}
                className="ml-auto shrink-0 px-2.5 py-1 bg-white border border-red-200 rounded text-xs flex items-center gap-1 hover:bg-red-100">
          <RefreshCw className="w-3 h-3" /> Retry
        </button>
      )}
    </div>
  );
}

function Spinner({ label }: { label: string }) {
  return (
    <p className="text-sm text-[#8B7355] flex items-center gap-2 py-2">
      <Loader2 className="w-4 h-4 animate-spin" /> {label}
    </p>
  );
}

/* ── Page ─────────────────────────────────────────────────────────────────── */

export default function TelephonyPage() {
  const [locked, setLocked] = useState(false);

  // 1 · Account
  const [bal, setBal] = useState<BalanceResp | null>(null);
  const [balLoading, setBalLoading] = useState(true);
  const [balError, setBalError] = useState<string | null>(null);

  // 2 · Call analysis
  const [days, setDays] = useState<number>(7);
  const [an, setAn] = useState<AnalysisResp | null>(null);
  const [anLoading, setAnLoading] = useState(true);
  const [anError, setAnError] = useState<string | null>(null);

  // 3 · Agents
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [agentsConfigured, setAgentsConfigured] = useState(true);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [agentsWarn, setAgentsWarn] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ mode: 'add' } | { mode: 'edit'; agent: AgentRow } | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [agentFlash, setAgentFlash] = useState<string | null>(null);

  // 4 · Caller ID
  const [sessions, setSessions] = useState<Record<string, CallerIdSession>>({});
  const [pwDraft, setPwDraft] = useState<Record<string, string>>({});

  // 5 · Recording diagnostic
  const [diag, setDiag] = useState<RecordingDiagResp | null>(null);
  const [diagLoading, setDiagLoading] = useState(true);
  const [diagError, setDiagError] = useState<string | null>(null);

  // 6 · Recording retention
  const [ret, setRet] = useState<RetentionResp | null>(null);
  const [retLoading, setRetLoading] = useState(true);
  const [retError, setRetError] = useState<string | null>(null);
  const [retSaving, setRetSaving] = useState<number | null>(null);
  const [retFlash, setRetFlash] = useState<string | null>(null);

  const loadBalance = useCallback(async () => {
    setBalLoading(true); setBalError(null);
    const r = await getJson<BalanceResp>('/api/telecmi/balance');
    if (!r.ok) {
      if (r.locked) setLocked(true);
      setBalError(r.error);
      setBal(null);
    } else {
      setBal(r.data);
    }
    setBalLoading(false);
  }, []);

  const loadAnalysis = useCallback(async (d: number) => {
    setAnLoading(true); setAnError(null);
    const r = await getJson<AnalysisResp>(`/api/telecmi/analysis?days=${d}`);
    if (!r.ok) {
      if (r.locked) setLocked(true);
      setAnError(r.error);
      setAn(null);
    } else {
      setAn(r.data);
    }
    setAnLoading(false);
  }, []);

  const loadAgents = useCallback(async () => {
    setAgentsLoading(true); setAgentsError(null); setAgentsWarn(null);
    const r = await getJson<AgentsResp>('/api/telecmi/agents');
    if (!r.ok) {
      if (r.locked) setLocked(true);
      setAgentsError(r.error);
      setAgents([]);
    } else {
      const list = Array.isArray(r.data?.agents) ? r.data.agents.map(normalizeAgent) : [];
      setAgents(list);
      setAgentsConfigured(r.data?.configured !== false);
      // A 200 carrying an `error` means "we reached the route but not TeleCMI" —
      // the list may be stale or partial, so say so instead of showing it clean.
      if (r.data?.error) setAgentsWarn(String(r.data.error));
    }
    setAgentsLoading(false);
  }, []);

  useEffect(() => { void loadBalance(); void loadAgents(); }, [loadBalance, loadAgents]);
  useEffect(() => { void loadAnalysis(days); }, [days, loadAnalysis]);

  /* ── 5 · Recording diagnostic ─────────────────────────────────────────────
   * Its own loader and its own effect rather than a line added to the one
   * above: this is a purely additive panel, and nothing already on this page
   * should change shape because it exists. Reads local tables only — no
   * TeleCMI round trip — so it is cheap enough to run on mount. */
  const loadDiag = useCallback(async () => {
    setDiagLoading(true); setDiagError(null);
    const r = await getJson<RecordingDiagResp>('/api/telecmi/recording-diagnostic');
    if (!r.ok) {
      if (r.locked) setLocked(true);
      setDiagError(r.error);
      setDiag(null);
    } else {
      setDiag(r.data);
    }
    setDiagLoading(false);
  }, []);

  useEffect(() => { void loadDiag(); }, [loadDiag]);

  /* ── 6 · Recording retention ──────────────────────────────────────────────
   * Its own loader for the same reason as the diagnostic above: additive, and
   * nothing already on this page changes shape because it exists. Reads
   * ct_settings plus one capped count — no TeleCMI round trip. */
  const loadRetention = useCallback(async () => {
    setRetLoading(true); setRetError(null);
    const r = await getJson<RetentionResp>('/api/telecmi/recording-retention');
    if (!r.ok) {
      if (r.locked) setLocked(true);
      setRetError(r.error);
      setRet(null);
    } else {
      setRet(r.data);
    }
    setRetLoading(false);
  }, []);

  useEffect(() => { void loadRetention(); }, [loadRetention]);

  const saveRetention = async (days: number) => {
    if (retSaving != null) return;
    setRetSaving(days); setRetError(null); setRetFlash(null);
    try {
      const r = await api('/api/telecmi/recording-retention', { method: 'PUT', body: { days } });
      const j = (await r.json().catch(() => ({}))) as Partial<RetentionResp>;
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      // The route answers with the freshly-read state, so the panel shows what
      // the server actually holds rather than what was clicked.
      setRet(j as RetentionResp);
      setRetFlash(`Saved — recordings stay reachable for ${days} days after the call.`);
    } catch (e) {
      setRetError(e instanceof Error ? e.message : 'Could not save the retention period');
    } finally {
      setRetSaving(null);
    }
  };

  /* ── Analysis drift ──────────────────────────────────────────────────────
   * TeleCMI's count is ground truth; ours comes from the CDR webhook. A gap
   * means webhooks are being dropped, and everything built on ct_calls is
   * silently incomplete. Require BOTH a relative and an absolute gap so a
   * single in-flight call on a one-day window is not reported as an outage. */
  const drift = useMemo(() => {
    if (!an || an.total == null) return null;
    const remote = Number(an.total) || 0;
    const local = Number(an.local?.total) || 0;
    const diff = remote - local;
    const base = Math.max(remote, local);
    if (base === 0) return null;
    const pct = (Math.abs(diff) / base) * 100;
    return { remote, local, diff, pct, bad: Math.abs(diff) >= 2 && pct > 5 };
  }, [an]);

  const localRate = useMemo(() => {
    const t = Number(an?.local?.total) || 0;
    if (!an || t === 0) return null;
    return ((Number(an.local.answered) || 0) / t) * 100;
  }, [an]);

  /* ── Agent save (modal submit) ───────────────────────────────────────────── */
  const submitAgent = async (body: Record<string, unknown>): Promise<string | null> => {
    const r = await api('/api/telecmi/agents', { method: 'POST', body });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return j?.error || `HTTP ${r.status}`;
    const saved = j?.agent ? normalizeAgent(j.agent) : null;
    if (saved) {
      setAgents(prev => {
        const i = prev.findIndex(a => a.agent_id === saved.agent_id);
        if (i === -1) return [...prev, saved];
        return prev.map((a, k) => (k === i ? saved : a));
      });
    } else {
      // The route answered ok but did not echo the row — re-pull rather than
      // leave the table showing pre-save values that look like a failed save.
      void loadAgents();
    }
    setAgentFlash(body.action === 'add' ? '✓ Agent created on TeleCMI' : '✓ Agent updated on TeleCMI');
    setTimeout(() => setAgentFlash(null), 4000);
    return null;
  };

  const refreshAgent = async (id: string) => {
    if (refreshingId) return;
    setRefreshingId(id); setAgentsError(null);
    try {
      const r = await api('/api/telecmi/agents', { method: 'POST', body: { action: 'refresh', id } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setAgentsError(j?.error || `Refresh failed (HTTP ${r.status})`); return; }
      if (j?.agent) {
        const saved = normalizeAgent(j.agent);
        setAgents(prev => prev.map(a => (a.agent_id === saved.agent_id ? saved : a)));
      }
    } catch (e: any) {
      setAgentsError(e?.message || 'Refresh failed');
    } finally {
      setRefreshingId(null);
    }
  };

  /* ── Caller ID ───────────────────────────────────────────────────────────── */
  // Hoisted rather than written inline: as object-literal keys sitting BEFORE
  // the two spreads, TypeScript reads them as being overwritten and errors
  // (TS2783). Same precedence either way — defaults, then whatever the session
  // already holds, then the patch — but expressed so the compiler agrees.
  const BLANK_SESSION: CallerIdSession = {
    expires_at: null, callerids: null, selected: null, busy: null, error: null, flash: null,
  };
  const patchSession = (id: string, patch: Partial<CallerIdSession>) =>
    setSessions(prev => ({
      ...prev,
      [id]: { ...BLANK_SESSION, ...(prev[id] || {}), ...patch },
    }));

  const callerIdPost = async (body: Record<string, unknown>) => {
    const r = await api('/api/telecmi/callerid', { method: 'POST', body });
    const j = await r.json().catch(() => ({}));
    // THE TRAP: this route answers HTTP 200 with { ok:false, error } for states
    // it does not treat as server failures — above all "TeleCMI is not
    // configured". Checking only r.ok reads that as a successful sign-in, then
    // reports the resulting empty caller-ID list as fact and lets "Set caller
    // ID" claim success for a call that never left the building. Both flags.
    if (!r.ok || j?.ok === false) throw new Error(j?.error || `HTTP ${r.status}`);
    return j;
  };

  const signIn = async (id: string) => {
    const password = (pwDraft[id] || '').trim();
    if (!password) { patchSession(id, { error: 'Enter this agent’s TeleCMI password.' }); return; }
    patchSession(id, { busy: 'login', error: null, flash: null });
    try {
      const j = await callerIdPost({ action: 'login', id, password });
      // Wipe the typed password the instant it has been used — it is never
      // stored, never re-sent, and must not sit in a field for a passer-by.
      setPwDraft(prev => ({ ...prev, [id]: '' }));
      patchSession(id, {
        busy: null,
        expires_at: j?.expires_at ?? null,
        flash: 'Signed in — this token lasts 30 days.',
      });
      await listCallerIds(id);
    } catch (e: any) {
      patchSession(id, { busy: null, error: e?.message || 'Sign-in failed' });
    }
  };

  const listCallerIds = async (id: string) => {
    patchSession(id, { busy: 'list', error: null });
    try {
      const j = await callerIdPost({ action: 'list', id });
      const list: CallerIdEntry[] = Array.isArray(j?.callerid)
        ? j.callerid.map((c: any) => ({
            pstn: Number(c?.pstn) || 0,
            price: Number(c?.price) || 0,
            capacity: Number(c?.capacity) || 0,
            profile: String(c?.profile ?? ''),
          }))
        : [];
      patchSession(id, { busy: null, callerids: list, selected: list[0]?.pstn ?? null });
    } catch (e: any) {
      patchSession(id, { busy: null, error: e?.message || 'Could not list caller IDs' });
    }
  };

  const applyCallerId = async (id: string) => {
    const s = sessions[id];
    const callerid = s?.selected;
    if (callerid == null) { patchSession(id, { error: 'Pick a caller ID first.' }); return; }
    patchSession(id, { busy: 'set', error: null, flash: null });
    try {
      const j = await callerIdPost({ action: 'set', id, callerid });
      patchSession(id, {
        busy: null,
        flash: `Caller ID set to ${j?.callerid ?? callerid} for outbound calls.`,
      });
    } catch (e: any) {
      patchSession(id, { busy: null, error: e?.message || 'Could not set the caller ID' });
    }
  };

  /* ── Locked (non-admin) ──────────────────────────────────────────────────── */
  if (locked) {
    return (
      <div className="p-4 sm:p-6 max-w-2xl mx-auto">
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center">
          <div className="w-12 h-12 mx-auto rounded-full bg-amber-50 border border-amber-200 flex items-center justify-center mb-3">
            <Lock className="w-5 h-5 text-amber-600" />
          </div>
          <h1 className="text-lg font-bold text-[#2D1B0E]">Admin only</h1>
          <p className="text-sm text-[#8B7355] mt-1">
            Telephony spends real money and changes real phone-system config
            (agents, caller IDs), so it is restricted to admins.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-4 pb-24">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
          <Phone className="w-6 h-6 text-[#af4408]" /> Telephony
        </h1>
        <p className="text-xs text-[#6B5744] mt-0.5">
          The TeleCMI account itself — wallet, call totals, agents and caller IDs. Admin only;
          changes here take effect on the live phone system immediately. For how the app{' '}
          <em>reacts</em> to calls (SLA, webhooks, agent mapping) see{' '}
          <a href="/crm-calls/settings" className="text-[#af4408] underline underline-offset-2">CRM Settings</a>.
        </p>
      </div>

      {/* ── 1 · Account ── */}
      <SectionCard
        icon={<Wallet className="w-4 h-4 text-[#af4408]" />}
        title="Account"
        subtitle="Wallet and SMS credits, straight from TeleCMI."
        right={
          <button onClick={() => void loadBalance()} disabled={balLoading}
                  className="px-2.5 py-1 bg-white border border-[#E8D5C4] rounded text-xs text-[#6B5744] flex items-center gap-1 hover:bg-[#FFF8F0] disabled:opacity-50">
            <RefreshCw className={`w-3 h-3 ${balLoading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        }
      >
        {balLoading ? (
          <Spinner label="Checking the TeleCMI account…" />
        ) : balError ? (
          <ErrorBox msg={balError} onRetry={() => void loadBalance()} />
        ) : !bal ? (
          <ErrorBox msg="No response from the balance API." onRetry={() => void loadBalance()} />
        ) : !bal.configured ? (
          <NotConfigured what="reading the account balance" />
        ) : (
          <div className="space-y-3">
            {bal.error && (
              <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-lg p-2.5 text-xs flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>TeleCMI did not answer cleanly: {bal.error}</span>
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Call balance */}
              {(() => {
                const v = bal.balance;
                const low = v != null && v < LOW_BALANCE_INR;
                return (
                  <div className={`rounded-lg border p-3 ${low ? 'bg-amber-50 border-amber-300' : 'bg-[#FFF8F0] border-[#E8D5C4]'}`}>
                    <p className="text-[10px] uppercase tracking-wide text-[#6B5744]">Call balance</p>
                    <p className={`text-2xl font-bold mt-0.5 ${low ? 'text-amber-800' : 'text-[#2D1B0E]'}`}>
                      {v == null ? '—' : money(v)}
                    </p>
                    {low ? (
                      <p className="text-[11px] text-amber-900 mt-1 flex items-start gap-1.5">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                        <span>
                          Low. When the wallet empties TeleCMI stops connecting calls and nothing in
                          this app announces it — the phones simply go quiet. Top up before it hits zero.
                        </span>
                      </p>
                    ) : (
                      <p className="text-[11px] text-[#6B5744] mt-1">
                        Amber below {money(LOW_BALANCE_INR)}.
                      </p>
                    )}
                  </div>
                );
              })()}

              {/* SMS credits */}
              <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-3">
                <p className="text-[10px] uppercase tracking-wide text-[#6B5744]">SMS credits</p>
                <p className="text-2xl font-bold text-[#2D1B0E] mt-0.5">
                  {bal.sms == null ? '—' : count(bal.sms)}
                </p>
                <p className="text-[11px] text-[#6B5744] mt-1">
                  Used by TeleCMI&rsquo;s own SMS alerts to agents (the <strong>SMS notify</strong>{' '}
                  column below). Guest WhatsApp does not draw on this.
                </p>
              </div>
            </div>

            {/* Shown RAW on purpose. TeleCMI documents no unit for `expire` and
                we have never confirmed one against a live account — it could be
                epoch seconds, epoch ms, or a day count. Guessing by magnitude
                would print a confident, specific, possibly wrong expiry date
                for the account that runs the restaurant's phones, and a wrong
                date is worse than no date. The number is surfaced so an owner
                can match it against the dashboard; it is not interpreted. */}
            {bal.expire != null && (
              <p className="text-[11px] text-[#6B5744] border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] px-2.5 py-1.5">
                TeleCMI also reports <code className="font-mono text-[#2D1B0E]">expire</code> ={' '}
                <strong className="font-mono text-[#2D1B0E]">{String(bal.expire)}</strong> for this
                account. Its unit is undocumented and unconfirmed, so it is shown exactly as
                received rather than converted into a date — check plan validity in the TeleCMI
                dashboard.
              </p>
            )}
          </div>
        )}
      </SectionCard>

      {/* ── 2 · Call analysis ── */}
      <SectionCard
        icon={<BarChart3 className="w-4 h-4 text-[#af4408]" />}
        title="Call analysis"
        subtitle="TeleCMI's own totals, next to what our CDR webhook actually recorded."
        right={
          <div className="flex items-center gap-1 bg-white border border-[#E8D5C4] rounded-lg p-0.5">
            {DAY_CHOICES.map(d => (
              <button key={d} onClick={() => setDays(d)}
                      className={`px-2.5 py-1 rounded text-xs font-medium ${
                        days === d ? 'bg-[#af4408] text-white' : 'text-[#6B5744] hover:bg-[#FFF1E3]'
                      }`}>
                {d}d
              </button>
            ))}
          </div>
        }
      >
        {anLoading ? (
          <Spinner label={`Pulling the last ${days} day${days === 1 ? '' : 's'}…`} />
        ) : anError ? (
          <ErrorBox msg={anError} onRetry={() => void loadAnalysis(days)} />
        ) : !an ? (
          <ErrorBox msg="No response from the analysis API." onRetry={() => void loadAnalysis(days)} />
        ) : (
          <div className="space-y-3">
            {!an.configured && <NotConfigured what="reading TeleCMI's call totals" />}
            {an.error && (
              <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-lg p-2.5 text-xs flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>TeleCMI side unavailable: {an.error} — the &ldquo;Ours&rdquo; column below is still real.</span>
              </div>
            )}

            {/* Say the window out loud. It is a ROLLING one ending at the moment
                you loaded the page, not IST calendar days, because TeleCMI's
                /analysis takes a plain epoch range with no notion of our
                timezone. So these totals can legitimately disagree with the
                dashboard's "today"/"this week" at the edges, and an admin who
                does not know that will read the difference as a bug. */}
            <p className="text-[11px] text-[#6B5744]">
              {fmtWhen(an.start)} → {fmtWhen(an.end)}
              <span className="block text-[10px] text-[#8B7355] mt-0.5">
                A rolling {an.days}-day window ending at load time — not IST calendar days, so
                edge counts can differ slightly from the CRM dashboard. Refresh to re-cut it.
              </span>
            </p>

            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[420px]">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wide text-[#8B7355] border-b border-[#E8D5C4]">
                    <th className="py-1.5 pr-2 font-medium"></th>
                    <th className="py-1.5 px-2 font-medium">TeleCMI</th>
                    <th className="py-1.5 px-2 font-medium">Ours (call log)</th>
                    <th className="py-1.5 pl-2 font-medium">Gap</th>
                  </tr>
                </thead>
                <tbody className="text-[#2D1B0E]">
                  {([
                    ['Total calls', an.total, an.local?.total ?? 0],
                    ['Answered', an.answered, an.local?.answered ?? 0],
                    ['Missed', an.missed, an.local?.missed ?? 0],
                  ] as [string, number | null, number][]).map(([label, remote, local]) => {
                    const gap = remote == null ? null : remote - local;
                    return (
                      <tr key={label} className="border-b border-[#E8D5C4]/60 last:border-0">
                        <td className="py-2 pr-2 text-[#6B5744]">{label}</td>
                        <td className="py-2 px-2 font-semibold tabular-nums">{remote == null ? '—' : count(remote)}</td>
                        <td className="py-2 px-2 font-semibold tabular-nums">{count(local)}</td>
                        <td className={`py-2 pl-2 tabular-nums ${gap && gap !== 0 ? 'text-amber-800 font-semibold' : 'text-[#8B7355]'}`}>
                          {gap == null ? '—' : gap === 0 ? '0' : `${gap > 0 ? '+' : ''}${count(gap)}`}
                        </td>
                      </tr>
                    );
                  })}
                  <tr>
                    <td className="py-2 pr-2 text-[#6B5744]">Answer rate</td>
                    <td className="py-2 px-2 font-semibold tabular-nums">{fmtPct(an.answer_rate)}</td>
                    <td className="py-2 px-2 font-semibold tabular-nums">{fmtPct(localRate)}</td>
                    <td className="py-2 pl-2 text-[#8B7355]">—</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* The whole point of putting the two side by side. */}
            {drift?.bad ? (
              <div className="bg-amber-50 border border-amber-300 text-amber-900 rounded-lg p-3 text-xs flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  <strong>
                    These do not agree — {drift.pct.toFixed(1)}% apart ({count(Math.abs(drift.diff))}{' '}
                    call{Math.abs(drift.diff) === 1 ? '' : 's'}
                    {drift.diff > 0 ? ' missing from our log' : ' extra in our log'}).
                  </strong>{' '}
                  {drift.diff > 0
                    ? 'That normally means the CDR webhook is not reaching us, so the call log, missed-call recovery queue and booking attribution are all working off incomplete data. Re-check the webhook URLs in CRM Settings (type “call report”, method POST) and run a backfill for this window.'
                    : 'We are holding more calls than TeleCMI reports for this window — usually rows carried in by a backfill or a demo seed that fall outside TeleCMI’s own reporting window.'}
                </span>
              </div>
            ) : drift ? (
              <p className="text-[11px] text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-2.5 py-1.5 flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                TeleCMI and our call log agree within {drift.pct.toFixed(1)}% — CDR webhooks are arriving.
              </p>
            ) : an.configured ? (
              <p className="text-[11px] text-[#6B5744] flex items-start gap-1.5">
                <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
                {an.total == null
                  ? 'TeleCMI’s own totals are unavailable for this window, so there is nothing to compare our call log against — the webhook-gap check is the reason this section exists, so retry once TeleCMI answers.'
                  : 'No calls in this window on either side, so there is nothing to compare.'}
              </p>
            ) : null}
          </div>
        )}
      </SectionCard>

      {/* ── 3 · Agents ── */}
      <SectionCard
        icon={<Users className="w-4 h-4 text-[#af4408]" />}
        title="Agents"
        subtitle="TeleCMI extensions. Adding or editing here writes to the live phone system."
        right={
          <>
            <button onClick={() => void loadAgents()} disabled={agentsLoading}
                    className="px-2.5 py-1 bg-white border border-[#E8D5C4] rounded text-xs text-[#6B5744] flex items-center gap-1 hover:bg-[#FFF8F0] disabled:opacity-50">
              <RefreshCw className={`w-3 h-3 ${agentsLoading ? 'animate-spin' : ''}`} /> Refresh
            </button>
            <button onClick={() => setEditing({ mode: 'add' })} disabled={!agentsConfigured}
                    className="px-2.5 py-1 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-40 text-white rounded text-xs flex items-center gap-1">
              <Plus className="w-3 h-3" /> Add agent
            </button>
          </>
        }
      >
        {agentFlash && (
          <div className="mb-3 bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-lg p-2.5 text-xs flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" /> {agentFlash}
          </div>
        )}
        {agentsLoading ? (
          <Spinner label="Loading agents…" />
        ) : agentsError ? (
          <ErrorBox msg={agentsError} onRetry={() => void loadAgents()} />
        ) : !agentsConfigured ? (
          <NotConfigured what="listing and editing agents" />
        ) : (
          <div className="space-y-3">
            {agentsWarn && (
              <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-lg p-2.5 text-xs flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{agentsWarn}</span>
              </div>
            )}

            {agents.length === 0 ? (
              <p className="text-sm text-[#8B7355] py-3 text-center">
                No agents on this TeleCMI account yet. Add one to give a GRE an extension.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[720px]">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wide text-[#8B7355] border-b border-[#E8D5C4]">
                      <th className="py-1.5 pr-2 font-medium">Ext</th>
                      <th className="py-1.5 px-2 font-medium">Name</th>
                      <th className="py-1.5 px-2 font-medium">Phone</th>
                      <th className="py-1.5 px-2 font-medium">Mapped FNB user</th>
                      <th className="py-1.5 px-2 font-medium">Hours</th>
                      <th className="py-1.5 px-2 font-medium">SMS notify</th>
                      <th className="py-1.5 pl-2 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="text-[#2D1B0E]">
                    {agents.map(a => (
                      <Fragment key={a.agent_id}>
                      <tr className={`align-middle ${a.error ? '' : 'border-b border-[#E8D5C4]/60'}`}>
                        <td className="py-2 pr-2 font-semibold tabular-nums">{a.extension ?? '—'}</td>
                        <td className="py-2 px-2">
                          <div>{a.name || <span className="text-[#8B7355]">—</span>}</div>
                          <div className="text-[10px] text-[#8B7355] font-mono">{a.agent_id}</div>
                        </td>
                        <td className="py-2 px-2 tabular-nums">{a.phone || '—'}</td>
                        <td className="py-2 px-2">
                          {a.mapped_email ? (
                            <span className="text-xs">{a.mapped_email}</span>
                          ) : (
                            // Unmapped is not cosmetic: click-to-call rings the
                            // MAPPED agent id, so this GRE cannot dial at all.
                            <span className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 inline-flex items-center gap-1">
                              <Link2Off className="w-3 h-3" /> Not mapped
                            </span>
                          )}
                        </td>
                        <td className="py-2 px-2 text-xs tabular-nums">{fmtHours(a)}</td>
                        <td className="py-2 px-2 text-xs">
                          {a.notify == null
                            ? <span className="text-[#B8A590]" title="TeleCMI did not report this — editing will leave it unchanged">—</span>
                            : a.notify
                              ? <span className="text-emerald-800">On</span>
                              : <span className="text-[#8B7355]">Off</span>}
                        </td>
                        <td className="py-2 pl-2">
                          <div className="flex items-center gap-1.5 justify-end">
                            <button onClick={() => void refreshAgent(a.agent_id)} disabled={refreshingId === a.agent_id}
                                    title="Re-pull this agent from TeleCMI"
                                    className="px-2 py-1 bg-white border border-[#E8D5C4] rounded text-xs text-[#6B5744] hover:bg-[#FFF8F0] disabled:opacity-50 inline-flex items-center gap-1">
                              <RefreshCw className={`w-3 h-3 ${refreshingId === a.agent_id ? 'animate-spin' : ''}`} />
                            </button>
                            {/* Editing an unenriched row is destructive, not just
                                useless: TeleCMI's update is a FULL REPLACE, so
                                saving would push whatever is in this form over
                                the agent's real name, phone and hours — values
                                we never received and therefore cannot preserve.
                                Refresh first, or fix it in TeleCMI. */}
                            <button onClick={() => setEditing({ mode: 'edit', agent: a })}
                                    disabled={Boolean(a.error)}
                                    title={a.error
                                      ? 'Refresh this agent first — we never got their current details, and saving would overwrite them.'
                                      : 'Edit this agent on TeleCMI'}
                                    className="px-2 py-1 bg-white border border-[#E8D5C4] rounded text-xs text-[#6B5744] hover:bg-[#FFF8F0] disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1">
                              <Pencil className="w-3 h-3" /> Edit
                            </button>
                          </div>
                        </td>
                      </tr>
                      {/* The row's own failure, said on the row. Without this the
                          blanks above read as "this agent has no details". */}
                      {a.error && (
                        <tr className="border-b border-[#E8D5C4]/60 last:border-0">
                          <td colSpan={7} className="pb-2 pr-2">
                            <p className="text-[11px] text-amber-900 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 flex items-start gap-1.5">
                              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                              <span>
                                <strong>Details not loaded for this agent.</strong> {a.error} The
                                blanks above are unknown values, not empty ones — use Refresh.
                              </span>
                            </p>
                          </td>
                        </tr>
                      )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="text-[10px] text-[#6B5744]">
              &ldquo;Mapped FNB user&rdquo; comes from the agent mapping in{' '}
              <a href="/crm-calls/settings" className="text-[#af4408] underline underline-offset-2">CRM Settings</a>.
              An unmapped agent still takes calls, but click-to-call cannot dial for them.
            </p>
          </div>
        )}
      </SectionCard>

      {/* ── 4 · Caller ID ── */}
      <SectionCard
        icon={<PhoneOutgoing className="w-4 h-4 text-[#af4408]" />}
        title="Caller ID"
        subtitle="Which number an agent shows when they dial out."
      >
        <div className="space-y-3">
          <div className="border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] p-2.5 flex items-start gap-2">
            <KeyRound className="w-4 h-4 text-[#8B7355] shrink-0 mt-0.5" />
            <p className="text-[11px] text-[#6B5744]">
              <strong className="text-[#2D1B0E]">Why this asks for a password.</strong> TeleCMI scopes
              caller-ID to the <em>user</em>, not the account — the App Secret that powers everything
              else on this page cannot read or change it. Each agent must sign in once with their own
              TeleCMI password to mint a user token. <strong>A sign-in lasts 30 days</strong>, after
              which it must be repeated. The password is sent once and never stored in this browser;
              only the token is kept, server-side.
            </p>
          </div>

          {agentsLoading ? (
            <Spinner label="Loading agents…" />
          ) : agentsError ? (
            <ErrorBox msg={agentsError} onRetry={() => void loadAgents()} />
          ) : !agentsConfigured ? (
            <NotConfigured what="managing caller IDs" />
          ) : agents.length === 0 ? (
            <p className="text-sm text-[#8B7355] py-3 text-center">
              No agents yet — add one above, then sign in here to pick their outbound number.
            </p>
          ) : (
            <div className="space-y-2">
              {agents.map(a => {
                const s = sessions[a.agent_id];
                const signedIn = Boolean(s?.expires_at) || Boolean(s?.callerids);
                const busy = s?.busy ?? null;
                return (
                  <div key={a.agent_id} className="border border-[#E8D5C4] rounded-lg bg-white p-3 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-[#2D1B0E]">
                        {a.name || a.agent_id}
                      </span>
                      <span className="text-[10px] text-[#8B7355] font-mono">{a.agent_id}</span>
                      {signedIn && (
                        <span className="ml-auto text-[10px] text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">
                          Signed in{s?.expires_at ? ` · expires ${fmtWhen(s.expires_at)}` : ''}
                        </span>
                      )}
                    </div>

                    {!signedIn ? (
                      <div className="flex flex-wrap items-end gap-2">
                        <label className="flex-1 min-w-[200px]">
                          <span className="text-[10px] uppercase tracking-wide text-[#6B5744]">
                            {a.name || 'Agent'}&rsquo;s TeleCMI password
                          </span>
                          <input
                            type="password"
                            autoComplete="off"
                            value={pwDraft[a.agent_id] ?? ''}
                            onChange={e => setPwDraft(prev => ({ ...prev, [a.agent_id]: e.target.value }))}
                            onKeyDown={e => { if (e.key === 'Enter') void signIn(a.agent_id); }}
                            placeholder="Not saved — used once to mint a 30-day token"
                            className="w-full mt-0.5 px-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0] focus:outline-none focus:border-[#af4408]"
                          />
                        </label>
                        <button onClick={() => void signIn(a.agent_id)} disabled={busy != null}
                                className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-40 text-white rounded text-xs font-semibold inline-flex items-center gap-1.5">
                          {busy === 'login' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
                          Sign in
                        </button>
                        {/* A token already lives server-side for 30 days, but this
                            page cannot see it — so without this button an admin is
                            asked for the password on every single page load, which
                            is precisely what a 30-day token exists to avoid. Try
                            the stored one first; if it is missing or expired the
                            route says so exactly, and the password box is right
                            here. */}
                        <button onClick={() => void listCallerIds(a.agent_id)} disabled={busy != null}
                                title="Reuse the token from a previous sign-in, if it is still valid"
                                className="px-2.5 py-1.5 bg-white border border-[#E8D5C4] rounded text-xs text-[#6B5744] hover:bg-[#FFF8F0] disabled:opacity-40 inline-flex items-center gap-1.5">
                          {busy === 'list' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                          Use existing sign-in
                        </button>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-end gap-2">
                        <label className="flex-1 min-w-[220px]">
                          <span className="text-[10px] uppercase tracking-wide text-[#6B5744]">Available caller IDs</span>
                          <select
                            value={s?.selected ?? ''}
                            onChange={e => patchSession(a.agent_id, { selected: Number(e.target.value) || null, flash: null })}
                            disabled={!s?.callerids?.length || busy === 'set'}
                            className="w-full mt-0.5 px-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0] focus:outline-none focus:border-[#af4408]"
                          >
                            {!s?.callerids?.length && <option value="">— none returned —</option>}
                            {(s?.callerids ?? []).map(c => (
                              <option key={c.pstn} value={c.pstn}>
                                {c.pstn}{c.profile ? ` · ${c.profile}` : ''}{c.capacity ? ` · capacity ${c.capacity}` : ''}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button onClick={() => void listCallerIds(a.agent_id)} disabled={busy === 'list'}
                                className="px-2.5 py-1.5 bg-white border border-[#E8D5C4] rounded text-xs text-[#6B5744] hover:bg-[#FFF8F0] disabled:opacity-50 inline-flex items-center gap-1">
                          <RefreshCw className={`w-3 h-3 ${busy === 'list' ? 'animate-spin' : ''}`} /> Reload
                        </button>
                        <button onClick={() => void applyCallerId(a.agent_id)}
                                disabled={busy === 'set' || s?.selected == null}
                                className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-40 text-white rounded text-xs font-semibold inline-flex items-center gap-1.5">
                          {busy === 'set' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                          Set caller ID
                        </button>
                      </div>
                    )}

                    {s?.error && (
                      <p className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5 flex items-start gap-1.5">
                        <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" /> {s.error}
                      </p>
                    )}
                    {s?.flash && (
                      <p className="text-[11px] text-emerald-800 bg-emerald-50 border border-emerald-200 rounded px-2 py-1.5 flex items-start gap-1.5">
                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-px" /> {s.flash}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </SectionCard>

      {/* ── 5 · Recordings ── */}
      <SectionCard
        icon={<FileAudio className="w-4 h-4 text-[#af4408]" />}
        title="Recordings"
        subtitle="Read-only. Has a CDR ever arrived, and what does TeleCMI actually put in its recording field?"
        right={
          <button onClick={() => void loadDiag()} disabled={diagLoading}
                  className="px-2.5 py-1 bg-white border border-[#E8D5C4] rounded text-xs text-[#6B5744] flex items-center gap-1 hover:bg-[#FFF8F0] disabled:opacity-50">
            <RefreshCw className={`w-3 h-3 ${diagLoading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        }
      >
        {diagLoading ? (
          <Spinner label="Reading the webhook log…" />
        ) : diagError ? (
          <ErrorBox msg={diagError} onRetry={() => void loadDiag()} />
        ) : !diag ? (
          <ErrorBox msg="No response from the recording diagnostic." onRetry={() => void loadDiag()} />
        ) : diag.error ? (
          <ErrorBox msg={diag.error} onRetry={() => void loadDiag()} />
        ) : !diag.webhooks || !diag.stored ? (
          <ErrorBox msg="The recording diagnostic answered without any figures." onRetry={() => void loadDiag()} />
        ) : (
          <div className="space-y-3">
            {/* THE HEADLINE. Zero CDRs is the most useful answer this panel can
                give and the one nobody guesses, so it is stated first, in red,
                before any field-level detail an owner would otherwise start
                debugging. The sentence itself comes from the route — one
                wording, not two that can drift apart. */}
            {diag.webhooks.cdr_count === 0 ? (
              <div className="bg-red-50 border border-red-300 text-red-800 rounded-lg p-3 text-xs flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  <strong className="block mb-1">No call report has ever reached this app.</strong>
                  {diag.webhooks.headline}{' '}
                  Fix it in the TeleCMI CHUB dashboard, not here: a webhook of type{' '}
                  <em>call report</em>, method POST, pointed at this app&rsquo;s CDR URL. The URL is
                  on{' '}
                  <a href="/crm-calls/settings" className="text-[#af4408] underline underline-offset-2">CRM Settings</a>.
                  {!diag.webhooks.token_configured && (
                    <> No webhook token is configured yet either, so open that page first.</>
                  )}
                </span>
              </div>
            ) : (
              <p className="text-[11px] text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-2.5 py-1.5 flex items-start gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-px" />
                <span>{diag.webhooks.headline}</span>
              </p>
            )}

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-3">
                <p className="text-[10px] uppercase tracking-wide text-[#6B5744]">CDRs received</p>
                <p className={`text-2xl font-bold mt-0.5 ${diag.webhooks.cdr_count === 0 ? 'text-red-700' : 'text-[#2D1B0E]'}`}>
                  {count(diag.webhooks.cdr_count)}
                </p>
                <p className="text-[11px] text-[#6B5744] mt-1">
                  {diag.webhooks.cdr_newest_at
                    ? <>Newest {fmtWhen(diag.webhooks.cdr_newest_at)}</>
                    : 'Never'}
                </p>
              </div>

              {/* Live beside CDR on purpose: the PAIR is the diagnosis. Live
                  arriving while CDR is zero rules out the token, the network
                  and the app, and points at one missing URL in TeleCMI. */}
              <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-3">
                <p className="text-[10px] uppercase tracking-wide text-[#6B5744]">Live events</p>
                <p className="text-2xl font-bold text-[#2D1B0E] mt-0.5">{count(diag.webhooks.live_count)}</p>
                <p className="text-[11px] text-[#6B5744] mt-1">
                  Screen-pop feed. Recordings never arrive on these.
                </p>
              </div>

              <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-3">
                <p className="text-[10px] uppercase tracking-wide text-[#6B5744]">Recording URLs stored</p>
                <p className="text-2xl font-bold text-[#2D1B0E] mt-0.5">{count(diag.stored.with_recording_url)}</p>
                <p className="text-[11px] text-[#6B5744] mt-1">
                  of {count(diag.stored.calls_total)} calls in the log
                </p>
              </div>

              <div className={`rounded-lg border p-3 ${diag.stored.real_recordings === 0 && diag.stored.with_recording_url > 0 ? 'bg-amber-50 border-amber-300' : 'border-[#E8D5C4] bg-[#FFF8F0]'}`}>
                <p className="text-[10px] uppercase tracking-wide text-[#6B5744]">Of those, real</p>
                <p className={`text-2xl font-bold mt-0.5 ${diag.stored.real_recordings === 0 && diag.stored.with_recording_url > 0 ? 'text-amber-800' : 'text-[#2D1B0E]'}`}>
                  {count(diag.stored.real_recordings)}
                </p>
                <p className="text-[11px] text-[#6B5744] mt-1">
                  {count(diag.stored.fixture_recordings)} demo fixture
                  {diag.stored.fixture_recordings === 1 ? '' : 's'}
                </p>
              </div>
            </div>

            <p className="text-[11px] text-[#6B5744] border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] px-2.5 py-1.5">
              {diag.stored.headline}
            </p>

            {/* Field-level detail. The newest CDR that actually CARRIES a
                recording is shown first when there is one, because the newest
                CDR overall is very often a missed call with no recording at
                all — and reading that as "TeleCMI never sends one" is the
                wrong conclusion this ordering exists to prevent. */}
            {diag.recording_scan?.sample && (
              <CdrDetail
                cdr={diag.recording_scan.sample}
                label={
                  diag.recording_scan.sample_is_latest
                    ? 'Most recent call report'
                    : 'Most recent call report that carries a recording'
                }
                note={
                  diag.recording_scan.sample_is_latest
                    ? undefined
                    : `Found by looking back through the last ${count(diag.recording_scan.scanned)} report${diag.recording_scan.scanned === 1 ? '' : 's'}; ${count(diag.recording_scan.with_recording_value)} of them carry a recording value.`
                }
              />
            )}

            {diag.latest_cdr && !diag.recording_scan?.sample_is_latest && (
              <CdrDetail
                cdr={diag.latest_cdr}
                label="Most recent call report"
                note={
                  diag.recording_scan && diag.recording_scan.with_recording_value === 0
                    ? `None of the last ${count(diag.recording_scan.scanned)} report${diag.recording_scan.scanned === 1 ? '' : 's'} carried a recording value.`
                    : undefined
                }
              />
            )}

            {diag.allowlist && diag.allowlist.length > 0 && (
              <p className="text-[10px] text-[#8B7355]">
                The player only fetches HTTPS URLs on{' '}
                <span className="font-mono text-[#6B5744]">{diag.allowlist.join(', ')}</span> — set
                by the <span className="font-mono">recording_host_allowlist</span> CRM setting.
                Values are shown here exactly as TeleCMI sent them, with anything that could be a
                credential masked.
              </p>
            )}
          </div>
        )}
      </SectionCard>

      {/* ── 6 · Recording retention ── */}
      <SectionCard
        icon={<Timer className="w-4 h-4 text-[#af4408]" />}
        title="Recording retention"
        subtitle="How long a call recording stays reachable through this app."
        right={
          <button onClick={() => void loadRetention()} disabled={retLoading}
                  className="px-2.5 py-1 bg-white border border-[#E8D5C4] rounded text-xs text-[#6B5744] flex items-center gap-1 hover:bg-[#FFF8F0] disabled:opacity-50">
            <RefreshCw className={`w-3 h-3 ${retLoading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        }
      >
        {retLoading ? (
          <Spinner label="Reading the retention policy…" />
        ) : !ret ? (
          <ErrorBox msg={retError || 'No response from the retention API.'} onRetry={() => void loadRetention()} />
        ) : (
          <div className="space-y-3">
            {/* WHAT THIS ACTUALLY DOES. Said first, and said plainly, because a
                retention control that quietly governs nothing is worse than no
                control: an owner would believe recordings are being deleted
                here. They are not stored here to begin with. */}
            <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-3 flex items-start gap-2">
              <Info className="w-4 h-4 text-[#8B7355] shrink-0 mt-0.5" />
              <div className="text-[11px] text-[#6B5744] space-y-1">
                {ret.stores_audio ? (
                  <p>
                    Recording audio is stored on this server
                    (<span className="font-mono">{ret.local_store}</span>). Files are deleted
                    automatically once they pass the window below, and playback is refused from
                    that moment.
                  </p>
                ) : (
                  <>
                    <p>
                      <strong className="text-[#2D1B0E]">No recording audio is kept on this
                      server.</strong> TeleCMI holds the audio; this app fetches it for each play
                      through an authenticated proxy and writes nothing to disk — so there is no
                      file here to delete, and no storage being consumed.
                    </p>
                    <p>
                      What this window controls today is <strong>reachability</strong>: once a call
                      is older than it, the player refuses the recording for everyone, before any
                      request goes to TeleCMI, and the refusal is written to the audit trail. If
                      recordings are ever stored on this server, the same window and the same
                      expiry job will delete those files — nothing here needs re-configuring.
                    </p>
                  </>
                )}
              </div>
            </div>

            {retError && <ErrorBox msg={retError} onRetry={() => void loadRetention()} />}
            {retFlash && (
              <p className="text-[11px] text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-2.5 py-1.5 flex items-start gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-px" /> <span>{retFlash}</span>
              </p>
            )}

            <div>
              <p className="text-[10px] uppercase tracking-wide text-[#6B5744] mb-1.5">
                Keep recordings reachable for
              </p>
              <div className="flex flex-wrap gap-2">
                {ret.choices.map(d => {
                  const active = d === ret.days;
                  const busy = retSaving === d;
                  return (
                    <button
                      key={d}
                      onClick={() => void saveRetention(d)}
                      disabled={retSaving != null || active}
                      className={`px-3 py-1.5 rounded-lg border text-xs font-semibold flex items-center gap-1.5 disabled:opacity-60 ${
                        active
                          ? 'bg-[#af4408] border-[#af4408] text-white'
                          : 'bg-white border-[#E8D5C4] text-[#6B5744] hover:bg-[#FFF8F0]'
                      }`}
                    >
                      {busy && <Loader2 className="w-3 h-3 animate-spin" />}
                      {d} days
                      {d === ret.default_days && !active && (
                        <span className="text-[9px] font-normal text-[#8B7355]">default</span>
                      )}
                    </button>
                  );
                })}
              </div>
              <p className="text-[10px] text-[#8B7355] mt-1.5">
                In force: <strong className="text-[#2D1B0E]">{ret.days} days</strong>
                {ret.source === 'default'
                  ? ' — the built-in default; nothing has been saved here yet.'
                  : ' — saved on this outlet.'}{' '}
                Shortening the window takes effect immediately, including for calls already logged.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-3">
                <p className="text-[10px] uppercase tracking-wide text-[#6B5744]">Past the window</p>
                <p className="text-2xl font-bold text-[#2D1B0E] mt-0.5">
                  {count(ret.expired_recordings.count)}{ret.expired_recordings.capped ? '+' : ''}
                </p>
                <p className="text-[11px] text-[#6B5744] mt-1">
                  Stored recording links older than {ret.days} days. These no longer play.
                  {ret.expired_recordings.capped && ' Counting stops early on purpose — an exact figure is not worth the query at this size.'}
                </p>
              </div>
              <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-3">
                <p className="text-[10px] uppercase tracking-wide text-[#6B5744]">Expiry job last walked to</p>
                <p className="text-sm font-semibold text-[#2D1B0E] mt-1.5">
                  {ret.swept_to ? fmtWhen(ret.swept_to) : 'Not run yet'}
                </p>
                <p className="text-[11px] text-[#6B5744] mt-1">
                  Calls up to this point have already been through an expiry pass. It runs in the
                  background off normal traffic, never on a schedule of its own.
                </p>
              </div>
            </div>
          </div>
        )}
      </SectionCard>

      {editing && (
        <AgentModal
          mode={editing.mode}
          agent={editing.mode === 'edit' ? editing.agent : null}
          onClose={() => setEditing(null)}
          onSubmit={submitAgent}
        />
      )}
    </div>
  );
}

/* ── One call report, field by field ──────────────────────────────────────────
 *
 * The point of this block is to answer, from real data, the question nobody
 * could answer from the player's flat "Recording URL is invalid": what does
 * TeleCMI actually put in that field? So it prints the field NAMES it sent
 * (the spelling matters — the mapper matches on it), the value of any field
 * the mapper reads as a recording, what the mapper turns that into, and
 * whether the proxy would accept the result.
 *
 * Every other field contributes its name and a SHAPE only, never its value —
 * a CDR can carry account identifiers, and "string(37) https URL" is enough to
 * spot a recording hiding under a name the mapper has never heard of.
 */
function CdrDetail({ cdr, label, note }: { cdr: DiagCdr; label: string; note?: string }) {
  const ok = cdr.validation.checked && cdr.validation.ok;
  const bad = cdr.validation.checked && !cdr.validation.ok;
  return (
    <div className="rounded-lg border border-[#E8D5C4] bg-white overflow-hidden">
      <div className="px-3 py-2 bg-[#FFF8F0] border-b border-[#E8D5C4]">
        <p className="text-xs font-semibold text-[#2D1B0E]">{label}</p>
        <p className="text-[10px] text-[#6B5744] mt-0.5">
          Received {fmtWhen(cdr.received_at)}
          {cdr.telecmi_call_id && <> · call <span className="font-mono">{cdr.telecmi_call_id}</span></>}
          {' · '}{cdr.field_count} field{cdr.field_count === 1 ? '' : 's'}
          {!cdr.processed && <> · <span className="text-amber-800 font-semibold">not ingested</span></>}
        </p>
        {note && <p className="text-[10px] text-[#8B7355] mt-0.5">{note}</p>}
      </div>

      <div className="p-3 space-y-2.5">
        {cdr.ingest_error && (
          <p className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5 flex items-start gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span>Ingest error on this delivery: {cdr.ingest_error}</span>
          </p>
        )}

        <p className={`text-[11px] rounded px-2 py-1.5 flex items-start gap-1.5 border ${
          ok ? 'text-emerald-800 bg-emerald-50 border-emerald-200'
             : 'text-amber-900 bg-amber-50 border-amber-300'}`}>
          {ok ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-px" />
              : <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />}
          <span>{cdr.headline}</span>
        </p>

        {cdr.recording_fields.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[380px]">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wide text-[#8B7355] border-b border-[#E8D5C4]">
                  <th className="py-1.5 pr-2 font-medium">Recording field</th>
                  <th className="py-1.5 pl-2 font-medium">Value as sent</th>
                </tr>
              </thead>
              <tbody className="text-[#2D1B0E]">
                {cdr.recording_fields.map(f => (
                  <tr key={f.path} className="border-b border-[#E8D5C4]/60 last:border-0 align-top">
                    <td className="py-2 pr-2 font-mono text-[11px] whitespace-nowrap">
                      {f.path}
                      {f.winner && (
                        <span className="ml-1.5 px-1 py-px rounded bg-[#FFF1E3] border border-[#E8D5C4] text-[9px] font-sans text-[#6B5744] align-middle">
                          used
                        </span>
                      )}
                    </td>
                    <td className="py-2 pl-2 font-mono text-[11px] break-all">
                      {f.value === '' ? <span className="text-[#8B7355] font-sans italic">empty</span> : f.value}
                      {f.truncated && <span className="text-[#8B7355]">…</span>}
                      {f.redacted && (
                        <span className="ml-1.5 text-[10px] font-sans text-[#8B7355]">
                          (masked — looked like a credential)
                        </span>
                      )}
                      <span className="block text-[10px] font-sans text-[#8B7355] mt-0.5">{f.shape}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* What the normalizer produces, and the proxy's own verdict on it —
            the two halves of the chain the player actually runs. */}
        <div className="rounded border border-[#E8D5C4] bg-[#FFF8F0] px-2.5 py-2 space-y-1">
          <p className="text-[10px] uppercase tracking-wide text-[#6B5744]">Normalizer result</p>
          <p className="font-mono text-[11px] text-[#2D1B0E] break-all">
            {cdr.normalized_recording_url || <span className="font-sans italic text-[#8B7355]">nothing — the mapper stores an empty recording_url</span>}
          </p>
          {/* Say what happened to the value, not just what came out. "Joined"
              is the load-bearing one: it means the URL above was BUILT here,
              so it is only as right as the base it was built from. */}
          {cdr.transform === 'joined' && (
            <p className="text-[10px] text-[#6B5744]">
              Built by pasting the filename onto{' '}
              <span className="font-mono text-[#2D1B0E]">{cdr.applied_base || 'the recording base'}</span>
              {' '}— TeleCMI did not send this URL, we assembled it.
            </p>
          )}
          {cdr.transform === 'passthrough' && (
            <p className="text-[10px] text-[#6B5744]">Sent by TeleCMI exactly like this; nothing was added.</p>
          )}
          {cdr.transform === 'dropped' && (
            <p className="text-[10px] text-amber-900">
              A value arrived and was deliberately discarded rather than guessed at
              {cdr.applied_base && <> (it could not be joined onto <span className="font-mono">{cdr.applied_base}</span>)</>}.
            </p>
          )}
          <p className={`text-[11px] ${bad ? 'text-amber-900' : ok ? 'text-emerald-800' : 'text-[#8B7355]'}`}>
            {ok
              ? <>Passes the player&rsquo;s check (host {cdr.validation.host}).</>
              : bad
                ? <>The player would reject it: &ldquo;{cdr.validation.error}&rdquo; — this is the exact message the audio proxy returns.</>
                : <>Nothing to check.</>}
          </p>
        </div>

        {cdr.other_fields.length > 0 && (
          <details className="text-[11px]">
            <summary className="cursor-pointer text-[#6B5744] hover:text-[#2D1B0E]">
              Every other field TeleCMI sent ({cdr.other_fields.length}) — names and shapes only
            </summary>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {cdr.other_fields.map(f => (
                <span key={f.path}
                      className="px-1.5 py-0.5 rounded border border-[#E8D5C4] bg-[#FFF8F0] text-[10px] text-[#6B5744]">
                  <span className="font-mono text-[#2D1B0E]">{f.path}</span> · {f.shape}
                </span>
              ))}
            </div>
            <p className="text-[10px] text-[#8B7355] mt-1.5">
              Values are withheld here on purpose — a report can carry account identifiers. If a
              recording is hiding under a name the mapper does not know, the name and the shape
              above are what give it away.
            </p>
          </details>
        )}

        {!cdr.payload_readable && (
          <p className="text-[11px] text-[#8B7355]">
            The stored copy of this delivery is not a readable JSON object, so no fields could be
            listed.
          </p>
        )}
      </div>
    </div>
  );
}

/* ── Add / Edit agent modal ───────────────────────────────────────────────── */

function AgentModal({
  mode, agent, onClose, onSubmit,
}: {
  mode: 'add' | 'edit';
  agent: AgentRow | null;
  onClose: () => void;
  /** Resolves to an error string, or null on success. */
  onSubmit: (body: Record<string, unknown>) => Promise<string | null>;
}) {
  const [extension, setExtension] = useState(agent?.extension != null ? String(agent.extension) : '');
  const [name, setName] = useState(agent?.name ?? '');
  const [phone, setPhone] = useState(agent?.phone ?? '');
  const [password, setPassword] = useState('');            // edit: blank = keep
  const [startTime, setStartTime] = useState(agent?.start_time != null ? String(agent.start_time) : '');
  const [endTime, setEndTime] = useState(agent?.end_time != null ? String(agent.end_time) : '');
  const [smsAlert, setSmsAlert] = useState(Boolean(agent?.notify));
  // Was the value ever KNOWN, and did the admin change it? If neither, the
  // update omits sms_alert entirely so TeleCMI keeps whatever it already has.
  const [smsTouched, setSmsTouched] = useState(false);
  const smsKnown = agent?.notify != null;
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isAdd = mode === 'add';
  const numOrUndef = (v: string): number | undefined => {
    const t = v.trim();
    if (t === '') return undefined;
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined;
  };

  const canSave =
    name.trim().length > 0 &&
    phone.trim().length > 0 &&
    (!isAdd || (extension.trim().length > 0 && password.length > 0));

  const submit = async () => {
    if (!canSave || saving) return;
    setSaving(true); setErr(null);
    try {
      const common: Record<string, unknown> = {
        name: name.trim(),
        phone_number: phone.trim(),
        // Add always states it — a new agent has no prior value to preserve.
        ...(isAdd || smsTouched || smsKnown ? { sms_alert: smsAlert } : {}),
      };
      const st = numOrUndef(startTime);
      const et = numOrUndef(endTime);
      if (st !== undefined) common.start_time = st;
      if (et !== undefined) common.end_time = et;

      let body: Record<string, unknown>;
      if (isAdd) {
        const ext = numOrUndef(extension);
        if (ext === undefined) { setErr('Extension must be a number.'); setSaving(false); return; }
        body = { action: 'add', extension: ext, password, ...common };
      } else {
        // TeleCMI's update is a FULL REPLACE and demands a password, so a blank
        // box must OMIT the field entirely — that is the server's signal to
        // resend the stored one. Sending "" here would blank the agent's login.
        body = { action: 'update', id: agent!.agent_id, ...common };
        if (password.length > 0) body.password = password;
      }
      const e = await onSubmit(body);
      if (e) { setErr(e); return; }
      onClose();
    } catch (e: any) {
      setErr(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const inputCls = 'w-full mt-0.5 px-2.5 py-2 border border-[#E8D5C4] rounded-lg text-sm bg-[#FFF8F0] focus:outline-none focus:border-[#af4408]';
  const labelCls = 'text-[10px] uppercase tracking-wide text-[#6B5744]';

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-start sm:items-center justify-center p-4 overflow-y-auto"
         role="dialog" aria-modal="true">
      <div className="bg-white rounded-2xl border border-[#E8D5C4] shadow-xl max-w-lg w-full p-5 space-y-4 my-8">
        <div className="flex items-start gap-2">
          <div className="min-w-0">
            <h3 className="text-lg font-bold text-[#2D1B0E] flex items-center gap-2">
              <Users className="w-5 h-5 text-[#af4408]" />
              {isAdd ? 'Add TeleCMI agent' : 'Edit TeleCMI agent'}
            </h3>
            <p className="text-xs text-[#6B5744] mt-1">
              {isAdd
                ? 'Creates a new extension on the live TeleCMI account.'
                : <>Editing <span className="font-mono">{agent?.agent_id}</span> on the live TeleCMI account.</>}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close"
                  className="ml-auto shrink-0 p-1 text-[#8B7355] hover:text-[#2D1B0E]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          {isAdd ? (
            <label className="block">
              <span className={labelCls}>Extension *</span>
              <input type="number" inputMode="numeric" value={extension}
                     onChange={e => setExtension(e.target.value)} placeholder="101" className={inputCls} />
              <span className="text-[10px] text-[#8B7355]">
                TeleCMI builds the agent id as &lt;extension&gt;_&lt;appid&gt;.
              </span>
            </label>
          ) : (
            <label className="block">
              <span className={labelCls}>Extension</span>
              <input value={agent?.extension ?? ''} disabled className={`${inputCls} opacity-60`} />
              <span className="text-[10px] text-[#8B7355]">Extensions cannot be changed after creation.</span>
            </label>
          )}

          <label className="block">
            <span className={labelCls}>Name *</span>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Priya (GRE)" className={inputCls} />
          </label>

          <label className="block">
            <span className={labelCls}>Phone number *</span>
            <input value={phone} inputMode="tel" onChange={e => setPhone(e.target.value)}
                   placeholder="919876543210" className={inputCls} />
            <span className="text-[10px] text-[#8B7355]">The handset TeleCMI rings for this agent.</span>
          </label>

          <label className="block">
            <span className={labelCls}>Password {isAdd ? '*' : ''}</span>
            <input type="password" autoComplete="new-password" value={password}
                   onChange={e => setPassword(e.target.value)}
                   placeholder={isAdd ? 'Agent’s TeleCMI login password' : 'Leave blank to keep current'}
                   className={inputCls} />
            <span className="text-[10px] text-[#8B7355]">
              {isAdd
                ? 'The agent needs this to sign in for caller ID below.'
                : 'Blank keeps the current password — nothing is sent and the login is untouched.'}
            </span>
          </label>

          <label className="block">
            <span className={labelCls}>Start hour</span>
            <input type="number" min={0} max={24} value={startTime}
                   onChange={e => setStartTime(e.target.value)} placeholder="9" className={inputCls} />
          </label>

          <label className="block">
            <span className={labelCls}>End hour</span>
            <input type="number" min={0} max={24} value={endTime}
                   onChange={e => setEndTime(e.target.value)} placeholder="23" className={inputCls} />
          </label>
        </div>

        {/* Do not promise blank == "keep". TeleCMI's update is a full replace and
            a blank box is simply not sent, so what happens to the stored hours is
            TeleCMI's call, not ours. The boxes are pre-filled from the current
            record precisely so the honest path is to leave them as they are. */}
        <p className="text-[10px] text-[#8B7355] -mt-1">
          Working hours use TeleCMI&rsquo;s 24-hour numbers (9 = 9:00, 23 = 23:00). A blank box is
          not sent at all &mdash; and because TeleCMI replaces the whole agent record on save, the
          safest way to leave hours untouched is to leave the values already filled in above.
        </p>

        <div className="flex items-center gap-2 border border-[#E8D5C4] rounded-lg bg-[#FFFDFB] px-3 py-2">
          <span className="text-xs text-[#2D1B0E] flex-1">
            SMS alert on missed calls
            <span className="block text-[10px] text-[#6B5744]">Draws on the SMS credits shown above.</span>
          </span>
          <Toggle checked={smsAlert} onChange={v => { setSmsAlert(v); setSmsTouched(true); }} size="sm" label="SMS alert on missed calls" />
        </div>

        {err && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl p-3 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> {err}
          </p>
        )}

        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2.5 text-sm font-medium text-[#6B5744] hover:bg-[#FFF1E3] rounded-xl">
            Cancel
          </button>
          <button onClick={() => void submit()} disabled={!canSave || saving}
                  className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-40 text-white rounded-xl text-sm font-semibold">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {isAdd ? 'Create agent' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
