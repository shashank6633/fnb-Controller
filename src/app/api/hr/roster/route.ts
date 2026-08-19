/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import {
  canAdminHr,
  canManageHr,
  isHrShiftRequestStatus,
  type HrRoster,
  type HrShiftRequest,
} from '@/lib/hr';
import { todayIST } from '@/lib/format-date';
import { reportServerError } from '@/lib/error-alerts';

/**
 * HR Roster + shift-request subresource (/api/hr/roster) — HRMS Phase 3.
 * Contract: docs/HRMS_DECISIONS.md. Backend mapping rules in force here:
 * employee_id is ALWAYS hr_employees.id, shift_id → hr_shifts.id, actor
 * columns (*_by) are ALWAYS me.email; reads LEFT JOIN to names so a dangling
 * id degrades to blank, never to a dropped row; refs are validated on CREATE.
 *
 * ROSTER (one shift per employee per IST date; UNIQUE(employee_id, date)):
 * GET    ?from=YYYY-MM-DD&to=YYYY-MM-DD&department_id=
 *          → { rows, from, to }   (management tier)
 *        Every hr_rosters row in [from, to] (defaults: today IST → +6 days,
 *        max 92 days) LEFT JOINed to employee (full_name, employee_code) and
 *        shift (name, start/end, split) — the week grid renders from these.
 *        department_id matches the employee's MAIN department OR sub-dept.
 * POST   { employee_id, date, shift_id, note? } → { assignment }
 *          Upsert on UNIQUE(employee_id, date) — assigning over an existing
 *          day replaces the shift. (management tier)
 * POST   { assignments: [{ employee_id, date, shift_id, note? }, ...] }
 *          → { ok, count }. BULK mode: all rows validated up front, then
 *          written in ONE transaction — all or nothing. (management tier)
 * DELETE ?employee_id=&date=   (also accepted as a JSON body)
 *          → { ok: true }. Removes that day's assignment. (management tier)
 *
 * SHIFT REQUESTS (subresource, discriminated by ?requests=1):
 * GET    ?requests=1&status=&page=&pageSize= → { rows, total, page, pageSize }
 *          (management tier) Rows join requester/swap-partner names + shift.
 * POST   ?requests=1 { employee_id, date, requested_shift_id,
 *          swap_with_employee_id?, reason? } → { request }
 *          (management tier) One PENDING request per employee-day (409).
 * PATCH  { id, action: 'approve' | 'reject', review_reason? } → { request }
 *          ADMIN ONLY. Refuses non-pending (409). Approval writes the roster
 *          row IN THE SAME TRANSACTION as the decision; a swap request also
 *          hands the requester's previous shift (when one was rostered) to the
 *          swap partner atomically.
 *
 * Every verb re-authenticates — the proxy does NOT guard API GETs (HRMS §2.1).
 * Error bodies are GENERIC on 500 (never e.message).
 */
export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Inclusive range cap for the grid read — a quarter, far beyond any week view. */
const MAX_RANGE_DAYS = 92;
/** Bulk-assign cap: a week grid for a 100-person venue is 700 rows. */
const MAX_BULK_ASSIGNMENTS = 1000;

/** Trimmed string from any body value ('' for null/undefined). */
function s(v: unknown): string {
  return String(v ?? '').trim();
}

/** date + n days, in pure YYYY-MM-DD string space (UTC arithmetic — no TZ drift). */
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole days from a to b (both YYYY-MM-DD), negative when b < a. */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Exited employees hold history but take no NEW roster/requests. */
const EXITED_STATUSES = new Set(['resigned', 'terminated', 'former']);

type EmployeeRef = { id: string; full_name: string; status: string };

/** hr_employees lookup for ref validation ('' / unknown id → null). */
function findEmployee(db: any, id: string): EmployeeRef | null {
  if (!id) return null;
  return (
    (db
      .prepare(`SELECT id, full_name, status FROM hr_employees WHERE id = ?`)
      .get(id) as EmployeeRef | undefined) ?? null
  );
}

const ROSTER_ROW_SELECT = `
  SELECT r.*,
         e.full_name     AS employee_name,
         e.employee_code AS employee_code,
         s.name          AS shift_name,
         s.start_hhmm    AS shift_start_hhmm,
         s.end_hhmm      AS shift_end_hhmm,
         s.split_json    AS shift_split_json,
         s.is_active     AS shift_is_active
    FROM hr_rosters r
    LEFT JOIN hr_employees e ON e.id = r.employee_id
    LEFT JOIN hr_shifts    s ON s.id = r.shift_id`;

const REQUEST_ROW_SELECT = `
  SELECT q.*,
         e.full_name     AS employee_name,
         e.employee_code AS employee_code,
         w.full_name     AS swap_with_name,
         w.employee_code AS swap_with_code,
         s.name          AS requested_shift_name,
         s.start_hhmm    AS requested_shift_start_hhmm,
         s.end_hhmm      AS requested_shift_end_hhmm
    FROM hr_shift_requests q
    LEFT JOIN hr_employees e ON e.id = q.employee_id
    LEFT JOIN hr_employees w ON w.id = q.swap_with_employee_id
    LEFT JOIN hr_shifts    s ON s.id = q.requested_shift_id`;

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }

  try {
    const sp = new URL(request.url).searchParams;
    const db = getDb();

    /* ── Subresource: shift-request listing (?requests=1) ─────────────── */
    if (sp.get('requests') === '1') {
      const status = s(sp.get('status'));
      if (status && !isHrShiftRequestStatus(status)) {
        return Response.json({ error: 'Invalid request status' }, { status: 400 });
      }

      // parseInt (not Number) so a float can't reach LIMIT/OFFSET and trip
      // SQLite's "datatype mismatch" 500 (the crm-calls convention).
      const page = Math.max(1, parseInt(sp.get('page') || '1', 10) || 1);
      const pageSize = Math.min(100, Math.max(1, parseInt(sp.get('pageSize') || '25', 10) || 25));

      // Shared WHERE — the same clause + params feed the page query and its
      // COUNT(*) so total and rows can never disagree.
      const where = status ? 'WHERE q.status = ?' : '';
      const params: string[] = status ? [status] : [];

      const totalRow = db
        .prepare(`SELECT COUNT(*) AS n FROM hr_shift_requests q ${where}`)
        .get(...params) as { n: number };
      const rows = db
        .prepare(
          `${REQUEST_ROW_SELECT} ${where}
           ORDER BY CASE q.status WHEN 'pending' THEN 0 ELSE 1 END, q.created_at DESC, q.id
           LIMIT ? OFFSET ?`,
        )
        .all(...params, pageSize, (page - 1) * pageSize) as any[];

      return Response.json({ rows, total: totalRow.n, page, pageSize });
    }

    /* ── Roster grid read ─────────────────────────────────────────────── */
    const rawFrom = s(sp.get('from'));
    const rawTo = s(sp.get('to'));
    if (rawFrom && !DATE_RE.test(rawFrom)) {
      return Response.json({ error: 'Invalid from date (expected YYYY-MM-DD)' }, { status: 400 });
    }
    if (rawTo && !DATE_RE.test(rawTo)) {
      return Response.json({ error: 'Invalid to date (expected YYYY-MM-DD)' }, { status: 400 });
    }
    const from = rawFrom || todayIST();
    const to = rawTo || addDays(from, 6); // default: one week grid
    const span = daysBetween(from, to);
    if (span < 0) {
      return Response.json({ error: 'from date must not be after to date' }, { status: 400 });
    }
    if (span > MAX_RANGE_DAYS) {
      return Response.json(
        { error: `Date range too large (max ${MAX_RANGE_DAYS} days)` },
        { status: 400 },
      );
    }

    const clauses = ['r.date >= ?', 'r.date <= ?'];
    const params: string[] = [from, to];
    const departmentId = s(sp.get('department_id'));
    if (departmentId) {
      // Match the employee's MAIN department OR sub-department — the same
      // rule the employee list uses, so the two screens can never disagree.
      clauses.push('(e.department_id = ? OR e.sub_department_id = ?)');
      params.push(departmentId, departmentId);
    }

    const rows = db
      .prepare(
        `${ROSTER_ROW_SELECT}
         WHERE ${clauses.join(' AND ')}
         ORDER BY r.date ASC, e.full_name COLLATE NOCASE ASC, r.id`,
      )
      .all(...params) as any[];

    return Response.json({ rows, from, to });
  } catch (e) {
    console.error('GET /api/hr/roster failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to load roster' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }

  let body: any = {};
  try { body = await request.json(); } catch { /* handled by field checks below */ }

  // better-sqlite3 is synchronous — resolve every await BEFORE db.transaction.
  const outletId = await getCurrentOutletId();
  const isRequests = new URL(request.url).searchParams.get('requests') === '1';

  try {
    const db = getDb();

    /* ── Subresource: create a shift request (?requests=1) ────────────── */
    if (isRequests) {
      const employee_id = s(body?.employee_id);
      const date = s(body?.date);
      const requested_shift_id = s(body?.requested_shift_id);
      const swap_with_employee_id = s(body?.swap_with_employee_id);
      const reason = s(body?.reason);

      if (!employee_id) return Response.json({ error: 'Employee is required' }, { status: 400 });
      if (!DATE_RE.test(date)) {
        return Response.json({ error: 'Invalid date (expected YYYY-MM-DD)' }, { status: 400 });
      }
      if (!requested_shift_id) {
        return Response.json({ error: 'Requested shift is required' }, { status: 400 });
      }

      const employee = findEmployee(db, employee_id);
      if (!employee) return Response.json({ error: 'Employee not found' }, { status: 400 });
      if (EXITED_STATUSES.has(employee.status)) {
        return Response.json(
          { error: 'Employee has exited — shift requests cannot be created' },
          { status: 409 },
        );
      }

      const shift = db
        .prepare(`SELECT id, is_active FROM hr_shifts WHERE id = ?`)
        .get(requested_shift_id) as any;
      if (!shift) return Response.json({ error: 'Requested shift was not found' }, { status: 400 });
      // A NEW intent must target a live template (roster upserts stay
      // tolerant of since-deactivated shifts; fresh requests do not).
      if (!shift.is_active) {
        return Response.json({ error: 'That shift has been deactivated' }, { status: 400 });
      }

      if (swap_with_employee_id) {
        if (swap_with_employee_id === employee_id) {
          return Response.json({ error: 'Swap partner must be a different employee' }, { status: 400 });
        }
        const partner = findEmployee(db, swap_with_employee_id);
        if (!partner) return Response.json({ error: 'Swap partner was not found' }, { status: 400 });
        if (EXITED_STATUSES.has(partner.status)) {
          return Response.json({ error: 'Swap partner has exited' }, { status: 409 });
        }
      }

      // One OPEN request per employee-day (no schema UNIQUE here — decided
      // requests must accumulate as history, so the guard is app-level).
      const open = db
        .prepare(
          `SELECT id FROM hr_shift_requests WHERE employee_id = ? AND date = ? AND status = 'pending'`,
        )
        .get(employee_id, date) as any;
      if (open) {
        return Response.json(
          { error: 'A pending shift request already exists for that employee and date' },
          { status: 409 },
        );
      }

      const id = generateId();
      const create = db.transaction(() => {
        db.prepare(
          `INSERT INTO hr_shift_requests
             (id, employee_id, date, requested_shift_id, swap_with_employee_id, reason, status, requested_by)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
        ).run(id, employee_id, date, requested_shift_id, swap_with_employee_id, reason, me.email);

        logAuditEvent(db, {
          event_type: 'hr.roster.request_create',
          entity_type: 'hr_shift_request',
          entity_id: id,
          actor_email: me.email,
          outlet_id: outletId,
          after: { id, employee_id, date, requested_shift_id, swap_with_employee_id, reason, status: 'pending' },
        });
      });
      create();

      const row = db.prepare(`${REQUEST_ROW_SELECT} WHERE q.id = ?`).get(id) as any;
      return Response.json({ request: row });
    }

    /* ── Bulk roster upsert ({ assignments: [...] }) ──────────────────── */
    if (Array.isArray(body?.assignments)) {
      const assignments = body.assignments as any[];
      if (!assignments.length) {
        return Response.json({ error: 'No assignments provided' }, { status: 400 });
      }
      if (assignments.length > MAX_BULK_ASSIGNMENTS) {
        return Response.json(
          { error: `Too many assignments (max ${MAX_BULK_ASSIGNMENTS} per save)` },
          { status: 400 },
        );
      }

      // Validate EVERYTHING up front — the transaction below is all-or-nothing
      // and must not begin until every ref is proven.
      const rows: { employee_id: string; date: string; shift_id: string; note: string }[] = [];
      for (let i = 0; i < assignments.length; i++) {
        const a = assignments[i] ?? {};
        const employee_id = s(a.employee_id);
        const date = s(a.date);
        const shift_id = s(a.shift_id);
        if (!employee_id || !DATE_RE.test(date) || !shift_id) {
          return Response.json(
            { error: `Assignment ${i + 1} is invalid — employee, date (YYYY-MM-DD) and shift are required` },
            { status: 400 },
          );
        }
        rows.push({ employee_id, date, shift_id, note: s(a.note) });
      }
      // Duplicate (employee, date) pairs inside one payload would make the
      // upsert order-dependent — refuse rather than silently last-write-wins.
      const seen = new Set<string>();
      for (const r of rows) {
        const key = `${r.employee_id}|${r.date}`;
        if (seen.has(key)) {
          return Response.json(
            { error: 'Duplicate assignment for the same employee and date in one save' },
            { status: 400 },
          );
        }
        seen.add(key);
      }

      const employeeIds = [...new Set(rows.map((r) => r.employee_id))];
      const shiftIds = [...new Set(rows.map((r) => r.shift_id))];
      const empPh = employeeIds.map(() => '?').join(',');
      const employees = db
        .prepare(`SELECT id, full_name, status FROM hr_employees WHERE id IN (${empPh})`)
        .all(...employeeIds) as EmployeeRef[];
      const empById = new Map(employees.map((e) => [e.id, e]));
      for (const empId of employeeIds) {
        const emp = empById.get(empId);
        if (!emp) return Response.json({ error: 'Employee not found' }, { status: 400 });
        if (EXITED_STATUSES.has(emp.status)) {
          return Response.json(
            { error: `${emp.full_name} has exited — they cannot be rostered` },
            { status: 409 },
          );
        }
      }
      const shiftPh = shiftIds.map(() => '?').join(',');
      const foundShifts = db
        .prepare(`SELECT id FROM hr_shifts WHERE id IN (${shiftPh})`)
        .all(...shiftIds) as any[];
      if (foundShifts.length !== shiftIds.length) {
        return Response.json({ error: 'Shift not found' }, { status: 400 });
      }

      const upsert = db.prepare(
        `INSERT INTO hr_rosters (id, employee_id, date, shift_id, note, created_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(employee_id, date) DO UPDATE SET
           shift_id = excluded.shift_id,
           note = excluded.note,
           created_by = excluded.created_by`,
      );
      const dates = rows.map((r) => r.date).sort();
      const bulk = db.transaction(() => {
        for (const r of rows) {
          upsert.run(generateId(), r.employee_id, r.date, r.shift_id, r.note, me.email);
        }
        // ONE summary event, not one per row — the roster table itself is the
        // state; audit_events must not take a 700-row write per grid save.
        logAuditEvent(db, {
          event_type: 'hr.roster.bulk_assign',
          entity_type: 'hr_roster',
          entity_id: `bulk:${dates[0]}..${dates[dates.length - 1]}`,
          actor_email: me.email,
          outlet_id: outletId,
          after: {
            count: rows.length,
            date_min: dates[0],
            date_max: dates[dates.length - 1],
            employee_count: employeeIds.length,
          },
        });
      });
      bulk();

      return Response.json({ ok: true, count: rows.length });
    }

    /* ── Single roster upsert ─────────────────────────────────────────── */
    const employee_id = s(body?.employee_id);
    const date = s(body?.date);
    const shift_id = s(body?.shift_id);
    const note = s(body?.note);

    if (!employee_id) return Response.json({ error: 'Employee is required' }, { status: 400 });
    if (!DATE_RE.test(date)) {
      return Response.json({ error: 'Invalid date (expected YYYY-MM-DD)' }, { status: 400 });
    }
    if (!shift_id) return Response.json({ error: 'Shift is required' }, { status: 400 });

    const employee = findEmployee(db, employee_id);
    if (!employee) return Response.json({ error: 'Employee not found' }, { status: 400 });
    if (EXITED_STATUSES.has(employee.status)) {
      return Response.json(
        { error: `${employee.full_name} has exited — they cannot be rostered` },
        { status: 409 },
      );
    }
    // Existence only — an INACTIVE shift may still be re-saved by a stale
    // grid; the LEFT JOIN keeps rendering its label either way.
    const shift = db.prepare(`SELECT id FROM hr_shifts WHERE id = ?`).get(shift_id) as any;
    if (!shift) return Response.json({ error: 'Shift not found' }, { status: 400 });

    const before = db
      .prepare(`SELECT * FROM hr_rosters WHERE employee_id = ? AND date = ?`)
      .get(employee_id, date) as HrRoster | undefined;

    const assign = db.transaction(() => {
      db.prepare(
        `INSERT INTO hr_rosters (id, employee_id, date, shift_id, note, created_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(employee_id, date) DO UPDATE SET
           shift_id = excluded.shift_id,
           note = excluded.note,
           created_by = excluded.created_by`,
      ).run(generateId(), employee_id, date, shift_id, note, me.email);

      const after = db
        .prepare(`SELECT * FROM hr_rosters WHERE employee_id = ? AND date = ?`)
        .get(employee_id, date) as HrRoster;
      logAuditEvent(db, {
        event_type: 'hr.roster.assign',
        entity_type: 'hr_roster',
        entity_id: after.id,
        actor_email: me.email,
        outlet_id: outletId,
        before: before ?? null,
        after,
      });
    });
    assign();

    const assignment = db
      .prepare(`${ROSTER_ROW_SELECT} WHERE r.employee_id = ? AND r.date = ?`)
      .get(employee_id, date) as any;
    return Response.json({ assignment });
  } catch (e) {
    console.error('POST /api/hr/roster failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to save roster' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }

  // House style is query params; the module contract writes DELETE
  // { employee_id, date } — accept both so neither caller shape breaks.
  const sp = new URL(request.url).searchParams;
  let employee_id = s(sp.get('employee_id'));
  let date = s(sp.get('date'));
  if (!employee_id || !date) {
    try {
      const body: any = await request.json();
      employee_id = employee_id || s(body?.employee_id);
      date = date || s(body?.date);
    } catch { /* no body — handled below */ }
  }
  if (!employee_id) return Response.json({ error: 'Employee is required' }, { status: 400 });
  if (!DATE_RE.test(date)) {
    return Response.json({ error: 'Invalid date (expected YYYY-MM-DD)' }, { status: 400 });
  }

  const outletId = await getCurrentOutletId();

  try {
    const db = getDb();
    const existing = db
      .prepare(`SELECT * FROM hr_rosters WHERE employee_id = ? AND date = ?`)
      .get(employee_id, date) as HrRoster | undefined;
    if (!existing) {
      return Response.json({ error: 'No roster assignment found for that day' }, { status: 404 });
    }

    const remove = db.transaction(() => {
      db.prepare(`DELETE FROM hr_rosters WHERE id = ?`).run(existing.id);
      logAuditEvent(db, {
        event_type: 'hr.roster.unassign',
        entity_type: 'hr_roster',
        entity_id: existing.id,
        actor_email: me.email,
        outlet_id: outletId,
        before: existing,
      });
    });
    remove();

    return Response.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/hr/roster failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to remove roster assignment' }, { status: 500 });
  }
}

/**
 * PATCH — decide a shift request (ADMIN ONLY). Approval writes the roster row
 * in the SAME transaction as the status flip: the decision and its effect can
 * never disagree. Swap semantics: the requester always receives the requested
 * shift; when a swap partner is named AND the requester already had a roster
 * row that day, the partner receives the requester's previous shift atomically.
 * (No previous row → there is nothing to hand over; the partner is untouched.)
 */
export async function PATCH(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) return Response.json({ error: 'Admin role required' }, { status: 403 });

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }
  const id = s(body?.id);
  const action = s(body?.action);
  const review_reason = s(body?.review_reason);

  if (!id) return Response.json({ error: 'Request id is required' }, { status: 400 });
  if (action !== 'approve' && action !== 'reject') {
    return Response.json({ error: 'Action must be approve or reject' }, { status: 400 });
  }

  const outletId = await getCurrentOutletId();

  try {
    const db = getDb();
    const req = db
      .prepare(`SELECT * FROM hr_shift_requests WHERE id = ?`)
      .get(id) as HrShiftRequest | undefined;
    if (!req) return Response.json({ error: 'Shift request not found' }, { status: 404 });
    // Decision functions refuse non-pending (the variance_approvals rule) —
    // a decided request is history, never re-decided.
    if (req.status !== 'pending') {
      return Response.json({ error: 'This request was already decided' }, { status: 409 });
    }

    if (action === 'reject') {
      const reject = db.transaction(() => {
        db.prepare(
          `UPDATE hr_shift_requests
              SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now'), review_reason = ?
            WHERE id = ?`,
        ).run(me.email, review_reason, id);
        logAuditEvent(db, {
          event_type: 'hr.roster.request_reject',
          entity_type: 'hr_shift_request',
          entity_id: id,
          actor_email: me.email,
          outlet_id: outletId,
          before: req,
          after: { ...req, status: 'rejected', reviewed_by: me.email, review_reason },
        });
      });
      reject();

      const row = db.prepare(`${REQUEST_ROW_SELECT} WHERE q.id = ?`).get(id) as any;
      return Response.json({ request: row });
    }

    /* ── approve ──────────────────────────────────────────────────────── */
    const employee = findEmployee(db, req.employee_id);
    if (!employee) return Response.json({ error: 'Employee not found' }, { status: 400 });
    if (EXITED_STATUSES.has(employee.status)) {
      return Response.json(
        { error: 'Employee has exited — the request cannot be approved' },
        { status: 409 },
      );
    }
    const shift = db
      .prepare(`SELECT id FROM hr_shifts WHERE id = ?`)
      .get(req.requested_shift_id) as any;
    if (!shift) return Response.json({ error: 'Requested shift was not found' }, { status: 400 });

    let partner: EmployeeRef | null = null;
    if (req.swap_with_employee_id) {
      partner = findEmployee(db, req.swap_with_employee_id);
      if (!partner) return Response.json({ error: 'Swap partner was not found' }, { status: 400 });
      if (EXITED_STATUSES.has(partner.status)) {
        return Response.json(
          { error: 'Swap partner has exited — the request cannot be approved' },
          { status: 409 },
        );
      }
    }

    const upsert = db.prepare(
      `INSERT INTO hr_rosters (id, employee_id, date, shift_id, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(employee_id, date) DO UPDATE SET
         shift_id = excluded.shift_id,
         note = excluded.note,
         created_by = excluded.created_by`,
    );

    const approve = db.transaction(() => {
      // The requester's PREVIOUS shift that day — read inside the txn so the
      // swap hand-over can't race another writer.
      const prev = db
        .prepare(`SELECT * FROM hr_rosters WHERE employee_id = ? AND date = ?`)
        .get(req.employee_id, req.date) as HrRoster | undefined;

      db.prepare(
        `UPDATE hr_shift_requests
            SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now'), review_reason = ?
          WHERE id = ?`,
      ).run(me.email, review_reason, id);

      upsert.run(
        generateId(), req.employee_id, req.date, req.requested_shift_id,
        `Shift request approved`, me.email,
      );

      let swapped_shift_id = '';
      if (partner && prev) {
        swapped_shift_id = prev.shift_id;
        upsert.run(
          generateId(), partner.id, req.date, prev.shift_id,
          `Swap with ${employee.full_name}`, me.email,
        );
      }

      logAuditEvent(db, {
        event_type: 'hr.roster.request_approve',
        entity_type: 'hr_shift_request',
        entity_id: id,
        actor_email: me.email,
        outlet_id: outletId,
        before: req,
        after: {
          ...req,
          status: 'approved',
          reviewed_by: me.email,
          review_reason,
          roster_written: { employee_id: req.employee_id, date: req.date, shift_id: req.requested_shift_id },
          swap_written: partner && swapped_shift_id
            ? { employee_id: partner.id, date: req.date, shift_id: swapped_shift_id }
            : null,
        },
      });
    });
    approve();

    const row = db.prepare(`${REQUEST_ROW_SELECT} WHERE q.id = ?`).get(id) as any;
    return Response.json({ request: row });
  } catch (e) {
    console.error('PATCH /api/hr/roster failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to decide shift request' }, { status: 500 });
  }
}
