'use client';

/**
 * CRM Training Simulator — the AI role-plays a customer calling Akan; staff
 * answer as front desk; each answer gets a Score Card (score/10, good points,
 * missed points, ideal response, pro tip). 10 questions per session, then a
 * final Report Card. History list on the setup screen.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, GraduationCap, Loader2, AlertCircle, Send, History, Play, Trophy,
  RotateCcw, Lightbulb, CheckCircle2, XCircle, MessageSquareQuote, LogOut,
} from 'lucide-react';
import { api } from '@/lib/api';

const DIFFICULTY_OPTIONS = [
  { value: 'easy', label: 'Easy - Simple Questions' },
  { value: 'medium', label: 'Medium - Detailed Answers' },
  { value: 'hard', label: 'Hard - Complex Scenarios' },
];

// Same 18 categories as the Flask training sidebar.
const CATEGORY_OPTIONS = [
  { value: 'random', label: 'Random (All Topics)' },
  { value: 'timings', label: 'Timings' },
  { value: 'entry_cover', label: 'Entry & Cover Charges' },
  { value: 'age_policy', label: 'Age Policy' },
  { value: 'spaces', label: 'Spaces & Seating' },
  { value: 'events', label: 'Events & Live Bands' },
  { value: 'sunday_brunch', label: 'Sunday Brunch' },
  { value: 'workshops', label: 'Workshops' },
  { value: 'reservations', label: 'Reservations' },
  { value: 'corporate', label: 'Corporate Events' },
  { value: 'birthday', label: 'Birthday Parties' },
  { value: 'complaints', label: 'Complaint Handling' },
  { value: 'menu_food', label: 'Menu & Food Items' },
  { value: 'bar_drinks', label: 'Bar & Drinks' },
  { value: 'desserts', label: 'Desserts' },
  { value: 'dietary', label: 'Dietary / Allergies' },
  { value: 'sushi_asian', label: 'Sushi & Pan-Asian' },
  { value: 'delivery', label: 'Takeaway & Delivery' },
];

const LANGUAGE_OPTIONS = [
  { value: 'english', label: 'English' },
  { value: 'telugu', label: 'Telugu' },
  { value: 'hindi', label: 'Hindi' },
];

type StreamItem =
  | { type: 'question'; text: string; number: number }
  | { type: 'answer'; text: string }
  | { type: 'evaluation'; evaluation: any; number: number };

interface HistoryItem {
  id: string; difficulty: string; category: string; language: string;
  total_score: number; questions_asked: number; average_score: number;
  percentage: number; completed: boolean; created_at: string;
}

const TOTAL_QUESTIONS = 10;

function fmtDate(s: string): string {
  try {
    const d = new Date(s.includes('T') || s.includes('Z') ? s : s.replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return s;
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + ' ' +
      d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  } catch { return s; }
}

function scoreColor(score: number): string {
  if (score >= 8) return 'bg-green-100 text-green-800 border-green-300';
  if (score >= 6) return 'bg-amber-100 text-amber-800 border-amber-300';
  return 'bg-red-100 text-red-700 border-red-300';
}

function catLabel(value: string): string {
  return CATEGORY_OPTIONS.find((c) => c.value === value)?.label || value;
}

export default function CrmTrainingPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<'setup' | 'session'>('setup');
  const [difficulty, setDifficulty] = useState('medium');
  const [category, setCategory] = useState('random');
  const [language, setLanguage] = useState('english');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [ids, setIds] = useState<{ training: string; chat: string } | null>(null);
  const [stream, setStream] = useState<StreamItem[]>([]);
  const [answered, setAnswered] = useState(0);
  const [runningAvg, setRunningAvg] = useState<number | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [report, setReport] = useState<any | null>(null);

  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement | null>(null);

  const loadHistory = useCallback(() => {
    setHistoryLoading(true);
    setHistoryError(null);
    fetch('/api/crm/training/history')
      .then((r) => r.json())
      .then((j) => {
        if (j.error) { setHistoryError(j.error); return; }
        setHistory(j.history || []);
      })
      .catch((e) => setHistoryError(e.message))
      .finally(() => setHistoryLoading(false));
  }, []);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [stream, report, sending]);

  const startTraining = async () => {
    setStarting(true);
    setError(null);
    try {
      const r = await api('/api/crm/training/start', {
        method: 'POST',
        body: { difficulty, category, language },
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 429) {
        setError(`AI is busy. Please try again${j.wait_seconds ? ` in ~${j.wait_seconds}s` : ' in a minute'}.`);
        return;
      }
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setIds({ training: j.training_session_id, chat: j.chat_session_id });
      setStream([{ type: 'question', text: j.question, number: 1 }]);
      setAnswered(0);
      setRunningAvg(null);
      setReport(null);
      setInput('');
      setPhase('session');
    } catch (e: any) {
      setError(e?.message || 'Failed to start training');
    } finally {
      setStarting(false);
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || !ids || sending || report) return;
    setSending(true);
    setError(null);
    try {
      const r = await api('/api/crm/training/respond', {
        method: 'POST',
        body: { training_session_id: ids.training, chat_session_id: ids.chat, response: text },
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 429) {
        setError(`AI is busy. Your answer is kept below — try Send again${j.wait_seconds ? ` in ~${j.wait_seconds}s` : ' in a minute'}.`);
        return;
      }
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }

      setInput('');
      setStream((prev) => {
        const items: StreamItem[] = [
          ...prev,
          { type: 'answer', text },
          { type: 'evaluation', evaluation: j.evaluation, number: j.question_number },
        ];
        if (!j.is_completed && j.next_question) {
          items.push({ type: 'question', text: j.next_question, number: j.question_number + 1 });
        }
        return items;
      });
      setAnswered(j.question_number);
      setRunningAvg(j.running_average ?? null);
      if (j.is_completed) {
        setReport(j.report || null);
        loadHistory();
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to send response');
    } finally {
      setSending(false);
    }
  };

  const endSession = () => {
    if (!report && stream.length > 0 && !window.confirm('End this training session? Progress so far stays in your history.')) return;
    setPhase('setup');
    setIds(null);
    setStream([]);
    setReport(null);
    setError(null);
    loadHistory();
  };

  const currentQuestionNumber = Math.min(answered + 1, TOTAL_QUESTIONS);

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-3xl mx-auto">
      <button
        onClick={() => router.back()}
        className="inline-flex items-center gap-1 text-sm text-[#6B5744] hover:text-[#2D1B0E] transition-colors"
      >
        <ArrowLeft className="w-4 h-4" /> Back
      </button>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <GraduationCap className="w-6 h-6 text-[#af4408]" />
          <h1 className="text-xl font-bold text-[#2D1B0E]">Training Simulator</h1>
        </div>
        {phase === 'session' && (
          <div className="flex items-center gap-3 text-sm">
            <span className="text-[#6B5744] font-medium">
              Question {report ? answered : currentQuestionNumber} / {TOTAL_QUESTIONS}
            </span>
            {runningAvg != null && (
              <span className="font-semibold text-[#af4408]">Avg: {runningAvg}/10</span>
            )}
            <button
              onClick={endSession}
              className="inline-flex items-center gap-1 text-xs text-[#8B7355] hover:text-[#af4408] border border-[#E8D5C4] rounded-lg px-2.5 py-1.5 transition-colors"
            >
              <LogOut className="w-3.5 h-3.5" /> End
            </button>
          </div>
        )}
      </div>

      {phase === 'session' && (
        <div className="h-1.5 bg-[#F3E7D9] rounded-full overflow-hidden">
          <div
            className="h-full bg-[#af4408] rounded-full transition-all"
            style={{ width: `${(answered / TOTAL_QUESTIONS) * 100}%` }}
          />
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 rounded-xl p-3 text-sm">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* ---------- SETUP ---------- */}
      {phase === 'setup' && (
        <>
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 sm:p-5 space-y-4">
            <h2 className="font-semibold text-[#2D1B0E]">Training Setup</h2>
            <p className="text-sm text-[#6B5744]">
              The AI plays a customer calling Akan. Answer like front desk staff — each reply is
              scored out of 10 with coaching feedback. {TOTAL_QUESTIONS} questions per session.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <label className="block">
                <span className="text-sm text-[#6B5744] mb-1 block">Difficulty</span>
                <select
                  value={difficulty}
                  onChange={(e) => setDifficulty(e.target.value)}
                  className="w-full bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm text-[#2D1B0E] focus:outline-none focus:ring-2 focus:ring-[#af4408]/30"
                >
                  {DIFFICULTY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-sm text-[#6B5744] mb-1 block">Category</span>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm text-[#2D1B0E] focus:outline-none focus:ring-2 focus:ring-[#af4408]/30"
                >
                  {CATEGORY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-sm text-[#6B5744] mb-1 block">Language</span>
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  className="w-full bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm text-[#2D1B0E] focus:outline-none focus:ring-2 focus:ring-[#af4408]/30"
                >
                  {LANGUAGE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </label>
            </div>
            <button
              onClick={startTraining}
              disabled={starting}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-60 text-white text-sm font-medium rounded-lg px-5 py-2.5 transition-colors"
            >
              {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              {starting ? 'Connecting to your customer...' : 'Start Training'}
            </button>
          </div>

          {/* History */}
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 sm:p-5 space-y-3">
            <div className="flex items-center gap-2">
              <History className="w-4 h-4 text-[#8B7355]" />
              <h2 className="font-semibold text-[#2D1B0E]">Recent Training</h2>
            </div>
            {historyLoading ? (
              <div className="flex items-center gap-2 text-sm text-[#8B7355] py-4">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading history...
              </div>
            ) : historyError ? (
              <p className="text-sm text-red-600">{historyError}</p>
            ) : history.length === 0 ? (
              <p className="text-sm text-[#8B7355] py-2">No training sessions yet. Start your first one above.</p>
            ) : (
              <ul className="divide-y divide-[#F3E7D9]">
                {history.map((h) => (
                  <li key={h.id} className="py-2.5 flex items-center justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <p className="text-sm text-[#2D1B0E] font-medium capitalize">
                        {h.difficulty} · {catLabel(h.category)}
                      </p>
                      <p className="text-xs text-[#8B7355]">
                        {fmtDate(h.created_at)} · {h.questions_asked}/{TOTAL_QUESTIONS} answered{!h.completed && ' · incomplete'}
                      </p>
                    </div>
                    <div className={`text-sm font-semibold shrink-0 ${h.average_score >= 7 ? 'text-green-700' : h.average_score >= 5 ? 'text-amber-600' : 'text-red-600'}`}>
                      {h.questions_asked > 0 ? `${h.average_score}/10 avg` : '—'}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {/* ---------- SESSION ---------- */}
      {phase === 'session' && (
        <div className="space-y-3">
          {stream.map((item, i) => {
            if (item.type === 'question') {
              return (
                <div key={i} className="flex justify-start">
                  <div className="max-w-[92%] sm:max-w-[80%] bg-white border border-[#E8D5C4] rounded-xl rounded-tl-sm p-3.5">
                    <p className="text-xs font-semibold text-[#af4408] mb-1">Customer · Q{item.number}</p>
                    <p className="text-sm text-[#2D1B0E] leading-relaxed whitespace-pre-wrap">{item.text}</p>
                  </div>
                </div>
              );
            }
            if (item.type === 'answer') {
              return (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[92%] sm:max-w-[80%] bg-[#af4408] text-white rounded-xl rounded-tr-sm p-3.5">
                    <p className="text-xs font-semibold text-white/80 mb-1">You (Front Desk)</p>
                    <p className="text-sm leading-relaxed whitespace-pre-wrap">{item.text}</p>
                  </div>
                </div>
              );
            }
            const ev = item.evaluation || {};
            return (
              <div key={i} className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-xl p-4 space-y-2.5">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <p className="text-sm font-semibold text-[#2D1B0E]">Score Card · Q{item.number}</p>
                  <span className={`text-sm font-bold border rounded-full px-3 py-0.5 ${scoreColor(Number(ev.score) || 0)}`}>
                    {ev.score ?? '-'}/10
                  </span>
                </div>
                {ev.category && (
                  <span className="inline-block text-xs bg-white border border-[#E8D5C4] text-[#6B5744] rounded-full px-2.5 py-0.5">
                    {ev.category}
                  </span>
                )}
                {ev.good_points && (
                  <div className="flex items-start gap-2 text-sm">
                    <CheckCircle2 className="w-4 h-4 text-green-600 mt-0.5 shrink-0" />
                    <p className="text-[#2D1B0E]"><span className="font-medium">Good:</span> {ev.good_points}</p>
                  </div>
                )}
                {ev.missed_points && (
                  <div className="flex items-start gap-2 text-sm">
                    <XCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                    <p className="text-[#2D1B0E]"><span className="font-medium">Missed:</span> {ev.missed_points}</p>
                  </div>
                )}
                {ev.ideal_response && (
                  <div className="flex items-start gap-2 text-sm">
                    <MessageSquareQuote className="w-4 h-4 text-[#af4408] mt-0.5 shrink-0" />
                    <p className="text-[#2D1B0E]"><span className="font-medium">Ideal response:</span> {ev.ideal_response}</p>
                  </div>
                )}
                {ev.pro_tip && (
                  <div className="flex items-start gap-2 text-sm">
                    <Lightbulb className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                    <p className="text-[#2D1B0E]"><span className="font-medium">Pro tip:</span> {ev.pro_tip}</p>
                  </div>
                )}
              </div>
            );
          })}

          {sending && (
            <div className="flex items-center gap-2 text-sm text-[#8B7355] px-1">
              <Loader2 className="w-4 h-4 animate-spin" /> Evaluating your response...
            </div>
          )}

          {/* Final report */}
          {report && (
            <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 sm:p-6 space-y-4">
              <div className="flex items-center gap-2">
                <Trophy className="w-5 h-5 text-[#af4408]" />
                <h2 className="font-semibold text-[#2D1B0E]">Report Card</h2>
              </div>
              <div className="flex items-center gap-4 flex-wrap">
                <div className="text-center bg-[#FFF8F0] border border-[#E8D5C4] rounded-xl px-5 py-3">
                  <p className="text-3xl font-bold text-[#af4408]">{report.grade}</p>
                  <p className="text-xs text-[#8B7355] mt-0.5">{report.percentage}%</p>
                </div>
                <div className="space-y-0.5">
                  <p className="text-sm font-semibold text-[#2D1B0E]">
                    {report.total_score} / {report.max_score} points · avg {report.average_score}/10
                  </p>
                  <p className="text-sm text-[#6B5744]">{report.message}</p>
                </div>
              </div>

              {report.category_scores && Object.keys(report.category_scores).length > 0 && (
                <div className="space-y-2.5">
                  <h3 className="text-sm font-semibold text-[#2D1B0E]">By Category</h3>
                  {Object.entries(report.category_scores as Record<string, any>).map(([cat, d]) => (
                    <div key={cat}>
                      <div className="flex items-center justify-between text-xs text-[#6B5744] mb-1">
                        <span>{cat}</span>
                        <span>{d.average}/10 ({d.count} q)</span>
                      </div>
                      <div className="h-2 bg-[#F3E7D9] rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${d.average >= 7 ? 'bg-green-500' : d.average >= 5 ? 'bg-amber-500' : 'bg-red-500'}`}
                          style={{ width: `${Math.min(100, (d.average / 10) * 100)}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {report.weak_areas && report.weak_areas.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold text-[#2D1B0E]">Focus Areas</h3>
                  <div className="flex flex-wrap gap-2">
                    {report.weak_areas.map((w: string) => (
                      <span key={w} className="text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded-full px-2.5 py-1">
                        {w}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <button
                onClick={endSession}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-[#af4408] hover:bg-[#8a3506] text-white text-sm font-medium rounded-lg px-5 py-2.5 transition-colors"
              >
                <RotateCcw className="w-4 h-4" />
                Start New Session
              </button>
            </div>
          )}

          {/* Composer */}
          {!report && (
            <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 space-y-2 sticky bottom-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
                }}
                placeholder="Type your response to the customer..."
                rows={3}
                disabled={sending}
                className="w-full bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm text-[#2D1B0E] resize-none focus:outline-none focus:ring-2 focus:ring-[#af4408]/30 disabled:opacity-60"
              />
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-[#8B7355] hidden sm:block">Enter to send · Shift+Enter for a new line</p>
                <button
                  onClick={send}
                  disabled={sending || !input.trim()}
                  className="inline-flex items-center gap-2 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors ml-auto"
                >
                  {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  Send
                </button>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
