import { getDb } from '@/lib/db';
import { getCurrentOutletId, getCurrentUser } from '@/lib/auth';

/**
 * CENTRAL STORE variance report (closing count vs the store's own book).
 *
 * SCOPE — read this before touching the formula. This report answers ONE
 * question: "of everything the CENTRAL STORE took in, how much is still on the
 * central shelf?" It is no longer a whole-building consumption report. Goods
 * issued to a department have LEFT this store; whether the kitchen then cooked
 * them, wasted them or lost them is the Department Variance report's question,
 * not this one.
 *
 * The authoritative formula (per material, cumulative as-of the count date):
 *
 *   Theoretical Central Stock = Purchases
 *                             − Requisition issues to departments
 *                             − Central wastage (store's own shelf only)
 *                             − Party issues / consumption (net of returns)
 *                             − Staff-meal issues (net of returns)
 *   Loss (Variance)           = Theoretical − Physical Closing Stock
 *
 * WHY RECIPE CONSUMPTION IS NOT IN THIS FORMULA — do not "restore" it.
 * Under department-based inventory a gram leaves central EXACTLY ONCE, at
 * requisition issue. Recipe consumption at KOT-complete then debits the
 * DEPARTMENT, never central (see applyDeduct in src/lib/db.ts). All 131
 * recipe-ingredient materials are also requisition-issued, so subtracting both
 * legs here would remove every one of those grams from the central book twice
 * — a straight doubling across the whole recipe set, reported as shrinkage.
 * The 'sale' and 'nc' totals are still SELECTed and returned, as
 * `recipe_to_date` / `recipe_sale_to_date` / `recipe_nc_to_date`, purely as a
 * diagnostic so the number is visible rather than invisible. They contribute
 * ZERO to theoretical_stock. See `report.excludes` in the payload.
 *
 * THE 36 LIVE 'nc' ROWS (1,945 units) ARE EXCLUDED, DELIBERATELY.
 * Comped / non-chargeable food is recipe consumption — the same rail as a
 * sale, fired from the same KOT-complete path — so it leaves the DEPARTMENT,
 * not central, and belongs in the department formula. Note what changed: the
 * old whitelist here was ('sale','party','staff_meal'), which silently dropped
 * 'nc' because nobody had added the string. It is now dropped on purpose, with
 * this reason, and surfaced as `recipe_nc_to_date` so it can be seen.
 *
 * THE TYPE VOCABULARY IS THE REAL ONE, not the one that reads well.
 * The previous whitelist matched ZERO rows for two of its three entries: no
 * writer in this codebase has ever written type='party' or type='staff_meal'.
 * The actual literals, verified against every INSERT INTO inventory_transactions
 * in src/, are 'party_issue' / 'party_consumption' / 'party_return' and
 * 'staff_meal_issue' / 'staff_meal_return'. Getting this wrong does not error —
 * it silently understates the outflow, which reads as surplus on the shelf.
 *
 * SIGNED SUMS, NOT ABS(). Every writer stamps an outflow NEGATIVE and a return
 * POSITIVE (issue-stock.ts:426, wastage:233, parties/items:125 and :208,
 * staff-meals/items:350 and :460, party-fulfillment:123). Summing the signed
 * quantity and negating gives the NET outflow, so a party return or a
 * staff-meal return puts the grams back on the central book by itself. ABS()
 * would count a return as a second issue. A requisition REVERSAL is the same
 * story: applyIssueDelta writes the reversal as a POSITIVE 'requisition_issue'
 * row, so -SUM() nets it out with no special case.
 *
 * WHY CENTRAL WASTAGE IS FILTERED BY DEPARTMENT.
 * /api/wastage writes the inventory_transactions row on BOTH rails on purpose
 * (see its comment at :227) — a chef binning spoiled prep the kitchen already
 * holds debits the DEPARTMENT ledger, but still records a wastage row, so that
 * wastage does not vanish from the audit. Central therefore must count only
 * the store's own shelf: rows whose wastage record carries no department. The
 * filter degrades to "count everything" when the column is absent, which is
 * exactly today's behaviour.
 *
 * WHAT IS DELIBERATELY *NOT* SUBTRACTED (and is reported instead):
 *   - 'transfer'          grocery → floor-store transfers (store-engine.ts:796)
 *   - 'butchering_input'  carcass broken down (butchering:389)
 *   - 'butchering_output' cuts credited back with no purchase row (:401)
 * These are genuine central movements that this formula does not yet model.
 * They hold ZERO rows today, so omitting them is a provable no-op — but rather
 * than leave that silent they are summed into `unmodelled_outflow_to_date` and
 * a top-level warning fires the moment one appears. Promote them into the
 * formula deliberately, with the owner's eyes on it; do not let them rot.
 *   - 'adjustment'        is correctly excluded: variance-approval.ts:234 posts
 *                         it to move current_stock ONTO the counted figure, so
 *                         subtracting it would double-count against
 *                         physical_stock on the very row being counted.
 *
 * Sign convention:
 *   Loss > 0  → leakage / shrinkage (real central stock shorter than the book)
 *   Loss < 0  → surplus (more on the shelf than the book accounts for — usually
 *               an unrecorded inward, an over-issue, or a count error)
 *
 * Note: `system_stock` stored on each `closing_stock` row was captured at the
 * moment of the count from `raw_materials.current_stock`; it is surfaced only
 * as `system_stock_snapshot` for drift detection and feeds no formula.
 *
 * Query params:
 *   from, to        — date range (YYYY-MM-DD). Default: last 30 days.
 *   date            — single closing-count date (overrides from/to).
 *   category        — filter by raw_material category.
 *   material_id     — drill down to one material's history.
 */

const REPORT_TITLE = 'Central Store variance';
const REPORT_SUBTITLE =
  'Goods issued to departments have left the store — they are counted on the '
  + 'Department Variance report, not here.';

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
    // Outlet scoping. NULL-tolerant: a freshly-saved count may briefly carry a
    // NULL outlet_id (pre-backfill on older rows) — still show it in-outlet
    // rather than making a just-recorded count vanish from this report.
    const outletId = await getCurrentOutletId();
    if (outletId) { where.push('(cs.outlet_id = ? OR cs.outlet_id IS NULL)'); params.push(outletId); }
    if (single) { where.push('cs.date = ?'); params.push(single); }
    else { where.push('cs.date BETWEEN ? AND ?'); params.push(from, to); }
    if (category)   { where.push('rm.category = ?'); params.push(category); }
    if (materialId) { where.push('cs.material_id = ?'); params.push(materialId); }
    const WHERE = where.join(' AND ');

    // wastages.department_id is added by the boot migration in src/lib/db.ts
    // (ALTER TABLE wastages ADD COLUMN department_id TEXT). This report must
    // still answer on a database where that migration has not run yet — a
    // hard-coded reference would 500 the whole page instead of degrading. When
    // the column is missing, every wastage row is central, which is precisely
    // the pre-change behaviour, so the fallback is a no-op and not a guess.
    const wastageHasDept = (() => {
      try {
        return (db.prepare(`PRAGMA table_info(wastages)`).all() as any[])
          .some(c => String(c?.name) === 'department_id');
      } catch { return false; }
    })();
    // NOT EXISTS, not a LEFT JOIN + IS NULL: a wastage inventory_transactions
    // row whose reference_id no longer resolves (hand-written, or a legacy row)
    // must stay CENTRAL. Only a row provably tied to a department is dropped.
    const CENTRAL_WASTAGE_ONLY = wastageHasDept
      ? `AND NOT EXISTS (SELECT 1 FROM wastages w
                          WHERE w.id = it.reference_id
                            AND COALESCE(w.department_id, '') <> '')`
      : '';

    // Per-line variance rows.
    //   theoretical_stock is RECOMPUTED FRESH on every read, so a count taken
    //   before a late-recorded purchase or issue self-corrects — no snapshot lag.
    //
    //   loss = theoretical_stock − physical_stock   (positive = leakage; negative = surplus)
    const rows = db.prepare(`
      SELECT cs.id, cs.date, cs.material_id, cs.physical_stock, cs.notes, cs.recorded_by, cs.created_at,
             cs.system_stock AS system_stock_snapshot,
             rm.name AS material_name, rm.sku AS material_sku, rm.unit AS material_unit,
             rm.category, rm.average_price,
             -- purchases.quantity is PURCHASE units; convert to RECIPE units with the
             -- same guarded pack factor every purchase writer applies to stock (see
             -- /api/purchases POST). BOTH HALVES of the guard are required:
             -- pack_size > 1 AND recipe unit <> purchase unit, or PICKLED GINGER
             -- 1.5KG (unit = purchase_unit) gets multiplied and reads 1.5x high.
             -- Factor is a per-material constant, so scaling the SUM is exact.
             COALESCE((SELECT SUM(p.quantity) FROM purchases p
                        WHERE p.material_id = cs.material_id AND p.date <= cs.date), 0)
               * CASE WHEN COALESCE(rm.pack_size, 1) > 1
                           AND LOWER(rm.unit) <> LOWER(COALESCE(rm.purchase_unit, rm.unit))
                      THEN rm.pack_size ELSE 1 END AS purchases_to_date,
             -- The gram leaves central HERE and nowhere else. Negated because the
             -- writer stamps an issue negative and a reversal positive, so this is
             -- the NET quantity still out with the departments.
             COALESCE((SELECT -SUM(it.quantity) FROM inventory_transactions it
                        WHERE it.material_id = cs.material_id
                          AND it.type = 'requisition_issue'
                          AND DATE(it.created_at) <= cs.date), 0) AS issues_to_date,
             -- Central wastage only. Department wastage debits the department
             -- ledger; counting it here would remove the gram from central a
             -- second time (it already left at issue).
             COALESCE((SELECT -SUM(it.quantity) FROM inventory_transactions it
                        WHERE it.material_id = cs.material_id
                          AND it.type = 'wastage'
                          AND DATE(it.created_at) <= cs.date
                          ${CENTRAL_WASTAGE_ONLY}), 0) AS wastage_to_date,
             -- Parties run on their own rail end-to-end: applyIssueDelta skips
             -- purpose='party' outright, so a party requisition never produces a
             -- 'requisition_issue' row and these three types cannot double-count
             -- with issues_to_date. 'party_return' is positive and nets itself off.
             COALESCE((SELECT -SUM(it.quantity) FROM inventory_transactions it
                        WHERE it.material_id = cs.material_id
                          AND it.type IN ('party_issue', 'party_consumption', 'party_return')
                          AND DATE(it.created_at) <= cs.date), 0) AS party_to_date,
             -- Staff meals: 'staff_meal_issue' is negative, 'staff_meal_return'
             -- positive, so the net is what the store is actually short.
             COALESCE((SELECT -SUM(it.quantity) FROM inventory_transactions it
                        WHERE it.material_id = cs.material_id
                          AND it.type IN ('staff_meal_issue', 'staff_meal_return')
                          AND DATE(it.created_at) <= cs.date), 0) AS staff_meal_to_date,
             -- DIAGNOSTIC ONLY. Not in the formula. Recipe consumption debits the
             -- department, never central. Split so the 'nc' exclusion is visible.
             COALESCE((SELECT -SUM(it.quantity) FROM inventory_transactions it
                        WHERE it.material_id = cs.material_id
                          AND it.type = 'sale'
                          AND DATE(it.created_at) <= cs.date), 0) AS recipe_sale_to_date,
             COALESCE((SELECT -SUM(it.quantity) FROM inventory_transactions it
                        WHERE it.material_id = cs.material_id
                          AND it.type = 'nc'
                          AND DATE(it.created_at) <= cs.date), 0) AS recipe_nc_to_date,
             -- DIAGNOSTIC ONLY. Real central movements this formula does not yet
             -- model. Zero rows today. Surfaced so the gap is loud, not silent.
             COALESCE((SELECT -SUM(it.quantity) FROM inventory_transactions it
                        WHERE it.material_id = cs.material_id
                          AND it.type IN ('transfer', 'butchering_input', 'butchering_output')
                          AND DATE(it.created_at) <= cs.date), 0) AS unmodelled_outflow_to_date
      FROM closing_stock cs
      JOIN raw_materials rm ON rm.id = cs.material_id
      WHERE ${WHERE}
      ORDER BY cs.date DESC
    `).all(...params) as any[];

    // Derive theoretical, loss, loss_value in JS so we don't repeat the subqueries
    // and so callers see consistent shape.
    for (const r of rows as any[]) {
      // ONE subtrahend, so a caller can never subtract half the outflow. If you
      // add a channel, add it here AND to report.formula — a screen that shows
      // Purchases − <one column> = Theoretical must have that column to show.
      r.central_outflow_to_date =
          (r.issues_to_date     || 0)
        + (r.wastage_to_date    || 0)
        + (r.party_to_date      || 0)
        + (r.staff_meal_to_date || 0);
      // Diagnostic roll-up of the DEPARTMENT rail. Excluded from theoretical.
      r.recipe_to_date = (r.recipe_sale_to_date || 0) + (r.recipe_nc_to_date || 0);
      r.recipe_in_central_formula = false;

      r.theoretical_stock = (r.purchases_to_date || 0) - r.central_outflow_to_date;
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

    // Repeat offenders — materials counted ≥2 times with real loss, aggregated
    // from the SAME recomputed rows and the SAME outlet/category/date filters,
    // so an offender's ranking can never contradict its own per-line Loss or mix
    // outlets (old code read the stored snapshot cs.variance_value with no
    // outlet filter).
    const roMap = new Map<string, {
      id: string; sku: string; name: string; unit: string;
      times_counted: number; total_abs_variance: number; net_variance: number; last_count: string;
    }>();
    for (const r of rows as any[]) {
      const slot = roMap.get(r.material_id) || {
        id: r.material_id, sku: r.material_sku, name: r.material_name, unit: r.material_unit,
        times_counted: 0, total_abs_variance: 0, net_variance: 0, last_count: r.date,
      };
      slot.times_counted += 1;
      slot.total_abs_variance += Math.abs(r.loss_value || 0);
      slot.net_variance += (r.variance_value || 0);   // legacy sign: physical − theoretical
      if (r.date > slot.last_count) slot.last_count = r.date;
      roMap.set(r.material_id, slot);
    }
    const repeat = Array.from(roMap.values())
      .filter(o => o.times_counted >= 2 && o.total_abs_variance > 0)
      .sort((a, b) => b.total_abs_variance - a.total_abs_variance)
      .slice(0, 20);

    // Top-line summary — built from recomputed rows so it stays in sync with the formula
    let shrinkage = 0, overcount = 0, net_loss_value = 0, counted_stock_value = 0;
    let issued_to_departments_value = 0, recipe_excluded_value = 0, unmodelled_outflow_value = 0;
    const dateSet = new Set<string>();
    for (const r of rows as any[]) {
      if (r.loss_value > 0) shrinkage += r.loss_value;
      else                  overcount += -r.loss_value;
      net_loss_value      += r.loss_value;
      counted_stock_value += r.physical_stock * (r.average_price || 0);
      // Quantities across different materials are not addable; money is. These
      // three are the "what moved off this report" numbers, in rupees, so the
      // exclusions are quantified on screen instead of being taken on trust.
      issued_to_departments_value += (r.issues_to_date   || 0) * (r.average_price || 0);
      recipe_excluded_value       += (r.recipe_to_date   || 0) * (r.average_price || 0);
      unmodelled_outflow_value    += (r.unmodelled_outflow_to_date || 0) * (r.average_price || 0);
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
      issued_to_departments_value,
      recipe_excluded_value,
      unmodelled_outflow_value,
    };

    // Blind count: the count-time system figure (system_stock_snapshot) is the
    // raw "system stock" a counter must not learn. Strip it for non-admins; the
    // recomputed theoretical/loss analysis remains (it's a derived model, not the
    // closing count's system number).
    const me = await getCurrentUser();
    const safeRows = me?.role === 'admin'
      ? rows
      : (rows as any[]).map(r => ({ ...r, system_stock_snapshot: null }));

    // Self-describing header so the page and the CSV export both read their
    // labels from the same place as the formula that produced the numbers.
    // A renamed report whose export still says "variance" is how a central
    // number ends up quoted as a whole-building number in a meeting.
    const warnings: string[] = [];
    if (Math.abs(unmodelled_outflow_value) > 0.005) {
      warnings.push(
        'Some central movements are not in this formula yet '
        + '(grocery→floor transfers, butchering). They are shown per row as '
        + '"unmodelled_outflow_to_date" but are NOT subtracted, so the loss '
        + 'figure is overstated by that amount.',
      );
    }

    return Response.json({
      range: single ? { date: single } : { from, to },
      report: {
        scope: 'central',
        title: REPORT_TITLE,
        subtitle: REPORT_SUBTITLE,
        export_title: REPORT_TITLE,
        export_filename_prefix: 'central-store-variance',
        formula: 'Theoretical = Purchases − Requisition issues − Central wastage − Party − Staff meals',
        outflow_column: 'central_outflow_to_date',
        excludes: [
          'Recipe consumption (sales) — debits the department, not the store',
          'Non-chargeable / complimentary (nc) — same recipe rail as a sale',
          'Department wastage — the department already held those goods',
        ],
      },
      warnings,
      summary,
      rows: safeRows,
      dates,
      by_category: byCategory,
      repeat_offenders: repeat,
    });
  } catch (e: any) {
    console.error('[variance-report]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
