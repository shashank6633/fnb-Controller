import { canApproveTableOp, type SessionUser } from './auth';

/**
 * WHO MAY DOWNLOAD A COPY OF A BILL (GET /api/dine-in/orders/[id]/bill-pdf).
 * ============================================================================
 *
 * THE OWNER'S RULE (approved 2026-10-14): the Cashier role, plus managers and
 * admins, may download a settled or held bill. Plain staff are REFUSED, as they
 * were before this file existed.
 *
 * ── HOW "THE CASHIER" IS NAMED IN THIS APP ──────────────────────────────────
 * Nothing new is invented and no role is created. The Cashier is the role
 * NAMED 'Cashier' in the roles table (seeded by db.ts, base_role 'staff'),
 * assigned to a login through users.role_id and resolved by getCurrentUser()
 * into `role_name`. canApproveTableOp() (auth.ts) is the app's existing test
 * for exactly "Cashier, manager or admin":
 *
 *   role === 'admin' || role === 'manager' || role_name === 'Cashier'
 *
 * and it is production's gate on this route today. This predicate IS that
 * test, called unchanged — so the set of people who may take a copy is
 * byte-for-byte production's set. Nobody production admitted is refused, and
 * nobody production refused is admitted.
 *
 * ── WHO IS REFUSED ──────────────────────────────────────────────────────────
 *   · no session (the route answers 401 before asking);
 *   · every staff-tier login WITHOUT the Cashier role assigned, whatever its
 *     page map says: NULL (the "plain staff" the owner named — an earlier draft
 *     admitted them through canAccessPage('/cashier'), whose NULL-map
 *     navigation grant reads "no map" as "every page": btl-staff@test went
 *     production 403 → draft 200), empty, ["/requisitions"], and also an
 *     explicit ["/cashier"]. A page grant is not the Cashier role; only the
 *     role is.
 *
 * The owner's lever lives in Settings → Roles: assign the Cashier role and the
 * copy opens; take it away and it closes. This file assigns nothing.
 *
 * ── WHAT THIS DOES NOT DECIDE ───────────────────────────────────────────────
 * "May this person take a copy of a bill" — never "which bills". The route
 * looks the bill up by id alone, as production always has; it adds no outlet
 * scope, because the approval did not name one.
 *
 * WHY A FILE OF ITS OWN when the answer is canApproveTableOp(): that predicate
 * also gates money and authority decisions (service-charge waiver, discount
 * approval, table transfer/merge, discount requests). The read-only copy is a
 * different question that happens to have the same answer today; naming it
 * here means a future change to either is a visible, deliberate edit.
 *
 * NOTE ON NAMING: no URL path in this app may contain the substring "print" —
 * proxy.ts makes such a path publicly unauthenticated. This is a lib module,
 * never a route, and the endpoint's path is unchanged.
 */

/**
 * May this user download a copy of a bill? Cashier role, manager or admin.
 * Returns false for a null session so a caller can answer 401/403 from the
 * same single test.
 */
export function canDownloadBillCopy(me: SessionUser | null): boolean {
  if (!me || !me.id) return false;
  return canApproveTableOp(me);
}

/** The 403 sentence — production's wording, unchanged. */
export const BILL_COPY_REFUSED_MESSAGE = 'Cashier, manager or admin required';
