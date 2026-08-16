'use client';

/**
 * /hr/employees/[id] — Employee Profile (HRMS Phase 1).
 *
 * Contract: docs/HRMS_DECISIONS.md. Three tabs only in Phase 1 —
 * Overview / Personal / Employment (later phases append more; see the
 * PHASE 2+ INSERTION POINT comment at the tab strip).
 *
 *  - Overview: identity card (photo/initials, code, status badge), the
 *    linked-login card (link/unlink a users row via PUT user_id — 409 from the
 *    idx_hr_emp_user UNIQUE index is surfaced verbatim), and the status card
 *    (PATCH set_status with a required note). Per contract D1, HR never writes
 *    the users table: when the API answers suggest_deactivate_login=true we
 *    only SHOW an amber pointer to /users — deactivation stays an explicit
 *    admin action there.
 *  - Personal / Employment: each tab saves ONLY its own fields via one PUT.
 *
 * All mutations go through api() from '@/lib/api' (CSRF header — /api/hr is a
 * CSRF-required prefix). Bare fetch is used for GETs only.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowLeft,
  Camera,
  Check,
  ExternalLink,
  Link2,
  Loader2,
  Pencil,
  Save,
  Unlink,
  User,
  X,
} from 'lucide-react';
import { api } from '@/lib/api';
import { fmtIST, fmtISTDate } from '@/lib/format-date';
import {
  HR_EMPLOYEE_STATUSES,
  HR_EMPLOYMENT_TYPES,
  employeeStatusMeta,
  employmentTypeMeta,
  isHrEmployeeStatus,
  isHrEmploymentType,
  type HrEmployeeListRow,
} from '@/lib/hr';
import TabScroller from '@/components/TabScroller';
import Combobox, { type ComboOption } from '@/components/Combobox';
import PhoneField from '@/components/PhoneField';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

/** GET /api/hr/employees/[id] → { employee } (joined names + linked login + outlets). */
interface EmployeeDetail extends HrEmployeeListRow {
  linked_user_name?: string | null;
  /** outlet ids from hr_employee_outlets (the "additional outlets" set). */
  outlets?: string[];
  /** Full base64 data URI — the [id] GET keeps it even though LIST rows ship
   *  has_photo (0/1) instead. Redeclared so this page never depends on the
   *  list-row projection carrying it. */
  photo: string;
}

interface DeptRow { id: string; name: string; parent_id: string | null; is_active: number }
interface OutletRow { id: string; name: string }
interface DesigRow { id: string; name: string; grade: string; is_active: number }
interface UserRow { id: string; name: string; email: string }
interface EmpPickRow { id: string; full_name: string; employee_code: string }

interface PersonalDraft {
  dob: string;
  gender: string;
  phone10: string;
  alt_phone10: string;
  email: string;
  current_address: string;
  permanent_address: string;
  emergency_name: string;
  emergency_relation: string;
  emergency_phone10: string;
}

interface EmploymentDraft {
  department_id: string;
  sub_department_id: string;
  designation_id: string;
  grade: string;
  reporting_manager_id: string;
  employment_type: string;
  employee_category: string;
  cost_centre: string;
  work_location: string;
  home_outlet_id: string;
  joining_date: string;
  probation_months: number;
  confirmation_date: string;
  notice_period_days: number;
  exit_date: string;
  notes: string;
  outlets: string[];
}

const personalFromEmp = (e: EmployeeDetail): PersonalDraft => ({
  dob: e.dob || '',
  // Lowercase keys everywhere ('male'|'female'|'other'|'') — server lowercases
  // on write; this normalises any pre-convention capitalised value on read.
  gender: (e.gender || '').toLowerCase(),
  phone10: e.phone10 || '',
  alt_phone10: e.alt_phone10 || '',
  email: e.email || '',
  current_address: e.current_address || '',
  permanent_address: e.permanent_address || '',
  emergency_name: e.emergency_name || '',
  emergency_relation: e.emergency_relation || '',
  emergency_phone10: e.emergency_phone10 || '',
});

const employmentFromEmp = (e: EmployeeDetail): EmploymentDraft => ({
  department_id: e.department_id || '',
  sub_department_id: e.sub_department_id || '',
  designation_id: e.designation_id || '',
  grade: e.grade || '',
  reporting_manager_id: e.reporting_manager_id || '',
  employment_type: e.employment_type || 'permanent',
  employee_category: e.employee_category || '',
  cost_centre: e.cost_centre || '',
  work_location: e.work_location || '',
  home_outlet_id: e.home_outlet_id || '',
  joining_date: e.joining_date || '',
  probation_months: Number(e.probation_months) || 0,
  confirmation_date: e.confirmation_date || '',
  notice_period_days: Number(e.notice_period_days) || 0,
  exit_date: e.exit_date || '',
  notes: e.notes || '',
  outlets: Array.isArray(e.outlets) ? [...e.outlets] : [],
});

/* ------------------------------------------------------------------ *
 * Small display helpers
 * ------------------------------------------------------------------ */

const inputCls =
  'w-full px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm focus:outline-none focus:border-[#af4408]';

const initialsOf = (name: string): string =>
  name.trim().split(/\s+/).slice(0, 2).map((w) => (w[0] || '').toUpperCase()).join('') || '?';

/** Statuses that make the optional exit-date field appear in the status modal
 *  (mirrors EXIT_STATUSES in the API route). */
const EXIT_STATUSES = new Set<string>(['resigned', 'terminated', 'former']);

/* ------------------------------------------------------------------ *
 * Client-side photo compression — copied from
 * src/app/tasks/_components/ImageUpload.tsx (that component renders its own
 * thumbnail strip + picker tile; here we need the bare helper wired to the
 * avatar and a PUT). Downscale to ~1200px, JPEG quality ladder, white matte,
 * ~250KB data-URI target — comfortably under the server's 400k-char cap.
 * ------------------------------------------------------------------ */

const PHOTO_MAX_EDGE = 1200;           // px — longest side after downscale
const PHOTO_TARGET_BYTES = 250 * 1024; // ~250KB cap on the encoded data: URI
const PHOTO_START_QUALITY = 0.7;       // initial JPEG quality
const PHOTO_MIN_QUALITY = 0.4;         // don't go blurrier than this via quality

/** Rough byte size of a data: URI's payload (base64 is ~4/3 of raw bytes). */
function dataUriBytes(uri: string): number {
  const comma = uri.indexOf(',');
  const b64 = comma >= 0 ? uri.slice(comma + 1) : uri;
  return Math.floor((b64.length * 3) / 4);
}

/**
 * Read one File → downscaled image/jpeg data: URI under the size cap.
 * Draws to a canvas at max ~1200px, then lowers quality (and finally scale)
 * until the encoded payload fits ~250KB. Rejects non-images.
 */
async function fileToDataUri(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error(`${file.name || 'File'} is not an image`);
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(new Error('Could not read file'));
    fr.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('Could not decode image'));
    el.src = dataUrl;
  });

  let scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(img.width, img.height));

  const encodeAt = (s: number, q: number): string => {
    const w = Math.max(1, Math.round(img.width * s));
    const h = Math.max(1, Math.round(img.height * s));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas not supported');
    // White matte so transparent PNGs don't turn black under JPEG.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', q);
  };

  // First: drop quality at the target scale.
  let q = PHOTO_START_QUALITY;
  let out = encodeAt(scale, q);
  while (dataUriBytes(out) > PHOTO_TARGET_BYTES && q > PHOTO_MIN_QUALITY) {
    q = Math.max(PHOTO_MIN_QUALITY, q - 0.1);
    out = encodeAt(scale, q);
  }
  // Still too big at min quality: shrink the canvas in steps.
  while (dataUriBytes(out) > PHOTO_TARGET_BYTES && scale > 0.2) {
    scale *= 0.8;
    out = encodeAt(scale, PHOTO_MIN_QUALITY);
  }
  return out;
}

/** PhoneField stores +91 numbers as bare 10 digits; other countries as E.164. */
const fmtPhone = (p: string): string =>
  !p ? '—' : /^\d{10}$/.test(p) ? `+91 ${p.slice(0, 5)} ${p.slice(5)}` : p;

function StatusBadge({ status }: { status: string }) {
  const m = employeeStatusMeta(status);
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-xs font-medium ${m.color}`}>
      {m.label}
    </span>
  );
}

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'personal', label: 'Personal' },
  { key: 'employment', label: 'Employment' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export default function EmployeeProfilePage() {
  const params = useParams<{ id: string }>();
  const id = String(params?.id ?? '');
  const apiUrl = `/api/hr/employees/${encodeURIComponent(id)}`;

  const [emp, setEmp] = useState<EmployeeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('overview');

  // Pickers
  const [depts, setDepts] = useState<DeptRow[]>([]);
  const [outlets, setOutlets] = useState<OutletRow[]>([]);
  const [designations, setDesignations] = useState<DesigRow[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [employees, setEmployees] = useState<EmpPickRow[]>([]);

  // Tab drafts (initialised once from the loaded employee; re-initialised only
  // after that tab's OWN save, so editing one tab never clobbers the other).
  const [personalDraft, setPersonalDraft] = useState<PersonalDraft | null>(null);
  const [employmentDraft, setEmploymentDraft] = useState<EmploymentDraft | null>(null);

  // Link-login card
  const [linkUserId, setLinkUserId] = useState('');
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkErr, setLinkErr] = useState<string | null>(null);

  // Status modal
  const [statusModal, setStatusModal] = useState(false);
  const [statusVal, setStatusVal] = useState('');
  const [statusNote, setStatusNote] = useState('');
  const [statusExitDate, setStatusExitDate] = useState('');
  const [statusSaving, setStatusSaving] = useState(false);
  const [statusErr, setStatusErr] = useState<string | null>(null);
  const [suggestDeactivate, setSuggestDeactivate] = useState(false);

  // Photo editor (Overview identity card)
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoErr, setPhotoErr] = useState<string | null>(null);

  // Inline name edit (Overview identity card)
  const [nameEditing, setNameEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [nameBusy, setNameBusy] = useState(false);
  const [nameErr, setNameErr] = useState<string | null>(null);

  // Per-tab save state
  const [personalSaving, setPersonalSaving] = useState(false);
  const [personalErr, setPersonalErr] = useState<string | null>(null);
  const [personalOk, setPersonalOk] = useState(false);
  const [employmentSaving, setEmploymentSaving] = useState(false);
  const [employmentErr, setEmploymentErr] = useState<string | null>(null);
  const [employmentOk, setEmploymentOk] = useState(false);

  /* ---- data loading ---- */

  const load = useCallback(async (): Promise<EmployeeDetail | null> => {
    if (!id) { setLoading(false); setLoadErr('Missing employee id.'); return null; }
    try {
      const r = await fetch(apiUrl);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setLoadErr(j?.error || `Could not load this employee (HTTP ${r.status}).`);
        return null;
      }
      const e = j.employee as EmployeeDetail;
      setEmp(e);
      setLoadErr(null);
      return e;
    } catch {
      setLoadErr('Could not load this employee. Check your connection.');
      return null;
    } finally {
      setLoading(false);
    }
  }, [id, apiUrl]);

  useEffect(() => { load(); }, [load]);

  // First-load draft init only (null check keeps later reloads from clobbering edits).
  useEffect(() => {
    if (!emp) return;
    setPersonalDraft((d) => d ?? personalFromEmp(emp));
    setEmploymentDraft((d) => d ?? employmentFromEmp(emp));
  }, [emp]);

  // Picker data — each source fails independently; a dead picker never blanks the page.
  useEffect(() => {
    const grab = async (url: string) => {
      try {
        const r = await fetch(url);
        if (!r.ok) return null;
        return await r.json();
      } catch { return null; }
    };
    (async () => {
      const [dj, oj, gj, uj, ej] = await Promise.all([
        grab('/api/departments'),
        grab('/api/outlets'),
        grab('/api/hr/designations'),
        grab('/api/tasks/users'),
        grab('/api/hr/employees?pageSize=100'),
      ]);
      if (dj?.departments) setDepts((dj.departments as DeptRow[]).filter((d) => d.is_active));
      if (oj?.outlets) setOutlets(oj.outlets as OutletRow[]);
      if (gj?.designations) setDesignations((gj.designations as DesigRow[]).filter((d) => d.is_active));
      if (uj?.users) setUsers(uj.users as UserRow[]);
      if (ej?.rows) setEmployees(ej.rows as EmpPickRow[]);
    })();
  }, []);

  /* ---- picker options ---- */

  const NONE: ComboOption = useMemo(() => ({ value: '', label: '— None —' }), []);

  const mainDeptOptions = useMemo<ComboOption[]>(
    () => [NONE, ...depts.filter((d) => !d.parent_id).map((d) => ({ value: d.id, label: d.name }))],
    [depts, NONE],
  );

  const subDeptOptions = useMemo<ComboOption[]>(() => {
    const pid = employmentDraft?.department_id || '';
    const subs = depts.filter((d) => d.parent_id && (!pid || d.parent_id === pid));
    return [
      NONE,
      ...subs.map((d) => ({
        value: d.id,
        label: d.name,
        hint: pid ? undefined : depts.find((p) => p.id === d.parent_id)?.name,
      })),
    ];
  }, [depts, employmentDraft?.department_id, NONE]);

  const designationOptions = useMemo<ComboOption[]>(
    () => [NONE, ...designations.map((d) => ({ value: d.id, label: d.name, hint: d.grade || undefined }))],
    [designations, NONE],
  );

  const outletOptions = useMemo<ComboOption[]>(
    () => [NONE, ...outlets.map((o) => ({ value: o.id, label: o.name }))],
    [outlets, NONE],
  );

  const managerOptions = useMemo<ComboOption[]>(
    () => [
      NONE,
      ...employees
        .filter((e) => e.id !== id)
        .map((e) => ({ value: e.id, label: e.full_name, hint: e.employee_code })),
    ],
    [employees, id, NONE],
  );

  const userOptions = useMemo<ComboOption[]>(
    () => users.map((u) => ({ value: u.id, label: u.name || u.email, hint: u.email })),
    [users],
  );

  /** Display label for the currently-selected option (fallback keeps a stale id visible). */
  const labelFor = (opts: ComboOption[], v: string, fallback = ''): string => {
    if (!v) return '';
    return opts.find((o) => o.value === v)?.label ?? fallback ?? '';
  };

  /* ---- mutations ---- */

  const linkLogin = async () => {
    if (!linkUserId) { setLinkErr('Pick a user account to link first.'); return; }
    setLinkBusy(true); setLinkErr(null);
    try {
      const res = await api(apiUrl, { method: 'PUT', body: { user_id: linkUserId } });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setLinkErr(j?.error || 'Could not link this login.'); return; }
      setLinkUserId('');
      await load();
    } catch {
      setLinkErr('Could not link this login. Check your connection.');
    } finally {
      setLinkBusy(false);
    }
  };

  const unlinkLogin = async () => {
    if (!confirm('Unlink this login from the employee? The user account itself is not changed.')) return;
    setLinkBusy(true); setLinkErr(null);
    try {
      const res = await api(apiUrl, { method: 'PUT', body: { user_id: null } });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setLinkErr(j?.error || 'Could not unlink this login.'); return; }
      await load();
    } catch {
      setLinkErr('Could not unlink this login. Check your connection.');
    } finally {
      setLinkBusy(false);
    }
  };

  /** Compress a picked file client-side and PUT { photo }. */
  const onPickPhoto = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setPhotoBusy(true); setPhotoErr(null);
    try {
      const uri = await fileToDataUri(file);
      const res = await api(apiUrl, { method: 'PUT', body: { photo: uri } });
      const j = await res.json().catch(() => ({}));
      // Surfaces the server's 400 'Photo too large' message verbatim.
      if (!res.ok) { setPhotoErr(j?.error || 'Could not save the photo.'); return; }
      await load();
    } catch (e) {
      setPhotoErr(e instanceof Error && e.message ? e.message : 'Could not save the photo. Check your connection.');
    } finally {
      setPhotoBusy(false);
    }
  };

  const removePhoto = async () => {
    setPhotoBusy(true); setPhotoErr(null);
    try {
      const res = await api(apiUrl, { method: 'PUT', body: { photo: '' } });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setPhotoErr(j?.error || 'Could not remove the photo.'); return; }
      await load();
    } catch {
      setPhotoErr('Could not remove the photo. Check your connection.');
    } finally {
      setPhotoBusy(false);
    }
  };

  const startNameEdit = () => {
    if (!emp) return;
    setNameDraft(emp.full_name);
    setNameErr(null);
    setNameEditing(true);
  };

  const saveName = async () => {
    const v = nameDraft.trim();
    if (!v) { setNameErr('Name cannot be empty.'); return; }
    setNameBusy(true); setNameErr(null);
    try {
      const res = await api(apiUrl, { method: 'PUT', body: { full_name: v } });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setNameErr(j?.error || 'Could not save the name.'); return; }
      setNameEditing(false);
      await load();
    } catch {
      setNameErr('Could not save the name. Check your connection.');
    } finally {
      setNameBusy(false);
    }
  };

  const openStatusModal = () => {
    if (!emp) return;
    setStatusVal(emp.status || 'active');
    setStatusNote('');
    setStatusExitDate('');
    setStatusErr(null);
    setStatusModal(true);
  };

  const submitStatus = async () => {
    if (!statusNote.trim()) { setStatusErr('A note explaining the change is required.'); return; }
    setStatusSaving(true); setStatusErr(null);
    try {
      const res = await api(apiUrl, {
        method: 'PATCH',
        body: { action: 'set_status', status: statusVal, note: statusNote.trim() },
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setStatusErr(j?.error || 'Could not change the status.'); return; }
      // Contract D1: HR never writes users.is_active — we only surface the pointer.
      setSuggestDeactivate(!!j?.suggest_deactivate_login);
      // Optional exit date picked alongside an exit status → follow-up PUT
      // (the PATCH deliberately only writes status).
      if (EXIT_STATUSES.has(statusVal) && statusExitDate) {
        const res2 = await api(apiUrl, { method: 'PUT', body: { exit_date: statusExitDate } });
        const j2 = await res2.json().catch(() => ({}));
        if (!res2.ok) {
          // Status DID change — keep the modal open so the partial failure is seen.
          setStatusErr(
            j2?.error
              ? `Status updated, but the exit date was not saved: ${j2.error}`
              : 'Status updated, but the exit date was not saved.',
          );
          await load();
          return;
        }
        // Keep the Employment draft in step so a later tab save can't clobber it.
        setEmploymentDraft((d) => (d ? { ...d, exit_date: statusExitDate } : d));
      }
      setStatusModal(false);
      await load();
    } catch {
      setStatusErr('Could not change the status. Check your connection.');
    } finally {
      setStatusSaving(false);
    }
  };

  const savePersonal = async () => {
    if (!personalDraft) return;
    setPersonalSaving(true); setPersonalErr(null); setPersonalOk(false);
    try {
      const res = await api(apiUrl, { method: 'PUT', body: { ...personalDraft } });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setPersonalErr(j?.error || 'Could not save personal details.'); return; }
      const fresh = await load();
      if (fresh) setPersonalDraft(personalFromEmp(fresh));
      setPersonalOk(true);
      setTimeout(() => setPersonalOk(false), 2500);
    } catch {
      setPersonalErr('Could not save personal details. Check your connection.');
    } finally {
      setPersonalSaving(false);
    }
  };

  const saveEmployment = async () => {
    if (!employmentDraft) return;
    setEmploymentSaving(true); setEmploymentErr(null); setEmploymentOk(false);
    try {
      const res = await api(apiUrl, { method: 'PUT', body: { ...employmentDraft } });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setEmploymentErr(j?.error || 'Could not save employment details.'); return; }
      const fresh = await load();
      if (fresh) setEmploymentDraft(employmentFromEmp(fresh));
      setEmploymentOk(true);
      setTimeout(() => setEmploymentOk(false), 2500);
    } catch {
      setEmploymentErr('Could not save employment details. Check your connection.');
    } finally {
      setEmploymentSaving(false);
    }
  };

  /* ---- render ---- */

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        <div>
          <Link
            href="/hr/employees"
            className="inline-flex items-center gap-1 text-sm text-[#6B5744] hover:text-[#2D1B0E] transition-colors mb-2"
          >
            <ArrowLeft className="w-4 h-4" /> Employees
          </Link>
          <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-2">
            <User className="w-6 h-6" /> {emp?.full_name || 'Employee Profile'}
          </h1>
          {emp && (
            <p className="text-[#8B7355] text-sm mt-1 flex flex-wrap items-center gap-2">
              <span className="font-mono">{emp.employee_code}</span>
              <StatusBadge status={emp.status} />
            </p>
          )}
        </div>

        {loading ? (
          <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-6 flex items-center gap-2 text-[#8B7355] text-sm">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading...
          </div>
        ) : loadErr || !emp ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 flex flex-wrap items-center justify-between gap-3">
            <span>{loadErr || 'Could not load this employee.'}</span>
            <button
              onClick={() => { setLoading(true); setLoadErr(null); load(); }}
              className="px-3 py-1.5 rounded-lg border border-red-300 bg-white hover:bg-red-100 text-red-700 text-sm font-medium"
            >
              Retry
            </button>
          </div>
        ) : (
          <>
            <TabScroller className="gap-2">
              {TABS.map((t) => {
                const active = tab === t.key;
                return (
                  <button
                    key={t.key}
                    onClick={() => setTab(t.key)}
                    className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                      active
                        ? 'bg-[#af4408] border-[#af4408] text-white'
                        : 'bg-white border-[#E8D5C4] text-[#6B5744] hover:bg-[#FFF1E3]'
                    }`}
                  >
                    {t.label}
                  </button>
                );
              })}
              {/* PHASE 2+ INSERTION POINT — later phases append tabs here
                  (Attendance, Leave, Documents, Salary, Assets, …): add the key
                  to TABS above and a matching `tab === '…'` section below. */}
            </TabScroller>

            {suggestDeactivate && (
              <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <div className="flex-1">
                  Login stays active. Deactivate it on the Users page (admin action).{' '}
                  <Link href="/users" className="underline font-medium inline-flex items-center gap-0.5">
                    Open Users <ExternalLink className="w-3 h-3" />
                  </Link>
                </div>
                <button
                  onClick={() => setSuggestDeactivate(false)}
                  className="text-amber-700 hover:text-amber-900 shrink-0"
                  title="Dismiss"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            {tab === 'overview' && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {/* Identity */}
                <div className="lg:col-span-2 bg-white border border-[#E8D5C4] rounded-xl shadow p-5">
                  <div className="flex items-start gap-4">
                    <div className="shrink-0 flex flex-col items-center gap-1.5">
                      {emp.photo ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={emp.photo}
                          alt={emp.full_name}
                          className="w-20 h-20 rounded-full object-cover border border-[#E8D5C4]"
                        />
                      ) : (
                        <div className="w-20 h-20 rounded-full bg-[#FFF1E3] border border-[#E8D5C4] flex items-center justify-center text-2xl font-bold text-[#af4408]">
                          {initialsOf(emp.full_name)}
                        </div>
                      )}
                      <input
                        ref={photoInputRef}
                        type="file"
                        accept="image/*"
                        className="sr-only"
                        aria-label="Edit photo"
                        onChange={(e) => { onPickPhoto(e.target.files); e.currentTarget.value = ''; }}
                      />
                      <button
                        onClick={() => photoInputRef.current?.click()}
                        disabled={photoBusy}
                        className="inline-flex items-center gap-1 text-[11px] font-medium text-[#af4408] hover:underline disabled:opacity-50"
                      >
                        {photoBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Camera className="w-3 h-3" />}
                        {photoBusy ? 'Saving…' : emp.photo ? 'Edit photo' : 'Add photo'}
                      </button>
                      {emp.photo && !photoBusy && (
                        <button
                          onClick={removePhoto}
                          className="text-[11px] text-red-600 hover:underline"
                        >
                          Remove photo
                        </button>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {nameEditing ? (
                          <>
                            <input
                              className="flex-1 min-w-[160px] px-2 py-1 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm font-bold focus:outline-none focus:border-[#af4408]"
                              value={nameDraft}
                              onChange={(e) => { setNameDraft(e.target.value); setNameErr(null); }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') saveName();
                                if (e.key === 'Escape') setNameEditing(false);
                              }}
                              autoFocus
                            />
                            <button
                              onClick={saveName}
                              disabled={nameBusy || !nameDraft.trim()}
                              title="Save name"
                              className="text-green-700 hover:text-green-800 disabled:opacity-50"
                            >
                              {nameBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                            </button>
                            <button
                              onClick={() => setNameEditing(false)}
                              disabled={nameBusy}
                              title="Cancel"
                              className="text-[#8B7355] hover:text-[#2D1B0E] disabled:opacity-50"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </>
                        ) : (
                          <>
                            <span className="text-lg font-bold text-[#2D1B0E]">{emp.full_name}</span>
                            <button
                              onClick={startNameEdit}
                              title="Edit name"
                              aria-label="Edit name"
                              className="text-[#8B7355] hover:text-[#af4408]"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <StatusBadge status={emp.status} />
                          </>
                        )}
                      </div>
                      {nameErr && <div className="text-xs text-red-700 mt-1">{nameErr}</div>}
                      <div className="text-sm text-[#8B7355] font-mono mt-0.5">{emp.employee_code}</div>
                      <div className="text-sm text-[#6B5744] mt-1">
                        {emp.designation_name || '—'}
                        {' · '}
                        {emp.department_name || '—'}
                        {emp.sub_department_name ? ` / ${emp.sub_department_name}` : ''}
                      </div>
                    </div>
                  </div>
                  {photoErr && (
                    <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                      {photoErr}
                    </div>
                  )}
                  <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6">
                    <InfoRow k="Phone" v={fmtPhone(emp.phone10)} />
                    <InfoRow k="Contact email" v={emp.email || '—'} />
                    <InfoRow k="Joined" v={emp.joining_date ? fmtISTDate(emp.joining_date) : '—'} />
                    <InfoRow k="Employment type" v={employmentTypeMeta(emp.employment_type).label} />
                    <InfoRow k="Home outlet" v={labelFor(outletOptions, emp.home_outlet_id, emp.home_outlet_id) || '—'} />
                    {emp.exit_date ? <InfoRow k="Exit date" v={fmtISTDate(emp.exit_date)} /> : null}
                  </div>
                </div>

                {/* Status card */}
                <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-5">
                  <h2 className="font-bold text-[#2D1B0E] text-sm mb-3">Status</h2>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={emp.status} />
                  </div>
                  <div className="text-xs text-[#8B7355] mt-2">Last updated {fmtIST(emp.updated_at)}</div>
                  <button
                    onClick={openStatusModal}
                    className="mt-4 w-full px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium"
                  >
                    Change status
                  </button>
                  <p className="text-[11px] text-[#8B7355] mt-2">
                    HR status never deactivates a login — that stays an explicit admin action on the Users page.
                  </p>
                </div>

                {/* Linked login */}
                <div className="lg:col-span-2 bg-white border border-[#E8D5C4] rounded-xl shadow p-5">
                  <h2 className="font-bold text-[#2D1B0E] text-sm mb-3 flex items-center gap-1.5">
                    <Link2 className="w-4 h-4 text-[#af4408]" /> Linked login
                  </h2>
                  {emp.user_id ? (
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-[#2D1B0E]">
                          {emp.linked_user_name || emp.linked_user_email || 'Linked account'}
                        </div>
                        <div className="text-xs text-[#8B7355] break-all">{emp.linked_user_email || emp.user_id}</div>
                      </div>
                      <button
                        onClick={unlinkLogin}
                        disabled={linkBusy}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-red-200 text-red-600 hover:bg-red-50 rounded-lg text-sm font-medium disabled:opacity-50"
                      >
                        {linkBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Unlink className="w-4 h-4" />}
                        Unlink
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-[#8B7355] text-sm">
                        No login linked — this employee cannot sign in to the app. Link an existing user account:
                      </p>
                      <div className="flex flex-col sm:flex-row gap-2">
                        <div className="flex-1 min-w-0">
                          <Combobox
                            options={userOptions}
                            value={labelFor(userOptions, linkUserId)}
                            onChange={(v) => { setLinkUserId(v); setLinkErr(null); }}
                            placeholder="Pick an active user account…"
                          />
                        </div>
                        <button
                          onClick={linkLogin}
                          disabled={linkBusy || !linkUserId}
                          className="inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium disabled:opacity-50 shrink-0"
                        >
                          {linkBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
                          Link login
                        </button>
                      </div>
                    </div>
                  )}
                  {linkErr && (
                    <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                      {linkErr}
                    </div>
                  )}
                </div>

                {/* Record meta */}
                <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-5">
                  <h2 className="font-bold text-[#2D1B0E] text-sm mb-3">Record</h2>
                  <InfoRow k="Created by" v={emp.created_by || '—'} />
                  <InfoRow k="Created" v={fmtIST(emp.created_at)} />
                  <InfoRow k="Updated" v={fmtIST(emp.updated_at)} />
                </div>
              </div>
            )}

            {tab === 'personal' && personalDraft && (
              <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-5 space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <FieldLabel>Date of birth</FieldLabel>
                    <input
                      type="date"
                      className={inputCls}
                      value={personalDraft.dob}
                      onChange={(e) => setPersonalDraft({ ...personalDraft, dob: e.target.value })}
                    />
                  </div>
                  <div>
                    <FieldLabel>Gender</FieldLabel>
                    <select
                      className={inputCls}
                      value={personalDraft.gender}
                      onChange={(e) => setPersonalDraft({ ...personalDraft, gender: e.target.value })}
                    >
                      <option value="">Not set</option>
                      <option value="male">Male</option>
                      <option value="female">Female</option>
                      <option value="other">Other</option>
                    </select>
                  </div>
                  <div>
                    <FieldLabel>Phone</FieldLabel>
                    <PhoneField
                      value={personalDraft.phone10}
                      onChange={(v) => setPersonalDraft({ ...personalDraft, phone10: v })}
                      placeholder="Mobile number"
                    />
                  </div>
                  <div>
                    <FieldLabel>Alternate phone</FieldLabel>
                    <PhoneField
                      value={personalDraft.alt_phone10}
                      onChange={(v) => setPersonalDraft({ ...personalDraft, alt_phone10: v })}
                      placeholder="Alternate number"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <FieldLabel>Contact email (not a login)</FieldLabel>
                    <input
                      type="email"
                      className={inputCls}
                      value={personalDraft.email}
                      onChange={(e) => setPersonalDraft({ ...personalDraft, email: e.target.value })}
                    />
                  </div>
                  <div>
                    <FieldLabel>Current address</FieldLabel>
                    <textarea
                      rows={3}
                      className={inputCls}
                      value={personalDraft.current_address}
                      onChange={(e) => setPersonalDraft({ ...personalDraft, current_address: e.target.value })}
                    />
                  </div>
                  <div>
                    <FieldLabel>Permanent address</FieldLabel>
                    <textarea
                      rows={3}
                      className={inputCls}
                      value={personalDraft.permanent_address}
                      onChange={(e) => setPersonalDraft({ ...personalDraft, permanent_address: e.target.value })}
                    />
                  </div>
                </div>

                <div>
                  <h3 className="text-sm font-bold text-[#2D1B0E] mb-2">Emergency contact</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <FieldLabel>Name</FieldLabel>
                      <input
                        className={inputCls}
                        value={personalDraft.emergency_name}
                        onChange={(e) => setPersonalDraft({ ...personalDraft, emergency_name: e.target.value })}
                      />
                    </div>
                    <div>
                      <FieldLabel>Relation</FieldLabel>
                      <input
                        className={inputCls}
                        value={personalDraft.emergency_relation}
                        onChange={(e) => setPersonalDraft({ ...personalDraft, emergency_relation: e.target.value })}
                        placeholder="e.g. Father, Spouse"
                      />
                    </div>
                    <div>
                      <FieldLabel>Phone</FieldLabel>
                      <PhoneField
                        value={personalDraft.emergency_phone10}
                        onChange={(v) => setPersonalDraft({ ...personalDraft, emergency_phone10: v })}
                        placeholder="Emergency number"
                      />
                    </div>
                  </div>
                </div>

                <SaveBar
                  err={personalErr}
                  ok={personalOk}
                  saving={personalSaving}
                  onSave={savePersonal}
                />
              </div>
            )}

            {tab === 'employment' && employmentDraft && (
              <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-5 space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <FieldLabel>Department</FieldLabel>
                    <Combobox
                      options={mainDeptOptions}
                      value={labelFor(mainDeptOptions, employmentDraft.department_id, emp.department_name || '')}
                      onChange={(v) => {
                        setEmploymentDraft((d) => {
                          if (!d) return d;
                          const sub = depts.find((x) => x.id === d.sub_department_id);
                          const clearSub = !!v && !!sub && sub.parent_id !== v;
                          return { ...d, department_id: v, sub_department_id: clearSub ? '' : d.sub_department_id };
                        });
                      }}
                      placeholder="Pick a department…"
                    />
                  </div>
                  <div>
                    <FieldLabel>Sub-department</FieldLabel>
                    <Combobox
                      options={subDeptOptions}
                      value={labelFor(subDeptOptions, employmentDraft.sub_department_id, emp.sub_department_name || '')}
                      onChange={(v) => setEmploymentDraft({ ...employmentDraft, sub_department_id: v })}
                      placeholder="Pick a sub-department…"
                    />
                  </div>
                  <div>
                    <FieldLabel>Designation</FieldLabel>
                    <Combobox
                      options={designationOptions}
                      value={labelFor(designationOptions, employmentDraft.designation_id, emp.designation_name || '')}
                      onChange={(v) => setEmploymentDraft({ ...employmentDraft, designation_id: v })}
                      placeholder="Pick a designation…"
                    />
                  </div>
                  <div>
                    <FieldLabel>Grade</FieldLabel>
                    <input
                      className={inputCls}
                      value={employmentDraft.grade}
                      onChange={(e) => setEmploymentDraft({ ...employmentDraft, grade: e.target.value })}
                    />
                  </div>
                  <div>
                    <FieldLabel>Reporting manager</FieldLabel>
                    <Combobox
                      options={managerOptions}
                      value={labelFor(
                        managerOptions,
                        employmentDraft.reporting_manager_id,
                        employmentDraft.reporting_manager_id ? 'Assigned (not in first 100)' : '',
                      )}
                      onChange={(v) => setEmploymentDraft({ ...employmentDraft, reporting_manager_id: v })}
                      placeholder="Pick an employee…"
                    />
                  </div>
                  <div>
                    <FieldLabel>Employment type</FieldLabel>
                    <select
                      className={inputCls}
                      value={employmentDraft.employment_type}
                      onChange={(e) => setEmploymentDraft({ ...employmentDraft, employment_type: e.target.value })}
                    >
                      {!isHrEmploymentType(employmentDraft.employment_type) && (
                        <option value={employmentDraft.employment_type}>
                          {employmentDraft.employment_type || 'Not set'}
                        </option>
                      )}
                      {HR_EMPLOYMENT_TYPES.map((t) => (
                        <option key={t.key} value={t.key}>{t.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <FieldLabel>Category</FieldLabel>
                    <input
                      className={inputCls}
                      value={employmentDraft.employee_category}
                      onChange={(e) => setEmploymentDraft({ ...employmentDraft, employee_category: e.target.value })}
                      placeholder="e.g. Kitchen, Service, Admin"
                    />
                  </div>
                  <div>
                    <FieldLabel>Cost centre</FieldLabel>
                    <input
                      className={inputCls}
                      value={employmentDraft.cost_centre}
                      onChange={(e) => setEmploymentDraft({ ...employmentDraft, cost_centre: e.target.value })}
                    />
                  </div>
                  <div>
                    <FieldLabel>Work location</FieldLabel>
                    <input
                      className={inputCls}
                      value={employmentDraft.work_location}
                      onChange={(e) => setEmploymentDraft({ ...employmentDraft, work_location: e.target.value })}
                    />
                  </div>
                  <div>
                    <FieldLabel>Home outlet</FieldLabel>
                    <Combobox
                      options={outletOptions}
                      value={labelFor(outletOptions, employmentDraft.home_outlet_id, employmentDraft.home_outlet_id)}
                      onChange={(v) => setEmploymentDraft({ ...employmentDraft, home_outlet_id: v })}
                      placeholder="Pick an outlet…"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <FieldLabel>Additional outlets (multi-outlet staff)</FieldLabel>
                    <div className="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                      {outlets.length === 0 ? (
                        <div className="text-[#8B7355] text-sm">No outlets found.</div>
                      ) : (
                        outlets.map((o) => (
                          <label key={o.id} className="flex items-center gap-2 text-sm text-[#2D1B0E]">
                            <input
                              type="checkbox"
                              checked={employmentDraft.outlets.includes(o.id)}
                              onChange={(e) =>
                                setEmploymentDraft((d) => {
                                  if (!d) return d;
                                  const next = e.target.checked
                                    ? [...d.outlets, o.id]
                                    : d.outlets.filter((x) => x !== o.id);
                                  return { ...d, outlets: next };
                                })
                              }
                            />
                            {o.name}
                          </label>
                        ))
                      )}
                    </div>
                  </div>
                  <div>
                    <FieldLabel>Joining date</FieldLabel>
                    <input
                      type="date"
                      className={inputCls}
                      value={employmentDraft.joining_date}
                      onChange={(e) => setEmploymentDraft({ ...employmentDraft, joining_date: e.target.value })}
                    />
                  </div>
                  <div>
                    <FieldLabel>Probation (months)</FieldLabel>
                    <input
                      type="number"
                      min={0}
                      className={inputCls}
                      value={String(employmentDraft.probation_months)}
                      onChange={(e) =>
                        setEmploymentDraft({
                          ...employmentDraft,
                          probation_months: Math.max(0, Math.floor(Number(e.target.value) || 0)),
                        })
                      }
                    />
                  </div>
                  <div>
                    <FieldLabel>Confirmation date</FieldLabel>
                    <input
                      type="date"
                      className={inputCls}
                      value={employmentDraft.confirmation_date}
                      onChange={(e) => setEmploymentDraft({ ...employmentDraft, confirmation_date: e.target.value })}
                    />
                  </div>
                  <div>
                    <FieldLabel>Notice period (days)</FieldLabel>
                    <input
                      type="number"
                      min={0}
                      className={inputCls}
                      value={String(employmentDraft.notice_period_days)}
                      onChange={(e) =>
                        setEmploymentDraft({
                          ...employmentDraft,
                          notice_period_days: Math.max(0, Math.floor(Number(e.target.value) || 0)),
                        })
                      }
                    />
                  </div>
                  <div>
                    <FieldLabel>Exit date</FieldLabel>
                    <input
                      type="date"
                      className={inputCls}
                      value={employmentDraft.exit_date}
                      onChange={(e) => setEmploymentDraft({ ...employmentDraft, exit_date: e.target.value })}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <FieldLabel>Notes</FieldLabel>
                    <textarea
                      rows={3}
                      className={inputCls}
                      value={employmentDraft.notes}
                      onChange={(e) => setEmploymentDraft({ ...employmentDraft, notes: e.target.value })}
                    />
                  </div>
                </div>

                <SaveBar
                  err={employmentErr}
                  ok={employmentOk}
                  saving={employmentSaving}
                  onSave={saveEmployment}
                />
              </div>
            )}
          </>
        )}

        {/* Change-status modal */}
        {statusModal && emp && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
            <div
              style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
              className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-lg shadow-xl flex flex-col overflow-hidden"
            >
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E]">Change status</h2>
                <button onClick={() => setStatusModal(false)} className="text-[#8B7355]">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-3">
                <div className="flex items-center gap-2 text-sm text-[#6B5744]">
                  Current: <StatusBadge status={emp.status} />
                </div>
                <div>
                  <FieldLabel>New status</FieldLabel>
                  <select
                    className={inputCls}
                    value={statusVal}
                    onChange={(e) => setStatusVal(e.target.value)}
                  >
                    {!isHrEmployeeStatus(statusVal) && (
                      <option value={statusVal}>{statusVal || 'Not set'}</option>
                    )}
                    {HR_EMPLOYEE_STATUSES.map((s) => (
                      <option key={s.key} value={s.key}>{s.label}</option>
                    ))}
                  </select>
                </div>
                {EXIT_STATUSES.has(statusVal) && (
                  <div>
                    <FieldLabel>Exit date (optional)</FieldLabel>
                    <input
                      type="date"
                      className={inputCls}
                      value={statusExitDate}
                      onChange={(e) => setStatusExitDate(e.target.value)}
                    />
                  </div>
                )}
                <div>
                  <FieldLabel>Note (required)</FieldLabel>
                  <textarea
                    rows={3}
                    className={inputCls}
                    value={statusNote}
                    onChange={(e) => setStatusNote(e.target.value)}
                    placeholder="Why is the status changing?"
                  />
                </div>
                <p className="text-[11px] text-[#8B7355]">
                  Setting an exit status (resigned / terminated / former) never deactivates a linked login —
                  you will be pointed to the Users page to do that as an explicit admin action.
                </p>
                {statusErr && (
                  <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                    {statusErr}
                  </div>
                )}
              </div>
              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
                <button onClick={() => setStatusModal(false)} className="px-3 py-2 text-sm text-[#6B5744]">
                  Cancel
                </button>
                <button
                  onClick={submitStatus}
                  disabled={statusSaving || !statusNote.trim()}
                  className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50"
                >
                  {statusSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  Update status
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Local presentational bits
 * ------------------------------------------------------------------ */

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="text-xs text-[#6B5744]">{children}</label>;
}

function InfoRow({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 border-b border-[#E8D5C4]/40 last:border-0 text-sm">
      <span className="text-[#8B7355] shrink-0">{k}</span>
      <span className="text-right text-[#2D1B0E] min-w-0 break-words">{v ?? '—'}</span>
    </div>
  );
}

function SaveBar({
  err,
  ok,
  saving,
  onSave,
}: {
  err: string | null;
  ok: boolean;
  saving: boolean;
  onSave: () => void;
}) {
  return (
    <div className="pt-3 border-t border-[#E8D5C4] flex flex-wrap items-center justify-end gap-3">
      {err && (
        <div className="flex-1 min-w-[200px] rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {err}
        </div>
      )}
      {ok && !err && <span className="text-xs text-green-700">Saved.</span>}
      <button
        onClick={onSave}
        disabled={saving}
        className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50"
      >
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
      </button>
    </div>
  );
}
