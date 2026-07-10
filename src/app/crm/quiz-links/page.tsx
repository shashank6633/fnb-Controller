'use client';

/**
 * CRM Quiz Links (HOD or ADMIN) — create shareable guest-quiz links, share via
 * Copy / WhatsApp, manage active links, and drill into guest results down to
 * per-question report cards.
 *
 * Guests open /quiz/link/CODE (public, no login) — the code is generated here.
 * Mobile-first: cards + horizontally scrollable tables.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useState } from 'react';
import {
  Link2, Loader2, Plus, Copy, Check, CheckCircle2, AlertCircle, Trash2,
  MessageCircle, ChevronDown, ChevronUp, ArrowLeft, XCircle, ShieldAlert, Clock,
} from 'lucide-react';
import { api } from '@/lib/api';

interface QuizLink {
  id: string;
  link_code: string;
  title: string;
  difficulty: string;
  question_count: number;
  pass_threshold: number;
  max_attempts: number;
  attempt_count: number;
  expires_at: string | null;
  is_active: boolean;
  creator_name: string | null;
  created_at: string;
  session_count: number;
  completed_count: number;
  cheated_count: number;
  passed_count: number;
  url: string; // origin-relative /quiz/link/CODE
}

interface GuestResult {
  id: string;
  guest_name: string;
  guest_mobile: string;
  guest_position: string;
  score: number;
  total: number;
  percentage: number;
  passed: boolean;
  status: string;
  time_taken_seconds: number | null;
  started_at: string;
  completed_at: string | null;
  responses: {
    question_number: number;
    question: string;
    options: string[];
    correct_index: number;
    selected_index: number | null;
    is_correct: boolean;
  }[];
}

function fullUrl(l: { url: string }): string {
  if (typeof window === 'undefined') return l.url;
  return `${window.location.origin}${l.url}`;
}

function fmtTime(sec: number | null): string {
  if (sec == null) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function fmtDate(d: string | null): string {
  if (!d) return '—';
  return d.replace('T', ' ').slice(0, 16);
}

export default function QuizLinksPage() {
  const [me, setMe] = useState<any>(undefined);
  const [links, setLinks] = useState<QuizLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  // Create form
  const [title, setTitle] = useState('');
  const [difficulty, setDifficulty] = useState('medium');
  const [questionCount, setQuestionCount] = useState(10);
  const [passThreshold, setPassThreshold] = useState(60);
  const [maxAttempts, setMaxAttempts] = useState(100);
  const [expiryDays, setExpiryDays] = useState<string>('');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<QuizLink | null>(null);
  const [copied, setCopied] = useState(false);

  // Row busy states + results drill-down
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { loading: boolean; error?: string; data?: { link: any; results: GuestResult[] } }>>({});
  const [reportFor, setReportFor] = useState<GuestResult | null>(null);

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.json())
      .then(d => setMe(d?.user ?? null))
      .catch(() => setMe(null));
  }, []);

  const refresh = useCallback(() => {
    setLoading(true); setError(null);
    fetch('/api/crm/quiz-links')
      .then(r => r.json())
      .then(j => { if (j.error) setError(j.error); else setLinks(j.links || []); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (me && (me.role === 'admin' || me.is_head_chef)) refresh();
  }, [me, refresh]);

  if (me === undefined) {
    return (
      <div className="p-8 text-center text-sm text-[#8B7355]">
        <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…
      </div>
    );
  }
  if (!me || (me.role !== 'admin' && !me.is_head_chef)) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
          🔒 HOD / Admin only. Quiz links are managed by managers and admins.
        </div>
      </div>
    );
  }

  const createLink = async () => {
    setCreating(true); setError(null); setFlash(null); setCreated(null); setCopied(false);
    try {
      const body: any = {
        title: title.trim() || 'AKAN Staff Quiz',
        difficulty,
        question_count: questionCount,
        pass_threshold: passThreshold,
        max_attempts: maxAttempts,
      };
      if (expiryDays) body.expiry_days = Number(expiryDays);
      const r = await api('/api/crm/quiz-links', { method: 'POST', body });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setCreated(j.link);
      setTitle('');
      refresh();
    } catch (e: any) {
      setError(e.message);
    } finally { setCreating(false); }
  };

  const copyUrl = async (l: QuizLink) => {
    try {
      await navigator.clipboard.writeText(fullUrl(l));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy — long-press the link to copy manually');
    }
  };

  const waShareHref = (l: QuizLink) => {
    const text = `📝 *${l.title}*\nAKAN staff knowledge quiz — ${l.question_count} questions, pass mark ${l.pass_threshold}%.\nTake it here: ${fullUrl(l)}`;
    return `https://wa.me/?text=${encodeURIComponent(text)}`;
  };

  const toggleActive = async (l: QuizLink) => {
    setBusyId(l.id); setError(null);
    try {
      const r = await api(`/api/crm/quiz-links/${l.id}`, { method: 'PUT', body: { is_active: !l.is_active } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setLinks(prev => prev.map(x => x.id === l.id ? { ...x, is_active: !l.is_active } : x));
    } finally { setBusyId(null); }
  };

  const deleteLink = async (l: QuizLink) => {
    if (!window.confirm(`Delete "${l.title}"? This cannot be undone.`)) return;
    setBusyId(l.id); setError(null); setFlash(null);
    try {
      const r = await api(`/api/crm/quiz-links/${l.id}`, { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setFlash('Quiz link deleted');
      if (expandedId === l.id) setExpandedId(null);
      refresh();
    } finally { setBusyId(null); }
  };

  const toggleResults = (l: QuizLink) => {
    if (expandedId === l.id) { setExpandedId(null); return; }
    setExpandedId(l.id);
    setReportFor(null);
    if (!results[l.id]?.data) {
      setResults(prev => ({ ...prev, [l.id]: { loading: true } }));
      fetch(`/api/crm/quiz-links/${l.id}/results`)
        .then(r => r.json())
        .then(j => {
          if (j.error) setResults(prev => ({ ...prev, [l.id]: { loading: false, error: j.error } }));
          else setResults(prev => ({ ...prev, [l.id]: { loading: false, data: j } }));
        })
        .catch(e => setResults(prev => ({ ...prev, [l.id]: { loading: false, error: e.message } })));
    }
  };

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-6xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
          <Link2 className="w-6 h-6 text-[#af4408]" /> Quiz Links
        </h1>
        <p className="text-xs text-[#6B5744] mt-0.5">
          Create shareable quiz links for candidates &amp; staff — no login needed. Share on WhatsApp,
          then review every attempt with per-question report cards.
        </p>
      </div>

      {flash && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-lg p-3 text-sm flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4" /> {flash}
        </div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" /> <span className="min-w-0 break-words">{error}</span>
        </div>
      )}

      {/* Create form */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 sm:p-4 space-y-3">
        <div className="text-sm font-semibold text-[#2D1B0E] flex items-center gap-1.5">
          <Plus className="w-4 h-4 text-[#af4408]" /> Create a new quiz link
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          <div className="col-span-2">
            <label className="text-[10px] uppercase tracking-wide text-[#8B7355]">Title</label>
            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="e.g. Waiter Hiring Quiz — July"
              className="w-full mt-0.5 px-2 py-1.5 bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wide text-[#8B7355]">Difficulty</label>
            <select
              value={difficulty}
              onChange={e => setDifficulty(e.target.value)}
              className="w-full mt-0.5 px-2 py-1.5 bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg text-sm"
            >
              <option value="easy">Easy</option>
              <option value="medium">Medium</option>
              <option value="hard">Hard</option>
            </select>
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wide text-[#8B7355]">Questions</label>
            <input
              type="number" min={1} max={50}
              value={questionCount}
              onChange={e => setQuestionCount(Number(e.target.value))}
              className="w-full mt-0.5 px-2 py-1.5 bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wide text-[#8B7355]">Pass %</label>
            <input
              type="number" min={0} max={100}
              value={passThreshold}
              onChange={e => setPassThreshold(Number(e.target.value))}
              className="w-full mt-0.5 px-2 py-1.5 bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wide text-[#8B7355]">Max attempts</label>
            <input
              type="number" min={1}
              value={maxAttempts}
              onChange={e => setMaxAttempts(Number(e.target.value))}
              className="w-full mt-0.5 px-2 py-1.5 bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wide text-[#8B7355]">Expires</label>
            <select
              value={expiryDays}
              onChange={e => setExpiryDays(e.target.value)}
              className="w-full mt-0.5 px-2 py-1.5 bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg text-sm"
            >
              <option value="">Never</option>
              <option value="1">In 1 day</option>
              <option value="3">In 3 days</option>
              <option value="7">In 7 days</option>
              <option value="14">In 14 days</option>
              <option value="30">In 30 days</option>
            </select>
          </div>
        </div>
        <button
          onClick={createLink}
          disabled={creating || questionCount < 1 || questionCount > 50 || passThreshold < 0 || passThreshold > 100 || maxAttempts < 1}
          className="px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm flex items-center gap-1.5 disabled:opacity-50"
        >
          {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
          {creating ? 'Creating…' : 'Generate link'}
        </button>

        {/* Generated link box */}
        {created && (
          <div className="border border-[#D4B896] bg-[#FFF1E3] rounded-lg p-3 space-y-2">
            <div className="text-xs font-semibold text-[#2D1B0E]">
              Link ready — &quot;{created.title}&quot;
            </div>
            <div className="font-mono text-xs bg-white border border-[#E8D5C4] rounded-lg px-3 py-2 break-all text-[#2D1B0E]">
              {fullUrl(created)}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => copyUrl(created)}
                className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm flex items-center gap-1.5"
              >
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {copied ? 'Copied!' : 'Copy link'}
              </button>
              <a
                href={waShareHref(created)}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm flex items-center gap-1.5"
              >
                <MessageCircle className="w-4 h-4" /> Share on WhatsApp
              </a>
            </div>
          </div>
        )}
      </div>

      {/* Links list */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        <div className="px-4 py-2 bg-[#FFF1E3] border-b border-[#E8D5C4] font-semibold text-sm text-[#2D1B0E]">
          All quiz links
        </div>
        {loading ? (
          <div className="py-10 text-center text-sm text-[#8B7355]">
            <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading links…
          </div>
        ) : links.length === 0 ? (
          <div className="p-4 text-xs text-[#8B7355] italic">No quiz links yet — create your first one above.</div>
        ) : (
          <div className="divide-y divide-[#E8D5C4]/60">
            {links.map(l => {
              const res = results[l.id];
              const expanded = expandedId === l.id;
              return (
                <div key={l.id}>
                  <div className="p-3 sm:px-4 flex flex-wrap items-center gap-x-3 gap-y-2">
                    <div className="min-w-0 flex-1 basis-48">
                      <div className="font-medium text-sm text-[#2D1B0E] truncate">{l.title}</div>
                      <div className="text-[10px] text-[#8B7355] flex flex-wrap gap-x-2">
                        <span className="font-mono">{l.link_code}</span>
                        <span className="capitalize">{l.difficulty}</span>
                        <span>{l.question_count} Qs</span>
                        <span>pass ≥{l.pass_threshold}%</span>
                        <span>
                          {l.expires_at
                            ? (new Date(l.expires_at) < new Date() ? `expired ${fmtDate(l.expires_at)}` : `expires ${fmtDate(l.expires_at)}`)
                            : 'no expiry'}
                        </span>
                      </div>
                    </div>
                    <div className="text-xs text-[#6B5744] whitespace-nowrap">
                      <span className="font-mono font-bold text-[#2D1B0E]">{l.session_count}</span> attempts
                      {l.completed_count > 0 && <span className="ml-1 text-emerald-700">· {l.passed_count} passed</span>}
                      {l.cheated_count > 0 && <span className="ml-1 text-red-600">· {l.cheated_count} flagged</span>}
                    </div>
                    <div className="flex items-center gap-1.5 ml-auto">
                      {/* Active toggle */}
                      <button
                        onClick={() => toggleActive(l)}
                        disabled={busyId === l.id}
                        title={l.is_active ? 'Deactivate link' : 'Activate link'}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 ${l.is_active ? 'bg-emerald-500' : 'bg-[#D4B896]'}`}
                      >
                        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${l.is_active ? 'translate-x-[1.15rem]' : 'translate-x-1'}`} />
                      </button>
                      <button
                        onClick={() => { navigator.clipboard?.writeText(fullUrl(l)).then(() => setFlash(`Copied link for "${l.title}"`)).catch(() => {}); }}
                        title="Copy link"
                        className="p-1.5 text-[#6B5744] hover:text-[#af4408] rounded"
                      >
                        <Copy className="w-4 h-4" />
                      </button>
                      <a
                        href={waShareHref(l)}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Share on WhatsApp"
                        className="p-1.5 text-[#6B5744] hover:text-emerald-600 rounded"
                      >
                        <MessageCircle className="w-4 h-4" />
                      </a>
                      <button
                        onClick={() => deleteLink(l)}
                        disabled={busyId === l.id || l.session_count > 0}
                        title={l.session_count > 0 ? 'Has attempts — deactivate instead' : 'Delete link'}
                        className="p-1.5 text-[#6B5744] hover:text-red-600 rounded disabled:opacity-30"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => toggleResults(l)}
                        className="px-2 py-1 text-xs border border-[#E8D5C4] rounded-lg text-[#6B5744] hover:bg-[#FFF1E3] flex items-center gap-1"
                      >
                        Results {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                      </button>
                    </div>
                  </div>

                  {/* Results drill-down */}
                  {expanded && (
                    <div className="px-3 sm:px-4 pb-3 bg-[#FFF8F0]/60">
                      {res?.loading && (
                        <div className="py-6 text-center text-xs text-[#8B7355]">
                          <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading results…
                        </div>
                      )}
                      {res?.error && (
                        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-2 text-xs">{res.error}</div>
                      )}
                      {res?.data && !reportFor && (
                        res.data.results.length === 0 ? (
                          <div className="py-4 text-center text-xs text-[#8B7355] italic">No attempts yet — share the link to get started.</div>
                        ) : (
                          <div className="overflow-x-auto border border-[#E8D5C4] rounded-lg bg-white">
                            <table className="w-full text-xs min-w-[640px]">
                              <thead className="text-[#6B5744] bg-[#FFF1E3]">
                                <tr>
                                  <th className="text-left py-1.5 px-3 font-medium">Candidate</th>
                                  <th className="text-left py-1.5 px-3 font-medium">Position</th>
                                  <th className="text-right py-1.5 px-3 font-medium">Score</th>
                                  <th className="text-center py-1.5 px-3 font-medium">Result</th>
                                  <th className="text-right py-1.5 px-3 font-medium">Time</th>
                                  <th className="text-left py-1.5 px-3 font-medium">When</th>
                                  <th className="text-right py-1.5 px-3 font-medium"></th>
                                </tr>
                              </thead>
                              <tbody>
                                {res.data.results.map(g => (
                                  <tr key={g.id} className="border-t border-[#E8D5C4]/50">
                                    <td className="py-1.5 px-3">
                                      <div className="font-medium text-[#2D1B0E]">{g.guest_name || '(no name)'}</div>
                                      <div className="text-[10px] text-[#8B7355]">{g.guest_mobile}</div>
                                    </td>
                                    <td className="py-1.5 px-3 text-[#6B5744]">{g.guest_position || '—'}</td>
                                    <td className="py-1.5 px-3 text-right font-mono">
                                      {g.status === 'active' ? '—' : <>{g.score}/{g.total} <span className="text-[#8B7355]">({g.percentage}%)</span></>}
                                    </td>
                                    <td className="py-1.5 px-3 text-center">
                                      {g.status === 'cheated' ? (
                                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-50 text-red-700 border border-red-200 text-[10px]">
                                          <ShieldAlert className="w-3 h-3" /> Flagged
                                        </span>
                                      ) : g.status === 'active' ? (
                                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200 text-[10px]">
                                          <Clock className="w-3 h-3" /> In progress
                                        </span>
                                      ) : g.passed ? (
                                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200 text-[10px]">
                                          <CheckCircle2 className="w-3 h-3" /> Pass
                                        </span>
                                      ) : (
                                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-50 text-red-700 border border-red-200 text-[10px]">
                                          <XCircle className="w-3 h-3" /> Fail
                                        </span>
                                      )}
                                    </td>
                                    <td className="py-1.5 px-3 text-right font-mono text-[#6B5744]">{fmtTime(g.time_taken_seconds)}</td>
                                    <td className="py-1.5 px-3 text-[#8B7355]">{fmtDate(g.started_at)}</td>
                                    <td className="py-1.5 px-3 text-right">
                                      <button
                                        onClick={() => setReportFor(g)}
                                        disabled={g.responses.length === 0}
                                        className="px-2 py-0.5 text-[10px] border border-[#E8D5C4] rounded text-[#6B5744] hover:bg-[#FFF1E3] disabled:opacity-40"
                                      >
                                        Report
                                      </button>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )
                      )}

                      {/* Per-question guest report */}
                      {res?.data && reportFor && (
                        <div className="border border-[#E8D5C4] rounded-lg bg-white p-3 space-y-2">
                          <button
                            onClick={() => setReportFor(null)}
                            className="text-xs text-[#6B5744] hover:text-[#af4408] flex items-center gap-1"
                          >
                            <ArrowLeft className="w-3 h-3" /> Back to attempts
                          </button>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                            <div className="font-semibold text-sm text-[#2D1B0E]">{reportFor.guest_name || '(no name)'}</div>
                            <div className="text-[10px] text-[#8B7355]">{reportFor.guest_mobile} · {reportFor.guest_position || 'position n/a'}</div>
                            <div className={`text-xs font-mono font-bold ${reportFor.passed ? 'text-emerald-700' : 'text-red-600'}`}>
                              {reportFor.score}/{reportFor.total} ({reportFor.percentage}%)
                              {reportFor.status === 'cheated' && <span className="ml-1 text-red-600">· FLAGGED FOR CHEATING</span>}
                            </div>
                            <div className="text-[10px] text-[#8B7355]">Time: {fmtTime(reportFor.time_taken_seconds)}</div>
                          </div>
                          <div className="space-y-2">
                            {reportFor.responses.map(q => (
                              <div key={q.question_number} className={`border rounded-lg p-2 ${q.is_correct ? 'border-emerald-200 bg-emerald-50/50' : 'border-red-200 bg-red-50/40'}`}>
                                <div className="text-xs font-medium text-[#2D1B0E] flex items-start gap-1.5">
                                  {q.is_correct
                                    ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 mt-0.5 flex-shrink-0" />
                                    : <XCircle className="w-3.5 h-3.5 text-red-500 mt-0.5 flex-shrink-0" />}
                                  <span>Q{q.question_number}. {q.question}</span>
                                </div>
                                <div className="mt-1.5 grid grid-cols-1 sm:grid-cols-2 gap-1">
                                  {q.options.map((opt, oi) => (
                                    <div
                                      key={oi}
                                      className={`text-[11px] px-2 py-1 rounded border ${
                                        oi === q.correct_index
                                          ? 'border-emerald-300 bg-emerald-100/60 text-emerald-900 font-medium'
                                          : oi === q.selected_index
                                            ? 'border-red-300 bg-red-100/60 text-red-800'
                                            : 'border-[#E8D5C4]/60 bg-white text-[#6B5744]'
                                      }`}
                                    >
                                      {String.fromCharCode(65 + oi)}. {opt}
                                      {oi === q.correct_index && ' ✓'}
                                      {oi === q.selected_index && oi !== q.correct_index && ' ✗ (their answer)'}
                                    </div>
                                  ))}
                                  {q.selected_index == null && (
                                    <div className="text-[10px] text-[#8B7355] italic px-2 py-1">Not answered</div>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <p className="text-[10px] text-[#8B7355]">
        Deactivating a link stops new attempts instantly but keeps all results. Links with attempts
        cannot be deleted — deactivate them instead so hiring records stay intact.
      </p>
    </div>
  );
}
