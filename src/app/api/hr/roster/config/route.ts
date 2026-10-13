/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { canAdminHr, canManageHr, type HrRosterCoverage, type HrRosterShiftMap } from '@/lib/hr';
import { getHrDayCutoff } from '@/lib/hr-attendance';
import { splitShiftInvariantProblem } from '@/lib/hr-roster-generate';
import { reportServerError } from '@/lib/error-alerts';

/**
 * ROSTER GENERATOR CONFIG (/api/hr/roster/config) — HRMS roster Stage 3.
 *
 * The two tables the generator cannot run without, and which NOTHING in the app
 * could write before this route existed. On production every generate refuses
 * with no_coverage + no_shift_map for exactly that reason, so this is the real
 * blocker, not the UI.
 *
 * GET    ?department_id=   → { department_id, coverage, shift_map, designations,
 *                              shifts, roles }
 *          Management tier. Rows the department INHERITS from the shared
 *          department_id='' scope are returned with inherited:true and are
 *          read-only here — they are a default, not this department's row.
 * PUT    { department_id, coverage?: [...], shift_map?: [...] } → { ok, counts }
 *          Admin only. UPSERT of the rows given, all in ONE transaction. It is
 *          never a replace: a row this call does not mention is left alone, so a
 *          half-filled form cannot wipe a configured week.
 * DELETE ?kind=coverage|shift_map&id=   → { ok: true }. Admin only.
 *
 * COVERAGE IS A FLOOR (owner rule 3, verbatim: "minimum present per group per
 * day"). There is deliberately NO max-offs field in this route's vocabulary, and
 * there must never be one: headcount moves with joiners, leavers and approved
 * leave, so a cap of "2 offs" silently becomes a different promise every week
 * while a floor of "6 present" stays the promise the owner actually made.
 *
 * EVERY WEEKDAY NEEDS A SHIFT-MAP ROW, SUNDAY INCLUDED, and Sunday must point at
 * its OWN hr_shifts rows (the owner's Sunday timings differ: MOR BREAK
 * 11:00-16:00 + 19:30-close, SECOND 14:00-close). hr_shifts carries no weekday
 * dimension, so this map is the only bridge; an unmapped pair is a refusal from
 * the generator, never a substitution.
 *
 * DEPARTMENTS AND DESIGNATIONS ARE READ, NEVER CREATED — they are the owner's
 * masters, and no name is hardcoded anywhere here. A write names a real
 * departments.id or it is refused; the stale local database still carries a
 * legacy "Akan Service" department production does not have.
 *
 * Writes are ADMIN (canAdminHr), matching /api/hr/settings and the shifts and
 * designations masters; reads are management (canManageHr), matching the grid.
 * Both verbs re-authenticate: the proxy does NOT guard API routes (HRMS §2.1).
 */
export const dynamic = 'force-dynamic';

/** Cap on rows accepted in one PUT. The whole editor is 7 weekdays × a handful
 *  of groups/roles — far under this. It exists so one request cannot become an
 *  unbounded transaction. */
const MAX_ROWS = 500;

function s(v: unknown): string {
  return String(v ?? '').trim();
}

/** 0..6 weekday, or null. */
function weekday(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 6 ? n : null;
}

/** 'HH:MM' → minutes past midnight; null for anything unparseable. */
function hhmmToMinutes(v: string): number | null {
  const m = String(v ?? '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }

  try {
    const departmentId = s(new URL(request.url).searchParams.get('department_id'));
    const db = getDb();

    // Own rows AND the shared '' defaults, each labelled. The generator resolves
    // own-over-inherited; showing both is what makes an inherited floor visible
    // instead of looking like a department with nothing configured.
    const coverage = db
      .prepare(
        `SELECT c.*, COALESCE(d.name, '') AS designation_name,
                CASE WHEN c.department_id = '' THEN 1 ELSE 0 END AS inherited
           FROM hr_roster_coverage c
           LEFT JOIN hr_designations d ON d.id = c.designation_id
          WHERE c.department_id = ? OR c.department_id = ''
          ORDER BY inherited ASC, designation_name COLLATE NOCASE ASC,
                   c.weekday ASC, c.shift_role COLLATE NOCASE ASC`,
      )
      .all(departmentId) as Array<HrRosterCoverage & { designation_name: string; inherited: number }>;

    const shiftMap = db
      .prepare(
        `SELECT m.*, COALESCE(sh.name, '') AS shift_name,
                COALESCE(sh.start_hhmm, '') AS shift_start_hhmm,
                COALESCE(sh.end_hhmm, '')   AS shift_end_hhmm,
                COALESCE(sh.split_json, '[]') AS shift_split_json,
                sh.is_active AS shift_is_active,
                CASE WHEN m.department_id = '' THEN 1 ELSE 0 END AS inherited
           FROM hr_roster_shift_map m
           LEFT JOIN hr_shifts sh ON sh.id = m.shift_id
          WHERE m.department_id = ? OR m.department_id = ''
          ORDER BY inherited ASC, m.shift_role COLLATE NOCASE ASC, m.weekday ASC`,
      )
      .all(departmentId) as Array<HrRosterShiftMap & Record<string, unknown>>;

    // Designations present in THIS department's people first, then the rest of
    // the active master — a floor may be configured before anyone is hired into
    // the group, but the staffed groups are the ones being looked for.
    const designations = db
      .prepare(
        `SELECT d.id, d.name, d.is_active,
                (SELECT COUNT(*) FROM hr_employees e
                  WHERE e.designation_id = d.id
                    AND (e.department_id = ? OR e.sub_department_id = ?)
                    AND e.status NOT IN ('resigned','terminated','former')) AS headcount
           FROM hr_designations d
          WHERE d.is_active = 1
          ORDER BY headcount DESC, d.name COLLATE NOCASE ASC`,
      )
      .all(departmentId, departmentId) as Array<{
      id: string;
      name: string;
      is_active: number;
      headcount: number;
    }>;

    const shifts = db
      .prepare(
        `SELECT id, name, start_hhmm, end_hhmm, split_json, department_id, is_active
           FROM hr_shifts
          WHERE is_active = 1
          ORDER BY start_hhmm ASC, name COLLATE NOCASE ASC`,
      )
      .all() as Array<Record<string, unknown>>;

    // The role vocabulary already in use anywhere, so the editor can offer the
    // owner's own words (MS / M 2 C / MOR BREAK / SECOND / NIGHT) rather than a
    // hardcoded list of ours. Roles are HIS words; we never invent one.
    const roles = (
      db
        .prepare(
          `SELECT DISTINCT shift_role AS r FROM hr_roster_shift_map WHERE TRIM(shift_role) <> ''
           UNION
           SELECT DISTINCT shift_role AS r FROM hr_roster_coverage WHERE TRIM(shift_role) <> ''
           ORDER BY r COLLATE NOCASE ASC`,
        )
        .all() as Array<{ r: string }>
    ).map((x) => s(x.r));

    return Response.json({ department_id: departmentId, coverage, shift_map: shiftMap, designations, shifts, roles });
  } catch (e) {
    console.error('GET /api/hr/roster/config failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to load roster configuration' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) return Response.json({ error: 'Admin role required' }, { status: 403 });

  let body: any = {};
  try { body = await request.json(); } catch { /* handled by the field checks below */ }

  const departmentId = s(body?.department_id);
  if (!departmentId) {
    return Response.json({ error: 'Pick the department to configure' }, { status: 400 });
  }

  const coverageIn = Array.isArray(body?.coverage) ? body.coverage : [];
  const mapIn = Array.isArray(body?.shift_map) ? body.shift_map : [];
  if (!coverageIn.length && !mapIn.length) {
    return Response.json({ error: 'Nothing to save' }, { status: 400 });
  }
  if (coverageIn.length + mapIn.length > MAX_ROWS) {
    return Response.json({ error: `Too many rows in one save (max ${MAX_ROWS})` }, { status: 400 });
  }

  // better-sqlite3 is synchronous — every await is resolved BEFORE the
  // transaction opens. Nothing may await inside db.transaction().
  const outletId = await getCurrentOutletId();

  try {
    const db = getDb();

    if (!db.prepare(`SELECT id FROM departments WHERE id = ?`).get(departmentId)) {
      return Response.json(
        {
          error:
            'That department does not exist. Departments are set in the app and are read here, ' +
            'never created — a roster keyed on a department name would configure a venue that ' +
            'does not exist.',
        },
        { status: 400 },
      );
    }

    /* ── Validate EVERYTHING first, so the transaction below is all-or-nothing
         and a bad row 12 cannot leave rows 1-11 written. ─────────────────────── */
    const cutoffMin = hhmmToMinutes(getHrDayCutoff(db)) ?? 4 * 60;
    const coverageRows: Array<{ designation_id: string; weekday: number; shift_role: string; min_present: number; note: string }> = [];
    for (const [i, raw] of (coverageIn as any[]).entries()) {
      const wd = weekday(raw?.weekday);
      if (wd === null) {
        return Response.json({ error: `Coverage row ${i + 1}: weekday must be 0 (Sunday) to 6 (Saturday)` }, { status: 400 });
      }
      const designationId = s(raw?.designation_id);
      if (designationId && !db.prepare(`SELECT id FROM hr_designations WHERE id = ?`).get(designationId)) {
        return Response.json({ error: `Coverage row ${i + 1}: that designation does not exist` }, { status: 400 });
      }
      const min = Number(raw?.min_present);
      if (!Number.isFinite(min) || min < 0) {
        // A FLOOR, never a cap — and never a negative one.
        return Response.json(
          { error: `Coverage row ${i + 1}: minimum present must be 0 or more` },
          { status: 400 },
        );
      }
      coverageRows.push({
        designation_id: designationId,
        weekday: wd,
        shift_role: s(raw?.shift_role),
        min_present: Math.round(min),
        note: s(raw?.note).slice(0, 200),
      });
    }

    const mapRows: Array<{ shift_role: string; weekday: number; shift_id: string }> = [];
    for (const [i, raw] of (mapIn as any[]).entries()) {
      const wd = weekday(raw?.weekday);
      if (wd === null) {
        return Response.json({ error: `Shift map row ${i + 1}: weekday must be 0 (Sunday) to 6 (Saturday)` }, { status: 400 });
      }
      const role = s(raw?.shift_role);
      if (!role) {
        return Response.json({ error: `Shift map row ${i + 1}: the shift role is required` }, { status: 400 });
      }
      const shiftId = s(raw?.shift_id);
      if (!shiftId) {
        return Response.json({ error: `Shift map row ${i + 1}: pick the shift this role resolves to` }, { status: 400 });
      }
      const shift = db
        .prepare(`SELECT id, name, start_hhmm, end_hhmm, split_json, is_active FROM hr_shifts WHERE id = ?`)
        .get(shiftId) as any;
      if (!shift) {
        return Response.json({ error: `Shift map row ${i + 1}: that shift does not exist` }, { status: 400 });
      }
      if (!shift.is_active) {
        // The generator refuses a map pointing at a deactivated shift
        // (`shift_inactive`). Accepting it here would store configuration that
        // can only ever produce a refusal.
        return Response.json(
          {
            error:
              `Shift map row ${i + 1}: "${s(shift.name)}" is deactivated. A generated week is a new ` +
              `intent and must target a live shift template.`,
          },
          { status: 400 },
        );
      }
      // Same check, same words, same single implementation the generator uses.
      // Mapping a role onto a reversed split shift would store config that can
      // only ever refuse — and worse, it is the case where LATE silently never
      // fires for everyone on that shift.
      const problem = splitShiftInvariantProblem(
        {
          start_hhmm: s(shift.start_hhmm),
          end_hhmm: s(shift.end_hhmm),
          split_json: String(shift.split_json ?? '[]'),
        },
        cutoffMin,
      );
      if (problem) {
        return Response.json(
          { error: `Shift map row ${i + 1}: "${s(shift.name)}" is stored the wrong way round — ${problem}` },
          { status: 400 },
        );
      }
      mapRows.push({ shift_role: role, weekday: wd, shift_id: shiftId });
    }

    /* ── Write. UPSERT on the UNIQUE keys the schema already enforces:
         coverage(department_id, designation_id, weekday, shift_role) and
         shift_map(department_id, shift_role, weekday). Nothing is deleted — a row
         this call does not mention is left exactly as it is. ────────────────── */
    const upsertCoverage = db.prepare(
      `INSERT INTO hr_roster_coverage
         (id, department_id, designation_id, weekday, shift_role, min_present, note, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(department_id, designation_id, weekday, shift_role) DO UPDATE SET
         min_present = excluded.min_present,
         note        = excluded.note,
         updated_by  = excluded.updated_by,
         updated_at  = datetime('now')`,
    );
    const upsertMap = db.prepare(
      `INSERT INTO hr_roster_shift_map
         (id, department_id, shift_role, weekday, shift_id, updated_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(department_id, shift_role, weekday) DO UPDATE SET
         shift_id   = excluded.shift_id,
         updated_by = excluded.updated_by,
         updated_at = datetime('now')`,
    );

    const write = db.transaction(() => {
      for (const c of coverageRows) {
        upsertCoverage.run(
          generateId(), departmentId, c.designation_id, c.weekday, c.shift_role,
          c.min_present, c.note, me.email,
        );
      }
      for (const m of mapRows) {
        upsertMap.run(generateId(), departmentId, m.shift_role, m.weekday, m.shift_id, me.email);
      }
    });
    write();

    logAuditEvent(db, {
      event_type: 'hr.roster.config.save',
      entity_type: 'hr_roster_config',
      entity_id: departmentId,
      actor_email: me.email,
      outlet_id: outletId,
      after: { department_id: departmentId, coverage: coverageRows, shift_map: mapRows },
    });

    return Response.json({
      ok: true,
      counts: { coverage: coverageRows.length, shift_map: mapRows.length },
    });
  } catch (e) {
    console.error('PUT /api/hr/roster/config failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to save roster configuration' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) return Response.json({ error: 'Admin role required' }, { status: 403 });

  // House style is ?id= (vendors, hr/designations); a JSON body is accepted too.
  const url = new URL(request.url);
  let kind = s(url.searchParams.get('kind'));
  let id = s(url.searchParams.get('id'));
  if (!id || !kind) {
    try {
      const body: any = await request.json();
      kind = kind || s(body?.kind);
      id = id || s(body?.id);
    } catch { /* no body — handled below */ }
  }
  if (kind !== 'coverage' && kind !== 'shift_map') {
    return Response.json({ error: "kind must be 'coverage' or 'shift_map'" }, { status: 400 });
  }
  if (!id) return Response.json({ error: 'Row id is required' }, { status: 400 });

  const outletId = await getCurrentOutletId();
  const table = kind === 'coverage' ? 'hr_roster_coverage' : 'hr_roster_shift_map';

  try {
    const db = getDb();
    const existing = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as any;
    if (!existing) return Response.json({ error: 'That configuration row no longer exists' }, { status: 404 });

    // Config rows carry no history semantics and no is_active column, so this is
    // a real delete. It removes a FLOOR or a MAPPING, which the generator then
    // names as missing on the next run — loudly, never silently.
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    logAuditEvent(db, {
      event_type: `hr.roster.config.delete.${kind}`,
      entity_type: table,
      entity_id: id,
      actor_email: me.email,
      outlet_id: outletId,
      before: existing,
    });
    return Response.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/hr/roster/config failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to remove the configuration row' }, { status: 500 });
  }
}
