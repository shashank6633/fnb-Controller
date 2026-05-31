#!/usr/bin/env node
/**
 * Recompute total_cost / profit / food_cost_percent for every recipe and sub-recipe.
 *
 * Use this after:
 *   - importing purchases (so latest avg prices propagate)
 *   - changing material units (e.g. ml → pcs via convert-stock-unit.js)
 *   - editing the cost-calc logic in lib/db.ts
 *
 * Run:  node scripts/recompute-all-recipe-costs.js
 */
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'fnb-controller.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Mirror lib/db.ts helpers (kept in sync)
function parseMaterialVolumeMl(name) {
  if (!name) return null;
  const s = String(name).toUpperCase();
  const mMl = s.match(/(\d+(?:\.\d+)?)\s*ML\b/);
  if (mMl) return parseFloat(mMl[1]);
  const mLtr = s.match(/(\d+(?:\.\d+)?)\s*(?:LTR|LITRE|LITER|L)\b/);
  if (mLtr) return parseFloat(mLtr[1]) * 1000;
  return null;
}
function convertToMaterialUnit(qty, recipeUnit, materialUnit, materialName) {
  const r = (recipeUnit || materialUnit || '').toLowerCase().trim();
  const m = (materialUnit || '').toLowerCase().trim();
  if (!r || r === m) return qty;
  if (r === 'pcs' && (m === 'ml' || m === 'l')) {
    const packMl = parseMaterialVolumeMl(materialName);
    if (packMl) return m === 'l' ? (qty * packMl) / 1000 : qty * packMl;
  }
  if ((r === 'ml' || r === 'l') && m === 'pcs') {
    const packMl = parseMaterialVolumeMl(materialName);
    if (packMl) return (r === 'l' ? qty * 1000 : qty) / packMl;
  }
  if (r === 'l'  && m === 'ml') return qty * 1000;
  if (r === 'ml' && m === 'l')  return qty / 1000;
  if (r === 'kg' && m === 'g')  return qty * 1000;
  if (r === 'g'  && m === 'kg') return qty / 1000;
  return qty;
}

function recalcSubRecipe(id) {
  const sub = db.prepare('SELECT * FROM sub_recipes WHERE id = ?').get(id);
  if (!sub) return;
  const ings = db.prepare(`
    SELECT sri.*, rm.average_price, rm.unit AS material_unit, rm.name AS material_name
    FROM sub_recipe_ingredients sri JOIN raw_materials rm ON sri.material_id = rm.id
    WHERE sri.sub_recipe_id = ? AND sri.is_default = 1
  `).all(id);
  let total = 0;
  for (const i of ings) {
    const q = convertToMaterialUnit(i.quantity, i.unit, i.material_unit, i.material_name);
    total += (q * (1 + i.wastage_percent / 100) / (i.yield_percent / 100)) * i.average_price;
  }
  const cpu = sub.yield_quantity > 0 ? total / sub.yield_quantity : 0;
  db.prepare(`UPDATE sub_recipes SET total_cost = ?, cost_per_unit = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(Math.round(total * 100) / 100, Math.round(cpu * 100) / 100, id);
}
function recalcRecipe(id) {
  const r = db.prepare('SELECT * FROM recipes WHERE id = ?').get(id);
  if (!r) return;
  const ings = db.prepare(`
    SELECT ri.*, rm.average_price, rm.unit AS material_unit, rm.name AS material_name
    FROM recipe_ingredients ri JOIN raw_materials rm ON ri.material_id = rm.id
    WHERE ri.recipe_id = ? AND ri.is_default = 1
  `).all(id);
  let total = 0;
  for (const i of ings) {
    const q = convertToMaterialUnit(i.quantity, i.unit, i.material_unit, i.material_name);
    total += (q * (1 + i.wastage_percent / 100) / (i.yield_percent / 100)) * i.average_price;
  }
  const subs = db.prepare(`
    SELECT rs.*, sr.cost_per_unit FROM recipe_sub_recipes rs
    JOIN sub_recipes sr ON rs.sub_recipe_id = sr.id WHERE rs.recipe_id = ?
  `).all(id);
  for (const s of subs) total += s.quantity * (s.cost_per_unit || 0);
  const profit = r.selling_price - total;
  const fcp = r.selling_price > 0 ? (total / r.selling_price) * 100 : 0;
  db.prepare(`UPDATE recipes SET total_cost = ?, profit = ?, food_cost_percent = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(Math.round(total * 100) / 100, Math.round(profit * 100) / 100, Math.round(fcp * 100) / 100, id);
}

const subs = db.prepare('SELECT id FROM sub_recipes').all();
const recs = db.prepare('SELECT id FROM recipes').all();

console.log(`Recomputing ${subs.length} sub-recipes + ${recs.length} recipes…`);
const t0 = Date.now();
db.transaction(() => {
  for (const s of subs) recalcSubRecipe(s.id);
  for (const r of recs) recalcRecipe(r.id);
})();
console.log(`Done in ${Date.now() - t0}ms`);

// Stats
const after = db.prepare(`
  SELECT COUNT(*) AS total,
         SUM(CASE WHEN total_cost > 0 THEN 1 ELSE 0 END) AS with_cost,
         SUM(CASE WHEN total_cost = 0 THEN 1 ELSE 0 END) AS zero_cost
  FROM recipes
`).get();
console.log(`recipes: total=${after.total} · with_cost=${after.with_cost} · zero_cost=${after.zero_cost}`);

db.close();
