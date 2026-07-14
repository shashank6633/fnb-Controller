import { getDb } from '@/lib/db';

/**
 * Materials in a specific storage location, with their current system stock
 * and today's closing count (if any). Drives the per-location count screen.
 *
 * Query: ?location=Walk-in%20chiller&date=YYYY-MM-DD
 *        Use location=__unassigned__ for materials without a storage_location set.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const location = url.searchParams.get('location') || '';
    const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);

    const isUnassigned = location === '__unassigned__' || location === '— Unassigned —';
    const where = isUnassigned
      ? `(rm.storage_location IS NULL OR TRIM(rm.storage_location) = '')`
      : `TRIM(rm.storage_location) = ?`;
    const params = isUnassigned ? [date] : [date, location];

    const rows = db.prepare(`
      SELECT rm.id, rm.sku, rm.name, rm.unit, rm.purchase_unit, rm.pack_size,
             COALESCE(rm.case_size, 1) AS case_size,
             rm.current_stock, rm.average_price, rm.reorder_level,
             rm.super_category, rm.category, rm.closing_cadence, rm.shelf_life_days,
             cs.physical_stock AS today_count,
             cs.variance       AS today_variance,
             cs.recorded_by    AS today_by
      FROM raw_materials rm
      LEFT JOIN closing_stock cs
             ON cs.material_id = rm.id AND cs.date = ?
      WHERE ${where}
        -- Store-mapped materials (liquor) are counted in their OWN store's
        -- closing (/api/stores/[id]/closing) — never on Central surfaces.
        AND NOT EXISTS (
          SELECT 1 FROM store_category_map scm
          JOIN store_locations sl ON sl.id = scm.store_id
          WHERE sl.is_active = 1 AND TRIM(scm.category) = TRIM(rm.category) COLLATE NOCASE
        )
      ORDER BY rm.super_category, rm.category, rm.name
    `).all(...params) as any[];

    return Response.json({
      date,
      location: isUnassigned ? '— Unassigned —' : location,
      items: rows,
    });
  } catch (e: any) {
    console.error('[closing-stock/by-location]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
