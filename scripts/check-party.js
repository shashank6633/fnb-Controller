const Database = require('better-sqlite3');
const db = new Database('./fnb-controller.db');
console.log('Items where item_name ends with " P" (likely Party items):');
console.table(db.prepare(`
  SELECT
    CASE WHEN item_name LIKE '% P' OR LOWER(category) LIKE '%party%' OR LOWER(category) = 'custom' THEN 'PARTY'
         ELSE 'DINE-IN' END AS segment,
    COUNT(DISTINCT item_name) AS distinct_items,
    SUM(quantity_sold) AS qty,
    ROUND(SUM(total_revenue)) AS rev,
    ROUND(SUM(total_cost)) AS cost
  FROM sales WHERE bill_type='normal'
  GROUP BY segment
`).all());
console.log('\nSample party items:');
console.table(db.prepare(`SELECT item_name, category, SUM(quantity_sold) AS qty FROM sales WHERE (item_name LIKE '% P' OR LOWER(category) IN ('party package','custom')) AND bill_type='normal' GROUP BY item_name ORDER BY qty DESC LIMIT 8`).all());
console.log('\nSample dine-in items:');
console.table(db.prepare(`SELECT item_name, category, SUM(quantity_sold) AS qty FROM sales WHERE NOT (item_name LIKE '% P' OR LOWER(category) IN ('party package','custom')) AND bill_type='normal' GROUP BY item_name ORDER BY qty DESC LIMIT 8`).all());
