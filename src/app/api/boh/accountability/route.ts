import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { ensureBohSchema } from '@/lib/boh-schema';
import { canUseBoh, canSeeBohTotals } from '@/lib/boh-access';
import {
  parseBohReportFilter, filterIsActive, loadBohReportRows,
  computeBohAccountability, computeBohDashboard,
} from '@/lib/boh-reporting';

/**
 * GET /api/boh/accountability — per responsible user: what they are carrying,
 * what has gone past its date, what they have not chased, and what they have
 * collected.
 *
 * ── MANAGEMENT ONLY, AND THIS ONE IS NOT NEGOTIABLE ────────────────────────
 * src/lib/boh-access.ts names this view explicitly as an isManagement() surface
 * (canSeeBohTotals). It is a cross-user money table by construction: there is
 * no version of it scoped to one person that would still answer the owner's
 * question, "who is actively following up and where are bills getting delayed".
 * The gate is here, in the route, because proxy.ts guards pages not APIs and
 * canAccessPage fails open four ways (role_id NULL on 9 of 9 users,
 * page_access NULL on 8).
 *
 * ── THE NUMBERS HAVE TO BE DEFENSIBLE ──────────────────────────────────────
 * This screen judges people, so two things are stated on the row itself rather
 * than assumed:
 *   · ATTRIBUTION — every assignment figure belongs to the CURRENT responsible
 *     user, and `inherited_count` says how many of those bills were handed to
 *     them by somebody else. Nothing in the history is rewritten by a
 *     reassignment; boh_assignments is append-only.
 *   · MISSED — one definition, taken from src/lib/boh.ts's FOLLOWUP_STATE_SQL
 *     through listBoh(), never re-spelled here: open, expected date BEFORE
 *     today (IST), and no follow-up recorded against THAT date. A date that has
 *     passed but WAS chased is 'overdue', not a miss.
 *
 * READ-ONLY. GET only; nothing it calls can write.
 * The path carries no 'print' substring and no file extension, so neither
 * isPublic() carve-out in proxy.ts can reach it.
 */
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    if (!canUseBoh(me)) {
      return Response.json({
        error: 'Your role does not include the Cashier page, so you cannot open the Bills on Hold module.',
      }, { status: 403 });
    }
    const totals = canSeeBohTotals(me);
    if (!totals.allowed) {
      return Response.json({ error: totals.message }, { status: totals.status });
    }

    const db = getDb();
    if (!ensureBohSchema(db)) {
      return Response.json({ error: 'The Bills on Hold tables are unavailable on this database.' }, { status: 503 });
    }

    const outletId = await getCurrentOutletId();
    const u = new URL(req.url);
    // The same filter object as the dashboard, so a manager can carry a date
    // range or a search straight across from one screen to the other and the
    // two will agree row for row.
    const filter = { ...parseBohReportFilter(u), outletId };
    const set = loadBohReportRows(db, filter);

    const users = computeBohAccountability(db, set);
    // The outlet-wide figures, so the table can be reconciled against a total
    // on the same response rather than against a second request that might have
    // been taken a minute later.
    const figures = computeBohDashboard(db, set);

    // Outlet-scoped for the same reason as the dashboard's: the empty state must
    // not tell a manager that records exist which this screen could never show.
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

    return Response.json({
      users,
      figures,
      row_total: set.rows.length,
      truncated: set.truncated,
      today: set.today,
      generated_at: new Date().toISOString(),
      filter_active: filterIsActive(filter),
      any_records: anyRecords,
    });
  } catch (e: any) {
    console.error('[/api/boh/accountability GET]', e);
    return Response.json({ error: e?.message || 'Failed to load the Bills on Hold accountability view' }, { status: 500 });
  }
}
