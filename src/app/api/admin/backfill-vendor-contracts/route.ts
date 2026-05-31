import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Backfill `vendor_contracts` from purchase history.
 *
 *   FOR every unique (vendor, material) pair in `purchases`:
 *     - Look up vendor_id by case-insensitive name match against vendors table
 *     - Pick the most recent unit_price for that pair
 *     - Insert into vendor_contracts if no active row exists; skip if it already does
 *
 * Idempotent — safe to re-run. Existing contracts are never overwritten.
 *
 * POST /api/admin/backfill-vendor-contracts
 *
 * Admin / store manager only.
 *
 * Returns:
 *   { created: [...], skipped_existing: [...], skipped_no_vendor: [...] }
 */
export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (me.role !== 'admin' && !me.is_store_manager) {
      return Response.json({ error: 'Admin / store manager only' }, { status: 403 });
    }
    const db = getDb();

    // Build vendor_name(lowercased) → vendor_id map
    const vendorRows = db.prepare(`SELECT id, name FROM vendors WHERE is_active = 1`).all() as any[];
    const vendorByName = new Map<string, string>();
    for (const v of vendorRows) vendorByName.set(String(v.name || '').trim().toLowerCase(), v.id);

    // For every unique (vendor, material) pair: pick latest purchase
    const pairs = db.prepare(`
      SELECT p.vendor AS vendor_name, p.material_id,
             rm.name  AS material_name
      FROM purchases p
      JOIN raw_materials rm ON rm.id = p.material_id
      WHERE TRIM(COALESCE(p.vendor, '')) != ''
      GROUP BY LOWER(TRIM(p.vendor)), p.material_id
    `).all() as any[];

    const latestPrice = db.prepare(`
      SELECT unit_price
      FROM purchases
      WHERE LOWER(TRIM(vendor)) = LOWER(TRIM(?)) AND material_id = ?
      ORDER BY date DESC, created_at DESC
      LIMIT 1
    `);
    const contractExists = db.prepare(`
      SELECT id FROM vendor_contracts
      WHERE vendor_id = ? AND material_id = ? AND is_active = 1
    `);
    const insertContract = db.prepare(`
      INSERT INTO vendor_contracts (id, vendor_id, material_id, unit_price, currency, valid_from, valid_to, notes, is_active)
      VALUES (?, ?, ?, ?, 'INR', date('now'), NULL, 'Auto-backfilled from purchase history', 1)
    `);

    const created: any[] = [];
    const skipped_existing: any[] = [];
    const skipped_no_vendor: any[] = [];

    const txn = db.transaction(() => {
      for (const p of pairs) {
        const vendorKey = String(p.vendor_name || '').trim().toLowerCase();
        const vendorId = vendorByName.get(vendorKey);
        if (!vendorId) {
          skipped_no_vendor.push({
            vendor_name: p.vendor_name, material_name: p.material_name,
            reason: 'Vendor not in /vendors master — add it first',
          });
          continue;
        }
        if (contractExists.get(vendorId, p.material_id)) {
          skipped_existing.push({ vendor_name: p.vendor_name, material_name: p.material_name });
          continue;
        }
        const lp = latestPrice.get(p.vendor_name, p.material_id) as { unit_price?: number } | undefined;
        const unitPrice = lp?.unit_price || 0;
        insertContract.run(generateId(), vendorId, p.material_id, unitPrice);
        created.push({
          vendor_name: p.vendor_name, material_name: p.material_name,
          unit_price: unitPrice,
        });
      }
    });
    txn();

    return Response.json({
      created, skipped_existing, skipped_no_vendor,
      summary: `Created ${created.length} vendor-material contract${created.length === 1 ? '' : 's'} from purchase history.` +
               ` Skipped ${skipped_existing.length} already-active. ${skipped_no_vendor.length} purchases referenced vendors not in the master list.`,
    });
  } catch (e: any) {
    console.error('[/api/admin/backfill-vendor-contracts]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
