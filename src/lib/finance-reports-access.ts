import { isManagement, type SessionUser } from '@/lib/auth';
import { financeCapOpens, FINANCE_CAP_PATHS } from '@/lib/page-catalog';

/**
 * THE API GATE for the owner's five finance screens (2026-10-05).
 *
 * WHY THIS FILE EXISTS. Four Reports routes and the purchase register each
 * refused with their own copy of `if (!isManagement(me)) 403`. The Accounts
 * designation was given all five pages in the Edit User grid and could open
 * none of them: ticks in that grid cannot reach past a tier gate. Widening
 * isManagement() would have opened every management screen in the building, so
 * instead the bar gains ONE narrow, admin-granted exception, and it lives here
 * rather than being retyped five times — six, once /api/reports/purchase-log is
 * counted, which is the feed the Purchase Report page actually calls.
 *
 * THE SAFETY PROPERTY, stated plainly: the capability is never tested alone.
 * Every call is `isManagement(me) || financeCapOpens(me, pagePath)`, and
 * financeCapOpens needs BOTH the user's roles column AND a `financeCap` flag on
 * the catalog row that `pagePath` resolves to. A route that passes a path with
 * no flag gets nothing, so this helper cannot be repurposed into a general
 * management bypass by a future caller that simply imports it.
 *
 * PAGE PATH, NOT API PATH. Callers pass the catalog path of the SCREEN they
 * feed, because that is where the flag lives and what the admin ticked. It is
 * also why /api/reports/purchase-log passes '/reports/purchases': it has no page
 * of its own, it is that page's data feed, and inventing a catalog row for it
 * would create a grant nobody can see in Settings.
 *
 * READ ONLY. Nothing here relaxes a WRITE path. The three routes that insert
 * purchases rows — POST /api/purchases, /purchases/bulk, /purchases/opening-stock
 * — keep the strict bar in src/lib/purchases-access.ts, because those move
 * current_stock and average_price and an accounts viewer has no business there.
 */

/** Can `me` read the finance screen served at `pagePath`? */
export function canViewFinanceReport(me: SessionUser | null, pagePath: string): boolean {
  return isManagement(me) || financeCapOpens(me, pagePath);
}

/** Standard 403 for the five finance screens, or null when allowed. The message
 *  names the capability so an admin reading a support screenshot knows which
 *  box to tick in Settings → Roles rather than guessing at tiers. */
export function requireFinanceReport(me: SessionUser | null, pagePath: string): Response | null {
  if (canViewFinanceReport(me, pagePath)) return null;
  return Response.json(
    { error: 'Management only, or a role with "View finance & purchase reports"' },
    { status: 403 },
  );
}

/** Re-exported so one grep over this module shows the whole allowlist. */
export { FINANCE_CAP_PATHS };
