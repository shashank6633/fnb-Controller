import { getDb, logAuditEvent } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { getStoreById, materialStoreId, postLedger, userStoreAccess } from '@/lib/store-engine';

/**
 * POST /api/stores/[id]/procure — DIRECT store procurement (Phase B, spec F2).
 *
 * Records a purchase INTO a store location (Liquor Store first) as a single
 * store_stock_ledger 'purchase' row. Gate: userStoreAccess(...).can_procure.
 *
 * body: {
 *   material_id, quantity (PURCHASE units, e.g. bottles),
 *   unit_price (₹ per PURCHASE unit), supplier?, vendor_id?,
 *   batch_no?, expiry_date?, invoice_ref?, notes?, date? (YYYY-MM-DD backdate)
 * }
 *
 * House unit convention (see purchases POST / updateMaterialPrice):
 *   ledger quantity  = quantity × pack_size   (RECIPE units, when recipe ≠ purchase unit)
 *   ledger unit_cost = unit_price ÷ pack_size (₹ per RECIPE unit)
 *
 * ⚠️ ISOLATION (deliberate, per spec): store purchases live ONLY in the store
 * ledger. NO `purchases` row, NO inventory_transactions, NO raw_materials
 * current_stock / average_price update — liquor must never pollute central
 * costing. Store valuation uses the ledger weighted-avg (store-engine
 * storeStock); central average_price stays whatever central flows made it.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id: storeId } = await params;
    const db = getDb();

    const store = getStoreById(db, storeId);
    if (!store) return Response.json({ error: 'Store not found' }, { status: 404 });

    const access = userStoreAccess(db, user, storeId);
    if (!access.can_procure) {
      return Response.json({ error: `You are not authorized to procure for ${store.name}` }, { status: 403 });
    }

    const b = await request.json();
    const materialId = String(b.material_id || '').trim();
    const quantity = Number(b.quantity);
    const unitPrice = Number(b.unit_price);
    if (!materialId) return Response.json({ error: 'material_id is required' }, { status: 400 });
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return Response.json({ error: 'quantity must be a positive number (purchase units)' }, { status: 400 });
    }
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      return Response.json({ error: 'unit_price must be a number ≥ 0 (₹ per purchase unit)' }, { status: 400 });
    }

    const mat = db.prepare(`
      SELECT id, name, category, unit, purchase_unit, pack_size FROM raw_materials WHERE id = ?
    `).get(materialId) as any;
    if (!mat) return Response.json({ error: 'Material not found' }, { status: 404 });

    // The material's category must be MAPPED to this store.
    if (materialStoreId(db, mat) !== storeId) {
      return Response.json({ error: `"${mat.name}" is not a ${store.name} material — its category "${mat.category}" is not mapped to this store (Settings → Store Locations)` }, { status: 400 });
    }

    let vendorId = String(b.vendor_id || '').trim();
    let supplier = String(b.supplier || '').trim();
    if (vendorId) {
      const v = db.prepare('SELECT id, name FROM vendors WHERE id = ?').get(vendorId) as any;
      if (!v) return Response.json({ error: 'Unknown vendor_id' }, { status: 400 });
      if (!supplier) supplier = v.name;
    }

    // Purchase units → recipe units (house pack-size convention).
    const packSize = Number(mat.pack_size) || 1;
    const ru = String(mat.unit || '').toLowerCase().trim();
    const pu = String(mat.purchase_unit || mat.unit || '').toLowerCase().trim();
    const packConv = (packSize > 1 && ru !== pu) ? packSize : 1;
    const recipeQty = quantity * packConv;
    const unitCost = packConv > 1 ? unitPrice / packConv : unitPrice;

    // Optional backdate: keep time-of-day so same-day ordering survives.
    const date = String(b.date || '').trim();
    const backdate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;

    let ledgerId = '';
    const txn = db.transaction(() => {
      ledgerId = postLedger(db, {
        store_id: storeId,
        material_id: materialId,
        txn_type: 'purchase',
        quantity: recipeQty,
        unit_cost: unitCost,
        batch_no: String(b.batch_no || '').trim(),
        supplier,
        vendor_id: vendorId,
        expiry_date: String(b.expiry_date || '').trim(),
        ref: String(b.invoice_ref || '').trim(),
        notes: String(b.notes || '').trim(),
        created_by: user.email,
      });
      if (backdate) {
        db.prepare(`
          UPDATE store_stock_ledger SET created_at = ? || ' ' || strftime('%H:%M:%S', 'now') WHERE id = ?
        `).run(backdate, ledgerId);
      }
    });
    txn();

    logAuditEvent(db, {
      event_type: 'store.procure',
      entity_type: 'store_stock_ledger',
      entity_id: ledgerId,
      actor_email: user.email,
      after: {
        store_id: storeId, store: store.name,
        material_id: materialId, material: mat.name,
        purchase_qty: quantity, purchase_unit: mat.purchase_unit || mat.unit,
        unit_price: unitPrice,
        recipe_qty: recipeQty, recipe_unit: mat.unit, unit_cost: unitCost,
        supplier, vendor_id: vendorId,
        batch_no: String(b.batch_no || '').trim(), expiry_date: String(b.expiry_date || '').trim(),
        invoice_ref: String(b.invoice_ref || '').trim(), date: backdate || undefined,
      },
      note: `${store.name}: +${quantity} ${mat.purchase_unit || mat.unit} ${mat.name} @ ₹${unitPrice}/${mat.purchase_unit || mat.unit}${supplier ? ` from ${supplier}` : ''}`,
    });

    return Response.json({
      ok: true, ledger_id: ledgerId,
      recipe_qty: recipeQty, unit_cost: unitCost,
      total: Math.round(quantity * unitPrice * 100) / 100,
    }, { status: 201 });
  } catch (e: any) {
    console.error('[/api/stores/[id]/procure POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
