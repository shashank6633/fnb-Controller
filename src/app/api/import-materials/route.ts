import { getDb, generateId } from '@/lib/db';

// Map POS categories to our system categories
function mapCategory(posCategory: string): string {
  const cat = posCategory.trim().toUpperCase();

  // Bar / Alcohol categories
  const barCategories = [
    'VODKA', 'GIN', 'RUM', 'WHISKEY', 'BOURBON', 'TEQUILA', 'BRANDY',
    'BLENDED SCOTCH', 'BLENDED MALT', 'SINGLE MALT WHISKEY', 'IRISH',
    'JAPANESE', 'TENNESSEE', 'LIQUER', 'APERITIF', 'VERMOUTH',
    'RED WINE', 'WHITE WINE', 'SPARKLING WINE', 'WINES [ROSE]', 'WINE',
    'BEER', 'BITTERS',
  ];
  if (barCategories.includes(cat)) return 'bar';

  // Beverages
  const beverageCategories = ['SOFT BEVERAGES', 'JUICES', 'SYRUPS', 'PUREE', 'CRUSH', 'SAUCES'];
  if (beverageCategories.includes(cat)) return 'beverages';

  // Dairy
  if (cat === 'DAIRY PRODUCTS' || cat === 'FROZEN & CHEESE') return 'dairy';

  // Vegetables
  const vegCategories = ['VEGETABLES', 'LOCAL VEGETABLES', 'ENGLISH VEGETABLES'];
  if (vegCategories.includes(cat)) return 'veg';

  // Fruits
  if (cat === 'FRUITS') return 'veg';

  // Non-veg / Meat
  const nonVegCategories = ['MEAT', 'POULTRY', 'POULTY', 'SEAFOOD'];
  if (nonVegCategories.includes(cat)) return 'non-veg';

  // Grocery
  if (cat === 'GROCERY') return 'grocery';

  // Spices (subset but kept under grocery since POS doesn't separate)
  if (cat === 'SPICES') return 'spices';

  // Gas & fuel
  if (cat === 'GAS & CHARCOAL') return 'other';

  // Packaging / Housekeeping
  if (cat === 'HOUSEKEEPING') return 'packaging';

  // Stationery
  if (cat === 'STATIONERY') return 'packaging';

  return 'other';
}

// Map a CONSUMPTION/recipe unit string → canonical recipe unit (kg/g/L/ml/pcs).
// This is what recipes deduct in. POS gives "GMS", "ML", "PC", "PKT (50PC)" etc.
function mapRecipeUnit(posUnit: string): string {
  const u = (posUnit || '').trim().toUpperCase();
  if (!u) return 'pcs';
  if (u === 'GMS' || u === 'GM' || u === 'GRAMS' || u === 'G') return 'g';
  if (u === 'KG' || u === 'KGS') return 'kg';
  if (u === 'ML') return 'ml';
  if (u === 'LTR' || u === 'LITRE' || u === 'L') return 'L';
  if (u === 'PC' || u === 'PCS' || u === 'PIECE' || u === 'PIECES') return 'pcs';
  // "PKT (50PC)" / "BTL (750ML)" — consumed by the piece unless inner unit says otherwise
  if (u.includes('ML')) return 'ml';
  if (u.includes('GM')) return 'g';
  return 'pcs';
}

// Normalize a PURCHASE unit string → clean vendor-facing token (KG/L/BTL/PKT/…).
// Strips any "(750ML)" / "(50PC)" suffix — that detail becomes pack_size.
function cleanPurchaseUnit(posUnit: string): string {
  const raw = (posUnit || '').trim().toUpperCase();
  const head = raw.split('(')[0].trim();   // "BTL (750ML)" → "BTL"
  if (head === 'KG' || head === 'KGS') return 'kg';
  if (head === 'GMS' || head === 'GM' || head === 'G') return 'g';
  if (head === 'LTR' || head === 'LITRE' || head === 'L') return 'L';
  if (head === 'ML') return 'ml';
  if (head === 'PC' || head === 'PCS') return 'pcs';
  if (head === 'BTL' || head === 'BOTTLE') return 'BTL';
  if (head === 'PKT' || head === 'PACKET') return 'PKT';
  if (head === 'TIN') return 'TIN';
  if (head === 'CAN') return 'CAN';
  if (head === 'BOX') return 'BOX';
  if (head === 'BAG') return 'BAG';
  if (head === 'JAR') return 'JAR';
  if (head === 'CASE') return 'CASE';
  if (head === 'BUNCH') return 'BUNCH';
  if (head === 'DOZEN' || head === 'DZN') return 'DOZEN';
  return head || 'pcs';
}

// Compute pack_size = how many RECIPE units are in one PURCHASE unit.
//   "BTL (750ML)" + consume "ML"  → 750
//   "PKT (50PC)"  + consume "PC"  → 50
//   "KG"          + consume "GMS" → 1000   (weight conversion)
//   "LTR"         + consume "ML"  → 1000   (volume conversion)
//   "KG"          + consume "KG"  → 1      (same unit)
function computePackSize(purchaseRaw: string, recipeUnit: string): number {
  const pu = (purchaseRaw || '').trim().toUpperCase();
  // 1) Explicit "(NNN UNIT)" inside the purchase unit wins.
  const m = pu.match(/\(\s*(\d+(?:\.\d+)?)\s*([A-Z]+)\s*\)/);
  if (m) {
    const qty = parseFloat(m[1]);
    if (Number.isFinite(qty) && qty > 0) return qty;
  }
  // 2) Weight / volume conversion when buy-unit is bigger than recipe-unit.
  const head = pu.split('(')[0].trim();
  if ((head === 'KG' || head === 'KGS') && recipeUnit === 'g')  return 1000;
  if ((head === 'LTR' || head === 'L' || head === 'LITRE') && recipeUnit === 'ml') return 1000;
  // 3) Same unit (KG↔kg, PKT↔pcs both-pieces, etc.) → 1.
  return 1;
}

// Next gapless MAT-NNNNN SKU — mirrors the generator in /api/inventory.
function nextSku(db: any): number {
  const row = db.prepare(`
    SELECT sku FROM raw_materials
    WHERE sku LIKE 'MAT-%' AND sku GLOB 'MAT-[0-9]*'
    ORDER BY CAST(REPLACE(sku, 'MAT-', '') AS INTEGER) DESC LIMIT 1
  `).get() as { sku?: string } | undefined;
  return row?.sku ? (parseInt(row.sku.replace('MAT-', ''), 10) || 0) : 0;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { materials, clearExisting } = body as {
      materials: {
        id?: string;
        name: string;
        category: string;
        purchaseUnit: string;
        stockUnit?: string;
        consumptionUnit?: string;
        usableInventory: number;
        minimumStockLevel: number;
        defaultPurchaseRate: number;
      }[];
      clearExisting?: boolean;
    };

    if (!materials || !Array.isArray(materials)) {
      return Response.json({ error: 'materials array is required' }, { status: 400 });
    }

    const db = getDb();

    const result = db.transaction(() => {
      if (clearExisting) {
        db.exec(`
          DELETE FROM inventory_transactions;
          DELETE FROM sales;
          DELETE FROM recipe_sub_recipes;
          DELETE FROM recipe_ingredients;
          DELETE FROM sub_recipe_ingredients;
          DELETE FROM recipes;
          DELETE FROM sub_recipes;
          DELETE FROM purchases;
          DELETE FROM raw_materials;
        `);
      }

      const insertMaterial = db.prepare(`
        INSERT OR REPLACE INTO raw_materials
          (id, sku, name, category, unit, purchase_unit, pack_size, case_size,
           current_stock, reorder_level, costing_method, average_price,
           created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'average', ?, datetime('now'), datetime('now'))
      `);
      // Seed the SKU counter once; increment in JS so we don't re-query per row.
      let skuCounter = nextSku(db);

      // Additive-by-default dedup: unless the caller EXPLICITLY asked to clear,
      // skip any material whose name already exists (in the DB, or duplicated
      // earlier in this same file). An import therefore NEVER deletes or
      // overwrites existing data — it only ADDS genuinely new items.
      const existingNames = new Set<string>();
      if (!clearExisting) {
        for (const row of db.prepare(`SELECT name FROM raw_materials`).all() as any[]) {
          existingNames.add(String(row.name || '').trim().toLowerCase());
        }
      }
      const seenInFile = new Set<string>();

      let imported = 0;
      let skipped = 0;          // rows with no usable name
      let skippedExisting = 0;  // rows skipped because the material already exists

      for (const mat of materials) {
        const name = mat.name?.trim();
        if (!name) { skipped++; continue; }
        const dedupKey = name.toLowerCase();
        if (!clearExisting && (existingNames.has(dedupKey) || seenInFile.has(dedupKey))) {
          skippedExisting++;
          continue;
        }
        seenInFile.add(dedupKey);

        const category = mapCategory(mat.category || 'other');
        // Recipe unit comes from the CONSUMPTION column (what recipes deduct in),
        // falling back to a sensible map of the purchase unit if consumption is blank.
        const recipeUnit   = mat.consumptionUnit?.trim()
          ? mapRecipeUnit(mat.consumptionUnit)
          : mapRecipeUnit(mat.purchaseUnit || 'pcs');
        const purchaseUnit = cleanPurchaseUnit(mat.purchaseUnit || recipeUnit);
        const packSize     = computePackSize(mat.purchaseUnit || '', recipeUnit);
        // The CSV's rate is per PURCHASE unit (e.g. ₹141.75/KG). Prices are
        // stored in RECIPE units (g/ml/pcs), so: price_recipe = rate ÷ pack_size.
        // OPENING STOCK IS NOT IMPORTED — the CSV's "Usable Inventory" column is
        // ignored on purpose. Every item starts at current_stock = 0; real stock
        // is established only via Purchases / Closing Stock from go-live day.
        const purchaseReorder = parseFloat(String(mat.minimumStockLevel)) || 0;
        const purchaseRate = parseFloat(String(mat.defaultPurchaseRate)) || 0;
        const stock        = 0;                              // never seed stock from the CSV
        const reorderLevel = purchaseReorder * packSize;     // buffer threshold, not stock on hand
        const price        = packSize > 0 ? purchaseRate / packSize : purchaseRate;  // per recipe unit
        const materialId = mat.id || generateId();
        // Auto-SKU: only mint a new one when the row didn't carry an existing SKU.
        const sku = (mat as any).sku?.trim() || `MAT-${String(++skuCounter).padStart(5, '0')}`;

        // Insert raw material — MASTER DATA ONLY (name, SKU, units, pack size,
        // reorder threshold, reference price). No opening stock and no purchase
        // record: current_stock stays 0 until real purchases / counts are entered.
        insertMaterial.run(
          materialId, sku, name, category, recipeUnit, purchaseUnit, packSize,
          stock, reorderLevel, price
        );

        imported++;
      }

      return { imported, skipped, skippedExisting };
    })();

    const message = clearExisting
      ? `Replaced all data — imported ${result.imported} materials.`
      : `Added ${result.imported} new material${result.imported === 1 ? '' : 's'}` +
        ` · ${result.skippedExisting} already existed (skipped — no duplicates)` +
        `${result.skipped ? ` · ${result.skipped} had no name` : ''} · nothing deleted.`;
    return Response.json({
      message,
      imported: result.imported,
      skipped: result.skipped,
      skipped_existing: result.skippedExisting,
      cleared: !!clearExisting,
    }, { status: 201 });

  } catch (error: any) {
    console.error('Import error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
