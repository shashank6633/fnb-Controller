import { getDb, generateId } from '@/lib/db';

/**
 * POST /api/vendors/bulk — bulk create/update vendors + optional vendor↔material mapping.
 *
 * Body: {
 *   vendors:  [{ name, contact_person?, phone?, email?, gstin?, address?, payment_terms?, notes? }],
 *   mappings: [{ vendor, material, price? }]        // optional; material = SKU or name
 * }
 *
 * Vendors are UPSERTed by case-insensitive name — an existing vendor is updated
 * (only non-empty incoming fields overwrite; blanks leave the old value intact),
 * a new name is inserted. Mappings resolve the vendor by name and the material by
 * SKU-then-name, then write a (vendor, material) pairing into `vendor_materials`
 * (INSERT OR IGNORE — re-uploading is safe). When a price > 0 is given and no
 * active contract exists for that pair, a `vendor_contracts` row is added too.
 *
 * The (vendor_id, material_id) PK on vendor_materials makes the relationship
 * many-to-many: the same material may appear on many rows (one per vendor), each
 * with its own contract price.
 */
export async function POST(request: Request) {
  try {
    const db = getDb();
    const b = await request.json();
    const vendors  = Array.isArray(b.vendors)  ? b.vendors  : [];
    const mappings = Array.isArray(b.mappings) ? b.mappings : [];

    if (!vendors.length && !mappings.length) {
      return Response.json({ error: 'Nothing to import — no vendors or mappings found.' }, { status: 400 });
    }

    const s = (x: any) => (x == null ? '' : String(x).trim());
    // Canonical match key: lowercase + collapse internal whitespace. Makes vendor/material
    // matching robust to inconsistent spacing between sheets ("AM  Dairy" vs "AM Dairy").
    const canon = (x: any) => s(x).toLowerCase().replace(/\s+/g, ' ');

    // ---- Vendors: upsert by canonical name ----
    const existing = db.prepare('SELECT id, name FROM vendors').all() as any[];
    const byName = new Map<string, string>();
    for (const v of existing) byName.set(canon(v.name), v.id);

    const insertV = db.prepare(`
      INSERT INTO vendors (id, name, contact_person, phone, email, gstin, address, payment_terms, lead_time_days, is_active, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `);
    // Only overwrite a column when the incoming value is non-empty — a partial
    // re-upload never wipes existing detail. is_active is deliberately LEFT ALONE:
    // re-uploading the source export must not silently un-deactivate a vendor the
    // user removed locally (soft-delete via the Deactivate button sets is_active=0).
    const updateV = db.prepare(`
      UPDATE vendors SET
        contact_person = CASE WHEN ? != '' THEN ? ELSE contact_person END,
        phone          = CASE WHEN ? != '' THEN ? ELSE phone          END,
        email          = CASE WHEN ? != '' THEN ? ELSE email          END,
        gstin          = CASE WHEN ? != '' THEN ? ELSE gstin          END,
        address        = CASE WHEN ? != '' THEN ? ELSE address        END,
        payment_terms  = CASE WHEN ? != '' THEN ? ELSE payment_terms  END,
        notes          = CASE WHEN ? != '' THEN ? ELSE notes          END,
        updated_at     = datetime('now')
      WHERE id = ?
    `);

    let vCreated = 0, vUpdated = 0;
    const vSkipped: any[] = [];

    const runVendors = db.transaction((rows: any[]) => {
      rows.forEach((r, i) => {
        const name = s(r.name);
        if (!name) { vSkipped.push({ row: i + 2, reason: 'missing vendor name' }); return; }
        const key = canon(name);
        const cp = s(r.contact_person), ph = s(r.phone), em = s(r.email),
              gs = s(r.gstin), ad = s(r.address), pt = s(r.payment_terms), nt = s(r.notes);
        const existingId = byName.get(key);
        if (existingId) {
          updateV.run(cp, cp, ph, ph, em, em, gs, gs, ad, ad, pt, pt, nt, nt, existingId);
          vUpdated++;
        } else {
          const id = generateId();
          insertV.run(id, name, cp, ph, em, gs, ad, pt, Number(r.lead_time_days) || 0, nt);
          byName.set(key, id);
          vCreated++;
        }
      });
    });
    runVendors(vendors);

    // ---- Optional vendor↔material mappings ----
    let mMapped = 0, mPriced = 0;
    const mSkipped: any[] = [];
    if (mappings.length) {
      const mats = db.prepare('SELECT id, sku, name FROM raw_materials').all() as any[];
      const bySku = new Map<string, any>(), byMatName = new Map<string, any>();
      for (const m of mats) {
        if (m.sku) bySku.set(canon(m.sku), m);
        byMatName.set(canon(m.name), m);
      }

      const insVM = db.prepare(`
        INSERT OR IGNORE INTO vendor_materials (vendor_id, material_id, notes, created_by)
        VALUES (?, ?, '', 'bulk-import')
      `);
      const insVC = db.prepare(`
        INSERT INTO vendor_contracts (id, vendor_id, material_id, unit_price, currency, valid_from, is_active)
        VALUES (?, ?, ?, ?, 'INR', date('now'), 1)
      `);
      const hasContract = db.prepare(`
        SELECT 1 FROM vendor_contracts WHERE vendor_id = ? AND material_id = ? AND is_active = 1 LIMIT 1
      `);

      const runMap = db.transaction((rows: any[]) => {
        rows.forEach((r, i) => {
          const vId = byName.get(canon(r.vendor));
          if (!vId) { mSkipped.push({ row: i + 2, reason: `vendor not found ("${s(r.vendor)}")` }); return; }
          const matKey = canon(r.material);
          if (!matKey) { mSkipped.push({ row: i + 2, reason: 'missing material' }); return; }
          const mat = bySku.get(matKey) || byMatName.get(matKey);
          if (!mat) { mSkipped.push({ row: i + 2, reason: `material not found ("${s(r.material)}")` }); return; }
          insVM.run(vId, mat.id);
          mMapped++;
          const price = Number(r.price);
          if (price > 0 && !hasContract.get(vId, mat.id)) {
            insVC.run(generateId(), vId, mat.id, price);
            mPriced++;
          }
        });
      });
      runMap(mappings);
    }

    const parts = [`Vendors: ${vCreated} created, ${vUpdated} updated` + (vSkipped.length ? `, ${vSkipped.length} skipped` : '') + '.'];
    if (mappings.length) {
      parts.push(`Materials: ${mMapped} mapped` + (mPriced ? `, ${mPriced} priced` : '') + (mSkipped.length ? `, ${mSkipped.length} skipped` : '') + '.');
    }

    return Response.json({
      success: true,
      vendors:  { created: vCreated, updated: vUpdated, skipped: vSkipped.length, skipped_rows: vSkipped.slice(0, 20) },
      mappings: { mapped: mMapped, priced: mPriced, skipped: mSkipped.length, skipped_rows: mSkipped.slice(0, 20) },
      message: parts.join(' '),
    });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
