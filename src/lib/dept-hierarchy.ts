import type Database from 'better-sqlite3';
import type { SessionUser } from './auth';

/**
 * Main-department hierarchy helpers.
 *
 * Model (2026-07): three top-level "main" departments — Kitchen, Bar, Operations
 * — each with `parent_id = NULL` and a `head_user_id` (the sole approver for
 * everything under it). Every other department is a SUB-department whose
 * `parent_id` points at one of the three. Material categories are assigned on the
 * MAIN department and inherited by its sub-departments.
 *
 * Rules these helpers encode:
 *  - Item visibility  : a user sees only materials whose category is in their
 *                       MAIN dept's `material_categories` (admin + store bypass).
 *  - Requisition view : a normal user sees only their OWN requisitions; a main-
 *                       dept head sees ALL requisitions under their main dept.
 *  - Approval         : only the main-dept head (or admin) may approve a
 *                       requisition belonging to a dept under that main dept.
 */

export interface DeptRow {
  id: string;
  name: string;
  parent_id: string | null;
  head_user_id: string | null;
  material_categories: string | null;
}

const SELECT_DEPT = `SELECT id, name, parent_id, head_user_id, material_categories FROM departments WHERE id = ?`;

/** The main (top-level) department for a dept id. If it's already a main
 *  (parent_id NULL) returns it; else returns its parent. null if not found. */
export function mainDeptOf(db: Database.Database, deptId: string | null | undefined): DeptRow | null {
  if (!deptId) return null;
  const d = db.prepare(SELECT_DEPT).get(deptId) as DeptRow | undefined;
  if (!d) return null;
  if (!d.parent_id) return d;
  const parent = db.prepare(SELECT_DEPT).get(d.parent_id) as DeptRow | undefined;
  return parent || d; // orphaned sub-dept → treat itself as the main
}

/** The main dept a user governs: as a head (head_user_id === user.id) first,
 *  else via their own department_id. null when neither resolves. */
export function userMainDept(db: Database.Database, user: SessionUser | null): DeptRow | null {
  if (!user) return null;
  const asHead = db.prepare(
    `SELECT id, name, parent_id, head_user_id, material_categories FROM departments WHERE head_user_id = ? AND parent_id IS NULL LIMIT 1`,
  ).get(user.id) as DeptRow | undefined;
  if (asHead) return asHead;
  if (user.department_id) return mainDeptOf(db, user.department_id);
  return null;
}

/** True if the user is the head of the main dept that owns deptId. Admin always
 *  true (escape hatch). */
export function isMainDeptHead(db: Database.Database, user: SessionUser | null, deptId: string | null | undefined): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const main = mainDeptOf(db, deptId);
  return !!(main && main.head_user_id && main.head_user_id === user.id);
}

/** True if the user is the head of ANY main department. */
export function isAnyMainDeptHead(db: Database.Database, user: SessionUser | null): boolean {
  if (!user) return false;
  const row = db.prepare(`SELECT 1 FROM departments WHERE head_user_id = ? AND parent_id IS NULL LIMIT 1`).get(user.id);
  return !!row;
}

/** Category whitelist governing which raw materials a user may see, taken from
 *  their MAIN dept's material_categories. null = no filter (see everything). */
export function effectiveCategoriesForUser(db: Database.Database, user: SessionUser | null): string[] | null {
  if (!user) return null;
  const main = userMainDept(db, user);
  if (!main || !main.material_categories) return null;
  try {
    const arr = JSON.parse(main.material_categories);
    return Array.isArray(arr) && arr.length > 0 ? arr : null;
  } catch {
    return null;
  }
}

/** SQL filter (predicate on `requisitions r`) for which requisitions a user may
 *  see. Returns null to mean "no filter — see all". `{sql:'1=0'}` hides all
 *  (unauthenticated). */
export function requisitionVisibility(
  db: Database.Database,
  user: SessionUser | null,
): { sql: string; params: any[] } | null {
  if (!user) return { sql: '1=0', params: [] };
  // Admin and store team need the full pipeline.
  if (user.role === 'admin' || user.is_store_manager) return null;
  // Granular approvers (can_approve_requisitions, e.g. a Bar Manager) are
  // GLOBAL approvers — like the admin fallback in canApproveAsChef they may
  // approve ANY department's submitted requisition, so they must see the full
  // pipeline too (approval inbox, party approvals, bell counts). Full-HOD
  // (is_head_chef) visibility is deliberately untouched: heads keep their
  // main-dept subtree scoping below.
  if (user.can_approve_requisitions) return null;
  // A main-dept head sees every requisition under their main dept (all sub-depts).
  const head = db.prepare(
    `SELECT id FROM departments WHERE head_user_id = ? AND parent_id IS NULL LIMIT 1`,
  ).get(user.id) as { id: string } | undefined;
  if (head) {
    return {
      sql: 'r.department_id IN (SELECT id FROM departments WHERE id = ? OR parent_id = ?)',
      params: [head.id, head.id],
    };
  }
  // Advanced override: an explicitly configured cross-department viewer.
  if (user.visible_department_ids) {
    try {
      const ids = JSON.parse(user.visible_department_ids);
      if (Array.isArray(ids) && ids.length > 0) {
        return { sql: `r.department_id IN (${ids.map(() => '?').join(',')})`, params: ids };
      }
    } catch { /* fall through to own-only */ }
  }
  // Default: a normal user sees ONLY the requisitions they raised.
  // NOTE: requisitions.drafted_by stores the user's EMAIL (see the POST insert),
  // not the id — match on email.
  return { sql: 'r.drafted_by = ?', params: [user.email] };
}
