import { getDb, generateId, recalcRecipesForMenuItems } from '@/lib/db';
import { checkStationOnSave } from '@/lib/station-master';
import { getCurrentUser, type SessionUser } from '@/lib/auth';
import { checkRecipeSanity, type SanityInput } from '@/lib/recipe-sanity';

/**
 * IS THE `recipes.is_approximate` COLUMN THERE?
 * ---------------------------------------------
 * This endpoint is the menu. The captain POS, the dine-in order pad, the party
 * menu picker and the offline LAN cache all read it, so if it throws, the
 * restaurant cannot take an order — which would be the worst possible version of
 * "a recipe decided what appears on the menu".
 *
 * IT IS NOT THERE TODAY. The owner's live database has 15 columns on `recipes`
 * and none of them is `is_approximate` (PRAGMA table_info, read-only snapshot,
 * 2026-09-11). The migration that would add it is an UNCOMMITTED line in
 * src/lib/db.ts — another lane's file, which this work may not edit — so whether
 * it ever runs is not this endpoint's to promise. An earlier revision of this
 * comment asserted the migration "ships WITH this change"; it does not, and a
 * comment that says otherwise is the reason somebody stops checking.
 *
 * So this query must not DEPEND on the column: it asks first, and if the column
 * is missing the menu still loads. The "approximate" mark is not lost with it —
 * it falls back to the sidecar below, which needs no schema change at all. A
 * missing mark costs a label; a thrown query costs the service.
 *
 * Cached only once it has been SEEN — the migration runs inside getDb(), which
 * has already run by the time any handler here asks, so a "yes" can never go back
 * to "no" inside one process. A "no" is re-checked (a PRAGMA on a 15-column table
 * is free) so the first boot after the migration ships needs no restart.
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

/**
 * THE APPROXIMATE MARK WITHOUT A SCHEMA CHANGE.
 * ---------------------------------------------
 * The owner's spec says a user who has no full recipe "should still be able to
 * create a Simple/Basic Recipe". That sentence was 100% non-functional: the
 * simple-recipe save returned 503 because the mark it carries had nowhere to be
 * written, and an unmarked rough cost reading as a measured one is the one thing
 * this feature must never do.
 *
 * The mark is one bit per recipe. It does not need a column — it needs somewhere
 * durable to live, and `settings` (key TEXT PRIMARY KEY, value TEXT) already is
 * that. One row, `recipe_approximate_ids_v1`, holding a JSON array of recipe ids.
 * No ALTER TABLE, no migration, nothing for a deploy to get wrong, and it works
 * on the database he is running RIGHT NOW.
 *
 * It is a FALLBACK, not a replacement. When the column exists it wins outright
 * and this row is not even read (`hasApprox` short-circuits every call site), so
 * the day the db.ts hunk lands nothing changes except that the sidecar stops
 * being consulted — and any recipe marked through it stays marked, because the
 * two are OR-ed while both exist. See the same pair in
 * src/app/api/recipes/route.ts, which is the only WRITER of the row; this file
 * only ever reads it.
 *
 * Deliberately one row, not one row per recipe: `settings` is read whole by
 * /api/settings, and 234 keys in a config table would be a mess that outlived
 * this workaround.
 */
// NOT exported: a Next.js route module may only export its handlers and a fixed
// set of config names — `export const APPROX_IDS_KEY` fails the build with
// "not assignable to type never". The same literal is declared in
// src/app/api/recipes/route.ts, which is the only writer; if you change it,
// change it in both places.
const APPROX_IDS_KEY = 'recipe_approximate_ids_v1';

/**
 * Can the mark be recorded AT ALL — either rail? The simple-recipe form asks this
 * before it offers itself, so the answer must be the same question the save path
 * actually tests (src/app/api/recipes/route.ts), or the screen offers something
 * the server then refuses.
 */
function canRecordApproximate(db: ReturnType<typeof getDb>): boolean {
  if (recipesHaveApproximateColumn(db)) return true;
  try {
    return !!db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'`).get();
  } catch {
    return false;
  }
}

function approximateRecipeIdsFallback(db: ReturnType<typeof getDb>): Set<string> {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(APPROX_IDS_KEY) as
      { value?: string } | undefined;
    if (!row?.value) return new Set();
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? new Set(parsed.map(String)) : new Set();
  } catch {
    // A malformed row must never cost the menu a page load. No mark is a label
    // lost; a thrown query is the service.
    return new Set();
  }
}

/**
 * WRITE GATE (owner's 2026-09 call): creating, editing or DELETING a menu item
 * — name, price, GST, station routing, active flag — is a manager/admin action on the
 * RESOLVED tier (an assigned role's base_role wins, so the "Head Chef" role,
 * base_role manager, passes). GET stays open to every signed-in user: the
 * captain POS, dine-in order pads, party menus, recipes page and the offline
 * LAN sync all read the menu. The CSV import route
 * (/api/menu-items/import) keeps its own existing gate and is untouched, as is
 * /api/menu-items/categories (requireRole('admin')).
 */
function requireMenuWriter(me: SessionUser | null): Response | null {
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (me.role !== 'admin' && me.role !== 'manager') {
    return Response.json({ error: 'Manager or admin only' }, { status: 403 });
  }
  return null;
}

/**
 * Reconcile an item's GST fields so they always agree (the bill engine sums the
 * combined tax_value per line). If explicit CGST/SGST are provided, the combined
 * value is their sum; if only a combined value arrives (e.g. CSV import), it is
 * split 50/50. Liquor is typically 0 (already taxed at source).
 */
function splitGst(
  cgstIn: unknown, sgstIn: unknown, combinedIn: unknown, r2: (n: number) => number,
): { cgst: number; sgst: number; combined: number } {
  const hasSplit = cgstIn !== undefined && cgstIn !== null || sgstIn !== undefined && sgstIn !== null;
  if (hasSplit) {
    const cgst = Math.max(0, r2(Number(cgstIn) || 0));
    const sgst = Math.max(0, r2(Number(sgstIn) || 0));
    return { cgst, sgst, combined: r2(cgst + sgst) };
  }
  const combined = Math.max(0, r2(Number(combinedIn) || 0));
  const cgst = r2(combined / 2);
  return { cgst, sgst: r2(combined - cgst), combined };
}

/**
 * Canonical item_type: lowercase + trailing non-alphanumerics stripped
 * ('Beverages.' → 'beverages'). POS sheets shipped a trailing dot which made
 * the type filter and stat-bar counts match nothing; every write path and the
 * summary counts share this normalizer (data repaired one-time in db.ts via
 * menu_item_type_normalize_v1).
 */
function normalizeItemType(v: unknown): string {
  return String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9]+$/, '');
}

/**
 * DOES THIS ROW WANT A RECIPE, AND IS IT STILL MISSING ONE?
 *
 * One predicate, because two things depend on it and they must never disagree:
 * `summary.foodsNoRecipe` (the backlog COUNT the owner watches shrink) and the
 * backlog LIST below (the rows he works through). If the count said 234 and the
 * list handed back 231, the number on screen would stop meaning anything the
 * moment he tried to act on it — and the one thing this whole feature is for is
 * a number he can trust to go down by one when he finishes one dish.
 *
 * Food + beverage only: a peg of whisky is poured from a bottle and costed on
 * the store rail, so folding 245 liquor rows in turns a real gap of 234 into a
 * wall of 479 nobody can act on. Active only: a delisted item sells nothing.
 */
function needsRecipe(i: { is_active?: unknown; item_type?: unknown; recipe_id?: unknown }): boolean {
  const t = normalizeItemType(i.item_type);
  return !!i.is_active && (t === 'foods' || t === 'beverages') && !i.recipe_id;
}

/** One row of the recipe backlog. */
interface BacklogRow {
  id: string;
  name: string;
  category: string;
  item_type: string;
  selling_price: number;
  material_id: string | null;
  material_name: string | null;
  /** Portions that left the kitchen — every bill type. See buildBacklog(). */
  portions: number;
  /** Of those, the ones nobody paid for (comp + NC). They cost the same to cook. */
  portions_free: number;
  /** ₹ taken for this dish while it recorded no food cost at all. */
  revenue: number;
  /** False when the sales import has never carried this item's name. */
  has_sales: boolean;
}

/**
 * THE BACKLOG, WORST FIRST — and what "worst" honestly means here.
 *
 * Ordered by PORTIONS SOLD, not revenue and certainly not alphabetically.
 * Revenue was the obvious choice and it is the wrong one on this data:
 *   · 4,732 portions were comped and 863 more went out on NC bills. Every one of
 *     them carries quantity_sold and ZERO total_revenue — and a comped plate
 *     costs the kitchen exactly what a sold one costs. Ranking by money would
 *     rank the food that walked out for free as the least urgent thing here.
 *   · "Staff Roti" sells 331 portions at ₹0. By revenue it sorts last of 234; by
 *     portions it is 8th. 331 rotis of flour genuinely left the kitchen.
 * Portions is the count of food that was actually cooked, which is the thing a
 * missing recipe fails to account for. Revenue rides along on every row so the
 * money is never hidden — it just does not decide the order.
 *
 * Matched to sales by name, folded and trimmed, because `sales` carries
 * item_name (TEXT) and no menu_items id — there is no key to join on. 300 of the
 * 692 names in sales resolve to a live menu item. An item the import has never
 * named is NOT reported as "sold zero": it is marked has_sales=false and sorted
 * to the end, because "we have no record" and "it never sold" are different
 * facts and printing the second one would be inventing data.
 */
/** The menu_items columns this backlog actually reads. Narrower than the row. */
interface BacklogSourceItem {
  id: unknown; name: unknown; category: unknown; item_type: unknown;
  selling_price: unknown; material_id: string | null; is_active: unknown; recipe_id: unknown;
}

function buildBacklog(db: ReturnType<typeof getDb>, allItems: BacklogSourceItem[]): {
  rows: BacklogRow[];
  sales_days: number;
  sales_from: string | null;
  sales_to: string | null;
} {
  const pending = allItems.filter(needsRecipe);

  const fold = (s: unknown) => String(s ?? '').trim().toLowerCase();

  // One grouped pass over `sales` (1,141 rows, 692 names) — not one query per
  // backlog row.
  const salesByName = new Map<string, { portions: number; free: number; revenue: number }>();
  for (const r of db.prepare(`
    SELECT item_name,
           SUM(quantity_sold) AS portions,
           SUM(CASE WHEN LOWER(TRIM(bill_type)) = 'normal' THEN 0 ELSE quantity_sold END) AS free,
           SUM(total_revenue) AS revenue
    FROM sales GROUP BY LOWER(TRIM(item_name))
  `).all() as Array<{ item_name: string; portions: number; free: number; revenue: number }>) {
    salesByName.set(fold(r.item_name), {
      portions: Number(r.portions) || 0,
      free: Number(r.free) || 0,
      revenue: Number(r.revenue) || 0,
    });
  }

  // Material names for the "mapped to a material, which costs nothing" note —
  // one query for the distinct ids on the backlog, not one per row.
  const matIds = [...new Set(pending.map((i) => i.material_id).filter(Boolean))].map(String);
  const matNames = new Map<string, string>();
  if (matIds.length) {
    const ph = matIds.map(() => '?').join(',');
    for (const m of db.prepare(`SELECT id, name FROM raw_materials WHERE id IN (${ph})`).all(...matIds) as
      Array<{ id: string; name: string }>) matNames.set(String(m.id), m.name);
  }

  const rows: BacklogRow[] = pending.map((i) => {
    const s = salesByName.get(fold(i.name));
    return {
      id: String(i.id),
      name: String(i.name ?? ''),
      category: String(i.category ?? ''),
      item_type: normalizeItemType(i.item_type),
      selling_price: Number(i.selling_price) || 0,
      material_id: i.material_id ?? null,
      material_name: i.material_id ? (matNames.get(String(i.material_id)) ?? null) : null,
      portions: s ? s.portions : 0,
      portions_free: s ? s.free : 0,
      revenue: s ? s.revenue : 0,
      has_sales: !!s,
    };
  });

  // Portions desc; revenue breaks a tie (two dishes at 12 portions each, the
  // ₹549 one first); name last so the order is stable across reloads.
  rows.sort((a, b) =>
    (b.portions - a.portions) || (b.revenue - a.revenue) || a.name.localeCompare(b.name));

  const span = db.prepare(
    'SELECT COUNT(DISTINCT date) AS days, MIN(date) AS mn, MAX(date) AS mx FROM sales'
  ).get() as { days?: number; mn?: string; mx?: string };

  return {
    rows,
    sales_days: Number(span?.days) || 0,
    sales_from: span?.mn ?? null,
    sales_to: span?.mx ?? null,
  };
}

export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const category = url.searchParams.get('category');
    const station = url.searchParams.get('station');
    const itemType = url.searchParams.get('item_type');
    const search = url.searchParams.get('search');
    const activeOnly = url.searchParams.get('active_only') === 'true';
    const hasApprox = recipesHaveApproximateColumn(db);

    // material_cost = per-SERVING cost for direct-sell items, mirroring how
    // sales-import books cost (average_price × qty_per_unit). average_price is
    // ₹ per RECIPE unit (g/ml/pcs), NOT per serving: for volume/weight materials
    // it only becomes a serving cost once the pour size (direct_item_links.
    // qty_per_unit, recipe units per item sold — e.g. 30 for a peg, 750 for a
    // bottle) is configured; until then return NULL so the UI shows "—" instead
    // of a ₹/ml price masquerading as a dish cost. pcs-style materials are
    // 1 sold = 1 pc unless qty_per_unit overrides (e.g. bucket of 4).
    let query = `
      SELECT mi.*,
        r.total_cost as recipe_cost,
        -- recipe_food_cost_percent is NOT selected here: it is derived below
        -- from recipe_cost divided by this row's own price, so the stale cached
        -- column on recipes can never reach this list. See the loop below.
        ${hasApprox ? 'r.is_approximate' : 'NULL'} as recipe_is_approximate,
        r.name as recipe_name,
        rm.name as material_name,
        CASE
          WHEN LOWER(COALESCE(rm.unit, '')) IN ('ml', 'l', 'g', 'kg')
            THEN CASE WHEN COALESCE(dil.qty_per_unit, 1) != 1
                      THEN rm.average_price * dil.qty_per_unit END
          ELSE rm.average_price * COALESCE(dil.qty_per_unit, 1)
        END as material_cost
      FROM menu_items mi
      LEFT JOIN recipes r ON mi.recipe_id = r.id
      LEFT JOIN raw_materials rm ON mi.material_id = rm.id
      LEFT JOIN direct_item_links dil ON dil.item_name = mi.name COLLATE NOCASE
      WHERE 1=1
    `;
    const params: any[] = [];

    if (category) { query += ' AND mi.category = ?'; params.push(category); }
    if (station) { query += ' AND mi.station = ?'; params.push(station); }
    if (itemType) { query += ' AND mi.item_type = ?'; params.push(itemType); }
    if (activeOnly) { query += ' AND mi.is_active = 1'; }
    if (search) { query += ' AND mi.name LIKE ?'; params.push(`%${search}%`); }

    query += ' ORDER BY mi.category, mi.name';

    const items = db.prepare(query).all(...params) as any[];

    // recipe_food_cost_percent is DERIVED here, never served from the stored
    // recipes.food_cost_percent column. That column is a cache last written the
    // last time the recipe was re-costed; a recipe untouched since the costing
    // rule changed still holds a percentage computed against its own stale
    // price, which is how this list printed "₹499 · FC 19.47" (87.43 ÷ 449) on
    // one row. The column and its tooltip both promise cost ÷ THIS row's price,
    // so that is exactly what is computed — for every listing, whether or not it
    // is the one that governs the recipe (a dish listed twice is costed against
    // the cheaper listing; each row still reports honestly against its own).
    // ── CAN THIS COST BE TRUSTED? ────────────────────────────────────────────
    // A cost is only as good as the units it was computed in. 38 of the 67 live
    // recipes contain at least one line the engine admits it cannot convert —
    // LOOSE PRAWNS holds ₹63,012 because 100 pcs of prawns is valued as 100 kg —
    // and 11 of those recipes are linked to dishes on sale right now. Printing
    // "9,562%" next to a ₹659 dish without saying why is how a wrong number gets
    // believed, so the REASON travels with the figure onto this list.
    //
    // Measured, not assumed: every one of the 67 stored total_cost values
    // reproduces to the paise from today's average_price, so these figures are
    // NOT stale and do not wait on the price reconcile. The unit is the problem,
    // and the unit is what this says.
    //
    // One query for every linked recipe's lines, grouped in memory — bounded by
    // the number of DISTINCT linked recipes (18 on this data), not by the 628
    // rows in the list.
    const linkedRecipeIds = [...new Set(items.map((i) => i.recipe_id).filter(Boolean))].map(String);
    const linesByRecipe = new Map<string, SanityInput[]>();
    /**
     * A recipe with NOTHING IN IT is not a costed dish, and it used to read as
     * one: no ingredient rows meant the sanity check was skipped entirely, so the
     * row came back Linked, "₹0.00", no warning — and the backlog count fell by
     * one while nothing had been costed. LABANESE MIZZE PLATTER is exactly that
     * row on the live database (0 ingredients, 0 sub-recipes, total_cost 0) and
     * the Link-a-recipe picker this lane added offers it.
     *
     * Sub-recipes are counted too, because a recipe built entirely from prepared
     * bases has a real cost with no ingredient rows at all — flagging that one as
     * empty would be inventing a fault.
     */
    const subCountByRecipe = new Map<string, number>();
    if (linkedRecipeIds.length) {
      const placeholders = linkedRecipeIds.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT ri.recipe_id, ri.quantity, ri.unit, ri.yield_percent, ri.wastage_percent,
               rm.name AS material_name, rm.average_price, rm.unit AS material_unit,
               rm.pack_size AS material_pack_size
        FROM recipe_ingredients ri
        JOIN raw_materials rm ON ri.material_id = rm.id
        WHERE ri.is_default = 1 AND ri.recipe_id IN (${placeholders})
      `).all(...linkedRecipeIds) as Array<SanityInput & { recipe_id: string }>;
      for (const row of rows) {
        const list = linesByRecipe.get(row.recipe_id);
        if (list) list.push(row); else linesByRecipe.set(row.recipe_id, [row]);
      }
      for (const s of db.prepare(
        `SELECT recipe_id, COUNT(*) AS n FROM recipe_sub_recipes WHERE recipe_id IN (${placeholders}) GROUP BY recipe_id`
      ).all(...linkedRecipeIds) as Array<{ recipe_id: string; n: number }>) {
        subCountByRecipe.set(String(s.recipe_id), Number(s.n) || 0);
      }
    }

    // The sidecar is read ONCE per request, and only while the column is absent.
    // The day the db.ts migration lands this is a no-op branch.
    const approxFallback = hasApprox ? null : approximateRecipeIdsFallback(db);

    for (const it of items) {
      const cost = Number(it.recipe_cost);
      const price = Number(it.selling_price) || 0;
      it.recipe_food_cost_percent = it.recipe_id && Number.isFinite(cost) && price > 0
        ? Math.round((cost / price) * 10000) / 100
        : null;

      // Only BLOCKERS reach the menu list — a unit the system cannot convert or
      // does not know, or one line costing more than the whole dish. The
      // proportional warnings ("this line is 91% of the price") are real but they
      // are a recipe-book conversation, and on a 628-row list they would be noise
      // that trains the eye to skip the column.
      //
      // Judged against THIS row's own selling price, the same denominator the
      // FC% above uses, so the two can never contradict each other.
      if (it.recipe_id) {
        const lines = linesByRecipe.get(String(it.recipe_id));
        /**
         * A RECIPE WHOSE EVERY LINE CARRIES NO QUANTITY IS EMPTY TOO.
         *
         * "Empty" used to mean zero ingredient ROWS, and that let a second,
         * identical-looking zero through: a recipe holding one PANEER line with
         * quantity 0 costs ₹0.00 and is costed as though the line were not there,
         * but the row stopped reading "Not linked · ₹0" (honest) and started
         * reading "Recipe · Cost ₹0.00 · FC 0%" — a costed-looking zero, on the
         * strength of a line that contributes nothing. Same user-visible truth as
         * an empty recipe (linked, ₹0, not costed), so it gets the same flag and
         * the same badge rather than a new state nobody has seen before.
         *
         * Judged on QUANTITY, never on cost: a line can cost ₹0 because the
         * material has never been purchased (average_price 0), which is a
         * different fault with its own pill on /recipes, and calling that "empty"
         * would blame the wrong thing.
         */
        const noQuantityAnywhere = !!lines?.length
          && lines.every((l) => !(Number(l.quantity) > 0));
        if (!lines || !lines.length || noQuantityAnywhere) {
          // EMPTY RECIPE — unless it is built from sub-recipes, in which case its
          // cost is real and there is nothing to report. See subCountByRecipe.
          if (!(subCountByRecipe.get(String(it.recipe_id)) ?? 0)) {
            it.recipe_empty = true;
            it.recipe_cost_warning = noQuantityAnywhere
              ? `${it.recipe_name ? `The recipe “${it.recipe_name}”` : 'The linked recipe'} lists ${lines!.length === 1 ? 'an ingredient' : `${lines!.length} ingredients`} but no quantity against ${lines!.length === 1 ? 'it' : 'any of them'}, so this dish records ₹0.00 food cost — exactly as if it had no recipe.`
              : `${it.recipe_name ? `The recipe “${it.recipe_name}”` : 'The linked recipe'} has no ingredients in it at all, so this dish records ₹0.00 food cost — exactly as if it had no recipe.`;
            it.recipe_cost_warning_fix = noQuantityAnywhere
              ? 'Open the recipe and type how much of each material the dish uses. Until then this dish is not costed, whatever the badge says.'
              : 'Open the recipe and add the materials it uses, or link a different recipe. Until then this dish is not costed, whatever the badge says.';
            // NOT "unusable": there is no wrong number here, there is no number.
            // Striking through ₹0.00 would say the zero is a miscalculation; it
            // is an accurate report of an empty recipe.
          }
        } else {
          const report = checkRecipeSanity(lines, price);
          /**
           * THE LEAD IS THE BIGGEST MONEY, NOT THE FIRST ROW.
           *
           * Only ONE finding reaches this list, and it used to be whichever came
           * first in ingredient order. That is how MUTTON MURAG SOUP came to lead
           * with an ₹8.37 bay-leaf note while a ₹3,890.25 line on the same recipe
           * — 76% of its cost — was never mentioned: the cheap line simply sat
           * higher in the list. Sorting by line_cost costs nothing and puts the
           * sentence that matters on the row.
           *
           * `suspect` below still sums EVERY blocker, so the grading that decides
           * recipe_cost_unusable is untouched by this ordering.
           */
          const byMoney = (a: { line_cost: number }, b: { line_cost: number }) =>
            (Number(b.line_cost) || 0) - (Number(a.line_cost) || 0);
          const blockers = report.findings.filter((f) => f.severity === 'blocker');
          /**
           * THE QUIET TIER, and why it has to exist.
           *
           * Only BLOCKERS used to reach this list, and for one release that was
           * the same thing as "every unit problem". It stopped being: a weight
           * entered against a volume (100 g of SALAD OIL 500 ML, stocked in ml)
           * is now graded a NOTE rather than a blocker, because the money it
           * produces is the engine's own density-1 figure — right to within a few
           * percent — and striking a red line through ASIAN GREEN SALAD's correct
           * ₹333.20 taught the reader to skip the mark before it reached GONGURA
           * PRAWNS' ₹63,012. See src/lib/recipe-sanity.ts.
           *
           * But the note still has to be SAID. Filtering to blockers alone left
           * seven dishes on this data with a unit fault, a kept number and no
           * mark at all — and the key printed under the table still promised a
           * "check units" state that nothing could any longer be in. So unit
           * notes surface here too, as the amber tier: the figure is kept, the
           * row is not struck, `recipe_cost_unusable` stays false.
           *
           * WHICH warning codes belong on a 628-row menu list, named explicitly
           * rather than by a `unit_` prefix test.
           *
           * The prefix was doing two jobs and only admitted to one. It read as
           * "unit problems are the ones worth listing", but what it actually
           * decided was that any FUTURE warning code would be silently excluded —
           * and the first one added (`line_quantity_implausible`, the 700 g of
           * sweet chilli sauce in one salad) is precisely a data-entry error on a
           * costed dish, which is exactly what this column exists to surface. A
           * naming convention is not a policy; this set is the policy.
           *
           * The PROPORTIONAL warnings are still excluded on purpose: "this line
           * is 91% of the selling price" is a pricing judgement, not a fault, and
           * on 628 rows it would train the eye past the column.
           */
          const MENU_LIST_WARNINGS = new Set([
            'unit_density_assumed',        // g against ml — a few percent out
            'unit_unknown',                // (blocker today; listed so it cannot be lost)
            'line_quantity_implausible',   // 700 g of one thing on one plate
            'quantity_zero',               // a line that contributes nothing
          ]);
          const notes = report.findings
            .filter((f) => f.severity === 'warning' && MENU_LIST_WARNINGS.has(f.code))
            .sort(byMoney);
          const lead = [...blockers].sort(byMoney)[0] ?? notes[0] ?? null;
          if (lead) {
            it.recipe_cost_warning = lead.message;
            it.recipe_cost_warning_fix = lead.likely_cause;
            /**
             * WHAT KIND of fault it is, because the page was VOUCHING for the
             * total on the strength of it. The amber tooltip read "This is a
             * small part of the cost, so the total is still broadly right" for
             * ANY non-unusable warning — true of a g-vs-ml density note, and
             * flatly false of 700 g of sauce that is 48% of the recipe's cost.
             * The page needs to know which sentence it is entitled to print.
             */
            it.recipe_cost_warning_kind =
              lead.code === 'line_quantity_implausible' ? 'quantity'
              : lead.code === 'quantity_zero' ? 'no_quantity'
              : 'unit';
          }
          if (blockers.length) {

            /**
             * HOW BADLY WRONG? — because "wrong" is not one thing, and treating
             * it as one thing is how a warning stops being read.
             *
             * Measured on this data, the eleven costed dishes with a bad line
             * split cleanly in two. Gongura Prawns has ₹63,000 of its ₹63,012 on
             * a single unconvertible line: the figure is not approximately
             * anything, it is noise. Thai Green Curry has ₹1.67 of its ₹152.24 on
             * one — two grams of pepper read as two millilitres. Striking through
             * ₹152.24 over ₹1.67 would teach him to ignore the mark by the third
             * row he saw it on, and then it would not be there when Gongura
             * Prawns came round.
             *
             * So the money decides. The cost is called UNUSABLE when the lines
             * the engine could not convert are more than a quarter of it, or when
             * those lines alone cost more than the dish sells for. Anything
             * smaller still gets named — quietly — because the cost it produces
             * is still broadly right.
             *
             * The denominator is the LARGER of the ingredient total and the
             * recipe's stored cost, because the stored figure includes
             * sub-recipes that the ingredient sum does not. Taking the larger can
             * only ever make the share smaller, so this can overstate nothing.
             */
            const suspect = blockers.reduce((sum, f) => sum + (Number(f.line_cost) || 0), 0);
            const basis = Math.max(Number(report.total_cost) || 0, Number(it.recipe_cost) || 0);
            it.recipe_cost_unusable =
              (basis > 0 && suspect / basis > 0.25) || (price > 0 && suspect > price);
          }
        }
      }
      // APPROXIMATE travels with the cost, on the same row, always. The cost and
      // the FC% on this line are derived from the linked recipe, so if that
      // recipe's quantities are rough these two numbers are rough — and this
      // list is read for pricing decisions. Shipping the cost without the
      // qualifier is what would make an approximate figure dangerous.
      //
      // Column first, sidecar second — OR-ed, so a recipe marked before the
      // migration lands keeps its mark after it does. See APPROX_IDS_KEY.
      const approx = !!Number(it.recipe_is_approximate)
        || (!!approxFallback && !!it.recipe_id && approxFallback.has(String(it.recipe_id)));

      /**
       * WHAT GOES ON THE WIRE — and what does not.
       *
       * This response is the MENU. Every captain tablet pulls it on every order
       * screen and src/lib/menu-cache.ts writes the whole thing into each
       * device's localStorage, so a field that carries no information is not
       * free: measured at 542,284 bytes, of which 88,392 (+19.5%) was these five
       * keys holding `null` and `false` on 617 rows that have nothing to say.
       * A comment in this file used to claim "the hot path is byte for byte what
       * it was"; it was 88 KB out.
       *
       * So each key is written only when it carries something. Absent and false
       * read identically on every consumer (page.tsx tests truthiness), and the
       * TypeScript shape already declares them optional.
       */
      if (approx) it.recipe_is_approximate = true; else delete it.recipe_is_approximate;
      if (it.recipe_name == null) delete it.recipe_name;
      if (!it.recipe_cost_warning) { delete it.recipe_cost_warning; delete it.recipe_cost_warning_fix; delete it.recipe_cost_warning_kind; }
      if (!it.recipe_cost_unusable) delete it.recipe_cost_unusable;
      if (!it.recipe_empty) delete it.recipe_empty;
    }

    // Summary stats
    const allItems = db.prepare('SELECT * FROM menu_items').all() as any[];
    const summary = {
      total: allItems.length,
      active: allItems.filter(i => i.is_active).length,
      inactive: allItems.filter(i => !i.is_active).length,
      foods: allItems.filter(i => normalizeItemType(i.item_type) === 'foods').length,
      liquors: allItems.filter(i => normalizeItemType(i.item_type) === 'liquors').length,
      beverages: allItems.filter(i => normalizeItemType(i.item_type) === 'beverages').length,
      withRecipe: allItems.filter(i => i.recipe_id).length,
      withMaterial: allItems.filter(i => i.material_id).length,
      noPrice: allItems.filter(i => !i.selling_price || i.selling_price === 0).length,
      noCategory: allItems.filter(i => !i.category).length,
      noStation: allItems.filter(i => !i.station).length,
      noDietaryTag: allItems.filter(i => i.item_type === 'foods' && !i.dietary_tag).length,
      // How many DISHES still have no recipe — THE backlog count, and the number
      // the owner watches go down. It shares needsRecipe() with the backlog list
      // below precisely so finishing one dish moves this by exactly one.
      foodsNoRecipe: allItems.filter(needsRecipe).length,
      foodsTotal: allItems.filter(i => {
        const t = normalizeItemType(i.item_type);
        return i.is_active && (t === 'foods' || t === 'beverages');
      }).length,
    };

    // Available categories & stations for filter dropdowns
    const categories = [...new Set(allItems.map(i => i.category).filter(Boolean))].sort();
    const stations = [...new Set(allItems.map(i => i.station).filter(Boolean))].sort();

    /**
     * THE BACKLOG — only when asked for, and only for someone who can act on it.
     *
     * NOT on the default read. This endpoint IS the menu: the captain POS, the
     * dine-in order pad, the party picker and the offline LAN cache all hit it,
     * some of them on a tablet over a venue's wifi. Aggregating 1,141 sales rows
     * on every one of those calls to serve a panel they never open would be a
     * tax on order-taking, so `?backlog=1` is opt-in and the hot path is byte
     * for byte what it was.
     *
     * Gated to manager/admin — the same tier that may WRITE a recipe
     * (requireMenuWriter / requireRecipeWriter). Two reasons, and either alone
     * would be enough: this payload carries per-dish revenue, which is sales
     * data the house keeps to management (a captain reads this endpoint for the
     * menu and has no business reading the takings out of it); and a backlog is
     * a worklist, so offering one to somebody whose every click would 403 is
     * offering a refusal.
     *
     * A refusal does NOT fail the request. The menu still loads exactly as
     * before and `backlog` simply comes back null with a reason — a captain's
     * POS must never go dark because it asked for a panel it cannot have.
     */
    let backlog: BacklogRow[] | null = null;
    let backlogDenied = false;
    let backlogMeta: { sales_days: number; sales_from: string | null; sales_to: string | null } | null = null;
    if (url.searchParams.get('backlog') === '1') {
      const me = await getCurrentUser();
      if (!me || (me.role !== 'admin' && me.role !== 'manager')) {
        backlogDenied = true;
      } else {
        const built = buildBacklog(db, allItems);
        backlog = built.rows;
        backlogMeta = { sales_days: built.sales_days, sales_from: built.sales_from, sales_to: built.sales_to };
      }
    }

    // Can a recipe be SAVED as approximate on this database? The screen needs to
    // know before it offers the simple-recipe form, because a recipe saved
    // without the mark would print a rough figure that looks like a measured one
    // — the exact thing the mark exists to prevent. EITHER rail will record it:
    // the column if the migration has run, the settings sidecar if it has not.
    // On the owner's database today the answer is the sidecar, and the answer is
    // yes — which is what makes the owner's "should still be able to create a
    // Simple/Basic Recipe" true rather than a 503.
    return Response.json({
      items, summary, categories, stations, approximate_supported: canRecordApproximate(db),
      backlog, backlog_denied: backlogDenied, backlog_meta: backlogMeta,
    });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const denied = requireMenuWriter(await getCurrentUser());
    if (denied) return denied;
    const db = getDb();
    const body = await request.json();
    const { name, category, station, item_type, dietary_tag, selling_price, listing_price, item_code, tax_value, cgst_percent, sgst_percent, prep_minutes, is_active, recipe_id, material_id, notes,
            image_url, spice_level, tags, taste_sour, taste_sweet, taste_spicy, taste_tangy, serves, options } = body;

    if (!name) return Response.json({ error: 'name is required' }, { status: 400 });

    // STATION IS A ROUTING KEY, NOT A LABEL — see checkStationOnSave(). A new
    // item has no held value to fall back on, so it is the master or nothing.
    // Checked BEFORE the INSERT so a refusal writes nothing at all.
    //
    // WHAT IS WRITTEN IS `stationCheck.store`, NOT `station`. The check matches
    // the master case-insensitively (the way every reader matches), so
    // "Tandoor" passes it — but kot-fire.ts groups a fired order by the RAW
    // string, so storing the client's bytes split one section's tickets into
    // two KOTs, and an NBSP/BOM-carrying spelling was stranded forever by
    // every SQLite-side lower(trim()) predicate (renames included). The store
    // value is the master row's own spelling, so every accepted spelling of a
    // station is byte-identical at the source.
    const stationCheck = checkStationOnSave(db, station, null);
    if (!stationCheck.ok) return Response.json({ error: stationCheck.error }, { status: 400 });

    const clamp = (v: any, max: number) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
    const asJson = (v: any) => Array.isArray(v) ? JSON.stringify(v) : (typeof v === 'string' ? v : '');
    const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
    // Per-item GST. If explicit CGST/SGST come in, tax_value = their sum (kept in
    // sync for the bill engine). If only a combined tax_value arrives (import),
    // split it 50/50. Liquor typically 0 (already taxed at source).
    const tax = splitGst(cgst_percent, sgst_percent, tax_value, r2);

    const id = generateId();
    db.prepare(`
      INSERT INTO menu_items (id, name, category, station, item_type, dietary_tag, selling_price, listing_price, item_code, tax_value, cgst_percent, sgst_percent, prep_minutes, is_active, recipe_id, material_id, source, notes,
                              image_url, spice_level, tags, taste_sour, taste_sweet, taste_spicy, taste_tangy, serves, options, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      id, name, category || '', stationCheck.store, normalizeItemType(item_type) || 'foods', dietary_tag || '',
      Number(selling_price) || 0, Number(listing_price) || 0, item_code || '', tax.combined, tax.cgst, tax.sgst,
      Number(prep_minutes) || 0, is_active === false ? 0 : 1, recipe_id || null, material_id || null, notes || '',
      (image_url || '').toString(), clamp(spice_level, 3), asJson(tags),
      clamp(taste_sour, 4), clamp(taste_sweet, 4), clamp(taste_spicy, 4), clamp(taste_tangy, 4), (serves || '').toString(), asJson(options)
    );

    // Creating a listing that already points at a recipe changes that recipe's
    // costing denominator (src/lib/recipe-price.ts) — re-cost it now.
    if (recipe_id) {
      try { recalcRecipesForMenuItems(db, [id]); } catch (e) { console.error('menu-item re-cost failed', e); }
    }

    const item = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id);
    return Response.json({ item }, { status: 201 });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const denied = requireMenuWriter(await getCurrentUser());
    if (denied) return denied;
    const db = getDb();
    const body = await request.json();
    const { id, ...fields } = body;

    if (!id) return Response.json({ error: 'id is required' }, { status: 400 });

    // STATION IS A ROUTING KEY, NOT A LABEL — see checkStationOnSave().
    //
    // Only when `station` is actually IN THE BODY. A PUT that never mentions it
    // (the list page's is_active toggle sends { id, is_active } and nothing
    // else) is untouched by this, exactly as before: the loop below already
    // skips absent keys, and re-validating a field nobody sent would turn every
    // legacy row into an un-toggleable one.
    //
    // Read BEFORE the UPDATE, so the "held value" is the station the row had
    // when the caller asked — and so a refusal writes nothing at all.
    //
    // On a pass, `fields.station` is REPLACED with `stationCheck.store` — the
    // master row's own spelling (or '' for blank, or the held value verbatim
    // for an off-master legacy row). Storing what the client sent is how
    // "Tandoor" beside "tandoor" shipped two KOTs for one section and how an
    // NBSP-spelled station survived every rename: see checkStationOnSave().
    if (fields.station !== undefined) {
      const cur = db.prepare('SELECT station FROM menu_items WHERE id = ?').get(id) as { station?: string | null } | undefined;
      const stationCheck = checkStationOnSave(db, fields.station, cur?.station);
      if (!stationCheck.ok) return Response.json({ error: stationCheck.error }, { status: 400 });
      fields.station = stationCheck.store;
    }

    const allowed = ['name', 'category', 'station', 'item_type', 'dietary_tag', 'selling_price', 'listing_price', 'item_code', 'tax_value', 'cgst_percent', 'sgst_percent', 'prep_minutes', 'is_active', 'recipe_id', 'material_id', 'notes',
      'image_url', 'spice_level', 'tags', 'taste_sour', 'taste_sweet', 'taste_spicy', 'taste_tangy', 'serves', 'options'];
    const updates: string[] = [];
    const values: any[] = [];
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        updates.push(`${key} = ?`);
        // tags/options may arrive as arrays from the form → store as JSON text.
        let v: any = (key === 'tags' || key === 'options') && Array.isArray(fields[key]) ? JSON.stringify(fields[key]) : fields[key];
        if (key === 'item_type') v = normalizeItemType(v);
        values.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
      }
    }
    if (updates.length === 0) return Response.json({ error: 'no fields to update' }, { status: 400 });

    // Keep tax_value = cgst_percent + sgst_percent whenever either half is edited,
    // so the per-item bill engine (which sums tax_value per line) stays correct.
    if (fields.cgst_percent !== undefined || fields.sgst_percent !== undefined) {
      const cur = db.prepare('SELECT cgst_percent, sgst_percent FROM menu_items WHERE id = ?').get(id) as any;
      const cg = Math.max(0, Number(fields.cgst_percent ?? cur?.cgst_percent ?? 0) || 0);
      const sg = Math.max(0, Number(fields.sgst_percent ?? cur?.sgst_percent ?? 0) || 0);
      const txIdx = updates.findIndex(u => u.startsWith('tax_value ='));  // drop any caller-sent tax_value; we derive it
      if (txIdx >= 0) { updates.splice(txIdx, 1); values.splice(txIdx, 1); }
      updates.push('tax_value = ?');
      values.push(Math.round((cg + sg) * 100) / 100);
    }

    // A linked recipe is costed against THIS price (see src/lib/recipe-price.ts),
    // so read the link as it stands BEFORE the write: if this call moves or drops
    // recipe_id, the recipe losing the link must fall back to its own price, and
    // after the write we can no longer find it from here.
    const beforeLink = db.prepare('SELECT recipe_id FROM menu_items WHERE id = ?').get(id) as
      { recipe_id?: string | null } | undefined;

    values.push(id);
    db.prepare(`UPDATE menu_items SET ${updates.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...values);

    // Re-cost whenever the price or the link moved. Without this, repricing a
    // dish here left the recipe's stored food_cost_percent computed against the
    // OLD menu price forever — the drift that reported 30.4% for a 10.4% dish.
    if (fields.selling_price !== undefined || fields.recipe_id !== undefined || fields.is_active !== undefined) {
      try {
        recalcRecipesForMenuItems(db, [id], [beforeLink?.recipe_id ?? null]);
      } catch (e) {
        // Never fail the menu edit over a costing refresh — the edit is the
        // user's action; the FC% is derived and self-heals on the next recompute.
        console.error('menu-item re-cost failed', e);
      }
    }

    const item = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id);
    return Response.json({ item });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    // SAME WRITE GATE AS POST/PUT — deleting a menu item is strictly more
    // destructive than editing one, and this handler had NO gate at all: any
    // signed-in session (a captain whose whole page set is /captain) could
    // hard-delete any menu item with nothing but the CSRF cookie every
    // logged-in browser already holds. Only caller, measured repo-wide:
    // src/app/menu-items/page.tsx:545 — the delete button on the manager
    // surface whose create/edit calls already pass this gate, so no
    // legitimate flow loses anything.
    const denied = requireMenuWriter(await getCurrentUser());
    if (denied) return denied;
    const db = getDb();
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (!id) return Response.json({ error: 'id is required' }, { status: 400 });

    // A linked recipe is costed against THIS item's price, so read the link
    // BEFORE the row is gone — afterwards there is nothing left to find it by.
    // Deactivating an item already re-costs (PUT above); DELETE was the one
    // writer of menu_items that never did, leaving the recipe's food cost and
    // profit measured against a price that no longer exists anywhere, with
    // price_drifted false so no banner or filter caught it. That contradicts
    // this function's own contract at src/lib/db.ts (recalcRecipesForMenuItems:
    // "Every writer of menu_items.selling_price / recipe_id MUST call this").
    const orphaned = (db.prepare('SELECT recipe_id FROM menu_items WHERE id = ?').get(id) as
      { recipe_id?: string | null } | undefined)?.recipe_id ?? null;

    db.prepare('DELETE FROM menu_items WHERE id = ?').run(id);

    if (orphaned) {
      try {
        recalcRecipesForMenuItems(db, [], [orphaned]);
      } catch (e) {
        // Never fail the delete over a costing refresh — the delete is the
        // user's action; FC% is derived on read and self-heals on recompute.
        console.error('menu-item delete re-cost failed', e);
      }
    }
    return Response.json({ success: true });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
