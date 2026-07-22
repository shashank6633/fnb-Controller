import { getDb, generateId } from '@/lib/db';
import { buildRecipeMatcher } from '@/lib/recipe-matcher';

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
}

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

export async function POST(request: Request) {
  try {
    const db = getDb();
    const body = await request.json();
    const { rows, overwrite_existing = false, fix_typos = true, strip_spaces = true, skip_inactive = false, skip_zero_price = false, link_materials = true } = body as {
      rows: ImportRow[];
      overwrite_existing?: boolean;
      fix_typos?: boolean;
      strip_spaces?: boolean;
      skip_inactive?: boolean;
      skip_zero_price?: boolean;
      // Auto-link unmatched items to a raw material by name prefix. Right for the
      // POS/liquor import (BUDWEISER → material), but wrong for a food menu where
      // every item should be a recipe — a food menu sends link_materials=false so
      // a soup never links to "TOMATO KETCHUP".
      link_materials?: boolean;
    };

    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return Response.json({ error: 'rows array is required' }, { status: 400 });
    }

    const report = {
      items_created: 0,
      items_updated: 0,
      items_skipped_inactive: 0,
      items_skipped_zero_price: 0,
      items_skipped_duplicate: 0,
      items_linked_to_recipe: 0,
      items_linked_to_material: 0,
      items_unlinked: 0,
      typos_fixed: [] as string[],
      spaces_fixed: 0,
      duplicates_found: [] as string[],
      recipe_links: [] as { item: string; recipe: string; score: number }[],
      unlinked_items: [] as string[],
      errors: [] as string[],
    };

    // Load existing menu items, recipes & materials for linking
    const existingItems = db.prepare('SELECT id, name, item_code FROM menu_items').all() as any[];
    const existingMap = new Map<string, any>();
    for (const m of existingItems) existingMap.set(m.name.toLowerCase().trim(), m);
    const existingById = new Map<string, any>(existingItems.map((m) => [String(m.id), m]));

    const recipes = db.prepare('SELECT id, name FROM recipes WHERE is_active = 1').all() as any[];
    // Fuzzy matcher: menu names are worded differently from recipe names
    // ("Veg Manchow Soup" → "MANCHOW SOUP VEG / NONVEG"). Tuned for precision —
    // it links only confident matches and leaves the rest for manual linking.
    const matchRecipe = buildRecipeMatcher(recipes);

    const materials = db.prepare('SELECT id, name FROM raw_materials').all() as any[];
    const materialMap = new Map<string, string>();
    for (const m of materials) materialMap.set(m.name.toLowerCase().trim(), m.id);

    const insertItem = db.prepare(`
      INSERT INTO menu_items (id, name, category, station, item_type, dietary_tag, selling_price, listing_price, item_code, tax_value, cgst_percent, sgst_percent, is_active, recipe_id, material_id, source, pos_id, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pos', ?, '', datetime('now'), datetime('now'))
    `);

    const updateItem = db.prepare(`
      UPDATE menu_items SET name = ?, category = ?, station = ?, item_type = ?, dietary_tag = ?, selling_price = ?, listing_price = ?, item_code = ?, tax_value = ?, cgst_percent = ?, sgst_percent = ?, is_active = ?, recipe_id = COALESCE(?, recipe_id), material_id = COALESCE(?, material_id), pos_id = ?, updated_at = datetime('now') WHERE id = ?
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

        // Check status filter
        const isActive = row.master_status?.toLowerCase() !== 'inactive';
        if (skip_inactive && !isActive) {
          report.items_skipped_inactive++;
          continue;
        }

        const sellingPrice = Number(row.selling_price) || 0;
        if (skip_zero_price && sellingPrice === 0) {
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

        // Link to recipe by fuzzy name match
        const rm = matchRecipe(normalized);
        let recipeId: string | null = rm ? rm.id : null;
        if (recipeId && rm) {
          report.items_linked_to_recipe++;
          report.recipe_links.push({ item: normalized, recipe: rm.name, score: rm.score });
        }

        // Link to material for direct-sale items (beer/wine/bottles)
        let materialId: string | null = null;
        if (!recipeId && link_materials) {
          // Try exact match first
          materialId = materialMap.get(nameKey) || null;
          // Try matching first few words (e.g., "BUDWEISER 330 ML" → "BUDWEISER (330ML)")
          if (!materialId) {
            const firstWord = normalized.split(' ')[0].toLowerCase();
            for (const [mname, mid] of materialMap) {
              if (mname.startsWith(firstWord) && mname.length > 3) {
                materialId = mid;
                break;
              }
            }
          }
          if (materialId) report.items_linked_to_material++;
        }

        if (!recipeId && !materialId) {
          report.items_unlinked++;
          report.unlinked_items.push(normalized);
        }

        // Existing item? Prefer the STABLE Item ID (from our own menu export) —
        // it survives renames; name matching is the legacy fallback for POS
        // sheets that carry no id.
        const byId = row.item_id ? existingById.get(String(row.item_id).trim()) : undefined;
        const existing = byId || existingMap.get(nameKey);
        if (existing) {
          if (!overwrite_existing) {
            report.items_skipped_duplicate++;
            continue;
          }
          const ug = gstSplit(Number(row.tax_value) || 0);
          updateItem.run(
            normalized,
            row.category || '', row.station || '', row.item_type || 'foods', row.dietary_tag || '',
            sellingPrice, Number(row.listing_price) || 0, row.item_code || '',
            ug.tax, ug.cgst, ug.sgst, isActive ? 1 : 0, recipeId, materialId, row.pos_id || '',
            existing.id
          );
          // Keep the name index current so a rename can't spawn a duplicate
          // from a later row in the same file.
          existingMap.set(nameKey, existing);
          report.items_updated++;
        } else {
          const id = generateId();
          const ig = gstSplit(Number(row.tax_value) || 0);
          insertItem.run(
            id, normalized, row.category || '', row.station || '',
            row.item_type || 'foods', row.dietary_tag || '',
            sellingPrice, Number(row.listing_price) || 0, row.item_code || '',
            ig.tax, ig.cgst, ig.sgst, isActive ? 1 : 0, recipeId, materialId, row.pos_id || ''
          );
          report.items_created++;
          existingMap.set(nameKey, { id, name: normalized });
        }
      }
    });

    doImport();

    // Dedupe typos list
    report.typos_fixed = [...new Set(report.typos_fixed)];
    report.duplicates_found = [...new Set(report.duplicates_found)];
    report.unlinked_items = [...new Set(report.unlinked_items)];

    return Response.json(report);
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
