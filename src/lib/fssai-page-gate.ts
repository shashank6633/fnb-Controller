import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { canAccessPage, firstAllowedPath } from '@/lib/page-catalog';
import { loadHodOnlyOverrides } from '@/lib/hod-overrides';

/**
 * THE PAGE GATE FOR AN FSSAI ROUTE WITH A CALLER-CONTROLLED PATH SEGMENT.
 *
 * MEASURED DEFECT (P3 adversarial probe, 2026-09-21, port 3977). `proxy.ts`
 * decides a request is PUBLIC before routing, on the pathname alone:
 *
 *     proxy.ts:135  if (pathname.includes('/print')) return true;
 *     proxy.ts:151  if (pathname.match(/\.(png|jpg|…|json|…)$/)) return true;
 *
 * Both tests look at the WHOLE path, and two FSSAI pages end in a segment the
 * caller chooses. So a signed-out stranger asking for
 *
 *     GET /fssai/settings/checklists/print-abc      → HTTP 200, 303 KB
 *     GET /fssai/settings/checklists/abc.json       → HTTP 200, 304 KB
 *     GET /fssai/checklists/run/print-abc           → HTTP 200, 303 KB
 *
 * was served the administrator's checklist builder and the runner, while the
 * same pages under a real id correctly answered 307 → /login. A staff user
 * turned away from `/fssai/settings/checklists/<real id>` with
 * `307 → /?forbidden=…` was likewise served `…/print-abc` with a 200.
 *
 * NOTHING LEAKED: all 24 /fssai pages are client components, so the body is the
 * pre-hydration shell, and every /api/fssai route gates itself — measured, 37
 * anonymous API calls, all 401. What was bypassed is the PAGE gate, which is
 * exactly the layer HARD RULE 10 says cannot be relied on alone.
 *
 * WHY THE FIX IS HERE AND NOT IN proxy.ts. The hole is app-wide and
 * pre-existing — `POST /api/returns/print-abc` reaches its handler the same way
 * (measured: 405, not 401) — and proxy.ts is shared with three live lanes. This
 * is the same call P2 made for `fssaiCsrfGuard`: fix it inside FSSAI's own
 * footprint, change nothing shared. Idempotent with the proxy — when the proxy
 * did run, this reaches the same verdict and redirects nobody twice.
 *
 * Fails CLOSED. proxy.ts's own page block ends its catch by falling through —
 * "on DB error, fail open". A second gate that also failed open would add
 * nothing, so this one refuses instead.
 *
 * @param pathname the path as the proxy would have seen it, id included.
 */
export async function assertFssaiPageAccess(pathname: string): Promise<void> {
  let me: Awaited<ReturnType<typeof getCurrentUser>> = null;
  let allowed = false;
  try {
    me = await getCurrentUser();
    if (me) {
      // Mirror proxy.ts: admin HOD-gate overrides must be loaded into the
      // catalog's state BEFORE canAccessPage runs, or a gate the owner switched
      // off still blocks here. loadHodOnlyOverrides fails closed internally.
      loadHodOnlyOverrides();
      allowed = canAccessPage(pathname, me);
    }
  } catch {
    me = null;
    allowed = false;
  }

  // redirect() signals by throwing, so it must sit outside the try above.
  if (!me) redirect(`/login?next=${encodeURIComponent(pathname)}`);
  if (!allowed) {
    // Same landing as proxy.ts: the first page this user can actually open,
    // never the one just refused (that loops).
    const fallback = firstAllowedPath(me);
    const to = fallback === pathname ? '/' : fallback;
    redirect(`${to}?forbidden=${encodeURIComponent(pathname)}`);
  }
}
