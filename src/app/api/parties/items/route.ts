import { getDb, generateId } from '@/lib/db';

export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const partyId = url.searchParams.get('party_id');

    if (!partyId) {
      return Response.json({ error: 'party_id is required' }, { status: 400 });
    }

    const items = db.prepare(`
      SELECT pi.*, rm.name as material_name, rm.unit as material_unit,
        rm.average_price as current_avg_price, rm.current_stock as material_current_stock
      FROM party_items pi
      LEFT JOIN raw_materials rm ON pi.material_id = rm.id
      WHERE pi.party_id = ?
      ORDER BY pi.category, pi.item_name
    `).all(partyId);

    // Summary by category (based on consumed quantity)
    const summary = db.prepare(`
      SELECT
        category,
        COUNT(*) as item_count,
        SUM(issued_quantity) as total_issued,
        SUM(returned_quantity) as total_returned,
        SUM(quantity) as total_consumed,
        SUM(total_cost) as total_cost,
        SUM(total_revenue) as total_revenue,
        SUM(CASE WHEN is_complimentary = 1 THEN total_cost ELSE 0 END) as comp_cost
      FROM party_items
      WHERE party_id = ?
      GROUP BY category
    `).all(partyId);

    return Response.json({ items, summary });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

// POST: Issue items for a party (opening) — deducts from main inventory
export async function POST(request: Request) {
  try {
    const db = getDb();
    const body = await request.json();
    const { items, deduct_inventory } = body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return Response.json({ error: 'items array is required' }, { status: 400 });
    }

    const allMaterials = db.prepare('SELECT id, name, average_price, unit, current_stock FROM raw_materials').all() as any[];
    const materialByName = new Map<string, any>();
    const materialById = new Map<string, any>();
    for (const m of allMaterials) {
      materialByName.set(m.name.toLowerCase().trim(), m);
      materialById.set(m.id, m);
    }

    const results = { success: 0, errors: [] as string[] };

    const insertItems = db.transaction(() => {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item.party_id || !item.item_name) {
          results.errors.push(`Row ${i + 1}: party_id and item_name required`);
          continue;
        }

        // Match material
        let materialId = item.material_id || null;
        let purchasePrice = Number(item.purchase_price) || 0;

        if (!materialId && item.item_name) {
          const matched = materialByName.get(item.item_name.toLowerCase().trim());
          if (matched) {
            materialId = matched.id;
            if (purchasePrice === 0) purchasePrice = matched.average_price || 0;
          }
        }
        if (materialId && purchasePrice === 0) {
          const mat = materialById.get(materialId);
          if (mat) purchasePrice = mat.average_price || 0;
        }

        const issuedQuantity = Number(item.issued_quantity ?? item.quantity) || 0;
        const sellingPrice = Number(item.selling_price) || 0;
        const isComp = item.is_complimentary ? 1 : 0;

        if (issuedQuantity <= 0) {
          results.errors.push(`Row ${i + 1}: issued quantity must be greater than 0`);
          continue;
        }

        // At issue time, consumed = issued (no return recorded yet)
        const totalCost = Math.round(purchasePrice * issuedQuantity * 100) / 100;
        const totalRevenue = isComp ? 0 : Math.round(sellingPrice * issuedQuantity * 100) / 100;

        const id = generateId();

        db.prepare(`
          INSERT INTO party_items (id, party_id, item_name, material_id, category,
            quantity, issued_quantity, returned_quantity, unit, purchase_price, selling_price,
            total_cost, total_revenue, is_complimentary, status, issued_at, notes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 'issued', datetime('now'), ?, datetime('now'))
        `).run(
          id, item.party_id, item.item_name, materialId,
          item.category || 'beverage', issuedQuantity, issuedQuantity,
          item.unit || 'pcs', purchasePrice, sellingPrice,
          totalCost, totalRevenue, isComp, item.notes || ''
        );

        // Deduct from main inventory if requested and material matched
        if (deduct_inventory && materialId) {
          db.prepare(`
            UPDATE raw_materials SET current_stock = current_stock - ?, updated_at = datetime('now')
            WHERE id = ?
          `).run(issuedQuantity, materialId);

          db.prepare(`
            INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at)
            VALUES (?, ?, 'party_issue', ?, ?, ?, datetime('now'))
          `).run(
            generateId(), materialId, -issuedQuantity, id,
            `Issued to party ${item.party_id}`
          );
        }

        results.success++;
      }
    });

    insertItems();

    return Response.json(results, { status: 201 });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

// PATCH: Record returns for party items (closing) — returns unused qty to inventory
export async function PATCH(request: Request) {
  try {
    const db = getDb();
    const body = await request.json();
    const { returns, restore_inventory } = body;

    if (!returns || !Array.isArray(returns) || returns.length === 0) {
      return Response.json({ error: 'returns array is required' }, { status: 400 });
    }

    const results = { success: 0, errors: [] as string[] };

    const processReturns = db.transaction(() => {
      for (let i = 0; i < returns.length; i++) {
        const ret = returns[i];
        if (!ret.id) {
          results.errors.push(`Row ${i + 1}: item id required`);
          continue;
        }

        const item = db.prepare('SELECT * FROM party_items WHERE id = ?').get(ret.id) as any;
        if (!item) {
          results.errors.push(`Row ${i + 1}: item not found`);
          continue;
        }

        const returnedQty = Number(ret.returned_quantity) || 0;
        if (returnedQty < 0) {
          results.errors.push(`Row ${i + 1}: returned quantity cannot be negative`);
          continue;
        }
        if (returnedQty > item.issued_quantity) {
          results.errors.push(`Row ${i + 1}: returned (${returnedQty}) cannot exceed issued (${item.issued_quantity})`);
          continue;
        }

        const consumedQty = item.issued_quantity - returnedQty;
        const totalCost = Math.round(item.purchase_price * consumedQty * 100) / 100;
        const totalRevenue = item.is_complimentary
          ? 0
          : Math.round(item.selling_price * consumedQty * 100) / 100;

        db.prepare(`
          UPDATE party_items SET
            returned_quantity = ?,
            quantity = ?,
            total_cost = ?,
            total_revenue = ?,
            status = 'closed',
            returned_at = datetime('now'),
            notes = COALESCE(?, notes)
          WHERE id = ?
        `).run(returnedQty, consumedQty, totalCost, totalRevenue, ret.notes || null, ret.id);

        // Restore unused to main inventory
        if (restore_inventory && item.material_id && returnedQty > 0) {
          db.prepare(`
            UPDATE raw_materials SET current_stock = current_stock + ?, updated_at = datetime('now')
            WHERE id = ?
          `).run(returnedQty, item.material_id);

          db.prepare(`
            INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at)
            VALUES (?, ?, 'party_return', ?, ?, ?, datetime('now'))
          `).run(
            generateId(), item.material_id, returnedQty, ret.id,
            `Returned from party ${item.party_id} (unused)`
          );
        }

        results.success++;
      }
    });

    processReturns();

    return Response.json(results);
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const id = url.searchParams.get('id');

    if (!id) {
      return Response.json({ error: 'id is required' }, { status: 400 });
    }

    // If deleting an issued item, restore the stock
    const item = db.prepare('SELECT * FROM party_items WHERE id = ?').get(id) as any;
    if (item && item.material_id && item.status === 'issued') {
      const netRemoved = item.issued_quantity - item.returned_quantity;
      if (netRemoved > 0) {
        db.prepare('UPDATE raw_materials SET current_stock = current_stock + ? WHERE id = ?')
          .run(netRemoved, item.material_id);
        db.prepare(`
          INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at)
          VALUES (?, ?, 'adjustment', ?, ?, ?, datetime('now'))
        `).run(generateId(), item.material_id, netRemoved, id, `Party item deleted — restored to stock`);
      }
    }

    db.prepare('DELETE FROM party_items WHERE id = ?').run(id);
    return Response.json({ success: true });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
