import { cookies } from 'next/headers';
import type { Database } from 'better-sqlite3';
import { getCurrentUser, isManagement, type SessionUser } from '@/lib/auth';
import { canAccessPage } from '@/lib/page-catalog';
import { userStoreAccess, materialStoreId, getStoreByName } from '@/lib/store-engine';
import { pettyCashWriteGate } from '@/lib/petty-cash';
import { LQ_RECON_PAGE } from '@/lib/liquor-summary';

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
 * manager). READING the register is §E money, so it is MANAGEMENT ONLY and
 * needs a page that shows it, the same two halves as the Reconciliation Summary
 * (requireRetailView); its depot rate and excess are ADMIN ONLY on top of that
 * (revealDepotFigures). REIMBURSING a claim moves money out of the petty cash box, so it
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

/** The page whose Wine-shop buys tab is this register's only screen. */
export const LIQUOR_STORE_PAGE = '/inventory/liquor-store';

/**
 * LISTING gate: signed in + MANAGEMENT (Admin, Manager or HOD — isManagement)
 * + a PAGE that shows the register. All of them are required.
 *
 * The listing IS §E of the Reconciliation Summary: depot spend, unreimbursed
 * staff spend, and every row's payer with the amount they are owed. It used to
 * admit can_view on the liquor store as well, which handed all of it to bar
 * staff who may only see stock. Store access does NOT widen it: recording a buy
 * (can_procure) is a stock authority, reading the money behind every buy is not.
 *
 * THE PAGE HALF. isManagement() alone is not what the Summary checks: its route
 * also requires canAccessPage(LQ_RECON_PAGE), so a manager, HOD or named
 * manager role whose page map is only ['/recipes'] (or only the wallet) got 403
 * on the Summary and 200 here — the same §E, through the softer door (measured
 * on the copy: recon 403, this route 200 with ₹10,100 owed and both payers'
 * names). Now one of the two screens that SHOW this data must be the caller's:
 *   · the Reconciliation Summary page — §E is on it already, so this route
 *     hands that viewer nothing the Summary does not; or
 *   · the Liquor Store page WITH can_view on the liquor store — the Wine-shop
 *     buys tab lives there, and without can_view that page is a lock screen.
 * canAccessPage is resolved exactly as the sidebar and the proxy resolve it.
 *
 * The depot rate and excess are a THIRD, narrower rule — admin-only — applied
 * to what this gate admits, in the route (revealDepotFigures below).
 */
export async function requireRetailView(db: Database): Promise<Gate | GateFail> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, status: 401, error: 'Sign in required' };
  const why = retailRegisterRefusal(db, user);
  if (why === 'not_management') {
    return {
      ok: false, status: 403,
      error: 'Only managers, HODs and admins can view the wine-shop register — it carries depot spend and the money owed to named staff.',
    };
  }
  if (why === 'no_page') {
    return {
      ok: false, status: 403,
      error: 'Your page access does not include the wine-shop register — it is shown on the Liquor Reconciliation Summary and on the Liquor Store page\'s Wine-shop buys tab.',
    };
  }
  return { ok: true, user };
}

/** Why requireRetailView would refuse this user, or null when it admits them. */
function retailRegisterRefusal(db: Database, user: SessionUser): 'not_management' | 'no_page' | null {
  if (!isManagement(user)) return 'not_management';
  const viaSummary = canAccessPage(LQ_RECON_PAGE, user);
  const store = viaSummary ? null : liquorStore(db);
  const viaStorePage = !viaSummary && !!store
    && canAccessPage(LIQUOR_STORE_PAGE, user)
    && userStoreAccess(db, user, store.id).can_view;
  return viaSummary || viaStorePage ? null : 'no_page';
}

/**
 * May this user read the money behind SOMEONE ELSE'S wine-shop buy — its rate
 * paid, its bottles, its excess? Exactly when they may open the register that
 * shows it (requireRetailView: management AND a page that shows it). The write
 * routes answer to can_procure, which is a STOCK authority, so anything they
 * say about another person's buy is filtered through this: the POST duplicate
 * refusal and the PATCH recomputed excess. isManagement alone was softer than
 * the register itself — a manager whose page map is only ['/recipes'] is 403 on
 * GET and was still quoted a colleague's rate on a duplicate retry. Fail closed.
 */
export function canReadRetailRegister(db: Database, user: SessionUser | null | undefined): boolean {
  if (!user) return false;
  return retailRegisterRefusal(db, user) === null;
}

/**
 * The depot landed rate on a wine-shop buy — and the excess, which is the rate
 * paid minus it — re-derives the ADMIN-ONLY TGBCL master rate (see
 * RETAIL_DEPOT_WITHHELD_NOTE in liquor-retail.ts). Admins only; fail closed.
 * The same predicate the Summary route passes as revealMasterRates.
 */
export function revealDepotFigures(user: Pick<SessionUser, 'role'> | null | undefined): boolean {
  return user?.role === 'admin';
}

/**
 * The FIRST step of every write that must look a record up before it can ask
 * the store question: signed in + CSRF. A lookup that runs before this answers
 * 404 to an anonymous caller — an existence oracle, and the wrong refusal.
 */
export async function requireSignedInWrite(request: Request): Promise<Gate | GateFail> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, status: 401, error: 'Sign in required' };
  if (!(await csrfOk(request))) {
    return { ok: false, status: 403, error: 'CSRF token missing or mismatched. Refresh the page.' };
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
