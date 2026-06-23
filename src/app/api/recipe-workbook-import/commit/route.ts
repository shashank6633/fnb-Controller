import * as XLSX from 'xlsx';
import {
  getDb, generateId, recalculateRecipeCost, recalculateSubRecipeCost,
} from '@/lib/db';
import { requireRole } from '@/lib/auth';
import {
  parseRecipeWorkbook, buildMaterialResolver, normName, categorizeRecipeName,
} from '@/lib/recipe-workbook';

/**
 * Step 2 of the Food-Costing workbook import — writes to the DB. Body is
 * multipart/form-data with `file` and optional `overwrite` ("1"/"0", default 1).
 *
 * Order is deliberate: materials → sub-recipes → recipes, so recipe cost rolls up
 * against freshly-computed sub-recipe cost_per_unit. Upsert-by-name +
 * delete-all-then-reinsert children make re-imports idempotent. The workbook gives
 * rates already per base unit (g/ml/pcs), so materials store average_price directly
 * with pack_size = 1 — never divide by pack size here.
 */
export async function POST(req: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });
  try {
    const fd = await req.formData();
    const file = fd.get('file');
    if (!file || !(file instanceof Blob)) {
      return Response.json({ error: 'file field missing' }, { status: 400 });
    }
    const overwrite = String(fd.get('overwrite') ?? '1') !== '0';

    const buf = Buffer.from(await file.arrayBuffer());
    const wb = XLSX.read(buf, { type: 'buffer' });
    const parsed = parseRecipeWorkbook(XLSX, wb);

    const db = getDb();

    const report = {
      materials_created: 0,
      materials_price_updated: 0,
      sub_recipes_created: 0,
      sub_recipes_updated: 0,
      recipes_created: 0,
      recipes_updated: 0,
      ingredients_not_matched: [] as string[],
      sub_in_sub_not_imported: [] as string[],
      sub_refs_not_matched: [] as string[],
      food_cost_validation: [] as { recipe: string; computed: number; workbook: number; delta: number }[],
      errors: [] as string[],
    };

    // Summary lookups (selling price + workbook food cost) keyed by recipe name.
    const summaryByName = new Map<string, { selling: number; foodCost: number }>();
    for (const s of parsed.summary) {
      summaryByName.set(normName(s.recipe), {
        selling: s.yourMenuPrice > 0 ? s.yourMenuPrice : s.menuPriceAtTarget,
        foodCost: s.foodCost,
      });
    }

    const run = db.transaction(() => {
      // ── 1) Materials ──────────────────────────────────────────────
      const existing = db.prepare('SELECT id, name, average_price FROM raw_materials').all() as any[];
      const idByName = new Map<string, string>();
      for (const m of existing) idByName.set(normName(m.name), m.id);

      const insertMat = db.prepare(`
        INSERT INTO raw_materials (id, name, category, unit, purchase_unit, pack_size, reorder_level, costing_method, average_price, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, 0, 'average', ?, datetime('now'), datetime('now'))
      `);
      const updateMatPrice = db.prepare(`UPDATE raw_materials SET average_price = ?, updated_at = datetime('now') WHERE id = ?`);

      for (const m of parsed.materials) {
        const key = normName(m.name);
        const existingId = idByName.get(key);
        const price = Math.round(m.avgRatePerBaseUnit * 10000) / 10000;
        if (existingId) {
          if (overwrite && price > 0) { updateMatPrice.run(price, existingId); report.materials_price_updated++; }
        } else {
          const id = generateId();
          insertMat.run(id, m.name, m.category || 'other', m.baseUnit || 'g', m.purchaseUnit || '', price);
          idByName.set(key, id);
          report.materials_created++;
        }
      }

      // Resolver over the post-insert material universe (existing + newly created).
      const allMaterials = db.prepare('SELECT id, name FROM raw_materials').all() as any[];
      const resolveMat = buildMaterialResolver(allMaterials);

      // ── 2) Sub-recipes ────────────────────────────────────────────
      const existingSubs = db.prepare('SELECT id, name FROM sub_recipes WHERE is_active = 1').all() as any[];
      const subIdByName = new Map<string, string>();
      for (const s of existingSubs) subIdByName.set(normName(s.name), s.id);

      const insertSub = db.prepare(`
        INSERT INTO sub_recipes (id, name, category, yield_quantity, yield_unit, version, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'g', 1, 1, datetime('now'), datetime('now'))
      `);
      const updateSubMeta = db.prepare(`
        UPDATE sub_recipes SET category = ?, yield_quantity = ?, yield_unit = 'g', version = version + 1, updated_at = datetime('now') WHERE id = ?
      `);
      const clearSubIng = db.prepare('DELETE FROM sub_recipe_ingredients WHERE sub_recipe_id = ?');
      const insertSubIng = db.prepare(`
        INSERT INTO sub_recipe_ingredients (id, sub_recipe_id, material_id, quantity, unit, yield_percent, wastage_percent, is_default, brand_preference)
        VALUES (?, ?, ?, ?, ?, 100, 0, 1, '')
      `);

      for (const s of parsed.subRecipes) {
        const key = normName(s.name);
        let subId = subIdByName.get(key);
        if (subId) {
          if (!overwrite) continue;
          updateSubMeta.run(s.source || '', s.batchYieldG || 1, subId);
          report.sub_recipes_updated++;
        } else {
          subId = generateId();
          insertSub.run(subId, s.name, s.source || '', s.batchYieldG || 1);
          subIdByName.set(key, subId);
          report.sub_recipes_created++;
        }
        clearSubIng.run(subId);
        for (const l of s.lines) {
          const matId = resolveMat(l.ingredientName);
          if (!matId) { report.ingredients_not_matched.push(`${s.name}: ${l.ingredientName}`); continue; }
          insertSubIng.run(generateId(), subId, matId, l.qty, l.baseUnit || 'g');
        }
        for (const ref of s.subRefLines) report.sub_in_sub_not_imported.push(`${s.name}: ${ref}`);
        recalculateSubRecipeCost(db, subId);
      }

      // ── 3) Recipes ────────────────────────────────────────────────
      const existingRecipes = db.prepare('SELECT id, name FROM recipes WHERE is_active = 1').all() as any[];
      const recipeIdByName = new Map<string, string>();
      for (const r of existingRecipes) recipeIdByName.set(normName(r.name), r.id);

      const insertRecipe = db.prepare(`
        INSERT INTO recipes (id, name, category, selling_price, yield_quantity, yield_unit, version, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'g', 1, 1, datetime('now'), datetime('now'))
      `);
      const updateRecipeMeta = db.prepare(`
        UPDATE recipes SET selling_price = ?, yield_quantity = ?, yield_unit = 'g', version = version + 1, updated_at = datetime('now') WHERE id = ?
      `);
      // Only fill the category when it's blank — never clobber a manual category.
      const fillRecipeCategory = db.prepare(`
        UPDATE recipes SET category = ? WHERE id = ? AND (category IS NULL OR trim(category) = '')
      `);
      const clearRecIng = db.prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?');
      const clearRecSub = db.prepare('DELETE FROM recipe_sub_recipes WHERE recipe_id = ?');
      const insertRecIng = db.prepare(`
        INSERT INTO recipe_ingredients (id, recipe_id, material_id, quantity, unit, yield_percent, wastage_percent, is_default, brand_preference)
        VALUES (?, ?, ?, ?, ?, 100, 0, 1, '')
      `);
      const insertRecSub = db.prepare(`
        INSERT INTO recipe_sub_recipes (id, recipe_id, sub_recipe_id, quantity, unit) VALUES (?, ?, ?, ?, 'g')
      `);

      for (const r of parsed.recipes) {
        const key = normName(r.name);
        const summary = summaryByName.get(key);
        const selling = summary?.selling ?? 0;
        let recipeId = recipeIdByName.get(key);
        const category = categorizeRecipeName(r.name);
        if (recipeId) {
          if (!overwrite) continue;
          updateRecipeMeta.run(selling, r.yieldQty || 0, recipeId);
          fillRecipeCategory.run(category, recipeId);   // backfills only if blank
          report.recipes_updated++;
        } else {
          recipeId = generateId();
          insertRecipe.run(recipeId, r.name, category, selling, r.yieldQty || 0);
          recipeIdByName.set(key, recipeId);
          report.recipes_created++;
        }
        clearRecIng.run(recipeId);
        clearRecSub.run(recipeId);
        for (const l of r.lines) {
          if (l.isSubRef) {
            const subId = subIdByName.get(normName(l.name));
            if (!subId) { report.sub_refs_not_matched.push(`${r.name}: ${l.name}`); continue; }
            insertRecSub.run(generateId(), recipeId, subId, l.qty);
          } else {
            const matId = resolveMat(l.name);
            if (!matId) { report.ingredients_not_matched.push(`${r.name}: ${l.name}`); continue; }
            insertRecIng.run(generateId(), recipeId, matId, l.qty, l.baseUnit || 'g');
          }
        }
        recalculateRecipeCost(db, recipeId);

        // Validate against the workbook's TOTAL FOOD COST.
        const fresh = db.prepare('SELECT total_cost FROM recipes WHERE id = ?').get(recipeId) as any;
        const computed = Number(fresh?.total_cost ?? 0);
        const workbook = summary?.foodCost ?? r.workbookFoodCost;
        if (workbook > 0) {
          report.food_cost_validation.push({
            recipe: r.name,
            computed: Math.round(computed * 100) / 100,
            workbook: Math.round(workbook * 100) / 100,
            delta: Math.round((computed - workbook) * 100) / 100,
          });
        }
      }

      // ── 4) Persist target food-cost % from the workbook ───────────
      if (parsed.targetFoodCostPct != null && parsed.targetFoodCostPct > 0) {
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
          .run('target_food_cost_pct', String(parsed.targetFoodCostPct));
      }
    });

    run();

    // De-dupe report lists.
    report.ingredients_not_matched = [...new Set(report.ingredients_not_matched)];
    report.sub_in_sub_not_imported = [...new Set(report.sub_in_sub_not_imported)];
    report.sub_refs_not_matched = [...new Set(report.sub_refs_not_matched)];

    // Validation summary: how many recipes are off by more than ₹0.50 AND >2%.
    const offenders = report.food_cost_validation.filter(
      (v) => Math.abs(v.delta) > 0.5 && Math.abs(v.delta) > 0.02 * (v.workbook || 1),
    );

    return Response.json({
      ...report,
      validation_summary: {
        total: report.food_cost_validation.length,
        within_tolerance: report.food_cost_validation.length - offenders.length,
        offenders: offenders.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 25),
      },
    });
  } catch (e: any) {
    console.error('[recipe-workbook-import/commit]', e);
    return Response.json({ error: e.message || 'Import failed', stack: e.stack }, { status: 500 });
  }
}
