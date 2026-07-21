import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

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
