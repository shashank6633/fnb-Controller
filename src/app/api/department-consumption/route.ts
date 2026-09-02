import { getDb } from '@/lib/db';
import { getCurrentOutletId } from '@/lib/auth';

/**
 * Department-wise material consumption analytics.
 *
 * TWO SOURCES OF TRUTH, because departments take goods in on two rails:
 *   1. `requisition_items.quantity_issued` — what each kitchen drew from the
 *      main store, aggregated by department & material over a date window and
 *      valued at the material's average_price (rupee context).
 *   2. DIRECT-ISSUE VENDOR RECEIPTS — `department_material_transactions` rows
 *      of type 'direct_receipt' (net of 'direct_receipt_reversal': voids,
 *      downward bill amendments and vendor returns of those goods). Under
 *      Settings → Direct Issue, whole categories are delivered by the vendor
 *      STRAIGHT to a kitchen and never cross the main store, so a register
 *      built from requisitions alone systematically understates what a
 *      department took in — a vendor lorry-load to the Main Kitchen would be
 *      invisible here. Ledger quantities are RECIPE units and average_price is
 *      ₹/recipe-unit, so qty × average_price is the same basis as rail 1.
 *      Dated by the stamped cost row's bill date (purchases.date via
 *      reference_id — honours backdating), falling back to the ledger row's
 *      own UTC date. Direct amounts also ride in a `direct_qty`/`direct_value`
 *      breakdown so a reader can still separate the two rails.
 *
 * Reminder: this is inflow *from the department's perspective* (what each
 * kitchen received — from the main store or vendor-direct). It's
 * analytics-only — does NOT relate to recipe-driven inventory deductions,
 * which run on a separate rail.
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

/** Per (day, department, material) NET direct-issue receipt rows inside the
 *  window — 'direct_receipt' minus 'direct_receipt_reversal', RECIPE units.
 *  Day = the stamped cost row's bill date (purchases.date, via the ledger
 *  row's reference_id) when it resolves, else the ledger row's own UTC date —
 *  a vendor-return reversal references its return ticket, so it falls back.
 *  try/catch to [] so a database from before the department ledger existed
 *  still answers with the requisition rail alone. */
function directInflowRows(
  db: any,
  f: { from: string; to: string; outletId: string | null; departmentId: string; categoryF: string; materialId: string },
): any[] {
  const DAY = `COALESCE(SUBSTR(p.date, 1, 10), SUBSTR(REPLACE(dmt.created_at, 'T', ' '), 1, 10))`;
  const where: string[] = [
    `dmt.type IN ('direct_receipt', 'direct_receipt_reversal')`,
    `${DAY} BETWEEN ? AND ?`,
  ];
  const params: any[] = [f.from, f.to];
  if (f.outletId)     { where.push('(dmt.outlet_id = ? OR dmt.outlet_id IS NULL)'); params.push(f.outletId); }
  if (f.departmentId) { where.push('dmt.department_id = ?'); params.push(f.departmentId); }
  if (f.categoryF)    { where.push('rm.category = ?');       params.push(f.categoryF); }
  if (f.materialId)   { where.push('dmt.material_id = ?');   params.push(f.materialId); }
  try {
    return db.prepare(`
      SELECT ${DAY}                                        AS day,
             dmt.department_id                             AS department_id,
             COALESCE(d.name, '—')                         AS department_name,
             COALESCE(d.code, '')                          AS department_code,
             dmt.material_id                               AS material_id,
             rm.name                                       AS material_name,
             rm.sku                                        AS material_sku,
             rm.unit                                       AS unit,
             COALESCE(rm.category, '')                     AS category,
             COALESCE(rm.average_price, 0)                 AS average_price,
             COALESCE(NULLIF(TRIM(rm.purchase_unit), ''), rm.unit) AS purchase_unit,
             COALESCE(rm.pack_size, 1)                     AS pack_size,
             SUM(dmt.quantity)                             AS qty,
             COUNT(*)                                      AS line_count
      FROM department_material_transactions dmt
      JOIN raw_materials rm ON rm.id = dmt.material_id
      LEFT JOIN departments d ON d.id = dmt.department_id
      LEFT JOIN purchases  p ON p.id = dmt.reference_id
      WHERE ${where.join(' AND ')}
      GROUP BY day, dmt.department_id, dmt.material_id
    `).all(...params) as any[];
  } catch {
    return [];
  }
}

/** Display divisor to the purchase basis — the BOTH-HALVES pack guard
 *  (pack_size > 1 AND unit <> purchase_unit), same rule as the register's
 *  packDiv for requisition rows. */
function packDivOf(row: { unit?: string; purchase_unit?: string; pack_size?: number }): number {
  return ((Number(row.pack_size) || 1) > 1
    && String(row.unit || '').toLowerCase().trim()
       !== String(row.purchase_unit || row.unit || '').toLowerCase().trim())
    ? Number(row.pack_size) : 1;
}

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
        // Blank ri.unit = legacy purchase-unit entry (× pack, same as dept-stock).
        // NEVER use last_purchase_price here: it is ₹/PURCHASE-unit, so
        // qty-in-requested/recipe-units × last_purchase_price mixes bases
        // (the old `last_purchase_price || average_price` fallback overvalued
        // e.g. 5 g of a material bought in 1 kg bags by ×1000).
        // Blank ri.unit = legacy pre-unit-column entry in PURCHASE units — same
        // deliberate rule as dept-stock.ts reqPackFactor (DB-verified 2026-07-22),
        // so /department-consumption and /inventory/department-stock agree.
        const asPurchase = String(row.req_unit || '').trim() === ''
          ? true : row.req_unit === row.purchase_unit;
        const packFactor =
          (asPurchase &&
           String(row.purchase_unit || '').trim() !== '' &&
           row.unit !== row.purchase_unit &&
           (Number(row.pack_size) || 1) > 1)
            ? Number(row.pack_size) : 1;
        const unitCost = (Number(row.average_price) || 0) * packFactor;
        // Display divisor to the purchase basis — INDEPENDENT of the line's own
        // basis (both-halves guard). qty is normalised to recipe first, so a
        // group mixing a legacy recipe-unit line with a purchase-unit line
        // still sums one basis.
        const packDiv = ((Number(row.pack_size) || 1) > 1
          && String(row.unit || '').toLowerCase().trim()
             !== String(row.purchase_unit || row.unit || '').toLowerCase().trim())
          ? Number(row.pack_size) : 1;
        for (const h of hist) {
          const day = String(h && h.at || '').slice(0, 10);
          if (!day || day < from || day > to) continue;
          const qty = Number(h.qty) || 0; if (qty <= 0) continue;
          const key = day + '|' + (row.department_id || '') + '|' + row.material_id;
          let g = map.get(key);
          if (!g) {
            g = { date: day, department_id: row.department_id || '', department_name: row.department_name || '—',
                  material_id: row.material_id, material_name: row.material_name, unit: row.unit, category: row.category || '',
                  purchase_unit: row.purchase_unit || row.unit, pack_div: packDiv,
                  qty: 0, value: 0, reqs: new Set<string>() };
            map.set(key, g);
          }
          // g.qty is RECIPE units (qty × packFactor) — before this fix it summed
          // the raw line-unit numbers, so "5 BTL" landed in a column labelled ml.
          const recipeQty = qty * packFactor;
          g.qty += recipeQty; g.value += qty * unitCost; g.reqs.add(row.req_number);
          days.add(day); depts.add(row.department_id || ''); mats.add(row.material_id);
          totQty += recipeQty; totVal += qty * unitCost;
        }
      }

      // ── RAIL 2: direct-issue vendor receipts (see the file header). Same
      // (date × department × material) grouping, RECIPE units, valued at
      // average_price (₹/recipe-unit — same basis, no conversion). NET of
      // reversals, so a voided or vendor-returned delivery does not inflate
      // the register; a reversal dated after its receipt shows as a negative
      // entry on its own day, which is the honest movement log. Each group
      // also carries the amount in `direct_qty` so the two rails stay
      // separable on the same row.
      for (const row of directInflowRows(db, { from, to, outletId, departmentId, categoryF, materialId })) {
        const dQty = Number(row.qty) || 0;
        if (Math.abs(dQty) < 1e-9) continue;   // fully netted out inside the window
        const day = String(row.day || '').slice(0, 10);
        const key = day + '|' + (row.department_id || '') + '|' + row.material_id;
        let g = map.get(key);
        if (!g) {
          g = { date: day, department_id: row.department_id || '', department_name: row.department_name || '—',
                material_id: row.material_id, material_name: row.material_name, unit: row.unit, category: row.category || '',
                purchase_unit: row.purchase_unit || row.unit, pack_div: packDivOf(row),
                qty: 0, value: 0, reqs: new Set<string>() };
          map.set(key, g);
        }
        const dVal = dQty * (Number(row.average_price) || 0); // rate-basis: recipe (ledger qty is RECIPE units; average_price is ₹/recipe-unit)
        g.qty += dQty; g.value += dVal; g.direct_qty = (g.direct_qty || 0) + dQty;
        days.add(day); depts.add(row.department_id || ''); mats.add(row.material_id);
        totQty += dQty; totVal += dVal;
      }

      const regRows = [...map.values()]
        .map(g => ({ date: g.date, department_id: g.department_id, department_name: g.department_name,
          material_id: g.material_id, material_name: g.material_name, unit: g.unit, category: g.category,
          qty: Math.round(g.qty * 1000) / 1000, value: Math.round(g.value * 100) / 100, req_count: g.reqs.size,
          // How much of this group's qty came vendor-direct (net, recipe units).
          direct_qty: Math.round((g.direct_qty || 0) * 1000) / 1000,
          // PURCHASE basis for display (rounded derivative — never summed)
          qty_purchase: Math.round((g.qty / g.pack_div) * 1000) / 1000,
          purchase_unit: g.purchase_unit, pack_factor: g.pack_div }))
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
    // purchase unit OR is blank (legacy purchase-unit era — matches dept-stock).
    const summary = db.prepare(`
      SELECT
        COUNT(DISTINCT r.id)             AS requisition_count,
        COUNT(DISTINCT r.department_id)  AS departments,
        COUNT(DISTINCT ri.material_id)   AS materials,
        COALESCE(SUM(ri.quantity_issued * (CASE WHEN (COALESCE(TRIM(ri.unit),'') = '' OR ri.unit = rm.purchase_unit)
                       AND COALESCE(TRIM(rm.purchase_unit),'') <> '' AND rm.unit <> rm.purchase_unit
                       AND COALESCE(rm.pack_size,1) > 1
                  THEN rm.pack_size ELSE 1 END)), 0)                          AS total_qty,
        COALESCE(SUM(ri.quantity_issued
          * (CASE WHEN (COALESCE(TRIM(ri.unit),'') = '' OR ri.unit = rm.purchase_unit)
                       AND COALESCE(TRIM(rm.purchase_unit),'') <> '' AND rm.unit <> rm.purchase_unit
                       AND COALESCE(rm.pack_size,1) > 1
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
             COALESCE(SUM(ri.quantity_issued * (CASE WHEN (COALESCE(TRIM(ri.unit),'') = '' OR ri.unit = rm.purchase_unit)
                       AND COALESCE(TRIM(rm.purchase_unit),'') <> '' AND rm.unit <> rm.purchase_unit
                       AND COALESCE(rm.pack_size,1) > 1
                  THEN rm.pack_size ELSE 1 END)), 0)                     AS total_qty,
             COALESCE(SUM(ri.quantity_issued
               * (CASE WHEN (COALESCE(TRIM(ri.unit),'') = '' OR ri.unit = rm.purchase_unit)
                            AND COALESCE(TRIM(rm.purchase_unit),'') <> '' AND rm.unit <> rm.purchase_unit
                            AND COALESCE(rm.pack_size,1) > 1
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
             COALESCE(NULLIF(TRIM(rm.purchase_unit),''), rm.unit) AS material_purchase_unit, COALESCE(rm.pack_size, 1) AS material_pack_size,
             SUM(ri.quantity_issued * (CASE WHEN (COALESCE(TRIM(ri.unit),'') = '' OR ri.unit = rm.purchase_unit)
                       AND COALESCE(TRIM(rm.purchase_unit),'') <> '' AND rm.unit <> rm.purchase_unit
                       AND COALESCE(rm.pack_size,1) > 1
                  THEN rm.pack_size ELSE 1 END))                         AS qty,
             SUM(ri.quantity_issued
               * (CASE WHEN (COALESCE(TRIM(ri.unit),'') = '' OR ri.unit = rm.purchase_unit)
                            AND COALESCE(TRIM(rm.purchase_unit),'') <> '' AND rm.unit <> rm.purchase_unit
                            AND COALESCE(rm.pack_size,1) > 1
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
             COALESCE(NULLIF(TRIM(rm.purchase_unit),''), rm.unit) AS material_purchase_unit, COALESCE(rm.pack_size, 1) AS material_pack_size,
             SUM(ri.quantity_issued * (CASE WHEN (COALESCE(TRIM(ri.unit),'') = '' OR ri.unit = rm.purchase_unit)
                       AND COALESCE(TRIM(rm.purchase_unit),'') <> '' AND rm.unit <> rm.purchase_unit
                       AND COALESCE(rm.pack_size,1) > 1
                  THEN rm.pack_size ELSE 1 END))                   AS total_qty,
             SUM(ri.quantity_issued
               * (CASE WHEN (COALESCE(TRIM(ri.unit),'') = '' OR ri.unit = rm.purchase_unit)
                            AND COALESCE(TRIM(rm.purchase_unit),'') <> '' AND rm.unit <> rm.purchase_unit
                            AND COALESCE(rm.pack_size,1) > 1
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
               * (CASE WHEN (COALESCE(TRIM(ri.unit),'') = '' OR ri.unit = rm.purchase_unit)
                            AND COALESCE(TRIM(rm.purchase_unit),'') <> '' AND rm.unit <> rm.purchase_unit
                            AND COALESCE(rm.pack_size,1) > 1
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

    // ── RAIL 2: merge direct-issue vendor receipts into all five aggregates
    // (see the file header). Everything below is ADDITIVE JS on top of the
    // untouched requisition SQL: each aggregate keeps its shape, its qty/value
    // now mean TOTAL department inflow, and the direct share rides beside them
    // in direct_qty / direct_value so the rails stay separable. A department
    // or material whose only inflow was vendor-direct appears with
    // requisition_count / line_count 0, which is the honest reading.
    const directRows = directInflowRows(db, { from, to, outletId, departmentId, categoryF, materialId });
    const summaryAny = summary as any;
    const byDeptAny = byDepartment as any[];
    const byDeptMatAny = byDepartmentMaterial as any[];
    const topMatAny = topMaterials as any[];
    const trendAny = trendByDay as any[];

    if (directRows.length > 0) {
      const r3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;

      // Requisition-side identity sets, read off the aggregates that already
      // carry them, so the union counts below are exact rather than guessed.
      const reqMatsByDept = new Map<string, Set<string>>();
      for (const r of byDeptMatAny) {
        const s = reqMatsByDept.get(String(r.department_id)) || new Set<string>();
        s.add(String(r.material_id));
        reqMatsByDept.set(String(r.department_id), s);
      }
      const deptRow = new Map<string, any>(byDeptAny.map((r) => [String(r.department_id), r]));
      const deptMatRow = new Map<string, any>(byDeptMatAny.map((r) => [`${r.department_id}|${r.material_id}`, r]));
      const matRow = new Map<string, any>(topMatAny.map((r) => [String(r.material_id), r]));
      const depsByMat = new Map<string, Set<string>>();
      for (const r of byDeptMatAny) {
        const s = depsByMat.get(String(r.material_id)) || new Set<string>();
        s.add(String(r.department_id));
        depsByMat.set(String(r.material_id), s);
      }
      const dayRow = new Map<string, any>(trendAny.map((r) => [String(r.date), r]));

      let dQtyTotal = 0, dValTotal = 0;
      const dDepts = new Set<string>(), dMats = new Set<string>();

      for (const row of directRows) {
        const qty = Number(row.qty) || 0;
        if (Math.abs(qty) < 1e-9) continue;
        const value = qty * (Number(row.average_price) || 0); // rate-basis: recipe (ledger qty is RECIPE units; average_price is ₹/recipe-unit)
        const deptId = String(row.department_id || '');
        const matId = String(row.material_id);
        dQtyTotal += qty; dValTotal += value;
        dDepts.add(deptId); dMats.add(matId);

        // by_department
        let dr = deptRow.get(deptId);
        if (!dr) {
          dr = { department_id: deptId, department_name: row.department_name, code: row.department_code,
                 requisition_count: 0, material_count: 0, line_count: 0,
                 total_qty: 0, total_value: 0, direct_qty: 0, direct_value: 0 };
          deptRow.set(deptId, dr); byDeptAny.push(dr);
        }
        dr.total_qty += qty; dr.total_value += value;
        dr.direct_qty = (dr.direct_qty || 0) + qty;
        dr.direct_value = (dr.direct_value || 0) + value;

        // by_department_material
        const dmKey = `${deptId}|${matId}`;
        let dm = deptMatRow.get(dmKey);
        if (!dm) {
          dm = { department_id: deptId, department_name: row.department_name,
                 material_id: matId, material_name: row.material_name, material_sku: row.material_sku,
                 material_unit: row.unit, category: row.category,
                 material_purchase_unit: row.purchase_unit, material_pack_size: row.pack_size,
                 qty: 0, value: 0, line_count: 0, direct_qty: 0, direct_value: 0 };
          deptMatRow.set(dmKey, dm); byDeptMatAny.push(dm);
        }
        dm.qty += qty; dm.value += value;
        dm.direct_qty = (dm.direct_qty || 0) + qty;
        dm.direct_value = (dm.direct_value || 0) + value;

        // top_materials (merged into the SQL top list; a direct-only material
        // gets its own row — the one rail it moved on is the whole story)
        let tm = matRow.get(matId);
        if (!tm) {
          tm = { material_id: matId, material_name: row.material_name, material_sku: row.material_sku,
                 material_unit: row.unit, category: row.category, average_price: row.average_price,
                 material_purchase_unit: row.purchase_unit, material_pack_size: row.pack_size,
                 total_qty: 0, total_value: 0, distinct_depts: 0, direct_qty: 0, direct_value: 0 };
          matRow.set(matId, tm); topMatAny.push(tm);
        }
        tm.total_qty += qty; tm.total_value += value;
        tm.direct_qty = (tm.direct_qty || 0) + qty;
        tm.direct_value = (tm.direct_value || 0) + value;
        const md = depsByMat.get(matId) || new Set<string>();
        md.add(deptId); depsByMat.set(matId, md);

        // trend_by_day
        const day = String(row.day || '').slice(0, 10);
        let td = dayRow.get(day);
        if (!td) {
          td = { date: day, total_value: 0, requisitions: 0, direct_value: 0 };
          dayRow.set(day, td); trendAny.push(td);
        }
        td.total_value += value;
        td.direct_value = (td.direct_value || 0) + value;
      }

      // Exact union material_count per department (requisition ∪ direct).
      for (const [deptId, dr] of deptRow) {
        const set = new Set(reqMatsByDept.get(deptId) || []);
        for (const row of directRows) {
          if (String(row.department_id || '') === deptId && Math.abs(Number(row.qty) || 0) >= 1e-9) set.add(String(row.material_id));
        }
        if (set.size > 0) dr.material_count = set.size;
      }
      // distinct_depts on the merged materials, off the exact union pairs.
      for (const [matId, tm] of matRow) {
        const s = depsByMat.get(matId);
        if (s && s.size > 0) tm.distinct_depts = s.size;
      }

      // summary: totals now mean TOTAL inflow; the direct share is broken out.
      summaryAny.total_qty = r3((Number(summaryAny.total_qty) || 0) + dQtyTotal);
      summaryAny.total_value = r3((Number(summaryAny.total_value) || 0) + dValTotal);
      summaryAny.direct_receipt_qty = r3(dQtyTotal);
      summaryAny.direct_receipt_value = r3(dValTotal);
      // departments/materials become exact unions across both rails.
      const allDepts = new Set<string>(byDeptAny.map((r) => String(r.department_id)));
      const allMats = new Set<string>(byDeptMatAny.map((r) => String(r.material_id)));
      summaryAny.departments = allDepts.size;
      summaryAny.materials = allMats.size;

      byDeptAny.sort((a, b) => (Number(b.total_value) || 0) - (Number(a.total_value) || 0));
      byDeptMatAny.sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0));
      topMatAny.sort((a, b) => (Number(b.total_value) || 0) - (Number(a.total_value) || 0));
      trendAny.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    }

    return Response.json({
      range: { from, to },
      summary: summaryAny,
      by_department: byDeptAny,
      by_department_material: byDeptMatAny,
      top_materials: topMatAny.slice(0, 30),
      trend_by_day: trendAny,
    });
  } catch (e: any) {
    console.error('[department-consumption]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
