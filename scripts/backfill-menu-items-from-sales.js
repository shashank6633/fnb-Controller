#!/usr/bin/env node
/**
 * Backfill menu_items from the historical sales table.
 *
 * After resetting recipes (which also wipes menu_items), the recipe form's
 * menu-item dropdown is empty because there's nothing to choose from. This
 * script reads every distinct PRODUCT NAME from `sales`, derives a sensible
 * selling_price from observed revenue ÷ qty, and creates a menu_item per
 * unique name. Idempotent: skips names that already exist.
 *
 * After running this you can use the recipe form's autocomplete and the
 * /menu-items page to link each menu item to one of the 66 imported recipes.
 */

const path = require('path');
const Database = require('better-sqlite3');
const crypto = require('crypto');

const db = new Database(path.join(__dirname, '..', 'fnb-controller.db'));
const id = () => crypto.randomUUID();

// Pull aggregates per item_name
const rows = db.prepare(`
  SELECT item_name,
         MAX(category)       AS category,
         MAX(station)        AS station,
         MAX(pos_item_id)    AS pos_id,
         SUM(total_revenue)  AS rev,
         SUM(quantity_sold)  AS qty,
         COUNT(*)            AS line_count
  FROM sales
  WHERE item_name IS NOT NULL
    AND TRIM(item_name) != ''
    AND TRIM(item_name) != '-'
    AND LOWER(TRIM(item_name)) NOT LIKE 'grand total%'
  GROUP BY item_name
`).all();

console.log(`Found ${rows.length} distinct item names in sales history`);

const existing = new Set(
  db.prepare(`SELECT LOWER(name) AS n FROM menu_items`).all().map(r => r.n)
);

const ins = db.prepare(`
  INSERT INTO menu_items
    (id, name, category, station, item_type, selling_price, listing_price,
     item_code, is_active, source, pos_id, created_at, updated_at)
  VALUES (?, ?, ?, ?, 'foods', ?, ?, '', 1, 'sales-backfill', ?, datetime('now'), datetime('now'))
`);

let created = 0, skipped = 0, zeroPrice = 0;
const txn = db.transaction(() => {
  for (const r of rows) {
    if (existing.has(r.item_name.toLowerCase())) { skipped++; continue; }
    const price = r.qty > 0 && r.rev > 0 ? Math.round((r.rev / r.qty) * 100) / 100 : 0;
    if (price === 0) zeroPrice++;
    ins.run(id(), r.item_name, r.category || '', r.station || '', price, price, r.pos_id || '');
    created++;
  }
});
txn();

console.log(`\n✅ Backfill complete:`);
console.log(`   ${created} menu items created`);
console.log(`   ${skipped} skipped (already existed)`);
console.log(`   (${zeroPrice} of the new ones have zero price — they were free/staff/comped items)`);

const total = db.prepare(`SELECT COUNT(*) AS n FROM menu_items WHERE is_active = 1`).get().n;
console.log(`\nMenu items now in DB: ${total}`);
console.log(`\n💡 Reload /recipes — the typeahead picker will now show options as you type.`);
