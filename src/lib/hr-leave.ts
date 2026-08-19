/**
 * HRMS — leave balances & request validation (Phase 3).
 *
 * SERVER ONLY. This module touches the database and must NEVER be imported by
 * client code ('use client' components) — the pure, client-safe contract
 * (HrLeaveType / HrLeaveBalance / HrLeaveRequest row types and the status
 * vocabulary) lives in ./hr.ts. Contract: docs/HRMS_DECISIONS.md §5/§6.
 *
 * better-sqlite3 is SYNCHRONOUS: nothing in this file awaits, so every
 * function is safe to call inside a caller's db.transaction() callback —
 * none of them opens a transaction of its own.
 *
 * THE LEDGER RULES (backend-mapping contract, restated where enforced):
 *
 *  · employee_id is ALWAYS hr_employees.id — never users.id, never an email.
 *    leave_type_id is ALWAYS hr_leave_types.id.
 *
 *  · hr_leave_balances is one row per (employee, type, calendar year).
 *    `entitled` is SEEDED ONCE from hr_leave_types.annual_entitlement the
 *    first time the row is needed; later entitlement edits on the type do NOT
 *    rewrite existing rows (manual deltas go through `adjusted`, with audit,
 *    from the balances route). `available` = entitled + adjusted - taken is
 *    COMPUTED, never stored.
 *
 *  · A request's balance bucket is the calendar year of its FROM date
 *    (leaveYearOf). A request spanning New Year draws wholly from the
 *    starting year — the deliberate simple rule, applied consistently by
 *    both validateRequest() and applyApprovedLeave().
 *
 *  · `taken` is bumped ONLY by applyApprovedLeave(), which the approve
 *    handler calls INSIDE its own transaction alongside the status UPDATE —
 *    so a failed approval can never half-spend a balance. Unpaid types bump
 *    `taken` too (the register records reality); only PAID types enforce
 *    sufficiency at validation time.
 */

import type Database from 'better-sqlite3';
import { generateId } from './db';
import type { HrLeaveBalance, HrLeaveRequest, HrLeaveType } from './hr';

/* ------------------------------------------------------------------ *
 * Small pure helpers
 * ------------------------------------------------------------------ */

/**
 * The hr_leave_balances.year bucket a leave request belongs to: the calendar
 * year of its from_date ('2026-12-30' -> '2026'). Routes and this module must
 * agree on this rule, so it is exported rather than re-derived.
 */
export function leaveYearOf(fromDate: string): string {
  return String(fromDate ?? '').slice(0, 4);
}

/** True for a real calendar date in strict YYYY-MM-DD form ('2026-02-30' fails). */
function isValidYmd(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(t)) return false;
  // Round-trip guard: JS Date silently rolls '2026-02-30' into March.
  return new Date(t).toISOString().slice(0, 10) === s;
}

/** Inclusive calendar-day span: from_date == to_date -> 1. Valid YMDs only. */
function inclusiveSpanDays(fromDate: string, toDate: string): number {
  const ms = Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

/* ------------------------------------------------------------------ *
 * Balance rows
 * ------------------------------------------------------------------ */

/**
 * Ensure the (employee, type, year) balance row exists and return it.
 *
 * On first touch the row is seeded with entitled = the type's CURRENT
 * annual_entitlement (0 when the type row is missing — a dangling id degrades,
 * never throws), taken = 0, adjusted = 0. INSERT OR IGNORE + re-read makes
 * this race-safe under the UNIQUE(employee_id, leave_type_id, year) index:
 * two concurrent callers both get the one surviving row.
 *
 * Synchronous — safe (and intended) to call inside a caller's transaction.
 */
export function ensureBalanceRow(
  db: Database.Database,
  employee_id: string,
  leave_type_id: string,
  year: string,
): HrLeaveBalance {
  const type = db
    .prepare('SELECT annual_entitlement FROM hr_leave_types WHERE id = ?')
    .get(leave_type_id) as { annual_entitlement: number } | undefined;

  db.prepare(
    `INSERT OR IGNORE INTO hr_leave_balances
       (id, employee_id, leave_type_id, year, entitled, taken, adjusted)
     VALUES (?, ?, ?, ?, ?, 0, 0)`,
  ).run(generateId(), employee_id, leave_type_id, year, Number(type?.annual_entitlement) || 0);

  return db
    .prepare(
      `SELECT id, employee_id, leave_type_id, year, entitled, taken, adjusted
       FROM hr_leave_balances
       WHERE employee_id = ? AND leave_type_id = ? AND year = ?`,
    )
    .get(employee_id, leave_type_id, year) as HrLeaveBalance;
}

/** The computed balance view: available is derived, never stored. */
export interface HrLeaveBalanceView {
  entitled: number;
  taken: number;
  adjusted: number;
  /** entitled + adjusted - taken. Can go negative (unpaid leave still bumps taken). */
  available: number;
}

/**
 * Read-only balance for (employee, type, year). When no hr_leave_balances row
 * exists yet it reports what ensureBalanceRow WOULD seed (entitled = the
 * type's annual_entitlement, taken/adjusted 0) WITHOUT writing — so list/GET
 * surfaces stay pure reads and never mint rows as a side effect.
 */
export function balanceOf(
  db: Database.Database,
  employee_id: string,
  leave_type_id: string,
  year: string,
): HrLeaveBalanceView {
  const row = db
    .prepare(
      `SELECT entitled, taken, adjusted FROM hr_leave_balances
       WHERE employee_id = ? AND leave_type_id = ? AND year = ?`,
    )
    .get(employee_id, leave_type_id, year) as
    | { entitled: number; taken: number; adjusted: number }
    | undefined;

  if (row) {
    const entitled = Number(row.entitled) || 0;
    const taken = Number(row.taken) || 0;
    const adjusted = Number(row.adjusted) || 0;
    return { entitled, taken, adjusted, available: entitled + adjusted - taken };
  }

  const type = db
    .prepare('SELECT annual_entitlement FROM hr_leave_types WHERE id = ?')
    .get(leave_type_id) as { annual_entitlement: number } | undefined;
  const entitled = Number(type?.annual_entitlement) || 0;
  return { entitled, taken: 0, adjusted: 0, available: entitled };
}

/* ------------------------------------------------------------------ *
 * Applying an approval
 * ------------------------------------------------------------------ */

/**
 * Spend an approved request against its balance: bump `taken` by
 * request.days on the (employee, type, year-of-from_date) row, seeding the
 * row first if this is the year's first touch.
 *
 * MUST be called INSIDE the caller's db.transaction(), in the same unit as
 * the hr_leave_requests status flip to 'approved' — this function
 * deliberately opens no transaction of its own, so approval + spend commit
 * or roll back together. Unpaid types are bumped too: the register records
 * days actually taken; sufficiency was a validation-time, paid-only concern.
 */
export function applyApprovedLeave(
  db: Database.Database,
  request: Pick<HrLeaveRequest, 'employee_id' | 'leave_type_id' | 'from_date' | 'days'>,
): void {
  const year = leaveYearOf(request.from_date);
  ensureBalanceRow(db, request.employee_id, request.leave_type_id, year);
  db.prepare(
    `UPDATE hr_leave_balances SET taken = taken + ?
     WHERE employee_id = ? AND leave_type_id = ? AND year = ?`,
  ).run(Number(request.days) || 0, request.employee_id, request.leave_type_id, year);
}

/* ------------------------------------------------------------------ *
 * Request validation
 * ------------------------------------------------------------------ */

/** What validateRequest needs to see of a leave request (create or re-check). */
export interface LeaveRequestInput {
  /** hr_employees.id — never users.id, never an email. */
  employee_id: string;
  /** hr_leave_types.id. */
  leave_type_id: string;
  /** YYYY-MM-DD. */
  from_date: string;
  /** YYYY-MM-DD (inclusive). */
  to_date: string;
  /** Chargeable days; 0.5 supported; may be less than the calendar span. */
  days: number;
  /**
   * When re-validating an EXISTING request (approve time), its own id — so
   * the overlap scan does not refuse the request for colliding with itself,
   * and a now-inactive leave type is accepted (it was active at request
   * time; deactivation must not strand pending requests). Omit on create.
   */
  exclude_request_id?: string;
}

/**
 * Validate a leave request before INSERT (and again before approve — pending
 * requests race each other for the same balance, so the approve handler
 * re-checks with exclude_request_id set).
 *
 * Returns a HUMAN error string for the route to send as a 400/409 message,
 * or null when the request is acceptable. Checks, in order:
 *
 *  1. the referenced employee exists (named message per the CREATE rule);
 *  2. dates are real YYYY-MM-DD values and from_date <= to_date;
 *  3. days > 0 and days does not exceed the inclusive calendar span;
 *  4. the leave type exists and is active (the active test is create-only:
 *     with exclude_request_id set, an inactive type is accepted);
 *  5. the type's max_consecutive_days cap (0 = uncapped) against the span;
 *  6. no overlap with the employee's existing pending/approved requests
 *     (ANY type — one person cannot be on two leaves at once);
 *  7. for PAID types only: available balance in the from_date year covers
 *     the requested days (unpaid/LOP types skip this and may go negative).
 *
 * Read-only: never writes, never seeds balance rows.
 */
export function validateRequest(db: Database.Database, req: LeaveRequestInput): string | null {
  const employee_id = String(req.employee_id ?? '').trim();
  const leave_type_id = String(req.leave_type_id ?? '').trim();
  const from_date = String(req.from_date ?? '').trim();
  const to_date = String(req.to_date ?? '').trim();
  const days = Number(req.days);

  // 1. Referenced employee must exist (LEFT-JOIN tolerance is for READS;
  //    creating against a missing employee is a named 400).
  if (!employee_id) return 'Employee is required';
  const emp = db.prepare('SELECT id FROM hr_employees WHERE id = ?').get(employee_id);
  if (!emp) return 'Selected employee was not found';

  // 2. Dates sane.
  if (!isValidYmd(from_date)) return 'From date must be a valid date (YYYY-MM-DD)';
  if (!isValidYmd(to_date)) return 'To date must be a valid date (YYYY-MM-DD)';
  if (from_date > to_date) return 'To date cannot be before the from date';

  // 3. Days sane. The span is the ceiling: 5 chargeable days cannot fit in a
  //    2-day range (half days mean days may be LESS than the span, never more).
  if (!Number.isFinite(days) || days <= 0) return 'Leave days must be greater than zero';
  const span = inclusiveSpanDays(from_date, to_date);
  if (days > span) {
    return `Leave days (${days}) cannot exceed the selected date range (${span} day${span === 1 ? '' : 's'})`;
  }

  // 4. Leave type exists and is active. The is_active refusal applies to NEW
  //    requests only: at approve time (exclude_request_id set — re-validating
  //    an EXISTING pending request) a now-inactive type is ACCEPTED, because
  //    it was active when the request was filed and deactivation only hides
  //    the type from pickers (the types route's documented contract) — it
  //    must not strand already-pending requests un-approvable.
  const type = db
    .prepare(
      `SELECT id, name, annual_entitlement, max_consecutive_days, is_paid, is_active
       FROM hr_leave_types WHERE id = ?`,
    )
    .get(leave_type_id) as
    | Pick<HrLeaveType, 'id' | 'name' | 'annual_entitlement' | 'max_consecutive_days' | 'is_paid' | 'is_active'>
    | undefined;
  if (!type) return 'Selected leave type was not found';
  if (!type.is_active && !String(req.exclude_request_id ?? '').trim()) {
    return 'That leave type is inactive';
  }

  // 5. Consecutive-days cap (0 = no cap) — judged on the calendar span.
  const maxRun = Number(type.max_consecutive_days) || 0;
  if (maxRun > 0 && span > maxRun) {
    return `${type.name} allows at most ${maxRun} consecutive day${maxRun === 1 ? '' : 's'} (requested ${span})`;
  }

  // 6. Overlap with the employee's own pending/approved requests, ANY type.
  //    Two closed [from, to] ranges intersect iff a.from <= b.to AND
  //    a.to >= b.from — plain string compare is safe on YYYY-MM-DD.
  const clash = db
    .prepare(
      `SELECT status, from_date, to_date FROM hr_leave_requests
       WHERE employee_id = ?
         AND status IN ('pending', 'approved')
         AND from_date <= ? AND to_date >= ?
         AND id <> ?
       ORDER BY from_date LIMIT 1`,
    )
    .get(employee_id, to_date, from_date, String(req.exclude_request_id ?? '')) as
    | { status: string; from_date: string; to_date: string }
    | undefined;
  if (clash) {
    return `Overlaps an existing ${clash.status} leave request (${clash.from_date} to ${clash.to_date})`;
  }

  // 7. Balance sufficiency — PAID types only. Bucket = the from_date year.
  if (type.is_paid) {
    const bal = balanceOf(db, employee_id, leave_type_id, leaveYearOf(from_date));
    if (bal.available < days) {
      return `Insufficient ${type.name} balance: ${bal.available} day${bal.available === 1 ? '' : 's'} available, ${days} requested`;
    }
  }

  return null;
}
