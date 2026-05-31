#!/usr/bin/env node
/**
 * Import a Recaho "STORE CLOSING" workbook into the closing_stock table.
 *
 *   node scripts/import-closing-stock.js <xlsx-path> <YYYY-MM-DD>
 *
 * Sheet expected columns:
 *   CATEGORY NAME | ITEM NAME | STOCK UNIT | CLOSING RATE (LAST INWARD RATE) |
 *   SYSTEM CLOSING QTY | SYSTEM CLOSING AMT
 *
 * For closing stock we record the *physical* qty == the system closing qty
 * from the file (the count the store reports). variance = physical - system_stock.
 *
 * Matching rules — name first, then SKU/aliases. Reports unmatched at the end
 * so the operator can fix material masters before re-running.
 */
const path = require('path');
const Database = require('better-sqlite3');
const XLSX = require('xlsx');
const crypto = require('crypto');

const file = process.argv[2];
const dateArg = process.argv[3];
if (!file || !dateArg) {
  console.error('Usage: node scripts/import-closing-stock.js <xlsx> <YYYY-MM-DD>');
  process.exit(2);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
  console.error('Date must be YYYY-MM-DD');
  process.exit(2);
}

const dbPath = path.join(__dirname, '..', 'fnb-controller.db');
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

const wb = XLSX.readFile(file);
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

const headerRow = rows[0].map(s => String(s || '').toUpperCase().trim());
const idx = {
  category: headerRow.findIndex(h => h.includes('CATEGORY')),
  item:     headerRow.findIndex(h => h.includes('ITEM')),
  unit:     headerRow.findIndex(h => h.includes('STOCK UNIT')),
  rate:     headerRow.findIndex(h => h.includes('CLOSING RATE')),
  qty:      headerRow.findIndex(h => h.includes('CLOSING QTY')),
  amt:      headerRow.findIndex(h => h.includes('CLOSING AMT')),
};
if (idx.item < 0 || idx.qty < 0) {
  console.error('Could not locate ITEM NAME / CLOSING QTY columns. Got header:', headerRow);
  process.exit(2);
}

// Build a name lookup for raw_materials
const materials = db.prepare('SELECT id, name, sku, current_stock, average_price, unit FROM raw_materials').all();
const byNorm = new Map();
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
for (const m of materials) byNorm.set(norm(m.name), m);

const items = [];
const unmatched = [];
for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  const name = String(r[idx.item] || '').trim();
  if (!name) continue;
  const qty = Number(r[idx.qty]);
  if (!Number.isFinite(qty)) continue;
  const m = byNorm.get(norm(name));
  if (!m) {
    unmatched.push({ name, category: r[idx.category], unit: r[idx.unit], qty });
    continue;
  }
  items.push({
    material_id: m.id,
    name: m.name,
    physical_stock: qty,
    system_stock: m.current_stock,
    avg_price: m.average_price,
  });
}

console.log(`Parsed ${rows.length - 1} rows → ${items.length} matched, ${unmatched.length} unmatched`);

const insert = db.prepare(`
  INSERT INTO closing_stock (id, material_id, date, system_stock, physical_stock,
                             variance, variance_value, notes, recorded_by)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const del = db.prepare('DELETE FROM closing_stock WHERE date = ?');

const txn = db.transaction(() => {
  del.run(dateArg);
  for (const it of items) {
    const variance = it.physical_stock - it.system_stock;
    const variance_value = variance * (it.avg_price || 0);
    insert.run(
      crypto.randomBytes(16).toString('hex'),
      it.material_id, dateArg,
      it.system_stock, it.physical_stock,
      variance, variance_value,
      'Imported from APR.Closing.2026.xlsx',
      'import-script',
    );
  }
});
txn();

console.log(`\n✓ Wrote ${items.length} closing-stock rows for ${dateArg}`);

if (unmatched.length) {
  console.log(`\n⚠ ${unmatched.length} unmatched items (need raw_material masters or alias):`);
  for (const u of unmatched.slice(0, 50)) {
    console.log(`  [${u.category}] ${u.name} — ${u.qty} ${u.unit}`);
  }
  if (unmatched.length > 50) console.log(`  …and ${unmatched.length - 50} more`);
}

// Quick variance summary
const totalVar = items.reduce((s, it) => s + (it.physical_stock - it.system_stock) * (it.avg_price || 0), 0);
const shortages = items.filter(it => it.physical_stock < it.system_stock).length;
const excesses  = items.filter(it => it.physical_stock > it.system_stock).length;
const matches   = items.filter(it => it.physical_stock === it.system_stock).length;
console.log(`\nVariance summary:`);
console.log(`  Net variance value : ₹${totalVar.toFixed(2)}`);
console.log(`  Shortages          : ${shortages}`);
console.log(`  Excesses           : ${excesses}`);
console.log(`  Exact matches      : ${matches}`);
