/**
 * Task Management — shared contract module.
 *
 * THE single source of truth every Task-Management slice imports: status /
 * priority / category / department vocabularies, badge color classes, mention
 * parsing, permission gates, recurrence math, and the row-shaped TS interfaces
 * mirroring the task_* tables in src/lib/db.ts.
 *
 * Pure module — no runtime DB import. It imports ONLY a *type* from ./auth
 * (erased at compile time), so it is safe on both server and client.
 */

import type { SessionUser } from './auth';

/* ------------------------------------------------------------------ *
 * Status
 * ------------------------------------------------------------------ */

/**
 * All status values the tasks.status column accepts (matches the CHECK-style
 * enum documented in db.ts). Ordered as the natural workflow progression, with
 * the two off-ramp states (on_hold, cancelled) last.
 */
export type TaskStatus =
  | 'draft'
  | 'assigned'
  | 'accepted'
  | 'in_progress'
  | 'waiting_verification'
  | 'completed'
  | 'approved'
  | 'reopened'
  | 'on_hold'
  | 'cancelled';

export interface StatusMeta {
  key: TaskStatus;
  label: string;
  /** Tailwind badge classes (bg + text + border), safe to drop on a <span>. */
  color: string;
}

/** Ordered status vocabulary with badge colors. */
export const TASK_STATUSES: readonly StatusMeta[] = [
  { key: 'draft', label: 'Draft', color: 'bg-gray-100 text-gray-700 border-gray-200' },
  { key: 'assigned', label: 'Assigned', color: 'bg-blue-100 text-blue-700 border-blue-200' },
  { key: 'accepted', label: 'Accepted', color: 'bg-indigo-100 text-indigo-700 border-indigo-200' },
  { key: 'in_progress', label: 'In Progress', color: 'bg-amber-100 text-amber-800 border-amber-200' },
  { key: 'waiting_verification', label: 'Waiting Verification', color: 'bg-purple-100 text-purple-700 border-purple-200' },
  { key: 'completed', label: 'Completed', color: 'bg-teal-100 text-teal-700 border-teal-200' },
  { key: 'approved', label: 'Approved', color: 'bg-green-100 text-green-700 border-green-200' },
  { key: 'reopened', label: 'Reopened', color: 'bg-orange-100 text-orange-700 border-orange-200' },
  { key: 'on_hold', label: 'On Hold', color: 'bg-yellow-100 text-yellow-800 border-yellow-200' },
  { key: 'cancelled', label: 'Cancelled', color: 'bg-rose-100 text-rose-700 border-rose-200' },
] as const;

const STATUS_FALLBACK: StatusMeta = {
  key: 'draft',
  label: 'Draft',
  color: 'bg-gray-100 text-gray-700 border-gray-200',
};

/** Metadata for a status key; falls back to Draft styling for unknown keys. */
export function statusMeta(key: string | null | undefined): StatusMeta {
  return TASK_STATUSES.find((s) => s.key === key) ?? { ...STATUS_FALLBACK, key: (key as TaskStatus) || 'draft', label: labelize(key) || 'Draft' };
}

/* ------------------------------------------------------------------ *
 * Priority
 * ------------------------------------------------------------------ */

export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface PriorityMeta {
  key: TaskPriority;
  label: string;
  /** Tailwind badge classes (bg + text + border). */
  color: string;
}

export const TASK_PRIORITIES: readonly PriorityMeta[] = [
  { key: 'low', label: 'Low', color: 'bg-slate-100 text-slate-600 border-slate-200' },
  { key: 'medium', label: 'Medium', color: 'bg-blue-100 text-blue-700 border-blue-200' },
  { key: 'high', label: 'High', color: 'bg-orange-100 text-orange-700 border-orange-200' },
  { key: 'urgent', label: 'Urgent', color: 'bg-red-100 text-red-700 border-red-200' },
] as const;

const PRIORITY_FALLBACK: PriorityMeta = {
  key: 'medium',
  label: 'Medium',
  color: 'bg-blue-100 text-blue-700 border-blue-200',
};

/** Metadata for a priority key; falls back to Medium styling for unknown keys. */
export function priorityMeta(key: string | null | undefined): PriorityMeta {
  return TASK_PRIORITIES.find((p) => p.key === key) ?? { ...PRIORITY_FALLBACK, key: (key as TaskPriority) || 'medium', label: labelize(key) || 'Medium' };
}

/* ------------------------------------------------------------------ *
 * Vocabularies (seeded in db.ts — kept in sync here for pickers/filters)
 * ------------------------------------------------------------------ */

/** 13 seeded task categories (order matches the db seed). */
export const TASK_CATEGORIES: readonly string[] = [
  'Hygiene',
  'Maintenance',
  'Repairs',
  'Operations',
  'HR',
  'Training',
  'Kitchen',
  'Housekeeping',
  'Store',
  'Bar',
  'Admin',
  'Compliance',
  'Safety',
] as const;

/** 10 seeded task departments (order matches the db seed). */
export const TASK_DEPARTMENTS: readonly string[] = [
  'Operations',
  'Kitchen',
  'Bar',
  'Housekeeping',
  'Maintenance',
  'Store',
  'HR',
  'Accounts',
  'Security',
  'Administration',
] as const;

/** Roles that own a daily checklist template. */
export const CHECKLIST_ROLES: readonly string[] = [
  'Operations Manager',
  'Floor Manager',
  'HR Manager',
  'Store Manager',
  'Bar Manager',
] as const;

/** Areas covered by hygiene audits. */
export const HYGIENE_AREAS: readonly string[] = [
  'Restaurant',
  'Washrooms',
  'Kitchen',
  'Bar',
] as const;

/* ------------------------------------------------------------------ *
 * Mentions
 * ------------------------------------------------------------------ */

// Try an email first (must contain @domain.tld), else a plain @handle token.
const MENTION_RE =
  /@([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|[A-Za-z0-9._-]+)/g;

/**
 * Extract @-mention tokens from free text. Returns the raw mentioned strings
 * (email addresses or @handles) WITHOUT the leading '@', de-duplicated and in
 * first-seen order. e.g. "hey @arun and @sita@x.com" -> ["arun","sita@x.com"].
 */
export function parseMentions(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(text)) !== null) {
    const token = m[1];
    const key = token.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(token);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Permissions
 * ------------------------------------------------------------------ */

/** Subset of SessionUser the task gates read; accepts a full SessionUser too. */
type TaskActor = Pick<SessionUser, 'role' | 'is_head_chef' | 'is_store_manager'>;

/**
 * May create / assign / edit / manage tasks: admins, managers, head chefs, and
 * store managers.
 */
export function canManageTasks(me: TaskActor | null | undefined): boolean {
  if (!me) return false;
  return me.role === 'admin' || me.role === 'manager' || !!me.is_head_chef || !!me.is_store_manager;
}

/** May approve / reopen tasks and checklist findings. Same set as canManageTasks. */
export function canApproveTasks(me: TaskActor | null | undefined): boolean {
  return canManageTasks(me);
}

/* ------------------------------------------------------------------ *
 * Recurrence
 * ------------------------------------------------------------------ */

export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly';

/**
 * Compute the next occurrence date (YYYY-MM-DD, UTC-safe) strictly AFTER
 * fromISODate.
 *   - daily   : fromISODate + 1 day.
 *   - weekly  : next date landing on dayOfWeek (0=Sun..6=Sat); if omitted, +7d.
 *   - monthly : next date landing on dayOfMonth (1..31, clamped to month
 *               length); if omitted, same day-of-month next month.
 * Invalid fromISODate returns ''.
 */
export function nextRecurrence(
  freq: RecurrenceFrequency,
  fromISODate: string,
  dayOfWeek?: number,
  dayOfMonth?: number,
): string {
  const base = parseISODate(fromISODate);
  if (!base) return '';

  if (freq === 'daily') {
    return fmtISO(addDays(base, 1));
  }

  if (freq === 'weekly') {
    if (dayOfWeek === undefined || dayOfWeek === null || Number.isNaN(dayOfWeek)) {
      return fmtISO(addDays(base, 7));
    }
    const target = ((Math.trunc(dayOfWeek) % 7) + 7) % 7;
    let delta = (target - base.getUTCDay() + 7) % 7;
    if (delta === 0) delta = 7; // strictly after
    return fmtISO(addDays(base, delta));
  }

  // monthly
  if (dayOfMonth === undefined || dayOfMonth === null || Number.isNaN(dayOfMonth)) {
    return fmtISO(addMonthsClamped(base, 1, base.getUTCDate()));
  }
  const wanted = Math.min(Math.max(Math.trunc(dayOfMonth), 1), 31);
  // Candidate in the same month.
  const thisMonth = clampDayOfMonth(base.getUTCFullYear(), base.getUTCMonth(), wanted);
  if (thisMonth.getTime() > base.getTime()) return fmtISO(thisMonth);
  return fmtISO(addMonthsClamped(base, 1, wanted));
}

/* ------------------------------------------------------------------ *
 * Date helpers (UTC — dates are calendar-day strings)
 * ------------------------------------------------------------------ */

function parseISODate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo, d));
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

function fmtISO(d: Date): string {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

function daysInMonth(year: number, monthIdx: number): number {
  return new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
}

function clampDayOfMonth(year: number, monthIdx: number, day: number): Date {
  const clamped = Math.min(day, daysInMonth(year, monthIdx));
  return new Date(Date.UTC(year, monthIdx, clamped));
}

function addMonthsClamped(base: Date, months: number, day: number): Date {
  const total = base.getUTCFullYear() * 12 + base.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const monthIdx = ((total % 12) + 12) % 12;
  return clampDayOfMonth(year, monthIdx, day);
}

/** Humanize a snake_case key into Title Case ("in_progress" -> "In Progress"). */
function labelize(key: string | null | undefined): string {
  if (!key) return '';
  return String(key)
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/* ------------------------------------------------------------------ *
 * Row-shaped interfaces (mirror the task_* tables in db.ts)
 * ------------------------------------------------------------------ */

export interface Task {
  id: string;
  title: string;
  description: string;
  category: string;
  department: string;
  priority: TaskPriority | string;
  status: TaskStatus | string;
  assignee_email: string;
  assignee_name: string;
  created_by: string;
  due_date: string;
  due_time: string;
  estimated_minutes: number;
  parent_task_id: string;
  recurring_rule_id: string;
  template_id: string;
  source: 'manual' | 'checklist' | 'maintenance' | 'hygiene' | 'recurring' | string;
  /** JSON string of the inline checklist array. */
  checklist_json: string;
  started_at: string | null;
  paused_at: string | null;
  completed_at: string | null;
  approved_at: string | null;
  approved_by: string | null;
  is_archived: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface TaskComment {
  id: string;
  task_id: string;
  author_email: string;
  author_name: string;
  body: string;
  created_at: string;
}

export interface ChecklistTemplate {
  id: string;
  name: string;
  role: string;
  department: string;
  category: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface MaintenanceSchedule {
  id: string;
  name: string;
  category: string;
  frequency: RecurrenceFrequency | string;
  department: string;
  assignee_email: string;
  next_due_date: string;
  last_generated_date: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface HygieneAudit {
  id: string;
  area: string;
  item: string;
  date: string;
  result: 'pass' | 'fail' | 'na' | string;
  image_url: string;
  corrective_action: string;
  created_task_id: string;
  score: number;
  auditor: string;
  created_at: string;
}

export interface KnowledgeTest {
  id: string;
  title: string;
  description: string;
  /** JSON string: array of {q,type:'mcq'|'image'|'practical',options[],answer,image_url}. */
  questions_json: string;
  time_limit_minutes: number;
  pass_score: number;
  is_active: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface TaskNotification {
  id: string;
  recipient_email: string;
  kind: string;
  title: string;
  body: string;
  task_id: string;
  href: string;
  is_read: number;
  created_at: string;
}
