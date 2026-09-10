import { getDb, generateId, recalculateRecipeCost } from '@/lib/db';
import { rollUpAllergens } from '@/lib/allergens';
import { getCurrentUser, type SessionUser } from '@/lib/auth';
import { resolveRecipePricesBulk, priceSourceLabel, costedFigures, figuresAreStale } from '@/lib/recipe-price';

/**
 * WRITE GATE — creating or editing a recipe.
 *
 * These handlers had NO gate: any signed-in session holding the CSRF cookie
 * every logged-in browser already carries could rewrite any dish's selling
 * price, and (since the menu link is now both the costing denominator AND the
 * key that deducts inventory on sale) could detach a live menu item from its
 * recipe so it silently stopped deducting stock.
 *
 * Same tier and same resolution as the menu writer gate
 * (src/app/api/menu-items/route.ts:15) — an assigned role's base_role wins, so
 * the "Head Chef" role (base_role manager) passes. GET stays open to every
 * signed-in user: the costed recipe book is read by /menu-items, the cookbook,
 * party menus and the sales screens.
 */
function requireRecipeWriter(me: SessionUser | null): Response | null {
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (me.role !== 'admin' && me.role !== 'manager') {
    return Response.json({ error: 'Manager or admin only' }, { status: 403 });
  }
  return null;
}

export async function GET(request: Request) {
  try {
    // SECURITY: the proxy only checks that a session cookie is PRESENT for GETs —
    // real validation is delegated here. Without this, a forged/expired cookie
    // could read the full costed recipe book.
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
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

    // WHICH price each FC% is computed against. Resolved once for the whole
    // list (two queries, not one per row) and shipped with every recipe so no
    // surface has to guess — the ambiguity that let one screen show FC 30.4%
    // beside the ₹279 the guest actually pays. See src/lib/recipe-price.ts.
    const priceMap = resolveRecipePricesBulk(db, recipes.map(r => ({ id: r.id, selling_price: r.selling_price })));

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
      `).all(recipe.id) as any[];

      // Cookbook: roll up allergens from every ingredient name — direct
      // ingredients AND the ingredients of any linked sub-recipe.
      const names: string[] = (ingredients as any[]).map((i) => i.material_name).filter(Boolean);
      for (const sr of sub_recipes) {
        const subMats = db.prepare(`
          SELECT rm.name as material_name
          FROM sub_recipe_ingredients sri
          JOIN raw_materials rm ON sri.material_id = rm.id
          WHERE sri.sub_recipe_id = ?
        `).all(sr.sub_recipe_id) as any[];
        for (const m of subMats) if (m.material_name) names.push(m.material_name);
      }
      const allergens = rollUpAllergens(names);

      const priced = priceMap.get(recipe.id)!;
      // DERIVED, NOT STORED. recipes.food_cost_percent / profit are a cache
      // written the last time this recipe was re-costed. A recipe nobody has
      // touched since the costing rule changed still holds the figure computed
      // against its own stale price, so serving that column printed FC 19.47%
      // beside the ₹499 the guest pays. Compute both from the effective price
      // this same payload is shipping — the two can then never disagree.
      // See src/lib/recipe-price.ts. The cache is left alone; realigning it is
      // the admin's explicit reconcile, never a silent bulk write.
      const derived = costedFigures(recipe.total_cost, priced.price);
      return {
        ...recipe,
        food_cost_percent: derived.food_cost_percent,
        profit: derived.profit,
        /** What the row still holds on disk, and whether it disagrees. */
        stored_food_cost_percent: Number(recipe.food_cost_percent) || 0,
        stored_profit: Number(recipe.profit) || 0,
        figures_stale: figuresAreStale(recipe, derived),
        ingredients,
        sub_recipes,
        allergens,
        // The denominator behind total_cost / food_cost_percent / profit.
        effective_selling_price: priced.price,
        price_source: priced.source,               // 'menu_item' | 'recipe'
        price_source_label: priceSourceLabel(priced),
        linked_menu_item_id: priced.menu_item_id,
        linked_menu_item_name: priced.menu_item_name,
        linked_menu_item_category: priced.menu_item_category,
        linked_menu_price: priced.menu_price,
        linked_menu_count: priced.linked_count,
        price_drifted: priced.drifted,             // stored recipe price ≠ menu price
      };
    });

    return Response.json({ recipes: result });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const denied = requireRecipeWriter(await getCurrentUser());
    if (denied) return denied;
    const db = getDb();
    const body = await request.json();
    const { name, category, selling_price, ingredients, sub_recipes, menu_item_id, instructions, image_url } = body;

    if (!name) {
      return Response.json({ error: 'name is required' }, { status: 400 });
    }

    const id = generateId();

    // A menu item can belong to exactly one recipe. Claiming one that already
    // belongs to ANOTHER recipe leaves that recipe costed against a menu price
    // it no longer owns, so remember whose it was and re-cost that recipe below.
    const stolenFrom = menu_item_id
      ? ((db.prepare('SELECT recipe_id FROM menu_items WHERE id = ?').get(menu_item_id) as { recipe_id?: string | null } | undefined)?.recipe_id ?? null)
      : null;

    const create = db.transaction(() => {
      db.prepare(`
        INSERT INTO recipes (id, name, category, selling_price, instructions, image_url, version, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, 1, datetime('now'), datetime('now'))
      `).run(id, name, category || '', selling_price || 0, (instructions || '').toString(), (image_url || '').toString());

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

      // The recipe that just lost this listing falls back to its own price —
      // re-cost it, or it keeps a food cost measured against a menu price that
      // is now somebody else's.
      if (stolenFrom && stolenFrom !== id) {
        const exists = db.prepare('SELECT 1 FROM recipes WHERE id = ?').get(stolenFrom);
        if (exists) recalculateRecipeCost(db, stolenFrom);
      }
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
    const denied = requireRecipeWriter(await getCurrentUser());
    if (denied) return denied;
    const db = getDb();
    const body = await request.json();
    const { id, name, category, selling_price, ingredients, sub_recipes, menu_item_id, instructions, image_url } = body;

    if (!id) {
      return Response.json({ error: 'id is required' }, { status: 400 });
    }

    const existing = db.prepare('SELECT * FROM recipes WHERE id = ?').get(id) as any;
    if (!existing) {
      return Response.json({ error: 'Recipe not found' }, { status: 404 });
    }

    // Whose costing this save disturbs, besides this recipe's own.
    //
    // A menu item belongs to exactly one recipe. Picking one that already
    // belongs to ANOTHER recipe silently moves it, and the recipe that lost it
    // must fall back to its own price — it was left costed against a menu price
    // it no longer owns, with price_drifted false, so no screen revealed it and
    // the reconcile tool (which only looks at LINKED recipes) could not see it.
    // Read before the write; afterwards the old owner is unfindable from here.
    const alsoRecost = new Set<string>();
    if (menu_item_id !== undefined) {
      if (menu_item_id) {
        const prevOwner = (db.prepare('SELECT recipe_id FROM menu_items WHERE id = ?').get(menu_item_id) as
          { recipe_id?: string | null } | undefined)?.recipe_id;
        if (prevOwner && prevOwner !== id) alsoRecost.add(prevOwner);
      }
      // This recipe's OTHER listings are about to be cleared too (the handler
      // relinks only the one sent), which can hand their price back to nobody.
      // Those rows belong to THIS recipe, so recalculateRecipeCost(id) below
      // covers them; nothing extra to collect here.
    }

    const update = db.transaction(() => {
      db.prepare(`
        UPDATE recipes
        SET name = ?, category = ?, selling_price = ?, instructions = ?, image_url = ?,
            version = version + 1, updated_at = datetime('now')
        WHERE id = ?
      `).run(
        name || existing.name,
        category ?? existing.category,
        selling_price ?? existing.selling_price,
        instructions !== undefined ? (instructions || '').toString() : (existing.instructions ?? ''),
        image_url !== undefined ? (image_url || '').toString() : (existing.image_url ?? ''),
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

      for (const rid of alsoRecost) {
        const exists = db.prepare('SELECT 1 FROM recipes WHERE id = ?').get(rid);
        if (exists) recalculateRecipeCost(db, rid);
      }
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
