import { getDb } from '@/lib/db';
import { getCurrentOutletId } from '@/lib/auth';

/**
 * Daily-Tracked Items widget — Phase 1 §6 EOD ritual support.
 * Returns materials configured with closing_cadence='daily' (or 'weekly' optionally),
 * with their current stock + whether they have a closing-stock count for today.
 *
 * Query: ?cadence=daily|weekly|monthly  (default: daily)
 *        ?date=YYYY-MM-DD               (default: today)
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const cadence = url.searchParams.get('cadence') || 'daily';
    const date    = url.searchParams.get('date') || new Date().toISOString().slice(0,10);
    const outletId = await getCurrentOutletId();

    // Last-90-day consumption rate per material to compute days-of-stock heuristic
    const ninety = (() => { const d = new Date(date); d.setDate(d.getDate() - 90); return d.toISOString().slice(0,10); })();

    const rows = db.prepare(`
      SELECT rm.id, rm.sku, rm.name, rm.unit, rm.purchase_unit, rm.pack_size, rm.case_size,
             rm.current_stock, rm.average_price, rm.reorder_level,
             rm.super_category, rm.category, rm.storage_location,
             COALESCE((SELECT SUM(ABS(it.quantity)) FROM inventory_transactions it
                       WHERE it.material_id = rm.id
                         AND it.type IN ('sale','party','staff_meal','wastage')
                         AND DATE(it.created_at) >= ?), 0) AS consumed_90d,
             (SELECT cs.physical_stock FROM closing_stock cs
              WHERE cs.material_id = rm.id AND cs.date = ?
                AND (? = '' OR cs.outlet_id = ? OR cs.outlet_id IS NULL)
              LIMIT 1) AS today_count,
             (SELECT MAX(cs.date) FROM closing_stock cs WHERE cs.material_id = rm.id) AS last_count_date
      FROM raw_materials rm
      WHERE LOWER(rm.closing_cadence) = LOWER(?)
      ORDER BY rm.super_category, rm.category, rm.name
    `).all(ninety, date, outletId || '', outletId || '', cadence) as any[];

    // Enrich each row with daily-rate + days-of-stock + counted-today flag.
    for (const r of rows) {
      const dailyRate = (r.consumed_90d || 0) / 90;     // recipe units per day
      r.daily_consumption_rate = Math.round(dailyRate * 100) / 100;
      r.days_of_stock = dailyRate > 0 ? Math.round((r.current_stock / dailyRate) * 10) / 10 : null;
      r.counted_today = r.today_count != null;
    }

    const summary = {
      total: rows.length,
      counted: rows.filter(r => r.counted_today).length,
      pending: rows.filter(r => !r.counted_today).length,
      low_stock: rows.filter(r => r.current_stock < (r.reorder_level || 0)).length,
    };

    return Response.json({ date, cadence, summary, items: rows });
  } catch (e: any) {
    console.error('[daily-tracked]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
