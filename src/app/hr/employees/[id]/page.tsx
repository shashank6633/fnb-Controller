'use client';

/**
 * /hr/employees/[id] — Employee Profile (HRMS Phase 1).
 *
 * Contract: docs/HRMS_DECISIONS.md. Phase 1 shipped Overview / Personal /
 * Employment; Phases 4/6 append the money + lifecycle tabs — Salary, Bank,
 * Documents, Advances, Assets, Disciplinary. Every added tab LAZY-fetches on
 * its first open, so the profile load stays one employee GET.
 *
 *  - Overview: identity card (photo/initials, code, status badge), the
 *    linked-login card (link/unlink a users row via PUT user_id — 409 from the
 *    idx_hr_emp_user UNIQUE index is surfaced verbatim), and the status card
 *    (PATCH set_status with a required note). Per contract D1, HR never writes
 *    the users table: when the API answers suggest_deactivate_login=true we
 *    only SHOW an amber pointer to /users — deactivation stays an explicit
 *    admin action there.
 *  - Personal / Employment: each tab saves ONLY its own fields via one PUT.
 *    Employment's Designation picker accepts free text: an unknown designation
 *    is a PROMPT ('＋ Create "X"'), never a dead end — designations are
 *    HR-local, so a wrong one is cosmetic and deactivatable on HR Settings.
 *    Creating is ADMIN-only (POST /api/hr/designations is canAdminHr) while
 *    this page is canManageHr, so managers see a pointer to HR Settings
 *    instead of a button that would 403. The picker is FILTERED by the chosen
 *    department (owner rule 2026-08-17 — "link designation and department"):
 *    generic designations (department_id '') always show, pinned ones show for
 *    their whole main-department tree, the designation the employee already
 *    holds is never hidden (an amber note names its department instead), and
 *    'Show all designations' lifts the filter for the unusual case. A created
 *    designation is pinned to the MAIN department currently selected.
 *    Departments are deliberately NOT
 *    auto-creatable anywhere: that tree is shared with requisitions, closing
 *    stock, variance and dept-stock, where a typo pollutes load-bearing
 *    operational data — create those on the Departments page first.
 *  - Salary / Documents / Disciplinary are admin-only surfaces: gated
 *    client-side via /api/auth/me + canAdminHr with a plain lock card for
 *    everyone else — and every backing API re-checks canAdminHr server-side
 *    (hiding is UX, not the boundary). Bank LISTS for management with the
 *    account number masked SERVER-side unless the caller is admin
 *    (can_view_full on the wire); add/edit/verify are admin actions.
 *  - Advances / Assets are read-only history views here (decisions live on
 *    their own admin surfaces); Assets expands a per-asset movement ledger
 *    on demand via GET /api/hr/assets?id=.
 *
 * All mutations go through api() from '@/lib/api' (CSRF header — /api/hr is a
 * CSRF-required prefix). Bare fetch is used for GETs only.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  Ban,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  IndianRupee,
  Landmark,
  Link2,
  Loader2,
  Lock,
  Package,
  Pencil,
  Plus,
  Save,
  ShieldAlert,
  Unlink,
  Upload,
  User,
  Wallet,
  X,
} from 'lucide-react';
import { api } from '@/lib/api';
import type { SessionUser } from '@/lib/auth';
import { fmtIST, fmtISTDate, todayIST } from '@/lib/format-date';
import {
  HR_DOC_TYPES,
  HR_EMPLOYEE_STATUSES,
  HR_EMPLOYMENT_TYPES,
  advanceStatusMeta,
  assetKindMeta,
  assetStatusMeta,
  canAdminHr,
  disciplinaryKindMeta,
  docTypeMeta,
  employeeStatusMeta,
  employmentTypeMeta,
  isHrEmployeeStatus,
  isHrEmploymentType,
  type HrAdvance,
  type HrAdvanceInstallment,
  type HrAsset,
  type HrAssetHistory,
  type HrBankAccount,
  type HrDisciplinaryRecord,
  type HrDocumentMeta,
  type HrEmployeeListRow,
  type HrSalaryStructure,
} from '@/lib/hr';
import TabScroller from '@/components/TabScroller';
import Combobox, { type ComboOption } from '@/components/Combobox';
import PhoneField from '@/components/PhoneField';
import Toggle from '@/components/Toggle';

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
/** hr_designations row as the picker needs it. `department_id` is the
 *  DESIGNATION→DEPARTMENT link curated on HR Settings: '' means GENERIC
 *  (belongs to no department — Manager, Trainee — and stays pickable
 *  everywhere), any other value pins it to that department's tree. */
interface DesigRow { id: string; name: string; department_id: string; grade: string; is_active: number }
interface UserRow { id: string; name: string; email: string }
interface EmpPickRow { id: string; full_name: string; employee_code: string }

/* Wire row shapes for the Phase 4/6 tabs — the API rows are the hr_* table
 * row + LEFT-JOINed employee display names (a dangling employee_id degrades
 * to blank names, never a dropped row). */
type SalaryRow = HrSalaryStructure & { employee_name?: string | null; employee_code?: string | null };
type BankRow = HrBankAccount & { employee_name?: string | null; employee_code?: string | null };
type DocRow = HrDocumentMeta & { employee_name?: string | null; employee_code?: string | null };
type AdvanceRow = HrAdvance & {
  employee_name?: string | null;
  employee_code?: string | null;
  /** hr_advance_installments ledger, shipped inline by GET /api/hr/advances. */
  installments?: HrAdvanceInstallment[];
};
type AssetRow = HrAsset & { holder_name?: string | null; holder_code?: string | null };
type AssetHistRow = HrAssetHistory & { employee_name?: string | null; employee_code?: string | null };
type DiscRow = HrDisciplinaryRecord & { employee_name?: string | null; employee_code?: string | null };

/** One editable {label, amount} line in the salary Revise modal (amount stays
 *  a string while typing; parsed on submit — the server recomputes gross/net). */
interface MoneyLine { label: string; amount: string }

/** Bank add/edit modal draft. */
interface BankDraft {
  bank_name: string;
  account_holder: string;
  account_number: string;
  ifsc: string;
  branch: string;
  account_type: string;
  is_active: boolean;
}

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

/** ₹ money for the pay tabs (Indian grouping, max 2dp). */
const inr = (n: number | null | undefined): string =>
  `₹${Number(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

/** [{label, amount}] out of an allowances/deductions JSON column ('' → []). */
function parseMoneyLines(json: string | null | undefined): { label: string; amount: number }[] {
  if (!json) return [];
  try {
    const arr: unknown = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((l): l is Record<string, unknown> => !!l && typeof l === 'object')
      .map((l) => ({ label: String(l.label ?? ''), amount: Number(l.amount) || 0 }));
  } catch {
    return [];
  }
}

/** Human file size for the document vault rows. */
const fmtBytes = (n: number): string =>
  !n || n <= 0
    ? '0 KB'
    : n >= 1024 * 1024
      ? `${(n / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.max(1, Math.round(n / 1024))} KB`;

/** 5 MB decoded-bytes cap — mirrors HR_DOC_MAX_BYTES in src/lib/hr-files.ts
 *  (a server module this client page cannot import). The server re-checks. */
const DOC_MAX_BYTES = 5 * 1024 * 1024;

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
  { key: 'salary', label: 'Salary' },
  { key: 'bank', label: 'Bank' },
  { key: 'documents', label: 'Documents' },
  { key: 'advances', label: 'Advances' },
  { key: 'assets', label: 'Assets' },
  { key: 'disciplinary', label: 'Disciplinary' },
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

  // Employment tab — inline "create designation" affordance. `desigTyped` holds
  // free text the viewer typed into the designation Combobox; null means "show
  // the selected option's label instead". Creation is always an EXPLICIT click,
  // never a side effect of saving.
  const [desigTyped, setDesigTyped] = useState<string | null>(null);
  const [desigCreating, setDesigCreating] = useState(false);
  const [desigCreateErr, setDesigCreateErr] = useState<string | null>(null);
  // The designation list is filtered to the chosen department by DEFAULT, never
  // caged: this lifts the filter for one unusual assignment (see the
  // 'Show all designations' link under the picker).
  const [desigShowAll, setDesigShowAll] = useState(false);

  /* ---- Phase 4/6 tabs: session tier + lazy per-tab state ---- */

  // Who am I — Salary / Documents / Disciplinary are admin-only surfaces; the
  // backing APIs re-check canAdminHr server-side (hiding is UX, not the
  // boundary), and Bank shows admin actions only to admins.
  const [me, setMe] = useState<SessionUser | null>(null);
  const [meLoaded, setMeLoaded] = useState(false);
  const isAdmin = canAdminHr(me);

  // Salary (admin-only; rows === null means "not fetched yet")
  const [salRows, setSalRows] = useState<SalaryRow[] | null>(null);
  const [salLoading, setSalLoading] = useState(false);
  const [salErr, setSalErr] = useState<string | null>(null);
  const [reviseOpen, setReviseOpen] = useState(false);
  const [revEffFrom, setRevEffFrom] = useState('');
  const [revBasic, setRevBasic] = useState('');
  const [revHra, setRevHra] = useState('');
  const [revAllow, setRevAllow] = useState<MoneyLine[]>([]);
  const [revDed, setRevDed] = useState<MoneyLine[]>([]);
  const [revNote, setRevNote] = useState('');
  const [revSaving, setRevSaving] = useState(false);
  const [revErr, setRevErr] = useState<string | null>(null);

  // Bank
  const [bankRows, setBankRows] = useState<BankRow[] | null>(null);
  const [bankCanFull, setBankCanFull] = useState(false);
  const [bankLoading, setBankLoading] = useState(false);
  const [bankErr, setBankErr] = useState<string | null>(null);
  const [bankModal, setBankModal] = useState<{ mode: 'add' } | { mode: 'edit'; row: BankRow } | null>(null);
  const [bankDraft, setBankDraft] = useState<BankDraft | null>(null);
  const [bankSaving, setBankSaving] = useState(false);
  const [bankModalErr, setBankModalErr] = useState<string | null>(null);
  /** Row id with a verify/reject PATCH in flight. */
  const [bankVerifyBusy, setBankVerifyBusy] = useState<string | null>(null);

  // Documents (admin-only)
  const [docRows, setDocRows] = useState<DocRow[] | null>(null);
  const [docLoading, setDocLoading] = useState(false);
  const [docErr, setDocErr] = useState<string | null>(null);
  const [docModal, setDocModal] = useState(false);
  const docFileRef = useRef<HTMLInputElement>(null);
  const [docFile, setDocFile] = useState<File | null>(null);
  const [docType, setDocType] = useState('');
  const [docNumber, setDocNumber] = useState('');
  const [docIssue, setDocIssue] = useState('');
  const [docExpiry, setDocExpiry] = useState('');
  const [docSaving, setDocSaving] = useState(false);
  const [docModalErr, setDocModalErr] = useState<string | null>(null);

  // Advances (read-only history — decisions live on their own admin surface)
  const [advRows, setAdvRows] = useState<AdvanceRow[] | null>(null);
  const [advLoading, setAdvLoading] = useState(false);
  const [advErr, setAdvErr] = useState<string | null>(null);
  const [advOpenId, setAdvOpenId] = useState<string | null>(null);

  // Assets (currently held + per-asset movement history on demand)
  const [assetRows, setAssetRows] = useState<AssetRow[] | null>(null);
  const [assetLoading, setAssetLoading] = useState(false);
  const [assetErr, setAssetErr] = useState<string | null>(null);
  const [assetOpenId, setAssetOpenId] = useState<string | null>(null);
  const [assetHist, setAssetHist] = useState<
    Record<string, { loading: boolean; err: string | null; rows: AssetHistRow[] | null }>
  >({});

  // Disciplinary (admin-only)
  const [discRows, setDiscRows] = useState<DiscRow[] | null>(null);
  const [discLoading, setDiscLoading] = useState(false);
  const [discErr, setDiscErr] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j) => setMe(j?.user || null))
      .catch(() => {})
      .finally(() => setMeLoaded(true));
  }, []);

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
      if (gj?.designations) {
        setDesignations(
          (gj.designations as DesigRow[])
            .filter((d) => d.is_active)
            // '' is the GENERIC marker the picker filter keys off — normalise a
            // NULL column to it so a legacy row never reads as "pinned to null".
            .map((d) => ({ ...d, department_id: d.department_id || '' })),
        );
      }
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

  /* ---- designation ⇄ department link (owner rule, 2026-08-17) ------------- *
   * A designation with department_id = '' is GENERIC and stays pickable
   * everywhere. A pinned one shows when the employee's department matches it,
   * TREE-AWARE: same id, or the same MAIN department (a designation pinned to
   * "Kitchen" offers under every Kitchen sub-department and vice-versa) — the
   * client mirror of mainDeptOf() in src/lib/dept-hierarchy.ts. With no
   * department chosen there is nothing to filter by, so everything shows. The
   * filter is a helpful default, not a cage: 'Show all designations' lifts it,
   * and the designation the employee ALREADY holds is never hidden.
   * ------------------------------------------------------------------------ */

  const deptById = useMemo(() => {
    const m = new Map<string, DeptRow>();
    for (const d of depts) m.set(d.id, d);
    return m;
  }, [depts]);

  /** Main (top-level) department id for any dept id — a sub resolves to its
   *  parent, a main (or an unknown id) resolves to itself. */
  const mainDeptIdOf = useCallback(
    (deptId: string): string => {
      if (!deptId) return '';
      const d = deptById.get(deptId);
      return d ? d.parent_id || d.id : deptId;
    },
    [deptById],
  );

  const deptNameOf = useCallback(
    (deptId: string): string => (deptId ? deptById.get(deptId)?.name || '' : ''),
    [deptById],
  );

  /** The department the Employment tab currently means: the sub-department when
   *  one is set, else the main department. '' = nothing chosen yet. */
  const empDeptId = employmentDraft
    ? employmentDraft.sub_department_id || employmentDraft.department_id
    : '';

  /** MAIN department a newly created designation gets pinned to ('' = generic). */
  const createUnderDeptId = useMemo(() => mainDeptIdOf(empDeptId), [mainDeptIdOf, empDeptId]);
  const createUnderDeptName = useMemo(
    () => deptNameOf(createUnderDeptId),
    [deptNameOf, createUnderDeptId],
  );

  /** True when a designation may be offered for the chosen department. */
  const desigFitsDept = useCallback(
    (desigDeptId: string): boolean => {
      if (!desigDeptId) return true;   // generic — pickable everywhere
      if (!empDeptId) return true;     // no department chosen — nothing to filter by
      if (desigDeptId === empDeptId) return true;
      return mainDeptIdOf(desigDeptId) === mainDeptIdOf(empDeptId);
    },
    [empDeptId, mainDeptIdOf],
  );

  /** The designation this employee holds right now — the unsaved draft pick
   *  first, else the saved one. It is ALWAYS offered, whatever department it
   *  belongs to: hiding it would let a save silently blank a real assignment. */
  const heldDesigId = employmentDraft?.designation_id || emp?.designation_id || '';

  const designationOptions = useMemo<ComboOption[]>(() => {
    const optOf = (d: DesigRow): ComboOption => {
      const bits = [deptNameOf(d.department_id) || (d.department_id ? 'Other department' : 'Any department')];
      if (d.grade) bits.push(d.grade);
      return { value: d.id, label: d.name, hint: bits.join(' · ') };
    };
    const rows = desigShowAll
      ? designations
      : designations.filter((d) => d.id === heldDesigId || desigFitsDept(d.department_id));
    const opts = rows.map(optOf);
    // A held designation that is missing from the loaded list (deactivated on HR
    // Settings, or outside this fetch) still needs an option, or clearing the
    // field would make it unrecoverable without a reload.
    if (heldDesigId && !opts.some((o) => o.value === heldDesigId)) {
      const name = (emp?.designation_id === heldDesigId && emp?.designation_name) || '';
      if (name) opts.push({ value: heldDesigId, label: name, hint: 'currently assigned' });
    }
    opts.sort((a, b) => a.label.localeCompare(b.label));
    return [NONE, ...opts];
  }, [designations, desigShowAll, desigFitsDept, heldDesigId, deptNameOf, emp, NONE]);

  /** How many active designations the department filter is hiding right now
   *  (0 when nothing is filtered — the 'Show all' link only earns its place
   *  when it would actually reveal something). */
  const desigHiddenCount = useMemo(
    () =>
      designations.filter((d) => d.id !== heldDesigId && !desigFitsDept(d.department_id)).length,
    [designations, heldDesigId, desigFitsDept],
  );

  /** The held designation when it belongs to ANOTHER department than the one
   *  chosen — kept in the list, but flagged so a human decides. */
  const heldDesigMismatch = useMemo(() => {
    // Only the DRAFT pick is flagged — that is what a Save would write. (The
    // option list is wider: it also keeps the saved designation available so
    // clearing the field stays reversible.)
    const draftId = employmentDraft?.designation_id || '';
    if (!draftId || !empDeptId) return null;
    const row = designations.find((d) => d.id === draftId);
    if (!row || !row.department_id) return null;      // unknown or generic — nothing to flag
    if (desigFitsDept(row.department_id)) return null;
    return {
      name: row.name,
      dept: deptNameOf(row.department_id) || 'another department',
    };
  }, [employmentDraft?.designation_id, empDeptId, designations, desigFitsDept, deptNameOf]);

  /** Free-typed designation text that matches no loaded designation ('' when
   *  the field holds a real pick, is blank, or the text names an existing row).
   *  Drives both the create affordance and the save guard — a typed label must
   *  never be silently dropped by the PUT. */
  const desigUnmatched = useMemo<string>(() => {
    const typed = (desigTyped || '').trim();
    if (!typed) return '';
    const hit = designations.some((d) => (d.name || '').trim().toLowerCase() === typed.toLowerCase());
    return hit ? '' : typed;
  }, [desigTyped, designations]);

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

  /**
   * Create the free-typed designation, then select it — the explicit half of
   * the "unknown designation is a prompt" rule. Only rendered for admins
   * (POST /api/hr/designations is canAdminHr); the server re-checks, and a 403
   * or the 409 'already exists' body is surfaced VERBATIM rather than swallowed.
   *
   * The new row is pinned to the MAIN department of whatever the Employment tab
   * has selected (a sub-department resolves to its main, so "Commis I" typed
   * under Kitchen → Hot Kitchen lands on Kitchen and offers across the whole
   * Kitchen tree). Nothing chosen → department_id '' = generic, pickable
   * everywhere. Grade stays curated on HR Settings.
   */
  const createDesignation = async () => {
    const name = desigUnmatched;
    if (!name) return;
    setDesigCreating(true); setDesigCreateErr(null);
    try {
      const res = await api('/api/hr/designations', {
        method: 'POST',
        body: { name, department_id: createUnderDeptId },
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setDesigCreateErr(j?.error || 'Could not create the designation.'); return; }
      const raw = j?.designation as DesigRow | undefined;
      if (!raw?.id) { setDesigCreateErr('Could not create the designation.'); return; }
      // Trust the server's stored department_id (it is the row that will come
      // back on the next GET), defaulting to generic if the column is absent.
      const row: DesigRow = { ...raw, department_id: raw.department_id || '' };
      // Append (name-sorted, like the GET) + select. Nothing is written to the
      // employee yet — the Employment tab still saves on its own Save.
      setDesignations((prev) =>
        prev.some((d) => d.id === row.id)
          ? prev
          : [...prev, row].sort((a, b) => (a.name || '').localeCompare(b.name || '')),
      );
      setEmploymentDraft((d) => (d ? { ...d, designation_id: row.id } : d));
      setDesigTyped(null);
      setEmploymentErr(null);
    } catch {
      setDesigCreateErr('Could not create the designation. Check your connection.');
    } finally {
      setDesigCreating(false);
    }
  };

  const saveEmployment = async () => {
    if (!employmentDraft) return;
    // A typed-but-unsaved designation would be silently dropped by the PUT
    // (designation_id is blank while the text matches nothing) — refuse, and
    // say which way out this viewer actually has.
    if (desigUnmatched) {
      setEmploymentErr(
        isAdmin
          ? `"${desigUnmatched}" is not a saved designation — use the Create button under the Designation field, or pick one from the list.`
          : `"${desigUnmatched}" is not a saved designation — pick one from the list, or ask an admin to add it on HR Settings.`,
      );
      setEmploymentOk(false);
      return;
    }
    setEmploymentSaving(true); setEmploymentErr(null); setEmploymentOk(false);
    try {
      const res = await api(apiUrl, { method: 'PUT', body: { ...employmentDraft } });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setEmploymentErr(j?.error || 'Could not save employment details.'); return; }
      const fresh = await load();
      if (fresh) setEmploymentDraft(employmentFromEmp(fresh));
      // Drop any leftover typed text so the picker reads back off the saved id.
      setDesigTyped(null);
      setDesigCreateErr(null);
      setEmploymentOk(true);
      setTimeout(() => setEmploymentOk(false), 2500);
    } catch {
      setEmploymentErr('Could not save employment details. Check your connection.');
    } finally {
      setEmploymentSaving(false);
    }
  };

  /* ---- Phase 4/6 tab loaders (each tab lazy-fetches on first open) ---- */

  const loadSalary = useCallback(async () => {
    setSalLoading(true); setSalErr(null);
    try {
      const r = await fetch(`/api/hr/salary-structures?employee_id=${encodeURIComponent(id)}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setSalErr(j?.error || `Could not load the salary history (HTTP ${r.status}).`); return; }
      setSalRows(Array.isArray(j?.rows) ? (j.rows as SalaryRow[]) : []);
    } catch {
      setSalErr('Could not load the salary history. Check your connection.');
    } finally {
      setSalLoading(false);
    }
  }, [id]);

  const loadBank = useCallback(async () => {
    setBankLoading(true); setBankErr(null);
    try {
      const r = await fetch(`/api/hr/bank?employee_id=${encodeURIComponent(id)}&include_inactive=1&pageSize=100`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setBankErr(j?.error || `Could not load bank accounts (HTTP ${r.status}).`); return; }
      setBankRows(Array.isArray(j?.rows) ? (j.rows as BankRow[]) : []);
      setBankCanFull(!!j?.can_view_full);
    } catch {
      setBankErr('Could not load bank accounts. Check your connection.');
    } finally {
      setBankLoading(false);
    }
  }, [id]);

  const loadDocs = useCallback(async () => {
    setDocLoading(true); setDocErr(null);
    try {
      const r = await fetch(`/api/hr/documents?employee_id=${encodeURIComponent(id)}&pageSize=100`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setDocErr(j?.error || `Could not load documents (HTTP ${r.status}).`); return; }
      setDocRows(Array.isArray(j?.rows) ? (j.rows as DocRow[]) : []);
    } catch {
      setDocErr('Could not load documents. Check your connection.');
    } finally {
      setDocLoading(false);
    }
  }, [id]);

  const loadAdvances = useCallback(async () => {
    setAdvLoading(true); setAdvErr(null);
    try {
      const r = await fetch(`/api/hr/advances?employee_id=${encodeURIComponent(id)}&pageSize=100`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setAdvErr(j?.error || `Could not load advances (HTTP ${r.status}).`); return; }
      setAdvRows(Array.isArray(j?.rows) ? (j.rows as AdvanceRow[]) : []);
    } catch {
      setAdvErr('Could not load advances. Check your connection.');
    } finally {
      setAdvLoading(false);
    }
  }, [id]);

  const loadAssets = useCallback(async () => {
    setAssetLoading(true); setAssetErr(null);
    try {
      const r = await fetch(`/api/hr/assets?employee_id=${encodeURIComponent(id)}&pageSize=100`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setAssetErr(j?.error || `Could not load assets (HTTP ${r.status}).`); return; }
      setAssetRows(Array.isArray(j?.rows) ? (j.rows as AssetRow[]) : []);
    } catch {
      setAssetErr('Could not load assets. Check your connection.');
    } finally {
      setAssetLoading(false);
    }
  }, [id]);

  const loadDisciplinary = useCallback(async () => {
    setDiscLoading(true); setDiscErr(null);
    try {
      const r = await fetch(`/api/hr/disciplinary?employee_id=${encodeURIComponent(id)}&pageSize=100`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setDiscErr(j?.error || `Could not load disciplinary records (HTTP ${r.status}).`); return; }
      setDiscRows(Array.isArray(j?.rows) ? (j.rows as DiscRow[]) : []);
    } catch {
      setDiscErr('Could not load disciplinary records. Check your connection.');
    } finally {
      setDiscLoading(false);
    }
  }, [id]);

  // Lazy fetch on first open. Admin-only tabs wait for /api/auth/me and never
  // fire for non-admins (they render a lock card instead — and the API would
  // 403 anyway; the server is the boundary).
  useEffect(() => {
    if (!id) return;
    if (tab === 'salary' && meLoaded && isAdmin && salRows === null && !salLoading) loadSalary();
    else if (tab === 'bank' && bankRows === null && !bankLoading) loadBank();
    else if (tab === 'documents' && meLoaded && isAdmin && docRows === null && !docLoading) loadDocs();
    else if (tab === 'advances' && advRows === null && !advLoading) loadAdvances();
    else if (tab === 'assets' && assetRows === null && !assetLoading) loadAssets();
    else if (tab === 'disciplinary' && meLoaded && isAdmin && discRows === null && !discLoading) loadDisciplinary();
  }, [
    tab, id, meLoaded, isAdmin,
    salRows, salLoading, loadSalary,
    bankRows, bankLoading, loadBank,
    docRows, docLoading, loadDocs,
    advRows, advLoading, loadAdvances,
    assetRows, assetLoading, loadAssets,
    discRows, discLoading, loadDisciplinary,
  ]);

  /* ---- Salary revise (append-only money history: POST inserts a new
   * structure; the server closes the previous open row in the same
   * transaction — nothing here ever edits an old row) ---- */

  const openRevise = () => {
    // Pre-fill from the current structure so a routine revision is one edit.
    const current = (salRows || []).find((s) => s.effective_to === '') || (salRows || [])[0];
    setRevEffFrom('');
    setRevBasic(current ? String(current.basic) : '');
    setRevHra(current ? String(current.hra) : '');
    setRevAllow(parseMoneyLines(current?.allowances_json).map((l) => ({ label: l.label, amount: String(l.amount) })));
    setRevDed(parseMoneyLines(current?.deductions_json).map((l) => ({ label: l.label, amount: String(l.amount) })));
    setRevNote('');
    setRevErr(null);
    setReviseOpen(true);
  };

  const lineTotal = (lines: MoneyLine[]): number =>
    lines.reduce((sum, l) => sum + (Number(l.amount) || 0), 0);

  // Client-side preview only — the server recomputes both and is the truth.
  const revGross = (Number(revBasic) || 0) + (Number(revHra) || 0) + lineTotal(revAllow);
  const revNet = revGross - lineTotal(revDed);

  const submitRevise = async () => {
    if (!revEffFrom) { setRevErr('An effective-from date is required.'); return; }
    const badLine = [...revAllow, ...revDed].find((l) => !l.label.trim() || !(Number(l.amount) >= 0));
    if (badLine) { setRevErr('Every allowance/deduction line needs a label and a non-negative amount.'); return; }
    setRevSaving(true); setRevErr(null);
    try {
      const res = await api('/api/hr/salary-structures', {
        method: 'POST',
        body: {
          employee_id: id,
          effective_from: revEffFrom,
          basic: Number(revBasic) || 0,
          hra: Number(revHra) || 0,
          allowances_json: revAllow.map((l) => ({ label: l.label.trim(), amount: Number(l.amount) || 0 })),
          deductions_json: revDed.map((l) => ({ label: l.label.trim(), amount: Number(l.amount) || 0 })),
          note: revNote.trim(),
        },
      });
      const j = await res.json().catch(() => ({}));
      // Server 400/409 messages are named, human strings — surface verbatim.
      if (!res.ok) { setRevErr(j?.error || 'Could not save the salary revision.'); return; }
      setReviseOpen(false);
      await loadSalary();
    } catch {
      setRevErr('Could not save the salary revision. Check your connection.');
    } finally {
      setRevSaving(false);
    }
  };

  /* ---- Bank ---- */

  const openBankAdd = () => {
    setBankDraft({
      bank_name: '',
      account_holder: emp?.full_name || '',
      account_number: '',
      ifsc: '',
      branch: '',
      account_type: 'savings',
      is_active: true,
    });
    setBankModalErr(null);
    setBankModal({ mode: 'add' });
  };

  const openBankEdit = (row: BankRow) => {
    setBankDraft({
      bank_name: row.bank_name || '',
      account_holder: row.account_holder || '',
      account_number: row.account_number || '',
      ifsc: row.ifsc || '',
      branch: row.branch || '',
      account_type: row.account_type || 'savings',
      is_active: !!row.is_active,
    });
    setBankModalErr(null);
    setBankModal({ mode: 'edit', row });
  };

  const submitBank = async () => {
    if (!bankDraft || !bankModal) return;
    if (!bankDraft.account_number.trim()) { setBankModalErr('Account number is required.'); return; }
    if (!bankDraft.ifsc.trim()) { setBankModalErr('IFSC is required.'); return; }
    setBankSaving(true); setBankModalErr(null);
    try {
      const fields = {
        bank_name: bankDraft.bank_name.trim(),
        account_holder: bankDraft.account_holder.trim(),
        account_number: bankDraft.account_number.trim(),
        ifsc: bankDraft.ifsc.trim(),
        branch: bankDraft.branch.trim(),
        account_type: bankDraft.account_type,
      };
      // employee_id rides only on CREATE — a bank row belongs to one person
      // forever (the PUT route refuses to move it).
      const res = bankModal.mode === 'add'
        ? await api('/api/hr/bank', { method: 'POST', body: { employee_id: id, ...fields } })
        : await api('/api/hr/bank', {
            method: 'PUT',
            body: { id: bankModal.row.id, ...fields, is_active: bankDraft.is_active },
          });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setBankModalErr(j?.error || 'Could not save the bank account.'); return; }
      setBankModal(null);
      await loadBank();
    } catch {
      setBankModalErr('Could not save the bank account. Check your connection.');
    } finally {
      setBankSaving(false);
    }
  };

  const decideBank = async (row: BankRow, action: 'verify' | 'reject') => {
    setBankVerifyBusy(row.id); setBankErr(null);
    try {
      const res = await api('/api/hr/bank', { method: 'PATCH', body: { id: row.id, action } });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setBankErr(j?.error || 'Could not update the verification.'); return; }
      await loadBank();
    } catch {
      setBankErr('Could not update the verification. Check your connection.');
    } finally {
      setBankVerifyBusy(null);
    }
  };

  /* ---- Documents ---- */

  const openDocModal = () => {
    setDocFile(null); setDocType(''); setDocNumber(''); setDocIssue(''); setDocExpiry('');
    setDocModalErr(null); setDocModal(true);
  };

  const submitDoc = async () => {
    if (!docFile) { setDocModalErr('Pick a file to upload first.'); return; }
    if (docFile.size > DOC_MAX_BYTES) { setDocModalErr('Document too large - 5MB max.'); return; }
    setDocSaving(true); setDocModalErr(null);
    try {
      // JSON data:-URI shape of POST /api/hr/documents (no compression — PDFs
      // must arrive byte-identical; the 5MB cap was checked above).
      const dataUri = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ''));
        fr.onerror = () => reject(new Error('Could not read the file'));
        fr.readAsDataURL(docFile);
      });
      const res = await api('/api/hr/documents', {
        method: 'POST',
        body: {
          data: dataUri,
          filename: docFile.name,
          employee_id: id,
          doc_type: docType,
          doc_number: docNumber.trim(),
          issue_date: docIssue,
          expiry_date: docExpiry,
        },
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setDocModalErr(j?.error || 'Could not upload the document.'); return; }
      setDocModal(false);
      await loadDocs();
    } catch {
      setDocModalErr('Could not upload the document. Check your connection.');
    } finally {
      setDocSaving(false);
    }
  };

  /* ---- Assets: per-asset movement ledger on demand ---- */

  const fetchAssetHistory = useCallback(async (assetId: string) => {
    setAssetHist((h) => ({ ...h, [assetId]: { loading: true, err: null, rows: null } }));
    try {
      const r = await fetch(`/api/hr/assets?id=${encodeURIComponent(assetId)}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setAssetHist((h) => ({
          ...h,
          [assetId]: { loading: false, err: j?.error || 'Could not load the movement history.', rows: null },
        }));
        return;
      }
      setAssetHist((h) => ({
        ...h,
        [assetId]: {
          loading: false,
          err: null,
          rows: Array.isArray(j?.history) ? (j.history as AssetHistRow[]) : [],
        },
      }));
    } catch {
      setAssetHist((h) => ({
        ...h,
        [assetId]: { loading: false, err: 'Could not load the movement history. Check your connection.', rows: null },
      }));
    }
  }, []);

  const toggleAssetHistory = (assetId: string) => {
    if (assetOpenId === assetId) { setAssetOpenId(null); return; }
    setAssetOpenId(assetId);
    const cur = assetHist[assetId];
    if (!cur || (!cur.loading && cur.rows === null)) fetchAssetHistory(assetId);
  };

  /* ---- Advances: outstanding balance (money owed = disbursed, not yet
   * recovered; approved-but-undisbursed is committed, not owed) ---- */

  const advTotals = useMemo(() => {
    const rows = advRows || [];
    let disbursed = 0;
    let recovered = 0;
    let outstanding = 0;
    for (const a of rows) {
      if (a.status === 'disbursed' || a.status === 'closed') {
        disbursed += a.approved_amount || 0;
        recovered += a.recovered_amount || 0;
      }
      if (a.status === 'disbursed') {
        outstanding += Math.max(0, (a.approved_amount || 0) - (a.recovered_amount || 0));
      }
    }
    return { disbursed, recovered, outstanding };
  }, [advRows]);

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
              {/* LATER-PHASE INSERTION POINT — further tabs (Attendance,
                  Leave, …) append here: add the key to TABS above and a
                  matching `tab === '…'` section below. */}
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
                      value={
                        desigTyped ??
                        labelFor(designationOptions, employmentDraft.designation_id, emp.designation_name || '')
                      }
                      onChange={(v, opt) => {
                        setDesigCreateErr(null);
                        if (opt) {
                          // A real pick (including "— None —"): the id is the truth
                          // again, so the typed-text overlay goes away.
                          setDesigTyped(null);
                          setEmploymentDraft((d) => (d ? { ...d, designation_id: opt.value } : d));
                          return;
                        }
                        // Typing the exact name of a designation the DEPARTMENT
                        // FILTER is hiding must not read as "unknown" — that
                        // would blank the field on save. Resolve it against the
                        // full master and select it, lifting the filter so the
                        // pick is visible in the list too.
                        const typed = v.trim().toLowerCase();
                        const hidden = typed
                          ? designations.find((d) => (d.name || '').trim().toLowerCase() === typed)
                          : undefined;
                        if (hidden) {
                          setDesigTyped(null);
                          setDesigShowAll(true);
                          setEmploymentDraft((d) => (d ? { ...d, designation_id: hidden.id } : d));
                          return;
                        }
                        // Free text matching nothing: hold it locally and drop the
                        // id, so a stale pick can never ride along under a label
                        // that no longer describes it. Save is guarded until this
                        // is resolved (created, picked, or cleared).
                        setDesigTyped(v);
                        setEmploymentDraft((d) => (d ? { ...d, designation_id: '' } : d));
                      }}
                      allowCustom
                      placeholder="Pick a designation…"
                    />

                    {/* The department filter, stated plainly with the way out.
                        Only rendered when it is actually hiding something — a
                        toggle that reveals nothing is noise. */}
                    {empDeptId && (desigHiddenCount > 0 || desigShowAll) && (
                      <p className="mt-1 text-[11px] text-[#8B7355]">
                        {desigShowAll ? (
                          <>
                            Showing all designations.{' '}
                            <button
                              type="button"
                              onClick={() => setDesigShowAll(false)}
                              className="underline text-[#af4408] hover:text-[#8a3506]"
                            >
                              Filter by {deptNameOf(empDeptId) || 'department'}
                            </button>
                          </>
                        ) : (
                          <>
                            Showing designations for {deptNameOf(empDeptId) || 'this department'} plus generic
                            ones · {desigHiddenCount} hidden.{' '}
                            <button
                              type="button"
                              onClick={() => setDesigShowAll(true)}
                              className="underline text-[#af4408] hover:text-[#8a3506]"
                            >
                              Show all designations
                            </button>
                          </>
                        )}
                      </p>
                    )}

                    {/* The held designation belongs elsewhere: it stays in the
                        list (hiding it would blank a real assignment on save) —
                        flagged so a human decides, never auto-cleared. */}
                    {heldDesigMismatch && (
                      <p className="mt-1 flex items-start gap-1 text-[11px] text-amber-700">
                        <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                        <span>
                          &quot;{heldDesigMismatch.name}&quot; belongs to {heldDesigMismatch.dept}, not{' '}
                          {deptNameOf(empDeptId) || 'the chosen department'}. It is kept as-is — change it only
                          if it is wrong.
                        </span>
                      </p>
                    )}

                    {/* Unknown designation → a prompt, not an error. Admin-only,
                        because POST /api/hr/designations is canAdminHr; managers
                        get the pointer instead of a button that would 403. */}
                    {!!desigUnmatched && meLoaded && (
                      isAdmin ? (
                        <div className="mt-1.5 space-y-1">
                          <button
                            type="button"
                            onClick={createDesignation}
                            disabled={desigCreating}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-[#af4408] bg-white text-[#af4408] hover:bg-[#FFF1E3] text-xs font-medium disabled:opacity-50"
                          >
                            {desigCreating
                              ? <Loader2 className="w-3 h-3 animate-spin" />
                              : <Plus className="w-3 h-3" />}
                            Create &quot;{desigUnmatched}&quot;{' '}
                            {createUnderDeptName ? `under ${createUnderDeptName}` : '(any department)'}
                          </button>
                          <p className="text-[11px] text-[#8B7355]">
                            {createUnderDeptName
                              ? `Adds it to the designations master under ${createUnderDeptName}, so it offers across that department — deactivate or re-link it later on HR Settings.`
                              : 'No department chosen, so it is added as generic — pickable for every department. Link it to one later on HR Settings.'}
                          </p>
                          {desigCreateErr && (
                            <div className="rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-700">
                              {desigCreateErr}
                            </div>
                          )}
                        </div>
                      ) : (
                        <p className="mt-1.5 text-[11px] text-[#8B7355]">
                          &quot;{desigUnmatched}&quot; is not a saved designation. Pick one from the list, or ask an
                          admin to add it on{' '}
                          <Link href="/hr/settings" className="underline text-[#af4408] hover:text-[#8a3506]">
                            HR Settings
                          </Link>
                          .
                        </p>
                      )
                    )}
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

            {/* ---- Salary (admin-only surface; APIs re-check server-side) ---- */}
            {tab === 'salary' && (
              meLoaded && !isAdmin ? (
                <LockCard name="Salary" />
              ) : salErr ? (
                <TabErrorBanner msg={salErr} onRetry={loadSalary} />
              ) : !meLoaded || salRows === null ? (
                <TabLoadingCard />
              ) : (
                <div className="bg-white border border-[#E8D5C4] rounded-xl shadow">
                  <div className="px-5 py-4 border-b border-[#E8D5C4] flex flex-wrap items-center justify-between gap-3">
                    <h2 className="font-bold text-[#2D1B0E] text-sm flex items-center gap-1.5">
                      <IndianRupee className="w-4 h-4 text-[#af4408]" /> Salary structure history
                    </h2>
                    <button
                      onClick={openRevise}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium"
                    >
                      <Plus className="w-4 h-4" /> Revise
                    </button>
                  </div>
                  {salRows.length === 0 ? (
                    <p className="px-5 py-6 text-sm text-[#8B7355]">
                      No salary structure on file yet — record the first one with Revise.
                    </p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                          <tr>
                            <th className="text-left py-2 px-3 font-medium">Effective</th>
                            <th className="text-right py-2 px-3 font-medium">Basic</th>
                            <th className="text-right py-2 px-3 font-medium">HRA</th>
                            <th className="text-right py-2 px-3 font-medium">Allowances</th>
                            <th className="text-right py-2 px-3 font-medium">Gross</th>
                            <th className="text-right py-2 px-3 font-medium">Deductions</th>
                            <th className="text-right py-2 px-3 font-medium">Net</th>
                            <th className="text-left py-2 px-3 font-medium">Note</th>
                            <th className="text-left py-2 px-3 font-medium">Revised by</th>
                          </tr>
                        </thead>
                        <tbody>
                          {salRows.map((row) => {
                            const allow = parseMoneyLines(row.allowances_json);
                            const ded = parseMoneyLines(row.deductions_json);
                            const isCurrent = row.effective_to === '';
                            return (
                              <tr key={row.id} className="border-t border-[#E8D5C4]/60 align-top">
                                <td className="py-2 px-3 whitespace-nowrap">
                                  <div className="flex items-center gap-2">
                                    <span>
                                      {fmtISTDate(row.effective_from)}
                                      {' → '}
                                      {isCurrent ? 'onwards' : fmtISTDate(row.effective_to)}
                                    </span>
                                    {isCurrent && (
                                      <span className="inline-flex items-center px-2 py-0.5 rounded-full border text-xs font-medium bg-green-100 text-green-700 border-green-200">
                                        Current
                                      </span>
                                    )}
                                  </div>
                                </td>
                                <td className="py-2 px-3 text-right whitespace-nowrap">{inr(row.basic)}</td>
                                <td className="py-2 px-3 text-right whitespace-nowrap">{inr(row.hra)}</td>
                                <td className="py-2 px-3 text-right">
                                  <div className="whitespace-nowrap">
                                    {inr(allow.reduce((sum, l) => sum + l.amount, 0))}
                                  </div>
                                  {allow.map((l, i) => (
                                    <div key={i} className="text-[11px] text-[#8B7355] whitespace-nowrap">
                                      {l.label}: {inr(l.amount)}
                                    </div>
                                  ))}
                                </td>
                                <td className="py-2 px-3 text-right font-medium whitespace-nowrap">{inr(row.gross)}</td>
                                <td className="py-2 px-3 text-right">
                                  <div className="whitespace-nowrap">
                                    {inr(ded.reduce((sum, l) => sum + l.amount, 0))}
                                  </div>
                                  {ded.map((l, i) => (
                                    <div key={i} className="text-[11px] text-[#8B7355] whitespace-nowrap">
                                      {l.label}: {inr(l.amount)}
                                    </div>
                                  ))}
                                </td>
                                <td className="py-2 px-3 text-right font-bold whitespace-nowrap">{inr(row.net)}</td>
                                <td className="py-2 px-3 max-w-[220px]">
                                  <span className="block truncate" title={row.note}>{row.note || '—'}</span>
                                </td>
                                <td className="py-2 px-3 whitespace-nowrap">
                                  <div>{row.created_by || '—'}</div>
                                  <div className="text-[11px] text-[#8B7355]">{fmtIST(row.created_at)}</div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )
            )}

            {/* ---- Bank (management sees the masked list; admin actions) ---- */}
            {tab === 'bank' && (
              bankErr ? (
                <TabErrorBanner msg={bankErr} onRetry={loadBank} />
              ) : bankRows === null ? (
                <TabLoadingCard />
              ) : (
                <div className="bg-white border border-[#E8D5C4] rounded-xl shadow">
                  <div className="px-5 py-4 border-b border-[#E8D5C4] flex flex-wrap items-center justify-between gap-3">
                    <h2 className="font-bold text-[#2D1B0E] text-sm flex items-center gap-1.5">
                      <Landmark className="w-4 h-4 text-[#af4408]" /> Bank accounts
                    </h2>
                    {isAdmin && (
                      <button
                        onClick={openBankAdd}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium"
                      >
                        <Plus className="w-4 h-4" /> Add account
                      </button>
                    )}
                  </div>
                  {!bankCanFull && bankRows.length > 0 && (
                    <p className="px-5 pt-3 text-[11px] text-[#8B7355]">
                      Account numbers are masked — the full number is visible to admins only.
                    </p>
                  )}
                  {bankRows.length === 0 ? (
                    <p className="px-5 py-6 text-sm text-[#8B7355]">No bank account on file for this employee.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                          <tr>
                            <th className="text-left py-2 px-3 font-medium">Bank</th>
                            <th className="text-left py-2 px-3 font-medium">Account holder</th>
                            <th className="text-left py-2 px-3 font-medium">Account number</th>
                            <th className="text-left py-2 px-3 font-medium">IFSC</th>
                            <th className="text-left py-2 px-3 font-medium">Branch</th>
                            <th className="text-left py-2 px-3 font-medium">Type</th>
                            <th className="text-left py-2 px-3 font-medium">Verification</th>
                            <th className="text-left py-2 px-3 font-medium">Active</th>
                            {isAdmin && <th className="text-right py-2 px-3 font-medium">Actions</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {bankRows.map((row) => (
                            <tr key={row.id} className={`border-t border-[#E8D5C4]/60 ${row.is_active ? '' : 'opacity-60'}`}>
                              <td className="py-2 px-3 whitespace-nowrap">{row.bank_name || '—'}</td>
                              <td className="py-2 px-3 whitespace-nowrap">{row.account_holder || '—'}</td>
                              <td className="py-2 px-3 font-mono whitespace-nowrap">{row.account_number || '—'}</td>
                              <td className="py-2 px-3 font-mono whitespace-nowrap">{row.ifsc || '—'}</td>
                              <td className="py-2 px-3 whitespace-nowrap">{row.branch || '—'}</td>
                              <td className="py-2 px-3 capitalize whitespace-nowrap">{row.account_type || '—'}</td>
                              <td className="py-2 px-3 whitespace-nowrap">
                                <div title={row.verified_by ? `${row.verified_by} · ${fmtIST(row.verified_at)}` : undefined}>
                                  <VerifyBadge status={row.verify_status} />
                                </div>
                              </td>
                              <td className="py-2 px-3 whitespace-nowrap">{row.is_active ? 'Yes' : 'No'}</td>
                              {isAdmin && (
                                <td className="py-2 px-3 whitespace-nowrap text-right">
                                  <div className="inline-flex items-center gap-2">
                                    {bankVerifyBusy === row.id ? (
                                      <Loader2 className="w-4 h-4 animate-spin text-[#8B7355]" />
                                    ) : (
                                      <>
                                        {row.verify_status !== 'verified' && (
                                          <button
                                            onClick={() => decideBank(row, 'verify')}
                                            className="inline-flex items-center gap-1 text-xs font-medium text-green-700 hover:underline"
                                          >
                                            <BadgeCheck className="w-3.5 h-3.5" /> Verify
                                          </button>
                                        )}
                                        {row.verify_status !== 'rejected' && (
                                          <button
                                            onClick={() => decideBank(row, 'reject')}
                                            className="inline-flex items-center gap-1 text-xs font-medium text-red-600 hover:underline"
                                          >
                                            <Ban className="w-3.5 h-3.5" /> Reject
                                          </button>
                                        )}
                                        <button
                                          onClick={() => openBankEdit(row)}
                                          title="Edit account"
                                          aria-label="Edit account"
                                          className="text-[#8B7355] hover:text-[#af4408]"
                                        >
                                          <Pencil className="w-3.5 h-3.5" />
                                        </button>
                                      </>
                                    )}
                                  </div>
                                </td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )
            )}

            {/* ---- Documents (admin-only surface; APIs re-check) ---- */}
            {tab === 'documents' && (
              meLoaded && !isAdmin ? (
                <LockCard name="Documents" />
              ) : docErr ? (
                <TabErrorBanner msg={docErr} onRetry={loadDocs} />
              ) : !meLoaded || docRows === null ? (
                <TabLoadingCard />
              ) : (
                <div className="bg-white border border-[#E8D5C4] rounded-xl shadow">
                  <div className="px-5 py-4 border-b border-[#E8D5C4] flex flex-wrap items-center justify-between gap-3">
                    <h2 className="font-bold text-[#2D1B0E] text-sm flex items-center gap-1.5">
                      <FileText className="w-4 h-4 text-[#af4408]" /> Documents
                    </h2>
                    <button
                      onClick={openDocModal}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium"
                    >
                      <Upload className="w-4 h-4" /> Upload
                    </button>
                  </div>
                  {docRows.length === 0 ? (
                    <p className="px-5 py-6 text-sm text-[#8B7355]">No documents on file for this employee.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                          <tr>
                            <th className="text-left py-2 px-3 font-medium">Type</th>
                            <th className="text-left py-2 px-3 font-medium">Number</th>
                            <th className="text-left py-2 px-3 font-medium">File</th>
                            <th className="text-left py-2 px-3 font-medium">Issued</th>
                            <th className="text-left py-2 px-3 font-medium">Expires</th>
                            <th className="text-right py-2 px-3 font-medium">Size</th>
                            <th className="text-left py-2 px-3 font-medium">Verification</th>
                            <th className="text-left py-2 px-3 font-medium">Uploaded</th>
                          </tr>
                        </thead>
                        <tbody>
                          {docRows.map((d) => {
                            const expired = !!d.expiry_date && d.expiry_date < todayIST();
                            return (
                              <tr key={d.id} className="border-t border-[#E8D5C4]/60">
                                <td className="py-2 px-3 whitespace-nowrap">
                                  <MetaBadge meta={docTypeMeta(d.doc_type)} />
                                </td>
                                <td className="py-2 px-3 font-mono whitespace-nowrap">{d.doc_number || '—'}</td>
                                <td className="py-2 px-3 max-w-[240px]">
                                  <a
                                    href={`/api/hr/documents/${encodeURIComponent(d.id)}/file`}
                                    className="inline-flex items-center gap-1 text-[#af4408] hover:underline max-w-full"
                                  >
                                    <Download className="w-3.5 h-3.5 shrink-0" />
                                    <span className="truncate" title={d.filename}>{d.filename || 'document'}</span>
                                  </a>
                                </td>
                                <td className="py-2 px-3 whitespace-nowrap">
                                  {d.issue_date ? fmtISTDate(d.issue_date) : '—'}
                                </td>
                                <td className={`py-2 px-3 whitespace-nowrap ${expired ? 'text-red-600 font-medium' : ''}`}>
                                  {d.expiry_date ? `${fmtISTDate(d.expiry_date)}${expired ? ' (expired)' : ''}` : '—'}
                                </td>
                                <td className="py-2 px-3 text-right whitespace-nowrap">{fmtBytes(d.size_bytes)}</td>
                                <td className="py-2 px-3 whitespace-nowrap"><VerifyBadge status={d.verify_status} /></td>
                                <td className="py-2 px-3 whitespace-nowrap">
                                  <div>{d.uploaded_by || '—'}</div>
                                  <div className="text-[11px] text-[#8B7355]">{fmtIST(d.created_at)}</div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )
            )}

            {/* ---- Advances (read-only history + outstanding balance) ---- */}
            {tab === 'advances' && (
              advErr ? (
                <TabErrorBanner msg={advErr} onRetry={loadAdvances} />
              ) : advRows === null ? (
                <TabLoadingCard />
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <StatCard label="Disbursed (lifetime)" value={inr(advTotals.disbursed)} />
                    <StatCard label="Recovered" value={inr(advTotals.recovered)} />
                    <StatCard label="Outstanding balance" value={inr(advTotals.outstanding)} highlight />
                  </div>
                  <div className="bg-white border border-[#E8D5C4] rounded-xl shadow">
                    <div className="px-5 py-4 border-b border-[#E8D5C4]">
                      <h2 className="font-bold text-[#2D1B0E] text-sm flex items-center gap-1.5">
                        <Wallet className="w-4 h-4 text-[#af4408]" /> Advance history
                      </h2>
                    </div>
                    {advRows.length === 0 ? (
                      <p className="px-5 py-6 text-sm text-[#8B7355]">No advances on record for this employee.</p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                            <tr>
                              <th className="w-8 py-2 px-2"></th>
                              <th className="text-left py-2 px-3 font-medium">Requested</th>
                              <th className="text-right py-2 px-3 font-medium">Requested ₹</th>
                              <th className="text-right py-2 px-3 font-medium">Approved ₹</th>
                              <th className="text-right py-2 px-3 font-medium">Installment</th>
                              <th className="text-right py-2 px-3 font-medium">Recovered</th>
                              <th className="text-right py-2 px-3 font-medium">Outstanding</th>
                              <th className="text-left py-2 px-3 font-medium">Status</th>
                              <th className="text-left py-2 px-3 font-medium">Reason</th>
                            </tr>
                          </thead>
                          <tbody>
                            {advRows.map((a) => {
                              const open = advOpenId === a.id;
                              const owed =
                                a.status === 'approved' || a.status === 'disbursed'
                                  ? Math.max(0, (a.approved_amount || 0) - (a.recovered_amount || 0))
                                  : null;
                              const installments = a.installments || [];
                              return (
                                <Fragment key={a.id}>
                                  <tr className="border-t border-[#E8D5C4]/60">
                                    <td className="py-2 px-2">
                                      <button
                                        onClick={() => setAdvOpenId(open ? null : a.id)}
                                        title={open ? 'Hide installments' : 'Show installments'}
                                        aria-label={open ? 'Hide installments' : 'Show installments'}
                                        className="text-[#8B7355] hover:text-[#af4408]"
                                      >
                                        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                                      </button>
                                    </td>
                                    <td className="py-2 px-3 whitespace-nowrap">{fmtIST(a.requested_at)}</td>
                                    <td className="py-2 px-3 text-right whitespace-nowrap">{inr(a.requested_amount)}</td>
                                    <td className="py-2 px-3 text-right whitespace-nowrap">
                                      {a.approved_amount ? inr(a.approved_amount) : '—'}
                                    </td>
                                    <td className="py-2 px-3 text-right whitespace-nowrap">
                                      {a.installment_amount ? inr(a.installment_amount) : '—'}
                                    </td>
                                    <td className="py-2 px-3 text-right whitespace-nowrap">{inr(a.recovered_amount)}</td>
                                    <td className="py-2 px-3 text-right whitespace-nowrap font-medium">
                                      {owed === null ? '—' : inr(owed)}
                                    </td>
                                    <td className="py-2 px-3 whitespace-nowrap">
                                      <MetaBadge meta={advanceStatusMeta(a.status)} />
                                    </td>
                                    <td className="py-2 px-3 max-w-[220px]">
                                      <span className="block truncate" title={a.reason}>{a.reason || '—'}</span>
                                    </td>
                                  </tr>
                                  {open && (
                                    <tr className="border-t border-[#E8D5C4]/40 bg-[#FFF8F0]">
                                      <td colSpan={9} className="py-2 px-4">
                                        {installments.length === 0 ? (
                                          <p className="text-xs text-[#8B7355]">
                                            No recovery schedule yet — installments appear on approval.
                                          </p>
                                        ) : (
                                          <div className="flex flex-wrap gap-2">
                                            {installments.map((ins) => (
                                              <div
                                                key={ins.id}
                                                className="border border-[#E8D5C4] bg-white rounded-lg px-2.5 py-1.5 text-xs"
                                              >
                                                <span className="font-mono">{ins.period}</span>
                                                {' · '}
                                                <span className="font-medium">{inr(ins.amount)}</span>
                                                {' · '}
                                                <span
                                                  className={
                                                    ins.status === 'recovered'
                                                      ? 'text-green-700'
                                                      : ins.status === 'waived'
                                                        ? 'text-[#8B7355]'
                                                        : 'text-amber-700'
                                                  }
                                                >
                                                  {ins.status}
                                                </span>
                                              </div>
                                            ))}
                                          </div>
                                        )}
                                      </td>
                                    </tr>
                                  )}
                                </Fragment>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              )
            )}

            {/* ---- Assets (currently held + on-demand movement ledger) ---- */}
            {tab === 'assets' && (
              assetErr ? (
                <TabErrorBanner msg={assetErr} onRetry={loadAssets} />
              ) : assetRows === null ? (
                <TabLoadingCard />
              ) : (
                <div className="bg-white border border-[#E8D5C4] rounded-xl shadow">
                  <div className="px-5 py-4 border-b border-[#E8D5C4]">
                    <h2 className="font-bold text-[#2D1B0E] text-sm flex items-center gap-1.5">
                      <Package className="w-4 h-4 text-[#af4408]" /> Assets with this employee
                    </h2>
                  </div>
                  {assetRows.length === 0 ? (
                    <p className="px-5 py-6 text-sm text-[#8B7355]">No assets are currently held by this employee.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                          <tr>
                            <th className="w-8 py-2 px-2"></th>
                            <th className="text-left py-2 px-3 font-medium">Asset</th>
                            <th className="text-left py-2 px-3 font-medium">Kind</th>
                            <th className="text-left py-2 px-3 font-medium">Tag</th>
                            <th className="text-left py-2 px-3 font-medium">Status</th>
                            <th className="text-left py-2 px-3 font-medium">Note</th>
                            <th className="text-left py-2 px-3 font-medium">Updated</th>
                          </tr>
                        </thead>
                        <tbody>
                          {assetRows.map((a) => {
                            const open = assetOpenId === a.id;
                            const hist = assetHist[a.id];
                            return (
                              <Fragment key={a.id}>
                                <tr className="border-t border-[#E8D5C4]/60">
                                  <td className="py-2 px-2">
                                    <button
                                      onClick={() => toggleAssetHistory(a.id)}
                                      title={open ? 'Hide movement history' : 'Show movement history'}
                                      aria-label={open ? 'Hide movement history' : 'Show movement history'}
                                      className="text-[#8B7355] hover:text-[#af4408]"
                                    >
                                      {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                                    </button>
                                  </td>
                                  <td className="py-2 px-3 whitespace-nowrap font-medium">{a.name}</td>
                                  <td className="py-2 px-3 whitespace-nowrap"><MetaBadge meta={assetKindMeta(a.kind)} /></td>
                                  <td className="py-2 px-3 font-mono whitespace-nowrap">{a.tag || '—'}</td>
                                  <td className="py-2 px-3 whitespace-nowrap"><MetaBadge meta={assetStatusMeta(a.status)} /></td>
                                  <td className="py-2 px-3 max-w-[220px]">
                                    <span className="block truncate" title={a.note}>{a.note || '—'}</span>
                                  </td>
                                  <td className="py-2 px-3 whitespace-nowrap">{fmtIST(a.updated_at)}</td>
                                </tr>
                                {open && (
                                  <tr className="border-t border-[#E8D5C4]/40 bg-[#FFF8F0]">
                                    <td colSpan={7} className="py-2 px-4">
                                      {!hist || hist.loading ? (
                                        <div className="flex items-center gap-2 text-xs text-[#8B7355]">
                                          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading movement history...
                                        </div>
                                      ) : hist.err ? (
                                        <div className="text-xs text-red-700 flex items-center gap-2">
                                          <span>{hist.err}</span>
                                          <button onClick={() => fetchAssetHistory(a.id)} className="underline font-medium">
                                            Retry
                                          </button>
                                        </div>
                                      ) : (hist.rows || []).length === 0 ? (
                                        <p className="text-xs text-[#8B7355]">No movements recorded for this asset.</p>
                                      ) : (
                                        <div className="space-y-1">
                                          {(hist.rows || []).map((h) => (
                                            <div key={h.id} className="text-xs text-[#6B5744] flex flex-wrap items-center gap-x-2">
                                              <span className="font-medium capitalize text-[#2D1B0E]">{h.action}</span>
                                              {h.employee_name ? <span>· {h.employee_name}</span> : null}
                                              {h.note ? <span>· {h.note}</span> : null}
                                              <span className="text-[#8B7355]">
                                                · {h.acted_by || 'system'} · {fmtIST(h.at)}
                                              </span>
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                    </td>
                                  </tr>
                                )}
                              </Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )
            )}

            {/* ---- Disciplinary (the most restricted surface: admin-only) ---- */}
            {tab === 'disciplinary' && (
              meLoaded && !isAdmin ? (
                <LockCard name="Disciplinary" />
              ) : discErr ? (
                <TabErrorBanner msg={discErr} onRetry={loadDisciplinary} />
              ) : !meLoaded || discRows === null ? (
                <TabLoadingCard />
              ) : (
                <div className="bg-white border border-[#E8D5C4] rounded-xl shadow">
                  <div className="px-5 py-4 border-b border-[#E8D5C4]">
                    <h2 className="font-bold text-[#2D1B0E] text-sm flex items-center gap-1.5">
                      <ShieldAlert className="w-4 h-4 text-[#af4408]" /> Disciplinary records
                    </h2>
                  </div>
                  {discRows.length === 0 ? (
                    <p className="px-5 py-6 text-sm text-[#8B7355]">No disciplinary records for this employee.</p>
                  ) : (
                    <div className="divide-y divide-[#E8D5C4]/60">
                      {discRows.map((r) => (
                        <div key={r.id} className="px-5 py-4 space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <MetaBadge meta={disciplinaryKindMeta(r.kind)} />
                            <span className="font-bold text-sm text-[#2D1B0E]">{r.subject || 'Untitled record'}</span>
                            <span
                              className={`ml-auto inline-flex items-center px-2 py-0.5 rounded-full border text-xs font-medium ${
                                r.status === 'closed'
                                  ? 'bg-gray-100 text-gray-700 border-gray-200'
                                  : 'bg-amber-100 text-amber-800 border-amber-200'
                              }`}
                            >
                              {r.status === 'closed' ? 'Closed' : 'Open'}
                            </span>
                          </div>
                          {r.detail && <p className="text-sm text-[#6B5744] whitespace-pre-wrap">{r.detail}</p>}
                          {r.employee_response && <DetailBlock label="Employee response" text={r.employee_response} />}
                          {r.manager_comment && <DetailBlock label="Manager comment" text={r.manager_comment} />}
                          {r.final_decision && <DetailBlock label="Final decision" text={r.final_decision} />}
                          <div className="text-[11px] text-[#8B7355]">
                            Raised by {r.created_by || '—'} · {fmtIST(r.created_at)}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
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

        {/* Salary revise modal (admin-only surface; the POST re-checks server-side) */}
        {reviseOpen && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
            <div
              style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
              className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-xl shadow-xl flex flex-col overflow-hidden"
            >
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E]">Revise salary</h2>
                <button onClick={() => setReviseOpen(false)} className="text-[#8B7355]">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-3">
                <p className="text-[11px] text-[#8B7355]">
                  A revision adds a NEW structure from the date below and closes the current one the day
                  before — history is never overwritten. Gross and net are recomputed on the server.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <FieldLabel>Effective from</FieldLabel>
                    <input
                      type="date"
                      className={inputCls}
                      value={revEffFrom}
                      onChange={(e) => { setRevEffFrom(e.target.value); setRevErr(null); }}
                    />
                  </div>
                  <div>
                    <FieldLabel>Basic</FieldLabel>
                    <input
                      type="number"
                      min={0}
                      className={inputCls}
                      value={revBasic}
                      onChange={(e) => setRevBasic(e.target.value)}
                    />
                  </div>
                  <div>
                    <FieldLabel>HRA</FieldLabel>
                    <input
                      type="number"
                      min={0}
                      className={inputCls}
                      value={revHra}
                      onChange={(e) => setRevHra(e.target.value)}
                    />
                  </div>
                </div>
                <MoneyLinesEditor title="Allowances" lines={revAllow} onChange={setRevAllow} />
                <MoneyLinesEditor title="Deductions" lines={revDed} onChange={setRevDed} />
                <div>
                  <FieldLabel>Note</FieldLabel>
                  <textarea
                    rows={2}
                    className={inputCls}
                    value={revNote}
                    onChange={(e) => setRevNote(e.target.value)}
                    placeholder="Why is the salary changing? (e.g. annual revision)"
                  />
                </div>
                <div className="rounded-lg bg-[#FFF1E3] border border-[#E8D5C4] px-3 py-2 text-sm flex flex-wrap gap-x-6 gap-y-1">
                  <span>Gross: <span className="font-bold">{inr(revGross)}</span></span>
                  <span>Net: <span className="font-bold">{inr(revNet)}</span></span>
                </div>
                {revErr && (
                  <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                    {revErr}
                  </div>
                )}
              </div>
              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
                <button onClick={() => setReviseOpen(false)} className="px-3 py-2 text-sm text-[#6B5744]">
                  Cancel
                </button>
                <button
                  onClick={submitRevise}
                  disabled={revSaving || !revEffFrom}
                  className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50"
                >
                  {revSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  Save revision
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Bank add/edit modal (admin-only actions; PUT/POST re-check) */}
        {bankModal && bankDraft && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
            <div
              style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
              className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-lg shadow-xl flex flex-col overflow-hidden"
            >
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E]">
                  {bankModal.mode === 'add' ? 'Add bank account' : 'Edit bank account'}
                </h2>
                <button onClick={() => setBankModal(null)} className="text-[#8B7355]">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <FieldLabel>Bank name</FieldLabel>
                    <input
                      className={inputCls}
                      value={bankDraft.bank_name}
                      onChange={(e) => setBankDraft({ ...bankDraft, bank_name: e.target.value })}
                    />
                  </div>
                  <div>
                    <FieldLabel>Account holder</FieldLabel>
                    <input
                      className={inputCls}
                      value={bankDraft.account_holder}
                      onChange={(e) => setBankDraft({ ...bankDraft, account_holder: e.target.value })}
                    />
                  </div>
                  <div>
                    <FieldLabel>Account number</FieldLabel>
                    <input
                      className={`${inputCls} font-mono`}
                      value={bankDraft.account_number}
                      onChange={(e) => { setBankDraft({ ...bankDraft, account_number: e.target.value }); setBankModalErr(null); }}
                    />
                  </div>
                  <div>
                    <FieldLabel>IFSC</FieldLabel>
                    <input
                      className={`${inputCls} font-mono uppercase`}
                      value={bankDraft.ifsc}
                      placeholder="HDFC0001234"
                      onChange={(e) => { setBankDraft({ ...bankDraft, ifsc: e.target.value }); setBankModalErr(null); }}
                    />
                  </div>
                  <div>
                    <FieldLabel>Branch</FieldLabel>
                    <input
                      className={inputCls}
                      value={bankDraft.branch}
                      onChange={(e) => setBankDraft({ ...bankDraft, branch: e.target.value })}
                    />
                  </div>
                  <div>
                    <FieldLabel>Account type</FieldLabel>
                    <select
                      className={inputCls}
                      value={bankDraft.account_type}
                      onChange={(e) => setBankDraft({ ...bankDraft, account_type: e.target.value })}
                    >
                      {!['savings', 'current', 'salary'].includes(bankDraft.account_type) && (
                        <option value={bankDraft.account_type}>{bankDraft.account_type || 'Not set'}</option>
                      )}
                      <option value="savings">Savings</option>
                      <option value="current">Current</option>
                      <option value="salary">Salary</option>
                    </select>
                  </div>
                </div>
                {bankModal.mode === 'edit' && (
                  <>
                    <div className="flex items-center gap-2">
                      <Toggle
                        checked={bankDraft.is_active}
                        onChange={(v) => setBankDraft({ ...bankDraft, is_active: v })}
                        label="Active"
                        size="sm"
                      />
                      <span className="text-sm text-[#6B5744]">Active</span>
                    </div>
                    <p className="text-[11px] text-[#8B7355]">
                      Changing the account number or IFSC resets verification back to unverified.
                    </p>
                  </>
                )}
                {bankModalErr && (
                  <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                    {bankModalErr}
                  </div>
                )}
              </div>
              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
                <button onClick={() => setBankModal(null)} className="px-3 py-2 text-sm text-[#6B5744]">
                  Cancel
                </button>
                <button
                  onClick={submitBank}
                  disabled={bankSaving || !bankDraft.account_number.trim() || !bankDraft.ifsc.trim()}
                  className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50"
                >
                  {bankSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  {bankModal.mode === 'add' ? 'Add account' : 'Save changes'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Document upload modal (admin-only surface; the POST re-checks) */}
        {docModal && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
            <div
              style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
              className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-lg shadow-xl flex flex-col overflow-hidden"
            >
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E]">Upload document</h2>
                <button onClick={() => setDocModal(false)} className="text-[#8B7355]">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-3">
                <div>
                  <FieldLabel>File (PDF / JPG / PNG / WEBP, 5MB max)</FieldLabel>
                  <input
                    ref={docFileRef}
                    type="file"
                    accept="application/pdf,image/jpeg,image/png,image/webp,.pdf,.jpg,.jpeg,.png,.webp"
                    className="sr-only"
                    aria-label="Pick a document file"
                    onChange={(e) => {
                      setDocFile(e.target.files?.[0] || null);
                      setDocModalErr(null);
                      e.currentTarget.value = '';
                    }}
                  />
                  <button
                    onClick={() => docFileRef.current?.click()}
                    className="mt-1 w-full px-3 py-3 border border-dashed border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm text-[#6B5744] hover:border-[#af4408] text-left"
                  >
                    {docFile ? (
                      <span className="flex items-center gap-2 min-w-0">
                        <FileText className="w-4 h-4 shrink-0 text-[#af4408]" />
                        <span className="truncate">{docFile.name}</span>
                        <span className="text-[#8B7355] shrink-0">({fmtBytes(docFile.size)})</span>
                      </span>
                    ) : (
                      <span className="flex items-center gap-2">
                        <Upload className="w-4 h-4" /> Pick a file…
                      </span>
                    )}
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <FieldLabel>Type</FieldLabel>
                    <select className={inputCls} value={docType} onChange={(e) => setDocType(e.target.value)}>
                      <option value="">— Type —</option>
                      {HR_DOC_TYPES.map((t) => (
                        <option key={t.key} value={t.key}>{t.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <FieldLabel>Document number</FieldLabel>
                    <input className={inputCls} value={docNumber} onChange={(e) => setDocNumber(e.target.value)} />
                  </div>
                  <div>
                    <FieldLabel>Issue date</FieldLabel>
                    <input type="date" className={inputCls} value={docIssue} onChange={(e) => setDocIssue(e.target.value)} />
                  </div>
                  <div>
                    <FieldLabel>Expiry date</FieldLabel>
                    <input type="date" className={inputCls} value={docExpiry} onChange={(e) => setDocExpiry(e.target.value)} />
                  </div>
                </div>
                {docModalErr && (
                  <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                    {docModalErr}
                  </div>
                )}
              </div>
              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
                <button onClick={() => setDocModal(false)} className="px-3 py-2 text-sm text-[#6B5744]">
                  Cancel
                </button>
                <button
                  onClick={submitDoc}
                  disabled={docSaving || !docFile}
                  className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50"
                >
                  {docSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                  Upload
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

/** Plain admin-only lock message (the house 403 copy for adminOnly surfaces).
 *  Hiding is UX only — every backing API re-checks canAdminHr server-side. */
function LockCard({ name }: { name: string }) {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-6 flex items-center gap-2 text-sm text-[#8B7355]">
      <Lock className="w-4 h-4 shrink-0" /> {name} is admin-only.
    </div>
  );
}

function TabLoadingCard() {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-6 flex items-center gap-2 text-[#8B7355] text-sm">
      <Loader2 className="w-4 h-4 animate-spin" /> Loading...
    </div>
  );
}

function TabErrorBanner({ msg, onRetry }: { msg: string; onRetry: () => void }) {
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 flex flex-wrap items-center justify-between gap-3">
      <span>{msg}</span>
      <button
        onClick={onRetry}
        className="px-3 py-1.5 rounded-lg border border-red-300 bg-white hover:bg-red-100 text-red-700 text-sm font-medium"
      >
        Retry
      </button>
    </div>
  );
}

/** unverified | verified | rejected badge (bank accounts + documents). */
function VerifyBadge({ status }: { status: string }) {
  const cls =
    status === 'verified'
      ? 'bg-green-100 text-green-700 border-green-200'
      : status === 'rejected'
        ? 'bg-rose-100 text-rose-700 border-rose-200'
        : 'bg-amber-100 text-amber-800 border-amber-200';
  const label = status === 'verified' ? 'Verified' : status === 'rejected' ? 'Rejected' : 'Unverified';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
}

/** Render any hr.ts vocabulary meta ({label, color}) as the house pill. */
function MetaBadge({ meta }: { meta: { label: string; color: string } }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-xs font-medium whitespace-nowrap ${meta.color}`}>
      {meta.label}
    </span>
  );
}

function StatCard({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-4">
      <div className="text-xs text-[#8B7355]">{label}</div>
      <div className={`text-lg font-bold mt-0.5 ${highlight ? 'text-[#af4408]' : 'text-[#2D1B0E]'}`}>{value}</div>
    </div>
  );
}

/** Labelled paragraph in a disciplinary record card. */
function DetailBlock({ label, text }: { label: string; text: string }) {
  return (
    <div className="text-sm">
      <span className="text-xs font-medium text-[#8B7355]">{label}: </span>
      <span className="text-[#2D1B0E] whitespace-pre-wrap">{text}</span>
    </div>
  );
}

/** Editable {label, amount} lines for the salary Revise modal. */
function MoneyLinesEditor({
  title,
  lines,
  onChange,
}: {
  title: string;
  lines: MoneyLine[];
  onChange: (next: MoneyLine[]) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <FieldLabel>{title}</FieldLabel>
        <button
          type="button"
          onClick={() => onChange([...lines, { label: '', amount: '' }])}
          className="text-xs font-medium text-[#af4408] hover:underline inline-flex items-center gap-0.5"
        >
          <Plus className="w-3 h-3" /> Add line
        </button>
      </div>
      {lines.length === 0 ? (
        <p className="text-xs text-[#8B7355] mt-1">None.</p>
      ) : (
        <div className="mt-1 space-y-1.5">
          {lines.map((l, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                className={inputCls}
                placeholder="Label (e.g. Conveyance)"
                value={l.label}
                onChange={(e) => onChange(lines.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
              />
              <input
                type="number"
                min={0}
                className={`${inputCls} w-32 shrink-0 text-right`}
                placeholder="0"
                value={l.amount}
                onChange={(e) => onChange(lines.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
              />
              <button
                type="button"
                onClick={() => onChange(lines.filter((_, j) => j !== i))}
                className="text-[#8B7355] hover:text-red-600 shrink-0"
                title="Remove line"
                aria-label="Remove line"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
