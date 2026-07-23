import { getDb, generateId, recalculateRecipeCost, updateMaterialPrice, recalculateCostsForMaterials } from '@/lib/db';
import { requireRole } from '@/lib/auth';

interface LiquorRawRow {
  name: string;
  rate: number;
  category: string;
  purchaseUnit: string;
  consumptionUnit: string;
}

interface RecipeRow {
  recipeName: string;
  matName: string;
  qty: number;
  unit: string;
  isSemi: boolean;
}

interface BarProductRow {
  name: string;
  category: string;
  sellingPrice: number;
  status: string;
}

// Category mapping from Bar Costing → system
function mapCategory(cat: string): string {
  const c = cat.toUpperCase();
  if (['BEER', 'LIQUEUR', 'SINGLEMALT', 'SINGLE MALT', 'BLENDED SCOTCH', 'BLENDED-SCOTCH',
       'VODKA', 'GIN', 'RUM', 'TEQUILA', 'WHISKY', 'WHISKEY', 'BOURBON', 'COGNAC',
       'WINE', 'CHAMPAGNE', 'SPARKLING', 'APERITIF', 'BITTERS'].some(k => c.includes(k))) {
    return 'bar';
  }
  if (['JUICE', 'SYRUP', 'PUREE', 'TONIC', 'SODA', 'COLA', 'MIXER'].some(k => c.includes(k))) {
    return 'beverages';
  }
  if (['MILK', 'CREAM', 'BUTTER', 'YOGURT', 'CHEESE'].some(k => c.includes(k))) {
    return 'dairy';
  }
  return 'other';
}

// Unit normalization & conversion
// Returns [normalizedUnit, conversionFactor] where qty * factor = qty in normalizedUnit
function normalizeUnit(rawUnit: string, rawQty: number, materialPurchaseUnit: string): { unit: string; qty: number } {
  const u = String(rawUnit || '').trim().toUpperCase().replace(/[,;]/g, '').trim();
  const qty = rawQty;

  // Direct passthrough
  if (u === 'ML' || u === 'MILLILITER' || u === 'MILLILITRE') return { unit: 'ml', qty };
  if (u === 'L' || u === 'LTR' || u === 'LITER') return { unit: 'ml', qty: qty * 1000 };
  if (u === 'GM' || u === 'GMS' || u === 'G' || u === 'GRAM') return { unit: 'g', qty };
  if (u === 'KG' || u === 'KILO') return { unit: 'g', qty: qty * 1000 };
  if (u === 'PCS' || u === 'NO' || u === 'SMALL PCS') return { unit: 'pcs', qty };

  // Conversions
  if (u === 'PINCH') return { unit: 'g', qty: qty * 1 }; // 1 pinch ≈ 1g
  if (u === 'DASHES' || u === 'DASH') return { unit: 'ml', qty: qty * 1 }; // 1 dash ≈ 1ml
  if (u === 'TSPN' || u === 'TSP' || u === 'TEASPOON') return { unit: 'ml', qty: qty * 5 };
  if (u === 'BSPN' || u === 'BAR SPOON' || u === 'BARSPOON') return { unit: 'ml', qty: qty * 5 };
  if (u === 'DROPS' || u === 'DROP') return { unit: 'ml', qty: qty * 0.05 }; // 1 drop ≈ 0.05ml
  if (u === 'LEAF' || u === 'LEAVES') return { unit: 'pcs', qty };
  if (u === 'WEDGE' || u === 'WEDGES') return { unit: 'pcs', qty };
  if (u === 'SPRIG' || u === 'SPRIGS') return { unit: 'g', qty: qty * 2 };
  if (u === 'SMALL CHUNK' || u === 'SMALL CHUNKS') return { unit: 'g', qty: qty * 5 };

  // BTL → ML based on bottle size from material's purchase unit (e.g., 'BTL (750ML)' → 750)
  if (u === 'BTL' || u === 'BOTTLE') {
    const sizeMatch = (materialPurchaseUnit || '').match(/(\d+)\s*ML/i);
    const size = sizeMatch ? parseInt(sizeMatch[1]) : 750; // Default 750ml if unknown
    return { unit: 'ml', qty: qty * size };
  }

  // Default fallback
  return { unit: u.toLowerCase() || 'pcs', qty };
}

// Auto-fix broken quantities (Excel date-serial values that got pasted as quantities)
function fixQuantity(rawQty: number, matName: string): { qty: number; fixed: boolean } {
  const original = rawQty;
  // Values between 40000-50000 are Excel date serials — not legitimate ingredient quantities
  if (rawQty < 5000) return { qty: rawQty, fixed: false };

  const name = matName.toUpperCase();
  // Apply sensible defaults based on ingredient
  if (name.includes('MINT') || name.includes('BASIL') || name.includes('LEMON BASIL')) return { qty: 5, fixed: true };
  if (name.includes('KAFFIRLIME') || name.includes('KAFFIR LIME')) return { qty: 2, fixed: true };
  if (name.includes('CLOVES') || name.includes('CARDMOM') || name.includes('CARDAMOM')) return { qty: 2, fixed: true };
  if (name.includes('CUCUMBER')) return { qty: 50, fixed: true };
  if (name.includes('BEETROOT') || name.includes('BEET')) return { qty: 30, fixed: true };
  // Generic fallback for garnish-type items
  return { qty: 5, fixed: true };
}

// Typo fixes on material names
function fixMatName(name: string): string {
  let fixed = name.trim();
  fixed = fixed.replace(/VERMOTH/gi, 'VERMOUTH');
  fixed = fixed.replace(/DECOCOTION/gi, 'DECOCTION');
  return fixed;
}

// Normalize material name for matching (case-insensitive, whitespace-normalized)
function normKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Try to find a material by fuzzy matching (handles "APEROL APERITIF 750ML" vs "APEROL APERITIF (750ML)")
function findMaterialFuzzy(name: string, materialMap: Map<string, any>): any | null {
  const exact = materialMap.get(normKey(name));
  if (exact) return exact;

  const normSimple = normKey(name).replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
  for (const [key, mat] of materialMap) {
    const keySimple = key.replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
    if (keySimple === normSimple) return mat;
  }

  // Try matching without "BOTTLE" suffix
  const withoutBottle = normKey(name).replace(/\s+bottle\s*$/, '');
  if (withoutBottle !== normKey(name)) {
    for (const [key, mat] of materialMap) {
      if (key.startsWith(withoutBottle) || key.replace(/[()]/g, '').replace(/\s+/g, ' ').trim().startsWith(withoutBottle)) {
        return mat;
      }
    }
  }

  return null;
}

export async function POST(request: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });
  try {
    const db = getDb();
    const body = await request.json();
    const {
      liquor_raw = [],
      recipes = [],
      bar_products = [],
      overwrite_existing = true,
      skip_beer_direct_sale = true,
    } = body as {
      liquor_raw: LiquorRawRow[];
      recipes: RecipeRow[];
      bar_products: BarProductRow[];
      overwrite_existing?: boolean;
      skip_beer_direct_sale?: boolean;
    };

    const report = {
      materials_created: 0,
      materials_updated: 0,
      materials_price_updated: 0,
      materials_price_skipped_unit_mismatch: 0,
      recipes_created: 0,
      recipes_updated: 0,
      recipes_skipped_empty: 0,
      recipes_skipped_exists: 0,
      fixes_applied: [] as string[],
      unit_conversions: 0,
      ingredients_not_matched: [] as string[],
      errors: [] as string[],
    };

    // ---- 1) Import Liquor Raw → raw_materials ----
    const existingMaterials = db.prepare('SELECT id, name, average_price, unit, current_stock FROM raw_materials').all() as any[];
    const materialMap = new Map<string, any>();
    for (const m of existingMaterials) {
      materialMap.set(normKey(m.name), m);
    }

    const ingestMaterial = db.prepare(`
      INSERT INTO raw_materials (id, name, category, unit, reorder_level, costing_method, average_price, created_at, updated_at)
      VALUES (?, ?, ?, ?, 5, 'average', ?, datetime('now'), datetime('now'))
    `);
    const updateMatPrice = db.prepare(`
      UPDATE raw_materials SET average_price = ?, updated_at = datetime('now') WHERE id = ?
    `);
    // Materials whose price this import changed — their dependent recipes'
    // stored totals must be recalculated after the import.
    const priceTouchedIds: string[] = [];

    const importMaterials = db.transaction(() => {
      for (const raw of liquor_raw) {
        if (!raw.name) continue;
        const name = fixMatName(raw.name);
        const key = normKey(name);
        const existing = materialMap.get(key);

        // Extract base unit (ml/g/pcs) from consumption/purchase unit
        const unitRaw = (raw.consumptionUnit || raw.purchaseUnit || '').toUpperCase();
        let baseUnit = 'pcs';
        if (unitRaw.includes('ML') || unitRaw === 'ML') baseUnit = 'ml';
        else if (unitRaw.includes('GM') || unitRaw.includes('G')) baseUnit = 'g';
        else if (unitRaw.includes('BTL') || unitRaw.includes('CAN') || unitRaw.includes('BOTTLE')) baseUnit = 'ml';

        const category = mapCategory(raw.category || '');

        // Convert purchase rate → rate per smallest unit (ml, g, pcs)
        // Strategy: try purchase unit first; if no size, extract from material name; else use sensible default
        let avgPrice = raw.rate || 0;
        const pu = (raw.purchaseUnit || '').toUpperCase();
        const nameU = name.toUpperCase();

        function extractSize(text: string, targetUnit: 'ml' | 'g'): number | null {
          if (targetUnit === 'ml') {
            const m = text.match(/(\d+(?:\.\d+)?)\s*(ML|LTR?|LITER|LITRE)\b/i);
            if (m) {
              const s = parseFloat(m[1]);
              const u = m[2].toUpperCase();
              return (u === 'LTR' || u === 'L' || u === 'LITRE' || u === 'LITER') ? s * 1000 : s;
            }
          } else {
            const m = text.match(/(\d+(?:\.\d+)?)\s*(KG|GMS?|G)\b/i);
            if (m) {
              const s = parseFloat(m[1]);
              const u = m[2].toUpperCase();
              return u === 'KG' ? s * 1000 : s;
            }
          }
          return null;
        }

        if (baseUnit === 'ml') {
          let sizeMl: number | null = extractSize(pu, 'ml');
          if (!sizeMl) sizeMl = extractSize(nameU, 'ml');
          if (!sizeMl) {
            // Apply sensible defaults based on container
            if (pu.includes('BTL') || pu.includes('BOTTLE')) sizeMl = 750;
            else if (pu.includes('CAN')) sizeMl = 330;
            else if (pu.includes('PKT') || pu.includes('POUCH')) sizeMl = 500;
            else if (pu.includes('LTR') || pu === 'L') sizeMl = 1000;
            else if (pu === 'ML') sizeMl = 1;
            else sizeMl = 1; // Last resort
          }
          avgPrice = sizeMl > 0 ? raw.rate / sizeMl : raw.rate;
        } else if (baseUnit === 'g') {
          let sizeG: number | null = extractSize(pu, 'g');
          if (!sizeG) sizeG = extractSize(nameU, 'g');
          if (!sizeG) {
            if (pu.includes('BTL') || pu.includes('BOTTLE')) sizeG = 325;
            else if (pu.includes('PKT') || pu.includes('POUCH') || pu.includes('BAG')) sizeG = 1000;
            else if (pu.includes('KG')) sizeG = 1000;
            else sizeG = 1;
          }
          avgPrice = sizeG > 0 ? raw.rate / sizeG : raw.rate;
        }
        avgPrice = Math.round(avgPrice * 10000) / 10000; // 4 decimal precision

        if (existing) {
          // avgPrice above is denominated in the sheet-derived base unit (ml/g/pcs).
          // If the DB material is tracked in a different recipe unit (e.g. a beer
          // stored as 'pcs' per bottle), writing a per-ml rate would deflate every
          // dependent cost — skip the price write and leave the row for manual review.
          // The material still participates in recipe matching below.
          if ((existing.unit || '') !== baseUnit) {
            report.materials_price_skipped_unit_mismatch++;
          } else {
            // Update price if changed significantly
            if (Math.abs((existing.average_price || 0) - avgPrice) > 0.001 && avgPrice > 0) {
              updateMatPrice.run(avgPrice, existing.id);
              priceTouchedIds.push(existing.id);
              report.materials_price_updated++;
            } else {
              report.materials_updated++;
            }
            materialMap.set(key, { ...existing, average_price: avgPrice, unit: baseUnit });
          }
        } else {
          const id = generateId();
          ingestMaterial.run(id, name, category, baseUnit, avgPrice);
          materialMap.set(key, { id, name, average_price: avgPrice, unit: baseUnit, current_stock: 0 });
          report.materials_created++;
        }
      }
    });
    importMaterials();
    // Recipes/sub-recipes elsewhere in the book may use these materials too —
    // keep their stored totals in sync with the imported prices.
    recalculateCostsForMaterials(db, priceTouchedIds);

    // ---- 2) Build selling price lookup from BAR PRODUCTS ----
    const priceMap = new Map<string, number>();
    for (const p of bar_products) {
      if (p.name && p.sellingPrice > 0) {
        priceMap.set(normKey(p.name), p.sellingPrice);
      }
    }

    // ---- 3) Group recipes by recipe name ----
    const recipeGroups = new Map<string, RecipeRow[]>();
    for (const r of recipes) {
      if (!r.recipeName) continue;
      const name = r.recipeName.trim();
      if (!recipeGroups.has(name)) recipeGroups.set(name, []);
      recipeGroups.get(name)!.push(r);
    }

    // ---- 4) Import Recipes ----
    const existingRecipes = db.prepare("SELECT id, name FROM recipes WHERE is_active = 1").all() as any[];
    const existingRecipeMap = new Map<string, string>();
    for (const r of existingRecipes) existingRecipeMap.set(normKey(r.name), r.id);

    const ingestRecipe = db.prepare(`
      INSERT INTO recipes (id, name, category, selling_price, total_cost, version, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, 1, 1, datetime('now'), datetime('now'))
    `);
    const clearIngredients = db.prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?');
    const ingestIngredient = db.prepare(`
      INSERT INTO recipe_ingredients (id, recipe_id, material_id, quantity, unit, yield_percent, wastage_percent, is_default, brand_preference)
      VALUES (?, ?, ?, ?, ?, 100, 0, 1, '')
    `);
    const updateRecipeMeta = db.prepare(`
      UPDATE recipes SET category = ?, selling_price = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?
    `);

    // Determine category helper for recipes from product listing
    const categoryForRecipe = (recipeName: string, ingredients: RecipeRow[]): string => {
      const prod = bar_products.find(p => normKey(p.name) === normKey(recipeName));
      if (prod?.category) {
        const pc = prod.category.toLowerCase();
        if (pc.includes('beer')) return 'bar-beer';
        if (pc.includes('scotch') || pc.includes('whisky') || pc.includes('whiskey')) return 'bar-whisky';
        if (pc.includes('vodka')) return 'bar-vodka';
        if (pc.includes('rum')) return 'bar-rum';
        if (pc.includes('gin')) return 'bar-gin';
        if (pc.includes('tequila')) return 'bar-tequila';
        if (pc.includes('wine') || pc.includes('champagne')) return 'bar-wine';
        if (pc.includes('cocktail')) return 'bar-cocktail';
        if (pc.includes('mocktail') || pc.includes('virgin')) return 'bar-mocktail';
        if (pc.includes('mixer') || pc.includes('soda')) return 'bar-soda';
      }
      // Infer from ingredients
      const hasAlcohol = ingredients.some(i => {
        const name = (i.matName || '').toUpperCase();
        return /VODKA|GIN|RUM|WHIS|TEQUILA|BOURBON|COGNAC|SCOTCH|PIPERS|BACARDI|SMIRNOFF|JIMBEAM|CHIVAS|GREATER|GLENL|GLENF|SINGLETON|TALISKER|JAGER|KAHLUA|BAILEY|CAMPARI|APEROL|VERMOUTH|APERITIF/.test(name);
      });
      return hasAlcohol ? 'bar-cocktail' : 'bar-mocktail';
    };

    const importRecipes = db.transaction(() => {
      for (const [recipeName, items] of recipeGroups) {
        // Skip if empty / no ingredients
        const validItems = items.filter(it => it.matName && it.qty > 0);
        if (validItems.length === 0) {
          report.recipes_skipped_empty++;
          continue;
        }

        // Skip direct-sale beer products (if enabled)
        if (skip_beer_direct_sale) {
          const prod = bar_products.find(p => normKey(p.name) === normKey(recipeName));
          if (prod && prod.category?.toLowerCase().includes('beer') && validItems.length === 0) {
            report.recipes_skipped_empty++;
            continue;
          }
        }

        // Existing recipe?
        const existingId = existingRecipeMap.get(normKey(recipeName));
        if (existingId && !overwrite_existing) {
          report.recipes_skipped_exists++;
          continue;
        }

        const sellingPrice = priceMap.get(normKey(recipeName)) || 0;
        const category = categoryForRecipe(recipeName, validItems);

        let recipeId: string;
        if (existingId) {
          recipeId = existingId;
          clearIngredients.run(recipeId);
          updateRecipeMeta.run(category, sellingPrice, recipeId);
          report.recipes_updated++;
        } else {
          recipeId = generateId();
          ingestRecipe.run(recipeId, recipeName, category, sellingPrice);
          report.recipes_created++;
        }

        // Add ingredients with auto-fixes
        for (const item of validItems) {
          const matName = fixMatName(item.matName);
          const material = findMaterialFuzzy(matName, materialMap);

          if (!material) {
            report.ingredients_not_matched.push(`${recipeName}: ${matName}`);
            continue;
          }

          // Auto-fix broken quantity
          const { qty: fixedQty, fixed } = fixQuantity(item.qty, matName);
          if (fixed) {
            report.fixes_applied.push(`${recipeName} → ${matName}: ${item.qty} → ${fixedQty} (broken date-serial value corrected)`);
          }

          // Normalize unit
          const matPurchaseUnit = (liquor_raw.find(r => normKey(fixMatName(r.name)) === normKey(matName))?.purchaseUnit) || '';
          const { unit: normUnit, qty: finalQty } = normalizeUnit(item.unit, fixedQty, matPurchaseUnit);

          const origUnit = (item.unit || '').trim().toUpperCase();
          if (origUnit && origUnit !== normUnit.toUpperCase() && origUnit !== 'ML' && origUnit !== 'G' && origUnit !== 'PCS' && origUnit !== 'GM' && origUnit !== 'GMS' && origUnit !== 'NO') {
            report.unit_conversions++;
          }

          ingestIngredient.run(generateId(), recipeId, material.id, finalQty, normUnit);
        }

        // Recalculate cost
        recalculateRecipeCost(db, recipeId);
      }
    });
    importRecipes();

    // Dedupe ingredients_not_matched
    report.ingredients_not_matched = [...new Set(report.ingredients_not_matched)];

    return Response.json(report);
  } catch (error: any) {
    return Response.json({ error: error.message, stack: error.stack }, { status: 500 });
  }
}
