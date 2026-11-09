/**
 * VALET capability predicate. IMPORTS NOTHING, on purpose: page-catalog.ts is
 * bundled into client components (Sidebar, Settings → Page Access) and imports
 * this file, so a db import here would drag better-sqlite3 into the browser —
 * the same rule src/lib/feedback/access.ts lives by.
 *
 * Strict `=== true`: a 1, '1' or any truthy junk never grants. The values come
 * from getCurrentUser() / proxy.ts, which resolve them fail-closed from an
 * ASSIGNED, ACTIVE role only (role-only capabilities, like finance and HR).
 */
export type ValetNeed = 'head' | 'attendant' | 'host';

export interface ValetCapUser {
  role?: string;
  valet_head?: boolean;
  valet_attendant?: boolean;
  valet_host?: boolean;
}

/** Admin holds every valet capability. A Valet Head may also do attendant and
 *  host work (the head runs the desk when it is short-staffed). */
export function hasValetCap(user: ValetCapUser | null | undefined, need: ValetNeed): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const head = user.valet_head === true;
  if (need === 'head') return head;
  if (need === 'attendant') return head || user.valet_attendant === true;
  if (need === 'host') return head || user.valet_host === true;
  return false;
}

/** Does this user hold ANY valet capability? */
export function hasAnyValetCap(user: ValetCapUser | null | undefined): boolean {
  return hasValetCap(user, 'head') || hasValetCap(user, 'attendant') || hasValetCap(user, 'host');
}
