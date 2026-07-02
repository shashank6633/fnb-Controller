import { getDb } from '@/lib/db';

export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');

    // Default to last 30 days
    const today = new Date().toISOString().split('T')[0];
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const dateFrom = from || thirtyDaysAgo;
    const dateTo = to || today;

    // Overall totals
    const totals = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN bill_type = 'normal' THEN total_revenue ELSE 0 END), 0) as total_revenue,
        COALESCE(SUM(total_cost), 0) as total_cost,
        COALESCE(SUM(CASE WHEN bill_type = 'normal' THEN total_revenue ELSE 0 END) - SUM(total_cost), 0) as gross_profit,
        COALESCE(SUM(CASE WHEN bill_type IN ('nc', 'comp') THEN total_cost ELSE 0 END), 0) as nc_loss,
        COALESCE(SUM(quantity_sold), 0) as total_items_sold
      FROM sales
      WHERE date >= ? AND date <= ?
    `).get(dateFrom, dateTo) as any;

    const grossMargin = totals.total_revenue > 0
      ? Math.round((totals.gross_profit / totals.total_revenue) * 10000) / 100
      : 0;

    // Low stock count
    const lowStockResult = db.prepare(`
      SELECT COUNT(*) as count FROM raw_materials WHERE reorder_level > 0 AND current_stock < reorder_level
    `).get() as any;

    // Active recipes count
    const activeRecipesResult = db.prepare(`
      SELECT COUNT(*) as count FROM recipes WHERE is_active = 1
    `).get() as any;

    // Daily trends (last 30 days)
    const dailyTrend = db.prepare(`
      SELECT
        date,
        SUM(CASE WHEN bill_type = 'normal' THEN total_revenue ELSE 0 END) as revenue,
        SUM(total_cost) as cost,
        SUM(CASE WHEN bill_type = 'normal' THEN total_revenue ELSE 0 END) - SUM(total_cost) as profit
      FROM sales
      WHERE date >= ? AND date <= ?
      GROUP BY date
      ORDER BY date ASC
    `).all(dateFrom, dateTo);

    // Top 10 sellers
    const topSellers = db.prepare(`
      SELECT
        item_name as name,
        SUM(quantity_sold) as quantity,
        SUM(CASE WHEN bill_type = 'normal' THEN total_revenue ELSE 0 END) as revenue
      FROM sales
      WHERE date >= ? AND date <= ?
      GROUP BY item_name
      ORDER BY quantity DESC
      LIMIT 10
    `).all(dateFrom, dateTo);

    // Most profitable items
    const mostProfitable = db.prepare(`
      SELECT
        item_name as name,
        SUM(CASE WHEN bill_type = 'normal' THEN total_revenue ELSE 0 END) - SUM(total_cost) as profit,
        CASE WHEN SUM(CASE WHEN bill_type = 'normal' THEN total_revenue ELSE 0 END) > 0
          THEN ROUND((SUM(CASE WHEN bill_type = 'normal' THEN total_revenue ELSE 0 END) - SUM(total_cost)) / SUM(CASE WHEN bill_type = 'normal' THEN total_revenue ELSE 0 END) * 100, 2)
          ELSE 0 END as margin
      FROM sales
      WHERE date >= ? AND date <= ?
      GROUP BY item_name
      ORDER BY profit DESC
      LIMIT 10
    `).all(dateFrom, dateTo);

    // Loss-making items
    const lossMakers = db.prepare(`
      SELECT
        item_name as name,
        SUM(CASE WHEN bill_type = 'normal' THEN total_revenue ELSE 0 END) - SUM(total_cost) as profit,
        CASE WHEN SUM(CASE WHEN bill_type = 'normal' THEN total_revenue ELSE 0 END) > 0
          THEN ROUND(SUM(total_cost) / SUM(CASE WHEN bill_type = 'normal' THEN total_revenue ELSE 0 END) * 100, 2)
          ELSE 0 END as food_cost_percent
      FROM sales
      WHERE date >= ? AND date <= ?
      GROUP BY item_name
      HAVING profit < 0
      ORDER BY profit ASC
    `).all(dateFrom, dateTo);

    // Category breakdown
    const categoryBreakdown = db.prepare(`
      SELECT
        COALESCE(r.category, 'uncategorized') as category,
        SUM(CASE WHEN s.bill_type = 'normal' THEN s.total_revenue ELSE 0 END) as revenue,
        SUM(s.total_cost) as cost
      FROM sales s
      LEFT JOIN recipes r ON s.recipe_id = r.id
      WHERE s.date >= ? AND s.date <= ?
      GROUP BY r.category
      ORDER BY revenue DESC
    `).all(dateFrom, dateTo);

    // NC impact over time
    const ncImpact = db.prepare(`
      SELECT
        date,
        SUM(CASE WHEN bill_type IN ('nc', 'comp') THEN total_cost ELSE 0 END) as nc_cost,
        SUM(CASE WHEN bill_type IN ('nc', 'comp') THEN 1 ELSE 0 END) as nc_count
      FROM sales
      WHERE date >= ? AND date <= ?
      GROUP BY date
      HAVING nc_count > 0
      ORDER BY date ASC
    `).all(dateFrom, dateTo);

    // Monthly Purchase vs Sale comparison
    const purchaseVsSale = db.prepare(`
      SELECT
        month,
        COALESCE(purchase_total, 0) as purchase_total,
        COALESCE(sale_revenue, 0) as sale_revenue,
        COALESCE(sale_cost, 0) as sale_cost,
        COALESCE(sale_revenue, 0) - COALESCE(purchase_total, 0) as net_difference
      FROM (
        SELECT DISTINCT month FROM (
          SELECT substr(date, 1, 7) as month FROM purchases WHERE date >= ? AND date <= ?
          UNION
          SELECT substr(date, 1, 7) as month FROM sales WHERE date >= ? AND date <= ?
        )
      ) months
      LEFT JOIN (
        SELECT substr(date, 1, 7) as month, SUM(total_price) as purchase_total
        FROM purchases
        WHERE date >= ? AND date <= ?
        GROUP BY substr(date, 1, 7)
      ) p USING (month)
      LEFT JOIN (
        SELECT substr(date, 1, 7) as month,
          SUM(CASE WHEN bill_type = 'normal' THEN total_revenue ELSE 0 END) as sale_revenue,
          SUM(total_cost) as sale_cost
        FROM sales
        WHERE date >= ? AND date <= ?
        GROUP BY substr(date, 1, 7)
      ) s USING (month)
      ORDER BY month ASC
    `).all(dateFrom, dateTo, dateFrom, dateTo, dateFrom, dateTo, dateFrom, dateTo);

    // Total purchase spend
    const purchaseTotals = db.prepare(`
      SELECT
        COALESCE(SUM(total_price), 0) as total_purchase_spend,
        COUNT(*) as total_purchase_count
      FROM purchases
      WHERE date >= ? AND date <= ?
    `).get(dateFrom, dateTo) as any;

    // Category-wise purchase breakdown
    const purchaseByCategory = db.prepare(`
      SELECT
        rm.category,
        SUM(p.total_price) as spend,
        SUM(p.quantity) as quantity
      FROM purchases p
      JOIN raw_materials rm ON p.material_id = rm.id
      WHERE p.date >= ? AND p.date <= ?
      GROUP BY rm.category
      ORDER BY spend DESC
    `).all(dateFrom, dateTo);

    // Top purchased materials
    const topPurchased = db.prepare(`
      SELECT
        rm.name,
        SUM(p.total_price) as total_spend,
        SUM(p.quantity) as total_qty,
        rm.unit
      FROM purchases p
      JOIN raw_materials rm ON p.material_id = rm.id
      WHERE p.date >= ? AND p.date <= ?
      GROUP BY p.material_id
      ORDER BY total_spend DESC
      LIMIT 10
    `).all(dateFrom, dateTo);

    // Stock alerts
    const stockAlerts = db.prepare(`
      SELECT
        id as material_id,
        name as material_name,
        current_stock,
        reorder_level,
        unit,
        ROUND(reorder_level - current_stock, 2) as deficit
      FROM raw_materials
      WHERE reorder_level > 0 AND current_stock < reorder_level
      ORDER BY (reorder_level - current_stock) DESC
    `).all();

    // Consumption trends (top 10 consumed materials)
    const consumptionTrend = db.prepare(`
      SELECT
        rm.name as material,
        COALESCE(ABS(SUM(CASE WHEN it.quantity < 0 THEN it.quantity ELSE 0 END)), 0) as consumed,
        rm.current_stock as remaining
      FROM raw_materials rm
      LEFT JOIN inventory_transactions it ON it.material_id = rm.id
        AND it.created_at >= ? AND it.created_at <= ?
      GROUP BY rm.id
      ORDER BY consumed DESC
      LIMIT 15
    `).all(dateFrom, dateTo + 'T23:59:59');

    return Response.json({
      total_revenue: totals.total_revenue,
      total_cost: totals.total_cost,
      gross_profit: totals.gross_profit,
      gross_margin: grossMargin,
      nc_loss: totals.nc_loss,
      total_items_sold: totals.total_items_sold,
      low_stock_count: lowStockResult.count,
      active_recipes: activeRecipesResult.count,
      daily_trend: dailyTrend,
      top_sellers: topSellers,
      most_profitable: mostProfitable,
      loss_makers: lossMakers,
      category_breakdown: categoryBreakdown,
      nc_impact: ncImpact,
      stock_alerts: stockAlerts,
      consumption_trend: consumptionTrend,
      purchase_vs_sale: purchaseVsSale,
      total_purchase_spend: purchaseTotals.total_purchase_spend,
      total_purchase_count: purchaseTotals.total_purchase_count,
      purchase_by_category: purchaseByCategory,
      top_purchased: topPurchased,
    });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
