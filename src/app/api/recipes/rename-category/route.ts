import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';

/**
 * Rename a recipe category across every recipe that uses it. If the target name
 * already exists, the two categories MERGE (every recipe in `from` simply adopts
 * `to`). Recipe categories are a plain string on `recipes.category` — there is no
 * categories table — so a rename is a bulk UPDATE.
 *
 * Body: { from: string, to: string }
 */
export async function POST(req: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });
  try {
    const body = await req.json().catch(() => ({}));
    const from = String(body?.from ?? '').trim();
    const to = String(body?.to ?? '').trim();
    if (!from || !to) return Response.json({ error: 'Both "from" and "to" are required' }, { status: 400 });
    if (from === to) return Response.json({ updated: 0, merged: false, to });

    const db = getDb();
    const targetExisting = db.prepare(
      'SELECT COUNT(*) AS n FROM recipes WHERE is_active = 1 AND category = ?'
    ).get(to) as any;

    const res = db.prepare(
      `UPDATE recipes SET category = ?, updated_at = datetime('now') WHERE is_active = 1 AND category = ?`
    ).run(to, from);

    return Response.json({
      updated: res.changes,
      merged: (targetExisting?.n || 0) > 0,
      from,
      to,
    });
  } catch (e: any) {
    console.error('[recipes/rename-category]', e);
    return Response.json({ error: e.message || 'Rename failed' }, { status: 500 });
  }
}
