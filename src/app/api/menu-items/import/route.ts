import { getDb, generateId } from '@/lib/db';

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
    const { rows, overwrite_existing = false, fix_typos = true, strip_spaces = true, skip_inactive = false, skip_zero_price = false } = body as {
      rows: ImportRow[];
      overwrite_existing?: boolean;
      fix_typos?: boolean;
      strip_spaces?: boolean;
      skip_inactive?: boolean;
      skip_zero_price?: boolean;
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
      typos_fixed: [] as string[],
      spaces_fixed: 0,
      duplicates_found: [] as string[],
      errors: [] as string[],
    };

    // Load existing menu items, recipes & materials for linking
    const existingItems = db.prepare('SELECT id, name, item_code FROM menu_items').all() as any[];
    const existingMap = new Map<string, any>();
    for (const m of existingItems) existingMap.set(m.name.toLowerCase().trim(), m);

    const recipes = db.prepare('SELECT id, name FROM recipes WHERE is_active = 1').all() as any[];
    const recipeMap = new Map<string, string>();
    for (const r of recipes) recipeMap.set(r.name.toLowerCase().trim(), r.id);

    const materials = db.prepare('SELECT id, name FROM raw_materials').all() as any[];
    const materialMap = new Map<string, string>();
    for (const m of materials) materialMap.set(m.name.toLowerCase().trim(), m.id);

    const insertItem = db.prepare(`
      INSERT INTO menu_items (id, name, category, station, item_type, dietary_tag, selling_price, listing_price, item_code, tax_value, is_active, recipe_id, material_id, source, pos_id, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pos', ?, '', datetime('now'), datetime('now'))
    `);

    const updateItem = db.prepare(`
      UPDATE menu_items SET category = ?, station = ?, item_type = ?, dietary_tag = ?, selling_price = ?, listing_price = ?, item_code = ?, tax_value = ?, is_active = ?, recipe_id = COALESCE(?, recipe_id), material_id = COALESCE(?, material_id), pos_id = ?, updated_at = datetime('now') WHERE id = ?
    `);

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

        // Link to recipe if name matches
        let recipeId: string | null = recipeMap.get(nameKey) || null;
        if (recipeId) report.items_linked_to_recipe++;

        // Link to material for direct-sale items (beer/wine/bottles)
        let materialId: string | null = null;
        if (!recipeId) {
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

        // Existing item?
        const existing = existingMap.get(nameKey);
        if (existing) {
          if (!overwrite_existing) {
            report.items_skipped_duplicate++;
            continue;
          }
          updateItem.run(
            row.category || '', row.station || '', row.item_type || 'foods', row.dietary_tag || '',
            sellingPrice, Number(row.listing_price) || 0, row.item_code || '',
            Number(row.tax_value) || 0, isActive ? 1 : 0, recipeId, materialId, row.pos_id || '',
            existing.id
          );
          report.items_updated++;
        } else {
          const id = generateId();
          insertItem.run(
            id, normalized, row.category || '', row.station || '',
            row.item_type || 'foods', row.dietary_tag || '',
            sellingPrice, Number(row.listing_price) || 0, row.item_code || '',
            Number(row.tax_value) || 0, isActive ? 1 : 0, recipeId, materialId, row.pos_id || ''
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

    return Response.json(report);
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
