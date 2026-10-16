import { getDb } from '@/lib/db';
import { todayIST } from '@/lib/format-date';
import {
  LQ_TOPUP_STEP_DEFAULT,
  WalletWriteError, buildWalletView, getTopUpStep, setTopUpStep, indentIntegrity,
  insertWalletTxn, isDate, listPortalChecks, signRuleText, topUpPlan, walletCsv,
  walletBalanceAsOf, r2, retryAutoDebit,
} from '@/lib/liquor-wallet';
import { LQ_WALLET_TXN_TYPES } from '@/lib/liquor-recon';
import { csrfGuard, minusDays, walletGate, writeError } from './gate';

/**
 * TGBCL PORTAL WALLET — phase L2. Plan: docs/liquor-reconciliation-plan.md.
 *
 *   GET  /api/liquor/wallet?from=&to=&planned=&format=csv
 *        → the ledger with a running balance per row, the §A cards (computed
 *          balance, working capital parked, deposits utilised %, bank-unconfirmed
 *          deposits), the §A2 top-up planner, the recorded portal checks, and the
 *          wallet-vs-recorded-indents integrity list.
 *   POST /api/liquor/wallet
 *        → record ONE movement: { date, type, amount, reference?, payment_mode?,
 *          bank_debit_date?, bank_amount?, bank_match?, portal_status?, remarks? }
 *        → or { action: 'retry_auto_debit', source_ref }: write a recorded
 *          indent's missing auto-debit from the indent itself (retryAutoDebit).
 *   PUT  /api/liquor/wallet
 *        → { top_up_step } — the planner's configurable rounding step (₹10k).
 *
 * NO PUT AND NO DELETE OF A MOVEMENT, deliberately — the same rule the store
 * cash box states. A wallet ledger is append-only: a wrong figure is corrected
 * by an `adjustment` row that is itself dated, attributed and visible, not by a
 * silent edit of yesterday's number. The one field this API will never accept
 * from a form is `source_ref` — the machine identity of an auto-created indent
 * debit. It belongs to the recorded indent, and it is the key
 * uq_lq_wallet_debit_source hangs on.
 *
 * NOTHING HERE STORES A BALANCE. Every figure returned is recomputed from
 * lq_wallet_txns by src/lib/liquor-wallet.ts on each request.
 *
 * The gate, the CSRF check and the error translation live in ./gate.ts, shared
 * with the portal-check route (a route.ts may only export handlers + config).
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  try {
    const gate = await walletGate();
    if (gate.error) return gate.error;

    const db = getDb();
    const sp = new URL(request.url).searchParams;
    const today = todayIST();

    let from = sp.get('from') || minusDays(today, 89);
    let to   = sp.get('to')   || today;
    if (!isDate(from)) from = minusDays(today, 89);
    if (!isDate(to))   to   = today;
    if (from > to) { const t = from; from = to; to = t; }

    // `today` is passed so the view can name movements dated AFTER today: they
    // are inside the headline balance and outside every as-of figure, check A
    // included, and the page showed the two side by side with nothing said.
    const view = buildWalletView(db, from, to, today);

    if (sp.get('format') === 'csv') {
      return new Response(walletCsv(view), {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="tgbcl-wallet_${from}_to_${to}.csv"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    // §A2 planner. `planned` is a what-if the owner types; the step is the
    // stored, configurable one (default ₹10,000).
    const step = getTopUpStep(db);
    const plannedRaw = sp.get('planned');
    const planned = plannedRaw !== null && plannedRaw !== '' && Number.isFinite(Number(plannedRaw)) ? Number(plannedRaw) : 0;
    const plan = topUpPlan({ planned_indent: planned, balance: view.summary.balance, step });

    return Response.json({
      today,
      range: view.range,
      opening_balance: view.opening_balance,
      closing_balance: view.closing_balance,
      rows: view.rows,
      outside_window: view.outside_window,
      summary: view.summary,
      // The as-of balance for the portal-check card: the window's `to` date, so
      // the figure the owner compares is the one for the day they are reading.
      balance_as_of: walletBalanceAsOf(db, { date: to }),
      top_up: plan,
      top_up_step: step,
      top_up_step_default: LQ_TOPUP_STEP_DEFAULT,
      portal_checks: listPortalChecks(db, 20),
      integrity: indentIntegrity(db),
      types: LQ_WALLET_TXN_TYPES.map(t => ({ key: t, sign_rule: signRuleText(t) })),
      // Recording an indent debit BY HAND is a history-import / repair path —
      // the ordinary route is the recorded indent, which writes its own debit
      // inside the indent's transaction. The form offers these three.
      manual_types: ['opening', 'deposit', 'adjustment'],
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    if (e instanceof WalletWriteError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
    console.error('[/api/liquor/wallet GET]', e);
    return Response.json({ error: e?.message || 'Could not load the TGBCL wallet.' }, { status: 500 });
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

    // ── HEAL: write a recorded indent's missing debit FROM the recorded indent ──
    // { action: 'retry_auto_debit', source_ref } — the "Write the debit" button
    // on the "recorded indents with NO wallet debit" list. A bill whose debit
    // failed cannot be re-saved to heal it (/procure-bill refuses the recorded
    // invoice as a duplicate, and a re-upload that posts no new line never
    // reaches the debit), so this re-runs autoDebitForIndent on the indent's own
    // store_bill_charges row: the debit is keyed on that row exactly as a clean
    // save would have keyed it. No amount is accepted from the form — it is the
    // recorded Net Indent — and source_ref here NAMES the indent; it is never
    // written from the body. Same gate and CSRF as every other wallet write.
    // An indent dated BEFORE the wallet's opening balance is refused with 409
    // before_opening: the opening already includes it (retryAutoDebit).
    if (b.action !== undefined) {
      if (b.action !== 'retry_auto_debit') {
        return Response.json({ error: `Unknown action "${String(b.action).slice(0, 40)}" — the only action is retry_auto_debit.` }, { status: 400 });
      }
      // IMMEDIATE for the reason given below: the debit's guards read then write.
      const r = db.transaction(() => retryAutoDebit(db, String(b.source_ref ?? ''), me.email)).immediate();
      const balance = walletBalanceAsOf(db).balance;
      if (r.action === 'failed') {
        // Still failing: the cause is not fixed. Recorded again (audit + errors
        // bell) by autoDebitForIndent, exactly as on the bill save.
        return Response.json({ error: r.note, code: r.error?.code || 'auto_debit_failed', result: r, balance }, { status: 409 });
      }
      return Response.json({ result: r, balance }, { status: 200 });
    }

    const today = todayIST();
    let id = '';
    const txn = db.transaction(() => {
      id = insertWalletTxn(db, {
        date: String(b.date || '').trim(),
        type: b.type,
        amount: b.amount,
        reference: b.reference,
        payment_mode: b.payment_mode,
        bank_debit_date: b.bank_debit_date,
        bank_amount: b.bank_amount,
        bank_match: b.bank_match,
        portal_status: b.portal_status,
        remarks: b.remarks,
      }, me.email, today).id;
    });
    // BEGIN IMMEDIATE, not the default deferred BEGIN: every guard in
    // insertWalletTxn is read-then-write (is there already an opening? is this
    // indent already debited?). A deferred transaction takes only a read lock at
    // its first SELECT and tries to upgrade at the INSERT, so two saves racing
    // from different processes are decided after both have read — and the loser
    // aborts on a row that was in fact recordable, leaving the person unable to
    // tell whether it landed.
    txn.immediate();

    const row = db.prepare('SELECT * FROM lq_wallet_txns WHERE id = ?').get(id);
    const balance = walletBalanceAsOf(db).balance;
    return Response.json({
      entry: row,
      balance,
      // Not clamped, and said out loud: an overdrawn TGBCL wallet is a real
      // state (a debit landing before the challan clears) and the page shows it
      // rather than a comfortable zero.
      ...(balance < 0
        ? { warning: `The wallet is overdrawn by ₹${r2(-balance).toFixed(2)} — a deposit is due before the next indent.`, overdrawn: true }
        : {}),
    }, { status: 201 });
  } catch (e: any) {
    console.error('[/api/liquor/wallet POST]', e?.message);
    return writeError(e);
  }
}

export async function PUT(request: Request) {
  try {
    const csrf = csrfGuard(request);
    if (csrf) return csrf;
    const gate = await walletGate();
    if (gate.error) return gate.error;

    const b = await request.json().catch(() => null);
    if (!b || typeof b !== 'object') return Response.json({ error: 'Send a JSON body.' }, { status: 400 });
    if (b.top_up_step === undefined) {
      return Response.json({ error: 'Nothing to change — send { top_up_step }.' }, { status: 400 });
    }
    const db = getDb();
    const step = setTopUpStep(db, Number(b.top_up_step));
    return Response.json({ top_up_step: step });
  } catch (e: any) {
    return writeError(e);
  }
}
