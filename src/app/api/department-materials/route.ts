import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Department-held materials — the on-hand balance each department is currently
 * holding after PARTY requisitions were fulfilled (store → dept transfer).
 *
 * department_materials.on_hand is the running balance; value is snapshotted
 * against the material's current average_price for a quick ₹ estimate.
 *
 * GET /api/department-materials            → all departments with on_hand > 0
 * GET /api/department-materials?department_id=<id> → single department
 *
 * Response:
 *   { by_department: [{ department_id, name, code,
 *                       items: [{ material_id, name, unit, on_hand, avg_price, value }] }],
 *     summary: { total_value } }
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const db = getDb();
    const url = new URL(request.url);
    const departmentId = url.searchParams.get('department_id');

    const params: any[] = [];
    let where = 'dm.on_hand > 0';
    if (departmentId) { where += ' AND dm.department_id = ?'; params.push(departmentId); }

    const rows = db.prepare(`
      SELECT dm.department_id,
             d.name  AS department_name,
             d.code  AS department_code,
             dm.material_id,
             rm.name AS material_name,
             rm.unit AS material_unit,
             dm.on_hand,
             rm.average_price AS avg_price
      FROM department_materials dm
      JOIN departments   d  ON d.id  = dm.department_id
      JOIN raw_materials rm ON rm.id = dm.material_id
      WHERE ${where}
      ORDER BY d.name ASC, rm.name ASC
    `).all(...params) as any[];

    const byDeptMap = new Map<string, any>();
    let totalValue = 0;

    for (const r of rows) {
      const onHand = Number(r.on_hand) || 0;
      const avg    = Number(r.avg_price) || 0;
      const value  = onHand * avg;
      totalValue += value;

      let dept = byDeptMap.get(r.department_id);
      if (!dept) {
        dept = {
          department_id: r.department_id,
          name: r.department_name,
          code: r.department_code || '',
          items: [] as any[],
        };
        byDeptMap.set(r.department_id, dept);
      }
      dept.items.push({
        material_id: r.material_id,
        name: r.material_name,
        unit: r.material_unit,
        on_hand: onHand,
        avg_price: avg,
        value,
      });
    }

    return Response.json({
      by_department: Array.from(byDeptMap.values()),
      summary: { total_value: totalValue },
    });
  } catch (e: any) {
    console.error('[department-materials GET]', e);
    return Response.json({ error: e?.message || 'Failed' }, { status: 500 });
  }
}
