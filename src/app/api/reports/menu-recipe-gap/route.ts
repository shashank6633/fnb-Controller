import { getDb, logAuditEvent } from '@/lib/db';
import { getCurrentUser, isManagement, requireRole, getCurrentOutletId } from '@/lib/auth';
import { todayIST } from '@/lib/format-date';
import { buildRecipeMatcher, type RecipeMatch } from '@/lib/recipe-matcher';

/* ══════════════════════════════════════════════════════════════════════════
 * MENU RECIPE GAP — /api/reports/menu-recipe-gap
 *
 *   GET  (management) — which menu items remove nothing when sold, ranked by
 *                       the money they have actually taken.
 *   POST (admin only) — attach recipes the human explicitly ticked. Nothing
 *                       else. See THE ATTACH RULE at the POST handler.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS REPORT EXISTS (measured on the live copy, 2026-08-05)
 * ─────────────────────────────────────────────────────────────────────────
 * 628 menu items exist. 610 of them carry no recipe_id. Every deduction path
 * in this app gates on a recipe: recordSale (db.ts) only calls
 * deductInventoryForSale when s.recipe_id is set, the KDS bump only selects
 * order_items WHERE recipe_id IS NOT NULL AND recipe_id != '', and the settle
 * backstop stamps recipe_deducted_at only when it.recipe_id is truthy. So a
 * dish with no recipe records ZERO food cost and moves ZERO stock, forever,
 * silently. That is the hole this report measures.
 *
 * DIRECT ITEMS DO NOT ESCAPE IT. 357 of those 610 carry menu_items.material_id
 * (bottled beer and the 349 liquor lines). It is tempting to assume a direct
 * material link means the sale deducts — it does not. Nothing in the sale path
 * reads menu_items.material_id; is_direct_sell is only a raw_materials label.
 * Those items are flagged `direct_material_linked` on every row precisely so a
 * reviewer does not attach a food recipe to a bottle of beer: the fix for a
 * direct item is a direct-item deduction, not a recipe, and that fix is not
 * this report's to make.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE LINK IS A NAME, AND THAT IS A LIMITATION, NOT A DESIGN CHOICE
 * ─────────────────────────────────────────────────────────────────────────
 * sales.pos_item_id is NULL on all 1,141 rows and menu_items.pos_id matches
 * none of them, so LOWER(TRIM(name)) is the only link that exists. It matches
 * 510 of 1,141 sales rows. The other 631 are NOT dropped and NOT folded into
 * the ranked list — they get their own labelled bucket, `unmatched_sales`,
 * because a ranked table that quietly omits 55% of the sales rows would be read
 * as complete and it is not.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE BUCKETS ARE NEVER SUMMED (the purchase-log discipline)
 * ─────────────────────────────────────────────────────────────────────────
 * Three buckets ship, each with its own totals, and there is deliberately NO
 * grand-total field anywhere in this payload or CSV:
 *
 *   no_recipe       — menu items with no recipe. THE actionable list.
 *   with_recipe     — menu items that do have one. Context only.
 *   unmatched_sales — sales names matching no menu item at all.
 *
 * The first two count MENU ITEMS; the third counts SALES NAMES. Adding their
 * counts produces a number of nothing. Their revenue figures are disjoint
 * slices of the same sales window, so they *could* be added — and the sum is
 * simply "all sales in the period", which this report is not about and will not
 * print, because the moment it appears someone quotes it as the size of the gap.
 * If you are ever tempted to add a `total_*` here, re-read this block.
 *
 * BUCKET TOTALS ARE COMPUTED BY SQL AGGREGATE over the full filtered set, never
 * by summing the returned rows, so the row cap can never understate a figure.
 * The revenue totals are computed SALES-SIDE (one classification per sales
 * name) rather than by adding up per-item revenue: if two menu items ever share
 * a normalised name, both rows legitimately show the same sales, and summing
 * the rows would count that money twice. `caveats.duplicate_menu_name_groups`
 * reports whether that condition exists at all (it is 0 today).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SENTENCE THAT MUST NEVER BE DROPPED FROM THIS FILE
 * ─────────────────────────────────────────────────────────────────────────
 * Attaching a recipe fixes FUTURE sales only. order_items.recipe_id and
 * sales.recipe_id are SNAPSHOTS copied when the item is punched, so sales
 * already rung up keep their zero food cost and their un-deducted stock no
 * matter what is attached afterwards. It ships in the JSON, in the CSV header
 * block, and in every POST response — three places, on purpose, because this
 * file gets read as a page, forwarded as a spreadsheet, and called as an API by
 * three different people who each need to hear it.
 * ══════════════════════════════════════════════════════════════════════════ */

// A gap report served from cache is a wrong gap report: it changes the instant
// anybody attaches a recipe or rings up a sale.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Printed verbatim in the JSON, the CSV and every POST response. */
const FUTURE_ONLY_NOTICE =
  'Attaching a recipe fixes FUTURE sales only. sales.recipe_id and order_items.recipe_id are snapshots '
  + 'taken when the item is punched, so sales already rung up keep their zero food cost and are not repaired.';

const NO_RECIPE_NOTE =
  'Menu items with no recipe attached. Every sale of these records zero food cost and removes no stock, '
  + 'because every deduction path in the app gates on recipe_id. Ranked by the revenue they have actually '
  + 'taken in this window, so the biggest holes come first.';

const WITH_RECIPE_NOTE =
  'Menu items that DO have a recipe. Context only — shown so the ranked list above can be read against the '
  + 'whole menu. Not a to-do list.';

const UNMATCHED_NOTE =
  'Sold, not on the menu master: sales rows whose item name matches no menu item by LOWER(TRIM(name)). '
  + 'sales.pos_item_id is NULL on every row, so name is the only link available. These are reported, never '
  + 'dropped and never folded into the ranked list — but they cannot be fixed by attaching a recipe until the '
  + 'name is reconciled with a menu item.';

const UNREPAIRABLE_NOTE =
  'Sales rows carrying no recipe_id whose menu item DOES now have a recipe. These are the sales that attaching '
  + 'cannot repair — the link was absent at the moment the item was punched and the sale row froze that.';

const NO_SUM_NOTE =
  'These buckets measure different populations (menu items vs sales names) and are deliberately never summed. '
  + 'There is no grand total in this report on purpose.';

/** Same normalisation the SQL uses. Kept beside it so the two cannot drift. */
const norm = (s: unknown): string => String(s ?? '').trim().toLowerCase();

const round2 = (n: unknown): number => Math.round((Number(n) || 0) * 100) / 100;
const round3 = (n: unknown): number => Math.round((Number(n) || 0) * 1000) / 1000;

/** Calendar arithmetic on an IST date string. Never touches the server's zone. */
function shiftIstDays(ymd: string, days: number): string {
  // Parsed as UTC midnight deliberately: the input is already an IST calendar
  // date from todayIST(), so plain day arithmetic on it is exact. Building a
  // local Date here would shift the window by a day on a non-IST server.
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** RFC-4180 escaping plus the Excel formula guard — menu names are free text
 *  and a leading '=' or '-' is executed by Excel when the file is opened. */
const csvCell = (v: unknown, numeric = false): string => {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (!numeric && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

interface GapRow {
  bucket: 'no_recipe' | 'with_recipe' | 'unmatched_sales';
  menu_item_id: string;
  menu_item: string;
  category: string;
  item_type: string;
  is_active: number;
  selling_price: number;
  pos_id: string;
  recipe_id: string;
  recipe_name: string;
  direct_material_linked: number;
  direct_material: string;
  units_sold: number;
  revenue: number;
  recorded_food_cost: number;
  implausible_cost_rows: number;
  sale_rows: number;
  order_count: number;
  last_sold_date: string;
  suggested_recipe_id: string;
  suggested_recipe: string;
  suggestion_score: number | '';
  suggestion_exact: number | '';
}

/**
 * CSV columns, header and accessor declared together — kept as ONE list rather
 * than a header array plus a separate row builder, because those two drift and
 * a column inserted in one and not the other files every later value under the
 * wrong heading. (purchase-log.ts learned this the expensive way.)
 */
const COLUMNS: { header: string; cell: (r: GapRow) => unknown; numeric?: boolean }[] = [
  { header: 'Bucket (no_recipe = the hole / with_recipe = context only / unmatched_sales = sold, not on the menu master)', cell: r => r.bucket },
  { header: 'Menu Item',                     cell: r => r.menu_item },
  { header: 'Menu Item ID',                  cell: r => r.menu_item_id },
  { header: 'Category',                      cell: r => r.category },
  { header: 'Item Type',                     cell: r => r.item_type },
  { header: 'Active (1 = live on the menu)', cell: r => r.is_active, numeric: true },
  { header: 'Selling Price (INR)',           cell: r => r.selling_price, numeric: true },
  { header: 'POS ID',                        cell: r => r.pos_id },
  { header: 'Recipe ID (blank = nothing is deducted when this sells)', cell: r => r.recipe_id },
  { header: 'Recipe',                        cell: r => r.recipe_name },
  // Named in full because the obvious reading of "has a material" is "so it must
  // deduct", and that reading is wrong — see the direct-items note in the header.
  { header: 'Direct Material Linked (1 = menu_items.material_id is set; this still deducts NOTHING on sale)', cell: r => r.direct_material_linked, numeric: true },
  { header: 'Direct Material',               cell: r => r.direct_material },
  { header: 'Units Sold (in window)',        cell: r => r.units_sold, numeric: true },
  { header: 'Revenue INR (in window)',       cell: r => r.revenue, numeric: true },
  // MEASURED from sales.total_cost, never printed as a hardcoded 0. On the live
  // data this is NOT zero and it is NOT a food cost — see the header note on
  // this column and caveats.recorded_food_cost.
  { header: 'Cost Recorded INR (from sales.total_cost — NOT a recipe food cost, see the notes at the end of this file)', cell: r => r.recorded_food_cost, numeric: true },
  { header: 'Sale Rows Where Recorded Cost EXCEEDS Revenue (a cost this large is a unit-basis error, not a margin)', cell: r => r.implausible_cost_rows, numeric: true },
  { header: 'Sale Rows',                     cell: r => r.sale_rows, numeric: true },
  { header: 'Distinct Order IDs (sales.order_id is NULL on almost every legacy row, so this reads low)', cell: r => r.order_count, numeric: true },
  { header: 'Last Sold',                     cell: r => r.last_sold_date },
  { header: 'SUGGESTION ONLY — Candidate Recipe (fuzzy name match, NOT applied by anything)', cell: r => r.suggested_recipe },
  { header: 'SUGGESTION ONLY — Candidate Recipe ID',        cell: r => r.suggested_recipe_id },
  { header: 'SUGGESTION ONLY — Match Score (1 = exact name)', cell: r => r.suggestion_score, numeric: true },
  { header: 'SUGGESTION ONLY — Exact Name Match (1/0)',      cell: r => r.suggestion_exact, numeric: true },
];

/** A full-width CSV row carrying `label` in the first column. */
function captionRow(label: string): string {
  const cells = COLUMNS.map(() => '');
  cells[0] = label;
  return cells.map(c => csvCell(c)).join(',');
}

function emptyRow(bucket: GapRow['bucket']): GapRow {
  return {
    bucket,
    menu_item_id: '', menu_item: '', category: '', item_type: '', is_active: 0,
    selling_price: 0, pos_id: '', recipe_id: '', recipe_name: '',
    direct_material_linked: 0, direct_material: '',
    units_sold: 0, revenue: 0, recorded_food_cost: 0, implausible_cost_rows: 0,
    sale_rows: 0, order_count: 0,
    last_sold_date: '', suggested_recipe_id: '', suggested_recipe: '',
    suggestion_score: '', suggestion_exact: '',
  };
}

/*
 * Sales aggregated ONCE per normalised name. Everything downstream joins to
 * this CTE rather than to `sales` directly: joining menu_items straight to
 * sales fans a menu item out to one row per sale, and every SUM in the report
 * would then be multiplied by the sale count.
 *
 * COUNT(DISTINCT NULLIF(...)) on order_id because order_id is NULL on 1,132 of
 * the 1,141 rows; counting NULLs as one order would report "1 order" for a
 * thousand sales.
 */
const SALES_AGG = `
  WITH sagg AS (
    SELECT LOWER(TRIM(s.item_name))                       AS norm_name,
           MIN(s.item_name)                               AS sample_name,
           COALESCE(SUM(s.quantity_sold), 0)              AS units_sold,
           COALESCE(SUM(s.total_revenue), 0)              AS revenue,
           COALESCE(SUM(s.total_cost), 0)                 AS recorded_food_cost,
           COALESCE(SUM(CASE WHEN s.total_cost > s.total_revenue AND s.total_cost > 0
                             THEN 1 ELSE 0 END), 0)       AS implausible_cost_rows,
           COUNT(*)                                       AS sale_rows,
           COUNT(DISTINCT NULLIF(COALESCE(s.order_id, ''), '')) AS order_count,
           MAX(s.date)                                    AS last_sold_date
    FROM sales s
    WHERE s.date >= ? AND s.date <= ?
    GROUP BY LOWER(TRIM(s.item_name))
  )
`;

/**
 * The whole report, as JSON. The CSV branch calls THIS and reads the result
 * through the shared COLUMNS list, so the screen and the download can never
 * show different numbers — there is exactly one query path.
 */
async function buildJson(req: Request): Promise<Response> {
  try {
    // Same gate and same wording as /api/reports/purchases: this joins revenue
    // onto the menu, which is the commercially sensitive half of the app.
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!isManagement(me)) return Response.json({ error: 'Management only' }, { status: 403 });

    const sp = new URL(req.url).searchParams;
    const rawFrom = sp.get('from');
    const rawTo = sp.get('to');

    // A malformed date is a 400, never a silent fall-back to some other window.
    // Quietly reporting a different period than the one asked for is how a
    // report gets read, signed off and acted on for the wrong month.
    if (rawFrom !== null && !YMD.test(rawFrom)) {
      return Response.json({ error: `Invalid 'from' date "${rawFrom}" — expected YYYY-MM-DD.` }, { status: 400 });
    }
    if (rawTo !== null && !YMD.test(rawTo)) {
      return Response.json({ error: `Invalid 'to' date "${rawTo}" — expected YYYY-MM-DD.` }, { status: 400 });
    }

    const rawFormat = sp.get('format');
    if (rawFormat !== null && rawFormat !== 'json' && rawFormat !== 'csv') {
      return Response.json({ error: `Invalid 'format' "${rawFormat}" — expected json or csv.` }, { status: 400 });
    }

    const rawLimit = sp.get('limit');
    if (rawLimit !== null && !/^\d+$/.test(rawLimit)) {
      return Response.json({ error: `Invalid 'limit' "${rawLimit}" — expected a positive integer.` }, { status: 400 });
    }
    const limit = Math.min(Math.max(Number(rawLimit ?? 5000) || 5000, 1), 20000);

    const db = getDb();

    // DEFAULT WINDOW = every sale on record, not a rolling 30 days. This report
    // ranks holes by the money that has fallen through them; a short default
    // window makes a dish that sold hard last quarter look harmless. `to`
    // defaults to today (IST) so sales keyed with a future date are still in.
    const to = rawTo ?? todayIST();
    const earliest = (db.prepare('SELECT MIN(date) AS d FROM sales').get() as any)?.d as string | null;
    const from = rawFrom ?? (earliest && YMD.test(earliest) ? earliest : shiftIstDays(to, -29));
    if (from > to) {
      return Response.json({ error: `'from' (${from}) must be on or before 'to' (${to}).` }, { status: 400 });
    }
    const window_is_default = rawFrom === null && rawTo === null;

    /* ── Bucket 1 + 2: the menu, split by whether a recipe is attached. ────── */
    const menuSql = (havingRecipe: boolean) => `
      ${SALES_AGG}
      SELECT m.id                                       AS menu_item_id,
             m.name                                     AS menu_item,
             COALESCE(m.category, '')                   AS category,
             COALESCE(m.item_type, '')                  AS item_type,
             m.is_active                                AS is_active,
             COALESCE(m.selling_price, 0)               AS selling_price,
             COALESCE(m.pos_id, '')                     AS pos_id,
             COALESCE(m.recipe_id, '')                  AS recipe_id,
             COALESCE(r.name, '')                       AS recipe_name,
             CASE WHEN COALESCE(m.material_id, '') <> '' THEN 1 ELSE 0 END AS direct_material_linked,
             COALESCE(rm.name, '')                      AS direct_material,
             COALESCE(a.units_sold, 0)                  AS units_sold,
             COALESCE(a.revenue, 0)                     AS revenue,
             COALESCE(a.recorded_food_cost, 0)          AS recorded_food_cost,
             COALESCE(a.implausible_cost_rows, 0)       AS implausible_cost_rows,
             COALESCE(a.sale_rows, 0)                   AS sale_rows,
             COALESCE(a.order_count, 0)                 AS order_count,
             COALESCE(a.last_sold_date, '')             AS last_sold_date
      FROM menu_items m
      LEFT JOIN sagg a          ON a.norm_name = LOWER(TRIM(m.name))
      LEFT JOIN recipes r       ON r.id = m.recipe_id
      LEFT JOIN raw_materials rm ON rm.id = m.material_id
      WHERE ${havingRecipe ? "COALESCE(m.recipe_id, '') <> ''" : "COALESCE(m.recipe_id, '') = ''"}
      ORDER BY revenue DESC, units_sold DESC, m.name ASC
      LIMIT ?
    `;

    const noRecipeRaw = db.prepare(menuSql(false)).all(from, to, limit) as any[];
    const withRecipeRaw = db.prepare(menuSql(true)).all(from, to, limit) as any[];

    /* ── Bucket 3: sales names that match no menu item at all. ─────────────── */
    const unmatchedRaw = db.prepare(`
      ${SALES_AGG}
      SELECT a.sample_name, a.units_sold, a.revenue, a.recorded_food_cost,
             a.implausible_cost_rows, a.sale_rows, a.order_count, a.last_sold_date
      FROM sagg a
      WHERE NOT EXISTS (SELECT 1 FROM menu_items m WHERE LOWER(TRIM(m.name)) = a.norm_name)
      ORDER BY a.revenue DESC, a.units_sold DESC, a.sample_name ASC
      LIMIT ?
    `).all(from, to, limit) as any[];

    /*
     * SALES-SIDE totals, one classification per sales name. Computed by SQL
     * aggregate over the FULL window (not by summing the capped rows above) and
     * sales-side (not by summing per-item revenue) so that two menu items
     * sharing a normalised name cannot count the same money twice.
     *
     * The CASE order is a priority, not a partition of menu items: if a name
     * somehow resolves to both a recipe-less and a recipe-bearing menu item, the
     * money is reported against the HOLE. Understating a gap is the failure mode
     * this report exists to prevent.
     */
    const salesSide = db.prepare(`
      ${SALES_AGG}
      SELECT CASE
               WHEN EXISTS (SELECT 1 FROM menu_items m
                            WHERE LOWER(TRIM(m.name)) = a.norm_name AND COALESCE(m.recipe_id, '') = '')  THEN 'no_recipe'
               WHEN EXISTS (SELECT 1 FROM menu_items m
                            WHERE LOWER(TRIM(m.name)) = a.norm_name)                                     THEN 'with_recipe'
               ELSE 'unmatched_sales'
             END                                   AS bucket,
             COUNT(*)                              AS distinct_names,
             COALESCE(SUM(a.sale_rows), 0)         AS sale_rows,
             COALESCE(SUM(a.units_sold), 0)        AS units_sold,
             COALESCE(SUM(a.revenue), 0)           AS revenue,
             COALESCE(SUM(a.recorded_food_cost), 0) AS recorded_food_cost,
             COALESCE(SUM(a.implausible_cost_rows), 0) AS implausible_cost_rows
      FROM sagg a
      GROUP BY bucket
    `).all(from, to) as any[];

    const side = (b: string) => salesSide.find(r => r.bucket === b) || {};
    const sideTotals = (b: string) => ({
      distinct_sales_names: Number(side(b).distinct_names) || 0,
      sale_rows: Number(side(b).sale_rows) || 0,
      units_sold: round3(side(b).units_sold),
      revenue: round2(side(b).revenue),
      // MEASURED, never assumed to be 0 — see caveats.recorded_food_cost. On
      // the live data this is large AND wrong, and a report that hardcoded 0
      // here would have hidden that.
      recorded_food_cost: round2(side(b).recorded_food_cost),
      implausible_cost_rows: Number(side(b).implausible_cost_rows) || 0,
    });

    /* ── Menu-item counts, by SQL aggregate over the full menu. ────────────── */
    const menuCounts = db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN COALESCE(recipe_id, '') = '' THEN 1 ELSE 0 END), 0) AS no_recipe,
             COALESCE(SUM(CASE WHEN COALESCE(recipe_id, '') <> '' THEN 1 ELSE 0 END), 0) AS with_recipe,
             COALESCE(SUM(CASE WHEN COALESCE(recipe_id, '') = '' AND is_active = 1 THEN 1 ELSE 0 END), 0) AS no_recipe_active,
             COALESCE(SUM(CASE WHEN COALESCE(recipe_id, '') = '' AND COALESCE(material_id, '') <> '' THEN 1 ELSE 0 END), 0) AS no_recipe_direct_linked,
             COUNT(*) AS menu_items_total
      FROM menu_items
    `).get() as any;

    /*
     * The sales attaching CANNOT repair: rows with no recipe_id stamped whose
     * menu item now DOES carry one. Reported as its own figure rather than
     * buried, because it is the direct measure of how much of the past is
     * beyond reach — and it is what stops "we attached the recipes" being heard
     * as "the numbers are fixed now".
     */
    const unrepairable = db.prepare(`
      SELECT COUNT(*)                              AS sale_rows,
             COALESCE(SUM(s.quantity_sold), 0)     AS units_sold,
             COALESCE(SUM(s.total_revenue), 0)     AS revenue
      FROM sales s
      WHERE s.date >= ? AND s.date <= ?
        AND COALESCE(s.recipe_id, '') = ''
        AND EXISTS (SELECT 1 FROM menu_items m
                    WHERE LOWER(TRIM(m.name)) = LOWER(TRIM(s.item_name))
                      AND COALESCE(m.recipe_id, '') <> '')
    `).get(from, to) as any;

    /*
     * RECORDED COST, MEASURED. The brief for this report assumed sales.total_cost
     * is 0 wherever no recipe is attached. It is not: 288 rows carry a cost and
     * 141 of them cost MORE than they sold for.
     *
     * Where it comes from: no sales row carries a recipe_id, so recordSale never
     * computed any of it. sales-import/route.ts has a direct-item fallback that
     * writes raw_materials.average_price * qty when the menu item has a
     * material_id. average_price is Rs per RECIPE unit (the unit canon) while the
     * imported qty is bottles/pieces, so on any packed material the figure is out
     * by the pack size — which is exactly what a cost four times the revenue looks
     * like. See project memory: LPP / average_price mixed-basis trap.
     *
     * This report therefore MEASURES the figure and labels it as not-a-food-cost,
     * rather than printing a hardcoded 0. Do not "simplify" this column back to a
     * constant: the constant would be a lie, and it would hide the unit bug.
     */
    const salesTotals = db.prepare(`
      SELECT COUNT(*) AS sale_rows,
             COALESCE(SUM(CASE WHEN COALESCE(recipe_id, '') = '' THEN 1 ELSE 0 END), 0) AS rows_without_recipe_stamp,
             COALESCE(SUM(CASE WHEN total_cost > 0 THEN 1 ELSE 0 END), 0)               AS rows_with_recorded_cost,
             COALESCE(SUM(CASE WHEN total_cost > total_revenue AND total_cost > 0 THEN 1 ELSE 0 END), 0) AS rows_cost_over_revenue,
             ROUND(COALESCE(SUM(total_cost), 0), 2)                                     AS recorded_cost_total
      FROM sales WHERE date >= ? AND date <= ?
    `).get(from, to) as any;

    const dupNames = db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT LOWER(TRIM(name)) AS nm FROM menu_items GROUP BY nm HAVING COUNT(*) > 1
      )
    `).get() as any;

    /*
     * SUGGESTIONS. Built over ACTIVE recipes only and attached to the no-recipe
     * bucket alone. The matcher is fuzzy and its own header says it errs toward
     * "no match" because a wrong link pulls the wrong food cost into every
     * future sale of that dish.
     *
     * NOTHING IN THIS ROUTE APPLIES A SUGGESTION. It is carried on the row as
     * `suggested_recipe_id` and read by a human; POST accepts only the pairs the
     * caller ticked and never looks at the matcher at all. If a future change
     * makes GET write, or makes POST call buildRecipeMatcher, that change is the
     * bug — see THE ATTACH RULE below.
     */
    const activeRecipes = db.prepare(
      'SELECT id, name FROM recipes WHERE is_active = 1 ORDER BY name'
    ).all() as { id: string; name: string }[];
    const match = buildRecipeMatcher(activeRecipes);

    const mapMenuRow = (r: any, bucket: 'no_recipe' | 'with_recipe'): GapRow => {
      let sug: RecipeMatch | null = null;
      if (bucket === 'no_recipe') {
        try { sug = match(r.menu_item); } catch { sug = null; }
      }
      return {
        bucket,
        menu_item_id: String(r.menu_item_id),
        menu_item: String(r.menu_item ?? ''),
        category: String(r.category ?? ''),
        item_type: String(r.item_type ?? ''),
        is_active: Number(r.is_active) ? 1 : 0,
        selling_price: round2(r.selling_price),
        pos_id: String(r.pos_id ?? ''),
        recipe_id: String(r.recipe_id ?? ''),
        recipe_name: String(r.recipe_name ?? ''),
        direct_material_linked: Number(r.direct_material_linked) ? 1 : 0,
        direct_material: String(r.direct_material ?? ''),
        units_sold: round3(r.units_sold),
        revenue: round2(r.revenue),
        recorded_food_cost: round2(r.recorded_food_cost),
        implausible_cost_rows: Number(r.implausible_cost_rows) || 0,
        sale_rows: Number(r.sale_rows) || 0,
        order_count: Number(r.order_count) || 0,
        last_sold_date: String(r.last_sold_date ?? ''),
        suggested_recipe_id: sug?.id ?? '',
        suggested_recipe: sug?.name ?? '',
        suggestion_score: sug ? sug.score : '',
        suggestion_exact: sug ? (sug.exact ? 1 : 0) : '',
      };
    };

    const no_recipe_rows = noRecipeRaw.map(r => mapMenuRow(r, 'no_recipe'));
    const with_recipe_rows = withRecipeRaw.map(r => mapMenuRow(r, 'with_recipe'));
    const unmatched_rows: GapRow[] = unmatchedRaw.map(r => ({
      ...emptyRow('unmatched_sales'),
      menu_item: String(r.sample_name ?? ''),
      units_sold: round3(r.units_sold),
      revenue: round2(r.revenue),
      recorded_food_cost: round2(r.recorded_food_cost),
      implausible_cost_rows: Number(r.implausible_cost_rows) || 0,
      sale_rows: Number(r.sale_rows) || 0,
      order_count: Number(r.order_count) || 0,
      last_sold_date: String(r.last_sold_date ?? ''),
    }));

    const buckets = {
      no_recipe: {
        label: 'Menu items with NO recipe',
        note: NO_RECIPE_NOTE,
        menu_item_count: Number(menuCounts.no_recipe) || 0,
        menu_item_count_active: Number(menuCounts.no_recipe_active) || 0,
        direct_material_linked_count: Number(menuCounts.no_recipe_direct_linked) || 0,
        sales: sideTotals('no_recipe'),
        rows: no_recipe_rows,
        truncated: no_recipe_rows.length >= limit,
      },
      with_recipe: {
        label: 'Menu items that HAVE a recipe (context only)',
        note: WITH_RECIPE_NOTE,
        menu_item_count: Number(menuCounts.with_recipe) || 0,
        sales: sideTotals('with_recipe'),
        rows: with_recipe_rows,
        truncated: with_recipe_rows.length >= limit,
      },
      unmatched_sales: {
        label: 'Sold, not on the menu master',
        note: UNMATCHED_NOTE,
        sales: sideTotals('unmatched_sales'),
        rows: unmatched_rows,
        truncated: unmatched_rows.length >= limit,
      },
    };

    return Response.json(
      {
        from, to, window_is_default, limit,
        notice: FUTURE_ONLY_NOTICE,
        buckets_are_never_summed: NO_SUM_NOTE,
        buckets,
        unrepairable_sales: {
          label: 'Sales attaching cannot repair',
          note: UNREPAIRABLE_NOTE,
          sale_rows: Number(unrepairable.sale_rows) || 0,
          units_sold: round3(unrepairable.units_sold),
          revenue: round2(unrepairable.revenue),
        },
        caveats: {
          link_basis: 'sales <-> menu_items joined on LOWER(TRIM(name)). sales.pos_item_id is NULL on every row and menu_items.pos_id matches none of them, so no id link exists.',
          duplicate_menu_name_groups: Number(dupNames.n) || 0,
          duplicate_menu_name_effect: 'While this is 0 the per-item rows and the sales-side totals agree exactly. Above 0, two menu items share a name and each row shows the same sales; the bucket totals stay correct because they are computed sales-side.',
          direct_items: 'menu_items.material_id (direct-sell bottles) does NOT cause a deduction on sale — nothing in the sale path reads it. Those rows are flagged direct_material_linked so a food recipe is not attached to a bottle.',
          order_count: 'sales.order_id is NULL on almost every legacy row, so distinct order counts read far lower than the sale-row count.',
          suggestions: 'Candidate recipes are FUZZY NAME MATCHES from src/lib/recipe-matcher.ts. Nothing applies them. POST attaches only the pairs a human ticked.',
          recorded_food_cost:
            'The "cost recorded" figures are MEASURED from sales.total_cost and are NOT recipe food costs. No sales row '
            + 'carries a recipe_id, so recordSale computed none of it; it was written by the sales importer\'s direct-item '
            + 'fallback as raw_materials.average_price x qty. average_price is Rs per RECIPE unit while the imported qty is '
            + 'bottles/pieces, so on packed materials the figure is out by the pack size — which is why some rows record a '
            + 'cost larger than their revenue. Treat this column as a defect count, not as a cost.',
          sales_window: {
            sale_rows: Number(salesTotals.sale_rows) || 0,
            rows_without_recipe_stamp: Number(salesTotals.rows_without_recipe_stamp) || 0,
            rows_with_recorded_cost: Number(salesTotals.rows_with_recorded_cost) || 0,
            rows_recorded_cost_over_revenue: Number(salesTotals.rows_cost_over_revenue) || 0,
            recorded_cost_total: round2(salesTotals.recorded_cost_total),
          },
        },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e: any) {
    console.error('[/api/reports/menu-recipe-gap GET]', e);
    return Response.json({ error: e?.message || 'Failed to build menu recipe gap report' }, { status: 500 });
  }
}

/**
 * CSV. Built from buildJson's output — never from a second set of queries —
 * so a filter or a fix applied to the report reaches the download for free and
 * the two can never disagree about a number.
 *
 * An error (401 / 403 / 400 / 500) is forwarded verbatim as JSON rather than
 * dressed up as a CSV file: a browser that downloads "menu-recipe-gap.csv"
 * containing the word "Management only" is how a permission failure gets
 * mistaken for an empty report.
 */
async function buildCsv(req: Request): Promise<Response> {
  const res = await buildJson(req);
  if (res.status !== 200) return res;
  const data = await res.json() as any;

  const lines: string[] = [COLUMNS.map(c => csvCell(c.header)).join(',')];

  // The notice sits ABOVE the data, in row 2, not in a footer. This file gets
  // opened cold in Excel by someone who never saw the page, and a warning below
  // 600 rows is a warning nobody reads.
  lines.push(captionRow(`READ THIS FIRST — ${FUTURE_ONLY_NOTICE}`));
  lines.push(captionRow(NO_SUM_NOTE));
  lines.push(captionRow(`Window ${data.from} to ${data.to} (IST)${data.window_is_default ? ' — default window: every sale on record' : ''}`));
  lines.push(captionRow(''));

  const push = (rows: GapRow[]) => {
    for (const r of rows) lines.push(COLUMNS.map(c => csvCell(c.cell(r), !!c.numeric)).join(','));
  };

  const b = data.buckets;
  lines.push(captionRow(`BUCKET 1 — ${b.no_recipe.label}: ${b.no_recipe.menu_item_count} menu items (${b.no_recipe.menu_item_count_active} active, ${b.no_recipe.direct_material_linked_count} are direct-material/liquor lines a recipe is the wrong fix for). Sales in window: ${b.no_recipe.sales.sale_rows} rows, ${b.no_recipe.sales.units_sold} units, INR ${b.no_recipe.sales.revenue}, food cost recorded INR ${b.no_recipe.sales.recorded_food_cost}.`));
  push(b.no_recipe.rows);
  if (b.no_recipe.truncated) lines.push(captionRow('!! TRUNCATED — the row limit was reached; this bucket is INCOMPLETE. The bucket totals above are SQL aggregates over the full set and remain correct.'));
  lines.push(captionRow(''));

  lines.push(captionRow(`BUCKET 2 — ${b.with_recipe.label}: ${b.with_recipe.menu_item_count} menu items. Sales in window: ${b.with_recipe.sales.sale_rows} rows, INR ${b.with_recipe.sales.revenue}. CONTEXT ONLY — do not add to Bucket 1.`));
  push(b.with_recipe.rows);
  if (b.with_recipe.truncated) lines.push(captionRow('!! TRUNCATED — the row limit was reached; this bucket is INCOMPLETE.'));
  lines.push(captionRow(''));

  lines.push(captionRow(`BUCKET 3 — ${b.unmatched_sales.label}: ${b.unmatched_sales.sales.distinct_sales_names} distinct sales names, ${b.unmatched_sales.sales.sale_rows} rows, INR ${b.unmatched_sales.sales.revenue}. These match NO menu item by name and cannot be fixed by attaching a recipe. Reported, not dropped. DO NOT add to Bucket 1.`));
  push(b.unmatched_sales.rows);
  if (b.unmatched_sales.truncated) lines.push(captionRow('!! TRUNCATED — the row limit was reached; this bucket is INCOMPLETE.'));
  lines.push(captionRow(''));

  const u = data.unrepairable_sales;
  lines.push(captionRow(`${u.label}: ${u.sale_rows} sale rows, ${u.units_sold} units, INR ${u.revenue}. ${u.note}`));
  lines.push(captionRow(`Menu-item names sharing a normalised name: ${data.caveats.duplicate_menu_name_groups}. ${data.caveats.duplicate_menu_name_effect}`));
  lines.push(captionRow(data.caveats.link_basis));
  lines.push(captionRow(data.caveats.direct_items));
  lines.push(captionRow(data.caveats.recorded_food_cost));
  lines.push(captionRow(`In this window: ${data.caveats.sales_window.sale_rows} sale rows, ${data.caveats.sales_window.rows_without_recipe_stamp} with no recipe stamped, ${data.caveats.sales_window.rows_with_recorded_cost} carrying a recorded cost, of which ${data.caveats.sales_window.rows_recorded_cost_over_revenue} record a cost GREATER than their revenue.`));
  lines.push(captionRow(data.caveats.suggestions));
  lines.push(captionRow(`REMINDER — ${FUTURE_ONLY_NOTICE}`));

  // UTF-8 BOM: without it Excel on Windows decodes the file as ANSI and Indian
  // dish names come out as mojibake. Prepended exactly once, here.
  return new Response('﻿' + lines.join('\r\n'), {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="menu-recipe-gap-${data.from}_${data.to}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * Route entry. Dispatches on format only — every gate, every validation and
 * every query lives in buildJson, so there is no path to the data that skips
 * the management check.
 */
export async function GET(req: Request) {
  try {
    return new URL(req.url).searchParams.get('format') === 'csv'
      ? await buildCsv(req)
      : await buildJson(req);
  } catch (e: any) {
    console.error('[/api/reports/menu-recipe-gap GET dispatch]', e);
    return Response.json({ error: e?.message || 'Failed to build menu recipe gap report' }, { status: 500 });
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * THE ATTACH RULE — POST /api/reports/menu-recipe-gap   (ADMIN ONLY)
 *
 * Applies ONLY the {menu_item_id, recipe_id} pairs the caller sent, which are
 * the pairs a human ticked on the page. This route does not call the matcher,
 * does not read `suggested_recipe_id`, and has no "apply all" path. An
 * unattended fuzzy attach pulls the wrong food cost into EVERY future sale of
 * that dish, silently and permanently, and the matcher's own header says it
 * errs toward no-match for exactly that reason. If you are adding a convenience
 * "accept all suggestions" button, add it in the UI as 600 ticked checkboxes a
 * human can untick — not as a server-side loop over the matcher.
 *
 * THE GUARD IS IN THE SQL, NOT IN THE READ:
 *   UPDATE ... WHERE id = ? AND (recipe_id IS NULL OR recipe_id = '')
 * so an existing link can never be overwritten even if another admin attached
 * one between this request's SELECT and its UPDATE. Do not "simplify" this to
 * `WHERE id = ?` on the grounds that the row was already checked — the check
 * and the write are two statements and the gap between them is real.
 *
 * WHAT THIS ROUTE MUST NEVER TOUCH: sales, order_items, raw_materials,
 * inventory_transactions, recipes, or any stock figure. Attaching a recipe is a
 * pure menu_items.recipe_id write plus an audit row. It does not and must not
 * retro-deduct anything: sales already rung up froze their recipe_id at punch
 * time and repairing them would mean inventing consumption that never happened.
 * ══════════════════════════════════════════════════════════════════════════ */

const MAX_PAIRS = 1000;

type AttachResult = {
  menu_item_id: string;
  recipe_id: string;
  status: 'applied' | 'skipped';
  reason: string;
  menu_item?: string;
  recipe_name?: string;
  existing_recipe_id?: string;
  recipe_is_active?: boolean;
};

export async function POST(req: Request) {
  try {
    // Admin only — stricter than GET's management gate. A recipe link changes
    // what every future sale of the dish deducts from stock.
    const gate = await requireRole('admin');
    if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });
    const actor = gate.user;

    let body: any;
    try { body = await req.json(); } catch { body = null; }
    const pairs = body?.pairs;
    if (!Array.isArray(pairs)) {
      return Response.json({ error: 'Body must be { pairs: [{ menu_item_id, recipe_id }] }.' }, { status: 400 });
    }
    if (pairs.length === 0) {
      return Response.json({ error: 'No pairs supplied. Tick the items to attach first — this route never picks for you.' }, { status: 400 });
    }
    if (pairs.length > MAX_PAIRS) {
      return Response.json({ error: `Too many pairs (${pairs.length}); the cap is ${MAX_PAIRS}. Attach in batches so each one is reviewable.` }, { status: 400 });
    }

    const db = getDb();
    const outletId = await getCurrentOutletId();

    const getMenu = db.prepare('SELECT id, name, recipe_id FROM menu_items WHERE id = ?');
    const getRecipe = db.prepare('SELECT id, name, is_active FROM recipes WHERE id = ?');
    // The guard lives here, in the WHERE clause. See THE ATTACH RULE above.
    const attach = db.prepare(
      "UPDATE menu_items SET recipe_id = ?, updated_at = datetime('now') WHERE id = ? AND (recipe_id IS NULL OR recipe_id = '')"
    );

    const results: AttachResult[] = [];

    // One transaction over the batch: a throw part-way through must not leave
    // half the ticked list attached and the other half silently not, with no
    // way for the caller to tell which.
    const run = db.transaction(() => {
      const seen = new Set<string>();
      for (const raw of pairs) {
        const menu_item_id = String(raw?.menu_item_id ?? '').trim();
        const recipe_id = String(raw?.recipe_id ?? '').trim();

        if (!menu_item_id || !recipe_id) {
          results.push({ menu_item_id, recipe_id, status: 'skipped', reason: 'menu_item_id and recipe_id are both required' });
          continue;
        }
        if (seen.has(menu_item_id)) {
          results.push({ menu_item_id, recipe_id, status: 'skipped', reason: 'duplicate menu_item_id in this request — only the first was considered' });
          continue;
        }
        seen.add(menu_item_id);

        const mi = getMenu.get(menu_item_id) as any;
        if (!mi) {
          results.push({ menu_item_id, recipe_id, status: 'skipped', reason: 'menu item not found' });
          continue;
        }
        const existing = String(mi.recipe_id ?? '');
        if (existing !== '') {
          results.push({
            menu_item_id, recipe_id, status: 'skipped', menu_item: mi.name,
            existing_recipe_id: existing,
            reason: 'menu item already has a recipe — an existing link is never overwritten',
          });
          continue;
        }

        const rc = getRecipe.get(recipe_id) as any;
        if (!rc) {
          results.push({ menu_item_id, recipe_id, status: 'skipped', menu_item: mi.name, reason: 'recipe not found' });
          continue;
        }

        const info = attach.run(recipe_id, menu_item_id);
        if (info.changes !== 1) {
          // Only reachable if the row gained a recipe between the SELECT above
          // and this UPDATE. Reported, never retried — the other write wins.
          results.push({
            menu_item_id, recipe_id, status: 'skipped', menu_item: mi.name, recipe_name: rc.name,
            reason: 'not applied — the item gained a recipe from another request while this one ran',
          });
          continue;
        }

        logAuditEvent(db, {
          event_type: 'menu_item.recipe_attach',
          entity_type: 'menu_item',
          entity_id: menu_item_id,
          actor_email: actor.email,
          outlet_id: outletId,
          before: { recipe_id: null },
          after: { recipe_id },
          note: `Attached recipe "${rc.name}" to menu item "${mi.name}" from the Menu Recipe Gap report (explicitly ticked). Future sales only.`,
        });

        results.push({
          menu_item_id, recipe_id, status: 'applied', menu_item: mi.name, recipe_name: rc.name,
          recipe_is_active: !!rc.is_active,
          reason: rc.is_active ? 'attached' : 'attached — WARNING: this recipe is marked inactive',
        });
      }
    });
    run();

    const applied = results.filter(r => r.status === 'applied').length;
    return Response.json(
      {
        applied,
        skipped: results.length - applied,
        results,
        notice: FUTURE_ONLY_NOTICE,
        wrote: 'menu_items.recipe_id and audit_events only. No sales, order_items, raw_materials or inventory_transactions row was read for writing or changed.',
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e: any) {
    console.error('[/api/reports/menu-recipe-gap POST]', e);
    return Response.json({ error: e?.message || 'Failed to attach recipes' }, { status: 500 });
  }
}
