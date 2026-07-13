import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { getStoreById, storeCategories, storeStock, userStoreAccess } from '@/lib/store-engine';

/**
 * GET /api/stores/[id]/stock — everything the store inventory page needs.
 * Gate: userStoreAccess(...).can_view (403 otherwise — use /my-access for the
 * page's 🔒 check, it never 403s).
 *
 * → {
 *     store, access,
 *     stock:   [storeStock row + purchase_unit/pack_size/reorder_level/sku],
 *     materials: [all materials whose category is mapped to this store — the
 *                 procure/adjust typeahead source],
 *     categories: [mapped category names],
 *     recent_suppliers: [latest distinct ledger suppliers],
 *     vendors: [{id,name}] active vendor master for the optional vendor select,
 *   }
 */
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id: storeId } = await params;
    const db = getDb();

    const store = getStoreById(db, storeId);
    if (!store) return Response.json({ error: 'Store not found' }, { status: 404 });

    const access = userStoreAccess(db, user, storeId);
    if (!access.can_view) {
      return Response.json({ error: `You are not authorized to view ${store.name}` }, { status: 403 });
    }

    // Base stock rows (recipe-unit qty + weighted-avg cost) from the engine,
    // enriched with the display fields the page needs (pack conversion, low-stock).
    const base = storeStock(db, storeId);
    const meta = new Map<string, any>();
    for (const m of db.prepare(`
      SELECT rm.id, rm.sku, rm.purchase_unit, rm.pack_size, rm.reorder_level
      FROM raw_materials rm
      JOIN store_category_map scm
        ON scm.store_id = ? AND TRIM(scm.category) = TRIM(rm.category) COLLATE NOCASE
    `).all(storeId) as any[]) meta.set(m.id, m);
    const stock = base.map(r => {
      const m = meta.get(r.material_id) || {};
      return {
        ...r,
        sku: m.sku || '',
        purchase_unit: m.purchase_unit || r.unit,
        pack_size: Number(m.pack_size) || 1,
        reorder_level: Number(m.reorder_level) || 0,
      };
    });

    // Typeahead source: every material in a mapped category (active stores only
    // claim categories — this store was found by id, so filter on its own map).
    const materials = db.prepare(`
      SELECT rm.id, rm.name, rm.sku, rm.category, rm.unit, rm.purchase_unit,
             rm.pack_size, rm.reorder_level, rm.average_price
      FROM raw_materials rm
      JOIN store_category_map scm
        ON scm.store_id = ? AND TRIM(scm.category) = TRIM(rm.category) COLLATE NOCASE
      ORDER BY rm.name COLLATE NOCASE
    `).all(storeId) as any[];

    const recent_suppliers = (db.prepare(`
      SELECT supplier FROM store_stock_ledger
      WHERE store_id = ? AND TRIM(supplier) != ''
      GROUP BY supplier ORDER BY MAX(created_at) DESC LIMIT 20
    `).all(storeId) as any[]).map(r => r.supplier);

    const vendors = db.prepare(`
      SELECT id, name FROM vendors WHERE is_active = 1 ORDER BY name COLLATE NOCASE
    `).all();

    return Response.json({
      store, access, stock, materials,
      categories: storeCategories(db, storeId),
      recent_suppliers, vendors,
    });
  } catch (e: any) {
    console.error('[/api/stores/[id]/stock GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
