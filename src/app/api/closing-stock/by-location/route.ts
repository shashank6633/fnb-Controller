import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { allowedDeptSetExpanded, canSeeAllDeptStock, DEPT_ITEM_SET_SQL, deptItemSetParams } from '@/lib/dept-stock';

/**
 * Materials in a specific storage location, with their current system stock
 * and today's closing count (if any). Drives the per-location count screen.
 *
 * Non-privileged users (not admin / manager / HOD / store manager) only see
 * their department's item set (materials issued to OR counted by their dept)
 * — a Tandoor cook counting a chiller must not see the whole catalogue.
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
    // Department scope for the JOIN (2026-07): the count screen writes each row
    // under a department (or '' = Store/Overall), so the read MUST match the same
    // key — otherwise today_count fans out to / shows another department's count.
    // '' / '__store__' / null all mean the Store/Overall bucket.
    const rawDept = url.searchParams.get('department_id');
    const deptMatch = (() => { const s = (rawDept == null ? '' : String(rawDept)).trim(); return s === '' || s === '__store__' ? '' : s; })();

    const isUnassigned = location === '__unassigned__' || location === '— Unassigned —';
    const where = isUnassigned
      ? `(rm.storage_location IS NULL OR TRIM(rm.storage_location) = '')`
      : `TRIM(rm.storage_location) = ?`;
    // JOIN placeholders (date, deptMatch) bind BEFORE the WHERE ones (location).
    const params: any[] = isUnassigned ? [date, deptMatch] : [date, deptMatch, location];

    // Dept item-set scope for non-privileged callers. A dept-less staff user
    // keeps the old full list (nothing sensible to intersect with).
    let deptScopeSql = '';
    const me = await getCurrentUser();
    if (me && !canSeeAllDeptStock(me)) {
      const deptSet = allowedDeptSetExpanded(db, me);
      if (deptSet.length > 0) {
        deptScopeSql = ` AND ${DEPT_ITEM_SET_SQL}`;
        params.push(...deptItemSetParams(deptSet));
      }
    }

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
            AND COALESCE(cs.department_id, '') = ?
      WHERE ${where}
        -- Store-mapped materials (liquor) are counted in their OWN store's
        -- closing (/api/stores/[id]/closing) — never on Central surfaces.
        AND NOT EXISTS (
          SELECT 1 FROM store_category_map scm
          JOIN store_locations sl ON sl.id = scm.store_id
          WHERE sl.is_active = 1 AND REPLACE(REPLACE(REPLACE(LOWER(TRIM(scm.category)),' ',''),'-',''),'_','') = REPLACE(REPLACE(REPLACE(LOWER(TRIM(rm.category)),' ',''),'-',''),'_','')
        )${deptScopeSql}
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
