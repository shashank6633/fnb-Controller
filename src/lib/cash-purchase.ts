import type { Database } from 'better-sqlite3';
import { generateId, logAuditEvent } from '@/lib/db';
import { fmtRs, toRupees } from '@/lib/petty-cash';

/**
 * CASH PURCHASE — the bridge between a vendor bill and the petty cash box.
 *
 * ── THE OWNER'S DESIGN, AND WHY IT IS SHAPED THIS WAY ───────────────────────
 * "Keep it in Enter Vendor Bill, add an option of Cash purchase. If they click
 *  on it, it will be added on petty cash."
 *
 * So there is NO new bill form and NO new writer of `purchases`. A cash market
 * run is recorded exactly where every other hand-typed bill is recorded —
 * POST /api/grn — and ticking the option adds ONE petty_cash_ledger row inside
 * that same transaction. src/app/api/grn/route.ts forbids a second bill-entry
 * route in capitals (~:55-61); this file is the money leg of the first one, not
 * a second one. It writes to petty_cash_ledger and to nothing else.
 *
 * ── THE THREE FACTS THIS MODULE EXISTS TO KEEP STRAIGHT ─────────────────────
 *
 * 1. THE CASH LEAVES THE BOX WHETHER OR NOT THE KITCHEN LIKES THE TOMATOES.
 *    A GRN carrying a QC-gated line is held: no stock, no `purchases` row, and
 *    the Purchase Report cannot show it until the kitchen signs
 *    (src/lib/purchase-log.ts excludes 'awaiting_qc' outright). The MONEY is not
 *    conditional on any of that — it was handed over at the stall. So the ledger
 *    row is written on the unconditional path of the GRN transaction, never
 *    inside the `!qc.required` branch, and the form says so at the moment of
 *    saving.
 *
 * 2. THE LINK IS grn_id, NOT purchase_id. petty_cash_ledger.purchase_id points
 *    at ONE `purchases` LINE, and that route's own comment says a single line
 *    "cannot honestly represent a cash payment against a multi-line vendor bill"
 *    (api/petty-cash/route.ts). Worse, a GRN void HARD-DELETES the purchases
 *    rows (src/lib/grn-reversal.ts), so a purchase_id link dangles the moment
 *    anyone corrects a receipt. The GRN HEADER survives a void (it is marked
 *    'void', never deleted), so grn_id is the only link that stays true.
 *    purchase_id is left alone and un-deprecated; this path simply never sets it.
 *
 * 3. THE VOUCHER NUMBER IS OURS, AND IT IS MINTED THE WAY PINV IS MINTED.
 *    The vendor bill number is mandatory on this form and a market run has no
 *    paper, so a cash receipt takes a PCV-yyyy-#### of its own — the same shape,
 *    the same lazy MAX()+1 inside the transaction, and the same "reuse a number
 *    that already exists" discipline as PINV. It is PRE-FILLED, not forced: type
 *    the vendor's real number over it and that number is stored instead.
 */

/** The petty-cash category a bill paid from the box lands in. */
export const CASH_CATEGORY = 'cash_purchase';

/**
 * OUR cash voucher number. Deliberately NOT the same prefix as PINV: PINV is
 * our invoice id for a bill (purchases.invoice_id) and this is a stand-in for
 * the VENDOR's bill number (goods_receipt_notes.invoice_number /
 * purchases.bill_no). Two different columns, two different meanings, so two
 * different prefixes — a reader who sees PCV in the Bill No column knows at
 * once that no vendor document exists.
 */
const PCV_RE = /^PCV-\d{4}-\d+$/i;

/**
 * Is this bill number one WE minted rather than one the vendor wrote?
 *
 * Used for exactly one decision: a PCV that arrives in the payload is a
 * PREVIEW the form pre-filled, so the server mints a fresh authoritative one
 * inside the transaction rather than trusting it. Two storekeepers with the
 * form open at once would otherwise both post PCV-2026-0007.
 */
export function isMintedCashVoucher(v: unknown): boolean {
  return PCV_RE.test(String(v || '').trim());
}

/**
 * The next free PCV-yyyy-####.
 *
 * MIRRORS THE PINV MINT (api/grn/route.ts mintInvoiceId) IN SHAPE AND IN
 * CONCURRENCY POSTURE: MAX(the numeric tail) + 1, read inside the caller's
 * transaction so a second sign-off in the same process cannot take the same
 * number. better-sqlite3 is synchronous, so within one process the whole
 * transaction body runs uninterrupted and the read-then-write is indivisible.
 *
 * IT GOES ONE STEP FURTHER THAN PINV, and cheaply: after MAX()+1 it walks
 * forward past any number already on the books. That closes the cross-process
 * window a deferred BEGIN leaves open, and it is what makes "unique by
 * construction" true rather than merely likely — which matters here because the
 * duplicate-bill guard keys on this string.
 *
 * ALL THREE COLUMNS ARE SCANNED, AND THE THIRD IS THE LOAD-BEARING ONE.
 * The number is written to goods_receipt_notes.invoice_number, mirrored to
 * purchases.bill_no, and recorded as petty_cash_ledger.reference. On a QC-HELD
 * receipt only the first exists until the kitchen signs — but the first two are
 * BOTH rewritten by PUT /api/grn/[id] the moment the vendor's real bill turns
 * up, which is a flow this feature explicitly invites ("type the vendor's real
 * number over it"). Scanning only those two re-issued a LIVE voucher after one
 * ordinary amendment: two different payments, two vendors, one number in the
 * cash book, and nothing to tell them apart. The ledger is append-only and is
 * therefore the one column the number is guaranteed to survive in.
 */
export function mintCashVoucherNo(db: Database): string {
  const y = new Date().getFullYear();
  const prefix = `PCV-${y}-`;
  const like = `${prefix}%`;
  const maxRow = db.prepare(`
    SELECT MAX(n) AS n FROM (
      SELECT CAST(substr(invoice_number, ?) AS INTEGER) AS n
        FROM goods_receipt_notes WHERE invoice_number LIKE ?
      UNION ALL
      SELECT CAST(substr(bill_no, ?) AS INTEGER) AS n
        FROM purchases WHERE bill_no LIKE ?
      UNION ALL
      SELECT CAST(substr(reference, ?) AS INTEGER) AS n
        FROM petty_cash_ledger WHERE reference LIKE ?
    )
  `).get(prefix.length + 1, like, prefix.length + 1, like,
         prefix.length + 1, like) as { n: number | null } | undefined;

  const taken = db.prepare(`
    SELECT 1 AS hit FROM goods_receipt_notes WHERE invoice_number = ?
     UNION ALL
    SELECT 1 AS hit FROM purchases WHERE bill_no = ?
     UNION ALL
    SELECT 1 AS hit FROM petty_cash_ledger WHERE reference = ?
     LIMIT 1
  `);
  let n = (Number(maxRow?.n) || 0) + 1;
  // Bounded: MAX()+1 is already free in every ordinary case, so this loop is a
  // belt on a pair of braces. 10,000 iterations is far past any real sequence
  // and stops a corrupted row (a hand-typed 'PCV-2026-99999999') from spinning.
  for (let i = 0; i < 10_000; i++) {
    const candidate = `${prefix}${String(n).padStart(4, '0')}`;
    if (!taken.get(candidate, candidate, candidate)) break;
    n++;
  }
  return `${prefix}${String(n).padStart(4, '0')}`;
}

/** The receipt a voucher number is already spoken for by — see cashVoucherOwner. */
export interface CashVoucherOwner {
  grn_id: string;
  grn_number: string;
  date: string;
  vendor: string;
}

/**
 * IS THIS VOUCHER NUMBER ALREADY SPOKEN FOR?
 *
 * ── WHY THIS EXISTS: THE FORM'S PREVIEW CAN BE POSTED TWICE ─────────────────
 * POST /api/grn treats a minted voucher as a BLANK bill number for both
 * duplicate guards, on the honest reading that a PCV is not the vendor's
 * document. That reading is right about comparing two DIFFERENT bills and wrong
 * about the case that actually happens: the SAME pre-filled preview posted twice
 * from one open form after a save that appeared to fail. Measured before this
 * guard existed — one market run, two saves, ₹290.10 out of the box twice and
 * the stock doubled, while the identical string sent as a credit bill was
 * refused 409 by a guard that had the data all along.
 *
 * A PCV is minted strictly forward, so the ONLY way one can arrive on a second
 * save is a form opened before the first save committed. That is either a
 * re-submission (refuse it) or a second tablet holding a stale preview (refuse
 * it too, and say to re-open the form — the cost is one reload, and the
 * alternative is paying a stall twice).
 *
 * BOTH DOORS ARE READ, for the same reason mintCashVoucherNo reads three
 * columns: an amendment moves the number off the receipt but never off the
 * ledger. A VOIDED receipt releases its number here — voiding and re-entering
 * is the sanctioned way to redo a receipt, and the mint will hand the re-entry a
 * fresh number anyway because the voided run's ledger row still holds the old
 * one.
 */
export function cashVoucherOwner(db: Database, voucher: string): CashVoucherOwner | null {
  const v = String(voucher || '').trim().toLowerCase();
  if (!v) return null;
  const onReceipt = db.prepare(`
    SELECT id AS grn_id, grn_number, date, vendor
      FROM goods_receipt_notes
     WHERE LOWER(TRIM(COALESCE(invoice_number, ''))) = ?
       AND status <> 'void'
     ORDER BY created_at ASC
     LIMIT 1
  `).get(v) as CashVoucherOwner | undefined;
  if (onReceipt) return onReceipt;
  try {
    const onLedger = db.prepare(`
      SELECT g.id AS grn_id, g.grn_number AS grn_number, g.date AS date, g.vendor AS vendor
        FROM petty_cash_ledger l
        JOIN goods_receipt_notes g ON g.id = l.grn_id
       WHERE LOWER(TRIM(COALESCE(l.reference, ''))) = ?
         AND g.status <> 'void'
       ORDER BY l.created_at ASC
       LIMIT 1
    `).get(v) as CashVoucherOwner | undefined;
    return onLedger || null;
  } catch {
    // grn_id arrives by boot migration; before it exists there are no cash rows
    // to collide with, and the receipt scan above has already answered.
    return null;
  }
}

/**
 * THE SAME MARKET RUN, PAID FOR TWICE — the guard that does not need a number.
 *
 * cashVoucherOwner() above catches ONE preview posted twice, which is the
 * double-click. It cannot catch the two vectors that were measured paying a
 * stall twice for one basket of vegetables:
 *
 *   · the bill-number box CLEARED on a cash run. The payload then carries no
 *     number at all, so `dupBill`, `dupMirror` AND the voucher guard are all
 *     switched off and the second save has no guard whatsoever;
 *   · TWO FORM OPENS. Each previews a DIFFERENT free voucher, so the two saves
 *     are two different numbers by construction and the voucher guard is blind
 *     to them by design.
 *
 * Both were 201/201 — ₹600 out of a box for ₹300 of goods, and the stock
 * doubled with it. The only identity such a run has is WHAT IT WAS: one outlet,
 * one day, one vendor, one amount. That is the same key POST /api/petty-cash
 * already refuses a re-click on (date + direction + amount + vendor …), applied
 * to the door that also brings goods in.
 *
 * CONFIRMABLE, NOT A HARD REFUSAL, and that is the difference from a duplicate
 * BILL number. A repeated bill number is the vendor's own document saying "this
 * is the same paper"; this is a coincidence of four fields, and two ₹500 runs to
 * the same sabziwala in one day are a real thing that must not be walled off.
 * The caller re-posts with `confirm_duplicate_cash: true` and it saves.
 *
 * A VOIDED RECEIPT IS NOT AN OWNER — voiding and re-entering is the sanctioned
 * way to redo a receipt, and its cash row deliberately stands (the vendor may
 * never have refunded), so counting it would make the redo impossible.
 * ROWS WITH NO grn_id ARE NOT READ: a movement typed by hand on /petty-cash is
 * somebody's deliberate entry, not this route's own write, and refusing a
 * receipt over it would be this route policing a book it did not write.
 */
export function cashRunAlreadyPaid(
  db: Database,
  p: { outletId: string | null; date: string; vendor: string; amountPaise: number; excludeGrnId?: string },
): { grn_number: string; date: string; vendor: string; recorded_by: string; created_at: string } | null {
  try {
    return db.prepare(`
      SELECT g.grn_number AS grn_number, l.date AS date, l.vendor AS vendor,
             l.recorded_by AS recorded_by, l.created_at AS created_at
        FROM petty_cash_ledger l
        JOIN goods_receipt_notes g ON g.id = l.grn_id
       WHERE l.direction = 'out'
         AND l.category  = ?
         AND l.date      = ?
         AND COALESCE(l.outlet_id, '') = COALESCE(?, '')
         AND LOWER(TRIM(COALESCE(l.vendor, ''))) = ?
         -- Integer paise on BOTH sides: petty_cash_ledger.amount is REAL, and a
         -- float compare on money is how a match silently stops matching.
         AND CAST(ROUND(l.amount * 100) AS INTEGER) = ?
         AND g.status <> 'void'
         AND COALESCE(l.grn_id, '') <> COALESCE(?, '')
       ORDER BY l.created_at ASC
       LIMIT 1
    `).get(CASH_CATEGORY, p.date, p.outletId, String(p.vendor || '').toLowerCase().trim(),
           Math.round(p.amountPaise), p.excludeGrnId || '') as any || null;
  } catch {
    // grn_id arrives by boot migration; before it exists this route has written
    // no cash rows at all, so there is nothing to collide with.
    return null;
  }
}

export interface CashPurchaseRow {
  id: string;
  date: string;
  amount: number;
  vendor: string;
  reference: string;
  notes: string;
  recorded_by: string;
  grn_id: string | null;
}

/** The cash row a receipt paid with, or null when the bill was on credit. */
export function cashLedgerForGrn(db: Database, grnId: string): CashPurchaseRow | null {
  try {
    const r = db.prepare(`
      SELECT id, date, amount, vendor, reference, notes, recorded_by, grn_id
        FROM petty_cash_ledger
       WHERE grn_id = ? AND direction = 'out'
       ORDER BY created_at ASC, rowid ASC
       LIMIT 1
    `).get(grnId) as CashPurchaseRow | undefined;
    return r || null;
  } catch {
    // The column is added by a boot migration. If it is somehow absent, "no
    // cash row" is the safe answer for every caller: the sign-off then stamps
    // no payment_mode and the void prints no cash sentence, which understates
    // rather than inventing a payment that cannot be proved.
    return null;
  }
}

/** Was this receipt paid out of the petty cash box? */
export function grnPaidInCash(db: Database, grnId: string): boolean {
  return cashLedgerForGrn(db, grnId) !== null;
}

/**
 * WRITE THE MONEY LEG. One row, direction 'out', linked by grn_id.
 *
 * MUST be called inside the GRN's own transaction — the cash row and the
 * receipt commit together or not at all. That is the whole reason the option
 * lives on the bill form rather than being a second gesture on another screen.
 *
 * NO NEGATIVE-CASH REFUSAL IS CONSULTED, and that is deliberate rather than an
 * omission: see src/lib/petty-cash.ts outflowWarning(). The storekeeper is
 * standing in the store holding vegetables he has already paid for; refusing to
 * record the purchase because the box is ₹200 short on paper would make the app
 * lie about goods that exist. The overdraft is reported, never enforced.
 */
export function recordCashPurchase(
  db: Database,
  p: {
    grnId: string;
    grnNumber: string;
    /** The receipt date — the same date the cost is recorded against. */
    date: string;
    /** Integer paise. The bill total actually handed over; see the caller. */
    amountPaise: number;
    vendor: string;
    /** The bill / voucher number the box is reconciled against. */
    reference: string;
    lineCount: number;
    outletId: string | null;
    actorEmail: string;
  },
): string {
  const id = generateId();
  const amount = toRupees(p.amountPaise);
  // IMMUTABLE FACTS ONLY. "Goods awaiting a kitchen check" is a state that
  // changes an hour later, so it is DERIVED on read (petty-cash.ts joins the
  // GRN and reports its live status) rather than frozen into a note that goes
  // stale the moment the kitchen signs.
  const notes = `Cash purchase on ${p.grnNumber} · ${p.lineCount} item${p.lineCount === 1 ? '' : 's'}`;
  db.prepare(`
    INSERT INTO petty_cash_ledger
      (id, outlet_id, date, direction, amount, category, purchase_id, grn_id, vendor, reference, notes, recorded_by)
    VALUES (?, ?, ?, 'out', ?, ?, NULL, ?, ?, ?, ?, ?)
  `).run(id, p.outletId, p.date, amount, CASH_CATEGORY, p.grnId,
         String(p.vendor || '').slice(0, 200), String(p.reference || '').slice(0, 120),
         notes, p.actorEmail);

  // THE SAME EVENT TYPE THE PETTY CASH FORM WRITES, so the cash book has one
  // audit trail whichever door the money went out of.
  logAuditEvent(db, {
    event_type: 'petty_cash.record',
    entity_type: 'petty_cash_ledger',
    entity_id: id,
    actor_email: p.actorEmail,
    outlet_id: p.outletId,
    after: {
      date: p.date, direction: 'out', amount, category: CASH_CATEGORY,
      vendor: p.vendor, reference: p.reference, notes,
      purchase_id: null, grn_id: p.grnId, grn_number: p.grnNumber,
    },
    note: `Cash out ${fmtRs(p.amountPaise)} — Cash purchase on ${p.grnNumber}`,
  });
  return id;
}
