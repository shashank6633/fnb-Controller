import { getDb } from '@/lib/db';
import { getCurrentOutletId } from '@/lib/auth';

/**
 * Department-wise material consumption analytics.
 *
 * Source of truth: `requisition_items.quantity_issued` aggregated by department & material
 * over a date window, valued at the material's average_price (rupee context).
 *
 * Reminder: this is consumption *from the department's perspective* (what each kitchen
 * received from main store). It's analytics-only — does NOT relate to recipe-driven
 * inventory deductions, which run on a separate rail.
 *
 * Query params:
 *   from, to        date range, default last 30 days
 *   department_id   restrict to one dept
 *   category        restrict to one raw_material category
 *   material_id     restrict to one material (drill-down)
 *
 * Response sections:
 *   summary         { total_qty_value, departments, materials, requisitions }
 *   by_department   [{ department_id, department_name, code,
 *                       material_count, line_count, requisition_count,
 *                       total_qty, total_value }]
 *   by_department_material   matrix: [{ department, material, qty, value }]
 *   top_materials   [{ material, total_qty, total_value, distinct_depts }]
 *   trend_by_day    [{ date, total_qty_value }]   for chart
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const from         = url.searchParams.get('from') || (() => {
      const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10);
    })();
    const to           = url.searchParams.get('to')   || new Date().toISOString().slice(0, 10);
    const departmentId = url.searchParams.get('department_id') || '';
    const categoryF    = url.searchParams.get('category') || '';
    const materialId   = url.searchParams.get('material_id') || '';

    const where: string[] = ['r.date BETWEEN ? AND ?', `r.status NOT IN ('cancelled', 'chef_rejected')`];
    const params: any[] = [from, to];
    const outletId = await getCurrentOutletId();
    if (outletId)     { where.push('(r.outlet_id = ? OR r.outlet_id IS NULL)'); params.push(outletId); }
    if (departmentId) { where.push('r.department_id = ?'); params.push(departmentId); }
    if (categoryF)    { where.push('rm.category = ?');     params.push(categoryF); }
    if (materialId)   { where.push('ri.material_id = ?');  params.push(materialId); }
    const WHERE = where.join(' AND ');

    // ── REGISTER view: "on which DATE which DEPARTMENT took what ITEMS" ───────
    // Groups actual store-issue events (unrolled from requisition_items.issue_history)
    // by handover date × department × material. The date filter applies to the
    // ISSUE timestamp (when it left the store), which is the truest movement date.
    if ((url.searchParams.get('view') || '') === 'register') {
      const rw: string[] = ["ri.issue_history IS NOT NULL", "ri.issue_history != ''", "ri.issue_history != '[]'",
        "r.status NOT IN ('cancelled','chef_rejected')"];
      const rp: any[] = [];
      if (outletId)     { rw.push('(r.outlet_id = ? OR r.outlet_id IS NULL)'); rp.push(outletId); }
      if (departmentId) { rw.push('(ri.department_id = ? OR r.department_id = ?)'); rp.push(departmentId, departmentId); }
      if (categoryF)    { rw.push('rm.category = ?'); rp.push(categoryF); }
      if (materialId)   { rw.push('ri.material_id = ?'); rp.push(materialId); }
      const rows = db.prepare(`
        SELECT ri.req_id, ri.material_id, ri.issue_history, ri.unit AS req_unit,
               rm.name AS material_name, rm.unit, rm.category, rm.average_price,
               rm.purchase_unit, rm.pack_size,
               r.req_number,
               COALESCE(dl.name, dr.name) AS department_name,
               COALESCE(ri.department_id, r.department_id) AS department_id
        FROM requisition_items ri
        JOIN raw_materials rm ON rm.id = ri.material_id
        JOIN requisitions r   ON r.id  = ri.req_id
        LEFT JOIN departments dr ON dr.id = r.department_id
        LEFT JOIN departments dl ON dl.id = ri.department_id
        WHERE ${rw.join(' AND ')}
      `).all(...rp) as any[];

      const map = new Map<string, any>();
      const days = new Set<string>(), depts = new Set<string>(), mats = new Set<string>();
      let totQty = 0, totVal = 0;
      for (const row of rows) {
        let hist: any[] = [];
        try { hist = JSON.parse(row.issue_history || '[]'); } catch { continue; }
        if (!Array.isArray(hist)) continue;
        // VALUE BASIS (deliberate — do not "simplify" back):
        // issue_history entries' qty are written by the store-issue route in the
        // line's REQUESTED unit (ri.unit): store-issue pushes {qty: addQty} where
        // addQty accumulates into quantity_issued, which is compared against
        // chef_approved_qty / quantity_requested — all in ri.unit. average_price
        // is ₹/RECIPE-unit, so convert with the same reqPackFactor semantics the
        // requisition screens and party-events/pnl use: × pack_size only when the
        // line was requested in the material's PURCHASE unit (e.g. 1 BTL = 750 ml).
        // Legacy rows with a blank ri.unit stay ×1.
        // NEVER use last_purchase_price here: it is ₹/PURCHASE-unit, so
        // qty-in-requested/recipe-units × last_purchase_price mixes bases
        // (the old `last_purchase_price || average_price` fallback overvalued
        // e.g. 5 g of a material bought in 1 kg bags by ×1000).
        const packFactor =
          (String(row.req_unit || '').trim() !== '' &&
           row.req_unit === row.purchase_unit &&
           row.req_unit !== row.unit &&
           (Number(row.pack_size) || 1) > 1)
            ? Number(row.pack_size) : 1;
        const unitCost = (Number(row.average_price) || 0) * packFactor;
        for (const h of hist) {
          const day = String(h && h.at || '').slice(0, 10);
          if (!day || day < from || day > to) continue;
          const qty = Number(h.qty) || 0; if (qty <= 0) continue;
          const key = day + '|' + (row.department_id || '') + '|' + row.material_id;
          let g = map.get(key);
          if (!g) {
            g = { date: day, department_id: row.department_id || '', department_name: row.department_name || '—',
                  material_id: row.material_id, material_name: row.material_name, unit: row.unit, category: row.category || '',
                  qty: 0, value: 0, reqs: new Set<string>() };
            map.set(key, g);
          }
          g.qty += qty; g.value += qty * unitCost; g.reqs.add(row.req_number);
          days.add(day); depts.add(row.department_id || ''); mats.add(row.material_id);
          totQty += qty; totVal += qty * unitCost;
        }
      }
      const regRows = [...map.values()]
        .map(g => ({ date: g.date, department_id: g.department_id, department_name: g.department_name,
          material_id: g.material_id, material_name: g.material_name, unit: g.unit, category: g.category,
          qty: Math.round(g.qty * 1000) / 1000, value: Math.round(g.value * 100) / 100, req_count: g.reqs.size }))
        .sort((a, b) => b.date.localeCompare(a.date) || a.department_name.localeCompare(b.department_name) || b.value - a.value);
      return Response.json({
        view: 'register', range: { from, to }, rows: regRows,
        totals: { rows: regRows.length, total_qty: Math.round(totQty * 1000) / 1000, total_value: Math.round(totVal * 100) / 100,
          days: days.size, departments: depts.size, materials: mats.size },
      });
    }

    // Value math (all 5 aggregates below): quantity_issued is in ri.unit — the unit
    // the line was REQUESTED in, which may be the material's PURCHASE unit (1 BTL =
    // 750 ml) — while average_price is ₹/RECIPE-unit. Convert with the same pack
    // factor the requisition screens use (reqPackFactor, same CASE as
    // party-events/pnl): × pack_size only when the line was requested in the
    // purchase unit. Legacy rows with a blank ri.unit stay ×1.
    const summary = db.prepare(`
      SELECT
        COUNT(DISTINCT r.id)             AS requisition_count,
        COUNT(DISTINCT r.department_id)  AS departments,
        COUNT(DISTINCT ri.material_id)   AS materials,
        COALESCE(SUM(ri.quantity_issued), 0)                                   AS total_qty,
        COALESCE(SUM(ri.quantity_issued
          * (CASE WHEN COALESCE(TRIM(ri.unit),'') <> '' AND ri.unit = rm.purchase_unit
                       AND ri.unit <> rm.unit AND COALESCE(rm.pack_size,1) > 1
                  THEN rm.pack_size ELSE 1 END)
          * rm.average_price), 0)                                              AS total_value
      FROM requisitions r
      JOIN requisition_items ri ON ri.req_id = r.id
      JOIN raw_materials rm    ON rm.id = ri.material_id
      WHERE ${WHERE}
    `).get(...params);

    const byDepartment = db.prepare(`
      SELECT d.id AS department_id, d.name AS department_name, d.code,
             COUNT(DISTINCT r.id)              AS requisition_count,
             COUNT(DISTINCT ri.material_id)    AS material_count,
             COUNT(*)                          AS line_count,
             COALESCE(SUM(ri.quantity_issued), 0)                              AS total_qty,
             COALESCE(SUM(ri.quantity_issued
               * (CASE WHEN COALESCE(TRIM(ri.unit),'') <> '' AND ri.unit = rm.purchase_unit
                            AND ri.unit <> rm.unit AND COALESCE(rm.pack_size,1) > 1
                       THEN rm.pack_size ELSE 1 END)
               * rm.average_price), 0)                                         AS total_value
      FROM requisitions r
      JOIN departments d ON d.id = r.department_id
      JOIN requisition_items ri ON ri.req_id = r.id
      JOIN raw_materials rm    ON rm.id = ri.material_id
      WHERE ${WHERE}
      GROUP BY d.id
      ORDER BY total_value DESC
    `).all(...params);

    const byDepartmentMaterial = db.prepare(`
      SELECT d.id AS department_id, d.name AS department_name,
             rm.id AS material_id, rm.name AS material_name, rm.sku AS material_sku, rm.unit AS material_unit, rm.category,
             SUM(ri.quantity_issued)                                  AS qty,
             SUM(ri.quantity_issued
               * (CASE WHEN COALESCE(TRIM(ri.unit),'') <> '' AND ri.unit = rm.purchase_unit
                            AND ri.unit <> rm.unit AND COALESCE(rm.pack_size,1) > 1
                       THEN rm.pack_size ELSE 1 END)
               * rm.average_price)                                    AS value,
             COUNT(*)                                                 AS line_count
      FROM requisitions r
      JOIN departments d ON d.id = r.department_id
      JOIN requisition_items ri ON ri.req_id = r.id
      JOIN raw_materials rm    ON rm.id = ri.material_id
      WHERE ${WHERE}
      GROUP BY d.id, rm.id
      ORDER BY value DESC
    `).all(...params);

    const topMaterials = db.prepare(`
      SELECT rm.id AS material_id, rm.name AS material_name, rm.sku AS material_sku,
             rm.unit AS material_unit, rm.category, rm.average_price,
             SUM(ri.quantity_issued)                            AS total_qty,
             SUM(ri.quantity_issued
               * (CASE WHEN COALESCE(TRIM(ri.unit),'') <> '' AND ri.unit = rm.purchase_unit
                            AND ri.unit <> rm.unit AND COALESCE(rm.pack_size,1) > 1
                       THEN rm.pack_size ELSE 1 END)
               * rm.average_price)                              AS total_value,
             COUNT(DISTINCT r.department_id)                    AS distinct_depts
      FROM requisitions r
      JOIN requisition_items ri ON ri.req_id = r.id
      JOIN raw_materials rm    ON rm.id = ri.material_id
      WHERE ${WHERE}
      GROUP BY rm.id
      ORDER BY total_value DESC
      LIMIT 30
    `).all(...params);

    const trendByDay = db.prepare(`
      SELECT r.date,
             SUM(ri.quantity_issued
               * (CASE WHEN COALESCE(TRIM(ri.unit),'') <> '' AND ri.unit = rm.purchase_unit
                            AND ri.unit <> rm.unit AND COALESCE(rm.pack_size,1) > 1
                       THEN rm.pack_size ELSE 1 END)
               * rm.average_price)                      AS total_value,
             COUNT(DISTINCT r.id)                       AS requisitions
      FROM requisitions r
      JOIN requisition_items ri ON ri.req_id = r.id
      JOIN raw_materials rm    ON rm.id = ri.material_id
      WHERE ${WHERE}
      GROUP BY r.date
      ORDER BY r.date ASC
    `).all(...params);

    return Response.json({
      range: { from, to },
      summary,
      by_department: byDepartment,
      by_department_material: byDepartmentMaterial,
      top_materials: topMaterials,
      trend_by_day: trendByDay,
    });
  } catch (e: any) {
    console.error('[department-consumption]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
