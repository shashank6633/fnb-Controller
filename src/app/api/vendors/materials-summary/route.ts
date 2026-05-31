import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Per-vendor → list of materials they've supplied, with stats.
 *
 *   For each active vendor:
 *     - Materials they've purchased (from `purchases` matched by vendor name)
 *     - Per material: total qty, total spend, last purchase date, last unit price,
 *       avg unit price (rolling 90d), whether a vendor_contracts row exists
 *
 * GET /api/vendors/materials-summary
 *
 * Returns: [{ vendor_id, vendor_name, materials: [...], total_spend }]
 *
 * Any signed-in user (read-only).
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();

    const vendors = db.prepare(`SELECT id, name FROM vendors WHERE is_active = 1 ORDER BY name`).all() as any[];

    // For each vendor, pull every material that is EITHER mapped to them
    // (vendor_materials) OR has at least one purchase from them. UNION so
    // newly-added mappings show up even when there's no purchase yet.
    const matStatsStmt = db.prepare(`
      WITH vendor_mat_ids AS (
        SELECT material_id FROM vendor_materials WHERE vendor_id = ?
        UNION
        SELECT DISTINCT material_id FROM purchases
        WHERE LOWER(TRIM(vendor)) = LOWER(TRIM(?))
      )
      SELECT rm.id   AS material_id,
             rm.name AS material_name,
             rm.sku  AS material_sku,
             rm.unit AS recipe_unit,
             rm.purchase_unit,
             rm.pack_size,
             COALESCE((SELECT SUM(quantity) FROM purchases pp
                       WHERE pp.material_id = rm.id AND LOWER(TRIM(pp.vendor)) = LOWER(TRIM(?))), 0) AS total_qty,
             COALESCE((SELECT SUM(total_price) FROM purchases pp
                       WHERE pp.material_id = rm.id AND LOWER(TRIM(pp.vendor)) = LOWER(TRIM(?))), 0) AS total_spend,
             (SELECT MAX(date) FROM purchases pp
              WHERE pp.material_id = rm.id AND LOWER(TRIM(pp.vendor)) = LOWER(TRIM(?))) AS last_purchase_date,
             COALESCE((SELECT COUNT(*) FROM purchases pp
                       WHERE pp.material_id = rm.id AND LOWER(TRIM(pp.vendor)) = LOWER(TRIM(?))), 0) AS purchase_count,
             (SELECT unit_price FROM purchases pp
              WHERE pp.material_id = rm.id AND LOWER(TRIM(pp.vendor)) = LOWER(TRIM(?))
              ORDER BY pp.date DESC, pp.created_at DESC LIMIT 1) AS last_unit_price,
             (SELECT ROUND(SUM(quantity * unit_price) / NULLIF(SUM(quantity), 0), 2)
              FROM purchases pp
              WHERE pp.material_id = rm.id AND LOWER(TRIM(pp.vendor)) = LOWER(TRIM(?))
                AND pp.date >= date('now','-90 day')) AS avg_unit_price_90d,
             EXISTS(SELECT 1 FROM vendor_materials vm
                    WHERE vm.vendor_id = ? AND vm.material_id = rm.id) AS is_mapped,
             EXISTS(SELECT 1 FROM vendor_contracts vc
                    WHERE vc.vendor_id = ? AND vc.material_id = rm.id AND vc.is_active = 1) AS has_contract,
             (SELECT unit_price FROM vendor_contracts vc
              WHERE vc.vendor_id = ? AND vc.material_id = rm.id AND vc.is_active = 1
              LIMIT 1) AS contract_price
      FROM raw_materials rm
      WHERE rm.id IN (SELECT material_id FROM vendor_mat_ids)
      ORDER BY (last_purchase_date IS NULL) ASC, last_purchase_date DESC, rm.name
    `);

    const out: any[] = [];
    for (const v of vendors) {
      // Parameter order: vendor_id, vendor_name (CTE), then 6× vendor_name for the
      // per-row sub-SELECTs, then 3× vendor_id for the EXISTS/contract lookups.
      const mats = matStatsStmt.all(
        v.id, v.name,                                  // CTE
        v.name, v.name, v.name, v.name, v.name, v.name, // 6× purchases lookups
        v.id, v.id, v.id,                              // 3× vendor_id for EXISTS/contract
      ) as any[];
      const totalSpend = mats.reduce((s, m) => s + (m.total_spend || 0), 0);
      out.push({
        vendor_id: v.id,
        vendor_name: v.name,
        materials: mats,
        total_spend: totalSpend,
        material_count: mats.length,
        with_mapping: mats.filter(m => m.is_mapped).length,
        with_contract: mats.filter(m => m.has_contract).length,
      });
    }

    // Also surface purchases that reference a vendor name not in the master
    const orphanRows = db.prepare(`
      SELECT p.vendor AS vendor_name,
             COUNT(DISTINCT p.material_id) AS material_count,
             SUM(p.total_price)            AS total_spend
      FROM purchases p
      WHERE TRIM(COALESCE(p.vendor, '')) != ''
        AND LOWER(TRIM(p.vendor)) NOT IN (SELECT LOWER(TRIM(name)) FROM vendors WHERE is_active = 1)
      GROUP BY LOWER(TRIM(p.vendor))
      ORDER BY SUM(p.total_price) DESC
    `).all();

    return Response.json({ vendors: out, orphan_vendors: orphanRows });
  } catch (e: any) {
    console.error('[/api/vendors/materials-summary]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
