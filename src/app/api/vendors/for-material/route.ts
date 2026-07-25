import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

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
 *
 * Any signed-in user (read-only) — the response carries negotiated contract rates
 * and purchase history, so it must not be readable without a session.
 */
export async function GET(request: Request) {
  try {
    const viewer = await getCurrentUser();
    if (!viewer) return Response.json({ error: 'Sign in required' }, { status: 401 });
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
    // TRIM both sides: the bind value is the TRIM(p.vendor) the SELECT above produced,
    // but a vendors-master name can carry stray whitespace, so an untrimmed compare
    // silently fails to resolve vendor_id and the active contract price never surfaces.
    // Same convention as vendor-contracts / vendors/materials-summary. Note SQLite's
    // TRIM() strips spaces only — a tab/NBSP-padded master name still misses here; the
    // durable fix is trimming the name at the vendors write boundary.
    // ORDER BY: with both sides trimmed, a clean row and a whitespace-padded duplicate
    // of the same name both match, so pick deterministically — the live row first, then
    // the exact (shortest, i.e. unpadded) name — instead of whatever the scan hits first.
    const lookup = db.prepare(`
      SELECT id, name, payment_terms, lead_time_days
      FROM vendors
      WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))
      ORDER BY is_active DESC, LENGTH(name) ASC
      LIMIT 1
    `);
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
      // A ₹0 contract row is "this vendor sells this item, price TBD" — vendor-contracts
      // POST explicitly allows unit_price = 0 — not an agreed rate. Report the whole
      // contract as absent so no consumer auto-fills a PO line at ₹0.
      const hasRate = Number(contract?.unit_price) > 0;
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
        contract_id: hasRate ? contract.id : null,
        contract_price: hasRate ? contract.unit_price : null,
        contract_valid_to: hasRate ? (contract.valid_to || null) : null,
      };
    });

    return Response.json({ vendors: enriched });
  } catch (e: any) {
    console.error('[vendors/for-material]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
