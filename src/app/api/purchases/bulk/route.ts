import { getDb, generateId, updateMaterialPrice } from '@/lib/db';
import { centralFlowBlock } from '@/lib/store-engine';

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

    // Load all materials for name matching (with units so we can convert
    // purchase-unit quantities → recipe units for the stock increment).
    const allMaterials = db.prepare('SELECT id, name, unit, purchase_unit, pack_size FROM raw_materials').all() as any[];
    const materialMap = new Map<string, any>();
    for (const m of allMaterials) {
      materialMap.set(m.name.toLowerCase().trim(), m);
    }
    // Stock is kept in RECIPE units everywhere (sales deduction, closing-stock
    // variance × average_price). The CSV quantity is in PURCHASE units, so
    // multiply by pack_size when recipe_unit ≠ purchase_unit — mirroring
    // updateMaterialPrice()'s guard so price (÷pack) and stock (×pack) stay aligned.
    const toStockQty = (m: any, qty: number) => {
      const packSize = Number(m.pack_size) || 1;
      const ru = String(m.unit || '').toLowerCase().trim();
      const pu = String(m.purchase_unit || m.unit || '').toLowerCase().trim();
      return (packSize > 1 && ru !== pu) ? qty * packSize : qty;
    };

    const results: {
      success: number; skipped: number; errors: string[];
      // Store guard (liquor) — rows skipped because the material is store-mapped.
      // Per-line skip + report, mirroring inward-import: never fail the batch.
      store_blocked: Array<{ material: string; error: string }>;
    } = {
      success: 0,
      skipped: 0,
      errors: [],
      store_blocked: [],
    };
    // Only materials that actually received a purchase row get a price recompute.
    const touchedMaterials = new Set<string>();

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
        const mat = materialMap.get(item.item_name.toLowerCase().trim());
        if (!mat) {
          results.errors.push(`Row ${rowNum}: Material not found: "${item.item_name}"`);
          results.skipped++;
          continue;
        }
        const materialId = mat.id;

        // Store guard: store-mapped materials (liquor) never enter Central
        // purchases/stock via bulk import — skip the line, report it, keep going.
        const storeMsg = centralFlowBlock(db, materialId);
        if (storeMsg) {
          results.store_blocked.push({ material: item.item_name, error: storeMsg });
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

        const stockQty = toStockQty(mat, quantity);   // recipe/stock units
        updateStock.run(stockQty, materialId);

        insertTransaction.run(
          generateId(), materialId, stockQty, id,
          `Bulk import: ${item.vendor || 'unknown'}`
        );

        touchedMaterials.add(materialId);
        results.success++;
      }
    });

    batchInsert();

    // Update prices for all affected materials (batch at end for performance).
    // Uses the touched set so store-blocked / skipped lines never trigger a recompute.
    for (const materialId of touchedMaterials) {
      updateMaterialPrice(db, materialId);
    }

    return Response.json(results, { status: 200 });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
