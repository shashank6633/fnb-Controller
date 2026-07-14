import { getDb } from '@/lib/db';
import { getCurrentOutletId } from '@/lib/auth';

/**
 * Storage-location summary for the EOD count workflow.
 * Returns each distinct storage_location with item count + how many already
 * have a closing-stock entry today. Lets the counter pick a physical area
 * (e.g. "Walk-in chiller", "Bar back-bar", "Dry store rack 3") and tick
 * through it without scrolling the entire material list.
 *
 * Query: ?date=YYYY-MM-DD (default: today)
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
    const outletId = await getCurrentOutletId();

    const rows = db.prepare(`
      SELECT
        COALESCE(NULLIF(TRIM(rm.storage_location), ''), '— Unassigned —') AS location,
        COUNT(*) AS items,
        SUM(CASE WHEN cs.id IS NOT NULL THEN 1 ELSE 0 END) AS counted_today,
        SUM(CASE WHEN rm.current_stock < COALESCE(rm.reorder_level, 0) THEN 1 ELSE 0 END) AS low_stock
      FROM raw_materials rm
      LEFT JOIN closing_stock cs
             ON cs.material_id = rm.id AND cs.date = ?
      -- Store-mapped materials (liquor) are counted in their OWN store's
      -- closing (/api/stores/[id]/closing) — never on Central surfaces.
      WHERE NOT EXISTS (
        SELECT 1 FROM store_category_map scm
        JOIN store_locations sl ON sl.id = scm.store_id
        WHERE sl.is_active = 1 AND TRIM(scm.category) = TRIM(rm.category) COLLATE NOCASE
      )
      GROUP BY location
      ORDER BY location
    `).all(date) as any[];

    const totals = {
      locations: rows.length,
      items: rows.reduce((s, r) => s + r.items, 0),
      counted: rows.reduce((s, r) => s + (r.counted_today || 0), 0),
    };

    return Response.json({ date, totals, locations: rows });
  } catch (e: any) {
    console.error('[closing-stock/locations]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
