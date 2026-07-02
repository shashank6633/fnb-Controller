import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { effectiveCategoriesForUser } from '@/lib/dept-hierarchy';

/**
 * List distinct raw_materials.category values currently in the catalog,
 * with material counts. Drives the /departments whitelist checkboxes.
 *
 * GET /api/inventory/categories
 *   → { categories: [{ category: 'vegetables', count: 47 }, ...] }
 *
 * Admin + store see EVERY category (they configure the whitelists / buy for all).
 * A department user only ever gets the categories of their OWN main department —
 * so even a direct call can't enumerate categories outside their scope.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const rows = db.prepare(`
      SELECT COALESCE(NULLIF(category, ''), 'other') AS category, COUNT(*) AS count
      FROM raw_materials
      GROUP BY COALESCE(NULLIF(category, ''), 'other')
      ORDER BY category ASC
    `).all() as { category: string; count: number }[];
    // Department-scope non-privileged users to their own main-dept categories.
    if (me.role !== 'admin' && !me.is_store_manager) {
      const wl = effectiveCategoriesForUser(db, me);
      if (wl) {
        const allow = new Set(wl);
        return Response.json({ categories: rows.filter((r) => allow.has(r.category)) });
      }
    }
    return Response.json({ categories: rows });
  } catch (e: any) {
    console.error('[/api/inventory/categories]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
