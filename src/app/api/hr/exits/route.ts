/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { canAdminHr } from '@/lib/hr';
import { reportServerError } from '@/lib/error-alerts';
import { todayIST } from '@/lib/format-date';

/**
 * HR Exits: resignations + exit clearance (/api/hr/exits) — Phase 6.
 * Contract: docs/HRMS_DECISIONS.md (§5 people lifecycle; D1: HR status is
 * DESCRIPTIVE — completing an exit updates hr_employees (our table) but NEVER
 * writes users.is_active; it only *suggests* deactivation to the admin).
 *
 * GET  ?employee_id=&status=&page=&pageSize= → { rows, total, page, pageSize }
 *      Rows are hr_resignations + employee_name / employee_code (LEFT JOIN —
 *      dangling ids degrade to blank, never drop the row) + clearance_total /
 *      clearance_pending counts.
 * GET  ?id=<resignation_id> → { resignation, clearance }
 *      One resignation + its hr_exit_clearance items (keyed by employee_id).
 *
 * POST { employee_id, resignation_date, notice_days?, reason? } → { resignation }
 *      Gate: canAdminHr — the /hr/exits page is adminOnly in the catalog, so
 *      the API matches (admins submit on behalf of staff — employees may
 *      have no login at all). notice_days defaults to the employee's
 *      notice_period_days when the key is absent; last_working_date is
 *      COMPUTED = resignation_date + notice_days. One OPEN resignation per
 *      employee (submitted/manager_approved/hr_approved) — duplicate → 409.
 *      An employee already in an exit state (resigned/terminated/former) is
 *      refused with a 409 — rehire first.
 *
 * PATCH { id, action, note? }                    — decisions, canAdminHr.
 *      The status ladder is enforced IN ORDER via status-guarded UPDATEs (a
 *      lost race is a 409, never a clobber):
 *        'manager_approve'  submitted        → manager_approved (stamps manager_by/at)
 *        'hr_approve'       manager_approved → hr_approved, and seeds the
 *            hr_exit_clearance checklist (assets, advances, leave_encash,
 *            fnf, experience_letter, relieving_letter). Existing rows from a
 *            PREVIOUS cycle are RESET to 'pending' (cleared_by/cleared_at
 *            blanked, audited) so a second exit never completes on stale
 *            clearances; missing items are seeded (INSERT OR IGNORE on
 *            UNIQUE(employee_id, item)).
 *        'withdraw'         any open status  → withdrawn.
 *        'complete'         hr_approved      → completed. REQUIRES every
 *            clearance item cleared/waived — otherwise 409 listing the
 *            pending items. Sets the employee's status to 'former' +
 *            exit_date (direct UPDATE hr_employees — our table; NEVER users)
 *            and returns suggest_deactivate_login so the admin can follow up
 *            on /users (contract D1: proposing, never doing).
 *      The decision note is preserved in the audit event (the schema has no
 *      decision-note columns; the schema is frozen).
 *
 * PATCH { id, status: 'cleared'|'waived', note? } — clearance item, canAdminHr
 *      (the page is adminOnly; every verb here matches the catalog flag).
 *      id here is the hr_exit_clearance row id; stamps cleared_by/cleared_at.
 *
 * Errors return GENERIC messages only. Audit: hr.resignation.submit /
 * hr.resignation.decide / hr.exit_clearance.update with before/after.
 */
export const dynamic = 'force-dynamic';

/** Trimmed string from any body value ('' for null/undefined). */
function s(v: unknown): string {
  return String(v ?? '').trim();
}

/** Non-negative integer; garbage → 0. */
function int0(v: unknown): number {
  return Math.max(0, parseInt(String(v ?? '0'), 10) || 0);
}

/** True for a real calendar date in YYYY-MM-DD form. */
function isYmd(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** ymd + days → ymd (pure UTC arithmetic — no timezone drift on date-only math). */
function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The exit-clearance checklist seeded on HR approval (free labels per the
 *  hr_exit_clearance schema comment). Existing items are skipped. */
const EXIT_CLEARANCE_ITEMS = [
  'assets',
  'advances',
  'leave_encash',
  'fnf',
  'experience_letter',
  'relieving_letter',
] as const;

const OPEN_STATUSES = ['submitted', 'manager_approved', 'hr_approved'] as const;

/** Projection shared by list + single reads: resignation + employee display
 *  names + clearance progress (clearance is keyed by employee_id). */
const RESIGNATION_SELECT = `
  SELECT r.*,
         e.full_name AS employee_name,
         e.employee_code AS employee_code,
         e.status AS employee_status,
         (SELECT COUNT(*) FROM hr_exit_clearance x WHERE x.employee_id = r.employee_id) AS clearance_total,
         (SELECT COUNT(*) FROM hr_exit_clearance x
           WHERE x.employee_id = r.employee_id AND x.status = 'pending') AS clearance_pending
  FROM hr_resignations r
  LEFT JOIN hr_employees e ON e.id = r.employee_id
`;

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  // /hr/exits is adminOnly in the catalog — every verb here matches (§2.1:
  // the proxy does not protect API GETs, so this handler is the boundary).
  if (!canAdminHr(me)) {
    return Response.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    const sp = new URL(request.url).searchParams;
    const db = getDb();

    const id = s(sp.get('id'));
    if (id) {
      const resignation = db.prepare(`${RESIGNATION_SELECT} WHERE r.id = ?`).get(id) as any;
      if (!resignation) {
        return Response.json({ error: 'Resignation was not found' }, { status: 404 });
      }
      const clearance = db
        .prepare(
          `SELECT * FROM hr_exit_clearance WHERE employee_id = ? ORDER BY item`,
        )
        .all(resignation.employee_id) as any[];
      return Response.json({ resignation, clearance });
    }

    const page = Math.max(1, parseInt(sp.get('page') || '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(sp.get('pageSize') || '25', 10) || 25));

    const clauses: string[] = [];
    const params: any[] = [];
    const employee_id = s(sp.get('employee_id'));
    if (employee_id) {
      clauses.push('r.employee_id = ?');
      params.push(employee_id);
    }
    const status = s(sp.get('status'));
    if (status) {
      clauses.push('r.status = ?');
      params.push(status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const totalRow = db
      .prepare(`SELECT COUNT(*) AS n FROM hr_resignations r ${where}`)
      .get(...params) as { n: number };
    const rows = db
      .prepare(`${RESIGNATION_SELECT} ${where} ORDER BY r.created_at DESC, r.id LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize) as any[];

    return Response.json({ rows, total: totalRow.n, page, pageSize });
  } catch (e) {
    console.error('[hr-exits] GET failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to load resignations' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  // Submit is admin too — the only submit UI lives on the adminOnly page.
  if (!canAdminHr(me)) {
    return Response.json({ error: 'Admin access required' }, { status: 403 });
  }

  let body: any = {};
  try { body = await request.json(); } catch { /* handled by field checks below */ }

  const employee_id = s(body?.employee_id);
  if (!employee_id) {
    return Response.json({ error: 'Employee is required' }, { status: 400 });
  }
  const resignation_date = s(body?.resignation_date);
  if (!isYmd(resignation_date)) {
    return Response.json(
      { error: 'A valid resignation date (YYYY-MM-DD) is required' },
      { status: 400 },
    );
  }

  try {
    const db = getDb();

    // Referenced-row validation on CREATE (backend mapping rule):
    // employee_id is ALWAYS hr_employees.id, never a users.id or an email.
    const emp = db
      .prepare('SELECT id, full_name, notice_period_days, status FROM hr_employees WHERE id = ?')
      .get(employee_id) as any;
    if (!emp) {
      return Response.json({ error: 'Selected employee was not found' }, { status: 400 });
    }

    // An employee already in an exit state cannot resign again — this is the
    // enabling path for a stale-clearance second cycle. Rehire first.
    if (['resigned', 'terminated', 'former'].includes(String(emp.status))) {
      return Response.json(
        { error: 'This employee has already exited' },
        { status: 409 },
      );
    }

    // One open resignation per employee — a second submit is a duplicate.
    const open = db
      .prepare(
        `SELECT id FROM hr_resignations
         WHERE employee_id = ? AND status IN ('submitted', 'manager_approved', 'hr_approved')`,
      )
      .get(employee_id);
    if (open) {
      return Response.json(
        { error: 'This employee already has an open resignation' },
        { status: 409 },
      );
    }

    // notice_days: explicit value wins; when the KEY is absent, default from
    // the employee's own notice_period_days (Phase 1 master data).
    const notice_days = Object.prototype.hasOwnProperty.call(body ?? {}, 'notice_days')
      ? int0(body.notice_days)
      : int0(emp.notice_period_days);
    const last_working_date = addDays(resignation_date, notice_days);

    const id = generateId();
    const record = {
      id,
      employee_id,
      resignation_date,
      notice_days,
      last_working_date,
      reason: s(body?.reason),
      status: 'submitted',
      created_by: me.email,
    };

    const create = db.transaction(() => {
      db.prepare(
        `INSERT INTO hr_resignations (
           id, employee_id, resignation_date, notice_days, last_working_date,
           reason, status, created_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id, record.employee_id, record.resignation_date, record.notice_days,
        record.last_working_date, record.reason, record.status, record.created_by,
      );
      logAuditEvent(db, {
        event_type: 'hr.resignation.submit',
        entity_type: 'hr_resignation',
        entity_id: id,
        actor_email: me.email,
        after: record,
      });
    });
    create();

    const resignation = db.prepare(`${RESIGNATION_SELECT} WHERE r.id = ?`).get(id) as any;
    return Response.json({ resignation });
  } catch (e) {
    console.error('[hr-exits] POST failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to submit resignation' }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }

  const id = s(body?.id);
  if (!id) return Response.json({ error: 'id is required' }, { status: 400 });

  const action = s(body?.action);
  if (action) return decideResignation(request, me, id, action, s(body?.note));

  const status = s(body?.status);
  if (status) return updateClearanceItem(request, me, id, status, body);

  return Response.json(
    { error: 'Provide an action (decision) or a status (clearance item)' },
    { status: 400 },
  );
}

/** The resignation status ladder — every decision is canAdminHr. */
async function decideResignation(
  request: Request,
  me: any,
  id: string,
  action: string,
  note: string,
): Promise<Response> {
  if (!['manager_approve', 'hr_approve', 'withdraw', 'complete'].includes(action)) {
    return Response.json({ error: 'Unknown action' }, { status: 400 });
  }
  if (!canAdminHr(me)) {
    return Response.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    const db = getDb();
    const resignation = db
      .prepare('SELECT * FROM hr_resignations WHERE id = ?')
      .get(id) as any;
    if (!resignation) {
      return Response.json({ error: 'Resignation was not found' }, { status: 404 });
    }

    const audit = (after: Record<string, unknown>) =>
      logAuditEvent(db, {
        event_type: 'hr.resignation.decide',
        entity_type: 'hr_resignation',
        entity_id: id,
        actor_email: me.email,
        before: { status: resignation.status },
        after: { action, ...after },
        note,
      });

    if (action === 'manager_approve') {
      // Status-guarded UPDATE: a lost race is a 409, never a clobber.
      const upd = db.transaction(() => {
        const r = db
          .prepare(
            `UPDATE hr_resignations
             SET status = 'manager_approved', manager_by = ?, manager_at = datetime('now')
             WHERE id = ? AND status = 'submitted'`,
          )
          .run(me.email, id);
        if (r.changes === 0) return false;
        audit({ status: 'manager_approved' });
        return true;
      });
      if (!upd()) {
        return Response.json(
          { error: 'This resignation is not awaiting manager approval' },
          { status: 409 },
        );
      }
    } else if (action === 'hr_approve') {
      // hr_approve seeds the clearance checklist in the SAME transaction.
      // Clearance is keyed per-EMPLOYEE (UNIQUE(employee_id, item)), so any
      // rows left from a PREVIOUS cycle are RESET to 'pending' first — a
      // second resignation must never complete on stale cleared/waived items.
      // Missing items are then seeded (INSERT OR IGNORE skips survivors).
      const upd = db.transaction(() => {
        const r = db
          .prepare(
            `UPDATE hr_resignations
             SET status = 'hr_approved', hr_by = ?, hr_at = datetime('now')
             WHERE id = ? AND status = 'manager_approved'`,
          )
          .run(me.email, id);
        if (r.changes === 0) return false;
        const reset = db
          .prepare(
            `UPDATE hr_exit_clearance
             SET status = 'pending', cleared_by = '', cleared_at = ''
             WHERE employee_id = ? AND status != 'pending'`,
          )
          .run(resignation.employee_id);
        const seed = db.prepare(
          `INSERT OR IGNORE INTO hr_exit_clearance (id, employee_id, item, status)
           VALUES (?, ?, ?, 'pending')`,
        );
        for (const item of EXIT_CLEARANCE_ITEMS) {
          seed.run(generateId(), resignation.employee_id, item);
        }
        audit({
          status: 'hr_approved',
          seeded_items: EXIT_CLEARANCE_ITEMS,
          reset_clearance_rows: reset.changes,
        });
        return true;
      });
      if (!upd()) {
        return Response.json(
          { error: 'This resignation is not awaiting HR approval' },
          { status: 409 },
        );
      }
    } else if (action === 'withdraw') {
      const upd = db.transaction(() => {
        const r = db
          .prepare(
            `UPDATE hr_resignations
             SET status = 'withdrawn'
             WHERE id = ? AND status IN ('${OPEN_STATUSES.join("', '")}')`,
          )
          .run(id);
        if (r.changes === 0) return false;
        audit({ status: 'withdrawn' });
        return true;
      });
      if (!upd()) {
        return Response.json(
          { error: 'This resignation can no longer be withdrawn' },
          { status: 409 },
        );
      }
    } else {
      // action === 'complete' — the terminal step. Everything (clearance
      // check, guarded status flip, employee update, audit) is ONE txn; all
      // values are resolved before it opens (no awaits inside).
      const employee = db
        .prepare('SELECT id, status, user_id FROM hr_employees WHERE id = ?')
        .get(resignation.employee_id) as any;
      const exit_date = s(resignation.last_working_date) || todayIST();

      let pendingItems: string[] = [];
      const upd = db.transaction(() => {
        pendingItems = (
          db
            .prepare(
              `SELECT item FROM hr_exit_clearance
               WHERE employee_id = ? AND status = 'pending' ORDER BY item`,
            )
            .all(resignation.employee_id) as { item: string }[]
        ).map((r) => r.item);
        if (pendingItems.length > 0) {
          throw Object.assign(new Error('clearance pending'), { hrCode: 'CLEARANCE_PENDING' });
        }

        const r = db
          .prepare(
            `UPDATE hr_resignations SET status = 'completed'
             WHERE id = ? AND status = 'hr_approved'`,
          )
          .run(id);
        if (r.changes === 0) {
          throw Object.assign(new Error('not hr_approved'), { hrCode: 'BAD_STATUS' });
        }

        // Direct UPDATE of hr_employees is allowed — it is OUR table.
        // users.is_active is NEVER written here (contract D1: HR proposes
        // login deactivation to the admin, it never performs it).
        if (employee) {
          db.prepare(
            `UPDATE hr_employees
             SET status = 'former', exit_date = ?, updated_at = datetime('now')
             WHERE id = ?`,
          ).run(exit_date, employee.id);
        }

        audit({
          status: 'completed',
          employee_id: resignation.employee_id,
          employee_status: 'former',
          exit_date,
        });
      });

      try {
        upd();
      } catch (e: any) {
        if (e?.hrCode === 'CLEARANCE_PENDING') {
          return Response.json(
            {
              error: `Cannot complete - clearance still pending: ${pendingItems.join(', ')}`,
              pending_items: pendingItems,
            },
            { status: 409 },
          );
        }
        if (e?.hrCode === 'BAD_STATUS') {
          return Response.json(
            { error: 'Only an HR-approved resignation can be completed' },
            { status: 409 },
          );
        }
        throw e;
      }

      const updated = db.prepare(`${RESIGNATION_SELECT} WHERE r.id = ?`).get(id) as any;
      const linked = employee?.user_id
        ? (db.prepare('SELECT email FROM users WHERE id = ?').get(employee.user_id) as any)
        : null;
      return Response.json({
        resignation: updated,
        // D1: suggestion only — deactivating the login stays an explicit
        // admin action on /users, never an HR side effect.
        suggest_deactivate_login: !!employee?.user_id,
        linked_user_email: linked?.email || null,
      });
    }

    const updated = db.prepare(`${RESIGNATION_SELECT} WHERE r.id = ?`).get(id) as any;
    return Response.json({ resignation: updated });
  } catch (e) {
    console.error('[hr-exits] PATCH decide failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to update resignation' }, { status: 500 });
  }
}

/** Clearance item update ({id, status cleared|waived, note}) — canAdminHr:
 *  the /hr/exits page is adminOnly in the catalog, so every verb here
 *  matches; the admin-gated 'complete' above stays the decision boundary. */
async function updateClearanceItem(
  request: Request,
  me: any,
  id: string,
  status: string,
  body: any,
): Promise<Response> {
  if (!canAdminHr(me)) {
    return Response.json({ error: 'Admin access required' }, { status: 403 });
  }
  if (status !== 'cleared' && status !== 'waived') {
    return Response.json({ error: 'Status must be cleared or waived' }, { status: 400 });
  }

  try {
    const db = getDb();
    const existing = db
      .prepare('SELECT * FROM hr_exit_clearance WHERE id = ?')
      .get(id) as any;
    if (!existing) {
      return Response.json({ error: 'Clearance item was not found' }, { status: 404 });
    }

    const hasNote = Object.prototype.hasOwnProperty.call(body ?? {}, 'note');
    const note = hasNote ? s(body.note) : String(existing.note ?? '');

    const update = db.transaction(() => {
      db.prepare(
        `UPDATE hr_exit_clearance
         SET status = ?, note = ?, cleared_by = ?, cleared_at = datetime('now')
         WHERE id = ?`,
      ).run(status, note, me.email, id);
      const after = db.prepare('SELECT * FROM hr_exit_clearance WHERE id = ?').get(id);
      logAuditEvent(db, {
        event_type: 'hr.exit_clearance.update',
        entity_type: 'hr_exit_clearance',
        entity_id: id,
        actor_email: me.email,
        before: existing,
        after,
      });
    });
    update();

    const clearance = db.prepare('SELECT * FROM hr_exit_clearance WHERE id = ?').get(id) as any;
    return Response.json({ clearance });
  } catch (e) {
    console.error('[hr-exits] PATCH clearance failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to update clearance item' }, { status: 500 });
  }
}
