import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { buildRecipeMatcher } from '@/lib/recipe-matcher';
import { MAX_CATEGORY_LEN, ensureMenuCategory, sanitizeCategoryName, findMenuCategory } from '@/lib/menu-category';
import { findStationRow, stationSpellingForWrite } from '@/lib/station-master';

interface ImportRow {
  category?: string;
  name: string;
  variation?: string;
  selling_price?: number;
  listing_price?: number;
  master_status?: string;
  item_type?: string;
  tax_value?: number;
  item_code?: string;
  station?: string;
  dietary_tag?: string;
  pos_id?: string;
  /** Stable menu_items.id from our own export — preferred match key (survives renames). */
  item_id?: string;
  /**
   * Values the IMPORTER DERIVED for what the sheet does not say — a column it
   * does not carry, or a cell it left blank: the recipe template's
   * category→station map, its initials item code, its 5% tax, the dietary tag
   * read out of the item name. A derived value is a GUESS, so it seeds a NEW
   * item and NOTHING ELSE: an existing item preserves what it has. (It used to
   * also fill a blank field on an existing one — that is how a sheet with no
   * Station column silently wrote 'tandoor' onto blank-station items while the
   * report said they "kept their station". The one surviving fill is
   * `fallback.station`, behind the explicit fill_station_from_category opt-in
   * below, and only for names the station master actually has.)
   */
  fallback?: {
    station?: string;
    item_code?: string;
    tax_value?: number;
    dietary_tag?: string;
  };
}

/** The sheet columns this route understands, by the ImportRow field they fill. */
const FILE_FIELDS = [
  'category', 'selling_price', 'listing_price', 'master_status', 'item_type',
  'tax_value', 'item_code', 'station', 'dietary_tag', 'pos_id',
] as const;
type FileField = (typeof FILE_FIELDS)[number];

/** Column captions for the report, so it names what the file did not carry. */
const FIELD_LABEL: Record<FileField, string> = {
  category: 'Category', selling_price: 'Selling Price', listing_price: 'Listing Price',
  master_status: 'Master Status', item_type: 'Item Type', tax_value: 'Tax Value',
  item_code: 'Item Code', station: 'Station', dietary_tag: 'Dietary Tag', pos_id: 'POS ID',
};

// Typo fixes
const TYPO_MAP: Record<string, string> = {
  'COSMOPOLTIAN': 'COSMOPOLITAN',
  'GLENMORNGIE': 'GLENMORANGIE',
  'HEINKEIN': 'HEINEKEN',
  'HOEGARDEN': 'HOEGAARDEN',
  'BUDWISER': 'BUDWEISER',
  'VERMOTH': 'VERMOUTH',
  'EXPRESSO': 'ESPRESSO',
  'TOBASCO': 'TABASCO',
  'CARDMOM': 'CARDAMOM',
  'DECOCOTION': 'DECOCTION',
  'STRREETS': 'STREETS',
  'BTTL': 'BOTTLE',
};

function fixTypos(name: string): string {
  let fixed = name;
  // Replace whole-word typos (case-insensitive, preserves case pattern)
  for (const [bad, good] of Object.entries(TYPO_MAP)) {
    const re = new RegExp(`\\b${bad}\\b`, 'gi');
    if (re.test(fixed)) {
      fixed = fixed.replace(re, (match) => {
        // Preserve case: if match was all caps, keep all caps
        if (match === match.toUpperCase()) return good;
        if (match === match.toLowerCase()) return good.toLowerCase();
        return good.charAt(0).toUpperCase() + good.slice(1).toLowerCase();
      });
    }
  }
  return fixed;
}

function normalizeName(name: string): string {
  // Strip extra spaces, trim
  return fixTypos(name.replace(/\s+/g, ' ').trim());
}

/**
 * Canonical item_type: lowercase + trailing non-alphanumerics stripped
 * ('Beverages.' → 'beverages'). POS sheets shipped a trailing dot which made
 * the type filter and stat-bar counts match nothing; mirrors the normalizer in
 * /api/menu-items (data repaired one-time in db.ts via menu_item_type_normalize_v1).
 */
function normalizeItemType(v: unknown): string {
  return String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9]+$/, '');
}

export async function POST(request: Request) {
  // NO NEW GATE ON THE IMPORT ITSELF. This route has never carried one (it
  // leans on the proxy, which authenticates and demands CSRF but checks no
  // role), the Import button on /menu-items is not admin-only either, and
  // taking that away from whoever uses it today is not this change's business.
  // What IS this change's business: it taught this route to write
  // `menu_categories`, whose own endpoint is requireRole('admin') on both
  // POST and PUT. Growing an admin-owned master from an ungated route is the
  // hole, so the MINTING is re-gated at admin — exactly the shape the HR
  // employee importer uses ("creating masters is admin-only even though the
  // import itself is canManageHr").
  try {
    const db = getDb();
    // Resolved here — INSIDE the try, so a session read that throws still comes
    // back as this route's own {error} shape, and BEFORE the transaction opens,
    // because better-sqlite3 is synchronous and no `await` may appear inside one.
    const me = await getCurrentUser();
    const canMintCategories = me?.role === 'admin';
    const actorEmail = me?.email || '';
    const outletId = await getCurrentOutletId();
    const body = await request.json();
    const { rows, overwrite_existing = false, fix_typos = true, strip_spaces = true, skip_inactive = false, skip_zero_price = false, link_materials = true, present_columns, fill_station_from_category = false } = body as {
      rows: ImportRow[];
      overwrite_existing?: boolean;
      fix_typos?: boolean;
      strip_spaces?: boolean;
      skip_inactive?: boolean;
      skip_zero_price?: boolean;
      /**
       * THE COLUMNS THE SHEET ACTUALLY CARRIED (ImportRow field names), as read
       * off its header row by the importer. See `supplied()` below: this is what
       * lets the route tell "the file has no Station column" from "the file has
       * a Station column and this cell is blank".
       */
      present_columns?: string[];
      // Auto-link unmatched items to a raw material by EXACT name/SKU only.
      // Right for the POS/liquor import (BUDWEISER → material), but wrong for a
      // food menu where every item should be a recipe — a food menu sends
      // link_materials=false so a soup never links to "TOMATO KETCHUP".
      link_materials?: boolean;
      /**
       * EXPLICIT OPT-IN, DEFAULT OFF: let the recipe template's hard-coded
       * category→station map (import-parse.ts, `fallback.station`) put a
       * station on items that have NONE — new items, and existing items whose
       * station is blank. Even opted in, a map value never OVERWRITES a
       * station, and a name the station master cannot resolve is never written
       * (it lands in station_fill_skipped_not_in_master instead — the map is a
       * free-typed guess, not the master). OFF — the default, and what every
       * caller that does not say otherwise gets — means a sheet with no
       * Station column touches NO station at all. HIGH-A was this fill running
       * unasked: 5 blank-station items silently became 'tandoor' while the
       * report counted the same 5 as "kept their station".
       */
      fill_station_from_category?: boolean;
    };

    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return Response.json({ error: 'rows array is required' }, { status: 400 });
    }

    const report = {
      items_created: 0,
      items_updated: 0,
      // is_active flips this import actually performed: the Master Status
      // column was present, the CELL said something, and it differed from the
      // stored value. A blank status cell used to read as the literal 'Active'
      // — which re-activated all 131 retired items and was reported nowhere
      // (HIGH-B). Blank now preserves, and a real flip is counted here.
      items_reactivated: 0,
      items_deactivated: 0,
      items_skipped_inactive: 0,
      items_skipped_zero_price: 0,
      items_skipped_duplicate: 0,
      items_linked_to_recipe: 0,
      items_linked_to_material: 0,
      items_unlinked: 0,
      // ── WHAT THE FILE DID NOT SAY ──────────────────────────────────────────
      // A column the sheet does not carry is not an instruction to erase the
      // value (see `supplied()`), and "items_updated: 9" said nothing at all
      // about that. These name it.
      //
      // Columns the sheet had no header for. Every existing item this import
      // touched KEPT what it already had in each of them.
      columns_absent: [] as string[],
      // Updated items that kept their existing value, per column.
      fields_preserved: {} as Record<string, number>,
      // The subset of fields_preserved where the column WAS in the file and
      // that row's CELL was blank. A blank cell is not a statement — the
      // literals that used to be substituted there ('Active', 'foods', 5% GST,
      // an initials code, a derived dietary tag) overwrote real values and were
      // reported nowhere. Now the cell preserves, and is counted apart from
      // the absent-column preserves so the report says which of the two
      // happened.
      blank_cells_preserved: {} as Record<string, number>,
      // Station is the one that moves a printed ticket to a different physical
      // printer, so it is counted on its own line rather than buried in the map.
      stations_preserved: 0,   // file had no Station column → station untouched
      stations_changed: 0,     // file HAD a Station column and it wrote a different station
      stations_cleared: 0,     // file HAD a Station column and it was blank → station emptied
      // An item with NO station given one from the recipe template's
      // category→station map — ONLY when the user explicitly opted in
      // (fill_station_from_category), and only with a name the station master
      // resolves. 0 whenever the flag is off. These items are NOT counted in
      // stations_preserved: HIGH-A was exactly that double-speak (the fill ran
      // unasked AND its items were reported as "kept their station").
      stations_filled_from_category: 0,
      // Map values the opt-in fill REFUSED because the station master does not
      // have them. The map is a hard-coded guess (see import-parse.ts) — a name
      // off the master routes nowhere, so it is skipped and named rather than
      // written. Empty whenever the flag is off.
      station_fill_skipped_not_in_master: [] as string[],
      // Items left with NO station after this import. They do not match a
      // station printer, so their KOT falls through to the food/bar fallback.
      items_without_station: 0,
      // Station strings this import WROTE that station_departments (the station
      // master) does not have. Written anyway — refusing one would be a new way
      // for an import to lose data — but named, because nothing else on this
      // path checks them and a station off the master routes nowhere.
      stations_not_in_master: [] as string[],
      // NEW items where material linking was requested but no EXACT name/SKU
      // match existed — reported for manual review instead of prefix-guessing a
      // link. Existing items are not counted here: an import never attempts to
      // link one (their still-unlinked names appear in unlinked_items instead).
      materials_unmatched: 0,
      materials_unmatched_items: [] as string[],
      typos_fixed: [] as string[],
      spaces_fixed: 0,
      // Categories in the file that the master did not have and this import
      // ADDED (owner's instruction: an unknown category is accepted and created
      // so it can be edited afterwards — never refused, never silently dropped).
      // Reported the way the HR employee importer reports created_designations,
      // so the admin can see exactly what the file added to the master.
      created_categories: [] as { id: string; name: string }[],
      // Named but NOT added: the master has a 60-character ceiling so a name
      // still fits the category chips and the guest-menu heading. The item keeps
      // the string it was given (nothing about menu_items changes), it just is
      // not offered in the picker — say so rather than let it vanish.
      categories_too_long: [] as string[],
      // The file spells a category the list already has, differently. The master
      // identifies a name case-insensitively (menu_categories.name is UNIQUE
      // COLLATE NOCASE), so no row is created — but the ITEM keeps the file's own
      // capitalisation, deliberately, because rewriting it would be this import
      // silently re-casing live menu data. That leaves the item off the master's
      // exact string, which the item form marks as "not in the category list".
      // Reported so the admin SEES it instead of finding it later: creating
      // nothing AND saying nothing was the hole here.
      categories_spelled_differently: [] as { file: string; list: string }[],
      // Unknown categories a NON-ADMIN's file named. The master is admin-owned
      // state (POST/PUT /api/menu-items/categories are both requireRole('admin')),
      // and this route carries no role gate, so a non-admin import must not grow
      // it. Same shape as the HR employee importer, which lets a manager import
      // but re-gates "create a new designation" at admin. The items still get
      // their category string exactly as before; only the picker entry waits.
      categories_need_admin: [] as string[],
      duplicates_found: [] as string[],
      recipe_links: [] as { item: string; recipe: string; score: number }[],
      unlinked_items: [] as string[],
      errors: [] as string[],
    };

    // ── WHICH COLUMNS DID THE FILE ACTUALLY CARRY? ──────────────────────────
    // A column that is ABSENT from the sheet is not an instruction to erase the
    // value. Only a column that is PRESENT and deliberately empty can be.
    //
    // This route used to write `row.station || ''` (and the same for category,
    // item code, dietary tag, price, tax, type, status) unconditionally on
    // every overwrite, so a sheet that never mentioned Station — a POS export, a
    // hand-built price list — silently emptied menu_items.station on every item
    // it matched. That string IS the KOT routing key (print.ts matches it
    // against print_stations.station), so the ticket moved to a different
    // physical printer and the report said only "items_updated".
    //
    // `present_columns` is the header the importer read, and when it is given it
    // is the authority: a listed column writes what its cells STATE, an
    // unlisted one is PRESERVED from the existing item.
    //
    // AND THE SAME RULE PER CELL: a listed column whose cell is BLANK on some
    // row is not a statement about that row either. The importer omits the
    // field for that row (undefined — see import-parse.ts), so `supplied()` is
    // false and the item preserves, counted in blank_cells_preserved. The one
    // deliberate exception is Station, where a blank cell in a present column
    // has always been the counted, reported instruction to CLEAR
    // (stations_cleared) — the importer sends '' there, so it still writes.
    //
    // When it is NOT given — an older browser tab that has not reloaded, or a
    // script posting rows by hand — absent and blank are indistinguishable, so
    // the reading is the conservative one: a value is written when it is
    // non-empty and preserved when it is empty. That refuses such a caller a
    // deliberate clear (it must send present_columns to get one); it can never
    // erase a station nobody mentioned.
    const declared = Array.isArray(present_columns)
      ? new Set(present_columns.map((c) => String(c)))
      : null;
    /**
     * What the importer used to put in a field whose column the sheet did NOT
     * have: '' for the strings, 0 for the numbers, and the literals 'foods' and
     * 'Active' for type and status. Without `present_columns` those are
     * indistinguishable from a real value, so in that legacy path they read as
     * "the file did not say" and the item keeps what it has. A caller that
     * means one of them literally — price 0, tax 0, type foods, status Active —
     * says so by sending present_columns.
     */
    const isLegacyFiller = (field: FileField, v: unknown): boolean => {
      const s = String(v).trim();
      if (s === '') return true;
      switch (field) {
        case 'item_type': return normalizeItemType(v) === 'foods';
        case 'master_status': return s.toLowerCase() === 'active';
        case 'selling_price':
        case 'listing_price':
        case 'tax_value': return Number(v) === 0;
        default: return false;
      }
    };
    const supplied = (row: ImportRow, field: FileField): boolean => {
      const v = (row as unknown as Record<string, unknown>)[field];
      if (v === undefined || v === null) return false;  // key absent ⇒ nothing to write, ever
      if (declared) return declared.has(field);
      return !isLegacyFiller(field, v);
    };
    if (declared) {
      report.columns_absent = FILE_FIELDS.filter((f) => !declared.has(f)).map((f) => FIELD_LABEL[f]);
    }
    const notePreserved = (f: FileField) => {
      report.fields_preserved[FIELD_LABEL[f]] = (report.fields_preserved[FIELD_LABEL[f]] || 0) + 1;
    };
    // Was this row's cell blank in a column the file DOES carry? The parser
    // sends undefined for such a cell, so it is distinguishable from an absent
    // column only through `declared`.
    const blankCellIn = (row: ImportRow, f: FileField): boolean => {
      const v = (row as unknown as Record<string, unknown>)[f];
      return !!declared && declared.has(f) && (v === undefined || v === null);
    };
    // Count a preserve — and when it happened because a present column left
    // THIS cell blank, say that too, so the report separates "no such column"
    // from "column there, cell empty".
    const notePreservedCell = (row: ImportRow, f: FileField) => {
      notePreserved(f);
      if (blankCellIn(row, f)) {
        report.blank_cells_preserved[FIELD_LABEL[f]] = (report.blank_cells_preserved[FIELD_LABEL[f]] || 0) + 1;
      }
    };
    const isBlank = (v: unknown) => v === undefined || v === null || String(v).trim() === '';
    const noteFillSkipped = (s: string) => {
      if (s && !report.station_fill_skipped_not_in_master.includes(s)) {
        report.station_fill_skipped_not_in_master.push(s);
      }
    };

    // Load existing menu items, recipes & materials for linking.
    // The rest of the columns are read because they are what an absent column
    // PRESERVES — the update below rewrites the whole row, so a field the file
    // did not carry has to be written back as it stands.
    // recipe_id/material_id ride along so "is this item still unlinked?" is
    // answerable at the write — an import never changes an existing item's
    // links (see the candidate block in the loop), it only NAMES the ones that
    // remain unlinked for review.
    const existingItems = db.prepare(`
      SELECT id, name, category, station, item_type, dietary_tag, selling_price,
             listing_price, item_code, tax_value, cgst_percent, sgst_percent, is_active,
             recipe_id, material_id
      FROM menu_items
    `).all() as any[];
    const existingMap = new Map<string, any>();
    for (const m of existingItems) existingMap.set(m.name.toLowerCase().trim(), m);
    const existingById = new Map<string, any>(existingItems.map((m) => [String(m.id), m]));

    const recipes = db.prepare('SELECT id, name FROM recipes WHERE is_active = 1').all() as any[];
    // Fuzzy matcher: menu names are worded differently from recipe names
    // ("Veg Manchow Soup" → "MANCHOW SOUP VEG / NONVEG"). Tuned for precision —
    // it links only confident matches and leaves the rest for manual linking.
    const matchRecipe = buildRecipeMatcher(recipes);

    const materials = db.prepare('SELECT id, name, sku FROM raw_materials').all() as any[];
    const materialMap = new Map<string, string>();
    for (const m of materials) materialMap.set(m.name.toLowerCase().trim(), m.id);
    // Exact SKU lookup (secondary match key; name equality wins on collision).
    const materialSkuMap = new Map<string, string>();
    for (const m of materials) {
      const sku = (m.sku || '').toString().toLowerCase().trim();
      if (sku && !materialSkuMap.has(sku)) materialSkuMap.set(sku, m.id);
    }

    const insertItem = db.prepare(`
      INSERT INTO menu_items (id, name, category, station, item_type, dietary_tag, selling_price, listing_price, item_code, tax_value, cgst_percent, sgst_percent, is_active, recipe_id, material_id, source, pos_id, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pos', ?, '', datetime('now'), datetime('now'))
    `);

    // pos_id: preserve on blank — the Recaho mapped code drives sales-import
    // matching, and a CSV without the POS ID column must not wipe it (same
    // COALESCE-preserve pattern as recipe_id/material_id).
    const updateItem = db.prepare(`
      UPDATE menu_items SET name = ?, category = ?, station = ?, item_type = ?, dietary_tag = ?, selling_price = ?, listing_price = ?, item_code = ?, tax_value = ?, cgst_percent = ?, sgst_percent = ?, is_active = ?, recipe_id = COALESCE(?, recipe_id), material_id = COALESCE(?, material_id), pos_id = COALESCE(NULLIF(?, ''), pos_id), updated_at = datetime('now') WHERE id = ?
    `);
    // Keep the invariant tax_value = cgst_percent + sgst_percent (the bill engine
    // sums tax_value; the menu form re-derives tax_value from the two halves on
    // edit, so leaving them 0 would zero out an item's GST on the next save).
    const gstSplit = (tv: number) => {
      const t = Math.max(0, Math.round((Number(tv) || 0) * 100) / 100);
      const cg = Math.round((t / 2) * 100) / 100;
      return { tax: t, cgst: cg, sgst: Math.round((t - cg) * 100) / 100 };
    };

    // Track what we've inserted in this batch (by normalized name) to detect in-batch duplicates
    const batchNames = new Map<string, number>();

    // Every distinct station string this import actually wrote — checked
    // against the station master AFTER the transaction (see below).
    const stationsWritten = new Set<string>();
    // The station counters are counted BY ITEM, not by row: a file that lists
    // the same item twice must not report two items keeping their station.
    const stationPreservedIds = new Set<string>();
    const stationChangedIds = new Set<string>();
    const stationClearedIds = new Set<string>();
    const stationFilledIds = new Set<string>();
    const noStationIds = new Set<string>();

    /**
     * MASTER-CATEGORY UPSERT for one row's category. RETURNS the string the
     * item is to store.
     *
     * IT RETURNS THE CLEANED NAME, AND THE ITEM WRITE USES IT. The first cut
     * sanitised the name it put in the MASTER and wrote the RAW cell onto the
     * ITEM, so a file spelling "Nitro  Cold  Brews" (two interior double
     * spaces) reported `created_categories: ["Nitro Cold Brews"]` and then gave
     * its own items a category that row does not cover — an orphan of the entry
     * the same import had just minted, and two guest-menu sections whose
     * headings render identically. sanitizeCategoryName only collapses runs of
     * whitespace and strips invisible Cf/Cc characters; it is IDENTITY on all
     * 47 category strings live menu items carry today (verified against the
     * live DB), so no existing row moves. Case is deliberately NOT folded — see
     * `categories_spelled_differently`.
     *
     * Called only for rows that actually WRITE an item. A row skipped as an
     * existing duplicate, as inactive or as ₹0 never lands its category on any
     * item, so minting a master entry for it would put a category in the picker
     * that nothing uses and nobody asked for.
     *
     * Already-known names (including DEACTIVATED ones) are left exactly as they
     * are: a file naming a retired category is not a request to un-retire it.
     *
     * TWO SEPARATE "ONLY ONCE"S, AND THEY ARE NOT THE SAME ONCE. What must
     * happen once per CATEGORY is the decision — create it / report it too long
     * / report it as needing an admin. What must happen once per SPELLING is the
     * `categories_spelled_differently` warning. Collapsing both onto the folded
     * key (one `seenCats` set, checked first) meant only the FIRST spelling in a
     * file was ever examined, and every later one landed on an item and was
     * reported nowhere. Proven on a copy of the live DB: a file spelling a NEW
     * category three ways (`zz-case`, `ZZ-CASE`, `Zz-Case`) created one row and
     * reported NOTHING, leaving two items off the master string the same import
     * had just minted; a file naming an existing `beer` as `BeEr` then `BEER`
     * reported one of the two. That is the hole the warning exists to close, so
     * the spelling check now runs for every distinct spelling in the file and
     * compares against `canon` — the name the picker will actually offer, which
     * is the master's spelling for a known category and the created row's for a
     * new one. `canon` is null when this file is putting NO row in the master
     * (over-long, or a non-admin's unknown category): there is no list entry to
     * be spelled differently from, and the row is already reported in its own
     * bucket.
     */
    const catCanon = new Map<string, string | null>();
    const seenSpellings = new Set<string>();
    const noteCategory = (raw: unknown): string => {
      const clean = sanitizeCategoryName(raw);
      if (!clean) return '';                    // blank behaves exactly as it does today
      const key = clean.toLowerCase();
      if (!catCanon.has(key)) {
        // ── ONCE PER CATEGORY ───────────────────────────────────────────────
        if (clean.length > MAX_CATEGORY_LEN) {
          report.categories_too_long.push(clean);
          catCanon.set(key, null);
        } else {
          // Already in the master under another capitalisation? Create nothing
          // (the NOCASE unique index would refuse a second row anyway) and let
          // the spelling check below say so.
          const known = findMenuCategory(db, clean);
          if (known) {
            catCanon.set(key, known.name);
          } else if (!canMintCategories) {
            report.categories_need_admin.push(clean);
            catCanon.set(key, null);
          } else {
            const made = ensureMenuCategory(db, clean);
            if (made?.created) report.created_categories.push({ id: made.row.id, name: made.row.name });
            catCanon.set(key, made ? made.row.name : null);
          }
        }
      }
      // ── ONCE PER SPELLING ─────────────────────────────────────────────────
      const canon = catCanon.get(key);
      if (canon && canon !== clean && !seenSpellings.has(clean)) {
        seenSpellings.add(clean);
        report.categories_spelled_differently.push({ file: clean, list: canon });
      }
      return clean;
    };

    const doImport = db.transaction(() => {
      for (const row of rows) {
        if (!row.name) continue;

        const originalName = row.name;
        let normalized = originalName.trim();

        // Strip extra spaces
        const cleanedSpaces = normalized.replace(/\s+/g, ' ').trim();
        if (strip_spaces && cleanedSpaces !== normalized) {
          report.spaces_fixed++;
          normalized = cleanedSpaces;
        }

        // Fix typos
        const withoutTypos = fixTypos(normalized);
        if (fix_typos && withoutTypos !== normalized) {
          report.typos_fixed.push(`"${normalized}" → "${withoutTypos}"`);
          normalized = withoutTypos;
        }

        // Check status filter. Gated on the column EXISTING: a file with no
        // Master Status column says nothing about any item's status, so it can
        // neither skip a row as inactive nor (below) re-activate one.
        const isActive = row.master_status?.toLowerCase() !== 'inactive';
        if (skip_inactive && supplied(row, 'master_status') && !isActive) {
          report.items_skipped_inactive++;
          continue;
        }

        // Same for ₹0: a file with no price column has no ₹0 in it to skip.
        const sellingPrice = Number(row.selling_price) || 0;
        if (skip_zero_price && supplied(row, 'selling_price') && sellingPrice === 0) {
          report.items_skipped_zero_price++;
          continue;
        }

        // Duplicate check (in-batch)
        const nameKey = normalized.toLowerCase();
        const batchCount = batchNames.get(nameKey) || 0;
        batchNames.set(nameKey, batchCount + 1);
        if (batchCount > 0) {
          report.duplicates_found.push(normalized);
        }

        // ── LINK CANDIDATES — FOR NEW ITEMS ONLY ────────────────────────────
        // The fuzzy recipe matcher and the exact material lookup (full-name or
        // SKU equality; the old first-word-prefix fallback mass-assigned
        // "Mango Kulfi" → "MANGO PICKLE 5 KG" and is gone) produce CANDIDATES
        // here, and a NEW item takes them. An EXISTING item's links are NEVER
        // touched: no sheet carries a recipe/material column, so a derived
        // match writing one is the same absent-column disease as the station
        // fill — it used to re-point a hand-linked item on every reimport
        // (COALESCE(?, recipe_id) with a fresh match), and even the fill-a-blank
        // version wrote wrong guesses ("Margherita NSP", a pizza, filled with
        // the "Margarita" cocktail recipe — whose stock then deducts on every
        // KOT). Links on existing items belong to the item form and the
        // recipe-link audit, not to a CSV that never mentioned them. The
        // counters moved with the decision, so a skipped row — or an existing
        // item simply keeping its links — no longer inflates
        // items_linked_to_recipe / materials_unmatched.
        const rm = matchRecipe(normalized);
        const recipeCandidate: string | null = rm ? rm.id : null;
        let materialCandidate: string | null = null;
        if (!recipeCandidate && link_materials) {
          materialCandidate = materialMap.get(nameKey) || materialSkuMap.get(nameKey) || null;
        }

        // Existing item? Prefer the STABLE Item ID (from our own menu export) —
        // it survives renames; name matching is the legacy fallback for POS
        // sheets that carry no id.
        const byId = row.item_id ? existingById.get(String(row.item_id).trim()) : undefined;
        const existing = byId || existingMap.get(nameKey);
        const fb = row.fallback || {};
        if (existing) {
          if (!overwrite_existing) {
            report.items_skipped_duplicate++;
            continue;
          }
          // ── EVERY FIELD: WHAT THE FILE SAID, OR WHAT THE ITEM ALREADY HAS ──
          // The UPDATE rewrites the whole row, so each column the file did not
          // carry is written back unchanged. `existing` is the row as it stands
          // (and is mutated at the end of this branch, so a second row for the
          // same item later in the same file preserves what the first wrote).
          const keep = <T,>(f: FileField, fromFile: T, current: T): T => {
            if (supplied(row, f)) return fromFile;
            notePreservedCell(row, f);
            return current;
          };
          // Category: noteCategory() is called ONLY when the file carried the
          // column AND this cell said something — it is what grows the category
          // master, and neither a missing column nor a blank cell must mint
          // anything.
          let cleanCat: string;
          if (supplied(row, 'category')) {
            cleanCat = noteCategory(row.category);
          } else {
            notePreservedCell(row, 'category');
            cleanCat = (existing.category ?? '') as string;
          }

          // Station.
          //
          // Values the FILE states go through stationSpellingForWrite(): a
          // spelling that resolves on the master ("Tandoor", a BOM-prefixed
          // cell) lands as the master's own bytes — the file's case split one
          // section's KOTs in two exactly like the form path once did — and
          // an off-master string is written cleaned-verbatim and reported in
          // stations_not_in_master as before. A PRESERVED station is written
          // back untouched: "kept it" means the stored string.
          //
          // A sheet with NO Station column touches NOTHING here (HIGH-A: the
          // template's category→station map used to fill a blank station
          // unasked — 5 items moved ''→'tandoor' — while stationPreservedIds
          // had already counted those very items as "kept their station").
          // The fill exists only behind the explicit fill_station_from_category
          // opt-in, writes only names the station master resolves (as the
          // master's own bytes), and its items are counted as FILLED — never
          // as preserved.
          const prevStation = (existing.station ?? '') as string;
          let stationOut = prevStation;
          if (supplied(row, 'station')) {
            stationOut = stationSpellingForWrite(db, row.station);
            if (stationOut !== prevStation) {
              if (!stationOut) stationClearedIds.add(existing.id);
              else stationChangedIds.add(existing.id);
            }
          } else {
            const wantFill = fill_station_from_category && isBlank(prevStation) && !isBlank(fb.station);
            const fillRow = wantFill ? findStationRow(db, fb.station) : null;
            if (fillRow) {
              stationOut = fillRow.station;       // the master's own spelling
              stationFilledIds.add(existing.id);
            } else {
              if (wantFill) noteFillSkipped(String(fb.station).trim());
              stationPreservedIds.add(existing.id);
              notePreservedCell(row, 'station');
            }
          }
          if (!stationOut) noStationIds.add(existing.id);
          else stationsWritten.add(stationOut);

          // Preserved item_type is written back RAW (not re-normalised): "kept
          // it" has to mean the stored string, not a tidied version of it.
          const typeOut = keep('item_type', normalizeItemType(row.item_type) || 'foods',
                               (String(existing.item_type ?? '').trim() || 'foods'));
          // The derived dietary tag and initials item code (fallback.*) seed
          // NEW items only — an existing item's blank is not filled from them.
          // Same disease as HIGH-A's station fill: a sheet that never carried
          // the column changed the item, and the report called it preserved.
          const dietOut = keep('dietary_tag', row.dietary_tag || '', (existing.dietary_tag ?? '') as string);
          const priceOut = keep('selling_price', sellingPrice, Number(existing.selling_price) || 0);
          const listOut = keep('listing_price', Number(row.listing_price) || 0, Number(existing.listing_price) || 0);
          const codeOut = keep('item_code', row.item_code || '', (existing.item_code ?? '') as string);
          // Tax keeps the invariant tax_value = cgst + sgst whichever way it
          // goes: the file's number is re-split, a preserved one is written back
          // with the item's own halves. `fallback.tax_value` (the template's
          // flat 5%) is deliberately NOT used to fill an existing item — an
          // existing 0 is how liquor is taxed, not a blank waiting to be filled.
          // (row.tax_value is a real number whenever supplied() is true: the
          // parser's numCell sends undefined for a blank or unparseable cell,
          // and parses a literal '0' as 0 — the `Number(cell) || 5` substitution
          // that wrote 5% GST onto liquor lines stating 0% was HIGH-C.)
          let ug: { tax: number; cgst: number; sgst: number };
          if (supplied(row, 'tax_value')) {
            ug = gstSplit(Number(row.tax_value) || 0);
          } else {
            notePreservedCell(row, 'tax_value');
            ug = {
              tax: Number(existing.tax_value) || 0,
              cgst: Number(existing.cgst_percent) || 0,
              sgst: Number(existing.sgst_percent) || 0,
            };
          }
          const prevActive = existing.is_active ? 1 : 0;
          const activeOut = keep('master_status', isActive ? 1 : 0, prevActive);
          if (activeOut !== prevActive) {
            if (activeOut) report.items_reactivated++;
            else report.items_deactivated++;
          }
          // pos_id has always been preserved by the SQL itself
          // (COALESCE(NULLIF(?,''), pos_id)) — counted here only so the report
          // is complete about what this file left alone.
          if (!supplied(row, 'pos_id')) notePreservedCell(row, 'pos_id');

          // Links: an existing item's recipe/material links are NEVER touched
          // by an import (see the candidate block above) — NULL through the
          // COALESCE preserves both. An item that comes out of this import
          // still unlinked is worth a review, so it is named, but no linking
          // was attempted on it and materials_unmatched does not count it.
          if (!existing.recipe_id && !existing.material_id) {
            report.items_unlinked++;
            report.unlinked_items.push(normalized);
          }

          updateItem.run(
            normalized,
            cleanCat, stationOut, typeOut, dietOut,
            priceOut, listOut, codeOut,
            ug.tax, ug.cgst, ug.sgst, activeOut, null, null, row.pos_id || '',
            existing.id
          );
          // Keep the name index current so a rename can't spawn a duplicate
          // from a later row in the same file...
          existingMap.set(nameKey, existing);
          // ...and the row image current, so a second row for the same item in
          // this file preserves what the first row wrote, not the pre-import
          // value.
          Object.assign(existing, {
            name: normalized, category: cleanCat, station: stationOut, item_type: typeOut,
            dietary_tag: dietOut, selling_price: priceOut, listing_price: listOut,
            item_code: codeOut, tax_value: ug.tax, cgst_percent: ug.cgst, sgst_percent: ug.sgst,
            is_active: activeOut,
          });
          report.items_updated++;
        } else {
          // NEW item: there is nothing to preserve, so an absent column falls
          // back to the value the importer derived, then to today's default.
          const cleanCat = supplied(row, 'category') ? noteCategory(row.category) : '';
          const id = generateId();
          // Station: what the FILE states is written (master's own bytes when
          // the spelling resolves; cleaned-verbatim and named in
          // stations_not_in_master when it does not). The category→station MAP
          // seeds a new item ONLY behind the same explicit
          // fill_station_from_category opt-in as the update branch, and only
          // with a name the master resolves — with the flag off (the default),
          // a sheet with no Station column creates the item with no station,
          // which items_without_station then counts.
          let stationNew = '';
          if (supplied(row, 'station')) {
            stationNew = stationSpellingForWrite(db, row.station);
          } else if (fill_station_from_category && !isBlank(fb.station)) {
            const fillRow = findStationRow(db, fb.station);
            if (fillRow) {
              stationNew = fillRow.station;
              stationFilledIds.add(id);
            } else {
              noteFillSkipped(String(fb.station).trim());
            }
          }
          if (!stationNew) noStationIds.add(id);
          else stationsWritten.add(stationNew);
          const codeNew = supplied(row, 'item_code') ? (row.item_code || '') : String(fb.item_code ?? '');
          const dietNew = supplied(row, 'dietary_tag') ? (row.dietary_tag || '') : String(fb.dietary_tag ?? '');
          const ig = gstSplit(supplied(row, 'tax_value') ? Number(row.tax_value) || 0 : Number(fb.tax_value) || 0);
          // A new item takes its link candidates as-is, and that is when they
          // are counted.
          if (recipeCandidate && rm) {
            report.items_linked_to_recipe++;
            report.recipe_links.push({ item: normalized, recipe: rm.name, score: rm.score });
          } else if (materialCandidate) {
            report.items_linked_to_material++;
          }
          if (!recipeCandidate && !materialCandidate) {
            report.items_unlinked++;
            report.unlinked_items.push(normalized);
            if (link_materials) {
              report.materials_unmatched++;
              report.materials_unmatched_items.push(normalized);
            }
          }
          insertItem.run(
            id, normalized, cleanCat, stationNew,
            normalizeItemType(row.item_type) || 'foods', dietNew,
            sellingPrice, Number(row.listing_price) || 0, codeNew,
            ig.tax, ig.cgst, ig.sgst, isActive ? 1 : 0, recipeCandidate, materialCandidate, row.pos_id || ''
          );
          report.items_created++;
          existingMap.set(nameKey, {
            id, name: normalized, category: cleanCat, station: stationNew,
            item_type: normalizeItemType(row.item_type) || 'foods', dietary_tag: dietNew,
            selling_price: sellingPrice, listing_price: Number(row.listing_price) || 0,
            item_code: codeNew, tax_value: ig.tax, cgst_percent: ig.cgst, sgst_percent: ig.sgst,
            is_active: isActive ? 1 : 0,
            recipe_id: recipeCandidate, material_id: materialCandidate,
          });
        }
      }

      // The admin UI path logs `menu_category.create` for every row it adds and
      // the rename route logs its own event; a CSV that grew the same master
      // left nothing behind at all. One event for the batch, INSIDE the
      // transaction so a file that throws half way through takes the audit row
      // down with the categories it minted. logAuditEvent swallows its own
      // errors and never throws, so it cannot take the import down with it.
      // Mirrors the HR importer's hr.designation.import_create.
      if (report.created_categories.length) {
        logAuditEvent(db, {
          event_type: 'menu_category.import_create',
          entity_type: 'menu_category',
          entity_id: report.created_categories[0].id,
          actor_email: actorEmail,
          outlet_id: outletId,
          before: null,
          after: { created: report.created_categories, names: report.created_categories.map(c => c.name) },
          note: `Menu-items CSV import added ${report.created_categories.length} categor${report.created_categories.length === 1 ? 'y' : 'ies'} to the category list: ${report.created_categories.map(c => `"${c.name}"`).join(', ')}. The list decides what the item form offers; no menu item was re-categorised by this.`,
        });
      }
    });

    doImport();

    report.stations_preserved = stationPreservedIds.size;
    report.stations_changed = stationChangedIds.size;
    report.stations_cleared = stationClearedIds.size;
    report.stations_filled_from_category = stationFilledIds.size;
    report.items_without_station = noStationIds.size;

    // ── THE STATION STRING IS A KEY, NOT A LABEL ────────────────────────────
    // Nothing on this path REFUSES it — refusing would be a new way for an
    // import to lose data. A spelling that RESOLVES on the master was written
    // as the master's own bytes (stationSpellingForWrite above), so it can
    // never appear here. What can: a hand-typed "Pan Asian", a name that was
    // renamed in the master since the sheet was exported, or a value from the
    // importer's hard-coded category→station map (a FOURTH copy of these
    // names — see src/app/menu-items/import-parse.ts) — written
    // cleaned-verbatim, matching no print_stations row and no department, so
    // it is NAMED here. station_departments is the master (src/lib/station-master.ts).
    try {
      for (const s of stationsWritten) {
        if (!findStationRow(db, s)) report.stations_not_in_master.push(s);
      }
    } catch {
      // The master is unreadable (missing table on a half-migrated DB). Report
      // nothing rather than fail an import that has already been committed.
    }

    // Dedupe typos list
    report.typos_fixed = [...new Set(report.typos_fixed)];
    report.duplicates_found = [...new Set(report.duplicates_found)];
    report.unlinked_items = [...new Set(report.unlinked_items)];
    report.materials_unmatched_items = [...new Set(report.materials_unmatched_items)];
    report.categories_too_long = [...new Set(report.categories_too_long)];
    report.categories_need_admin = [...new Set(report.categories_need_admin)];

    return Response.json(report);
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
