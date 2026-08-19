/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { canAdminHr, isHrDisciplinaryKind } from '@/lib/hr';
import { reportServerError } from '@/lib/error-alerts';

/**
 * HR Disciplinary Records (/api/hr/disciplinary) — Phase 6.
 * Contract: docs/HRMS_DECISIONS.md — THE MOST RESTRICTED DATA IN THE MODULE:
 * the page is adminOnly and EVERY verb here, GET included, gates on
 * canAdminHr. Nothing from this table is ever served to a non-admin, and the
 * proxy does not protect API GETs (§2.1) so this handler is the boundary.
 *
 * GET  ?employee_id=&status=&kind=&q=&page=&pageSize=
 *        → { rows, total, page, pageSize }
 *      Rows are hr_disciplinary_records + employee_name / employee_code
 *      (LEFT JOIN hr_employees — a dangling employee_id degrades to blank,
 *      never drops the record).
 *
 * POST { employee_id, subject, kind?, detail?, ... } → { record }
 *      employee_id must be a real hr_employees.id (400 with a named message);
 *      kind is validated against HR_DISCIPLINARY_KINDS (default 'incident').
 *
 * PATCH { id, ...fields } → { record }
 *      Updatable: kind / subject / detail / employee_response /
 *      manager_comment / final_decision / status (open|closed).
 *      employee_id is immutable — a record never moves between people.
 *
 * DELETE ?id= → { ok }   (admin-only removal; the full row is preserved in
 *      the audit event's before snapshot).
 *
 * Errors return GENERIC messages only — e.message can leak PII for HR data.
 * Audit: hr.disciplinary.create / .update / .delete with before/after.
 */
export const dynamic = 'force-dynamic';

/** Trimmed string from any body value ('' for null/undefined). */
function s(v: unknown): string {
  return String(v ?? '').trim();
}

/** Projection shared by list + single reads. */
const DISCIPLINARY_SELECT = `
  SELECT r.*,
         e.full_name AS employee_name,
         e.employee_code AS employee_code
  FROM hr_disciplinary_records r
  LEFT JOIN hr_employees e ON e.id = r.employee_id
`;

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) {
    return Response.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    const sp = new URL(request.url).searchParams;
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
    const kind = s(sp.get('kind'));
    if (kind) {
      clauses.push('r.kind = ?');
      params.push(kind);
    }
    const q = s(sp.get('q'));
    if (q) {
      const like = `%${q}%`;
      clauses.push('(r.subject LIKE ? OR r.detail LIKE ? OR e.full_name LIKE ?)');
      params.push(like, like, like);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const db = getDb();
    const totalRow = db
      .prepare(
        `SELECT COUNT(*) AS n FROM hr_disciplinary_records r
         LEFT JOIN hr_employees e ON e.id = r.employee_id ${where}`,
      )
      .get(...params) as { n: number };
    const rows = db
      .prepare(`${DISCIPLINARY_SELECT} ${where} ORDER BY r.created_at DESC, r.id LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize) as any[];

    return Response.json({ rows, total: totalRow.n, page, pageSize });
  } catch (e) {
    console.error('[hr-disciplinary] GET failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to load disciplinary records' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) {
    return Response.json({ error: 'Admin access required' }, { status: 403 });
  }

  let body: any = {};
  try { body = await request.json(); } catch { /* handled by field checks below */ }

  const employee_id = s(body?.employee_id);
  if (!employee_id) {
    return Response.json({ error: 'Employee is required' }, { status: 400 });
  }
  const subject = s(body?.subject);
  if (!subject) {
    return Response.json({ error: 'Subject is required' }, { status: 400 });
  }
  const kind = body?.kind !== undefined && s(body.kind) !== '' ? s(body.kind) : 'incident';
  if (!isHrDisciplinaryKind(kind)) {
    return Response.json({ error: 'Invalid disciplinary kind' }, { status: 400 });
  }

  try {
    const db = getDb();

    // Referenced-row validation on CREATE (backend mapping rule):
    // employee_id is ALWAYS hr_employees.id, never a users.id or an email.
    const emp = db.prepare('SELECT id FROM hr_employees WHERE id = ?').get(employee_id);
    if (!emp) {
      return Response.json({ error: 'Selected employee was not found' }, { status: 400 });
    }

    const id = generateId();
    const record = {
      id,
      employee_id,
      kind,
      subject,
      detail: s(body?.detail),
      employee_response: s(body?.employee_response),
      manager_comment: s(body?.manager_comment),
      final_decision: s(body?.final_decision),
      status: 'open',
      created_by: me.email,
    };

    const create = db.transaction(() => {
      db.prepare(
        `INSERT INTO hr_disciplinary_records (
           id, employee_id, kind, subject, detail, employee_response,
           manager_comment, final_decision, status, created_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id, record.employee_id, record.kind, record.subject, record.detail,
        record.employee_response, record.manager_comment, record.final_decision,
        record.status, record.created_by,
      );
      logAuditEvent(db, {
        event_type: 'hr.disciplinary.create',
        entity_type: 'hr_disciplinary_record',
        entity_id: id,
        actor_email: me.email,
        after: record,
      });
    });
    create();

    const row = db.prepare(`${DISCIPLINARY_SELECT} WHERE r.id = ?`).get(id) as any;
    return Response.json({ record: row });
  } catch (e) {
    console.error('[hr-disciplinary] POST failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to create disciplinary record' }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) {
    return Response.json({ error: 'Admin access required' }, { status: 403 });
  }

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }

  const id = s(body?.id);
  if (!id) return Response.json({ error: 'Record id is required' }, { status: 400 });

  try {
    const db = getDb();
    const existing = db
      .prepare('SELECT * FROM hr_disciplinary_records WHERE id = ?')
      .get(id) as any;
    if (!existing) {
      return Response.json({ error: 'Record was not found' }, { status: 404 });
    }

    const has = (k: string) => Object.prototype.hasOwnProperty.call(body ?? {}, k);
    const sets: string[] = [];
    const vals: any[] = [];

    if (has('kind')) {
      const kind = s(body.kind);
      if (!isHrDisciplinaryKind(kind)) {
        return Response.json({ error: 'Invalid disciplinary kind' }, { status: 400 });
      }
      sets.push('kind = ?');
      vals.push(kind);
    }
    if (has('subject')) {
      const subject = s(body.subject);
      if (!subject) return Response.json({ error: 'Subject is required' }, { status: 400 });
      sets.push('subject = ?');
      vals.push(subject);
    }
    if (has('detail')) { sets.push('detail = ?'); vals.push(s(body.detail)); }
    if (has('employee_response')) { sets.push('employee_response = ?'); vals.push(s(body.employee_response)); }
    if (has('manager_comment')) { sets.push('manager_comment = ?'); vals.push(s(body.manager_comment)); }
    if (has('final_decision')) { sets.push('final_decision = ?'); vals.push(s(body.final_decision)); }
    if (has('status')) {
      const status = s(body.status);
      if (status !== 'open' && status !== 'closed') {
        return Response.json({ error: 'Status must be open or closed' }, { status: 400 });
      }
      sets.push('status = ?');
      vals.push(status);
    }

    if (sets.length === 0) {
      return Response.json({ error: 'Nothing to update' }, { status: 400 });
    }

    const update = db.transaction(() => {
      db.prepare(
        `UPDATE hr_disciplinary_records
         SET ${sets.join(', ')}, updated_at = datetime('now')
         WHERE id = ?`,
      ).run(...vals, id);
      const after = db.prepare('SELECT * FROM hr_disciplinary_records WHERE id = ?').get(id);
      logAuditEvent(db, {
        event_type: 'hr.disciplinary.update',
        entity_type: 'hr_disciplinary_record',
        entity_id: id,
        actor_email: me.email,
        before: existing,
        after,
      });
    });
    update();

    const row = db.prepare(`${DISCIPLINARY_SELECT} WHERE r.id = ?`).get(id) as any;
    return Response.json({ record: row });
  } catch (e) {
    console.error('[hr-disciplinary] PATCH failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to update disciplinary record' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) {
    return Response.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    const id = s(new URL(request.url).searchParams.get('id'));
    if (!id) return Response.json({ error: 'Record id is required' }, { status: 400 });

    const db = getDb();
    const existing = db
      .prepare('SELECT * FROM hr_disciplinary_records WHERE id = ?')
      .get(id) as any;
    if (!existing) {
      return Response.json({ error: 'Record was not found' }, { status: 404 });
    }

    const remove = db.transaction(() => {
      db.prepare('DELETE FROM hr_disciplinary_records WHERE id = ?').run(id);
      logAuditEvent(db, {
        event_type: 'hr.disciplinary.delete',
        entity_type: 'hr_disciplinary_record',
        entity_id: id,
        actor_email: me.email,
        before: existing,
      });
    });
    remove();

    return Response.json({ ok: true });
  } catch (e) {
    console.error('[hr-disciplinary] DELETE failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to delete disciplinary record' }, { status: 500 });
  }
}
