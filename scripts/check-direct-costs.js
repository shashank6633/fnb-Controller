const Database = require('better-sqlite3');
const db = new Database('/Users/shashankreddy/Desktop/Claude/fnb-controller/fnb-controller.db');
const sample = db.prepare(`
  SELECT s.item_name, ROUND(SUM(s.total_revenue)) AS revenue, ROUND(SUM(s.total_cost)) AS cost,
         SUM(s.quantity_sold) AS qty,
         mi.material_id AS mi_mat, dil.material_id AS dil_mat,
         COALESCE(dil.qty_per_unit, 1) AS qty_per_unit,
         rm.average_price, rm.unit, rm.pack_size, rm.purchase_unit, rm.name AS material
  FROM sales s
  LEFT JOIN menu_items mi ON LOWER(mi.name) = LOWER(s.item_name)
  LEFT JOIN direct_item_links dil ON dil.item_name = s.item_name COLLATE NOCASE
  LEFT JOIN raw_materials rm ON rm.id = COALESCE(dil.material_id, mi.material_id)
  WHERE s.item_name IN ('KF ULTRA 330 ML', 'BUDWEISER 330 ML', 'JAMESON IRISH 30 ML', 'CORONA', 'WATALOG WATER BOTTLE')
  GROUP BY s.item_name
`).all();
console.table(sample);
