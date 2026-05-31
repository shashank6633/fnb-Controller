#!/usr/bin/env node
/**
 * Direct DB recompute — bypasses the Next.js API so we don't need the dev
 * server to be running with the latest code. Mirrors the canonical
 * updateMaterialPrice logic (rolling 90-day + pack_size normalisation) and
 * cascades into recipe + sub-recipe costs.
 */
const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, '..', 'fnb-controller.db'));
db.pragma('foreign_keys = ON');

function updateMaterialPrice(materialId) {
  const m = db.prepare('SELECT * FROM raw_materials WHERE id = ?').get(materialId);
  if (!m) return;
  if (m.costing_method !== 'average') {
    const latest = db.prepare(`SELECT unit_price FROM purchases WHERE material_id = ? ORDER BY date DESC, created_at DESC LIMIT 1`).get(materialId);
    if (latest) db.prepare(`UPDATE raw_materials SET average_price = ?, updated_at = datetime('now') WHERE id = ?`).run(latest.unit_price, materialId);
    return;
  }
  const rolling = db.prepare(`SELECT SUM(quantity*unit_price) AS v, SUM(quantity) AS q FROM purchases WHERE material_id = ? AND date >= date('now','-90 day')`).get(materialId);
  const allTime = db.prepare(`SELECT SUM(quantity*unit_price) AS v, SUM(quantity) AS q FROM purchases WHERE material_id = ?`).get(materialId);
  const r = rolling.q > 0 ? rolling : allTime;
  if (!r.q) return;
  let avg = r.v / r.q;
  const ps = Number(m.pack_size) || 1;
  const u = String(m.unit || '').toLowerCase();
  const pu = String(m.purchase_unit || m.unit || '').toLowerCase();
  if (ps > 1 && u !== pu) avg = avg / ps;
  db.prepare(`UPDATE raw_materials SET average_price = ?, updated_at = datetime('now') WHERE id = ?`).run(Math.round(avg * 10000) / 10000, materialId);
}

function recalcRecipe(recipeId) {
  // total = sum(qty × price), where qty is converted via pack_size where needed
  const ings = db.prepare(`
    SELECT ri.quantity, ri.unit, ri.yield_percent, ri.wastage_percent,
           rm.average_price, rm.unit AS mat_unit, rm.pack_size, rm.purchase_unit
    FROM recipe_ingredients ri JOIN raw_materials rm ON rm.id = ri.material_id
    WHERE ri.recipe_id = ?
  `).all(recipeId);
  let total = 0;
  for (const ing of ings) {
    const qty = Number(ing.quantity) || 0;
    const price = Number(ing.average_price) || 0;
    const ru = String(ing.unit || '').toLowerCase();
    const mu = String(ing.mat_unit || '').toLowerCase();
    let qtyInMatUnit = qty;
    if (ru !== mu) {
      // Basic g↔kg, ml↔l
      if (ru === 'g'  && mu === 'kg') qtyInMatUnit = qty / 1000;
      else if (ru === 'kg' && mu === 'g')  qtyInMatUnit = qty * 1000;
      else if (ru === 'ml' && mu === 'l')  qtyInMatUnit = qty / 1000;
      else if (ru === 'l'  && mu === 'ml') qtyInMatUnit = qty * 1000;
      // Density=1 fallback: cross-dimension volume↔weight (works for ~water-density items
      // like milk, sauces, oils where 1 ml ≈ 1 g; off by ~5-15% for syrups/oils — close
      // enough for food-cost). Without this fallback an "ml against a kg material"
      // recipe row produces costs 1,000,000× too high.
      else if (ru === 'ml' && mu === 'kg') qtyInMatUnit = qty / 1000;
      else if (ru === 'g'  && mu === 'l')  qtyInMatUnit = qty / 1000;
      else if (ru === 'ml' && mu === 'g')  qtyInMatUnit = qty;            // 1ml ≈ 1g
      else if (ru === 'g'  && mu === 'ml') qtyInMatUnit = qty;            // 1g ≈ 1ml
      else if (ru === 'l'  && mu === 'kg') qtyInMatUnit = qty;            // 1l ≈ 1kg
      else if (ru === 'kg' && mu === 'l')  qtyInMatUnit = qty;
    }
    const y = (Number(ing.yield_percent) || 100) / 100;
    const w = (Number(ing.wastage_percent) || 0) / 100;
    total += (qtyInMatUnit * price * (1 + w)) / y;
  }
  total = Math.round(total * 100) / 100;
  const sp = (db.prepare(`SELECT selling_price FROM recipes WHERE id = ?`).get(recipeId)).selling_price || 0;
  const profit = sp > 0 ? Math.round((sp - total) * 100) / 100 : 0;
  const fc = sp > 0 ? Math.round((total / sp) * 10000) / 100 : 0;
  db.prepare(`UPDATE recipes SET total_cost = ?, profit = ?, food_cost_percent = ?, updated_at = datetime('now') WHERE id = ?`).run(total, profit, fc, recipeId);
}

const mats = db.prepare(`SELECT id FROM raw_materials`).all();
console.log(`Recomputing ${mats.length} material prices…`);
for (const m of mats) updateMaterialPrice(m.id);

const recs = db.prepare(`SELECT id FROM recipes`).all();
console.log(`Recomputing ${recs.length} recipe costs…`);
for (const r of recs) recalcRecipe(r.id);

const gngr = db.prepare(`SELECT name, unit, purchase_unit, pack_size, average_price FROM raw_materials WHERE name = 'GINGER'`).get();
console.log(`\n✓ GINGER:`, gngr);

const angara = db.prepare(`SELECT name, total_cost, selling_price, food_cost_percent FROM recipes WHERE LOWER(name) LIKE '%angara chicken kebab%'`).get();
console.log(`\n✓ Angara Chicken Kebab:`, angara);
