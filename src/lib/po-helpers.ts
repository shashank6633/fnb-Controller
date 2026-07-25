import { getDb } from '@/lib/db';
import { getCurrentUser, isManagement } from '@/lib/auth';

/**
 * Shared Purchase Order helpers.
 *
 * Moved out of /api/purchase-orders/route.ts: Next.js route modules may only
 * export HTTP handlers (GET/POST/…), so the helpers shared with the
 * [id]/submit|approve|receive|reject action routes live here instead of being
 * re-exported from the route file (which fails route-module type validation).
 */

/** Role of the CURRENT SESSION, or null when there is no valid session.
 *  SECURITY: never falls back to a privileged role. The old settings-based
 *  `current_role` fallback meant a forged/expired cookie was treated as admin
 *  on every PO money/stock action — removed. Callers MUST 401 on null.
 *  Collapses 'staff' → 'manager' for the legacy two-tier PO callers. */
export async function effectiveRole(): Promise<'admin' | 'manager' | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  return user.role === 'admin' ? 'admin' : 'manager';
}
/** Back-compat shim for callers that used the old sync currentRole(db): now
 *  session-based and nullable. */
export async function currentRole(): Promise<'admin' | 'manager' | null> {
  return effectiveRole();
}

/** Gate every PO WRITE action (create / edit / delete / submit / receive /
 *  revise) with this. 'anon' → 401, 'denied' → 403, 'ok' → proceed.
 *  WHY IT EXISTS: those routes are documented "Manager OR Admin" but test
 *  `if (!(await effectiveRole()))` — and effectiveRole()/currentRole() collapse
 *  staff into 'manager' (above), so that test only asserts "has a session", not
 *  a tier. A truthiness check on effectiveRole/currentRole is never a tier check.
 *  NOT for approve/reject: those are intentionally stricter (admin-only).
 *  MEMBERSHIP: management (admin, any manager, or a HOD — the same isManagement()
 *  that gates the rest of the app's management-only surfaces) PLUS the store
 *  manager flag. That is the set /api/crm/reorder/route.ts:28 already calls "the
 *  people who raise POs today", and is_store_manager is independent of tier
 *  (auth/users + auth/roles both allow it on a 'staff' base role), so without it
 *  this would 403 the storekeeper whose job submit/receive actually is.
 *  403 COPY: say "Only Management or the Store Manager …" — "Manager or Admin"
 *  misstates the rule, since a staff-tier HOD and a storekeeper both pass.
 *  ACCEPTED RISK: isManagement passes every base_role='manager', which includes
 *  the seeded Floor Manager and Bar Manager (db.ts roles seed) — roles whose
 *  page_access carries no store page at all. They therefore also pass on receive,
 *  the irreversible one (stock bump + last_purchase_price + average_price
 *  rewrite). Deliberate: one gate for the whole PO lifecycle. If that stops being
 *  acceptable, narrow RECEIVE only, to `admin || is_store_manager`. */
export async function poWriteGate(): Promise<'anon' | 'denied' | 'ok'> {
  const user = await getCurrentUser();
  if (!user) return 'anon';
  return (isManagement(user) || user.is_store_manager) ? 'ok' : 'denied';
}

export async function effectiveActor(): Promise<string> {
  const user = await getCurrentUser();
  return user ? user.email : 'system';
}

export function recalcTotal(db: ReturnType<typeof getDb>, poId: string) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(total_price), 0) AS t FROM purchase_order_items WHERE po_id = ?
  `).get(poId) as any;
  db.prepare(`UPDATE purchase_orders SET total_cost = ?, updated_at = datetime('now') WHERE id = ?`).run(r.t, poId);
}
