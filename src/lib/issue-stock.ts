/**
 * THE single writer of stock for a requisition issue, and — since the
 * traceability work — THE single recorder of one too. Those are two different
 * jobs and this file is now careful to keep them apart.
 *
 * The owner's rule is "stock is deducted once, at issue": goods leaving the
 * central store on a requisition debit raw_materials.current_stock and credit
 * the receiving department. Nothing else in this codebase may move stock for a
 * requisition — every writer of requisition_items.quantity_issued calls
 * applyIssueDelta() instead of rolling its own.
 *
 * ── ALWAYS RECORD, GATE ONLY THE DEDUCT ────────────────────────────────────
 * READ THIS BEFORE YOU "SIMPLIFY" ANYTHING BELOW.
 *
 * This function used to open with `if (!issueDeductionEnabled(db)) return`, so
 * settings key `requisition_deduct_at_issue` (shipped '0', still '0' in
 * production) made the WHOLE function a no-op. One flag was gating two
 * unrelated things, and the cost was measured: 14,148 requisition lines carry
 * quantity_issued > 0 and requisition_issue_ledger has ZERO rows. The store
 * hands goods to a kitchen every day and the database keeps no movement row of
 * it, so no purchase → requisition → issue → consumption log can be built.
 *
 * The flag now gates the DEDUCT only. The ledger row is written on EVERY issue
 * in BOTH flag states. Stock behaviour is exactly three writes — UPDATE
 * raw_materials, INSERT inventory_transactions, creditDepartment() — and all
 * three are driven by `stockQty`, which is 0 on every path while the flag is
 * off. So with the flag off nothing about stock changes, and a record appears.
 *
 * DO NOT collapse this back into one flag, and DO NOT "tidy" the two quantity
 * columns into one. Which brings us to the trap:
 *
 * ── TWO QUANTITIES, TWO CLAMPS ─────────────────────────────────────────────
 *   delta_recipe_qty     recipe units THIS CALL ACTUALLY REMOVED from
 *                        raw_materials.current_stock. 0 whenever no stock moved.
 *                        Sole input to the stock credit clamp. Meaning unchanged
 *                        from the day it was written.
 *   recorded_recipe_qty  recipe units PHYSICALLY HANDED OVER on this call,
 *                        written whether or not stock moved. The end-to-end log
 *                        reads this and only this.
 *
 * Writing the hand-over into delta_recipe_qty instead — the obvious "why two
 * columns?" simplification — passes every test today (flag off, nothing moves)
 * and then MANUFACTURES STOCK the first time the owner switches the flag on: a
 * line issued while the flag was off has a positive delta_recipe_qty behind it
 * with no debit, so the credit clamp happily gives it back on undo. That is the
 * measured ALMOND bug (g/kg, pack 1000: current_stock 4,000 -> 5,000, the
 * department balance to -1,000) restated in a new costume.
 *
 * Each quantity is therefore clamped against ITS OWN running sum, so neither
 * can run past zero and neither can borrow the other's history.
 *
 * SUM(delta_recipe_qty) <= SUM(recorded_recipe_qty), always, per req_item_id.
 *
 * stock_applied (1 iff this row moved stock) exists so the log can say which of
 * the two happened without inferring it from a setting whose value at the time
 * is unrecoverable — and because lineHasMovedStock()/requisitionHasMovedStock()
 * key on it. See their doc comment: that is not cosmetic, it is what stops four
 * daily operations from refusing the moment the first ledger row lands.
 *
 * WHY THE DEDUCT IS STILL OFF: recipe consumption at KOT-complete ALREADY
 * debits central current_stock (src/lib/db.ts applyDeduct, reached from the KDS
 * bump and the sales routes), and all 131 recipe-ingredient materials are also
 * requisition-issued. Turning this on before the sales side is repointed at
 * department balances would remove the same gram twice — once leaving the
 * store, once being cooked.
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
 *      writes roll back with yours.
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
 * pack_factor is stored per row so the log can reverse each row's conversion
 * with the factor ACTUALLY USED — a later Unit Audit rebase changes a
 * material's factor, and the pre-ledger remainder arithmetic in the end-to-end
 * log depends on that reversal being exact.
 */
import { packFactor } from '@/lib/pack-units';
import { generateId } from '@/lib/db';
import { centralFlowBlock } from '@/lib/store-engine';

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
   * skip_reason. Note that 'flag_off' / 'party' / 'unit_review' no longer mean
   * "nothing was written" — a ledger row is still recorded; see the header.
   */
  skipped?: 'flag_off' | 'party' | 'unit_review' | 'zero_delta' | 'missing_line';
  /** Recipe units removed from current_stock — 0 unless applied. */
  deltaRecipeQty?: number;
  /** Recipe units recorded as handed over, deducted or not. */
  recordedRecipeQty?: number;
  packFactor?: number;
  ledgerId?: string;
  needsUnitReview?: boolean;
}

/** Is deduct-at-issue switched on? Default OFF — see the file header. */
export function issueDeductionEnabled(db: any): boolean {
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'requisition_deduct_at_issue'`).get() as
      | { value: string } | undefined;
    return String(row?.value ?? '0') === '1';
  } catch { return false; }
}

/**
 * Has this line ever moved stock? Destructive edits (cancel, chef-reject,
 * requisition PUT, which deletes and reinserts lines with new ids) must refuse
 * on such a line, because they would orphan the ledger and strand the stock.
 *
 * `AND stock_applied = 1` IS LOAD-BEARING. DO NOT DROP IT.
 *
 * The question these two helpers ask has always been "has stock moved", never
 * "does a record exist" — the distinction simply did not exist while the flag
 * gated recording too, because then no ledger row could exist at all. Now a row
 * is written on every issue in both flag states, so a bare EXISTS would start
 * REFUSING four operations the owner performs daily, with the deduct flag still
 * off and not one gram moved:
 *
 *   api/requisitions/route.ts:496          PUT (deletes and reinserts lines)
 *   api/requisitions/[id]/cancel:49        cancel
 *   api/requisitions/[id]/items/[itemId]:83  chef reject
 *   api/requisitions-import (documented in that file's header)
 *
 * With the flag off no row carries stock_applied = 1, so all four behave
 * exactly as they do today; with the flag on they behave exactly as designed.
 */
export function lineHasMovedStock(db: any, reqItemId: string): boolean {
  try {
    const row = db.prepare(
      `SELECT 1 FROM requisition_issue_ledger WHERE req_item_id = ? AND stock_applied = 1 LIMIT 1`,
    ).get(reqItemId) as any;
    return !!row;
  } catch { return false; }
}

/** Same question for a whole requisition. The stock_applied filter above applies verbatim. */
export function requisitionHasMovedStock(db: any, reqId: string): boolean {
  try {
    const row = db.prepare(
      `SELECT 1 FROM requisition_issue_ledger WHERE req_id = ? AND stock_applied = 1 LIMIT 1`,
    ).get(reqId) as any;
    return !!row;
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

const EPS = 1e-9;

export function applyIssueDelta(db: any, input: IssueDeltaInput): IssueDeltaResult {
  // quantity_requested and chef_approved_qty are read HERE rather than passed
  // in, which is what keeps store-issue — the hottest, most carefully reasoned
  // route in the store — at a zero diff for this change. Safe because neither
  // caller's UPDATE touches either column: updIssue/updIssuePartial/updUndo/
  // updReject set quantity_issued, the issued_* pair, the defer pair and
  // issue_history; store-process sets quantity_issued and quantity_to_purchase.
  const line = db.prepare(`
    SELECT ri.id, ri.req_id, ri.material_id, ri.unit AS line_unit,
           ri.quantity_requested, ri.chef_approved_qty,
           r.purpose, r.department_id, r.outlet_id,
           rm.unit, rm.purchase_unit, rm.pack_size
      FROM requisition_items ri
      JOIN requisitions  r  ON r.id  = ri.req_id
      JOIN raw_materials rm ON rm.id = ri.material_id
     WHERE ri.id = ?
  `).get(input.reqItemId) as any;
  if (!line) return { applied: false, skipped: 'missing_line' };

  // Read ONCE, and used for NOTHING except gating the three stock writes. It is
  // no longer an early return: see "ALWAYS RECORD, GATE ONLY THE DEDUCT" in the
  // header before you move this line back to the top of the function.
  const deductOn = issueDeductionEnabled(db);

  // Party requisitions already deduct at fulfilment, from three separate
  // implementations that all dedup on inventory_transactions.type =
  // 'party_consumption'. A row typed 'requisition_issue' walks straight past
  // those guards, so the only safe move is to leave the party rail's STOCK
  // alone. The hand-over itself is still a real hand-over and belongs in the
  // owner's log, so it is recorded with skip_reason 'party'.
  const isParty = String(line.purpose || '') === 'party';

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

  // ── THE RECORD: always, in both flag states ───────────────────────────────
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
    // the day the deduct flag is switched on — see the header.
    const recRow = db.prepare(
      `SELECT COALESCE(SUM(recorded_recipe_qty), 0) AS recorded FROM requisition_issue_ledger WHERE req_item_id = ?`,
    ).get(input.reqItemId) as any;
    const recorded = Number(recRow?.recorded) || 0;
    if (recorded + recordQty < -EPS) recordQty = -recorded;
    if (Math.abs(recordQty) < EPS) recordQty = 0;
  }

  // ── THE DEDUCT: gated, and ONLY the deduct ────────────────────────────────
  let stockQty = 0;
  if (deductOn && !isParty && !needsReview) {
    stockQty = deltaRecipe;
    // NEVER GIVE BACK MORE THAN THIS RAIL TOOK.
    //
    // baseline_line_qty anchors the first row, but it does not stop a CREDIT
    // from running past zero. A line that already carried quantity_issued from
    // before the flag was switched on has had nothing debited here — yet
    // undo/reject set quantity_issued = 0, producing a negative delta and
    // manufacturing stock that never left the store. Measured on ALMOND (g/kg,
    // pack 1000) with a pre-flag quantity_issued of 1: current_stock went
    // 4,000 -> 5,000 g and the department balance went to -1,000.
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
  // 14,148 pre-ledger issues: the record clamp took it to 0, and writing a row
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

  // Liquor / store-mapped materials are governed by the store ledger, not the
  // central pool, and every other central writer refuses them via
  // centralFlowBlock. Their central stock is where the goods actually sit
  // today, so we still move it, but the row is stamped so the liquor rail can
  // reconcile later. Flagged in the design brief as an owner decision.
  let storeMapped = false;
  try { storeMapped = centralFlowBlock(db, String(line.material_id)) !== null; } catch { /* not fatal */ }

  // effective_line_qty is SNAPSHOTTED, not recomputed on read. FULL vs PART is
  // a fact about what the store did that morning; a chef editing
  // chef_approved_qty next week must not retro-rewrite it. (The owner's case:
  // 7 kg requested, 5 kg issued.)
  const effectiveLineQty = line.chef_approved_qty != null
    ? (Number(line.chef_approved_qty) || 0)
    : (Number(line.quantity_requested) || 0);

  const ledgerId = insertLedger(db, input, line, {
    factor, deltaLine, deltaRecipe: stockQty, recordedRecipe: recordQty,
    needsReview, invTxnId, storeMapped, effectiveLineQty,
    // Why no stock moved, stamped on the row's own face. Inferring it later
    // from settings.requisition_deduct_at_issue is impossible — the value it
    // held at the time is unrecoverable.
    skipReason: !deductOn ? 'flag_off' : isParty ? 'party' : needsReview ? 'unit_review' : '',
  });

  if (stockQty !== 0) creditDepartment(db, line, stockQty, input);

  return {
    applied: stockQty !== 0,
    ...(stockQty === 0
      ? { skipped: (!deductOn ? 'flag_off' : isParty ? 'party' : needsReview ? 'unit_review' : 'zero_delta') as IssueDeltaResult['skipped'] }
      : {}),
    deltaRecipeQty: stockQty,
    recordedRecipeQty: recordQty,
    packFactor: factor,
    ledgerId,
    // Surfaced ONLY when the deduct is on. store-process turns this into
    // result.issue_unit_review; with the flag off there is no refused deduction
    // to report, so its response body stays byte-identical to today's.
    ...(deductOn && needsReview ? { needsUnitReview: true } : {}),
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

/**
 * Mirror of the central debit: the department that asked for the goods now
 * holds them. Written in RECIPE units, matching party-fulfillment.ts, so both
 * rails speak the same basis.
 *
 * NOTE for whoever wires the department views: computeDeptStock currently
 * DERIVES a department's balance from requisition_items directly. It must not
 * also add department_materials.on_hand, or every issue counts twice. The two
 * representations are mutually exclusive by design.
 */
function creditDepartment(db: any, line: any, deltaRecipe: number, input: IssueDeltaInput) {
  const deptId = line.department_id || null;
  if (!deptId) return;

  const existing = db.prepare(
    `SELECT id, on_hand FROM department_materials WHERE department_id = ? AND material_id = ?`,
  ).get(deptId, line.material_id) as any;

  let balanceAfter: number;
  if (existing) {
    balanceAfter = (Number(existing.on_hand) || 0) + deltaRecipe;
    db.prepare(`UPDATE department_materials SET on_hand = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(balanceAfter, existing.id);
  } else {
    balanceAfter = deltaRecipe;
    db.prepare(`
      INSERT INTO department_materials (id, outlet_id, department_id, material_id, on_hand)
      VALUES (?,?,?,?,?)
    `).run(generateId(), line.outlet_id || null, deptId, line.material_id, balanceAfter);
  }

  db.prepare(`
    INSERT INTO department_material_transactions
      (id, outlet_id, department_id, material_id, type, quantity, balance_after,
       reference_id, notes, user)
    VALUES (?,?,?,?,'issued',?,?,?,?,?)
  `).run(
    generateId(), line.outlet_id || null, deptId, line.material_id,
    deltaRecipe, balanceAfter, line.req_id,
    `Requisition issue (${input.reason})`, input.actor || '',
  );
}
