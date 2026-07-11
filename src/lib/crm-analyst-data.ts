/**
 * AI Analyst — deterministic data-pack builders (NO text-to-SQL).
 *
 * Each view function reads the live DB and returns a compact, JSON-able object
 * the analyst route feeds to the LLM as grounded context. Conventions:
 *   - arrays capped (~15 rows) so the prompt stays small
 *   - ₹ values rounded to 2dp, quantities to 3dp — never NaN/undefined
 *   - PACK FACTOR house rule: requisition_items qty is in ri.unit;
 *     raw_materials.average_price is ₹/RECIPE-unit. Convert with pack_size
 *     ONLY when the line was requested in the material's purchase unit.
 *     The CASE below is copied verbatim from /api/party-events/pnl.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type Database from 'better-sqlite3';

type DB = Database.Database;

/** ₹/qty rounding that always yields a real number. */
const r2 = (n: unknown): number => Math.round((Number(n) || 0) * 100) / 100;
const r3 = (n: unknown): number => Math.round((Number(n) || 0) * 1000) / 1000;

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
const today = (): string => new Date().toISOString().slice(0, 10);

/** House pack-factor CASE (verbatim from src/app/api/party-events/pnl/route.ts). */
const PACK_FACTOR = `(CASE WHEN COALESCE(TRIM(ri.unit),'') <> '' AND ri.unit = rm.purchase_unit
                            AND ri.unit <> rm.unit AND COALESCE(rm.pack_size,1) > 1
                       THEN rm.pack_size ELSE 1 END)`;

/** Requisition lines that represent real store→dept issues. */
const REQ_ISSUED = `ri.quantity_issued > 0 AND r.status NOT IN ('cancelled','chef_rejected','draft')`;
/** Best-known issue date for a line: issue timestamp, else the req date. */
const ISSUE_DATE = `COALESCE(NULLIF(SUBSTR(ri.issued_at,1,10),''), r.date)`;

/* ── shared: average daily use (recipe units/day) over the last N days ── */

function dailyUseMap(db: DB, days = 14): Map<string, number> {
  const since = daysAgo(days - 1);
  const m = new Map<string, number>();
  const rows = db.prepare(`
    SELECT ri.material_id AS id,
           SUM(ri.quantity_issued * ${PACK_FACTOR}) AS qty
    FROM requisition_items ri
    JOIN requisitions r   ON r.id  = ri.req_id
    JOIN raw_materials rm ON rm.id = ri.material_id
    WHERE ${REQ_ISSUED} AND ${ISSUE_DATE} >= ?
    GROUP BY ri.material_id
  `).all(since) as { id: string; qty: number }[];
  for (const row of rows) if (row.qty > 0) m.set(row.id, row.qty / days);
  // Fallback: materials with no requisition history — use negative inventory
  // transactions (sales deductions / wastage / adjustments) as consumption.
  const tx = db.prepare(`
    SELECT material_id AS id, SUM(-quantity) AS qty
    FROM inventory_transactions
    WHERE quantity < 0 AND SUBSTR(created_at,1,10) >= ?
    GROUP BY material_id
  `).all(since) as { id: string; qty: number }[];
  for (const row of tx) if (!m.has(row.id) && row.qty > 0) m.set(row.id, row.qty / days);
  return m;
}

/** Most recent store-issue date on record — lets the AI flag stale data. */
function latestIssueDate(db: DB): string | null {
  const row = db.prepare(`
    SELECT MAX(${ISSUE_DATE}) AS d
    FROM requisition_items ri JOIN requisitions r ON r.id = ri.req_id
    WHERE ${REQ_ISSUED}
  `).get() as any;
  return row?.d || null;
}

interface MaterialRow {
  id: string; name: string; sku: string | null; category: string;
  current_stock: number; unit: string; purchase_unit: string | null;
  pack_size: number; reorder_level: number; average_price: number;
}

function activeMaterials(db: DB): MaterialRow[] {
  return db.prepare(`
    SELECT id, name, sku, COALESCE(NULLIF(category,''),'other') AS category,
           current_stock, unit, purchase_unit,
           COALESCE(pack_size,1) AS pack_size,
           reorder_level, average_price
    FROM raw_materials
    WHERE COALESCE(is_active,1) = 1
  `).all() as MaterialRow[];
}

/** Purchase-unit equivalent of an on-hand qty (null when same unit / no pack). */
function purchaseEquivalent(m: MaterialRow): { qty: number; unit: string } | null {
  if (m.pack_size > 1 && m.purchase_unit && m.purchase_unit.toLowerCase() !== (m.unit || '').toLowerCase()) {
    return { qty: r2(m.current_stock / m.pack_size), unit: m.purchase_unit };
  }
  return null;
}

/* ── views ─────────────────────────────────────────────────────────────── */

export function stockAlerts(db: DB) {
  const use = dailyUseMap(db, 14);
  const mats = activeMaterials(db)
    .filter(m => m.reorder_level > 0 && m.current_stock <= m.reorder_level);
  const rows = mats.map(m => {
    const avg = use.get(m.id) || 0;
    const daysLeft = avg > 0 ? r2(Math.max(0, m.current_stock) / avg) : null;
    return {
      name: m.name, sku: m.sku || '', category: m.category,
      current_stock: r3(m.current_stock), unit: m.unit,
      in_purchase_units: purchaseEquivalent(m),
      reorder_level: r3(m.reorder_level),
      avg_daily_use_14d: r3(avg),
      days_of_stock_left: daysLeft,          // null = no recent usage recorded
    };
  }).sort((a, b) => {
    const ax = a.days_of_stock_left == null ? 9e9 : a.days_of_stock_left;
    const bx = b.days_of_stock_left == null ? 9e9 : b.days_of_stock_left;
    return ax - bx;
  }).slice(0, 15);
  return {
    as_of: today(),
    low_stock_count: mats.length,
    latest_issue_date: latestIssueDate(db),  // if older than 14d, usage averages read 0 (stale data)
    note: 'Materials at/below their reorder level. days_of_stock_left = on-hand ÷ avg daily issued qty (last 14 days). null = no recent usage data.',
    rows,
  };
}

export function reorderSuggestions(db: DB) {
  const use = dailyUseMap(db, 14);
  const out: any[] = [];
  for (const m of activeMaterials(db)) {
    const avg = use.get(m.id) || 0;
    const belowReorder = m.reorder_level > 0 && m.current_stock <= m.reorder_level;
    const daysLeft = avg > 0 ? m.current_stock / avg : null;
    if (!belowReorder && !(daysLeft != null && daysLeft < 7)) continue;
    const pack = m.pack_size > 0 ? m.pack_size : 1;
    const need7 = avg * 7;                                        // recipe units for 7-day cover
    let packs = Math.ceil(Math.max(0, need7 - m.current_stock) / pack);
    if (packs <= 0 && belowReorder) {
      packs = Math.max(1, Math.ceil((m.reorder_level - m.current_stock) / pack));
    }
    if (packs <= 0) continue;
    out.push({
      name: m.name, sku: m.sku || '', category: m.category,
      current_stock: r3(m.current_stock), unit: m.unit,
      avg_daily_use_14d: r3(avg),
      days_of_stock_left: daysLeft == null ? null : r2(daysLeft),
      suggested_order_qty: packs,
      order_unit: m.purchase_unit || m.unit,
      est_cost: r2(packs * pack * m.average_price),
    });
  }
  out.sort((a, b) => {
    const ax = a.days_of_stock_left == null ? 9e9 : a.days_of_stock_left;
    const bx = b.days_of_stock_left == null ? 9e9 : b.days_of_stock_left;
    return ax - bx || b.est_cost - a.est_cost;
  });
  return {
    as_of: today(),
    latest_issue_date: latestIssueDate(db),  // if older than 14d, suggestions fall back to reorder-level top-ups
    note: 'Suggested order quantity = ceil((7-day need − on-hand) ÷ pack size), in PURCHASE units, for a 7-day cover. est_cost in ₹.',
    rows: out.slice(0, 15),
  };
}

export function salesSummary(db: DB) {
  const from14 = daysAgo(13);
  const from7 = daysAgo(6);
  const latest = (db.prepare(`SELECT MAX(date) AS d FROM sales`).get() as any)?.d || null;
  const byDay = (db.prepare(`
    SELECT date,
           ROUND(SUM(total_revenue), 2) AS revenue,
           COUNT(DISTINCT COALESCE(NULLIF(order_id,''), id)) AS orders,
           ROUND(SUM(quantity_sold), 2) AS items_sold
    FROM sales WHERE date >= ?
    GROUP BY date ORDER BY date
  `).all(from14) as any[]).slice(-15);
  const topByRevenue = db.prepare(`
    SELECT item_name, ROUND(SUM(total_revenue),2) AS revenue, ROUND(SUM(quantity_sold),2) AS qty
    FROM sales WHERE date >= ?
    GROUP BY LOWER(TRIM(item_name)) ORDER BY revenue DESC LIMIT 10
  `).all(from7) as any[];
  const topByQty = db.prepare(`
    SELECT item_name, ROUND(SUM(quantity_sold),2) AS qty, ROUND(SUM(total_revenue),2) AS revenue
    FROM sales WHERE date >= ?
    GROUP BY LOWER(TRIM(item_name)) ORDER BY qty DESC LIMIT 10
  `).all(from7) as any[];
  const categorySplit = db.prepare(`
    SELECT COALESCE(NULLIF(category,''),'uncategorised') AS category,
           ROUND(SUM(total_revenue),2) AS revenue, ROUND(SUM(quantity_sold),2) AS qty
    FROM sales WHERE date >= ?
    GROUP BY 1 ORDER BY revenue DESC LIMIT 15
  `).all(from7) as any[];
  return {
    as_of: today(),
    latest_sale_date: latest,   // if older than the window, POS sales have not been uploaded since
    revenue_by_day_last_14d: byDay,
    top10_items_by_revenue_last_7d: topByRevenue,
    top10_items_by_qty_last_7d: topByQty,
    category_split_last_7d: categorySplit,
  };
}

export function foodCost(db: DB) {
  const weeks: any[] = [];
  for (let i = 3; i >= 0; i--) {
    const start = daysAgo(7 * i + 6);
    const end = daysAgo(7 * i);
    const cons = db.prepare(`
      SELECT COALESCE(SUM(ri.quantity_issued * ${PACK_FACTOR} * rm.average_price), 0) AS v
      FROM requisitions r
      JOIN requisition_items ri ON ri.req_id = r.id
      JOIN raw_materials rm     ON rm.id = ri.material_id
      WHERE ${REQ_ISSUED} AND ${ISSUE_DATE} BETWEEN ? AND ?
    `).get(start, end) as any;
    const rev = db.prepare(`
      SELECT COALESCE(SUM(total_revenue), 0) AS v FROM sales WHERE date BETWEEN ? AND ?
    `).get(start, end) as any;
    const consumption = r2(cons?.v);
    const revenue = r2(rev?.v);
    weeks.push({
      week_start: start, week_end: end,
      consumption_value: consumption,
      sales_revenue: revenue,
      food_cost_pct: revenue > 0 ? r2((consumption / revenue) * 100) : null,
    });
  }
  const topMaterials = db.prepare(`
    SELECT rm.name, rm.unit, COALESCE(NULLIF(rm.category,''),'other') AS category,
           ROUND(SUM(ri.quantity_issued * ${PACK_FACTOR}), 3) AS qty_issued,
           ROUND(SUM(ri.quantity_issued * ${PACK_FACTOR} * rm.average_price), 2) AS consumption_value
    FROM requisitions r
    JOIN requisition_items ri ON ri.req_id = r.id
    JOIN raw_materials rm     ON rm.id = ri.material_id
    WHERE ${REQ_ISSUED} AND ${ISSUE_DATE} >= ?
    GROUP BY rm.id ORDER BY consumption_value DESC LIMIT 10
  `).all(daysAgo(6)) as any[];
  return {
    as_of: today(),
    latest_issue_date: latestIssueDate(db),
    latest_sale_date: (db.prepare(`SELECT MAX(date) AS d FROM sales`).get() as any)?.d || null,
    note: 'Consumption = store-issued requisition qty × ₹/recipe-unit (pack-factor adjusted). food_cost_pct = consumption ÷ sales revenue. null % = no sales recorded that week. If the latest dates predate the windows, the data upload is behind.',
    weekly_last_4w: weeks,
    top10_materials_by_consumption_value_last_7d: topMaterials,
  };
}

export function varianceReport(db: DB) {
  const latest = (db.prepare(`SELECT MAX(date) AS d FROM closing_stock`).get() as any)?.d || null;
  if (!latest) {
    return { latest_count_date: null, rows: [], note: 'No closing-stock physical counts recorded yet — variance cannot be computed.' };
  }
  const rows = db.prepare(`
    SELECT rm.name, rm.sku, rm.unit,
           ROUND(cs.system_stock, 3)  AS system_stock,
           ROUND(cs.physical_stock,3) AS physical_stock,
           ROUND(cs.variance, 3)      AS variance,
           ROUND(cs.variance_value,2) AS variance_value
    FROM closing_stock cs
    JOIN raw_materials rm ON rm.id = cs.material_id
    WHERE cs.date = ?
    ORDER BY ABS(cs.variance_value) DESC
    LIMIT 12
  `).all(latest) as any[];
  return {
    latest_count_date: latest,
    note: 'Top absolute variances (system vs physical) on the latest count date. Negative variance_value = stock missing (₹).',
    rows,
  };
}

export function menuMargins(db: DB) {
  const from30 = daysAgo(29);
  // Recipe cost = recipes.total_cost — the SAME stored value the Recipes page
  // shows (maintained by recalculateRecipeCost on every ingredient/price change).
  const recipes = db.prepare(`
    SELECT id, name, COALESCE(NULLIF(category,''),'other') AS category,
           selling_price, total_cost
    FROM recipes
    WHERE COALESCE(is_active,1) = 1 AND selling_price > 0
  `).all() as any[];
  const sales = db.prepare(`
    SELECT LOWER(TRIM(item_name)) AS nm,
           SUM(quantity_sold) AS qty, SUM(total_revenue) AS rev
    FROM sales WHERE date >= ?
    GROUP BY LOWER(TRIM(item_name))
  `).all(from30) as { nm: string; qty: number; rev: number }[];
  const salesByName = new Map(sales.map(s => [s.nm, s]));
  const rows = recipes.map(rcp => {
    const s = salesByName.get(String(rcp.name || '').trim().toLowerCase());
    const margin = rcp.selling_price - rcp.total_cost;
    return {
      name: rcp.name, category: rcp.category,
      selling_price: r2(rcp.selling_price),
      recipe_cost: r2(rcp.total_cost),
      margin: r2(margin),
      margin_pct: rcp.selling_price > 0 ? r2((margin / rcp.selling_price) * 100) : 0,
      qty_sold_30d: r2(s?.qty || 0),
      revenue_30d: r2(s?.rev || 0),
    };
  });
  const byMarginDesc = [...rows].sort((a, b) => b.margin_pct - a.margin_pct);
  return {
    as_of: today(),
    priced_recipe_count: rows.length,
    note: 'Margin = selling price − recipe cost (₹/portion). Sales matched to recipes by item name (case-insensitive), last 30 days.',
    top_by_margin_pct: byMarginDesc.slice(0, 15),
    bottom10_by_margin_pct: byMarginDesc.slice(-10).reverse(),
  };
}

export function purchaseTrends(db: DB) {
  const from30 = daysAgo(29);
  const byCategory = db.prepare(`
    SELECT COALESCE(NULLIF(rm.category,''),'other') AS category,
           ROUND(SUM(p.total_price),2) AS spend, COUNT(*) AS purchase_lines
    FROM purchases p JOIN raw_materials rm ON rm.id = p.material_id
    WHERE p.date >= ?
    GROUP BY 1 ORDER BY spend DESC LIMIT 15
  `).all(from30) as any[];
  const byVendor = db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(p.vendor),''),'(unknown)') AS vendor,
           ROUND(SUM(p.total_price),2) AS spend, COUNT(*) AS purchase_lines
    FROM purchases p
    WHERE p.date >= ?
    GROUP BY 1 ORDER BY spend DESC LIMIT 10
  `).all(from30) as any[];
  // Price jumps: latest purchase price (normalised to ₹/recipe-unit via pack_size)
  // vs the material's rolling average_price — flag >15% above average.
  const jumps = db.prepare(`
    WITH latest AS (
      SELECT p.material_id, p.unit_price, p.vendor, p.date,
             ROW_NUMBER() OVER (PARTITION BY p.material_id ORDER BY p.date DESC, p.created_at DESC) AS rk
      FROM purchases p
    )
    SELECT rm.name, rm.sku, rm.unit, l.vendor, l.date AS last_purchase_date,
           ROUND(l.unit_price / (CASE WHEN COALESCE(rm.pack_size,1) > 1 THEN rm.pack_size ELSE 1 END), 4) AS latest_price_per_recipe_unit,
           ROUND(rm.average_price, 4) AS average_price_per_recipe_unit,
           ROUND(((l.unit_price / (CASE WHEN COALESCE(rm.pack_size,1) > 1 THEN rm.pack_size ELSE 1 END)) / rm.average_price - 1) * 100, 1) AS jump_pct
    FROM latest l
    JOIN raw_materials rm ON rm.id = l.material_id
    WHERE l.rk = 1 AND rm.average_price > 0
      AND (l.unit_price / (CASE WHEN COALESCE(rm.pack_size,1) > 1 THEN rm.pack_size ELSE 1 END)) > rm.average_price * 1.15
    ORDER BY jump_pct DESC LIMIT 10
  `).all() as any[];
  return {
    as_of: today(),
    spend_by_category_last_30d: byCategory,
    spend_by_vendor_top10_last_30d: byVendor,
    price_jumps_gt_15pct: jumps,
    note: 'Prices in ₹ per recipe unit. jump_pct = latest purchase price vs the material rolling average.',
  };
}

export function wastageSummary(db: DB) {
  const from30 = daysAgo(29);
  const total = db.prepare(`
    SELECT COUNT(*) AS entries,
           COALESCE(ROUND(SUM(w.quantity * rm.average_price),2),0) AS value
    FROM wastages w JOIN raw_materials rm ON rm.id = w.material_id
    WHERE w.date >= ?
  `).get(from30) as any;
  const byMaterial = db.prepare(`
    SELECT rm.name, rm.unit,
           ROUND(SUM(w.quantity),3) AS qty,
           ROUND(SUM(w.quantity * rm.average_price),2) AS value,
           COUNT(*) AS entries
    FROM wastages w JOIN raw_materials rm ON rm.id = w.material_id
    WHERE w.date >= ?
    GROUP BY rm.id ORDER BY value DESC LIMIT 10
  `).all(from30) as any[];
  const byReason = db.prepare(`
    SELECT COALESCE(NULLIF(w.reason,''),'unspecified') AS reason,
           ROUND(SUM(w.quantity * rm.average_price),2) AS value, COUNT(*) AS entries
    FROM wastages w JOIN raw_materials rm ON rm.id = w.material_id
    WHERE w.date >= ?
    GROUP BY 1 ORDER BY value DESC LIMIT 10
  `).all(from30) as any[];
  return {
    as_of: today(),
    window: 'last 30 days',
    total_entries: Number(total?.entries) || 0,
    total_value: r2(total?.value),
    top10_by_material: byMaterial,
    by_reason: byReason,
  };
}

export function slowMovers(db: DB) {
  const from30 = daysAgo(29);
  const rows = db.prepare(`
    SELECT rm.name, rm.sku, COALESCE(NULLIF(rm.category,''),'other') AS category,
           ROUND(rm.current_stock, 3) AS current_stock, rm.unit,
           ROUND(rm.current_stock * rm.average_price, 2) AS stock_value
    FROM raw_materials rm
    WHERE COALESCE(rm.is_active,1) = 1
      AND rm.current_stock > 0 AND rm.average_price > 0
      AND rm.current_stock * rm.average_price > 500
      AND NOT EXISTS (
        SELECT 1 FROM requisition_items ri
        JOIN requisitions r ON r.id = ri.req_id
        WHERE ri.material_id = rm.id AND ${REQ_ISSUED} AND ${ISSUE_DATE} >= ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM inventory_transactions it
        WHERE it.material_id = rm.id AND it.quantity < 0
          AND SUBSTR(it.created_at,1,10) >= ?
      )
    ORDER BY stock_value DESC
    LIMIT 12
  `).all(from30, from30) as any[];
  return {
    as_of: today(),
    note: 'Stock worth >₹500 with NO issues or consumption in the last 30 days. stock_value in ₹.',
    rows,
  };
}

/* ── registry the analyst route uses ───────────────────────────────────── */

export const ANALYST_VIEWS = {
  stockAlerts,
  reorderSuggestions,
  salesSummary,
  foodCost,
  varianceReport,
  menuMargins,
  purchaseTrends,
  wastageSummary,
  slowMovers,
} as const;

export type AnalystViewName = keyof typeof ANALYST_VIEWS;
