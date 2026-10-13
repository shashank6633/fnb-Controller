import type Database from 'better-sqlite3';
import { generateId } from '@/lib/db';
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
 * UNITS: requisition_items.quantity_issued is in ri.unit — the unit the line
 * was REQUESTED in, which may be the material's PURCHASE unit (1 BTL = 750 ml)
 * — while current_stock and department_materials.on_hand are RECIPE units
 * (average_price is ₹/recipe-unit). Convert ONCE here with the house
 * pack-factor CASE (byte-equivalent to department-consumption route.ts SQL and
 * dept-stock reqPackFactor): × pack_size only when the line was requested in
 * the purchase unit. Legacy rows with a blank ri.unit stay ×1.
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
    for (const it of items) {
      const issuedReq = Number(it.quantity_issued) || 0; // in ri.unit
      if (issuedReq <= 0) continue;
      // ri.unit → RECIPE units: the house pack-factor CASE (see header). Kept
      // byte-equivalent to department-consumption route.ts SQL and dept-stock
      // reqPackFactor: emptiness guarded with trim, purchase-/recipe-unit
      // equality on the RAW ri.unit.
      const packFactor =
        (String(it.req_unit ?? '').trim() !== '' &&
         it.req_unit === it.purchase_unit &&
         it.req_unit !== it.unit &&
         (Number(it.pack_size) || 1) > 1)
          ? Number(it.pack_size) : 1;
      const issued = issuedReq * packFactor; // RECIPE units
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
    return true;
  });
  // IMMEDIATE, not the default deferred — see the header. Nested inside a
  // caller's transaction better-sqlite3 uses a SAVEPOINT and ignores the mode,
  // so this is a no-op for both API routes and the protection that matters for
  // a standalone call.
  txn.immediate();

  return { transferred, total: transferred.length };
}
