'use client';

/**
 * HR — Leave (Phase 3).
 *
 * Contract: docs/HRMS_DECISIONS.md §5/§6. Three tabs:
 *  · Requests — the pending queue (default) + all requests with a status
 *    filter, server-paginated against GET /api/hr/leave/requests. Every row
 *    renders its balance inline ("CL 4.5 of 12 left" — available of
 *    entitled+adjusted for the request's own (employee, type, from-year)
 *    bucket, computed by the API, never here). Approve/Reject open a modal
 *    with a REQUIRED note (decisions are admin acts — the API enforces
 *    canAdminHr and this page just surfaces its message); management can
 *    cancel a still-pending request from the same modal.
 *  · Apply — managers file on behalf: employee Combobox (fed from
 *    GET /api/hr/employees?pageSize=100 — code + name, no photos), leave
 *    type, from/to dates, half-day Toggle (forces to = from, days = 0.5),
 *    days computed client-side for display; the SERVER re-derives and
 *    validates everything (span, overlap, balance) and its human message is
 *    shown verbatim.
 *  · Types — CRUD table + modal over GET/POST/PUT/DELETE /api/hr/leave/types
 *    (soft deactivate only; mutations are admin-gated server-side).
 *
 * Conventions copied from src/app/hr/employees/page.tsx (canonical HR page):
 * bare fetch for GETs, api()/apiJson() for mutations (CSRF), fetch-race
 * guard, house palette, portaled Combobox in modals, Toggle for switches,
 * fmtIST* for every date. employee_id is ALWAYS hr_employees.id.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarDays, Plus, X, Loader2, Save, Check, Ban, Pencil, RotateCcw,
  ChevronLeft, ChevronRight, Send,
} from 'lucide-react';
import { apiJson } from '@/lib/api';
import { fmtIST, fmtISTDate } from '@/lib/format-date';
import Combobox, { type ComboOption } from '@/components/Combobox';
import Toggle from '@/components/Toggle';
import TabScroller from '@/components/TabScroller';
import {
  HR_LEAVE_STATUSES,
  leaveStatusMeta,
  type HrLeaveRequest,
  type HrLeaveType,
} from '@/lib/hr';

const PAGE_SIZE = 25;

/* ------------------------------------------------------------------ *
 * Wire shapes (mirror the leave routes exactly)
 * ------------------------------------------------------------------ */

/** Computed balance view from hr-leave's balanceOf (available is derived). */
interface BalanceView {
  entitled: number;
  taken: number;
  adjusted: number;
  available: number;
}

/** One GET /api/hr/leave/requests row: request + LEFT-JOINed labels + its
 *  own (employee, type, from-year) balance bucket. Dangling ids degrade to
 *  null labels, never dropped rows. */
interface RequestRow extends HrLeaveRequest {
  employee_code: string | null;
  full_name: string | null;
  leave_type_name: string | null;
  leave_type_is_paid: number | null;
  balance?: BalanceView;
}

/** The GET's per-employee balances map (every ACTIVE type, filter year). */
type EmployeeBalances = Record<
  string,
  ({ leave_type_id: string; leave_type_name: string; is_paid: number } & BalanceView)[]
>;

/** Minimal slice of a GET /api/hr/employees row the picker needs. */
interface EmployeePickRow {
  id: string;
  employee_code: string;
  full_name: string;
  status: string;
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/** Render leave-day counts without float noise: 4 -> "4", 4.5 -> "4.5". */
function fmtDays(n: number): string {
  const v = Math.round(Number(n) * 10) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** "CL 4.5 of 12 left" — the inline per-request balance line. */
function balanceLine(r: RequestRow): string | null {
  if (!r.balance) return null;
  const cap = Number(r.balance.entitled) + Number(r.balance.adjusted);
  return `${r.leave_type_name || 'Leave'} ${fmtDays(r.balance.available)} of ${fmtDays(cap)} left`;
}

/** Strict YYYY-MM-DD check (the date inputs emit this shape). */
function isYmd(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** Inclusive calendar-day span for DISPLAY only — the server re-derives. */
function spanDays(from: string, to: string): number {
  if (!isYmd(from) || !isYmd(to)) return 0;
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  if (Number.isNaN(ms) || ms < 0) return 0;
  return Math.round(ms / 86_400_000) + 1;
}

type Tab = 'requests' | 'apply' | 'types';
type DecisionMode = 'approve' | 'reject' | 'cancel';

interface ApplyForm {
  employee_id: string;
  leave_type_id: string;
  from_date: string;
  to_date: string;
  half_day: boolean;
  reason: string;
}

const emptyApply = (): ApplyForm => ({
  employee_id: '', leave_type_id: '', from_date: '', to_date: '', half_day: false, reason: '',
});

interface TypeForm {
  name: string;
  annual_entitlement: string;
  carry_forward_max: string;
  encashable: boolean;
  max_consecutive_days: string;
  is_paid: boolean;
}

const emptyType = (): TypeForm => ({
  name: '', annual_entitlement: '', carry_forward_max: '',
  encashable: false, max_consecutive_days: '', is_paid: true,
});

const DECISION_COPY: Record<DecisionMode, { title: string; verb: string; noteRequired: boolean }> = {
  approve: { title: 'Approve leave', verb: 'Approve', noteRequired: true },
  reject: { title: 'Reject leave', verb: 'Reject', noteRequired: true },
  cancel: { title: 'Cancel request', verb: 'Cancel request', noteRequired: false },
};

export default function HrLeavePage() {
  const [tab, setTab] = useState<Tab>('requests');

  // ── Requests tab state ──────────────────────────────────────────────────
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [balances, setBalances] = useState<EmployeeBalances>({});
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('pending'); // '' = all
  const [loading, setLoading] = useState(true);   // first paint only
  const [fetching, setFetching] = useState(false); // any in-flight list fetch
  const [error, setError] = useState<string | null>(null);
  // Race guard: a stale response must never overwrite a newer one.
  const fetchSeq = useRef(0);

  // ── Decision modal ──────────────────────────────────────────────────────
  const [decide, setDecide] = useState<{ mode: DecisionMode; row: RequestRow } | null>(null);
  const [note, setNote] = useState('');
  const [deciding, setDeciding] = useState(false);
  const [decideError, setDecideError] = useState<string | null>(null);

  // ── Apply tab state ─────────────────────────────────────────────────────
  const [employees, setEmployees] = useState<EmployeePickRow[]>([]);
  const [applyForm, setApplyForm] = useState<ApplyForm>(emptyApply());
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applySuccess, setApplySuccess] = useState<string | null>(null);

  // ── Types tab state ─────────────────────────────────────────────────────
  const [types, setTypes] = useState<HrLeaveType[]>([]);
  const [typesLoading, setTypesLoading] = useState(true);
  const [typesError, setTypesError] = useState<string | null>(null);
  const [typeModal, setTypeModal] = useState<{ id: string | null } | null>(null); // null id = create
  const [typeForm, setTypeForm] = useState<TypeForm>(emptyType());
  const [typeSaving, setTypeSaving] = useState(false);
  const [typeError, setTypeError] = useState<string | null>(null);
  const [typeBusyId, setTypeBusyId] = useState<string | null>(null);

  /* ---------------------------------------------------------------- *
   * Requests list
   * ---------------------------------------------------------------- */

  useEffect(() => { setPage(1); }, [statusFilter]);

  const fetchRequests = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setFetching(true);
    setError(null);
    try {
      const sp = new URLSearchParams();
      if (statusFilter) sp.set('status', statusFilter);
      sp.set('page', String(page));
      sp.set('pageSize', String(PAGE_SIZE));
      const res = await fetch(`/api/hr/leave/requests?${sp.toString()}`);
      if (seq !== fetchSeq.current) return; // a newer fetch superseded this one
      if (!res.ok) {
        setError(res.status === 401 || res.status === 403
          ? 'You need management access to view leave.'
          : "Couldn't load leave requests");
        return;
      }
      const json = await res.json();
      if (seq !== fetchSeq.current) return;
      setRows(Array.isArray(json?.rows) ? json.rows : []);
      setBalances(json?.balances && typeof json.balances === 'object' ? json.balances : {});
      setTotal(Number(json?.total) || 0);
    } catch {
      if (seq === fetchSeq.current) setError("Couldn't load leave requests");
    } finally {
      if (seq === fetchSeq.current) { setFetching(false); setLoading(false); }
    }
  }, [statusFilter, page]);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  /* ---------------------------------------------------------------- *
   * Picker + types data (bare fetch is fine for GETs)
   * ---------------------------------------------------------------- */

  useEffect(() => {
    fetch('/api/hr/employees?pageSize=100')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(j => setEmployees(Array.isArray(j?.rows) ? j.rows : []))
      .catch(() => {});
  }, []);

  const fetchTypes = useCallback(async () => {
    setTypesError(null);
    try {
      const res = await fetch('/api/hr/leave/types?include_inactive=1');
      if (!res.ok) {
        setTypesError(res.status === 401 || res.status === 403
          ? 'You need management access to view leave types.'
          : "Couldn't load leave types");
        return;
      }
      const json = await res.json();
      setTypes(Array.isArray(json?.leave_types) ? json.leave_types : []);
    } catch {
      setTypesError("Couldn't load leave types");
    } finally {
      setTypesLoading(false);
    }
  }, []);

  useEffect(() => { fetchTypes(); }, [fetchTypes]);

  const activeTypes = useMemo(() => types.filter(t => t.is_active === 1), [types]);

  /* ---------------------------------------------------------------- *
   * Decision modal (approve / reject / cancel)
   * ---------------------------------------------------------------- */

  const openDecision = (mode: DecisionMode, row: RequestRow) => {
    setDecide({ mode, row });
    setNote('');
    setDecideError(null);
  };

  const submitDecision = async () => {
    if (!decide) return;
    const { mode, row } = decide;
    const trimmed = note.trim();
    if (DECISION_COPY[mode].noteRequired && !trimmed) {
      setDecideError(`A note is required to ${mode} this request.`);
      return;
    }
    setDeciding(true);
    setDecideError(null);
    try {
      if (mode === 'cancel') {
        await apiJson('/api/hr/leave/requests', {
          method: 'POST',
          body: { action: 'cancel', id: row.id, reason: trimmed },
        });
      } else {
        await apiJson('/api/hr/leave/requests', {
          method: 'PATCH',
          body: { id: row.id, action: mode, review_reason: trimmed },
        });
      }
      setDecide(null);
      setNote('');
      fetchRequests();
    } catch (e: any) {
      // Server messages are human (validation, "Admin access required",
      // "already been decided") — surface them verbatim.
      setDecideError(e?.message || 'Could not update the leave request');
    } finally {
      setDeciding(false);
    }
  };

  /* ---------------------------------------------------------------- *
   * Apply tab
   * ---------------------------------------------------------------- */

  const employeeOptions = useMemo<ComboOption[]>(
    () => employees.map(e => ({ value: e.id, label: e.full_name, hint: e.employee_code })),
    [employees],
  );
  const selectedEmployee = useMemo(
    () => employees.find(e => e.id === applyForm.employee_id) || null,
    [employees, applyForm.employee_id],
  );
  const typeOptions = useMemo<ComboOption[]>(
    () =>
      activeTypes.map(t => ({
        value: t.id,
        label: t.name,
        hint: `${fmtDays(t.annual_entitlement)} days/yr${t.is_paid ? '' : ' · unpaid'}`,
      })),
    [activeTypes],
  );
  const selectedType = useMemo(
    () => activeTypes.find(t => t.id === applyForm.leave_type_id) || null,
    [activeTypes, applyForm.leave_type_id],
  );

  // Half day = a single date worth 0.5 — display calc only, server re-derives.
  const applyDays = useMemo(() => {
    if (applyForm.half_day) return isYmd(applyForm.from_date) ? 0.5 : 0;
    return spanDays(applyForm.from_date, applyForm.to_date);
  }, [applyForm.half_day, applyForm.from_date, applyForm.to_date]);

  const setFromDate = (v: string) => {
    setApplyForm(f => ({ ...f, from_date: v, to_date: f.half_day ? v : f.to_date }));
  };
  const setHalfDay = (on: boolean) => {
    setApplyForm(f => ({ ...f, half_day: on, to_date: on ? f.from_date : f.to_date }));
  };

  const submitApply = async () => {
    setApplySuccess(null);
    if (!applyForm.employee_id) { setApplyError('Pick an employee.'); return; }
    if (!applyForm.leave_type_id) { setApplyError('Pick a leave type.'); return; }
    if (!isYmd(applyForm.from_date) || !isYmd(applyForm.to_date)) {
      setApplyError('Both from and to dates are required.');
      return;
    }
    if (applyDays <= 0) { setApplyError('The to date cannot be before the from date.'); return; }
    setApplying(true);
    setApplyError(null);
    try {
      await apiJson('/api/hr/leave/requests', {
        method: 'POST',
        body: {
          employee_id: applyForm.employee_id,
          leave_type_id: applyForm.leave_type_id,
          from_date: applyForm.from_date,
          to_date: applyForm.to_date,
          days: applyDays,
          reason: applyForm.reason.trim(),
        },
      });
      setApplySuccess(
        `Leave request filed for ${selectedEmployee?.full_name || 'the employee'} — it is now in the pending queue.`,
      );
      setApplyForm(emptyApply());
      fetchRequests();
    } catch (e: any) {
      // hr-leave validation messages are human and caller-safe.
      setApplyError(e?.message || 'Could not file the leave request');
    } finally {
      setApplying(false);
    }
  };

  /* ---------------------------------------------------------------- *
   * Types tab
   * ---------------------------------------------------------------- */

  const openTypeCreate = () => {
    setTypeForm(emptyType());
    setTypeError(null);
    setTypeModal({ id: null });
  };
  const openTypeEdit = (t: HrLeaveType) => {
    setTypeForm({
      name: t.name,
      annual_entitlement: t.annual_entitlement ? String(t.annual_entitlement) : '',
      carry_forward_max: t.carry_forward_max ? String(t.carry_forward_max) : '',
      encashable: t.encashable === 1,
      max_consecutive_days: t.max_consecutive_days ? String(t.max_consecutive_days) : '',
      is_paid: t.is_paid === 1,
    });
    setTypeError(null);
    setTypeModal({ id: t.id });
  };

  const saveType = async () => {
    const name = typeForm.name.trim();
    if (!name) { setTypeError('Leave type name is required.'); return; }
    setTypeSaving(true);
    setTypeError(null);
    const payload = {
      name,
      annual_entitlement: Number(typeForm.annual_entitlement) || 0,
      carry_forward_max: Number(typeForm.carry_forward_max) || 0,
      encashable: typeForm.encashable,
      max_consecutive_days: Number(typeForm.max_consecutive_days) || 0,
      is_paid: typeForm.is_paid,
    };
    try {
      if (typeModal?.id) {
        await apiJson('/api/hr/leave/types', { method: 'PUT', body: { id: typeModal.id, ...payload } });
      } else {
        await apiJson('/api/hr/leave/types', { method: 'POST', body: payload });
      }
      setTypeModal(null);
      fetchTypes();
    } catch (e: any) {
      setTypeError(e?.message || 'Could not save the leave type');
    } finally {
      setTypeSaving(false);
    }
  };

  const deactivateType = async (t: HrLeaveType) => {
    setTypeBusyId(t.id);
    setTypesError(null);
    try {
      await apiJson(`/api/hr/leave/types?id=${encodeURIComponent(t.id)}`, { method: 'DELETE' });
      fetchTypes();
    } catch (e: any) {
      setTypesError(e?.message || 'Could not deactivate the leave type');
    } finally {
      setTypeBusyId(null);
    }
  };

  const reactivateType = async (t: HrLeaveType) => {
    setTypeBusyId(t.id);
    setTypesError(null);
    try {
      await apiJson('/api/hr/leave/types', { method: 'PUT', body: { id: t.id, is_active: true } });
      fetchTypes();
    } catch (e: any) {
      setTypesError(e?.message || 'Could not reactivate the leave type');
    } finally {
      setTypeBusyId(null);
    }
  };

  /* ---------------------------------------------------------------- *
   * Derived + shared bits
   * ---------------------------------------------------------------- */

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const fromN = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const toN = Math.min(page * PAGE_SIZE, total);

  const inputCls = 'w-full px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm';
  const pillCls = (active: boolean) =>
    `px-3 py-1.5 rounded-full text-xs font-medium border ${
      active
        ? 'bg-[#af4408] text-white border-[#af4408]'
        : 'bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]'
    }`;

  const decideRowBalances = decide ? balances[decide.row.employee_id] || [] : [];

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">

        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-2">
              <CalendarDays className="w-6 h-6" /> Leave
            </h1>
            <p className="text-[#8B7355] text-sm mt-1">
              Requests, filing on behalf of staff, and leave types.
            </p>
          </div>
          {tab === 'types' && (
            <button onClick={openTypeCreate}
                    className="inline-flex items-center gap-2 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium">
              <Plus className="w-4 h-4" /> Add Leave Type
            </button>
          )}
        </div>

        {/* Tab strip */}
        <TabScroller className="gap-2">
          <button onClick={() => setTab('requests')} className={pillCls(tab === 'requests')}>Requests</button>
          <button onClick={() => setTab('apply')} className={pillCls(tab === 'apply')}>Apply</button>
          <button onClick={() => setTab('types')} className={pillCls(tab === 'types')}>Types</button>
        </TabScroller>

        {/* ══════════════════ Requests ══════════════════ */}
        {tab === 'requests' && (
          <>
            <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-3">
              <TabScroller className="gap-2">
                {HR_LEAVE_STATUSES.map(s => (
                  <button key={s.key} onClick={() => setStatusFilter(s.key)}
                          className={pillCls(statusFilter === s.key)}>
                    {s.label}
                  </button>
                ))}
                <button onClick={() => setStatusFilter('')} className={pillCls(statusFilter === '')}>
                  All
                </button>
              </TabScroller>
            </div>

            {error && (
              <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm flex items-center justify-between gap-3">
                <span>{error}</span>
                <button onClick={() => fetchRequests()}
                        className="shrink-0 px-3 py-1.5 border border-red-200 rounded-lg text-xs font-medium hover:bg-red-100">
                  Retry
                </button>
              </div>
            )}

            <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
              {loading ? (
                <div className="p-6 flex items-center justify-center gap-2 text-[#8B7355] text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading...
                </div>
              ) : rows.length === 0 ? (
                <div className="p-6 text-center text-[#8B7355] text-sm">
                  {statusFilter === 'pending'
                    ? 'No pending leave requests — the queue is clear.'
                    : 'No leave requests match this filter.'}
                </div>
              ) : (
                <>
                  <div className={`overflow-x-auto ${fetching ? 'opacity-60' : ''}`}>
                    <table className="w-full text-sm">
                      <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                        <tr>
                          <th className="text-left py-2 px-3 font-medium">Employee</th>
                          <th className="text-left py-2 px-3 font-medium">Type</th>
                          <th className="text-left py-2 px-3 font-medium">Dates</th>
                          <th className="text-right py-2 px-3 font-medium">Days</th>
                          <th className="text-left py-2 px-3 font-medium">Balance</th>
                          <th className="text-left py-2 px-3 font-medium">Status</th>
                          <th className="text-left py-2 px-3 font-medium">Requested</th>
                          <th className="text-right py-2 px-3 font-medium">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map(r => {
                          const meta = leaveStatusMeta(r.status);
                          const bal = balanceLine(r);
                          return (
                            <tr key={r.id} className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3] align-top">
                              <td className="py-2 px-3">
                                <div className="font-bold">{r.full_name || <span className="text-[#8B7355] font-normal">—</span>}</div>
                                {r.employee_code && (
                                  <div className="text-[10px] font-mono text-[#8B7355]">{r.employee_code}</div>
                                )}
                              </td>
                              <td className="py-2 px-3 text-xs whitespace-nowrap">
                                {r.leave_type_name || <span className="text-[#8B7355]">—</span>}
                                {r.leave_type_is_paid === 0 && (
                                  <span className="ml-1 text-[10px] text-[#8B7355]">(unpaid)</span>
                                )}
                              </td>
                              <td className="py-2 px-3 text-xs whitespace-nowrap">
                                {fmtISTDate(r.from_date)}
                                {r.to_date !== r.from_date && <> &ndash; {fmtISTDate(r.to_date)}</>}
                                {r.reason && (
                                  <div className="text-[10px] text-[#8B7355] max-w-[220px] truncate" title={r.reason}>
                                    {r.reason}
                                  </div>
                                )}
                              </td>
                              <td className="py-2 px-3 text-right whitespace-nowrap">
                                {fmtDays(r.days)}
                                {Number(r.days) === 0.5 && (
                                  <div className="text-[10px] text-[#8B7355]">half day</div>
                                )}
                              </td>
                              <td className="py-2 px-3 text-xs whitespace-nowrap">
                                {bal || <span className="text-[#8B7355]">—</span>}
                              </td>
                              <td className="py-2 px-3">
                                <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border ${meta.color}`}>
                                  {meta.label}
                                </span>
                                {r.status !== 'pending' && r.reviewed_by && (
                                  <div className="text-[10px] text-[#8B7355] mt-0.5 max-w-[200px] truncate"
                                       title={r.review_reason || undefined}>
                                    {r.reviewed_by}{r.review_reason ? ` — ${r.review_reason}` : ''}
                                  </div>
                                )}
                              </td>
                              <td className="py-2 px-3 text-xs whitespace-nowrap">
                                {fmtIST(r.created_at)}
                                {r.requested_by && (
                                  <div className="text-[10px] text-[#8B7355]">{r.requested_by}</div>
                                )}
                              </td>
                              <td className="py-2 px-3 text-right whitespace-nowrap">
                                {r.status === 'pending' ? (
                                  <div className="inline-flex items-center gap-1.5">
                                    <button onClick={() => openDecision('approve', r)}
                                            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-green-200 bg-green-50 text-green-700 text-xs font-medium hover:bg-green-100">
                                      <Check className="w-3.5 h-3.5" /> Approve
                                    </button>
                                    <button onClick={() => openDecision('reject', r)}
                                            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-rose-200 bg-rose-50 text-rose-700 text-xs font-medium hover:bg-rose-100">
                                      <Ban className="w-3.5 h-3.5" /> Reject
                                    </button>
                                    <button onClick={() => openDecision('cancel', r)}
                                            title="Cancel this pending request"
                                            className="px-2 py-1 rounded-lg border border-[#E8D5C4] bg-white text-[#6B5744] text-xs font-medium hover:bg-[#FFF1E3]">
                                      Cancel
                                    </button>
                                  </div>
                                ) : (
                                  <span className="text-[#8B7355] text-xs">—</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="px-3 py-2 border-t border-[#E8D5C4] flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs text-[#8B7355]">Showing {fromN}&ndash;{toN} of {total}</span>
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

        {/* ══════════════════ Apply ══════════════════ */}
        {tab === 'apply' && (
          <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-5 max-w-2xl space-y-4">
            <div>
              <h2 className="font-bold text-[#2D1B0E]">File leave on behalf of an employee</h2>
              <p className="text-xs text-[#8B7355] mt-0.5">
                The request lands in the pending queue for an admin decision. Balances and overlaps
                are checked when it is filed and again at approval.
              </p>
            </div>

            {applySuccess && (
              <div className="rounded-lg border border-green-200 bg-green-50 text-green-700 px-3 py-2 text-sm">
                {applySuccess}
              </div>
            )}
            {applyError && (
              <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
                {applyError}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-[#6B5744]">Employee *</label>
                <Combobox
                  options={employeeOptions}
                  value={selectedEmployee?.full_name || ''}
                  onChange={(v) => setApplyForm(f => ({ ...f, employee_id: v }))}
                  placeholder="Pick employee"
                />
              </div>
              <div>
                <label className="text-xs text-[#6B5744]">Leave type *</label>
                <Combobox
                  options={typeOptions}
                  value={selectedType?.name || ''}
                  onChange={(v) => setApplyForm(f => ({ ...f, leave_type_id: v }))}
                  placeholder={activeTypes.length ? 'Pick leave type' : 'No active leave types yet'}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-[#6B5744]">From *</label>
                <input type="date" value={applyForm.from_date}
                       onChange={e => setFromDate(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className="text-xs text-[#6B5744]">To *</label>
                <input type="date" value={applyForm.to_date} disabled={applyForm.half_day}
                       onChange={e => setApplyForm(f => ({ ...f, to_date: e.target.value }))}
                       className={`${inputCls} ${applyForm.half_day ? 'opacity-60' : ''}`} />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Toggle checked={applyForm.half_day} onChange={setHalfDay} label="Half day" size="sm" />
                <span className="text-sm text-[#6B5744]">Half day</span>
              </div>
              <div className="text-sm text-[#6B5744]">
                Days:{' '}
                <span className="font-bold text-[#2D1B0E]">
                  {applyDays > 0 ? fmtDays(applyDays) : '—'}
                </span>
                {applyForm.half_day && applyDays > 0 && (
                  <span className="text-xs text-[#8B7355]"> (half day)</span>
                )}
              </div>
            </div>
            {!applyForm.half_day && isYmd(applyForm.from_date) && isYmd(applyForm.to_date) && applyDays === 0 && (
              <p className="text-xs text-red-600">The to date is before the from date.</p>
            )}

            <div>
              <label className="text-xs text-[#6B5744]">Reason</label>
              <textarea value={applyForm.reason} rows={3}
                        onChange={e => setApplyForm(f => ({ ...f, reason: e.target.value }))}
                        placeholder="Why is the leave needed?" className={inputCls} />
            </div>

            <div className="flex justify-end">
              <button onClick={submitApply} disabled={applying}
                      className="inline-flex items-center gap-2 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium disabled:opacity-50">
                {applying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                File Request
              </button>
            </div>
          </div>
        )}

        {/* ══════════════════ Types ══════════════════ */}
        {tab === 'types' && (
          <>
            {typesError && (
              <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm flex items-center justify-between gap-3">
                <span>{typesError}</span>
                <button onClick={() => fetchTypes()}
                        className="shrink-0 px-3 py-1.5 border border-red-200 rounded-lg text-xs font-medium hover:bg-red-100">
                  Retry
                </button>
              </div>
            )}

            <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
              {typesLoading ? (
                <div className="p-6 flex items-center justify-center gap-2 text-[#8B7355] text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading...
                </div>
              ) : types.length === 0 ? (
                <div className="p-6 text-center text-[#8B7355] text-sm">
                  No leave types yet — add the first one (e.g. Casual Leave).
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                      <tr>
                        <th className="text-left py-2 px-3 font-medium">Name</th>
                        <th className="text-right py-2 px-3 font-medium">Entitlement (days/yr)</th>
                        <th className="text-right py-2 px-3 font-medium">Carry-forward max</th>
                        <th className="text-left py-2 px-3 font-medium">Encashable</th>
                        <th className="text-right py-2 px-3 font-medium">Max consecutive</th>
                        <th className="text-left py-2 px-3 font-medium">Paid</th>
                        <th className="text-left py-2 px-3 font-medium">Status</th>
                        <th className="text-right py-2 px-3 font-medium">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {types.map(t => (
                        <tr key={t.id}
                            className={`border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3] ${t.is_active ? '' : 'opacity-60'}`}>
                          <td className="py-2 px-3 font-bold">{t.name}</td>
                          <td className="py-2 px-3 text-right">{fmtDays(t.annual_entitlement)}</td>
                          <td className="py-2 px-3 text-right">{fmtDays(t.carry_forward_max)}</td>
                          <td className="py-2 px-3 text-xs">
                            {t.encashable === 1 ? 'Yes' : <span className="text-[#8B7355]">No</span>}
                          </td>
                          <td className="py-2 px-3 text-right">
                            {t.max_consecutive_days > 0
                              ? t.max_consecutive_days
                              : <span className="text-[#8B7355] text-xs">no cap</span>}
                          </td>
                          <td className="py-2 px-3 text-xs">
                            {t.is_paid === 1 ? 'Paid' : <span className="text-[#8B7355]">Unpaid</span>}
                          </td>
                          <td className="py-2 px-3">
                            <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border ${
                              t.is_active
                                ? 'bg-green-100 text-green-700 border-green-200'
                                : 'bg-slate-100 text-slate-600 border-slate-200'
                            }`}>
                              {t.is_active ? 'Active' : 'Inactive'}
                            </span>
                          </td>
                          <td className="py-2 px-3 text-right whitespace-nowrap">
                            <div className="inline-flex items-center gap-1.5">
                              <button onClick={() => openTypeEdit(t)}
                                      className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-[#E8D5C4] bg-white text-[#6B5744] text-xs font-medium hover:bg-[#FFF1E3]">
                                <Pencil className="w-3.5 h-3.5" /> Edit
                              </button>
                              {t.is_active === 1 ? (
                                <button onClick={() => deactivateType(t)} disabled={typeBusyId === t.id}
                                        title="Existing balances and requests keep the label"
                                        className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-rose-200 bg-rose-50 text-rose-700 text-xs font-medium hover:bg-rose-100 disabled:opacity-50">
                                  {typeBusyId === t.id
                                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    : <Ban className="w-3.5 h-3.5" />} Deactivate
                                </button>
                              ) : (
                                <button onClick={() => reactivateType(t)} disabled={typeBusyId === t.id}
                                        className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-green-200 bg-green-50 text-green-700 text-xs font-medium hover:bg-green-100 disabled:opacity-50">
                                  {typeBusyId === t.id
                                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    : <RotateCcw className="w-3.5 h-3.5" />} Reactivate
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <p className="text-[11px] text-[#8B7355]">
              Entitlement seeds an employee&apos;s yearly balance the first time it is used — later
              edits apply to new balance rows only. Deactivating hides a type from pickers; history
              keeps the label. Leave-type changes are admin-only.
            </p>
          </>
        )}

        {/* ══════════════════ Decision modal ══════════════════ */}
        {decide && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
            <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
                 className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-md shadow-xl flex flex-col overflow-hidden">
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E]">{DECISION_COPY[decide.mode].title}</h2>
                <button onClick={() => { if (!deciding) setDecide(null); }} className="text-[#8B7355]">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
                {decideError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
                    {decideError}
                  </div>
                )}

                <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-3 text-sm space-y-1">
                  <div className="font-bold">
                    {decide.row.full_name || '—'}
                    {decide.row.employee_code && (
                      <span className="ml-2 text-[10px] font-mono font-normal text-[#8B7355]">
                        {decide.row.employee_code}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-[#6B5744]">
                    {decide.row.leave_type_name || 'Leave'}
                    {decide.row.leave_type_is_paid === 0 && ' (unpaid)'} &middot;{' '}
                    {fmtISTDate(decide.row.from_date)}
                    {decide.row.to_date !== decide.row.from_date && <> &ndash; {fmtISTDate(decide.row.to_date)}</>}
                    {' '}&middot; {fmtDays(decide.row.days)} day{Number(decide.row.days) === 1 ? '' : 's'}
                  </div>
                  {decide.row.reason && (
                    <div className="text-xs text-[#8B7355]">&ldquo;{decide.row.reason}&rdquo;</div>
                  )}
                  {balanceLine(decide.row) && (
                    <div className="text-xs font-medium text-[#af4408]">{balanceLine(decide.row)}</div>
                  )}
                </div>

                {decideRowBalances.length > 0 && (
                  <div>
                    <div className="text-xs font-semibold text-[#8B7355] uppercase tracking-wide mb-1.5">
                      Balances this year
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {decideRowBalances.map(b => (
                        <span key={b.leave_type_id}
                              className="inline-flex px-2 py-0.5 rounded-full text-[11px] border border-[#E8D5C4] bg-white text-[#6B5744]">
                          {b.leave_type_name} {fmtDays(b.available)} of {fmtDays(b.entitled + b.adjusted)} left
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <label className="text-xs text-[#6B5744]">
                    Note {DECISION_COPY[decide.mode].noteRequired ? '(required) *' : '(optional)'}
                  </label>
                  <textarea value={note} rows={3} onChange={e => setNote(e.target.value)}
                            placeholder={
                              decide.mode === 'approve'
                                ? 'Why is this approved? e.g. covered by roster'
                                : decide.mode === 'reject'
                                  ? 'Why is this rejected?'
                                  : 'Why is this being cancelled?'
                            }
                            className={inputCls} autoFocus />
                </div>
              </div>

              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
                <button onClick={() => setDecide(null)} disabled={deciding}
                        className="px-3 py-2 text-sm text-[#6B5744] disabled:opacity-50">
                  Close
                </button>
                <button onClick={submitDecision} disabled={deciding}
                        className={`px-3 py-2 text-sm text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50 ${
                          decide.mode === 'approve'
                            ? 'bg-green-600 hover:bg-green-700'
                            : decide.mode === 'reject'
                              ? 'bg-rose-600 hover:bg-rose-700'
                              : 'bg-[#af4408] hover:bg-[#8a3506]'
                        }`}>
                  {deciding
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : decide.mode === 'approve'
                      ? <Check className="w-4 h-4" />
                      : <Ban className="w-4 h-4" />}
                  {DECISION_COPY[decide.mode].verb}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ══════════════════ Type modal ══════════════════ */}
        {typeModal && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
            <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
                 className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-md shadow-xl flex flex-col overflow-hidden">
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E]">
                  {typeModal.id ? 'Edit Leave Type' : 'Add Leave Type'}
                </h2>
                <button onClick={() => { if (!typeSaving) setTypeModal(null); }} className="text-[#8B7355]">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
                {typeError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
                    {typeError}
                  </div>
                )}

                <div>
                  <label className="text-xs text-[#6B5744]">Name *</label>
                  <input value={typeForm.name}
                         onChange={e => setTypeForm({ ...typeForm, name: e.target.value })}
                         placeholder="e.g. Casual Leave" className={inputCls} autoFocus />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-[#6B5744]">Annual entitlement (days)</label>
                    <input type="number" min={0} step={0.5} value={typeForm.annual_entitlement}
                           onChange={e => setTypeForm({ ...typeForm, annual_entitlement: e.target.value })}
                           placeholder="e.g. 12" className={inputCls} />
                  </div>
                  <div>
                    <label className="text-xs text-[#6B5744]">Carry-forward max (days)</label>
                    <input type="number" min={0} step={0.5} value={typeForm.carry_forward_max}
                           onChange={e => setTypeForm({ ...typeForm, carry_forward_max: e.target.value })}
                           placeholder="0 = none" className={inputCls} />
                  </div>
                </div>

                <div>
                  <label className="text-xs text-[#6B5744]">Max consecutive days</label>
                  <input type="number" min={0} step={1} value={typeForm.max_consecutive_days}
                         onChange={e => setTypeForm({ ...typeForm, max_consecutive_days: e.target.value })}
                         placeholder="0 = no cap" className={inputCls} />
                </div>

                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm text-[#2D1B0E] font-medium">Encashable</div>
                    <div className="text-[11px] text-[#8B7355]">Unused days can be paid out</div>
                  </div>
                  <Toggle checked={typeForm.encashable} label="Encashable"
                          onChange={v => setTypeForm({ ...typeForm, encashable: v })} />
                </div>

                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm text-[#2D1B0E] font-medium">Paid leave</div>
                    <div className="text-[11px] text-[#8B7355]">
                      Unpaid types still record days taken but never block on balance
                    </div>
                  </div>
                  <Toggle checked={typeForm.is_paid} label="Paid leave"
                          onChange={v => setTypeForm({ ...typeForm, is_paid: v })} />
                </div>
              </div>

              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
                <button onClick={() => setTypeModal(null)} disabled={typeSaving}
                        className="px-3 py-2 text-sm text-[#6B5744] disabled:opacity-50">
                  Cancel
                </button>
                <button onClick={saveType} disabled={typeSaving}
                        className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
                  {typeSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
