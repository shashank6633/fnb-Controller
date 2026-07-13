import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId, canApproveAsChef, canProcessAsStore } from '@/lib/auth';
import { requisitionVisibility } from '@/lib/dept-hierarchy';

/**
 * Action Inbox — the global notification bell.
 *
 * GET /api/notifications/inbox
 *   → { total, items: [{ key, label, count, href }] }
 *
 * NO new tables: every item is a live COUNT over existing pending states,
 * computed for THE CALLER's role:
 *   - HOD/admin        : requisitions waiting for chef approval (page-identical
 *                        dept scoping via requisitionVisibility)
 *   - store mgr/admin  : approved requisitions waiting at the issue desk
 *   - admin            : vendor POs awaiting approval ('pending' | 'pending_reapproval')
 *   - kitchen/admin    : open KOT trouble alerts (kot_alerts.resolved_at IS NULL)
 *   - HOD/store/admin  : materials at/below reorder level
 *   - plain staff      : their OWN requisitions by stage (with HOD / being
 *                        issued / fulfilled today)
 *
 * NOTE — bill discounts deliberately have NO bucket: the discount flow
 * (POST /api/dine-in/orders/[id]/discount) verifies the approving Manager's
 * login synchronously on the spot, so a "pending discount request" state
 * never persists anywhere.
 *
 * Items with count = 0 are omitted. This sits beside the existing
 * GET /api/notifications (party defer feed), which is untouched.
 */
export const dynamic = 'force-dynamic';

interface InboxItem { key: string; label: string; count: number; href: string }

export async function GET() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const outletId = await getCurrentOutletId();

    // Requisitions are outlet-scoped the same lenient way the /api/requisitions
    // list is: rows for the current outlet OR legacy rows with no outlet.
    const reqOutletSql = outletId ? ' AND (r.outlet_id = ? OR r.outlet_id IS NULL)' : '';
    const reqOutletParams: unknown[] = outletId ? [outletId] : [];

    const items: InboxItem[] = [];
    const push = (key: string, label: string, count: number, href: string) => {
      if (count > 0) items.push({ key, label, count, href });
    };
    const one = (sql: string, params: unknown[]): number =>
      Number((db.prepare(sql).get(...(params as any[])) as any)?.n || 0);

    const isAdmin = me.role === 'admin';

    // ── HOD approval inbox ────────────────────────────────────────────────
    if (canApproveAsChef(me)) {
      // Same dept scoping as the /requisitions page: null = see all
      // (admin/store), else the visibility SQL fragment (main-dept subtree,
      // explicit visible_department_ids, or own-drafted fallback).
      const vis = requisitionVisibility(db, me);
      const visSql = vis ? ` AND (${vis.sql})` : '';
      const visParams = vis ? vis.params : [];
      const n = one(
        `SELECT COUNT(*) AS n FROM requisitions r WHERE r.status = 'submitted'${reqOutletSql}${visSql}`,
        [...reqOutletParams, ...visParams],
      );
      push('chef_inbox', 'Requisitions waiting for HOD approval', n, '/requisitions');
    }

    // ── Store issue desk ──────────────────────────────────────────────────
    if (canProcessAsStore(me)) {
      const n = one(
        `SELECT COUNT(*) AS n FROM requisitions r
         WHERE r.status IN ('chef_approved', 'mgmt_approved')${reqOutletSql}`,
        reqOutletParams,
      );
      push('store_issue', 'Approved requisitions to issue', n, '/store-requisitions');
    }

    // ── Vendor PO approvals (admin approves; see purchase-orders/[id]/approve) ──
    if (isAdmin) {
      const poOutletSql = outletId ? ' AND po.outlet_id = ?' : '';
      const n = one(
        `SELECT COUNT(*) AS n FROM purchase_orders po
         WHERE po.status IN ('pending', 'pending_reapproval')${poOutletSql}`,
        outletId ? [outletId] : [],
      );
      push('po_approvals', 'Purchase orders awaiting approval', n, '/purchase-orders');
    }

    // ── Open KOT trouble alerts (KDS red banner) ──────────────────────────
    // Who: admin, Kitchen-section users, or anyone explicitly granted the KDS
    // page. (A NULL page_access means "all pages" for legacy users, but that
    // must NOT hand every plain staffer a kitchen bucket — so the page check
    // only applies to an explicit page list.)
    let seesKds = isAdmin || me.section === 'Kitchen';
    if (!seesKds && me.page_access) {
      try { seesKds = (JSON.parse(me.page_access) as string[]).includes('/dine-in/kitchen'); } catch { /* ignore */ }
    }
    if (seesKds) {
      const n = one(
        `SELECT COUNT(*) AS n FROM kot_alerts
         WHERE resolved_at IS NULL AND (outlet_id = ? OR outlet_id IS NULL)`,
        [outletId],
      );
      push('kot_alerts', 'KOTs not printed', n, '/dine-in/kitchen');
    }

    // ── Low stock (same trigger math as Smart Reorder: level > 0 & at/below) ──
    if (isAdmin || me.is_head_chef || me.is_store_manager) {
      const n = one(
        `SELECT COUNT(*) AS n FROM raw_materials
         WHERE reorder_level > 0 AND current_stock <= reorder_level`,
        [],
      );
      push('reorder', 'Items below reorder level', n, '/crm/reorder');
    }

    // ── Plain staff: MY requisitions by stage ─────────────────────────────
    // requisitions.drafted_by stores the drafter's EMAIL (see POST /api/requisitions).
    if (!isAdmin && !me.is_head_chef && !me.is_store_manager) {
      const own = (statusSql: string) => one(
        `SELECT COUNT(*) AS n FROM requisitions r
         WHERE r.drafted_by = ?${reqOutletSql} AND ${statusSql}`,
        [me.email, ...reqOutletParams],
      );
      push('my_req_hod', 'My requisitions with HOD', own(`r.status = 'submitted'`), '/requisitions');
      push('my_req_issuing', 'My requisitions being issued',
        own(`r.status IN ('chef_approved', 'mgmt_approved', 'store_processed')`), '/requisitions');
      push('my_req_fulfilled', 'My requisitions fulfilled today',
        own(`r.status = 'fulfilled' AND date(COALESCE(r.fulfilled_at, r.updated_at)) = date('now')`), '/requisitions');
    }

    const total = items.reduce((s, i) => s + i.count, 0);
    return Response.json({ total, items });
  } catch (e: any) {
    console.error('[/api/notifications/inbox]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
