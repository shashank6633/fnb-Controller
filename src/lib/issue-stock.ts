/**
 * THE single writer of stock for a requisition issue.
 *
 * The owner's rule is "stock is deducted once, at issue": goods leaving the
 * central store on a requisition debit raw_materials.current_stock and credit
 * the receiving department. Nothing else in this codebase may move stock for a
 * requisition — every writer of requisition_items.quantity_issued calls
 * applyIssueDelta() instead of rolling its own.
 *
 * SHIPPED OFF BY DEFAULT. Settings key `requisition_deduct_at_issue` defaults
 * to '0' and this function returns a no-op until it is '1'. That is deliberate:
 * recipe consumption at KOT-complete ALREADY debits central current_stock
 * (src/lib/db.ts applyDeduct, reached from the KDS bump and the sales routes),
 * and all 131 recipe-ingredient materials are also requisition-issued. Turning
 * this on before the sales side is repointed at department balances would
 * remove the same gram twice — once leaving the store, once being cooked.
 *
 * ── THE CALLER CONTRACT ────────────────────────────────────────────────────
 * Callers pass the BEFORE and AFTER line quantities and this computes the
 * delta. That is what makes one helper correct for both writers, which disagree
 * about what they store:
 *
 *   store-issue    is INCREMENTAL  (quantity_issued + addQty)
 *   store-process  is ABSOLUTE     (SET quantity_issued = ?)
 *
 * A replayed absolute write therefore yields delta 0 and writes nothing — real
 * no-op idempotency rather than a hopeful guard. An undo, which zeroes the
 * column, yields the exact negative of what was deducted.
 *
 * Two rules the caller MUST honour:
 *   1. Read `beforeLineQty` INSIDE the same transaction, immediately before the
 *      UPDATE. Reading it earlier races; reading it after is impossible —
 *      undo and reject zero quantity_issued and blank issue_history in the same
 *      statement, destroying the pre-image.
 *   2. Call inside your own transaction. This function never opens one, so its
 *      writes roll back with yours.
 *
 * ── THE INVARIANT ──────────────────────────────────────────────────────────
 * For any req_item_id, SUM(delta_recipe_qty) is never negative and equals the
 * net recipe quantity THIS RAIL has removed from the store.
 *
 * Two mechanisms hold it up, one per direction:
 *   - Debits are anchored by baseline_line_qty, stamped only on the first row
 *     for a line from whatever quantity_issued already held. Forward-only is
 *     therefore structural: the 14,147 imported history lines ARE the baseline,
 *     so a fresh issue against an old requisition moves only the increment.
 *   - Credits are clamped to that running total, so undo/reject can only ever
 *     give back what was actually taken. Without the clamp a line carrying a
 *     pre-flag quantity_issued would manufacture stock the moment it was undone.
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
  applied: boolean;
  /** Why nothing happened, when applied === false. */
  skipped?: 'flag_off' | 'party' | 'zero_delta' | 'missing_line';
  deltaRecipeQty?: number;
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
 * Returns false for every line while the flag is off, since no ledger row can
 * exist yet — so none of those guards can start refusing anything today.
 */
export function lineHasMovedStock(db: any, reqItemId: string): boolean {
  try {
    const row = db.prepare(
      `SELECT 1 FROM requisition_issue_ledger WHERE req_item_id = ? LIMIT 1`,
    ).get(reqItemId) as any;
    return !!row;
  } catch { return false; }
}

/** Same question for a whole requisition. */
export function requisitionHasMovedStock(db: any, reqId: string): boolean {
  try {
    const row = db.prepare(
      `SELECT 1 FROM requisition_issue_ledger WHERE req_id = ? LIMIT 1`,
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
  if (!issueDeductionEnabled(db)) return { applied: false, skipped: 'flag_off' };

  const line = db.prepare(`
    SELECT ri.id, ri.req_id, ri.material_id, ri.unit AS line_unit,
           r.purpose, r.department_id, r.outlet_id,
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
  // those guards, so the only safe move is to leave the party rail alone.
  if (String(line.purpose || '') === 'party') return { applied: false, skipped: 'party' };

  const { factor, needsReview } = lineFactor(line.line_unit, line);
  const deltaLine = (Number(input.afterLineQty) || 0) - (Number(input.beforeLineQty) || 0);
  let deltaRecipe = Math.round(deltaLine * factor * 1e6) / 1e6;

  if (needsReview) {
    // Record the intent so it surfaces for review, but move no stock.
    insertLedger(db, input, line, { factor, deltaLine, deltaRecipe: 0, needsReview: true, invTxnId: null });
    return { applied: false, skipped: 'zero_delta', needsUnitReview: true, packFactor: factor };
  }
  // NEVER GIVE BACK MORE THAN THIS RAIL TOOK.
  //
  // baseline_line_qty anchors the first row, but it does not stop a CREDIT from
  // running past zero. A line that already carried quantity_issued from before
  // the flag was switched on has had nothing debited here — yet undo/reject set
  // quantity_issued = 0, producing a negative delta and manufacturing stock that
  // never left the store. Measured on ALMOND (g/kg, pack 1000) with a pre-flag
  // quantity_issued of 1: current_stock went 4,000 -> 5,000 g and the department
  // balance went to -1,000.
  //
  // So the credit is clamped to the running total this rail has actually moved
  // for the line. The property that keeps stock honest is therefore:
  //
  //   SUM(delta_recipe_qty) for a req_item_id is never negative, and equals the
  //   net recipe quantity this rail has removed from the store.
  //
  // Debits are never clamped — only the giving-back direction.
  const takenRow = db.prepare(
    `SELECT COALESCE(SUM(delta_recipe_qty), 0) AS taken FROM requisition_issue_ledger WHERE req_item_id = ?`,
  ).get(input.reqItemId) as any;
  const taken = Number(takenRow?.taken) || 0;
  if (deltaRecipe < 0 && taken + deltaRecipe < -EPS) deltaRecipe = -taken;

  if (Math.abs(deltaRecipe) < EPS) return { applied: false, skipped: 'zero_delta', packFactor: factor };

  // Liquor / store-mapped materials are governed by the store ledger, not the
  // central pool, and every other central writer refuses them via
  // centralFlowBlock. Their central stock is where the goods actually sit
  // today, so we still move it, but the row is stamped so the liquor rail can
  // reconcile later. Flagged in the design brief as an owner decision.
  let storeMapped = false;
  try { storeMapped = centralFlowBlock(db, String(line.material_id)) !== null; } catch { /* not fatal */ }

  // Positive delta = goods left the store.
  db.prepare(`UPDATE raw_materials SET current_stock = current_stock - ? WHERE id = ?`)
    .run(deltaRecipe, line.material_id);

  const invTxnId = generateId();
  db.prepare(`
    INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, outlet_id)
    VALUES (?, ?, 'requisition_issue', ?, ?, ?, ?)
  `).run(invTxnId, line.material_id, -deltaRecipe, line.req_id,
         `Requisition issue (${input.reason})`, line.outlet_id || null);

  const ledgerId = insertLedger(db, input, line, {
    factor, deltaLine, deltaRecipe, needsReview: false, invTxnId, storeMapped,
  });

  creditDepartment(db, line, deltaRecipe, input);

  return { applied: true, deltaRecipeQty: deltaRecipe, packFactor: factor, ledgerId };
}

function insertLedger(
  db: any, input: IssueDeltaInput, line: any,
  o: { factor: number; deltaLine: number; deltaRecipe: number; needsReview: boolean; invTxnId: string | null; storeMapped?: boolean },
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
       line_unit, pack_factor, delta_recipe_qty, store_mapped, needs_unit_review,
       inv_txn_id, client_token, actor)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, line.req_id, input.reqItemId, line.material_id,
    line.department_id || null, line.outlet_id || null, input.reason,
    seen ? null : (Number(input.beforeLineQty) || 0),
    Number(input.beforeLineQty) || 0, Number(input.afterLineQty) || 0, o.deltaLine,
    line.line_unit ?? null, o.factor, o.deltaRecipe,
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
