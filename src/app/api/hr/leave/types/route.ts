/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { canAdminHr, canManageHr, type HrLeaveType } from '@/lib/hr';
import { reportServerError } from '@/lib/error-alerts';

/**
 * HR Leave Types master (/api/hr/leave/types) — HRMS Phase 3.
 *
 * Contract: docs/HRMS_DECISIONS.md §5 (hr_leave_types). Same shape as the
 * designations master: a small global vocabulary, soft-deleted only
 * (is_active = 0) — hr_leave_requests.leave_type_id / hr_leave_balances
 * references live forever and LEFT JOINs render the label after deactivation.
 *
 * GET    /api/hr/leave/types?include_inactive=1 → { leave_types }
 *          Management tier (admin | manager | HOD). The proxy does NOT guard
 *          API GETs — this check is the security boundary (§2.1).
 * POST   /api/hr/leave/types { name, annual_entitlement?, carry_forward_max?,
 *          encashable?, max_consecutive_days?, is_paid? } → { leave_type }
 *          Admin only. 409 on COLLATE NOCASE duplicate name.
 * PUT    /api/hr/leave/types { id, ...any of the POST fields, is_active? }
 *          → { leave_type }. Admin only. Rename runs the same dup check.
 * DELETE /api/hr/leave/types?id=   (id also accepted in a JSON body)
 *          → { ok: true, pending_requests, warning? }. Admin only. Soft
 *          deactivate — ALWAYS allowed, even while balances/requests still
 *          reference the type: deactivation only hides it from pickers;
 *          existing rows keep the label, and already-pending requests remain
 *          approvable (hr-leave validateRequest accepts an inactive type when
 *          re-validating at approve time). pending_requests counts requests
 *          still in flight; warning names them when the count is non-zero.
 *
 * Error bodies are GENERIC on 500 (never e.message — HR data must not leak
 * schema/details through errors). Audit: hr.leave.type.create/.update/.deactivate.
 */
export const dynamic = 'force-dynamic';

/** Trimmed string from any body value ('' for null/undefined). */
function s(v: unknown): string {
  return String(v ?? '').trim();
}

/** Non-negative REAL (entitlements support 0.5 steps); garbage → 0. */
function real0(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Non-negative integer (day caps); garbage → 0 (0 = no cap). */
function int0(v: unknown): number {
  return Math.max(0, parseInt(String(v ?? '0'), 10) || 0);
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
      `SELECT * FROM hr_leave_types` +
      (includeInactive ? '' : ` WHERE is_active = 1`) +
      ` ORDER BY is_active DESC, name COLLATE NOCASE ASC`;
    const leave_types = db.prepare(sql).all() as HrLeaveType[];
    return Response.json({ leave_types });
  } catch (e) {
    console.error('GET /api/hr/leave/types failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to load leave types' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) return Response.json({ error: 'Admin role required' }, { status: 403 });

  let body: any = {};
  try { body = await request.json(); } catch { /* handled by field checks below */ }
  const name = s(body?.name);
  if (!name) return Response.json({ error: 'Leave type name is required' }, { status: 400 });

  // better-sqlite3 is synchronous — resolve every await BEFORE touching the DB.
  const outletId = await getCurrentOutletId();

  try {
    const db = getDb();
    const dupe = db.prepare(`SELECT id FROM hr_leave_types WHERE name = ? COLLATE NOCASE`).get(name) as any;
    if (dupe) return Response.json({ error: 'A leave type with that name already exists' }, { status: 409 });

    const id = generateId();
    db.prepare(
      `INSERT INTO hr_leave_types
         (id, name, annual_entitlement, carry_forward_max, encashable, max_consecutive_days, is_paid)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      name,
      real0(body?.annual_entitlement),
      real0(body?.carry_forward_max),
      body?.encashable ? 1 : 0,
      int0(body?.max_consecutive_days),
      // is_paid defaults to 1 (schema default) when the key is absent.
      body?.is_paid === undefined ? 1 : (body.is_paid ? 1 : 0),
    );

    const leave_type = db.prepare(`SELECT * FROM hr_leave_types WHERE id = ?`).get(id) as HrLeaveType;
    logAuditEvent(db, {
      event_type: 'hr.leave.type.create',
      entity_type: 'hr_leave_type',
      entity_id: id,
      actor_email: me.email,
      outlet_id: outletId,
      after: leave_type,
    });
    return Response.json({ leave_type });
  } catch (e) {
    console.error('POST /api/hr/leave/types failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to create leave type' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) return Response.json({ error: 'Admin role required' }, { status: 403 });

  let body: any = {};
  try { body = await request.json(); } catch { /* handled by field checks below */ }
  const id = s(body?.id);
  if (!id) return Response.json({ error: 'Leave type id is required' }, { status: 400 });

  const outletId = await getCurrentOutletId();

  try {
    const db = getDb();
    const existing = db.prepare(`SELECT * FROM hr_leave_types WHERE id = ?`).get(id) as HrLeaveType | undefined;
    if (!existing) return Response.json({ error: 'Leave type not found' }, { status: 404 });

    const sets: string[] = [];
    const args: any[] = [];
    if (body.name !== undefined) {
      const name = s(body.name);
      if (!name) return Response.json({ error: 'Leave type name cannot be empty' }, { status: 400 });
      const dupe = db
        .prepare(`SELECT id FROM hr_leave_types WHERE name = ? COLLATE NOCASE AND id != ?`)
        .get(name, id) as any;
      if (dupe) return Response.json({ error: 'A leave type with that name already exists' }, { status: 409 });
      sets.push('name = ?'); args.push(name);
    }
    if (body.annual_entitlement !== undefined) {
      sets.push('annual_entitlement = ?'); args.push(real0(body.annual_entitlement));
    }
    if (body.carry_forward_max !== undefined) {
      sets.push('carry_forward_max = ?'); args.push(real0(body.carry_forward_max));
    }
    if (body.encashable !== undefined) {
      sets.push('encashable = ?'); args.push(body.encashable ? 1 : 0);
    }
    if (body.max_consecutive_days !== undefined) {
      sets.push('max_consecutive_days = ?'); args.push(int0(body.max_consecutive_days));
    }
    if (body.is_paid !== undefined) {
      sets.push('is_paid = ?'); args.push(body.is_paid ? 1 : 0);
    }
    if (body.is_active !== undefined) {
      sets.push('is_active = ?'); args.push(body.is_active ? 1 : 0);
    }
    if (!sets.length) return Response.json({ error: 'Nothing to update' }, { status: 400 });

    sets.push(`updated_at = datetime('now')`);
    db.prepare(`UPDATE hr_leave_types SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);

    const leave_type = db.prepare(`SELECT * FROM hr_leave_types WHERE id = ?`).get(id) as HrLeaveType;
    logAuditEvent(db, {
      event_type: 'hr.leave.type.update',
      entity_type: 'hr_leave_type',
      entity_id: id,
      actor_email: me.email,
      outlet_id: outletId,
      before: existing,
      after: leave_type,
    });
    return Response.json({ leave_type });
  } catch (e) {
    console.error('PUT /api/hr/leave/types failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to update leave type' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) return Response.json({ error: 'Admin role required' }, { status: 403 });

  // House style is ?id= (vendors, tasks/*); the module contract writes DELETE { id }.
  // Accept both so neither caller shape breaks.
  const url = new URL(request.url);
  let id = s(url.searchParams.get('id'));
  if (!id) {
    try {
      const body: any = await request.json();
      id = s(body?.id);
    } catch { /* no body — handled below */ }
  }
  if (!id) return Response.json({ error: 'Leave type id is required' }, { status: 400 });

  const outletId = await getCurrentOutletId();

  try {
    const db = getDb();
    const existing = db.prepare(`SELECT * FROM hr_leave_types WHERE id = ?`).get(id) as HrLeaveType | undefined;
    if (!existing) return Response.json({ error: 'Leave type not found' }, { status: 404 });

    // Soft deactivate is ALWAYS allowed — no in-use guard. Deactivation only
    // hides the type from pickers; balances and requests keep the label, and
    // already-PENDING requests stay approvable (validateRequest accepts an
    // inactive type at approve time — hr-leave.ts step 4). The count of
    // pending requests rides the response as a warning so the admin knows
    // what is still in flight against the retired type.
    const pendingRow = db
      .prepare(`SELECT COUNT(*) AS n FROM hr_leave_requests WHERE leave_type_id = ? AND status = 'pending'`)
      .get(id) as { n: number };
    db.prepare(`UPDATE hr_leave_types SET is_active = 0, updated_at = datetime('now') WHERE id = ?`).run(id);
    logAuditEvent(db, {
      event_type: 'hr.leave.type.deactivate',
      entity_type: 'hr_leave_type',
      entity_id: id,
      actor_email: me.email,
      outlet_id: outletId,
      before: existing,
      after: { ...existing, is_active: 0 },
    });
    return Response.json({
      ok: true,
      pending_requests: pendingRow.n,
      ...(pendingRow.n > 0
        ? {
            warning: `${pendingRow.n} pending leave request${pendingRow.n === 1 ? '' : 's'} still reference${pendingRow.n === 1 ? 's' : ''} this type — they can still be approved or rejected`,
          }
        : {}),
    });
  } catch (e) {
    console.error('DELETE /api/hr/leave/types failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to deactivate leave type' }, { status: 500 });
  }
}
