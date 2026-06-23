import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { categorizeRecipeName } from '@/lib/recipe-workbook';

/**
 * Backfill recipe categories from recipe names for any active recipe whose
 * category is currently blank. Never overwrites a category a user already set.
 * Body (optional): { overwriteAll?: boolean } to re-classify every recipe.
 */
export async function POST(req: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });
  try {
    const body = await req.json().catch(() => ({}));
    const overwriteAll = !!body?.overwriteAll;

    const db = getDb();
    const recipes = db.prepare('SELECT id, name, category FROM recipes WHERE is_active = 1').all() as any[];
    const update = db.prepare(`UPDATE recipes SET category = ?, updated_at = datetime('now') WHERE id = ?`);

    let updated = 0;
    const distribution: Record<string, number> = {};
    const run = db.transaction(() => {
      for (const r of recipes) {
        const blank = !r.category || !String(r.category).trim();
        if (!overwriteAll && !blank) continue;
        const cat = categorizeRecipeName(r.name);
        update.run(cat, r.id);
        distribution[cat] = (distribution[cat] || 0) + 1;
        updated++;
      }
    });
    run();

    return Response.json({ updated, total: recipes.length, distribution });
  } catch (e: any) {
    console.error('[recipes/auto-categorize]', e);
    return Response.json({ error: e.message || 'Auto-categorize failed' }, { status: 500 });
  }
}
