import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * One-click repair: clamp any NEGATIVE raw-material current_stock to 0.
 *
 * Negative physical stock is impossible — it happens only when stock-in records
 * (purchases / opening stock) are removed while the consumption that drew them
 * down remains (e.g. an Admin Reset that reverses purchase quantities). That
 * makes Total Stock Value show a large negative number. This sets those rows to
 * 0 so the value is sane again. It is a STOPGAP — do a physical count afterwards
 * (Opening/Closing Stock) to enter the true on-hand, or re-import the purchases.
 *
 * Admin only. POST. Returns how many rows were fixed + the value cleared.
 */
export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (me.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });

    const db = getDb();

    // Snapshot the damage before fixing (for an honest before/after summary).
    const before = db.prepare(`
      SELECT COUNT(*) AS neg_items,
             COALESCE(SUM(current_stock * average_price), 0) AS neg_value
      FROM raw_materials WHERE is_active = 1 AND current_stock < 0
    `).get() as any;

    const res = db.prepare(`
      UPDATE raw_materials
      SET current_stock = 0, updated_at = datetime('now')
      WHERE current_stock < 0
    `).run();

    const after = db.prepare(`
      SELECT COALESCE(SUM(current_stock * average_price), 0) AS total_value
      FROM raw_materials WHERE is_active = 1
    `).get() as any;

    return Response.json({
      success: true,
      items_fixed: res.changes,
      negative_value_cleared: Math.round((before?.neg_value || 0) * 100) / 100,
      total_stock_value_after: Math.round((after?.total_value || 0) * 100) / 100,
      summary: `Reset ${res.changes} item${res.changes === 1 ? '' : 's'} with negative stock to 0. `
        + `Do a physical count (Opening/Closing Stock) to enter the real on-hand.`,
    });
  } catch (e: any) {
    console.error('[/api/inventory/fix-negative-stock]', e);
    return Response.json({ error: e?.message || 'Failed to fix negative stock' }, { status: 500 });
  }
}
