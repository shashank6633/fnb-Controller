import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * List distinct raw_materials.category values currently in the catalog,
 * with material counts. Used by /departments to populate the material-
 * category whitelist checkboxes.
 *
 * GET /api/inventory/categories
 *   → { categories: [{ category: 'vegetables', count: 47 }, ...] }
 *
 * Admin-only (this drives the dept management UI).
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
    `).all();
    return Response.json({ categories: rows });
  } catch (e: any) {
    console.error('[/api/inventory/categories]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
