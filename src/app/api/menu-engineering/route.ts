/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * GET /api/menu-engineering?days=30   (allowed: 7 | 30 | 90, default 30)
 *
 * Classic menu-engineering matrix: popularity × profitability per menu item
 * sold in the window.
 *
 * Gate: admin or HOD (is_head_chef) — financial data (costs/margins), same
 * audience as /api/crm/analyst and party P&L.
 *
 * Conventions (same derivation as crm-analyst-data.ts menuMargins — kept in
 * sync by hand because that module returns capped top/bottom lists, not the
 * full per-item detail this report needs):
 *   - Recipe cost = recipes.total_cost (the stored value the Recipes page
 *     shows, maintained by recalculateRecipeCost on ingredient/price change).
 *   - Sales matched to recipes by item name, case-insensitive + trimmed.
 *   - ₹ rounded to 2dp, quantities to 3dp — never NaN/undefined.
 *
 * Quadrants (window medians as thresholds, >= median = "high"):
 *   STAR      high popularity / high margin%   → promote
 *   PLOWHORSE high popularity / low margin%    → reprice or reduce cost
 *   PUZZLE    low popularity  / high margin%   → promote or reposition
 *   DOG       low popularity  / low margin%    → consider dropping
 *
 * Items sold in the window with NO recipe match (or a recipe with no cost)
 * are returned separately as `uncosted` and are NOT classified.
 */
export const dynamic = 'force-dynamic';

const r2 = (n: unknown): number => Math.round((Number(n) || 0) * 100) / 100;
const r3 = (n: unknown): number => Math.round((Number(n) || 0) * 1000) / 1000;

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Median of a numeric list (already-finite values). 0 for an empty list. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export type Quadrant = 'star' | 'plowhorse' | 'puzzle' | 'dog';

export interface MenuEngineeringItem {
  name: string;
  category: string;
  qty_sold: number;
  revenue: number;
  /** Average realized selling price in the window (revenue ÷ qty). */
  avg_price: number;
  /** Recipe cost ₹/unit (recipes.total_cost). */
  cost_unit: number;
  /** avg_price − cost_unit. */
  margin_unit: number;
  /** margin_unit ÷ avg_price × 100. */
  margin_pct: number;
  /** Total margin contribution ₹ = margin_unit × qty (= revenue − cost×qty). */
  contribution: number;
  quadrant: Quadrant;
}

const ALLOWED_DAYS = [7, 30, 90];

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  // Financial data (costs / margins) — admin or HOD only.
  if (!(me.role === 'admin' || me.is_head_chef)) {
    return Response.json({ error: 'Not authorised' }, { status: 403 });
  }

  try {
    const url = new URL(request.url);
    const requested = Number(url.searchParams.get('days') || 30);
    const days = ALLOWED_DAYS.includes(requested) ? requested : 30;
    const since = daysAgo(days - 1);

    const db = getDb();

    // Sales in the window, aggregated by normalized item name
    // (menuMargins convention: LOWER(TRIM(item_name))).
    const sales = db.prepare(`
      SELECT LOWER(TRIM(item_name)) AS nm,
             MAX(TRIM(item_name))   AS display_name,
             SUM(quantity_sold)     AS qty,
             SUM(total_revenue)     AS rev
      FROM sales
      WHERE date >= ?
      GROUP BY LOWER(TRIM(item_name))
      HAVING SUM(quantity_sold) > 0
    `).all(since) as { nm: string; display_name: string; qty: number; rev: number }[];

    // Active recipes keyed by normalized name — cost source (recipes.total_cost).
    const recipes = db.prepare(`
      SELECT name, COALESCE(NULLIF(category,''),'other') AS category,
             selling_price, total_cost
      FROM recipes
      WHERE COALESCE(is_active,1) = 1
    `).all() as { name: string; category: string; selling_price: number; total_cost: number }[];
    const recipeByName = new Map(
      recipes.map(r => [String(r.name || '').trim().toLowerCase(), r]),
    );

    // Split sold items into costed (classifiable) vs uncosted.
    type Working = Omit<MenuEngineeringItem, 'quadrant'>;
    const working: Working[] = [];
    const uncosted: { name: string; category: string; qty_sold: number; revenue: number; reason: 'no_recipe' | 'no_cost' }[] = [];

    for (const s of sales) {
      const rcp = recipeByName.get(s.nm);
      const qty = Number(s.qty) || 0;
      const rev = Number(s.rev) || 0;
      if (!rcp || !(Number(rcp.total_cost) > 0)) {
        uncosted.push({
          name: rcp?.name || s.display_name,
          category: rcp?.category || 'other',
          qty_sold: r3(qty),
          revenue: r2(rev),
          reason: rcp ? 'no_cost' : 'no_recipe',
        });
        continue;
      }
      const costUnit = Number(rcp.total_cost) || 0;
      const avgPrice = qty > 0 ? rev / qty : 0;
      const marginUnit = avgPrice - costUnit;
      working.push({
        name: rcp.name,
        category: rcp.category,
        qty_sold: r3(qty),
        revenue: r2(rev),
        avg_price: r2(avgPrice),
        cost_unit: r2(costUnit),
        margin_unit: r2(marginUnit),
        margin_pct: avgPrice > 0 ? r2((marginUnit / avgPrice) * 100) : 0,
        contribution: r2(marginUnit * qty),
      });
    }

    // Window medians → quadrant thresholds (>= median counts as "high").
    const medianQty = median(working.map(w => w.qty_sold));
    const medianMarginPct = median(working.map(w => w.margin_pct));

    const items: MenuEngineeringItem[] = working.map(w => {
      const highPop = w.qty_sold >= medianQty;
      const highMargin = w.margin_pct >= medianMarginPct;
      const quadrant: Quadrant = highPop
        ? (highMargin ? 'star' : 'plowhorse')
        : (highMargin ? 'puzzle' : 'dog');
      return { ...w, quadrant };
    });

    items.sort((a, b) => b.contribution - a.contribution);
    uncosted.sort((a, b) => b.revenue - a.revenue);

    const quadrants: Record<Quadrant, MenuEngineeringItem[]> = {
      star: [], plowhorse: [], puzzle: [], dog: [],
    };
    for (const it of items) quadrants[it.quadrant].push(it);

    const latestSale = (db.prepare(`SELECT MAX(date) AS d FROM sales`).get() as any)?.d || null;

    return Response.json({
      days,
      medians: { qty: r3(medianQty), margin_pct: r2(medianMarginPct) },
      items,
      quadrants,
      uncosted,
      freshness: { latest_sale_date: latestSale },
    });
  } catch (e: any) {
    console.error('GET /api/menu-engineering failed:', e);
    return Response.json({ error: e?.message || 'Failed to build menu engineering report' }, { status: 500 });
  }
}
