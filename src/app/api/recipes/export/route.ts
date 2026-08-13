import { getDb, convertToMaterialUnit } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { packFactor, toPurchaseQty, purchasePrice } from '@/lib/pack-units';
import * as XLSX from 'xlsx';

/**
 * Effective line cost — the SAME per-line math recalculateRecipeCost /
 * recalculateSubRecipeCost use (src/lib/db.ts): convert the recipe-declared
 * qty into the material's stock unit (incl. the pcs↔ml/g pack_size bridge),
 * apply wastage/yield, then multiply by average_price (₹ per RECIPE unit).
 * Row must carry: quantity, unit, material_unit, material_name,
 * material_pack_size, average_price, yield_percent, wastage_percent.
 */
function engineLineCost(ing: any): number {
  const qtyInMatUnit = convertToMaterialUnit(
    ing.quantity || 0, ing.unit, ing.material_unit, ing.material_name, ing.material_pack_size,
  );
  // Engine formula: qty × (1 + wastage%/100) ÷ (yield%/100). Guard yield<=0
  // (engine would emit Infinity — never valid in a spreadsheet cell).
  const yieldPct = ing.yield_percent > 0 ? ing.yield_percent : 100;
  const effectiveQty = qtyInMatUnit * (1 + (ing.wastage_percent || 0) / 100) / (yieldPct / 100);
  return Math.round(effectiveQty * (ing.average_price || 0) * 100) / 100;
}

/**
 * Export the full recipe book as a multi-sheet Excel workbook.
 *   - Summary        : counts + filter context
 *   - Recipes        : main recipes + ingredient lines + sub-recipe references
 *   - Sub-Recipes    : sub-recipes + their own ingredient lines
 *   - Direct Items   : menu items linked directly to a raw material
 *
 * ── DIRECT ITEMS: WHY SOME "Cost / sale" CELLS ARE BLANK ────────────────────
 * average_price is ₹ per RECIPE unit (₹/ml, ₹/g) — never ₹ per item sold. Only
 * direct_item_links.qty_per_unit (recipe units per item sold: 30 for a peg, 700
 * for a bottle) converts the one into the other. This sheet used to multiply by
 * `qty_per_unit || 1`, so a measured material with NO configured pour size
 * printed its ₹/ml under the header "Cost / sale (₹)" and a margin computed
 * from it: SINGLETON 12 Y.O BOTTLE (sell ₹16,499, material 700 ML @ ₹9.01/ml)
 * read Cost ₹9.01 / Margin 99.95%, against a real bottle cost of ₹6,307 (~62%).
 *
 * THE CHOICE MADE HERE: leave the cost blank and name the reason — do NOT
 * derive the sale from the pack. The sheet cannot tell a peg from a bottle:
 * 259 live rows are in this state and both readings sit on the SAME material
 * with the SAME unset qty_per_unit ("SINGLETON 12 Y.O 30 ML" ₹769 and
 * "SINGLETON 12 Y.O BOTTLE" ₹16,499 both link to SINGLETON 12YRS (700ML)).
 * Pricing every such sale as one pack would fix the 73 bottle-ish rows and
 * replace the +99.95% artefact with a −720% one on the 63 peg-ish rows
 * (−1,547% for BUDWEISER DRAUGHT 330 ML off a 30 L keg). A guess that is wrong
 * in the other direction is not an improvement; a blank is honest and points at
 * the one field that would fix it. This mirrors the two surfaces that already
 * refuse this number — /api/menu-items (its CASE returns NULL so the UI shows
 * "—") and /api/sales-import (books ₹0 and reports the line as uncosted).
 *
 * Piece-counted materials (pcs / btl / nos) are untouched: for them 1 sold = 1
 * piece IS the portion, so their cost stays exactly as it was.
 *
 * Every quantity/rate header on that sheet also names its basis now, because
 * "1 sold uses" and the rate sat unlabelled beside Purchase Unit / Pack Size
 * and read as purchase units when both are in the material's RECIPE unit.
 *
 * Query params:
 *   ?format=csv                  → legacy CSV (Recipes only, no sub/direct)
 *   (default)                    → .xlsx workbook with all four sheets
 *   ?category=Bar                → filter recipes by category
 *   ?include_inactive=true       → include is_active=0 rows
 */
export async function GET(request: Request) {
  // SECURITY: this export is the full costed recipe book (every ingredient qty,
  // average_price, total_cost, profit, direct-item margins). The proxy only
  // checks that a session cookie EXISTS for GETs — validate it in-handler.
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
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
        SELECT ri.*, rm.name AS material_name, rm.average_price, rm.unit AS material_unit,
               rm.pack_size AS material_pack_size
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
        const lineCost = engineLineCost(ing);
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
          // sr.cost_per_unit here is sub_recipes.cost_per_unit, which
          // recalculateSubRecipeCost (src/lib/db.ts) writes as total_cost ÷
          // yield_quantity — ₹ per the sub-recipe's own YIELD unit, not ₹ per raw
          // material unit. recipe_sub_recipes.unit is stamped from that same
          // yield_unit (updateFormSubRecipe in src/app/recipes/page.tsx locks it),
          // so rs.quantity is in the yield unit too. A sub-recipe is never
          // bought — it has no purchase unit and no pack size, so nothing
          // converts. Same product as the engine's `sr.quantity * sr.cost_per_unit`.
          // rate-basis: recipe (₹ per sub-recipe yield unit × qty in that same unit)
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
      // purchase_unit + average_price ride along so each ingredient line can also
      // be shown in the PURCHASE basis (owner rule: sub-recipe ingredient lines
      // lead with kg / L / BTL — see the carve-out in src/lib/pack-units.ts).
      const ings = db.prepare(`
        SELECT sri.*, rm.name AS material_name, rm.average_price, rm.unit AS material_unit,
               rm.purchase_unit, rm.pack_size AS material_pack_size
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
          Qty: '', Unit: '',
          // Emitted blank rather than omitted: json_to_sheet derives headers from
          // the keys it meets first, so a yield-only row must still carry them or
          // the purchase columns land after 'Line Cost' for the rest of the sheet.
          'Qty (Purchase)': '', 'Purchase Unit': '', 'Rate / Purchase Unit (₹)': '',
          'Line Cost (₹)': '',
        });
        continue;
      }
      for (const ing of ings) {
        const lineCost = engineLineCost(ing);
        // The both-halves guard reads the MATERIAL's own unit pair — sri.unit is
        // the line's authored unit (Option B) and feeding it here would compare
        // the wrong pair and convert materials that have no pack conversion.
        const meta = {
          unit: ing.material_unit,
          purchase_unit: ing.purchase_unit,
          pack_size: ing.material_pack_size,
        };
        // The line qty is authored in sri.unit; normalise to the material's recipe
        // unit first (same hop engineLineCost makes) or a "0.5 kg" line divides by
        // pack_size a second time.
        const qtyInMatUnit = convertToMaterialUnit(
          ing.quantity || 0, ing.unit, ing.material_unit, ing.material_name, ing.material_pack_size,
        );
        subRows.push({
          'Sub-Recipe': sr.name,
          'Yield Qty':   sr.yield_quantity || 1,
          'Yield Unit':  sr.yield_unit || 'kg',
          'Total Cost (₹)': Math.round(sr.total_cost || 0),
          'Cost / Unit (₹)': Math.round((sr.cost_per_unit || 0) * 100) / 100,
          Ingredient: ing.material_name,
          Qty: ing.quantity, Unit: ing.unit,
          'Qty (Purchase)': toPurchaseQty(qtyInMatUnit, meta),
          'Purchase Unit': ing.purchase_unit || ing.material_unit || '',
          // average_price is ₹/recipe-unit; × packFactor gives ₹/purchase-unit.
          // Display only — 'Line Cost (₹)' stays on the recipe-basis engine math.
          'Rate / Purchase Unit (₹)': purchasePrice(ing.average_price || 0, meta),
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

    // Recipe units that are a MEASURE, not a count. Same list, same order as
    // /api/sales-import (MEASURED_RECIPE_UNITS) and the /api/menu-items CASE
    // expression — if one is edited, all three must be.
    const MEASURED_RECIPE_UNITS = new Set(['ml', 'l', 'g', 'kg']);
    let uncostedDirect = 0;

    const directRows = directItems.map((d: any) => {
      const recipeUnit = String(d.material_unit || '').trim();
      // qty_per_unit is RECIPE units per ITEM SOLD; absent/≤0 → 1, matching
      // normalizeQtyPerUnit in direct-items/_lib/link-writer.ts.
      const qtyPerSale = Number(d.qty_per_unit) > 0 ? Number(d.qty_per_unit) : 1;
      const isMeasured = MEASURED_RECIPE_UNITS.has(recipeUnit.toLowerCase());
      // "1 ml per sale" is nobody's pour size — it is the unset default showing
      // through, so the sale quantity is genuinely unknown for this row.
      const noPortionSize = isMeasured && qtyPerSale === 1;

      // packFactor carries the both-halves guard, so a kg/kg material like
      // PICKLED GINGER 1.5KG reports no pack hint rather than a bogus one.
      const pf = packFactor({
        unit: d.material_unit, purchase_unit: d.purchase_unit, pack_size: d.pack_size,
      });
      const packHint = pf > 1
        ? ` (pack: 1 ${d.purchase_unit || 'purchase unit'} = ${Math.round(pf * 1000) / 1000} ${recipeUnit})`
        : '';

      const costPerSale = noPortionSize
        ? null
        : (Number(d.average_price) || 0) * qtyPerSale;
      const margin = costPerSale != null && d.selling_price > 0
        ? Math.round(((d.selling_price - costPerSale) / d.selling_price) * 10000) / 100
        : null;
      if (noPortionSize) uncostedDirect++;

      return {
        'Sold As': d.item_name,
        Category: d.category || '',
        Station:  d.station || '',
        'Selling Price (₹)': Math.round(d.selling_price || 0),
        'Matched Material':  d.material_name || '',
        // Renamed from 'Material Unit' / '1 sold uses' / 'Avg Price / unit (₹)':
        // all three are the RECIPE basis, and unlabelled they read as the
        // purchase basis they are printed next to.
        'Material Unit (recipe)': recipeUnit,
        'Purchase Unit':     d.purchase_unit || '',
        'Pack Size (recipe units per purchase unit)': d.pack_size || 1,
        '1 sold uses (qty in Material Unit)': qtyPerSale,
        'Avg Price (₹ per Material Unit)': Math.round((d.average_price || 0) * 10000) / 10000,
        'Cost / sale (₹)':   costPerSale != null ? Math.round(costPerSale * 100) / 100 : '',
        'Margin %':          margin != null ? margin : '',
        // Says which basis produced the cost, or why there isn't one. Blank
        // cells that do not explain themselves get read as zero.
        'Cost basis': noPortionSize
          ? `not costed — no portion size. Set "1 sold uses" to the ${recipeUnit} in one sale${packHint}`
          : `${Math.round(qtyPerSale * 1000) / 1000} ${recipeUnit} × ₹/${recipeUnit}`.trim(),
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
      ['  Uncosted (no portion size)', uncostedDirect],
      [],
      ['Notes'],
      ['Main Recipes — every recipe with its ingredient lines + any [SUB] references it uses.'],
      ['Sub-Recipes — every sub-recipe (Mint Chutney, GG Paste, etc.) with its own ingredient lines.'],
      ['Direct Items — menu items sold AS-IS from a raw material (beers, whiskies, water bottles).'],
      ['Costs use the rolling 90-day weighted-average price normalised by pack_size.'],
      ['Direct Items: a blank "Cost / sale" means the pour size is not configured, NOT zero cost.'],
      ['  Avg Price is ₹ per RECIPE unit (₹/ml, ₹/g) — it only becomes a cost per sale once'],
      ['  "1 sold uses" says how many recipe units one sale is. Each such row names its reason'],
      ['  in "Cost basis"; set the portion on the Menu Items page and re-export.'],
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
      { wch: 36 }, { wch: 10 }, { wch: 8 },
      { wch: 14 }, { wch: 14 }, { wch: 22 },
      { wch: 14 },
    ];
    XLSX.utils.book_append_sheet(wb, wsSub, 'Sub-Recipes');

    const wsDir = XLSX.utils.json_to_sheet(directRows.length ? directRows : [{ 'Sold As': '(no direct items)' }]);
    // 14 widths for 14 keys — the trailing 'Cost basis' carries a sentence, so
    // it gets the wide column; Dismissed stays last.
    wsDir['!cols'] = [
      { wch: 30 }, { wch: 20 }, { wch: 14 }, { wch: 14 }, { wch: 28 },
      { wch: 16 }, { wch: 12 }, { wch: 18 }, { wch: 20 }, { wch: 18 }, { wch: 14 }, { wch: 10 },
      { wch: 64 }, { wch: 10 },
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
      SELECT ri.*, rm.name AS material_name, rm.average_price, rm.unit AS material_unit,
             rm.pack_size AS material_pack_size
      FROM recipe_ingredients ri JOIN raw_materials rm ON rm.id = ri.material_id
      WHERE ri.recipe_id = ? ORDER BY rm.name
    `).all(r.id) as any[];
    if (ings.length === 0) {
      lines.push([r.name, r.category, r.selling_price, r.total_cost, r.food_cost_percent,
        '', '', '', '', '', '', '(no ingredients)'].map(csvEscape).join(','));
      continue;
    }
    for (const ing of ings) {
      const lc = engineLineCost(ing);
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
