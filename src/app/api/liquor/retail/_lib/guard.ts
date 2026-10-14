import { cookies } from 'next/headers';
import type { Database } from 'better-sqlite3';
import { getCurrentUser, isManagement, type SessionUser } from '@/lib/auth';
import { canAccessPage } from '@/lib/page-catalog';
import { userStoreAccess, materialStoreId, getStoreByName } from '@/lib/store-engine';
import { pettyCashWriteGate } from '@/lib/petty-cash';

/**
 * The security boundary for every /api/liquor/retail route (phase L3).
 *
 * ── WHY EACH ROUTE GATES ITSELF (same reasoning as L1's brand-map guard) ─────
 * src/proxy.ts gates PAGES, not APIs, and L3 has NO page of its own
 * (page-catalog.ts, line ~258: "L3 … deliberately has NO entry"). So there is
 * not even a catalog flag to lean on — the routes are the ONLY boundary, and
 * they must re-check server-side on every verb.
 *
 * ── WHY CSRF IS CHECKED HERE AND NOT IN THE PROXY ────────────────────────────
 * proxy.ts enforces CSRF by prefix (CSRF_REQUIRED_PREFIXES) and '/api/liquor'
 * is NOT on that list; it cannot be added from this phase (proxy.ts is shared,
 * and all five liquor phases would collide adding the same line). So the
 * double-submit check runs here, with exactly the proxy's rule: cookie fnb_csrf
 * must be present and equal to the x-csrf-token header (src/lib/api.ts injects
 * it on every state-changing call). If '/api/liquor' is later added to the
 * proxy list this stays correct — the same check simply runs twice.
 *
 * ── THE TWO GATE LEVELS, AND WHY ─────────────────────────────────────────────
 * RECORDING a wine-shop buy is a liquor PURCHASE, so it gates at the same level
 * the existing liquor purchase flow does — userStoreAccess(...).can_procure on
 * the store the material belongs to (admin / head chef / store manager / bar
 * manager). REIMBURSING a claim moves money out of the petty cash box, so it
 * gates at the petty-cash write level (Management or the Store Manager) AND
 * requires access to the petty-cash page — you may only pay out of a book you
 * may see, exactly as /api/petty-cash itself insists.
 */

export interface Gate { ok: true; user: SessionUser; storeId?: string; }
export interface GateFail { ok: false; status: number; error: string; }

export function gateResponse(g: GateFail): Response {
  return Response.json({ error: g.error }, { status: g.status });
}

/** The proxy's own CSRF rule, applied to a mutating request. */
async function csrfOk(request: Request): Promise<boolean> {
  const method = (request.method || 'GET').toUpperCase();
  if (!(method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) return true;
  const jar = await cookies();
  const cookieToken = jar.get('fnb_csrf')?.value || '';
  const headerToken = request.headers.get('x-csrf-token') || '';
  return !!cookieToken && !!headerToken && cookieToken === headerToken;
}

/** The active LIQUOR STORE, resolved by name (the module's single store today). */
export function liquorStore(db: Database): { id: string; name: string } | null {
  const s = getStoreByName(db, 'LIQUOR STORE');
  return s ? { id: s.id, name: s.name } : null;
}

/**
 * RECORD gate: signed in + CSRF (on writes) + can_procure on the store the
 * material belongs to. When materialId is given the store is resolved from it,
 * so a caller cannot procure into a store their material is not mapped to; when
 * it is absent (a GET listing) we gate on view access to the liquor store.
 */
export async function requireRetailRecord(
  request: Request, db: Database, materialId?: string,
): Promise<Gate | GateFail> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, status: 401, error: 'Sign in required' };
  if (!(await csrfOk(request))) {
    return { ok: false, status: 403, error: 'CSRF token missing or mismatched. Refresh the page.' };
  }
  const mat = materialId
    ? db.prepare('SELECT category FROM raw_materials WHERE id = ?').get(materialId) as any
    : null;
  const storeId = mat ? materialStoreId(db, mat) : (liquorStore(db)?.id ?? null);
  if (!storeId) {
    return { ok: false, status: 400, error: 'No liquor store is configured for this material.' };
  }
  const access = userStoreAccess(db, user, storeId);
  const need = (request.method || 'GET').toUpperCase() === 'GET' ? access.can_view : access.can_procure;
  if (!need) {
    return {
      ok: false, status: 403,
      error: 'You are not authorized to record wine-shop purchases for the liquor store.',
    };
  }
  // Return the MATERIAL's own store, so the writer books stock into the store
  // the item actually belongs to — correct even if a second liquor store is
  // ever added, not just the single by-name LIQUOR STORE.
  return { ok: true, user, storeId };
}

/** LISTING gate: signed in + can_view on the liquor store, OR management. */
export async function requireRetailView(db: Database): Promise<Gate | GateFail> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, status: 401, error: 'Sign in required' };
  const storeId = liquorStore(db)?.id ?? null;
  const canView = !!storeId && userStoreAccess(db, user, storeId).can_view;
  if (!canView && !isManagement(user)) {
    return { ok: false, status: 403, error: 'You are not authorized to view wine-shop purchases.' };
  }
  return { ok: true, user };
}

/**
 * REIMBURSE gate: signed in + CSRF + petty-cash page access + petty-cash write
 * level (Management or the Store Manager). Both halves, because a payout you may
 * record but not see would be money leaving a book you are refused.
 */
export async function requireRetailReimburse(request: Request): Promise<Gate | GateFail> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, status: 401, error: 'Sign in required' };
  if (!(await csrfOk(request))) {
    return { ok: false, status: 403, error: 'CSRF token missing or mismatched. Refresh the page.' };
  }
  if (!canAccessPage('/petty-cash', user)) {
    return { ok: false, status: 403, error: 'You do not have access to the petty cash book.' };
  }
  const gate = await pettyCashWriteGate();
  if (gate !== 'ok') {
    return { ok: false, status: 403, error: 'Only Management or the Store Manager can record a petty cash payout.' };
  }
  return { ok: true, user };
}
