import { getDb, recalculateSubRecipeCost, recalculateRecipeCost } from '@/lib/db';
import { requireRole } from '@/lib/auth';

/**
 * Recompute every sub-recipe and recipe cost from current material prices, using
 * the canonical engine in src/lib/db.ts (so there's no logic drift from a script
 * copy). Sub-recipes first (each cascades to its dependent recipes), then a full
 * recipe pass to catch any not touched by a cascade. Idempotent.
 */
export async function POST() {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });
  try {
    const db = getDb();
    const subs = db.prepare('SELECT id FROM sub_recipes WHERE is_active = 1').all() as { id: string }[];
    const recipes = db.prepare('SELECT id FROM recipes WHERE is_active = 1').all() as { id: string }[];

    const run = db.transaction(() => {
      for (const s of subs) recalculateSubRecipeCost(db, s.id);
      for (const r of recipes) recalculateRecipeCost(db, r.id);
    });
    run();

    const zeroCost = db.prepare('SELECT COUNT(*) AS n FROM recipes WHERE is_active = 1 AND total_cost = 0').get() as any;

    return Response.json({
      sub_recipes: subs.length,
      recipes: recipes.length,
      zero_cost_recipes: zeroCost?.n ?? 0,
    });
  } catch (e: any) {
    console.error('[recipes/recompute-all]', e);
    return Response.json({ error: e.message || 'Recompute failed' }, { status: 500 });
  }
}
