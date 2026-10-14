/**
 * TGBCL PORTAL WALLET — phase L2 of the Liquor Purchase Reconciliation module.
 *
 * Plan:   docs/liquor-reconciliation-plan.md  (§ "Phase L2")
 * Shapes: src/lib/liquor-recon.ts             (L0 contract — LqWalletTxn,
 *                                              LQ_WALLET_TXN_TYPES, LQ_BANK_MATCH)
 * Tables: the `lq_*` block at the foot of initializeSchema() in src/lib/db.ts
 *         (lq_wallet_txns, lq_portal_checks)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE RULE: THE RUNNING BALANCE IS SUM(amount) AND IS NEVER STORED.
 *
 * There is no balance column, no cached headline, no "closing balance" carried
 * on a row. Every figure this file returns — the wallet balance, the per-row
 * running balance, working capital parked, deposits utilised %, the top-up
 * shortfall — is recomputed from lq_wallet_txns on every read. A stored balance
 * drifts the moment one back-dated deposit is inserted, and the workbook's
 * Portal Wallet sheet re-derives its own balance every time it is opened for
 * exactly that reason.
 *
 * The ONE figure here that is stored without being computed is the OBSERVED
 * portal amount, and it lives in lq_portal_checks — never in lq_wallet_txns. A
 * row in the wallet is a MOVEMENT and enters SUM(amount); a portal reading is
 * not a movement, so storing it as one would corrupt the very balance it exists
 * to check. See recordPortalCheck() at the foot of this file.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHERE walletBalanceAsOf() LIVES, AND WHY IT IS NOT IN liquor-recon.ts
 * The L0 contract asks each phase to implement its shared helper *inside*
 * liquor-recon.ts. L2 cannot: liquor-recon.ts is owned by the phase building
 * alongside this one, and two builds editing one file lose each other's work.
 * The CONTRACT is kept verbatim — walletBalanceAsOf(db, { outletId, date }) →
 * { balance, lastTxnDate, depositTotal, debitTotal }, SUM(amount) up to and
 * including `date`, nothing stored, nothing cached — only the address differs:
 *   import { walletBalanceAsOf } from '@/lib/liquor-wallet';
 * L5 (§A wallet reconciliation, §A2 top-up planner) reads it from here. If L1
 * later wants the single-file arrangement back, liquor-recon.ts can re-export
 * this symbol; it must never grow a second implementation.
 *
 * ── THE THREE WRITE-PATH RULES L0's VERIFICATION LEFT FOR THIS FILE ──────────
 * L0 proved three ways the SCHEMA alone lets a wrong balance in. All three are
 * closed here, at the edge, because they are write-path rules, not shapes:
 *
 *  1. SIGN BY TYPE. `amount` is signed and the table CHECKs the sign, but a
 *     CHECK failure reaches a person as "CHECK constraint failed:
 *     lq_wallet_txns" — which names nothing they can act on. assertSign() below
 *     refuses first, in words, naming the type and the sign it requires. The
 *     CHECK stays as the backstop for anything that reaches SQLite another way.
 *
 *  2. THE OUTLET RULE — see walletOutletId(). uq_lq_wallet_indent_debit and
 *     uq_lq_wallet_opening are both keyed on COALESCE(outlet_id,''), and
 *     outlet_id is nullable with nothing in the schema to resolve it from
 *     (store_locations has no outlet_id). L0 measured the consequence: the same
 *     indent debited once with outlet_id NULL and once with it set passed both
 *     indexes and turned ₹1,000 of spend into ₹2,000. This module therefore
 *     keeps ONE wallet and writes outlet_id = NULL on EVERY row, from every
 *     path, so COALESCE(outlet_id,'') is the constant '' and both unique rules
 *     actually bite. Reads never filter by outlet either — a row that somehow
 *     carries one is still counted, because money you cannot see is worse than
 *     money filed under the wrong licence.
 *
 *  3. ONE OPENING, ONE DEBIT PER INDENT. uq_lq_wallet_opening and
 *     uq_lq_wallet_indent_debit enforce these once rule 2 makes their key
 *     stable; this file checks them first so the answer is a sentence rather
 *     than a constraint name, and treats the constraint error as the backstop.
 *     "The same indent" is decided by walletIndentKey() — TRIM + lowercase, the
 *     L0 contract's lqBillKey — because both indexes are BINARY and a case
 *     variant of one indent number was therefore debited TWICE with every
 *     integrity list reading clean. See walletIndentKey below.
 *
 * ── APPEND-ONLY, LIKE THE CASH BOX ──────────────────────────────────────────
 * There is no update and no delete of a wallet movement, deliberately — the
 * same rule src/app/api/petty-cash/route.ts states. A wrong figure is corrected
 * with an `adjustment` row that is itself visible, dated and attributed. The
 * ONE exception is the machine-written indent debit, which is re-derived when
 * its indent is re-saved (autoDebitForIndent) — that is not an edit of a human
 * decision, it is the same fact restated by its only source. A row a person
 * typed that the auto-debit ADOPTED keeps what they recorded (in its remark and
 * in audit_events) and is never deleted by a later correction: see ADOPTED_MARK.
 *
 * MONEY: rupees as REAL, rounded to paise on the way in. Sums are done in
 * INTEGER PAISE (CAST(ROUND(amount*100) AS INTEGER)) so a long ledger cannot
 * accumulate float drift into the headline.
 */

import type { Database } from 'better-sqlite3';
import { generateId, logAuditEvent } from './db';
import { recordError, maybeNotifyAdmins } from './error-alerts';
import { todayIST } from './format-date';
import type { LqWalletTxnType, LqBankMatch } from './liquor-recon';
import { LQ_WALLET_TXN_TYPES, LQ_BANK_MATCH, lqBillKey } from './liquor-recon';

/** The catalog path this module's page and API are gated on (mgmtOnly). */
export const LQ_WALLET_PAGE = '/inventory/liquor-wallet';

/** settings key: the top-up planner's rounding step, in ₹ (plan: "rounded UP
 *  to a configurable ₹10k"). */
export const LQ_TOPUP_STEP_KEY = 'lq_wallet_topup_step';
export const LQ_TOPUP_STEP_DEFAULT = 10000;

/* ── money ─────────────────────────────────────────────────────────────────── */

/**
 * Half AWAY FROM ZERO, which is what SQLite's ROUND() does — NOT Math.round(),
 * which is half UP (Math.round(-0.5) === -0, SQLite ROUND(-0.5) === -1).
 *
 * Two engines sum this ledger and both are shown on the same page: the JS one
 * (buildWalletView) and the SQL one (walletBalanceAsOf, CAST(ROUND(amount*100)
 * AS INTEGER)). A single row of −0.005 made them report ₹1,20,000 and
 * ₹1,19,999.99 for the same wallet. Nothing L2 writes can produce a sub-paise
 * amount — both doors round on the way in — but the plan's one-time Portal
 * Wallet history import will write by another route, and two balances that
 * disagree by a paise on one screen destroy trust in both.
 */
function roundHalfAwayFromZero(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/** ₹ → integer paise. */
export function toPaise(rupees: unknown): number {
  const n = Number(rupees);
  if (!Number.isFinite(n)) return 0;
  return roundHalfAwayFromZero(n * 100);
}
/** integer paise → ₹ (2dp). */
export function toRupees(paise: number): number {
  return roundHalfAwayFromZero(paise) / 100;
}
/** Round a ₹ figure to paise. */
export function r2(n: number): number {
  return roundHalfAwayFromZero(n * 100) / 100;
}

/**
 * THE INDENT KEY — how this wallet decides two references are the same indent.
 *
 * lqBillKey (the L0 contract, src/lib/liquor-recon.ts) is TRIM + lowercase, and
 * it is what the whole bill chain already uses: invoiceRefHasPurchases matches
 * COLLATE NOCASE, /procure-bulk's charges probe matches COLLATE NOCASE, and
 * getBillChargesForStore keys its map on the lower-cased ref. The wallet keyed
 * indents on the RAW string and was the one link in that chain that did not —
 * measured: `IND/2026/77` and `ind/2026/77` were debited twice for one ₹1,180
 * indent, with every integrity list reading clean, because the Liquor Store page
 * folds the two bills onto one key while the wallet held two debits.
 *
 * uq_lq_wallet_indent_debit is BINARY (it lives in db.ts, which this phase does
 * not own), so the index can only ever be the backstop for the byte-identical
 * case. This function is the real rule, applied on both write paths.
 *
 * Inner whitespace is deliberately NOT collapsed: "IND/ 9" is a different bill
 * to the register, to the charges table and to the dup guard on both bill
 * routes, and the wallet must not be the one place where it is the same one.
 */
export function walletIndentKey(reference: string | null | undefined): string {
  return lqBillKey(reference);
}

/* ── errors ────────────────────────────────────────────────────────────────── */

/**
 * A refusal the caller should hand to the user verbatim. `status` is the HTTP
 * status the route returns; `code` is machine-readable so the page can react
 * (e.g. offer "record an adjustment instead").
 */
export class WalletWriteError extends Error {
  status: number;
  code: string;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'WalletWriteError';
    this.code = code;
    this.status = status;
  }
}

/* ── the outlet rule (defect 2) ────────────────────────────────────────────── */

/**
 * THE OUTLET this module writes on every lq_wallet_txns and lq_portal_checks
 * row: always NULL.
 *
 * A TGBCL wallet belongs to a LICENCE, and outlet_id is the licence scope — but
 * nothing in the schema can resolve a licence from the thing that spends the
 * wallet. An indent is STORE-scoped (store_bill_charges → store_locations) and
 * store_locations has no outlet_id, so the auto-debit has no outlet to write
 * and NULL is what it naturally produces. If the hand-entered rows wrote the
 * signed-in user's current outlet instead, the same wallet would be split into
 * two ledgers whose unique indexes cannot see each other — which is precisely
 * how L0 measured ₹1,000 of indent becoming ₹2,000 of debit.
 *
 * So: ONE wallet, outlet_id NULL, written by every path through this function.
 * COALESCE(outlet_id,'') is then the constant '', which is what makes
 * uq_lq_wallet_indent_debit and uq_lq_wallet_opening real constraints instead
 * of decorations.
 *
 * THE DAY MULTI-LICENCE ARRIVES this function is the single place to change,
 * and the change is not just "return the outlet": store_locations must first
 * gain a licence/outlet link so the AUTO-debit can resolve the same value the
 * manual path does. Until both sides can agree, they must both say NULL.
 */
export function walletOutletId(): null {
  return null;
}

/* ── vocabulary + sign rules (defect 1) ────────────────────────────────────── */

export function isWalletTxnType(v: unknown): v is LqWalletTxnType {
  return typeof v === 'string' && (LQ_WALLET_TXN_TYPES as readonly string[]).includes(v);
}
export function isBankMatch(v: unknown): v is LqBankMatch {
  return typeof v === 'string' && (LQ_BANK_MATCH as readonly string[]).includes(v);
}

/** Human sentence for the sign a type demands — used in refusals and on the form. */
export function signRuleText(type: LqWalletTxnType): string {
  switch (type) {
    case 'opening':      return 'An opening balance is money already in the wallet, so it is recorded POSITIVE (₹0 is allowed for a wallet that started empty).';
    case 'deposit':      return 'A deposit pays money INTO the wallet, so it is recorded POSITIVE.';
    case 'indent_debit': return 'An indent debit spends money OUT of the wallet, so it is recorded NEGATIVE.';
    case 'adjustment':   return 'An adjustment is the ± correction row: positive adds to the wallet, negative takes away.';
  }
}

/**
 * REFUSE A WRONG SIGN, LOUDLY (L0 defect 1).
 *
 * The balance IS SUM(amount), so a positive indent_debit or a negative deposit
 * is a wrong balance with nothing downstream able to detect it — L0 measured a
 * ₹431,550 balance reading as ₹68,450 that way. The table CHECKs this too; this
 * runs first so the person sees which row broke which rule instead of
 * "CHECK constraint failed: lq_wallet_txns".
 *
 * Throws WalletWriteError. Returns the amount rounded to paise.
 */
export function assertSign(type: LqWalletTxnType, amount: number): number {
  if (!Number.isFinite(amount)) {
    throw new WalletWriteError('amount_not_a_number', 'Amount must be a number.');
  }
  const a = r2(amount);
  if (type === 'opening' || type === 'deposit') {
    if (a < 0) {
      throw new WalletWriteError(
        'wrong_sign',
        `${type === 'opening' ? 'An opening balance' : 'A deposit'} cannot be negative (₹${a.toFixed(2)}). ${signRuleText(type)} `
        + 'To take money OUT of the wallet, record an adjustment with a negative amount.',
      );
    }
    if (type === 'deposit' && a === 0) {
      throw new WalletWriteError('zero_amount', 'A ₹0 deposit records nothing — enter the challan amount.');
    }
  } else if (type === 'indent_debit') {
    if (a > 0) {
      throw new WalletWriteError(
        'wrong_sign',
        `An indent debit cannot be positive (₹${a.toFixed(2)}). ${signRuleText('indent_debit')} `
        + 'A spreadsheet export usually carries debits unsigned — negate them before importing.',
      );
    }
    if (a === 0) {
      throw new WalletWriteError('zero_amount', 'A ₹0 indent debit records nothing.');
    }
  } else if (type === 'adjustment') {
    if (a === 0) {
      throw new WalletWriteError('zero_amount', 'A ₹0 adjustment corrects nothing — enter the difference you are correcting.');
    }
  }
  return a;
}

/** A real calendar date in YYYY-MM-DD. "2026-02-31" matches the shape, sorts
 *  like a date and is not one — every window in this file is a string compare
 *  on this column, so a day that does not exist lands the money outside every
 *  report that should show it. */
export function isDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/* ── reads: the balance is always recomputed ───────────────────────────────── */

export interface WalletBalance {
  /** SUM(amount) in ₹ over every row up to and including `date`. MAY BE
   *  NEGATIVE and is never clamped — an overdrawn TGBCL wallet is a real state
   *  (a debit landed before the challan cleared), and hiding it behind a zero
   *  would tell the owner they have money they do not have. */
  balance: number;
  /** Latest `date` counted, '' when the wallet has no rows yet. */
  lastTxnDate: string;
  /** Σ of everything that ADDED to the wallet (opening + deposits + positive
   *  adjustments), ₹ positive. */
  depositTotal: number;
  /** Σ of everything that TOOK money out (indent debits + negative
   *  adjustments), ₹ positive (a magnitude, not a signed figure). */
  debitTotal: number;
}

/**
 * walletBalanceAsOf — the L0 shared contract, implemented here (see the file
 * header for why it is not in liquor-recon.ts).
 *
 * SUM(amount) over lq_wallet_txns up to and including `date`. Nothing stored,
 * nothing cached. Amounts are signed, so the sum IS the balance.
 *
 * `outletId` is part of the contract's shape and this module keeps ONE wallet
 * (walletOutletId() === null), so the only value it accepts is null/undefined.
 * A caller that passes a real outlet is REFUSED rather than silently answered
 * with ₹0 — a wallet page showing an empty ledger because of a filter is the
 * worst possible way to learn that multi-licence is not built yet.
 */
export function walletBalanceAsOf(
  db: Database,
  opts: { outletId?: string | null; date?: string | null } = {},
): WalletBalance {
  if (opts.outletId != null && String(opts.outletId).trim() !== '') {
    throw new WalletWriteError(
      'outlet_scoped_wallet',
      'This module keeps ONE TGBCL wallet (see walletOutletId in src/lib/liquor-wallet.ts). '
      + 'Per-outlet wallets need store_locations to carry a licence first, or the auto-debit and the '
      + 'manual rows would file the same money under two different scopes.',
      500,
    );
  }
  const date = isDate(opts.date) ? opts.date : null;
  const where = date ? 'WHERE date <= ?' : '';
  const args = date ? [date] : [];
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CAST(ROUND(amount * 100) AS INTEGER)), 0)                                  AS net_p,
      COALESCE(SUM(CASE WHEN amount > 0 THEN CAST(ROUND(amount * 100) AS INTEGER) END), 0)    AS in_p,
      COALESCE(SUM(CASE WHEN amount < 0 THEN CAST(ROUND(amount * 100) AS INTEGER) END), 0)    AS out_p,
      COALESCE(MAX(date), '')                                                                 AS last_date
    FROM lq_wallet_txns ${where}
  `).get(...args) as { net_p: number; in_p: number; out_p: number; last_date: string };
  return {
    balance: toRupees(row.net_p),
    lastTxnDate: row.last_date || '',
    depositTotal: toRupees(row.in_p),
    debitTotal: toRupees(-row.out_p),
  };
}

export interface WalletRow {
  id: string;
  date: string;
  type: LqWalletTxnType;
  reference: string;
  amount: number;
  payment_mode: string;
  bank_debit_date: string;
  bank_amount: number;
  bank_match: LqBankMatch;
  portal_status: string;
  source_ref: string;
  remarks: string;
  created_by: string;
  created_at: string;
  outlet_id: string | null;
  /** Σ of every row up to and including this one, in ledger order. NEVER stored. */
  running_balance: number;
  /** Machine-written from a recorded indent (source_ref set) → not hand-editable. */
  auto: boolean;
  /** Non-null when something about the row deserves a second look on the page. */
  anomaly: string | null;
}

/** Ledger order — the same tie-break the cash box uses, so a back-dated row
 *  lands in its date's place and two rows saved in the same second keep the
 *  order they were written in. */
const ORDER_SQL = 'ORDER BY date ASC, created_at ASC, rowid ASC';

/** A row worth a highlight on the page. Never blocks anything — the balance
 *  counts every row exactly as recorded. */
function rowAnomaly(
  r: { type: string; amount: number; reference: string; bank_match: string; bank_amount: number; date: string },
  today?: string,
): string | null {
  if (r.type === 'indent_debit' && r.amount > 0) return 'An indent debit recorded POSITIVE — it is ADDING to the wallet.';
  if ((r.type === 'deposit' || r.type === 'opening') && r.amount < 0) return 'Recorded negative — it is REDUCING the wallet.';
  if (r.type === 'indent_debit' && !String(r.reference || '').trim()) return 'Indent debit with no indent reference.';
  // A movement dated ahead of today is in the headline balance but outside every
  // as-of figure — including the portal check, which is the one comparison built
  // to catch a wallet disagreement. insertWalletTxn refuses one; a bill route
  // only shape-checks its date, so an auto-debit can still carry one in.
  if (today && r.date > today) return `Dated ${r.date} — in the FUTURE. It is in the headline balance but outside every as-at figure, including check A.`;
  if (r.type === 'deposit' && r.bank_match === 'verified' && r.bank_amount > 0
      && Math.abs(toPaise(r.bank_amount) - Math.abs(toPaise(r.amount))) > 0) {
    return 'Marked bank-verified, but the bank amount differs from the challan amount.';
  }
  return null;
}

export interface WalletSummary {
  /** The wallet as it stands over EVERY row, unbounded by the window — the
   *  headline. Negative is a real state and is shown as one. */
  balance: number;
  overdrawn: boolean;
  /** Money parked with TGBCL = the balance. Not clamped: when it is negative
   *  nothing is parked, TGBCL is carrying us, and that is what it says. */
  working_capital_parked: number;
  /** Everything that funded the wallet: opening + deposits + POSITIVE adjustments.
   *  The positive adjustments are counted GROSS: a +₹1,00,000 and a −₹1,00,000
   *  correction pair (the shape this ledger's own append-only rule produces) is
   *  ₹1,00,000 in and ₹1,00,000 out, not nothing in and nothing out. */
  funded_in: number;
  /** Everything that spent it: indent debits + NEGATIVE adjustments (magnitude,
   *  gross — see funded_in). */
  utilised_out: number;
  /** Σ of the positive adjustments alone (already inside funded_in). */
  adjustment_in: number;
  /** Σ of the negative adjustments alone, as a magnitude (already inside utilised_out). */
  adjustment_out: number;
  /** Movements dated AFTER today: counted in `balance`, outside every as-of
   *  figure (check A included). 0 unless the caller passed `today`. */
  future_dated_count: number;
  future_dated_total: number;
  /** utilised_out ÷ funded_in × 100. null when nothing has funded the wallet
   *  yet — a "0%" there would read as "we have spent nothing of a lot". */
  deposits_utilised_pct: number | null;
  opening_total: number;
  deposit_total: number;
  indent_debit_total: number;
  adjustment_net: number;
  /** Summary check C: deposits recorded but not yet matched to a bank debit. */
  bank_unconfirmed_count: number;
  bank_unconfirmed_total: number;
  row_count: number;
}

export interface WalletView {
  range: { from: string; to: string };
  /** Balance the day BEFORE `from` — the window's opening line. */
  opening_balance: number;
  /** Balance as at `to` (the running balance of the window's last row). */
  closing_balance: number;
  rows: WalletRow[];
  summary: WalletSummary;
  /** Rows outside the window still counted in `summary` / `balance`. */
  outside_window: number;
}

/**
 * The ledger, with a running balance on every row.
 *
 * The running balance is computed over EVERY row in ledger order and only then
 * sliced to the window, exactly like the cash box: a running balance computed
 * over a filtered set is a different number wearing the same label, and someone
 * will reconcile against it.
 */
export function buildWalletView(db: Database, from: string, to: string, today?: string): WalletView {
  const all = db.prepare(`
    SELECT id, outlet_id, date, type, reference, amount, payment_mode, bank_debit_date,
           bank_amount, bank_match, portal_status, source_ref, remarks, created_by, created_at
    FROM lq_wallet_txns ${ORDER_SQL}
  `).all() as any[];

  const todayStr = isDate(today) ? today : '';
  let runP = 0;
  let openingP = 0;
  const rows: WalletRow[] = [];
  let openP = 0, depP = 0, debP = 0, adjP = 0, adjInP = 0, adjOutP = 0;
  let futureN = 0, futureP = 0;
  for (const r of all) {
    const p = toPaise(r.amount);
    if (r.date < from) openingP += p;
    runP += p;
    if (r.type === 'opening') openP += p;
    else if (r.type === 'deposit') depP += p;
    else if (r.type === 'indent_debit') debP += p;
    else {
      adjP += p;
      // GROSS, not net: an adjustment pair that cancels in the balance still
      // moved money in and money out, and the card's own caption promises the
      // split ("opening + deposits + POSITIVE adjustments").
      if (p > 0) adjInP += p; else adjOutP += p;
    }
    if (todayStr && r.date > todayStr) { futureN++; futureP += p; }
    if (r.date >= from && r.date <= to) {
      rows.push({
        id: r.id,
        date: r.date,
        type: r.type,
        reference: r.reference || '',
        amount: toRupees(p),
        payment_mode: r.payment_mode || '',
        bank_debit_date: r.bank_debit_date || '',
        bank_amount: Number(r.bank_amount) || 0,
        bank_match: (r.bank_match === 'verified' ? 'verified' : 'pending'),
        portal_status: r.portal_status || '',
        source_ref: r.source_ref || '',
        remarks: r.remarks || '',
        created_by: r.created_by || '',
        created_at: r.created_at || '',
        outlet_id: r.outlet_id ?? null,
        running_balance: toRupees(runP),
        auto: !!String(r.source_ref || '').trim(),
        anomaly: rowAnomaly(r, todayStr || undefined),
      });
    }
  }

  const fundedP = openP + depP + adjInP;
  const utilisedP = -debP + -adjOutP;
  const bank = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(CAST(ROUND(amount * 100) AS INTEGER)), 0) AS p
    FROM lq_wallet_txns WHERE type = 'deposit' AND bank_match = 'pending'
  `).get() as { n: number; p: number };

  const balance = toRupees(runP);
  return {
    range: { from, to },
    opening_balance: toRupees(openingP),
    closing_balance: toRupees(
      rows.length ? toPaise(rows[rows.length - 1].running_balance) : openingP,
    ),
    rows,
    outside_window: all.length - rows.length,
    summary: {
      balance,
      overdrawn: runP < 0,
      working_capital_parked: balance,
      funded_in: toRupees(fundedP),
      utilised_out: toRupees(utilisedP),
      adjustment_in: toRupees(adjInP),
      adjustment_out: toRupees(-adjOutP),
      future_dated_count: futureN,
      future_dated_total: toRupees(futureP),
      deposits_utilised_pct: fundedP > 0 ? Math.round((utilisedP / fundedP) * 1000) / 10 : null,
      opening_total: toRupees(openP),
      deposit_total: toRupees(depP),
      indent_debit_total: toRupees(debP),
      adjustment_net: toRupees(adjP),
      bank_unconfirmed_count: bank.n,
      bank_unconfirmed_total: toRupees(bank.p),
      row_count: all.length,
    },
  };
}

/* ── the top-up planner (Summary §A2) ──────────────────────────────────────── */

export interface TopUpPlan {
  planned_indent: number;
  balance: number;
  /** planned − balance. NEGATIVE when the wallet already covers the indent. */
  shortfall: number;
  /** The rounding step actually used, ₹. */
  step: number;
  /** Shortfall rounded UP to the next whole `step`. ₹0 when there is no
   *  shortfall — never a "minimum top-up" nobody asked for. */
  recommended_challan: number;
  /** recommended − shortfall: what the rounding adds on top. 0 when the
   *  shortfall is already an exact multiple of the step. */
  rounding_add: number;
  /** Balance after paying the recommended challan and the planned indent. */
  balance_after: number;
  /** Present when the wallet already covers the planned indent. */
  surplus: number;
  /** The planned indent was NEGATIVE — an indent costs money, so this is a
   *  typo (a minus key hit while typing). Everything below is reported at ₹0
   *  rather than answered with a confident "you have ₹2,00,000 to spare". */
  planned_invalid: boolean;
}

/** Round ₹ UP to the next whole `step`. Exact multiples are left alone (₹50,000
 *  at a ₹10,000 step is ₹50,000, not ₹60,000) — done in integer paise so a
 *  float that is a hair over an exact multiple cannot push it a whole step up. */
export function roundUpTo(rupees: number, step: number): number {
  const stepP = toPaise(step);
  if (!(stepP > 0)) return r2(rupees);          // no step → no rounding
  const p = toPaise(rupees);
  if (p <= 0) return 0;
  return toRupees(Math.ceil(p / stepP) * stepP);
}

/**
 * Summary §A2: "planned next indent value → shortfall → recommended challan
 * rounded UP to a configurable ₹10k."
 *
 * Deliberate behaviours, each with a test in the build note:
 *   · shortfall ≤ 0 (the wallet already covers it)  → recommend ₹0, report the surplus.
 *   · shortfall an exact multiple of the step        → recommend it unchanged.
 *   · balance NEGATIVE                               → the shortfall is planned + the
 *     overdraft, because the challan has to clear the hole before it buys anything.
 *     (planned − balance does this on its own; the note is here so nobody
 *     "fixes" it by clamping the balance at zero.)
 */
export function topUpPlan(args: { planned_indent: number; balance: number; step: number }): TopUpPlan {
  const plannedRaw = r2(Number(args.planned_indent) || 0);
  const balance = r2(Number(args.balance) || 0);
  const step = Number(args.step) > 0 ? r2(Number(args.step)) : LQ_TOPUP_STEP_DEFAULT;
  // A NEGATIVE planned indent is a typo, not a plan: an indent takes money out
  // of the wallet. Answered as typed it reads "the wallet already covers this
  // indent, with ₹2,00,000 to spare" — a confident wrong answer on the one card
  // that decides how much money to send TGBCL. It is reported invalid instead.
  const plannedInvalid = plannedRaw < 0;
  const planned = plannedInvalid ? 0 : plannedRaw;
  const shortfall = plannedInvalid ? 0 : r2(planned - balance);
  const recommended = shortfall > 0 ? roundUpTo(shortfall, step) : 0;
  return {
    planned_indent: planned,
    balance,
    shortfall,
    step,
    recommended_challan: recommended,
    rounding_add: recommended > 0 ? r2(recommended - shortfall) : 0,
    balance_after: plannedInvalid ? balance : r2(balance + recommended - planned),
    surplus: !plannedInvalid && shortfall < 0 ? r2(-shortfall) : 0,
    planned_invalid: plannedInvalid,
  };
}

/** The configurable step, from settings. Anything unusable falls back to
 *  ₹10,000 rather than dividing by zero in roundUpTo. */
export function getTopUpStep(db: Database): number {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(LQ_TOPUP_STEP_KEY) as { value?: string } | undefined;
    const n = Number(row?.value);
    return Number.isFinite(n) && n > 0 ? r2(n) : LQ_TOPUP_STEP_DEFAULT;
  } catch { return LQ_TOPUP_STEP_DEFAULT; }
}

export function setTopUpStep(db: Database, rupees: number): number {
  const n = Number(rupees);
  if (!Number.isFinite(n) || n <= 0) {
    throw new WalletWriteError('bad_step', 'The rounding step must be more than ₹0 (the planner rounds the challan UP to a whole multiple of it).');
  }
  if (n > 10_000_000) {
    throw new WalletWriteError('bad_step', 'That rounding step is larger than ₹1 crore — check for an extra zero.');
  }
  const v = r2(n);
  // ₹0.001 passes `n > 0` and then STORES as "0", which getTopUpStep rejects and
  // silently replaces with ₹10,000 — while the page reports "step set to ₹0.00"
  // and the button reads "Round to ₹0.00" for a step the planner is not using.
  // The stored value is what must be usable, so the guard is on the stored value.
  if (!(v > 0)) {
    throw new WalletWriteError('bad_step', `A rounding step of ₹${n} rounds to ₹0.00, and the planner cannot round to a step of ₹0 — use ₹1 or more.`);
  }
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(LQ_TOPUP_STEP_KEY, String(v));
  return v;
}

/* ── writes: one guarded door for a hand-entered movement ──────────────────── */

export interface WalletTxnInput {
  date: string;
  type: LqWalletTxnType;
  amount: number;
  reference?: string;
  payment_mode?: string;
  bank_debit_date?: string;
  bank_amount?: number;
  bank_match?: string;
  portal_status?: string;
  remarks?: string;
}

/** ₹10 crore on ONE wallet row — a typo guard, not a business limit. */
const MAX_ROW = 100_000_000;

/**
 * Record ONE hand-entered wallet movement. Call INSIDE a transaction (the route
 * uses BEGIN IMMEDIATE, because every guard below is read-then-write).
 *
 * Refuses, with a sentence rather than a constraint name:
 *   · a wrong sign for the type                        (L0 defect 1)
 *   · a blank reference on an indent debit             (L0 defect 2)
 *   · a duplicate indent debit for the same reference  (L0 defect 2)
 *   · a SECOND opening row                             (L0 defect 3)
 *   · a future-dated movement, a non-calendar date, an absurd amount
 *
 * `source_ref` is NOT an input: it is store_bill_charges.id, the machine
 * identity of an auto-debit, and a hand-entered row must never be able to claim
 * one — that is the key uq_lq_wallet_debit_source hangs on.
 */
export function insertWalletTxn(
  db: Database,
  input: WalletTxnInput,
  actorEmail: string,
  today: string,
): { id: string } {
  const type = input.type;
  if (!isWalletTxnType(type)) {
    throw new WalletWriteError('bad_type', `type must be one of: ${LQ_WALLET_TXN_TYPES.join(', ')}.`);
  }
  if (!isDate(input.date)) {
    throw new WalletWriteError(
      'bad_date',
      /^\d{4}-\d{2}-\d{2}$/.test(String(input.date))
        ? `${input.date} is not a real date — there is no such day on the calendar.`
        : 'date must be YYYY-MM-DD.',
    );
  }
  if (isDate(today) && input.date > today) {
    throw new WalletWriteError('future_date', `Cannot record a wallet movement dated ${input.date} — that is in the future.`);
  }
  if (typeof input.amount !== 'number' && typeof input.amount !== 'string') {
    throw new WalletWriteError('amount_not_a_number', 'amount must be a number.');
  }
  const amount = assertSign(type, Number(input.amount));
  if (Math.abs(amount) > MAX_ROW) {
    throw new WalletWriteError('amount_too_large', 'That is over ₹10 crore on a single wallet row — check for an extra zero.');
  }

  const reference = String(input.reference ?? '').trim().slice(0, 120);
  // L0 defect 2, first half. The table CHECKs this too; refusing here says WHY.
  // A deposit's challan number stays optional on purpose — a challan can be
  // recorded before its number comes back — which is why this is scoped to the
  // one type whose identity IS its reference.
  if (type === 'indent_debit' && !reference) {
    throw new WalletWriteError(
      'blank_reference',
      'An indent debit must name its indent. Two blank-reference debits both slipped past the '
      + 'one-debit-per-indent rule once and doubled the spend.',
    );
  }
  const remarks = String(input.remarks ?? '').trim().slice(0, 500);
  // An adjustment is the one row that can move money in either direction with
  // no counterparty. Unexplained, it is indistinguishable from a mistake.
  if (type === 'adjustment' && !remarks) {
    throw new WalletWriteError(
      'adjustment_needs_remark',
      'An adjustment needs a remark — it moves money with no challan and no indent behind it, so the reason is the only record of why.',
    );
  }

  // L0 defect 3 — ONE opening per wallet. uq_lq_wallet_opening enforces it now
  // that walletOutletId() keeps the key stable; this says so in words, and says
  // what to do instead.
  if (type === 'opening') {
    const existing = db.prepare(`
      SELECT id, date, amount FROM lq_wallet_txns WHERE type = 'opening' LIMIT 1
    `).get() as { id: string; date: string; amount: number } | undefined;
    if (existing) {
      throw new WalletWriteError(
        'opening_exists',
        `This wallet already has an opening balance (₹${r2(existing.amount).toFixed(2)} on ${existing.date}). `
        + 'A second one would silently DOUBLE the balance every portal check is measured against. '
        + 'Correct the opening figure with an adjustment instead.',
        409,
      );
    }
  }

  // L0 defect 2, second half — ONE debit per indent. Checked here so the answer
  // names the existing row; uq_lq_wallet_indent_debit is the backstop.
  //
  // Matched on walletIndentKey (TRIM + lowercase), NOT on the raw string: a
  // byte-exact match let `IND/9`, `ind/9` and `IND/9` again through as three
  // debits of one indent, and a history import is exactly where a reference
  // arrives in a different case from the one already recorded.
  if (type === 'indent_debit') {
    const dup = db.prepare(`
      SELECT id, date, amount, reference, source_ref FROM lq_wallet_txns
      WHERE type = 'indent_debit' AND LOWER(TRIM(reference)) = ? LIMIT 1
    `).get(walletIndentKey(reference)) as { id: string; date: string; amount: number; reference: string; source_ref: string } | undefined;
    if (dup) {
      const sameCase = dup.reference === reference;
      throw new WalletWriteError(
        'debit_exists',
        `Indent "${reference}" is already debited (₹${r2(dup.amount).toFixed(2)} on ${dup.date})`
        + (sameCase ? '' : ` — recorded as "${dup.reference}"; indent numbers are matched ignoring case`)
        + (dup.source_ref ? ' — that row was created automatically from the recorded indent.' : '.')
        + ' A second debit would double the spend. Correct the amount with an adjustment.',
        409,
      );
    }
  }

  const bankMatch: LqBankMatch = isBankMatch(input.bank_match) ? input.bank_match : 'pending';
  const bankDebitDate = String(input.bank_debit_date ?? '').trim();
  if (bankDebitDate && !isDate(bankDebitDate)) {
    throw new WalletWriteError('bad_bank_date', 'bank_debit_date must be YYYY-MM-DD (or left blank).');
  }
  const bankAmountRaw = Number(input.bank_amount);
  const bankAmount = Number.isFinite(bankAmountRaw) ? r2(Math.abs(bankAmountRaw)) : 0;
  // Check C is "type='deposit' AND bank_match='pending'", so bank_match is
  // meaningless on the other three types and must stay at its default there —
  // otherwise a verified adjustment would look like a confirmed deposit to a
  // query that forgot the type half of the rule.
  const effectiveBankMatch: LqBankMatch = type === 'deposit' ? bankMatch : 'pending';
  if (type === 'deposit' && effectiveBankMatch === 'verified' && !bankDebitDate) {
    throw new WalletWriteError(
      'verify_needs_bank_date',
      'Marking a deposit bank-verified means the bank statement shows it — record the bank debit date too.',
    );
  }

  const id = generateId();
  db.prepare(`
    INSERT INTO lq_wallet_txns
      (id, outlet_id, date, type, reference, amount, payment_mode, bank_debit_date,
       bank_amount, bank_match, portal_status, source_ref, remarks, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)
  `).run(
    id, walletOutletId(), input.date, type, reference, amount,
    String(input.payment_mode ?? '').trim().slice(0, 60),
    bankDebitDate, bankAmount, effectiveBankMatch,
    String(input.portal_status ?? '').trim().slice(0, 120),
    remarks, actorEmail,
  );

  logAuditEvent(db, {
    event_type: 'liquor_wallet.record',
    entity_type: 'lq_wallet_txns',
    entity_id: id,
    actor_email: actorEmail,
    after: { date: input.date, type, reference, amount, bank_match: effectiveBankMatch, remarks },
    note: `TGBCL wallet: ${type} ₹${amount.toFixed(2)}${reference ? ' — ' + reference : ''}`,
  });
  return { id };
}

/* ── writes: the AUTO indent debit ─────────────────────────────────────────── */

export interface AutoDebitArgs {
  /** store_bill_charges.id — the debit's real identity (uq_lq_wallet_debit_source). */
  source_ref: string;
  /** The indent / invoice reference (store_bill_charges.invoice_ref). */
  reference: string;
  /** YYYY-MM-DD. Falls back to today when the bill carries no date. */
  date: string;
  /** The recorded Net Indent (invoice value + the four TGBCL levies), ₹ POSITIVE. */
  net_indent_value: number;
  store_id?: string;
  supplier?: string;
  created_by?: string;
}

/**
 * The stamp adoption leaves on a row it took over from a person, written into
 * `remarks` because lq_wallet_txns has no column for it and db.ts belongs to
 * another phase. It is machine-written text this function is the only author of,
 * and it is what tells a later correction "this movement was typed by a human —
 * do not delete it".
 */
const ADOPTED_MARK = ' [adopted a hand-entered debit';

export type AutoDebitAction = 'inserted' | 'updated' | 'adopted' | 'removed' | 'none' | 'failed';
export interface AutoDebitResult {
  action: AutoDebitAction;
  id: string | null;
  /** The signed ₹ written (negative), or 0 when no debit row exists after this. */
  amount: number;
  note: string;
  /** Present only on action 'failed': why the debit was not written. The bill
   *  WAS saved; this names what the wallet could not do alongside it. */
  error?: { code: string; message: string };
}

/** audit_events.event_type of a debit that could not be written alongside its
 *  saved bill. indentIntegrity() reads the newest one per indent back onto the
 *  wallet page's "recorded indents with no debit" list, so the reason travels
 *  with the gap instead of living only in a server log. */
export const LQ_AUTO_DEBIT_FAILED_EVENT = 'liquor_wallet.auto_debit_failed';

/**
 * AUTO-CREATE (or re-derive) THE WALLET DEBIT FOR ONE RECORDED INDENT — AND
 * NEVER TAKE THE BILL DOWN WITH IT.
 *
 * Called from upsertBillCharges() in src/lib/store-engine.ts, which is the ONE
 * place a Net Indent is ever written and which is itself called inside the
 * indent's own db.transaction() (/procure-bill and /procure-bulk).
 *
 * ── THE DECISION (2026-10-14): A WALLET-SIDE PROBLEM NEVER BLOCKS A BILL ──────
 * The TGBCL bill save is a DEPLOYED stock flow: it puts bottles on the Liquor
 * Store ledger that the bar is about to pour. The wallet is an analytics ledger
 * layered on top of it. This function used to throw straight through the bill's
 * transaction, so a missing lq_wallet_txns table, a CHECK, or two stores filing
 * one indent number rolled the WHOLE BILL back — measured on the DB copy: HTTP
 * 500 and zero ledger lines, zero charges rows, for a bill that had nothing
 * wrong with it. A delivery that cannot be booked is a far worse failure than a
 * wallet line that is late, so the priority is now explicit:
 *
 *   1. The debit is written in a SAVEPOINT nested inside the bill's own
 *      transaction (better-sqlite3 turns a nested db.transaction() into
 *      SAVEPOINT / RELEASE). On success it commits with the bill, exactly as
 *      before — the same-transaction promise is unchanged for every bill that
 *      can be debited.
 *   2. On ANY wallet-side throw the savepoint rolls back ONLY the wallet's own
 *      writes, the bill carries on and commits, and this returns action
 *      'failed'. Nothing is half-written: no debit, no stray adoption.
 *   3. The gap is never silent. The failure is (a) written to audit_events as
 *      LQ_AUTO_DEBIT_FAILED_EVENT against the store_bill_charges id, which
 *      indentIntegrity().missing reads back onto the wallet page with the
 *      reason; (b) filed in error_reports, the admin "App errors" bell; and
 *      (c) returned in the bill response as bill_charges.wallet_debit. The
 *      indent still has a positive Net Indent and no debit, so it is on the
 *      wallet page's "missing" list until somebody fixes it.
 *   4. Re-saving the bill (or its charges) after the cause is fixed re-runs this
 *      and writes the debit — the upsert is idempotent, so healing is a re-save.
 *
 * The ONE exception: if SQLite abandoned the OUTER transaction itself (disk
 * full, I/O error — db.inTransaction flips to false), there is no bill left to
 * protect, so the error is re-thrown and the bill route answers 500 exactly as
 * it would have without this module.
 *
 * IDEMPOTENT, and that matters more than it looks: upsertBillCharges is an
 * UPSERT, so re-saving a bill (a balance CSV re-upload, a corrected levy) calls
 * this again for the same store_bill_charges.id. Re-deriving must UPDATE the
 * one debit, never add a second.
 *
 *   1. A row already carrying this source_ref → UPDATE it.
 *   2. Otherwise a hand-entered debit for the SAME reference → ADOPT it: stamp
 *      the source_ref on and re-derive it. Without this step the INSERT below
 *      would hit uq_lq_wallet_indent_debit and take the whole indent down with
 *      it — a new failure mode bolted onto the existing bill flow, which this
 *      module must not create. Adopting is also the honest reading: the manual
 *      row was standing in for this indent.
 *   3. Otherwise INSERT.
 *
 * A NON-POSITIVE NET INDENT writes NO debit and removes any earlier one. A ₹0
 * indent spends nothing, and a negative Net Indent (only reachable when MRP
 * rounding exceeds the whole bill) is not a debit at all — writing it would
 * need a positive `amount` on an indent_debit, which the table refuses. The
 * wallet page's integrity panel lists indents with no debit, so nothing here
 * goes unseen.
 */
export function autoDebitForIndent(db: Database, args: AutoDebitArgs): AutoDebitResult {
  const outerTxn = db.inTransaction;
  try {
    // Nested inside the bill's transaction this is a SAVEPOINT: a throw rolls
    // back to it (undoing only what writeAutoDebit wrote) and re-throws here.
    return db.transaction(() => writeAutoDebit(db, args))();
  } catch (e: any) {
    if (outerTxn && !db.inTransaction) throw e;   // SQLite dropped the bill's own transaction
    return recordAutoDebitFailure(db, args, e);
  }
}

/** The wallet-side failure, recorded where it will be seen — and never thrown. */
function recordAutoDebitFailure(db: Database, args: AutoDebitArgs, e: any): AutoDebitResult {
  const reference = String(args.reference || '').trim().slice(0, 120);
  const sourceRef = String(args.source_ref || '').trim();
  const raw = String(e?.message || e || 'unknown error');
  const code = e instanceof WalletWriteError
    ? e.code
    : (/no such table/i.test(raw) ? 'wallet_table_missing' : 'wallet_write_failed');
  const message = code === 'wallet_table_missing'
    ? 'the TGBCL wallet table is not on this database'
    : raw;
  const net = toRupees(toPaise(args.net_indent_value));
  try {
    console.error(`[liquor-wallet] auto-debit NOT written for indent ${reference || '(no ref)'} (bill saved): ${code} — ${raw}`);
  } catch { /* logging must not fail a bill */ }
  if (sourceRef) {
    logAuditEvent(db, {          // swallows its own errors
      event_type: LQ_AUTO_DEBIT_FAILED_EVENT,
      entity_type: 'store_bill_charges',
      entity_id: sourceRef,
      actor_email: String(args.created_by || '').trim(),
      after: { reference, net_indent_value: net, store_id: args.store_id || '', code, message },
      note: `TGBCL wallet: indent ${reference} was SAVED but its wallet debit of ₹${net.toFixed(2)} was NOT written — ${message}`,
    });
  }
  try {
    // The admin "App errors" bell. One stable message per failure kind, so a
    // run of bills on a broken wallet collapses onto ONE open row with a count
    // instead of one row per indent; the indent itself is in `stack`.
    const res = recordError({
      source: 'server',
      message: `TGBCL wallet auto-debit failed (${code}) — the bill was saved, its wallet debit was not. Liquor Wallet → "recorded indents with no debit" lists each one.`,
      stack: `indent ${reference} · store_bill_charges ${sourceRef} · Net Indent ₹${net.toFixed(2)}\n${raw}`,
      url: '/inventory/liquor-wallet',
    });
    if (res?.isNew) void maybeNotifyAdmins(res);
  } catch { /* the reporter must never be the thing that fails a bill */ }
  return {
    action: 'failed',
    id: null,
    amount: 0,
    note: `The bill was saved, but its TGBCL wallet debit (₹${net.toFixed(2)} for ${reference || 'this indent'}) was NOT written: ${message}. `
      + 'The Liquor Wallet page lists it under recorded indents with no debit; re-saving the bill once the cause is fixed writes it.',
    error: { code, message },
  };
}

/** The write itself. Throws on any wallet-side problem; autoDebitForIndent is
 *  the only caller and turns a throw into a recorded, non-blocking 'failed'. */
function writeAutoDebit(db: Database, args: AutoDebitArgs): AutoDebitResult {
  const sourceRef = String(args.source_ref || '').trim();
  const reference = String(args.reference || '').trim().slice(0, 120);
  if (!sourceRef) {
    throw new WalletWriteError('auto_debit_no_source', 'autoDebitForIndent needs the store_bill_charges.id as source_ref — it is the debit\'s only stable identity.', 500);
  }
  if (!reference) {
    // The table CHECKs this; saying it here names the caller's bug. An indent
    // with no reference cannot be reconciled against the portal either.
    throw new WalletWriteError('auto_debit_no_reference', 'autoDebitForIndent needs the indent/invoice reference — an indent debit must name its indent.', 500);
  }
  // todayIST(), not the UTC date: this is the DEFAULT path (it fires whenever a
  // bill is saved with no date), and between 00:00 and 05:30 IST the UTC date is
  // still yesterday — every indent keyed in those hours was debited a day before
  // the business day it belongs to, ahead of the challan that funded it and
  // outside a window starting "today". Every other date in this module is IST.
  const date = isDate(args.date) ? args.date : todayIST();
  const netP = toPaise(args.net_indent_value);
  const existing = db.prepare(`
    SELECT id, amount, remarks FROM lq_wallet_txns WHERE type = 'indent_debit' AND source_ref = ? LIMIT 1
  `).get(sourceRef) as { id: string; amount: number; remarks: string } | undefined;

  if (!(netP > 0)) {
    // A row this function ADOPTED was typed by a person. Deleting it would take
    // a human's movement out of the balance inside somebody else's bill save,
    // in a ledger whose own rule is append-only — so an adopted row is kept and
    // the disagreement is left for indentIntegrity().mismatched to show. A
    // machine-written row is deleted as before: that is the same fact restated
    // by its only source, not the destruction of a human decision.
    if (existing && String(existing.remarks || '').includes(ADOPTED_MARK)) {
      logAuditEvent(db, {
        event_type: 'liquor_wallet.auto_debit_removal_skipped',
        entity_type: 'lq_wallet_txns',
        entity_id: existing.id,
        actor_email: args.created_by || '',
        before: { amount: existing.amount, reference, source_ref: sourceRef },
        after: { net_indent_value: toRupees(netP) },
        note: `TGBCL wallet: indent ${reference} now has a Net Indent of ₹${toRupees(netP).toFixed(2)}, but its debit was entered BY HAND and adopted — it was kept, not deleted.`,
      });
      return {
        action: 'none',
        id: existing.id,
        amount: r2(existing.amount),
        note: `Net Indent is ₹${toRupees(netP).toFixed(2)}, but the debit for ${reference} was entered by hand and adopted — it was KEPT (₹${r2(existing.amount).toFixed(2)}). Correct it with an adjustment; the wallet page lists it as no longer equal to its Net Indent.`,
      };
    }
    if (existing) {
      db.prepare('DELETE FROM lq_wallet_txns WHERE id = ?').run(existing.id);
      logAuditEvent(db, {
        event_type: 'liquor_wallet.auto_debit_removed',
        entity_type: 'lq_wallet_txns',
        entity_id: existing.id,
        actor_email: args.created_by || '',
        before: { amount: existing.amount, reference, source_ref: sourceRef },
        note: `TGBCL wallet: debit for indent ${reference} removed — its Net Indent is now ₹${toRupees(netP).toFixed(2)}`,
      });
      return { action: 'removed', id: null, amount: 0, note: `Net Indent is ₹${toRupees(netP).toFixed(2)} — the wallet debit was removed.` };
    }
    return { action: 'none', id: null, amount: 0, note: `Net Indent is ₹${toRupees(netP).toFixed(2)} — nothing to debit.` };
  }

  const amount = toRupees(-netP);            // SIGNED, negative. assertSign is the belt.
  assertSign('indent_debit', amount);
  const remarks = `Auto: indent ${reference}${args.supplier ? ' — ' + String(args.supplier).trim() : ''}`.slice(0, 500);
  const createdBy = String(args.created_by || '').trim();

  if (existing) {
    db.prepare(`
      UPDATE lq_wallet_txns
         SET date = ?, reference = ?, amount = ?, remarks = ?, outlet_id = ?, updated_at = datetime('now')
       WHERE id = ?
    `).run(date, reference, amount, remarks, walletOutletId(), existing.id);
    logAuditEvent(db, {
      event_type: 'liquor_wallet.auto_debit',
      entity_type: 'lq_wallet_txns',
      entity_id: existing.id,
      actor_email: createdBy,
      before: { amount: existing.amount },
      after: { date, reference, amount, source_ref: sourceRef },
      note: `TGBCL wallet: indent ${reference} re-saved — debit now ₹${amount.toFixed(2)}`,
    });
    return { action: 'updated', id: existing.id, amount, note: `Wallet debit updated to ₹${amount.toFixed(2)}.` };
  }

  // A debit already filed under this indent number that is NOT this indent.
  // Two cases, and they are not the same thing:
  //   · source_ref = ''  → a HAND-ENTERED debit standing in for this indent (a
  //     history import, or someone who recorded it before the indent was keyed
  //     in). ADOPT it below: stamp the source on and re-derive it. Without this
  //     the INSERT would hit uq_lq_wallet_indent_debit and the indent would be
  //     left with no debit of its own.
  //   · source_ref set   → ANOTHER recorded indent already claims this number.
  //     store_bill_charges is keyed UNIQUE(store_id, invoice_ref), so this can
  //     only be two DIFFERENT stores filing the same TGBCL indent number. The
  //     wallet is ONE wallet and cannot tell "two indents that share a number"
  //     from "one indent recorded twice", and guessing wrong DOUBLES the spend —
  //     the exact failure this module exists to prevent. So it refuses, by
  //     name. The refusal is the WALLET's, not the bill's: autoDebitForIndent
  //     rolls back to its savepoint, the bill is saved, and the indent sits on
  //     the wallet page's "no debit" list with this sentence beside it until the
  //     number is corrected — the wallet never silently absorbs it.
  //
  // Matched on walletIndentKey, so `IND/9` and `ind/9` are ONE indent here as
  // they already are to the register, to invoiceRefHasPurchases and to
  // /procure-bulk's charges probe. Byte-exact matching is how one ₹1,180 indent
  // became ₹2,360 of spend with the integrity panel reading clean.
  const sameRef = db.prepare(`
    SELECT id, amount, reference, COALESCE(source_ref,'') AS source_ref FROM lq_wallet_txns
     WHERE type = 'indent_debit' AND LOWER(TRIM(reference)) = ?
     ORDER BY CASE WHEN COALESCE(source_ref,'') = '' THEN 0 ELSE 1 END
     LIMIT 1
  `).get(walletIndentKey(reference)) as { id: string; amount: number; reference: string; source_ref: string } | undefined;
  if (sameRef && sameRef.source_ref) {
    throw new WalletWriteError(
      'debit_reference_conflict',
      `The TGBCL wallet already holds a debit of ₹${r2(sameRef.amount).toFixed(2)} for indent "${sameRef.reference}", `
      + (sameRef.reference === reference ? '' : `which is the same indent number as "${reference}" (case is ignored, exactly as the bill register ignores it) — `)
      + 'created from a different recorded bill. One wallet cannot tell two indents that share a number apart from '
      + 'one indent recorded twice, and guessing would double the spend — so this indent was NOT debited. '
      + 'Use the indent\'s real TGBCL number, or correct the other bill that is using it, then re-save.',
      409,
    );
  }
  const adoptable = sameRef && !sameRef.source_ref ? sameRef : undefined;
  if (adoptable) {
    // ADOPTION REWRITES A ROW A PERSON TYPED — its amount, its date and its
    // remark — inside somebody else's bill save (measured: −₹99,999 "my own
    // note" became −₹350 "Auto: indent …", moving the balance ₹99,649). It is
    // still the right call (the alternative is a unique-index failure that
    // leaves the indent undebited), but what the human recorded is carried INTO the row it
    // replaces, not left only in audit_events, and ADOPTED_MARK is what stops a
    // later correction deleting it. The reference is re-stamped to the indent's
    // own spelling so the ledger shows the number the bill was filed under.
    const prior = db.prepare('SELECT date, remarks FROM lq_wallet_txns WHERE id = ?').get(adoptable.id) as { date: string; remarks: string } | undefined;
    const priorRemark = String(prior?.remarks || '').trim();
    const adoptedRemarks = (
      remarks + ADOPTED_MARK + `: ₹${r2(adoptable.amount).toFixed(2)} dated ${prior?.date || '?'}`
      + (priorRemark ? ` — "${priorRemark}"` : '') + ']'
    ).slice(0, 500);
    db.prepare(`
      UPDATE lq_wallet_txns
         SET date = ?, reference = ?, amount = ?, source_ref = ?, remarks = ?, outlet_id = ?, updated_at = datetime('now')
       WHERE id = ?
    `).run(date, reference, amount, sourceRef, adoptedRemarks, walletOutletId(), adoptable.id);
    logAuditEvent(db, {
      event_type: 'liquor_wallet.auto_debit_adopted',
      entity_type: 'lq_wallet_txns',
      entity_id: adoptable.id,
      actor_email: createdBy,
      before: { amount: adoptable.amount, date: prior?.date || '', remarks: priorRemark, source_ref: '' },
      after: { date, reference, amount, source_ref: sourceRef },
      note: `TGBCL wallet: hand-entered debit for ${reference} (₹${r2(adoptable.amount).toFixed(2)} on ${prior?.date || '?'}) adopted by the recorded indent — now ₹${amount.toFixed(2)}`,
    });
    return {
      action: 'adopted',
      id: adoptable.id,
      amount,
      note: `A hand-entered debit for ${reference} of ₹${r2(adoptable.amount).toFixed(2)} (${prior?.date || '?'}) was adopted and re-derived to ₹${amount.toFixed(2)} — the wallet balance moved by ₹${r2(amount - adoptable.amount).toFixed(2)}.`,
    };
  }

  const id = generateId();
  db.prepare(`
    INSERT INTO lq_wallet_txns
      (id, outlet_id, date, type, reference, amount, payment_mode, bank_debit_date,
       bank_amount, bank_match, portal_status, source_ref, remarks, created_by)
    VALUES (?, ?, ?, 'indent_debit', ?, ?, '', '', 0, 'pending', '', ?, ?, ?)
  `).run(id, walletOutletId(), date, reference, amount, sourceRef, remarks, createdBy);
  logAuditEvent(db, {
    event_type: 'liquor_wallet.auto_debit',
    entity_type: 'lq_wallet_txns',
    entity_id: id,
    actor_email: createdBy,
    after: { date, reference, amount, source_ref: sourceRef, store_id: args.store_id || '' },
    note: `TGBCL wallet: indent ${reference} debited ₹${amount.toFixed(2)}`,
  });
  return { action: 'inserted', id, amount, note: `Wallet debited ₹${amount.toFixed(2)} for indent ${reference}.` };
}

/* ── integrity: the wallet vs the recorded indents ─────────────────────────── */

export interface IndentIntegrity {
  /** Recorded indents (store_bill_charges) with a positive Net Indent and NO
   *  wallet debit. Should be empty — a non-empty list means an indent was
   *  recorded before this module existed, its debit was deleted by hand, or the
   *  debit could not be written when the bill was saved. In that last case
   *  `failure` carries the reason (the newest LQ_AUTO_DEBIT_FAILED_EVENT for the
   *  indent); it is null otherwise. */
  missing: Array<{ source_ref: string; invoice_ref: string; date: string; net_indent_value: number; store: string; failure: string | null }>;
  /** Debits whose amount no longer matches their indent's Net Indent. */
  mismatched: Array<{ id: string; reference: string; debit: number; net_indent_value: number; diff: number }>;
  /** Debits with a source_ref that no longer names a recorded indent. */
  orphaned: Array<{ id: string; reference: string; amount: number }>;
  /** Indents recorded with a non-positive Net Indent — not debited, on purpose. */
  non_positive: Array<{ invoice_ref: string; date: string; net_indent_value: number }>;
  /** Liquor-store purchases recorded in the stock ledger that have NO bill-charges
   *  row, so no Net Indent was ever computed and NOTHING was debited. `missing`
   *  cannot see these — it selects FROM store_bill_charges. This is the CSV door:
   *  /procure-bulk only writes a charges row when a levy is non-zero, so a
   *  register uploaded with the four levy fields blank spends real TGBCL money
   *  and moves nothing here. */
  undebited: Array<{ invoice_ref: string; store: string; date: string; recorded_value: number }>;
  /** Wallet debits whose indent belongs to a store that is NOT the liquor store.
   *  upsertBillCharges is generic over stores and the Liquor Store page is a
   *  picker over every active store, so a grocery bill's charges debit this one
   *  TGBCL wallet. The debit is NOT blocked (which store may spend the wallet is
   *  the owner's call, and a floor bar is a store too) — it is named here so it
   *  can never be silent, which is what it was. */
  foreign_store: Array<{ id: string; reference: string; amount: number; store: string }>;
}

/** The store(s) this module treats as the TGBCL indent store, resolved by name
 *  exactly as every other phase of this module resolves it. Empty when nothing
 *  is named LIQUOR STORE — in which case the two store-scoped checks below say
 *  nothing rather than flagging every bill in the system. */
function liquorStoreIds(db: Database): string[] {
  try {
    return (db.prepare(
      `SELECT id FROM store_locations WHERE TRIM(name) = 'LIQUOR STORE' COLLATE NOCASE`,
    ).all() as Array<{ id: string }>).map(r => r.id);
  } catch { return []; }
}

/**
 * "The wallet can never disagree with recorded indents" is a promise the
 * same-transaction auto-debit keeps going forward. This is how the page PROVES
 * it, over history it did not write: every recorded indent should have exactly
 * one debit, of exactly its Net Indent.
 */
export function indentIntegrity(db: Database): IndentIntegrity {
  // `failure` is a correlated read of audit_events, served by idx_audit_entity
  // (entity_type, entity_id) and run at most 200 times (the LIMIT).
  const missing = db.prepare(`
    SELECT c.id AS source_ref, c.invoice_ref, COALESCE(c.date,'') AS date,
           c.net_indent_value, COALESCE(s.name,'') AS store,
           (SELECT a.note FROM audit_events a
             WHERE a.entity_type = 'store_bill_charges' AND a.entity_id = c.id
               AND a.event_type = ?
             ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1) AS failure
      FROM store_bill_charges c
      LEFT JOIN store_locations s ON s.id = c.store_id
     WHERE c.net_indent_value > 0
       AND NOT EXISTS (SELECT 1 FROM lq_wallet_txns w
                        WHERE w.type = 'indent_debit' AND w.source_ref = c.id)
     ORDER BY c.date DESC, c.invoice_ref
     LIMIT 200
  `).all(LQ_AUTO_DEBIT_FAILED_EVENT) as IndentIntegrity['missing'];

  const mismatched = db.prepare(`
    SELECT w.id, w.reference, w.amount AS debit, c.net_indent_value,
           ROUND(w.amount + c.net_indent_value, 2) AS diff
      FROM lq_wallet_txns w
      JOIN store_bill_charges c ON c.id = w.source_ref
     WHERE w.type = 'indent_debit'
       AND CAST(ROUND(w.amount * 100) AS INTEGER) <> -CAST(ROUND(c.net_indent_value * 100) AS INTEGER)
     ORDER BY w.date DESC
     LIMIT 200
  `).all() as IndentIntegrity['mismatched'];

  const orphaned = db.prepare(`
    SELECT w.id, w.reference, w.amount
      FROM lq_wallet_txns w
     WHERE w.type = 'indent_debit' AND COALESCE(w.source_ref,'') <> ''
       AND NOT EXISTS (SELECT 1 FROM store_bill_charges c WHERE c.id = w.source_ref)
     ORDER BY w.date DESC
     LIMIT 200
  `).all() as IndentIntegrity['orphaned'];

  const non_positive = db.prepare(`
    SELECT invoice_ref, COALESCE(date,'') AS date, net_indent_value
      FROM store_bill_charges WHERE net_indent_value <= 0
     ORDER BY date DESC LIMIT 200
  `).all() as IndentIntegrity['non_positive'];

  // The two store-scoped checks. Both go quiet when no store is named LIQUOR
  // STORE rather than guessing — a wrong guess here would either flag every
  // purchase in the system or flag none of them.
  const liqIds = liquorStoreIds(db);
  const inList = liqIds.map(() => '?').join(',');

  // GROUPED FIRST, then anti-joined. The obvious shape — a correlated NOT EXISTS
  // on every ledger row — re-scans store_bill_charges once per row and cannot use
  // an index through LOWER(TRIM(...)): measured at 3.4 SECONDS on 20,000 ledger
  // rows, which is one liquor year, on a panel that loads with the page.
  // Collapsing the ledger to one row per indent first turns that into 2,000
  // comparisons against a materialised key set (measured below 100 ms).
  const undebited = liqIds.length ? db.prepare(`
    WITH led AS (
      SELECT l.store_id                                  AS store_id,
             LOWER(TRIM(l.ref))                          AS k,
             MIN(TRIM(l.ref))                            AS invoice_ref,
             MIN(substr(l.created_at, 1, 10))            AS date,
             SUM(l.quantity * COALESCE(l.unit_cost, 0))  AS recorded_value
        FROM store_stock_ledger l
       WHERE l.store_id IN (${inList})
         AND l.txn_type IN ('purchase','inward')
         AND TRIM(COALESCE(l.ref,'')) <> ''
       GROUP BY l.store_id, LOWER(TRIM(l.ref))
    ),
    chg AS (
      SELECT store_id, LOWER(TRIM(invoice_ref)) AS k
        FROM store_bill_charges
       WHERE store_id IN (${inList})
    )
    SELECT led.invoice_ref, COALESCE(s.name,'') AS store, led.date,
           ROUND(led.recorded_value, 2) AS recorded_value
      FROM led
      LEFT JOIN store_locations s ON s.id = led.store_id
     WHERE led.recorded_value > 0
       AND NOT EXISTS (SELECT 1 FROM chg WHERE chg.store_id = led.store_id AND chg.k = led.k)
     ORDER BY led.date DESC
     LIMIT 200
  `).all(...liqIds, ...liqIds) as IndentIntegrity['undebited'] : [];

  const foreign_store = liqIds.length ? db.prepare(`
    SELECT w.id, w.reference, w.amount, COALESCE(s.name, c.store_id) AS store
      FROM lq_wallet_txns w
      JOIN store_bill_charges c ON c.id = w.source_ref
      LEFT JOIN store_locations s ON s.id = c.store_id
     WHERE w.type = 'indent_debit'
       AND c.store_id NOT IN (${inList})
     ORDER BY w.date DESC
     LIMIT 200
  `).all(...liqIds) as IndentIntegrity['foreign_store'] : [];

  return { missing, mismatched, orphaned, non_positive, undebited, foreign_store };
}

/* ── the portal check (Summary check A) — an OBSERVATION, not a movement ───── */

export interface PortalCheckResult {
  id: string;
  as_of_date: string;
  portal_amount: number;
  computed_balance: number;
  /** portal − computed. Positive: the portal shows MORE than we have recorded. */
  difference: number;
  /** The sentence that says which way round `difference` runs. The magnitude on
   *  its own cannot tell an owner whether to chase a missing indent or a missing
   *  challan, and "computed vs the portal" reads as the opposite subtraction. */
  difference_direction: string;
  matched: boolean;
  source: string;
  note: string;
  observed_by: string;
  created_at?: string;
  /** Set when this reading REPLACED an earlier reading for the same day (the
   *  row is upserted). Silently overwriting a morning reading with an evening
   *  one is how a wallet stops being watched around an indent. */
  replaced_amount?: number | null;
}

/** ₹ with Indian grouping, so a sentence built here reads like every figure the
 *  page prints beside it. */
function rs(n: number): string {
  return '₹' + r2(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Which way `difference` runs, in words. */
export function portalDifferenceText(difference: number): string {
  const p = toPaise(difference);
  if (p === 0) return 'The portal and the ledger agree.';
  return p > 0
    ? `The PORTAL holds ${rs(difference)} MORE than the ledger accounts for — look for a deposit we have not recorded, or an indent TGBCL has not charged yet.`
    : `The LEDGER claims ${rs(-difference)} MORE than the portal shows — look for a challan that never reached TGBCL, or an indent we have not recorded.`;
}

/**
 * Record what the TGBCL portal SHOWS, and report the difference against what we
 * COMPUTE. This is Summary check A.
 *
 * IT DOES NOT MOVE THE BALANCE, and it never can: it writes lq_portal_checks,
 * a table with no `amount` column that any balance query reads. A wallet row is
 * a MOVEMENT and enters SUM(amount) — filing an observation there would corrupt
 * the very figure it is meant to check, which is exactly why L0 created a
 * separate table for it.
 *
 * Upserted on (COALESCE(outlet_id,''), kind, reference, as_of_date) so re-typing
 * today's portal figure corrects today's reading instead of stacking readings.
 * The conflict target repeats the index's own expression, as SQLite requires.
 */
export function recordPortalCheck(
  db: Database,
  args: { as_of_date: string; portal_amount: number; source?: string; note?: string },
  actorEmail: string,
  today: string,
): PortalCheckResult {
  if (!isDate(args.as_of_date)) {
    throw new WalletWriteError(
      'bad_date',
      /^\d{4}-\d{2}-\d{2}$/.test(String(args.as_of_date))
        ? `${args.as_of_date} is not a real date — there is no such day on the calendar.`
        : 'as_of_date must be YYYY-MM-DD.',
    );
  }
  if (isDate(today) && args.as_of_date > today) {
    throw new WalletWriteError('future_date', `Cannot record a portal reading dated ${args.as_of_date} — that is in the future.`);
  }
  if (typeof args.portal_amount !== 'number' && typeof args.portal_amount !== 'string') {
    throw new WalletWriteError('amount_not_a_number', 'portal_amount must be a number.');
  }
  // Number('') and Number('   ') are 0, and 0 is finite — so an empty field was
  // recorded as a ₹0.00 READING and reported a full-balance difference. A
  // genuine ₹0 (and a negative) portal figure must stay recordable, so the
  // refusal is aimed at the blank string, not at the value.
  if (typeof (args.portal_amount as unknown) === 'string' && String(args.portal_amount).trim() === '') {
    throw new WalletWriteError(
      'blank_amount',
      'Type the balance the portal shows. A blank field would be stored as a ₹0.00 reading and reported as a difference the size of the whole wallet.',
    );
  }
  const portal = Number(args.portal_amount);
  if (!Number.isFinite(portal)) throw new WalletWriteError('amount_not_a_number', 'portal_amount must be a number.');
  if (Math.abs(portal) > MAX_ROW) {
    throw new WalletWriteError('amount_too_large', 'That portal figure is over ₹10 crore — check for an extra zero.');
  }
  // NOT clamped at zero: TGBCL can show an overdrawn wallet, and a reading we
  // refused to store is a check that silently never ran.
  const portalAmount = r2(portal);

  // What (if anything) this reading is about to overwrite. The row is upserted
  // on (outlet, kind, reference, as_of_date), which is right for correcting a
  // typo and wrong to do in silence: a morning and an evening reading of the
  // same day are two observations, and the first one vanished from the screen
  // with only audit_events remembering it.
  const priorRow = db.prepare(`
    SELECT portal_amount FROM lq_portal_checks
     WHERE COALESCE(outlet_id,'') = '' AND kind = 'wallet_balance' AND reference = '' AND as_of_date = ?
  `).get(args.as_of_date) as { portal_amount: number } | undefined;
  const replacedAmount = priorRow ? r2(Number(priorRow.portal_amount) || 0) : null;

  const id = generateId();
  db.prepare(`
    INSERT INTO lq_portal_checks
      (id, outlet_id, kind, as_of_date, reference, portal_amount, source, observed_by, note)
    VALUES (?, ?, 'wallet_balance', ?, '', ?, ?, ?, ?)
    ON CONFLICT (COALESCE(outlet_id,''), kind, reference, as_of_date) DO UPDATE SET
      portal_amount = excluded.portal_amount,
      source        = excluded.source,
      observed_by   = excluded.observed_by,
      note          = excluded.note,
      updated_at    = datetime('now')
  `).run(
    id, walletOutletId(), args.as_of_date, portalAmount,
    String(args.source ?? '').trim().slice(0, 120) || 'portal screen',
    actorEmail,
    String(args.note ?? '').trim().slice(0, 500),
  );

  const stored = db.prepare(`
    SELECT id, as_of_date, portal_amount, source, note, observed_by, created_at
      FROM lq_portal_checks
     WHERE COALESCE(outlet_id,'') = '' AND kind = 'wallet_balance' AND reference = '' AND as_of_date = ?
  `).get(args.as_of_date) as any;

  const computed = walletBalanceAsOf(db, { date: args.as_of_date }).balance;
  const difference = r2(portalAmount - computed);
  logAuditEvent(db, {
    event_type: 'liquor_wallet.portal_check',
    entity_type: 'lq_portal_checks',
    entity_id: stored?.id || id,
    actor_email: actorEmail,
    before: replacedAmount === null ? undefined : { portal_amount: replacedAmount },
    after: { as_of_date: args.as_of_date, portal_amount: portalAmount, computed_balance: computed, difference },
    note: `TGBCL portal check ${args.as_of_date}: portal ₹${portalAmount.toFixed(2)} vs computed ₹${computed.toFixed(2)} (difference ₹${difference.toFixed(2)})`
      + (replacedAmount === null ? '' : ` — replaced an earlier reading of ₹${replacedAmount.toFixed(2)} for the same day`),
  });

  return {
    id: stored?.id || id,
    as_of_date: args.as_of_date,
    portal_amount: portalAmount,
    computed_balance: computed,
    difference,
    difference_direction: portalDifferenceText(difference),
    matched: toPaise(difference) === 0,
    source: stored?.source || '',
    note: stored?.note || '',
    observed_by: stored?.observed_by || actorEmail,
    created_at: stored?.created_at,
    replaced_amount: replacedAmount,
  };
}

/* ── the per-indent portal check (Summary check B) — also an OBSERVATION ───── */

export interface IndentPortalCheckResult {
  id: string;
  as_of_date: string;
  /** The indent number as it was typed (trimmed). Matched to recorded indents
   *  ignoring case — walletIndentKey — exactly as the wallet and the bill
   *  register match them; the spelling itself is kept, never folded. */
  reference: string;
  portal_amount: number;
  /** The recorded indent this reading was compared against, or null when no
   *  recorded bill carries this number yet (a reading can be taken off the
   *  portal before the bill is keyed in — it is kept, and check B shows it as a
   *  reading with no indent behind it). */
  matched_invoice_ref: string | null;
  store: string | null;
  /** That indent's recorded Net Indent (invoice value + the four levies). */
  net_indent_value: number | null;
  /** portal − Net Indent. null when no recorded indent matched. */
  difference: number | null;
  difference_direction: string;
  matched: boolean | null;
  /** More than one recorded bill carries this number (two stores); the reading
   *  is compared against the LIQUOR STORE's, else the oldest, and says so. */
  warning: string | null;
  source: string;
  note: string;
  observed_by: string;
  created_at?: string;
  replaced_amount?: number | null;
}

/** The recorded indent(s) a reference names, LIQUOR STORE first. */
function recordedIndentsFor(db: Database, reference: string): Array<{ invoice_ref: string; net_indent_value: number; store: string }> {
  return db.prepare(`
    SELECT c.invoice_ref, c.net_indent_value, COALESCE(s.name,'') AS store
      FROM store_bill_charges c
      LEFT JOIN store_locations s ON s.id = c.store_id
     WHERE LOWER(TRIM(c.invoice_ref)) = ?
     ORDER BY CASE WHEN TRIM(COALESCE(s.name,'')) = 'LIQUOR STORE' COLLATE NOCASE THEN 0 ELSE 1 END, c.rowid
  `).all(walletIndentKey(reference)) as Array<{ invoice_ref: string; net_indent_value: number; store: string }>;
}

function indentComparison(db: Database, reference: string, portalAmount: number) {
  const hits = recordedIndentsFor(db, reference);
  const hit = hits[0];
  if (!hit) {
    return {
      matched_invoice_ref: null, store: null, net_indent_value: null, difference: null, matched: null,
      difference_direction: `No recorded bill carries indent "${reference}" yet — the reading is kept, and check B lists it as a reading with no indent behind it until the bill is recorded.`,
      warning: null as string | null,
    };
  }
  const net = r2(Number(hit.net_indent_value) || 0);
  const difference = r2(portalAmount - net);
  const p = toPaise(difference);
  return {
    matched_invoice_ref: hit.invoice_ref,
    store: hit.store || null,
    net_indent_value: net,
    difference,
    matched: p === 0,
    difference_direction: p === 0
      ? 'The portal and the recorded Net Indent agree.'
      : (p > 0
        ? `The PORTAL charged ${rs(difference)} MORE than the recorded Net Indent — check the bill's lines and its four levies against the indent PDF.`
        : `The recorded Net Indent is ${rs(-difference)} MORE than the portal charged — check for a line or a levy keyed in twice.`),
    warning: hits.length > 1
      ? `${hits.length} recorded bills carry this indent number (${hits.map(h => h.store || '?').join(', ')}); compared against ${hit.store || 'the first'}.`
      : null,
  };
}

/**
 * Record what the TGBCL portal shows as ONE INDENT's value, and report it
 * against that indent's recorded Net Indent. This is Summary check B's input —
 * nothing wrote kind='indent_value' before, so check B could never run.
 *
 * Like the wallet-balance reading it is an OBSERVATION in lq_portal_checks: it
 * moves no money, no stock and no Net Indent. One reading per indent per day:
 * re-typing the same day CORRECTS it (the indent is matched ignoring case, so
 * "IND/9" and "ind/9" on one day are one reading, not two); a later day files a
 * new reading, and check B uses the newest in its range.
 */
export function recordIndentPortalCheck(
  db: Database,
  args: { reference: string; as_of_date: string; portal_amount: number; source?: string; note?: string },
  actorEmail: string,
  today: string,
): IndentPortalCheckResult {
  const reference = String(args.reference ?? '').trim();
  if (!reference) {
    throw new WalletWriteError('blank_reference', 'Name the indent — a per-indent portal reading is compared against that indent\'s recorded Net Indent.');
  }
  if (reference.length > 120) {
    throw new WalletWriteError('bad_reference', 'That indent number is longer than 120 characters — check what was pasted.');
  }
  if (!isDate(args.as_of_date)) {
    throw new WalletWriteError(
      'bad_date',
      /^\d{4}-\d{2}-\d{2}$/.test(String(args.as_of_date))
        ? `${args.as_of_date} is not a real date — there is no such day on the calendar.`
        : 'as_of_date must be YYYY-MM-DD.',
    );
  }
  if (isDate(today) && args.as_of_date > today) {
    throw new WalletWriteError('future_date', `Cannot record a portal reading dated ${args.as_of_date} — that is in the future.`);
  }
  if (typeof args.portal_amount !== 'number' && typeof args.portal_amount !== 'string') {
    throw new WalletWriteError('amount_not_a_number', 'portal_amount must be a number.');
  }
  if (typeof (args.portal_amount as unknown) === 'string' && String(args.portal_amount).trim() === '') {
    throw new WalletWriteError('blank_amount', 'Type the indent value the portal shows — a blank field would be stored as a ₹0.00 reading.');
  }
  const portal = Number(args.portal_amount);
  if (!Number.isFinite(portal)) throw new WalletWriteError('amount_not_a_number', 'portal_amount must be a number.');
  if (portal < 0) {
    throw new WalletWriteError('wrong_sign', 'An indent value on the portal is what TGBCL charged for it — it cannot be negative. Type it without the minus sign.');
  }
  if (portal > MAX_ROW) {
    throw new WalletWriteError('amount_too_large', 'That indent value is over ₹10 crore — check for an extra zero.');
  }
  const portalAmount = r2(portal);
  const source = String(args.source ?? '').trim().slice(0, 120) || 'indent PDF';
  const note = String(args.note ?? '').trim().slice(0, 500);

  // The same indent on the same day, matched ignoring case: uq_lq_portal_check
  // is BINARY on `reference`, so the index alone would file "IND/9" and "ind/9"
  // as two readings of one indent and check B would count whichever was newer.
  const prior = db.prepare(`
    SELECT id, portal_amount FROM lq_portal_checks
     WHERE COALESCE(outlet_id,'') = '' AND kind = 'indent_value' AND as_of_date = ?
       AND LOWER(TRIM(reference)) = ?
     ORDER BY created_at DESC LIMIT 1
  `).get(args.as_of_date, walletIndentKey(reference)) as { id: string; portal_amount: number } | undefined;
  const replacedAmount = prior ? r2(Number(prior.portal_amount) || 0) : null;

  let id: string;
  if (prior) {
    // The reading keeps the spelling it was FIRST filed under; only the figure,
    // its source and who read it change.
    id = prior.id;
    db.prepare(`
      UPDATE lq_portal_checks
         SET portal_amount = ?, source = ?, observed_by = ?, note = ?, updated_at = datetime('now')
       WHERE id = ?
    `).run(portalAmount, source, actorEmail, note, id);
  } else {
    id = generateId();
    db.prepare(`
      INSERT INTO lq_portal_checks
        (id, outlet_id, kind, as_of_date, reference, portal_amount, source, observed_by, note)
      VALUES (?, ?, 'indent_value', ?, ?, ?, ?, ?, ?)
      ON CONFLICT (COALESCE(outlet_id,''), kind, reference, as_of_date) DO UPDATE SET
        portal_amount = excluded.portal_amount,
        source        = excluded.source,
        observed_by   = excluded.observed_by,
        note          = excluded.note,
        updated_at    = datetime('now')
    `).run(id, walletOutletId(), args.as_of_date, reference, portalAmount, source, actorEmail, note);
  }
  // Read back by the row's real key: on the ON CONFLICT half of the INSERT the
  // generated id above is discarded and the existing row's id stands.
  const stored = db.prepare(`
    SELECT id, reference, created_at FROM lq_portal_checks
     WHERE COALESCE(outlet_id,'') = '' AND kind = 'indent_value' AND as_of_date = ?
       AND (id = ? OR reference = ?)
     ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1
  `).get(args.as_of_date, id, reference, id) as { id: string; reference: string; created_at: string } | undefined;
  const storedRef = stored?.reference || reference;

  const cmp = indentComparison(db, storedRef, portalAmount);
  logAuditEvent(db, {
    event_type: 'liquor_wallet.portal_indent_check',
    entity_type: 'lq_portal_checks',
    entity_id: stored?.id || id,
    actor_email: actorEmail,
    before: replacedAmount === null ? undefined : { portal_amount: replacedAmount },
    after: { as_of_date: args.as_of_date, reference: storedRef, portal_amount: portalAmount, net_indent_value: cmp.net_indent_value, difference: cmp.difference },
    note: `TGBCL portal indent check ${storedRef} ${args.as_of_date}: portal ₹${portalAmount.toFixed(2)} vs recorded Net Indent `
      + (cmp.net_indent_value == null ? '(no recorded bill yet)' : `₹${cmp.net_indent_value.toFixed(2)} (difference ₹${(cmp.difference ?? 0).toFixed(2)})`)
      + (replacedAmount === null ? '' : ` — replaced an earlier reading of ₹${replacedAmount.toFixed(2)} for the same day`),
  });

  return {
    id: stored?.id || id,
    as_of_date: args.as_of_date,
    reference: storedRef,
    portal_amount: portalAmount,
    ...cmp,
    source,
    note,
    observed_by: actorEmail,
    created_at: stored?.created_at,
    replaced_amount: replacedAmount,
  };
}

/** The recorded per-indent readings, newest first, each re-compared against
 *  the indent's CURRENT recorded Net Indent (a corrected levy re-reads). */
export function listIndentPortalChecks(db: Database, limit = 50): IndentPortalCheckResult[] {
  const rows = db.prepare(`
    SELECT id, as_of_date, reference, portal_amount, source, note, observed_by, created_at
      FROM lq_portal_checks
     WHERE kind = 'indent_value'
     ORDER BY as_of_date DESC, created_at DESC
     LIMIT ?
  `).all(Math.max(1, Math.min(200, limit))) as any[];
  return rows.map(r => {
    const portalAmount = r2(Number(r.portal_amount) || 0);
    return {
      id: r.id,
      as_of_date: r.as_of_date,
      reference: r.reference || '',
      portal_amount: portalAmount,
      ...indentComparison(db, String(r.reference || ''), portalAmount),
      source: r.source || '',
      note: r.note || '',
      observed_by: r.observed_by || '',
      created_at: r.created_at || '',
    };
  });
}

/** The recorded portal readings, newest first, each with the balance we compute
 *  for the same day — so a reading taken before a back-dated deposit re-reads
 *  correctly instead of staying frozen at the difference it had that morning. */
export function listPortalChecks(db: Database, limit = 20): PortalCheckResult[] {
  const rows = db.prepare(`
    SELECT id, as_of_date, portal_amount, source, note, observed_by, created_at
      FROM lq_portal_checks
     WHERE kind = 'wallet_balance'
     ORDER BY as_of_date DESC, created_at DESC
     LIMIT ?
  `).all(Math.max(1, Math.min(200, limit))) as any[];
  return rows.map(r => {
    const computed = walletBalanceAsOf(db, { date: r.as_of_date }).balance;
    const difference = r2(Number(r.portal_amount) - computed);
    return {
      id: r.id,
      as_of_date: r.as_of_date,
      portal_amount: r2(Number(r.portal_amount) || 0),
      computed_balance: computed,
      difference,
      difference_direction: portalDifferenceText(difference),
      matched: toPaise(difference) === 0,
      source: r.source || '',
      note: r.note || '',
      observed_by: r.observed_by || '',
      created_at: r.created_at || '',
    };
  });
}

/* ── CSV ───────────────────────────────────────────────────────────────────── */

export function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  // A leading =, +, - or @ makes Excel treat the cell as a formula. Prefix with
  // a quote so a reference like "-INV/9" stays text.
  const safe = /^[=+\-@]/.test(s) ? "'" + s : s;
  return /[",\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}

export function walletCsv(view: WalletView): string {
  const lines: string[] = [];
  lines.push(['Date', 'Type', 'Reference', 'Amount (Rs)', 'Running balance (Rs)', 'Payment mode',
    'Bank debit date', 'Bank amount', 'Bank match', 'Portal status', 'Auto (from indent)',
    'Remarks', 'Recorded by'].map(csvCell).join(','));
  lines.push([`Opening balance before ${view.range.from}`, '', '', '', view.opening_balance, '', '', '', '', '', '', '', ''].map(csvCell).join(','));
  for (const r of view.rows) {
    lines.push([
      r.date, r.type, r.reference, r.amount.toFixed(2), r.running_balance.toFixed(2), r.payment_mode,
      r.bank_debit_date, r.bank_amount ? r.bank_amount.toFixed(2) : '', r.bank_match, r.portal_status,
      r.auto ? 'yes' : 'no', r.remarks, r.created_by,
    ].map(csvCell).join(','));
  }
  lines.push([`Closing balance at ${view.range.to}`, '', '', '', view.closing_balance, '', '', '', '', '', '', '', ''].map(csvCell).join(','));
  lines.push('');
  lines.push([`Wallet balance (all rows, unbounded by this window)`, view.summary.balance.toFixed(2)].map(csvCell).join(','));
  lines.push([`Working capital parked with TGBCL`, view.summary.working_capital_parked.toFixed(2)].map(csvCell).join(','));
  lines.push([`Funded in (opening + deposits + positive adjustments)`, view.summary.funded_in.toFixed(2)].map(csvCell).join(','));
  lines.push([`  of which positive adjustments`, view.summary.adjustment_in.toFixed(2)].map(csvCell).join(','));
  lines.push([`Utilised out (indent debits + negative adjustments)`, view.summary.utilised_out.toFixed(2)].map(csvCell).join(','));
  lines.push([`  of which negative adjustments`, view.summary.adjustment_out.toFixed(2)].map(csvCell).join(','));
  lines.push([`Deposits utilised %`, view.summary.deposits_utilised_pct === null ? 'n/a' : view.summary.deposits_utilised_pct.toFixed(1)].map(csvCell).join(','));
  lines.push([`Deposits not yet bank-confirmed`, view.summary.bank_unconfirmed_count, view.summary.bank_unconfirmed_total.toFixed(2)].map(csvCell).join(','));
  if (view.summary.future_dated_count > 0) {
    lines.push([`Movements dated in the FUTURE (in the balance, outside every as-at figure)`,
      view.summary.future_dated_count, view.summary.future_dated_total.toFixed(2)].map(csvCell).join(','));
  }
  return lines.join('\n');
}
