/**
 * THE single writer of stock for a requisition issue, and — since the
 * traceability work — THE single recorder of one too. Those are two different
 * jobs and this file is now careful to keep them apart.
 *
 * The owner's rule is "stock is deducted once, at issue": goods leaving the
 * central store on a requisition debit raw_materials.current_stock and credit
 * the receiving DEPARTMENT's ledger. Nothing else in this codebase may move
 * stock for a requisition — every writer of requisition_items.quantity_issued
 * calls applyIssueDelta() instead of rolling its own.
 *
 * ── THE FLAG IS GONE. THE DEDUCT IS UNCONDITIONAL. ─────────────────────────
 * The old deduct-at-issue setting key no longer gates anything. Nothing in this
 * file — or anywhere else — reads it. Its settings ROW is deliberately LEFT IN
 * THE TABLE, inert and ignored: deleting admin-owned state inside a deploy is
 * not this change's business, and scripts/check-boot-migrations.js exists to
 * stop exactly that. The key is named once, in the db.ts comment that marks the
 * row inert, and NOWHERE ELSE ON PURPOSE — this file is grep-clean of it so a
 * reviewer can prove in one command that no functional read survived. Do not
 * reintroduce one, and do not "restore" the toggle: a switch that writes a key
 * nothing consults is worse than no switch at all.
 *
 * THIS EDIT CANNOT BE SPLIT ACROSS COMMITS OR DEPLOYS. Recipe consumption at
 * KOT-complete (src/lib/db.ts applyDeduct) used to debit central too, and all
 * 131 recipe-ingredient materials are ALSO requisition-issued. Removing the
 * flag here while applyDeduct still points at central removes every gram
 * twice — once leaving the store, once being cooked. The two edits ship
 * together or not at all.
 *
 * ── ALWAYS RECORD, GATE ONLY THE DEDUCT ────────────────────────────────────
 * READ THIS BEFORE YOU "SIMPLIFY" ANYTHING BELOW.
 *
 * The deduct is unconditional but not universal: three cases still hand goods
 * over WITHOUT this rail moving a gram — party requisitions (their own rail),
 * store-mapped/liquor materials (the TGBCL store ledger), and an ambiguous
 * line unit (we refuse to guess). The ledger row is written on EVERY issue in
 * ALL of those cases. The hand-over is a real event and the owner's log must
 * see it; only the stock write is skipped, and the row says why on its face.
 *
 * That is why there are still two quantity columns, and why they are not
 * interchangeable:
 *
 * ── TWO QUANTITIES, TWO CLAMPS ─────────────────────────────────────────────
 *   delta_recipe_qty     recipe units THIS CALL ACTUALLY REMOVED from
 *                        raw_materials.current_stock. 0 whenever no stock moved.
 *                        Sole input to the stock credit clamp, and the sole
 *                        input to lineHasMovedStock()/requisitionHasMovedStock().
 *   recorded_recipe_qty  recipe units PHYSICALLY HANDED OVER on this call,
 *                        written whether or not stock moved. The end-to-end log
 *                        reads this and only this.
 *
 * Writing the hand-over into delta_recipe_qty instead — the obvious "why two
 * columns?" simplification — MANUFACTURES STOCK: a line handed over on a path
 * that moved nothing (party, liquor, or any of the 14,148 pre-ledger lines)
 * would carry a positive delta_recipe_qty with no debit behind it, so the
 * credit clamp would happily give it back on undo. That is the measured ALMOND
 * bug (g/kg, pack 1000: current_stock 4,000 -> 5,000, the department balance to
 * -1,000) restated in a new costume.
 *
 * Each quantity is therefore clamped against ITS OWN running sum, so neither
 * can run past zero and neither can borrow the other's history.
 *
 * SUM(delta_recipe_qty) <= SUM(recorded_recipe_qty), always, per req_item_id.
 *
 * stock_applied (1 iff this row moved stock) is still stamped for the log's
 * benefit, but the has-stock-moved guards no longer key on it — see their doc
 * comment for the deadlock that caused.
 *
 * ── ONE DEPARTMENT BALANCE, DERIVED FROM ONE LEDGER ────────────────────────
 * The credit goes through postDeptLedger() in src/lib/dept-ledger.ts, which
 * owns department_material_transactions (the truth: SUM of signed quantity,
 * anchored on the cutover/closing count) and maintains department_materials
 * .on_hand as a CACHE. computeDeptStock() in dept-stock.ts reads that same
 * ledger. There is now exactly ONE derivation of a department balance in this
 * codebase; the old warning here — that computeDeptStock derived its own from
 * requisition_items and must not also add on_hand, or every issue counts twice
 * — is retired because the second derivation is gone. Do not bring it back.
 *
 * ── THE CALLER CONTRACT ────────────────────────────────────────────────────
 * Unchanged. Callers pass the BEFORE and AFTER line quantities and this
 * computes the delta. That is what makes one helper correct for both writers,
 * which disagree about what they store:
 *
 *   store-issue    is INCREMENTAL  (quantity_issued + addQty)
 *   store-process  is ABSOLUTE     (SET quantity_issued = ?)
 *
 * A replayed absolute write therefore yields delta 0 and writes nothing — not
 * even a ledger row, because the zero-delta gate runs FIRST, before any clamp
 * or insert. That ordering is a correctness requirement, not tidiness:
 * store-process's loop is deliberately unfiltered and rewrites EVERY line
 * including the omitted and chef-rejected ones, so a gate placed after the
 * insert would emit a junk row per untouched line on every process. An undo,
 * which zeroes the column, still yields the exact negative of what was issued.
 *
 * Two rules the caller MUST honour:
 *   1. Read `beforeLineQty` INSIDE the same transaction, immediately before the
 *      UPDATE. Reading it earlier races; reading it after is impossible —
 *      undo and reject zero quantity_issued and blank issue_history in the same
 *      statement, destroying the pre-image.
 *   2. Call inside your own transaction. This function never opens one, so its
 *      writes roll back with yours — which is the whole mechanism behind the
 *      reversal guard below: it THROWS, and your transaction unwinds.
 *
 * ── THE INVARIANTS ─────────────────────────────────────────────────────────
 * For any req_item_id, neither SUM(delta_recipe_qty) nor
 * SUM(recorded_recipe_qty) is ever negative. The first equals the net recipe
 * quantity this rail has removed from the store; the second equals the net
 * recipe quantity this rail has recorded as handed over.
 *
 * Two mechanisms hold them up, one per direction:
 *   - Debits and records alike are anchored by baseline_line_qty, stamped only
 *     on the first row for a line from whatever quantity_issued already held.
 *     Forward-only is therefore structural: the 14,148 lines of history ARE the
 *     baseline, so a fresh issue against an old requisition moves and records
 *     only the increment.
 *   - Credits are clamped to the matching running total, so undo/reject can
 *     only ever give back what was actually taken (stock) or actually recorded
 *     (log). Without the record clamp, undoing one of those 14,148 pre-existing
 *     quantity_issued values would log a department issuing minus 1,000 g out
 *     of nowhere.
 *
 * A THIRD mechanism now sits on top of the stock clamp, and it is not a clamp:
 * the department must actually still HOLD the goods. See assertReversible.
 *
 * pack_factor is stored per row so the log can reverse each row's conversion
 * with the factor ACTUALLY USED — a later Unit Audit rebase changes a
 * material's factor, and the pre-ledger remainder arithmetic in the end-to-end
 * log depends on that reversal being exact.
 */
import { packFactor } from '@/lib/pack-units';
import { generateId } from '@/lib/db';
import { centralFlowBlock } from '@/lib/store-engine';
import { postDeptLedger, assertReversible } from '@/lib/dept-ledger';

export interface IssueDeltaInput {
  reqItemId: string;
  beforeLineQty: number;
  afterLineQty: number;
  /** issue | store_process | undo | store_reject | admin_adjust */
  reason: string;
  actor?: string;
  /** Per-gesture token. Present => a replay collides on uq_req_issue_token_item. */
  clientToken?: string | null;
}

export interface IssueDeltaResult {
  /** Did STOCK move? A recorded-but-not-deducted issue is applied === false. */
  applied: boolean;
  /**
   * Why STOCK did not move, when applied === false. Mirrors the row's
   * skip_reason. Note that 'party' / 'store_mapped' / 'unit_review' do NOT mean
   * "nothing was written" — a ledger row is still recorded; see the header.
   */
  skipped?: 'party' | 'store_mapped' | 'unit_review' | 'zero_delta' | 'missing_line';
  /** Recipe units removed from current_stock — 0 unless applied. */
  deltaRecipeQty?: number;
  /** Recipe units recorded as handed over, deducted or not. */
  recordedRecipeQty?: number;
  packFactor?: number;
  ledgerId?: string;
  needsUnitReview?: boolean;
}

/**
 * Float slack. Declared up here because the has-stock-moved guards below now
 * compare a SUM against it, not just the arithmetic further down.
 */
const EPS = 1e-9;

/**
 * Has this line moved stock ON NET, right now? Destructive edits (cancel,
 * chef-reject, requisition PUT, which deletes and reinserts lines with new ids)
 * must refuse on such a line, because they would orphan the ledger and strand
 * the stock.
 *
 * THE SUM IS LOAD-BEARING, AND SO IS THE COLUMN IT SUMS. DO NOT REVERT EITHER.
 *
 * This used to be `EXISTS(... AND stock_applied = 1)`. That reads as "did stock
 * EVER move", which is a different question and creates a dead end: insertLedger
 * stamps stock_applied = 1 whenever deltaRecipe != 0, and a REVERSAL row has a
 * non-zero (negative) delta too. So a line that was issued and then fully undone
 * — every gram back in the store, net zero — stays permanently "moved", and
 * cancel / PUT / chef-reject refuse forever. Worse, the escape hatch
 * api/requisitions/[id]/cancel:51 offers ("undo the issued lines first") is the
 * very action that created the blocking row, so the advice can never work.
 *
 * It MUST be delta_recipe_qty and NEVER recorded_recipe_qty. recorded is
 * written on hand-overs that moved no stock at all — party lines, store-mapped
 * liquor, and every pre-cutover hand-over — so summing it would start refusing
 * these four daily operations on lines where not one gram left central:
 *
 *   api/requisitions/route.ts:496            PUT (deletes and reinserts lines)
 *   api/requisitions/[id]/cancel:49          cancel
 *   api/requisitions/[id]/items/[itemId]:83  chef reject
 *   api/requisitions-import (documented in that file's header)
 *
 * Provable no-op on today's data: requisition_issue_ledger holds 1 row, with
 * delta_recipe_qty 0.0 and stock_applied 0, and the 14,149 imported issued lines
 * have no ledger row at all. Old form and new form both return false for every
 * line in the database.
 */
export function lineHasMovedStock(db: any, reqItemId: string): boolean {
  try {
    const row = db.prepare(
      `SELECT COALESCE(SUM(delta_recipe_qty), 0) AS net FROM requisition_issue_ledger WHERE req_item_id = ?`,
    ).get(reqItemId) as any;
    return (Number(row?.net) || 0) > EPS;
  } catch { return false; }
}

/** Same question for a whole requisition. The net-sum reasoning above applies verbatim. */
export function requisitionHasMovedStock(db: any, reqId: string): boolean {
  try {
    const row = db.prepare(
      `SELECT COALESCE(SUM(delta_recipe_qty), 0) AS net FROM requisition_issue_ledger WHERE req_id = ?`,
    ).get(reqId) as any;
    return (Number(row?.net) || 0) > EPS;
  } catch { return false; }
}

/**
 * The LINE -> RECIPE conversion, Option B.
 *
 * requisition_items quantities are stored in the LINE's own `unit` column;
 * current_stock is always recipe units. packFactor is IMPORTED, never
 * re-derived: the three hand-rolled copies elsewhere in this repo
 * (party-fulfillment.ts, purchase-orders/[id]/receive, dept-stock.ts) each drop
 * or weaken half of the "pack_size > 1 AND recipe unit !== purchase unit" rule,
 * which is how PICKLED GINGER 1.5KG (kg/kg, pack 1.5) ends up divided.
 *
 * The BLANK-unit case is the one genuine fork in this codebase: dept-stock and
 * department-consumption read blank as the PURCHASE basis (x pack), while
 * party-fulfillment reads it as recipe (x1). Rather than pick a side and be
 * silently wrong on someone else's screen, a blank unit on a packed material
 * refuses to move stock and is flagged for review. Only 3 live lines are both
 * blank-unit and pack_size > 1, so the cost of refusing is tiny and the cost of
 * guessing is a 750x stock error.
 */
export function lineFactor(
  lineUnit: string | null | undefined,
  rm: { unit?: string | null; purchase_unit?: string | null; pack_size?: number | null },
): { factor: number; needsReview: boolean } {
  const pf = packFactor({ unit: rm.unit, purchase_unit: rm.purchase_unit, pack_size: rm.pack_size });
  if (pf <= 1) return { factor: 1, needsReview: false };

  const lu = String(lineUnit ?? '').toLowerCase().trim();
  const pu = String(rm.purchase_unit ?? '').toLowerCase().trim();
  const ru = String(rm.unit ?? '').toLowerCase().trim();

  if (lu === '') return { factor: 1, needsReview: true };   // ambiguous — refuse, see above
  if (lu === pu) return { factor: pf, needsReview: false };  // line is in purchase units
  if (lu === ru) return { factor: 1, needsReview: false };   // line is already recipe units
  return { factor: 1, needsReview: true };                   // unrecognised unit — refuse
}

export function applyIssueDelta(db: any, input: IssueDeltaInput): IssueDeltaResult {
  // quantity_requested and chef_approved_qty are read HERE rather than passed
  // in, which is what keeps store-issue — the hottest, most carefully reasoned
  // route in the store — at a zero diff for this change. Safe because neither
  // caller's UPDATE touches either column: updIssue/updIssuePartial/updUndo/
  // updReject set quantity_issued, the issued_* pair, the defer pair and
  // issue_history; store-process sets quantity_issued and quantity_to_purchase.
  //
  // department_id is RESOLVED IN SQL as COALESCE(line, requisition), matching
  // dept-stock.ts:182 and party-fulfillment.ts:119 — the line's own department
  // wins because a multi-department requisition splits its goods per line, and
  // crediting the header department would give the wrong kitchen the stock.
  // Provable no-op on today's data: 0 of the 14,149 issued lines have a line
  // department that differs from their requisition's, and 0 resolve to NULL.
  const line = db.prepare(`
    SELECT ri.id, ri.req_id, ri.material_id, ri.unit AS line_unit,
           ri.quantity_requested, ri.chef_approved_qty,
           r.purpose, r.outlet_id,
           COALESCE(ri.department_id, r.department_id) AS department_id,
           rm.unit, rm.purchase_unit, rm.pack_size
      FROM requisition_items ri
      JOIN requisitions  r  ON r.id  = ri.req_id
      JOIN raw_materials rm ON rm.id = ri.material_id
     WHERE ri.id = ?
  `).get(input.reqItemId) as any;
  if (!line) return { applied: false, skipped: 'missing_line' };

  // Party requisitions already deduct at fulfilment, from three separate
  // implementations that all dedup on inventory_transactions.type =
  // 'party_consumption'. A row typed 'requisition_issue' walks straight past
  // those guards, so the only safe move is to leave the party rail's STOCK
  // alone — central AND department. The hand-over itself is still a real
  // hand-over and belongs in the owner's log, so it is recorded with
  // skip_reason 'party'.
  const isParty = String(line.purpose || '') === 'party';

  // LIQUOR CARVE-OUT. Store-mapped materials live on the TGBCL store ledger
  // (store_stock_ledger / store_locations) and every other central writer
  // already refuses them via centralFlowBlock. This used to be a PASSIVE stamp:
  // the debit happened anyway and the row was merely marked for someone to
  // reconcile later. Under department stock that is the one outcome worse than
  // doing nothing — it takes the gram out of central and gives it to nobody,
  // so the material simply evaporates from both rails. So the flag now GATES
  // BOTH SIDES: no central debit, no department credit, one honest ledger row
  // stamped store_mapped. If you are tempted to "restore" the debit because
  // liquor stock looks wrong on the central screen, fix it on the store rail.
  let storeMapped = false;
  try { storeMapped = centralFlowBlock(db, String(line.material_id)) !== null; } catch { /* not fatal */ }

  const { factor, needsReview } = lineFactor(line.line_unit, line);
  const deltaLine = (Number(input.afterLineQty) || 0) - (Number(input.beforeLineQty) || 0);
  const deltaRecipe = Math.round(deltaLine * factor * 1e6) / 1e6;

  // THE ZERO-DELTA GATE RUNS FIRST, before any clamp, any stock write and any
  // insert. store-process rewrites every line on every process, including the
  // ones the client omitted and the ones the chef rejected; without this gate
  // sitting ahead of the insert, each of those untouched lines would drop a
  // junk ledger row and the owner's log would be noise on day one. It is also
  // what makes a replayed absolute write a literal no-op rather than a
  // duplicate record.
  if (Math.abs(deltaLine) < EPS) return { applied: false, skipped: 'zero_delta', packFactor: factor };

  // ── THE RECORD: always, on every path ─────────────────────────────────────
  // An ambiguous unit records 0 for the same reason it deducts 0 — we do not
  // know whether the line means grams or kilos, and a 750x number in the log is
  // worse than a gap in it. The row's own quantities stay honest either way.
  let recordQty = needsReview ? 0 : deltaRecipe;
  if (recordQty < 0) {
    // The record's own credit clamp, against the record's own running sum.
    // NOT the stock clamp below and NOT interchangeable with it: undoing one of
    // the 14,148 lines that carried quantity_issued from before this shipped
    // must record nothing, because nothing was ever recorded as handed over.
    // Sharing one clamp between the two columns is how stock gets manufactured
    // — see the ALMOND note in the header.
    const recRow = db.prepare(
      `SELECT COALESCE(SUM(recorded_recipe_qty), 0) AS recorded FROM requisition_issue_ledger WHERE req_item_id = ?`,
    ).get(input.reqItemId) as any;
    const recorded = Number(recRow?.recorded) || 0;
    if (recorded + recordQty < -EPS) recordQty = -recorded;
    if (Math.abs(recordQty) < EPS) recordQty = 0;
  }

  // ── THE DEDUCT: unconditional, minus the three carve-outs ─────────────────
  let stockQty = 0;
  if (!isParty && !storeMapped && !needsReview) {
    stockQty = deltaRecipe;
    // NEVER GIVE BACK MORE THAN THIS RAIL TOOK.
    //
    // baseline_line_qty anchors the first row, but it does not stop a CREDIT
    // from running past zero. A line that already carried quantity_issued from
    // before the cutover has had nothing debited here — yet undo/reject set
    // quantity_issued = 0, producing a negative delta and manufacturing stock
    // that never left the store. Measured on ALMOND (g/kg, pack 1000) with a
    // pre-cutover quantity_issued of 1: current_stock went 4,000 -> 5,000 g and
    // the department balance went to -1,000. This clamp is what keeps the
    // 14,148 pre-ledger lines safe to undo, so it stays whatever else changes.
    //
    // So the credit is clamped to the running total this rail has actually
    // moved for the line. The property that keeps stock honest is therefore:
    //
    //   SUM(delta_recipe_qty) for a req_item_id is never negative, and equals
    //   the net recipe quantity this rail has removed from the store.
    //
    // Debits are never clamped — only the giving-back direction.
    const takenRow = db.prepare(
      `SELECT COALESCE(SUM(delta_recipe_qty), 0) AS taken FROM requisition_issue_ledger WHERE req_item_id = ?`,
    ).get(input.reqItemId) as any;
    const taken = Number(takenRow?.taken) || 0;
    if (stockQty < 0 && taken + stockQty < -EPS) stockQty = -taken;
    if (Math.abs(stockQty) < EPS) stockQty = 0;
  }

  let invTxnId: string | null = null;
  if (stockQty !== 0) {
    // A DEBIT WITHOUT A CREDIT DESTROYS A GRAM SILENTLY, so the department is
    // resolved and validated BEFORE central is touched. 0 of the 14,149 issued
    // lines resolve to NULL today, so this throws for nobody — it exists so
    // that a future requisition created without a department fails loudly at
    // the store counter instead of quietly evaporating stock. Do not soften it
    // back into an early return.
    if (!line.department_id) {
      throw new Error(
        `Requisition line ${input.reqItemId} has no department — stock cannot leave the central store ` +
        `without a receiving department. Set the department on the requisition and try again.`,
      );
    }

    if (stockQty < 0) {
      // REVERSALS REFUSE, THEY DO NOT CLAMP.
      //
      // The clamp above answers "did this rail take that much from central".
      // This answers the other half: "does the department still HOLD it". If a
      // KOT already cooked the goods, putting them back in the store would
      // invent stock in one place and drive the department negative in the
      // other.
      //
      // It must THROW, not clamp. Every caller has ALREADY written
      // quantity_issued before calling us (store-issue:277->278 and :289->290,
      // store-process:384->394), so a silent clamp commits a line reading
      // "0 issued" against grams that never came back — the two rails diverge
      // with nothing on screen to show it. A throw unwinds the caller's
      // transaction (we never open one; see the caller contract), so
      // quantity_issued stays exactly as it was. store-issue already relies on
      // this same pattern at :368-387 for the status race.
      //
      // The cap is POOLED per (department, material), not per line, because
      // without lot tracking the goods genuinely are fungible: requisition A's
      // consumption can legitimately block requisition B's reversal. That is
      // physically correct, which is why dept-ledger's message says "the
      // department holds only X" and never "you consumed this line".
      // `qty` is the POSITIVE magnitude we want to push back to central.
      // reqItemId is passed so dept-ledger can apply its per-line cap too: it
      // recomputes the same SUM(delta_recipe_qty) the clamp above used, which
      // is belt-and-braces rather than duplication — the clamp keeps this call
      // honest, and the cap keeps a future caller that forgets the clamp honest.
      assertReversible(db, {
        reqItemId: input.reqItemId,
        departmentId: String(line.department_id),
        materialId: String(line.material_id),
        qty: -stockQty,
      });
    }

    // Positive delta = goods left the store.
    db.prepare(`UPDATE raw_materials SET current_stock = current_stock - ? WHERE id = ?`)
      .run(stockQty, line.material_id);

    invTxnId = generateId();
    db.prepare(`
      INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, outlet_id)
      VALUES (?, ?, 'requisition_issue', ?, ?, ?, ?)
    `).run(invTxnId, line.material_id, -stockQty, line.req_id,
           `Requisition issue (${input.reason})`, line.outlet_id || null);
  }

  // Nothing to record and nothing moved. The live case is an undo of one of the
  // 14,149 pre-ledger issues: the record clamp took it to 0, and writing a row
  // of two zeroes would only teach the log that a department gave back
  // something it was never logged as receiving.
  //
  // ONE CARVE-OUT: an ambiguous unit. Its two quantities are 0 by refusal, not
  // by absence — a real hand-over happened and we declined to put a number on
  // it. That is precisely the thing the owner needs shown to him, so the row is
  // written with needs_unit_review = 1 and both quantities 0, exactly as the
  // pre-change code did. Dropping it would silently retire the only surface
  // that ever names the 3 blank-unit packed lines. Note the ordering still
  // holds: a REPLAY of such a line is zero-delta and was already gated out
  // above, so this cannot reintroduce the junk-row-per-process problem — the
  // old code, which had no zero-delta gate ahead of it, wrote one of these on
  // every single process.
  if (recordQty === 0 && stockQty === 0 && !needsReview) {
    return { applied: false, skipped: 'zero_delta', packFactor: factor };
  }

  // effective_line_qty is SNAPSHOTTED, not recomputed on read. FULL vs PART is
  // a fact about what the store did that morning; a chef editing
  // chef_approved_qty next week must not retro-rewrite it. (The owner's case:
  // 7 kg requested, 5 kg issued.)
  const effectiveLineQty = line.chef_approved_qty != null
    ? (Number(line.chef_approved_qty) || 0)
    : (Number(line.quantity_requested) || 0);

  // Why no stock moved, stamped on the row's own face, in precedence order.
  // party and store_mapped are PERMANENT facts about the rail; unit_review is a
  // fixable data problem, so it comes last — telling a storekeeper to fix a
  // unit on a liquor line would send him after a deduct that is never coming.
  const skipReason = isParty ? 'party' : storeMapped ? 'store_mapped' : needsReview ? 'unit_review' : '';

  const ledgerId = insertLedger(db, input, line, {
    factor, deltaLine, deltaRecipe: stockQty, recordedRecipe: recordQty,
    needsReview, invTxnId, storeMapped, effectiveLineQty, skipReason,
  });

  if (stockQty !== 0) {
    // THE MIRROR OF THE CENTRAL DEBIT. Signed, in RECIPE units: positive = into
    // the department, negative = back out of it. The TYPE is what the audit
    // reads and the SIGN is what the balance sums — they are stamped separately
    // on purpose, because the old code wrote type 'issued' with a negative
    // quantity for a reversal and any report grouping by type or summing
    // ABS(quantity) read a give-back as another issue.
    postDeptLedger(db, {
      outletId: line.outlet_id || null,
      departmentId: String(line.department_id),
      materialId: String(line.material_id),
      type: stockQty > 0 ? 'issued' : 'issue_reversal',
      quantity: stockQty,
      referenceId: line.req_id,
      reqItemId: input.reqItemId,
      source: 'requisition_issue',
      notes: `Requisition issue (${input.reason})`,
      user: input.actor || '',
    });
  }

  return {
    applied: stockQty !== 0,
    ...(stockQty === 0
      ? { skipped: (skipReason || 'zero_delta') as IssueDeltaResult['skipped'] }
      : {}),
    deltaRecipeQty: stockQty,
    recordedRecipeQty: recordQty,
    packFactor: factor,
    ledgerId,
    // store-process turns this into result.issue_unit_review. Now that the
    // deduct is unconditional, a refused line is always worth reporting.
    ...(needsReview ? { needsUnitReview: true } : {}),
  };
}

function insertLedger(
  db: any, input: IssueDeltaInput, line: any,
  o: {
    factor: number; deltaLine: number;
    /** RECIPE units actually removed from current_stock — 0 when nothing moved. */
    deltaRecipe: number;
    /** RECIPE units physically handed over, deducted or not. */
    recordedRecipe: number;
    needsReview: boolean; invTxnId: string | null; storeMapped?: boolean;
    effectiveLineQty: number; skipReason: string;
  },
): string {
  // baseline_line_qty marks the pre-existing quantity_issued the first time we
  // ever touch this line — the anchor that keeps history out of scope.
  const seen = db.prepare(`SELECT 1 FROM requisition_issue_ledger WHERE req_item_id = ? LIMIT 1`)
    .get(input.reqItemId) as any;
  const id = generateId();
  db.prepare(`
    INSERT INTO requisition_issue_ledger
      (id, req_id, req_item_id, material_id, department_id, outlet_id, reason,
       baseline_line_qty, before_line_qty, after_line_qty, delta_line_qty,
       line_unit, pack_factor, delta_recipe_qty, recorded_recipe_qty,
       stock_applied, effective_line_qty, skip_reason, store_mapped,
       needs_unit_review, inv_txn_id, client_token, actor)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, line.req_id, input.reqItemId, line.material_id,
    line.department_id || null, line.outlet_id || null, input.reason,
    seen ? null : (Number(input.beforeLineQty) || 0),
    Number(input.beforeLineQty) || 0, Number(input.afterLineQty) || 0, o.deltaLine,
    line.line_unit ?? null, o.factor, o.deltaRecipe, o.recordedRecipe,
    o.deltaRecipe !== 0 ? 1 : 0, o.effectiveLineQty, o.skipReason,
    o.storeMapped ? 1 : 0, o.needsReview ? 1 : 0,
    o.invTxnId, input.clientToken || null, input.actor || null,
  );
  return id;
}
