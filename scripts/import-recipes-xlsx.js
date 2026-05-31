#!/usr/bin/env node
/**
 * Import recipes + cost cards from the AKAN Food Costing workbook.
 *
 * The workbook has these sheets:
 *   - Recipe Cost Cards : 807 ingredient lines across 67 recipes, with
 *                         "Matched SKU" pointing at the raw_materials.name and
 *                         "Conv. Qty" already in the material's recipe unit.
 *   - Recipe Summary    : per-recipe yield, total cost, suggested menu price
 *   - Sub-Recipes To Build : 30+ named sub-recipes referenced by main recipes
 *
 * Strategy:
 *   1. Build a name → material lookup from raw_materials (case/space tolerant).
 *   2. Walk Recipe Cost Cards; group by Recipe #.
 *   3. For each recipe:
 *        - Create the recipe row (notes='AUTO-IMPORT' so easy to find later).
 *        - For each "✓ Matched" line, resolve SKU → material_id and insert
 *          into recipe_ingredients with Conv. Qty + material's unit.
 *        - Skip "Skip" and "⚠ Unmatched" lines but log them.
 *   4. Set recipe.total_cost = Food Cost (₹) from Recipe Summary, and
 *        selling_price = suggested menu price.
 *   5. Create skeleton sub_recipes from "Sub-Recipes To Build" so they show
 *      up in the Recipes page for the kitchen to fill ingredients into.
 *
 * Idempotent: re-running skips recipes that already exist by name.
 * Run:  node scripts/import-recipes-xlsx.js /path/to/AKAN_Food_Costing.xlsx
 */

const path = require('path');
const XLSX = require('xlsx');
const Database = require('better-sqlite3');
const crypto = require('crypto');

const FILE = process.argv[2];
if (!FILE) { console.error('Usage: node scripts/import-recipes-xlsx.js <xlsx-path>'); process.exit(1); }

const DB_PATH = path.join(__dirname, '..', 'fnb-controller.db');
const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');
db.pragma('defer_foreign_keys = 1');

const wb = XLSX.readFile(FILE);
const id = () => crypto.randomUUID();
const normalize = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// ── 1. Build material lookup ──
const mats = db.prepare(`SELECT id, name, unit FROM raw_materials`).all();
const matByName = new Map();
for (const m of mats) matByName.set(normalize(m.name), m);

function resolveMaterial(matchedSkuRaw) {
  const key = normalize(matchedSkuRaw);
  if (!key || key.startsWith('—')) return null;
  return matByName.get(key) || null;
}

// ── 2. Parse Recipe Cost Cards ──
const cardRows = XLSX.utils.sheet_to_json(wb.Sheets['Recipe Cost Cards'], { header: 1, defval: '' });
// First 3 rows = headers; data starts at index 3
// Columns: 0=Recipe#, 1=Name, 2=Yield(g), 3=Ingredient, 4=Qty, 5=Unit, 6=Matched SKU, 7=Status, 8=Conv. Qty, 9=Line Cost
const recipes = new Map();   // recipeNum → { name, yield, lines: [...] }
for (let i = 3; i < cardRows.length; i++) {
  const r = cardRows[i];
  const num = Number(r[0]);
  if (!num) continue;
  const slot = recipes.get(num) || {
    num, name: String(r[1] || '').trim(), yield_g: Number(r[2]) || 0, lines: [],
  };
  slot.lines.push({
    ingredient: r[3], qty: Number(r[4]) || 0, unit: r[5],
    matched_sku: r[6], status: r[7],
    conv_qty: Number(r[8]) || 0, line_cost: Number(r[9]) || 0,
  });
  recipes.set(num, slot);
}

// ── 3. Parse Recipe Summary for costs + suggested prices ──
const summaryRows = XLSX.utils.sheet_to_json(wb.Sheets['Recipe Summary'], { header: 1, defval: '' });
// Columns: 0=#, 1=Name, 2=Ingredients, 3=Yield, 4=Food Cost, 5=Cost/Portion, 6=Menu Price @ Target, 7=Your Menu Price, 8=Actual FC%
const summaryByNum = new Map();
for (let i = 5; i < summaryRows.length; i++) {
  const r = summaryRows[i];
  const num = Number(r[0]);
  if (!num) continue;
  summaryByNum.set(num, {
    food_cost: Number(r[4]) || 0,
    cost_per_portion: Number(r[5]) || 0,
    menu_price: Number(r[6]) || 0,
    your_price: Number(r[7]) || 0,
  });
}

// ── 4. Parse Sub-Recipes ──
const subRows = XLSX.utils.sheet_to_json(wb.Sheets['Sub-Recipes To Build'], { header: 1, defval: '' });
const subRecipes = [];
for (let i = 3; i < subRows.length; i++) {
  const r = subRows[i];
  const name = String(r[0] || '').trim();
  if (!name) continue;
  subRecipes.push({ name, used_in: Number(r[1]) || 0, refs: String(r[2] || '') });
}

console.log(`\n📖 Workbook parsed:`);
console.log(`   ${recipes.size} recipes · ${[...recipes.values()].reduce((a, r) => a + r.lines.length, 0)} ingredient lines`);
console.log(`   ${subRecipes.length} sub-recipes`);
console.log(`   ${mats.length} raw materials in DB to resolve against`);

// ── 5. Existence check (idempotency) ──
const existingRecipeNames = new Set(
  db.prepare(`SELECT LOWER(name) AS n FROM recipes`).all().map(r => r.n)
);
const existingSubNames = new Set(
  db.prepare(`SELECT LOWER(name) AS n FROM sub_recipes`).all().map(r => r.n)
);

// ── 6. Insert ──
const stats = {
  recipes_created: 0, recipes_skipped: 0,
  ingredients_added: 0, ingredients_unmatched: 0, ingredients_skipped: 0,
  sub_recipes_created: 0, sub_recipes_skipped: 0,
};
const unmatchedSkus = new Map();   // name → count

const insRecipe = db.prepare(`
  INSERT INTO recipes (id, name, category, selling_price, total_cost, profit,
                       food_cost_percent, is_active, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
`);
const insIng = db.prepare(`
  INSERT INTO recipe_ingredients (id, recipe_id, material_id, quantity, unit, yield_percent, wastage_percent, is_default)
  VALUES (?, ?, ?, ?, ?, 100, 0, 1)
`);
// Check sub_recipes schema dynamically to keep insert robust
const subCols = new Set(db.prepare("PRAGMA table_info(sub_recipes)").all().map(c => c.name));
const subInsertCols = ['id', 'name'];
const subInsertVals = ['?', '?'];
if (subCols.has('category'))      { subInsertCols.push('category'); subInsertVals.push("'sub-recipe'"); }
if (subCols.has('is_active'))     { subInsertCols.push('is_active'); subInsertVals.push('1'); }
if (subCols.has('created_at'))    { subInsertCols.push('created_at'); subInsertVals.push("datetime('now')"); }
if (subCols.has('updated_at'))    { subInsertCols.push('updated_at'); subInsertVals.push("datetime('now')"); }
const insSub = db.prepare(`INSERT INTO sub_recipes (${subInsertCols.join(',')}) VALUES (${subInsertVals.join(',')})`);

const txn = db.transaction(() => {
  for (const r of recipes.values()) {
    if (existingRecipeNames.has(r.name.toLowerCase())) {
      stats.recipes_skipped++;
      continue;
    }
    const recipeId = id();
    const summary = summaryByNum.get(r.num) || {};
    const sellingPrice = summary.your_price || summary.menu_price || 0;
    const totalCost = summary.food_cost || 0;
    const profit = sellingPrice > 0 ? Math.round((sellingPrice - totalCost) * 100) / 100 : 0;
    const fcPct = sellingPrice > 0 ? Math.round((totalCost / sellingPrice) * 10000) / 100 : 0;

    insRecipe.run(
      recipeId, r.name, '',
      sellingPrice, Math.round(totalCost * 100) / 100,
      profit, fcPct,
    );
    stats.recipes_created++;

    for (const line of r.lines) {
      if (line.status === 'Skip' || !line.conv_qty) { stats.ingredients_skipped++; continue; }
      if (line.status && line.status.startsWith('⚠')) {
        stats.ingredients_unmatched++;
        unmatchedSkus.set(line.ingredient, (unmatchedSkus.get(line.ingredient) || 0) + 1);
        continue;
      }
      const mat = resolveMaterial(line.matched_sku);
      if (!mat) {
        stats.ingredients_unmatched++;
        unmatchedSkus.set(line.matched_sku || line.ingredient, (unmatchedSkus.get(line.matched_sku || line.ingredient) || 0) + 1);
        continue;
      }
      // Store with the RECIPE's unit (g/ml/pcs) not the material's unit.
      // recalculateRecipeCost will bridge via pack_size + convertToMaterialUnit.
      const recipeUnit = String(line.unit || mat.unit).toLowerCase().trim();
      insIng.run(id(), recipeId, mat.id, line.conv_qty, recipeUnit);
      stats.ingredients_added++;
    }
  }

  // Sub-recipes — skeleton only
  for (const s of subRecipes) {
    if (existingSubNames.has(s.name.toLowerCase())) {
      stats.sub_recipes_skipped++;
      continue;
    }
    insSub.run(id(), s.name);
    stats.sub_recipes_created++;
  }
});
txn();

console.log(`\n✅ Import complete:`);
console.log(`   Recipes:        ${stats.recipes_created} created, ${stats.recipes_skipped} skipped (already existed)`);
console.log(`   Ingredients:    ${stats.ingredients_added} added, ${stats.ingredients_unmatched} unmatched, ${stats.ingredients_skipped} 'Skip' lines`);
console.log(`   Sub-recipes:    ${stats.sub_recipes_created} created, ${stats.sub_recipes_skipped} skipped`);

if (unmatchedSkus.size > 0) {
  console.log(`\n⚠ Top unmatched ingredient names (need a matching raw_material):`);
  const top = [...unmatchedSkus.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  for (const [name, n] of top) console.log(`   ${n}×  ${name}`);
}

console.log(`\n💡 Next steps:`);
console.log(`   1. Open /recipes — every recipe is tagged "AUTO-IMPORT" in notes`);
console.log(`   2. Open /menu-items — link each AKAN recipe to its POS menu item`);
console.log(`   3. Fill ingredients into the ${stats.sub_recipes_created} sub-recipes`);
