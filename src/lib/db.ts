import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'fnb-controller.db');

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initializeSchema(db);
    // After schema is built + seeded, push the units table into the in-memory
    // registry so convert() uses user-edited values immediately.
    try {
      const rows = db.prepare('SELECT key, label, aliases, dimension, to_base FROM units').all() as any[];
      if (rows.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { applyRegistryRows } = require('./units') as typeof import('./units');
        applyRegistryRows(rows);
      }
    } catch (e) { console.error('units registry hydration failed:', e); }
  }
  return db;
}

function initializeSchema(db: Database.Database) {
  db.exec(`
    -- Raw Materials Master
    CREATE TABLE IF NOT EXISTS raw_materials (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      unit TEXT NOT NULL DEFAULT 'kg',
      current_stock REAL NOT NULL DEFAULT 0,
      reorder_level REAL NOT NULL DEFAULT 0,
      costing_method TEXT NOT NULL DEFAULT 'average',
      average_price REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Purchase Records
    CREATE TABLE IF NOT EXISTS purchases (
      id TEXT PRIMARY KEY,
      material_id TEXT NOT NULL,
      vendor TEXT NOT NULL DEFAULT '',
      brand TEXT NOT NULL DEFAULT '',
      quantity REAL NOT NULL,
      unit_price REAL NOT NULL,
      total_price REAL NOT NULL,
      date TEXT NOT NULL,
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (material_id) REFERENCES raw_materials(id)
    );

    -- Sub-Recipes (sauces, bases, pre-mixes)
    CREATE TABLE IF NOT EXISTS sub_recipes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      yield_quantity REAL NOT NULL DEFAULT 1,
      yield_unit TEXT NOT NULL DEFAULT 'kg',
      cost_per_unit REAL NOT NULL DEFAULT 0,
      total_cost REAL NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Sub-Recipe Ingredients
    CREATE TABLE IF NOT EXISTS sub_recipe_ingredients (
      id TEXT PRIMARY KEY,
      sub_recipe_id TEXT NOT NULL,
      material_id TEXT NOT NULL,
      quantity REAL NOT NULL,
      unit TEXT NOT NULL DEFAULT 'kg',
      yield_percent REAL NOT NULL DEFAULT 100,
      wastage_percent REAL NOT NULL DEFAULT 0,
      is_default INTEGER NOT NULL DEFAULT 1,
      brand_preference TEXT DEFAULT '',
      FOREIGN KEY (sub_recipe_id) REFERENCES sub_recipes(id) ON DELETE CASCADE,
      FOREIGN KEY (material_id) REFERENCES raw_materials(id)
    );

    -- Main Recipes (Final Dishes)
    CREATE TABLE IF NOT EXISTS recipes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      selling_price REAL NOT NULL DEFAULT 0,
      total_cost REAL NOT NULL DEFAULT 0,
      profit REAL NOT NULL DEFAULT 0,
      food_cost_percent REAL NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Recipe Raw Ingredients
    CREATE TABLE IF NOT EXISTS recipe_ingredients (
      id TEXT PRIMARY KEY,
      recipe_id TEXT NOT NULL,
      material_id TEXT NOT NULL,
      quantity REAL NOT NULL,
      unit TEXT NOT NULL DEFAULT 'kg',
      yield_percent REAL NOT NULL DEFAULT 100,
      wastage_percent REAL NOT NULL DEFAULT 0,
      is_default INTEGER NOT NULL DEFAULT 1,
      brand_preference TEXT DEFAULT '',
      FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE,
      FOREIGN KEY (material_id) REFERENCES raw_materials(id)
    );

    -- Recipe Sub-Recipe Links
    CREATE TABLE IF NOT EXISTS recipe_sub_recipes (
      id TEXT PRIMARY KEY,
      recipe_id TEXT NOT NULL,
      sub_recipe_id TEXT NOT NULL,
      quantity REAL NOT NULL,
      unit TEXT NOT NULL DEFAULT 'kg',
      FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE,
      FOREIGN KEY (sub_recipe_id) REFERENCES sub_recipes(id)
    );

    -- Sales Records
    CREATE TABLE IF NOT EXISTS sales (
      id TEXT PRIMARY KEY,
      item_name TEXT NOT NULL,
      recipe_id TEXT,
      quantity_sold REAL NOT NULL,
      bill_type TEXT NOT NULL DEFAULT 'normal',
      selling_price REAL NOT NULL DEFAULT 0,
      total_revenue REAL NOT NULL DEFAULT 0,
      total_cost REAL NOT NULL DEFAULT 0,
      date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (recipe_id) REFERENCES recipes(id)
    );

    -- Inventory Transactions Log (immutable audit trail)
    CREATE TABLE IF NOT EXISTS inventory_transactions (
      id TEXT PRIMARY KEY,
      material_id TEXT NOT NULL,
      type TEXT NOT NULL, -- 'purchase', 'sale', 'nc', 'adjustment', 'wastage'
      quantity REAL NOT NULL, -- positive = in, negative = out
      reference_id TEXT, -- purchase_id or sale_id
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (material_id) REFERENCES raw_materials(id)
    );

    -- Settings
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Insert default settings if not exists
    INSERT OR IGNORE INTO settings (key, value) VALUES ('costing_method', 'average');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('currency', 'INR');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('business_name', 'My Restaurant & Pub');
    -- Target food-cost %, stored as a fraction (0.30 = 30%). Drives the Recipes
    -- "Menu Price @ Target" suggestion and the high-FC flag. Overwritten on
    -- recipe-workbook import from the workbook's own target cell.
    INSERT OR IGNORE INTO settings (key, value) VALUES ('target_food_cost_pct', '0.30');

    -- Parties (Events / Functions)
    CREATE TABLE IF NOT EXISTS parties (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      date TEXT NOT NULL,
      party_type TEXT NOT NULL DEFAULT 'mixed', -- beverage, liquor, mixed, food
      venue TEXT DEFAULT '',
      floor TEXT DEFAULT '',
      guest_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'upcoming', -- upcoming, active, completed, cancelled
      notes TEXT DEFAULT '',
      akan_unique_id TEXT DEFAULT '',
      akan_host_name TEXT DEFAULT '',
      akan_company TEXT DEFAULT '',
      akan_phone TEXT DEFAULT '',
      akan_occasion TEXT DEFAULT '',
      akan_package TEXT DEFAULT '',
      akan_final_amount REAL DEFAULT 0,
      akan_row_index INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Party Consumption Items (Issue → Return → Consumption flow)
    CREATE TABLE IF NOT EXISTS party_items (
      id TEXT PRIMARY KEY,
      party_id TEXT NOT NULL,
      item_name TEXT NOT NULL,
      material_id TEXT,
      category TEXT NOT NULL DEFAULT 'beverage', -- beverage, liquor, food, mixer, other
      quantity REAL NOT NULL DEFAULT 0, -- Net consumed qty (= issued - returned)
      issued_quantity REAL NOT NULL DEFAULT 0, -- Opening: what kitchen/bar took out
      returned_quantity REAL NOT NULL DEFAULT 0, -- Closing: what came back unused
      unit TEXT NOT NULL DEFAULT 'pcs',
      purchase_price REAL NOT NULL DEFAULT 0,
      selling_price REAL NOT NULL DEFAULT 0,
      total_cost REAL NOT NULL DEFAULT 0,
      total_revenue REAL NOT NULL DEFAULT 0,
      is_complimentary INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'issued', -- 'issued', 'closed'
      issued_at TEXT,
      returned_at TEXT,
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (party_id) REFERENCES parties(id) ON DELETE CASCADE,
      FOREIGN KEY (material_id) REFERENCES raw_materials(id)
    );

    -- Menu Items (complete product catalog — food, liquor, beverages)
    CREATE TABLE IF NOT EXISTS menu_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      station TEXT DEFAULT '',
      item_type TEXT DEFAULT 'foods', -- foods, liquors, beverages
      dietary_tag TEXT DEFAULT '', -- Veg, Non-Veg, Egg
      selling_price REAL NOT NULL DEFAULT 0,
      listing_price REAL NOT NULL DEFAULT 0,
      item_code TEXT DEFAULT '',
      tax_value REAL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      recipe_id TEXT, -- links to recipe if this item has one
      material_id TEXT, -- links to raw material for direct-sale items (bottles/cans)
      source TEXT DEFAULT 'manual', -- 'pos', 'manual', 'import'
      notes TEXT DEFAULT '',
      pos_id TEXT DEFAULT '', -- external POS identifier
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (recipe_id) REFERENCES recipes(id),
      FOREIGN KEY (material_id) REFERENCES raw_materials(id)
    );

    CREATE INDEX IF NOT EXISTS idx_menu_items_category ON menu_items(category);
    CREATE INDEX IF NOT EXISTS idx_menu_items_station ON menu_items(station);
    CREATE INDEX IF NOT EXISTS idx_menu_items_type ON menu_items(item_type);
    CREATE INDEX IF NOT EXISTS idx_menu_items_code ON menu_items(item_code);
    CREATE INDEX IF NOT EXISTS idx_menu_items_name ON menu_items(name);

    -- Staff Meals (Daily staff food requisition & consumption)
    CREATE TABLE IF NOT EXISTS staff_meals (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      meal_type TEXT NOT NULL DEFAULT 'lunch', -- breakfast, lunch, snacks, dinner
      shift TEXT DEFAULT '', -- morning, evening, night, all
      staff_count INTEGER NOT NULL DEFAULT 0,
      cooked_by TEXT DEFAULT '',
      menu TEXT DEFAULT '', -- what was cooked (free text)
      status TEXT NOT NULL DEFAULT 'open', -- open, closed
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS staff_meal_items (
      id TEXT PRIMARY KEY,
      meal_id TEXT NOT NULL,
      item_name TEXT NOT NULL,
      material_id TEXT,
      category TEXT NOT NULL DEFAULT 'grocery',
      quantity REAL NOT NULL DEFAULT 0,
      issued_quantity REAL NOT NULL DEFAULT 0,
      returned_quantity REAL NOT NULL DEFAULT 0,
      unit TEXT NOT NULL DEFAULT 'kg',
      purchase_price REAL NOT NULL DEFAULT 0,
      total_cost REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'issued', -- issued, closed
      issued_at TEXT,
      returned_at TEXT,
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (meal_id) REFERENCES staff_meals(id) ON DELETE CASCADE,
      FOREIGN KEY (material_id) REFERENCES raw_materials(id)
    );

    CREATE INDEX IF NOT EXISTS idx_staff_meals_date ON staff_meals(date);
    CREATE INDEX IF NOT EXISTS idx_staff_meal_items_meal ON staff_meal_items(meal_id);

    -- Closing Stock (Physical Count Records)
    CREATE TABLE IF NOT EXISTS closing_stock (
      id TEXT PRIMARY KEY,
      material_id TEXT NOT NULL,
      date TEXT NOT NULL,
      system_stock REAL NOT NULL DEFAULT 0,
      physical_stock REAL NOT NULL DEFAULT 0,
      variance REAL NOT NULL DEFAULT 0,
      variance_value REAL NOT NULL DEFAULT 0,
      notes TEXT DEFAULT '',
      recorded_by TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (material_id) REFERENCES raw_materials(id)
    );

    CREATE INDEX IF NOT EXISTS idx_closing_stock_date ON closing_stock(date);
    CREATE INDEX IF NOT EXISTS idx_closing_stock_material ON closing_stock(material_id);

    -- Create indexes for performance
    CREATE INDEX IF NOT EXISTS idx_parties_date ON parties(date);
    CREATE INDEX IF NOT EXISTS idx_parties_status ON parties(status);
    CREATE INDEX IF NOT EXISTS idx_party_items_party ON party_items(party_id);

    -- Create indexes for performance
    CREATE INDEX IF NOT EXISTS idx_purchases_material ON purchases(material_id);
    CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(date);
    CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(date);
    CREATE INDEX IF NOT EXISTS idx_sales_recipe ON sales(recipe_id);
    CREATE INDEX IF NOT EXISTS idx_sales_bill_type ON sales(bill_type);
    CREATE INDEX IF NOT EXISTS idx_inventory_tx_material ON inventory_transactions(material_id);
    CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_recipe ON recipe_ingredients(recipe_id);
    CREATE INDEX IF NOT EXISTS idx_sub_recipe_ingredients_sub ON sub_recipe_ingredients(sub_recipe_id);
  `);

  // Migrations: add Akan Party Manager columns if missing
  try {
    const partyColumns = db.prepare("PRAGMA table_info(parties)").all() as any[];
    const colNames = new Set(partyColumns.map((c: any) => c.name));
    const akanCols: [string, string][] = [
      ['akan_unique_id', "TEXT DEFAULT ''"],
      ['akan_host_name', "TEXT DEFAULT ''"],
      ['akan_company', "TEXT DEFAULT ''"],
      ['akan_phone', "TEXT DEFAULT ''"],
      ['akan_occasion', "TEXT DEFAULT ''"],
      ['akan_package', "TEXT DEFAULT ''"],
      ['akan_final_amount', "REAL DEFAULT 0"],
      ['akan_row_index', "INTEGER DEFAULT 0"],
    ];
    for (const [col, type] of akanCols) {
      if (!colNames.has(col)) {
        db.exec(`ALTER TABLE parties ADD COLUMN ${col} ${type}`);
      }
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_parties_akan_id ON parties(akan_unique_id)`);
  } catch (_) { /* table may not exist yet on first run */ }

  // Migrations: add Issue/Return columns to party_items if missing
  try {
    const itemCols = db.prepare("PRAGMA table_info(party_items)").all() as any[];
    const itemColNames = new Set(itemCols.map((c: any) => c.name));
    const issueReturnCols: [string, string][] = [
      ['issued_quantity', "REAL NOT NULL DEFAULT 0"],
      ['returned_quantity', "REAL NOT NULL DEFAULT 0"],
      ['status', "TEXT NOT NULL DEFAULT 'issued'"],
      ['issued_at', "TEXT"],
      ['returned_at', "TEXT"],
    ];
    for (const [col, type] of issueReturnCols) {
      if (!itemColNames.has(col)) {
        db.exec(`ALTER TABLE party_items ADD COLUMN ${col} ${type}`);
      }
    }
    db.exec(`UPDATE party_items SET issued_quantity = quantity WHERE issued_quantity = 0 AND quantity > 0`);
    db.exec(`UPDATE party_items SET issued_at = created_at WHERE issued_at IS NULL`);
  } catch (_) { /* table may not exist yet on first run */ }

  // Migration: clear default reorder_level=5 sentinel (was causing spurious low-stock alerts).
  // Users who want alerts should set reorder_level explicitly. Guarded by settings flag so it runs once.
  try {
    const flag = db.prepare("SELECT value FROM settings WHERE key = 'migration_reorder_default_cleared'").get() as any;
    if (!flag) {
      db.exec(`UPDATE raw_materials SET reorder_level = 0 WHERE reorder_level = 5`);
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('migration_reorder_default_cleared', '1')").run();
    }
  } catch (_) { /* ignore if tables missing */ }

  // Migration: add sale_time + order_id + category + server columns to sales for richer analytics
  try {
    const salesCols = db.prepare("PRAGMA table_info(sales)").all() as any[];
    const salesColNames = new Set(salesCols.map((c: any) => c.name));
    const newCols: [string, string][] = [
      ['sale_time', "TEXT DEFAULT NULL"],       // HH:MM (from Order Date and Time)
      ['order_id', "TEXT DEFAULT NULL"],        // POS order/bill id
      ['category', "TEXT DEFAULT NULL"],        // food/liquor/beverages (denormalized for fast filters)
      ['server', "TEXT DEFAULT NULL"],          // Order Created By
      ['order_type', "TEXT DEFAULT NULL"],      // dine-in / delivery / takeaway
      ['pos_item_id', "TEXT DEFAULT NULL"],     // POS product id / mapped code — stable link for recipes
      ['pos_item_name', "TEXT DEFAULT NULL"],   // Raw Product Name from POS (pre-variant)
      ['variant_name', "TEXT DEFAULT NULL"],    // e.g. "Butter" for "Naan(Butter)"
      ['linked_event_name', "TEXT DEFAULT NULL"], // manual party-event override (NULL = use date-based default)
      ['linked_event_date', "TEXT DEFAULT NULL"], // only valid in conjunction with linked_event_name
    ];
    for (const [col, type] of newCols) {
      if (!salesColNames.has(col)) {
        db.exec(`ALTER TABLE sales ADD COLUMN ${col} ${type}`);
      }
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_category ON sales(category)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_order_id ON sales(order_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_item_lower ON sales(LOWER(item_name))`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_menu_items_name_lower ON menu_items(LOWER(name))`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_pos_item_id ON sales(pos_item_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_linked_event ON sales(linked_event_name, linked_event_date)`);
  } catch (e) { console.error('sales migration failed:', e); }

  // Table: direct_item_links — canonical source for "sold item name → raw material" decisions.
  // Keyed by item_name (case-insensitive via COLLATE NOCASE). Works for any sold item name,
  // even ones that don't exist as rows in menu_items.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS direct_item_links (
        item_name   TEXT PRIMARY KEY COLLATE NOCASE,
        material_id TEXT,           -- NULL means dismissed (reviewed but not linked)
        reviewed    INTEGER NOT NULL DEFAULT 1,
        updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (material_id) REFERENCES raw_materials(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_direct_item_links_material ON direct_item_links(material_id);
    `);
    // Pack multiplier — e.g. "Budweiser bucket of 4" sold once = 4 pcs deducted.
    const dilCols = db.prepare("PRAGMA table_info(direct_item_links)").all() as any[];
    const dilNames = new Set(dilCols.map((c: any) => c.name));
    if (!dilNames.has('qty_per_unit')) {
      db.exec(`ALTER TABLE direct_item_links ADD COLUMN qty_per_unit REAL NOT NULL DEFAULT 1`);
    }
    // Dismissed: hides the item from the Direct Items report without deleting
    // any sales history. Used for one-off comps, POS data-entry errors, or
    // discontinued items that shouldn't appear in the reconciliation view.
    if (!dilNames.has('dismissed')) {
      db.exec(`ALTER TABLE direct_item_links ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0`);
    }
  } catch (e) { console.error('direct_item_links migration failed:', e); }

  // Migration: backfill existing menu_items decisions into direct_item_links (one-shot).
  try {
    db.exec(`
      INSERT OR IGNORE INTO direct_item_links (item_name, material_id, reviewed, updated_at)
      SELECT name, material_id, direct_reviewed, datetime('now')
      FROM menu_items
      WHERE (material_id IS NOT NULL OR direct_reviewed = 1)
    `);
  } catch (e) { console.error('direct_item_links backfill failed:', e); }

  // Migration: add `direct_reviewed` flag to menu_items for direct-items workflow (pending vs reviewed)
  try {
    const miCols = db.prepare("PRAGMA table_info(menu_items)").all() as any[];
    const miNames = new Set(miCols.map((c: any) => c.name));
    if (!miNames.has('direct_reviewed')) {
      db.exec(`ALTER TABLE menu_items ADD COLUMN direct_reviewed INTEGER NOT NULL DEFAULT 0`);
    }
    // Per-dish prep time (minutes) → drives the captain's per-item countup timer.
    if (!miNames.has('prep_minutes')) {
      db.exec(`ALTER TABLE menu_items ADD COLUMN prep_minutes INTEGER NOT NULL DEFAULT 0`);
    }
    // Customer QR-menu presentation fields (item detail: photo, spice, tags, taste
    // radar, serves). All optional; the menu still renders with sensible defaults.
    const miAdds: Array<[string, string]> = [
      ['image_url', "TEXT DEFAULT ''"],
      ['spice_level', 'INTEGER NOT NULL DEFAULT 0'],   // 0 none · 1 mild · 2 medium · 3 hot
      ['tags', "TEXT DEFAULT ''"],                      // JSON array: most-ordered|chef|bestseller|popular
      ['taste_sour', 'INTEGER NOT NULL DEFAULT 0'],     // each 0–4
      ['taste_sweet', 'INTEGER NOT NULL DEFAULT 0'],
      ['taste_spicy', 'INTEGER NOT NULL DEFAULT 0'],
      ['taste_tangy', 'INTEGER NOT NULL DEFAULT 0'],
      ['serves', "TEXT DEFAULT ''"],                    // e.g. "1-2"
      ['options', "TEXT DEFAULT ''"],                   // JSON: [{label, choices:[…]}] — e.g. Temperature: Normal/Chilled
    ];
    for (const [c, t] of miAdds) if (!miNames.has(c)) db.exec(`ALTER TABLE menu_items ADD COLUMN ${c} ${t}`);
    // Backfill — any menu item already with a material_id is implicitly reviewed
    db.exec(`UPDATE menu_items SET direct_reviewed = 1 WHERE material_id IS NOT NULL AND direct_reviewed = 0`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_menu_items_direct_reviewed ON menu_items(direct_reviewed)`);
  } catch (e) { console.error('direct_reviewed migration failed:', e); }

  // Migration: extend raw_materials with vendor + recipe-unit + conversion factor + yield (Inventory Module spec)
  try {
    const cols = db.prepare("PRAGMA table_info(raw_materials)").all() as any[];
    const has = (n: string) => cols.some((c: any) => c.name === n);
    const adds: [string, string][] = [
      ['primary_vendor',     "TEXT DEFAULT ''"],          // default supplier (most-frequent vendor backfill below)
      ['purchase_unit',      "TEXT DEFAULT ''"],          // e.g. KG, Liter, Bottle, CASE(24PC)
      ['recipe_unit',        "TEXT DEFAULT ''"],          // e.g. Grams, ML
      ['conversion_factor',  "REAL DEFAULT 1"],           // recipe_units per 1 purchase_unit (e.g. 1 KG = 1000 g → 1000)
      ['yield_percent',      "REAL DEFAULT 100"],         // material-level yield (waste/trim from purchased qty)
      ['last_purchase_price',"REAL DEFAULT 0"],           // most-recent unit_price (for cost-spike detection)
      ['last_purchase_date', "TEXT DEFAULT NULL"],
    ];
    for (const [c, t] of adds) if (!has(c)) db.exec(`ALTER TABLE raw_materials ADD COLUMN ${c} ${t}`);

    // Backfill primary_vendor from most-recent purchase
    db.exec(`
      UPDATE raw_materials
      SET primary_vendor = (
        SELECT vendor FROM purchases p
        WHERE p.material_id = raw_materials.id AND p.vendor IS NOT NULL AND p.vendor != ''
        ORDER BY p.date DESC, p.created_at DESC LIMIT 1
      )
      WHERE primary_vendor IS NULL OR primary_vendor = ''
    `);
    // Backfill purchase_unit from material's stored unit
    db.exec(`UPDATE raw_materials SET purchase_unit = unit WHERE purchase_unit IS NULL OR purchase_unit = ''`);
    db.exec(`UPDATE raw_materials SET recipe_unit   = unit WHERE recipe_unit   IS NULL OR recipe_unit   = ''`);
    // Backfill last_purchase_price/date from most-recent purchase
    db.exec(`
      UPDATE raw_materials
      SET last_purchase_price = COALESCE((
        SELECT unit_price FROM purchases p
        WHERE p.material_id = raw_materials.id
        ORDER BY p.date DESC, p.created_at DESC LIMIT 1
      ), 0),
          last_purchase_date  = (
        SELECT date FROM purchases p
        WHERE p.material_id = raw_materials.id
        ORDER BY p.date DESC, p.created_at DESC LIMIT 1
      )
      WHERE last_purchase_price IS NULL OR last_purchase_price = 0
    `);
  } catch (e) { console.error('raw_materials extension migration failed:', e); }

  // Migration: recipes carry a yield (e.g. "220 g" per batch) — needed to round-trip
  // the food-costing workbook and to optionally show cost-per-yield-unit. Additive &
  // defaulted; does NOT change recalculateRecipeCost (recipe cost stays batch cost).
  try {
    const cols = db.prepare("PRAGMA table_info(recipes)").all() as any[];
    const has = (n: string) => cols.some((c: any) => c.name === n);
    if (!has('yield_quantity')) db.exec(`ALTER TABLE recipes ADD COLUMN yield_quantity REAL DEFAULT 0`);
    if (!has('yield_unit'))     db.exec(`ALTER TABLE recipes ADD COLUMN yield_unit TEXT DEFAULT 'g'`);
  } catch (e) { console.error('recipes yield migration failed:', e); }

  // ============================================================
  // MULTI-OUTLET SUPPORT
  // ============================================================
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS outlets (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        address     TEXT DEFAULT '',
        gstin       TEXT DEFAULT '',
        is_active   INTEGER NOT NULL DEFAULT 1,
        is_default  INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Create a default outlet on first run; everything backfills to this one.
    const existing = db.prepare('SELECT id FROM outlets WHERE is_default = 1 LIMIT 1').get() as any;
    let defaultOutletId: string;
    if (existing) {
      defaultOutletId = existing.id;
    } else {
      defaultOutletId = (db.prepare("SELECT lower(hex(randomblob(16))) AS id").get() as any).id;
      db.prepare(`INSERT INTO outlets (id, name, is_default) VALUES (?, 'Main', 1)`).run(defaultOutletId);
    }

    // Add outlet_id to every transactional table — backfill to the default outlet
    const TABLES_NEEDING_OUTLET = [
      'sales', 'purchases', 'purchase_orders', 'parties', 'staff_meals',
      'closing_stock', 'inventory_transactions',
    ];
    for (const table of TABLES_NEEDING_OUTLET) {
      try {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
        if (cols.length === 0) continue;     // table doesn't exist yet
        if (!cols.some((c: any) => c.name === 'outlet_id')) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN outlet_id TEXT`);
        }
        // Backfill any NULL outlet_id rows to the default outlet
        db.exec(`UPDATE ${table} SET outlet_id = '${defaultOutletId}' WHERE outlet_id IS NULL OR outlet_id = ''`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_outlet ON ${table}(outlet_id)`);
      } catch (e) { console.error(`outlet_id migration on ${table} failed:`, e); }
    }

    // Per-user current outlet (which outlet you're viewing). Can switch anytime.
    try {
      const userCols = db.prepare("PRAGMA table_info(users)").all() as any[];
      if (userCols.length > 0 && !userCols.some((c: any) => c.name === 'current_outlet_id')) {
        db.exec(`ALTER TABLE users ADD COLUMN current_outlet_id TEXT`);
      }
      db.exec(`UPDATE users SET current_outlet_id = '${defaultOutletId}' WHERE current_outlet_id IS NULL`);
    } catch (e) { console.error('users.current_outlet_id failed:', e); }
  } catch (e) { console.error('multi-outlet schema failed:', e); }

  // Migration: per-line vendor on purchase_order_items
  try {
    const cols = db.prepare("PRAGMA table_info(purchase_order_items)").all() as any[];
    if (cols.length > 0) {
      const has = (n: string) => cols.some((c: any) => c.name === n);
      if (!has('vendor'))    db.exec(`ALTER TABLE purchase_order_items ADD COLUMN vendor TEXT DEFAULT ''`);
      if (!has('vendor_id')) db.exec(`ALTER TABLE purchase_order_items ADD COLUMN vendor_id TEXT`);
      // Backfill existing rows: copy the PO header vendor onto each line
      db.exec(`
        UPDATE purchase_order_items
        SET vendor    = COALESCE((SELECT vendor    FROM purchase_orders WHERE id = po_id), vendor),
            vendor_id = COALESCE((SELECT vendor_id FROM purchase_orders WHERE id = po_id), vendor_id)
        WHERE vendor IS NULL OR vendor = ''
      `);
    }
  } catch (e) { console.error('po_items.vendor migration failed:', e); }

  // Migration: add `approval_note` to purchase_orders for admin override audit trail
  try {
    const cols = db.prepare("PRAGMA table_info(purchase_orders)").all() as any[];
    if (!cols.some((c: any) => c.name === 'approval_note')) {
      db.exec(`ALTER TABLE purchase_orders ADD COLUMN approval_note TEXT DEFAULT ''`);
    }
  } catch (e) { console.error('po.approval_note migration failed:', e); }

  // Table: vendors (master) — referenced by purchase_orders.vendor_id, free-text vendor kept as cached display
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS vendors (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        contact_person  TEXT DEFAULT '',
        phone           TEXT DEFAULT '',
        email           TEXT DEFAULT '',
        gstin           TEXT DEFAULT '',
        address         TEXT DEFAULT '',
        payment_terms   TEXT DEFAULT '',           -- e.g. "Net 30", "On delivery"
        lead_time_days  INTEGER DEFAULT 0,
        is_active       INTEGER NOT NULL DEFAULT 1,
        notes           TEXT DEFAULT '',
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_vendors_name ON vendors(name);
    `);

    // Backfill vendors from existing purchase data — every distinct supplier becomes a vendor row.
    // Inner SELECT DISTINCT first; the outer query then assigns one random id per distinct row
    // (without inner DISTINCT, randomblob() is unique per row → DISTINCT becomes a no-op).
    db.exec(`
      INSERT INTO vendors (id, name, created_at, updated_at)
      SELECT lower(hex(randomblob(16))), v, datetime('now'), datetime('now')
      FROM (
        SELECT DISTINCT vendor AS v FROM purchases
        WHERE vendor IS NOT NULL AND TRIM(vendor) != ''
      )
      WHERE v NOT IN (SELECT name FROM vendors)
    `);

    // One-shot cleanup for the previous bug — keep one row per distinct name, re-point POs by name
    db.exec(`
      DELETE FROM vendors
      WHERE id NOT IN (
        SELECT MIN(id) FROM vendors GROUP BY name
      )
    `);
    db.exec(`
      UPDATE purchase_orders
      SET vendor_id = (SELECT id FROM vendors WHERE name = purchase_orders.vendor LIMIT 1)
      WHERE vendor_id IS NOT NULL
        AND vendor_id NOT IN (SELECT id FROM vendors)
    `);
  } catch (e) { console.error('vendors schema failed:', e); }

  // Migration: add vendor_id FK to purchase_orders, backfilled from name
  try {
    const cols = db.prepare("PRAGMA table_info(purchase_orders)").all() as any[];
    if (!cols.some((c: any) => c.name === 'vendor_id')) {
      db.exec(`ALTER TABLE purchase_orders ADD COLUMN vendor_id TEXT`);
    }
    db.exec(`
      UPDATE purchase_orders
      SET vendor_id = (SELECT id FROM vendors WHERE vendors.name = purchase_orders.vendor LIMIT 1)
      WHERE vendor_id IS NULL AND vendor IS NOT NULL AND TRIM(vendor) != ''
    `);
  } catch (e) { console.error('po vendor_id migration failed:', e); }

  // Table: vendor_contracts — per-(vendor, material) negotiated unit price.
  // PO line auto-fills the contract price; if a buyer enters a different
  // price, the UI flags it as off-contract so admin can spot creep.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS vendor_contracts (
        id              TEXT PRIMARY KEY,
        vendor_id       TEXT NOT NULL,
        material_id     TEXT NOT NULL,
        unit_price      REAL NOT NULL,
        currency        TEXT NOT NULL DEFAULT 'INR',
        valid_from      TEXT NOT NULL,                    -- ISO date YYYY-MM-DD
        valid_to        TEXT,                             -- NULL = open-ended
        notes           TEXT DEFAULT '',
        is_active       INTEGER NOT NULL DEFAULT 1,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (vendor_id)   REFERENCES vendors(id),
        FOREIGN KEY (material_id) REFERENCES raw_materials(id)
      );
      CREATE INDEX IF NOT EXISTS idx_vc_vendor   ON vendor_contracts(vendor_id);
      CREATE INDEX IF NOT EXISTS idx_vc_material ON vendor_contracts(material_id);
      CREATE INDEX IF NOT EXISTS idx_vc_active   ON vendor_contracts(is_active, valid_from, valid_to);
    `);
  } catch (e) { console.error('vendor_contracts schema failed:', e); }

  // vendor_materials — simple (vendor, material) MAPPING. No price, no dates.
  // Just declares "this vendor sells this material". Used by PO + GRN to filter
  // material pickers. Distinct from `vendor_contracts` which carries negotiated
  // prices and validity windows.
  //
  // On first migration we backfill from existing vendor_contracts so any user
  // who's been using the old approach doesn't lose their mappings.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS vendor_materials (
        vendor_id    TEXT NOT NULL,
        material_id  TEXT NOT NULL,
        notes        TEXT DEFAULT '',
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        created_by   TEXT,
        PRIMARY KEY (vendor_id, material_id),
        FOREIGN KEY (vendor_id)   REFERENCES vendors(id),
        FOREIGN KEY (material_id) REFERENCES raw_materials(id)
      );
      CREATE INDEX IF NOT EXISTS idx_vm_vendor   ON vendor_materials(vendor_id);
      CREATE INDEX IF NOT EXISTS idx_vm_material ON vendor_materials(material_id);
    `);
    // One-time backfill: every active vendor_contracts pair → vendor_materials.
    db.exec(`
      INSERT OR IGNORE INTO vendor_materials (vendor_id, material_id, notes, created_by)
      SELECT DISTINCT vendor_id, material_id, 'Backfilled from vendor_contracts', 'system'
      FROM vendor_contracts
      WHERE is_active = 1
    `);
  } catch (e) { console.error('vendor_materials schema failed:', e); }

  // Tables: purchase_orders + purchase_order_items
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS purchase_orders (
        id              TEXT PRIMARY KEY,
        po_number       TEXT NOT NULL UNIQUE,
        date            TEXT NOT NULL,
        vendor          TEXT DEFAULT '',
        status          TEXT NOT NULL DEFAULT 'draft',  -- draft | pending | approved | received | rejected | cancelled
        total_cost      REAL NOT NULL DEFAULT 0,
        notes           TEXT DEFAULT '',
        drafted_by      TEXT DEFAULT 'manager',
        submitted_at    TEXT DEFAULT NULL,
        approved_by     TEXT DEFAULT NULL,
        approved_at     TEXT DEFAULT NULL,
        rejected_reason TEXT DEFAULT NULL,
        received_at     TEXT DEFAULT NULL,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status);
      CREATE INDEX IF NOT EXISTS idx_po_date   ON purchase_orders(date);
      CREATE INDEX IF NOT EXISTS idx_po_vendor ON purchase_orders(vendor);

      CREATE TABLE IF NOT EXISTS purchase_order_items (
        id            TEXT PRIMARY KEY,
        po_id         TEXT NOT NULL,
        material_id   TEXT NOT NULL,
        quantity      REAL NOT NULL DEFAULT 0,           -- in raw_material's stock unit
        unit_price    REAL NOT NULL DEFAULT 0,
        total_price   REAL NOT NULL DEFAULT 0,
        notes         TEXT DEFAULT '',
        FOREIGN KEY (po_id)       REFERENCES purchase_orders(id) ON DELETE CASCADE,
        FOREIGN KEY (material_id) REFERENCES raw_materials(id)
      );
      CREATE INDEX IF NOT EXISTS idx_po_items_po       ON purchase_order_items(po_id);
      CREATE INDEX IF NOT EXISTS idx_po_items_material ON purchase_order_items(material_id);
    `);
  } catch (e) { console.error('purchase_orders schema failed:', e); }

  // Settings: current_role (manager | admin) — fallback when no auth session is present
  try {
    db.exec(`INSERT OR IGNORE INTO settings (key, value) VALUES ('current_role', 'admin')`);
  } catch (_) {}

  // Users + sessions for real auth
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id              TEXT PRIMARY KEY,
        email           TEXT NOT NULL UNIQUE,
        password_hash   TEXT NOT NULL,
        name            TEXT NOT NULL DEFAULT '',
        role            TEXT NOT NULL DEFAULT 'manager',  -- manager | admin
        is_active       INTEGER NOT NULL DEFAULT 1,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        last_login_at   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

      CREATE TABLE IF NOT EXISTS sessions (
        token       TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at  TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

      -- Audit columns on purchase_orders for who actually performed each action
      -- (drafted_by/approved_by already exist as text — reuse, just store user.email or role)
    `);
  } catch (e) { console.error('users/sessions schema failed:', e); }

  // Migration: add stable SKU code on raw_materials (MAT-00001…), backfilled by created_at.
  try {
    const cols = db.prepare("PRAGMA table_info(raw_materials)").all() as any[];
    const has = (n: string) => cols.some((c: any) => c.name === n);
    if (!has('sku')) {
      db.exec(`ALTER TABLE raw_materials ADD COLUMN sku TEXT`);
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_materials_sku ON raw_materials(sku) WHERE sku IS NOT NULL`);
    // Backfill any rows still missing a SKU
    const missing = db.prepare(`
      SELECT id FROM raw_materials WHERE sku IS NULL OR sku = '' ORDER BY created_at ASC, name ASC
    `).all() as any[];
    if (missing.length > 0) {
      const maxRow = db.prepare(`
        SELECT MAX(CAST(SUBSTR(sku, 5) AS INTEGER)) AS n
        FROM raw_materials WHERE sku LIKE 'MAT-%'
      `).get() as any;
      let n = (maxRow?.n || 0) + 1;
      const upd = db.prepare('UPDATE raw_materials SET sku = ? WHERE id = ?');
      const txn = db.transaction(() => {
        for (const r of missing) {
          upd.run('MAT-' + String(n).padStart(5, '0'), r.id);
          n++;
        }
      });
      txn();
    }
  } catch (e) { console.error('raw_materials.sku migration failed:', e); }

  // Migration: backfill menu_items.pos_id from sales.pos_item_id (one-shot per session).
  // For each menu item without a pos_id, find sales rows matching by name + pos_item_id != NULL,
  // pick the most common pos_item_id, write it back.
  try {
    db.exec(`
      WITH best AS (
        SELECT s.pos_item_id, s.item_name, COUNT(*) AS n,
               ROW_NUMBER() OVER (PARTITION BY LOWER(TRIM(s.item_name)) ORDER BY COUNT(*) DESC) AS rk
        FROM sales s
        WHERE s.pos_item_id IS NOT NULL AND s.pos_item_id != ''
          AND s.item_name IS NOT NULL AND TRIM(s.item_name) != ''
        GROUP BY LOWER(TRIM(s.item_name)), s.pos_item_id
      )
      UPDATE menu_items
      SET pos_id = (SELECT b.pos_item_id FROM best b
                    WHERE LOWER(TRIM(b.item_name)) = LOWER(TRIM(menu_items.name)) AND b.rk = 1)
      WHERE (pos_id IS NULL OR pos_id = '')
        AND EXISTS (SELECT 1 FROM best b
                    WHERE LOWER(TRIM(b.item_name)) = LOWER(TRIM(menu_items.name)) AND b.rk = 1)
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_menu_items_pos_id ON menu_items(pos_id) WHERE pos_id IS NOT NULL AND pos_id != ''`);
  } catch (e) { console.error('menu_items.pos_id backfill failed:', e); }

  // Migration: backfill sales.category from menu_items (one-shot). Dramatically speeds analytics.
  try {
    const flag = db.prepare("SELECT value FROM settings WHERE key = 'migration_sales_category_backfilled'").get() as any;
    if (!flag) {
      db.exec(`
        UPDATE sales
        SET category = (
          SELECT mi.category FROM menu_items mi
          WHERE LOWER(mi.name) = LOWER(sales.item_name)
          LIMIT 1
        )
        WHERE (category IS NULL OR category = '')
      `);
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('migration_sales_category_backfilled', '1')").run();
    }
  } catch (e) { console.error('sales.category backfill failed:', e); }

  // ============================================================
  // Migration: department-wise closing stock (2026-07).
  // closing_stock is now recorded PER-DEPARTMENT — the same material can be held
  // by several departments, each recording its own physical count. department_id
  // is nullable: NULL / '' = the store / overall count (backward-compatible with
  // existing callers that don't send a department_id).
  try {
    const csCols = db.prepare("PRAGMA table_info(closing_stock)").all() as any[];
    if (csCols.length > 0 && !csCols.some((c: any) => c.name === 'department_id')) {
      db.exec(`ALTER TABLE closing_stock ADD COLUMN department_id TEXT`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_closing_stock_dept ON closing_stock(department_id)`);
  } catch (e) { console.error('closing_stock.department_id migration failed:', e); }

  // Department-wise Internal Requisitions
  // ============================================================
  // Workflow:
  //   draft → submitted → chef_approved → store_processed → fulfilled
  //                    ↘  chef_rejected
  //   (cancelled is terminal from any non-terminal state)
  //
  // Roles involved (additive — admin always allowed):
  //   - department staff: drafts + submits requisitions for their department
  //   - head chef:        approves/rejects submitted requisitions
  //   - store manager:    processes chef-approved requisitions — issues stock
  //                       on hand, then auto-creates a vendor PO (status=pending)
  //                       for any shortfall, which goes to admin approval.
  //   - admin:            approves the resulting vendor PO (existing PO flow).
  // ============================================================
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS departments (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL UNIQUE,
        code            TEXT DEFAULT '',
        description     TEXT DEFAULT '',
        head_chef_user_id TEXT,                          -- optional default approver
        is_active       INTEGER NOT NULL DEFAULT 1,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (head_chef_user_id) REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS idx_dept_name ON departments(name);
    `);
    // Phase 1 §2 — per-dept submission windows. CSV list of HH:MM times, e.g. "11:00,18:30".
    const dCols = db.prepare("PRAGMA table_info(departments)").all() as any[];
    if (!dCols.some((c:any)=>c.name==='submission_windows'))       db.exec(`ALTER TABLE departments ADD COLUMN submission_windows TEXT DEFAULT ''`);
    if (!dCols.some((c:any)=>c.name==='submission_grace_minutes')) db.exec(`ALTER TABLE departments ADD COLUMN submission_grace_minutes INTEGER NOT NULL DEFAULT 30`);
    // Material category whitelist — JSON array of raw_materials.category values
    // the dept's staff can see in inventory pickers. NULL = no filter (see all).
    // Admin / head-chef / store-manager always bypass this filter.
    if (!dCols.some((c:any)=>c.name==='material_categories')) db.exec(`ALTER TABLE departments ADD COLUMN material_categories TEXT`);
    // ── Main-department hierarchy (2026-07): 3 mains (Kitchen/Bar/Operations),
    //    each with a head_user_id (the sole approver for everything under it);
    //    existing departments become sub-departments via parent_id. Categories
    //    are assigned on the MAIN dept and inherited by its sub-depts. ──
    if (!dCols.some((c:any)=>c.name==='parent_id'))    db.exec(`ALTER TABLE departments ADD COLUMN parent_id TEXT`);
    if (!dCols.some((c:any)=>c.name==='head_user_id')) db.exec(`ALTER TABLE departments ADD COLUMN head_user_id TEXT`);
    // ── Department AREA (2026-07): coarse grouping used for closing-stock rollups.
    //    Values: kitchen | bar | store | service | other. '' = unset. A department
    //    belongs to exactly one area; several sub-departments can share an area
    //    (e.g. Hot Kitchen + Cold Kitchen + Pastry all roll up to 'kitchen').
    if (!dCols.some((c:any)=>c.name==='area')) db.exec(`ALTER TABLE departments ADD COLUMN area TEXT DEFAULT ''`);
    // One-time seed, guarded by a settings flag so admin edits are never clobbered.
    const deptHierSeeded = db.prepare("SELECT value FROM settings WHERE key = 'dept_hierarchy_v1'").get() as { value?: string } | undefined;
    if (!deptHierSeeded) {
      const mkMain = (name: string): string => {
        db.prepare(`INSERT OR IGNORE INTO departments (id, name, parent_id, is_active) VALUES (?, ?, NULL, 1)`).run(generateId(), name);
        return (db.prepare(`SELECT id FROM departments WHERE name = ?`).get(name) as { id: string }).id;
      };
      const kitchenId = mkMain('Kitchen');
      const barId = mkMain('Bar');
      const opsId = mkMain('Operations');
      db.prepare(`UPDATE departments SET parent_id = NULL WHERE id IN (?, ?, ?)`).run(kitchenId, barId, opsId);
      // Bucket existing raw-material categories into the 3 mains as a STARTING
      // default (admin refines in the Departments UI). Keyword-based so future
      // categories still land somewhere sensible.
      const cats = (db.prepare(`SELECT DISTINCT COALESCE(NULLIF(category,''),'other') c FROM raw_materials`).all() as { c: string }[]).map(r => r.c);
      // Operations FIRST — otherwise short liquor tokens false-match: e.g. "gin"
      // is a substring of "packa-gin-g". Short/ambiguous bar words are also
      // word-boundaried (\bbar\b, \brum\b, \bgin\b) so they don't hit "barley" etc.
      const OPS_CAT = /packag|housekeep|station|clean|disposable|cutlery|printer|office|maintenance|tissue/i;
      const BAR_CAT = /\bbar\b|beer|wine|whisk|\brum\b|tequila|vodka|\bgin\b|brandy|scotch|bourbon|liqueur|liquor|spirit|beverage|syrup|crush|cocktail|soda|malt/i;
      const bkt: Record<string, string[]> = { kitchen: [], bar: [], ops: [] };
      for (const c of cats) { if (OPS_CAT.test(c)) bkt.ops.push(c); else if (BAR_CAT.test(c)) bkt.bar.push(c); else bkt.kitchen.push(c); }
      const setCats = (id: string, arr: string[]) => { if (arr.length) db.prepare(`UPDATE departments SET material_categories = ? WHERE id = ? AND (material_categories IS NULL OR material_categories = '')`).run(JSON.stringify(arr), id); };
      setCats(kitchenId, bkt.kitchen); setCats(barId, bkt.bar); setCats(opsId, bkt.ops);
      // Assign each existing (non-main) department a parent by name heuristic.
      const others = db.prepare(`SELECT id, name FROM departments WHERE id NOT IN (?, ?, ?)`).all(kitchenId, barId, opsId) as { id: string; name: string }[];
      const BAR_DEPT = /\bbar\b|liquor|beverage|wine|cocktail/i;
      const OPS_DEPT = /operation|store|packag|house|admin|office|general|\bgm\b|front|reception|maintenance/i;
      const setParent = db.prepare(`UPDATE departments SET parent_id = ? WHERE id = ? AND parent_id IS NULL`);
      for (const d of others) { const p = BAR_DEPT.test(d.name) ? barId : OPS_DEPT.test(d.name) ? opsId : kitchenId; setParent.run(p, d.id); }
      db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('dept_hierarchy_v1', '1')`).run();
    }

    // ── ONE-TIME PRICE/STOCK BASIS REPAIR (2026-07) ──────────────────────────
    // Historical inward-import rows mixed unit bases, corrupting money data:
    //  A) ml/L materials: purchase rows written in RECIPE units (qty=9000 ml,
    //     price ₹/ml); updateMaterialPrice then ÷pack again → average_price ~pack×
    //     too small (Jameson ₹2.85/BTL instead of ₹2,421). Stock was fine.
    //  B) kg/g (and keg) materials: stock bumped in PURCHASE units (10 kegs stored
    //     as "10" in an ml field) → stock ~pack× too small. Price was fine.
    // Guard flag so it runs exactly once; both sets are classified BEFORE any
    // mutation (normalizing rows first would fool the detector).
    const priceRepaired = db.prepare("SELECT value FROM settings WHERE key = 'price_basis_repair_v1'").get() as { value?: string } | undefined;
    if (!priceRepaired) {
      // Atomic: if any step throws, roll back everything so a re-run starts from
      // the original (un-normalized) rows — a half-normalized DB would be
      // mis-classified on the next attempt.
      const runRepair = db.transaction(() => {
        const packMats = db.prepare(`
          SELECT id, pack_size, current_stock FROM raw_materials
          WHERE COALESCE(pack_size,1) > 1 AND LOWER(unit) <> LOWER(COALESCE(purchase_unit, unit))
        `).all() as { id: string; pack_size: number; current_stock: number }[];
        const priceSet: { id: string; pack_size: number }[] = [];
        const stockSet: { id: string; pack_size: number; current_stock: number; purchSum: number }[] = [];
        for (const m of packMats) {
          const pr = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(quantity),0) sq FROM purchases WHERE material_id = ? AND quantity > 0`).get(m.id) as any;
          if (!pr.n) continue;                          // no purchases → leave for manual review
          const recipeRows = (db.prepare(`SELECT COUNT(*) n FROM purchases WHERE material_id = ? AND quantity >= ? AND (quantity % ?) = 0`).get(m.id, m.pack_size, m.pack_size) as any).n;
          if (recipeRows > 0) priceSet.push({ id: m.id, pack_size: m.pack_size });          // A: price wrong, stock OK
          else stockSet.push({ id: m.id, pack_size: m.pack_size, current_stock: m.current_stock, purchSum: pr.sq }); // B: stock wrong, price OK
        }
        // A) normalize recipe-basis rows → purchase units (prefer invoice total_price)
        const updRow = db.prepare(`UPDATE purchases SET quantity = ?, unit_price = ? WHERE id = ?`);
        for (const m of priceSet) {
          const rows = db.prepare(`SELECT id, quantity, unit_price, total_price FROM purchases WHERE material_id = ? AND quantity >= ? AND (quantity % ?) = 0`).all(m.id, m.pack_size, m.pack_size) as any[];
          for (const r of rows) {
            const nq = r.quantity / m.pack_size;
            const nup = (r.total_price > 0) ? r.total_price / nq : r.unit_price * m.pack_size;
            updRow.run(nq, Math.round(nup * 10000) / 10000, r.id);
          }
        }
        // B) rebase stock into recipe units: add (pack-1) × Σ(purchase qty)
        for (const m of stockSet) {
          const correction = m.purchSum * (m.pack_size - 1);
          if (correction > 0) db.prepare(`UPDATE raw_materials SET current_stock = ? WHERE id = ?`).run(m.current_stock + correction, m.id);
        }
        // re-price every purchased material (now safe), cascade recipe/sub-recipe costs
        for (const x of db.prepare(`SELECT DISTINCT material_id id FROM purchases`).all() as any[]) updateMaterialPrice(db, x.id);
        for (const s of db.prepare(`SELECT id FROM sub_recipes`).all() as any[]) recalculateSubRecipeCost(db, s.id);
        for (const r of db.prepare(`SELECT id FROM recipes`).all() as any[]) recalculateRecipeCost(db, r.id);
        db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('price_basis_repair_v1', '1')`).run();
        console.log(`[db] price/stock basis repair: fixed ${priceSet.length} prices + ${stockSet.length} stocks`);
      });
      try { runRepair(); }
      catch (e) { console.error('[db] price_basis_repair_v1 failed (rolled back, left unrepaired):', e); }
    }

    db.exec(`

      CREATE TABLE IF NOT EXISTS requisitions (
        id                  TEXT PRIMARY KEY,
        req_number          TEXT NOT NULL UNIQUE,         -- REQ-YYYY-NNNN
        department_id       TEXT NOT NULL,
        date                TEXT NOT NULL,                -- YYYY-MM-DD
        status              TEXT NOT NULL DEFAULT 'draft',
        notes               TEXT DEFAULT '',
        outlet_id           TEXT,

        -- Stage 1: department raised
        drafted_by          TEXT DEFAULT '',
        submitted_at        TEXT,
        submitted_by        TEXT DEFAULT '',

        -- Stage 2: head chef approval
        chef_approved_at    TEXT,
        chef_approved_by    TEXT DEFAULT '',
        chef_note           TEXT DEFAULT '',
        -- Stage 2b: Mgmt approval (per Phase 1 SOP §2 — Dept→Chef→Mgmt→Store)
        mgmt_approved_at    TEXT,
        mgmt_approved_by    TEXT DEFAULT '',
        mgmt_note           TEXT DEFAULT '',
        rejected_at         TEXT,
        rejected_by         TEXT DEFAULT '',
        rejected_reason     TEXT DEFAULT '',

        -- Stage 3: store manager processing
        store_processed_at  TEXT,
        store_processed_by  TEXT DEFAULT '',
        store_note          TEXT DEFAULT '',
        linked_po_id        TEXT,                         -- vendor PO created for shortfall

        -- Final fulfilment
        fulfilled_at        TEXT,
        fulfilled_by        TEXT DEFAULT '',

        cancelled_at        TEXT,
        cancelled_by        TEXT DEFAULT '',

        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (department_id) REFERENCES departments(id),
        FOREIGN KEY (linked_po_id)  REFERENCES purchase_orders(id),
        FOREIGN KEY (outlet_id)     REFERENCES outlets(id)
      );
      CREATE INDEX IF NOT EXISTS idx_req_dept     ON requisitions(department_id);
      CREATE INDEX IF NOT EXISTS idx_req_status   ON requisitions(status);
      CREATE INDEX IF NOT EXISTS idx_req_date     ON requisitions(date);
      CREATE INDEX IF NOT EXISTS idx_req_outlet   ON requisitions(outlet_id);

      CREATE TABLE IF NOT EXISTS requisition_items (
        id                    TEXT PRIMARY KEY,
        req_id                TEXT NOT NULL,
        material_id           TEXT NOT NULL,
        quantity_requested    REAL NOT NULL,
        quantity_issued       REAL NOT NULL DEFAULT 0,    -- store gave from on-hand
        quantity_to_purchase  REAL NOT NULL DEFAULT 0,    -- shortfall sent to vendor PO
        notes                 TEXT DEFAULT '',
        created_at            TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (req_id)      REFERENCES requisitions(id) ON DELETE CASCADE,
        FOREIGN KEY (material_id) REFERENCES raw_materials(id)
      );
      CREATE INDEX IF NOT EXISTS idx_req_items_req ON requisition_items(req_id);
    `);
  } catch (e) { console.error('requisitions schema failed:', e); }

  // Department on-hand ledger — party fulfilment TRANSFERS materials store→dept:
  // raw_materials.current_stock decreases (store ledger) and the respective
  // department's on_hand increases. Post-party each department records leftover
  // balance so consumption is tracked. department_materials is the running
  // balance; department_material_transactions is the append-only ledger.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS department_materials (
        id            TEXT PRIMARY KEY,
        outlet_id     TEXT,
        department_id TEXT NOT NULL,
        material_id   TEXT NOT NULL,
        on_hand       REAL NOT NULL DEFAULT 0,
        updated_at    TEXT DEFAULT (datetime('now')),
        UNIQUE(department_id, material_id)
      );
      CREATE INDEX IF NOT EXISTS idx_dept_materials_dept ON department_materials(department_id);

      CREATE TABLE IF NOT EXISTS department_material_transactions (
        id            TEXT PRIMARY KEY,
        outlet_id     TEXT,
        department_id TEXT NOT NULL,
        material_id   TEXT NOT NULL,
        type          TEXT NOT NULL,               -- received | consumed | returned | adjusted
        quantity      REAL DEFAULT 0,              -- positive = in, negative = out
        balance_after REAL DEFAULT 0,
        reference_id  TEXT,
        event_name    TEXT DEFAULT '',
        event_date    TEXT DEFAULT '',
        notes         TEXT DEFAULT '',
        user          TEXT DEFAULT '',
        created_at    TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_dept_mat_tx_dept_mat ON department_material_transactions(department_id, material_id);
    `);
  } catch (e) { console.error('department_materials schema failed:', e); }

  // Butchering — track whole-carcass breakdown into named cuts.
  // Buys carcass at vendor rate (per kg of dressed weight); cuts inherit
  // pro-rata cost (default by weight). Waste is tracked separately so the
  // butcher's loss % is visible in the yield report.
  //
  // Flow:
  //   1. Create batch (status='open'): records source material + gross weight
  //   2. Add output lines (cut or waste) with weight
  //   3. Close batch (status='closed'): atomically debits source stock and
  //      credits each cut into raw_materials.current_stock
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS butchering_batches (
        id                   TEXT PRIMARY KEY,
        batch_id             TEXT UNIQUE NOT NULL,        -- e.g. MUT-20260520-RAJBR-01
        source_material_id   TEXT NOT NULL,               -- the whole-carcass SKU
        vendor_id            TEXT,
        grn_id               TEXT,                        -- optional link to GRN
        gross_weight         REAL NOT NULL,               -- kg of dressed carcass
        invoice_weight       REAL,                        -- what vendor charged for
        cost_per_unit        REAL NOT NULL DEFAULT 0,     -- source material's avg_price at batch time
        total_cost           REAL NOT NULL DEFAULT 0,     -- gross_weight * cost_per_unit
        cost_allocation      TEXT NOT NULL DEFAULT 'weight',  -- 'weight' | 'value_coefficient' (future)
        butcher              TEXT DEFAULT '',
        head_chef            TEXT DEFAULT '',
        status               TEXT NOT NULL DEFAULT 'open', -- 'open' | 'closed' | 'cancelled'
        notes                TEXT DEFAULT '',
        outlet_id            TEXT,
        created_by           TEXT,
        created_at           TEXT NOT NULL DEFAULT (datetime('now')),
        closed_at            TEXT,
        FOREIGN KEY (source_material_id) REFERENCES raw_materials(id)
      );
      CREATE INDEX IF NOT EXISTS idx_bb_status    ON butchering_batches(status);
      CREATE INDEX IF NOT EXISTS idx_bb_created   ON butchering_batches(created_at);

      CREATE TABLE IF NOT EXISTS butchering_outputs (
        id              TEXT PRIMARY KEY,
        batch_id        TEXT NOT NULL,                  -- FK to butchering_batches.id (not batch_id text)
        output_type     TEXT NOT NULL,                  -- 'cut' | 'waste'
        material_id     TEXT,                            -- NULL for waste rows
        waste_category  TEXT,                            -- NULL for cut rows: 'fat' | 'sinew' | 'discarded_bone' | 'spoilage' | 'other'
        weight          REAL NOT NULL,
        cost_allocated  REAL NOT NULL DEFAULT 0,         -- pro-rata share of batch total_cost (waste rows always 0)
        yield_pct       REAL NOT NULL DEFAULT 0,         -- weight / batch.gross_weight * 100
        notes           TEXT DEFAULT '',
        FOREIGN KEY (batch_id) REFERENCES butchering_batches(id) ON DELETE CASCADE,
        FOREIGN KEY (material_id) REFERENCES raw_materials(id)
      );
      CREATE INDEX IF NOT EXISTS idx_bo_batch    ON butchering_outputs(batch_id);
      CREATE INDEX IF NOT EXISTS idx_bo_material ON butchering_outputs(material_id);
    `);
  } catch (e) { console.error('butchering schema failed:', e); }

  // Party consumption — post-event bottle / beverage / direct-issue tracking
  // for per-party P&L. Liquor cost is captured here (food cost comes from
  // party requisitions). Cost is snapshotted at recording time so historical
  // P&L is stable even if material avg_price drifts later.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS party_consumption (
        id              TEXT PRIMARY KEY,
        party_unique_id TEXT,
        fp_id           TEXT,
        event_name      TEXT NOT NULL,
        event_date      TEXT NOT NULL,
        material_id     TEXT NOT NULL,
        qty_consumed    REAL NOT NULL,
        cost_at_time    REAL NOT NULL DEFAULT 0,
        notes           TEXT DEFAULT '',
        recorded_at     TEXT NOT NULL DEFAULT (datetime('now')),
        recorded_by     TEXT,
        FOREIGN KEY (material_id) REFERENCES raw_materials(id)
      );
      CREATE INDEX IF NOT EXISTS idx_pc_party ON party_consumption(party_unique_id);
      CREATE INDEX IF NOT EXISTS idx_pc_event ON party_consumption(event_name, event_date);
    `);
  } catch (e) { console.error('party_consumption schema failed:', e); }

  // party_status_audit — diff log written by the scheduled refresh of the
  // AKAN Party Manager sheet. Captures who/when each FP changed status so
  // admins can trace "when did the Sharma wedding get approved?"
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS party_status_audit (
        id              TEXT PRIMARY KEY,
        party_unique_id TEXT,
        fp_id           TEXT,
        event_name      TEXT,
        event_date      TEXT,
        old_status      TEXT,
        new_status      TEXT,
        detected_at     TEXT NOT NULL DEFAULT (datetime('now')),
        source          TEXT NOT NULL DEFAULT 'cron'
      );
      CREATE INDEX IF NOT EXISTS idx_psa_detected ON party_status_audit(detected_at);
      CREATE INDEX IF NOT EXISTS idx_psa_party    ON party_status_audit(party_unique_id);
      CREATE INDEX IF NOT EXISTS idx_psa_status   ON party_status_audit(new_status);
    `);
  } catch (e) { console.error('party_status_audit schema failed:', e); }

  // notifications — outbound queue + log. Channels: 'slack' | 'email' | 'inapp'.
  // - sent_at NULL  → queued, not yet delivered (email stays here until SMTP wired)
  // - sent_at SET   → delivered (success); see delivery_meta for response details
  // - kind is used for dedup so the same trigger doesn't fire repeatedly
  // (e.g. approving the same party twice in a day shouldn't double-ping Slack)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        id              TEXT PRIMARY KEY,
        kind            TEXT NOT NULL,                 -- e.g. 'party_approved_within_24h'
        party_unique_id TEXT,
        fp_id           TEXT,
        event_name      TEXT,
        event_date      TEXT,
        channel         TEXT NOT NULL DEFAULT 'slack', -- 'slack' | 'email' | 'inapp'
        recipient       TEXT DEFAULT '',
        title           TEXT NOT NULL,
        body            TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        sent_at         TEXT,
        delivery_meta   TEXT DEFAULT '',
        UNIQUE (party_unique_id, kind, channel)
      );
      CREATE INDEX IF NOT EXISTS idx_notif_created ON notifications(created_at);
      CREATE INDEX IF NOT EXISTS idx_notif_sent    ON notifications(sent_at);
    `);
  } catch (e) { console.error('notifications schema failed:', e); }

  // Migration: per-line department on requisition items so a single party
  // requisition can span kitchen + bar + housekeeping with each item tagged
  // to the owning department. Backfills from parent requisition.department_id.
  try {
    const cols = db.prepare("PRAGMA table_info(requisition_items)").all() as any[];
    const has = (n: string) => cols.some((c: any) => c.name === n);
    if (!has('department_id')) {
      db.exec(`ALTER TABLE requisition_items ADD COLUMN department_id TEXT`);
      db.exec(`
        UPDATE requisition_items
        SET department_id = (SELECT department_id FROM requisitions WHERE id = requisition_items.req_id)
        WHERE department_id IS NULL
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_req_items_dept ON requisition_items(department_id)`);
    }
  } catch (e) { console.error('requisition_items per-line dept migration failed:', e); }

  // Migration: chef per-item controls. Lets the approving head chef tweak
  // individual quantities and reject specific items WITHOUT having to reject
  // the whole requisition. Each change is also logged to audit_events.
  //   chef_approved_qty   — what the chef actually approved (may differ from
  //                          quantity_requested). NULL = no chef edit yet → effective qty
  //                          is quantity_requested.
  //   is_rejected         — chef explicitly rejected this item (won't be issued
  //                          by store even when the parent req is chef_approved).
  //   chef_note           — free-text reason ("over budget", "out of season", etc.)
  try {
    const cols = db.prepare("PRAGMA table_info(requisition_items)").all() as any[];
    const has = (n: string) => cols.some((c: any) => c.name === n);
    if (!has('chef_approved_qty')) db.exec(`ALTER TABLE requisition_items ADD COLUMN chef_approved_qty REAL`);
    if (!has('is_rejected'))       db.exec(`ALTER TABLE requisition_items ADD COLUMN is_rejected INTEGER NOT NULL DEFAULT 0`);
    if (!has('chef_note'))         db.exec(`ALTER TABLE requisition_items ADD COLUMN chef_note TEXT DEFAULT ''`);
  } catch (e) { console.error('requisition_items chef-per-item migration failed:', e); }

  // Migration: `unit` column on requisition_items. The party-req modal now lets
  // staff pick a unit per line (kg / BTL / etc., scoped to the material's
  // registered units). Without this column the INSERT fails with
  // "table requisition_items has no column named unit" on any pre-existing prod DB.
  try {
    const cols = db.prepare("PRAGMA table_info(requisition_items)").all() as any[];
    const has = (n: string) => cols.some((c: any) => c.name === n);
    if (!has('unit')) db.exec(`ALTER TABLE requisition_items ADD COLUMN unit TEXT DEFAULT ''`);
  } catch (e) { console.error('requisition_items unit-column migration failed:', e); }

  // Migration: store-issue per-item tracking. The store manager doesn't always
  // issue every item at once — some are out, some are coming in tomorrow. These
  // columns let an item be partially issued / deferred with a promised time,
  // independent of the parent requisition status.
  //   issued_at        — exact timestamp the item was handed over to the dept
  //   issued_by        — store user who issued it
  //   deferred_until   — ISO datetime the store has promised to issue the item
  //   defer_reason     — free-text ("waiting on vendor", "out of cold storage")
  //   issue_history    — JSON array of {qty, at, by} for split-issues
  try {
    const cols = db.prepare("PRAGMA table_info(requisition_items)").all() as any[];
    const has = (n: string) => cols.some((c: any) => c.name === n);
    if (!has('issued_at'))      db.exec(`ALTER TABLE requisition_items ADD COLUMN issued_at TEXT`);
    if (!has('issued_by'))      db.exec(`ALTER TABLE requisition_items ADD COLUMN issued_by TEXT`);
    if (!has('deferred_until')) db.exec(`ALTER TABLE requisition_items ADD COLUMN deferred_until TEXT`);
    if (!has('defer_reason'))   db.exec(`ALTER TABLE requisition_items ADD COLUMN defer_reason TEXT DEFAULT ''`);
    if (!has('issue_history'))  db.exec(`ALTER TABLE requisition_items ADD COLUMN issue_history TEXT DEFAULT '[]'`);
  } catch (e) { console.error('requisition_items store-issue migration failed:', e); }

  // Migration: store-side per-item rejection. DISTINCT from is_rejected (which is
  // the chef's field). The store person can reject a line they cannot fulfil at
  // all (e.g. material discontinued, wrong item requested) without it being a
  // chef decision. A store-rejected line is treated like a chef-rejected line for
  // fulfillment purposes — it is NOT required to be issued for the parent req to
  // become 'fulfilled'.
  //   store_rejected       — 1 = the store rejected this line (won't be issued)
  //   store_reject_reason  — free-text ("discontinued", "wrong item", etc.)
  try {
    const cols = db.prepare("PRAGMA table_info(requisition_items)").all() as any[];
    const has = (n: string) => cols.some((c: any) => c.name === n);
    if (!has('store_rejected'))      db.exec(`ALTER TABLE requisition_items ADD COLUMN store_rejected INTEGER NOT NULL DEFAULT 0`);
    if (!has('store_reject_reason')) db.exec(`ALTER TABLE requisition_items ADD COLUMN store_reject_reason TEXT DEFAULT ''`);
  } catch (e) { console.error('requisition_items store-reject migration failed:', e); }

  // Migration: Unit-audit locks — a curated snapshot of admin-fixed unit fields
  // (recipe_unit, purchase_unit, pack_size, case_size, category) per material.
  // Keyed by SKU (preferred) and name (fallback) so it survives a full data wipe
  // and re-upload. Two purposes:
  //   1) Re-apply via /api/unit-audit/import after a clean reseed → no manual re-fix.
  //   2) Defend against purchases imports overwriting curated units — inward-commit
  //      checks the lock and either reuses it for new materials or refuses to mutate
  //      an existing locked material's units.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS unit_audit_locks (
        id            TEXT PRIMARY KEY,
        sku           TEXT,
        name_key      TEXT NOT NULL,           -- lower-cased trimmed name
        name          TEXT NOT NULL,           -- last-known display name
        recipe_unit   TEXT,
        purchase_unit TEXT,
        pack_size     REAL,
        case_size     REAL,
        category      TEXT,
        locked_by     TEXT,
        locked_at     TEXT DEFAULT (datetime('now')),
        updated_at    TEXT DEFAULT (datetime('now'))
      )
    `);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ualock_sku  ON unit_audit_locks(sku) WHERE sku IS NOT NULL AND sku != ''`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ualock_name ON unit_audit_locks(name_key)`);
  } catch (e) { console.error('unit_audit_locks migration failed:', e); }

  // Migrations: add user flags so we can identify head chefs and store managers.
  // Admin role always implicitly has both permissions; these flags only matter
  // for non-admin users.
  // Also adds `position` (Bar Manager / Sous Chef / Operations Manager / etc.) which
  // is a descriptive job-title used to drive approval-flag defaults at edit time.
  try {
    const cols = db.prepare("PRAGMA table_info(users)").all() as any[];
    const has = (n: string) => cols.some((c: any) => c.name === n);
    if (!has('department_id'))      db.exec(`ALTER TABLE users ADD COLUMN department_id TEXT`);
    if (!has('is_head_chef'))       db.exec(`ALTER TABLE users ADD COLUMN is_head_chef INTEGER NOT NULL DEFAULT 0`);
    if (!has('is_store_manager'))   db.exec(`ALTER TABLE users ADD COLUMN is_store_manager INTEGER NOT NULL DEFAULT 0`);
    if (!has('position'))           db.exec(`ALTER TABLE users ADD COLUMN position TEXT DEFAULT ''`);
    // Per-user page access map. NULL = full access (backward compat). When set,
    // a JSON array of allowed paths from src/lib/page-catalog.ts.
    if (!has('page_access'))        db.exec(`ALTER TABLE users ADD COLUMN page_access TEXT`);
    // Per-user department visibility map. NULL = only see own department's data
    // (current behavior). When set, a JSON array of department_ids whose
    // requisitions / consumption / approvals are visible to this user.
    // Admin / head chef / store manager always see everything, ignoring this.
    if (!has('visible_department_ids')) db.exec(`ALTER TABLE users ADD COLUMN visible_department_ids TEXT`);
    // Captain area assignment: which floors/zones + specific tables a captain may
    // work. NULL = all (unrestricted). Enforced only when the `captain_area_lock`
    // setting is ON and the user is a plain captain (admins/managers bypass).
    if (!has('preferred_zones'))     db.exec(`ALTER TABLE users ADD COLUMN preferred_zones TEXT`);      // JSON array of zone strings
    if (!has('preferred_table_ids')) db.exec(`ALTER TABLE users ADD COLUMN preferred_table_ids TEXT`);  // JSON array of table ids
    // Parent Role / functional section: Kitchen | Bar | Service | Maintenance | Store
    // ('' = unset). Per-user; drives the KDS ticket filter + KOT printer routing.
    if (!has('section'))             db.exec(`ALTER TABLE users ADD COLUMN section TEXT DEFAULT ''`);
  } catch (e) { console.error('users role-flags migration failed:', e); }

  // ── Named roles (Floor Manager, Captain, Cashier, Bar Manager …) ───────────
  // A role bundles a privilege TIER (base_role: admin|manager|staff — drives the
  // existing API permission gates) with a default page-access set. Assigning a
  // role to a user (users.role_id) drives both; a per-user page_access still
  // overrides the role default. getCurrentUser() resolves the effective tier +
  // pages, so no enforcement site needs to change. is_system roles can't be
  // deleted. Seeded once, idempotent by unique name; admins edit them in the UI.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS roles (
        id               TEXT PRIMARY KEY,
        name             TEXT NOT NULL UNIQUE,
        base_role        TEXT NOT NULL DEFAULT 'staff',   -- admin | manager | staff
        page_access      TEXT,                            -- JSON array of paths; NULL = all pages
        is_head_chef     INTEGER NOT NULL DEFAULT 0,
        is_store_manager INTEGER NOT NULL DEFAULT 0,
        is_system        INTEGER NOT NULL DEFAULT 0,
        is_active        INTEGER NOT NULL DEFAULT 1,
        sort_order       INTEGER NOT NULL DEFAULT 0,
        description      TEXT DEFAULT '',
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_roles_active ON roles(is_active);
    `);
    const ucols = db.prepare("PRAGMA table_info(users)").all() as any[];
    if (!ucols.some((c: any) => c.name === 'role_id')) db.exec(`ALTER TABLE users ADD COLUMN role_id TEXT`);

    // Discount permission per role (set by an ops manager/admin on /settings/roles):
    // can_request_discount = this role may REQUEST a bill discount (e.g. Cashier);
    // max_discount_pct = the cap they can request. Approval is still Manager/Admin.
    const rCols = db.prepare("PRAGMA table_info(roles)").all() as any[];
    if (!rCols.some((c: any) => c.name === 'can_request_discount')) db.exec(`ALTER TABLE roles ADD COLUMN can_request_discount INTEGER NOT NULL DEFAULT 0`);
    if (!rCols.some((c: any) => c.name === 'max_discount_pct'))     db.exec(`ALTER TABLE roles ADD COLUMN max_discount_pct REAL NOT NULL DEFAULT 0`);

    const seedRole = db.prepare(`
      INSERT OR IGNORE INTO roles (id, name, base_role, page_access, is_head_chef, is_store_manager, is_system, sort_order, description)
      VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const J = (a: string[]) => JSON.stringify(a);
    // [name, base_role, page_access(JSON|null), is_head_chef, is_store_manager, is_system, sort_order, description]
    const seeds: Array<[string, string, string | null, number, number, number, number, string]> = [
      ['Administrator', 'admin',   null, 0, 0, 1, 0, 'Full access to everything'],
      ['Manager',       'manager', null, 0, 0, 1, 1, 'Full access; runs operations'],
      ['Staff',         'staff',   J(['/requisitions']), 0, 0, 1, 2, 'Raises requisitions only'],
      ['Floor Manager', 'manager', J(['/', '/dine-in/floor', '/dine-in/tables', '/dine-in/kitchen', '/dine-in/order', '/dine-in/reconciliation', '/captain', '/print/agent', '/reports']), 0, 0, 0, 10, 'Runs the dining floor'],
      ['Captain',       'staff',   J(['/captain']), 0, 0, 0, 11, 'Takes table orders on a tablet'],
      ['Cashier',       'staff',   J(['/dine-in/floor', '/dine-in/tables', '/dine-in/order', '/captain']), 0, 0, 0, 12, 'Takes orders and settles bills'],
      ['Bar Manager',   'manager', J(['/dine-in/floor', '/dine-in/tables', '/dine-in/kitchen', '/dine-in/offline-print', '/print/agent', '/reports']), 0, 0, 0, 13, 'Runs the bar and its printers'],
      ['Head Chef',     'manager', J(['/dine-in/kitchen', '/requisitions', '/menu-items', '/recipes', '/department-consumption']), 1, 0, 0, 14, 'Runs the kitchen; approves requisitions'],
      ['Store Manager', 'manager', J(['/store-dashboard', '/store-requisitions', '/purchases', '/purchase-orders', '/grn', '/inventory', '/closing-stock', '/wastage', '/departments', '/vendors']), 0, 1, 0, 15, 'Runs the store; issues inventory'],
    ];
    for (const s of seeds) seedRole.run(s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]);
  } catch (e) { console.error('roles schema/seed migration failed:', e); }

  // Mark the linked_po_id column on purchase_orders so we can navigate from PO → Requisition
  try {
    const cols = db.prepare("PRAGMA table_info(purchase_orders)").all() as any[];
    if (!cols.some((c: any) => c.name === 'requisition_id')) {
      db.exec(`ALTER TABLE purchase_orders ADD COLUMN requisition_id TEXT`);
    }
  } catch (e) { console.error('po.requisition_id migration failed:', e); }

  // Phase 1 §1: units registry — editable from /units page.
  // We mirror the built-in UNIT_REGISTRY into this table on first run so admins
  // can add/adjust units (toBase factors, aliases, labels) without code changes.
  // The runtime conversion engine reloads from this table after each write.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS units (
        key         TEXT PRIMARY KEY,         -- canonical key (e.g. 'kg', 'BTL')
        label       TEXT NOT NULL,
        aliases     TEXT NOT NULL DEFAULT '[]', -- JSON array of strings
        dimension   TEXT NOT NULL CHECK (dimension IN ('volume','weight','count')),
        to_base     REAL NOT NULL DEFAULT 1,
        is_builtin  INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const seeded = db.prepare("SELECT value FROM settings WHERE key='units_registry_seeded_v1'").get() as any;
    if (!seeded) {
      // Seed from the in-memory built-in registry. We don't import it because
      // db.ts loads before everything else; instead we hard-code the seed list
      // here. Keep in sync with BUILT_IN_REGISTRY in src/lib/units.ts.
      const seed: Array<{ key: string; label: string; aliases: string[]; dimension: string; toBase: number }> = [
        // Volume
        { key: 'ml',   label: 'ml',   aliases: ['ml','milliliter','millilitre'], dimension: 'volume', toBase: 1 },
        { key: 'cl',   label: 'cl',   aliases: ['cl'],                            dimension: 'volume', toBase: 10 },
        { key: 'L',    label: 'L',    aliases: ['l','lt','ltr','liter','litre'],  dimension: 'volume', toBase: 1000 },
        { key: 'oz',   label: 'oz',   aliases: ['oz','fl oz','fluid ounce'],      dimension: 'volume', toBase: 29.5735 },
        { key: 'tsp',  label: 'tsp',  aliases: ['tsp','teaspoon'],                dimension: 'volume', toBase: 4.92892 },
        { key: 'tbsp', label: 'tbsp', aliases: ['tbsp','tablespoon'],             dimension: 'volume', toBase: 14.7868 },
        { key: 'cup',  label: 'cup',  aliases: ['cup','cups'],                    dimension: 'volume', toBase: 240 },
        // Weight
        { key: 'mg',   label: 'mg',   aliases: ['mg','milligram'],                dimension: 'weight', toBase: 0.001 },
        { key: 'g',    label: 'g',    aliases: ['g','gm','gms','grm','grms','gram'], dimension: 'weight', toBase: 1 },
        { key: 'kg',   label: 'kg',   aliases: ['kg','kilo','kilogram'],          dimension: 'weight', toBase: 1000 },
        { key: 'lb',   label: 'lb',   aliases: ['lb','lbs','pound'],              dimension: 'weight', toBase: 453.592 },
        // Count
        { key: 'pcs',  label: 'pcs',  aliases: ['pcs','pc','piece','each','unit','units'], dimension: 'count', toBase: 1 },
        { key: 'BTL',  label: 'BTL',  aliases: ['btl','bottle','bottles'],        dimension: 'count', toBase: 1 },
        { key: 'CASE', label: 'CASE', aliases: ['case','cs'],                     dimension: 'count', toBase: 1 },
        { key: 'PKT',  label: 'PKT',  aliases: ['pkt','packet','pack'],           dimension: 'count', toBase: 1 },
        { key: 'TIN',  label: 'TIN',  aliases: ['tin'],                           dimension: 'count', toBase: 1 },
        { key: 'CAN',  label: 'CAN',  aliases: ['can'],                           dimension: 'count', toBase: 1 },
        { key: 'JAR',  label: 'JAR',  aliases: ['jar'],                           dimension: 'count', toBase: 1 },
        { key: 'BOX',  label: 'BOX',  aliases: ['box','carton'],                  dimension: 'count', toBase: 1 },
        { key: 'BAG',  label: 'BAG',  aliases: ['bag','sack'],                    dimension: 'count', toBase: 1 },
        { key: 'BUNCH',label: 'BUNCH',aliases: ['bunch'],                         dimension: 'count', toBase: 1 },
        { key: 'TRAY', label: 'TRAY', aliases: ['tray'],                          dimension: 'count', toBase: 1 },
      ];
      const ins = db.prepare(`INSERT OR IGNORE INTO units (key, label, aliases, dimension, to_base, is_builtin) VALUES (?, ?, ?, ?, ?, 1)`);
      for (const s of seed) ins.run(s.key, s.label, JSON.stringify(s.aliases), s.dimension, s.toBase);
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('units_registry_seeded_v1', '1')").run();
    }
  } catch (e) { console.error('units registry schema failed:', e); }

  // Phase 1 §3 — emergency / cash purchase channel. Captures unplanned buys that
  // bypassed the PO workflow (Sunday store-out, kitchen emergency, sample, etc.).
  // Reports filter on these to track how much procurement is happening off-process.
  try {
    const cols = db.prepare("PRAGMA table_info(purchases)").all() as any[];
    const has = (n: string) => cols.some((c: any) => c.name === n);
    if (!has('is_emergency'))      db.exec(`ALTER TABLE purchases ADD COLUMN is_emergency INTEGER NOT NULL DEFAULT 0`);
    if (!has('payment_mode'))      db.exec(`ALTER TABLE purchases ADD COLUMN payment_mode TEXT DEFAULT ''`);
    if (!has('emergency_reason'))  db.exec(`ALTER TABLE purchases ADD COLUMN emergency_reason TEXT DEFAULT ''`);
  } catch (e) { console.error('purchases.is_emergency migration failed:', e); }

  // Phase 1 §5: Goods Receipt Note (GRN) — formal record at the receiving bay.
  // Every PO receive auto-creates a GRN. Ad-hoc / cash receipts can create a GRN directly.
  // Rule: stock only enters via the accepted-quantity column on a GRN line item.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS goods_receipt_notes (
        id              TEXT PRIMARY KEY,
        grn_number      TEXT NOT NULL UNIQUE,
        date            TEXT NOT NULL,
        time            TEXT DEFAULT '',
        po_id           TEXT,
        vendor_id       TEXT,
        vendor          TEXT DEFAULT '',
        invoice_number  TEXT DEFAULT '',
        invoice_date    TEXT DEFAULT '',
        received_by     TEXT DEFAULT '',
        qc_by           TEXT DEFAULT '',
        status          TEXT NOT NULL DEFAULT 'received',
        notes           TEXT DEFAULT '',
        outlet_id       TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (po_id)     REFERENCES purchase_orders(id),
        FOREIGN KEY (vendor_id) REFERENCES vendors(id)
      );
      CREATE INDEX IF NOT EXISTS idx_grn_date   ON goods_receipt_notes(date);
      CREATE INDEX IF NOT EXISTS idx_grn_po     ON goods_receipt_notes(po_id);
      CREATE INDEX IF NOT EXISTS idx_grn_vendor ON goods_receipt_notes(vendor_id);
      CREATE TABLE IF NOT EXISTS goods_receipt_note_items (
        id                  TEXT PRIMARY KEY,
        grn_id              TEXT NOT NULL,
        po_item_id          TEXT,
        material_id         TEXT NOT NULL,
        quantity_ordered    REAL NOT NULL DEFAULT 0,
        quantity_received   REAL NOT NULL,
        quantity_accepted   REAL NOT NULL,
        quantity_rejected   REAL NOT NULL DEFAULT 0,
        rejection_reason    TEXT DEFAULT '',
        unit_price          REAL NOT NULL DEFAULT 0,
        notes               TEXT DEFAULT '',
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (grn_id)      REFERENCES goods_receipt_notes(id) ON DELETE CASCADE,
        FOREIGN KEY (material_id) REFERENCES raw_materials(id)
      );
      CREATE INDEX IF NOT EXISTS idx_grni_grn ON goods_receipt_note_items(grn_id);
    `);
    // Back-link from PO → GRN
    const poCols = db.prepare("PRAGMA table_info(purchase_orders)").all() as any[];
    if (!poCols.some((c: any) => c.name === 'grn_id')) {
      db.exec(`ALTER TABLE purchase_orders ADD COLUMN grn_id TEXT`);
    }
    // Phase 1 §4 — receiving QC checklist (boolean ticks captured at receive time)
    const grnCols = db.prepare("PRAGMA table_info(goods_receipt_notes)").all() as any[];
    const hasG = (n: string) => grnCols.some((c: any) => c.name === n);
    if (!hasG('qc_quality'))       db.exec(`ALTER TABLE goods_receipt_notes ADD COLUMN qc_quality INTEGER NOT NULL DEFAULT 0`);
    if (!hasG('qc_temperature'))   db.exec(`ALTER TABLE goods_receipt_notes ADD COLUMN qc_temperature INTEGER NOT NULL DEFAULT 0`);
    if (!hasG('qc_expiry'))        db.exec(`ALTER TABLE goods_receipt_notes ADD COLUMN qc_expiry INTEGER NOT NULL DEFAULT 0`);
    if (!hasG('qc_damage'))        db.exec(`ALTER TABLE goods_receipt_notes ADD COLUMN qc_damage INTEGER NOT NULL DEFAULT 0`);
    if (!hasG('qc_weight'))        db.exec(`ALTER TABLE goods_receipt_notes ADD COLUMN qc_weight INTEGER NOT NULL DEFAULT 0`);
    if (!hasG('qc_invoice_match')) db.exec(`ALTER TABLE goods_receipt_notes ADD COLUMN qc_invoice_match INTEGER NOT NULL DEFAULT 0`);
  } catch (e) { console.error('GRN schema failed:', e); }

  // POS Phase 1 — front-of-house order backbone: tables → order → settle → sale.
  // An order is opened on a table, items are added (priced from menu_items), and
  // settling writes one `sales` row per line + deducts inventory (see recordSale).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS restaurant_tables (
        id            TEXT PRIMARY KEY,
        outlet_id     TEXT,
        table_number  TEXT NOT NULL,
        zone          TEXT DEFAULT '',
        seats         INTEGER NOT NULL DEFAULT 2,
        qr_token      TEXT,
        is_active     INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_rtables_outlet ON restaurant_tables(outlet_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_rtables_qr ON restaurant_tables(qr_token);

      CREATE TABLE IF NOT EXISTS orders (
        id             TEXT PRIMARY KEY,
        outlet_id      TEXT,
        order_number   INTEGER NOT NULL DEFAULT 0,
        table_id       TEXT,
        status         TEXT NOT NULL DEFAULT 'open',      -- open | settled | void
        order_type     TEXT NOT NULL DEFAULT 'dine-in',   -- dine-in | takeaway | delivery
        bill_type      TEXT NOT NULL DEFAULT 'normal',    -- maps to sales.bill_type
        covers         INTEGER NOT NULL DEFAULT 0,
        server_id      TEXT DEFAULT '',
        server_name    TEXT DEFAULT '',
        subtotal       REAL NOT NULL DEFAULT 0,
        tax_total      REAL NOT NULL DEFAULT 0,
        discount       REAL NOT NULL DEFAULT 0,
        total          REAL NOT NULL DEFAULT 0,
        payment_method TEXT DEFAULT '',                   -- cash | upi | card (set on settle)
        settled_at     TEXT DEFAULT NULL,
        voided_at      TEXT DEFAULT NULL,
        notes          TEXT DEFAULT '',
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (table_id) REFERENCES restaurant_tables(id)
      );
      CREATE INDEX IF NOT EXISTS idx_orders_outlet ON orders(outlet_id);
      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
      CREATE INDEX IF NOT EXISTS idx_orders_table  ON orders(table_id);

      CREATE TABLE IF NOT EXISTS order_items (
        id            TEXT PRIMARY KEY,
        order_id      TEXT NOT NULL,
        menu_item_id  TEXT,
        recipe_id     TEXT,                               -- snapshot for costing/deduction
        name          TEXT NOT NULL,                      -- snapshot
        station       TEXT DEFAULT '',                    -- snapshot (Phase 2 KOT routing)
        quantity      REAL NOT NULL DEFAULT 1,
        unit_price    REAL NOT NULL DEFAULT 0,            -- snapshot of menu price
        tax_value     REAL NOT NULL DEFAULT 0,            -- snapshot tax % at add time
        line_total    REAL NOT NULL DEFAULT 0,
        status        TEXT NOT NULL DEFAULT 'pending',    -- Phase 2: new|preparing|ready|served
        notes         TEXT DEFAULT '',
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

      -- POS Phase 2 — Kitchen Order Tickets. Firing an order groups its pending
      -- items by station into one KOT per station; the KDS bumps the whole ticket
      -- through new → preparing → ready → served.
      CREATE TABLE IF NOT EXISTS kots (
        id           TEXT PRIMARY KEY,
        outlet_id    TEXT,
        order_id     TEXT NOT NULL,
        kot_number   INTEGER NOT NULL DEFAULT 0,
        station      TEXT NOT NULL DEFAULT 'kitchen',
        status       TEXT NOT NULL DEFAULT 'new',   -- new | preparing | ready | served
        notes        TEXT DEFAULT '',
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_kots_order   ON kots(order_id);
      CREATE INDEX IF NOT EXISTS idx_kots_station ON kots(station);
      CREATE INDEX IF NOT EXISTS idx_kots_status  ON kots(status);
    `);
    // order_items gains a kot_id once it is fired to the kitchen (Phase 2).
    const oiCols = db.prepare("PRAGMA table_info(order_items)").all() as any[];
    if (!oiCols.some((c: any) => c.name === 'kot_id')) {
      db.exec(`ALTER TABLE order_items ADD COLUMN kot_id TEXT`);
    }
    // KOT print metadata: who fired it (the punching captain) + how many times
    // it's been printed (0 = original; each reprint increments → DUPLICATE N).
    const kCols = db.prepare("PRAGMA table_info(kots)").all() as any[];
    if (!kCols.some((c: any) => c.name === 'fired_by'))      db.exec(`ALTER TABLE kots ADD COLUMN fired_by TEXT DEFAULT ''`);
    if (!kCols.some((c: any) => c.name === 'reprint_count')) db.exec(`ALTER TABLE kots ADD COLUMN reprint_count INTEGER NOT NULL DEFAULT 0`);
    // Guest capture (a table is opened with the guest's details).
    const orCols = db.prepare("PRAGMA table_info(orders)").all() as any[];
    const hasOrd = (n: string) => orCols.some((c: any) => c.name === n);
    if (!hasOrd('guest_name'))            db.exec(`ALTER TABLE orders ADD COLUMN guest_name TEXT DEFAULT ''`);
    if (!hasOrd('guest_mobile'))          db.exec(`ALTER TABLE orders ADD COLUMN guest_mobile TEXT DEFAULT ''`);
    // Offline LAN KOT replay: client_ref is the idempotency key sent by the
    // counter's offline mini-POS; origin marks where the order came from
    // ('cloud' for normal online orders, 'offline' for replayed ones).
    if (!hasOrd('client_ref'))            db.exec(`ALTER TABLE orders ADD COLUMN client_ref TEXT`);
    if (!hasOrd('origin'))                db.exec(`ALTER TABLE orders ADD COLUMN origin TEXT DEFAULT 'cloud'`);
    // DB-level idempotency guard for offline replay: at most one order per
    // client_ref. Partial index so the many NULL client_refs (all online orders)
    // are exempt. The replay route catches the constraint as "already existed".
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_client_ref ON orders(client_ref) WHERE client_ref IS NOT NULL`);
    // Bill: service charge amount + why a cashier removed it; discount % + approver.
    if (!hasOrd('service_charge'))        db.exec(`ALTER TABLE orders ADD COLUMN service_charge REAL NOT NULL DEFAULT 0`);
    if (!hasOrd('service_charge_reason')) db.exec(`ALTER TABLE orders ADD COLUMN service_charge_reason TEXT DEFAULT ''`);
    if (!hasOrd('discount_pct'))          db.exec(`ALTER TABLE orders ADD COLUMN discount_pct REAL NOT NULL DEFAULT 0`);
    if (!hasOrd('discount_approved_by'))  db.exec(`ALTER TABLE orders ADD COLUMN discount_approved_by TEXT DEFAULT ''`);
    // Per-item prep timer + completion: prep_minutes snapshot from the menu item,
    // fired_at when it went to the kitchen (timer start), completed_at when the
    // captain marks it received. Bill is gated until every fired item completes.
    if (!oiCols.some((c: any) => c.name === 'prep_minutes')) db.exec(`ALTER TABLE order_items ADD COLUMN prep_minutes INTEGER NOT NULL DEFAULT 0`);
    if (!oiCols.some((c: any) => c.name === 'fired_at'))     db.exec(`ALTER TABLE order_items ADD COLUMN fired_at TEXT`);
    if (!oiCols.some((c: any) => c.name === 'completed_at')) db.exec(`ALTER TABLE order_items ADD COLUMN completed_at TEXT`);
    // KOT escalation: a captain flags a KOT that would not print, so the Manager
    // (in-app) and the Kitchen Display both see "not printed — action needed".
    db.exec(`
      CREATE TABLE IF NOT EXISTS kot_alerts (
        id          TEXT PRIMARY KEY,
        kot_id      TEXT,
        order_id    TEXT,
        outlet_id   TEXT,
        kot_number  INTEGER,
        station     TEXT DEFAULT '',
        table_number TEXT DEFAULT '',
        reason      TEXT DEFAULT '',
        created_by  TEXT DEFAULT '',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_kot_alerts_open ON kot_alerts(resolved_at);
    `);
    // kot_alerts: `kind` categorises the issue (manual|fire_failed|print_failed|
    // unprinted); `server_id` snapshots the table's owning captain so an alert
    // can route to "the respective captain" (see src/lib/kot-alerts.ts).
    try {
      const kaCols = db.prepare("PRAGMA table_info(kot_alerts)").all() as any[];
      const kaHas = (c: string) => kaCols.some((x: any) => x.name === c);
      if (!kaHas('kind'))      db.exec("ALTER TABLE kot_alerts ADD COLUMN kind TEXT DEFAULT 'manual'");
      if (!kaHas('server_id')) db.exec("ALTER TABLE kot_alerts ADD COLUMN server_id TEXT DEFAULT ''");
    } catch (e) { console.error('kot_alerts column migration failed:', e); }

    // restaurant_tables.qr_printed_at — when this table's QR standee was last
    // printed/downloaded (NULL = never), so the QR Standees page can show which
    // are done vs still pending. See /api/tables/qr + /api/tables/qr/pdf.
    try {
      const rtCols = db.prepare("PRAGMA table_info(restaurant_tables)").all() as any[];
      if (!rtCols.some((x: any) => x.name === 'qr_printed_at')) {
        db.exec("ALTER TABLE restaurant_tables ADD COLUMN qr_printed_at TEXT");
      }
    } catch (e) { console.error('restaurant_tables qr_printed_at migration failed:', e); }

    // order_items.recipe_deducted_at — set when the item's recipe was deducted
    // from stock (on KOT "served"/complete). NULL = not yet consumed. The settle
    // path skips inventory for already-stamped items so stock never double-drops.
    try {
      const oiCols = db.prepare("PRAGMA table_info(order_items)").all() as any[];
      if (!oiCols.some((x: any) => x.name === 'recipe_deducted_at')) {
        db.exec("ALTER TABLE order_items ADD COLUMN recipe_deducted_at TEXT");
      }
    } catch (e) { console.error('order_items recipe_deducted_at migration failed:', e); }

    // Customer QR menu — table-side service requests (bell). A guest at a table
    // taps "Call waiter / Refill water / Extra cutlery / Request bill" and the
    // request lands here for the Captain/Waiter dashboard to accept → complete.
    db.exec(`
      CREATE TABLE IF NOT EXISTS service_requests (
        id           TEXT PRIMARY KEY,
        outlet_id    TEXT,
        table_id     TEXT,
        table_number TEXT DEFAULT '',
        type         TEXT NOT NULL,                       -- waiter | water | cutlery | bill
        status       TEXT NOT NULL DEFAULT 'pending',     -- pending | accepted | completed
        note         TEXT DEFAULT '',
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        accepted_at  TEXT,
        accepted_by  TEXT DEFAULT '',
        completed_at TEXT,
        completed_by TEXT DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_service_requests_status ON service_requests(status);
      CREATE INDEX IF NOT EXISTS idx_service_requests_table  ON service_requests(table_id);
    `);

    // Customer QR menu — every table needs a stable, hard-to-guess qr_token that
    // the printed standee encodes (…/menu?t=<token>). Backfill any table that has
    // none. Idempotent: only touches rows still missing a token. NULLs are exempt
    // from idx_rtables_qr (SQLite treats NULLs as distinct), so no collisions.
    const needToken = db.prepare("SELECT id FROM restaurant_tables WHERE qr_token IS NULL OR qr_token = ''").all() as any[];
    if (needToken.length) {
      const setTok = db.prepare("UPDATE restaurant_tables SET qr_token = ?, updated_at = datetime('now') WHERE id = ?");
      for (const t of needToken) setTok.run(newQrToken(), t.id);
    }
  } catch (e) { console.error('POS orders schema failed:', e); }

  // Phase 1 §6: wastages — items thrown away (spoilage / expiry / damage / overcooked / spillage).
  // Writes to inventory_transactions(type='wastage') so it shows up in consumption math.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS wastages (
        id          TEXT PRIMARY KEY,
        date        TEXT NOT NULL,
        material_id TEXT NOT NULL,
        quantity    REAL NOT NULL,
        reason      TEXT NOT NULL DEFAULT 'spoilage',
        recipe_id   TEXT,
        recorded_by TEXT DEFAULT '',
        notes       TEXT DEFAULT '',
        outlet_id   TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (material_id) REFERENCES raw_materials(id),
        FOREIGN KEY (recipe_id)   REFERENCES recipes(id)
      );
      CREATE INDEX IF NOT EXISTS idx_wastages_date     ON wastages(date);
      CREATE INDEX IF NOT EXISTS idx_wastages_material ON wastages(material_id);
    `);
  } catch (e) { console.error('wastages schema failed:', e); }

  // Append-only audit log. No UPDATE, no DELETE — only INSERT.
  // We don't enforce immutability at the SQL level (SQLite triggers could,
  // but it complicates testing); instead `logAuditEvent` is the only insert path
  // and the /audit page is read-only.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id           TEXT PRIMARY KEY,
        event_type   TEXT NOT NULL,
        entity_type  TEXT NOT NULL,
        entity_id    TEXT NOT NULL,
        actor_email  TEXT NOT NULL DEFAULT '',
        outlet_id    TEXT,
        before_json  TEXT,
        after_json   TEXT,
        note         TEXT DEFAULT '',
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_audit_created   ON audit_events(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_entity    ON audit_events(entity_type, entity_id);
      CREATE INDEX IF NOT EXISTS idx_audit_actor     ON audit_events(actor_email);
    `);
  } catch (e) { console.error('audit_events schema failed:', e); }

  // Offline KOT + Bill printing (ADDITIVE — touches no existing table/data).
  // print_stations maps a logical role (a customer "bill" printer, or a kitchen
  // "kot" station) to a physical printer the local print bridge can reach over
  // IP (raw TCP :9100) or USB (OS raw spool). print_jobs is an audit journal of
  // print attempts so failures are visible during/after an outage.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS print_stations (
        id          TEXT PRIMARY KEY,
        outlet_id   TEXT,
        name        TEXT NOT NULL,
        role        TEXT NOT NULL DEFAULT 'kot',    -- 'bill' | 'kot'
        station     TEXT DEFAULT '',                 -- kitchen station label this maps to (kot)
        transport   TEXT NOT NULL DEFAULT 'ip',      -- 'ip' | 'usb'
        target      TEXT NOT NULL DEFAULT '',        -- "ip:port" (ip) or OS printer/share name (usb)
        paper_width INTEGER NOT NULL DEFAULT 48,     -- 48 = 80mm, 32 = 58mm
        copies      INTEGER NOT NULL DEFAULT 1,
        floor       TEXT DEFAULT '',                  -- floor/zone label (multi-floor venues)
        backup_target TEXT DEFAULT '',                -- failover printer "ip:port" if primary is down
        kind        TEXT DEFAULT 'food',              -- KOT group: 'food' (kitchen) | 'bar'
        is_master   INTEGER NOT NULL DEFAULT 0,       -- 1 = expediter: gets a consolidated copy of all KOTs of its kind
        mirror_to_master INTEGER NOT NULL DEFAULT 1,  -- 1 = this station's KOTs are duplicated to the Main (master) printer
        is_active   INTEGER NOT NULL DEFAULT 1,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_print_stations_role ON print_stations(role);

      CREATE TABLE IF NOT EXISTS print_jobs (
        id          TEXT PRIMARY KEY,
        outlet_id   TEXT,
        station_id  TEXT,
        doc_type    TEXT NOT NULL DEFAULT 'kot',     -- 'kot' | 'bill'
        source      TEXT NOT NULL DEFAULT 'test',    -- 'test' | 'fire' | 'bill' | 'reprint'
        ref_id      TEXT,                             -- order_id / kot_id / etc.
        status      TEXT NOT NULL DEFAULT 'queued',  -- 'queued' | 'printed' | 'failed'
        attempts    INTEGER NOT NULL DEFAULT 0,
        last_error  TEXT DEFAULT '',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        printed_at  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_print_jobs_created ON print_jobs(created_at DESC);
    `);
    // Add fleet columns to print_stations if an older deployment created it first.
    const psCols = db.prepare("PRAGMA table_info(print_stations)").all() as any[];
    if (!psCols.some((c: any) => c.name === 'floor'))         db.exec(`ALTER TABLE print_stations ADD COLUMN floor TEXT DEFAULT ''`);
    if (!psCols.some((c: any) => c.name === 'backup_target')) db.exec(`ALTER TABLE print_stations ADD COLUMN backup_target TEXT DEFAULT ''`);
    if (!psCols.some((c: any) => c.name === 'kind'))          db.exec(`ALTER TABLE print_stations ADD COLUMN kind TEXT DEFAULT 'food'`);
    if (!psCols.some((c: any) => c.name === 'is_master'))     db.exec(`ALTER TABLE print_stations ADD COLUMN is_master INTEGER NOT NULL DEFAULT 0`);
    if (!psCols.some((c: any) => c.name === 'mirror_to_master')) db.exec(`ALTER TABLE print_stations ADD COLUMN mirror_to_master INTEGER NOT NULL DEFAULT 1`);
  } catch (e) { console.error('print_stations/print_jobs schema failed:', e); }

  // Phase 1 §2: add Mgmt approval columns to requisitions (idempotent)
  try {
    const cols = db.prepare("PRAGMA table_info(requisitions)").all() as any[];
    const has = (n: string) => cols.some((c: any) => c.name === n);
    if (!has('mgmt_approved_at')) db.exec(`ALTER TABLE requisitions ADD COLUMN mgmt_approved_at TEXT`);
    if (!has('mgmt_approved_by')) db.exec(`ALTER TABLE requisitions ADD COLUMN mgmt_approved_by TEXT DEFAULT ''`);
    if (!has('mgmt_note'))        db.exec(`ALTER TABLE requisitions ADD COLUMN mgmt_note TEXT DEFAULT ''`);
    // Phase 1 §2 — final dept-side acknowledgment after items physically arrive
    if (!has('dept_acknowledged_at')) db.exec(`ALTER TABLE requisitions ADD COLUMN dept_acknowledged_at TEXT`);
    if (!has('dept_acknowledged_by')) db.exec(`ALTER TABLE requisitions ADD COLUMN dept_acknowledged_by TEXT DEFAULT ''`);
    if (!has('dept_ack_note'))        db.exec(`ALTER TABLE requisitions ADD COLUMN dept_ack_note TEXT DEFAULT ''`);

    // Party event fields — mark a requisition as belonging to a banquet event.
    // Cost of issued items × material avg_price = the event's food cost.
    // 'purpose' default 'internal' keeps existing requisitions unchanged.
    if (!has('purpose'))     db.exec(`ALTER TABLE requisitions ADD COLUMN purpose TEXT NOT NULL DEFAULT 'internal'`);
    if (!has('event_name'))  db.exec(`ALTER TABLE requisitions ADD COLUMN event_name TEXT DEFAULT ''`);
    if (!has('event_date'))  db.exec(`ALTER TABLE requisitions ADD COLUMN event_date TEXT`);
    if (!has('guest_count')) db.exec(`ALTER TABLE requisitions ADD COLUMN guest_count INTEGER`);
    if (!has('customer'))    db.exec(`ALTER TABLE requisitions ADD COLUMN customer TEXT DEFAULT ''`);
    if (!has('event_notes')) db.exec(`ALTER TABLE requisitions ADD COLUMN event_notes TEXT DEFAULT ''`);

    // Sheet-origin keys — let the requisitions page join back to the live
    // upcoming-parties cache to show fresh Customer Name (Column P) data,
    // even for reqs raised before contact_person became the primary field.
    if (!has('fp_id'))           db.exec(`ALTER TABLE requisitions ADD COLUMN fp_id TEXT DEFAULT ''`);
    if (!has('party_unique_id')) db.exec(`ALTER TABLE requisitions ADD COLUMN party_unique_id TEXT DEFAULT ''`);
  } catch (e) { console.error('requisitions.mgmt_approved migration failed:', e); }

  // Flag raw_materials that were auto-created from imports (e.g. Recaho transfer report)
  // so admins can review them — these often need price/unit corrections before going live.
  // Also splits the single `unit` field into two semantic units:
  //   purchase_unit — how the vendor invoices (e.g. BTL, CASE, KG)
  //   unit          — recipe / stock unit (canonical for recipes, e.g. ml, g, pcs)
  // We keep `unit` as the recipe unit so the existing recipe-deduction code keeps working;
  // `purchase_unit` is purely descriptive metadata for procurement / audit clarity.
  try {
    const cols = db.prepare("PRAGMA table_info(raw_materials)").all() as any[];
    const has = (n: string) => cols.some((c: any) => c.name === n);
    if (!has('is_auto_discovered')) db.exec(`ALTER TABLE raw_materials ADD COLUMN is_auto_discovered INTEGER NOT NULL DEFAULT 0`);
    if (!has('discovered_source'))  db.exec(`ALTER TABLE raw_materials ADD COLUMN discovered_source TEXT DEFAULT ''`);
    if (!has('purchase_unit')) {
      db.exec(`ALTER TABLE raw_materials ADD COLUMN purchase_unit TEXT DEFAULT ''`);
      // Backfill: copy the existing unit so historical rows keep working immediately.
      db.exec(`UPDATE raw_materials SET purchase_unit = unit WHERE purchase_unit = '' OR purchase_unit IS NULL`);
    }
    // ============================================================
    // Phase 1 — Master Inventory Mapping (per Inventory Mgmt SOP)
    //   super_category    e.g. "Meat" (groups Chicken/Mutton/Seafood); analytics + tax rules
    //   brand             explicit on master (today only on purchases.brand)
    //   yield_percent     default 100; auto-defaults to 98 for meat-family categories
    //   tax_percent       GST applicable to this material (5/12/18/28/0)
    //   cess_percent      additional cess (e.g. liquor cess varies by state)
    //   standard_purchase_rate    "expected" rate; PO entries above this need mgmt approval
    //   closing_cadence   'daily' | 'weekly' | 'monthly' | 'none' — drives daily-tracking widget
    //   is_recipe_item    used in any recipe? (cached for fast filter)
    //   is_direct_sell    sold direct via menu_items.material_id (e.g. bottled beer)
    //   is_semifinished   produced in-house, used as ingredient (overlaps with sub_recipes)
    // ============================================================
    if (!has('super_category'))         db.exec(`ALTER TABLE raw_materials ADD COLUMN super_category TEXT DEFAULT ''`);
    if (!has('brand'))                  db.exec(`ALTER TABLE raw_materials ADD COLUMN brand TEXT DEFAULT ''`);
    if (!has('yield_percent'))          db.exec(`ALTER TABLE raw_materials ADD COLUMN yield_percent REAL NOT NULL DEFAULT 100`);
    if (!has('tax_percent'))            db.exec(`ALTER TABLE raw_materials ADD COLUMN tax_percent REAL NOT NULL DEFAULT 0`);
    if (!has('cess_percent'))           db.exec(`ALTER TABLE raw_materials ADD COLUMN cess_percent REAL NOT NULL DEFAULT 0`);
    if (!has('standard_purchase_rate')) db.exec(`ALTER TABLE raw_materials ADD COLUMN standard_purchase_rate REAL NOT NULL DEFAULT 0`);
    if (!has('closing_cadence'))        db.exec(`ALTER TABLE raw_materials ADD COLUMN closing_cadence TEXT NOT NULL DEFAULT 'none'`);
    if (!has('is_recipe_item'))         db.exec(`ALTER TABLE raw_materials ADD COLUMN is_recipe_item INTEGER NOT NULL DEFAULT 0`);
    if (!has('is_direct_sell'))         db.exec(`ALTER TABLE raw_materials ADD COLUMN is_direct_sell INTEGER NOT NULL DEFAULT 0`);
    if (!has('is_semifinished'))        db.exec(`ALTER TABLE raw_materials ADD COLUMN is_semifinished INTEGER NOT NULL DEFAULT 0`);
    // Operational fields — where it lives + how long it lasts
    if (!has('storage_location'))       db.exec(`ALTER TABLE raw_materials ADD COLUMN storage_location TEXT DEFAULT ''`);
    if (!has('shelf_life_days'))        db.exec(`ALTER TABLE raw_materials ADD COLUMN shelf_life_days INTEGER NOT NULL DEFAULT 0`);
    // Soft-delete flag for round-trip CSV re-upload: "deactivate missing" sets
    // is_active=0 instead of hard-deleting (FK references from purchases/recipes/
    // requisitions would otherwise cascade-break). DEFAULT 1 → every existing
    // material stays active. Without this column the re-upload route throws
    // "no such column: is_active" (long-standing gap — the route always assumed it).
    if (!has('is_active'))              db.exec(`ALTER TABLE raw_materials ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1`);
    // One-shot backfills — only run once, idempotent via the settings flag.
    const phase1Backfilled = db.prepare("SELECT value FROM settings WHERE key='phase1_master_backfill_v1'").get() as any;
    if (!phase1Backfilled) {
      // Default standard rate = current last_purchase_price (best signal we have).
      db.exec(`UPDATE raw_materials SET standard_purchase_rate = last_purchase_price WHERE standard_purchase_rate = 0 AND last_purchase_price > 0`);
      // is_recipe_item = referenced by any recipe / sub-recipe ingredient
      db.exec(`UPDATE raw_materials SET is_recipe_item = 1 WHERE id IN (SELECT DISTINCT material_id FROM recipe_ingredients UNION SELECT DISTINCT material_id FROM sub_recipe_ingredients)`);
      // is_direct_sell = referenced by any menu_items.material_id
      db.exec(`UPDATE raw_materials SET is_direct_sell = 1 WHERE id IN (SELECT DISTINCT material_id FROM menu_items WHERE material_id IS NOT NULL)`);
      // Default super_category from category. Map known meat-family categories first.
      db.exec(`
        UPDATE raw_materials SET super_category = CASE
          WHEN LOWER(category) IN ('chicken','mutton','lamb','beef','pork','meat')                   THEN 'Meat'
          WHEN LOWER(category) IN ('fish','prawn','seafood','crab','lobster','oyster')               THEN 'Seafood'
          WHEN LOWER(category) IN ('dairy','dairy-products','milk','curd','yogurt','cheese','butter','cream') THEN 'Dairy'
          WHEN LOWER(category) IN ('vegetable','vegetables','english-vegetables','exotic-vegetables') THEN 'Vegetables'
          WHEN LOWER(category) IN ('fruit','fruits','exotic-fruits','berry')                          THEN 'Fruits'
          WHEN LOWER(category) IN ('beer','whisky','scotch','vodka','gin','rum','tequila','wine','white-wine','wines-rose','blended-scotch','blended-malt','liqueur','bitters','vermouth','brandy','champagne') THEN 'Liquor'
          WHEN LOWER(category) IN ('juice','soda','mixer','water','soft-beverages','beverage','beverages','syrup','syrups','crush') THEN 'Beverages'
          WHEN LOWER(category) IN ('grocery','spice','spices','powder','masala','flour','rice','sugar','salt','dal','grain','pulse') THEN 'Grocery'
          WHEN LOWER(category) IN ('housekeeping','cleaning')                                         THEN 'Housekeeping'
          WHEN LOWER(category) IN ('stationery','paper')                                              THEN 'Stationery'
          WHEN LOWER(category) IN ('gas','charcoal','fuel','wood','gas-charcoal')                     THEN 'Fuel'
          ELSE COALESCE(NULLIF(super_category, ''), '')
        END
      `);
      // Yield% default for meat/seafood is 98% per spec
      db.exec(`UPDATE raw_materials SET yield_percent = 98 WHERE yield_percent = 100 AND LOWER(super_category) IN ('meat','seafood')`);
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('phase1_master_backfill_v1', '1')").run();
    }
    // Helpful index for the new "daily tracking" widget
    db.exec(`CREATE INDEX IF NOT EXISTS idx_rm_closing_cadence ON raw_materials(closing_cadence)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_rm_super_category  ON raw_materials(super_category)`);
    // pack_size = how many recipe-units fit in one purchase-unit.
    //   Example: 100 PIPERS BTL of 750ML, recipe_unit=ml → pack_size = 750
    //            Salted Butter 500GM PKT, recipe_unit=g  → pack_size = 500
    //            BUDWEISER (330ML),       recipe_unit=pcs → pack_size = 1  (1 BTL = 1 pcs)
    //            Tomatoes bought in kg,   recipe_unit=kg → pack_size = 1
    // Only ml/L recipe units benefit from a numeric pack_size derived from the name.
    // case_size — number of purchase-units (bottles/cans/packs) bundled in one outer pack.
    // Default 1 = no outer wrapping (vendor sells loose bottles or one-off cans).
    // Example: 100 Pipers → pack_size=750 (ml per BTL), case_size=12 (BTL per CASE).
    // Stock math: (cases × case_size × pack_size) = ml added to current_stock.
    if (!has('case_size')) db.exec(`ALTER TABLE raw_materials ADD COLUMN case_size REAL NOT NULL DEFAULT 1`);
    if (!has('pack_size')) {
      db.exec(`ALTER TABLE raw_materials ADD COLUMN pack_size REAL NOT NULL DEFAULT 1`);
      // Best-effort backfill from "(NML)" in name — only when recipe unit is ml/L
      // (otherwise pack_size would carry a meaningless number like 330 for a pcs item).
      db.exec(`
        UPDATE raw_materials
        SET pack_size = CAST(
          REPLACE(REPLACE(REPLACE(REPLACE(SUBSTR(UPPER(name),
            INSTR(UPPER(name), '(')+1,
            INSTR(UPPER(name), ')') - INSTR(UPPER(name), '(') - 1),
            'ML', ''), ' ', ''), '(', ''), ')', '')
          AS REAL)
        WHERE pack_size = 1
          AND UPPER(name) GLOB '*([0-9]*ML)*'
          AND LOWER(unit) IN ('ml', 'l')
      `);
    }
    // One-shot cleanup for installs where pack_size was already populated incorrectly
    // (we earlier wrote pack_size for any (NML) name regardless of unit).
    const flag = db.prepare("SELECT value FROM settings WHERE key='migration_pack_size_reset_for_non_ml_v1'").get() as any;
    if (!flag) {
      db.exec(`UPDATE raw_materials SET pack_size = 1 WHERE LOWER(unit) NOT IN ('ml', 'l') AND pack_size > 1`);
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('migration_pack_size_reset_for_non_ml_v1', '1')").run();
    }
  } catch (e) { console.error('raw_materials.purchase_unit migration failed:', e); }

  // Kitchen Production / Batch tracking: prepared items get a batch + barcode at
  // production time, are drawn down FIFO on consumption, and every state change is
  // recorded in an append-only audit trail.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS production_batches (
        id                 TEXT PRIMARY KEY,
        outlet_id          TEXT,
        batch_number       TEXT,
        barcode            TEXT UNIQUE,
        item_name          TEXT NOT NULL,
        category           TEXT DEFAULT '',
        material_id        TEXT,
        recipe_id          TEXT,
        production_date    TEXT,
        production_time    TEXT,
        expiry_date        TEXT,
        expiry_time        TEXT,
        shelf_life         TEXT DEFAULT '',
        quantity_produced  REAL NOT NULL DEFAULT 0,
        quantity_consumed  REAL NOT NULL DEFAULT 0,
        unit               TEXT DEFAULT '',
        prepared_by        TEXT DEFAULT '',
        kitchen_section    TEXT DEFAULT '',
        storage_location   TEXT DEFAULT '',
        remarks            TEXT DEFAULT '',
        status             TEXT NOT NULL DEFAULT 'active',   -- active | consumed | expired | disposed
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_production_batches_item   ON production_batches(item_name);
      CREATE INDEX IF NOT EXISTS idx_production_batches_barcode ON production_batches(barcode);
      CREATE INDEX IF NOT EXISTS idx_production_batches_status ON production_batches(status);
      CREATE INDEX IF NOT EXISTS idx_production_batches_expiry ON production_batches(expiry_date);

      CREATE TABLE IF NOT EXISTS batch_transactions (
        id                TEXT PRIMARY KEY,
        batch_id          TEXT NOT NULL,
        outlet_id         TEXT,
        type              TEXT NOT NULL,   -- created | printed | reprinted | scanned | consumed | transferred | returned | wasted | expired | disposed
        quantity          REAL DEFAULT 0,
        balance_quantity  REAL DEFAULT 0,
        user              TEXT DEFAULT '',
        department        TEXT DEFAULT '',
        remarks           TEXT DEFAULT '',
        created_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_batch_transactions_batch ON batch_transactions(batch_id);
    `);
  } catch (e) { console.error('production_batches/batch_transactions schema failed:', e); }

  // Production Items master — the FIXED list of prepared items a batch can be
  // recorded against. Batch creation selects from this list (no free-typed
  // names), and FIFO groups by production_item_id so a rename (or a legacy
  // typo) can never split an item's FIFO chain.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS production_items (
        id                       TEXT PRIMARY KEY,
        outlet_id                TEXT,
        name                     TEXT NOT NULL UNIQUE COLLATE NOCASE,
        category                 TEXT DEFAULT '',
        unit                     TEXT DEFAULT '',
        shelf_life_hours         REAL DEFAULT 0,
        default_storage_location TEXT DEFAULT '',
        is_active                INTEGER NOT NULL DEFAULT 1,
        created_at               TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const bCols = db.prepare('PRAGMA table_info(production_batches)').all() as { name: string }[];
    if (!bCols.some((c) => c.name === 'production_item_id')) {
      db.exec(`ALTER TABLE production_batches ADD COLUMN production_item_id TEXT`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_production_batches_pitem ON production_batches(production_item_id)`);
    // Backfill (idempotent, re-runs every boot): every distinct batch item name
    // becomes a master item (INSERT OR IGNORE on the NOCASE-unique name), and any
    // batch without a production_item_id links to its item by name. New batches
    // always carry the id, so this only ever touches legacy rows.
    db.exec(`
      INSERT OR IGNORE INTO production_items (id, name, category, unit)
        SELECT lower(hex(randomblob(16))), TRIM(item_name), MAX(COALESCE(category,'')), MAX(COALESCE(unit,''))
        FROM production_batches
        WHERE production_item_id IS NULL
          AND TRIM(COALESCE(item_name,'')) != ''
        GROUP BY TRIM(item_name) COLLATE NOCASE;
      UPDATE production_batches
         SET production_item_id = (
           SELECT pi.id FROM production_items pi
            WHERE pi.name = TRIM(production_batches.item_name) COLLATE NOCASE
         )
       WHERE production_item_id IS NULL
         AND TRIM(COALESCE(item_name,'')) != '';
    `);
  } catch (e) { console.error('production_items schema failed:', e); }
}

// ---- UTILITY FUNCTIONS ----

/**
 * Parse the per-piece volume in ml from a material name.
 * "JAMESON IRISH (750ML)" → 750.   "ABSOLUT 700 ml" → 700.   "VODKA 1 LTR" → 1000.
 * Returns null if no volume can be parsed.
 */
export function parseMaterialVolumeMl(name: string | null | undefined): number | null {
  if (!name) return null;
  const s = String(name).toUpperCase();
  const mMl = s.match(/(\d+(?:\.\d+)?)\s*ML\b/);
  if (mMl) return parseFloat(mMl[1]);
  const mLtr = s.match(/(\d+(?:\.\d+)?)\s*(?:LTR|LITRE|LITER|L)\b/);
  if (mLtr) return parseFloat(mLtr[1]) * 1000;
  return null;
}

/**
 * Convert a recipe ingredient quantity from its declared unit into the raw material's
 * stock unit, so cost = qty × material.average_price stays correct.
 *
 * Handles:
 *   recipe pcs ↔ material ml/l   (uses pack volume parsed from material name)
 *   recipe ml ↔ material l
 *   recipe l ↔ material ml
 *   recipe g ↔ material kg
 *   recipe kg ↔ material g
 *   same unit → no change
 *
 * Falls back to passing the qty through if the conversion can't be inferred.
 */
export function convertToMaterialUnit(
  qty: number,
  recipeUnit: string | null | undefined,
  materialUnit: string,
  materialName?: string,
  /** Optional explicit pack size (recipe-units per purchase-unit). If > 1 it
   *  takes precedence over the name-regex extraction in parseMaterialVolumeMl. */
  packSize?: number | null,
): number {
  const r = (recipeUnit || materialUnit || '').toLowerCase().trim();
  const m = (materialUnit || '').toLowerCase().trim();
  if (!r || r === m) return qty;
  // Delegate to the central units library which knows about all volume/weight/count
  // dimensions and bridges across them via pack_size. Unknown unit pairs return null
  // → we fall back to the original qty so callers don't crash.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { convert } = require('./units') as typeof import('./units');
  const result = convert(qty, r, m, {
    recipe_unit: m,
    pack_size: packSize ?? undefined,
    name: materialName,
  });
  return result == null ? qty : result;
}


export function generateId(): string {
  return crypto.randomUUID();
}

/**
 * A compact, URL-safe token for a table's QR standee (…/menu?t=<token>).
 * 12 chars of base32-ish alphabet ≈ 60 bits — unguessable enough for a dine-in
 * menu (the Captain-approval step is the real gate), short enough to keep the
 * printed QR low-density and crisp.
 */
export function newQrToken(): string {
  const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // no l/o/0/1 ambiguity
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += ALPHABET[b & 31];
  return s;
}

/**
 * Log an append-only audit event. Captures who did what to which entity,
 * with optional before/after snapshots for diff'ing.
 * Never throws — audit failure should not break the parent operation.
 */
export function logAuditEvent(
  db: Database.Database,
  params: {
    event_type: string;        // e.g. 'po.approve', 'recipe.edit', 'reset.run', 'purchase.delete'
    entity_type: string;       // 'purchase_order', 'recipe', 'raw_material', 'requisition', ...
    entity_id: string;
    actor_email?: string;
    outlet_id?: string | null;
    before?: any;
    after?: any;
    note?: string;
  }
): void {
  try {
    db.prepare(`
      INSERT INTO audit_events
        (id, event_type, entity_type, entity_id, actor_email, outlet_id, before_json, after_json, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      crypto.randomUUID(),
      params.event_type,
      params.entity_type,
      params.entity_id,
      params.actor_email || '',
      params.outlet_id || null,
      params.before != null ? JSON.stringify(params.before) : null,
      params.after != null ? JSON.stringify(params.after) : null,
      params.note || '',
    );
  } catch (e: any) {
    console.error('[audit] failed to log event:', e?.message, params.event_type);
  }
}

// Calculate effective quantity after yield and wastage
export function effectiveQuantity(quantity: number, yieldPercent: number, wastagePercent: number): number {
  const usable = quantity * (yieldPercent / 100);
  const afterWaste = quantity * (1 + wastagePercent / 100);
  return afterWaste / (yieldPercent / 100);
}

// Recalculate recipe cost
export function recalculateRecipeCost(db: Database.Database, recipeId: string): void {
  const recipe = db.prepare('SELECT * FROM recipes WHERE id = ?').get(recipeId) as any;
  if (!recipe) return;

  // Cost from raw ingredients
  const ingredients = db.prepare(`
    SELECT ri.*, rm.average_price, rm.unit AS material_unit, rm.name AS material_name, rm.pack_size AS material_pack_size
    FROM recipe_ingredients ri
    JOIN raw_materials rm ON ri.material_id = rm.id
    WHERE ri.recipe_id = ? AND ri.is_default = 1
  `).all(recipeId) as any[];

  let totalCost = 0;
  for (const ing of ingredients) {
    // Convert recipe-declared qty into material-stock-unit qty so cost math is correct
    const qtyInMatUnit = convertToMaterialUnit(ing.quantity, ing.unit, ing.material_unit, ing.material_name, ing.material_pack_size);
    const effectiveQty = qtyInMatUnit * (1 + ing.wastage_percent / 100) / (ing.yield_percent / 100);
    totalCost += effectiveQty * ing.average_price;
  }

  // Cost from sub-recipes
  const subRecipes = db.prepare(`
    SELECT rs.*, sr.cost_per_unit
    FROM recipe_sub_recipes rs
    JOIN sub_recipes sr ON rs.sub_recipe_id = sr.id
    WHERE rs.recipe_id = ?
  `).all(recipeId) as any[];

  for (const sr of subRecipes) {
    totalCost += sr.quantity * sr.cost_per_unit;
  }

  const profit = recipe.selling_price - totalCost;
  const foodCostPercent = recipe.selling_price > 0 ? (totalCost / recipe.selling_price) * 100 : 0;

  db.prepare(`
    UPDATE recipes SET total_cost = ?, profit = ?, food_cost_percent = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(Math.round(totalCost * 100) / 100, Math.round(profit * 100) / 100, Math.round(foodCostPercent * 100) / 100, recipeId);
}

// Recalculate sub-recipe cost
export function recalculateSubRecipeCost(db: Database.Database, subRecipeId: string): void {
  const subRecipe = db.prepare('SELECT * FROM sub_recipes WHERE id = ?').get(subRecipeId) as any;
  if (!subRecipe) return;

  const ingredients = db.prepare(`
    SELECT sri.*, rm.average_price, rm.unit AS material_unit, rm.name AS material_name, rm.pack_size AS material_pack_size
    FROM sub_recipe_ingredients sri
    JOIN raw_materials rm ON sri.material_id = rm.id
    WHERE sri.sub_recipe_id = ? AND sri.is_default = 1
  `).all(subRecipeId) as any[];

  let totalCost = 0;
  for (const ing of ingredients) {
    const qtyInMatUnit = convertToMaterialUnit(ing.quantity, ing.unit, ing.material_unit, ing.material_name, ing.material_pack_size);
    const effectiveQty = qtyInMatUnit * (1 + ing.wastage_percent / 100) / (ing.yield_percent / 100);
    totalCost += effectiveQty * ing.average_price;
  }

  const costPerUnit = subRecipe.yield_quantity > 0 ? totalCost / subRecipe.yield_quantity : 0;

  db.prepare(`
    UPDATE sub_recipes SET total_cost = ?, cost_per_unit = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(Math.round(totalCost * 100) / 100, Math.round(costPerUnit * 100) / 100, subRecipeId);

  // Cascade: update all recipes using this sub-recipe
  const linkedRecipes = db.prepare(`
    SELECT DISTINCT recipe_id FROM recipe_sub_recipes WHERE sub_recipe_id = ?
  `).all(subRecipeId) as any[];

  for (const link of linkedRecipes) {
    recalculateRecipeCost(db, link.recipe_id);
  }
}

// Update material average price after purchase
export function updateMaterialPrice(db: Database.Database, materialId: string): void {
  const material = db.prepare('SELECT * FROM raw_materials WHERE id = ?').get(materialId) as any;
  if (!material) return;

  if (material.costing_method === 'average') {
    // SAME-MONTH weighted average: use ONLY the purchases made in the calendar
    // month of the material's MOST RECENT purchase. The average therefore always
    // reflects that month's prices and NEVER blends across a full year (older
    // months are ignored). A material with no purchases at all is left untouched
    // (so a manually-corrected rate stays put until a real purchase lands).
    const sameMonth = db.prepare(`
      SELECT SUM(quantity * unit_price) AS total_value, SUM(quantity) AS total_qty
      FROM purchases
      WHERE material_id = ?
        AND strftime('%Y-%m', date) = (
          SELECT strftime('%Y-%m', MAX(date)) FROM purchases WHERE material_id = ?
        )
    `).get(materialId, materialId) as any;

    let avgPrice: number | null = null;   // ₹ per purchase_unit (e.g. ₹/kg)
    if (sameMonth && sameMonth.total_qty > 0) {
      avgPrice = sameMonth.total_value / sameMonth.total_qty;
    }

    // 🔧 Normalise to ₹ per RECIPE unit. Purchases are entered in purchase_unit
    // (e.g. "5 kg" of ginger at ₹70/kg), but recipes use the material.unit
    // (e.g. grams). If pack_size > 1, divide the per-purchase-unit price by
    // pack_size so downstream cost = recipe_qty × average_price is correct.
    //
    // Example: ginger bought at ₹70/kg, pack_size=1000 (1 kg = 1000 g) →
    //   average_price stored = ₹0.07/g, so recipe of 5 g costs ₹0.35.
    if (avgPrice != null) {
      const packSize = Number(material.pack_size) || 1;
      const recipeUnit = String(material.unit || '').toLowerCase();
      const purchaseUnit = String(material.purchase_unit || material.unit || '').toLowerCase();
      if (packSize > 1 && recipeUnit !== purchaseUnit) {
        avgPrice = avgPrice / packSize;
      }
      db.prepare('UPDATE raw_materials SET average_price = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(Math.round(avgPrice * 10000) / 10000, materialId);
    }
  } else {
    // FIFO: use latest purchase price — normalised to ₹/recipe unit (÷pack),
    // exactly like the average branch, so a pack>1 material flipped to FIFO
    // doesn't store a ₹/purchase-unit price into a ₹/recipe-unit field.
    const latest = db.prepare(
      'SELECT unit_price FROM purchases WHERE material_id = ? ORDER BY date DESC, created_at DESC LIMIT 1'
    ).get(materialId) as any;
    if (latest) {
      const packSize = Number(material.pack_size) || 1;
      const recipeUnit = String(material.unit || '').toLowerCase();
      const purchaseUnit = String(material.purchase_unit || material.unit || '').toLowerCase();
      const price = (packSize > 1 && recipeUnit !== purchaseUnit) ? latest.unit_price / packSize : latest.unit_price;
      db.prepare('UPDATE raw_materials SET average_price = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(Math.round(price * 10000) / 10000, materialId);
    }
  }

  // Cascade cost updates to all sub-recipes using this material
  const subRecipes = db.prepare(`
    SELECT DISTINCT sub_recipe_id FROM sub_recipe_ingredients WHERE material_id = ?
  `).all(materialId) as any[];

  for (const sr of subRecipes) {
    recalculateSubRecipeCost(db, sr.sub_recipe_id);
  }

  // Cascade to recipes directly using this material
  const recipes = db.prepare(`
    SELECT DISTINCT recipe_id FROM recipe_ingredients WHERE material_id = ?
  `).all(materialId) as any[];

  for (const r of recipes) {
    recalculateRecipeCost(db, r.recipe_id);
  }
}

// Deduct inventory for a sale
export function deductInventoryForSale(db: Database.Database, recipeId: string, quantity: number, saleId: string, billType: string): void {
  // Deduct raw ingredients
  const ingredients = db.prepare(`
    SELECT ri.*, rm.current_stock, rm.unit AS material_unit, rm.name AS material_name, rm.pack_size AS material_pack_size
    FROM recipe_ingredients ri
    JOIN raw_materials rm ON ri.material_id = rm.id
    WHERE ri.recipe_id = ? AND ri.is_default = 1
  `).all(recipeId) as any[];

  const txType = billType === 'nc' ? 'nc' : billType === 'complimentary' ? 'nc' : 'sale';

  for (const ing of ingredients) {
    const qtyInMatUnit = convertToMaterialUnit(ing.quantity, ing.unit, ing.material_unit, ing.material_name, ing.material_pack_size);
    const effectiveQty = qtyInMatUnit * (1 + ing.wastage_percent / 100) / (ing.yield_percent / 100);
    const totalDeduct = effectiveQty * quantity;

    db.prepare('UPDATE raw_materials SET current_stock = current_stock - ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(totalDeduct, ing.material_id);

    db.prepare(`
      INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(generateId(), ing.material_id, txType, -totalDeduct, saleId, `Sale of ${quantity}x recipe ${recipeId}`);
  }

  // Deduct sub-recipe ingredients
  const subRecipes = db.prepare(`
    SELECT rs.*, sr.yield_quantity
    FROM recipe_sub_recipes rs
    JOIN sub_recipes sr ON rs.sub_recipe_id = sr.id
    WHERE rs.recipe_id = ?
  `).all(recipeId) as any[];

  for (const sr of subRecipes) {
    const subIngredients = db.prepare(`
      SELECT sri.*, rm.current_stock, rm.unit AS material_unit, rm.name AS material_name, rm.pack_size AS material_pack_size
      FROM sub_recipe_ingredients sri
      JOIN raw_materials rm ON sri.material_id = rm.id
      WHERE sri.sub_recipe_id = ? AND sri.is_default = 1
    `).all(sr.sub_recipe_id) as any[];

    const ratio = sr.quantity / (sr.yield_quantity || 1);

    for (const ing of subIngredients) {
      const qtyInMatUnit = convertToMaterialUnit(ing.quantity, ing.unit, ing.material_unit, ing.material_name, ing.material_pack_size);
      const effectiveQty = qtyInMatUnit * (1 + ing.wastage_percent / 100) / (ing.yield_percent / 100);
      const totalDeduct = effectiveQty * ratio * quantity;

      db.prepare('UPDATE raw_materials SET current_stock = current_stock - ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(totalDeduct, ing.material_id);

      db.prepare(`
        INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(generateId(), ing.material_id, txType, -totalDeduct, saleId, `Sub-recipe usage for sale`);
    }
  }
}

export interface SaleInput {
  item_name: string;
  recipe_id?: string | null;
  quantity_sold: number;
  bill_type?: string;              // 'normal' | 'nc' | 'comp'
  selling_price?: number;
  date: string;                    // YYYY-MM-DD
  sale_time?: string | null;
  order_id?: string | null;
  category?: string | null;
  server?: string | null;
  order_type?: string | null;
  pos_item_id?: string | null;
  pos_item_name?: string | null;
  variant_name?: string | null;
  outlet_id?: string | null;
  // Record the sale (revenue) but do NOT deduct inventory again — used at settle
  // when the item's recipe was already deducted at KOT-complete (see the KDS bump
  // route). Prevents double-deduction under the "consume on KOT complete" model.
  skip_inventory?: boolean;
}

/**
 * Record one sale row and deduct its inventory. This is the canonical path that
 * POS settle and /api/sales both use: cost comes from the recipe, revenue is 0
 * for non-`normal` bills, and inventory is deducted only when a recipe is linked.
 * Call inside a db.transaction() to keep a multi-line settle atomic.
 * Returns the new sale id.
 */
export function recordSale(db: Database.Database, s: SaleInput): string {
  if (!s.item_name || !s.quantity_sold || !s.date) {
    throw new Error('item_name, quantity_sold, and date are required');
  }
  const billType = s.bill_type || 'normal';

  let recipeCost = 0;
  if (s.recipe_id) {
    const recipe = db.prepare('SELECT total_cost FROM recipes WHERE id = ?').get(s.recipe_id) as any;
    if (recipe) recipeCost = recipe.total_cost;
  }
  const total_cost = Math.round(recipeCost * s.quantity_sold * 100) / 100;
  const total_revenue = billType === 'normal'
    ? Math.round((s.selling_price || 0) * s.quantity_sold * 100) / 100
    : 0;

  const id = generateId();
  db.prepare(`
    INSERT INTO sales (id, item_name, recipe_id, quantity_sold, bill_type, selling_price,
                       total_revenue, total_cost, date, created_at,
                       sale_time, order_id, category, server, order_type,
                       pos_item_id, pos_item_name, variant_name, outlet_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'),
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?)
  `).run(
    id, s.item_name, s.recipe_id || null, s.quantity_sold, billType,
    s.selling_price || 0, total_revenue, total_cost, s.date,
    s.sale_time || null, s.order_id || null, s.category || null, s.server || null, s.order_type || null,
    s.pos_item_id || null, s.pos_item_name || null, s.variant_name || null, s.outlet_id || null,
  );

  if (s.recipe_id && !s.skip_inventory) {
    deductInventoryForSale(db, s.recipe_id, s.quantity_sold, id, billType);
  }
  return id;
}
