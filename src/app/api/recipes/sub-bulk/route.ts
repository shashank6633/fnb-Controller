import { getDb, generateId, recalculateSubRecipeCost, recalculateRecipeCost } from '@/lib/db';
import { requireRole } from '@/lib/auth';

interface SubBulkRow {
  sub_recipe_name: string;
  yield_qty?: number;
  yield_unit?: string;
  ingredient_name: string;
  quantity: number;
  unit?: string;
}

export async function POST(request: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });
  try {
    const db = getDb();
    const body = await request.json();
    const { rows, overwrite_existing } = body as { rows: SubBulkRow[]; overwrite_existing?: boolean };

    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return Response.json({ error: 'rows array is required' }, { status: 400 });
    }

    // Load all materials for name matching
    const allMaterials = db.prepare('SELECT id, name, unit FROM raw_materials').all() as any[];
    const materialByName = new Map<string, any>();
    for (const m of allMaterials) {
      materialByName.set(m.name.toLowerCase().trim(), m);
    }

    // Group rows by sub-recipe name
    const subGroups = new Map<string, SubBulkRow[]>();
    for (const row of rows) {
      if (!row.sub_recipe_name || !row.ingredient_name) continue;
      const key = row.sub_recipe_name.trim();
      if (!subGroups.has(key)) subGroups.set(key, []);
      subGroups.get(key)!.push(row);
    }

    const results = {
      subs_created: 0,
      subs_updated: 0,
      subs_skipped: 0,
      ingredients_added: 0,
      ingredients_not_found: [] as string[],
      recipes_recosted: 0,
      // Overwrite-mode sub-recipes left completely untouched because one or
      // more of their CSV lines didn't resolve — see the preflight below.
      rejected: [] as { sub_recipe: string; unmatched: string[] }[],
      errors: [] as string[],
    };

    const bulkCreate = db.transaction(() => {
      const touchedSubIds: string[] = [];

      for (const [subName, groupRows] of subGroups) {
        const firstRow = groupRows[0];
        const yieldQty = Number(firstRow.yield_qty) > 0 ? Number(firstRow.yield_qty) : 0;
        const yieldUnit = firstRow.yield_unit?.trim() || '';

        // Check if sub-recipe already exists (case-insensitive)
        const existing = db.prepare('SELECT id FROM sub_recipes WHERE lower(name) = lower(?) AND is_active = 1').get(subName) as any;

        let subRecipeId: string;

        if (existing) {
          if (!overwrite_existing) {
            results.subs_skipped++;
            continue;
          }
          // PREFLIGHT before any destructive write: resolve EVERY line of this
          // sub-recipe's group first. The old delete-then-match flow permanently
          // dropped any line whose material name had drifted (the June "thinned
          // recipe" incident class). If anything is unmatched, leave the
          // sub-recipe completely untouched and report it in `rejected`.
          const unmatched: string[] = [];
          for (const row of groupRows) {
            const ingName = String(row.ingredient_name).trim();
            if (!materialByName.get(ingName.toLowerCase())) {
              unmatched.push(ingName);
              results.ingredients_not_found.push(`"${ingName}" (sub-recipe: ${subName})`);
            }
          }
          if (unmatched.length > 0) {
            results.rejected.push({ sub_recipe: subName, unmatched: [...new Set(unmatched)] });
            results.errors.push(`Rejected "${subName}" — ${unmatched.length} unmatched line(s); existing sub-recipe left untouched. Fix the names and re-upload.`);
            continue;
          }
          subRecipeId = existing.id;
          // Clear existing ingredients and update yield fields when provided
          db.prepare('DELETE FROM sub_recipe_ingredients WHERE sub_recipe_id = ?').run(subRecipeId);
          if (yieldQty > 0) {
            db.prepare('UPDATE sub_recipes SET yield_quantity = ? WHERE id = ?').run(yieldQty, subRecipeId);
          }
          if (yieldUnit) {
            db.prepare('UPDATE sub_recipes SET yield_unit = ? WHERE id = ?').run(yieldUnit, subRecipeId);
          }
          db.prepare(`
            UPDATE sub_recipes SET version = version + 1, updated_at = datetime('now') WHERE id = ?
          `).run(subRecipeId);
          results.subs_updated++;
        } else {
          subRecipeId = generateId();
          db.prepare(`
            INSERT INTO sub_recipes (id, name, category, yield_quantity, yield_unit, version, is_active, created_at, updated_at)
            VALUES (?, ?, '', ?, ?, 1, 1, datetime('now'), datetime('now'))
          `).run(subRecipeId, subName, yieldQty > 0 ? yieldQty : 1, yieldUnit || 'kg');
          results.subs_created++;
        }

        // Add ingredients
        for (const row of groupRows) {
          const ingName = String(row.ingredient_name).trim();
          const material = materialByName.get(ingName.toLowerCase());

          if (!material) {
            results.ingredients_not_found.push(`"${ingName}" (sub-recipe: ${subName})`);
            continue;
          }

          // Quantity 0 is valid (cost-neutral) — mirrors the recipes bulk route;
          // rejecting after the DELETE above would drop the line permanently.
          const quantity = Number(row.quantity);
          if (!Number.isFinite(quantity) || quantity < 0) {
            results.errors.push(`Invalid quantity for "${ingName}" in "${subName}"`);
            continue;
          }

          db.prepare(`
            INSERT INTO sub_recipe_ingredients (id, sub_recipe_id, material_id, quantity, unit, yield_percent, wastage_percent, is_default, brand_preference)
            VALUES (?, ?, ?, ?, ?, 100, 0, 1, '')
          `).run(generateId(), subRecipeId, material.id, quantity, row.unit || material.unit || 'kg');

          results.ingredients_added++;
        }

        // Recalculate sub-recipe cost (also cascades to linked recipes)
        recalculateSubRecipeCost(db, subRecipeId);
        touchedSubIds.push(subRecipeId);
      }

      // Final pass: recost every recipe linked to any touched sub-recipe so
      // recipe totals reflect ALL sub-recipe updates from this import
      if (touchedSubIds.length > 0) {
        const placeholders = touchedSubIds.map(() => '?').join(',');
        const linkedRecipes = db.prepare(`
          SELECT DISTINCT recipe_id FROM recipe_sub_recipes WHERE sub_recipe_id IN (${placeholders})
        `).all(...touchedSubIds) as any[];
        for (const link of linkedRecipes) {
          recalculateRecipeCost(db, link.recipe_id);
        }
        results.recipes_recosted = linkedRecipes.length;
      }
    });

    bulkCreate();

    return Response.json(results);
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
