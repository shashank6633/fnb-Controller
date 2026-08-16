/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { canAdminHr, canManageHr, type HrDesignation } from '@/lib/hr';

/**
 * HR Designations master (/api/hr/designations).
 *
 * Contract: docs/HRMS_DECISIONS.md (D2 — designations are a NEW hr_ master;
 * users.position free text stays untouched). Rows are soft-deleted only
 * (is_active = 0) — hr_employees.designation_id references live forever.
 *
 * GET    /api/hr/designations?include_inactive=1 → { designations }
 *          Management tier (admin | manager | HOD). The proxy does NOT guard
 *          API GETs — this check is the security boundary.
 * POST   /api/hr/designations { name, department_id?, grade? } → { designation }
 *          Admin only. 409 on COLLATE NOCASE duplicate name.
 * PUT    /api/hr/designations { id, name?, department_id?, grade?, is_active? }
 *          → { designation }. Admin only. Rename runs the same dup check.
 * DELETE /api/hr/designations?id=   (id also accepted in a JSON body)
 *          → { ok: true }. Admin only. Soft deactivate — ALWAYS allowed, even
 *          while employees still reference the designation: deactivation only
 *          hides it from pickers; holders keep the label (LEFT JOIN renders it).
 *
 * Error bodies are GENERIC on 500 (never e.message — HR data must not leak
 * schema/details through errors).
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }
  try {
    const url = new URL(request.url);
    const includeInactive = url.searchParams.get('include_inactive') === '1';
    const db = getDb();
    const sql =
      `SELECT * FROM hr_designations` +
      (includeInactive ? '' : ` WHERE is_active = 1`) +
      ` ORDER BY is_active DESC, name ASC`;
    const designations = db.prepare(sql).all() as HrDesignation[];
    return Response.json({ designations });
  } catch (e) {
    console.error('GET /api/hr/designations failed:', e);
    return Response.json({ error: 'Failed to load designations' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) return Response.json({ error: 'Admin role required' }, { status: 403 });

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }
  const name = String(body?.name || '').trim();
  const departmentId = String(body?.department_id || '').trim();
  const grade = String(body?.grade || '').trim();
  if (!name) return Response.json({ error: 'Designation name is required' }, { status: 400 });

  // better-sqlite3 is synchronous — resolve every await BEFORE touching the DB.
  const outletId = await getCurrentOutletId();

  try {
    const db = getDb();
    const dupe = db.prepare(`SELECT id FROM hr_designations WHERE name = ? COLLATE NOCASE`).get(name) as any;
    if (dupe) return Response.json({ error: 'A designation with that name already exists' }, { status: 409 });

    const id = generateId();
    db.prepare(
      `INSERT INTO hr_designations (id, name, department_id, grade) VALUES (?, ?, ?, ?)`,
    ).run(id, name, departmentId, grade);

    const designation = db.prepare(`SELECT * FROM hr_designations WHERE id = ?`).get(id) as HrDesignation;
    logAuditEvent(db, {
      event_type: 'hr.designation.create',
      entity_type: 'hr_designation',
      entity_id: id,
      actor_email: me.email,
      outlet_id: outletId,
      after: designation,
    });
    return Response.json({ designation });
  } catch (e) {
    console.error('POST /api/hr/designations failed:', e);
    return Response.json({ error: 'Failed to create designation' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) return Response.json({ error: 'Admin role required' }, { status: 403 });

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }
  const id = String(body?.id || '').trim();
  if (!id) return Response.json({ error: 'Designation id is required' }, { status: 400 });

  const outletId = await getCurrentOutletId();

  try {
    const db = getDb();
    const existing = db.prepare(`SELECT * FROM hr_designations WHERE id = ?`).get(id) as HrDesignation | undefined;
    if (!existing) return Response.json({ error: 'Designation not found' }, { status: 404 });

    const sets: string[] = [];
    const args: any[] = [];
    if (body.name !== undefined) {
      const name = String(body.name || '').trim();
      if (!name) return Response.json({ error: 'Designation name cannot be empty' }, { status: 400 });
      const dupe = db
        .prepare(`SELECT id FROM hr_designations WHERE name = ? COLLATE NOCASE AND id != ?`)
        .get(name, id) as any;
      if (dupe) return Response.json({ error: 'A designation with that name already exists' }, { status: 409 });
      sets.push('name = ?'); args.push(name);
    }
    if (body.department_id !== undefined) {
      sets.push('department_id = ?'); args.push(String(body.department_id || '').trim());
    }
    if (body.grade !== undefined) {
      sets.push('grade = ?'); args.push(String(body.grade || '').trim());
    }
    if (body.is_active !== undefined) {
      sets.push('is_active = ?'); args.push(body.is_active ? 1 : 0);
    }
    if (!sets.length) return Response.json({ error: 'Nothing to update' }, { status: 400 });

    sets.push(`updated_at = datetime('now')`);
    db.prepare(`UPDATE hr_designations SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);

    const designation = db.prepare(`SELECT * FROM hr_designations WHERE id = ?`).get(id) as HrDesignation;
    logAuditEvent(db, {
      event_type: 'hr.designation.update',
      entity_type: 'hr_designation',
      entity_id: id,
      actor_email: me.email,
      outlet_id: outletId,
      before: existing,
      after: designation,
    });
    return Response.json({ designation });
  } catch (e) {
    console.error('PUT /api/hr/designations failed:', e);
    return Response.json({ error: 'Failed to update designation' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) return Response.json({ error: 'Admin role required' }, { status: 403 });

  // House style is ?id= (vendors, tasks/*); the module contract writes DELETE { id }.
  // Accept both so neither caller shape breaks.
  const url = new URL(request.url);
  let id = String(url.searchParams.get('id') || '').trim();
  if (!id) {
    try {
      const body: any = await request.json();
      id = String(body?.id || '').trim();
    } catch { /* no body — handled below */ }
  }
  if (!id) return Response.json({ error: 'Designation id is required' }, { status: 400 });

  const outletId = await getCurrentOutletId();

  try {
    const db = getDb();
    const existing = db.prepare(`SELECT * FROM hr_designations WHERE id = ?`).get(id) as HrDesignation | undefined;
    if (!existing) return Response.json({ error: 'Designation not found' }, { status: 404 });

    // Soft deactivate is ALWAYS allowed — no in-use guard. Deactivation only
    // hides the designation from pickers; employees holding it keep the label.
    db.prepare(`UPDATE hr_designations SET is_active = 0, updated_at = datetime('now') WHERE id = ?`).run(id);
    logAuditEvent(db, {
      event_type: 'hr.designation.deactivate',
      entity_type: 'hr_designation',
      entity_id: id,
      actor_email: me.email,
      outlet_id: outletId,
      before: existing,
      after: { ...existing, is_active: 0 },
    });
    return Response.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/hr/designations failed:', e);
    return Response.json({ error: 'Failed to deactivate designation' }, { status: 500 });
  }
}
