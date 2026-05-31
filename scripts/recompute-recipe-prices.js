#!/usr/bin/env node
/**
 * Recompute recipe selling_price + food_cost_percent from actual sales data.
 *
 * The xlsx import set every recipe to ₹cost ÷ 0.30 (the 30% target). That's
 * a target ceiling, not the real price. This script replaces it with the
 * actual weighted-average selling price observed in the `sales` table.
 *
 * Matching strategy:
 *   1. Exact name match (case-insensitive)
 *   2. Strip "/ NONVEG", "(VEG)", "GRILL LIVE", "NSP", etc. and retry
 *   3. Token-overlap match: must share ≥ 2 anchor tokens with a sale name
 *
 * Recipes that don't match: selling_price = 0, food_cost_percent = 0, and
 * a console warning. Better to admit unknown than to lie.
 */

const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, '..', 'fnb-controller.db'));

const normalize = s => String(s || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
const GENERIC = new Set([
  'and','or','the','a','of','with','to','&','live','grill','nsp','pr','peri',
  've','nv','veg','nonveg','non','vegan','classic','special','indian','chinese',
  'continental','main','side','small','large','full','half','baby','mini',
  'plates','plate','dish','served','served-with','served-with-',
]);
const tokens = (name) => normalize(name).split(' ').filter(t => t.length >= 3 && !GENERIC.has(t));

// 1. Pre-aggregate sales by item_name → weighted avg price
const salesAgg = db.prepare(`
  SELECT item_name,
         SUM(total_revenue) AS total_rev,
         SUM(quantity_sold) AS total_qty,
         COUNT(*) AS line_count
  FROM sales
  WHERE total_revenue > 0 AND quantity_sold > 0
    AND item_name IS NOT NULL AND TRIM(item_name) != ''
  GROUP BY item_name
`).all();

console.log(`\n📊 ${salesAgg.length} distinct sale item names available for matching`);

// Pre-tokenize sales
const salesWithToks = salesAgg
  .map(s => ({ ...s, toks: tokens(s.item_name), avg_price: s.total_rev / s.total_qty }))
  .filter(s => s.avg_price > 5);   // filter out anomalies (free items etc.)

// Build exact-name lookup
const salesByExact = new Map();
for (const s of salesWithToks) salesByExact.set(normalize(s.item_name), s);

// 2. For each recipe, find best match
function findMatch(recipeName) {
  const exact = salesByExact.get(normalize(recipeName));
  if (exact) return { sale: exact, method: 'exact', score: 1 };

  // Cleanup pass: drop "/ NONVEG", "(VEG)" etc.
  const cleaned = recipeName
    .replace(/\s*\/.*$/g, '')   // drop "/ NONVEG"
    .replace(/\(.*?\)/g, '')    // drop "(VEG)"
    .replace(/\b(grill live|nsp|pr|peri peri|live|grill|gravy)\b/gi, '')
    .replace(/\s+/g, ' ').trim();
  const cleanedExact = salesByExact.get(normalize(cleaned));
  if (cleanedExact) return { sale: cleanedExact, method: 'cleaned', score: 0.95 };

  // Token-overlap matching disabled: it pairs unrelated items that share
  // a couple of generic ingredient tokens (e.g. "Edamame Truffle Uramaki"
  // → "Edamame Truffle Dimsum" — wrong dish, wrong price). Leave price=0
  // for these so the kitchen explicitly maps via /menu-items instead of
  // trusting a confidently wrong number.
  return null;
}

// 3. Walk recipes and update
const recipes = db.prepare(`SELECT id, name, total_cost FROM recipes`).all();
const stats = { exact: 0, cleaned: 0, unmatched: 0 };
const unmatched = [];

const update = db.prepare(`
  UPDATE recipes
  SET selling_price = ?, profit = ?, food_cost_percent = ?, updated_at = datetime('now')
  WHERE id = ?
`);

const txn = db.transaction(() => {
  for (const r of recipes) {
    const m = findMatch(r.name);
    if (!m) {
      stats.unmatched++; unmatched.push(r.name);
      update.run(0, 0, 0, r.id);   // wipe the fake 30% number
      continue;
    }
    stats[m.method] = (stats[m.method] || 0) + 1;
    const price = Math.round(m.sale.avg_price * 100) / 100;
    const cost = r.total_cost || 0;
    const profit = Math.round((price - cost) * 100) / 100;
    const fcPct = price > 0 ? Math.round((cost / price) * 10000) / 100 : 0;
    update.run(price, profit, fcPct, r.id);
  }
});
txn();

console.log(`\n✅ Recompute complete:`);
console.log(`   Exact name match:    ${stats.exact}`);
console.log(`   Cleaned match:       ${stats.cleaned}`);
console.log(`   Unmatched (price=0): ${stats.unmatched}  ← needs manual /menu-items linking`);

// Distribution of resulting food cost %
const fcDist = db.prepare(`
  SELECT
    SUM(CASE WHEN food_cost_percent BETWEEN 0.01 AND 25 THEN 1 ELSE 0 END) AS healthy,
    SUM(CASE WHEN food_cost_percent > 25 AND food_cost_percent <= 35 THEN 1 ELSE 0 END) AS target,
    SUM(CASE WHEN food_cost_percent > 35 AND food_cost_percent <= 50 THEN 1 ELSE 0 END) AS high,
    SUM(CASE WHEN food_cost_percent > 50 THEN 1 ELSE 0 END) AS bleeding,
    SUM(CASE WHEN food_cost_percent <= 0 THEN 1 ELSE 0 END) AS unknown
  FROM recipes
`).get();
console.log(`\n📈 Resulting food cost % distribution:`);
console.log(`   ✓ Healthy (<25%):        ${fcDist.healthy}`);
console.log(`   ✓ Target (25-35%):       ${fcDist.target}`);
console.log(`   ⚠ High (35-50%):         ${fcDist.high}`);
console.log(`   ✗ Bleeding (>50%):       ${fcDist.bleeding}`);
console.log(`   ? Unknown (no sale ref): ${fcDist.unknown}`);

if (unmatched.length > 0) {
  console.log(`\n⚠ ${unmatched.length} recipes with no matching POS sale (price set to 0):`);
  for (const n of unmatched.slice(0, 30)) console.log(`   - ${n}`);
  if (unmatched.length > 30) console.log(`   ...and ${unmatched.length - 30} more`);
}
