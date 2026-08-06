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
import { packFactor } from '@/lib/pack-units';

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

/**
 * inventory_transactions types that mean "goods LEFT THE OUTLET" — the only
 * ones a usage rate may be built from. Whitelist, never a blacklist: a new type
 * must be argued into this list, not silently absorbed by it.
 *
 * The type vocabulary actually written by the app is purchase, sale, nc,
 * adjustment, wastage, transfer, requisition_issue, party_issue,
 * party_consumption, party_return, staff_meal_issue, staff_meal_return,
 * butchering_input, butchering_output. Of those:
 *
 *   requisition_issue  EXCLUDED — an INTERNAL store→department transfer. Goods
 *                      moved shelf-to-shelf; the outlet still owns every gram.
 *                      Before the department cutover this row did not exist
 *                      (the deduct was flag-gated), so the unfiltered SUM below
 *                      was harmless. It exists on every issue now, and counting
 *                      it here would (a) double-count against the primary leg
 *                      and (b) smuggle in lines the primary leg deliberately
 *                      drops via REQ_ISSUED — draft / cancelled / chef_rejected
 *                      requisitions. Do not "simplify" it back in.
 *   transfer,          EXCLUDED for the same reason — internal movements. The
 *   party_issue,       party rail's real usage is party_consumption; its issue
 *   party_return       and return legs are transfers around it.
 *   butchering_*       EXCLUDED — a yield conversion, not consumption. Counting
 *                      the input as usage double-books it against the output.
 *   adjustment         EXCLUDED — a count correction (also staff-meal deletes
 *                      and party leftover returns). A correction is not a rate;
 *                      averaging one over 14 days invents a daily burn.
 *   purchase           EXCLUDED — inflow.
 *
 * staff_meal_return and party_return come back POSITIVE, so `quantity < 0`
 * already keeps them out of the sum; the rate is therefore gross-of-returns,
 * exactly as it was before this change.
 */
const OUTFLOW_TX_TYPES = ['sale', 'nc', 'wastage', 'staff_meal_issue', 'party_consumption'] as const;
const OUTFLOW_TX_IN = OUTFLOW_TX_TYPES.map(t => `'${t}'`).join(',');

/**
 * Average daily USE, recipe units/day, over the last N days.
 *
 * BASIS — read this before touching either leg. Every caller divides an ON-HAND
 * figure by this rate, so the two must describe the same pocket of stock:
 *
 *   numerator   outletOnHandMap() = central + everything the departments hold
 *   denominator this map          = the rate at which goods leave the OUTLET
 *
 * A requisition issue appears in the primary leg not as an outflow in its own
 * right but as the best available PROXY for what the kitchen then cooks: only
 * 18 of 628 menu items carry a recipe, so recorded recipe consumption covers
 * almost nothing and the issue rate is the only usage signal most materials
 * have. That proxy is safe against an outlet-wide numerator (issuing does not
 * change it) and unsafe against a central-only one — against central, the same
 * issue event lowers the numerator AND raises the denominator, and a material
 * issued daily grows its own suggested order by (days × daily issue) while the
 * goods sit untouched on the kitchen shelf. That is the trap this pairing
 * exists to close; see outletOnHandMap().
 *
 * MEASURED, so nobody has to re-argue it. Replaying the 2026-04-15..28 issue
 * fortnight against live data and counting materials that trip
 * days_of_stock_left < 7 (the reorder trigger below):
 *
 *   central ÷ issue rate, pre-cutover  (today's shipped numbers)  38, none negative
 *   central ÷ issue rate, post-cutover (the trap, if left alone)  97, 46 negative
 *   outlet  ÷ issue rate, post-cutover (this pairing)             38, none negative
 *
 * Those 59 extra rows are not a shortage — they are one fortnight of goods
 * sitting on the kitchen shelves, and /api/crm/reorder drafts them straight
 * into a purchase order. Total suggested packs come out identical (1069) with
 * and without the fix, which is the real test: the order must not drift upward
 * with elapsed time just because the store keeps issuing.
 */
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
  // Fallback for materials with NO requisition history in the window: measured
  // consumption/loss out of the outlet. Type-whitelisted — see OUTFLOW_TX_TYPES
  // for why an unfiltered "quantity < 0" is now wrong.
  const tx = db.prepare(`
    SELECT material_id AS id, SUM(-quantity) AS qty
    FROM inventory_transactions
    WHERE quantity < 0 AND type IN (${OUTFLOW_TX_IN})
      AND SUBSTR(created_at,1,10) >= ?
    GROUP BY material_id
  `).all(since) as { id: string; qty: number }[];
  for (const row of tx) if (!m.has(row.id) && row.qty > 0) m.set(row.id, row.qty / days);
  return m;
}

/**
 * What the OUTLET holds of each material, recipe units — central store plus
 * every department shelf.
 *
 *   outlet on-hand = raw_materials.current_stock + Σ(signed department ledger)
 *
 * WHY THE SUM IS EXACTLY RIGHT, type by type. department_material_transactions
 * is signed (+ into the department, − out) by contract (src/lib/db.ts, the
 * department ledger block; every writer obeys it — issue-stock postDeptLedger,
 * party-fulfillment 'received', the reconcile route's 'consumed'/'returned').
 * Each movement therefore lands on exactly one side of the identity:
 *
 *   issued / issue_reversal   central ∓q AND dept ±q  → total unchanged (a
 *                             transfer between two of our own shelves)
 *   received / returned       party rail, same mirror → total unchanged
 *   consumption, consumed,    dept −q, central untouched → total falls once
 *   wastage, staff_meal
 *   opening (cutover count)   dept +counted; the admin re-bases central in the
 *                             same action → total = the counted total
 *   adjustment                dept ±delta → total moves by the correction, the
 *                             same way a central adjustment does
 *   purchase / GRN            central +q (no department_id column on
 *                             `purchases` — every receipt lands in the store by
 *                             construction) → total rises once
 *
 * So the total moves ONCE per real event and NEVER on an internal transfer.
 * That is the whole point: reordering must not be triggered by the store handing
 * goods to the kitchen. The liquor carve-out needs no code here — store-mapped
 * materials are skipped by BOTH the central debit and the department credit, so
 * neither term of the sum moves for them and they keep their own TGBCL rail.
 *
 * PROVABLE NO-OP TODAY: the ledger is empty (0 rows), so the sum is 0 and every
 * caller sees raw_materials.current_stock exactly as before.
 */
function outletOnHandMap(db: DB): Map<string, number> {
  const held = new Map<string, number>();
  // Unguarded on purpose: db.ts getDb() calls initializeSchema() on the first
  // connection, and that runs an unconditional CREATE TABLE IF NOT EXISTS for
  // department_material_transactions (db.ts:1251) — no settings flag, no
  // migration gate. It is therefore present before any query here can run, the
  // same guarantee every other table this file names relies on. If that ever
  // becomes conditional, this prepare() throws and takes the whole AI analyst
  // down with it, so move the CREATE, don't gate it.
  for (const row of db.prepare(`
    SELECT material_id AS id, SUM(quantity) AS qty
    FROM department_material_transactions
    GROUP BY material_id
  `).all() as { id: string; qty: number }[]) {
    const q = Number(row.qty) || 0;
    if (q !== 0) held.set(row.id, q);
  }
  return held;
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
  /** CENTRAL store only — raw_materials.current_stock, unchanged meaning. */
  current_stock: number; unit: string; purchase_unit: string | null;
  pack_size: number; reorder_level: number; average_price: number;
  /** Priority stars: 3 = critical, 2 = standard, 1 = low. */
  priority: number;
  /** Σ signed department ledger — what the kitchens hold. 0 before the cutover. */
  dept_held: number;
  /** central + dept_held. The ONLY figure the days-of-cover math may divide. */
  outlet_on_hand: number;
}

function activeMaterials(db: DB): MaterialRow[] {
  const held = outletOnHandMap(db);
  const rows = db.prepare(`
    SELECT id, name, sku, COALESCE(NULLIF(category,''),'other') AS category,
           current_stock, unit, purchase_unit,
           COALESCE(pack_size,1) AS pack_size,
           reorder_level, average_price,
           COALESCE(priority,2) AS priority
    FROM raw_materials
    WHERE COALESCE(is_active,1) = 1
  `).all() as MaterialRow[];
  for (const m of rows) {
    m.dept_held = held.get(m.id) || 0;
    m.outlet_on_hand = (Number(m.current_stock) || 0) + m.dept_held;
  }
  return rows;
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
    // OUTLET on-hand over an OUTLET usage rate — see dailyUseMap's BASIS note.
    // The reorder_level trigger above still reads CENTRAL on purpose: a reorder
    // level is a level for the STORE's own shelf, and it is the owner's number.
    const daysLeft = avg > 0 ? r2(Math.max(0, m.outlet_on_hand) / avg) : null;
    return {
      name: m.name, sku: m.sku || '', category: m.category,
      priority: m.priority,                  // 3★ critical first (see sort)
      current_stock: r3(m.current_stock), unit: m.unit,
      in_purchase_units: purchaseEquivalent(m),
      in_departments: r3(m.dept_held),       // 0 until the department cutover
      outlet_on_hand: r3(m.outlet_on_hand),  // central + departments
      reorder_level: r3(m.reorder_level),
      avg_daily_use_14d: r3(avg),
      days_of_stock_left: daysLeft,          // null = no recent usage recorded
    };
  }).sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority; // 3★ first
    const ax = a.days_of_stock_left == null ? 9e9 : a.days_of_stock_left;
    const bx = b.days_of_stock_left == null ? 9e9 : b.days_of_stock_left;
    return ax - bx;
  }).slice(0, 15);
  return {
    as_of: today(),
    low_stock_count: mats.length,
    critical_3star_count: mats.filter(m => m.priority === 3).length,
    latest_issue_date: latestIssueDate(db),  // if older than 14d, usage averages read 0 (stale data)
    note: 'Materials at/below their reorder level (reorder level is a CENTRAL-store level, so current_stock is what trips it), CRITICAL (priority 3★) first. days_of_stock_left = outlet_on_hand (central + departments) ÷ avg daily use (last 14 days) — goods handed to a kitchen are still ours, so an issue does not shorten cover. null = no recent usage data.',
    rows,
  };
}

export function reorderSuggestions(db: DB) {
  const use = dailyUseMap(db, 14);
  const out: any[] = [];
  for (const m of activeMaterials(db)) {
    const avg = use.get(m.id) || 0;
    // TWO ARMS, TWO BASES, ON PURPOSE.
    //   reorder_level arm — CENTRAL. A reorder level is the level the owner set
    //     for the store's own shelf; it is his number and it is not rebased here.
    //     Leaving it on central is safe against the cutover by measurement, not
    //     by argument: 107 of 929 active materials carry a level at all (1–10),
    //     every one of them already sits at current_stock = 0, so all 107 trip
    //     today. The set is SATURATED — central can only fall further, and a
    //     material with no level (reorder_level = 0) can never enter. So the
    //     cutover cannot add a single row through this arm.
    //   days-of-cover arm — OUTLET (central + departments). Dividing central by
    //     a rate that is driven by issues makes the store handing goods to the
    //     kitchen look like consumption: cover shortens, the 7-day need is
    //     measured against a numerator the issue just emptied, and the order
    //     grows by (elapsed days × daily issue) for goods already on the kitchen
    //     shelf. These rows are drafted straight into a PO, so that is real
    //     money. See dailyUseMap's BASIS note and outletOnHandMap().
    const belowReorder = m.reorder_level > 0 && m.current_stock <= m.reorder_level;
    const daysLeft = avg > 0 ? m.outlet_on_hand / avg : null;
    if (!belowReorder && !(daysLeft != null && daysLeft < 7)) continue;
    const packF = packFactor(m);           // recipe units per purchase unit (1 = no conversion)
    const need7 = avg * 7;                                        // recipe units for 7-day cover
    let packs = Math.ceil(Math.max(0, need7 - m.outlet_on_hand) / packF);
    if (packs <= 0 && belowReorder) {
      // Central top-up to the owner's level — the one place central is right.
      packs = Math.max(1, Math.ceil((m.reorder_level - m.current_stock) / packF));
    }
    if (packs <= 0) continue;
    out.push({
      name: m.name, sku: m.sku || '', category: m.category,
      priority: m.priority,                  // 3★ critical first (see sort)
      current_stock: r3(m.current_stock), unit: m.unit,
      in_departments: r3(m.dept_held),       // 0 until the department cutover
      outlet_on_hand: r3(m.outlet_on_hand),
      avg_daily_use_14d: r3(avg),
      days_of_stock_left: daysLeft == null ? null : r2(daysLeft),
      suggested_order_qty: packs,
      order_unit: m.purchase_unit || m.unit,
      est_cost: r2(packs * packF * m.average_price),   // packs → recipe units × ₹/recipe-unit
    });
  }
  out.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority; // 3★ first
    const ax = a.days_of_stock_left == null ? 9e9 : a.days_of_stock_left;
    const bx = b.days_of_stock_left == null ? 9e9 : b.days_of_stock_left;
    return ax - bx || b.est_cost - a.est_cost;
  });
  return {
    as_of: today(),
    latest_issue_date: latestIssueDate(db),  // if older than 14d, suggestions fall back to reorder-level top-ups
    note: 'Suggested order quantity = ceil((7-day need − outlet_on_hand) ÷ pack factor), in PURCHASE units, for a 7-day cover. outlet_on_hand = central store + what the departments hold, because a requisition issue moves goods between our own shelves and does not consume them. Pack factor = pack_size only when the recipe unit differs from the purchase unit, else 1. est_cost in ₹.',
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

export function varianceReport(db: DB, isAdmin: boolean = false) {
  // Blind count: the system figure + per-item variance are admin-only. Never let
  // a non-admin (e.g. a HOD asking the AI about "variance/theft") get the numbers
  // quoted back — the whole point is that only admins see the expected figure.
  if (!isAdmin) {
    return { latest_count_date: null, rows: [], note: 'Variance detail (system stock vs physical count) is restricted to admins and is not available here.' };
  }
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
  // DEAD STOCK IS AN OUTLET QUESTION, NOT A STORE ONE. The value tested is
  // central + department shelves (ON_HAND below). Two failures this avoids:
  //   · a material issued to a kitchen 40 days ago and never cooked drains
  //     central to 0 after the cutover, so a central-only test would drop it off
  //     the list at the exact moment it became dead — silently.
  //   · it also cannot create a FALSE positive out of a department move: a move
  //     IS a requisition issue, and the first NOT EXISTS already excludes any
  //     material issued inside the window.
  // The idle tests themselves are untouched. Note the second one stays a
  // deliberately BROAD "any negative transaction" — here we want proof of ANY
  // movement, which is the opposite question from dailyUseMap's usage RATE, so
  // it does not take OUTFLOW_TX_TYPES. requisition_issue rows landing in this
  // table after the cutover only reinforce the first test.
  const ON_HAND = `(rm.current_stock + COALESCE((
        SELECT SUM(dmt.quantity) FROM department_material_transactions dmt
        WHERE dmt.material_id = rm.id), 0))`;
  const rows = db.prepare(`
    SELECT rm.name, rm.sku, COALESCE(NULLIF(rm.category,''),'other') AS category,
           ROUND(rm.current_stock, 3) AS current_stock, rm.unit,
           ROUND(${ON_HAND}, 3) AS outlet_on_hand,
           ROUND(${ON_HAND} * rm.average_price, 2) AS stock_value
    FROM raw_materials rm
    WHERE COALESCE(rm.is_active,1) = 1
      AND ${ON_HAND} > 0 AND rm.average_price > 0
      AND ${ON_HAND} * rm.average_price > 500
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
    note: 'Stock worth >₹500 with NO issues or consumption in the last 30 days. Value is OUTLET on-hand (central store + department shelves) × average price, in ₹ — goods parked in a kitchen are still capital sitting idle.',
    rows,
  };
}

/* ── additive views (Daily Digest + Smart Reorder) ─────────────────────── */
/* ADDED for /crm/digest and /crm/reorder. Purely additive — nothing above
 * this block changed, and neither function is registered in ANALYST_VIEWS
 * (the digest/reorder routes import them directly). */

/** Everything waiting on someone's yes — for the morning digest. Lists cap at 8. */
export function pendingApprovals(db: DB) {
  const cnt = (sql: string): number =>
    Number((db.prepare(sql).get() as any)?.n) || 0;

  // 1. Requisitions submitted by departments, waiting on the HOD (chef) inbox.
  const reqSubmitted = db.prepare(`
    SELECT r.req_number, COALESCE(d.name,'(unknown dept)') AS department, r.date,
           (SELECT COUNT(*) FROM requisition_items ri WHERE ri.req_id = r.id) AS items
    FROM requisitions r LEFT JOIN departments d ON d.id = r.department_id
    WHERE r.status = 'submitted'
    ORDER BY r.date DESC, r.created_at DESC LIMIT 8
  `).all() as any[];

  // 2. Approved requisitions sitting in the Store Manager's issue queue.
  const reqStoreQueue = db.prepare(`
    SELECT r.req_number, COALESCE(d.name,'(unknown dept)') AS department, r.date, r.status,
           (SELECT COUNT(*) FROM requisition_items ri WHERE ri.req_id = r.id) AS items
    FROM requisitions r LEFT JOIN departments d ON d.id = r.department_id
    WHERE r.status IN ('chef_approved','mgmt_approved')
    ORDER BY r.date DESC, r.created_at DESC LIMIT 8
  `).all() as any[];

  // 3. Purchase orders awaiting approval. PO status vocabulary (db.ts +
  //    /api/purchase-orders actions): draft | pending | pending_reapproval |
  //    approved | received | rejected | cancelled. "Awaiting approval" =
  //    submitted-but-undecided = pending / pending_reapproval.
  const poAwaiting = db.prepare(`
    SELECT po_number, COALESCE(NULLIF(TRIM(vendor),''),'(no vendor)') AS vendor,
           date, status, ROUND(COALESCE(total_cost,0),2) AS total_cost
    FROM purchase_orders
    WHERE status IN ('pending','pending_reapproval')
    ORDER BY date DESC, created_at DESC LIMIT 8
  `).all() as any[];

  // 4. Guest-quiz links expiring within the next 3 days.
  const expiringLinks = db.prepare(`
    SELECT title, link_code, expires_at, attempt_count, max_attempts
    FROM crm_quiz_links
    WHERE is_active = 1 AND expires_at IS NOT NULL
      AND datetime(expires_at) >= datetime('now')
      AND datetime(expires_at) <= datetime('now','+3 days')
    ORDER BY datetime(expires_at) LIMIT 8
  `).all() as any[];

  return {
    as_of: today(),
    note: 'Items waiting on an approval or about to expire. Counts are totals; lists show the newest 8.',
    requisitions_awaiting_chef: {
      count: cnt(`SELECT COUNT(*) AS n FROM requisitions WHERE status = 'submitted'`),
      rows: reqSubmitted,
    },
    requisitions_in_store_queue: {
      count: cnt(`SELECT COUNT(*) AS n FROM requisitions WHERE status IN ('chef_approved','mgmt_approved')`),
      rows: reqStoreQueue,
    },
    purchase_orders_awaiting_approval: {
      count: cnt(`SELECT COUNT(*) AS n FROM purchase_orders WHERE status IN ('pending','pending_reapproval')`),
      rows: poAwaiting,
    },
    draft_po_count: cnt(`SELECT COUNT(*) AS n FROM purchase_orders WHERE status = 'draft'`),
    quiz_links_expiring_3d: {
      count: cnt(`SELECT COUNT(*) AS n FROM crm_quiz_links
                  WHERE is_active = 1 AND expires_at IS NOT NULL
                    AND datetime(expires_at) >= datetime('now')
                    AND datetime(expires_at) <= datetime('now','+3 days')`),
      rows: expiringLinks,
    },
  };
}

/**
 * Smart Reorder rows — same trigger + qty math as reorderSuggestions (verbatim),
 * but WITH material_id / pack data and vendor + price enrichment so the
 * /crm/reorder page can turn a row straight into a draft-PO line.
 *
 * Per material:
 *   vendors      — pickable options: ACTIVE vendor_contracts (₹/purchase-unit
 *                  from the contract) merged with plain vendor_materials mappings.
 *   preferred    — cheapest active contract's vendor; else the first mapped
 *                  vendor; else null.
 *   unit_price   — ₹/PURCHASE-unit: contract price → last_purchase_price (already
 *                  ₹/PU — same derivation the Requisitions page shows as "Last ₹")
 *                  → average_price (₹/recipe-unit) × packFactor — which is
 *                  pack_size ONLY when the recipe unit differs from the
 *                  purchase unit, else 1.
 */
export function reorderSuggestionsEnriched(db: DB) {
  const use = dailyUseMap(db, 14);

  // Active contracts, cheapest first (ORDER BY makes "first per material" = preferred).
  const contracts = db.prepare(`
    SELECT vc.material_id, vc.vendor_id, v.name AS vendor_name, vc.unit_price
    FROM vendor_contracts vc JOIN vendors v ON v.id = vc.vendor_id
    WHERE vc.is_active = 1 AND vc.valid_from <= date('now')
      AND (vc.valid_to IS NULL OR vc.valid_to >= date('now'))
    ORDER BY vc.unit_price ASC, v.name
  `).all() as { material_id: string; vendor_id: string; vendor_name: string; unit_price: number }[];
  const contractsByMat = new Map<string, typeof contracts>();
  for (const c of contracts) {
    const arr = contractsByMat.get(c.material_id) || [];
    arr.push(c); contractsByMat.set(c.material_id, arr);
  }

  // Plain vendor↔material mappings (no price).
  const mappings = db.prepare(`
    SELECT vm.material_id, vm.vendor_id, v.name AS vendor_name
    FROM vendor_materials vm JOIN vendors v ON v.id = vm.vendor_id
    ORDER BY v.name
  `).all() as { material_id: string; vendor_id: string; vendor_name: string }[];
  const mappingsByMat = new Map<string, typeof mappings>();
  for (const m of mappings) {
    const arr = mappingsByMat.get(m.material_id) || [];
    arr.push(m); mappingsByMat.set(m.material_id, arr);
  }

  // last_purchase_price is ₹/purchase-unit (see /requisitions "PUoM · Last ₹").
  const lastPrice = new Map<string, number>();
  for (const r of db.prepare(`
    SELECT id, last_purchase_price FROM raw_materials WHERE COALESCE(last_purchase_price,0) > 0
  `).all() as { id: string; last_purchase_price: number }[]) {
    lastPrice.set(r.id, r.last_purchase_price);
  }

  const out: any[] = [];
  for (const m of activeMaterials(db)) {
    // ── trigger + suggested qty: IDENTICAL math to reorderSuggestions ──
    // Including the two bases: reorder_level against CENTRAL, days-of-cover and
    // the 7-day need against OUTLET on-hand. Keep the two functions byte-aligned
    // — this is the copy whose rows /api/crm/reorder turns into a draft PO, so a
    // divergence here is the one that spends money.
    const avg = use.get(m.id) || 0;
    const belowReorder = m.reorder_level > 0 && m.current_stock <= m.reorder_level;
    const daysLeft = avg > 0 ? m.outlet_on_hand / avg : null;
    if (!belowReorder && !(daysLeft != null && daysLeft < 7)) continue;
    const pack = m.pack_size > 0 ? m.pack_size : 1;
    // Recipe units per purchase unit — 1 unless pack_size > 1 AND the recipe
    // unit differs from the purchase unit. Both halves matter: "PICKLED GINGER
    // 1.5KG" (unit kg = purchase_unit kg, pack 1.5) has NO conversion. These
    // rows are drafted straight into a PO by /api/crm/reorder, so a wrong
    // factor here becomes a wrong purchases.unit_price.
    const packF = packFactor(m);
    const need7 = avg * 7;
    let packs = Math.ceil(Math.max(0, need7 - m.outlet_on_hand) / packF);
    if (packs <= 0 && belowReorder) {
      // Central top-up to the owner's level — the one place central is right.
      packs = Math.max(1, Math.ceil((m.reorder_level - m.current_stock) / packF));
    }
    if (packs <= 0) continue;

    // ── vendor options + preferred ──
    const matContracts = contractsByMat.get(m.id) || [];
    const matMappings = mappingsByMat.get(m.id) || [];
    const contractPriceByVendor = new Map(matContracts.map(c => [c.vendor_id, r2(c.unit_price)]));
    const seen = new Set<string>();
    const vendorOptions: { vendor_id: string; vendor_name: string; contract_price: number | null }[] = [];
    for (const c of matContracts) {
      if (seen.has(c.vendor_id)) continue;
      seen.add(c.vendor_id);
      vendorOptions.push({ vendor_id: c.vendor_id, vendor_name: c.vendor_name, contract_price: r2(c.unit_price) });
    }
    for (const v of matMappings) {
      if (seen.has(v.vendor_id)) continue;
      seen.add(v.vendor_id);
      vendorOptions.push({ vendor_id: v.vendor_id, vendor_name: v.vendor_name, contract_price: contractPriceByVendor.get(v.vendor_id) ?? null });
    }
    const preferred = matContracts[0]              // cheapest active contract
      ?? matMappings[0]                            // else first plain mapping
      ?? null;                                     // else unassigned

    // ── ₹/purchase-unit ──
    let unitPrice: number;
    let priceSource: 'contract' | 'last_purchase' | 'average';
    if (matContracts[0]) { unitPrice = r2(matContracts[0].unit_price); priceSource = 'contract'; }
    else if (lastPrice.has(m.id)) { unitPrice = r2(lastPrice.get(m.id)); priceSource = 'last_purchase'; }
    // average_price is ₹/RECIPE-unit — ×packF (never ×pack) lifts it to ₹/purchase-unit.
    else { unitPrice = r2(m.average_price * packF); priceSource = 'average'; }

    out.push({
      material_id: m.id,
      name: m.name, sku: m.sku || '', category: m.category,
      priority: m.priority,                  // 3★/2★/1★ — page pre-ticks 3★
      current_stock: r3(m.current_stock), unit: m.unit,
      in_departments: r3(m.dept_held),                 // 0 until the department cutover
      outlet_on_hand: r3(m.outlet_on_hand),            // central + departments
      purchase_unit: m.purchase_unit || m.unit,
      pack_size: pack,
      current_stock_pu: r2(m.current_stock / packF),   // packF = 1 when there is no conversion
      outlet_on_hand_pu: r2(m.outlet_on_hand / packF),
      avg_daily_use_14d: r3(avg),
      days_of_stock_left: daysLeft == null ? null : r2(daysLeft),
      suggested_order_qty: packs,
      order_unit: m.purchase_unit || m.unit,
      unit_price: unitPrice,
      price_source: priceSource,
      preferred_vendor_id: preferred?.vendor_id ?? null,
      preferred_vendor_name: preferred?.vendor_name ?? null,
      vendors: vendorOptions,
      line_estimate: r2(packs * unitPrice),
    });
  }
  out.sort((a, b) => {
    // 3★ critical first — otherwise the 60-row cap below could push a critical
    // material off the page entirely while 2★ rows with usage data fill it.
    if (b.priority !== a.priority) return b.priority - a.priority;
    const ax = a.days_of_stock_left == null ? 9e9 : a.days_of_stock_left;
    const bx = b.days_of_stock_left == null ? 9e9 : b.days_of_stock_left;
    return ax - bx || b.line_estimate - a.line_estimate;
  });
  return {
    as_of: today(),
    latest_issue_date: latestIssueDate(db),
    note: 'Suggested qty = ceil((7-day need − outlet_on_hand) ÷ pack factor), in PURCHASE units, CRITICAL (3★) materials first. outlet_on_hand = current_stock (central store) + in_departments (kitchen shelves) — a requisition issue moves goods between our own shelves, so it must not trigger a purchase. Pack factor = pack_size only when the recipe unit differs from the purchase unit, else 1. unit_price is ₹/purchase-unit (contract → last purchase → average × pack factor).',
    rows: out.slice(0, 60),
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
