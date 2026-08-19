/**
 * HR Headcount — one row per department over hr_employees.
 *
 * Same file contract as category-summary.ts: exports COLUMNS + run(db,
 * outletId, from, to); SQL aggregation, r2 rounding. Consumed by the
 * /api/hr/reports dispatcher (canManageHr-gated — /hr/reports is mgmtOnly).
 *
 * Semantics (documented so the numbers can be defended):
 *  - On-roll and the per-status columns are a CURRENT snapshot: they count
 *    employees by their status TODAY, using the src/lib/hr.ts status
 *    vocabulary. On-roll = active + probation + confirmed + notice_period +
 *    suspended (a suspended employee is still on the rolls — §8.4b only
 *    blocks punching); exit statuses (resigned/terminated/former) are
 *    excluded from on-roll but still counted in total_employees.
 *  - joined_in_range / exited_in_range use the [from, to] dates against
 *    joining_date / exit_date (blank dates never match), across employees of
 *    EVERY status — someone who joined and left inside the range counts in
 *    both.
 *
 * Backend-mapping rules honoured (docs/HRMS_DECISIONS.md, Phases 3-7 block):
 *  - department_id -> departments.id via LEFT JOIN; a blank or dangling id
 *    buckets under 'Unassigned', never drops the people.
 *  - Outlet-lenient on home_outlet_id (the employment assignment): match,
 *    or the legacy blank ''.
 */
import type Database from 'better-sqlite3';

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export interface Row {
  department: string;
  on_roll: number;
  active: number;
  probation: number;
  confirmed: number;
  notice_period: number;
  suspended: number;
  joined_in_range: number;
  exited_in_range: number;
  total_employees: number;
}

export const COLUMNS: { k: string; label: string; num?: boolean; money?: boolean; pct?: boolean; date?: boolean; wide?: boolean }[] = [
  { k: 'department', label: 'Department' },
  { k: 'on_roll', label: 'On Roll', num: true },
  { k: 'active', label: 'Active', num: true },
  { k: 'probation', label: 'Probation', num: true },
  { k: 'confirmed', label: 'Confirmed', num: true },
  { k: 'notice_period', label: 'Notice Period', num: true },
  { k: 'suspended', label: 'Suspended', num: true },
  { k: 'joined_in_range', label: 'Joined (Range)', num: true },
  { k: 'exited_in_range', label: 'Exited (Range)', num: true },
  { k: 'total_employees', label: 'Total Records', num: true },
];

export function run(db: Database.Database, outletId: string | null, from: string, to: string): Row[] {
  const rows = db.prepare(`
    SELECT
      COALESCE(d.name, 'Unassigned') AS department,
      SUM(CASE WHEN e.status IN ('active','probation','confirmed','notice_period','suspended') THEN 1 ELSE 0 END) AS on_roll,
      SUM(CASE WHEN e.status = 'active' THEN 1 ELSE 0 END)        AS active,
      SUM(CASE WHEN e.status = 'probation' THEN 1 ELSE 0 END)     AS probation,
      SUM(CASE WHEN e.status = 'confirmed' THEN 1 ELSE 0 END)     AS confirmed,
      SUM(CASE WHEN e.status = 'notice_period' THEN 1 ELSE 0 END) AS notice_period,
      SUM(CASE WHEN e.status = 'suspended' THEN 1 ELSE 0 END)     AS suspended,
      SUM(CASE WHEN e.joining_date != '' AND e.joining_date BETWEEN ? AND ? THEN 1 ELSE 0 END) AS joined_in_range,
      SUM(CASE WHEN e.exit_date != '' AND e.exit_date BETWEEN ? AND ? THEN 1 ELSE 0 END)       AS exited_in_range,
      COUNT(*) AS total_employees
    FROM hr_employees e
    LEFT JOIN departments d ON d.id = e.department_id
    WHERE (e.home_outlet_id = COALESCE(?, '') OR e.home_outlet_id = '')
    GROUP BY department
    ORDER BY on_roll DESC, department COLLATE NOCASE
  `).all(from, to, from, to, outletId) as any[];

  return rows.map((r) => ({
    department: String(r.department),
    on_roll: r2(r.on_roll),
    active: r2(r.active),
    probation: r2(r.probation),
    confirmed: r2(r.confirmed),
    notice_period: r2(r.notice_period),
    suspended: r2(r.suspended),
    joined_in_range: r2(r.joined_in_range),
    exited_in_range: r2(r.exited_in_range),
    total_employees: r2(r.total_employees),
  }));
}
