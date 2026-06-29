import { getDb, generateId, updateMaterialPrice } from '@/lib/db';

export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const materialId = url.searchParams.get('material_id');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');

    // p.quantity is stored in PURCHASE units (kg, BTL) and p.unit_price per
    // purchase unit, so they ARE the natural display values. recipe_qty is the
    // recipe-unit equivalent (× pack_size when recipe_unit ≠ purchase_unit) for
    // the secondary "= 20,000 g" hint. total_price is the invoice amount.
    let query = `
      SELECT p.*, rm.name as material_name,
             rm.unit          AS material_unit,
             rm.purchase_unit AS material_purchase_unit,
             COALESCE(rm.pack_size, 1) AS material_pack_size,
             p.quantity   AS purchase_qty,
             p.unit_price AS purchase_unit_price,
             CASE WHEN COALESCE(rm.pack_size, 1) > 1
                       AND LOWER(rm.unit) <> LOWER(COALESCE(rm.purchase_unit, rm.unit))
                  THEN p.quantity * rm.pack_size
                  ELSE p.quantity
             END AS recipe_qty
      FROM purchases p
      JOIN raw_materials rm ON p.material_id = rm.id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (materialId) {
      query += ' AND p.material_id = ?';
      params.push(materialId);
    }
    if (from) {
      query += ' AND p.date >= ?';
      params.push(from);
    }
    if (to) {
      query += ' AND p.date <= ?';
      params.push(to);
    }

    query += ' ORDER BY p.date DESC, p.created_at DESC';

    const purchases = db.prepare(query).all(...params);
    return Response.json({ purchases });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const db = getDb();
    const body = await request.json();
    const { material_id, vendor, brand, quantity, unit_price, date, notes,
            is_emergency, payment_mode, emergency_reason } = body;

    if (!material_id || !quantity || !unit_price || !date) {
      return Response.json({ error: 'material_id, quantity, unit_price, and date are required' }, { status: 400 });
    }

    const material = db.prepare('SELECT * FROM raw_materials WHERE id = ?').get(material_id) as any;
    if (!material) {
      return Response.json({ error: 'Material not found' }, { status: 404 });
    }

    const total_price = Math.round(quantity * unit_price * 100) / 100;
    const id = generateId();

    const insertPurchase = db.transaction(() => {
      // Create purchase record (with optional emergency / cash flags)
      db.prepare(`
        INSERT INTO purchases (id, material_id, vendor, brand, quantity, unit_price, total_price, date, notes,
                               is_emergency, payment_mode, emergency_reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(id, material_id, vendor || '', brand || '', quantity, unit_price, total_price, date, notes || '',
              is_emergency ? 1 : 0, payment_mode || '', emergency_reason || '');

      // Stock is kept in RECIPE units (sales deduction, closing-stock variance
      // × average_price). quantity is entered in PURCHASE units, so multiply by
      // pack_size when recipe_unit ≠ purchase_unit — mirroring updateMaterialPrice().
      const packSize = Number(material.pack_size) || 1;
      const ru = String(material.unit || '').toLowerCase().trim();
      const pu = String(material.purchase_unit || material.unit || '').toLowerCase().trim();
      const stockQty = (packSize > 1 && ru !== pu) ? quantity * packSize : quantity;

      // Update stock
      db.prepare(`
        UPDATE raw_materials SET current_stock = current_stock + ?, updated_at = datetime('now') WHERE id = ?
      `).run(stockQty, material_id);

      // Create inventory transaction
      db.prepare(`
        INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at)
        VALUES (?, ?, 'purchase', ?, ?, ?, datetime('now'))
      `).run(generateId(), material_id, stockQty, id, `Purchase from ${vendor || 'unknown'}`);

      // Update material price and cascade
      updateMaterialPrice(db, material_id);
    });

    insertPurchase();

    const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(id);
    return Response.json({ purchase }, { status: 201 });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
