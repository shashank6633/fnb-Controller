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
 * Attendance (Phase 2) — vocabularies
 * Contract: docs/HRMS_DECISIONS.md §8.2/§8.5; schema = the Phase 2 block at
 * the end of the hr section of initializeSchema (src/lib/db.ts).
 * ------------------------------------------------------------------ */

/** All values hr_attendance_events.source accepts. */
export type HrEventSource = 'gps' | 'biometric' | 'manual' | 'import';

export interface HrEventSourceMeta {
  key: HrEventSource;
  label: string;
  /** Tailwind badge classes (bg + text + border), safe to drop on a <span>. */
  color: string;
}

/** Ordered punch-source vocabulary with badge colors. */
export const HR_EVENT_SOURCES: readonly HrEventSourceMeta[] = [
  { key: 'gps', label: 'GPS', color: 'bg-sky-100 text-sky-700 border-sky-200' },
  { key: 'biometric', label: 'Biometric', color: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  { key: 'manual', label: 'Manual', color: 'bg-amber-100 text-amber-800 border-amber-200' },
  { key: 'import', label: 'Import', color: 'bg-indigo-100 text-indigo-700 border-indigo-200' },
] as const;

/** True when the key is a valid hr_attendance_events.source value. */
export function isHrEventSource(key: string | null | undefined): key is HrEventSource {
  return HR_EVENT_SOURCES.some((s) => s.key === key);
}

/** Metadata for a punch-source key; safe fallback styling for unknown keys. */
export function eventSourceMeta(key: string | null | undefined): HrEventSourceMeta {
  return (
    HR_EVENT_SOURCES.find((s) => s.key === key) ?? {
      key: (key as HrEventSource) || 'manual',
      label: labelize(key) || 'Manual',
      color: 'bg-slate-100 text-slate-600 border-slate-200',
    }
  );
}

/** All values hr_attendance_events.event_type accepts. Only check_in /
 *  check_out are ever INFERRED (single-gate alternation, §8.2.3); every
 *  other type must be written explicitly. */
export type HrAttendanceEventType =
  | 'check_in'
  | 'check_out'
  | 'break_start'
  | 'break_end'
  | 'outside_detected'
  | 'outside_confirmed'
  | 'returned';

/** The event-type vocabulary in one place (the engine validates against it). */
export const HR_ATTENDANCE_EVENT_TYPES: readonly HrAttendanceEventType[] = [
  'check_in',
  'check_out',
  'break_start',
  'break_end',
  'outside_detected',
  'outside_confirmed',
  'returned',
] as const;

/** All values hr_attendance.status accepts (mirrors the db.ts column comment).
 *  Phase 2 computes NOT_CHECKED_IN / PRESENT / CHECKED_OUT / MISSING_CHECKOUT;
 *  the rest are reserved for shifts/leave (Phase 3+) and render safely now. */
export type HrAttendanceStatus =
  | 'NOT_CHECKED_IN'
  | 'PRESENT'
  | 'LATE'
  | 'ON_BREAK'
  | 'OUTSIDE_GEOFENCE'
  | 'EARLY_CHECKOUT'
  | 'CHECKED_OUT'
  | 'ABSENT'
  | 'ON_LEAVE'
  | 'HALF_DAY'
  | 'OVERTIME'
  | 'MISSING_CHECKOUT';

export interface HrAttendanceStatusMeta {
  key: HrAttendanceStatus;
  label: string;
  /** Tailwind badge classes (bg + text + border), safe to drop on a <span>. */
  color: string;
}

/** Ordered day-status vocabulary with badge colors. */
export const HR_ATTENDANCE_STATUSES: readonly HrAttendanceStatusMeta[] = [
  { key: 'NOT_CHECKED_IN', label: 'Not Checked In', color: 'bg-gray-100 text-gray-600 border-gray-200' },
  { key: 'PRESENT', label: 'Present', color: 'bg-green-100 text-green-700 border-green-200' },
  { key: 'LATE', label: 'Late', color: 'bg-amber-100 text-amber-800 border-amber-200' },
  { key: 'ON_BREAK', label: 'On Break', color: 'bg-indigo-100 text-indigo-700 border-indigo-200' },
  { key: 'OUTSIDE_GEOFENCE', label: 'Outside Geofence', color: 'bg-orange-100 text-orange-700 border-orange-200' },
  { key: 'EARLY_CHECKOUT', label: 'Early Checkout', color: 'bg-yellow-100 text-yellow-800 border-yellow-200' },
  { key: 'CHECKED_OUT', label: 'Checked Out', color: 'bg-blue-100 text-blue-700 border-blue-200' },
  { key: 'ABSENT', label: 'Absent', color: 'bg-rose-100 text-rose-700 border-rose-200' },
  { key: 'ON_LEAVE', label: 'On Leave', color: 'bg-purple-100 text-purple-700 border-purple-200' },
  { key: 'HALF_DAY', label: 'Half Day', color: 'bg-teal-100 text-teal-700 border-teal-200' },
  { key: 'OVERTIME', label: 'Overtime', color: 'bg-cyan-100 text-cyan-700 border-cyan-200' },
  { key: 'MISSING_CHECKOUT', label: 'Missing Checkout', color: 'bg-red-100 text-red-700 border-red-200' },
] as const;

const ATTENDANCE_STATUS_FALLBACK: HrAttendanceStatusMeta = {
  key: 'NOT_CHECKED_IN',
  label: 'Not Checked In',
  color: 'bg-gray-100 text-gray-600 border-gray-200',
};

/** Metadata for a day-status key; safe fallback styling for unknown keys. */
export function attendanceStatusMeta(key: string | null | undefined): HrAttendanceStatusMeta {
  return (
    HR_ATTENDANCE_STATUSES.find((s) => s.key === key) ?? {
      ...ATTENDANCE_STATUS_FALLBACK,
      key: (key as HrAttendanceStatus) || 'NOT_CHECKED_IN',
      label: labelize(key) || 'Not Checked In',
    }
  );
}

/** True when the key is a valid hr_attendance.status value. */
export function isHrAttendanceStatus(key: string | null | undefined): key is HrAttendanceStatus {
  return HR_ATTENDANCE_STATUSES.some((s) => s.key === key);
}

/* ------------------------------------------------------------------ *
 * Attendance (Phase 2) — row-shaped interfaces (mirror the Phase 2 hr_*
 * tables in db.ts exactly; REAL-nullable columns are number | null)
 * ------------------------------------------------------------------ */

/** One row of hr_geofences (soft delete via is_active). */
export interface HrGeofence {
  id: string;
  outlet_id: string;
  name: string;
  lat: number;
  lng: number;
  /** Fence radius in metres — configurable data, never hard-coded. */
  radius_m: number;
  /** GPS fixes less accurate than this evaluate to 'unknown' (hr-geo.ts). */
  accuracy_threshold_m: number;
  grace_seconds: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

/** One row of hr_attendance_events — the APPEND-ONLY punch timeline.
 *  Rows are never updated or deleted; debounced duplicates stay with
 *  ignored=1. `at` is UTC ('YYYY-MM-DD HH:MM:SS'), render via fmtIST. */
export interface HrAttendanceEvent {
  id: string;
  employee_id: string;
  outlet_id: string;
  event_type: HrAttendanceEventType | string;
  source: HrEventSource | string;
  /** UTC punch instant. */
  at: string;
  /** IST business day (after hr_day_cutoff) — stamped AT WRITE TIME. */
  business_date: string;
  lat: number | null;
  lng: number | null;
  accuracy_m: number | null;
  geofence_id: string;
  /** inside|outside|unknown or ''. */
  geofence_status: string;
  reason: string;
  device_info: string;
  /** 1 = debounce duplicate — excluded from pairing and summaries. */
  ignored: number;
  ignored_reason: string;
  /** me.email; '' for machine sources. */
  created_by: string;
  created_at: string;
}

/** One row of hr_attendance — the COMPUTED summary, one per employee per
 *  business day (UNIQUE(employee_id, date)). Rebuilt by recomputeDay(); the
 *  events are the truth, this is the register. */
export interface HrAttendanceSummary {
  id: string;
  employee_id: string;
  outlet_id: string;
  /** IST business date (YYYY-MM-DD), the register key. */
  date: string;
  status: HrAttendanceStatus | string;
  /** UTC datetimes; '' = none. */
  first_in: string;
  last_out: string;
  /** IN/OUT pairs; 2 on a split-shift day. */
  sessions: number;
  worked_minutes: number;
  /** Gaps BETWEEN sessions (the split-shift afternoon). */
  break_minutes: number;
  outside_minutes: number;
  overtime_minutes: number;
  /** Phase 3 fills this. */
  shift_id: string;
  /** 1 = odd punch count at day close; a checkout time is NEVER invented. */
  missing_checkout: number;
  /** 1 = an approved correction touched this day. */
  corrected: number;
  computed_at: string;
}

/** One row of hr_attendance_corrections (variance_approvals pattern: frozen
 *  original + requested + approved JSON; a partial UNIQUE allows one PENDING
 *  request per employee-day; approval APPENDS manual events, never edits). */
export interface HrAttendanceCorrection {
  id: string;
  employee_id: string;
  /** IST business date being corrected. */
  date: string;
  original_json: string;
  /** JSON: { events: [{ event_type, at (UTC), reason? }] } — see
   *  CorrectionRequestedJson in hr-attendance.ts. */
  requested_json: string;
  reason: string;
  requested_by: string;
  status: 'pending' | 'approved' | 'rejected' | string;
  reviewed_by: string;
  reviewed_at: string;
  review_reason: string;
  approved_json: string;
  created_at: string;
}

/** One row of hr_biometric_map — employee ↔ device identity (soft delete via
 *  is_active; UNIQUE(biometric_employee_id, device_id)). Whatever the final
 *  vendor connector is, it resolves punches through this table and calls the
 *  SAME recordAttendanceEvent() chokepoint. */
export interface HrBiometricMap {
  id: string;
  employee_id: string;
  /** The id the DEVICE knows the person by. */
  biometric_employee_id: string;
  device_id: string;
  outlet_id: string;
  is_active: number;
  created_at: string;
  updated_at: string;
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

/* ================================================================== *
 * Phases 3-7 — vocabularies + row interfaces (appended per contract
 * docs/HRMS_DECISIONS.md §5/§6; schema = the Phases 3-7 block inside
 * the hr section of initializeSchema in src/lib/db.ts).
 *
 * Backend-mapping rules every consumer of these types must honour:
 *  · employee_id is ALWAYS hr_employees.id — never users.id, never an
 *    email. Actor columns (*_by) are ALWAYS me.email.
 *  · Reads LEFT JOIN hr_employees for names; a dangling id degrades to
 *    blank, never to a dropped row.
 *  · Money history is append-only + effective-dated (salary structures,
 *    statutory configs); ledgers append (advance installments, payroll
 *    items, asset history). State lives in the status columns below.
 * ================================================================== */

/* ------------------------------------------------------------------ *
 * Shifts, roster & leave (Phase 3) — vocabularies
 * ------------------------------------------------------------------ */

/** All values hr_leave_requests.status accepts. */
export type HrLeaveStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface HrLeaveStatusMeta {
  key: HrLeaveStatus;
  label: string;
  /** Tailwind badge classes (bg + text + border), safe to drop on a <span>. */
  color: string;
}

/** Ordered leave-request status vocabulary with badge colors. */
export const HR_LEAVE_STATUSES: readonly HrLeaveStatusMeta[] = [
  { key: 'pending', label: 'Pending', color: 'bg-amber-100 text-amber-800 border-amber-200' },
  { key: 'approved', label: 'Approved', color: 'bg-green-100 text-green-700 border-green-200' },
  { key: 'rejected', label: 'Rejected', color: 'bg-rose-100 text-rose-700 border-rose-200' },
  { key: 'cancelled', label: 'Cancelled', color: 'bg-slate-100 text-slate-600 border-slate-200' },
] as const;

/** Metadata for a leave-request status key; safe fallback styling for unknown keys. */
export function leaveStatusMeta(key: string | null | undefined): HrLeaveStatusMeta {
  return (
    HR_LEAVE_STATUSES.find((s) => s.key === key) ?? {
      key: (key as HrLeaveStatus) || 'pending',
      label: labelize(key) || 'Pending',
      color: 'bg-slate-100 text-slate-600 border-slate-200',
    }
  );
}

/** True when the key is a valid hr_leave_requests.status value. */
export function isHrLeaveStatus(key: string | null | undefined): key is HrLeaveStatus {
  return HR_LEAVE_STATUSES.some((s) => s.key === key);
}

/** All values hr_shift_requests.status accepts (leave vocab minus 'cancelled'). */
export type HrShiftRequestStatus = 'pending' | 'approved' | 'rejected';

export interface HrShiftRequestStatusMeta {
  key: HrShiftRequestStatus;
  label: string;
  /** Tailwind badge classes (bg + text + border), safe to drop on a <span>. */
  color: string;
}

/** Ordered shift-request status vocabulary with badge colors. */
export const HR_SHIFT_REQUEST_STATUSES: readonly HrShiftRequestStatusMeta[] = [
  { key: 'pending', label: 'Pending', color: 'bg-amber-100 text-amber-800 border-amber-200' },
  { key: 'approved', label: 'Approved', color: 'bg-green-100 text-green-700 border-green-200' },
  { key: 'rejected', label: 'Rejected', color: 'bg-rose-100 text-rose-700 border-rose-200' },
] as const;

/** Metadata for a shift-request status key; safe fallback styling for unknown keys. */
export function shiftRequestStatusMeta(key: string | null | undefined): HrShiftRequestStatusMeta {
  return (
    HR_SHIFT_REQUEST_STATUSES.find((s) => s.key === key) ?? {
      key: (key as HrShiftRequestStatus) || 'pending',
      label: labelize(key) || 'Pending',
      color: 'bg-slate-100 text-slate-600 border-slate-200',
    }
  );
}

/** True when the key is a valid hr_shift_requests.status value. */
export function isHrShiftRequestStatus(key: string | null | undefined): key is HrShiftRequestStatus {
  return HR_SHIFT_REQUEST_STATUSES.some((s) => s.key === key);
}

/* ------------------------------------------------------------------ *
 * Pay: advances & payroll (Phase 4) — vocabularies
 * ------------------------------------------------------------------ */

/** All values hr_advances.status accepts — the advance lifecycle. */
export type HrAdvanceStatus = 'pending' | 'approved' | 'rejected' | 'disbursed' | 'closed';

export interface HrAdvanceStatusMeta {
  key: HrAdvanceStatus;
  label: string;
  /** Tailwind badge classes (bg + text + border), safe to drop on a <span>. */
  color: string;
}

/** Ordered advance status vocabulary with badge colors. */
export const HR_ADVANCE_STATUSES: readonly HrAdvanceStatusMeta[] = [
  { key: 'pending', label: 'Pending', color: 'bg-amber-100 text-amber-800 border-amber-200' },
  { key: 'approved', label: 'Approved', color: 'bg-green-100 text-green-700 border-green-200' },
  { key: 'rejected', label: 'Rejected', color: 'bg-rose-100 text-rose-700 border-rose-200' },
  { key: 'disbursed', label: 'Disbursed', color: 'bg-blue-100 text-blue-700 border-blue-200' },
  { key: 'closed', label: 'Closed', color: 'bg-gray-100 text-gray-700 border-gray-200' },
] as const;

/** Metadata for an advance status key; safe fallback styling for unknown keys. */
export function advanceStatusMeta(key: string | null | undefined): HrAdvanceStatusMeta {
  return (
    HR_ADVANCE_STATUSES.find((s) => s.key === key) ?? {
      key: (key as HrAdvanceStatus) || 'pending',
      label: labelize(key) || 'Pending',
      color: 'bg-slate-100 text-slate-600 border-slate-200',
    }
  );
}

/** True when the key is a valid hr_advances.status value. */
export function isHrAdvanceStatus(key: string | null | undefined): key is HrAdvanceStatus {
  return HR_ADVANCE_STATUSES.some((s) => s.key === key);
}

/** All values hr_payroll_runs.status accepts. A finalized run is IMMUTABLE. */
export type HrPayrollRunStatus = 'draft' | 'finalized';

export interface HrPayrollRunStatusMeta {
  key: HrPayrollRunStatus;
  label: string;
  /** Tailwind badge classes (bg + text + border), safe to drop on a <span>. */
  color: string;
}

/** Ordered payroll-run status vocabulary with badge colors. */
export const HR_PAYROLL_RUN_STATUSES: readonly HrPayrollRunStatusMeta[] = [
  { key: 'draft', label: 'Draft', color: 'bg-amber-100 text-amber-800 border-amber-200' },
  { key: 'finalized', label: 'Finalized', color: 'bg-green-100 text-green-700 border-green-200' },
] as const;

/** Metadata for a payroll-run status key; safe fallback styling for unknown keys. */
export function payrollRunStatusMeta(key: string | null | undefined): HrPayrollRunStatusMeta {
  return (
    HR_PAYROLL_RUN_STATUSES.find((s) => s.key === key) ?? {
      key: (key as HrPayrollRunStatus) || 'draft',
      label: labelize(key) || 'Draft',
      color: 'bg-slate-100 text-slate-600 border-slate-200',
    }
  );
}

/** True when the key is a valid hr_payroll_runs.status value. */
export function isHrPayrollRunStatus(key: string | null | undefined): key is HrPayrollRunStatus {
  return HR_PAYROLL_RUN_STATUSES.some((s) => s.key === key);
}

/* ------------------------------------------------------------------ *
 * Documents (Phase 4) — doc-type vocabulary
 * ------------------------------------------------------------------ */

/** All values hr_documents.doc_type accepts. */
export type HrDocType =
  | 'aadhaar'
  | 'pan'
  | 'address_proof'
  | 'passport'
  | 'driving_licence'
  | 'education'
  | 'experience'
  | 'offer_letter'
  | 'appointment_letter'
  | 'bank_proof'
  | 'other';

export interface HrDocTypeMeta {
  key: HrDocType;
  label: string;
  /** Tailwind badge classes (bg + text + border), safe to drop on a <span>. */
  color: string;
}

/** Ordered document-type vocabulary with badge colors. */
export const HR_DOC_TYPES: readonly HrDocTypeMeta[] = [
  { key: 'aadhaar', label: 'Aadhaar', color: 'bg-blue-100 text-blue-700 border-blue-200' },
  { key: 'pan', label: 'PAN', color: 'bg-purple-100 text-purple-700 border-purple-200' },
  { key: 'address_proof', label: 'Address Proof', color: 'bg-teal-100 text-teal-700 border-teal-200' },
  { key: 'passport', label: 'Passport', color: 'bg-indigo-100 text-indigo-700 border-indigo-200' },
  { key: 'driving_licence', label: 'Driving Licence', color: 'bg-sky-100 text-sky-700 border-sky-200' },
  { key: 'education', label: 'Education', color: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  { key: 'experience', label: 'Experience', color: 'bg-cyan-100 text-cyan-700 border-cyan-200' },
  { key: 'offer_letter', label: 'Offer Letter', color: 'bg-amber-100 text-amber-800 border-amber-200' },
  { key: 'appointment_letter', label: 'Appointment Letter', color: 'bg-orange-100 text-orange-700 border-orange-200' },
  { key: 'bank_proof', label: 'Bank Proof', color: 'bg-green-100 text-green-700 border-green-200' },
  { key: 'other', label: 'Other', color: 'bg-slate-100 text-slate-600 border-slate-200' },
] as const;

/** Metadata for a document-type key; safe fallback styling for unknown keys. */
export function docTypeMeta(key: string | null | undefined): HrDocTypeMeta {
  return (
    HR_DOC_TYPES.find((t) => t.key === key) ?? {
      key: (key as HrDocType) || 'other',
      label: labelize(key) || 'Other',
      color: 'bg-slate-100 text-slate-600 border-slate-200',
    }
  );
}

/** True when the key is a valid hr_documents.doc_type value. */
export function isHrDocType(key: string | null | undefined): key is HrDocType {
  return HR_DOC_TYPES.some((t) => t.key === key);
}

/* ------------------------------------------------------------------ *
 * SOPs & training (Phase 5) — vocabularies
 * ------------------------------------------------------------------ */

/** All values hr_sop_versions.status accepts. Publishing archives the old
 *  published version; assignments always point at a version, never the SOP. */
export type HrSopVersionStatus = 'draft' | 'published' | 'archived';

export interface HrSopVersionStatusMeta {
  key: HrSopVersionStatus;
  label: string;
  /** Tailwind badge classes (bg + text + border), safe to drop on a <span>. */
  color: string;
}

/** Ordered SOP-version status vocabulary with badge colors. */
export const HR_SOP_VERSION_STATUSES: readonly HrSopVersionStatusMeta[] = [
  { key: 'draft', label: 'Draft', color: 'bg-amber-100 text-amber-800 border-amber-200' },
  { key: 'published', label: 'Published', color: 'bg-green-100 text-green-700 border-green-200' },
  { key: 'archived', label: 'Archived', color: 'bg-slate-100 text-slate-600 border-slate-200' },
] as const;

/** Metadata for a SOP-version status key; safe fallback styling for unknown keys. */
export function sopVersionStatusMeta(key: string | null | undefined): HrSopVersionStatusMeta {
  return (
    HR_SOP_VERSION_STATUSES.find((s) => s.key === key) ?? {
      key: (key as HrSopVersionStatus) || 'draft',
      label: labelize(key) || 'Draft',
      color: 'bg-slate-100 text-slate-600 border-slate-200',
    }
  );
}

/** True when the key is a valid hr_sop_versions.status value. */
export function isHrSopVersionStatus(key: string | null | undefined): key is HrSopVersionStatus {
  return HR_SOP_VERSION_STATUSES.some((s) => s.key === key);
}

/** All values hr_training_assignments.status accepts. */
export type HrTrainingStatus = 'assigned' | 'in_progress' | 'completed' | 'failed' | 'expired';

export interface HrTrainingStatusMeta {
  key: HrTrainingStatus;
  label: string;
  /** Tailwind badge classes (bg + text + border), safe to drop on a <span>. */
  color: string;
}

/** Ordered training-assignment status vocabulary with badge colors. */
export const HR_TRAINING_STATUSES: readonly HrTrainingStatusMeta[] = [
  { key: 'assigned', label: 'Assigned', color: 'bg-sky-100 text-sky-700 border-sky-200' },
  { key: 'in_progress', label: 'In Progress', color: 'bg-indigo-100 text-indigo-700 border-indigo-200' },
  { key: 'completed', label: 'Completed', color: 'bg-green-100 text-green-700 border-green-200' },
  { key: 'failed', label: 'Failed', color: 'bg-rose-100 text-rose-700 border-rose-200' },
  { key: 'expired', label: 'Expired', color: 'bg-orange-100 text-orange-700 border-orange-200' },
] as const;

/** Metadata for a training status key; safe fallback styling for unknown keys. */
export function trainingStatusMeta(key: string | null | undefined): HrTrainingStatusMeta {
  return (
    HR_TRAINING_STATUSES.find((s) => s.key === key) ?? {
      key: (key as HrTrainingStatus) || 'assigned',
      label: labelize(key) || 'Assigned',
      color: 'bg-slate-100 text-slate-600 border-slate-200',
    }
  );
}

/** True when the key is a valid hr_training_assignments.status value. */
export function isHrTrainingStatus(key: string | null | undefined): key is HrTrainingStatus {
  return HR_TRAINING_STATUSES.some((s) => s.key === key);
}

/* ------------------------------------------------------------------ *
 * People lifecycle (Phase 6) — vocabularies
 * ------------------------------------------------------------------ */

/** All values hr_candidates.stage accepts — the recruitment pipeline order. */
export type HrCandidateStage =
  | 'applied'
  | 'shortlisted'
  | 'interview'
  | 'selected'
  | 'offer'
  | 'joined'
  | 'rejected';

export interface HrCandidateStageMeta {
  key: HrCandidateStage;
  label: string;
  /** Tailwind badge classes (bg + text + border), safe to drop on a <span>. */
  color: string;
}

/** Ordered candidate-stage vocabulary with badge colors. */
export const HR_CANDIDATE_STAGES: readonly HrCandidateStageMeta[] = [
  { key: 'applied', label: 'Applied', color: 'bg-gray-100 text-gray-700 border-gray-200' },
  { key: 'shortlisted', label: 'Shortlisted', color: 'bg-sky-100 text-sky-700 border-sky-200' },
  { key: 'interview', label: 'Interview', color: 'bg-indigo-100 text-indigo-700 border-indigo-200' },
  { key: 'selected', label: 'Selected', color: 'bg-teal-100 text-teal-700 border-teal-200' },
  { key: 'offer', label: 'Offer', color: 'bg-purple-100 text-purple-700 border-purple-200' },
  { key: 'joined', label: 'Joined', color: 'bg-green-100 text-green-700 border-green-200' },
  { key: 'rejected', label: 'Rejected', color: 'bg-rose-100 text-rose-700 border-rose-200' },
] as const;

/** Metadata for a candidate-stage key; safe fallback styling for unknown keys. */
export function candidateStageMeta(key: string | null | undefined): HrCandidateStageMeta {
  return (
    HR_CANDIDATE_STAGES.find((s) => s.key === key) ?? {
      key: (key as HrCandidateStage) || 'applied',
      label: labelize(key) || 'Applied',
      color: 'bg-slate-100 text-slate-600 border-slate-200',
    }
  );
}

/** True when the key is a valid hr_candidates.stage value. */
export function isHrCandidateStage(key: string | null | undefined): key is HrCandidateStage {
  return HR_CANDIDATE_STAGES.some((s) => s.key === key);
}

/** All values hr_assets.status accepts. */
export type HrAssetStatus = 'in_store' | 'issued' | 'returned' | 'damaged' | 'lost';

export interface HrAssetStatusMeta {
  key: HrAssetStatus;
  label: string;
  /** Tailwind badge classes (bg + text + border), safe to drop on a <span>. */
  color: string;
}

/** Ordered asset status vocabulary with badge colors. */
export const HR_ASSET_STATUSES: readonly HrAssetStatusMeta[] = [
  { key: 'in_store', label: 'In Store', color: 'bg-gray-100 text-gray-700 border-gray-200' },
  { key: 'issued', label: 'Issued', color: 'bg-blue-100 text-blue-700 border-blue-200' },
  { key: 'returned', label: 'Returned', color: 'bg-teal-100 text-teal-700 border-teal-200' },
  { key: 'damaged', label: 'Damaged', color: 'bg-orange-100 text-orange-700 border-orange-200' },
  { key: 'lost', label: 'Lost', color: 'bg-rose-100 text-rose-700 border-rose-200' },
] as const;

/** Metadata for an asset status key; safe fallback styling for unknown keys. */
export function assetStatusMeta(key: string | null | undefined): HrAssetStatusMeta {
  return (
    HR_ASSET_STATUSES.find((s) => s.key === key) ?? {
      key: (key as HrAssetStatus) || 'in_store',
      label: labelize(key) || 'In Store',
      color: 'bg-slate-100 text-slate-600 border-slate-200',
    }
  );
}

/** True when the key is a valid hr_assets.status value. */
export function isHrAssetStatus(key: string | null | undefined): key is HrAssetStatus {
  return HR_ASSET_STATUSES.some((s) => s.key === key);
}

/** All values hr_assets.kind accepts. */
export type HrAssetKind =
  | 'uniform'
  | 'shoes'
  | 'id_card'
  | 'locker'
  | 'keys'
  | 'tablet'
  | 'mobile'
  | 'laptop'
  | 'pos_device'
  | 'other';

export interface HrAssetKindMeta {
  key: HrAssetKind;
  label: string;
  /** Tailwind badge classes (bg + text + border), safe to drop on a <span>. */
  color: string;
}

/** Ordered asset-kind vocabulary with badge colors. */
export const HR_ASSET_KINDS: readonly HrAssetKindMeta[] = [
  { key: 'uniform', label: 'Uniform', color: 'bg-blue-100 text-blue-700 border-blue-200' },
  { key: 'shoes', label: 'Shoes', color: 'bg-teal-100 text-teal-700 border-teal-200' },
  { key: 'id_card', label: 'ID Card', color: 'bg-purple-100 text-purple-700 border-purple-200' },
  { key: 'locker', label: 'Locker', color: 'bg-amber-100 text-amber-800 border-amber-200' },
  { key: 'keys', label: 'Keys', color: 'bg-orange-100 text-orange-700 border-orange-200' },
  { key: 'tablet', label: 'Tablet', color: 'bg-indigo-100 text-indigo-700 border-indigo-200' },
  { key: 'mobile', label: 'Mobile', color: 'bg-sky-100 text-sky-700 border-sky-200' },
  { key: 'laptop', label: 'Laptop', color: 'bg-cyan-100 text-cyan-700 border-cyan-200' },
  { key: 'pos_device', label: 'POS Device', color: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  { key: 'other', label: 'Other', color: 'bg-slate-100 text-slate-600 border-slate-200' },
] as const;

/** Metadata for an asset-kind key; safe fallback styling for unknown keys. */
export function assetKindMeta(key: string | null | undefined): HrAssetKindMeta {
  return (
    HR_ASSET_KINDS.find((k) => k.key === key) ?? {
      key: (key as HrAssetKind) || 'other',
      label: labelize(key) || 'Other',
      color: 'bg-slate-100 text-slate-600 border-slate-200',
    }
  );
}

/** True when the key is a valid hr_assets.kind value. */
export function isHrAssetKind(key: string | null | undefined): key is HrAssetKind {
  return HR_ASSET_KINDS.some((k) => k.key === key);
}

/** All values hr_disciplinary_records.kind accepts. */
export type HrDisciplinaryKind = 'incident' | 'warning' | 'show_cause';

export interface HrDisciplinaryKindMeta {
  key: HrDisciplinaryKind;
  label: string;
  /** Tailwind badge classes (bg + text + border), safe to drop on a <span>. */
  color: string;
}

/** Ordered disciplinary-kind vocabulary with badge colors. */
export const HR_DISCIPLINARY_KINDS: readonly HrDisciplinaryKindMeta[] = [
  { key: 'incident', label: 'Incident', color: 'bg-amber-100 text-amber-800 border-amber-200' },
  { key: 'warning', label: 'Warning', color: 'bg-orange-100 text-orange-700 border-orange-200' },
  { key: 'show_cause', label: 'Show Cause', color: 'bg-rose-100 text-rose-700 border-rose-200' },
] as const;

/** Metadata for a disciplinary-kind key; safe fallback styling for unknown keys. */
export function disciplinaryKindMeta(key: string | null | undefined): HrDisciplinaryKindMeta {
  return (
    HR_DISCIPLINARY_KINDS.find((k) => k.key === key) ?? {
      key: (key as HrDisciplinaryKind) || 'incident',
      label: labelize(key) || 'Incident',
      color: 'bg-slate-100 text-slate-600 border-slate-200',
    }
  );
}

/** True when the key is a valid hr_disciplinary_records.kind value. */
export function isHrDisciplinaryKind(key: string | null | undefined): key is HrDisciplinaryKind {
  return HR_DISCIPLINARY_KINDS.some((k) => k.key === key);
}

/** All values hr_resignations.status accepts — the exit workflow order. */
export type HrResignationStatus =
  | 'submitted'
  | 'manager_approved'
  | 'hr_approved'
  | 'withdrawn'
  | 'completed';

export interface HrResignationStatusMeta {
  key: HrResignationStatus;
  label: string;
  /** Tailwind badge classes (bg + text + border), safe to drop on a <span>. */
  color: string;
}

/** Ordered resignation status vocabulary with badge colors. */
export const HR_RESIGNATION_STATUSES: readonly HrResignationStatusMeta[] = [
  { key: 'submitted', label: 'Submitted', color: 'bg-amber-100 text-amber-800 border-amber-200' },
  { key: 'manager_approved', label: 'Manager Approved', color: 'bg-sky-100 text-sky-700 border-sky-200' },
  { key: 'hr_approved', label: 'HR Approved', color: 'bg-green-100 text-green-700 border-green-200' },
  { key: 'withdrawn', label: 'Withdrawn', color: 'bg-slate-100 text-slate-600 border-slate-200' },
  { key: 'completed', label: 'Completed', color: 'bg-gray-100 text-gray-700 border-gray-200' },
] as const;

/** Metadata for a resignation status key; safe fallback styling for unknown keys. */
export function resignationStatusMeta(key: string | null | undefined): HrResignationStatusMeta {
  return (
    HR_RESIGNATION_STATUSES.find((s) => s.key === key) ?? {
      key: (key as HrResignationStatus) || 'submitted',
      label: labelize(key) || 'Submitted',
      color: 'bg-slate-100 text-slate-600 border-slate-200',
    }
  );
}

/** True when the key is a valid hr_resignations.status value. */
export function isHrResignationStatus(key: string | null | undefined): key is HrResignationStatus {
  return HR_RESIGNATION_STATUSES.some((s) => s.key === key);
}

/* ------------------------------------------------------------------ *
 * Shifts, roster & leave (Phase 3) — row-shaped interfaces
 * (mirror the Phases 3-7 hr_* tables in db.ts exactly; REAL columns
 * declared without NOT NULL are number | null)
 * ------------------------------------------------------------------ */

/** One row of hr_shifts (soft delete via is_active). Times are IST clock
 *  strings; end < start = overnight (+1 day); split_json holds the extra
 *  windows of a split shift. */
export interface HrShift {
  id: string;
  name: string;
  /** IST clock time 'HH:MM'. */
  start_hhmm: string;
  /** IST clock time 'HH:MM'; end < start = overnight (+1 day). */
  end_hhmm: string;
  /** JSON array of optional extra [start,end] windows for split shifts. */
  split_json: string;
  break_minutes: number;
  grace_minutes: number;
  late_after_minutes: number;
  early_out_before_minutes: number;
  overtime_after_minutes: number;
  /** departments.id — a hint for pickers, not a constraint. */
  department_id: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

/** One row of hr_rosters — one shift per employee per IST business date
 *  (UNIQUE(employee_id, date)). */
export interface HrRoster {
  id: string;
  employee_id: string;
  /** IST business date (YYYY-MM-DD). */
  date: string;
  /** hr_shifts.id. */
  shift_id: string;
  note: string;
  /** me.email (house actor convention). */
  created_by: string;
  created_at: string;
}

/** One row of hr_shift_requests (change/swap request against a roster day). */
export interface HrShiftRequest {
  id: string;
  employee_id: string;
  /** IST business date (YYYY-MM-DD). */
  date: string;
  /** hr_shifts.id being requested. */
  requested_shift_id: string;
  /** hr_employees.id of the swap counterpart, '' = plain change request. */
  swap_with_employee_id: string;
  reason: string;
  status: HrShiftRequestStatus | string;
  requested_by: string;
  reviewed_by: string;
  reviewed_at: string;
  review_reason: string;
  created_at: string;
}

/** One row of hr_leave_types (soft delete via is_active). */
export interface HrLeaveType {
  id: string;
  name: string;
  annual_entitlement: number;
  carry_forward_max: number;
  encashable: number;
  /** 0 = no cap. */
  max_consecutive_days: number;
  is_paid: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

/** One row of hr_leave_balances — per employee/type/year
 *  (UNIQUE(employee_id, leave_type_id, year)). Available =
 *  entitled + adjusted - taken; computed, never stored. */
export interface HrLeaveBalance {
  id: string;
  employee_id: string;
  /** hr_leave_types.id. */
  leave_type_id: string;
  /** Calendar year, e.g. '2026'. */
  year: string;
  entitled: number;
  taken: number;
  /** Manual +/- with audit. */
  adjusted: number;
}

/** One row of hr_leave_requests. days supports 0.5 (half day). */
export interface HrLeaveRequest {
  id: string;
  employee_id: string;
  /** hr_leave_types.id. */
  leave_type_id: string;
  /** YYYY-MM-DD. */
  from_date: string;
  /** YYYY-MM-DD. */
  to_date: string;
  days: number;
  reason: string;
  status: HrLeaveStatus | string;
  requested_by: string;
  reviewed_by: string;
  reviewed_at: string;
  review_reason: string;
  created_at: string;
}

/* ------------------------------------------------------------------ *
 * Pay: salary, statutory, bank, documents, advances, payroll (Phase 4)
 * — row-shaped interfaces
 * ------------------------------------------------------------------ */

/** One row of hr_salary_structures — APPEND-ONLY money history. A revision
 *  INSERTs a new row and closes the previous row's effective_to in the SAME
 *  transaction; old rows are NEVER updated. */
export interface HrSalaryStructure {
  id: string;
  employee_id: string;
  /** YYYY-MM-DD. */
  effective_from: string;
  /** YYYY-MM-DD; '' = current. */
  effective_to: string;
  basic: number;
  hra: number;
  /** JSON [{label, amount}]. */
  allowances_json: string;
  gross: number;
  /** JSON [{label, amount}]. */
  deductions_json: string;
  net: number;
  note: string;
  created_by: string;
  created_at: string;
}

/** One row of hr_statutory_configs — effective-dated CONFIG ROWS (never
 *  constants in code, never columns on the employee), scoped by
 *  state/category, applied at payroll compute time. */
export interface HrStatutoryConfig {
  id: string;
  kind: 'pf' | 'esi' | 'professional_tax' | 'tds' | 'bonus' | 'gratuity' | 'min_wage' | string;
  /** '' = all-India. */
  state: string;
  employee_category: string;
  /** YYYY-MM-DD. */
  effective_from: string;
  /** YYYY-MM-DD; '' = current. */
  effective_to: string;
  /** Rates/slabs JSON, shape per kind. */
  config_json: string;
  is_active: number;
  created_by: string;
  created_at: string;
}

/** One row of hr_bank_accounts. account_number is readable in FULL only by
 *  canViewSalary callers — every other surface renders
 *  maskAccountNumber(account_number). */
export interface HrBankAccount {
  id: string;
  employee_id: string;
  bank_name: string;
  account_holder: string;
  /** FULL value — mask on every non-privileged surface. */
  account_number: string;
  ifsc: string;
  branch: string;
  account_type: string;
  verify_status: 'unverified' | 'verified' | 'rejected' | string;
  verified_by: string;
  verified_at: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

/** One row of hr_documents WITHOUT the data BLOB — the blob never rides
 *  JSON; bytes are served only by the gated download route
 *  (Cache-Control: private, no-store). */
export interface HrDocumentMeta {
  id: string;
  employee_id: string;
  doc_type: HrDocType | string;
  /** Masked outside canViewHrDocs. */
  doc_number: string;
  /** YYYY-MM-DD or ''. */
  issue_date: string;
  /** YYYY-MM-DD or ''; expiry alerts key on this. */
  expiry_date: string;
  filename: string;
  mime: string;
  size_bytes: number;
  verify_status: 'unverified' | 'verified' | 'rejected' | string;
  verified_by: string;
  uploaded_by: string;
  created_at: string;
}

/** One row of hr_advances. Recovery detail lives in the append-only
 *  hr_advance_installments ledger; state lives in status. */
export interface HrAdvance {
  id: string;
  employee_id: string;
  requested_amount: number;
  approved_amount: number;
  installment_amount: number;
  recovered_amount: number;
  reason: string;
  status: HrAdvanceStatus | string;
  requested_at: string;
  reviewed_by: string;
  reviewed_at: string;
  disbursed_at: string;
  created_by: string;
}

/** One row of hr_advance_installments — the append-only recovery ledger
 *  (UNIQUE(advance_id, period)). */
export interface HrAdvanceInstallment {
  id: string;
  /** hr_advances.id. */
  advance_id: string;
  /** Payroll period, e.g. '2026-09'. */
  period: string;
  amount: number;
  status: 'due' | 'recovered' | 'waived' | string;
  recovered_at: string;
  /** hr_payroll_items.id — set when a payroll run recovers it, '' before. */
  payroll_item_id: string;
}

/** One row of hr_payroll_runs (UNIQUE(period, outlet_id)). Draft until
 *  finalized; a finalized run is IMMUTABLE. */
export interface HrPayrollRun {
  id: string;
  /** '2026-09'. */
  period: string;
  outlet_id: string;
  status: HrPayrollRunStatus | string;
  note: string;
  created_by: string;
  finalized_by: string;
  finalized_at: string;
  created_at: string;
}

/** One row of hr_payroll_items — one frozen payslip line per employee per
 *  run (UNIQUE(run_id, employee_id)); detail_json is the full compute
 *  trace, frozen at run time. */
export interface HrPayrollItem {
  id: string;
  /** hr_payroll_runs.id. */
  run_id: string;
  employee_id: string;
  paid_days: number;
  lop_days: number;
  overtime_minutes: number;
  /** JSON [{label, amount}]. */
  earnings_json: string;
  /** JSON [{label, amount}]. */
  deductions_json: string;
  gross: number;
  net: number;
  /** The full compute trace, frozen. */
  detail_json: string;
}

/* ------------------------------------------------------------------ *
 * SOPs, training & tests (Phase 5) — row-shaped interfaces
 * ------------------------------------------------------------------ */

/** One row of hr_sops — the SOP head; content lives in hr_sop_versions. */
export interface HrSop {
  id: string;
  title: string;
  category: string;
  /** departments.id — targeting hint. */
  department_id: string;
  /** hr_designations.id — targeting hint. */
  designation_id: string;
  is_active: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** One row of hr_sop_versions (UNIQUE(sop_id, version)). Publishing a
 *  version assigns it and archives the previously published one. */
export interface HrSopVersion {
  id: string;
  /** hr_sops.id. */
  sop_id: string;
  version: number;
  /** The SOP content (rich text / markdown). */
  body: string;
  status: HrSopVersionStatus | string;
  require_ack: number;
  published_by: string;
  published_at: string;
  created_at: string;
}

/** One row of hr_sop_assignments (UNIQUE(sop_version_id, employee_id)) —
 *  per-person viewed/acknowledged tracking against a VERSION. */
export interface HrSopAssignment {
  id: string;
  /** hr_sop_versions.id. */
  sop_version_id: string;
  employee_id: string;
  /** '' = not yet viewed. */
  viewed_at: string;
  /** '' = not yet acknowledged. */
  acknowledged_at: string;
  /** Nullable REAL — null = no quiz taken. */
  quiz_score: number | null;
  assigned_by: string;
  created_at: string;
}

/** One row of hr_trainings (soft delete via is_active). */
export interface HrTraining {
  id: string;
  name: string;
  trainer: string;
  /** hr_sops.id or ''. */
  sop_id: string;
  department_id: string;
  is_active: number;
  created_by: string;
  created_at: string;
}

/** One row of hr_training_assignments (UNIQUE(training_id, employee_id)). */
export interface HrTrainingAssignment {
  id: string;
  /** hr_trainings.id. */
  training_id: string;
  employee_id: string;
  /** YYYY-MM-DD or ''. */
  assigned_date: string;
  due_date: string;
  completed_date: string;
  /** Nullable REAL — null = not scored. */
  score: number | null;
  remarks: string;
  status: HrTrainingStatus | string;
  assigned_by: string;
}

/** One row of hr_tests (knowledge test definition; soft delete via is_active). */
export interface HrTest {
  id: string;
  name: string;
  department_id: string;
  designation_id: string;
  pass_score: number;
  max_attempts: number;
  /** 0 = untimed. */
  time_limit_minutes: number;
  shuffle: number;
  version: number;
  is_active: number;
  created_by: string;
  created_at: string;
}

/** One row of hr_test_questions. `correct` is the answer key and is NEVER
 *  serialized to takers — the take-test API must project it OUT; it exists
 *  in JSON only on the admin authoring surface. */
export interface HrTestQuestion {
  id: string;
  /** hr_tests.id. */
  test_id: string;
  kind: 'mcq' | 'true_false' | string;
  question: string;
  /** JSON array of option strings/keys. */
  options_json: string;
  /** Correct option key — NEVER sent to takers. */
  correct: string;
  sort_order: number;
  is_active: number;
}

/** One row of hr_test_attempts (UNIQUE(test_id, employee_id, attempt_no));
 *  test_version freezes which version was attempted. */
export interface HrTestAttempt {
  id: string;
  /** hr_tests.id. */
  test_id: string;
  test_version: number;
  employee_id: string;
  attempt_no: number;
  /** JSON {question_id: chosen_option}. */
  answers_json: string;
  score: number;
  passed: number;
  started_at: string;
  /** '' = still in progress. */
  finished_at: string;
}

/* ------------------------------------------------------------------ *
 * Performance, assets, recruitment, discipline, exit (Phase 6)
 * — row-shaped interfaces
 * ------------------------------------------------------------------ */

/** One row of hr_kpis (soft delete via is_active). */
export interface HrKpi {
  id: string;
  name: string;
  weight: number;
  is_active: number;
  created_at: string;
}

/** One row of hr_performance_reviews (UNIQUE(employee_id, period, kind)). */
export interface HrPerformanceReview {
  id: string;
  employee_id: string;
  /** '2026-09' | '2026-Q3' | '2026'. */
  period: string;
  kind: 'monthly' | 'quarterly' | 'annual' | string;
  /** JSON [{kpi_id, score, note}] — kpi_id -> hr_kpis.id. */
  scores_json: string;
  overall: number;
  remarks: string;
  reviewed_by: string;
  created_at: string;
}

/** One row of hr_assets. Movements live in the append-only
 *  hr_asset_history ledger; state lives in status. */
export interface HrAsset {
  id: string;
  name: string;
  kind: HrAssetKind | string;
  /** Asset tag / serial. */
  tag: string;
  /** hr_employees.id of the current holder; '' = in store, unissued. */
  employee_id: string;
  status: HrAssetStatus | string;
  note: string;
  created_at: string;
  updated_at: string;
}

/** One row of hr_asset_history — the append-only movement ledger. */
export interface HrAssetHistory {
  id: string;
  /** hr_assets.id. */
  asset_id: string;
  /** hr_employees.id involved in the movement, '' when none. */
  employee_id: string;
  action: 'issued' | 'returned' | 'damaged' | 'lost' | 'repaired' | string;
  note: string;
  /** me.email (house actor convention). */
  acted_by: string;
  at: string;
}

/** One row of hr_candidates. employee_id is set ONLY when the candidate is
 *  converted to an hr_employees row on join. */
export interface HrCandidate {
  id: string;
  name: string;
  /** PhoneField contract: +91 = bare 10 digits. */
  phone10: string;
  email: string;
  position: string;
  department_id: string;
  resume_note: string;
  /** Nullable REAL — null = not scored. */
  interview_score: number | null;
  /** Nullable REAL — null = not stated. */
  expected_salary: number | null;
  /** Nullable REAL — null = no offer made. */
  offered_salary: number | null;
  /** YYYY-MM-DD or ''. */
  joining_date: string;
  stage: HrCandidateStage | string;
  /** hr_employees.id — set only on convert; '' before. */
  employee_id: string;
  note: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** One row of hr_onboarding_items (per-employee checklist row). */
export interface HrOnboardingItem {
  id: string;
  employee_id: string;
  /** Free label: kyc|bank|documents|uniform|... */
  item: string;
  done: number;
  done_by: string;
  done_at: string;
  sort_order: number;
}

/** One row of hr_disciplinary_records — the most restricted surface in the
 *  module: adminOnly page + canAdminHr on every verb. */
export interface HrDisciplinaryRecord {
  id: string;
  employee_id: string;
  kind: HrDisciplinaryKind | string;
  subject: string;
  detail: string;
  employee_response: string;
  manager_comment: string;
  final_decision: string;
  status: 'open' | 'closed' | string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** One row of hr_resignations. HR status stays descriptive: completing an
 *  exit PROPOSES login deactivation via /users, never writes users.is_active
 *  (contract D1). */
export interface HrResignation {
  id: string;
  employee_id: string;
  /** YYYY-MM-DD or ''. */
  resignation_date: string;
  notice_days: number;
  /** YYYY-MM-DD or ''. */
  last_working_date: string;
  reason: string;
  status: HrResignationStatus | string;
  /** me.email of the manager decision; '' until decided. */
  manager_by: string;
  manager_at: string;
  /** me.email of the HR decision; '' until decided. */
  hr_by: string;
  hr_at: string;
  created_by: string;
  created_at: string;
}

/** One row of hr_exit_clearance (UNIQUE(employee_id, item)). */
export interface HrExitClearance {
  id: string;
  employee_id: string;
  /** assets|advances|leave_encash|fnf|experience_letter|... free label. */
  item: string;
  status: 'pending' | 'cleared' | 'waived' | string;
  note: string;
  cleared_by: string;
  cleared_at: string;
}

/* ------------------------------------------------------------------ *
 * Notifications (Phase 7) — row-shaped interface
 * ------------------------------------------------------------------ */

/** One row of hr_notifications — durable per-user rows (task_notifications
 *  shape) behind the live-COUNT bell buckets. Addressed by EMAIL (a login),
 *  not employee_id: only login holders have a bell. */
export interface HrNotification {
  id: string;
  recipient_email: string;
  kind: string;
  title: string;
  body: string;
  href: string;
  is_read: number;
  created_at: string;
}

/* ------------------------------------------------------------------ *
 * Masking helpers
 * ------------------------------------------------------------------ */

/**
 * Mask a bank account number to the house 'XXXX XXXX 4587' style: only the
 * last 4 characters stay visible, the rest become X runs grouped in 4s.
 * '' / null / undefined -> ''. Values of 4 characters or fewer are returned
 * as-is (they ARE the last 4). Every surface without canViewSalary renders
 * this, never the raw column.
 */
export function maskAccountNumber(acct: string | null | undefined): string {
  const raw = String(acct ?? '').replace(/\s+/g, '');
  if (!raw) return '';
  const visible = raw.slice(-4);
  const maskedLen = raw.length - visible.length;
  if (maskedLen <= 0) return visible;
  const groups: string[] = [];
  for (let i = 0; i < maskedLen; i += 4) {
    groups.push('X'.repeat(Math.min(4, maskedLen - i)));
  }
  groups.push(visible);
  return groups.join(' ');
}
