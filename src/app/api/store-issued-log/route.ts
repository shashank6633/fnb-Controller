import { getDb } from '@/lib/db';
import { getCurrentUser, canProcessAsStore } from '@/lib/auth';

/**
 * Cross-requisition issued-items log.
 *
 * One row per *issue event* (a single hand-over from store to a department).
 * Built by unrolling the `issue_history` JSON on every requisition_item, so
 * split-issues (e.g. 30 kg now + 20 kg later) appear as two distinct rows.
 *
 * Query params:
 *   from           ISO date (inclusive). Defaults to today.
 *   to             ISO date (inclusive). Defaults to today.
 *   department_id  optional filter
 *   material_id    optional filter
 *   issuer         optional substring match on issuer email
 *
 * Response: {
 *   events:  [{ at, qty, unit, material_name, department_name, issuer,
 *               req_number, req_id, item_id, note }, ...],
 *   totals:  { events, total_qty_value, distinct_materials, distinct_departments }
 * }
 *
 * Access: store-managers (canProcessAsStore) + admins.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canProcessAsStore(me)) {
      return Response.json({ error: 'Store permission required' }, { status: 403 });
    }

    const db = getDb();
    const url = new URL(request.url);
    const today = new Date().toISOString().slice(0, 10);
    const from = url.searchParams.get('from') || today;
    const to   = url.searchParams.get('to')   || today;
    const departmentId = url.searchParams.get('department_id') || '';
    const materialId   = url.searchParams.get('material_id') || '';
    const issuer       = (url.searchParams.get('issuer') || '').toLowerCase();

    const where: string[] = ['ri.issue_history IS NOT NULL', 'ri.issue_history != \'\'', 'ri.issue_history != \'[]\''];
    const params: any[] = [];
    if (departmentId) {
      where.push('(ri.department_id = ? OR r.department_id = ?)');
      params.push(departmentId, departmentId);
    }
    if (materialId) { where.push('ri.material_id = ?'); params.push(materialId); }

    // Pull every line that has at least one issue event, then expand in JS.
    // SQLite's JSON1 could do this server-side, but keeping it in JS makes the
    // shape much easier to evolve.
    const rows = db.prepare(`
      SELECT ri.id AS item_id, ri.req_id, ri.material_id, ri.department_id AS line_dept_id,
             ri.quantity_requested, ri.chef_approved_qty, ri.quantity_issued, ri.is_rejected,
             ri.issue_history, ri.notes, ri.unit AS line_unit,
             rm.name AS material_name, rm.unit, rm.average_price, rm.last_purchase_price,
             rm.purchase_unit AS rm_purchase_unit, COALESCE(rm.pack_size, 1) AS rm_pack_size,
             r.req_number, r.department_id AS req_dept_id, r.purpose, r.event_name,
             COALESCE(d_line.name, d_req.name) AS department_name
      FROM requisition_items ri
      JOIN raw_materials rm ON rm.id = ri.material_id
      JOIN requisitions r   ON r.id   = ri.req_id
      LEFT JOIN departments d_req  ON d_req.id  = r.department_id
      LEFT JOIN departments d_line ON d_line.id = ri.department_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.req_number DESC
    `).all(...params) as any[];

    const events: any[] = [];
    let totalValue = 0;
    const dists = { materials: new Set<string>(), departments: new Set<string>() };

    for (const row of rows) {
      let history: Array<{ qty: number; at: string; by: string; note?: string }> = [];
      try { history = JSON.parse(row.issue_history || '[]'); } catch { continue; }
      if (!Array.isArray(history) || history.length === 0) continue;

      for (const h of history) {
        const at = String(h.at || '');
        // Date filter on the issue timestamp itself (not on req.date).
        const isoDay = at.slice(0, 10);
        if (isoDay < from || isoDay > to) continue;
        if (issuer && !String(h.by || '').toLowerCase().includes(issuer)) continue;
        // h.qty is stored IN THE LINE'S OWN UNIT (requisition_items.unit) — the
        // reqPackFactor convention. The earlier comment here claimed "h.qty is
        // RECIPE units"; that was only true of blank-unit lines. The composer
        // stamps the PURCHASE unit on every line (and a 2026-07-27 backfill
        // stamped the 16k Recaho-imported ones), so a "5" against unit 'kg' is
        // FIVE KILOS — reading it as grams understated qty and value pack_size×.
        const vPack = Number(row.rm_pack_size) || 1;
        const puNorm = String(row.rm_purchase_unit || row.unit || '').toLowerCase().trim();
        const ruNorm = String(row.unit || '').toLowerCase().trim();
        const luNorm = String(row.line_unit || '').toLowerCase().trim();
        const vDiffer = ruNorm !== puNorm;
        // Both-halves guard, applied to the LINE unit: the qty is purchase-basis
        // only when the line was requested in the purchase unit of a real pack.
        const lineIsPU = vPack > 1 && vDiffer && luNorm !== '' && luNorm === puNorm;
        const rawQty = Number(h.qty) || 0;
        const recipeQty   = lineIsPU ? rawQty * vPack : rawQty;
        const qtyPurchase = Math.round((lineIsPU ? rawQty : rawQty / ((vPack > 1 && vDiffer) ? vPack : 1)) * 1000) / 1000;
        // unitCost is ₹/RECIPE-unit (lpp is ₹/purchase-unit → ÷pack; average_price
        // already is). Value = recipeQty × ₹/recipe — ONE basis, never mixed.
        const vLpp = (vPack > 1 && vDiffer)
          ? (Number(row.last_purchase_price) || 0) / vPack
          : Number(row.last_purchase_price) || 0;
        const unitCost = vLpp || Number(row.average_price) || 0;
        const lineValue = Math.round(recipeQty * unitCost * 100) / 100;
        totalValue += lineValue;
        dists.materials.add(row.material_id);
        if (row.department_name) dists.departments.add(row.department_name);
        events.push({
          at,
          // RECIPE basis — what the value is computed from (resolved through the
          // line's unit above). Kept so the costing trail stays checkable.
          qty: recipeQty,
          unit: row.unit,
          // PURCHASE basis — what the store actually handed over, and what the log
          // leads with. Equal to qty when the material is not packed.
          qty_purchase: qtyPurchase,
          purchase_unit: row.rm_purchase_unit || row.unit,
          pack_factor: (vPack > 1 && vDiffer) ? vPack : 1,
          material_id: row.material_id,
          material_name: row.material_name,
          department_id: row.line_dept_id || row.req_dept_id,
          department_name: row.department_name || '',
          issuer: h.by || '',
          note: h.note || '',
          req_id: row.req_id,
          req_number: row.req_number,
          purpose: row.purpose,
          event_name: row.event_name || '',
          item_id: row.item_id,
          unit_cost: unitCost,
          value: lineValue,
        });
      }
    }

    // Newest first
    events.sort((a, b) => (b.at || '').localeCompare(a.at || ''));

    return Response.json({
      events,
      totals: {
        events: events.length,
        total_value: Math.round(totalValue * 100) / 100,
        distinct_materials: dists.materials.size,
        distinct_departments: dists.departments.size,
      },
      filters: { from, to, department_id: departmentId, material_id: materialId, issuer },
    });
  } catch (e: any) {
    console.error('[store-issued-log]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
