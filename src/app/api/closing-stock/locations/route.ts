import { getDb } from '@/lib/db';
import { getCurrentOutletId, getCurrentUser } from '@/lib/auth';
import { allowedDeptSetExpanded, canSeeAllDeptStock, DEPT_ITEM_SET_SQL, deptItemSetParams } from '@/lib/dept-stock';

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
    // Department scope for the JOIN (2026-07): counts are written per department,
    // so counted_today must be counted against the SAME department the client is
    // recording under — else the progress cards over-count / show other depts'.
    // '' / '__store__' / null = Store/Overall bucket.
    const rawDept = url.searchParams.get('department_id');
    const deptMatch = (() => { const s = (rawDept == null ? '' : String(rawDept)).trim(); return s === '' || s === '__store__' ? '' : s; })();

    // Dept item-set scope for non-privileged callers — same restriction as
    // /api/closing-stock/by-location, so staff location cards count only THEIR
    // items (locations with none of their items disappear entirely).
    // JOIN placeholders (date, deptMatch) bind before any WHERE dept-scope params.
    const params: any[] = [date, deptMatch];
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
      SELECT
        COALESCE(NULLIF(TRIM(rm.storage_location), ''), '— Unassigned —') AS location,
        COUNT(*) AS items,
        SUM(CASE WHEN cs.id IS NOT NULL THEN 1 ELSE 0 END) AS counted_today,
        SUM(CASE WHEN rm.current_stock < COALESCE(rm.reorder_level, 0) THEN 1 ELSE 0 END) AS low_stock
      FROM raw_materials rm
      LEFT JOIN closing_stock cs
             ON cs.material_id = rm.id AND cs.date = ?
            AND COALESCE(cs.department_id, '') = ?
      -- Store-mapped materials (liquor) are counted in their OWN store's
      -- closing (/api/stores/[id]/closing) — never on Central surfaces.
      WHERE NOT EXISTS (
        SELECT 1 FROM store_category_map scm
        JOIN store_locations sl ON sl.id = scm.store_id
        WHERE sl.is_active = 1 AND REPLACE(REPLACE(REPLACE(LOWER(TRIM(scm.category)),' ',''),'-',''),'_','') = REPLACE(REPLACE(REPLACE(LOWER(TRIM(rm.category)),' ',''),'-',''),'_','')
      )${deptScopeSql}
      GROUP BY location
      ORDER BY location
    `).all(...params) as any[];

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
