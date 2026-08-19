'use client';

/**
 * HR — Recruitment pipeline + onboarding (Phase 6).
 *
 * Contract: docs/HRMS_DECISIONS.md. The API (/api/hr/candidates, canManageHr)
 * is the security boundary — this page renders only what it is allowed to see.
 * Conventions copied from the exemplar list page (src/app/hr/employees/page.tsx):
 * bare fetch for GETs with the fetchSeq race guard, api()/apiJson() for every
 * mutation, house palette, portaled Combobox in modals, Toggle for switches.
 *
 * Board: stage-grouped horizontal-scroll lanes (applied → shortlisted →
 * interview → selected → offer → joined; rejected collapsed by default).
 * Card click → edit modal with validated stage-advance buttons — 'joined' is
 * NEVER settable here (convert-only, the API refuses it), and a converted
 * candidate's stage is locked. 'Convert to employee' (offer/selected) opens a
 * modal prefilled from the candidate → POST {action:'convert'} → link to the
 * new /hr/employees/[id]. The onboarding panel drives /api/hr/onboarding:
 * employee picker → checklist with done toggles + completion bar + seed.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  HeartHandshake, Plus, Search, X, Loader2, Save, ClipboardCheck,
  UserCheck, ArrowRight, ArrowLeft, ExternalLink, Sparkles,
} from 'lucide-react';
import { apiJson } from '@/lib/api';
import { fmtIST } from '@/lib/format-date';
import Combobox, { type ComboOption } from '@/components/Combobox';
import PhoneField from '@/components/PhoneField';
import Toggle from '@/components/Toggle';
import {
  HR_EMPLOYMENT_TYPES,
  candidateStageMeta,
  type HrCandidate,
  type HrCandidateStage,
  type HrOnboardingItem,
} from '@/lib/hr';

/** GET /api/hr/candidates row: hr_candidates + LEFT-JOINed display names. */
interface CandidateRow extends HrCandidate {
  department_name: string | null;
  /** Post-convert only (LEFT JOIN hr_employees on c.employee_id). */
  employee_name: string | null;
  employee_code: string | null;
}

interface DeptRow { id: string; name: string; parent_id: string | null; is_active: number }
interface DesigRow { id: string; name: string; grade?: string; is_active?: number }
interface OutletRow { id: string; name: string }
interface EmpPickRow { id: string; full_name: string; employee_code: string }

/** The advancement chain. 'joined' is reachable ONLY via convert; 'rejected'
 *  is a side exit available from any pipeline stage. */
const PIPELINE: readonly HrCandidateStage[] = ['applied', 'shortlisted', 'interview', 'selected', 'offer'];
/** Lanes always rendered on the board (rejected is the collapsible extra). */
const BOARD_LANES: readonly HrCandidateStage[] = [...PIPELINE, 'joined'];
/** Stages that offer 'Convert to employee'. */
const CONVERTIBLE: readonly HrCandidateStage[] = ['selected', 'offer'];

/** Candidate create/edit form — everything as strings; the API parses. */
interface CandForm {
  name: string;
  phone10: string;
  email: string;
  position: string;
  department_id: string;
  joining_date: string;
  interview_score: string;
  expected_salary: string;
  offered_salary: string;
  resume_note: string;
  note: string;
}

const emptyCandForm = (): CandForm => ({
  name: '', phone10: '', email: '', position: '', department_id: '',
  joining_date: '', interview_score: '', expected_salary: '', offered_salary: '',
  resume_note: '', note: '',
});

/** Convert-to-employee form (prefilled from the candidate). */
interface ConvForm {
  full_name: string;
  phone10: string;
  email: string;
  department_id: string;
  sub_department_id: string;
  designation_id: string;
  employment_type: string;
  joining_date: string;
  home_outlet_id: string;
}

/** Friendly labels for the free-label onboarding items the API seeds. */
const ITEM_LABELS: Record<string, string> = {
  kyc: 'KYC',
  bank: 'Bank details',
  documents: 'Documents',
  offer_letter: 'Offer letter',
  appointment_letter: 'Appointment letter',
  uniform: 'Uniform',
  id_card: 'ID card',
  system_access: 'System access',
  sop_assignment: 'SOP assignment',
  training: 'Training',
  introduction: 'Introduction',
  biometric: 'Biometric enrolment',
};

function itemLabel(item: string): string {
  if (ITEM_LABELS[item]) return ITEM_LABELS[item];
  return item.split(/[_\s]+/).filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || item;
}

/** ₹ money for on-page display (never used in exports). */
function fmtMoney(n: number | null): string {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '';
  return `₹${Number(n).toLocaleString('en-IN')}`;
}

export default function HrRecruitmentPage() {
  // ── Pipeline board state ────────────────────────────────────────────────
  const [rows, setRows] = useState<CandidateRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRejected, setShowRejected] = useState(false);

  // ── Filters ─────────────────────────────────────────────────────────────
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');
  const [deptId, setDeptId] = useState('');

  // ── Picker data ─────────────────────────────────────────────────────────
  const [departments, setDepartments] = useState<DeptRow[]>([]);
  const [designations, setDesignations] = useState<DesigRow[]>([]);
  const [outlets, setOutlets] = useState<OutletRow[]>([]);
  const [employees, setEmployees] = useState<EmpPickRow[]>([]);

  // ── Candidate create/edit modal ─────────────────────────────────────────
  const [modal, setModal] = useState<
    | { mode: 'create' }
    | { mode: 'edit'; candidate: CandidateRow }
    | null
  >(null);
  const [candForm, setCandForm] = useState<CandForm>(emptyCandForm());
  const [candSaving, setCandSaving] = useState(false);
  const [candError, setCandError] = useState<string | null>(null);
  const [stageBusy, setStageBusy] = useState(false);

  // ── Convert modal ───────────────────────────────────────────────────────
  const [convertFor, setConvertFor] = useState<CandidateRow | null>(null);
  const [convForm, setConvForm] = useState<ConvForm | null>(null);
  const [converting, setConverting] = useState(false);
  const [convError, setConvError] = useState<string | null>(null);
  const [convDone, setConvDone] = useState<{ id: string; code: string; name: string } | null>(null);

  // ── Onboarding panel ────────────────────────────────────────────────────
  const [obEmpId, setObEmpId] = useState('');
  const [obItems, setObItems] = useState<HrOnboardingItem[]>([]);
  const [obLoading, setObLoading] = useState(false);
  const [obError, setObError] = useState<string | null>(null);
  const [obSeeding, setObSeeding] = useState(false);
  const [obBusyItemId, setObBusyItemId] = useState('');

  // Race guard: a stale response must never overwrite a newer one
  // (pattern copied from the exemplar page).
  const fetchSeq = useRef(0);
  const obSeq = useRef(0);

  // Debounce the search box (300ms)
  useEffect(() => {
    const t = setTimeout(() => setQ(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const fetchCandidates = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setFetching(true);
    setError(null);
    try {
      const sp = new URLSearchParams();
      if (q) sp.set('q', q);
      if (deptId) sp.set('department_id', deptId);
      sp.set('page', '1');
      sp.set('pageSize', '100'); // API cap — the board shows the 100 most recent
      const res = await fetch(`/api/hr/candidates?${sp.toString()}`);
      if (seq !== fetchSeq.current) return;
      if (!res.ok) {
        setError(res.status === 401 || res.status === 403
          ? 'You need management access to view recruitment.'
          : "Couldn't load candidates");
        return;
      }
      const json = await res.json();
      if (seq !== fetchSeq.current) return;
      setRows(Array.isArray(json?.rows) ? json.rows : []);
      setTotal(Number(json?.total) || 0);
    } catch {
      if (seq === fetchSeq.current) setError("Couldn't load candidates");
    } finally {
      if (seq === fetchSeq.current) { setFetching(false); setLoading(false); }
    }
  }, [q, deptId]);

  useEffect(() => { fetchCandidates(); }, [fetchCandidates]);

  const fetchEmployeesPicker = useCallback(() => {
    fetch('/api/hr/employees?pageSize=100')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(j => setEmployees(Array.isArray(j?.rows) ? j.rows : []))
      .catch(() => {});
  }, []);

  // Picker data — one fetch each on mount (bare fetch is fine for GETs)
  useEffect(() => {
    fetch('/api/departments')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(j => setDepartments(Array.isArray(j?.departments) ? j.departments : []))
      .catch(() => {});
    fetch('/api/hr/designations')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(j => setDesignations(Array.isArray(j?.designations) ? j.designations : []))
      .catch(() => {});
    fetch('/api/outlets')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(j => setOutlets(Array.isArray(j?.outlets) ? j.outlets : []))
      .catch(() => {});
    fetchEmployeesPicker();
  }, [fetchEmployeesPicker]);

  // ── Department helpers ──────────────────────────────────────────────────
  const deptById = useMemo(() => new Map(departments.map(d => [d.id, d])), [departments]);
  const mains = useMemo(
    () => departments.filter(d => !d.parent_id && d.is_active).sort((a, b) => a.name.localeCompare(b.name)),
    [departments],
  );
  const subsOf = useCallback(
    (parentId: string) =>
      departments.filter(d => d.parent_id === parentId && d.is_active).sort((a, b) => a.name.localeCompare(b.name)),
    [departments],
  );

  /** All departments (subs carry their parent name as the hint). */
  const deptAllOptions = useMemo<ComboOption[]>(() => {
    const opts: ComboOption[] = [{ value: '', label: '(none)' }];
    for (const m of mains) {
      opts.push({ value: m.id, label: m.name });
      for (const s of subsOf(m.id)) opts.push({ value: s.id, label: s.name, hint: m.name });
    }
    return opts;
  }, [mains, subsOf]);

  const deptFilterOptions = useMemo<ComboOption[]>(
    () => [{ value: '', label: 'All departments' }, ...deptAllOptions.slice(1)],
    [deptAllOptions],
  );

  const mainOptions = useMemo<ComboOption[]>(
    () => [{ value: '', label: '(none)' }, ...mains.map(m => ({ value: m.id, label: m.name }))],
    [mains],
  );

  const desigOptions = useMemo<ComboOption[]>(
    () => [
      { value: '', label: '(none)' },
      ...designations
        .filter(d => d.is_active !== 0)
        .map(d => ({ value: d.id, label: d.name, hint: d.grade || undefined })),
    ],
    [designations],
  );
  const outletOptions = useMemo<ComboOption[]>(
    () => [{ value: '', label: '(stamp current outlet)' }, ...outlets.map(o => ({ value: o.id, label: o.name }))],
    [outlets],
  );
  const empOptions = useMemo<ComboOption[]>(
    () => employees.map(e => ({ value: e.id, label: e.full_name, hint: e.employee_code })),
    [employees],
  );

  // ── Board grouping ──────────────────────────────────────────────────────
  const byStage = useMemo(() => {
    const map = new Map<string, CandidateRow[]>();
    for (const r of rows) {
      const list = map.get(r.stage) || [];
      list.push(r);
      map.set(r.stage, list);
    }
    return map;
  }, [rows]);
  const rejectedCount = (byStage.get('rejected') || []).length;

  // ── Candidate modal open/save ───────────────────────────────────────────
  const openCreate = () => {
    setCandForm(emptyCandForm());
    setCandError(null);
    setModal({ mode: 'create' });
  };

  const openEdit = (c: CandidateRow) => {
    setCandForm({
      name: c.name || '',
      phone10: c.phone10 || '',
      email: c.email || '',
      position: c.position || '',
      department_id: c.department_id || '',
      joining_date: c.joining_date || '',
      interview_score: c.interview_score === null || c.interview_score === undefined ? '' : String(c.interview_score),
      expected_salary: c.expected_salary === null || c.expected_salary === undefined ? '' : String(c.expected_salary),
      offered_salary: c.offered_salary === null || c.offered_salary === undefined ? '' : String(c.offered_salary),
      resume_note: c.resume_note || '',
      note: c.note || '',
    });
    setCandError(null);
    setModal({ mode: 'edit', candidate: c });
  };

  const saveCandidate = async () => {
    if (!modal) return;
    if (!candForm.name.trim()) { setCandError('Candidate name is required.'); return; }
    setCandSaving(true);
    setCandError(null);
    const fields = {
      name: candForm.name.trim(),
      phone10: candForm.phone10,
      email: candForm.email.trim(),
      position: candForm.position.trim(),
      department_id: candForm.department_id,
      joining_date: candForm.joining_date,
      interview_score: candForm.interview_score,
      expected_salary: candForm.expected_salary,
      offered_salary: candForm.offered_salary,
      resume_note: candForm.resume_note,
      note: candForm.note,
    };
    try {
      if (modal.mode === 'create') {
        await apiJson('/api/hr/candidates', { method: 'POST', body: fields });
      } else {
        await apiJson('/api/hr/candidates', {
          method: 'PATCH',
          body: { id: modal.candidate.id, ...fields },
        });
      }
      setModal(null);
      fetchCandidates();
    } catch (e: unknown) {
      setCandError(e instanceof Error ? e.message : 'Could not save the candidate');
    } finally {
      setCandSaving(false);
    }
  };

  /** Validated stage move from the edit modal (never 'joined' — convert only). */
  const setStage = async (stage: HrCandidateStage) => {
    if (!modal || modal.mode !== 'edit' || stageBusy) return;
    setStageBusy(true);
    setCandError(null);
    try {
      const res = await apiJson<{ candidate: CandidateRow }>('/api/hr/candidates', {
        method: 'PATCH',
        body: { id: modal.candidate.id, stage },
      });
      if (res?.candidate) {
        setModal({ mode: 'edit', candidate: res.candidate });
        setRows(prev => prev.map(r => (r.id === res.candidate.id ? res.candidate : r)));
        if (stage === 'rejected') setShowRejected(true);
      }
    } catch (e: unknown) {
      setCandError(e instanceof Error ? e.message : 'Could not change the stage');
    } finally {
      setStageBusy(false);
    }
  };

  // ── Convert flow ────────────────────────────────────────────────────────
  const openConvert = (c: CandidateRow) => {
    // Derive main/sub from the candidate's department (which may be a sub row).
    let main = '';
    let sub = '';
    const d = c.department_id ? deptById.get(c.department_id) : undefined;
    if (d) {
      if (d.parent_id) { main = d.parent_id; sub = d.id; } else { main = d.id; }
    }
    setConvForm({
      full_name: c.name || '',
      phone10: c.phone10 || '',
      email: c.email || '',
      department_id: main,
      sub_department_id: sub,
      designation_id: '',
      employment_type: 'permanent',
      joining_date: c.joining_date || '',
      home_outlet_id: '',
    });
    setConvError(null);
    setConvDone(null);
    setModal(null);
    setConvertFor(c);
  };

  const doConvert = async () => {
    if (!convertFor || !convForm) return;
    if (!convForm.full_name.trim()) { setConvError('Employee name is required.'); return; }
    setConverting(true);
    setConvError(null);
    try {
      const body: Record<string, unknown> = {
        action: 'convert',
        candidate_id: convertFor.id,
        full_name: convForm.full_name.trim(),
        phone10: convForm.phone10,
        email: convForm.email.trim(),
        department_id: convForm.department_id,
        sub_department_id: convForm.sub_department_id,
        designation_id: convForm.designation_id,
        employment_type: convForm.employment_type,
        joining_date: convForm.joining_date,
      };
      // Only send home_outlet_id when picked — an absent key lets the server
      // stamp the current outlet (explicit '' means "deliberately none").
      if (convForm.home_outlet_id) body.home_outlet_id = convForm.home_outlet_id;

      const res = await apiJson<{ employee: { id: string; employee_code: string; full_name: string } }>(
        '/api/hr/candidates',
        { method: 'POST', body },
      );
      if (res?.employee?.id) {
        setConvDone({
          id: res.employee.id,
          code: res.employee.employee_code || '',
          name: res.employee.full_name || convForm.full_name.trim(),
        });
        // The convert seeds the onboarding checklist server-side — point the
        // panel straight at the new employee.
        setObEmpId(res.employee.id);
        fetchEmployeesPicker();
      }
      fetchCandidates();
    } catch (e: unknown) {
      setConvError(e instanceof Error ? e.message : 'Could not convert the candidate');
    } finally {
      setConverting(false);
    }
  };

  // ── Onboarding panel ────────────────────────────────────────────────────
  const loadChecklist = useCallback(async (empId: string) => {
    if (!empId) { setObItems([]); setObError(null); return; }
    const seq = ++obSeq.current;
    setObLoading(true);
    setObError(null);
    try {
      const res = await fetch(`/api/hr/onboarding?employee_id=${encodeURIComponent(empId)}`);
      if (seq !== obSeq.current) return;
      if (!res.ok) { setObError("Couldn't load the onboarding checklist"); return; }
      const json = await res.json();
      if (seq !== obSeq.current) return;
      setObItems(Array.isArray(json?.items) ? json.items : []);
    } catch {
      if (seq === obSeq.current) setObError("Couldn't load the onboarding checklist");
    } finally {
      if (seq === obSeq.current) setObLoading(false);
    }
  }, []);

  useEffect(() => { loadChecklist(obEmpId); }, [obEmpId, loadChecklist]);

  const seedChecklist = async () => {
    if (!obEmpId || obSeeding) return;
    setObSeeding(true);
    setObError(null);
    try {
      const res = await apiJson<{ items: HrOnboardingItem[] }>('/api/hr/onboarding', {
        method: 'POST',
        body: { employee_id: obEmpId },
      });
      setObItems(Array.isArray(res?.items) ? res.items : []);
    } catch (e: unknown) {
      setObError(e instanceof Error ? e.message : 'Could not seed the checklist');
    } finally {
      setObSeeding(false);
    }
  };

  const toggleItem = async (item: HrOnboardingItem, next: boolean) => {
    if (obBusyItemId) return;
    setObBusyItemId(item.id);
    setObError(null);
    try {
      const res = await apiJson<{ item: HrOnboardingItem }>('/api/hr/onboarding', {
        method: 'PATCH',
        body: { id: item.id, done: next },
      });
      if (res?.item) {
        setObItems(prev => prev.map(i => (i.id === res.item.id ? res.item : i)));
      }
    } catch (e: unknown) {
      setObError(e instanceof Error ? e.message : 'Could not update the checklist item');
    } finally {
      setObBusyItemId('');
    }
  };

  const obDone = obItems.filter(i => !!i.done).length;
  const obPct = obItems.length > 0 ? Math.round((obDone / obItems.length) * 100) : 0;
  const obEmployee = employees.find(e => e.id === obEmpId);

  // ── Shared bits ─────────────────────────────────────────────────────────
  const inputCls = 'w-full px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm';
  const deptFilterLabel = deptId ? (deptById.get(deptId)?.name || '') : '';
  const editingCandidate = modal?.mode === 'edit' ? modal.candidate : null;
  const editingStageIdx = editingCandidate ? PIPELINE.indexOf(editingCandidate.stage as HrCandidateStage) : -1;

  const renderCard = (c: CandidateRow) => {
    const scoreSet = c.interview_score !== null && c.interview_score !== undefined;
    return (
      <div
        key={c.id}
        onClick={() => openEdit(c)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEdit(c); } }}
        className="bg-white border border-[#E8D5C4] rounded-lg shadow-sm hover:shadow hover:border-[#af4408]/40 p-3 cursor-pointer space-y-1.5"
      >
        <div className="font-bold text-sm text-[#2D1B0E] leading-tight">{c.name}</div>
        {c.position && <div className="text-xs text-[#8B7355]">{c.position}</div>}
        {c.phone10 && <div className="text-xs font-mono text-[#6B5744]">{c.phone10}</div>}
        {(c.expected_salary !== null || c.offered_salary !== null) && (
          <div className="text-xs text-[#6B5744] flex flex-wrap gap-x-3">
            {c.expected_salary !== null && <span>Exp {fmtMoney(c.expected_salary)}</span>}
            {c.offered_salary !== null && <span className="font-medium">Off {fmtMoney(c.offered_salary)}</span>}
          </div>
        )}
        {scoreSet && (
          <span className="inline-flex px-1.5 py-0.5 rounded-full text-[10px] font-medium border bg-indigo-100 text-indigo-700 border-indigo-200">
            Score {c.interview_score}
          </span>
        )}
        {c.stage === 'joined' && c.employee_id ? (
          <div className="pt-1 border-t border-[#E8D5C4]/60 flex items-center justify-between gap-2">
            <span className="text-[10px] font-mono text-[#8B7355]">{c.employee_code || ''}</span>
            <Link
              href={`/hr/employees/${c.employee_id}`}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-[#af4408] hover:underline"
            >
              View employee <ExternalLink className="w-3 h-3" />
            </Link>
          </div>
        ) : CONVERTIBLE.includes(c.stage as HrCandidateStage) ? (
          <div className="pt-1">
            <button
              onClick={(e) => { e.stopPropagation(); openConvert(c); }}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium bg-[#af4408] hover:bg-[#8a3506] text-white"
            >
              <UserCheck className="w-3 h-3" /> Convert to employee
            </button>
          </div>
        ) : null}
      </div>
    );
  };

  const renderLane = (stage: HrCandidateStage, extraHeader?: ReactNode) => {
    const meta = candidateStageMeta(stage);
    const list = byStage.get(stage) || [];
    return (
      <div key={stage} className="w-64 shrink-0">
        <div className="flex items-center justify-between gap-2 px-1 pb-2">
          <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border ${meta.color}`}>
            {meta.label}
          </span>
          <span className="text-xs text-[#8B7355]">{list.length}</span>
          {extraHeader}
        </div>
        <div className="space-y-2 rounded-xl bg-[#FFF1E3]/50 border border-[#E8D5C4]/60 p-2 min-h-[64px]">
          {list.length === 0 ? (
            <div className="text-xs text-[#8B7355] px-1 py-2">No candidates</div>
          ) : (
            list.map(renderCard)
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">

        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-2">
              <HeartHandshake className="w-6 h-6" /> Recruitment
            </h1>
            <p className="text-[#8B7355] text-sm mt-1">
              Candidate pipeline{loading ? '' : ` — ${total} candidate${total === 1 ? '' : 's'}`}, convert-to-employee and onboarding.
            </p>
          </div>
          <button onClick={openCreate}
                  className="inline-flex items-center gap-2 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium">
            <Plus className="w-4 h-4" /> Add Candidate
          </button>
        </div>

        {/* Filters */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 flex-1 min-w-[200px]">
              <Search className="w-4 h-4 text-[#8B7355]" />
              <input value={searchInput} onChange={e => setSearchInput(e.target.value)}
                     placeholder="Name, phone, email, position…"
                     className="flex-1 px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
            </div>
            <div className="w-full sm:w-64">
              <Combobox
                options={deptFilterOptions}
                value={deptFilterLabel}
                onChange={(v) => setDeptId(v)}
                placeholder="All departments"
              />
            </div>
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm flex items-center justify-between gap-3">
            <span>{error}</span>
            <button onClick={() => fetchCandidates()}
                    className="shrink-0 px-3 py-1.5 border border-red-200 rounded-lg text-xs font-medium hover:bg-red-100">
              Retry
            </button>
          </div>
        )}

        {/* Pipeline board */}
        {loading ? (
          <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-6 flex items-center justify-center gap-2 text-[#8B7355] text-sm">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading...
          </div>
        ) : rows.length === 0 && !error ? (
          <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-6 text-center text-[#8B7355] text-sm">
            {q || deptId ? 'No candidates match these filters.' : 'No candidates yet — add the first one.'}
          </div>
        ) : (
          <div className={fetching ? 'opacity-60' : ''}>
            {total > rows.length && (
              <p className="text-xs text-[#8B7355] mb-2">
                Showing the {rows.length} most recent of {total} candidates — search to narrow.
              </p>
            )}
            <div className="overflow-x-auto pb-2">
              <div className="flex items-start gap-3 min-w-max">
                {BOARD_LANES.map(stage => renderLane(stage))}
                {showRejected ? (
                  renderLane(
                    'rejected',
                    <button onClick={() => setShowRejected(false)}
                            className="text-[11px] text-[#8B7355] hover:text-[#af4408] font-medium">
                      Hide
                    </button>,
                  )
                ) : (
                  <button
                    onClick={() => setShowRejected(true)}
                    className="w-44 shrink-0 rounded-xl border border-dashed border-[#E8D5C4] bg-white/60 hover:bg-white px-3 py-4 text-left"
                  >
                    <span className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border bg-rose-100 text-rose-700 border-rose-200">
                      Rejected
                    </span>
                    <div className="text-xs text-[#8B7355] mt-2">
                      {rejectedCount} candidate{rejectedCount === 1 ? '' : 's'} — tap to show
                    </div>
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Onboarding panel */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-bold text-[#2D1B0E] flex items-center gap-2">
              <ClipboardCheck className="w-5 h-5 text-[#af4408]" /> Onboarding
            </h2>
            <div className="w-full sm:w-72">
              <Combobox
                options={empOptions}
                value={obEmployee ? obEmployee.full_name : ''}
                onChange={(v) => setObEmpId(v)}
                placeholder="Pick an employee…"
              />
            </div>
          </div>

          {obError && (
            <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
              {obError}
            </div>
          )}

          {!obEmpId ? (
            <p className="text-sm text-[#8B7355]">
              Pick an employee to see their onboarding checklist.
            </p>
          ) : obLoading ? (
            <div className="flex items-center gap-2 text-[#8B7355] text-sm py-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading...
            </div>
          ) : (
            <>
              {/* Completion bar */}
              <div className="flex items-center gap-3">
                <div className="flex-1 h-2 rounded-full bg-[#FFF1E3] border border-[#E8D5C4]/60 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${obPct === 100 ? 'bg-green-500' : 'bg-[#af4408]'}`}
                    style={{ width: `${obPct}%` }}
                  />
                </div>
                <span className="text-xs text-[#6B5744] whitespace-nowrap">
                  {obDone}/{obItems.length} done ({obPct}%)
                </span>
              </div>

              {obItems.length === 0 ? (
                <div className="text-center py-4 space-y-3">
                  <p className="text-sm text-[#8B7355]">No checklist yet for this employee.</p>
                  <button onClick={seedChecklist} disabled={obSeeding}
                          className="inline-flex items-center gap-2 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium disabled:opacity-50">
                    {obSeeding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                    Seed standard checklist
                  </button>
                </div>
              ) : (
                <>
                  <ul className="divide-y divide-[#E8D5C4]/50">
                    {obItems.map(item => (
                      <li key={item.id} className="py-2 flex items-center gap-3">
                        <Toggle
                          size="sm"
                          checked={!!item.done}
                          disabled={obBusyItemId === item.id}
                          onChange={(next) => toggleItem(item, next)}
                          label={`Mark ${itemLabel(item.item)} ${item.done ? 'pending' : 'done'}`}
                        />
                        <span className={`text-sm flex-1 ${item.done ? 'text-[#8B7355] line-through' : 'text-[#2D1B0E]'}`}>
                          {itemLabel(item.item)}
                        </span>
                        {!!item.done && item.done_at && (
                          <span className="text-[11px] text-[#8B7355] whitespace-nowrap">
                            {item.done_by ? `${item.done_by} · ` : ''}{fmtIST(item.done_at)}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                  <div className="flex justify-end">
                    <button onClick={seedChecklist} disabled={obSeeding}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 border border-[#E8D5C4] bg-white hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-xs font-medium disabled:opacity-50">
                      {obSeeding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                      Seed standard checklist
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {/* Candidate create/edit modal — house safe-modal shell */}
        {modal && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
            <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
                 className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-lg shadow-xl flex flex-col overflow-hidden">
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E]">
                  {modal.mode === 'create' ? 'Add Candidate' : 'Edit Candidate'}
                </h2>
                <button onClick={() => { if (!candSaving && !stageBusy) setModal(null); }} className="text-[#8B7355]">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
                {candError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
                    {candError}
                  </div>
                )}

                {/* Stage controls (edit only) */}
                {editingCandidate && (
                  <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-[#6B5744]">Stage</span>
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border ${candidateStageMeta(editingCandidate.stage).color}`}>
                        {candidateStageMeta(editingCandidate.stage).label}
                      </span>
                      {stageBusy && <Loader2 className="w-3.5 h-3.5 animate-spin text-[#8B7355]" />}
                    </div>
                    {editingCandidate.employee_id ? (
                      <div className="text-xs text-[#8B7355] flex items-center gap-2 flex-wrap">
                        <span>Joined — the stage is locked.</span>
                        <Link href={`/hr/employees/${editingCandidate.employee_id}`}
                              className="inline-flex items-center gap-1 font-medium text-[#af4408] hover:underline">
                          View employee <ExternalLink className="w-3 h-3" />
                        </Link>
                      </div>
                    ) : editingCandidate.stage === 'rejected' ? (
                      <button onClick={() => setStage('applied')} disabled={stageBusy}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-[#E8D5C4] bg-white hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-xs font-medium disabled:opacity-50">
                        <ArrowLeft className="w-3.5 h-3.5" /> Reopen as Applied
                      </button>
                    ) : editingStageIdx >= 0 ? (
                      <div className="flex flex-wrap items-center gap-2">
                        {editingStageIdx > 0 && (
                          <button onClick={() => setStage(PIPELINE[editingStageIdx - 1])} disabled={stageBusy}
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-[#E8D5C4] bg-white hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-xs font-medium disabled:opacity-50">
                            <ArrowLeft className="w-3.5 h-3.5" /> {candidateStageMeta(PIPELINE[editingStageIdx - 1]).label}
                          </button>
                        )}
                        {editingStageIdx < PIPELINE.length - 1 && (
                          <button onClick={() => setStage(PIPELINE[editingStageIdx + 1])} disabled={stageBusy}
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-xs font-medium disabled:opacity-50">
                            {candidateStageMeta(PIPELINE[editingStageIdx + 1]).label} <ArrowRight className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {CONVERTIBLE.includes(editingCandidate.stage as HrCandidateStage) && (
                          <button onClick={() => openConvert(editingCandidate)} disabled={stageBusy}
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded-lg text-xs font-medium disabled:opacity-50">
                            <UserCheck className="w-3.5 h-3.5" /> Convert to employee
                          </button>
                        )}
                        <button onClick={() => setStage('rejected')} disabled={stageBusy}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-rose-200 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded-lg text-xs font-medium disabled:opacity-50">
                          Reject
                        </button>
                      </div>
                    ) : null}
                    <p className="text-[10px] text-[#8B7355]">
                      &lsquo;Joined&rsquo; is set only by Convert to employee.
                    </p>
                  </div>
                )}

                {/* Fields */}
                <div className="space-y-3">
                  <div>
                    <label className="text-xs text-[#6B5744]">Name *</label>
                    <input value={candForm.name} onChange={e => setCandForm({ ...candForm, name: e.target.value })}
                           placeholder="e.g. Ravi Kumar" className={inputCls} autoFocus={modal.mode === 'create'} />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-[#6B5744]">Phone</label>
                      <PhoneField value={candForm.phone10} onChange={v => setCandForm({ ...candForm, phone10: v })} />
                    </div>
                    <div>
                      <label className="text-xs text-[#6B5744]">Email</label>
                      <input type="email" value={candForm.email}
                             onChange={e => setCandForm({ ...candForm, email: e.target.value })}
                             className={inputCls} />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-[#6B5744]">Position applied for</label>
                      <input value={candForm.position}
                             onChange={e => setCandForm({ ...candForm, position: e.target.value })}
                             placeholder="e.g. Commis Chef" className={inputCls} />
                    </div>
                    <div>
                      <label className="text-xs text-[#6B5744]">Department</label>
                      <Combobox
                        options={deptAllOptions}
                        value={candForm.department_id ? (deptById.get(candForm.department_id)?.name || '') : ''}
                        onChange={(v) => setCandForm({ ...candForm, department_id: v })}
                        placeholder="Pick department"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="text-xs text-[#6B5744]">Interview score</label>
                      <input type="number" min={0} step="0.5" value={candForm.interview_score}
                             onChange={e => setCandForm({ ...candForm, interview_score: e.target.value })}
                             placeholder="—" className={inputCls} />
                    </div>
                    <div>
                      <label className="text-xs text-[#6B5744]">Expected salary</label>
                      <input type="number" min={0} value={candForm.expected_salary}
                             onChange={e => setCandForm({ ...candForm, expected_salary: e.target.value })}
                             placeholder="₹ / month" className={inputCls} />
                    </div>
                    <div>
                      <label className="text-xs text-[#6B5744]">Offered salary</label>
                      <input type="number" min={0} value={candForm.offered_salary}
                             onChange={e => setCandForm({ ...candForm, offered_salary: e.target.value })}
                             placeholder="₹ / month" className={inputCls} />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-[#6B5744]">Expected joining date</label>
                    <input type="date" value={candForm.joining_date}
                           onChange={e => setCandForm({ ...candForm, joining_date: e.target.value })}
                           className={inputCls} />
                  </div>
                  <div>
                    <label className="text-xs text-[#6B5744]">Resume note</label>
                    <textarea value={candForm.resume_note} rows={2}
                              onChange={e => setCandForm({ ...candForm, resume_note: e.target.value })}
                              placeholder="Experience, referral, CV highlights…" className={inputCls} />
                  </div>
                  <div>
                    <label className="text-xs text-[#6B5744]">Note</label>
                    <textarea value={candForm.note} rows={2}
                              onChange={e => setCandForm({ ...candForm, note: e.target.value })}
                              className={inputCls} />
                  </div>
                </div>
              </div>

              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
                <button onClick={() => setModal(null)} disabled={candSaving || stageBusy}
                        className="px-3 py-2 text-sm text-[#6B5744] disabled:opacity-50">
                  Cancel
                </button>
                <button onClick={saveCandidate} disabled={candSaving || stageBusy}
                        className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
                  {candSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Convert modal — house safe-modal shell */}
        {convertFor && convForm && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
            <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
                 className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-lg shadow-xl flex flex-col overflow-hidden">
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E] flex items-center gap-2">
                  <UserCheck className="w-5 h-5 text-[#af4408]" /> Convert to Employee
                </h2>
                <button onClick={() => { if (!converting) { setConvertFor(null); setConvForm(null); } }}
                        className="text-[#8B7355]">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
                {convDone ? (
                  <div className="space-y-4 text-center py-4">
                    <div className="rounded-lg border border-green-200 bg-green-50 text-green-800 px-4 py-3 text-sm">
                      <span className="font-bold">{convDone.name}</span> is now employee{' '}
                      <span className="font-mono font-bold">{convDone.code}</span>.
                      The standard onboarding checklist has been seeded — it is loaded in the
                      Onboarding panel below.
                    </div>
                    <div className="flex items-center justify-center gap-2">
                      <Link href={`/hr/employees/${convDone.id}`}
                            className="inline-flex items-center gap-2 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium">
                        Open employee profile <ExternalLink className="w-4 h-4" />
                      </Link>
                      <button onClick={() => { setConvertFor(null); setConvForm(null); }}
                              className="px-3 py-2 text-sm text-[#6B5744] border border-[#E8D5C4] rounded-lg hover:bg-[#FFF1E3]">
                        Close
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {convError && (
                      <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
                        {convError}
                      </div>
                    )}
                    <p className="text-xs text-[#8B7355]">
                      Creates the employee record from this candidate, marks the candidate
                      &lsquo;Joined&rsquo; and seeds the onboarding checklist. Everything else
                      (photo, addresses, login link…) is added on the profile afterwards.
                    </p>

                    <div className="space-y-3">
                      <div>
                        <label className="text-xs text-[#6B5744]">Full name *</label>
                        <input value={convForm.full_name}
                               onChange={e => setConvForm({ ...convForm, full_name: e.target.value })}
                               className={inputCls} />
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="text-xs text-[#6B5744]">Phone</label>
                          <PhoneField value={convForm.phone10}
                                      onChange={v => setConvForm({ ...convForm, phone10: v })} />
                        </div>
                        <div>
                          <label className="text-xs text-[#6B5744]">Email</label>
                          <input type="email" value={convForm.email}
                                 onChange={e => setConvForm({ ...convForm, email: e.target.value })}
                                 className={inputCls} />
                        </div>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="text-xs text-[#6B5744]">Department</label>
                          <Combobox
                            options={mainOptions}
                            value={convForm.department_id ? (deptById.get(convForm.department_id)?.name || '') : ''}
                            onChange={(v) => setConvForm({ ...convForm, department_id: v, sub_department_id: '' })}
                            placeholder="Pick department"
                          />
                        </div>
                        <div>
                          <label className="text-xs text-[#6B5744]">Sub-department</label>
                          {!convForm.department_id || subsOf(convForm.department_id).length === 0 ? (
                            <input disabled
                                   placeholder={!convForm.department_id ? 'Pick department first' : 'No sub-departments'}
                                   className={`${inputCls} opacity-60`} />
                          ) : (
                            <Combobox
                              options={[
                                { value: '', label: '(none)' },
                                ...subsOf(convForm.department_id).map(s => ({ value: s.id, label: s.name })),
                              ]}
                              value={convForm.sub_department_id ? (deptById.get(convForm.sub_department_id)?.name || '') : ''}
                              onChange={(v) => setConvForm({ ...convForm, sub_department_id: v })}
                              placeholder="Pick sub-department"
                            />
                          )}
                        </div>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="text-xs text-[#6B5744]">Designation</label>
                          <Combobox
                            options={desigOptions}
                            value={convForm.designation_id ? (designations.find(d => d.id === convForm.designation_id)?.name || '') : ''}
                            onChange={(v) => setConvForm({ ...convForm, designation_id: v })}
                            placeholder="Pick designation"
                          />
                        </div>
                        <div>
                          <label className="text-xs text-[#6B5744]">Employment type</label>
                          <select value={convForm.employment_type}
                                  onChange={e => setConvForm({ ...convForm, employment_type: e.target.value })}
                                  className={inputCls}>
                            {HR_EMPLOYMENT_TYPES.map(t => (
                              <option key={t.key} value={t.key}>{t.label}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="text-xs text-[#6B5744]">Joining date</label>
                          <input type="date" value={convForm.joining_date}
                                 onChange={e => setConvForm({ ...convForm, joining_date: e.target.value })}
                                 className={inputCls} />
                        </div>
                        <div>
                          <label className="text-xs text-[#6B5744]">Home outlet</label>
                          <Combobox
                            options={outletOptions}
                            value={convForm.home_outlet_id ? (outlets.find(o => o.id === convForm.home_outlet_id)?.name || '') : ''}
                            onChange={(v) => setConvForm({ ...convForm, home_outlet_id: v })}
                            placeholder="(stamp current outlet)"
                          />
                        </div>
                      </div>
                      {convertFor.offered_salary !== null && (
                        <p className="text-[11px] text-[#8B7355]">
                          Offered salary {fmtMoney(convertFor.offered_salary)} — record the salary
                          structure on the employee profile after converting.
                        </p>
                      )}
                    </div>
                  </>
                )}
              </div>

              {!convDone && (
                <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
                  <button onClick={() => { setConvertFor(null); setConvForm(null); }} disabled={converting}
                          className="px-3 py-2 text-sm text-[#6B5744] disabled:opacity-50">
                    Cancel
                  </button>
                  <button onClick={doConvert} disabled={converting}
                          className="px-3 py-2 text-sm bg-green-600 hover:bg-green-700 text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
                    {converting ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserCheck className="w-4 h-4" />}
                    Convert
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
