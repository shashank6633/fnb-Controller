import type Database from 'better-sqlite3';
import { generateId, logAuditEvent } from './db';
import { GrnRefused, logAuditOrThrow, r6 } from './grn-reversal';
import {
  postCentralTxn, deptParty, PARTY_TRANSFER_TYPE, PARTY_TRANSFER_TYPES_SQL,
} from '@/lib/movement-record';
import {
  checkCentralIssue, recordPartyShelfTake, stampShelfClose, centralShelfEmpty, markLedgerShelfClose,
} from '@/lib/issue-stock';
import { qtyGrid } from '@/lib/central-debit-clamp';

/* ══════════════════════════════════════════════════════════════════════════
 * THE PO → REQUISITION FULFIL CASCADE, IN ONE PLACE.
 *
 * SERVER ONLY. Call INSIDE the caller's db.transaction(): it writes
 * requisitions, raw_materials.current_stock and inventory_transactions, and
 * those must commit or roll back with the decision that triggered them.
 *
 * ── WHY IT MOVED HERE ──────────────────────────────────────────────────────
 * It used to live inline at the end of POST /api/purchase-orders/[id]/receive,
 * gated on `po.requisition_id && isComplete`. The kitchen QC gate broke that
 * single trigger in two: a PO can now be COMPLETE on the receipt ledger (every
 * line has a GRN row) while its goods are still sitting in 'awaiting_qc' and no
 * stock has been credited. Firing the party branch there would DEDUCT stock
 * that was never added — taking the goods out of some other receipt's balance.
 *
 * So the cascade now fires from whichever of the two places is LAST:
 *   · POST …/receive          — when the PO completes and NO GRN of it is held
 *   · decideGrnQc (grn-qc.ts) — when a sign-off clears the LAST held GRN of a
 *                               complete PO
 * One helper, two callers, one behaviour. Copying it would have been two
 * behaviours the day one of them was edited.
 *
 * ── THE BODY WAS LIFTED VERBATIM, AND HAS SINCE GAINED THE CENTRAL FLOOR ───
 * It came from receive/route.ts with only three names rewritten —
 * po.requisition_id → requisitionId, po.outlet_id → poOutletId,
 * receivedByEmail → actorEmail. The effective-qty rule and the average_price
 * basis are still exactly as they were; they are load-bearing and are
 * documented in place below.
 *
 * ONE THING IS NO LONGER VERBATIM: the party debit is now bounded, and its
 * hand-rolled pack factor is gone in favour of the shared one. The debit ran as
 * a bare `current_stock = current_stock - ?` with no balance read, so this
 * cascade could drive central negative with NO STOREKEEPER ANYWHERE IN THE
 * STORY (measured: a party line of 9 against a balance of 0 → −9, status
 * fulfilled). See THE UNATTENDED-PATH JUDGEMENT at the clamp below, which is
 * why this route CLAMPS where the two issue desks THROW.
 *
 * ── IT IS ITS OWN REPLAY GUARD ─────────────────────────────────────────────
 * Two guards, both pre-existing:
 *   · the requisitions UPDATE is `WHERE … AND status = 'store_processed'`, so a
 *     second call moves nothing, and `willFulfill` is read BEFORE it — a second
 *     caller sees 'fulfilled', not 'store_processed', and skips the party
 *     branch entirely;
 *   · the party branch additionally probes inventory_transactions for an
 *     existing party transfer row on this requisition (type 'party_issue',
 *     or the legacy 'party_consumption') and logs a skip.
 * Do not add a third; these two already make the double-call safe, which is
 * exactly what two callers require.
 * ══════════════════════════════════════════════════════════════════════════ */

export interface RequisitionCascadeInput {
  requisitionId: string;
  /** The PO's outlet — the fallback stamp when the requisition has none. */
  poOutletId: string | null;
  /** Who is credited in the audit trail: the receiver, or the QC signer. */
  actorEmail: string;
}

export function fulfilRequisitionFromPo(
  db: Database.Database,
  { requisitionId, poOutletId, actorEmail }: RequisitionCascadeInput,
): void {
  if (!requisitionId) return;
  const reqRow = db.prepare(`SELECT * FROM requisitions WHERE id = ?`).get(requisitionId) as any;
  const willFulfill = reqRow && reqRow.status === 'store_processed';
  db.prepare(`
    UPDATE requisitions
    SET status = 'fulfilled', fulfilled_at = datetime('now'), fulfilled_by = ?, updated_at = datetime('now')
    WHERE id = ? AND status = 'store_processed'
  `).run('po-received-cascade', requisitionId);

  // Party requisition fulfilled via PO-receive cascade — deduct now.
  // (Internal requisitions remain audit-only and never enter this branch.)
  if (willFulfill && reqRow.purpose === 'party') {
    // MATCHES BOTH NAMES, PERMANENTLY. This guard's whole job is to see rows
    // the OTHER rail (applyPartyFulfillment) wrote — same reference_id, same
    // shape. The type was renamed 'party_consumption' → 'party_issue' on
    // 2026-09-17; a row that escaped the migration, or an older backup, still
    // means the goods have already left central. Narrow it to one name and this
    // cascade deducts the same stock a second time. See PARTY_TRANSFER_TYPES.
    const already = db.prepare(`
      SELECT 1 FROM inventory_transactions
      WHERE reference_id = ? AND type IN (${PARTY_TRANSFER_TYPES_SQL})
      LIMIT 1
    `).get(requisitionId);
    if (already) {
      logAuditEvent(db, {
        event_type: 'requisition.party_consumption.skipped',
        entity_type: 'requisition',
        entity_id: requisitionId,
        actor_email: actorEmail,
        after: { reason: 'already_deducted' },
        note: 'Party consumption skipped — inventory_transactions row already exists',
      });
    } else {
      const reqItems = db.prepare(`
        -- No last_purchase_price here on purpose. That column is stored in
        -- MIXED bases (some rows ₹/purchase-unit, some already ₹/recipe-unit),
        -- so it cannot be normalised by any formula. average_price is the
        -- sanctioned single-basis rate — see src/lib/closing-valuation.ts and
        -- src/app/api/department-variance/route.ts:620-622.
        SELECT ri.*, rm.name AS material_name, rm.average_price,
               rm.unit AS rm_unit, rm.purchase_unit AS rm_purchase_unit,
               COALESCE(rm.pack_size, 1) AS rm_pack_size
        FROM requisition_items ri
        JOIN raw_materials rm ON rm.id = ri.material_id
        WHERE ri.req_id = ?
          -- A line the chef or the store REFUSED never leaves the store, so
          -- it can never be consumed. Without this filter a rejected line
          -- still carried its quantity_requested into the fallback below.
          AND COALESCE(ri.is_rejected, 0) = 0
          AND COALESCE(ri.store_rejected, 0) = 0
      `).all(requisitionId) as any[];
      const decStock = db.prepare(`
        UPDATE raw_materials SET current_stock = current_stock - ?, updated_at = datetime('now')
        WHERE id = ?
      `);
      // The raw INSERT that stood here is now postCentralTxn at the call site,
      // so a party draw on central names the department it went to, the event's
      // own date and the person whose action cascaded it.
      // The consumption belongs to the requisition's outlet (PO's as a
      // fallback); an unstamped row is backfilled to the DEFAULT outlet.
      const partyOutletId = reqRow.outlet_id || poOutletId || null;
      const partyNote = `Party: ${reqRow.event_name || '(unnamed)'} @ ${reqRow.event_date || ''}`.trim();
      const auditItems: any[] = [];
      // Every line this cascade could NOT satisfy in full, for the audit row
      // below. See THE UNATTENDED-PATH JUDGEMENT at the clamp.
      const shortfalls: Array<{
        req_item_id: string; material_id: string; material_name: string;
        reason: string; wanted_recipe: number; issued_recipe: number;
        short_recipe: number; central_stock_recipe: number;
      }> = [];
      // Lines the shelf rule resolved to the balance, corrected to what left the
      // shelf (round 7) — see THE LINE RECORDS WHAT LEFT THE SHELF below.
      const shelfRecorded: Array<{
        req_item_id: string; material_id: string; material_name: string; line_unit: string;
        asked_line_qty: number; recorded_line_qty: number; debit_recipe: number;
      }> = [];
      let totalCost = 0;
      for (const it of reqItems) {
        /* EFFECTIVE QTY — the house rule (store-issue/route.ts, dept-stock,
           party-approvals): what the chef APPROVED, falling back to what was
           requested only when no approval was recorded. The old fallback was
           raw quantity_requested, so a line the chef trimmed 10 → 4, or
           rejected outright, still deducted 10 — and once the pack factor
           below was applied that became 7,500 ml of a material nobody
           released. Cap at the approved figure and this cannot recur. */
        const effApproved = (it.chef_approved_qty != null
          ? Number(it.chef_approved_qty)
          : Number(it.quantity_requested)) || 0;
        const issuedReq = Math.min(Number(it.quantity_issued) || effApproved, effApproved);
        if (issuedReq <= 0) continue;

        /* ── THE UNATTENDED-PATH JUDGEMENT ──────────────────────────────────
           THIS ROUTE CLAMPS. The two issue desks THROW, and the difference is
           deliberate: it is about whether there is a human being to read a
           refusal.

           applyPartyFulfillment runs with a storekeeper at the counter, mid
           hand-over, inside a request he just made. Throwing there unwinds HIS
           gesture, puts the sentence on HIS screen and he fixes the stock. That
           is the right answer and it is what that rail does.

           NOBODY IS HERE. This cascade fires from a purchase-order receipt or a
           GRN QC sign-off (receive/route.ts:1930, grn-qc.ts:2043) — a delivery
           that has physically arrived and been counted, or a chef signing off
           perishables. The party requisition is a BYSTANDER to that
           transaction. A throw would roll the whole receipt back, so:
             · goods that are on the premises would be recorded as not received,
             · the QC signature would vanish,
             · the refusal would be addressed to a person who is not there,
             · and the thing actually at fault — a short party line on some
               other material — would be nowhere on screen.
           Destroying a correct delivery to prevent a bad party debit is a worse
           outcome than the debit, and it fails closed on the wrong transaction.

           SO BOTH OF THE OWNER'S REQUIREMENTS ARE MET WITHOUT A THROW:
             1. central must not silently go negative → the debit is clamped to
                what central actually holds, so the floor still holds absolutely.
                Never more, never below zero.
             2. he must be able to SEE what could not be satisfied → every
                clamped or skipped line is recorded in audit_events as
                'requisition.party_consumption.short', naming the material, what
                was wanted, what moved and what is missing. The word "silently"
                is the part this removes; the arithmetic is the part the clamp
                removes.

           A CLAMPED LINE IS PERMANENT, WHICH IS WHY THE RECORD IS NOT OPTIONAL.
           Both party rails treat ONE party transfer row on the requisition as
           proof the whole transfer happened, so a short line will not be topped
           up on a later call by either of them. The audit row is the only thing
           that will ever say so.

           THE VOID STAYS CORRECT FOR FREE. reverseRequisitionFulfilFromPo
           credits back ABS(the stored inventory_transactions.quantity) and never
           recomputes (see its header), so it reverses exactly the clamped figure
           that was written. A line clamped to zero writes no row at all — the
           same shape as the pre-existing `issuedReq <= 0` skip — and the void's
           own 'party_row_shape' guard, which refuses a zero or positive row,
           therefore still never sees one. */
        const c = checkCentralIssue(db, {
          reqItemId: String(it.id),
          beforeLineQty: 0,
          afterLineQty: issuedReq,
          rail: 'party',
        });

        // The two carve-outs the internal floor respects, honoured here too, and
        // gating BOTH the debit and the cost line. store_mapped = the material's
        // balance lives on the TGBCL store ledger, not in central (95 of the 127
        // store-mapped materials hold a central balance of 0, so a party draw on
        // one went straight below zero). unit_review = ri.unit is blank or
        // unrecognised on a PACKED material, so the old CASE above silently
        // guessed recipe units where dept-stock reads the same blank as the
        // purchase basis — a 750x fork decided by which screen you opened.
        if (!c.debits) {
          shortfalls.push({
            req_item_id: String(it.id), material_id: String(it.material_id),
            material_name: String(it.material_name || ''),
            reason: c.skipReason || 'zero_delta',
            wanted_recipe: 0, issued_recipe: 0, short_recipe: 0,
            central_stock_recipe: c.centralStockRecipe,
          });
          continue;
        }

        // ri.unit → RECIPE units. Requisition quantities are stored in the
        // LINE's OWN unit (option B), so a "2 BTL" line is TWO BOTTLES —
        // deducting it verbatim took 2 ml off stock instead of 1,500 ml and
        // wrote a −2 party transfer row. THE FACTOR IS THE FLOOR'S OWN: the
        // hand-rolled CASE that stood here is gone, so the quantity weighed
        // against the balance and the quantity taken off it are one number and
        // cannot drift. Proved a no-op on quantity across all 16,353 live
        // requisition lines (identical factor on 16,350; the other 3 are the
        // blank-unit packed lines both now refuse instead of guessing).
        const wanted = c.requestedRecipe;          // RECIPE units
        // THE CLAMP IS THE RULE'S OWN FIGURE. debitRecipe comes from
        // planCentralDebit (src/lib/central-debit-clamp.ts), the one rule every
        // central floor shares: when the line fits it is the ask (or, on an ask
        // of "everything", the balance itself, so the write lands on exactly 0);
        // when it does not fit it is max(0, balance) — the clamp. Never more than
        // the raw stored balance, so a rounding step can never hand out a
        // fraction more than is physically there. This used to be a local
        // min(wanted, 6-dp allowance, balance) with its own 1e-9 test, which
        // logged a "short" of 0.0000004 against an ask the floor had accepted.
        const issued = Math.max(0, c.debitRecipe);
        if (!c.ok || issued <= 0) {
          shortfalls.push({
            req_item_id: String(it.id), material_id: String(it.material_id),
            material_name: String(it.material_name || ''),
            reason: 'central_stock_short',
            wanted_recipe: wanted, issued_recipe: issued,
            short_recipe: Math.round((wanted - issued) * 1e6) / 1e6,
            central_stock_recipe: c.centralStockRecipe,
          });
        }
        // Nothing issuable at all writes NO movement row, exactly as the
        // `issuedReq <= 0` skip above does — a zero-quantity party row would be
        // a movement that did not happen, and the void refuses rows of that shape.
        if (issued <= 0) continue;

        // ── THE LINE RECORDS WHAT LEFT THE SHELF (round 7) ──────────────────
        // The rule above can FIT a line by taking the balance instead of its
        // figure — the shown-figure rule: two party lines of 10 + 4.843 kg over
        // 14,842.5 g, the second takes 4,842.5 g. The movement row and the
        // consumption audit always carried that; the line kept 4.843 kg, the
        // issue ledger 4,843 g, and nothing named the half gram (measured: no
        // .short row — rightly, nothing was short). The contract in
        // src/lib/central-debit-clamp.ts is that a caller whose debit is not the
        // ask records the debit, so the line is corrected to recordAfterLineQty,
        // the floor's own figure (recordPartyShelfTake, shared with the desks'
        // party rail). Only on a FIT: a clamped line (!c.ok) is a shortfall and
        // goes on the .short row as before. Only when the line itself carried
        // the figure weighed — a line issued nothing is weighed at its approved
        // quantity, and that is not this line's record to rewrite.
        if (c.ok && c.recordAfterLineQty !== issuedReq
            && recordPartyShelfTake(db, {
              reqItemId: String(it.id), askedLineQty: issuedReq,
              recordLineQty: c.recordAfterLineQty, actor: actorEmail || 'system:po-requisition-fulfil',
            })) {
          shelfRecorded.push({
            req_item_id: String(it.id), material_id: String(it.material_id),
            material_name: String(it.material_name || ''), line_unit: String(it.unit ?? ''),
            asked_line_qty: issuedReq, recorded_line_qty: c.recordAfterLineQty, debit_recipe: issued,
          });
        }
        decStock.run(issued, it.material_id);
        // THE RULE'S MEMORY (round 8) — a record, not a movement: when this take
        // emptied the shelf and the line (as corrected above) owes less than one
        // printed step, the line is stamped complete (stampShelfClose), so the
        // Issue Log and both desks read the line this cascade fulfilled as done.
        // It moves nothing, credits nothing and decides no status — the
        // cascade's own behaviour (what it debits, what it does not credit, the
        // fulfilled stamp above) is exactly as it was.
        // The ledger row carrying the line's figure keeps the fact as history
        // (round 8b, markLedgerShelfClose) — still a record, nothing moves.
        if (stampShelfClose(db, String(it.id), centralShelfEmpty(db, String(it.material_id))).byShelf) {
          markLedgerShelfClose(db, String(it.id));
        }
        // MOVEMENT RECORD: the party's draw on central. The destination was
        // implicit in the type; it is now the requisition's own department when
        // one is named, and the party sink otherwise.
        //
        // TYPED 'party_issue' SINCE 2026-09-17, and it MUST move in lockstep
        // with party-fulfillment.ts's write. The two rails produce an
        // identically shaped row on the same reference_id and each rail's guard
        // exists to see the OTHER rail's rows: rename one write and leave the
        // other, and the two rails write two different types for one event.
        postCentralTxn(db, {
          materialId: it.material_id,
          type: PARTY_TRANSFER_TYPE,
          quantity: -issued,
          referenceId: requisitionId,
          notes: partyNote,
          outletId: partyOutletId,
          counterparty: reqRow.department_id
            ? deptParty(db, String(reqRow.department_id))
            : { kind: 'consumption', name: partyNote },
          txnDate: reqRow.event_date || undefined,
          actor: actorEmail || 'system:po-requisition-fulfil',
        });
        /* BOTH SIDES OF THIS MULTIPLICATION ARE ON THE RECIPE BASIS.
           LEFT  — `issued` is RECIPE units (ml/g): issuedReq is in the LINE's
                   own unit and the shared pack factor applied by
                   checkCentralIssue above lifted a purchase-unit line into
                   recipe units (it is `c.requestedRecipe`, possibly clamped).
           RIGHT — raw_materials.average_price is ₹ per RECIPE unit by canon,
                   so it needs NO pack conversion. Dividing it by the pack size,
                   or multiplying it up, would break the trio.
           It used to read last_purchase_price / pack_size here. That column is
           stored in MIXED bases: of the 190 packed materials that hold both a
           stored LPP and a purchase history, 71 are ALREADY ₹/recipe-unit, so
           the divide fired a second time — MALA STRAWBERRY CRUSH 5 LTR
           (ml/BTL, pack 5000, avg ₹0.13482/ml) logged ₹0.13 for a full bottle
           instead of ₹674.10, and `lppRecipe || average_price` short-circuited
           on that non-zero wrong value so the correct rate on the same row was
           never reached. average_price is the sanctioned rate for a
           recipe-unit quantity (src/lib/closing-valuation.ts ladder). */
        const unitCost = Number(it.average_price) || 0;   // ₹ / RECIPE unit
        const lineCost = Math.round(issued * unitCost * 100) / 100;
        totalCost += lineCost;
        auditItems.push({
          material_id: it.material_id,
          material_name: it.material_name,
          quantity: issued,
          unit_cost: unitCost,
          line_cost: lineCost,
          // Stated on the line itself as well as in the shortfall event below,
          // so the consumption record cannot read as a full hand-over when the
          // clamp reduced it. Only present when it actually bit — `!c.ok`, the
          // rule's own verdict (round 7). A FIT that took the balance by the
          // shown figure (4,842.5 g for 4.843 kg typed) is not a shortfall and
          // must not read as one: it carries the typed figure as
          // asked_quantity instead, beside the quantity that moved, and the line
          // itself now records that quantity (above).
          ...(!c.ok && issued < wanted - 1e-9
            ? { requested_quantity: wanted, short_quantity: Math.round((wanted - issued) * 1e6) / 1e6 }
            : c.ok && qtyGrid(issued) !== qtyGrid(wanted)
              ? { asked_quantity: wanted }
              : {}),
        });
      }
      logAuditEvent(db, {
        event_type: 'requisition.party_consumption',
        entity_type: 'requisition',
        entity_id: requisitionId,
        actor_email: actorEmail,
        after: { items: auditItems, total_cost: Math.round(totalCost * 100) / 100 },
        note: partyNote,
      });
      // WHAT COULD NOT BE SATISFIED, ON ITS OWN ROW. Written only when the clamp
      // or a carve-out bit, so an ordinary cascade is byte-identical to before.
      //
      // IT IS A THIRD, SEPARATE EVENT TYPE ON PURPOSE. cascadeDeductionWitness
      // below decides what a void may undo from exactly two names —
      // 'requisition.party_consumption' and '…​.skipped' — and the event above is
      // still written whenever this branch ran, so the witness answers 'deducted'
      // exactly as it did before and this row cannot change its mind. It is a
      // report to the owner, not a discriminator; do NOT add it to that IN list.
      if (shortfalls.length > 0) {
        logAuditEvent(db, {
          event_type: 'requisition.party_consumption.short',
          entity_type: 'requisition',
          entity_id: requisitionId,
          actor_email: actorEmail,
          after: {
            reason: 'central_floor',
            lines: shortfalls,
            moved_lines: auditItems.length,
          },
          note: `${partyNote} — ${shortfalls.length} line(s) could not be issued in full from central: `
            + shortfalls.map(s => `${s.material_name || s.material_id} (${s.reason})`).join(', '),
        });
      }
      // THE LINES THE SHELF RULE CORRECTED, on the same row the desks' party
      // rail writes (party-fulfillment.ts). A fourth event type, and like the
      // .short row a report to the owner, NOT a discriminator: do not add it to
      // cascadeDeductionWitness's IN list. Written only when a line was
      // corrected, so an ordinary cascade is byte-identical.
      if (shelfRecorded.length > 0) {
        logAuditEvent(db, {
          event_type: 'requisition.party_transfer.shelf',
          entity_type: 'requisition',
          entity_id: requisitionId,
          actor_email: actorEmail,
          after: { lines: shelfRecorded, source: 'po_cascade' },
          note: `${partyNote} — the purchase-order cascade took what the central store held on `
            + `${shelfRecorded.length} line(s) typed at the store's shown figure; each line now records what left `
            + `the shelf (the typed figure is kept as asked): `
            + shelfRecorded.map(r => `${r.material_name || r.material_id} ${r.asked_line_qty} → ${r.recorded_line_qty}`
              + `${r.line_unit ? ` ${r.line_unit}` : ''}`).join(', '),
        });
      }
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * THE INVERSE — WHEN THE RECEIPT THAT FIRED THE CASCADE IS VOIDED.
 *
 * It lives in THIS file, directly under the forward, for the same reason the
 * forward was extracted: two triggers, one behaviour. A reversal written in the
 * void's own route would be a second reading of what the cascade did, and the
 * day someone changes the effective-qty rule or the pack factor above, only one
 * of the two would learn about it.
 *
 * WHAT THE FORWARD DID, AND SO WHAT THIS UNDOES:
 *   1. requisitions: store_processed → fulfilled, stamping fulfilled_at and
 *      fulfilled_by = 'po-received-cascade'.
 *   2. purpose='party' ONLY: per non-rejected line, current_stock -= issued and
 *      an inventory_transactions row (type 'party_issue' — 'party_consumption'
 *      on rows written before 2026-09-17, which is why every predicate in this
 *      file matches both — quantity
 *      = −issued, reference_id = the requisition).
 *
 * ── THE PROVENANCE TRAP, WHICH IS THE REAL HAZARD HERE ────────────────────
 * TWO writers produce an IDENTICALLY SHAPED party transfer row keyed on the
 * same reference_id: this cascade, and applyPartyFulfillment()
 * (src/lib/party-fulfillment.ts, called from store-issue and store-process).
 * Same type, same reference_id, same negative quantity, same
 * `Party: <event> @ <date>` note. NOTHING ON THE ROW SAYS WHICH RAIL WROTE IT,
 * and deleting blindly would credit back stock this PO never caused to move.
 *
 * So three discriminators are read before a single row is touched, and where
 * they cannot agree the void is REFUSED:
 *   · requisitions.fulfilled_by = 'po-received-cascade' — that literal is
 *     written nowhere else in the codebase; it is this cascade's signature. It
 *     proves the cascade FULFILLED the requisition. It does NOT prove the
 *     cascade DEDUCTED anything: see the third one.
 *   · NO department_material_transactions row of type 'received' carrying this
 *     requisition as reference_id. applyPartyFulfillment credits the department
 *     alongside the store deduction (party-fulfillment.ts:126-138); this cascade
 *     writes NEITHER. A dept 'received' row is therefore positive proof the
 *     other rail ran. It is NOT proof of the converse — that write is guarded
 *     `if (deptId)`, so its absence proves nothing.
 *   · THE CASCADE'S OWN AUDIT ROW, which is the only positive evidence of what
 *     the forward actually did. See cascadeDeductionWitness below. The forward
 *     stamps its signature UNCONDITIONALLY and only then checks whether party
 *     rows already exist (:61-75); when they do it deducts NOTHING and writes
 *     'requisition.party_consumption.skipped'. Without reading that, a signature
 *     over another rail's party rows looked exactly like our own deduction —
 *     which meant a reachable void was refused for ever as "both rails" (a dead
 *     end for the very correction this feature exists to provide), and, one
 *     falsy department_id away, a credit for goods this receipt never moved.
 *

 * ── AND IT REVERSES BY THE RECORDED QUANTITY, NEVER A RECOMPUTE ───────────
 * Exactly the doctrine reverseGrnMovement follows: credit back ABS(the stored
 * inventory_transactions.quantity). Recomputing issued × pack factor would
 * subtract a different number than was added the moment pack_size is edited —
 * and pack_size is mutable, which is the whole reason the unit-audit lock
 * exists.
 *
 * ── THE REPLAY GUARDS ARE THE FORWARD'S, MIRRORED — NOT NEW ONES ──────────
 *   · the demotion is `WHERE id = ? AND status = 'fulfilled' AND fulfilled_by =
 *     'po-received-cascade'`, so a second call moves nothing, and `willUnfulfil`
 *     is read BEFORE it exactly as `willFulfill` is above;
 *   · the party branch acts only on rows that are actually THERE, which is the
 *     same probe the forward uses to decide it has already run.
 * A double void cannot credit twice — and cannot even reach here, because the
 * GRN void's own conditional claim refuses the second call first.
 * ══════════════════════════════════════════════════════════════════════════ */

/** WHERE THE PARTY DEDUCTION CAME FROM. The forward stamps this literal and
 *  nothing else in the codebase writes it. */
export const PO_CASCADE_ACTOR = 'po-received-cascade';

/** What the forward's own audit trail says it did on this requisition.
 *  'deducted' — it wrote the party movements; 'skipped' — it wrote none because
 *  another rail had already booked them; 'unknown' — no audit row either way
 *  (a pre-audit row, or an insert that was swallowed), in which case the two
 *  older discriminators decide, exactly as they did before. */
type CascadeWitness = 'deducted' | 'skipped' | 'unknown';

export interface RequisitionUndoPlan {
  requisition_id: string;
  purpose: string;
  /** true iff this void will demote the requisition back to 'store_processed'. */
  willUnfulfil: boolean;
  /** true iff it will ALSO delete the party movements and credit their stock
   *  back. FALSE with willUnfulfil TRUE is a real and correct outcome: the
   *  cascade fulfilled the requisition but deducted nothing, so only the
   *  fulfilment is undone. */
  reverseParty: boolean;
  /** The party transfer rows about to be deleted — verbatim, the only copy.
   *  EMPTY when reverseParty is false, even where rows exist on the ledger. */
  partyRows: any[];
  /** Party movements deliberately LEFT STANDING because another rail booked
   *  them. Reported so the response never implies this void examined nothing. */
  partyRowsLeftIntact: number;
  /** What the forward's audit trail says it did — carried for the audit row. */
  witness: CascadeWitness;
  /** material_id → RECIPE units this reversal will CREDIT BACK.
   *  Feed it to assertNoNegativeStock as `replacement`: the receipt reversal
   *  debits and this credits, and the guard's whole job is the NET of the two. */
  credit: Map<string, number>;
  /** Names for the messages, resolved once. */
  materialNames: Map<string, string>;
}

/**
 * DID THE FORWARD ACTUALLY DEDUCT, OR DID IT SKIP? — the discriminator the
 * signature alone cannot give.
 *
 * 'requisition.party_consumption' and 'requisition.party_consumption.skipped'
 * are written by fulfilRequisitionFromPo above and BY NOTHING ELSE in the
 * codebase (applyPartyFulfillment writes no audit event at all), so either row
 * is positive proof about this cascade in particular.
 *
 * THE MOST RECENT OF THE TWO WINS, because both can legitimately exist on one
 * requisition over its life: deduct → void (rows deleted, audit kept) → another
 * rail books its own → re-receive → the cascade now finds rows and skips. Only
 * the latest describes the state a void is about to unwind.
 *
 * A SAME-SECOND TIE READS AS 'skipped', which is the conservative direction:
 * misreading a skip as a deduction fabricates stock and destroys another rail's
 * ledger rows; misreading a deduction as a skip leaves stock understated, which
 * is visible, reversible with an adjustment, and invents nothing. (audit_events
 * has no monotonic key — its id is a random UUID — so created_at at second
 * resolution is the only ordering available.)
 *
 * NEVER THROWS. An unreadable audit table returns 'unknown', which puts the
 * decision back on the two older discriminators rather than blocking a void on
 * a reporting table.
 */
function cascadeDeductionWitness(db: Database.Database, requisitionId: string): CascadeWitness {
  try {
    const row = db.prepare(`
      SELECT event_type FROM audit_events
       WHERE entity_id = ?
         AND event_type IN ('requisition.party_consumption', 'requisition.party_consumption.skipped')
       ORDER BY created_at DESC,
                CASE event_type WHEN 'requisition.party_consumption.skipped' THEN 0 ELSE 1 END
       LIMIT 1
    `).get(requisitionId) as any;
    if (!row) return 'unknown';
    return String(row.event_type) === 'requisition.party_consumption.skipped' ? 'skipped' : 'deducted';
  } catch {
    return 'unknown';
  }
}

/**
 * PROVE IT IS OURS TO UNDO. NO WRITES — every branch either returns a plan or
 * throws GrnRefused, which the caller's transaction turns into "nothing
 * happened". Refusing is reversible; a stray stock credit is not.
 */
export function planRequisitionUndoFromPo(
  db: Database.Database,
  requisitionId: string,
  poNumber: string,
): RequisitionUndoPlan {
  const empty = (purpose = ''): RequisitionUndoPlan => ({
    requisition_id: requisitionId, purpose, willUnfulfil: false, reverseParty: false,
    partyRows: [], partyRowsLeftIntact: 0, witness: 'unknown',
    credit: new Map(), materialNames: new Map(),
  });
  if (!requisitionId) return empty();

  const req = db.prepare(`SELECT * FROM requisitions WHERE id = ?`).get(requisitionId) as any;
  if (!req) {
    throw new GrnRefused(409,
      `${poNumber} was raised to fulfil a requisition that no longer exists (${requisitionId}), so the fulfilment this receipt completed cannot be undone. Voiding the bill would leave the order reopened and the requisition unaccounted for. Investigate the requisition before voiding.`,
      { requisition_id: requisitionId }, 'requisition_missing');
  }

  // BOTH NAMES, and this one is load-bearing in a way the guards are not: this
  // SELECT is the ONLY thing that finds the movements a void must credit back
  // and delete. If it misses the renamed rows it returns [], so
  //   · the 'party_unattributable' refusal (below) never fires,
  //   · the 'party_two_rails' refusal never fires,
  //   · `credit` is empty and reverseRequisitionFulfilFromPo's
  //     `plan.partyRows.length > 0` arm is skipped,
  // and the void then DEMOTES THE REQUISITION WHILE LEAVING THE DEDUCTION
  // STANDING AND UNCREDITED — recording in the audit that it reversed it. Three
  // safety gates failing OPEN and silently. Keep both names. Keep it in step
  // with the DELETE in reverseRequisitionFulfilFromPo, which must delete
  // exactly the set this selected.
  const partyRows = db.prepare(`
    SELECT id, material_id, quantity, reference_id, notes, outlet_id, created_at
    FROM inventory_transactions
    WHERE reference_id = ? AND type IN (${PARTY_TRANSFER_TYPES_SQL})
  `).all(requisitionId) as any[];

  // DISCRIMINATOR 1 — the cascade's signature.
  const ours = String(req.fulfilled_by || '') === PO_CASCADE_ACTOR;
  // DISCRIMINATOR 2 — positive proof the OTHER rail ran.
  let deptWitness = false;
  try {
    deptWitness = !!db.prepare(`
      SELECT 1 FROM department_material_transactions
      WHERE reference_id = ? AND type = 'received' LIMIT 1
    `).get(requisitionId);
  } catch (e: any) {
    // Cannot read the discriminator ⇒ cannot tell the two rails apart. That is
    // a refusal, never a silent "assume it is ours".
    throw new GrnRefused(409,
      `The department ledger could not be read (${e?.message || 'unreadable'}), so it cannot be proved which rail deducted the party stock on requisition ${req.req_number || requisitionId}. Refusing rather than credit back goods this receipt never moved.`,
      { requisition_id: requisitionId }, 'party_provenance_unreadable');
  }

  if (!ours) {
    // The cascade did not fulfil this requisition — either it never fired (the
    // ordinary case: the PO is still open, or the requisition was already
    // fulfilled by the store) or another rail has since taken it over.
    if (partyRows.length > 0 && !deptWitness) {
      // Party stock IS out on this requisition, with no dept credit to name the
      // other rail and no cascade signature to name ours. Undoing it would be a
      // guess; leaving it while reopening the PO would hide a deduction this
      // delivery may well have caused.
      throw new GrnRefused(409,
        `Requisition ${req.req_number || requisitionId} has ${partyRows.length} party-consumption movement(s) that cannot be attributed: it is not marked as fulfilled by the purchase-order cascade, and no department receipt names the other rail either. Voiding ${poNumber}'s receipt would either credit back goods it never moved or silently leave a deduction it did. Settle the requisition's history first.`,
        { requisition_id: requisitionId, party_rows: partyRows.length }, 'party_unattributable');
    }
    return empty(String(req.purpose || ''));
  }

  // ── ours ──────────────────────────────────────────────────────────────────
  if (String(req.status || '') !== 'fulfilled') {
    throw new GrnRefused(409,
      `Requisition ${req.req_number || requisitionId} was fulfilled by this purchase order's receipt but has since moved to "${req.status}". Undoing the fulfilment now would overwrite whatever moved it. Void is refused; correct the requisition first.`,
      { requisition_id: requisitionId, requisition_status: String(req.status || '') }, 'requisition_moved_on');
  }

  // ── DISCRIMINATOR 3 — DID OUR CASCADE DEDUCT, OR DID IT SKIP? ─────────────
  // The signature above proves the cascade FULFILLED this requisition. It does
  // not prove the cascade DEDUCTED, because the forward stamps the signature
  // before it decides, and skips the deduction outright when party rows already
  // exist. Where the audit trail says it skipped, the party movements on this
  // requisition are ANOTHER rail's and this void's business is only the
  // fulfilment: demote the requisition, touch not one quantity.
  //
  // That turns what used to be a permanent 'party_two_rails' dead end into a
  // correct partial — and a partial is precisely what the forward performed. It
  // is not a half-apply: the reversal is exactly as wide as the action.
  const witness = cascadeDeductionWitness(db, requisitionId);
  if (witness === 'skipped') {
    return {
      requisition_id: requisitionId,
      purpose: String(req.purpose || ''),
      willUnfulfil: true,
      reverseParty: false,
      partyRows: [],
      partyRowsLeftIntact: partyRows.length,
      witness,
      credit: new Map(),
      materialNames: new Map(),
    };
  }

  // No positive proof of a skip. Either the audit says we deducted, or there is
  // no audit row at all — and in the second case the two older discriminators
  // decide exactly as they did before, which means a genuine both-rails collision
  // is still refused rather than guessed.
  if (partyRows.length > 0 && deptWitness) {
    throw new GrnRefused(409,
      `Requisition ${req.req_number || requisitionId} carries a party deduction on BOTH rails — this purchase order's cascade and a store issue that also credited the department. Reversing one of them cannot be done without knowing which movement belongs to which, and the rows are identical. Void is refused.`,
      { requisition_id: requisitionId, party_rows: partyRows.length }, 'party_two_rails');
  }

  const credit = new Map<string, number>();
  const materialNames = new Map<string, string>();
  for (const row of partyRows) {
    const qty = Number(row.quantity);
    if (!Number.isFinite(qty) || qty >= 0) {
      // The forward writes −issued and skips issued <= 0, so a zero or positive
      // row is not something this cascade wrote. Crediting ABS() of it would
      // invent stock.
      throw new GrnRefused(409,
        `A party-consumption movement on requisition ${req.req_number || requisitionId} records ${row.quantity} rather than a deduction, so the quantity to credit back is unknown. Void is refused.`,
        { requisition_id: requisitionId, transaction_id: row.id }, 'party_row_shape');
    }
    const mat = db.prepare(`SELECT id, name FROM raw_materials WHERE id = ?`).get(String(row.material_id)) as any;
    if (!mat) {
      throw new GrnRefused(409,
        `A party-consumption movement on requisition ${req.req_number || requisitionId} belongs to a material that no longer exists in the master (${row.material_id}), so its stock cannot be credited back. Void is refused.`,
        { requisition_id: requisitionId, material_id: String(row.material_id) }, 'party_material_missing');
    }
    materialNames.set(String(row.material_id), String(mat.name));
    credit.set(String(row.material_id), r6((credit.get(String(row.material_id)) || 0) + Math.abs(qty)));
  }

  return {
    requisition_id: requisitionId,
    purpose: String(req.purpose || ''),
    willUnfulfil: true,
    reverseParty: true,
    partyRows,
    partyRowsLeftIntact: 0,
    witness,
    credit,
    materialNames,
  };
}

export interface RequisitionUndoOutcome {
  requisition_id: string;
  /** true iff the requisitions row was demoted fulfilled → store_processed. */
  unfulfilled: boolean;
  party_rows_deleted: number;
  /** Movements another rail booked, deliberately left standing. */
  party_rows_left_intact: number;
  /** Credited back, RECIPE units, BY THE RECORDED QUANTITY. */
  stock_restored: Array<{ material_id: string; material_name: string; quantity: number }>;
  /** Verbatim, for the caller's audit snapshot — the only copy of the deleted rows. */
  party_rows: any[];
  requisition_before: { status: string; fulfilled_at: string | null; fulfilled_by: string | null } | null;
}

/**
 * PERFORM IT. Call INSIDE the caller's db.transaction(), with a plan that
 * planRequisitionUndoFromPo returned and after the caller's own
 * assertNoNegativeStock has already passed on the NET of debit and credit.
 */
export function reverseRequisitionFulfilFromPo(
  db: Database.Database,
  { plan, actorEmail, poNumber, grnNumber }:
    { plan: RequisitionUndoPlan; actorEmail: string; poNumber: string; grnNumber: string },
): RequisitionUndoOutcome {
  const out: RequisitionUndoOutcome = {
    requisition_id: plan.requisition_id, unfulfilled: false, party_rows_deleted: 0,
    party_rows_left_intact: plan.partyRowsLeftIntact,
    stock_restored: [], party_rows: plan.partyRows, requisition_before: null,
  };
  if (!plan.willUnfulfil) return out;

  const before = db.prepare(
    `SELECT status, fulfilled_at, fulfilled_by FROM requisitions WHERE id = ?`
  ).get(plan.requisition_id) as any;
  out.requisition_before = before
    ? { status: String(before.status ?? ''), fulfilled_at: before.fulfilled_at ?? null, fulfilled_by: before.fulfilled_by ?? null }
    : null;

  // THE DEMOTION — the mirror of the forward's conditional UPDATE, and its own
  // replay guard. fulfilled_at / fulfilled_by are CLEARED, not kept: both
  // re-fulfil paths stamp them through COALESCE (store-issue/route.ts:455-466
  // documents this), so a leftover stamp would survive the round trip and the
  // eventual re-fulfilment would report this attempt's time for ever — and
  // /requisitions renders "Fulfilled: <date>" off the column alone, whatever
  // the status says. store_processed_at/by are deliberately NOT cleared: the
  // store genuinely did process this requisition.
  const demoted = db.prepare(`
    UPDATE requisitions
    SET status = 'store_processed', fulfilled_at = NULL, fulfilled_by = NULL, updated_at = datetime('now')
    WHERE id = ? AND status = 'fulfilled' AND fulfilled_by = ?
  `).run(plan.requisition_id, PO_CASCADE_ACTOR);
  if (demoted.changes === 0) {
    // The plan proved both conditions a moment ago under this same write lock,
    // so this cannot happen — and if it somehow does, the honest answer is that
    // the requisition is not in the state we are about to write about.
    throw new GrnRefused(409,
      `Requisition ${plan.requisition_id} could not be returned to the store queue — it is no longer marked as fulfilled by this purchase order. Nothing was changed.`,
      { requisition_id: plan.requisition_id }, 'requisition_moved_on');
  }
  out.unfulfilled = true;

  // GATED ON reverseParty, not on the rows existing. When the forward SKIPPED
  // its deduction the rows on this requisition belong to another rail, plan
  // carries none of them, and not one quantity is touched here.
  if (plan.reverseParty && plan.partyRows.length > 0) {
    const credit = db.prepare(
      `UPDATE raw_materials SET current_stock = current_stock + ?, updated_at = datetime('now') WHERE id = ?`
    );
    for (const [materialId, qty] of plan.credit) {
      credit.run(qty, materialId);
      out.stock_restored.push({
        material_id: materialId,
        material_name: plan.materialNames.get(materialId) || materialId,
        quantity: r6(qty),
      });
    }
    // THE SAME SET THE PLAN SELECTED, BY THE SAME PREDICATE. The credit above
    // is computed from plan.partyRows; this DELETE must remove exactly those
    // rows. Leave this narrow while the plan's SELECT matches both names and a
    // renamed row gets its stock credited back with the deduction row still on
    // the ledger — stock invented out of a mismatch between two lines of SQL.
    // Both predicates come from PARTY_TRANSFER_TYPES_SQL so they cannot drift.
    out.party_rows_deleted = db.prepare(
      `DELETE FROM inventory_transactions WHERE reference_id = ? AND type IN (${PARTY_TRANSFER_TYPES_SQL})`
    ).run(plan.requisition_id).changes;
  }

  // VERIFIED, NOT BEST-EFFORT. The forward's own audit row is best-effort
  // because it destroys nothing; this one is the only copy of the movements
  // just deleted and of the fulfilment stamps just cleared.
  logAuditOrThrow(db, {
    event_type: 'requisition.po_fulfil.reversed',
    entity_type: 'requisition',
    entity_id: plan.requisition_id,
    actor_email: actorEmail,
    before: {
      requisition: out.requisition_before,
      inventory_transactions: plan.partyRows,
    },
    after: {
      status: 'store_processed',
      party_rows_deleted: out.party_rows_deleted,
      party_rows_left_intact: out.party_rows_left_intact,
      cascade_witness: plan.witness,
      stock_restored: out.stock_restored,
      voided_grn: grnNumber, purchase_order: poNumber,
    },
    note: `Requisition returned to the store queue because ${grnNumber} on ${poNumber} was voided`
      + (out.party_rows_deleted
        ? `. Reversed ${out.party_rows_deleted} party-consumption movement(s) and credited ${out.stock_restored.length} material(s) back.`
        : out.party_rows_left_intact
          // NOT "no party consumption had been booked" — some was, by a different
          // rail, and it is still standing. Saying the wrong one of those two is
          // how an admin ends up correcting stock that was never wrong.
          ? `. ${out.party_rows_left_intact} party-consumption movement(s) on this requisition were booked by a store issue, not by this purchase order, so they were left exactly as they are and no stock was credited back.`
          : '. No party consumption had been booked.'),
  }, 'the requisition reversal (this row is the only copy of the deleted party movements and the cleared fulfilment stamps)');

  return out;
}
