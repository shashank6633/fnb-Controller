#!/usr/bin/env node
/**
 * Auto-set pack_size on materials where:
 *   - recipe_unit != purchase_unit
 *   - pack_size is missing or 1
 *   - the (recipe_unit, purchase_unit) pair has a known conversion factor
 *
 * Without this fix, average_price is in ₹/purchase_unit (e.g. ₹/kg) while
 * recipes use grams — so 5 g of ginger gets costed as 5 kg. After this fix
 * + the updated updateMaterialPrice, costs come out correctly.
 *
 * Known conversions:
 *   g  in kg     → pack_size = 1000
 *   ml in l      → pack_size = 1000
 *   pcs in dozen → pack_size = 12
 *   pcs in case  → variable, NOT auto-fixed (case_size is separate)
 */

const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, '..', 'fnb-controller.db'));

const CONVERSIONS = {
  'g|kg':  1000,
  'ml|l':  1000,
  'pcs|dozen': 12,
};

const mats = db.prepare(`
  SELECT id, name, unit, purchase_unit, pack_size, average_price
  FROM raw_materials
  WHERE LOWER(unit) != LOWER(COALESCE(purchase_unit, ''))
    AND (pack_size IS NULL OR pack_size <= 1)
`).all();

console.log(`Found ${mats.length} materials with unit ≠ purchase_unit and no pack_size`);

const upd = db.prepare(`UPDATE raw_materials SET pack_size = ?, updated_at = datetime('now') WHERE id = ?`);
let fixed = 0, unknown = 0;
const unknownPairs = new Map();

const txn = db.transaction(() => {
  for (const m of mats) {
    const u = (m.unit || '').toLowerCase().trim();
    const pu = (m.purchase_unit || '').toLowerCase().trim();
    const key = `${u}|${pu}`;
    const ps = CONVERSIONS[key];
    if (!ps) {
      unknown++;
      unknownPairs.set(key, (unknownPairs.get(key) || 0) + 1);
      continue;
    }
    upd.run(ps, m.id);
    fixed++;
  }
});
txn();

console.log(`\n✅ Pack-size fix applied:`);
console.log(`   ${fixed} materials updated`);
console.log(`   ${unknown} skipped (unknown unit pair)`);

if (unknownPairs.size > 0) {
  console.log(`\n⚠ Unknown (recipe_unit | purchase_unit) pairs — need manual review:`);
  for (const [k, n] of [...unknownPairs.entries()].sort((a,b) => b[1] - a[1])) {
    console.log(`   ${n}×  (${k})`);
  }
}

// ─── PHASE 2: detect "purchase_unit = recipe_unit = g/ml but price is suspiciously high" ───
// Common pattern: user set both units to 'g' but entered purchases as kg-qty at kg-price.
// Heuristic: for materials with unit∈{g,ml} and avg_price > 10, the actual purchase was
// almost certainly in {kg,l}. Flip purchase_unit to {kg,l} + set pack_size = 1000.
const susTxn = db.transaction(() => {
  const sus = db.prepare(`
    SELECT id, name, unit, purchase_unit, pack_size, average_price
    FROM raw_materials
    WHERE LOWER(unit) IN ('g','ml')
      AND LOWER(purchase_unit) = LOWER(unit)
      AND average_price > 10
  `).all();
  console.log(`\nPhase 2: ${sus.length} materials with suspicious per-${'<g/ml>'} price > ₹10`);
  let phase2 = 0;
  const upd2 = db.prepare(`UPDATE raw_materials SET purchase_unit = ?, pack_size = 1000, updated_at = datetime('now') WHERE id = ?`);
  for (const m of sus) {
    const u = m.unit.toLowerCase();
    const newPu = u === 'g' ? 'kg' : 'l';
    upd2.run(newPu, m.id);
    phase2++;
  }
  console.log(`   ${phase2} flipped to purchase_unit = kg/l + pack_size = 1000`);
});
susTxn();

console.log(`\n💡 Next: hit /api/admin/recompute-prices to recompute average_price + recipe costs:`);
console.log(`   curl -X POST http://localhost:3001/api/admin/recompute-prices`);
console.log(`   OR: node scripts/recompute-prices-direct.js`);
