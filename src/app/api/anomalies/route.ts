import { getDb } from '@/lib/db';

/**
 * Daily anomaly detector. Scans yesterday's data and last-30-day baselines
 * to produce a short, actionable list ("3 things to look at this morning").
 * Heuristics, not ML — but each line is a real-world signal:
 *   - Purchase price spikes (vs 30-day avg)
 *   - Sales volume crashes (vs 7-day avg)
 *   - Inventory variance outliers (top |Δ| by ₹)
 *   - Vendor short-supply incidents (rejections in receiving)
 *   - Materials below reorder level
 *
 * Each anomaly returns a severity + headline + detail + fix_url.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface Anomaly {
  severity: 'high' | 'medium' | 'low';
  category: string;
  headline: string;
  detail: string;
  fix_url: string;
  metric_value?: number;
}

const yesterdayISO = () => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); };
const daysAgoISO = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };

export async function GET() {
  try {
    const db = getDb();
    const yesterday = yesterdayISO();
    const sevenAgo = daysAgoISO(7);
    const thirtyAgo = daysAgoISO(30);
    const anomalies: Anomaly[] = [];

    // 1. Purchase price spikes (yesterday vs 30-day avg)
    const priceSpikes = db.prepare(`
      WITH y AS (
        SELECT material_id, AVG(unit_price) AS price_y
        FROM purchases WHERE date = ?
        GROUP BY material_id
      ),
      base AS (
        SELECT material_id, AVG(unit_price) AS price_30
        FROM purchases WHERE date >= ? AND date < ?
        GROUP BY material_id
        HAVING COUNT(*) >= 2
      )
      SELECT rm.id, rm.name, y.price_y, base.price_30,
             ((y.price_y - base.price_30) / base.price_30 * 100) AS pct_change
      FROM y
      JOIN base ON base.material_id = y.material_id
      JOIN raw_materials rm ON rm.id = y.material_id
      WHERE ABS((y.price_y - base.price_30) / base.price_30) >= 0.15
      ORDER BY ABS(pct_change) DESC
      LIMIT 5
    `).all(yesterday, thirtyAgo, yesterday) as any[];
    for (const r of priceSpikes) {
      const dir = r.pct_change > 0 ? 'up' : 'down';
      anomalies.push({
        severity: Math.abs(r.pct_change) > 30 ? 'high' : 'medium',
        category: 'Price',
        headline: `${r.name} purchase price ${dir} ${Math.abs(Math.round(r.pct_change))}%`,
        detail: `Yesterday avg ₹${Math.round(r.price_y)} vs 30-day avg ₹${Math.round(r.price_30)}`,
        fix_url: `/purchases?material=${r.id}`,
        metric_value: r.pct_change,
      });
    }

    // 2. Sales volume crashes (yesterday revenue vs 7-day baseline)
    const yRev = (db.prepare(`SELECT COALESCE(SUM(total_revenue), 0) AS r FROM sales WHERE date = ?`).get(yesterday) as any)?.r || 0;
    const wkAvg = (db.prepare(`SELECT COALESCE(AVG(daily), 0) AS r FROM (SELECT date, SUM(total_revenue) AS daily FROM sales WHERE date >= ? AND date < ? GROUP BY date)`).get(sevenAgo, yesterday) as any)?.r || 0;
    if (wkAvg > 0 && yRev < wkAvg * 0.6) {
      anomalies.push({
        severity: 'high',
        category: 'Sales',
        headline: `Yesterday revenue ₹${Math.round(yRev).toLocaleString('en-IN')} — ${Math.round((1 - yRev / wkAvg) * 100)}% below 7-day avg`,
        detail: `7-day avg was ₹${Math.round(wkAvg).toLocaleString('en-IN')}. Check if POS sync failed or kitchen was closed.`,
        fix_url: `/sales`,
      });
    } else if (wkAvg > 0 && yRev > wkAvg * 1.5) {
      anomalies.push({
        severity: 'medium',
        category: 'Sales',
        headline: `Yesterday revenue ₹${Math.round(yRev).toLocaleString('en-IN')} — ${Math.round((yRev / wkAvg - 1) * 100)}% above 7-day avg`,
        detail: `Strong day. Check if a duplicate sales import inflated the number.`,
        fix_url: `/sales`,
      });
    }

    // 3. Largest inventory variances (yesterday)
    const variances = db.prepare(`
      SELECT cs.material_id, rm.name, cs.variance, cs.variance_value, rm.unit
      FROM closing_stock cs
      JOIN raw_materials rm ON rm.id = cs.material_id
      WHERE cs.date = ? AND ABS(cs.variance_value) >= 500
      ORDER BY ABS(cs.variance_value) DESC
      LIMIT 5
    `).all(yesterday) as any[];
    for (const v of variances) {
      const tone = v.variance_value < 0 ? 'short' : 'over';
      anomalies.push({
        severity: Math.abs(v.variance_value) > 5000 ? 'high' : 'medium',
        category: 'Variance',
        headline: `${v.name} ${tone} by ₹${Math.round(Math.abs(v.variance_value)).toLocaleString('en-IN')}`,
        detail: `Physical count off by ${v.variance} ${v.unit} vs system stock.`,
        fix_url: `/variance-report`,
        metric_value: v.variance_value,
      });
    }

    // 4. Receiving rejections (yesterday)
    const rejections = db.prepare(`
      SELECT g.grn_number, g.vendor, COUNT(*) AS lines,
             SUM(gi.quantity_rejected * gi.unit_price) AS rej_value
      FROM goods_receipt_note_items gi
      JOIN goods_receipt_notes g ON g.id = gi.grn_id
      WHERE g.date = ? AND gi.quantity_rejected > 0
      GROUP BY g.id
      ORDER BY rej_value DESC
      LIMIT 3
    `).all(yesterday) as any[];
    for (const r of rejections) {
      anomalies.push({
        severity: r.rej_value > 1000 ? 'high' : 'medium',
        category: 'Receiving',
        headline: `${r.vendor} — ${r.lines} line(s) rejected on ${r.grn_number}`,
        detail: `Rejected value ₹${Math.round(r.rej_value).toLocaleString('en-IN')}. Review vendor performance.`,
        fix_url: `/receiving-variance`,
      });
    }

    // 5. Materials below reorder level (any)
    const lowStock = db.prepare(`
      SELECT id, name, current_stock, reorder_level, unit
      FROM raw_materials
      WHERE reorder_level > 0 AND current_stock < reorder_level
      ORDER BY (reorder_level - current_stock) DESC
      LIMIT 5
    `).all() as any[];
    if (lowStock.length > 0) {
      anomalies.push({
        severity: lowStock.length >= 10 ? 'high' : 'medium',
        category: 'Stock',
        headline: `${lowStock.length}+ materials below reorder level`,
        detail: `Top: ${lowStock.slice(0, 3).map(s => s.name).join(', ')}`,
        fix_url: `/inventory?filter=low`,
      });
    }

    // 6. Daily tie-out (Opening + Received − Recipe − Wastage = Expected Closing)
    const tieOut = db.prepare(`
      SELECT
        (SELECT COALESCE(SUM(quantity), 0) FROM inventory_transactions WHERE type='purchase' AND DATE(created_at) = ?) AS received,
        (SELECT COALESCE(SUM(ABS(quantity)), 0) FROM inventory_transactions WHERE type IN ('sale','party','staff_meal') AND DATE(created_at) = ?) AS consumed,
        (SELECT COALESCE(SUM(ABS(quantity)), 0) FROM inventory_transactions WHERE type='wastage' AND DATE(created_at) = ?) AS wasted
    `).get(yesterday, yesterday, yesterday) as any;
    const closingValue = (db.prepare(`SELECT COALESCE(SUM(ABS(variance_value)), 0) AS v FROM closing_stock WHERE date = ?`).get(yesterday) as any)?.v || 0;
    if (closingValue > 10000) {
      anomalies.push({
        severity: 'high',
        category: 'Tie-out',
        headline: `Daily reconciliation off by ₹${Math.round(closingValue).toLocaleString('en-IN')}`,
        detail: `Received ${Math.round(tieOut.received)} · Recipe ${Math.round(tieOut.consumed)} · Wasted ${Math.round(tieOut.wasted)} units across all materials yesterday.`,
        fix_url: `/daily-rollup`,
      });
    }

    // Sort by severity (high first)
    const order = { high: 0, medium: 1, low: 2 };
    anomalies.sort((a, b) => order[a.severity] - order[b.severity]);

    return Response.json({
      date: yesterday,
      tie_out: {
        received: tieOut.received || 0,
        recipe_consumed: tieOut.consumed || 0,
        wasted: tieOut.wasted || 0,
        variance_value_total: closingValue,
        balanced: closingValue < 1000,
      },
      anomaly_count: anomalies.length,
      anomalies: anomalies.slice(0, 12),
    });
  } catch (e: any) {
    console.error('[anomalies]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
