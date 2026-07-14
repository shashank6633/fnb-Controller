'use client';

/**
 * Knowledge Tests (/tasks/knowledge-tests).
 *
 * Everyone signed in can browse active tests and take them: a timed runner
 * renders MCQ / image / practical questions, auto-scores MCQ+image on submit,
 * and shows the pass/fail result. Managers (canManageTasks) additionally get a
 * builder to create / edit / deactivate tests and a per-test leaderboard.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle, ArrowLeft, Award, BookOpen, CheckCircle2, ChevronLeft, ChevronRight,
  Clock, Loader2, Pencil, Plus, RefreshCw, Search, Trash2, Trophy, X, XCircle,
} from 'lucide-react';
import { api } from '@/lib/api';
import { canManageTasks } from '@/lib/tasks';

type QType = 'mcq' | 'image' | 'practical';
interface Question { q: string; type: QType; options: string[]; answer: string; image_url: string }
interface TestRow {
  id: string;
  title: string;
  description: string;
  questions_json: string;
  time_limit_minutes: number;
  pass_score: number;
  is_active: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  question_count?: number;
  my_last_result?: { score: number; passed: number; taken_at: string; reviewed: number } | null;
  attempt_count?: number;
}

const parseQ = (json: string): Question[] => {
  try { const a = JSON.parse(json || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
};
const fmtWhen = (s: string | null | undefined) => {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const mmss = (secs: number) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

export default function KnowledgeTestsPage() {
  const router = useRouter();
  const [me, setMe] = useState<any>(undefined);
  const [rows, setRows] = useState<TestRow[]>([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // runner
  const [runTest, setRunTest] = useState<TestRow | null>(null);
  // builder
  const [showBuilder, setShowBuilder] = useState(false);
  const [editTest, setEditTest] = useState<TestRow | null>(null);
  // leaderboard
  const [lbTest, setLbTest] = useState<TestRow | null>(null);

  const canManage = canManageTasks(me);

  useEffect(() => {
    fetch('/api/auth/me').then((r) => r.json()).then((d) => setMe(d?.user ?? null)).catch(() => setMe(null));
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/tasks/knowledge-tests?q=${encodeURIComponent(q)}`)
      .then((r) => r.json())
      .then((j) => { if (j.error) { setError(j.error); setRows([]); } else setRows(j.rows || []); })
      .catch((e) => { setError(e?.message || 'Failed to load'); setRows([]); })
      .finally(() => setLoading(false));
  }, [q]);

  useEffect(() => {
    if (me === undefined || me === null) return;
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [me, load]);

  const removeTest = async (t: TestRow) => {
    if (!confirm(`Deactivate test "${t.title}"?`)) return;
    try {
      const r = await api(`/api/tasks/knowledge-tests?id=${encodeURIComponent(t.id)}`, { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setNotice('Test deactivated');
      load();
    } catch (e: any) { setError(e?.message || 'Failed'); }
  };

  if (me === undefined) return <div className="p-8 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…</div>;
  if (!me) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <button onClick={() => router.back()} className="inline-flex items-center gap-1 text-sm text-[#6B5744] hover:text-[#2D1B0E] mb-3"><ArrowLeft className="w-4 h-4" /> Back</button>
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">🔒 Please sign in to take knowledge tests.</div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-6xl mx-auto pb-16">
      {/* Header */}
      <div>
        <button onClick={() => router.back()} className="inline-flex items-center gap-1 text-sm text-[#6B5744] hover:text-[#2D1B0E] mb-2"><ArrowLeft className="w-4 h-4" /> Back</button>
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#af4408] text-white flex items-center justify-center shrink-0"><BookOpen size={20} /></div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl sm:text-2xl font-bold text-[#2D1B0E]">Knowledge Tests</h1>
            <p className="text-xs text-[#8B7355]">Take timed tests, auto-scored — with leaderboards {canManage && '& a test builder'}</p>
          </div>
          <button onClick={load} disabled={loading} className="inline-flex items-center gap-1.5 bg-white border border-[#E8D5C4] hover:border-[#af4408] text-[#2D1B0E] text-sm rounded-lg px-3 py-2 disabled:opacity-50"><RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh</button>
          {canManage && <button onClick={() => { setEditTest(null); setShowBuilder(true); }} className="inline-flex items-center gap-1.5 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm rounded-lg px-3 py-2"><Plus size={14} /> New Test</button>}
        </div>
      </div>

      {notice && (
        <div className="flex items-center justify-between gap-2 bg-green-50 border border-green-200 text-green-800 text-sm rounded-lg px-3 py-2">
          <span className="flex items-center gap-2"><CheckCircle2 size={15} className="shrink-0" /> {notice}</span>
          <button onClick={() => setNotice(null)} className="text-green-700 hover:text-green-900"><X size={14} /></button>
        </div>
      )}
      {error && <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2"><AlertCircle size={15} className="shrink-0" /> {error}</div>}

      {/* Search */}
      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8B7355]" />
        <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tests…" className="w-full border border-[#E8D5C4] rounded-lg pl-9 pr-3 py-2 text-sm bg-white focus:outline-none focus:border-[#af4408]" />
      </div>

      {loading && rows.length === 0 && <div className="p-8 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading tests…</div>}
      {!loading && rows.length === 0 && !error && (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center text-sm text-[#8B7355]">
          {q ? 'No tests match your search.' : <>No knowledge tests yet.{canManage && <> Tap <span className="font-semibold">New Test</span> to build one.</>}</>}
        </div>
      )}

      {/* Test cards */}
      {rows.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {rows.map((t) => {
            const last = t.my_last_result;
            return (
              <div key={t.id} className={`bg-white border rounded-xl p-4 flex flex-col ${t.is_active ? 'border-[#E8D5C4]' : 'border-gray-200 opacity-70'}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-[#2D1B0E] flex items-center gap-2 flex-wrap">
                      {t.title}
                      {!t.is_active && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600 border border-gray-200">inactive</span>}
                    </div>
                    {t.description && <p className="text-xs text-[#8B7355] mt-0.5 line-clamp-2">{t.description}</p>}
                  </div>
                  {canManage && (
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => { setEditTest(t); setShowBuilder(true); }} className="p-1.5 rounded-lg hover:bg-[#FFF8F0] text-[#8B7355] hover:text-[#af4408]" title="Edit"><Pencil size={15} /></button>
                      {!!t.is_active && <button onClick={() => removeTest(t)} className="p-1.5 rounded-lg hover:bg-red-50 text-[#8B7355] hover:text-red-600" title="Deactivate"><Trash2 size={15} /></button>}
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-xs text-[#6B5744]">
                  <span>{t.question_count ?? parseQ(t.questions_json).length} questions</span>
                  <span>Pass ≥ {t.pass_score}%</span>
                  <span className="inline-flex items-center gap-1"><Clock size={11} /> {t.time_limit_minutes > 0 ? `${t.time_limit_minutes} min` : 'No limit'}</span>
                  {typeof t.attempt_count === 'number' && t.attempt_count > 0 && <span>{t.attempt_count} attempt{t.attempt_count === 1 ? '' : 's'}</span>}
                </div>

                {last && (
                  <div className={`mt-2 inline-flex items-center gap-1.5 text-xs rounded-lg px-2.5 py-1 border ${last.passed ? 'bg-green-50 text-green-700 border-green-200' : 'bg-rose-50 text-rose-700 border-rose-200'}`}>
                    {last.passed ? <CheckCircle2 size={13} /> : <XCircle size={13} />} Last: {last.score}% {last.passed ? 'passed' : 'failed'}
                    {!last.reviewed && <span className="text-[#8B7355]">· review pending</span>}
                  </div>
                )}

                <div className="mt-3 pt-3 border-t border-[#F0E4D6] flex items-center gap-2">
                  <button onClick={() => setRunTest(t)} disabled={!t.is_active || (t.question_count ?? parseQ(t.questions_json).length) === 0} className="flex-1 inline-flex items-center justify-center gap-1.5 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm rounded-lg px-3 py-2 disabled:opacity-50">
                    <Award size={14} /> {last ? 'Retake' : 'Take Test'}
                  </button>
                  {canManage && <button onClick={() => setLbTest(t)} className="inline-flex items-center gap-1.5 bg-white border border-[#E8D5C4] hover:border-[#af4408] text-[#2D1B0E] text-sm rounded-lg px-3 py-2"><Trophy size={14} /> Leaderboard</button>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {runTest && <TestRunner test={runTest} onClose={() => setRunTest(null)} onDone={(msg) => { setNotice(msg); load(); }} />}
      {showBuilder && <TestBuilder test={editTest} onClose={() => setShowBuilder(false)} onSaved={(msg) => { setShowBuilder(false); setNotice(msg); load(); }} onError={setError} />}
      {lbTest && <Leaderboard test={lbTest} onClose={() => setLbTest(null)} />}
    </div>
  );
}

/* ── Test runner (timed) ────────────────────────────────────────────────── */

function TestRunner({ test, onClose, onDone }: { test: TestRow; onClose: () => void; onDone: (msg: string) => void }) {
  const [questions, setQuestions] = useState<Question[] | null>(null);
  const [answers, setAnswers] = useState<string[]>([]);
  const [idx, setIdx] = useState(0);
  const [remaining, setRemaining] = useState<number | null>(null); // seconds, null = no limit
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  // load fresh questions (answers stripped server-side for takers)
  useEffect(() => {
    fetch(`/api/tasks/knowledge-tests?view=test&test_id=${encodeURIComponent(test.id)}`)
      .then((r) => r.json())
      .then((j) => {
        if (j.error) { setLoadErr(j.error); return; }
        const qs = parseQ(j.test?.questions_json || '[]');
        setQuestions(qs);
        setAnswers(new Array(qs.length).fill(''));
        if (test.time_limit_minutes > 0) setRemaining(test.time_limit_minutes * 60);
      })
      .catch((e) => setLoadErr(e?.message || 'Failed to load test'));
  }, [test.id, test.time_limit_minutes]);

  const submit = useCallback(async (auto = false) => {
    if (submitting || result) return;
    setSubmitting(true);
    try {
      const r = await api('/api/tasks/knowledge-tests', { method: 'POST', body: { action: 'submit', test_id: test.id, answers } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setLoadErr(j.error || `HTTP ${r.status}`); setSubmitting(false); return; }
      setResult({ ...j, auto });
    } catch (e: any) { setLoadErr(e?.message || 'Failed to submit'); setSubmitting(false); }
  }, [answers, submitting, result, test.id]);

  // countdown
  useEffect(() => {
    if (remaining == null || result) return;
    if (remaining <= 0) { submit(true); return; }
    const t = setTimeout(() => setRemaining((s) => (s == null ? s : s - 1)), 1000);
    return () => clearTimeout(t);
  }, [remaining, result, submit]);

  const setAns = (i: number, v: string) => setAnswers((a) => { const n = [...a]; n[i] = v; return n; });

  const answeredCount = answers.filter((a) => String(a).trim() !== '').length;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={result ? onClose : undefined}>
      <div className="bg-white w-full sm:max-w-2xl rounded-t-2xl sm:rounded-2xl p-4 sm:p-5 space-y-3 max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-bold text-[#2D1B0E] flex items-center gap-2 min-w-0"><Award size={18} className="text-[#af4408] shrink-0" /> <span className="truncate">{test.title}</span></h2>
          <div className="flex items-center gap-2 shrink-0">
            {remaining != null && !result && (
              <span className={`inline-flex items-center gap-1 text-sm font-semibold px-2 py-1 rounded-lg border ${remaining <= 30 ? 'bg-red-50 text-red-700 border-red-200' : 'bg-[#FFF1E3] text-[#8a3606] border-[#E8D5C4]'}`}><Clock size={14} /> {mmss(remaining)}</span>
            )}
            <button onClick={onClose} className="text-[#8B7355] hover:text-[#2D1B0E]"><X size={18} /></button>
          </div>
        </div>

        {loadErr && <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg px-2.5 py-1.5"><AlertCircle size={13} className="shrink-0" /> {loadErr}</div>}

        {/* Result view */}
        {result ? (
          <div className="text-center py-6 space-y-3">
            <div className={`w-16 h-16 mx-auto rounded-full flex items-center justify-center ${result.passed ? 'bg-green-100 text-green-600' : 'bg-rose-100 text-rose-600'}`}>
              {result.passed ? <CheckCircle2 size={34} /> : <XCircle size={34} />}
            </div>
            <div className="text-3xl font-bold text-[#2D1B0E]">{result.score}%</div>
            <div className={`text-sm font-semibold ${result.passed ? 'text-green-700' : 'text-rose-700'}`}>{result.passed ? 'Passed' : 'Failed'} · pass mark {result.pass_score}%</div>
            {result.needs_review && <div className="text-xs text-[#8B7355]">Practical answers submitted — pending manual review.</div>}
            {result.auto && <div className="text-xs text-amber-700">Time expired — your test was auto-submitted.</div>}
            <button onClick={onClose} className="mt-2 inline-flex items-center justify-center gap-1.5 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm rounded-lg px-4 py-2">Done</button>
          </div>
        ) : !questions ? (
          <div className="p-8 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading questions…</div>
        ) : questions.length === 0 ? (
          <div className="p-6 text-center text-sm text-[#8B7355]">This test has no questions.</div>
        ) : (
          <>
            {/* progress */}
            <div className="flex items-center justify-between text-xs text-[#8B7355]">
              <span>Question {idx + 1} of {questions.length}</span>
              <span>{answeredCount}/{questions.length} answered</span>
            </div>
            <div className="h-1.5 bg-[#F0E4D6] rounded-full overflow-hidden"><div className="h-full bg-[#af4408]" style={{ width: `${((idx + 1) / questions.length) * 100}%` }} /></div>

            {/* current question */}
            {(() => {
              const cq = questions[idx];
              return (
                <div className="space-y-3">
                  <div className="font-medium text-[#2D1B0E]">{cq.q}</div>
                  {cq.image_url && <img src={cq.image_url} alt="" className="max-h-56 rounded-lg border border-[#E8D5C4] max-w-full object-contain" />}
                  {cq.type === 'practical' ? (
                    <textarea rows={4} placeholder="Type your answer…" value={answers[idx]} onChange={(e) => setAns(idx, e.target.value)} className="w-full border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#af4408]" />
                  ) : (
                    <div className="space-y-2">
                      {cq.options.length === 0 && <div className="text-xs text-[#8B7355]">No options configured for this question.</div>}
                      {cq.options.map((opt, oi) => (
                        <label key={oi} className={`flex items-center gap-2 border rounded-lg px-3 py-2 text-sm cursor-pointer ${answers[idx] === opt ? 'border-[#af4408] bg-[#FFF1E3]' : 'border-[#E8D5C4] hover:bg-[#FFF8F0]'}`}>
                          <input type="radio" name={`q${idx}`} checked={answers[idx] === opt} onChange={() => setAns(idx, opt)} className="accent-[#af4408]" />
                          <span className="text-[#2D1B0E]">{opt}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* nav */}
            <div className="flex items-center justify-between gap-2 pt-1">
              <button onClick={() => setIdx((i) => Math.max(0, i - 1))} disabled={idx === 0} className="inline-flex items-center gap-1 text-sm border border-[#E8D5C4] rounded-lg px-3 py-2 text-[#2D1B0E] hover:border-[#af4408] disabled:opacity-40"><ChevronLeft size={15} /> Prev</button>
              {idx < questions.length - 1 ? (
                <button onClick={() => setIdx((i) => Math.min(questions.length - 1, i + 1))} className="inline-flex items-center gap-1 text-sm border border-[#E8D5C4] rounded-lg px-3 py-2 text-[#2D1B0E] hover:border-[#af4408]">Next <ChevronRight size={15} /></button>
              ) : (
                <button onClick={() => submit(false)} disabled={submitting} className="inline-flex items-center gap-1.5 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm rounded-lg px-4 py-2 disabled:opacity-50">{submitting ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />} Submit Test</button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ── Test builder (create / edit) ───────────────────────────────────────── */

const BLANK_Q: Question = { q: '', type: 'mcq', options: ['', ''], answer: '', image_url: '' };

function TestBuilder({ test, onClose, onSaved, onError }: { test: TestRow | null; onClose: () => void; onSaved: (msg: string) => void; onError: (e: string) => void }) {
  const [title, setTitle] = useState(test?.title || '');
  const [description, setDescription] = useState(test?.description || '');
  const [timeLimit, setTimeLimit] = useState(test?.time_limit_minutes ? String(test.time_limit_minutes) : '');
  const [passScore, setPassScore] = useState(test ? String(test.pass_score) : '60');
  const [isActive, setIsActive] = useState(test ? !!test.is_active : true);
  const [questions, setQuestions] = useState<Question[]>(() => {
    const qs = test ? parseQ(test.questions_json) : [];
    return qs.length ? qs.map((x) => ({ ...BLANK_Q, ...x, options: Array.isArray(x.options) ? x.options : [] })) : [{ ...BLANK_Q }];
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const upd = (i: number, patch: Partial<Question>) => setQuestions((qs) => qs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const updOpt = (qi: number, oi: number, v: string) => setQuestions((qs) => qs.map((x, j) => (j === qi ? { ...x, options: x.options.map((o, k) => (k === oi ? v : o)) } : x)));
  const addOpt = (qi: number) => setQuestions((qs) => qs.map((x, j) => (j === qi ? { ...x, options: [...x.options, ''] } : x)));
  const rmOpt = (qi: number, oi: number) => setQuestions((qs) => qs.map((x, j) => (j === qi ? { ...x, options: x.options.filter((_, k) => k !== oi) } : x)));
  const addQ = () => setQuestions((qs) => [...qs, { ...BLANK_Q }]);
  const rmQ = (i: number) => setQuestions((qs) => qs.filter((_, j) => j !== i));

  const save = async () => {
    if (!title.trim()) { setErr('Title is required'); return; }
    const clean = questions
      .map((x) => ({ ...x, q: x.q.trim(), options: x.options.map((o) => o.trim()).filter(Boolean), answer: String(x.answer).trim(), image_url: x.image_url.trim() }))
      .filter((x) => x.q);
    // validation: MCQ/image need an answer that matches an option
    for (const [i, x] of clean.entries()) {
      if (x.type !== 'practical') {
        if (x.options.length < 2) { setErr(`Q${i + 1}: add at least 2 options`); return; }
        if (!x.answer) { setErr(`Q${i + 1}: choose the correct answer`); return; }
        if (!x.options.includes(x.answer)) { setErr(`Q${i + 1}: correct answer must match an option`); return; }
      }
    }
    setSaving(true);
    setErr(null);
    const payload: any = {
      title: title.trim(), description: description.trim(), questions: clean,
      time_limit_minutes: timeLimit ? parseInt(timeLimit, 10) : 0,
      pass_score: passScore ? parseInt(passScore, 10) : 60,
      is_active: isActive ? 1 : 0,
    };
    try {
      const r = test
        ? await api('/api/tasks/knowledge-tests', { method: 'PUT', body: { id: test.id, ...payload } })
        : await api('/api/tasks/knowledge-tests', { method: 'POST', body: { action: 'create', ...payload } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j.error || `HTTP ${r.status}`); setSaving(false); return; }
      onSaved(test ? 'Test updated' : 'Test created');
    } catch (e: any) { setErr(e?.message || 'Failed to save'); setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-white w-full sm:max-w-2xl rounded-t-2xl sm:rounded-2xl p-4 sm:p-5 space-y-3 max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-[#2D1B0E] flex items-center gap-2"><BookOpen size={18} className="text-[#af4408]" /> {test ? 'Edit Test' : 'New Knowledge Test'}</h2>
          <button onClick={onClose} className="text-[#8B7355] hover:text-[#2D1B0E]"><X size={18} /></button>
        </div>
        {err && <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg px-2.5 py-1.5"><AlertCircle size={13} className="shrink-0" /> {err}</div>}

        <input type="text" placeholder="Test title *" value={title} onChange={(e) => setTitle(e.target.value)} className="w-full border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#af4408]" />
        <textarea placeholder="Description (optional, @email to notify)" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} className="w-full border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#af4408]" />
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <div>
            <label className="text-[11px] text-[#8B7355] uppercase tracking-wide">Time limit (min)</label>
            <input type="number" min="0" placeholder="0 = none" value={timeLimit} onChange={(e) => setTimeLimit(e.target.value)} className="w-full mt-0.5 border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#af4408]" />
          </div>
          <div>
            <label className="text-[11px] text-[#8B7355] uppercase tracking-wide">Pass score %</label>
            <input type="number" min="0" max="100" value={passScore} onChange={(e) => setPassScore(e.target.value)} className="w-full mt-0.5 border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#af4408]" />
          </div>
          <label className="flex items-center gap-2 text-sm text-[#2D1B0E] mt-5">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className="accent-[#af4408]" /> Active
          </label>
        </div>

        {/* Questions */}
        <div className="space-y-3">
          <div className="text-xs font-semibold text-[#2D1B0E] uppercase tracking-wide">Questions ({questions.length})</div>
          {questions.map((cq, qi) => (
            <div key={qi} className="border border-[#E8D5C4] rounded-xl p-3 space-y-2 bg-[#FFFDF9]">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-[#8B7355]">Q{qi + 1}</span>
                <div className="flex items-center gap-2">
                  <select value={cq.type} onChange={(e) => upd(qi, { type: e.target.value as QType })} className="border border-[#E8D5C4] rounded-lg px-2 py-1 text-xs bg-white focus:outline-none focus:border-[#af4408]">
                    <option value="mcq">MCQ</option>
                    <option value="image">Image</option>
                    <option value="practical">Practical</option>
                  </select>
                  {questions.length > 1 && <button onClick={() => rmQ(qi)} className="p-1 rounded-lg hover:bg-red-50 text-[#8B7355] hover:text-red-600"><Trash2 size={14} /></button>}
                </div>
              </div>
              <textarea rows={2} placeholder="Question text *" value={cq.q} onChange={(e) => upd(qi, { q: e.target.value })} className="w-full border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#af4408]" />
              {cq.type === 'image' && <input type="text" placeholder="Image URL" value={cq.image_url} onChange={(e) => upd(qi, { image_url: e.target.value })} className="w-full border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#af4408]" />}
              {cq.type === 'practical' ? (
                <div className="text-xs text-[#8B7355]">Practical answers are reviewed manually (not auto-scored).</div>
              ) : (
                <div className="space-y-1.5">
                  {cq.options.map((opt, oi) => (
                    <div key={oi} className="flex items-center gap-2">
                      <input type="radio" name={`ans${qi}`} checked={!!opt && cq.answer === opt} onChange={() => upd(qi, { answer: opt })} className="accent-[#af4408]" title="Mark correct" />
                      <input type="text" placeholder={`Option ${oi + 1}`} value={opt} onChange={(e) => updOpt(qi, oi, e.target.value)} className="flex-1 border border-[#E8D5C4] rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:border-[#af4408]" />
                      {cq.options.length > 2 && <button onClick={() => rmOpt(qi, oi)} className="p-1 rounded-lg hover:bg-red-50 text-[#8B7355] hover:text-red-600"><X size={14} /></button>}
                    </div>
                  ))}
                  <button onClick={() => addOpt(qi)} className="text-xs text-[#af4408] hover:text-[#8a3606] inline-flex items-center gap-1"><Plus size={12} /> Add option</button>
                  <div className="text-[11px] text-[#8B7355]">Select the radio next to the correct option.</div>
                </div>
              )}
            </div>
          ))}
          <button onClick={addQ} className="w-full inline-flex items-center justify-center gap-1.5 border border-dashed border-[#E8D5C4] hover:border-[#af4408] text-[#8a3606] text-sm rounded-lg px-3 py-2"><Plus size={14} /> Add Question</button>
        </div>

        <button onClick={save} disabled={saving || !title.trim()} className="w-full inline-flex items-center justify-center gap-1.5 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm font-semibold rounded-lg px-3 py-2.5 disabled:opacity-50">
          {saving ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />} {test ? 'Save Changes' : 'Create Test'}
        </button>
      </div>
    </div>
  );
}

/* ── Leaderboard ────────────────────────────────────────────────────────── */

function Leaderboard({ test, onClose }: { test: TestRow; onClose: () => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/tasks/knowledge-tests?view=leaderboard&test_id=${encodeURIComponent(test.id)}`)
      .then((r) => r.json())
      .then((j) => { if (j.error) setErr(j.error); else setRows(j.rows || []); })
      .catch((e) => setErr(e?.message || 'Failed to load'));
  }, [test.id]);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl p-4 sm:p-5 space-y-3 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-[#2D1B0E] flex items-center gap-2 min-w-0"><Trophy size={18} className="text-[#af4408] shrink-0" /> <span className="truncate">{test.title}</span></h2>
          <button onClick={onClose} className="text-[#8B7355] hover:text-[#2D1B0E]"><X size={18} /></button>
        </div>
        {err && <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg px-2.5 py-1.5"><AlertCircle size={13} className="shrink-0" /> {err}</div>}
        {!rows && !err && <div className="p-6 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…</div>}
        {rows && rows.length === 0 && <div className="p-6 text-center text-sm text-[#8B7355]">No attempts yet.</div>}
        {rows && rows.length > 0 && (
          <div className="divide-y divide-[#F0E4D6] border border-[#E8D5C4] rounded-lg overflow-hidden">
            {rows.map((r, i) => (
              <div key={r.user_email || i} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className={`w-6 text-center font-bold ${i === 0 ? 'text-[#af4408]' : 'text-[#8B7355]'}`}>{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[#2D1B0E] font-medium truncate">{r.user_name || r.user_email}</div>
                  <div className="text-[11px] text-[#8B7355]">{r.attempts} attempt{r.attempts === 1 ? '' : 's'} · {fmtWhen(r.last_taken)}</div>
                </div>
                <span className={`text-sm font-semibold ${r.ever_passed ? 'text-green-700' : 'text-[#2D1B0E]'}`}>{Math.round(r.best_score * 10) / 10}%</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
