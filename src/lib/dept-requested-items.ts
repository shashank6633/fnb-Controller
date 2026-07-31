import type Database from 'better-sqlite3';
import { resolveDeptSet } from './dept-stock';

/**
 * EVER-REQUESTED DEPARTMENT ITEM SET (owner requirement 4, 2026-07-31)
 * ────────────────────────────────────────────────────────────────────
 * Owner's rule, verbatim: "If a department requests the 40 items till now, only
 * those items to be shown to the departments for their closing stock updating"
 * and "once an item is requested by a department they will have that stock and
 * it will be maximum their regular stock, so it may be 1 year also — keep it as
 * their department requested that item."
 *
 * So the definition is EVER-REQUESTED, with NO recency window at all. A
 * requisition line raised eleven months ago keeps the material on that
 * department's closing sheet forever. There is deliberately no `r.date >= …`
 * clause below and there must never be one.
 *
 * WHY THIS IS NOT dept-stock.DEPT_ITEM_SET_SQL
 * --------------------------------------------
 * That fragment is "ever ISSUED (quantity_issued > 0) UNION ever counted" and
 * drives the computed dept BALANCE, where an un-issued request moves nothing.
 * The owner's rule for the closing SHEET is broader: what the department asked
 * for, whether or not the store had it that day (a line the store could not
 * fill this week is still one of the department's regular items). This set is
 * therefore a strict superset of DEPT_ITEM_SET_SQL — scoping a sheet with it
 * can never hide a row the old rule would have shown.
 *
 * EXCLUSIONS (requirement 2)
 * --------------------------
 *  - ri.is_rejected      → the head chef struck the line out.
 *  - ri.store_rejected   → the store struck the line out.
 *  - r.status IN ('cancelled','chef_rejected') → the whole requisition died.
 * A material a department only ever had REJECTED is therefore NOT "theirs",
 * exactly as asked. Same three exclusions, same spelling, as
 * dept-stock.DEPT_ITEM_SET_SQL — the two must not drift.
 *
 * WHAT IS *NOT* EXCLUDED
 * ----------------------
 *  - purpose = 'party'. DEPT_ITEM_SET_SQL drops party lines because a one-off
 *    event does not establish a running balance; here the department genuinely
 *    requested and received the item, so it belongs on their count sheet.
 *    Keeping them also preserves the superset property above.
 *  - draft / submitted requisitions. "Requested" is the owner's word; only a
 *    cancelled or rejected request is undone.
 *
 * THE closing_stock UNION
 * -----------------------
 * A material this department has ALREADY COUNTED stays on its sheet even if no
 * requisition line exists — otherwise a saved count would become invisible and
 * un-editable the next day, and anything a counter adds through the "not on
 * this list" escape hatch would vanish the moment they saved it. (Live DB
 * 2026-07-31: zero closing_stock rows carry a department_id yet, so today this
 * arm contributes nothing; it is what makes the escape hatch stick from the
 * first dept-tagged count onwards.)
 *
 * LINE OWNERSHIP
 * --------------
 * COALESCE(NULLIF(TRIM(ri.department_id),''), r.department_id) — the per-line
 * department when the line carries one, else the requisition header's. Same
 * rule as the store-issue route, department-consumption analytics and
 * dept-stock.ts, with the extra NULLIF/TRIM so a whitespace-only line value
 * cannot orphan a line (live DB: 2 NULL lines, 0 blank — the guard is cheap
 * insurance, and it can only ever widen a department's set).
 */

/**
 * SQL fragment restricting a `raw_materials rm` alias to one department set's
 * ever-requested items. Binds TWO params, both the SAME JSON array of
 * department ids — pass deptRequestedParams(deptSet).
 */
export const DEPT_REQUESTED_ITEM_SQL = `rm.id IN (
  SELECT ri.material_id
  FROM requisition_items ri
  JOIN requisitions r ON r.id = ri.req_id
  WHERE COALESCE(NULLIF(TRIM(ri.department_id), ''), r.department_id) IN (SELECT value FROM json_each(?))
    AND r.status NOT IN ('cancelled','chef_rejected')
    AND COALESCE(ri.is_rejected, 0) = 0
    AND COALESCE(ri.store_rejected, 0) = 0
  UNION
  SELECT cs.material_id
  FROM closing_stock cs
  WHERE COALESCE(cs.department_id, '') <> ''
    AND cs.department_id IN (SELECT value FROM json_each(?))
)`;

/** The two bind params DEPT_REQUESTED_ITEM_SQL expects. */
export function deptRequestedParams(deptSet: string[]): [string, string] {
  const json = JSON.stringify(deptSet);
  return [json, json];
}

/**
 * Store-mapped materials (liquor) are counted in their OWN store's closing
 * (/api/stores/[id]/closing), never on a Central closing surface. Kept
 * byte-identical to the guard in ../closing-stock/by-location and ../locations
 * so the three can never disagree about which side of the house owns a
 * material. Expects the same `rm` alias.
 */
export const NOT_STORE_MAPPED_SQL = `NOT EXISTS (
  SELECT 1 FROM store_category_map scm
  JOIN store_locations sl ON sl.id = scm.store_id
  WHERE sl.is_active = 1 AND REPLACE(REPLACE(REPLACE(LOWER(TRIM(scm.category)),' ',''),'-',''),'_','') = REPLACE(REPLACE(REPLACE(LOWER(TRIM(rm.category)),' ',''),'-',''),'_','')
)`;

/**
 * The department set a closing surface should scope to when department `deptId`
 * is SELECTED: the department itself plus, when it is a MAIN department, its
 * sub-departments (resolveDeptSet — a main-dept sheet rolls its sections up,
 * matching every other dept-scoped surface). Empty array for an unknown id.
 */
export function selectedDeptSet(db: Database.Database, deptId: string): string[] {
  return resolveDeptSet(db, deptId);
}

/** Just the material ids — used where only membership matters. */
export function deptRequestedMaterialIds(db: Database.Database, deptSet: string[]): string[] {
  if (deptSet.length === 0) return [];
  const rows = db.prepare(
    `SELECT rm.id FROM raw_materials rm WHERE ${DEPT_REQUESTED_ITEM_SQL}`,
  ).all(...deptRequestedParams(deptSet)) as { id: string }[];
  return rows.map(r => String(r.id));
}
