import { getDb } from '@/lib/db';

/**
 * Cost-spike detector — ingredients where the latest purchase unit_price exceeds
 * the historical average by ≥ threshold% (default 10%).
 *
 * Query params:
 *   threshold_pct  default 10 (i.e. last >= avg × 1.10)
 *   min_purchases  default 2  (skip materials with only 1 purchase)
 *   limit          default 50
 */
export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const thresholdPct = Math.max(0, Number(url.searchParams.get('threshold_pct') || 10));
    const minPurchases = Math.max(1, Number(url.searchParams.get('min_purchases') || 2));
    const limit        = Math.min(Number(url.searchParams.get('limit') || 50), 200);

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
    `).all(minPurchases, factor, limit);

    return Response.json({
      threshold_pct: thresholdPct,
      min_purchases: minPurchases,
      count: rows.length,
      spikes: rows,
    });
  } catch (error: any) {
    console.error('[/api/cost-spikes] error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
