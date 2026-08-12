import { getDb } from '@/lib/db';
import { getCentralStoreCutoverDate } from '@/lib/central-cutover';

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
 *
 * THE CENTRAL-STORE CUTOVER FLOOR. Three things below read
 * closing_stock.variance_value, a figure FROZEN at count time against
 * raw_materials.current_stock. Before a cutover that book had drifted for
 * months, so a pre-cutover count's variance is missing paperwork, not loss —
 * and this feed is the owner's dashboard. All three are gated on `preCutover`
 * (`yesterday` earlier than the cutover date):
 *   1. the per-item "Largest inventory variances" anomalies — not emitted;
 *   2. the ₹ tie-out ANOMALY — not emitted;
 *   3. tie_out.variance_value_total in the PAYLOAD — withheld as null, exactly
 *      as it already is for a non-admin. Gating only the anomaly left the raw
 *      pre-cutover rupee figure on the wire, and the dashboard prints that
 *      field verbatim ("⚠ Off by ₹X"), so drift still read as loss on the one
 *      morning the cutover exists to stop that.
 *
 * WHAT IS DELIBERATELY *NOT* GATED, so nobody "completes" it later:
 * tie_out.balanced. It is a boolean over the same sum, and a boolean has no
 * honest third state here — true would claim the books tie out across a
 * boundary nobody can tie out across, and false is what it already says. The
 * consumer (src/app/page.tsx) already renders the null-₹ case as "Variance
 * flagged (admin review)" rather than a rupee loss, which is the truthful
 * reading. `tie_out.pre_cutover` travels beside it so a second dashboard can
 * tell "withheld because pre-cutover" from "withheld because not an admin".
 *
 * The window is short by construction (yesterday moves) but it covers cutover
 * morning, which is precisely when a wall of drift presented as red "Variance /
 * high" anomalies would do the damage. Unstamped, getCentralStoreCutoverDate
 * returns null, `preCutover` is false and nothing here changes at all.
 *
 * The other four detectors are left alone deliberately, for two different
 * reasons — do not "complete the set". Detectors 1, 2 and 4 read purchases,
 * sales and receiving, never the book the cutover re-bases. Detector 5
 * (materials below reorder level) DOES read raw_materials.current_stock, but it
 * is a reorder alert with no date dimension and no variance figure: a re-based
 * book makes it MORE accurate, not less, so there is nothing there to gate.
 * Expect its output to move on cutover day — that is the correction landing,
 * not a regression.
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
    // Blind count: the closing-count variance (per-item and the ₹ tie-out total)
    // is admin-only — a non-admin must not learn the system figure from the
    // morning anomalies feed on the dashboard.
    const me = await (await import('@/lib/auth')).getCurrentUser();
    const isAdmin = me?.role === 'admin';
    const yesterday = yesterdayISO();
    const sevenAgo = daysAgoISO(7);
    const thirtyAgo = daysAgoISO(30);
    // >= keeps the cutover day itself reportable: the cutover writes no
    // closing_stock row, so a genuine count dated that day still counts.
    const cutoverDate = getCentralStoreCutoverDate(db);
    const preCutover = !!cutoverDate && yesterday < cutoverDate;
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
      SELECT cs.material_id, rm.name, cs.variance, cs.variance_value, rm.unit,
             COALESCE(NULLIF(TRIM(rm.purchase_unit),''), rm.unit) AS purchase_unit,
             COALESCE(rm.pack_size, 1) AS pack_size
      FROM closing_stock cs
      JOIN raw_materials rm ON rm.id = cs.material_id
      WHERE cs.date = ? AND ABS(cs.variance_value) >= 500
      ORDER BY ABS(cs.variance_value) DESC
      LIMIT 5
    `).all(yesterday) as any[];
    // Variance anomalies reveal the per-item system figure ("off by X vs system
    // stock") — admin only, and suppressed for a pre-cutover count date.
    if (isAdmin && !preCutover) for (const v of variances) {
      const tone = v.variance_value < 0 ? 'short' : 'over';
      anomalies.push({
        severity: Math.abs(v.variance_value) > 5000 ? 'high' : 'medium',
        category: 'Variance',
        headline: `${v.name} ${tone} by ₹${Math.round(Math.abs(v.variance_value)).toLocaleString('en-IN')}`,
        // Purchase-basis wording (owner rule) — the stored variance is recipe units.
        detail: (() => {
          const pk = Number(v.pack_size) || 1;
          const isPack = pk > 1 && String(v.unit || '').toLowerCase().trim() !== String(v.purchase_unit || v.unit || '').toLowerCase().trim();
          const q = isPack ? Math.round((v.variance / pk) * 1000) / 1000 : v.variance;
          return `Physical count off by ${q} ${isPack ? v.purchase_unit : v.unit} vs system stock.`;
        })(),
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
    // The tie-out ₹ figure is a closing-count variance total — admin only, and
    // suppressed for a pre-cutover count date.
    if (isAdmin && !preCutover && closingValue > 10000) {
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
        // Variance ₹ total is admin-only AND cutover-floored — the same two
        // conditions the tie-out anomaly above is gated on, because this field
        // is that anomaly's number and a dashboard prints it verbatim.
        variance_value_total: isAdmin && !preCutover ? closingValue : null,
        // NOT gated — see the header. Left as the raw signal because a boolean
        // cannot say "not measurable across the cutover boundary".
        balanced: closingValue < 1000,
        /** Why the ₹ total may be null: yesterday predates the cutover date. */
        pre_cutover: preCutover,
      },
      anomaly_count: anomalies.length,
      anomalies: anomalies.slice(0, 12),
    });
  } catch (e: any) {
    console.error('[anomalies]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
