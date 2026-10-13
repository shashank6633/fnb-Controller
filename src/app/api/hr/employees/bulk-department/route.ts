import { getDb, logAuditEvent } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { canManageHr } from '@/lib/hr';
import { mainDeptOf } from '@/lib/dept-hierarchy';
import { reportServerError } from '@/lib/error-alerts';

/**
 * BULK DEPARTMENT ASSIGNMENT — POST /api/hr/employees/bulk-department
 *
 * WHY THIS EXISTS. Production carries 129 employees on rolls and 128 of them have
 * NO department. Nothing can be rostered by field until they are classified, and
 * the two existing paths cannot do it:
 *   · PUT /api/hr/employees/[id] sets one employee at a time — 128 round trips
 *     through a modal, which is the kind of job that never gets finished.
 *   · POST /api/hr/employees/import is INSERT-ONLY (it mints fresh EMP-#### codes
 *     inside its transaction). Re-importing the 129 to backfill departments would
 *     create 129 DUPLICATE employees, not update anybody.
 * So this is a bulk UPDATE path, and the only one.
 *
 * IT IS NOT A WEAKER DOOR. Everything PUT enforces, this enforces:
 *   · the same gate — canManageHr (admin | manager | HOD), NOT canAdminHr, or
 *     bulk and single would disagree about who may reassign a department;
 *   · the same 401/403 ladder and the same message strings, so existing client
 *     error handling keeps working;
 *   · the same referenced-row 400s, with the same named messages;
 *   · an explicit column allowlist — the body is never spread into SQL.
 *
 * AND IT CLOSES A GAP PUT LEAVES OPEN. PUT validates department_id and
 * sub_department_id by EXISTENCE ONLY: it never checks that the sub-department is
 * a child of the department. Measured on real data, `department_id = Bar` (a
 * root) with `sub_department_id = Akan Main Kitchen` (a child of Kitchen) passes
 * both guards and is written. The child-ness rule lives only in the browser
 * picker — an inert guard any non-browser caller walks past. A bulk endpoint
 * would widen that to 128 rows in one call, so it is enforced HERE, server-side,
 * via mainDeptOf (the sanctioned one-level lift; do not re-walk parent_id).
 *
 * EXPLICIT IDS ONLY. The body carries the employee ids to change. A filter-shaped
 * body ("everyone matching this search") is refused: the set a manager SAW when
 * they clicked must be the set that changes, and a filter re-evaluated server-side
 * can quietly include someone who was added between the two requests.
 *
 * PER-ROW BEFORE-IMAGES, not just batch counters. The house default is ONE audit
 * event per batch, and that holds — but this route OVERWRITES a column, and there
 * is no undo. The single event therefore carries each row's prior department so a
 * mistaken bulk assign can be reconstructed. Photos are stripped (a base64 image
 * per row would bloat audit_events for nothing).
 */

/** Cap per call. 129 is the entire production headcount, so 250 clears the whole
 *  backlog in one action with room to grow, while still bounding a runaway body.
 *  Checked BEFORE anything is applied — never silently truncated. */
const MAX_BULK_DEPARTMENT = 250;

/** The ONLY columns this route may write. */
const BULK_FIELDS = ['department_id', 'sub_department_id'] as const;

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }

  let body: any = {};
  try { body = await request.json(); } catch { /* field checks below */ }

  // Refuse a filter-shaped body outright rather than quietly ignoring it: a
  // caller that sent `q`/`status` believes it is assigning everyone who matches.
  if (body?.q !== undefined || body?.status !== undefined || body?.filter !== undefined) {
    return Response.json(
      {
        error:
          'Send the employee ids to change, not a filter. Select the rows you want so the set you saw is the set that changes.',
      },
      { status: 400 },
    );
  }

  const ids: string[] = Array.isArray(body?.employee_ids)
    ? [...new Set(body.employee_ids.map((v: any) => String(v ?? '').trim()).filter(Boolean))] as string[]
    : [];
  if (ids.length === 0) {
    return Response.json({ error: 'Select at least one employee' }, { status: 400 });
  }
  if (ids.length > MAX_BULK_DEPARTMENT) {
    return Response.json(
      {
        error: `Too many employees in one go — the limit is ${MAX_BULK_DEPARTMENT}.`,
        cap: MAX_BULK_DEPARTMENT,
        received: ids.length,
      },
      { status: 400 },
    );
  }

  // PRESENCE, not truthiness. PUT treats a key present with '' as "clear this
  // column", and that rule is kept: omitting sub_department_id leaves it alone,
  // sending '' clears it. A body that always shipped sub_department_id would
  // silently wipe every selected employee's sub-department.
  const setsDept = Object.prototype.hasOwnProperty.call(body ?? {}, 'department_id');
  const setsSub = Object.prototype.hasOwnProperty.call(body ?? {}, 'sub_department_id');
  if (!setsDept && !setsSub) {
    return Response.json({ error: 'Nothing to update' }, { status: 400 });
  }
  const deptId = setsDept ? String(body.department_id ?? '').trim() : null;
  const subId = setsSub ? String(body.sub_department_id ?? '').trim() : null;

  // Resolve every await BEFORE db.transaction — better-sqlite3 is synchronous and
  // an await inside the callback silently breaks atomicity (repo-wide rule).
  const outletId = await getCurrentOutletId();

  try {
    const db = getDb();

    // ── Referenced-row validation, same shape and same messages as PUT.
    if (deptId) {
      if (!db.prepare('SELECT id FROM departments WHERE id = ?').get(deptId)) {
        return Response.json({ error: 'Selected department was not found' }, { status: 400 });
      }
    }
    if (subId) {
      if (!db.prepare('SELECT id FROM departments WHERE id = ?').get(subId)) {
        return Response.json({ error: 'Selected sub-department was not found' }, { status: 400 });
      }
      // THE CHECK PUT IS MISSING. A sub-department must belong to the department
      // being set. mainDeptOf walks exactly one level and is orphan-safe.
      if (deptId) {
        const main = mainDeptOf(db, subId);
        if (main && main.id !== deptId) {
          return Response.json(
            {
              error:
                'That sub-department belongs to a different department. Pick a sub-department of the department you selected, or clear it.',
            },
            { status: 400 },
          );
        }
      } else if (setsDept) {
        // department cleared to '' while a sub-department is being set — the
        // orphan shape the schema's own comment forbids.
        return Response.json(
          { error: 'Choose a department before setting a sub-department' },
          { status: 400 },
        );
      }
    }

    const placeholders = ids.map(() => '?').join(',');
    const before = db
      .prepare(
        `SELECT id, employee_code, full_name, department_id, sub_department_id, status
           FROM hr_employees WHERE id IN (${placeholders})`,
      )
      .all(...ids) as Array<Record<string, any>>;

    const found = new Set(before.map((r) => String(r.id)));
    const missing = ids.filter((i) => !found.has(i));
    if (before.length === 0) {
      return Response.json({ error: 'None of those employees were found' }, { status: 404 });
    }

    const sets: string[] = [];
    const setParams: (string | number)[] = [];
    if (setsDept) { sets.push('department_id = ?'); setParams.push(deptId ?? ''); }
    if (setsSub) { sets.push('sub_department_id = ?'); setParams.push(subId ?? ''); }
    sets.push(`updated_at = datetime('now')`);

    const updateOne = db.prepare(
      `UPDATE hr_employees SET ${sets.join(', ')} WHERE id = ?`,
    );

    const apply = db.transaction(() => {
      let changed = 0;
      for (const row of before) {
        const info = updateOne.run(...setParams, row.id);
        changed += info.changes;
      }
      return changed;
    });
    const changed = apply();

    const deptName = deptId
      ? (db.prepare('SELECT name FROM departments WHERE id = ?').get(deptId) as any)?.name ?? deptId
      : '';
    const subName = subId
      ? (db.prepare('SELECT name FROM departments WHERE id = ?').get(subId) as any)?.name ?? subId
      : '';

    // ONE event for the batch, carrying each row's prior department so a wrong
    // bulk assign can be reconstructed — there is no undo for this.
    logAuditEvent(db, {
      event_type: 'hr.employee.bulk_department',
      entity_type: 'hr_employee',
      entity_id: '',
      actor_email: me.email,
      outlet_id: outletId,
      before: { employees: before },
      after: {
        department_id: setsDept ? deptId : '(unchanged)',
        sub_department_id: setsSub ? subId : '(unchanged)',
        changed,
        requested: ids.length,
        not_found: missing,
      },
      note:
        `Bulk department assignment: ${changed} employee(s) set to ` +
        `${setsDept ? (deptName || '(no department)') : '(department unchanged)'}` +
        `${setsSub ? ` / ${subName || '(no sub-department)'}` : ''}` +
        `${missing.length ? `; ${missing.length} id(s) not found` : ''}.`,
    });

    return Response.json({
      success: true,
      changed,
      requested: ids.length,
      not_found: missing,
      department_id: setsDept ? deptId : null,
      department_name: setsDept ? deptName : null,
      sub_department_id: setsSub ? subId : null,
      sub_department_name: setsSub ? subName : null,
    });
  } catch (e) {
    console.error('POST /api/hr/employees/bulk-department failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to assign departments' }, { status: 500 });
  }
}
