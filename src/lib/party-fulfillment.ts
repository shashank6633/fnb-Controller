import type Database from 'better-sqlite3';
import { generateId, logAuditEvent } from '@/lib/db';
import { assertCentralIssue, recordPartyShelfTake, lineFactor } from '@/lib/issue-stock';
// THE MOVEMENT RECORD (owner's eight fields, 2026-09-10). This module writes
// BOTH rails with its own raw INSERTs — it maintains the department_materials
// cache itself, so it deliberately does NOT route through postDeptLedger (that
// would update the cache a second time and double it). The movement columns are
// therefore appended here, by hand, to the SAME statements: quantities, signs,
// cache maths and reference ids are untouched.
import {
  movementCols, postCentralTxn, deptParty, CENTRAL_PARTY,
  PARTY_TRANSFER_TYPE, PARTY_TRANSFER_TYPES_SQL,
} from '@/lib/movement-record';

/** One party line the transfer corrected to what left the shelf (round 7) —
 *  see "THE LINE RECORDS WHAT LEFT THE SHELF" below. */
export interface PartyShelfRecord {
  req_item_id: string;
  material_id: string;
  material_name: string;
  line_unit: string;
  /** quantity_issued before the transfer — the figure typed, in the LINE's unit. */
  asked_line_qty: number;
  /** quantity_issued now — what left the shelf, in the LINE's unit. */
  recorded_line_qty: number;
  /** RECIPE units the transfer debited (central) and credited (department). */
  debit_recipe: number;
}

/**
 * Centralised PARTY fulfilment TRANSFER: store → department.
 *
 * When a party requisition (requisitions.purpose='party') reaches its final
 * 'fulfilled' state, the materials it issued must move OUT of the store and INTO
 * the owning department's on-hand balance:
 *
 *   - STORE side  (raw_materials.current_stock / inventory_transactions):
 *       current_stock -= issued, plus a 'party_issue' ledger row
 *       (quantity = -issued). current_stock = purchases − recipe − party.
 *       ('party_issue' since 2026-09-17; 'party_consumption' before it. Same
 *       movement, same numbers — the old name called a transfer a consumption
 *       and every outflow report believed it.)
 *   - DEPT side   (department_materials / department_material_transactions):
 *       on_hand += issued, plus a 'received' ledger row (quantity = +issued,
 *       balance_after = new on_hand). This is what departments later draw down
 *       to record leftover balance / consumption post-party.
 *
 * ── THE CENTRAL FLOOR APPLIES HERE, AND IT IS THE INTERNAL RAIL'S OWN ───────
 * THE DEBIT BELOW USED TO BE UNBOUNDED. `UPDATE raw_materials SET current_stock
 * = current_stock - ?` ran with no balance read of any kind, so a party
 * requisition could take out stock that was not there and drive central
 * negative in silence. Measured over 76 real material shapes at both issue
 * desks — 152 attempts, 0 refused, 152 negative outcomes, global
 * MIN(current_stock) −36,000, 75 materials below zero.
 *
 * It is bounded now by assertCentralIssue() from src/lib/issue-stock.ts —
 * THE SAME floor the internal rail uses, asked with rail:'party' so its party
 * carve-out (which exists for the OTHER rail, where a party line debits
 * nothing) does not excuse the very debit it is bounding. Deliberately NOT a
 * second floor and NOT a second conversion: both are recorded traps in this
 * repo (the rival-helper trap, and the 750x trap of a local packFactor copy).
 *
 * IT THROWS CentralStockShort, and that is right HERE because somebody is
 * standing at the counter. Both callers run inside their own db.transaction and
 * both already catch it and answer 400 with the storekeeper-phrased message
 * (store-issue/route.ts:971, store-process/route.ts:1307), so the whole gesture
 * unwinds and the requisition is left exactly as it was. It must be
 * all-or-nothing rather than a quietly short transfer: a line that moved less
 * than it records would read as handed over in full on the line, the ledger and
 * the Issue Log, with nobody told. (A later call now TOPS UP what an earlier one
 * moved — see below — but only a line that records more than has moved; a short
 * line written as if it had moved in full would never be seen as owed.) The UNATTENDED third route (the PO-receipt / GRN-QC cascade in
 * po-requisition-fulfil.ts) deliberately does the opposite — see the judgement
 * recorded there.
 *
 * UNITS: requisition_items.quantity_issued is in ri.unit — the unit the line
 * was REQUESTED in, which may be the material's PURCHASE unit (1 BTL = 750 ml)
 * — while current_stock and department_materials.on_hand are RECIPE units
 * (average_price is ₹/recipe-unit). THE CONVERSION IS NOW THE FLOOR'S OWN. The
 * hand-rolled pack-factor CASE that stood here has been replaced by the factor
 * assertCentralIssue already applied (lineFactor → packFactor from
 * src/lib/pack-units.ts), so the quantity compared against the balance and the
 * quantity subtracted from it are THE SAME NUMBER by construction and cannot
 * drift. Proved a no-op on quantity: across all 16,353 live requisition lines
 * the old CASE and lineFactor return the identical factor on 16,350 and both
 * return 1 on the other 3 — which are exactly the blank-unit packed lines the
 * two now REFUSE rather than guess (see the carve-outs below).
 *
 * The party transfer inventory_transactions rows are the single source of truth
 * for de-duplication: what they already moved for this requisition is never
 * moved again. That makes the helper safe to call from BOTH fulfilment paths
 * (store-process batch + store-issue incremental) without any risk of
 * double-deduction. The probe matches BOTH the current 'party_issue' and the
 * legacy 'party_consumption' — see the guard below.
 *
 * ── A LATER CALL TOPS UP; IT NEVER REPEATS (round 7) ───────────────────────
 * The guard used to be ONE-SHOT: any party row on the requisition ⇒ skip the
 * whole call. store-process fires this transfer on a PARTIAL hand-over (its
 * trigger is "nothing on order", deliberately not "fulfilled" — the goods
 * leave the store the day they leave), so a party line processed at 10 of
 * 14.843 kg moved 10 kg, and the store-issue top-up that completed the line
 * met the one-shot guard: the line, the issue ledger and the Issue Log said
 * 14.843 kg handed over while only 10 kg ever left central or reached the
 * department (measured, lv.ts party_mixed_process_then_issue; the same on
 * ca91b18 and production).
 *
 * Now the rows say how much has moved, PER MATERIAL, and a later call moves
 * only what the lines record beyond it — attributed to the material's lines in
 * the same row order this loop always walked, each line through the same floor
 * with beforeLineQty = its moved share. A requisition already moved in full
 * finds nothing left and writes nothing, exactly as the old skip did; a
 * concurrent second process still waits on the IMMEDIATE lock and then reads
 * the first one's rows. Only POSITIVE remainders move: a line that now records
 * LESS than its share moved (an undo after a partial transfer) is not credited
 * back here — this rail does not unwind, which is the existing rule (see
 * store-issue's party reversal refusal), and it is left for the department
 * reconcile screen.
 *
 * NEITHER OTHER RAIL CHANGES. The PO cascade keeps its own any-row skip (it is
 * unattended; see po-requisition-fulfil.ts), and the void's three
 * discriminators read the same row shapes as before. Proved a no-op on the
 * live book: it holds 0 party transfer rows (both party requisitions are
 * still 'submitted'), so no stored requisition reads differently.
 *
 * THE GUARD READ AND THE WRITES SHARE ONE TRANSACTION, and that transaction is
 * IMMEDIATE. Until 2026-09-17 the guard ran outside the db.transaction that
 * acted on it — a check-then-act with the window wide open. One JS process
 * cannot interleave there (better-sqlite3 is synchronous and neither this
 * helper nor its callers await), but two OS processes on the same file can, and
 * measured four-way: every worker read "no row", every worker deducted, and
 * central lost 4× the goods. BEGIN IMMEDIATE takes the write lock BEFORE the
 * guard reads, so the second process waits on busy_timeout, then reads the row
 * the first one committed and skips. Do not hoist the guard back out, and do
 * not downgrade to the default deferred mode — deferred would turn the race
 * into a SQLITE_BUSY_SNAPSHOT error instead of a wait, which is safe but noisy.
 * (Both API callers already run this inside their own db.transaction, so there
 * the inner one becomes a SAVEPOINT and the mode is ignored by better-sqlite3 —
 * the outer transaction supplies the same atomicity. The IMMEDIATE matters for
 * a standalone call: a maintenance script or a second app instance.)
 *
 * All writes run inside a single db.transaction.
 *
 * ── THE LINE RECORDS WHAT LEFT THE SHELF (round 7) ─────────────────────────
 * The floor below can take the BALANCE rather than the line's figure — the
 * shown-figure rule: 14.843 kg typed over 14,842.5 g takes 14,842.5 g. Central,
 * the movement row and the department credit always carried that debit; the
 * requisition line and the issue ledger kept the typed 14.843 kg, so the Issue
 * Log claimed half a gram that never moved. The contract in
 * src/lib/central-debit-clamp.ts is that a caller whose debit is not the ask
 * records the debit, so each such line is corrected here, in this transaction
 * (recordPartyShelfTake), and the gesture is named on one audit row,
 * 'requisition.party_transfer.shelf'. An ordinary transfer writes neither.
 *
 * @param db         open better-sqlite3 database
 * @param reqId      requisition id
 * @param actorEmail the store person performing the fulfilment (stamped on dept ledger)
 * @returns { transferred: Array<{material_id, issued, department_id}>, total, recorded } — issued in RECIPE
 *          units; `recorded` lists the lines whose quantity_issued was corrected to what left the shelf.
 */
export function applyPartyFulfillment(
  db: Database.Database,
  reqId: string,
  actorEmail: string,
): {
  transferred: Array<{ material_id: string; issued: number; department_id: string | null }>;
  total: number;
  recorded: PartyShelfRecord[];
} {
  const req = db.prepare('SELECT * FROM requisitions WHERE id = ?').get(reqId) as any;
  if (!req) {
    console.warn(`[party-fulfillment] requisition ${reqId} not found — skip`);
    return { transferred: [], total: 0, recorded: [] };
  }

  // IDEMPOTENCY GUARD — the presence of a party transfer ledger row for this
  // requisition means the store→dept transfer already ran. Never repeat it.
  //
  // IT MATCHES BOTH NAMES, AND THAT IS NOT REDUNDANCY. The row is typed
  // 'party_issue' since 2026-09-17 and was typed 'party_consumption' before it.
  // A row that escaped the migration, or a database restored from an older
  // backup, still means EXACTLY the same thing: the goods already left central.
  // Narrow this to one name and every such requisition reads as
  // never-transferred, and the same stock is deducted from central a SECOND
  // time. See PARTY_TRANSFER_TYPES for the full reasoning and the three
  // same-named things this is not.
  //
  // PREPARED HERE, EXECUTED INSIDE THE TRANSACTION (see the header): preparing
  // takes no lock, so only the read itself needs to be under the write lock.
  //
  // WHAT HAS ALREADY MOVED, PER MATERIAL (round 7 — "A LATER CALL TOPS UP" in
  // the header). The rows are negative debits, so −SUM is RECIPE units out.
  const selMoved = db.prepare(`
    SELECT material_id, -COALESCE(SUM(quantity), 0) AS moved
    FROM inventory_transactions
    WHERE reference_id = ? AND type IN (${PARTY_TRANSFER_TYPES_SQL})
    GROUP BY material_id
  `);

  // Also read INSIDE the transaction. quantity_issued is what this helper
  // deducts; reading it under the same lock as the guard means the quantities
  // written are the quantities that were current when the guard passed.
  const selItems = db.prepare(`
    SELECT ri.id, ri.material_id, ri.quantity_issued, ri.department_id,
           ri.unit AS req_unit,
           rm.current_stock, rm.unit, rm.purchase_unit, rm.pack_size
    FROM requisition_items ri
    JOIN raw_materials rm ON rm.id = ri.material_id
    WHERE ri.req_id = ?
  `);

  const partyNote = `Party: ${req.event_name || '(unnamed)'} @ ${req.event_date || ''}`.trim();
  const eventName = req.event_name || '';
  const eventDate = req.event_date || '';
  const outletId = req.outlet_id || null;

  const decStock = db.prepare(`
    UPDATE raw_materials SET current_stock = current_stock - ?, updated_at = datetime('now')
    WHERE id = ?
  `);
  const selDeptMat = db.prepare(`
    SELECT id, on_hand FROM department_materials WHERE department_id = ? AND material_id = ?
  `);
  const insDeptMat = db.prepare(`
    INSERT INTO department_materials (id, outlet_id, department_id, material_id, on_hand, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);
  const updDeptMat = db.prepare(`
    UPDATE department_materials SET on_hand = ?, updated_at = datetime('now') WHERE id = ?
  `);
  // The movement columns this database actually has. Their NAMES are identical
  // for every row on a given table (movementCols filters a fixed list by
  // presence), so the statement is prepared once from a probe and only the
  // VALUES are recomputed per line — same pattern, one prepare, N binds.
  const mvNames = movementCols(db, 'department_material_transactions', {
    materialId: '', quantity: 1, src: CENTRAL_PARTY, dst: { kind: 'department' },
  }).names;
  const mvCols = mvNames.length ? `, ${mvNames.join(', ')}` : '';
  const mvQs = mvNames.map(() => ', ?').join('');
  const insDeptTx = db.prepare(`
    INSERT INTO department_material_transactions
      (id, outlet_id, department_id, material_id, type, quantity, balance_after,
       reference_id, event_name, event_date, notes, user, created_at${mvCols})
    VALUES (?, ?, ?, ?, 'received', ?, ?, ?, ?, ?, ?, ?, datetime('now')${mvQs})
  `);

  const transferred: Array<{ material_id: string; issued: number; department_id: string | null }> = [];
  const recorded: PartyShelfRecord[] = [];

  const txn = db.transaction((): boolean => {
    // THE GUARD, UNDER THE WRITE LOCK. Everything this function decides — has
    // the transfer already happened, and for how much — is read here, after
    // BEGIN IMMEDIATE has excluded every other writer.
    const movedRows = selMoved.all(reqId) as Array<{ material_id: string; moved: number }>;
    // topUp: an earlier call already moved some of this requisition. Each line
    // is then floored from its moved share, not from 0, so nothing moves twice.
    const topUp = movedRows.length > 0;
    const movedPool = new Map<string, number>(
      movedRows.map(m => [String(m.material_id), Math.max(0, Number(m.moved) || 0)]),
    );
    const items = selItems.all(reqId) as any[];
    // Lines this transfer DECLINED to move, for the audit row below. A declined
    // line leaves no other trace: unlike applyIssueDelta, this rail writes no
    // requisition_issue_ledger row, so without that row the skip would be
    // invisible — and the per-requisition guard above means it can never be
    // picked up on a later call either.
    const declined: Array<{
      req_item_id: string; material_id: string; material_name: string;
      reason: string; requested_line_qty: number; line_unit: string;
    }> = [];
    // What earlier lines of THIS transfer took, per material, and how many
    // lines — for the refusal SENTENCE only (assertCentralIssue's siblings).
    // The floor's decision needs no claim: each line re-reads a balance the
    // earlier debits have already reduced.
    const takenBy = new Map<string, { recipe: number; lines: number }>();
    for (const it of items) {
      const issuedReq = Number(it.quantity_issued) || 0; // in ri.unit
      if (issuedReq <= 0) continue;
      const prior = takenBy.get(String(it.material_id));

      // THIS LINE'S SHARE OF WHAT EARLIER CALLS MOVED, in the LINE's unit. The
      // rows are per material, so the moved recipe quantity is handed to the
      // material's lines in this loop's own order, each taking up to what it
      // records. 0 on a first transfer (topUp false), which is exactly the
      // beforeLineQty this call always passed. A line whose unit cannot be
      // resolved never moved (the floor declines it) and takes no share.
      let movedLine = 0;
      if (topUp) {
        const lf = lineFactor(it.req_unit, it);
        const left = movedPool.get(String(it.material_id)) || 0;
        if (!lf.needsReview && left > 0 && lf.factor > 0) {
          const lineRecipe = Math.round(issuedReq * lf.factor * 1e6) / 1e6;
          const share = Math.min(left, lineRecipe);
          movedPool.set(String(it.material_id), left - share);
          movedLine = share >= lineRecipe ? issuedReq : share / lf.factor;
        }
      }

      // THE FLOOR AND THE CONVERSION, FROM ONE CALL, INSIDE THIS TRANSACTION.
      //
      // beforeLineQty 0 / afterLineQty issuedReq is the honest statement of what
      // this rail does: the internal rail debits an INCREMENT as each line is
      // issued, while the party rail moves the line's whole quantity_issued once,
      // here, at fulfilment. So the delta this floor must bound is the full
      // figure, not a difference.
      //
      // IT READS current_stock ITSELF, per line, one statement before the UPDATE
      // — which is also why two lines of the same material need no running
      // claim: by the time the second is checked the first has already been
      // subtracted. better-sqlite3 is synchronous and nothing awaits inside this
      // transaction, so nothing can interleave between the read and the write.
      //
      // A REFUSAL AFTER AN EARLIER LINE OF THE SAME MATERIAL names that line
      // (round 7). Two party lines of one material at 14.843 kg over 14,842.5 g:
      // the first took everything, so the second met an empty shelf and the
      // gesture was refused "the central store holds none of it" — while the
      // unwound gesture left all 14,842.5 g on the shelf. The decision is the
      // same; the sentence now says the store holds 14.843 kg and all of it
      // goes to the line above.
      //
      // ON A TOP-UP the floor bounds only the remainder: beforeLineQty is the
      // line's moved share, so the delta is what the line records beyond it.
      const c = assertCentralIssue(db, {
        reqItemId: String(it.id),
        beforeLineQty: movedLine,
        afterLineQty: issuedReq,
        rail: 'party',
        siblingRecipe: prior?.recipe || 0,
        siblingLines: prior?.lines || 0,
      });
      // Already moved in full (or, after an undo, moved MORE than the line now
      // records — see the header: this rail does not credit back). Nothing to
      // move and nothing declined: the earlier call's rows are the record.
      if (topUp && !c.debits && c.skipReason === 'zero_delta') continue;

      // THE OTHER TWO CARVE-OUTS, HONOURED — AND THEY GATE BOTH SIDES.
      //
      // store_mapped: the material lives on the TGBCL store ledger
      // (store_stock_ledger / store_locations) and central's current_stock is
      // not its balance. This rail used to debit central anyway — of the 952
      // materials 127 are store-mapped and 95 of those hold a central balance of
      // 0, so a party draw on one of them went straight below zero.
      // unit_review: ri.unit is blank or unrecognised on a PACKED material, so
      // nobody can say whether the line means grams or kilos. The old CASE
      // silently assumed recipe units (×1) where dept-stock and
      // department-consumption read the same blank as the purchase basis
      // (×pack) — a 750x disagreement decided by which screen you opened. 3 live
      // lines are this shape: 100 PIPERS (750ML), OLIVE OIL POMACE 1 ltr and
      // SALTED BUTTER 500 GM.
      //
      // NEITHER SIDE MOVES. Skipping only the central debit while still crediting
      // the department would MANUFACTURE stock — the department would gain a
      // gram central never gave up. applyIssueDelta learned this the same way
      // and gates both sides for the identical reason; a gap that is recorded is
      // the lesser evil, and it is recorded in audit_events below.
      if (!c.debits) {
        declined.push({
          req_item_id: String(it.id),
          material_id: String(it.material_id),
          material_name: String(c.materialName || ''),
          reason: c.skipReason || 'zero_delta',
          requested_line_qty: issuedReq,
          line_unit: String(it.req_unit ?? ''),
        });
        continue;
      }

      // RECIPE units, and the floor's own figure — never a second multiplication.
      // debitRecipe, not requestedRecipe: the floor accepts "everything on the
      // shelf" on the balance's 6-dp grid point, and on that ask the figure to
      // subtract is the balance itself, so the write lands on exactly 0 rather
      // than -4e-7 (planCentralDebit, src/lib/central-debit-clamp.ts). Identical
      // to requestedRecipe on every other ask. The department credit and the
      // movement row below carry the same figure, so the two rails still agree.
      const issued = c.debitRecipe;
      const deptId: string | null = it.department_id || req.department_id || null;
      takenBy.set(String(it.material_id), {
        recipe: (prior?.recipe || 0) + issued, lines: (prior?.lines || 0) + 1,
      });

      // THE LINE SAYS WHAT LEFT THE SHELF (round 7). recordAfterLineQty is the
      // floor's own answer: the line's figure untouched on every ordinary
      // transfer, the balance (in the line's unit) when the shown-figure rule
      // took it instead. Written before the debit only because the debit does
      // not read the line; both are inside this one transaction.
      if (c.recordAfterLineQty !== issuedReq
          && recordPartyShelfTake(db, {
            reqItemId: String(it.id), askedLineQty: issuedReq,
            recordLineQty: c.recordAfterLineQty, actor: actorEmail,
          })) {
        recorded.push({
          req_item_id: String(it.id), material_id: String(it.material_id),
          material_name: String(c.materialName || ''), line_unit: String(it.req_unit ?? ''),
          asked_line_qty: issuedReq, recorded_line_qty: c.recordAfterLineQty, debit_recipe: issued,
        });
      }

      // STORE: decrement current_stock + ledger row.
      decStock.run(issued, it.material_id);
      // Same debit as before — same type, same sign, same reference, same note.
      // What is new is that the row now says WHERE the goods went (this party's
      // department, by id and by name), in WHAT unit, on WHAT business date and
      // by WHOM. The central rail had no actor column at all until today.
      postCentralTxn(db, {
        materialId: it.material_id,
        // 'party_issue' — "Issued to a party / event". It was 'party_consumption'
        // until 2026-09-17, and that word was simply wrong: nothing is consumed
        // here. The goods move to the department, whose on_hand is credited ten
        // lines below, and the department draws them down later. The quantity,
        // the sign, the reference and the two balances are untouched — only the
        // NAME of the movement changed. (The label mattered because it is what
        // every report buckets on: this row sat in the outflow whitelist beside
        // 'sale', so an internal transfer read as stock consumed and gone.)
        type: PARTY_TRANSFER_TYPE,
        quantity: -issued,
        referenceId: reqId,
        notes: partyNote,
        outletId,
        counterparty: deptId ? deptParty(db, deptId) : { kind: 'consumption' },
        txnDate: eventDate || undefined,
        actor: actorEmail,
      });

      // DEPT: upsert on_hand + append received ledger row.
      if (deptId) {
        const existing = selDeptMat.get(deptId, it.material_id) as any;
        let newOnHand: number;
        if (existing) {
          newOnHand = (Number(existing.on_hand) || 0) + issued;
          updDeptMat.run(newOnHand, existing.id);
        } else {
          newOnHand = issued;
          insDeptMat.run(generateId(), outletId, deptId, it.material_id, newOnHand);
        }
        // 'received' is a POSITIVE movement, so the department is the
        // destination and the central store is the source — the mirror of the
        // debit posted above, now stated on the row instead of implied by the type.
        insDeptTx.run(generateId(), outletId, deptId, it.material_id, issued, newOnHand,
                      reqId, eventName, eventDate, partyNote, actorEmail,
                      ...movementCols(db, 'department_material_transactions', {
                        materialId: it.material_id,
                        quantity: issued,
                        src: CENTRAL_PARTY,
                        dst: deptParty(db, deptId),
                        txnDate: eventDate || undefined,
                      }).values);
      }

      transferred.push({ material_id: it.material_id, issued, department_id: deptId });
    }

    // WHAT THIS TRANSFER WOULD NOT MOVE, WHERE THE OWNER CAN SEE IT. Written
    // ONLY when something was declined, so an ordinary fulfilment is byte-identical
    // to before this change.
    //
    // THE EVENT TYPE IS DELIBERATELY NOT ONE OF THE CASCADE'S TWO.
    // po-requisition-fulfil.ts's cascadeDeductionWitness tells a void which rail
    // deducted by looking for exactly 'requisition.party_consumption' or
    // 'requisition.party_consumption.skipped', and its correctness rests on the
    // stated fact that "applyPartyFulfillment writes no audit event at all".
    // Writing either name here would make THIS rail's row look like the
    // cascade's own witness, and a void would then credit back — or refuse to
    // credit back — on the strength of a row the cascade never wrote. Keep this
    // name distinct from both, and keep it out of that IN list.
    if (declined.length > 0) {
      logAuditEvent(db, {
        event_type: 'requisition.party_transfer.declined',
        entity_type: 'requisition',
        entity_id: reqId,
        actor_email: actorEmail,
        after: { declined, transferred: transferred.length },
        note: `Party transfer: ${declined.length} line(s) moved no stock — `
          + declined.map(d => `${d.material_name || d.material_id} (${d.reason})`).join(', '),
      });
    }
    // WHAT THE SHELF RULE RESOLVED, on its own row — written ONLY when a line
    // was corrected, so an ordinary transfer is byte-identical. Not one of the
    // cascade witness names either (see the note above), for the same reason.
    if (recorded.length > 0) {
      logAuditEvent(db, {
        event_type: 'requisition.party_transfer.shelf',
        entity_type: 'requisition',
        entity_id: reqId,
        actor_email: actorEmail,
        after: { lines: recorded },
        note: `Party transfer took what the central store held on ${recorded.length} line(s) typed at the `
          + `store's shown figure; each line now records what left the shelf (the typed figure is kept as asked): `
          + recorded.map(r => `${r.material_name || r.material_id} ${r.asked_line_qty} → ${r.recorded_line_qty}`
            + `${r.line_unit ? ` ${r.line_unit}` : ''}`).join(', '),
      });
    }
    if (topUp && transferred.length === 0 && declined.length === 0) {
      console.log(`[party-fulfillment] requisition ${reqId} already transferred in full — nothing to top up`);
    }
    return true;
  });
  // IMMEDIATE, not the default deferred — see the header. Nested inside a
  // caller's transaction better-sqlite3 uses a SAVEPOINT and ignores the mode,
  // so this is a no-op for both API routes and the protection that matters for
  // a standalone call.
  txn.immediate();

  return { transferred, total: transferred.length, recorded };
}
