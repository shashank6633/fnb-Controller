/**
 * Shared gate + error translation for the TGBCL wallet API (phase L2).
 *
 * A route.ts may only export HTTP handlers and Next's route config, so these
 * live beside it rather than in it. Both /api/liquor/wallet and
 * /api/liquor/wallet/portal-check call the SAME functions: two copies of an
 * access rule drift, and on this module the copy that drifts is the write path.
 */

import { getCurrentUser, isManagement } from '@/lib/auth';
import { canAccessPage } from '@/lib/page-catalog';
import { LQ_WALLET_PAGE, WalletWriteError } from '@/lib/liquor-wallet';

const CSRF_COOKIE = 'fnb_csrf';
const CSRF_HEADER = 'x-csrf-token';

/**
 * Double-submit cookie check, mirroring src/proxy.ts.
 *
 * src/proxy.ts enforces CSRF only on the API prefixes it lists, and
 * '/api/liquor' is not one of them — the five phases of this module are the
 * first routes under it. This is money, so rather than depend on a shared edit
 * to proxy.ts that four sibling phases would be making at the same moment,
 * every state-changing handler here runs the identical check itself. If
 * '/api/liquor' is added to CSRF_REQUIRED_PREFIXES later this becomes a
 * harmless second read of the same two values.
 *
 * Returns a 403 Response to hand straight back, or null to proceed.
 */
export function csrfGuard(request: Request): Response | null {
  const header = request.headers.get(CSRF_HEADER);
  const cookie = (request.headers.get('cookie') || '')
    .split(';')
    .map(c => c.trim())
    .find(c => c.startsWith(CSRF_COOKIE + '='));
  const cookieToken = cookie ? decodeURIComponent(cookie.slice(CSRF_COOKIE.length + 1)) : '';
  if (!cookieToken || !header || cookieToken !== header) {
    return Response.json({ error: 'CSRF token missing or mismatched. Refresh the page.' }, { status: 403 });
  }
  return null;
}

/**
 * THE GATE, applied identically to the read path and the write path — a write
 * path looser than its read path is how a user who cannot see a ledger ends up
 * able to post into it.
 *
 * page-catalog declares /inventory/liquor-wallet mgmtOnly and this enforces
 * BOTH halves of that:
 *   · canAccessPage(...) — the user's page map, resolved exactly as the sidebar
 *     and the proxy resolve it, so the API and the nav can never disagree; and
 *   · isManagement(...)  — because canAccessPage matches a grant BY PREFIX, so a
 *     bare '/inventory' grant (the seeded Store Manager holds one) would carry
 *     this page for a non-management user. The catalog says as much beside the
 *     entry: "This list is never the security boundary."
 */
export async function walletGate(): Promise<
  { error: Response; me: null } | { error: null; me: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>> }
> {
  const me = await getCurrentUser();
  if (!me) return { error: Response.json({ error: 'Sign in required' }, { status: 401 }), me: null };
  if (!canAccessPage(LQ_WALLET_PAGE, me) || !isManagement(me)) {
    return {
      error: Response.json({
        error: 'The TGBCL wallet is management-only — it is the working capital parked with the excise department.',
      }, { status: 403 }),
      me: null,
    };
  }
  return { error: null, me };
}

/**
 * Translate a WalletWriteError — or a constraint that got past it — into a
 * response the person can act on.
 *
 * The DB CHECKs and UNIQUE indexes are the BACKSTOP for this API's own guards.
 * When one of them fires it means something reached SQLite by another door, and
 * "CHECK constraint failed: lq_wallet_txns" names nothing anybody can act on —
 * so say which rule was broken.
 */
export function writeError(e: any): Response {
  if (e instanceof WalletWriteError) {
    return Response.json({ error: e.message, code: e.code }, { status: e.status });
  }
  const msg = String(e?.message || '');
  if (/uq_lq_wallet_opening/i.test(msg)) {
    return Response.json({
      error: 'This wallet already has an opening balance. Correct it with an adjustment instead — a second opening would double the balance.',
      code: 'opening_exists',
    }, { status: 409 });
  }
  if (/uq_lq_wallet_indent_debit|uq_lq_wallet_debit_source/i.test(msg)) {
    return Response.json({
      error: 'That indent is already debited. A second debit would double the spend — correct the amount with an adjustment.',
      code: 'debit_exists',
    }, { status: 409 });
  }
  if (/CHECK constraint failed/i.test(msg)) {
    return Response.json({
      error: 'The wallet refused that row: amounts are signed by type (opening and deposit positive, indent debit negative) and an indent debit must name its indent.',
      code: 'check_failed', detail: msg,
    }, { status: 400 });
  }
  if (/SQLITE_BUSY|database is locked|database table is locked/i.test(msg)) {
    return Response.json({
      error: 'Someone else was writing to the wallet at that moment, so NOTHING was recorded. Press Record again.',
      retry: true,
    }, { status: 503 });
  }
  return Response.json({ error: e?.message || 'Could not record the wallet movement.' }, { status: 500 });
}

/** YYYY-MM-DD, n days earlier. */
export function minusDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
