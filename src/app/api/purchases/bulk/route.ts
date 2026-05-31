import { getDb, generateId, updateMaterialPrice } from '@/lib/db';

interface BulkPurchaseItem {
  item_name: string;
  vendor?: string;
  brand?: string;
  quantity: number;
  unit_price: number;
  total_amount?: number;
  date: string;
  notes?: string;
  gst_amount?: number;
}

export async function POST(request: Request) {
  try {
    const db = getDb();
    const body = await request.json();
    const { purchases } = body as { purchases: BulkPurchaseItem[] };

    if (!purchases || !Array.isArray(purchases) || purchases.length === 0) {
      return Response.json({ error: 'purchases array is required' }, { status: 400 });
    }

    // Load all materials for name matching
    const allMaterials = db.prepare('SELECT id, name FROM raw_materials').all() as { id: string; name: string }[];
    const materialMap = new Map<string, string>();
    for (const m of allMaterials) {
      materialMap.set(m.name.toLowerCase().trim(), m.id);
    }

    const results: { success: number; skipped: number; errors: string[] } = {
      success: 0,
      skipped: 0,
      errors: [],
    };

    const insertPurchase = db.prepare(`
      INSERT INTO purchases (id, material_id, vendor, brand, quantity, unit_price, total_price, date, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    const updateStock = db.prepare(`
      UPDATE raw_materials SET current_stock = current_stock + ?, updated_at = datetime('now') WHERE id = ?
    `);

    const insertTransaction = db.prepare(`
      INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at)
      VALUES (?, ?, 'purchase', ?, ?, ?, datetime('now'))
    `);

    const batchInsert = db.transaction(() => {
      for (let i = 0; i < purchases.length; i++) {
        const item = purchases[i];
        const rowNum = i + 1;

        // Validate required fields
        if (!item.item_name || (!item.quantity && !item.total_amount) || (!item.unit_price && !item.total_amount)) {
          results.errors.push(`Row ${rowNum}: Missing required fields (item_name: "${item.item_name || ''}")`);
          results.skipped++;
          continue;
        }

        // Match material by name (case-insensitive)
        const materialId = materialMap.get(item.item_name.toLowerCase().trim());
        if (!materialId) {
          results.errors.push(`Row ${rowNum}: Material not found: "${item.item_name}"`);
          results.skipped++;
          continue;
        }

        let quantity = Number(item.quantity) || 0;
        let unitPrice = Number(item.unit_price) || 0;
        const totalAmount = Number(item.total_amount) || 0;
        const gstAmount = Number(item.gst_amount) || 0;

        // If total_amount provided but no unit_price, calculate it
        if (totalAmount > 0 && unitPrice === 0 && quantity > 0) {
          unitPrice = Math.round(((totalAmount + gstAmount) / quantity) * 100) / 100;
        }

        // If unit_price provided and gst exists, add gst proportionally
        if (unitPrice > 0 && gstAmount > 0 && totalAmount === 0) {
          const lineTotal = unitPrice * quantity;
          unitPrice = Math.round(((lineTotal + gstAmount) / quantity) * 100) / 100;
        }

        if (quantity <= 0 || unitPrice <= 0) {
          results.errors.push(`Row ${rowNum}: Invalid quantity or price for "${item.item_name}"`);
          results.skipped++;
          continue;
        }

        const totalPrice = Math.round(quantity * unitPrice * 100) / 100;
        const id = generateId();

        insertPurchase.run(
          id, materialId, item.vendor || '', item.brand || '',
          quantity, unitPrice, totalPrice, item.date, item.notes || ''
        );

        updateStock.run(quantity, materialId);

        insertTransaction.run(
          generateId(), materialId, quantity, id,
          `Bulk import: ${item.vendor || 'unknown'}`
        );

        results.success++;
      }
    });

    batchInsert();

    // Update prices for all affected materials (batch at end for performance)
    const affectedMaterials = new Set<string>();
    for (const item of purchases) {
      const materialId = materialMap.get(item.item_name.toLowerCase().trim());
      if (materialId) affectedMaterials.add(materialId);
    }
    for (const materialId of affectedMaterials) {
      updateMaterialPrice(db, materialId);
    }

    return Response.json(results, { status: 200 });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
