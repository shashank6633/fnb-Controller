'use client';

/**
 * CRM — Call Log (master spec 5.5).
 *
 * Every call, filterable by direction / status / agent / date range / phone.
 * Each row: IST time, direction arrow, caller (guest link or quick-create),
 * agent, duration, status chip, disposition chip (inline 7-chip picker →
 * PUT /api/crm-calls/calls/[id]), recording playback (auth-proxied inline
 * <audio>), and a straight jump into the Recovery Queue for missed calls.
 * Desktop table + mobile cards, paged 50.
 */

import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { formatPhone } from '@/lib/ct/phone';
import {
  ArrowDownLeft, ArrowUpRight, ChevronLeft, ChevronRight, Loader2, Phone,
  PhoneMissed, Play, RefreshCw, Search, Square, UserPlus, X, CheckCircle,
  Sparkles, AlertTriangle,
} from 'lucide-react';
import CallAnalysisCard, { type CallAnalysisData } from '@/app/crm/assistant/CallAnalysisCard';

// ─── Types ────────────────────────────────────────────────────────────────

interface CallRow {
  id: string;
  telecmi_call_id: string | null;
  phone_e164: string;
  direction: 'inbound' | 'outbound' | string;
  status: 'ringing' | 'answered' | 'missed' | 'abandoned' | 'voicemail' | string;
  agent_user: string;
  agent_display?: string; // mapped staff name (falls back to raw agent id server-side)
  queue: string;
  started_at: string | null;
  answered_at: string | null;
  ended_at: string | null;
  duration_sec: number;
  disposition: string;
  disposition_note: string;
  created_at: string;
  has_recording: boolean;
  // AI call-enhancement state (from the scorecard engine; may be absent on old rows)
  analysis_status?: string;      // '' | pending | done | error | skipped
  analysis_score?: number | null;
  analysis_outcome?: string;
  analysis_error?: string;
  guest_id: string | null;
  guest_name: string;
  guest_tags: string[];
}

/** GET /api/crm-calls/calls/[id]/analyze — stored scorecard state. */
interface AnalysisResponse {
  status: string;                     // '' | pending | done | error | skipped
  score: number | null;
  outcome: string;
  summary: string;
  analyzed_at: string | null;
  analyzed_by: string;
  error: string;
  analysis: CallAnalysisData | null;  // the object <CallAnalysisCard/> renders
}

/** A scorecard captured straight from an Enhance POST response, kept in session
 *  memory keyed by call id. In 'ephemeral' retention mode the result is never
 *  persisted, so this is the ONLY copy — the panel renders from here instead of
 *  the (now-empty) GET. In 'permanent' mode a freshly-enhanced call renders from
 *  here too; older stored scorecards fall back to the GET. */
interface CachedAnalysis {
  analysis: CallAnalysisData | null;
  status: string;
  score: number | null;
  error: string;
  summary?: string;
}

interface Summary {
  total: number; inbound: number; outbound: number;
  answered: number; missed: number; ringing: number; needs_disposition: number;
}

const EMPTY_SUMMARY: Summary = {
  total: 0, inbound: 0, outbound: 0, answered: 0, missed: 0, ringing: 0, needs_disposition: 0,
};

const PAGE_SIZE = 50;
const MISSED_FAMILY = ['missed', 'abandoned', 'voicemail'];
// Cap the session scorecard cache so a long session never keeps an unbounded
// pile of full transcripts in memory.
const ANALYSIS_CACHE_CAP = 60;

const DISPOSITIONS: Array<{ value: string; label: string; chip: string }> = [
  { value: 'booking_made',      label: 'Booking Made',   chip: 'bg-green-100 text-green-700 border-green-200' },
  { value: 'enquiry',           label: 'Enquiry',        chip: 'bg-blue-100 text-blue-700 border-blue-200' },
  { value: 'event_enquiry',     label: 'Event Enquiry',  chip: 'bg-indigo-100 text-indigo-700 border-indigo-200' },
  { value: 'complaint',         label: 'Complaint',      chip: 'bg-red-100 text-red-700 border-red-200' },
  { value: 'wrong_number',      label: 'Wrong Number',   chip: 'bg-gray-100 text-gray-600 border-gray-200' },
  { value: 'follow_up_needed',  label: 'Follow-up',      chip: 'bg-amber-100 text-amber-800 border-amber-200' },
  { value: 'no_action',         label: 'No Action',      chip: 'bg-gray-100 text-gray-500 border-gray-200' },
];
const dispositionMeta = (v: string) => DISPOSITIONS.find(d => d.value === v) || null;

// ─── Small helpers ────────────────────────────────────────────────────────

const IST = 'Asia/Kolkata';

function istDayKey(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: IST }); // YYYY-MM-DD
}

/** IST display: { time: "07:42 pm", date: "Today" | "18 Jul" } */
function istWhen(iso: string | null | undefined): { time: string; date: string } {
  if (!iso) return { time: '—', date: '' };
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { time: '—', date: '' };
  const time = d.toLocaleTimeString('en-IN', { timeZone: IST, hour: '2-digit', minute: '2-digit', hour12: true });
  const key = istDayKey(d);
  const now = new Date();
  let date: string;
  if (key === istDayKey(now)) date = 'Today';
  else if (key === istDayKey(new Date(now.getTime() - 86_400_000))) date = 'Yesterday';
  else date = d.toLocaleDateString('en-IN', { timeZone: IST, day: '2-digit', month: 'short' });
  return { time, date };
}

function mmss(sec: number): string {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

const startOf = (c: CallRow) => c.started_at || c.created_at;

// ─── Page ─────────────────────────────────────────────────────────────────

export default function CallLogPage() {
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [summary, setSummary] = useState<Summary>(EMPTY_SUMMARY);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);

  // Filters
  const [direction, setDirection] = useState('');        // '' | inbound | outbound
  const [status, setStatus] = useState('');               // '' | answered | missed | abandoned | voicemail | ringing
  const [needsDisposition, setNeedsDisposition] = useState(false);
  const [agent, setAgent] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [phoneInput, setPhoneInput] = useState('');
  const [phoneQuery, setPhoneQuery] = useState('');
  const [page, setPage] = useState(1);

  // Agent options accumulate from every page fetched (API has no /agents list).
  // Keep raw id as the query value + mapped name as the visible label (dedup by value).
  const [agents, setAgents] = useState<Array<{ value: string; label: string }>>([]);

  // Row interactions
  const [savingId, setSavingId] = useState<string | null>(null);
  const [audioId, setAudioId] = useState<string | null>(null);
  const [analysisId, setAnalysisId] = useState<string | null>(null);              // AI panel expanded row
  const [analyzingIds, setAnalyzingIds] = useState<Set<string>>(() => new Set()); // in-flight enhances
  const [analysisCache, setAnalysisCache] = useState<Record<string, CachedAnalysis>>({}); // scorecards from Enhance POST bodies (survives ephemeral mode)
  const [quickGuest, setQuickGuest] = useState<{ phone: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchSeq = useRef(0);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  }, []);

  // Debounce phone search
  useEffect(() => {
    const t = setTimeout(() => setPhoneQuery(phoneInput.trim()), 350);
    return () => clearTimeout(t);
  }, [phoneInput]);

  // Reset to page 1 whenever a filter changes
  useEffect(() => { setPage(1); }, [direction, status, needsDisposition, agent, from, to, phoneQuery]);

  const buildQuery = useCallback((p: number) => {
    const sp = new URLSearchParams();
    if (direction) sp.set('direction', direction);
    if (status) sp.set('status', status);
    if (needsDisposition) sp.set('needs_disposition', '1');
    if (agent) sp.set('agent', agent);
    if (from) sp.set('from', from);
    if (to) sp.set('to', to);
    if (phoneQuery) sp.set('phone', phoneQuery);
    sp.set('page', String(p));
    sp.set('pageSize', String(PAGE_SIZE));
    return sp.toString();
  }, [direction, status, needsDisposition, agent, from, to, phoneQuery]);

  const fetchCalls = useCallback(async (silent = false) => {
    const seq = ++fetchSeq.current;
    if (!silent) setFetching(true);
    try {
      const res = await fetch(`/api/crm-calls/calls?${buildQuery(page)}`);
      if (!res.ok) return;
      const json = await res.json();
      if (seq !== fetchSeq.current) return; // a newer fetch superseded this one
      const list: CallRow[] = Array.isArray(json?.calls) ? json.calls : [];
      setCalls(list);
      setTotal(Number(json?.total) || 0);
      setSummary(json?.summary || EMPTY_SUMMARY);
      setAgents(prev => {
        const map = new Map(prev.map(a => [a.value, a]));
        for (const c of list) if (c.agent_user) map.set(c.agent_user, { value: c.agent_user, label: c.agent_display || c.agent_user });
        return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
      });
    } catch { /* transient network error — keep last data */ }
    finally {
      if (seq === fetchSeq.current) { setFetching(false); setLoading(false); }
    }
  }, [buildQuery, page]);

  useEffect(() => { fetchCalls(); }, [fetchCalls]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const anyFilter = !!(direction || status || needsDisposition || agent || from || to || phoneQuery);
  const clearFilters = () => {
    setDirection(''); setStatus(''); setNeedsDisposition(false);
    setAgent(''); setFrom(''); setTo(''); setPhoneInput('');
  };

  // Chip togglers (chips + selects share the same state, so they stay in sync)
  const pickAll = () => { setDirection(''); setStatus(''); setNeedsDisposition(false); };
  const pickDirection = (d: string) => { setDirection(prev => (prev === d ? '' : d)); };
  const pickStatus = (s: string) => { setStatus(prev => (prev === s ? '' : s)); setNeedsDisposition(false); };
  const pickNeedsDisposition = () => { setNeedsDisposition(v => !v); setStatus(''); };

  // ── Mutations ───────────────────────────────────────────────────────────

  const setDisposition = async (call: CallRow, disposition: string) => {
    setSavingId(call.id);
    try {
      const res = await api(`/api/crm-calls/calls/${encodeURIComponent(call.id)}`, {
        method: 'PUT',
        body: { disposition },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(json?.error || 'Could not save disposition');
        return;
      }
      setCalls(prev => prev.map(c => (c.id === call.id ? { ...c, disposition } : c)));
      showToast(
        json?.follow_up_skipped_reason
          ? 'Saved — create the guest to enable the follow-up'
          : 'Disposition saved',
      );
      fetchCalls(true); // refresh summary counts quietly
    } catch {
      showToast('Could not save disposition');
    } finally {
      setSavingId(null);
    }
  };

  const createGuest = async (phone: string, name: string): Promise<boolean> => {
    try {
      const res = await api('/api/crm-calls/guests', {
        method: 'POST',
        body: { phone, name: name.trim(), source: 'call' },
      });
      if (res.ok) {
        showToast('Guest created');
        setQuickGuest(null);
        fetchCalls(true);
        return true;
      }
      const json = await res.json().catch(() => ({}));
      if (res.status === 409) {
        // Someone beat us to it — the phone join will pick the guest up.
        showToast('A guest with this phone already exists');
        setQuickGuest(null);
        fetchCalls(true);
        return true;
      }
      showToast(json?.error || 'Could not create guest');
      return false;
    } catch {
      showToast('Could not create guest');
      return false;
    }
  };

  // ── AI call enhancement (reuses the production scorecard engine) ──────────

  // Add/replace a session scorecard, bounded to the most-recent entries so a
  // long session never retains an unbounded pile of full transcripts. Spread
  // preserves insertion order (a re-enhanced id keeps its slot); once past the
  // cap, drop the oldest keys.
  const cacheAnalysis = useCallback((id: string, entry: CachedAnalysis) => {
    setAnalysisCache(prev => {
      const next: Record<string, CachedAnalysis> = { ...prev, [id]: entry };
      const keys = Object.keys(next);
      if (keys.length > ANALYSIS_CACHE_CAP) {
        for (const k of keys.slice(0, keys.length - ANALYSIS_CACHE_CAP)) delete next[k];
      }
      return next;
    });
  }, []);

  const enhance = async (call: CallRow) => {
    if (analyzingIds.has(call.id)) return;
    setAnalyzingIds(prev => { const n = new Set(prev); n.add(call.id); return n; });
    try {
      const res = await api(`/api/crm-calls/calls/${encodeURIComponent(call.id)}/analyze`, {
        method: 'POST', body: {},
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json?.status === 'done') {
        // Cache the scorecard from the POST body. In 'ephemeral' retention mode
        // it is never stored, so this session cache is the only place it exists;
        // the inline panel prefers it over the (now-empty) GET.
        cacheAnalysis(call.id, {
          analysis: (json.analysis as CallAnalysisData) ?? null,
          status: 'done', score: json.score ?? null, error: '',
          summary: typeof json.summary === 'string' ? json.summary : '',
        });
        setCalls(prev => prev.map(c => (c.id === call.id
          ? { ...c, analysis_status: 'done', analysis_score: json.score ?? null, analysis_error: '' }
          : c)));
        setAnalysisId(call.id);           // reveal the fresh scorecard inline
        showToast('Call enhanced with AI');
      } else if (json?.status === 'skipped') {
        setCalls(prev => prev.map(c => (c.id === call.id ? { ...c, analysis_status: 'skipped' } : c)));
        showToast(json?.message || json?.error || 'Nothing to analyze on this call');
      } else if (res.status === 429 || json?.status === 'rate_limited') {
        showToast('AI is busy right now — try again in a moment');
      } else {
        cacheAnalysis(call.id, {
          analysis: null, status: 'error', score: null, error: json?.error || '',
        });
        setCalls(prev => prev.map(c => (c.id === call.id
          ? { ...c, analysis_status: 'error', analysis_error: json?.error || '' }
          : c)));
        showToast(json?.error || 'Could not enhance this call');
      }
    } catch {
      setCalls(prev => prev.map(c => (c.id === call.id ? { ...c, analysis_status: 'error' } : c)));
      showToast('Could not enhance this call');
    } finally {
      setAnalyzingIds(prev => { const n = new Set(prev); n.delete(call.id); return n; });
    }
  };

  const toggleAnalysis = (call: CallRow) => setAnalysisId(prev => (prev === call.id ? null : call.id));

  // ── Render ──────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] p-6 animate-pulse">
        <div className="max-w-[100rem] mx-auto space-y-6">
          <div className="h-9 w-64 bg-[#FFF1E3] rounded-lg" />
          <div className="h-10 bg-[#FFF1E3] rounded-xl" />
          <div className="bg-white border border-[#E8D5C4] rounded-2xl h-96" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-[100rem] mx-auto px-3 sm:px-6 py-5 sm:py-6 space-y-4 sm:space-y-5">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">CRM · Call to Table</p>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#2D1B0E] mt-0.5 flex items-center gap-3">
              <Phone className="w-6 h-6 text-[#af4408]" /> Call Log
            </h1>
          </div>
          <button
            onClick={() => fetchCalls()}
            className="self-start sm:self-auto flex items-center gap-2 px-3 sm:px-4 py-2.5 bg-white border border-[#E0D0BE] hover:bg-[#FFF1E3] text-[#6B5744] rounded-xl text-sm font-medium shadow-sm transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${fetching ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>

        {/* Summary chips (counts ignore the active chip so they stay stable) */}
        <div className="flex flex-wrap items-center gap-2">
          <SummaryChip label="All" count={summary.total} active={!direction && !status && !needsDisposition} onClick={pickAll} />
          <SummaryChip label="Inbound" count={summary.inbound} active={direction === 'inbound'} onClick={() => pickDirection('inbound')}
                       icon={<ArrowDownLeft className="w-3.5 h-3.5" />} />
          <SummaryChip label="Outbound" count={summary.outbound} active={direction === 'outbound'} onClick={() => pickDirection('outbound')}
                       icon={<ArrowUpRight className="w-3.5 h-3.5" />} />
          <SummaryChip label="Answered" count={summary.answered} active={status === 'answered'} onClick={() => pickStatus('answered')} tone="green" />
          <SummaryChip label="Missed" count={summary.missed} active={status === 'missed'} onClick={() => pickStatus('missed')} tone="red" />
          {summary.ringing > 0 && (
            <SummaryChip label="Ringing" count={summary.ringing} active={status === 'ringing'} onClick={() => pickStatus('ringing')} tone="amber" pulse />
          )}
          <SummaryChip label="Needs disposition" count={summary.needs_disposition} active={needsDisposition} onClick={pickNeedsDisposition} tone="amber" />
        </div>

        {/* Search + filters */}
        <div className="flex flex-col lg:flex-row gap-2.5">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8B7355]" />
            <input
              type="text" inputMode="tel" placeholder="Search by phone number…"
              value={phoneInput} onChange={e => setPhoneInput(e.target.value)}
              className="w-full pl-10 pr-9 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]/40 focus:border-[#af4408] shadow-sm"
            />
            {phoneInput && (
              <button onClick={() => setPhoneInput('')} aria-label="Clear search"
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-[#8B7355] hover:text-[#2D1B0E]">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select value={status} onChange={e => { setStatus(e.target.value); setNeedsDisposition(false); }}
                    className="px-3 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm shadow-sm" aria-label="Status filter">
              <option value="">All Statuses</option>
              <option value="answered">Answered</option>
              <option value="missed">Missed (incl. abandoned + voicemail)</option>
              <option value="abandoned">Abandoned only</option>
              <option value="voicemail">Voicemail only</option>
              <option value="ringing">Ringing</option>
            </select>
            <select value={agent} onChange={e => setAgent(e.target.value)}
                    className="px-3 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm shadow-sm" aria-label="Agent filter">
              <option value="">All Agents</option>
              {agent && !agents.some(a => a.value === agent) && <option value={agent}>{agent}</option>}
              {agents.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
            <input type="date" value={from} onChange={e => setFrom(e.target.value)} aria-label="From date"
                   className="px-3 py-2 bg-white border border-[#E0D0BE] rounded-xl text-sm shadow-sm text-[#6B5744]" />
            <span className="text-xs text-[#8B7355]">to</span>
            <input type="date" value={to} onChange={e => setTo(e.target.value)} aria-label="To date"
                   className="px-3 py-2 bg-white border border-[#E0D0BE] rounded-xl text-sm shadow-sm text-[#6B5744]" />
            {anyFilter && (
              <button onClick={clearFilters} className="text-sm font-medium text-[#af4408] hover:underline whitespace-nowrap">
                Clear filters
              </button>
            )}
          </div>
        </div>

        {/* ---- Calls: table on desktop, cards on mobile ---- */}
        {calls.length === 0 ? (
          <div className="bg-white border border-[#E8D5C4] rounded-2xl py-16 text-center text-[#8B7355]">
            <Phone className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p>No calls found</p>
            <p className="text-xs mt-1">{anyFilter ? 'Try clearing filters' : 'Calls appear here as TeleCMI reports them'}</p>
          </div>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden md:block bg-white border border-[#E8D5C4] rounded-2xl shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-wide text-[#8B7355] border-b border-[#E8D5C4] bg-[#FFF8F0]">
                      <th className="text-left py-3 px-4 font-semibold">Time</th>
                      <th className="text-center py-3 px-2 font-semibold" title="Direction">Dir</th>
                      <th className="text-left py-3 px-3 font-semibold">Caller</th>
                      <th className="text-left py-3 px-3 font-semibold">Agent</th>
                      <th className="text-right py-3 px-3 font-semibold">Duration</th>
                      <th className="text-left py-3 px-3 font-semibold">Status</th>
                      <th className="text-left py-3 px-3 font-semibold">Disposition</th>
                      <th className="text-center py-3 px-3 font-semibold">Rec</th>
                      <th className="text-center py-3 px-3 font-semibold" title="AI call analysis">AI</th>
                      <th className="w-28" aria-label="Actions"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {calls.map(c => {
                      const when = istWhen(startOf(c));
                      const isMissed = MISSED_FAMILY.includes(c.status);
                      return (
                        <Fragment key={c.id}>
                          <tr className="border-b border-[#F0E4D6] last:border-0 hover:bg-[#FFF8F0]">
                            <td className="py-2.5 px-4 whitespace-nowrap">
                              <p className="font-semibold text-[13px] text-[#2D1B0E]">{when.time}</p>
                              <p className="text-[11px] text-[#8B7355]">{when.date}</p>
                            </td>
                            <td className="py-2.5 px-2 text-center"><DirectionIcon direction={c.direction} /></td>
                            <td className="py-2.5 px-3">
                              <CallerCell call={c} onQuickCreate={() => setQuickGuest({ phone: c.phone_e164 })} />
                            </td>
                            <td className="py-2.5 px-3 text-[13px] text-[#3D2614]">
                              {c.agent_display || c.agent_user || <span className="text-[#C4B09A]">—</span>}
                              {c.queue && <p className="text-[11px] text-[#8B7355]">{c.queue}</p>}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono text-[13px] text-[#3D2614]">
                              {c.status === 'answered' || c.duration_sec > 0 ? mmss(c.duration_sec) : <span className="text-[#C4B09A]">—</span>}
                            </td>
                            <td className="py-2.5 px-3"><StatusChip status={c.status} /></td>
                            <td className="py-2.5 px-3">
                              <DispositionCell call={c} saving={savingId === c.id} onPick={d => setDisposition(c, d)} />
                            </td>
                            <td className="py-2.5 px-3 text-center">
                              {c.has_recording ? (
                                <button
                                  onClick={() => setAudioId(prev => (prev === c.id ? null : c.id))}
                                  aria-label={audioId === c.id ? 'Hide recording' : 'Play recording'}
                                  title={audioId === c.id ? 'Hide recording' : 'Play recording'}
                                  className={`p-1.5 rounded-lg transition-colors ${audioId === c.id ? 'bg-[#af4408] text-white' : 'text-[#af4408] hover:bg-[#FFF1E3]'}`}
                                >
                                  {audioId === c.id ? <Square className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                                </button>
                              ) : <span className="text-[#C4B09A]">—</span>}
                            </td>
                            <td className="py-2.5 px-3 text-center">
                              <AiCell
                                call={c}
                                analyzing={analyzingIds.has(c.id)}
                                panelOpen={analysisId === c.id}
                                onEnhance={() => enhance(c)}
                                onTogglePanel={() => toggleAnalysis(c)}
                              />
                            </td>
                            <td className="py-2.5 px-3 text-right whitespace-nowrap">
                              {isMissed && (
                                <Link href="/crm-calls/recovery"
                                      className="inline-flex items-center gap-1 text-xs font-semibold text-red-600 hover:text-red-700 hover:underline">
                                  <PhoneMissed className="w-3.5 h-3.5" /> Recovery →
                                </Link>
                              )}
                            </td>
                          </tr>
                          {audioId === c.id && c.has_recording ? (
                            <tr className="border-b border-[#F0E4D6] last:border-0 bg-[#FFF8F0]">
                              <td colSpan={10} className="px-4 py-3">
                                <AudioPlayer callId={c.id} />
                              </td>
                            </tr>
                          ) : null}
                          {analysisId === c.id && c.has_recording ? (
                            <tr className="border-b border-[#F0E4D6] last:border-0 bg-[#FFF8F0]">
                              <td colSpan={10} className="px-4 py-3">
                                <AnalysisPanel callId={c.id} cached={analysisCache[c.id]} />
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Mobile cards */}
            <div className="md:hidden space-y-2.5">
              {calls.map(c => {
                const when = istWhen(startOf(c));
                const isMissed = MISSED_FAMILY.includes(c.status);
                return (
                  <div key={c.id} className="bg-white border border-[#E8D5C4] rounded-xl p-3.5 space-y-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <DirectionIcon direction={c.direction} />
                        <div className="min-w-0">
                          <CallerCell call={c} onQuickCreate={() => setQuickGuest({ phone: c.phone_e164 })} />
                        </div>
                      </div>
                      <StatusChip status={c.status} />
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[#8B7355]">
                      <span>{when.time} · {when.date}</span>
                      {(c.agent_display || c.agent_user) && <span>Agent: {c.agent_display || c.agent_user}</span>}
                      {(c.status === 'answered' || c.duration_sec > 0) && <span className="font-mono">{mmss(c.duration_sec)}</span>}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <DispositionCell call={c} saving={savingId === c.id} onPick={d => setDisposition(c, d)} />
                      {c.has_recording ? (
                        <button
                          onClick={() => setAudioId(prev => (prev === c.id ? null : c.id))}
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium transition-colors ${audioId === c.id ? 'bg-[#af4408] text-white border-[#af4408]' : 'bg-white text-[#af4408] border-[#E0D0BE]'}`}
                        >
                          <Play className="w-3.5 h-3.5" /> {audioId === c.id ? 'Hide recording' : 'Recording'}
                        </button>
                      ) : null}
                      <AiCell
                        call={c}
                        analyzing={analyzingIds.has(c.id)}
                        panelOpen={analysisId === c.id}
                        onEnhance={() => enhance(c)}
                        onTogglePanel={() => toggleAnalysis(c)}
                      />
                      {isMissed && (
                        <Link href="/crm-calls/recovery"
                              className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-red-600">
                          <PhoneMissed className="w-3.5 h-3.5" /> Recovery →
                        </Link>
                      )}
                    </div>
                    {audioId === c.id && c.has_recording ? <AudioPlayer callId={c.id} /> : null}
                    {analysisId === c.id && c.has_recording ? <AnalysisPanel callId={c.id} cached={analysisCache[c.id]} /> : null}
                  </div>
                );
              })}
            </div>

            {/* Pagination */}
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-1">
              <p className="text-xs text-[#8B7355]">
                Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total} calls
              </p>
              <div className="flex items-center gap-1.5">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}
                        aria-label="Previous page"
                        className="p-2 rounded-lg border border-[#E0D0BE] bg-white text-[#6B5744] disabled:opacity-40 hover:bg-[#FFF1E3] transition-colors">
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="px-2 text-sm text-[#6B5744]">Page {page} of {pageCount}</span>
                <button onClick={() => setPage(p => Math.min(pageCount, p + 1))} disabled={page >= pageCount}
                        aria-label="Next page"
                        className="p-2 rounded-lg border border-[#E0D0BE] bg-white text-[#6B5744] disabled:opacity-40 hover:bg-[#FFF1E3] transition-colors">
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3 px-5 py-3 bg-green-600 text-white rounded-lg shadow-lg">
          <CheckCircle className="w-4 h-4" />
          <span className="text-sm font-medium">{toast}</span>
        </div>
      )}

      {/* Quick guest create */}
      {quickGuest && (
        <QuickGuestModal
          phone={quickGuest.phone}
          onClose={() => setQuickGuest(null)}
          onCreate={createGuest}
        />
      )}
    </div>
  );
}

// ─── Cells & chips ────────────────────────────────────────────────────────

function DirectionIcon({ direction }: { direction: string }) {
  if (direction === 'outbound') {
    return (
      <span role="img" aria-label="Outbound" title="Outbound"
            className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-purple-100 text-purple-700 shrink-0">
        <ArrowUpRight className="w-4 h-4" />
      </span>
    );
  }
  return (
    <span role="img" aria-label="Inbound" title="Inbound"
          className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-blue-100 text-blue-700 shrink-0">
      <ArrowDownLeft className="w-4 h-4" />
    </span>
  );
}

function StatusChip({ status }: { status: string }) {
  const map: Record<string, { cls: string; label: string; pulse?: boolean }> = {
    answered:  { cls: 'bg-green-100 text-green-700',  label: 'Answered' },
    missed:    { cls: 'bg-red-100 text-red-700',      label: 'Missed' },
    abandoned: { cls: 'bg-orange-100 text-orange-700', label: 'Abandoned' },
    voicemail: { cls: 'bg-blue-100 text-blue-700',    label: 'Voicemail' },
    ringing:   { cls: 'bg-amber-100 text-amber-800',  label: 'Ringing', pulse: true },
  };
  const m = map[status] || { cls: 'bg-gray-100 text-gray-600', label: status || '—' };
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${m.cls} ${m.pulse ? 'animate-pulse' : ''}`}>
      {m.pulse && <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />}
      {m.label}
    </span>
  );
}

function CallerCell({ call, onQuickCreate }: { call: CallRow; onQuickCreate: () => void }) {
  const phone = formatPhone(call.phone_e164) || call.phone_e164 || '—';
  if (call.guest_id) {
    return (
      <div className="min-w-0">
        <Link href={`/crm-calls/guests/${call.guest_id}`}
              className="font-semibold text-[13px] text-[#af4408] hover:underline truncate block max-w-[220px]">
          {call.guest_name || phone}
        </Link>
        <p className="text-[11px] text-[#8B7355] font-mono">{phone}</p>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 min-w-0">
      <p className="font-semibold text-[13px] text-[#2D1B0E] font-mono truncate">{phone}</p>
      <button onClick={onQuickCreate} title="Create guest from this number"
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-dashed border-[#D4B896] text-[11px] font-medium text-[#8B7355] hover:text-[#af4408] hover:border-[#af4408] transition-colors whitespace-nowrap">
        <UserPlus className="w-3 h-3" /> Guest
      </button>
    </div>
  );
}

/** Disposition chip when set; [Set] button opening the 7-chip inline picker
 *  when not. Fixed-position popover so the table's scroll container never
 *  clips it (same pattern as menu-items' row menu). */
function DispositionCell({ call, saving, onPick }: {
  call: CallRow; saving: boolean; onPick: (d: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      const width = 260;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
      setPos({ top: r.bottom + 6, left });
    }
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [open]);

  const meta = dispositionMeta(call.disposition);

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => (open ? setOpen(false) : openMenu())}
        disabled={saving}
        title={call.disposition_note || (meta ? 'Change disposition' : 'Set disposition')}
        className={
          meta
            ? `inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border font-medium whitespace-nowrap ${meta.chip} hover:opacity-80 transition-opacity`
            : 'inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full border border-dashed border-[#D4B896] font-medium text-[#8B7355] hover:text-[#af4408] hover:border-[#af4408] transition-colors whitespace-nowrap'
        }
      >
        {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
        {meta ? meta.label : 'Set'}
      </button>
      {open && pos && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div style={{ top: pos.top, left: pos.left, width: 260 }}
               className="fixed z-50 bg-white border border-[#E8D5C4] rounded-xl shadow-xl p-3">
            <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wide mb-2">Disposition</p>
            <div className="flex flex-wrap gap-1.5">
              {DISPOSITIONS.map(d => (
                <button
                  key={d.value}
                  onClick={() => { setOpen(false); if (d.value !== call.disposition) onPick(d.value); }}
                  className={`text-[11px] px-2.5 py-1 rounded-full border font-medium transition-colors ${
                    call.disposition === d.value
                      ? 'bg-[#af4408] text-white border-[#af4408]'
                      : `${d.chip} hover:opacity-80`
                  }`}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}

/** Auth-proxied playback — the TeleCMI URL never reaches the client. */
function AudioPlayer({ callId }: { callId: string }) {
  return (
    <audio
      controls
      preload="none"
      className="w-full max-w-md h-9"
      src={`/api/telecmi/recording/${encodeURIComponent(callId)}`}
    >
      Your browser does not support audio playback.
    </audio>
  );
}

// ─── AI call enhancement (reuses the production scorecard engine) ──────────

function scoreChipCls(score: number, active: boolean): string {
  if (score >= 80) return active ? 'bg-green-600 text-white border-green-600' : 'bg-green-100 text-green-700 border-green-200 hover:bg-green-200';
  if (score >= 60) return active ? 'bg-amber-500 text-white border-amber-500' : 'bg-amber-100 text-amber-800 border-amber-200 hover:bg-amber-200';
  return active ? 'bg-red-600 text-white border-red-600' : 'bg-red-100 text-red-700 border-red-200 hover:bg-red-200';
}

/** Per-row AI affordance — nothing for calls without a recording; a coloured
 *  "AI <score>" chip once analysed (click → inline scorecard); an "Analyzing…"
 *  pill while a run is in flight; otherwise a "✨ Enhance" button (and, on a
 *  failed run, a warning toggle that reveals the error in the panel). */
function AiCell({ call, analyzing, panelOpen, onEnhance, onTogglePanel }: {
  call: CallRow;
  analyzing: boolean;
  panelOpen: boolean;
  onEnhance: () => void;
  onTogglePanel: () => void;
}) {
  if (!call.has_recording) return null;
  const status = call.analysis_status || '';

  if (analyzing) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-purple-50 text-purple-700 border border-purple-200 text-[11px] font-medium whitespace-nowrap">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Analyzing…
      </span>
    );
  }

  if (status === 'done') {
    const score = Math.round(Number(call.analysis_score) || 0);
    return (
      <button
        onClick={onTogglePanel}
        title={panelOpen ? 'Hide AI analysis' : 'View AI analysis'}
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-semibold whitespace-nowrap transition-colors ${scoreChipCls(score, panelOpen)}`}
      >
        <Sparkles className="w-3 h-3" /> AI {score}
      </button>
    );
  }

  // '', 'skipped', 'error', 'pending' → offer to (re)run; on error also expose
  // the reason. A stranded server-side 'pending' (no in-flight client action)
  // shows a "Retry" button here so a human can re-POST /analyze.
  return (
    <span className="inline-flex items-center gap-1">
      <button
        onClick={onEnhance}
        title="Analyze this call with AI"
        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-dashed border-purple-300 text-[11px] font-medium text-purple-700 hover:bg-purple-50 hover:border-purple-400 transition-colors whitespace-nowrap"
      >
        <Sparkles className="w-3 h-3" /> {status === 'error' || status === 'pending' ? 'Retry' : 'Enhance'}
      </button>
      {status === 'error' && (
        <button
          onClick={onTogglePanel}
          title="View analysis error"
          aria-label="View analysis error"
          className={`inline-flex items-center justify-center p-1 rounded-full border transition-colors ${panelOpen ? 'bg-red-600 text-white border-red-600' : 'text-red-600 border-red-200 hover:bg-red-50'}`}
        >
          <AlertTriangle className="w-3.5 h-3.5" />
        </button>
      )}
    </span>
  );
}

function AnalysisErrorBox({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">
      <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
      <span className="min-w-0 break-words">{text}</span>
    </div>
  );
}

/** Inline analysis panel. Prefers the session cache captured from the Enhance
 *  POST body (the only copy in 'ephemeral' retention mode, and a fresh copy in
 *  'permanent' mode); falls back to GETting the stored scorecard when there is
 *  no cached entry (e.g. a call analysed in a previous session). Renders the
 *  shared <CallAnalysisCard/>, or the error text for failed runs. */
function AnalysisPanel({ callId, cached }: { callId: string; cached?: CachedAnalysis }) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<AnalysisResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (cached) return; // session cache wins — no GET (ephemeral has nothing stored)
    let alive = true;
    setLoading(true); setData(null); setErr(null);
    fetch(`/api/crm-calls/calls/${encodeURIComponent(callId)}/analyze`)
      .then(async res => {
        const json = await res.json().catch(() => ({}));
        if (!alive) return;
        if (!res.ok) setErr(json?.error || `Could not load analysis (${res.status})`);
        else setData(json as AnalysisResponse);
      })
      .catch(() => { if (alive) setErr('Could not load analysis'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [callId, cached]);

  // Session cache (from the Enhance POST) takes precedence over the GET.
  if (cached) {
    if (cached.analysis) return <CallAnalysisCard data={cached.analysis} />;
    if (cached.status === 'error') return <AnalysisErrorBox text={cached.error || 'Analysis failed for this call.'} />;
    // Done, but the model returned unstructured output (no scorecard object).
    // We still have a score/summary in the POST body — show it rather than the
    // misleading "No analysis available".
    if (cached.status === 'done' || typeof cached.score === 'number') {
      const score = typeof cached.score === 'number' ? Math.round(cached.score) : null;
      return (
        <div className="bg-white border border-[#E8D5C4] rounded-xl px-4 py-3 text-sm space-y-2">
          <div className="flex items-center gap-2 font-semibold text-[#2D1B0E]">
            <Sparkles className="w-4 h-4 text-[#af4408]" />
            {score !== null ? `AI score ${score}` : 'AI analysis complete'}
          </div>
          {cached.summary ? <p className="text-[#6B5744] break-words">{cached.summary}</p> : null}
          {cached.error ? <p className="text-[11px] text-[#8B7355] break-words">{cached.error}</p> : null}
          {!cached.summary && !cached.error ? (
            <p className="text-[11px] text-[#8B7355]">The AI returned a score but no detailed breakdown for this call.</p>
          ) : null}
        </div>
      );
    }
    return <div className="text-sm text-[#8B7355] py-4">No analysis available for this call yet.</div>;
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-[#8B7355] py-4">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading analysis…
      </div>
    );
  }
  if (err) return <AnalysisErrorBox text={err} />;
  if (data?.analysis) return <CallAnalysisCard data={data.analysis} />;
  if (data?.status === 'error') return <AnalysisErrorBox text={data.error || 'Analysis failed for this call.'} />;
  return <div className="text-sm text-[#8B7355] py-4">No analysis available for this call yet.</div>;
}

// ─── Quick guest create modal ─────────────────────────────────────────────

function QuickGuestModal({ phone, onClose, onCreate }: {
  phone: string;
  onClose: () => void;
  onCreate: (phone: string, name: string) => Promise<boolean>;
}) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const submit = async () => {
    if (saving) return;
    setSaving(true);
    try { await onCreate(phone, name); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-sm bg-white rounded-2xl shadow-xl border border-[#E8D5C4]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#E8D5C4]">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-[#F3E2D0]"><UserPlus className="w-4 h-4 text-[#af4408]" /></div>
            <h2 className="text-base font-semibold text-[#2D1B0E]">New Guest</h2>
          </div>
          <button onClick={onClose} className="p-1 text-[#8B7355] hover:text-[#2D1B0E]" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div>
            <label className="block text-xs font-medium text-[#8B7355] mb-1">Phone</label>
            <p className="px-3 py-2.5 bg-[#FFF8F0] border border-[#E8D5C4] rounded-xl text-sm font-mono text-[#2D1B0E]">
              {formatPhone(phone) || phone}
            </p>
          </div>
          <div>
            <label htmlFor="quick-guest-name" className="block text-xs font-medium text-[#8B7355] mb-1">Name</label>
            <input
              id="quick-guest-name" ref={inputRef} type="text" value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submit(); }}
              placeholder="Guest name (optional)"
              className="w-full px-3 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]/40 focus:border-[#af4408]"
            />
          </div>
          <div className="flex gap-2 pt-1">
            <button onClick={submit} disabled={saving}
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 text-white rounded-xl text-sm font-semibold transition-colors">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
              Create Guest
            </button>
            <button onClick={onClose} className="px-4 py-2.5 bg-[#FFF1E3] text-[#6B5744] rounded-xl text-sm hover:bg-[#E8D5C4] transition-colors">
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Summary chip ─────────────────────────────────────────────────────────

function SummaryChip({ label, count, active, onClick, icon, tone, pulse }: {
  label: string; count: number; active: boolean; onClick: () => void;
  icon?: ReactNode; tone?: 'green' | 'red' | 'amber'; pulse?: boolean;
}) {
  const activeCls =
    tone === 'green' ? 'bg-green-600 text-white border-green-600'
    : tone === 'red' ? 'bg-red-600 text-white border-red-600'
    : tone === 'amber' ? 'bg-amber-500 text-white border-amber-500'
    : 'bg-[#af4408] text-white border-[#af4408]';
  const idleCls =
    tone === 'green' ? 'bg-white text-green-700 border-green-200 hover:bg-green-50'
    : tone === 'red' ? 'bg-white text-red-700 border-red-200 hover:bg-red-50'
    : tone === 'amber' ? 'bg-white text-amber-800 border-amber-300 hover:bg-amber-50'
    : 'bg-white text-[#6B5744] border-[#E0D0BE] hover:bg-[#FFF1E3]';
  return (
    <button onClick={onClick}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium whitespace-nowrap transition-colors ${active ? activeCls : idleCls} ${pulse && !active ? 'animate-pulse' : ''}`}>
      {icon}
      {label} <span className="font-bold">{count}</span>
    </button>
  );
}
