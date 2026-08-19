'use client';

/**
 * HR — Attendance (Phase 2, mgmtOnly via page-catalog; the APIs are the boundary).
 *
 * Contract: docs/HRMS_DECISIONS.md §8.2/§8.5. Three tabs:
 *  · Register — the daily attendance register, one row per active employee on
 *    the BUSINESS day (IST after the hr_day_cutoff — a 1 AM checkout belongs
 *    to yesterday; the API stamps and defaults this, the page never derives
 *    days itself). Server-paginated against GET /api/hr/attendance. A manual
 *    punch per row POSTs through the same recordAttendanceEvent chokepoint
 *    every provider uses (source 'manual', reason REQUIRED).
 *  · Timeline — one employee's chronological punch log for a day, INCLUDING
 *    debounce-ignored rows (greyed, with their reason): the audit-trail view
 *    for disputes. Corrections are REQUESTED here (variance_approvals
 *    pattern), never written directly — approval appends manual events.
 *  · Corrections — the pending queue; Approve/Reject are admin-only
 *    (canAdminHr) with a required review note.
 *
 * Structure copied from the Phase 1 list page (src/app/hr/employees/page.tsx):
 * race-guarded fetches, house filter card, house safe-modal shell, portaled
 * Combobox for dropdowns near/inside overflow containers.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarClock,
  Search,
  X,
  Loader2,
  Save,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
  History,
  Plus,
  Trash2,
  Fingerprint,
  CheckCircle2,
  XCircle,
  FilePen,
} from 'lucide-react';
import { apiJson } from '@/lib/api';
import { fmtIST, fmtISTDate, fmtISTShort, fmtISTTime } from '@/lib/format-date';
import Combobox, { type ComboOption } from '@/components/Combobox';
import TabScroller from '@/components/TabScroller';
import {
  attendanceStatusMeta,
  eventSourceMeta,
  canAdminHr,
  type HrAttendanceEvent,
  type HrAttendanceSummary,
  type HrAttendanceCorrection,
} from '@/lib/hr';
import type { SessionUser } from '@/lib/auth';

const PAGE_SIZE = 25;

/* ------------------------------------------------------------------ *
 * Row shapes (defensive: the register is a LEFT JOIN, so every summary
 * column may be null for a NOT_CHECKED_IN employee)
 * ------------------------------------------------------------------ */

interface RegisterRow {
  /** Some projections ship the employee id as `id`, others as `employee_id`. */
  id?: string;
  employee_id?: string;
  employee_code: string;
  full_name: string;
  department_name?: string | null;
  status?: string | null;
  first_in?: string | null;
  last_out?: string | null;
  sessions?: number | null;
  worked_minutes?: number | null;
  break_minutes?: number | null;
  missing_checkout?: number | null;
  corrected?: number | null;
}

interface DeptRow {
  id: string;
  name: string;
  parent_id: string | null;
  is_active: number;
}

interface DetailEmployee {
  id: string;
  full_name: string;
  employee_code: string;
  department_name?: string | null;
}

interface DetailResp {
  employee: DetailEmployee | null;
  summary: HrAttendanceSummary | null;
  events: HrAttendanceEvent[];
}

interface CorrectionRow extends HrAttendanceCorrection {
  employee_name?: string | null;
  employee_code?: string | null;
}

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

const empIdOf = (r: RegisterRow): string => String(r.employee_id ?? r.id ?? '');

/** Minutes → "h:mm" (720 → "12:00", 210 → "3:30"). Server stores minutes. */
function fmtHM(min: number | null | undefined): string {
  const m = Math.max(0, Math.round(Number(min) || 0));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * <input type="datetime-local"> gives LOCAL wall time ("2026-08-19T14:30").
 * The attendance APIs (and hr_attendance_events.at) speak UTC — convert via
 * the browser's own zone (IST for the venue) to 'YYYY-MM-DD HH:MM:SS'.
 * Returns null when unparseable.
 */
function localInputToUtc(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

const EVENT_TYPE_LABELS: Record<string, string> = {
  check_in: 'Check-in',
  check_out: 'Check-out',
  break_start: 'Break start',
  break_end: 'Break end',
  outside_detected: 'Outside detected',
  outside_confirmed: 'Outside confirmed',
  returned: 'Returned',
};

const evTypeLabel = (t: string | null | undefined): string =>
  EVENT_TYPE_LABELS[String(t ?? '')] ?? (String(t ?? '') || '—');

const CORR_STATUS_META: Record<string, { label: string; color: string }> = {
  pending: { label: 'Pending', color: 'bg-amber-100 text-amber-800 border-amber-200' },
  approved: { label: 'Approved', color: 'bg-green-100 text-green-700 border-green-200' },
  rejected: { label: 'Rejected', color: 'bg-rose-100 text-rose-700 border-rose-200' },
};

/** Parse requested_json defensively (string or object; {events:[…]} or bare array). */
function parseRequestedEvents(raw: unknown): { event_type?: string; at?: string; reason?: string }[] {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const list = Array.isArray(v) ? v : Array.isArray((v as { events?: unknown[] })?.events)
      ? (v as { events: unknown[] }).events
      : [];
    return list.filter((e): e is { event_type?: string; at?: string; reason?: string } =>
      !!e && typeof e === 'object');
  } catch {
    return [];
  }
}

/** Map thrown fetch errors to venue-friendly copy (server messages are generic). */
function niceErr(e: unknown, fallback: string): string {
  const msg = e instanceof Error ? e.message : '';
  if (/403|forbidden/i.test(msg)) return 'You do not have permission for this action.';
  if (/401|unauthor/i.test(msg)) return 'Your session has expired — sign in again.';
  return msg && !/^HTTP \d+$/.test(msg) ? msg : fallback;
}

type TabKey = 'register' | 'timeline' | 'corrections';

const inputCls = 'w-full px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm';

export default function HrAttendancePage() {
  const [tab, setTab] = useState<TabKey>('register');

  // Who am I — corrections Approve/Reject render only for admins (the PATCH
  // re-checks server-side; hiding is UX, not the boundary).
  const [me, setMe] = useState<SessionUser | null>(null);
  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(j => setMe(j?.user || null))
      .catch(() => {});
  }, []);
  const isAdmin = canAdminHr(me);

  /* ── Register state ────────────────────────────────────────────────── */
  const [rows, setRows] = useState<RegisterRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');
  const [deptId, setDeptId] = useState('');
  /** '' until the API answers — the server owns "today's business date". */
  const [date, setDate] = useState('');
  const [departments, setDepartments] = useState<DeptRow[]>([]);
  const fetchSeq = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setQ(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => { setPage(1); }, [q, deptId, date]);

  useEffect(() => {
    fetch('/api/departments')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(j => setDepartments(Array.isArray(j?.departments) ? j.departments : []))
      .catch(() => {});
  }, []);

  const buildQuery = useCallback((p: number) => {
    const sp = new URLSearchParams();
    if (date) sp.set('date', date);
    if (q) sp.set('q', q);
    if (deptId) sp.set('department_id', deptId);
    sp.set('page', String(p));
    sp.set('pageSize', String(PAGE_SIZE));
    return sp.toString();
  }, [date, q, deptId]);

  const fetchRegister = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setFetching(true);
    setError(null);
    try {
      const res = await fetch(`/api/hr/attendance?${buildQuery(page)}`);
      if (seq !== fetchSeq.current) return;
      if (!res.ok) {
        setError(res.status === 401 || res.status === 403
          ? 'You need management access to view attendance.'
          : "Couldn't load the attendance register");
        return;
      }
      const json = await res.json();
      if (seq !== fetchSeq.current) return;
      setRows(Array.isArray(json?.rows) ? json.rows : []);
      setTotal(Number(json?.total) || 0);
      // First load carries no date — adopt the server's current BUSINESS date
      // (never the browser's calendar date: at 1 AM they differ by design).
      if (!date && typeof json?.date === 'string' && json.date) setDate(json.date);
    } catch {
      if (seq === fetchSeq.current) setError("Couldn't load the attendance register");
    } finally {
      if (seq === fetchSeq.current) { setFetching(false); setLoading(false); }
    }
  }, [buildQuery, page, date]);

  useEffect(() => { fetchRegister(); }, [fetchRegister]);

  const mains = useMemo(
    () => departments.filter(d => !d.parent_id && d.is_active).sort((a, b) => a.name.localeCompare(b.name)),
    [departments],
  );
  const deptById = useMemo(() => new Map(departments.map(d => [d.id, d])), [departments]);
  const deptFilterOptions = useMemo<ComboOption[]>(() => {
    const opts: ComboOption[] = [{ value: '', label: 'All departments' }];
    for (const m of mains) {
      opts.push({ value: m.id, label: m.name });
      for (const s of departments
        .filter(d => d.parent_id === m.id && d.is_active)
        .sort((a, b) => a.name.localeCompare(b.name))) {
        opts.push({ value: s.id, label: s.name, hint: m.name });
      }
    }
    return opts;
  }, [mains, departments]);

  /* ── Manual punch modal ────────────────────────────────────────────── */
  const [punchRow, setPunchRow] = useState<RegisterRow | null>(null);
  const [punchForm, setPunchForm] = useState({ event_type: 'check_in', at: '', reason: '' });
  const [punchSaving, setPunchSaving] = useState(false);
  const [punchError, setPunchError] = useState<string | null>(null);

  const openPunch = (r: RegisterRow) => {
    // Smart default: someone currently at work most likely needs an OUT.
    const dir = r.status === 'PRESENT' || r.status === 'ON_BREAK' ? 'check_out' : 'check_in';
    setPunchForm({ event_type: dir, at: '', reason: '' });
    setPunchError(null);
    setPunchRow(r);
  };

  /* ── Timeline state ────────────────────────────────────────────────── */
  const [selectedEmpId, setSelectedEmpId] = useState('');
  const [selectedEmpLabel, setSelectedEmpLabel] = useState('');
  const [detail, setDetail] = useState<DetailResp | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailRefresh, setDetailRefresh] = useState(0);
  const detailSeq = useRef(0);
  const [corrNotice, setCorrNotice] = useState<string | null>(null);

  const employeeOptions = useMemo<ComboOption[]>(() => {
    const seen = new Set<string>();
    const opts: ComboOption[] = [];
    for (const r of rows) {
      const id = empIdOf(r);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      opts.push({ value: id, label: r.full_name, hint: r.employee_code });
    }
    return opts;
  }, [rows]);

  useEffect(() => {
    if (!selectedEmpId) { setDetail(null); return; }
    const seq = ++detailSeq.current;
    setDetailLoading(true);
    setDetailError(null);
    const sp = new URLSearchParams();
    if (date) sp.set('date', date);
    fetch(`/api/hr/attendance/${encodeURIComponent(selectedEmpId)}?${sp.toString()}`)
      .then(async res => {
        if (seq !== detailSeq.current) return;
        if (!res.ok) {
          setDetailError(res.status === 401 || res.status === 403
            ? 'You need management access to view attendance.'
            : "Couldn't load this employee's timeline");
          setDetail(null);
          return;
        }
        const json = await res.json();
        if (seq !== detailSeq.current) return;
        setDetail({
          employee: json?.employee ?? null,
          summary: json?.summary ?? null,
          events: Array.isArray(json?.events) ? json.events : [],
        });
      })
      .catch(() => {
        if (seq === detailSeq.current) {
          setDetailError("Couldn't load this employee's timeline");
          setDetail(null);
        }
      })
      .finally(() => {
        if (seq === detailSeq.current) setDetailLoading(false);
      });
  }, [selectedEmpId, date, detailRefresh]);

  const openTimelineFor = (r: RegisterRow) => {
    setSelectedEmpId(empIdOf(r));
    setSelectedEmpLabel(r.full_name);
    setTab('timeline');
  };

  /* ── Correction request modal (Timeline tab) ───────────────────────── */
  const [showCorrModal, setShowCorrModal] = useState(false);
  const [corrDate, setCorrDate] = useState('');
  const [corrEvents, setCorrEvents] = useState<{ event_type: string; at: string }[]>([]);
  const [corrReason, setCorrReason] = useState('');
  const [corrSaving, setCorrSaving] = useState(false);
  const [corrError, setCorrError] = useState<string | null>(null);

  const openCorrModal = () => {
    if (!selectedEmpId) return;
    setCorrDate(date);
    setCorrEvents([{ event_type: 'check_out', at: '' }]);
    setCorrReason('');
    setCorrError(null);
    setShowCorrModal(true);
  };

  const submitCorrection = async () => {
    if (!selectedEmpId) return;
    if (!corrDate) { setCorrError('Pick the business date being corrected.'); return; }
    const reason = corrReason.trim();
    if (!reason) { setCorrError('A reason is required.'); return; }
    if (corrEvents.length === 0) { setCorrError('Add at least one event.'); return; }
    const events: { event_type: string; at: string }[] = [];
    for (const ev of corrEvents) {
      const at = localInputToUtc(ev.at);
      if (!at) { setCorrError('Every event needs a valid time.'); return; }
      events.push({ event_type: ev.event_type, at });
    }
    setCorrSaving(true);
    setCorrError(null);
    try {
      // requested_json is JSON TEXT (the hr_attendance_corrections column) —
      // the same {events:[{event_type, at}]} shape applyCorrection() parses.
      await apiJson('/api/hr/attendance/corrections', {
        method: 'POST',
        body: {
          employee_id: selectedEmpId,
          date: corrDate,
          requested_json: JSON.stringify({ events }),
          reason,
        },
      });
      setShowCorrModal(false);
      setCorrNotice('Correction request submitted — it appears in the Corrections tab until an admin decides it.');
      setTimeout(() => setCorrNotice(null), 6000);
      if (corrStatusFilter === 'pending' || corrStatusFilter === '') fetchCorrections();
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      setCorrError(/409/.test(msg)
        ? 'There is already a pending correction request for this employee and day.'
        : niceErr(e, 'Could not submit the correction request'));
    } finally {
      setCorrSaving(false);
    }
  };

  /* ── Corrections queue state ───────────────────────────────────────── */
  const [corrStatusFilter, setCorrStatusFilter] = useState('pending'); // '' = all
  const [corrections, setCorrections] = useState<CorrectionRow[]>([]);
  const [corrLoading, setCorrLoading] = useState(false);
  const [corrFetchError, setCorrFetchError] = useState<string | null>(null);
  const corrSeq = useRef(0);
  const [decision, setDecision] = useState<{ corr: CorrectionRow; action: 'approve' | 'reject' } | null>(null);
  const [decisionNote, setDecisionNote] = useState('');
  const [decisionSaving, setDecisionSaving] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  const fetchCorrections = useCallback(async () => {
    const seq = ++corrSeq.current;
    setCorrLoading(true);
    setCorrFetchError(null);
    try {
      const sp = corrStatusFilter ? `?status=${encodeURIComponent(corrStatusFilter)}` : '';
      const res = await fetch(`/api/hr/attendance/corrections${sp}`);
      if (seq !== corrSeq.current) return;
      if (!res.ok) {
        setCorrFetchError(res.status === 401 || res.status === 403
          ? 'You need management access to view corrections.'
          : "Couldn't load correction requests");
        return;
      }
      const json = await res.json();
      if (seq !== corrSeq.current) return;
      setCorrections(Array.isArray(json?.corrections) ? json.corrections : []);
    } catch {
      if (seq === corrSeq.current) setCorrFetchError("Couldn't load correction requests");
    } finally {
      if (seq === corrSeq.current) setCorrLoading(false);
    }
  }, [corrStatusFilter]);

  useEffect(() => {
    if (tab === 'corrections') fetchCorrections();
  }, [tab, fetchCorrections]);

  /** Fallback names for corrections whose API rows carry only employee_id. */
  const empNameById = useMemo(() => {
    const m = new Map<string, { name: string; code: string }>();
    for (const r of rows) {
      const id = empIdOf(r);
      if (id && !m.has(id)) m.set(id, { name: r.full_name, code: r.employee_code });
    }
    return m;
  }, [rows]);

  const corrEmployeeLabel = (c: CorrectionRow): string => {
    if (c.employee_name) return c.employee_name;
    const hit = empNameById.get(c.employee_id);
    if (hit) return hit.name;
    return c.employee_code || c.employee_id;
  };

  const submitDecision = async () => {
    if (!decision) return;
    const note = decisionNote.trim();
    if (!note) { setDecisionError('A review note is required.'); return; }
    setDecisionSaving(true);
    setDecisionError(null);
    try {
      await apiJson('/api/hr/attendance/corrections', {
        method: 'PATCH',
        body: { id: decision.corr.id, action: decision.action, review_reason: note },
      });
      const affected = decision.corr;
      setDecision(null);
      fetchCorrections();
      // An approval APPENDED manual events and recomputed the day — the
      // register and any open timeline for that employee are now stale.
      fetchRegister();
      if (selectedEmpId && selectedEmpId === affected.employee_id) setDetailRefresh(n => n + 1);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      setDecisionError(/403|forbidden/i.test(msg)
        ? 'Only admins can approve or reject correction requests.'
        : niceErr(e, 'Could not record the decision'));
    } finally {
      setDecisionSaving(false);
    }
  };

  /* ── Punch submit ──────────────────────────────────────────────────── */
  const submitPunch = async () => {
    if (!punchRow) return;
    const reason = punchForm.reason.trim();
    if (!reason) { setPunchError('A reason is required for manual punches.'); return; }
    let atUtc: string | null = null;
    if (punchForm.at) {
      atUtc = localInputToUtc(punchForm.at);
      if (!atUtc) { setPunchError('That time could not be read — pick it again.'); return; }
    }
    setPunchSaving(true);
    setPunchError(null);
    try {
      const body: Record<string, unknown> = {
        employee_id: empIdOf(punchRow),
        event_type: punchForm.event_type,
        reason,
      };
      if (atUtc) body.at = atUtc;
      await apiJson('/api/hr/attendance', { method: 'POST', body });
      const punchedId = empIdOf(punchRow);
      setPunchRow(null);
      fetchRegister();
      if (selectedEmpId && selectedEmpId === punchedId) setDetailRefresh(n => n + 1);
    } catch (e) {
      setPunchError(niceErr(e, 'Could not record the punch'));
    } finally {
      setPunchSaving(false);
    }
  };

  /* ── Derived ───────────────────────────────────────────────────────── */
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const fromN = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const toN = Math.min(page * PAGE_SIZE, total);
  const deptFilterLabel = deptId ? (deptById.get(deptId)?.name || '') : '';
  const summary = detail?.summary ?? null;
  const summaryMeta = summary ? attendanceStatusMeta(summary.status) : null;

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
            <CalendarClock className="w-6 h-6" /> Attendance
          </h1>
          <p className="text-[#8B7355] text-sm mt-1">
            Daily register on the business-day clock — punches after midnight up to the day
            cutoff belong to the previous day, so a split shift ending at 1&nbsp;AM stays one day.
          </p>
        </div>

        {/* Tabs */}
        <TabScroller className="gap-2">
          <button onClick={() => setTab('register')} className={pill(tab === 'register')}>Register</button>
          <button onClick={() => setTab('timeline')} className={pill(tab === 'timeline')}>Timeline</button>
          <button onClick={() => setTab('corrections')} className={pill(tab === 'corrections')}>Corrections</button>
        </TabScroller>

        {/* ══════════════ TAB 1 — REGISTER ══════════════ */}
        {tab === 'register' && (
          <>
            {/* Filters */}
            <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-3">
              <div className="flex flex-wrap items-center gap-3">
                <div>
                  <label className="text-xs text-[#6B5744] block">Business date</label>
                  <input type="date" value={date} onChange={e => setDate(e.target.value)}
                         className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
                </div>
                <div className="w-full sm:w-60">
                  <label className="text-xs text-[#6B5744] block">Department</label>
                  <Combobox
                    options={deptFilterOptions}
                    value={deptFilterLabel}
                    onChange={(v) => setDeptId(v)}
                    placeholder="All departments"
                  />
                </div>
                <div className="flex items-end gap-2 flex-1 min-w-[200px]">
                  <Search className="w-4 h-4 text-[#8B7355] mb-2.5" />
                  <div className="flex-1">
                    <label className="text-xs text-[#6B5744] block">Search</label>
                    <input value={searchInput} onChange={e => setSearchInput(e.target.value)}
                           placeholder="Name or code…" className={inputCls} />
                  </div>
                </div>
              </div>
            </div>

            {error && (
              <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm flex items-center justify-between gap-3">
                <span>{error}</span>
                <button onClick={() => fetchRegister()}
                        className="shrink-0 px-3 py-1.5 border border-red-200 rounded-lg text-xs font-medium hover:bg-red-100">
                  Retry
                </button>
              </div>
            )}

            {/* Register table */}
            <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
              {loading ? (
                <div className="p-6 flex items-center justify-center gap-2 text-[#8B7355] text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading...
                </div>
              ) : rows.length === 0 ? (
                <div className="p-6 text-center text-[#8B7355] text-sm">
                  {q || deptId ? 'No employees match these filters.' : 'No active employees for this day.'}
                </div>
              ) : (
                <>
                  <div className={`overflow-x-auto ${fetching ? 'opacity-60' : ''}`}>
                    <table className="w-full text-sm">
                      <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                        <tr>
                          <th className="text-left py-2 px-3 font-medium">Code</th>
                          <th className="text-left py-2 px-3 font-medium">Name</th>
                          <th className="text-left py-2 px-3 font-medium">Department</th>
                          <th className="text-left py-2 px-3 font-medium">Status</th>
                          <th className="text-left py-2 px-3 font-medium">First in</th>
                          <th className="text-left py-2 px-3 font-medium">Last out</th>
                          <th className="text-right py-2 px-3 font-medium">Sessions</th>
                          <th className="text-right py-2 px-3 font-medium">Worked</th>
                          <th className="text-right py-2 px-3 font-medium">Break</th>
                          <th className="py-2 px-2 font-medium"></th>
                          <th className="py-2 px-3 font-medium"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map(r => {
                          const meta = attendanceStatusMeta(r.status);
                          const key = empIdOf(r) || r.employee_code;
                          return (
                            <tr key={key} className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]">
                              <td className="py-2 px-3 text-xs font-mono whitespace-nowrap">{r.employee_code}</td>
                              <td className="py-2 px-3">
                                <button onClick={() => openTimelineFor(r)}
                                        title="Open punch timeline"
                                        className="font-bold text-[#2D1B0E] hover:text-[#af4408] hover:underline text-left">
                                  {r.full_name}
                                </button>
                              </td>
                              <td className="py-2 px-3 text-xs">
                                {r.department_name || <span className="text-[#8B7355]">—</span>}
                              </td>
                              <td className="py-2 px-3">
                                <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border ${meta.color}`}>
                                  {meta.label}
                                </span>
                              </td>
                              <td className="py-2 px-3 text-xs whitespace-nowrap">{fmtISTTime(r.first_in || '')}</td>
                              <td className="py-2 px-3 text-xs whitespace-nowrap">{fmtISTTime(r.last_out || '')}</td>
                              <td className="py-2 px-3 text-xs text-right">{Number(r.sessions) || 0}</td>
                              <td className="py-2 px-3 text-xs text-right font-mono">{fmtHM(r.worked_minutes)}</td>
                              <td className="py-2 px-3 text-xs text-right font-mono">{fmtHM(r.break_minutes)}</td>
                              <td className="py-2 px-2">
                                <span className="inline-flex items-center gap-1">
                                  {!!r.missing_checkout && (
                                    <AlertTriangle className="w-4 h-4 text-red-600" aria-label="Missing checkout" />
                                  )}
                                  {!!r.corrected && (
                                    <History className="w-3.5 h-3.5 text-blue-600" aria-label="Corrected" />
                                  )}
                                </span>
                              </td>
                              <td className="py-2 px-3 text-right">
                                <button onClick={() => openPunch(r)}
                                        className="inline-flex items-center gap-1 px-2 py-1 border border-[#E8D5C4] bg-white hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-xs font-medium whitespace-nowrap">
                                  <Fingerprint className="w-3.5 h-3.5" /> Manual punch
                                </button>
                              </td>
                            </tr>
                          );
                        })}
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

        {/* ══════════════ TAB 2 — TIMELINE ══════════════ */}
        {tab === 'timeline' && (
          <>
            {/* Selector */}
            <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-3">
              <div className="flex flex-wrap items-end gap-3">
                <div className="w-full sm:w-72">
                  <label className="text-xs text-[#6B5744] block">Employee</label>
                  <Combobox
                    options={employeeOptions}
                    value={selectedEmpLabel}
                    onChange={(v, opt) => { setSelectedEmpId(v); setSelectedEmpLabel(opt?.label || ''); }}
                    placeholder="Pick an employee"
                  />
                </div>
                <div>
                  <label className="text-xs text-[#6B5744] block">Business date</label>
                  <input type="date" value={date} onChange={e => setDate(e.target.value)}
                         className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
                </div>
                <div className="flex-1" />
                <button onClick={openCorrModal} disabled={!selectedEmpId}
                        className="inline-flex items-center gap-2 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium disabled:opacity-40">
                  <FilePen className="w-4 h-4" /> Request correction
                </button>
              </div>
              <p className="text-[11px] text-[#8B7355] mt-2">
                The employee picker lists the current register rows — adjust the Register tab&apos;s
                filters or page to reach someone not listed here.
              </p>
            </div>

            {corrNotice && (
              <div className="rounded-xl border border-green-200 bg-green-50 text-green-700 px-4 py-3 text-sm">
                {corrNotice}
              </div>
            )}

            {detailError && (
              <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm">
                {detailError}
              </div>
            )}

            {!selectedEmpId ? (
              <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-6 text-center text-[#8B7355] text-sm">
                Pick an employee to see their punch timeline — the audit-trail view for disputes.
              </div>
            ) : detailLoading && !detail ? (
              <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-6 flex items-center justify-center gap-2 text-[#8B7355] text-sm">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading...
              </div>
            ) : detail && (
              <>
                {/* Day summary */}
                <div className={`bg-white border border-[#E8D5C4] rounded-xl shadow p-4 ${detailLoading ? 'opacity-60' : ''}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                    <div>
                      <div className="font-bold text-[#2D1B0E]">
                        {detail.employee?.full_name || selectedEmpLabel}
                        {detail.employee?.employee_code && (
                          <span className="ml-2 text-xs font-mono text-[#8B7355]">{detail.employee.employee_code}</span>
                        )}
                      </div>
                      <div className="text-xs text-[#8B7355]">
                        {date ? fmtISTDate(date) : ''}
                        {detail.employee?.department_name ? ` · ${detail.employee.department_name}` : ''}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {summaryMeta && (
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border ${summaryMeta.color}`}>
                          {summaryMeta.label}
                        </span>
                      )}
                      {!!summary?.missing_checkout && (
                        <span className="inline-flex items-center gap-1 text-[11px] text-red-600 font-medium">
                          <AlertTriangle className="w-3.5 h-3.5" /> Missing checkout
                        </span>
                      )}
                      {!!summary?.corrected && (
                        <span className="inline-flex items-center gap-1 text-[11px] text-blue-600 font-medium">
                          <History className="w-3.5 h-3.5" /> Corrected
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
                    <div>
                      <div className="text-[11px] text-[#8B7355]">First in</div>
                      <div className="font-medium">{fmtISTShort(summary?.first_in || '')}</div>
                    </div>
                    <div>
                      <div className="text-[11px] text-[#8B7355]">Last out</div>
                      <div className="font-medium">{fmtISTShort(summary?.last_out || '')}</div>
                    </div>
                    <div>
                      <div className="text-[11px] text-[#8B7355]">Sessions</div>
                      <div className="font-medium">{Number(summary?.sessions) || 0}</div>
                    </div>
                    <div>
                      <div className="text-[11px] text-[#8B7355]">Worked (h:mm)</div>
                      <div className="font-medium font-mono">{fmtHM(summary?.worked_minutes)}</div>
                    </div>
                    <div>
                      <div className="text-[11px] text-[#8B7355]">Break (h:mm)</div>
                      <div className="font-medium font-mono">{fmtHM(summary?.break_minutes)}</div>
                    </div>
                  </div>
                </div>

                {/* Event log */}
                <div className={`bg-white border border-[#E8D5C4] rounded-xl shadow ${detailLoading ? 'opacity-60' : ''}`}>
                  <div className="px-4 py-3 border-b border-[#E8D5C4] text-sm font-bold text-[#2D1B0E]">
                    Punch log
                    <span className="ml-2 text-xs font-normal text-[#8B7355]">
                      append-only — ignored duplicates stay recorded
                    </span>
                  </div>
                  {detail.events.length === 0 ? (
                    <div className="p-6 text-center text-[#8B7355] text-sm">No punches on this day.</div>
                  ) : (
                    <div>
                      {detail.events.map(ev => {
                        const src = eventSourceMeta(ev.source);
                        return (
                          <div key={ev.id}
                               className={`px-4 py-2.5 border-t border-[#E8D5C4]/50 first:border-t-0 flex flex-wrap items-center gap-x-3 gap-y-1 ${ev.ignored ? 'opacity-60' : ''}`}>
                            <span className="text-xs font-mono whitespace-nowrap">{fmtIST(ev.at, { withTz: false })}</span>
                            <span className={`text-sm font-medium ${ev.ignored ? 'line-through' : ''}`}>
                              {evTypeLabel(ev.event_type)}
                            </span>
                            <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium border ${src.color}`}>
                              {src.label}
                            </span>
                            {ev.geofence_status && (
                              <span className="text-[11px] text-[#8B7355]">geofence: {ev.geofence_status}</span>
                            )}
                            {ev.created_by && (
                              <span className="text-[11px] text-[#8B7355]">by {ev.created_by}</span>
                            )}
                            {ev.reason && (
                              <span className="text-[11px] text-[#6B5744] italic">{ev.reason}</span>
                            )}
                            {!!ev.ignored && (
                              <span className="text-[11px] text-amber-700 basis-full sm:basis-auto">
                                Ignored{ev.ignored_reason ? ` — ${ev.ignored_reason}` : ''}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            )}
          </>
        )}

        {/* ══════════════ TAB 3 — CORRECTIONS ══════════════ */}
        {tab === 'corrections' && (
          <>
            <TabScroller className="gap-2">
              {[
                { k: 'pending', label: 'Pending' },
                { k: 'approved', label: 'Approved' },
                { k: 'rejected', label: 'Rejected' },
                { k: '', label: 'All' },
              ].map(s => (
                <button key={s.k || 'all'} onClick={() => setCorrStatusFilter(s.k)}
                        className={pill(corrStatusFilter === s.k)}>
                  {s.label}
                </button>
              ))}
            </TabScroller>

            {corrFetchError && (
              <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm flex items-center justify-between gap-3">
                <span>{corrFetchError}</span>
                <button onClick={() => fetchCorrections()}
                        className="shrink-0 px-3 py-1.5 border border-red-200 rounded-lg text-xs font-medium hover:bg-red-100">
                  Retry
                </button>
              </div>
            )}

            {corrLoading && corrections.length === 0 ? (
              <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-6 flex items-center justify-center gap-2 text-[#8B7355] text-sm">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading...
              </div>
            ) : corrections.length === 0 && !corrFetchError ? (
              <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-6 text-center text-[#8B7355] text-sm">
                {corrStatusFilter === 'pending'
                  ? 'No pending correction requests.'
                  : 'No correction requests here.'}
              </div>
            ) : (
              <div className={`space-y-3 ${corrLoading ? 'opacity-60' : ''}`}>
                {!isAdmin && corrStatusFilter === 'pending' && corrections.length > 0 && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 text-amber-800 px-4 py-3 text-sm">
                    Only admins can approve or reject correction requests — you can review them here.
                  </div>
                )}
                {corrections.map(c => {
                  const meta = CORR_STATUS_META[c.status] ?? {
                    label: c.status || '—',
                    color: 'bg-slate-100 text-slate-600 border-slate-200',
                  };
                  const reqEvents = parseRequestedEvents(c.requested_json);
                  return (
                    <div key={c.id} className="bg-white border border-[#E8D5C4] rounded-xl shadow p-4 space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <span className="font-bold text-[#2D1B0E]">{corrEmployeeLabel(c)}</span>
                          <span className="ml-2 text-xs text-[#8B7355]">{fmtISTDate(c.date)}</span>
                        </div>
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border ${meta.color}`}>
                          {meta.label}
                        </span>
                      </div>
                      <div className="text-sm text-[#6B5744]">{c.reason || <span className="text-[#8B7355]">No reason given.</span>}</div>
                      <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] px-3 py-2">
                        <div className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wide mb-1">
                          Requested events
                        </div>
                        {reqEvents.length === 0 ? (
                          <div className="text-xs text-[#8B7355]">Could not read the requested changes.</div>
                        ) : (
                          <ul className="space-y-0.5">
                            {reqEvents.map((ev, i) => (
                              <li key={i} className="text-xs flex flex-wrap items-center gap-2">
                                <span className="font-medium">{evTypeLabel(ev.event_type)}</span>
                                <span className="font-mono">{fmtIST(ev.at ?? '', { withTz: false })}</span>
                                {ev.reason && <span className="text-[#8B7355] italic">{ev.reason}</span>}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      <div className="text-[11px] text-[#8B7355]">
                        Requested by {c.requested_by || '—'} · {fmtIST(c.created_at, { withTz: false })}
                        {c.status !== 'pending' && c.reviewed_by && (
                          <> · {c.status === 'approved' ? 'Approved' : 'Reviewed'} by {c.reviewed_by}
                            {c.reviewed_at ? ` · ${fmtIST(c.reviewed_at, { withTz: false })}` : ''}</>
                        )}
                      </div>
                      {c.status !== 'pending' && c.review_reason && (
                        <div className="text-xs text-[#6B5744]">Review note: {c.review_reason}</div>
                      )}
                      {c.status === 'pending' && isAdmin && (
                        <div className="flex items-center gap-2 pt-1">
                          <button onClick={() => { setDecision({ corr: c, action: 'approve' }); setDecisionNote(''); setDecisionError(null); }}
                                  className="inline-flex items-center gap-1 px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded-lg text-xs font-medium">
                            <CheckCircle2 className="w-3.5 h-3.5" /> Approve
                          </button>
                          <button onClick={() => { setDecision({ corr: c, action: 'reject' }); setDecisionNote(''); setDecisionError(null); }}
                                  className="inline-flex items-center gap-1 px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-medium">
                            <XCircle className="w-3.5 h-3.5" /> Reject
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* ── Manual punch modal ─────────────────────────────────────────── */}
        {punchRow && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
            <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
                 className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-md shadow-xl flex flex-col overflow-hidden">
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E]">Manual punch — {punchRow.full_name}</h2>
                <button onClick={() => { if (!punchSaving) setPunchRow(null); }} className="text-[#8B7355]">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
                {punchError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
                    {punchError}
                  </div>
                )}
                <div>
                  <label className="text-xs text-[#6B5744]">Event type</label>
                  <select value={punchForm.event_type}
                          onChange={e => setPunchForm({ ...punchForm, event_type: e.target.value })}
                          className={inputCls}>
                    <option value="check_in">Check-in</option>
                    <option value="check_out">Check-out</option>
                  </select>
                  <p className="text-[11px] text-[#8B7355] mt-1">
                    Gate punches normally alternate automatically — picking a direction here
                    overrides pairing for this one event.
                  </p>
                </div>
                <div>
                  <label className="text-xs text-[#6B5744]">Time (optional)</label>
                  <input type="datetime-local" value={punchForm.at}
                         onChange={e => setPunchForm({ ...punchForm, at: e.target.value })}
                         className={inputCls} />
                  <p className="text-[11px] text-[#8B7355] mt-1">Leave empty to use the current time.</p>
                </div>
                <div>
                  <label className="text-xs text-[#6B5744]">Reason *</label>
                  <textarea value={punchForm.reason}
                            onChange={e => setPunchForm({ ...punchForm, reason: e.target.value })}
                            rows={2} placeholder="Why this punch is being entered by hand…"
                            className={inputCls} />
                </div>
                <p className="text-[11px] text-[#8B7355]">
                  Recorded as a <span className="font-medium">manual</span> event in the append-only
                  punch log under your name; the day&apos;s summary recomputes automatically.
                </p>
              </div>
              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
                <button onClick={() => setPunchRow(null)} disabled={punchSaving}
                        className="px-3 py-2 text-sm text-[#6B5744] disabled:opacity-50">
                  Cancel
                </button>
                <button onClick={submitPunch} disabled={punchSaving}
                        className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
                  {punchSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Record punch
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Request-correction modal ───────────────────────────────────── */}
        {showCorrModal && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
            <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
                 className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-lg shadow-xl flex flex-col overflow-hidden">
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E]">Request correction — {selectedEmpLabel}</h2>
                <button onClick={() => { if (!corrSaving) setShowCorrModal(false); }} className="text-[#8B7355]">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
                {corrError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
                    {corrError}
                  </div>
                )}
                <div>
                  <label className="text-xs text-[#6B5744]">Business date being corrected *</label>
                  <input type="date" value={corrDate} onChange={e => setCorrDate(e.target.value)}
                         className={inputCls} />
                </div>
                <div className="space-y-2">
                  <div className="text-xs font-semibold text-[#8B7355] uppercase tracking-wide">Events to add</div>
                  {corrEvents.map((ev, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <select value={ev.event_type}
                              onChange={e => setCorrEvents(list => list.map((x, j) => j === i ? { ...x, event_type: e.target.value } : x))}
                              className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm">
                        <option value="check_in">Check-in</option>
                        <option value="check_out">Check-out</option>
                      </select>
                      <input type="datetime-local" value={ev.at}
                             onChange={e => setCorrEvents(list => list.map((x, j) => j === i ? { ...x, at: e.target.value } : x))}
                             className="flex-1 px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
                      <button onClick={() => setCorrEvents(list => list.filter((_, j) => j !== i))}
                              disabled={corrEvents.length <= 1}
                              className="p-1.5 text-[#8B7355] hover:text-rose-600 disabled:opacity-30"
                              aria-label="Remove event">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                  <button onClick={() => setCorrEvents(list => [...list, { event_type: 'check_out', at: '' }])}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-[#E8D5C4] bg-white hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-xs font-medium">
                    <Plus className="w-3.5 h-3.5" /> Add event
                  </button>
                  <p className="text-[11px] text-[#8B7355]">
                    Times are entered on your local (IST) clock. On approval these are APPENDED to the
                    punch log on the date above — the original punches are never rewritten.
                  </p>
                </div>
                <div>
                  <label className="text-xs text-[#6B5744]">Reason *</label>
                  <textarea value={corrReason} onChange={e => setCorrReason(e.target.value)}
                            rows={2} placeholder="e.g. Forgot to punch out after the night shift…"
                            className={inputCls} />
                </div>
              </div>
              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
                <button onClick={() => setShowCorrModal(false)} disabled={corrSaving}
                        className="px-3 py-2 text-sm text-[#6B5744] disabled:opacity-50">
                  Cancel
                </button>
                <button onClick={submitCorrection} disabled={corrSaving}
                        className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
                  {corrSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Submit request
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Decision modal (approve / reject) ──────────────────────────── */}
        {decision && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
            <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
                 className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-md shadow-xl flex flex-col overflow-hidden">
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E]">
                  {decision.action === 'approve' ? 'Approve' : 'Reject'} correction
                </h2>
                <button onClick={() => { if (!decisionSaving) setDecision(null); }} className="text-[#8B7355]">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
                {decisionError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
                    {decisionError}
                  </div>
                )}
                <div className="text-sm text-[#6B5744]">
                  <span className="font-bold text-[#2D1B0E]">{corrEmployeeLabel(decision.corr)}</span>
                  {' · '}{fmtISTDate(decision.corr.date)}
                </div>
                {decision.action === 'approve' && (
                  <p className="text-[11px] text-[#8B7355]">
                    Approving appends the requested events to the punch log as manual entries under
                    your name and recomputes the day. The original punches stay untouched.
                  </p>
                )}
                <div>
                  <label className="text-xs text-[#6B5744]">Review note *</label>
                  <textarea value={decisionNote} onChange={e => setDecisionNote(e.target.value)}
                            rows={2}
                            placeholder={decision.action === 'approve' ? 'Why this correction is accepted…' : 'Why this correction is rejected…'}
                            className={inputCls} />
                </div>
              </div>
              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
                <button onClick={() => setDecision(null)} disabled={decisionSaving}
                        className="px-3 py-2 text-sm text-[#6B5744] disabled:opacity-50">
                  Cancel
                </button>
                <button onClick={submitDecision} disabled={decisionSaving}
                        className={`px-3 py-2 text-sm text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50 ${
                          decision.action === 'approve' ? 'bg-green-600 hover:bg-green-700' : 'bg-rose-600 hover:bg-rose-700'
                        }`}>
                  {decisionSaving
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : decision.action === 'approve'
                      ? <CheckCircle2 className="w-4 h-4" />
                      : <XCircle className="w-4 h-4" />}
                  {decision.action === 'approve' ? 'Approve' : 'Reject'}
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
