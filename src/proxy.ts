import { NextRequest, NextResponse } from 'next/server';
import { canAccessPage, firstAllowedPath } from '@/lib/page-catalog';
import { loadHodOnlyOverrides } from '@/lib/hod-overrides';
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
  // Returns — the sibling of /api/requisitions and, like it, a workflow whose
  // last step writes raw_materials.current_stock (store-verify). It was the only
  // stock-moving family missing from this list. Safe to add: every write on the
  // returns pages goes through src/lib/api.ts, which injects X-CSRF-Token on
  // state-changing methods; the bare fetch() calls there are all GETs, which
  // isStateChanging() never checks.
  '/api/returns',             // vendor + internal returns, and the accept that moves stock
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
  '/api/petty-cash',          // store cash box — every POST moves real cash
  '/api/import-materials',
  '/api/closing-stock',
  '/api/variance-approvals',  // approve/reject variance (admin) — mutates stock
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
  '/api/department-materials', // dept on-hand transfer view + post-party reconcile
  '/api/party-bookings',      // sheet refresh (POST forces live fetch)
  '/api/party-menus',         // party (limited) menu presets — create/enable/assign tables
  '/api/dine-in/tables',      // POS table management (create/edit/delete)
  '/api/kitchen-production',   // prepared-item batches + FIFO consumption + label print
  '/api/settings/label-printer', // TSC label-printer config (admin) — matched by /api/settings too, kept explicit
  '/api/dine-in/orders',      // POS orders: open, add items, fire, settle, void
  '/api/dine-in/discount-requests', // remote bill-discount requests + approve/reject
  '/api/dine-in/customer-orders', // Captain approve/reject/modify of QR-menu orders
  '/api/dine-in/service-requests', // Captain accept/complete of table service requests
  '/api/dine-in/kds',         // KDS bump (the SSE stream is GET, exempt)
  '/api/dine-in/offline-print', // print-station config + print-job journal
  // The counter-PC dispatcher's liveness beat. It had no prefix here because it
  // never reached this step: isPublic()'s '/print' substring matched it first, so
  // it was publicly unauthenticated AND CSRF-exempt. Closing that hole makes it
  // authed, but WITHOUT this line it would stay forgeable by a cross-site page
  // driving a signed-in staff browser — and a forged beat marks a DEAD dispatcher
  // alive, which silences the watchdog banner while KOTs quietly stop printing.
  // Costs the real client nothing: its only caller (src/app/print/agent/page.tsx)
  // posts through src/lib/api.ts, which injects X-CSRF-Token, and /api/auth/login
  // issues fnb_csrf with the SAME maxAge as fnb_session — so any browser able to
  // authenticate necessarily holds the CSRF cookie too.
  '/api/dine-in/print-agent',  // print-agent heartbeat (status is GET, exempt)
  '/api/dine-in/cashier-presence', // which cashier holds which floor — holding a floor decides who may settle there
  // Bills on Hold. Its writes RECORD MONEY (payments, write-offs) and move
  // accountability between staff (reassign), so they are forgeable targets in
  // exactly the way /api/dine-in/orders is.
  //
  // MEASURED before this line existed, against a booted server: POST
  // /api/boh/<id>/payments with the fnb_csrf COOKIE present but NO
  // x-csrf-token header returned 200, while the control POST /api/wastage —
  // a prefix already on this list — returned 403. src/app/api/boh/route.ts's
  // own header comment claimed "Writes are CSRF-protected by the '/api/boh'
  // prefix in proxy.ts's CSRF_REQUIRED_PREFIXES"; the prefix was simply never
  // added, and no BOH route does its own check. This is that line.
  //
  // Costs the legitimate client nothing: every BOH screen posts through
  // src/lib/api.ts, which injects the header on state-changing methods.
  '/api/boh',                 // Bills on Hold: payments, follow-ups, reassign, close, void
  '/api/tables',              // QR standee token generation (admin)
  '/api/crm',                 // AKAN CRM (chat/training/quiz/settings) — guest-quiz is carved out in isPublic
  '/api/whatsapp',            // WhatsApp Integration (config/templates) — webhook is carved out in isPublic
  '/api/stores',              // Store Locations (multi-store engine config: stores/categories/access)
  '/api/tasks',               // Task Management module (tasks/checklists/maintenance/hygiene/training/approvals/etc.) — all mutations CSRF-protected
  '/api/crm-calls',           // CRM Call-to-Table: guests/calls/bookings/recoveries/settings/seed mutations
  '/api/crm-calls/entertainment', // GRE "What's On" entertainment calendar CRUD (management-gated writes)
  '/api/telecmi',             // TeleCMI actions (click-to-call, backfill) — webhooks are carved out in isPublic (matched there first)
  '/api/hr',                  // HRMS module (docs/HRMS_DECISIONS.md) — one prefix covers every present and future HR mutation; HR client writes must use src/lib/api.ts or they 403 here
  // Bill Submission Quality Check: the Store -> Accounts vendor-bill handover
  // register. One prefix covers create / submit / confirm / void / attachment,
  // present and future. Every client write must go through src/lib/api.ts
  // (api()/apiJson() inject X-CSRF-Token) or it 403s here. MEASURED without this
  // line, built from HEAD: POST /api/bill-submissions with NO x-csrf-token
  // reached app code. The path carries no 'print' substring and no file
  // extension, so neither isPublic() carve-out can make any of it public — and
  // the /api/ hard floor below (9224f6d) is untouched by this edit.
  '/api/bill-submissions',
];

// Print PAGES that must render without bouncing through /login — the four paths
// the old `pathname.includes('/print')` test actually existed for, now spelled out
// and ANCHORED. A substring is the wrong tool for this job twice over: it caught
// every API route with "print" anywhere in it (see the hard floor in isPublic),
// and it silently adopts the next page anyone names with the word in it —
// '/settings/printer-fleet' or '/reports/blueprint' would become public pages
// nobody chose to publish. An explicit list can only ever match what it lists.
//
// These four stay public, exactly as before. That is deliberate and load-bearing:
// isPublic() returns before the page_access check in proxy() step 2b, so '/print/agent'
// — the counter PC's KOT dispatcher — is reachable by whatever account the counter
// happens to be signed in as. Several seeded roles (Captain, Cashier, Head Chef,
// Store Manager, Staff) do NOT carry a '/print/agent' grant, so gating this path
// would redirect the counter away from the dispatcher and stop KOTs mid-service.
// Tightening page-level access here needs the production role map checked first;
// it is not part of closing the API hole, and the two must not be bundled.
const PUBLIC_PRINT_PAGES: RegExp[] = [
  /^\/print\/agent\/?$/,                   // counter-PC KOT dispatcher (see note above)
  /^\/settings\/print-design\/?$/,         // bill/KOT layout designer
  /^\/grn\/print\/[^/]+\/?$/,              // GRN print view
  /^\/purchase-orders\/[^/]+\/print\/?$/,  // PO print view — the original reason for the carve-out
];

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  // Customer QR menu: the scan-to-order page + its public, table-token-scoped
  // APIs must work with NO staff session (guests aren't logged in). Order
  // submissions land as 'pending_approval' and are gated by Captain approval,
  // so nothing reaches the kitchen or the bill without staff review.
  if (pathname === '/menu') return true;
  if (pathname.startsWith('/api/customer/')) return true;
  // CRM guest quiz: shareable-link quiz for job candidates / trial staff — no
  // account. Security rests on the unguessable link_code + server-side answer
  // stripping + attempt/expiry gates in the guest-quiz routes themselves.
  if (pathname.startsWith('/quiz/link/')) return true;
  if (pathname.startsWith('/api/crm/guest-quiz/')) return true;
  // WhatsApp webhook: Meta's servers call this with no session/CSRF. GET is the
  // verify-token handshake (403s on mismatch inside the route); POST only logs
  // the payload into whatsapp_events_log. Exact match — nothing else under
  // /api/whatsapp is public.
  if (pathname === '/api/whatsapp/webhook') return true;
  // TeleCMI webhooks (CRM Call-to-Table): TeleCMI's cloud POSTs live events +
  // CDRs with no session/CSRF. Security = the unguessable token path segment,
  // validated inside the routes (403 on mismatch). ONLY the webhook subtree is
  // public — click-to-call/recording/backfill under /api/telecmi stay authed.
  if (pathname.startsWith('/api/telecmi/webhook/')) return true;
  // Crash reporter: the client error boundaries + global handlers POST here, and
  // a crash can happen before login / in a state where the CSRF cookie isn't
  // available — so POST is public + CSRF-exempt. It's rate-limited, size-capped
  // and write-only; the GET/PATCH admin console self-checks role==='admin'.
  if (pathname === '/api/error-report') return true;

  // ───────────────────────── HARD FLOOR — /api/ stops here ─────────────────────────
  // Every deliberately-public API route is named ABOVE this line, one by one.
  // Everything BELOW matches by PATTERN — print pages, static files, file
  // extensions — and a pattern must never be able to unauthenticate an API route.
  //
  // Why this is a security boundary and not just tidiness: proxy() consults
  // isPublic() BEFORE its "auth required" step (2), before the session-validity
  // check (2c) and before the CSRF step (3). So anything that matched a pattern
  // down there was publicly readable AND exempt from CSRF — both at once.
  //
  // Two patterns below were doing exactly that:
  //   · `pathname.includes('/print')` made 7 API routes public, among them
  //     POST /api/dine-in/orders/[id]/print-bill (stamps orders.bill_printed_at and
  //     pushes a full tax invoice to the counter printer), POST
  //     /api/dine-in/print-agent/heartbeat (falsifies the KOT watchdog) and POST
  //     /api/kitchen-production/[id]/print-confirm (fakes production print history).
  //   · The file-extension regex is not limited to static files: Next's dynamic
  //     segments match any non-slash string, so /api/<anything>/<id>.json ends in
  //     ".json" and skipped both steps too. No API route and no caller in this repo
  //     ends a path in one of those extensions, so nothing legitimate used it.
  //
  // Closing both costs printing NOTHING. All 7 print routes already open with
  // `getCurrentUser()` and 401 without a session, so no cookie-less caller can have
  // been relying on them — the proxy now returns the same 401 the route already did.
  // The print bridge never calls the app at all (zero outbound fetches); the only
  // genuinely cookie-less caller is the PowerShell installer pulling
  // /print-bridge.mjs, /print-bridge.bat and /install-bridge-service.ps1 — all
  // root-level static files, not /api/, so the extension rule still serves them.
  if (pathname.startsWith('/api/')) return false;
  // ─────────────────────────────────────────────────────────────────────────────────

  if (PUBLIC_PRINT_PAGES.some(re => re.test(pathname))) return true;  // print pages render via cookie if present
  if (pathname.startsWith('/_next')) return true;
  if (pathname.startsWith('/favicon')) return true;
  // App downloads (the AKAN Captain APK): staff install it on fresh phones that
  // aren't signed in yet, so the file must be reachable without auth. It's just
  // the TWA wrapper (no secrets — those live in server env), so public is safe.
  if (pathname.startsWith('/downloads/')) return true;
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
      // Admin HOD-gate overrides (settings key 'hod_only_overrides') must be in
      // page-catalog's state BEFORE canAccessPage runs, or a switched-off gate
      // still blocks here. TTL-cached (2s) so this costs at most one tiny
      // settings SELECT per interval; it fails CLOSED internally (any read/parse
      // problem → the coded hodOnly flags stand), so it cannot widen access on
      // a DB error the way this block's own catch fails open.
      loadHodOnlyOverrides();
      // Resolve the EFFECTIVE tier + page set from the assigned named role (if any),
      // mirroring getCurrentUser(): a role-based user's page_access lives on the
      // role, not the user row — read it here or page gating fails open.
      const row = db.prepare(`
        SELECT u.role, u.page_access, u.role_id, u.is_head_chef,
               r.base_role AS role_base, r.page_access AS role_page_access,
               r.is_head_chef AS role_head_chef
        FROM sessions s JOIN users u ON u.id = s.user_id
        LEFT JOIN roles r ON r.id = u.role_id
        WHERE s.token = ? AND u.is_active = 1 AND s.expires_at > datetime('now')
      `).get(session) as any;
      const user = row ? {
        role: (row.role_id && row.role_base) ? row.role_base : row.role,
        page_access: row.page_access != null ? row.page_access : (row.role_id ? (row.role_page_access ?? null) : null),
        // Effective HOD flag = own column OR assigned role's flag. Mirror
        // getCurrentUser EXACTLY (auth.ts): the role contributes only when it is a
        // real assigned role (role_id AND base_role present), so the two never drift.
        is_head_chef: !!row.is_head_chef || (!!row.role_id && !!row.role_base && !!row.role_head_chef),
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
