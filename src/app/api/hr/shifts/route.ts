/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { canAdminHr, canManageHr, type HrShift } from '@/lib/hr';
import { reportServerError } from '@/lib/error-alerts';

/**
 * HR Shift templates master (/api/hr/shifts) — HRMS Phase 3.
 * Contract: docs/HRMS_DECISIONS.md §8.2.6 — shift templates must support both
 * OVERNIGHT spans (end < start ⇒ the shift crosses midnight into the next
 * calendar day; this is LEGAL, never a validation error — the venue's own
 * evening session runs 18:30 → 01:00) and SPLIT definitions (extra
 * [start, end] windows in split_json). Times are IST clock strings 'HH:MM'.
 *
 * GET    /api/hr/shifts?include_inactive=1 → { shifts }
 *          Management tier (admin | manager | HOD). The proxy does NOT guard
 *          API GETs — this check is the security boundary (HRMS §2.1).
 * POST   /api/hr/shifts { name, start_hhmm?, end_hhmm?, split_json?,
 *          break_minutes?, grace_minutes?, late_after_minutes?,
 *          early_out_before_minutes?, overtime_after_minutes?, department_id? }
 *          → { shift }. Admin only. 409 on a duplicate ACTIVE shift name
 *          (deactivated names may be reused). department_id, when given, must
 *          exist in departments (the mapping contract: validate refs on CREATE).
 * PUT    /api/hr/shifts { id, ...any of the POST fields, is_active? }
 *          → { shift }. Admin only. Partial update; provided HH:MM fields are
 *          re-validated; rename runs the same active-dup check.
 * DELETE /api/hr/shifts?id=   (id also accepted in a JSON body)
 *          → { ok: true }. Admin only. SOFT delete (is_active = 0) — roster
 *          rows referencing the shift keep rendering via LEFT JOIN; only the
 *          pickers hide it.
 *
 * Error bodies are GENERIC on 500 (never e.message — HR data must not leak
 * schema/details through errors).
 */
export const dynamic = 'force-dynamic';

/** IST clock time 'HH:MM' (24h). */
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Trimmed string from any body value ('' for null/undefined). */
function s(v: unknown): string {
  return String(v ?? '').trim();
}

/** Non-negative integer (minutes columns); garbage → 0. */
function int0(v: unknown): number {
  return Math.max(0, parseInt(String(v ?? '0'), 10) || 0);
}

/**
 * Normalise a split_json body value (array OR pre-stringified JSON) into the
 * stored JSON string: an array of [start, end] HH:MM pairs. Returns null when
 * the shape is invalid. Overnight windows (end < start) are LEGAL here too —
 * the same +1-day rule the main span follows.
 */
function normalizeSplitJson(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return '[]';
  let arr: unknown = v;
  if (typeof v === 'string') {
    try { arr = JSON.parse(v); } catch { return null; }
  }
  if (!Array.isArray(arr)) return null;
  const windows: [string, string][] = [];
  for (const w of arr) {
    if (!Array.isArray(w) || w.length !== 2) return null;
    const start = s(w[0]);
    const end = s(w[1]);
    if (!HHMM_RE.test(start) || !HHMM_RE.test(end)) return null;
    windows.push([start, end]);
  }
  return JSON.stringify(windows);
}

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }
  try {
    const includeInactive = new URL(request.url).searchParams.get('include_inactive') === '1';
    const db = getDb();
    const sql =
      `SELECT * FROM hr_shifts` +
      (includeInactive ? '' : ` WHERE is_active = 1`) +
      ` ORDER BY is_active DESC, start_hhmm ASC, name COLLATE NOCASE ASC`;
    const shifts = db.prepare(sql).all() as HrShift[];
    return Response.json({ shifts });
  } catch (e) {
    console.error('GET /api/hr/shifts failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to load shifts' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) return Response.json({ error: 'Admin role required' }, { status: 403 });

  let body: any = {};
  try { body = await request.json(); } catch { /* handled by field checks below */ }

  const name = s(body?.name);
  if (!name) return Response.json({ error: 'Shift name is required' }, { status: 400 });

  const start_hhmm = body?.start_hhmm !== undefined && s(body.start_hhmm) !== '' ? s(body.start_hhmm) : '09:00';
  const end_hhmm = body?.end_hhmm !== undefined && s(body.end_hhmm) !== '' ? s(body.end_hhmm) : '18:00';
  if (!HHMM_RE.test(start_hhmm)) {
    return Response.json({ error: 'Invalid start time (expected HH:MM, 24h)' }, { status: 400 });
  }
  if (!HHMM_RE.test(end_hhmm)) {
    return Response.json({ error: 'Invalid end time (expected HH:MM, 24h)' }, { status: 400 });
  }
  // NOTE deliberately absent: end < start is NOT an error. It is the documented
  // overnight form (§8.2.6) — 18:30 → 01:00 ends on the NEXT calendar day.

  const split_json = normalizeSplitJson(body?.split_json);
  if (split_json === null) {
    return Response.json(
      { error: 'Invalid split windows (expected an array of [HH:MM, HH:MM] pairs)' },
      { status: 400 },
    );
  }

  const department_id = s(body?.department_id);

  // better-sqlite3 is synchronous — resolve every await BEFORE touching the DB.
  const outletId = await getCurrentOutletId();

  try {
    const db = getDb();

    // Mapping contract: department_id → departments.id, validated on CREATE
    // (reads stay LEFT-JOIN tolerant; only writes refuse dangling refs).
    if (department_id) {
      const dept = db.prepare(`SELECT id FROM departments WHERE id = ?`).get(department_id) as any;
      if (!dept) return Response.json({ error: 'Selected department was not found' }, { status: 400 });
    }

    // hr_shifts.name carries no UNIQUE constraint (deactivated names must stay
    // reusable) — the ACTIVE namespace is guarded here instead: two live
    // shifts with one name would make every roster picker ambiguous.
    const dupe = db
      .prepare(`SELECT id FROM hr_shifts WHERE name = ? COLLATE NOCASE AND is_active = 1`)
      .get(name) as any;
    if (dupe) return Response.json({ error: 'An active shift with that name already exists' }, { status: 409 });

    const id = generateId();
    db.prepare(
      `INSERT INTO hr_shifts (
         id, name, start_hhmm, end_hhmm, split_json, break_minutes, grace_minutes,
         late_after_minutes, early_out_before_minutes, overtime_after_minutes, department_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, name, start_hhmm, end_hhmm, split_json,
      int0(body?.break_minutes),
      body?.grace_minutes !== undefined ? int0(body.grace_minutes) : 10,
      body?.late_after_minutes !== undefined ? int0(body.late_after_minutes) : 15,
      body?.early_out_before_minutes !== undefined ? int0(body.early_out_before_minutes) : 15,
      body?.overtime_after_minutes !== undefined ? int0(body.overtime_after_minutes) : 30,
      department_id,
    );

    const shift = db.prepare(`SELECT * FROM hr_shifts WHERE id = ?`).get(id) as HrShift;
    logAuditEvent(db, {
      event_type: 'hr.shift.create',
      entity_type: 'hr_shift',
      entity_id: id,
      actor_email: me.email,
      outlet_id: outletId,
      after: shift,
    });
    return Response.json({ shift });
  } catch (e) {
    console.error('POST /api/hr/shifts failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to create shift' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) return Response.json({ error: 'Admin role required' }, { status: 403 });

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }
  const id = s(body?.id);
  if (!id) return Response.json({ error: 'Shift id is required' }, { status: 400 });

  const outletId = await getCurrentOutletId();

  try {
    const db = getDb();
    const existing = db.prepare(`SELECT * FROM hr_shifts WHERE id = ?`).get(id) as HrShift | undefined;
    if (!existing) return Response.json({ error: 'Shift not found' }, { status: 404 });

    const sets: string[] = [];
    const args: any[] = [];

    if (body.name !== undefined) {
      const name = s(body.name);
      if (!name) return Response.json({ error: 'Shift name cannot be empty' }, { status: 400 });
      const dupe = db
        .prepare(`SELECT id FROM hr_shifts WHERE name = ? COLLATE NOCASE AND is_active = 1 AND id != ?`)
        .get(name, id) as any;
      if (dupe) return Response.json({ error: 'An active shift with that name already exists' }, { status: 409 });
      sets.push('name = ?'); args.push(name);
    }
    if (body.start_hhmm !== undefined) {
      const start = s(body.start_hhmm);
      if (!HHMM_RE.test(start)) {
        return Response.json({ error: 'Invalid start time (expected HH:MM, 24h)' }, { status: 400 });
      }
      sets.push('start_hhmm = ?'); args.push(start);
    }
    if (body.end_hhmm !== undefined) {
      const end = s(body.end_hhmm);
      if (!HHMM_RE.test(end)) {
        return Response.json({ error: 'Invalid end time (expected HH:MM, 24h)' }, { status: 400 });
      }
      // end < start stays LEGAL — the overnight (+1 day) form, §8.2.6.
      sets.push('end_hhmm = ?'); args.push(end);
    }
    if (body.split_json !== undefined) {
      const split = normalizeSplitJson(body.split_json);
      if (split === null) {
        return Response.json(
          { error: 'Invalid split windows (expected an array of [HH:MM, HH:MM] pairs)' },
          { status: 400 },
        );
      }
      sets.push('split_json = ?'); args.push(split);
    }
    for (const col of [
      'break_minutes',
      'grace_minutes',
      'late_after_minutes',
      'early_out_before_minutes',
      'overtime_after_minutes',
    ] as const) {
      if (body[col] !== undefined) {
        sets.push(`${col} = ?`); args.push(int0(body[col]));
      }
    }
    if (body.department_id !== undefined) {
      const department_id = s(body.department_id);
      if (department_id) {
        const dept = db.prepare(`SELECT id FROM departments WHERE id = ?`).get(department_id) as any;
        if (!dept) return Response.json({ error: 'Selected department was not found' }, { status: 400 });
      }
      sets.push('department_id = ?'); args.push(department_id);
    }
    if (body.is_active !== undefined) {
      sets.push('is_active = ?'); args.push(body.is_active ? 1 : 0);
    }
    if (!sets.length) return Response.json({ error: 'Nothing to update' }, { status: 400 });

    sets.push(`updated_at = datetime('now')`);
    db.prepare(`UPDATE hr_shifts SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);

    const shift = db.prepare(`SELECT * FROM hr_shifts WHERE id = ?`).get(id) as HrShift;
    logAuditEvent(db, {
      event_type: 'hr.shift.update',
      entity_type: 'hr_shift',
      entity_id: id,
      actor_email: me.email,
      outlet_id: outletId,
      before: existing,
      after: shift,
    });
    return Response.json({ shift });
  } catch (e) {
    console.error('PUT /api/hr/shifts failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to update shift' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) return Response.json({ error: 'Admin role required' }, { status: 403 });

  // House style is ?id= (vendors, hr/designations); DELETE { id } accepted too.
  const url = new URL(request.url);
  let id = s(url.searchParams.get('id'));
  if (!id) {
    try {
      const body: any = await request.json();
      id = s(body?.id);
    } catch { /* no body — handled below */ }
  }
  if (!id) return Response.json({ error: 'Shift id is required' }, { status: 400 });

  const outletId = await getCurrentOutletId();

  try {
    const db = getDb();
    const existing = db.prepare(`SELECT * FROM hr_shifts WHERE id = ?`).get(id) as HrShift | undefined;
    if (!existing) return Response.json({ error: 'Shift not found' }, { status: 404 });

    // Soft deactivate is ALWAYS allowed — no in-use guard. Roster rows keep
    // the shift's label through their LEFT JOIN; only pickers hide it.
    db.prepare(`UPDATE hr_shifts SET is_active = 0, updated_at = datetime('now') WHERE id = ?`).run(id);
    logAuditEvent(db, {
      event_type: 'hr.shift.deactivate',
      entity_type: 'hr_shift',
      entity_id: id,
      actor_email: me.email,
      outlet_id: outletId,
      before: existing,
      after: { ...existing, is_active: 0 },
    });
    return Response.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/hr/shifts failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to deactivate shift' }, { status: 500 });
  }
}
