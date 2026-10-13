import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { ensureBohSchema } from '@/lib/boh-schema';
import { canUseBoh, canSeeBohTotals } from '@/lib/boh-access';
import {
  parseBohReportFilter, filterIsActive, loadBohReportRows,
  computeBohDashboard, responsibleUsersIn, overdueDaysOf,
} from '@/lib/boh-reporting';

/**
 * GET /api/boh/dashboard — every figure the owner named, for the bills the
 * filter selects.
 *
 * ── THIS ROUTE GATES ITSELF, AND THAT IS THE ONLY REAL GATE ─────────────────
 * proxy.ts guards PAGES, not APIs, and canAccessPage fails open four ways.
 * Measured on the owner's live data: role_id is set on 0 of 9 users and
 * page_access is NULL on 8 (NULL = all pages), so page gating is inert in
 * production. Nothing below relies on the proxy having refused anyone.
 *
 * ── MANAGEMENT ONLY, AND WHY IT IS STRICTER THAN THE REGISTER ──────────────
 * src/lib/boh-access.ts's third tier: own BOH bills are visible to any
 * till-capable user, but CROSS-USER LISTS AND EVERY MONEY TOTAL are
 * isManagement(). This screen is nothing but cross-user money totals — total
 * outstanding, what each bill is worth, and a customer's phone number on every
 * row — so it takes the stricter door, canSeeBohTotals(). A cashier's own
 * bills live on the register (/boh), not here.
 *
 * ── READ-ONLY ───────────────────────────────────────────────────────────────
 * GET only. There is no POST/PATCH/DELETE in this file and nothing it calls can
 * write, so it cannot touch the rail a BOH payment must never move (sales,
 * inventory_transactions, department_material_transactions, consumption_skips,
 * store_stock_ledger, the frozen orders columns). Being read-only is also why
 * it needs no CSRF token — but note that /api/boh is NOT in proxy.ts's
 * CSRF_REQUIRED_PREFIXES today, which the module's WRITE routes do depend on;
 * that is reported separately and is not this route's to fix.
 *
 * The path contains no 'print' substring (proxy.ts:132 would make such a path
 * PUBLICLY UNAUTHENTICATED) and ends in no file extension, so neither isPublic()
 * carve-out can reach it.
 */
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    // Two doors, in order, so the refusal says which one closed. canUseBoh is
    // the module door (tillCapable: management always, staff only with an
    // EXPLICIT /cashier grant); canSeeBohTotals is the money door.
    if (!canUseBoh(me)) {
      return Response.json({
        error: 'Your role does not include the Cashier page, so you cannot open the Bills on Hold module.',
      }, { status: 403 });
    }
    const totals = canSeeBohTotals(me);
    if (!totals.allowed) {
      return Response.json({
        error: 'The Bills on Hold dashboard shows what every bill on hold is worth across all users, ' +
               'and a customer phone number on each one. It is management only — ' +
               'your own bills are on the Bills on Hold register.',
      }, { status: totals.status });
    }

    const db = getDb();
    // Self-heal: a schema error swallowed by initializeSchema at boot becomes a
    // clear 503 here rather than a permanent "no such table" 500.
    if (!ensureBohSchema(db)) {
      return Response.json({ error: 'The Bills on Hold tables are unavailable on this database.' }, { status: 503 });
    }

    const outletId = await getCurrentOutletId();
    const u = new URL(req.url);
    const filter = { ...parseBohReportFilter(u), outletId };
    const set = loadBohReportRows(db, filter);
    const figures = computeBohDashboard(db, set);

    // Does this VIEWER have ANY bill on hold at all, filters aside? This is the
    // difference between "nothing is pending" and "nothing matches your
    // filters", and the screen must never show the first when it means the
    // second. Scoped to the same outlet predicate listBoh uses — an unscoped
    // count would tell a manager records exist that this screen can never show
    // him, which is the same lie in the other direction.
    let anyRecords = 0;
    try {
      anyRecords = outletId
        ? Number((db.prepare(
            `SELECT COUNT(*) AS n FROM boh_bills WHERE status <> 'void' AND (outlet_id = ? OR outlet_id IS NULL)`,
          ).get(outletId) as any)?.n ?? 0) || 0
        : Number((db.prepare(
            `SELECT COUNT(*) AS n FROM boh_bills WHERE status <> 'void'`,
          ).get() as any)?.n ?? 0) || 0;
    } catch { anyRecords = 0; }

    // The rows behind the figures. An explicit field list, deliberately NOT the
    // `o.*` shape of GET /api/dine-in/orders?status=on_hold.
    const DISPLAY_CAP = 500;
    const rows = set.rows.slice(0, DISPLAY_CAP).map(r => ({
      id: r.id,
      order_id: r.order_id,
      bill_number: r.bill_number,
      bill_date: r.bill_date,
      table_label: r.table_label,
      customer_name: r.customer_name,
      customer_mobile: r.customer_mobile,
      customer_company: r.customer_company,
      responsible_user_id: r.responsible_user_id,
      responsible_name: r.responsible_name,
      expected_payment_date: r.expected_payment_date,
      principal_amount: r.principal_amount,
      paid_amount: r.paid_amount,
      balance_amount: r.balance_amount,
      status: r.status,
      close_kind: r.close_kind,
      followup_state: r.followup_state,
      overdue_days: overdueDaysOf(r, set.today),
      reconcile_needed: r.reconcile_needed,
      order_status: r.order_status,
      reason: r.reason,
    }));

    return Response.json({
      figures,
      rows,
      row_total: set.rows.length,
      display_cap: DISPLAY_CAP,
      truncated: set.truncated,
      users: responsibleUsersIn(set.rows),
      today: set.today,
      // The moment these numbers were counted. The screen prints it so nothing
      // on the page can imply a figure is live when it is minutes old.
      generated_at: new Date().toISOString(),
      filter_active: filterIsActive(filter),
      any_records: anyRecords,
    });
  } catch (e: any) {
    console.error('[/api/boh/dashboard GET]', e);
    return Response.json({ error: e?.message || 'Failed to load the Bills on Hold dashboard' }, { status: 500 });
  }
}
