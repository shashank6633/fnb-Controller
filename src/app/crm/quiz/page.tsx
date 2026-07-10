'use client';

/**
 * CRM Daily Quiz — staff knowledge quiz (question bank for staff, AI for
 * managers/admins with bank fallback).
 *
 * Flow: setup card → question card (progress, score, 4 options, explanation
 * after answering, Next) → report card (score ring, grade, category bars,
 * weak areas, Play Again). Tab switches during an active quiz are logged
 * via /api/crm/quiz/cheat-log. History list lives below the setup card.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, Brain, Loader2, AlertCircle, CheckCircle2, XCircle, ChevronRight,
  Trophy, RotateCcw, History, Play,
} from 'lucide-react';
import { api } from '@/lib/api';

const CATEGORY_OPTIONS = [
  { value: 'random', label: 'All Topics' },
  { value: 'Menu Knowledge', label: 'Menu Knowledge' },
  { value: 'Service Skills', label: 'Service Skills' },
  { value: 'Communication', label: 'Communication' },
  { value: 'Guest Handling', label: 'Guest Handling' },
  { value: 'Upselling', label: 'Upselling' },
  { value: 'Service SOP', label: 'Service SOP' },
  { value: 'CRM Actions', label: 'CRM Actions' },
];

const DIFFICULTY_OPTIONS = [
  { value: 'random', label: 'Mixed - All Levels' },
  { value: 'easy', label: 'Easy - Quick Recall' },
  { value: 'medium', label: 'Medium - Know Your Stuff' },
  { value: 'hard', label: 'Hard - Expert Challenge' },
];

interface StrippedQuestion { question: string; options: string[]; category: string; difficulty?: string | null; }
interface AnswerState { selected: number; correctIndex: number; explanation: string; isCorrect: boolean; }
interface HistoryItem {
  id: string; category: string; difficulty: string; score: number; total: number;
  percentage: number; completed: boolean; created_at: string;
}

const OPTION_LETTERS = ['A', 'B', 'C', 'D'];

function fmtDate(s: string): string {
  try {
    const d = new Date(s.includes('T') || s.includes('Z') ? s : s.replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return s;
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + ' ' +
      d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  } catch { return s; }
}

export default function CrmQuizPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<'setup' | 'quiz' | 'report'>('setup');
  const [category, setCategory] = useState('random');
  const [difficulty, setDifficulty] = useState('medium');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [source, setSource] = useState<string>('bank');
  const [total, setTotal] = useState(0);
  const [question, setQuestion] = useState<StrippedQuestion | null>(null);
  const [qNumber, setQNumber] = useState(1);
  const [score, setScore] = useState(0);
  const [answering, setAnswering] = useState(false);
  const [answerState, setAnswerState] = useState<AnswerState | null>(null);
  const [pendingNext, setPendingNext] = useState<StrippedQuestion | null>(null);
  const [report, setReport] = useState<any | null>(null);

  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const loadHistory = useCallback(() => {
    setHistoryLoading(true);
    setHistoryError(null);
    fetch('/api/crm/quiz/history')
      .then((r) => r.json())
      .then((j) => {
        if (j.error) { setHistoryError(j.error); return; }
        setHistory(j.history || []);
      })
      .catch((e) => setHistoryError(e.message))
      .finally(() => setHistoryLoading(false));
  }, []);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  // Anti-cheat: log tab switches while a quiz is in progress.
  useEffect(() => {
    if (phase !== 'quiz' || !sessionId) return;
    const onVis = () => {
      if (document.hidden) {
        api('/api/crm/quiz/cheat-log', {
          method: 'POST',
          body: { quiz_session_id: sessionId, cheat_type: 'tab_switch' },
        }).catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [phase, sessionId]);

  const startQuiz = async () => {
    setStarting(true);
    setError(null);
    try {
      const r = await api('/api/crm/quiz/start', {
        method: 'POST',
        body: { category, difficulty, language: 'english', source: 'auto' },
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 429) {
        setError(`AI is busy. Please try again${j.wait_seconds ? ` in ~${j.wait_seconds}s` : ' in a minute'}.`);
        return;
      }
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setSessionId(j.quiz_session_id);
      setSource(j.source || 'bank');
      setTotal(j.total || j.total_questions || 0);
      setQuestion(j.question);
      setQNumber(1);
      setScore(0);
      setAnswerState(null);
      setPendingNext(null);
      setReport(null);
      setPhase('quiz');
    } catch (e: any) {
      setError(e?.message || 'Failed to start quiz');
    } finally {
      setStarting(false);
    }
  };

  const answer = async (idx: number) => {
    if (!sessionId || answering || answerState) return;
    setAnswering(true);
    setError(null);
    try {
      const r = await api('/api/crm/quiz/answer', {
        method: 'POST',
        body: { quiz_session_id: sessionId, question_number: qNumber, selected_index: idx },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setAnswerState({
        selected: idx,
        correctIndex: j.correct_index,
        explanation: j.explanation || '',
        isCorrect: !!j.correct,
      });
      setScore(j.score ?? score);
      setPendingNext(j.next_question || null);
      if (j.is_completed && j.report) setReport(j.report);
    } catch (e: any) {
      setError(e?.message || 'Failed to submit answer');
    } finally {
      setAnswering(false);
    }
  };

  const next = () => {
    if (report) {
      setPhase('report');
      loadHistory();
      return;
    }
    if (pendingNext) {
      setQuestion(pendingNext);
      setQNumber((n) => n + 1);
      setAnswerState(null);
      setPendingNext(null);
    }
  };

  const playAgain = () => {
    setPhase('setup');
    setSessionId(null);
    setQuestion(null);
    setReport(null);
    setAnswerState(null);
    setError(null);
    loadHistory();
  };

  const pct = report ? report.percentage : 0;
  const ringCircumference = 2 * Math.PI * 52;

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-3xl mx-auto">
      <button
        onClick={() => router.back()}
        className="inline-flex items-center gap-1 text-sm text-[#6B5744] hover:text-[#2D1B0E] transition-colors"
      >
        <ArrowLeft className="w-4 h-4" /> Back
      </button>
      <div className="flex items-center gap-2">
        <Brain className="w-6 h-6 text-[#af4408]" />
        <h1 className="text-xl font-bold text-[#2D1B0E]">Daily Quiz</h1>
      </div>

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
            <h2 className="font-semibold text-[#2D1B0E]">Start a Quiz</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
            </div>
            <button
              onClick={startQuiz}
              disabled={starting}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-60 text-white text-sm font-medium rounded-lg px-5 py-2.5 transition-colors"
            >
              {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              {starting ? 'Preparing questions...' : 'Start Quiz'}
            </button>
            <p className="text-xs text-[#8B7355]">
              10 questions. Switching tabs during the quiz is recorded.
            </p>
          </div>

          {/* History */}
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 sm:p-5 space-y-3">
            <div className="flex items-center gap-2">
              <History className="w-4 h-4 text-[#8B7355]" />
              <h2 className="font-semibold text-[#2D1B0E]">Recent Quizzes</h2>
            </div>
            {historyLoading ? (
              <div className="flex items-center gap-2 text-sm text-[#8B7355] py-4">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading history...
              </div>
            ) : historyError ? (
              <p className="text-sm text-red-600">{historyError}</p>
            ) : history.length === 0 ? (
              <p className="text-sm text-[#8B7355] py-2">No quizzes yet. Take your first one above.</p>
            ) : (
              <ul className="divide-y divide-[#F3E7D9]">
                {history.map((h) => (
                  <li key={h.id} className="py-2.5 flex items-center justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <p className="text-sm text-[#2D1B0E] font-medium capitalize">
                        {h.difficulty} · {h.category === 'question_bank' ? 'Question Bank' : h.category}
                      </p>
                      <p className="text-xs text-[#8B7355]">{fmtDate(h.created_at)}{!h.completed && ' · incomplete'}</p>
                    </div>
                    <div className={`text-sm font-semibold shrink-0 ${h.percentage >= 70 ? 'text-green-700' : h.percentage >= 50 ? 'text-amber-600' : 'text-red-600'}`}>
                      {h.score}/{h.total} · {h.percentage}%
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {/* ---------- QUESTION ---------- */}
      {phase === 'quiz' && question && (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 sm:p-5 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <span className="text-sm font-medium text-[#6B5744]">Question {qNumber} / {total}</span>
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold text-[#af4408]">Score: {score}</span>
              <span className="text-xs bg-[#FFF8F0] border border-[#E8D5C4] text-[#8B7355] rounded-full px-2 py-0.5">
                {source === 'bank' ? 'Question Bank' : 'AI Generated'}
              </span>
            </div>
          </div>

          {/* progress bar */}
          <div className="h-1.5 bg-[#F3E7D9] rounded-full overflow-hidden">
            <div
              className="h-full bg-[#af4408] rounded-full transition-all"
              style={{ width: `${total > 0 ? ((qNumber - (answerState ? 0 : 1)) / total) * 100 : 0}%` }}
            />
          </div>

          {question.category && (
            <span className="inline-block text-xs bg-[#FFF8F0] border border-[#E8D5C4] text-[#6B5744] rounded-full px-2.5 py-0.5">
              {question.category}
            </span>
          )}
          <p className="text-base font-medium text-[#2D1B0E] leading-relaxed">{question.question}</p>

          <div className="space-y-2">
            {question.options.map((opt, idx) => {
              let cls = 'border-[#E8D5C4] bg-[#FFF8F0] hover:border-[#af4408]/50 text-[#2D1B0E]';
              if (answerState) {
                if (idx === answerState.correctIndex) {
                  cls = 'border-green-500 bg-green-50 text-green-900';
                } else if (idx === answerState.selected) {
                  cls = 'border-red-400 bg-red-50 text-red-800';
                } else {
                  cls = 'border-[#E8D5C4] bg-white text-[#8B7355]';
                }
              }
              return (
                <button
                  key={idx}
                  onClick={() => answer(idx)}
                  disabled={!!answerState || answering}
                  className={`w-full text-left border rounded-lg px-3.5 py-3 text-sm transition-colors flex items-start gap-2.5 disabled:cursor-default ${cls}`}
                >
                  <span className="font-semibold shrink-0">{OPTION_LETTERS[idx] || idx + 1}.</span>
                  <span className="flex-1">{opt}</span>
                  {answerState && idx === answerState.correctIndex && (
                    <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0 mt-0.5" />
                  )}
                  {answerState && idx === answerState.selected && idx !== answerState.correctIndex && (
                    <XCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                  )}
                </button>
              );
            })}
          </div>

          {answering && (
            <div className="flex items-center gap-2 text-sm text-[#8B7355]">
              <Loader2 className="w-4 h-4 animate-spin" /> Checking...
            </div>
          )}

          {answerState && (
            <div className={`rounded-lg border p-3 text-sm ${answerState.isCorrect ? 'bg-green-50 border-green-200 text-green-900' : 'bg-red-50 border-red-200 text-red-800'}`}>
              <p className="font-semibold mb-1">{answerState.isCorrect ? 'Correct!' : 'Not quite.'}</p>
              {answerState.explanation && <p className="leading-relaxed">{answerState.explanation}</p>}
            </div>
          )}

          {answerState && (
            <button
              onClick={next}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-[#af4408] hover:bg-[#8a3506] text-white text-sm font-medium rounded-lg px-5 py-2.5 transition-colors"
            >
              {report ? 'View Report' : 'Next Question'}
              <ChevronRight className="w-4 h-4" />
            </button>
          )}
        </div>
      )}

      {/* ---------- REPORT ---------- */}
      {phase === 'report' && report && (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 sm:p-6 space-y-5">
          <div className="flex items-center gap-2">
            <Trophy className="w-5 h-5 text-[#af4408]" />
            <h2 className="font-semibold text-[#2D1B0E]">Quiz Report</h2>
          </div>

          <div className="flex flex-col sm:flex-row items-center gap-5">
            {/* score ring */}
            <div className="relative shrink-0">
              <svg viewBox="0 0 120 120" className="w-32 h-32">
                <circle cx="60" cy="60" r="52" fill="none" stroke="#F3E7D9" strokeWidth="10" />
                <circle
                  cx="60" cy="60" r="52" fill="none"
                  stroke={pct >= 70 ? '#16a34a' : pct >= 50 ? '#d97706' : '#dc2626'}
                  strokeWidth="10" strokeLinecap="round"
                  strokeDasharray={`${(ringCircumference * pct) / 100} ${ringCircumference}`}
                  transform="rotate(-90 60 60)"
                />
                <text x="60" y="56" textAnchor="middle" fontSize="26" fontWeight="700" fill="#2D1B0E">{report.grade}</text>
                <text x="60" y="78" textAnchor="middle" fontSize="14" fill="#6B5744">{pct}%</text>
              </svg>
            </div>
            <div className="text-center sm:text-left space-y-1">
              <p className="text-lg font-semibold text-[#2D1B0E]">{report.score} / {report.total} correct</p>
              <p className="text-sm text-[#6B5744]">{report.message}</p>
            </div>
          </div>

          {/* category bars */}
          {report.category_breakdown && Object.keys(report.category_breakdown).length > 0 && (
            <div className="space-y-2.5">
              <h3 className="text-sm font-semibold text-[#2D1B0E]">By Category</h3>
              {Object.entries(report.category_breakdown as Record<string, any>).map(([cat, d]) => (
                <div key={cat}>
                  <div className="flex items-center justify-between text-xs text-[#6B5744] mb-1">
                    <span>{cat}</span>
                    <span>{d.correct}/{d.total}</span>
                  </div>
                  <div className="h-2 bg-[#F3E7D9] rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${d.percentage >= 70 ? 'bg-green-500' : d.percentage >= 50 ? 'bg-amber-500' : 'bg-red-500'}`}
                      style={{ width: `${d.percentage}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* weak areas */}
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
            onClick={playAgain}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-[#af4408] hover:bg-[#8a3506] text-white text-sm font-medium rounded-lg px-5 py-2.5 transition-colors"
          >
            <RotateCcw className="w-4 h-4" />
            Play Again
          </button>
        </div>
      )}
    </div>
  );
}
