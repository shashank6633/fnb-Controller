import { getDb } from '@/lib/db';
import { getCurrentUser, requireRole } from '@/lib/auth';
import { listStores, getStoreByName } from '@/lib/store-engine';

/**
 * Store Locations — the multi-store inventory engine's config surface
 * (first store: LIQUOR STORE; every future store is pure data, no code).
 *
 * GET  /api/stores                                   any signed-in user
 *   → { stores: [{ …store, categories: [{id, category}] , access?: […] }],
 *       material_categories: [distinct raw_materials categories],
 *       users?: [{id,name,email,role}] }
 *   `access` + `users` are ADMIN-ONLY payloads (user emails / grant matrix
 *   must not leak to regular staff who can read the store list).
 *
 * POST /api/stores  { name, code?, description?, requires_authorization? }
 *   → create a store location                                   admin only
 *
 * CSRF: '/api/stores' is listed in proxy.ts CSRF_REQUIRED_PREFIXES, so every
 * state-changing call here must carry the double-submit header (use api()).
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const isAdmin = me.role === 'admin';

    const stores = listStores(db).map(s => {
      const categories = db.prepare(`
        SELECT id, category FROM store_category_map
        WHERE store_id = ? ORDER BY category COLLATE NOCASE
      `).all(s.id);
      const out: any = { ...s, categories };
      if (isAdmin) {
        out.access = db.prepare(`
          SELECT a.id, a.user_id, u.name AS user_name, u.email AS user_email,
                 a.can_view, a.can_procure, a.can_adjust, a.can_close_stock
          FROM store_user_access a
          JOIN users u ON u.id = a.user_id
          WHERE a.store_id = ?
          ORDER BY u.name COLLATE NOCASE
        `).all(s.id);
      }
      return out;
    });

    // Dropdown assist for the category-mapping editor: every live category.
    const material_categories = (db.prepare(`
      SELECT DISTINCT TRIM(category) AS category FROM raw_materials
      WHERE category IS NOT NULL AND TRIM(category) != ''
      ORDER BY 1 COLLATE NOCASE
    `).all() as { category: string }[]).map(r => r.category);

    const payload: any = { stores, material_categories };
    if (isAdmin) {
      payload.users = db.prepare(`
        SELECT id, name, email, role FROM users
        WHERE is_active = 1 ORDER BY name COLLATE NOCASE
      `).all();
    }
    return Response.json(payload);
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireRole('admin');
    if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });
    const db = getDb();
    const b = await request.json();

    const name = String(b.name || '').trim();
    if (!name) return Response.json({ error: 'Store name is required' }, { status: 400 });
    if (getStoreByName(db, name)) {
      return Response.json({ error: `A store named "${name}" already exists` }, { status: 409 });
    }

    const id = db.prepare(`
      INSERT INTO store_locations (id, name, code, description, requires_authorization)
      VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)
      RETURNING id
    `).get(
      name,
      String(b.code || '').trim(),
      String(b.description || '').trim(),
      b.requires_authorization === false || b.requires_authorization === 0 ? 0 : 1,
    ) as any;

    return Response.json({ ok: true, id: id?.id }, { status: 201 });
  } catch (e: any) {
    console.error('[/api/stores POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
