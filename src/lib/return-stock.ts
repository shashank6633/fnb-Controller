import type Database from 'better-sqlite3';
import { generateId } from './db';
import { assertReversible, postDeptLedger } from './dept-ledger';
import { directRowsForGrn } from './direct-issue';
import { centralFlowBlock } from './store-engine';

/**
 * THE two stock movers for the Returns module (owner requirements 72-79).
 *
 * ── THE ONE THING TO READ BEFORE TOUCHING THIS FILE ────────────────────────
 * STOCK MOVES HERE AND ONLY HERE, AND ONLY ON STORE ACCEPT.
 *
 * A return ticket is raised by a department, approved by the Department Head,
 * and only then reaches the store. Nothing in the raise step and nothing in the
 * HOD-approval step touches a single gram. The goods are physically sitting on
 * the store counter while the ticket waits at `hod_approved`; that waiting IS
 * the holding state, which is why the module has no second "returned stock"
 * bucket (see THE RETURNED-STOCK DECISION below). The store's Accept is the
 * first and last moment stock moves, and it moves exactly once.
 *
 * ── A VENDOR RETURN AND AN INTERNAL RETURN DO OPPOSITE THINGS TO CENTRAL ───
 * This is the whole reason there are two exported functions and not one with a
 * flag:
 *
 *   acceptInternalReturnLine()  DEPARTMENT --> CENTRAL STORE.
 *                               The goods stay in the building.
 *                               Department DOWN, raw_materials.current_stock UP.
 *
 *   acceptVendorReturnLine()    CENTRAL STORE --> OUT THE DOOR, back to the vendor.
 *                               The goods LEAVE the building.
 *                               current_stock DOWN. No department leg at all.
 *                               EXCEPTION: a GRN line stamped
 *                               purchases.direct_issue_dept_id was booked on
 *                               the DEPARTMENT ledger (central never held it),
 *                               so its return debits THAT ledger and leaves
 *                               central untouched — see the direct-issue fork
 *                               documented on the function itself.
 *
 * Requirement 76 — "accepted returns should be added back to Store stock as
 * Returned Stock, and Department stock should be reduced automatically" —
 * describes the INTERNAL shape and only the internal shape. Applying its words
 * to a vendor return would credit central for goods that are physically on a
 * lorry back to the supplier, i.e. invent inventory. The fork is therefore
 * STRUCTURAL: two separately named exports, no shared branch, so there is no
 * single code path that can take the wrong side on a bad flag. The caller has
 * already committed to a kind at ticket creation (material_returns.kind, set
 * once and never updated) and simply calls the matching function.
 *
 * ── THE RETURNED-STOCK DECISION (requirement 76's wording) ─────────────────
 * "Returned Stock" is PLAIN CENTRAL STOCK plus a typed, reference-linked ledger
 * row — not a second stock bucket. raw_materials.current_stock is the single
 * pooled truth read by the variance report, closing valuation, recipe costing,
 * the requisition picker and reorder; a parallel bucket would make every one of
 * them wrong-by-omission. A kitchen has no quarantine shelf either — the grams
 * go back in the same bin. Traceability, which is the real ask, comes from
 * inventory_transactions.reference_id = <material_return_items.id> and the ids
 * this module hands back for write-back onto the line.
 *
 * Unusable goods never become Returned Stock at all: an internal line marked
 * wastage/disposal debits the department and stops there.
 *
 * ── TRANSACTIONS ───────────────────────────────────────────────────────────
 * Neither function opens a transaction, exactly like postDeptLedger() and
 * applyIssueDelta(). Both REFUSE to run outside one, because "stock moves
 * exactly once" is only true if the department debit, the central credit and
 * the audit row commit or roll back together. Call inside the store-verify
 * db.transaction(), after the single-shot status claim.
 *
 * A throw from here is DESIGNED to roll that transaction back: the status
 * change to 'verified' goes with it, so a refused line leaves the ticket
 * re-verifiable rather than half-accepted.
 *
 * ── UNITS ──────────────────────────────────────────────────────────────────
 * Every quantity crossing this boundary is RECIPE units (raw_materials.unit —
 * g/ml), matching current_stock and the department ledger. The caller converts
 * ONCE, at the line, with the both-halves-guarded pack factor it snapshotted
 * onto material_return_items.pack_factor. This module never converts and never
 * guesses: it cannot see the line's unit, and guessing is the 750x PICKLED
 * GINGER class of error.
 *
 * There is no money here on purpose. Valuing a return is the report's job, and
 * a rate multiplied by a quantity in this file would be a basis question this
 * file has no business answering.
 *
 * ── FOUR THINGS A FUTURE ENGINEER WILL WANT TO "SIMPLIFY". DO NOT ──────────
 *  1. DO NOT CALL applyIssueDelta() FOR THE INTERNAL RETURN. It is not a stock
 *     mover you can call; it is a derivative of requisition_items.quantity_issued
 *     (its only inputs are reqItemId / beforeLineQty / afterLineQty,
 *     issue-stock.ts:135-144), so driving it would mean falsifying the store's
 *     record of what it handed over. Decisively: its give-back clamp
 *     (issue-stock.ts:360-365) caps at SUM(delta_recipe_qty) for the line, which
 *     is 0 for the ~14,149 lines issued before the ledger existed. Against one of
 *     those the clamp zeroes the quantity, the function returns
 *     { applied:false, skipped:'zero_delta' } (issue-stock.ts:446), and an
 *     approved, store-accepted return MOVES NOTHING WHILE REPORTING SUCCESS.
 *     This module uses the primitives underneath it — assertReversible +
 *     postDeptLedger — which have no such clamp.
 *  2. DO NOT USE dept type 'returned' FOR AN INTERNAL RETURN. It reads right and
 *     is wrong: it is the PARTY rail's leftover type, and admin/reset/route.ts:763
 *     credits central for SUM(quantity) over type IN ('received','consumed',
 *     'returned'). A store return typed that way would be credited to central a
 *     SECOND time on a reset — literally invented inventory. 'adjustment' is
 *     excluded from that credit but is a correction by definition. 'issue_reversal'
 *     is what this rail actually is: grams that left central on the requisition
 *     rail going back the way they came. It is canonical (so
 *     /api/department-ledger/check does not flag it as unknown_type) and is
 *     bucketed as reversals_out by department-variance.
 *  3. DO NOT WRITE A NEGATIVE `purchases` ROW FOR A VENDOR RETURN. It looks like
 *     the natural inverse and it poisons costing both ways: updateMaterialPrice's
 *     FIFO branch takes `unit_price ... ORDER BY date DESC LIMIT 1`, so the return
 *     BECOMES the material's price, and the same-month average branch is distorted
 *     — then db.ts:5113+ cascades that into every sub-recipe and recipe cost,
 *     silently and permanently. Zero negative purchases rows exist today and
 *     receive/route.ts:376 already refuses the idea in prose. The money side of a
 *     vendor return is a CREDIT NOTE, recorded on the ticket header, and it never
 *     feeds stock or cost. Nothing here calls updateMaterialPrice().
 *  4. DO NOT CLAMP. Both movers refuse an over-quantity outright. A clamp would
 *     commit a ticket line reading "3 kg accepted" against 2 kg that actually
 *     moved, which is the same shape as the bug dept-ledger's negative-balance
 *     guard exists to prevent.
 *
 * ── ONE DISCLOSED GAP, SO IT IS LOUD RATHER THAN SILENT ────────────────────
 * The INTERNAL leg is invisible-proof against the central variance report by
 * construction (see the comment on the inventory_transactions write below). The
 * VENDOR leg is not: /api/variance-report's theoretical is
 * purchases - (issues + wastage + party + staff_meal), every term a CLOSED
 * `type IN (...)` list, so a 'vendor_return' row is not seen there and a vendor
 * return will read as leakage against the next count. Closing that needs a new
 * term in that committed formula, which is an owner-approval question and is
 * NOT done here.
 */

const EPS = 1e-9;

/** 6dp, the house rounding — same as dept-ledger.ts and issue-stock.ts, so the
 *  three rails' numbers compare exactly instead of drifting in the 15th decimal. */
function r6(n: number): number {
  return Math.round((Number(n) || 0) * 1e6) / 1e6;
}

/**
 * What the store decided this line's goods are. Requirement 78.
 *
 * 'disposal' is a DISPOSITION, not a second ledger and not a second event:
 * kitchen-production/[id]/dispose/route.ts already treats wasted and disposed as
 * siblings and its own dashboard and reports SUM THEM TOGETHER as "Waste &
 * Disposal". Both write off the same way here; the distinction survives on the
 * line so the return report can separate them, which is the whole of req 78's
 * "generate separate reports".
 */
export type ReturnDisposition = 'reusable' | 'wastage' | 'disposal';

/** Thrown when a movement is refused. Routes should answer 409 with `.message`.
 *  Internal over-quantity throws DeptReversalBlocked from dept-ledger instead —
 *  routes should catch both. */
export class ReturnStockRefused extends Error {
  readonly code = 'RETURN_STOCK_REFUSED';
  readonly materialId: string;
  readonly materialName: string;
  readonly requested: number;
  readonly available: number;

  constructor(d: { materialId: string; materialName: string; requested: number; available: number; message: string }) {
    super(d.message);
    this.name = 'ReturnStockRefused';
    this.materialId = d.materialId;
    this.materialName = d.materialName;
    this.requested = d.requested;
    this.available = d.available;
  }
}

export function isReturnStockRefused(e: unknown): e is ReturnStockRefused {
  return e instanceof ReturnStockRefused
    || (typeof e === 'object' && e !== null && (e as { code?: string }).code === 'RETURN_STOCK_REFUSED');
}

/** What moved, and the receipts. The caller writes these ids back onto
 *  material_return_items so a verified line with a quantity and a NULL receipt
 *  is a DETECTABLE integrity fault rather than a silent zero-credit. */
export interface ReturnMoveResult {
  /** department_material_transactions.id — internal lines AND direct-issue
   *  vendor lines (whose goods sat on the department ledger); else null. */
  deptTxnId: string | null;
  /** inventory_transactions.id — null on an internal wastage/disposal line,
   *  which by design never touches central, and on a DIRECT-ISSUE vendor line,
   *  whose goods central never held (see acceptVendorReturnLine). */
  invTxnId: string | null;
  /** The rounded RECIPE quantity actually moved. Never clamped — equals what
   *  was asked for, or the call threw. */
  recipeQty: number;
  /** Signed RECIPE-unit change applied to raw_materials.current_stock.
   *  + on an internal reusable return, - on a vendor return, 0 on a write-off. */
  centralDelta: number;
  disposition: ReturnDisposition;
}

export interface InternalReturnLine {
  /** The department giving the goods back. Required — an internal ticket
   *  without one is refused at creation, and this is the second gate. */
  departmentId: string;
  materialId: string;
  /** POSITIVE magnitude, RECIPE units. The caller converted from the line's
   *  own unit with its snapshotted pack_factor. */
  recipeQty: number;
  /** Default 'reusable'. wastage/disposal write the goods off instead of
   *  putting them back in the sellable pool. */
  disposition?: ReturnDisposition;
  /** material_return_items.id — becomes inventory_transactions.reference_id and
   *  is how a central row is traced back to the ticket line that caused it. */
  returnItemId: string;
  /** material_returns.id — the department ledger row's reference_id. */
  returnId?: string | null;
  /** RET-YYYY-NNNN, for the human-readable note only. */
  retNumber?: string | null;
  outletId?: string | null;
  /** Who accepted it at the counter. Audit only. */
  actor?: string;
  notes?: string;
}

export interface VendorReturnLine {
  materialId: string;
  /** POSITIVE magnitude, RECIPE units. */
  recipeQty: number;
  /** material_return_items.id — inventory_transactions.reference_id. */
  returnItemId: string;
  /** material_returns.id — the department ledger row's reference_id on a
   *  direct-issue line, mirroring acceptInternalReturnLine. */
  returnId?: string | null;
  /** goods_receipt_notes.id the ticket is anchored on (material_returns.grn_id).
   *  REQUIRED for the direct-issue check: it is how this mover finds the
   *  stamped `purchases.direct_issue_dept_id` cost rows and reverses the rail
   *  the goods ACTUALLY arrived on. Omitting it on a direct-routed line would
   *  debit central for goods it never held — the exact defect this field
   *  exists to prevent. Absent/blank falls back to the central path (the
   *  pre-direct-issue behaviour), which is only correct for central goods. */
  grnId?: string | null;
  retNumber?: string | null;
  outletId?: string | null;
  actor?: string;
  notes?: string;
}

/* ────────────────────────────────────────────────────────────────────────────
 * SHARED PRE-FLIGHT
 * ──────────────────────────────────────────────────────────────────────────*/

/** Both movers require the caller's transaction. Refusing is cheaper than a
 *  torn write: without it a throw on line 3 of a 5-line ticket leaves lines 1-2
 *  moved and the ticket un-verified, which is the double-move bug wearing a
 *  different hat. */
function requireTransaction(db: Database.Database, fn: string): void {
  if (!db.inTransaction) {
    throw new Error(
      `${fn}: must be called inside the caller's db.transaction() — ` +
      `the department debit, the central credit and the audit row have to commit or roll back together.`,
    );
  }
}

function materialName(db: Database.Database, materialId: string): string {
  try {
    const row = db.prepare('SELECT name FROM raw_materials WHERE id = ?').get(materialId) as { name?: string } | undefined;
    return String(row?.name || '') || materialId;
  } catch { return materialId; }
}

/** Rounded to the house 6dp BEFORE anything is written, so the ledger row, the
 *  central credit and the accepted quantity on the line are the SAME number. */
function normQty(fn: string, db: Database.Database, materialId: string, raw: number): number {
  const qty = r6(Math.abs(Number(raw) || 0));
  if (!Number.isFinite(qty) || qty < EPS) {
    throw new Error(
      `${fn}: refusing a zero / non-finite return quantity for ${materialName(db, materialId)}. ` +
      `A zero-quantity acceptance is a caller bug — gate it before you get here.`,
    );
  }
  return qty;
}

/**
 * Store-mapped (liquor / TGBCL) materials do not live in raw_materials.current_stock
 * at all — their truth is store_stock_ledger. Crediting or debiting central for
 * one would manufacture a phantom balance on a rail that does not own the
 * bottle. The route refuses these at ticket CREATION; this is the backstop, and
 * unlike dept-ledger (whose header explains why it must NOT re-check this) a
 * refusal here is exactly the right outcome — there is no legitimate movement
 * for it to roll back.
 */
function refuseStoreMapped(db: Database.Database, fn: string, materialId: string): void {
  const block = centralFlowBlock(db, materialId);
  if (block) throw new Error(`${fn}: ${block}`);
}

/* ────────────────────────────────────────────────────────────────────────────
 * REQUIREMENTS 76 + 77 + 78 — INTERNAL DEPARTMENT RETURN
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * DEPARTMENT --> CENTRAL STORE. The goods stay in the building.
 *
 * Called ONCE per accepted line, inside the store-verify transaction, after the
 * single-shot `UPDATE ... WHERE status='hod_approved'` claim has asserted
 * changes === 1. Never at raise, never at HOD approval.
 *
 * disposition 'reusable' (requirements 76 + 77) — four statements, the shape
 * already proven by the party leftover return at
 * department-materials/reconcile/route.ts:200-234:
 *   1. assertReversible — the department must actually still hold the grams.
 *   2. department ledger DOWN.
 *   3. raw_materials.current_stock UP.
 *   4. one inventory_transactions row, POSITIVE.
 *
 * disposition 'wastage' | 'disposal' (requirement 78) — the department is
 * debited and NOTHING ELSE HAPPENS. Unusable goods must not re-enter the
 * sellable pool, so there is no central credit and no central audit row. That
 * is arithmetically complete, not a shortcut: department-variance reads
 * department_material_transactions directly and buckets 'wastage' correctly,
 * and the central variance report's wastage term is already filtered to
 * department-less rows, so a department-rail write-off correctly does not move
 * central theoretical. One gram, one movement.
 *
 * THROWS (rolling the caller's transaction back, which is the point):
 *   - DeptReversalBlocked when the department no longer holds the quantity —
 *     it may legitimately have cooked the goods between raise and accept, and
 *     the balance AT ACCEPT is the only authoritative one. It refuses; it never
 *     clamps to what is left.
 *   - a plain Error for a store-mapped material, a zero quantity, or a call
 *     made outside a transaction.
 */
export function acceptInternalReturnLine(db: Database.Database, p: InternalReturnLine): ReturnMoveResult {
  const FN = 'acceptInternalReturnLine';
  requireTransaction(db, FN);

  const departmentId = String(p.departmentId || '').trim();
  const materialId = String(p.materialId || '').trim();
  if (!departmentId) throw new Error(`${FN}: departmentId is required — an internal return always names the department giving the goods back.`);
  if (!materialId) throw new Error(`${FN}: materialId is required`);

  const returnItemId = String(p.returnItemId || '').trim();
  if (!returnItemId) {
    throw new Error(
      `${FN}: returnItemId is required — it is the reference_id that ties the central row back to ` +
      `the ticket line, and without it an accepted return is untraceable.`,
    );
  }

  const disposition: ReturnDisposition = p.disposition || 'reusable';
  if (disposition !== 'reusable' && disposition !== 'wastage' && disposition !== 'disposal') {
    throw new Error(`${FN}: unknown disposition '${String(disposition)}' — expected reusable | wastage | disposal.`);
  }

  refuseStoreMapped(db, FN, materialId);
  const qty = normQty(FN, db, materialId, p.recipeQty);

  // THE NEGATIVE-BALANCE GUARD, run HERE and not earlier. Deliberately WITHOUT
  // a reqItemId: department stock is pooled per (department, material) with no
  // lot tracking, so a kitchen returning onion that arrived across three
  // requisitions has no single line to cite, and capDept — what the department
  // actually holds — is the only physically meaningful cap. Passing a reqItemId
  // would additionally apply capLine = SUM(delta_recipe_qty), which is 0 for a
  // pre-ledger line and would refuse a perfectly real return.
  //
  // It runs on EVERY disposition: the grams leave the department whether they
  // go back on the shelf or into the bin, so the department must hold them
  // either way.
  assertReversible(db, { departmentId, materialId, qty });

  const outletId = p.outletId || null;
  const label = p.retNumber ? `Return ${p.retNumber}` : 'Department return';
  const note = (p.notes || '').trim()
    || (disposition === 'reusable' ? `${label}: returned to central store` : `${label}: written off as ${disposition}`);

  // ── the department leg. Always. ──────────────────────────────────────────
  // 'reusable' -> 'issue_reversal': the grams left central on the requisition
  //   rail and are going back the way they came. See rule 2 in the header for
  //   why 'returned' is not merely wrong-flavoured but dangerous.
  // 'wastage'/'disposal' -> 'wastage': the SAME canonical type and the SAME
  //   rail that /api/wastage's own department branch posts, so the loss lands
  //   in the bucket department-variance already reads.
  // Both are sign '-' types, and the quantity is negated to match — postDeptLedger
  // throws on a sign that contradicts the type, which is the guard that keeps a
  // give-back from ever being recorded as a receipt.
  const deptType = disposition === 'reusable' ? 'issue_reversal' as const : 'wastage' as const;
  const deptTxn = postDeptLedger(db, {
    departmentId,
    materialId,
    type: deptType,
    quantity: -qty,
    outletId,
    referenceId: p.returnId || returnItemId,
    source: 'material-return',
    notes: note,
    user: p.actor || '',
  });

  if (disposition !== 'reusable') {
    // THE VISIBLE HALF OF THE WRITE-OFF (req 78, owner-approved 2026-08-08).
    // The department ledger row above is arithmetically complete — the grams are
    // gone from the department and department-variance already reads them. But
    // /wastage and its reports read the `wastages` TABLE, not the ledger, so
    // without this row a disposal is correct in the arithmetic and INVISIBLE to
    // the person whose job is watching spoilage. A loss nobody can see is a loss
    // nobody investigates.
    //
    // Deliberately writes the row here rather than calling POST /api/wastage:
    // that route re-derives its own department debit, and calling it would post
    // the SAME grams to the department ledger a second time. This is the record
    // only; the movement above is the movement.
    //
    // return_item_id ties it back to the ticket — a real column, not a sentence
    // parsed out of `notes`. api/wastage's own INSERT omits it and gets NULL,
    // which is exactly right: a shelf-found spoilage has no return.
    db.prepare(`
      INSERT INTO wastages (id, date, material_id, quantity, reason, recipe_id,
                            recorded_by, notes, outlet_id, department_id, return_item_id)
      VALUES (?, DATE('now'), ?, ?, ?, NULL, ?, ?, ?, ?, ?)
    `).run(
      generateId(), materialId, qty,
      disposition === 'disposal' ? 'Disposal (returned item)' : 'Wastage (returned item)',
      p.actor || '', note || '', outletId, departmentId, returnItemId,
    );
    // Central is untouched on purpose — see the header block.
    return { deptTxnId: deptTxn.id, invTxnId: null, recipeQty: qty, centralDelta: 0, disposition };
  }

  // ── the central leg: two writes, never one ───────────────────────────────
  // The stock change and its audit row are what /api/department-ledger/check
  // reconciles against the department row above; writing only one of them is
  // how the two rails start disagreeing.
  db.prepare(`UPDATE raw_materials SET current_stock = current_stock + ?, updated_at = datetime('now') WHERE id = ?`)
    .run(qty, materialId);

  // POSITIVE, on the EXISTING 'requisition_issue' type. This is the single most
  // load-bearing line in the file and it is not a reuse of convenience.
  //
  // /api/variance-report computes issues_to_date as
  //   -SUM(quantity) WHERE type = 'requisition_issue'
  // over a CLOSED list of types, and the writer's contract is that an outflow is
  // stamped NEGATIVE and a return POSITIVE so the negation nets them out with no
  // special case — exactly how applyIssueDelta already records a reversal. An
  // internal return IS grams that left central on the requisition rail coming
  // back, so a positive row here raises theoretical by precisely the amount
  // current_stock just rose, and the variance report stays honest with ZERO
  // edits to its committed formula.
  //
  // A brand-new type string (say 'return_in') would be INVISIBLE to that closed
  // list: physical stock up, theoretical flat, and a permanent FALSE SURPLUS the
  // owner would chase forever. That is the live bug in the party leftover
  // return's choice of 'adjustment', which is why it was not copied.
  //
  // Checked before choosing this: the only other readers of the type,
  // /api/inventory and /api/analytics, both use consumption WHITELISTS
  // ('sale','nc','party','staff_meal','wastage') that exclude requisition_issue
  // entirely, so a positive row is inert in both.
  const invTxnId = generateId();
  db.prepare(`
    INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at, outlet_id)
    VALUES (?, ?, 'requisition_issue', ?, ?, ?, datetime('now'), ?)
  `).run(invTxnId, materialId, qty, returnItemId, note, outletId);

  return { deptTxnId: deptTxn.id, invTxnId, recipeQty: qty, centralDelta: qty, disposition };
}

/* ────────────────────────────────────────────────────────────────────────────
 * REQUIREMENT 74 (the accept half) — VENDOR RETURN
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * CENTRAL STORE --> OUT OF THE BUILDING, back to the vendor.
 *
 * The mirror image of the function above: central stock goes DOWN and there is
 * no department leg, because a vendor return never came from a department. Do
 * not read requirement 76's "added back to Store stock" onto this path.
 *
 * Two statements only:
 *   1. raw_materials.current_stock DOWN.
 *   2. one inventory_transactions row, NEGATIVE, type 'vendor_return'.
 *
 * ── EXCEPT WHEN THE GOODS NEVER TOUCHED CENTRAL: THE DIRECT-ISSUE FORK ────
 * A GRN line whose cost row is stamped `purchases.direct_issue_dept_id`
 * (Settings → Direct Issue) booked its accepted quantity on the DEPARTMENT
 * ledger — src/lib/direct-issue.ts, type 'direct_receipt' — and central's
 * book never moved. Returning such a line to the vendor must therefore
 * reverse the DEPARTMENT rail, not central: debiting current_stock here
 * would leave central short goods it never held AND leave the department
 * holding a phantom balance for bottles that left on the lorry — two
 * mis-statements that nothing ever ties together at the next counts.
 *
 * The fork is decided by the ROW'S STAMP, never by the rule table of the
 * day (rules affect future receipts only; the stamp is where THIS receipt's
 * stock actually went — the same time-correctness rule grn-reversal.ts
 * follows). On the direct branch:
 *   1. assertReversible — the DEPARTMENT must still hold the grams, and a
 *      refusal speaks about the department, not about central holdings that
 *      are meaningless for kitchen-held goods.
 *   2. one department ledger row, NEGATIVE, type 'direct_receipt_reversal' —
 *      the canonical "direct delivery going back out" type; central's
 *      current_stock and inventory_transactions are NOT touched, which is
 *      exactly what keeps the central variance report (whose purchases term
 *      already excludes direct-routed cost rows) in balance.
 * centralDelta is 0 on this branch, honestly: central did not move.
 *
 * And three things it deliberately does NOT do — see rule 3 in the header:
 *   - no `purchases` row, positive or negative (it would become the material's
 *     price and cascade into every recipe cost),
 *   - no updateMaterialPrice() call,
 *   - no po_vendor_bills row and no edit to goods_receipt_note_items — the PO's
 *     completion state is derived from quantity_accepted, and moving it would
 *     silently reopen or close a purchase order as a side effect of a return.
 * The money is a credit note, recorded on the ticket header and nowhere else.
 *
 * REFUSES, never clamps: if central holds less than the line asks for, the goods
 * on the counter are not the goods the system thinks it has, and shipping a
 * partial quantity while the ticket says otherwise is worse than stopping.
 */
export function acceptVendorReturnLine(db: Database.Database, p: VendorReturnLine): ReturnMoveResult {
  const FN = 'acceptVendorReturnLine';
  requireTransaction(db, FN);

  const materialId = String(p.materialId || '').trim();
  if (!materialId) throw new Error(`${FN}: materialId is required`);

  const returnItemId = String(p.returnItemId || '').trim();
  if (!returnItemId) {
    throw new Error(
      `${FN}: returnItemId is required — it is the reference_id that ties the central row back to ` +
      `the ticket line, and without it a vendor return is untraceable.`,
    );
  }

  refuseStoreMapped(db, FN, materialId);
  const qty = normQty(FN, db, materialId, p.recipeQty);

  // ── THE DIRECT-ISSUE FORK (see the header block above) ───────────────────
  // Decided by the stamped cost rows of THIS GRN + material, read inside the
  // caller's transaction. directRowsForGrn fails-to-empty when the marker
  // column is absent, which correctly falls through to the central path — a
  // database without the direct-issue schema cannot have direct-routed rows.
  const grnId = String(p.grnId || '').trim();
  const directRows = grnId ? directRowsForGrn(db, grnId, materialId) : [];
  if (directRows.length > 0) {
    const depts = [...new Set(directRows.map((r) => String(r.direct_issue_dept_id)))];
    if (depts.length > 1) {
      // Should be impossible (one resolution per material per receipt), but if
      // two cost rows ever disagree the movement cannot be attributed to one
      // ledger — refuse and roll back rather than guess a department.
      throw new Error(
        `${FN}: the direct-issue cost rows for ${materialName(db, materialId)} on this GRN are stamped for ` +
        `${depts.length} different departments, so the return cannot be attributed to one ledger. ` +
        `Correct the stamps before verifying this return.`,
      );
    }
    const departmentId = depts[0];

    // THE DEPARTMENT-BALANCE GUARD — the direct branch's analogue of the
    // central guard below, and it throws DeptReversalBlocked whose message
    // names the DEPARTMENT ("<kitchen> holds only X"), not central holdings
    // that mean nothing for goods that never crossed the central shelf. The
    // department may legitimately have cooked part of the delivery while the
    // ticket waited; the balance AT ACCEPT is the only authoritative one.
    // Deliberately no reqItemId: no requisition line exists on this rail.
    assertReversible(db, { departmentId, materialId, qty });

    const outletId = p.outletId || null;
    const note = (p.notes || '').trim()
      || `${p.retNumber ? `Return ${p.retNumber}` : 'Vendor return'}: direct-issue goods returned to vendor from the department`;

    // ONE department ledger row, NEGATIVE, and nothing on the central rail.
    // 'direct_receipt_reversal' is the canonical sign-'-' type of the direct
    // purchase rail (dept-ledger.ts) — the delivery going back out the way it
    // came in — so every balance reader and /api/department-ledger/check
    // accept the row without edits. reference_id mirrors
    // acceptInternalReturnLine (the ticket), and the caller writes deptTxnId
    // back onto the line, so the movement is traceable from both ends. Note
    // the GRN void/amend rails can never race this into a double-reversal:
    // both refuse to touch a line that has any return ticket anchored to it.
    const deptTxn = postDeptLedger(db, {
      departmentId,
      materialId,
      type: 'direct_receipt_reversal',
      quantity: -qty,
      outletId,
      referenceId: p.returnId || returnItemId,
      source: 'material-return',
      notes: note,
      user: p.actor || '',
    });

    // centralDelta 0, honestly: central never held these goods and did not move.
    return { deptTxnId: deptTxn.id, invTxnId: null, recipeQty: qty, centralDelta: 0, disposition: 'reusable' };
  }

  // THE CENTRAL-BALANCE GUARD. Read fresh inside the caller's transaction, for
  // the same reason assertReversible is: the ticket may have sat at
  // hod_approved for days while the store issued the goods out.
  const row = db.prepare('SELECT name, COALESCE(current_stock, 0) AS current_stock FROM raw_materials WHERE id = ?')
    .get(materialId) as { name?: string; current_stock?: number } | undefined;
  if (!row) throw new Error(`${FN}: material ${materialId} not found`);

  const onHand = r6(Number(row.current_stock) || 0);
  if (qty > onHand + EPS) {
    const name = String(row.name || '') || materialId;
    throw new ReturnStockRefused({
      materialId,
      materialName: name,
      requested: qty,
      available: Math.max(0, onHand),
      message:
        `Cannot return ${qty} of ${name} to the vendor: the central store holds only ` +
        `${Math.max(0, onHand)}. Accept ${Math.max(0, onHand)} or less, or record a stock count first.`,
    });
  }

  const outletId = p.outletId || null;
  const note = (p.notes || '').trim()
    || `${p.retNumber ? `Return ${p.retNumber}` : 'Vendor return'}: goods returned to vendor`;

  db.prepare(`UPDATE raw_materials SET current_stock = current_stock - ?, updated_at = datetime('now') WHERE id = ?`)
    .run(qty, materialId);

  // NEGATIVE — goods out. A NEW type, and it is a known and disclosed gap: the
  // central variance formula's terms are closed `type IN (...)` lists, so
  // 'vendor_return' is not seen there yet and a vendor return will read as
  // leakage against the next count. It is written under its own honest name
  // rather than smuggled into 'wastage' (which is a different economic event,
  // and whose variance term is joined to the wastages table we would not have)
  // precisely so the gap is greppable and can be closed with one term when the
  // owner approves an edit to that committed formula.
  const invTxnId = generateId();
  db.prepare(`
    INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at, outlet_id)
    VALUES (?, ?, 'vendor_return', ?, ?, ?, datetime('now'), ?)
  `).run(invTxnId, materialId, -qty, returnItemId, note, outletId);

  return { deptTxnId: null, invTxnId, recipeQty: qty, centralDelta: -qty, disposition: 'reusable' };
}
