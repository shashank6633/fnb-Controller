import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId, canApproveAsChef, canProcessAsStore } from '@/lib/auth';
import { requisitionVisibility } from '@/lib/dept-hierarchy';
import { canApproveTasks } from '@/lib/tasks';

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
 * Bill discounts: the synchronous flow (POST /api/dine-in/orders/[id]/discount)
 * still verifies the approving Manager's login on the spot and never persists
 * a pending state. The REMOTE flow (discount_requests) does persist one, so:
 *   - approvers (admin/manager-tier/HOD) : pending bill-discount requests
 *                                          → /dine-in/discount-approvals
 *   - everyone else                      : their OWN pending requests → /captain
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
    // CRITICAL (3★ priority) materials ONLY — with 1000+ materials the bell
    // must mean "act today". 2★/1★ tiers stay visible on /store-dashboard
    // and /crm/reorder, just not counted here.
    if (isAdmin || me.is_head_chef || me.is_store_manager) {
      const n = one(
        `SELECT COUNT(*) AS n FROM raw_materials
         WHERE reorder_level > 0 AND current_stock <= reorder_level
           AND COALESCE(priority, 2) = 3`,
        [],
      );
      push('reorder', 'Critical items below reorder level', n, '/crm/reorder');
    }

    // ── Bill discounts awaiting REMOTE approval ──────────────────────────
    // Approver gate mirrors /api/dine-in/discount-requests: admin, manager
    // tier, or HOD. Only requests on still-open orders count (a settled order
    // can't take a discount anymore). Non-approvers see their OWN pending
    // requests and are pointed back to the Captain app.
    if (isAdmin || me.role === 'manager' || me.is_head_chef) {
      const n = one(
        `SELECT COUNT(*) AS n FROM discount_requests dr
         JOIN orders o ON o.id = dr.order_id
         WHERE dr.status = 'pending' AND o.status = 'open'
           AND (dr.outlet_id = ? OR dr.outlet_id IS NULL)`,
        [outletId],
      );
      push('discount_approvals', 'Bill discounts awaiting approval', n, '/dine-in/discount-approvals');
    } else {
      const n = one(
        `SELECT COUNT(*) AS n FROM discount_requests dr
         JOIN orders o ON o.id = dr.order_id
         WHERE dr.status = 'pending' AND o.status = 'open' AND lower(dr.requested_by) = lower(?)`,
        [me.email],
      );
      push('my_discount_pending', 'My discount requests awaiting approval', n, '/captain');
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

    // ── Task Management buckets (additive; isolated so a task-schema issue
    //    can never break the existing inbox) ───────────────────────────────
    try {
      const email = me.email || '';

      // Tasks due today assigned to me (still open).
      push('tasks_due_today', 'Tasks due today assigned to me', one(
        `SELECT COUNT(*) AS n FROM tasks
         WHERE lower(assignee_email) = lower(?) AND due_date = date('now')
           AND is_archived = 0
           AND status NOT IN ('completed', 'approved', 'cancelled')`,
        [email],
      ), '/tasks/my');

      // Tasks awaiting my approval (approvers only).
      if (canApproveTasks(me)) {
        push('tasks_awaiting_approval', 'Tasks awaiting my approval', one(
          `SELECT COUNT(*) AS n FROM tasks
           WHERE status = 'waiting_verification' AND is_archived = 0`,
          [],
        ), '/tasks/approvals');
      }

      // Unread @mentions for me — counted off task_notifications (kind='mention'),
      // NOT task_mentions. Every deliverable @mention (an @email token) fans out to
      // BOTH a task_mentions row and a kind='mention' task_notifications row, and the
      // /tasks/notifications page's mark-read flow clears task_notifications. Counting
      // task_mentions.is_read here left the bell stuck forever, because no endpoint
      // ever sets task_mentions.is_read = 1 — so the badge could never return to zero.
      push('tasks_mentions', '@mentions for me (unread)', one(
        `SELECT COUNT(*) AS n FROM task_notifications
         WHERE lower(recipient_email) = lower(?) AND kind = 'mention' AND is_read = 0`,
        [email],
      ), '/tasks/notifications');
    } catch (taskErr) {
      console.error('[/api/notifications/inbox] task buckets failed:', taskErr);
    }

    // ── CRM Call-to-Table: pending missed-call recoveries (additive; isolated
    //    so a ct-schema issue can never break the existing inbox). Visible to
    //    admins and anyone explicitly granted the Recovery Queue page — same
    //    "explicit page list only" rule as the KDS bucket above. ─────────────
    try {
      let seesCt = isAdmin;
      if (!seesCt && me.page_access) {
        try {
          const pages = JSON.parse(me.page_access) as string[];
          seesCt = pages.includes('/crm-calls/recovery') || pages.includes('/crm-calls');
        } catch { /* ignore */ }
      }
      if (seesCt) {
        const n = one(
          `SELECT COUNT(*) AS n FROM ct_recoveries WHERE status IN ('pending', 'attempting')`,
          [],
        );
        push('ct_recoveries', 'Missed calls awaiting callback', n, '/crm-calls/recovery');
      }
    } catch (ctErr) {
      console.error('[/api/notifications/inbox] ct bucket failed:', ctErr);
    }

    const total = items.reduce((s, i) => s + i.count, 0);
    return Response.json({ total, items });
  } catch (e: any) {
    console.error('[/api/notifications/inbox]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
