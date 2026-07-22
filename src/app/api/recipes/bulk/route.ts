import { getDb, generateId, recalculateRecipeCost } from '@/lib/db';

interface BulkRow {
  recipe_name: string;
  category?: string;
  selling_price?: number;
  ingredient_name: string;
  quantity: number;
  unit?: string;
  yield_percent?: number;
  wastage_percent?: number;
  notes?: string;
}

export async function POST(request: Request) {
  try {
    const db = getDb();
    const body = await request.json();
    const { rows, overwrite_existing } = body as { rows: BulkRow[]; overwrite_existing?: boolean };

    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return Response.json({ error: 'rows array is required' }, { status: 400 });
    }

    // Load all materials for name matching
    const allMaterials = db.prepare('SELECT id, name, unit FROM raw_materials').all() as any[];
    const materialByName = new Map<string, any>();
    for (const m of allMaterials) {
      materialByName.set(m.name.toLowerCase().trim(), m);
    }

    // Load all sub-recipes for [SUB] name matching
    const allSubRecipes = db.prepare('SELECT id, name, yield_unit FROM sub_recipes WHERE is_active = 1').all() as any[];
    const subRecipeByName = new Map<string, any>();
    for (const s of allSubRecipes) {
      subRecipeByName.set(s.name.toLowerCase().trim(), s);
    }

    // Group rows by recipe name
    const recipeGroups = new Map<string, BulkRow[]>();
    for (const row of rows) {
      if (!row.recipe_name || !row.ingredient_name) continue;
      const key = row.recipe_name.trim();
      if (!recipeGroups.has(key)) recipeGroups.set(key, []);
      recipeGroups.get(key)!.push(row);
    }

    const results = {
      recipes_created: 0,
      recipes_updated: 0,
      recipes_skipped: 0,
      ingredients_added: 0,
      ingredients_not_found: [] as string[],
      subs_linked: 0,
      subs_not_found: [] as string[],
      errors: [] as string[],
    };

    const bulkCreate = db.transaction(() => {
      for (const [recipeName, groupRows] of recipeGroups) {
        const firstRow = groupRows[0];
        const category = firstRow.category?.trim() || 'other';
        const sellingPrice = Number(firstRow.selling_price) || 0;

        // Check if recipe already exists — case/whitespace-insensitive, like the
        // sub/material matching: a byte-exact check would create a DUPLICATE
        // recipe on any name-case drift and leave the damaged one stale.
        const existing = db.prepare('SELECT id FROM recipes WHERE lower(trim(name)) = lower(?) AND is_active = 1').get(recipeName) as any;

        let recipeId: string;

        if (existing) {
          if (!overwrite_existing) {
            results.recipes_skipped++;
            continue;
          }
          recipeId = existing.id;
          // Clear existing ingredients and update recipe. Sub-recipe links are
          // only cleared when this CSV actually carries [SUB] rows for the
          // recipe — a plain ingredient/price upload (template or legacy export
          // has no [SUB] rows) must not silently strip existing links.
          db.prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?').run(recipeId);
          const hasSubRows = groupRows.some(r => /^\[sub\]/i.test(String(r.ingredient_name).trim()));
          if (hasSubRows) {
            db.prepare('DELETE FROM recipe_sub_recipes WHERE recipe_id = ?').run(recipeId);
          }
          db.prepare(`
            UPDATE recipes SET category = ?, selling_price = ?, version = version + 1, updated_at = datetime('now')
            WHERE id = ?
          `).run(category, sellingPrice, recipeId);
          results.recipes_updated++;
        } else {
          recipeId = generateId();
          db.prepare(`
            INSERT INTO recipes (id, name, category, selling_price, version, is_active, created_at, updated_at)
            VALUES (?, ?, ?, ?, 1, 1, datetime('now'), datetime('now'))
          `).run(recipeId, recipeName, category, sellingPrice);
          results.recipes_created++;
        }

        // Add ingredients
        for (const row of groupRows) {
          const ingName = String(row.ingredient_name).trim();

          // "[SUB] <name>" rows link a sub-recipe instead of a raw material
          const subMatch = ingName.match(/^\[sub\]\s*(.+)$/i);
          if (subMatch) {
            const subName = subMatch[1].trim();
            const subRecipe = subRecipeByName.get(subName.toLowerCase());

            if (!subRecipe) {
              results.subs_not_found.push(`"${subName}" (recipe: ${recipeName})`);
              continue;
            }

            // Quantity 0 is valid (cost-neutral) — real recipe cards carry
            // zero-qty lines, and rejecting them after the DELETE above would
            // permanently drop the link. Only NaN/negative values are errors.
            const subQty = Number(row.quantity);
            if (!Number.isFinite(subQty) || subQty < 0) {
              results.errors.push(`Invalid quantity for "[SUB] ${subName}" in "${recipeName}"`);
              continue;
            }

            // Cost math reads quantity in the sub's yield_unit (recalculateRecipeCost
            // multiplies by cost_per_unit and IGNORES this unit column) — a CSV row
            // in a different unit would silently mis-cost, so warn loudly.
            const subUnit = String(row.unit || subRecipe.yield_unit || 'kg').trim();
            if (subRecipe.yield_unit && subUnit.toLowerCase() !== String(subRecipe.yield_unit).trim().toLowerCase()) {
              results.errors.push(`Unit warning: "[SUB] ${subName}" in "${recipeName}" is "${subUnit}" but the sub-recipe yields "${subRecipe.yield_unit}" — quantity is costed in ${subRecipe.yield_unit}`);
            }
            db.prepare(`
              INSERT INTO recipe_sub_recipes (id, recipe_id, sub_recipe_id, quantity, unit)
              VALUES (?, ?, ?, ?, ?)
            `).run(generateId(), recipeId, subRecipe.id, subQty, subUnit);

            results.subs_linked++;
            continue;
          }

          const material = materialByName.get(ingName.toLowerCase());

          if (!material) {
            results.ingredients_not_found.push(`"${ingName}" (recipe: ${recipeName})`);
            continue;
          }

          // Quantity 0 is valid (cost-neutral) — see [SUB] note above.
          const quantity = Number(row.quantity);
          if (!Number.isFinite(quantity) || quantity < 0) {
            results.errors.push(`Invalid quantity for "${ingName}" in "${recipeName}"`);
            continue;
          }

          db.prepare(`
            INSERT INTO recipe_ingredients (id, recipe_id, material_id, quantity, unit, yield_percent, wastage_percent, is_default, brand_preference)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, '')
          `).run(
            generateId(), recipeId, material.id, quantity,
            row.unit || material.unit || 'kg',
            row.yield_percent ?? 100,
            row.wastage_percent ?? 0
          );

          results.ingredients_added++;
        }

        // Recalculate recipe cost
        recalculateRecipeCost(db, recipeId);
      }
    });

    bulkCreate();

    return Response.json(results);
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
