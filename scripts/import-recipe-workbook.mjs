#!/usr/bin/env node
/**
 * CLI fallback for the Food-Costing workbook import. Mirrors the API commit route
 * (src/app/api/recipe-workbook-import/commit/route.ts) but runs headless against
 * the SQLite file directly. Reuses the SAME pure parser (src/lib/recipe-workbook.ts)
 * so there is no parsing drift.
 *
 * Run (Node 22+, type-stripping needed to import the .ts parser):
 *   node --experimental-strip-types scripts/import-recipe-workbook.mjs <path-to.xlsx> [--no-overwrite]
 *
 * Cost roll-up is computed inline (identity unit conversion — the importer stores
 * each material's unit == the recipe line's base unit, so qty needs no conversion).
 * For the authoritative engine math, use the in-app "Recompute all costs" button.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { parseRecipeWorkbook, buildMaterialResolver, normName, categorizeRecipeName } from '../src/lib/recipe-workbook.ts';

const FILE = process.argv[2];
const overwrite = !process.argv.includes('--no-overwrite');
if (!FILE) {
  console.error('Usage: node --experimental-strip-types scripts/import-recipe-workbook.mjs <xlsx> [--no-overwrite]');
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'fnb-controller.db');
const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

const wb = XLSX.readFile(FILE);
const parsed = parseRecipeWorkbook(XLSX, wb);

const rep = { materials_created: 0, materials_price_updated: 0, sub_created: 0, sub_updated: 0, rec_created: 0, rec_updated: 0, not_matched: 0, sub_in_sub: 0 };

const summaryByName = new Map();
for (const s of parsed.summary) summaryByName.set(normName(s.recipe), s.yourMenuPrice > 0 ? s.yourMenuPrice : s.menuPriceAtTarget);

const tx = db.transaction(() => {
  // Materials
  const idByName = new Map();
  for (const m of db.prepare('SELECT id, name FROM raw_materials').all()) idByName.set(normName(m.name), m.id);
  const insMat = db.prepare(`INSERT INTO raw_materials (id, name, category, unit, purchase_unit, pack_size, reorder_level, costing_method, average_price, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 0, 'average', ?, datetime('now'), datetime('now'))`);
  const updMat = db.prepare(`UPDATE raw_materials SET average_price = ?, updated_at = datetime('now') WHERE id = ?`);
  for (const m of parsed.materials) {
    const key = normName(m.name); const price = Math.round(m.avgRatePerBaseUnit * 10000) / 10000;
    const ex = idByName.get(key);
    if (ex) { if (overwrite && price > 0) { updMat.run(price, ex); rep.materials_price_updated++; } }
    else { const id = randomUUID(); insMat.run(id, m.name, m.category || 'other', m.baseUnit || 'g', m.purchaseUnit || '', price); idByName.set(key, id); rep.materials_created++; }
  }
  const resolveMat = buildMaterialResolver(db.prepare('SELECT id, name FROM raw_materials').all());
  const priceById = new Map(db.prepare('SELECT id, average_price FROM raw_materials').all().map((m) => [m.id, m.average_price]));

  // Sub-recipes
  const subIdByName = new Map();
  for (const s of db.prepare('SELECT id, name FROM sub_recipes WHERE is_active = 1').all()) subIdByName.set(normName(s.name), s.id);
  const insSub = db.prepare(`INSERT INTO sub_recipes (id, name, category, yield_quantity, yield_unit, version, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 'g', 1, 1, datetime('now'), datetime('now'))`);
  const updSub = db.prepare(`UPDATE sub_recipes SET category = ?, yield_quantity = ?, yield_unit = 'g', version = version + 1, updated_at = datetime('now') WHERE id = ?`);
  const clrSubIng = db.prepare('DELETE FROM sub_recipe_ingredients WHERE sub_recipe_id = ?');
  const insSubIng = db.prepare(`INSERT INTO sub_recipe_ingredients (id, sub_recipe_id, material_id, quantity, unit, yield_percent, wastage_percent, is_default, brand_preference) VALUES (?, ?, ?, ?, ?, 100, 0, 1, '')`);
  const setSubCost = db.prepare(`UPDATE sub_recipes SET total_cost = ?, cost_per_unit = ?, updated_at = datetime('now') WHERE id = ?`);
  const costPerUnitBySub = new Map();
  for (const s of parsed.subRecipes) {
    const key = normName(s.name); let id = subIdByName.get(key);
    if (id) { if (!overwrite) continue; updSub.run(s.source || '', s.batchYieldG || 1, id); rep.sub_updated++; }
    else { id = randomUUID(); insSub.run(id, s.name, s.source || '', s.batchYieldG || 1); subIdByName.set(key, id); rep.sub_created++; }
    clrSubIng.run(id);
    let total = 0;
    for (const l of s.lines) {
      const matId = resolveMat(l.ingredientName);
      if (!matId) { rep.not_matched++; continue; }
      insSubIng.run(randomUUID(), id, matId, l.qty, l.baseUnit || 'g');
      total += l.qty * (priceById.get(matId) || 0);
    }
    rep.sub_in_sub += s.subRefLines.length;
    const cpu = (s.batchYieldG || 0) > 0 ? total / s.batchYieldG : 0;
    setSubCost.run(Math.round(total * 100) / 100, Math.round(cpu * 100) / 100, id);
    costPerUnitBySub.set(id, cpu);
  }

  // Recipes
  const recIdByName = new Map();
  for (const r of db.prepare('SELECT id, name FROM recipes WHERE is_active = 1').all()) recIdByName.set(normName(r.name), r.id);
  const insRec = db.prepare(`INSERT INTO recipes (id, name, category, selling_price, yield_quantity, yield_unit, version, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'g', 1, 1, datetime('now'), datetime('now'))`);
  const fillRecCat = db.prepare(`UPDATE recipes SET category = ? WHERE id = ? AND (category IS NULL OR trim(category) = '')`);
  const updRec = db.prepare(`UPDATE recipes SET selling_price = ?, yield_quantity = ?, yield_unit = 'g', version = version + 1, updated_at = datetime('now') WHERE id = ?`);
  const clrRecIng = db.prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?');
  const clrRecSub = db.prepare('DELETE FROM recipe_sub_recipes WHERE recipe_id = ?');
  const insRecIng = db.prepare(`INSERT INTO recipe_ingredients (id, recipe_id, material_id, quantity, unit, yield_percent, wastage_percent, is_default, brand_preference) VALUES (?, ?, ?, ?, ?, 100, 0, 1, '')`);
  const insRecSub = db.prepare(`INSERT INTO recipe_sub_recipes (id, recipe_id, sub_recipe_id, quantity, unit) VALUES (?, ?, ?, ?, 'g')`);
  const setRecCost = db.prepare(`UPDATE recipes SET total_cost = ?, profit = selling_price - ?, food_cost_percent = CASE WHEN selling_price > 0 THEN ? / selling_price * 100 ELSE 0 END, updated_at = datetime('now') WHERE id = ?`);
  for (const r of parsed.recipes) {
    const key = normName(r.name); const selling = summaryByName.get(key) || 0; const cat = categorizeRecipeName(r.name); let id = recIdByName.get(key);
    if (id) { if (!overwrite) continue; updRec.run(selling, r.yieldQty || 0, id); fillRecCat.run(cat, id); rep.rec_updated++; }
    else { id = randomUUID(); insRec.run(id, r.name, cat, selling, r.yieldQty || 0); recIdByName.set(key, id); rep.rec_created++; }
    clrRecIng.run(id); clrRecSub.run(id);
    let total = 0;
    for (const l of r.lines) {
      if (l.isSubRef) {
        const subId = subIdByName.get(normName(l.name));
        if (!subId) { rep.not_matched++; continue; }
        insRecSub.run(randomUUID(), id, subId, l.qty);
        total += l.qty * (costPerUnitBySub.get(subId) || 0);
      } else {
        const matId = resolveMat(l.name);
        if (!matId) { rep.not_matched++; continue; }
        insRecIng.run(randomUUID(), id, matId, l.qty, l.baseUnit || 'g');
        total += l.qty * (priceById.get(matId) || 0);
      }
    }
    const rounded = Math.round(total * 100) / 100;
    setRecCost.run(rounded, rounded, rounded, id);
  }

  if (parsed.targetFoodCostPct != null && parsed.targetFoodCostPct > 0) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('target_food_cost_pct', String(parsed.targetFoodCostPct));
  }
});
tx();

console.log('Import complete:', JSON.stringify(rep, null, 2));
console.log(`Target food cost %: ${parsed.targetFoodCostPct}`);
db.close();
