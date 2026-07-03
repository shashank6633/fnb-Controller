import { NextRequest, NextResponse } from 'next/server';
import { canAccessPage, firstAllowedPath } from '@/lib/page-catalog';
import { getDb } from '@/lib/db';

/**
 * Next.js 16 proxy (formerly `middleware`) — runs at the network boundary on the
 * Node.js runtime. We only check session cookie presence here; full validation
 * (DB lookup, expiry) still happens inside route handlers via `getCurrentUser`.
 *
 * Two responsibilities:
 *   1. Redirect unauthenticated browser requests to /login (UX — no flash of app shell).
 *   2. Enforce CSRF on state-changing API calls using double-submit cookie pattern.
 */

const SESSION_COOKIE = 'fnb_session';
const CSRF_COOKIE    = 'fnb_csrf';
const CSRF_HEADER    = 'x-csrf-token';

// Routes that don't need authentication
const PUBLIC_PATHS = new Set([
  '/login',
  '/api/auth/login',
  '/api/auth/me',     // returns null for unauthenticated; safe to expose
  '/api/build-info',  // build id polling for stale-bundle auto-reload
]);

// CSRF is enforced on every state-changing API call. Listed by prefix so a single
// new route under any of these is automatically protected.
const CSRF_REQUIRED_PREFIXES = [
  '/api/auth/users',          // user management (admin-only)
  '/api/purchase-orders',     // POs + actions
  '/api/vendors',             // vendor master
  '/api/vendor-contracts',    // negotiated unit-price contracts
  '/api/vendor-materials',    // simple vendor↔material mapping (no price)
  '/api/departments',         // department master
  '/api/requisitions',        // internal department requisitions + workflow actions
  '/api/requisitions-import', // bulk import past transfers from Recaho
  '/api/unit-audit',          // bulk update of material units
  '/api/sales-import',        // bulk import Recaho item-wise sales report
  '/api/units',               // unit registry CRUD (admin)
  '/api/wastage',             // wastage logging (deducts stock)
  '/api/grn',                 // ad-hoc GRN creation
  '/api/sales',               // sales upload + delete
  '/api/inventory',           // material CRUD
  '/api/recipes',             // recipe CRUD
  '/api/sub-recipes',
  '/api/menu-items',
  '/api/parties',             // event consumption
  '/api/staff-meals',
  '/api/purchases',           // legacy purchase entries
  '/api/import-materials',
  '/api/closing-stock',
  '/api/direct-items',        // direct item link/unlink
  '/api/seed',                // seed sample data
  '/api/settings',            // settings updates
  '/api/outlets',             // outlet master + switching
  '/api/admin',               // admin destructive operations
  '/api/cron',                // manual cron trigger (admin or x-cron-token bypass)
  '/api/inward-import',       // bulk inward report upload (preview + commit)
  '/api/recipe-workbook-import', // bulk recipe-costing workbook upload (preview + commit)
  '/api/butchering',          // carcass breakdown batches + seed
  '/api/party-consumption',   // post-party liquor consumption recording
  '/api/party-bookings',      // sheet refresh (POST forces live fetch)
  '/api/dine-in/tables',      // POS table management (create/edit/delete)
  '/api/dine-in/orders',      // POS orders: open, add items, fire, settle, void
  '/api/dine-in/customer-orders', // Captain approve/reject/modify of QR-menu orders
  '/api/dine-in/service-requests', // Captain accept/complete of table service requests
  '/api/dine-in/kds',         // KDS bump (the SSE stream is GET, exempt)
  '/api/dine-in/offline-print', // print-station config + print-job journal
  '/api/tables',              // QR standee token generation (admin)
];

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  // Customer QR menu: the scan-to-order page + its public, table-token-scoped
  // APIs must work with NO staff session (guests aren't logged in). Order
  // submissions land as 'pending_approval' and are gated by Captain approval,
  // so nothing reaches the kitchen or the bill without staff review.
  if (pathname === '/menu') return true;
  if (pathname.startsWith('/api/customer/')) return true;
  if (pathname.includes('/print')) return true;            // PO print pages render via cookie if present
  if (pathname.startsWith('/_next')) return true;
  if (pathname.startsWith('/favicon')) return true;
  // manifest.json + sw.js + offline.html must be reachable without auth so the
  // browser can install the PWA shell / unregister the SW even before login.
  if (pathname === '/manifest.json') return true;
  if (pathname === '/sw.js') return true;
  if (pathname === '/offline.html') return true;
  // The offline KOT mini-POS page must be downloadable WITHOUT auth so the
  // counter-PC installer (Invoke-WebRequest) and manual download can fetch it.
  // It carries no secrets — the menu is loaded from the bridge's /cache at runtime.
  if (pathname === '/offline-pos.html') return true;
  if (pathname.match(/\.(png|jpg|jpeg|svg|ico|webp|gif|css|js|jsx|mjs|map|json|webmanifest|txt|woff2?|ttf|bat|ps1)$/)) return true;
  return false;
}

function isStateChanging(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const session = req.cookies.get(SESSION_COOKIE)?.value;
  const isApi = pathname.startsWith('/api/');

  // 1. Public bypass
  if (isPublic(pathname)) {
    // Issue a CSRF cookie on the login page so the very first POST has it
    if (pathname === '/login' && !req.cookies.get(CSRF_COOKIE)?.value) {
      const res = NextResponse.next();
      res.cookies.set(CSRF_COOKIE, randomToken(), {
        sameSite: 'lax', path: '/', secure: false, httpOnly: false,
      });
      return res;
    }
    return NextResponse.next();
  }

  // 2. Auth required for everything else
  if (!session) {
    if (isApi) {
      return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', pathname + req.nextUrl.search);
    return NextResponse.redirect(url);
  }

  // 2b. Page-level access enforcement for non-API page requests.
  // Admin always passes. Users with no page_access map (NULL) always pass
  // (backward compat). Anyone else must have the path in their JSON map.
  if (!isApi) {
    try {
      const db = getDb();
      // Resolve the EFFECTIVE tier + page set from the assigned named role (if any),
      // mirroring getCurrentUser(): a role-based user's page_access lives on the
      // role, not the user row — read it here or page gating fails open.
      const row = db.prepare(`
        SELECT u.role, u.page_access, u.role_id,
               r.base_role AS role_base, r.page_access AS role_page_access
        FROM sessions s JOIN users u ON u.id = s.user_id
        LEFT JOIN roles r ON r.id = u.role_id
        WHERE s.token = ? AND u.is_active = 1 AND s.expires_at > datetime('now')
      `).get(session) as any;
      const user = row ? {
        role: (row.role_id && row.role_base) ? row.role_base : row.role,
        page_access: row.page_access != null ? row.page_access : (row.role_id ? (row.role_page_access ?? null) : null),
      } : undefined;
      if (user && !canAccessPage(pathname, user)) {
        // Dashboard `/` is no longer ALWAYS_ALLOWED — so a user without
        // dashboard access who hits `/` would be told to go to... `/` again,
        // looping forever. Smart fallback: send them to the first allowed
        // path in their map (catalog order). Hit /login as final safety.
        const fallback = firstAllowedPath(user);
        // Don't redirect to the same path we just blocked (would loop)
        if (fallback === pathname) {
          return new NextResponse('No accessible pages assigned. Contact your administrator.', {
            status: 403, headers: { 'Content-Type': 'text/plain' },
          });
        }
        const url = req.nextUrl.clone();
        url.pathname = fallback;
        url.search = '';
        url.searchParams.set('forbidden', pathname);
        return NextResponse.redirect(url);
      }
    } catch { /* on DB error, fall through — fail open */ }
  }

  // 2c. SECURITY: validate the session for state-changing API calls. Presence of
  // the fnb_session cookie (checked in step 2) is NOT validity — a forged/expired
  // token was previously accepted by every mutating handler (some of which have no
  // handler-level auth). Validate the token against the sessions table here so a
  // junk cookie can never reach a POST/PUT/PATCH/DELETE handler. (GETs stay lenient;
  // sensitive GETs authenticate in-handler.)
  if (isApi && isStateChanging(req.method)) {
    try {
      const db = getDb();
      const valid = db.prepare(`
        SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = ? AND u.is_active = 1 AND s.expires_at > datetime('now')
      `).get(session);
      if (!valid) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
    } catch { /* infra/DB error → fall through (don't hard-fail the whole app) */ }
  }

  // 3. CSRF check on sensitive state-changing API calls
  if (isApi && isStateChanging(req.method)) {
    const required = CSRF_REQUIRED_PREFIXES.some(p => pathname.startsWith(p));
    if (required) {
      const cookieToken = req.cookies.get(CSRF_COOKIE)?.value;
      const headerToken = req.headers.get(CSRF_HEADER);
      if (!cookieToken || !headerToken || cookieToken !== headerToken) {
        return NextResponse.json(
          { error: 'CSRF token missing or mismatched. Refresh the page.' },
          { status: 403 },
        );
      }
    }
  }

  // 4. Make sure CSRF cookie exists for any signed-in browser session
  if (!req.cookies.get(CSRF_COOKIE)?.value && !isApi) {
    const res = NextResponse.next();
    res.cookies.set(CSRF_COOKIE, randomToken(), {
      sameSite: 'lax', path: '/', secure: false, httpOnly: false,
    });
    addNoCacheHeader(res, isApi);
    return res;
  }

  const res = NextResponse.next();
  addNoCacheHeader(res, isApi);
  return res;
}

/**
 * Force fresh HTML on every navigation. Without this, browsers (especially
 * Safari) cache the HTML response and serve it back on subsequent visits —
 * but the HTML references hashed chunk filenames from the build that was
 * live when it was cached. After a deploy, those chunks are gone → React
 * fails to load them → page render crashes ("This page couldn't load").
 *
 * Static assets (/_next/static, images) can still be cached aggressively
 * because their filenames are hash-stamped; deploys produce new hashes.
 */
function addNoCacheHeader(res: NextResponse, isApi: boolean): void {
  if (isApi) return;   // APIs set their own Cache-Control
  res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.headers.set('Pragma', 'no-cache');
}

function randomToken(): string {
  // 16 random bytes → 32-char hex (proxy runs on Node so crypto is available)
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

// Run on every request except static asset paths Next.js handles internally.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
