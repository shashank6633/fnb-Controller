/**
 * Catalog of access-controlled pages, grouped by section.
 *
 * Single source of truth for:
 *   - Sidebar (filters nav links based on user's page_access)
 *   - Settings → Page Access (the matrix UI uses this list)
 *   - Proxy (route-level access enforcement)
 *
 * Backward compat:
 *   A user with `page_access = null` (no map set) sees EVERYTHING. This keeps
 *   existing users unaffected on rollout. Admin then opts each user into
 *   restricted access by checking specific pages.
 *
 * To add a page: append it to its section (or create a new section).
 */

export interface PageEntry {
  /** Path that proxy.ts + sidebar will match against */
  path: string;
  /** Display label */
  label: string;
}

export interface PageSection {
  /** Section heading */
  label: string;
  /** Pages inside this section. Children must be a non-empty list */
  pages: PageEntry[];
}

export const PAGE_CATALOG: PageSection[] = [
  {
    label: 'Core',
    pages: [
      { path: '/',                    label: 'Dashboard' },
    ],
  },
  {
    label: 'Dine-In',
    pages: [
      { path: '/dine-in/floor',       label: 'Order Floor' },
      { path: '/dine-in/kitchen',     label: 'Kitchen Display' },
      { path: '/dine-in/offline-print', label: 'KOT & Bill Printers' },
      { path: '/dine-in/tables',      label: 'Tables' },
      { path: '/dine-in/order',       label: 'Order Terminal' },
      { path: '/captain',             label: 'Captain (Tablet POS)' },
      { path: '/print/agent',         label: 'Print Agent (Counter)' },
      { path: '/menu-items',          label: 'Menu Items' },
      { path: '/recipes',             label: 'Recipes' },
      { path: '/direct-items',        label: 'Direct Items' },
      { path: '/sales',               label: 'Sales Upload' },
      { path: '/dine-in/reconciliation', label: 'Reconciliation' },
      { path: '/variance-report',     label: 'Variance Report' },
    ],
  },
  {
    label: 'Parties',
    pages: [
      { path: '/party-events',        label: 'Party Events' },
      { path: '/party-requisitions',  label: 'Party Requisitions' },
      { path: '/party-approvals',     label: 'Party Approvals' },
      { path: '/food-consumption',    label: 'Food Consumption' },
      { path: '/party-pnl',           label: 'Party Liquor Consumption' },
      { path: '/parties',             label: 'Party P&L (admin)' },
    ],
  },
  {
    label: 'Requisitions',
    pages: [
      { path: '/requisitions',        label: 'Internal Requisitions' },
    ],
  },
  {
    label: 'Store',
    pages: [
      { path: '/store-dashboard',     label: 'Store Dashboard — Low Stock' },
      { path: '/store-requisitions',  label: 'Store Requisitions (Issue)' },
      { path: '/purchases',           label: 'Purchases' },
      { path: '/purchase-orders',     label: 'Purchase Orders' },
      { path: '/grn',                 label: 'Goods Receipt (GRN)' },
      { path: '/butchering',          label: 'Butchering' },
      { path: '/receiving-variance',  label: 'Receiving Variance' },
      { path: '/departments',         label: 'Departments' },
      { path: '/vendors',             label: 'Vendors' },
      { path: '/vendors/materials',   label: 'Vendor → Items' },
      { path: '/contracts',           label: 'Contracts' },
      { path: '/inventory',           label: 'Raw Materials' },
      { path: '/unit-audit',          label: 'Unit Audit' },
      { path: '/units',               label: 'Unit Registry' },
      { path: '/closing-stock',       label: 'Closing Stock' },
      { path: '/daily-rollup',        label: 'Daily Roll-up' },
      { path: '/wastage',             label: 'Wastage' },
    ],
  },
  {
    label: 'Reports',
    pages: [
      { path: '/department-consumption', label: 'Dept Consumption' },
      { path: '/staff-meals',         label: 'Staff Meals' },
      { path: '/reports',             label: 'Reports' },
      { path: '/audit',               label: 'Audit' },
      { path: '/eod',                 label: 'End-of-Day' },
      { path: '/outlets',             label: 'Outlets' },
    ],
  },
  {
    label: 'Admin',
    pages: [
      { path: '/users',               label: 'Users' },
      { path: '/settings/roles',      label: 'Settings — Roles' },
      { path: '/settings/print-design', label: 'Settings — Print Design' },
      { path: '/settings/categories', label: 'Settings — Category Manager' },
      { path: '/settings/page-access', label: 'Settings — Page Access' },
      { path: '/settings/integrations', label: 'Settings — Integrations' },
      { path: '/admin/data-hygiene',  label: 'Admin — Data Hygiene' },
      { path: '/admin/reset',         label: 'Admin — Reset' },
    ],
  },
];

/** Flat list of all paths (handy for "select all" / proxy matching). */
export const ALL_PAGE_PATHS: string[] = PAGE_CATALOG.flatMap(s => s.pages.map(p => p.path));

/**
 * Pages that EVERY signed-in user can access regardless of their access map.
 *
 * Only /login here. The Dashboard `/` is intentionally NOT included anymore
 * so admins can restrict it per user (e.g. bar staff who shouldn't see
 * cross-restaurant KPIs).
 *
 * To avoid redirect loops when a user can't see `/`, proxy.ts redirects them
 * to the first allowed path from their page_access array (see firstAllowedPath
 * helper below).
 */
export const ALWAYS_ALLOWED: string[] = ['/login'];

/**
 * Pick a landing path for a user whose page_access map exists and does NOT
 * include `/`. Returns the first allowed path in their map (in catalog order
 * so the UX is predictable), or '/login' as a final fallback.
 */
export function firstAllowedPath(user: { role?: string; page_access?: string | null } | null): string {
  if (!user) return '/login';
  if (user.role === 'admin') return '/';
  if (!user.page_access) return '/';                     // null map = full access → /
  let allowed: string[] = [];
  try { allowed = JSON.parse(user.page_access); }
  catch { return '/'; }
  if (!Array.isArray(allowed) || allowed.length === 0) return '/';
  // Iterate the catalog in display order so the redirect lands somewhere the
  // user "naturally" starts (Dashboard if allowed, else first dine-in/parties
  // page they have, etc.).
  for (const section of PAGE_CATALOG) {
    for (const p of section.pages) {
      if (allowed.includes(p.path)) return p.path;
    }
  }
  return '/login';
}

/**
 * Returns true if the given user can access the given path.
 *   - admin → always true
 *   - page_access null/empty → always true (backward compat)
 *   - otherwise → must be in the user's allowed set OR in ALWAYS_ALLOWED
 *
 * Path matching is prefix-based for nested routes (e.g. /requisitions/123
 * matches /requisitions). API paths under /api/* are NOT page-level
 * controlled — those have their own auth checks.
 */
export function canAccessPage(
  pathname: string,
  user: { role?: string; page_access?: string | null } | null,
): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (ALWAYS_ALLOWED.some(p => pathname === p)) return true;

  // No explicit map → grant everything (backward compat)
  if (!user.page_access) return true;

  let allowed: string[];
  try { allowed = JSON.parse(user.page_access); }
  catch { return true; }   // garbled value → don't lock out
  if (!Array.isArray(allowed) || allowed.length === 0) return true;

  // Exact match OR prefix match on a controlled page (so /vendors/123 works
  // when /vendors is allowed). To avoid /audit allowing /audit-log we require
  // the next char to be '/' or end-of-string.
  return allowed.some(p => pathname === p || pathname.startsWith(p + '/'));
}
