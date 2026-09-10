import type Database from 'better-sqlite3';

/**
 * COST SPIKES — materials whose latest purchase rate is above their own
 * historical average by at least `threshold_pct`.
 *
 * WHY THIS FILE EXISTS. This query used to live inside
 * src/app/api/cost-spikes/route.ts and nowhere else, so the home dashboard's
 * "cost spikes" card was the only thing that could see it. The price-hike
 * WhatsApp alert needs the SAME number: if the alert re-derived its own
 * average, the message and the screen would disagree the first time either
 * definition drifted, and the owner would be told two different percentages for
 * one purchase. The SQL was MOVED here verbatim and the route now calls this
 * function — the route's response is unchanged field for field.
 *
 * THE BASIS, AND THE LABEL TRAP
 * ─────────────────────────────
 * `purchases.unit_price` is rupees per PURCHASE unit (the core convention —
 * see src/lib/pack-units.ts and the vendor-rates endpoint, which says the same
 * thing at more length). Both `avg_price` and `latest_price` are therefore
 * ₹ per purchase unit, and they are directly comparable to each other.
 *
 * `rm.unit` is the RECIPE unit. The original SELECT returned it beside those
 * two prices, which is fine for a screen that only shows the percentage, and
 * wrong the moment anything prints "₹450/kg" — the rate is per CASE, or per
 * 5-kg bag, not per kg. `purchase_unit` and `pack_size` are ADDED here (select
 * list only, no change to the WHERE, the GROUP BY or the row set) so a caller
 * that prints the rate can label it truthfully. `unit` is left exactly as it
 * was so the existing card is untouched.
 *
 * NOT raw_materials.last_purchase_price. That column holds MIXED bases (105
 * rows are recipe-basis, up to 5,000× off) and must never be compared with a
 * purchase-basis figure. See src/lib/closing-valuation.ts.
 *
 * READ-ONLY. Never throws for an empty table — no purchases means no spikes.
 */

export interface CostSpikeRow {
  id: string;
  sku: string;
  name: string;
  /** RECIPE unit. Kept for the existing dashboard card — do NOT label a rate with it. */
  unit: string;
  /** ADDITIVE: the unit `avg_price` / `latest_price` are actually per. */
  purchase_unit: string;
  /** ADDITIVE: recipe units per purchase unit. */
  pack_size: number;
  category: string;
  purchase_count: number;
  /** ₹ per PURCHASE unit, averaged over every purchase of this material. */
  avg_price: number;
  /** ₹ per PURCHASE unit on the most recent purchase. */
  latest_price: number;
  latest_date: string;
  latest_vendor: string;
  /** (latest − avg) ÷ avg × 100, 2dp. */
  pct_change: number;
  /** latest − avg, ₹ per purchase unit, 4dp. */
  abs_change: number;
}

export interface CostSpikeOpts {
  /** Latest must be ≥ avg × (1 + this/100). Default 10. */
  thresholdPct?: number;
  /** Materials with fewer purchases than this are skipped. Default 2. */
  minPurchases?: number;
  /** Row cap. Default 50, hard max 200. */
  limit?: number;
}

export interface CostSpikeResult {
  threshold_pct: number;
  min_purchases: number;
  count: number;
  spikes: CostSpikeRow[];
}

export function costSpikes(db: Database.Database, opts: CostSpikeOpts = {}): CostSpikeResult {
  const thresholdPct = Math.max(0, Number(opts.thresholdPct ?? 10));
  const minPurchases = Math.max(1, Number(opts.minPurchases ?? 2));
  const limit = Math.min(Number(opts.limit ?? 50), 200);
  const factor = 1 + thresholdPct / 100;

  // Per material: avg of unit_price across all purchases vs the most recent unit_price
  const rows = db.prepare(`
    WITH stats AS (
      SELECT material_id,
             COUNT(*)       AS n,
             AVG(unit_price) AS avg_price,
             MAX(date)      AS latest_date
      FROM purchases
      GROUP BY material_id
      HAVING COUNT(*) >= ?
    ),
    latest AS (
      SELECT p.material_id, p.unit_price AS latest_price, p.date AS latest_date, p.vendor
      FROM purchases p
      JOIN (
        SELECT material_id, MAX(date || '|' || created_at) AS k
        FROM purchases GROUP BY material_id
      ) mx ON mx.material_id = p.material_id AND (p.date || '|' || p.created_at) = mx.k
    )
    SELECT rm.id, rm.sku, rm.name, rm.unit, rm.category,
           COALESCE(NULLIF(TRIM(rm.purchase_unit), ''), rm.unit) AS purchase_unit,
           COALESCE(rm.pack_size, 1)                             AS pack_size,
           s.n           AS purchase_count,
           s.avg_price   AS avg_price,
           l.latest_price,
           l.latest_date,
           l.vendor      AS latest_vendor,
           ROUND((l.latest_price - s.avg_price) * 100.0 / NULLIF(s.avg_price, 0), 2) AS pct_change,
           ROUND( l.latest_price - s.avg_price, 4)                                   AS abs_change
    FROM stats s
    JOIN latest l ON l.material_id = s.material_id
    JOIN raw_materials rm ON rm.id = s.material_id
    WHERE l.latest_price >= s.avg_price * ?
      AND s.avg_price > 0
    ORDER BY pct_change DESC
    LIMIT ?
  `).all(minPurchases, factor, limit) as CostSpikeRow[];

  return { threshold_pct: thresholdPct, min_purchases: minPurchases, count: rows.length, spikes: rows };
}
