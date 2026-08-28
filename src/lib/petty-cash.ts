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
 *
 * ⚠ THE `p <= 0 → 0` TEST IN signedPaise IS NOT A BALANCE CLAMP. It is the
 * positive-AMOUNT rule above, applied to ONE ROW's stored figure, and it must
 * not be relaxed or "fixed" now that the BALANCE may be negative. The two are
 * different numbers: `amount` is always positive and direction carries the sign,
 * while the running total is a signed sum of those. There is no MAX(0,…), no
 * ABS() and no clamp anywhere in this file's money path, which is exactly why a
 * negative balance renders, sums, reconciles and CSVs correctly.
 *
 * ── THE BALANCE MAY GO NEGATIVE, BY THE OWNER'S RULING ──────────────────────
 * A payment the box cannot fund is RECORDED and REPORTED, never refused — see
 * outflowWarning() for the full reasoning and for what was removed.
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
/** ₹ display used in server-generated copy (overdraft warnings, CSV, audit notes). */
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
/** The SAME order, qualified, for the one query that joins another table.
 *  goods_receipt_notes also has `date` and `created_at`, so an unqualified
 *  ORDER BY there is ambiguous — and an ORDER BY that silently resolved to the
 *  GRN's date would reorder the running balance. */
export const LEDGER_ORDER_SQL_P = 'ORDER BY p.date ASC, p.created_at ASC, p.rowid ASC';

export interface RawLedgerRow {
  id: string;
  outlet_id: string | null;
  date: string;
  direction: string;
  amount: number;
  category: string;
  purchase_id: string | null;
  /** The vendor bill this cash paid for, when it was recorded on Enter Vendor
   *  Bill with "Cash purchase" ticked. See src/lib/cash-purchase.ts. */
  grn_id: string | null;
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
function scope(outletId: string | null, prefix = ''): { sql: string; params: string[] } {
  if (!outletId) return { sql: '', params: [] };
  return { sql: ` AND (${prefix}outlet_id = ? OR ${prefix}outlet_id IS NULL)`, params: [outletId] };
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

// ─── The overdraft WARNING (this used to be a refusal) ──────────────────────

/**
 * ABSURDITY CEILING — ₹10,00,000 in ONE entry.
 *
 * Catches an extra zero, not a real movement. It lives here rather than in the
 * POST route because there are now TWO doors into this ledger: the petty cash
 * form, and "Cash purchase" on Enter Vendor Bill (src/lib/cash-purchase.ts). One
 * rule, one number — a ceiling that differs by door is not a ceiling.
 *
 * It is DIRECTION-BLIND and says nothing about the balance, so it never argues
 * with the overdraft rule below: it is about the size of a single figure a human
 * typed, not about what the box can fund.
 */
export const MAX_PAISE = 1_000_000_00;

export interface TailMinimum {
  /** Lowest running balance from the insert position onward, in paise. */
  min_paise: number;
  /** The date at which that low point occurs. */
  at_date: string;
  /** Balance at the insert position itself (everything dated <= `date`), in
   *  paise. Equal to min_paise only when the low point IS this position — the
   *  distinction the back-dated warning is worded around. */
  prefix_paise: number;
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
 * ledger claims the box held negative cash, so the entry is WARNED ABOUT — it is
 * recorded either way; see outflowWarning below for why the refusal went.
 *
 * INSERT POSITION: a new row's created_at is `now` and its rowid is the highest
 * yet, so under LEDGER_ORDER_SQL it sorts after every existing row of the same
 * date. Hence: prefix = date <= d, tail = date > d — and `prefix − amount` is
 * exactly the running balance the log will show on the new row.
 *
 * ⚠ THE MINIMUM IS NOT THAT ROW'S BALANCE. `min_paise` is the lowest point from
 * the insert position to the END of the book, so on a BACK-DATED entry the low
 * point belongs to a LATER date and `min_paise − amount` is a future trough, not
 * the figure the new row's running-balance cell will show. They coincide only
 * when at_date === date. outflowWarning's sentence is worded around that; do not
 * re-describe this as "the balance after this payment".
 *
 * IT SURVIVED THE REMOVAL OF THE REFUSAL BECAUSE IT IS THE ONLY THING THAT CAN
 * SEE A BACK-DATED HOLE. Nothing else in the system can say "this payment is
 * affordable today, but it puts the box at −₹200 on 25 Aug" — and a hole dug in
 * a past day almost always means a float top-up nobody wrote down, which is a
 * fact worth surfacing even though it is no longer a reason to refuse.
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
  return { min_paise: min, at_date: at, prefix_paise: prefix };
}

export type OutflowWarning = { overdrawn: false } | { overdrawn: true; message: string; available_paise: number; at_date: string };

/**
 * REPORT — DO NOT REFUSE — A PAYMENT THAT TAKES CASH IN HAND BELOW ZERO.
 *
 * ── THIS FUNCTION USED TO REFUSE, AND THE OWNER CHANGED THE RULE ────────────
 * It was `guardOutflow`, and it returned a hard 400: "Physical cash cannot go
 * negative, so this entry was not recorded." The argument written here for that
 * was: "If the ledger is allowed to go negative it has stopped describing the
 * box, and every figure downstream of it is fiction."
 *
 * The owner's ruling is the opposite, and it is the better one, because the
 * refusal made the app lie about a thing that had already physically happened:
 *
 *   · a storekeeper who spends ₹300 of his own money at the market has really
 *     spent it. Refusing the row does not un-spend it — it just leaves the box
 *     describing a payment nobody can see, and the money owed to a named person
 *     recorded nowhere at all;
 *   · the refusal had NO RECOVERY MODE. Once the ledger was under water by any
 *     route, EVERY further payment of any size was refused, ₹1 included, until
 *     somebody posted a top-up;
 *   · and it is a PRECONDITION for the cash-purchase feature. A cash bill writes
 *     the money and the goods in ONE transaction (src/lib/cash-purchase.ts), so
 *     a refusal here would have refused the STOCK and the PURCHASE LINE too —
 *     the storekeeper standing in the store holding vegetables the system
 *     insists were never bought.
 *
 * A negative balance is now a real, expected business state meaning either "the
 * box is owed a top-up" or "somebody is owed a reimbursement". It is shown in
 * red, it is explained, and a later float top-up clears it — money IN is never
 * warned about (it can only raise every balance).
 *
 * WHAT IS KEPT: the arithmetic, in full, as INFORMATION. The tail scan still
 * finds the lowest point from the insert position to the end of the book, so a
 * back-dated payment that digs a hole in a PAST day still says so — see
 * tailMinimum. Nothing is silently discarded; only the refusal is gone.
 */
export function outflowWarning(
  db: Db,
  outletId: string | null,
  date: string,
  direction: PettyDirection,
  amountPaise: number,
): OutflowWarning {
  if (direction !== 'out') return { overdrawn: false };
  const { min_paise, at_date, prefix_paise } = tailMinimum(db, outletId, date);
  if (amountPaise <= min_paise) return { overdrawn: false };

  const shortfall = amountPaise - min_paise;
  const sameDay = at_date === date;
  /* TWO SENTENCES, BECAUSE THEY ARE TWO DIFFERENT FACTS. On the same-day branch
   * the low point IS this row's own balance and "leaves" is literally true. On
   * the BACK-DATED branch it is a trough on a LATER date (see tailMinimum), and
   * this row's own running-balance cell will very often read a comfortable
   * positive figure — so "paying X leaves −Y" there names a number the reader
   * cannot find anywhere, printed beside one that contradicts it. Both figures
   * are therefore quoted, each labelled with the day it belongs to. THE
   * ARITHMETIC IS UNCHANGED; only the sentence is. */
  const message = sameDay
    ? `Cash in hand on ${date} is ${fmtRs(min_paise)}. Paying ${fmtRs(amountPaise)} leaves ${fmtRs(min_paise - amountPaise)} — `
      + `${fmtRs(shortfall)} more than the box holds. It was recorded anyway: the money really moved. `
      + `Record the float top-up that funds it and the balance comes back up.`
    : `Cash in hand on ${date} is ${fmtRs(prefix_paise)}, so paying ${fmtRs(amountPaise)} leaves ${fmtRs(prefix_paise - amountPaise)} `
      + `beside this entry. A later entry already spends it: the box reaches its lowest point of ${fmtRs(min_paise - amountPaise)} `
      + `on ${at_date} — ${fmtRs(shortfall)} more than it holds on that day. It was recorded anyway: the money really moved. `
      + `Record the float top-up that funds it and the balance comes back up.`;
  return { overdrawn: true, available_paise: min_paise, at_date, message };
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
  /** The receipt this cash paid for. Null on every row not linked to a bill. */
  grn_number: string | null;
  /** Its LIVE status — 'received' | 'partial' | 'awaiting_qc' | 'void'. */
  grn_status: string | null;
  /** What has happened to the GOODS, derived from that status — see goodsState(). */
  goods_state: GoodsState;
  /** One sentence a storekeeper can act on. Empty when there is nothing to say. */
  goods_note: string;
  /** True when the receipt was CORRECTED after this payment and is now worth a
   *  different figure — see amendedNote(). Independent of goods_state, because
   *  a correction can land on a receipt in any state. */
  goods_amended: boolean;
  /** The sentence for that, naming both figures. Empty when it is not. */
  goods_amended_note: string;
}

export type GoodsState = 'in_stock' | 'awaiting_qc' | 'voided' | 'rejected' | 'partial' | 'unknown' | null;

/**
 * WHAT HAPPENED TO THE GOODS THIS CASH PAID FOR — derived, never stored.
 *
 * The petty cash ledger is append-only ON PURPOSE (there is no PUT and no
 * DELETE — see api/petty-cash/route.ts), so the cash row cannot be edited when
 * the receipt behind it changes. It does not need to be: the receipt's own
 * status IS the fact, and reading it live means the log can never carry a stale
 * "awaiting check" on a bill the kitchen signed an hour ago.
 *
 * 'voided' IS THE ONE THAT MATTERS. Voiding a receipt reverses the stock and
 * DELETES its cost rows — and does not, cannot, return the cash. The money may
 * genuinely never have come back from the vendor. So the row stays exactly as
 * recorded and is MARKED, with the two honest remedies named: a Return (cash
 * IN) if the vendor refunded, an Adjustment if he did not. Nothing here writes
 * a compensating row on anyone's behalf.
 *
 * AND SO ARE 'rejected' AND 'partial', WHICH USED TO FALL THROUGH TO "IN STOCK".
 * A receipt the kitchen rejects outright is materially the SAME EVENT as a void
 * — money out, no stock, no cost row, a Return-or-Adjustment decision a human
 * has to make — and the cash book was labelling it `in_stock` with an empty
 * note, which is the one surface the physical box is counted against. 'partial'
 * is the softer half of the same fact: the cash was recorded on the RECEIVED
 * quantity (see the accumulation in POST /api/grn), so when some of it went
 * back the payment covers more than ever reached the shelf. Neither figure is
 * touched; both are named.
 */
export function goodsState(grnStatus: string | null | undefined, hasGrnLink: boolean): { state: GoodsState; note: string } {
  if (!hasGrnLink) return { state: null, note: '' };
  const s = String(grnStatus || '').trim();
  if (!s) {
    return {
      state: 'unknown',
      note: 'This payment names a goods receipt that can no longer be found. The cash stands as recorded — check the receipt before reconciling.',
    };
  }
  if (s === 'void') {
    return {
      state: 'voided',
      note: 'The goods receipt was VOIDED — the stock was reversed and its cost rows removed. This cash was NOT returned to the box by that void, because voiding a receipt cannot know whether the vendor refunded. If the money came back, record a Return; if it did not, record an Adjustment.',
    };
  }
  if (s === 'awaiting_qc') {
    return {
      state: 'awaiting_qc',
      note: 'The cash has left the box, but the goods are held for a kitchen quality check — they are not in stock and not on the Purchase Report yet. Both arrive when the check is signed.',
    };
  }
  if (s === 'rejected') {
    return {
      state: 'rejected',
      note: 'The goods were REJECTED at the quality check — nothing entered stock and no cost row was written, so this payment has no purchase behind it. The cash was NOT returned to the box by that rejection. If the money came back, record a Return; if it did not, record an Adjustment.',
    };
  }
  if (s === 'partial') {
    return {
      state: 'partial',
      note: 'Some of this delivery was refused, and the cash was recorded on the quantity RECEIVED — so this payment covers more than reached the shelf. That is right when the money was handed over at the stall for the whole lot. If the vendor took the refused goods back and returned the money, record a Return.',
    };
  }
  return { state: 'in_stock', note: '' };
}

/**
 * THE RECEIPT WAS CORRECTED AFTER THE MONEY WAS RECORDED.
 *
 * goodsState() above reads goods_receipt_notes.status, and a LINE CORRECTION
 * does not change it: a ₹2,000.00 cash bill amended down to ₹400.00 of goods
 * stayed `received`, so the cash book called it an ordinary in-stock purchase
 * with an empty note and a ₹1,600.00 gap between what the box paid and what the
 * receipt is now worth was legible nowhere. The PATCH response says it — but
 * that closes the moment, not the record, and the record is what the physical
 * box is counted against months later.
 *
 * BOTH CONDITIONS, AND THE VALUE ONE IS THE LOAD-BEARING HALF:
 *  · `editCount > 0` — the receipt was actually amended. PUT /api/grn/[id]
 *    bumps this for a HEADER change too (typing the vendor's real bill number
 *    over our voucher is a flow this feature invites), so on its own it would
 *    mark a receipt nobody re-valued.
 *  · the amounts differ — which is the fact worth printing, and the reason the
 *    header-only amendment above stays silent: it leaves the value untouched.
 *
 * ONE RUPEE OF TOLERANCE, not zero. The payment is accumulated line by line at
 * inward from the same figures the GRN rows are written from, so on whole
 * quantities the two agree to the paisa — but a FRACTIONAL quantity can round a
 * paisa differently between the accumulation and a SUM over the stored rows.
 * Marking a receipt as re-valued over one paisa would be a false alarm on the
 * one surface that must not cry wolf; a real correction is never that small.
 *
 * NOTHING IS RECOMPUTED AND NO FIGURE IS CHANGED. The ledger row stands exactly
 * as recorded — this only says out loud that the receipt behind it no longer
 * matches it, and names both numbers so a human can decide which is right.
 */
const AMEND_TOLERANCE_PAISE = 100;
export function amendedNote(
  editCount: number,
  paidPaise: number,
  inwardPaise: number | null,
): { amended: boolean; note: string } {
  if (!(Number(editCount) > 0)) return { amended: false, note: '' };
  if (inwardPaise === null || !Number.isFinite(inwardPaise)) return { amended: false, note: '' };
  const diff = inwardPaise - paidPaise;
  if (Math.abs(diff) <= AMEND_TOLERANCE_PAISE) return { amended: false, note: '' };
  return {
    amended: true,
    note: `The goods receipt was CORRECTED after this payment: ${fmtRs(paidPaise)} left the box, but the receipt is now worth ${fmtRs(inwardPaise)} `
        + `— ${fmtRs(Math.abs(diff))} ${diff < 0 ? 'less' : 'more'} than was paid. The cash row stands as recorded, because correcting a bill cannot know whether the vendor `
        + `gave any money back. If he did, record a Return; if he did not, the box is genuinely ${diff < 0 ? 'short' : 'over'} and an Adjustment says so.`,
  };
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
  const s = scope(outletId, 'p.');
  // ── THE GRN JOIN IS DISPLAY ONLY, AND IT IS A LEFT JOIN FOR A REASON ──────
  // Nothing about the BALANCE reads it: sumPaise, openingPaise and tailMinimum
  // still touch petty_cash_ledger alone, so a missing or voided receipt can
  // never change a rupee of the cash box. This adds one column of TRUTH ABOUT
  // THE GOODS beside each payment — and a LEFT JOIN so a row whose receipt has
  // somehow gone (or a legacy row with no grn_id at all) still appears, with
  // its money intact, rather than vanishing out of a reconciliation.
  // Aliased columns, not g.*, so the row shape stays exactly RawLedgerRow plus
  // the two named fields; a `g.date` or `g.notes` colliding with the ledger's
  // own would silently rewrite the payment.
  // `grn_edit_count` and `grn_inward_value` are the two facts amendedNote()
  // needs: was the receipt corrected, and is it still worth what was paid.
  // Total Inward is the SAME expression the GRN list computes as `inward_value`
  // and the inward register prints — quoted, not re-invented, so the cash book
  // and the receipt cannot disagree about what a bill is worth.
  const raw = db.prepare(`
    SELECT p.id, p.outlet_id, p.date, p.direction, p.amount, p.category, p.purchase_id, p.grn_id,
           p.vendor, p.reference, p.notes, p.recorded_by, p.created_at,
           g.grn_number AS grn_number, g.status AS grn_status,
           g.edit_count AS grn_edit_count,
           (SELECT SUM(quantity_received * unit_price
                       - discount + cgst + sgst + compensation_cess
                       + special_excise_cess + tcs + delivery_charges + mrp_round_off)
              FROM goods_receipt_note_items WHERE grn_id = g.id) AS grn_inward_value
      FROM petty_cash_ledger p
      LEFT JOIN goods_receipt_notes g ON g.id = p.grn_id
     WHERE p.date >= ? AND p.date <= ?${s.sql}
     ${LEDGER_ORDER_SQL_P}
  `).all(from, to, ...s.params) as (RawLedgerRow & {
    grn_number: string | null; grn_status: string | null;
    grn_edit_count: number | null; grn_inward_value: number | null;
  })[];

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
    const goods = goodsState(r.grn_status, !!r.grn_id);
    /* NOT ON A VOIDED OR REJECTED RECEIPT. Both already say, in stronger words,
     * that this payment has no purchase behind it at all; a second sentence
     * about the receipt being worth less would be noise on top of "nothing
     * entered stock". Voiding also removes the cost rows, so "worth less" is a
     * statement about a document nobody is reconciling against any more. */
    const amend = (goods.state === 'voided' || goods.state === 'rejected' || goods.state === 'unknown' || !r.grn_id)
      ? { amended: false, note: '' }
      : amendedNote(Number(r.grn_edit_count) || 0, toPaise(r.amount) || 0,
                    r.grn_inward_value === null || r.grn_inward_value === undefined
                      ? null : toPaise(r.grn_inward_value));
    /* THE TWO NEW READS ARE STRIPPED OFF THE ROW, not spread onto it.
     * goods_receipt_notes.edit_count is ADMIN-ONLY on the wire by the owner's
     * rule — POST /api/grn strips it out of every row it returns (EDIT_STAMPS)
     * — and this page is not an admin page. What the cash book needs is the
     * CONSEQUENCE, which is the sentence above; the raw stamp is not it. */
    const { grn_edit_count: _ec, grn_inward_value: _iv, ...rest } = r;
    return {
      ...rest,
      signed: toRupees(p),
      running_balance: toRupees(running),
      category_label: categoryLabel(r.category),
      anomaly,
      grn_number: r.grn_number ?? null,
      grn_status: r.grn_status ?? null,
      goods_state: goods.state,
      goods_note: goods.note,
      goods_amended: amend.amended,
      goods_amended_note: amend.note,
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
  return mayRecordPettyCash(user) ? 'ok' : 'denied';
}

/**
 * THE MEMBERSHIP RULE ITSELF, synchronous, so a caller that has ALREADY
 * resolved the session can apply it without a second lookup.
 *
 * It exists because there are now TWO doors into this ledger and their outer
 * gates are NOT the same: POST /api/petty-cash needs page access + this
 * membership, while POST /api/grn needs only a signed-in session. Ticking
 * "Cash purchase" on a vendor bill writes into the one ledger in the app with
 * no DELETE, so that route re-applies BOTH of petty cash's gates through this
 * function rather than inheriting the looser one — otherwise "can record a
 * goods receipt" would silently become "can move money out of the cash box".
 *
 * ONE rule, called from two places. Duplicating the membership test is how the
 * read path and the write path drifted apart once already.
 */
export function mayRecordPettyCash(user: { role?: string; is_head_chef?: boolean; is_store_manager?: boolean } | null): boolean {
  if (!user) return false;
  return isManagement(user) || !!user.is_store_manager;
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
  // "Goods" is the LAST column, appended rather than inserted, so a sheet or a
  // script keyed on the existing column positions keeps working. It is empty on
  // every row not tied to a vendor bill — which is every row this file wrote
  // before Enter Vendor Bill gained the Cash purchase option.
  lines.push(['Date', 'In/Out', 'Amount', 'Category', 'Vendor', 'Reference', 'Notes', 'Recorded by', 'Recorded at', 'Running balance', 'Data warning', 'Goods'].map(csvCell).join(','));
  lines.push(['', '', '', 'OPENING BALANCE', '', '', `As at start of ${opts.from}`, '', '', summary.opening.toFixed(2), '', ''].map(csvCell).join(','));
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
      // The receipt and what became of it. A VOIDED or REJECTED receipt has to
      // be legible on the printout the box is counted against, or a payment
      // whose goods never reached the shelf reconciles as an ordinary purchase.
      //
      // 'unknown' IS ITS OWN BRANCH, not a suffix. It means the LEFT JOIN found
      // no receipt — which is exactly when grn_number is NULL, so as a suffix it
      // could never print and the screen (which shows "⚠ Receipt not found" off
      // goods_state) and this printout disagreed about a payment with nothing
      // behind it. The CSV is the artefact the box is counted against; it is the
      // one that must not stay silent.
      // A CORRECTION IS APPENDED, NOT BRANCHED, because it can land on a receipt
      // in any state and it does not replace what that state says. Without it a
      // bill amended from ₹2,000 to ₹400 printed here as a bare receipt number,
      // two rows below one that spells out a rejection — the same column, the
      // same reader, and the larger gap left silent.
      (r.goods_state === 'unknown'
        ? (r.grn_number ? `${r.grn_number} — receipt not found` : 'RECEIPT NOT FOUND')
        : r.grn_number
          ? `${r.grn_number}${r.goods_state === 'voided' ? ' — RECEIPT VOIDED, cash not returned'
              : r.goods_state === 'rejected' ? ' — REJECTED at quality check, nothing in stock, cash not returned'
              : r.goods_state === 'partial' ? ' — part of the delivery was refused; cash covers the received quantity'
              : r.goods_state === 'awaiting_qc' ? ' — awaiting kitchen check, not in stock yet'
              : ''}`
          : '')
        + (r.goods_amended ? ' — CORRECTED after payment, receipt no longer worth what was paid' : ''),
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
