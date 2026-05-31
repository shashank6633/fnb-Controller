/**
 * FP (Function Prospectus) → Material Estimation Engine
 *
 * Pure library. No API calls, no side effects. Given a parsed FP (event metadata,
 * menu items, bar brands) and the better-sqlite3 database handle, returns a list
 * of MaterialEstimate rows that pre-fill a Party Requisition.
 *
 * Resolution priority for each dish:
 *   1. Recipe match (exact / cleaned / token-overlap) → multiply per-portion
 *      ingredients by guest_count. Confidence: 'high'.
 *   2. Per-head category default (e.g. 200g chicken curry cut per guest for a
 *      non-veg chicken main). Confidence: 'medium'.
 *   3. Skip — leave it for manual entry. (Don't emit a 'low'-confidence guess
 *      we can't actually back with a material.)
 *
 * Bar brands resolve via fuzzy name match to raw_materials, then per-head ml
 * standards over the serving window. Confidence: 'medium' (brand-known) or
 * 'low' (generic category fallback).
 *
 * Aggregation: rows with the same material_id are summed and their reasoning
 * strings concatenated with '; '.
 */

import type Database from 'better-sqlite3';

// ───────────────────────── Types ─────────────────────────

export interface ParsedFP {
  event_name?: string;
  event_date?: string;
  guest_count: number;
  serving_hours?: number;
  package_name?: string;
  menu: {
    veg_starters: string[];
    nonveg_starters: string[];
    veg_mains: string[];
    nonveg_mains: string[];
    rice: string[];
    salad: string[];
    dal: string[];
    desserts: string[];
    accompaniments: string[];
  };
  bar: {
    brands: string[];
    cocktail_count: number;
    mocktail_count: number;
    has_aerated: boolean;
    serving_hours: number;
    notes?: string;
  };
}

export interface MaterialEstimate {
  material_id: string;
  material_name: string;
  unit: string;
  quantity: number;
  reasoning: string;
  source: 'recipe' | 'per-head-default' | 'bar-standard';
  confidence: 'high' | 'medium' | 'low';
}

// Internal shape returned by the recipe-ingredients join.
interface RecipeIngredientRow {
  material_id: string;
  quantity: number;
  unit: string;
  name: string;
  mat_unit: string;
}

interface RecipeRow { id: string; name: string }
interface RawMaterialRow { id: string; name: string; unit: string }

// ───────────────────────── Tokenisation helpers ─────────────────────────

/**
 * Lowercase + strip punctuation + drop noise words ("style", "live", "gravy",
 * "nsp", "peri peri", "veg", "non veg"). Keeps tokens of length >= 3.
 */
function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[()\/]/g, ' ')
    .replace(/\b(style|live|gravy|nsp|peri peri|veg|non[\s-]?veg)\b/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

/** Jaccard similarity over token sets — 0..1. */
function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  const common = [...A].filter((t) => B.has(t)).length;
  return common / (A.size + B.size - common || 1);
}

/** Strip common dish-name noise to produce a "cleaned" candidate string. */
function cleanDishName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\/\s*non[\s-]?veg/g, ' ')
    .replace(/\b(style|live|gravy|nsp|peri peri)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ───────────────────────── Recipe lookup ─────────────────────────

/**
 * Resolve a dish name to a recipe row. Tries exact (case-insensitive),
 * cleaned exact, then token-overlap > 0.6 across all active recipes.
 * Returns null if nothing crosses the threshold.
 */
function findRecipe(
  db: Database.Database,
  dishName: string,
  allRecipes: RecipeRow[],
): RecipeRow | null {
  const lower = dishName.toLowerCase().trim();

  // 1. Exact (case-insensitive)
  const exact = db
    .prepare('SELECT id, name FROM recipes WHERE LOWER(name) = ? AND is_active = 1 LIMIT 1')
    .get(lower) as RecipeRow | undefined;
  if (exact) return exact;

  // 2. Cleaned exact
  const cleaned = cleanDishName(dishName);
  if (cleaned !== lower) {
    const cleanedExact = db
      .prepare('SELECT id, name FROM recipes WHERE LOWER(name) = ? AND is_active = 1 LIMIT 1')
      .get(cleaned) as RecipeRow | undefined;
    if (cleanedExact) return cleanedExact;
  }

  // 3. Token overlap > 0.6 — scan all active recipes (typically a few hundred,
  //    cheap enough for an estimation step done once per FP upload).
  const dishTokens = tokens(dishName);
  if (dishTokens.length === 0) return null;

  let best: RecipeRow | null = null;
  let bestScore = 0.6; // threshold
  for (const r of allRecipes) {
    const score = jaccard(dishTokens, tokens(r.name));
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

// ───────────────────────── Per-head defaults ─────────────────────────

/**
 * Default material draw, in the material's recipe unit (grams for solids,
 * ml for liquids, pcs for piece-counted things), per guest.
 *
 * Buckets are inferred from dish name keywords below.
 */
const PER_HEAD_DEFAULTS: Record<string, Record<string, number>> = {
  nonveg_main_chicken: { 'CHICKEN CURRY CUT': 200 },
  nonveg_main_mutton:  { 'MUTTON CURRY CUT': 180 },
  nonveg_main_fish:    { 'KING FISH': 150 },
  nonveg_main_prawn:   { 'PRAWNS 80/100': 120 },
  veg_main_paneer:     { 'PANEER': 150 },
  veg_main_other:      {}, // too generic — skip
  rice:                { 'BASMATI RICE': 100 },
  dal:                 { 'TOOR DAL': 40 },
  bread:               { 'AASHIRVAAD ATTA': 50 },
  veg_starter_paneer:  { 'PANEER': 60 },
  veg_starter_other:   {},
  nonveg_starter_chicken: { 'CHICKEN BREAST BONELESS': 80 },
  nonveg_starter_fish:    { 'KING FISH': 60 },
  nonveg_starter_prawn:   { 'PRAWNS 80/100': 60 },
  dessert_dairy:       { 'MILK 500 ML': 50, 'SUGAR': 30 },
};

/** Map a dish name + section to one of the bucket keys above. */
function bucketForDish(
  dishName: string,
  section: 'veg_starter' | 'nonveg_starter' | 'veg_main' | 'nonveg_main' | 'rice' | 'dal' | 'dessert' | 'bread' | 'other',
): string | null {
  const n = dishName.toLowerCase();
  switch (section) {
    case 'nonveg_main':
      if (/chicken|murgh/.test(n)) return 'nonveg_main_chicken';
      if (/mutton|lamb|gosht/.test(n)) return 'nonveg_main_mutton';
      if (/fish|machli|pomfret/.test(n)) return 'nonveg_main_fish';
      if (/prawn|jhinga|shrimp/.test(n)) return 'nonveg_main_prawn';
      return 'nonveg_main_chicken'; // safest default for a non-veg main
    case 'veg_main':
      if (/paneer/.test(n)) return 'veg_main_paneer';
      return 'veg_main_other';
    case 'nonveg_starter':
      if (/chicken|murgh|tikka|kebab/.test(n)) return 'nonveg_starter_chicken';
      if (/fish|machli/.test(n)) return 'nonveg_starter_fish';
      if (/prawn|jhinga/.test(n)) return 'nonveg_starter_prawn';
      return 'nonveg_starter_chicken';
    case 'veg_starter':
      if (/paneer/.test(n)) return 'veg_starter_paneer';
      return 'veg_starter_other';
    case 'rice': return 'rice';
    case 'dal':  return 'dal';
    case 'bread': return 'bread';
    case 'dessert':
      if (/kheer|phirni|rabri|kulfi|payasam|halwa|gulab|jamun|rasmalai/.test(n)) return 'dessert_dairy';
      return null;
    default:
      return null;
  }
}

// ───────────────────────── Bar standards ─────────────────────────

const BAR_DEFAULTS = {
  premium_whisky_per_head_ml: 60,  // ~2 × 30ml pegs
  wine_per_head_ml:           60,
  vodka_gin_rum_per_head_ml:  30,
  beer_per_head_bottles:      1,   // 1 × 330ml bottle
  mocktail_per_head:          1,
  cocktail_per_head:          1,
  soft_drink_per_head_ml:     200,
};

/**
 * Categorise a bar brand string so we know which per-head ml figure to apply.
 * Returns null if we can't tell (we'll fall back to vodka_gin_rum default).
 */
function classifyBarBrand(brand: string): keyof typeof BAR_DEFAULTS | null {
  const b = brand.toLowerCase();
  if (/whisky|whiskey|scotch|black dog|100 pipers|chivas|jw|johnnie|teacher|glenfiddich/.test(b)) return 'premium_whisky_per_head_ml';
  if (/wine|sula|cabernet|merlot|chardonnay|sauvignon|shiraz/.test(b)) return 'wine_per_head_ml';
  if (/vodka|smirnoff|absolut|grey goose|gin|bombay|tanqueray|rum|bacardi|old monk/.test(b)) return 'vodka_gin_rum_per_head_ml';
  if (/beer|kingfisher|heineken|corona|budweiser|tuborg|carlsberg/.test(b)) return 'beer_per_head_bottles';
  return null;
}

// ───────────────────────── Aggregation ─────────────────────────

/**
 * Push an estimate into the accumulator, summing quantity and concatenating
 * reasoning if we already have a row for this material_id. The lowest
 * confidence wins (so an aggregate of high+medium reports as medium).
 */
function addEstimate(acc: Map<string, MaterialEstimate>, est: MaterialEstimate): void {
  const existing = acc.get(est.material_id);
  if (!existing) {
    acc.set(est.material_id, { ...est });
    return;
  }
  existing.quantity += est.quantity;
  existing.reasoning = `${existing.reasoning}; ${est.reasoning}`;
  // Downgrade confidence if mixing
  const rank = { high: 3, medium: 2, low: 1 } as const;
  if (rank[est.confidence] < rank[existing.confidence]) {
    existing.confidence = est.confidence;
  }
}

// ───────────────────────── Main estimator ─────────────────────────

export async function estimateMaterialsForFP(
  db: Database.Database,
  fp: ParsedFP,
): Promise<MaterialEstimate[]> {
  const guests = fp.guest_count;
  if (!guests || guests <= 0) return [];

  // Preload all active recipes once for the fuzzy-match scan.
  const allRecipes = db
    .prepare('SELECT id, name FROM recipes WHERE is_active = 1')
    .all() as RecipeRow[];

  const ingredientStmt = db.prepare(`
    SELECT ri.material_id  AS material_id,
           ri.quantity     AS quantity,
           ri.unit         AS unit,
           rm.name         AS name,
           rm.unit         AS mat_unit
    FROM recipe_ingredients ri
    JOIN raw_materials rm ON rm.id = ri.material_id
    WHERE ri.recipe_id = ?
  `);

  // Cache material-name lookups (for per-head defaults). Case-insensitive
  // exact match on raw_materials.name.
  const materialByNameStmt = db.prepare(
    'SELECT id, name, unit FROM raw_materials WHERE UPPER(name) = UPPER(?) LIMIT 1',
  );
  const materialByLikeStmt = db.prepare(
    "SELECT id, name, unit FROM raw_materials WHERE UPPER(name) LIKE UPPER(?) LIMIT 1",
  );
  const materialNameCache = new Map<string, RawMaterialRow | null>();
  function lookupMaterial(name: string): RawMaterialRow | null {
    if (materialNameCache.has(name)) return materialNameCache.get(name)!;
    let row = materialByNameStmt.get(name) as RawMaterialRow | undefined;
    if (!row) row = materialByLikeStmt.get(`%${name}%`) as RawMaterialRow | undefined;
    const result = row ?? null;
    materialNameCache.set(name, result);
    return result;
  }

  const acc = new Map<string, MaterialEstimate>();

  // ── Walk the menu sections ──
  const sections: Array<{
    items: string[];
    section: Parameters<typeof bucketForDish>[1];
    label: string;
  }> = [
    { items: fp.menu.veg_starters,    section: 'veg_starter',    label: 'veg starter' },
    { items: fp.menu.nonveg_starters, section: 'nonveg_starter', label: 'non-veg starter' },
    { items: fp.menu.veg_mains,       section: 'veg_main',       label: 'veg main' },
    { items: fp.menu.nonveg_mains,    section: 'nonveg_main',    label: 'non-veg main' },
    { items: fp.menu.rice,            section: 'rice',           label: 'rice' },
    { items: fp.menu.dal,             section: 'dal',            label: 'dal' },
    { items: fp.menu.desserts,        section: 'dessert',        label: 'dessert' },
    { items: fp.menu.accompaniments,  section: 'bread',          label: 'bread / accompaniment' },
    // salad intentionally ignored — too varied for sensible defaults
  ];

  for (const { items, section, label } of sections) {
    for (const dish of items ?? []) {
      if (!dish || !dish.trim()) continue;

      // ── 1. Recipe match ──
      const recipe = findRecipe(db, dish, allRecipes);
      if (recipe) {
        const rows = ingredientStmt.all(recipe.id) as RecipeIngredientRow[];
        for (const r of rows) {
          // Recipe ingredients are stored per-portion. Scale by guest count.
          const qty = r.quantity * guests;
          addEstimate(acc, {
            material_id: r.material_id,
            material_name: r.name,
            unit: r.mat_unit || r.unit,
            quantity: qty,
            reasoning: `${guests} guests × ${r.quantity}${r.unit} ${r.name} (from ${recipe.name} recipe) = ${qty.toFixed(2)}${r.mat_unit || r.unit}`,
            source: 'recipe',
            confidence: 'high',
          });
        }
        continue;
      }

      // ── 2. Per-head default ──
      const bucket = bucketForDish(dish, section);
      if (!bucket) continue;
      const defaults = PER_HEAD_DEFAULTS[bucket];
      if (!defaults || Object.keys(defaults).length === 0) continue;

      for (const [matName, perHead] of Object.entries(defaults)) {
        const mat = lookupMaterial(matName);
        if (!mat) continue; // can't resolve → skip silently
        const qty = perHead * guests;
        addEstimate(acc, {
          material_id: mat.id,
          material_name: mat.name,
          unit: mat.unit,
          quantity: qty,
          reasoning: `${guests} guests × ${perHead}${mat.unit} ${mat.name} (default for ${label}: ${dish}) = ${qty.toFixed(2)}${mat.unit}`,
          source: 'per-head-default',
          confidence: 'medium',
        });
      }
    }
  }

  // ── 3. Bar brands ──
  const barHours = fp.bar.serving_hours || fp.serving_hours || 2.5;

  for (const brand of fp.bar.brands ?? []) {
    if (!brand || !brand.trim()) continue;

    // Fuzzy-match brand string to a raw_material via LIKE on the first token.
    // ("Black Dog" → "BLACK DOG …(750ML)")
    const firstWord = brand.trim().split(/\s+/)[0];
    let mat = lookupMaterial(brand);
    if (!mat) mat = lookupMaterial(firstWord);
    if (!mat) continue;

    const category = classifyBarBrand(brand) ?? 'vodka_gin_rum_per_head_ml';
    let perHeadMl = 0;
    if (category === 'beer_per_head_bottles') {
      perHeadMl = BAR_DEFAULTS.beer_per_head_bottles * 330;
    } else {
      perHeadMl = BAR_DEFAULTS[category] as number;
    }

    const totalMl = perHeadMl * guests;
    // If the material's unit is ml/litre, emit ml; otherwise just emit the
    // number in ml and let the downstream UI convert via the material's
    // recipe_unit/conversion_factor.
    addEstimate(acc, {
      material_id: mat.id,
      material_name: mat.name,
      unit: mat.unit,
      quantity: totalMl,
      reasoning: `${guests} guests × ${perHeadMl}ml ${brand} over ${barHours}h (${category.replace(/_/g, ' ')}) = ${totalMl}ml`,
      source: 'bar-standard',
      confidence: 'medium',
    });
  }

  // Mocktails / cocktails / aerated — pure per-head counts. We don't try to
  // resolve specific juice/syrup materials; an FP rarely lists them.
  // Aerated drinks: assume a generic "AERATED WATER" or "SOFT DRINK" SKU.
  if (fp.bar.has_aerated) {
    const aerated = lookupMaterial('AERATED') ?? lookupMaterial('SOFT DRINK') ?? lookupMaterial('COKE');
    if (aerated) {
      const totalMl = BAR_DEFAULTS.soft_drink_per_head_ml * guests;
      addEstimate(acc, {
        material_id: aerated.id,
        material_name: aerated.name,
        unit: aerated.unit,
        quantity: totalMl,
        reasoning: `${guests} guests × ${BAR_DEFAULTS.soft_drink_per_head_ml}ml aerated drinks = ${totalMl}ml`,
        source: 'bar-standard',
        confidence: 'low',
      });
    }
  }

  // Round all quantities to 2dp for tidy display.
  const out: MaterialEstimate[] = [];
  for (const est of acc.values()) {
    est.quantity = Math.round(est.quantity * 100) / 100;
    out.push(est);
  }

  // Sort: recipe-sourced first, then per-head, then bar; alphabetical inside.
  const sourceRank = { recipe: 0, 'per-head-default': 1, 'bar-standard': 2 };
  out.sort((a, b) => {
    const s = sourceRank[a.source] - sourceRank[b.source];
    return s !== 0 ? s : a.material_name.localeCompare(b.material_name);
  });

  return out;
}
