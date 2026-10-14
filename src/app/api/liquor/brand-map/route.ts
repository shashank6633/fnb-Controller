import { getDb, generateId } from '@/lib/db';
import { catNorm } from '@/lib/store-engine';
import { LQ_PRODUCT_TYPES } from '@/lib/liquor-recon';
import { requireBrandMapAdmin, gateResponse, requireAuditedWrite } from './_lib/guard';
import { normProductType, normCode, BRAND_MAP_CSV_HEADER } from './_lib/rows';

/**
 * TGBCL BRAND MASTER ↔ our materials — phase L1 of the Liquor Purchase
 * Reconciliation (docs/liquor-reconciliation-plan.md).
 *
 *   GET    /api/liquor/brand-map[?q=&material_id=&include_inactive=1]
 *   POST   /api/liquor/brand-map        create one mapping
 *   PUT    /api/liquor/brand-map        update one mapping (by id)
 *   DELETE /api/liquor/brand-map?id=    remove one mapping
 *
 * ONE MATERIAL, SEVERAL PACKS. The key is (tgbcl_brand_code, size_code), not
 * material_id — the workbook's 9740-PP and 9740-NN are the same brand in two
 * pack sizes and both map to the same material. The UNIQUE index in db.ts
 * enforces exactly that, and this route never adds a material_id uniqueness
 * rule on top of it.
 *
 * VALUATION IS NOT TOUCHED. Nothing here writes raw_materials.average_price,
 * raw_materials.last_purchase_price or store_stock_ledger.unit_cost. Plan
 * decision 1(a): the TGBCL levies stay recorded-only and landed cost is an
 * analytics figure inside this module. The ONLY table this route writes is
 * lq_brand_map (plus audit_events).
 *
 * Gate: ADMIN, server-side, on every verb — see _lib/guard.ts. Writes are
 * additionally CSRF-checked there, because '/api/liquor' is not in the proxy's
 * CSRF prefix list and cannot be added from this phase.
 */
export const dynamic = 'force-dynamic';

interface Payload {
  material_id?: unknown;
  tgbcl_brand_code?: unknown;
  size_code?: unknown;
  size_ml?: unknown;
  bottles_per_case?: unknown;
  rate_per_case_master?: unknown;
  product_type?: unknown;
  is_active?: unknown;
  note?: unknown;
}

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const r4 = (n: number) => Math.round((Number(n) || 0) * 1e4) / 1e4;

/** Validate + normalise a create/update body. Returns a message on refusal. */
function normalise(db: ReturnType<typeof getDb>, b: Payload): { ok: true; v: {
  material_id: string; tgbcl_brand_code: string; size_code: string; size_ml: number;
  bottles_per_case: number; rate_per_case_master: number; product_type: string;
  is_active: number; note: string; material_name: string;
} } | { ok: false; error: string } {
  const material_id = String(b.material_id ?? '').trim();
  if (!material_id) return { ok: false, error: 'Pick the material this TGBCL code maps to.' };
  const mat = db.prepare('SELECT id, name FROM raw_materials WHERE id = ?').get(material_id) as any;
  if (!mat) return { ok: false, error: 'That material no longer exists.' };

  const tgbcl_brand_code = normCode(b.tgbcl_brand_code);
  if (!tgbcl_brand_code) return { ok: false, error: 'TGBCL brand code is required.' };
  const size_code = normCode(b.size_code);

  const size_ml = Number(b.size_ml ?? 0);
  if (!Number.isFinite(size_ml) || size_ml < 0) {
    return { ok: false, error: 'Size (ml) must be a number ≥ 0 — leave it 0 if the bottle size is unknown.' };
  }

  // NO DEFAULT AND > 0, matching the schema CHECK. Every landed cost in this
  // module divides by it, and SQLite returns NULL rather than raising on a
  // divide by zero — which is the exact value landedCostPerBottle() reserves
  // for "not mapped". A mapped row that reads as unmapped is worse than a
  // refusal, so this is a hard error, never a coerced 1.
  const bpcRaw = Number(b.bottles_per_case);
  if (!Number.isFinite(bpcRaw) || bpcRaw <= 0 || !Number.isInteger(bpcRaw)) {
    return { ok: false, error: 'Bottles per case must be a whole number greater than 0 — every landed cost divides by it.' };
  }

  const rate = Number(b.rate_per_case_master ?? 0);
  if (!Number.isFinite(rate) || rate < 0) {
    return { ok: false, error: 'Rate per case must be a number ≥ 0 (₹ per CASE, the TGBCL issue price).' };
  }

  const product_type = normProductType(String(b.product_type ?? ''));
  if (!product_type) {
    return { ok: false, error: `Product type must be one of: ${LQ_PRODUCT_TYPES.join(', ')}.` };
  }

  return {
    ok: true,
    v: {
      material_id, tgbcl_brand_code, size_code, size_ml,
      bottles_per_case: bpcRaw, rate_per_case_master: r2(rate),
      product_type, is_active: b.is_active === 0 || b.is_active === false ? 0 : 1,
      note: String(b.note ?? '').trim(), material_name: String(mat.name || ''),
    },
  };
}

const SELECT_ROWS = `
  SELECT bm.id, bm.material_id, bm.tgbcl_brand_code, bm.size_code, bm.size_ml,
         bm.bottles_per_case, bm.rate_per_case_master, bm.product_type,
         bm.is_active, bm.note, bm.created_by, bm.created_at, bm.updated_at,
         rm.name AS material_name, rm.sku AS material_sku, rm.category AS material_category,
         rm.unit AS material_unit, rm.purchase_unit AS material_purchase_unit,
         rm.pack_size AS material_pack_size, rm.case_size AS material_case_size
  FROM lq_brand_map bm
  JOIN raw_materials rm ON rm.id = bm.material_id
`;

export async function GET(request: Request) {
  const gate = await requireBrandMapAdmin(request);
  if (!gate.ok) return gateResponse(gate);
  try {
    const db = getDb();
    const qs = new URL(request.url).searchParams;
    const q = (qs.get('q') || '').trim();
    const materialId = (qs.get('material_id') || '').trim();
    const includeInactive = qs.get('include_inactive') === '1';

    const where: string[] = [];
    const args: any[] = [];
    if (!includeInactive) where.push('bm.is_active = 1');
    if (materialId) { where.push('bm.material_id = ?'); args.push(materialId); }
    if (q) {
      where.push(`(rm.name LIKE ? COLLATE NOCASE OR rm.sku LIKE ? COLLATE NOCASE
                   OR bm.tgbcl_brand_code LIKE ? COLLATE NOCASE OR bm.size_code LIKE ? COLLATE NOCASE)`);
      const like = `%${q}%`;
      args.push(like, like, like, like);
    }
    const rows = (db.prepare(`
      ${SELECT_ROWS}
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY rm.name COLLATE NOCASE, bm.tgbcl_brand_code, bm.size_code
    `).all(...args) as any[]).map(r => ({
      ...r,
      // DERIVED, never stored — see the db.ts comment on lq_brand_map.
      rate_per_bottle_master: r.bottles_per_case > 0
        ? r4(Number(r.rate_per_case_master) / Number(r.bottles_per_case)) : 0,
    }));

    // The pickable universe: materials whose category is mapped to an ACTIVE
    // store location. That is the TGBCL shelf — a brand code is meaningless on
    // a central-store grocery, and offering 900 rows in the picker would bury
    // the 127 that can actually carry one.
    const materials = db.prepare(`
      SELECT rm.id, rm.name, rm.sku, rm.category, rm.unit, rm.purchase_unit,
             rm.pack_size, rm.case_size
      FROM raw_materials rm
      WHERE rm.is_active = 1
        AND EXISTS (
          SELECT 1 FROM store_category_map m
          JOIN store_locations s ON s.id = m.store_id
          WHERE s.is_active = 1 AND ${catNorm('m.category')} = ${catNorm('rm.category')}
        )
      ORDER BY rm.name COLLATE NOCASE
    `).all() as any[];

    const totals = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active,
             COUNT(DISTINCT material_id) AS materials_mapped
      FROM lq_brand_map
    `).get() as any;

    return Response.json({
      ok: true,
      rows,
      materials,
      product_types: LQ_PRODUCT_TYPES,
      csv_header: BRAND_MAP_CSV_HEADER,
      counts: {
        total: Number(totals?.total) || 0,
        active: Number(totals?.active) || 0,
        materials_mapped: Number(totals?.materials_mapped) || 0,
        materials_available: materials.length,
      },
    });
  } catch (e: any) {
    console.error('[GET /api/liquor/brand-map]', e);
    return Response.json({ error: 'Could not load the brand map.' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const gate = await requireBrandMapAdmin(request);
  if (!gate.ok) return gateResponse(gate);
  try {
    const db = getDb();
    const body = (await request.json().catch(() => ({}))) as Payload;
    const n = normalise(db, body);
    if (!n.ok) return Response.json({ error: n.error }, { status: 400 });
    const v = n.v;

    const clash = db.prepare(
      'SELECT id, material_id FROM lq_brand_map WHERE tgbcl_brand_code = ? AND size_code = ?',
    ).get(v.tgbcl_brand_code, v.size_code) as any;
    if (clash) {
      return Response.json({
        error: `${v.tgbcl_brand_code}${v.size_code ? '-' + v.size_code : ''} is already mapped. Edit that row instead — one TGBCL code + pack is one master row.`,
        existing_id: clash.id,
      }, { status: 409 });
    }

    const id = generateId();
    const run = db.transaction(() => {
      db.prepare(`
        INSERT INTO lq_brand_map
          (id, material_id, tgbcl_brand_code, size_code, size_ml, bottles_per_case,
           rate_per_case_master, product_type, is_active, note, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, v.material_id, v.tgbcl_brand_code, v.size_code, v.size_ml,
        v.bottles_per_case, v.rate_per_case_master, v.product_type, v.is_active,
        v.note, gate.user.email);
      requireAuditedWrite(db, {
        event_type: 'liquor.brand_map.create',
        entity_type: 'lq_brand_map',
        entity_id: id,
        actor_email: gate.user.email,
        after: { ...v },
        note: `Mapped ${v.material_name} → TGBCL ${v.tgbcl_brand_code}${v.size_code ? '-' + v.size_code : ''}`,
      }, 'this new brand mapping');
    });
    run();
    return Response.json({ ok: true, id }, { status: 201 });
  } catch (e: any) {
    console.error('[POST /api/liquor/brand-map]', e);
    const msg = String(e?.message || '');
    if (msg.includes('UNIQUE')) {
      return Response.json({ error: 'That TGBCL code + pack is already mapped.' }, { status: 409 });
    }
    if (msg.includes('CHECK')) {
      return Response.json({ error: 'The database refused those values — check bottles per case (> 0) and product type.' }, { status: 400 });
    }
    return Response.json({ error: msg || 'Could not save the mapping.' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const gate = await requireBrandMapAdmin(request);
  if (!gate.ok) return gateResponse(gate);
  try {
    const db = getDb();
    const body = (await request.json().catch(() => ({}))) as Payload & { id?: unknown };
    const id = String(body.id ?? '').trim();
    if (!id) return Response.json({ error: 'id is required' }, { status: 400 });
    const before = db.prepare('SELECT * FROM lq_brand_map WHERE id = ?').get(id) as any;
    if (!before) return Response.json({ error: 'That mapping no longer exists.' }, { status: 404 });

    const n = normalise(db, body);
    if (!n.ok) return Response.json({ error: n.error }, { status: 400 });
    const v = n.v;

    const clash = db.prepare(
      'SELECT id FROM lq_brand_map WHERE tgbcl_brand_code = ? AND size_code = ? AND id != ?',
    ).get(v.tgbcl_brand_code, v.size_code, id) as any;
    if (clash) {
      return Response.json({
        error: `${v.tgbcl_brand_code}${v.size_code ? '-' + v.size_code : ''} already belongs to another row.`,
      }, { status: 409 });
    }

    const run = db.transaction(() => {
      db.prepare(`
        UPDATE lq_brand_map
        SET material_id = ?, tgbcl_brand_code = ?, size_code = ?, size_ml = ?,
            bottles_per_case = ?, rate_per_case_master = ?, product_type = ?,
            is_active = ?, note = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(v.material_id, v.tgbcl_brand_code, v.size_code, v.size_ml,
        v.bottles_per_case, v.rate_per_case_master, v.product_type, v.is_active, v.note, id);
      requireAuditedWrite(db, {
        event_type: 'liquor.brand_map.update',
        entity_type: 'lq_brand_map',
        entity_id: id,
        actor_email: gate.user.email,
        before: {
          material_id: before.material_id, tgbcl_brand_code: before.tgbcl_brand_code,
          size_code: before.size_code, size_ml: before.size_ml,
          bottles_per_case: before.bottles_per_case,
          rate_per_case_master: before.rate_per_case_master,
          product_type: before.product_type, is_active: before.is_active, note: before.note,
        },
        after: { ...v },
        note: `Edited TGBCL ${v.tgbcl_brand_code}${v.size_code ? '-' + v.size_code : ''}`
          + (Number(before.rate_per_case_master) !== v.rate_per_case_master
            ? ` — rate/case ₹${before.rate_per_case_master} → ₹${v.rate_per_case_master}` : ''),
      }, 'this change to the brand master');
    });
    run();
    return Response.json({ ok: true, id });
  } catch (e: any) {
    console.error('[PUT /api/liquor/brand-map]', e);
    const msg = String(e?.message || '');
    if (msg.includes('UNIQUE')) return Response.json({ error: 'That TGBCL code + pack is already mapped.' }, { status: 409 });
    return Response.json({ error: msg || 'Could not save the mapping.' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const gate = await requireBrandMapAdmin(request);
  if (!gate.ok) return gateResponse(gate);
  try {
    const db = getDb();
    const id = (new URL(request.url).searchParams.get('id') || '').trim();
    if (!id) return Response.json({ error: 'id is required' }, { status: 400 });
    const before = db.prepare('SELECT * FROM lq_brand_map WHERE id = ?').get(id) as any;
    if (!before) return Response.json({ error: 'That mapping no longer exists.' }, { status: 404 });

    const run = db.transaction(() => {
      db.prepare('DELETE FROM lq_brand_map WHERE id = ?').run(id);
      requireAuditedWrite(db, {
        event_type: 'liquor.brand_map.delete',
        entity_type: 'lq_brand_map',
        entity_id: id,
        actor_email: gate.user.email,
        before: { ...before },
        note: `Removed the mapping for TGBCL ${before.tgbcl_brand_code}${before.size_code ? '-' + before.size_code : ''}`,
      }, 'the removal of this brand mapping');
    });
    run();
    return Response.json({ ok: true });
  } catch (e: any) {
    console.error('[DELETE /api/liquor/brand-map]', e);
    return Response.json({ error: String(e?.message || 'Could not remove the mapping.') }, { status: 500 });
  }
}
