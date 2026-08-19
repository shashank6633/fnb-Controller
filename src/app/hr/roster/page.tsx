'use client';

/**
 * HR — Roster (Phase 3, mgmtOnly via page-catalog; the API is the boundary).
 *
 * Contract: docs/HRMS_DECISIONS.md. Two tabs (TabScroller):
 *  · Week Grid — employees down, 7 IST days across (prev/next week nav).
 *    Each cell shows the assigned shift chip (name + IST times, "+1d" for
 *    overnight spans) or '—'. Clicking a cell opens the house modal with a
 *    PORTALED shift Combobox → POST /api/hr/roster upsert (one shift per
 *    employee per day; UNIQUE(employee_id, date) server-side). "Copy last
 *    week" reads the previous week's rows and bulk-POSTs them shifted +7
 *    days in ONE all-or-nothing transaction. Department filter matches the
 *    employee's MAIN department OR sub-department (the employee-list rule).
 *  · Shift Requests — pending queue with Approve / Reject + review note.
 *    Decisions are ADMIN-only (canAdminHr — hidden here for UX, re-checked
 *    by PATCH server-side); approval writes the roster row in the same
 *    transaction, so the grid refetches after a decision. Management can
 *    also log a request on an employee's behalf (no self-service yet, §8.3).
 *
 * Backend mapping rules honoured throughout: employee_id is ALWAYS
 * hr_employees.id, shift_id → hr_shifts.id, actor columns are me.email
 * (stamped server-side); joined names come from the API's LEFT JOINs, so a
 * dangling id renders as a blank/unknown label, never a dropped row.
 *
 * Structure copied from the Phase 1/2 pages (src/app/hr/employees/page.tsx,
 * src/app/hr/attendance/page.tsx): race-guarded fetches, house filter card,
 * house safe-modal shell, portaled Combobox, tables in overflow-x-auto.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Loader2,
  X,
  Save,
  Copy,
  Trash2,
  Plus,
  CheckCircle2,
  XCircle,
  ClipboardList,
} from 'lucide-react';
import { apiJson } from '@/lib/api';
import { fmtISTDate, fmtISTShort, todayIST } from '@/lib/format-date';
import Combobox, { type ComboOption } from '@/components/Combobox';
import TabScroller from '@/components/TabScroller';
import {
  canAdminHr,
  shiftRequestStatusMeta,
  type HrRoster,
  type HrShift,
  type HrShiftRequest,
} from '@/lib/hr';
import type { SessionUser } from '@/lib/auth';

const EMP_PAGE_SIZE = 100;
/** Hard stop for the employee loader: 5 pages = 500 people, far beyond the venue. */
const MAX_EMP_PAGES = 5;
const REQ_PAGE_SIZE = 25;
/** Server bulk cap (mirrors MAX_BULK_ASSIGNMENTS in the route). */
const MAX_BULK = 1000;

/* ------------------------------------------------------------------ *
 * Row shapes (defensive: the API LEFT JOINs, so every joined column
 * may be null when the referenced row is gone)
 * ------------------------------------------------------------------ */

interface DeptRow { id: string; name: string; parent_id: string | null; is_active: number }

/** GET /api/hr/employees list row — only the fields this grid needs. */
interface EmpRow {
  id: string;
  full_name: string;
  employee_code: string;
  status: string;
}

/** GET /api/hr/roster row (hr_rosters + LEFT JOIN employee + shift). */
interface RosterRow extends HrRoster {
  employee_name: string | null;
  employee_code: string | null;
  shift_name: string | null;
  shift_start_hhmm: string | null;
  shift_end_hhmm: string | null;
  shift_split_json: string | null;
  shift_is_active: number | null;
}

/** GET /api/hr/roster?requests=1 row (hr_shift_requests + LEFT JOINs). */
interface RequestRow extends HrShiftRequest {
  employee_name: string | null;
  employee_code: string | null;
  swap_with_name: string | null;
  swap_with_code: string | null;
  requested_shift_name: string | null;
  requested_shift_start_hhmm: string | null;
  requested_shift_end_hhmm: string | null;
}

/* ------------------------------------------------------------------ *
 * Pure date helpers — ALL arithmetic stays in YYYY-MM-DD string space
 * via UTC so the browser's zone can never shift an IST business date.
 * ------------------------------------------------------------------ */

/** date + n days (YYYY-MM-DD in, YYYY-MM-DD out). */
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Monday of the week containing the given IST date. */
function mondayOf(date: string): string {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((day + 6) % 7));
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** 'Mon' for a YYYY-MM-DD string (string-space, no TZ involved). */
function weekdayOf(date: string): string {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

/** '18 Aug' for a YYYY-MM-DD string. */
function dayMonthOf(date: string): string {
  return `${parseInt(date.slice(8, 10), 10)} ${MONTHS[parseInt(date.slice(5, 7), 10) - 1] || ''}`;
}

/** '09:00–18:00', with ' +1d' appended for overnight spans (end < start). */
function timeLabel(start: string | null | undefined, end: string | null | undefined): string {
  if (!start || !end) return '';
  return `${start}–${end}${end < start ? ' +1d' : ''}`;
}

/** True when split_json holds at least one extra window. */
function hasSplit(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) && v.length > 0;
  } catch {
    return false;
  }
}

/** Exited employees hold history but take no NEW roster rows (the API's rule). */
const EXITED = new Set(['resigned', 'terminated', 'former']);

/** Map thrown fetch errors to venue-friendly copy (server messages are generic). */
function niceErr(e: unknown, fallback: string): string {
  const msg = e instanceof Error ? e.message : '';
  if (/403|forbidden/i.test(msg)) return 'You do not have permission for this action.';
  if (/401|unauthor/i.test(msg)) return 'Your session has expired — sign in again.';
  return msg && !/^HTTP \d+$/.test(msg) ? msg : fallback;
}

type TabKey = 'grid' | 'requests';

const inputCls = 'w-full px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm';

export default function HrRosterPage() {
  const [tab, setTab] = useState<TabKey>('grid');

  // Who am I — request Approve/Reject render only for admins (the PATCH
  // re-checks server-side; hiding is UX, not the boundary).
  const [me, setMe] = useState<SessionUser | null>(null);
  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(j => setMe(j?.user || null))
      .catch(() => {});
  }, []);
  const isAdmin = canAdminHr(me);

  /* ── Shared picker data ────────────────────────────────────────────── */
  const [departments, setDepartments] = useState<DeptRow[]>([]);
  const [shifts, setShifts] = useState<HrShift[]>([]);
  const [deptId, setDeptId] = useState(''); // '' = all departments

  useEffect(() => {
    fetch('/api/departments')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(j => setDepartments(Array.isArray(j?.departments) ? j.departments : []))
      .catch(() => {});
    // include_inactive so chips for since-deactivated shifts still resolve.
    fetch('/api/hr/shifts?include_inactive=1')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(j => setShifts(Array.isArray(j?.shifts) ? j.shifts : []))
      .catch(() => {});
  }, []);

  const shiftById = useMemo(() => new Map(shifts.map(s => [s.id, s])), [shifts]);

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
  const deptFilterLabel = deptId ? (deptById.get(deptId)?.name || '') : '';

  /* ── Week grid state ───────────────────────────────────────────────── */
  const [weekStart, setWeekStart] = useState(() => mondayOf(todayIST()));
  const [employees, setEmployees] = useState<EmpRow[]>([]);
  const [rosterRows, setRosterRows] = useState<RosterRow[]>([]);
  const [gridLoading, setGridLoading] = useState(true);   // first paint only
  const [gridFetching, setGridFetching] = useState(false); // any in-flight fetch
  const [gridError, setGridError] = useState<string | null>(null);
  const gridSeq = useRef(0);

  const weekEnd = addDays(weekStart, 6);
  const weekDates = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const thisMonday = mondayOf(todayIST());
  const today = todayIST();

  const fetchGrid = useCallback(async () => {
    const seq = ++gridSeq.current;
    setGridFetching(true);
    setGridError(null);
    try {
      // Employees (all pages up to the cap) + the week's roster, in parallel.
      const loadEmployees = async (): Promise<EmpRow[]> => {
        const out: EmpRow[] = [];
        let total = Infinity;
        for (let p = 1; p <= MAX_EMP_PAGES && out.length < total; p++) {
          const sp = new URLSearchParams({ page: String(p), pageSize: String(EMP_PAGE_SIZE) });
          if (deptId) sp.set('department_id', deptId);
          const res = await fetch(`/api/hr/employees?${sp.toString()}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const json = await res.json();
          const rows: EmpRow[] = Array.isArray(json?.rows) ? json.rows : [];
          out.push(...rows);
          total = Number(json?.total) || 0;
          if (rows.length === 0) break;
        }
        return out;
      };
      const loadRoster = async (): Promise<RosterRow[]> => {
        const sp = new URLSearchParams({ from: weekStart, to: addDays(weekStart, 6) });
        if (deptId) sp.set('department_id', deptId);
        const res = await fetch(`/api/hr/roster?${sp.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        return Array.isArray(json?.rows) ? json.rows : [];
      };

      const [emps, roster] = await Promise.all([loadEmployees(), loadRoster()]);
      if (seq !== gridSeq.current) return; // a newer fetch superseded this one
      setEmployees(emps);
      setRosterRows(roster);
    } catch (e) {
      if (seq !== gridSeq.current) return;
      const msg = e instanceof Error ? e.message : '';
      setGridError(/401|403/.test(msg)
        ? 'You need management access to view the roster.'
        : "Couldn't load the roster");
    } finally {
      if (seq === gridSeq.current) { setGridFetching(false); setGridLoading(false); }
    }
  }, [weekStart, deptId]);

  useEffect(() => { fetchGrid(); }, [fetchGrid]);

  /** `${employee_id}|${date}` → roster row. */
  const rosterByKey = useMemo(() => {
    const m = new Map<string, RosterRow>();
    for (const r of rosterRows) m.set(`${r.employee_id}|${r.date}`, r);
    return m;
  }, [rosterRows]);

  /** Grid rows: every non-exited employee, PLUS anyone the week's roster
   *  references who fell outside the list (exited since, or beyond the page
   *  cap) — an existing assignment must never vanish from the grid. */
  const gridEmployees = useMemo(() => {
    const base = employees.filter(e => !EXITED.has(e.status));
    const known = new Set(base.map(e => e.id));
    const extras = new Map<string, EmpRow>();
    for (const r of rosterRows) {
      if (!known.has(r.employee_id) && !extras.has(r.employee_id)) {
        extras.set(r.employee_id, {
          id: r.employee_id,
          full_name: r.employee_name || 'Unknown employee',
          employee_code: r.employee_code || '',
          status: '',
        });
      }
    }
    return [...base, ...extras.values()].sort((a, b) => a.full_name.localeCompare(b.full_name));
  }, [employees, rosterRows]);

  /** Non-exited employees only — feeds the request-modal pickers. */
  const activeEmployees = useMemo(
    () => employees.filter(e => !EXITED.has(e.status)),
    [employees],
  );
  const activeEmpIds = useMemo(() => new Set(activeEmployees.map(e => e.id)), [activeEmployees]);

  /* ── Cell shift-picker modal ───────────────────────────────────────── */
  const [picker, setPicker] = useState<{
    empId: string; empName: string; date: string; existing: RosterRow | null;
  } | null>(null);
  const [pickShiftId, setPickShiftId] = useState('');
  const [pickNote, setPickNote] = useState('');
  const [pickSaving, setPickSaving] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);

  const openCell = (emp: EmpRow, date: string) => {
    const existing = rosterByKey.get(`${emp.id}|${date}`) ?? null;
    setPicker({ empId: emp.id, empName: emp.full_name, date, existing });
    setPickShiftId(existing?.shift_id ?? '');
    setPickNote(existing?.note ?? '');
    setPickError(null);
  };

  /** Active shifts (+ the cell's current shift even if since-deactivated, so
   *  re-saving a day never silently drops its label). */
  const pickerShiftOptions = useMemo<ComboOption[]>(() => {
    const opts: ComboOption[] = shifts
      .filter(s => s.is_active === 1)
      .map(s => ({ value: s.id, label: s.name, hint: timeLabel(s.start_hhmm, s.end_hhmm) }));
    if (pickShiftId && !opts.some(o => o.value === pickShiftId)) {
      const cur = shiftById.get(pickShiftId);
      opts.push({
        value: pickShiftId,
        label: cur ? cur.name : 'Unknown shift',
        hint: cur ? `${timeLabel(cur.start_hhmm, cur.end_hhmm)} · inactive` : undefined,
      });
    }
    return opts;
  }, [shifts, shiftById, pickShiftId]);
  const pickShiftLabel = pickShiftId
    ? (pickerShiftOptions.find(o => o.value === pickShiftId)?.label || '')
    : '';

  const savePick = async () => {
    if (!picker) return;
    if (!pickShiftId) { setPickError('Pick a shift first.'); return; }
    setPickSaving(true);
    setPickError(null);
    try {
      await apiJson('/api/hr/roster', {
        method: 'POST',
        body: { employee_id: picker.empId, date: picker.date, shift_id: pickShiftId, note: pickNote.trim() },
      });
      setPicker(null);
      fetchGrid();
    } catch (e) {
      setPickError(niceErr(e, 'Could not save the assignment'));
    } finally {
      setPickSaving(false);
    }
  };

  const removePick = async () => {
    if (!picker?.existing) return;
    if (!window.confirm(`Remove ${picker.empName}'s shift on ${fmtISTDate(picker.date)}?`)) return;
    setPickSaving(true);
    setPickError(null);
    try {
      await apiJson(
        `/api/hr/roster?employee_id=${encodeURIComponent(picker.empId)}&date=${encodeURIComponent(picker.date)}`,
        { method: 'DELETE' },
      );
      setPicker(null);
      fetchGrid();
    } catch (e) {
      setPickError(niceErr(e, 'Could not remove the assignment'));
    } finally {
      setPickSaving(false);
    }
  };

  /* ── Copy last week ────────────────────────────────────────────────── */
  const [copying, setCopying] = useState(false);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);
  useEffect(() => { setCopyMsg(null); }, [weekStart, deptId]);

  const copyLastWeek = async () => {
    setCopying(true);
    setCopyMsg(null);
    setGridError(null);
    try {
      const sp = new URLSearchParams({ from: addDays(weekStart, -7), to: addDays(weekStart, -1) });
      if (deptId) sp.set('department_id', deptId);
      const res = await fetch(`/api/hr/roster?${sp.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const prev: RosterRow[] = Array.isArray(json?.rows) ? json.rows : [];

      // The bulk POST is all-or-nothing and validates every ref — filter out
      // rows the server would reject (exited/unknown employees, dangling
      // shifts) so one stale row can't sink the whole copy.
      const assignments = prev
        .filter(r => activeEmpIds.has(r.employee_id) && shiftById.has(r.shift_id))
        .map(r => ({
          employee_id: r.employee_id,
          date: addDays(r.date, 7),
          shift_id: r.shift_id,
          note: r.note || '',
        }));
      const skipped = prev.length - assignments.length;

      if (assignments.length === 0) {
        setCopyMsg(prev.length === 0
          ? 'Last week has no roster to copy.'
          : 'Nothing copyable — last week\'s rows all belong to exited employees or removed shifts.');
        return;
      }
      if (assignments.length > MAX_BULK) {
        setCopyMsg(`Too many assignments to copy at once (max ${MAX_BULK}).`);
        return;
      }
      if (!window.confirm(
        `Copy ${assignments.length} assignment${assignments.length === 1 ? '' : 's'} from last week into ` +
        `${fmtISTDate(weekStart)} – ${fmtISTDate(weekEnd)}? Existing shifts on those days will be replaced.`,
      )) return;

      await apiJson('/api/hr/roster', { method: 'POST', body: { assignments } });
      setCopyMsg(
        `Copied ${assignments.length} assignment${assignments.length === 1 ? '' : 's'} from last week.` +
        (skipped > 0 ? ` ${skipped} skipped (exited employee or removed shift).` : ''),
      );
      fetchGrid();
    } catch (e) {
      setGridError(niceErr(e, 'Could not copy last week'));
    } finally {
      setCopying(false);
    }
  };

  /* ── Shift-requests tab state ──────────────────────────────────────── */
  const [reqRows, setReqRows] = useState<RequestRow[]>([]);
  const [reqTotal, setReqTotal] = useState(0);
  const [reqPage, setReqPage] = useState(1);
  const [reqStatus, setReqStatus] = useState('pending'); // '' = all
  const [reqLoading, setReqLoading] = useState(true);
  const [reqError, setReqError] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const reqSeq = useRef(0);

  useEffect(() => { setReqPage(1); }, [reqStatus]);

  const refreshPendingCount = useCallback(() => {
    fetch('/api/hr/roster?requests=1&status=pending&pageSize=1')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(j => setPendingCount(Number(j?.total) || 0))
      .catch(() => {});
  }, []);
  useEffect(() => { refreshPendingCount(); }, [refreshPendingCount]);

  const fetchRequests = useCallback(async () => {
    const seq = ++reqSeq.current;
    setReqError(null);
    try {
      const sp = new URLSearchParams({
        requests: '1', page: String(reqPage), pageSize: String(REQ_PAGE_SIZE),
      });
      if (reqStatus) sp.set('status', reqStatus);
      const res = await fetch(`/api/hr/roster?${sp.toString()}`);
      if (seq !== reqSeq.current) return;
      if (!res.ok) {
        setReqError(res.status === 401 || res.status === 403
          ? 'You need management access to view shift requests.'
          : "Couldn't load shift requests");
        return;
      }
      const json = await res.json();
      if (seq !== reqSeq.current) return;
      setReqRows(Array.isArray(json?.rows) ? json.rows : []);
      setReqTotal(Number(json?.total) || 0);
      if (reqStatus === 'pending') setPendingCount(Number(json?.total) || 0);
    } catch {
      if (seq === reqSeq.current) setReqError("Couldn't load shift requests");
    } finally {
      if (seq === reqSeq.current) setReqLoading(false);
    }
  }, [reqPage, reqStatus]);

  useEffect(() => {
    if (tab === 'requests') fetchRequests();
  }, [tab, fetchRequests]);

  /* ── Decision modal (admin) ────────────────────────────────────────── */
  const [decideReq, setDecideReq] = useState<RequestRow | null>(null);
  const [decideNote, setDecideNote] = useState('');
  const [deciding, setDeciding] = useState<'approve' | 'reject' | null>(null);
  const [decideError, setDecideError] = useState<string | null>(null);

  const openDecide = (r: RequestRow) => {
    setDecideReq(r);
    setDecideNote('');
    setDecideError(null);
  };

  const decide = async (action: 'approve' | 'reject') => {
    if (!decideReq) return;
    setDeciding(action);
    setDecideError(null);
    try {
      await apiJson('/api/hr/roster', {
        method: 'PATCH',
        body: { id: decideReq.id, action, review_reason: decideNote.trim() },
      });
      setDecideReq(null);
      fetchRequests();
      refreshPendingCount();
      // Approval writes the roster row in the same transaction — keep the
      // grid honest without waiting for a tab switch.
      if (action === 'approve') fetchGrid();
    } catch (e) {
      setDecideError(niceErr(e, 'Could not decide the request'));
    } finally {
      setDeciding(null);
    }
  };

  /* ── New-request modal (management logs on an employee's behalf) ───── */
  const [showNewReq, setShowNewReq] = useState(false);
  const [nrForm, setNrForm] = useState({
    employee_id: '', date: '', requested_shift_id: '', swap_with_employee_id: '', reason: '',
  });
  const [nrSaving, setNrSaving] = useState(false);
  const [nrError, setNrError] = useState<string | null>(null);

  const openNewReq = () => {
    setNrForm({ employee_id: '', date: todayIST(), requested_shift_id: '', swap_with_employee_id: '', reason: '' });
    setNrError(null);
    setShowNewReq(true);
  };

  const empOptions = useMemo<ComboOption[]>(
    () => activeEmployees
      .slice()
      .sort((a, b) => a.full_name.localeCompare(b.full_name))
      .map(e => ({ value: e.id, label: e.full_name, hint: e.employee_code })),
    [activeEmployees],
  );
  const swapOptions = useMemo<ComboOption[]>(
    () => [{ value: '', label: '(none — plain change)' }, ...empOptions.filter(o => o.value !== nrForm.employee_id)],
    [empOptions, nrForm.employee_id],
  );
  const activeShiftOptions = useMemo<ComboOption[]>(
    () => shifts
      .filter(s => s.is_active === 1)
      .map(s => ({ value: s.id, label: s.name, hint: timeLabel(s.start_hhmm, s.end_hhmm) })),
    [shifts],
  );
  const nrEmpLabel = empOptions.find(o => o.value === nrForm.employee_id)?.label || '';
  const nrSwapLabel = nrForm.swap_with_employee_id
    ? (empOptions.find(o => o.value === nrForm.swap_with_employee_id)?.label || '')
    : '';
  const nrShiftLabel = activeShiftOptions.find(o => o.value === nrForm.requested_shift_id)?.label || '';

  const saveNewReq = async () => {
    if (!nrForm.employee_id) { setNrError('Pick the employee.'); return; }
    if (!nrForm.date) { setNrError('Pick the date.'); return; }
    if (!nrForm.requested_shift_id) { setNrError('Pick the requested shift.'); return; }
    setNrSaving(true);
    setNrError(null);
    try {
      await apiJson('/api/hr/roster?requests=1', {
        method: 'POST',
        body: {
          employee_id: nrForm.employee_id,
          date: nrForm.date,
          requested_shift_id: nrForm.requested_shift_id,
          swap_with_employee_id: nrForm.swap_with_employee_id,
          reason: nrForm.reason.trim(),
        },
      });
      setShowNewReq(false);
      setReqStatus('pending');
      fetchRequests();
      refreshPendingCount();
    } catch (e) {
      setNrError(niceErr(e, 'Could not log the request'));
    } finally {
      setNrSaving(false);
    }
  };

  /* ── Derived ───────────────────────────────────────────────────────── */
  const reqPageCount = Math.max(1, Math.ceil(reqTotal / REQ_PAGE_SIZE));
  const reqFromN = reqTotal === 0 ? 0 : (reqPage - 1) * REQ_PAGE_SIZE + 1;
  const reqToN = Math.min(reqPage * REQ_PAGE_SIZE, reqTotal);

  const pill = (active: boolean) =>
    `px-3 py-1.5 rounded-full text-xs font-medium border ${
      active
        ? 'bg-[#af4408] text-white border-[#af4408]'
        : 'bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]'
    }`;

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">

        {/* Header */}
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-2">
            <CalendarRange className="w-6 h-6" /> Roster
          </h1>
          <p className="text-[#8B7355] text-sm mt-1">
            Weekly shift grid on IST dates — one shift per employee per day. Click any cell to
            assign or change a shift.
          </p>
        </div>

        {/* Tabs */}
        <TabScroller className="gap-2">
          <button onClick={() => setTab('grid')} className={pill(tab === 'grid')}>Week Grid</button>
          <button onClick={() => setTab('requests')} className={pill(tab === 'requests')}>
            Shift Requests{pendingCount ? ` (${pendingCount})` : ''}
          </button>
        </TabScroller>

        {/* ═══════════════ Week grid tab ═══════════════ */}
        {tab === 'grid' && (
          <>
            {/* Week nav + filters */}
            <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-3 flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-1">
                <button onClick={() => setWeekStart(addDays(weekStart, -7))}
                        aria-label="Previous week"
                        className="p-2 rounded-lg border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744]">
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <div className="px-2 text-sm font-medium min-w-[13rem] text-center">
                  {fmtISTDate(weekStart)} – {fmtISTDate(weekEnd)}
                </div>
                <button onClick={() => setWeekStart(addDays(weekStart, 7))}
                        aria-label="Next week"
                        className="p-2 rounded-lg border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744]">
                  <ChevronRight className="w-4 h-4" />
                </button>
                {weekStart !== thisMonday && (
                  <button onClick={() => setWeekStart(thisMonday)}
                          className="ml-1 px-2.5 py-1.5 rounded-lg border border-[#E8D5C4] hover:bg-[#FFF1E3] text-xs text-[#6B5744]">
                    This week
                  </button>
                )}
              </div>
              <div className="w-56">
                <Combobox options={deptFilterOptions} value={deptFilterLabel}
                          onChange={(v) => setDeptId(v)} placeholder="All departments" />
              </div>
              <div className="flex-1" />
              <button onClick={copyLastWeek} disabled={copying || gridFetching}
                      className="inline-flex items-center gap-2 px-3 py-2 border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm disabled:opacity-50">
                {copying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Copy className="w-4 h-4" />}
                Copy last week
              </button>
            </div>

            {copyMsg && (
              <div className="rounded-lg border border-green-200 bg-green-50 text-green-700 px-3 py-2 text-sm">
                {copyMsg}
              </div>
            )}

            {gridError && (
              <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm flex items-center justify-between gap-3">
                <span>{gridError}</span>
                <button onClick={fetchGrid} className="underline shrink-0">Retry</button>
              </div>
            )}

            {/* The grid */}
            <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
              {gridLoading ? (
                <div className="flex items-center justify-center py-16 text-[#8B7355]">
                  <Loader2 className="w-6 h-6 animate-spin" />
                </div>
              ) : gridEmployees.length === 0 ? (
                <p className="text-sm text-[#8B7355] px-4 py-10 text-center">
                  {deptId ? 'No employees in this department.' : 'No employees yet — add them on the Employees page first.'}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-[880px]">
                    <thead className="bg-[#FFF1E3]">
                      <tr>
                        <th className="text-left px-3 py-2 font-semibold sticky left-0 bg-[#FFF1E3] z-10 min-w-[11rem]">
                          Employee
                        </th>
                        {weekDates.map(d => (
                          <th key={d}
                              className={`text-center px-2 py-2 font-semibold min-w-[6.5rem] ${
                                d === today ? 'text-[#af4408]' : ''
                              }`}>
                            <div>{weekdayOf(d)}</div>
                            <div className={`text-[11px] font-normal ${d === today ? 'text-[#af4408]' : 'text-[#8B7355]'}`}>
                              {dayMonthOf(d)}
                            </div>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {gridEmployees.map(emp => (
                        <tr key={emp.id} className="border-t border-[#F3E7D9]">
                          <td className="px-3 py-2 sticky left-0 bg-white z-10 align-top">
                            <div className="font-medium leading-tight">{emp.full_name}</div>
                            {emp.employee_code && (
                              <div className="text-[11px] text-[#8B7355]">{emp.employee_code}</div>
                            )}
                          </td>
                          {weekDates.map(d => {
                            const cell = rosterByKey.get(`${emp.id}|${d}`);
                            return (
                              <td key={d} className={`p-1 align-top ${d === today ? 'bg-[#FFF8F0]' : ''}`}>
                                <button
                                  onClick={() => openCell(emp, d)}
                                  title={cell?.note ? `Note: ${cell.note}` : 'Assign shift'}
                                  className="w-full min-h-[3rem] rounded-lg px-1.5 py-1.5 text-center hover:bg-[#FFF1E3] focus:outline-none focus:ring-1 focus:ring-[#af4408]/40">
                                  {cell ? (
                                    <span className={`inline-flex flex-col items-center gap-0.5 ${cell.shift_is_active === 0 ? 'opacity-60' : ''}`}>
                                      <span className="inline-block max-w-[9rem] truncate px-2 py-0.5 rounded-full border border-[#E8D5C4] bg-[#FFF1E3] text-[#af4408] text-xs font-medium">
                                        {cell.shift_name || 'Unknown shift'}
                                      </span>
                                      <span className="text-[10px] text-[#8B7355]">
                                        {timeLabel(cell.shift_start_hhmm, cell.shift_end_hhmm)}
                                        {hasSplit(cell.shift_split_json) ? ' · split' : ''}
                                        {cell.note ? ' ✎' : ''}
                                      </span>
                                    </span>
                                  ) : (
                                    <span className="text-[#C9B8A5]">—</span>
                                  )}
                                </button>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <p className="text-[11px] text-[#8B7355]">
              Times are IST clock times; “+1d” marks an overnight shift ending the next calendar
              morning — the whole shift still belongs to the start day’s attendance.
            </p>
          </>
        )}

        {/* ═══════════════ Shift-requests tab ═══════════════ */}
        {tab === 'requests' && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <TabScroller className="gap-2 flex-1">
                {[
                  { k: 'pending', label: 'Pending' },
                  { k: 'approved', label: 'Approved' },
                  { k: 'rejected', label: 'Rejected' },
                  { k: '', label: 'All' },
                ].map(s => (
                  <button key={s.k || 'all'} onClick={() => setReqStatus(s.k)}
                          className={pill(reqStatus === s.k)}>
                    {s.label}
                  </button>
                ))}
              </TabScroller>
              <button onClick={openNewReq}
                      className="inline-flex items-center gap-2 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium">
                <Plus className="w-4 h-4" /> Log request
              </button>
            </div>

            {reqError && (
              <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm flex items-center justify-between gap-3">
                <span>{reqError}</span>
                <button onClick={fetchRequests} className="underline shrink-0">Retry</button>
              </div>
            )}

            <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
              {reqLoading ? (
                <div className="flex items-center justify-center py-16 text-[#8B7355]">
                  <Loader2 className="w-6 h-6 animate-spin" />
                </div>
              ) : reqRows.length === 0 ? (
                <p className="text-sm text-[#8B7355] px-4 py-10 text-center">
                  {reqStatus === 'pending' ? 'No pending shift requests.' : 'No shift requests here yet.'}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-[860px]">
                    <thead className="bg-[#FFF1E3]">
                      <tr>
                        <th className="text-left px-3 py-2 font-semibold">Employee</th>
                        <th className="text-left px-3 py-2 font-semibold">Date</th>
                        <th className="text-left px-3 py-2 font-semibold">Requested shift</th>
                        <th className="text-left px-3 py-2 font-semibold">Swap with</th>
                        <th className="text-left px-3 py-2 font-semibold">Reason</th>
                        <th className="text-left px-3 py-2 font-semibold">Status</th>
                        <th className="text-left px-3 py-2 font-semibold">Logged</th>
                        <th className="text-right px-3 py-2 font-semibold">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reqRows.map(r => {
                        const meta = shiftRequestStatusMeta(r.status);
                        return (
                          <tr key={r.id} className="border-t border-[#F3E7D9] align-top">
                            <td className="px-3 py-2">
                              <div className="font-medium leading-tight">{r.employee_name || 'Unknown employee'}</div>
                              {r.employee_code && <div className="text-[11px] text-[#8B7355]">{r.employee_code}</div>}
                            </td>
                            <td className="px-3 py-2 whitespace-nowrap">{fmtISTDate(r.date)}</td>
                            <td className="px-3 py-2">
                              <div>{r.requested_shift_name || 'Unknown shift'}</div>
                              <div className="text-[11px] text-[#8B7355]">
                                {timeLabel(r.requested_shift_start_hhmm, r.requested_shift_end_hhmm)}
                              </div>
                            </td>
                            <td className="px-3 py-2">
                              {r.swap_with_employee_id
                                ? (r.swap_with_name || 'Unknown employee')
                                : <span className="text-[#C9B8A5]">—</span>}
                            </td>
                            <td className="px-3 py-2 max-w-[16rem]">
                              <span className="break-words">{r.reason || <span className="text-[#C9B8A5]">—</span>}</span>
                            </td>
                            <td className="px-3 py-2">
                              <span className={`inline-block px-2 py-0.5 rounded-full border text-xs font-medium ${meta.color}`}>
                                {meta.label}
                              </span>
                              {r.status !== 'pending' && r.reviewed_by && (
                                <div className="text-[11px] text-[#8B7355] mt-1">
                                  by {r.reviewed_by}
                                  {r.review_reason ? ` — ${r.review_reason}` : ''}
                                </div>
                              )}
                            </td>
                            <td className="px-3 py-2 whitespace-nowrap text-[#6B5744]">
                              <div>{fmtISTShort(r.created_at)}</div>
                              {r.requested_by && <div className="text-[11px] text-[#8B7355]">{r.requested_by}</div>}
                            </td>
                            <td className="px-3 py-2 text-right">
                              {r.status === 'pending' ? (
                                isAdmin ? (
                                  <button onClick={() => openDecide(r)}
                                          className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-[#E8D5C4] hover:bg-[#FFF1E3] rounded-lg text-xs text-[#6B5744]">
                                    <ClipboardList className="w-3.5 h-3.5" /> Review
                                  </button>
                                ) : (
                                  <span className="text-[11px] text-[#8B7355]">Admin decides</span>
                                )
                              ) : (
                                <span className="text-[#C9B8A5]">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Pagination */}
              {reqTotal > REQ_PAGE_SIZE && (
                <div className="px-3 py-2 border-t border-[#E8D5C4] flex items-center justify-between text-sm text-[#6B5744]">
                  <span>{reqFromN}–{reqToN} of {reqTotal}</span>
                  <div className="flex items-center gap-1">
                    <button onClick={() => setReqPage(p => Math.max(1, p - 1))} disabled={reqPage <= 1}
                            className="p-1.5 rounded-lg border border-[#E8D5C4] hover:bg-[#FFF1E3] disabled:opacity-40">
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <span className="px-2">{reqPage} / {reqPageCount}</span>
                    <button onClick={() => setReqPage(p => Math.min(reqPageCount, p + 1))} disabled={reqPage >= reqPageCount}
                            className="p-1.5 rounded-lg border border-[#E8D5C4] hover:bg-[#FFF1E3] disabled:opacity-40">
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {/* ── Cell shift-picker modal ─────────────────────────────────── */}
        {picker && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
            <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
                 className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-md shadow-xl flex flex-col overflow-hidden">
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E]">
                  {picker.existing ? 'Change shift' : 'Assign shift'} — {picker.empName}
                </h2>
                <button onClick={() => { if (!pickSaving) setPicker(null); }} className="text-[#8B7355]">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
                {pickError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
                    {pickError}
                  </div>
                )}
                <p className="text-sm text-[#6B5744]">
                  {weekdayOf(picker.date)}, {fmtISTDate(picker.date)}
                </p>
                <div>
                  <label className="text-xs text-[#6B5744]">Shift *</label>
                  <Combobox options={pickerShiftOptions} value={pickShiftLabel}
                            onChange={(v) => setPickShiftId(v)} placeholder="Pick a shift…" />
                  {activeShiftOptions.length === 0 && (
                    <p className="text-[11px] text-[#8B7355] mt-1">
                      No active shift templates yet — create them on the Shifts page first.
                    </p>
                  )}
                </div>
                <div>
                  <label className="text-xs text-[#6B5744]">Note (optional)</label>
                  <input type="text" value={pickNote} maxLength={200}
                         onChange={e => setPickNote(e.target.value)}
                         placeholder="e.g. covering for Ramesh"
                         className={inputCls} />
                </div>
              </div>
              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-between gap-2 shrink-0">
                <div>
                  {picker.existing && (
                    <button onClick={removePick} disabled={pickSaving}
                            className="inline-flex items-center gap-1 px-3 py-2 text-sm text-rose-600 hover:bg-rose-50 rounded-lg disabled:opacity-50">
                      <Trash2 className="w-4 h-4" /> Remove
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => setPicker(null)} disabled={pickSaving}
                          className="px-3 py-2 text-sm text-[#6B5744] disabled:opacity-50">
                    Cancel
                  </button>
                  <button onClick={savePick} disabled={pickSaving}
                          className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
                    {pickSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Decision modal (admin) ──────────────────────────────────── */}
        {decideReq && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
            <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
                 className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-md shadow-xl flex flex-col overflow-hidden">
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E]">Review shift request</h2>
                <button onClick={() => { if (!deciding) setDecideReq(null); }} className="text-[#8B7355]">
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
                  <div>
                    <span className="font-medium">{decideReq.employee_name || 'Unknown employee'}</span>
                    {decideReq.employee_code && (
                      <span className="text-[#8B7355] text-xs"> · {decideReq.employee_code}</span>
                    )}
                  </div>
                  <div className="text-[#6B5744]">
                    {weekdayOf(decideReq.date)}, {fmtISTDate(decideReq.date)} →{' '}
                    <span className="font-medium">{decideReq.requested_shift_name || 'Unknown shift'}</span>{' '}
                    <span className="text-[#8B7355]">
                      {timeLabel(decideReq.requested_shift_start_hhmm, decideReq.requested_shift_end_hhmm)}
                    </span>
                  </div>
                  {decideReq.swap_with_employee_id && (
                    <div className="text-[#6B5744]">
                      Swap with <span className="font-medium">{decideReq.swap_with_name || 'Unknown employee'}</span>
                      {' '}— on approval they receive the requester&apos;s current shift for that day.
                    </div>
                  )}
                  {decideReq.reason && (
                    <div className="text-[#6B5744]">Reason: {decideReq.reason}</div>
                  )}
                </div>
                <div>
                  <label className="text-xs text-[#6B5744]">Review note (optional)</label>
                  <textarea value={decideNote} rows={2} maxLength={300}
                            onChange={e => setDecideNote(e.target.value)}
                            placeholder="Why this decision…"
                            className={inputCls} />
                </div>
                <p className="text-[11px] text-[#8B7355]">
                  Approving writes the roster for that day immediately. A decided request cannot be
                  re-decided.
                </p>
              </div>
              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
                <button onClick={() => setDecideReq(null)} disabled={!!deciding}
                        className="px-3 py-2 text-sm text-[#6B5744] disabled:opacity-50">
                  Cancel
                </button>
                <button onClick={() => decide('reject')} disabled={!!deciding}
                        className="px-3 py-2 text-sm bg-rose-600 hover:bg-rose-700 text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
                  {deciding === 'reject' ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />} Reject
                </button>
                <button onClick={() => decide('approve')} disabled={!!deciding}
                        className="px-3 py-2 text-sm bg-green-600 hover:bg-green-700 text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
                  {deciding === 'approve' ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Approve
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── New-request modal ───────────────────────────────────────── */}
        {showNewReq && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
            <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
                 className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-md shadow-xl flex flex-col overflow-hidden">
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E]">Log shift request</h2>
                <button onClick={() => { if (!nrSaving) setShowNewReq(false); }} className="text-[#8B7355]">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
                {nrError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
                    {nrError}
                  </div>
                )}
                <div>
                  <label className="text-xs text-[#6B5744]">Employee *</label>
                  <Combobox options={empOptions} value={nrEmpLabel}
                            onChange={(v) => setNrForm(f => ({
                              ...f,
                              employee_id: v,
                              swap_with_employee_id: f.swap_with_employee_id === v ? '' : f.swap_with_employee_id,
                            }))}
                            placeholder="Pick the employee…" />
                  {deptId && (
                    <p className="text-[11px] text-[#8B7355] mt-1">
                      Showing employees from the department filtered on the grid.
                    </p>
                  )}
                </div>
                <div>
                  <label className="text-xs text-[#6B5744]">Date *</label>
                  <input type="date" value={nrForm.date}
                         onChange={e => setNrForm(f => ({ ...f, date: e.target.value }))}
                         className={inputCls} />
                </div>
                <div>
                  <label className="text-xs text-[#6B5744]">Requested shift *</label>
                  <Combobox options={activeShiftOptions} value={nrShiftLabel}
                            onChange={(v) => setNrForm(f => ({ ...f, requested_shift_id: v }))}
                            placeholder="Pick a shift…" />
                </div>
                <div>
                  <label className="text-xs text-[#6B5744]">Swap with (optional)</label>
                  <Combobox options={swapOptions} value={nrSwapLabel}
                            onChange={(v) => setNrForm(f => ({ ...f, swap_with_employee_id: v }))}
                            placeholder="(none — plain change)" />
                </div>
                <div>
                  <label className="text-xs text-[#6B5744]">Reason (optional)</label>
                  <textarea value={nrForm.reason} rows={2} maxLength={300}
                            onChange={e => setNrForm(f => ({ ...f, reason: e.target.value }))}
                            placeholder="Why the change is needed…"
                            className={inputCls} />
                </div>
                <p className="text-[11px] text-[#8B7355]">
                  One pending request per employee per day. Approval (admin) applies the shift to the
                  roster automatically.
                </p>
              </div>
              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
                <button onClick={() => setShowNewReq(false)} disabled={nrSaving}
                        className="px-3 py-2 text-sm text-[#6B5744] disabled:opacity-50">
                  Cancel
                </button>
                <button onClick={saveNewReq} disabled={nrSaving}
                        className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
                  {nrSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Log request
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
