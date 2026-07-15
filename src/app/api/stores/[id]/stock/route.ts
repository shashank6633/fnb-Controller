import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { getStoreById, storeCategories, storeStock, storeItemList, userStoreAccess } from '@/lib/store-engine';

/**
 * GET /api/stores/[id]/stock — everything the store inventory page needs.
 * Gate: userStoreAccess(...).can_view (403 otherwise — use /my-access for the
 * page's 🔒 check, it never 403s).
 *
 * → {
 *     store, access,
 *     stock:   [ONE row per store material — the union of category-mapped
 *               materials (owner store) and any material with a ledger row here
 *               (so a RECEIVING floor lists what it holds/received). Zero-ledger
 *               mapped materials appear at qty 0. Enriched with purchase_unit/
 *               pack_size/case_size/reorder_level/sku + central_stock
 *               (raw_materials.current_stock), average_price and has_ledger — the
 *               page shows an "In central" hint + admin Migrate action],
 *     materials: [the store's material universe (mapped UNION ledger) — the
 *                 procure/adjust/closing typeahead source],
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

    // Base stock rows (recipe-unit qty + weighted-avg cost) from the engine.
    const base = storeStock(db, storeId);

    // Material universe for THIS store = category-mapped (owner store) UNION any
    // material with a ledger row here (so a RECEIVING floor lists exactly what it
    // has been transferred → enables per-floor closing + stock display). The
    // central Liquor Store is unaffected: its union ≈ its mapped set.
    const items = storeItemList(db, storeId);
    // Display-only columns the engine helper doesn't carry (sku / purchase_unit /
    // reorder_level / central current_stock / priority), fetched per union id.
    const extra = new Map<string, any>();
    const ids = items.map(i => i.material_id);
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      for (const x of db.prepare(`
        SELECT id, sku, purchase_unit, reorder_level, current_stock,
               COALESCE(priority, 2) AS priority
        FROM raw_materials WHERE id IN (${ph})
      `).all(...ids) as any[]) extra.set(x.id, x);
    }
    // meta = one enrichment record per union material (merges engine item meta
    // with the display-only columns above), keyed by material id.
    const meta = new Map<string, any>();
    for (const i of items) {
      const x = extra.get(i.material_id) || {};
      meta.set(i.material_id, {
        id: i.material_id, name: i.name, category: i.category, unit: i.unit,
        sku: x.sku ?? '',
        purchase_unit: x.purchase_unit || i.unit,
        pack_size: i.pack_size, case_size: i.case_size,
        reorder_level: Number(x.reorder_level) || 0,
        priority: Number(x.priority) || 2,
        current_stock: Number(x.current_stock) || 0,
        average_price: i.average_price,
      });
    }

    // ONE row per union material: ledger-backed rows keep their engine qty /
    // weighted-avg cost; mapped-but-empty (or not-yet-received) materials appear
    // at qty 0 (their valuation basis is central average_price).
    const ledgered = new Map(base.map(r => [r.material_id, r]));
    const enrich = (r: any, m: any) => ({
      ...r,
      sku: m.sku ?? r.sku ?? '',
      purchase_unit: m.purchase_unit || r.unit,
      pack_size: Number(m.pack_size) || 1,
      case_size: Number(m.case_size) || 1,
      reorder_level: Number(m.reorder_level) || 0,
      priority: Number(m.priority) || 2,
      central_stock: Number(m.current_stock) || 0,
      average_price: Number(m.average_price) || 0,
      has_ledger: ledgered.has(r.material_id),
    });
    const stock = [
      ...base.map(r => enrich(r, meta.get(r.material_id) || {})),
      ...Array.from(meta.values())
        .filter(m => !ledgered.has(m.id))
        .map(m => enrich({
          material_id: m.id,
          material_name: m.name,
          category: m.category,
          unit: m.unit,
          qty: 0,
          avg_cost: Math.round((Number(m.average_price) || 0) * 10000) / 10000,
          value: 0,
        }, m)),
    ].sort((a, b) => String(a.material_name).localeCompare(String(b.material_name)));

    // Typeahead source: the store's material universe (mapped UNION ledger),
    // already name-sorted by storeItemList. A receiving floor lists what it
    // holds; the central Liquor Store still lists its mapped categories.
    const materials = items.map(i => {
      const m = meta.get(i.material_id)!;
      return {
        id: m.id, name: m.name, sku: m.sku, category: m.category, unit: m.unit,
        purchase_unit: m.purchase_unit, pack_size: m.pack_size,
        case_size: m.case_size, reorder_level: m.reorder_level,
        average_price: m.average_price,
      };
    });

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
