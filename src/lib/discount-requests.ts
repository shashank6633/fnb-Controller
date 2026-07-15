import type Database from 'better-sqlite3';
import type { SessionUser } from './auth';
import { round2 } from './bill-calc';

/**
 * Shared helpers for the remote bill-discount approval flow
 * (/api/dine-in/discount-requests + its [id]/decide action + the inbox bucket).
 * The synchronous at-the-till flow (orders/[id]/discount) is untouched.
 */

/** Who may see the approval queue and decide requests: Admin, Manager tier, or HOD. */
export function canDecideDiscount(u: SessionUser): boolean {
  return u.role === 'admin' || u.role === 'manager' || u.is_head_chef;
}

/** Discount-request rows joined with their order/table/requester context. */
export function listDiscountRequests(db: Database.Database, whereSql: string, params: unknown[]) {
  const rows = db.prepare(`
    SELECT dr.id, dr.order_id, dr.outlet_id, dr.requested_by, dr.requested_pct,
           COALESCE(dr.kind, 'discount') AS kind,
           dr.reason, dr.status, dr.decided_by, dr.decided_note, dr.decided_at, dr.created_at,
           o.order_number, o.order_type, o.status AS order_status,
           o.subtotal AS order_subtotal, o.total AS order_total,
           o.service_charge AS order_service_charge,
           o.discount_pct AS order_discount_pct,
           t.table_number, t.zone,
           COALESCE(u.name, dr.requested_by) AS requester_name
    FROM discount_requests dr
    JOIN orders o ON o.id = dr.order_id
    LEFT JOIN restaurant_tables t ON o.table_id = t.id
    LEFT JOIN users u ON lower(u.email) = lower(dr.requested_by)
    ${whereSql}
  `).all(...(params as any[])) as any[];
  // ₹ impact if approved. Discount = subtotal × pct / 100 (same math the sync
  // route writes). Service-charge waiver's exact ₹ is only known at settle
  // (subtotal × SC%), so it shows 0 here and the UI labels it a waiver.
  return rows.map((r) => ({
    ...r,
    impact_amount: r.kind === 'service_charge' ? 0 : round2((Number(r.order_subtotal) || 0) * (Number(r.requested_pct) || 0) / 100),
  }));
}
