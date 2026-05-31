import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Duplicate a recipe.
 *
 * The common case this solves: a dual-purpose recipe like "Manchow Soup Veg / Non Veg"
 * was imported as a single row but the kitchen needs to track Veg vs Non Veg as
 * separate recipes (different ingredients, different selling prices, different
 * food cost %, separate sales deduction).
 *
 * Steps performed in one transaction:
 *   1. Insert a new recipe row with the requested name + selling_price + category.
 *   2. Copy every recipe_ingredients row (qty, unit, yield_percent, wastage_percent).
 *   3. Copy every recipe_sub_recipes link.
 *   4. Optionally RENAME the original recipe (so the user can convert
 *      "Manchow Soup Veg / Non Veg" → original becomes "Manchow Soup Veg" and the
 *      new copy is "Manchow Soup Non Veg" in one shot).
 *   5. Audit log both ops.
 *
 * Body:
 *   {
 *     new_name:        string,         // required
 *     selling_price?:  number,         // defaults to source recipe's selling_price
 *     category?:       string,         // defaults to source recipe's category
 *     rename_original?: string,        // optional — also rename the source recipe to this
 *   }
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id } = await params;
    const db = getDb();

    const body = await req.json().catch(() => ({}));
    const newName = String(body?.new_name || '').trim();
    if (!newName) return Response.json({ error: 'new_name is required' }, { status: 400 });
    const renameOriginal = String(body?.rename_original || '').trim() || null;

    const src = db.prepare('SELECT * FROM recipes WHERE id = ?').get(id) as any;
    if (!src) return Response.json({ error: 'Source recipe not found' }, { status: 404 });

    // Name collision check — recipe names are not unique in schema but we treat
    // them as the user-visible key, so flag duplicates upfront.
    const collide = db.prepare('SELECT id FROM recipes WHERE LOWER(name) = LOWER(?) AND id != ?')
      .get(newName, id) as any;
    if (collide) {
      return Response.json({ error: `A recipe named "${newName}" already exists` }, { status: 409 });
    }
    if (renameOriginal) {
      const collide2 = db.prepare('SELECT id FROM recipes WHERE LOWER(name) = LOWER(?) AND id != ?')
        .get(renameOriginal, id) as any;
      if (collide2) {
        return Response.json({ error: `Rename target "${renameOriginal}" already exists` }, { status: 409 });
      }
    }

    const newId = generateId();
    const sellingPrice = body?.selling_price != null ? Number(body.selling_price) : src.selling_price;
    const category     = body?.category != null ? String(body.category) : src.category;

    const txn = db.transaction(() => {
      // 1. Insert the copy with same cost/profit/FC as source — will recompute
      //    automatically the first time the user edits an ingredient.
      db.prepare(`
        INSERT INTO recipes (id, name, category, selling_price, total_cost, profit,
                             food_cost_percent, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
      `).run(newId, newName, category, sellingPrice,
             src.total_cost || 0, src.profit || 0, src.food_cost_percent || 0);

      // 2. Copy ingredients
      const ings = db.prepare('SELECT * FROM recipe_ingredients WHERE recipe_id = ?').all(id) as any[];
      const insIng = db.prepare(`
        INSERT INTO recipe_ingredients (id, recipe_id, material_id, quantity, unit,
                                        yield_percent, wastage_percent, is_default, brand_preference)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const ing of ings) {
        insIng.run(generateId(), newId, ing.material_id, ing.quantity, ing.unit,
                   ing.yield_percent, ing.wastage_percent, ing.is_default, ing.brand_preference || '');
      }

      // 3. Copy sub-recipe links
      const subs = db.prepare('SELECT * FROM recipe_sub_recipes WHERE recipe_id = ?').all(id) as any[];
      const insSub = db.prepare(`
        INSERT INTO recipe_sub_recipes (id, recipe_id, sub_recipe_id, quantity, unit)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const sr of subs) {
        insSub.run(generateId(), newId, sr.sub_recipe_id, sr.quantity, sr.unit);
      }

      // 4. Optional rename of the source recipe
      if (renameOriginal) {
        db.prepare('UPDATE recipes SET name = ?, updated_at = datetime(\'now\') WHERE id = ?')
          .run(renameOriginal, id);
      }

      // 5. Audit
      logAuditEvent(db, {
        event_type: 'recipe.duplicate',
        entity_type: 'recipe',
        entity_id: newId,
        actor_email: me.email,
        before: null,
        after: { name: newName, source_recipe_id: id, source_name: src.name,
                 ingredient_count: ings.length, sub_recipe_count: subs.length },
        note: renameOriginal ? `Source renamed to "${renameOriginal}"` : '',
      });
      if (renameOriginal) {
        logAuditEvent(db, {
          event_type: 'recipe.rename',
          entity_type: 'recipe',
          entity_id: id,
          actor_email: me.email,
          before: { name: src.name },
          after:  { name: renameOriginal },
          note: `Triggered by duplicate-to "${newName}"`,
        });
      }
    });
    txn();

    return Response.json({
      success: true,
      new_recipe_id: newId,
      new_name: newName,
      ingredient_count: db.prepare('SELECT COUNT(*) AS n FROM recipe_ingredients WHERE recipe_id = ?').get(newId),
      original_renamed_to: renameOriginal,
    });
  } catch (e: any) {
    console.error('[recipes.duplicate]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
