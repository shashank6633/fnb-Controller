import { getDb } from '@/lib/db';
import { todayIST } from '@/lib/format-date';
import { listPortalChecks, recordPortalCheck, walletBalanceAsOf } from '@/lib/liquor-wallet';
import { csrfGuard, walletGate, writeError } from '../gate';

/**
 * SUMMARY CHECK A — computed wallet balance vs what the TGBCL portal SHOWS.
 *
 *   GET  /api/liquor/wallet/portal-check         → the recorded readings, each
 *        re-compared against the balance computed for its own as-of date.
 *   POST /api/liquor/wallet/portal-check
 *        { as_of_date, portal_amount, source?, note? }
 *        → records the reading and returns computed / portal / difference.
 *
 * ── THE POINT OF THIS ROUTE BEING SEPARATE FROM THE LEDGER ──────────────────
 * The portal figure is an OBSERVATION, not a movement. It is written to
 * lq_portal_checks — a table with no `amount` column that any balance query
 * reads — and it CANNOT move the wallet balance, because the balance is
 * SUM(lq_wallet_txns.amount) and nothing here touches that table.
 *
 * Filing the observation as a wallet row instead would have corrupted the very
 * figure it exists to check: a ₹4,31,550 portal reading recorded as a movement
 * makes the computed balance ₹8,63,100 and the check "passes" by having broken
 * itself. L0 created lq_portal_checks for exactly this, and the schema comment
 * beside it says so.
 *
 * Readings are UPSERTED on (outlet, kind, reference, as_of_date), so re-typing
 * today's figure CORRECTS today's reading rather than stacking a second one.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    const gate = await walletGate();
    if (gate.error) return gate.error;
    const db = getDb();
    return Response.json({
      today: todayIST(),
      balance: walletBalanceAsOf(db).balance,
      checks: listPortalChecks(db, 50),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    console.error('[/api/liquor/wallet/portal-check GET]', e);
    return Response.json({ error: e?.message || 'Could not load the portal checks.' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const csrf = csrfGuard(request);
    if (csrf) return csrf;
    const gate = await walletGate();
    if (gate.error) return gate.error;
    const me = gate.me;

    const b = await request.json().catch(() => null);
    if (!b || typeof b !== 'object') return Response.json({ error: 'Send a JSON body.' }, { status: 400 });

    const db = getDb();
    const result = recordPortalCheck(db, {
      as_of_date: String(b.as_of_date || '').trim(),
      portal_amount: b.portal_amount,
      source: b.source,
      note: b.note,
    }, me.email, todayIST());

    return Response.json({
      check: result,
      // Proof, returned to the caller on every write: the wallet balance is the
      // same before and after recording an observation.
      balance: walletBalanceAsOf(db).balance,
    }, { status: 201 });
  } catch (e: any) {
    console.error('[/api/liquor/wallet/portal-check POST]', e?.message);
    return writeError(e);
  }
}
