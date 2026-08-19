import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { canManageHr, canAdminHr } from '@/lib/hr';
import { reportServerError } from '@/lib/error-alerts';

/**
 * HR Biometric mapping (/api/hr/biometric) — Phase 2 biometric readiness.
 * Contract: docs/HRMS_DECISIONS.md §8.1/§8.5 — whatever the final device turns
 * out to be, its connector resolves punches through hr_biometric_map and calls
 * the SAME recordAttendanceEvent() chokepoint. This route is the admin CRUD
 * for that mapping table.
 *
 * GET  ?include_inactive=1
 *        → { mappings } — every mapping row joined to the employee's
 *          full_name/employee_code (LEFT JOIN: a dangling employee_id never
 *          hides the row). Active-only by default; soft-deleted rows appear
 *          only with include_inactive=1.
 * POST { employee_id, biometric_employee_id, device_id? } → { mapping }
 *        409 when (biometric_employee_id, device_id) is already actively
 *        mapped — the device id can only mean ONE person. A soft-deleted row
 *        with the same pair is REVIVED (re-pointed + is_active=1) instead of
 *        violating the UNIQUE index, so a deleted mapping can be re-created.
 * DELETE { id } (body or ?id=) — soft delete (is_active=0), per the house
 *        pattern; punches already recorded through the mapping stay untouched
 *        (hr_attendance_events is append-only).
 *
 * Gates (§2.1 — the proxy does NOT protect API routes): GET canManageHr,
 * mutations canAdminHr. Errors return GENERIC messages only.
 */
export const dynamic = 'force-dynamic';

/** Trimmed string from any body value ('' for null/undefined). */
function s(v: unknown): string {
  return String(v ?? '').trim();
}

/** The list/detail projection: mapping row + joined employee name/code. */
const MAPPING_SELECT = `
  SELECT m.id, m.employee_id, m.biometric_employee_id, m.device_id,
         m.outlet_id, m.is_active, m.created_at, m.updated_at,
         e.full_name     AS employee_name,
         e.employee_code AS employee_code,
         e.status        AS employee_status
  FROM hr_biometric_map m
  LEFT JOIN hr_employees e ON e.id = m.employee_id
`;

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }

  try {
    const sp = new URL(request.url).searchParams;
    const includeInactive = sp.get('include_inactive') === '1';

    const db = getDb();
    const mappings = db
      .prepare(
        `${MAPPING_SELECT}
         ${includeInactive ? '' : 'WHERE m.is_active = 1'}
         ORDER BY e.full_name COLLATE NOCASE, m.biometric_employee_id, m.device_id`,
      )
      .all();

    return Response.json({ mappings });
  } catch (e) {
    console.error('GET /api/hr/biometric failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to load biometric mappings' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) {
    return Response.json({ error: 'Admin access required' }, { status: 403 });
  }

  let body: Record<string, unknown> = {};
  try { body = await request.json(); } catch { /* handled by field checks below */ }

  const employee_id = s(body?.employee_id);
  const biometric_employee_id = s(body?.biometric_employee_id);
  const device_id = s(body?.device_id); // '' = "any device" wildcard mapping

  if (!employee_id) {
    return Response.json({ error: 'Employee is required' }, { status: 400 });
  }
  if (!biometric_employee_id) {
    return Response.json({ error: 'Biometric employee id is required' }, { status: 400 });
  }

  try {
    const db = getDb();

    const emp = db
      .prepare('SELECT id, full_name, home_outlet_id FROM hr_employees WHERE id = ?')
      .get(employee_id) as { id: string; full_name: string; home_outlet_id: string } | undefined;
    if (!emp) {
      return Response.json({ error: 'Selected employee was not found' }, { status: 400 });
    }

    // UNIQUE(biometric_employee_id, device_id) is unconditional (not partial
    // over is_active), so a soft-deleted row must be REVIVED, not re-inserted.
    const existing = db
      .prepare(
        `SELECT id, employee_id, is_active FROM hr_biometric_map
         WHERE biometric_employee_id = ? AND device_id = ?`,
      )
      .get(biometric_employee_id, device_id) as
      | { id: string; employee_id: string; is_active: number }
      | undefined;

    if (existing && existing.is_active) {
      return Response.json(
        {
          error:
            'That biometric id is already mapped on this device — remove the existing mapping first',
        },
        { status: 409 },
      );
    }

    const outlet_id = s(emp.home_outlet_id);
    let id: string;

    const write = db.transaction(() => {
      if (existing) {
        // Revive the soft-deleted pair, re-pointed at the requested employee.
        id = existing.id;
        db.prepare(
          `UPDATE hr_biometric_map
           SET employee_id = ?, outlet_id = ?, is_active = 1, updated_at = datetime('now')
           WHERE id = ?`,
        ).run(employee_id, outlet_id, existing.id);
      } else {
        id = generateId();
        db.prepare(
          `INSERT INTO hr_biometric_map
             (id, employee_id, biometric_employee_id, device_id, outlet_id, is_active)
           VALUES (?, ?, ?, ?, ?, 1)`,
        ).run(id, employee_id, biometric_employee_id, device_id, outlet_id);
      }

      logAuditEvent(db, {
        event_type: 'hr.biometric_map.create',
        entity_type: 'hr_biometric_map',
        entity_id: id,
        actor_email: me.email,
        outlet_id: outlet_id || null,
        before: existing ? { ...existing } : undefined,
        after: { id, employee_id, biometric_employee_id, device_id, outlet_id, is_active: 1 },
        note: existing ? 'revived soft-deleted mapping' : '',
      });
    });

    try {
      write();
    } catch (e: unknown) {
      // Race: two admins claiming the same (biometric id, device) pair — the
      // UNIQUE index is the authority.
      const err = e as { code?: string };
      if (String(err?.code || '').startsWith('SQLITE_CONSTRAINT')) {
        return Response.json(
          {
            error:
              'That biometric id is already mapped on this device — remove the existing mapping first',
          },
          { status: 409 },
        );
      }
      throw e;
    }

    const mapping = db.prepare(`${MAPPING_SELECT} WHERE m.id = ?`).get(id!);
    return Response.json({ mapping });
  } catch (e) {
    console.error('POST /api/hr/biometric failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to save biometric mapping' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) {
    return Response.json({ error: 'Admin access required' }, { status: 403 });
  }

  let body: Record<string, unknown> = {};
  try { body = await request.json(); } catch { /* id may arrive as a query param */ }

  try {
    const sp = new URL(request.url).searchParams;
    const id = s(body?.id) || s(sp.get('id'));
    if (!id) return Response.json({ error: 'Mapping id is required' }, { status: 400 });

    const db = getDb();
    const existing = db
      .prepare(
        `SELECT id, employee_id, biometric_employee_id, device_id, outlet_id, is_active
         FROM hr_biometric_map WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string;
          employee_id: string;
          biometric_employee_id: string;
          device_id: string;
          outlet_id: string;
          is_active: number;
        }
      | undefined;
    if (!existing) {
      return Response.json({ error: 'Mapping not found' }, { status: 404 });
    }

    // Idempotent soft delete — deleting an already-inactive row is a no-op
    // success, matching the house soft-delete convention.
    if (existing.is_active) {
      const remove = db.transaction(() => {
        db.prepare(
          `UPDATE hr_biometric_map SET is_active = 0, updated_at = datetime('now') WHERE id = ?`,
        ).run(id);
        logAuditEvent(db, {
          event_type: 'hr.biometric_map.delete',
          entity_type: 'hr_biometric_map',
          entity_id: id,
          actor_email: me.email,
          outlet_id: existing.outlet_id || null,
          before: { ...existing },
          after: { ...existing, is_active: 0 },
        });
      });
      remove();
    }

    return Response.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/hr/biometric failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to remove biometric mapping' }, { status: 500 });
  }
}
