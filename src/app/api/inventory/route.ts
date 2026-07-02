import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { effectiveCategoriesForUser } from '@/lib/dept-hierarchy';

export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const category = url.searchParams.get('category');
    const search = url.searchParams.get('search');
    const lowStock = url.searchParams.get('low_stock');
    // scope=all bypasses the dept-category whitelist. Used by store operations
    // (GRN, Purchases, Purchase Orders) where the user needs to see every
    // material regardless of their dept restrictions.
    const scope = url.searchParams.get('scope');
    // vendor_id filter — when set, restricts to materials that have an active
    // contract with that vendor (vendor_contracts table). Empty filter when
    // the vendor has no contracts at all — caller should fall back to scope=all.
    const vendorId = url.searchParams.get('vendor_id');
    // Department-scoped material visibility:
    // - admin / store manager → see everything (they buy for every department)
    // - scope=all → see everything (callers like /grn must opt in)
    // - everyone else, INCLUDING dept heads (Main Chef / Bar Manager / GM) →
    //   filtered to their MAIN department's `material_categories` whitelist, which
    //   sub-departments inherit. NULL whitelist on the main dept = no filter.
    const me = await getCurrentUser();
    let categoryWhitelist: string[] | null = null;
    if (scope !== 'all' && me && me.role !== 'admin' && !me.is_store_manager) {
      categoryWhitelist = effectiveCategoriesForUser(db, me);
    }

    let query = `
      SELECT rm.*,
        COALESCE((SELECT unit_price FROM purchases WHERE material_id = rm.id ORDER BY date DESC, created_at DESC LIMIT 1), 0) as last_purchase_price,
        COALESCE((SELECT date FROM purchases WHERE material_id = rm.id ORDER BY date DESC, created_at DESC LIMIT 1), '') as last_purchase_date,
        COALESCE((SELECT SUM(ABS(quantity)) FROM inventory_transactions WHERE material_id = rm.id AND quantity < 0), 0) as total_consumed,
        ROUND(rm.current_stock * rm.average_price, 2) as stock_value,
        -- Recency view: rolling 30-day (monthly) weighted avg drives recipe / req cost.
        -- Also expose 90-day + all-time for the UI comparison column.
        (SELECT ROUND(SUM(quantity * unit_price) / NULLIF(SUM(quantity), 0), 2)
           FROM purchases WHERE material_id = rm.id AND date >= date('now','-30 day')) AS avg_price_30d,
        (SELECT ROUND(SUM(quantity * unit_price) / NULLIF(SUM(quantity), 0), 2)
           FROM purchases WHERE material_id = rm.id AND date >= date('now','-90 day')) AS avg_price_90d,
        (SELECT ROUND(SUM(quantity * unit_price) / NULLIF(SUM(quantity), 0), 2)
           FROM purchases WHERE material_id = rm.id) AS avg_price_all_time
      FROM raw_materials rm
      WHERE 1=1
    `;
    const params: any[] = [];

    if (category) {
      query += ' AND rm.category = ?';
      params.push(category);
    }
    if (categoryWhitelist) {
      const placeholders = categoryWhitelist.map(() => '?').join(',');
      query += ` AND rm.category IN (${placeholders})`;
      params.push(...categoryWhitelist);
    }
    if (vendorId) {
      // Limit to materials with at least one currently-active vendor_contracts
      // row for this vendor. is_active=1 AND today between valid_from/valid_to.
      query += ` AND rm.id IN (
        SELECT material_id FROM vendor_contracts
        WHERE vendor_id = ?
          AND is_active = 1
          AND date('now') >= valid_from
          AND (valid_to IS NULL OR date('now') <= valid_to)
      )`;
      params.push(vendorId);
    }
    if (search) {
      query += ' AND rm.name LIKE ?';
      params.push(`%${search}%`);
    }
    if (lowStock === 'true') {
      query += ' AND rm.reorder_level > 0 AND rm.current_stock < rm.reorder_level';
    }

    query += ' ORDER BY rm.name ASC';

    const materials = db.prepare(query).all(...params);
    return Response.json({ materials });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

// Helper: enforce duplicate-name rule (Phase 1 §1) with case-insensitive match.
function isDuplicateName(db: ReturnType<typeof getDb>, name: string, excludeId?: string): boolean {
  const row = db.prepare(`
    SELECT id FROM raw_materials WHERE LOWER(name) = LOWER(?) ${excludeId ? 'AND id != ?' : ''}
  `).get(...(excludeId ? [name, excludeId] : [name])) as any;
  return !!row;
}

// Helper: enforce duplicate-SKU rule (Phase 1 §1).
function isDuplicateSku(db: ReturnType<typeof getDb>, sku: string, excludeId?: string): boolean {
  if (!sku) return false;
  const row = db.prepare(`
    SELECT id FROM raw_materials WHERE LOWER(sku) = LOWER(?) ${excludeId ? 'AND id != ?' : ''}
  `).get(...(excludeId ? [sku, excludeId] : [sku])) as any;
  return !!row;
}

// Helper: generate next MAT-NNNNN SKU (zero-padded, gapless wrt highest existing).
function nextSku(db: ReturnType<typeof getDb>): string {
  const row = db.prepare(`
    SELECT sku FROM raw_materials
    WHERE sku LIKE 'MAT-%' AND sku GLOB 'MAT-[0-9]*'
    ORDER BY CAST(SUBSTR(sku, 5) AS INTEGER) DESC LIMIT 1
  `).get() as any;
  const last = row?.sku ? parseInt(row.sku.replace('MAT-', ''), 10) || 0 : 0;
  return `MAT-${String(last + 1).padStart(5, '0')}`;
}

export async function POST(request: Request) {
  try {
    const db = getDb();
    const body = await request.json();
    const {
      name, sku: skuInput, category, unit, purchase_unit, pack_size, case_size, reorder_level, costing_method,
      // ----- Phase 1 master fields -----
      super_category, brand, yield_percent, tax_percent, cess_percent,
      standard_purchase_rate, closing_cadence,
      is_recipe_item, is_direct_sell, is_semifinished,
      storage_location, shelf_life_days,
    } = body;

    if (!name) return Response.json({ error: 'name is required' }, { status: 400 });
    if (isDuplicateName(db, String(name).trim())) {
      return Response.json({ error: `Duplicate material name: "${name}" already exists. Phase 1 SOP: no duplicates.` }, { status: 409 });
    }
    // Phase 1 §1 — every material MUST have a SKU. If caller didn't provide one,
    // auto-generate the next MAT-NNNNN. If they did, validate uniqueness.
    let sku = String(skuInput || '').trim();
    if (sku) {
      if (isDuplicateSku(db, sku)) {
        return Response.json({ error: `SKU "${sku}" already in use.` }, { status: 409 });
      }
    } else {
      sku = nextSku(db);
    }

    const id = generateId();
    db.prepare(`
      INSERT INTO raw_materials (
        id, sku, name, category, unit, purchase_unit, pack_size, case_size, reorder_level, costing_method,
        super_category, brand, yield_percent, tax_percent, cess_percent,
        standard_purchase_rate, closing_cadence, is_recipe_item, is_direct_sell, is_semifinished,
        storage_location, shelf_life_days,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      id, sku, name, category || 'other', unit || 'kg',
      purchase_unit || unit || 'kg',
      pack_size != null ? Number(pack_size) : 1,
      case_size != null ? Number(case_size) : 1,
      reorder_level ?? 0, costing_method || 'average',
      super_category || '', brand || '',
      yield_percent != null ? Number(yield_percent) : 100,
      tax_percent   != null ? Number(tax_percent)   : 0,
      cess_percent  != null ? Number(cess_percent)  : 0,
      standard_purchase_rate != null ? Number(standard_purchase_rate) : 0,
      ['daily','weekly','monthly','none'].includes(closing_cadence) ? closing_cadence : 'none',
      is_recipe_item ? 1 : 0, is_direct_sell ? 1 : 0, is_semifinished ? 1 : 0,
      storage_location || '',
      shelf_life_days != null ? Number(shelf_life_days) : 0,
    );

    const material = db.prepare('SELECT * FROM raw_materials WHERE id = ?').get(id);
    return Response.json({ material }, { status: 201 });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const db = getDb();
    const body = await request.json();
    const {
      id, name, category, unit, purchase_unit, pack_size, case_size, reorder_level, costing_method,
      super_category, brand, yield_percent, tax_percent, cess_percent,
      standard_purchase_rate, closing_cadence,
      is_recipe_item, is_direct_sell, is_semifinished,
      storage_location, shelf_life_days,
      average_price,   // optional manual override; expected per recipe-unit
    } = body;

    if (!id) return Response.json({ error: 'id is required' }, { status: 400 });
    const existing = db.prepare('SELECT * FROM raw_materials WHERE id = ?').get(id) as any;
    if (!existing) return Response.json({ error: 'Material not found' }, { status: 404 });

    if (name && String(name).trim() && String(name).toLowerCase() !== String(existing.name).toLowerCase()
        && isDuplicateName(db, String(name).trim(), id)) {
      return Response.json({ error: `Duplicate material name: "${name}" already exists.` }, { status: 409 });
    }

    // average_price: optional manual override (per recipe-unit). Use COALESCE so
    // we only update when caller explicitly sets it; otherwise auto-recompute
    // (from purchases) keeps managing it.
    const overrideAvgPrice = (average_price != null && Number.isFinite(Number(average_price)))
      ? Number(average_price) : null;

    db.prepare(`
      UPDATE raw_materials
      SET name = ?, category = ?, unit = ?, purchase_unit = ?, pack_size = ?, case_size = ?,
          reorder_level = ?, costing_method = ?,
          super_category = ?, brand = ?, yield_percent = ?, tax_percent = ?, cess_percent = ?,
          standard_purchase_rate = ?, closing_cadence = ?,
          is_recipe_item = ?, is_direct_sell = ?, is_semifinished = ?,
          storage_location = ?, shelf_life_days = ?,
          average_price = CASE WHEN ? IS NOT NULL THEN ? ELSE average_price END,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      name || existing.name,
      category || existing.category,
      unit || existing.unit,
      purchase_unit ?? existing.purchase_unit,
      pack_size != null ? Number(pack_size) : existing.pack_size,
      case_size != null ? Number(case_size) : (existing.case_size ?? 1),
      reorder_level ?? existing.reorder_level,
      costing_method || existing.costing_method,
      super_category ?? existing.super_category ?? '',
      brand ?? existing.brand ?? '',
      yield_percent != null ? Number(yield_percent) : existing.yield_percent,
      tax_percent   != null ? Number(tax_percent)   : existing.tax_percent,
      cess_percent  != null ? Number(cess_percent)  : existing.cess_percent,
      standard_purchase_rate != null ? Number(standard_purchase_rate) : existing.standard_purchase_rate,
      ['daily','weekly','monthly','none'].includes(closing_cadence) ? closing_cadence : (existing.closing_cadence || 'none'),
      is_recipe_item   != null ? (is_recipe_item   ? 1 : 0) : existing.is_recipe_item,
      is_direct_sell   != null ? (is_direct_sell   ? 1 : 0) : existing.is_direct_sell,
      is_semifinished  != null ? (is_semifinished  ? 1 : 0) : existing.is_semifinished,
      storage_location ?? existing.storage_location ?? '',
      shelf_life_days != null ? Number(shelf_life_days) : (existing.shelf_life_days ?? 0),
      // Two placeholders for the CASE expression on average_price
      overrideAvgPrice, overrideAvgPrice,
      id
    );

    // Cascade recipe + sub-recipe cost recalc if avg_price changed
    if (overrideAvgPrice != null) {
      try {
        const { recalculateSubRecipeCost, recalculateRecipeCost } = await import('@/lib/db');
        const subRecipes = db.prepare(`SELECT DISTINCT sub_recipe_id FROM sub_recipe_ingredients WHERE material_id = ?`).all(id) as any[];
        for (const sr of subRecipes) recalculateSubRecipeCost(db, sr.sub_recipe_id);
        const recipes = db.prepare(`SELECT DISTINCT recipe_id FROM recipe_ingredients WHERE material_id = ?`).all(id) as any[];
        for (const r of recipes) recalculateRecipeCost(db, r.recipe_id);
      } catch (e: any) {
        console.warn('[/api/inventory PUT] cascade failed:', e?.message);
      }
    }

    const material = db.prepare('SELECT * FROM raw_materials WHERE id = ?').get(id);
    return Response.json({ material });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
