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
      errors: [] as string[],
    };

    const bulkCreate = db.transaction(() => {
      for (const [recipeName, groupRows] of recipeGroups) {
        const firstRow = groupRows[0];
        const category = firstRow.category?.trim() || 'other';
        const sellingPrice = Number(firstRow.selling_price) || 0;

        // Check if recipe already exists
        const existing = db.prepare('SELECT id FROM recipes WHERE name = ? AND is_active = 1').get(recipeName) as any;

        let recipeId: string;

        if (existing) {
          if (!overwrite_existing) {
            results.recipes_skipped++;
            continue;
          }
          recipeId = existing.id;
          // Clear existing ingredients and update recipe
          db.prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?').run(recipeId);
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
          const material = materialByName.get(ingName.toLowerCase());

          if (!material) {
            results.ingredients_not_found.push(`"${ingName}" (recipe: ${recipeName})`);
            continue;
          }

          const quantity = Number(row.quantity) || 0;
          if (quantity <= 0) {
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
