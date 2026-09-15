import { getDb, generateId, recalculateRecipeCost } from '@/lib/db';
import { rollUpAllergens } from '@/lib/allergens';
import { getCurrentUser, type SessionUser } from '@/lib/auth';
import { resolveRecipePricesBulk, resolveRecipePrice, priceSourceLabel, costedFigures, figuresAreStale } from '@/lib/recipe-price';
import { checkRecipeSanity, type SanityInput } from '@/lib/recipe-sanity';

/**
 * Re-read the saved ingredient lines with their material rates and judge them
 * against the price the recipe is actually costed against, so the sanity report
 * the caller gets back is computed from what is ON DISK, not from what the client
 * claimed. Same function the entry screen runs live in the browser.
 */
function sanityFor(db: ReturnType<typeof getDb>, recipeId: string, recipePrice: number) {
  const rows = db.prepare(`
    SELECT ri.quantity, ri.unit, ri.yield_percent, ri.wastage_percent,
           rm.name AS material_name, rm.average_price, rm.unit AS material_unit,
           rm.pack_size AS material_pack_size
    FROM recipe_ingredients ri
    JOIN raw_materials rm ON ri.material_id = rm.id
    WHERE ri.recipe_id = ? AND ri.is_default = 1
  `).all(recipeId) as SanityInput[];
  return checkRecipeSanity(rows, resolveRecipePrice(db, recipeId, recipePrice).price);
}

/**
 * 0/1 from anything a JSON body might carry, `undefined` when the key is absent,
 * and 'invalid' when the key is present but is not a boolean this can read.
 *
 * WHY THE THIRD ANSWER EXISTS. This used to be `v === true || v === 1 || v ===
 * '1' || v === 'true' ? 1 : 0`, so ANY other value silently became 0 — NOT
 * approximate. A caller that meant "this recipe is rough" and spelled it `"yes"`
 * (or `2`, or `"TRUE"`) got HTTP 201 and a recipe whose estimated cost reads on
 * every screen as a measured one. That is the precise outcome the 503
 * APPROX_UNSUPPORTED path was built to prevent, arrived at through the front
 * door. An unreadable flag is now refused instead of guessed at.
 *
 * 'true'/'false' are accepted in any case because form encoders and spreadsheets
 * produce both; anything else is a bug in the caller and is told so.
 */
type BoolFlag = 0 | 1 | undefined | 'invalid';
function boolFlag(v: unknown): BoolFlag {
  if (v === undefined || v === null) return undefined;
  if (v === true || v === 1 || v === '1') return 1;
  if (v === false || v === 0 || v === '0') return 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true') return 1;
    if (s === 'false' || s === '') return 0;
  }
  return 'invalid';
}

/** Said identically by both handlers when is_approximate cannot be read. */
function approxFlagRejection(v: unknown): Response {
  return Response.json({
    error: `is_approximate could not be read: ${JSON.stringify(v)} is neither true nor false. `
      + 'Send true or false. The recipe has NOT been saved — guessing this wrong would either '
      + 'mark a full recipe as an estimate, or (worse) show a rough cost as a measured one.',
  }, { status: 400 });
}

/**
 * IS THE `recipes.is_approximate` COLUMN THERE?
 *
 * It is not in the live database today, and the migration that would add it
 * lives in src/lib/db.ts, which this work may not edit. Writing the column
 * unconditionally would therefore make every recipe save — the full editor
 * included — fail with "no such column". So the writes below name the column
 * only when it exists, and a caller that actually needs the mark is told plainly
 * that it cannot be recorded rather than having its recipe saved unmarked.
 *
 * Same lazy check as src/app/api/menu-items/route.ts: a "yes" is cached (the
 * migration runs in getDb(), so it cannot un-happen mid-process), a "no" is
 * re-asked so the first request after the migration ships is already correct.
 */
let approxColumnSeen = false;
function recipesHaveApproximateColumn(db: ReturnType<typeof getDb>): boolean {
  if (approxColumnSeen) return true;
  try {
    const cols = db.prepare('PRAGMA table_info(recipes)').all() as Array<{ name?: string }>;
    approxColumnSeen = cols.some((c) => c.name === 'is_approximate');
  } catch {
    approxColumnSeen = false;
  }
  return approxColumnSeen;
}

/** Said the same way in both handlers, in the owner's words, not the database's. */
const APPROX_UNSUPPORTED =
  'This database cannot record a recipe as approximate, and saving one without that mark would show a rough cost that looks like a measured one. Ask an admin to check the app’s settings table, then try again.';

/**
 * THE APPROXIMATE MARK, WITH NO SCHEMA CHANGE.
 * -------------------------------------------
 * The column is not on the owner's live database and the migration that would add
 * it sits uncommitted in a file this work may not touch. For one release that
 * meant the simple-recipe save returned 503 — the owner's "users should still be
 * able to create a Simple/Basic Recipe" was the one sentence of his spec that did
 * not work at all.
 *
 * It does not need a column. It is one bit per recipe, and `settings`
 * (key TEXT PRIMARY KEY, value TEXT) is already a durable place to put one: a
 * single row, `recipe_approximate_ids_v1`, holding a JSON array of recipe ids.
 *
 * THIS FILE IS THE ONLY WRITER. src/app/api/menu-items/route.ts reads the same
 * row (its APPROX_IDS_KEY) to mark the menu list; nothing else touches it.
 *
 * It is a fallback and it defers: when the column exists it is written and read
 * and the sidecar is not consulted at all, so the day the db.ts hunk lands this
 * becomes dead weight rather than a second source of truth — and a recipe marked
 * through the sidecar beforehand STAYS marked, because the two are OR-ed on read
 * while both exist.
 *
 * Ids are pruned against the recipes table on every write, so deleting a recipe
 * cannot leave the row growing forever.
 */
const APPROX_IDS_KEY = 'recipe_approximate_ids_v1';

function settingsTableExists(db: ReturnType<typeof getDb>): boolean {
  try {
    return !!db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'`).get();
  } catch {
    return false;
  }
}

/** Either rail will do. Same predicate /api/menu-items serves as approximate_supported. */
function canRecordApproximate(db: ReturnType<typeof getDb>): boolean {
  return recipesHaveApproximateColumn(db) || settingsTableExists(db);
}

function approxIdsFallback(db: ReturnType<typeof getDb>): Set<string> {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(APPROX_IDS_KEY) as
      { value?: string } | undefined;
    if (!row?.value) return new Set();
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? new Set(parsed.map(String)) : new Set();
  } catch {
    return new Set();
  }
}

/**
 * Mark or unmark one recipe in the sidecar. Runs INSIDE the caller's transaction,
 * so a recipe row and its mark land together or not at all.
 */
function writeApproxFallback(db: ReturnType<typeof getDb>, recipeId: string, on: boolean): void {
  const ids = approxIdsFallback(db);
  if (on) ids.add(String(recipeId)); else ids.delete(String(recipeId));
  // Prune anything that is no longer a recipe, so this row cannot grow without
  // bound as recipes come and go.
  const live = new Set(
    (db.prepare('SELECT id FROM recipes').all() as Array<{ id: string }>).map((r) => String(r.id)));
  const keep = [...ids].filter((id) => live.has(id));
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(APPROX_IDS_KEY, JSON.stringify(keep));
}

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

    // One read for the whole list, and only while the column is missing.
    const hasApproxCol = recipesHaveApproximateColumn(db);
    const approxIds = hasApproxCol ? null : approxIdsFallback(db);

    const result = recipes.map((recipe) => {
      const ingredients = db.prepare(`
        SELECT ri.*, rm.name as material_name, rm.average_price, rm.unit as material_unit,
               rm.pack_size as material_pack_size
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

      // UNIT SANITY, on every read. A recipe already carrying an unconvertible
      // line was costed wrong long before this feature existed — LOOSE PRAWNS
      // holds ₹63,012 because 100 pcs of prawns is valued as 100 kg — and the
      // only surfaces that showed it showed the number without the reason. The
      // check is cheap (the ingredient rows are already joined above) so the
      // recipe book can mark the row rather than leaving the reader to wonder
      // why a starter costs more than the night's takings.
      // `is_default = 1` only — exactly the rows recalculateRecipeCost costs.
      // Judging rows the engine never prices would invent findings about money
      // that is not in total_cost. `material_pack_size` is selected above for the
      // same reason: it is what bridges count↔weight, and without it a line the
      // engine converts cleanly would be reported here as unconvertible.
      const sanity = checkRecipeSanity(
        (ingredients as Array<SanityInput & { is_default?: number }>)
          .filter((i) => Number(i.is_default) === 1),
        priced.price,
      );

      return {
        ...recipe,
        food_cost_percent: derived.food_cost_percent,
        profit: derived.profit,
        /**
         * APPROXIMATE — a real recipe entered fast from its major cost drivers.
         * Stored on the row (recipes.is_approximate) where that column exists, in
         * the settings sidecar where it does not — see APPROX_IDS_KEY. Set by
         * whoever entered it; every surface printing a cost derived from this
         * recipe must say so.
         */
        is_approximate: !!Number(recipe.is_approximate)
          || (!!approxIds && approxIds.has(String(recipe.id))),
        /** Unit/magnitude problems in this recipe's lines, with their causes. */
        sanity_findings: sanity.findings,
        sanity_has_blocker: sanity.has_blocker,
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

    // Whether an "approximate" mark can be stored at all on this database — by
    // EITHER rail (column, or the settings sidecar). When it cannot, the recipe
    // book must not offer the tick: a recipe saved unmarked would show a rough
    // cost that reads as a measured one.
    return Response.json({ recipes: result, approximate_supported: canRecordApproximate(db) });
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

    // A quick recipe is a REAL recipe row — same table, same columns, same
    // costing — carrying a flag that says its quantities are rough. It is created
    // here, through this handler, precisely so it can later be completed rather
    // than replaced: adding the remaining ingredients and clearing the flag turns
    // the same row, with the same id and the same menu link, into a full recipe.
    // Nothing is thrown away and no second "draft" table exists to reconcile.
    const approxRaw = boolFlag(body.is_approximate);
    if (approxRaw === 'invalid') return approxFlagRejection(body.is_approximate);
    const isApprox = approxRaw ?? 0;

    // The mark is the whole point of a simple recipe, so a request for one that
    // cannot be marked is refused — never quietly downgraded to an unmarked
    // recipe whose estimate would then read as a costed figure. A FULL recipe
    // (is_approximate absent or 0) is unaffected and saves as it always has.
    //
    // "Cannot be marked" now means BOTH rails are gone: no column AND no settings
    // table. On the owner's database the column is absent and the sidecar carries
    // it, so the simple recipe saves — which is the point.
    const hasApproxColumn = recipesHaveApproximateColumn(db);
    if (isApprox === 1 && !canRecordApproximate(db)) {
      return Response.json({ error: APPROX_UNSUPPORTED }, { status: 503 });
    }

    const id = generateId();

    // A menu item can belong to exactly one recipe. Claiming one that already
    // belongs to ANOTHER recipe leaves that recipe costed against a menu price
    // it no longer owns, so remember whose it was and re-cost that recipe below.
    const stolenFrom = menu_item_id
      ? ((db.prepare('SELECT recipe_id FROM menu_items WHERE id = ?').get(menu_item_id) as { recipe_id?: string | null } | undefined)?.recipe_id ?? null)
      : null;

    const create = db.transaction(() => {
      // The column is NAMED only when it exists — see recipesHaveApproximateColumn.
      // Everything else about this INSERT is identical either way.
      if (hasApproxColumn) {
        db.prepare(`
          INSERT INTO recipes (id, name, category, selling_price, instructions, image_url, is_approximate, version, is_active, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, datetime('now'), datetime('now'))
        `).run(id, name, category || '', selling_price || 0, (instructions || '').toString(), (image_url || '').toString(), isApprox);
      } else {
        db.prepare(`
          INSERT INTO recipes (id, name, category, selling_price, instructions, image_url, version, is_active, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 1, 1, datetime('now'), datetime('now'))
        `).run(id, name, category || '', selling_price || 0, (instructions || '').toString(), (image_url || '').toString());
      }

      // No column to hold the mark → the sidecar holds it, inside this same
      // transaction so the row and its mark can never disagree.
      if (isApprox === 1 && !hasApproxColumn) writeApproxFallback(db, id, true);

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

    // The sanity report is computed from the rows as SAVED and returned with the
    // row, so a caller that is not the entry screen — an importer, a script, a
    // tampered client that skipped the browser-side check — is still told that
    // what it just stored prices 100 pcs of prawns as 100 kg. The save is not
    // refused: refusing it would break the CSV importer and every existing edit
    // of the recipes that ALREADY carry such a line. Reported, never silent.
    /**
     * THE LINK THIS SAVE TOOK OFF SOMEBODY ELSE — said out loud.
     *
     * A menu item belongs to exactly one recipe, so creating a recipe for an item
     * that already had one MOVES the link, and the recipe that lost it is left
     * active, orphaned, and re-costed against its own (usually 0) price. The move
     * is deliberate and is already handled — recalculateRecipeCost(stolenFrom)
     * runs inside the transaction above — but nothing in the RESPONSE mentioned
     * it, so a caller that is not this app's own screens (an importer, a script)
     * saw a plain 201 and had no way to know it had just detached a recipe from
     * the only dish that gave it a price.
     *
     * Reported, not refused: the full recipe editor relies on being able to move
     * a link, and refusing here would break it. The browser cannot reach this
     * state anyway — a linked item offers "Open recipe", never a second quick
     * recipe — which is exactly why the non-browser caller is the one that needs
     * telling.
     */
    const relinked = stolenFrom && stolenFrom !== id
      ? (db.prepare('SELECT id, name, selling_price FROM recipes WHERE id = ?').get(stolenFrom) as
          { id: string; name: string; selling_price: number } | undefined)
      : undefined;

    return Response.json({
      recipe: {
        ...recipe,
        // Column when there is one, the flag we just honoured when there is not.
        is_approximate: !!Number(recipe.is_approximate) || isApprox === 1,
        ingredients: recipeIngredients,
        sub_recipes: recipeSubRecipes,
      },
      ...(relinked ? {
        menu_item_relinked_from: {
          recipe_id: relinked.id,
          recipe_name: relinked.name,
          warning: `That menu item was already linked to the recipe “${relinked.name}”. `
            + 'The link has moved to this new recipe, so that one is now attached to no menu item '
            + `and has been re-costed against its own stored price (${relinked.selling_price || 0}). `
            + 'It was not deleted or deactivated — open it and either give it a price, link it to a '
            + 'different dish, or deactivate it.',
        },
      } : {}),
      sanity: sanityFor(db, id, recipe.selling_price),
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

    // undefined when the key was not sent — every existing caller (the full
    // recipe editor, the workbook importer, /api/recipes/bulk) omits it and must
    // leave the flag exactly as it found it.
    const approxFlagRaw = boolFlag(body.is_approximate);
    if (approxFlagRaw === 'invalid') return approxFlagRejection(body.is_approximate);
    const approxFlag: 0 | 1 | undefined = approxFlagRaw;

    // Same rule as POST. Asking to MARK a recipe approximate on a database that
    // cannot record it EITHER WAY is refused; asking to CLEAR the mark (or not
    // mentioning it at all, which is every existing caller) is fine — and with
    // the sidecar there is now something real to clear.
    const hasApproxColumn = recipesHaveApproximateColumn(db);
    if (approxFlag === 1 && !canRecordApproximate(db)) {
      return Response.json({ error: APPROX_UNSUPPORTED }, { status: 503 });
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
      // COMPLETING a recipe is the act of a person, never a side effect.
      //
      // Adding a fifth ingredient does not make a rough recipe exact, so the flag
      // is NOT auto-cleared by an edit: omit the key and it is preserved verbatim.
      // The full recipe editor sends is_approximate: false explicitly when the
      // cook ticks "quantities are now exact", and that — only that — turns the
      // same row into a full recipe. Its id, its menu link and its history all
      // survive; nothing is replaced.
      //
      // The column is SET only when it exists (see recipesHaveApproximateColumn);
      // every other field is written identically either way.
      const common = [
        name || existing.name,
        category ?? existing.category,
        selling_price ?? existing.selling_price,
        instructions !== undefined ? (instructions || '').toString() : (existing.instructions ?? ''),
        image_url !== undefined ? (image_url || '').toString() : (existing.image_url ?? ''),
      ];
      if (hasApproxColumn) {
        db.prepare(`
          UPDATE recipes
          SET name = ?, category = ?, selling_price = ?, instructions = ?, image_url = ?,
              is_approximate = ?,
              version = version + 1, updated_at = datetime('now')
          WHERE id = ?
        `).run(
          ...common,
          approxFlag !== undefined ? approxFlag : (Number(existing.is_approximate) ? 1 : 0),
          id,
        );
      } else {
        db.prepare(`
          UPDATE recipes
          SET name = ?, category = ?, selling_price = ?, instructions = ?, image_url = ?,
              version = version + 1, updated_at = datetime('now')
          WHERE id = ?
        `).run(...common, id);
        // No column → the sidecar carries it. Only when the caller actually SENT
        // the key: every legacy caller omits it and must leave the mark exactly
        // as it found it (approxFlag is undefined then, and this does nothing).
        if (approxFlag !== undefined) writeApproxFallback(db, id, approxFlag === 1);
      }

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
      recipe: {
        ...recipe,
        // Column when there is one; otherwise the sidecar, read back from disk so
        // the caller is told what was actually stored, not what it asked for.
        is_approximate: hasApproxColumn
          ? !!Number(recipe.is_approximate)
          : approxIdsFallback(db).has(String(id)),
        ingredients: recipeIngredients,
        sub_recipes: recipeSubRecipes,
      },
      sanity: sanityFor(db, id, recipe.selling_price),
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
