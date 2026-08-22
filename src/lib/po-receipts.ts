import type { getDb } from '@/lib/db';

/* ══════════════════════════════════════════════════════════════════════════
 * THE PO RECEIPT LEDGER — ONE FILE, ONE DOCTRINE.
 *
 * There is no per-line received flag on purchase_order_items (and no column may
 * be added — see receive/route.ts:26-42). "This PO line is received" is DERIVED:
 * a goods_receipt_note_items row carries that po_item_id under a GRN whose
 * po_id is this PO. /api/grn writes po_id = NULL and po_item_id = NULL on every
 * ad-hoc GRN, so the PO receive route is the only writer of those rows.
 *
 * WHY THIS FILE EXISTS. That derivation had been written out NINE separate
 * times across seven files, in seven different spellings, and the five that
 * answer "is this PO line spoken for?" carried NO status filter at all:
 *
 *   receive/route.ts:59-68        receivedPoItemIds()   — none   (claim)
 *   receive/route.ts:134-140      grnByItem             — none   (claim)
 *   purchase-orders/route.ts:233  the detail fold       — none   (claim)
 *   purchase-orders/route.ts:281  the per-receipt roll  — none   (value)
 *   purchase-orders/route.ts:378  received_line_count   — none   (claim)
 *   purchase-orders/route.ts:409  delivered/outstanding — none   (claim)
 *   edit-approved/route.ts:42-63  receiptsOnPo()        — none   (claim)
 *   purchase-log.ts:844-848       link_raw              — none   (claim)
 *                                   ↑ the eighth. It shipped unfiltered with the
 *                                   first six and was fixed on 2026-08-23, after
 *                                   it was MEASURED returning the voided receipt
 *                                   as an ordered line's link key. It now takes
 *                                   claimJoin() like the rest.
 *   receive/route.ts:1563-1568    the `prior` net       — none   (value)
 *   ... while returns.ts:374, grn-reversal.ts:1735, grn-qc.ts:1818,
 *   grn/route.ts:263, anomalies:197, receiving-variance:58 and
 *   purchase-log.ts:802 each carried their own, in four more spellings.
 *
 * A voided GRN keeps its goods_receipt_note_items rows — it must, they ARE the
 * bill — so an unfiltered derivation says a voided receipt still claims its PO
 * line, and that PO can never be received again. THAT is what made a PO-sourced
 * GRN unvoidable, and it is the reason this file exists: the void shipped only
 * once all nine derivations came through here. Patching each in place would have
 * fixed the five and guaranteed a tenth copy reintroduced the bug.
 *
 * THE RULE FOR ANY NEW QUERY: if it reaches goods_receipt_notes from a GRN line
 * in order to say something about a PURCHASE ORDER, it comes out of this file —
 * a shaped reader below, or claimJoin() for the raw-SQL contexts that cannot
 * call one. Do not hand-write `JOIN goods_receipt_notes g ON g.id = gi.grn_id`
 * against a PO again.
 *
 * ── AND THERE ARE TWO PREDICATES, NOT ONE. CONFLATING THEM IS THE MOST
 *    DANGEROUS MISTAKE AVAILABLE HERE. ──────────────────────────────────────
 *
 *   CLAIM — "is this PO line spoken for?"   →  void only.
 *     A GRN held for a kitchen quality check (status 'awaiting_qc') HAS claimed
 *     its line: the goods are in the building and the bill exists; it simply has
 *     not moved stock yet. receive/route.ts:1630-1632 states this outright —
 *     isComplete measures the receipt LEDGER, and a held GRN has its rows.
 *     Excluding 'awaiting_qc' from the CLAIM would make a held PO receivable a
 *     second time: two bills, two stock credits, one delivery.
 *
 *   VALUE — "does this bill's money count?" →  void AND awaiting_qc.
 *     A held line's quantity_accepted is pinned to 0 — the ABSENCE of a
 *     decision, not a decision to accept nothing — while its charges are stored
 *     in full. purchase-log.ts:785-802 and grn-reversal.ts:1700-1721 spell out
 *     what including it does to a money column.
 *
 * Every reader below says which of the two it is answering, and why.
 * ══════════════════════════════════════════════════════════════════════════ */

type Db = ReturnType<typeof getDb>;

/** The one status string that means "this receipt was undone". */
const VOID = 'void';
/** grn-qc.ts's QC_AWAITING, restated rather than imported: this file must stay
 *  free of runtime imports so it can be loaded by a verification harness with
 *  no module resolution. Any drift is caught by the tests that assert a held
 *  GRN still CLAIMS its line. */
const AWAITING_QC = 'awaiting_qc';

/**
 * CLAIM predicate. Use for "is this PO line already received / spoken for?".
 * COALESCE because goods_receipt_notes.status is NOT NULL DEFAULT 'received'
 * today but the column has been loosened before elsewhere; a NULL must read as
 * live, never as void. (Measured 2026-08-22: 0 NULL statuses in 29 rows.)
 */
export const liveClaimSql = (grn = 'g'): string =>
  `COALESCE(${grn}.status, '') <> '${VOID}'`;

/**
 * VALUE predicate. Use for any SUM of a bill's money.
 * NOT used by receivedNet() below — see the note there; that function must keep
 * today's treatment of a held receipt byte-for-byte. This export exists for the
 * money sums that need it, above all the `prior` net at
 * [id]/receive/route.ts:1563-1568, which is the third copy of a sum whose other
 * two copies (grn-reversal.ts:1735, grn-qc.ts:1818) are already void-aware.
 */
export const liveValueSql = (grn = 'g'): string =>
  `COALESCE(${grn}.status, '') NOT IN ('${VOID}', '${AWAITING_QC}')`;

/**
 * THE JOIN. A caller cannot reach goods_receipt_notes from a GRN line without
 * spelling the filter, because the filter is inside the string they must use.
 *
 * `poIdCol` puts the PO guard in the ON clause beside the status guard, which is
 * REQUIRED on a LEFT JOIN: appending `AND g.status <> 'void'` to the WHERE of a
 * LEFT JOIN collapses it into an INNER JOIN, and every PO line with no receipt
 * at all silently disappears from the result. That is the single easiest way to
 * get this wrong, and it is why the helper hands out a join rather than a
 * condition.
 *
 * Only for raw-SQL contexts that cannot call a shaped reader (a scalar subquery
 * inside a larger SELECT, a compound SELECT branch). Prefer a reader.
 */
export function claimJoin(opts: {
  /** alias for goods_receipt_notes (default 'g') */
  grn?: string;
  /** alias for goods_receipt_note_items already in scope (default 'gi') */
  item?: string;
  /** emit LEFT JOIN — mandatory when the GRN side may be absent */
  left?: boolean;
  /** column/expression the GRN's po_id must equal, e.g. 'poi.po_id' */
  poIdCol?: string;
} = {}): string {
  const g = opts.grn || 'g';
  const gi = opts.item || 'gi';
  const kind = opts.left ? 'LEFT JOIN' : 'JOIN';
  const po = opts.poIdCol ? ` AND ${g}.po_id = ${opts.poIdCol}` : '';
  return `${kind} goods_receipt_notes ${g} ON ${g}.id = ${gi}.grn_id${po} AND ${liveClaimSql(g)}`;
}

/** The "a po_item_id is actually present on this GRN line" guard, restated once.
 *  Ad-hoc GRN lines carry NULL here; a legacy row can carry ''. */
const HAS_PO_ITEM = `gi.po_item_id IS NOT NULL AND TRIM(gi.po_item_id) != ''`;

/* ───────────────────────────────────────────────────────────────────────────
 * SITE 1 — the receipt ledger
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * CLAIM. po_item_ids on this PO already covered by a LIVE GRN.
 *
 * THE receipt ledger. Read by the receive screen (which lines are outstanding),
 * by the pre-transaction 409, and re-read INSIDE the receive transaction after
 * this call's rows are inserted, where it is the sole input to the
 * approved → received transition. A voided receipt drops out of all three: its
 * line returns to outstanding, its vendor reappears on the receive screen, and
 * the PO reopens — which is the whole point.
 */
export function receivedPoItemIds(db: Db, poId: string): Set<string> {
  const rows = db.prepare(`
    SELECT DISTINCT gi.po_item_id AS po_item_id
    FROM goods_receipt_note_items gi
    ${claimJoin()}
    WHERE g.po_id = ? AND ${HAS_PO_ITEM}
  `).all(poId) as any[];
  return new Set(rows.map(r => String(r.po_item_id)));
}

/**
 * WHICH PO LINES THIS ONE RECEIPT SPEAKS FOR — the other half of the ledger.
 *
 * Not one of the six: it does not reach goods_receipt_notes at all, because it
 * asks about a single GRN by id and that row's own status is the caller's
 * business, not this query's. It lives here anyway so that HAS_PO_ITEM — the
 * "a po_item_id is actually present" guard, which a legacy '' row fails — is
 * stated in exactly one place.
 *
 * THE VOID'S COMPLETION TEST IS BUILT ON IT. Subtract this set from
 * receivedPoItemIds() (read AFTER the void's claim, so it already excludes this
 * receipt) and what remains is the set of lines the void ORPHANS. That is the
 * only question the order's status actually turns on, and unlike
 * "is every receivable line claimed" it reads no mutable admin state.
 */
export function claimedPoItemIds(db: Db, grnId: string): Set<string> {
  const rows = db.prepare(`
    SELECT DISTINCT gi.po_item_id AS po_item_id
    FROM goods_receipt_note_items gi
    WHERE gi.grn_id = ? AND ${HAS_PO_ITEM}
  `).all(grnId) as any[];
  return new Set(rows.map(r => String(r.po_item_id)));
}

/* ───────────────────────────────────────────────────────────────────────────
 * SITE 2 (and the receive screen's GRN badge) — what actually arrived per line
 * ─────────────────────────────────────────────────────────────────────────── */

export interface PoReceiptLine {
  po_item_id: string;
  quantity_received: number;
  quantity_accepted: number;
  quantity_rejected: number;
  received_unit_price: number;
  rejection_reason: string | null;
  received_discount: number;
  received_delivery: number;
  grn_number: string;
  received_on: string;
  received_from: string;
  received_bill_no: string | null;
}

/**
 * CLAIM. One row per PO line that a LIVE GRN booked, oldest receipt first.
 *
 * ORDER BY g.date, g.created_at, g.grn_number is load-bearing for the callers
 * that fold these into a last-wins map: on a line touched by two receipts the
 * SURVIVING one must win, and after a void the surviving one is whichever
 * remains. Voided rows are simply not here to overwrite it.
 */
export function poReceiptLines(db: Db, poId: string): PoReceiptLine[] {
  return db.prepare(`
    SELECT gi.po_item_id, gi.quantity_received, gi.quantity_accepted, gi.quantity_rejected,
           gi.unit_price AS received_unit_price, gi.rejection_reason,
           gi.discount AS received_discount, gi.delivery_charges AS received_delivery,
           g.grn_number, g.date AS received_on, g.vendor AS received_from,
           g.invoice_number AS received_bill_no
    FROM goods_receipt_note_items gi
    ${claimJoin()}
    WHERE g.po_id = ? AND ${HAS_PO_ITEM}
    ORDER BY g.date, g.created_at, g.grn_number
  `).all(poId) as PoReceiptLine[];
}

/* ───────────────────────────────────────────────────────────────────────────
 * SITE 3 — the order's receipt HISTORY, which is a different question
 * ─────────────────────────────────────────────────────────────────────────── */

export interface PoReceipt {
  grn_id: string;
  grn_number: string;
  date: string;
  vendor: string;
  vendor_id: string | null;
  bill_no: string;
  bill_date: string;
  received_by: string;
  status: string;
  /** true iff this receipt was voided. It is still IN the list on purpose. */
  is_void: boolean;
  line_count: number;
  gross: number;
  discount: number;
  delivery: number;
}

/**
 * HISTORY, not claim. EVERY vendor bill ever taken in on this PO, voided ones
 * INCLUDED and flagged.
 *
 * WHY THIS ONE DOES NOT DROP THE VOIDED ROW. /grn already shows a voided bill
 * struck through rather than deleted (grn/page.tsx:568-594) — the receipt
 * happened, and the order's printed history that omitted it would no longer
 * reconcile with the GRN register. So the row stays and the MONEY leaves; see
 * receivedNet below. Consumers must render is_void rows as struck through and
 * must not add them to any total.
 */
export function poReceipts(db: Db, poId: string): PoReceipt[] {
  const rows = db.prepare(`
    SELECT g.id AS grn_id, g.grn_number, g.date AS date, g.vendor, g.vendor_id,
           g.invoice_number AS bill_no, g.invoice_date AS bill_date,
           g.received_by, g.status,
           COUNT(gi.id) AS line_count,
           COALESCE(SUM(ROUND(gi.quantity_accepted * gi.unit_price, 2)), 0) AS gross,
           COALESCE(SUM(gi.discount), 0)         AS discount,
           COALESCE(SUM(gi.delivery_charges), 0) AS delivery
    FROM goods_receipt_notes g
    LEFT JOIN goods_receipt_note_items gi ON gi.grn_id = g.id
    WHERE g.po_id = ?
    GROUP BY g.id
    ORDER BY g.date, g.created_at, g.grn_number
  `).all(poId) as any[];
  for (const r of rows) r.is_void = String(r.status || '') === VOID;
  return rows as PoReceipt[];
}

/**
 * The order's received total: Σ net over the receipts that still stand.
 *
 * VOID ONLY — deliberately NOT liveValueSql(). A held ('awaiting_qc') receipt
 * has always been counted here, at gross 0 less its stored discount, and this
 * change is not the place to move that: it would restate the printed total of
 * every PO with a delivery waiting on the kitchen. Excluding the VOIDED rows is
 * the one semantic change, and it is forced — a voided bill's money is
 * reversed out of stock and out of purchase_orders.total_cost, so leaving it in
 * this sum would print an order at more than it cost.
 *
 * `is_void` IS REQUIRED, NOT OPTIONAL, and that is the whole safety of this
 * function. Optional, a caller could hand it rows that simply do not carry the
 * flag — every one of them reads as live and the voided money is silently summed
 * back into the order's printed total, which is the one thing this exists to
 * prevent. Required, that same caller is a compile error. poReceipts() always
 * sets it (see the loop at the end of that function), so the only cost is that
 * the call site may not launder its rows through `any`.
 */
export function receivedNet(receipts: Array<{ net?: unknown; is_void: boolean }>): number {
  const sum = receipts.reduce((s, r) => (r.is_void ? s : s + (Number(r.net) || 0)), 0);
  return Math.round(sum * 100) / 100;
}

/* ───────────────────────────────────────────────────────────────────────────
 * SITE 4 — how many lines of this PO have walked in the door
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * CLAIM, as a scalar subquery. Emitted rather than read because it lives inside
 * the PO list SELECT, correlated to each row.
 *
 * LINES, NEVER QUANTITIES: purchase_order_items.quantity values are purchase
 * units of DIFFERENT materials, so adding 2 kg to 3 BTL yields a number that
 * means nothing (the same reasoning as api/grn/route.ts:99-106).
 *
 * Bounded per row: g.po_id rides idx_grn_po and gi.grn_id rides idx_grni_grn, so
 * each row touches only its OWN receipts. The added status test costs nothing —
 * it filters after the same index seek (there is no index on
 * goods_receipt_note_items.po_item_id either way).
 */
export const receivedLineCountSql = (poIdExpr = 'po.id'): string => `
  (SELECT COUNT(DISTINCT gi.po_item_id)
     FROM goods_receipt_note_items gi
     ${claimJoin()}
    WHERE g.po_id = ${poIdExpr} AND ${HAS_PO_ITEM})`;

/* ───────────────────────────────────────────────────────────────────────────
 * SITE 5 — whose lines are in, and whose are still owed
 * ─────────────────────────────────────────────────────────────────────────── */

export interface PoLineDelivery {
  po_id: string;
  vendor_name: string;
  /** 1 iff this ordered line has a LIVE receipt against it. */
  received: number;
}

/**
 * CLAIM, one grouped pass over a whole filtered PO set — never one query per row.
 *
 * `whereSql` is the caller's PO list filter (outlet / status / vendor / date),
 * applied to `po`. It MUST NOT be where the status guard goes: this is a LEFT
 * JOIN chain, and a WHERE-side `g.status <> 'void'` turns it into an INNER JOIN,
 * emptying outstanding_vendors for every PO that has no receipt at all. The
 * guard rides in the ON clause via claimJoin({ left: true, poIdCol }), next to
 * the g.po_id guard that is there for the same reason — a GRN row carrying this
 * po_item_id under a DIFFERENT PO must not mark the line delivered.
 *
 * The vendor a line is filed under is byte-for-byte receive/route.ts's rule: the
 * line's own vendor, else the PO header's. Anything else names a vendor the
 * goods will not be booked against.
 */
export function poLineDelivery(db: Db, whereSql: string, params: unknown[]): PoLineDelivery[] {
  return db.prepare(`
    SELECT poi.po_id AS po_id,
           COALESCE(NULLIF(TRIM(poi.vendor), ''), NULLIF(TRIM(po.vendor), ''), '') AS vendor_name,
           MAX(CASE WHEN g.id IS NULL THEN 0 ELSE 1 END) AS received
    FROM purchase_order_items poi
    JOIN purchase_orders po ON po.id = poi.po_id
    LEFT JOIN goods_receipt_note_items gi ON gi.po_item_id = poi.id
    ${claimJoin({ left: true, poIdCol: 'poi.po_id' })}
    WHERE ${whereSql}
    GROUP BY poi.id
  `).all(...(params as any[])) as PoLineDelivery[];
}

/* ───────────────────────────────────────────────────────────────────────────
 * SITE 6 — has ANYTHING been received against this PO
 * ─────────────────────────────────────────────────────────────────────────── */

export interface PoReceiptWitnesses {
  grns: Array<{ grn_number: string; vendor: string; invoice_number: string; lines: number }>;
  bills: Array<{ vendor_name: string; bill_no: string; bill_date: string }>;
  any: boolean;
}

/**
 * CLAIM, over BOTH witnesses the receive transaction writes. Feeds the hard 409
 * that freezes a PO's lines once goods are in (edit-approved rewrites every
 * purchase_order_items row, which would orphan a live GRN's po_item_id and let
 * one delivery be received and paid twice).
 *
 * `any` is an OR over two witnesses, so the freeze lifts only when NEITHER
 * stands — which means both witnesses have to be void-aware or the freeze
 * survives the void for ever on the surviving one.
 *
 * WITNESS 2 IS TIED TO ITS GRN BY PROSE, NOT BY A COLUMN. po_vendor_bills has no
 * grn_id and no status; receive writes `notes = 'GRN <number>'` optionally
 * followed by ' — <charges note>'. Both exact forms are matched here — never
 * `LIKE 'GRN <number>%'`, which catches GRN-2026-00011 when looking for
 * GRN-2026-0001 once the sequence passes four digits — the same rule
 * poVendorBillsFor() uses at api/grn/[id]/route.ts:131-143.
 *
 * It fails SAFE: a bill row is dropped only when a VOIDED GRN of this same PO
 * matches its notes exactly. Anything unmatched keeps the freeze, which is the
 * reversible answer.
 *
 * AND IT IS NOW BELT-AND-BRACES, DELIBERATELY KEPT. po_vendor_bills has since
 * gained a real grn_id (db.ts) and the void DELETES this receipt's bill row
 * outright (src/lib/po-void.ts), so after a void there is normally nothing left
 * here to skip. The prose test stays for the one case that is not normal: a row
 * the backfill left NULL and a void that was refused on it, where the freeze
 * SHOULD stand. Rewriting it to key on grn_id would drop exactly that
 * protection, so it is not rewritten.
 */
export function liveReceiptsOnPo(db: Db, poId: string): PoReceiptWitnesses {
  const grns = db.prepare(`
    SELECT g.grn_number, g.vendor, g.invoice_number,
           (SELECT COUNT(*) FROM goods_receipt_note_items gi WHERE gi.grn_id = g.id) AS lines
    FROM goods_receipt_notes g
    WHERE g.po_id = ? AND ${liveClaimSql('g')}
    ORDER BY g.date, g.created_at
  `).all(poId) as PoReceiptWitnesses['grns'];
  // Wrapped because db.ts creates po_vendor_bills inside a try/catch — if that
  // DDL ever failed the table would be absent, and a throw here would 500 every
  // edit. It cannot fail OPEN by being skipped: the same missing table would
  // make the receive txn throw at its INSERT and roll back, so no GRN would
  // exist either and the witness above still holds.
  let bills: PoReceiptWitnesses['bills'] = [];
  try {
    bills = db.prepare(`
      SELECT b.vendor_name, b.bill_no, b.bill_date
      FROM po_vendor_bills b
      WHERE b.po_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM goods_receipt_notes g
           WHERE g.po_id = b.po_id
             AND COALESCE(g.status, '') = '${VOID}'
             AND (b.notes = 'GRN ' || g.grn_number
                  OR b.notes LIKE 'GRN ' || g.grn_number || ' — %')
        )
      ORDER BY b.created_at, b.id
    `).all(poId) as PoReceiptWitnesses['bills'];
  } catch { /* table absent — the GRN witness above is authoritative */ }
  return { grns, bills, any: grns.length > 0 || bills.length > 0 };
}
