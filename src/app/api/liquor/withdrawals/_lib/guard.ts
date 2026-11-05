import { cookies } from 'next/headers';
import { getCurrentUser, type SessionUser } from '@/lib/auth';

/**
 * The security boundary for every /api/liquor/withdrawals route (phase L4).
 *
 * ── ONE GATE, EVERY VERB ─────────────────────────────────────────────────────
 * The register and the recovery edit call the SAME function. The two handlers
 * used to carry their own copy of "signed in + admin" and NEITHER copy had the
 * CSRF half. Every other liquor write (brand-map, retail, reimburse, wallet,
 * portal-check) refused a request without the token, and these two, which
 * MOVE STOCK and record money owed by a named person, accepted it. Measured on
 * a DB copy: an admin POST with no x-csrf-token returned 201 and wrote a
 * LIQUOR STORE ledger row, and a PATCH with no token returned 200.
 *
 * ── WHY CSRF IS CHECKED HERE AND NOT IN THE PROXY ────────────────────────────
 * src/proxy.ts enforces CSRF by prefix (CSRF_REQUIRED_PREFIXES), and
 * '/api/liquor' is NOT on that list. proxy.ts is shared with production and is
 * not this module's file. So the double-submit check runs here, with exactly the
 * proxy's rule: the fnb_csrf cookie must be present and equal to the
 * x-csrf-token header, which src/lib/api.ts injects on every state-changing
 * call. liquor-withdrawals/page.tsx already posts and patches through api(), so
 * the screen sends the header and loses nothing. If '/api/liquor' is later added
 * to the proxy list this stays correct: the same check simply runs twice.
 *
 * ── WHY ADMIN, ON GET TOO ────────────────────────────────────────────────────
 * page-catalog flags /inventory/liquor-withdrawals adminOnly, but the catalog
 * "is never the security boundary". This is the director/management personal-use
 * ledger and it moves stock, so a manager with a bare '/inventory' grant must
 * still be refused, on reads as well as writes.
 */

export type WithdrawalsGate =
  | { ok: true; user: SessionUser }
  | { ok: false; response: Response };

const CSRF_COOKIE = 'fnb_csrf';
const CSRF_HEADER = 'x-csrf-token';

function isStateChanging(method: string): boolean {
  const m = (method || 'GET').toUpperCase();
  return m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE';
}

/**
 * Signed in, admin, and (on a write) the double-submit CSRF token. The CSRF half
 * keys off request.method, so a GET is never refused for a header it would not
 * have sent.
 */
export async function requireWithdrawalsAdmin(request: Request): Promise<WithdrawalsGate> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, response: Response.json({ error: 'Sign in required' }, { status: 401 }) };
  if (user.role !== 'admin') return { ok: false, response: Response.json({ error: 'Admin only' }, { status: 403 }) };
  if (isStateChanging(request.method)) {
    const jar = await cookies();
    const cookieToken = jar.get(CSRF_COOKIE)?.value || '';
    const headerToken = request.headers.get(CSRF_HEADER) || '';
    if (!cookieToken || !headerToken || cookieToken !== headerToken) {
      return {
        ok: false,
        response: Response.json({ error: 'CSRF token missing or mismatched. Refresh the page.' }, { status: 403 }),
      };
    }
  }
  return { ok: true, user };
}
