/**
 * HR Payroll Register — one row per employee per payroll run, over the runs
 * whose period ('2026-09'-style) falls inside the months spanned by
 * [from, to].
 *
 * Same file contract as category-summary.ts: exports COLUMNS + run(db,
 * outletId, from, to); SQL aggregation, r2 rounding.
 *
 * SALARY DATA — the /api/hr/reports dispatcher gates THIS report on
 * canAdminHr on top of its canManageHr module gate (contract §2.2: payroll
 * is an adminOnly surface; canViewSalary is admin-only to start). Nothing
 * here may be reachable by a plain manager.
 *
 * Backend-mapping rules honoured (docs/HRMS_DECISIONS.md, Phases 3-7 block):
 *  - run_id -> hr_payroll_runs.id: an INNER JOIN, because the period filter
 *    lives on the run — an orphaned item has no period and can never match a
 *    month range, so the join drops nothing the filter would have kept.
 *  - employee_id -> hr_employees.id via LEFT JOIN; a dangling id degrades to
 *    a blank name/code, never to a dropped payslip line.
 *  - hr_payroll_items is an append-only ledger of FROZEN compute results —
 *    this report only reads gross/net as stored; it never recomputes.
 *  - Draft runs are included and labelled (run_status via the
 *    payrollRunStatusMeta vocabulary from src/lib/hr.ts) so a register pulled
 *    mid-cycle is honest about which figures are not yet final.
 *  - Outlet-lenient on the RUN's outlet_id: match, or the legacy blank ''.
 */
import type Database from 'better-sqlite3';
import { payrollRunStatusMeta } from '../hr';

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export interface Row {
  period: string;
  run_status: string;
  employee_code: string;
  full_name: string;
  department: string;
  paid_days: number;
  lop_days: number;
  ot_hours: number;
  gross: number;
  net: number;
}

export const COLUMNS: { k: string; label: string; num?: boolean; money?: boolean; pct?: boolean; date?: boolean; wide?: boolean }[] = [
  { k: 'period', label: 'Period' },
  { k: 'run_status', label: 'Run Status' },
  { k: 'employee_code', label: 'Code' },
  { k: 'full_name', label: 'Employee' },
  { k: 'department', label: 'Department' },
  { k: 'paid_days', label: 'Paid Days', num: true },
  { k: 'lop_days', label: 'LOP Days', num: true },
  { k: 'ot_hours', label: 'OT Hrs', num: true },
  { k: 'gross', label: 'Gross', money: true },
  { k: 'net', label: 'Net', money: true },
];

export function run(db: Database.Database, outletId: string | null, from: string, to: string): Row[] {
  // hr_payroll_runs.period is 'YYYY-MM'; the YYYY-MM-DD range collapses to
  // the months it spans ('2026-08-05'..'2026-09-20' -> '2026-08'..'2026-09').
  const pFrom = from.slice(0, 7);
  const pTo = to.slice(0, 7);

  const rows = db.prepare(`
    SELECT
      r.period,
      r.status                      AS run_status,
      COALESCE(e.employee_code, '') AS employee_code,
      COALESCE(e.full_name, '')     AS full_name,
      COALESCE(d.name, '')          AS department,
      COALESCE(i.paid_days, 0)        AS paid_days,
      COALESCE(i.lop_days, 0)         AS lop_days,
      COALESCE(i.overtime_minutes, 0) AS overtime_minutes,
      COALESCE(i.gross, 0)            AS gross,
      COALESCE(i.net, 0)              AS net
    FROM hr_payroll_items i
    JOIN hr_payroll_runs r  ON r.id = i.run_id
    LEFT JOIN hr_employees e ON e.id = i.employee_id
    LEFT JOIN departments d  ON d.id = e.department_id
    WHERE r.period BETWEEN ? AND ?
      AND (r.outlet_id = COALESCE(?, '') OR r.outlet_id = '')
    ORDER BY r.period, full_name COLLATE NOCASE, i.employee_id
  `).all(pFrom, pTo, outletId) as any[];

  return rows.map((r) => ({
    period: String(r.period),
    run_status: payrollRunStatusMeta(r.run_status).label,
    employee_code: String(r.employee_code),
    full_name: String(r.full_name),
    department: String(r.department),
    paid_days: r2(r.paid_days),
    lop_days: r2(r.lop_days),
    ot_hours: r2((Number(r.overtime_minutes) || 0) / 60),
    gross: r2(r.gross),
    net: r2(r.net),
  }));
}
