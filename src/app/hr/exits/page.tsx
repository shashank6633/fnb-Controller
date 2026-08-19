'use client';

/**
 * HR — Disciplinary & Exits (Phase 6). ADMIN-ONLY page.
 *
 * Contract: docs/HRMS_DECISIONS.md §2 (the API is the boundary — this page
 * renders only what canAdminHr lets through; a 403 renders the plain
 * admin-only lock copy). Three tabs:
 *
 *  · Disciplinary — hr_disciplinary_records via /api/hr/disciplinary
 *    (employee filter + kind chips + open/closed chips + search; create/edit
 *    modal covering subject / detail / employee response / manager comment /
 *    final decision, with Close / Reopen in the same modal).
 *  · Resignations — hr_resignations via /api/hr/exits (submit modal computes
 *    the last working day = resignation date + notice days, mirroring the
 *    server's addDays; manage modal renders the status LADDER
 *    submitted → manager → HR → completed with decide buttons + a note,
 *    and Withdraw for any open status). Decisions are status-guarded
 *    server-side — a lost race comes back as a 409 message, surfaced as-is.
 *  · Clearance — per exiting employee (hr_approved / completed resignations):
 *    the hr_exit_clearance checklist with Cleared / Waived + notes, and the
 *    Complete button. A 409 from complete (pending items) is surfaced
 *    VERBATIM; on success the amber "Login stays active — deactivate on the
 *    Users page" banner appears, exactly like the profile status flow
 *    (contract D1: HR proposes login deactivation, never performs it).
 *
 * Structure copied from src/app/hr/employees/page.tsx + hr/documents/page.tsx
 * (fetch race guard, pagination, modal shell, palette).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ShieldAlert,
  Plus,
  Search,
  X,
  Loader2,
  Save,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
  FileSignature,
  ClipboardCheck,
  Undo2,
  Lock,
  RotateCcw,
} from 'lucide-react';
import { api, apiJson } from '@/lib/api';
import { fmtIST, fmtISTDate, todayIST } from '@/lib/format-date';
import Combobox, { type ComboOption } from '@/components/Combobox';
import TabScroller from '@/components/TabScroller';
import {
  HR_DISCIPLINARY_KINDS,
  disciplinaryKindMeta,
  HR_RESIGNATION_STATUSES,
  resignationStatusMeta,
  type HrDisciplinaryRecord,
  type HrResignation,
  type HrExitClearance,
} from '@/lib/hr';

const PAGE_SIZE = 25;

type TabKey = 'disciplinary' | 'resignations' | 'clearance';

/** The slice of GET /api/hr/employees rows this page needs for pickers. */
interface EmpRow {
  id: string;
  employee_code: string;
  full_name: string;
  notice_period_days: number;
  status: string;
}

/** One list row from GET /api/hr/disciplinary — record + LEFT-JOINed names
 *  (a dangling employee_id degrades to blank, never drops the record). */
interface DiscRow extends HrDisciplinaryRecord {
  employee_name: string | null;
  employee_code: string | null;
}

/** One list row from GET /api/hr/exits — resignation + names + clearance progress. */
interface ResRow extends HrResignation {
  employee_name: string | null;
  employee_code: string | null;
  employee_status: string | null;
  clearance_total: number;
  clearance_pending: number;
}

/** Friendly labels for the seeded clearance items; unknown keys degrade to
 *  Title Case (the item column is a free label by schema comment). */
const CLEARANCE_LABELS: Record<string, string> = {
  assets: 'Assets returned',
  advances: 'Advances recovered',
  leave_encash: 'Leave encashment',
  fnf: 'Full & final settlement',
  experience_letter: 'Experience letter',
  relieving_letter: 'Relieving letter',
};

/** Title Case fallback for unknown clearance item keys. */
function labelizeItem(key: string): string {
  return (
    CLEARANCE_LABELS[key] ||
    key.split(/[_\s]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
  );
}

/** True for a real calendar date in YYYY-MM-DD form (mirror of the route). */
function isYmd(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** ymd + days → ymd — the SAME pure-UTC arithmetic the route uses, so the
 *  modal preview always matches the server-computed last working day. */
function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Clearance item status badge classes. */
function clearanceBadge(status: string): { label: string; color: string } {
  if (status === 'cleared')
    return { label: 'Cleared', color: 'bg-green-100 text-green-700 border-green-200' };
  if (status === 'waived')
    return { label: 'Waived', color: 'bg-slate-100 text-slate-600 border-slate-200' };
  return { label: 'Pending', color: 'bg-amber-100 text-amber-800 border-amber-200' };
}

/** Disciplinary open/closed badge classes. */
function discStatusBadge(status: string): { label: string; color: string } {
  if (status === 'closed')
    return { label: 'Closed', color: 'bg-gray-100 text-gray-700 border-gray-200' };
  return { label: 'Open', color: 'bg-blue-100 text-blue-700 border-blue-200' };
}

interface DiscForm {
  employee_id: string;
  kind: string;
  subject: string;
  detail: string;
  employee_response: string;
  manager_comment: string;
  final_decision: string;
}

const emptyDiscForm = (): DiscForm => ({
  employee_id: '',
  kind: 'incident',
  subject: '',
  detail: '',
  employee_response: '',
  manager_comment: '',
  final_decision: '',
});

interface SubmitForm {
  employee_id: string;
  resignation_date: string;
  notice_days: string; // input text; sent as int
  reason: string;
}

const inputCls = 'w-full px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm';
const chipCls = (active: boolean) =>
  `px-3 py-1.5 rounded-full text-xs font-medium border ${
    active
      ? 'bg-[#af4408] text-white border-[#af4408]'
      : 'bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]'
  }`;

export default function HrExitsPage() {
  const [tab, setTab] = useState<TabKey>('disciplinary');
  const [locked, setLocked] = useState(false);

  // ── Employee picker data (shared by all three tabs) ─────────────────────
  const [employees, setEmployees] = useState<EmpRow[]>([]);
  useEffect(() => {
    fetch('/api/hr/employees?pageSize=100')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j) => setEmployees(Array.isArray(j?.rows) ? j.rows : []))
      .catch(() => {});
  }, []);
  const empById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);
  const empFilterOptions = useMemo<ComboOption[]>(
    () => [
      { value: '', label: 'All employees' },
      ...employees.map((e) => ({ value: e.id, label: e.full_name, hint: e.employee_code })),
    ],
    [employees],
  );
  const empPickOptions = useMemo<ComboOption[]>(
    () => employees.map((e) => ({ value: e.id, label: e.full_name, hint: e.employee_code })),
    [employees],
  );

  // ── Page-level "exit completed" banner (the profile status-flow pattern:
  //    HR only SHOWS an amber pointer to /users — deactivation stays an
  //    explicit admin action there, never an HR side effect) ───────────────
  const [completeBanner, setCompleteBanner] = useState<{
    name: string;
    suggest: boolean;
    email: string | null;
  } | null>(null);

  /* ════════════════════════ Disciplinary tab ════════════════════════ */

  const [dRows, setDRows] = useState<DiscRow[]>([]);
  const [dTotal, setDTotal] = useState(0);
  const [dPage, setDPage] = useState(1);
  const [dLoading, setDLoading] = useState(true); // first paint only
  const [dFetching, setDFetching] = useState(false);
  const [dError, setDError] = useState<string | null>(null);

  const [dEmployeeId, setDEmployeeId] = useState('');
  const [dKind, setDKind] = useState(''); // '' = all kinds
  const [dStatus, setDStatus] = useState(''); // '' | open | closed
  const [dSearchInput, setDSearchInput] = useState('');
  const [dQ, setDQ] = useState('');

  const dSeq = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setDQ(dSearchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [dSearchInput]);

  useEffect(() => {
    setDPage(1);
  }, [dQ, dEmployeeId, dKind, dStatus]);

  const fetchDisc = useCallback(async () => {
    const seq = ++dSeq.current;
    setDFetching(true);
    setDError(null);
    try {
      const sp = new URLSearchParams();
      if (dEmployeeId) sp.set('employee_id', dEmployeeId);
      if (dKind) sp.set('kind', dKind);
      if (dStatus) sp.set('status', dStatus);
      if (dQ) sp.set('q', dQ);
      sp.set('page', String(dPage));
      sp.set('pageSize', String(PAGE_SIZE));
      const res = await fetch(`/api/hr/disciplinary?${sp.toString()}`);
      if (seq !== dSeq.current) return; // a newer fetch superseded this one
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          setLocked(true);
          return;
        }
        setDError("Couldn't load disciplinary records");
        return;
      }
      const json = await res.json();
      if (seq !== dSeq.current) return;
      setDRows(Array.isArray(json?.rows) ? json.rows : []);
      setDTotal(Number(json?.total) || 0);
    } catch {
      if (seq === dSeq.current) setDError("Couldn't load disciplinary records");
    } finally {
      if (seq === dSeq.current) {
        setDFetching(false);
        setDLoading(false);
      }
    }
  }, [dEmployeeId, dKind, dStatus, dQ, dPage]);

  useEffect(() => {
    fetchDisc();
  }, [fetchDisc]);

  // Create / edit modal
  const [showDisc, setShowDisc] = useState(false);
  const [discEditing, setDiscEditing] = useState<DiscRow | null>(null);
  const [discForm, setDiscForm] = useState<DiscForm>(emptyDiscForm());
  const [discSaving, setDiscSaving] = useState(false);
  const [discError, setDiscError] = useState<string | null>(null);

  const openDiscCreate = () => {
    setDiscEditing(null);
    setDiscForm({ ...emptyDiscForm(), employee_id: dEmployeeId });
    setDiscError(null);
    setShowDisc(true);
  };

  const openDiscEdit = (r: DiscRow) => {
    setDiscEditing(r);
    setDiscForm({
      employee_id: r.employee_id,
      kind: r.kind || 'incident',
      subject: r.subject || '',
      detail: r.detail || '',
      employee_response: r.employee_response || '',
      manager_comment: r.manager_comment || '',
      final_decision: r.final_decision || '',
    });
    setDiscError(null);
    setShowDisc(true);
  };

  /** Save the modal fields. `nextStatus` rides along for the Close / Reopen
   *  footer buttons (one PATCH — fields + status together). */
  const saveDisc = async (nextStatus?: 'open' | 'closed') => {
    if (!discEditing && !discForm.employee_id) {
      setDiscError('Pick an employee.');
      return;
    }
    if (!discForm.subject.trim()) {
      setDiscError('Subject is required.');
      return;
    }
    setDiscSaving(true);
    setDiscError(null);
    try {
      if (discEditing) {
        const body: Record<string, unknown> = {
          id: discEditing.id,
          kind: discForm.kind,
          subject: discForm.subject.trim(),
          detail: discForm.detail,
          employee_response: discForm.employee_response,
          manager_comment: discForm.manager_comment,
          final_decision: discForm.final_decision,
        };
        if (nextStatus) body.status = nextStatus;
        await apiJson('/api/hr/disciplinary', { method: 'PATCH', body });
      } else {
        await apiJson('/api/hr/disciplinary', {
          method: 'POST',
          body: {
            employee_id: discForm.employee_id,
            kind: discForm.kind,
            subject: discForm.subject.trim(),
            detail: discForm.detail,
            employee_response: discForm.employee_response,
            manager_comment: discForm.manager_comment,
            final_decision: discForm.final_decision,
          },
        });
      }
      setShowDisc(false);
      fetchDisc();
    } catch (e: any) {
      setDiscError(e?.message || 'Could not save the record');
    } finally {
      setDiscSaving(false);
    }
  };

  /* ════════════════════════ Resignations tab ════════════════════════ */

  const [rRows, setRRows] = useState<ResRow[]>([]);
  const [rTotal, setRTotal] = useState(0);
  const [rPage, setRPage] = useState(1);
  const [rLoading, setRLoading] = useState(true);
  const [rFetching, setRFetching] = useState(false);
  const [rError, setRError] = useState<string | null>(null);
  const [rStatus, setRStatus] = useState(''); // '' = all statuses

  const rSeq = useRef(0);

  useEffect(() => {
    setRPage(1);
  }, [rStatus]);

  const fetchRes = useCallback(async () => {
    const seq = ++rSeq.current;
    setRFetching(true);
    setRError(null);
    try {
      const sp = new URLSearchParams();
      if (rStatus) sp.set('status', rStatus);
      sp.set('page', String(rPage));
      sp.set('pageSize', String(PAGE_SIZE));
      const res = await fetch(`/api/hr/exits?${sp.toString()}`);
      if (seq !== rSeq.current) return;
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          setLocked(true);
          return;
        }
        setRError("Couldn't load resignations");
        return;
      }
      const json = await res.json();
      if (seq !== rSeq.current) return;
      setRRows(Array.isArray(json?.rows) ? json.rows : []);
      setRTotal(Number(json?.total) || 0);
    } catch {
      if (seq === rSeq.current) setRError("Couldn't load resignations");
    } finally {
      if (seq === rSeq.current) {
        setRFetching(false);
        setRLoading(false);
      }
    }
  }, [rStatus, rPage]);

  useEffect(() => {
    fetchRes();
  }, [fetchRes]);

  // Submit modal
  const [showSubmit, setShowSubmit] = useState(false);
  const [subForm, setSubForm] = useState<SubmitForm>({
    employee_id: '',
    resignation_date: todayIST(),
    notice_days: '0',
    reason: '',
  });
  const [subSaving, setSubSaving] = useState(false);
  const [subError, setSubError] = useState<string | null>(null);

  const openSubmit = () => {
    setSubForm({ employee_id: '', resignation_date: todayIST(), notice_days: '0', reason: '' });
    setSubError(null);
    setShowSubmit(true);
  };

  const subNoticeDays = Math.max(0, parseInt(subForm.notice_days, 10) || 0);
  const subLwd = isYmd(subForm.resignation_date)
    ? addDaysYmd(subForm.resignation_date, subNoticeDays)
    : '';

  const saveSubmit = async () => {
    if (!subForm.employee_id) {
      setSubError('Pick an employee.');
      return;
    }
    if (!isYmd(subForm.resignation_date)) {
      setSubError('Pick a valid resignation date.');
      return;
    }
    setSubSaving(true);
    setSubError(null);
    try {
      await apiJson('/api/hr/exits', {
        method: 'POST',
        body: {
          employee_id: subForm.employee_id,
          resignation_date: subForm.resignation_date,
          notice_days: subNoticeDays,
          reason: subForm.reason,
        },
      });
      setShowSubmit(false);
      fetchRes();
    } catch (e: any) {
      setSubError(e?.message || 'Could not submit the resignation');
    } finally {
      setSubSaving(false);
    }
  };

  // Manage (ladder) modal
  const [manageRow, setManageRow] = useState<ResRow | null>(null);
  const [decideNote, setDecideNote] = useState('');
  const [decideBusy, setDecideBusy] = useState<string | null>(null); // the in-flight action
  const [manageError, setManageError] = useState<string | null>(null);

  const openManage = (r: ResRow) => {
    setManageRow(r);
    setDecideNote('');
    setManageError(null);
  };

  /** One PATCH decision against /api/hr/exits. Errors (incl. the status-race
   *  409s and the complete pending-items 409) come back VERBATIM. */
  const decideRequest = async (
    resignationId: string,
    action: string,
    note: string,
  ): Promise<{ ok: boolean; error?: string; json?: any }> => {
    try {
      const res = await api('/api/hr/exits', {
        method: 'PATCH',
        body: { id: resignationId, action, note },
      });
      let json: any = null;
      try {
        json = await res.json();
      } catch {
        /* non-JSON body — fall through to the generic message */
      }
      if (!res.ok) return { ok: false, error: json?.error || `HTTP ${res.status}` };
      return { ok: true, json };
    } catch {
      return { ok: false, error: 'Network error — try again' };
    }
  };

  /** Shared complete handler (manage modal + clearance tab): surfaces the
   *  pending-items 409 verbatim; on success raises the page-level banner. */
  const runComplete = async (
    row: { id: string; employee_name: string | null; employee_code: string | null },
    note: string,
  ): Promise<{ ok: boolean; error?: string }> => {
    const r = await decideRequest(row.id, 'complete', note);
    if (!r.ok) return { ok: false, error: r.error };
    setCompleteBanner({
      name: row.employee_name || row.employee_code || 'Employee',
      suggest: !!r.json?.suggest_deactivate_login,
      email: r.json?.linked_user_email || null,
    });
    return { ok: true };
  };

  const decide = async (action: 'manager_approve' | 'hr_approve' | 'withdraw' | 'complete') => {
    if (!manageRow) return;
    if (action === 'withdraw') {
      const who = manageRow.employee_name || manageRow.employee_code || 'this employee';
      if (!window.confirm(`Withdraw the resignation for ${who}?`)) return;
    }
    setDecideBusy(action);
    setManageError(null);
    const result =
      action === 'complete'
        ? await runComplete(manageRow, decideNote)
        : await decideRequest(manageRow.id, action, decideNote);
    setDecideBusy(null);
    if (!result.ok) {
      setManageError(result.error || 'Could not update the resignation');
      return;
    }
    setManageRow(null);
    fetchRes();
    // Keep the clearance tab's detail in sync when it points at this row.
    if (clearPickId === manageRow.id) loadClearance(manageRow.id);
  };

  /* ════════════════════════ Clearance tab ════════════════════════ */

  // Candidates: hr_approved (in progress) + completed (read-only view).
  const [candidates, setCandidates] = useState<ResRow[]>([]);
  const [candLoading, setCandLoading] = useState(false);
  const [clearPickId, setClearPickId] = useState('');
  const [clearDetail, setClearDetail] = useState<{
    resignation: ResRow;
    clearance: HrExitClearance[];
  } | null>(null);
  const [clearLoading, setClearLoading] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const [itemNotes, setItemNotes] = useState<Record<string, string>>({});
  const [itemBusy, setItemBusy] = useState<string | null>(null); // `${id}:${status}`
  const [itemError, setItemError] = useState<string | null>(null);
  const [completeBusy, setCompleteBusy] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);

  const clearSeq = useRef(0);

  const fetchCandidates = useCallback(async () => {
    setCandLoading(true);
    try {
      const res = await fetch('/api/hr/exits?pageSize=100');
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) setLocked(true);
        return;
      }
      const json = await res.json();
      const rows: ResRow[] = Array.isArray(json?.rows) ? json.rows : [];
      setCandidates(rows.filter((r) => r.status === 'hr_approved' || r.status === 'completed'));
    } catch {
      /* the detail fetch below carries the visible error state */
    } finally {
      setCandLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === 'clearance') fetchCandidates();
  }, [tab, fetchCandidates]);

  // Default the picker to the first in-progress exit once candidates arrive.
  useEffect(() => {
    if (tab !== 'clearance' || clearPickId) return;
    const first = candidates.find((c) => c.status === 'hr_approved') || candidates[0];
    if (first) setClearPickId(first.id);
  }, [tab, candidates, clearPickId]);

  const loadClearance = useCallback(async (id: string) => {
    const seq = ++clearSeq.current;
    setClearLoading(true);
    setClearError(null);
    setItemError(null);
    setCompleteError(null);
    try {
      const res = await fetch(`/api/hr/exits?id=${encodeURIComponent(id)}`);
      if (seq !== clearSeq.current) return;
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          setLocked(true);
          return;
        }
        setClearError("Couldn't load the clearance checklist");
        return;
      }
      const json = await res.json();
      if (seq !== clearSeq.current) return;
      const clearance: HrExitClearance[] = Array.isArray(json?.clearance) ? json.clearance : [];
      setClearDetail({ resignation: json?.resignation, clearance });
      setItemNotes(Object.fromEntries(clearance.map((c) => [c.id, c.note || ''])));
    } catch {
      if (seq === clearSeq.current) setClearError("Couldn't load the clearance checklist");
    } finally {
      if (seq === clearSeq.current) setClearLoading(false);
    }
  }, []);

  useEffect(() => {
    if (clearPickId) loadClearance(clearPickId);
    else setClearDetail(null);
  }, [clearPickId, loadClearance]);

  const candidateOptions = useMemo<ComboOption[]>(
    () =>
      candidates.map((c) => ({
        value: c.id,
        label: c.employee_name || c.employee_code || 'Unknown employee',
        hint: `${c.employee_code || '—'} · ${resignationStatusMeta(c.status).label}`,
      })),
    [candidates],
  );
  const pickedCandidate = candidates.find((c) => c.id === clearPickId) || null;

  const markItem = async (item: HrExitClearance, status: 'cleared' | 'waived') => {
    setItemBusy(`${item.id}:${status}`);
    setItemError(null);
    try {
      await apiJson('/api/hr/exits', {
        method: 'PATCH',
        body: { id: item.id, status, note: itemNotes[item.id] ?? '' },
      });
      if (clearPickId) await loadClearance(clearPickId);
    } catch (e: any) {
      setItemError(e?.message || 'Could not update the clearance item');
    } finally {
      setItemBusy(null);
    }
  };

  const completeFromClearance = async () => {
    if (!clearDetail) return;
    setCompleteBusy(true);
    setCompleteError(null);
    const r = await runComplete(clearDetail.resignation, '');
    setCompleteBusy(false);
    if (!r.ok) {
      // The API's pending-items 409 (or status-race 409) — shown VERBATIM.
      setCompleteError(r.error || 'Could not complete the exit');
      return;
    }
    fetchRes();
    fetchCandidates();
    if (clearPickId) loadClearance(clearPickId);
  };

  /* ════════════════════════ Render ════════════════════════ */

  // adminOnly lock — the catalog flag keeps non-admins off the page, and the
  // API 403 keeps this honest even if a link slips through.
  if (locked) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
          <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-6 flex items-center gap-2 text-sm text-[#6B5744]">
            <Lock className="w-4 h-4 shrink-0" /> Disciplinary &amp; Exits is admin-only.
          </div>
        </div>
      </div>
    );
  }

  const pendingCount = clearDetail
    ? clearDetail.clearance.filter((c) => c.status === 'pending').length
    : 0;

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-2">
              <ShieldAlert className="w-6 h-6" /> Disciplinary &amp; Exits
            </h1>
            <p className="text-[#8B7355] text-sm mt-1">
              Disciplinary records, the resignation ladder and exit clearance. Admin-only.
            </p>
          </div>
          {tab === 'disciplinary' ? (
            <button
              onClick={openDiscCreate}
              className="inline-flex items-center gap-2 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium"
            >
              <Plus className="w-4 h-4" /> New Record
            </button>
          ) : tab === 'resignations' ? (
            <button
              onClick={openSubmit}
              className="inline-flex items-center gap-2 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium"
            >
              <FileSignature className="w-4 h-4" /> Submit Resignation
            </button>
          ) : null}
        </div>

        {/* Exit-completed banner (page level so it survives tab switches) */}
        {completeBanner && (
          <div className="space-y-2">
            <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="flex-1">
                Exit completed for <span className="font-medium">{completeBanner.name}</span> — the
                employee is now marked Former.
              </div>
              <button
                onClick={() => setCompleteBanner(null)}
                className="text-green-700 hover:text-green-900 shrink-0"
                title="Dismiss"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {completeBanner.suggest && (
              <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <div className="flex-1">
                  Login stays active
                  {completeBanner.email ? (
                    <>
                      {' '}
                      (<span className="font-mono text-xs">{completeBanner.email}</span>)
                    </>
                  ) : null}
                  . Deactivate it on the Users page (admin action).{' '}
                  <Link
                    href="/users"
                    className="underline font-medium inline-flex items-center gap-0.5"
                  >
                    Open Users <ExternalLink className="w-3 h-3" />
                  </Link>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Tabs */}
        <TabScroller className="gap-2">
          {(
            [
              { key: 'disciplinary', label: 'Disciplinary' },
              { key: 'resignations', label: 'Resignations' },
              { key: 'clearance', label: 'Clearance' },
            ] as { key: TabKey; label: string }[]
          ).map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                tab === t.key
                  ? 'bg-[#af4408] border-[#af4408] text-white'
                  : 'bg-white border-[#E8D5C4] text-[#6B5744] hover:bg-[#FFF1E3]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </TabScroller>

        {/* ══════════════ Disciplinary ══════════════ */}
        {tab === 'disciplinary' && (
          <>
            {/* Filters */}
            <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-3 space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2 flex-1 min-w-[200px]">
                  <Search className="w-4 h-4 text-[#8B7355]" />
                  <input
                    value={dSearchInput}
                    onChange={(e) => setDSearchInput(e.target.value)}
                    placeholder="Subject, detail, employee…"
                    className="flex-1 px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm"
                  />
                </div>
                <div className="w-full sm:w-64">
                  <Combobox
                    options={empFilterOptions}
                    value={dEmployeeId ? empById.get(dEmployeeId)?.full_name || '' : ''}
                    onChange={(v) => setDEmployeeId(v)}
                    placeholder="All employees"
                  />
                </div>
              </div>
              <TabScroller className="gap-2">
                <button onClick={() => setDKind('')} className={chipCls(dKind === '')}>
                  All kinds
                </button>
                {HR_DISCIPLINARY_KINDS.map((k) => (
                  <button
                    key={k.key}
                    onClick={() => setDKind((prev) => (prev === k.key ? '' : k.key))}
                    className={chipCls(dKind === k.key)}
                  >
                    {k.label}
                  </button>
                ))}
                <span className="w-px self-stretch bg-[#E8D5C4] mx-1" aria-hidden />
                <button onClick={() => setDStatus('')} className={chipCls(dStatus === '')}>
                  All
                </button>
                <button
                  onClick={() => setDStatus((p) => (p === 'open' ? '' : 'open'))}
                  className={chipCls(dStatus === 'open')}
                >
                  Open
                </button>
                <button
                  onClick={() => setDStatus((p) => (p === 'closed' ? '' : 'closed'))}
                  className={chipCls(dStatus === 'closed')}
                >
                  Closed
                </button>
              </TabScroller>
            </div>

            {dError && (
              <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm flex items-center justify-between gap-3">
                <span>{dError}</span>
                <button
                  onClick={() => fetchDisc()}
                  className="shrink-0 px-3 py-1.5 border border-red-200 rounded-lg text-xs font-medium hover:bg-red-100"
                >
                  Retry
                </button>
              </div>
            )}

            <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
              {dLoading ? (
                <div className="p-6 flex items-center justify-center gap-2 text-[#8B7355] text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading...
                </div>
              ) : dRows.length === 0 ? (
                <div className="p-6 text-center text-[#8B7355] text-sm">
                  {dQ || dEmployeeId || dKind || dStatus
                    ? 'No records match these filters.'
                    : 'No disciplinary records yet.'}
                </div>
              ) : (
                <>
                  <div className={`overflow-x-auto ${dFetching ? 'opacity-60' : ''}`}>
                    <table className="w-full text-sm">
                      <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                        <tr>
                          <th className="text-left py-2 px-3 font-medium">Employee</th>
                          <th className="text-left py-2 px-3 font-medium">Kind</th>
                          <th className="text-left py-2 px-3 font-medium">Subject</th>
                          <th className="text-left py-2 px-3 font-medium">Status</th>
                          <th className="text-left py-2 px-3 font-medium">Decision</th>
                          <th className="text-left py-2 px-3 font-medium">Created</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dRows.map((r) => {
                          const kindMeta = disciplinaryKindMeta(r.kind);
                          const badge = discStatusBadge(r.status);
                          return (
                            <tr
                              key={r.id}
                              onClick={() => openDiscEdit(r)}
                              className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3] cursor-pointer"
                            >
                              <td className="py-2 px-3">
                                <div className="font-bold text-[#2D1B0E]">
                                  {r.employee_name || <span className="text-[#8B7355]">—</span>}
                                </div>
                                {r.employee_code && (
                                  <div className="text-[10px] font-mono text-[#8B7355]">
                                    {r.employee_code}
                                  </div>
                                )}
                              </td>
                              <td className="py-2 px-3">
                                <span
                                  className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border ${kindMeta.color}`}
                                >
                                  {kindMeta.label}
                                </span>
                              </td>
                              <td className="py-2 px-3 max-w-[280px]">
                                <div className="truncate" title={r.subject}>
                                  {r.subject}
                                </div>
                              </td>
                              <td className="py-2 px-3">
                                <span
                                  className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border ${badge.color}`}
                                >
                                  {badge.label}
                                </span>
                              </td>
                              <td className="py-2 px-3 text-xs max-w-[220px]">
                                <div className="truncate" title={r.final_decision}>
                                  {r.final_decision || <span className="text-[#8B7355]">—</span>}
                                </div>
                              </td>
                              <td className="py-2 px-3 text-xs whitespace-nowrap">
                                {fmtIST(r.created_at)}
                                <div className="text-[10px] text-[#8B7355]">{r.created_by}</div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="px-3 py-2 border-t border-[#E8D5C4] flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs text-[#8B7355]">
                      Showing {dTotal === 0 ? 0 : (dPage - 1) * PAGE_SIZE + 1}–
                      {Math.min(dPage * PAGE_SIZE, dTotal)} of {dTotal}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setDPage((p) => Math.max(1, p - 1))}
                        disabled={dPage <= 1 || dFetching}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-[#E8D5C4] bg-white hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-xs font-medium disabled:opacity-40"
                      >
                        <ChevronLeft className="w-3.5 h-3.5" /> Prev
                      </button>
                      <span className="text-xs text-[#6B5744]">
                        Page {dPage} of {Math.max(1, Math.ceil(dTotal / PAGE_SIZE))}
                      </span>
                      <button
                        onClick={() =>
                          setDPage((p) => Math.min(Math.max(1, Math.ceil(dTotal / PAGE_SIZE)), p + 1))
                        }
                        disabled={dPage >= Math.max(1, Math.ceil(dTotal / PAGE_SIZE)) || dFetching}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-[#E8D5C4] bg-white hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-xs font-medium disabled:opacity-40"
                      >
                        Next <ChevronRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </>
        )}

        {/* ══════════════ Resignations ══════════════ */}
        {tab === 'resignations' && (
          <>
            <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-3">
              <TabScroller className="gap-2">
                <button onClick={() => setRStatus('')} className={chipCls(rStatus === '')}>
                  All
                </button>
                {HR_RESIGNATION_STATUSES.map((s) => (
                  <button
                    key={s.key}
                    onClick={() => setRStatus((prev) => (prev === s.key ? '' : s.key))}
                    className={chipCls(rStatus === s.key)}
                  >
                    {s.label}
                  </button>
                ))}
              </TabScroller>
            </div>

            {rError && (
              <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm flex items-center justify-between gap-3">
                <span>{rError}</span>
                <button
                  onClick={() => fetchRes()}
                  className="shrink-0 px-3 py-1.5 border border-red-200 rounded-lg text-xs font-medium hover:bg-red-100"
                >
                  Retry
                </button>
              </div>
            )}

            <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
              {rLoading ? (
                <div className="p-6 flex items-center justify-center gap-2 text-[#8B7355] text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading...
                </div>
              ) : rRows.length === 0 ? (
                <div className="p-6 text-center text-[#8B7355] text-sm">
                  {rStatus
                    ? 'No resignations with this status.'
                    : 'No resignations yet — submit the first one.'}
                </div>
              ) : (
                <>
                  <div className={`overflow-x-auto ${rFetching ? 'opacity-60' : ''}`}>
                    <table className="w-full text-sm">
                      <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                        <tr>
                          <th className="text-left py-2 px-3 font-medium">Employee</th>
                          <th className="text-left py-2 px-3 font-medium">Resigned</th>
                          <th className="text-left py-2 px-3 font-medium">Notice</th>
                          <th className="text-left py-2 px-3 font-medium">Last Working Day</th>
                          <th className="text-left py-2 px-3 font-medium">Status</th>
                          <th className="text-left py-2 px-3 font-medium">Clearance</th>
                          <th className="text-right py-2 px-3 font-medium"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {rRows.map((r) => {
                          const meta = resignationStatusMeta(r.status);
                          return (
                            <tr
                              key={r.id}
                              onClick={() => openManage(r)}
                              className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3] cursor-pointer"
                            >
                              <td className="py-2 px-3">
                                <div className="font-bold text-[#2D1B0E]">
                                  {r.employee_name || <span className="text-[#8B7355]">—</span>}
                                </div>
                                {r.employee_code && (
                                  <div className="text-[10px] font-mono text-[#8B7355]">
                                    {r.employee_code}
                                  </div>
                                )}
                              </td>
                              <td className="py-2 px-3 text-xs whitespace-nowrap">
                                {r.resignation_date ? fmtISTDate(r.resignation_date) : '—'}
                              </td>
                              <td className="py-2 px-3 text-xs whitespace-nowrap">
                                {r.notice_days} day{r.notice_days === 1 ? '' : 's'}
                              </td>
                              <td className="py-2 px-3 text-xs whitespace-nowrap">
                                {r.last_working_date ? fmtISTDate(r.last_working_date) : '—'}
                              </td>
                              <td className="py-2 px-3">
                                <span
                                  className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border ${meta.color}`}
                                >
                                  {meta.label}
                                </span>
                              </td>
                              <td className="py-2 px-3 text-xs whitespace-nowrap">
                                {r.clearance_total > 0 ? (
                                  <span
                                    className={
                                      r.clearance_pending > 0 ? 'text-amber-700' : 'text-green-700'
                                    }
                                  >
                                    {r.clearance_total - r.clearance_pending}/{r.clearance_total}{' '}
                                    cleared
                                  </span>
                                ) : (
                                  <span className="text-[#8B7355]">—</span>
                                )}
                              </td>
                              <td className="py-2 px-3 text-right">
                                <span className="text-xs text-[#af4408] font-medium">Manage</span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="px-3 py-2 border-t border-[#E8D5C4] flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs text-[#8B7355]">
                      Showing {rTotal === 0 ? 0 : (rPage - 1) * PAGE_SIZE + 1}–
                      {Math.min(rPage * PAGE_SIZE, rTotal)} of {rTotal}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setRPage((p) => Math.max(1, p - 1))}
                        disabled={rPage <= 1 || rFetching}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-[#E8D5C4] bg-white hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-xs font-medium disabled:opacity-40"
                      >
                        <ChevronLeft className="w-3.5 h-3.5" /> Prev
                      </button>
                      <span className="text-xs text-[#6B5744]">
                        Page {rPage} of {Math.max(1, Math.ceil(rTotal / PAGE_SIZE))}
                      </span>
                      <button
                        onClick={() =>
                          setRPage((p) => Math.min(Math.max(1, Math.ceil(rTotal / PAGE_SIZE)), p + 1))
                        }
                        disabled={rPage >= Math.max(1, Math.ceil(rTotal / PAGE_SIZE)) || rFetching}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-[#E8D5C4] bg-white hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-xs font-medium disabled:opacity-40"
                      >
                        Next <ChevronRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </>
        )}

        {/* ══════════════ Clearance ══════════════ */}
        {tab === 'clearance' && (
          <>
            <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-3 flex flex-wrap items-center gap-3">
              <ClipboardCheck className="w-4 h-4 text-[#8B7355]" />
              <div className="w-full sm:w-96">
                <Combobox
                  options={candidateOptions}
                  value={
                    pickedCandidate
                      ? pickedCandidate.employee_name || pickedCandidate.employee_code || ''
                      : ''
                  }
                  onChange={(v) => setClearPickId(v)}
                  placeholder={candLoading ? 'Loading exits…' : 'Pick an exiting employee'}
                />
              </div>
              <p className="text-xs text-[#8B7355]">
                Clearance opens once HR approves a resignation.
              </p>
            </div>

            {clearError && (
              <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm flex items-center justify-between gap-3">
                <span>{clearError}</span>
                <button
                  onClick={() => clearPickId && loadClearance(clearPickId)}
                  className="shrink-0 px-3 py-1.5 border border-red-200 rounded-lg text-xs font-medium hover:bg-red-100"
                >
                  Retry
                </button>
              </div>
            )}

            {!clearPickId && !candLoading && candidates.length === 0 ? (
              <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-6 text-center text-[#8B7355] text-sm">
                No exits in clearance — HR-approve a resignation first.
              </div>
            ) : clearLoading ? (
              <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-6 flex items-center justify-center gap-2 text-[#8B7355] text-sm">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading...
              </div>
            ) : clearDetail ? (
              <div className="space-y-4">
                {/* Exit summary */}
                <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                  <div>
                    <div className="font-bold text-[#2D1B0E]">
                      {clearDetail.resignation.employee_name || '—'}
                    </div>
                    <div className="text-[10px] font-mono text-[#8B7355]">
                      {clearDetail.resignation.employee_code || ''}
                    </div>
                  </div>
                  <div className="text-xs text-[#6B5744]">
                    <span className="text-[#8B7355]">Last working day:</span>{' '}
                    {clearDetail.resignation.last_working_date
                      ? fmtISTDate(clearDetail.resignation.last_working_date)
                      : '—'}
                  </div>
                  <span
                    className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border ${resignationStatusMeta(clearDetail.resignation.status).color}`}
                  >
                    {resignationStatusMeta(clearDetail.resignation.status).label}
                  </span>
                  <div className="text-xs text-[#6B5744]">
                    <span className="text-[#8B7355]">Progress:</span>{' '}
                    {clearDetail.clearance.length - pendingCount}/{clearDetail.clearance.length}{' '}
                    cleared
                  </div>
                </div>

                {itemError && (
                  <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm">
                    {itemError}
                  </div>
                )}

                {/* Checklist */}
                <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
                  {clearDetail.clearance.length === 0 ? (
                    <div className="p-6 text-center text-[#8B7355] text-sm">
                      No clearance items for this exit yet.
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                          <tr>
                            <th className="text-left py-2 px-3 font-medium">Item</th>
                            <th className="text-left py-2 px-3 font-medium">Status</th>
                            <th className="text-left py-2 px-3 font-medium min-w-[220px]">Note</th>
                            <th className="text-left py-2 px-3 font-medium">By</th>
                            <th className="text-right py-2 px-3 font-medium">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {clearDetail.clearance.map((item) => {
                            const badge = clearanceBadge(item.status);
                            const readOnly = clearDetail.resignation.status === 'completed';
                            return (
                              <tr key={item.id} className="border-t border-[#E8D5C4]/50">
                                <td className="py-2 px-3">
                                  <div className="font-medium text-[#2D1B0E]">
                                    {labelizeItem(item.item)}
                                  </div>
                                  <div className="text-[10px] font-mono text-[#8B7355]">
                                    {item.item}
                                  </div>
                                </td>
                                <td className="py-2 px-3">
                                  <span
                                    className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border ${badge.color}`}
                                  >
                                    {badge.label}
                                  </span>
                                </td>
                                <td className="py-2 px-3">
                                  {readOnly ? (
                                    <span className="text-xs text-[#6B5744]">
                                      {item.note || <span className="text-[#8B7355]">—</span>}
                                    </span>
                                  ) : (
                                    <input
                                      value={itemNotes[item.id] ?? ''}
                                      onChange={(e) =>
                                        setItemNotes((n) => ({ ...n, [item.id]: e.target.value }))
                                      }
                                      placeholder="Note (optional)"
                                      className="w-full px-2 py-1 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-xs"
                                    />
                                  )}
                                </td>
                                <td className="py-2 px-3 text-xs">
                                  {item.cleared_by ? (
                                    <>
                                      <div>{item.cleared_by}</div>
                                      <div className="text-[10px] text-[#8B7355]">
                                        {item.cleared_at ? fmtIST(item.cleared_at) : ''}
                                      </div>
                                    </>
                                  ) : (
                                    <span className="text-[#8B7355]">—</span>
                                  )}
                                </td>
                                <td className="py-2 px-3 text-right whitespace-nowrap">
                                  {!readOnly && (
                                    <div className="inline-flex items-center gap-1.5">
                                      <button
                                        onClick={() => markItem(item, 'cleared')}
                                        disabled={itemBusy !== null}
                                        className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium border border-green-200 bg-green-50 text-green-700 hover:bg-green-100 disabled:opacity-40"
                                      >
                                        {itemBusy === `${item.id}:cleared` ? (
                                          <Loader2 className="w-3 h-3 animate-spin" />
                                        ) : (
                                          <CheckCircle2 className="w-3 h-3" />
                                        )}
                                        Cleared
                                      </button>
                                      <button
                                        onClick={() => markItem(item, 'waived')}
                                        disabled={itemBusy !== null}
                                        className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium border border-[#E8D5C4] bg-white text-[#6B5744] hover:bg-[#FFF1E3] disabled:opacity-40"
                                      >
                                        {itemBusy === `${item.id}:waived` ? (
                                          <Loader2 className="w-3 h-3 animate-spin" />
                                        ) : (
                                          <Undo2 className="w-3 h-3" />
                                        )}
                                        Waived
                                      </button>
                                    </div>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* Complete */}
                {clearDetail.resignation.status === 'hr_approved' && (
                  <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-4 space-y-3">
                    {completeError && (
                      <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
                        {completeError}
                      </div>
                    )}
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="text-xs text-[#8B7355]">
                        {pendingCount > 0
                          ? `${pendingCount} item${pendingCount === 1 ? '' : 's'} still pending — every item must be cleared or waived before the exit can be completed.`
                          : 'All items cleared — completing marks the employee Former and closes the resignation.'}
                      </p>
                      <button
                        onClick={completeFromClearance}
                        disabled={completeBusy}
                        className="inline-flex items-center gap-2 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium disabled:opacity-50"
                      >
                        {completeBusy ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <CheckCircle2 className="w-4 h-4" />
                        )}
                        Complete Exit
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-6 text-center text-[#8B7355] text-sm">
                Pick an exiting employee to see their clearance checklist.
              </div>
            )}
          </>
        )}

        {/* ── Disciplinary create / edit modal ── */}
        {showDisc && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
            <div
              style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
              className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-lg shadow-xl flex flex-col overflow-hidden"
            >
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E]">
                  {discEditing ? 'Disciplinary Record' : 'New Disciplinary Record'}
                </h2>
                <button
                  onClick={() => {
                    if (!discSaving) setShowDisc(false);
                  }}
                  className="text-[#8B7355]"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
                {discError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
                    {discError}
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-[#6B5744]">Employee *</label>
                    {discEditing ? (
                      // employee_id is immutable — a record never moves between people.
                      <input
                        disabled
                        value={`${discEditing.employee_name || '—'}${discEditing.employee_code ? ` (${discEditing.employee_code})` : ''}`}
                        className={`${inputCls} opacity-60`}
                      />
                    ) : (
                      <Combobox
                        options={empPickOptions}
                        value={
                          discForm.employee_id
                            ? empById.get(discForm.employee_id)?.full_name || ''
                            : ''
                        }
                        onChange={(v) => setDiscForm((f) => ({ ...f, employee_id: v }))}
                        placeholder="Pick employee"
                      />
                    )}
                  </div>
                  <div>
                    <label className="text-xs text-[#6B5744]">Kind</label>
                    <select
                      value={discForm.kind}
                      onChange={(e) => setDiscForm((f) => ({ ...f, kind: e.target.value }))}
                      className={inputCls}
                    >
                      {HR_DISCIPLINARY_KINDS.map((k) => (
                        <option key={k.key} value={k.key}>
                          {k.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="text-xs text-[#6B5744]">Subject *</label>
                  <input
                    value={discForm.subject}
                    onChange={(e) => setDiscForm((f) => ({ ...f, subject: e.target.value }))}
                    placeholder="e.g. Repeated late reporting"
                    className={inputCls}
                    autoFocus={!discEditing}
                  />
                </div>

                <div>
                  <label className="text-xs text-[#6B5744]">Detail</label>
                  <textarea
                    value={discForm.detail}
                    onChange={(e) => setDiscForm((f) => ({ ...f, detail: e.target.value }))}
                    rows={3}
                    placeholder="What happened"
                    className={inputCls}
                  />
                </div>

                <div>
                  <label className="text-xs text-[#6B5744]">Employee response</label>
                  <textarea
                    value={discForm.employee_response}
                    onChange={(e) =>
                      setDiscForm((f) => ({ ...f, employee_response: e.target.value }))
                    }
                    rows={2}
                    placeholder="The employee's side, as recorded"
                    className={inputCls}
                  />
                </div>

                <div>
                  <label className="text-xs text-[#6B5744]">Manager comment</label>
                  <textarea
                    value={discForm.manager_comment}
                    onChange={(e) =>
                      setDiscForm((f) => ({ ...f, manager_comment: e.target.value }))
                    }
                    rows={2}
                    className={inputCls}
                  />
                </div>

                <div>
                  <label className="text-xs text-[#6B5744]">Final decision</label>
                  <textarea
                    value={discForm.final_decision}
                    onChange={(e) =>
                      setDiscForm((f) => ({ ...f, final_decision: e.target.value }))
                    }
                    rows={2}
                    placeholder="Outcome / action taken"
                    className={inputCls}
                  />
                </div>
              </div>

              <div className="px-5 py-3 border-t border-[#E8D5C4] flex flex-wrap items-center justify-end gap-2 shrink-0">
                {discEditing && discEditing.status === 'open' && (
                  <button
                    onClick={() => saveDisc('closed')}
                    disabled={discSaving}
                    className="mr-auto inline-flex items-center gap-1 px-3 py-2 text-sm border border-[#E8D5C4] text-[#6B5744] hover:bg-[#FFF1E3] rounded-lg disabled:opacity-50"
                    title="Save the fields and close the record"
                  >
                    <Lock className="w-4 h-4" /> Save &amp; Close Record
                  </button>
                )}
                {discEditing && discEditing.status === 'closed' && (
                  <button
                    onClick={() => saveDisc('open')}
                    disabled={discSaving}
                    className="mr-auto inline-flex items-center gap-1 px-3 py-2 text-sm border border-[#E8D5C4] text-[#6B5744] hover:bg-[#FFF1E3] rounded-lg disabled:opacity-50"
                    title="Save the fields and reopen the record"
                  >
                    <RotateCcw className="w-4 h-4" /> Reopen
                  </button>
                )}
                <button
                  onClick={() => setShowDisc(false)}
                  disabled={discSaving}
                  className="px-3 py-2 text-sm text-[#6B5744] disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={() => saveDisc()}
                  disabled={discSaving}
                  className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50"
                >
                  {discSaving ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Save className="w-4 h-4" />
                  )}{' '}
                  Save
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Submit resignation modal ── */}
        {showSubmit && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
            <div
              style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
              className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-lg shadow-xl flex flex-col overflow-hidden"
            >
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E]">Submit Resignation</h2>
                <button
                  onClick={() => {
                    if (!subSaving) setShowSubmit(false);
                  }}
                  className="text-[#8B7355]"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
                {subError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
                    {subError}
                  </div>
                )}

                <div>
                  <label className="text-xs text-[#6B5744]">Employee *</label>
                  <Combobox
                    options={empPickOptions}
                    value={
                      subForm.employee_id ? empById.get(subForm.employee_id)?.full_name || '' : ''
                    }
                    onChange={(v) => {
                      // Prefill notice days from the employee master (the server
                      // does the same when the key is absent — we always send it,
                      // so the prefill keeps the two in agreement while staying editable).
                      const emp = empById.get(v);
                      setSubForm((f) => ({
                        ...f,
                        employee_id: v,
                        notice_days: String(emp?.notice_period_days ?? 0),
                      }));
                    }}
                    placeholder="Pick employee"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-[#6B5744]">Resignation date *</label>
                    <input
                      type="date"
                      value={subForm.resignation_date}
                      onChange={(e) =>
                        setSubForm((f) => ({ ...f, resignation_date: e.target.value }))
                      }
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-[#6B5744]">Notice days</label>
                    <input
                      type="number"
                      min={0}
                      value={subForm.notice_days}
                      onChange={(e) => setSubForm((f) => ({ ...f, notice_days: e.target.value }))}
                      className={inputCls}
                    />
                  </div>
                </div>

                <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF1E3] px-3 py-2 text-sm text-[#6B5744]">
                  Last working day:{' '}
                  <span className="font-medium text-[#2D1B0E]">
                    {subLwd ? fmtISTDate(subLwd) : '—'}
                  </span>
                  <span className="text-xs text-[#8B7355]"> (resignation date + notice days)</span>
                </div>

                <div>
                  <label className="text-xs text-[#6B5744]">Reason</label>
                  <textarea
                    value={subForm.reason}
                    onChange={(e) => setSubForm((f) => ({ ...f, reason: e.target.value }))}
                    rows={3}
                    placeholder="Reason given (optional)"
                    className={inputCls}
                  />
                </div>
              </div>

              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
                <button
                  onClick={() => setShowSubmit(false)}
                  disabled={subSaving}
                  className="px-3 py-2 text-sm text-[#6B5744] disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={saveSubmit}
                  disabled={subSaving}
                  className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50"
                >
                  {subSaving ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <FileSignature className="w-4 h-4" />
                  )}{' '}
                  Submit
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Manage resignation (ladder) modal ── */}
        {manageRow && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
            <div
              style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
              className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-lg shadow-xl flex flex-col overflow-hidden"
            >
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <div>
                  <h2 className="font-bold text-[#2D1B0E]">
                    {manageRow.employee_name || 'Resignation'}
                  </h2>
                  <div className="text-[10px] font-mono text-[#8B7355]">
                    {manageRow.employee_code || ''}
                  </div>
                </div>
                <button
                  onClick={() => {
                    if (!decideBusy) setManageRow(null);
                  }}
                  className="text-[#8B7355]"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
                {manageError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
                    {manageError}
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <div className="text-xs text-[#8B7355]">Resignation date</div>
                    <div>
                      {manageRow.resignation_date ? fmtISTDate(manageRow.resignation_date) : '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-[#8B7355]">Last working day</div>
                    <div>
                      {manageRow.last_working_date ? fmtISTDate(manageRow.last_working_date) : '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-[#8B7355]">Notice</div>
                    <div>
                      {manageRow.notice_days} day{manageRow.notice_days === 1 ? '' : 's'}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-[#8B7355]">Clearance</div>
                    <div>
                      {manageRow.clearance_total > 0
                        ? `${manageRow.clearance_total - manageRow.clearance_pending}/${manageRow.clearance_total} cleared`
                        : 'Not seeded yet'}
                    </div>
                  </div>
                </div>

                {manageRow.reason && (
                  <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] px-3 py-2 text-sm text-[#6B5744]">
                    <span className="text-xs text-[#8B7355]">Reason: </span>
                    {manageRow.reason}
                  </div>
                )}

                {/* Ladder: submitted → manager → HR → completed */}
                {manageRow.status === 'withdrawn' ? (
                  <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF1E3] px-3 py-2 text-sm text-[#6B5744]">
                    This resignation was withdrawn.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {(
                      [
                        {
                          key: 'submitted',
                          label: 'Submitted',
                          by: manageRow.created_by,
                          at: manageRow.created_at,
                        },
                        {
                          key: 'manager_approved',
                          label: 'Manager approval',
                          by: manageRow.manager_by,
                          at: manageRow.manager_at,
                        },
                        {
                          key: 'hr_approved',
                          label: 'HR approval',
                          by: manageRow.hr_by,
                          at: manageRow.hr_at,
                        },
                        { key: 'completed', label: 'Completed', by: '', at: '' },
                      ] as { key: string; label: string; by: string; at: string }[]
                    ).map((step, idx) => {
                      const order = ['submitted', 'manager_approved', 'hr_approved', 'completed'];
                      const currentIdx = order.indexOf(manageRow.status);
                      const done = idx <= currentIdx;
                      const isNext = idx === currentIdx + 1;
                      return (
                        <div
                          key={step.key}
                          className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${
                            done
                              ? 'border-green-200 bg-green-50'
                              : isNext
                                ? 'border-[#af4408]/40 bg-[#FFF1E3]'
                                : 'border-[#E8D5C4] bg-white'
                          }`}
                        >
                          <div
                            className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                              done ? 'bg-green-600 text-white' : 'bg-[#FFF8F0] border border-[#E8D5C4] text-[#8B7355]'
                            }`}
                          >
                            {done ? <CheckCircle2 className="w-4 h-4" /> : idx + 1}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-[#2D1B0E]">{step.label}</div>
                            {done && step.by && (
                              <div className="text-[10px] text-[#8B7355] truncate">
                                {step.by}
                                {step.at ? ` · ${fmtIST(step.at)}` : ''}
                              </div>
                            )}
                          </div>
                          {isNext && step.key === 'manager_approved' && (
                            <button
                              onClick={() => decide('manager_approve')}
                              disabled={decideBusy !== null}
                              className="shrink-0 px-2.5 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-xs font-medium inline-flex items-center gap-1 disabled:opacity-50"
                            >
                              {decideBusy === 'manager_approve' && (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              )}
                              Manager Approve
                            </button>
                          )}
                          {isNext && step.key === 'hr_approved' && (
                            <button
                              onClick={() => decide('hr_approve')}
                              disabled={decideBusy !== null}
                              className="shrink-0 px-2.5 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-xs font-medium inline-flex items-center gap-1 disabled:opacity-50"
                            >
                              {decideBusy === 'hr_approve' && (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              )}
                              HR Approve
                            </button>
                          )}
                          {isNext && step.key === 'completed' && (
                            <button
                              onClick={() => decide('complete')}
                              disabled={decideBusy !== null}
                              title="Requires every clearance item cleared or waived"
                              className="shrink-0 px-2.5 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-xs font-medium inline-flex items-center gap-1 disabled:opacity-50"
                            >
                              {decideBusy === 'complete' && (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              )}
                              Complete
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Decision note + clearance shortcut */}
                {['submitted', 'manager_approved', 'hr_approved'].includes(manageRow.status) && (
                  <div>
                    <label className="text-xs text-[#6B5744]">
                      Decision note (kept in the audit trail)
                    </label>
                    <textarea
                      value={decideNote}
                      onChange={(e) => setDecideNote(e.target.value)}
                      rows={2}
                      placeholder="Optional note for the next decision"
                      className={inputCls}
                    />
                  </div>
                )}
                {manageRow.status === 'hr_approved' && (
                  <button
                    onClick={() => {
                      setClearPickId(manageRow.id);
                      setManageRow(null);
                      setTab('clearance');
                    }}
                    className="text-xs text-[#af4408] font-medium underline inline-flex items-center gap-1"
                  >
                    <ClipboardCheck className="w-3.5 h-3.5" /> Open the clearance checklist
                  </button>
                )}
              </div>

              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-between gap-2 shrink-0">
                {['submitted', 'manager_approved', 'hr_approved'].includes(manageRow.status) ? (
                  <button
                    onClick={() => decide('withdraw')}
                    disabled={decideBusy !== null}
                    className="inline-flex items-center gap-1 px-3 py-2 text-sm border border-red-200 text-red-700 hover:bg-red-50 rounded-lg disabled:opacity-50"
                  >
                    {decideBusy === 'withdraw' ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Undo2 className="w-4 h-4" />
                    )}{' '}
                    Withdraw
                  </button>
                ) : (
                  <span />
                )}
                <button
                  onClick={() => {
                    if (!decideBusy) setManageRow(null);
                  }}
                  className="px-3 py-2 text-sm text-[#6B5744]"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
