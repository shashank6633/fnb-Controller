#!/usr/bin/env node
/**
 * Backfill sales.total_cost for rows that are matched to a direct item
 * (material_id) but have total_cost = 0 because they were imported before
 * direct-item costing was wired into sales-import.
 *
 * Cost formula:
 *   cost = quantity_sold × qty_per_unit × material.average_price
 *
 * - qty_per_unit comes from direct_item_links (default 1)
 * - material.average_price is already normalised to ₹ per recipe-unit via
 *   the pack_size fix (e.g. ₹0.0038/ml for whisky from a 750ml bottle)
 *
 * Re-runnable; only touches rows where total_cost is 0 or unset.
 */

const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, '..', 'fnb-controller.db'));

// Find every distinct sales item name that has a direct-item link via either
// direct_item_links or menu_items.material_id but no associated cost.
const candidates = db.prepare(`
  SELECT s.item_name,
         COALESCE(dil.material_id, mi.material_id) AS material_id,
         COALESCE(dil.qty_per_unit, 1)             AS qty_per_unit,
         rm.average_price                          AS avg_price,
         rm.name                                   AS material_name,
         rm.unit                                   AS unit
  FROM sales s
  LEFT JOIN direct_item_links dil ON dil.item_name = s.item_name COLLATE NOCASE
  LEFT JOIN menu_items mi ON LOWER(mi.name) = LOWER(s.item_name)
  LEFT JOIN raw_materials rm ON rm.id = COALESCE(dil.material_id, mi.material_id)
  WHERE s.recipe_id IS NULL
    AND (s.total_cost IS NULL OR s.total_cost = 0)
    AND COALESCE(dil.material_id, mi.material_id) IS NOT NULL
    AND rm.average_price > 0
  GROUP BY s.item_name
`).all();

console.log(`Found ${candidates.length} item names with direct-link cost gap\n`);

const upd = db.prepare(`
  UPDATE sales
  SET total_cost = ROUND(quantity_sold * ? * ?, 2)
  WHERE LOWER(item_name) = LOWER(?)
    AND recipe_id IS NULL
    AND (total_cost IS NULL OR total_cost = 0)
`);

let rowsUpdated = 0;
let totalCostInjected = 0;
const detail = [];

const txn = db.transaction(() => {
  for (const c of candidates) {
    const r = upd.run(c.qty_per_unit, c.avg_price, c.item_name);
    rowsUpdated += r.changes;
    if (r.changes > 0) {
      // Sum the new cost for reporting
      const sum = db.prepare(`SELECT SUM(total_cost) AS s FROM sales
        WHERE LOWER(item_name) = LOWER(?) AND recipe_id IS NULL`).get(c.item_name);
      totalCostInjected += sum.s || 0;
      detail.push({
        item: c.item_name,
        material: c.material_name,
        qty_per_unit: c.qty_per_unit,
        unit_price: c.avg_price,
        rows: r.changes,
        new_cost: sum.s,
      });
    }
  }
});
txn();

// Print top 15 by impact
detail.sort((a, b) => (b.new_cost || 0) - (a.new_cost || 0));
console.log('Top items by injected cost:\n');
console.table(detail.slice(0, 15).map(d => ({
  item: d.item.slice(0, 30),
  material: d.material.slice(0, 30),
  qty_per: d.qty_per_unit,
  '₹/unit': Math.round(d.unit_price * 10000) / 10000,
  rows: d.rows,
  new_cost: '₹' + Math.round(d.new_cost || 0).toLocaleString('en-IN'),
})));

console.log(`\n✅ Backfill complete:`);
console.log(`   ${rowsUpdated} sales rows updated`);
console.log(`   ${detail.length} distinct items fixed`);
console.log(`   ₹${Math.round(totalCostInjected).toLocaleString('en-IN')} total cost injected`);
