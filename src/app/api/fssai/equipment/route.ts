/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentOutletId, isManagement } from '@/lib/auth';
import {
  FSSAI_EQUIPMENT_KINDS, FSSAI_TEMP_UOMS, FSSAI_FREQUENCIES,
  fssaiDisplayReading, fssaiToday,
} from '@/lib/fssai';
import {
  requireFssaiUser, requireFssaiAdmin, fssaiCsrfGuard, fssaiAudit, fssaiAppAudit, str,
} from '@/lib/fssai-server';
import { fssaiNum } from '../_p4/lib';

/**
 * THE EQUIPMENT REGISTER (/api/fssai/equipment) — the list every temperature
 * verdict is judged against.
 *
 * ── WHY THIS TABLE IS NOT A DUPLICATE MASTER ────────────────────────────────
 * Owner §21 and HARD RULE 4 forbid a second item, vendor, employee or role
 * master, and this module obeys that everywhere. Equipment is the one genuine
 * exception, measured rather than assumed: THERE IS NO EQUIPMENT MASTER IN THIS
 * APPLICATION. `hr_assets` is a staff-issued-item register (uniforms, ID cards),
 * and the only cold units that exist anywhere are four FREE-TEXT STRINGS typed
 * onto kitchen production labels — `production_batches.storage_location`, live
 * values `Cold Room 1`, `Cold Room 2`, `Cold Room 3`, `walkin chiller 1`.
 * So `GET` offers those exact four strings as suggestions: register them under
 * the same names and the batches already labelled with them line up instead of
 * starting a fresh list.
 *
 * ── WHO MAY WRITE ───────────────────────────────────────────────────────────
 * ADMIN ONLY, and the reason is on the catalog row for `/fssai/settings/equipment`:
 * a wrong safe range here re-grades how every future temperature reading is
 * judged, and it does so quietly. READS are open to any signed-in user, because
 * the cold-room board and the temperature screen both need the list and the
 * ranges to show a staff member what a reading will be judged against BEFORE they
 * take it.
 *
 * ── THE ONE THING WRITING HERE CANNOT DO ────────────────────────────────────
 * Changing a range NEVER re-grades a record. `fssai_temperature_logs` freezes
 * `min_used` / `max_used` / `is_judged` / `is_fail` at the moment of the reading,
 * and nothing in this file writes that table — grep it: the only statements
 * against `fssai_temperature_logs` are SELECTs for the latest reading. Tightening
 * a standard next month cannot retrospectively fail a fridge that passed.
 *
 * ── NO DELETE (owner §19) ───────────────────────────────────────────────────
 * A unit is RETIRED (`is_active = 0`) and stays in the file, so its old readings
 * still name what they were readings of. There is no DELETE handler, and a retire
 * is audited with the same before/after row as an edit.
 *
 *   GET  [?include_inactive=1][?with_latest=1]
 *   POST { action: 'create' | 'update' | 'retire' | 'restore', … }
 */
export const dynamic = 'force-dynamic';

const LIST_LIMIT = 300;

/** The columns a screen reads, shaped once so create/update/list cannot drift. */
const EQUIP_SELECT = `
  SELECT e.id, e.code, e.name, e.kind, e.location_label, e.department_id, e.store_id,
         e.min_temp, e.max_temp, e.temp_uom, e.check_frequency, e.is_active, e.sort_order,
         e.notes, e.created_by, e.created_at, e.updated_at,
         IFNULL(d.name,'') AS department_name,
         IFNULL(s.name,'') AS store_name
    FROM fssai_equipment e
    LEFT JOIN departments d ON d.id = e.department_id
    LEFT JOIN store_locations s ON s.id = e.store_id`;

function shapeUnit(row: any) {
  return {
    id: String(row.id),
    code: String(row.code || ''),
    name: String(row.name || ''),
    kind: String(row.kind || 'cold_room'),
    kind_label: FSSAI_EQUIPMENT_KINDS.find((k) => k.key === String(row.kind))?.label || String(row.kind || ''),
    location_label: String(row.location_label || ''),
    department_id: String(row.department_id || ''),
    department_name: String(row.department_name || ''),
    store_id: String(row.store_id || ''),
    store_name: String(row.store_name || ''),
    /* NULL stays null all the way to the screen. A unit with no range must read
     * "no range set", never "0 °C to 0 °C" — which is a rule that would fail
     * every fridge in the building. */
    min_temp: fssaiNum(row.min_temp),
    max_temp: fssaiNum(row.max_temp),
    temp_uom: String(row.temp_uom || 'C'),
    has_range: fssaiNum(row.min_temp) !== null || fssaiNum(row.max_temp) !== null,
    check_frequency: String(row.check_frequency || 'daily'),
    is_active: Number(row.is_active) ? 1 : 0,
    sort_order: Number(row.sort_order) || 0,
    notes: String(row.notes || ''),
    created_by: String(row.created_by || ''),
    created_at: String(row.created_at || ''),
    updated_at: String(row.updated_at || ''),
  };
}

export async function GET(request: Request) {
  // READS ARE OPEN TO ANY SIGNED-IN USER. Staff must see the range a reading will
  // be judged against before they take it, or "not judged" looks like a bug.
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;

  try {
    const db = getDb();
    const url = new URL(request.url);
    const includeInactive = url.searchParams.get('include_inactive') === '1';

    const rows = db.prepare(
      `${EQUIP_SELECT}
       ${includeInactive ? '' : 'WHERE e.is_active = 1'}
       ORDER BY e.is_active DESC, e.sort_order ASC, e.name ASC
       LIMIT ${LIST_LIMIT}`,
    ).all() as any[];

    const units = rows.map(shapeUnit);

    /* ══ THE LATEST READING PER UNIT ════════════════════════════════════════
     * One query over all units rather than one per unit. The window function is
     * available in the SQLite better-sqlite3 ships, and the alternative — a
     * correlated subquery per row — is the shape that made the sales heatmap
     * slow enough to notice.
     *
     * A VOIDED READING IS NOT THE LATEST READING. `status <> 'void'` is what
     * stops a board showing a number a manager has already struck out. */
    let latest: Record<string, any> = {};
    if (url.searchParams.get('with_latest') !== '0' && units.length) {
      const lr = db.prepare(
        `SELECT equipment_id, business_date, reading_at, value_num, uom, decimals,
                is_fail, is_judged, fail_reason, recorded_by, recorded_name, status, id
           FROM (
             SELECT t.*, ROW_NUMBER() OVER (
                      PARTITION BY t.equipment_id
                      ORDER BY t.business_date DESC, t.reading_at DESC, t.created_at DESC, t.rowid DESC
                    ) AS rn
               FROM fssai_temperature_logs t
              WHERE t.equipment_id <> '' AND t.status <> 'void'
           )
          WHERE rn = 1`,
      ).all() as any[];
      for (const r of lr) {
        latest[String(r.equipment_id)] = {
          id: String(r.id),
          business_date: String(r.business_date || ''),
          reading_at: String(r.reading_at || ''),
          value_num: fssaiNum(r.value_num),
          display: fssaiDisplayReading(fssaiNum(r.value_num), r.decimals),
          uom: String(r.uom || 'C'),
          is_fail: Number(r.is_fail) ? 1 : 0,
          is_judged: Number(r.is_judged) ? 1 : 0,
          fail_reason: String(r.fail_reason || ''),
          recorded_by: String(r.recorded_by || ''),
          recorded_name: String(r.recorded_name || ''),
          status: String(r.status || ''),
        };
      }
    }

    /* ══ THE FOUR NAMES THAT ALREADY EXIST IN THE APP ════════════════════════
     * Offered, never auto-created. A boot-time or first-read seed is exactly the
     * shape db.ts's own HRMS comment warns about: it RESURRECTS ROWS AN ADMIN
     * DELETED, because "never registered" and "registered and then retired" look
     * identical from an absent row. So the admin presses the button, and the
     * press is audited. A name already registered — under any case — drops out.
     */
    const known = new Set(
      (db.prepare(`SELECT lower(TRIM(name)) AS n FROM fssai_equipment`).all() as any[])
        .map((r) => String(r.n || '')),
    );
    const suggestions = (db.prepare(
      `SELECT TRIM(storage_location) AS label, COUNT(*) AS batches
         FROM production_batches
        WHERE TRIM(IFNULL(storage_location,'')) <> ''
        GROUP BY lower(TRIM(storage_location))
        ORDER BY batches DESC, label ASC`,
    ).all() as any[])
      .map((r) => ({ label: String(r.label), batches: Number(r.batches) || 0 }))
      .filter((s) => !known.has(s.label.toLowerCase()));

    return Response.json({
      units,
      latest,
      suggestions,
      /* Said out loud rather than left for the screen to infer: a unit with no
       * range cannot judge anything, and that is the single most important fact
       * on this list while the register is young. */
      without_range: units.filter((u) => u.is_active && !u.has_range).map((u) => u.id),
      can_edit: me.role === 'admin',
      is_management: isManagement(me),
      vocab: {
        kinds: FSSAI_EQUIPMENT_KINDS,
        uoms: FSSAI_TEMP_UOMS,
        frequencies: FSSAI_FREQUENCIES,
      },
      today: fssaiToday(),
    });
  } catch (e: any) {
    console.error('GET /api/fssai/equipment failed:', e);
    return Response.json({ error: e?.message || 'Failed to load the equipment register' }, { status: 500 });
  }
}

/** Shared validation — one place, so create and update cannot disagree. */
function validateUnit(body: any, existing: any | null): { error: string } | { ok: true; v: any } {
  const name = str(body?.name ?? existing?.name).slice(0, 200);
  if (!name) return { error: 'Give the unit a name. "Cold Room 1" is enough — it is what will appear on every reading taken on it.' };

  const kind = str(body?.kind ?? existing?.kind) || 'cold_room';
  if (!FSSAI_EQUIPMENT_KINDS.some((k) => k.key === kind)) {
    return { error: `"${kind}" is not a kind of unit this register knows.` };
  }

  const uom = (str(body?.temp_uom ?? existing?.temp_uom) || 'C').toUpperCase();
  if (!FSSAI_TEMP_UOMS.some((u) => u.key === uom)) {
    return { error: 'A temperature range must be in °C or °F.' };
  }

  /* A RANGE IS OPTIONAL AND EITHER HALF MAY STAND ALONE. A freezer with a maximum
   * and no minimum is normal, and demanding both would push an admin into
   * inventing a lower bound — which then starts failing readings. */
  const hasMin = body?.min_temp !== undefined ? str(body.min_temp) !== '' : fssaiNum(existing?.min_temp) !== null;
  const hasMax = body?.max_temp !== undefined ? str(body.max_temp) !== '' : fssaiNum(existing?.max_temp) !== null;
  const min = body?.min_temp !== undefined ? fssaiNum(body.min_temp) : fssaiNum(existing?.min_temp);
  const max = body?.max_temp !== undefined ? fssaiNum(body.max_temp) : fssaiNum(existing?.max_temp);
  if (hasMin && min === null) return { error: 'The minimum temperature is not a number.' };
  if (hasMax && max === null) return { error: 'The maximum temperature is not a number.' };
  if (min !== null && max !== null && min > max) {
    return { error: `The range reads ${min} to ${max}. A minimum above its maximum would fail every reading ever taken on this unit.` };
  }

  const freq = str(body?.check_frequency ?? existing?.check_frequency) || 'daily';
  if (!FSSAI_FREQUENCIES.some((f) => f.key === freq)) {
    return { error: `"${freq}" is not one of the frequencies.` };
  }

  return {
    ok: true,
    v: {
      name,
      code: str(body?.code ?? existing?.code).slice(0, 60),
      kind,
      location_label: str(body?.location_label ?? existing?.location_label).slice(0, 200),
      department_id: str(body?.department_id ?? existing?.department_id),
      store_id: str(body?.store_id ?? existing?.store_id),
      min_temp: min,
      max_temp: max,
      temp_uom: uom,
      check_frequency: freq,
      sort_order: Number(body?.sort_order ?? existing?.sort_order) || 0,
      notes: str(body?.notes ?? existing?.notes).slice(0, 2000),
    },
  };
}

export async function POST(request: Request) {
  const csrf = fssaiCsrfGuard(request);
  if (csrf) return csrf;
  // ADMIN ONLY FOR EVERY WRITE — see the header. The page catalog is visibility,
  // never security (canAccessPage fails open four ways), so this is the gate.
  const g = await requireFssaiAdmin();
  if ('resp' in g) return g.resp;
  const me = g.me;

  let body: any = {};
  try { body = await request.json(); } catch { /* validated below */ }

  try {
    const db = getDb();
    const outletId = (await getCurrentOutletId()) || '';
    const action = str(body?.action) || 'create';

    /* ══════════════════════════════════════════════════════════════════════
     * CREATE — one unit, or several at once from the suggestions.
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'create') {
      /* `names` is the "register all four" path. It exists because the suggestion
       * list is the normal way this register gets its first rows, and four
       * separate round trips each opening their own transaction is four chances
       * for a half-registered list. */
      const names: string[] = Array.isArray(body?.names)
        ? body.names.map((n: unknown) => str(n).slice(0, 200)).filter(Boolean)
        : [];

      if (names.length) {
        const kind = str(body?.kind) || 'cold_room';
        if (!FSSAI_EQUIPMENT_KINDS.some((k) => k.key === kind)) {
          return Response.json({ error: `"${kind}" is not a kind of unit this register knows.` }, { status: 400 });
        }
        const created: any[] = [];
        const skipped: string[] = [];
        /* ONE TRANSACTION, NOTHING AWAITED INSIDE IT (better-sqlite3 is
         * synchronous — HARD RULE 1 of this phase's four). */
        const tx = db.transaction(() => {
          for (const name of names) {
            const dupe = db.prepare(
              `SELECT id FROM fssai_equipment WHERE lower(TRIM(name)) = lower(TRIM(?)) LIMIT 1`,
            ).get(name) as any;
            if (dupe) { skipped.push(name); continue; }
            const id = generateId();
            db.prepare(
              `INSERT INTO fssai_equipment
                 (id, code, name, kind, location_label, department_id, store_id,
                  min_temp, max_temp, temp_uom, check_frequency, is_active, sort_order,
                  notes, created_by, outlet_id)
               VALUES (?, '', ?, ?, ?, '', '', NULL, NULL, 'C', 'daily', 1, ?, '', ?, ?)`,
            ).run(id, name, kind, name, created.length, me.email || '', outletId);
            fssaiAudit(db, {
              entity_table: 'fssai_equipment', entity_id: id, action: 'create',
              after: { name, kind, location_label: name, min_temp: null, max_temp: null },
              reason: 'Registered from the names already used on kitchen production labels.',
              actor: { email: me.email, name: me.name }, outlet_id: outletId,
            });
            created.push({ id, name });
          }
        });
        tx();
        return Response.json({
          ok: true,
          created,
          skipped,
          /* THE SENTENCE THAT STOPS A FALSE SENSE OF COMPLETENESS. A registered
           * unit with no range still judges nothing. */
          note: created.length
            ? `${created.length} unit${created.length === 1 ? '' : 's'} registered. None of them has a safe range yet, so a reading taken on one is recorded and marked as not judged until you set its numbers.`
            : 'Nothing was registered — every one of those names is already on the list.',
        });
      }

      const checked = validateUnit(body, null);
      if ('error' in checked) return Response.json({ error: checked.error }, { status: 400 });
      const v = checked.v;

      /* A DUPLICATE NAME IS REFUSED BY NAME, not silently merged. There is no
       * UNIQUE on `fssai_equipment.name` (the W1 index list has only
       * `idx_fssai_equipment_active`), so this is the only guard — and two units
       * called "Cold Room 1" would split one fridge's history in two. */
      const dupe = db.prepare(
        `SELECT id, is_active FROM fssai_equipment WHERE lower(TRIM(name)) = lower(TRIM(?)) LIMIT 1`,
      ).get(v.name) as any;
      if (dupe) {
        return Response.json(
          {
            error: Number(dupe.is_active)
              ? `"${v.name}" is already on the register. Open it and change it rather than adding a second one — two units with one name split that fridge's history in two.`
              : `"${v.name}" is on the register but retired. Put it back into use rather than adding a second one, so its old readings stay attached to it.`,
            code: 'duplicate_name', id: String(dupe.id),
          },
          { status: 409 },
        );
      }

      const id = generateId();
      const tx = db.transaction(() => {
        db.prepare(
          `INSERT INTO fssai_equipment
             (id, code, name, kind, location_label, department_id, store_id,
              min_temp, max_temp, temp_uom, check_frequency, is_active, sort_order,
              notes, created_by, outlet_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        ).run(
          id, v.code, v.name, v.kind, v.location_label, v.department_id, v.store_id,
          v.min_temp, v.max_temp, v.temp_uom, v.check_frequency, v.sort_order,
          v.notes, me.email || '', outletId,
        );
        fssaiAudit(db, {
          entity_table: 'fssai_equipment', entity_id: id, action: 'create',
          after: v, reason: str(body?.reason) || 'Registered',
          actor: { email: me.email, name: me.name }, outlet_id: outletId,
        });
      });
      tx();

      const row = db.prepare(`${EQUIP_SELECT} WHERE e.id = ?`).get(id) as any;
      return Response.json({ ok: true, unit: shapeUnit(row) });
    }

    /* ══════════════════════════════════════════════════════════════════════
     * UPDATE — including the safe range, which is the consequential one.
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'update') {
      const id = str(body?.id);
      if (!id) return Response.json({ error: 'Which unit? No id was sent.' }, { status: 400 });
      const existing = db.prepare(`SELECT * FROM fssai_equipment WHERE id = ?`).get(id) as any;
      if (!existing) return Response.json({ error: 'That unit is no longer on the register.' }, { status: 404 });

      const checked = validateUnit(body, existing);
      if ('error' in checked) return Response.json({ error: checked.error }, { status: 400 });
      const v = checked.v;

      if (String(v.name).trim().toLowerCase() !== String(existing.name || '').trim().toLowerCase()) {
        const dupe = db.prepare(
          `SELECT id FROM fssai_equipment WHERE lower(TRIM(name)) = lower(TRIM(?)) AND id <> ? LIMIT 1`,
        ).get(v.name, id) as any;
        if (dupe) {
          return Response.json(
            { error: `Another unit is already called "${v.name}".`, code: 'duplicate_name' },
            { status: 409 },
          );
        }
      }

      const rangeMoved = fssaiNum(existing.min_temp) !== v.min_temp
        || fssaiNum(existing.max_temp) !== v.max_temp
        || String(existing.temp_uom || 'C') !== v.temp_uom;

      const tx = db.transaction(() => {
        db.prepare(
          `UPDATE fssai_equipment
              SET code=?, name=?, kind=?, location_label=?, department_id=?, store_id=?,
                  min_temp=?, max_temp=?, temp_uom=?, check_frequency=?, sort_order=?, notes=?,
                  updated_at=datetime('now')
            WHERE id=?`,
        ).run(
          v.code, v.name, v.kind, v.location_label, v.department_id, v.store_id,
          v.min_temp, v.max_temp, v.temp_uom, v.check_frequency, v.sort_order, v.notes, id,
        );
        /* §19's "original value, changed value, reason" in one row. The WHOLE row
         * is diffed rather than a field, because an admin editing a unit usually
         * moves several things at once and a per-field trail would read as four
         * unrelated changes. */
        fssaiAudit(db, {
          entity_table: 'fssai_equipment', entity_id: id, action: 'update',
          before: {
            name: existing.name, kind: existing.kind, location_label: existing.location_label,
            department_id: existing.department_id, store_id: existing.store_id,
            min_temp: fssaiNum(existing.min_temp), max_temp: fssaiNum(existing.max_temp),
            temp_uom: existing.temp_uom, check_frequency: existing.check_frequency,
          },
          after: v,
          reason: str(body?.reason) || (rangeMoved ? 'Safe range changed' : 'Details changed'),
          actor: { email: me.email, name: me.name }, outlet_id: outletId || existing.outlet_id || '',
        });
      });
      tx();

      const row = db.prepare(`${EQUIP_SELECT} WHERE e.id = ?`).get(id) as any;

      /* HOW MANY RECORDS THIS DID *NOT* RE-GRADE, counted and said out loud.
       * An admin who has just tightened a range will reasonably wonder whether
       * yesterday's readings moved. They did not, and a number is a better
       * answer than a promise. */
      let unchanged = 0;
      if (rangeMoved) {
        unchanged = Number((db.prepare(
          `SELECT COUNT(*) AS n FROM fssai_temperature_logs WHERE equipment_id = ? AND status <> 'void'`,
        ).get(id) as any)?.n) || 0;
      }

      return Response.json({
        ok: true,
        unit: shapeUnit(row),
        range_changed: rangeMoved ? 1 : 0,
        records_unchanged: unchanged,
        note: rangeMoved
          ? `The new range applies to readings taken from now on. The ${unchanged} reading${unchanged === 1 ? '' : 's'} already in the file keep the range that was actually applied to them — tightening a standard does not retrospectively fail a fridge that passed.`
          : '',
      });
    }

    /* ══════════════════════════════════════════════════════════════════════
     * RETIRE / RESTORE — never a delete (owner §19).
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'retire' || action === 'restore') {
      const id = str(body?.id);
      if (!id) return Response.json({ error: 'Which unit? No id was sent.' }, { status: 400 });
      const existing = db.prepare(`SELECT * FROM fssai_equipment WHERE id = ?`).get(id) as any;
      if (!existing) return Response.json({ error: 'That unit is no longer on the register.' }, { status: 404 });

      const wantActive = action === 'restore' ? 1 : 0;
      if (Number(existing.is_active) === wantActive) {
        return Response.json(
          { error: wantActive ? 'That unit is already in use.' : 'That unit is already retired.', code: 'already' },
          { status: 409 },
        );
      }

      const reason = str(body?.reason).slice(0, 2000);
      /* A RETIRE DEMANDS A REASON; PUTTING A UNIT BACK DOES NOT. Retiring is the
       * action that makes a unit stop appearing on the round, so it is the one
       * that needs explaining to whoever notices the gap. */
      if (!wantActive && reason.length < 4) {
        return Response.json(
          {
            error: 'Say why this unit is being retired — it will stop appearing on the temperature round, and whoever notices the gap will want to know.',
            code: 'reason_required',
          },
          { status: 400 },
        );
      }

      const tx = db.transaction(() => {
        const res = db.prepare(
          `UPDATE fssai_equipment SET is_active=?, updated_at=datetime('now')
            WHERE id=? AND is_active=?`,
        ).run(wantActive, id, wantActive ? 0 : 1);
        if (res.changes !== 1) throw new Error('FSSAI_EQUIP_MOVED');
        fssaiAudit(db, {
          entity_table: 'fssai_equipment', entity_id: id,
          action: wantActive ? 'reopen' : 'void',
          field: 'is_active',
          before: { is_active: Number(existing.is_active) ? 1 : 0 },
          after: { is_active: wantActive },
          reason: reason || 'Back in use',
          actor: { email: me.email, name: me.name }, outlet_id: outletId || existing.outlet_id || '',
        });
      });
      try { tx(); } catch (e: any) {
        if (String(e?.message) === 'FSSAI_EQUIP_MOVED') {
          return Response.json({ error: 'Somebody has just changed this unit. Reload and try again.', code: 'already_moved' }, { status: 409 });
        }
        throw e;
      }

      fssaiAppAudit(db, {
        event_type: wantActive ? 'fssai.equipment.restore' : 'fssai.equipment.retire',
        entity_type: 'fssai_equipment', entity_id: id, actor_email: me.email,
        before: { is_active: Number(existing.is_active) ? 1 : 0 }, after: { is_active: wantActive },
        note: reason,
      });

      const row = db.prepare(`${EQUIP_SELECT} WHERE e.id = ?`).get(id) as any;
      return Response.json({
        ok: true,
        unit: shapeUnit(row),
        note: wantActive
          ? 'Back in use.'
          : 'Retired. It stays on the register with your reason on it, so every reading ever taken on it still names the unit it was taken on.',
      });
    }

    return Response.json(
      { error: `"${action}" is not something that can be done to a unit. Use create, update, retire or restore.` },
      { status: 400 },
    );
  } catch (e: any) {
    console.error('POST /api/fssai/equipment failed:', e);
    return Response.json({ error: e?.message || 'Failed to save that' }, { status: 500 });
  }
}

/* No DELETE. A unit that should never have been registered is RETIRED with a
 * reason and stays in the file (owner §19). Deleting it would orphan every
 * temperature reading ever taken on it — `fssai_temperature_logs.equipment_id`
 * has no FK precisely so a retired unit's history survives, and that is only
 * worth anything while the row it points at is still there to be named. */
