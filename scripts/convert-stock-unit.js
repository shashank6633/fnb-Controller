#!/usr/bin/env node
/**
 * Convert a raw material's stock unit by dividing all purchase quantities + current_stock
 * by a pack size, and multiplying unit prices by the same factor — so total ₹ stays
 * identical and stock now reads in the new (larger) unit.
 *
 * Usage:
 *   node scripts/convert-stock-unit.js --name "BUDWEISER (330ML)" --to pcs --pack 330 [--dry]
 *   node scripts/convert-stock-unit.js --id <uuid> --to pcs --pack 330 [--dry]
 *
 * Examples:
 *   # 1 bottle of 330ml beer = 1 pc; 330 ml → 1 pc → divide qty by 330, multiply price by 330.
 *   node scripts/convert-stock-unit.js --name "BUDWEISER (330ML)" --to pcs --pack 330
 *
 *   # 1 keg of 30 LTR draught = 1 pc; 30,000 ml → 1 pc → divide by 30000.
 *   node scripts/convert-stock-unit.js --name "KF PREMIUM DRAUGHT" --to pcs --pack 30000
 *
 *   # Dry-run first — prints what WOULD change, makes no edits.
 *   node scripts/convert-stock-unit.js --name "..." --to pcs --pack 330 --dry
 */

const path = require('path');
const Database = require('better-sqlite3');

// --- arg parse (tiny, no deps) ---
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const next = process.argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
}

if ((!args.name && !args.id) || !args.to || !args.pack) {
  console.error('Usage: node scripts/convert-stock-unit.js --name "<material name>" --to <pcs|...> --pack <factor> [--dry]');
  process.exit(1);
}
const pack = Number(args.pack);
if (!Number.isFinite(pack) || pack <= 0) {
  console.error('--pack must be a positive number (e.g. 330 for ml→pcs of a 330ml bottle).');
  process.exit(1);
}
const newUnit = String(args.to);
const dry = !!args.dry;

const DB_PATH = path.join(__dirname, '..', 'fnb-controller.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Locate material
let mat;
if (args.id) {
  mat = db.prepare('SELECT * FROM raw_materials WHERE id = ?').get(args.id);
} else {
  mat = db.prepare('SELECT * FROM raw_materials WHERE LOWER(name) = LOWER(?)').get(args.name);
}
if (!mat) {
  console.error(`Material not found: ${args.name || args.id}`);
  process.exit(1);
}

console.log('=== CONVERT STOCK UNIT ===');
console.log(`Material      : ${mat.name}`);
console.log(`Current unit  : ${mat.unit}    →    New unit: ${newUnit}`);
console.log(`Pack factor   : ${pack}        (each 1 ${newUnit} = ${pack} ${mat.unit})`);
console.log(`Mode          : ${dry ? 'DRY RUN' : 'LIVE'}`);
console.log();

// Pre-stats
const purchases = db.prepare('SELECT id, quantity, unit_price, total_price FROM purchases WHERE material_id = ?').all(mat.id);
const beforeTotalQty   = purchases.reduce((s, p) => s + p.quantity, 0);
const beforeTotalValue = purchases.reduce((s, p) => s + p.total_price, 0);

console.log(`Purchase rows : ${purchases.length}`);
console.log(`Before stock  : ${mat.current_stock.toLocaleString('en-IN')} ${mat.unit}`);
console.log(`Before avg ₹  : ${mat.average_price.toFixed(4)} / ${mat.unit}`);
console.log(`Sum qty       : ${beforeTotalQty.toLocaleString('en-IN')} ${mat.unit}`);
console.log(`Sum total ₹   : ₹${beforeTotalValue.toLocaleString('en-IN')}`);

// Compute targets
const newStock = mat.current_stock / pack;
const newAvg   = mat.average_price * pack;
const expectedAfterTotalQty = beforeTotalQty / pack;

console.log();
console.log('--- AFTER ---');
console.log(`Stock         : ${newStock.toLocaleString('en-IN')} ${newUnit}`);
console.log(`Avg ₹ / ${newUnit}: ${newAvg.toFixed(2)}`);
console.log(`Sum qty       : ${expectedAfterTotalQty.toLocaleString('en-IN')} ${newUnit}`);
console.log(`Sum total ₹   : ₹${beforeTotalValue.toLocaleString('en-IN')} (unchanged)`);
console.log();

if (dry) {
  console.log('DRY RUN — no changes made. Re-run without --dry to apply.');
  db.close();
  process.exit(0);
}

const txn = db.transaction(() => {
  // Convert each purchase row — keep total_price stable
  const upd = db.prepare(`
    UPDATE purchases
    SET quantity   = ROUND(quantity   / ?, 6),
        unit_price = ROUND(unit_price * ?, 4)
    WHERE material_id = ?
  `);
  upd.run(pack, pack, mat.id);

  // Update raw_material
  db.prepare(`
    UPDATE raw_materials
    SET unit          = ?,
        current_stock = ROUND(current_stock / ?, 6),
        average_price = ROUND(average_price * ?, 4),
        updated_at    = datetime('now')
    WHERE id = ?
  `).run(newUnit, pack, pack, mat.id);

  // Convert any inventory_transactions for this material too (audit trail consistency)
  db.prepare(`
    UPDATE inventory_transactions
    SET quantity = ROUND(quantity / ?, 6)
    WHERE material_id = ?
  `).run(pack, mat.id);

  // Convert any recipe_ingredients that use this material in the OLD unit only
  // (we leave per-recipe units alone if they specified a different unit explicitly;
  //  conservative: only update rows whose unit equals the OLD material unit)
  db.prepare(`
    UPDATE recipe_ingredients
    SET quantity = ROUND(quantity / ?, 6),
        unit     = ?
    WHERE material_id = ? AND unit = ?
  `).run(pack, newUnit, mat.id, mat.unit);

  db.prepare(`
    UPDATE sub_recipe_ingredients
    SET quantity = ROUND(quantity / ?, 6),
        unit     = ?
    WHERE material_id = ? AND unit = ?
  `).run(pack, newUnit, mat.id, mat.unit);
});

txn();

// Verify
const after = db.prepare('SELECT * FROM raw_materials WHERE id = ?').get(mat.id);
const afterPurch = db.prepare('SELECT SUM(quantity) AS q, SUM(total_price) AS v FROM purchases WHERE material_id = ?').get(mat.id);

console.log('=== APPLIED ===');
console.log(`Stock now     : ${after.current_stock} ${after.unit}`);
console.log(`Avg ₹         : ${after.average_price} / ${after.unit}`);
console.log(`Sum qty       : ${afterPurch.q?.toLocaleString('en-IN') || 0} ${after.unit}`);
console.log(`Sum total ₹   : ₹${(afterPurch.v || 0).toLocaleString('en-IN')}`);

const drift = Math.abs((afterPurch.v || 0) - beforeTotalValue);
if (drift > 0.5) {
  console.warn(`⚠️  Total drifted by ₹${drift.toFixed(2)} — investigate.`);
} else {
  console.log(`✓ Total ₹ preserved (drift ₹${drift.toFixed(4)})`);
}

db.close();
