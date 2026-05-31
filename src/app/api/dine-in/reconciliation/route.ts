import { getDb } from '@/lib/db';
import { getCurrentOutletId } from '@/lib/auth';
import type { NextRequest } from 'next/server';

/**
 * Dine-In Reconciliation — surfaces every break in the chain:
 *   POS sales row → menu_item → recipe → ingredients with cost
 *
 * When ANY arrow breaks, food cost % silently lies. Each category here is
 * one specific kind of break, with the qty/revenue impact attached so you
 * can prioritise. Always scoped to DINE_IN (PARTY items excluded server-side)
 * and the current outlet.
 *
 * Categories:
 *   1. unmatched_sales  — POS rows with no menu_item link at all
 *   2. menu_no_recipe   — menu items linked from sales but no recipe / no direct material
 *   3. empty_recipes    — recipes with zero ingredients yet linked to selling menu items
 *   4. zero_cost_recipes — recipes with ingredients but total_cost = 0 (priceless materials)
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

// PARTY classification predicate, mirrored from /api/reports.
const PARTY_PREDICATE = `(s.item_name LIKE '% P' OR LOWER(s.category) IN ('party package','custom'))`;
const NOT_PARTY = `NOT ${PARTY_PREDICATE}`;

const isoDaysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};
const todayISO = () => new Date().toISOString().slice(0, 10);

/** Token-based Jaccard similarity on lowercased whitespace tokens. */
function jaccard(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const tb = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common += 1;
  const unique = new Set<string>([...ta, ...tb]);
  return common / unique.size;
}

interface MenuRow {
  id: string;
  name: string;
  recipe_id: string | null;
  material_id: string | null;
  category: string;
  item_code: string;
  pos_id: string;
  selling_price: number;
}

interface UnmatchedSale {
  item_name: string;
  qty_sold: number;
  revenue: number;
  line_count: number;
  suggested_match: { menu_item_id: string; name: string; score: number } | null;
}

interface MenuNoRecipe {
  id: string;
  name: string;
  category: string;
  sales_qty: number;
  sales_revenue: number;
  item_code: string;
  suggested_action: 'add_recipe' | 'mark_direct';
}

interface EmptyRecipe {
  recipe_id: string;
  recipe_name: string;
  menu_items: string[];
  sales_qty: number;
  sales_revenue: number;
}

interface ZeroCostRecipe {
  recipe_id: string;
  recipe_name: string;
  ingredient_count: number;
  sales_qty: number;
  sales_revenue: number;
  priceless_ingredients: string[];
}

export async function GET(request: NextRequest) {
  try {
    const url = request.nextUrl;
    const from = url.searchParams.get('from') || isoDaysAgo(30);
    const to = url.searchParams.get('to') || todayISO();
    const segment = url.searchParams.get('segment') || 'DINE_IN';
    const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get('limit')) || 200));

    const db = getDb();
    const outletId = await getCurrentOutletId();

    // Base WHERE for sales rows we care about: date-bounded, dine-in only, current outlet.
    // segment param is for safety — only DINE_IN is supported here.
    const segmentClause = segment === 'DINE_IN' ? `AND ${NOT_PARTY}` : '';
    const outletClause = outletId ? `AND s.outlet_id = ?` : '';
    const baseParams: any[] = [from, to];
    if (outletId) baseParams.push(outletId);

    // ---------- Pre-load menu items for matching ----------
    const menuItems = db.prepare(`
      SELECT id, name, recipe_id, material_id, category, item_code, pos_id, selling_price
      FROM menu_items
      WHERE is_active = 1
    `).all() as MenuRow[];

    const menuByLowerName = new Map<string, MenuRow>();
    const menuByPosId = new Map<string, MenuRow>();
    for (const m of menuItems) {
      if (m.name) menuByLowerName.set(m.name.toLowerCase().trim(), m);
      if (m.pos_id) menuByPosId.set(String(m.pos_id), m);
    }

    // direct_item_links — name → material_id (treats "linked-as-direct" as a valid match).
    const directLinks = db.prepare(`
      SELECT item_name, material_id, dismissed
      FROM direct_item_links
    `).all() as any[];
    const directLinkByName = new Map<string, { material_id: string | null; dismissed: number }>();
    for (const d of directLinks) {
      directLinkByName.set(String(d.item_name).toLowerCase().trim(), {
        material_id: d.material_id || null,
        dismissed: d.dismissed || 0,
      });
    }

    // ---------- Aggregate sales rows in window ----------
    const salesAgg = db.prepare(`
      SELECT
        s.item_name,
        s.pos_item_id,
        SUM(s.quantity_sold) AS qty_sold,
        SUM(s.total_revenue) AS revenue,
        COUNT(*) AS line_count
      FROM sales s
      WHERE s.date >= ? AND s.date <= ?
        ${segmentClause}
        ${outletClause}
      GROUP BY LOWER(TRIM(s.item_name)), s.pos_item_id
    `).all(...baseParams) as any[];

    // Classify each sales aggregate as: unmatched | menu(linked to id)
    type Resolved = {
      item_name: string;
      qty: number;
      revenue: number;
      line_count: number;
      menu_id: string | null;     // matched menu_item id, if any
      menu_recipe_id: string | null;
      menu_material_id: string | null;
      direct_material_id: string | null; // resolved via direct_item_links
    };
    const resolved: Resolved[] = [];
    const unmatchedAgg = new Map<string, { item_name: string; qty: number; revenue: number; line_count: number }>();

    for (const r of salesAgg) {
      const name = String(r.item_name || '');
      const lower = name.toLowerCase().trim();
      const qty = Number(r.qty_sold) || 0;
      const revenue = Number(r.revenue) || 0;
      const lines = Number(r.line_count) || 0;

      // Try (a) name match, (b) pos_item_id match.
      let m = menuByLowerName.get(lower) || null;
      if (!m && r.pos_item_id) m = menuByPosId.get(String(r.pos_item_id)) || null;

      // (c) direct_item_links — counts as "linked", even without a menu_items row.
      const dl = directLinkByName.get(lower) || null;
      const directMatId = dl && !dl.dismissed ? dl.material_id : null;

      if (!m && !directMatId) {
        // Truly unmatched. Aggregate by item_name (case-insensitive).
        const prev = unmatchedAgg.get(lower);
        if (prev) {
          prev.qty += qty;
          prev.revenue += revenue;
          prev.line_count += lines;
        } else {
          unmatchedAgg.set(lower, { item_name: name, qty, revenue, line_count: lines });
        }
        continue;
      }

      resolved.push({
        item_name: name,
        qty, revenue, line_count: lines,
        menu_id: m?.id || null,
        menu_recipe_id: m?.recipe_id || null,
        menu_material_id: m?.material_id || null,
        direct_material_id: directMatId,
      });
    }

    // ---------- 1. unmatched_sales ----------
    const unmatched_sales: UnmatchedSale[] = Array.from(unmatchedAgg.values())
      .map(u => {
        // Token-based fuzzy match against active menu items.
        let best: { menu_item_id: string; name: string; score: number } | null = null;
        for (const m of menuItems) {
          const score = jaccard(u.item_name, m.name);
          if (score > 0.5 && (!best || score > best.score)) {
            best = { menu_item_id: m.id, name: m.name, score: Math.round(score * 100) / 100 };
          }
        }
        return {
          item_name: u.item_name,
          qty_sold: Math.round(u.qty * 100) / 100,
          revenue: Math.round(u.revenue),
          line_count: u.line_count,
          suggested_match: best,
        };
      })
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, limit);

    // ---------- 2. menu_no_recipe ----------
    // menu_items linked from resolved sales but no recipe AND no material AND no direct link.
    const menuAgg = new Map<string, { qty: number; revenue: number }>();
    for (const r of resolved) {
      if (!r.menu_id) continue;
      const prev = menuAgg.get(r.menu_id);
      if (prev) {
        prev.qty += r.qty;
        prev.revenue += r.revenue;
      } else {
        menuAgg.set(r.menu_id, { qty: r.qty, revenue: r.revenue });
      }
    }

    const menuById = new Map(menuItems.map(m => [m.id, m]));
    const menu_no_recipe: MenuNoRecipe[] = [];
    for (const [id, agg] of menuAgg) {
      const m = menuById.get(id);
      if (!m) continue;
      if (m.recipe_id || m.material_id) continue;
      // Skip if a direct_item_link already resolves it.
      const dl = directLinkByName.get(m.name.toLowerCase().trim());
      if (dl && !dl.dismissed && dl.material_id) continue;

      // Heuristic: liquor/beverage categories tend to be "direct" sales (bottle/can),
      // food categories tend to need recipes. Use category to suggest action.
      const cat = String(m.category || '').toLowerCase();
      const looksDirect = /liquor|beverage|cigar|bottle|can|water|soft/.test(cat);
      menu_no_recipe.push({
        id: m.id,
        name: m.name,
        category: m.category,
        sales_qty: Math.round(agg.qty * 100) / 100,
        sales_revenue: Math.round(agg.revenue),
        item_code: m.item_code || '',
        suggested_action: looksDirect ? 'mark_direct' : 'add_recipe',
      });
    }
    menu_no_recipe.sort((a, b) => b.sales_revenue - a.sales_revenue);
    const menu_no_recipe_capped = menu_no_recipe.slice(0, limit);

    // ---------- Recipe-level aggregations ----------
    // recipe_id → { qty, revenue, menu_names[] }
    const recipeAgg = new Map<string, { qty: number; revenue: number; menu_names: Set<string> }>();
    for (const r of resolved) {
      if (!r.menu_recipe_id) continue;
      const prev = recipeAgg.get(r.menu_recipe_id);
      if (prev) {
        prev.qty += r.qty;
        prev.revenue += r.revenue;
        prev.menu_names.add(r.item_name);
      } else {
        recipeAgg.set(r.menu_recipe_id, {
          qty: r.qty, revenue: r.revenue, menu_names: new Set([r.item_name]),
        });
      }
    }

    // Pull recipe metadata for any recipe with sales.
    const recipeIds = Array.from(recipeAgg.keys());
    const recipeRows = recipeIds.length === 0 ? [] : (db.prepare(`
      SELECT r.id, r.name, r.total_cost,
             (SELECT COUNT(*) FROM recipe_ingredients WHERE recipe_id = r.id) AS ing_count,
             (SELECT COUNT(*) FROM recipe_sub_recipes WHERE recipe_id = r.id) AS sub_count
      FROM recipes r
      WHERE r.id IN (${recipeIds.map(() => '?').join(',')})
    `).all(...recipeIds) as any[]);
    const recipeById = new Map(recipeRows.map((r: any) => [r.id, r]));

    // ---------- 3. empty_recipes ----------
    const empty_recipes: EmptyRecipe[] = [];
    for (const [rid, agg] of recipeAgg) {
      const r = recipeById.get(rid);
      if (!r) continue;
      if (r.ing_count > 0 || r.sub_count > 0) continue;
      empty_recipes.push({
        recipe_id: r.id,
        recipe_name: r.name,
        menu_items: Array.from(agg.menu_names),
        sales_qty: Math.round(agg.qty * 100) / 100,
        sales_revenue: Math.round(agg.revenue),
      });
    }
    empty_recipes.sort((a, b) => b.sales_revenue - a.sales_revenue);
    const empty_recipes_capped = empty_recipes.slice(0, limit);

    // ---------- 4. zero_cost_recipes ----------
    const zero_cost_recipes: ZeroCostRecipe[] = [];
    for (const [rid, agg] of recipeAgg) {
      const r = recipeById.get(rid);
      if (!r) continue;
      if (r.ing_count === 0 && r.sub_count === 0) continue;   // those are empty_recipes
      if (Number(r.total_cost) > 0) continue;

      // Find priceless ingredients (avg_price = 0) in this recipe (direct ingredients only).
      const priceless = db.prepare(`
        SELECT rm.name
        FROM recipe_ingredients ri
        JOIN raw_materials rm ON rm.id = ri.material_id
        WHERE ri.recipe_id = ?
          AND COALESCE(rm.average_price, 0) = 0
        ORDER BY rm.name
      `).all(rid) as any[];

      zero_cost_recipes.push({
        recipe_id: r.id,
        recipe_name: r.name,
        ingredient_count: Number(r.ing_count) + Number(r.sub_count),
        sales_qty: Math.round(agg.qty * 100) / 100,
        sales_revenue: Math.round(agg.revenue),
        priceless_ingredients: priceless.map(p => p.name),
      });
    }
    zero_cost_recipes.sort((a, b) => b.sales_revenue - a.sales_revenue);
    const zero_cost_recipes_capped = zero_cost_recipes.slice(0, limit);

    // ---------- summary ----------
    // Healthy = sales rows resolved to a menu_item whose recipe has ingredients & cost > 0,
    // OR resolved to a direct material (recipe-less by design).
    const brokenRecipeIds = new Set<string>([
      ...empty_recipes.map(e => e.recipe_id),
      ...zero_cost_recipes.map(z => z.recipe_id),
    ]);
    const brokenMenuIds = new Set<string>(menu_no_recipe.map(m => m.id));

    let healthy_count = 0;
    let healthy_revenue = 0;
    let problematic_revenue = 0;
    for (const r of resolved) {
      const isBroken =
        (r.menu_id && brokenMenuIds.has(r.menu_id)) ||
        (r.menu_recipe_id && brokenRecipeIds.has(r.menu_recipe_id));
      if (isBroken) {
        problematic_revenue += r.revenue;
      } else {
        healthy_count += r.line_count;
        healthy_revenue += r.revenue;
      }
    }
    // Add unmatched sales revenue to problematic.
    for (const u of unmatched_sales) problematic_revenue += u.revenue;

    const by_category = {
      unmatched_sales: unmatched_sales.length,
      menu_no_recipe: menu_no_recipe.length,
      empty_recipes: empty_recipes.length,
      zero_cost_recipes: zero_cost_recipes.length,
    };
    const total_issues =
      by_category.unmatched_sales +
      by_category.menu_no_recipe +
      by_category.empty_recipes +
      by_category.zero_cost_recipes;

    return Response.json({
      date_range: { from, to },
      summary: {
        total_issues,
        by_category,
        healthy_count,
        healthy_revenue: Math.round(healthy_revenue),
        problematic_revenue: Math.round(problematic_revenue),
      },
      unmatched_sales,
      menu_no_recipe: menu_no_recipe_capped,
      empty_recipes: empty_recipes_capped,
      zero_cost_recipes: zero_cost_recipes_capped,
    });
  } catch (e: any) {
    console.error('[dine-in/reconciliation]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
