/**
 * THE MENU-SHEET PARSER — the half of the CSV/XLSX import that reads a
 * spreadsheet and decides what each row is asking for.
 *
 * It lived inside handleImportFile() in page.tsx. It is here because the rule it
 * now enforces cannot be checked from a React event handler:
 *
 *   A COLUMN THAT IS ABSENT FROM THE FILE IS NOT AN INSTRUCTION TO ERASE THE
 *   VALUE. Only a column that is PRESENT and deliberately empty could be.
 *
 * The old parser filled every field for every row whether or not the sheet had
 * the column — `String(r[undefined] || '').trim()` is '' — so a POS export or a
 * hand-built price list, imported with Overwrite on, sent station: '' for items
 * that had one, and the route wrote it. menu_items.station IS the KOT routing
 * key, so those tickets moved to a different physical printer.
 *
 * Now: a column the header does not have is left OUT of the row (undefined,
 * which JSON.stringify drops) and named in `presentColumns`, and the route
 * preserves what the item already has.
 *
 * THE SAME RULE, PER CELL: a column that IS present but whose cell is BLANK is
 * also not a statement. This parser used to substitute a literal in that spot —
 * 'Active' for a blank Master Status (which re-activated all 131 retired items),
 * 'foods' for a blank Item Type, `Number(cell) || 5` for the template's Tax
 * (which also rewrote a LITERAL 0% as 5% GST on liquor, because 0 is falsy),
 * an initials code, a dietary tag derived from the name. All of those wrote a
 * value nobody typed. A blank cell is now OMITTED from the row exactly like an
 * absent column, so the route preserves — with ONE deliberate exception:
 * Station, where a blank cell in a present column has always been the counted,
 * reported instruction to CLEAR (stations_cleared).
 *
 * A value the parser DERIVES (the template's category→station map, its initials
 * item code, its flat 5% tax, the dietary tag read out of the name) travels in
 * `fallback`, which seeds a NEW item only. It never changes an existing item —
 * except that the route may fill a BLANK station from `fallback.station` when
 * the user explicitly opts in (fill_station_from_category, default OFF), and
 * then only with a name the station master actually has.
 */

/** One row as POSTed to /api/menu-items/import. Absent column ⇒ absent key. */
export interface ParsedMenuRow {
  item_id?: string;
  name: string;
  category?: string;
  selling_price?: number;
  listing_price?: number;
  master_status?: string;
  item_type?: string;
  tax_value?: number;
  item_code?: string;
  station?: string;
  dietary_tag?: string;
  pos_id?: string;
  notes?: string;
  /**
   * Derived values for columns the sheet does not carry — or for cells the
   * sheet left blank. They seed a NEW item; an existing item preserves instead
   * (station may fill a blank behind the route's explicit opt-in flag, checked
   * against the station master). Never an overwrite.
   */
  fallback?: { station?: string; item_code?: string; tax_value?: number; dietary_tag?: string };
}

export interface ParsedMenuSheet {
  rows: ParsedMenuRow[];
  isTemplate: boolean;
  /** ImportRow field names the header actually carried — the route's authority. */
  presentColumns: string[];
  headerRowIdx: number;
}

/**
 * ⚠ A FOURTH COPY OF THE STATION NAMES, AND NOTHING CHECKS IT AGAINST THE
 * MASTER. `station_departments` is the station master (see src/lib/station-master.ts);
 * the item form's dropdown is built from it, print_stations.station joins on the
 * same strings, and kot-section.ts keeps its own bar list. This map is a
 * hard-coded guess written for one recipe workbook: a name that is retired or
 * renamed in the master goes on writing dead stations from here, and 'sushi' /
 * 'terracegrill' / 'pan-asian' are only correct by coincidence.
 *
 * It is NOT validated here because this file cannot reach the master (the master
 * is server-side; the page fetches it separately) and inventing a second
 * validation path is how a fifth copy starts. What has changed is its BLAST
 * RADIUS: values from this map travel as `fallback`, and the route writes one
 * ONLY behind the explicit fill_station_from_category opt-in (default OFF) and
 * ONLY after findStationRow() confirms the name is on the station master. With
 * the flag off — the default — a sheet with no Station column touches no
 * station at all, new items included.
 */
export const STATION_BY_CATEGORY: Record<string, string> = {
  'Bar Bites': 'bar', 'Burgers / Sandwiches': 'continental', 'Desserts': 'bakery',
  'Dimsums/Baos': 'pan-asian', 'Grills': 'tandoor', 'Live Grills': 'terracegrill',
  'Non-Veg Main Course': 'indian', 'Pasta': 'continental', 'Pizzas': 'pizza',
  'Pulaos / Biryanis/ Noodles': 'indian', 'Salads': 'continental',
  'Small Plates - Veg': 'tandoor', 'Soups': 'continental', 'Starters Non-Veg': 'tandoor',
  'Sushi': 'sushi', 'Veg - Main Course': 'indian',
};

// Case-insensitive station lookup — POS sheets spell these categories UPPERCASE.
const STATION_LOWER: Record<string, string> = {};
for (const [k, v] of Object.entries(STATION_BY_CATEGORY)) STATION_LOWER[k.toLowerCase()] = v;

export const stationForCategory = (cat: string): string =>
  STATION_BY_CATEGORY[cat] || STATION_LOWER[cat.toLowerCase()] || '';

export function vegNormalize(v: unknown): string {
  if (!v) return '';
  const s = String(v).toUpperCase().trim();
  if (s === 'VEG') return 'Veg';
  if (s === 'NON-VEG' || s === 'NONVEG') return 'Non-Veg';
  if (s === 'EGG') return 'Egg';
  if (s.includes('VEG') && s.includes('NON')) return 'Non-Veg';
  return String(v).trim();
}

/** When the sheet has no dietary column: infer from the name, then the category. */
export function deriveDietary(cat: string, name: string): string {
  const n = name.toLowerCase();
  if (/\b(chicken|mutton|lamb|fish|prawn|prawns|crab|seafood|keema|kheema)\b/.test(n)) return 'Non-Veg';
  if (/\begg\b/.test(n)) return 'Egg';
  const c = cat.toUpperCase();
  if (c.includes('NON-VEG') || c.includes('NON VEG')) return 'Non-Veg';
  if (c.includes('VEG')) return 'Veg';
  return '';
}

export const slugifyCategory = (c: string): string =>
  c.toLowerCase().replace(/\s*\/\s*/g, '-').replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

const initialsCode = (name: string): string =>
  name.split(' ').map((w) => w[0] || '').join('').toUpperCase().slice(0, 5);

/** A cell that says nothing: missing, null, or only whitespace. */
const cellBlank = (v: unknown): boolean =>
  v === undefined || v === null || String(v).trim() === '';

/**
 * The number a cell actually STATES, or undefined when it states nothing.
 * `Number(cell) || default` was the bug this replaces, twice over: a LITERAL 0
 * is falsy, so a template sheet stating 0% GST wrote 5% onto every liquor line;
 * and a blank is 0, so a POS sheet with an empty Tax cell zeroed a real 5%.
 * Blank and unparseable both come back undefined — "the file did not say" —
 * which the route reads as PRESERVE on an existing item. Identical on the
 * template and non-template paths, deliberately.
 */
const numCell = (v: unknown): number | undefined => {
  if (cellBlank(v)) return undefined;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : undefined;
};

/**
 * `sheetRows` is XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null }) —
 * a raw grid, header row included.
 */
export function parseMenuSheet(sheetRows: any[][]): ParsedMenuSheet {
  const rows = sheetRows || [];

  // Find header row — scan first 5 rows for one that has "name" or "product name" or "menu item"
  let headerRowIdx = 0;
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const r = rows[i];
    if (!r) continue;
    const hasName = r.some((c: any) => c && /^(menu\s*item|item\s*name|product\s*name|name|category\s*name)$/i.test(String(c).trim()));
    if (hasName) { headerRowIdx = i; break; }
  }

  const header = rows[headerRowIdx] || [];
  const colIdx: Record<string, number> = {};
  header.forEach((h: any, i: number) => {
    if (!h) return;
    const key = String(h).toLowerCase().trim();
    // Stable identifier from OUR export — matches the exact item even on rename
    if ((key === 'item id' || key === 'menu item id') && colIdx.itemId === undefined) colIdx.itemId = i;
    // Category column — "Category Name" (POS) or "Category" (template)
    else if ((key === 'category name' || key === 'category') && colIdx.category === undefined) colIdx.category = i;
    // Name column — "Product Name" (POS) or "Menu Item" (template)
    else if ((key === 'product name' || key === 'menu item' || key === 'item name' || key === 'name') && colIdx.name === undefined) colIdx.name = i;
    else if (key === 'selling price' || key === 'selling price (₹)' || key === 'price') colIdx.sellingPrice = i;
    else if (key === 'listing price') colIdx.listingPrice = i;
    else if (key === 'master status' || key === 'status') colIdx.masterStatus = i;
    else if (key === 'item type' || key === 'type') colIdx.itemType = i;
    else if (key === 'tax value' || key === 'tax') colIdx.taxValue = i;
    else if (key === 'item code' || key === 'code') colIdx.itemCode = i;
    // Recaho POS mapped code — exported as "POS ID"; without this the
    // round-trip re-import drops pos_id and sales-import matching breaks.
    else if (key === 'pos id' || key === 'pos_id' || key === 'mapped code') colIdx.posId = i;
    else if (key === 'station') colIdx.station = i;
    else if (key === 'dietary tag' || key === 'veg/non-veg' || key === 'veg / non-veg') colIdx.dietaryTag = i;
    else if (key === 'cuisine') colIdx.cuisine = i;
  });

  // If template format detected (has "cuisine", "menu item", or "item name"), apply category → station mapping
  const isTemplate = colIdx.cuisine !== undefined || /menu\s*item|item\s*name/i.test(String(header[colIdx.name ?? 0] || ''));

  const has = (c: string) => colIdx[c] !== undefined;
  // The route's own field names, so it can be told what this sheet carried.
  const presentColumns: string[] = [];
  if (has('category')) presentColumns.push('category');
  if (has('sellingPrice')) presentColumns.push('selling_price');
  if (has('listingPrice')) presentColumns.push('listing_price');
  if (has('masterStatus')) presentColumns.push('master_status');
  if (has('itemType')) presentColumns.push('item_type');
  if (has('taxValue')) presentColumns.push('tax_value');
  if (has('itemCode')) presentColumns.push('item_code');
  if (has('station')) presentColumns.push('station');
  if (has('dietaryTag')) presentColumns.push('dietary_tag');
  if (has('posId')) presentColumns.push('pos_id');

  // Start parsing from row after header
  const parsedRows: ParsedMenuRow[] = [];
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[colIdx.name]) continue;

    const rawCategory = has('category') ? String(r[colIdx.category] || '').trim() : '';
    const name = String(r[colIdx.name] || '').trim();
    const cuisine = has('cuisine') ? String(r[colIdx.cuisine] || '').trim() : '';

    const taxStated = has('taxValue') ? numCell(r[colIdx.taxValue]) : undefined;
    const codeBlank = has('itemCode') ? cellBlank(r[colIdx.itemCode]) : true;
    const dietBlank = has('dietaryTag') ? cellBlank(r[colIdx.dietaryTag]) : true;

    // Derived values for what this sheet does NOT say — the column is missing,
    // or this row's cell is blank (a blank is not a statement, so it behaves
    // exactly like the absent column, decided per cell). They seed a NEW item;
    // an existing item preserves what it has — see the route's `fallback`
    // handling and its fill_station_from_category opt-in.
    const fallback: NonNullable<ParsedMenuRow['fallback']> = {};
    if (!has('station') && isTemplate) {
      const st = stationForCategory(rawCategory);
      if (st) fallback.station = st;
    }
    if (isTemplate && name && codeBlank) fallback.item_code = initialsCode(name);
    if (isTemplate && taxStated === undefined) fallback.tax_value = 5;
    if (dietBlank) {
      const d = deriveDietary(rawCategory, name);
      if (d) fallback.dietary_tag = d;
    }

    parsedRows.push({
      item_id: has('itemId') ? String(r[colIdx.itemId] || '').trim() : '',
      name,
      // For every field below except Station: a blank cell in a PRESENT column
      // is omitted (undefined — dropped by JSON.stringify), so the route
      // preserves what the item already has. The literals this parser used to
      // substitute in that spot ('Active', 'foods', 5, an initials code, a
      // derived dietary tag) were values nobody typed, written over real data.
      category: has('category') && !cellBlank(r[colIdx.category])
        ? (isTemplate ? slugifyCategory(rawCategory) : rawCategory)
        : undefined,
      selling_price: has('sellingPrice') ? numCell(r[colIdx.sellingPrice]) : undefined,
      listing_price: has('listingPrice') ? numCell(r[colIdx.listingPrice]) : undefined,
      master_status: has('masterStatus') && !cellBlank(r[colIdx.masterStatus])
        ? String(r[colIdx.masterStatus]).trim()
        : undefined,
      item_type: has('itemType') && !cellBlank(r[colIdx.itemType])
        ? String(r[colIdx.itemType]).trim()
        : undefined,
      // '0' IS a statement — 0% GST is how liquor is taxed — and numCell keeps
      // it one on both the template and non-template paths.
      tax_value: taxStated,
      item_code: !codeBlank ? String(r[colIdx.itemCode]).trim() : undefined,
      // Station is the ONE deliberate exception: a blank cell in a present
      // Station column stays '' — the documented, counted CLEAR
      // (stations_cleared in the route's report). Unchanged.
      station: has('station') ? String(r[colIdx.station] || '').trim() : undefined,
      // Only send pos_id when the sheet has the column AND the cell says
      // something — the route's SQL preserves on blank anyway (COALESCE), this
      // just lets it COUNT the preserve.
      pos_id: has('posId') && !cellBlank(r[colIdx.posId]) ? String(r[colIdx.posId]).trim() : undefined,
      dietary_tag: !dietBlank ? vegNormalize(r[colIdx.dietaryTag]) : undefined,
      notes: isTemplate && cuisine ? `Cuisine: ${cuisine}` : '',
      ...(Object.keys(fallback).length ? { fallback } : {}),
    });
  }

  return { rows: parsedRows, isTemplate, presentColumns, headerRowIdx };
}

/** Human column captions for the preview/report, keyed by route field name. */
export const COLUMN_LABEL: Record<string, string> = {
  category: 'Category', selling_price: 'Selling Price', listing_price: 'Listing Price',
  master_status: 'Master Status', item_type: 'Item Type', tax_value: 'Tax Value',
  item_code: 'Item Code', station: 'Station', dietary_tag: 'Dietary Tag', pos_id: 'POS ID',
};

/** The columns a sheet can carry, for "not in this file" messaging. */
export const ALL_IMPORT_COLUMNS = Object.keys(COLUMN_LABEL);
