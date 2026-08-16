/**
 * HRMS — shared contract module (Phase 1).
 *
 * THE single source of truth every HR slice imports: employment-type /
 * employee-status vocabularies, badge color classes, permission gates, and the
 * row-shaped TS interfaces mirroring the hr_* tables in src/lib/db.ts.
 * Contract: docs/HRMS_DECISIONS.md (§2.6 places the predicates here).
 * The /api/hr routes gate through these predicates (canManageHr / canAdminHr).
 *
 * Pure module — no runtime DB import, no server-only import. It imports ONLY a
 * *type* from ./auth (erased at compile time), so it is safe on both server
 * and client. Server-side helpers that need the DB live in ./hr-server.ts.
 */

import type { SessionUser } from './auth';

/* ------------------------------------------------------------------ *
 * Employment type
 * ------------------------------------------------------------------ */

/** All values the hr_employees.employment_type column accepts. */
export type HrEmploymentType =
  | 'permanent'
  | 'contract'
  | 'temporary'
  | 'part_time'
  | 'intern'
  | 'consultant';

export interface HrEmploymentTypeMeta {
  key: HrEmploymentType;
  label: string;
  /** Tailwind badge classes (bg + text + border), safe to drop on a <span>. */
  color: string;
}

/** Ordered employment-type vocabulary with badge colors. */
export const HR_EMPLOYMENT_TYPES: readonly HrEmploymentTypeMeta[] = [
  { key: 'permanent', label: 'Permanent', color: 'bg-blue-100 text-blue-700 border-blue-200' },
  { key: 'contract', label: 'Contract', color: 'bg-purple-100 text-purple-700 border-purple-200' },
  { key: 'temporary', label: 'Temporary', color: 'bg-amber-100 text-amber-800 border-amber-200' },
  { key: 'part_time', label: 'Part Time', color: 'bg-indigo-100 text-indigo-700 border-indigo-200' },
  { key: 'intern', label: 'Intern', color: 'bg-teal-100 text-teal-700 border-teal-200' },
  { key: 'consultant', label: 'Consultant', color: 'bg-slate-100 text-slate-600 border-slate-200' },
] as const;

const EMPLOYMENT_TYPE_FALLBACK: HrEmploymentTypeMeta = {
  key: 'permanent',
  label: 'Permanent',
  color: 'bg-blue-100 text-blue-700 border-blue-200',
};

/** Metadata for an employment-type key; safe fallback styling for unknown keys. */
export function employmentTypeMeta(key: string | null | undefined): HrEmploymentTypeMeta {
  return (
    HR_EMPLOYMENT_TYPES.find((t) => t.key === key) ?? {
      ...EMPLOYMENT_TYPE_FALLBACK,
      key: (key as HrEmploymentType) || 'permanent',
      label: labelize(key) || 'Permanent',
    }
  );
}

/** True when the key is a valid hr_employees.employment_type value. */
export function isHrEmploymentType(key: string | null | undefined): key is HrEmploymentType {
  return HR_EMPLOYMENT_TYPES.some((t) => t.key === key);
}

/* ------------------------------------------------------------------ *
 * Employee status
 * ------------------------------------------------------------------ */

/**
 * All values the hr_employees.status column accepts, ordered as the natural
 * lifecycle progression with the exit states last. HR status is descriptive
 * ONLY — it never touches users.is_active (contract D1: deactivating a login
 * is an explicit admin action on /users, never an HR side effect).
 */
export type HrEmployeeStatus =
  | 'active'
  | 'probation'
  | 'confirmed'
  | 'notice_period'
  | 'suspended'
  | 'resigned'
  | 'terminated'
  | 'former';

export interface HrEmployeeStatusMeta {
  key: HrEmployeeStatus;
  label: string;
  /** Tailwind badge classes (bg + text + border), safe to drop on a <span>. */
  color: string;
}

/** Ordered status vocabulary with badge colors. */
export const HR_EMPLOYEE_STATUSES: readonly HrEmployeeStatusMeta[] = [
  { key: 'active', label: 'Active', color: 'bg-green-100 text-green-700 border-green-200' },
  { key: 'probation', label: 'Probation', color: 'bg-amber-100 text-amber-800 border-amber-200' },
  { key: 'confirmed', label: 'Confirmed', color: 'bg-teal-100 text-teal-700 border-teal-200' },
  { key: 'notice_period', label: 'Notice Period', color: 'bg-orange-100 text-orange-700 border-orange-200' },
  { key: 'suspended', label: 'Suspended', color: 'bg-yellow-100 text-yellow-800 border-yellow-200' },
  { key: 'resigned', label: 'Resigned', color: 'bg-slate-100 text-slate-600 border-slate-200' },
  { key: 'terminated', label: 'Terminated', color: 'bg-rose-100 text-rose-700 border-rose-200' },
  { key: 'former', label: 'Former', color: 'bg-gray-100 text-gray-700 border-gray-200' },
] as const;

const EMPLOYEE_STATUS_FALLBACK: HrEmployeeStatusMeta = {
  key: 'active',
  label: 'Active',
  color: 'bg-green-100 text-green-700 border-green-200',
};

/** Metadata for a status key; safe fallback styling for unknown keys. */
export function employeeStatusMeta(key: string | null | undefined): HrEmployeeStatusMeta {
  return (
    HR_EMPLOYEE_STATUSES.find((s) => s.key === key) ?? {
      ...EMPLOYEE_STATUS_FALLBACK,
      key: (key as HrEmployeeStatus) || 'active',
      label: labelize(key) || 'Active',
    }
  );
}

/** True when the key is a valid hr_employees.status value. */
export function isHrEmployeeStatus(key: string | null | undefined): key is HrEmployeeStatus {
  return HR_EMPLOYEE_STATUSES.some((s) => s.key === key);
}

/* ------------------------------------------------------------------ *
 * Permissions (docs/HRMS_DECISIONS.md §2.6)
 * ------------------------------------------------------------------ */

/** Subset of SessionUser the HR gates read; accepts a full SessionUser too. */
type HrActor = Pick<SessionUser, 'role' | 'is_head_chef'>;

/**
 * May view / manage the employee master and designations reads: admin tier,
 * any manager tier, or a Head of Department. Mirrors isManagement() in
 * src/lib/auth.ts exactly (which cannot be imported here — auth.ts pulls in
 * the DB). NOTE: deliberately NOT is_store_manager — that flag grants store
 * powers, not people powers.
 */
export function canManageHr(me: HrActor | null | undefined): boolean {
  if (!me) return false;
  return me.role === 'admin' || me.role === 'manager' || !!me.is_head_chef;
}

/**
 * Admin-only HR actions: designation mutations, and (in later phases) salary,
 * bank, documents, payroll.
 */
export function canAdminHr(me: HrActor | null | undefined): boolean {
  if (!me) return false;
  return me.role === 'admin';
}

/* ------------------------------------------------------------------ *
 * Row-shaped interfaces (mirror the hr_* tables in db.ts — Phase 1 block
 * at the end of initializeSchema)
 * ------------------------------------------------------------------ */

/** One row of hr_employees. Every TEXT column is NOT NULL DEFAULT '' except
 *  user_id (the only nullable column — and the only declared FK, to users.id). */
export interface HrEmployee {
  id: string;
  /** HR-issued, human-facing, unique (EMP-0001 — minted by hr-server.ts nextEmployeeCode). */
  employee_code: string;
  full_name: string;
  /** base64 data URI (~250KB, ImageUpload-compressed), '' = none. */
  photo: string;
  /** YYYY-MM-DD or ''. */
  dob: string;
  gender: string;
  /** PhoneField contract: +91 = bare 10 digits. */
  phone10: string;
  alt_phone10: string;
  /** Contact only; NOT an identity — the login identity is users.email via user_id. */
  email: string;
  current_address: string;
  permanent_address: string;
  emergency_name: string;
  emergency_relation: string;
  emergency_phone10: string;
  /** departments.id (the real 3-main/16-sub tree — NOT task_departments). */
  department_id: string;
  /** departments.id (a child row of department_id). */
  sub_department_id: string;
  /** hr_designations.id. */
  designation_id: string;
  grade: string;
  /** hr_employees.id of the reporting manager. */
  reporting_manager_id: string;
  employment_type: HrEmploymentType | string;
  employee_category: string;
  cost_centre: string;
  work_location: string;
  /** Employment assignment; users.current_outlet_id is a VIEW preference, never this. */
  home_outlet_id: string;
  /** YYYY-MM-DD or ''. */
  joining_date: string;
  probation_months: number;
  /** YYYY-MM-DD or ''. */
  confirmation_date: string;
  notice_period_days: number;
  status: HrEmployeeStatus | string;
  /** YYYY-MM-DD or ''. */
  exit_date: string;
  /** users.id or null. Partial UNIQUE index: one employee per login. */
  user_id: string | null;
  notes: string;
  /** me.email of the creator (house actor convention). */
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** One row of hr_designations (soft delete via is_active — rows are never removed). */
export interface HrDesignation {
  id: string;
  name: string;
  /** departments.id — a hint for pickers, not a constraint. */
  department_id: string;
  grade: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

/** One row of hr_employee_outlets (multi-outlet assignment join table). */
export interface HrEmployeeOutlet {
  id: string;
  employee_id: string;
  outlet_id: string;
  created_at: string;
}

/** A list-API row: hr_employees LEFT JOINed to its display names.
 *  Matches GET /api/hr/employees rows exactly. */
export interface HrEmployeeListRow extends HrEmployee {
  /** departments.name for department_id, or null when unset/dangling. */
  department_name: string | null;
  /** departments.name for sub_department_id, or null. */
  sub_department_name: string | null;
  /** hr_designations.name for designation_id, or null. */
  designation_name: string | null;
  /** users.email for user_id, or null when no login is linked. */
  linked_user_email: string | null;
}

/* ------------------------------------------------------------------ *
 * Internal helpers
 * ------------------------------------------------------------------ */

/** Humanize a snake_case key into Title Case ("notice_period" -> "Notice Period"). */
function labelize(key: string | null | undefined): string {
  if (!key) return '';
  return String(key)
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
