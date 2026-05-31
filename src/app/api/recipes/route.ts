import { getDb, generateId, recalculateRecipeCost } from '@/lib/db';

export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const category = url.searchParams.get('category');
    const search = url.searchParams.get('search');

    let query = 'SELECT * FROM recipes WHERE is_active = 1';
    const params: any[] = [];

    if (category) {
      query += ' AND category = ?';
      params.push(category);
    }
    if (search) {
      query += ' AND name LIKE ?';
      params.push(`%${search}%`);
    }

    query += ' ORDER BY name ASC';

    const recipes = db.prepare(query).all(...params) as any[];

    const result = recipes.map((recipe) => {
      const ingredients = db.prepare(`
        SELECT ri.*, rm.name as material_name, rm.average_price, rm.unit as material_unit, rm.average_price, rm.unit as material_unit
        FROM recipe_ingredients ri
        JOIN raw_materials rm ON ri.material_id = rm.id
        WHERE ri.recipe_id = ?
      `).all(recipe.id);

      const sub_recipes = db.prepare(`
        SELECT rs.*, sr.name as sub_recipe_name, sr.cost_per_unit
        FROM recipe_sub_recipes rs
        JOIN sub_recipes sr ON rs.sub_recipe_id = sr.id
        WHERE rs.recipe_id = ?
      `).all(recipe.id);

      return { ...recipe, ingredients, sub_recipes };
    });

    return Response.json({ recipes: result });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const db = getDb();
    const body = await request.json();
    const { name, category, selling_price, ingredients, sub_recipes, menu_item_id } = body;

    if (!name) {
      return Response.json({ error: 'name is required' }, { status: 400 });
    }

    const id = generateId();

    const create = db.transaction(() => {
      db.prepare(`
        INSERT INTO recipes (id, name, category, selling_price, version, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, 1, datetime('now'), datetime('now'))
      `).run(id, name, category || '', selling_price || 0);

      // Link menu item → this recipe (and clear any previous recipe link from that menu item)
      if (menu_item_id) {
        db.prepare(`UPDATE menu_items SET recipe_id = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(id, menu_item_id);
      }

      if (ingredients && ingredients.length) {
        for (const ing of ingredients) {
          db.prepare(`
            INSERT INTO recipe_ingredients (id, recipe_id, material_id, quantity, unit, yield_percent, wastage_percent, is_default, brand_preference)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            generateId(), id, ing.material_id, ing.quantity,
            ing.unit || 'kg', ing.yield_percent ?? 100, ing.wastage_percent ?? 0,
            ing.is_default ?? 1, ing.brand_preference || ''
          );
        }
      }

      if (sub_recipes && sub_recipes.length) {
        for (const sr of sub_recipes) {
          db.prepare(`
            INSERT INTO recipe_sub_recipes (id, recipe_id, sub_recipe_id, quantity, unit)
            VALUES (?, ?, ?, ?, ?)
          `).run(generateId(), id, sr.sub_recipe_id, sr.quantity, sr.unit || 'kg');
        }
      }

      recalculateRecipeCost(db, id);
    });

    create();

    const recipe = db.prepare('SELECT * FROM recipes WHERE id = ?').get(id) as any;
    const recipeIngredients = db.prepare(`
      SELECT ri.*, rm.name as material_name, rm.average_price, rm.unit as material_unit
      FROM recipe_ingredients ri
      JOIN raw_materials rm ON ri.material_id = rm.id
      WHERE ri.recipe_id = ?
    `).all(id);
    const recipeSubRecipes = db.prepare(`
      SELECT rs.*, sr.name as sub_recipe_name
      FROM recipe_sub_recipes rs
      JOIN sub_recipes sr ON rs.sub_recipe_id = sr.id
      WHERE rs.recipe_id = ?
    `).all(id);

    return Response.json({
      recipe: { ...recipe, ingredients: recipeIngredients, sub_recipes: recipeSubRecipes }
    }, { status: 201 });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const db = getDb();
    const body = await request.json();
    const { id, name, category, selling_price, ingredients, sub_recipes, menu_item_id } = body;

    if (!id) {
      return Response.json({ error: 'id is required' }, { status: 400 });
    }

    const existing = db.prepare('SELECT * FROM recipes WHERE id = ?').get(id) as any;
    if (!existing) {
      return Response.json({ error: 'Recipe not found' }, { status: 404 });
    }

    const update = db.transaction(() => {
      db.prepare(`
        UPDATE recipes
        SET name = ?, category = ?, selling_price = ?,
            version = version + 1, updated_at = datetime('now')
        WHERE id = ?
      `).run(
        name || existing.name,
        category ?? existing.category,
        selling_price ?? existing.selling_price,
        id
      );

      // Re-link / unlink menu item (only when menu_item_id key was sent)
      if (menu_item_id !== undefined) {
        // Clear any old menu items pointing to this recipe (safe idempotent)
        db.prepare(`UPDATE menu_items SET recipe_id = NULL WHERE recipe_id = ?`).run(id);
        if (menu_item_id) {
          db.prepare(`UPDATE menu_items SET recipe_id = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(id, menu_item_id);
        }
      }

      if (ingredients) {
        db.prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?').run(id);
        for (const ing of ingredients) {
          db.prepare(`
            INSERT INTO recipe_ingredients (id, recipe_id, material_id, quantity, unit, yield_percent, wastage_percent, is_default, brand_preference)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            generateId(), id, ing.material_id, ing.quantity,
            ing.unit || 'kg', ing.yield_percent ?? 100, ing.wastage_percent ?? 0,
            ing.is_default ?? 1, ing.brand_preference || ''
          );
        }
      }

      if (sub_recipes) {
        db.prepare('DELETE FROM recipe_sub_recipes WHERE recipe_id = ?').run(id);
        for (const sr of sub_recipes) {
          db.prepare(`
            INSERT INTO recipe_sub_recipes (id, recipe_id, sub_recipe_id, quantity, unit)
            VALUES (?, ?, ?, ?, ?)
          `).run(generateId(), id, sr.sub_recipe_id, sr.quantity, sr.unit || 'kg');
        }
      }

      recalculateRecipeCost(db, id);
    });

    update();

    const recipe = db.prepare('SELECT * FROM recipes WHERE id = ?').get(id) as any;
    const recipeIngredients = db.prepare(`
      SELECT ri.*, rm.name as material_name, rm.average_price, rm.unit as material_unit
      FROM recipe_ingredients ri
      JOIN raw_materials rm ON ri.material_id = rm.id
      WHERE ri.recipe_id = ?
    `).all(id);
    const recipeSubRecipes = db.prepare(`
      SELECT rs.*, sr.name as sub_recipe_name
      FROM recipe_sub_recipes rs
      JOIN sub_recipes sr ON rs.sub_recipe_id = sr.id
      WHERE rs.recipe_id = ?
    `).all(id);

    return Response.json({
      recipe: { ...recipe, ingredients: recipeIngredients, sub_recipes: recipeSubRecipes }
    });
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

    const existing = db.prepare('SELECT * FROM recipes WHERE id = ?').get(id);
    if (!existing) {
      return Response.json({ error: 'Recipe not found' }, { status: 404 });
    }

    db.prepare('UPDATE recipes SET is_active = 0, updated_at = datetime(\'now\') WHERE id = ?').run(id);
    return Response.json({ success: true, message: 'Recipe deactivated' });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
