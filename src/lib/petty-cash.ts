import { getDb } from '@/lib/db';
import { getCurrentUser, isManagement } from '@/lib/auth';

/**
 * PETTY CASH — the store's physical cash box, as a ledger.
 *
 * Owner requirement 5: "how much in hand is there and how much is used for cash
 * purchases or delivery amount … clear purchase credit and debit logs".
 *
 * ── THE ONE RULE THIS FILE EXISTS TO ENFORCE ────────────────────────────────
 * The balance is DERIVED, never stored: cash in hand = Σ(in) − Σ(out) over
 * petty_cash_ledger. There is no `balance` column to drift, no nightly job to
 * miss a row, and no way for the headline figure and the log beneath it to
 * disagree — they are the same sum, computed by the same function.
 *
 * ── MONEY IS INTEGER PAISE, EVERYWHERE INSIDE ───────────────────────────────
 * `amount` is a SQLite REAL. Summing REALs gives you 0.30000000000000004, and
 * a period summary whose four numbers are off by 1e-15 is a period summary the
 * storekeeper cannot reconcile against a cash box. So every sum in this file is
 * done in INTEGER PAISE (`CAST(ROUND(amount*100) AS INTEGER)`) and converted to
 * rupees only at the very edge, once. opening + in − out == closing is then an
 * identity in integer arithmetic — it cannot fail to add up.
 *
 * ── THE SIGNING RULE (SQL and JS MUST stay in step) ─────────────────────────
 * SIGNED_PAISE_SQL and signedPaise() below are the same rule written twice, for
 * SQL aggregation and for JS row-walking. If you change one, change the other:
 * the running-balance column is JS, the opening balance is SQL, and they are
 * displayed side by side.
 *
 *   direction 'in'  + amount > 0  →  +paise
 *   direction 'out' + amount > 0  →  −paise
 *   anything else                 →   0, AND the row is reported as an anomaly
 *
 * That last line is deliberate. A row with a negative amount or a direction that
 * is neither 'in' nor 'out' cannot be signed honestly, so it contributes nothing
 * and is NAMED in the summary instead. The alternative — quietly guessing a sign
 * — is how a cash box ends up with a number nobody can tie to the notes in it.
 * The POST route refuses to create such a row; they can only arrive by hand-editing
 * the DB.
 */

type Db = ReturnType<typeof getDb>;

export type PettyDirection = 'in' | 'out';
export type PettyCategory =
  | 'float_topup'
  | 'cash_purchase'
  | 'delivery'
  | 'return'
  | 'adjustment';

export interface PettyCategoryDef {
  key: PettyCategory;
  label: string;
  /** Which directions this category may be recorded in. */
  allows: PettyDirection[];
  /** One line the storekeeper can read at the moment of recording. */
  help: string;
  /** Adjustments create or destroy cash with no counterparty → management only. */
  managementOnly?: boolean;
}

/**
 * CATEGORY IS REQUIRED — an unlabelled cash movement is how petty cash goes
 * missing. Each category also declares its legal direction(s), so "float top-up,
 * out" (which would be a nonsense that still balances) is refused at the door.
 */
export const PETTY_CATEGORIES: PettyCategoryDef[] = [
  { key: 'float_topup',   label: 'Float top-up',   allows: ['in'],  help: 'Cash put INTO the box — from the cashier, the safe or the owner.' },
  { key: 'cash_purchase', label: 'Cash purchase',  allows: ['out'], help: 'Cash paid OUT for goods bought against a bill / voucher.' },
  { key: 'delivery',      label: 'Delivery payment', allows: ['out'], help: 'Cash paid OUT for delivery / freight / hamali on a consignment.' },
  { key: 'return',        label: 'Return / refund', allows: ['in'],  help: 'Cash coming BACK — goods returned, unspent advance handed in.' },
  { key: 'adjustment',    label: 'Adjustment',     allows: ['in', 'out'], managementOnly: true,
    help: 'Correction to match a physical count. Management only — it moves cash with no counterparty.' },
];

const CATEGORY_BY_KEY = new Map(PETTY_CATEGORIES.map(c => [c.key, c]));

export function categoryDef(key: string): PettyCategoryDef | null {
  return CATEGORY_BY_KEY.get(key as PettyCategory) || null;
}
export function isPettyCategory(v: unknown): v is PettyCategory {
  return typeof v === 'string' && CATEGORY_BY_KEY.has(v as PettyCategory);
}
export function categoryLabel(key: string): string {
  return CATEGORY_BY_KEY.get(key as PettyCategory)?.label || (key || '—');
}

// ─── Money ──────────────────────────────────────────────────────────────────

/** Rupees → integer paise. Everything internal is paise. */
export function toPaise(rupees: unknown): number {
  const n = Number(rupees);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}
/** Integer paise → rupees, for the edge of the API only. */
export function toRupees(paise: number): number {
  return Math.round(paise) / 100;
}
/** ₹ display used in server-generated copy (refusal messages, CSV). */
export function fmtRs(paise: number): string {
  const neg = paise < 0;
  const abs = Math.abs(Math.round(paise));
  const s = (abs / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (neg ? '−₹' : '₹') + s;
}

/**
 * The signing rule, in SQL. MUST match signedPaise() exactly — see the header.
 * Guards `amount > 0` so a hand-edited negative amount contributes 0 rather than
 * flipping its own sign.
 */
export const SIGNED_PAISE_SQL = `
  CASE WHEN amount > 0 AND direction = 'in'  THEN  CAST(ROUND(amount * 100) AS INTEGER)
       WHEN amount > 0 AND direction = 'out' THEN -CAST(ROUND(amount * 100) AS INTEGER)
       ELSE 0 END`;

/**
 * Deterministic ledger order. The running balance is only meaningful against a
 * fixed order, and the same order is used by the tail scan in the negative-cash
 * guard, so the two can never disagree about "what comes after this entry".
 *
 * WHY rowid AND NOT id: `created_at` is `datetime('now')` — ONE-SECOND
 * resolution — so several movements recorded in the same second tie, and the
 * tiebreak then decides the running balance. Breaking the tie on the TEXT
 * PRIMARY KEY sorted a day's entries by random UUID: a proof run recorded a
 * ₹10,000 top-up first and three payments after it, and the log rendered the
 * top-up LAST, showing the box at −₹4,550.50 mid-day — a negative balance the
 * write guard had in fact prevented. `rowid` is SQLite's insertion counter, so
 * ties resolve in the order the cash actually moved.
 * (A VACUUM may renumber rowids on a table whose primary key is not an INTEGER,
 * but it rewrites rows in rowid order, so their relative order survives.)
 */
export const LEDGER_ORDER_SQL = 'ORDER BY date ASC, created_at ASC, rowid ASC';

export interface RawLedgerRow {
  id: string;
  outlet_id: string | null;
  date: string;
  direction: string;
  amount: number;
  category: string;
  purchase_id: string | null;
  vendor: string;
  reference: string;
  notes: string;
  recorded_by: string;
  created_at: string;
}

/** The signing rule, in JS. MUST match SIGNED_PAISE_SQL exactly. */
export function signedPaise(row: Pick<RawLedgerRow, 'direction' | 'amount'>): number {
  const p = toPaise(row.amount);
  if (!Number.isFinite(p) || p <= 0) return 0;
  if (row.direction === 'in') return p;
  if (row.direction === 'out') return -p;
  return 0;
}

/**
 * Why a row could not be signed, or null when it is sound. Anomalies are shown,
 * not swallowed — see the header.
 */
export function rowAnomaly(row: Pick<RawLedgerRow, 'direction' | 'amount' | 'category'>): string | null {
  const p = toPaise(row.amount);
  if (!Number.isFinite(p) || p <= 0) return 'amount is not a positive number — excluded from the balance';
  if (row.direction !== 'in' && row.direction !== 'out') return `direction "${row.direction}" is neither in nor out — excluded from the balance`;
  if (!isPettyCategory(row.category)) return `category "${row.category || '(blank)'}" is not a known petty-cash category`;
  return null;
}

// ─── Outlet scope ───────────────────────────────────────────────────────────

/**
 * Outlet filter, in the house convention used by every other store query:
 * the current outlet PLUS rows with no outlet stamped. Writes here always stamp
 * the current outlet (POST resolves getCurrentOutletId), so `outlet_id IS NULL`
 * only ever catches rows created before an outlet existed — and cash that is
 * invisible is worse than cash attributed to the default box.
 */
function scope(outletId: string | null): { sql: string; params: string[] } {
  if (!outletId) return { sql: '', params: [] };
  return { sql: ' AND (outlet_id = ? OR outlet_id IS NULL)', params: [outletId] };
}

// ─── Balances ───────────────────────────────────────────────────────────────

/**
 * Net paise over every row matching the scope, optionally bounded by date.
 * `before` is EXCLUSIVE (date < before) — that is the opening balance of a
 * period. `upto` is INCLUSIVE (date <= upto).
 */
function sumPaise(db: Db, outletId: string | null, bound?: { before?: string; upto?: string }): number {
  const s = scope(outletId);
  const where: string[] = ['1=1'];
  const params: string[] = [];
  if (bound?.before) { where.push('date < ?'); params.push(bound.before); }
  if (bound?.upto)   { where.push('date <= ?'); params.push(bound.upto); }
  const r = db.prepare(`
    SELECT COALESCE(SUM(${SIGNED_PAISE_SQL}), 0) AS paise
      FROM petty_cash_ledger
     WHERE ${where.join(' AND ')}${s.sql}
  `).get(...params, ...s.params) as { paise: number };
  return Math.round(Number(r?.paise) || 0);
}

/**
 * CASH IN HAND — the headline figure. Every row, no date bound.
 *
 * Safe to take unbounded because the POST route refuses a future-dated movement:
 * a petty-cash payment is a physical event that has already happened. So "every
 * row" and "every row up to today" are the same set, and the headline can never
 * include money the box does not hold yet.
 */
export function cashInHandPaise(db: Db, outletId: string | null): number {
  return sumPaise(db, outletId, {});
}

/** Opening balance of a period: everything strictly BEFORE `from`. */
export function openingPaise(db: Db, outletId: string | null, from: string): number {
  return sumPaise(db, outletId, { before: from });
}

// ─── The negative-cash guard ────────────────────────────────────────────────

export interface TailMinimum {
  /** Lowest running balance from the insert position onward, in paise. */
  min_paise: number;
  /** The date at which that low point occurs. */
  at_date: string;
}

/**
 * Lowest running balance from the point a movement dated `date` would sit, to
 * the end of the ledger.
 *
 * WHY A TAIL SCAN AND NOT JUST "current balance − amount":
 * a BACK-DATED payment does not only reduce today's balance; it reduces every
 * running balance from its own date forward by the same amount. Recording a
 * ₹5,000 payment dated last Monday can leave the box at −₹300 on Tuesday even
 * though today's balance is comfortable. Tuesday is a real day on which the
 * ledger claims the box held negative cash, so the entry has to be refused.
 *
 * INSERT POSITION: a new row's created_at is `now` and its rowid is the highest
 * yet, so under LEDGER_ORDER_SQL it sorts after every existing row of the same
 * date. Hence: prefix = date <= d, tail = date > d — and `prefix − amount` is
 * exactly the running balance the log will show on the new row. The guard and
 * the running-balance column are therefore the same arithmetic: if the guard
 * passes, the column cannot go negative.
 */
export function tailMinimum(db: Db, outletId: string | null, date: string): TailMinimum {
  const prefix = sumPaise(db, outletId, { upto: date });
  const s = scope(outletId);
  const tail = db.prepare(`
    SELECT date, (${SIGNED_PAISE_SQL}) AS paise
      FROM petty_cash_ledger
     WHERE date > ?${s.sql}
     ${LEDGER_ORDER_SQL}
  `).all(date, ...s.params) as { date: string; paise: number }[];

  let running = prefix;
  let min = prefix;
  let at = date;
  for (const r of tail) {
    running += Math.round(Number(r.paise) || 0);
    if (running < min) { min = running; at = r.date; }
  }
  return { min_paise: min, at_date: at };
}

export type GuardResult = { ok: true } | { ok: false; message: string; available_paise: number; at_date: string };

/**
 * REFUSE A PAYMENT THAT WOULD TAKE CASH IN HAND BELOW ZERO.
 *
 * Physical cash cannot be negative. If the ledger is allowed to go negative it
 * has stopped describing the box, and every figure downstream of it is fiction.
 * Money-in ('in') is never blocked — it can only raise every balance.
 */
export function guardOutflow(
  db: Db,
  outletId: string | null,
  date: string,
  direction: PettyDirection,
  amountPaise: number,
): GuardResult {
  if (direction !== 'out') return { ok: true };
  const { min_paise, at_date } = tailMinimum(db, outletId, date);
  if (amountPaise <= min_paise) return { ok: true };

  const shortfall = amountPaise - min_paise;
  const sameDay = at_date === date;
  const where = sameDay
    ? `Cash in hand on ${date} is ${fmtRs(min_paise)}`
    : `Cash in hand on ${date} covers it, but a later entry already spends it: the box would fall to ${fmtRs(min_paise - amountPaise)} on ${at_date} (lowest point after this one)`;
  return {
    ok: false,
    available_paise: min_paise,
    at_date,
    message:
      `${where}. Paying ${fmtRs(amountPaise)} would leave ${fmtRs(min_paise - amountPaise)} — ` +
      `short by ${fmtRs(shortfall)}. Physical cash cannot go negative, so this entry was not recorded. ` +
      `Record the float top-up that funded it first, or correct the amount.`,
  };
}

// ─── The log + the period summary ───────────────────────────────────────────

export interface LedgerRow extends RawLedgerRow {
  /** Rupees, signed by direction: +in / −out / 0 for an anomalous row. */
  signed: number;
  /** True cash-box running balance after this row, in rupees. */
  running_balance: number;
  category_label: string;
  /** Non-null when this row could not be signed — see rowAnomaly(). */
  anomaly: string | null;
}

export interface PeriodSummary {
  from: string;
  to: string;
  /** Rupees. opening + total_in − total_out === closing, exactly. */
  opening: number;
  total_in: number;
  total_out: number;
  closing: number;
  /** Always true by construction (integer paise). Present so the UI asserts it. */
  reconciles: boolean;
  /** Empty when reconciles; otherwise WHY the four numbers do not add up. */
  reconcile_note: string;
  rows_in_period: number;
  /** Rows in the period that contribute 0 because they could not be signed. */
  excluded_rows: number;
  /** Plain-English reasons, one per excluded row, ready to print. */
  excluded_notes: string[];
}

export interface FilteredTotals {
  category: string;
  category_label: string;
  rows: number;
  total_in: number;
  total_out: number;
  net: number;
}

export interface LedgerView {
  summary: PeriodSummary;
  /** Every row in the period, in ledger order, each with the TRUE running balance. */
  all_rows: LedgerRow[];
  /** `all_rows` narrowed by the category filter (=== all_rows when no filter). */
  rows: LedgerRow[];
  /** Set only when a category filter is applied — see the note in buildLedgerView. */
  filtered: FilteredTotals | null;
}

/**
 * The whole page's data, computed once so nothing on screen can disagree.
 *
 * TWO DELIBERATE CHOICES, both about not printing a number that lies:
 *
 * 1. RUNNING BALANCE IS THE TRUE CASH BOX. It is computed over EVERY row in the
 *    period, then rows are filtered for display. A running balance computed over
 *    only the "cash_purchase" rows would be a column of numbers that matches no
 *    cash box on earth.
 *
 * 2. THE PERIOD SUMMARY IGNORES THE CATEGORY FILTER. opened-with / in / out /
 *    closing describe the box, so they must reconcile; a filtered "in" and an
 *    unfiltered "opening" never would. The filtered subtotal is returned
 *    SEPARATELY as `filtered`, and the UI labels it as a subset of the period —
 *    never as a reconciliation.
 */
export function buildLedgerView(
  db: Db,
  outletId: string | null,
  from: string,
  to: string,
  category: string,
): LedgerView {
  const s = scope(outletId);
  const raw = db.prepare(`
    SELECT id, outlet_id, date, direction, amount, category, purchase_id,
           vendor, reference, notes, recorded_by, created_at
      FROM petty_cash_ledger
     WHERE date >= ? AND date <= ?${s.sql}
     ${LEDGER_ORDER_SQL}
  `).all(from, to, ...s.params) as RawLedgerRow[];

  const openPaise = openingPaise(db, outletId, from);

  let running = openPaise;
  let inPaise = 0;
  let outPaise = 0;
  const excluded: string[] = [];
  const all: LedgerRow[] = raw.map(r => {
    const p = signedPaise(r);
    const anomaly = rowAnomaly(r);
    // An anomalous row contributes 0 to BOTH the running balance and the in/out
    // totals — the same 0 — which is exactly why the identity below holds.
    if (p > 0) inPaise += p;
    else if (p < 0) outPaise += -p;
    if (anomaly) excluded.push(`${r.date} · ${fmtRs(toPaise(r.amount) || 0)} · ${anomaly}`);
    running += p;
    return {
      ...r,
      signed: toRupees(p),
      running_balance: toRupees(running),
      category_label: categoryLabel(r.category),
      anomaly,
    };
  });

  const closePaise = openPaise + inPaise - outPaise;
  // Integer paise: this identity cannot fail. It is asserted anyway, because a
  // summary that quietly stops adding up is the one failure this page must never
  // have — if a future edit breaks it, the page says so instead of printing it.
  const reconciles = closePaise === running;

  const summary: PeriodSummary = {
    from, to,
    opening: toRupees(openPaise),
    total_in: toRupees(inPaise),
    total_out: toRupees(outPaise),
    closing: toRupees(closePaise),
    reconciles,
    reconcile_note: reconciles
      ? ''
      : `Opening ${fmtRs(openPaise)} + in ${fmtRs(inPaise)} − out ${fmtRs(outPaise)} = ${fmtRs(closePaise)}, ` +
        `but walking the ${raw.length} rows of this period gives ${fmtRs(running)}. ` +
        `Do not act on these figures until the difference of ${fmtRs(Math.abs(closePaise - running))} is explained.`,
    rows_in_period: raw.length,
    excluded_rows: excluded.length,
    excluded_notes: excluded,
  };

  const def = categoryDef(category);
  let rows = all;
  let filtered: FilteredTotals | null = null;
  if (category) {
    rows = all.filter(r => r.category === category);
    let fin = 0, fout = 0;
    for (const r of rows) {
      const p = toPaise(r.signed);
      if (p > 0) fin += p; else if (p < 0) fout += -p;
    }
    filtered = {
      category,
      category_label: def ? def.label : category,
      rows: rows.length,
      total_in: toRupees(fin),
      total_out: toRupees(fout),
      net: toRupees(fin - fout),
    };
  }

  return { summary, all_rows: all, rows, filtered };
}

// ─── Write gates ────────────────────────────────────────────────────────────

export type WriteGate = 'anon' | 'denied' | 'ok';

/**
 * WHO MAY RECORD A MOVEMENT: management (admin / any manager / an HOD) PLUS the
 * store-manager flag — the same membership poHelpers.poWriteGate() uses for the
 * PO lifecycle (src/lib/po-helpers.ts:51), and for the same reason: the
 * storekeeper is the person who actually hands over the cash, and
 * is_store_manager is tier-independent, so gating on management alone would 403
 * exactly the people whose job this is.
 *
 * Reading is separate and looser (page access), because a storekeeper must be
 * able to see the box before spending from it.
 */
export async function pettyCashWriteGate(): Promise<WriteGate> {
  const user = await getCurrentUser();
  if (!user) return 'anon';
  return (isManagement(user) || user.is_store_manager) ? 'ok' : 'denied';
}

/**
 * ADJUSTMENT IS STRICTER: management only, no store-manager bypass.
 * Every other category has a counterparty — a top-up came from the safe, a
 * purchase has a bill. An adjustment is the one movement that can make cash
 * appear or vanish to match a count, i.e. the one that can paper over a
 * shortfall. The person holding the box must not be able to write it alone.
 */
export async function pettyCashAdjustGate(): Promise<WriteGate> {
  const user = await getCurrentUser();
  if (!user) return 'anon';
  return isManagement(user) ? 'ok' : 'denied';
}

// ─── CSV ────────────────────────────────────────────────────────────────────

export function csvCell(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * CSV of the log, for reconciling against the physical cash box.
 *
 * Carries the opening line and the closing line as rows of the file, so the
 * printout is self-checking: whoever counts the notes can read opening, add the
 * ins, subtract the outs and land on the closing figure without the app.
 */
export function ledgerCsv(view: LedgerView, opts: { from: string; to: string; outlet: string; category: string }): string {
  const { summary } = view;
  const lines: string[] = [];
  lines.push(['Petty cash log', opts.outlet || '', `${opts.from} to ${opts.to}`].map(csvCell).join(','));
  if (opts.category) lines.push(['Filtered to category', categoryLabel(opts.category)].map(csvCell).join(','));
  lines.push('');
  lines.push(['Date', 'In/Out', 'Amount', 'Category', 'Vendor', 'Reference', 'Notes', 'Recorded by', 'Recorded at', 'Running balance', 'Data warning'].map(csvCell).join(','));
  lines.push(['', '', '', 'OPENING BALANCE', '', '', `As at start of ${opts.from}`, '', '', summary.opening.toFixed(2), ''].map(csvCell).join(','));
  for (const r of view.rows) {
    lines.push([
      r.date,
      r.direction === 'in' ? 'IN' : r.direction === 'out' ? 'OUT' : r.direction,
      Number(r.amount || 0).toFixed(2),
      r.category_label,
      r.vendor,
      r.reference,
      r.notes,
      r.recorded_by,
      r.created_at,
      r.running_balance.toFixed(2),
      r.anomaly || '',
    ].map(csvCell).join(','));
  }
  lines.push('');
  lines.push(['', '', '', 'PERIOD SUMMARY'].map(csvCell).join(','));
  lines.push(['Opened with', summary.opening.toFixed(2)].map(csvCell).join(','));
  lines.push(['Cash in', summary.total_in.toFixed(2)].map(csvCell).join(','));
  lines.push(['Cash out', summary.total_out.toFixed(2)].map(csvCell).join(','));
  lines.push(['Closing (opening + in − out)', summary.closing.toFixed(2)].map(csvCell).join(','));
  if (view.filtered) {
    lines.push('');
    lines.push([`Rows shown above are filtered to "${view.filtered.category_label}" — the summary covers ALL categories in the period.`].map(csvCell).join(','));
    lines.push([`${view.filtered.category_label}: in`, view.filtered.total_in.toFixed(2)].map(csvCell).join(','));
    lines.push([`${view.filtered.category_label}: out`, view.filtered.total_out.toFixed(2)].map(csvCell).join(','));
  }
  if (!summary.reconciles) {
    lines.push('');
    lines.push(['DOES NOT RECONCILE', summary.reconcile_note].map(csvCell).join(','));
  }
  if (summary.excluded_rows > 0) {
    lines.push('');
    lines.push([`${summary.excluded_rows} row(s) excluded from the balance:`].map(csvCell).join(','));
    for (const n of summary.excluded_notes) lines.push(['', n].map(csvCell).join(','));
  }
  return lines.join('\n');
}
