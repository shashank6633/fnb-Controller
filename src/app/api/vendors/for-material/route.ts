import { getDb } from '@/lib/db';

/**
 * Eligible vendors for a given raw material — vendors we've actually purchased
 * this material from. Used by the PO line vendor picker so the user picks from
 * their proven supply history first, then falls back to the full vendor master.
 *
 * GET /api/vendors/for-material?material_id=<uuid>
 *   → { vendors: [{ name, vendor_id?, purchase_count, last_date, last_price, avg_price, total_qty }, ...] }
 *
 * Source of truth: the `purchases` table (committed receipts). We dedupe by
 * normalised lowercase vendor name and try to resolve to a vendors-master row
 * for richer display (payment_terms, lead time).
 */
export async function GET(request: Request) {
  try {
    const db = getDb();
    const materialId = new URL(request.url).searchParams.get('material_id');
    if (!materialId) return Response.json({ error: 'material_id required' }, { status: 400 });

    const rows = db.prepare(`
      SELECT
        TRIM(p.vendor) AS vendor,
        COUNT(*) AS purchase_count,
        MAX(p.date) AS last_date,
        SUM(p.quantity) AS total_qty,
        ROUND(AVG(p.unit_price), 2) AS avg_price,
        (SELECT p2.unit_price
           FROM purchases p2
          WHERE p2.material_id = p.material_id
            AND LOWER(TRIM(p2.vendor)) = LOWER(TRIM(p.vendor))
          ORDER BY p2.date DESC, p2.created_at DESC
          LIMIT 1) AS last_price
      FROM purchases p
      WHERE p.material_id = ?
        AND p.vendor IS NOT NULL
        AND TRIM(p.vendor) != ''
      GROUP BY LOWER(TRIM(p.vendor))
      ORDER BY purchase_count DESC, last_date DESC
    `).all(materialId) as any[];

    // Resolve each vendor name to a vendors-master row when possible.
    // Also attach the currently-active contract price for this (vendor, material), if any.
    const lookup = db.prepare('SELECT id, name, payment_terms, lead_time_days FROM vendors WHERE LOWER(name) = LOWER(?) LIMIT 1');
    const contractLookup = db.prepare(`
      SELECT id, unit_price, valid_from, valid_to
      FROM vendor_contracts
      WHERE vendor_id = ? AND material_id = ?
        AND is_active = 1
        AND valid_from <= date('now')
        AND (valid_to IS NULL OR valid_to >= date('now'))
      ORDER BY valid_from DESC LIMIT 1
    `);
    const enriched = rows.map(r => {
      const v = lookup.get(r.vendor) as any;
      const contract = v?.id ? contractLookup.get(v.id, materialId) as any : null;
      return {
        vendor: r.vendor,
        vendor_id: v?.id || null,
        payment_terms: v?.payment_terms || null,
        lead_time_days: v?.lead_time_days || null,
        purchase_count: r.purchase_count,
        last_date: r.last_date,
        last_price: r.last_price,
        avg_price: r.avg_price,
        total_qty: r.total_qty,
        contract_id: contract?.id || null,
        contract_price: contract?.unit_price ?? null,
        contract_valid_to: contract?.valid_to || null,
      };
    });

    return Response.json({ vendors: enriched });
  } catch (e: any) {
    console.error('[vendors/for-material]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
