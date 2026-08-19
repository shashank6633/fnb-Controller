/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { canAdminHr, canManageHr, type HrKpi } from '@/lib/hr';
import { reportServerError } from '@/lib/error-alerts';

/**
 * HR KPI master (/api/hr/kpis) — HRMS Phase 6.
 * Contract: docs/HRMS_DECISIONS.md. KPIs are the weighted scoring dimensions
 * behind /api/hr/performance — a review's `overall` is the weight-weighted
 * mean of its per-KPI scores, so `weight` must stay a positive number.
 *
 * GET    /api/hr/kpis?include_inactive=1 → { kpis }
 *          Management tier (admin | manager | HOD). The proxy does NOT guard
 *          API GETs — this check is the security boundary (HRMS §2.1).
 * POST   /api/hr/kpis { name, weight? } → { kpi }. Admin only.
 *          409 on a duplicate name — hr_kpis.name is UNIQUE COLLATE NOCASE,
 *          pre-checked for a human message and backstopped by the constraint.
 * PUT    /api/hr/kpis { id, name?, weight?, is_active? } → { kpi }. Admin only.
 * DELETE /api/hr/kpis?id=   (id also accepted in a JSON body)
 *          → { ok: true }. Admin only. SOFT delete (is_active = 0) — old
 *          reviews keep scoring against the row; only pickers hide it.
 *
 * Error bodies are GENERIC on 500 (never e.message — HR data must not leak
 * schema/details through errors).
 */
export const dynamic = 'force-dynamic';

/** Trimmed string from any body value ('' for null/undefined). */
function s(v: unknown): string {
  return String(v ?? '').trim();
}

/** KPI weight: a finite number > 0, or null when the value is unusable.
 *  Zero is refused — an all-zero weight set would make the weighted-mean
 *  denominator vanish in /api/hr/performance. */
function parseWeight(v: unknown): number | null {
  const n = Number(String(v ?? '').trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
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
      `SELECT * FROM hr_kpis` +
      (includeInactive ? '' : ` WHERE is_active = 1`) +
      ` ORDER BY is_active DESC, name COLLATE NOCASE ASC`;
    const kpis = db.prepare(sql).all() as HrKpi[];
    return Response.json({ kpis });
  } catch (e) {
    console.error('GET /api/hr/kpis failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to load KPIs' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) return Response.json({ error: 'Admin role required' }, { status: 403 });

  let body: any = {};
  try { body = await request.json(); } catch { /* handled by field checks below */ }

  const name = s(body?.name);
  if (!name) return Response.json({ error: 'KPI name is required' }, { status: 400 });

  let weight = 1;
  if (body?.weight !== undefined && s(body.weight) !== '') {
    const w = parseWeight(body.weight);
    if (w === null) {
      return Response.json({ error: 'Weight must be a number greater than 0' }, { status: 400 });
    }
    weight = w;
  }

  // better-sqlite3 is synchronous — resolve every await BEFORE touching the DB.
  const outletId = await getCurrentOutletId();

  try {
    const db = getDb();

    // Friendly pre-check; the UNIQUE COLLATE NOCASE constraint is the authority.
    const dupe = db
      .prepare(`SELECT id FROM hr_kpis WHERE name = ? COLLATE NOCASE`)
      .get(name) as any;
    if (dupe) return Response.json({ error: 'A KPI with that name already exists' }, { status: 409 });

    const id = generateId();
    try {
      db.prepare(`INSERT INTO hr_kpis (id, name, weight) VALUES (?, ?, ?)`).run(id, name, weight);
    } catch (e: any) {
      if (String(e?.code || '').startsWith('SQLITE_CONSTRAINT')) {
        return Response.json({ error: 'A KPI with that name already exists' }, { status: 409 });
      }
      throw e;
    }

    const kpi = db.prepare(`SELECT * FROM hr_kpis WHERE id = ?`).get(id) as HrKpi;
    logAuditEvent(db, {
      event_type: 'hr.kpi.create',
      entity_type: 'hr_kpi',
      entity_id: id,
      actor_email: me.email,
      outlet_id: outletId,
      after: kpi,
    });
    return Response.json({ kpi });
  } catch (e) {
    console.error('POST /api/hr/kpis failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to create KPI' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) return Response.json({ error: 'Admin role required' }, { status: 403 });

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }
  const id = s(body?.id);
  if (!id) return Response.json({ error: 'KPI id is required' }, { status: 400 });

  const outletId = await getCurrentOutletId();

  try {
    const db = getDb();
    const existing = db.prepare(`SELECT * FROM hr_kpis WHERE id = ?`).get(id) as HrKpi | undefined;
    if (!existing) return Response.json({ error: 'KPI not found' }, { status: 404 });

    const sets: string[] = [];
    const args: any[] = [];

    if (body.name !== undefined) {
      const name = s(body.name);
      if (!name) return Response.json({ error: 'KPI name cannot be empty' }, { status: 400 });
      const dupe = db
        .prepare(`SELECT id FROM hr_kpis WHERE name = ? COLLATE NOCASE AND id != ?`)
        .get(name, id) as any;
      if (dupe) return Response.json({ error: 'A KPI with that name already exists' }, { status: 409 });
      sets.push('name = ?'); args.push(name);
    }
    if (body.weight !== undefined) {
      const w = parseWeight(body.weight);
      if (w === null) {
        return Response.json({ error: 'Weight must be a number greater than 0' }, { status: 400 });
      }
      sets.push('weight = ?'); args.push(w);
    }
    if (body.is_active !== undefined) {
      sets.push('is_active = ?'); args.push(body.is_active ? 1 : 0);
    }
    if (!sets.length) return Response.json({ error: 'Nothing to update' }, { status: 400 });

    // NOTE: hr_kpis has no updated_at column — do not invent one.
    try {
      db.prepare(`UPDATE hr_kpis SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
    } catch (e: any) {
      if (String(e?.code || '').startsWith('SQLITE_CONSTRAINT')) {
        return Response.json({ error: 'A KPI with that name already exists' }, { status: 409 });
      }
      throw e;
    }

    const kpi = db.prepare(`SELECT * FROM hr_kpis WHERE id = ?`).get(id) as HrKpi;
    logAuditEvent(db, {
      event_type: 'hr.kpi.update',
      entity_type: 'hr_kpi',
      entity_id: id,
      actor_email: me.email,
      outlet_id: outletId,
      before: existing,
      after: kpi,
    });
    return Response.json({ kpi });
  } catch (e) {
    console.error('PUT /api/hr/kpis failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to update KPI' }, { status: 500 });
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
  if (!id) return Response.json({ error: 'KPI id is required' }, { status: 400 });

  const outletId = await getCurrentOutletId();

  try {
    const db = getDb();
    const existing = db.prepare(`SELECT * FROM hr_kpis WHERE id = ?`).get(id) as HrKpi | undefined;
    if (!existing) return Response.json({ error: 'KPI not found' }, { status: 404 });

    // Soft deactivate is ALWAYS allowed — no in-use guard. Existing reviews
    // froze their scores at write time; only the pickers hide the row.
    db.prepare(`UPDATE hr_kpis SET is_active = 0 WHERE id = ?`).run(id);
    logAuditEvent(db, {
      event_type: 'hr.kpi.deactivate',
      entity_type: 'hr_kpi',
      entity_id: id,
      actor_email: me.email,
      outlet_id: outletId,
      before: existing,
      after: { ...existing, is_active: 0 },
    });
    return Response.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/hr/kpis failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to deactivate KPI' }, { status: 500 });
  }
}
