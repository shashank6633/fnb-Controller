/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { canManageHr, canAdminHr, isHrAdvanceStatus } from '@/lib/hr';
import { notifyHrEmployee } from '@/lib/hr-notify';
import { reportServerError } from '@/lib/error-alerts';
import { todayIST } from '@/lib/format-date';

/**
 * HR Salary Advances (/api/hr/advances) — Phase 4.
 * Contract: docs/HRMS_DECISIONS.md (§5 pay tables; ledgers append, state lives
 * in status columns; employee_id = hr_employees.id, actors = me.email).
 *
 * GET  ?employee_id=&status=&page=&pageSize=
 *        → { rows, total, page, pageSize }
 *      Server-side pagination (default 25, cap 100). Each row is an
 *      hr_advances row + employee_name / employee_code (LEFT JOIN — a dangling
 *      employee_id degrades to blank, never drops the money row) + its
 *      hr_advance_installments as `installments` (ordered by period).
 *
 * POST { employee_id, requested_amount, reason? } → { advance }
 *      Creates a 'pending' request. canManageHr — managers raise requests on
 *      behalf of staff (employees may have no login at all, contract D1).
 *
 * PATCH { id, action, ... } → { advance }        — ALL decisions canAdminHr.
 *      action 'approve'  { approved_amount, installment_amount }:
 *        pending → approved, and generates the recovery schedule in the SAME
 *        transaction: ceil(approved/installment) hr_advance_installments rows
 *        starting NEXT month (IST, 'YYYY-MM' arithmetic), every row =
 *        installment_amount except the last = the remainder. Paise-integer
 *        math — no float dust in a money ledger.
 *      action 'reject'   { review_reason }: pending → rejected. hr_advances
 *        has no review_reason column (schema is frozen) — the reason is
 *        preserved durably in the audit event's note.
 *      action 'disburse': approved → disbursed, stamps disbursed_at.
 *      action 'close':    disbursed → closed, ONLY when recovered_amount has
 *        caught up with approved_amount. The engine never invents recovery —
 *        recovered_amount is written by the payroll run, not here.
 *
 * Every decision uses a status-guarded UPDATE (WHERE status = ...) so a lost
 * race is a 409, never a clobber (the corrections-route idiom). Errors return
 * GENERIC messages only — e.message can leak schema/PII for HR data.
 */
export const dynamic = 'force-dynamic';

/** Trimmed string from any body value ('' for null/undefined). */
function s(v: unknown): string {
  return String(v ?? '').trim();
}

/**
 * Positive money value rounded to paise, or null when the input is not a
 * finite positive number (Number.isFinite guard — 'abc', NaN, Infinity, 0 and
 * negatives are all rejected, never coerced).
 */
function money(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

/** Sanity ceiling on a recovery schedule (5 years of monthly deductions). */
const MAX_INSTALLMENTS = 60;

/**
 * 'YYYY-MM' periods for the recovery schedule: n consecutive months starting
 * the month AFTER the current IST month. Pure month-index arithmetic — a
 * December approval rolls into January of the next year.
 */
function nextPeriods(n: number): string[] {
  const today = todayIST(); // YYYY-MM-DD in IST
  const y = parseInt(today.slice(0, 4), 10);
  const m = parseInt(today.slice(5, 7), 10); // 1-12
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const idx = y * 12 + (m - 1) + 1 + i; // months since year 0; +1 = next month
    const year = Math.floor(idx / 12);
    const month = (idx % 12) + 1;
    out.push(`${year}-${String(month).padStart(2, '0')}`);
  }
  return out;
}

const ADVANCE_SELECT = `
  SELECT a.*, e.full_name AS employee_name, e.employee_code AS employee_code
  FROM hr_advances a
  LEFT JOIN hr_employees e ON e.id = a.employee_id
`;

/** One advance with joined names + its installment ledger (or null). */
function loadAdvance(db: any, id: string): any {
  const row = db.prepare(`${ADVANCE_SELECT} WHERE a.id = ?`).get(id);
  if (!row) return null;
  const installments = db
    .prepare('SELECT * FROM hr_advance_installments WHERE advance_id = ? ORDER BY period, id')
    .all(id);
  return { ...row, installments };
}

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  // Money list — /hr/payroll (the only UI) is adminOnly in the catalog, so
  // reads are admin too. POST below stays canManageHr (raise on behalf).
  if (!canAdminHr(me)) {
    return Response.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    const sp = new URL(request.url).searchParams;

    // parseInt (not Number) so a float can't reach LIMIT/OFFSET and trip
    // SQLite's "datatype mismatch" 500 (the crm-calls convention).
    const page = Math.max(1, parseInt(sp.get('page') || '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(sp.get('pageSize') || '25', 10) || 25));

    const employee_id = s(sp.get('employee_id'));
    const status = s(sp.get('status'));
    if (status && !isHrAdvanceStatus(status)) {
      return Response.json({ error: 'Invalid status filter' }, { status: 400 });
    }

    // ONE clause + params feeds both COUNT(*) and the page query, so total
    // and rows can never disagree.
    const clauses: string[] = [];
    const params: any[] = [];
    if (employee_id) {
      clauses.push('a.employee_id = ?');
      params.push(employee_id);
    }
    if (status) {
      clauses.push('a.status = ?');
      params.push(status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const db = getDb();
    const totalRow = db
      .prepare(`SELECT COUNT(*) AS n FROM hr_advances a ${where}`)
      .get(...params) as { n: number };

    const rows = db
      .prepare(
        `${ADVANCE_SELECT} ${where}
         ORDER BY a.requested_at DESC, a.id
         LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, (page - 1) * pageSize) as any[];

    // Attach each advance's installment ledger in ONE IN() query for the page
    // (25-100 ids), grouped in memory — not a query per row.
    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      const inst = db
        .prepare(
          `SELECT * FROM hr_advance_installments
           WHERE advance_id IN (${ids.map(() => '?').join(',')})
           ORDER BY period, id`,
        )
        .all(...ids) as any[];
      const byAdvance = new Map<string, any[]>();
      for (const i of inst) {
        const list = byAdvance.get(i.advance_id);
        if (list) list.push(i);
        else byAdvance.set(i.advance_id, [i]);
      }
      for (const r of rows) r.installments = byAdvance.get(r.id) ?? [];
    }

    return Response.json({ rows, total: totalRow.n, page, pageSize });
  } catch (e) {
    console.error('[hr-advances] GET failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to load advances' }, { status: 500 });
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

    const employee_id = s(body?.employee_id);
    if (!employee_id) {
      return Response.json({ error: 'Employee is required' }, { status: 400 });
    }
    const requested_amount = money(body?.requested_amount);
    if (requested_amount === null) {
      return Response.json(
        { error: 'Requested amount must be a positive number' },
        { status: 400 },
      );
    }
    const reason = s(body?.reason);

    const db = getDb();
    // CREATE validates the referenced employee exists (reads stay LEFT-JOIN
    // tolerant; writes do not get to invent people).
    const emp = db
      .prepare('SELECT id FROM hr_employees WHERE id = ?')
      .get(employee_id) as any;
    if (!emp) {
      return Response.json({ error: 'Selected employee was not found' }, { status: 400 });
    }

    const id = generateId();
    const record = {
      id,
      employee_id,
      requested_amount,
      reason,
      status: 'pending',
      created_by: me.email, // actor = me.email, NEVER an employee id
    };

    const create = db.transaction(() => {
      db.prepare(
        `INSERT INTO hr_advances (id, employee_id, requested_amount, reason, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, employee_id, requested_amount, reason, 'pending', me.email);

      logAuditEvent(db, {
        event_type: 'hr.advance.request',
        entity_type: 'hr_advance',
        entity_id: id,
        actor_email: me.email,
        after: record,
      });
    });
    create();

    return Response.json({ advance: loadAdvance(db, id) });
  } catch (e) {
    console.error('[hr-advances] POST failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to create the advance request' }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  // ALL advance decisions (approve/reject/disburse/close) are ADMIN acts —
  // this is money (HRMS_DECISIONS §2.2).
  if (!canAdminHr(me)) {
    return Response.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    let body: any = {};
    try { body = await request.json(); } catch { /* handled by field checks below */ }

    const id = s(body?.id);
    if (!id) return Response.json({ error: 'Advance id is required' }, { status: 400 });
    const action = s(body?.action);
    if (!['approve', 'reject', 'disburse', 'close'].includes(action)) {
      return Response.json({ error: 'Unknown action' }, { status: 400 });
    }

    const db = getDb();
    const row = db.prepare('SELECT * FROM hr_advances WHERE id = ?').get(id) as any;
    if (!row) return Response.json({ error: 'Advance not found' }, { status: 404 });

    // ---- approve: decide + generate the recovery schedule in ONE txn ----
    if (action === 'approve') {
      if (row.status !== 'pending') {
        return Response.json({ error: 'This advance has already been decided' }, { status: 409 });
      }
      const approved_amount = money(body?.approved_amount);
      if (approved_amount === null) {
        return Response.json(
          { error: 'Approved amount must be a positive number' },
          { status: 400 },
        );
      }
      const installment_amount = money(body?.installment_amount);
      if (installment_amount === null) {
        return Response.json(
          { error: 'Installment amount must be a positive number' },
          { status: 400 },
        );
      }

      // Paise integers: ceil(approved/installment) rows, last = remainder.
      const ap = Math.round(approved_amount * 100);
      const ip = Math.round(installment_amount * 100);
      const n = Math.ceil(ap / ip);
      if (n > MAX_INSTALLMENTS) {
        return Response.json(
          {
            error: `Installment amount is too small - recovery would take ${n} months (max ${MAX_INSTALLMENTS})`,
          },
          { status: 400 },
        );
      }
      const periods = nextPeriods(n);
      const schedule = periods.map((period, i) => ({
        id: generateId(),
        period,
        // Every row the chosen installment; the LAST row is the remainder so
        // the schedule sums to approved_amount exactly (n = ceil ⇒ remainder
        // is always > 0 and ≤ installment).
        amount: (i === n - 1 ? ap - ip * (n - 1) : ip) / 100,
      }));

      const insertInst = db.prepare(
        `INSERT INTO hr_advance_installments (id, advance_id, period, amount)
         VALUES (?, ?, ?, ?)`,
      );
      const tx = db.transaction(() => {
        // Status-guarded claim: a lost race (someone decided in between) rolls
        // the whole thing back as a 409, never a duplicate schedule.
        const claimed = db
          .prepare(
            `UPDATE hr_advances
             SET status = 'approved', approved_amount = ?, installment_amount = ?,
                 reviewed_by = ?, reviewed_at = datetime('now')
             WHERE id = ? AND status = 'pending'`,
          )
          .run(approved_amount, installment_amount, me.email, id);
        if (claimed.changes !== 1) throw new Error('ADVANCE_ALREADY_DECIDED');

        for (const inst of schedule) {
          insertInst.run(inst.id, id, inst.period, inst.amount);
        }

        logAuditEvent(db, {
          event_type: 'hr.advance.approve',
          entity_type: 'hr_advance',
          entity_id: id,
          actor_email: me.email,
          before: { status: 'pending', requested_amount: row.requested_amount },
          after: {
            status: 'approved',
            employee_id: row.employee_id,
            approved_amount,
            installment_amount,
            installments: n,
            first_period: periods[0],
            last_period: periods[n - 1],
          },
        });
      });
      try {
        tx();
      } catch (e) {
        if (e instanceof Error && e.message === 'ADVANCE_ALREADY_DECIDED') {
          return Response.json(
            { error: 'This advance has already been decided' },
            { status: 409 },
          );
        }
        throw e;
      }
      // Durable notification + push (best-effort, AFTER the transaction
      // committed — a notify failure must never fail the decision).
      try {
        notifyHrEmployee(db, row.employee_id, {
          kind: 'hr.advance.approve',
          title: `Salary advance approved: ₹${approved_amount.toFixed(2)}`,
          body: `Recovery in ${n} monthly installment(s) of ₹${installment_amount.toFixed(2)} starting ${periods[0]}.`,
          href: '/hr/payroll',
        });
      } catch { /* best-effort */ }
      return Response.json({ advance: loadAdvance(db, id) });
    }

    // ---- reject: decision metadata only ----
    if (action === 'reject') {
      if (row.status !== 'pending') {
        return Response.json({ error: 'This advance has already been decided' }, { status: 409 });
      }
      const review_reason = s(body?.review_reason);
      if (!review_reason) {
        return Response.json({ error: 'A reason for rejecting is required' }, { status: 400 });
      }
      const res = db
        .prepare(
          `UPDATE hr_advances
           SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now')
           WHERE id = ? AND status = 'pending'`,
        )
        .run(me.email, id);
      if (res.changes !== 1) {
        return Response.json({ error: 'This advance has already been decided' }, { status: 409 });
      }
      // hr_advances has no review_reason column — the audit note is the
      // durable record of WHY (surfaced on /audit).
      logAuditEvent(db, {
        event_type: 'hr.advance.reject',
        entity_type: 'hr_advance',
        entity_id: id,
        actor_email: me.email,
        before: { status: 'pending', requested_amount: row.requested_amount },
        after: { status: 'rejected', employee_id: row.employee_id },
        note: review_reason,
      });
      // Durable notification + push (best-effort, AFTER the decision landed —
      // a notify failure must never fail the decision).
      try {
        notifyHrEmployee(db, row.employee_id, {
          kind: 'hr.advance.reject',
          title: 'Salary advance request rejected',
          body: review_reason,
          href: '/hr/payroll',
        });
      } catch { /* best-effort */ }
      return Response.json({ advance: loadAdvance(db, id) });
    }

    // ---- disburse: money leaves the till — only an approved advance ----
    if (action === 'disburse') {
      if (row.status !== 'approved') {
        return Response.json(
          { error: 'Only an approved advance can be disbursed' },
          { status: 409 },
        );
      }
      const res = db
        .prepare(
          `UPDATE hr_advances
           SET status = 'disbursed', disbursed_at = datetime('now')
           WHERE id = ? AND status = 'approved'`,
        )
        .run(id);
      if (res.changes !== 1) {
        return Response.json(
          { error: 'Only an approved advance can be disbursed' },
          { status: 409 },
        );
      }
      logAuditEvent(db, {
        event_type: 'hr.advance.disburse',
        entity_type: 'hr_advance',
        entity_id: id,
        actor_email: me.email,
        before: { status: 'approved' },
        after: {
          status: 'disbursed',
          employee_id: row.employee_id,
          approved_amount: row.approved_amount,
        },
      });
      // Durable notification + push (best-effort, AFTER the decision landed —
      // a notify failure must never fail the decision).
      try {
        notifyHrEmployee(db, row.employee_id, {
          kind: 'hr.advance.disburse',
          title: `Salary advance disbursed: ₹${Number(row.approved_amount || 0).toFixed(2)}`,
          body: 'Your approved salary advance has been paid out.',
          href: '/hr/payroll',
        });
      } catch { /* best-effort */ }
      return Response.json({ advance: loadAdvance(db, id) });
    }

    // ---- close: only when the ledger says recovery has caught up ----
    if (row.status !== 'disbursed') {
      return Response.json({ error: 'Only a disbursed advance can be closed' }, { status: 409 });
    }
    // Paise compare — recovered_amount is written by payroll recovery, never
    // invented here.
    const recoveredP = Math.round(Number(row.recovered_amount || 0) * 100);
    const approvedP = Math.round(Number(row.approved_amount || 0) * 100);
    if (recoveredP < approvedP) {
      return Response.json(
        {
          error: `Advance cannot be closed - recovered ${(recoveredP / 100).toFixed(2)} of ${(approvedP / 100).toFixed(2)}`,
        },
        { status: 409 },
      );
    }
    const res = db
      .prepare(`UPDATE hr_advances SET status = 'closed' WHERE id = ? AND status = 'disbursed'`)
      .run(id);
    if (res.changes !== 1) {
      return Response.json({ error: 'Only a disbursed advance can be closed' }, { status: 409 });
    }
    logAuditEvent(db, {
      event_type: 'hr.advance.close',
      entity_type: 'hr_advance',
      entity_id: id,
      actor_email: me.email,
      before: { status: 'disbursed' },
      after: {
        status: 'closed',
        employee_id: row.employee_id,
        approved_amount: row.approved_amount,
        recovered_amount: row.recovered_amount,
      },
    });
    return Response.json({ advance: loadAdvance(db, id) });
  } catch (e) {
    console.error('[hr-advances] PATCH failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to update the advance' }, { status: 500 });
  }
}
