import type Database from 'better-sqlite3';
import { generateId, logAuditEvent } from '@/lib/db';
import {
  assertCentralIssue, checkCentralIssue, recordPartyShelfTake, stampShelfClose, centralShelfEmpty,
  markLedgerShelfClose, issueLedgerWatermark, lineFactor, CentralStockShort, isCentralStockShort,
} from '@/lib/issue-stock';
import { qtyGrid } from '@/lib/central-debit-clamp';
// ROUTED LINES (rulings #45/#74): the leaf probe only.
import { routedColSql } from '@/lib/routed-schema';
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
  /**
   * WHY the line was corrected (round 10):
   *   'shown'   — the shown-figure rule took the balance, not the typed figure
   *               (round 7; the only kind before round 10);
   *   'substep' — a top-up whose remainder, below one printed step, the shelf
   *               could not cover: the transfer took what the shelf held and
   *               the line records what left (THE RULE then closes it);
   *   'short'   — a top-up line this gesture did not touch, whose recorded
   *               remainder the shelf could not cover: the transfer took what
   *               the shelf held, the line records what left, and it stays
   *               open for the rest.
   * See "A TOP-UP THE SHELF CANNOT COVER" below.
   */
  kind: 'shown' | 'substep' | 'short';
  /** What earlier transfers had already moved for the line, LINE units (0 on
   *  a 'shown' correction of a first transfer). */
  moved_line_qty: number;
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
 * all-or-nothing rather than a partial transfer: a quietly short line would
 * leave the line recording goods the books never moved. (Round 9: a later call
 * now moves what each line holds above what already moved — see "A SECOND CALL
 * MOVES ONLY WHAT HAS NOT MOVED" below — but a refusal is still whole. Round
 * 10: a top-up the shelf cannot cover takes what the shelf holds only where
 * the LINE THEN RECORDS WHAT LEFT — never a quiet short — see "A TOP-UP THE
 * SHELF CANNOT COVER"; every other short line still refuses, all of them
 * named.) The UNATTENDED third route (the PO-receipt / GRN-QC cascade in
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
 * The party transfer inventory_transactions rows are the single source of
 * truth for de-duplication: what they already moved for a line's material is
 * never moved again. Until round 9 ONE such row made the whole call a no-op;
 * now a call moves only what each line holds above what its rows already moved
 * (a top-up after a short /store-process submit), and a call with nothing left
 * to move is the same no-op it always was. That keeps the helper safe to call
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
 * ── A REFUSAL WORDED FOR THE BOX THAT ASKED (round 9) ───────────────────────
 * The decision below never changes: the transfer moves each line's WHOLE
 * quantity_issued, from 0. But /store-issue's box ADDS to what a line already
 * holds, so a refusal whose cap was "Issue 14.842 kg or less on this line" —
 * the cap on the whole line — sent the store desk to add 14.842 kg to a line
 * already holding 14.842 kg, and be refused again "so 29.684 kg cannot be
 * issued" (round-8 verifier, sd_party_tail). `opts.deskBeforeLineQty` is each
 * line's quantity_issued before the gesture, as that box sees it; the floor
 * then words the refusal and returns its cap for a box that adds to it
 * (checkCentralIssue's deskBeforeLineQty / maxAddLineQty). /store-process, whose
 * box IS the line's absolute figure, passes nothing and is byte-identical.
 *
 * ── A TOP-UP THE SHELF CANNOT COVER (round 10) ─────────────────────────────
 * A top-up asks the floor for what a line holds above the part already moved,
 * and the part already moved cannot be put back (a party undo zeroes the line;
 * the goods stay with the department). So a top-up refusal can leave a
 * requisition with no truthful way forward, and two shapes did (round-9
 * never-stuck recheck):
 *   · A REMAINDER BELOW ONE PRINTED STEP, OVER AN EMPTY SHELF. THREE MANGO
 *     14.843 kg approved, 14,842.4 g moved by the management desk (the shelf
 *     emptied, the line closed by THE RULE); undone and re-issued at the box's
 *     14.843, the top-up asked 0.6 g of a 0 g shelf and was refused — and that
 *     refusal then blocked SALT's Issue Now and SALT's Reject on the same
 *     requisition, for good (ta_redo_full_out). THE RULE's own answer for a
 *     line that holds everything the store gave it, owes less than one printed
 *     step and leaves the shelf empty is "complete". So such a remainder takes
 *     what the shelf holds (nothing, or a crumb), the line RECORDS WHAT LEFT
 *     (14.8424 kg) and the shelf arm closes it. It never blocks.
 *   · A LINE THIS GESTURE DID NOT TOUCH, whose recorded remainder the shelf can
 *     no longer cover. THREE MANGO 20 kg recorded, 10 kg moved, the shelf since
 *     drained to 5 kg by other screens; SALT's Reject — the last open line —
 *     fired the top-up, which refused it naming MANGO, a complete line with no
 *     rest to defer (ta_block). The storekeeper was not acting on MANGO, so the
 *     refusal was not his to fix in that gesture, and every exit without a
 *     receipt ended in a false record. The owner's rule for a line the store
 *     cannot cover is "issue the 5, hold the 1": the rest of the gesture goes
 *     ahead and the short line STAYS OUTSTANDING. So the transfer takes what
 *     the shelf holds for that line (5 kg, landing on exactly 0), the line
 *     records what left (15 kg) and reads open for the 5 kg still owed, and the
 *     route names it on its 200 (party_short). Nothing goes below zero, nothing
 *     records goods that did not move, and the line keeps Issue Now / Defer /
 *     Reject.
 * Both go through recordPartyShelfTake (the same correction the shown-figure
 * rule makes, kind 'substep' / 'short') and stampShelfClose. Neither applies
 * to a first transfer (nothing moved: an undo is still a truthful way to lower
 * the line) nor to a line THIS gesture issued on whose remainder is a step or
 * more (the storekeeper is asking for it now — refused, with its figures).
 * `opts.gestureIssuedIds` names the lines this gesture issued on; without it
 * (/store-process, whose submit writes every line) every line is the gesture's.
 *
 * ── EVERY SHORT LINE IS NAMED (round 10) ────────────────────────────────────
 * The transfer used to throw on the FIRST line it could not move, so a second
 * short line was found only by the next press (round-9 recheck, two-short).
 * Every line is now scored before the transfer refuses; the first refusal is
 * thrown with the rest on CentralStockShort.others, and the routes return each
 * one's row and cap. The refusal is still whole: nothing moves. (Final pass:
 * each line's sentence also names the other short lines that would refuse
 * again, since its own cap moves nothing while they stay in the transfer.)
 *
 * ── THE SHELF MARK GOES ON THE CLOSING GESTURE'S ROW (round 10) ─────────────
 * `opts.ledgerSince` is requisition_issue_ledger's MAX(rowid) when the gesture
 * began (issueLedgerWatermark). A line this transfer closes by the shelf arm
 * stamps only a ledger row written since — the gesture's own issue row, or
 * this transfer's correction row — never an earlier gesture's (round-9
 * issue-log verifier, party_retro_stamp). Without it, the transfer's own start.
 *
 * @param db         open better-sqlite3 database
 * @param reqId      requisition id
 * @param actorEmail the store person performing the fulfilment (stamped on dept ledger)
 * @param opts       deskBeforeLineQty: requisition_items.id → quantity_issued before this gesture (/store-issue only);
 *                   gestureIssuedIds: the lines this gesture issued on (/store-issue only);
 *                   ledgerSince: the issue ledger's MAX(rowid) when the gesture began
 * @returns { transferred: Array<{material_id, issued, department_id}>, total, recorded } — issued in RECIPE
 *          units; `recorded` lists the lines whose quantity_issued was corrected to what left the shelf.
 */
export function applyPartyFulfillment(
  db: Database.Database,
  reqId: string,
  actorEmail: string,
  opts?: {
    deskBeforeLineQty?: ReadonlyMap<string, number>;
    gestureIssuedIds?: ReadonlySet<string>;
    ledgerSince?: number;
  },
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
  const selAlready = db.prepare(`
    SELECT 1 FROM inventory_transactions
    WHERE reference_id = ? AND type IN (${PARTY_TRANSFER_TYPES_SQL})
    LIMIT 1
  `);
  // WHAT ALREADY LEFT THE SHELF, per material (round 9 — the top-up, see
  // "A SECOND CALL MOVES ONLY WHAT HAS NOT MOVED" below). RECIPE units, the
  // sign flipped (the rows are debits). Same two type names as the guard.
  const selMovedByMat = db.prepare(`
    SELECT material_id, COALESCE(SUM(-quantity), 0) AS moved
      FROM inventory_transactions
     WHERE reference_id = ? AND type IN (${PARTY_TRANSFER_TYPES_SQL})
     GROUP BY material_id
  `);

  // Also read INSIDE the transaction. quantity_issued is what this helper
  // deducts; reading it under the same lock as the guard means the quantities
  // written are the quantities that were current when the guard passed.
  // routed_dept (rulings #45/#74): '' on every line the store serves, and on a
  // database without the column — then this rail is byte-identical.
  const selItems = db.prepare(`
    SELECT ri.id, ri.material_id, ri.quantity_issued, ri.department_id,
           ri.unit AS req_unit,
           ${routedColSql(db)} AS routed_dept,
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
    const already = !!selAlready.get(reqId);
    const items = selItems.all(reqId) as any[];
    // ── A SECOND CALL MOVES ONLY WHAT HAS NOT MOVED (round 9) ───────────────
    // This guard used to end the function: one party row on the requisition
    // and every later call skipped. That was the whole idempotency story, and
    // it was right only while the transfer ran once, at the end. It does not:
    // /store-process runs it on every submit that raises no PO, short lines
    // included, so a 20 kg line processed at 14.842 kg moved 14,842.4 g — and
    // when the store desk later issued the 5.158 kg tail, the requisition
    // closed as fulfilled with 20 kg recorded, no stock check, and not a gram
    // more moved ("already transferred — skip"), over a shelf at 0 (round-9
    // verifier, party-tail pt_short; pt_plenty recorded 20 kg over 10,000 g
    // moved). The store gave, on paper, what the books said it did not hold.
    //
    // So the guard now says HOW MUCH already moved, not merely that something
    // did, and each line asks the floor only for what it holds above that:
    // beforeLineQty = the part already moved (line units), afterLineQty = the
    // line as it stands. The same floor, the same shown-figure rule, the same
    // all-or-nothing refusal, the same department credit — on the remainder.
    // A repeat call with nothing left to move is a no-op exactly as before
    // (not one row written), so the double-deduction guarantee stands: what
    // moved is never moved again. The moved figure is per MATERIAL on the
    // party rows (reference_id + material_id), handed to the requisition's
    // lines of that material in the order this loop walks them — the order
    // the first run moved them in. Two lines of one material cannot be saved
    // today (duplicateLineError), so in practice each material is one line.
    // Measured: the live book has 2 party requisitions, both 'submitted', and
    // 0 party transfer rows — this changes nothing that exists.
    const movedLeft = new Map<string, number>();
    if (already) {
      for (const row of selMovedByMat.all(reqId) as any[]) {
        movedLeft.set(String(row.material_id), Math.max(0, Number(row.moved) || 0));
      }
    }
    let topUpLines = 0;
    // Lines this transfer DECLINED to move, for the audit row below. A declined
    // line leaves no other trace: unlike applyIssueDelta, this rail writes no
    // requisition_issue_ledger row, so without that row the skip would be
    // invisible. (A later call — a top-up, round 9 — meets the same carve-out
    // and declines the line again, on its own audit row.)
    const declined: Array<{
      req_item_id: string; material_id: string; material_name: string;
      reason: string; requested_line_qty: number; line_unit: string;
    }> = [];
    // What earlier lines of THIS transfer took, per material, and how many
    // lines — for the refusal SENTENCE only (assertCentralIssue's siblings).
    // The floor's decision needs no claim: each line re-reads a balance the
    // earlier debits have already reduced.
    const takenBy = new Map<string, { recipe: number; lines: number }>();
    // Every line the floor refuses, in walk order (round 10 — EVERY SHORT LINE
    // IS NAMED). Thrown together once the walk is done.
    const shorts: CentralStockShort[] = [];
    // Which of them would refuse AGAIN on a gesture that does not touch them
    // (final pass — see "A SHORT LINE THAT BLOCKS ANOTHER" below): a first
    // transfer (nothing moved yet) refuses whenever the transfer runs, and on
    // /store-process (no gestureIssuedIds) every line is the gesture's; a
    // top-up line on /store-issue that the next gesture leaves alone instead
    // takes what the shelf holds and stays open (A TOP-UP THE SHELF CANNOT
    // COVER). Parallel to `shorts`.
    const shortBlocks: boolean[] = [];
    // The gesture's start in the issue ledger (round 10 — THE SHELF MARK GOES
    // ON THE CLOSING GESTURE'S ROW), read under the write lock with the rest.
    const ledgerSince = opts?.ledgerSince != null && Number.isFinite(Number(opts.ledgerSince))
      ? Number(opts.ledgerSince) : issueLedgerWatermark(db);
    for (const it of items) {
      // A ROUTED LINE NEVER MOVES ON THIS RAIL (owner rulings #45 + #74). A
      // Direct Issue rule sends its material straight to the routed department,
      // which hands it to this party's department by department transfer — that
      // transfer is the movement, and it is what wrote the line's
      // quantity_issued (routed-requisitions.ts syncRoutedLine). Debiting
      // central for it here as well would count the goods twice and take from a
      // store that never held them. Skipped FIRST — before the moved pool, the
      // floor and the decline record — so it leaves no trace on this rail at
      // all; the line is still costed on the party's P&L from quantity_issued
      // (party-liquor.ts), exactly as a store-issued party line.
      if (String(it.routed_dept || '') !== '') continue;
      const issuedReq = Number(it.quantity_issued) || 0; // in ri.unit
      if (issuedReq <= 0) continue;
      const prior = takenBy.get(String(it.material_id));
      // What this line already moved (top-up only; 0 on a first run), in the
      // line's unit through the floor's own factor. Nothing left above it — a
      // line moved in full before, or lowered since — and the line is skipped
      // outright: no floor call, no decline row, no write.
      let movedLine = 0;
      if (already) {
        const mat = String(it.material_id);
        const pool = movedLeft.get(mat) || 0;
        const { factor } = lineFactor(it.req_unit, it);
        const lineRecipe = Math.round(issuedReq * (factor || 1) * 1e6) / 1e6;
        const movedRecipe = Math.min(pool, lineRecipe);
        movedLeft.set(mat, Math.max(0, pool - movedRecipe));
        if (Math.round((lineRecipe - movedRecipe) * 1e6) <= 0) continue;
        movedLine = movedRecipe / (factor || 1);
        topUpLines++;
      }
      // The desk's base is passed through only where it differs from the part
      // already moved: when the box adds to exactly that (the ordinary top-up —
      // the line holds what moved, and the gesture adds the tail), the floor's
      // own before→after sentence and cap already speak for that box.
      const deskIn = opts?.deskBeforeLineQty?.get(String(it.id));
      const deskBase = movedLine > 0 && deskIn != null && Math.abs(deskIn - movedLine) <= 1e-9 ? undefined : deskIn;

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
      // A TOP-UP (round 9) asks from the part already moved, not from 0.
      //
      // ASKED, NOT ASSERTED (round 10): the decision is checkCentralIssue's —
      // the very function assertCentralIssue throws on — so a line the floor
      // refuses can be told apart from a top-up the shelf cannot cover (see "A
      // TOP-UP THE SHELF CANNOT COVER" in the header) and every short line can
      // be named before the transfer refuses. The refusal's own sentence is
      // still assertCentralIssue's, sibling wording included.
      const c = checkCentralIssue(db, {
        reqItemId: String(it.id),
        beforeLineQty: movedLine,
        afterLineQty: issuedReq,
        rail: 'party',
        deskBeforeLineQty: deskBase,
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

      // ── A LINE THE FLOOR REFUSES ─────────────────────────────────────────
      // Either a top-up the shelf cannot cover that must not block (the two
      // shapes in "A TOP-UP THE SHELF CANNOT COVER": a remainder below one
      // printed step, or a line this gesture did not touch) — which takes what
      // the shelf holds and records what left — or a refusal, collected so
      // every short line is named (round 10).
      let kind: PartyShelfRecord['kind'] | null = null;
      let issued: number;
      let recordLine: number;
      if (c.ok) {
        // RECIPE units, and the floor's own figure — never a second
        // multiplication. debitRecipe, not requestedRecipe: the floor accepts
        // "everything on the shelf" on the balance's 6-dp grid point, and on
        // that ask the figure to subtract is the balance itself, so the write
        // lands on exactly 0 rather than -4e-7 (planCentralDebit,
        // src/lib/central-debit-clamp.ts). Identical to requestedRecipe on
        // every other ask. The department credit and the movement row below
        // carry the same figure, so the two rails still agree.
        issued = c.debitRecipe;
        recordLine = c.recordAfterLineQty;
        if (recordLine !== issuedReq) kind = 'shown';
      } else {
        const topUp = movedLine > 0;
        // Below ONE PRINTED STEP: 0.001 of the purchase unit, in recipe units,
        // on the house grid — the step THE RULE's shelf arm measures against.
        const subStep = topUp && qtyGrid(c.requestedRecipe) < qtyGrid(0.001 * (c.purchasePackFactor || 1));
        const untouched = topUp && !!opts?.gestureIssuedIds && !opts.gestureIssuedIds.has(String(it.id));
        if (!subStep && !untouched) {
          // A REFUSAL. Its sentence is the floor's own (assertCentralIssue,
          // the sibling wording when an earlier line of the same material took
          // from the shelf first). Nothing is debited for it; the walk goes on
          // so the next short line is named too, and the whole transfer is
          // refused once it is done.
          try {
            assertCentralIssue(db, {
              reqItemId: String(it.id), beforeLineQty: movedLine, afterLineQty: issuedReq, rail: 'party',
              siblingRecipe: prior?.recipe || 0, siblingLines: prior?.lines || 0, deskBeforeLineQty: deskBase,
            });
            shorts.push(new CentralStockShort(c));
          } catch (e) {
            if (!isCentralStockShort(e)) throw e;
            shorts.push(e as CentralStockShort);
          }
          shortBlocks.push(!(movedLine > 0) || !opts?.gestureIssuedIds);
          continue;
        }
        // WHAT THE SHELF HOLDS, AND NO MORE. On a refusal the floor's debit is
        // max(0, balance) — "what an unattended rail may clamp to" (issue-stock
        // CentralIssueCheck.debitRecipe) — so the write lands on exactly 0 and
        // never below it; 0 when the shelf is empty. The line records the part
        // already moved plus this, in its own unit.
        issued = Math.max(0, Number(c.debitRecipe) || 0);
        recordLine = movedLine + issued / (c.packFactor || 1);
        kind = subStep ? 'substep' : 'short';
      }
      const deptId: string | null = it.department_id || req.department_id || null;
      takenBy.set(String(it.material_id), {
        recipe: (prior?.recipe || 0) + issued, lines: (prior?.lines || 0) + 1,
      });

      // THE LINE SAYS WHAT LEFT THE SHELF (round 7). recordAfterLineQty is the
      // floor's own answer: the line's figure untouched on every ordinary
      // transfer, the balance (in the line's unit) when the shown-figure rule
      // took it instead — and (round 10) the part already moved plus what the
      // shelf held, on a top-up it could not cover. Written before the debit
      // only because the debit does not read the line; both are inside this
      // one transaction.
      if (kind && recordLine !== issuedReq
          && recordPartyShelfTake(db, {
            reqItemId: String(it.id), askedLineQty: issuedReq,
            recordLineQty: recordLine, actor: actorEmail,
          })) {
        recorded.push({
          req_item_id: String(it.id), material_id: String(it.material_id),
          material_name: String(c.materialName || ''), line_unit: String(it.req_unit ?? ''),
          asked_line_qty: issuedReq, recorded_line_qty: recordLine, debit_recipe: issued,
          kind, moved_line_qty: movedLine,
        });
      }

      // STORE: decrement current_stock + ledger row. Nothing to subtract when a
      // top-up the shelf could not cover met an empty shelf.
      if (issued > 0) decStock.run(issued, it.material_id);
      // THE RULE'S MEMORY (round 8). Did THIS take empty the shelf? Read
      // straight after the debit: a party line it closed by the shelf — the take
      // emptied the material and what the line still owes is below one printed
      // step (14.842 of 14.843 kg typed over 14,842.4 g, recorded 14.8424) — is
      // stamped complete (stampShelfClose), so the status the caller decides
      // AFTER this transfer reads it complete, and so does every later reader.
      const stamp = stampShelfClose(db, String(it.id), centralShelfEmpty(db, String(it.material_id)));
      // And on the ledger row that now carries the line's figure (the
      // party_shelf correction, or the issue row moved unchanged), as history
      // a later undo cannot retire (round 8b, markLedgerShelfClose) — a row OF
      // THIS GESTURE only (round 10, `ledgerSince`): when the gesture wrote
      // none for the line, an earlier gesture's row keeps what it truly was.
      if (stamp.byShelf) markLedgerShelfClose(db, String(it.id), null, null, ledgerSince);
      if (!(issued > 0)) continue;
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
    // THE REFUSAL, WHOLE — and naming every line it could not move (round 10).
    // Thrown inside the transaction, so every debit, credit and correction the
    // walk wrote for the other lines unwinds with it: not a gram moves.
    if (shorts.length > 0) {
      // ── A SHORT LINE THAT BLOCKS ANOTHER (final pass) ──────────────────────
      // Each refusal's own sentence offers its line's way forward — a cap, an
      // undo-and-reissue. Taken alone, that moves nothing while another short
      // line that would refuse again stays in the transfer (round-10 recheck,
      // two-short: "Issue 5.158 kg or less on this line" for THREE MANGO,
      // refused again over WHOLE DHANIYA). So each sentence names those lines
      // (CentralStockShort.nameBlockers). Words only: the refusal, its rows and
      // their caps are unchanged; a lone short line reads exactly as before.
      if (shorts.length > 1) {
        shorts.forEach((s, i) => {
          const names = shorts
            .filter((o, j) => j !== i && shortBlocks[j])
            .map(o => String(o.materialId) === String(s.materialId)
              ? (o.materialName ? `the other ${o.materialName} line` : 'the other line of this item')
              : (o.materialName || 'another line'));
          s.nameBlockers(names);
        });
      }
      const first = shorts[0];
      first.others = shorts.slice(1);
      throw first;
    }
    if (already && topUpLines === 0) {
      // A repeat call with nothing left above what already moved: the old skip,
      // to the letter — not one row written.
      console.log(`[party-fulfillment] requisition ${reqId} already transferred — skip`);
      return false;
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
      const fig = (r: PartyShelfRecord) => `${r.material_name || r.material_id} ${r.asked_line_qty} → ${r.recorded_line_qty}`
        + `${r.line_unit ? ` ${r.line_unit}` : ''}`;
      // Every correction the shown-figure rule made reads exactly as before;
      // a top-up the shelf could not cover (round 10) says so per line.
      const why = (r: PartyShelfRecord) => r.kind === 'substep'
        ? ' (less than one printed step was still to move and the central store held no more, so the line closes)'
        : r.kind === 'short'
          ? ' (the central store could not cover what the line held above what had already moved; the line stays open)'
          : '';
      const allShown = recorded.every(r => r.kind === 'shown');
      logAuditEvent(db, {
        event_type: 'requisition.party_transfer.shelf',
        entity_type: 'requisition',
        entity_id: reqId,
        actor_email: actorEmail,
        // The round-7 row, field for field, when only the shown-figure rule spoke.
        after: { lines: allShown ? recorded.map(({ kind: _k, moved_line_qty: _m, ...r }) => r) : recorded },
        note: allShown
          ? `Party transfer took what the central store held on ${recorded.length} line(s) typed at the `
            + `store's shown figure; each line now records what left the shelf (the typed figure is kept as asked): `
            + recorded.map(fig).join(', ')
          : `Party transfer took what the central store held on ${recorded.length} line(s); each line now records `
            + `what left the shelf (the figure it held is kept as asked): `
            + recorded.map(r => `${fig(r)}${why(r)}`).join(', '),
      });
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
