import { getDb } from '@/lib/db';

/**
 * Comprehensive sales analytics — all aggregations server-side.
 * Handles datasets of any size; one fetch powers the entire page.
 *
 * Query params:
 *   from, to           — ISO dates (YYYY-MM-DD). Required.
 *   bill_type          — optional filter (normal | nc | complimentary)
 *   category           — optional filter
 *   item               — optional LIKE filter on item_name
 */
export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const from = url.searchParams.get('from') || '';
    const to = url.searchParams.get('to') || '';
    const billType = url.searchParams.get('bill_type') || '';
    const category = url.searchParams.get('category') || '';
    const item = url.searchParams.get('item') || '';

    if (!from || !to) {
      return Response.json({ error: 'from and to dates are required' }, { status: 400 });
    }

    // Build shared WHERE clauses
    const whereParts: string[] = ['s.date BETWEEN ? AND ?'];
    const params: any[] = [from, to];
    if (billType) { whereParts.push('s.bill_type = ?'); params.push(billType); }
    if (category) { whereParts.push('s.category = ?'); params.push(category); }
    if (item)     { whereParts.push('s.item_name LIKE ?'); params.push(`%${item}%`); }
    const WHERE = whereParts.join(' AND ');

    // Previous period of equal length (for comparison deltas)
    const fromDate = new Date(from);
    const toDate   = new Date(to);
    const days     = Math.round((toDate.getTime() - fromDate.getTime()) / 86400000) + 1;
    const prevTo   = new Date(fromDate.getTime() - 86400000).toISOString().split('T')[0];
    const prevFrom = new Date(fromDate.getTime() - days * 86400000).toISOString().split('T')[0];

    // ---------- TOTALS (current period) ----------
    const totalsSQL = `
      SELECT
        COUNT(*)                                                   AS line_count,
        COALESCE(SUM(s.quantity_sold), 0)                          AS total_items,
        COUNT(DISTINCT COALESCE(s.order_id, s.date))               AS order_count,
        COALESCE(SUM(s.total_revenue), 0)                          AS total_revenue,
        COALESCE(SUM(s.total_cost), 0)                             AS total_cost,
        COALESCE(SUM(CASE WHEN s.bill_type != 'normal'
                          THEN s.total_cost ELSE 0 END), 0)        AS nc_cost,
        COUNT(CASE WHEN s.bill_type != 'normal' THEN 1 END)        AS nc_count
      FROM sales s
      WHERE ${WHERE}
    `;
    const totals = db.prepare(totalsSQL).get(...params) as any;

    // Previous-period totals (same filters, shifted dates)
    const prevParams = [prevFrom, prevTo, ...params.slice(2)];
    const prevTotals = db.prepare(totalsSQL).get(...prevParams) as any;

    // Avg bill
    const avgBill    = totals.order_count > 0 ? totals.total_revenue / totals.order_count : 0;
    const prevAvgBill = prevTotals.order_count > 0 ? prevTotals.total_revenue / prevTotals.order_count : 0;

    // ---------- DAILY TREND ----------
    const dailyTrend = db.prepare(`
      SELECT s.date AS date,
             COALESCE(SUM(s.total_revenue), 0)                     AS revenue,
             COALESCE(SUM(s.total_cost), 0)                        AS cost,
             COUNT(DISTINCT COALESCE(s.order_id, s.date || '|' || s.id)) AS orders,
             COALESCE(SUM(s.quantity_sold), 0)                     AS items,
             COALESCE(SUM(CASE WHEN s.bill_type != 'normal'
                               THEN s.total_cost ELSE 0 END), 0)   AS nc_cost
      FROM sales s
      WHERE ${WHERE}
      GROUP BY s.date
      ORDER BY s.date ASC
    `).all(...params);

    // ---------- HOURLY × WEEKDAY HEATMAP ----------
    //
    // THE HOUR MUST BE THE HOUR THE GUEST WAS SERVED, NOT THE HOUR WE WROTE THE
    // ROW. The old fallback was `substr(s.created_at, 12, 2)`, i.e. the UTC
    // hour stamped by the importer — so on the live data 1,132 of 1,141 rows
    // (Rs 2,17,48,234 of Rs 2,17,53,044, 99.98% of revenue) piled into a single
    // 09:00 cell that no service ever happened in, and "Peak Hour" read 09:00.
    //
    // Two honest sources, in order:
    //   1. sales.sale_time — 'HH:MM' IST, written by the settle/hold routes
    //      (Asia/Kolkata, hour12:false) and by POS exports that carry a time.
    //   2. the linked order's settled_at, shifted to IST.
    // When NEITHER exists the sale hour is genuinely UNKNOWN. Those rows are
    // EXCLUDED and reported separately as `heatmapUnattributed`, because
    // parking them on an invented hour is what produced the 09:00 wall.
    //
    // dow is taken on the TRADING NIGHT (04:00–04:00 IST, owner ruling
    // 2026-09-23): sales.date is the IST calendar
    // day of the settle, so a 00:30 bill rolls back one day to the night that
    // earned it.
    // The 0..23 guard on branch 1 is load-bearing, not defensive dressing. The
    // .xlsx importer on this very page turns a 23:59:45 bill into sale_time
    // '24:00' (page.tsx rounds the Excel day-fraction to 1440 minutes = hour
    // 24). An unguarded CAST returns 24, which is NOT NULL, so such a row would
    // pass the IS NOT NULL filter below, be counted as PLACED, and then never
    // be drawn — the grid only renders hours 0..23. It would vanish from the
    // grid AND from heatmapUnattributed, drag `max` up so every visible cell
    // washed out to the alpha floor, and win the Peak Hour sort, where
    // hour12(24) prints "12:00 PM" — a near-midnight bill reported as a
    // lunchtime peak. That is the exact lie this block exists to kill.
    //
    // With the guard, an out-of-range sale_time falls through to the settled
    // order, and failing that to NULL, where heatmapUnattributed names it out
    // loud. Branch 2 needs no guard: strftime('%H') is always '00'..'23'.
    const SALE_HOUR = `
      CASE
        WHEN s.sale_time IS NOT NULL AND TRIM(s.sale_time) <> ''
             AND CAST(substr(TRIM(s.sale_time), 1, 2) AS INTEGER) BETWEEN 0 AND 23
             THEN CAST(substr(TRIM(s.sale_time), 1, 2) AS INTEGER)
        WHEN o.settled_at IS NOT NULL
             THEN CAST(strftime('%H', o.settled_at, '+330 minutes') AS INTEGER)
        ELSE NULL
      END`;
    const heatmap = db.prepare(`
      SELECT strftime('%w',
               CASE WHEN (${SALE_HOUR}) < 4 THEN date(s.date, '-1 day') ELSE s.date END
             )                                                     AS dow,
             (${SALE_HOUR})                                        AS hour,
             COALESCE(SUM(s.total_revenue), 0)                     AS revenue,
             COUNT(*)                                              AS count
      FROM sales s
      LEFT JOIN orders o ON o.id = s.order_id
      WHERE ${WHERE} AND (${SALE_HOUR}) IS NOT NULL
      GROUP BY dow, hour
      ORDER BY dow, hour
    `).all(...params);

    // What the heatmap could NOT place, so the screen can say so out loud
    // instead of quietly showing a smaller total than the KPIs above it.
    const heatmapUnattributed = db.prepare(`
      SELECT COUNT(*)                          AS count,
             COALESCE(SUM(s.total_revenue), 0) AS revenue
      FROM sales s
      LEFT JOIN orders o ON o.id = s.order_id
      WHERE ${WHERE} AND (${SALE_HOUR}) IS NULL
    `).get(...params);

    // ---------- CATEGORY MIX ----------
    const byCategory = db.prepare(`
      SELECT COALESCE(NULLIF(s.category, ''), 'Uncategorised') AS category,
             COALESCE(SUM(s.total_revenue), 0)                     AS revenue,
             COALESCE(SUM(s.total_cost), 0)                        AS cost,
             COALESCE(SUM(s.quantity_sold), 0)                     AS items,
             COUNT(*)                                              AS lines
      FROM sales s
      WHERE ${WHERE}
      GROUP BY 1
      ORDER BY revenue DESC
    `).all(...params);

    // ---------- TOP ITEMS ----------
    const topByRevenue = db.prepare(`
      SELECT s.item_name,
             COALESCE(SUM(s.quantity_sold), 0)                     AS qty,
             COALESCE(SUM(s.total_revenue), 0)                     AS revenue,
             COALESCE(SUM(s.total_cost), 0)                        AS cost
      FROM sales s
      WHERE ${WHERE}
      GROUP BY s.item_name
      ORDER BY revenue DESC
      LIMIT 10
    `).all(...params);

    const topByQty = db.prepare(`
      SELECT s.item_name,
             COALESCE(SUM(s.quantity_sold), 0)                     AS qty,
             COALESCE(SUM(s.total_revenue), 0)                     AS revenue
      FROM sales s
      WHERE ${WHERE}
      GROUP BY s.item_name
      ORDER BY qty DESC
      LIMIT 10
    `).all(...params);

    // ---------- NC / LOSS LEADERS ----------
    const topNC = db.prepare(`
      SELECT s.item_name,
             COUNT(*)                                              AS nc_count,
             COALESCE(SUM(s.total_cost), 0)                        AS nc_cost
      FROM sales s
      WHERE ${WHERE} AND s.bill_type != 'normal'
      GROUP BY s.item_name
      ORDER BY nc_cost DESC
      LIMIT 10
    `).all(...params);

    // ---------- PEAKS ----------
    const peakDay  = [...dailyTrend].sort((a: any, b: any) => b.revenue - a.revenue)[0] || null;
    const peakHour = [...heatmap].sort((a: any, b: any) => b.revenue - a.revenue)[0] || null;

    // ---------- AVAILABLE FILTER VALUES ----------
    const categories = db.prepare(`
      SELECT DISTINCT COALESCE(NULLIF(s.category, ''), 'Uncategorised') AS category
      FROM sales s
      LEFT JOIN menu_items mi ON LOWER(mi.name) = LOWER(s.item_name)
      WHERE s.date BETWEEN ? AND ?
      ORDER BY 1
    `).all(from, to);

    return Response.json({
      range: { from, to, days },
      prevRange: { from: prevFrom, to: prevTo },
      totals: {
        ...totals,
        avg_bill: avgBill,
        gross_profit: totals.total_revenue - totals.total_cost,
        gross_margin: totals.total_revenue > 0
          ? ((totals.total_revenue - totals.total_cost) / totals.total_revenue) * 100
          : 0,
      },
      prevTotals: {
        ...prevTotals,
        avg_bill: prevAvgBill,
        gross_profit: prevTotals.total_revenue - prevTotals.total_cost,
        gross_margin: prevTotals.total_revenue > 0
          ? ((prevTotals.total_revenue - prevTotals.total_cost) / prevTotals.total_revenue) * 100
          : 0,
      },
      dailyTrend,
      heatmap,
      heatmapUnattributed,
      byCategory,
      topByRevenue,
      topByQty,
      topNC,
      peakDay,
      peakHour,
      categories: (categories as any[]).map((r: any) => r.category),
    });
  } catch (error: any) {
    console.error('[/api/sales/analytics] error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
