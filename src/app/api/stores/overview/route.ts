import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { listStores, consolidatedStock } from '@/lib/store-engine';

/**
 * GET /api/stores/overview — the ADMIN CONSOLIDATED STOCK board (multi-floor
 * bar, Phase 1). One row per material with its qty in EVERY active store
 * (Liquor Store + each floor bar) plus grand total qty + total valuation.
 *
 * Gate: admin / manager / store-manager (is_store_manager) / HOD (is_head_chef)
 * ONLY — this board exposes cross-store valuation and every location's holding,
 * so it must not leak to floor-scoped staff. (Per-store pages keep their own
 * userStoreAccess gate; this is the roll-up view.)
 *
 * → {
 *     stores: [{ id, name, code }]  — active stores, the board's columns,
 *                                      in the same order consolidatedStock uses,
 *     rows:   [ConsolidatedStockRow + { sku, purchase_unit }]  — enriched so the
 *             page can search by SKU and render the Cases/Bottles/loose (CBL)
 *             breakdown (fmtBreakdown needs purchase_unit to label bottles).
 *             Each row also carries grocery_qty / grocery_value (central grocery
 *             backstock = raw_materials.current_stock @ average_price) straight
 *             from consolidatedStock(); already folded into total_qty/total_value,
 *             surfaced by the page as a leftmost "Grocery" location column,
 *     generated_at,
 *   }
 *
 * Valuation + qty come straight from the engine's consolidatedStock() (each
 * store's OWN weighted-avg cost, matching storeStock(); central grocery valued
 * at raw_materials.average_price); this route only adds display metadata + the
 * store column list. No writes.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const canView =
      me.role === 'admin' || me.role === 'manager' || me.is_store_manager || me.is_head_chef;
    if (!canView) {
      return Response.json(
        { error: 'The consolidated stock board is limited to admins, managers, store managers and HODs.' },
        { status: 403 },
      );
    }

    const db = getDb();

    // Column set = active stores, SAME order the engine iterates (listStores
    // filtered to active — ordered by name COLLATE NOCASE), so by_store keys
    // line up with these headers.
    const stores = listStores(db)
      .filter(s => !!s.is_active)
      .map(s => ({ id: s.id, name: s.name, code: s.code }));

    const rows = consolidatedStock(db);

    // Enrich with sku + purchase_unit (not carried by the engine row) in one
    // pass so search-by-SKU and the CBL breakdown work. Left join in-memory.
    const meta = new Map<string, { sku: string; purchase_unit: string }>();
    if (rows.length > 0) {
      const ph = rows.map(() => '?').join(',');
      for (const m of db.prepare(`
        SELECT id, COALESCE(sku, '') AS sku, purchase_unit
        FROM raw_materials WHERE id IN (${ph})
      `).all(...rows.map(r => r.material_id)) as { id: string; sku: string; purchase_unit: string | null }[]) {
        meta.set(m.id, { sku: m.sku || '', purchase_unit: m.purchase_unit || '' });
      }
    }

    const enriched = rows.map(r => {
      const m = meta.get(r.material_id);
      return {
        ...r,
        sku: m?.sku || '',
        // fall back to the recipe unit when no distinct purchase unit is set,
        // matching pack-units' packFactor (which treats unit === purchase_unit
        // as "no pack conversion").
        purchase_unit: m?.purchase_unit || r.unit,
      };
    });

    return Response.json({
      stores,
      rows: enriched,
      generated_at: new Date().toISOString(),
    });
  } catch (e: any) {
    return Response.json({ error: e?.message || 'Failed to load consolidated stock' }, { status: 500 });
  }
}
