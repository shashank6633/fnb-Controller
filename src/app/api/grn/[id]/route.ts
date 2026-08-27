import { getDb, updateMaterialPrice, logAuditEvent } from '@/lib/db';
import { getCurrentUser, requireRole, getCurrentOutletId, canProcessAsStore, isManagement } from '@/lib/auth';
import { getCentralStoreCutoverDate } from '@/lib/central-cutover';
import {
  GrnRefused, logAuditOrThrow,
  collectRecordedMoves, assertNoNegativeStock, reverseGrnMovement,
  amendGrnLines, raisePoDeviationAlert, type AmendLineInput,
} from '@/lib/grn-reversal';
import { planPoReceiptVoid, applyPoReceiptVoid, type PoVoidPlan, type PoVoidOutcome } from '@/lib/po-void';
// The same "is there a bill number here?" the receive route and the receive
// modal use — see the header of @/lib/bill-no. An amendment that may not REMOVE
// the number must not be satisfiable by an invisible one either.
import { normalizeBillNo } from '@/lib/bill-no';

/**
 * AMEND and VOID one inward entry (GRN).
 *
 *   PUT    /api/grn/[id]  → amend the BILL-LEVEL fields, and RECORD that it was
 *                           amended (who, when, and the field-level diff).
 *   PATCH  /api/grn/[id]  → ADMIN ONLY. Amend the LINE ITEMS — quantities, rate,
 *                           or remove a line — unwinding the old stock and cost
 *                           effect and applying the new one in one transaction.
 *   DELETE /api/grn/[id]  → ADMIN ONLY. Reverse the stock this GRN added, then
 *                           VOID the row. Never a hard delete.
 *
 * ── WHY "DELETE" IS A VOID ────────────────────────────────────────────────
 * A received GRN has already moved inventory: it bumped raw_materials.current_stock,
 * wrote a `purchases` cost row per accepted line and an inventory_transactions
 * row per cost row, and dragged raw_materials.average_price through
 * updateMaterialPrice into every sub-recipe and recipe that uses the material.
 * Dropping the header row would leave every one of those in place, silently
 * overstating on-hand for ever. So the document is KEPT — header and line items
 * both, status flipped to 'void' with voided_at / voided_by / void_reason — and
 * what is undone is the movement.
 *
 * It also could not be a hard delete even if we wanted one: material_returns.grn_id
 * and material_return_items.grn_item_id point at these rows, PRAGMA foreign_keys
 * is ON, and goods_receipt_note_items cascades from the header.
 *
 * ── A PO-SOURCED RECEIPT IS VOIDABLE NOW, AND WHAT THAT TOOK ──────────────
 * It used to be refused outright, for four reasons this file stated honestly.
 * All four are solved; the refusal is gone and the reasons are recorded here
 * because each one is still the thing that would break if its fix were undone:
 *
 *   1. "WHICH PO LINES ARE ALREADY RECEIVED" was derived from
 *      goods_receipt_note_items ALONE, with no status filter, in SIX places
 *      across three files (nine, in seven spellings, once counted properly). A
 *      voided GRN keeps its item rows — it must, they ARE the bill — so every
 *      one of them said a voided receipt still claimed its line, and that PO
 *      could never be received again. All of them now come through
 *      src/lib/po-receipts.ts, the ONE place that states the rule, which is
 *      void-aware BY CONSTRUCTION: it hands out the JOIN, not a condition, so a
 *      seventh copy cannot be written without the filter. It filters 'void'
 *      only — a receipt HELD for a kitchen quality check HAS claimed its line.
 *   2. po_vendor_bills NOW CARRIES grn_id (db.ts, guarded + backfilled from the
 *      sentence where it identifies exactly one receipt). Its
 *      UNIQUE(po_id, vendor_name, bill_no) is the duplicate-bill guard, so the
 *      void RELEASES that row — otherwise the reopened PO could never take in
 *      the very bill it is waiting for, and since the store re-receiving the
 *      same delivery types the SAME bill number, that is the normal case.
 *   3. purchase_orders IS REOPENED — status, received_at, total_cost back to the
 *      ORDERED total, grn_id to a surviving GRN. src/lib/po-void.ts.
 *   4. THE REQUISITION CASCADE IS REVERSED, including the purpose='party'
 *      branch that deducts stock a second time, by the inverse that lives beside
 *      the forward (src/lib/po-requisition-fulfil.ts) and only where two
 *      independent discriminators prove that rail wrote the rows. Its credit is
 *      fed into the SAME negative-stock guard as the receipt's debit, as the
 *      `replacement` term, so the guard tests the NET of the two rather than
 *      refusing a void whose two halves cancel out.
 *
 * WHAT IS STILL REFUSED, and every one of these is deliberate: a LATER live
 * receipt on the same PO (void newest first); a vendor bill row that cannot be
 * uniquely identified; a requisition whose party deduction cannot be attributed
 * to this cascade; and stock that has already been consumed. Refusing is
 * reversible; a stray stock credit is not.
 *
 * ── THE WEIGHTED AVERAGE: WHAT THIS DOES, AND WHAT IT CANNOT DO ───────────
 * The reversal DELETES the `purchases` rows this GRN wrote (snapshotted into the
 * audit row first) and then re-runs updateMaterialPrice per material. That is
 * the only option that keeps current_stock, average_price and the variance
 * report moving together — variance-report computes purchases_to_date from
 * SUM(purchases.quantity), not from inventory_transactions, so a soft-flagged
 * row would read as real there and in ~40 other files that SELECT FROM purchases.
 * A NEGATIVE purchases row is explicitly forbidden (src/lib/return-stock.ts):
 * FIFO's "latest purchase" would become the reversal itself and cascade a
 * nonsense rate into every recipe.
 *
 * updateMaterialPrice re-derives the average from the surviving rows in the
 * calendar month of the material's newest remaining purchase, so in the normal
 * case the pre-receipt figure comes back on its own. IT CANNOT when NO purchase
 * rows remain for that material: `if (sameMonth.total_qty > 0)` and the FIFO
 * `if (latest)` both leave average_price untouched, so the voided bill's price
 * stands. Nothing anywhere stores the pre-receipt average, so there is nothing
 * honest to restore it from — the response and the audit row therefore NAME
 * those materials in `average_price_stale` rather than pretend. Same for
 * last_purchase_price, which is a straight overwrite with no history: it is
 * re-derived from the newest surviving purchase, and named in
 * `last_purchase_stale` when there is none.
 *
 * ── WHAT IS NOT UNDONE, DELIBERATELY ──────────────────────────────────────
 * Anything that SPENT the average between receive and void was written at that
 * rate and is a historical snapshot: party-consumption unit_cost/line_cost in
 * audit_events, closing valuations, department-variance valuations, kitchen
 * production batch costs. A void does not rewrite history it did not author.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GrnRefused and logAuditOrThrow NOW LIVE IN @/lib/grn-reversal, together with
 * EPS and r6, and their behaviour is unchanged — GrnRefused keeps the same positional
 * (status, message, payload) signature every call site below already used, and
 * logAuditOrThrow keeps its three verify-or-throw failure messages verbatim.
 * They moved because the LINE amendment added by PATCH has to reverse a receipt
 * exactly the way DELETE does; sharing one implementation is the only way the
 * two cannot drift apart. See that file's header for the doctrine.
 */

/** A stored UTC stamp ('YYYY-MM-DD HH:MM:SS') as the venue reads it. Every other
 *  surface in this feature renders through the page's fmtIST; a message that
 *  interpolated the raw column told an admin in Hyderabad the bill was voided
 *  five and a half hours before they voided it. */
function istStamp(utc: any): string {
  const s = String(utc ?? '').trim();
  if (!s) return '';
  const d = new Date(/[TZ]/.test(s) ? s : s.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
}

/** The same outlet predicate the list at GET /api/grn applies:
 *  `(g.outlet_id = ? OR g.outlet_id IS NULL)`. A GRN the caller's own list does
 *  not show is not a GRN they may amend or void — the id alone is not an
 *  authorisation, and neither PUT nor DELETE read the outlet before this. */
function outletBlock(grn: any, outletId: string | null): string | null {
  if (!outletId) return null;                 // no outlet dimension resolved — nothing to scope by
  if (grn.outlet_id == null) return null;     // shared/unassigned document, visible everywhere
  if (String(grn.outlet_id) === String(outletId)) return null;
  return `${grn.grn_number} belongs to a different outlet than the one you are working in. Switch to that outlet first — a bill is amended and voided from the books it was recorded in.`;
}

/** The po_vendor_bills row receive/route.ts wrote for this GRN.
 *
 *  THE LINK IS PROSE, NOT A COLUMN: that table has no grn_id, and receive writes
 *  `notes = 'GRN <number>'` optionally followed by ' — <charges note>'. Both exact
 *  forms are matched here rather than a `LIKE 'GRN <number>%'`, which would also
 *  catch GRN-2026-00011 when looking for GRN-2026-0001 once the sequence passes
 *  four digits. If the match is not EXACTLY ONE row the caller is refused rather
 *  than a guess being rewritten — this row is the duplicate-bill guard. */
function poVendorBillsFor(db: ReturnType<typeof getDb>, poId: string, grnNumber: string): any[] {
  try {
    return db.prepare(`
      SELECT id, po_id, vendor_name, bill_no, bill_date, notes
      FROM po_vendor_bills
      WHERE po_id = ? AND (notes = ? OR notes LIKE ?)
    `).all(poId, `GRN ${grnNumber}`, `GRN ${grnNumber} — %`) as any[];
  } catch {
    // Table missing on an un-migrated DB. Treated as "cannot identify", which
    // the caller turns into a refusal — never into a silent skip.
    return [];
  }
}

/** One sentence per PO rail the void touched, for the audit note and the
 *  admin's on-screen notice. Says what happened rather than that something did:
 *  "reversed 0 material(s)" on a held receipt already reads as a silent failure,
 *  and "the PO is open again" is the fact the storekeeper needs before they can
 *  re-receive the delivery. */
function poVoidNote(po: PoVoidOutcome): string {
  const bits: string[] = [];
  if (po.po_reopened) {
    bits.push(`${po.po_number} is open again for receiving (total back to the ordered ₹${po.po_total_cost}).`);
  } else if (po.po_status === 'approved') {
    // Never closed by this receipt in the first place — a part-delivered order.
    // Saying "stays approved — another receipt still covers every line" here
    // would be describing a completion that never happened.
    bits.push(`${po.po_number} was already open for receiving and stays that way; its ordered total is unchanged.`);
  } else if (!po.po_total_restamped) {
    bits.push(`${po.po_number} stays ${po.po_status} — a surviving receipt still covers every line this bill did. Its received total was left at ₹${po.po_total_cost} because another delivery on the order is still waiting for a quality check; it is re-derived when that one is signed off.`);
  } else {
    bits.push(`${po.po_number} stays ${po.po_status} — a surviving receipt still covers every line this bill did (received total re-derived to ₹${po.po_total_cost}).`);
  }
  if (po.bill_released) {
    bits.push(po.bill_released.bill_no
      ? `Bill no. "${po.bill_released.bill_no}" from ${po.bill_released.vendor_name || '(no vendor)'} was released and can be received again.`
      : `The blank-bill receipt from ${po.bill_released.vendor_name || '(no vendor)'} was released, so that vendor can deliver against this order again.`);
  } else {
    bits.push(`No vendor bill row was recorded for this receipt, so there was none to release.`);
  }
  if (po.requisition?.unfulfilled) {
    if (po.requisition.party_rows_deleted) {
      bits.push(`Requisition returned to the store queue and ${po.requisition.party_rows_deleted} party-consumption movement(s) were reversed, crediting ${po.requisition.stock_restored.length} material(s) back.`);
    } else if (po.requisition.party_rows_left_intact) {
      bits.push(`Requisition returned to the store queue. Its ${po.requisition.party_rows_left_intact} party-consumption movement(s) were booked by a store issue rather than by this order, so they were left exactly as they are and no stock was credited back.`);
    } else {
      bits.push(`Requisition returned to the store queue; no party consumption had been booked.`);
    }
  }
  return ` ${bits.join(' ')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// PUT — amend the bill-level fields
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHAT IS EDITABLE, AND WHY THE REST IS NOT.
 *
 * Editable — the bill's IDENTITY and its paperwork, none of which moves stock
 * or money: invoice_number, invoice_date, vendor / vendor_id (ad-hoc only),
 * qc_by, notes, and the six qc_* ticks.
 *
 * NOT editable here, each for a specific reason:
 *   · `date` — it is the valuation date of every `purchases` row this GRN wrote
 *     AND the month window updateMaterialPrice averages over. Moving it silently
 *     re-values two months of cost and every recipe underneath them, and on a
 *     PO-sourced GRN it would also drift from purchase_orders.received_at. A
 *     wrong receipt date is a void-and-re-enter, not an amendment.
 *   · line items (quantities, rates, charges) — those ARE the stock movement.
 *     Changing them means reversing and re-applying it; that is the void path.
 *   · vendor on a PO-sourced GRN — the vendor there is not free text, it is the
 *     grouping key receive/route.ts filed the lines and the po_vendor_bills row
 *     under. Rewriting it here would orphan that row.
 * Each of those is REFUSED with its reason when sent, never silently ignored: a
 * caller that believes it changed the date is worse off than one that got a 400.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    // ── WHO MAY AMEND A COMMITTED BILL ──────────────────────────────────────
    // A session alone is NOT the bar, even though POST /api/grn (which creates
    // the document) settles for one. Three things make this reach further than
    // a create:
    //   · it rewrites purchases.vendor and purchases.bill_no — the spend ledger
    //     behind /api/reports/purchases and purchase-bill-summary, both of which
    //     403 a staff session for merely READING the same figures;
    //   · it rewrites po_vendor_bills.bill_no, the duplicate-bill guard;
    //   · it reaches BACKWARD into history, which a create cannot.
    // src/proxy.ts guards pages, not APIs, and /grn carries no tier flag, so a
    // waiter on a shared floor tablet could reach this with one fetch.
    // The bar is therefore the people who may record a receipt (store manager)
    // or see vendor money (management) — the same shape as
    // api/purchase-orders/[id]/edit-approved, which amends an already-approved
    // purchase document. FAILS CLOSED: both helpers read the RESOLVED tier off
    // the session (never canAccessPage, which fails open four ways), and an
    // unresolvable role leaves both false.
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!(canProcessAsStore(me) || isManagement(me))) {
      return Response.json({
        error: 'Amending a received bill is limited to the store manager, a manager or an admin — it rewrites the vendor and bill number on the purchase ledger and on the duplicate-bill guard.',
      }, { status: 403 });
    }
    const db = getDb();

    const grn = db.prepare('SELECT * FROM goods_receipt_notes WHERE id = ?').get(id) as any;
    if (!grn) return Response.json({ error: 'Not found' }, { status: 404 });
    const outOfOutlet = outletBlock(grn, await getCurrentOutletId());
    if (outOfOutlet) return Response.json({ error: outOfOutlet }, { status: 403 });
    if (String(grn.status) === 'void') {
      return Response.json({
        error: `This bill was voided${grn.voided_by ? ' by ' + grn.voided_by : ''}${grn.voided_at ? ' on ' + istStamp(grn.voided_at) : ''} and can no longer be amended. Record a fresh GRN instead.`,
      }, { status: 409 });
    }

    const b = await request.json().catch(() => ({} as any));
    const has = (k: string) => Object.prototype.hasOwnProperty.call(b || {}, k);

    // Refuse the fields that look editable but are not — with the reason.
    if (has('items')) {
      return Response.json({
        error: 'Line items are not editable on an amendment. Quantities and rates ARE the stock movement — void this GRN and record it again.',
      }, { status: 400 });
    }
    if (has('date') && String(b.date || '').trim() !== String(grn.date || '').trim()) {
      return Response.json({
        error: 'The receipt date cannot be amended: it is the valuation date of every cost row this GRN wrote and the month the weighted average is taken over. Void this GRN and record it on the correct date.',
      }, { status: 400 });
    }
    if (has('status')) {
      return Response.json({ error: 'Status is not editable. Use the void action to cancel a bill.' }, { status: 400 });
    }

    const isPoGrn = !!grn.po_id;
    const changes: Record<string, { from: any; to: any }> = {};
    const sets: string[] = [];
    const vals: any[] = [];
    // BOTH SIDES TRIMMED. Every candidate below arrives .trim()ed, but the
    // STORED value is not guaranteed to be — POST /api/grn writes
    // `invoice_number || ''` verbatim — so comparing a trimmed candidate against
    // a raw column reports '  PAD-99  ' → 'PAD-99' as a real amendment: it
    // stamps a permanent "edited" marker, re-stamps the cost rows and writes an
    // audit event for a bill nobody changed. Whitespace-only difference is NOT
    // a change; a genuine difference still writes the trimmed value.
    const same = (a: any, b: any) => String(a ?? '').trim() === String(b ?? '').trim();
    const put = (col: string, next: any, prev: any) => {
      if (same(prev, next)) return;
      changes[col] = { from: prev ?? null, to: next ?? null };
      sets.push(`${col} = ?`); vals.push(next);
    };

    // ── invoice_number — MANDATORY, and an amendment may not remove it ──────
    // Enforced when the field is SENT (a partial patch touching only `notes`
    // must not be blocked by a legacy PO GRN that never had a bill number). What
    // is forbidden is clearing or blanking it: this number is the only way back
    // to the paper months later, and the duplicate-bill guard skips any row
    // whose bill_no is blank — so a cleared number does not merely lose a
    // reference, it turns the guard off for those rows.
    let invoiceChanged = false;
    if (has('invoice_number')) {
      // normalizeBillNo, NOT `?? ''` + .trim(). Proven against this route before
      // the change: `""`, `"   "` and `null` were all refused, and a single ZERO
      // WIDTH SPACE was ACCEPTED — it replaced a real bill number on a received,
      // PO-sourced GRN across goods_receipt_notes, po_vendor_bills AND the
      // purchases mirror, which is precisely the removal this guard exists to
      // stop, done in a way nothing on any screen can show. `||` rather than
      // `??` also means a numeric 0 now reads as "no number" here, the same as
      // it already did on the receive route.
      const next = normalizeBillNo(b.invoice_number);
      if (!next) {
        return Response.json({
          error: 'Vendor invoice / bill number is required — an amendment cannot remove the only link back to the vendor\'s paperwork.',
        }, { status: 400 });
      }
      put('invoice_number', next, grn.invoice_number);
      invoiceChanged = 'invoice_number' in changes;
    }
    let invoiceDateChanged = false;
    if (has('invoice_date')) {
      put('invoice_date', String(b.invoice_date ?? '').trim(), grn.invoice_date);
      invoiceDateChanged = 'invoice_date' in changes;
    }

    // ── vendor — ad-hoc only ────────────────────────────────────────────────
    if (has('vendor') || has('vendor_id')) {
      const nextVendor = has('vendor') ? String(b.vendor ?? '').trim() : String(grn.vendor ?? '');
      const nextVendorId = has('vendor_id') ? (String(b.vendor_id ?? '').trim() || null) : (grn.vendor_id ?? null);
      const vendorMoves = !same(nextVendor, grn.vendor) || !same(nextVendorId, grn.vendor_id);
      if (vendorMoves && isPoGrn) {
        return Response.json({
          error: 'The vendor on a PO-sourced GRN cannot be amended — it is the key the PO lines and the vendor bill row were filed under, not a free-text field. Amend the bill number or date instead.',
        }, { status: 400 });
      }
      if (vendorMoves) {
        put('vendor', nextVendor, grn.vendor);
        put('vendor_id', nextVendorId, grn.vendor_id);
      }
    }

    // qc_by is guarded below with the three kitchen ticks — on a gated receipt
    // it IS the kitchen's signature, not a free-text note.
    if (has('notes')) put('notes', String(b.notes ?? ''), grn.notes);

    // ── THE THREE KITCHEN TICKS ARE NOT THE RECEIVER'S TO WRITE ─────────────
    // On a GRN the kitchen QC gate held (qc_required = 1), quality / temperature
    // / damage belong to the CHECKING DEPARTMENT and are stamped by
    // POST /api/grn/[id]/qc together with qc_kitchen_by and qc_kitchen_at.
    // This route's bar is canProcessAsStore || isManagement — i.e. the store
    // manager, the very person the owner's decision 4 separates from the
    // checker. Letting them flip the ticks here would reinstate the exact defect
    // this feature exists to remove ("ticked by the same person doing the
    // inward"), in two ways: BEFORE sign-off it pre-ticks a check nobody made,
    // and AFTER sign-off — or after an override, where they are deliberately
    // left at 0 — it rewrites the kitchen's answer with no second signature and
    // makes the printed GRN say "Quality OK" on goods no one ever judged.
    // SCOPED TO GATED RECEIPTS ONLY. qc_required is 0 on all 29 historical rows
    // and on every ungated delivery, so the pre-existing amend behaviour there
    // is untouched. The STORE's own three (expiry / weight / invoice match) stay
    // amendable on every receipt — they are this caller's half of the split.
    // qc_by IS IN THIS SET, and leaving it out was a hole the guard itself
    // created the appearance of closing. decideGrnQc writes the kitchen
    // signer's email into qc_by (it is the LEGACY single signature that
    // src/app/grn/print/[id]/page.tsx renders as "QC by" and as the
    // "QC verified by" signature line), and an override deliberately blanks it.
    // Left amendable at this route's bar (canProcessAsStore || isManagement),
    // a store manager could type "Ravi — Head Chef" onto a bill nobody checked,
    // or overwrite the real signer's name after a genuine sign-off while
    // qc_kitchen_by — which is never printed — silently disagreed. The printed
    // sheet is the surface most people read, so that is the one that matters.
    const KITCHEN_TICKS = ['qc_quality', 'qc_temperature', 'qc_damage'] as const;
    if (Number(grn.qc_required) === 1) {
      const attempted: string[] = KITCHEN_TICKS.filter(q => has(q) && (b[q] ? 1 : 0) !== (Number(grn[q]) ? 1 : 0));
      if (has('qc_by') && String(b.qc_by ?? '').trim() !== String(grn.qc_by ?? '').trim()) attempted.push('qc_by');
      if (attempted.length > 0) {
        return Response.json({
          error: `Quality, temperature, damage and the QC signature on ${grn.grn_number} are the checking department's to record, not the receiving desk's — this delivery was held for a ${String(grn.qc_checker || 'kitchen')} check. `
            + (String(grn.status) === 'awaiting_qc'
              ? 'Sign it off on Pending Quality Checks, or ask an admin / head chef to release it with a written reason.'
              : 'It has already been decided; a check cannot be re-ticked or re-signed afterwards. Void and re-record the receipt if it was wrong.'),
          fields: attempted,
        }, { status: 400 });
      }
    } else if (has('qc_by')) {
      // Ungated receipt — unchanged behaviour, qc_by stays the free-text note
      // the receiving bay has always typed.
      put('qc_by', String(b.qc_by ?? '').trim(), grn.qc_by);
    }
    for (const q of ['qc_quality', 'qc_temperature', 'qc_expiry', 'qc_damage', 'qc_weight', 'qc_invoice_match']) {
      if (has(q)) put(q, b[q] ? 1 : 0, Number(grn[q]) ? 1 : 0);
    }

    const changed = Object.keys(changes);
    if (changed.length === 0) {
      // NOT stamped as an edit. edit_count is what the row's "edited" marker
      // hangs on, and a save that altered nothing did not amend the bill —
      // bumping it would put a permanent marker on a document nobody changed.
      return Response.json({
        success: true, changed: [], edit_count: Number(grn.edit_count) || 0,
        message: 'Nothing changed.',
      });
    }

    const warnings: string[] = [];
    const editReason = String(b.edit_reason ?? b.reason ?? '').trim();
    let purchasesRestamped = 0;
    let billRowUpdated = 0;

    // THE BULK-IMPORT WILDCARD, counted BEFORE the re-stamp below overwrites it.
    // api/purchases/bulk/route.ts's duplicate guard treats a STORED row with an
    // EMPTY bill_no as matching ANY incoming bill number, and says why in its
    // own comment: without that wildcard "the same file re-uploaded would insert
    // again and DOUBLE the stock". Filling the number in is the right end state
    // — but it DISARMS the wildcard for these rows, so a re-upload of the same
    // inward sheet is only still caught if the number typed here matches the
    // number in the file. Warned, not refused: refusing would make historically
    // blank rows permanently un-amendable, which is the worse of the two.
    const blankBillRows = invoiceChanged
      ? (db.prepare(`SELECT COUNT(*) AS n FROM purchases WHERE grn_id = ? AND TRIM(COALESCE(bill_no, '')) = ''`)
          .get(id) as any)?.n || 0
      : 0;

    const txn = db.transaction(() => {
      // 1. ATOMIC CLAIM — the write lock and the replay guard in one statement.
      //    The precondition is REPEATED in the WHERE rather than trusted from the
      //    read above, so a void that landed in between is not amended over.
      const claim = db.prepare(`
        UPDATE goods_receipt_notes
        SET ${sets.join(', ')},
            edited_at = datetime('now'), edited_by = ?, edit_count = COALESCE(edit_count, 0) + 1
        WHERE id = ? AND status <> 'void'
      `).run(...vals, me.email, id);
      if (claim.changes === 0) {
        throw new GrnRefused(409, 'This bill was voided while you were editing it. Reload the page.');
      }

      // 2. po_vendor_bills — the duplicate-bill guard for PO receipts. Kept in
      //    step ONLY when the match is exactly one row; a zero or multi match is
      //    a refusal, because rewriting the wrong row would let the same vendor
      //    bill be received twice on that PO.
      if (isPoGrn && (invoiceChanged || invoiceDateChanged)) {
        const rows = poVendorBillsFor(db, String(grn.po_id), String(grn.grn_number));
        if (rows.length !== 1) {
          throw new GrnRefused(409,
            `Cannot amend the bill number: the vendor bill row behind ${grn.grn_number} could not be identified uniquely (${rows.length} match${rows.length === 1 ? '' : 'es'}). That row is the duplicate-bill guard for this PO, and rewriting the wrong one would let the same bill be received twice.`);
        }
        const nextBillNo = invoiceChanged ? String(changes.invoice_number.to ?? '') : rows[0].bill_no;
        const nextBillDate = invoiceDateChanged ? String(changes.invoice_date.to ?? '') : rows[0].bill_date;
        try {
          billRowUpdated = db.prepare(
            `UPDATE po_vendor_bills SET bill_no = ?, bill_date = ? WHERE id = ?`
          ).run(nextBillNo, nextBillDate, rows[0].id).changes;
        } catch (e: any) {
          if (String(e?.code || '').startsWith('SQLITE_CONSTRAINT')) {
            throw new GrnRefused(409,
              `Bill no. "${nextBillNo}" is already recorded for ${rows[0].vendor_name || '(no vendor)'} on this PO. The same bill cannot appear twice.`);
          }
          throw e;
        }
      }

      // 3. MIRROR TO THE COST ROWS. purchases.bill_no must not drift from the
      //    GRN's bill number: it is what the duplicate-bill guard keys on and
      //    what a vendor statement is reconciled against. `vendor` is mirrored
      //    for the same reason — the vendor-rate reports read it off this row,
      //    not off the GRN. Both are scoped by the HARD link (purchases.grn_id);
      //    there is no regex fallback on a write.
      if (invoiceChanged) {
        purchasesRestamped = db.prepare(`UPDATE purchases SET bill_no = ? WHERE grn_id = ?`)
          .run(String(changes.invoice_number.to ?? ''), id).changes;
      }
      if ('vendor' in changes) {
        db.prepare(`UPDATE purchases SET vendor = ? WHERE grn_id = ?`)
          .run(String(changes.vendor.to ?? ''), id);
        // ── AND TO THE COST ROW THAT HAS NOT BEEN WRITTEN YET ────────────────
        // A GRN the kitchen QC gate is holding has NO `purchases` rows: the
        // UPDATE above matches nothing, and the cost row is written hours later
        // by decideGrnQc from goods_receipt_note_items.cost_vendor — the copy
        // taken at inward, because on a mixed PO each line is booked against its
        // OWN vendor and the header's name is not it. Without this the amended
        // vendor would reach the GRN and the ledger would still book the typo.
        // SAFE ON EVERY OTHER RECEIPT because it can only fire where the header
        // vendor IS the line vendor: a vendor change on a PO-sourced GRN is
        // already refused above (it is the grouping key), so this branch is
        // ad-hoc-only, where cost_vendor was written as the header vendor. On an
        // already-applied GRN it rewrites a field nothing reads again, which
        // keeps the document and its cost rows telling one story.
        db.prepare(`UPDATE goods_receipt_note_items SET cost_vendor = ? WHERE grn_id = ?`)
          .run(String(changes.vendor.to ?? ''), id);
      }

      // 4. THE RECORD. audit_events is the authority on WHAT changed; the three
      //    stamps on the header row only say that it did, by whom and when.
      //    VERIFIED, not best-effort — if this row does not land, the stamp and
      //    the marker it drives roll back with it (see logAuditOrThrow).
      logAuditOrThrow(db, {
        event_type: 'grn.edit',
        entity_type: 'goods_receipt_note',
        entity_id: id,
        actor_email: me.email,
        outlet_id: grn.outlet_id ?? null,
        before: Object.fromEntries(changed.map(k => [k, changes[k].from])),
        after: Object.fromEntries(changed.map(k => [k, changes[k].to])),
        note: `Amended ${grn.grn_number}: ${changed.join(', ')}${editReason ? ` — ${editReason}` : ''}`,
      }, 'this amendment');
    });
    txn();

    // A GRN with accepted lines but no cost rows carrying its grn_id predates
    // that column, so the bill number could not be pushed down to them. Reported
    // rather than refused: blocking a legitimate header correction on old data
    // would be worse, and the caller needs to know the guard is still blind for
    // those rows.
    if (invoiceChanged) {
      const acceptedLines = (db.prepare(
        `SELECT COUNT(*) AS n FROM goods_receipt_note_items WHERE grn_id = ? AND quantity_accepted <> 0`
      ).get(id) as any)?.n || 0;
      if (acceptedLines > 0 && purchasesRestamped === 0) {
        warnings.push(
          'The bill number was changed on the GRN but no purchase cost row could be re-stamped — this receipt predates purchases.grn_id, so its cost rows are not linked and the duplicate-bill guard stays blind for them.'
        );
      }
      // The opposite case, and the one that can DOUBLE STOCK rather than merely
      // stay blind: rows that had NO bill number now have one, so the bulk
      // importer's empty-bill wildcard no longer covers them.
      if (blankBillRows > 0 && purchasesRestamped > 0) {
        warnings.push(
          `${blankBillRows} cost row(s) on this receipt had no bill number until now. Until today they matched ANY bill number in the CSV importer's duplicate check; from now on they only match "${String(changes.invoice_number.to ?? '')}". If you re-upload an inward sheet that covers these lines, make sure its bill-number column says exactly that — otherwise the importer will treat them as new lines and add the stock a second time.`
        );
      }
    }

    const after = db.prepare('SELECT * FROM goods_receipt_notes WHERE id = ?').get(id) as any;
    return Response.json({
      success: true,
      changed,
      edit_count: Number(after?.edit_count) || 0,
      edited_at: after?.edited_at || null,
      edited_by: after?.edited_by || '',
      purchases_restamped: purchasesRestamped,
      po_vendor_bill_updated: billRowUpdated,
      warnings,
    });
  } catch (e: any) {
    if (e instanceof GrnRefused) {
      return Response.json({ error: e.message, ...(e.payload || {}) }, { status: e.httpStatus });
    }
    console.error('[grn PUT]', e);
    return Response.json({ error: e?.message || 'Amend failed' }, { status: 500 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH — amend the LINE ITEMS. ADMIN ONLY.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CHANGE A QUANTITY, A RATE, OR REMOVE A LINE ON AN ALREADY-RECORDED BILL.
 *
 * PUT above amends the bill's IDENTITY and its paperwork — invoice number, date,
 * vendor, the QC ticks, notes — and REFUSES `items` outright, because quantities
 * and rates ARE the stock movement. This handler is the answer to that refusal:
 * it unwinds the old stock and cost effect and applies the new one in ONE
 * transaction, so the four writes a receipt makes (the bill line, the `purchases`
 * cost row, raw_materials.current_stock + last_purchase_price, and the
 * inventory_transactions movement) all end consistent, or nothing changes.
 *
 * ── WHO ────────────────────────────────────────────────────────────────────
 * ADMIN ONLY, FAILING CLOSED — a strictly higher bar than PUT's
 * (canProcessAsStore || isManagement), and the SAME bar as the void, because
 * this reaches exactly as far as a void does: it moves stock, deletes and
 * rewrites cost rows, and drags average_price through updateMaterialPrice into
 * every sub-recipe and recipe. requireRole('admin') is used, never
 * canAccessPage — that helper fails OPEN four ways (NULL, [], bad JSON, a
 * non-array) and is not a gate. src/proxy.ts guards pages, not APIs, so without
 * this a waiter on a shared floor tablet could reach it with one fetch.
 *
 * ── WHAT IT WILL NOT DO, AND WHY ───────────────────────────────────────────
 *   · ADD a line. One material = one line is enforced on every writer
 *     (duplicateLineError), and it is the only per-line key from a cost row back
 *     to a bill line, because `purchases` has no grn_item_id. A line that was
 *     never on the bill is a new delivery, recorded as its own GRN.
 *   · CHANGE a line's MATERIAL. That is not a correction to this line, it is a
 *     reversal of one material and a receipt of another — with two different
 *     stock pools, two different weighted averages and two different recipe
 *     cascades. Remove the line and record the right one.
 *   · CHANGE the receipt DATE, the vendor, the bill number, the discount or the
 *     recorded-only charges. The first three are PUT's; the last two are what
 *     the vendor's bill says and are not a function of quantity.
 *   · REMOVE a line from a PO-sourced receipt. See poLineRemovalRefusal in
 *     @/lib/grn-reversal — the same knot the void documents, and the response
 *     names the alternative (set accepted to 0, which reverses the stock and the
 *     cost row while keeping the PO line claimed).
 * Each is REFUSED with its reason, never silently ignored: a caller that
 * believes it changed something is worse off than one that got a 400.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const gate = await requireRole('admin');
    if (!gate.ok) {
      return Response.json(
        { error: gate.message, code: gate.status === 401 ? 'unauthenticated' : 'forbidden' },
        { status: gate.status },
      );
    }
    const me = gate.user;
    const db = getDb();

    const grn = db.prepare('SELECT * FROM goods_receipt_notes WHERE id = ?').get(id) as any;
    if (!grn) return Response.json({ error: 'Not found', code: 'not_found' }, { status: 404 });
    // Scoped to the outlet the caller is working in, exactly as the list is — a
    // bill you cannot see is a bill you cannot correct.
    const outOfOutlet = outletBlock(grn, await getCurrentOutletId());
    if (outOfOutlet) return Response.json({ error: outOfOutlet, code: 'wrong_outlet', refused: true }, { status: 403 });
    if (String(grn.status) === 'void') {
      return Response.json({
        error: `This bill was voided${grn.voided_by ? ' by ' + grn.voided_by : ''}${grn.voided_at ? ' on ' + istStamp(grn.voided_at) : ''}. A voided receipt's lines are kept as the record of what the document said and can no longer be edited — record a fresh GRN instead.`,
        code: 'voided',
        refused: true,
      }, { status: 409 });
    }

    // Body read BEFORE the transaction: better-sqlite3 transactions are
    // synchronous and nothing may be awaited inside one.
    const b = await request.json().catch(() => ({} as any));

    // ── THE REASON IS MANDATORY, and it fails closed. ──────────────────────
    // This is a backward correction to a committed financial document: months
    // later the audit row is all that explains why the book disagrees with the
    // paper. The void asks for one too. A blank reason is a 400, never a silent
    // empty string.
    const reason = String(b?.reason ?? b?.edit_reason ?? '').trim();
    if (reason.length < 3) {
      return Response.json({
        error: 'A reason is required to correct a recorded bill — it is the only thing that will explain this change to whoever reads the ledger months from now.',
        code: 'reason_required',
      }, { status: 400 });
    }

    const rawLines = Array.isArray(b?.lines) ? b.lines : null;
    if (!rawLines || rawLines.length === 0) {
      return Response.json({ error: 'lines array required — send the line(s) to correct.', code: 'no_lines' }, { status: 400 });
    }

    const lines: AmendLineInput[] = [];
    const seen = new Set<string>();
    for (const l of rawLines) {
      const lineId = String(l?.id ?? '').trim();
      if (!lineId) {
        return Response.json({ error: 'Every line must carry its `id` (goods_receipt_note_items.id).', code: 'line_id_required' }, { status: 400 });
      }
      if (seen.has(lineId)) {
        return Response.json({
          error: `Line ${lineId} appears twice in this request. One line, one correction — two corrections to the same line in one call would apply the second on top of the first with no record of the middle state.`,
          code: 'duplicate_line',
        }, { status: 400 });
      }
      seen.add(lineId);
      if (l?.material_id !== undefined) {
        return Response.json({
          error: 'A line\'s material cannot be changed. That is not a correction to this line — it is a reversal of one material and a receipt of another, with two stock pools, two weighted averages and two recipe cascades. Remove this line and record the right one.',
          code: 'material_change',
        }, { status: 400 });
      }
      const remove = !!l?.remove;
      const num = (v: any) => {
        if (v === undefined || v === null || String(v).trim() === '') return undefined;
        const n = Number(v);
        return Number.isFinite(n) ? n : NaN;
      };
      const qr = num(l?.quantity_received);
      const qa = num(l?.quantity_accepted);
      const up = num(l?.unit_price);
      for (const [k, v] of [['quantity_received', qr], ['quantity_accepted', qa], ['unit_price', up]] as const) {
        if (Number.isNaN(v as number)) {
          return Response.json({ error: `${k} on line ${lineId} is not a number.`, code: 'bad_number' }, { status: 400 });
        }
      }
      if (!remove && qr === undefined && qa === undefined && up === undefined) {
        return Response.json({
          error: `Line ${lineId} carries no change and no removal. Send at least one of quantity_received, quantity_accepted, unit_price — or remove: true.`,
          code: 'empty_line_change',
        }, { status: 400 });
      }
      const e = l?.expect;
      // THE OPTIMISTIC LOCK IS MANDATORY, and this is the idempotency
      // guarantee: without the three values the caller SAW there is nothing to
      // re-assert under the write lock, and a double submit or a replayed
      // request would apply the same correction twice. Fail closed.
      if (!e || [e.quantity_received, e.quantity_accepted, e.unit_price].some(v => !Number.isFinite(Number(v)))) {
        return Response.json({
          error: `Line ${lineId} must carry \`expect\` with the quantity_received, quantity_accepted and unit_price the form was showing. They are re-checked under the write lock, so a double submit or a retry cannot apply the same correction twice.`,
          code: 'expect_required',
        }, { status: 400 });
      }
      lines.push({
        id: lineId, remove,
        quantity_received: qr, quantity_accepted: qa, unit_price: up,
        expect: {
          quantity_received: Number(e.quantity_received),
          quantity_accepted: Number(e.quantity_accepted),
          unit_price: Number(e.unit_price),
        },
      });
    }

    // The header the caller was looking at. `expect_status` is PINNED IN THE
    // CLAIM: a QC sign-off landing between the read and the lock moves a receipt
    // from held (no stock effect) to inwarded (the full four writes), and running
    // the wrong branch would double-apply or double-reverse stock.
    // `expect_edit_count` is optional and additive — when sent it is the
    // bill-level half of the same replay guard.
    const expectStatus = String(b?.expect_status ?? '').trim() || String(grn.status);
    const expectEditCount = b?.expect_edit_count === undefined || b?.expect_edit_count === null
      ? null : Number(b.expect_edit_count);
    if (expectEditCount != null && !Number.isFinite(expectEditCount)) {
      return Response.json({ error: 'expect_edit_count must be a number.', code: 'bad_number' }, { status: 400 });
    }

    const result = amendGrnLines(db, {
      grnId: id, actorEmail: me.email, reason, lines, expectStatus, expectEditCount,
    });

    // ── AFTER THE COMMIT: the weighted average and the recipe cascade. ──────
    // updateMaterialPrice does its own writes and cascades into every sub-recipe
    // and recipe, so it must not run inside the transaction above.
    //
    // PAST THIS LINE THE CORRECTION HAS COMMITTED, so NOTHING here may surface as
    // a failure. The void learned this the hard way: a SQLITE_BUSY out of
    // updateMaterialPrice returned "500 failed" on a reversal that had happened,
    // and an admin who believes a correction failed corrects it AGAIN, by hand,
    // on top of the one that already landed. Averages are recoverable (the next
    // purchase re-derives them, and updateMaterialPrice can be re-run); a
    // duplicated manual correction is not.
    const warnings = [...result.warnings];
    const averagePriceStale: Array<{ material_id: string; material_name: string }> = [];
    for (const mid of result.materials_touched) {
      const name = result.changes.find(c => c.material_id === mid)?.material_name || mid;
      try {
        const remaining = (db.prepare(`SELECT COUNT(*) AS n FROM purchases WHERE material_id = ?`).get(mid) as any)?.n || 0;
        // updateMaterialPrice leaves average_price UNTOUCHED when no purchase
        // rows remain (`if (sameMonth.total_qty > 0)` / `if (latest)`), so the
        // removed line's price silently stands. Nothing anywhere stores the
        // pre-receipt average, so there is nothing honest to restore it from —
        // it is NAMED rather than pretended about.
        if (remaining === 0) averagePriceStale.push({ material_id: mid, material_name: name });
        updateMaterialPrice(db, mid);
      } catch (e: any) {
        console.error('[grn PATCH] post-commit price refresh failed', mid, e);
        warnings.push(
          `${name}: the weighted average could not be re-derived after the correction (${e?.message || 'unknown error'}). The correction WAS applied — do not re-send it; the next purchase of this material will correct its average.`
        );
      }
    }
    // ── THE OFF-PO ALERT. Post-commit and best-effort, for the same reason the
    //    price refresh above is: the correction is already recorded, and a
    //    notification that fails must not present as a correction that failed.
    //    The receiving desk refuses an off-PO line outright unless a deviation
    //    reason is given and then tells the admin; a correction that moves a line
    //    off its PO after the fact must tell him too, or the alert is only as
    //    good as nobody using this route.
    let poDeviationEvent: string | null = null;
    if (result.po_deviation.length > 0 && result.po_id) {
      poDeviationEvent = raisePoDeviationAlert(db, {
        poId: result.po_id, poNumber: result.po_number,
        grnNumber: result.grn_number, grnId: id,
        vendor: String(grn.vendor || ''), actorEmail: me.email, reason,
        lines: result.po_deviation,
      });
      if (!poDeviationEvent) {
        warnings.push(
          `This correction moved ${result.po_deviation.length} line(s) away from what ${result.po_number || 'the purchase order'} ordered, but the admin alert could not be raised. The correction WAS applied — do not re-send it; tell the purchasing admin directly.`
        );
      }
    }
    if (averagePriceStale.length > 0) {
      // Best-effort ON PURPOSE, unlike the write inside the transaction: this
      // note is a follow-up about a price field, the correction it annotates is
      // already recorded in grn.line_edit, and there is no longer a transaction
      // to roll back. Losing it must not turn a committed correction into an error.
      logAuditEvent(db, {
        event_type: 'grn.line_edit.price_stale',
        entity_type: 'goods_receipt_note',
        entity_id: id,
        actor_email: me.email,
        outlet_id: grn.outlet_id ?? null,
        after: { materials: averagePriceStale },
        note: 'No purchase rows remain for these materials after the line correction, so the weighted average still carries the removed line\'s price. Nothing stores the pre-receipt average; it must be corrected by hand or by the next real purchase.',
      });
    }

    return Response.json({
      success: true,
      ...result,
      average_price_stale: averagePriceStale,
      po_deviation_event: poDeviationEvent,
      warnings,
      notice: [
        result.state === 'held'
          ? 'This receipt is still waiting for a quality check, so it had never moved stock — only the bill lines were corrected. The corrected quantities and rates will be applied when the checking department signs it off.'
          : 'Stock, the cost rows and the stock movements were corrected together in one transaction.',
        result.last_purchase_kept.length
          ? `${result.last_purchase_kept.length} material(s) kept their existing last-purchase rate — it came from a different receipt, not from this bill.`
          : '',
        averagePriceStale.length
          ? `${averagePriceStale.length} material(s) have no purchases left, so their weighted average still carries this bill's price — correct it by hand or with the next purchase.`
          : (result.materials_touched.length ? 'Weighted averages were re-derived from the surviving purchases.' : ''),
        result.po_total_restamped
          ? 'The purchase order\'s received total was re-derived from its GRN lines.'
          : '',
        poDeviationEvent
          ? `${result.po_deviation.length} line(s) no longer match what the purchase order asked for — the purchasing admin has been alerted (${poDeviationEvent}).`
          : '',
        'Valuations already taken at the old average (closing stock, department variance, party consumption, production batches) are historical and were NOT rewritten.',
      ].filter(Boolean).join(' '),
    });
  } catch (e: any) {
    if (e instanceof GrnRefused) {
      return Response.json({ error: e.message, code: e.code || 'refused', refused: true, ...(e.payload || {}) }, { status: e.httpStatus });
    }
    console.error('[grn PATCH]', e);
    return Response.json({ error: e?.message || 'Line amendment failed', code: 'server_error' }, { status: 500 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE — reverse the stock, then void the row. ADMIN ONLY.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * EVERY CONDITION UNDER WHICH THIS REFUSES, in the order it checks them:
 *   403  caller is not an admin (requireRole fails closed — no session, an
 *        unresolvable role and any thrown lookup all deny).
 *   403  the GRN belongs to another outlet than the one the caller is working
 *        in — the same predicate the list applies, so a bill you cannot see is
 *        a bill you cannot void.
 *   404  no such GRN.
 *   409  already voided. The claim's WHERE matches nothing on a replay, so a
 *        second call reverses NOTHING — this is the idempotency guarantee.
 *
 *   ── PO-SOURCED RECEIPTS ONLY (po_id NOT NULL). Every one of these is raised
 *      by src/lib/po-void.ts BEFORE any quantity moves, and each carries a
 *      machine-readable `code` so the modal can offer the right next step.
 *      CHECKED AFTER the bill-level refusals below, on purpose: those describe
 *      walls this bill can never get past, these describe walls that clear.
 *   409  po_missing — the purchase order row is gone. The order cannot be
 *        reopened, so the goods would be reversed against nothing.
 *   409  po_status_unexpected — the order is neither 'approved' nor 'received'.
 *        Those are the only two states that can carry a receipt; anything else
 *        means something this route does not understand has moved it.
 *   409  po_later_receipt — a live receipt KEYED AFTER this one still stands on
 *        the order. A PO cannot be received once closed, so an earlier bill is by
 *        definition not the one that closed it, and reopening would erase a
 *        completion date and a received total that the later bill stamped. Void
 *        newest first. "Later" is by created_at, never by the typed receipt date
 *        — backdating is ordinary and would otherwise let the wrong one through.
 *   409  po_bill_ambiguous / po_bill_unidentifiable / po_bill_unreadable — the
 *        po_vendor_bills row this receipt wrote cannot be pinned to exactly one
 *        row. That row is the UNIQUE(po_id, vendor_name, bill_no) duplicate-bill
 *        guard: release the wrong one and a DIFFERENT bill can be received
 *        twice; release none and the reopened order can never take its own bill.
 *   409  requisition_missing / requisition_moved_on — the requisition this order
 *        fulfilled is gone, or has since moved on from 'fulfilled'. Undoing it
 *        would overwrite whatever moved it.
 *   409  party_unattributable / party_two_rails / party_row_shape /
 *        party_material_missing / party_provenance_unreadable — the party
 *        deduction on that requisition cannot be proved to be this cascade's.
 *        TWO writers produce an identically shaped party_consumption row on the
 *        same reference_id (this cascade and applyPartyFulfillment), and nothing
 *        on the row says which. Crediting back the wrong one invents stock.
 *        NOT raised where the cascade's own audit trail proves it SKIPPED its
 *        deduction: there the void succeeds, demotes the requisition and leaves
 *        the other rail's movements untouched — the reversal is exactly as wide
 *        as the action was.
 *
 *   409  the receipt is dated ON OR BEFORE a committed central-store cutover.
 *        The cutover RE-BASED current_stock to a physical count that already
 *        absorbs this receipt, and variance-report floors purchases_to_date at
 *        the cutover date — so debiting the stock now would take the book below
 *        the counted baseline with no offsetting term anywhere.
 *   409  a vendor/internal return ticket references this GRN or one of its
 *        lines and is not cancelled/rejected. Part of the stock has already been
 *        reversed on the returns rail; a full void would debit it twice, and
 *        voiding the lines would orphan the ticket's anchor. A SETTLED
 *        (store-verified) ticket and an OPEN one are told apart, because only
 *        the open one can be cleared — a settled return cannot be cancelled, so
 *        that bill is permanently unvoidable and the message says so instead of
 *        sending the admin round a loop.
 *   409  the cost rows cannot be identified: accepted lines exist but no
 *        `purchases` row carries this grn_id (a receipt older than that column),
 *        or the count of linked cost rows does not match the count of accepted
 *        lines. A destructive reversal does not fall back to matching on prose.
 *   409  a linked `purchases` row has no inventory_transactions movement behind
 *        it — the quantity that actually moved is unknown for that row.
 *   409  would_go_negative — reversing would drive a material's current_stock
 *        below zero, i.e. the goods have already been consumed or issued.
 *        REFUSED, NEVER CLAMPED (src/lib/return-stock.ts states the rule): a
 *        clamp would commit a void claiming to have reversed more than really
 *        moved. On a PO receipt that also reverses a party requisition the test
 *        is the NET of this reversal's debit and that cascade's credit, so a
 *        void whose two halves cancel out is not refused for the sake of it.
 *
 * WHAT IT REVERSES BY: the RECORDED inventory_transactions.quantity, never a
 * recomputed accepted × pack_size. pack_size is mutable (that is why the
 * unit-audit lock exists), so a recompute would subtract a different number
 * than was added.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    // ADMIN ONLY, FAIL CLOSED. Not canAccessPage — that fails open on NULL, [],
    // bad JSON and a non-array, and is not a gate.
    const gate = await requireRole('admin');
    if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });
    const me = gate.user;
    const db = getDb();

    const grn = db.prepare('SELECT * FROM goods_receipt_notes WHERE id = ?').get(id) as any;
    if (!grn) return Response.json({ error: 'Not found' }, { status: 404 });
    // Scoped to the outlet the caller is working in, exactly as the list is. An
    // admin can void anything — but from that outlet's books, not across them.
    const outOfOutlet = outletBlock(grn, await getCurrentOutletId());
    if (outOfOutlet) return Response.json({ error: outOfOutlet, refused: true }, { status: 403 });

    // Body read BEFORE the transaction: better-sqlite3 transactions are
    // synchronous and nothing may be awaited inside one.
    let reason = '';
    try { const b = await request.json(); reason = String(b?.reason ?? '').trim(); } catch { /* no body is fine */ }

    const cutoverDate = getCentralStoreCutoverDate(db);

    const result: {
      materials: { material_id: string; material_name: string; reversed_qty: number }[];
      purchases_deleted: number;
      transactions_deleted: number;
      average_price_stale: { material_id: string; material_name: string }[];
      last_purchase_stale: { material_id: string; material_name: string }[];
      last_purchase_kept: { material_id: string; material_name: string }[];
    } = { materials: [], purchases_deleted: 0, transactions_deleted: 0, average_price_stale: [], last_purchase_stale: [], last_purchase_kept: [] };

    // The PO rails: planned inside the transaction (step 2), written at step 5b,
    // reported afterwards. Stays null on an ad-hoc GRN, and every branch that
    // reads it below is guarded on that — the ad-hoc path is byte-unchanged.
    let poVoid: PoVoidPlan | null = null;
    let poResult: PoVoidOutcome | null = null;

    const txn = db.transaction(() => {
      // ── 1. CLAIM FIRST. Takes the write lock AND is the replay guard: a
      //       second void matches zero rows and the throw below rolls back
      //       before a single quantity has moved.
      const claim = db.prepare(`
        UPDATE goods_receipt_notes
        SET status = 'void', voided_at = datetime('now'), voided_by = ?, void_reason = ?
        WHERE id = ? AND status <> 'void'
      `).run(me.email, reason, id);
      if (claim.changes === 0) {
        const cur = db.prepare('SELECT voided_by, voided_at FROM goods_receipt_notes WHERE id = ?').get(id) as any;
        throw new GrnRefused(409,
          `${grn.grn_number} is already voided${cur?.voided_by ? ' by ' + cur.voided_by : ''}${cur?.voided_at ? ' on ' + istStamp(cur.voided_at) : ''}. Nothing was reversed a second time.`);
      }

      // ── 2. REFUSALS. Every one of these throws, which rolls the claim back.
      //
      // THE ORDER OF THE CHECKS IS THE ORDER THE ADMIN NEEDS TO HEAR THEM IN.
      // The four below — cutover, returns, cost-row identity, orphan cost row —
      // are properties of THIS BILL, and three of them make it permanently
      // unvoidable. The PO rails are properties of the ORDER AROUND IT, and
      // every one of those is clearable (void the later receipt; fix the bill
      // row; settle the requisition). Planning the PO rails first meant a bill
      // that could never be voided because of a settled return was reported as
      // `po_bill_unidentifiable`, and the admin was sent to fix a bill row that
      // was not the problem. Nothing writes in either order — every refusal
      // rolls the claim back — so this costs nothing and is only about telling
      // the truth about which wall was hit.
      if (cutoverDate && String(grn.date) <= String(cutoverDate)) {
        throw new GrnRefused(409,
          `${grn.grn_number} is dated ${grn.date}, on or before the central-store cutover (${cutoverDate}). The cutover re-based on-hand stock to a physical count that already includes this receipt, so reversing it now would debit the same goods twice. Correct it with a stock adjustment instead.`);
      }

      // FAILS CLOSED. If this read throws — the returns tables missing on an
      // un-migrated DB, schema init having swallowed its own error — the answer
      // is "cannot prove nothing was returned", and a destructive reversal does
      // not proceed on an unproven assumption.
      //
      // SETTLED AND OPEN ARE BOTH A BAR, BUT THEY ARE NOT THE SAME BAR, and the
      // message has to say which. A SETTLED (store-verified) return has already
      // debited part of this delivery, so a full reversal would take the same
      // grams out twice — and it can never be cancelled either
      // (api/returns/[id] refuses: "a settled stock movement is never undone in
      // place"). Telling that admin to "cancel or settle the returns first" sent
      // them round a loop the system itself forbids. An OPEN ticket really can
      // be cancelled, so for that one the instruction is real.
      let openReturns = 0;
      let settledReturns = 0;
      try {
        const r = db.prepare(`
          SELECT
            SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) AS settled,
            SUM(CASE WHEN status <> 'verified' THEN 1 ELSE 0 END) AS open
          FROM material_returns
          WHERE status NOT IN ('cancelled', 'hod_rejected')
            AND (grn_id = ?
                 OR id IN (SELECT ri.return_id FROM material_return_items ri
                            WHERE ri.grn_item_id IN (SELECT gi.id FROM goods_receipt_note_items gi WHERE gi.grn_id = ?)))
        `).get(id, id) as any;
        settledReturns = Number(r?.settled) || 0;
        openReturns = Number(r?.open) || 0;
      } catch (e: any) {
        throw new GrnRefused(409,
          `Cannot confirm whether anything from ${grn.grn_number} has already been returned (${e?.message || 'returns ledger unreadable'}). Refusing rather than risk reversing the same stock twice.`);
      }
      if (settledReturns > 0) {
        throw new GrnRefused(409,
          `${settledReturns} return ticket(s) against ${grn.grn_number} have already been settled by the store, so part of this delivery has physically gone back and its stock is already out of the book. Voiding the whole receipt would take the same goods out a second time. A settled return cannot be cancelled either — this bill can no longer be voided. Correct the remainder with a stock adjustment, or raise a vendor return for what is left.`);
      }
      if (openReturns > 0) {
        throw new GrnRefused(409,
          `${openReturns} open return ticket(s) reference ${grn.grn_number}. Voiding the receipt would leave them anchored to a voided line, and settling them afterwards would reverse the same stock twice. Cancel those tickets first, then void.`);
      }

      const acceptedLines = (db.prepare(
        `SELECT COUNT(*) AS n FROM goods_receipt_note_items WHERE grn_id = ? AND quantity_accepted <> 0`
      ).get(id) as any)?.n || 0;
      const linkedPurchases = (db.prepare(
        `SELECT COUNT(*) AS n FROM purchases WHERE grn_id = ?`
      ).get(id) as any)?.n || 0;
      if (acceptedLines !== linkedPurchases) {
        throw new GrnRefused(409,
          linkedPurchases === 0
            ? `${grn.grn_number} has ${acceptedLines} accepted line(s) but no cost row carries its id, so the rows it wrote cannot be identified. This receipt predates purchases.grn_id; a destructive reversal will not guess from the note text. Correct the stock with an adjustment instead.`
            : `${grn.grn_number} has ${acceptedLines} accepted line(s) but ${linkedPurchases} linked cost row(s). Something else has already changed this receipt's cost rows; reversing a set that does not match the bill would corrupt the average. Investigate before voiding.`);
      }

      const orphanCost = (db.prepare(`
        SELECT COUNT(*) AS n FROM purchases p
        WHERE p.grn_id = ?
          AND NOT EXISTS (SELECT 1 FROM inventory_transactions it
                           WHERE it.type = 'purchase' AND it.reference_id = p.id)
      `).get(id) as any)?.n || 0;
      if (orphanCost > 0) {
        throw new GrnRefused(409,
          `${orphanCost} cost row(s) on ${grn.grn_number} have no stock movement behind them, so the quantity that actually entered stock is unknown for them. A reversal that guessed the quantity would be a fabricated adjustment.`);
      }

      // ── THE PO RAILS ARE PLANNED HERE AND WRITTEN AT STEP 5b — NO WRITES YET.
      // Deliberately AFTER THE CLAIM, so every ledger read inside it already
      // excludes this receipt (po-receipts.ts filters 'void' by construction)
      // and therefore measures the state the void is about to LEAVE rather than
      // the one it found — the completion test in particular is a subtraction
      // that only works that way round. And deliberately AFTER the four checks
      // above, for the reason stated at the top of this step. Its refusals — a
      // receipt keyed later, an unidentifiable vendor bill row, an
      // unattributable party deduction — throw exactly like the ones above and
      // roll the claim back with them.
      if (grn.po_id) poVoid = planPoReceiptVoid(db, grn);

      // ── 3. THE MOVEMENT SET, from the RECORDED rows. Never recomputed from
      //       accepted × pack_size: pack_size is mutable, so a recompute can
      //       subtract a different number than was added.
      //       SHARED WITH THE LINE AMENDMENT (@/lib/grn-reversal) — one
      //       derivation, so a per-line unwind can never disagree with a void
      //       about what this receipt actually moved.
      const moves = collectRecordedMoves(db, id);

      // ── 4. NEGATIVE-STOCK GUARD, on EVERY material, BEFORE any write.
      //       Balances are read fresh inside this transaction (the SELECT above
      //       runs under the write lock the claim took). Refuse the WHOLE void
      //       if any one material would go under — a partial reversal is exactly
      //       what a single transaction exists to prevent.
      //       ── THE REPLACEMENT TERM IS THE PARTY CREDIT, AND ONLY THAT ─────
      //       On an ad-hoc GRN the map is EMPTY, so every material's `new_in` is
      //       0 and the shared test reduces to exactly the one this handler has
      //       always applied: r6(current_stock − qty) < −EPS. The message and the
      //       `materials: string[]` payload are the ones it has always returned.
      //
      //       On a PO receipt whose void also reverses a party requisition, the
      //       two rails move the SAME materials in OPPOSITE directions: this
      //       reversal DEBITS what the receipt added, and the cascade reversal
      //       CREDITS back what the party consumed. Guarding the debit alone
      //       against a balance the party had already drawn down would refuse a
      //       void whose two halves cancel out exactly — the commonest shape
      //       there is, since the PO was raised to replenish that very
      //       requisition. `replacement` is precisely the "what this correction
      //       puts back" term the shared guard was built around, so the party
      //       credit goes in there and the test becomes the NET. The credit can
      //       never drive a balance negative on its own; it only ever makes this
      //       test kinder, and only by the amount actually recorded.
      const partyCredit = poVoid?.requisition.credit ?? new Map<string, number>();
      assertNoNegativeStock(moves, partyCredit, {
        code: 'would_go_negative',
        verb: 'reversed',
        // Message and payload are the void's OWN, verbatim — not the shared
        // helper's — so this refusal's wire shape is byte-for-byte what it was
        // before the reversal was extracted. `materials` stays a string[]; the
        // richer per-material breakdown the helper can build is deliberately NOT
        // added here, because a caller already rendering this response should not
        // have its payload change shape as a side effect of a refactor.
        // The party sentence is APPENDED only when there IS a party credit, so
        // the ad-hoc refusal is character-for-character unchanged.
        build: (blocked) => ({
          message:
            `Reversing ${grn.grn_number} would drive stock below zero for ${blocked.length} material(s): ${blocked.map(b => b.text).join('; ')}. The goods have already been consumed or issued, so the receipt cannot honestly be un-received. Nothing was changed.`
            + (partyCredit.size > 0
              ? ` This already counts the ${blocked.filter(b => b.new_in > 0).length} material(s) the party consumption would credit back.`
              : ''),
          payload: { materials: blocked.map(b => b.text) },
        }),
      });

      // ── 5. SNAPSHOT, then reverse — the shared helper, which takes the
      //       verbatim snapshot of the cost rows, the movements and the four
      //       price/stock fields (before_json is the ONLY copy once they are
      //       deleted), proves whose last_purchase_price this is before touching
      //       it, deletes by SUBQUERY rather than an IN list (a GRN with hundreds
      //       of lines can never hit SQLite's 999-variable ceiling), debits by the
      //       RECORDED quantity and re-derives LPP only where this bill owns it.
      //       Read @/lib/grn-reversal for the full reasoning behind each of those
      //       — it is the text that used to live here.
      //
      //       includeGrossCandidate ON THE PO BRANCH ONLY. last_purchase_price
      //       holds the GROSS bill rate on a PO receipt (receive/route.ts writes
      //       `price`, not `netPrice`) while purchases.unit_price is NET of the
      //       allocated discount, so the narrow ownership test — which compares
      //       only against the cost row — answers "cannot tell" and leaves the
      //       column alone. That is a fail-safe, not a correct answer: on a PO
      //       receipt this bill really does own the rate, and the flag lets the
      //       proof see the rate its writer actually used, then re-derives on the
      //       same GROSS basis. The ad-hoc branch stays FALSE so its shipped
      //       behaviour is byte-unchanged. The line amendment already passes true
      //       for exactly this case.
      const rev = reverseGrnMovement(db, { grnId: id, moves, includeGrossCandidate: !!grn.po_id });
      const txnRows = rev.transaction_rows;
      const purchaseRows = rev.purchase_rows;
      const matBefore = rev.material_snapshot;
      result.transactions_deleted = rev.transactions_deleted;
      result.purchases_deleted = rev.purchases_deleted;
      result.last_purchase_stale = rev.last_purchase_stale;
      result.last_purchase_kept = rev.last_purchase_kept;
      result.materials = rev.materials;

      // ── 5b. THE THREE PO RAILS THE STOCK REVERSAL CANNOT SEE ─────────────
      //        Release the vendor bill row (so the reopened order can take the
      //        SAME bill number in again — the whole point), put the order back
      //        to 'approved' with its ORDERED total, and reverse the requisition
      //        fulfilment including the party deduction. Every refusal these
      //        rails can raise was already raised at step 2, before a quantity
      //        moved; this call performs, it does not re-litigate.
      //        src/lib/po-void.ts carries the reasoning for each.
      if (poVoid) {
        poResult = applyPoReceiptVoid(db, poVoid, { actorEmail: me.email, grnNumber: String(grn.grn_number) });
      }

      // VERIFIED, NOT BEST-EFFORT — and of the two audit writes in this file
      // this is the one that must not be allowed to fail quietly. before_json
      // below is the ONLY copy of the purchases rows and the movements just
      // deleted, and the only record of the pre-reversal price fields. If the
      // insert is swallowed the reversal still commits: the cost rows are gone,
      // there is nothing to rebuild them from, and the response says success.
      // logAuditOrThrow turns that into a rollback.
      logAuditOrThrow(db, {
        event_type: 'grn.void',
        entity_type: 'goods_receipt_note',
        entity_id: id,
        actor_email: me.email,
        outlet_id: grn.outlet_id ?? null,
        before: {
          grn: {
            grn_number: grn.grn_number, date: grn.date, status: grn.status,
            vendor: grn.vendor, invoice_number: grn.invoice_number, invoice_date: grn.invoice_date,
            received_by: grn.received_by, outlet_id: grn.outlet_id ?? null,
          },
          materials: matBefore,
          purchases: purchaseRows,
          inventory_transactions: txnRows,
          // The released po_vendor_bills row and the order's pre-void state.
          // The bill row is DELETED by step 5b and this is its ONLY copy — the
          // same reason the purchases rows above are here.
          ...(poResult ? (poResult as PoVoidOutcome).before : {}),
        },
        after: {
          status: 'void', voided_by: me.email, void_reason: reason,
          purchases_deleted: result.purchases_deleted,
          transactions_deleted: result.transactions_deleted,
          stock_reversed: result.materials,
          ...(poResult ? {
            purchase_order: {
              id: (poResult as PoVoidOutcome).po_id,
              po_number: (poResult as PoVoidOutcome).po_number,
              status: (poResult as PoVoidOutcome).po_status,
              reopened: (poResult as PoVoidOutcome).po_reopened,
              total_cost: (poResult as PoVoidOutcome).po_total_cost,
              total_restamped: (poResult as PoVoidOutcome).po_total_restamped,
              received_at_cleared: (poResult as PoVoidOutcome).received_at_cleared,
              grn_id: poVoid?.surviving_grn_id ?? null,
              // The lines this void left with no live claim — the reason the
              // order did or did not reopen, recorded rather than re-derivable:
              // a later re-receive gives those lines new claims and the question
              // can never be asked of the data again.
              orphaned_po_item_ids: poVoid?.orphaned_po_item_ids ?? [],
              held_siblings: poVoid?.held_siblings ?? 0,
            },
            bill_released: (poResult as PoVoidOutcome).bill_released,
            bill_matched_by: (poResult as PoVoidOutcome).bill_matched_by,
            requisition: (poResult as PoVoidOutcome).requisition,
          } : {}),
        },
        note: `Voided ${grn.grn_number}${reason ? ` — ${reason}` : ''}. Reversed ${result.materials.length} material(s); deleted ${result.purchases_deleted} cost row(s) and ${result.transactions_deleted} stock movement(s). Header and line items kept.`
          + (poResult ? poVoidNote(poResult) : ''),
      }, 'the reversal (this row is the only copy of the deleted cost rows and stock movements)');
    });
    txn();

    // ── 6. AFTER THE COMMIT: the weighted average and the recipe cascade.
    //       updateMaterialPrice does its own writes and cascades into every
    //       sub-recipe and recipe, so it must not run inside the transaction
    //       above. Materials left with NO surviving purchase row are detected
    //       BEFORE the call and reported: updateMaterialPrice leaves
    //       average_price untouched in that case (`if (sameMonth.total_qty > 0)`
    //       / `if (latest)`), so the voided bill's price silently stands and the
    //       caller has to be told rather than shown a clean success.
    //
    //  PAST THIS LINE THE VOID HAS COMMITTED, so NOTHING here may surface as a
    //  failure. It used to: a SQLITE_BUSY out of updateMaterialPrice (this route
    //  raised exactly that under contention) fell through to the catch and
    //  returned `500 Void failed` on a void that had happened — an admin who
    //  believes a void failed corrects it by hand, on top of the reversal that
    //  already landed. The averages are recoverable (the next purchase re-derives
    //  them, and updateMaterialPrice can be re-run); a duplicated manual
    //  correction is not. So this phase reports through `warnings`, per material,
    //  and the response still says the void succeeded — because it did.
    const priceWarnings: string[] = [];
    for (const m of result.materials) {
      try {
        const remaining = (db.prepare(`SELECT COUNT(*) AS n FROM purchases WHERE material_id = ?`)
          .get(m.material_id) as any)?.n || 0;
        if (remaining === 0) result.average_price_stale.push({ material_id: m.material_id, material_name: m.material_name });
        updateMaterialPrice(db, m.material_id);
      } catch (e: any) {
        console.error('[grn DELETE/void] post-commit price refresh failed', m.material_id, e);
        priceWarnings.push(
          `${m.material_name}: the weighted average could not be re-derived after the reversal (${e?.message || 'unknown error'}). The stock WAS reversed — do not void or adjust again; the next purchase of this material will correct its average.`
        );
      }
    }
    if (result.average_price_stale.length > 0) {
      // Best-effort ON PURPOSE, unlike the two writes inside the transactions:
      // this note is a follow-up about a price field, the reversal it annotates
      // is already recorded in grn.void, and there is no longer a transaction to
      // roll back. Losing it must not turn a committed void into an error.
      logAuditEvent(db, {
        event_type: 'grn.void.price_stale',
        entity_type: 'goods_receipt_note',
        entity_id: id,
        actor_email: me.email,
        outlet_id: grn.outlet_id ?? null,
        after: { materials: result.average_price_stale },
        note: 'No purchase rows remain for these materials, so the weighted average still carries the voided bill\'s price. Nothing stores the pre-receipt average; it must be corrected by hand or by the next real purchase.',
      });
    }

    // Also post-commit, so also guarded: the void does not become a 500 because
    // the read-back of its own row lost a race for the lock.
    let after: any = null;
    try { after = db.prepare('SELECT * FROM goods_receipt_notes WHERE id = ?').get(id) as any; } catch { /* reported below */ }
    const poNotice = poResult ? poVoidNote(poResult).trim() : '';
    return Response.json({
      success: true,
      voided: true,
      grn_number: grn.grn_number,
      voided_by: after?.voided_by || me.email,
      voided_at: after?.voided_at || null,
      void_reason: after?.void_reason ?? reason,
      stock_reversed: result.materials,
      purchases_deleted: result.purchases_deleted,
      transactions_deleted: result.transactions_deleted,
      average_price_stale: result.average_price_stale,
      last_purchase_stale: result.last_purchase_stale,
      last_purchase_kept: result.last_purchase_kept,
      warnings: priceWarnings,
      // ── THE PO RAILS, ADDITIVE ────────────────────────────────────────────
      // Absent on an ad-hoc void (poResult is null, so every key below is
      // undefined and JSON drops it) — the shipped ad-hoc response shape is
      // byte-unchanged.
      po_number:      poResult ? (poResult as PoVoidOutcome).po_number : undefined,
      po_status:      poResult ? (poResult as PoVoidOutcome).po_status : undefined,
      po_reopened:    poResult ? (poResult as PoVoidOutcome).po_reopened : undefined,
      po_total_cost:  poResult ? (poResult as PoVoidOutcome).po_total_cost : undefined,
      po_total_restamped: poResult ? (poResult as PoVoidOutcome).po_total_restamped : undefined,
      bill_released:  poResult ? (poResult as PoVoidOutcome).bill_released : undefined,
      requisition_reversed: poResult ? ((poResult as PoVoidOutcome).requisition?.unfulfilled ?? false) : undefined,
      party_stock_restored: poResult ? ((poResult as PoVoidOutcome).requisition?.stock_restored ?? []) : undefined,
      /** Party movements another rail booked, deliberately left standing. On the
       *  wire so the modal can never imply the void examined and reversed them. */
      party_stock_left_intact: poResult ? ((poResult as PoVoidOutcome).requisition?.party_rows_left_intact ?? 0) : undefined,
      notice: [
        'The bill document is kept — header and line items are unchanged; only the stock and cost rows were reversed.',
        poNotice,
        // ── A HELD RECEIPT VOIDS TO A CLEAN ZERO, AND THAT IS NOT A FAILURE ──
        // A GRN the kitchen QC gate was still holding never moved stock and
        // never wrote a cost row, so the reversal above legitimately finds
        // nothing: 0 materials, 0 purchases, 0 movements. Said out loud because
        // "reversed 0 material(s)" on an admin's screen otherwise reads as the
        // void having silently failed, and the correction for that belief is
        // another manual adjustment on top of a receipt that never landed.
        // It also takes the receipt out of the Pending Quality Checks queue for
        // good: the sign-off's claim matches only status = 'awaiting_qc', so a
        // voided receipt can never be signed and QC can never un-void one.
        String(grn.status) === 'awaiting_qc'
          ? 'This receipt was still waiting for a quality check, so no stock had ever been added and there was nothing to reverse. It has left the Pending Quality Checks queue and can no longer be signed off.'
          : '',
        result.average_price_stale.length
          ? `${result.average_price_stale.length} material(s) have no purchases left, so their weighted average still carries this bill's price — correct it by hand or with the next purchase.`
          : 'Weighted averages were re-derived from the surviving purchases.',
        result.last_purchase_kept.length
          ? `${result.last_purchase_kept.length} material(s) kept their existing last-purchase rate — it came from a different receipt, not from this bill.`
          : '',
        'Valuations already taken at the old average (closing stock, department variance, party consumption, production batches) are historical and were NOT rewritten.',
      ].filter(Boolean).join(' '),
    });
  } catch (e: any) {
    if (e instanceof GrnRefused) {
      // `code` is ADDITIVE and appended, never inserted: the refusals raised in
      // this file have always carried no code, so the key is `undefined` for
      // them and JSON drops it — the shipped wire shape of every existing
      // refusal is unchanged. The PO refusals DO carry one, because the void
      // modal now has to branch (a later-receipt refusal offers "void that one
      // first"; an unidentifiable bill row offers nothing but a person). PATCH
      // in this same file already returns `code` for exactly this reason.
      return Response.json({ error: e.message, refused: true, code: e.code, ...(e.payload || {}) }, { status: e.httpStatus });
    }
    console.error('[grn DELETE/void]', e);
    return Response.json({ error: e?.message || 'Void failed' }, { status: 500 });
  }
}
