#!/usr/bin/env node
/**
 * Backfill recipes.category from related sales/menu_items.
 *
 * The xlsx import didn't carry forward a category. But every recipe maps to
 * a POS item that DOES have a category (Bar, Small Plates Non Veg, Breads,
 * Mocktails, etc.). For each recipe we:
 *   1. Find the matching sale by exact / cleaned name
 *   2. Pick the dominant sales.category for that name (mode)
 *   3. Normalise capitalisation ("small-plates-non-veg" → "Small Plates Non Veg")
 *   4. Coarse-bucket into the high-level groups the user thinks in:
 *        Bar  · Food · Bakery · Party  · Other
 */

const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, '..', 'fnb-controller.db'));

const norm = s => String(s || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

const titleCase = s => String(s || '')
  .replace(/[-_]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .split(' ')
  .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
  .join(' ');

// Coarse-bucket so the chip filter has a small, useful set instead of 30+ chips
function coarseBucket(category) {
  const c = (category || '').toLowerCase();
  if (/\b(beer|wine|whisk|whiskies|whiskey|vodka|gin|rum|tequila|cocktail|mocktail|liqueur|bar|spirit|scotch|bitter|crush|liquor|brandy|champagne)\b/.test(c)) return 'Bar';
  if (/\b(soft|beverage|juice|water|soda)\b/.test(c)) return 'Beverages';
  if (/\b(party|custom)\b/.test(c)) return 'Party / Custom';
  if (/\b(bread|naan|roti)\b/.test(c)) return 'Breads';
  if (/\b(brunch|breakfast)\b/.test(c)) return 'Brunch';
  if (/\b(small\s*plate|kebab|starter|appetizer|nibble)\b/.test(c)) return 'Small Plates';
  if (/\b(rice|noodle|biryani|main|curry)\b/.test(c)) return 'Mains';
  if (/\b(dessert|sweet|ice\s*cream)\b/.test(c)) return 'Desserts';
  if (/\b(soup|salad)\b/.test(c)) return 'Soups & Salads';
  if (/\b(pizza|sushi|uramaki)\b/.test(c)) return 'International';
  if (!c || c === 'other') return 'Uncategorised';
  return titleCase(category);
}

// Aggregate sales category by item_name (case-insensitive)
const salesByName = new Map();
const rows = db.prepare(`SELECT item_name, category, COUNT(*) AS n FROM sales
  WHERE category IS NOT NULL AND category != '' GROUP BY item_name, category`).all();
for (const r of rows) {
  const k = norm(r.item_name);
  const slot = salesByName.get(k) || new Map();
  slot.set(r.category, (slot.get(r.category) || 0) + r.n);
  salesByName.set(k, slot);
}

function findCategory(recipeName) {
  // 1. Exact name
  const exact = salesByName.get(norm(recipeName));
  if (exact) return [...exact.entries()].sort((a, b) => b[1] - a[1])[0][0];
  // 2. Cleaned name (drop "/ NONVEG", "(VEG)", "GRILL LIVE", "NSP", "PR")
  const cleaned = recipeName
    .replace(/\s*\/.*$/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/\b(grill live|nsp|pr|peri peri|live|grill|gravy)\b/gi, '')
    .replace(/\s+/g, ' ').trim();
  const cleanedHit = salesByName.get(norm(cleaned));
  if (cleanedHit) return [...cleanedHit.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return null;
}

const recipes = db.prepare(`SELECT id, name, category FROM recipes`).all();
console.log(`Backfilling category for ${recipes.length} recipes…\n`);

const upd = db.prepare(`UPDATE recipes SET category = ?, updated_at = datetime('now') WHERE id = ?`);
const stats = { updated: 0, kept: 0, fallback: 0, by_bucket: {} };

const txn = db.transaction(() => {
  for (const r of recipes) {
    const raw = findCategory(r.name);
    let bucket;
    if (raw) {
      bucket = coarseBucket(raw);
      stats.updated++;
    } else {
      // Fallback heuristic — look at the recipe NAME for keywords, then ingredients.
      const n = r.name.toLowerCase();
      if      (/\b(soup|shorba|salad)\b/.test(n))                            bucket = 'Soups & Salads';
      else if (/\b(naan|roti|bread)\b/.test(n))                              bucket = 'Breads';
      else if (/\b(roll|uramaki|sushi|pizza|nsp|quesadilla|tempura|asian)\b/.test(n)) bucket = 'International';
      else if (/\b(kebab|tikka|skewer|kofta|seekh|finger|pakod|popcorn|fries|nibble|crispy|65|nachos|popper|peanut|foxnut|mizze|tikki)\b/.test(n)) bucket = 'Small Plates';
      else if (/\b(grill|tandoori|achari|peri)\b/.test(n))                   bucket = 'Grills';
      else if (/\b(curry|biryani|gravy|stroganoff|paya|murag|hunan|basil|khadai|gongura|ghee\s*roast|telangana)\b/.test(n)) bucket = 'Mains';
      else if (/\b(dessert|sweet|ice\s*cream|kulfi|halwa|payasam)\b/.test(n)) bucket = 'Desserts';
      else if (/\b(juice|cocktail|mocktail|beer|wine)\b/.test(n))            bucket = 'Bar';
      else {
        // Last resort: ingredient signals
        const ing = db.prepare(`SELECT GROUP_CONCAT(rm.name, ' ') AS t FROM recipe_ingredients ri JOIN raw_materials rm ON rm.id = ri.material_id WHERE ri.recipe_id = ?`).get(r.id);
        const t = String(ing?.t || '').toLowerCase();
        if      (/\b(prawn|fish|squid|calamari|mutton|chicken|lamb)\b/.test(t)) bucket = 'Small Plates Non Veg';
        else if (/\b(paneer|broccoli|mushroom|potato|broccoli|corn|cottage)\b/.test(t)) bucket = 'Small Plates Veg';
        else bucket = 'Other';
      }
      stats.fallback++;
    }
    if (bucket && bucket !== r.category) {
      upd.run(bucket, r.id);
      stats.by_bucket[bucket] = (stats.by_bucket[bucket] || 0) + 1;
    } else {
      stats.kept++;
    }
  }
});
txn();

console.log(`✅ Categories backfilled:`);
console.log(`   ${stats.updated} from sales mapping`);
console.log(`   ${stats.fallback} from name/ingredient heuristic`);
console.log(`   ${stats.kept} kept as-is`);
console.log(`\nResulting buckets:`);
for (const [b, n] of Object.entries(stats.by_bucket).sort((a, b) => b[1] - a[1])) {
  console.log(`   ${n.toString().padStart(3)} · ${b}`);
}
