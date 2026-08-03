import { getDb, generateId, recalculateSubRecipeCost } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { materialRate, rateMap } from '@/lib/closing-valuation';

/**
 * Attach the ₹-per-PURCHASE-unit rate to each ingredient row.
 *
 * The obvious `average_price × packFactor` is WRONG on this database often
 * enough to matter: of the 281 packed materials that carry a rate, 50 hold the
 * PURCHASE-unit price in the ₹/recipe-unit column, so multiplying by the pack
 * inflates them by pack_size — COCO POWDER comes out at ₹846,570/kg. Every one
 * of those 50 has zero purchase history, which is exactly why nothing ever
 * corrected them.
 *
 * So the rate is derived by the SAME ladder the closing sheet uses
 * (src/lib/closing-valuation.ts): the most recent purchases.unit_price first
 * (authoritative — ₹ per purchase unit by canon, and what we actually paid),
 * then average_price × packFactor, then nothing. `rate_source` travels with the
 * number so the screen can show where it came from and flag an unverified one:
 * a rate nobody can trace is a rate nobody should cost a recipe with.
 *
 * rateMap() is loaded ONCE per request and passed in, so a sub-recipe with 20
 * ingredients does one query, not 20.
 */
function withRates(db: any, ingredients: any[], preloaded: Map<string, { unit_price: number; date: string }>) {
  return ingredients.map((ing: any) => {
    const r = materialRate(db, {
      id: ing.material_id,
      unit: ing.material_unit,
      purchase_unit: ing.purchase_unit,
      pack_size: ing.pack_size,
      average_price: ing.average_price,
    }, preloaded.get(ing.material_id) ?? null);
    return { ...ing, rate_per_purchase_unit: r.ratePerPurchaseUnit, rate_source: r.source, rate_as_of: r.asOf };
  });
}

export async function GET(request: Request) {
  try {
    // SECURITY: the proxy only checks that a session cookie is PRESENT for GETs —
    // real validation is delegated here. Without this, a forged/expired cookie
    // could read every costed sub-recipe.
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const subRecipes = db.prepare(`
      SELECT * FROM sub_recipes WHERE is_active = 1 ORDER BY name ASC
    `).all() as any[];

    // ONE query for every material's latest purchase rate, before the loop —
    // otherwise 68 sub-recipes x N ingredients each run their own lookup.
    const rates = rateMap(db);

    const result = subRecipes.map((sr) => {
      const ingredients = db.prepare(`
        SELECT sri.*, rm.name as material_name,
               -- Pack meta so every sub-recipe surface can LEAD with the purchase
               -- unit (kg / L / BTL) instead of the recipe unit. Sub-recipes are
               -- batch-produced in bulk, so the chef reasons in kg, not grams.
               -- average_price is RUPEES PER RECIPE UNIT — the client multiplies by
               -- packFactor() to show the rate per purchase unit; it is sent raw so
               -- the both-halves guard is applied in exactly one place.
               rm.unit AS material_unit,
               COALESCE(NULLIF(TRIM(rm.purchase_unit), ''), rm.unit) AS purchase_unit,
               COALESCE(rm.pack_size, 1) AS pack_size,
               COALESCE(rm.case_size, 0) AS case_size,
               rm.average_price, rm.sku
        FROM sub_recipe_ingredients sri
        JOIN raw_materials rm ON sri.material_id = rm.id
        WHERE sri.sub_recipe_id = ?
      `).all(sr.id);
      return { ...sr, ingredients: withRates(db, ingredients as any[], rates) };
    });

    return Response.json({ sub_recipes: result });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const db = getDb();
    const body = await request.json();
    const { name, category, yield_quantity, yield_unit, ingredients } = body;

    if (!name || !ingredients || !ingredients.length) {
      return Response.json({ error: 'name and ingredients are required' }, { status: 400 });
    }

    // Guard: a zero/negative/NaN yield collapses cost_per_unit to 0 and cascades
    // into every dependent recipe's total_cost. Reject before writing.
    if (yield_quantity != null && (!Number.isFinite(Number(yield_quantity)) || Number(yield_quantity) <= 0)) {
      return Response.json({ error: 'yield_quantity must be > 0' }, { status: 400 });
    }

    const id = generateId();

    const create = db.transaction(() => {
      db.prepare(`
        INSERT INTO sub_recipes (id, name, category, yield_quantity, yield_unit, version, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, 1, datetime('now'), datetime('now'))
      `).run(id, name, category || '', yield_quantity || 1, yield_unit || 'kg');

      for (const ing of ingredients) {
        db.prepare(`
          INSERT INTO sub_recipe_ingredients (id, sub_recipe_id, material_id, quantity, unit, yield_percent, wastage_percent, is_default, brand_preference)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          generateId(), id, ing.material_id, ing.quantity,
          ing.unit || 'kg', ing.yield_percent ?? 100, ing.wastage_percent ?? 0,
          ing.is_default ?? 1, ing.brand_preference || ''
        );
      }

      recalculateSubRecipeCost(db, id);
    });

    create();

    const subRecipe = db.prepare('SELECT * FROM sub_recipes WHERE id = ?').get(id);
    const subIngredients = db.prepare(`
      SELECT sri.*, rm.name as material_name,
               -- Pack meta so every sub-recipe surface can LEAD with the purchase
               -- unit (kg / L / BTL) instead of the recipe unit. Sub-recipes are
               -- batch-produced in bulk, so the chef reasons in kg, not grams.
               -- average_price is RUPEES PER RECIPE UNIT — the client multiplies by
               -- packFactor() to show the rate per purchase unit; it is sent raw so
               -- the both-halves guard is applied in exactly one place.
               rm.unit AS material_unit,
               COALESCE(NULLIF(TRIM(rm.purchase_unit), ''), rm.unit) AS purchase_unit,
               COALESCE(rm.pack_size, 1) AS pack_size,
               COALESCE(rm.case_size, 0) AS case_size,
               rm.average_price, rm.sku
      FROM sub_recipe_ingredients sri
      JOIN raw_materials rm ON sri.material_id = rm.id
      WHERE sri.sub_recipe_id = ?
    `).all(id);

    return Response.json({ sub_recipe: { ...(subRecipe as any), ingredients: withRates(db, subIngredients as any[], rateMap(db)) } }, { status: 201 });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const db = getDb();
    const body = await request.json();
    const { id, name, category, yield_quantity, yield_unit, ingredients } = body;

    if (!id) {
      return Response.json({ error: 'id is required' }, { status: 400 });
    }

    const existing = db.prepare('SELECT * FROM sub_recipes WHERE id = ?').get(id) as any;
    if (!existing) {
      return Response.json({ error: 'Sub-recipe not found' }, { status: 404 });
    }

    // Guard: PUT used `yield_quantity ?? existing` so an explicit 0 was written,
    // zeroing cost_per_unit and every dependent recipe's cost. Reject before writing.
    if (yield_quantity != null && (!Number.isFinite(Number(yield_quantity)) || Number(yield_quantity) <= 0)) {
      return Response.json({ error: 'yield_quantity must be > 0' }, { status: 400 });
    }

    const update = db.transaction(() => {
      // Increment version
      db.prepare(`
        UPDATE sub_recipes
        SET name = ?, category = ?, yield_quantity = ?, yield_unit = ?,
            version = version + 1, updated_at = datetime('now')
        WHERE id = ?
      `).run(
        name || existing.name,
        category ?? existing.category,
        yield_quantity ?? existing.yield_quantity,
        yield_unit || existing.yield_unit,
        id
      );

      // Replace ingredients if provided. An explicit EMPTY array is a valid
      // "clear all rows" request (the edit modal sends [] when every row is
      // removed); only skip when the field is absent entirely.
      if (Array.isArray(ingredients)) {
        db.prepare('DELETE FROM sub_recipe_ingredients WHERE sub_recipe_id = ?').run(id);
        for (const ing of ingredients) {
          db.prepare(`
            INSERT INTO sub_recipe_ingredients (id, sub_recipe_id, material_id, quantity, unit, yield_percent, wastage_percent, is_default, brand_preference)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            generateId(), id, ing.material_id, ing.quantity,
            ing.unit || 'kg', ing.yield_percent ?? 100, ing.wastage_percent ?? 0,
            ing.is_default ?? 1, ing.brand_preference || ''
          );
        }
      }

      recalculateSubRecipeCost(db, id);
    });

    update();

    const subRecipe = db.prepare('SELECT * FROM sub_recipes WHERE id = ?').get(id);
    const subIngredients = db.prepare(`
      SELECT sri.*, rm.name as material_name,
               -- Pack meta so every sub-recipe surface can LEAD with the purchase
               -- unit (kg / L / BTL) instead of the recipe unit. Sub-recipes are
               -- batch-produced in bulk, so the chef reasons in kg, not grams.
               -- average_price is RUPEES PER RECIPE UNIT — the client multiplies by
               -- packFactor() to show the rate per purchase unit; it is sent raw so
               -- the both-halves guard is applied in exactly one place.
               rm.unit AS material_unit,
               COALESCE(NULLIF(TRIM(rm.purchase_unit), ''), rm.unit) AS purchase_unit,
               COALESCE(rm.pack_size, 1) AS pack_size,
               COALESCE(rm.case_size, 0) AS case_size,
               rm.average_price, rm.sku
      FROM sub_recipe_ingredients sri
      JOIN raw_materials rm ON sri.material_id = rm.id
      WHERE sri.sub_recipe_id = ?
    `).all(id);

    return Response.json({ sub_recipe: { ...(subRecipe as any), ingredients: withRates(db, subIngredients as any[], rateMap(db)) } });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const id = url.searchParams.get('id');

    if (!id) {
      return Response.json({ error: 'id is required' }, { status: 400 });
    }

    const existing = db.prepare('SELECT * FROM sub_recipes WHERE id = ?').get(id);
    if (!existing) {
      return Response.json({ error: 'Sub-recipe not found' }, { status: 404 });
    }

    db.prepare('UPDATE sub_recipes SET is_active = 0, updated_at = datetime(\'now\') WHERE id = ?').run(id);
    return Response.json({ success: true, message: 'Sub-recipe deactivated' });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
