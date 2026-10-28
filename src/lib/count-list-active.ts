import type Database from 'better-sqlite3';
import { deptKey, deptOnHandBulk } from './dept-ledger';

/**
 * COUNT LISTS AND A SWITCHED-OFF RAW MATERIAL (owner #6 / ruling 78)
 * ═══════════════════════════════════════════════════════════════════════════
 * "Raw material OFF = hide on NEW entries …; keep on counting/wastage/transfer
 * screens while it has stock." This file is the ONE reading of "while it has
 * stock" for the COUNT LISTS — the lists a counter walks:
 *
 *   closing-stock/overview      uncounted list + each area's item total
 *   closing-stock/dept-sheet    the Department Closing Sheet (and ./import, its
 *                               all-departments template)
 *   closing-stock/by-location   an area's count screen (+ ../locations, its
 *                               progress cards — kept identical to it)
 *   closing-stock?dept_items=1  a department's own count list (+ its search)
 *   lib/central-cutover.ts      the Central Store Cutover count sheet
 *
 * THE RULE. A switched-ON item is listed exactly as before. A switched-OFF item
 * (raw_materials.is_active = 0) is listed while the place being counted still
 * has a NON-ZERO balance of it on the books, and drops off at zero:
 *   · a CENTRAL list reads raw_materials.current_stock;
 *   · a DEPARTMENT list reads that department's own books (heldInDepts below).
 * NON-ZERO, not "above zero", on purpose: a negative book balance is exactly
 * what a count corrects, and hiding it would leave a known-wrong figure that
 * nobody can count any more. (The wastage / transfer PICKERS read "above zero"
 * — MaterialTypeahead offeredInPicker — because nothing can leave a shelf that
 * holds less than nothing. Different question, different side of zero.)
 * Each list also keeps whatever it already showed for a count SAVED on the
 * date it is showing, so a saved count never silently vanishes.
 *
 * NO SWITCHED-OFF ITEM → NO CHANGE. Every reader here first asks for the
 * switched-off ids; on a database with none it returns an empty set without
 * touching the ledger, and every list's extra SQL arm reads `rm.id IN
 * (<empty>)` — false — beside an `is_active = 1` arm that is true for every
 * row, so each list returns exactly the rows it returned before.
 *
 * READ-ONLY. Nothing here writes, and nothing here changes what a count POST
 * accepts: the count routes never refused a switched-off material, and still
 * do not.
 */

/** Below this a balance is float residue, not stock (MaterialTypeahead's
 *  STOCK_EPSILON — the same 1e-6 recipe-unit grain). */
export const COUNT_HELD_EPSILON = 1e-6;

/**
 * SQL: does the CENTRAL store still hold a non-zero balance of `alias`?
 * For the central lists' WHERE clause, e.g.
 *   `(COALESCE(rm.is_active, 1) = 1 OR ${centralHeldSql('rm')})`.
 */
export function centralHeldSql(alias: string): string {
  return `ABS(COALESCE(${alias}.current_stock, 0)) > ${COUNT_HELD_EPSILON}`;
}

/** Switched-off material ids (raw_materials.is_active = 0). Empty on a database
 *  where nothing is switched off — every caller then does what it always did. */
export function switchedOffIds(db: Database.Database): string[] {
  return (db.prepare(
    'SELECT id FROM raw_materials WHERE COALESCE(is_active, 1) = 0',
  ).all() as Array<{ id: string }>).map((r) => String(r.id));
}

/**
 * Switched-off materials with a non-zero balance on a DEPARTMENT's books.
 * `pairs` = deptKey(department, material) for each (department, material) that
 * holds one; `materials` = the material ids among them (any department). Each
 * department is read on its own, never rolled up (a parent never "holds" what
 * only its sub-department holds; a caller listing for a department SET asks
 * for every department in it).
 *
 * "The books" are the department ledger's own figure, the one the send check
 * and Department Stock read (dept-ledger.ts deptReleasable):
 *   counted / opened → deptOnHand: the latest count or cut-over opening plus
 *                      every movement since;
 *   never counted    → the all-time signed ledger total for the pair.
 * Read NOW — the switch itself has no history, so "does it still hold stock"
 * is a present-tense question on every list, whatever date the list shows.
 */
export function heldInDepts(
  db: Database.Database,
  deptIds: string[],
  offIds: string[] = switchedOffIds(db),
): { pairs: Set<string>; materials: Set<string> } {
  const pairs = new Set<string>();
  const materials = new Set<string>();
  const depts = [...new Set((deptIds || []).map((d) => String(d || '')).filter(Boolean))];
  const mats = [...new Set((offIds || []).map((m) => String(m || '')).filter(Boolean))];
  if (depts.length === 0 || mats.length === 0) return { pairs, materials };

  // Anchored balances (count / opening + movements since), same arithmetic as
  // deptOnHand, batched.
  const bal = deptOnHandBulk(db, depts, mats);
  // All-time signed ledger totals — deptReleasable's figure for a pair that was
  // never counted (rawLedgerSum, batched).
  const raw = new Map<string, number>();
  const pairOf = new Map<string, string>();
  for (const d of depts) for (const m of mats) pairOf.set(deptKey(d, m), m);
  for (const r of db.prepare(`
    SELECT department_id, material_id, COALESCE(SUM(quantity), 0) AS s
      FROM department_material_transactions
     WHERE department_id IN (SELECT value FROM json_each(?))
       AND material_id   IN (SELECT value FROM json_each(?))
     GROUP BY department_id, material_id
  `).all(JSON.stringify(depts), JSON.stringify(mats)) as Array<{ department_id: string; material_id: string; s: number }>) {
    raw.set(deptKey(String(r.department_id), String(r.material_id)), Number(r.s) || 0);
  }

  for (const k of new Set<string>([...bal.keys(), ...raw.keys()])) {
    const m = pairOf.get(k);
    if (m === undefined) continue;
    const b = bal.get(k);
    const figure = b && !b.neverCounted && b.onHand !== null ? Number(b.onHand) : (raw.get(k) ?? 0);
    if (Math.abs(Number(figure) || 0) > COUNT_HELD_EPSILON) { pairs.add(k); materials.add(m); }
  }
  return { pairs, materials };
}

/**
 * The switched-off material ids a count list keeps, for the place it counts:
 *   central  → central current_stock non-zero
 *   deptIds  → non-zero on ANY of these departments' books
 * Both may be asked at once (a list that spans the house). Returns [] at once
 * when nothing is switched off.
 */
export function switchedOffStillHeld(
  db: Database.Database,
  where: { central?: boolean; deptIds?: string[] },
): string[] {
  const off = switchedOffIds(db);
  if (off.length === 0) return [];
  const keep = new Set<string>();
  if (where.central) {
    for (const r of db.prepare(`
      SELECT rm.id FROM raw_materials rm
       WHERE COALESCE(rm.is_active, 1) = 0 AND ${centralHeldSql('rm')}
    `).all() as Array<{ id: string }>) keep.add(String(r.id));
  }
  if (where.deptIds && where.deptIds.length > 0) {
    for (const m of heldInDepts(db, where.deptIds, off).materials) keep.add(m);
  }
  return [...keep];
}

/** Every department id (active or not) — for a list that spans the house. */
export function allDeptIds(db: Database.Database): string[] {
  return (db.prepare('SELECT id FROM departments').all() as Array<{ id: string }>).map((r) => String(r.id));
}
