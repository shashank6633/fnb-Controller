import { getDb, generateId, updateMaterialPrice } from '@/lib/db';
import { centralFlowBlock } from '@/lib/store-engine';
import { getCurrentUser } from '@/lib/auth';
import { checkPurchaseDate } from '@/lib/purchase-guard';

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

/** One rejected row, echoed back with enough to re-download + fix + re-upload. */
type SkipKind = 'missing' | 'date' | 'not_found' | 'liquor' | 'invalid' | 'duplicate';
interface SkippedRow {
  row: number;
  item_name: string; vendor: string; brand: string;
  quantity: any; unit_price: any; total_amount: any; gst_amount: any;
  date: string; notes: string;
  kind: SkipKind; reason: string;
}

export async function POST(request: Request) {
  try {
    const db = getDb();
    const body = await request.json();
    const { purchases } = body as { purchases: BulkPurchaseItem[] };

    if (!purchases || !Array.isArray(purchases) || purchases.length === 0) {
      return Response.json({ error: 'purchases array is required' }, { status: 400 });
    }

    const me = await getCurrentUser();
    const isAdmin = me?.role === 'admin';

    const allMaterials = db.prepare('SELECT id, name, unit, purchase_unit, pack_size FROM raw_materials').all() as any[];
    const materialMap = new Map<string, any>();
    for (const m of allMaterials) materialMap.set(m.name.toLowerCase().trim(), m);

    const toStockQty = (m: any, qty: number) => {
      const packSize = Number(m.pack_size) || 1;
      const ru = String(m.unit || '').toLowerCase().trim();
      const pu = String(m.purchase_unit || m.unit || '').toLowerCase().trim();
      return (packSize > 1 && ru !== pu) ? qty * packSize : qty;
    };

    const results: {
      success: number; skipped: number; duplicates: number;
      errors: string[];
      store_blocked: Array<{ material: string; error: string }>;
      skipped_rows: SkippedRow[];
    } = { success: 0, skipped: 0, duplicates: 0, errors: [], store_blocked: [], skipped_rows: [] };

    // Record a skipped row into every reporting channel (back-compat + the new
    // detailed list the UI shows + lets the user download).
    const skip = (item: BulkPurchaseItem, rowNum: number, kind: SkipKind, reason: string) => {
      results.skipped++;
      if (kind === 'duplicate') results.duplicates++;
      results.errors.push(`Row ${rowNum}: ${reason}`);
      if (kind === 'liquor') results.store_blocked.push({ material: item.item_name || '', error: reason });
      results.skipped_rows.push({
        row: rowNum,
        item_name: item.item_name || '', vendor: item.vendor || '', brand: item.brand || '',
        quantity: item.quantity ?? '', unit_price: item.unit_price ?? '',
        total_amount: item.total_amount ?? '', gst_amount: item.gst_amount ?? '',
        date: item.date || '', notes: item.notes || '',
        kind, reason,
      });
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
    // Duplicate guard: a purchase with the SAME material + vendor + date + qty +
    // unit_price already in the DB. Rounded so float noise never causes a miss.
    const dupCheck = db.prepare(`
      SELECT 1 FROM purchases
      WHERE material_id = ?
        AND LOWER(COALESCE(vendor, '')) = LOWER(?)
        AND date = ?
        AND ROUND(quantity, 3)   = ROUND(?, 3)
        AND ROUND(unit_price, 2) = ROUND(?, 2)
      LIMIT 1
    `);

    const touchedMaterials = new Set<string>();
    // Also dedupe WITHIN the uploaded file (same row twice in one upload).
    const seenInFile = new Set<string>();
    const dupKey = (mid: string, vendor: string, date: string, q: number, up: number) =>
      `${mid}|${(vendor || '').toLowerCase().trim()}|${date}|${Math.round(q * 1000)}|${Math.round(up * 100)}`;

    const batchInsert = db.transaction(() => {
      for (let i = 0; i < purchases.length; i++) {
        const item = purchases[i];
        const rowNum = i + 1;

        if (!item.item_name || (!item.quantity && !item.total_amount) || (!item.unit_price && !item.total_amount)) {
          skip(item, rowNum, 'missing', `Missing required fields (item_name / quantity / price)`);
          continue;
        }
        const dateCheck = checkPurchaseDate(db, item.date, isAdmin);
        if (!dateCheck.ok) { skip(item, rowNum, 'date', dateCheck.error || 'Invalid date'); continue; }

        const mat = materialMap.get(item.item_name.toLowerCase().trim());
        if (!mat) { skip(item, rowNum, 'not_found', `Material not found: "${item.item_name}" — name must match an existing Raw Material.`); continue; }
        const materialId = mat.id;

        const storeMsg = centralFlowBlock(db, materialId);
        if (storeMsg) { skip(item, rowNum, 'liquor', storeMsg); continue; }

        let quantity = Number(item.quantity) || 0;
        let unitPrice = Number(item.unit_price) || 0;
        const totalAmount = Number(item.total_amount) || 0;
        const gstAmount = Number(item.gst_amount) || 0;
        if (totalAmount > 0 && unitPrice === 0 && quantity > 0) {
          unitPrice = Math.round(((totalAmount + gstAmount) / quantity) * 100) / 100;
        }
        if (unitPrice > 0 && gstAmount > 0 && totalAmount === 0) {
          const lineTotal = unitPrice * quantity;
          unitPrice = Math.round(((lineTotal + gstAmount) / quantity) * 100) / 100;
        }
        if (quantity <= 0 || unitPrice <= 0) {
          skip(item, rowNum, 'invalid', `Invalid quantity or price for "${item.item_name}"`);
          continue;
        }

        // Duplicate guard — already uploaded (DB) OR repeated earlier in this file.
        const key = dupKey(materialId, item.vendor || '', item.date, quantity, unitPrice);
        const already = seenInFile.has(key) || !!dupCheck.get(materialId, item.vendor || '', item.date, quantity, unitPrice);
        if (already) {
          skip(item, rowNum, 'duplicate',
            `Already uploaded — same item + vendor + date + qty + rate already exists. Skipped to avoid double-counting.`);
          continue;
        }
        seenInFile.add(key);

        const totalPrice = Math.round(quantity * unitPrice * 100) / 100;
        const id = generateId();
        insertPurchase.run(id, materialId, item.vendor || '', item.brand || '', quantity, unitPrice, totalPrice, item.date, item.notes || '');
        const stockQty = toStockQty(mat, quantity);
        updateStock.run(stockQty, materialId);
        insertTransaction.run(generateId(), materialId, stockQty, id, `Bulk import: ${item.vendor || 'unknown'}`);
        touchedMaterials.add(materialId);
        results.success++;
      }
    });
    batchInsert();

    for (const materialId of touchedMaterials) updateMaterialPrice(db, materialId);

    return Response.json(results, { status: 200 });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
