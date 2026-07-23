import { getDb, generateId, recalculateSubRecipeCost } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

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

    const result = subRecipes.map((sr) => {
      const ingredients = db.prepare(`
        SELECT sri.*, rm.name as material_name
        FROM sub_recipe_ingredients sri
        JOIN raw_materials rm ON sri.material_id = rm.id
        WHERE sri.sub_recipe_id = ?
      `).all(sr.id);
      return { ...sr, ingredients };
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
      SELECT sri.*, rm.name as material_name
      FROM sub_recipe_ingredients sri
      JOIN raw_materials rm ON sri.material_id = rm.id
      WHERE sri.sub_recipe_id = ?
    `).all(id);

    return Response.json({ sub_recipe: { ...(subRecipe as any), ingredients: subIngredients } }, { status: 201 });
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
      SELECT sri.*, rm.name as material_name
      FROM sub_recipe_ingredients sri
      JOIN raw_materials rm ON sri.material_id = rm.id
      WHERE sri.sub_recipe_id = ?
    `).all(id);

    return Response.json({ sub_recipe: { ...(subRecipe as any), ingredients: subIngredients } });
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
