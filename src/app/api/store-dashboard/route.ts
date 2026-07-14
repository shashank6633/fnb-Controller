import { getDb } from '@/lib/db';
import { getCurrentUser, canProcessAsStore } from '@/lib/auth';

/**
 * Store-Manager dashboard — what needs buying right now.
 *
 * For every raw_material with reorder_level > 0 (i.e. buffer stock declared),
 * report whether current_stock has dropped below the buffer, plus everything
 * the procurement person needs to act on it:
 *   - suggested buy quantity (= reorder_level - current_stock, in recipe units
 *                              and in purchase-unit packs if pack_size > 1)
 *   - last vendor + last unit price + last purchase date (for ballpark cost)
 *   - estimated cost of restocking = suggest_qty × last_unit_price
 *   - severity:
 *       critical  → current_stock <= 0
 *       low       → current_stock < reorder_level
 *       ok        → otherwise (still returned only if explicitly requested)
 *   - days since last purchase (helps spot dead-stock items wrongly flagged)
 *
 * Access: admins, users flagged is_store_manager, or anyone with /store-dashboard
 * in their page_access map (proxy will already have enforced the latter). We
 * gate this API explicitly to keep cost / vendor data off non-store accounts.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canProcessAsStore(me)) {
      // Soft fallback: if page_access explicitly grants /store-dashboard, allow it.
      // (Store users can be set up without is_store_manager flag.)
      const allowed = (() => {
        if (!me.page_access) return true; // null map = full access
        try { return (JSON.parse(me.page_access) as string[]).includes('/store-dashboard'); }
        catch { return false; }
      })();
      if (!allowed) return Response.json({ error: 'Store permission required' }, { status: 403 });
    }

    const db = getDb();
    const url = new URL(request.url);
    const includeOk     = url.searchParams.get('include_ok') === '1';
    const category      = url.searchParams.get('category') || '';
    const search        = (url.searchParams.get('q') || '').toLowerCase();

    const where: string[] = ['rm.reorder_level > 0'];
    const params: any[] = [];
    if (!includeOk) where.push('rm.current_stock < rm.reorder_level');
    if (category)   { where.push('rm.category = ?'); params.push(category); }
    if (search)     { where.push('(LOWER(rm.name) LIKE ? OR LOWER(rm.sku) LIKE ?)');
                      params.push(`%${search}%`, `%${search}%`); }

    // Last-purchase lookup is correlated; we keep it as a sub-select rather than
    // pulling all of `purchases` into memory.
    const rows = db.prepare(`
      SELECT
        rm.id, rm.sku, rm.name, rm.category,
        rm.unit                          AS recipe_unit,
        COALESCE(rm.purchase_unit, rm.unit) AS purchase_unit,
        COALESCE(rm.pack_size, 1)        AS pack_size,
        COALESCE(rm.case_size, 1)        AS case_size,
        rm.current_stock,
        rm.reorder_level,
        COALESCE(rm.priority, 2)         AS priority,
        rm.average_price,
        (SELECT vendor FROM purchases WHERE material_id = rm.id
            ORDER BY date DESC, created_at DESC LIMIT 1) AS last_vendor,
        (SELECT unit_price FROM purchases WHERE material_id = rm.id
            ORDER BY date DESC, created_at DESC LIMIT 1) AS last_unit_price,
        (SELECT date FROM purchases WHERE material_id = rm.id
            ORDER BY date DESC, created_at DESC LIMIT 1) AS last_purchase_date
      FROM raw_materials rm
      WHERE ${where.join(' AND ')}
      ORDER BY
        CASE WHEN rm.current_stock <= 0 THEN 0 ELSE 1 END,
        (rm.reorder_level - rm.current_stock) DESC,
        rm.name ASC
    `).all(...params) as any[];

    const today = new Date();
    const items = rows.map(r => {
      const deficit = Math.max(0, Number(r.reorder_level) - Number(r.current_stock));
      // "Buy this much" in recipe units (kg/L/etc); also expressed in purchase units
      // when pack_size > 1 (so the store manager sees both "120 ml" and "1 BTL").
      const suggestRecipeQty = deficit;
      const suggestPurchaseQty = r.pack_size > 1 ? Math.ceil(suggestRecipeQty / r.pack_size) : suggestRecipeQty;
      const unitCost = Number(r.last_unit_price) || Number(r.average_price) || 0;
      // unit_price is per RECIPE unit (matches `quantity` stored in recipe units),
      // so estimated cost = suggestRecipeQty × unitCost.
      const estCost = suggestRecipeQty * unitCost;
      const lastDate = r.last_purchase_date ? new Date(r.last_purchase_date) : null;
      const daysSince = lastDate ? Math.floor((today.getTime() - lastDate.getTime()) / 86400000) : null;
      const severity = r.current_stock <= 0
        ? 'critical'
        : r.current_stock < r.reorder_level ? 'low' : 'ok';
      return {
        id: r.id,
        sku: r.sku,
        name: r.name,
        category: r.category,
        recipe_unit: r.recipe_unit,
        purchase_unit: r.purchase_unit,
        pack_size: r.pack_size,
        case_size: r.case_size,
        current_stock: r.current_stock,
        reorder_level: r.reorder_level,
        priority: Number(r.priority) || 2,
        deficit,
        suggest_recipe_qty: suggestRecipeQty,
        suggest_purchase_qty: suggestPurchaseQty,
        last_vendor: r.last_vendor || '',
        last_unit_price: unitCost,
        last_purchase_date: r.last_purchase_date || '',
        days_since_last_purchase: daysSince,
        est_cost: estCost,
        severity,
      };
    });

    // Aggregate cards
    const summary = {
      total: items.length,
      critical: items.filter(i => i.severity === 'critical').length,
      low:      items.filter(i => i.severity === 'low').length,
      total_est_cost: items.reduce((s, i) => s + i.est_cost, 0),
      stale_vendor_count: items.filter(i => (i.days_since_last_purchase ?? 999) > 60).length,
    };

    // Distinct categories among ALL flagged items (independent of filter so the
    // dropdown doesn't collapse when one is selected). Computed off `audit-style`
    // base query without the category filter.
    const allCats = (db.prepare(`
      SELECT DISTINCT category FROM raw_materials
      WHERE reorder_level > 0 AND current_stock < reorder_level
        AND category IS NOT NULL AND category != ''
      ORDER BY category ASC
    `).all() as any[]).map(r => r.category);

    return Response.json({ items, summary, categories: allCats });
  } catch (e: any) {
    console.error('[store-dashboard]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
