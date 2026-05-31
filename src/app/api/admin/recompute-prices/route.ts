import { getDb, updateMaterialPrice, recalculateRecipeCost, recalculateSubRecipeCost, logAuditEvent } from '@/lib/db';
import { requireRole } from '@/lib/auth';

/**
 * One-shot: re-run updateMaterialPrice on every material so the new
 * rolling-90-day weighted average takes effect across the catalog at once.
 * Recipe + sub-recipe costs cascade automatically.
 *
 * Admin only. Idempotent — safe to re-run.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST() {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });

  const db = getDb();
  // 1. Refresh weighted-avg material prices (rolling 90d, ÷ pack_size)
  const mats = db.prepare(`SELECT id FROM raw_materials`).all() as any[];
  let matsRecomputed = 0;
  for (const m of mats) { updateMaterialPrice(db, m.id); matsRecomputed++; }
  // 2. Force a recipe cost recompute so the stored total_cost + food_cost_percent
  //    on the recipes table matches the live calculator. Without this step, the
  //    /recipes cards keep showing old totals from before the price refresh.
  const subs = db.prepare(`SELECT id FROM sub_recipes`).all() as any[];
  let subsRecomputed = 0;
  for (const s of subs) { recalculateSubRecipeCost(db, s.id); subsRecomputed++; }
  const recipes = db.prepare(`SELECT id FROM recipes`).all() as any[];
  let recipesRecomputed = 0;
  for (const r of recipes) { recalculateRecipeCost(db, r.id); recipesRecomputed++; }
  logAuditEvent(db, {
    event_type: 'prices.recompute',
    entity_type: 'system',
    entity_id: 'all',
    actor_email: auth.user.email,
    after: { materials: matsRecomputed, sub_recipes: subsRecomputed, recipes: recipesRecomputed },
    note: 'Bulk price + recipe-cost recompute',
  });
  return Response.json({
    success: true,
    materials: matsRecomputed,
    sub_recipes: subsRecomputed,
    recipes: recipesRecomputed,
  });
}
