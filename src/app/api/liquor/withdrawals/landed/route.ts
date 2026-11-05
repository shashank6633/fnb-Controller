import { getDb } from '@/lib/db';
import { getStoreById } from '@/lib/store-engine';
import { packFactor } from '@/lib/pack-units';
import { requireWithdrawalsAdmin } from '../_lib/guard';
import { resolveLandedUnitCost, loadWithdrawalMaterial } from '@/lib/liquor-withdrawals';

/**
 * GET /api/liquor/withdrawals/landed?store_id=&material_id=&date=
 *   → { per_recipe_unit, per_bottle, source, basis, as_of }
 *
 * THE FIGURE THE SERVER WILL FREEZE, before it is frozen. The New Withdrawal
 * form used to preview "Landed value (auto)" and the 'landed' recoverable at
 * the store's AVERAGE ledger cost, while POST froze L1's landed cost (rate paid
 * on the latest indent + its levies) — so the amount billed to a named person
 * was not the amount on the screen when they agreed to it. This runs the SAME
 * resolver with the SAME arguments createWithdrawal passes when the Landed
 * ₹/bottle box is left blank (store, material, business date; no bill ref), so
 * the preview and the save can only differ if the books change in between
 * (a new indent recorded for that date, say).
 *
 * ADMIN-ONLY, like every route under /api/liquor/withdrawals and the page that
 * calls it (../_lib/guard.ts): the answer can BE the TGBCL master rate per
 * bottle for an item never indented, and the master is admin-only. Read-only —
 * writes nothing.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const gate = await requireWithdrawalsAdmin(request);
    if (!gate.ok) return gate.response;
    const db = getDb();

    const sp = new URL(request.url).searchParams;
    const storeId = String(sp.get('store_id') || '').trim();
    const materialId = String(sp.get('material_id') || '').trim();
    const date = String(sp.get('date') || '').trim();
    if (!storeId) return Response.json({ error: 'store_id is required' }, { status: 400 });
    if (!materialId) return Response.json({ error: 'material_id is required' }, { status: 400 });
    // The resolver prices "as of" the business date; a malformed one is refused
    // here rather than silently read as "no indent yet".
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Response.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 });

    if (!getStoreById(db, storeId)) return Response.json({ error: 'Store not found' }, { status: 404 });
    const mat = loadWithdrawalMaterial(db, materialId);
    if (!mat) return Response.json({ error: 'Material not found' }, { status: 404 });

    const landed = resolveLandedUnitCost(db, { storeId, materialId, mat, asOf: date });
    return Response.json({
      // Full precision, as createWithdrawal multiplies it (it rounds the VALUE
      // once, at the end) — so qty × this, rounded to the paisa, is the value
      // it will store.
      per_recipe_unit: landed.value,
      per_bottle: landed.value * (packFactor(mat) || 1),
      source: landed.source,
      basis: landed.detail,
      as_of: date,
    });
  } catch (e: any) {
    console.error('[/api/liquor/withdrawals/landed GET]', e);
    return Response.json({ error: e?.message || 'Could not resolve the landed cost' }, { status: 500 });
  }
}
