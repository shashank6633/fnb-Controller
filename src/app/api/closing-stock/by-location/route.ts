import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { allowedDeptSetExpanded, canSeeAllDeptStock } from '@/lib/dept-stock';
import { DEPT_REQUESTED_ITEM_SQL, deptRequestedParams, selectedDeptSet } from '@/lib/dept-requested-items';

/**
 * Materials in a specific storage location, with their current system stock
 * and today's closing count (if any). Drives the per-location count screen.
 *
 * Non-privileged users (not admin / manager / HOD / store manager) only see
 * their department's item set (materials their dept ever REQUISITIONED, or has
 * already counted) — a Tandoor cook counting a chiller must not see the whole
 * catalogue.
 *
 * And whenever a department is SELECTED (department_id), the list is scoped to
 * that department's ever-requested items for EVERY tier, admins included —
 * owner requirement 4. department_id '' / '__store__' = Store / Overall, which
 * is not department-scoped and lists the whole area exactly as it always has.
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

    // VIEWER floor — the departments this person may see at all. A dept-less
    // staff user keeps the old full list (nothing sensible to intersect with).
    //
    // The ITEM definition here moved from dept-stock.DEPT_ITEM_SET_SQL (ever
    // ISSUED) to the owner's ever-REQUESTED rule (2026-07-31), so the floor can
    // never clip an item off the department's own sheet: a Bakery counter was
    // shown 71 of Bakery's 75 items because 4 were requested but never issued.
    // The requested set is a strict superset of the issued one (an issue
    // implies a requisition line, and this version also keeps party lines), so
    // this only ever widens — nothing that used to be countable disappears —
    // and the department bound itself is unchanged.
    let deptScopeSql = '';
    const me = await getCurrentUser();
    if (me && !canSeeAllDeptStock(me)) {
      const deptSet = allowedDeptSetExpanded(db, me);
      if (deptSet.length > 0) {
        deptScopeSql = ` AND ${DEPT_REQUESTED_ITEM_SQL}`;
        params.push(...deptRequestedParams(deptSet));
      }
    }

    /* SELECTED-department scope (owner requirement 4, 2026-07-31): when a
       department is chosen, this area lists only the materials THAT department
       has ever requisitioned — for every tier, admins included, because the
       question being answered is "what does this department count?", not "what
       is this user allowed to see". Store / Overall (deptMatch '') is
       deliberately untouched: it still lists the whole area.
       Appended AFTER the viewer floor above so SQL and params stay in step. */
    if (deptMatch) {
      const selSet = selectedDeptSet(db, deptMatch);
      if (selSet.length > 0) {
        deptScopeSql += ` AND ${DEPT_REQUESTED_ITEM_SQL}`;
        params.push(...deptRequestedParams(selSet));
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

    // Blind count: only admins may see the system stock + variance. For everyone
    // else strip both server-side so the expected number never reaches the browser
    // (a counter must not be able to just type back the system figure).
    const items = (me?.role === 'admin')
      ? rows
      : rows.map(r => ({ ...r, current_stock: null, today_variance: null }));

    return Response.json({
      date,
      location: isUnassigned ? '— Unassigned —' : location,
      items,
    });
  } catch (e: any) {
    console.error('[closing-stock/by-location]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
