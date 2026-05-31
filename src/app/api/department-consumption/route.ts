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

    const summary = db.prepare(`
      SELECT
        COUNT(DISTINCT r.id)             AS requisition_count,
        COUNT(DISTINCT r.department_id)  AS departments,
        COUNT(DISTINCT ri.material_id)   AS materials,
        COALESCE(SUM(ri.quantity_issued), 0)                                   AS total_qty,
        COALESCE(SUM(ri.quantity_issued * rm.average_price), 0)                AS total_value
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
             COALESCE(SUM(ri.quantity_issued * rm.average_price), 0)           AS total_value
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
             SUM(ri.quantity_issued * rm.average_price)               AS value,
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
             SUM(ri.quantity_issued * rm.average_price)         AS total_value,
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
             SUM(ri.quantity_issued * rm.average_price) AS total_value,
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
