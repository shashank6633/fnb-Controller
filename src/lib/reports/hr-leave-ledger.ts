/**
 * HR Leave Ledger — one row per employee x leave type, merging the yearly
 * balance (hr_leave_balances) with request activity in [from, to]
 * (hr_leave_requests).
 *
 * Same file contract as category-summary.ts: exports COLUMNS + run(db,
 * outletId, from, to); SQL aggregation, r2 rounding. Consumed by the
 * /api/hr/reports dispatcher (canManageHr-gated — /hr/reports is mgmtOnly).
 *
 * Row membership is the UNION of both sources, so the ledger never hides
 * anyone: an employee with a balance row but no requests shows with zero
 * activity, and an employee whose requests predate any balance seeding shows
 * with a zero balance. Balances are summed over every year the range spans
 * (year BETWEEN substr(from,1,4) AND substr(to,1,4)); a request counts as
 * "in range" when its [from_date, to_date] span OVERLAPS [from, to].
 *
 * Backend-mapping rules honoured (docs/HRMS_DECISIONS.md, Phases 3-7 block):
 *  - employee_id -> hr_employees.id, leave_type_id -> hr_leave_types.id;
 *    both names come from LEFT JOINs so a dangling id degrades to a blank
 *    label, never to a dropped row.
 *  - balance is COMPUTED (entitled + adjusted - taken), never stored —
 *    matching the HrLeaveBalance contract in src/lib/hr.ts.
 *  - Leave tables carry no outlet_id; outlet leniency rides the employee's
 *    home_outlet_id (match, legacy blank '', or NULL for a dangling id).
 *  - approved/pending sums use the hr_leave_requests status vocabulary from
 *    src/lib/hr.ts (HR_LEAVE_STATUSES); requests_in_range counts every
 *    status so rejected/cancelled activity is still visible in the count.
 */
import type Database from 'better-sqlite3';

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export interface Row {
  employee_code: string;
  full_name: string;
  leave_type: string;
  entitled: number;
  adjusted: number;
  taken: number;
  balance: number;
  approved_days_in_range: number;
  pending_days_in_range: number;
  requests_in_range: number;
}

export const COLUMNS: { k: string; label: string; num?: boolean; money?: boolean; pct?: boolean; date?: boolean; wide?: boolean }[] = [
  { k: 'employee_code', label: 'Code' },
  { k: 'full_name', label: 'Employee' },
  { k: 'leave_type', label: 'Leave Type' },
  { k: 'entitled', label: 'Entitled', num: true },
  { k: 'adjusted', label: 'Adjusted', num: true },
  { k: 'taken', label: 'Taken', num: true },
  { k: 'balance', label: 'Balance', num: true },
  { k: 'approved_days_in_range', label: 'Approved Days (Range)', num: true },
  { k: 'pending_days_in_range', label: 'Pending Days (Range)', num: true },
  { k: 'requests_in_range', label: 'Requests (Range)', num: true },
];

export function run(db: Database.Database, outletId: string | null, from: string, to: string): Row[] {
  // hr_leave_balances.year is '2026'-style TEXT; a YYYY-MM-DD range spans
  // whole years, so balances are summed across every year it touches.
  const yFrom = from.slice(0, 4);
  const yTo = to.slice(0, 4);

  const rows = db.prepare(`
    WITH keys AS (
      SELECT employee_id, leave_type_id FROM hr_leave_balances
       WHERE year BETWEEN ? AND ?
      UNION
      SELECT employee_id, leave_type_id FROM hr_leave_requests
       WHERE from_date <= ? AND to_date >= ?
    ),
    bal AS (
      SELECT employee_id, leave_type_id,
             SUM(COALESCE(entitled, 0)) AS entitled,
             SUM(COALESCE(taken, 0))    AS taken,
             SUM(COALESCE(adjusted, 0)) AS adjusted
      FROM hr_leave_balances
      WHERE year BETWEEN ? AND ?
      GROUP BY employee_id, leave_type_id
    ),
    req AS (
      SELECT employee_id, leave_type_id,
             SUM(CASE WHEN status = 'approved' THEN COALESCE(days, 0) ELSE 0 END) AS approved_days,
             SUM(CASE WHEN status = 'pending'  THEN COALESCE(days, 0) ELSE 0 END) AS pending_days,
             COUNT(*) AS requests
      FROM hr_leave_requests
      WHERE from_date <= ? AND to_date >= ?
      GROUP BY employee_id, leave_type_id
    )
    SELECT
      COALESCE(e.employee_code, '') AS employee_code,
      COALESCE(e.full_name, '')     AS full_name,
      COALESCE(lt.name, '')         AS leave_type,
      COALESCE(b.entitled, 0)       AS entitled,
      COALESCE(b.adjusted, 0)       AS adjusted,
      COALESCE(b.taken, 0)          AS taken,
      COALESCE(b.entitled, 0) + COALESCE(b.adjusted, 0) - COALESCE(b.taken, 0) AS balance,
      COALESCE(r.approved_days, 0)  AS approved_days_in_range,
      COALESCE(r.pending_days, 0)   AS pending_days_in_range,
      COALESCE(r.requests, 0)       AS requests_in_range
    FROM keys k
    LEFT JOIN bal b ON b.employee_id = k.employee_id AND b.leave_type_id = k.leave_type_id
    LEFT JOIN req r ON r.employee_id = k.employee_id AND r.leave_type_id = k.leave_type_id
    LEFT JOIN hr_employees e   ON e.id  = k.employee_id
    LEFT JOIN hr_leave_types lt ON lt.id = k.leave_type_id
    WHERE (e.home_outlet_id = COALESCE(?, '') OR e.home_outlet_id = '' OR e.home_outlet_id IS NULL)
    ORDER BY full_name COLLATE NOCASE, leave_type COLLATE NOCASE, k.employee_id
  `).all(yFrom, yTo, to, from, yFrom, yTo, to, from, outletId) as any[];

  return rows.map((r) => ({
    employee_code: String(r.employee_code),
    full_name: String(r.full_name),
    leave_type: String(r.leave_type),
    entitled: r2(r.entitled),
    adjusted: r2(r.adjusted),
    taken: r2(r.taken),
    balance: r2(r.balance),
    approved_days_in_range: r2(r.approved_days_in_range),
    pending_days_in_range: r2(r.pending_days_in_range),
    requests_in_range: r2(r.requests_in_range),
  }));
}
