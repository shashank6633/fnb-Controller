import { getDb } from '@/lib/db';
import { getCurrentOutletId } from '@/lib/auth';

/**
 * Closing-stock variance report.
 *
 * The authoritative formulas (per material, cumulative as-of the count date):
 *
 *   Theoretical Stock (Recipe Calc) = Purchases − Recipe Consumption
 *   Loss (Variance)                 = Theoretical − Physical Closing Stock
 *                                   = Purchases − Recipe − Closing Stock
 *
 * Where:
 *   - Purchases          = Σ quantity in `purchases` table up to & incl. count date,
 *                          converted purchase-units → RECIPE units (× pack_size under
 *                          the same guard every purchase writer uses: pack_size > 1
 *                          AND recipe unit ≠ purchase unit). `purchases.quantity` is
 *                          stored in PURCHASE units (kg/BTL); everything else in this
 *                          formula (recipe, wastage, physical) is RECIPE units (g/ml).
 *   - Recipe Consumption = Σ |qty| in `inventory_transactions` of type
 *                          ('sale' | 'party' | 'staff_meal') up to & incl. count date
 *   - Internal transfers (`type='issue'` or imported requisitions) are EXCLUDED.
 *
 * Sign convention:
 *   Loss > 0  → leakage / shrinkage (real inventory shorter than books say)
 *   Loss < 0  → surplus  (more on shelf than recipes account for — usually means
 *               an unrecorded inward, an over-recipe-deduction, or a count error)
 *
 * Note: `system_stock` stored on each `closing_stock` row was captured at the
 * moment of the count from `raw_materials.current_stock`. Under the strict
 * "Purchases − Recipe" model that already equals theoretical stock, so we
 * surface it as `theoretical_stock` and derive `loss = theoretical - physical`.
 *
 * Query params:
 *   from, to        — date range (YYYY-MM-DD). Default: last 30 days.
 *   date            — single closing-count date (overrides from/to).
 *   category        — filter by raw_material category.
 *   material_id     — drill down to one material's history.
 */
export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const single = url.searchParams.get('date');
    const from   = url.searchParams.get('from') || (() => {
      const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10);
    })();
    const to     = url.searchParams.get('to')   || new Date().toISOString().slice(0, 10);
    const category    = url.searchParams.get('category') || '';
    const materialId  = url.searchParams.get('material_id') || '';

    const where: string[] = [];
    const params: any[] = [];
    // Outlet scoping
    const outletId = await getCurrentOutletId();
    if (outletId) { where.push('cs.outlet_id = ?'); params.push(outletId); }
    if (single) { where.push('cs.date = ?'); params.push(single); }
    else { where.push('cs.date BETWEEN ? AND ?'); params.push(from, to); }
    if (category)   { where.push('rm.category = ?'); params.push(category); }
    if (materialId) { where.push('cs.material_id = ?'); params.push(materialId); }
    const WHERE = where.join(' AND ');

    // Per-line variance rows.
    //   theoretical_stock is RECOMPUTED FRESH on every read = (purchases_to_date − recipe_to_date).
    //   This means: as recipes get wired up and sales recipe-deduct, historical closing-stock
    //   counts retroactively get the correct theoretical & loss numbers — no snapshot lag.
    //
    //   loss = theoretical_stock − physical_stock   (positive = leakage; negative = surplus)
    //
    //   `system_stock` (captured at count time) is kept on each row as `system_stock_snapshot`
    //   for debugging / drift detection. The formula columns no longer depend on it.
    const rows = db.prepare(`
      SELECT cs.id, cs.date, cs.material_id, cs.physical_stock, cs.notes, cs.recorded_by, cs.created_at,
             cs.system_stock AS system_stock_snapshot,
             rm.name AS material_name, rm.sku AS material_sku, rm.unit AS material_unit,
             rm.category, rm.average_price,
             -- purchases.quantity is PURCHASE units; convert to RECIPE units with the
             -- same guarded pack factor every purchase writer applies to stock (see
             -- /api/purchases POST). Factor is a per-material constant, so scaling
             -- the SUM is exact.
             COALESCE((SELECT SUM(p.quantity) FROM purchases p
                        WHERE p.material_id = cs.material_id AND p.date <= cs.date), 0)
               * CASE WHEN COALESCE(rm.pack_size, 1) > 1
                           AND LOWER(rm.unit) <> LOWER(COALESCE(rm.purchase_unit, rm.unit))
                      THEN rm.pack_size ELSE 1 END AS purchases_to_date,
             COALESCE((SELECT SUM(ABS(it.quantity)) FROM inventory_transactions it
                        WHERE it.material_id = cs.material_id
                          AND it.type IN ('sale', 'party', 'staff_meal')
                          AND DATE(it.created_at) <= cs.date), 0) AS recipe_to_date,
             -- Phase 1 §6: wastage is its own consumption channel, counted alongside recipe.
             COALESCE((SELECT SUM(ABS(it.quantity)) FROM inventory_transactions it
                        WHERE it.material_id = cs.material_id
                          AND it.type = 'wastage'
                          AND DATE(it.created_at) <= cs.date), 0) AS wastage_to_date
      FROM closing_stock cs
      JOIN raw_materials rm ON rm.id = cs.material_id
      WHERE ${WHERE}
      ORDER BY cs.date DESC
    `).all(...params) as any[];

    // Derive theoretical, loss, loss_value in JS so we don't repeat the subqueries
    // and so callers see consistent shape.
    for (const r of rows as any[]) {
      // Theoretical = Purchases − Recipe − Wastage. Loss = Theoretical − Closing.
      r.theoretical_stock = (r.purchases_to_date || 0) - (r.recipe_to_date || 0) - (r.wastage_to_date || 0);
      r.loss              = r.theoretical_stock - r.physical_stock;
      r.loss_value        = r.loss * (r.average_price || 0);
      // Keep these for back-compat with anything still reading old field names
      r.system_stock      = r.theoretical_stock;
      r.variance          = r.physical_stock - r.theoretical_stock;
      r.variance_value    = r.variance * (r.average_price || 0);
    }
    // Re-sort by absolute loss after computation
    (rows as any[]).sort((a, b) => Math.abs(b.loss_value) - Math.abs(a.loss_value));

    // Distinct closing dates in this window (for the date picker on the page).
    // Aggregate from the freshly-computed rows so dates summary stays consistent
    // with the formula even when recipes get wired up later.
    const datesMap = new Map<string, { items: number; net_loss_value: number; shrinkage: number; overcount: number }>();
    for (const r of rows as any[]) {
      const slot = datesMap.get(r.date) || { items: 0, net_loss_value: 0, shrinkage: 0, overcount: 0 };
      slot.items += 1;
      slot.net_loss_value += r.loss_value;
      if (r.loss_value > 0) slot.shrinkage += r.loss_value;
      else                  slot.overcount += -r.loss_value;
      datesMap.set(r.date, slot);
    }
    const dates = Array.from(datesMap.entries())
      .map(([date, s]) => ({ date, items_counted: s.items, net_variance: -s.net_loss_value,
                              shrinkage: s.shrinkage, overcount: s.overcount }))
      .sort((a, b) => (a.date < b.date ? 1 : -1));

    // Aggregate by category from the recomputed rows
    const catMap = new Map<string, { items: number; shrinkage: number; overcount: number; net: number }>();
    for (const r of rows as any[]) {
      const cat = r.category || 'other';
      const slot = catMap.get(cat) || { items: 0, shrinkage: 0, overcount: 0, net: 0 };
      slot.items += 1;
      slot.net   += -r.loss_value;   // keep legacy "net_variance" sign convention (positive = surplus)
      if (r.loss_value > 0) slot.shrinkage += r.loss_value;
      else                  slot.overcount += -r.loss_value;
      catMap.set(cat, slot);
    }
    const byCategory = Array.from(catMap.entries())
      .map(([category, s]) => ({ category, items_counted: s.items,
                                  shrinkage: s.shrinkage, overcount: s.overcount, net_variance: s.net }))
      .sort((a, b) => b.shrinkage - a.shrinkage);

    // Repeat offenders — materials whose ABSOLUTE variance > ₹X across multiple counts in range
    const repeat = db.prepare(`
      SELECT rm.id, rm.sku, rm.name, rm.unit,
             COUNT(*) AS times_counted,
             SUM(ABS(cs.variance_value)) AS total_abs_variance,
             SUM(cs.variance_value) AS net_variance,
             MAX(cs.date) AS last_count
      FROM closing_stock cs
      JOIN raw_materials rm ON rm.id = cs.material_id
      WHERE cs.date BETWEEN ? AND ? AND ABS(cs.variance) > 0
      GROUP BY rm.id
      HAVING times_counted >= 2
      ORDER BY total_abs_variance DESC
      LIMIT 20
    `).all(from, to);

    // Top-line summary — built from recomputed rows so it stays in sync with the formula
    let shrinkage = 0, overcount = 0, net_loss_value = 0, counted_stock_value = 0;
    const dateSet = new Set<string>();
    for (const r of rows as any[]) {
      if (r.loss_value > 0) shrinkage += r.loss_value;
      else                  overcount += -r.loss_value;
      net_loss_value      += r.loss_value;
      counted_stock_value += r.physical_stock * (r.average_price || 0);
      dateSet.add(r.date);
    }
    const summary = {
      count_dates: dateSet.size,
      lines: rows.length,
      shrinkage, overcount,
      // Keep legacy sign convention (positive = surplus) for backward compat with the page
      net_variance: -net_loss_value,
      // New: explicit loss-positive number for plain-English reporting
      net_loss_value,
      counted_stock_value,
    };

    return Response.json({
      range: single ? { date: single } : { from, to },
      summary,
      rows,
      dates,
      by_category: byCategory,
      repeat_offenders: repeat,
    });
  } catch (e: any) {
    console.error('[variance-report]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
