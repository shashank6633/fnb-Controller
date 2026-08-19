/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { canManageHr, isHrTrainingStatus } from '@/lib/hr';
import { EXITED_STATUSES } from '@/lib/hr-attendance';
import { reportServerError } from '@/lib/error-alerts';
import { todayIST } from '@/lib/format-date';

/**
 * HR Trainings (/api/hr/trainings) — Phase 5.
 * Contract: docs/HRMS_DECISIONS.md (§5 hr_trainings / hr_training_assignments;
 * employee_id = hr_employees.id, actors = me.email — never mixed).
 *
 * GET  ?training_id=<id>
 *        → { training, assignments }
 *      One training (LEFT-JOINed department_name / sop_title) + every
 *      assignment row with employee_name / employee_code (LEFT JOIN — a
 *      dangling employee_id degrades to blank, never drops the row).
 * GET  ?q=&department_id=&is_active=&page=&pageSize=
 *        → { rows, total, page, pageSize }
 *      Server-side pagination (default 25, cap 100). Each row is an
 *      hr_trainings row + department_name + sop_title + assigned_count /
 *      completed_count.
 *
 * POST { name (required), trainer?, sop_id?, department_id? } → { training }
 *      Referenced rows are validated at CREATE (400 with a named message);
 *      reads stay LEFT-JOIN tolerant. Duplicate active name → 409.
 * POST { action:'assign', training_id, employee_ids: string[], due_date? }
 *        → { assigned, skipped, assignments }
 *      Bulk-assigns the training. Employees already holding the
 *      UNIQUE(training_id, employee_id) row are SKIPPED (counted, never an
 *      error); the rest are inserted in ONE transaction with
 *      assigned_date = today (IST), status 'assigned', assigned_by = me.email.
 *      Exited employees (EXITED_STATUSES from hr-attendance — resigned/
 *      terminated/former) are refused with a named 400; suspended staff MAY
 *      be assigned (suspension blocks punches, not training).
 *      Audit: hr.training.assign.
 *
 * PUT  { id, name?, trainer?, sop_id?, department_id?, is_active? } → { training }
 * PATCH { id, status?, score?, remarks?, due_date?, completed_date? } → { assignment }
 *      Updates ONE assignment (id = hr_training_assignments.id). status is
 *      vocab-validated (isHrTrainingStatus); score is null or 0-100; moving to
 *      'completed' stamps completed_date = today (IST) when none is supplied.
 * DELETE ?id= → { ok: true }        (soft: is_active = 0 — rows never removed)
 *
 * Every verb gates through getCurrentUser + canManageHr ('@/lib/hr') — the
 * proxy does NOT protect API GETs (HRMS_DECISIONS §2.1). Errors return
 * GENERIC messages only — e.message can leak schema/PII for HR data.
 */
export const dynamic = 'force-dynamic';

/** Trimmed string from any body value ('' for null/undefined). */
function s(v: unknown): string {
  return String(v ?? '').trim();
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Training + joined display names + assignment counters. */
const TRAINING_SELECT = `
  SELECT t.*,
         d.name  AS department_name,
         sp.title AS sop_title,
         (SELECT COUNT(*) FROM hr_training_assignments a WHERE a.training_id = t.id) AS assigned_count,
         (SELECT COUNT(*) FROM hr_training_assignments a
           WHERE a.training_id = t.id AND a.status = 'completed') AS completed_count
  FROM hr_trainings t
  LEFT JOIN departments d ON d.id = t.department_id
  LEFT JOIN hr_sops sp    ON sp.id = t.sop_id
`;

/** Assignment + employee display names (LEFT JOIN — dangling ids stay blank). */
const ASSIGNMENT_SELECT = `
  SELECT a.*,
         e.full_name AS employee_name,
         e.employee_code AS employee_code
  FROM hr_training_assignments a
  LEFT JOIN hr_employees e ON e.id = a.employee_id
`;

/** One training with joined names, or null. */
function loadTraining(db: any, id: string): any {
  return db.prepare(`${TRAINING_SELECT} WHERE t.id = ?`).get(id) ?? null;
}

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }

  try {
    const sp = new URL(request.url).searchParams;

    // ---- detail: one training + its assignment roster ----
    const training_id = s(sp.get('training_id'));
    if (training_id) {
      const db = getDb();
      const training = loadTraining(db, training_id);
      if (!training) {
        return Response.json({ error: 'Training not found' }, { status: 404 });
      }
      const assignments = db
        .prepare(
          `${ASSIGNMENT_SELECT} WHERE a.training_id = ?
           ORDER BY e.full_name COLLATE NOCASE, a.id`,
        )
        .all(training_id);
      return Response.json({ training, assignments });
    }

    // ---- list ----
    // parseInt (not Number) so a float can't reach LIMIT/OFFSET and trip
    // SQLite's "datatype mismatch" 500 (the crm-calls convention).
    const page = Math.max(1, parseInt(sp.get('page') || '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(sp.get('pageSize') || '25', 10) || 25));

    // ONE clause + params feeds both COUNT(*) and the page query, so total
    // and rows can never disagree.
    const clauses: string[] = [];
    const params: any[] = [];
    const q = s(sp.get('q'));
    if (q) {
      clauses.push('(t.name LIKE ? OR t.trainer LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }
    const department_id = s(sp.get('department_id'));
    if (department_id) {
      clauses.push('t.department_id = ?');
      params.push(department_id);
    }
    const is_active = s(sp.get('is_active'));
    if (is_active === '0' || is_active === '1') {
      clauses.push('t.is_active = ?');
      params.push(parseInt(is_active, 10));
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const db = getDb();
    const totalRow = db
      .prepare(`SELECT COUNT(*) AS n FROM hr_trainings t ${where}`)
      .get(...params) as { n: number };

    const rows = db
      .prepare(
        `${TRAINING_SELECT} ${where}
         ORDER BY t.name COLLATE NOCASE, t.id
         LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, (page - 1) * pageSize);

    return Response.json({ rows, total: totalRow.n, page, pageSize });
  } catch (e) {
    console.error('[hr-trainings] GET failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to load trainings' }, { status: 500 });
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

    // ---- bulk assign ----
    if (s(body?.action) === 'assign') {
      const training_id = s(body?.training_id);
      if (!training_id) {
        return Response.json({ error: 'Training is required' }, { status: 400 });
      }
      const due_date = s(body?.due_date);
      if (due_date && !DATE_RE.test(due_date)) {
        return Response.json({ error: 'Invalid due date (expected YYYY-MM-DD)' }, { status: 400 });
      }

      // De-duplicated, blank-free employee id list, capped to keep the IN()
      // bind list and the write burst sane.
      const rawIds: unknown[] = Array.isArray(body?.employee_ids) ? body.employee_ids : [];
      const employeeIds = [...new Set(rawIds.map((v) => s(v)).filter(Boolean))];
      if (employeeIds.length === 0) {
        return Response.json({ error: 'Select at least one employee' }, { status: 400 });
      }
      if (employeeIds.length > 500) {
        return Response.json(
          { error: 'Too many employees in one assignment (max 500)' },
          { status: 400 },
        );
      }

      const db = getDb();
      // CREATE validates the referenced rows exist (reads stay LEFT-JOIN
      // tolerant; writes do not get to invent trainings or people).
      const training = db
        .prepare('SELECT * FROM hr_trainings WHERE id = ?')
        .get(training_id) as any;
      if (!training) {
        return Response.json({ error: 'Selected training was not found' }, { status: 400 });
      }
      if (!training.is_active) {
        return Response.json(
          { error: 'This training is inactive - reactivate it before assigning' },
          { status: 400 },
        );
      }
      const marks = employeeIds.map(() => '?').join(',');
      const found = db
        .prepare(`SELECT id, full_name, status FROM hr_employees WHERE id IN (${marks})`)
        .all(...employeeIds) as { id: string; full_name: string; status: string }[];
      if (found.length !== employeeIds.length) {
        return Response.json(
          { error: 'One or more selected employees were not found' },
          { status: 400 },
        );
      }
      // Exit gate (engine's exported subset — never re-declared): employees
      // who have LEFT (resigned/terminated/former) cannot be assigned
      // training. Suspended staff MAY train — suspension blocks punches, not
      // learning — so only exits are refused here.
      const exited = found.filter((e) => EXITED_STATUSES.has(String(e.status ?? '').trim()));
      if (exited.length > 0) {
        return Response.json(
          {
            error:
              `Cannot assign: ${exited.map((e) => e.full_name).join(', ')} ` +
              `${exited.length === 1 ? 'has' : 'have'} exited (resigned/terminated/former). ` +
              'Suspended staff may still be assigned training.',
          },
          { status: 400 },
        );
      }

      // UNIQUE(training_id, employee_id): already-assigned employees are
      // SKIPPED (reported, never an error) so re-assigning a department after
      // a new joiner arrives is a safe, idempotent gesture.
      const existing = db
        .prepare(
          `SELECT employee_id FROM hr_training_assignments
           WHERE training_id = ? AND employee_id IN (${marks})`,
        )
        .all(training_id, ...employeeIds) as { employee_id: string }[];
      const already = new Set(existing.map((r) => r.employee_id));
      const toCreate = employeeIds.filter((id) => !already.has(id));

      const assigned_date = todayIST();
      const created = toCreate.map((employee_id) => ({ id: generateId(), employee_id }));
      const ins = db.prepare(
        `INSERT INTO hr_training_assignments
           (id, training_id, employee_id, assigned_date, due_date, status, assigned_by)
         VALUES (?, ?, ?, ?, ?, 'assigned', ?)`,
      );
      const tx = db.transaction(() => {
        for (const c of created) {
          ins.run(c.id, training_id, c.employee_id, assigned_date, due_date, me.email);
        }
        logAuditEvent(db, {
          event_type: 'hr.training.assign',
          entity_type: 'hr_training',
          entity_id: training_id,
          actor_email: me.email,
          after: {
            training_id,
            training_name: training.name,
            employee_ids: created.map((c) => c.employee_id),
            due_date,
            assigned: created.length,
            skipped: already.size,
          },
        });
      });
      if (created.length > 0) tx();

      const assignments = created.length
        ? db
            .prepare(
              `${ASSIGNMENT_SELECT}
               WHERE a.id IN (${created.map(() => '?').join(',')})
               ORDER BY e.full_name COLLATE NOCASE, a.id`,
            )
            .all(...created.map((c) => c.id))
        : [];
      return Response.json({ assigned: created.length, skipped: already.size, assignments });
    }

    // ---- create training ----
    const name = s(body?.name);
    if (!name) return Response.json({ error: 'Training name is required' }, { status: 400 });

    const trainer = s(body?.trainer);
    const sop_id = s(body?.sop_id);
    const department_id = s(body?.department_id);

    const db = getDb();
    const dupe = db
      .prepare('SELECT id FROM hr_trainings WHERE name = ? COLLATE NOCASE AND is_active = 1')
      .get(name) as any;
    if (dupe) {
      return Response.json(
        { error: 'An active training with that name already exists' },
        { status: 409 },
      );
    }
    // Referenced rows validated at CREATE (400, named) — reads stay tolerant.
    if (sop_id) {
      const sop = db.prepare('SELECT id FROM hr_sops WHERE id = ?').get(sop_id) as any;
      if (!sop) return Response.json({ error: 'Selected SOP was not found' }, { status: 400 });
    }
    if (department_id) {
      const dept = db.prepare('SELECT id FROM departments WHERE id = ?').get(department_id) as any;
      if (!dept) {
        return Response.json({ error: 'Selected department was not found' }, { status: 400 });
      }
    }

    const id = generateId();
    const create = db.transaction(() => {
      db.prepare(
        `INSERT INTO hr_trainings (id, name, trainer, sop_id, department_id, is_active, created_by)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
      ).run(id, name, trainer, sop_id, department_id, me.email);
      logAuditEvent(db, {
        event_type: 'hr.training.create',
        entity_type: 'hr_training',
        entity_id: id,
        actor_email: me.email,
        after: { id, name, trainer, sop_id, department_id, created_by: me.email },
      });
    });
    create();

    return Response.json({ training: loadTraining(db, id) });
  } catch (e) {
    console.error('[hr-trainings] POST failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to save the training' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }

  try {
    let body: any = {};
    try { body = await request.json(); } catch { /* handled below */ }
    const id = s(body?.id);
    if (!id) return Response.json({ error: 'Training id is required' }, { status: 400 });

    const db = getDb();
    const existing = db.prepare('SELECT * FROM hr_trainings WHERE id = ?').get(id) as any;
    if (!existing) return Response.json({ error: 'Training not found' }, { status: 404 });

    const sets: string[] = [];
    const args: any[] = [];

    if (body.name !== undefined) {
      const name = s(body.name);
      if (!name) return Response.json({ error: 'Training name cannot be empty' }, { status: 400 });
      const dupe = db
        .prepare(
          'SELECT id FROM hr_trainings WHERE name = ? COLLATE NOCASE AND is_active = 1 AND id != ?',
        )
        .get(name, id) as any;
      if (dupe) {
        return Response.json(
          { error: 'An active training with that name already exists' },
          { status: 409 },
        );
      }
      sets.push('name = ?'); args.push(name);
    }
    if (body.trainer !== undefined) {
      sets.push('trainer = ?'); args.push(s(body.trainer));
    }
    if (body.sop_id !== undefined) {
      const sop_id = s(body.sop_id);
      if (sop_id) {
        const sop = db.prepare('SELECT id FROM hr_sops WHERE id = ?').get(sop_id) as any;
        if (!sop) return Response.json({ error: 'Selected SOP was not found' }, { status: 400 });
      }
      sets.push('sop_id = ?'); args.push(sop_id);
    }
    if (body.department_id !== undefined) {
      const department_id = s(body.department_id);
      if (department_id) {
        const dept = db
          .prepare('SELECT id FROM departments WHERE id = ?')
          .get(department_id) as any;
        if (!dept) {
          return Response.json({ error: 'Selected department was not found' }, { status: 400 });
        }
      }
      sets.push('department_id = ?'); args.push(department_id);
    }
    if (body.is_active !== undefined) {
      sets.push('is_active = ?'); args.push(body.is_active ? 1 : 0);
    }
    if (!sets.length) return Response.json({ error: 'Nothing to update' }, { status: 400 });

    const update = db.transaction(() => {
      db.prepare(`UPDATE hr_trainings SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
      const after = db.prepare('SELECT * FROM hr_trainings WHERE id = ?').get(id);
      logAuditEvent(db, {
        event_type: 'hr.training.update',
        entity_type: 'hr_training',
        entity_id: id,
        actor_email: me.email,
        before: existing,
        after,
      });
    });
    update();

    return Response.json({ training: loadTraining(db, id) });
  } catch (e) {
    console.error('[hr-trainings] PUT failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to update the training' }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }

  try {
    let body: any = {};
    try { body = await request.json(); } catch { /* handled below */ }
    const id = s(body?.id);
    if (!id) return Response.json({ error: 'Assignment id is required' }, { status: 400 });

    const db = getDb();
    const existing = db
      .prepare('SELECT * FROM hr_training_assignments WHERE id = ?')
      .get(id) as any;
    if (!existing) return Response.json({ error: 'Assignment not found' }, { status: 404 });

    const sets: string[] = [];
    const args: any[] = [];

    // Vocab gate (400, not silent coercion — a typo'd status must not create a
    // row the list filters can never find).
    let newStatus: string | undefined;
    if (body.status !== undefined) {
      newStatus = s(body.status);
      if (!isHrTrainingStatus(newStatus)) {
        return Response.json({ error: 'Invalid training status' }, { status: 400 });
      }
      sets.push('status = ?'); args.push(newStatus);
    }
    if (body.score !== undefined) {
      // Nullable REAL: explicit null clears; otherwise 0-100.
      if (body.score === null || s(body.score) === '') {
        sets.push('score = NULL');
      } else {
        const score = Number(body.score);
        if (!Number.isFinite(score) || score < 0 || score > 100) {
          return Response.json(
            { error: 'Score must be a number between 0 and 100' },
            { status: 400 },
          );
        }
        sets.push('score = ?'); args.push(Math.round(score * 100) / 100);
      }
    }
    if (body.remarks !== undefined) {
      sets.push('remarks = ?'); args.push(s(body.remarks));
    }
    if (body.due_date !== undefined) {
      const due_date = s(body.due_date);
      if (due_date && !DATE_RE.test(due_date)) {
        return Response.json({ error: 'Invalid due date (expected YYYY-MM-DD)' }, { status: 400 });
      }
      sets.push('due_date = ?'); args.push(due_date);
    }
    if (body.completed_date !== undefined) {
      const completed_date = s(body.completed_date);
      if (completed_date && !DATE_RE.test(completed_date)) {
        return Response.json(
          { error: 'Invalid completed date (expected YYYY-MM-DD)' },
          { status: 400 },
        );
      }
      sets.push('completed_date = ?'); args.push(completed_date);
    } else if (newStatus === 'completed' && !existing.completed_date) {
      // Moving to 'completed' without a date stamps today (IST) — the common
      // "mark done" gesture should not leave a completed row undated.
      sets.push('completed_date = ?'); args.push(todayIST());
    }
    if (!sets.length) return Response.json({ error: 'Nothing to update' }, { status: 400 });

    const update = db.transaction(() => {
      db.prepare(`UPDATE hr_training_assignments SET ${sets.join(', ')} WHERE id = ?`)
        .run(...args, id);
      const after = db.prepare('SELECT * FROM hr_training_assignments WHERE id = ?').get(id);
      logAuditEvent(db, {
        event_type: 'hr.training.assignment.update',
        entity_type: 'hr_training_assignment',
        entity_id: id,
        actor_email: me.email,
        before: existing,
        after,
      });
    });
    update();

    const assignment = db.prepare(`${ASSIGNMENT_SELECT} WHERE a.id = ?`).get(id);
    return Response.json({ assignment });
  } catch (e) {
    console.error('[hr-trainings] PATCH failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to update the assignment' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }

  // House style is ?id= (vendors, hr/designations); DELETE { id } accepted too.
  const url = new URL(request.url);
  let id = s(url.searchParams.get('id'));
  if (!id) {
    try {
      const body: any = await request.json();
      id = s(body?.id);
    } catch { /* no body — handled below */ }
  }
  if (!id) return Response.json({ error: 'Training id is required' }, { status: 400 });

  try {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM hr_trainings WHERE id = ?').get(id) as any;
    if (!existing) return Response.json({ error: 'Training not found' }, { status: 404 });

    // Soft deactivate is ALWAYS allowed — no in-use guard. Assignment rows
    // keep the training's label through their joins; only pickers hide it.
    if (existing.is_active) {
      db.prepare('UPDATE hr_trainings SET is_active = 0 WHERE id = ?').run(id);
      logAuditEvent(db, {
        event_type: 'hr.training.deactivate',
        entity_type: 'hr_training',
        entity_id: id,
        actor_email: me.email,
        before: existing,
        after: { ...existing, is_active: 0 },
      });
    }
    return Response.json({ ok: true });
  } catch (e) {
    console.error('[hr-trainings] DELETE failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to deactivate the training' }, { status: 500 });
  }
}
