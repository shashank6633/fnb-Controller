import { getDb, generateId, deductInventoryForSale } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { parseRecahoSalesWorkbook, ParsedSaleLine } from '@/lib/recaho-sales';
import { packFactor } from '@/lib/pack-units';
import * as XLSX from 'xlsx';

/**
 * Recaho "Item Wise Sales Report" importer.
 *
 *   1. Upload with commit=false → preview: parsed lines, matched/unmatched menu items,
 *                                  date range, totals per bill_type
 *   2. Upload with commit=true   → atomic import:
 *        - Inserts one `sales` row per Recaho item (qty = TOTAL QTY SOLD over the period)
 *        - Recipe-deducts ingredients via deductInventoryForSale() for items linked to recipes
 *        - bill_type follows sheet: 'normal' | 'comp' | 'nc'
 *        - Date = end_date from the Recaho header (the report is aggregated; we anchor at period close)
 *        - Idempotent: a per-import "import_batch_id" is stored in `sales.notes`-style field
 *          so a re-upload of the same file can be detected by the user via duplicate-day-totals
 *
 * DEPARTMENT ATTRIBUTION (deduct-at-issue rail).
 * Recipe consumption no longer leaves central stock — the gram left central at the
 * requisition issue. It now leaves the DEPARTMENT that cooked the dish, resolved from
 * the menu item's station. A bulk import is the one place where that resolution can
 * fail silently at scale: 600 lines can commit, every sale row can look right, and not
 * one gram can move because the stations on those items are not mapped to a department.
 * So this route classifies every committed line into four mutually-exclusive buckets
 * (department / station_unmapped / liquor_store_rail / no_recipe), returns the counts
 * plus a per-station breakdown of the unmapped ones, and reports the same projection on
 * the PREVIEW response so the operator sees the gap before committing rather than after.
 *
 * Form data:
 *   file                       (required) — the .xlsx
 *   commit                     'true' | 'false' (default false)
 *   anchor_date                'end' | 'start' (default 'end')
 *   create_missing_menu_items  'true' → auto-create one menu_item per unmatched
 *                              PRODUCT NAME and return (no sales rows written).
 *                              Each new menu_item gets:
 *                                name          = Recaho PRODUCT NAME
 *                                category      = Recaho CATEGORY
 *                                station       = Recaho STATION
 *                                item_type     = Recaho ITEM TYPE (foods/liquors/beverages)
 *                                selling_price = AMOUNT / TOTAL QTY (period-avg, recoverable)
 *                                pos_id        = Recaho MAPPED CODE (when present)
 *                                source        = 'pos-import'
 *                                is_active     = 1
 *                              Operator can then re-preview the same workbook;
 *                              previously-unmatched lines will now match.
 */

const VALID_BILL_TYPES = new Set(['normal', 'comp', 'nc']);

function normalize(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me || me.role !== 'admin') {
      return Response.json({ error: 'Admin only — sales import recipe-deducts inventory' }, { status: 403 });
    }

    const form = await request.formData();
    const file = form.get('file');
    const commit = String(form.get('commit') || 'false') === 'true';
    const anchor = String(form.get('anchor_date') || 'end').toLowerCase();
    const createMissingMenu = String(form.get('create_missing_menu_items') || 'false') === 'true';
    if (!file || typeof file === 'string') {
      return Response.json({ error: 'file required (multipart form-data)' }, { status: 400 });
    }

    const ab = await (file as File).arrayBuffer();
    const wb = XLSX.read(ab, { type: 'array' });

    // Build the sheet → rows map. Recaho gives 4 sheets; parser picks the ones it needs.
    const sheets: Record<string, any[][]> = {};
    for (const name of wb.SheetNames) {
      sheets[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' }) as any[][];
    }
    const parsed = parseRecahoSalesWorkbook(sheets);

    if (parsed.lines.length === 0) {
      return Response.json({
        error: 'No sales lines parsed from this workbook.',
        errors: parsed.errors,
        sheets_seen: wb.SheetNames,
      }, { status: 400 });
    }

    const anchorDate = anchor === 'start'
      ? (parsed.start_date_iso || parsed.end_date_iso)
      : (parsed.end_date_iso   || parsed.start_date_iso);
    if (!anchorDate) {
      return Response.json({ error: 'Could not infer date range from workbook header.' }, { status: 400 });
    }

    const db = getDb();

    // -------- Match menu items by mapped_code first, then normalised name --------
    // `station` is selected because it is the ONLY input to department attribution
    // below. It was missing here before deduct-at-issue and nothing noticed, because
    // nothing read it; the re-match SELECT further down (pos-import items) already
    // carried it. Both paths must supply it or half an import attributes to nobody.
    const allMenu = db.prepare(`
      SELECT id, name, pos_id, recipe_id, item_type, selling_price, station
      FROM menu_items WHERE is_active = 1
    `).all() as any[];
    const byPos  = new Map<string, any>();
    const byNorm = new Map<string, any>();
    for (const m of allMenu) {
      if (m.pos_id) byPos.set(String(m.pos_id).toLowerCase().trim(), m);
      byNorm.set(normalize(m.name), m);
    }
    const matchOne = (line: ParsedSaleLine) => {
      if (line.mapped_code) {
        const m = byPos.get(line.mapped_code.toLowerCase().trim());
        if (m) return m;
      }
      return byNorm.get(normalize(line.product_name));
    };

    const matched: Array<{ line: ParsedSaleLine; menu: any }>      = [];
    const unmatched: ParsedSaleLine[]                               = [];
    for (const ln of parsed.lines) {
      const m = matchOne(ln);
      if (m) matched.push({ line: ln, menu: m });
      else   unmatched.push(ln);
    }

    // -------- Create missing menu_items inline --------
    // When called with create_missing_menu_items=true:
    //   - Without commit=true → create then return early (preview-style stats)
    //   - With commit=true    → create, then re-match unmatched lines against the
    //                           newly-created items, then fall through to commit.
    let createdMenuItemsSummary: { count: number; items: any[] } | null = null;
    if (createMissingMenu) {
      // Aggregate unmatched lines by PRODUCT NAME so each unique name → one menu_item.
      // Roll up qty + amount across bill_types so the period selling_price is sensible.
      const byName = new Map<string, {
        name: string; category: string; station: string; item_type: string;
        mapped_code: string; total_qty: number; total_amount: number;
      }>();
      for (const ln of unmatched) {
        const key = normalize(ln.product_name);
        let slot = byName.get(key);
        if (!slot) {
          slot = {
            name: ln.product_name,
            category:    ln.category    || '',
            station:     ln.station     || '',
            item_type:   ln.item_type   || 'foods',
            mapped_code: ln.mapped_code || '',
            total_qty: 0, total_amount: 0,
          };
          byName.set(key, slot);
        }
        slot.total_qty    += ln.total_qty;
        slot.total_amount += ln.amount;
        // Prefer the row that has a mapped_code if multiple rows merged
        if (!slot.mapped_code && ln.mapped_code) slot.mapped_code = ln.mapped_code;
      }

      const insMenu = db.prepare(`
        INSERT INTO menu_items
          (id, name, category, station, item_type, selling_price, listing_price,
           item_code, is_active, source, pos_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, '', 1, 'pos-import', ?, datetime('now'), datetime('now'))
      `);
      const created: Array<{ name: string; selling_price: number; pos_id: string }> = [];
      const txn = db.transaction(() => {
        for (const m of byName.values()) {
          const sellingPrice = m.total_qty > 0
            ? Math.round((m.total_amount / m.total_qty) * 100) / 100
            : 0;
          insMenu.run(
            generateId(), m.name, m.category, m.station, m.item_type,
            sellingPrice, sellingPrice, m.mapped_code,
          );
          created.push({ name: m.name, selling_price: sellingPrice, pos_id: m.mapped_code });
        }
      });
      txn();
      createdMenuItemsSummary = { count: created.length, items: created };
      if (!commit) {
        return Response.json({
          success: true,
          created_missing_menu_items: true,
          created_count: created.length,
          created_items: created.slice(0, 100),
        });
      }
      // Commit was requested too — re-match unmatched lines against the
      // newly-inserted menu_items so they flow into the sales table below.
      const newlyById = new Map<string, any>();
      const newlyByName = new Map<string, any>();
      const refreshed = db.prepare(`
        SELECT id, name, item_code, recipe_id, station, item_type, category, selling_price, listing_price
        FROM menu_items WHERE source = 'pos-import' AND created_at >= datetime('now','-1 minute')
      `).all() as any[];
      for (const mi of refreshed) {
        newlyByName.set(normalize(mi.name), mi);
        if (mi.item_code) newlyById.set(mi.item_code, mi);
      }
      const stillUnmatched: typeof unmatched = [];
      for (const ln of unmatched) {
        const hit = (ln.mapped_code && newlyById.get(ln.mapped_code))
                 || newlyByName.get(normalize(ln.product_name));
        if (hit) matched.push({ line: ln, menu: hit });
        else     stillUnmatched.push(ln);
      }
      unmatched.length = 0;
      unmatched.push(...stillUnmatched);
    }

    // -------- Station → department attribution --------
    // Read the map ONCE per import, outside the commit transaction.
    //
    // WHICH station? The MENU ITEM's, never the Recaho STATION column on the sheet.
    // The live rail copies menu_items.station verbatim into order_items.station
    // (dine-in/orders/[id]/route.ts:148) and applyDeduct resolves the department from
    // that. Falling back to the sheet's station would be an external POS vocabulary,
    // so the same dish would land in a different kitchen depending on whether it was
    // rung up in the app or imported from a file. Do not "improve" this into a fallback
    // chain — an unmapped station must stay unmapped and be reported, not guessed.
    const stationDept = new Map<string, string>();
    let stationMapConfigured = false;
    try {
      const rows = db.prepare(
        `SELECT station, department_id FROM station_departments WHERE is_active = 1`,
      ).all() as any[];
      for (const r of rows) {
        if (r.station && r.department_id) {
          stationDept.set(String(r.station).toLowerCase().trim(), String(r.department_id));
        }
      }
      stationMapConfigured = stationDept.size > 0;
    } catch (e) {
      // Table absent or unreadable. This map is an OBSERVATION used for reporting;
      // the stock decision itself is made inside applyDeduct on the same rule. Fail
      // toward "nothing was attributed" so the response says so loudly, rather than
      // toward a guessed department — a wrong kitchen debited in bulk is far worse
      // than a visible zero.
      console.error('[sales-import] station_departments unreadable — reporting all lines as unmapped', e);
      stationMapConfigured = false;
    }

    // Liquor rides the TGBCL store ledger (store_stock_ledger / store_locations), not
    // the department raw-material rail. Counted as its own bucket so an operator does
    // not read "0 department rows" on a bar-heavy sheet as a broken import.
    const isLiquorLine = (menu: any, line: ParsedSaleLine) =>
      String(menu.item_type || line.item_type || '').toLowerCase().startsWith('liquor')
      || String(menu.station || '').toLowerCase().trim() === 'liquor';

    const stationOf = (menu: any) => String(menu.station || '').trim();

    // Four buckets, MUTUALLY EXCLUSIVE and summing to the committed matched-line count.
    // If a future edit makes a line fall into two of them, the totals stop reconciling
    // and the whole point of this summary (no silent zero) is lost.
    const classify = (menu: any, line: ParsedSaleLine):
      'department' | 'station_unmapped' | 'liquor_store_rail' | 'no_recipe' => {
      if (!menu.recipe_id) return isLiquorLine(menu, line) ? 'liquor_store_rail' : 'no_recipe';
      const st = stationOf(menu).toLowerCase();
      // Blank station is deliberately NOT treated as "kitchen": 'kitchen' is the
      // blank-station sentinel the KOT writer stamps, and 'Kitchen' is a real
      // department (the main-kitchen roll-up). Resolving it would silently debit the
      // busiest kitchen in the building for every station-less item.
      return st && stationDept.has(st) ? 'department' : 'station_unmapped';
    };

    const newAttribution = () => ({
      station_map_configured: stationMapConfigured,
      department_rows: 0,
      station_unmapped_rows: 0,
      liquor_store_rail_rows: 0,
      no_recipe_rows: 0,
      unmapped_by_station: {} as Record<string, number>,
      warning: null as string | null,
    });
    type Attribution = ReturnType<typeof newAttribution>;

    const countLine = (acc: Attribution, menu: any, line: ParsedSaleLine) => {
      switch (classify(menu, line)) {
        case 'department':        acc.department_rows        += 1; break;
        case 'liquor_store_rail': acc.liquor_store_rail_rows += 1; break;
        case 'no_recipe':         acc.no_recipe_rows         += 1; break;
        default: {
          acc.station_unmapped_rows += 1;
          const key = stationOf(menu) || '(blank)';
          acc.unmapped_by_station[key] = (acc.unmapped_by_station[key] || 0) + 1;
        }
      }
    };

    const finishAttribution = (acc: Attribution): Attribution => {
      if (!acc.station_map_configured) {
        acc.warning = 'No station → department mapping is configured, so no recipe line '
          + 'can be attributed to a department. Map the stations in Settings, then re-import.';
      } else if (acc.station_unmapped_rows > 0) {
        const names = Object.entries(acc.unmapped_by_station)
          .sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} (${n})`).join(', ');
        acc.warning = `${acc.station_unmapped_rows} recipe line(s) consumed nothing from any `
          + `department because their station is not mapped: ${names}. `
          + 'Central stock was NOT touched for these — map the stations and record the '
          + 'difference as a department count.';
      }
      return acc;
    };

    /* ── DIRECT-ITEM COST BASIS (lines with no recipe) ─────────────────────
     * THE DIMENSION RULE. A line's cost is quantity × rate, and the two halves
     * must be in the SAME basis. Name the basis of each factor:
     *
     *   line.total_qty        — ITEMS SOLD (pegs, plates, bottles). It is a
     *                           COUNT. It is never a weight and never a volume.
     *   rm.average_price      — ₹ per RECIPE unit (₹/ml, ₹/g, ₹/pcs) per the
     *                           house canon. It is NOT ₹ per item sold.
     *   dil.qty_per_unit      — RECIPE units consumed per ITEM SOLD (30 for a
     *                           30 ml peg, 700 for a full bottle, 4 for a
     *                           bucket of beer). This is the ONLY factor that
     *                           converts ₹/recipe-unit into ₹/item-sold.
     *
     * So the one dimensionally sound product is
     *     ₹/recipe-unit  ×  recipe-units-per-item  ×  items-sold.
     *
     * When qty_per_unit is unset it defaults to 1, and for a MEASURED material
     * (ml / l / g / kg) "1" is never a real portion — nobody sells one
     * millilitre of gin or one gram of mutton. The default therefore silently
     * priced ITEMS SOLD at ₹ per RECIPE unit: HENDRICKS 30ML booked
     * 62 pegs × ₹5,641.83 = ₹3,49,793 of cost against ₹54,498 of revenue, a
     * 642% food cost that reads as a plausible number on screen.
     *
     * /api/menu-items:56-62 already refuses to DISPLAY a cost in exactly this
     * case (its CASE expression returns NULL so the UI shows "—"). This is the
     * same guard on the WRITER, which is where the money is actually booked.
     * ₹0 + a named un-costed line is the honest answer: the hole stays visible
     * and /api/reports/menu-recipe-gap measures it, instead of a fabricated
     * cost that reconciles with nothing.
     *
     * PIECE-COUNTED materials (unit = pcs / btl / nos / …) keep the
     * 1-sold = 1-piece default, because for them that IS the portion — one
     * bottled beer sold is one bottle out. They are unaffected by this guard.
     *
     * NOT A BACKFILL. Sales rows already carrying the old product are left
     * exactly as they are; rewriting the owner's booked history is not this
     * route's call. The guard stops new imports compounding it.
     * ─────────────────────────────────────────────────────────────────────── */

    // Recipe units that are a MEASURE, not a count. Same list, same order as
    // the menu-items CASE expression — if one is edited the other must be.
    const MEASURED_RECIPE_UNITS = new Set(['ml', 'l', 'g', 'kg']);

    const findDirectLink = db.prepare(`
      SELECT material_id, qty_per_unit FROM direct_item_links WHERE item_name = ? COLLATE NOCASE
    `);
    // unit / purchase_unit / pack_size ride along so the guard can tell a
    // measure from a count, and so the un-costed line can name the pack size
    // the operator most likely wants as the portion. packFactor() carries the
    // both-halves guard (pack_size > 1 AND unit !== purchase_unit), so a
    // kg/kg material like PICKLED GINGER 1.5KG reports no pack hint at all
    // rather than a bogus one.
    const findMat = db.prepare(`
      SELECT id, name, unit, purchase_unit, pack_size, average_price
      FROM raw_materials WHERE id = ?
    `);

    type DirectCost = {
      lineCost: number;
      /** Set only when the cost was SUPPRESSED by the portion-size guard. */
      uncosted: null | {
        item_name: string;
        material_name: string;
        material_unit: string;
        qty_sold: number;
        revenue: number;
        /** Recipe units in one purchase unit, when a real pack conversion exists. */
        pack_hint: number | null;
        purchase_unit: string | null;
        reason: string;
      };
    };

    const directCostOf = (menu: any, line: ParsedSaleLine): DirectCost => {
      // Try the explicit direct-item link first, then menu_items.material_id.
      const dil = findDirectLink.get(line.product_name) as any;
      const matId = dil?.material_id || menu.material_id || null;
      if (!matId) return { lineCost: 0, uncosted: null };
      const mat = findMat.get(matId) as any;
      if (!mat || !(mat.average_price > 0)) return { lineCost: 0, uncosted: null };

      // qty_per_unit = RECIPE units per ITEM SOLD. Absent → 1.
      const qpu = Number(dil?.qty_per_unit) > 0 ? Number(dil.qty_per_unit) : 1;
      const isMeasured = MEASURED_RECIPE_UNITS.has(
        String(mat.unit || '').toLowerCase().trim(),
      );

      if (isMeasured && qpu === 1) {
        // ₹/ml × items-sold would be dimensionally wrong by the portion size.
        // Book nothing and say so.
        const pf = packFactor(mat);
        return {
          lineCost: 0,
          uncosted: {
            item_name: line.product_name,
            material_name: mat.name,
            material_unit: String(mat.unit || ''),
            qty_sold: line.total_qty,
            revenue: line.amount,
            pack_hint: pf > 1 ? pf : null,
            purchase_unit: mat.purchase_unit || null,
            reason: 'no_portion_size',
          },
        };
      }

      // Dimensionally sound: ₹/recipe-unit × recipe-units-per-item × items-sold.
      return { lineCost: mat.average_price * qpu * line.total_qty, uncosted: null };
    };

    const newUncosted = () => ({
      rows: 0,
      qty: 0,
      revenue: 0,
      items: [] as NonNullable<DirectCost['uncosted']>[],
      warning: null as string | null,
    });
    type Uncosted = ReturnType<typeof newUncosted>;

    const countUncosted = (acc: Uncosted, u: NonNullable<DirectCost['uncosted']>) => {
      acc.rows    += 1;
      acc.qty     += u.qty_sold;
      acc.revenue += u.revenue;
      acc.items.push(u);
    };

    const finishUncosted = (acc: Uncosted): Uncosted => {
      if (acc.rows > 0) {
        acc.warning = `${acc.rows} direct-sell line(s) booked ZERO food cost because their `
          + 'material is measured (ml/g) and no portion size is configured. Set '
          + 'direct_item_links.qty_per_unit (recipe units per item sold — e.g. 30 for a '
          + '30 ml peg, 700 for a full bottle) on the Menu Items page, then re-import. '
          + 'A zero here is deliberate: costing a peg at ₹ per millilitre overstates food '
          + 'cost by the portion size and cannot be unwound once booked.';
      }
      return acc;
    };

    // -------- Preview only --------
    if (!commit) {
      const matched_with_recipe = matched.filter(x => x.menu.recipe_id).length;
      // Same classification the commit will perform, run read-only, so the station gap
      // is visible BEFORE the sales rows exist rather than in the post-mortem.
      const previewAttribution = newAttribution();
      // Same reason, run read-only for the portion-size guard: an operator must
      // see WHICH lines will book zero food cost before committing, not after.
      const previewUncosted = newUncosted();
      for (const { line, menu } of matched) {
        if (!VALID_BILL_TYPES.has(line.bill_type)) continue;
        countLine(previewAttribution, menu, line);
        if (!menu.recipe_id) {
          const u = directCostOf(menu, line).uncosted;
          if (u) countUncosted(previewUncosted, u);
        }
      }
      finishAttribution(previewAttribution);
      finishUncosted(previewUncosted);
      return Response.json({
        preview: true,
        date_range: { start: parsed.start_date_iso, end: parsed.end_date_iso, anchor: anchorDate },
        business_name: parsed.business_name,
        totals_by_bill_type: parsed.by_bill_type,
        line_count: parsed.lines.length,
        matched_count:        matched.length,
        matched_with_recipe,
        matched_no_recipe:    matched.length - matched_with_recipe,
        station_attribution:  previewAttribution,
        station_warning:      previewAttribution.warning,
        uncosted_direct_items: {
          count:   previewUncosted.rows,
          qty:     previewUncosted.qty,
          revenue: Math.round(previewUncosted.revenue * 100) / 100,
          items:   previewUncosted.items.slice(0, 50),
        },
        uncosted_warning:     previewUncosted.warning,
        unmatched_count:      unmatched.length,
        unmatched_items:      unmatched.slice(0, 50).map(u => ({
          product_name: u.product_name, mapped_code: u.mapped_code,
          category: u.category, station: u.station, qty: u.total_qty, amount: u.amount,
          bill_type: u.bill_type,
        })),
        sample_matched:       matched.slice(0, 10).map(x => ({
          product_name: x.line.product_name,
          menu_name: x.menu.name,
          has_recipe: !!x.menu.recipe_id,
          qty: x.line.total_qty, amount: x.line.amount, bill_type: x.line.bill_type,
        })),
        errors: parsed.errors,
      });
    }

    // -------- Commit --------
    const insSale = db.prepare(`
      INSERT INTO sales (id, item_name, recipe_id, quantity_sold, bill_type, selling_price,
                         total_revenue, total_cost, date, created_at,
                         category, pos_item_id, pos_item_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'),
              ?, ?, ?)
    `);
    const summary = {
      sales_created: 0,
      qty_total: 0,
      revenue_total: 0,
      recipe_deducted_count: 0,
      skipped_unmatched: unmatched.length,
      bill_types: { normal: 0, comp: 0, nc: 0 } as Record<string, number>,
      // Where each committed line's consumption actually landed. Populated in the
      // commit loop below; the four row counts sum to sales_created by construction.
      station_attribution: newAttribution(),
      // Direct-sell lines whose cost was SUPPRESSED by the portion-size guard.
      // Not a bucket of station_attribution — it cuts across it and must never
      // be added to those counts.
      uncosted_direct_items: newUncosted(),
    };

    const txn = db.transaction(() => {
      for (const { line, menu } of matched) {
        if (!VALID_BILL_TYPES.has(line.bill_type)) continue;
        const sellingPrice = line.total_qty > 0 ? (line.amount / line.total_qty) : (menu.selling_price || 0);
        const totalRevenue = line.bill_type === 'normal' ? line.amount : 0;
        // Cost computation:
        //   - Recipe-linked → recipe.total_cost × qty  (both per-serving: sound)
        //   - Direct item   → directCostOf(), which enforces the dimension rule
        //                     documented above and books 0 + an un-costed record
        //                     rather than ₹/ml × items-sold
        //   - Otherwise     → 0 (unmatched, surfaces as 100% margin in reports)
        let lineCost = 0;
        if (menu.recipe_id) {
          const r = db.prepare('SELECT total_cost FROM recipes WHERE id = ?').get(menu.recipe_id) as any;
          if (r) lineCost = (r.total_cost || 0) * line.total_qty;
        } else {
          const dc = directCostOf(menu, line);
          lineCost = dc.lineCost;
          if (dc.uncosted) countUncosted(summary.uncosted_direct_items, dc.uncosted);
        }
        const id = generateId();
        insSale.run(
          id, line.product_name, menu.recipe_id || null,
          line.total_qty, line.bill_type, sellingPrice,
          totalRevenue, Math.round(lineCost * 100) / 100, anchorDate,
          line.category || null, menu.pos_id || line.mapped_code || null, line.product_name,
        );
        if (menu.recipe_id) {
          // Pass the station so applyDeduct can resolve the DEPARTMENT that cooked this
          // dish. Central is not touched here any more — the gram left central at the
          // requisition issue. When the station resolves to nothing, applyDeduct posts
          // to no stock rail at all and records a consumption_skip; it still writes the
          // inventory_transactions row, which is what keeps Sales-vs-Purchase and the
          // Variance recipe_to_date figure bit-identical to a pre-change import.
          deductInventoryForSale(
            db, menu.recipe_id, line.total_qty, id, line.bill_type,
            { station: stationOf(menu) },
          );
          summary.recipe_deducted_count += 1;
        }
        countLine(summary.station_attribution, menu, line);
        summary.sales_created += 1;
        summary.qty_total     += line.total_qty;
        summary.revenue_total += totalRevenue;
        summary.bill_types[line.bill_type] = (summary.bill_types[line.bill_type] || 0) + 1;
      }
    });
    txn();
    finishAttribution(summary.station_attribution);
    finishUncosted(summary.uncosted_direct_items);
    // The item list is capped for the wire; rows / qty / revenue above it are
    // accumulated over EVERY suppressed line, so the cap can never understate.
    summary.uncosted_direct_items.revenue =
      Math.round(summary.uncosted_direct_items.revenue * 100) / 100;
    summary.uncosted_direct_items.items = summary.uncosted_direct_items.items.slice(0, 50);

    return Response.json({
      success: true,
      committed: true,
      anchor_date: anchorDate,
      summary,
      // Lifted out of `summary` as well so a caller rendering only the top level cannot
      // miss it. An import that attributed nothing must never look like a clean import.
      station_warning: summary.station_attribution.warning,
      // Same reasoning as station_warning: lifted to the top level so a caller
      // rendering only the envelope cannot miss that some lines booked ₹0 cost
      // on purpose. A zero food cost must never look like a clean import.
      uncosted_warning: summary.uncosted_direct_items.warning,
      unmatched_items: unmatched.slice(0, 100).map(u => u.product_name),
      auto_created_menu_items: createdMenuItemsSummary
        ? { count: createdMenuItemsSummary.count, sample: createdMenuItemsSummary.items.slice(0, 10) }
        : null,
    });
  } catch (e: any) {
    console.error('[sales-import]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
