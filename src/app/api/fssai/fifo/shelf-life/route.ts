/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentOutletId } from '@/lib/auth';
import {
  FSSAI_STORAGE_CONDITIONS, FSSAI_NEAR_EXPIRY_DAYS, FSSAI_TEMP_UOMS, canAuthorFssai,
} from '@/lib/fssai';
import {
  requireFssaiUser, requireFssaiAdmin, fssaiCsrfGuard, fssaiAudit,
  fssaiAppAudit, str, toInt01, constraintMessage,
} from '@/lib/fssai-server';
import { num, nullableInt, real } from '../../_p5/records';

/**
 * SHELF LIFE PER ITEM (/api/fssai/fifo/shelf-life) — the data FEFO does not have.
 *
 * ── THE MEASURED GAP THIS CLOSES ────────────────────────────────────────────
 * All 952 rows of raw_materials carry a BLANK shelf_life_days and a blank
 * storage_location, and purchase and goods-receipt lines carry no lot number and
 * no expiry date at all. So "use the oldest first" has nothing to sort on for
 * anything the restaurant buys. This table is where the owner says how long each
 * item keeps, how long once opened, how many days ahead counts as "use first",
 * and what has to be written on its label.
 *
 * ── WHY IT IS NOT WRITTEN BACK INTO THE ITEM MASTER ─────────────────────────
 * raw_materials is the owner's Item Master (HARD RULE 4's spirit) and
 * /api/import-materials would overwrite anything this module put there on the
 * next import. So this is a JOIN, never a copy: `material_name` is denormalised
 * for display only, and no price, stock, unit, category or pack size is
 * restated. raw_materials stays the single master — RECON §5 row 1.
 *
 * ── WHO MAY DO WHAT ─────────────────────────────────────────────────────────
 * Anyone signed in may READ it: the FIFO board needs the near-expiry window to
 * colour a batch, and a chef is entitled to see how long a thing keeps. Only an
 * administrator may WRITE it — this is configuration, and owner §20 gives
 * configuration to the administrator. requireFssaiAdmin, not the page catalog:
 * canAccessPage fails open four ways.
 *
 *   GET  [?q=&storage_condition=&include_inactive=1]
 *   POST { action: 'save' | 'retire' | 'restore', … }
 */
export const dynamic = 'force-dynamic';

const LIST_LIMIT = 1000;

function shapeShelfLife(row: any) {
  const cond = String(row.storage_condition || 'ambient');
  return {
    id: String(row.id),
    material_id: String(row.material_id || ''),
    material_name: String(row.material_name || ''),
    /* The live name off raw_materials beside the stored one. They differ when an
     * item has been renamed since, and a screen that showed only the stored copy
     * would quietly be a stale second item master. */
    material_name_now: String(row.material_name_now || ''),
    material_exists: !!row.material_name_now,
    unit: String(row.unit || ''),
    purchase_unit: String(row.purchase_unit || ''),
    pack_size: real(row.pack_size),
    category: String(row.category || ''),
    storage_condition: cond,
    storage_condition_label: FSSAI_STORAGE_CONDITIONS.find((c) => c.key === cond)?.label || cond,
    /* NULL on every one of these means THE OWNER HAS NOT SAID, and must never be
     * rendered as 0 — "0 days shelf life" on a sack of rice would be read as an
     * instruction to throw it away. */
    shelf_life_days: row.shelf_life_days === null || row.shelf_life_days === undefined
      ? null : Number(row.shelf_life_days),
    opened_shelf_life_days: row.opened_shelf_life_days === null || row.opened_shelf_life_days === undefined
      ? null : Number(row.opened_shelf_life_days),
    near_expiry_days: row.near_expiry_days === null || row.near_expiry_days === undefined
      ? null : Number(row.near_expiry_days),
    /* What the FIFO board will actually use for this item, resolved here so the
     * screen never has to repeat the fallback chain and get it wrong. */
    near_expiry_days_effective: row.near_expiry_days === null || row.near_expiry_days === undefined
      ? FSSAI_NEAR_EXPIRY_DAYS : Number(row.near_expiry_days),
    storage_temp_min: real(row.storage_temp_min),
    storage_temp_max: real(row.storage_temp_max),
    temp_uom: String(row.temp_uom || 'C'),
    label_rule: String(row.label_rule || ''),
    is_high_risk: Number(row.is_high_risk) === 1,
    notes: String(row.notes || ''),
    is_active: Number(row.is_active) === 1,
    created_by: String(row.created_by || ''),
    created_at: String(row.created_at || ''),
    updated_at: String(row.updated_at || ''),
  };
}

const SHELF_SELECT = `
  SELECT sl.*, rm.name AS material_name_now, rm.unit AS unit,
         rm.purchase_unit AS purchase_unit, rm.pack_size AS pack_size,
         rm.category AS category
    FROM fssai_item_shelf_life sl
    LEFT JOIN raw_materials rm ON rm.id = sl.material_id`;

export async function GET(request: Request) {
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;

  try {
    const db = getDb();
    const url = new URL(request.url);

    const where: string[] = [];
    const args: any[] = [];
    if (url.searchParams.get('include_inactive') !== '1') where.push('sl.is_active = 1');

    const cond = str(url.searchParams.get('storage_condition'));
    if (cond) {
      if (!FSSAI_STORAGE_CONDITIONS.some((c) => c.key === cond)) {
        return Response.json({ error: `"${cond}" is not a way an item is kept.` }, { status: 400 });
      }
      where.push('sl.storage_condition = ?'); args.push(cond);
    }
    if (url.searchParams.get('high_risk') === '1') where.push('sl.is_high_risk = 1');

    const rows = db.prepare(
      `${SHELF_SELECT}
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY sl.is_high_risk DESC, IFNULL(rm.name, sl.material_name) ASC
       LIMIT ${LIST_LIMIT}`,
    ).all(...args) as any[];

    const q = str(url.searchParams.get('q')).toLowerCase();
    const shaped = rows.map(shapeShelfLife).filter((r) => !q
      || r.material_name.toLowerCase().includes(q)
      || r.material_name_now.toLowerCase().includes(q)
      || r.category.toLowerCase().includes(q)
      || r.label_rule.toLowerCase().includes(q));

    const total = db.prepare(`SELECT COUNT(*) AS n FROM raw_materials`).get() as any;
    const withDays = db.prepare(
      `SELECT COUNT(*) AS n FROM fssai_item_shelf_life WHERE is_active = 1 AND shelf_life_days IS NOT NULL`,
    ).get() as any;

    return Response.json({
      rows: shaped,
      coverage: {
        items_total: Number(total?.n) || 0,
        configured: Number(withDays?.n) || 0,
        /* The honest headline for a screen: how much of the store this actually
         * covers. One configured item out of 952 is not "FEFO is working". */
        note: 'Only items with a shelf life set here can be ranked by date. Everything else is recorded, but has no date to rank on.',
      },
      vocab: {
        storage_conditions: FSSAI_STORAGE_CONDITIONS,
        temp_uoms: FSSAI_TEMP_UOMS,
        near_expiry_days_default: FSSAI_NEAR_EXPIRY_DAYS,
      },
      /* The SAME predicate requireFssaiAdmin uses below, so the screen hides the
       * editing controls exactly when the route would refuse them — never one
       * without the other. It is a convenience for the UI and not the gate. */
      can_edit: canAuthorFssai(g.me),
      truncated: rows.length >= LIST_LIMIT,
    });
  } catch (e: any) {
    console.error('GET /api/fssai/fifo/shelf-life failed:', e);
    return Response.json({ error: e?.message || 'Failed to load the shelf-life settings' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const csrf = fssaiCsrfGuard(request);
  if (csrf) return csrf;
  /* ADMIN, not management. Shelf life is a rule about food, and owner §20 puts
   * the rules in the administrator's hands — the same gate the checklist builder
   * uses. */
  const g = await requireFssaiAdmin();
  if ('resp' in g) return g.resp;
  const me = g.me;

  let body: any = {};
  try { body = await request.json(); } catch { /* validated below */ }

  try {
    const db = getDb();
    const outletId = (await getCurrentOutletId()) || '';
    const action = str(body?.action) || 'save';

    if (action === 'retire' || action === 'restore') {
      const id = str(body?.id);
      if (!id) return Response.json({ error: 'Which item? No id was sent.' }, { status: 400 });
      const row = db.prepare(`SELECT * FROM fssai_item_shelf_life WHERE id = ?`).get(id) as any;
      if (!row) return Response.json({ error: 'That shelf-life setting no longer exists.' }, { status: 404 });
      const next = action === 'retire' ? 0 : 1;

      /* RETIRED, NOT DELETED, even though this is configuration rather than a
       * record. A deleted row would lose the near-expiry window every entry on
       * the register was judged against, and the unique index is on
       * (outlet_id, material_id), so a delete-then-re-add would silently become a
       * different row with the same meaning. */
      const apply = db.transaction(() => {
        db.prepare(
          `UPDATE fssai_item_shelf_life SET is_active = ?, updated_at = datetime('now') WHERE id = ?`,
        ).run(next, id);
        fssaiAudit(db, {
          entity_table: 'fssai_item_shelf_life', entity_id: id,
          action: action === 'retire' ? 'update' : 'reopen', field: 'is_active',
          before: { is_active: Number(row.is_active) },
          after: { is_active: next },
          reason: str(body?.reason).slice(0, 500),
          actor: { email: me.email, name: me.name }, outlet_id: outletId || row.outlet_id,
        });
      });
      apply();

      const fresh = db.prepare(`${SHELF_SELECT} WHERE sl.id = ?`).get(id) as any;
      return Response.json({ ok: true, row: shapeShelfLife(fresh) });
    }

    if (action !== 'save') {
      return Response.json(
        { error: `"${action}" is not something this screen does. Use save, retire or restore.` },
        { status: 400 },
      );
    }

    const materialId = str(body?.material_id);
    if (!materialId) return Response.json({ error: 'Pick the item first.' }, { status: 400 });
    const material = db.prepare(`SELECT id, name FROM raw_materials WHERE id = ?`).get(materialId) as any;
    if (!material) {
      return Response.json(
        { error: 'That item is not in the Item Master. Add it there first — this screen never creates items.' },
        { status: 400 },
      );
    }

    const cond = str(body?.storage_condition) || 'ambient';
    if (!FSSAI_STORAGE_CONDITIONS.some((c) => c.key === cond)) {
      return Response.json({ error: `"${cond}" is not a way an item is kept.` }, { status: 400 });
    }
    const uom = str(body?.temp_uom) || 'C';
    if (!FSSAI_TEMP_UOMS.some((u) => u.key === uom)) {
      return Response.json({ error: `"${uom}" is not a temperature unit.` }, { status: 400 });
    }

    const shelfDays = nullableInt(body?.shelf_life_days);
    const openedDays = nullableInt(body?.opened_shelf_life_days);
    const nearDays = nullableInt(body?.near_expiry_days);
    for (const [label, v] of [['shelf life', shelfDays], ['opened shelf life', openedDays], ['use-first window', nearDays]] as const) {
      if (v !== null && (v < 0 || v > 3650)) {
        return Response.json({ error: `A ${label} of ${v} days is not a number this will accept. Use 0 to 3650, or leave it blank for "not set".` }, { status: 400 });
      }
    }
    /* An opened shelf life LONGER than the unopened one is almost certainly the
     * two boxes filled in the wrong order, and it would make the register say an
     * opened tub keeps longer than a sealed one. Refused by name rather than
     * stored and puzzled over later. */
    if (shelfDays !== null && openedDays !== null && openedDays > shelfDays) {
      return Response.json(
        { error: `Once opened, ${material.name} cannot keep longer (${openedDays} days) than it keeps sealed (${shelfDays} days). Check the two boxes.` },
        { status: 400 },
      );
    }

    const tMin = num(body?.storage_temp_min);
    const tMax = num(body?.storage_temp_max);
    if (tMin !== null && tMax !== null && tMin > tMax) {
      return Response.json(
        { error: `The storage range reads ${tMin} to ${tMax} ${uom}, which is the wrong way round.` },
        { status: 400 },
      );
    }

    const existing = db.prepare(
      `SELECT * FROM fssai_item_shelf_life WHERE outlet_id = ? AND material_id = ?`,
    ).get(outletId, materialId) as any;

    const id = existing ? String(existing.id) : generateId();
    const fields = {
      material_name: String(material.name || '').slice(0, 300),
      storage_condition: cond,
      shelf_life_days: shelfDays,
      opened_shelf_life_days: openedDays,
      near_expiry_days: nearDays,
      storage_temp_min: tMin,
      storage_temp_max: tMax,
      temp_uom: uom,
      label_rule: str(body?.label_rule).slice(0, 500),
      is_high_risk: toInt01(body?.is_high_risk, 0),
      notes: str(body?.notes).slice(0, 2000),
      is_active: toInt01(body?.is_active, 1),
    };

    try {
      const write = db.transaction(() => {
        if (existing) {
          db.prepare(
            `UPDATE fssai_item_shelf_life
                SET material_name = ?, storage_condition = ?, shelf_life_days = ?,
                    opened_shelf_life_days = ?, near_expiry_days = ?,
                    storage_temp_min = ?, storage_temp_max = ?, temp_uom = ?,
                    label_rule = ?, is_high_risk = ?, notes = ?, is_active = ?,
                    updated_at = datetime('now')
              WHERE id = ?`,
          ).run(
            fields.material_name, fields.storage_condition, fields.shelf_life_days,
            fields.opened_shelf_life_days, fields.near_expiry_days,
            fields.storage_temp_min, fields.storage_temp_max, fields.temp_uom,
            fields.label_rule, fields.is_high_risk, fields.notes, fields.is_active, id,
          );
        } else {
          db.prepare(
            `INSERT INTO fssai_item_shelf_life
               (id, material_id, material_name, storage_condition, shelf_life_days,
                opened_shelf_life_days, near_expiry_days, storage_temp_min, storage_temp_max,
                temp_uom, label_rule, is_high_risk, notes, is_active, created_by, outlet_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            id, materialId, fields.material_name, fields.storage_condition, fields.shelf_life_days,
            fields.opened_shelf_life_days, fields.near_expiry_days,
            fields.storage_temp_min, fields.storage_temp_max, fields.temp_uom,
            fields.label_rule, fields.is_high_risk, fields.notes, fields.is_active,
            me.email || '', outletId,
          );
        }

        /* THROWS: this is the administrator's own configuration work, and §19
         * wants the old value beside the new one. He can retry. */
        fssaiAudit(db, {
          entity_table: 'fssai_item_shelf_life', entity_id: id,
          action: existing ? 'update' : 'create',
          before: existing
            ? {
              storage_condition: String(existing.storage_condition || ''),
              shelf_life_days: existing.shelf_life_days ?? null,
              opened_shelf_life_days: existing.opened_shelf_life_days ?? null,
              near_expiry_days: existing.near_expiry_days ?? null,
              storage_temp_min: real(existing.storage_temp_min),
              storage_temp_max: real(existing.storage_temp_max),
              is_high_risk: Number(existing.is_high_risk),
              is_active: Number(existing.is_active),
            }
            : undefined,
          after: fields,
          reason: str(body?.reason).slice(0, 500),
          actor: { email: me.email, name: me.name }, outlet_id: outletId,
        });
      });
      write();
    } catch (e: any) {
      /* uq_fssai_shelf_material is UNIQUE(outlet_id, material_id). The read above
       * should have found it, so hitting this means two administrators saved the
       * same item at the same moment — said in words rather than as a SQLite
       * string. */
      const msg = constraintMessage(e, `${material.name} already has a shelf life set. Reload the screen and edit the row that is there.`);
      if (msg) return Response.json({ error: msg }, { status: 409 });
      throw e;
    }

    fssaiAppAudit(db, {
      event_type: existing ? 'fssai.shelf_life.update' : 'fssai.shelf_life.create',
      entity_type: 'fssai_item_shelf_life', entity_id: id,
      actor_email: me.email, after: fields,
    });

    const fresh = db.prepare(`${SHELF_SELECT} WHERE sl.id = ?`).get(id) as any;
    return Response.json({
      ok: true,
      row: shapeShelfLife(fresh),
      /* Said out loud because it is the first thing an administrator assumes
       * went the other way: the Item Master is untouched. */
      item_master_unchanged: true,
    });
  } catch (e: any) {
    console.error('POST /api/fssai/fifo/shelf-life failed:', e);
    return Response.json({ error: e?.message || 'Failed to save the shelf life' }, { status: 500 });
  }
}

/* No DELETE. A shelf-life row is RETIRED (is_active = 0) so the window every
 * register entry was judged against stays readable. */
