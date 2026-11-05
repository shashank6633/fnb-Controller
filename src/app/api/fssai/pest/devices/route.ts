/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentOutletId } from '@/lib/auth';
import { canAuthorFssai, FSSAI_PEST_DEVICE_KINDS } from '@/lib/fssai';
import { requireFssaiUser, fssaiCsrfGuard, fssaiAudit, str } from '@/lib/fssai-server';
import { p6ConstraintMessage, isoDateOrBlank, p6Bool01, intOrNull } from '../../p6-shared';
import { fssaiToday } from '@/lib/fssai';
import { fssaiTableExists } from '@/lib/fssai-void';
import { pestStationCoverage, PEST_CHECK_FREQUENCY_DAYS } from '../_pest/monitoring';

/**
 * THE PEST MAP — bait stations, glue boards and insect light traps, AS A
 * REGISTER (owner §7). /api/fssai/pest/devices
 *
 * ── A REGISTER OF PLACES ─────────────────────────────────────────────────────
 * This holds WHERE the stations are. It said here once that there must never be
 * a device-check table, because "station 7 checked, no activity" would be a
 * checklist answer. SUPERSEDED 2026-10-14: the Hyderabad authority's monitoring
 * sheet is station by station (date, device, activity yes/no, action,
 * initials), a checklist has a fixed question set while this map has however
 * many stations are on the wall, and the measured result of the old bet was
 * that last_checked_at was written only by a sighting. The walk now has its own
 * table and route (fssai_pest_device_checks, /api/fssai/pest/checks).
 *
 * Three things read this register: the walk (one line per station in use), a
 * sighting (device_id), and the coverage below. last_checked_at is stamped by
 * both a walk and a sighting — "somebody looked"; whether a station is DUE is
 * judged from the walk's lines alone (pestStationCoverage), because a sighting
 * is not a check.
 *
 * ── WHO MAY WRITE IT ────────────────────────────────────────────────────────
 * ADMIN, via canAuthorFssai. The pest map is configuration, not a record: the
 * same reasoning that makes checklist authoring admin-only (owner §20 — only the
 * administrator configures). A manager who could renumber the stations could
 * renumber away the station a sighting was filed against.
 *
 * Reading is open to everyone, because the sighting form's "which station" list
 * comes from here and that form is open to everyone.
 *
 * ── DEACTIVATE, NEVER DELETE ────────────────────────────────────────────────
 * fssai_pest_devices has no void trio (17 columns, no voided_at) because it is
 * not a record of an event — it is a list of places. A station that has been
 * taken out carries is_active = 0, and the row stays, because sightings point at
 * it. A DELETE would orphan every sighting ever filed against station 7 and the
 * column has no FK to stop it.
 *
 *   GET  [?active=1|0&kind=&q=]
 *   POST { action: 'create' | 'update' | 'set_active', … }
 */
export const dynamic = 'force-dynamic';

const SELECT = `
  SELECT d.*,
         dep.name AS department_name,
         st.name  AS store_name,
         v.name   AS vendor_name,
         (SELECT COUNT(*) FROM fssai_pest_sightings g
            WHERE g.device_id = d.id AND g.voided_at = '') AS sighting_count,
         (SELECT MAX(g.business_date) FROM fssai_pest_sightings g
            WHERE g.device_id = d.id AND g.voided_at = '') AS last_sighting_date
    FROM fssai_pest_devices d
    LEFT JOIN departments     dep ON dep.id = d.department_id
    LEFT JOIN store_locations st  ON st.id  = d.store_id
    LEFT JOIN vendors         v   ON v.id   = d.vendor_id`;

function shape(row: any) {
  return {
    id: String(row.id),
    code: str(row.code),
    device_kind: str(row.device_kind),
    device_kind_label: FSSAI_PEST_DEVICE_KINDS.find((k) => k.key === str(row.device_kind))?.label || str(row.device_kind),
    location_label: str(row.location_label),
    department_id: str(row.department_id),
    department_name: str(row.department_name),
    store_id: str(row.store_id),
    store_name: str(row.store_name),
    installed_on: str(row.installed_on),
    vendor_id: str(row.vendor_id),
    vendor_name: str(row.vendor_name),
    check_frequency: str(row.check_frequency),
    last_checked_at: str(row.last_checked_at),
    notes: str(row.notes),
    is_active: Number(row.is_active) === 1,
    sort_order: Number(row.sort_order) || 0,
    sighting_count: Number(row.sighting_count) || 0,
    last_sighting_date: str(row.last_sighting_date),
    created_by: str(row.created_by),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
  };
}

export async function GET(request: Request) {
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;

  try {
    const db = getDb();
    const url = new URL(request.url);
    const where: string[] = [];
    const args: any[] = [];

    const active = str(url.searchParams.get('active'));
    if (active === '1') where.push('d.is_active = 1');
    else if (active === '0') where.push('d.is_active = 0');

    const kind = str(url.searchParams.get('kind'));
    if (kind) {
      if (!FSSAI_PEST_DEVICE_KINDS.some((k) => k.key === kind)) {
        return Response.json({ error: `"${kind}" is not a kind of monitoring point.` }, { status: 400 });
      }
      where.push('d.device_kind = ?'); args.push(kind);
    }

    const q = str(url.searchParams.get('q'));
    if (q) {
      const like = `%${q.toLowerCase()}%`;
      where.push(`(lower(d.code) LIKE ? OR lower(d.location_label) LIKE ? OR lower(d.notes) LIKE ?)`);
      args.push(like, like, like);
    }

    const rows = db.prepare(
      `${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
       ORDER BY d.is_active DESC, d.sort_order ASC, d.code ASC, d.rowid ASC
       LIMIT 500`,
    ).all(...args) as any[];

    const counts = db.prepare(
      `SELECT SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END) AS retired,
              COUNT(*) AS all_rows
         FROM fssai_pest_devices`,
    ).get() as any;

    // Where each station IN USE stands on the monitoring sheet. A retired
    // station has no coverage — it is no longer walked.
    const coverage = fssaiTableExists(db, 'fssai_pest_device_checks')
      ? new Map(pestStationCoverage(db, fssaiToday()).map((c) => [c.device_id, c]))
      : new Map();

    return Response.json({
      devices: rows.map((r) => {
        const c: any = coverage.get(String(r.id));
        return {
          ...shape(r),
          sheet: c
            ? {
              state: c.state, state_label: c.state_label, state_color: c.state_color,
              last_check_date: c.last_check_date, last_check_time: c.last_check_time,
              last_activity: c.last_activity, due_on: c.due_on, frequency_days: c.frequency_days,
            }
            : null,
        };
      }),
      frequencies: Object.keys(PEST_CHECK_FREQUENCY_DAYS),
      counts: {
        active: Number(counts?.active) || 0,
        retired: Number(counts?.retired) || 0,
        all: Number(counts?.all_rows) || 0,
      },
      kinds: FSSAI_PEST_DEVICE_KINDS,
      can_configure: canAuthorFssai(me),
      generated_at: new Date().toISOString(),
    });
  } catch (e: any) {
    console.error('GET /api/fssai/pest/devices failed:', e);
    return Response.json({ error: e?.message || 'Failed to load the pest map' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const csrf = fssaiCsrfGuard(request);
  if (csrf) return csrf;

  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;
  if (!canAuthorFssai(me)) {
    return Response.json({ error: 'Only an administrator can set up the pest map. A sighting can be reported by anyone — use the Sightings tab.' }, { status: 403 });
  }

  let body: any = {};
  try { body = await request.json(); } catch { body = {}; }
  const action = str(body.action);

  try {
    const db = getDb();
    const outletId = (await getCurrentOutletId()) || '';

    if (action === 'create' || action === 'update') {
      const isCreate = action === 'create';
      let row: any = null;
      if (!isCreate) {
        row = db.prepare(`SELECT * FROM fssai_pest_devices WHERE id = ?`).get(str(body.id)) as any;
        if (!row) return Response.json({ error: 'That monitoring point is no longer in the register.' }, { status: 404 });
      }

      // location_label is NOT NULL with NO DEFAULT on this table — the one column
      // in the nineteen W1 added that cannot fall back to ''. Supply it or refuse;
      // a station whose location is blank is a station nobody can find.
      const location = (body.location_label === undefined && row ? str(row.location_label) : str(body.location_label)).trim();
      if (location.length < 2) {
        return Response.json({ error: 'Where is this station? A monitoring point with no place on it cannot be checked.' }, { status: 400 });
      }
      const kind = FSSAI_PEST_DEVICE_KINDS.some((k) => k.key === str(body.device_kind))
        ? str(body.device_kind)
        : (row ? str(row.device_kind) : 'bait_station');
      const code = (body.code === undefined && row ? str(row.code) : str(body.code)).trim();

      const deptId = body.department_id === undefined && row ? str(row.department_id) : str(body.department_id);
      if (deptId) {
        const d = db.prepare(`SELECT id FROM departments WHERE id = ?`).get(deptId) as any;
        if (!d) return Response.json({ error: 'That department is not in the list.' }, { status: 400 });
      }
      const storeId = body.store_id === undefined && row ? str(row.store_id) : str(body.store_id);
      if (storeId) {
        const s = db.prepare(`SELECT id FROM store_locations WHERE id = ?`).get(storeId) as any;
        if (!s) return Response.json({ error: 'That store is not in the list.' }, { status: 400 });
      }
      const vendorId = body.vendor_id === undefined && row ? str(row.vendor_id) : str(body.vendor_id);
      if (vendorId) {
        const v = db.prepare(`SELECT id FROM vendors WHERE id = ?`).get(vendorId) as any;
        if (!v) return Response.json({ error: 'That pest control agency is not in the supplier list.' }, { status: 400 });
      }

      // The frequency decides when the monitoring sheet calls a station overdue,
      // so only the four words pestStationCoverage knows are accepted. A row
      // already holding something else keeps it (and reads as weekly, flagged).
      const frequency = (body.check_frequency === undefined && row ? str(row.check_frequency) : str(body.check_frequency)) || 'weekly';
      const freqChanged = isCreate || frequency !== str(row?.check_frequency);
      if (freqChanged && !Object.prototype.hasOwnProperty.call(PEST_CHECK_FREQUENCY_DAYS, frequency)) {
        return Response.json({ error: `"${frequency}" is not a check frequency. Use daily, weekly, fortnightly or monthly.` }, { status: 400 });
      }

      const now = new Date().toISOString();
      const id = isCreate ? generateId() : String(row.id);
      const sortOrder = intOrNull(body.sort_order) ?? (row ? Number(row.sort_order) || 0 : 0);

      try {
        db.transaction(() => {
          if (isCreate) {
            db.prepare(
              `INSERT INTO fssai_pest_devices
                 (id, code, device_kind, location_label, department_id, store_id, installed_on,
                  vendor_id, check_frequency, notes, is_active, sort_order, created_by,
                  outlet_id, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            ).run(
              id, code, kind, location.slice(0, 300), deptId, storeId,
              isoDateOrBlank(body.installed_on), vendorId,
              frequency, str(body.notes).slice(0, 2000),
              p6Bool01(body.is_active, 1), sortOrder, me.email, outletId, now, now,
            );
            fssaiAudit(db, {
              entity_table: 'fssai_pest_devices', entity_id: id, action: 'create',
              after: { code, device_kind: kind, location_label: location, department_id: deptId, store_id: storeId },
              actor: { email: me.email, name: me.name }, outlet_id: outletId,
            });
          } else {
            db.prepare(
              `UPDATE fssai_pest_devices
                  SET code = ?, device_kind = ?, location_label = ?, department_id = ?, store_id = ?,
                      installed_on = ?, vendor_id = ?, check_frequency = ?, notes = ?,
                      sort_order = ?, updated_at = ?
                WHERE id = ?`,
            ).run(
              code, kind, location.slice(0, 300), deptId, storeId,
              body.installed_on === undefined ? str(row.installed_on) : isoDateOrBlank(body.installed_on),
              vendorId, frequency,
              str(body.notes ?? row.notes).slice(0, 2000), sortOrder, now, id,
            );
            fssaiAudit(db, {
              entity_table: 'fssai_pest_devices', entity_id: id, action: 'update',
              before: {
                code: str(row.code), device_kind: str(row.device_kind), location_label: str(row.location_label),
                department_id: str(row.department_id), store_id: str(row.store_id),
              },
              after: { code, device_kind: kind, location_label: location, department_id: deptId, store_id: storeId },
              actor: { email: me.email, name: me.name }, outlet_id: outletId,
            });
          }
        })();
      } catch (e: any) {
        const msg = p6ConstraintMessage(e, '');
        if (msg) return Response.json({ error: msg }, { status: 409 });
        throw e;
      }

      const after = db.prepare(`${SELECT} WHERE d.id = ?`).get(id) as any;
      return Response.json({ device: shape(after), created: isCreate });
    }

    /* ── RETIRE / BRING BACK — never a delete ────────────────────────────── */
    if (action === 'set_active') {
      const row = db.prepare(`SELECT * FROM fssai_pest_devices WHERE id = ?`).get(str(body.id)) as any;
      if (!row) return Response.json({ error: 'That monitoring point is no longer in the register.' }, { status: 404 });
      const want = p6Bool01(body.is_active, Number(row.is_active) === 1 ? 0 : 1);
      if (want === Number(row.is_active)) {
        return Response.json({ error: want === 1 ? 'That station is already in use.' : 'That station is already retired.' }, { status: 409 });
      }
      // A reason is required to RETIRE one, not to bring it back: taking a station
      // off the map changes what the monitoring round covers, and an inspector
      // comparing last year's map with this one will ask why.
      const reason = str(body.reason).trim();
      if (want === 0 && reason.length < 4) {
        return Response.json({ error: 'Say in words why this station is being taken off the map — the round that covers it will stop asking about it.' }, { status: 400 });
      }
      const now = new Date().toISOString();
      db.transaction(() => {
        db.prepare(`UPDATE fssai_pest_devices SET is_active = ?, updated_at = ? WHERE id = ?`).run(want, now, row.id);
        fssaiAudit(db, {
          entity_table: 'fssai_pest_devices', entity_id: String(row.id),
          action: want === 1 ? 'reactivate' : 'retire', field: 'is_active',
          before: { is_active: Number(row.is_active) }, after: { is_active: want },
          reason, actor: { email: me.email, name: me.name }, outlet_id: outletId,
        });
      })();
      const after = db.prepare(`${SELECT} WHERE d.id = ?`).get(row.id) as any;
      return Response.json({ device: shape(after) });
    }

    return Response.json({ error: `"${action || '(none)'}" is not something this screen can do.` }, { status: 400 });
  } catch (e: any) {
    console.error('POST /api/fssai/pest/devices failed:', e);
    const msg = p6ConstraintMessage(e, '');
    if (msg) return Response.json({ error: msg }, { status: 409 });
    return Response.json({ error: e?.message || 'Could not save the monitoring point' }, { status: 500 });
  }
}
