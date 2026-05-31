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
    // Uses sale_time if present, else falls back to created_at HH
    // strftime('%w', date) gives 0-6 (Sun=0)
    const heatmap = db.prepare(`
      SELECT strftime('%w', s.date)                                AS dow,
             CAST(
               CASE
                 WHEN s.sale_time IS NOT NULL AND s.sale_time != ''
                      THEN substr(s.sale_time, 1, 2)
                 ELSE substr(s.created_at, 12, 2)
               END AS INTEGER
             )                                                     AS hour,
             COALESCE(SUM(s.total_revenue), 0)                     AS revenue,
             COUNT(*)                                              AS count
      FROM sales s
      WHERE ${WHERE}
      GROUP BY dow, hour
      ORDER BY dow, hour
    `).all(...params);

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
