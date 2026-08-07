import { getDb } from '@/lib/db';
import { getCurrentUser, canProcessAsStore } from '@/lib/auth';
import { packFactor } from '@/lib/pack-units';
import { rateMap, materialRate } from '@/lib/closing-valuation';

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
    //
    // The stored last-purchase-price column on raw_materials is DELIBERATELY NOT
    // SELECTED here, and must not be added back. It holds mixed bases on this
    // database: of the 190 packed materials carrying both that column and a
    // purchase history, 115 hold Rs per PURCHASE unit and 71 already hold Rs per
    // RECIPE unit. This route used to divide it by pack_size unconditionally,
    // which converted those 71 a second time — 100 PIPERS (750ML) stores 2.2112
    // (Rs/ml, matching its average_price 2.5404), divided again by 750 gives
    // Rs 0.00295/ml, 862x low, so a 2-BTL issue logged Rs 4.42 instead of ~Rs 3811.
    // Rates now come from src/lib/closing-valuation.ts, the sanctioned ladder:
    // latest purchases.unit_price (Rs per PURCHASE unit by canon), then
    // average_price x packFactor, then none.
    const rows = db.prepare(`
      SELECT ri.id AS item_id, ri.req_id, ri.material_id, ri.department_id AS line_dept_id,
             ri.quantity_requested, ri.chef_approved_qty, ri.quantity_issued, ri.is_rejected,
             ri.issue_history, ri.notes, ri.unit AS line_unit,
             rm.name AS material_name, rm.unit, rm.average_price,
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

    // ONE query for the whole log: the latest priced purchase per material. Passing
    // the hit (or an explicit null) into materialRate as `preloaded` keeps it from
    // running its own per-material SELECT inside the loop.
    const rates = rows.length ? rateMap(db) : new Map<string, { unit_price: number; date: string }>();

    for (const row of rows) {
      // PackMeta + average_price, the shape closing-valuation reads. `unit` is the
      // RECIPE unit, `purchase_unit` the PURCHASE unit; packFactor/toPurchaseQty
      // apply the both-halves guard (pack_size > 1 AND unit !== purchase_unit), so
      // a kg/kg pack_size-1.5 material like PICKLED GINGER is never converted.
      const mat = {
        id: row.material_id as string,
        unit: row.unit,
        purchase_unit: row.rm_purchase_unit,
        pack_size: row.rm_pack_size,
        average_price: row.average_price,
      };
      const preloaded = rates.get(row.material_id) ?? null;
      const matPackFactor = packFactor(mat);
      // Resolved ONCE per requisition line: the rate depends only on the material,
      // never on the individual issue event, so a split issue (30 kg now + 20 kg
      // later) is costed at one consistent rate. ratePerPurchaseUnit is Rs per
      // PURCHASE unit by construction on every rung of the ladder.
      const rate = materialRate(db, mat, preloaded);
      const ratePU = rate.ratePerPurchaseUnit;

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
        // ── MONEY: one basis on BOTH halves of the multiplication ───────────
        // Both halves are RECIPE basis here:
        //     value = recipeQty [ml] × unitCost [Rs/ml]
        // and unitCost is derived from the ladder's Rs-per-PURCHASE-unit rate by
        // dividing ONCE by the same packFactor that carries the both-halves guard,
        // so the pack cancels exactly instead of being applied twice.
        //
        // Deliberately NOT valueCount(): that helper multiplies toPurchaseQty(qty)
        // × ratePU, and toPurchaseQty ROUNDS TO 3 dp before the multiply — the very
        // thing pack-units.ts warns against ("Money never round-trips through the
        // purchase basis"). It is exact for a whole-bottle issue but collapses on
        // the small pours this log exists to record: 12 ml of KF PREMIUM DRAUGHT
        // 50 LTRS (pack 50,000) rounds to 0.000 kegs and values at Rs 0.00 instead
        // of Rs 1.90, and 30 ml values 66% HIGH at Rs 7.91 against Rs 4.75.
        // valueCount stays right for closing stock, where counts are whole packs.
        const unitCost = matPackFactor > 1 ? ratePU / matPackFactor : ratePU;
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
          // RECIPE basis (₹ per g / ml) — pairs with `qty` above. Unchanged field,
          // unchanged basis; consumers that multiply qty × unit_cost still balance.
          unit_cost: unitCost,
          // PURCHASE basis (₹ per kg / L / BTL) — pairs with `qty_purchase`, which
          // is what this log LEADS with. A reader multiplying the two visible
          // purchase-unit columns now lands on `value` instead of a pack_size-off
          // number. Equal to unit_cost when the material is not packed.
          unit_cost_purchase: ratePU,
          // Which rung of the closing-valuation ladder this rate came from
          // ('last_purchase' | 'average_cost' | 'none') and the purchase date behind
          // it. A valuation nobody can trace is a valuation nobody trusts.
          rate_source: rate.source,
          rate_as_of: rate.asOf || null,
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
