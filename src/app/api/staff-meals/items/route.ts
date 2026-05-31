import { getDb, generateId } from '@/lib/db';

export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const mealId = url.searchParams.get('meal_id');
    if (!mealId) return Response.json({ error: 'meal_id is required' }, { status: 400 });

    const items = db.prepare(`
      SELECT smi.*, rm.name as material_name, rm.unit as material_unit,
        rm.average_price as current_avg_price, rm.current_stock as material_current_stock,
        rm.category as material_category
      FROM staff_meal_items smi
      LEFT JOIN raw_materials rm ON smi.material_id = rm.id
      WHERE smi.meal_id = ?
      ORDER BY smi.category, smi.item_name
    `).all(mealId);

    const summary = db.prepare(`
      SELECT
        COUNT(*) as total_items,
        SUM(issued_quantity) as total_issued,
        SUM(returned_quantity) as total_returned,
        SUM(quantity) as total_consumed,
        SUM(total_cost) as total_cost,
        SUM(CASE WHEN status = 'issued' THEN 1 ELSE 0 END) as open_items,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed_items
      FROM staff_meal_items
      WHERE meal_id = ?
    `).get(mealId);

    return Response.json({ items, summary });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

// POST: Issue items (deducts from inventory)
export async function POST(request: Request) {
  try {
    const db = getDb();
    const body = await request.json();
    const { items, deduct_inventory } = body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return Response.json({ error: 'items array is required' }, { status: 400 });
    }

    const allMaterials = db.prepare('SELECT id, name, average_price, unit, category, current_stock FROM raw_materials').all() as any[];
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
        if (!item.meal_id || !item.item_name) {
          results.errors.push(`Row ${i + 1}: meal_id and item_name required`);
          continue;
        }

        let materialId = item.material_id || null;
        let purchasePrice = Number(item.purchase_price) || 0;
        let category = item.category || '';
        let unit = item.unit || '';

        if (!materialId && item.item_name) {
          const matched = materialByName.get(item.item_name.toLowerCase().trim());
          if (matched) {
            materialId = matched.id;
            if (purchasePrice === 0) purchasePrice = matched.average_price || 0;
            if (!category) category = matched.category || 'grocery';
            if (!unit) unit = matched.unit || 'kg';
          }
        }
        if (materialId && purchasePrice === 0) {
          const mat = materialById.get(materialId);
          if (mat) {
            purchasePrice = mat.average_price || 0;
            if (!category) category = mat.category || 'grocery';
            if (!unit) unit = mat.unit || 'kg';
          }
        }

        const issuedQuantity = Number(item.issued_quantity ?? item.quantity) || 0;
        if (issuedQuantity <= 0) {
          results.errors.push(`Row ${i + 1}: issued quantity must be > 0`);
          continue;
        }

        const totalCost = Math.round(purchasePrice * issuedQuantity * 100) / 100;
        const id = generateId();

        db.prepare(`
          INSERT INTO staff_meal_items (id, meal_id, item_name, material_id, category,
            quantity, issued_quantity, returned_quantity, unit, purchase_price, total_cost,
            status, issued_at, notes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'issued', datetime('now'), ?, datetime('now'))
        `).run(
          id, item.meal_id, item.item_name, materialId,
          category || 'grocery', issuedQuantity, issuedQuantity,
          unit || 'kg', purchasePrice, totalCost, item.notes || ''
        );

        if (deduct_inventory && materialId) {
          db.prepare(`
            UPDATE raw_materials SET current_stock = current_stock - ?, updated_at = datetime('now')
            WHERE id = ?
          `).run(issuedQuantity, materialId);

          db.prepare(`
            INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at)
            VALUES (?, ?, 'staff_meal_issue', ?, ?, ?, datetime('now'))
          `).run(
            generateId(), materialId, -issuedQuantity, id,
            `Issued to staff meal ${item.meal_id}`
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

// PATCH: Record returns (restores unused to inventory)
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
        if (!ret.id) { results.errors.push(`Row ${i + 1}: item id required`); continue; }

        const item = db.prepare('SELECT * FROM staff_meal_items WHERE id = ?').get(ret.id) as any;
        if (!item) { results.errors.push(`Row ${i + 1}: item not found`); continue; }

        const returnedQty = Number(ret.returned_quantity) || 0;
        if (returnedQty < 0) {
          results.errors.push(`Row ${i + 1}: returned qty cannot be negative`);
          continue;
        }
        if (returnedQty > item.issued_quantity) {
          results.errors.push(`Row ${i + 1}: returned (${returnedQty}) cannot exceed issued (${item.issued_quantity})`);
          continue;
        }

        const consumedQty = item.issued_quantity - returnedQty;
        const totalCost = Math.round(item.purchase_price * consumedQty * 100) / 100;

        db.prepare(`
          UPDATE staff_meal_items SET
            returned_quantity = ?, quantity = ?, total_cost = ?,
            status = 'closed', returned_at = datetime('now'),
            notes = COALESCE(?, notes)
          WHERE id = ?
        `).run(returnedQty, consumedQty, totalCost, ret.notes || null, ret.id);

        if (restore_inventory && item.material_id && returnedQty > 0) {
          db.prepare(`
            UPDATE raw_materials SET current_stock = current_stock + ?, updated_at = datetime('now')
            WHERE id = ?
          `).run(returnedQty, item.material_id);

          db.prepare(`
            INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at)
            VALUES (?, ?, 'staff_meal_return', ?, ?, ?, datetime('now'))
          `).run(
            generateId(), item.material_id, returnedQty, ret.id,
            `Returned from staff meal ${item.meal_id} (unused)`
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
    if (!id) return Response.json({ error: 'id is required' }, { status: 400 });

    const item = db.prepare('SELECT * FROM staff_meal_items WHERE id = ?').get(id) as any;
    if (item && item.material_id && item.status === 'issued') {
      const netRemoved = item.issued_quantity - item.returned_quantity;
      if (netRemoved > 0) {
        db.prepare('UPDATE raw_materials SET current_stock = current_stock + ? WHERE id = ?')
          .run(netRemoved, item.material_id);
        db.prepare(`
          INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at)
          VALUES (?, ?, 'adjustment', ?, ?, ?, datetime('now'))
        `).run(generateId(), item.material_id, netRemoved, id, `Staff meal item deleted — restored`);
      }
    }

    db.prepare('DELETE FROM staff_meal_items WHERE id = ?').run(id);
    return Response.json({ success: true });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
