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
  /**
   * When true, only HODs (is_head_chef) and admins may see/open this page,
   * regardless of the user's page_access map. First catalog-level tier gate.
   */
  hodOnly?: boolean;
  /**
   * When true, only management — Admin, any Manager, or an HOD (is_head_chef) —
   * may see/open this page. Broader than hodOnly (which excludes managers). Used
   * for sensitive customer PII (the Customers page).
   */
  mgmtOnly?: boolean;
  /**
   * When true, ONLY an Admin (role === 'admin') may see/open this page —
   * stricter than mgmtOnly/hodOnly. Used for admin-only consoles like the App
   * Errors page. Non-admins are blocked even with an explicit page_access grant.
   */
  adminOnly?: boolean;
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
      { path: '/cashier',             label: 'Cashier' },
      { path: '/dine-in/requests',    label: 'Customer Orders & Requests' },
      { path: '/dine-in/discount-approvals', label: 'Discount Approvals' },
      { path: '/dine-in/kitchen',     label: 'Kitchen Display' },
      { path: '/dine-in/kitchen/scan-out', label: 'Kitchen Scan-Out' },
      { path: '/dine-in/offline-print', label: 'KOT & Bill Printers' },
      { path: '/dine-in/tables',      label: 'Tables' },
      { path: '/dine-in/reservations', label: 'Reservations' },
      { path: '/customers',           label: 'Customers' },
      { path: '/dine-in/order',       label: 'Order Terminal' },
      { path: '/captain',             label: 'Captain (Tablet POS)' },
      { path: '/print/agent',         label: 'Print Agent (Counter)' },
      { path: '/menu-items',          label: 'Menu Items' },
      { path: '/recipes',             label: 'Recipes' },
      { path: '/direct-items',        label: 'Direct Items' },
      { path: '/sales',               label: 'Sales Upload' },
      { path: '/dine-in/reconciliation', label: 'Reconciliation' },
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
    label: 'Purchasing',
    pages: [
      { path: '/purchases',           label: 'Purchases' },
      { path: '/purchase-orders',     label: 'Purchase Orders' },
      { path: '/grn',                 label: 'Goods Receipt (GRN)' },
      { path: '/receiving-variance',  label: 'Receiving Variance' },
      { path: '/vendors',             label: 'Vendors' },
      { path: '/vendors/materials',   label: 'Vendor → Items' },
      { path: '/contracts',           label: 'Contracts' },
    ],
  },
  {
    label: 'Inventory',
    pages: [
      { path: '/inventory',           label: 'Raw Materials' },
      { path: '/settings/categories', label: 'Categories' },
      { path: '/inventory/liquor-store', label: 'Liquor Store' },
      { path: '/inventory/stock-overview', label: 'Stock Overview' },
      { path: '/inventory/transfers', label: 'Store Transfers' },
      { path: '/inventory/department-stock', label: 'Department Stock' },
      { path: '/inventory/reconciliation', label: 'Sales vs Consumption' },
      { path: '/store-dashboard',     label: 'Store Dashboard — Low Stock' },
      { path: '/store-requisitions',  label: 'Store Requisitions (Issue)' },
      { path: '/closing-stock',       label: 'Closing Stock' },
      { path: '/daily-rollup',        label: 'Daily Roll-up' },
      { path: '/wastage',             label: 'Wastage' },
      { path: '/unit-audit',          label: 'Unit Audit' },
      { path: '/units',               label: 'Unit Registry' },
      { path: '/department-materials', label: 'Dept Materials (Party)' },
    ],
  },
  {
    label: 'Production',
    pages: [
      { path: '/kitchen-production',   label: 'Kitchen Production', hodOnly: true },
      { path: '/kitchen-production/dashboard', label: 'Kitchen Production — Dashboard', hodOnly: true },
      { path: '/kitchen-production/scan', label: 'Kitchen Production — Scan' },
      { path: '/butchering',          label: 'Butchering' },
    ],
  },
  {
    label: 'Reports',
    pages: [
      { path: '/sales-dashboard',     label: 'Sales Dashboard' },
      { path: '/reports',             label: 'Reports' },
      { path: '/reports/sales',       label: 'Sales Reports', mgmtOnly: true },
      { path: '/menu-engineering',    label: 'Menu Engineering', hodOnly: true },
      { path: '/variance-report',     label: 'Variance Report' },
      { path: '/department-consumption', label: 'Dept Consumption' },
      { path: '/staff-meals',         label: 'Staff Meals' },
      { path: '/dine-in/kot-analytics', label: 'KOT Data Points' },
      { path: '/dine-in/captain-performance', label: 'Captain Response Times' },
      { path: '/kitchen-production/reports', label: 'Production Reports', hodOnly: true },
      { path: '/audit',               label: 'Audit' },
      { path: '/eod',                 label: 'End-of-Day' },
      { path: '/outlets',             label: 'Outlets' },
    ],
  },
  {
    // Task Management — checklists, maintenance, hygiene, training, approvals,
    // reporting. Additive module. No hodOnly: dept staff need My Tasks etc.;
    // page + API handlers gate management surfaces (canManageTasks) themselves.
    label: 'Task Management',
    pages: [
      { path: '/tasks',                label: 'Dashboard' },
      { path: '/tasks/my',             label: 'My Tasks' },
      { path: '/tasks/checklists',     label: 'Daily Checklists' },
      { path: '/tasks/board',          label: 'Task Board' },
      { path: '/tasks/maintenance',    label: 'Maintenance' },
      { path: '/tasks/hygiene',        label: 'Hygiene Audits' },
      { path: '/tasks/training',       label: 'Training Tasks' },
      { path: '/tasks/knowledge-tests', label: 'Knowledge Tests' },
      { path: '/tasks/approvals',      label: 'Approvals' },
      { path: '/tasks/reports',        label: 'Reports' },
      { path: '/tasks/calendar',       label: 'Calendar' },
      { path: '/tasks/templates',      label: 'Templates' },
      { path: '/tasks/departments',    label: 'Departments' },
      { path: '/tasks/notifications',  label: 'Notifications' },
      { path: '/tasks/settings',       label: 'Settings' },
    ],
  },
  {
    // CRM — Call-to-Table: TeleCMI telephony guest CRM (screen-pop, missed-call
    // recovery queue, guest 360, call log). Grant to GRE/front-office users.
    // Settings is admin-only (server-gated too). See docs/CRM_DECISIONS.md.
    label: 'CRM',
    pages: [
      { path: '/crm-calls',          label: 'CRM Dashboard' },
      { path: '/crm-calls/live',     label: 'Live Calls' },
      { path: '/crm-calls/recovery', label: 'Recovery Queue' },
      { path: '/crm-calls/guests',   label: 'Guests (unified 360)' },
      { path: '/crm-calls/log',      label: 'Call Log' },
      { path: '/crm-calls/bookings', label: 'CRM Bookings' },
      { path: '/crm-calls/settings', label: 'CRM Call Settings', mgmtOnly: true },
    ],
  },
  {
    // AI Training — AI assistant / analyst / training / quizzes for the Front
    // Office & GRE team (ported from the standalone Flask app; was "AKAN CRM",
    // renamed to avoid a second "CRM" heading). Grant per user/role like any
    // other page. Quiz Links + CRM Settings are HOD/admin surfaces.
    label: 'AI Training',
    pages: [
      { path: '/crm/assistant',  label: 'AI Assistant' },
      { path: '/crm/analyst',    label: 'AI Analyst — Data', hodOnly: true },
      { path: '/crm/digest',     label: 'Daily Digest',      hodOnly: true },
      // NOT hodOnly: store managers raise POs too — the page + API gate on
      // admin/HOD/store-manager themselves.
      { path: '/crm/reorder',    label: 'Smart Reorder' },
      // Legacy loyalty desk — folded into the unified CRM › Guests 360 (loyalty
      // is surfaced there by phone). Kept accessible (deep links / points admin)
      // but off the sidebar; the page + API gate on admin/manager-tier/HOD.
      { path: '/crm/guests',     label: 'Guests & Loyalty (legacy → CRM › Guests)' },
      { path: '/crm/training',   label: 'Training' },
      { path: '/crm/quiz',       label: 'Quiz' },
      { path: '/crm/quiz-links', label: 'Staff Quiz Links', hodOnly: true },
      { path: '/crm/settings',   label: 'CRM Settings',     hodOnly: true },
    ],
  },
  {
    label: 'Admin',
    pages: [
      { path: '/departments',         label: 'Departments' },
      { path: '/users',               label: 'Users' },
      { path: '/settings/dashboard',  label: 'Settings — Dashboard' },
      { path: '/settings/roles',      label: 'Settings — Roles' },
      { path: '/settings/print-design', label: 'Settings — Print Design' },
      { path: '/settings/stores',     label: 'Settings — Store Locations' },
      { path: '/settings/page-access', label: 'Settings — Page Access' },
      { path: '/settings/integrations', label: 'Settings — Integrations' },
      { path: '/settings/integrations/whatsapp', label: 'Settings — WhatsApp' },
      { path: '/settings/qr-standees', label: 'Settings — QR Standees' },
      { path: '/settings/customer-menu', label: 'Settings — Menu Design' },
      { path: '/settings/errors', label: 'Settings — App Errors', adminOnly: true },
      { path: '/admin/data-hygiene',  label: 'Admin — Data Hygiene' },
      { path: '/admin/reset',         label: 'Admin — Reset' },
    ],
  },
];

/** Flat list of all paths (handy for "select all" / proxy matching). */
export const ALL_PAGE_PATHS: string[] = PAGE_CATALOG.flatMap(s => s.pages.map(p => p.path));

/**
 * Is `pathname` under an HOD-only catalog entry? Uses LONGEST-prefix match so a
 * non-restricted child (e.g. /kitchen-production/scan) can sit under a
 * restricted parent (/kitchen-production) without inheriting the lock.
 */
function bestEntry(pathname: string): PageEntry | null {
  let best: PageEntry | null = null;
  for (const section of PAGE_CATALOG) {
    for (const p of section.pages) {
      if (pathname === p.path || pathname.startsWith(p.path + '/')) {
        if (!best || p.path.length > best.path.length) best = p;
      }
    }
  }
  return best;
}
export function isHodOnlyPath(pathname: string): boolean {
  return !!bestEntry(pathname)?.hodOnly;
}
/** Is `pathname` under a management-only catalog entry (admin/manager/HOD)? */
export function isMgmtOnlyPath(pathname: string): boolean {
  return !!bestEntry(pathname)?.mgmtOnly;
}
/** Is `pathname` under an admin-only catalog entry (role === 'admin' only)? */
export function isAdminOnlyPath(pathname: string): boolean {
  return !!bestEntry(pathname)?.adminOnly;
}

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
export const ALWAYS_ALLOWED: string[] = ['/login', '/launch'];

/**
 * Pick a landing path for a user whose page_access map exists and does NOT
 * include `/`. Returns the first allowed path in their map (in catalog order
 * so the UX is predictable), or '/login' as a final fallback.
 */
/**
 * Role-aware landing for a freshly-opened session. The Captain APK (and any PWA
 * install) opens /launch, and the post-login redirect resolves through here, so
 * ONE app drops each user on their natural home:
 *   management → dashboard, GRE → Recovery Queue, captain → POS, kitchen → KDS…
 * Picks the FIRST preferred candidate the user can actually access, then falls
 * back to firstAllowedPath() so nobody lands on a page that immediately
 * re-blocks them. Purely a routing convenience — every page still enforces its
 * own access; this never grants anything.
 */
export function homePathFor(user: { role?: string; page_access?: string | null; is_head_chef?: boolean } | null): string {
  if (!user) return '/login';
  const isMgmt = user.role === 'admin' || user.role === 'manager' || user.is_head_chef;
  // Legacy full-access (null map) NON-management users: canAccessPage grants
  // them everything via backward-compat, so the pref list below would land them
  // on /captain (the POS) via that backdoor. Send them to the dashboard '/'
  // instead — a genuine captain has an EXPLICIT /captain grant (or captain-tier
  // role) and so has a non-null map, unaffected by this.
  if (!user.page_access && !isMgmt) return '/';
  const prefs: string[] = [];
  // Management wants the whole-outlet dashboard first.
  if (isMgmt) prefs.push('/');
  // Then role homes, most-specific first. A GRE has CRM but not Captain access
  // (and vice-versa), so each lands correctly; someone with both is POS-primary.
  prefs.push(
    '/captain',              // captains → tablet POS
    '/crm-calls/recovery',   // GREs → missed-call recovery home base
    '/crm-calls',            // (CRM without recovery grant)
    '/dine-in/kitchen',      // kitchen → KDS
    '/dine-in/floor',        // floor staff → order floor
    '/cashier',
    '/requisitions',
    '/tasks/my',
    '/',                     // anyone with dashboard access
  );
  for (const p of prefs) if (canAccessPage(p, user)) return p;
  // Fallback: first catalog page (display order) the user can ACTUALLY open,
  // decided by canAccessPage — the SAME authority the proxy enforces, so
  // homePathFor can never return a page the proxy then bounces (no loop). A
  // user with no openable page → '/login' (LaunchPage shows a friendly notice).
  for (const section of PAGE_CATALOG) {
    for (const pg of section.pages) if (canAccessPage(pg.path, user)) return pg.path;
  }
  return '/login';
}

export function firstAllowedPath(user: { role?: string; page_access?: string | null; is_head_chef?: boolean } | null): string {
  if (!user) return '/login';
  if (user.role === 'admin') return '/';
  if (!user.page_access) return '/';                     // null map = full access → /
  let allowed: string[] = [];
  try { allowed = JSON.parse(user.page_access); }
  catch { return '/'; }
  if (!Array.isArray(allowed) || allowed.length === 0) return '/';
  // Iterate the catalog in display order so the redirect lands somewhere the
  // user "naturally" starts (Dashboard if allowed, else first dine-in/parties
  // page they have, etc.). Skip HOD-only pages the user can't actually open, so
  // a non-HOD isn't redirected to a page that immediately re-blocks them.
  for (const section of PAGE_CATALOG) {
    for (const p of section.pages) {
      if (allowed.includes(p.path)
        && !(p.hodOnly && !user.is_head_chef)
        && !(p.mgmtOnly && !(user.role === 'manager' || user.is_head_chef))
        && !(p.adminOnly && user.role !== 'admin')) return p.path;
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
  user: { role?: string; page_access?: string | null; is_head_chef?: boolean } | null,
): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (ALWAYS_ALLOWED.some(p => pathname === p)) return true;

  // HOD-only pages: a non-admin must be an HOD (is_head_chef), whatever their
  // page_access map says. MUST run before the null-map backward-compat grant
  // below, so legacy full-access staff are still locked out of these pages.
  if (isHodOnlyPath(pathname) && !user.is_head_chef) return false;

  // Management-only pages (customer PII): a non-admin must be a Manager or an
  // HOD. Also runs before the null-map grant so legacy full-access staff can't
  // reach the Customers page.
  if (isMgmtOnlyPath(pathname) && !(user.role === 'manager' || user.is_head_chef)) return false;

  // Admin-only pages (App Errors console): a non-admin is blocked outright,
  // whatever their page_access map says — runs before the null-map grant so
  // legacy full-access staff can't reach it either. (Admins already returned
  // true above, so this only ever affects non-admins.)
  if (isAdminOnlyPath(pathname)) return false;

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
