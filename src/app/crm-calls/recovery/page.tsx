'use client';

/**
 * CRM Call-to-Table — Recovery Queue (GRE home base).
 *
 * Every missed/abandoned call lands here with an owner, an SLA deadline and a
 * recorded outcome ("we missed it and nobody noticed" must be structurally
 * impossible). Rows come from GET /api/crm-calls/recoveries (VIP-first, most
 * urgent SLA first); the countdown chips tick client-side every second from
 * sla_due_at (🟢 ok / 🟠 <10 min left / 🔴 breached).
 *
 * Live-ness without SSE on this page: full list refresh every 20s + a light
 * poll of /api/crm-calls/live every 10s that refetches early whenever a
 * recovery_update / call_ended bus event is seen.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { formatPhone } from '@/lib/ct/phone';
import CallbackButton from '@/components/ct/CallbackButton';
import {
  PhoneMissed,
  PhoneIncoming,
  PhoneOutgoing,
  MessageCircle,
  MessageSquare,
  Ban,
  StickyNote,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  CheckCircle,
  AlertCircle,
  Crown,
  UserPlus,
  ExternalLink,
  Clock,
  Loader2,
  Search,
  Flame,
  HelpCircle,
  User,
} from 'lucide-react';

// ── Types (mirror /api/crm-calls/recoveries response) ───────────────────────

interface Attempt {
  at: string;
  by: string;
  method: 'callback' | 'whatsapp' | 'sms' | string;
  outcome?: string;
}

interface SourceCall {
  id: string;
  telecmi_call_id: string;
  direction: string;
  status: string;
  agent_user: string;
  queue: string;
  started_at: string | null;
  ended_at: string | null;
  duration_sec: number;
  disposition: string;
  has_recording: boolean;
}

interface Recovery {
  id: string;
  call_id: string;
  guest_id: string | null;
  phone_e164: string;
  missed_at: string;
  detected_via: string;
  sla_due_at: string;
  status: 'pending' | 'attempting' | 'recovered' | 'unreachable' | 'expired' | 'auto_resolved';
  assigned_to: string;
  attempts: Attempt[];
  first_attempt_at: string | null;
  recovered_at: string | null;
  recovery_call_id: string | null;
  recovery_booking_id: string | null;
  escalated: number;
  escalated_at: string | null;
  resolution_note: string;
  created_at: string;
  updated_at: string;
  guest_name: string | null;
  guest_tags: string[];
  is_vip: boolean;
  sla_state: 'ok' | 'warning' | 'breached';
  call: SourceCall | null;
}

type Counts = Record<string, number>;

interface CtLiveEvent { type: string; seq: number }

// ── Tabs ─────────────────────────────────────────────────────────────────────

const TABS = [
  { key: 'open', label: 'Open', statuses: 'pending,attempting' },
  { key: 'recovered', label: 'Recovered', statuses: 'recovered,auto_resolved' },
  { key: 'unreachable', label: 'Unreachable', statuses: 'unreachable' },
  { key: 'expired', label: 'Expired', statuses: 'expired' },
  { key: 'all', label: 'All', statuses: 'all' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

const OPEN_STATUSES = ['pending', 'attempting'];
const RESOLVED_STATUSES = ['recovered', 'auto_resolved'];
const LIST_REFRESH_MS = 20_000;
const LIVE_POLL_MS = 10_000;
const WARN_MS = 10 * 60 * 1000;

// ── Formatting helpers (store UTC, display IST) ─────────────────────────────

function istDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

function istTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });
}

/** 95s → "1:35"; 4h05m → "4h 5m" (coarse above an hour, ticking below). */
function fmtSpan(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtCallDuration(sec: number): string {
  if (!sec || sec <= 0) return '0:00';
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function callerName(r: Recovery): string {
  return (r.guest_name || '').trim() || formatPhone(r.phone_e164);
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function RecoveryQueuePage() {
  const [tab, setTab] = useState<TabKey>('open');
  const [rows, setRows] = useState<Recovery[]>([]);
  const [counts, setCounts] = useState<Counts>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // `${id}:${action}`
  const [nowMs, setNowMs] = useState(() => Date.now());
  // "What is this?" help — open by default until a staffer dismisses it (remembered).
  const [helpOpen, setHelpOpen] = useState(false);
  useEffect(() => {
    try { setHelpOpen(localStorage.getItem('ct_recovery_help_dismissed') !== '1'); } catch { setHelpOpen(true); }
  }, []);
  const dismissHelp = () => {
    setHelpOpen(false);
    try { localStorage.setItem('ct_recovery_help_dismissed', '1'); } catch { /* ignore */ }
  };
  const [toast, setToast] = useState<{ msg: string; tone: 'success' | 'error' } | null>(null);

  // Inline create-guest form (inside the expanded detail of an unknown caller)
  const [createName, setCreateName] = useState('');

  const tabRef = useRef<TabKey>('open');
  tabRef.current = tab;
  const liveSeqRef = useRef<number | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string, tone: 'success' | 'error' = 'success') => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, tone });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);

  const fetchList = useCallback(async (silent: boolean) => {
    const current = TABS.find(t => t.key === tabRef.current) || TABS[0];
    if (!silent) setLoading(true);
    else setRefreshing(true);
    try {
      const res = await fetch(`/api/crm-calls/recoveries?status=${encodeURIComponent(current.statuses)}`, { cache: 'no-store' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      setRows(Array.isArray(json.recoveries) ? json.recoveries : []);
      setCounts(json.counts && typeof json.counts === 'object' ? json.counts : {});
      setLoadError(null);
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load recovery queue');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Initial load + reload on tab change
  useEffect(() => { fetchList(false); }, [tab, fetchList]);

  // Full list refresh every 20s
  useEffect(() => {
    const t = setInterval(() => fetchList(true), LIST_REFRESH_MS);
    return () => clearInterval(t);
  }, [fetchList]);

  // SSE-lite: poll the live event ring buffer every 10s; refetch early when a
  // recovery_update / call_ended event happened since our last seq.
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const after = liveSeqRef.current ?? 0;
        const res = await fetch(`/api/crm-calls/live?after=${after}`, { cache: 'no-store' });
        if (!res.ok) return;
        const json = await res.json().catch(() => null);
        if (!json || stopped) return;
        const seq = Number(json.seq) || 0;
        if (liveSeqRef.current === null) {
          liveSeqRef.current = seq; // first poll: just sync the cursor
          return;
        }
        liveSeqRef.current = seq;
        const events: CtLiveEvent[] = Array.isArray(json.events) ? json.events : [];
        if (events.some(e => e.type === 'recovery_update' || e.type === 'call_ended')) {
          fetchList(true);
        }
      } catch { /* transient network error — next tick retries */ }
    };
    poll();
    const t = setInterval(poll, LIVE_POLL_MS);
    return () => { stopped = true; clearInterval(t); };
  }, [fetchList]);

  // 1-second tick that drives every SLA countdown chip
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  // Reset per-row UI state when switching tabs
  useEffect(() => { setExpandedId(null); setCreateName(''); }, [tab]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    const qDigits = q.replace(/\D/g, '');
    return rows.filter(r =>
      (r.guest_name || '').toLowerCase().includes(q)
      || (qDigits.length >= 3 && r.phone_e164.replace(/\D/g, '').includes(qDigits))
      || (r.assigned_to || '').toLowerCase().includes(q)
    );
  }, [rows, search]);

  const breachedCount = useMemo(
    () => rows.filter(r => OPEN_STATUSES.includes(r.status) && Date.parse(r.sla_due_at) - nowMs <= 0).length,
    [rows, nowMs],
  );

  const tabCount = useCallback((key: TabKey): number => {
    const n = (s: string) => counts[s] || 0;
    switch (key) {
      case 'open': return n('pending') + n('attempting');
      case 'recovered': return n('recovered') + n('auto_resolved');
      case 'unreachable': return n('unreachable');
      case 'expired': return n('expired');
      case 'all': return Object.values(counts).reduce((a, b) => a + b, 0);
    }
  }, [counts]);

  // ── Row actions ────────────────────────────────────────────────────────────

  const putAction = useCallback(async (r: Recovery, actionKey: string, body: Record<string, unknown>, okMsg: string) => {
    setBusy(`${r.id}:${actionKey}`);
    try {
      const res = await api(`/api/crm-calls/recoveries/${r.id}`, { method: 'PUT', body });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      showToast(okMsg);
      await fetchList(true);
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Action failed', 'error');
    } finally {
      setBusy(null);
    }
  }, [fetchList, showToast]);

  const openWhatsApp = useCallback(async (r: Recovery) => {
    window.open('https://wa.me/' + r.phone_e164.replace('+', ''), '_blank', 'noopener');
    await putAction(r, 'wa', { action: 'attempt', method: 'whatsapp', outcome: 'WhatsApp opened' }, 'WhatsApp opened — attempt logged');
  }, [putAction]);

  const markUnreachable = useCallback(async (r: Recovery) => {
    if (!window.confirm(`Mark ${callerName(r)} as unreachable? This closes the recovery.`)) return;
    const note = window.prompt('Why unreachable? (note)', r.resolution_note || '');
    if (note === null) return;
    await putAction(r, 'unreach', { action: 'unreachable', resolution_note: note }, 'Marked unreachable');
  }, [putAction]);

  const addNote = useCallback(async (r: Recovery) => {
    const note = window.prompt('Note on this recovery', r.resolution_note || '');
    if (note === null) return;
    await putAction(r, 'note', { action: 'note', resolution_note: note }, 'Note saved');
  }, [putAction]);

  const markRecovered = useCallback(async (r: Recovery) => {
    if (!window.confirm(`Mark ${callerName(r)} as recovered (guest reached)?`)) return;
    const note = window.prompt('Resolution note (optional)', r.resolution_note || '');
    if (note === null) return;
    await putAction(r, 'resolve', { action: 'resolve', resolution_note: note }, 'Recovery marked recovered');
  }, [putAction]);

  const createGuest = useCallback(async (r: Recovery) => {
    const name = createName.trim();
    if (!name) { showToast('Enter the guest name first', 'error'); return; }
    setBusy(`${r.id}:guest`);
    try {
      const res = await api('/api/crm-calls/guests', {
        method: 'POST',
        body: { phone: r.phone_e164, name, source: 'call' },
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 409) {
        // Guest already exists for this number — server retro-links on create,
        // and a refetch picks up the existing link either way.
        showToast('A guest with this number already exists — linked');
      } else if (!res.ok) {
        throw new Error(json?.error || `HTTP ${res.status}`);
      } else {
        showToast(`Guest "${name}" created and linked`);
      }
      setCreateName('');
      await fetchList(true);
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Could not create guest', 'error');
    } finally {
      setBusy(null);
    }
  }, [createName, fetchList, showToast]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedId(prev => (prev === id ? null : id));
    setCreateName('');
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] p-6 animate-pulse">
        <div className="max-w-7xl mx-auto space-y-6">
          <div className="h-9 w-72 bg-[#FFF1E3] rounded-lg" />
          <div className="h-10 w-full max-w-lg bg-[#FFF1E3] rounded-xl" />
          {[...Array(4)].map((_, i) => <div key={i} className="bg-white border border-[#E8D5C4] rounded-xl h-20" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 py-5 sm:py-6 space-y-4">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">CRM — Call-to-Table</p>
            <div className="flex items-center gap-3 mt-0.5">
              <h1 className="text-2xl sm:text-3xl font-bold flex items-center gap-2.5">
                <PhoneMissed className="w-7 h-7 text-[#af4408]" />
                Recovery Queue
              </h1>
              {breachedCount > 0 && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-600 text-white text-xs font-bold animate-pulse">
                  <Flame className="w-3.5 h-3.5" />{breachedCount} breached
                </span>
              )}
            </div>
            <p className="text-sm text-[#8B7355] mt-1">No missed call goes untracked — call back before the SLA clock runs out.</p>
          </div>
          <button
            onClick={() => fetchList(true)}
            className="flex items-center gap-2 px-4 py-2.5 bg-white border border-[#E0D0BE] hover:bg-[#FFF1E3] text-[#6B5744] rounded-xl text-sm font-medium shadow-sm transition-colors self-start sm:self-auto"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />Refresh
          </button>
        </div>

        {/* What is this? — plain-language help, dismissible + remembered */}
        {helpOpen ? (
          <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl p-3.5 sm:p-4 text-sm text-[#3D2614]">
            <div className="flex items-start gap-2.5">
              <HelpCircle className="w-5 h-5 text-[#af4408] shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-[#2D1B0E]">What is the Recovery Queue?</p>
                <p className="mt-1 leading-relaxed">
                  Every <b>missed call</b> (nobody picked up) is turned into a <b>call-back task</b> here — so no
                  customer is forgotten. Each one has a <b>deadline</b> (the SLA clock:
                  <span className="text-green-700 font-semibold"> 🟢 on time</span> →
                  <span className="text-amber-600 font-semibold"> 🟠 running low</span> →
                  <span className="text-red-600 font-semibold"> 🔴 over</span>), and VIPs float to the top.
                  Tap <b>Call Back</b>, reach the guest, and turn a missed call into a booking.
                </p>
                <ul className="mt-2 grid sm:grid-cols-2 gap-x-6 gap-y-1 text-[13px] text-[#6B5744]">
                  <li><b className="text-[#8B7355]">Open</b> — missed, waiting for a call-back</li>
                  <li><b className="text-green-700">Recovered</b> — reached the guest &amp; handled it 🎉</li>
                  <li><b className="text-[#8B7355]">Auto-resolved</b> — the guest called again &amp; got through</li>
                  <li><b className="text-red-600">Unreachable / Expired</b> — couldn't reach / deadline passed</li>
                </ul>
                <button onClick={dismissHelp} className="mt-2.5 text-xs font-semibold text-[#af4408] hover:underline">Got it, hide this</button>
              </div>
            </div>
          </div>
        ) : (
          <button onClick={() => setHelpOpen(true)}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-[#8B7355] hover:text-[#af4408]">
            <HelpCircle className="w-3.5 h-3.5" /> What is the Recovery Queue?
          </button>
        )}

        {/* Tabs + search */}
        <div className="flex flex-col lg:flex-row lg:items-center gap-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {TABS.map(t => {
              const on = tab === t.key;
              return (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium whitespace-nowrap transition-colors ${
                    on ? 'bg-[#af4408] text-white border-[#af4408]' : 'bg-white text-[#6B5744] border-[#E0D0BE] hover:bg-[#FFF1E3]'
                  }`}
                >
                  {t.label}
                  <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${on ? 'bg-white/25' : 'bg-[#FFF1E3] text-[#8B7355]'}`}>
                    {tabCount(t.key)}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="relative lg:ml-auto lg:w-72">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8B7355]" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search name / phone / assignee…"
              className="w-full pl-9 pr-3 py-2 bg-white border border-[#E0D0BE] rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]/40 focus:border-[#af4408] shadow-sm"
            />
          </div>
        </div>

        {loadError && (
          <div className="flex items-center gap-2 p-3.5 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
            <AlertCircle className="w-4 h-4 shrink-0" />{loadError}
          </div>
        )}

        {/* Queue */}
        {filteredRows.length === 0 ? (
          <div className="bg-white border border-[#E8D5C4] rounded-xl py-16 text-center text-[#8B7355]">
            {tab === 'open' && !search ? (
              <>
                <CheckCircle className="w-10 h-10 mx-auto mb-3 text-green-500" />
                <p className="font-medium text-[#2D1B0E]">All clear — no missed calls waiting</p>
                <p className="text-xs mt-1">New missed calls appear here automatically with an SLA countdown.</p>
              </>
            ) : (
              <>
                <PhoneMissed className="w-10 h-10 mx-auto mb-3 opacity-40" />
                <p>No recoveries in this view</p>
                {search && <p className="text-xs mt-1">Try clearing the search.</p>}
              </>
            )}
          </div>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden md:block bg-white border border-[#E8D5C4] rounded-xl shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-wide text-[#8B7355] border-b border-[#E8D5C4] bg-[#FFF8F0]">
                      <th className="w-8" aria-label="Expand"></th>
                      <th className="text-left py-3 px-2 font-semibold">Caller</th>
                      <th className="text-left py-3 px-3 font-semibold">Missed (IST)</th>
                      <th className="text-left py-3 px-3 font-semibold">SLA</th>
                      <th className="text-center py-3 px-3 font-semibold">Attempts</th>
                      <th className="text-left py-3 px-3 font-semibold">Assigned</th>
                      {tab === 'all' && <th className="text-left py-3 px-3 font-semibold">Status</th>}
                      <th className="text-right py-3 px-4 font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.map(r => {
                      const expanded = expandedId === r.id;
                      return (
                        <RowGroup
                          key={r.id}
                          r={r}
                          nowMs={nowMs}
                          expanded={expanded}
                          showStatusCol={tab === 'all'}
                          busy={busy}
                          onToggle={() => toggleExpand(r.id)}
                          onCallbackLogged={() => fetchList(true)}
                          onWhatsApp={() => openWhatsApp(r)}
                          onUnreachable={() => markUnreachable(r)}
                          onNote={() => addNote(r)}
                          onRecovered={() => markRecovered(r)}
                          createName={createName}
                          setCreateName={setCreateName}
                          onCreateGuest={() => createGuest(r)}
                        />
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Mobile cards */}
            <div className="md:hidden space-y-2.5">
              {filteredRows.map(r => (
                <MobileCard
                  key={r.id}
                  r={r}
                  nowMs={nowMs}
                  expanded={expandedId === r.id}
                  busy={busy}
                  onToggle={() => toggleExpand(r.id)}
                  onCallbackLogged={() => fetchList(true)}
                  onWhatsApp={() => openWhatsApp(r)}
                  onUnreachable={() => markUnreachable(r)}
                  onNote={() => addNote(r)}
                  onRecovered={() => markRecovered(r)}
                  createName={createName}
                  setCreateName={setCreateName}
                  onCreateGuest={() => createGuest(r)}
                />
              ))}
            </div>

            <p className="text-xs text-[#8B7355]">
              {filteredRows.length} recover{filteredRows.length === 1 ? 'y' : 'ies'} shown · VIP callers float to the top · auto-refreshes every 20s
            </p>
          </>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-5 py-3 text-white rounded-lg shadow-lg ${toast.tone === 'success' ? 'bg-green-600' : 'bg-red-600'}`}>
          {toast.tone === 'success' ? <CheckCircle className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
          <span className="text-sm font-medium">{toast.msg}</span>
        </div>
      )}
    </div>
  );
}

// ── Shared row/card action props ─────────────────────────────────────────────

interface RowActions {
  r: Recovery;
  nowMs: number;
  expanded: boolean;
  busy: string | null;
  onToggle: () => void;
  onCallbackLogged: () => void;
  onWhatsApp: () => void;
  onUnreachable: () => void;
  onNote: () => void;
  onRecovered: () => void;
  createName: string;
  setCreateName: (v: string) => void;
  onCreateGuest: () => void;
}

/** Attempts are allowed on everything except recovered/auto_resolved. */
function isWorkable(r: Recovery): boolean {
  return !RESOLVED_STATUSES.includes(r.status);
}

// ── Desktop row (+ expanded detail row) ──────────────────────────────────────

function RowGroup(props: RowActions & { showStatusCol: boolean }) {
  const { r, nowMs, expanded, showStatusCol, busy, onToggle, onCallbackLogged, onWhatsApp, onUnreachable, onNote } = props;
  const cols = showStatusCol ? 8 : 7;
  return (
    <>
      <tr
        onClick={onToggle}
        className={`border-b border-[#F0E4D6] last:border-0 cursor-pointer transition-colors ${expanded ? 'bg-[#FFF8F0]' : 'hover:bg-[#FFF8F0]'}`}
      >
        <td className="py-2.5 pl-3 pr-1 text-[#8B7355]">
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </td>
        <td className="py-2.5 px-2">
          <CallerCell r={r} />
        </td>
        <td className="py-2.5 px-3 text-[13px] text-[#3D2614] whitespace-nowrap">{istDateTime(r.missed_at)}</td>
        <td className="py-2.5 px-3"><SlaChip r={r} nowMs={nowMs} /></td>
        <td className="py-2.5 px-3 text-center">
          <AttemptsBadge count={r.attempts.length} />
        </td>
        <td className="py-2.5 px-3 text-[13px] text-[#6B5744] max-w-[160px] truncate">
          {r.assigned_to || <span className="text-[#C4B09A]">Unassigned</span>}
        </td>
        {showStatusCol && <td className="py-2.5 px-3"><StatusBadge status={r.status} /></td>}
        <td className="py-2.5 px-4">
          <div className="flex items-center justify-end gap-1.5" onClick={e => e.stopPropagation()}>
            {isWorkable(r) && (
              <>
                <CallbackButton
                  phone={r.phone_e164}
                  guestId={r.guest_id ?? undefined}
                  recoveryId={r.id}
                  guestName={r.guest_name ?? undefined}
                  onLogged={onCallbackLogged}
                />
                <ActionBtn
                  label="WhatsApp" tone="green" busy={busy === `${r.id}:wa`}
                  icon={<MessageCircle className="w-3.5 h-3.5" />} onClick={onWhatsApp}
                />
                {!['unreachable'].includes(r.status) && (
                  <ActionBtn
                    label="Unreachable" tone="gray" busy={busy === `${r.id}:unreach`}
                    icon={<Ban className="w-3.5 h-3.5" />} onClick={onUnreachable}
                  />
                )}
              </>
            )}
            <ActionBtn
              label="Note" tone="gray" busy={busy === `${r.id}:note`}
              icon={<StickyNote className="w-3.5 h-3.5" />} onClick={onNote}
            />
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-[#F0E4D6] last:border-0 bg-[#FFFBF5]">
          <td colSpan={cols} className="px-5 py-4">
            <DetailPanel {...props} />
          </td>
        </tr>
      )}
    </>
  );
}

// ── Mobile card ──────────────────────────────────────────────────────────────

function MobileCard(props: RowActions) {
  const { r, nowMs, expanded, busy, onToggle, onCallbackLogged, onWhatsApp, onUnreachable, onNote } = props;
  return (
    <div className={`bg-white border rounded-xl shadow-sm overflow-hidden ${expanded ? 'border-[#af4408]/50' : 'border-[#E8D5C4]'}`}>
      <button onClick={onToggle} className="w-full text-left px-4 pt-3.5 pb-2.5">
        <div className="flex items-start justify-between gap-3">
          <CallerCell r={r} />
          <SlaChip r={r} nowMs={nowMs} />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-[11px] text-[#8B7355]">
          <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" />Missed {istDateTime(r.missed_at)}</span>
          <span>{r.attempts.length} attempt{r.attempts.length === 1 ? '' : 's'}</span>
          <span className="truncate">{r.assigned_to ? `→ ${r.assigned_to}` : 'Unassigned'}</span>
          <StatusBadge status={r.status} />
        </div>
      </button>
      <div className="flex items-center gap-1.5 px-3 pb-3 flex-wrap">
        {isWorkable(r) && (
          <>
            <CallbackButton phone={r.phone_e164} guestId={r.guest_id ?? undefined} recoveryId={r.id} guestName={r.guest_name ?? undefined} onLogged={onCallbackLogged} className="flex-1" />
            <ActionBtn label="WhatsApp" tone="green" busy={busy === `${r.id}:wa`} icon={<MessageCircle className="w-3.5 h-3.5" />} onClick={onWhatsApp} grow />
            {r.status !== 'unreachable' && (
              <ActionBtn label="Unreachable" tone="gray" busy={busy === `${r.id}:unreach`} icon={<Ban className="w-3.5 h-3.5" />} onClick={onUnreachable} />
            )}
          </>
        )}
        <ActionBtn label="Note" tone="gray" busy={busy === `${r.id}:note`} icon={<StickyNote className="w-3.5 h-3.5" />} onClick={onNote} />
      </div>
      {expanded && (
        <div className="border-t border-[#F0E4D6] bg-[#FFFBF5] px-4 py-4">
          <DetailPanel {...props} />
        </div>
      )}
    </div>
  );
}

// ── Expanded detail: attempts timeline + source call + guest link/create ────

function DetailPanel(props: RowActions) {
  const { r, busy, onRecovered, createName, setCreateName, onCreateGuest } = props;
  const knownGuest = !!(r.guest_id && String(r.guest_id).trim());
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 text-sm">

      {/* Attempts timeline */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-4">
        <h3 className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider mb-3">
          Attempts ({r.attempts.length})
        </h3>
        {r.attempts.length === 0 ? (
          <p className="text-xs text-[#C4B09A]">No callback attempts yet — the SLA clock is running.</p>
        ) : (
          <ol className="space-y-2.5">
            {r.attempts.map((a, i) => (
              <li key={i} className="flex items-start gap-2.5">
                <span className="mt-0.5 w-6 h-6 rounded-full bg-[#FFF1E3] text-[#af4408] flex items-center justify-center shrink-0">
                  {a.method === 'whatsapp'
                    ? <MessageCircle className="w-3.5 h-3.5" />
                    : a.method === 'sms'
                      ? <MessageSquare className="w-3.5 h-3.5" />
                      : <PhoneOutgoing className="w-3.5 h-3.5" />}
                </span>
                <div className="min-w-0">
                  <p className="text-[13px] text-[#2D1B0E]">
                    <span className="font-semibold capitalize">{a.method}</span>
                    {a.outcome ? <span className="text-[#6B5744]"> — {a.outcome}</span> : null}
                  </p>
                  <p className="text-[11px] text-[#8B7355]">{istDateTime(a.at)}{a.by ? ` · ${a.by}` : ''}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
        {r.first_attempt_at && (
          <p className="text-[11px] text-[#8B7355] mt-3 pt-2 border-t border-[#F0E4D6]">
            First attempt {istDateTime(r.first_attempt_at)}
          </p>
        )}
        {r.resolution_note && (
          <p className="text-xs text-[#6B5744] mt-2 bg-[#FFF8F0] border border-[#F0E4D6] rounded-lg px-2.5 py-2">
            <span className="font-semibold">Note:</span> {r.resolution_note}
          </p>
        )}
      </div>

      {/* Source call info */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-4">
        <h3 className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider mb-3">Missed call</h3>
        {r.call ? (
          <dl className="space-y-1.5 text-[13px]">
            <DetailRow label="Direction">
              <span className="inline-flex items-center gap-1.5 capitalize">
                {r.call.direction === 'outbound' ? <PhoneOutgoing className="w-3.5 h-3.5 text-[#8B7355]" /> : <PhoneIncoming className="w-3.5 h-3.5 text-[#8B7355]" />}
                {r.call.direction || 'inbound'}
              </span>
            </DetailRow>
            <DetailRow label="Status"><span className="capitalize">{r.call.status || '—'}</span></DetailRow>
            <DetailRow label="Started">{istDateTime(r.call.started_at)}</DetailRow>
            <DetailRow label="Rang for">{fmtCallDuration(r.call.duration_sec)}</DetailRow>
            {r.call.queue ? <DetailRow label="Queue">{r.call.queue}</DetailRow> : null}
            {r.call.agent_user ? <DetailRow label="Agent">{r.call.agent_user}</DetailRow> : null}
            {r.call.disposition ? <DetailRow label="Disposition"><span className="capitalize">{r.call.disposition.replace(/_/g, ' ')}</span></DetailRow> : null}
          </dl>
        ) : (
          <p className="text-xs text-[#C4B09A]">Call record not found (detected via {r.detected_via.replace(/_/g, ' ')}).</p>
        )}
        <div className="flex flex-wrap gap-1.5 mt-3 pt-2 border-t border-[#F0E4D6] text-[11px]">
          <span className="px-2 py-0.5 rounded-full bg-[#FFF1E3] text-[#8B7355]">via {r.detected_via.replace(/_/g, ' ')}</span>
          {!!r.escalated && (
            <span className="px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200 font-medium">
              Escalated{r.escalated_at ? ` ${istTime(r.escalated_at)}` : ''}
            </span>
          )}
          {r.recovered_at && (
            <span className="px-2 py-0.5 rounded-full bg-green-50 text-green-700 border border-green-200 font-medium">
              Recovered {istDateTime(r.recovered_at)}
            </span>
          )}
          {r.recovery_booking_id && (
            <span className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 font-medium">
              Booking made
            </span>
          )}
        </div>
      </div>

      {/* Guest link / inline create + manual resolve */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 flex flex-col">
        <h3 className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider mb-3">Guest</h3>
        {knownGuest ? (
          <div className="space-y-2">
            <p className="text-[13px] font-semibold flex items-center gap-1.5">
              <User className="w-4 h-4 text-[#8B7355]" />
              {(r.guest_name || '').trim() || 'Unnamed guest'}
              {r.is_vip && <VipBadge />}
            </p>
            <p className="text-xs text-[#6B5744] font-mono">{formatPhone(r.phone_e164)}</p>
            {r.guest_tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {r.guest_tags.map(t => (
                  <span key={t} className="px-1.5 py-0.5 rounded-full bg-[#FFF1E3] text-[#8B7355] text-[10px] font-medium">{t}</span>
                ))}
              </div>
            )}
            <Link
              href={`/crm-calls/guests/${r.guest_id}`}
              className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[#af4408] hover:underline"
            >
              Open Guest 360 <ExternalLink className="w-3.5 h-3.5" />
            </Link>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-[#8B7355]">
              Unknown caller <span className="font-mono text-[#6B5744]">{formatPhone(r.phone_e164)}</span> — create a guest so the next call pops their card.
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={createName}
                onChange={e => setCreateName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') onCreateGuest(); }}
                placeholder="Guest name"
                className="flex-1 min-w-0 px-3 py-2 bg-white border border-[#E0D0BE] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]/40 focus:border-[#af4408]"
              />
              <button
                onClick={onCreateGuest}
                disabled={busy === `${r.id}:guest`}
                className="flex items-center gap-1.5 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 text-white rounded-lg text-sm font-medium whitespace-nowrap"
              >
                {busy === `${r.id}:guest` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
                Create guest
              </button>
            </div>
          </div>
        )}

        {isWorkable(r) && (
          <div className="mt-auto pt-3">
            <button
              onClick={onRecovered}
              disabled={busy === `${r.id}:resolve`}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-green-50 hover:bg-green-100 disabled:opacity-50 text-green-700 border border-green-200 rounded-lg text-sm font-medium transition-colors"
            >
              {busy === `${r.id}:resolve` ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
              Mark Recovered (guest reached)
            </button>
            <p className="text-[10px] text-[#C4B09A] mt-1.5 text-center">
              Answered callbacks auto-recover via the call log — this is the manual fallback.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-24 shrink-0 text-[11px] text-[#8B7355] uppercase tracking-wide">{label}</dt>
      <dd className="text-[#3D2614] min-w-0">{children}</dd>
    </div>
  );
}

// ── Small pieces ─────────────────────────────────────────────────────────────

function CallerCell({ r }: { r: Recovery }) {
  const known = !!(r.guest_name || '').trim();
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${r.is_vip ? 'bg-amber-100 text-amber-700' : known ? 'bg-[#F3E2D0] text-[#a8632b]' : 'bg-gray-100 text-gray-500'}`}>
        {known
          ? <span className="text-[11px] font-bold">{(r.guest_name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?'}</span>
          : <PhoneMissed className="w-4 h-4" />}
      </div>
      <div className="min-w-0">
        <p className="font-semibold text-[13px] text-[#2D1B0E] truncate flex items-center gap-1.5">
          <span className="truncate">{known ? (r.guest_name || '').trim() : formatPhone(r.phone_e164)}</span>
          {r.is_vip && <VipBadge />}
        </p>
        <p className="text-[11px] text-[#8B7355] font-mono truncate">
          {known ? formatPhone(r.phone_e164) : 'Unknown caller'}
        </p>
      </div>
    </div>
  );
}

function VipBadge() {
  return (
    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[10px] font-bold shrink-0">
      <Crown className="w-3 h-3" />VIP
    </span>
  );
}

/**
 * Live SLA countdown, ticking every second off the shared nowMs.
 * 🟢 comfortably inside SLA · 🟠 under 10 minutes left · 🔴 breached.
 * Terminal states show a status badge instead of a clock.
 */
function SlaChip({ r, nowMs }: { r: Recovery; nowMs: number }) {
  if (!OPEN_STATUSES.includes(r.status)) return <StatusBadge status={r.status} />;
  const due = Date.parse(r.sla_due_at || '');
  if (!Number.isFinite(due)) return <span className="text-[#C4B09A] text-xs">—</span>;
  const left = due - nowMs;
  if (left <= 0) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-red-50 border border-red-200 text-red-700 text-xs font-bold whitespace-nowrap tabular-nums">
        <span aria-hidden>🔴</span>{fmtSpan(-left)} over
      </span>
    );
  }
  if (left < WARN_MS) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-orange-50 border border-orange-200 text-orange-700 text-xs font-bold whitespace-nowrap tabular-nums">
        <span aria-hidden>🟠</span>{fmtSpan(left)} left
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-green-50 border border-green-200 text-green-700 text-xs font-semibold whitespace-nowrap tabular-nums">
      <span aria-hidden>🟢</span>{fmtSpan(left)} left
    </span>
  );
}

function StatusBadge({ status }: { status: Recovery['status'] }) {
  const map: Record<Recovery['status'], { cls: string; label: string }> = {
    pending: { cls: 'bg-amber-50 text-amber-700 border-amber-200', label: 'Pending' },
    attempting: { cls: 'bg-blue-50 text-blue-700 border-blue-200', label: 'Attempting' },
    recovered: { cls: 'bg-green-50 text-green-700 border-green-200', label: 'Recovered' },
    auto_resolved: { cls: 'bg-teal-50 text-teal-700 border-teal-200', label: 'Auto-resolved' },
    unreachable: { cls: 'bg-gray-100 text-gray-600 border-gray-200', label: 'Unreachable' },
    expired: { cls: 'bg-red-50 text-red-700 border-red-200', label: 'Expired' },
  };
  const m = map[status] || { cls: 'bg-gray-100 text-gray-600 border-gray-200', label: status };
  return <span className={`inline-flex px-2 py-0.5 rounded-full border text-[11px] font-medium whitespace-nowrap ${m.cls}`}>{m.label}</span>;
}

function AttemptsBadge({ count }: { count: number }) {
  return (
    <span className={`inline-flex items-center justify-center min-w-[1.75rem] px-1.5 py-0.5 rounded-full text-[11px] font-bold ${count > 0 ? 'bg-[#FFF1E3] text-[#af4408]' : 'bg-gray-100 text-gray-400'}`}>
      {count}
    </span>
  );
}

function ActionBtn({ label, icon, tone, onClick, busy, grow }: {
  label: string;
  icon: React.ReactNode;
  tone: 'primary' | 'green' | 'gray';
  onClick: () => void;
  busy?: boolean;
  grow?: boolean;
}) {
  const tones: Record<string, string> = {
    primary: 'bg-[#af4408] hover:bg-[#8a3506] text-white border-transparent',
    green: 'bg-green-600 hover:bg-green-700 text-white border-transparent',
    gray: 'bg-white hover:bg-[#FFF1E3] text-[#6B5744] border-[#E0D0BE]',
  };
  return (
    <button
      onClick={onClick}
      disabled={!!busy}
      className={`flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium whitespace-nowrap transition-colors disabled:opacity-50 ${tones[tone]} ${grow ? 'flex-1' : ''}`}
    >
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : icon}
      {label}
    </button>
  );
}
