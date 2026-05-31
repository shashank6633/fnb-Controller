import { getDb } from '@/lib/db';
import * as XLSX from 'xlsx';

/**
 * Export the full recipe book as a multi-sheet Excel workbook.
 *   - Summary        : counts + filter context
 *   - Recipes        : main recipes + ingredient lines + sub-recipe references
 *   - Sub-Recipes    : sub-recipes + their own ingredient lines
 *   - Direct Items   : menu items linked directly to a raw material
 *
 * Query params:
 *   ?format=csv                  → legacy CSV (Recipes only, no sub/direct)
 *   (default)                    → .xlsx workbook with all four sheets
 *   ?category=Bar                → filter recipes by category
 *   ?include_inactive=true       → include is_active=0 rows
 */
export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const category = url.searchParams.get('category');
    const includeInactive = url.searchParams.get('include_inactive') === 'true';
    const format = url.searchParams.get('format') || 'xlsx';

    const recipeWhere = ['1=1'];
    const recipeParams: any[] = [];
    if (!includeInactive) recipeWhere.push('is_active = 1');
    if (category) { recipeWhere.push('category = ?'); recipeParams.push(category); }
    const recipes = db.prepare(
      `SELECT * FROM recipes WHERE ${recipeWhere.join(' AND ')} ORDER BY category, name`
    ).all(...recipeParams) as any[];

    if (format === 'csv') return emitCsv(db, recipes);

    // ── 1. Recipes sheet ──
    const recipeRows: any[] = [];
    let totalIngredients = 0;
    for (const r of recipes) {
      const ings = db.prepare(`
        SELECT ri.*, rm.name AS material_name, rm.average_price, rm.unit AS material_unit
        FROM recipe_ingredients ri JOIN raw_materials rm ON rm.id = ri.material_id
        WHERE ri.recipe_id = ? ORDER BY rm.name
      `).all(r.id) as any[];
      const subs = db.prepare(`
        SELECT rs.*, sr.name AS sub_recipe_name, sr.cost_per_unit
        FROM recipe_sub_recipes rs JOIN sub_recipes sr ON sr.id = rs.sub_recipe_id
        WHERE rs.recipe_id = ?
      `).all(r.id) as any[];

      if (ings.length === 0 && subs.length === 0) {
        recipeRows.push({
          Recipe: r.name, Category: r.category || '',
          'Selling Price (₹)': Math.round(r.selling_price || 0),
          'Total Cost (₹)':    Math.round(r.total_cost || 0),
          'Food Cost %':        r.food_cost_percent || 0,
          Ingredient: '(no ingredients)',
          Qty: '', Unit: '', 'Yield %': '', 'Wastage %': '', 'Line Cost (₹)': '',
        });
        continue;
      }
      for (const ing of ings) {
        const lineCost = Math.round((ing.quantity || 0) * (ing.average_price || 0) * 100) / 100;
        recipeRows.push({
          Recipe: r.name, Category: r.category || '',
          'Selling Price (₹)': Math.round(r.selling_price || 0),
          'Total Cost (₹)':    Math.round(r.total_cost || 0),
          'Food Cost %':        r.food_cost_percent || 0,
          Ingredient: ing.material_name, Qty: ing.quantity, Unit: ing.unit,
          'Yield %': ing.yield_percent, 'Wastage %': ing.wastage_percent,
          'Line Cost (₹)': lineCost,
        });
        totalIngredients++;
      }
      for (const sr of subs) {
        recipeRows.push({
          Recipe: r.name, Category: r.category || '',
          'Selling Price (₹)': Math.round(r.selling_price || 0),
          'Total Cost (₹)':    Math.round(r.total_cost || 0),
          'Food Cost %':        r.food_cost_percent || 0,
          Ingredient: `[SUB] ${sr.sub_recipe_name}`,
          Qty: sr.quantity, Unit: sr.unit,
          'Yield %': 100, 'Wastage %': 0,
          'Line Cost (₹)': Math.round((sr.quantity || 0) * (sr.cost_per_unit || 0) * 100) / 100,
        });
        totalIngredients++;
      }
    }

    // ── 2. Sub-Recipes sheet ──
    const subRecipes = db.prepare(`SELECT * FROM sub_recipes ORDER BY name`).all() as any[];
    const subRows: any[] = [];
    let totalSubIngredients = 0;
    for (const sr of subRecipes) {
      const ings = db.prepare(`
        SELECT sri.*, rm.name AS material_name, rm.average_price
        FROM sub_recipe_ingredients sri JOIN raw_materials rm ON rm.id = sri.material_id
        WHERE sri.sub_recipe_id = ? ORDER BY rm.name
      `).all(sr.id) as any[];
      if (ings.length === 0) {
        subRows.push({
          'Sub-Recipe': sr.name,
          'Yield Qty':   sr.yield_quantity || 1,
          'Yield Unit':  sr.yield_unit || 'kg',
          'Total Cost (₹)': Math.round(sr.total_cost || 0),
          'Cost / Unit (₹)': Math.round((sr.cost_per_unit || 0) * 100) / 100,
          Ingredient: '(no ingredients yet)',
          Qty: '', Unit: '', 'Line Cost (₹)': '',
        });
        continue;
      }
      for (const ing of ings) {
        const lineCost = Math.round((ing.quantity || 0) * (ing.average_price || 0) * 100) / 100;
        subRows.push({
          'Sub-Recipe': sr.name,
          'Yield Qty':   sr.yield_quantity || 1,
          'Yield Unit':  sr.yield_unit || 'kg',
          'Total Cost (₹)': Math.round(sr.total_cost || 0),
          'Cost / Unit (₹)': Math.round((sr.cost_per_unit || 0) * 100) / 100,
          Ingredient: ing.material_name,
          Qty: ing.quantity, Unit: ing.unit,
          'Line Cost (₹)': lineCost,
        });
        totalSubIngredients++;
      }
    }

    // ── 3. Direct Items sheet ──
    const directItems = db.prepare(`
      SELECT
        COALESCE(mi.name, dil.item_name)   AS item_name,
        mi.category, mi.station,
        mi.selling_price,
        rm.id   AS material_id,
        rm.name AS material_name,
        rm.unit AS material_unit,
        rm.purchase_unit, rm.pack_size, rm.average_price,
        COALESCE(dil.qty_per_unit, 1) AS qty_per_unit,
        COALESCE(dil.dismissed, 0)    AS dismissed
      FROM menu_items mi
      LEFT JOIN direct_item_links dil ON LOWER(dil.item_name) = LOWER(mi.name)
      LEFT JOIN raw_materials rm ON rm.id = COALESCE(dil.material_id, mi.material_id)
      WHERE mi.is_active = 1
        AND COALESCE(dil.material_id, mi.material_id) IS NOT NULL
      UNION
      SELECT
        dil.item_name AS item_name,
        NULL AS category, NULL AS station,
        NULL AS selling_price,
        rm.id AS material_id, rm.name AS material_name, rm.unit AS material_unit,
        rm.purchase_unit, rm.pack_size, rm.average_price,
        COALESCE(dil.qty_per_unit, 1) AS qty_per_unit,
        COALESCE(dil.dismissed, 0)    AS dismissed
      FROM direct_item_links dil
      JOIN raw_materials rm ON rm.id = dil.material_id
      WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE LOWER(name) = LOWER(dil.item_name))
      ORDER BY item_name
    `).all() as any[];

    const directRows = directItems.map((d: any) => {
      const costPerSale = (Number(d.average_price) || 0) * (Number(d.qty_per_unit) || 1);
      const margin = d.selling_price > 0
        ? Math.round(((d.selling_price - costPerSale) / d.selling_price) * 10000) / 100
        : null;
      return {
        'Sold As': d.item_name,
        Category: d.category || '',
        Station:  d.station || '',
        'Selling Price (₹)': Math.round(d.selling_price || 0),
        'Matched Material':  d.material_name || '',
        'Material Unit':     d.material_unit || '',
        'Purchase Unit':     d.purchase_unit || '',
        'Pack Size':         d.pack_size || 1,
        '1 sold uses':       d.qty_per_unit || 1,
        'Avg Price / unit (₹)': Math.round((d.average_price || 0) * 10000) / 10000,
        'Cost / sale (₹)':   Math.round(costPerSale * 100) / 100,
        'Margin %':          margin != null ? margin : '',
        Dismissed:           d.dismissed ? 'yes' : '',
      };
    });

    // ── 4. Summary sheet ──
    const summaryRows = [
      ['F&B Controller — Full Recipe Book Export'],
      [],
      ['Generated at', new Date().toISOString()],
      ['Category filter', category || 'all'],
      ['Include inactive', String(includeInactive)],
      [],
      ['Section', 'Count'],
      ['Main Recipes',        recipes.length],
      ['  Ingredient lines',  totalIngredients],
      ['Sub-Recipes',         subRecipes.length],
      ['  Ingredient lines',  totalSubIngredients],
      ['Direct Items',        directItems.length],
      [],
      ['Notes'],
      ['Main Recipes — every recipe with its ingredient lines + any [SUB] references it uses.'],
      ['Sub-Recipes — every sub-recipe (Mint Chutney, GG Paste, etc.) with its own ingredient lines.'],
      ['Direct Items — menu items sold AS-IS from a raw material (beers, whiskies, water bottles).'],
      ['Costs use the rolling 90-day weighted-average price normalised by pack_size.'],
    ];

    const wb = XLSX.utils.book_new();
    const wsSum = XLSX.utils.aoa_to_sheet(summaryRows);
    wsSum['!cols'] = [{ wch: 28 }, { wch: 40 }];
    XLSX.utils.book_append_sheet(wb, wsSum, 'Summary');

    const wsRec = XLSX.utils.json_to_sheet(recipeRows.length ? recipeRows : [{ Recipe: '(no recipes)' }]);
    wsRec['!cols'] = [
      { wch: 36 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 12 },
      { wch: 36 }, { wch: 10 }, { wch: 8 }, { wch: 10 }, { wch: 12 }, { wch: 14 },
    ];
    XLSX.utils.book_append_sheet(wb, wsRec, 'Recipes');

    const wsSub = XLSX.utils.json_to_sheet(subRows.length ? subRows : [{ 'Sub-Recipe': '(no sub-recipes)' }]);
    wsSub['!cols'] = [
      { wch: 30 }, { wch: 10 }, { wch: 10 }, { wch: 16 }, { wch: 16 },
      { wch: 36 }, { wch: 10 }, { wch: 8 }, { wch: 14 },
    ];
    XLSX.utils.book_append_sheet(wb, wsSub, 'Sub-Recipes');

    const wsDir = XLSX.utils.json_to_sheet(directRows.length ? directRows : [{ 'Sold As': '(no direct items)' }]);
    wsDir['!cols'] = [
      { wch: 30 }, { wch: 20 }, { wch: 14 }, { wch: 14 }, { wch: 28 },
      { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 16 }, { wch: 14 }, { wch: 10 }, { wch: 10 },
    ];
    XLSX.utils.book_append_sheet(wb, wsDir, 'Direct Items');

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const today = new Date().toISOString().split('T')[0];
    return new Response(buffer, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="recipe-book_${today}.xlsx"`,
      },
    });
  } catch (error: any) {
    console.error('[recipes/export]', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}

// Legacy CSV emitter — kept so any old bookmarks / scripts hitting
// /api/recipes/export?format=csv still get a CSV back.
function emitCsv(db: any, recipes: any[]): Response {
  const headers = [
    'recipe_name', 'category', 'selling_price', 'total_cost', 'food_cost_percent',
    'ingredient_name', 'quantity', 'unit', 'yield_percent', 'wastage_percent',
    'line_cost', 'notes',
  ];
  const csvEscape = (val: any): string => {
    const s = String(val ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines: string[] = [headers.map(csvEscape).join(',')];
  for (const r of recipes) {
    const ings = db.prepare(`
      SELECT ri.*, rm.name AS material_name, rm.average_price
      FROM recipe_ingredients ri JOIN raw_materials rm ON rm.id = ri.material_id
      WHERE ri.recipe_id = ? ORDER BY rm.name
    `).all(r.id) as any[];
    if (ings.length === 0) {
      lines.push([r.name, r.category, r.selling_price, r.total_cost, r.food_cost_percent,
        '', '', '', '', '', '', '(no ingredients)'].map(csvEscape).join(','));
      continue;
    }
    for (const ing of ings) {
      const lc = Math.round((ing.quantity || 0) * (ing.average_price || 0) * 100) / 100;
      lines.push([r.name, r.category, r.selling_price, r.total_cost, r.food_cost_percent,
        ing.material_name, ing.quantity, ing.unit, ing.yield_percent, ing.wastage_percent, lc, ''].map(csvEscape).join(','));
    }
  }
  return new Response(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="recipes_${new Date().toISOString().split('T')[0]}.csv"`,
    },
  });
}
