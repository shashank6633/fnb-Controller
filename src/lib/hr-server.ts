/**
 * HRMS — server-side helpers (Phase 1).
 *
 * SERVER ONLY. This module touches the database and must NEVER be imported by
 * client code ('use client' components) — the pure, client-safe contract
 * (vocabularies, badge colors, predicates, row types) lives in ./hr.ts.
 * Contract: docs/HRMS_DECISIONS.md.
 *
 * better-sqlite3 is SYNCHRONOUS: everything here is safe to call inside a
 * db.transaction() callback (no awaits anywhere in this file).
 */

import type Database from 'better-sqlite3';
import type { HrEmployee } from './hr';

/* ------------------------------------------------------------------ *
 * Employee code
 * ------------------------------------------------------------------ */

/**
 * Mint the next HR-issued employee code: 'EMP-' + zero-padded 4-digit
 * sequence (EMP-0001, EMP-0002, ...). Derived from the current MAX over rows
 * matching 'EMP-%' (the PINV pattern from /api/purchases), so deleted rows
 * never cause reuse of a lower number, and hand-entered non-EMP codes (if the
 * column is ever opened up) are simply ignored by the sequence.
 *
 * substr(employee_code, 5) is 1-indexed SQLite: 'EMP-0001' -> '0001'.
 * CAST of a non-numeric tail yields 0 and is harmless under MAX.
 *
 * Call this INSIDE the same db.transaction() as the INSERT that uses it —
 * outside a transaction two concurrent creates could mint the same code and
 * one would then fail the UNIQUE constraint on employee_code.
 */
export function nextEmployeeCode(db: Database.Database): string {
  const last = db
    .prepare(
      `SELECT MAX(CAST(substr(employee_code, 5) AS INTEGER)) AS n
       FROM hr_employees WHERE employee_code LIKE 'EMP-%'`,
    )
    .get() as { n: number | null } | undefined;
  return `EMP-${String((Number(last?.n) || 0) + 1).padStart(4, '0')}`;
}

/* ------------------------------------------------------------------ *
 * Employee list query fragments (shared by list + detail APIs)
 * ------------------------------------------------------------------ */

/** Every hr_employees column EXCEPT photo — the ~250KB base64 blob must never
 *  ride along on list reads (100 rows × 250KB = a 25MB page). */
const HR_EMPLOYEE_COLUMNS = `e.id, e.employee_code, e.full_name, e.dob, e.gender,
         e.phone10, e.alt_phone10, e.email, e.current_address, e.permanent_address,
         e.emergency_name, e.emergency_relation, e.emergency_phone10,
         e.department_id, e.sub_department_id, e.designation_id, e.grade,
         e.reporting_manager_id, e.employment_type, e.employee_category,
         e.cost_centre, e.work_location, e.home_outlet_id, e.joining_date,
         e.probation_months, e.confirmation_date, e.notice_period_days,
         e.status, e.exit_date, e.user_id, e.notes, e.created_by,
         e.created_at, e.updated_at`;

/** The four joined display names + the has_photo flag both projections share. */
const HR_EMPLOYEE_EXTRAS = `CASE WHEN e.photo != '' THEN 1 ELSE 0 END AS has_photo,
         d.name  AS department_name,
         sd.name AS sub_department_name,
         ds.name AS designation_name,
         u.email AS linked_user_email`;

/**
 * LIST projection: the HrEmployeeListRow shape from ./hr.ts MINUS photo, PLUS
 * has_photo (0/1) — the blob itself is only served by the single-employee GET
 * via HR_EMPLOYEE_SELECT_FULL. Compose as:
 *   `${HR_EMPLOYEE_SELECT} ${HR_EMPLOYEE_JOINS} WHERE ...`
 */
export const HR_EMPLOYEE_SELECT = `
  SELECT ${HR_EMPLOYEE_COLUMNS},
         ${HR_EMPLOYEE_EXTRAS}
`;

/**
 * DETAIL projection: same as HR_EMPLOYEE_SELECT but WITH e.photo — for the
 * single-employee GET only (the [id] route), never for lists.
 */
export const HR_EMPLOYEE_SELECT_FULL = `
  SELECT e.photo, ${HR_EMPLOYEE_COLUMNS},
         ${HR_EMPLOYEE_EXTRAS}
`;

/**
 * FROM + LEFT JOINs for the employee list/detail reads. LEFT JOIN throughout:
 * a dangling or '' department_id/designation_id/user_id must never hide the
 * employee row — the joined name just comes back NULL.
 */
export const HR_EMPLOYEE_JOINS = `
  FROM hr_employees e
  LEFT JOIN departments d      ON d.id  = e.department_id
  LEFT JOIN departments sd     ON sd.id = e.sub_department_id
  LEFT JOIN hr_designations ds ON ds.id = e.designation_id
  LEFT JOIN users u            ON u.id  = e.user_id
`;

/**
 * Build the WHERE clause + bind params for GET /api/hr/employees filters.
 * All filters are optional; with none, returns { where: '', params: [] }.
 *
 *  - q             : matched (LIKE, case-insensitive per SQLite default on
 *                    ASCII) against full_name, employee_code, phone10, email.
 *  - department_id : matches the MAIN department OR the sub-department, so a
 *                    picker sending a child departments.id still finds its
 *                    people.
 *  - status        : exact match on hr_employees.status. Callers validate
 *                    against the vocab (isHrEmployeeStatus in ./hr.ts) BEFORE
 *                    calling if they want a 400 on garbage; an unknown value
 *                    here simply matches nothing.
 *
 * Use the SAME return values for both the page query and its COUNT(*) — the
 * crm-calls pagination convention requires the WHERE to be identical.
 */
export function employeeListWhere(filters: {
  q?: string | null;
  department_id?: string | null;
  status?: string | null;
}): { where: string; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  const q = String(filters.q ?? '').trim();
  if (q) {
    const like = `%${q}%`;
    clauses.push(
      '(e.full_name LIKE ? OR e.employee_code LIKE ? OR e.phone10 LIKE ? OR e.email LIKE ?)',
    );
    params.push(like, like, like, like);
  }

  const dept = String(filters.department_id ?? '').trim();
  if (dept) {
    clauses.push('(e.department_id = ? OR e.sub_department_id = ?)');
    params.push(dept, dept);
  }

  const status = String(filters.status ?? '').trim();
  if (status) {
    clauses.push('e.status = ?');
    params.push(status);
  }

  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/* ------------------------------------------------------------------ *
 * Row normalisation
 * ------------------------------------------------------------------ */

/**
 * Normalise a raw hr_employees row (or a joined list row — extra keys pass
 * through untouched) into the HrEmployee contract shape: the two INTEGER
 * columns come back as numbers, and user_id is null (never '' / undefined)
 * when no login is linked. better-sqlite3 already returns TEXT as string and
 * NULL as null, so everything else passes through as-is.
 */
export function rowToEmployee<T extends Record<string, unknown>>(row: T): T & HrEmployee {
  return {
    ...row,
    probation_months: Number((row as Record<string, unknown>).probation_months) || 0,
    notice_period_days: Number((row as Record<string, unknown>).notice_period_days) || 0,
    user_id: ((row as Record<string, unknown>).user_id as string | null | undefined) ?? null,
  } as T & HrEmployee;
}

/**
 * The outlet ids assigned to an employee via hr_employee_outlets, oldest
 * first. This is the `outlets: string[]` field of GET /api/hr/employees/[id].
 */
export function employeeOutletIds(db: Database.Database, employeeId: string): string[] {
  const rows = db
    .prepare(
      `SELECT outlet_id FROM hr_employee_outlets
       WHERE employee_id = ? ORDER BY created_at, id`,
    )
    .all(employeeId) as { outlet_id: string }[];
  return rows.map((r) => r.outlet_id);
}

/**
 * Replace an employee's hr_employee_outlets rows with exactly `outletIds`
 * (de-duplicated, blanks dropped). Call INSIDE the caller's db.transaction()
 * — this helper intentionally does not open its own, so the PUT handler can
 * make the employee UPDATE + outlet replacement one atomic unit.
 *
 * `makeId` is injected (pass generateId from '@/lib/db') so this module adds
 * no import cycle onto db.ts.
 */
export function replaceEmployeeOutlets(
  db: Database.Database,
  employeeId: string,
  outletIds: readonly string[],
  makeId: () => string,
): void {
  db.prepare('DELETE FROM hr_employee_outlets WHERE employee_id = ?').run(employeeId);
  const ins = db.prepare(
    'INSERT INTO hr_employee_outlets (id, employee_id, outlet_id) VALUES (?, ?, ?)',
  );
  const seen = new Set<string>();
  for (const raw of outletIds) {
    const outletId = String(raw ?? '').trim();
    if (!outletId || seen.has(outletId)) continue;
    seen.add(outletId);
    ins.run(makeId(), employeeId, outletId);
  }
}
