import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/purchases/vendor-rates?vendor=<name>
 *   -> { vendor, rates: { [material_id]: { unit_price, date } } }
 *
 * The last rate THIS vendor charged for each item, so Enter Full Bill can seed a
 * line's Unit Price with a number the store person is actually checking against.
 *
 * WHY VENDOR-SCOPED AND NOT THE PO'S poRateOf(). The PO composer seeds from the
 * newest purchase by ANYONE, which is right for a document we author — we are
 * deciding what to pay. A bill is a document we TRANSCRIBE, and three vendors on
 * three adjacent rows will not have charged the same price for the same item.
 * Seeding a bill line from another vendor's rate invites someone to accept a
 * figure that was never charged, in the one field that recomputes average cost
 * and re-costs every recipe built on the material.
 *
 * BASIS — the trap this endpoint has to get right. purchases.unit_price is
 * rupees per PURCHASE unit by core convention, which is exactly the basis a bill
 * line is entered in, so this value needs NO conversion. It is deliberately NOT
 * raw_materials.last_purchase_price: that stored column holds MIXED bases (some
 * rows recipe-basis, off by up to 5,000x) and must never seed an input. See the
 * NAME TRAP note above poRateOf() in src/app/purchase-orders/page.tsx, which
 * survives only because /api/inventory ALIASES the column over this same
 * purchases.unit_price. Here we read the source directly.
 *
 * ONE QUERY, NOT ONE PER LINE. The whole map comes back on a single vendor
 * selection. A request per material would be an N+1 against synchronous
 * better-sqlite3 on a single-threaded box — every one of those blocks billing
 * and KOT, which is how a 504 reaches a live venue.
 *
 * Zero and negative rates are excluded: they are refused on save anyway, and a
 * prefilled 0 reads as "this is free" rather than "we have no record".
 */
export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  const url = new URL(request.url);
  const vendorRaw = url.searchParams.get('vendor') || '';
  const vendor = vendorRaw.trim().toLowerCase();
  // No vendor chosen yet is a normal state on a half-filled bill, not an error —
  // answer with an empty map so the caller needs no special case.
  if (!vendor) return Response.json({ vendor: '', rates: {} });

  const db = getDb();

  /* Newest row per material for this vendor, in one pass. Vendor is matched on
   * lower(trim(...)) because the name reaches purchases from three writers — the
   * bill modal, the CSV importer and the Recaho inward import — and they do not
   * agree on case or trailing spaces. (Measured today: 42 distinct vendors, 42
   * after normalising, so nothing collapses right now; the guard is for the
   * imports that will.) */
  const rows = db.prepare(`
    SELECT material_id, unit_price, date
      FROM (
        SELECT material_id, unit_price, date,
               ROW_NUMBER() OVER (
                 PARTITION BY material_id
                 ORDER BY date DESC, created_at DESC
               ) AS rn
          FROM purchases
         WHERE lower(trim(COALESCE(vendor, ''))) = ?
           AND COALESCE(unit_price, 0) > 0
           AND COALESCE(material_id, '') <> ''
      )
     WHERE rn = 1
  `).all(vendor) as Array<{ material_id: string; unit_price: number; date: string }>;

  const rates: Record<string, { unit_price: number; date: string }> = {};
  for (const r of rows) {
    rates[r.material_id] = { unit_price: Number(r.unit_price) || 0, date: String(r.date || '') };
  }

  return Response.json({ vendor: vendorRaw.trim(), rates });
}
