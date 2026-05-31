import { getDb } from '@/lib/db';

/**
 * Approval Context for a Purchase Order.
 *
 * For every line item the admin/approver gets:
 *   - last_purchases  : 2 most-recent purchase rows (date, vendor, qty, unit_price)
 *   - current_stock   : as-of-now in raw_materials
 *   - last_purchase_price + last_purchase_date (cached on raw_materials)
 *   - usage_30d / usage_60d / usage_90d : units consumed (sum of negative inventory_transactions)
 *   - avg_daily_usage_30d : usage_30d / 30
 *   - days_of_stock      : current_stock / avg_daily_usage_30d (Infinity if no usage)
 *   - days_since_last_purchase
 *   - flags : array of warnings the UI should highlight
 *       'over_order'        — requested_qty + current_stock > 90 days of usage
 *       'recent_purchase'   — last purchase < 7 days ago
 *       'price_jump'        — requested unit_price > 1.10 × avg_purchase_price
 *       'overstock'         — current_stock alone covers > 60 days
 *
 * The aim is to let the admin spot stockpiling / panic ordering at a glance.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = getDb();

    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id) as any;
    if (!po) return Response.json({ error: 'Not found' }, { status: 404 });

    const items = db.prepare(`
      SELECT poi.*, rm.name AS material_name, rm.sku AS material_sku, rm.unit AS material_unit,
             rm.current_stock, rm.last_purchase_price, rm.last_purchase_date, rm.average_price
      FROM purchase_order_items poi
      JOIN raw_materials rm ON rm.id = poi.material_id
      WHERE poi.po_id = ?
    `).all(id) as any[];

    const lastPurchasesStmt = db.prepare(`
      SELECT date, vendor, quantity, unit_price, total_price
      FROM purchases
      WHERE material_id = ?
      ORDER BY date DESC, created_at DESC
      LIMIT 2
    `);

    const usageStmt = db.prepare(`
      SELECT COALESCE(SUM(-quantity), 0) AS used
      FROM inventory_transactions
      WHERE material_id = ?
        AND quantity < 0                                       -- consumption only
        AND date(created_at) >= date('now', ?)
    `);

    const enriched = items.map((it) => {
      const lastPurchases = lastPurchasesStmt.all(it.material_id) as any[];
      const u30 = (usageStmt.get(it.material_id, '-30 days') as any).used || 0;
      const u60 = (usageStmt.get(it.material_id, '-60 days') as any).used || 0;
      const u90 = (usageStmt.get(it.material_id, '-90 days') as any).used || 0;
      const avgDaily = u30 / 30;
      const daysOfStock = avgDaily > 0 ? it.current_stock / avgDaily : null;

      let daysSinceLast: number | null = null;
      if (it.last_purchase_date) {
        const ms = Date.now() - new Date(it.last_purchase_date).getTime();
        daysSinceLast = Math.floor(ms / 86400000);
      }

      const flags: string[] = [];
      // 1. Over-ordering: requested qty + current_stock > 90d of consumption
      const requestedQty = Number(it.quantity) || 0;
      if (u90 > 0 && (requestedQty + it.current_stock) > u90) flags.push('over_order');
      // 2. Recent purchase (< 7 days)
      if (daysSinceLast != null && daysSinceLast < 7) flags.push('recent_purchase');
      // 3. Price jump
      if (it.average_price > 0 && Number(it.unit_price) > it.average_price * 1.10) flags.push('price_jump');
      // 4. Already overstocked: current_stock alone covers > 60 days
      if (avgDaily > 0 && it.current_stock > avgDaily * 60) flags.push('overstock');
      // 5. Never sold (no usage history at all but stock exists)
      if (u90 === 0 && it.current_stock > 0) flags.push('no_recent_usage');

      return {
        po_item_id: it.id,
        material_id: it.material_id,
        material_name: it.material_name,
        material_sku: it.material_sku,
        material_unit: it.material_unit,
        requested_qty: requestedQty,
        requested_unit_price: Number(it.unit_price) || 0,
        requested_total: Number(it.total_price) || 0,
        current_stock: it.current_stock,
        average_price: it.average_price,
        last_purchase_price: it.last_purchase_price,
        last_purchase_date: it.last_purchase_date,
        days_since_last_purchase: daysSinceLast,
        last_purchases: lastPurchases,
        usage_30d: u30,
        usage_60d: u60,
        usage_90d: u90,
        avg_daily_usage_30d: avgDaily,
        days_of_stock: daysOfStock,
        flags,
      };
    });

    return Response.json({
      po: {
        id: po.id, po_number: po.po_number, date: po.date,
        vendor: po.vendor, vendor_id: po.vendor_id, total_cost: po.total_cost,
        status: po.status, item_count: items.length,
      },
      items: enriched,
      summary: {
        total_flags: enriched.reduce((s, i) => s + i.flags.length, 0),
        over_order_count:    enriched.filter(i => i.flags.includes('over_order')).length,
        recent_purchase_count: enriched.filter(i => i.flags.includes('recent_purchase')).length,
        price_jump_count:    enriched.filter(i => i.flags.includes('price_jump')).length,
        overstock_count:     enriched.filter(i => i.flags.includes('overstock')).length,
        no_recent_usage_count: enriched.filter(i => i.flags.includes('no_recent_usage')).length,
      },
    });
  } catch (e: any) {
    console.error('[approval-context]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
