import { isManagement, type SessionUser } from '@/lib/auth';
import { financeCapOpens, isFinanceCapPath, FINANCE_CAP_PATHS } from '@/lib/page-catalog';

/**
 * THE API GATE for the owner's finance screens (2026-10-05).
 *
 * WHY THIS FILE EXISTS. Four Reports routes and the purchase register each
 * refused with their own copy of `if (!isManagement(me)) 403`. The Accounts
 * designation was given five of those pages in the Edit User grid and could open
 * none of them: ticks in that grid cannot reach past a tier gate. Widening
 * isManagement() would have opened every management screen in the building, so
 * instead the bar gains ONE narrow, admin-granted exception, and it lives here
 * rather than being retyped five times — six, once /api/reports/purchase-log is
 * counted, which is the feed the Purchase Report page actually calls.
 *
 * WHICH PAGES THE EXCEPTION COVERS IS NOT DECIDED HERE. It is decided by the
 * financeCap flag in page-catalog.ts, which the owner trimmed to FOUR the same
 * day by removing /reports/sales — sales data ranking NAMED STAFF, unlike the
 * three vendor-money Reports. Every route here still calls this helper, so that
 * page is refused by the ordinary management bar and the catalog remains the one
 * place the set is defined.
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

/** Standard 403 for these screens, or null when allowed.
 *
 *  THE MESSAGE IS CONDITIONAL ON THE PAGE'S OWN FLAG, not on this module being
 *  the one refusing. A route whose page carries no financeCap — /reports/sales
 *  since the owner removed it — is management-only exactly as it was before this
 *  module existed, so naming a capability there would send an admin to tick a box
 *  that cannot open it. Routes still call this helper rather than isManagement
 *  directly so the catalog stays the single source of truth: re-flagging a page
 *  changes both the gate and the message together, with no route to re-edit. */
export function requireFinanceReport(me: SessionUser | null, pagePath: string): Response | null {
  if (canViewFinanceReport(me, pagePath)) return null;
  return Response.json(
    {
      error: isFinanceCapPath(pagePath)
        ? 'Management only, or a role with "View finance & purchase reports"'
        : 'Management only',
    },
    { status: 403 },
  );
}

/** Re-exported so one grep over this module shows the whole allowlist. */
export { FINANCE_CAP_PATHS };
