import { getDb, updateMaterialPrice, recalculateRecipeCost, recalculateSubRecipeCost } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Normalize `raw_materials.average_price` for materials whose stored value is
 * per purchase-unit instead of per recipe-unit. Re-cascades recipe + sub-recipe
 * costs after.
 *
 * THE PROBLEM:
 *   The schema assumes `average_price` is per `material.unit` (the recipe unit,
 *   e.g. ₹/g for an item bought in kg). `updateMaterialPrice` enforces this by
 *   dividing the per-purchase-unit price by `pack_size` when `pack_size > 1`
 *   and `purchase_unit != unit`. But materials without any purchase history
 *   (CSV-imported, manually entered, bar-import) can end up with the raw
 *   per-purchase-unit value stored — leading to recipe costs being inflated
 *   by `pack_size` (e.g. ₹42,661 instead of ₹42.66 for a 120 g ingredient).
 *
 * THE FIX (idempotent, safe to re-run):
 *   For every material with pack_size > 1 AND purchase_unit != unit:
 *     1. If purchase history exists → call updateMaterialPrice (already handles
 *        pack-size division correctly).
 *     2. If no purchase history AND average_price > 0 → assume the stored value
 *        is per-purchase-unit (legacy bug) and divide by pack_size.
 *
 * After all materials are normalized, re-cascade recipe + sub-recipe costs
 * so downstream `recipe.total_cost` reflects the corrected per-unit prices.
 *
 * POST /api/admin/normalize-prices
 * Returns: { normalized: [...], skipped: [...] }
 *
 * Admin / head chef / store manager only.
 */
export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (me.role !== 'admin' && !me.is_head_chef && !me.is_store_manager) {
      return Response.json({ error: 'Admin / head chef / store manager only' }, { status: 403 });
    }
    const db = getDb();

    const candidates = db.prepare(`
      SELECT id, name, unit, purchase_unit, pack_size, average_price
      FROM raw_materials
      WHERE pack_size > 1
        AND purchase_unit IS NOT NULL AND purchase_unit != ''
        AND LOWER(purchase_unit) != LOWER(unit)
    `).all() as any[];

    const normalized: any[] = [];
    const skipped: any[] = [];

    for (const m of candidates) {
      // Does this material have any purchase history?
      const hasPurchase = db.prepare(`SELECT 1 FROM purchases WHERE material_id = ? LIMIT 1`).get(m.id);

      if (hasPurchase) {
        // updateMaterialPrice already handles correct normalization from purchases
        const before = m.average_price;
        updateMaterialPrice(db, m.id);
        const after = (db.prepare(`SELECT average_price FROM raw_materials WHERE id = ?`).get(m.id) as any)?.average_price;
        if (Math.abs((after || 0) - (before || 0)) > 0.0001) {
          normalized.push({ id: m.id, name: m.name, before, after, source: 'recomputed_from_purchases' });
        } else {
          skipped.push({ id: m.id, name: m.name, reason: 'already_normalized' });
        }
      } else if (m.average_price > 0) {
        // No purchases — assume stored value is per-purchase-unit. Divide by pack_size.
        const newPrice = m.average_price / m.pack_size;
        db.prepare(`UPDATE raw_materials SET average_price = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(Math.round(newPrice * 10000) / 10000, m.id);
        normalized.push({
          id: m.id, name: m.name,
          before: m.average_price, after: Math.round(newPrice * 10000) / 10000,
          source: 'divided_by_pack_size',
          note: `Assumed per-${m.purchase_unit}, divided by pack_size=${m.pack_size} → per-${m.unit}`,
        });
      } else {
        skipped.push({ id: m.id, name: m.name, reason: 'zero_price' });
      }
    }

    // Cascade recipe + sub-recipe cost recalc so recipe.total_cost is corrected
    const subRecipes = db.prepare(`SELECT id FROM sub_recipes`).all() as any[];
    for (const sr of subRecipes) recalculateSubRecipeCost(db, sr.id);
    const recipes = db.prepare(`SELECT id FROM recipes`).all() as any[];
    for (const r of recipes) recalculateRecipeCost(db, r.id);

    return Response.json({
      normalized,
      skipped,
      summary: `Normalized ${normalized.length} material${normalized.length === 1 ? '' : 's'}. Skipped ${skipped.length}.` +
               ` Re-cascaded ${subRecipes.length} sub-recipe cost${subRecipes.length === 1 ? '' : 's'} and ${recipes.length} recipe cost${recipes.length === 1 ? '' : 's'}.`,
    });
  } catch (e: any) {
    console.error('[/api/admin/normalize-prices]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
