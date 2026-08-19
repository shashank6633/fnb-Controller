/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { canAdminHr, canManageHr, type HrGeofence } from '@/lib/hr';
import { reportServerError } from '@/lib/error-alerts';

/**
 * HR Geofences admin (/api/hr/geofences) — Phase 2.
 *
 * Contract: docs/HRMS_DECISIONS.md (D3 — geofences are DATA, radius is never
 * hard-coded; src/lib/hr-geo.ts evaluates them, this route only manages rows).
 * Rows are soft-deleted only (is_active = 0): hr_attendance_events.geofence_id
 * references live forever, so a fence is hidden, never removed.
 *
 * GET    /api/hr/geofences?include_inactive=1 → { geofences }
 *          Management tier (admin | manager | HOD). The proxy does NOT guard
 *          API GETs — this check is the security boundary.
 * POST   /api/hr/geofences { name, outlet_id?, lat, lng, radius_m?,
 *          accuracy_threshold_m?, grace_seconds? } → { geofence }
 *          Admin only. outlet_id defaults to the caller's current outlet ONLY
 *          when the body key is absent (an explicit '' is stored as '').
 * PUT    /api/hr/geofences { id, ...fields } → { geofence }. Admin only.
 *          Partial update; every provided field re-validates.
 * DELETE /api/hr/geofences?id=   (id also accepted in a JSON body)
 *          → { ok: true }. Admin only. Soft deactivate (is_active = 0).
 *
 * Validation (400): lat ∈ [-90, 90], lng ∈ [-180, 180], radius_m > 0,
 * accuracy_threshold_m > 0, grace_seconds ≥ 0.
 *
 * Error bodies are GENERIC on 500 (never e.message — HR data must not leak
 * schema/details through errors).
 */
export const dynamic = 'force-dynamic';

/** Finite number from a body value (accepts numeric strings), else null. */
function num(v: unknown): number | null {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Validate one geofence numeric field; returns an error string or null.
 *  `value` is the already-parsed number (null = unparseable). */
function fieldError(field: string, value: number | null): string | null {
  if (value === null) return `A valid ${field} is required`;
  switch (field) {
    case 'lat':
      return value >= -90 && value <= 90 ? null : 'Latitude must be between -90 and 90';
    case 'lng':
      return value >= -180 && value <= 180 ? null : 'Longitude must be between -180 and 180';
    case 'radius_m':
      return value > 0 ? null : 'Radius must be greater than 0 metres';
    case 'accuracy_threshold_m':
      return value > 0 ? null : 'Accuracy threshold must be greater than 0 metres';
    case 'grace_seconds':
      return value >= 0 ? null : 'Grace seconds cannot be negative';
    default:
      return null;
  }
}

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
      `SELECT * FROM hr_geofences` +
      (includeInactive ? '' : ` WHERE is_active = 1`) +
      ` ORDER BY is_active DESC, name COLLATE NOCASE ASC`;
    const geofences = db.prepare(sql).all() as HrGeofence[];
    return Response.json({ geofences });
  } catch (e) {
    console.error('GET /api/hr/geofences failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to load geofences' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) return Response.json({ error: 'Admin role required' }, { status: 403 });

  let body: any = {};
  try { body = await request.json(); } catch { /* handled by field checks below */ }

  const name = String(body?.name || '').trim();
  if (!name) return Response.json({ error: 'Geofence name is required' }, { status: 400 });

  const lat = num(body?.lat);
  const lng = num(body?.lng);
  // Optional fields fall back to the schema defaults (kept in ONE place — here
  // and the CREATE TABLE agree: 100 m radius, 50 m accuracy, 300 s grace).
  const radius_m = body?.radius_m === undefined ? 100 : num(body?.radius_m);
  const accuracy_threshold_m =
    body?.accuracy_threshold_m === undefined ? 50 : num(body?.accuracy_threshold_m);
  const grace_seconds = body?.grace_seconds === undefined ? 300 : num(body?.grace_seconds);

  for (const [field, value] of [
    ['lat', lat],
    ['lng', lng],
    ['radius_m', radius_m],
    ['accuracy_threshold_m', accuracy_threshold_m],
    ['grace_seconds', grace_seconds],
  ] as Array<[string, number | null]>) {
    const err = fieldError(field, value);
    if (err) return Response.json({ error: err }, { status: 400 });
  }

  // Stamp the caller's outlet ONLY when the KEY is absent from the body — an
  // explicit '' is a deliberate "no outlet" and is stored as ''. Resolve the
  // await BEFORE any DB work (better-sqlite3 is synchronous).
  let outlet_id = String(body?.outlet_id ?? '').trim();
  if (!Object.prototype.hasOwnProperty.call(body ?? {}, 'outlet_id')) {
    outlet_id = (await getCurrentOutletId()) || '';
  }

  try {
    const db = getDb();
    const id = generateId();
    db.prepare(
      `INSERT INTO hr_geofences
         (id, outlet_id, name, lat, lng, radius_m, accuracy_threshold_m, grace_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, outlet_id, name, lat, lng, radius_m,
      accuracy_threshold_m, Math.round(grace_seconds as number),
    );

    const geofence = db.prepare(`SELECT * FROM hr_geofences WHERE id = ?`).get(id) as HrGeofence;
    logAuditEvent(db, {
      event_type: 'hr.geofence.create',
      entity_type: 'hr_geofence',
      entity_id: id,
      actor_email: me.email,
      outlet_id: outlet_id || null,
      after: geofence,
    });
    return Response.json({ geofence });
  } catch (e) {
    console.error('POST /api/hr/geofences failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to create geofence' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) return Response.json({ error: 'Admin role required' }, { status: 403 });

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }
  const id = String(body?.id || '').trim();
  if (!id) return Response.json({ error: 'Geofence id is required' }, { status: 400 });

  const outletId = await getCurrentOutletId();

  try {
    const db = getDb();
    const existing = db.prepare(`SELECT * FROM hr_geofences WHERE id = ?`).get(id) as
      | HrGeofence
      | undefined;
    if (!existing) return Response.json({ error: 'Geofence not found' }, { status: 404 });

    const sets: string[] = [];
    const args: any[] = [];

    if (body.name !== undefined) {
      const name = String(body.name || '').trim();
      if (!name) return Response.json({ error: 'Geofence name cannot be empty' }, { status: 400 });
      sets.push('name = ?'); args.push(name);
    }
    if (body.outlet_id !== undefined) {
      sets.push('outlet_id = ?'); args.push(String(body.outlet_id ?? '').trim());
    }
    for (const field of ['lat', 'lng', 'radius_m', 'accuracy_threshold_m', 'grace_seconds']) {
      if (body[field] === undefined) continue;
      const value = num(body[field]);
      const err = fieldError(field, value);
      if (err) return Response.json({ error: err }, { status: 400 });
      sets.push(`${field} = ?`);
      args.push(field === 'grace_seconds' ? Math.round(value as number) : value);
    }
    if (body.is_active !== undefined) {
      sets.push('is_active = ?'); args.push(body.is_active ? 1 : 0);
    }
    if (!sets.length) return Response.json({ error: 'Nothing to update' }, { status: 400 });

    sets.push(`updated_at = datetime('now')`);
    db.prepare(`UPDATE hr_geofences SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);

    const geofence = db.prepare(`SELECT * FROM hr_geofences WHERE id = ?`).get(id) as HrGeofence;
    logAuditEvent(db, {
      event_type: 'hr.geofence.update',
      entity_type: 'hr_geofence',
      entity_id: id,
      actor_email: me.email,
      outlet_id: outletId,
      before: existing,
      after: geofence,
    });
    return Response.json({ geofence });
  } catch (e) {
    console.error('PUT /api/hr/geofences failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to update geofence' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) return Response.json({ error: 'Admin role required' }, { status: 403 });

  // House style is ?id= (vendors, tasks/*); the module contract writes
  // DELETE { id }. Accept both so neither caller shape breaks.
  const url = new URL(request.url);
  let id = String(url.searchParams.get('id') || '').trim();
  if (!id) {
    try {
      const body: any = await request.json();
      id = String(body?.id || '').trim();
    } catch { /* no body — handled below */ }
  }
  if (!id) return Response.json({ error: 'Geofence id is required' }, { status: 400 });

  const outletId = await getCurrentOutletId();

  try {
    const db = getDb();
    const existing = db.prepare(`SELECT * FROM hr_geofences WHERE id = ?`).get(id) as
      | HrGeofence
      | undefined;
    if (!existing) return Response.json({ error: 'Geofence not found' }, { status: 404 });

    // Soft deactivate only — attendance events keep their geofence_id and the
    // fence stays renderable in history; it just stops matching new punches.
    db.prepare(
      `UPDATE hr_geofences SET is_active = 0, updated_at = datetime('now') WHERE id = ?`,
    ).run(id);
    logAuditEvent(db, {
      event_type: 'hr.geofence.deactivate',
      entity_type: 'hr_geofence',
      entity_id: id,
      actor_email: me.email,
      outlet_id: outletId,
      before: existing,
      after: { ...existing, is_active: 0 },
    });
    return Response.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/hr/geofences failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to deactivate geofence' }, { status: 500 });
  }
}
