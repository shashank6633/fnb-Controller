import type Database from 'better-sqlite3';

/**
 * ROUTED REQUISITION LINES — THE SCHEMA PROBE (owner rulings #45 + #74).
 *
 * A LEAF MODULE: it imports nothing but the better-sqlite3 types, so every
 * other module (po-helpers, issue-stock, party-fulfillment, the routes, the
 * readers) can ask "does this database carry the routed columns?" without an
 * import cycle through src/lib/routed-requisitions.ts.
 *
 *   lineCol  — requisition_items carries routed_department_id, routed_at,
 *              routed_via and routed_rule_id (src/lib/db.ts).
 *   linkCols — department_transfers.requisition_id and
 *              department_transfer_lines.req_item_id + req_line_qty.
 *
 * FAIL-TO-STORE. When lineCol is false NO line is routed and every path is
 * exactly what it was before this feature: routedColSql() then returns the SQL
 * literal '' so every `... = ''` filter keeps every line and every
 * `... AS routed_dept` reads empty. scripts/desk-rule-tests.ts builds an
 * in-memory schema without the column and must keep passing unchanged.
 *
 * Cached per Database handle, POSITIVE answers only: a handle probed before
 * the boot ALTER ran (a script, a fresh harness) asks again next time instead
 * of reading "absent" forever. PRAGMA table_info is cheap.
 */

export interface RoutedSchema {
  lineCol: boolean;
  linkCols: boolean;
}

const cache = new WeakMap<object, RoutedSchema>();

function colsOf(db: Database.Database, table: string): Set<string> {
  try {
    return new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => String(c.name)),
    );
  } catch {
    return new Set();
  }
}

export function routedSchema(db: Database.Database): RoutedSchema {
  const hit = cache.get(db as unknown as object);
  if (hit) return hit;
  const ri = colsOf(db, 'requisition_items');
  const lineCol = ['routed_department_id', 'routed_at', 'routed_via', 'routed_rule_id'].every((c) => ri.has(c));
  const dt = colsOf(db, 'department_transfers');
  const dtl = colsOf(db, 'department_transfer_lines');
  const linkCols = dt.has('requisition_id') && dtl.has('req_item_id') && dtl.has('req_line_qty');
  const out = { lineCol, linkCols };
  if (lineCol && linkCols) cache.set(db as unknown as object, out);
  return out;
}

/**
 * The SQL expression for "the department a line is routed to" — '' when the
 * store serves it. `COALESCE(<alias>.routed_department_id,'')` when the column
 * exists, else the literal `''` (fail-to-store). Use it as
 *   `${routedColSql(db)} = ''`        — store-served lines only
 *   `${routedColSql(db)} AS routed_dept`
 */
export function routedColSql(db: Database.Database, alias = 'ri'): string {
  return routedSchema(db).lineCol ? `COALESCE(${alias}.routed_department_id,'')` : `''`;
}
