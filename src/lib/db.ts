import Database from 'better-sqlite3';
import path from 'path';
// The department stock rail. Safe to import STATICALLY (not via the deferred
// require this file uses for './units' and './store-engine'): dept-ledger has
// no runtime imports at all — only `import type Database` — so there is no
// cycle back into db.ts. Static on purpose, so the compiler checks the call
// shapes: resolveStationDepartment returns a RESOLUTION OBJECT, not an id, and
// reading it as an id would post "[object Object]" into a stock ledger.
import { resolveStationDepartment, postDeptLedger, recordConsumptionSkip } from './dept-ledger';

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
    -- Backdate window (in DAYS) for purchase-type date entry (Purchase / Bulk Bill /
    -- GRN). Non-admins can only save a date within the last N days and never in the
    -- future; admins are fully exempt. Admin-editable via /settings; enforced in
    -- src/lib/purchase-guard.ts. INSERT OR IGNORE = deploy-safe (never clobbers a set value).
    INSERT OR IGNORE INTO settings (key, value) VALUES ('purchase_backdate_limit_days', '3');

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

    -- Variance Approvals — a closing count with a non-zero variance NEVER changes
    -- stock directly; it creates a PENDING approval here. An admin reviews (records
    -- the staff's reason) and approves (stock → physical count) or rejects (stock
    -- unchanged; the variance stands as an open loss to investigate). Covers both
    -- central raw-material counts (source='central') and liquor/floor-bar counts
    -- (source='liquor').
    CREATE TABLE IF NOT EXISTS variance_approvals (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,                     -- 'central' | 'liquor'
      material_id TEXT NOT NULL,
      store_id TEXT NOT NULL DEFAULT '',        -- liquor: the store/floor bar; central: ''
      department_id TEXT NOT NULL DEFAULT '',   -- central: dept bucket ('' = Store/Overall); liquor: ''
      date TEXT NOT NULL,                       -- closing count date (YYYY-MM-DD)
      system_stock REAL NOT NULL DEFAULT 0,     -- what the system had at count time
      physical_stock REAL NOT NULL DEFAULT 0,   -- what was counted
      variance REAL NOT NULL DEFAULT 0,         -- physical - system (negative = shortage)
      variance_value REAL NOT NULL DEFAULT 0,   -- variance × average_price
      unit TEXT NOT NULL DEFAULT '',            -- recipe unit, for display
      counted_by TEXT NOT NULL DEFAULT '',
      count_note TEXT NOT NULL DEFAULT '',      -- optional note from whoever counted
      status TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'approved' | 'rejected'
      reviewed_by TEXT NOT NULL DEFAULT '',
      reviewed_at TEXT NOT NULL DEFAULT '',
      review_reason TEXT NOT NULL DEFAULT '',   -- admin records the reason after asking staff
      outlet_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (material_id) REFERENCES raw_materials(id)
    );
    CREATE INDEX IF NOT EXISTS idx_variance_appr_status ON variance_approvals(status);
    CREATE INDEX IF NOT EXISTS idx_variance_appr_date ON variance_approvals(date);
    CREATE INDEX IF NOT EXISTS idx_variance_appr_material ON variance_approvals(material_id);
    -- At most ONE pending approval per (source, material, store, dept, date,
    -- OUTLET): a re-count before approval refreshes the same pending row (see
    -- upsertVarianceApproval). outlet_id is part of the key so two outlets can
    -- each hold their own pending row for the same material/date.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_variance_appr_pending
      ON variance_approvals(source, material_id, store_id, department_id, date, outlet_id)
      WHERE status = 'pending';

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
    // Backfill — any menu item already with a material_id is implicitly reviewed.
    // ONE-SHOT: direct_reviewed is a human's judgement, so re-running this on
    // every boot silently re-reviewed anything an admin had un-reviewed, on the
    // next deploy. Same class of bug as the nav-continuity grants below.
    const reviewedBackfilled = db.prepare("SELECT value FROM settings WHERE key='direct_reviewed_backfill_v1'").get() as any;
    if (!reviewedBackfilled) {
      db.exec(`UPDATE menu_items SET direct_reviewed = 1 WHERE material_id IS NOT NULL AND direct_reviewed = 0`);
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('direct_reviewed_backfill_v1', '1')").run();
    }
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
    // Cookbook (Phase 1): a recipe becomes a usable kitchen document — cooking
    // METHOD + a photo. Additive; does NOT affect recalculateRecipeCost.
    if (!has('instructions')) db.exec(`ALTER TABLE recipes ADD COLUMN instructions TEXT DEFAULT ''`);
    if (!has('image_url'))    db.exec(`ALTER TABLE recipes ADD COLUMN image_url TEXT DEFAULT ''`);
  } catch (e) { console.error('recipes yield migration failed:', e); }

  // Migration: ct_specials gains a `category` (special|offer|notice|event|vip) so
  // the GRE "What's On" board's specials tool doubles as a general per-date
  // heading+details notice board (each category renders its own icon/colour).
  // Additive & defaulted; harmless if the table doesn't exist yet.
  try {
    const cols = db.prepare("PRAGMA table_info(ct_specials)").all() as any[];
    if (cols.length && !cols.some((c: any) => c.name === 'category')) {
      db.exec(`ALTER TABLE ct_specials ADD COLUMN category TEXT NOT NULL DEFAULT 'special'`);
    }
  } catch (e) { console.error('ct_specials category migration failed:', e); }

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

  // The PO line forgot which requisition LINE it buys for. When a shortfall
  // becomes a PO, store-process holds ln.req_item_id in memory all the way to
  // the insert and then drops it; only "From REQ-2026-0123" survives in the line
  // notes, and that names the requisition, not the line. Soft link, no FK
  // (SQLite cannot ADD one by ALTER). NOT backfilled; the note text is unchanged.
  //
  // Placed AFTER the CREATE TABLE above on purpose. The older per-line-vendor
  // migration for this same table sits BEFORE it, so on a brand-new database
  // its PRAGMA sees no table and the columns only appear on the second boot.
  // Do not copy that ordering.
  //
  // Known limitation, stated rather than papered over: mergeDuplicateLines()
  // (src/lib/line-dedupe.ts) folds two requisition lines for the same material
  // into one PO line keeping the first row's fields, so a merged line names the
  // FIRST requisition line. The joined notes still carry both.
  try {
    const cols = db.prepare("PRAGMA table_info(purchase_order_items)").all() as any[];
    if (cols.length > 0 && !cols.some((c: any) => c.name === 'req_item_id')) {
      db.exec(`ALTER TABLE purchase_order_items ADD COLUMN req_item_id TEXT`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_poi_req_item ON purchase_order_items(req_item_id)`);
  } catch (e) { console.error('po_items.req_item_id migration failed:', e); }

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

    // One-time: rebuild every stored recipe/sub-recipe total from CURRENT
    // material rates. Rate fixes made before the cascade landed (rate editor,
    // unit-audit rebase, workbook/bar imports) never recalculated dependent
    // recipes, so stored totals could show costs at OLD prices (owner-reported:
    // list ₹303.99 vs live lines ₹120.52). Prices themselves are not touched.
    const costsResynced = db.prepare(`SELECT value FROM settings WHERE key = 'recipe_costs_resync_v1'`).get() as any;
    if (!costsResynced) {
      const runResync = db.transaction(() => {
        for (const s of db.prepare(`SELECT id FROM sub_recipes`).all() as any[]) recalculateSubRecipeCost(db, s.id);
        for (const r of db.prepare(`SELECT id FROM recipes`).all() as any[]) recalculateRecipeCost(db, r.id);
        db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('recipe_costs_resync_v1', '1')`).run();
      });
      try { runResync(); console.log('[db] recipe_costs_resync_v1: stored recipe totals rebuilt from current rates'); }
      catch (e) { console.error('[db] recipe_costs_resync_v1 failed (rolled back):', e); }
    }

    // One-time: normalize dirty menu_items.item_type values. POS sheets shipped
    // 'beverages.' (trailing dot, 46 live rows), so the Beverages type filter
    // and stat-bar counts matched nothing. Write paths (/api/menu-items POST/PUT
    // and the import) now normalize (lowercase + strip trailing non-alphanumerics);
    // this repairs rows already stored.
    const itemTypesNormalized = db.prepare(`SELECT value FROM settings WHERE key = 'menu_item_type_normalize_v1'`).get() as any;
    if (!itemTypesNormalized) {
      const runItemTypeFix = db.transaction(() => {
        db.prepare(`UPDATE menu_items SET item_type = 'beverages' WHERE item_type = 'beverages.'`).run();
        // Generic sweep for any other dirty value (SQLite has no regex — normalize in JS per distinct value).
        const distinctTypes = db.prepare(`SELECT DISTINCT item_type FROM menu_items WHERE item_type IS NOT NULL AND item_type != ''`).all() as any[];
        for (const t of distinctTypes) {
          const clean = String(t.item_type).trim().toLowerCase().replace(/[^a-z0-9]+$/, '');
          if (clean && clean !== t.item_type) {
            db.prepare(`UPDATE menu_items SET item_type = ? WHERE item_type = ?`).run(clean, t.item_type);
          }
        }
        db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('menu_item_type_normalize_v1', '1')`).run();
      });
      try { runItemTypeFix(); console.log('[db] menu_item_type_normalize_v1: menu_items.item_type values normalized'); }
      catch (e) { console.error('[db] menu_item_type_normalize_v1 failed (rolled back):', e); }
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

  // Department on-hand ledger. Originally party-only (party fulfilment
  // TRANSFERS materials store→dept: raw_materials.current_stock decreases and
  // the department's on_hand increases). Since the department-inventory cutover
  // (2026-08) this is the ONE department stock rail for everything: requisition
  // issues in, recipe consumption out, reversals back.
  //
  // department_material_transactions IS THE TRUTH — the SUM of its signed
  // `quantity` (recipe units, + into the department, − out), anchored on the
  // latest physical count. See the widening block at the end of this function.
  //
  // department_materials.on_hand is a maintained CACHE, not a truth. It stays
  // written because party-fulfillment.ts and the reconcile route read it, but
  // no guard and no screen may DECIDE on it. Same for balance_after on the
  // ledger row: a running-balance column is the classic way two truths appear
  // the moment two writers interleave. /api/department-ledger/check asserts
  // cache == ledger sum so drift is visible instead of silent.
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
        -- VOCABULARY (the SIGN is what the balance sums; the type is what the
        -- audit reads, so the two must never be conflated):
        --   opening        + cutover count, one per dept x material, admin-only
        --   issued         + requisition issue from central
        --   issue_reversal - undo / store_reject of an issue
        --   consumption    - recipe consumption at KOT complete / comp / NC
        --   wastage        - spoilage the department already held
        --   staff_meal     - staff meal cooked from department stock
        --   received       + party fulfilment in            (party rail only)
        --   consumed       - party post-event usage         (party rail only)
        --   returned       - party leftovers back to store  (party rail only)
        --   adjusted     +/- approved variance count, unit-audit rebase
        -- issue_reversal exists because creditDepartment used to write a
        -- reversal as type='issued' with a NEGATIVE quantity: any report
        -- grouping by type, or summing ABS(quantity), read a reversal as an
        -- issue.
        type          TEXT NOT NULL,
        quantity      REAL DEFAULT 0,              -- SIGNED, recipe units. + into the dept, - out. THE balance column.
        balance_after REAL DEFAULT 0,              -- display convenience for the audit view. NEVER read it for a decision.
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

  // Requisition issue ledger — the audit spine for the store→department
  // handover, and the one table the end-to-end material log is built on.
  //
  // Every writer of requisition_items.quantity_issued calls applyIssueDelta()
  // (src/lib/issue-stock.ts) inside its own transaction with the before/after
  // line quantities, and exactly one row lands here per non-zero delta.
  //
  // TWO QUANTITIES, AND THEY ARE NOT THE SAME NUMBER. Do not "simplify" them
  // back into one column — that is the ALMOND bug waiting to happen:
  //
  //   recorded_recipe_qty  what physically left the store on this call. Written
  //                        on EVERY issue, ALWAYS, whatever else is true of the
  //                        line. This is the column the log reads.
  //                                                         ALWAYS-RECORD.
  //   delta_recipe_qty     the SUBSET of that which actually moved
  //                        raw_materials.current_stock — 0 whenever no stock
  //                        moved. Sole input to the credit clamp in
  //                        issue-stock.ts.                  ACTUAL-DEDUCT.
  //
  // The deduct is now UNCONDITIONAL (department-inventory cutover, 2026-08):
  // every non-party, non-store-mapped issue debits central. The two columns
  // still differ, because two carve-outs still move no central stock — party
  // requisitions (party-fulfillment.ts owns their debit) and store-mapped
  // liquor (the TGBCL store rail owns it). skip_reason names which.
  //
  // The RECORD must never again be gated on anything: while it was, this table
  // stayed empty through 14,148 real issues and no log of them could be built.
  //
  // INVARIANTS, per req_item_id:
  //
  //   SUM(recorded_recipe_qty) == (quantity_issued - baseline_line_qty) x pack_factor
  //   SUM(delta_recipe_qty)    <= SUM(recorded_recipe_qty)                always
  //
  // The first of those used to be stated on delta_recipe_qty, and held only
  // while a row could not exist without a deduction. A hand-over that moves no
  // central stock (party, store-mapped) still has to be RECORDED, so the
  // hand-over invariant moved to its own column.
  //
  // WHY THE SPLIT: overloading delta_recipe_qty with hand-overs that moved no
  // stock poisons the credit clamp — a line recorded without a debit and then
  // undone would credit stock that was never debited. Measured on ALMOND:
  // 4,000 g became 5,000 g and the department balance went to -1,000. Two
  // meanings, two columns, two independent clamps.
  //
  // stock_applied is 1 iff the row moved current_stock — INCLUDING a reversal
  // row, which carries a negative delta_recipe_qty. So lineHasMovedStock() /
  // requisitionHasMovedStock() must ask for NET movement
  // (SUM(delta_recipe_qty) > 1e-9), never for the mere EXISTENCE of a
  // stock_applied row: a fully-undone line would otherwise stay "moved"
  // forever and four daily operations — requisition PUT, cancel, chef-reject,
  // requisitions-import — dead-end on advice ("undo the issued lines first")
  // that can never be followed.
  //
  // effective_line_qty (chef_approved_qty ?? quantity_requested) is SNAPSHOTTED
  // at issue time, so FULL-vs-PART is a stamped fact: a chef editing the
  // approved quantity next week must not retro-rewrite what the store handed
  // over this morning.
  //
  // baseline_line_qty is stamped ONLY on the first row for a req_item_id, from
  // whatever quantity_issued already held. That is what makes forward-only
  // structural rather than a promise: the 14,148 lines of imported history are
  // the baseline, so a new issue against an old requisition records and moves
  // only the increment and can never retro-deduct the past.
  //
  // pack_factor is stored per row because a later Unit Audit rebase changes a
  // material's factor; the audit must reconcile with the factor actually used,
  // and the log's pre-ledger remainder — quantity_issued minus
  // SUM(recorded_recipe_qty / pack_factor) — only reverses exactly if it does.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS requisition_issue_ledger (
        id                TEXT PRIMARY KEY,
        req_id            TEXT NOT NULL,
        req_item_id       TEXT NOT NULL,
        material_id       TEXT NOT NULL,
        department_id     TEXT,
        outlet_id         TEXT,
        reason            TEXT NOT NULL,            -- issue | store_process | undo | store_reject | admin_adjust
        baseline_line_qty REAL,                     -- NON-NULL only on the first row for a req_item_id
        before_line_qty   REAL NOT NULL,
        after_line_qty    REAL NOT NULL,
        delta_line_qty    REAL NOT NULL,            -- in the LINE's own unit (Option B)
        line_unit         TEXT,
        pack_factor       REAL NOT NULL,
        delta_recipe_qty  REAL NOT NULL,            -- RECIPE units; positive = left the store
        store_mapped      INTEGER NOT NULL DEFAULT 0,
        needs_unit_review INTEGER NOT NULL DEFAULT 0,
        inv_txn_id        TEXT,
        client_token      TEXT,
        actor             TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_req_issue_ledger_item ON requisition_issue_ledger(req_item_id);
      CREATE INDEX IF NOT EXISTS idx_req_issue_ledger_req  ON requisition_issue_ledger(req_id);
      CREATE INDEX IF NOT EXISTS idx_req_issue_ledger_mat  ON requisition_issue_ledger(material_id);
      -- Layer 2 idempotency: a replayed POST carrying the same gesture token
      -- collides here, better-sqlite3 rolls the whole txn back, and the route
      -- answers 200 {replayed:true} instead of deducting a second time.
      CREATE UNIQUE INDEX IF NOT EXISTS uq_req_issue_token_item
        ON requisition_issue_ledger(client_token, req_item_id)
        WHERE client_token IS NOT NULL;
    `);
    // RETAINED DELIBERATELY, READ BY NOTHING. The deduct-at-issue cutover
    // (2026-08) made the behaviour unconditional and removed every functional
    // read of this key. The row stays because deleting it would rewrite
    // admin-owned state inside a boot migration — the one thing
    // scripts/check-boot-migrations.js exists to prevent — and because
    // src/lib/db-explorer.ts still ships a saved query that must resolve
    // (scripts/check-db-explorer.js asserts it). Flipping it changes nothing.
    // Do not re-introduce a read; the gate for the cutover is the counted
    // opening balance (settings.dept_ledger_cutover_at), not a switch.
    db.exec(`INSERT OR IGNORE INTO settings (key, value) VALUES ('requisition_deduct_at_issue', '0')`);
  } catch (e) { console.error('requisition_issue_ledger schema failed:', e); }

  // The four columns that let an issue be RECORDED without being DEDUCTED.
  // Additive, guarded one at a time, no backfill. The CREATE TABLE above is
  // left exactly as it shipped — THIS block is the single source of truth for
  // fresh and existing databases alike, the same pattern the purchases
  // migration further down uses. Adding them to the CREATE would give a fresh
  // database one shape and an existing one another.
  try {
    const cols = db.prepare("PRAGMA table_info(requisition_issue_ledger)").all() as any[];
    const has = (n: string) => cols.some((c: any) => c.name === n);
    if (cols.length > 0) {
      // ALWAYS-RECORD: recipe units physically handed over on this call, written
      // on every issue whatever the deduct flag says. Do NOT fold this back into
      // delta_recipe_qty to save a column — that column feeds the credit clamp
      // and means "what left current_stock". See the ALMOND note above.
      if (!has('recorded_recipe_qty'))
        db.exec(`ALTER TABLE requisition_issue_ledger ADD COLUMN recorded_recipe_qty REAL NOT NULL DEFAULT 0`);
      // 1 iff this row moved raw_materials.current_stock. The has-stock-moved
      // guards filter on it; without that filter they begin refusing requisition
      // PUT, cancel, chef-reject and import the moment a flag-off record lands.
      if (!has('stock_applied'))
        db.exec(`ALTER TABLE requisition_issue_ledger ADD COLUMN stock_applied INTEGER NOT NULL DEFAULT 0`);
      // chef_approved_qty ?? quantity_requested, snapshotted at issue time so
      // FULL vs PART (7 kg asked, 5 kg given) is a stamped fact, not a live
      // recomputation a later approval edit can rewrite.
      if (!has('effective_line_qty'))
        db.exec(`ALTER TABLE requisition_issue_ledger ADD COLUMN effective_line_qty REAL`);
      // '' | flag_off | party | unit_review — why no stock moved, stated on the
      // row's own face. The setting's value at the time is unrecoverable later,
      // so a reader must not have to infer it.
      if (!has('skip_reason'))
        db.exec(`ALTER TABLE requisition_issue_ledger ADD COLUMN skip_reason TEXT NOT NULL DEFAULT ''`);
    }
    // Once recording is unconditional this table goes from 0 rows to roughly
    // 14,000 a year, and the end-to-end log filters by date and by department.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_req_issue_ledger_created ON requisition_issue_ledger(created_at);
      CREATE INDEX IF NOT EXISTS idx_req_issue_ledger_dept    ON requisition_issue_ledger(department_id);
    `);
  } catch (e) { console.error('requisition_issue_ledger additive columns failed:', e); }

  // ── Purchasing: per-vendor receiving + petty cash ────────────────────────
  try {
    db.exec(`
      -- A mixed-vendor PO is received one VENDOR at a time, because each vendor
      -- turns up with their own invoice on their own day. One row per vendor per
      -- PO: their bill number, their date, who took it in.
      CREATE TABLE IF NOT EXISTS po_vendor_bills (
        id          TEXT PRIMARY KEY,
        po_id       TEXT NOT NULL,
        vendor_id   TEXT,
        vendor_name TEXT NOT NULL DEFAULT '',
        bill_no     TEXT NOT NULL DEFAULT '',
        bill_date   TEXT NOT NULL DEFAULT '',
        received_by TEXT NOT NULL DEFAULT '',
        notes       TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_po_vendor_bills_po ON po_vendor_bills(po_id);
      -- One bill number per vendor per PO. A second delivery from the same
      -- vendor on the same PO carries a different invoice, so this catches the
      -- duplicate-entry case without blocking a genuine split delivery.
      CREATE UNIQUE INDEX IF NOT EXISTS uq_po_vendor_bill
        ON po_vendor_bills(po_id, vendor_name, bill_no);

      -- Store petty cash. Every movement of physical cash the store holds:
      -- a float top-up in, a cash purchase or delivery payment out. Balance is
      -- SUM(in) - SUM(out) — never stored, always derived, so it cannot drift
      -- away from its own ledger.
      CREATE TABLE IF NOT EXISTS petty_cash_ledger (
        id           TEXT PRIMARY KEY,
        outlet_id    TEXT,
        date         TEXT NOT NULL,
        direction    TEXT NOT NULL,              -- 'in' | 'out'
        amount       REAL NOT NULL DEFAULT 0,    -- always POSITIVE; direction carries the sign
        category     TEXT NOT NULL DEFAULT '',   -- float_topup | cash_purchase | delivery | return | adjustment
        purchase_id  TEXT,                       -- set when the cash paid for a recorded purchase
        vendor       TEXT NOT NULL DEFAULT '',
        reference    TEXT NOT NULL DEFAULT '',   -- bill / voucher number
        notes        TEXT NOT NULL DEFAULT '',
        recorded_by  TEXT NOT NULL DEFAULT '',
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_petty_date   ON petty_cash_ledger(date);
      CREATE INDEX IF NOT EXISTS idx_petty_outlet ON petty_cash_ledger(outlet_id);
    `);
  } catch (e) { console.error('purchasing schema (po_vendor_bills / petty_cash) failed:', e); }

  // SEED vendor_materials FROM REAL PURCHASE HISTORY — one-shot.
  //
  // Vendor mapping is about to become STRICT on the PO screen: a vendor offers
  // only its own materials, and a material offers only its own vendors. The
  // table is empty and there are 55 vendors, so shipping the rule against an
  // empty map would stop every PO from being raised the next morning.
  //
  // Who has actually supplied what is already recorded in `purchases`: 527
  // distinct vendor/material pairs across 38 vendors and 441 materials. That is
  // a truer starting map than anything typed by hand, so it is seeded once and
  // then owned by the Vendor Items screen. Matching is by vendor NAME because
  // purchases stores the name, not the id.
  //
  // ONE-SHOT and INSERT OR IGNORE: after this the mapping is admin-owned, and a
  // redeploy must never re-add a pair someone deliberately deleted.
  try {
    const seeded = db.prepare("SELECT value FROM settings WHERE key='vendor_materials_seed_v1'").get() as any;
    if (!seeded) {
      const n = db.prepare(`
        INSERT OR IGNORE INTO vendor_materials (vendor_id, material_id, notes, created_by)
        SELECT v.id, p.material_id, 'seeded from purchase history', 'system'
          FROM purchases p
          JOIN vendors v ON LOWER(TRIM(v.name)) = LOWER(TRIM(p.vendor))
         WHERE TRIM(COALESCE(p.vendor,'')) <> '' AND p.material_id IS NOT NULL
         GROUP BY v.id, p.material_id
      `).run();
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('vendor_materials_seed_v1','1')").run();
      if (n.changes > 0) console.log(`[migration] seeded ${n.changes} vendor→material pairs from purchase history`);
    }
  } catch (e) { console.error('vendor_materials seed failed:', e); }

  // ── WhatsApp templates for the guest-engagement features ─────────────────
  //
  // Seeded as DRAFTS: send_as_template = 0 and provider_template_name = ''.
  // Nothing here can go out as an approved template until a human pastes the
  // Meta/Interakt-approved name into the Templates tab and flips the switch —
  // which is correct, because Meta must approve the wording first and we cannot
  // do that from here. The body text is the exact copy to submit.
  //
  // INSERT OR IGNORE, never REPLACE: this is admin-editable content. Once
  // someone edits the wording or wires the provider name, a redeploy must not
  // undo them (see scripts/check-boot-migrations.js for why that rule exists).
  //
  // CATEGORY MATTERS AT META, and getting it wrong gets the template rejected
  // or reclassified:
  //   UTILITY   — follows up on something the guest did (they rang us; they
  //               sent an enquiry). No offers, no discounts, no marketing words.
  //   MARKETING — anything promotional. Requires prior opt-in under DPDPA and
  //               costs the marketing rate (Rs 0.8631/msg in India from
  //               Jan 2026), versus ~Rs 0.115 for utility.
  //
  // Variables are POSITIONAL at the provider ({{1}}, {{2}}); the local `body`
  // uses names and `param_order` maps one to the other.
  try {
    const seedTpl = db.prepare(`
      INSERT OR IGNORE INTO whatsapp_templates
        (id, name, category, language, body, is_active, provider_template_name,
         provider_language, param_order, send_as_template)
      VALUES (lower(hex(randomblob(16))), ?, ?, 'en', ?, 1, '', 'en', ?, 0)
    `);
    const T: Array<[string, string, string, string[]]> = [
      // [internal name, local category, body, positional param order]

      // 1. UTILITY — the missed-call acknowledgement. Deliberately has NO offer
      //    in it; one promotional word here turns it into a MARKETING template
      //    that cannot be used as a service reply.
      ['ct_missed_call_ack', 'notification',
       'Sorry we missed your call to {{venue}}. Reply to this message and our team will help you book a table.',
       ['venue']],

      // 2. UTILITY — same, for a call that came in after closing. Says when we
      //    open, which is the useful thing to tell someone at 2am.
      ['ct_missed_call_ack_after_hours', 'notification',
       'Sorry we missed your call to {{venue}}. We open at {{open_time}}. Reply to this message and we will help you book a table.',
       ['venue', 'open_time']],

      // 3. UTILITY — follow-up to an enquiry the GUEST started, so it stays
      //    transactional as long as it offers help rather than a deal.
      ['ct_enquiry_followup', 'notification',
       'Hi {{name}}, thank you for your enquiry about an event at {{venue}}. Reply to this message and our events team will share dates and options.',
       ['name', 'venue']],

      // 4. MARKETING — the win-back. Needs opt-in.
      ['ct_winback', 'marketing',
       'Hi {{name}}, it has been a while since your last visit to {{venue}}. We would love to welcome you back — reply to this message to book a table.',
       ['name', 'venue']],

      // 5. MARKETING — filling a quiet night.
      ['ct_slow_night', 'marketing',
       'Hi {{name}}, we have tables free at {{venue}} on {{day}}. Reply to this message to reserve yours.',
       ['name', 'venue', 'day']],

      // 6. MARKETING — birthday. The highest-converting message a venue sends,
      //    and the one most worth getting approved.
      ['ct_birthday', 'marketing',
       'Happy birthday {{name}}! Everyone at {{venue}} wishes you a wonderful year. Reply to this message to plan your celebration with us.',
       ['name', 'venue']],

      // 7. UTILITY — DAILY CALLS ANALYTICS TO THE ADMIN. Internal, not a guest
      //    message: it goes to our own owner/managers about our own operation.
      //
      //    The name MUST stay 'calls_daily'. Template lookup for notifyEvent is
      //    by convention name === event, so renaming this silently drops the
      //    admin back to the built-in fallback body.
      //
      //    Nine variables is a lot for one template and Meta will scrutinise it.
      //    If it gets rejected, collapse the body to two ({{date}} and one
      //    pre-formatted {{summary}}) and build the block in runWaDailyNotifications
      //    instead — the param_order is the only thing that has to change.
      ['calls_daily', 'notification',
       '📞 AKAN Calls — {{date}}\n\n'
       + 'Calls {{calls}} · Answered {{answered}} ({{answered_pct}}%) · Missed {{missed}}\n'
       + 'Bookings from calls: {{bookings}}\n'
       + 'Missed still open: {{pending}}\n'
       + 'Busiest hour: {{peak}}\n\n'
       + '{{agents}}',
       ['date', 'calls', 'answered', 'answered_pct', 'missed', 'bookings', 'pending', 'peak', 'agents']],
    ];
    for (const [name, cat, body, order] of T) seedTpl.run(name, cat, body, JSON.stringify(order));
  } catch (e) { console.error('whatsapp guest-engagement template seed failed:', e); }

  // ── CRM: topic tracking + win-back campaigns ─────────────────────────────
  // Ideas worth taking from CallHippo, built on the stack we already own
  // rather than bought (their Terms disclaim Indian PSTN termination, they
  // have no DLT support, and their API exposes one call-data endpoint with no
  // transcripts — so none of it could feed the guest 360 anyway).
  try {
    db.exec(`
      -- Standing keyword rules run over call transcripts/analysis. CallHippo
      -- calls this a "custom topic tracker"; ours reads the transcripts we
      -- already hold, so it costs nothing per call.
      CREATE TABLE IF NOT EXISTS ct_topic_rules (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        keywords    TEXT NOT NULL DEFAULT '[]',   -- JSON array, matched case-insensitively
        severity    TEXT NOT NULL DEFAULT 'info', -- info | attention | urgent
        is_active   INTEGER NOT NULL DEFAULT 1,
        notify      INTEGER NOT NULL DEFAULT 0,   -- raise an alert on a hit
        created_by  TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS ct_topic_hits (
        id           TEXT PRIMARY KEY,
        rule_id      TEXT NOT NULL,
        call_id      TEXT NOT NULL,
        guest_id     TEXT,
        matched_term TEXT NOT NULL DEFAULT '',
        excerpt      TEXT NOT NULL DEFAULT '',
        acknowledged INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(rule_id, call_id, matched_term)      -- re-scanning a call is a no-op
      );
      CREATE INDEX IF NOT EXISTS idx_ct_topic_hits_call ON ct_topic_hits(call_id);
      CREATE INDEX IF NOT EXISTS idx_ct_topic_hits_rule ON ct_topic_hits(rule_id);

      -- Win-back / slow-night WhatsApp campaigns. One row per send so the
      -- result is attributable: did this guest come back, and did they spend?
      CREATE TABLE IF NOT EXISTS ct_campaigns (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        segment      TEXT NOT NULL DEFAULT '{}',  -- JSON: the bucket that produced the list
        template     TEXT NOT NULL DEFAULT '',
        status       TEXT NOT NULL DEFAULT 'draft', -- draft | sending | sent | failed
        created_by   TEXT NOT NULL DEFAULT '',
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        sent_at      TEXT
      );
      CREATE TABLE IF NOT EXISTS ct_campaign_targets (
        id           TEXT PRIMARY KEY,
        campaign_id  TEXT NOT NULL,
        guest_id     TEXT,
        phone_e164   TEXT NOT NULL DEFAULT '',
        name         TEXT NOT NULL DEFAULT '',
        send_status  TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed | skipped
        send_error   TEXT NOT NULL DEFAULT '',
        sent_at      TEXT,
        -- attribution: filled in when the guest comes back after the send
        returned_at  TEXT,
        return_value REAL,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(campaign_id, phone_e164)             -- never message the same guest twice in one campaign
      );
      CREATE INDEX IF NOT EXISTS idx_ct_camp_targets_camp  ON ct_campaign_targets(campaign_id);
      CREATE INDEX IF NOT EXISTS idx_ct_camp_targets_phone ON ct_campaign_targets(phone_e164);
    `);
    // Defaults are all OFF / conservative: nothing starts messaging guests or
    // changing routing until someone turns it on in CRM Settings.
    for (const [k, v] of [
      ['missed_call_whatsapp', '0'],   // auto-acknowledge a missed call on WhatsApp
      ['missed_call_wa_text',  'Sorry we missed your call. Reply here and we will help you book.'],
      ['sticky_agent',         '0'],   // prefer the GRE who last spoke to this guest
      ['vip_routing',          '0'],   // surface high-value guests first
      ['vip_min_visits',       '5'],
      ['vip_min_spend',        '25000'],
      ['lapsed_days',          '60'],  // default win-back bucket
    ] as [string, string][]) {
      db.prepare(`INSERT OR IGNORE INTO ct_settings (key, value) VALUES (?, ?)`).run(k, v);
    }
  } catch (e) { console.error('ct topic/campaign schema failed:', e); }

  // Closing counts for SEMI-FINISHED items (sub_recipes) — Mint Chutney, GG
  // Paste, Aioli and 65 more. The kitchen holds real quantities of these at
  // close, but they live in sub_recipes, not raw_materials, so the ordinary
  // closing sheet could never show them.
  //
  // A separate table rather than a column on closing_stock: that table's
  // material_id is NOT NULL with a FOREIGN KEY to raw_materials and
  // `PRAGMA foreign_keys = ON` is set (db.ts:12), so a sub-recipe id cannot be
  // stored there at all. Relaxing it would mean a full table rebuild of live
  // count history to gain nothing — the two sides share no columns beyond
  // qty/date and value a semi-finished item by its own cost_per_unit, with no
  // pack factor. Readers UNION the two.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS closing_stock_semi (
        id             TEXT PRIMARY KEY,
        sub_recipe_id  TEXT NOT NULL,
        date           TEXT NOT NULL,
        department_id  TEXT,
        outlet_id      TEXT,
        physical_stock REAL NOT NULL DEFAULT 0,   -- in the sub-recipe's yield_unit
        unit           TEXT DEFAULT '',           -- yield_unit snapshot at count time
        rate           REAL NOT NULL DEFAULT 0,   -- Rs per yield_unit at count time
        total_value    REAL NOT NULL DEFAULT 0,   -- physical_stock x rate
        notes          TEXT DEFAULT '',
        recorded_by    TEXT DEFAULT '',
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (sub_recipe_id) REFERENCES sub_recipes(id)
      );
      CREATE INDEX IF NOT EXISTS idx_closing_semi_date ON closing_stock_semi(date);
      CREATE INDEX IF NOT EXISTS idx_closing_semi_sub  ON closing_stock_semi(sub_recipe_id);
      CREATE INDEX IF NOT EXISTS idx_closing_semi_dept ON closing_stock_semi(department_id);
    `);
  } catch (e) { console.error('closing_stock_semi schema failed:', e); }

  // Valuation snapshot on the raw-material closing row. Stored, not recomputed:
  // a count is a dated record, so the rate it was valued at must survive later
  // price movement. Nullable so every existing row stays untouched.
  try {
    const cols = new Set((db.prepare(`PRAGMA table_info(closing_stock)`).all() as any[]).map(c => c.name));
    if (!cols.has('rate_per_purchase_unit')) db.exec(`ALTER TABLE closing_stock ADD COLUMN rate_per_purchase_unit REAL`);
    if (!cols.has('rate_source'))            db.exec(`ALTER TABLE closing_stock ADD COLUMN rate_source TEXT`);
    if (!cols.has('total_value'))            db.exec(`ALTER TABLE closing_stock ADD COLUMN total_value REAL`);
  } catch (e) { console.error('closing_stock valuation columns failed:', e); }

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

  // ── Crash-proofing: captured production errors (web + captain + server) ──────
  // Every uncaught client error, unhandled rejection, React error-boundary hit,
  // and server-side onRequestError is POSTed to /api/error-report and stored
  // here. Identical errors (same digest) collapse into one OPEN row with a bumped
  // count, so a crash loop can't flood the table or the admin bell. Admins see an
  // "App errors" bucket in the notification bell + the /settings/errors page.
  // Isolated so a schema hiccup can never break the rest of initializeSchema.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS error_reports (
        id           TEXT PRIMARY KEY,
        digest       TEXT NOT NULL,               -- hash(source|message|where) for dedup
        source       TEXT NOT NULL DEFAULT 'web', -- 'web' | 'captain' | 'server' | 'client'
        message      TEXT NOT NULL DEFAULT '',
        stack        TEXT NOT NULL DEFAULT '',
        url          TEXT NOT NULL DEFAULT '',
        user_email   TEXT NOT NULL DEFAULT '',
        user_role    TEXT NOT NULL DEFAULT '',
        user_agent   TEXT NOT NULL DEFAULT '',
        count        INTEGER NOT NULL DEFAULT 1,
        first_seen   TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen    TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at  TEXT,
        resolved_by  TEXT NOT NULL DEFAULT '',
        notified_at  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_error_digest    ON error_reports(digest);
      CREATE INDEX IF NOT EXISTS idx_error_last_seen ON error_reports(last_seen);
      CREATE INDEX IF NOT EXISTS idx_error_unresolved ON error_reports(resolved_at);
    `);
  } catch (e) { console.error('error_reports schema failed:', e); }

  // ── Per-item CGST/SGST (India GST split) ────────────────────────────────────
  // Restaurants set CGST% + SGST% per menu item (liquor = 0, already taxed at
  // source). tax_value is kept = cgst_percent + sgst_percent so the per-item bill
  // engine (src/lib/bill-calc.ts, which applies each line's tax_value) is
  // UNCHANGED — this only adds explicit entry/display of the two halves. Backfill
  // splits the existing combined tax_value 50/50 so current items keep their tax.
  try {
    const cols = db.prepare('PRAGMA table_info(menu_items)').all() as any[];
    const has = (n: string) => cols.some((c: any) => c.name === n);
    if (!has('cgst_percent')) db.exec('ALTER TABLE menu_items ADD COLUMN cgst_percent REAL DEFAULT 0');
    if (!has('sgst_percent')) db.exec('ALTER TABLE menu_items ADD COLUMN sgst_percent REAL DEFAULT 0');
    db.exec(`UPDATE menu_items
             SET cgst_percent = ROUND(tax_value / 2.0, 2),
                 sgst_percent = ROUND(tax_value - tax_value / 2.0, 2)
             WHERE COALESCE(cgst_percent, 0) = 0 AND COALESCE(sgst_percent, 0) = 0 AND COALESCE(tax_value, 0) > 0`);
  } catch (e) { console.error('menu_items cgst/sgst migration failed:', e); }

  // Snapshot the per-line CGST/SGST split at add time (for exact bill display +
  // tax reporting). tax_value (combined) remains the value the bill engine sums.
  try {
    const cols = db.prepare('PRAGMA table_info(order_items)').all() as any[];
    const has = (n: string) => cols.some((c: any) => c.name === n);
    if (!has('cgst_value')) db.exec('ALTER TABLE order_items ADD COLUMN cgst_value REAL DEFAULT 0');
    if (!has('sgst_value')) db.exec('ALTER TABLE order_items ADD COLUMN sgst_value REAL DEFAULT 0');
    db.exec(`UPDATE order_items
             SET cgst_value = ROUND(tax_value / 2.0, 2),
                 sgst_value = ROUND(tax_value - tax_value / 2.0, 2)
             WHERE COALESCE(cgst_value, 0) = 0 AND COALESCE(sgst_value, 0) = 0 AND COALESCE(tax_value, 0) > 0`);
  } catch (e) { console.error('order_items cgst/sgst migration failed:', e); }

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

    // BACKFILL (2026-07-27, idempotent): Recaho-imported lines were inserted
    // without a unit — the importer's INSERT simply omitted the column — and a
    // blank unit is read as RECIPE units by reqPackFactor, while Recaho's
    // "TO QTY" figures are PURCHASE units (a "1" is one kg/BTL/pack, not one
    // gram). So 16k+ imported lines displayed and valued pack_size× too small
    // ("issued 1 g of ghee"). Provenance is clean — every affected row belongs
    // to a req_number LIKE 'REQ-IMP-%' written by that one importer — so stamp
    // each line with its material's purchase unit, the same resolution the
    // importer itself now uses. Scoped to REQ-IMP only: the handful of blank
    // APP-created lines are left alone (their entry basis is not provable, and
    // blank = recipe-units is at least a consistent reading for them).
    // Idempotent by construction: once stamped, no row matches the WHERE again.
    const backfilled = db.prepare(`
      UPDATE requisition_items SET unit = (
        SELECT COALESCE(NULLIF(TRIM(rm.purchase_unit), ''), rm.unit)
        FROM raw_materials rm WHERE rm.id = requisition_items.material_id
      )
      WHERE TRIM(COALESCE(unit, '')) = ''
        AND EXISTS (SELECT 1 FROM raw_materials rm WHERE rm.id = requisition_items.material_id)
        AND req_id IN (SELECT id FROM requisitions WHERE req_number LIKE 'REQ-IMP-%')
    `).run();
    if (backfilled.changes > 0) {
      console.log(`[migration] stamped purchase unit on ${backfilled.changes} Recaho-imported requisition lines`);
    }
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
    // Granular approval flag: may approve requisitions (dine-in + party) WITHOUT
    // the full HOD flag — no HOD-only pages, no party financials. Lets e.g. a
    // Bar Manager clear the approval inbox. Mirrors the is_head_chef pattern
    // (user flag OR assigned role's flag; see getCurrentUser / canApproveAsChef).
    if (!has('can_approve_requisitions')) db.exec(`ALTER TABLE users ADD COLUMN can_approve_requisitions INTEGER NOT NULL DEFAULT 0`);
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
    // Granular approval flag on the role (mirrors users.can_approve_requisitions):
    // holders may approve dine-in + party requisitions without being an HOD.
    if (!rCols.some((c: any) => c.name === 'can_approve_requisitions')) db.exec(`ALTER TABLE roles ADD COLUMN can_approve_requisitions INTEGER NOT NULL DEFAULT 0`);

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
      ['Floor Manager', 'manager', J(['/', '/dine-in/floor', '/dine-in/tables', '/dine-in/reservations', '/dine-in/kitchen', '/dine-in/order', '/dine-in/reconciliation', '/captain', '/print/agent', '/reports']), 0, 0, 0, 10, 'Runs the dining floor'],
      ['Captain',       'staff',   J(['/captain']), 0, 0, 0, 11, 'Takes table orders on a tablet'],
      // '/cashier' was MISSING from this list until 2026-08-11 — the role
      // described as "settles bills" could not open the cashier console, and
      // now that settle authority is gated on canAccessPage('/cashier', me)
      // (src/lib/settle-authority.ts) the omission would refuse a Cashier the
      // settle itself. Fixed here for FRESH databases; existing ones are
      // repaired by the one-shot cashier_role_page_grant_v1 migration lower in
      // this file, whose NOT-LIKE guard makes it a no-op on a fresh install.
      ['Cashier',       'staff',   J(['/cashier', '/dine-in/floor', '/dine-in/tables', '/dine-in/reservations', '/dine-in/order', '/captain']), 0, 0, 0, 12, 'Takes orders and settles bills'],
      ['Bar Manager',   'manager', J(['/dine-in/floor', '/dine-in/tables', '/dine-in/kitchen', '/dine-in/offline-print', '/print/agent', '/reports']), 0, 0, 0, 13, 'Runs the bar and its printers'],
      ['Head Chef',     'manager', J(['/dine-in/kitchen', '/requisitions', '/menu-items', '/recipes', '/department-consumption']), 1, 0, 0, 14, 'Runs the kitchen; approves requisitions'],
      ['Store Manager', 'manager', J(['/store-dashboard', '/store-requisitions', '/purchases', '/purchase-orders', '/grn', '/inventory', '/closing-stock', '/wastage', '/departments', '/vendors']), 0, 1, 0, 15, 'Runs the store; issues inventory'],
    ];
    for (const s of seeds) seedRole.run(s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]);
  } catch (e) { console.error('roles schema/seed migration failed:', e); }

  // ── NAV-CONTINUITY GRANTS — ONE-SHOT, NEVER ON EVERY BOOT ────────────────
  //
  // These two hand a newly-added page to roles that already hold its sibling,
  // so a rename or a split does not silently strand people. That is a
  // one-time courtesy at the moment the page ships.
  //
  // They used to run on EVERY boot, and because a deploy restarts the process,
  // that made them run on every deploy. Their WHERE clause cannot tell "this
  // role has never seen the new page" from "an admin deliberately revoked it",
  // so a revoke survived exactly until the next deploy and then silently
  // undid itself. Reproduced on the live Floor Manager role: revoke
  // /dine-in/reservations, restart once, and it is back.
  //
  // Access is admin-owned state, not derived state. Once it has been granted
  // once, the admin's word is final — so both are gated behind a settings flag
  // and can never run a second time. Same one-shot pattern as
  // phase1_master_backfill_v1 and the other *_v1 flags in this file.
  //
  // ANY future migration that writes roles.page_access, users.page_access, a
  // role tier, or any other admin-set permission MUST be one-shot for the same
  // reason. scripts/check-boot-migrations.js enforces this.
  try {
    const navGranted = db.prepare("SELECT value FROM settings WHERE key='nav_continuity_grants_v1'").get() as any;
    if (!navGranted) {
      // /crm-calls/guests supersedes the legacy "Guests & Loyalty" (/crm/guests).
      // '/crm/guests' is NOT a substring of '/crm-calls/guests', so the
      // quoted-element LIKE is exact. NULL page_access (= full access) untouched.
      for (const tbl of ['roles', 'users']) {
        db.prepare(
          `UPDATE ${tbl}
             SET page_access = json_insert(page_access, '$[#]', '/crm-calls/guests')
           WHERE page_access IS NOT NULL
             AND json_valid(page_access)
             AND page_access LIKE '%"/crm/guests"%'
             AND page_access NOT LIKE '%"/crm-calls/guests"%'`,
        ).run();
      }
      // The host Seat board sits beside Tables, so whoever runs Tables gets it.
      for (const tbl of ['roles', 'users']) {
        db.prepare(
          `UPDATE ${tbl}
             SET page_access = json_insert(page_access, '$[#]', '/dine-in/reservations')
           WHERE page_access IS NOT NULL
             AND json_valid(page_access)
             AND page_access LIKE '%"/dine-in/tables"%'
             AND page_access NOT LIKE '%"/dine-in/reservations"%'`,
        ).run();
      }
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('nav_continuity_grants_v1', '1')").run();
    }
  } catch (e) { console.error('nav-continuity page_access migration failed:', e); }

  // Mark the linked_po_id column on purchase_orders so we can navigate from PO → Requisition
  try {
    const cols = db.prepare("PRAGMA table_info(purchase_orders)").all() as any[];
    if (!cols.some((c: any) => c.name === 'requisition_id')) {
      db.exec(`ALTER TABLE purchase_orders ADD COLUMN requisition_id TEXT`);
    }
  } catch (e) { console.error('po.requisition_id migration failed:', e); }

  // Expected Delivery Date — the date the VENDOR PROMISED, as distinct from
  // purchase_orders.date, which is the date the PO was raised.
  //
  // Nullable with NO backfill on purpose: every PO written before this column
  // existed genuinely has no promised date, and defaulting it to the order date
  // would fabricate a commitment the vendor never made — which is worse than
  // blank, because an overdue-delivery view would then be built on invented
  // promises. NULL reads as "no promised date" everywhere.
  //
  // Named delivery_date in the DB but labelled "Expected Delivery Date" in the
  // UI: in this domain "delivery" on its own already means the vendor's
  // delivery CHARGE (goods_receipt_note_items.delivery_charges, the PO print
  // page's "Delivery charges" line), so the bare word would read as money.
  try {
    const cols = db.prepare("PRAGMA table_info(purchase_orders)").all() as any[];
    if (!cols.some((c: any) => c.name === 'delivery_date')) {
      db.exec(`ALTER TABLE purchase_orders ADD COLUMN delivery_date TEXT`);
    }
  } catch (e) { console.error('po.delivery_date migration failed:', e); }

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
    // TWO DIFFERENT identifiers per purchase line — do not conflate:
    //   invoice_id — OUR system-generated number (PINV-<year>-####). Auto-assigned
    //                on entry; lines of the SAME vendor bill share one invoice_id.
    //   bill_no    — the VENDOR's own bill/invoice number, as printed on the
    //                physical bill the vendor gives us. Entered by the user.
    // Additive, default '' → every existing row unchanged.
    if (!has('invoice_id'))        db.exec(`ALTER TABLE purchases ADD COLUMN invoice_id TEXT DEFAULT ''`);
    if (!has('bill_no'))           db.exec(`ALTER TABLE purchases ADD COLUMN bill_no TEXT DEFAULT ''`);
    // GRN-Inward-style per-line charges (₹) on a purchase — RECORDED ONLY, they
    // do NOT change unit_price/total_price (the weighted-avg cost basis), and
    // updateMaterialPrice never reads them, so average_price and every recipe
    // cost stay clean. Total Inward Amount = total_price − discount + cgst
    // + sgst + compensation_cess + special_excise_cess + tcs + delivery_charges
    // + mrp_round_off (computed on read — eight terms). All default 0.
    //
    // TWO DIFFERENT CESSES — do not conflate, they are different levies:
    //   compensation_cess   — GST Compensation Cess (GST (Compensation to
    //                         States) Act). Ours: aerated/carbonated beverages
    //                         and tobacco at the bar. Seeded per line from
    //                         raw_materials.cess_percent on the Purchase Entry
    //                         surfaces. NOT part of the CGST/SGST invariant
    //                         (tax_value === cgst + sgst) — cess is a separate
    //                         levy, is never halved, and adding it to that sum
    //                         would overstate GST on a return. Zero on liquor:
    //                         TGBCL lines are zero-rated on our side.
    //   special_excise_cess — TGBCL Special Excise Cess off the liquor store
    //                         bill. Non-creditable landed cost. Every reader
    //                         and label already means exactly this by it, which
    //                         is why compensation cess needed its own column
    //                         rather than sharing this one.
    // The bulk CSV alias chain still maps a bare 'cess'/'CESS' header into
    // special_excise_cess — the TGBCL inward sheets use CESS to mean excise.
    // A compensation-cess CSV must name the column compensation_cess.
    for (const col of ['discount', 'cgst', 'sgst', 'special_excise_cess', 'tcs', 'delivery_charges', 'mrp_round_off', 'compensation_cess']) {
      if (!has(col)) db.exec(`ALTER TABLE purchases ADD COLUMN ${col} REAL NOT NULL DEFAULT 0`);
    }
    // PO QTY from the inward sheet — what the PO asked for, vs `quantity` which
    // is what actually came IN. Record-only (no stock/costing effect); lets the
    // inward register show ordered-vs-received without a linked PO.
    if (!has('po_qty')) db.exec(`ALTER TABLE purchases ADD COLUMN po_qty REAL NOT NULL DEFAULT 0`);
    // The cost row did not know its delivery. A PO receive writes po_vendor_bills
    // + goods_receipt_notes + goods_receipt_note_items + purchases in ONE
    // transaction, and yet the only tie from the purchase back to the GRN was a
    // sentence in purchases.notes ("Received against PO-… (GRN GRN-…)") that
    // purchase-log.ts has to re-parse with a regex.
    //
    // Soft link, deliberately no FK: SQLite cannot ADD one by ALTER, and
    // rebuilding purchases on a live restaurant system to gain a constraint
    // nothing enforces today is not a trade worth making.
    //
    // Populated ONLY where a GRN genuinely exists in scope — the PO receive path
    // and the ad-hoc GRN path. The other purchases writers (direct purchase,
    // opening stock, bulk, inward-import, seed) have no GRN and NULL is the
    // honest value there. NOT backfilled, and purchases.notes keeps its exact
    // wording: it is history, and purchase-log.ts still reads it.
    if (!has('grn_id')) db.exec(`ALTER TABLE purchases ADD COLUMN grn_id TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_purchases_grn ON purchases(grn_id)`);
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

    // GRN Inward financial columns (TGBCL-style inward register) — per LINE ₹
    // amounts captured at receive time. SUBTOTAL = inward qty × rate (computed),
    // TOTAL INWARD AMOUNT = subtotal − discount + cgst + sgst + compensation
    // cess + special excise cess + tcs + delivery + mrp round off (computed on
    // read — eight terms). Only these eight inputs are stored; all default 0 so
    // every existing GRN line is unchanged. RECORDED ONLY: none of them touch
    // unit_price/total_price, so the weighted-average cost and every recipe cost
    // stay clean.
    //
    // TWO DIFFERENT CESSES — the same distinction already drawn on `purchases`
    // above, and for the same reason; do not conflate them, they are different
    // levies:
    //   compensation_cess   — GST Compensation Cess (GST (Compensation to
    //                         States) Act). Seeded per line from
    //                         raw_materials.cess_percent when the material is
    //                         picked on PO Receive and on the ad-hoc GRN, the
    //                         same way tax_percent seeds GST. NOT part of the
    //                         CGST/SGST invariant (tax_value === cgst + sgst) —
    //                         cess is a separate levy, is never halved, and
    //                         adding it to that sum would overstate GST on a
    //                         return. Zero on liquor: store-mapped/TGBCL lines
    //                         are zero-rated on our side, exactly as for GST.
    //   special_excise_cess — TGBCL Special Excise Cess off the liquor store
    //                         bill. Non-creditable landed cost. Every reader and
    //                         label already means exactly this by it, which is
    //                         why compensation cess needed its own column rather
    //                         than sharing this one.
    //
    // THE TWO CESS/GST TAXABLE BASES ARE DELIBERATELY DIFFERENT — a future
    // reader will assume they match and "simplify" one into the other. They do
    // not match, by the owner's ruling:
    //   cgst + sgst are charged on the POST-discount line value (gross − discount)
    //   compensation_cess is charged on the GROSS line value, BEFORE discount
    // e.g. 10 kg @ ₹100 = ₹1,000 with ₹100 discount → GST 18% on ₹900 = ₹162,
    // cess 12% on ₹1,000 = ₹120. Both figures are derived server-side at receive
    // time (the wire carries a cess PERCENT only, never a rupee amount) and only
    // stored here; nothing recomputes them from this row.
    const grniCols = db.prepare("PRAGMA table_info(goods_receipt_note_items)").all() as any[];
    const hasGI = (n: string) => grniCols.some((c: any) => c.name === n);
    for (const col of ['discount', 'cgst', 'sgst', 'special_excise_cess', 'tcs', 'delivery_charges', 'mrp_round_off', 'compensation_cess']) {
      if (!hasGI(col)) db.exec(`ALTER TABLE goods_receipt_note_items ADD COLUMN ${col} REAL NOT NULL DEFAULT 0`);
    }
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
    // When the bill was last printed for this order — highlights the table on the
    // cashier floor as "asked for the bill / about to free up".
    if (!hasOrd('bill_printed_at'))       db.exec(`ALTER TABLE orders ADD COLUMN bill_printed_at TEXT`);
    // CAPTAIN → CASHIER BILL REQUEST (src/lib/bill-request.ts).
    //
    // The captain tablet can no longer take payment: settle and hold are gated
    // by src/lib/settle-authority.ts, so a captain who is not the floor's
    // cashier gets a 403. Its Bill button therefore REQUESTS the bill, and the
    // request surfaces to that floor's cashier as a bell bucket and a marked
    // table on the cashier board.
    //
    // STAMPS ON THE ORDER, NOT A REQUESTS TABLE. Three reasons, all load-bearing:
    //   IDEMPOTENT BY CONSTRUCTION. A stamp is set or it is not, and the writer
    //   is COALESCE(bill_requested_at, datetime('now')), so a captain tapping
    //   Request Bill four times raises exactly one alert. A rows table would
    //   have needed a de-duplicator that could drift.
    //   IT RETIRES ITSELF. Every reader joins orders on status = 'open', so
    //   settling, holding or voiding the bill clears the request with no cleanup
    //   step that a future change could forget to call.
    //   IT RIDES ALONG. /api/dine-in/tables already selects the open order's
    //   columns for the cashier board's "Bill printed" highlight; the marked
    //   table is the same one-line join, not a second query per tile.
    // bill_seen_at is the acknowledgement, written only for someone whose
    // settleAuthority allows that floor — see markBillRequestSeen(). The third
    // state the owner asked for, "settled", is the order leaving status 'open'.
    if (!hasOrd('bill_requested_at'))     db.exec(`ALTER TABLE orders ADD COLUMN bill_requested_at TEXT`);
    if (!hasOrd('bill_requested_by'))     db.exec(`ALTER TABLE orders ADD COLUMN bill_requested_by TEXT DEFAULT ''`);
    if (!hasOrd('bill_seen_at'))          db.exec(`ALTER TABLE orders ADD COLUMN bill_seen_at TEXT`);
    if (!hasOrd('bill_seen_by'))          db.exec(`ALTER TABLE orders ADD COLUMN bill_seen_by TEXT DEFAULT ''`);
    // Bill-on-hold: a finalised bill the cashier parked as UNPAID (status
    // 'on_hold'); it frees the table and shows under Outstanding Payment until
    // settled. held_at = when it was parked.
    if (!hasOrd('held_at'))               db.exec(`ALTER TABLE orders ADD COLUMN held_at TEXT`);
    // IDLE-TABLE SWEEP — why a void happened (src/lib/stale-tables.ts).
    //
    // Open orders accumulate forever: nothing in this app has ever closed one.
    // Measured on the live database 2026-08-12, eleven orders sat 'open' — two
    // of them 765h and 527h old (32 and 22 days), the rest ~17h.
    //
    // The sweep closes only the EMPTY ones (zero order_items): no bill, no
    // money, nothing consumed, so 'void' — "this never happened" — is literally
    // true, and it is the existing status every reader already understands. A
    // table that HAS items is never closed by a timer under any setting; it is
    // only flagged for a human. See the header of stale-tables.ts.
    //
    // NULL for every void a human wrote (including every row that pre-dates
    // this column); 'idle_empty' for one the sweep wrote. That distinction is
    // the whole point of the column: /api/dine-in/kot-analytics and
    // src/lib/sales-dashboard.ts both COUNT and SUM(total) over
    // status = 'void', so without it an automatic close would be
    // indistinguishable from a cashier cancelling a real bill.
    if (!hasOrd('auto_close_reason'))     db.exec(`ALTER TABLE orders ADD COLUMN auto_close_reason TEXT`);
    // How many hours an EMPTY open order may idle before the sweep closes it.
    // 0 = OFF, and OFF is the seeded default: nothing starts closing tables the
    // moment this deploys — the owner turns it on after looking at the list.
    // INSERT OR IGNORE so his chosen value survives every future deploy.
    db.exec(`INSERT OR IGNORE INTO settings (key, value) VALUES ('stale_table_auto_close_hours', '0')`);
    // Per-item prep timer + completion: prep_minutes snapshot from the menu item,
    // fired_at when it went to the kitchen (timer start), completed_at when the
    // captain marks it received. Bill is gated until every fired item completes.
    if (!oiCols.some((c: any) => c.name === 'prep_minutes')) db.exec(`ALTER TABLE order_items ADD COLUMN prep_minutes INTEGER NOT NULL DEFAULT 0`);
    if (!oiCols.some((c: any) => c.name === 'fired_at'))     db.exec(`ALTER TABLE order_items ADD COLUMN fired_at TEXT`);
    if (!oiCols.some((c: any) => c.name === 'completed_at')) db.exec(`ALTER TABLE order_items ADD COLUMN completed_at TEXT`);
    // Item barcode tracking (leak-proof serving): kitchen_sent_at = when the
    // kitchen supervisor SCANNED this item's sticker out of the kitchen; served_at
    // = when its KOT was bumped 'served' on the KDS. These are purely additive
    // tracking stamps — the stock-deduction trigger (kds bump, gated on
    // recipe_deducted_at) and the bill gate (completed_at) are untouched. The
    // item journey is created_at(punch) → fired_at → kitchen_sent_at → completed_at(received).
    if (!oiCols.some((c: any) => c.name === 'kitchen_sent_at')) db.exec(`ALTER TABLE order_items ADD COLUMN kitchen_sent_at TEXT`);
    if (!oiCols.some((c: any) => c.name === 'served_at'))       db.exec(`ALTER TABLE order_items ADD COLUMN served_at TEXT`);
    // Short scannable code stamped at fire time; the sticker-KOT QR/barcode
    // encodes it and the Scan-Out screen resolves it back to this item.
    if (!oiCols.some((c: any) => c.name === 'scan_code'))       db.exec(`ALTER TABLE order_items ADD COLUMN scan_code TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_order_items_kitchen_sent ON order_items(kitchen_sent_at)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_order_items_scan_code ON order_items(scan_code)`);
    // UNDO A COMPLETED KOT (owner ruling 2026-08-12) — kots.served_at anchors the
    // window in which the KDS 'Served' bump can still be taken back, and the
    // recipe consumption is DEFERRED until that window closes rather than posted
    // at the bump (src/lib/kot-completion.ts explains why deferring beats
    // reversing). It had to be a new column: kots.updated_at is bumped by the
    // reprint and resend routes, so a re-sent ticket would silently re-open the
    // window, and created_at is the FIRE time. NULL means "never served through
    // the KDS bump" — every historical row, and every ticket the offline replay
    // writes straight to 'served', so neither is ever swept or undoable.
    if (!kCols.some((c: any) => c.name === 'served_at')) db.exec(`ALTER TABLE kots ADD COLUMN served_at TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_kots_served_at ON kots(served_at)`);
    // The window itself, in seconds. 10 is what the owner asked for; the Kitchen
    // Display lets a manager change it (0 = no undo, consume inline as before).
    // OR IGNORE so a tuned value survives every future deploy.
    db.exec(`INSERT OR IGNORE INTO settings (key, value) VALUES ('kot_undo_window_seconds', '10')`);
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

    // restaurant_tables.section — free-text section code (e.g. "FA", "SA") within
    // a floor (zone). Floor→Section→Table hierarchy: `zone` is the floor, `section`
    // groups tables inside it, `table_number` is the full label (e.g. "FA1").
    try {
      const rtCols2 = db.prepare("PRAGMA table_info(restaurant_tables)").all() as any[];
      if (!rtCols2.some((x: any) => x.name === 'section')) {
        db.exec("ALTER TABLE restaurant_tables ADD COLUMN section TEXT NOT NULL DEFAULT ''");
      }
    } catch (e) { console.error('restaurant_tables section migration failed:', e); }

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

    // Service-request CLOSE TRAIL. A close that nobody typed has to say why, and
    // it must NOT borrow completed_at / completed_by: /api/dine-in/captain-
    // performance averages attend time by completed_by and counts a request with
    // no accepted_at and no completed_at as "unattended". Writing an automatic
    // close into those columns would credit whoever settled the bill with
    // attending every open bell at that table. So the automatic paths move only
    // the status column and these three, and every captain-performance number
    // keeps meaning exactly what it means today.
    //   outcome       — '' (still open, or a legacy row) | attended | not_attended | expired
    //   closed_reason — captain | bill-settled | stale-timeout
    //   closed_at     — when the close was written. Audit only; no UI reads it,
    //                   and it is the ONLY timestamp an automatic close leaves.
    try {
      const srCols = db.prepare("PRAGMA table_info(service_requests)").all() as any[];
      const srHas = (n: string) => srCols.some((x: any) => x.name === n);
      if (!srHas('outcome'))       db.exec("ALTER TABLE service_requests ADD COLUMN outcome TEXT DEFAULT ''");
      if (!srHas('closed_reason')) db.exec("ALTER TABLE service_requests ADD COLUMN closed_reason TEXT DEFAULT ''");
      if (!srHas('closed_at'))     db.exec("ALTER TABLE service_requests ADD COLUMN closed_at TEXT");
    } catch (e) { console.error('service_requests close-trail migration failed:', e); }

    // Safety net for a table that never bills (a walk-out): auto-close a service
    // request that has sat open this many minutes. 0 = OFF, and OFF is the
    // default — settling the table's bill already closes its open bells, so the
    // timeout only has to catch the tables that never reach a bill. Seeded with
    // INSERT OR IGNORE so an admin's chosen value survives every deploy.
    db.exec("INSERT OR IGNORE INTO settings (key, value) VALUES ('service_request_auto_close_minutes', '0')");

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
    // Print-agent (dispatcher) heartbeat — one row per outlet. Lets the Kitchen
    // board tell "a dispatcher is alive and sending KOTs to the printers" apart
    // from the bridge PROCESS being up. See src/lib/print-agent.ts.
    db.exec(`
      CREATE TABLE IF NOT EXISTS print_agent_heartbeat (
        outlet_id  TEXT PRIMARY KEY,            -- '' for the NULL/default outlet
        last_seen  TEXT NOT NULL,
        bridge_ok  INTEGER NOT NULL DEFAULT 0,  -- was the local bridge healthy at the last ping
        agent_url  TEXT DEFAULT '',
        user_agent TEXT DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      -- Hot-path indexes: getPrintAgentStatus (recent-fire count) runs on every
      -- kitchen poll; the KOT-alert sweep + auto-resolve probe print_jobs by
      -- ref_id. Both tables grow unbounded, so keep these scans off full-table.
      CREATE INDEX IF NOT EXISTS idx_kots_created ON kots(created_at);
      CREATE INDEX IF NOT EXISTS idx_print_jobs_ref ON print_jobs(ref_id);
      -- Sales-dashboard filters settled/void orders by IST calendar day via
      -- date(settled_at,'+330 minutes'); expression+partial indexes let those
      -- range scans prune to the requested days instead of scanning all history.
      CREATE INDEX IF NOT EXISTS idx_orders_settled_ist
        ON orders(date(settled_at, '+330 minutes')) WHERE status = 'settled';
      CREATE INDEX IF NOT EXISTS idx_orders_void_ist
        ON orders(date(COALESCE(voided_at, updated_at), '+330 minutes')) WHERE status = 'void';
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
    // Priority stars — 3 = critical / 2 = standard / 1 = low (values 1-3 only).
    // Drives tiered low-stock alerting: the notification bell + WhatsApp daily
    // low-stock job count 3★ items ONLY; store-dashboard / smart-reorder group
    // and pre-tick by stars. Default 2 keeps all 1000+ existing materials at
    // "standard" until someone deliberately promotes/demotes them.
    if (!has('priority'))               db.exec(`ALTER TABLE raw_materials ADD COLUMN priority INTEGER NOT NULL DEFAULT 2`);
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

  // ── AKAN CRM (ported from the standalone Flask app) ───────────────────────
  // AI assistant / training / quiz / guest-quiz for the Front Office & GRE team.
  // Users are THIS app's users (users.id TEXT) — the Flask app's own users table
  // (and its plaintext-password column) is deliberately NOT ported.
  // Seeds below fire ONLY when a table/section is EMPTY — a deploy can never
  // overwrite live CRM knowledge or the question bank (deploy-safety rule).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS crm_chat_sessions (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL,
        title       TEXT DEFAULT '',
        mode        TEXT NOT NULL DEFAULT 'assistant',   -- assistant | training
        status      TEXT NOT NULL DEFAULT 'active',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS idx_crm_chat_sessions_user ON crm_chat_sessions(user_id, mode);

      CREATE TABLE IF NOT EXISTS crm_messages (
        id               TEXT PRIMARY KEY,
        session_id       TEXT NOT NULL,
        role             TEXT NOT NULL,                  -- user | assistant
        content          TEXT NOT NULL,
        response_time_ms INTEGER,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (session_id) REFERENCES crm_chat_sessions(id)
      );
      CREATE INDEX IF NOT EXISTS idx_crm_messages_session ON crm_messages(session_id);

      CREATE TABLE IF NOT EXISTS crm_training_sessions (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL,
        chat_session_id TEXT,
        difficulty      TEXT NOT NULL DEFAULT 'medium',
        category        TEXT NOT NULL DEFAULT 'general',
        language        TEXT NOT NULL DEFAULT 'english',
        status          TEXT NOT NULL DEFAULT 'active',  -- active | completed | abandoned
        questions_asked INTEGER NOT NULL DEFAULT 0,
        total_score     REAL NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at    TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS idx_crm_training_user ON crm_training_sessions(user_id);

      CREATE TABLE IF NOT EXISTS crm_training_responses (
        id                  TEXT PRIMARY KEY,
        training_session_id TEXT NOT NULL,
        question_number     INTEGER NOT NULL,
        question            TEXT NOT NULL,
        user_response       TEXT NOT NULL,
        score               REAL NOT NULL DEFAULT 0,
        feedback            TEXT DEFAULT '',              -- JSON evaluation blob
        ideal_answer        TEXT DEFAULT '',
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (training_session_id) REFERENCES crm_training_sessions(id)
      );
      CREATE INDEX IF NOT EXISTS idx_crm_training_resp ON crm_training_responses(training_session_id);

      CREATE TABLE IF NOT EXISTS crm_quiz_sessions (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL,
        category        TEXT NOT NULL DEFAULT 'all',
        difficulty      TEXT NOT NULL DEFAULT 'medium',
        language        TEXT NOT NULL DEFAULT 'english',
        source          TEXT NOT NULL DEFAULT 'bank',     -- bank | ai
        questions_json  TEXT NOT NULL DEFAULT '[]',
        total_questions INTEGER NOT NULL DEFAULT 0,
        score           INTEGER NOT NULL DEFAULT 0,
        status          TEXT NOT NULL DEFAULT 'active',
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at    TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS idx_crm_quiz_user ON crm_quiz_sessions(user_id);

      CREATE TABLE IF NOT EXISTS crm_quiz_responses (
        id              TEXT PRIMARY KEY,
        quiz_session_id TEXT NOT NULL,
        question_number INTEGER NOT NULL,
        question        TEXT NOT NULL,
        options_json    TEXT NOT NULL DEFAULT '[]',
        correct_index   INTEGER NOT NULL DEFAULT 0,
        selected_index  INTEGER,
        is_correct      INTEGER NOT NULL DEFAULT 0,
        explanation     TEXT DEFAULT '',
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (quiz_session_id) REFERENCES crm_quiz_sessions(id)
      );
      CREATE INDEX IF NOT EXISTS idx_crm_quiz_resp ON crm_quiz_responses(quiz_session_id);

      CREATE TABLE IF NOT EXISTS crm_cheat_logs (
        id              TEXT PRIMARY KEY,
        user_id         TEXT,
        quiz_session_id TEXT,
        cheat_type      TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS crm_question_bank (
        id            TEXT PRIMARY KEY,
        category      TEXT NOT NULL DEFAULT '',
        subcategory   TEXT DEFAULT '',
        difficulty    TEXT NOT NULL DEFAULT 'medium',
        question      TEXT NOT NULL,
        options_json  TEXT NOT NULL DEFAULT '[]',
        correct_index INTEGER NOT NULL DEFAULT 0,
        explanation   TEXT DEFAULT '',
        is_active     INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_crm_qbank_cat ON crm_question_bank(category, difficulty);

      CREATE TABLE IF NOT EXISTS crm_user_seen_questions (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL,
        question_id TEXT NOT NULL,
        was_correct INTEGER,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_crm_seen_user ON crm_user_seen_questions(user_id);

      CREATE TABLE IF NOT EXISTS crm_quiz_links (
        id             TEXT PRIMARY KEY,
        link_code      TEXT NOT NULL UNIQUE,
        title          TEXT NOT NULL DEFAULT 'AKAN Staff Quiz',
        difficulty     TEXT NOT NULL DEFAULT 'medium',
        question_count INTEGER NOT NULL DEFAULT 10,
        pass_threshold INTEGER NOT NULL DEFAULT 60,
        max_attempts   INTEGER NOT NULL DEFAULT 100,
        attempt_count  INTEGER NOT NULL DEFAULT 0,
        expires_at     TEXT,
        is_active      INTEGER NOT NULL DEFAULT 1,
        created_by     TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS crm_guest_quiz_sessions (
        id                 TEXT PRIMARY KEY,
        link_id            TEXT NOT NULL,
        guest_name         TEXT NOT NULL DEFAULT '',
        guest_mobile       TEXT NOT NULL DEFAULT '',
        guest_position     TEXT NOT NULL DEFAULT '',
        questions_json     TEXT NOT NULL DEFAULT '[]',
        total_questions    INTEGER NOT NULL DEFAULT 0,
        score              INTEGER NOT NULL DEFAULT 0,
        status             TEXT NOT NULL DEFAULT 'active', -- active | completed | cheated
        time_taken_seconds INTEGER,
        started_at         TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at       TEXT,
        FOREIGN KEY (link_id) REFERENCES crm_quiz_links(id)
      );
      CREATE INDEX IF NOT EXISTS idx_crm_guest_link ON crm_guest_quiz_sessions(link_id);

      CREATE TABLE IF NOT EXISTS crm_guest_quiz_responses (
        id               TEXT PRIMARY KEY,
        guest_session_id TEXT NOT NULL,
        question_number  INTEGER NOT NULL,
        question         TEXT NOT NULL,
        options_json     TEXT NOT NULL DEFAULT '[]',
        correct_index    INTEGER NOT NULL DEFAULT 0,
        selected_index   INTEGER,
        is_correct       INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (guest_session_id) REFERENCES crm_guest_quiz_sessions(id)
      );

      -- Knowledge base: one row per section (venue_info, policies, events,
      -- menu_info, call_scripts, custom_faqs). content = the section's JSON.
      CREATE TABLE IF NOT EXISTS crm_knowledge (
        section    TEXT PRIMARY KEY,
        content    TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_by TEXT DEFAULT ''
      );
    `);

    // Seed question bank + knowledge from the bundled Flask-app export, ONLY
    // when empty/missing (a redeploy can never clobber live edits). Files live
    // in src/data/crm/ (committed); loaded lazily so the middleware bundle
    // doesn't swell.
    const qn = (db.prepare(`SELECT COUNT(*) AS n FROM crm_question_bank`).get() as any).n;
    if (qn === 0) {
      try {
        const fs = require('fs');
        const path = require('path');
        const file = path.join(process.cwd(), 'src', 'data', 'crm', 'question-bank.json');
        if (fs.existsSync(file)) {
          const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
          const ins = db.prepare(`
            INSERT INTO crm_question_bank (id, category, subcategory, difficulty, question, options_json, correct_index, explanation)
            VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?)
          `);
          const tx = db.transaction((all: any[]) => {
            for (const r of all) ins.run(r.category || '', r.subcategory || '', r.difficulty || 'medium', r.question, r.options_json || '[]', r.correct_index ?? 0, r.explanation || '');
          });
          tx(rows);
          console.log(`[crm] seeded question bank: ${rows.length} questions`);
        }
      } catch (e) { console.error('crm question bank seed failed:', e); }
    }
    try {
      const fs = require('fs');
      const path = require('path');
      const dir = path.join(process.cwd(), 'src', 'data', 'crm');
      const SECTIONS = ['venue_info', 'policies', 'events', 'menu_info', 'call_scripts', 'custom_faqs'];
      const insKb = db.prepare(`INSERT OR IGNORE INTO crm_knowledge (section, content) VALUES (?, ?)`);
      for (const s of SECTIONS) {
        const f = path.join(dir, `${s}.json`);
        if (fs.existsSync(f)) insKb.run(s, fs.readFileSync(f, 'utf8'));
      }
    } catch (e) { console.error('crm knowledge seed failed:', e); }
  } catch (e) { console.error('crm schema failed:', e); }

  // ── AKAN CRM — Daily Digest (additive) ─────────────────────────────────────
  // One AI-written owner briefing per calendar day (/crm/digest). Regenerating
  // upserts the same row; data_json keeps the exact data pack the LLM saw.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS crm_digests (
        digest_date  TEXT PRIMARY KEY,                       -- YYYY-MM-DD
        content      TEXT NOT NULL,                          -- markdown briefing
        data_json    TEXT DEFAULT '{}',
        generated_at TEXT DEFAULT (datetime('now')),
        generated_by TEXT DEFAULT ''
      );
    `);
  } catch (e) { console.error('crm_digests schema failed:', e); }

  // ── WhatsApp Integration ───────────────────────────────────────────────────
  // Configuration + template + event-log foundation for the WhatsApp module
  // (/settings/integrations/whatsapp). Purely additive. No live Business-API
  // traffic happens until an admin configures a provider; the existing wa.me
  // review-request links elsewhere are untouched.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS whatsapp_templates (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL UNIQUE,
        category   TEXT NOT NULL DEFAULT 'general',   -- notification | marketing | approval | general
        language   TEXT NOT NULL DEFAULT 'en',
        body       TEXT NOT NULL,                     -- supports {{placeholder}} vars
        is_active  INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS whatsapp_events_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        kind       TEXT NOT NULL DEFAULT '',          -- 'webhook' | 'send' | future event kinds
        payload    TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT OR IGNORE INTO settings (key, value) VALUES ('wa_api_provider', 'meta_cloud');
      INSERT OR IGNORE INTO settings (key, value) VALUES ('wa_phone_number_id', '');
      INSERT OR IGNORE INTO settings (key, value) VALUES ('wa_business_account_id', '');
      INSERT OR IGNORE INTO settings (key, value) VALUES ('wa_access_token', '');
      INSERT OR IGNORE INTO settings (key, value) VALUES ('wa_webhook_verify_token', '');
      INSERT OR IGNORE INTO settings (key, value) VALUES ('wa_notifications_enabled', '0');
      INSERT OR IGNORE INTO settings (key, value) VALUES ('wa_notify_recipients', '{}');
    `);
    // Default notification templates — one per notify event, looked up BY NAME
    // (convention: whatsapp_templates.name === event key) by notifyEvent() in
    // lib/whatsapp.ts. INSERT OR IGNORE: admin edits in the Templates tab are
    // never overwritten. Bodies mirror WA_DEFAULT_EVENT_BODIES (the code-side
    // fallback used if a template is deleted or deactivated).
    db.exec(`
      INSERT OR IGNORE INTO whatsapp_templates (id, name, category, language, body) VALUES
        ('watpl_requisition_approved', 'requisition_approved', 'notification', 'en',
         '✅ Requisition {{req_number}} ({{department}}) has been approved by {{approved_by}}.'),
        ('watpl_discount_decided', 'discount_decided', 'notification', 'en',
         'Discount request for order #{{order}} — {{pct}}% {{decision}} by {{decided_by}}.'),
        ('watpl_low_stock_daily', 'low_stock_daily', 'notification', 'en',
         '📦 Low-stock summary ({{date}}) — {{count}} material(s) to reorder:' || char(10) || '{{summary}}'),
        ('watpl_digest_daily', 'digest_daily', 'notification', 'en',
         '📋 AKAN Daily Digest — {{date}}' || char(10) || char(10) || '{{content}}');
    `);
  } catch (e) { console.error('whatsapp schema failed:', e); }

  // Migration: extend whatsapp_templates for Meta-approved template sends +
  // multi-provider (Meta Cloud / Interakt). Free-form text only delivers inside
  // the 24h window; these columns let a template map to its provider-approved
  // template + positional param order so notifyEvent() can send anytime.
  try {
    const cols = db.prepare("PRAGMA table_info(whatsapp_templates)").all() as any[];
    const has = (n: string) => cols.some((c: any) => c.name === n);
    if (!has('provider_template_name')) db.exec(`ALTER TABLE whatsapp_templates ADD COLUMN provider_template_name TEXT DEFAULT ''`); // exact approved name at the provider
    if (!has('provider_language'))      db.exec(`ALTER TABLE whatsapp_templates ADD COLUMN provider_language TEXT DEFAULT ''`);      // e.g. 'en_US' (Meta) / 'en' (Interakt); empty → fall back to language
    if (!has('param_order'))            db.exec(`ALTER TABLE whatsapp_templates ADD COLUMN param_order TEXT DEFAULT ''`);            // JSON array of var names in {{1}},{{2}}… order; empty → WA_EVENT_PARAM_ORDER
    if (!has('send_as_template'))       db.exec(`ALTER TABLE whatsapp_templates ADD COLUMN send_as_template INTEGER NOT NULL DEFAULT 0`); // 1 → send via provider template API, not free-form text
  } catch (e) { console.error('whatsapp_templates template-send migration failed:', e); }

  // Interakt provider API key (Basic-auth secret, used AS-IS). Additive seed.
  try {
    db.exec(`INSERT OR IGNORE INTO settings (key, value) VALUES ('wa_interakt_api_key', '')`);
  } catch (e) { console.error('wa_interakt_api_key seed failed:', e); }

  // ── AKAN CRM — Guest Database + Loyalty (additive) ─────────────────────────
  // Guest directory keyed by normalized 10-digit mobile (/crm/guests). Visits
  // append to crm_guest_visits and roll up onto the guest row (visit_count /
  // total_spend / points). Points accrue at `crm_loyalty_points_per_100` pts
  // per ₹100 billed. Tier (Bronze/Silver/Gold) is COMPUTED from points at read
  // time — never stored. POS capture hooks call upsertGuestVisit() in
  // src/lib/crm-guests.ts (wired in a later pass).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS crm_guests (
        id             TEXT PRIMARY KEY,
        name           TEXT DEFAULT '',
        mobile         TEXT NOT NULL UNIQUE,                -- normalized 10-digit
        birthday       TEXT DEFAULT '',                     -- 'YYYY-MM-DD' or 'MM-DD'
        notes          TEXT DEFAULT '',
        first_visit_at TEXT DEFAULT (datetime('now')),
        last_visit_at  TEXT,
        visit_count    INTEGER NOT NULL DEFAULT 0,
        total_spend    REAL NOT NULL DEFAULT 0,
        points         REAL NOT NULL DEFAULT 0,
        is_active      INTEGER NOT NULL DEFAULT 1,
        created_at     TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_crm_guests_mobile ON crm_guests(mobile);

      CREATE TABLE IF NOT EXISTS crm_guest_visits (
        id            TEXT PRIMARY KEY,
        guest_id      TEXT NOT NULL,
        order_id      TEXT DEFAULT '',
        bill_amount   REAL NOT NULL DEFAULT 0,
        points_earned REAL NOT NULL DEFAULT 0,
        visited_at    TEXT DEFAULT (datetime('now')),
        source        TEXT DEFAULT 'pos',                   -- 'pos' | 'manual' | …
        FOREIGN KEY (guest_id) REFERENCES crm_guests(id)
      );
      CREATE INDEX IF NOT EXISTS idx_crm_guest_visits_guest ON crm_guest_visits(guest_id);

      INSERT OR IGNORE INTO settings (key, value) VALUES ('crm_loyalty_points_per_100', '1');
      INSERT OR IGNORE INTO settings (key, value) VALUES ('crm_review_link', '');
    `);
  } catch (e) { console.error('crm_guests schema failed:', e); }

  // ── Remote bill-discount approvals ─────────────────────────────────────────
  // Parallel REQUEST → REMOTE APPROVE path beside the synchronous at-the-till
  // flow (POST /api/dine-in/orders/[id]/discount, which stays unchanged). A
  // cashier files a request; a Manager/Admin/HOD approves it from anywhere via
  // /dine-in/discount-approvals. Approving applies the discount to the order
  // with EXACTLY the same columns/semantics as the sync route.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS discount_requests (
        id            TEXT PRIMARY KEY,
        order_id      TEXT NOT NULL,
        outlet_id     TEXT,
        requested_by  TEXT NOT NULL,                      -- requester's email (like requisitions.drafted_by)
        requested_pct REAL NOT NULL,
        reason        TEXT DEFAULT '',
        status        TEXT NOT NULL DEFAULT 'pending',    -- pending | approved | rejected
        decided_by    TEXT DEFAULT '',                    -- approver's display name (mirrors orders.discount_approved_by)
        decided_note  TEXT DEFAULT '',
        decided_at    TEXT,
        created_at    TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_discount_requests_status ON discount_requests(status);
      CREATE INDEX IF NOT EXISTS idx_discount_requests_order  ON discount_requests(order_id);
    `);
  } catch (e) { console.error('discount_requests schema failed:', e); }

  // ── Cashier console (additive) ───────────────────────────────────────────
  // (1) service-charge waivers ride the SAME approval queue as discounts via a
  //     `kind` column (existing rows default to 'discount'); (2) split payments
  //     are recorded one row per method in order_payments (the sales dashboard's
  //     payment-category breakup reads this when present).
  try {
    const drCols = db.prepare("PRAGMA table_info(discount_requests)").all() as any[];
    if (!drCols.some((c: any) => c.name === 'kind')) {
      db.exec(`ALTER TABLE discount_requests ADD COLUMN kind TEXT NOT NULL DEFAULT 'discount'`);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS order_payments (
        id         TEXT PRIMARY KEY,
        order_id   TEXT NOT NULL,
        outlet_id  TEXT,
        method     TEXT NOT NULL,
        amount     REAL NOT NULL DEFAULT 0,
        created_by TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_order_payments_order ON order_payments(order_id);
    `);
  } catch (e) { console.error('cashier billing schema failed:', e); }

  // ── Customer QR OTP (additive) ───────────────────────────────────────────
  // WhatsApp OTP for QR self-orders: capture a verified mobile before a captain-
  // less order fires, so an abandoned/unpaid bill has a real number to call.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS customer_otps (
        id          TEXT PRIMARY KEY,
        outlet_id   TEXT,
        table_id    TEXT,
        mobile      TEXT NOT NULL,
        code_hash   TEXT NOT NULL,
        attempts    INTEGER NOT NULL DEFAULT 0,
        sent_at     TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at  TEXT NOT NULL,
        verified_at TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_customer_otps_lookup ON customer_otps(table_id, mobile, created_at);
    `);
    // send_failed: the provider REJECTED this code's WhatsApp send (bad token /
    // template). The orders route treats a fresh failed send as "channel down"
    // and falls back to captain approval instead of 428-ing the guest into a
    // verify loop they can never pass.
    const otpCols = db.prepare('PRAGMA table_info(customer_otps)').all() as any[];
    if (!otpCols.some((c: any) => c.name === 'send_failed')) {
      db.exec('ALTER TABLE customer_otps ADD COLUMN send_failed INTEGER NOT NULL DEFAULT 0');
    }
  } catch (e) { console.error('customer_otps schema failed:', e); }

  // ── Multi-Store Inventory Engine — FOUNDATION (Phase A, additive) ─────────
  // Named store locations (first: LIQUOR STORE) that own their own stock,
  // separate from the Central Store. Everything is CONFIG, zero hardcoding:
  // a future Wine Cellar / Beer Store / Mini Bar is just a new store_locations
  // row + category mappings + user grants — no code change.
  //
  //   store_locations    — the store master (name/code/active/authorization)
  //   store_category_map — which raw_materials.category values BELONG to a
  //                        store (COLLATE NOCASE; matched with TRIM everywhere)
  //   store_user_access  — per-user permission grants ("Authorized Liquor
  //                        Users"): view / procure / adjust / close-stock
  //   store_stock_ledger — the SINGLE SOURCE OF TRUTH for per-store stock.
  //                        Signed quantities in RECIPE units; current stock per
  //                        material = SUM(quantity). raw_materials.current_stock
  //                        is NOT touched by this module.
  //
  // ⚠️ GUARD NOTE (Phase B wires enforcement): store-mapped materials (e.g.
  // liquor) must eventually be BLOCKED from Central Store flows (purchases /
  // GRN / requisition issue). Phase A only ships the detection helpers
  // (isStoreMappedMaterial / storeGuardWarning in src/lib/store-engine.ts) —
  // NO existing flow changes behaviour yet.
  //
  // Seeds are INSERT OR IGNORE — a redeploy can never clobber admin edits.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS store_locations (
        id                     TEXT PRIMARY KEY,
        name                   TEXT UNIQUE NOT NULL,
        code                   TEXT DEFAULT '',
        description            TEXT DEFAULT '',
        is_active              INTEGER NOT NULL DEFAULT 1,
        requires_authorization INTEGER NOT NULL DEFAULT 1,
        created_at             TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS store_category_map (
        id         TEXT PRIMARY KEY,
        store_id   TEXT NOT NULL,
        category   TEXT NOT NULL COLLATE NOCASE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(store_id, category),
        FOREIGN KEY (store_id) REFERENCES store_locations(id)
      );

      CREATE TABLE IF NOT EXISTS store_user_access (
        id              TEXT PRIMARY KEY,
        store_id        TEXT NOT NULL,
        user_id         TEXT NOT NULL,
        can_view        INTEGER NOT NULL DEFAULT 1,
        can_procure     INTEGER NOT NULL DEFAULT 0,
        can_adjust      INTEGER NOT NULL DEFAULT 0,
        can_close_stock INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(store_id, user_id),
        FOREIGN KEY (store_id) REFERENCES store_locations(id),
        FOREIGN KEY (user_id)  REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS store_stock_ledger (
        id          TEXT PRIMARY KEY,
        store_id    TEXT NOT NULL,
        material_id TEXT NOT NULL,
        txn_type    TEXT NOT NULL,             -- opening|purchase|inward|outward|adjustment|closing|transfer
        quantity    REAL NOT NULL,             -- RECIPE units, signed (+in / -out)
        unit_cost   REAL DEFAULT 0,            -- ₹ per recipe unit at txn time
        batch_no    TEXT DEFAULT '',
        supplier    TEXT DEFAULT '',
        vendor_id   TEXT DEFAULT '',
        expiry_date TEXT DEFAULT '',
        ref         TEXT DEFAULT '',           -- PO no / invoice no / party id …
        notes       TEXT DEFAULT '',
        created_by  TEXT DEFAULT '',           -- actor email
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (store_id)    REFERENCES store_locations(id),
        FOREIGN KEY (material_id) REFERENCES raw_materials(id)
      );
      CREATE INDEX IF NOT EXISTS idx_store_ledger_store_material ON store_stock_ledger(store_id, material_id);
      CREATE INDEX IF NOT EXISTS idx_store_ledger_store_created  ON store_stock_ledger(store_id, created_at);

      -- Seed store #1: LIQUOR STORE (name is UNIQUE → OR IGNORE keeps admin edits)
      INSERT OR IGNORE INTO store_locations (id, name, code, description)
      VALUES (lower(hex(randomblob(16))), 'LIQUOR STORE', 'LIQ',
              'Dedicated liquor store — bottles live here, not in the Central Store');
    `);
    // Seed the LIQUOR STORE category mappings (spec list, lowercased). Names
    // that already exist in the raw_materials category vocabulary keep that
    // exact kebab-case spelling (beer, blended-scotch, bourbon, red-wine, rum,
    // single-malt-whiskey, tequila); the rest are seeded as spec'd — matching
    // is COLLATE NOCASE + TRIM everywhere, so spacing/case never matters.
    // (The pre-existing 'bar' category is deliberately NOT auto-seeded: the
    // admin decides on /settings/stores whether 'bar' consumables belong here.)
    const LIQUOR_SEED_CATEGORIES = [
      'aperitif', 'beer', 'blended malt', 'blended-scotch', 'bourbon', 'brandy',
      'gin', 'irish', 'japanese whisky', 'liqueur', 'red-wine', 'rose wine',
      'rum', 'single-malt-whiskey', 'sparkling-wine', 'tennessee whiskey',
      'tequila', 'vermouth', 'vodka', 'whiskey', 'white-wine',
    ];
    const liq = db.prepare(`SELECT id FROM store_locations WHERE TRIM(name) = 'LIQUOR STORE' COLLATE NOCASE`).get() as any;
    if (liq) {
      const insMap = db.prepare(`
        INSERT OR IGNORE INTO store_category_map (id, store_id, category)
        VALUES (lower(hex(randomblob(16))), ?, ?)
      `);
      for (const c of LIQUOR_SEED_CATEGORIES) insMap.run(liq.id, c);
    }
  } catch (e) { console.error('store engine (store_locations/…) schema failed:', e); }

  // ── Store closing counts — Phase C (spec F6, additive) ────────────────────
  // Independent per-store daily physical counts (Liquor Store first). A count
  // NEVER moves stock — rows here are a pure register (system vs physical vs
  // variance snapshot at count time), so closing can't distort the ledger.
  // The optional admin-only "adjust to physical" action posts a regular
  // 'adjustment' ledger row via /api/stores/[id]/closing — this table stays
  // movement-free. UNIQUE(store_id, material_id, date) → same-day recount is
  // an upsert, never a duplicate row. Completely separate from the central
  // closing_stock table — zero interaction with /closing-stock.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS store_closing_counts (
        id             TEXT PRIMARY KEY,
        store_id       TEXT NOT NULL,
        material_id    TEXT NOT NULL,
        date           TEXT NOT NULL,               -- YYYY-MM-DD count date
        system_qty     REAL NOT NULL DEFAULT 0,     -- ledger SUM as-of date (recipe units)
        physical_qty   REAL NOT NULL DEFAULT 0,     -- counted qty (recipe units)
        variance       REAL NOT NULL DEFAULT 0,     -- physical − system
        variance_value REAL NOT NULL DEFAULT 0,     -- variance × weighted-avg ₹/recipe-unit
        counted_by     TEXT DEFAULT '',             -- actor email
        note           TEXT DEFAULT '',
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(store_id, material_id, date),
        FOREIGN KEY (store_id)    REFERENCES store_locations(id),
        FOREIGN KEY (material_id) REFERENCES raw_materials(id)
      );
      CREATE INDEX IF NOT EXISTS idx_store_closing_store_date ON store_closing_counts(store_id, date);
    `);
  } catch (e) { console.error('store_closing_counts schema failed:', e); }

  // ── Store→Store transfers (Multi-floor bar, Phase 1, additive) ────────────
  // A REQUISITION/TRANSFER header + its line items moving stock between two
  // store_locations (central LIQUOR STORE → floor bars). Lifecycle:
  //   requested → issued → received   (or requested → cancelled)
  // NO stock moves live here — the header/items are a workflow register. The
  // actual stock movement is TWO signed store_stock_ledger rows (txn_type
  // 'transfer', ref = transfer id): a NEGATIVE row on the FROM store at ISSUE
  // and a POSITIVE row on the TO store at RECEIVE (see store-engine.ts
  // issueTransfer / receiveTransfer). In-transit = qty_issued − qty_received;
  // per-item discrepancy (loss in transit) = qty_issued − qty_received. The
  // from-store weighted-avg unit_cost rides the ledger rows so valuation
  // follows the stock. Purely additive — no existing table is touched.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS store_transfers (
        id           TEXT PRIMARY KEY,
        -- NULLABLE for Option B: a from_central transfer sources the CENTRAL
        -- grocery (raw_materials.current_stock) and has NO source store, so it
        -- stores NULL here. NULL is exempt from the FK below; store→store rows
        -- still carry a real, referentially-checked store_locations.id.
        from_store_id TEXT,
        to_store_id   TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'requested',  -- requested|issued|received|cancelled
        note          TEXT DEFAULT '',
        requested_by  TEXT DEFAULT '',                    -- actor email
        requested_at  TEXT,
        issued_by     TEXT DEFAULT '',
        issued_at     TEXT,
        received_by   TEXT DEFAULT '',
        received_at   TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (from_store_id) REFERENCES store_locations(id),
        FOREIGN KEY (to_store_id)   REFERENCES store_locations(id)
      );

      CREATE TABLE IF NOT EXISTS store_transfer_items (
        id            TEXT PRIMARY KEY,
        transfer_id   TEXT NOT NULL,
        material_id   TEXT NOT NULL,
        qty_requested REAL NOT NULL DEFAULT 0,   -- recipe units
        qty_issued    REAL NOT NULL DEFAULT 0,   -- recipe units (set at issue)
        qty_received  REAL NOT NULL DEFAULT 0,   -- recipe units (set at receive)
        note          TEXT DEFAULT '',
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (transfer_id) REFERENCES store_transfers(id),
        FOREIGN KEY (material_id) REFERENCES raw_materials(id)
      );

      CREATE INDEX IF NOT EXISTS idx_store_transfers_status ON store_transfers(status);
      CREATE INDEX IF NOT EXISTS idx_store_transfers_from   ON store_transfers(from_store_id);
      CREATE INDEX IF NOT EXISTS idx_store_transfers_to     ON store_transfers(to_store_id);
      CREATE INDEX IF NOT EXISTS idx_store_transfer_items_transfer ON store_transfer_items(transfer_id);
    `);
    // Multi-floor bar Option B (grocery→floor bridge, additive): a transfer may
    // source from the CENTRAL grocery (raw_materials.current_stock) instead of a
    // store_location. When from_central=1, from_store_id is empty/ignored and
    // issueTransfer debits raw_materials.current_stock + writes an
    // inventory_transactions row (see store-engine.ts). Default 0 keeps every
    // existing store→store transfer unchanged.
    const stCols = db.prepare("PRAGMA table_info(store_transfers)").all() as any[];
    if (!stCols.some((c: any) => c.name === 'from_central')) {
      db.exec(`ALTER TABLE store_transfers ADD COLUMN from_central INTEGER NOT NULL DEFAULT 0`);
    }
    // Option B migration: a DB created before this change still has
    // from_store_id declared NOT NULL, so a from_central transfer (which must
    // store NULL as its source) fails the constraint. SQLite can't drop NOT
    // NULL via ALTER, so rebuild the table with a NULLABLE from_store_id
    // (following the SQLite safe table-rebuild procedure — foreign_keys OFF
    // around the swap). Guarded on notnull so it runs at most once.
    const fromCol = stCols.find((c: any) => c.name === 'from_store_id');
    if (fromCol && Number(fromCol.notnull) === 1) {
      db.pragma('foreign_keys = OFF');
      const rebuild = db.transaction(() => {
        db.exec(`
          CREATE TABLE store_transfers_ob_new (
            id           TEXT PRIMARY KEY,
            from_store_id TEXT,
            to_store_id   TEXT NOT NULL,
            status        TEXT NOT NULL DEFAULT 'requested',
            note          TEXT DEFAULT '',
            requested_by  TEXT DEFAULT '',
            requested_at  TEXT,
            issued_by     TEXT DEFAULT '',
            issued_at     TEXT,
            received_by   TEXT DEFAULT '',
            received_at   TEXT,
            created_at    TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
            from_central  INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (from_store_id) REFERENCES store_locations(id),
            FOREIGN KEY (to_store_id)   REFERENCES store_locations(id)
          );
          INSERT INTO store_transfers_ob_new
            (id, from_store_id, to_store_id, status, note, requested_by, requested_at,
             issued_by, issued_at, received_by, received_at, created_at, updated_at, from_central)
          SELECT id, from_store_id, to_store_id, status, note, requested_by, requested_at,
             issued_by, issued_at, received_by, received_at, created_at, updated_at, COALESCE(from_central, 0)
          FROM store_transfers;
          DROP TABLE store_transfers;
          ALTER TABLE store_transfers_ob_new RENAME TO store_transfers;
          CREATE INDEX IF NOT EXISTS idx_store_transfers_status ON store_transfers(status);
          CREATE INDEX IF NOT EXISTS idx_store_transfers_from   ON store_transfers(from_store_id);
          CREATE INDEX IF NOT EXISTS idx_store_transfers_to     ON store_transfers(to_store_id);
        `);
      });
      rebuild();
      db.pragma('foreign_keys = ON');
    }
  } catch (e) { console.error('store_transfers schema failed:', e); }

  // ── Store bill charges (TGBCL govt liquor invoice, additive) ──────────────
  // A liquor supplier invoice (esp. the Telangana TGBCL indent) carries, on TOP
  // of the line-item amounts, several bill-level charges that are entered by
  // hand (they vary invoice-to-invoice, no formula): MRP Rounding Off, Bar
  // Excise Turnover Tax, Special Excise Cess and TCS. This table stores ONE row
  // per (store, invoice) capturing those charges plus the two totals:
  //   invoice_value    = Σ line amounts (the bottle cost the ledger already holds)
  //   net_indent_value = invoice_value + the four charges (the true bill total).
  // Per the product decision these charges are recorded at the BILL level only —
  // they do NOT change per-bottle unit_cost in store_stock_ledger (TCS is a
  // recoverable tax; keeping it out of stock valuation is deliberate). The
  // ledger stays the source of truth for stock value; this is the invoice
  // overhead layer surfaced on the bill + in reporting. UNIQUE(store_id,
  // invoice_ref) → re-saving the same invoice upserts, never duplicates.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS store_bill_charges (
        id                  TEXT PRIMARY KEY,
        store_id            TEXT NOT NULL,
        invoice_ref         TEXT NOT NULL,
        supplier            TEXT DEFAULT '',
        date                TEXT DEFAULT '',            -- YYYY-MM-DD bill date
        invoice_value       REAL NOT NULL DEFAULT 0,    -- Σ line amounts at save
        mrp_rounding        REAL NOT NULL DEFAULT 0,
        excise_turnover_tax REAL NOT NULL DEFAULT 0,
        special_excise_cess REAL NOT NULL DEFAULT 0,
        tcs                 REAL NOT NULL DEFAULT 0,
        net_indent_value    REAL NOT NULL DEFAULT 0,    -- invoice_value + 4 charges
        created_by          TEXT DEFAULT '',
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(store_id, invoice_ref),
        FOREIGN KEY (store_id) REFERENCES store_locations(id)
      );
      CREATE INDEX IF NOT EXISTS idx_store_bill_charges_store ON store_bill_charges(store_id, invoice_ref);
    `);
    // GRN-Inward per-line charges on a liquor purchase line (recorded only —
    // never change unit_cost / stock valuation). These four are PER LINE on the
    // ledger; the other four (MRP round-off, excise turnover tax, special excise
    // cess, TCS) stay BILL-level in store_bill_charges and are allocated per line
    // in the inward register. All default 0 → every existing ledger row unchanged.
    const sslCols = db.prepare("PRAGMA table_info(store_stock_ledger)").all() as any[];
    const hasSSL = (n: string) => sslCols.some((c: any) => c.name === n);
    for (const col of ['discount', 'cgst', 'sgst', 'delivery_charges']) {
      if (!hasSSL(col)) db.exec(`ALTER TABLE store_stock_ledger ADD COLUMN ${col} REAL NOT NULL DEFAULT 0`);
    }
  } catch (e) { console.error('store_bill_charges schema failed:', e); }

  // ── Party Menu (manager-enabled LIMITED menu for selected tables, additive) ─
  // A curated subset of à-la-carte items shown ONLY on specific tables' QR menu
  // while ENABLED (e.g. a 10–20 pax party the host wants without costly liquor).
  // A preset = hand-picked menu items (party_menu_items) + assigned tables
  // (party_menu_tables, switchable) + an `enabled` flag a MANAGER flips on. When
  // enabled, the customer menu + order APIs for those tables are restricted to
  // the picked items (see lib/party-menu.ts). `booking_id` optionally links a
  // reservation so the Reservations board can badge "limited menu — contact
  // manager". Purely additive; a table with no enabled party menu is unaffected.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS party_menus (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        note        TEXT DEFAULT '',              -- staff note (guest, "contact manager", …)
        enabled     INTEGER NOT NULL DEFAULT 0,   -- manager toggles this ON
        booking_id  TEXT,                         -- optional ct_bookings link
        outlet_id   TEXT,
        created_by  TEXT DEFAULT '',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS party_menu_items (
        party_menu_id TEXT NOT NULL,
        menu_item_id  TEXT NOT NULL,
        PRIMARY KEY (party_menu_id, menu_item_id),
        FOREIGN KEY (party_menu_id) REFERENCES party_menus(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS party_menu_tables (
        party_menu_id TEXT NOT NULL,
        table_id      TEXT NOT NULL,
        PRIMARY KEY (party_menu_id, table_id),
        FOREIGN KEY (party_menu_id) REFERENCES party_menus(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_party_menu_tables_table ON party_menu_tables(table_id);
      CREATE INDEX IF NOT EXISTS idx_party_menu_items_pm     ON party_menu_items(party_menu_id);
      CREATE INDEX IF NOT EXISTS idx_party_menus_booking     ON party_menus(booking_id);
    `);
  } catch (e) { console.error('party_menus schema failed:', e); }

  // ── Multi-floor bar Phase 2/3 (leak-proof automation, additive) ───────────
  // Three purely-additive pieces, all guarded so a redeploy is a no-op:
  //   1. store_locations.floor_label — a TEXT label (or comma-separated list of
  //      labels) mapping a floor bar store to the restaurant_tables.zone value(s)
  //      its sales come from. Empty by default → no floor attribution, byte-
  //      identical to today. resolveFloorStore() (store-engine.ts) matches a
  //      sale's zone (NOCASE/TRIM) to the active store whose floor_label CSV
  //      contains it. Admin edits it on /settings/stores.
  //   2. bar_empties — a log of non-sale floor stock reductions (empties returned,
  //      breakage, complimentary, spillage). Pure register; a breakage/spillage
  //      row may ALSO post an 'adjustment' ledger row (handled by its API), but
  //      this table itself moves no stock. Feeds the reconciliation report as a
  //      legit non-sale reduction.
  //   3. tm_floor_autodeduct setting — the FAIL-SAFE OPT-IN master switch for
  //      routing a dine-in sale's liquor deduction to the floor store ledger
  //      instead of central raw_materials.current_stock. Default "0" = OFF =
  //      today's exact behaviour (deductInventoryForSale ignores floor routing
  //      unless the setting is "1" AND a caller passes opts.storeId).
  try {
    const slCols = db.prepare("PRAGMA table_info(store_locations)").all() as any[];
    if (!slCols.some((c: any) => c.name === 'floor_label')) {
      db.exec(`ALTER TABLE store_locations ADD COLUMN floor_label TEXT DEFAULT ''`);
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS bar_empties (
        id          TEXT PRIMARY KEY,
        store_id    TEXT NOT NULL,
        material_id TEXT NOT NULL,
        qty         REAL NOT NULL DEFAULT 0,           -- recipe units (magnitude ≥ 0)
        kind        TEXT NOT NULL DEFAULT 'empty',     -- empty|breakage|complimentary|spillage
        note        TEXT DEFAULT '',
        recorded_by TEXT DEFAULT '',                   -- actor email
        date        TEXT NOT NULL,                     -- YYYY-MM-DD (IST) event date
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (store_id)    REFERENCES store_locations(id),
        FOREIGN KEY (material_id) REFERENCES raw_materials(id)
      );
      CREATE INDEX IF NOT EXISTS idx_bar_empties_store_date ON bar_empties(store_id, date);
      CREATE INDEX IF NOT EXISTS idx_bar_empties_material   ON bar_empties(material_id);
    `);

    // Fail-safe master switch — OFF by default so nothing changes until an admin
    // opts in. OR IGNORE never clobbers an admin's chosen value on redeploy.
    db.exec(`INSERT OR IGNORE INTO settings (key, value) VALUES ('tm_floor_autodeduct', '0')`);
  } catch (e) { console.error('multi-floor bar phase 2/3 schema failed:', e); }

  // ── Config-audit fingerprint (evidence instrumentation, 2026-07-13) ────────
  // Prod complaint: "user roles & permission settings change on every deploy."
  // A byte-diff boot test proved the boot path does NOT mutate users/roles, but
  // to catch ANY future mutation WITH a timestamp we fingerprint the permission
  // config (users' tier/role/page map + full roles page maps) on every boot and
  // log every transition. A deploy-boot that logs a change here = real DB
  // mutation; a complaint WITHOUT a log row here = stale cached bundle on the
  // client (hard-refresh fixes it). Purely additive; never blocks boot.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS config_fingerprint_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        old_hash    TEXT,
        new_hash    TEXT NOT NULL,
        changed_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createHash } = require('crypto') as typeof import('crypto');
    const userLines = (db.prepare(`
      SELECT id || '|' || COALESCE(role,'') || '|' || COALESCE(role_id,'') || '|' || COALESCE(page_access,'<NULL>') AS line
      FROM users ORDER BY id
    `).all() as any[]).map(r => r.line);
    const roleLines = (db.prepare(`
      SELECT id || '|' || COALESCE(base_role,'') || '|' || COALESCE(page_access,'<NULL>') AS line
      FROM roles ORDER BY id
    `).all() as any[]).map(r => r.line);
    const fingerprint = createHash('sha256')
      .update(userLines.join('\n') + '\n==ROLES==\n' + roleLines.join('\n'))
      .digest('hex');
    const prev = db.prepare("SELECT value FROM settings WHERE key = 'config_fingerprint'").get() as any;
    if (prev && prev.value !== fingerprint) {
      db.prepare('INSERT INTO config_fingerprint_log (old_hash, new_hash) VALUES (?, ?)')
        .run(prev.value, fingerprint);
      console.log(`[config-audit] users/roles permission config CHANGED since last boot: ${prev.value.slice(0, 12)}… → ${fingerprint.slice(0, 12)}… (see config_fingerprint_log)`);
    }
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('config_fingerprint', ?)").run(fingerprint);
  } catch (e) { console.error('config fingerprint audit failed:', e); }

  // ══════════════════════════════════════════════════════════════════════════
  // TASK MANAGEMENT MODULE (2026-07) — purely additive. All 19 tables + seeds
  // live inside ONE labeled try/catch so any failure here never blocks boot and
  // never touches existing tables. Idempotent: CREATE TABLE/INDEX IF NOT EXISTS,
  // INSERT OR IGNORE, existence-guarded seeds.
  // ══════════════════════════════════════════════════════════════════════════
  try {
    db.exec(`
      -- 1. task_categories
      CREATE TABLE IF NOT EXISTS task_categories (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        color       TEXT NOT NULL DEFAULT '',
        icon        TEXT NOT NULL DEFAULT '',
        sort_order  INTEGER NOT NULL DEFAULT 0,
        is_active   INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- 2. task_departments
      CREATE TABLE IF NOT EXISTS task_departments (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        code        TEXT NOT NULL DEFAULT '',
        is_active   INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- 3. tasks
      CREATE TABLE IF NOT EXISTS tasks (
        id                 TEXT PRIMARY KEY,
        title              TEXT NOT NULL,
        description        TEXT NOT NULL DEFAULT '',
        category           TEXT NOT NULL DEFAULT 'Operations',
        department         TEXT NOT NULL DEFAULT '',
        priority           TEXT NOT NULL DEFAULT 'medium',
        status             TEXT NOT NULL DEFAULT 'draft',
        assignee_email     TEXT NOT NULL DEFAULT '',
        assignee_name      TEXT NOT NULL DEFAULT '',
        created_by         TEXT NOT NULL DEFAULT '',
        due_date           TEXT NOT NULL DEFAULT '',
        due_time           TEXT NOT NULL DEFAULT '',
        estimated_minutes  INTEGER NOT NULL DEFAULT 0,
        parent_task_id     TEXT NOT NULL DEFAULT '',
        recurring_rule_id  TEXT NOT NULL DEFAULT '',
        template_id        TEXT NOT NULL DEFAULT '',
        source             TEXT NOT NULL DEFAULT 'manual',
        checklist_json     TEXT NOT NULL DEFAULT '[]',
        started_at         TEXT,
        paused_at          TEXT,
        completed_at       TEXT,
        approved_at        TEXT,
        approved_by        TEXT,
        is_archived        INTEGER NOT NULL DEFAULT 0,
        sort_order         INTEGER NOT NULL DEFAULT 0,
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status         ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_assignee_email ON tasks(assignee_email);
      CREATE INDEX IF NOT EXISTS idx_tasks_department     ON tasks(department);
      CREATE INDEX IF NOT EXISTS idx_tasks_due_date       ON tasks(due_date);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent         ON tasks(parent_task_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_category       ON tasks(category);

      -- 4. task_assignees
      CREATE TABLE IF NOT EXISTS task_assignees (
        id          TEXT PRIMARY KEY,
        task_id     TEXT NOT NULL,
        user_email  TEXT NOT NULL DEFAULT '',
        user_name   TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_task_assignees_task ON task_assignees(task_id);

      -- 5. task_comments
      CREATE TABLE IF NOT EXISTS task_comments (
        id            TEXT PRIMARY KEY,
        task_id       TEXT NOT NULL,
        author_email  TEXT NOT NULL DEFAULT '',
        author_name   TEXT NOT NULL DEFAULT '',
        body          TEXT NOT NULL DEFAULT '',
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id);

      -- 6. task_attachments
      CREATE TABLE IF NOT EXISTS task_attachments (
        id          TEXT PRIMARY KEY,
        task_id     TEXT NOT NULL,
        comment_id  TEXT NOT NULL DEFAULT '',
        kind        TEXT NOT NULL DEFAULT 'file',
        url         TEXT NOT NULL DEFAULT '',
        filename    TEXT NOT NULL DEFAULT '',
        created_by  TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_task_attachments_task ON task_attachments(task_id);

      -- 7. task_mentions
      CREATE TABLE IF NOT EXISTS task_mentions (
        id               TEXT PRIMARY KEY,
        task_id          TEXT NOT NULL,
        comment_id       TEXT NOT NULL DEFAULT '',
        mentioned_email  TEXT NOT NULL DEFAULT '',
        mentioned_name   TEXT NOT NULL DEFAULT '',
        mentioned_by     TEXT NOT NULL DEFAULT '',
        is_read          INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_task_mentions_email ON task_mentions(mentioned_email);
      CREATE INDEX IF NOT EXISTS idx_task_mentions_task  ON task_mentions(task_id);

      -- 8. task_status_history
      CREATE TABLE IF NOT EXISTS task_status_history (
        id           TEXT PRIMARY KEY,
        task_id      TEXT NOT NULL,
        from_status  TEXT NOT NULL DEFAULT '',
        to_status    TEXT NOT NULL DEFAULT '',
        changed_by   TEXT NOT NULL DEFAULT '',
        note         TEXT NOT NULL DEFAULT '',
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_task_status_history_task ON task_status_history(task_id);

      -- 9. checklist_templates
      CREATE TABLE IF NOT EXISTS checklist_templates (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        role        TEXT NOT NULL DEFAULT '',
        department  TEXT NOT NULL DEFAULT '',
        category    TEXT NOT NULL DEFAULT 'Operations',
        is_active   INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- 10. checklist_items
      CREATE TABLE IF NOT EXISTS checklist_items (
        id             TEXT PRIMARY KEY,
        template_id    TEXT NOT NULL,
        label          TEXT NOT NULL,
        sort_order     INTEGER NOT NULL DEFAULT 0,
        requires_image INTEGER NOT NULL DEFAULT 0,
        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_checklist_items_template ON checklist_items(template_id);

      -- 11. daily_checklist_records
      CREATE TABLE IF NOT EXISTS daily_checklist_records (
        id                TEXT PRIMARY KEY,
        template_id       TEXT NOT NULL DEFAULT '',
        item_id           TEXT NOT NULL DEFAULT '',
        date              TEXT NOT NULL DEFAULT '',
        result            TEXT NOT NULL DEFAULT 'na',
        comment           TEXT NOT NULL DEFAULT '',
        image_url         TEXT NOT NULL DEFAULT '',
        corrective_action TEXT NOT NULL DEFAULT '',
        created_task_id   TEXT NOT NULL DEFAULT '',
        department        TEXT NOT NULL DEFAULT '',
        recorded_by       TEXT NOT NULL DEFAULT '',
        created_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_daily_checklist_records_tpl_date ON daily_checklist_records(template_id, date);
      CREATE INDEX IF NOT EXISTS idx_daily_checklist_records_date     ON daily_checklist_records(date);

      -- 12. maintenance_schedules
      CREATE TABLE IF NOT EXISTS maintenance_schedules (
        id                  TEXT PRIMARY KEY,
        name                TEXT NOT NULL,
        category            TEXT NOT NULL DEFAULT 'Maintenance',
        frequency           TEXT NOT NULL DEFAULT 'daily',
        department          TEXT NOT NULL DEFAULT 'Maintenance',
        assignee_email      TEXT NOT NULL DEFAULT '',
        next_due_date       TEXT NOT NULL DEFAULT '',
        last_generated_date TEXT NOT NULL DEFAULT '',
        is_active           INTEGER NOT NULL DEFAULT 1,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- 13. maintenance_logs
      CREATE TABLE IF NOT EXISTS maintenance_logs (
        id           TEXT PRIMARY KEY,
        schedule_id  TEXT NOT NULL,
        task_id      TEXT NOT NULL DEFAULT '',
        performed_by TEXT NOT NULL DEFAULT '',
        performed_at TEXT NOT NULL DEFAULT '',
        status       TEXT NOT NULL DEFAULT 'done',
        notes        TEXT NOT NULL DEFAULT '',
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_maintenance_logs_schedule ON maintenance_logs(schedule_id);

      -- 14. hygiene_audits
      CREATE TABLE IF NOT EXISTS hygiene_audits (
        id                TEXT PRIMARY KEY,
        area              TEXT NOT NULL DEFAULT '',
        item              TEXT NOT NULL DEFAULT '',
        date              TEXT NOT NULL DEFAULT '',
        result            TEXT NOT NULL DEFAULT 'na',
        image_url         TEXT NOT NULL DEFAULT '',
        corrective_action TEXT NOT NULL DEFAULT '',
        created_task_id   TEXT NOT NULL DEFAULT '',
        score             REAL NOT NULL DEFAULT 0,
        auditor           TEXT NOT NULL DEFAULT '',
        created_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_hygiene_audits_area_date ON hygiene_audits(area, date);
      CREATE INDEX IF NOT EXISTS idx_hygiene_audits_date      ON hygiene_audits(date);

      -- 15. training_sessions
      CREATE TABLE IF NOT EXISTS training_sessions (
        id               TEXT PRIMARY KEY,
        title            TEXT NOT NULL,
        trainer          TEXT NOT NULL DEFAULT '',
        department       TEXT NOT NULL DEFAULT '',
        session_date     TEXT NOT NULL DEFAULT '',
        duration_minutes INTEGER NOT NULL DEFAULT 0,
        attendees_json   TEXT NOT NULL DEFAULT '[]',
        status           TEXT NOT NULL DEFAULT 'scheduled',
        feedback         TEXT NOT NULL DEFAULT '',
        created_by       TEXT NOT NULL DEFAULT '',
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- 16. knowledge_tests
      CREATE TABLE IF NOT EXISTS knowledge_tests (
        id                 TEXT PRIMARY KEY,
        title              TEXT NOT NULL,
        description        TEXT NOT NULL DEFAULT '',
        questions_json     TEXT NOT NULL DEFAULT '[]',
        time_limit_minutes INTEGER NOT NULL DEFAULT 0,
        pass_score         INTEGER NOT NULL DEFAULT 60,
        is_active          INTEGER NOT NULL DEFAULT 1,
        created_by         TEXT NOT NULL DEFAULT '',
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- 17. knowledge_test_results
      CREATE TABLE IF NOT EXISTS knowledge_test_results (
        id           TEXT PRIMARY KEY,
        test_id      TEXT NOT NULL,
        user_email   TEXT NOT NULL DEFAULT '',
        user_name    TEXT NOT NULL DEFAULT '',
        score        REAL NOT NULL DEFAULT 0,
        answers_json TEXT NOT NULL DEFAULT '[]',
        passed       INTEGER NOT NULL DEFAULT 0,
        reviewed     INTEGER NOT NULL DEFAULT 0,
        taken_at     TEXT NOT NULL DEFAULT '',
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_test_results_test ON knowledge_test_results(test_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_test_results_user ON knowledge_test_results(user_email);

      -- 18. task_notifications
      CREATE TABLE IF NOT EXISTS task_notifications (
        id               TEXT PRIMARY KEY,
        recipient_email  TEXT NOT NULL DEFAULT '',
        kind             TEXT NOT NULL DEFAULT '',
        title            TEXT NOT NULL DEFAULT '',
        body             TEXT NOT NULL DEFAULT '',
        task_id          TEXT NOT NULL DEFAULT '',
        href             TEXT NOT NULL DEFAULT '',
        is_read          INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_task_notifications_recipient ON task_notifications(recipient_email, is_read);

      -- 19. task_approvals
      CREATE TABLE IF NOT EXISTS task_approvals (
        id             TEXT PRIMARY KEY,
        task_id        TEXT NOT NULL,
        requested_by   TEXT NOT NULL DEFAULT '',
        approver_email TEXT NOT NULL DEFAULT '',
        decision       TEXT NOT NULL DEFAULT 'pending',
        note           TEXT NOT NULL DEFAULT '',
        decided_at     TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_task_approvals_task     ON task_approvals(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_approvals_decision ON task_approvals(decision);

      -- 20. recurring_task_rules
      CREATE TABLE IF NOT EXISTS recurring_task_rules (
        id             TEXT PRIMARY KEY,
        title          TEXT NOT NULL,
        description    TEXT NOT NULL DEFAULT '',
        category       TEXT NOT NULL DEFAULT 'Operations',
        department     TEXT NOT NULL DEFAULT '',
        assignee_email TEXT NOT NULL DEFAULT '',
        priority       TEXT NOT NULL DEFAULT 'medium',
        frequency      TEXT NOT NULL DEFAULT 'daily',
        day_of_week    INTEGER NOT NULL DEFAULT 0,
        day_of_month   INTEGER NOT NULL DEFAULT 1,
        next_run_date  TEXT NOT NULL DEFAULT '',
        last_run_date  TEXT NOT NULL DEFAULT '',
        is_active      INTEGER NOT NULL DEFAULT 1,
        created_by     TEXT NOT NULL DEFAULT '',
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // ── SEED: task_categories (13) — name is UNIQUE, INSERT OR IGNORE is safe ──
    {
      const cats: [string, string, string][] = [
        // [name, color, icon]
        ['Hygiene',     'emerald', 'SprayCan'],
        ['Maintenance', 'amber',   'Wrench'],
        ['Repairs',     'orange',  'Hammer'],
        ['Operations',  'blue',    'Settings2'],
        ['HR',          'violet',  'Users'],
        ['Training',    'indigo',  'GraduationCap'],
        ['Kitchen',     'red',     'ChefHat'],
        ['Housekeeping','teal',    'Sparkles'],
        ['Store',       'yellow',  'Package'],
        ['Bar',         'purple',  'Wine'],
        ['Admin',       'slate',   'FileText'],
        ['Compliance',  'cyan',    'ShieldCheck'],
        ['Safety',      'rose',    'AlertTriangle'],
      ];
      const ins = db.prepare(`INSERT OR IGNORE INTO task_categories (id, name, color, icon, sort_order) VALUES (?, ?, ?, ?, ?)`);
      cats.forEach(([name, color, icon], i) => ins.run(generateId(), name, color, icon, i));
    }

    // ── SEED: task_departments (10) — name UNIQUE ──
    {
      const depts: [string, string][] = [
        ['Operations', 'OPS'], ['Kitchen', 'KIT'], ['Bar', 'BAR'],
        ['Housekeeping', 'HK'], ['Maintenance', 'MNT'], ['Store', 'STR'],
        ['HR', 'HR'], ['Accounts', 'ACC'], ['Security', 'SEC'], ['Administration', 'ADM'],
      ];
      const ins = db.prepare(`INSERT OR IGNORE INTO task_departments (id, name, code) VALUES (?, ?, ?)`);
      depts.forEach(([name, code]) => ins.run(generateId(), name, code));
    }

    // ── SEED: checklist_templates + checklist_items ──
    // Guarded by name (checklist_templates.name is NOT unique) so admin edits
    // are never clobbered and re-runs are idempotent.
    {
      const templates: { name: string; role: string; department: string; category: string; items: string[] }[] = [
        {
          name: 'Operations Manager Daily Checklist', role: 'Operations Manager', department: 'Operations', category: 'Operations',
          items: ['Restaurant Cleanliness', 'Washrooms', 'Dining Area', 'Kitchen Inspection', 'Store Inspection', 'Bar Inspection', 'Fire Safety', 'Emergency Exit', 'Music', 'Lighting', 'AC Temperature', 'Guest Complaints', 'Opening Checklist', 'Closing Checklist'],
        },
        {
          name: 'Floor Manager Daily Checklist', role: 'Floor Manager', department: 'Operations', category: 'Operations',
          items: ['Table Setup', 'Cutlery & Crockery', 'Menu Cards', 'Staff Grooming', 'Guest Greeting', 'Service Standards', 'Order Accuracy', 'Billing Process', 'Feedback Collection', 'Table Turnaround', 'Reservation Management', 'Closing Floor Check'],
        },
        {
          name: 'HR Manager Daily Checklist', role: 'HR Manager', department: 'HR', category: 'HR',
          items: ['Attendance Register', 'Staff Grooming', 'Uniform Check', 'Shift Roster', 'Leave Records', 'Training Schedule', 'Staff Welfare', 'Discipline Log', 'New Joinee Documentation', 'Payroll Inputs'],
        },
        {
          name: 'Store Manager Daily Checklist', role: 'Store Manager', department: 'Store', category: 'Store',
          items: ['Stock Levels', 'Expiry Check', 'FIFO Compliance', 'Storage Hygiene', 'Temperature Logs', 'Receiving Inspection', 'Indent Processing', 'Wastage Record', 'Vendor Delivery Check', 'Inventory Reconciliation'],
        },
        {
          name: 'Bar Manager Daily Checklist', role: 'Bar Manager', department: 'Bar', category: 'Bar',
          items: ['Bar Cleanliness', 'Liquor Stock', 'Glassware', 'Ice Machine', 'Garnish Station', 'Beverage Expiry', 'POS Check', 'Bar Opening', 'Bar Closing', 'Wastage & Spillage Log'],
        },
      ];
      const findTpl = db.prepare(`SELECT id FROM checklist_templates WHERE name = ?`);
      const insTpl = db.prepare(`INSERT INTO checklist_templates (id, name, role, department, category) VALUES (?, ?, ?, ?, ?)`);
      const insItem = db.prepare(`INSERT INTO checklist_items (id, template_id, label, sort_order) VALUES (?, ?, ?, ?)`);
      for (const t of templates) {
        const existing = findTpl.get(t.name) as { id: string } | undefined;
        if (existing) continue; // already seeded — leave admin edits alone
        const tplId = generateId();
        insTpl.run(tplId, t.name, t.role, t.department, t.category);
        t.items.forEach((label, i) => insItem.run(generateId(), tplId, label, i));
      }
    }

    // ── SEED: maintenance_schedules (7 daily + 8 weekly + 6 monthly) ──
    // Guarded by name (not unique) so re-runs are idempotent and edits survive.
    {
      const scheds: [string, 'daily' | 'weekly' | 'monthly'][] = [
        ['Generator', 'daily'], ['Lighting', 'daily'], ['Electrical Panel', 'daily'], ['Water Tank', 'daily'], ['Washrooms', 'daily'], ['Water Leakage', 'daily'], ['Garbage Disposal', 'daily'],
        ['AC Cleaning', 'weekly'], ['Water Filter Inspection', 'weekly'], ['Refrigerator Cleaning', 'weekly'], ['Exhaust Cleaning', 'weekly'], ['Table Fittings', 'weekly'], ['Chair Fittings', 'weekly'], ['Door Closers', 'weekly'], ['CCTV Check', 'weekly'],
        ['Fire Extinguishers', 'monthly'], ['Plumbing', 'monthly'], ['Electrical Audit', 'monthly'], ['Pest Control', 'monthly'], ['Deep Cleaning', 'monthly'], ['Freezer Service', 'monthly'],
      ];
      const findSched = db.prepare(`SELECT id FROM maintenance_schedules WHERE name = ?`);
      const insSched = db.prepare(`INSERT INTO maintenance_schedules (id, name, category, frequency, department) VALUES (?, ?, 'Maintenance', ?, 'Maintenance')`);
      for (const [name, freq] of scheds) {
        if (findSched.get(name)) continue;
        insSched.run(generateId(), name, freq);
      }
    }
  } catch (e) { console.error('task-module schema failed:', e); }

  // ── Task Phase-3: blob file store + web-push subscriptions ──
  // Purely additive. Isolated try/catch, idempotent CREATE IF NOT EXISTS,
  // touches no existing table. task_files holds video/voice/large attachment
  // BLOBs (images stay on the inline-base64 path via ImageUpload).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_files (
        id         TEXT PRIMARY KEY,
        mime       TEXT NOT NULL DEFAULT '',
        filename   TEXT NOT NULL DEFAULT '',
        data       BLOB NOT NULL,
        size       INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_task_files_created ON task_files(created_at);

      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id         TEXT PRIMARY KEY,
        user_email TEXT NOT NULL DEFAULT '',
        endpoint   TEXT NOT NULL UNIQUE,
        p256dh     TEXT NOT NULL DEFAULT '',
        auth       TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_push_subscriptions_email ON push_subscriptions(user_email);
    `);
  } catch (e) { console.error('task push/files schema failed:', e); }

  // ── CRM Call-to-Table (ct_) — TeleCMI telephony CRM ──
  // Purely additive; isolated try/catch; namespaced ct_ to avoid the existing
  // AKAN-CRM crm_* tables. JSON-as-TEXT, UTC ISO timestamps. See
  // docs/CRM_DECISIONS.md for the full contract.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ct_guests (
        id          TEXT PRIMARY KEY,
        outlet_id   TEXT NOT NULL DEFAULT '',
        phone_e164  TEXT NOT NULL UNIQUE,
        name        TEXT NOT NULL DEFAULT '',
        alt_phone   TEXT NOT NULL DEFAULT '',
        email       TEXT NOT NULL DEFAULT '',
        tags        TEXT NOT NULL DEFAULT '[]',
        source      TEXT NOT NULL DEFAULT 'call',
        notes       TEXT NOT NULL DEFAULT '',
        dob         TEXT NOT NULL DEFAULT '',
        anniversary TEXT NOT NULL DEFAULT '',
        preferences TEXT NOT NULL DEFAULT '{}',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_ct_guests_phone ON ct_guests(phone_e164);

      CREATE TABLE IF NOT EXISTS ct_calls (
        id               TEXT PRIMARY KEY,
        telecmi_call_id  TEXT UNIQUE,
        guest_id         TEXT,
        phone_e164       TEXT NOT NULL DEFAULT '',
        direction        TEXT NOT NULL DEFAULT 'inbound',
        status           TEXT NOT NULL DEFAULT 'ringing',
        agent_user       TEXT NOT NULL DEFAULT '',
        queue            TEXT NOT NULL DEFAULT '',
        started_at       TEXT,
        answered_at      TEXT,
        ended_at         TEXT,
        duration_sec     INTEGER NOT NULL DEFAULT 0,
        recording_url    TEXT NOT NULL DEFAULT '',
        raw_payload      TEXT NOT NULL DEFAULT '{}',
        disposition      TEXT NOT NULL DEFAULT '',
        disposition_note TEXT NOT NULL DEFAULT '',
        created_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_ct_calls_phone   ON ct_calls(phone_e164);
      CREATE INDEX IF NOT EXISTS idx_ct_calls_guest   ON ct_calls(guest_id);
      CREATE INDEX IF NOT EXISTS idx_ct_calls_started ON ct_calls(started_at);
      CREATE INDEX IF NOT EXISTS idx_ct_calls_status  ON ct_calls(status);

      CREATE TABLE IF NOT EXISTS ct_bookings (
        id             TEXT PRIMARY KEY,
        guest_id       TEXT NOT NULL,
        source_call_id TEXT,
        booking_date   TEXT NOT NULL DEFAULT '',
        slot_time      TEXT NOT NULL DEFAULT '',
        party_size     INTEGER NOT NULL DEFAULT 2,
        occasion       TEXT NOT NULL DEFAULT '',
        section_pref   TEXT NOT NULL DEFAULT '',
        status         TEXT NOT NULL DEFAULT 'pending',
        created_by     TEXT NOT NULL DEFAULT '',
        channel        TEXT NOT NULL DEFAULT 'call',
        advance_amount REAL NOT NULL DEFAULT 0,
        notes          TEXT NOT NULL DEFAULT '',
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_ct_bookings_guest ON ct_bookings(guest_id);
      CREATE INDEX IF NOT EXISTS idx_ct_bookings_date  ON ct_bookings(booking_date);
      CREATE INDEX IF NOT EXISTS idx_ct_bookings_src   ON ct_bookings(source_call_id);

      -- Entertainment & events calendar — the standalone "what's on" schedule
      -- (live bands, DJ nights, special events) a manager fills per date; feeds
      -- the GRE "What's On" board alongside party-function entertainment.
      CREATE TABLE IF NOT EXISTS ct_entertainment (
        id          TEXT PRIMARY KEY,
        outlet_id   TEXT NOT NULL DEFAULT '',
        event_date  TEXT NOT NULL DEFAULT '',        -- YYYY-MM-DD
        type        TEXT NOT NULL DEFAULT 'band',     -- band | dj | live_music | event | offer | other
        name        TEXT NOT NULL DEFAULT '',
        start_time  TEXT NOT NULL DEFAULT '',         -- HH:mm (IST), free text ok
        end_time    TEXT NOT NULL DEFAULT '',
        area        TEXT NOT NULL DEFAULT '',         -- floor / section / hall
        description TEXT NOT NULL DEFAULT '',
        created_by  TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_ct_ent_date ON ct_entertainment(event_date);

      -- Specials & offers for the GRE "What's On" board. A special is either
      -- RECURRING on a weekday (scope='weekday', weekday 0=Sun..6=Sat — e.g.
      -- "every Sunday: Brunch") or a ONE-OFF on a date (scope='date', event_date).
      -- Shown on the board for any date it matches, alongside the always-on
      -- talking-points text (ct_settings.whatson_specials).
      CREATE TABLE IF NOT EXISTS ct_specials (
        id          TEXT PRIMARY KEY,
        outlet_id   TEXT NOT NULL DEFAULT '',
        scope       TEXT NOT NULL DEFAULT 'weekday',   -- weekday | date
        weekday     INTEGER NOT NULL DEFAULT -1,        -- 0=Sun..6=Sat (scope='weekday')
        event_date  TEXT NOT NULL DEFAULT '',           -- YYYY-MM-DD (scope='date')
        category    TEXT NOT NULL DEFAULT 'special',    -- special|offer|workshop|event|notice|vip
        title       TEXT NOT NULL DEFAULT '',           -- e.g. "Sunday Brunch"
        details     TEXT NOT NULL DEFAULT '',           -- menu / price / notes
        start_time  TEXT NOT NULL DEFAULT '',           -- HH:mm-ish, free text ok
        end_time    TEXT NOT NULL DEFAULT '',
        active      INTEGER NOT NULL DEFAULT 1,
        created_by  TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_ct_specials_weekday ON ct_specials(weekday);
      CREATE INDEX IF NOT EXISTS idx_ct_specials_date ON ct_specials(event_date);

      CREATE TABLE IF NOT EXISTS ct_follow_ups (
        id          TEXT PRIMARY KEY,
        guest_id    TEXT NOT NULL,
        call_id     TEXT,
        due_at      TEXT NOT NULL DEFAULT '',
        assigned_to TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'open',
        note        TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_ct_followups_guest ON ct_follow_ups(guest_id);
      CREATE INDEX IF NOT EXISTS idx_ct_followups_due   ON ct_follow_ups(status, due_at);

      CREATE TABLE IF NOT EXISTS ct_recoveries (
        id                  TEXT PRIMARY KEY,
        call_id             TEXT NOT NULL UNIQUE,
        guest_id            TEXT,
        phone_e164          TEXT NOT NULL DEFAULT '',
        missed_at           TEXT NOT NULL,
        detected_via        TEXT NOT NULL DEFAULT 'cdr',
        sla_due_at          TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'pending',
        assigned_to         TEXT NOT NULL DEFAULT '',
        attempts            TEXT NOT NULL DEFAULT '[]',
        first_attempt_at    TEXT,
        recovered_at        TEXT,
        recovery_call_id    TEXT,
        recovery_booking_id TEXT,
        escalated           INTEGER NOT NULL DEFAULT 0,
        escalated_at        TEXT,
        resolution_note     TEXT NOT NULL DEFAULT '',
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_ct_recov_status ON ct_recoveries(status, sla_due_at);
      CREATE INDEX IF NOT EXISTS idx_ct_recov_phone  ON ct_recoveries(phone_e164);

      CREATE TABLE IF NOT EXISTS ct_webhook_log (
        id              TEXT PRIMARY KEY,
        kind            TEXT NOT NULL DEFAULT '',
        telecmi_call_id TEXT NOT NULL DEFAULT '',
        phone_e164      TEXT NOT NULL DEFAULT '',
        event           TEXT NOT NULL DEFAULT '',
        received_at     TEXT NOT NULL DEFAULT (datetime('now')),
        payload         TEXT NOT NULL DEFAULT '{}',
        processed       INTEGER NOT NULL DEFAULT 0,
        error           TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_ct_whlog_call ON ct_webhook_log(telecmi_call_id);
      CREATE INDEX IF NOT EXISTS idx_ct_whlog_recv ON ct_webhook_log(received_at);

      CREATE TABLE IF NOT EXISTS ct_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT ''
      );
    `);
    // Defaults (INSERT OR IGNORE = idempotent, admin edits survive re-runs)
    const seedCt = db.prepare(`INSERT OR IGNORE INTO ct_settings (key, value) VALUES (?, ?)`);
    seedCt.run('sla_minutes', '30');
    seedCt.run('attribution_hours', '48');
    seedCt.run('business_open', '12:00');
    seedCt.run('business_close', '23:30');
    seedCt.run('auto_assign', 'off');
    seedCt.run('after_hours_whatsapp', '0');
    seedCt.run('after_hours_template', 'Sorry we missed your call! We open at {open}. Book a table: {link}');
    seedCt.run('agent_map', '{}');
    seedCt.run('auto_analyze', '0'); // AI call-scoring: off by default (opt-in, controls LLM spend)
    seedCt.run('analysis_retention', 'permanent'); // 'permanent' (keep scorecards) | 'ephemeral' (view-on-click, not stored)

    // AI call-analysis columns on ct_calls (additive; ALTER is idempotent via
    // the per-column try/catch — a re-run throws "duplicate column" which we
    // swallow). Holds the CallPilot-style scorecard from analyzeCallRecording.
    const addCtCol = (col: string, decl: string) => {
      try { db.exec(`ALTER TABLE ct_calls ADD COLUMN ${col} ${decl}`); } catch { /* already exists */ }
    };
    addCtCol('analysis_json',    `TEXT NOT NULL DEFAULT ''`);   // full CallAnalysisStructured JSON
    addCtCol('analysis_score',   `INTEGER`);                    // overall_score 0-100, NULL if unscored
    addCtCol('analysis_outcome', `TEXT NOT NULL DEFAULT ''`);   // resolved|escalate|follow_up|lost
    addCtCol('analysis_summary', `TEXT NOT NULL DEFAULT ''`);
    addCtCol('analysis_status',  `TEXT NOT NULL DEFAULT ''`);   // ''|pending|done|error|skipped
    addCtCol('analysis_error',   `TEXT NOT NULL DEFAULT ''`);
    addCtCol('analyzed_at',      `TEXT`);
    addCtCol('analyzed_by',      `TEXT NOT NULL DEFAULT ''`);   // user email or 'auto'
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ct_calls_analysis_status ON ct_calls(analysis_status)`);

    // ── Answered-call OWNERSHIP (additive; same idempotent addCtCol pattern) ──
    // WHY: when a GRE answers, that call is THEIRS — the screen-pop and the
    // disposition write-up belong to one person, and everyone else drops to a
    // read-only strip naming who is on it. Two people writing up one call was
    // the reported problem.
    //
    // agent_user CANNOT carry this: it is the TELEPHONY agent id (5004_33338614),
    // and an unmapped id resolves to no app user at all — which is exactly the
    // first-claim case. So ownership is its own column, holding an app user's
    // email, set only by the atomic claim in src/lib/ct/call-owner.ts.
    //
    // EMPTY STRING = UNOWNED, never NULL: every other ct_ column in this block
    // uses the empty-string convention and mixing the two makes every ownership
    // query a NULL trap. NOT NULL DEFAULT '' also back-fills existing rows as
    // unowned in the ALTER itself, so no data migration is needed.
    //
    // NOTHING here expires a lock — expiry is a computation done per request in
    // call-owner.ts (a browser timer that never fires would strand a call).
    // owner_claimed_at is read as the expiry anchor only when ended_at is blank.
    addCtCol('owner_email',      `TEXT NOT NULL DEFAULT ''`);   // app user email who claimed the ANSWERED call; '' = unowned
    addCtCol('owner_claimed_at', `TEXT NOT NULL DEFAULT ''`);   // UTC ISO of the claim; '' = unowned

    // ── Did TeleCMI RECORD this call? (additive; same idempotent addCtCol) ────
    // TeleCMI's CDR carries a `record` boolean. Until now nothing read it, so a
    // call TeleCMI never recorded looked identical to a recording that went
    // missing — one is normal, the other is a fault, and the diagnostic could
    // not tell them apart.
    //
    // THREE-STATE, stored as the three words themselves:
    //   'yes'     — the CDR said recorded
    //   'no'      — the CDR said not recorded
    //   'unknown' — no CDR field to read (every live-created row, and every row
    //               that already exists today)
    //
    // WHY WORDS AND NOT 0/1/NULL. Every falsy shortcut a reader might reach for
    // has to fail SAFE. With INTEGER 0/1/NULL, `!row.x` is true for both NULL
    // and 0 — unknown silently collapses into "not recorded", which is exactly
    // the false claim this column exists to prevent. With '' as the unknown
    // marker, `if (row.x)` collapses the same way. With 'unknown'/'yes'/'no'
    // there is no falsy value at all: a reader must spell the word, and
    // `x === 'no'` cannot accidentally swallow unknown.
    //
    // WHY DEFAULT 'unknown' AND NOT ''. NOT NULL DEFAULT back-fills every
    // existing row inside the ALTER itself — the same trick owner_email uses —
    // so the entire pre-existing call history lands in UNKNOWN rather than
    // being relabelled "not recorded". No data migration, and no second blank
    // state to disambiguate later.
    addCtCol('telecmi_recorded', `TEXT NOT NULL DEFAULT 'unknown'`); // 'yes' | 'no' | 'unknown'

    // ── WHERE DID THIS DURATION COME FROM, AND CAN WE PROVE IT? ──────────────
    // (additive; same idempotent addCtCol pattern)
    //
    // The Call Back flow logs an OUTBOUND call the GRE placed from their own
    // handset. On Android the Captain APK reads the exact talk time out of the
    // device call log; everywhere else the number is a wall-clock estimate or
    // typed by hand. Until now all four cases landed in the same duration_sec
    // column and rendered identically, and the only note of provenance was a
    // duration_source key stringified into the raw_payload JSON blob — which
    // is not selected by any API and is read by nothing. So there was no way,
    // in the app or in plain SQL, to tell a measured duration from a typed one.
    //
    // TWO COLUMNS, BECAUSE THEY ANSWER TWO DIFFERENT QUESTIONS:
    //
    //   duration_source   — what the CLIENT says it is. The callback log path
    //                       writes one of four words, the set it already
    //                       whitelists: 'call_log' (Android call log),
    //                       'approx' (the APK's own wall time, used when
    //                       READ_CALL_LOG was denied), 'timer' (the web
    //                       time-away estimate) or 'manual' (typed from zero).
    //                       '' means no callback ever wrote this row — every
    //                       CDR/live/seeded call, and the whole history that
    //                       predates this column. A CLAIM either way: all four
    //                       words arrive in a request body.
    //
    //   duration_verified — 0/1. 1 ONLY when the server itself BOUNDED the
    //                       number: the client redeemed a single-use
    //                       ct_call_tokens row minted when the GRE tapped Call
    //                       Back, and the claim was checked against the wall
    //                       time elapsed since. BOUNDED, not clamped — the
    //                       clamp only bites when the claim exceeds that wall
    //                       time, so an honest 60s call five minutes after
    //                       dialling is verified and untouched. See
    //                       src/lib/ct/call-token.ts. This is the column any
    //                       honesty badge must read.
    //
    // WHY DEFAULT '' AND 0. NOT NULL DEFAULT back-fills every existing row
    // inside the ALTER itself (the trick owner_email and telecmi_recorded both
    // use), so the whole call history — every seeded row, every CDR row, every
    // callback logged before this shipped — lands as unknown-source and
    // UNVERIFIED. That is the truthful state for all of them: nothing in that
    // history was ever bounded by the server. No data migration, and the fail
    // state is the safe one, because a reader that forgets the column entirely
    // still gets "not verified" rather than a false claim of accuracy.
    addCtCol('duration_source',   `TEXT NOT NULL DEFAULT ''`);    // 'call_log'|'approx'|'timer'|'manual', '' = no callback wrote it — CLAIMED, not proven
    addCtCol('duration_verified', `INTEGER NOT NULL DEFAULT 0`);  // 1 = server bounded it against a redeemed call token (clamped only if the claim exceeded the wall time)

    // ── ct_call_tokens — the wall-clock receipt for an outbound call back ────
    //
    // WHAT IT IS FOR. The GRE taps Call Back; before the dialer opens, the
    // client asks the server to mint a row here. The server records WHO asked,
    // WHICH number, and WHEN — on the server clock, which no handset and no
    // address bar can move. When the log posts back carrying that token id,
    // the accepted talk time is clamped to (now - issued_at): you cannot have
    // talked for longer than the wall time since you started dialling. The
    // token is then marked redeemed, so the same token cannot VOUCH for a
    // second call. Read "single use" as "a claim can only be vouched for once",
    // NEVER as "rows cannot be fabricated" — a replay outside the de-dupe
    // window still inserts a complete ct_calls row; it just lands with
    // duration_verified = 0. What bounds row CREATION is the de-dupe window and
    // the per-agent burst cap in log-callback, not this table.
    //
    // WHY A TOKEN AND NOT A SIGNATURE. The alternative was signing the APK's
    // return URL, which needs a shared secret shipped inside an APK — and an
    // APK is a zip anyone can open. A server-issued, server-timed, single-use
    // row needs no secret and needs no APK change at all.
    //
    // ISSUING MUST NEVER BLOCK THE CALL. If minting fails (offline, server
    // down) the GRE still dials and the call is still logged — just with
    // duration_verified = 0. Losing a real guest call to protect a statistic
    // would be a worse bug than the one this closes.
    //
    // EMPTY STRING, NOT NULL, for redeemed_at / redeemed_call_id / recovery_id
    // — the convention every other ct_ table here uses, so no query needs a
    // NULL guard. redeemed_at = '' IS the unredeemed state, and it is what the
    // single-use check tests.
    //
    // THIS TABLE IS EPHEMERAL. One row per Call Back tap, and a row is useless
    // the moment it is redeemed or a day old. issueCallToken() prunes anything
    // older than 24h on its way past, so the table stays bounded without a
    // sweeper. Nothing of record lives here — the CALL is the record.
    db.exec(`
      CREATE TABLE IF NOT EXISTS ct_call_tokens (
        id               TEXT PRIMARY KEY,
        agent_email      TEXT NOT NULL,
        phone_e164       TEXT NOT NULL,
        recovery_id      TEXT NOT NULL DEFAULT '',
        issued_at        TEXT NOT NULL,
        redeemed_at      TEXT NOT NULL DEFAULT '',
        redeemed_call_id TEXT NOT NULL DEFAULT ''
      );
    `);
    // The prune is a range scan on issued_at alone; redemption looks a row up
    // by its PRIMARY KEY. Those are the only two access paths, so issued_at is
    // the only index worth carrying.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ct_call_tokens_issued ON ct_call_tokens(issued_at)`);

    // ── Reservation → table seating (Part A) + table party (Part B) ──────────
    // Additive columns; per-column try/catch makes the ALTER idempotent.
    const addBookingCol = (col: string, decl: string) => {
      try { db.exec(`ALTER TABLE ct_bookings ADD COLUMN ${col} ${decl}`); } catch { /* exists */ }
    };
    addBookingCol('table_id',  `TEXT NOT NULL DEFAULT ''`);   // physical table a booking was seated at
    addBookingCol('seated_at', `TEXT`);                       // when the host seated the party
    try { db.exec(`ALTER TABLE orders ADD COLUMN booking_id TEXT NOT NULL DEFAULT ''`); } catch { /* exists */ }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ct_bookings_table ON ct_bookings(table_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_booking ON orders(booking_id)`);

    // Table party — every diner at a table for one visit (Part B). One primary
    // (the reserved/registered member) + any number of additional QR-scan diners.
    // Keyed by the last-10-digit phone so a re-scan updates rather than duplicates.
    db.exec(`
      CREATE TABLE IF NOT EXISTS order_guests (
        id         TEXT PRIMARY KEY,
        order_id   TEXT NOT NULL,
        phone10    TEXT NOT NULL DEFAULT '',   -- last-10 join key (may be '' if name-only)
        mobile     TEXT NOT NULL DEFAULT '',   -- stored form (bare +91 / E.164)
        name       TEXT NOT NULL DEFAULT '',
        is_primary INTEGER NOT NULL DEFAULT 0,
        source     TEXT NOT NULL DEFAULT 'walk-in',  -- reservation | walk-in | qr
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
      );
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_order_guests_order ON order_guests(order_id)`);
    // One party guest per (order, phone) — a re-scan/re-entry updates in place.
    // PARTIAL (phone10 != '') so multiple name-only guests can coexist.
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_order_guests_uniq ON order_guests(order_id, phone10) WHERE phone10 != ''`);

    // One-time: materialize every existing dining + loyalty guest into ct_guests
    // so the CRM has real, editable records (notes/tags/follow-ups) instead of
    // read-only "synthetic" phone:<10> rows. Ongoing capture happens at the order
    // + loyalty write paths via autoSaveCrmGuest; this backfills the history.
    // Guarded by a settings key + deferred require (cycle-safe, same pattern as
    // convertToMaterialUnit's require('./units')).
    const ctBackfilled = db.prepare(`SELECT value FROM settings WHERE key = 'ct_guests_autosave_backfill_v1'`).get() as any;
    if (!ctBackfilled) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { backfillCrmGuestsFromDiningAndLoyalty } = require('./ct/guest-autosave') as typeof import('./ct/guest-autosave');
        const run = db.transaction(() => {
          const created = backfillCrmGuestsFromDiningAndLoyalty(db);
          db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('ct_guests_autosave_backfill_v1', '1')`).run();
          return created;
        });
        const created = run();
        console.log(`[db] ct_guests_autosave_backfill_v1: materialized ${created} dining/loyalty guest(s) into the CRM`);
      } catch (e) { console.error('[db] ct_guests_autosave_backfill_v1 failed (rolled back):', e); }
    }
  } catch (e) { console.error('ct (call-to-table CRM) schema failed:', e); }

  // ══ RESERVEGO RESERVATION IMPORT — SCHEMA ONLY (2026-08) ══════════════════
  //
  // The owner exports Reservego's reservation history as CSV and wants it to
  // build ONE accurate guest database. It lands in the tables the phone CRM
  // already uses — ct_guests as the customer master, ct_bookings as the booking
  // history — and NOT in a parallel "imported reservations" island that every
  // CRM page, plus the /dine-in/reservations seat board, would then have to
  // UNION forever.
  //
  // Everything here is additive and PRAGMA-guarded. The 40 ct_bookings and 27
  // ct_guests rows already in production are real bookings taken over the
  // phone: no column is dropped or renamed and nothing is backfilled, so those
  // rows come out of this migration byte-identical, just wider.
  //
  // WHY A SESSION TABLE AND NOT A ONE-SHOT UPLOAD. Production is ~106,000 rows
  // / ~30MB. Measured on this machine with better-sqlite3: 106k upserts in one
  // batched transaction = 1.1s, an idempotent re-import = 0.4s, a full metric
  // rollup = 12ms. SQLite is nowhere near the bottleneck — the HTTP body is. So
  // the browser parses the CSV with papaparse and posts batches of 2,000 rows,
  // and reservation_imports is the row those batches accumulate into: it is
  // what gives the upload a progress bar, a duplicate/collapse report, and the
  // ability to survive a dropped connection.
  //
  // Column semantics are fixed by src/lib/reservego.ts (mapRow / MappedBooking
  // / dedupeKeyFor / computeGuestMetrics). That module is the agreed contract —
  // this block stores what it produces and re-spells none of its rules.
  try {
    // ── A) ct_bookings gains the Reservego record ────────────────────────────
    // These are nullable on purpose. A NULL here reads as "this booking did not
    // come from Reservego", which is the literal truth for all 40 existing rows
    // and for every future booking typed in during a phone call — and it is
    // also what makes the partial unique index below legal (see WHY, there).
    const rbCols = db.prepare(`PRAGMA table_info(ct_bookings)`).all() as any[];
    const hasRB = (n: string) => rbCols.some((c: any) => c.name === n);
    const addRB = (col: string, decl: string) => {
      if (!hasRB(col)) db.exec(`ALTER TABLE ct_bookings ADD COLUMN ${col} ${decl}`);
    };
    addRB('reservego_key',          `TEXT`);     // dedupeKeyFor(outlet, guestKey, bookingTime) — THE idempotency key
    addRB('reservego_status',       `TEXT`);     // the RAW status string, kept verbatim: mapStatus() returns null for
                                                 // anything it does not recognise, and a status we cannot map is exactly
                                                 // the one worth being able to read back later.
    addRB('booking_time',           `TEXT`);     // when the booking was CREATED — the owner's unique-record field.
                                                 // Distinct from created_at, which is when WE inserted the row.
    addRB('reserved_time',          `TEXT`);     // the slot the table was booked FOR
    addRB('booking_type',           `TEXT`);     // Reservation | Walkin | …
    addRB('outlet_name',            `TEXT`);
    addRB('pax_breakdown',          `TEXT`);     // JSON of the 10 pax columns (adult/child/veg/non-veg/male/female/
                                                 // infant/couple/male-stag/female-stag) — one column, not ten, because
                                                 // nothing queries them individually; they are read back as a whole.
    addRB('reserved_by',            `TEXT`);
    addRB('sections',               `TEXT`);
    addRB('tables_csv',             `TEXT`);     // Reservego's "Table(s)" — free text, may list several
    addRB('source',                 `TEXT`);     // Source of Booking. Separate from the existing `channel`, which is
                                                 // OUR taxonomy ('call'); this one is Reservego's, unedited.
    addRB('preferences',            `TEXT`);
    addRB('tags',                   `TEXT`);
    addRB('guest_comments',         `TEXT`);
    addRB('outlet_comments',        `TEXT`);
    addRB('deletion_type',          `TEXT`);
    addRB('deletion_reason',        `TEXT`);
    addRB('bill_amount',            `REAL`);     // NULL ≠ 0: "no bill recorded" is not "spent nothing", and
                                                 // computeGuestMetrics' total/avg spend depends on that distinction.
    addRB('bill_number',            `TEXT`);
    addRB('booking_amount',         `REAL`);     // advance taken at booking, per Reservego (the existing
                                                 // advance_amount column stays OUR field, written by the phone CRM)
    addRB('booking_txn_id',         `TEXT`);
    addRB('booking_payment_status', `TEXT`);
    addRB('booking_payment_date',   `TEXT`);
    addRB('arrived',                `INTEGER DEFAULT 0`);  // isArrived(status, seatedAt) — denormalised because every
                                                           // metric and every "who actually came" filter reads it
    addRB('import_id',              `TEXT`);     // which reservation_imports run wrote/last-touched this row
    addRB('source_exported_at',     `TEXT`);     // THE RECENCY GUARD. Reservego stamps its export in the file name
                                                 // (exportStampFromFileName / normalizeExportStamp in reservego.ts);
                                                 // the engine refuses a field-level overwrite whose stamp is older
                                                 // than the one stored here. Without the column the guard has nowhere
                                                 // to read from, so re-uploading a stale export from the owner's 129
                                                 // files would quietly revert bookings the newer export had corrected.
                                                 // NULL = the 40 phone rows and any row written before the guard.
                                                 // No index: it is only ever read on a row already found through
                                                 // idx_ct_bookings_resv_key, so an index would pay write cost on
                                                 // 85,558 rows to serve no query.
    addRB('reservego_visit_count',  `INTEGER`);  // Reservego's own "Vist Count" column — misspelt at source, kept
                                                 // under a readable name. Stored as a CROSS-CHECK against the
                                                 // arrived_visits we compute in computeGuestMetrics, not as an input
                                                 // to it: their count is per-export and per-outlet, ours is over
                                                 // every row we hold. A gap between the two is a signal worth
                                                 // reading, which it cannot be if we overwrite one with the other.
                                                 // NULL ≠ 0 — a blank cell means "not reported", not "never came".

    // ── A2) is_duplicate — the same-day verdict, STORED not computed ─────────
    // markDuplicateGroups() (src/lib/reservego.ts) decides, per (outlet, mobile,
    // date), which stored row IS the visit and which are its duplicates. That
    // verdict is written here after each import; 0 = the visit, 1 = a duplicate
    // of it. Nothing is deleted, so the row stays auditable and the verdict can
    // be recomputed if the rule ever changes.
    //
    // WHY STORED. Three reasons, in order of how much they hurt.
    //  1. ONE ANSWER. The bookings list, the CSV export and the guest metrics
    //     must agree on the count or the feature is worthless — the owner will
    //     see 82,088 on screen and a different number in the file he opens in
    //     Excel. Computed per query, the rule would exist three more times, once
    //     per SQL statement, alongside the TS function that is supposed to be
    //     the only copy. A stored column makes them all read the same byte.
    //  2. IT IS NOT CLEANLY EXPRESSIBLE IN SQL ANYWAY. The tiebreak is a total
    //     ordering over (arrived, bill_amount, booking_time, id) where a missing
    //     bill sorts as -1 — not as SQL NULL, which orders differently and would
    //     silently pick a different primary. A window function that "looks the
    //     same" is a second implementation of a rule already proven subtle
    //     enough to have shipped wrong once (the per-batch collapse).
    //  3. COST. Measured shape of the real archive: ~129 Reservego exports,
    //     217,805 CSV rows → 82,088 bookings over 70,297 guests. Computing the
    //     verdict per query means partitioning 82k rows on every list render,
    //     every sort and every keystroke of the search box; stored, it is one
    //     pass per import.
    addRB('is_duplicate', `INTEGER NOT NULL DEFAULT 0`);
    // NOT NULL, unlike `arrived` above, and deliberately. Every consumer filters
    // `is_duplicate = 0`, and in SQL `NULL = 0` is not false but NULL — one row
    // written with an explicit NULL would vanish from the list, the export AND
    // the metrics at once, silently. The default fills the 40 existing phone
    // rows with 0, which is the truth: a phone booking is never a Reservego
    // duplicate (markDuplicateGroups is only ever handed import_id IS NOT NULL
    // rows), and the importer's INSERT omits the column so new rows also land
    // at 0 until the post-import sweep judges them.

    // ── A3) derived reservation fields — written once, at import ─────────────
    // Everything here is a function of the row Reservego already gave us, so
    // none of it is new information. It is stored because the questions the
    // owner asks of this archive are all GROUP BY questions — which weekday
    // fills, lunch vs dinner, which band pulls a crowd — and derived per query
    // they would be `strftime()` and `CASE` expressions over 85,558 bookings,
    // unindexable by definition: SQLite cannot seek on an expression, so every
    // one of those screens would be a full table scan plus a sort.
    //
    // Nullable, and nothing is backfilled: NULL reads as "not derived", which
    // is the truth for all 40 existing phone bookings. The two live-band
    // columns are the deliberate exception — see the note above them.
    addRB('reserved_date',  `TEXT`);     // YYYY-MM-DD the table was booked FOR, split out of reserved_time.
                                         // booking_date is OUR field and reserved_time is a timestamp; this is the
                                         // date half, so a month filter is a range scan and not a substr().
    addRB('day_of_week',    `TEXT`);     // 'Saturday' — the label, for display and CSV export
    addRB('dow',            `INTEGER`);  // 0=Sunday…6=Saturday, matching strftime('%w'). Kept BESIDE the label
                                         // rather than derived from it because sorting a weekday report by name
                                         // yields Friday, Monday, Saturday — and because ordering by the label
                                         // cannot use an index on the label.
    addRB('slot_time',      `TEXT`);     // already on the base table (CREATE TABLE ct_bookings above), so this
                                         // addRB is a guarded no-op. Listed anyway so the derived set reads as
                                         // one group here instead of one column silently living elsewhere.
    addRB('meal_period',    `TEXT`);     // 'lunch' | 'dinner', split at the reservation_meal_cutoff setting seeded
                                         // below. A setting and not a constant: the cutoff is a house rule the
                                         // owner may move, and 17:00 is only today's answer.
    // The two live-band columns are NOT NULL DEFAULT '' while the rest of this
    // group is nullable, and the difference is not cosmetic. '' is the sentinel
    // src/lib/ct/live-band.ts declared for them, and the relink backfill
    // (/api/crm/reservations/relink-bands) selects its work with
    // `WHERE live_band_id = ''` and counts it with `SUM(CASE WHEN live_band_id
    // = '' …)`. In SQL a NULL row answers neither that equality nor its
    // negation, so nullable columns would hand the backfill an empty work set
    // over all 85,558 imported bookings — the feature would run, report 0, and
    // look like it had nothing to do. '' also matches the neighbouring
    // occasion / section_pref columns on the base table.
    addRB('live_band',      `TEXT NOT NULL DEFAULT ''`);  // the band name AS IT WAS on the night, frozen onto the
                                         // booking. Renaming a band in ct_bands must not rewrite what last year's
                                         // report says played.
    addRB('live_band_id',   `TEXT NOT NULL DEFAULT ''`);  // → ct_bands.id. The join key, so 'Agnee' and 'AGNEE'
                                         // aggregate as one band even though live_band above keeps them spelt as
                                         // typed. '' = no band that night.
    // A database that already carries these columns in a NULLABLE form predates
    // this declaration, and the PRAGMA guard above cannot correct it — changing
    // nullability needs a table rewrite, which is not this block's job. Say so
    // once at boot rather than let the relink backfill quietly find no rows.
    if (db.prepare(`PRAGMA table_info(ct_bookings)`).all()
          .some((c: any) => c.name === 'live_band_id' && Number(c.notnull) === 0)) {
      console.warn(`[db] ct_bookings.live_band_id is nullable; relink-bands matches on '' and will skip NULL rows`);
    }

    // WHY THIS UNIQUE INDEX IS PARTIAL.
    // One table now holds two kinds of booking. Reservego rows carry a
    // dedupeKey and must be unique on it — that is what makes re-uploading the
    // same file (or an overlapping month) an idempotent no-op instead of
    // 106,000 duplicates. Phone bookings have no such key and never will.
    // SQLite treats NULLs as distinct in a UNIQUE index, so a plain UNIQUE
    // index would already tolerate many NULL rows — but WHERE reservego_key IS
    // NOT NULL states that intent instead of relying on it, and keeps the index
    // holding only the ~106k rows that are actually looked up through it rather
    // than every row in the table. Both kinds of booking therefore live in one
    // table, and the seat board's queries are unaffected.
    //
    // UPSERT TRAP, measured against a copy of production: a PARTIAL index does
    // NOT match a bare conflict target. `ON CONFLICT(reservego_key) DO UPDATE`
    // fails to even PREPARE with "ON CONFLICT clause does not match any PRIMARY
    // KEY or UNIQUE constraint". The importer must repeat the predicate:
    //   ON CONFLICT(reservego_key) WHERE reservego_key IS NOT NULL DO UPDATE …
    // (INSERT OR IGNORE / OR REPLACE need no target and are unaffected.)
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ct_bookings_resv_key
             ON ct_bookings(reservego_key) WHERE reservego_key IS NOT NULL`);
    // booking_date is already indexed as idx_ct_bookings_date (created with the
    // table above); re-declaring it under the same name is a no-op rather than
    // a second, redundant B-tree paying write cost on all 106k inserts.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ct_bookings_date      ON ct_bookings(booking_date)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ct_bookings_arrived   ON ct_bookings(arrived)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ct_bookings_import    ON ct_bookings(import_id)`);
    // The one filter every Reservego surface applies: hide duplicates, then bound
    // or order by date. is_duplicate FIRST because it is the equality half —
    // SQLite can seek on a leading equality and then range-scan booking_date
    // inside it, so this one index serves both the WHERE and the ORDER BY. The
    // reverse order would seek on the date and re-test is_duplicate per row,
    // which over 82k bookings is the whole table minus the month.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ct_bookings_dup_date ON ct_bookings(is_duplicate, booking_date)`);
    // The A3 columns exist to be grouped and filtered on; these are what make
    // that cheap. Single-column and not composite because the reports pick one
    // of them at a time (a weekday breakdown, a lunch/dinner split, a band's
    // history) and a composite would only serve the one prefix order it was
    // built in.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ct_bookings_dow       ON ct_bookings(dow)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ct_bookings_meal      ON ct_bookings(meal_period)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ct_bookings_resv_date ON ct_bookings(reserved_date)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ct_bookings_band      ON ct_bookings(live_band_id)`);
    // The reserved_date twin of idx_ct_bookings_dup_date, for the same reason
    // and in the same column order: every Reservego surface hides duplicates
    // first, and the ones that report on the night the guest was booked FOR
    // bound by reserved_date rather than by our booking_date.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ct_bookings_dup_resv_date ON ct_bookings(is_duplicate, reserved_date)`);

    // ── B) ct_guests gains denormalised lifetime metrics ─────────────────────
    // Refreshed once at the end of an import, NOT computed per page view. A
    // Customers list that aggregated 106k bookings on every render would be
    // paying 12ms of rollup for one screen of 50 rows, and paying it again on
    // every sort and every keystroke of the search box. Written by
    // computeGuestMetrics() so the list, the guest 360 and the CSV export can
    // never disagree about what "arrival rate" means.
    const gCols = db.prepare(`PRAGMA table_info(ct_guests)`).all() as any[];
    const hasG = (n: string) => gCols.some((c: any) => c.name === n);
    const addG = (col: string, decl: string) => {
      if (!hasG(col)) db.exec(`ALTER TABLE ct_guests ADD COLUMN ${col} ${decl}`);
    };
    addG('phone10',              `TEXT`);            // phone10() last-10-digit key: 919392966858 and 9392966858 are
                                                     // one guest. phone_e164 keeps the stored form; this is the JOIN key.
    addG('total_bookings',       `INTEGER DEFAULT 0`);
    addG('arrived_visits',       `INTEGER DEFAULT 0`);
    addG('cancelled_bookings',   `INTEGER DEFAULT 0`);
    addG('no_shows',             `INTEGER DEFAULT 0`);
    addG('arrival_rate',         `REAL DEFAULT 0`);  // 0..1, arrived / total
    addG('total_pax',            `INTEGER DEFAULT 0`);
    addG('total_spend',          `REAL DEFAULT 0`);
    addG('avg_spend',            `REAL DEFAULT 0`);  // per ARRIVED visit, not per booking — see computeGuestMetrics
    addG('first_booking',        `TEXT`);
    addG('last_booking',         `TEXT`);
    addG('booking_sources',      `TEXT`);            // JSON array of the distinct Source of Booking values
    addG('visit_frequency_days', `INTEGER`);         // mean gap between arrived visits; NULL = fewer than two visits,
                                                     // which is not the same as "comes every 0 days"
    addG('metrics_updated_at',   `TEXT`);            // NULL = never rolled up (the state all 27 existing rows are in)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ct_guests_phone10 ON ct_guests(phone10)`);

    // ── C) reservation_imports — one row per upload session ──────────────────
    // The counters are NOT NULL DEFAULT 0 because import/batch increments them
    // in place (`SET rows_processed = rows_processed + ?`) and in SQL
    // NULL + n = NULL: a single NULL counter would silently blank the progress
    // bar and the final summary. Defaulting to 0 means a start row can be
    // inserted with just its identity and every batch can safely add to it.
    // errors_json is capped by the writer, not here — the point of the column
    // is the first few hundred rejected rows, not a second copy of the file.
    db.exec(`
      CREATE TABLE IF NOT EXISTS reservation_imports (
        id                TEXT PRIMARY KEY,
        file_name         TEXT NOT NULL DEFAULT '',
        started_at        TEXT,
        finished_at       TEXT,
        status            TEXT NOT NULL DEFAULT 'running',   -- running | completed | failed
        rows_total        INTEGER NOT NULL DEFAULT 0,        -- as counted by the browser parse, known up front
        rows_processed    INTEGER NOT NULL DEFAULT 0,
        new_bookings      INTEGER NOT NULL DEFAULT 0,
        updated_bookings  INTEGER NOT NULL DEFAULT 0,
        duplicate_rows    INTEGER NOT NULL DEFAULT 0,        -- same reservego_key seen again — the re-import case
        collapsed_rows    INTEGER NOT NULL DEFAULT 0,        -- same date + same mobile, collapsed to the checked-in
                                                             -- copy. REPORTED, never silently dropped.
        new_customers     INTEGER NOT NULL DEFAULT 0,
        updated_customers INTEGER NOT NULL DEFAULT 0,
        failed_rows       INTEGER NOT NULL DEFAULT 0,
        errors_json       TEXT DEFAULT '[]',
        imported_by       TEXT DEFAULT '',
        created_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // ── D) ct_bands — the band master behind ct_bookings.live_band_id ─────────
    //
    // WHY A TABLE AND NOT FREE TEXT ON THE BOOKING. Typed per night, "Agnee",
    // "AGNEE" and "Agnee Band" are three different strings, so GROUP BY
    // live_band reports three bands with a third of the covers each and no
    // query can put them back together — the one thing the owner wants this
    // column for (which act actually fills the room) is exactly the thing free
    // text cannot answer. UNIQUE COLLATE NOCASE is therefore the point of the
    // table, not decoration on it: it makes the second spelling of a name
    // impossible to insert rather than merely discouraged. Case-INSENSITIVE
    // and not case-preserving-unique because the collation is what catches
    // 'AGNEE'; the name stays stored as first typed, and ct_bookings.live_band
    // keeps the per-night spelling anyway.
    //
    // is_active retires a band without deleting it: the id is referenced by
    // every booking it ever played, so a delete would orphan history. Inactive
    // means "do not offer this in the picker", not "never happened".
    db.exec(`
      CREATE TABLE IF NOT EXISTS ct_bands (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
        is_active  INTEGER DEFAULT 1,
        created_by TEXT,
        created_at TEXT,
        updated_at TEXT
      );
    `);

    // ── E) settings seeds ────────────────────────────────────────────────────
    // INSERT OR IGNORE, so a value the owner has already changed survives every
    // subsequent boot. Seeded rather than left absent because meal_period and
    // the band lead-in are derived AT IMPORT: a missing key would make the
    // derivation fall back to a hardcoded default that then disagrees with what
    // /settings shows, for the whole archive, silently.
    db.exec(`
      -- Lunch/dinner boundary for ct_bookings.meal_period. 17:00 is AKAN's
      -- current changeover, not a law — hence a setting.
      INSERT OR IGNORE INTO settings (key, value) VALUES ('reservation_meal_cutoff', '17:00');
      -- How long before a band's start time a booking still counts as "came for
      -- that band". Guests booked at 19:00 are there for the 21:00 act; without
      -- a lead-in window, attributing on exact overlap would credit the band
      -- with only the late arrivals.
      INSERT OR IGNORE INTO settings (key, value) VALUES ('reservation_band_lead_in_minutes', '120');
    `);
  } catch (e) { console.error('reservego reservation-import schema failed:', e); }

  // ── ct_bookings.arrived — one-shot backfill for the pre-import rows ────────
  //
  // `arrived` was added above for the importer, so it defaulted to 0 on the 40
  // bookings the phone CRM had already taken. Measured on a copy of production
  // (2026-08-13): 9 rows sit at status 'seated' and 14 at 'completed' — 23 rows
  // that describe a guest who sat at a table and are rendered "Arrived: No" by
  // every surface that reads the column. The remaining 17 (8 confirmed, 5
  // no_show, 2 cancelled, 2 pending) are correctly 0 and must stay 0.
  //
  // The derivation is isArrived(status, seatedAt) from src/lib/reservego.ts,
  // transcribed — not reinvented — so an imported row and a phone row mean the
  // same thing by the same rule: cancelled and no_show are never arrivals
  // whatever a seated stamp says, and otherwise 'seated'/'completed' or the
  // presence of a stamp is an arrival. All 40 rows have seated_at NULL today,
  // so the stamp clause changes nothing right now; it is here because the seat
  // board (src/lib/ct/seating.ts) writes seated_at and this migration must not
  // encode a narrower rule than the one the app uses.
  //
  // ONE-DIRECTIONAL, 0 → 1 ONLY. Clearing a 1 back to 0 would make this a
  // repair job competing with the importer for ownership of the column on every
  // boot; the flag below is what makes it a migration instead.
  try {
    const arrivedFlag = db.prepare("SELECT value FROM settings WHERE key = 'ct_bookings_arrived_backfill_v1'").get() as { value?: string } | undefined;
    if (!arrivedFlag) {
      const run = db.transaction(() => {
        // The import guard is the point of the WHERE clause. import_id and
        // reservego_key are both NULL only on rows the CRM typed itself; a
        // Reservego row already carries the importer's own isArrived() verdict,
        // computed from the CSV, and a boot migration second-guessing it from
        // our mapped status would overwrite the more informed answer. Both
        // columns are checked rather than one because they are written by the
        // same statement and disagreeing would mean a half-written row.
        const info = db.prepare(`
          UPDATE ct_bookings
             SET arrived = 1
           WHERE (arrived IS NULL OR arrived = 0)
             AND import_id IS NULL
             AND reservego_key IS NULL
             AND status NOT IN ('cancelled', 'no_show')
             AND (status IN ('seated', 'completed')
                  OR (seated_at IS NOT NULL AND TRIM(seated_at) <> ''))
        `).run();
        // Flag written inside the same transaction: if the process dies between
        // the two statements, neither happened and the next boot retries.
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ct_bookings_arrived_backfill_v1', '1')").run();
        return info.changes;
      });
      const changed = run();
      console.log(`[db] ct_bookings_arrived_backfill_v1: marked ${changed} pre-import booking(s) as arrived`);
    }
  } catch (e) { console.error('[db] ct_bookings_arrived_backfill_v1 failed (rolled back):', e); }

  // ══ DEPARTMENT-BASED INVENTORY — CUTOVER SCHEMA (2026-08) ═════════════════
  //
  // ONE RAIL: Central Store --requisition issue--> Department --recipe
  // consumption at KOT complete--> consumed. Every gram leaves central exactly
  // once (at issue) and leaves the department exactly once (at consumption).
  //
  // This block is SCHEMA ONLY plus one one-shot seed. It performs NO backfill
  // and re-bases NO balance. The 14,149 historic issued lines get no department
  // movement, by decision: department balances start from a counted opening
  // written by an explicit admin action (POST /api/department-ledger/cutover),
  // never by a deploy. A boot migration that wrote opening balances would be
  // inventing stock on every restart.
  //
  // The department ledger itself is department_material_transactions, created
  // ~1,200 lines above and already carrying three writers. It is not recreated
  // here — only widened. A SECOND balance table would give the app two
  // competing department truths, which is the exact failure issue-stock.ts
  // warns about in prose.
  try {
    // ── (a) STATION → DEPARTMENT MAP ────────────────────────────────────────
    // Configurable, never guessed. menu_items.station / order_items.station
    // carry 12 free-text values; `departments` has 19 rows and the names do NOT
    // string-match ('Akan  Indian' has two spaces, 'Akan Tandoori' vs station
    // 'tandoor', 'Akan - Bakery' hyphenated). A name-based lookup silently maps
    // half of them to nothing, so the mapping is DATA the owner edits, and the
    // seed below matches on UUID.
    //
    // department_id NULL = deliberately unmapped. An unmapped station must
    // SKIP the deduction and say so, never fall back to a parent department and
    // never fall back to central: debiting the wrong kitchen silently reads as
    // theft on the very variance report this change exists to produce.
    db.exec(`
      CREATE TABLE IF NOT EXISTS station_departments (
        station       TEXT PRIMARY KEY,
        department_id TEXT,
        is_active     INTEGER NOT NULL DEFAULT 1,
        note          TEXT DEFAULT '',
        updated_at    TEXT DEFAULT (datetime('now'))
      );
    `);
  } catch (e) { console.error('station_departments schema failed:', e); }

  // ── (b) ONE-SHOT SEED of the unambiguous matches ──────────────────────────
  // Guarded by settings.station_dept_seed_v1 so it runs exactly once, ever. The
  // guard is not decoration: without it an admin who DELETES a mapping row (or
  // blanks a department) gets it re-created on the next deploy, which is the
  // "roles get disturbed on every deployment" bug in a different table.
  //
  // UUIDs, not names — see (a). Every id below was read off the live
  // `departments` table; the assert re-checks at boot and skips (loudly) rather
  // than writing a dangling pointer into a stock rail.
  //
  // sushi / terracegrill / liquor / kitchen are seeded with a NULL department
  // ON PURPOSE, so they are VISIBLE as unmapped in Settings instead of being
  // absent and looking like an oversight:
  //   sushi, terracegrill — no department exists for them yet; the owner picks.
  //   liquor              — store-mapped, lives on the TGBCL store rail
  //                         (store_stock_ledger). It must never be pulled onto
  //                         the department raw-material rail.
  //   kitchen             — the BLANK-STATION SENTINEL. kot-fire.ts coerces an
  //                         empty line station to the literal 'kitchen', and
  //                         'Kitchen' is a real department (the main-kitchen
  //                         roll-up). Mapping it would silently debit the
  //                         busiest kitchen in the building for every
  //                         station-less item sold. Leave it NULL.
  try {
    const stationSeeded = db.prepare(
      "SELECT value FROM settings WHERE key = 'station_dept_seed_v1'",
    ).get() as { value?: string } | undefined;
    if (!stationSeeded) {
      const SEED: Array<{ station: string; department_id: string | null; note: string }> = [
        { station: 'continental',  department_id: 'ce314649-af35-478f-b941-ff20897ed683', note: 'Akan Continental' },
        { station: 'pan-asian',    department_id: '193757e4-bd12-4f6e-bfe7-08fd657cd055', note: 'Akan Pan Asian' },
        { station: 'indian',       department_id: '85a66e30-0a2f-4860-a4f8-4c00803e4d9c', note: 'Akan  Indian' },
        { station: 'tandoor',      department_id: '4f1309ac-bb4d-4e51-9a1a-146bfbaa6407', note: 'Akan Tandoori' },
        { station: 'pizza',        department_id: 'b725bab8-e062-4f3b-8bef-f4ac4fe518fd', note: 'Akan Pizza' },
        { station: 'bakery',       department_id: 'cfc03d24-17d9-4e05-bdce-89acf5534caf', note: 'Akan - Bakery' },
        // The bar family — three stations, one physical bar, one department.
        { station: 'bar',          department_id: '0148b272-9bb0-4deb-a4a7-eb594392cfaf', note: 'Akan Bar' },
        { station: 'cocktail',     department_id: '0148b272-9bb0-4deb-a4a7-eb594392cfaf', note: 'Akan Bar' },
        { station: 'mocktail',     department_id: '0148b272-9bb0-4deb-a4a7-eb594392cfaf', note: 'Akan Bar' },
        // Deliberately unmapped — see the header above. Do not "finish the job".
        { station: 'sushi',        department_id: null, note: 'Unmapped — no department chosen yet' },
        { station: 'terracegrill', department_id: null, note: 'Unmapped — no department chosen yet' },
        { station: 'liquor',       department_id: null, note: 'Store-mapped (TGBCL store rail), not a department' },
        { station: 'kitchen',      department_id: null, note: 'Blank-station sentinel — never map this' },
      ];
      const deptExists = db.prepare('SELECT 1 FROM departments WHERE id = ?');
      const insStation = db.prepare(`
        INSERT OR IGNORE INTO station_departments (station, department_id, is_active, note)
        VALUES (?, ?, 1, ?)
      `);
      const seedRun = db.transaction(() => {
        let mapped = 0, unmapped = 0;
        for (const row of SEED) {
          if (row.department_id && !deptExists.get(row.department_id)) {
            console.error(
              `[db] station_dept_seed_v1: department ${row.department_id} (${row.note}) does not exist — ` +
              `station '${row.station}' left UNSEEDED. Map it by hand in Settings; nothing will deduct for it until you do.`,
            );
            continue;
          }
          insStation.run(row.station, row.department_id, row.note);
          if (row.department_id) mapped++; else unmapped++;
        }
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('station_dept_seed_v1', '1')").run();
        return { mapped, unmapped };
      });
      const r = seedRun();
      console.log(`[db] station_dept_seed_v1: seeded ${r.mapped} mapped + ${r.unmapped} deliberately-unmapped station(s)`);
    }
  } catch (e) { console.error('station_dept_seed_v1 failed:', e); }

  // ── (c) DEPARTMENT LEDGER — additive columns ──────────────────────────────
  // PRAGMA-guarded, one ALTER at a time, exactly like the requisition_issue_
  // ledger block above. The CREATE TABLE stays as it shipped; THIS is the
  // single source of truth for fresh and existing databases alike (adding them
  // to the CREATE would give a fresh DB one shape and an existing one another).
  try {
    const cols = db.prepare('PRAGMA table_info(department_material_transactions)').all() as any[];
    const has = (n: string) => cols.some((c: any) => c.name === n);
    if (cols.length > 0) {
      // Ties an issue and its reversal to the SAME requisition line, so the
      // reversal cap is a per-line question, not a per-material one.
      if (!has('req_item_id'))
        db.exec('ALTER TABLE department_material_transactions ADD COLUMN req_item_id TEXT');
      // Ties a consumption row back to the exact sold line — the link the
      // issued-items log has never had.
      if (!has('order_item_id'))
        db.exec('ALTER TABLE department_material_transactions ADD COLUMN order_item_id TEXT');
      // The station that RESOLVED this department. Kept on the row because the
      // station→department map is editable: a later remap must not silently
      // rewrite what a past consumption was attributed to.
      if (!has('station'))
        db.exec('ALTER TABLE department_material_transactions ADD COLUMN station TEXT');
      // The route that wrote the row, for the audit trail.
      if (!has('source'))
        db.exec('ALTER TABLE department_material_transactions ADD COLUMN source TEXT');
    }
    // ── (d) indexes for the two hot reads ───────────────────────────────────
    // The existing idx_dept_mat_tx_dept_mat(department_id, material_id) already
    // covers the balance query; these cover the "since the anchor" window and
    // the per-line reversal cap.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_dept_mat_tx_created ON department_material_transactions(created_at);
      CREATE INDEX IF NOT EXISTS idx_dept_mat_tx_reqitem ON department_material_transactions(req_item_id);
    `);
  } catch (e) { console.error('department_material_transactions additive columns failed:', e); }

  // ── (e) CONSUMPTION SKIPS ─────────────────────────────────────────────────
  // Recipe consumption that moved NOTHING, and why. Written whenever applyDeduct
  // cannot name a department it is entitled to debit: blank station, unmapped
  // station (sushi, terracegrill), the 'kitchen' sentinel, or a store-mapped
  // (liquor) material.
  //
  // This table is the reason the skip is honest rather than invisible. Without
  // it, "we sold 40 sushi rolls and no stock moved" is indistinguishable from
  // "nothing was sold", and the department variance screen would have nothing
  // to name in its warning banner. It is an audit record, not a queue — nothing
  // replays from it, and no balance reads it.
  //
  // EVERY COLUMN IS OPTIONAL TO THE WRITER. recordConsumptionSkip() in
  // dept-ledger.ts is fail-soft by contract — it swallows its own errors so a
  // served order can never roll back over a breadcrumb — which means a column
  // this table demands but that writer does not supply would make skips vanish
  // SILENTLY. So every column carries a default, `date` included: that writer
  // omits it and lets the default fire.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS consumption_skips (
        id            TEXT PRIMARY KEY,
        -- IST calendar day. '+330 minutes' is the house convention
        -- (sales-reports.ts / sales-dashboard.ts): plain date('now') is UTC and
        -- would file an 11pm skip under yesterday on the screen that reports it.
        date          TEXT NOT NULL DEFAULT (date('now', '+330 minutes')),
        outlet_id     TEXT,
        order_id      TEXT,
        order_item_id TEXT,
        menu_item_id  TEXT,
        material_id   TEXT,
        quantity      REAL NOT NULL DEFAULT 0,    -- recipe units that WOULD have been deducted
        station       TEXT NOT NULL DEFAULT '',   -- '' = the line carried no station at all
        reason        TEXT NOT NULL DEFAULT '',   -- blank | unmapped | inactive | store_mapped | ...
        recipe_id     TEXT,
        source        TEXT NOT NULL DEFAULT '',
        notes         TEXT NOT NULL DEFAULT '',
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_consumption_skips_date_station ON consumption_skips(date, station);
    `);
  } catch (e) { console.error('consumption_skips schema failed:', e); }

  // ── (f)+(g) WASTAGE / STAFF MEAL can belong to a DEPARTMENT ───────────────
  // Nullable on purpose, and the NULL branch is not a leftover:
  //   department_id SET  → the department already holds the goods, so the debit
  //                        belongs to the DEPARTMENT ledger. Debiting central
  //                        again would remove the same gram twice and inflate
  //                        that kitchen's apparent variance by exactly the
  //                        wasted quantity.
  //   department_id NULL → the STORE found it on its own shelf. Central, as
  //                        today. Keep this branch.
  // Both tables hold 0 rows at cutover, so the column arrives with no history to
  // reinterpret and no backfill question to answer.
  try { db.exec('ALTER TABLE wastages ADD COLUMN department_id TEXT'); } catch { /* exists */ }
  try { db.exec('ALTER TABLE staff_meal_items ADD COLUMN department_id TEXT'); } catch { /* exists */ }

  // ── (h) CUTOVER STAMP ─────────────────────────────────────────────────────
  // Inert until the admin cutover action stamps it. Seeded EMPTY, and INSERT OR
  // IGNORE so a re-deploy can never un-stamp a cutover that has happened.
  //
  // This timestamp is the hard boundary, not a caption: every "history
  // excluded" label reads it, and the department balance query must FLOOR its
  // movement window at it. Without that floor a closing count backdated one day
  // before the cutover would drag months of pre-cutover issues into a balance
  // that was defined to start from a physical count.
  try {
    db.exec("INSERT OR IGNORE INTO settings (key, value) VALUES ('dept_ledger_cutover_at', '')");
  } catch (e) { console.error('dept_ledger_cutover_at seed failed:', e); }

  // ── RETURNS MODULE (spreadsheet reqs 72-79) ───────────────────────────────
  // Two new tables. Nothing else in this block: no ALTER of any existing table,
  // no backfill, no settings seed. A returns deploy must be able to land without
  // touching a single row that already exists.
  //
  // READ THIS BEFORE YOU WRITE AGAINST THESE TABLES — two rules the schema
  // cannot enforce on its own, and both of them are the expensive kind:
  //
  //   1. STOCK MOVES ONLY ON STORE ACCEPT. Raising a return moves nothing.
  //      Department-head approval moves nothing. The ONLY moment any quantity
  //      changes hands is inside the store-verify transaction, and only for a
  //      line the store actually accepted. A rejected line leaves stock exactly
  //      where it was. That single stage is also the reason there is no separate
  //      "returned stock" bucket: while a ticket sits at hod_approved the goods
  //      are physically on the store counter and nothing has moved yet, so the
  //      holding state the requirement asks for is the WORKFLOW state, not a
  //      second stock scalar. Adding a second scalar would leave the variance
  //      report, closing valuation, recipe costing, the requisition picker and
  //      reorder all wrong-by-omission.
  //
  //   2. A VENDOR RETURN AND AN INTERNAL RETURN DO OPPOSITE THINGS TO CENTRAL
  //      STOCK, and `kind` is what decides which:
  //        kind='internal' → department DOWN, central UP. The goods came out of
  //                          the store on a requisition and are going back in;
  //                          they never leave the building.
  //        kind='vendor'   → central DOWN, no department leg at all. The goods
  //                          go back out to the supplier. Crediting central here
  //                          would invent inventory that has physically left.
  //      So `kind` is set at creation and NEVER updated afterwards — a route that
  //      lets it be edited turns a settled movement into the wrong one. The CHECK
  //      below is the last line of defence, not the first.
  //
  // Quantity is carried in THREE columns because one is not enough. The screens
  // lead with the PURCHASE unit (owner rule) but the department ledger and
  // inventory_transactions take RECIPE units only and refuse to convert. So the
  // line stores what the user typed (quantity + unit), the factor used at the
  // time (pack_factor, snapshotted the same way requisition_issue_ledger snapshots
  // its own), and the derived recipe_qty. Storing the factor is what lets a
  // movement be reversed with the factor it was MADE with rather than with
  // whatever pack_size happens to say next month.
  //
  // What is deliberately NOT here: no column on goods_receipt_note_items (its
  // quantity_accepted is what decides PO completion — "how much of this GRN line
  // was already returned" is DERIVED by summing accepted_recipe_qty over verified
  // tickets, the same no-flag-column discipline receivedPoItemIds() already uses);
  // no column on po_vendor_bills (its UNIQUE key is the receive dedupe); no closed
  // status on purchase_orders (req 75's return window is read-time only, measured
  // from the GRN date, so nothing unattended ever shuts a real PO); no row in
  // wastages; and no seed for po_return_window_days — an absent key reads as '0',
  // meaning NO LIMIT, which is exactly today's behaviour.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS material_returns (
        id                    TEXT PRIMARY KEY,
        ret_number            TEXT NOT NULL UNIQUE,        -- RET-YYYY-NNNN
        -- THE FORK. Immutable after creation. See rule 2 above.
        kind                  TEXT NOT NULL CHECK (kind IN ('internal','vendor')),
        date                  TEXT NOT NULL,               -- YYYY-MM-DD, IST
        status                TEXT NOT NULL DEFAULT 'draft',
        -- draft | submitted | hod_approved | verified | hod_rejected | cancelled
        -- Its own vocabulary, not the requisition one: reusing those would put
        -- return tickets in front of store-issue's status gates.
        department_id         TEXT,                        -- REQUIRED when kind='internal', NULL for vendor
        -- Vendor anchor (req 72). Populated only when kind='vendor'; the ticket is
        -- raised FROM a GRN line, so PO No. and GRN No. are a real join and never
        -- a nearest match. NULL on internal tickets, where the chain genuinely
        -- does not exist.
        grn_id                TEXT,
        po_id                 TEXT,                        -- NULL for ad-hoc GRNs, which are common
        vendor_id             TEXT,
        vendor                TEXT DEFAULT '',             -- cached display name, as goods_receipt_notes does
        -- Credit note: RECORDED-ONLY. Never feeds stock, price or cost. There is
        -- no negative purchases row and no po_vendor_bills row for a return —
        -- updateMaterialPrice would take the return as the latest price and
        -- cascade that into every sub-recipe and recipe.
        credit_note_no        TEXT DEFAULT '',
        credit_note_date      TEXT DEFAULT '',
        credit_note_amount    REAL NOT NULL DEFAULT 0,
        notes                 TEXT DEFAULT '',
        outlet_id             TEXT,
        -- Stage 1 — raised by the department
        drafted_by            TEXT DEFAULT '',
        submitted_at          TEXT,
        submitted_by          TEXT DEFAULT '',
        -- Stage 2 — Department Head / Manager (req 73). Gated on canApproveAsChef,
        -- the ROLE flag. A department's head_user_id decides who SEES a ticket,
        -- never who may act on it; conflating the two was a live bug once.
        hod_approved_at       TEXT,
        hod_approved_by       TEXT DEFAULT '',
        hod_note              TEXT DEFAULT '',
        hod_rejected_at       TEXT,
        hod_rejected_by       TEXT DEFAULT '',
        hod_rejected_reason   TEXT DEFAULT '',             -- mandatory on reject, enforced in the route
        -- Stage 3 — Store verification (req 74), gated on canIssueAsStore.
        -- THE ONLY STAGE THAT MOVES STOCK.
        store_verified_at     TEXT,
        store_verified_by     TEXT DEFAULT '',
        store_note            TEXT DEFAULT '',
        store_rejected_at     TEXT,                        -- whole-ticket; per-line rejection lives on the line
        store_rejected_by     TEXT DEFAULT '',
        store_rejected_reason TEXT DEFAULT '',             -- mandatory
        cancelled_at          TEXT,
        cancelled_by          TEXT DEFAULT '',
        created_at            TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (department_id) REFERENCES departments(id),
        FOREIGN KEY (grn_id)        REFERENCES goods_receipt_notes(id),
        FOREIGN KEY (po_id)         REFERENCES purchase_orders(id),
        FOREIGN KEY (vendor_id)     REFERENCES vendors(id),
        FOREIGN KEY (outlet_id)     REFERENCES outlets(id)
      );

      CREATE TABLE IF NOT EXISTS material_return_items (
        id                    TEXT PRIMARY KEY,
        return_id             TEXT NOT NULL,
        material_id           TEXT NOT NULL,
        -- Quantity, three columns. See the note above the CREATE.
        quantity              REAL NOT NULL,               -- as typed, in the unit below
        unit                  TEXT NOT NULL DEFAULT '',    -- normally the PURCHASE unit
        pack_factor           REAL NOT NULL DEFAULT 1,     -- recipe units per that unit, snapshotted, both-halves guarded
        recipe_qty            REAL NOT NULL DEFAULT 0,     -- quantity * pack_factor. The only number stock ever moves by.
        reason                TEXT NOT NULL DEFAULT '',    -- req 72's per-line Reason
        -- req 78. A disposition code, NOT a second ledger: the production module
        -- already treats wasted and disposed as siblings and sums them together
        -- in its own reports. An internal line marked wastage or disposal debits
        -- the DEPARTMENT only and credits nothing — unusable goods must never
        -- re-enter the sellable pool.
        disposition           TEXT NOT NULL DEFAULT 'reusable'
                              CHECK (disposition IN ('reusable','wastage','disposal')),
        -- req 72 auto-fill anchor for a vendor line. PO No. and GRN No. are read
        -- THROUGH grn_item_id rather than stored twice.
        grn_item_id           TEXT,
        po_item_id            TEXT,
        -- Internal reference only, usually NULL. Department stock is pooled per
        -- (department, material) with no lot tracking, so most returns cannot name
        -- one requisition line. Never used as a reversal cap, and never written
        -- back to requisition_items.quantity_issued — returns are not a writer of
        -- the store's record of what it handed over.
        req_item_id           TEXT,
        -- Store verification outcome (req 74), per line
        accepted_qty          REAL NOT NULL DEFAULT 0,     -- in the unit above
        accepted_recipe_qty   REAL NOT NULL DEFAULT 0,     -- RECIPE units, what actually moved
        store_rejected        INTEGER NOT NULL DEFAULT 0,
        store_reject_reason   TEXT DEFAULT '',             -- set and cleared TOGETHER with the flag
        -- MOVEMENT RECEIPTS, written back inside the accept transaction. A
        -- non-null id is the on-the-row proof that this line moved, and moved
        -- once. A verified line with accepted_recipe_qty > 0 and a NULL receipt is
        -- a detectable integrity fault rather than a silent zero-credit.
        dept_txn_id           TEXT,                        -- department_material_transactions.id (internal only)
        inv_txn_id            TEXT,                        -- inventory_transactions.id (both kinds)
        notes                 TEXT DEFAULT '',
        created_at            TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (return_id)   REFERENCES material_returns(id) ON DELETE CASCADE,
        FOREIGN KEY (material_id) REFERENCES raw_materials(id)
      );

      CREATE INDEX IF NOT EXISTS idx_mat_returns_status     ON material_returns(status);
      CREATE INDEX IF NOT EXISTS idx_mat_returns_kind       ON material_returns(kind);
      CREATE INDEX IF NOT EXISTS idx_mat_returns_date       ON material_returns(date);
      CREATE INDEX IF NOT EXISTS idx_mat_returns_dept       ON material_returns(department_id);
      CREATE INDEX IF NOT EXISTS idx_mat_returns_grn        ON material_returns(grn_id);
      CREATE INDEX IF NOT EXISTS idx_mat_returns_outlet     ON material_returns(outlet_id);
      CREATE INDEX IF NOT EXISTS idx_mat_return_items_ret   ON material_return_items(return_id);
      CREATE INDEX IF NOT EXISTS idx_mat_return_items_mat   ON material_return_items(material_id);
      CREATE INDEX IF NOT EXISTS idx_mat_return_items_grni  ON material_return_items(grn_item_id);
    `);

    // Req 78 (owner-approved 2026-08-08): a returned item written off as
    // wastage/disposal must show on /wastage, not only in the department ledger.
    // src/lib/return-stock.ts writes the wastages row and stamps this column, so
    // the spoilage is traceable to the ticket that produced it by a real id
    // rather than a sentence in `notes`.
    //
    // ONE-SHOT and NULLABLE, so /api/wastage's own INSERT — which does not name
    // this column — keeps working unchanged and gets NULL, which is exactly
    // right: a shelf-found spoilage has no return behind it.
    const wCols = db.prepare('PRAGMA table_info(wastages)').all() as any[];
    if (!wCols.some((c: any) => c.name === 'return_item_id')) {
      db.exec(`ALTER TABLE wastages ADD COLUMN return_item_id TEXT`);
    }
  } catch (e) { console.error('material_returns schema failed:', e); }

  // ── CENTRAL STORE CUTOVER — re-base the book on a physical count ──────────
  //
  // WHY. raw_materials.current_stock is a RUNNING BALANCE, never an
  // observation: 39 writers in src/ and every one of them adds to or subtracts
  // from it. Outflows record themselves (an issue writes a row); inflows need a
  // human to type a purchase. Cash-market runs and door-drop deliveries arrive
  // physically and are never typed, so the error is one-directional and
  // cumulative, and every variance report today measures DRIFT rather than
  // LOSS. The cutover counts the shelf once, SETS the book to it, and stamps
  // the date from which a variance means something.
  //
  // TWO TABLES, AND WHY NOT THE OBVIOUS ONES:
  //   NOT closing_stock — that is the table /api/variance-report reads. Writing
  //     the count there turns every counted material into a variance line on
  //     cutover day, measured against all-time theoretical history, i.e. a
  //     fabricated shrinkage report on the exact day the owner is watching.
  //   NOT variance_approvals — a row there is an actionable admin queue item
  //     that /api/notifications/inbox counts into the bell, and approving one
  //     posts a stale count-time delta onto the freshly-corrected book. Several
  //     hundred of them would destroy the queue and could undo the cutover one
  //     click at a time.
  //   NOT inventory_transactions — an 'adjustment' row is NOT report-neutral in
  //     the negative direction: analytics (top-consumed), inventory/priority
  //     (consumption frequency) and crm-analyst-data (idle capital) all filter
  //     on `quantity < 0` with no type predicate, so a downward re-base would
  //     read as consumption. Ruling 1 says the correction never enters
  //     consumption, P&L or variance, so the cutover writes NO transaction row
  //     and central_cutover_lines IS its ledger. The trade-off is real and must
  //     be said on screen: central stock jumps with no inventory_transactions
  //     row behind it, and this table is the only record of why.
  //
  // NO outlet_id, deliberately. closing_stock and variance_approvals both carry
  // one, but raw_materials.current_stock is a SINGLE GLOBAL POOL with no outlet
  // dimension at all. A per-outlet column here would let a screen imply a
  // per-outlet cutover, which would be a lie. This re-bases the one central
  // pool, building-wide, whatever outlet the admin is sitting in.
  //
  // The stamp (settings.central_store_cutover_at) is NOT seeded or written
  // here. It is admin-owned state, written once by the explicit commit action
  // in src/lib/central-cutover.ts — mirroring dept_ledger_cutover_at above and
  // the rule scripts/check-boot-migrations.js exists to enforce.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS central_cutover_batches (
        id                 TEXT PRIMARY KEY,
        -- IST business date the shelf was physically counted. NOT the commit
        -- time: a sheet counted this morning and typed this evening is dated
        -- this morning.
        cutover_date       TEXT NOT NULL,
        status             TEXT NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft','committed','cancelled')),
        note               TEXT NOT NULL DEFAULT '',
        created_by         TEXT NOT NULL DEFAULT '',
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),
        committed_by       TEXT NOT NULL DEFAULT '',
        committed_at       TEXT NOT NULL DEFAULT '',
        cancelled_by       TEXT NOT NULL DEFAULT '',
        cancelled_at       TEXT NOT NULL DEFAULT '',
        -- SUMMARY, frozen at commit and never recomputed. These are what the
        -- single bell notification quotes ("847 counted, 612 with variance,
        -- net Rs X"). Frozen rather than derived because a line's material can
        -- later be deleted, and a headline that drifts away from the records
        -- underneath it is worse than no headline.
        counted_lines      INTEGER NOT NULL DEFAULT 0,
        variance_lines     INTEGER NOT NULL DEFAULT 0,
        -- Rs, INFORMATION ONLY (Ruling 1). Never posted anywhere.
        net_variance_value REAL NOT NULL DEFAULT 0,
        shortage_value     REAL NOT NULL DEFAULT 0,   -- absolute Rs of the down lines
        excess_value       REAL NOT NULL DEFAULT 0,   -- Rs of the up lines
        -- 1 only for the batch whose commit actually wrote the stamp. A later
        -- cutover is recorded but does not move the boundary, so it stores 0
        -- and the screen can say which run set the date.
        stamped            INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_central_cutover_batches_status
        ON central_cutover_batches(status, cutover_date);

      CREATE TABLE IF NOT EXISTS central_cutover_lines (
        id                 TEXT PRIMARY KEY,
        batch_id           TEXT NOT NULL,
        material_id        TEXT NOT NULL,
        -- Frozen label so a committed cutover still reads correctly after a
        -- material is renamed or deleted. Never join through this.
        material_name      TEXT NOT NULL DEFAULT '',
        -- THE EXISTENCE OF THIS ROW MEANS "COUNTED". There is no row for an
        -- uncounted material and no null quantity: a material with no count is
        -- left completely untouched by the commit, and a blank cell is refused
        -- at staging rather than coerced to 0. counted_qty = 0 IS a count —
        -- "we looked and found none" — and is applied like any other.
        counted_qty        REAL NOT NULL,             -- AS ENTERED, in counted_unit
        counted_unit       TEXT NOT NULL DEFAULT '',  -- the unit the human typed
        counted_basis      TEXT NOT NULL DEFAULT 'recipe'
                           CHECK (counted_basis IN ('purchase','recipe')),
        -- packFactor() at staging time, carrying the BOTH-HALVES guard. Stored
        -- so the commit can refuse a line whose material was re-based by
        -- /unit-audit after it was staged (that route rescales current_stock by
        -- fNew/fOld and would otherwise multiply a counted figure).
        pack_factor        REAL NOT NULL DEFAULT 1,
        counted_qty_recipe REAL NOT NULL DEFAULT 0,   -- the figure written to current_stock
        -- current_stock the moment this line was staged. INFORMATIONAL: it is
        -- what makes the "moved since you counted" refusal quotable. The value
        -- actually overwritten is book_qty_recipe below.
        book_qty_at_stage  REAL NOT NULL DEFAULT 0,
        staged_at          TEXT NOT NULL DEFAULT (datetime('now')),
        -- SNAPSHOT TAKEN INSIDE THE COMMIT TRANSACTION — the value this line
        -- actually overwrote. current_stock has no history of its own and is
        -- not reconstructible from inventory_transactions on this database, so
        -- these rows are the ONLY record of the pre-cutover book. 0 until the
        -- batch commits.
        book_qty_recipe    REAL NOT NULL DEFAULT 0,
        variance_recipe    REAL NOT NULL DEFAULT 0,   -- counted - book, recipe units
        recipe_unit        TEXT NOT NULL DEFAULT '',
        purchase_unit      TEXT NOT NULL DEFAULT '',
        -- Rs per PURCHASE unit from src/lib/closing-valuation.ts, NOT from
        -- raw_materials.last_purchase_price (105 rows hold that in a mixed
        -- basis, up to 5,000x out). rate_source travels with it so a screen can
        -- say where the money came from.
        unit_value         REAL NOT NULL DEFAULT 0,
        rate_source        TEXT NOT NULL DEFAULT 'none',
        variance_value     REAL NOT NULL DEFAULT 0,   -- Rs, INFORMATION ONLY
        note               TEXT NOT NULL DEFAULT '',
        -- THE ALERT RECORD. The owner asked for "an alert for every single
        -- variance". Every line whose counted figure differs from the book sets
        -- alert = 1 at commit and is listed, line by line, on the cutover
        -- review screen — nothing is aggregated away. The BELL gets ONE
        -- notification for the batch, because ~600 bell rows would destroy the
        -- bell as a tool. reviewed_at = '' is the unreviewed state, and a batch
        -- holding any line still in it is what the bell LISTS (one item, count
        -- 1) -- see unreviewedAlertBatches in src/lib/central-cutover.ts and the
        -- cutover_alerts bucket in api/notifications/inbox.
        alert              INTEGER NOT NULL DEFAULT 0,
        reviewed_by        TEXT NOT NULL DEFAULT '',
        reviewed_at        TEXT NOT NULL DEFAULT '',
        review_note        TEXT NOT NULL DEFAULT '',
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (batch_id) REFERENCES central_cutover_batches(id) ON DELETE CASCADE
      );
      -- One count per material per batch; re-staging a material UPDATEs its
      -- line rather than stacking a second quantity on the same shelf.
      CREATE UNIQUE INDEX IF NOT EXISTS uq_central_cutover_line
        ON central_cutover_lines(batch_id, material_id);
      CREATE INDEX IF NOT EXISTS idx_central_cutover_lines_batch
        ON central_cutover_lines(batch_id);
      CREATE INDEX IF NOT EXISTS idx_central_cutover_lines_material
        ON central_cutover_lines(material_id);
      -- The bell + review screen read exactly this: unreviewed alert lines.
      CREATE INDEX IF NOT EXISTS idx_central_cutover_lines_alert
        ON central_cutover_lines(alert, reviewed_at);
    `);
  } catch (e) { console.error('central_cutover schema failed:', e); }

  // ══ CASHIER FLOOR PRESENCE — who is manning which floor, right now ════════
  //
  // WHY A NEW TABLE, when three things in this database already look like they
  // could carry it. All three were checked and all three are wrong:
  //
  //   sessions (token, user_id, created_at, expires_at) has no floor and no
  //   activity stamp, and a session lives 30 days — so "holds a session" is not
  //   "is standing at the till".
  //
  //   print_agent_heartbeat has a heartbeat, but its PRIMARY KEY is outlet_id
  //   ALONE, so two counters on two floors overwrite each other; its own
  //   heartbeat route resolves the user and then throws it away.
  //
  //   users.preferred_zones is already spoken for. captainAreaFilter() in
  //   src/lib/captain-area.ts reads it for ANY staff-tier user, and the seeded
  //   Cashier role is staff tier — so reusing that column would mean the day
  //   anyone switches captain_area_lock on, an assigned cashier could no longer
  //   work tables outside their billing floor. Presence is its own concept and
  //   gets its own table.
  //
  // FLOOR = restaurant_tables.zone, verbatim. An order reaches a floor through
  // its table_id; a takeaway/delivery order has no table and therefore no
  // floor at all. An empty zone ('') is a REAL floor — the unzoned tables the
  // captain UI labels "Floor" — which is why this column is NOT NULL DEFAULT ''
  // rather than nullable, and why '' must never be treated as "unset".
  //
  // ONE CASHIER PER FLOOR: PRIMARY KEY (outlet_id, floor). A replacement
  // cashier UPSERTs over the row, so a handover is a single write and there is
  // never an instant where two people both hold Floor 2. The consequence is
  // deliberate: this is a LIVE REGISTER, not an audit log, and it keeps no
  // shift history. The record of who actually took money is
  // order_payments.created_by, written on every settle — that is the row an
  // auditor reads, and it is unaffected by anything here.
  //
  // outlet_id '' = the NULL/default outlet — the same convention
  // print_agent_heartbeat uses. checked_out_at '' = still on duty, empty string
  // rather than NULL so no query needs a NULL guard.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cashier_presence (
        outlet_id      TEXT NOT NULL DEFAULT '',   -- '' = the NULL/default outlet
        floor          TEXT NOT NULL DEFAULT '',   -- restaurant_tables.zone; '' = the unzoned "Floor"
        user_id        TEXT NOT NULL,
        user_name      TEXT NOT NULL DEFAULT '',   -- denormalised so the floor board renders without a join
        checked_in_at  TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen      TEXT NOT NULL DEFAULT (datetime('now')),
        checked_out_at TEXT NOT NULL DEFAULT '',   -- '' = still on duty
        PRIMARY KEY (outlet_id, floor)
      );
    `);
    // A person is in ONE place: checkIn() releases every other floor the user
    // holds before taking a new one, and the post-login prompt asks "where am I
    // already checked in?". Both are lookups by user_id. The per-floor read and
    // the floor board ride the PRIMARY KEY, so this is the only index needed.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_cashier_presence_user ON cashier_presence(user_id)`);

    // STALENESS. Presence MUST expire: a cashier who went home would otherwise
    // still hold Floor 2 tomorrow — refusing every other STAFF user a settle
    // there and leaving managers to settle only via recorded overrides
    // (src/lib/settle-authority.ts, the override model). 720 minutes = 12
    // hours of INACTIVITY (src/lib/cashier-
    // presence.ts bumps last_seen on every touch, so this measures silence, not
    // shift length) — longer than any single service, short enough that every
    // floor is free again by the next day's open.
    //
    // Expiry can only ever WIDEN who may settle, never narrow it: an expired
    // floor reads as "no cashier on this floor", which is the branch that lets
    // manager/admin — and the expired cashier themselves — settle. So a wrong
    // value here cannot strand a payment.
    //
    // INSERT OR IGNORE: an admin who tunes this keeps their value across every
    // future deploy.
    db.exec("INSERT OR IGNORE INTO settings (key, value) VALUES ('cashier_presence_timeout_min', '720')");
  } catch (e) { console.error('cashier_presence schema failed:', e); }

  // ══ SEED DEFECT REPAIR — the Cashier role never granted /cashier ═══════════
  //
  // THE DEFECT. The seeded Cashier role (the `seeds` array further up this file)
  // ships page_access
  //   ["/dine-in/floor","/dine-in/tables","/dine-in/order","/captain",
  //    "/dine-in/reservations"]
  // and has never contained "/cashier". Measured against the live database on
  // 2026-08-11: the row matches that seed exactly (the reservations entry came
  // from the one-shot nav-continuity grant above). So a user assigned the
  // Cashier role cannot open the cashier console at all — and now that settle
  // authority is gated on tillCapable() in src/lib/settle-authority.ts, which
  // requires staff to hold an EXPLICIT /cashier grant (deliberately NOT
  // canAccessPage, whose null map grants everything and would pass captains),
  // that same seed defect would refuse a cashier the right to settle. Shipping
  // the gate without this repair locks the till.
  //
  // WHY ONE-SHOT, NOT A PLAIN UPDATE. A blind UPDATE on every boot is exactly
  // what scripts/check-boot-migrations.js exists to stop: page access is
  // admin-owned state, a WHERE clause cannot tell "never granted" from
  // "deliberately revoked", and a recompute-on-boot silently reverts the admin
  // on the next deploy. That has already happened once in this file (see the
  // nav-continuity note). So this runs ONCE, records itself in settings, and
  // can never run again — if an admin revokes /cashier from the Cashier role
  // tomorrow, it stays revoked forever, deploy after deploy.
  //
  // WHY IT IS SAFE TO WRITE AT ALL. It repairs OUR seed, not the admin's
  // choice: /cashier has never been in that row for an admin to have formed an
  // opinion about, because the seed never put it there and the page has never
  // been reachable for that role. The write is additive (json_insert of one
  // path), and it deliberately skips:
  //   - a role that is no longer NAMED 'Cashier' (renamed = the admin owns it),
  //   - a NULL page_access (= all pages already; nothing to add),
  //   - a row that somehow already holds the path.
  // Same shape, same guard, same precedent as the nav-continuity grants.
  //
  // WHAT IT DELIBERATELY DOES NOT DO: it does not grant /cashier to Floor
  // Manager, Bar Manager or any other role. Those maps were written by a human
  // and adding to them would be inventing intent. And under the override model
  // (src/lib/settle-authority.ts tillCapable) manager/admin TIER settles
  // regardless of page maps — this grant is what lets a STAFF user assigned
  // the Cashier role pass the till capability test, and page maps remain a
  // configuration decision for /settings/roles.
  try {
    const cashierPageGranted = db.prepare("SELECT value FROM settings WHERE key='cashier_role_page_grant_v1'").get() as any;
    if (!cashierPageGranted) {
      // '"/cashier"' is quoted on BOTH sides, so the LIKE is an exact JSON
      // element test — it cannot be satisfied by a longer path that merely
      // starts with /cashier.
      db.prepare(
        `UPDATE roles
            SET page_access = json_insert(page_access, '$[#]', '/cashier'),
                updated_at  = datetime('now')
          WHERE name = 'Cashier'
            AND page_access IS NOT NULL
            AND json_valid(page_access)
            AND page_access NOT LIKE '%"/cashier"%'`,
      ).run();
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('cashier_role_page_grant_v1', '1')").run();
    }
  } catch (e) { console.error('cashier_role_page_grant_v1 migration failed:', e); }

  // ── Discount request limits — ONE-SHOT, the owner's stated policy ──────────
  //
  // Measured 2026-08-12: EVERY seeded role had can_request_discount = 0 and
  // max_discount_pct = 0, so nobody could request a discount at all — not even
  // an Administrator. The owner set the policy: Cashier 10%, Manager 30%,
  // Administrator 100%. Approval is unchanged and still a live Manager/Admin
  // login at the till (orders/[id]/discount verifies it on the spot), so this
  // grants the right to ASK, never the right to approve.
  //
  // WHY THIS ALSO UNBLOCKS ADMINS. auth.ts computes can_request_discount = true
  // for the admin tier unconditionally, but the discount ROUTE does not — it
  // reads the role row and compares max_discount_pct. With the row at 0 an
  // admin was refused by their own limit while the session said they were
  // allowed. Setting Administrator to 100 makes the two agree.
  //
  // ONE-SHOT AND NON-CLOBBERING, for the same reason as the grant above: these
  // are admin-owned decisions and scripts/check-boot-migrations.js exists to
  // keep deploys out of them. The flag stops it re-running, and each UPDATE is
  // additionally guarded on can_request_discount = 0 so a limit an admin has
  // since tuned in Settings -> Roles is never overwritten, even if the flag
  // were lost.
  //
  // DELIBERATELY NOT INCLUDED: Bar Manager, Floor Manager, Head Chef, Store
  // Manager. The owner named three roles; extending a money permission to roles
  // he did not name is not mine to do. Any of them can be enabled in
  // Settings -> Roles.
  try {
    const done = db.prepare("SELECT value FROM settings WHERE key='discount_limits_v1'").get() as any;
    if (!done) {
      const grant = db.prepare(
        `UPDATE roles SET can_request_discount = 1, max_discount_pct = ?, updated_at = datetime('now')
          WHERE name = ? AND can_request_discount = 0`,
      );
      for (const [role, pct] of [['Cashier', 10], ['Manager', 30], ['Administrator', 100]] as const) {
        grant.run(pct, role);
      }
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('discount_limits_v1', '1')").run();
    }
  } catch (e) { console.error('discount_limits_v1 migration failed:', e); }
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
 * A short, scanner + human friendly code for a fired item's sticker-KOT
 * (Crockford base32, no ambiguous I/L/O/U). 6 chars ≈ 1e9 combos; we retry on
 * the rare collision against a live scan_code. Short enough to fit a 1D barcode
 * on 80mm and to type as a manual fallback on the Scan-Out board.
 */
export function genScanCode(db: import('better-sqlite3').Database): string {
  const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  for (let attempt = 0; attempt < 10; attempt++) {
    let c = '';
    for (let i = 0; i < 6; i++) c += A[Math.floor(Math.random() * 32)];
    try {
      const hit = db.prepare('SELECT 1 FROM order_items WHERE scan_code = ?').get(c);
      if (!hit) return c;
    } catch { return c; }
  }
  return 'IT' + Date.now().toString(36).toUpperCase().slice(-6);
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
    // NOT a raw-material pair at all: a sub-recipe is an intermediate, it has
    // no purchase unit and no pack. sr.cost_per_unit is sub_recipes.cost_per_unit
    // = total_cost ÷ yield_quantity (written by recalculateSubRecipeCost just
    // below), i.e. ₹ per the sub's OWN yield_unit. sr.quantity is
    // recipe_sub_recipes.quantity, which every writer pins to that same
    // yield_unit: /recipes locks the Unit cell to sub.yield_unit on create and
    // on edit, /api/recipes/bulk raises a unit warning when a CSV row disagrees,
    // and the workbook importer writes 'g' on both sides. So no conversion
    // belongs here, and /recipes mirrors this exact product client-side.
    // rate-basis: recipe (qty in the sub's yield unit × ₹ per that yield unit)
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
  `).run(Math.round(totalCost * 100) / 100, Math.round(costPerUnit * 10000) / 10000, subRecipeId);

  // Cascade: update all recipes using this sub-recipe
  const linkedRecipes = db.prepare(`
    SELECT DISTINCT recipe_id FROM recipe_sub_recipes WHERE sub_recipe_id = ?
  `).all(subRecipeId) as any[];

  for (const link of linkedRecipes) {
    recalculateRecipeCost(db, link.recipe_id);
  }
}

// Cascade cost recalculation for a batch of materials whose average_price
// (or unit/pack basis) was changed DIRECTLY — i.e. not via updateMaterialPrice,
// which cascades on its own. Every route that writes raw_materials.average_price
// (rate editors, importers, unit-audit rebase, admin normalizers) MUST call this
// afterwards, or recipes.total_cost keeps showing costs at the OLD prices while
// detail lines compute live — the "header says ₹303.99, lines sum ₹120.52" bug.
// Dedupes across materials; sub-recipes first (each cascades to its parent
// recipes), then direct recipes. Idempotent.
export function recalculateCostsForMaterials(
  db: Database.Database,
  materialIds: Array<string | null | undefined>,
): { sub_recipes: number; recipes: number } {
  const ids = [...new Set(materialIds.filter(Boolean) as string[])];
  if (!ids.length) return { sub_recipes: 0, recipes: 0 };
  const subQ = db.prepare('SELECT DISTINCT sub_recipe_id AS id FROM sub_recipe_ingredients WHERE material_id = ?');
  const recQ = db.prepare('SELECT DISTINCT recipe_id AS id FROM recipe_ingredients WHERE material_id = ?');
  const subSet = new Set<string>();
  const recSet = new Set<string>();
  for (const mid of ids) {
    for (const s of subQ.all(mid) as any[]) subSet.add(s.id);
    for (const r of recQ.all(mid) as any[]) recSet.add(r.id);
  }
  for (const sid of subSet) recalculateSubRecipeCost(db, sid);
  for (const rid of recSet) recalculateRecipeCost(db, rid);
  return { sub_recipes: subSet.size, recipes: recSet.size };
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

// Deduct inventory for a sale.
//
// DEPARTMENT-BASED INVENTORY (cutover 2026-08). Recipe consumption no longer
// touches raw_materials.current_stock at all. The gram left CENTRAL at the
// requisition issue (src/lib/issue-stock.ts, now unconditional); this function
// takes it out of the DEPARTMENT that cooked the dish. Stock moves exactly
// once on each leg — a central debit here would be the second removal of the
// same gram, and all 131 recipe-ingredient materials are also
// requisition-issued, so it would hit every one of them.
//
// The department is resolved from opts.station ONLY, via the editable
// station→department map. It is never guessed:
//   resolved              → post a signed 'consumption' row to the department
//                           ledger. Central untouched.
//   blank / unmapped      → post to NO stock rail, write a consumption_skips
//   (sushi, terracegrill,   row naming the station, and let the UI say so.
//    'kitchen' sentinel)    Debiting the wrong kitchen silently reads as theft
//                           on the very variance report this change exists for.
//   store-mapped material → skipped on BOTH rails. Liquor lives on the TGBCL
//                           store ledger and must not be pulled onto the
//                           department raw-material rail.
//
// THE inventory_transactions ROW IS ALWAYS WRITTEN, on every branch, exactly
// where it was before — it is what the Variance Report and Sales-vs-Purchase
// read, so their numbers are bit-identical through the cutover. See the warning
// repeated at the two INSERT sites below.
//
// FAIL-SAFE OPT-IN FLOOR ROUTING (Multi-floor bar, Phase 2/3):
// `opts.storeId` is passed ONLY by the two dine-in call sites (KDS bump + settle
// backstop), resolved from the order → table.zone → floor store. The other three
// call sites (/api/sales, /api/sales-import, /api/seed) pass nothing → unchanged.
// For each ingredient, IF the setting tm_floor_autodeduct == "1" AND opts.storeId
// is set AND the material is store-held (owned by a store via its category OR
// already has a ledger row in that floor store), the deduction is posted as an
// OUTWARD store_stock_ledger row on opts.storeId INSTEAD of decrementing central
// raw_materials.current_stock. On ANY error the code FALLS BACK to the central
// UPDATE (a sale must never fail because of floor routing). Setting OFF (default)
// or no storeId => byte-identical to the original behaviour. The
// inventory_transactions audit row is ALWAYS written, on either path.
export function deductInventoryForSale(
  db: Database.Database,
  recipeId: string,
  quantity: number,
  saleId: string,
  billType: string,
  opts?: { storeId?: string; station?: string | null; orderItemId?: string | null },
): void {
  const floorStoreId = opts?.storeId ? String(opts.storeId).trim() : '';
  // The station of the SOLD LINE (order_items.station). Never kots.station:
  // kot-fire.ts coerces a blank line station to the literal 'kitchen' when the
  // KOT is written, and 'Kitchen' is a real department, so resolving from the
  // KOT would silently debit the main kitchen for every station-less item.
  const station = String(opts?.station ?? '').trim();
  const orderItemId = opts?.orderItemId ? String(opts.orderItemId) : null;

  // Load store-engine ONCE, unconditionally — the liquor carve-out needs
  // isStoreMappedMaterial on every call now, not only when a floor store was
  // supplied. Deferred require, not an import: store-engine imports generateId
  // from here, so a static import is a cycle. A future engineer "tidying" this
  // into an import reintroduces it.
  let se: typeof import('./store-engine') | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    se = require('./store-engine') as typeof import('./store-engine');
  } catch (e) {
    console.error('store-engine load failed — consumption will be SKIPPED, never charged to central', e);
    se = null;
  }
  // Floor routing stays opt-in and is still only consulted when a caller asked
  // for it. Any failure disables routing, never the sale.
  let routeEnabled = false;
  if (floorStoreId && se) {
    try {
      routeEnabled = se.floorAutoDeductEnabled(db);
    } catch (e) {
      console.error('floor auto-deduct: setting read failed, routing disabled for this sale', e);
      routeEnabled = false;
    }
  }
  const ledgerHasRow = db.prepare(
    'SELECT 1 FROM store_stock_ledger WHERE store_id = ? AND material_id = ? LIMIT 1',
  );

  // Resolve the DEPARTMENT ONCE per sale, from the station, through the
  // editable station→department map. The resolver NEVER guesses: it hands back
  // {departmentId: null, reason} for blank / unmapped / inactive, and its
  // reason string is what the skip row records.
  //
  // FAILS TO A SKIP, NEVER TO CENTRAL. Falling back to a central debit would
  // remove the gram a second time (it left at the issue); falling back to a
  // guessed department would debit the wrong kitchen. Doing nothing, loudly, is
  // the only honest failure available here.
  const resolution = resolveStationDepartment(db, station);
  const departmentId: string | null = resolution.departmentId;
  const unresolvedReason: string = resolution.reason || 'no_department';

  // Audit row for a consumption that moved nothing. recordConsumptionSkip is
  // fail-soft by contract — a missing table or bad column returns false rather
  // than throwing — because this runs on the KOT-completion path and a lost
  // breadcrumb must never roll back a served order.
  //
  // The recipe id rides in `notes` for now: consumption_skips carries a
  // recipe_id column but recordConsumptionSkip does not populate it yet.
  const recordSkip = (materialId: string, qty: number, reason: string): void => {
    recordConsumptionSkip(db, {
      station,
      reason,
      materialId,
      quantity: qty,
      orderItemId,
      source: 'recipe_consumption',
      notes: `recipe:${recipeId} sale:${saleId}`,
    });
  };

  // Store-mapped lookup, memoised per call by category (one query per distinct
  // category instead of one per ingredient). Returns null for UNKNOWN, which is
  // treated as store-mapped by the caller: with the check unavailable we cannot
  // prove a material belongs on the department rail, and posting a liquor
  // movement into a kitchen's balance is not recoverable by a later count.
  const storeMappedMemo = new Map<string, boolean>();
  const storeMapped = (materialId: string, category: string | null): boolean | null => {
    if (!se) return null;
    const key = String(category ?? '').trim() || materialId;
    const cached = storeMappedMemo.get(key);
    if (cached !== undefined) return cached;
    try {
      const v = se.isStoreMappedMaterial(db, key);
      storeMappedMemo.set(key, v);
      return v;
    } catch (e) {
      console.error(`store-mapped check failed for '${key}' — treating as store-mapped (skip)`, e);
      return null;
    }
  };

  /**
   * Move `totalDeduct` recipe-units of one material off the rail that is
   * entitled to lose it. Exactly one rail, or none — never central.
   *
   *   1. floor store   (opt-in, unchanged, still first)
   *   2. store-mapped  → skip both rails, record why (liquor keeps its own rail)
   *   3. department    → signed 'consumption' row on the department ledger
   *   4. otherwise     → move NOTHING, record why
   *
   * Always safe to call; never throws. The caller writes its
   * inventory_transactions row regardless of which branch runs here.
   */
  const applyDeduct = (materialId: string, category: string | null, totalDeduct: number): void => {
    // A zero, negative or non-finite quantity is bad recipe data, not a
    // movement. Previously it fell through to `current_stock - 0` (a no-op) or,
    // for NaN, poisoned the column. Nothing to move, nothing to record.
    if (!Number.isFinite(totalDeduct) || totalDeduct <= 0) return;

    if (routeEnabled && se && floorStoreId && totalDeduct > 0) {
      try {
        const owned = se.materialStoreId(db, { category }) != null;
        const held = owned || !!ledgerHasRow.get(floorStoreId, materialId);
        if (held) {
          se.postLedger(db, {
            store_id: floorStoreId,
            material_id: materialId,
            txn_type: 'outward',
            quantity: -totalDeduct,
            ref: saleId,
            notes: `Floor auto-deduct (sale ${saleId})`,
          });
          return; // routed to floor ledger — skip the central UPDATE
        }
      } catch (e) {
        console.error(`floor auto-deduct failed for material ${materialId}, falling back to central`, e);
        // fall through to central UPDATE below
      }
    }
    // LIQUOR KEEPS ITS OWN RAIL. Store-mapped materials live on
    // store_stock_ledger (TGBCL) and are skipped by the central debit at issue
    // too, so there is no department holding to draw down here. `null` means
    // the check itself was unavailable and is treated the same way — an
    // unprovable material must not be posted onto a kitchen's balance.
    // Do NOT "simplify" this away: without it, a cocktail sale would debit the
    // bar department for spirits that never entered the department rail.
    const mapped = storeMapped(materialId, category);
    if (mapped !== false) {
      recordSkip(materialId, totalDeduct, mapped === null ? 'store_check_unavailable' : 'store_mapped');
      return;
    }

    // THE DEPARTMENT LOSES THE GRAM. Signed, negative, recipe units — the sign
    // is what the balance sums. Central is NOT touched: it lost this gram at
    // the requisition issue.
    if (departmentId) {
      try {
        postDeptLedger(db, {
          departmentId,
          materialId,
          type: 'consumption',
          quantity: -totalDeduct,
          referenceId: saleId,
          orderItemId,
          station,
          source: 'recipe_consumption',
          notes: `Recipe consumption (sale ${saleId})`,
        });
      } catch (e) {
        // A sale must never fail because the ledger post failed. Record the
        // miss instead — an under-deducted department is visible and fixable
        // at the next count; a failed settle is not.
        console.error(`dept ledger post failed for material ${materialId}, recording a skip`, e);
        recordSkip(materialId, totalDeduct, 'dept_post_failed');
      }
      return;
    }

    // NO DEPARTMENT COULD BE NAMED → MOVE NOTHING, ANYWHERE. Blank station,
    // unmapped station (sushi, terracegrill), the 'kitchen' sentinel, or the
    // map being unreadable. Do NOT add a fallback here — not central, not a
    // parent department, not "the main kitchen". Debiting the wrong kitchen
    // silently reads as theft on the department variance report; a recorded
    // skip reads as the data gap it actually is.
    recordSkip(materialId, totalDeduct, unresolvedReason);
  };

  // Deduct raw ingredients
  const ingredients = db.prepare(`
    SELECT ri.*, rm.current_stock, rm.unit AS material_unit, rm.name AS material_name, rm.pack_size AS material_pack_size, rm.category AS material_category
    FROM recipe_ingredients ri
    JOIN raw_materials rm ON ri.material_id = rm.id
    WHERE ri.recipe_id = ? AND ri.is_default = 1
  `).all(recipeId) as any[];

  const txType = billType === 'nc' ? 'nc' : billType === 'complimentary' ? 'nc' : 'sale';

  for (const ing of ingredients) {
    const qtyInMatUnit = convertToMaterialUnit(ing.quantity, ing.unit, ing.material_unit, ing.material_name, ing.material_pack_size);
    const effectiveQty = qtyInMatUnit * (1 + ing.wastage_percent / 100) / (ing.yield_percent / 100);
    const totalDeduct = effectiveQty * quantity;

    applyDeduct(ing.material_id, ing.material_category, totalDeduct);

    // ALWAYS WRITTEN, ON EVERY BRANCH ABOVE — including the skips. This row is
    // what the Variance Report / Daily Roll-up / Sales-vs-Purchase read.
    // Do NOT "simplify" this by gating the transaction row too — recipe_to_date
    // would collapse to 0 and every variance line would report the whole
    // purchase history as shrinkage.
    db.prepare(`
      INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(generateId(), ing.material_id, txType, -totalDeduct, saleId, `Sale of ${quantity}x recipe ${recipeId}`);
  }

  // Deduct sub-recipe ingredients.
  //
  // A sub-recipe INHERITS THE PARENT DISH'S DEPARTMENT — `departmentId` was
  // resolved once, from the sold line's station, and every branch below reuses
  // it. That is right while a sauce is made in the same kitchen that plates the
  // dish, and wrong the moment a shared prep kitchen makes it for several
  // stations: the consuming station's department is debited, not the one that
  // actually held the goods. Harmless today (recipe_sub_recipes holds 0 rows),
  // and the Kitchen Production module — where a batch is produced in one
  // department and drawn by others — is where it will first bite. Fixing it
  // means resolving a department per sub-recipe, not per sale.
  const subRecipes = db.prepare(`
    SELECT rs.*, sr.yield_quantity
    FROM recipe_sub_recipes rs
    JOIN sub_recipes sr ON rs.sub_recipe_id = sr.id
    WHERE rs.recipe_id = ?
  `).all(recipeId) as any[];

  for (const sr of subRecipes) {
    const subIngredients = db.prepare(`
      SELECT sri.*, rm.current_stock, rm.unit AS material_unit, rm.name AS material_name, rm.pack_size AS material_pack_size, rm.category AS material_category
      FROM sub_recipe_ingredients sri
      JOIN raw_materials rm ON sri.material_id = rm.id
      WHERE sri.sub_recipe_id = ? AND sri.is_default = 1
    `).all(sr.sub_recipe_id) as any[];

    const ratio = sr.quantity / (sr.yield_quantity || 1);

    for (const ing of subIngredients) {
      const qtyInMatUnit = convertToMaterialUnit(ing.quantity, ing.unit, ing.material_unit, ing.material_name, ing.material_pack_size);
      const effectiveQty = qtyInMatUnit * (1 + ing.wastage_percent / 100) / (ing.yield_percent / 100);
      const totalDeduct = effectiveQty * ratio * quantity;

      applyDeduct(ing.material_id, ing.material_category, totalDeduct);

      // ALWAYS WRITTEN, ON EVERY BRANCH — see the identical note in the raw
      // ingredient loop. Gating this row collapses recipe_to_date to 0 and
      // reports the whole purchase history as shrinkage.
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
  // FAIL-SAFE FLOOR ROUTING (Multi-floor bar Phase 2/3): the resolved floor bar
  // store (order → table.zone → resolveFloorStore) for the dine-in settle
  // backstop only. Forwarded verbatim to deductInventoryForSale's opts.storeId;
  // absent (the default, and for /api/sales/-import/seed) => central behaviour,
  // byte-identical to before. Routing is still gated on tm_floor_autodeduct.
  store_id?: string;
  // DEPARTMENT ROUTING (deduct-at-issue cutover). order_items.station of the
  // SOLD LINE — the only field that resolves the department that cooked it.
  // Never kots.station (blank is coerced to the literal 'kitchen' there, and
  // 'Kitchen' is a real department), and never `category` (sales-import puts
  // the Recaho menu category in that field). Absent / blank / unmapped =>
  // applyDeduct moves nothing and records the skip. There is no fallback.
  station?: string | null;
  // Optional back-link from a department consumption row to the exact sold
  // line. Nothing supplies it yet on this path: the KDS bump calls
  // deductInventoryForSale directly and passes the order-item id as its
  // saleId, so that path's ledger reference_id already carries it.
  order_item_id?: string | null;
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
    // Forward the caller-resolved floor store (settle backstop) and the sold
    // line's station verbatim. opts is passed UNCONDITIONALLY so the station
    // always reaches the deduct; a missing storeId normalises to '' inside
    // deductInventoryForSale, which is exactly what `undefined` did before.
    // Pass a blank station through rather than dropping it — the skip and its
    // reason are the record that a department could not be named.
    deductInventoryForSale(
      db, s.recipe_id, s.quantity_sold, id, billType,
      { storeId: s.store_id, station: s.station ?? null, orderItemId: s.order_item_id ?? null },
    );
  }
  return id;
}
