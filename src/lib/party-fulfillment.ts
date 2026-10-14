import type Database from 'better-sqlite3';
import { generateId, logAuditEvent } from '@/lib/db';
import { assertCentralIssue } from '@/lib/issue-stock';
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
 * all-or-nothing rather than a partial transfer, because the idempotency guard
 * below is per-REQUISITION: one line's party row makes the whole requisition
 * read as already-transferred, so a quietly short line could never be completed
 * later. The UNATTENDED third route (the PO-receipt / GRN-QC cascade in
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
 * The party transfer inventory_transactions row is the single source of truth
 * for de-duplication: if one already exists for this requisition, the transfer
 * has already happened and this is a no-op. That makes the helper safe to call
 * from BOTH fulfilment paths (store-process batch + store-issue incremental)
 * without any risk of double-deduction. The probe matches BOTH the current
 * 'party_issue' and the legacy 'party_consumption' — see the guard below.
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
 * @param db         open better-sqlite3 database
 * @param reqId      requisition id
 * @param actorEmail the store person performing the fulfilment (stamped on dept ledger)
 * @returns { transferred: Array<{material_id, issued, department_id}>, total } — issued in RECIPE units
 */
export function applyPartyFulfillment(
  db: Database.Database,
  reqId: string,
  actorEmail: string,
): { transferred: Array<{ material_id: string; issued: number; department_id: string | null }>; total: number } {
  const req = db.prepare('SELECT * FROM requisitions WHERE id = ?').get(reqId) as any;
  if (!req) {
    console.warn(`[party-fulfillment] requisition ${reqId} not found — skip`);
    return { transferred: [], total: 0 };
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
  const selAlready = db.prepare(`
    SELECT 1 FROM inventory_transactions
    WHERE reference_id = ? AND type IN (${PARTY_TRANSFER_TYPES_SQL})
    LIMIT 1
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

  const txn = db.transaction((): boolean => {
    // THE GUARD, UNDER THE WRITE LOCK. Everything this function decides — has
    // the transfer already happened, and for how much — is read here, after
    // BEGIN IMMEDIATE has excluded every other writer.
    const already = selAlready.get(reqId);
    if (already) {
      console.log(`[party-fulfillment] requisition ${reqId} already transferred — skip`);
      return false;
    }
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
    for (const it of items) {
      const issuedReq = Number(it.quantity_issued) || 0; // in ri.unit
      if (issuedReq <= 0) continue;

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
      const c = assertCentralIssue(db, {
        reqItemId: String(it.id),
        beforeLineQty: 0,
        afterLineQty: issuedReq,
        rail: 'party',
      });

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
    return true;
  });
  // IMMEDIATE, not the default deferred — see the header. Nested inside a
  // caller's transaction better-sqlite3 uses a SAVEPOINT and ignores the mode,
  // so this is a no-op for both API routes and the protection that matters for
  // a standalone call.
  txn.immediate();

  return { transferred, total: transferred.length };
}
