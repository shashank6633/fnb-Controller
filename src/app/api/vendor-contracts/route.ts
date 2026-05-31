import { getDb, generateId } from '@/lib/db';

/**
 * Vendor Contracts — negotiated unit prices per (vendor, material).
 *
 * GET    /api/vendor-contracts                                → list all (with vendor + material names)
 * GET    /api/vendor-contracts?material_id=X                  → contracts for a material
 * GET    /api/vendor-contracts?vendor_id=Y                    → contracts for a vendor
 * GET    /api/vendor-contracts?material_id=X&vendor_id=Y      → exactly one contract (or none)
 * GET    /api/vendor-contracts?id=Z                           → single
 * POST   /api/vendor-contracts                                → create
 *        body: { vendor_id, material_id, unit_price, valid_from?, valid_to?, notes? }
 * PUT    /api/vendor-contracts                                → update
 *        body: { id, unit_price?, valid_from?, valid_to?, notes?, is_active? }
 * DELETE /api/vendor-contracts?id=Z                           → soft-delete (is_active=0)
 *
 * "Active" means is_active=1 AND today is within [valid_from, valid_to NULL=∞].
 */

const today = () => new Date().toISOString().slice(0, 10);

const SELECT_BASE = `
  SELECT vc.*,
         v.name  AS vendor_name,
         rm.name AS material_name,
         rm.sku  AS material_sku,
         rm.unit AS material_unit,
         rm.average_price AS material_avg_price,
         rm.last_purchase_price AS material_last_price,
         CASE
           WHEN vc.is_active = 1
            AND vc.valid_from <= date('now')
            AND (vc.valid_to IS NULL OR vc.valid_to >= date('now'))
           THEN 1 ELSE 0
         END AS currently_active
  FROM vendor_contracts vc
  JOIN vendors      v  ON v.id  = vc.vendor_id
  JOIN raw_materials rm ON rm.id = vc.material_id
`;

export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const id          = url.searchParams.get('id');
    const materialId  = url.searchParams.get('material_id');
    const vendorId    = url.searchParams.get('vendor_id');
    const onlyActive  = url.searchParams.get('active') === '1';

    if (id) {
      const row = db.prepare(`${SELECT_BASE} WHERE vc.id = ?`).get(id);
      if (!row) return Response.json({ error: 'Not found' }, { status: 404 });
      return Response.json({ contract: row });
    }

    const where: string[] = ['1=1'];
    const params: any[] = [];
    if (materialId) { where.push('vc.material_id = ?'); params.push(materialId); }
    if (vendorId)   { where.push('vc.vendor_id = ?');   params.push(vendorId); }
    if (onlyActive) {
      where.push(`vc.is_active = 1
                  AND vc.valid_from <= date('now')
                  AND (vc.valid_to IS NULL OR vc.valid_to >= date('now'))`);
    }

    const rows = db.prepare(`
      ${SELECT_BASE}
      WHERE ${where.join(' AND ')}
      ORDER BY currently_active DESC, vc.valid_from DESC, vc.created_at DESC
    `).all(...params);
    return Response.json({ contracts: rows });
  } catch (e: any) {
    console.error('[vendor-contracts GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const db = getDb();
    const b = await request.json();
    if (!b.vendor_id || !b.material_id) {
      return Response.json({ error: 'vendor_id and material_id required' }, { status: 400 });
    }
    // unit_price=0 is allowed — used by simple vendor↔material mappings on
    // /vendors/materials where the user just declares "this vendor sells this
    // item, price TBD". PO/GRN will still warn if the price is 0.
    let price = Number(b.unit_price);
    if (!Number.isFinite(price) || price < 0) price = 0;
    // If no price was given AND we have a purchase history for this pair,
    // auto-seed with the most recent purchase rate so the contract is useful.
    if (price === 0) {
      const lp = db.prepare(`
        SELECT p.unit_price FROM purchases p
        JOIN vendors v ON LOWER(TRIM(v.name)) = LOWER(TRIM(p.vendor))
        WHERE v.id = ? AND p.material_id = ?
        ORDER BY p.date DESC, p.created_at DESC LIMIT 1
      `).get(b.vendor_id, b.material_id) as { unit_price?: number } | undefined;
      if (lp?.unit_price) price = lp.unit_price;
    }
    const validFrom = (b.valid_from as string) || today();
    const validTo   = (b.valid_to as string) || null;

    // Auto-deactivate any existing open contract for the same (vendor, material) so
    // there's at most one currently-active row per pair. Audit trail is preserved
    // via is_active=0 + the old valid_to.
    const id = generateId();
    const txn = db.transaction(() => {
      db.prepare(`
        UPDATE vendor_contracts
        SET is_active = 0,
            valid_to  = COALESCE(valid_to, date(?, '-1 day')),
            updated_at = datetime('now')
        WHERE vendor_id = ? AND material_id = ?
          AND is_active = 1
          AND (valid_to IS NULL OR valid_to >= date(?))
      `).run(validFrom, b.vendor_id, b.material_id, validFrom);

      db.prepare(`
        INSERT INTO vendor_contracts
          (id, vendor_id, material_id, unit_price, currency, valid_from, valid_to, notes, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(id, b.vendor_id, b.material_id, price,
              b.currency || 'INR', validFrom, validTo, b.notes || '');
    });
    txn();

    const row = db.prepare(`${SELECT_BASE} WHERE vc.id = ?`).get(id);
    return Response.json({ contract: row }, { status: 201 });
  } catch (e: any) {
    console.error('[vendor-contracts POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const db = getDb();
    const b = await request.json();
    if (!b.id) return Response.json({ error: 'id required' }, { status: 400 });
    db.prepare(`
      UPDATE vendor_contracts SET
        unit_price = COALESCE(?, unit_price),
        valid_from = COALESCE(?, valid_from),
        valid_to   = ?,
        notes      = COALESCE(?, notes),
        is_active  = COALESCE(?, is_active),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      b.unit_price != null ? Number(b.unit_price) : null,
      b.valid_from ?? null,
      // valid_to is intentionally pass-through: null clears it (open-ended)
      b.valid_to !== undefined ? b.valid_to : null,
      b.notes ?? null,
      b.is_active != null ? (b.is_active ? 1 : 0) : null,
      b.id,
    );
    const row = db.prepare(`${SELECT_BASE} WHERE vc.id = ?`).get(b.id);
    return Response.json({ contract: row });
  } catch (e: any) {
    console.error('[vendor-contracts PUT]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const db = getDb();
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return Response.json({ error: 'id required' }, { status: 400 });
    db.prepare(`UPDATE vendor_contracts SET is_active = 0, updated_at = datetime('now') WHERE id = ?`).run(id);
    return Response.json({ success: true });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
