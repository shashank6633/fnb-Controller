const Database = require('better-sqlite3');
const db = new Database('./fnb-controller.db');
console.log('bill_type distribution:');
console.table(db.prepare(`SELECT bill_type, COUNT(*) AS rows, SUM(quantity_sold) AS qty, ROUND(SUM(total_revenue)) AS rev FROM sales GROUP BY bill_type ORDER BY 2 DESC`).all());
console.log('\norder_type distribution:');
console.table(db.prepare(`SELECT order_type, COUNT(*) AS rows, SUM(quantity_sold) AS qty, ROUND(SUM(total_revenue)) AS rev FROM sales WHERE order_type IS NOT NULL GROUP BY order_type ORDER BY 2 DESC`).all());
console.log('\ncategory distribution (Party):');
console.table(db.prepare(`SELECT category, COUNT(*) AS rows, SUM(quantity_sold) AS qty FROM sales WHERE LOWER(category) LIKE '%party%' GROUP BY category`).all());
