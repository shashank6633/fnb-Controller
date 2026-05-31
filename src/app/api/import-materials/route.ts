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

// Map POS purchase unit to our system units
function mapUnit(posUnit: string): string {
  const u = posUnit.trim().toUpperCase();

  if (u === 'KG' || u.includes('KG')) return 'kg';
  if (u === 'GMS' || u.includes('GMS') || u.includes('GM')) return 'g';
  if (u === 'LTR' || u.includes('LTR')) return 'l';
  if (u.includes('ML')) return 'ml';
  if (u === 'PC' || u === 'PCS') return 'pcs';
  if (u.includes('BTL')) return 'bottle';
  if (u.includes('PKT')) return 'pcs';
  if (u.includes('TIN')) return 'pcs';
  if (u.includes('BOX')) return 'pcs';
  if (u.includes('CAN')) return 'pcs';
  if (u.includes('BAG')) return 'kg';
  if (u.includes('DOZEN') || u.includes('DZN')) return 'dozen';
  if (u.includes('BUNCH')) return 'bunch';

  return 'pcs';
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
        INSERT OR REPLACE INTO raw_materials (id, name, category, unit, current_stock, reorder_level, costing_method, average_price, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'average', ?, datetime('now'), datetime('now'))
      `);

      const insertPurchase = db.prepare(`
        INSERT INTO purchases (id, material_id, vendor, brand, quantity, unit_price, total_price, date, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `);

      const insertTransaction = db.prepare(`
        INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at)
        VALUES (?, ?, 'purchase', ?, ?, ?, datetime('now'))
      `);

      let imported = 0;
      let skipped = 0;

      for (const mat of materials) {
        const name = mat.name?.trim();
        if (!name) { skipped++; continue; }

        const category = mapCategory(mat.category || 'other');
        const unit = mapUnit(mat.purchaseUnit || 'pcs');
        const stock = parseFloat(String(mat.usableInventory)) || 0;
        const reorderLevel = parseFloat(String(mat.minimumStockLevel)) || 0;
        const price = parseFloat(String(mat.defaultPurchaseRate)) || 0;
        const materialId = mat.id || generateId();

        // Insert raw material
        insertMaterial.run(materialId, name, category, unit, stock, reorderLevel, price);

        // Create initial purchase record if there's stock and price
        if (stock > 0 && price > 0) {
          const purchaseId = generateId();
          insertPurchase.run(
            purchaseId, materialId, 'POS Import', 'Default', stock, price, stock * price,
            '2026-04-06', 'Initial stock from POS system import'
          );

          insertTransaction.run(
            generateId(), materialId, stock, purchaseId, 'POS import initial stock'
          );
        }

        imported++;
      }

      return { imported, skipped };
    })();

    return Response.json({
      message: `Successfully imported ${result.imported} materials (${result.skipped} skipped)`,
      imported: result.imported,
      skipped: result.skipped,
    }, { status: 201 });

  } catch (error: any) {
    console.error('Import error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
