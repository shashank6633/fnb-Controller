'use client';

/**
 * HR — Training (/hr/training, Phase 5). mgmtOnly page (catalog flag); the API
 * (/api/hr/trainings, canManageHr on every verb) is the security boundary —
 * this page just renders what it is allowed to see.
 *
 * Contract: docs/HRMS_DECISIONS.md. Structure copied from the Phase 1 exemplar
 * (src/app/hr/employees/page.tsx): server-side pagination, fetchSeq race guard,
 * house modal shell, Combobox (portaled) for pickers, literal hex palette.
 *
 * Master-detail on one page:
 *  · Trainings CRUD (create/edit modal, soft deactivate via DELETE ?id=,
 *    reactivate via PUT is_active) with q / department / show-inactive filters.
 *  · Selecting a training loads its assignment roster (GET ?training_id=) —
 *    status-vocab badges, score entry + remarks (result modal), quick
 *    Complete / Fail actions (PATCH), filterable by status + employee.
 *  · Assign modal: employee MULTI-PICK via checkboxes fed from
 *    GET /api/hr/employees?pageSize=100 (rows carry employee_code + full_name;
 *    no photos in lists), plus a due date → POST { action:'assign' }.
 * All mutations go through api()/apiJson() (CSRF); GETs are bare fetch.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  GraduationCap, Plus, Search, X, Loader2, Save, ChevronLeft, ChevronRight,
  Pencil, CheckCircle2, XCircle, UserPlus, Archive, ArchiveRestore, ClipboardList,
} from 'lucide-react';
import { apiJson } from '@/lib/api';
import { fmtISTDate, todayIST } from '@/lib/format-date';
import Combobox, { type ComboOption } from '@/components/Combobox';
import TabScroller from '@/components/TabScroller';
import Toggle from '@/components/Toggle';
import {
  HR_TRAINING_STATUSES,
  trainingStatusMeta,
  type HrTraining,
  type HrTrainingAssignment,
} from '@/lib/hr';

const PAGE_SIZE = 25;

/** One list/detail row from /api/hr/trainings (training + joined names + counters). */
interface TrainingRow extends HrTraining {
  department_name: string | null;
  sop_title: string | null;
  assigned_count: number;
  completed_count: number;
}

/** One roster row from GET ?training_id= (assignment + employee display names). */
interface AssignmentRow extends HrTrainingAssignment {
  employee_name: string | null;
  employee_code: string | null;
}

interface DeptRow { id: string; name: string; parent_id: string | null; is_active: number }
interface SopRow { id: string; title: string; is_active: number }
/** Minimal slice of a GET /api/hr/employees row this page reads. */
interface EmployeeRow {
  id: string;
  employee_code: string;
  full_name: string;
  status: string;
  department_name: string | null;
}

interface TrainingForm { name: string; trainer: string; department_id: string; sop_id: string }
const emptyForm = (): TrainingForm => ({ name: '', trainer: '', department_id: '', sop_id: '' });

/** Overdue = has a due date in the past and was never completed. */
function isOverdue(a: AssignmentRow): boolean {
  return !!a.due_date && !a.completed_date && a.status !== 'completed' && a.due_date < todayIST();
}

export default function HrTrainingPage() {
  // ── Trainings list state ────────────────────────────────────────────────
  const [rows, setRows] = useState<TrainingRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);   // first paint only
  const [fetching, setFetching] = useState(false); // any in-flight list fetch
  const [error, setError] = useState<string | null>(null);

  // ── List filters ────────────────────────────────────────────────────────
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');            // debounced searchInput
  const [deptId, setDeptId] = useState('');  // '' = all departments
  const [showInactive, setShowInactive] = useState(false);

  // ── Picker data ─────────────────────────────────────────────────────────
  const [departments, setDepartments] = useState<DeptRow[]>([]);
  const [sops, setSops] = useState<SopRow[]>([]);

  // ── Detail (selected training + roster) ─────────────────────────────────
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ training: TrainingRow; assignments: AssignmentRow[] } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('');   // '' = all statuses
  const [employeeFilter, setEmployeeFilter] = useState(''); // '' = all employees

  // ── Create / edit training modal ────────────────────────────────────────
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<TrainingForm>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // ── Assign modal ────────────────────────────────────────────────────────
  const [showAssign, setShowAssign] = useState(false);
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [empLoaded, setEmpLoaded] = useState(false);
  const [empError, setEmpError] = useState<string | null>(null);
  const [empSearch, setEmpSearch] = useState('');
  const [pickedIds, setPickedIds] = useState<Set<string>>(new Set());
  const [dueDate, setDueDate] = useState('');
  const [assigning, setAssigning] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);

  // ── Result modal (score / remarks / status / due date on ONE assignment) ─
  const [resultFor, setResultFor] = useState<AssignmentRow | null>(null);
  const [resStatus, setResStatus] = useState('assigned');
  const [resScore, setResScore] = useState('');
  const [resRemarks, setResRemarks] = useState('');
  const [resDue, setResDue] = useState('');
  const [resSaving, setResSaving] = useState(false);
  const [resError, setResError] = useState<string | null>(null);

  /** Row whose quick Complete/Fail PATCH is in flight (disables its buttons). */
  const [actingId, setActingId] = useState<string | null>(null);

  // Race guards: a stale response must never overwrite a newer one
  // (pattern copied from src/app/crm-calls/log/page.tsx via the exemplar).
  const fetchSeq = useRef(0);
  const detailSeq = useRef(0);

  // Debounce the search box (300ms)
  useEffect(() => {
    const t = setTimeout(() => setQ(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Reset to page 1 whenever any list filter changes
  useEffect(() => { setPage(1); }, [q, deptId, showInactive]);

  const buildQuery = useCallback((p: number) => {
    const sp = new URLSearchParams();
    if (q) sp.set('q', q);
    if (deptId) sp.set('department_id', deptId);
    if (!showInactive) sp.set('is_active', '1');
    sp.set('page', String(p));
    sp.set('pageSize', String(PAGE_SIZE));
    return sp.toString();
  }, [q, deptId, showInactive]);

  const fetchTrainings = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setFetching(true);
    setError(null);
    try {
      const res = await fetch(`/api/hr/trainings?${buildQuery(page)}`);
      if (seq !== fetchSeq.current) return; // superseded
      if (!res.ok) {
        setError(res.status === 401 || res.status === 403
          ? 'You need management access to view trainings.'
          : "Couldn't load trainings");
        return;
      }
      const json = await res.json();
      if (seq !== fetchSeq.current) return; // superseded
      setRows(Array.isArray(json?.rows) ? json.rows : []);
      setTotal(Number(json?.total) || 0);
    } catch {
      if (seq === fetchSeq.current) setError("Couldn't load trainings");
    } finally {
      if (seq === fetchSeq.current) { setFetching(false); setLoading(false); }
    }
  }, [buildQuery, page]);

  useEffect(() => { fetchTrainings(); }, [fetchTrainings]);

  const fetchDetail = useCallback(async (id: string) => {
    const seq = ++detailSeq.current;
    setDetailLoading(true);
    setDetailError(null);
    try {
      const res = await fetch(`/api/hr/trainings?training_id=${encodeURIComponent(id)}`);
      if (seq !== detailSeq.current) return; // superseded
      if (!res.ok) {
        setDetailError("Couldn't load the assignment roster");
        return;
      }
      const json = await res.json();
      if (seq !== detailSeq.current) return; // superseded
      if (json?.training) {
        setDetail({
          training: json.training,
          assignments: Array.isArray(json?.assignments) ? json.assignments : [],
        });
      } else {
        setDetailError("Couldn't load the assignment roster");
      }
    } catch {
      if (seq === detailSeq.current) setDetailError("Couldn't load the assignment roster");
    } finally {
      if (seq === detailSeq.current) setDetailLoading(false);
    }
  }, []);

  const selectTraining = (id: string) => {
    if (selectedId === id) return;
    setSelectedId(id);
    setDetail(null);
    setStatusFilter('');
    setEmployeeFilter('');
    fetchDetail(id);
  };
  const closeDetail = () => {
    detailSeq.current++; // cancel any in-flight detail fetch
    setSelectedId(null);
    setDetail(null);
    setDetailError(null);
  };

  // Picker data — one fetch each on mount (bare fetch is fine for GETs)
  useEffect(() => {
    fetch('/api/departments')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(j => setDepartments(Array.isArray(j?.departments) ? j.departments : []))
      .catch(() => {});
    fetch('/api/hr/sops?pageSize=100')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(j => setSops(Array.isArray(j?.rows) ? j.rows : []))
      .catch(() => {});
  }, []);

  /** Employee roster for the assign modal — loaded lazily on first open. */
  const loadEmployees = useCallback(async () => {
    setEmpError(null);
    try {
      const res = await fetch('/api/hr/employees?pageSize=100');
      if (!res.ok) { setEmpError("Couldn't load employees"); return; }
      const json = await res.json();
      setEmployees(Array.isArray(json?.rows) ? json.rows : []);
      setEmpLoaded(true);
    } catch {
      setEmpError("Couldn't load employees");
    }
  }, []);

  // ── Department options (tree: mains + subs with parent hint) ────────────
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

  const sopOptions = useMemo<ComboOption[]>(
    () => [
      { value: '', label: '(none)' },
      ...sops.filter(s => s.is_active !== 0).map(s => ({ value: s.id, label: s.title })),
    ],
    [sops],
  );

  // ── Create / edit / deactivate / reactivate ─────────────────────────────
  const openCreate = () => { setEditId(null); setForm(emptyForm()); setFormError(null); setShowForm(true); };
  const openEdit = (t: TrainingRow) => {
    setEditId(t.id);
    setForm({ name: t.name, trainer: t.trainer, department_id: t.department_id, sop_id: t.sop_id });
    setFormError(null);
    setShowForm(true);
  };

  const saveTraining = async () => {
    if (!form.name.trim()) { setFormError('Training name is required.'); return; }
    setSaving(true);
    setFormError(null);
    try {
      if (editId) {
        await apiJson('/api/hr/trainings', { method: 'PUT', body: { id: editId, ...form, name: form.name.trim() } });
      } else {
        await apiJson('/api/hr/trainings', { method: 'POST', body: { ...form, name: form.name.trim() } });
      }
      setShowForm(false);
      fetchTrainings();
      if (editId && selectedId === editId) fetchDetail(editId);
    } catch (e: any) {
      setFormError(e?.message || 'Could not save the training');
    } finally {
      setSaving(false);
    }
  };

  const deactivate = async (t: TrainingRow) => {
    if (!confirm(`Deactivate "${t.name}"? Existing assignments keep their records; it only disappears from pickers.`)) return;
    try {
      await apiJson(`/api/hr/trainings?id=${encodeURIComponent(t.id)}`, { method: 'DELETE' });
      fetchTrainings();
      if (selectedId === t.id) fetchDetail(t.id);
    } catch (e: any) {
      setError(e?.message || 'Could not deactivate the training');
    }
  };

  const reactivate = async (t: TrainingRow) => {
    try {
      await apiJson('/api/hr/trainings', { method: 'PUT', body: { id: t.id, is_active: true } });
      fetchTrainings();
      if (selectedId === t.id) fetchDetail(t.id);
    } catch (e: any) {
      setError(e?.message || 'Could not reactivate the training');
    }
  };

  // ── Assign flow ─────────────────────────────────────────────────────────
  const openAssign = () => {
    setPickedIds(new Set());
    setDueDate('');
    setEmpSearch('');
    setAssignError(null);
    setShowAssign(true);
    if (!empLoaded) loadEmployees();
  };

  const alreadyAssigned = useMemo(
    () => new Set((detail?.assignments ?? []).map(a => a.employee_id)),
    [detail],
  );

  const visibleEmployees = useMemo(() => {
    const raw = empSearch.trim().toLowerCase();
    if (!raw) return employees;
    return employees.filter(e =>
      e.full_name.toLowerCase().includes(raw) ||
      e.employee_code.toLowerCase().includes(raw) ||
      (e.department_name || '').toLowerCase().includes(raw),
    );
  }, [employees, empSearch]);

  const togglePick = (id: string) => {
    setPickedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const pickAllVisible = () => {
    setPickedIds(prev => {
      const next = new Set(prev);
      for (const e of visibleEmployees) if (!alreadyAssigned.has(e.id)) next.add(e.id);
      return next;
    });
  };
  const clearPicks = () => setPickedIds(new Set());

  const submitAssign = async () => {
    if (!selectedId) return;
    if (pickedIds.size === 0) { setAssignError('Select at least one employee.'); return; }
    setAssigning(true);
    setAssignError(null);
    try {
      const res = await apiJson<{ assigned: number; skipped: number }>('/api/hr/trainings', {
        method: 'POST',
        body: { action: 'assign', training_id: selectedId, employee_ids: [...pickedIds], due_date: dueDate },
      });
      setShowAssign(false);
      fetchDetail(selectedId);
      fetchTrainings(); // assigned_count changed
      if (res?.skipped) {
        // Not an error — the API skips employees who already hold the assignment.
        setDetailError(null);
      }
    } catch (e: any) {
      setAssignError(e?.message || 'Could not assign the training');
    } finally {
      setAssigning(false);
    }
  };

  // ── Assignment mutations ────────────────────────────────────────────────
  /** Merge one PATCHed assignment row back into the detail roster. */
  const mergeAssignment = (updated: AssignmentRow) => {
    setDetail(d => d
      ? { ...d, assignments: d.assignments.map(a => (a.id === updated.id ? { ...a, ...updated } : a)) }
      : d);
  };

  const quickStatus = async (a: AssignmentRow, status: 'completed' | 'failed') => {
    setActingId(a.id);
    try {
      const res = await apiJson<{ assignment: AssignmentRow }>('/api/hr/trainings', {
        method: 'PATCH',
        body: { id: a.id, status },
      });
      if (res?.assignment) mergeAssignment(res.assignment);
      fetchTrainings(); // completed_count changed
    } catch (e: any) {
      setDetailError(e?.message || 'Could not update the assignment');
    } finally {
      setActingId(null);
    }
  };

  const openResult = (a: AssignmentRow) => {
    setResultFor(a);
    setResStatus(String(a.status || 'assigned'));
    setResScore(a.score === null || a.score === undefined ? '' : String(a.score));
    setResRemarks(a.remarks || '');
    setResDue(a.due_date || '');
    setResError(null);
  };

  const saveResult = async () => {
    if (!resultFor) return;
    const scoreTrim = resScore.trim();
    if (scoreTrim !== '') {
      const n = Number(scoreTrim);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        setResError('Score must be a number between 0 and 100.');
        return;
      }
    }
    setResSaving(true);
    setResError(null);
    try {
      const res = await apiJson<{ assignment: AssignmentRow }>('/api/hr/trainings', {
        method: 'PATCH',
        body: {
          id: resultFor.id,
          status: resStatus,
          score: scoreTrim === '' ? null : Number(scoreTrim),
          remarks: resRemarks,
          due_date: resDue,
        },
      });
      if (res?.assignment) mergeAssignment(res.assignment);
      setResultFor(null);
      fetchTrainings(); // completed_count may have changed
    } catch (e: any) {
      setResError(e?.message || 'Could not save the result');
    } finally {
      setResSaving(false);
    }
  };

  // ── Assignment filters (client-side over the loaded roster) ─────────────
  const rosterEmployeeOptions = useMemo<ComboOption[]>(() => {
    const seen = new Map<string, string>();
    for (const a of detail?.assignments ?? []) {
      if (!seen.has(a.employee_id)) {
        seen.set(a.employee_id, a.employee_name || a.employee_code || '(unknown)');
      }
    }
    return [
      { value: '', label: 'All employees' },
      ...[...seen.entries()]
        .sort((x, y) => x[1].localeCompare(y[1]))
        .map(([value, label]) => ({ value, label })),
    ];
  }, [detail]);

  const filteredAssignments = useMemo(() => {
    let list = detail?.assignments ?? [];
    if (statusFilter) list = list.filter(a => a.status === statusFilter);
    if (employeeFilter) list = list.filter(a => a.employee_id === employeeFilter);
    return list;
  }, [detail, statusFilter, employeeFilter]);

  const employeeFilterLabel = employeeFilter
    ? (rosterEmployeeOptions.find(o => o.value === employeeFilter)?.label || '')
    : '';

  // ── Pagination derived ──────────────────────────────────────────────────
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const fromN = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const toN = Math.min(page * PAGE_SIZE, total);

  const inputCls = 'w-full px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm';
  const dash = <span className="text-[#8B7355]">—</span>;

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">

        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-2">
              <GraduationCap className="w-6 h-6" /> Training
            </h1>
            <p className="text-[#8B7355] text-sm mt-1">
              Training programs{loading ? '' : ` — ${total} training${total === 1 ? '' : 's'}`}. Pick one to manage its assignments.
            </p>
          </div>
          <button onClick={openCreate}
                  className="inline-flex items-center gap-2 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium">
            <Plus className="w-4 h-4" /> Add Training
          </button>
        </div>

        {/* Filters */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 flex-1 min-w-[200px]">
              <Search className="w-4 h-4 text-[#8B7355]" />
              <input value={searchInput} onChange={e => setSearchInput(e.target.value)}
                     placeholder="Training or trainer…"
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
            <label className="flex items-center gap-2 text-xs text-[#6B5744]">
              <Toggle size="sm" checked={showInactive} onChange={setShowInactive} label="Show inactive trainings" />
              Show inactive
            </label>
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm flex items-center justify-between gap-3">
            <span>{error}</span>
            <button onClick={() => { setError(null); fetchTrainings(); }}
                    className="shrink-0 px-3 py-1.5 border border-red-200 rounded-lg text-xs font-medium hover:bg-red-100">
              Retry
            </button>
          </div>
        )}

        {/* Trainings table */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
          {loading ? (
            <div className="p-6 flex items-center justify-center gap-2 text-[#8B7355] text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading...
            </div>
          ) : rows.length === 0 ? (
            <div className="p-6 text-center text-[#8B7355] text-sm">
              {q || deptId || showInactive ? 'No trainings match these filters.' : 'No trainings yet — add the first one.'}
            </div>
          ) : (
            <>
              <div className={`overflow-x-auto ${fetching ? 'opacity-60' : ''}`}>
                <table className="w-full text-sm">
                  <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                    <tr>
                      <th className="text-left py-2 px-3 font-medium">Training</th>
                      <th className="text-left py-2 px-3 font-medium">Trainer</th>
                      <th className="text-left py-2 px-3 font-medium">Department</th>
                      <th className="text-left py-2 px-3 font-medium">SOP</th>
                      <th className="text-right py-2 px-3 font-medium">Assigned</th>
                      <th className="text-right py-2 px-3 font-medium">Completed</th>
                      <th className="text-left py-2 px-3 font-medium">Active</th>
                      <th className="text-right py-2 px-3 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(t => (
                      <tr key={t.id}
                          className={`border-t border-[#E8D5C4]/50 cursor-pointer ${
                            selectedId === t.id ? 'bg-[#FFF1E3]' : 'hover:bg-[#FFF1E3]'
                          }`}
                          onClick={() => selectTraining(t.id)}>
                        <td className="py-2 px-3">
                          <span className="font-bold text-[#2D1B0E]">{t.name}</span>
                        </td>
                        <td className="py-2 px-3 text-xs">{t.trainer || dash}</td>
                        <td className="py-2 px-3 text-xs">{t.department_name || dash}</td>
                        <td className="py-2 px-3 text-xs">{t.sop_title || dash}</td>
                        <td className="py-2 px-3 text-xs text-right font-mono">{t.assigned_count}</td>
                        <td className="py-2 px-3 text-xs text-right font-mono">{t.completed_count}</td>
                        <td className="py-2 px-3">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border ${
                            t.is_active
                              ? 'bg-green-100 text-green-700 border-green-200'
                              : 'bg-slate-100 text-slate-600 border-slate-200'
                          }`}>
                            {t.is_active ? 'Active' : 'Inactive'}
                          </span>
                        </td>
                        <td className="py-2 px-3">
                          <div className="flex items-center justify-end gap-1" onClick={e => e.stopPropagation()}>
                            <button onClick={() => openEdit(t)} title="Edit training"
                                    className="p-1.5 rounded-lg text-[#6B5744] hover:bg-[#FFF1E3] border border-transparent hover:border-[#E8D5C4]">
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            {t.is_active ? (
                              <button onClick={() => deactivate(t)} title="Deactivate training"
                                      className="p-1.5 rounded-lg text-[#6B5744] hover:bg-[#FFF1E3] border border-transparent hover:border-[#E8D5C4]">
                                <Archive className="w-3.5 h-3.5" />
                              </button>
                            ) : (
                              <button onClick={() => reactivate(t)} title="Reactivate training"
                                      className="p-1.5 rounded-lg text-[#6B5744] hover:bg-[#FFF1E3] border border-transparent hover:border-[#E8D5C4]">
                                <ArchiveRestore className="w-3.5 h-3.5" />
                              </button>
                            )}
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

        {/* Detail — assignment roster for the selected training */}
        {selectedId && (
          <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
            <div className="px-4 py-3 border-b border-[#E8D5C4] flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <ClipboardList className="w-4 h-4 text-[#af4408] shrink-0" />
                <h2 className="font-bold text-[#2D1B0E] truncate">
                  {detail?.training?.name || 'Assignments'}
                </h2>
                {detail && (
                  <span className="text-xs text-[#8B7355] whitespace-nowrap">
                    {detail.assignments.length} assignment{detail.assignments.length === 1 ? '' : 's'}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button onClick={openAssign}
                        disabled={!detail || !detail.training.is_active}
                        title={detail && !detail.training.is_active ? 'Reactivate the training before assigning' : undefined}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-xs font-medium disabled:opacity-40">
                  <UserPlus className="w-3.5 h-3.5" /> Assign Employees
                </button>
                <button onClick={closeDetail} className="p-1.5 text-[#8B7355] hover:text-[#2D1B0E]" title="Close">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Assignment filters: status chips + employee picker */}
            <div className="px-4 py-3 border-b border-[#E8D5C4]/60 space-y-3">
              <TabScroller className="gap-2">
                <button onClick={() => setStatusFilter('')}
                        className={`px-3 py-1.5 rounded-full text-xs font-medium border ${
                          statusFilter === ''
                            ? 'bg-[#af4408] text-white border-[#af4408]'
                            : 'bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]'
                        }`}>
                  All
                </button>
                {HR_TRAINING_STATUSES.map(s => (
                  <button key={s.key} onClick={() => setStatusFilter(prev => (prev === s.key ? '' : s.key))}
                          className={`px-3 py-1.5 rounded-full text-xs font-medium border ${
                            statusFilter === s.key
                              ? 'bg-[#af4408] text-white border-[#af4408]'
                              : 'bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]'
                          }`}>
                    {s.label}
                  </button>
                ))}
              </TabScroller>
              <div className="w-full sm:w-72">
                <Combobox
                  options={rosterEmployeeOptions}
                  value={employeeFilterLabel}
                  onChange={(v) => setEmployeeFilter(v)}
                  placeholder="All employees"
                />
              </div>
            </div>

            {detailError && (
              <div className="mx-4 my-3 rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm flex items-center justify-between gap-3">
                <span>{detailError}</span>
                <button onClick={() => { setDetailError(null); fetchDetail(selectedId); }}
                        className="shrink-0 px-3 py-1.5 border border-red-200 rounded-lg text-xs font-medium hover:bg-red-100">
                  Retry
                </button>
              </div>
            )}

            {detailLoading && !detail ? (
              <div className="p-6 flex items-center justify-center gap-2 text-[#8B7355] text-sm">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading...
              </div>
            ) : !detail ? (
              !detailError && (
                <div className="p-6 text-center text-[#8B7355] text-sm">Pick a training above to see its assignments.</div>
              )
            ) : detail.assignments.length === 0 ? (
              <div className="p-6 text-center text-[#8B7355] text-sm">Nobody is assigned to this training yet.</div>
            ) : filteredAssignments.length === 0 ? (
              <div className="p-6 text-center text-[#8B7355] text-sm">No assignments match these filters.</div>
            ) : (
              <div className={`overflow-x-auto ${detailLoading ? 'opacity-60' : ''}`}>
                <table className="w-full text-sm">
                  <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                    <tr>
                      <th className="text-left py-2 px-3 font-medium">Employee</th>
                      <th className="text-left py-2 px-3 font-medium">Assigned</th>
                      <th className="text-left py-2 px-3 font-medium">Due</th>
                      <th className="text-left py-2 px-3 font-medium">Completed</th>
                      <th className="text-right py-2 px-3 font-medium">Score</th>
                      <th className="text-left py-2 px-3 font-medium">Status</th>
                      <th className="text-left py-2 px-3 font-medium">Remarks</th>
                      <th className="text-right py-2 px-3 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredAssignments.map(a => {
                      const meta = trainingStatusMeta(a.status);
                      const overdue = isOverdue(a);
                      const busy = actingId === a.id;
                      return (
                        <tr key={a.id} className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]">
                          <td className="py-2 px-3">
                            <span className="font-bold text-[#2D1B0E]">{a.employee_name || '(unknown)'}</span>
                            {a.employee_code && (
                              <div className="text-[10px] font-mono text-[#8B7355]">{a.employee_code}</div>
                            )}
                          </td>
                          <td className="py-2 px-3 text-xs whitespace-nowrap">
                            {a.assigned_date ? fmtISTDate(a.assigned_date) : dash}
                          </td>
                          <td className={`py-2 px-3 text-xs whitespace-nowrap ${overdue ? 'text-red-600 font-semibold' : ''}`}>
                            {a.due_date ? fmtISTDate(a.due_date) : dash}
                            {overdue && <div className="text-[10px] font-medium">Overdue</div>}
                          </td>
                          <td className="py-2 px-3 text-xs whitespace-nowrap">
                            {a.completed_date ? fmtISTDate(a.completed_date) : dash}
                          </td>
                          <td className="py-2 px-3 text-xs text-right font-mono">
                            {a.score === null || a.score === undefined ? dash : a.score}
                          </td>
                          <td className="py-2 px-3">
                            <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border ${meta.color}`}>
                              {meta.label}
                            </span>
                          </td>
                          <td className="py-2 px-3 text-xs max-w-[200px] truncate" title={a.remarks || undefined}>
                            {a.remarks || dash}
                          </td>
                          <td className="py-2 px-3">
                            <div className="flex items-center justify-end gap-1">
                              {a.status !== 'completed' && (
                                <button onClick={() => quickStatus(a, 'completed')} disabled={busy}
                                        title="Mark completed"
                                        className="p-1.5 rounded-lg text-green-700 hover:bg-green-50 border border-transparent hover:border-green-200 disabled:opacity-40">
                                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                                </button>
                              )}
                              {a.status !== 'failed' && a.status !== 'completed' && (
                                <button onClick={() => quickStatus(a, 'failed')} disabled={busy}
                                        title="Mark failed"
                                        className="p-1.5 rounded-lg text-rose-700 hover:bg-rose-50 border border-transparent hover:border-rose-200 disabled:opacity-40">
                                  <XCircle className="w-3.5 h-3.5" />
                                </button>
                              )}
                              <button onClick={() => openResult(a)} disabled={busy}
                                      title="Enter score / result"
                                      className="p-1.5 rounded-lg text-[#6B5744] hover:bg-[#FFF1E3] border border-transparent hover:border-[#E8D5C4] disabled:opacity-40">
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Create / edit training modal — house safe-modal shell */}
        {showForm && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
            <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
                 className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-lg shadow-xl flex flex-col overflow-hidden">
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E]">{editId ? 'Edit Training' : 'Add Training'}</h2>
                <button onClick={() => { if (!saving) setShowForm(false); }} className="text-[#8B7355]">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
                {formError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
                    {formError}
                  </div>
                )}
                <div>
                  <label className="text-xs text-[#6B5744]">Training name *</label>
                  <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
                         placeholder="e.g. Food Safety Basics" className={inputCls} autoFocus />
                </div>
                <div>
                  <label className="text-xs text-[#6B5744]">Trainer</label>
                  <input value={form.trainer} onChange={e => setForm({ ...form, trainer: e.target.value })}
                         placeholder="Who conducts it" className={inputCls} />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-[#6B5744]">Department</label>
                    <Combobox
                      options={deptModalOptions}
                      value={form.department_id ? (deptById.get(form.department_id)?.name || '') : ''}
                      onChange={(v) => setForm({ ...form, department_id: v })}
                      placeholder="Pick department"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-[#6B5744]">Linked SOP</label>
                    <Combobox
                      options={sopOptions}
                      value={form.sop_id ? (sops.find(s => s.id === form.sop_id)?.title || '') : ''}
                      onChange={(v) => setForm({ ...form, sop_id: v })}
                      placeholder="Pick SOP"
                    />
                  </div>
                </div>
                <p className="text-[11px] text-[#8B7355]">
                  Department and SOP are targeting hints — they help pick who to assign, they never restrict assignment.
                </p>
              </div>

              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
                <button onClick={() => setShowForm(false)} disabled={saving}
                        className="px-3 py-2 text-sm text-[#6B5744] disabled:opacity-50">
                  Cancel
                </button>
                <button onClick={saveTraining} disabled={saving}
                        className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Assign modal — employee multi-pick (checkboxes) + due date */}
        {showAssign && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
            <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
                 className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-lg shadow-xl flex flex-col overflow-hidden">
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E]">
                  Assign Employees{detail?.training?.name ? ` — ${detail.training.name}` : ''}
                </h2>
                <button onClick={() => { if (!assigning) setShowAssign(false); }} className="text-[#8B7355]">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
                {assignError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
                    {assignError}
                  </div>
                )}

                <div>
                  <label className="text-xs text-[#6B5744]">Due date</label>
                  <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} className={inputCls} />
                </div>

                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="text-xs text-[#6B5744]">
                      Employees * <span className="text-[#8B7355]">({pickedIds.size} selected)</span>
                    </label>
                    <div className="flex items-center gap-2">
                      <button onClick={pickAllVisible} type="button"
                              className="text-[11px] font-medium text-[#af4408] hover:underline">
                        Select all shown
                      </button>
                      <button onClick={clearPicks} type="button"
                              className="text-[11px] font-medium text-[#8B7355] hover:underline">
                        Clear
                      </button>
                    </div>
                  </div>
                  <input value={empSearch} onChange={e => setEmpSearch(e.target.value)}
                         placeholder="Search name, code, department…" className={inputCls} />

                  {empError ? (
                    <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm flex items-center justify-between gap-3">
                      <span>{empError}</span>
                      <button onClick={loadEmployees}
                              className="shrink-0 px-2 py-1 border border-red-200 rounded-lg text-xs font-medium hover:bg-red-100">
                        Retry
                      </button>
                    </div>
                  ) : !empLoaded ? (
                    <div className="p-4 flex items-center justify-center gap-2 text-[#8B7355] text-sm border border-[#E8D5C4] rounded-lg">
                      <Loader2 className="w-4 h-4 animate-spin" /> Loading employees...
                    </div>
                  ) : visibleEmployees.length === 0 ? (
                    <div className="p-4 text-center text-[#8B7355] text-sm border border-[#E8D5C4] rounded-lg">
                      No employees match this search.
                    </div>
                  ) : (
                    <div className="border border-[#E8D5C4] rounded-lg divide-y divide-[#E8D5C4]/50 max-h-64 overflow-y-auto">
                      {visibleEmployees.map(e => {
                        const assigned = alreadyAssigned.has(e.id);
                        return (
                          <label key={e.id}
                                 className={`flex items-center gap-3 px-3 py-2 text-sm ${
                                   assigned ? 'opacity-50' : 'cursor-pointer hover:bg-[#FFF1E3]'
                                 }`}>
                            <input type="checkbox"
                                   checked={assigned || pickedIds.has(e.id)}
                                   disabled={assigned}
                                   onChange={() => togglePick(e.id)}
                                   className="accent-[#af4408] w-4 h-4 shrink-0" />
                            <span className="min-w-0 flex-1">
                              <span className="font-medium text-[#2D1B0E]">{e.full_name}</span>
                              <span className="ml-2 text-[10px] font-mono text-[#8B7355]">{e.employee_code}</span>
                              {e.department_name && (
                                <span className="block text-[10px] text-[#8B7355] truncate">{e.department_name}</span>
                              )}
                            </span>
                            {assigned && (
                              <span className="shrink-0 text-[10px] text-[#8B7355]">already assigned</span>
                            )}
                          </label>
                        );
                      })}
                    </div>
                  )}
                  <p className="text-[11px] text-[#8B7355]">
                    Employees who already hold this training are skipped automatically.
                  </p>
                </div>
              </div>

              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
                <button onClick={() => setShowAssign(false)} disabled={assigning}
                        className="px-3 py-2 text-sm text-[#6B5744] disabled:opacity-50">
                  Cancel
                </button>
                <button onClick={submitAssign} disabled={assigning || pickedIds.size === 0}
                        className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
                  {assigning ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
                  Assign{pickedIds.size > 0 ? ` (${pickedIds.size})` : ''}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Result modal — status / score / remarks / due date on one assignment */}
        {resultFor && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
            <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
                 className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-md shadow-xl flex flex-col overflow-hidden">
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E]">
                  Result — {resultFor.employee_name || resultFor.employee_code || 'assignment'}
                </h2>
                <button onClick={() => { if (!resSaving) setResultFor(null); }} className="text-[#8B7355]">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
                {resError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
                    {resError}
                  </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-[#6B5744]">Status</label>
                    <select value={resStatus} onChange={e => setResStatus(e.target.value)} className={inputCls}>
                      {HR_TRAINING_STATUSES.map(s => (
                        <option key={s.key} value={s.key}>{s.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-[#6B5744]">Score (0–100)</label>
                    <input type="number" min={0} max={100} step="0.5" value={resScore}
                           onChange={e => setResScore(e.target.value)}
                           placeholder="Leave blank for none" className={inputCls} />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-[#6B5744]">Due date</label>
                  <input type="date" value={resDue} onChange={e => setResDue(e.target.value)} className={inputCls} />
                </div>
                <div>
                  <label className="text-xs text-[#6B5744]">Remarks</label>
                  <textarea value={resRemarks} onChange={e => setResRemarks(e.target.value)} rows={3}
                            placeholder="Trainer feedback, retake notes…" className={inputCls} />
                </div>
                <p className="text-[11px] text-[#8B7355]">
                  Marking Completed without a completed date stamps today automatically.
                </p>
              </div>

              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
                <button onClick={() => setResultFor(null)} disabled={resSaving}
                        className="px-3 py-2 text-sm text-[#6B5744] disabled:opacity-50">
                  Cancel
                </button>
                <button onClick={saveResult} disabled={resSaving}
                        className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
                  {resSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
