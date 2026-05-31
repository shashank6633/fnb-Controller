import { getDb } from '@/lib/db';

// Department buckets — derived from sales.category via SQL LIKE patterns.
// Mirrors the operational departments in the `departments` table so reports
// can be sliced by who-cooks-what without joining through menu_items.station.
// Patterns must match the case-insensitive `LIKE '%pattern%'` SQL form.
const DEPARTMENT_PATTERNS: Record<string, string[]> = {
  'Bar / Beverages': [
    'beer', 'wine', 'champagne', 'whisk', 'vodka', 'gin', 'rum', 'tequila',
    'cocktail', 'mocktail', 'liqueur', 'bar', 'scotch', 'spirit', 'crush',
    'liquor', 'brandy', 'shooter', 'bitter', 'aperitif', 'sake',
    'soft', 'beverage', 'juice', 'water', 'soda', 'tonic',
  ],
  'Tandoor / Grills': ['tandoor', 'kebab', 'tikka', 'grill', 'sheekh', 'angara', 'live'],
  'Pan-Asian': ['sushi', 'uramaki', 'dimsum', 'dim sum', 'thai', 'chinese', 'oriental', 'hunan', 'asian', 'manchow', 'tom yum', 'basil'],
  'Continental': ['pizza', 'pasta', 'burger', 'sandwich', 'risotto', 'lasagne', 'salad'],
  'Bakery': ['bread', 'naan', 'roti', 'paratha', 'kulcha', 'dessert', 'sweet', 'ice cream', 'kulfi'],
  'Indian Main': ['curry', 'biryani', 'rice', 'dal', 'gravy', 'indian', 'masala', 'gongura', 'telangana', 'shorba'],
  'Small Plates / Snacks': ['small plate', 'starter', 'appetizer', 'snack', 'nibble', 'popcorn', 'fries', 'finger', 'pakod'],
  'Custom / Party': ['custom', 'party', 'package'],
};

// SQL fragment: returns the bucket name for a given category column.
// Uses a CASE WHEN ladder so it can be embedded in any SELECT/WHERE clause.
function deptCaseExpr(catCol: string): string {
  const branches = Object.entries(DEPARTMENT_PATTERNS).map(([dept, pats]) => {
    const cond = pats.map(p => `LOWER(${catCol}) LIKE '%${p.replace(/'/g, "''")}%'`).join(' OR ');
    return `WHEN ${cond} THEN '${dept}'`;
  }).join(' ');
  return `CASE ${branches} ELSE 'Other' END`;
}

export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const period = url.searchParams.get('period') || 'daily';
    const department = url.searchParams.get('department') || '';
    // Segment filter — narrows reports to Dine-In or Party sales only.
    // Detection rule:
    //   PARTY  = item_name ends with " P" (Recaho convention)  OR
    //            category is exactly "Party Package" or "Custom"
    //   DINE-IN = everything else
    // Empty = both segments combined.
    const segment = url.searchParams.get('segment') || '';

    let dateFilter = '';
    const params: any[] = [];
    if (from) {
      dateFilter += ' AND s.date >= ?';
      params.push(from);
    }
    if (to) {
      dateFilter += ' AND s.date <= ?';
      params.push(to);
    }

    // Department filter — applied on the derived dept of s.category.
    const deptExpr = deptCaseExpr('s.category');
    if (department) {
      dateFilter += ` AND ${deptExpr} = ?`;
      params.push(department);
    }

    // Reusable SQL fragments for segment classification.
    const PARTY_PREDICATE = `(s.item_name LIKE '% P' OR LOWER(s.category) IN ('party package','custom'))`;
    const SEGMENT_EXPR    = `CASE WHEN ${PARTY_PREDICATE} THEN 'PARTY' ELSE 'DINE_IN' END`;
    if (segment === 'PARTY')  dateFilter += ` AND ${PARTY_PREDICATE}`;
    if (segment === 'DINE_IN') dateFilter += ` AND NOT ${PARTY_PREDICATE}`;

    // Item-level P&L
    const itemPnL = db.prepare(`
      SELECT
        s.item_name,
        SUM(CASE WHEN s.bill_type = 'normal' THEN s.quantity_sold ELSE 0 END) as quantity_sold,
        SUM(s.total_revenue) as revenue,
        SUM(s.total_cost) as cost,
        SUM(s.total_revenue) - SUM(s.total_cost) as profit,
        CASE WHEN SUM(s.total_revenue) > 0
          THEN ROUND(SUM(s.total_cost) / SUM(s.total_revenue) * 100, 2)
          ELSE 0 END as food_cost_percent,
        SUM(CASE WHEN s.bill_type IN ('nc', 'complimentary') THEN s.quantity_sold ELSE 0 END) as nc_quantity,
        SUM(CASE WHEN s.bill_type IN ('nc', 'complimentary') THEN s.total_cost ELSE 0 END) as nc_cost
      FROM sales s
      WHERE 1=1 ${dateFilter}
      GROUP BY s.item_name
      ORDER BY revenue DESC
    `).all(...params) as any[];

    // Period aggregation
    let periodGroup: string;
    switch (period) {
      case 'weekly':
        periodGroup = "strftime('%Y-W%W', s.date)";
        break;
      case 'monthly':
        periodGroup = "strftime('%Y-%m', s.date)";
        break;
      default:
        periodGroup = 's.date';
    }

    const periodData = db.prepare(`
      SELECT
        ${periodGroup} as period,
        SUM(CASE WHEN s.bill_type = 'normal' THEN s.total_revenue ELSE 0 END) as total_sales,
        SUM(s.total_cost) as total_cost,
        SUM(CASE WHEN s.bill_type = 'normal' THEN s.total_revenue ELSE 0 END) - SUM(s.total_cost) as gross_profit,
        CASE WHEN SUM(CASE WHEN s.bill_type = 'normal' THEN s.total_revenue ELSE 0 END) > 0
          THEN ROUND((SUM(CASE WHEN s.bill_type = 'normal' THEN s.total_revenue ELSE 0 END) - SUM(s.total_cost)) / SUM(CASE WHEN s.bill_type = 'normal' THEN s.total_revenue ELSE 0 END) * 100, 2)
          ELSE 0 END as gross_margin,
        SUM(CASE WHEN s.bill_type = 'nc' THEN 1 ELSE 0 END) as nc_count,
        SUM(CASE WHEN s.bill_type = 'nc' THEN s.total_cost ELSE 0 END) as nc_cost,
        SUM(CASE WHEN s.bill_type = 'complimentary' THEN 1 ELSE 0 END) as complimentary_count,
        SUM(CASE WHEN s.bill_type = 'complimentary' THEN s.total_cost ELSE 0 END) as complimentary_cost
      FROM sales s
      WHERE 1=1 ${dateFilter}
      GROUP BY ${periodGroup}
      ORDER BY period ASC
    `).all(...params) as any[];

    // NC impact
    const ncImpact = db.prepare(`
      SELECT
        SUM(CASE WHEN s.bill_type IN ('nc', 'complimentary') THEN s.total_cost ELSE 0 END) as total_nc_cost,
        SUM(CASE WHEN s.bill_type IN ('nc', 'complimentary') THEN s.quantity_sold ELSE 0 END) as total_nc_quantity
      FROM sales s
      WHERE 1=1 ${dateFilter}
    `).get(...params) as any;

    // Top sellers
    const topSellers = itemPnL
      .sort((a: any, b: any) => b.quantity_sold - a.quantity_sold)
      .slice(0, 10)
      .map((i: any) => ({ name: i.item_name, quantity: i.quantity_sold }));

    // Most profitable
    const mostProfitable = itemPnL
      .sort((a: any, b: any) => b.profit - a.profit)
      .slice(0, 10)
      .map((i: any) => ({ name: i.item_name, profit: i.profit }));

    // Loss makers
    const lossMakers = itemPnL
      .filter((i: any) => i.profit < 0)
      .sort((a: any, b: any) => a.profit - b.profit)
      .map((i: any) => ({ name: i.item_name, profit: i.profit }));

    // High food cost items (>30%)
    const highFoodCost = itemPnL
      .filter((i: any) => i.food_cost_percent > 30)
      .sort((a: any, b: any) => b.food_cost_percent - a.food_cost_percent)
      .map((i: any) => ({ name: i.item_name, percent: i.food_cost_percent }));

    // Department breakdown — counts of distinct items + revenue per derived dept.
    // Computed against the ENTIRE date range (ignoring the department filter)
    // so the dropdown labels reflect everything available, not "this dept = me".
    const dateOnlyFilter = (from || to)
      ? ` AND ${from ? 's.date >= ?' : '1=1'} ${to ? 'AND s.date <= ?' : ''}`
      : '';
    const dateOnlyParams: any[] = [];
    if (from) dateOnlyParams.push(from);
    if (to)   dateOnlyParams.push(to);
    const deptBreakdown = db.prepare(`
      SELECT
        ${deptExpr} AS department,
        COUNT(DISTINCT s.item_name) AS items,
        SUM(s.total_revenue)        AS revenue
      FROM sales s
      WHERE 1=1 ${dateOnlyFilter}
      GROUP BY department
      ORDER BY revenue DESC
    `).all(...dateOnlyParams) as any[];

    // Segment breakdown — same idea for the Dine-In / Party toggle. Counts
    // honour the date range but ignore the active segment so the toggle
    // labels show how many you'd get if you picked the OTHER side.
    const segmentBreakdown = db.prepare(`
      SELECT
        ${SEGMENT_EXPR} AS segment,
        COUNT(DISTINCT s.item_name) AS items,
        SUM(s.quantity_sold)        AS qty,
        SUM(s.total_revenue)        AS revenue,
        SUM(s.total_cost)           AS cost
      FROM sales s
      WHERE 1=1 ${dateOnlyFilter}
      GROUP BY segment
    `).all(...dateOnlyParams) as any[];

    return Response.json({
      department_breakdown: deptBreakdown,
      active_department: department || null,
      segment_breakdown: segmentBreakdown,
      active_segment: segment || null,
      item_pnl: itemPnL,
      period_data: periodData,
      nc_impact: ncImpact,
      top_sellers: topSellers,
      most_profitable: mostProfitable,
      loss_makers: lossMakers,
      high_food_cost: highFoodCost,
    });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
