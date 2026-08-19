/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { canManageHr, canAdminHr, isHrLeaveStatus } from '@/lib/hr';
import {
  validateRequest,
  applyApprovedLeave,
  balanceOf,
  leaveYearOf,
  type HrLeaveBalanceView,
} from '@/lib/hr-leave';
import { todayIST, fmtISTDate } from '@/lib/format-date';
import { notifyHrEmployee } from '@/lib/hr-notify';
import { reportServerError } from '@/lib/error-alerts';

/**
 * HR Leave Requests (/api/hr/leave/requests) — HRMS Phase 3.
 * Contract: docs/HRMS_DECISIONS.md §5/§6; ledger rules in src/lib/hr-leave.ts.
 *
 * GET  ?status=&employee_id=&year=&page=&pageSize=
 *        → { rows, total, page, pageSize, balances }
 *      Server-side pagination (default 25, cap 100), COUNT(*) sharing the
 *      WHERE. rows are hr_leave_requests LEFT JOINed to employee code/name and
 *      the leave-type label (dangling ids degrade to blank, never drop rows),
 *      each carrying its own `balance` view for the (employee, type,
 *      from-date-year) bucket it draws from. `balances` is a per-employee map
 *      (every employee on the page) of the year's balance across all ACTIVE
 *      leave types — the year filter when given, else the current IST year.
 *      All balance reads go through balanceOf() (hr-leave lib): pure reads,
 *      no rows are minted by a GET.
 *
 * POST create { employee_id, leave_type_id, from_date, to_date, days, reason? }
 *        → { request }
 *      validateRequest() (hr-leave lib) decides: employee/type must exist,
 *      real dates, days ≤ span, max_consecutive_days cap, no overlap with the
 *      employee's pending/approved leaves, and paid-type balance sufficiency.
 *      Failures return its HUMAN message — 409 for the overlap conflict, 400
 *      for everything else. Row is born 'pending', requested_by = me.email
 *      (actor convention; employee_id is ALWAYS hr_employees.id).
 *
 * POST cancel { action: 'cancel', id, reason? } → { request }
 *      Management may cancel while the request is still PENDING (guarded
 *      UPDATE — a lost race with a decision is a 409, never a clobber).
 *
 * PATCH { id, action: 'approve'|'reject', review_reason } → { request }
 *      Admin only; review_reason REQUIRED for both actions. reject flips the
 *      status (decision metadata only, nothing moves). approve runs claim →
 *      re-validate (exclude_request_id = its own id — pending requests race
 *      each other for the same balance) → applyApprovedLeave (bump taken,
 *      seeding the year row if needed) → audit, ALL inside ONE
 *      db.transaction(): a failure anywhere rolls the whole decision back and
 *      the row stays pending. The response includes the updated balance.
 *
 * Gates: GET/POST canManageHr, PATCH canAdminHr. The proxy does NOT protect
 * API GETs — these handlers are the security boundary (§2.1). Errors are
 * GENERIC on the wire except hr-leave's caller-safe validation messages;
 * e.message otherwise never leaves the server.
 * Audit: hr.leave.request / .approve / .reject / .cancel.
 */
export const dynamic = 'force-dynamic';

const ALREADY_DECIDED = 'Leave request has already been decided';

/** Trimmed string from any body value ('' for null/undefined). */
function s(v: unknown): string {
  return String(v ?? '').trim();
}

const REQUEST_SELECT = `
  SELECT r.*, e.employee_code, e.full_name,
         t.name AS leave_type_name, t.is_paid AS leave_type_is_paid
  FROM hr_leave_requests r
  LEFT JOIN hr_employees e ON e.id = r.employee_id
  LEFT JOIN hr_leave_types t ON t.id = r.leave_type_id
`;

function loadRequest(db: any, id: string): any {
  return db.prepare(`${REQUEST_SELECT} WHERE r.id = ?`).get(id);
}

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }

  try {
    const sp = new URL(request.url).searchParams;

    const status = s(sp.get('status'));
    if (status && !isHrLeaveStatus(status)) {
      return Response.json({ error: 'Invalid status filter' }, { status: 400 });
    }
    const employeeId = s(sp.get('employee_id'));
    const year = s(sp.get('year'));
    if (year && !/^\d{4}$/.test(year)) {
      return Response.json({ error: 'Invalid year filter' }, { status: 400 });
    }

    // parseInt (not Number) so a float can't reach LIMIT/OFFSET and trip
    // SQLite's "datatype mismatch" 500 (the crm-calls convention).
    const page = Math.max(1, parseInt(sp.get('page') || '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(sp.get('pageSize') || '25', 10) || 25));

    // One WHERE feeds both the COUNT and the page query, so total and rows
    // can never disagree. The year bucket matches leaveYearOf (from_date).
    const conds: string[] = [];
    const params: any[] = [];
    if (status) { conds.push('r.status = ?'); params.push(status); }
    if (employeeId) { conds.push('r.employee_id = ?'); params.push(employeeId); }
    if (year) { conds.push('substr(r.from_date, 1, 4) = ?'); params.push(year); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const db = getDb();
    const totalRow = db
      .prepare(`SELECT COUNT(*) AS n FROM hr_leave_requests r ${where}`)
      .get(...params) as { n: number };

    const rows = db
      .prepare(
        `${REQUEST_SELECT} ${where}
         ORDER BY r.created_at DESC, r.id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, (page - 1) * pageSize) as any[];

    // Per-row balance: the exact (employee, type, from-date-year) bucket this
    // request draws from — what an approver needs to see next to the row.
    // balanceOf is a pure read (it never mints hr_leave_balances rows).
    for (const r of rows) {
      r.balance = balanceOf(db, r.employee_id, r.leave_type_id, leaveYearOf(r.from_date));
    }

    // Per-employee balances across all ACTIVE leave types for the filter year
    // (or the current IST year), for every employee on the page.
    const balanceYear = year || todayIST().slice(0, 4);
    const activeTypes = db
      .prepare(
        `SELECT id, name, is_paid FROM hr_leave_types
         WHERE is_active = 1 ORDER BY name COLLATE NOCASE`,
      )
      .all() as { id: string; name: string; is_paid: number }[];
    const balances: Record<
      string,
      ({ leave_type_id: string; leave_type_name: string; is_paid: number } & HrLeaveBalanceView)[]
    > = {};
    for (const empId of new Set(rows.map((r) => String(r.employee_id)))) {
      balances[empId] = activeTypes.map((t) => ({
        leave_type_id: t.id,
        leave_type_name: t.name,
        is_paid: t.is_paid,
        ...balanceOf(db, empId, t.id, balanceYear),
      }));
    }

    return Response.json({ rows, total: totalRow.n, page, pageSize, balances });
  } catch (e) {
    console.error('GET /api/hr/leave/requests failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to load leave requests' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }

  try {
    let body: any = {};
    try { body = await request.json(); } catch { /* handled by field checks below */ }

    // ---- cancel (management act, pending rows only) ----
    if (s(body?.action) === 'cancel') {
      const id = s(body?.id);
      if (!id) return Response.json({ error: 'Leave request id is required' }, { status: 400 });
      const reason = s(body?.reason);

      const outletId = await getCurrentOutletId();
      const db = getDb();
      const row = db.prepare('SELECT * FROM hr_leave_requests WHERE id = ?').get(id) as any;
      if (!row) return Response.json({ error: 'Leave request not found' }, { status: 404 });
      if (row.status !== 'pending') {
        return Response.json({ error: 'Only a pending leave request can be cancelled' }, { status: 409 });
      }

      // Status guard in the WHERE: a lost race (someone decided in between)
      // is a 409, never a clobber.
      const res = db
        .prepare(
          `UPDATE hr_leave_requests
           SET status = 'cancelled', reviewed_by = ?, reviewed_at = datetime('now'),
               review_reason = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(me.email, reason, id);
      if (res.changes !== 1) {
        return Response.json({ error: ALREADY_DECIDED }, { status: 409 });
      }

      logAuditEvent(db, {
        event_type: 'hr.leave.cancel',
        entity_type: 'hr_leave_request',
        entity_id: id,
        actor_email: me.email,
        outlet_id: outletId,
        before: { status: 'pending' },
        after: {
          status: 'cancelled',
          employee_id: row.employee_id,
          leave_type_id: row.leave_type_id,
          from_date: row.from_date,
          to_date: row.to_date,
          days: row.days,
        },
        note: reason,
      });
      return Response.json({ request: loadRequest(db, id) });
    }

    // ---- create ----
    const employee_id = s(body?.employee_id);
    const leave_type_id = s(body?.leave_type_id);
    const from_date = s(body?.from_date);
    const to_date = s(body?.to_date);
    const days = Number(body?.days);
    const reason = s(body?.reason);

    const outletId = await getCurrentOutletId();
    const db = getDb();

    // hr-leave's validateRequest owns the rules (employee/type exist, real
    // dates, days ≤ span, consecutive cap, overlap, paid-balance sufficiency)
    // and returns HUMAN messages. Overlap is a conflict (409); the rest 400.
    const invalid = validateRequest(db, { employee_id, leave_type_id, from_date, to_date, days });
    if (invalid) {
      const conflict = invalid.startsWith('Overlaps an existing');
      return Response.json({ error: invalid }, { status: conflict ? 409 : 400 });
    }

    const id = generateId();
    db.prepare(
      `INSERT INTO hr_leave_requests
         (id, employee_id, leave_type_id, from_date, to_date, days, reason,
          status, requested_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(id, employee_id, leave_type_id, from_date, to_date, days, reason, me.email);

    logAuditEvent(db, {
      event_type: 'hr.leave.request',
      entity_type: 'hr_leave_request',
      entity_id: id,
      actor_email: me.email,
      outlet_id: outletId,
      after: { employee_id, leave_type_id, from_date, to_date, days, status: 'pending' },
      note: reason,
    });

    return Response.json({ request: loadRequest(db, id) });
  } catch (e) {
    console.error('POST /api/hr/leave/requests failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to submit the leave request' }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  // Decisions are ADMIN acts (variance pattern: requesting is management,
  // deciding is not).
  if (!canAdminHr(me)) {
    return Response.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    let body: any = {};
    try { body = await request.json(); } catch { /* handled by field checks below */ }

    const id = s(body?.id);
    if (!id) return Response.json({ error: 'Leave request id is required' }, { status: 400 });
    const action = s(body?.action);
    if (action !== 'approve' && action !== 'reject') {
      return Response.json({ error: 'Unknown action' }, { status: 400 });
    }
    const review_reason = s(body?.review_reason);
    if (!review_reason) {
      return Response.json(
        { error: `A reason for ${action === 'approve' ? 'approving' : 'rejecting'} is required` },
        { status: 400 },
      );
    }

    // Resolve EVERY await before the transaction — better-sqlite3 is
    // synchronous and an await inside db.transaction() breaks atomicity.
    const outletId = await getCurrentOutletId();

    const db = getDb();
    const row = db.prepare('SELECT * FROM hr_leave_requests WHERE id = ?').get(id) as any;
    if (!row) return Response.json({ error: 'Leave request not found' }, { status: 404 });
    if (row.status !== 'pending') {
      return Response.json({ error: ALREADY_DECIDED }, { status: 409 });
    }

    if (action === 'reject') {
      // Decision metadata only — nothing moves, no balance is touched.
      const res = db
        .prepare(
          `UPDATE hr_leave_requests
           SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now'),
               review_reason = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(me.email, review_reason, id);
      if (res.changes !== 1) {
        return Response.json({ error: ALREADY_DECIDED }, { status: 409 });
      }
      logAuditEvent(db, {
        event_type: 'hr.leave.reject',
        entity_type: 'hr_leave_request',
        entity_id: id,
        actor_email: me.email,
        outlet_id: outletId,
        before: { status: 'pending' },
        after: {
          status: 'rejected',
          employee_id: row.employee_id,
          leave_type_id: row.leave_type_id,
          from_date: row.from_date,
          to_date: row.to_date,
          days: row.days,
        },
        note: review_reason,
      });
      // Durable notification + push (best-effort, AFTER the decision landed —
      // a notify failure must never fail the decision).
      try {
        notifyHrEmployee(db, row.employee_id, {
          kind: 'hr.leave.reject',
          title: `Leave rejected: ${fmtISTDate(row.from_date)} - ${fmtISTDate(row.to_date)}`,
          body: review_reason,
          href: '/hr/leave',
        });
      } catch { /* best-effort */ }
      return Response.json({ request: loadRequest(db, id) });
    }

    // ---- approve: claim + re-validate + spend + audit in ONE transaction ----
    // Pending requests race each other for the same balance, so validation
    // runs again HERE (exclude_request_id = its own id), inside the same
    // atomic unit as the status flip and the applyApprovedLeave spend — a
    // throw anywhere rolls everything back and the row stays pending.
    // (hr-leave functions are synchronous and open no transaction of their
    // own, by contract.)
    const tx = db.transaction(() => {
      const claimed = db
        .prepare(
          `UPDATE hr_leave_requests
           SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now'),
               review_reason = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(me.email, review_reason, id);
      if (claimed.changes !== 1) throw new Error('LEAVE_ALREADY_DECIDED');

      const invalid = validateRequest(db, {
        employee_id: row.employee_id,
        leave_type_id: row.leave_type_id,
        from_date: row.from_date,
        to_date: row.to_date,
        days: Number(row.days),
        exclude_request_id: id,
      });
      if (invalid) throw new Error(`LEAVE_VALIDATE:${invalid}`);

      // Bump taken on the (employee, type, from-date-year) row, seeding the
      // year's balance row first if this is its first touch.
      applyApprovedLeave(db, {
        employee_id: row.employee_id,
        leave_type_id: row.leave_type_id,
        from_date: row.from_date,
        days: Number(row.days),
      });

      logAuditEvent(db, {
        event_type: 'hr.leave.approve',
        entity_type: 'hr_leave_request',
        entity_id: id,
        actor_email: me.email,
        outlet_id: outletId,
        before: { status: 'pending' },
        after: {
          status: 'approved',
          employee_id: row.employee_id,
          leave_type_id: row.leave_type_id,
          from_date: row.from_date,
          to_date: row.to_date,
          days: row.days,
        },
        note: review_reason,
      });
    });

    try {
      tx();
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      if (msg === 'LEAVE_ALREADY_DECIDED') {
        return Response.json({ error: ALREADY_DECIDED }, { status: 409 });
      }
      if (msg.startsWith('LEAVE_VALIDATE:')) {
        // The request no longer passes (balance spent by a sibling approval,
        // a new overlap, type deactivated...). Caller-safe hr-leave message.
        return Response.json(
          { error: `Cannot approve: ${msg.slice('LEAVE_VALIDATE:'.length)}` },
          { status: 409 },
        );
      }
      throw e;
    }

    // Durable notification + push (best-effort, AFTER the transaction
    // committed — a notify failure must never fail the decision).
    try {
      notifyHrEmployee(db, row.employee_id, {
        kind: 'hr.leave.approve',
        title: `Leave approved: ${fmtISTDate(row.from_date)} - ${fmtISTDate(row.to_date)}`,
        body: `${row.days} day(s) approved. ${review_reason}`,
        href: '/hr/leave',
      });
    } catch { /* best-effort */ }

    return Response.json({
      request: loadRequest(db, id),
      balance: balanceOf(db, row.employee_id, row.leave_type_id, leaveYearOf(row.from_date)),
    });
  } catch (e) {
    console.error('PATCH /api/hr/leave/requests failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to decide the leave request' }, { status: 500 });
  }
}
