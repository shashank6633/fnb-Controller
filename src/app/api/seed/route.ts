import { getDb, generateId, updateMaterialPrice, recalculateSubRecipeCost, recalculateRecipeCost, deductInventoryForSale } from '@/lib/db';

export async function POST() {
  try {
    const db = getDb();

    const seed = db.transaction(() => {
      // Clear existing data
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

      // ---- RAW MATERIALS ----
      const materials: Record<string, string> = {};

      const rawMats = [
        { name: 'Chicken Breast', category: 'non-veg', unit: 'kg', reorder: 5 },
        { name: 'Pasta (Penne)', category: 'grocery', unit: 'kg', reorder: 3 },
        { name: 'Olive Oil', category: 'grocery', unit: 'l', reorder: 2 },
        { name: 'Tomatoes', category: 'veg', unit: 'kg', reorder: 5 },
        { name: 'Vodka', category: 'bar', unit: 'bottle', reorder: 3 },
        { name: 'Rum (White)', category: 'bar', unit: 'bottle', reorder: 3 },
        { name: 'Gin', category: 'bar', unit: 'bottle', reorder: 2 },
        { name: 'Lime', category: 'veg', unit: 'kg', reorder: 2 },
        { name: 'Mint Leaves', category: 'veg', unit: 'bunch', reorder: 5 },
        { name: 'Sugar', category: 'grocery', unit: 'kg', reorder: 3 },
        { name: 'Fresh Cream', category: 'dairy', unit: 'l', reorder: 2 },
        { name: 'Mozzarella Cheese', category: 'dairy', unit: 'kg', reorder: 2 },
        { name: 'Onion', category: 'veg', unit: 'kg', reorder: 5 },
        { name: 'Garlic', category: 'veg', unit: 'kg', reorder: 1 },
        { name: 'Bread (Loaf)', category: 'bakery', unit: 'pcs', reorder: 10 },
        { name: 'Butter', category: 'dairy', unit: 'kg', reorder: 2 },
        { name: 'Parmesan Cheese', category: 'dairy', unit: 'kg', reorder: 1 },
        { name: 'Lettuce', category: 'veg', unit: 'kg', reorder: 2 },
        { name: 'Pizza Dough Base', category: 'bakery', unit: 'pcs', reorder: 10 },
        { name: 'Soda Water', category: 'beverages', unit: 'bottle', reorder: 10 },
      ];

      for (const mat of rawMats) {
        const id = generateId();
        materials[mat.name] = id;
        db.prepare(`
          INSERT INTO raw_materials (id, name, category, unit, current_stock, reorder_level, costing_method, average_price, created_at, updated_at)
          VALUES (?, ?, ?, ?, 0, ?, 'average', 0, datetime('now'), datetime('now'))
        `).run(id, mat.name, mat.category, mat.unit, mat.reorder);
      }

      // ---- PURCHASES ----
      const purchaseData = [
        { material: 'Chicken Breast', vendor: 'Fresh Meats Co', brand: 'Farm Fresh', qty: 20, price: 280, date: daysAgo(25) },
        { material: 'Chicken Breast', vendor: 'Fresh Meats Co', brand: 'Farm Fresh', qty: 15, price: 290, date: daysAgo(10) },
        { material: 'Pasta (Penne)', vendor: 'Italian Imports', brand: 'Barilla', qty: 10, price: 180, date: daysAgo(20) },
        { material: 'Olive Oil', vendor: 'Italian Imports', brand: 'Bertolli', qty: 5, price: 650, date: daysAgo(20) },
        { material: 'Tomatoes', vendor: 'Local Farm', brand: '', qty: 15, price: 40, date: daysAgo(18) },
        { material: 'Tomatoes', vendor: 'Local Farm', brand: '', qty: 10, price: 45, date: daysAgo(5) },
        { material: 'Vodka', vendor: 'Spirits Depot', brand: 'Absolut', qty: 6, price: 1200, date: daysAgo(22) },
        { material: 'Rum (White)', vendor: 'Spirits Depot', brand: 'Bacardi', qty: 6, price: 950, date: daysAgo(22) },
        { material: 'Gin', vendor: 'Spirits Depot', brand: 'Bombay Sapphire', qty: 4, price: 1400, date: daysAgo(22) },
        { material: 'Lime', vendor: 'Local Farm', brand: '', qty: 5, price: 80, date: daysAgo(15) },
        { material: 'Mint Leaves', vendor: 'Local Farm', brand: '', qty: 10, price: 30, date: daysAgo(15) },
        { material: 'Sugar', vendor: 'Grocery Wholesale', brand: '', qty: 10, price: 45, date: daysAgo(20) },
        { material: 'Fresh Cream', vendor: 'Dairy Direct', brand: 'Amul', qty: 5, price: 220, date: daysAgo(12) },
        { material: 'Mozzarella Cheese', vendor: 'Dairy Direct', brand: 'Amul', qty: 5, price: 480, date: daysAgo(12) },
        { material: 'Onion', vendor: 'Local Farm', brand: '', qty: 10, price: 30, date: daysAgo(18) },
        { material: 'Garlic', vendor: 'Local Farm', brand: '', qty: 3, price: 120, date: daysAgo(18) },
        { material: 'Bread (Loaf)', vendor: 'Bakery Fresh', brand: 'Britannia', qty: 20, price: 45, date: daysAgo(10) },
        { material: 'Butter', vendor: 'Dairy Direct', brand: 'Amul', qty: 5, price: 520, date: daysAgo(12) },
        { material: 'Parmesan Cheese', vendor: 'Italian Imports', brand: 'Parmigiano', qty: 2, price: 1200, date: daysAgo(15) },
        { material: 'Lettuce', vendor: 'Local Farm', brand: '', qty: 5, price: 60, date: daysAgo(10) },
        { material: 'Pizza Dough Base', vendor: 'Bakery Fresh', brand: '', qty: 30, price: 25, date: daysAgo(8) },
        { material: 'Soda Water', vendor: 'Beverages Inc', brand: 'Schweppes', qty: 24, price: 30, date: daysAgo(15) },
      ];

      for (const p of purchaseData) {
        const matId = materials[p.material];
        const totalPrice = Math.round(p.qty * p.price * 100) / 100;
        const purchaseId = generateId();

        db.prepare(`
          INSERT INTO purchases (id, material_id, vendor, brand, quantity, unit_price, total_price, date, notes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', datetime('now'))
        `).run(purchaseId, matId, p.vendor, p.brand, p.qty, p.price, totalPrice, p.date);

        db.prepare(`
          UPDATE raw_materials SET current_stock = current_stock + ?, updated_at = datetime('now') WHERE id = ?
        `).run(p.qty, matId);

        db.prepare(`
          INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at)
          VALUES (?, ?, 'purchase', ?, ?, ?, datetime('now'))
        `).run(generateId(), matId, p.qty, purchaseId, `Purchase from ${p.vendor}`);
      }

      // Update all material prices
      for (const matId of Object.values(materials)) {
        updateMaterialPrice(db, matId);
      }

      // ---- SUB-RECIPES ----
      const subRecipes: Record<string, string> = {};

      // White Sauce
      const whiteSauceId = generateId();
      subRecipes['White Sauce'] = whiteSauceId;
      db.prepare(`
        INSERT INTO sub_recipes (id, name, category, yield_quantity, yield_unit, version, is_active, created_at, updated_at)
        VALUES (?, 'White Sauce', 'sauce', 1, 'l', 1, 1, datetime('now'), datetime('now'))
      `).run(whiteSauceId);

      const whiteSauceIngs = [
        { material: 'Butter', qty: 0.05, unit: 'kg' },
        { material: 'Fresh Cream', qty: 0.3, unit: 'l' },
        { material: 'Garlic', qty: 0.01, unit: 'kg' },
        { material: 'Parmesan Cheese', qty: 0.05, unit: 'kg' },
      ];
      for (const ing of whiteSauceIngs) {
        db.prepare(`
          INSERT INTO sub_recipe_ingredients (id, sub_recipe_id, material_id, quantity, unit, yield_percent, wastage_percent, is_default, brand_preference)
          VALUES (?, ?, ?, ?, ?, 100, 0, 1, '')
        `).run(generateId(), whiteSauceId, materials[ing.material], ing.qty, ing.unit);
      }

      // Red Sauce
      const redSauceId = generateId();
      subRecipes['Red Sauce'] = redSauceId;
      db.prepare(`
        INSERT INTO sub_recipes (id, name, category, yield_quantity, yield_unit, version, is_active, created_at, updated_at)
        VALUES (?, 'Red Sauce', 'sauce', 1, 'l', 1, 1, datetime('now'), datetime('now'))
      `).run(redSauceId);

      const redSauceIngs = [
        { material: 'Tomatoes', qty: 0.5, unit: 'kg' },
        { material: 'Onion', qty: 0.1, unit: 'kg' },
        { material: 'Garlic', qty: 0.02, unit: 'kg' },
        { material: 'Olive Oil', qty: 0.03, unit: 'l' },
      ];
      for (const ing of redSauceIngs) {
        db.prepare(`
          INSERT INTO sub_recipe_ingredients (id, sub_recipe_id, material_id, quantity, unit, yield_percent, wastage_percent, is_default, brand_preference)
          VALUES (?, ?, ?, ?, ?, 100, 5, 1, '')
        `).run(generateId(), redSauceId, materials[ing.material], ing.qty, ing.unit);
      }

      // Mint Mix (for mojito)
      const mintMixId = generateId();
      subRecipes['Mint Mix'] = mintMixId;
      db.prepare(`
        INSERT INTO sub_recipes (id, name, category, yield_quantity, yield_unit, version, is_active, created_at, updated_at)
        VALUES (?, 'Mint Mix', 'bar-prep', 0.5, 'l', 1, 1, datetime('now'), datetime('now'))
      `).run(mintMixId);

      const mintMixIngs = [
        { material: 'Mint Leaves', qty: 0.1, unit: 'bunch' },
        { material: 'Lime', qty: 0.1, unit: 'kg' },
        { material: 'Sugar', qty: 0.05, unit: 'kg' },
      ];
      for (const ing of mintMixIngs) {
        db.prepare(`
          INSERT INTO sub_recipe_ingredients (id, sub_recipe_id, material_id, quantity, unit, yield_percent, wastage_percent, is_default, brand_preference)
          VALUES (?, ?, ?, ?, ?, 100, 0, 1, '')
        `).run(generateId(), mintMixId, materials[ing.material], ing.qty, ing.unit);
      }

      // Sugar Syrup
      const sugarSyrupId = generateId();
      subRecipes['Sugar Syrup'] = sugarSyrupId;
      db.prepare(`
        INSERT INTO sub_recipes (id, name, category, yield_quantity, yield_unit, version, is_active, created_at, updated_at)
        VALUES (?, 'Sugar Syrup', 'bar-prep', 1, 'l', 1, 1, datetime('now'), datetime('now'))
      `).run(sugarSyrupId);

      const sugarSyrupIngs = [
        { material: 'Sugar', qty: 0.5, unit: 'kg' },
      ];
      for (const ing of sugarSyrupIngs) {
        db.prepare(`
          INSERT INTO sub_recipe_ingredients (id, sub_recipe_id, material_id, quantity, unit, yield_percent, wastage_percent, is_default, brand_preference)
          VALUES (?, ?, ?, ?, ?, 100, 0, 1, '')
        `).run(generateId(), sugarSyrupId, materials[ing.material], ing.qty, ing.unit);
      }

      // Recalculate all sub-recipe costs
      for (const srId of Object.values(subRecipes)) {
        recalculateSubRecipeCost(db, srId);
      }

      // ---- RECIPES ----
      const recipes: Record<string, string> = {};

      // 1. Chicken Pasta - selling_price 450
      const chickenPastaId = generateId();
      recipes['Chicken Pasta'] = chickenPastaId;
      db.prepare(`
        INSERT INTO recipes (id, name, category, selling_price, version, is_active, created_at, updated_at)
        VALUES (?, 'Chicken Pasta', 'non-veg', 450, 1, 1, datetime('now'), datetime('now'))
      `).run(chickenPastaId);

      // Direct ingredients
      const cpIngs = [
        { material: 'Chicken Breast', qty: 0.15, unit: 'kg' },
        { material: 'Pasta (Penne)', qty: 0.1, unit: 'kg' },
        { material: 'Olive Oil', qty: 0.02, unit: 'l' },
      ];
      for (const ing of cpIngs) {
        db.prepare(`
          INSERT INTO recipe_ingredients (id, recipe_id, material_id, quantity, unit, yield_percent, wastage_percent, is_default, brand_preference)
          VALUES (?, ?, ?, ?, ?, 90, 5, 1, '')
        `).run(generateId(), chickenPastaId, materials[ing.material], ing.qty, ing.unit);
      }
      // Sub-recipe: White Sauce
      db.prepare(`
        INSERT INTO recipe_sub_recipes (id, recipe_id, sub_recipe_id, quantity, unit)
        VALUES (?, ?, ?, 0.15, 'l')
      `).run(generateId(), chickenPastaId, whiteSauceId);

      // 2. Margherita Pizza - selling_price 350
      const margheritaId = generateId();
      recipes['Margherita Pizza'] = margheritaId;
      db.prepare(`
        INSERT INTO recipes (id, name, category, selling_price, version, is_active, created_at, updated_at)
        VALUES (?, 'Margherita Pizza', 'veg', 350, 1, 1, datetime('now'), datetime('now'))
      `).run(margheritaId);

      const mpIngs = [
        { material: 'Pizza Dough Base', qty: 1, unit: 'pcs' },
        { material: 'Mozzarella Cheese', qty: 0.1, unit: 'kg' },
        { material: 'Olive Oil', qty: 0.01, unit: 'l' },
      ];
      for (const ing of mpIngs) {
        db.prepare(`
          INSERT INTO recipe_ingredients (id, recipe_id, material_id, quantity, unit, yield_percent, wastage_percent, is_default, brand_preference)
          VALUES (?, ?, ?, ?, ?, 100, 0, 1, '')
        `).run(generateId(), margheritaId, materials[ing.material], ing.qty, ing.unit);
      }
      db.prepare(`
        INSERT INTO recipe_sub_recipes (id, recipe_id, sub_recipe_id, quantity, unit)
        VALUES (?, ?, ?, 0.1, 'l')
      `).run(generateId(), margheritaId, redSauceId);

      // 3. Classic Mojito - selling_price 350
      const mojitoId = generateId();
      recipes['Classic Mojito'] = mojitoId;
      db.prepare(`
        INSERT INTO recipes (id, name, category, selling_price, version, is_active, created_at, updated_at)
        VALUES (?, 'Classic Mojito', 'bar', 350, 1, 1, datetime('now'), datetime('now'))
      `).run(mojitoId);

      const mojIngs = [
        { material: 'Rum (White)', qty: 0.06, unit: 'bottle' },
        { material: 'Soda Water', qty: 0.2, unit: 'bottle' },
      ];
      for (const ing of mojIngs) {
        db.prepare(`
          INSERT INTO recipe_ingredients (id, recipe_id, material_id, quantity, unit, yield_percent, wastage_percent, is_default, brand_preference)
          VALUES (?, ?, ?, ?, ?, 100, 0, 1, '')
        `).run(generateId(), mojitoId, materials[ing.material], ing.qty, ing.unit);
      }
      db.prepare(`
        INSERT INTO recipe_sub_recipes (id, recipe_id, sub_recipe_id, quantity, unit)
        VALUES (?, ?, ?, 0.08, 'l')
      `).run(generateId(), mojitoId, mintMixId);
      db.prepare(`
        INSERT INTO recipe_sub_recipes (id, recipe_id, sub_recipe_id, quantity, unit)
        VALUES (?, ?, ?, 0.02, 'l')
      `).run(generateId(), mojitoId, sugarSyrupId);

      // 4. Vodka Martini - selling_price 400
      const martiniId = generateId();
      recipes['Vodka Martini'] = martiniId;
      db.prepare(`
        INSERT INTO recipes (id, name, category, selling_price, version, is_active, created_at, updated_at)
        VALUES (?, 'Vodka Martini', 'bar', 400, 1, 1, datetime('now'), datetime('now'))
      `).run(martiniId);

      const vmIngs = [
        { material: 'Vodka', qty: 0.06, unit: 'bottle' },
        { material: 'Lime', qty: 0.02, unit: 'kg' },
        { material: 'Olive Oil', qty: 0.005, unit: 'l' },
      ];
      for (const ing of vmIngs) {
        db.prepare(`
          INSERT INTO recipe_ingredients (id, recipe_id, material_id, quantity, unit, yield_percent, wastage_percent, is_default, brand_preference)
          VALUES (?, ?, ?, ?, ?, 100, 0, 1, '')
        `).run(generateId(), martiniId, materials[ing.material], ing.qty, ing.unit);
      }

      // 5. Caesar Salad - selling_price 300
      const caesarId = generateId();
      recipes['Caesar Salad'] = caesarId;
      db.prepare(`
        INSERT INTO recipes (id, name, category, selling_price, version, is_active, created_at, updated_at)
        VALUES (?, 'Caesar Salad', 'veg', 300, 1, 1, datetime('now'), datetime('now'))
      `).run(caesarId);

      const csIngs = [
        { material: 'Lettuce', qty: 0.1, unit: 'kg' },
        { material: 'Parmesan Cheese', qty: 0.03, unit: 'kg' },
        { material: 'Bread (Loaf)', qty: 1, unit: 'pcs' },
        { material: 'Olive Oil', qty: 0.02, unit: 'l' },
        { material: 'Garlic', qty: 0.005, unit: 'kg' },
      ];
      for (const ing of csIngs) {
        db.prepare(`
          INSERT INTO recipe_ingredients (id, recipe_id, material_id, quantity, unit, yield_percent, wastage_percent, is_default, brand_preference)
          VALUES (?, ?, ?, ?, ?, 95, 5, 1, '')
        `).run(generateId(), caesarId, materials[ing.material], ing.qty, ing.unit);
      }

      // 6. Garlic Bread - selling_price 200
      const garlicBreadId = generateId();
      recipes['Garlic Bread'] = garlicBreadId;
      db.prepare(`
        INSERT INTO recipes (id, name, category, selling_price, version, is_active, created_at, updated_at)
        VALUES (?, 'Garlic Bread', 'veg', 200, 1, 1, datetime('now'), datetime('now'))
      `).run(garlicBreadId);

      const gbIngs = [
        { material: 'Bread (Loaf)', qty: 2, unit: 'pcs' },
        { material: 'Butter', qty: 0.03, unit: 'kg' },
        { material: 'Garlic', qty: 0.01, unit: 'kg' },
        { material: 'Mozzarella Cheese', qty: 0.03, unit: 'kg' },
      ];
      for (const ing of gbIngs) {
        db.prepare(`
          INSERT INTO recipe_ingredients (id, recipe_id, material_id, quantity, unit, yield_percent, wastage_percent, is_default, brand_preference)
          VALUES (?, ?, ?, ?, ?, 100, 0, 1, '')
        `).run(generateId(), garlicBreadId, materials[ing.material], ing.qty, ing.unit);
      }

      // Recalculate all recipe costs
      for (const recipeId of Object.values(recipes)) {
        recalculateRecipeCost(db, recipeId);
      }

      // ---- SALES DATA (last 30 days) ----
      const recipeItems = [
        { name: 'Chicken Pasta', id: chickenPastaId, price: 450 },
        { name: 'Margherita Pizza', id: margheritaId, price: 350 },
        { name: 'Classic Mojito', id: mojitoId, price: 350 },
        { name: 'Vodka Martini', id: martiniId, price: 400 },
        { name: 'Caesar Salad', id: caesarId, price: 300 },
        { name: 'Garlic Bread', id: garlicBreadId, price: 200 },
      ];

      // Generate sales for last 30 days
      for (let day = 29; day >= 0; day--) {
        const date = daysAgo(day);
        // Each day: 2-5 items sold
        const itemsToday = 2 + Math.floor(pseudoRandom(day) * 4);

        for (let i = 0; i < itemsToday; i++) {
          const itemIdx = Math.floor(pseudoRandom(day * 10 + i) * recipeItems.length);
          const item = recipeItems[itemIdx];
          const qty = 1 + Math.floor(pseudoRandom(day * 100 + i) * 3);

          // Every 7th sale is NC, every 15th is complimentary
          let billType = 'normal';
          const saleNum = day * 10 + i;
          if (saleNum % 15 === 0) billType = 'complimentary';
          else if (saleNum % 7 === 0) billType = 'nc';

          const recipe = db.prepare('SELECT total_cost FROM recipes WHERE id = ?').get(item.id) as any;
          const totalCost = Math.round((recipe?.total_cost || 0) * qty * 100) / 100;
          const totalRevenue = billType === 'normal'
            ? Math.round(item.price * qty * 100) / 100
            : 0;

          const saleId = generateId();
          db.prepare(`
            INSERT INTO sales (id, item_name, recipe_id, quantity_sold, bill_type, selling_price, total_revenue, total_cost, date, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          `).run(saleId, item.name, item.id, qty, billType, item.price, totalRevenue, totalCost, date);

          // Deduct inventory
          deductInventoryForSale(db, item.id, qty, saleId, billType);
        }
      }
    });

    seed();

    // Get summary counts
    const materialCount = (db.prepare('SELECT COUNT(*) as c FROM raw_materials').get() as any).c;
    const purchaseCount = (db.prepare('SELECT COUNT(*) as c FROM purchases').get() as any).c;
    const subRecipeCount = (db.prepare('SELECT COUNT(*) as c FROM sub_recipes').get() as any).c;
    const recipeCount = (db.prepare('SELECT COUNT(*) as c FROM recipes').get() as any).c;
    const salesCount = (db.prepare('SELECT COUNT(*) as c FROM sales').get() as any).c;

    return Response.json({
      success: true,
      message: 'Database seeded successfully',
      counts: {
        raw_materials: materialCount,
        purchases: purchaseCount,
        sub_recipes: subRecipeCount,
        recipes: recipeCount,
        sales: salesCount,
      },
    }, { status: 201 });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

// Helper: get date string N days ago
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

// Deterministic pseudo-random for reproducible seed data
function pseudoRandom(seed: number): number {
  const x = Math.sin(seed + 1) * 10000;
  return x - Math.floor(x);
}
