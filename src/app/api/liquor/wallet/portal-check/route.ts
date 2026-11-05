import { getDb } from '@/lib/db';
import { todayIST } from '@/lib/format-date';
import {
  listIndentPortalChecks, listPortalChecks, recordIndentPortalCheck, recordPortalCheck, walletBalanceAsOf,
} from '@/lib/liquor-wallet';
import { LQ_PORTAL_CHECK_KINDS } from '@/lib/liquor-recon';
import { csrfGuard, walletGate, writeError } from '../gate';

/**
 * SUMMARY CHECKS A AND B — what we RECORDED vs what the TGBCL portal SHOWS.
 *
 *   GET  /api/liquor/wallet/portal-check         → the recorded readings, each
 *        re-compared against today's computed figure for it:
 *          checks         — wallet-balance readings (check A)
 *          indent_checks  — per-indent readings (check B)
 *   POST /api/liquor/wallet/portal-check
 *        { kind?: 'wallet_balance' (default) | 'indent_value',
 *          as_of_date, portal_amount, reference? (required for indent_value),
 *          source?, note? }
 *        → records the reading and returns computed / portal / difference.
 *
 * `kind` is checked, never guessed. It used to be ignored: a per-indent figure
 * POSTed with kind 'indent_value' was filed as a WALLET-BALANCE reading for that
 * day (measured on the DB copy: an indent of ₹1,05,450.60 became the 2026-10-13
 * "portal balance" and check A failed by ₹1,39,098.80), and an unknown kind did
 * the same. An absent kind still means wallet_balance, so the wallet page's
 * existing form is unchanged; anything else that is not a known kind is a 400.
 *
 * ── THE POINT OF THIS ROUTE BEING SEPARATE FROM THE LEDGER ──────────────────
 * A portal figure is an OBSERVATION, not a movement. It is written to
 * lq_portal_checks — a table with no `amount` column that any balance query
 * reads — and it CANNOT move the wallet balance, because the balance is
 * SUM(lq_wallet_txns.amount) and nothing here touches that table. An indent
 * reading likewise never edits the indent's recorded Net Indent.
 *
 * Readings are UPSERTED per day, so re-typing today's figure CORRECTS today's
 * reading rather than stacking a second one.
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
      indent_checks: listIndentPortalChecks(db, 50),
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

    const kind = b.kind === undefined || b.kind === null || b.kind === '' ? 'wallet_balance' : b.kind;
    if (!(LQ_PORTAL_CHECK_KINDS as readonly unknown[]).includes(kind)) {
      return Response.json({
        error: `kind must be one of: ${LQ_PORTAL_CHECK_KINDS.join(', ')} — "wallet_balance" for the balance the portal shows, "indent_value" for one indent's value.`,
        code: 'bad_kind',
      }, { status: 400 });
    }

    const db = getDb();
    const today = todayIST();
    if (kind === 'indent_value') {
      const check = recordIndentPortalCheck(db, {
        reference: String(b.reference ?? ''),
        as_of_date: String(b.as_of_date || '').trim(),
        portal_amount: b.portal_amount,
        source: b.source,
        note: b.note,
      }, me.email, today);
      return Response.json({
        kind,
        check,
        // Proof, as on the balance path: an indent reading moves no money.
        balance: walletBalanceAsOf(db).balance,
      }, { status: 201 });
    }

    const result = recordPortalCheck(db, {
      as_of_date: String(b.as_of_date || '').trim(),
      portal_amount: b.portal_amount,
      source: b.source,
      note: b.note,
    }, me.email, today);

    return Response.json({
      kind,
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
