import { getDb, logAuditEvent } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { getStoreById, materialStoreId, postLedger, userStoreAccess } from '@/lib/store-engine';

/**
 * POST /api/stores/[id]/adjust — store stock adjustment / one-time opening.
 * Gate: userStoreAccess(...).can_adjust.
 *
 * body: {
 *   material_id,
 *   quantity   — SIGNED, RECIPE units (+ found stock / − shrinkage, breakage…),
 *   reason     — REQUIRED (goes to ledger notes),
 *   txn_type?  — 'adjustment' (default) | 'opening'
 *                'opening' is the one-time opening-stock helper: allowed ONLY
 *                while the material has ZERO ledger rows in this store.
 *   unit_price? — optional ₹ per PURCHASE unit (useful on 'opening' so the
 *                 valuation has a cost basis; converted ÷pack to ₹/recipe-unit)
 * }
 *
 * Same isolation as procure: ledger-only, central inventory untouched.
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
    if (!access.can_adjust) {
      return Response.json({ error: `You are not authorized to adjust ${store.name} stock` }, { status: 403 });
    }

    const b = await request.json();
    const materialId = String(b.material_id || '').trim();
    const quantity = Number(b.quantity);
    const reason = String(b.reason || '').trim();
    const txnType = String(b.txn_type || 'adjustment').trim() as 'adjustment' | 'opening';

    if (!materialId) return Response.json({ error: 'material_id is required' }, { status: 400 });
    if (!Number.isFinite(quantity) || quantity === 0) {
      return Response.json({ error: 'quantity must be a non-zero number (signed, recipe units)' }, { status: 400 });
    }
    if (!reason) return Response.json({ error: 'reason is required' }, { status: 400 });
    if (txnType !== 'adjustment' && txnType !== 'opening') {
      return Response.json({ error: "txn_type must be 'adjustment' or 'opening'" }, { status: 400 });
    }

    const mat = db.prepare(`
      SELECT id, name, category, unit, purchase_unit, pack_size FROM raw_materials WHERE id = ?
    `).get(materialId) as any;
    if (!mat) return Response.json({ error: 'Material not found' }, { status: 404 });
    // Owned (category-mapped) OR actually held via this store's ledger — a
    // receiving FLOOR owns no categories but must be able to adjust (e.g. write
    // off a broken bottle) the stock transferred into it. 'opening' still
    // requires zero ledger history below, so it stays owner-only in practice.
    if (materialStoreId(db, mat) !== storeId) {
      const held = db.prepare('SELECT 1 FROM store_stock_ledger WHERE store_id = ? AND material_id = ? LIMIT 1').get(storeId, materialId);
      if (!held) {
        return Response.json({ error: `"${mat.name}" is not a ${store.name} material — its category "${mat.category}" is not mapped to this store (Settings → Store Locations)` }, { status: 400 });
      }
    }

    if (txnType === 'opening') {
      if (quantity < 0) return Response.json({ error: 'Opening stock must be positive' }, { status: 400 });
      const has = db.prepare(`
        SELECT 1 FROM store_stock_ledger WHERE store_id = ? AND material_id = ? LIMIT 1
      `).get(storeId, materialId);
      if (has) {
        return Response.json({ error: `"${mat.name}" already has ledger history in ${store.name} — record an adjustment instead of an opening` }, { status: 400 });
      }
    }

    // Optional cost basis, entered per PURCHASE unit → stored per RECIPE unit.
    const packSize = Number(mat.pack_size) || 1;
    const ru = String(mat.unit || '').toLowerCase().trim();
    const pu = String(mat.purchase_unit || mat.unit || '').toLowerCase().trim();
    const packConv = (packSize > 1 && ru !== pu) ? packSize : 1;
    let unitCost = 0;
    if (b.unit_price !== undefined && b.unit_price !== null && b.unit_price !== '') {
      const p = Number(b.unit_price);
      if (!Number.isFinite(p) || p < 0) {
        return Response.json({ error: 'unit_price must be a number ≥ 0 (₹ per purchase unit)' }, { status: 400 });
      }
      unitCost = packConv > 1 ? p / packConv : p;
    }

    const ledgerId = postLedger(db, {
      store_id: storeId,
      material_id: materialId,
      txn_type: txnType,
      quantity,
      unit_cost: unitCost,
      notes: reason,
      created_by: user.email,
    });

    logAuditEvent(db, {
      event_type: txnType === 'opening' ? 'store.opening' : 'store.adjust',
      entity_type: 'store_stock_ledger',
      entity_id: ledgerId,
      actor_email: user.email,
      after: {
        store_id: storeId, store: store.name,
        material_id: materialId, material: mat.name,
        quantity, recipe_unit: mat.unit, unit_cost: unitCost, reason,
      },
      note: `${store.name}: ${txnType} ${quantity > 0 ? '+' : ''}${quantity} ${mat.unit} ${mat.name} — ${reason}`,
    });

    return Response.json({ ok: true, ledger_id: ledgerId }, { status: 201 });
  } catch (e: any) {
    console.error('[/api/stores/[id]/adjust POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
