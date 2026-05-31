import { getDb, updateMaterialPrice, recalculateRecipeCost, recalculateSubRecipeCost } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * EMERGENCY RESTORE: recompute `raw_materials.average_price` from the
 * canonical source — `purchases.unit_price` — using the same logic as
 * `updateMaterialPrice` (rolling 30-day → 90-day → all-time → divide by
 * pack_size if purchase_unit != unit).
 *
 * Use this if a bad bulk action (like the earlier buggy normalize-prices
 * pass) left prices in the wrong scale. This is purely a recompute from
 * source-of-truth — no heuristics, no guessing.
 *
 * Items without purchase history: left alone (admin must edit manually).
 *
 * POST /api/admin/restore-prices
 * Admin only.
 */
export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (me.role !== 'admin') {
      return Response.json({ error: 'Admin only' }, { status: 403 });
    }
    const db = getDb();

    const mats = db.prepare(`SELECT id, name, average_price, pack_size, purchase_unit, unit FROM raw_materials`).all() as any[];
    const restored: any[] = [];
    const skipped_no_purchase: any[] = [];
    const unchanged: any[] = [];

    for (const m of mats) {
      const hasPurchase = db.prepare(`SELECT 1 FROM purchases WHERE material_id = ? LIMIT 1`).get(m.id);
      if (!hasPurchase) { skipped_no_purchase.push({ id: m.id, name: m.name, current: m.average_price }); continue; }

      const before = m.average_price;
      updateMaterialPrice(db, m.id);   // canonical recompute from purchases + pack_size
      const after = (db.prepare(`SELECT average_price FROM raw_materials WHERE id = ?`).get(m.id) as any)?.average_price;
      if (Math.abs((after || 0) - (before || 0)) > 0.0001) {
        restored.push({ id: m.id, name: m.name, before, after });
      } else {
        unchanged.push({ id: m.id, name: m.name });
      }
    }

    // Re-cascade recipe + sub-recipe costs
    const subRecipes = db.prepare(`SELECT id FROM sub_recipes`).all() as any[];
    for (const sr of subRecipes) recalculateSubRecipeCost(db, sr.id);
    const recipes = db.prepare(`SELECT id FROM recipes`).all() as any[];
    for (const r of recipes) recalculateRecipeCost(db, r.id);

    return Response.json({
      restored,
      unchanged_count: unchanged.length,
      skipped_no_purchase,
      summary: `Restored ${restored.length} material${restored.length === 1 ? '' : 's'} from purchases. ` +
               `${unchanged.length} unchanged. ${skipped_no_purchase.length} skipped (no purchase history — fix manually).`,
    });
  } catch (e: any) {
    console.error('[/api/admin/restore-prices]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
