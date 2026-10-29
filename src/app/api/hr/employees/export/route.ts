import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { canManageHr } from '@/lib/hr';
import { todayIST } from '@/lib/format-date';
import { reportServerError } from '@/lib/error-alerts';

/**
 * HR Employee CSV export (/api/hr/employees/export) — owner ruling 92:
 * "Yes, same columns as import".
 *
 * GET ?status=active|all
 *   active → hr_employees.status = 'active' (the list page's "Active" chip)
 *   all    → every status (probation, notice period, resigned, former, …)
 *   anything else → 400
 *   → text/csv attachment: UTF-8 BOM, RFC-4180 quoting, CRLF rows.
 *
 * COLUMNS: EXACTLY the bulk-upload template, in its order (IMPORT_COLUMNS in
 * src/app/hr/employees/page.tsx; the import route's CANONICAL_BY_BARE in
 * src/app/api/hr/employees/import/route.ts reads them), then `status`.
 * Values are written the way the import reads them: phones as stored
 * (phone10 / alt_phone10 / emergency_phone10), department / sub_department /
 * designation by NAME (the import matches names, never ids), dates as stored
 * (YYYY-MM-DD: the HR forms use date inputs and the import normalises to it;
 * the APIs do not re-validate, so a value stored any other way is exported
 * verbatim and the import flags that row), employment_type and gender as
 * their vocab keys, the two integer columns as integers. A
 * dangling or empty reference exports as an empty cell (LEFT JOIN — the
 * employee row is never hidden). `status` is NOT an import column: the import
 * ignores it with an "Unknown column" warning and imports every row as active.
 *
 * THE ONE PLACE A VALUE IS NOT WRITTEN AS STORED: the formula guard below.
 * A cell starting with = + - @ is written with a leading ' — including a
 * non-India phone the PhoneField stored with its '+' ("+44 7911 123456").
 * The import does not strip that ': it keeps the text for names/notes, and
 * for a phone its normPhone (no leading '+') keeps only the last 10 digits.
 * Such cells need the ' removed before the file is uploaded again.
 *
 * DELIBERATELY ABSENT: photo, salary, bank, PAN, Aadhaar, documents, login
 * link, reporting manager, outlet, ids. The SELECT below names every column
 * the file can carry — nothing reaches the file by a `*`.
 *
 * Gate: canManageHr — the SAME check GET /api/hr/employees uses to read the
 * list (route.ts there). The proxy does NOT protect API GETs (HRMS_DECISIONS
 * §2.1); this handler is the boundary. 401 signed out, 403 otherwise. Errors
 * return GENERIC messages only (e.message can leak schema/PII for HR data).
 *
 * Audit: ONE hr.employee.export event per download (actor, status filter,
 * rows written, total matched, truncated flag).
 */
export const dynamic = 'force-dynamic';

/** The bulk-upload template columns, in template order (page.tsx IMPORT_COLUMNS),
 *  then status. Duplicated by necessity: the template lives in a 'use client'
 *  page a server route cannot import from. */
const EXPORT_COLUMNS = [
  'full_name', 'employee_code', 'phone', 'alt_phone', 'email', 'gender', 'dob',
  'joining_date', 'department', 'sub_department', 'designation', 'grade',
  'employment_type', 'employee_category', 'cost_centre', 'work_location',
  'probation_months', 'notice_period_days', 'emergency_name',
  'emergency_relation', 'emergency_phone', 'current_address',
  'permanent_address', 'notes',
  'status',
] as const;

type ExportRow = Record<(typeof EXPORT_COLUMNS)[number], string | number | null>;

/** Row cap — the same figure and reasoning as the HR Reports CSV
 *  (src/app/api/hr/reports/route.ts CSV_ROW_CAP): far above any venue's
 *  headcount, but a cap beats an open-ended string build on the 1 GB box. */
const CSV_ROW_CAP = 20_000;

/**
 * Copied VERBATIM from src/app/api/hr/reports/route.ts (csvCell): RFC-4180
 * escaping PLUS the spreadsheet formula-injection guard (CWE-1236) — a cell
 * starting with = + - @ TAB or CR executes in Excel/Sheets, so it is prefixed
 * with a quote. Not imported: route files must not export helpers. No column
 * here opts out (`numeric` is never passed): the only numeric columns are
 * probation_months / notice_period_days, which are never negative, so the
 * guard cannot touch them.
 */
const csvCell = (v: unknown, numeric = false): string => {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (!numeric && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canManageHr(me)) {
      return Response.json({ error: 'Management access required' }, { status: 403 });
    }

    const statusFilter = String(new URL(request.url).searchParams.get('status') || '');
    if (statusFilter !== 'active' && statusFilter !== 'all') {
      return Response.json({ error: 'status must be active or all' }, { status: 400 });
    }

    const db = getDb();
    const where = statusFilter === 'active' ? `WHERE e.status = 'active'` : '';

    const total = (db
      .prepare(`SELECT COUNT(*) AS n FROM hr_employees e ${where}`)
      .get() as { n: number }).n;

    // Every column the file can carry is named here. Sort = the list page's.
    const rows = db
      .prepare(
        `SELECT e.full_name, e.employee_code,
                e.phone10 AS phone, e.alt_phone10 AS alt_phone, e.email,
                e.gender, e.dob, e.joining_date,
                d.name AS department, sd.name AS sub_department, ds.name AS designation,
                e.grade, e.employment_type, e.employee_category, e.cost_centre,
                e.work_location, e.probation_months, e.notice_period_days,
                e.emergency_name, e.emergency_relation,
                e.emergency_phone10 AS emergency_phone,
                e.current_address, e.permanent_address, e.notes, e.status
           FROM hr_employees e
           LEFT JOIN departments d      ON d.id  = e.department_id
           LEFT JOIN departments sd     ON sd.id = e.sub_department_id
           LEFT JOIN hr_designations ds ON ds.id = e.designation_id
           ${where}
          ORDER BY e.full_name COLLATE NOCASE, e.id
          LIMIT ?`,
      )
      .all(CSV_ROW_CAP) as ExportRow[];

    const lines: string[] = [EXPORT_COLUMNS.map((c) => csvCell(c)).join(',')];
    for (const r of rows) lines.push(EXPORT_COLUMNS.map((c) => csvCell(r[c])).join(','));
    const truncated = total > rows.length;
    if (truncated) {
      // In-file, like the HR Reports CSV — a truncated export that looks
      // complete would be read as the whole roster. full_name is left BLANK
      // so the bulk import rejects this line ("Missing full_name") instead of
      // creating an employee named after the warning.
      lines.push(['', csvCell(
        `TRUNCATED: showing first ${rows.length} of ${total} ${statusFilter === 'active' ? 'active ' : ''}employees - this file is not the complete list`,
      )].join(','));
    }

    const outletId = await getCurrentOutletId();
    logAuditEvent(db, {
      event_type: 'hr.employee.export',
      entity_type: 'hr_employee_export',
      entity_id: generateId(),
      actor_email: me.email,
      outlet_id: outletId || null,
      after: { status_filter: statusFilter, rows: rows.length, total, truncated },
    });

    // The BOM makes Excel read the file as UTF-8 (the import strips it).
    const csv = '﻿' + lines.join('\r\n') + '\r\n';
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="employees-${statusFilter}_${todayIST()}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    console.error('[/api/hr/employees/export]', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to export employees' }, { status: 500 });
  }
}
