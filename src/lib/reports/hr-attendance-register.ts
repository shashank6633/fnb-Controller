/**
 * HR Attendance Register — one row per employee, aggregated over the range
 * [from, to] of IST business dates.
 *
 * Same file contract as category-summary.ts: exports COLUMNS + run(db,
 * outletId, from, to); SQL aggregation, r2 rounding. Consumed by the
 * /api/hr/reports dispatcher (canManageHr-gated — /hr/reports is mgmtOnly),
 * which sweeps stale open days (sweepStaleOpenDays) BEFORE calling run(), so
 * Missing Checkouts here are current even if nobody opened /hr/attendance.
 *
 * Column semantics (rebuilt 2026-08-19, verify-fleet finding: the old
 * status-key columns LATE/HALF_DAY/ON_LEAVE/ABSENT read fields nothing wrote):
 *  - Present          = business days with any punch-in (first_in != '') —
 *    LATE / MISSING_CHECKOUT days are still presence, so Present ⊇ Late Days.
 *  - Late Days        = days the engine's shift-aware close verdict is 'LATE'
 *    (recomputeDay vs the rostered shift's start + late_after_minutes).
 *  - Missing Checkouts = SUM of the 0/1 flag — set only after the business
 *    day closes; the engine never invents a checkout time (§8.2.5).
 *  - Leave Days       = approved hr_leave_requests overlapping the range,
 *    each clamped to min(recorded days, overlapping calendar days) — the
 *    same clamp hr-payroll.ts uses, so fractional (0.5) leave stays honest.
 *  - Absent Days      = rostered days (hr_rosters) in range with NO
 *    hr_attendance summary row for that employee-day. Derived, not a stored
 *    status. The NOT EXISTS check is outlet-blind on purpose: a summary row
 *    anywhere means the day happened. (Leave and Absent come from different
 *    sources — clear the roster for approved leave to keep them disjoint.)
 *  - Worked/Break/OT hours = SUM(minutes)/60 rounded to 2dp;
 *    overtime_minutes is the engine's shift-aware excess (§8.2.6).
 *
 * Row membership is the UNION of the three sources (attendance rows in range,
 * rostered days in range, approved leave overlapping the range), so an
 * employee who never punched still shows their absent/leave days. Outlet
 * leniency: attendance rows match the caller's outlet OR the legacy blank ''
 * (hr_ tables default outlet_id to ''); roster/leave carry no outlet, so
 * roster/leave-only rows ride the employee's home_outlet_id (match, blank,
 * or NULL for a dangling id) — the hr-leave-ledger.ts convention.
 *
 * Backend-mapping rules honoured (docs/HRMS_DECISIONS.md, Phases 3-7 block):
 *  - employee_id is ALWAYS hr_employees.id — names come from a LEFT JOIN, so
 *    a dangling id degrades to a blank name/code, never a dropped row.
 *  - hr_attendance is the COMPUTED business-day summary; this report only
 *    READS it — the events remain the truth; nothing here writes anything.
 */
import type Database from 'better-sqlite3';

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

// ASSERTION: COLUMNS[].k below matches the keys of Row EXACTLY (same names,
// same order) — the dispatcher renders/CSV-exports rows by COLUMNS[].k, so a
// drifted key silently blanks a column. Change them together.
export interface Row {
  employee_code: string;
  full_name: string;
  department: string;
  days_present: number;
  late_days: number;
  missing_checkouts: number;
  leave_days: number;
  absent_days: number;
  worked_hours: number;
  break_hours: number;
  overtime_hours: number;
}

export const COLUMNS: { k: string; label: string; num?: boolean; money?: boolean; pct?: boolean; date?: boolean; wide?: boolean }[] = [
  { k: 'employee_code', label: 'Code' },
  { k: 'full_name', label: 'Employee' },
  { k: 'department', label: 'Department' },
  { k: 'days_present', label: 'Present', num: true },
  { k: 'late_days', label: 'Late Days', num: true },
  { k: 'missing_checkouts', label: 'Missing Checkouts', num: true },
  { k: 'leave_days', label: 'Leave Days', num: true },
  { k: 'absent_days', label: 'Absent Days', num: true },
  { k: 'worked_hours', label: 'Worked Hrs', num: true },
  { k: 'break_hours', label: 'Break Hrs', num: true },
  { k: 'overtime_hours', label: 'OT Hrs', num: true },
];

export function run(db: Database.Database, outletId: string | null, from: string, to: string): Row[] {
  const rows = db.prepare(`
    WITH att AS (
      SELECT employee_id,
             SUM(CASE WHEN first_in != '' THEN 1 ELSE 0 END)  AS days_present,
             SUM(CASE WHEN status = 'LATE' THEN 1 ELSE 0 END) AS late_days,
             SUM(COALESCE(missing_checkout, 0)) AS missing_checkouts,
             SUM(COALESCE(worked_minutes, 0))   AS worked_minutes,
             SUM(COALESCE(break_minutes, 0))    AS break_minutes,
             SUM(COALESCE(overtime_minutes, 0)) AS overtime_minutes
        FROM hr_attendance
       WHERE date BETWEEN ? AND ?
         AND (outlet_id = COALESCE(?, '') OR outlet_id = '')
       GROUP BY employee_id
    ),
    lv AS (
      -- Approved leave clamped per request to min(recorded days, calendar
      -- days overlapping [from, to]) — MIN/MAX here are SQLite's 2-arg
      -- scalars, matching hr-payroll.ts overlapDays + its clamp.
      SELECT employee_id,
             SUM(MIN(COALESCE(days, 0),
                     julianday(MIN(to_date, ?)) - julianday(MAX(from_date, ?)) + 1)) AS leave_days
        FROM hr_leave_requests
       WHERE status = 'approved' AND from_date <= ? AND to_date >= ?
       GROUP BY employee_id
    ),
    ab AS (
      SELECT r.employee_id, COUNT(*) AS absent_days
        FROM hr_rosters r
       WHERE r.date BETWEEN ? AND ?
         AND NOT EXISTS (SELECT 1 FROM hr_attendance a
                          WHERE a.employee_id = r.employee_id AND a.date = r.date)
       GROUP BY r.employee_id
    ),
    keys AS (
      SELECT employee_id FROM att
      UNION SELECT employee_id FROM lv
      UNION SELECT employee_id FROM ab
    )
    SELECT
      COALESCE(e.employee_code, '')    AS employee_code,
      COALESCE(e.full_name, '')        AS full_name,
      COALESCE(d.name, '')             AS department,
      COALESCE(a.days_present, 0)      AS days_present,
      COALESCE(a.late_days, 0)         AS late_days,
      COALESCE(a.missing_checkouts, 0) AS missing_checkouts,
      COALESCE(l.leave_days, 0)        AS leave_days,
      COALESCE(b.absent_days, 0)       AS absent_days,
      COALESCE(a.worked_minutes, 0)    AS worked_minutes,
      COALESCE(a.break_minutes, 0)     AS break_minutes,
      COALESCE(a.overtime_minutes, 0)  AS overtime_minutes
    FROM keys k
    LEFT JOIN att a ON a.employee_id = k.employee_id
    LEFT JOIN lv  l ON l.employee_id = k.employee_id
    LEFT JOIN ab  b ON b.employee_id = k.employee_id
    LEFT JOIN hr_employees e ON e.id = k.employee_id
    LEFT JOIN departments d  ON d.id = e.department_id
    WHERE a.employee_id IS NOT NULL
       OR e.home_outlet_id = COALESCE(?, '') OR e.home_outlet_id = '' OR e.home_outlet_id IS NULL
    ORDER BY full_name COLLATE NOCASE, k.employee_id
  `).all(from, to, outletId, to, from, to, from, from, to, outletId) as any[];

  return rows.map((r) => ({
    employee_code: String(r.employee_code),
    full_name: String(r.full_name),
    department: String(r.department),
    days_present: r2(r.days_present),
    late_days: r2(r.late_days),
    missing_checkouts: r2(r.missing_checkouts),
    leave_days: r2(r.leave_days),
    absent_days: r2(r.absent_days),
    worked_hours: r2((Number(r.worked_minutes) || 0) / 60),
    break_hours: r2((Number(r.break_minutes) || 0) / 60),
    overtime_hours: r2((Number(r.overtime_minutes) || 0) / 60),
  }));
}
