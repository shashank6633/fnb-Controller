import { getDb, generateId, deductInventoryForSale } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { parseRecahoSalesWorkbook, ParsedSaleLine } from '@/lib/recaho-sales';
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
    const allMenu = db.prepare(`
      SELECT id, name, pos_id, recipe_id, item_type, selling_price
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

    // -------- Preview only --------
    if (!commit) {
      const matched_with_recipe = matched.filter(x => x.menu.recipe_id).length;
      return Response.json({
        preview: true,
        date_range: { start: parsed.start_date_iso, end: parsed.end_date_iso, anchor: anchorDate },
        business_name: parsed.business_name,
        totals_by_bill_type: parsed.by_bill_type,
        line_count: parsed.lines.length,
        matched_count:        matched.length,
        matched_with_recipe,
        matched_no_recipe:    matched.length - matched_with_recipe,
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
    };

    // Helper: look up direct-item link (material_id + qty_per_unit) for an item name
    const findDirectLink = db.prepare(`
      SELECT material_id, qty_per_unit FROM direct_item_links WHERE item_name = ? COLLATE NOCASE
    `);
    const findMatPrice = db.prepare(`SELECT average_price FROM raw_materials WHERE id = ?`);

    const txn = db.transaction(() => {
      for (const { line, menu } of matched) {
        if (!VALID_BILL_TYPES.has(line.bill_type)) continue;
        const sellingPrice = line.total_qty > 0 ? (line.amount / line.total_qty) : (menu.selling_price || 0);
        const totalRevenue = line.bill_type === 'normal' ? line.amount : 0;
        // Cost computation:
        //   - Recipe-linked → recipe.total_cost × qty
        //   - Direct item (material_id) → material.average_price × qty × qty_per_unit
        //   - Otherwise → 0 (unmatched, surfaces as 100% margin in reports)
        let lineCost = 0;
        if (menu.recipe_id) {
          const r = db.prepare('SELECT total_cost FROM recipes WHERE id = ?').get(menu.recipe_id) as any;
          if (r) lineCost = (r.total_cost || 0) * line.total_qty;
        } else {
          // Try direct-item link first, then menu_items.material_id as fallback
          const dil = findDirectLink.get(line.product_name) as any;
          const matId = dil?.material_id || menu.material_id || null;
          if (matId) {
            const mat = findMatPrice.get(matId) as any;
            const qpu = Number(dil?.qty_per_unit) > 0 ? Number(dil.qty_per_unit) : 1;
            if (mat && mat.average_price > 0) {
              lineCost = mat.average_price * line.total_qty * qpu;
            }
          }
        }
        const id = generateId();
        insSale.run(
          id, line.product_name, menu.recipe_id || null,
          line.total_qty, line.bill_type, sellingPrice,
          totalRevenue, Math.round(lineCost * 100) / 100, anchorDate,
          line.category || null, menu.pos_id || line.mapped_code || null, line.product_name,
        );
        if (menu.recipe_id) {
          deductInventoryForSale(db, menu.recipe_id, line.total_qty, id, line.bill_type);
          summary.recipe_deducted_count += 1;
        }
        summary.sales_created += 1;
        summary.qty_total     += line.total_qty;
        summary.revenue_total += totalRevenue;
        summary.bill_types[line.bill_type] = (summary.bill_types[line.bill_type] || 0) + 1;
      }
    });
    txn();

    return Response.json({
      success: true,
      committed: true,
      anchor_date: anchorDate,
      summary,
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
