/**
 * BILL ON HOLD (BOH) — THE ENGINE
 * ===============================
 *
 * Everything that WRITES a BOH fact lives here. The routes under /api/boh do
 * authentication, authorization and input shaping; they never compose SQL of
 * their own. One writer means one place the money rule can be checked.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE MONEY RULE — AND WHY THIS FILE CANNOT GET IT WRONG
 * ════════════════════════════════════════════════════════════════════════════
 * A BOH PAYMENT IS A PAYMENT RECORD. IT IS NOT A SALE.
 *
 * Putting a bill on hold already performed every irreversible half of a settle
 * except taking the money. From src/lib/station-master.ts:430, verbatim:
 *   "'on_hold' IS FINISHED, and that is not obvious. Hold performs every
 *    irreversible half of a settle except taking the money: it writes the
 *    `sales` rows [...], deducts the stock, freezes the totals [...].
 *    Settle-from-hold skips its own item loop."
 *
 * Revenue is booked and stock is deducted AT THE MOMENT OF HOLD. If recording a
 * BOH payment wrote another `sales` row, deducted stock again, or moved any
 * inventory, the owner's books would be doubled — revenue AND recipe cost, in
 * the analytics rail, the variance report, sales-vs-purchase and dept
 * consumption. It is the same class of defect as a transfer that called itself
 * a consumption.
 *
 * THREE DEFENCES, in increasing strength:
 *
 *  1. IMPORTS. This file imports `generateId` and `logAuditEvent` from ./db and
 *     NOTHING ELSE from it. Not recordSale. Not postDeptLedger. Not
 *     postCentralTxn. Not recordConsumptionSkip. The functions that could
 *     double the books are not in scope in this module.
 *
 *  2. STATEMENTS. Every SQL statement in this file writes a boh_* table, with
 *     exactly two deliberate exceptions, both in clearOrderForBoh() and both
 *     named there: the order's own settle UPDATE and the order_payments replay.
 *
 *  3. THE GUARD, which is the one that actually holds. assertRailsUnmoved()
 *     snapshots six rails INSIDE the same transaction as the write and THROWS
 *     if any of them moved, rolling the payment back. A comment cannot be
 *     violated by a future edit; this can, and then the write fails loudly
 *     rather than silently doubling the owner's revenue.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT ELSE THIS FILE MUST NEVER DO
 * ════════════════════════════════════════════════════════════════════════════
 *  · Never DELETE or UPDATE a row in boh_assignments / boh_followups /
 *    boh_payments. The owner said twice that no history may be overwritten or
 *    deleted. A wrong payment is reversed by a NEW negative row.
 *  · Never re-open a held order, merge it, void it, or clear
 *    order_items.recipe_deducted_at (that would re-arm the KDS-bump backstop
 *    into a third deduct).
 *  · Never auto-close a BOH because its order left a filter. An underlying bill
 *    that changed status is surfaced for a human, never silently resolved.
 */
import type Database from 'better-sqlite3';
import { generateId, logAuditEvent } from './db';
import {
  ensureBohSchema,
  BOH_OUTCOMES, BOH_PAYMENT_MODES,
  type BohOutcome, type BohPaymentMode,
} from './boh-schema';

/* ══════════════════════════════ IST TIME ══════════════════════════════════ */

/**
 * Today on the owner's clock, 'YYYY-MM-DD'.
 *
 * EVERY date comparison in this module goes through IST. date('now') is UTC and
 * rolls at 05:30 IST, so a bill would read "overdue" for the five and a half
 * hours before the owner's day even starts, and two reminders on one Indian
 * morning could land on different "days" and fire twice.
 */
export function bohToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/** The same value expressed in SQL, for use inside a WHERE clause. */
export const IST_TODAY_SQL = `date('now','+5 hours','+30 minutes')`;

/** Whole days between two 'YYYY-MM-DD' dates (b - a). Negative when b is before a. */
export function daysBetween(a: string, b: string): number {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
  return Math.round((tb - ta) / 86_400_000);
}

/**
 * A REAL CALENDAR DATE in 'YYYY-MM-DD', not merely something shaped like one.
 *
 * The shape test alone accepted '2026-13-45', and it was STORED: measured on a
 * booted server, POST /api/boh/<id>/payments with paid_on '2026-13-45' returned
 * 200 and put that string in boh_payments.paid_on. Nothing then equals it —
 * payments_received_today compares paid_on to the IST day — so the collection
 * became invisible to the day's figure for ever, and julianday() over it is
 * NULL. Round-tripping through UTC is the cheapest exact check: an out-of-range
 * month or day rolls over and no longer formats back to what was asked for.
 *
 * Garbage still FALLS BACK rather than throwing wherever it did before ('not a
 * date' already behaved that way); this only stops a non-date being mistaken
 * for one.
 */
const isDate = (s: unknown): boolean => {
  const v = String(s ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
};

/* ═════════════════════════════ MONEY ══════════════════════════════════════ */

/**
 * THE BOH PRINCIPAL IS A WHOLE RUPEE, and that is not cosmetic.
 *
 * Hold stores computeBill's round2() total (two decimals), but settle-from-hold
 * collects Math.round(order.total) and OVERWRITES orders.total with that
 * integer (settle/route.ts:121, :237). /cashier shows the same rounded figure
 * (cashier/page.tsx:156). Track the unrounded value and the balance can never
 * reach exactly zero — it stalls up to Rs 0.50 short and the BOH never
 * auto-closes.
 */
export const bohPrincipal = (orderTotal: unknown): number => Math.round(Number(orderTotal) || 0);

/** Two-decimal rounding for payment amounts (matches bill-calc's round2). */
export const money2 = (n: unknown): number => Math.round((Number(n) || 0) * 100) / 100;

const S = (v: unknown): string => String(v ?? '').trim();

/**
 * Reduce any phone string to a bare 10-digit key — the SAME rule as
 * src/lib/ct/guest-unify.ts norm10, repeated here rather than imported because
 * that module pulls in @/lib/crm-guests and this one is required from db.ts's
 * dependency graph. Kept character-identical on purpose: the CRM pre-fill below
 * joins on this key and a second spelling would split it.
 */
export function bohNorm10(raw: unknown): string {
  if (raw == null) return '';
  const stripped = String(raw).replace(/[ \-+().\/]/g, '');
  const k = stripped.slice(-10);
  return /^\d{10}$/.test(k) ? k : '';
}

/* ═══════════════════════ THE RAIL GUARD (defence 3) ═══════════════════════ */

/**
 * The six rails a BOH write must never move, and the reader each one would
 * double. Named here so the guard's failure message says WHICH book broke.
 */
const RAILS: { table: string; doubles: string }[] = [
  { table: 'sales',                            doubles: 'revenue AND recipe cost, in analytics / sales-dashboard / variance / sales-vs-purchase' },
  { table: 'inventory_transactions',           doubles: 'Variance Report, Daily Roll-up, Sales-vs-Purchase (recipe_to_date)' },
  { table: 'department_material_transactions', doubles: 'department on-hand — a second debit reads as theft on dept variance' },
  { table: 'consumption_skips',                doubles: 'skip-reason reports — a second skip row for one consumption' },
  { table: 'store_stock_ledger',               doubles: 'the liquor TGBCL rail — re-books a pour the owner ruled is measured by count only' },
  { table: 'order_items',                      doubles: 'nothing directly — but clearing recipe_deducted_at re-arms the KDS-bump backstop into a THIRD deduct' },
];

/** The order columns that were FROZEN at hold and may never move again. */
const FROZEN_ORDER_COLS = ['subtotal', 'tax_total', 'service_charge', 'discount', 'discount_pct'] as const;

interface RailSnapshot {
  counts: Record<string, number | null>;
  order: Record<string, unknown> | null;
  orderPayments: number | null;
}

function snapshotRails(db: Database.Database, orderId: string): RailSnapshot {
  const counts: Record<string, number | null> = {};
  for (const r of RAILS) {
    try {
      counts[r.table] = Number((db.prepare(`SELECT COUNT(*) AS n FROM ${r.table}`).get() as any)?.n ?? 0);
    } catch {
      // Table absent on a minimal database (e.g. store_stock_ledger before the
      // liquor module is built). null means "not measurable", and the compare
      // below skips it rather than inventing a zero that would pass forever.
      counts[r.table] = null;
    }
  }
  // order_items also needs its DEDUCTION STAMPS checked, not just its row count:
  // clearing recipe_deducted_at leaves the count identical.
  try {
    counts['order_items.recipe_deducted_at'] = Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM order_items WHERE recipe_deducted_at IS NOT NULL`).get() as any)?.n ?? 0,
    );
  } catch { counts['order_items.recipe_deducted_at'] = null; }

  let order: Record<string, unknown> | null = null;
  try {
    order = (db.prepare(
      `SELECT status, total, ${FROZEN_ORDER_COLS.join(', ')} FROM orders WHERE id = ?`,
    ).get(orderId) as any) ?? null;
  } catch { order = null; }

  let orderPayments: number | null = null;
  try {
    orderPayments = Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM order_payments WHERE order_id = ?`).get(orderId) as any)?.n ?? 0,
    );
  } catch { orderPayments = null; }

  return { counts, order, orderPayments };
}

/**
 * Compare two snapshots and THROW if any forbidden rail moved.
 *
 * Called INSIDE the write transaction, so the throw rolls the write back. This
 * is the defence that survives a future edit: someone who adds a recordSale()
 * call to a BOH path gets a loud failure on the first payment instead of a
 * silently doubled set of books.
 *
 * `allow` names the writes that are legitimate on THIS path:
 *   · 'order_settle'    — clearOrderForBoh may flip status/payment_method/
 *                         settled_at/updated_at and set total to the SAME
 *                         rounded figure. The frozen columns still may not move.
 *   · 'order_payments'  — clearOrderForBoh replays the BOH ledger into the
 *                         order's tender rows, exactly once, at settle.
 */
function assertRailsUnmoved(
  before: RailSnapshot,
  after: RailSnapshot,
  allow: { order_settle?: boolean; order_payments?: boolean } = {},
): void {
  for (const [table, b] of Object.entries(before.counts)) {
    const a = after.counts[table];
    if (b == null || a == null) continue;       // not measurable — say nothing
    if (a !== b) {
      const rail = RAILS.find((r) => r.table === table);
      throw new Error(
        `BOH MONEY RULE VIOLATED: ${table} changed from ${b} to ${a} during a BOH write. ` +
        `A BOH payment is a payment record, not a sale — revenue and stock were already ` +
        `booked when the bill was held. This would double ${rail?.doubles || 'the books'}. ` +
        `The write has been rolled back.`,
      );
    }
  }

  if (before.order && after.order) {
    for (const col of FROZEN_ORDER_COLS) {
      const b = Number((before.order as any)[col] ?? 0);
      const a = Number((after.order as any)[col] ?? 0);
      if (Math.abs(a - b) > 1e-9) {
        throw new Error(
          `BOH MONEY RULE VIOLATED: orders.${col} changed from ${b} to ${a}. ` +
          `These figures were frozen when the bill was held and are the BOH principal's ` +
          `basis; rewriting one silently changes the debt. The write has been rolled back.`,
        );
      }
    }
    const bStatus = S((before.order as any).status);
    const aStatus = S((after.order as any).status);
    const bTotal = Number((before.order as any).total ?? 0);
    const aTotal = Number((after.order as any).total ?? 0);
    if (!allow.order_settle) {
      if (bStatus !== aStatus) {
        throw new Error(`BOH MONEY RULE VIOLATED: orders.status changed from '${bStatus}' to '${aStatus}' on a path that may not settle. Rolled back.`);
      }
      if (Math.abs(aTotal - bTotal) > 1e-9) {
        throw new Error(`BOH MONEY RULE VIOLATED: orders.total changed from ${bTotal} to ${aTotal} on a path that may not settle. Rolled back.`);
      }
    } else {
      // Even the clearing path may only round, never re-price: settle-from-hold
      // stores Math.round(order.total), so the only legal move is to that value.
      //
      // NO CHANGE AT ALL IS ALSO LEGAL, and that is a FIX, not a loosening.
      // clearOrderForBoh has three branches that deliberately write NOTHING to
      // the order — 'skipped' (the order row is gone), 'already_settled', and
      // 'refused_total_mismatch' — and this assertion used to demand that the
      // total HAVE been rounded. So a refusal threw here, rolled the whole
      // transaction back with a 500, and the cashier's collected money was
      // recorded NOWHERE — the exact opposite of the contract stated at
      // clearOrderForBoh's head ("the BOH still closes ... but the order is
      // left untouched"). Reproduced by the money probe (probe-FINAL.txt §9)
      // on an order whose total had drifted to 780.9 against a principal of 681.
      //
      // Unchanged-is-legal cannot hide a re-price: bTotal === aTotal IS the
      // "nothing moved" case, and any other value still has to equal
      // Math.round(bTotal).
      if (aTotal !== bTotal && aTotal !== bohPrincipal(bTotal)) {
        throw new Error(
          `BOH MONEY RULE VIOLATED: the clearing step set orders.total to ${aTotal}, but the ` +
          `only values settle-from-hold may store are Math.round(${bTotal}) = ${bohPrincipal(bTotal)} ` +
          `or the unchanged ${bTotal}. Rolled back.`,
        );
      }
    }
  }

  if (!allow.order_payments && before.orderPayments != null && after.orderPayments != null) {
    if (before.orderPayments !== after.orderPayments) {
      throw new Error(
        `BOH MONEY RULE VIOLATED: order_payments for this order changed from ${before.orderPayments} ` +
        `to ${after.orderPayments}. BOH partials live in boh_payments — settle/route.ts:263 is an ` +
        `unconditional DELETE of this table and would erase them. Rolled back.`,
      );
    }
  }
}

/* ═════════════════════════════ TYPES ══════════════════════════════════════ */

export interface BohActor {
  id: string;
  email?: string | null;
  name?: string | null;
  role?: string;
}

export interface BohRow {
  id: string; order_id: string; outlet_id: string | null;
  bill_number: string; bill_date: string; held_at: string; table_label: string;
  customer_name: string; customer_mobile: string; customer_company: string;
  contact_source: string; crm_guest_id: string;
  reason: string; remarks: string;
  department_id: string; department_name: string;
  responsible_user_id: string; responsible_email: string; responsible_name: string;
  expected_payment_date: string; principal_amount: number; status: string;
  close_kind: string; close_remarks: string; closed_at: string; closed_by: string;
  void_reason: string; voided_at: string; voided_by: string;
  order_sync: string; order_sync_note: string;
  created_by: string; created_at: string; updated_at: string;
}

/** A BOH row plus everything derived from its children. */
export interface BohView extends BohRow {
  paid_amount: number;
  balance_amount: number;
  /** IST days since the current expected date (negative = still in the future). */
  days_pending: number;
  /** 'due' | 'overdue' | 'missed' | 'scheduled' | 'none' — see followupState(). */
  followup_state: string;
  /** The underlying POS bill's status right now, or '' when the order is gone. */
  order_status: string;
  /** True when the order is no longer 'on_hold' while this BOH is still open. */
  reconcile_needed: boolean;
}

export class BohError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

/* ═══════════════════════ DERIVED-STATE SQL FRAGMENTS ══════════════════════ */

const PAID_SQL = `COALESCE((SELECT SUM(p.amount) FROM boh_payments p WHERE p.boh_id = b.id), 0)`;
const BALANCE_SQL = `(b.principal_amount - ${PAID_SQL})`;

/**
 * FOLLOW-UP STATE — the definition the dashboard and the accountability view
 * both read, written once so the two figures cannot disagree.
 *
 * A follow-up is MISSED when the day someone promised to chase a bill has gone
 * by and nobody wrote down what happened. Formally: the BOH is still open, its
 * CURRENT expected payment date is before today (IST), and no boh_followups row
 * answers that date.
 *
 * DUE is the same with '=' — today, and nothing logged yet. A due follow-up
 * becomes missed at IST midnight if nothing is logged. The two can never
 * overlap, which is what makes them safe to show side by side.
 *
 * 'overdue' is the third state: the date has passed AND a follow-up was logged
 * against it — chased, still unpaid. That is a different management problem
 * from a miss and must not be counted as one.
 */
const FOLLOWUP_ANSWERED_SQL = `EXISTS (
  SELECT 1 FROM boh_followups f
   WHERE f.boh_id = b.id AND f.answered_expected_date = b.expected_payment_date
)`;

const FOLLOWUP_STATE_SQL = `CASE
  WHEN b.status <> 'open' OR b.expected_payment_date = '' THEN 'none'
  WHEN b.expected_payment_date = ${IST_TODAY_SQL} AND NOT ${FOLLOWUP_ANSWERED_SQL} THEN 'due'
  WHEN b.expected_payment_date <  ${IST_TODAY_SQL} AND NOT ${FOLLOWUP_ANSWERED_SQL} THEN 'missed'
  WHEN b.expected_payment_date <  ${IST_TODAY_SQL} THEN 'overdue'
  ELSE 'scheduled'
END`;

/**
 * RECONCILE NEEDED — "the underlying bill left 'on_hold' while this record is
 * still open, and nobody has reconciled it here".
 *
 * `order_sync <> 'settled'` is the exception that makes the flag mean what it
 * says. When THIS BOH's own clearing payment settled the bill, order_sync is
 * stamped 'settled' (clearOrderForBoh) — the order being 'settled' is then the
 * expected end state, not a discrepancy. That matters after an ADMIN REVERSES
 * THE CLEARING PAYMENT (a bounced cheque): the record re-opens against an order
 * this module itself settled, and without this clause it would instantly read
 * "settled outside the BOH" and refuse every further collection, which is how
 * the clearing payment came to be uncorrectable in the first place.
 */
const RECONCILE_SQL = `CASE
  WHEN b.status = 'open' AND COALESCE(o.status,'') <> 'on_hold' AND COALESCE(b.order_sync,'') <> 'settled'
  THEN 1 ELSE 0 END`;

/** The SELECT every read in this module uses, so every surface agrees. */
const BOH_SELECT = `
  SELECT b.*,
         ${PAID_SQL}                                   AS paid_amount,
         ${BALANCE_SQL}                                AS balance_amount,
         CAST(julianday(${IST_TODAY_SQL}) - julianday(NULLIF(b.expected_payment_date,'')) AS INTEGER)
                                                       AS days_pending,
         ${FOLLOWUP_STATE_SQL}                         AS followup_state,
         COALESCE(o.status, '')                        AS order_status,
         ${RECONCILE_SQL}                              AS reconcile_needed
    FROM boh_bills b
    LEFT JOIN orders o ON o.id = b.order_id
`;

function shapeRow(r: any): BohView {
  return {
    ...(r as BohRow),
    paid_amount: money2(r.paid_amount),
    balance_amount: money2(r.balance_amount),
    days_pending: Number(r.days_pending ?? 0) || 0,
    followup_state: S(r.followup_state) || 'none',
    order_status: S(r.order_status),
    reconcile_needed: !!r.reconcile_needed,
  };
}

/* ════════════════════════════ READS ═══════════════════════════════════════ */

export function getBoh(db: Database.Database, id: string): BohView | null {
  ensureBohSchema(db);
  const r = db.prepare(`${BOH_SELECT} WHERE b.id = ?`).get(S(id)) as any;
  return r ? shapeRow(r) : null;
}

export function getBohByOrder(db: Database.Database, orderId: string): BohView | null {
  ensureBohSchema(db);
  const r = db.prepare(`${BOH_SELECT} WHERE b.order_id = ? AND b.status <> 'void' LIMIT 1`).get(S(orderId)) as any;
  return r ? shapeRow(r) : null;
}

export interface BohListFilter {
  /** Restrict to one responsible user. THE VISIBILITY GATE passes this for a
   *  non-management caller; the route decides, this function obeys. */
  responsibleUserId?: string | null;
  status?: string | null;
  outletId?: string | null;
  /** 'due' | 'overdue' | 'missed' | 'scheduled' */
  followupState?: string | null;
  /** 'due_today' | 'overdue' | 'partially_paid' | 'contact_missing' | 'reconcile' */
  bucket?: string | null;
  from?: string | null;
  to?: string | null;
  /** Permanent searchability: bill number, customer name, mobile. */
  q?: string | null;
  limit?: number;
  offset?: number;
}

export function listBoh(db: Database.Database, f: BohListFilter = {}): BohView[] {
  ensureBohSchema(db);
  const where: string[] = [];
  const params: unknown[] = [];

  if (f.responsibleUserId != null) { where.push('b.responsible_user_id = ?'); params.push(S(f.responsibleUserId)); }
  if (f.status) { where.push('b.status = ?'); params.push(S(f.status)); }
  else { where.push(`b.status <> 'void'`); }
  // Outlet scoping is the lenient shape the rest of the app uses: rows for this
  // outlet OR legacy rows with none.
  if (f.outletId) { where.push('(b.outlet_id = ? OR b.outlet_id IS NULL)'); params.push(S(f.outletId)); }
  if (f.from && isDate(f.from)) { where.push('b.bill_date >= ?'); params.push(f.from); }
  if (f.to && isDate(f.to)) { where.push('b.bill_date <= ?'); params.push(f.to); }
  if (f.followupState) { where.push(`${FOLLOWUP_STATE_SQL} = ?`); params.push(S(f.followupState)); }

  switch (S(f.bucket)) {
    case 'due_today':
      where.push(`b.status = 'open' AND b.expected_payment_date = ${IST_TODAY_SQL}`); break;
    case 'overdue':
      where.push(`b.status = 'open' AND b.expected_payment_date <> '' AND b.expected_payment_date < ${IST_TODAY_SQL}`); break;
    case 'partially_paid':
      where.push(`b.status = 'open' AND ${PAID_SQL} > 0 AND ${BALANCE_SQL} > 0`); break;
    case 'contact_missing':
      where.push(`b.status = 'open' AND TRIM(b.customer_mobile) = ''`); break;
    case 'reconcile':
      where.push(`b.status = 'open' AND COALESCE(b.order_sync,'') <> 'settled'
                  AND COALESCE((SELECT o2.status FROM orders o2 WHERE o2.id = b.order_id),'') <> 'on_hold'`); break;
    default: break;
  }

  const q = S(f.q);
  if (q) {
    // Mobile is matched on the 10-digit key so '+91 98765 43210', '098765…'
    // and '9876543210' are one search, exactly as the CRM joins them.
    const key = bohNorm10(q);
    const like = `%${q.toLowerCase()}%`;
    if (key) { where.push('(b.customer_mobile = ? OR lower(b.bill_number) LIKE ? OR lower(b.customer_name) LIKE ? OR lower(b.customer_company) LIKE ?)'); params.push(key, like, like, like); }
    else { where.push('(lower(b.bill_number) LIKE ? OR lower(b.customer_name) LIKE ? OR lower(b.customer_company) LIKE ? OR b.customer_mobile LIKE ?)'); params.push(like, like, like, `%${q}%`); }
  }

  const limit = Math.min(Math.max(Number(f.limit) || 200, 1), 1000);
  const offset = Math.max(Number(f.offset) || 0, 0);
  const rows = db.prepare(`
    ${BOH_SELECT}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE b.status WHEN 'open' THEN 0 WHEN 'closed' THEN 1 ELSE 2 END,
             CASE WHEN b.expected_payment_date = '' THEN 1 ELSE 0 END,
             b.expected_payment_date ASC, b.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as any[];
  return rows.map(shapeRow);
}

/** The full, append-only timeline for one BOH — nothing here is ever deleted. */
export function getBohTimeline(db: Database.Database, id: string) {
  ensureBohSchema(db);
  const bohId = S(id);
  const q = <T,>(sql: string): T[] => { try { return db.prepare(sql).all(bohId) as T[]; } catch { return []; } };
  return {
    assignments: q<any>(`SELECT * FROM boh_assignments WHERE boh_id = ? ORDER BY changed_at ASC, id ASC`),
    followups:   q<any>(`SELECT * FROM boh_followups   WHERE boh_id = ? ORDER BY created_at ASC, id ASC`),
    payments:    q<any>(`SELECT * FROM boh_payments    WHERE boh_id = ? ORDER BY created_at ASC, id ASC`),
    reminders:   q<any>(`SELECT * FROM boh_reminders   WHERE boh_id = ? ORDER BY id ASC`),
    // The audit trail, through the boh_* namespace's window onto audit_events.
    // Falls back to the base table if the view is missing on this database.
    audit: (() => {
      try { return db.prepare(`SELECT * FROM boh_audit WHERE boh_id = ? ORDER BY created_at ASC, id ASC`).all(bohId) as any[]; }
      catch {
        try {
          return db.prepare(
            `SELECT id, event_type AS action, entity_id AS boh_id, before_json AS old_value,
                    after_json AS new_value, actor_email AS updated_by, note, created_at
               FROM audit_events WHERE entity_type = 'boh' AND entity_id = ? ORDER BY created_at ASC`,
          ).all(bohId) as any[];
        } catch { return []; }
      }
    })(),
  };
}

/* ═════════════════════════ AUDIT (one store) ══════════════════════════════ */

function audit(
  db: Database.Database,
  action: string,
  bohId: string,
  actor: BohActor,
  before: unknown,
  after: unknown,
  note = '',
  outletId?: string | null,
): void {
  // logAuditEvent never throws (db.ts:9103 swallows). before_json/after_json are
  // literally the owner's "old value / new value".
  logAuditEvent(db, {
    event_type: action, entity_type: 'boh', entity_id: bohId,
    actor_email: S(actor.email) || S(actor.id), outlet_id: outletId ?? null,
    before, after, note,
  });
}

/* ═════════════════════════ CREATE (auto, on hold) ═════════════════════════ */

export interface CreateBohInput {
  orderId: string;
  outletId?: string | null;
  /** The responsible user. Defaults to the actor — the cashier who held it. */
  responsible?: { id: string; email?: string | null; name?: string | null } | null;
  customerName?: string | null;
  customerMobile?: string | null;
  customerCompany?: string | null;
  reason?: string | null;
  remarks?: string | null;
  expectedPaymentDate?: string | null;
  departmentId?: string | null;
}

export interface CreateBohResult {
  created: boolean;
  boh: BohView | null;
  /** Why nothing was created, when created === false. */
  reason?: string;
  /** True when no usable mobile could be found anywhere — the owner's gap #1. */
  contactMissing: boolean;
}

/**
 * Create the BOH for a bill that has just been placed on hold.
 *
 * CALLED AFTER THE HOLD TRANSACTION COMMITS, never inside it — same rule as
 * recordSettleOverride / completeBookingForOrder next door. A BOH failure must
 * never roll back a hold that already wrote the sales rows and deducted stock;
 * the bill would be un-held with its inventory gone.
 *
 * NEVER THROWS by contract. The caller wraps it in its own try/catch anyway
 * (the house rule), and a BOH that failed to create is recoverable from the
 * /api/boh backfill; a hold that failed to commit is not.
 *
 * RESPONSIBLE USER — THE PROVISIONAL DEFAULT, REPORTED FOR THE OWNER TO
 * OVERTURN: it is the cashier who put the bill on hold. That person made the
 * forward commitment with the guest in front of them, and they are the only
 * name the system can know at that instant. It is reassignable immediately and
 * every reassignment is recorded.
 */
export function createBohForHold(db: Database.Database, input: CreateBohInput, actor: BohActor): CreateBohResult {
  try {
    ensureBohSchema(db);
    const orderId = S(input.orderId);
    if (!orderId) return { created: false, boh: null, reason: 'no order id', contactMissing: true };

    const existing = getBohByOrder(db, orderId);
    if (existing) return { created: false, boh: existing, reason: 'already exists', contactMissing: !existing.customer_mobile };

    const order = db.prepare(`
      SELECT o.*, t.table_number, t.zone
        FROM orders o LEFT JOIN restaurant_tables t ON t.id = o.table_id
       WHERE o.id = ?
    `).get(orderId) as any;
    if (!order) return { created: false, boh: null, reason: 'order not found', contactMissing: true };

    const responsibleId = S(input.responsible?.id) || S(actor.id);
    // THE ONE RECORD THIS MODULE CANNOT BE BUILT ON. Refuse rather than write an
    // unowned debt; the column is NOT NULL for the same reason.
    if (!responsibleId) return { created: false, boh: null, reason: 'no responsible user', contactMissing: true };
    const who = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(responsibleId) as any;

    // ── CONTACT RESOLUTION, in falling order of evidence ────────────────────
    // captured → what the person at the till typed (the one moment a customer
    // is standing there); order → whatever the bill already carried; crm → the
    // CRM guest matched on the last 10 digits. 'missing' is recorded as such
    // and is a first-class dashboard bucket, never a silent blank.
    let name = S(input.customerName);
    let mobile = bohNorm10(input.customerMobile);
    let source = mobile || name ? 'captured' : '';
    if (!mobile) {
      const fromOrder = bohNorm10(order.guest_mobile);
      if (fromOrder) { mobile = fromOrder; source = source || 'order'; }
    }
    if (!name) { const n = S(order.guest_name); if (n) { name = n; source = source || 'order'; } }

    let crmGuestId = '';
    if (mobile) {
      try {
        // crm_guests.mobile is ALREADY stored normalised 10-digit (db.ts, and
        // its UNIQUE index proves it), so bohNorm10 above and this column are
        // the same key — that is the whole reason the join works without a
        // second normalisation here. `mobile`, not `phone`: the column name is
        // verified against the schema, not assumed.
        const g = db.prepare(`SELECT id, name FROM crm_guests WHERE mobile = ? LIMIT 1`).get(mobile) as any;
        if (g?.id) { crmGuestId = S(g.id); if (!name) { name = S(g.name); source = source || 'crm'; } }
      } catch { /* no CRM on this install — not an error */ }
    }
    if (!mobile) source = 'missing';

    const today = bohToday();
    // ── NO DATE SUPPLIED MEANS NO DATE, NOT "TODAY" ─────────────────────────
    // PROVISIONAL DEFAULT, reported for the owner to overturn (three options
    // are set out in the fix report). This used to default to `today`, and the
    // hold route does not ask for a date, so EVERY bill held at a busy till
    // silently PROMISED TODAY. Two measured consequences, both of them lies
    // about a person:
    //   · the one and only reminder fired minutes after the hold, telling the
    //     cashier to chase a bill he had just taken ("0 day(s) pending");
    //   · at IST midnight the same row turned 'missed' on the dashboard and in
    //     that cashier's Missed column — a broken promise nobody made.
    // Blank is the schema's own default, reads as the first-class "No date set"
    // bucket the dashboard and the accountability view already render, cannot
    // be due / overdue / missed, and is excluded from the reminder job's
    // DUE_SQL (`expected_payment_date <> ''`). The date is then set by the
    // first recorded follow-up, which is where a real promise is made.
    const expected = isDate(input.expectedPaymentDate) ? S(input.expectedPaymentDate) : '';

    const id = generateId();
    const principal = bohPrincipal(order.total);
    const tableLabel = S(order.table_number) ? `${S(order.zone)}${S(order.zone) ? ' / ' : ''}${S(order.table_number)}` : S(order.order_type || '');

    const row = {
      id,
      order_id: orderId,
      outlet_id: input.outletId ?? order.outlet_id ?? null,
      bill_number: S(order.order_number) || orderId.slice(0, 8),
      bill_date: today,
      held_at: S(order.held_at),
      table_label: tableLabel,
      customer_name: name,
      customer_mobile: mobile,
      customer_company: S(input.customerCompany),
      contact_source: source || 'missing',
      crm_guest_id: crmGuestId,
      reason: S(input.reason),
      remarks: S(input.remarks),
      department_id: S(input.departmentId),
      department_name: '',
      responsible_user_id: responsibleId,
      responsible_email: S(who?.email) || S(actor.email),
      responsible_name: S(who?.name) || S(actor.name) || S(who?.email) || S(actor.email),
      expected_payment_date: expected,
      principal_amount: principal,
      created_by: S(actor.email) || S(actor.id),
    };
    if (row.department_id) {
      try {
        const d = db.prepare('SELECT name FROM departments WHERE id = ?').get(row.department_id) as any;
        row.department_name = S(d?.name);
      } catch { /* optional label */ }
    }

    const write = db.transaction(() => {
      // THE RAIL GUARD runs even on create. Creating a BOH reads the order and
      // writes two boh_* rows; if a future edit made it touch a sale, this is
      // where that stops.
      const before = snapshotRails(db, orderId);
      db.prepare(`
        INSERT INTO boh_bills (
          id, order_id, outlet_id, bill_number, bill_date, held_at, table_label,
          customer_name, customer_mobile, customer_company, contact_source, crm_guest_id,
          reason, remarks, department_id, department_name,
          responsible_user_id, responsible_email, responsible_name,
          expected_payment_date, principal_amount, status, created_by
        ) VALUES (
          @id, @order_id, @outlet_id, @bill_number, @bill_date, @held_at, @table_label,
          @customer_name, @customer_mobile, @customer_company, @contact_source, @crm_guest_id,
          @reason, @remarks, @department_id, @department_name,
          @responsible_user_id, @responsible_email, @responsible_name,
          @expected_payment_date, @principal_amount, 'open', @created_by
        )
      `).run(row);
      // THE CHAIN STARTS HERE, not at the first hand-off: without this row the
      // original owner is the one person the history could not name.
      db.prepare(`
        INSERT INTO boh_assignments (id, boh_id, prev_user_id, prev_user_name, new_user_id, new_user_name, reason, changed_by)
        VALUES (?, ?, '', '', ?, ?, 'Responsible at hold', ?)
      `).run(generateId(), id, responsibleId, row.responsible_name, row.created_by);
      assertRailsUnmoved(before, snapshotRails(db, orderId));
    });
    write();

    audit(db, 'boh.create', id, actor, null, row,
      `BOH opened for bill ${row.bill_number} (Rs ${principal}); responsible ${row.responsible_name}`, row.outlet_id);

    return { created: true, boh: getBoh(db, id), contactMissing: !mobile };
  } catch (e) {
    // Never throw into a committed hold. Log loudly; the bill is still held and
    // the BOH is recoverable via POST /api/boh.
    console.error('[boh] createBohForHold failed (non-fatal to the hold):', e);
    return { created: false, boh: null, reason: (e as any)?.message || 'failed', contactMissing: true };
  }
}

/* ═════════════════════════════ REASSIGN ═══════════════════════════════════ */

export function reassignBoh(
  db: Database.Database,
  id: string,
  newUserId: string,
  reason: string,
  actor: BohActor,
): BohView {
  ensureBohSchema(db);
  const boh = getBoh(db, id);
  if (!boh) throw new BohError('BOH not found', 404);
  if (boh.status === 'void') throw new BohError('This BOH was voided — it cannot be reassigned', 409);
  // ── ONLY A LIVE DEBT CAN BE HANDED ON ───────────────────────────────────
  // 'closed' used to fall straight through this guard, and canReassignBoh()
  // grants the CURRENT responsible user regardless of tier — so an ORDINARY
  // CASHIER could reassign a fully-collected, closed record and silently move
  // the whole 'Collected' figure onto somebody who collected none of it
  // (measured: Priya 1,100 -> 0, Ravi 330 -> 1,430, no management involved).
  // Reassignment exists to say who will CHASE a bill; a settled bill is not
  // chased by anybody, and its accountability record is history.
  if (boh.status !== 'open') {
    throw new BohError(
      `This BOH is ${boh.status} — only an open bill on hold can be handed to someone else. ` +
      `Reassigning a ${boh.status} record would move the money already collected on it onto a different person's accountability row.`,
      409,
    );
  }

  const target = db.prepare('SELECT id, email, name, is_active FROM users WHERE id = ?').get(S(newUserId)) as any;
  if (!target?.id) throw new BohError('That user does not exist', 400);
  if (target.is_active === 0) throw new BohError('That user is deactivated — pick someone who can still act on it', 400);
  if (S(target.id) === boh.responsible_user_id) throw new BohError('That user is already responsible for this BOH', 400);

  const newName = S(target.name) || S(target.email);
  const why = S(reason);
  if (!why) throw new BohError('A reason for the reassignment is required', 400);

  const before = { responsible_user_id: boh.responsible_user_id, responsible_name: boh.responsible_name };
  const after = { responsible_user_id: S(target.id), responsible_name: newName };

  db.transaction(() => {
    const railsBefore = snapshotRails(db, boh.order_id);
    // APPEND the history row FIRST, so a crash between the two leaves the
    // evidence rather than the silent change.
    db.prepare(`
      INSERT INTO boh_assignments (id, boh_id, prev_user_id, prev_user_name, new_user_id, new_user_name, reason, changed_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(generateId(), boh.id, boh.responsible_user_id, boh.responsible_name, S(target.id), newName, why, S(actor.email) || S(actor.id));
    db.prepare(`
      UPDATE boh_bills SET responsible_user_id = ?, responsible_email = ?, responsible_name = ?,
             updated_at = datetime('now') WHERE id = ?
    `).run(S(target.id), S(target.email), newName, boh.id);
    assertRailsUnmoved(railsBefore, snapshotRails(db, boh.order_id));
  })();

  audit(db, 'boh.reassign', boh.id, actor, before, after, why, boh.outlet_id);

  // ── TELL THE PERSON WHO NOW OWNS THE DEBT ───────────────────────────────
  // The reminder slot is keyed on (boh_id, expected_payment_date) and NOTHING
  // re-dates it, so a bill handed over AFTER its reminder has fired was never
  // announced to its new owner — not that day, not ever (measured: four further
  // scheduler ticks, "0 claimed ... 6 already held", and the new owner's total
  // was 0 reminders for 2 bills she held). The ordinary shift-change case —
  // held Monday, handed over Tuesday — reminded the new owner never.
  //
  // A handover is its own event, so it gets its own notification rather than
  // re-arming the date slot: re-arming would also re-fire for a bill somebody
  // had already been told about, and the slot ledger is the proof that a given
  // promise was announced exactly once.
  //
  // Required lazily and swallowed: boh-notify pulls in push + whatsapp, and
  // this file sits in db.ts's dependency graph. notifyBohUser never throws by
  // its own contract; this try/catch is the second belt.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { notifyBohUser } = require('./boh-notify') as typeof import('./boh-notify');
    const fresh = getBoh(db, boh.id)!;
    const who = S(actor.name) || S(actor.email) || 'a manager';
    notifyBohUser(db, {
      bohId: fresh.id,
      billNo: fresh.bill_number,
      customer: fresh.customer_name || (fresh.customer_mobile ? `+91 ${fresh.customer_mobile}` : 'Guest'),
      amount: fresh.balance_amount,
      expectedDate: fresh.expected_payment_date,
      daysPending: Math.max(fresh.days_pending, 0),
      responsibleUserId: fresh.responsible_user_id,
      responsibleEmail: fresh.responsible_email,
      responsibleName: fresh.responsible_name,
    }, {
      kind: 'boh.handover',
      title: 'A bill on hold was handed to you',
      body:
        `BOH Bill ${fresh.bill_number || '-'} | ${fresh.customer_name || 'Guest'} | ` +
        `Rs ${fresh.balance_amount.toFixed(2)} still owed | ` +
        `${fresh.expected_payment_date ? `expected ${fresh.expected_payment_date}` : 'no payment date set yet'} — ` +
        `handed over by ${who}: ${why}`,
    });
  } catch (e) {
    console.error('[boh] handover notification failed (non-fatal):', e);
  }

  return getBoh(db, boh.id)!;
}

/* ═════════════════════════════ FOLLOW-UP ══════════════════════════════════ */

export interface FollowUpInput {
  outcome: string;
  remarks?: string | null;
  nextExpectedDate?: string | null;
}

/**
 * Log a follow-up. The loop the owner described: when payment was NOT received,
 * remarks are mandatory AND a new expected date is mandatory — and writing that
 * date opens the next reminder slot, "looping until settled".
 *
 * A follow-up NEVER records money. 'payment_received' as an outcome is a
 * statement about the conversation, not a collection — the collection is a
 * boh_payments row through recordBohPayment(), which is the only path that can
 * move a balance.
 */
export function addFollowUp(db: Database.Database, id: string, input: FollowUpInput, actor: BohActor): BohView {
  ensureBohSchema(db);
  const boh = getBoh(db, id);
  if (!boh) throw new BohError('BOH not found', 404);
  if (boh.status !== 'open') throw new BohError(`This BOH is ${boh.status} — follow-ups are only logged on an open BOH`, 409);

  const outcome = S(input.outcome) as BohOutcome;
  if (!(BOH_OUTCOMES as readonly string[]).includes(outcome)) {
    throw new BohError(`outcome must be one of: ${BOH_OUTCOMES.join(', ')}`, 400);
  }
  const remarks = S(input.remarks);
  const next = S(input.nextExpectedDate);

  // "when not received, mandatory remarks plus a NEW expected date that
  // schedules the next reminder" — his words. Everything except a completed
  // collection is 'not received' for this purpose: a customer who asked for
  // more time, is not responding, is disputing or whose payment is processing
  // has not paid, and each of those must leave a date the system can chase.
  const needsNext = outcome !== 'payment_received';
  if (needsNext) {
    if (!remarks) throw new BohError('Remarks are required when the payment was not received', 400);
    if (!isDate(next)) throw new BohError('A new expected payment date (YYYY-MM-DD) is required when the payment was not received', 400);
    // A date in the past would be due-and-missed the instant it is written.
    if (daysBetween(bohToday(), next) < 0) throw new BohError('The new expected payment date cannot be in the past', 400);
  } else if (next && !isDate(next)) {
    throw new BohError('next_expected_date must be YYYY-MM-DD', 400);
  }

  const answered = boh.expected_payment_date;
  const before = { expected_payment_date: answered };
  const rowId = generateId();

  db.transaction(() => {
    const railsBefore = snapshotRails(db, boh.order_id);
    db.prepare(`
      INSERT INTO boh_followups (id, boh_id, answered_expected_date, outcome, remarks, next_expected_date, created_by, created_by_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(rowId, boh.id, answered, outcome, remarks, isDate(next) ? next : '', S(actor.email) || S(actor.id), S(actor.name) || S(actor.email));
    if (isDate(next)) {
      // RE-DATING IS THE LOOP. A new expected date is a NEW (boh_id, due_date)
      // reminder slot; yesterday's slot stays spent and can never replay.
      db.prepare(`UPDATE boh_bills SET expected_payment_date = ?, updated_at = datetime('now') WHERE id = ?`).run(next, boh.id);
    }
    assertRailsUnmoved(railsBefore, snapshotRails(db, boh.order_id));
  })();

  audit(db, 'boh.followup', boh.id, actor, before, { expected_payment_date: isDate(next) ? next : answered, outcome },
    `${outcome}${remarks ? ` — ${remarks}` : ''}`, boh.outlet_id);
  return getBoh(db, boh.id)!;
}

/* ═════════════════════════════ PAYMENTS ═══════════════════════════════════ */

export interface PaymentInput {
  amount: number;
  mode: string;
  paidOn?: string | null;
  reference?: string | null;
  remarks?: string | null;
}

export interface PaymentResult {
  boh: BohView;
  payment_id: string;
  closed: boolean;
  /** What the clearing step did to the underlying order, verbatim. */
  order_sync: string;
  order_sync_note: string;
}

/**
 * Record a collection against a BOH. PARTIALS SUPPORTED: the remainder
 * continues as an active BOH and the record auto-closes at zero.
 *
 * THIS IS THE FUNCTION THE MONEY RULE IS ABOUT. It writes ONE boh_payments row.
 * It does not write `sales`. It does not move stock. It does not touch the
 * order's frozen totals. assertRailsUnmoved() proves that on every call, inside
 * the transaction, and rolls the payment back if a future edit breaks it.
 */
export function recordBohPayment(db: Database.Database, id: string, input: PaymentInput, actor: BohActor): PaymentResult {
  ensureBohSchema(db);
  const boh = getBoh(db, id);
  if (!boh) throw new BohError('BOH not found', 404);
  if (boh.status !== 'open') throw new BohError(`This BOH is ${boh.status} — no further payment can be recorded against it`, 409);

  // THE RECONCILE REFUSAL. If the bill was settled through the POS while this
  // record was open, the money is already collected there and recording it
  // again here would count one collection twice. Refuse and name the fix —
  // never silently auto-close, and never silently double.
  if (boh.reconcile_needed) {
    throw new BohError(
      `The underlying POS bill is now '${boh.order_status || 'gone'}', not 'on_hold' — it was settled or changed outside this BOH. ` +
      `Recording another payment here would count the same collection twice. A manager must reconcile and close this BOH instead.`,
      409,
    );
  }

  const amount = money2(input.amount);
  if (!(amount > 0)) throw new BohError('Payment amount must be greater than zero', 400);
  const mode = S(input.mode).toLowerCase() as BohPaymentMode;
  if (!(BOH_PAYMENT_MODES as readonly string[]).includes(mode)) {
    throw new BohError(`mode must be one of: ${BOH_PAYMENT_MODES.join(', ')}`, 400);
  }
  const paidOn = isDate(input.paidOn) ? S(input.paidOn) : bohToday();
  // MONEY CANNOT ARRIVE TOMORROW. paid_on is the owner's "date" on a collection
  // and is exactly what payments_received_today counts (boh-reporting.ts reads
  // `WHERE paid_on = <IST today>`). A future date was accepted and stored —
  // measured, 200 OK with paid_on '2099-12-31' — which takes the collection out
  // of today's received figure and parks it in a day that has not happened, so
  // the day's cash never reconciles and nobody can see why.
  //
  // BACKDATING STAYS ALLOWED and is the ordinary case: recording on Monday a
  // payment that was taken on Saturday is the whole reason this column exists.
  if (daysBetween(bohToday(), paidOn) > 0) {
    throw new BohError(
      `A payment cannot be dated in the future (${paidOn}). Record the date the money was actually collected.`,
      400,
    );
  }
  // OVER-COLLECTION IS REFUSED. The balance is what is owed; a bigger number is
  // a typo, and accepting it would push the order's replayed tenders past the
  // frozen bill total — which settle's own +/-Rs 1 split check would then
  // refuse, wedging the close.
  if (amount - boh.balance_amount > 0.005) {
    throw new BohError(`That is more than the outstanding balance (Rs ${boh.balance_amount.toFixed(2)}). Record at most the balance.`, 400);
  }

  const paymentId = generateId();
  const newPaid = money2(boh.paid_amount + amount);
  const newBalance = money2(boh.principal_amount - newPaid);
  const clears = newBalance <= 0.005;

  let orderSync = 'skipped';
  let orderSyncNote = clears ? '' : 'Partial payment — the order stays on hold until the balance is cleared.';

  db.transaction(() => {
    const railsBefore = snapshotRails(db, boh.order_id);

    // ── THE ONLY WRITE ON A PARTIAL PAYMENT ──────────────────────────────
    db.prepare(`
      INSERT INTO boh_payments (id, boh_id, order_id, paid_on, amount, mode, reference, remarks, created_by, created_by_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(paymentId, boh.id, boh.order_id, paidOn, amount, mode, S(input.reference), S(input.remarks),
           S(actor.email) || S(actor.id), S(actor.name) || S(actor.email));

    if (!clears) {
      // A PARTIAL MAY NOT TOUCH THE ORDER AT ALL. No settle allowance, no
      // order_payments allowance — the strictest form of the guard.
      assertRailsUnmoved(railsBefore, snapshotRails(db, boh.order_id));
      return;
    }

    // ── THE CLEARING PAYMENT ─────────────────────────────────────────────
    const sync = clearOrderForBoh(db, boh.order_id, boh.principal_amount, actor, boh.order_sync);
    orderSync = sync.outcome;
    orderSyncNote = sync.note;

    db.prepare(`
      UPDATE boh_bills SET status = 'closed', close_kind = 'paid_in_full', close_remarks = '',
             closed_at = datetime('now'), closed_by = ?, order_sync = ?, order_sync_note = ?,
             updated_at = datetime('now')
       WHERE id = ?
    `).run('system (paid in full)', orderSync, orderSyncNote, boh.id);

    // The guard, with the two writes the clearing step is ALLOWED to make.
    assertRailsUnmoved(railsBefore, snapshotRails(db, boh.order_id), { order_settle: true, order_payments: true });
  })();

  audit(db, 'boh.payment', boh.id, actor,
    { paid_amount: boh.paid_amount, balance_amount: boh.balance_amount, status: boh.status },
    { paid_amount: newPaid, balance_amount: Math.max(newBalance, 0), status: clears ? 'closed' : 'open' },
    `Rs ${amount.toFixed(2)} by ${mode}${S(input.reference) ? ` (ref ${S(input.reference)})` : ''} on ${paidOn}` +
      (clears ? ` — balance cleared, BOH closed, order ${orderSync}` : ` — balance Rs ${newBalance.toFixed(2)} remains`),
    boh.outlet_id);

  return { boh: getBoh(db, boh.id)!, payment_id: paymentId, closed: clears, order_sync: orderSync, order_sync_note: orderSyncNote };
}

/**
 * THE CLEARING STEP — the ONLY place this module writes outside boh_*.
 *
 * The map's ruling, and the reason it exists: a held bill must eventually reach
 * orders.status='settled', or /cashier shows it under Outstanding forever, the
 * Sales Dashboard never counts it, and bill-pdf never marks it a reprint. Only
 * the FINAL payment that clears the balance may do this.
 *
 * IT MIRRORS settle/route.ts's fromHold BRANCH EXACTLY, and deliberately so:
 *   · UPDATE orders SET status='settled', payment_method=?, total=?,
 *     settled_at, updated_at   — the same four columns settle writes at :236.
 *     It does NOT rewrite service_charge/discount/tax_total, because settle's
 *     fromHold branch does not either.
 *   · total = Math.round(order.total), the same value settle computes as
 *     `grand` at :121 and stores at :237.
 *   · DELETE + re-INSERT order_payments, the same shape as settle :263-267,
 *     replaying the BOH ledger so the order's tender rows are the truth about
 *     how the bill was actually paid. Idempotent for exactly the reason settle's
 *     own DELETE is.
 *   · payment_method = the single mode, or the literal 'split' when the BOH was
 *     collected in more than one — settle's `primaryMethod` rule at :149.
 *
 * `AND status = 'on_hold'` on the UPDATE is the guard that makes this safe: it
 * can never re-settle a settled bill and can never touch an open one.
 *
 * A TOTAL MISMATCH REFUSES RATHER THAN OVERWRITES. If orders.total no longer
 * rounds to the principal this BOH tracked (only reachable by a direct DB edit
 * or a future route), the BOH still closes — the money in its ledger was really
 * collected — but the order is left untouched and the refusal is recorded on
 * the row for a human. Silently rewriting a bill total to match a debt is the
 * one thing worse than an unreconciled record.
 */
function clearOrderForBoh(
  db: Database.Database,
  orderId: string,
  principal: number,
  actor: BohActor,
  prevOrderSync = '',
): { outcome: string; note: string } {
  const order = db.prepare('SELECT id, status, total FROM orders WHERE id = ?').get(orderId) as any;
  if (!order) return { outcome: 'skipped', note: 'The underlying order row is gone — nothing to settle.' };

  /** The BOH ledger, netted by mode, as the order's tender rows. */
  const replayTenders = (): { groups: any[]; primaryMethod: string } => {
    // Net the BOH ledger by mode so a reversal cancels its original rather than
    // producing a negative tender row settle could never have written.
    const groups = db.prepare(`
      SELECT mode, ROUND(SUM(amount), 2) AS amt FROM boh_payments
       WHERE boh_id = (SELECT id FROM boh_bills WHERE order_id = ? AND status <> 'void' LIMIT 1)
       GROUP BY mode HAVING ROUND(SUM(amount), 2) > 0 ORDER BY mode
    `).all(orderId) as any[];
    const primaryMethod = groups.length === 1 ? S(groups[0].mode) : 'split';
    db.prepare('DELETE FROM order_payments WHERE order_id = ?').run(orderId);
    const outletId = (db.prepare('SELECT outlet_id FROM orders WHERE id = ?').get(orderId) as any)?.outlet_id ?? null;
    const ins = db.prepare('INSERT INTO order_payments (id, order_id, outlet_id, method, amount, created_by) VALUES (?, ?, ?, ?, ?, ?)');
    for (const g of groups) ins.run(generateId(), orderId, outletId, S(g.mode), Number(g.amt), S(actor.email) || S(actor.id));
    return { groups, primaryMethod };
  };

  if (S(order.status) !== 'on_hold') {
    // THE RE-CLEAR. This BOH already settled this bill once (order_sync
    // 'settled'), an admin then REVERSED the clearing payment — a bounced
    // cheque — and the replacement collection has now cleared it again. The
    // order's status and total are already correct and are NOT touched; only
    // the tender replay is refreshed, so order_payments still says how the bill
    // was actually paid (the bounced cheque nets to zero and drops out) instead
    // of naming a tender that never arrived.
    if (S(order.status) === 'settled' && S(prevOrderSync) === 'settled'
        && bohPrincipal(order.total) === bohPrincipal(principal)) {
      const { primaryMethod } = replayTenders();
      db.prepare(`UPDATE orders SET payment_method = ?, updated_at = datetime('now') WHERE id = ? AND status = 'settled'`)
        .run(primaryMethod, orderId);
      return {
        outcome: 'settled',
        note: `The bill was already settled by this BOH; its tenders were refreshed after a reversal (${primaryMethod}).`,
      };
    }
    return { outcome: 'already_settled', note: `The underlying bill was already '${S(order.status)}' — left untouched.` };
  }
  const grand = bohPrincipal(order.total);
  if (grand !== bohPrincipal(principal)) {
    return {
      outcome: 'refused_total_mismatch',
      note: `The bill total is now Rs ${grand} but this BOH tracked Rs ${bohPrincipal(principal)}. ` +
            `The order was NOT settled — a manager must reconcile it in the POS.`,
    };
  }

  const { primaryMethod } = replayTenders();

  db.prepare(`
    UPDATE orders SET status = 'settled', payment_method = ?, total = ?,
           settled_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ? AND status = 'on_hold'
  `).run(primaryMethod, grand, orderId);

  return { outcome: 'settled', note: `Bill settled for Rs ${grand} (${primaryMethod}).` };
}

/**
 * Reverse a payment recorded in error. ADMIN ONLY (the route enforces it).
 *
 * APPEND-ONLY: this writes a NEW row with the negative amount and
 * reverses_payment_id set. It never updates and never deletes the original,
 * because the owner said no history may be overwritten or deleted.
 *
 * A CLOSED BOH IS REVERSIBLE TOO, and that is the fix for the one payment this
 * module used to be unable to correct. The CLEARING payment is precisely the
 * one that closes the record — so refusing every reversal on a closed BOH meant
 * a bounced cheque or a mistyped final amount was permanent, with all six
 * recovery paths refusing (reverse 409 · negative payment 409 · follow-up 409 ·
 * void 409 · close-again 409 · PATCH status ignored) and the POS bill already
 * settled. Reversing on a closed record RE-OPENS it and the debt is chased
 * again.
 *
 * WHAT IT STILL DOES NOT DO: it never un-settles the POS bill. Hold wrote the
 * sales rows and deducted the stock; re-opening a settled order is a POS
 * correction with its own consequences, and this module's own rule forbids it.
 * The order keeps its status and its frozen total, order_sync stays 'settled'
 * so the re-opened record is NOT mis-read as "settled outside this BOH", and
 * the replacement collection re-closes it and refreshes the tender replay
 * (clearOrderForBoh's re-clear branch).
 *
 * VOID is still refused: a voided record is a record that should not exist.
 */
export function reverseBohPayment(db: Database.Database, id: string, paymentId: string, reason: string, actor: BohActor): BohView {
  ensureBohSchema(db);
  const boh = getBoh(db, id);
  if (!boh) throw new BohError('BOH not found', 404);
  if (boh.status === 'void') throw new BohError('This BOH is void — there is nothing to reverse on it', 409);
  const why = S(reason);
  if (!why) throw new BohError('A reason is required to reverse a payment', 400);

  const orig = db.prepare('SELECT * FROM boh_payments WHERE id = ? AND boh_id = ?').get(S(paymentId), boh.id) as any;
  if (!orig) throw new BohError('That payment is not on this BOH', 404);
  if (Number(orig.amount) <= 0) throw new BohError('That row is itself a reversal', 400);
  const already = db.prepare('SELECT id FROM boh_payments WHERE reverses_payment_id = ?').get(S(paymentId)) as any;
  if (already) throw new BohError('That payment has already been reversed', 409);

  const newPaid = money2(boh.paid_amount - Number(orig.amount));
  const newBalance = money2(boh.principal_amount - newPaid);
  const reopens = boh.status === 'closed' && newBalance > 0.005;
  const reopenNote = reopens
    ? `Re-opened on ${bohToday()}: Rs ${money2(orig.amount).toFixed(2)} recorded by ${S(orig.mode)} was reversed — ${why}. ` +
      (S(boh.order_sync) === 'settled'
        ? `The POS bill stays settled (this BOH settled it); collecting the balance here re-closes the record and refreshes its tenders.`
        : `The POS bill was not settled by this BOH and is untouched.`)
    : '';

  db.transaction(() => {
    const railsBefore = snapshotRails(db, boh.order_id);
    db.prepare(`
      INSERT INTO boh_payments (id, boh_id, order_id, paid_on, amount, mode, reference, remarks, reverses_payment_id, created_by, created_by_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(generateId(), boh.id, boh.order_id, bohToday(), -Number(orig.amount), S(orig.mode), S(orig.reference),
           `Reversal: ${why}`, S(paymentId), S(actor.email) || S(actor.id), S(actor.name) || S(actor.email));
    if (reopens) {
      // The close fields are CLEARED, not deleted: closed_at/closed_by named a
      // close that is no longer true. The event itself survives in audit_events
      // (boh.close / boh.payment) and in boh_payments, which is where this
      // module's history actually lives.
      db.prepare(`
        UPDATE boh_bills SET status = 'open', close_kind = '', close_remarks = '',
               closed_at = '', closed_by = '', order_sync_note = ?, updated_at = datetime('now')
         WHERE id = ? AND status = 'closed'
      `).run(reopenNote, boh.id);
    }
    assertRailsUnmoved(railsBefore, snapshotRails(db, boh.order_id));
  })();

  audit(db, 'boh.payment.reverse', boh.id, actor,
    { payment_id: S(paymentId), amount: Number(orig.amount), paid_amount: boh.paid_amount, status: boh.status },
    { paid_amount: newPaid, balance_amount: newBalance, status: reopens ? 'open' : boh.status },
    reopens ? `${why} — the BOH re-opened with Rs ${newBalance.toFixed(2)} outstanding` : why, boh.outlet_id);
  return getBoh(db, boh.id)!;
}

/* ══════════════ THE TILL DOOR — /cashier SETTLING A HELD BILL ═════════════ */

/**
 * WHY THIS EXISTS AT ALL — THE DOUBLE-CHARGE.
 *
 * /cashier's "Outstanding" tab settles a held bill through
 * POST /api/dine-in/orders/[id]/settle, whose fromHold branch collects
 * `Math.round(order.total)` — the WHOLE frozen bill — and knew nothing about
 * boh_payments. Measured end to end: a Rs 681 bill with a Rs 200 BOH partial
 * already taken settled at the till for Rs 681. Rs 881 collected against a
 * Rs 681 bill. The books were NOT doubled (one sales row, revenue booked once,
 * no stock movement — all measured); only the GUEST was.
 *
 * The opposite direction was already guarded: recordBohPayment() refuses with a
 * 409 once the POS has settled the bill. This closes the remaining direction.
 *
 * TWO FUNCTIONS, ON PURPOSE. The settle route is a shared money path and its
 * diff has to stay readable, so it calls exactly one function before the
 * transaction (a pure READ that tells it what may still be collected) and one
 * inside it (the write that records the till's collection in this ledger and
 * closes the record). No SQL of its own; the same one-writer rule as the rest
 * of this module.
 */
export interface BohTillNetting {
  bohId: string;
  /** What the BOH record is tracking. */
  principal: number;
  /** Already collected on the BOH before the guest reached the till. */
  alreadyPaid: number;
  /** What the till may still take: the frozen bill minus alreadyPaid. */
  dueNow: number;
  customerName: string;
  billNumber: string;
  /** 'open' or 'closed'. A CLOSED record still nets — see the note below. */
  status: string;
}

/**
 * READ ONLY. What may still be collected at the till for this held order.
 *
 * Returns null when this order has no live BOH record — every bill held before
 * the module shipped, and any install where the tables do not exist — so the
 * settle route behaves EXACTLY as it did today for those. A real query failure
 * is NOT swallowed: it throws, because the failure mode of guessing here is
 * charging a guest twice.
 *
 * ── WHY `status <> 'void'` AND NOT `status = 'open'` ──────────────────────
 * This used to read `status = 'open'`, and that left the SAME double-collect
 * open through a second door. A WRITE-OFF closes the record and DELIBERATELY
 * leaves the underlying bill 'on_hold' (writing off a debt must not settle a
 * bill nobody paid), so a record that had already collected a deposit stopped
 * netting the moment a manager wrote off the rest — and the till then charged
 * the whole bill again. Measured on a booted server: a Rs 1,100 bill, Rs 300
 * collected on the BOH, written off, settled at the till for Rs 1,100 —
 * Rs 1,400 taken for a Rs 1,100 bill.
 *
 * The same shape reaches 'closed' by one other route: a clearing payment whose
 * order settle was REFUSED for a total mismatch (clearOrderForBoh's
 * 'refused_total_mismatch'), which closes the record with the money collected
 * and leaves the bill on hold. There the netting drives dueNow to zero and the
 * settle route refuses outright, which is the right answer.
 *
 * A VOIDED record is excluded and must stay excluded: void already refuses
 * while any money is on the record ("reverse those payments first"), so a void
 * carries no collections to net. `status <> 'void'` also matches the UNIQUE
 * index ux_boh_bills_order_live exactly, so this can still only ever find one
 * row per order.
 */
export function bohTillNetting(db: Database.Database, orderId: string, frozenGrand: number): BohTillNetting | null {
  let row: any;
  try {
    row = db.prepare(`
      SELECT b.id, b.status, b.principal_amount, b.bill_number, b.customer_name, ${PAID_SQL} AS paid_amount
        FROM boh_bills b WHERE b.order_id = ? AND b.status <> 'void' LIMIT 1
    `).get(S(orderId));
  } catch (e) {
    // The module is not installed on this database at all — the only error
    // shape that is safe to treat as "no BOH".
    if (/no such table/i.test(String((e as any)?.message || e))) return null;
    throw e;
  }
  if (!row) return null;
  const alreadyPaid = money2(row.paid_amount);
  const grand = bohPrincipal(frozenGrand);
  return {
    bohId: S(row.id),
    principal: money2(row.principal_amount),
    alreadyPaid,
    dueNow: money2(grand - alreadyPaid),
    customerName: S(row.customer_name),
    billNumber: S(row.bill_number),
    status: S(row.status),
  };
}

/**
 * Record the till's collection in the BOH ledger and CLOSE the record.
 *
 * CALL INSIDE the settle transaction, AFTER it has written its own
 * order_payments rows. Two writes and one read-back:
 *
 *  1. ONE boh_payments ROW PER TENDER the till took. Not a synthetic lump: the
 *     owner asked for payment capture with a mode, and the mode vocabularies are
 *     identical (settle's VALID_METHODS ≡ BOH_PAYMENT_MODES), so a split settle
 *     lands as a split in this ledger too. This is a PAYMENT RECORD, not a sale
 *     — no rail is touched here, and the settle route's fromHold branch writes
 *     no sales rows and moves no stock either (hold did both).
 *  2. THE PRIOR LEDGER IS REPLAYED into order_payments alongside the till's own
 *     rows, so the order's tenders still sum to the whole bill. Without this the
 *     order would say it was paid Rs 481 against a Rs 681 total.
 *  3. The record CLOSES as paid_in_full, attributed to the person at the till.
 *
 * THIS IS NOT A SILENT AUTO-CLOSE. The module's rule is that a bill whose order
 * left 'on_hold' is surfaced for a human rather than resolved behind their back
 * — and this IS that human, in this request, taking the money. Every held bill
 * settled the way staff actually settle them used to leave its BOH open for
 * ever, overstating pending_amount on the dashboard and accusing its owner of
 * not chasing a bill that was paid.
 *
 * ── AN ALREADY-CLOSED RECORD IS STILL LEDGERED, AND NEVER RE-CLOSED ───────
 * Selecting `status = 'open'` here would have left the netting half of the fix
 * without its write half. A WRITTEN-OFF record keeps its bill on hold, so the
 * till can still settle it; bohTillNetting() now nets that record's earlier
 * collections off the amount taken, and this function must therefore record
 * what the till took and replay the earlier ledger — otherwise the order's
 * tenders would sum to less than its own total and the payment-mode breakup
 * would under-report the difference.
 *
 * What it must NOT do on a closed record is rewrite the close. `write_off` is
 * the manager's judgement and part of the permanent history: money arriving
 * afterwards is a new fact appended to the ledger and stamped into
 * order_sync_note, not a reason to restate the decision as "paid in full". The
 * UPDATE below is therefore still `WHERE ... AND status = 'open'`.
 */
export function absorbTillSettleIntoBoh(
  db: Database.Database,
  orderId: string,
  input: { tenders: { method: string; amount: number }[]; outletId?: string | null; actor: BohActor },
): { bohId: string; closed: boolean; already_paid: number; till_amount: number; method: string;
     was_open: boolean; note: string } | null {
  const row = db.prepare(`
    SELECT b.id, b.status, b.close_kind, b.principal_amount, ${PAID_SQL} AS paid_amount
      FROM boh_bills b WHERE b.order_id = ? AND b.status <> 'void' LIMIT 1
  `).get(S(orderId)) as any;
  if (!row) return null;

  const bohId = S(row.id);
  const wasOpen = S(row.status) === 'open';
  const alreadyPaid = money2(row.paid_amount);
  const actorId = S(input.actor.email) || S(input.actor.id);
  const actorName = S(input.actor.name) || S(input.actor.email);
  const today = bohToday();

  const ins = db.prepare(`
    INSERT INTO boh_payments (id, boh_id, order_id, paid_on, amount, mode, reference, remarks, created_by, created_by_name)
    VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?)
  `);
  let tillAmount = 0;
  for (const t of input.tenders) {
    const amt = money2(t.amount);
    if (!(amt > 0)) continue;
    const mode = S(t.method).toLowerCase();
    ins.run(generateId(), bohId, S(orderId), today, amt,
      (BOH_PAYMENT_MODES as readonly string[]).includes(mode) ? mode : 'other',
      'Collected at the till (Cashier → settle)', actorId, actorName);
    tillAmount = money2(tillAmount + amt);
  }

  // The PRIOR ledger, netted by mode, added to the order's tender rows. The
  // till's own rows were inserted by the settle route moments ago and are left
  // exactly as they are.
  const prior = db.prepare(`
    SELECT mode, ROUND(SUM(amount), 2) AS amt FROM boh_payments
     WHERE boh_id = ? AND remarks <> 'Collected at the till (Cashier → settle)'
     GROUP BY mode HAVING ROUND(SUM(amount), 2) > 0 ORDER BY mode
  `).all(bohId) as any[];
  const insP = db.prepare('INSERT INTO order_payments (id, order_id, outlet_id, method, amount, created_by) VALUES (?, ?, ?, ?, ?, ?)');
  for (const p of prior) insP.run(generateId(), S(orderId), input.outletId ?? null, S(p.mode), Number(p.amt), actorId);

  // payment_method must describe ALL the tenders now on the order, not just the
  // ones the till took.
  const methods = db.prepare('SELECT DISTINCT method FROM order_payments WHERE order_id = ?').all(S(orderId)) as any[];
  const method = methods.length === 1 ? S(methods[0].method) : 'split';
  db.prepare(`UPDATE orders SET payment_method = ? WHERE id = ?`).run(method, S(orderId));

  const note = wasOpen
    ? (alreadyPaid > 0.005
      ? `Settled at the till for Rs ${tillAmount.toFixed(2)}; Rs ${alreadyPaid.toFixed(2)} had already been collected on this record. Both are in the ledger and in the bill's tenders.`
      : `Settled at the till for Rs ${tillAmount.toFixed(2)} by ${actorName || actorId}.`)
    // The record was ALREADY closed (a write-off, or a clearing payment whose
    // order settle was refused). It is not re-closed and its close_kind is not
    // restated — the collection is appended to the ledger and said out loud here.
    : `Collected Rs ${tillAmount.toFixed(2)} at the till AFTER this record was closed as '${S(row.close_kind) || 'closed'}'` +
      `${alreadyPaid > 0.005 ? `; Rs ${alreadyPaid.toFixed(2)} had already been collected here and was netted off, so the guest was charged once` : ''}. ` +
      `The close decision stands as recorded; the money is in this ledger and in the bill's tenders.`;
  db.prepare(`
    UPDATE boh_bills SET status = 'closed', close_kind = 'paid_in_full', close_remarks = '',
           closed_at = datetime('now'), closed_by = ?, order_sync = 'settled', order_sync_note = ?,
           updated_at = datetime('now')
     WHERE id = ? AND status = 'open'
  `).run(actorId, note, bohId);
  if (!wasOpen) {
    // Only the sync fields. status / close_kind / close_remarks / closed_by /
    // closed_at are the closed record's history and are left untouched.
    db.prepare(`UPDATE boh_bills SET order_sync = 'settled', order_sync_note = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(note, bohId);
  }

  // Audited INSIDE the transaction here, unlike every other writer in this file:
  // the settle route owns the transaction, so an audit written after it returns
  // could outlive a rolled-back settle. logAuditEvent never throws.
  audit(db, wasOpen ? 'boh.settled_at_till' : 'boh.collected_at_till_after_close', bohId, input.actor,
    { status: wasOpen ? 'open' : 'closed', close_kind: S(row.close_kind), paid_amount: alreadyPaid },
    { status: 'closed', close_kind: wasOpen ? 'paid_in_full' : S(row.close_kind), paid_amount: money2(alreadyPaid + tillAmount), till_amount: tillAmount },
    note, input.outletId ?? null);

  return { bohId, closed: true, already_paid: alreadyPaid, till_amount: tillAmount, method, was_open: wasOpen, note };
}

/* ═══════════════════════════ CLOSE / VOID ═════════════════════════════════ */

/**
 * Close a BOH that still carries a balance — a WRITE-OFF, or a bill that was
 * collected through the POS outside this record.
 *
 * MANAGEMENT ONLY, and the route enforces that. The reasoning, stated so nobody
 * widens it by accident: hold is a FORWARD commitment a cashier makes with a
 * guest standing there; closing is the WRITE-OFF OF AN ACCOUNTABILITY RECORD
 * ABOUT THAT CASHIER. Letting the responsible user close their own outstanding
 * bill removes the only thing this module is for.
 *
 * A zero-balance close is NOT this function — that is arithmetic and happens
 * automatically inside recordBohPayment(). This is judgement, it is a distinct
 * audited action, and remarks are mandatory.
 */
export function closeBoh(
  db: Database.Database,
  id: string,
  kind: string,
  remarks: string,
  actor: BohActor,
  opts: { acknowledgeCollected?: boolean } = {},
): BohView {
  ensureBohSchema(db);
  const boh = getBoh(db, id);
  if (!boh) throw new BohError('BOH not found', 404);
  if (boh.status !== 'open') throw new BohError(`This BOH is already ${boh.status}`, 409);

  const k = S(kind) || 'write_off';
  if (k !== 'write_off' && k !== 'settled_outside_boh') {
    throw new BohError(`close kind must be 'write_off' or 'settled_outside_boh'`, 400);
  }
  const why = S(remarks);
  if (!why) throw new BohError('Remarks are required to close a BOH that still carries a balance', 400);
  if (k === 'settled_outside_boh' && !boh.reconcile_needed) {
    throw new BohError(`The underlying bill is still on hold — it was not settled outside this BOH. Collect the payment here, or write it off.`, 400);
  }

  // ── THE MONEY THIS RECORD ALREADY TOOK MUST NOT VANISH INTO A CLOSE ─────
  // 'settled_outside_boh' means the till collected the bill while this record
  // was open. If the record ALSO carries collections of its own, the guest was
  // very probably charged twice — settle-from-hold takes Math.round(order.total)
  // and (before the guard added to that route) knew nothing about boh_payments.
  // This branch used to check only reconcile_needed and store free text, so a
  // BOH closed with Rs 200 already collected was indistinguishable from one
  // closed with Rs 0, and the discrepancy left every screen the moment it
  // closed. Now the figure is computed, must be acknowledged explicitly, and is
  // stamped into close_remarks AND the audit row where it cannot be lost.
  const collectedHere = money2(boh.paid_amount);
  const doubleCollect = k === 'settled_outside_boh' && collectedHere > 0.005;
  if (doubleCollect && !opts.acknowledgeCollected) {
    throw new BohError(
      `Rs ${collectedHere.toFixed(2)} was ALREADY COLLECTED against this BOH, and the bill has since been ` +
      `settled at the till for its full amount — the guest may have paid twice. Check what was actually taken ` +
      `before closing this: if the till collected the whole bill, Rs ${collectedHere.toFixed(2)} has to be refunded ` +
      `or accounted for. Confirm you have checked, and the figure will be recorded permanently on this record.`,
      409,
    );
  }
  const storedRemarks = doubleCollect
    ? `${why} [Rs ${collectedHere.toFixed(2)} had already been collected on this BOH before the till settled the bill — ` +
      `possible double collection, acknowledged by ${S(actor.name) || S(actor.email) || S(actor.id)}]`
    : why;

  db.transaction(() => {
    const railsBefore = snapshotRails(db, boh.order_id);
    // A NON-ZERO CLOSE NEVER TOUCHES THE ORDER. A write-off is a decision about
    // the debt, not a collection: it must not settle a bill nobody paid, and it
    // must not un-hold one. The order keeps whatever status it has.
    db.prepare(`
      UPDATE boh_bills SET status = 'closed', close_kind = ?, close_remarks = ?,
             closed_at = datetime('now'), closed_by = ?, updated_at = datetime('now')
       WHERE id = ? AND status = 'open'
    `).run(k, storedRemarks, S(actor.email) || S(actor.id), boh.id);
    assertRailsUnmoved(railsBefore, snapshotRails(db, boh.order_id));
  })();

  audit(db, k === 'write_off' ? 'boh.write_off' : 'boh.close_reconciled', boh.id, actor,
    { status: 'open', balance_amount: boh.balance_amount, paid_amount: collectedHere },
    { status: 'closed', close_kind: k, balance_amount: boh.balance_amount, paid_amount: collectedHere,
      already_collected_here: doubleCollect ? collectedHere : 0 },
    `${k} with Rs ${boh.balance_amount.toFixed(2)} outstanding — ${storedRemarks}`, boh.outlet_id);
  return getBoh(db, boh.id)!;
}

/**
 * Void a BOH created in error. ADMIN ONLY (the route enforces it).
 *
 * A VOID KEEPS THE HISTORY. This sets a status; it deletes nothing. Every
 * assignment, follow-up, payment, reminder and audit row stays exactly where it
 * was, and the timeline still renders. The partial unique index is on
 * status <> 'void' precisely so a corrected record can be created afterwards
 * without the evidence being removed to make room.
 *
 * Refused while money has been collected against it: a voided record with
 * payments would be collected money with no ledger.
 *
 * ── AND REFUSED ON THE HISTORY, NOT ONLY ON THE BALANCE ────────────────────
 * (This paragraph replaces the sentence that used to end the one above —
 * "Reverse the payments first." Reversing no longer unlocks a void, and saying
 * so was the bug.)
 * The balance test alone ("reverse those payments first") could be SATISFIED BY
 * DOING EXACTLY THAT. paid_amount is SUM(boh_payments.amount) (PAID_SQL above),
 * a reversal is a NEW NEGATIVE ROW rather than a delete (reverseBohPayment),
 * so a collection of Rs 500 followed by its reversal nets to 0.00 and the old
 * guard waved the void through. The record that gets erased is the only place
 * the app says that Rs 500 ever arrived and was given back.
 *
 * The worst shape is the one this module was built around: a BOH whose clearing
 * payment SETTLED THE POS BILL (clearOrderForBoh → orders.status 'settled',
 * order_payments rewritten, order_sync 'settled'), and whose payment was then
 * reversed — a bounced cheque. reverseBohPayment deliberately LEAVES THE BILL
 * SETTLED and order_sync 'settled' (see its header), re-opening the BOH to
 * chase the debt. Balance 0.00, bill settled in the POS, void allowed. Voiding
 * there detaches the settled order from the only record explaining how it was
 * settled, and frees the partial unique index so a second live BOH can be
 * opened on an order the books already call paid.
 *
 * So the two facts below are HISTORY and cannot be undone by a later write:
 *   1. any collection row ever recorded (amount > 0), reversed or not;
 *   2. this record having ever cleared its own bill (order_sync = 'settled').
 * A BOH that never took a rupee and never touched its order — the genuine
 * "created in error" case this function exists for — is unaffected, which is
 * every BOH whose timeline holds nothing but assignments and follow-ups.
 * Anything else is corrected by CLOSING it with a reason, which keeps the
 * record and its ledger visible, not by voiding it out of the register.
 */
export function voidBoh(db: Database.Database, id: string, reason: string, actor: BohActor): BohView {
  ensureBohSchema(db);
  const boh = getBoh(db, id);
  if (!boh) throw new BohError('BOH not found', 404);
  if (boh.status === 'void') throw new BohError('This BOH is already void', 409);
  const why = S(reason);
  if (!why) throw new BohError('A reason is required to void a BOH', 400);
  if (boh.paid_amount > 0.005) {
    throw new BohError(
      `Rs ${boh.paid_amount.toFixed(2)} has been collected against this BOH. Reverse those payments first — ` +
      `voiding it would leave collected money with no ledger.`, 409,
    );
  }
  // HISTORY GATE 1 — money that really moved, even if it has since been undone.
  const everPaid = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS gross
       FROM boh_payments WHERE boh_id = ? AND amount > 0.005`,
  ).get(boh.id) as any;
  if (Number(everPaid?.n || 0) > 0) {
    throw new BohError(
      `Rs ${money2(everPaid.gross).toFixed(2)} was collected against this BOH and later reversed, so its balance ` +
      `reads zero — but the money did move, and this record is the only ledger that says so. A void would erase ` +
      `it. Close the record with a reason instead; that keeps the payments and the reversal on the timeline.`,
      409,
    );
  }
  // HISTORY GATE 2 — this record settled its own bill in the POS.
  if (S(boh.order_sync) === 'settled') {
    throw new BohError(
      `This BOH settled its own bill in the POS, so the order is marked paid and its tender rows were written ` +
      `from this ledger. Voiding it would leave a settled bill with no record of how it was paid. Close the ` +
      `record with a reason instead.`,
      409,
    );
  }

  db.transaction(() => {
    const railsBefore = snapshotRails(db, boh.order_id);
    db.prepare(`
      UPDATE boh_bills SET status = 'void', void_reason = ?, voided_at = datetime('now'),
             voided_by = ?, updated_at = datetime('now')
       WHERE id = ?
    `).run(why, S(actor.email) || S(actor.id), boh.id);
    assertRailsUnmoved(railsBefore, snapshotRails(db, boh.order_id));
  })();

  audit(db, 'boh.void', boh.id, actor, { status: boh.status }, { status: 'void' }, why, boh.outlet_id);
  return getBoh(db, boh.id)!;
}

/** Update the chaseable details — contact, company, remarks. Never money, never
 *  the expected date (that moves only through a recorded follow-up). */
export function updateBohDetails(
  db: Database.Database,
  id: string,
  patch: { customerName?: string | null; customerMobile?: string | null; customerCompany?: string | null; remarks?: string | null; reason?: string | null },
  actor: BohActor,
  opts: { allowClosed?: boolean } = {},
): BohView {
  ensureBohSchema(db);
  const boh = getBoh(db, id);
  if (!boh) throw new BohError('BOH not found', 404);
  if (boh.status === 'void') throw new BohError('This BOH was voided', 409);
  // ── A SETTLED RECORD'S IDENTITY IS NOT A CASHIER'S TO REWRITE ───────────
  // customer_name and customer_mobile are two of the three keys the owner named
  // for PERMANENT searchability, and this function overwrites them IN PLACE —
  // the audit row is the only surviving copy of what was there before, and
  // logAuditEvent is best-effort. 'closed' used to fall straight through the
  // void guard, so any cashier still holding a settled record could rewrite the
  // customer on it for ever. A manager may still fix a genuine typo after the
  // fact; the route decides who counts as one (boh-access.canEditBohDetails).
  if (boh.status !== 'open' && !opts.allowClosed) {
    throw new BohError(
      `This BOH is ${boh.status}. A closed record's customer name and number are part of the permanent ` +
      `search history — only a manager or admin can correct them.`,
      403,
    );
  }

  const next = {
    customer_name: patch.customerName === undefined ? boh.customer_name : S(patch.customerName),
    customer_mobile: patch.customerMobile === undefined ? boh.customer_mobile : bohNorm10(patch.customerMobile),
    customer_company: patch.customerCompany === undefined ? boh.customer_company : S(patch.customerCompany),
    remarks: patch.remarks === undefined ? boh.remarks : S(patch.remarks),
    reason: patch.reason === undefined ? boh.reason : S(patch.reason),
  };
  if (patch.customerMobile !== undefined && S(patch.customerMobile) && !next.customer_mobile) {
    throw new BohError('That mobile number is not a valid 10-digit Indian number', 400);
  }
  const source = next.customer_mobile
    ? (boh.customer_mobile === next.customer_mobile ? boh.contact_source : 'captured')
    : 'missing';

  db.transaction(() => {
    const railsBefore = snapshotRails(db, boh.order_id);
    db.prepare(`
      UPDATE boh_bills SET customer_name = ?, customer_mobile = ?, customer_company = ?,
             remarks = ?, reason = ?, contact_source = ?, updated_at = datetime('now')
       WHERE id = ?
    `).run(next.customer_name, next.customer_mobile, next.customer_company, next.remarks, next.reason, source, boh.id);
    assertRailsUnmoved(railsBefore, snapshotRails(db, boh.order_id));
  })();

  audit(db, 'boh.update', boh.id, actor,
    { customer_name: boh.customer_name, customer_mobile: boh.customer_mobile, customer_company: boh.customer_company, remarks: boh.remarks, reason: boh.reason },
    next, '', boh.outlet_id);
  return getBoh(db, boh.id)!;
}

/* ═══════════════════════ DASHBOARD + ACCOUNTABILITY ═══════════════════════ */

export interface BohDashboard {
  total_boh_amount: number;
  pending_amount: number;
  collected_amount: number;
  open_count: number;
  due_today_count: number; due_today_amount: number;
  overdue_count: number;  overdue_amount: number;
  followups_due: number;
  followups_missed: number;
  payments_expected_today: number;
  payments_received_today: number;
  partially_paid_count: number; partially_paid_amount: number;
  closed_count: number; written_off_amount: number;
  contact_missing_count: number;
  reconcile_needed_count: number;
}

/**
 * The dashboard the owner asked for, one query per figure so each one is
 * readable and none can be silently broken by a join.
 *
 * SCOPE IS THE CALLER'S DECISION. Pass responsibleUserId for a non-management
 * viewer and every figure is that person's own; pass null for management and
 * they are the outlet's. The route decides which — see src/lib/boh-access.ts.
 */
export function bohDashboard(db: Database.Database, f: { responsibleUserId?: string | null; outletId?: string | null } = {}): BohDashboard {
  ensureBohSchema(db);
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.responsibleUserId != null) { where.push('b.responsible_user_id = ?'); params.push(S(f.responsibleUserId)); }
  if (f.outletId) { where.push('(b.outlet_id = ? OR b.outlet_id IS NULL)'); params.push(S(f.outletId)); }
  const scope = where.length ? ' AND ' + where.join(' AND ') : '';

  const num = (sql: string, extra: unknown[] = []): number => {
    try { return Number((db.prepare(sql).get(...params, ...extra) as any)?.n ?? 0) || 0; }
    catch { return 0; }
  };

  const OPEN = `b.status = 'open'${scope}`;
  return {
    // "total BOH amount" = the principal of every LIVE record (open + closed),
    // which is what was ever put on hold. Voids are excluded everywhere: a
    // voided record is a mistake, not a debt.
    total_boh_amount: money2(num(`SELECT SUM(b.principal_amount) AS n FROM boh_bills b WHERE b.status <> 'void'${scope}`)),
    pending_amount: money2(num(`SELECT SUM(${BALANCE_SQL}) AS n FROM boh_bills b WHERE ${OPEN}`)),
    collected_amount: money2(num(`SELECT SUM(${PAID_SQL}) AS n FROM boh_bills b WHERE b.status <> 'void'${scope}`)),
    open_count: num(`SELECT COUNT(*) AS n FROM boh_bills b WHERE ${OPEN}`),
    due_today_count: num(`SELECT COUNT(*) AS n FROM boh_bills b WHERE ${OPEN} AND b.expected_payment_date = ${IST_TODAY_SQL}`),
    due_today_amount: money2(num(`SELECT SUM(${BALANCE_SQL}) AS n FROM boh_bills b WHERE ${OPEN} AND b.expected_payment_date = ${IST_TODAY_SQL}`)),
    overdue_count: num(`SELECT COUNT(*) AS n FROM boh_bills b WHERE ${OPEN} AND b.expected_payment_date <> '' AND b.expected_payment_date < ${IST_TODAY_SQL}`),
    overdue_amount: money2(num(`SELECT SUM(${BALANCE_SQL}) AS n FROM boh_bills b WHERE ${OPEN} AND b.expected_payment_date <> '' AND b.expected_payment_date < ${IST_TODAY_SQL}`)),
    // DUE and MISSED cannot overlap — see FOLLOWUP_STATE_SQL.
    followups_due: num(`SELECT COUNT(*) AS n FROM boh_bills b WHERE ${OPEN} AND ${FOLLOWUP_STATE_SQL} = 'due'`),
    followups_missed: num(`SELECT COUNT(*) AS n FROM boh_bills b WHERE ${OPEN} AND ${FOLLOWUP_STATE_SQL} = 'missed'`),
    payments_expected_today: money2(num(`SELECT SUM(${BALANCE_SQL}) AS n FROM boh_bills b WHERE ${OPEN} AND b.expected_payment_date = ${IST_TODAY_SQL}`)),
    payments_received_today: money2(num(
      `SELECT SUM(p.amount) AS n FROM boh_payments p JOIN boh_bills b ON b.id = p.boh_id
        WHERE p.paid_on = ${IST_TODAY_SQL} AND b.status <> 'void'${scope}`)),
    partially_paid_count: num(`SELECT COUNT(*) AS n FROM boh_bills b WHERE ${OPEN} AND ${PAID_SQL} > 0 AND ${BALANCE_SQL} > 0`),
    partially_paid_amount: money2(num(`SELECT SUM(${BALANCE_SQL}) AS n FROM boh_bills b WHERE ${OPEN} AND ${PAID_SQL} > 0 AND ${BALANCE_SQL} > 0`)),
    closed_count: num(`SELECT COUNT(*) AS n FROM boh_bills b WHERE b.status = 'closed'${scope}`),
    written_off_amount: money2(num(`SELECT SUM(${BALANCE_SQL}) AS n FROM boh_bills b WHERE b.status = 'closed' AND b.close_kind = 'write_off'${scope}`)),
    // THE OWNER'S GAP #1 MADE VISIBLE: you cannot chase a customer you have no
    // number for, so the count of them is a headline figure, not a footnote.
    contact_missing_count: num(`SELECT COUNT(*) AS n FROM boh_bills b WHERE ${OPEN} AND TRIM(b.customer_mobile) = ''`),
    reconcile_needed_count: num(
      `SELECT COUNT(*) AS n FROM boh_bills b WHERE ${OPEN}
        AND COALESCE(b.order_sync,'') <> 'settled'
        AND COALESCE((SELECT o.status FROM orders o WHERE o.id = b.order_id),'') <> 'on_hold'`),
  };
}

export interface BohAccountabilityRow {
  user_id: string; user_name: string; user_email: string;
  total_assigned: number; total_assigned_amount: number;
  pending_amount: number; overdue_amount: number;
  followups_due: number; followups_missed: number;
  payments_collected: number;
}

/**
 * The user-wise accountability view. MANAGEMENT ONLY (the route enforces it) —
 * it is a cross-user money table by construction.
 *
 * Every figure is attributed to the CURRENT responsible user. A reassignment
 * moves the bill's future accountability without erasing the chain: who held it
 * and when is in boh_assignments, and no row there is ever updated or removed.
 */
export function bohAccountability(db: Database.Database, f: { outletId?: string | null } = {}): BohAccountabilityRow[] {
  ensureBohSchema(db);
  const params: unknown[] = [];
  let scope = '';
  if (f.outletId) { scope = ' AND (b.outlet_id = ? OR b.outlet_id IS NULL)'; params.push(S(f.outletId)); }
  try {
    const rows = db.prepare(`
      SELECT b.responsible_user_id                                   AS user_id,
             MAX(b.responsible_name)                                 AS user_name,
             MAX(b.responsible_email)                                AS user_email,
             SUM(CASE WHEN b.status = 'open' THEN 1 ELSE 0 END)      AS total_assigned,
             SUM(CASE WHEN b.status = 'open' THEN b.principal_amount ELSE 0 END) AS total_assigned_amount,
             SUM(CASE WHEN b.status = 'open' THEN ${BALANCE_SQL} ELSE 0 END)     AS pending_amount,
             SUM(CASE WHEN b.status = 'open' AND b.expected_payment_date <> ''
                       AND b.expected_payment_date < ${IST_TODAY_SQL}
                      THEN ${BALANCE_SQL} ELSE 0 END)                AS overdue_amount,
             SUM(CASE WHEN ${FOLLOWUP_STATE_SQL} = 'due'    THEN 1 ELSE 0 END)   AS followups_due,
             SUM(CASE WHEN ${FOLLOWUP_STATE_SQL} = 'missed' THEN 1 ELSE 0 END)   AS followups_missed,
             SUM(${PAID_SQL})                                        AS payments_collected
        FROM boh_bills b
       WHERE b.status <> 'void'${scope}
       GROUP BY b.responsible_user_id
       ORDER BY pending_amount DESC, followups_missed DESC
    `).all(...params) as any[];
    return rows.map((r) => ({
      user_id: S(r.user_id), user_name: S(r.user_name) || S(r.user_email) || S(r.user_id), user_email: S(r.user_email),
      total_assigned: Number(r.total_assigned) || 0,
      total_assigned_amount: money2(r.total_assigned_amount),
      pending_amount: money2(r.pending_amount),
      overdue_amount: money2(r.overdue_amount),
      followups_due: Number(r.followups_due) || 0,
      followups_missed: Number(r.followups_missed) || 0,
      payments_collected: money2(r.payments_collected),
    }));
  } catch (e) {
    console.error('[boh] accountability failed:', e);
    return [];
  }
}
