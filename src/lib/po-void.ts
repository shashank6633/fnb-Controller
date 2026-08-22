import type Database from 'better-sqlite3';
import { GrnRefused, r2 } from './grn-reversal';
import { receivedPoItemIds, claimedPoItemIds, liveClaimSql, liveValueSql } from './po-receipts';
import {
  planRequisitionUndoFromPo, reverseRequisitionFulfilFromPo,
  type RequisitionUndoPlan, type RequisitionUndoOutcome,
} from './po-requisition-fulfil';

/* ══════════════════════════════════════════════════════════════════════════
 * VOIDING A PO-SOURCED RECEIPT — THE THREE RAILS THE STOCK REVERSAL DOES NOT
 * TOUCH.
 *
 * DELETE /api/grn/[id] has always known how to un-do the MOVEMENT a receipt
 * made: reverseGrnMovement (src/lib/grn-reversal.ts) deletes the `purchases`
 * rows and their inventory_transactions, debits current_stock by the RECORDED
 * quantity and re-derives last_purchase_price only where the bill owns it. That
 * half is unchanged here and is NOT re-implemented — this file is called
 * beside it, never instead of it.
 *
 * A PO receipt writes THREE more things that a stock reversal cannot see, and
 * every one of them would otherwise survive the void and make the order
 * permanently wrong:
 *
 *   1. THE VENDOR BILL ROW (po_vendor_bills). Its
 *      UNIQUE(po_id, vendor_name, bill_no) is the duplicate-bill guard. Leave
 *      the row standing and the reopened PO can never take in the very bill it
 *      is waiting for — and since the store re-receiving the SAME physical
 *      delivery types the SAME bill number, that is the normal case, not an
 *      edge one. (15 of 20 live rows carry a BLANK bill_no, which collides on
 *      (po_id, vendor, '') for that vendor's next delivery too.) So the void
 *      RELEASES the row — and refuses outright rather than release one it
 *      cannot prove is this receipt's, because releasing the wrong row would
 *      let a DIFFERENT vendor bill be received a second time.
 *
 *   2. THE ORDER'S OWN STATE (purchase_orders). The completing receipt is the
 *      sole writer of approved → received, and it stamps received_at, total_cost
 *      and grn_id with it (receive/route.ts:1581-1608). Reversing the goods
 *      while leaving the order closed leaves a PO that says "delivered" with
 *      nothing delivered and no way back in — "Only approved POs can be
 *      received".
 *
 *   3. THE REQUISITION CASCADE. A PO raised from a department requisition marks
 *      it fulfilled on completion, and a purpose='party' requisition DEDUCTS
 *      STOCK A SECOND TIME on a different rail when it does. Undoing the
 *      receipt without undoing that leaves goods consumed against a delivery
 *      that never happened. It is handled by the inverse that lives beside the
 *      forward (po-requisition-fulfil.ts), never re-derived here.
 *
 * ── WHAT total_cost MEANS, AND WHY THE TWO BRANCHES DIFFER ────────────────
 * On an 'approved' PO the column means WHAT WAS ORDERED (recalcTotal is its
 * only writer there); on a 'received' PO it means WHAT WAS BOOKED. So a void
 * that REOPENS the order must put the ORDERED total back — never a figure
 * derived from total_cost itself, which is a different quantity entirely
 * (measured 2026-08-22: 19 of 20 received POs have total_cost ≠ their ordered
 * total; PO-2026-0002 reads 800 against 5,800 ordered). It is re-derived from
 * purchase_order_items, which receive never touches and edit-approved is
 * refused from touching once any receipt exists — the ordered rows are frozen,
 * so the derivation is exact.
 * A void that leaves the order CLOSED (a surviving receipt still claims every
 * line this one did) instead RE-STAMPS the booked figure from the surviving
 * bills — the same re-derivation grn-qc.ts:1814-1821 performs after a QC
 * rejection — and SKIPS even that while any delivery on the order is still on a
 * quality hold, which is the rule grn-reversal.ts:1723-1729 already applies for
 * the reason stated there: a held line's accepted quantity is 0, so re-deriving
 * would delete those goods from the order's value.
 *
 * ── AND WHY A LATER RECEIPT IS REFUSED ────────────────────────────────────
 * See laterReceiptRefusal below. Short version: a PO cannot be received once it
 * is closed, so a receipt with a LIVE receipt keyed after it is by definition
 * not the one that closed the order — and unwinding it would have to un-stamp a
 * completion that a different vendor's bill earned. Voiding the LATEST receipt
 * is always available, which is the mistake an admin actually needs to undo.
 * ══════════════════════════════════════════════════════════════════════════ */

type PoRow = {
  id: string; po_number: string; status: string;
  received_at: string | null; total_cost: number | null;
  grn_id: string | null; requisition_id: string | null; outlet_id: string | null;
};

export interface PoVoidPlan {
  po: PoRow;
  /** The po_vendor_bills row this receipt wrote. null when the PO carries none. */
  bill: any | null;
  /** How that row was identified — the column, or the historical sentence. */
  bill_matched_by: 'grn_id' | 'notes' | 'none';
  /** Does a SURVIVING receipt still claim every PO line this one claimed? */
  still_complete: boolean;
  /** The po_item_ids this void leaves with no live claim at all. Non-empty ⇒
   *  the order is no longer complete and must reopen. */
  orphaned_po_item_ids: string[];
  /** Will this void take the order from 'received' back to 'approved'? */
  will_reopen: boolean;
  /** Deliveries on this order still sitting on a quality hold. While any does,
   *  the stays-closed branch writes NO total_cost — a held line's accepted
   *  quantity is 0 and re-deriving would delete those goods from the order. */
  held_siblings: number;
  /** The receipt that inherits purchase_orders.grn_id (deliberately NOT
   *  authoritative — the most recent SURVIVING one), or null. */
  surviving_grn_id: string | null;
  surviving_grn_number: string | null;
  /** SUM(purchase_order_items.total_price) — the ORDERED total. */
  ordered_total: number;
  /** Σ net over the receipts that still stand, for the stays-closed branch. */
  surviving_net: number;
  /** Empty and inert unless the order actually reopens. */
  requisition: RequisitionUndoPlan;
}

export interface PoVoidOutcome {
  po_id: string;
  po_number: string;
  po_status: string;
  po_reopened: boolean;
  po_total_cost: number;
  /** false when the stays-closed branch deliberately left total_cost alone
   *  because a delivery on this order is still on a quality hold. */
  po_total_restamped: boolean;
  /** null when the order kept its completion. */
  received_at_cleared: boolean;
  bill_released: { id: string; vendor_name: string; bill_no: string; bill_date: string } | null;
  bill_matched_by: 'grn_id' | 'notes' | 'none';
  requisition: RequisitionUndoOutcome | null;
  /** The verbatim po_vendor_bills row and PO fields, for the caller's audit
   *  snapshot — the released bill row has no other copy once it is deleted. */
  before: Record<string, unknown>;
}

/**
 * A PO cannot be received while it is closed ("Only approved POs can be
 * received"), so a receipt that has a LIVE receipt AFTER it is, by definition,
 * not the one that closed the order. Voiding it would still un-claim its lines
 * and force the order back open — which means erasing a received_at and a
 * total_cost that a DIFFERENT vendor's bill stamped, and leaving that vendor's
 * delivery sitting on a reopened order it did not reopen.
 *
 * That is solvable, but not by guessing: it needs a decision about which
 * receipt owns the order's completion date, and there is nothing in the schema
 * that records one. Refusing is reversible. And it costs the admin nothing they
 * need — voiding the LATEST receipt is always allowed, so a mis-keyed delivery
 * can be undone as long as it is undone before the next one is taken in, and
 * two receipts can be undone newest-first.
 *
 * ── "LATER" MEANS KEYED LATER, NOT DATED LATER. THIS IS THE WHOLE GUARD. ───
 * It used to compare (date, created_at, grn_number) — the ordering poReceipts
 * uses for DISPLAY. goods_receipt_notes.date is the storekeeper-TYPED receipt
 * date and backdating is ordinary (checkPurchaseDate allows a window and exempts
 * admins), so Monday's delivery keyed in on Wednesday sorted BEFORE a Tuesday
 * delivery keyed in on Tuesday. The guard then let the wrong receipt through:
 * measured 2026-08-22, voiding the receipt that did NOT close the order returned
 * 200, cleared a received_at the other bill stamped, and — on a party PO —
 * credited party stock back on a cascade that receipt never fired.
 *
 * created_at is the row's own insert stamp (NOT NULL DEFAULT datetime('now');
 * 0 nulls in 29 rows), it cannot be typed, and the receipt that stamped
 * received_at is by construction the one with the greatest one. grn_number
 * breaks a same-second tie and is monotonic within a year. So the causal order
 * is (created_at, grn_number), and `date` is deliberately NOT in the key.
 */
function laterReceiptRefusal(grnNumber: string, poNumber: string, later: any[]): GrnRefused {
  const names = later.map(r => r.grn_number).join(', ');
  return new GrnRefused(409,
    `${grnNumber} cannot be voided because ${later.length} receipt(s) on ${poNumber} were entered after it and still stand (${names}). Voiding an earlier bill would reopen the order and clear a completion date and a received total that those later bills stamped. Void the later receipt(s) first, newest first — or raise a vendor return for these goods instead.`,
    { grn_number: grnNumber, po_number: poNumber, later_grns: later.map(r => String(r.grn_number)) },
    'po_later_receipt');
}

/**
 * PROVE THE VOID CAN BE DONE HONESTLY. NO WRITES — every branch either returns
 * a plan or throws GrnRefused, and the caller's transaction turns that into
 * "nothing happened", including the status claim it already took.
 *
 * CALL IT AFTER THE CLAIM has flipped this GRN to 'void': every ledger read
 * below goes through src/lib/po-receipts.ts, which excludes voided receipts by
 * construction, so the state it measures is the state the void is about to
 * leave behind rather than the one it found.
 */
export function planPoReceiptVoid(db: Database.Database, grn: any): PoVoidPlan {
  const poId = String(grn.po_id);
  const po = db.prepare(`
    SELECT id, po_number, status, received_at, total_cost, grn_id, requisition_id, outlet_id
    FROM purchase_orders WHERE id = ?
  `).get(poId) as PoRow | undefined;
  if (!po) {
    throw new GrnRefused(409,
      `${grn.grn_number} was received against purchase order ${poId}, which no longer exists. The order cannot be reopened, so voiding the receipt would leave its goods reversed with nothing recording what they were ordered against. Correct the stock with an adjustment instead.`,
      { grn_number: grn.grn_number, po_id: poId }, 'po_missing');
  }

  // Only two states can carry a receipt: 'approved' (part-delivered, still
  // receivable) and 'received'. cancel/route.ts refuses anything past draft /
  // pending / rejected, and edit-approved refuses once a receipt exists — so
  // anything else here means something this route does not understand has moved
  // the order, and writing a status on top of it would destroy that.
  if (po.status !== 'received' && po.status !== 'approved') {
    throw new GrnRefused(409,
      `${po.po_number} is "${po.status}", not an order this receipt can be unwound from — a purchase order carrying a receipt is only ever "approved" or "received". Something else has moved it. Void is refused; nothing was changed.`,
      { grn_number: grn.grn_number, po_number: po.po_number, po_status: po.status }, 'po_status_unexpected');
  }

  // ── LATER RECEIPTS ────────────────────────────────────────────────────────
  // CAUSAL order — (created_at, grn_number), never the typed `date`. See
  // laterReceiptRefusal above for why that distinction is the guard rather than
  // a detail. This GRN is already 'void' at this point, so liveClaimSql excludes
  // it and the `id <> ?` is belt-and-braces rather than the filter.
  const later = db.prepare(`
    SELECT grn_number, date, created_at FROM goods_receipt_notes
    WHERE po_id = ? AND id <> ? AND ${liveClaimSql('goods_receipt_notes')}
      AND (created_at, grn_number) > (?, ?)
    ORDER BY created_at, grn_number
  `).all(poId, String(grn.id), String(grn.created_at ?? ''), String(grn.grn_number ?? '')) as any[];
  if (later.length > 0) throw laterReceiptRefusal(String(grn.grn_number), po.po_number, later);

  // ── THE VENDOR BILL ROW ───────────────────────────────────────────────────
  const { bill, matchedBy } = identifyVendorBill(db, poId, String(grn.id), String(grn.grn_number), po.po_number);

  // ── DOES THIS VOID ACTUALLY UN-CLAIM A PO LINE? ───────────────────────────
  //
  // THE QUESTION IS NOT "is every RECEIVABLE line still claimed". That was the
  // rule here until 2026-08-23 and it could strand an order permanently. It
  // re-derived "receivable" through centralFlowBlock, which resolves a
  // material's category against the LIVE store_category_map — mutable admin
  // state, read long after the delivery. Map a category to the Liquor Store
  // after the goods landed and that set SHRINKS; shrink it to empty and
  // `[].every()` is `true`, so a PO with exactly ONE receipt concluded "another
  // receipt still covers every line". Measured on a snapshot 2026-08-22: the
  // void returned 200 with po_reopened:false, reversed the stock, DELETED the
  // vendor bill row, left the order 'received' (terminal — "Only approved POs
  // can be received"), stamped total_cost ₹0, told the admin another receipt
  // covered the order, and on a party PO skipped the cascade reversal in
  // silence, leaving 10 units consumed against a delivery that no longer
  // existed. One boolean, five wrongs, and a NET DOUBLE REMOVAL of stock.
  //
  // THE HONEST QUESTION IS NARROWER AND READS NO ADMIN STATE: which PO lines
  // did THIS receipt claim, and does a LIVE receipt still claim each of them?
  //   · any line left with no live claim ⇒ the order is no longer complete and
  //     MUST reopen, whatever any category map now says about it;
  //   · none ⇒ either a surviving sibling also claims those lines, or this
  //     receipt claimed no PO line at all, and the order's completion is
  //     genuinely untouched by this void.
  // `ledger` is read AFTER the caller's claim flipped this GRN to 'void', so it
  // is already the post-void set; the subtraction needs no special case.
  //
  // AND IT REQUIRES A SURVIVOR. "Another receipt still covers every line" is
  // false when there is no other receipt at all, whatever the arithmetic says —
  // so the closed branch is gated on one existing.
  //
  // THIS ALSO RETIRES THE STORE-MAPPED EXCLUSION, and nothing needs it here:
  // PO-2026-0002 and PO-2026-0014 are 'received' with 1 of 2 lines claimed, and
  // under this rule voiding their receipt orphans the claimed line and reopens
  // the order — which is exactly right, and is what the exclusion was protecting
  // against reaching the wrong way round.
  const surviving = db.prepare(`
    SELECT id, grn_number FROM goods_receipt_notes
    WHERE po_id = ? AND ${liveClaimSql('goods_receipt_notes')}
    ORDER BY created_at DESC, grn_number DESC
    LIMIT 1
  `).get(poId) as any;

  const ledger = receivedPoItemIds(db, poId);
  const orphaned_po_item_ids = [...claimedPoItemIds(db, String(grn.id))]
    .filter(pid => !ledger.has(pid));
  const still_complete = !!surviving && orphaned_po_item_ids.length === 0;
  const will_reopen = po.status === 'received' && !still_complete;

  // Held deliveries on this SAME order. Counted before the money below is
  // derived, because their existence is what decides whether any money is
  // written at all on the stays-closed branch.
  const held_siblings = Number((db.prepare(
    `SELECT COUNT(*) AS n FROM goods_receipt_notes
      WHERE po_id = ? AND id <> ? AND status = 'awaiting_qc'`
  ).get(poId, String(grn.id)) as any)?.n) || 0;

  const ordered_total = Number((db.prepare(
    `SELECT COALESCE(SUM(total_price), 0) AS t FROM purchase_order_items WHERE po_id = ?`
  ).get(poId) as any)?.t) || 0;

  // VALUE, not claim — a held sibling's accepted qty is pinned to 0 while its
  // discount is stored in full, so it must not enter a money sum.
  //
  // NOT byte-identical to grn-qc.ts:1814-1821 / grn-reversal.ts:1731-1736, and
  // saying it was would have invited the next editor to "align" the wrong one:
  // those two spell the filter `g.status <> 'void'` and do NOT exclude
  // 'awaiting_qc'. The difference can only bite when a held delivery exists on
  // this order — and in that case this figure is not written at all (see
  // held_siblings and the stays-closed branch in applyPoReceiptVoid), which is
  // the same conclusion grn-reversal reaches by skipping its restamp outright.
  // With no held sibling the two predicates select identical rows.
  const surviving_net = Number((db.prepare(`
    SELECT COALESCE(SUM(ROUND(gi.quantity_accepted * gi.unit_price, 2) - gi.discount), 0) AS net
      FROM goods_receipt_note_items gi
      JOIN goods_receipt_notes g ON g.id = gi.grn_id
     WHERE g.po_id = ? AND ${liveValueSql('g')}
  `).get(poId) as any)?.net) || 0;

  // ── THE REQUISITION CASCADE ───────────────────────────────────────────────
  // Planned ONLY when the order actually reopens, and that is now SOUND rather
  // than merely convenient. still_complete means a surviving receipt claims
  // every line this one claimed, so the cascade's own precondition — the PO is
  // complete — is untouched and its fulfilment is still true; reversing it there
  // would un-fulfil a requisition the order genuinely completed. Under the old
  // "every receivable line" rule that reasoning did not hold: still_complete
  // could be true with ZERO surviving receipts, and the cascade was then neither
  // reversed NOR refused — the silent half-apply that left party goods consumed
  // against a delivery that no longer existed.
  // When it is not planned it must not refuse either: a requisition this void
  // will not touch is not this void's business.
  const requisition = (will_reopen && po.requisition_id)
    ? planRequisitionUndoFromPo(db, String(po.requisition_id), po.po_number)
    : planRequisitionUndoFromPo(db, '', po.po_number);

  return {
    po, bill, bill_matched_by: matchedBy,
    still_complete, orphaned_po_item_ids, will_reopen, held_siblings,
    surviving_grn_id: surviving?.id ? String(surviving.id) : null,
    surviving_grn_number: surviving?.grn_number ? String(surviving.grn_number) : null,
    ordered_total: r2(ordered_total),
    surviving_net: r2(surviving_net),
    requisition,
  };
}

/**
 * WHICH po_vendor_bills ROW IS THIS RECEIPT'S — grn_id first, the historical
 * sentence second, and a REFUSAL rather than a guess.
 *
 * The column is new (db.ts, guarded + backfilled where the sentence identifies
 * exactly one receipt). Rows written before it, and rows whose sentence was
 * ambiguous enough that the backfill deliberately left them NULL, still have to
 * be reachable — so the prose match survives as the fallback, exactly the way
 * purchases.grn_id/notes is handled.
 *
 * THE PROSE RULE IS THE ONE poVendorBillsFor() ALREADY USES: the two exact
 * forms receive writes — `GRN <n>` and `GRN <n> — <charges note>` — never
 * `LIKE 'GRN <n>%'`, which catches GRN-2026-00011 when looking for
 * GRN-2026-0001 once the sequence passes four digits.
 *
 * Three outcomes, and only one of them writes:
 *   · exactly one row  → release it;
 *   · the PO has NO bill rows at all → nothing to release (a receipt older than
 *     the table). The reopened order is unblocked either way, so this proceeds;
 *   · anything else — two matches, or bill rows exist on the order but none is
 *     identifiable as this receipt's — → REFUSED. Releasing the wrong row would
 *     let a different vendor bill be received twice, and releasing none while
 *     one survives would leave the reopened order unable to take its own bill.
 */
function identifyVendorBill(
  db: Database.Database, poId: string, grnId: string, grnNumber: string, poNumber: string,
): { bill: any | null; matchedBy: 'grn_id' | 'notes' | 'none' } {
  let all: any[];
  try {
    all = db.prepare(`SELECT * FROM po_vendor_bills WHERE po_id = ?`).all(poId) as any[];
  } catch (e: any) {
    // The table is created inside a try/catch in db.ts whose error is swallowed.
    // "Cannot read the duplicate-bill guard" is not "there is no guard".
    throw new GrnRefused(409,
      `The vendor bill register could not be read (${e?.message || 'unreadable'}), so it cannot be proved that voiding ${grnNumber} would release the right bill. Nothing was changed.`,
      { grn_number: grnNumber, po_number: poNumber }, 'po_bill_unreadable');
  }
  if (all.length === 0) return { bill: null, matchedBy: 'none' };

  const byId = all.filter(b => b.grn_id != null && String(b.grn_id) === grnId);
  if (byId.length === 1) return { bill: byId[0], matchedBy: 'grn_id' };
  if (byId.length > 1) {
    throw new GrnRefused(409,
      `${byId.length} vendor bill rows on ${poNumber} are linked to ${grnNumber}, so the one this receipt recorded cannot be identified. Releasing the wrong one would let a different bill be received twice. Void is refused; nothing was changed.`,
      { grn_number: grnNumber, po_number: poNumber, matches: byId.length }, 'po_bill_ambiguous');
  }

  const exact = `GRN ${grnNumber}`;
  const byNotes = all.filter(b => {
    const n = String(b.notes ?? '');
    return n === exact || n.startsWith(`${exact} — `);
  });
  if (byNotes.length === 1) return { bill: byNotes[0], matchedBy: 'notes' };
  if (byNotes.length > 1) {
    throw new GrnRefused(409,
      `${byNotes.length} vendor bill rows on ${poNumber} name ${grnNumber} in their note, so the one this receipt recorded cannot be identified. Releasing the wrong one would let a different bill be received twice. Void is refused; nothing was changed.`,
      { grn_number: grnNumber, po_number: poNumber, matches: byNotes.length }, 'po_bill_ambiguous');
  }

  throw new GrnRefused(409,
    `${poNumber} carries ${all.length} vendor bill row(s) but none of them can be identified as ${grnNumber}'s. Voiding without releasing this receipt's bill row would leave the reopened order unable to take that bill in again, and releasing a row that cannot be proved to be this one would let a different bill be received twice. Void is refused; nothing was changed.`,
    { grn_number: grnNumber, po_number: poNumber, bill_rows: all.length }, 'po_bill_unidentifiable');
}

/**
 * PERFORM THE THREE RAILS. Call INSIDE the caller's db.transaction(), with a
 * plan from planPoReceiptVoid and AFTER the caller's assertNoNegativeStock has
 * passed on the NET of the receipt debit and the party credit.
 *
 * Order is deterministic but not arithmetically load-bearing: every stock write
 * on both rails is relative (`current_stock ± x`), and the guard was run against
 * the pre-write balances with the party credit already supplied as the
 * `replacement` term, so the net it tested is the net that lands.
 */
export function applyPoReceiptVoid(
  db: Database.Database,
  plan: PoVoidPlan,
  { actorEmail, grnNumber }: { actorEmail: string; grnNumber: string },
): PoVoidOutcome {
  const po = plan.po;
  const out: PoVoidOutcome = {
    po_id: po.id, po_number: po.po_number,
    po_status: po.status, po_reopened: false,
    po_total_cost: Number(po.total_cost) || 0,
    po_total_restamped: false,
    received_at_cleared: false,
    bill_released: null,
    bill_matched_by: plan.bill_matched_by,
    requisition: null,
    before: {
      purchase_order: {
        id: po.id, po_number: po.po_number, status: po.status,
        received_at: po.received_at, total_cost: po.total_cost,
        grn_id: po.grn_id, requisition_id: po.requisition_id,
      },
      po_vendor_bill: plan.bill ?? null,
    },
  };

  // ── 1. RELEASE THE BILL NUMBER ────────────────────────────────────────────
  // DELETED, not tombstoned. The row is the duplicate-bill guard and nothing
  // else: after a true void nothing was received from this vendor on this
  // order, so both of its other readers — the edit-approved freeze witness and
  // purchase-log's bill-number fallback — are RIGHT to stop seeing it. The
  // alternative (a voided_at column plus a partial unique index) would mean
  // dropping and recreating a shipped UNIQUE index on boot and teaching three
  // readers a new column, to preserve a receipt event the voided GRN itself
  // already records. The row is snapshotted into `before` above, which the
  // caller writes through logAuditOrThrow — the only copy.
  if (plan.bill) {
    db.prepare(`DELETE FROM po_vendor_bills WHERE id = ?`).run(String(plan.bill.id));
    out.bill_released = {
      id: String(plan.bill.id),
      vendor_name: String(plan.bill.vendor_name ?? ''),
      bill_no: String(plan.bill.bill_no ?? ''),
      bill_date: String(plan.bill.bill_date ?? ''),
    };
  }

  // ── 2. THE ORDER ──────────────────────────────────────────────────────────
  if (po.status === 'received' && !plan.still_complete) {
    // REOPEN. total_cost goes back to the ORDERED total, because that is what
    // the column means on an 'approved' order and every reader assumes it —
    // the list prints the figure beside a plain APPROVED badge, and a buyer
    // reconciling open commitments reads it as the commitment.
    db.prepare(`
      UPDATE purchase_orders
      SET status = 'approved', received_at = NULL, total_cost = ?, grn_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(plan.ordered_total, plan.surviving_grn_id, po.id);
    out.po_status = 'approved';
    out.po_reopened = true;
    out.received_at_cleared = true;
    out.po_total_cost = plan.ordered_total;
    out.po_total_restamped = true;
  } else if (po.status === 'received' && plan.held_siblings === 0) {
    // STAYS CLOSED — a surviving receipt still claims every line this one did.
    // Only the money moves, re-derived from the bills that survive; that is what
    // grn-qc.ts does after a QC rejection, and it self-heals.
    db.prepare(`
      UPDATE purchase_orders
      SET total_cost = ?, grn_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(plan.surviving_net, plan.surviving_grn_id, po.id);
    out.po_total_cost = plan.surviving_net;
    out.po_total_restamped = true;
  } else if (po.status === 'received') {
    // STAYS CLOSED, AND THE MONEY IS LEFT ALONE. A delivery on this order is
    // still waiting for a quality check, and a held line's quantity_accepted is
    // pinned to 0 — the ABSENCE of a decision, not a decision to accept nothing.
    // Re-deriving the received total now would delete those goods from the
    // order's value and leave the wrong figure standing for the whole life of
    // the hold, with nothing on screen explaining it. grn-reversal.ts:1723-1729
    // reaches the same conclusion for the same reason and skips its restamp; the
    // sign-off re-derives correctly (grn-qc.ts:1814-1821), so this self-heals.
    // grn_id still moves: it must not point at a receipt that no longer stands.
    db.prepare(`
      UPDATE purchase_orders SET grn_id = ?, updated_at = datetime('now') WHERE id = ?
    `).run(plan.surviving_grn_id, po.id);
  } else {
    // Already 'approved' — this receipt never closed the order, so there is no
    // completion to undo. total_cost is DELIBERATELY LEFT ALONE: on an approved
    // order it already means ORDERED and the receive route never moved it.
    db.prepare(`
      UPDATE purchase_orders SET grn_id = ?, updated_at = datetime('now') WHERE id = ?
    `).run(plan.surviving_grn_id, po.id);
  }

  // ── 3. THE REQUISITION CASCADE ────────────────────────────────────────────
  // Reported as null rather than as an all-zero object when nothing was on that
  // rail — an empty summary in the response reads as "a reversal happened and
  // moved nothing", which is a different claim.
  const undo = reverseRequisitionFulfilFromPo(db, {
    plan: plan.requisition, actorEmail, poNumber: po.po_number, grnNumber,
  });
  out.requisition = undo.unfulfilled ? undo : null;

  return out;
}
