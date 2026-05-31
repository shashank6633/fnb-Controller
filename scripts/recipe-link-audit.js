#!/usr/bin/env node
/**
 * Recipe ↔ Material link audit + cleanup.
 *
 * Reports:
 *   - Recipes whose ingredients reference materials with NO purchase history (₹0 price)
 *   - Recipes whose ingredients reference deleted/missing materials (orphaned)
 *   - Duplicate raw_materials with the same NORMALIZED name (potential merge candidates)
 *   - menu_items with no pos_id (will rely on name matching)
 *   - menu_items with no recipe link AND with sales (no cost tracking yet)
 *
 * Usage:
 *   node scripts/recipe-link-audit.js
 *   node scripts/recipe-link-audit.js --fix-recipe-costs   # also re-runs all recipe cost calcs
 */
const path = require('path');
const Database = require('better-sqlite3');

const fix = process.argv.includes('--fix-recipe-costs');
const DB_PATH = path.join(__dirname, '..', 'fnb-controller.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const line = (s = '') => console.log(s);
const heading = (s) => { line(); line('=== ' + s + ' ==='); };

heading('1. ORPHAN INGREDIENTS — recipes pointing to a material that no longer exists');
const orphans = db.prepare(`
  SELECT r.name AS recipe, ri.material_id AS missing_material_id, COUNT(*) AS lines
  FROM recipe_ingredients ri
  JOIN recipes r ON r.id = ri.recipe_id
  LEFT JOIN raw_materials rm ON rm.id = ri.material_id
  WHERE rm.id IS NULL
  GROUP BY r.id, ri.material_id
`).all();
if (orphans.length === 0) line('✓ No orphan ingredient references');
else orphans.forEach(o => line(`  ${o.recipe}: ${o.lines} line(s) → missing ${o.missing_material_id}`));

heading('2. DUPLICATE MATERIALS — same normalised name, different rows');
const dupes = db.prepare(`
  WITH norm AS (
    SELECT id, sku, name,
           LOWER(TRIM(REPLACE(REPLACE(REPLACE(name, ' ', ''), '(', ''), ')', ''))) AS k
    FROM raw_materials
  )
  SELECT k, GROUP_CONCAT(sku || ' | ' || name, ' || ') AS variants, COUNT(*) AS n
  FROM norm
  GROUP BY k
  HAVING COUNT(*) > 1
  ORDER BY n DESC
`).all();
if (dupes.length === 0) line('✓ No duplicate-name materials');
else {
  line(`Found ${dupes.length} sets of duplicates (top 10):`);
  dupes.slice(0, 10).forEach(d => line(`  · (${d.n}x) ${d.variants}`));
}

heading('3. INGREDIENTS USED IN RECIPES BUT NEVER PURCHASED');
const unpurchased = db.prepare(`
  SELECT rm.sku, rm.name, COUNT(DISTINCT ri.recipe_id) AS used_in
  FROM recipe_ingredients ri
  JOIN raw_materials rm ON rm.id = ri.material_id
  WHERE NOT EXISTS (SELECT 1 FROM purchases p WHERE p.material_id = rm.id)
  GROUP BY rm.id
  ORDER BY used_in DESC
`).all();
line(`${unpurchased.length} unique ingredients (top 15):`);
unpurchased.slice(0, 15).forEach(u => line(`  ${(u.sku||'·').padEnd(10)} ${u.name.padEnd(40)} used in ${u.used_in} recipes`));

heading('4. MENU ITEMS WITHOUT A POS ID');
const noPos = db.prepare(`SELECT COUNT(*) AS n FROM menu_items WHERE pos_id IS NULL OR pos_id = ''`).get();
const totalMenu = db.prepare(`SELECT COUNT(*) AS n FROM menu_items`).get();
line(`${noPos.n} of ${totalMenu.n} menu items have no pos_id (rely on name matching for sales linking)`);
if (noPos.n > 0) {
  line(`  → re-upload your Recaho Item Wise Sale report to populate pos_item_id on sales,`);
  line(`    then the next server boot will auto-backfill menu_items.pos_id from sales.`);
}

heading('5. SOLD MENU ITEMS WITHOUT A RECIPE OR DIRECT-MATERIAL LINK');
const unlinked = db.prepare(`
  SELECT mi.name, mi.pos_id, COUNT(s.id) AS sale_lines, SUM(s.total_revenue) AS rev
  FROM menu_items mi
  JOIN sales s ON LOWER(s.item_name) = LOWER(mi.name)
  WHERE mi.recipe_id IS NULL AND mi.material_id IS NULL
  GROUP BY mi.id
  ORDER BY SUM(s.total_revenue) DESC
  LIMIT 15
`).all();
line(`Top 15 by revenue:`);
unlinked.forEach(u => line(`  ${u.name.padEnd(35)} ${(u.pos_id||'').padEnd(10)} ${u.sale_lines} lines  ₹${(u.rev||0).toFixed(0)}`));

if (fix) {
  heading('FIX: recompute every recipe cost');
  // delegate to the existing script for behaviour parity
  require('./recompute-all-recipe-costs.js');
}

db.close();
