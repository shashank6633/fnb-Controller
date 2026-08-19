'use client';

/**
 * HR — Knowledge Tests (Phase 5). Contract: docs/HRMS_DECISIONS.md.
 *
 * Three surfaces in one page, all against /api/hr/tests (mgmtOnly page; the
 * API is the boundary — GETs are canManageHr, question authoring is
 * canAdminHr BY API DESIGN, so a non-admin manager sees the editor but the
 * server 403s the mutation and the message surfaces in the modal):
 *
 *   1. Test list (server-side pagination) + create/edit modal
 *      (pass score, max attempts, time limit, shuffle Toggle, active Toggle).
 *   2. Test detail: questions editor (list, add/edit modal with mcq/true_false
 *      kind, option rows, correct picker) + attempts history table.
 *   3. "Run test" flow: pick employee → start attempt → one-question-per-screen
 *      runner (progress + optional countdown from time_limit_minutes, deadline
 *      anchored to the attempt's server started_at so a resumed attempt does
 *      NOT get a fresh clock) → submit → score + pass/fail result.
 *
 * The answer key (`correct`) is rendered ONLY from the manager detail GET —
 * the runner consumes the taker projection from action:'start', which never
 * carries it. Scoring is server-side; this page never computes a score.
 * Structure copied from the canonical HR CRUD page (src/app/hr/employees).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FileQuestion, Plus, Search, X, Loader2, Save, ChevronLeft, ChevronRight,
  ArrowLeft, Pencil, Play, Check, Clock, CheckCircle2, XCircle, Trash2,
} from 'lucide-react';
import { apiJson } from '@/lib/api';
import { fmtIST } from '@/lib/format-date';
import Combobox, { type ComboOption } from '@/components/Combobox';
import TabScroller from '@/components/TabScroller';
import Toggle from '@/components/Toggle';
import type { HrTest, HrTestAttempt, HrTestQuestion } from '@/lib/hr';

const PAGE_SIZE = 25;

/* ── Row shapes as the API ships them ───────────────────────────────────── */

interface TestRow extends HrTest {
  department_name: string | null;
  designation_name: string | null;
  question_count: number;
  attempt_count: number;
}

/** Detail question — manager surface, `correct` included + parsed options. */
interface QuestionRow extends HrTestQuestion { options: string[] }

interface AttemptRow extends HrTestAttempt {
  employee_name: string | null;
  employee_code: string | null;
}

/** Taker projection from action:'start' — NO `correct` field exists here. */
interface TakerQuestion {
  id: string;
  kind: string;
  question: string;
  options: string[];
  sort_order: number;
}

interface DeptRow { id: string; name: string; parent_id: string | null; is_active: number }
interface DesigRow { id: string; name: string; grade?: string; is_active?: number }
interface EmpRow { id: string; employee_code: string; full_name: string; status?: string }

interface Detail { test: TestRow; questions: QuestionRow[]; attempts: AttemptRow[] }

/* ── Form shapes ────────────────────────────────────────────────────────── */

interface TestForm {
  name: string;
  department_id: string;
  designation_id: string;
  pass_score: string;
  max_attempts: string;
  time_limit_minutes: string;
  shuffle: boolean;
  is_active: boolean;
}

const emptyTestForm = (): TestForm => ({
  name: '', department_id: '', designation_id: '',
  pass_score: '60', max_attempts: '3', time_limit_minutes: '0',
  shuffle: true, is_active: true,
});

interface QuestionForm {
  kind: 'mcq' | 'true_false';
  question: string;
  options: string[];
  correctIdx: number;
  sort_order: string;
}

const emptyQuestionForm = (): QuestionForm => ({
  kind: 'mcq', question: '', options: ['', ''], correctIdx: -1, sort_order: '',
});

/* ── Small helpers ──────────────────────────────────────────────────────── */

/** DB timestamps are UTC 'YYYY-MM-DD HH:MM:SS' (no Z) — parse as UTC ms. */
function parseUtcMs(ts: string): number {
  const ms = Date.parse(ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? ms : Date.now();
}

function fmtSecs(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const MGMT_MSG = 'You need management access to view knowledge tests.';

function kindBadge(kind: string) {
  return kind === 'true_false'
    ? { label: 'True / False', cls: 'bg-purple-50 text-purple-700 border-purple-200' }
    : { label: 'MCQ', cls: 'bg-blue-50 text-blue-700 border-blue-200' };
}

const pill = (on: boolean) =>
  `px-3 py-1.5 rounded-full text-xs font-medium border ${
    on ? 'bg-[#af4408] text-white border-[#af4408]'
       : 'bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]'
  }`;

export default function HrTestsPage() {
  /* ── List state ───────────────────────────────────────────────────────── */
  const [rows, setRows] = useState<TestRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);   // first paint only
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');
  const [deptId, setDeptId] = useState('');
  const [activeFilter, setActiveFilter] = useState(''); // '' | '1' | '0'

  /* ── Picker data ──────────────────────────────────────────────────────── */
  const [departments, setDepartments] = useState<DeptRow[]>([]);
  const [designations, setDesignations] = useState<DesigRow[]>([]);
  const [employees, setEmployees] = useState<EmpRow[]>([]);

  /* ── Detail state ─────────────────────────────────────────────────────── */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  /* ── Test create/edit modal ───────────────────────────────────────────── */
  const [showTestModal, setShowTestModal] = useState(false);
  const [editingTest, setEditingTest] = useState<TestRow | null>(null);
  const [tForm, setTForm] = useState<TestForm>(emptyTestForm());
  const [tSaving, setTSaving] = useState(false);
  const [tError, setTError] = useState<string | null>(null);

  /* ── Question add/edit modal ──────────────────────────────────────────── */
  const [showQModal, setShowQModal] = useState(false);
  const [editingQ, setEditingQ] = useState<QuestionRow | null>(null);
  const [qForm, setQForm] = useState<QuestionForm>(emptyQuestionForm());
  const [qSaving, setQSaving] = useState(false);
  const [qError, setQError] = useState<string | null>(null);

  /* ── Run-test flow ────────────────────────────────────────────────────── */
  const [runOpen, setRunOpen] = useState(false);
  const [runStage, setRunStage] = useState<'pick' | 'run' | 'result'>('pick');
  const [runEmpId, setRunEmpId] = useState('');
  const [runError, setRunError] = useState<string | null>(null);
  const [runBusy, setRunBusy] = useState(false);
  const [attempt, setAttempt] = useState<AttemptRow | null>(null);
  const [takerQs, setTakerQs] = useState<TakerQuestion[]>([]);
  const [timeLimit, setTimeLimit] = useState(0); // minutes; 0 = untimed
  const [qIdx, setQIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [remaining, setRemaining] = useState<number | null>(null); // seconds
  const [result, setResult] = useState<{ total: number; correct: number } | null>(null);

  // Latest answers + a one-shot guard, readable from the timer's closure.
  const answersRef = useRef<Record<string, string>>({});
  useEffect(() => { answersRef.current = answers; }, [answers]);
  const submittedRef = useRef(false);

  // Race guards (pattern from src/app/crm-calls/log/page.tsx)
  const fetchSeq = useRef(0);
  const detailSeq = useRef(0);

  /* ── List fetch ───────────────────────────────────────────────────────── */
  useEffect(() => {
    const t = setTimeout(() => setQ(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => { setPage(1); }, [q, deptId, activeFilter]);

  const fetchTests = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setFetching(true);
    setError(null);
    try {
      const sp = new URLSearchParams();
      if (q) sp.set('q', q);
      if (deptId) sp.set('department_id', deptId);
      if (activeFilter) sp.set('is_active', activeFilter);
      sp.set('page', String(page));
      sp.set('pageSize', String(PAGE_SIZE));
      const res = await fetch(`/api/hr/tests?${sp.toString()}`);
      if (seq !== fetchSeq.current) return;
      if (!res.ok) {
        setError(res.status === 401 || res.status === 403 ? MGMT_MSG : "Couldn't load tests");
        return;
      }
      const json = await res.json();
      if (seq !== fetchSeq.current) return;
      setRows(Array.isArray(json?.rows) ? json.rows : []);
      setTotal(Number(json?.total) || 0);
    } catch {
      if (seq === fetchSeq.current) setError("Couldn't load tests");
    } finally {
      if (seq === fetchSeq.current) { setFetching(false); setLoading(false); }
    }
  }, [q, deptId, activeFilter, page]);

  useEffect(() => { fetchTests(); }, [fetchTests]);

  // Picker data — one fetch each on mount (bare fetch is fine for GETs).
  useEffect(() => {
    fetch('/api/departments')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(j => setDepartments(Array.isArray(j?.departments) ? j.departments : []))
      .catch(() => {});
    fetch('/api/hr/designations')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(j => setDesignations(Array.isArray(j?.designations) ? j.designations : []))
      .catch(() => {});
    // Employee picker source (rows carry employee_code + full_name; no photos).
    fetch('/api/hr/employees?pageSize=100')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(j => setEmployees(Array.isArray(j?.rows) ? j.rows : []))
      .catch(() => {});
  }, []);

  /* ── Detail load ──────────────────────────────────────────────────────── */
  const loadDetail = useCallback(async (id: string) => {
    const seq = ++detailSeq.current;
    setDetailError(null);
    try {
      const res = await fetch(`/api/hr/tests?test_id=${encodeURIComponent(id)}`);
      if (seq !== detailSeq.current) return;
      if (!res.ok) {
        setDetailError(res.status === 401 || res.status === 403 ? MGMT_MSG : "Couldn't load this test");
        return;
      }
      const j = await res.json();
      if (seq !== detailSeq.current) return;
      if (!j?.test) { setDetailError("Couldn't load this test"); return; }
      setDetail({
        test: j.test,
        questions: Array.isArray(j.questions) ? j.questions : [],
        attempts: Array.isArray(j.attempts) ? j.attempts : [],
      });
    } catch {
      if (seq === detailSeq.current) setDetailError("Couldn't load this test");
    }
  }, []);

  useEffect(() => {
    if (!selectedId) { setDetail(null); setDetailError(null); return; }
    setDetail(null);
    loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  /* ── Dept/designation options ─────────────────────────────────────────── */
  const mains = useMemo(
    () => departments.filter(d => !d.parent_id && d.is_active).sort((a, b) => a.name.localeCompare(b.name)),
    [departments],
  );
  const subsOf = useCallback(
    (parentId: string) =>
      departments.filter(d => d.parent_id === parentId && d.is_active).sort((a, b) => a.name.localeCompare(b.name)),
    [departments],
  );
  const deptById = useMemo(() => new Map(departments.map(d => [d.id, d])), [departments]);

  const deptFilterOptions = useMemo<ComboOption[]>(() => {
    const opts: ComboOption[] = [{ value: '', label: 'All departments' }];
    for (const m of mains) {
      opts.push({ value: m.id, label: m.name });
      for (const s of subsOf(m.id)) opts.push({ value: s.id, label: s.name, hint: m.name });
    }
    return opts;
  }, [mains, subsOf]);

  const deptModalOptions = useMemo<ComboOption[]>(() => {
    const opts: ComboOption[] = [{ value: '', label: '(none)' }];
    for (const m of mains) {
      opts.push({ value: m.id, label: m.name });
      for (const s of subsOf(m.id)) opts.push({ value: s.id, label: s.name, hint: m.name });
    }
    return opts;
  }, [mains, subsOf]);

  const desigOptions = useMemo<ComboOption[]>(
    () => [
      { value: '', label: '(none)' },
      ...designations
        .filter(d => d.is_active !== 0)
        .map(d => ({ value: d.id, label: d.name, hint: d.grade || undefined })),
    ],
    [designations],
  );

  const employeeOptions = useMemo<ComboOption[]>(
    () => employees.map(e => ({ value: e.id, label: e.full_name, hint: e.employee_code || undefined })),
    [employees],
  );
  const empById = useMemo(() => new Map(employees.map(e => [e.id, e])), [employees]);

  /* ── Test CRUD ────────────────────────────────────────────────────────── */
  const openCreateTest = () => {
    setEditingTest(null);
    setTForm(emptyTestForm());
    setTError(null);
    setShowTestModal(true);
  };

  const openEditTest = (t: TestRow) => {
    setEditingTest(t);
    setTForm({
      name: t.name,
      department_id: t.department_id || '',
      designation_id: t.designation_id || '',
      pass_score: String(t.pass_score),
      max_attempts: String(t.max_attempts),
      time_limit_minutes: String(t.time_limit_minutes),
      shuffle: !!t.shuffle,
      is_active: !!t.is_active,
    });
    setTError(null);
    setShowTestModal(true);
  };

  const saveTest = async () => {
    const name = tForm.name.trim();
    if (!name) { setTError('Test name is required.'); return; }
    const pass = Number(tForm.pass_score);
    if (!Number.isFinite(pass) || pass < 0 || pass > 100) {
      setTError('Pass score must be a number between 0 and 100.'); return;
    }
    const maxA = parseInt(tForm.max_attempts, 10);
    if (!Number.isFinite(maxA) || maxA < 1 || maxA > 100) {
      setTError('Max attempts must be between 1 and 100.'); return;
    }
    const limit = parseInt(tForm.time_limit_minutes || '0', 10);
    if (!Number.isFinite(limit) || limit < 0) {
      setTError('Time limit must be 0 (untimed) or a positive number of minutes.'); return;
    }

    setTSaving(true);
    setTError(null);
    try {
      const body: Record<string, unknown> = {
        name,
        department_id: tForm.department_id,
        designation_id: tForm.designation_id,
        pass_score: pass,
        max_attempts: maxA,
        time_limit_minutes: limit,
        shuffle: tForm.shuffle,
      };
      if (editingTest) {
        body.id = editingTest.id;
        body.is_active = tForm.is_active;
        await apiJson('/api/hr/tests', { method: 'PUT', body });
        if (selectedId) loadDetail(selectedId);
      } else {
        const res = await apiJson<{ test: TestRow }>('/api/hr/tests', { method: 'POST', body });
        // Jump straight into the new test so questions can be added.
        if (res?.test?.id) setSelectedId(res.test.id);
      }
      setShowTestModal(false);
      fetchTests();
    } catch (e) {
      setTError(e instanceof Error ? e.message : 'Could not save the test');
    } finally {
      setTSaving(false);
    }
  };

  const toggleTestActive = async (t: TestRow) => {
    if (t.is_active) {
      const ok = window.confirm(
        `Deactivate "${t.name}"? It disappears from pickers and cannot be run; attempt history is kept.`,
      );
      if (!ok) return;
    }
    try {
      if (t.is_active) {
        await apiJson(`/api/hr/tests?id=${encodeURIComponent(t.id)}`, { method: 'DELETE' });
      } else {
        await apiJson('/api/hr/tests', { method: 'PUT', body: { id: t.id, is_active: true } });
      }
      fetchTests();
      if (selectedId) loadDetail(selectedId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not update the test';
      if (selectedId) setDetailError(msg); else setError(msg);
    }
  };

  /* ── Question CRUD ────────────────────────────────────────────────────── */
  const openCreateQuestion = () => {
    setEditingQ(null);
    setQForm(emptyQuestionForm());
    setQError(null);
    setShowQModal(true);
  };

  const openEditQuestion = (qr: QuestionRow) => {
    setEditingQ(qr);
    const kind: QuestionForm['kind'] = qr.kind === 'true_false' ? 'true_false' : 'mcq';
    const options = qr.options.length >= 2 ? [...qr.options] : ['', ''];
    setQForm({
      kind,
      question: qr.question,
      options,
      correctIdx: options.indexOf(qr.correct),
      sort_order: String(qr.sort_order ?? ''),
    });
    setQError(null);
    setShowQModal(true);
  };

  const setQuestionKind = (kind: QuestionForm['kind']) => {
    setQForm(f => {
      if (kind === f.kind) return f;
      if (kind === 'true_false') {
        // Canonical fixed pair; correct must be re-picked deliberately.
        return { ...f, kind, options: ['True', 'False'], correctIdx: -1 };
      }
      return { ...f, kind, correctIdx: -1 };
    });
  };

  const saveQuestion = async () => {
    if (!detail) return;
    const text = qForm.question.trim();
    if (!text) { setQError('Question text is required.'); return; }

    // Clean exactly like the server: trim, drop blanks, de-duplicate.
    const cleaned: string[] = [];
    const seen = new Set<string>();
    for (const raw of qForm.options) {
      const o = raw.trim();
      if (!o || seen.has(o)) continue;
      seen.add(o);
      cleaned.push(o);
    }
    if (cleaned.length < 2 || cleaned.length > 12) {
      setQError('Options must be 2 to 12 distinct, non-empty choices.'); return;
    }
    const correct = qForm.correctIdx >= 0 ? (qForm.options[qForm.correctIdx] || '').trim() : '';
    if (!correct || !cleaned.includes(correct)) {
      setQError('Mark one of the options as the correct answer.'); return;
    }

    setQSaving(true);
    setQError(null);
    try {
      if (editingQ) {
        await apiJson('/api/hr/tests', {
          method: 'PUT',
          body: {
            question_id: editingQ.id,
            kind: qForm.kind,
            question: text,
            options: cleaned,
            correct,
            ...(qForm.sort_order.trim() !== ''
              ? { sort_order: Math.max(0, parseInt(qForm.sort_order, 10) || 0) }
              : {}),
          },
        });
      } else {
        await apiJson('/api/hr/tests', {
          method: 'POST',
          body: {
            action: 'question',
            test_id: detail.test.id,
            kind: qForm.kind,
            question: text,
            options: cleaned,
            correct,
            ...(qForm.sort_order.trim() !== ''
              ? { sort_order: Math.max(0, parseInt(qForm.sort_order, 10) || 0) }
              : {}),
          },
        });
      }
      setShowQModal(false);
      if (selectedId) loadDetail(selectedId);
      fetchTests(); // question_count changed
    } catch (e) {
      setQError(e instanceof Error ? e.message : 'Could not save the question');
    } finally {
      setQSaving(false);
    }
  };

  const deactivateQuestion = async (qr: QuestionRow) => {
    const ok = window.confirm(
      'Deactivate this question? It leaves the paper for future attempts; past attempts keep their scores.',
    );
    if (!ok) return;
    try {
      await apiJson(`/api/hr/tests?question_id=${encodeURIComponent(qr.id)}`, { method: 'DELETE' });
      if (selectedId) loadDetail(selectedId);
      fetchTests();
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : 'Could not deactivate the question');
    }
  };

  /* ── Run-test flow ────────────────────────────────────────────────────── */
  const openRun = () => {
    setRunStage('pick');
    setRunEmpId('');
    setRunError(null);
    setAttempt(null);
    setTakerQs([]);
    setAnswers({});
    setQIdx(0);
    setResult(null);
    setRemaining(null);
    submittedRef.current = false;
    setRunOpen(true);
  };

  const closeRun = () => {
    if (runStage === 'run' && !submittedRef.current) {
      const ok = window.confirm(
        'Close the test runner? The attempt stays open and will RESUME (same attempt number) the next time this employee is run.',
      );
      if (!ok) return;
    }
    setRunOpen(false);
    setRunStage('pick');
    setAttempt(null);
    setTakerQs([]);
    setRemaining(null);
  };

  const startRun = async () => {
    if (!detail) return;
    if (!runEmpId) { setRunError('Pick an employee first.'); return; }
    setRunBusy(true);
    setRunError(null);
    try {
      const res = await apiJson<{
        attempt: AttemptRow;
        questions: TakerQuestion[];
        time_limit_minutes: number;
      }>('/api/hr/tests', {
        method: 'POST',
        body: { action: 'start', test_id: detail.test.id, employee_id: runEmpId },
      });
      setAttempt(res.attempt);
      setTakerQs(Array.isArray(res.questions) ? res.questions : []);
      setTimeLimit(Number(res.time_limit_minutes) || 0);
      setAnswers({});
      setQIdx(0);
      setResult(null);
      submittedRef.current = false;
      setRunStage('run');
      loadDetail(detail.test.id); // a fresh attempt row may now exist
    } catch (e) {
      setRunError(e instanceof Error ? e.message : 'Could not start the attempt');
    } finally {
      setRunBusy(false);
    }
  };

  const submitAttempt = useCallback(async () => {
    if (!attempt || submittedRef.current) return;
    submittedRef.current = true;
    setRunBusy(true);
    setRunError(null);
    try {
      const res = await apiJson<{ attempt: AttemptRow; result: { total: number; correct: number } }>(
        '/api/hr/tests',
        {
          method: 'POST',
          body: { action: 'submit', attempt_id: attempt.id, answers_json: answersRef.current },
        },
      );
      setAttempt(res.attempt);
      setResult(res.result);
      setRunStage('result');
      if (selectedId) loadDetail(selectedId);
      fetchTests(); // attempt_count changed
    } catch (e) {
      submittedRef.current = false; // allow retry — e.g. transient network error
      setRunError(e instanceof Error ? e.message : 'Could not submit the attempt');
    } finally {
      setRunBusy(false);
    }
  }, [attempt, selectedId, loadDetail, fetchTests]);

  const submitRef = useRef(submitAttempt);
  useEffect(() => { submitRef.current = submitAttempt; }, [submitAttempt]);

  // Countdown — anchored to the attempt's server started_at (UTC), so a
  // resumed attempt continues its original clock. 0 remaining → auto-submit.
  useEffect(() => {
    if (!runOpen || runStage !== 'run' || !attempt || timeLimit <= 0) {
      setRemaining(null);
      return;
    }
    const deadline = parseUtcMs(attempt.started_at) + timeLimit * 60_000;
    let fired = false;
    const tick = () => {
      const secs = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRemaining(secs);
      if (secs <= 0 && !fired) {
        fired = true;
        submitRef.current(); // time is up — submit whatever is answered
      }
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [runOpen, runStage, attempt, timeLimit]);

  /* ── Derived ──────────────────────────────────────────────────────────── */
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const fromN = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const toN = Math.min(page * PAGE_SIZE, total);

  const answeredCount = useMemo(
    () => takerQs.filter(tq => (answers[tq.id] || '') !== '').length,
    [takerQs, answers],
  );

  // Attempt usage for the picked employee (list caps at 200 — the server is
  // the authority; this is a courtesy preview).
  const pickedUsage = useMemo(() => {
    if (!detail || !runEmpId) return null;
    const mine = detail.attempts.filter(a => a.employee_id === runEmpId);
    return {
      finished: mine.filter(a => a.finished_at !== '').length,
      hasOpen: mine.some(a => a.finished_at === ''),
    };
  }, [detail, runEmpId]);

  const maxReached =
    !!detail && !!pickedUsage && !pickedUsage.hasOpen &&
    pickedUsage.finished >= Math.max(1, Number(detail.test.max_attempts) || 1);

  const inputCls = 'w-full px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm';
  const currentQ = takerQs[qIdx] || null;

  /* ═══════════════════════════════════════════════════════════════════════ */

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">

        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-2">
              <FileQuestion className="w-6 h-6" /> Knowledge Tests
            </h1>
            <p className="text-[#8B7355] text-sm mt-1">
              {selectedId
                ? 'Question paper, attempts and the test runner.'
                : `Build question papers and run staff knowledge checks${loading ? '' : ` — ${total} test${total === 1 ? '' : 's'}`}.`}
            </p>
          </div>
          {!selectedId && (
            <button onClick={openCreateTest}
                    className="inline-flex items-center gap-2 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium">
              <Plus className="w-4 h-4" /> Add Test
            </button>
          )}
        </div>

        {/* ══ LIST VIEW ══ */}
        {!selectedId && (
          <>
            {/* Filters */}
            <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-3 space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2 flex-1 min-w-[200px]">
                  <Search className="w-4 h-4 text-[#8B7355]" />
                  <input value={searchInput} onChange={e => setSearchInput(e.target.value)}
                         placeholder="Test name…"
                         className="flex-1 px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
                </div>
                <div className="w-full sm:w-64">
                  <Combobox
                    options={deptFilterOptions}
                    value={deptId ? (deptById.get(deptId)?.name || '') : ''}
                    onChange={(v) => setDeptId(v)}
                    placeholder="All departments"
                  />
                </div>
              </div>
              <TabScroller className="gap-2">
                <button onClick={() => setActiveFilter('')} className={pill(activeFilter === '')}>All</button>
                <button onClick={() => setActiveFilter('1')} className={pill(activeFilter === '1')}>Active</button>
                <button onClick={() => setActiveFilter('0')} className={pill(activeFilter === '0')}>Inactive</button>
              </TabScroller>
            </div>

            {/* Error banner */}
            {error && (
              <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm flex items-center justify-between gap-3">
                <span>{error}</span>
                <button onClick={() => fetchTests()}
                        className="shrink-0 px-3 py-1.5 border border-red-200 rounded-lg text-xs font-medium hover:bg-red-100">
                  Retry
                </button>
              </div>
            )}

            {/* Table */}
            <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
              {loading ? (
                <div className="p-6 flex items-center justify-center gap-2 text-[#8B7355] text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading...
                </div>
              ) : rows.length === 0 ? (
                <div className="p-6 text-center text-[#8B7355] text-sm">
                  {q || deptId || activeFilter ? 'No tests match these filters.' : 'No tests yet — add the first one.'}
                </div>
              ) : (
                <>
                  <div className={`overflow-x-auto ${fetching ? 'opacity-60' : ''}`}>
                    <table className="w-full text-sm">
                      <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                        <tr>
                          <th className="text-left py-2 px-3 font-medium">Test</th>
                          <th className="text-right py-2 px-3 font-medium">Pass %</th>
                          <th className="text-right py-2 px-3 font-medium">Max attempts</th>
                          <th className="text-left py-2 px-3 font-medium">Time limit</th>
                          <th className="text-right py-2 px-3 font-medium">Questions</th>
                          <th className="text-right py-2 px-3 font-medium">Attempts</th>
                          <th className="text-left py-2 px-3 font-medium">Status</th>
                          <th className="text-right py-2 px-3 font-medium">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map(r => (
                          <tr key={r.id} className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]">
                            <td className="py-2 px-3">
                              <button onClick={() => setSelectedId(r.id)}
                                      className="font-bold text-left text-[#2D1B0E] hover:text-[#af4408] hover:underline">
                                {r.name}
                              </button>
                              {(r.department_name || r.designation_name) && (
                                <div className="text-[10px] text-[#8B7355]">
                                  {[r.department_name, r.designation_name].filter(Boolean).join(' · ')}
                                </div>
                              )}
                            </td>
                            <td className="py-2 px-3 text-right text-xs whitespace-nowrap">{r.pass_score}%</td>
                            <td className="py-2 px-3 text-right text-xs">{r.max_attempts}</td>
                            <td className="py-2 px-3 text-xs whitespace-nowrap">
                              {r.time_limit_minutes > 0
                                ? `${r.time_limit_minutes} min`
                                : <span className="text-[#8B7355]">Untimed</span>}
                            </td>
                            <td className="py-2 px-3 text-right text-xs">{r.question_count}</td>
                            <td className="py-2 px-3 text-right text-xs">{r.attempt_count}</td>
                            <td className="py-2 px-3">
                              <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border ${
                                r.is_active
                                  ? 'bg-green-50 text-green-700 border-green-200'
                                  : 'bg-gray-100 text-gray-600 border-gray-200'
                              }`}>
                                {r.is_active ? 'Active' : 'Inactive'}
                              </span>
                            </td>
                            <td className="py-2 px-3">
                              <div className="flex items-center justify-end gap-1">
                                <button onClick={() => openEditTest(r)} title="Edit test"
                                        className="p-1.5 rounded-lg border border-[#E8D5C4] text-[#6B5744] hover:bg-[#FFF1E3]">
                                  <Pencil className="w-3.5 h-3.5" />
                                </button>
                                <button onClick={() => setSelectedId(r.id)}
                                        className="px-2.5 py-1.5 rounded-lg border border-[#E8D5C4] text-xs font-medium text-[#6B5744] hover:bg-[#FFF1E3]">
                                  Open
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="px-3 py-2 border-t border-[#E8D5C4] flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs text-[#8B7355]">Showing {fromN}–{toN} of {total}</span>
                    <div className="flex items-center gap-2">
                      <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1 || fetching}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-[#E8D5C4] bg-white hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-xs font-medium disabled:opacity-40">
                        <ChevronLeft className="w-3.5 h-3.5" /> Prev
                      </button>
                      <span className="text-xs text-[#6B5744]">Page {page} of {pageCount}</span>
                      <button onClick={() => setPage(p => Math.min(pageCount, p + 1))} disabled={page >= pageCount || fetching}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-[#E8D5C4] bg-white hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-xs font-medium disabled:opacity-40">
                        Next <ChevronRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </>
        )}

        {/* ══ DETAIL VIEW ══ */}
        {selectedId && (
          <>
            <button onClick={() => { setSelectedId(null); fetchTests(); }}
                    className="inline-flex items-center gap-1.5 text-sm text-[#6B5744] hover:text-[#af4408] font-medium">
              <ArrowLeft className="w-4 h-4" /> All tests
            </button>

            {detailError && (
              <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm flex items-center justify-between gap-3">
                <span>{detailError}</span>
                <button onClick={() => loadDetail(selectedId)}
                        className="shrink-0 px-3 py-1.5 border border-red-200 rounded-lg text-xs font-medium hover:bg-red-100">
                  Retry
                </button>
              </div>
            )}

            {!detail && !detailError ? (
              <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-6 flex items-center justify-center gap-2 text-[#8B7355] text-sm">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading...
              </div>
            ) : detail && (
              <>
                {/* Summary card */}
                <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-4 space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-lg font-bold text-[#2D1B0E]">{detail.test.name}</h2>
                        <span className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border bg-[#FFF1E3] text-[#6B5744] border-[#E8D5C4]">
                          v{detail.test.version}
                        </span>
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border ${
                          detail.test.is_active
                            ? 'bg-green-50 text-green-700 border-green-200'
                            : 'bg-gray-100 text-gray-600 border-gray-200'
                        }`}>
                          {detail.test.is_active ? 'Active' : 'Inactive'}
                        </span>
                      </div>
                      {(detail.test.department_name || detail.test.designation_name) && (
                        <div className="text-xs text-[#8B7355] mt-0.5">
                          {[detail.test.department_name, detail.test.designation_name].filter(Boolean).join(' · ')}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        onClick={openRun}
                        disabled={!detail.test.is_active || detail.questions.length === 0}
                        title={!detail.test.is_active
                          ? 'Inactive tests cannot be run'
                          : detail.questions.length === 0 ? 'Add at least one question first' : undefined}
                        className="inline-flex items-center gap-2 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium disabled:opacity-50">
                        <Play className="w-4 h-4" /> Run Test
                      </button>
                      <button onClick={() => openEditTest(detail.test)}
                              className="inline-flex items-center gap-2 px-3 py-2 border border-[#E8D5C4] bg-white hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm font-medium">
                        <Pencil className="w-4 h-4" /> Edit
                      </button>
                      <button onClick={() => toggleTestActive(detail.test)}
                              className="inline-flex items-center gap-2 px-3 py-2 border border-[#E8D5C4] bg-white hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm font-medium">
                        {detail.test.is_active
                          ? <><Trash2 className="w-4 h-4" /> Deactivate</>
                          : <><Check className="w-4 h-4" /> Reactivate</>}
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                    {[
                      { label: 'Pass score', value: `${detail.test.pass_score}%` },
                      { label: 'Max attempts', value: String(detail.test.max_attempts) },
                      {
                        label: 'Time limit',
                        value: detail.test.time_limit_minutes > 0
                          ? `${detail.test.time_limit_minutes} min` : 'Untimed',
                      },
                      { label: 'Shuffle', value: detail.test.shuffle ? 'On' : 'Off' },
                      { label: 'Questions', value: String(detail.questions.length) },
                      { label: 'Attempts', value: String(detail.test.attempt_count) },
                    ].map(s => (
                      <div key={s.label} className="rounded-lg bg-[#FFF8F0] border border-[#E8D5C4] px-3 py-2">
                        <div className="text-[10px] text-[#8B7355] uppercase tracking-wide">{s.label}</div>
                        <div className="text-sm font-bold text-[#2D1B0E]">{s.value}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Questions editor */}
                <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
                  <div className="px-4 py-3 border-b border-[#E8D5C4] flex items-center justify-between gap-3">
                    <div>
                      <h3 className="font-bold text-[#2D1B0E]">Questions</h3>
                      <p className="text-[11px] text-[#8B7355]">
                        The correct answer is visible only on this manager surface — takers never receive it.
                        Question changes are admin actions and bump the paper version.
                      </p>
                    </div>
                    <button onClick={openCreateQuestion}
                            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-xs font-medium">
                      <Plus className="w-3.5 h-3.5" /> Add Question
                    </button>
                  </div>
                  {detail.questions.length === 0 ? (
                    <div className="p-6 text-center text-[#8B7355] text-sm">No questions yet — add the first one.</div>
                  ) : (
                    <ul className="divide-y divide-[#E8D5C4]/60">
                      {detail.questions.map((qr, i) => {
                        const kb = kindBadge(qr.kind);
                        return (
                          <li key={qr.id} className="px-4 py-3 flex flex-wrap items-start gap-3">
                            <div className="w-7 h-7 shrink-0 rounded-full bg-[#FFF1E3] border border-[#E8D5C4] text-[#af4408] text-xs font-bold flex items-center justify-center">
                              {i + 1}
                            </div>
                            <div className="flex-1 min-w-[220px]">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-medium text-[#2D1B0E]">{qr.question}</span>
                                <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium border ${kb.cls}`}>
                                  {kb.label}
                                </span>
                              </div>
                              <div className="mt-1.5 flex flex-wrap gap-1.5">
                                {qr.options.map(opt => (
                                  <span key={opt}
                                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] border ${
                                          opt === qr.correct
                                            ? 'bg-green-50 text-green-800 border-green-300 font-medium'
                                            : 'bg-[#FFF8F0] text-[#6B5744] border-[#E8D5C4]'
                                        }`}>
                                    {opt === qr.correct && <Check className="w-3 h-3" />}
                                    {opt}
                                  </span>
                                ))}
                              </div>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <button onClick={() => openEditQuestion(qr)} title="Edit question"
                                      className="p-1.5 rounded-lg border border-[#E8D5C4] text-[#6B5744] hover:bg-[#FFF1E3]">
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              <button onClick={() => deactivateQuestion(qr)} title="Deactivate question"
                                      className="p-1.5 rounded-lg border border-[#E8D5C4] text-[#6B5744] hover:bg-red-50 hover:text-red-700 hover:border-red-200">
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>

                {/* Attempts history */}
                <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
                  <div className="px-4 py-3 border-b border-[#E8D5C4]">
                    <h3 className="font-bold text-[#2D1B0E]">Attempts</h3>
                    <p className="text-[11px] text-[#8B7355]">
                      Latest 200, newest first. Each attempt freezes the paper version it ran against.
                    </p>
                  </div>
                  {detail.attempts.length === 0 ? (
                    <div className="p-6 text-center text-[#8B7355] text-sm">No attempts yet.</div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                          <tr>
                            <th className="text-left py-2 px-3 font-medium">Employee</th>
                            <th className="text-right py-2 px-3 font-medium">Attempt #</th>
                            <th className="text-right py-2 px-3 font-medium">Score</th>
                            <th className="text-left py-2 px-3 font-medium">Result</th>
                            <th className="text-right py-2 px-3 font-medium">Ver</th>
                            <th className="text-left py-2 px-3 font-medium">Date</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.attempts.map(a => {
                            const inProgress = a.finished_at === '';
                            return (
                              <tr key={a.id} className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]">
                                <td className="py-2 px-3">
                                  <span className="font-medium">
                                    {a.employee_name || <span className="text-[#8B7355]">—</span>}
                                  </span>
                                  {a.employee_code && (
                                    <span className="ml-1.5 text-[10px] font-mono text-[#8B7355]">{a.employee_code}</span>
                                  )}
                                </td>
                                <td className="py-2 px-3 text-right text-xs">{a.attempt_no}</td>
                                <td className="py-2 px-3 text-right text-xs font-medium whitespace-nowrap">
                                  {inProgress ? <span className="text-[#8B7355]">—</span> : `${a.score}%`}
                                </td>
                                <td className="py-2 px-3">
                                  <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border ${
                                    inProgress
                                      ? 'bg-amber-50 text-amber-700 border-amber-200'
                                      : a.passed
                                        ? 'bg-green-50 text-green-700 border-green-200'
                                        : 'bg-red-50 text-red-700 border-red-200'
                                  }`}>
                                    {inProgress ? 'In progress' : a.passed ? 'Passed' : 'Failed'}
                                  </span>
                                </td>
                                <td className="py-2 px-3 text-right text-xs">v{a.test_version}</td>
                                <td className="py-2 px-3 text-xs whitespace-nowrap">
                                  {fmtIST(inProgress ? a.started_at : a.finished_at)}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </>
            )}
          </>
        )}

        {/* ══ Test create/edit modal ══ */}
        {showTestModal && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
            <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
                 className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-lg shadow-xl flex flex-col overflow-hidden">
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E]">{editingTest ? 'Edit Test' : 'Add Test'}</h2>
                <button onClick={() => { if (!tSaving) setShowTestModal(false); }} className="text-[#8B7355]">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
                {tError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
                    {tError}
                  </div>
                )}

                <div>
                  <label className="text-xs text-[#6B5744]">Test name *</label>
                  <input value={tForm.name} onChange={e => setTForm({ ...tForm, name: e.target.value })}
                         placeholder="e.g. Food Safety Basics" className={inputCls} autoFocus />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-[#6B5744]">Department</label>
                    <Combobox
                      options={deptModalOptions}
                      value={tForm.department_id ? (deptById.get(tForm.department_id)?.name || '') : ''}
                      onChange={(v) => setTForm({ ...tForm, department_id: v })}
                      placeholder="Pick department"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-[#6B5744]">Designation</label>
                    <Combobox
                      options={desigOptions}
                      value={tForm.designation_id
                        ? (designations.find(d => d.id === tForm.designation_id)?.name || '') : ''}
                      onChange={(v) => setTForm({ ...tForm, designation_id: v })}
                      placeholder="Pick designation"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="text-xs text-[#6B5744]">Pass score (%) *</label>
                    <input type="number" min={0} max={100} value={tForm.pass_score}
                           onChange={e => setTForm({ ...tForm, pass_score: e.target.value })}
                           className={inputCls} />
                  </div>
                  <div>
                    <label className="text-xs text-[#6B5744]">Max attempts *</label>
                    <input type="number" min={1} max={100} value={tForm.max_attempts}
                           onChange={e => setTForm({ ...tForm, max_attempts: e.target.value })}
                           className={inputCls} />
                  </div>
                  <div>
                    <label className="text-xs text-[#6B5744]">Time limit (min)</label>
                    <input type="number" min={0} value={tForm.time_limit_minutes}
                           onChange={e => setTForm({ ...tForm, time_limit_minutes: e.target.value })}
                           className={inputCls} />
                    <p className="text-[10px] text-[#8B7355] mt-0.5">0 = untimed</p>
                  </div>
                </div>

                <div className="flex items-center justify-between rounded-lg bg-[#FFF8F0] border border-[#E8D5C4] px-3 py-2.5">
                  <div>
                    <div className="text-sm font-medium text-[#2D1B0E]">Shuffle questions</div>
                    <div className="text-[11px] text-[#8B7355]">
                      Each run shows questions and options in a random order.
                    </div>
                  </div>
                  <Toggle checked={tForm.shuffle} onChange={v => setTForm({ ...tForm, shuffle: v })}
                          label="Shuffle questions" />
                </div>

                {editingTest && (
                  <div className="flex items-center justify-between rounded-lg bg-[#FFF8F0] border border-[#E8D5C4] px-3 py-2.5">
                    <div>
                      <div className="text-sm font-medium text-[#2D1B0E]">Active</div>
                      <div className="text-[11px] text-[#8B7355]">
                        Inactive tests keep their history but cannot be run.
                      </div>
                    </div>
                    <Toggle checked={tForm.is_active} onChange={v => setTForm({ ...tForm, is_active: v })}
                            label="Test active" />
                  </div>
                )}
              </div>

              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
                <button onClick={() => setShowTestModal(false)} disabled={tSaving}
                        className="px-3 py-2 text-sm text-[#6B5744] disabled:opacity-50">
                  Cancel
                </button>
                <button onClick={saveTest} disabled={tSaving}
                        className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
                  {tSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ══ Question add/edit modal ══ */}
        {showQModal && detail && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
            <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
                 className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-lg shadow-xl flex flex-col overflow-hidden">
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E]">{editingQ ? 'Edit Question' : 'Add Question'}</h2>
                <button onClick={() => { if (!qSaving) setShowQModal(false); }} className="text-[#8B7355]">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
                {qError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
                    {qError}
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-[#6B5744]">Kind</label>
                    <select value={qForm.kind}
                            onChange={e => setQuestionKind(e.target.value === 'true_false' ? 'true_false' : 'mcq')}
                            className={inputCls}>
                      <option value="mcq">Multiple choice</option>
                      <option value="true_false">True / False</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-[#6B5744]">Sort order</label>
                    <input type="number" min={0} value={qForm.sort_order}
                           onChange={e => setQForm({ ...qForm, sort_order: e.target.value })}
                           placeholder="Auto" className={inputCls} />
                  </div>
                </div>

                <div>
                  <label className="text-xs text-[#6B5744]">Question *</label>
                  <textarea value={qForm.question} rows={2}
                            onChange={e => setQForm({ ...qForm, question: e.target.value })}
                            placeholder="e.g. What is the safe holding temperature for hot food?"
                            className={inputCls} autoFocus />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs text-[#6B5744]">
                      Options — tick the correct answer *
                    </label>
                    {qForm.kind === 'mcq' && qForm.options.length < 12 && (
                      <button onClick={() => setQForm(f => ({ ...f, options: [...f.options, ''] }))}
                              className="text-xs font-medium text-[#af4408] hover:underline inline-flex items-center gap-1">
                        <Plus className="w-3 h-3" /> Add option
                      </button>
                    )}
                  </div>
                  {qForm.options.map((opt, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="correct-option"
                        checked={qForm.correctIdx === i}
                        onChange={() => setQForm(f => ({ ...f, correctIdx: i }))}
                        title="Mark as the correct answer"
                        className="shrink-0 accent-[#af4408] w-4 h-4"
                      />
                      <input
                        value={opt}
                        onChange={e => setQForm(f => {
                          const options = [...f.options];
                          options[i] = e.target.value;
                          return { ...f, options };
                        })}
                        placeholder={`Option ${i + 1}`}
                        className={inputCls}
                      />
                      {qForm.kind === 'mcq' && qForm.options.length > 2 && (
                        <button
                          onClick={() => setQForm(f => {
                            const options = f.options.filter((_, j) => j !== i);
                            let correctIdx = f.correctIdx;
                            if (correctIdx === i) correctIdx = -1;
                            else if (correctIdx > i) correctIdx -= 1;
                            return { ...f, options, correctIdx };
                          })}
                          title="Remove option"
                          className="shrink-0 p-1.5 rounded-lg border border-[#E8D5C4] text-[#8B7355] hover:bg-red-50 hover:text-red-700 hover:border-red-200">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  ))}
                  <p className="text-[10px] text-[#8B7355]">
                    {qForm.kind === 'true_false'
                      ? 'True / False uses exactly two choices.'
                      : '2 to 12 distinct choices. Blanks and duplicates are dropped on save.'}
                  </p>
                </div>
              </div>

              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
                <button onClick={() => setShowQModal(false)} disabled={qSaving}
                        className="px-3 py-2 text-sm text-[#6B5744] disabled:opacity-50">
                  Cancel
                </button>
                <button onClick={saveQuestion} disabled={qSaving}
                        className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
                  {qSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ══ Run-test modal (pick → run → result) ══ */}
        {runOpen && detail && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
            <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
                 className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-2xl shadow-xl flex flex-col overflow-hidden">
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between gap-3 shrink-0">
                <div className="min-w-0">
                  <h2 className="font-bold text-[#2D1B0E] truncate">{detail.test.name}</h2>
                  {runStage === 'run' && attempt && (
                    <p className="text-[11px] text-[#8B7355]">
                      {empById.get(attempt.employee_id)?.full_name || attempt.employee_name || 'Employee'}
                      {' · '}attempt #{attempt.attempt_no} · paper v{attempt.test_version}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {runStage === 'run' && remaining !== null && (
                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-sm font-bold border ${
                      remaining < 60
                        ? 'bg-red-50 text-red-700 border-red-200'
                        : 'bg-[#FFF1E3] text-[#af4408] border-[#E8D5C4]'
                    }`}>
                      <Clock className="w-4 h-4" /> {fmtSecs(remaining)}
                    </span>
                  )}
                  <button onClick={() => { if (!runBusy) closeRun(); }} className="text-[#8B7355]">
                    <X className="w-5 h-5" />
                  </button>
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
                {runError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
                    {runError}
                  </div>
                )}

                {/* ── Stage: pick employee ── */}
                {runStage === 'pick' && (
                  <>
                    <div>
                      <label className="text-xs text-[#6B5744]">Employee *</label>
                      <Combobox
                        options={employeeOptions}
                        value={runEmpId ? (empById.get(runEmpId)?.full_name || '') : ''}
                        onChange={(v) => setRunEmpId(v)}
                        placeholder="Pick the employee taking the test"
                      />
                      {employees.length === 0 && (
                        <p className="text-[10px] text-[#8B7355] mt-1">
                          Employee list is loading — refresh if it stays empty.
                        </p>
                      )}
                    </div>

                    <div className="rounded-lg bg-[#FFF8F0] border border-[#E8D5C4] px-3 py-2.5 text-xs text-[#6B5744] space-y-1">
                      <div>
                        {detail.questions.length} question{detail.questions.length === 1 ? '' : 's'} ·
                        {' '}pass mark {detail.test.pass_score}% ·
                        {' '}{detail.test.time_limit_minutes > 0
                          ? `time limit ${detail.test.time_limit_minutes} min` : 'untimed'}
                      </div>
                      {pickedUsage && (
                        <div>
                          {pickedUsage.finished} of {detail.test.max_attempts} attempts used.
                          {pickedUsage.hasOpen && ' An unfinished attempt exists — starting resumes it.'}
                        </div>
                      )}
                      {maxReached && (
                        <div className="text-red-700 font-medium">
                          Maximum attempts reached for this employee.
                        </div>
                      )}
                    </div>
                  </>
                )}

                {/* ── Stage: runner (one question per screen) ── */}
                {runStage === 'run' && (
                  currentQ ? (
                    <>
                      <div>
                        <div className="flex items-center justify-between text-xs text-[#6B5744] mb-1">
                          <span>Question {qIdx + 1} of {takerQs.length}</span>
                          <span>{answeredCount} answered</span>
                        </div>
                        <div className="h-1.5 rounded-full bg-[#FFF1E3] overflow-hidden">
                          <div className="h-full bg-[#af4408] rounded-full transition-all"
                               style={{ width: `${((qIdx + 1) / Math.max(1, takerQs.length)) * 100}%` }} />
                        </div>
                      </div>

                      <div className="text-base font-medium text-[#2D1B0E]">{currentQ.question}</div>

                      {currentQ.options.length === 0 ? (
                        <div className="text-sm text-[#8B7355]">
                          This question has no options — skip it and flag the paper to an admin.
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {currentQ.options.map(opt => {
                            const chosen = answers[currentQ.id] === opt;
                            return (
                              <button key={opt}
                                      onClick={() => setAnswers(a => ({ ...a, [currentQ.id]: opt }))}
                                      className={`w-full text-left px-3 py-2.5 rounded-lg border text-sm transition-colors flex items-center gap-2 ${
                                        chosen
                                          ? 'border-[#af4408] bg-[#FFF1E3] text-[#2D1B0E] font-medium'
                                          : 'border-[#E8D5C4] bg-white hover:bg-[#FFF8F0] text-[#2D1B0E]'
                                      }`}>
                                <span className={`w-4 h-4 shrink-0 rounded-full border flex items-center justify-center ${
                                  chosen ? 'border-[#af4408] bg-[#af4408]' : 'border-[#D4B896]'
                                }`}>
                                  {chosen && <Check className="w-3 h-3 text-white" />}
                                </span>
                                {opt}
                              </button>
                            );
                          })}
                        </div>
                      )}

                      {qIdx === takerQs.length - 1 && answeredCount < takerQs.length && (
                        <div className="rounded-lg border border-amber-200 bg-amber-50 text-amber-800 px-3 py-2 text-xs">
                          {takerQs.length - answeredCount} question{takerQs.length - answeredCount === 1 ? ' is' : 's are'} unanswered
                          — they score as wrong if you submit now.
                        </div>
                      )}

                      <p className="text-[10px] text-[#8B7355]">
                        Closing this window keeps the attempt open — it resumes on the next run
                        {timeLimit > 0 ? ' with the same clock' : ''}.
                      </p>
                    </>
                  ) : (
                    <div className="text-sm text-[#8B7355]">This paper has no questions.</div>
                  )
                )}

                {/* ── Stage: result ── */}
                {runStage === 'result' && attempt && result && (
                  <div className="py-4 flex flex-col items-center text-center space-y-3">
                    {attempt.passed
                      ? <CheckCircle2 className="w-14 h-14 text-green-600" />
                      : <XCircle className="w-14 h-14 text-red-500" />}
                    <div className="text-4xl font-bold text-[#2D1B0E]">{attempt.score}%</div>
                    <span className={`inline-flex px-3 py-1 rounded-full text-sm font-medium border ${
                      attempt.passed
                        ? 'bg-green-50 text-green-700 border-green-200'
                        : 'bg-red-50 text-red-700 border-red-200'
                    }`}>
                      {attempt.passed ? 'Passed' : 'Failed'}
                    </span>
                    <div className="text-sm text-[#6B5744]">
                      {result.correct} of {result.total} correct · pass mark {detail.test.pass_score}%
                    </div>
                    <div className="text-xs text-[#8B7355]">
                      {attempt.employee_name || empById.get(attempt.employee_id)?.full_name || 'Employee'}
                      {' · '}attempt #{attempt.attempt_no} of {detail.test.max_attempts}
                    </div>
                  </div>
                )}
              </div>

              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-between gap-2 shrink-0">
                {runStage === 'pick' && (
                  <>
                    <button onClick={closeRun} disabled={runBusy}
                            className="px-3 py-2 text-sm text-[#6B5744] disabled:opacity-50">
                      Cancel
                    </button>
                    <button onClick={startRun} disabled={runBusy || !runEmpId || maxReached}
                            className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1.5 disabled:opacity-50">
                      {runBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                      {pickedUsage?.hasOpen ? 'Resume Attempt' : 'Start Attempt'}
                    </button>
                  </>
                )}
                {runStage === 'run' && (
                  <>
                    <button onClick={() => setQIdx(i => Math.max(0, i - 1))}
                            disabled={qIdx <= 0 || runBusy}
                            className="inline-flex items-center gap-1 px-3 py-2 border border-[#E8D5C4] bg-white hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm font-medium disabled:opacity-40">
                      <ChevronLeft className="w-4 h-4" /> Prev
                    </button>
                    {qIdx < takerQs.length - 1 ? (
                      <button onClick={() => setQIdx(i => Math.min(takerQs.length - 1, i + 1))}
                              disabled={runBusy}
                              className="inline-flex items-center gap-1 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium disabled:opacity-50">
                        Next <ChevronRight className="w-4 h-4" />
                      </button>
                    ) : (
                      <button onClick={() => submitAttempt()} disabled={runBusy}
                              className="inline-flex items-center gap-1.5 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium disabled:opacity-50">
                        {runBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                        Submit Test
                      </button>
                    )}
                  </>
                )}
                {runStage === 'result' && (
                  <button onClick={closeRun}
                          className="ml-auto px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg font-medium">
                    Close
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
