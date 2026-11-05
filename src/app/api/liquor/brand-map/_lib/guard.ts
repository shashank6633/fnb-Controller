import { cookies } from 'next/headers';
import type Database from 'better-sqlite3';
import { getCurrentUser } from '@/lib/auth';
import { logAuditEvent } from '@/lib/db';
import type { SessionUser } from '@/lib/auth';

/**
 * The security boundary for every /api/liquor/brand-map route.
 *
 * ── WHY EACH ROUTE GATES ITSELF ──────────────────────────────────────────────
 * src/proxy.ts gates PAGES, not APIs. It resolves page_access for a non-API
 * request only; an /api/… request passes step 2b untouched. So the catalog's
 * `adminOnly` on /inventory/liquor-brand-map protects the SCREEN and nothing
 * else — a signed-in staff account can still curl the route. page-catalog.ts
 * says this in as many words ("Each page's own routes MUST re-check
 * server-side... This list is never the security boundary"), and one brand-map
 * row sets the yardstick every later indent of that pack is measured against
 * (the §G rate-movement watch), the cost of a pack before its first indent, and
 * its beer / spirit split. It never re-prices an indent: landed cost is built on
 * the rate PAID (owner decision 2). Admin, server-side, on every verb incl. GET.
 *
 * ── WHY CSRF IS CHECKED HERE AND NOT IN THE PROXY ────────────────────────────
 * proxy.ts enforces CSRF by PREFIX (CSRF_REQUIRED_PREFIXES) and '/api/liquor'
 * is NOT on that list. It cannot be added from this phase: proxy.ts is shared,
 * and all five liquor-reconciliation phases would add the same line to it and
 * collide. So the double-submit check is done here instead, with exactly the
 * proxy's rule (cookie fnb_csrf must be present and equal to the x-csrf-token
 * header, which src/lib/api.ts injects on every state-changing call). If
 * '/api/liquor' is later added to the proxy list this stays correct — the same
 * check simply runs twice.
 *
 * ── WHY THE AUDIT IS VERIFIED, NOT TRUSTED ───────────────────────────────────
 * logAuditEvent() in db.ts swallows its own error by design. Accepting a new
 * TGBCL rate into the master OVERWRITES the figure every future variance is
 * measured against; an accept with no audit row is an unexplained price change.
 * requireAuditedWrite() counts, logs, counts again, and throws unless the row
 * appeared — called INSIDE the caller's db.transaction() so the UPDATE rolls
 * back with it. Same technique as logAuditOrThrow() in src/lib/grn-reversal.ts;
 * kept local rather than imported for the same reason the HR import keeps its
 * own CSV parser — that module is the GRN reversal rail and may evolve with it.
 */

export interface Gate {
  ok: true;
  user: SessionUser;
}
export interface GateFail {
  ok: false;
  status: number;
  error: string;
}

/**
 * Admin + (for writes) CSRF. `method` decides whether the CSRF half runs, so a
 * GET is never refused for a missing header it would not have sent.
 */
export async function requireBrandMapAdmin(request: Request): Promise<Gate | GateFail> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, status: 401, error: 'Sign in required' };
  if (user.role !== 'admin') {
    return {
      ok: false, status: 403,
      error: 'Admin access required — the TGBCL brand master is the yardstick every indent rate is checked against (Rate Movement), and the rate a pack is costed at before its first indent.',
    };
  }
  const method = (request.method || 'GET').toUpperCase();
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const jar = await cookies();
    const cookieToken = jar.get('fnb_csrf')?.value || '';
    const headerToken = request.headers.get('x-csrf-token') || '';
    if (!cookieToken || !headerToken || cookieToken !== headerToken) {
      return { ok: false, status: 403, error: 'CSRF token missing or mismatched. Refresh the page.' };
    }
  }
  return { ok: true, user };
}

/** Turn a GateFail into its Response. */
export function gateResponse(g: GateFail): Response {
  return Response.json({ error: g.error }, { status: g.status });
}

/**
 * Write the audit row or abort the transaction. Call INSIDE db.transaction().
 * Throws a plain Error whose message is safe to show the operator.
 */
export function requireAuditedWrite(
  db: Database.Database,
  params: Parameters<typeof logAuditEvent>[1],
  whatWouldBeLost: string,
): void {
  const count = (): number => Number((db.prepare(
    'SELECT COUNT(*) AS n FROM audit_events WHERE entity_type = ? AND entity_id = ? AND event_type = ?',
  ).get(params.entity_type, params.entity_id, params.event_type) as any)?.n);

  let before: number;
  try {
    before = count();
    if (!Number.isFinite(before)) throw new Error('audit_events unreadable');
  } catch (e: any) {
    throw new Error(
      `The audit log could not be read (${e?.message || 'unknown error'}), so ${whatWouldBeLost} cannot be recorded. Nothing was changed.`,
    );
  }
  logAuditEvent(db, params);
  let after: number;
  try {
    after = count();
  } catch (e: any) {
    throw new Error(
      `The audit log could not be verified (${e?.message || 'unknown error'}), so ${whatWouldBeLost} cannot be recorded. Nothing was changed.`,
    );
  }
  if (after !== before + 1) {
    throw new Error(
      `The audit record for this action could not be written, so ${whatWouldBeLost} would leave no trail. Nothing was changed — check the server log for the [audit] error and try again.`,
    );
  }
}
