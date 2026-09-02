import { isManagement, canProcessAsStore, type SessionUser } from '@/lib/auth';

/**
 * ROLE GATE for the purchase register and every route that WRITES purchases
 * rows (owner's 2026-09 call). ONE copy, imported by:
 *   · GET/POST /api/purchases            — the register feed + the programmatic
 *     single-line shape (the bill form itself moved to POST /api/grn);
 *   · POST /api/purchases/bulk           — the Generic-CSV importer;
 *   · POST /api/purchases/opening-stock  — the go-live seeding importer.
 * The two importers were login-only, which left a plain staffer 403'd from even
 * READING /api/purchases yet still able to bulk-INSERT purchase rows that move
 * current_stock and average_price. Same bar on all of them now.
 *
 * The bar is the strictest CONSISTENT sibling gate — the union GET /api/grn
 * already uses for its amend rights: resolved-tier admin/manager, a Head of
 * Department (is_head_chef), or the store person (is_store_manager). Plain
 * staff get 403.
 *
 * Callers, measured repo-wide (excluding node_modules/.next):
 *   · GET /api/purchases            — src/app/purchases/page.tsx only.
 *   · POST /api/purchases           — nobody in the browser; the dead
 *     scripts/import-purchases.py (401 since the auth gate landed).
 *   · POST bulk + opening-stock     — src/app/purchases/page.tsx only (the
 *     Generic CSV Upload and Upload Opening Stock buttons). That page's own
 *     feed is the 403'd GET above, so nobody who could USE those buttons
 *     loses them: every legitimate operator of the page already passes this.
 */
export function requirePurchasesAccess(me: SessionUser): Response | null {
  if (!isManagement(me) && !canProcessAsStore(me)) {
    return Response.json({ error: 'Store manager or management only' }, { status: 403 });
  }
  return null;
}
