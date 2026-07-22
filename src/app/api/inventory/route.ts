import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { effectiveCategoriesForUser } from '@/lib/dept-hierarchy';
import { lockedUnitFields } from '@/lib/unit-audit-lock';

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
    // exclude_store_mapped=1 — hide materials whose category belongs to an
    // ACTIVE store location (store_category_map, NOCASE). Opt-in: only Central
    // closing-stock surfaces pass it (store-mapped liquor is counted in its own
    // store's closing). All other callers see the full list as before.
    const excludeStoreMapped = url.searchParams.get('exclude_store_mapped') === '1';
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
        -- Latest price PER PURCHASE UNIT = total/qty of the most recent purchase.
        -- Purchase rows record quantity in PURCHASE units (core convention), so
        -- total/qty already IS ₹/purchase-unit — no pack conversion here. The old
        -- "qty is a clean multiple of pack ⇒ recorded in recipe units, ×pack"
        -- repair guess false-positived on every legitimate qty that's a multiple
        -- of a small pack (6 packs of a pack-2 cover → price shown ×2) and, via
        -- SQLite's integer %, on ALL fractional packs — inflating this column.
        -- Mis-based legacy rows are data corruption for the ₹-audit to repair,
        -- not something to guess at per-row at display time.
        COALESCE((SELECT p.total_price / p.quantity
           FROM purchases p
           WHERE p.material_id = rm.id AND p.quantity > 0 AND COALESCE(p.total_price, 0) > 0
           ORDER BY p.date DESC, p.created_at DESC LIMIT 1), 0) as latest_price_purchase_unit,
        -- Exclude 'transfer' rows (Option B grocery→floor bridge writes a
        -- negative type='transfer' row per grocery-source issue): a transfer
        -- relocates stock, it is NOT consumption, so counting it here would
        -- inflate the material's consumed metric. real consumption channels
        -- (recipe/requisition/issue/sale/party/staff_meal/wastage) still count.
        COALESCE((SELECT SUM(ABS(quantity)) FROM inventory_transactions WHERE material_id = rm.id AND quantity < 0 AND type != 'transfer'), 0) as total_consumed,
        ROUND(rm.current_stock * rm.average_price, 2) as stock_value,
        -- Recency view: rolling 30-day (monthly) weighted avg drives recipe / req cost.
        -- Also expose 90-day + all-time for the UI comparison column.
        (SELECT ROUND(SUM(quantity * unit_price) / NULLIF(SUM(quantity), 0), 2)
           FROM purchases WHERE material_id = rm.id AND date >= date('now','-30 day')) AS avg_price_30d,
        (SELECT ROUND(SUM(quantity * unit_price) / NULLIF(SUM(quantity), 0), 2)
           FROM purchases WHERE material_id = rm.id AND date >= date('now','-90 day')) AS avg_price_90d,
        (SELECT ROUND(SUM(quantity * unit_price) / NULLIF(SUM(quantity), 0), 2)
           FROM purchases WHERE material_id = rm.id) AS avg_price_all_time,
        -- Unit-audit lock: when set, the edit modal disables the unit fields and
        -- points at /unit-audit (the only writer) instead of silently discarding.
        EXISTS(SELECT 1 FROM unit_audit_locks ual
               WHERE (rm.sku != '' AND ual.sku = rm.sku)
                  OR ual.name_key = lower(trim(rm.name))) AS units_locked
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
      // COLLATE NOCASE so a dept whitelist saved with different casing (e.g.
      // "Bar") still matches the lowercase stored category ("bar"). Without it a
      // case-mismatched whitelist silently drops those categories from view.
      query += ` AND rm.category COLLATE NOCASE IN (${placeholders})`;
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
    if (excludeStoreMapped) {
      query += ` AND NOT EXISTS (
        SELECT 1 FROM store_category_map scm
        JOIN store_locations sl ON sl.id = scm.store_id
        WHERE sl.is_active = 1 AND REPLACE(REPLACE(REPLACE(LOWER(TRIM(scm.category)),' ',''),'-',''),'_','') = REPLACE(REPLACE(REPLACE(LOWER(TRIM(rm.category)),' ',''),'-',''),'_','')
      )`;
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
      priority,       // 3★ critical / 2★ standard / 1★ low (default 2)
      average_price,  // ₹/recipe-unit (the form pre-converts from ₹/purchase-unit)
    } = body;

    if (!name) return Response.json({ error: 'name is required' }, { status: 400 });
    if (priority != null && ![1, 2, 3].includes(Number(priority))) {
      return Response.json({ error: 'priority must be 1, 2 or 3' }, { status: 400 });
    }
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
    // Recover units from the unit-audit lock if this name/SKU was audited before
    // (e.g. re-creating a deleted material) — the lock is the source of truth.
    const newLock = lockedUnitFields(db, { sku, name });
    const newUnit = newLock?.unit ?? (unit || 'kg');
    const newPurchaseUnit = newLock?.purchase_unit ?? (purchase_unit || unit || 'kg');
    const newPackSize = newLock?.pack_size ?? (pack_size != null ? Number(pack_size) : 1);
    const newCaseSize = newLock?.case_size ?? (case_size != null ? Number(case_size) : 1);
    db.prepare(`
      INSERT INTO raw_materials (
        id, sku, name, category, unit, purchase_unit, pack_size, case_size, reorder_level, costing_method,
        super_category, brand, yield_percent, tax_percent, cess_percent,
        standard_purchase_rate, closing_cadence, is_recipe_item, is_direct_sell, is_semifinished,
        storage_location, shelf_life_days, priority, average_price,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      id, sku, name, category || 'other', newUnit,
      newPurchaseUnit,
      newPackSize,
      newCaseSize,
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
      priority != null ? Number(priority) : 2,
      // The form pre-converts ₹/purchase-unit → ₹/recipe-unit before sending —
      // the PUT has always honored this; the POST dropped it, so every new
      // material landed at ₹0 until edited a second time.
      (average_price != null && Number.isFinite(Number(average_price))) ? Number(average_price) : 0,
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
      priority,        // 3★ critical / 2★ standard / 1★ low
      average_price,   // optional manual override; expected per recipe-unit
    } = body;

    if (!id) return Response.json({ error: 'id is required' }, { status: 400 });
    if (priority != null && ![1, 2, 3].includes(Number(priority))) {
      return Response.json({ error: 'priority must be 1, 2 or 3' }, { status: 400 });
    }
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

    // Unit-audit lock is authoritative: if this material has been audited, its
    // unit-of-measure fields are the source of truth and CANNOT be changed here
    // — only via the /unit-audit page. We keep the existing values (protect) and
    // flag it so the UI can tell the user to edit units in Unit Audit instead.
    const lock = lockedUnitFields(db, { sku: existing.sku, name: existing.name });
    const unitVal = lock?.unit != null ? existing.unit : (unit || existing.unit);
    const purchaseUnitVal = lock?.purchase_unit != null ? existing.purchase_unit : (purchase_unit ?? existing.purchase_unit);
    const packSizeVal = lock?.pack_size != null ? existing.pack_size : (pack_size != null ? Number(pack_size) : existing.pack_size);
    const caseSizeVal = lock?.case_size != null ? (existing.case_size ?? 1) : (case_size != null ? Number(case_size) : (existing.case_size ?? 1));
    const unitsLockedIgnored = !!lock && (
      (unit != null && unit !== existing.unit) ||
      (purchase_unit != null && purchase_unit !== existing.purchase_unit) ||
      (pack_size != null && Number(pack_size) !== Number(existing.pack_size)) ||
      (case_size != null && Number(case_size) !== Number(existing.case_size ?? 1))
    );

    db.prepare(`
      UPDATE raw_materials
      SET name = ?, category = ?, unit = ?, purchase_unit = ?, pack_size = ?, case_size = ?,
          reorder_level = ?, costing_method = ?,
          super_category = ?, brand = ?, yield_percent = ?, tax_percent = ?, cess_percent = ?,
          standard_purchase_rate = ?, closing_cadence = ?,
          is_recipe_item = ?, is_direct_sell = ?, is_semifinished = ?,
          storage_location = ?, shelf_life_days = ?, priority = ?,
          average_price = CASE WHEN ? IS NOT NULL THEN ? ELSE average_price END,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      name || existing.name,
      category || existing.category,
      unitVal,
      purchaseUnitVal,
      packSizeVal,
      caseSizeVal,
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
      priority != null ? Number(priority) : (existing.priority ?? 2),
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
    return Response.json({
      material,
      // True when the caller tried to change unit-of-measure fields on a material
      // whose units are locked by Unit Audit — the change was ignored on purpose.
      units_locked: unitsLockedIgnored,
      ...(unitsLockedIgnored ? { units_locked_note: 'Units are locked by Unit Audit and were left unchanged. Edit them on the Unit Audit page.' } : {}),
    });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
