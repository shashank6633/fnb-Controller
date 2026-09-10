import type Database from 'better-sqlite3';

/**
 * WHICH PRICE IS A RECIPE COSTED AGAINST?
 * ---------------------------------------
 * Two tables carried a price and nothing reconciled them:
 *
 *   recipes.selling_price      — typed into the recipe form. Charged to nobody.
 *   menu_items.selling_price   — what the guest is actually billed
 *                                (src/app/api/dine-in/orders/[id]/route.ts:129,149).
 *
 * recalculateRecipeCost divided cost by the RECIPE's price, so a dish linked to a
 * ₹279 menu item but carrying a stale ₹96 in the recipe row reported FC 30.4%
 * when the guest-facing truth was 10.4%. Repricing on /menu-items never touched
 * the recipe and never re-costed it, so the two numbers drifted apart forever.
 *
 * THE RULE, now enforced in one place:
 *
 *   A recipe LINKED to a live, priced menu item is costed against the MENU price.
 *   The menu price is what the guest pays, so it is the only denominator under
 *   which "food cost %" means anything.
 *
 *   An UNLINKED recipe (sub-recipes, party/custom dishes, un-listed items) keeps
 *   its own price. That is the only case where recipes.selling_price is a real
 *   commercial input.
 *
 * recipes.selling_price is NOT overwritten by this resolution — it is preserved
 * verbatim and simply stops being the denominator while a link exists. Aligning
 * the stored value is a separate, reviewed, admin-triggered action
 * (/api/admin/recipe-price-reconcile) — never automatic, never a boot migration.
 *
 * TIE-BREAK when one recipe feeds several menu items: the LOWEST priced live
 * item wins. FC% is a risk metric; pricing off the cheapest listing gives the
 * highest (most cautious) food cost, so a multi-listed dish can never look
 * safer than its worst-margin listing. `linked_count` is surfaced so the UI can
 * say so out loud rather than leaving the choice invisible.
 */
export interface RecipePriceResolution {
  /** The denominator for FC% / GPM / profit. */
  price: number;
  /** Where `price` came from. */
  source: 'menu_item' | 'recipe';
  /** recipes.selling_price, preserved verbatim whatever the source. */
  recipe_price: number;
  /** The live menu item that set the price (only when source === 'menu_item'). */
  menu_item_id: string | null;
  menu_item_name: string | null;
  menu_item_category: string | null;
  menu_price: number | null;
  /** How many live menu items point at this recipe (0 = unlinked). */
  linked_count: number;
  /** True when a link exists AND the two stored prices disagree. */
  drifted: boolean;
}

interface LinkRow {
  id: string;
  name: string;
  category: string | null;
  selling_price: number | null;
}

function build(recipePrice: number, links: LinkRow[]): RecipePriceResolution {
  const rp = Number(recipePrice) || 0;
  // Only a live, positively-priced listing can own the price. A delisted item
  // (is_active = 0) or a ₹0 placeholder must not silently zero a recipe's FC%.
  const priced = links
    .filter((l) => Number(l.selling_price) > 0)
    .sort((a, b) => Number(a.selling_price) - Number(b.selling_price));

  if (!priced.length) {
    return {
      price: rp,
      source: 'recipe',
      recipe_price: rp,
      menu_item_id: null,
      menu_item_name: null,
      menu_item_category: null,
      menu_price: null,
      linked_count: links.length,
      drifted: false,
    };
  }

  const win = priced[0];
  const menuPrice = Number(win.selling_price);
  return {
    price: menuPrice,
    source: 'menu_item',
    recipe_price: rp,
    menu_item_id: win.id,
    menu_item_name: win.name,
    menu_item_category: win.category ?? null,
    menu_price: menuPrice,
    linked_count: links.length,
    // Round to paise before comparing — a float tail is not a pricing decision.
    drifted: Math.round(rp * 100) !== Math.round(menuPrice * 100),
  };
}

const LINK_SQL = `
  SELECT id, name, category, selling_price
  FROM menu_items
  WHERE recipe_id = ? AND is_active = 1
`;

/** Resolve the effective price for ONE recipe. */
export function resolveRecipePrice(
  db: Database.Database,
  recipeId: string,
  recipePrice: number,
): RecipePriceResolution {
  const links = db.prepare(LINK_SQL).all(recipeId) as LinkRow[];
  return build(recipePrice, links);
}

/**
 * Resolve every recipe at once — two queries total, for list endpoints that
 * would otherwise fire one lookup per row.
 */
export function resolveRecipePricesBulk(
  db: Database.Database,
  recipes: Array<{ id: string; selling_price: number }>,
): Map<string, RecipePriceResolution> {
  const out = new Map<string, RecipePriceResolution>();
  if (!recipes.length) return out;

  const byRecipe = new Map<string, LinkRow[]>();
  const rows = db.prepare(`
    SELECT id, name, category, selling_price, recipe_id
    FROM menu_items
    WHERE recipe_id IS NOT NULL AND recipe_id <> '' AND is_active = 1
  `).all() as Array<LinkRow & { recipe_id: string }>;
  for (const r of rows) {
    const slot = byRecipe.get(r.recipe_id) || [];
    slot.push({ id: r.id, name: r.name, category: r.category, selling_price: r.selling_price });
    byRecipe.set(r.recipe_id, slot);
  }

  for (const rec of recipes) {
    out.set(rec.id, build(Number(rec.selling_price) || 0, byRecipe.get(rec.id) || []));
  }
  return out;
}

/**
 * FC% AND PROFIT ARE DERIVED, NOT REMEMBERED.
 * ------------------------------------------
 * recipes.food_cost_percent / recipes.profit are a CACHE written by
 * recalculateRecipeCost. Changing the denominator (this file) does not travel
 * back in time: a recipe nobody has edited or re-costed since still holds the
 * figure computed under the old rule, and a read surface that prints that
 * column prints a food cost that contradicts the price printed beside it on
 * the same row — the owner's exact complaint.
 *
 * So every read surface computes the pair here, from total_cost and the
 * effective price it is already showing, and never trusts the stored column.
 * The cache is still written (it is what the admin reconcile audits and what
 * a fresh recompute produces) but nothing reads it to render a number.
 *
 * Rounding matches recalculateRecipeCost in src/lib/db.ts exactly, so a
 * recomputed row and a stored row can be compared for equality in paise.
 */
export interface CostedFigures {
  food_cost_percent: number;
  profit: number;
}

export function costedFigures(totalCost: number, effectivePrice: number): CostedFigures {
  const cost = Number(totalCost) || 0;
  const price = Number(effectivePrice) || 0;
  const fc = price > 0 ? (cost / price) * 100 : 0;
  return {
    food_cost_percent: Math.round(fc * 100) / 100,
    profit: Math.round((price - cost) * 100) / 100,
  };
}

/** True when the row's stored cache disagrees with the derived truth. */
export function figuresAreStale(
  stored: { food_cost_percent?: number | null; profit?: number | null },
  derived: CostedFigures,
): boolean {
  const a = Math.round((Number(stored.food_cost_percent) || 0) * 100);
  const b = Math.round((Number(stored.profit) || 0) * 100);
  return a !== Math.round(derived.food_cost_percent * 100)
      || b !== Math.round(derived.profit * 100);
}

/**
 * CLIENT-SAFE mirror of LINK_SQL's `is_active = 1`.
 *
 * The browser holds the whole menu list (live AND delisted) and was matching a
 * recipe to the first row with that recipe_id, delisted included. The server
 * ignores delisted listings entirely, so the modal could lock the price field
 * to a ₹888 item the costing engine had never heard of. One rule, two callers.
 */
export interface MenuListingLite {
  id: string;
  name?: string;
  category?: string;
  selling_price?: number | null;
  recipe_id?: string | null;
  is_active?: number | boolean | null;
}

const isLive = (mi: MenuListingLite) => mi.is_active === undefined || mi.is_active === null
  ? true                                   // payload without the column: assume live
  : !!Number(mi.is_active);

/** Every LIVE listing pointing at this recipe (priced or not), lowest price first. */
export function liveListingsFor<T extends MenuListingLite>(items: T[], recipeId: string): T[] {
  return items
    .filter((mi) => mi.recipe_id === recipeId && isLive(mi))
    .sort((a, b) => (Number(a.selling_price) || 0) - (Number(b.selling_price) || 0));
}

/**
 * The one listing that governs this recipe's price: live, priced > 0, and the
 * cheapest of them. Exactly what build() picks server-side. Null when no live
 * priced listing exists — the recipe then owns its own price.
 */
export function governingListing<T extends MenuListingLite>(items: T[], recipeId: string): T | null {
  const priced = liveListingsFor(items, recipeId).filter((mi) => Number(mi.selling_price) > 0);
  return priced[0] ?? null;
}

/** Does THIS listing, on its own, govern the recipe it points at? */
export function listingGoverns<T extends MenuListingLite>(items: T[], listing: T): boolean {
  if (!listing.recipe_id) return false;
  const win = governingListing(items, listing.recipe_id);
  return !!win && win.id === listing.id;
}

/**
 * Human-readable note for the surface showing an FC%, so the number can never
 * again be read against a price the reader has to guess at.
 */
export function priceSourceLabel(res: RecipePriceResolution): string {
  if (res.source === 'menu_item') {
    return res.linked_count > 1
      ? `menu item "${res.menu_item_name}" (lowest of ${res.linked_count} linked listings)`
      : `menu item "${res.menu_item_name}"`;
  }
  return 'this recipe’s own price (not linked to a menu item)';
}
