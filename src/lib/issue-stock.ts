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
 * ── AND A FOURTH, ON THE OTHER DIRECTION: THE CENTRAL FLOOR ────────────────
 * Until this change the DEBIT direction had no bound at all. Issuing a line for
 * more than the central store holds succeeded silently and drove
 * raw_materials.current_stock NEGATIVE — measured on a copy of the live db,
 * central 0 kg -> -1 kg on a 1 kg issue, with nothing anywhere on the path
 * refusing it. The owner has decided the server must refuse, so that no caller
 * — not the two issue desks, not a direct API call, not a future writer — can
 * take out more than is there. See assertCentralIssue / checkCentralIssue.
 *
 * TWO LAYERS, AND THE SPLIT IS THE WHOLE DESIGN:
 *   1. assertCentralIssue() here is the FLOOR. It reads current_stock inside the
 *      caller's transaction, immediately before the debit, and THROWS. It is the
 *      only thing that can make the no-negative property structural, because it
 *      sits on the single writer.
 *   2. checkCentralIssue() is the same rule asked EARLY. Both routes run it over
 *      every line BEFORE opening their transaction and refuse the whole gesture
 *      with every short line named. That is what keeps the floor from ever being
 *      the thing the storekeeper meets: by the time the transaction opens, the
 *      numbers have already been agreed.
 *
 * WHY THE FLOOR THROWS RATHER THAN CLAMPS, which is the same reason the reversal
 * guard throws: every caller has ALREADY written quantity_issued by the time we
 * are called. Silently debiting less than the line claims commits a row reading
 * "5 kg issued" against 0.4 kg that actually moved — the two rails diverge with
 * nothing on screen to show it. A throw unwinds the caller's transaction and the
 * line stays exactly as it was.
 *
 * THE FLOOR IS ON THE DEBIT ONLY. A credit (undo / reject / a reduced absolute
 * re-process) can never drive central negative — it moves stock INTO the store —
 * and it already has two bounds of its own above. Putting the floor on both
 * directions would refuse every legitimate undo the moment a material's balance
 * happened to be 0.
 *
 * THE THREE CARVE-OUTS ARE CARVED OUT HERE TOO, necessarily: party,
 * store-mapped and ambiguous-unit lines debit nothing, so there is nothing for a
 * floor to bound. Refusing them for a central balance they never touch would
 * stop four daily operations over a rail they are not on.
 *
 * ── THE PARTY RAIL BORROWS THIS FLOOR; IT DOES NOT GROW ITS OWN ────────────
 * A party line debits nothing HERE, but it is not free: the goods leave central
 * later, in one lump, when the requisition reaches 'fulfilled'. Three writers do
 * that — applyPartyFulfillment (both issue desks) and fulfilRequisitionFromPo
 * (the PO-receipt / GRN-QC cascade) — and until now every one of them ran
 * `current_stock = current_stock - ?` with no balance read of any kind. Measured
 * over 76 material shapes at both desks: 152 attempts, 0 refused, global
 * MIN(current_stock) −36,000.
 *
 * All three now ask THIS function, with rail:'party'. They do not get a floor of
 * their own, for the two reasons this file keeps repeating: a second floor with
 * slightly different rules is the rival-helper trap, and a second unit
 * conversion is the 750x trap (the party rail had one of those too — see
 * lineFactor's note on the three hand-rolled packFactor copies).
 *
 * WHAT "REFUSE" MEANS SPLITS BY WHETHER ANYONE IS THERE TO READ IT, and that is
 * a deliberate decision documented at both sites: the two issue desks THROW
 * (a storekeeper is at the counter and both routes already answer 400 with the
 * message), while the PO/QC cascade CLAMPS and records the shortfall, because a
 * throw there would roll back a delivery that physically arrived, in front of
 * nobody. See the comment above the clamp in po-requisition-fulfil.ts.
 *
 * pack_factor is stored per row so the log can reverse each row's conversion
 * with the factor ACTUALLY USED — a later Unit Audit rebase changes a
 * material's factor, and the pre-ledger remainder arithmetic in the end-to-end
 * log depends on that reversal being exact.
 */
import { packFactor, fmtQtyNum, toPurchaseQty } from '@/lib/pack-units';
import { generateId } from '@/lib/db';
import { centralFlowBlock } from '@/lib/store-engine';
import { postDeptLedger, assertReversible } from '@/lib/dept-ledger';
import { postCentralTxn, deptParty } from '@/lib/movement-record';
// THE ONE RULE for "does this debit fit, and what do we subtract" — shared with
// every other central floor. See its header for the grid and why 1e-6, and for
// the shown-figure rule the desks' purchase-unit figure obeys (round 6).
import { planCentralDebit, holdsAny, qtyDown, qtyGrid, fmtGridQty } from '@/lib/central-debit-clamp';

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

/* ────────────────────────────────────────────────────────────────────────────
 * THE CENTRAL FLOOR — no requisition issue may drive current_stock negative.
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * Thrown by assertCentralIssue(). Routes answer 400 with `.message` and the
 * structured fields, exactly as they already do for DeptReversalBlocked.
 *
 * EVERY QUANTITY ON THIS ERROR CARRIES ITS BASIS IN ITS NAME. The *Purchase
 * fields are what a message may print (OWNER RULE: store and inventory surfaces
 * lead with the purchase unit); the *Recipe fields are the stored truth. Mixing
 * them is the 750x error this file exists to prevent.
 */
export class CentralStockShort extends Error {
  readonly code = 'CENTRAL_STOCK_SHORT';
  readonly reqItemId: string;
  readonly materialId: string;
  readonly materialName: string;
  /** RECIPE units the debit wanted. */
  readonly requestedRecipe: number;
  /** RECIPE units issuable right now (never negative). */
  readonly availableRecipe: number;
  /** PURCHASE units the debit wanted — printable. */
  readonly requestedPurchase: number;
  /** PURCHASE units issuable right now — printable. */
  readonly availablePurchase: number;
  readonly purchaseUnit: string;
  /** Largest value the line's Issue box may hold, in THE LINE'S OWN unit. */
  readonly maxIssueLineQty: number;
  readonly lineUnit: string;

  constructor(c: CentralIssueCheck) {
    super(c.message);
    this.name = 'CentralStockShort';
    this.reqItemId = c.reqItemId;
    this.materialId = c.materialId;
    this.materialName = c.materialName;
    this.requestedRecipe = c.requestedRecipe;
    this.availableRecipe = c.availableRecipe;
    this.requestedPurchase = c.requestedPurchase;
    this.availablePurchase = c.availablePurchase;
    this.purchaseUnit = c.purchaseUnit;
    this.maxIssueLineQty = c.maxIssueLineQty;
    this.lineUnit = c.lineUnit;
  }
}

export function isCentralStockShort(e: unknown): e is CentralStockShort {
  return e instanceof CentralStockShort
    || (typeof e === 'object' && e !== null && (e as { code?: string }).code === 'CENTRAL_STOCK_SHORT');
}

export interface CentralIssueCheck {
  /** false => this debit would take central below zero. */
  ok: boolean;
  /**
   * Does this write debit central at all? false for the three carve-outs
   * (party / store-mapped / ambiguous unit), for a credit, for a zero delta and
   * for a line that no longer exists. `ok` is always true when this is false —
   * there is nothing to bound.
   */
  debits: boolean;
  /**
   * WHY `debits` is false. '' when it is true.
   *
   * The same vocabulary applyIssueDelta stamps on its ledger row, deliberately,
   * so one word means one thing on both. The internal rail never needed to read
   * it — a carve-out there simply means "no floor applies" and the row records
   * the reason itself. THE PARTY RAIL DOES NEED IT: party-fulfillment writes no
   * requisition_issue_ledger row, so a line it declines to move leaves no trace
   * unless the caller is told which reason to record, and it must gate the
   * matching DEPARTMENT credit by the same answer — crediting a department for a
   * gram central never gave up manufactures stock, which is the one outcome
   * worse than a gap (see the store_mapped note in applyIssueDelta).
   */
  skipReason: '' | 'party' | 'store_mapped' | 'unit_review' | 'zero_delta' | 'missing_line';
  reqItemId: string;
  materialId: string;
  materialName: string;
  /** RECIPE units this write wants to remove. 0 when !debits. */
  requestedRecipe: number;
  /**
   * The SIGNED recipe delta this write applies to central — positive = out of
   * the store, negative = back into it, 0 for the three carve-outs and for a
   * line that no longer exists. This is the field a caller accumulates across a
   * multi-line gesture; requestedRecipe alone would count the debits and ignore
   * the credits that pay for them.
   */
  netRecipe: number;
  /**
   * RECIPE units to actually SUBTRACT from current_stock for this line — the
   * figure every writer on this rule must use, never requestedRecipe. Equal to
   * requestedRecipe on an ordinary partial issue; equal to the balance ITSELF
   * when the ask is "everything on the shelf" (on the balance's 6-dp grid point),
   * so the landing is exactly 0 and never -4e-7 (planCentralDebit,
   * src/lib/central-debit-clamp.ts). When !ok it is what an unattended rail may
   * clamp to: max(0, balance). 0 when !debits.
   */
  debitRecipe: number;
  /** RECIPE units issuable — max(0, stock − already claimed), 6-dp. A DISPLAY
   *  figure: it sits on the balance's own grid point, so typing it back fits.
   *  The comparison itself is planCentralDebit's, on the unrounded balance. */
  availableRecipe: number;
  /** The raw stored balance, negative included, so nothing is hidden. */
  centralStockRecipe: number;
  /** The afterLineQty to TYPE to issue everything the store can give this line,
   *  in the LINE'S OWN unit: the line-unit image of the shown figure
   *  `availablePurchase`, so typing it back is accepted (and, being the shown
   *  balance, takes all of it). */
  maxIssueLineQty: number;
  /**
   * The afterLineQty the caller must WRITE to requisition_items.quantity_issued
   * so the line records what actually left the shelf. Equal to the afterLineQty
   * it was given on every ordinary issue (byte-identical, no float re-sum);
   * different ONLY when the shown-figure rule took the balance and the balance
   * differs from the typed figure by at least one grid step — then it is
   * beforeLineQty + debitRecipe / packFactor. See issueLineQtyToRecord.
   */
  recordAfterLineQty: number;
  /** requisition_items.unit as stored ('' means the recipe basis — Option B). */
  lineUnit: string;
  /** The ask in PURCHASE units as the desk shows it (toPurchaseQty, 3 dp
   *  half-up); unrounded only for a sub-display ask that would show as 0. */
  requestedPurchase: number;
  /** The cap in PURCHASE units: the balance's SHOWN figure (toPurchaseQty — the
   *  "In store" column's own number), which the shown-figure rule accepts when
   *  typed back and debits as the whole balance. For a sub-display crumb (shows
   *  0, holds ≥ one grid step) the exact purchase image of its 6-dp recipe
   *  figure. 0 only when holdsAny() is false. */
  availablePurchase: number;
  /** raw_materials.purchase_unit as stored. Never blank on any of the 952 live
   *  materials (checked), so a message may lean on it. */
  purchaseUnit: string;
  /** LINE ↔ recipe factor (lineFactor) — what the debit is converted with. */
  packFactor: number;
  /** PURCHASE ↔ recipe factor of the material (packFactor of its pack meta) —
   *  what the purchase-unit figures above are converted with. Equal to
   *  packFactor on a purchase-unit line, 1 on a line already in recipe units. */
  purchasePackFactor: number;
  /** '' when ok. Already phrased for a storekeeper, in PURCHASE units. */
  message: string;
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE PURCHASE-BASIS FIGURE: THE ONE THE DESK SHOWS, AND THE RULE THAT OBEYS IT.
 *
 * toPurchaseQty() (pack-units.ts) is the one converter every purchase-unit
 * display goes through, and it rounds to 3 dp, half-up. Both desks print the
 * central balance through exactly that arithmetic (U.stockPU, the "In store"
 * column) and the storekeeper types what he reads.
 *
 * ROUND 5 FLOORED THE CAP AND CEILED THE ASK, and that was a trap. MEASURED on
 * THREE MANGO RED CHILLI POWDER 500 GM (g/kg, pack 1000, 14,842.5 g; GREEN APPLE
 * 8,368.5 g the same): the column showed 14.843 kg, typing it was refused
 * "holds only 14.842 kg", clicking the offered 14.842 left 0.5 g behind, and the
 * NEXT ask read "the central store holds none of it" over that 0.5 g — whose
 * only way out was typing 0.0005 kg, a figure no screen shows. Production
 * accepted 14.843 and went to −0.5 g.
 *
 * ROUND 6 OBEYS THE SHOWN FIGURE INSTEAD — the rule is planCentralDebit's
 * `shownAs` (src/lib/central-debit-clamp.ts, "THE SHOWN FIGURE IS THE BALANCE"),
 * decided there once; this file only hands it the converter:
 *   · an ask whose toPurchaseQty equals the balance's (and is > 0) is "all of
 *     it": it fits, the debit is the balance itself, the landing is exactly 0,
 *     and the line RECORDS that balance (recordAfterLineQty) — not the typed
 *     figure, which is up to half a 0.001 step away from what left the shelf;
 *   · the CAP this file prints is therefore the SHOWN figure itself (14.843 kg,
 *     the column's own number), and typing it back is accepted by construction;
 *   · the ASK is printed through the same converter. On every refusal that
 *     remains the two shown figures differ and the ask's is the larger, so the
 *     sentence can never read "holds only X, so X cannot be issued".
 *
 * A BALANCE THE COLUMN SHOWS AS 0 BUT THE STORE STILL HOLDS (a crumb under half
 * a step — 0.4 g on a 1000-pack — left by a floor that works in recipe units) is
 * NOT "none of it": holdsAny() says so, and the refusal names it in recipe units
 * with the purchase figure that, typed back, takes it (puFine below).
 * ──────────────────────────────────────────────────────────────────────────*/

/** A purchase-unit figure printed at enough decimals to carry a 6-dp RECIPE
 *  quantity exactly (6 + log10 of the pack). Only for the sub-display crumb
 *  case, where the 3-dp figure would read 0. Typed back through either desk's
 *  fromPU (× pack, rounded to 6 dp) it lands on the same recipe grid point. */
function puFine(purchaseQty: number, pf: number): string {
  const dp = Math.min(20, 6 + Math.max(0, Math.ceil(Math.log10(pf > 1 ? pf : 1))));
  return (Number(purchaseQty) || 0).toLocaleString('en-IN', { maximumFractionDigits: dp });
}

/**
 * THE RULE, ASKED ONCE. Both issue routes call this before opening their
 * transaction (to refuse with a good message) and applyIssueDelta calls it
 * through assertCentralIssue inside the transaction (to make the bound real).
 * One function, so the pre-flight and the floor can never disagree about what
 * is issuable — a pre-flight that said yes where the floor says no would be a
 * 500 at the counter, which is the failure this shape exists to avoid.
 *
 * UNITS. requisition_items quantities are in the LINE'S own unit; current_stock
 * is RECIPE units. The conversion is lineFactor() — the same call applyIssueDelta
 * makes for the debit itself, which is what guarantees the number compared here
 * is the number subtracted there. A cap derived from a second conversion would
 * refuse correct work and admit wrong work; packFactor is never re-derived (see
 * lineFactor's own comment on the three hand-rolled copies in this repo).
 *
 * `alreadyClaimedRecipe` is for the pre-flight only, and it is SIGNED (sum the
 * `netRecipe` of the lines already scored). One gesture can draw on the same
 * material twice — two entries for one line, which store-issue documents and
 * measures, or two lines for one material, which 0 of the 1,630 live
 * requisitions currently hold — and each draw fits while the pair does not. The
 * floor needs no equivalent: it re-reads current_stock per line, so by the time
 * the second debit runs the first is already in the balance.
 *
 * WHERE THE PRE-FLIGHT CAN BE MORE GENEROUS THAN THE FLOOR, stated rather than
 * hidden: a credit in the same gesture is assumed to land in full, while the
 * credit clamp and assertReversible may reduce or refuse it. The floor is the
 * authority and catches that; erring this way costs a late refusal with the same
 * sentence, where erring the other way would refuse work the floor allows.
 *
 * ── `rail`: WHICH WRITER IS ASKING, AND WHY THE PARTY RAIL MUST SAY SO ───────
 * The party carve-out below exists because on the INTERNAL rail a party line
 * debits nothing — applyIssueDelta leaves it alone and the party rail moves the
 * goods later, in one lump, at fulfilment. For that caller the carve-out is
 * simply the truth.
 *
 * THE PARTY RAIL ITSELF IS THE OTHER CALLER, and for it that same carve-out
 * would be a guard that reads correctly and can never fire — this codebase's
 * recorded inert-guard pattern, 9 instances, in its purest form: a floor on the
 * party debit that begins by excusing every party debit. So the party rail
 * passes rail:'party' and the carve-out does not apply to it.
 *
 * NOTHING ELSE FORKS. The store-mapped and ambiguous-unit carve-outs, the
 * lineFactor conversion, the comparison, the max(0, …) and the message are the
 * same lines of code for both rails. That is the whole reason this takes a flag
 * instead of getting a sibling function: a second floor with slightly different
 * rules is the rival-helper trap, and a second conversion is the 750x one.
 * rail defaults to 'internal', so every pre-existing caller is unchanged.
 */
export function checkCentralIssue(
  db: any,
  a: {
    reqItemId: string;
    beforeLineQty: number;
    afterLineQty: number;
    /** RECIPE units earlier lines of the SAME gesture have already claimed. */
    alreadyClaimedRecipe?: number;
    /**
     * Who is debiting. 'internal' (default) = applyIssueDelta and the two issue
     * desks' pre-flights, for which a party line debits nothing. 'party' = the
     * party rail's own fulfilment debit (party-fulfillment.ts /
     * po-requisition-fulfil.ts), for which the party carve-out would be inert.
     */
    rail?: 'internal' | 'party';
  },
): CentralIssueCheck {
  const nil = (over: Partial<CentralIssueCheck>): CentralIssueCheck => ({
    ok: true, debits: false, skipReason: 'zero_delta',
    reqItemId: String(a.reqItemId || ''),
    materialId: '', materialName: '', requestedRecipe: 0, netRecipe: 0,
    debitRecipe: 0, availableRecipe: 0,
    centralStockRecipe: 0, maxIssueLineQty: Number(a.afterLineQty) || 0,
    recordAfterLineQty: Number(a.afterLineQty) || 0,
    lineUnit: '', requestedPurchase: 0, availablePurchase: 0,
    purchaseUnit: '', packFactor: 1, purchasePackFactor: 1, message: '', ...over,
  });

  const line = db.prepare(`
    SELECT ri.id, ri.material_id, ri.unit AS line_unit, r.purpose,
           rm.name AS material_name, rm.unit, rm.purchase_unit, rm.pack_size,
           COALESCE(rm.current_stock, 0) AS current_stock
      FROM requisition_items ri
      JOIN requisitions  r  ON r.id  = ri.req_id
      JOIN raw_materials rm ON rm.id = ri.material_id
     WHERE ri.id = ?
  `).get(String(a.reqItemId)) as any;
  // A line that is not there debits nothing; applyIssueDelta answers the same
  // way ({ skipped: 'missing_line' }) a few lines into its own body.
  if (!line) return nil({ skipReason: 'missing_line' });

  // THE SAME THREE CARVE-OUTS, RESOLVED THE SAME WAY as applyIssueDelta does
  // below — purpose === 'party', centralFlowBlock(), and lineFactor's
  // needsReview. None of the three moves a gram of central stock, so none of
  // them has a central balance to be short of.
  //
  // THE FIRST ONE IS THE CALLER'S OWN RAIL TALKING. See `rail` in the header:
  // for the internal rail a party line debits nothing here and the carve-out is
  // the truth; for the party rail, which IS the writer of that later debit, the
  // same line would excuse the very thing it is being asked to bound.
  if (a.rail !== 'party' && String(line.purpose || '') === 'party') {
    return nil({ materialId: String(line.material_id), skipReason: 'party' });
  }
  let storeMapped = false;
  try { storeMapped = centralFlowBlock(db, String(line.material_id)) !== null; } catch { /* not fatal */ }
  if (storeMapped) return nil({ materialId: String(line.material_id), skipReason: 'store_mapped' });

  const { factor, needsReview } = lineFactor(line.line_unit, line);
  if (needsReview) {
    return nil({ materialId: String(line.material_id), packFactor: factor, skipReason: 'unit_review' });
  }

  const deltaLine = (Number(a.afterLineQty) || 0) - (Number(a.beforeLineQty) || 0);
  const requestedRecipe = Math.round(deltaLine * factor * 1e6) / 1e6;
  // CREDITS AND NO-OPS ARE NOT THIS GUARD'S BUSINESS. A give-back raises the
  // central balance and is bounded by the credit clamp plus assertReversible; a
  // zero delta writes nothing at all. The signed figure still goes back, so a
  // caller accumulating across lines sees the headroom the credit creates.
  if (requestedRecipe <= EPS) {
    return nil({
      materialId: String(line.material_id), packFactor: factor,
      netRecipe: requestedRecipe < -EPS ? requestedRecipe : 0,
    });
  }

  const meta = { unit: line.unit, purchase_unit: line.purchase_unit, pack_size: line.pack_size };
  const stock = Number(line.current_stock) || 0;
  // SIGNED, deliberately. A negative running claim means an earlier line of the
  // same gesture is putting goods BACK, which genuinely raises the balance this
  // line draws on — and that is what the floor will see when it re-reads
  // current_stock after that credit has been written.
  const claimed = Number(a.alreadyClaimedRecipe) || 0;
  // max(0, …): a balance that is ALREADY negative (0 of 952 materials today,
  // but /api/inventory/fix-negative-stock exists because it has happened) must
  // read as "nothing issuable", never as a negative allowance that would let the
  // next issue dig the hole deeper.
  const availableRecipe = Math.max(0, Math.round((stock - claimed) * 1e6) / 1e6);
  // THE DECISION — planCentralDebit, the one rule every central floor shares.
  // It used to be `requestedRecipe <= availableRecipe + EPS` here: a 6-dp
  // ROUNDED allowance against a 1e-9 slack. Rounding UP let 100 through against
  // a stored 99.9999996 and the debit wrote -4e-7 (measured, both desks). The
  // plan compares both figures on the same 6-dp grid and also says what to
  // subtract, so the floor and the write cannot disagree. Against
  // `stock − claimed`, so the pre-flight's running claim and the floor's
  // per-line re-read see the same balance.
  //
  // THE SHOWN FIGURE (round 6): the converter is toPurchaseQty — the arithmetic
  // of both desks' "In store" column — so an ask typed from that column is
  // matched against the very figure the storekeeper read. The rule itself is
  // planCentralDebit's; nothing here decides "fits".
  const pf = packFactor(meta);
  const plan = planCentralDebit(stock - claimed, requestedRecipe, r => toPurchaseQty(r, meta));
  const purchaseUnit = String(line.purchase_unit || line.unit || '').trim();
  const recipeUnit = String(line.unit || '').trim();
  const shownAvail = Number(plan.shownAvailable) || 0;
  const shownAsk = Number(plan.shownAsk) || 0;
  // THE SUB-DISPLAY CRUMB: the store holds at least one grid step, but less than
  // half a 0.001 purchase step, so the column shows 0. Its typeable figure is the
  // balance's own grid point, carried in purchase units without the 3-dp
  // rounding (puFine prints it).
  const gridAvail = qtyDown(plan.available, 6);
  const crumb = shownAvail <= 0 && holdsAny(plan.available);
  // THE CAP IS THE SHOWN FIGURE — the column's own number, accepted when typed
  // back because it IS the balance's shown figure (byShownFigure). Never a
  // floored figure: round 5's floor sent the storekeeper to 14.842, which left a
  // 0.5 g crumb the column then showed as nothing.
  const availablePurchase = shownAvail > 0 ? shownAvail : crumb ? gridAvail / pf : 0;
  // The ask through the same converter. A sub-display ask (it shows as 0) is
  // carried unrounded so the sentence never says "0 kg cannot be issued".
  const requestedPurchase = shownAsk > 0 ? shownAsk : requestedRecipe / pf;
  const beforeLine = Number(a.beforeLineQty) || 0;
  const base: CentralIssueCheck = {
    ok: true, debits: true, skipReason: '',
    reqItemId: String(line.id),
    materialId: String(line.material_id),
    materialName: String(line.material_name || ''),
    // netRecipe carries the figure the floor will actually WRITE when the line
    // fits — the pre-flight's running claim then subtracts exactly what the
    // floor's per-line re-read will see gone. On a refusal it stays the ask
    // (the line does not run, so callers do not accumulate it).
    requestedRecipe, netRecipe: plan.fits ? plan.debit : requestedRecipe,
    debitRecipe: plan.debit,
    availableRecipe, centralStockRecipe: stock,
    // In the LINE's unit: the line-unit image of `availablePurchase`, so the
    // value typed straight back into the Issue box is the shown figure and
    // passes this very check on the retry. purchase → recipe is × pf, recipe →
    // line is ÷ factor (a purchase-unit line has factor = pf, so it is the shown
    // figure itself); rounded at the 6 dp both desks' fromPU rounds an entry to.
    // A crumb is carried unrounded — 6 dp of a purchase-unit line would shave a
    // 0.4 g crumb on a 1000-pack to nothing.
    maxIssueLineQty: shownAvail > 0
      ? beforeLine + Math.round((shownAvail * pf / (factor || 1)) * 1e6) / 1e6
      : crumb
        ? beforeLine + gridAvail / (factor || 1)
        : beforeLine,
    // WHAT THE LINE MUST RECORD. The afterLineQty as given, untouched (so an
    // ordinary issue is byte-identical — no `before + delta` float re-sum),
    // unless the shown-figure rule took a balance that differs from the typed
    // figure by a grid step or more: then the line says what left the shelf.
    recordAfterLineQty: plan.fits && !plan.debitIsAsk
      ? beforeLine + plan.debit / (factor || 1)
      : (Number(a.afterLineQty) || 0),
    lineUnit: String(line.line_unit ?? ''),
    requestedPurchase, availablePurchase, purchaseUnit,
    packFactor: factor,
    purchasePackFactor: pf,
    message: '',
  };
  // An issue of everything on the shelf — binary noise included, or the 6-dp
  // figure the desks print — fits and lands on exactly 0 (debitRecipe is then
  // the balance itself). Only an ask on a grid point PAST the balance is refused.
  if (plan.fits) return base;

  // THE MESSAGE IS WRITTEN FOR THE 508, NOT FOR THE 56. Measured over all 16,346
  // non-party lines: 564 carry an outstanding seed this floor would refuse, and
  // on 508 of them the central balance is ZERO — there is no "issue less"
  // available. A single sentence offering a smaller number would therefore be
  // nonsense on 90% of the real refusals, which is this project's inert-guard
  // pattern (9 recorded instances) in message form. So the empty case gets its
  // own sentence and names the way out, and only the 56 are offered a partial.
  //
  // AND THE PARTIAL IT OFFERS IS TYPEABLE, AND TAKES IT ALL. `availablePurchase`
  // is the SHOWN figure (the "In store" column's own number), which the
  // shown-figure rule accepts on the retry and debits as the whole balance —
  // proved by typing it back on the real 14,842.5 g and 8,368.5 g balances, not
  // by reading this code. The PURCHASE unit is the right basis because that is
  // the unit BOTH desks' Issue boxes are entered in (requisitions/page.tsx
  // `issued_pu` → U.fromPU, store-requisitions/page.tsx `editQty` → U.fromPU);
  // the line unit the API takes is reached only through those converters.
  //
  // "HOLDS NONE OF IT" ONLY WHEN IT HOLDS NONE — holdsAny(), the one test every
  // floor uses. A crumb the column shows as 0 is named in recipe units, with the
  // purchase figure that takes it.
  return {
    ...base, ok: false,
    message: centralShortMessage(base, {
      holds: holdsAny(plan.available), shownAvail, shownAsk, gridAvail, recipeUnit, pf,
    }),
  };
}

/** The refusal sentence for a short line, in the purchase unit the desks type
 *  in. Three branches, chosen by holdsAny and the shown figure — never by a
 *  rounded display figure on its own. Shared by checkCentralIssue (so the
 *  pre-flight and the floor) and by the after-the-gesture re-score of a held
 *  line, so the sentences cannot drift. */
function centralShortMessage(
  c: CentralIssueCheck,
  f: { holds: boolean; shownAvail: number; shownAsk: number; gridAvail: number; recipeUnit: string; pf: number },
): string {
  const pu = c.purchaseUnit;
  const q = (n: number) => `${fmtQtyNum(n)}${pu ? ` ${pu}` : ''}`;
  const ru = f.recipeUnit ? ` ${f.recipeUnit}` : '';
  // The ask: its shown figure when it has one, otherwise (a sub-display ask) its
  // recipe figure — never "0 kg cannot be issued".
  const askFig = f.shownAsk > 0 ? q(f.shownAsk) : `${fmtGridQty(c.requestedRecipe)}${ru}`;
  if (!f.holds) {
    return `${c.materialName}: the central store holds none of it, `
      + `so ${askFig} cannot be issued. Receive the stock, or record a closing count, first.`;
  }
  if (f.shownAvail > 0) {
    return `${c.materialName}: the central store holds only ${q(f.shownAvail)}, `
      + `so ${askFig} cannot be issued. Issue ${q(f.shownAvail)} or less on this line.`;
  }
  const fine = `${puFine(c.availablePurchase, f.pf)}${pu ? ` ${pu}` : ''}`;
  return `${c.materialName}: the central store holds only ${fmtGridQty(f.gridAvail)}${ru} of it `
    + `— less than the 0.001${pu ? ` ${pu}` : ''} the store desk shows — so ${askFig} cannot be issued. `
    + `Issue ${fine} or less on this line, or record a closing count.`;
}

/**
 * THE FLOOR. Throws CentralStockShort; it does NOT clamp — see "WHY THE FLOOR
 * THROWS RATHER THAN CLAMPS" in this file's header.
 *
 * MUST be called inside the caller's transaction, immediately before the debit,
 * for the same reason the pre-image must be: a balance read earlier races.
 */
export function assertCentralIssue(
  db: any,
  a: {
    reqItemId: string; beforeLineQty: number; afterLineQty: number;
    /** See `rail` on checkCentralIssue. Passed straight through. */
    rail?: 'internal' | 'party';
  },
): CentralIssueCheck {
  const c = checkCentralIssue(db, a);
  if (!c.ok) throw new CentralStockShort(c);
  return c;
}

/**
 * THE QUANTITY A ROUTE MUST WRITE TO requisition_items.quantity_issued (round 6).
 *
 * Both desks write quantity_issued BEFORE they call applyIssueDelta (the caller
 * contract above). Until round 6 the figure written was always the figure typed,
 * and that was safe because the floor's debit never differed from it by a grid
 * step. The shown-figure rule (planCentralDebit) changes that on exactly one
 * gesture: typing the balance's shown figure — 14.843 kg over 14,842.5 g — takes
 * the balance, 0.5 g less than typed. Writing 14.843 would leave the line, the
 * issue_history and the audit row claiming half a gram that never left the
 * shelf; so the route asks HERE, writes what this returns, and passes the same
 * figure to applyIssueDelta.
 *
 * CALL IT INSIDE THE TRANSACTION, IMMEDIATELY BEFORE THE UPDATE — the same rule
 * as the pre-image: it reads current_stock, and better-sqlite3 lets nothing
 * interleave between this read, the UPDATE and applyIssueDelta's own floor, so
 * the floor then sees an ask on the balance's grid point and takes exactly it.
 *
 * `changed` is false on every ordinary issue, and then `afterLineQty` is the
 * value passed in, untouched — so a route that keys "did the figure move" on it
 * stays byte-identical to round 5 everywhere the rule did not fire. A line that
 * does not debit central (party, store-mapped, unit review, a credit, a zero
 * delta) and a line the floor would refuse are returned as given: the first
 * moves no stock to record, the second is the floor's to refuse.
 */
export function issueLineQtyToRecord(
  db: any,
  a: { reqItemId: string; beforeLineQty: number; afterLineQty: number },
): { afterLineQty: number; changed: boolean } {
  const asked = Number(a.afterLineQty) || 0;
  const c = checkCentralIssue(db, a);
  if (!c.debits || !c.ok || c.recordAfterLineQty === asked) return { afterLineQty: asked, changed: false };
  return { afterLineQty: c.recordAfterLineQty, changed: true };
}

/**
 * A HELD LINE'S ROW, SCORED AGAINST WHAT IS LEFT AFTER THE GESTURE (round 6).
 *
 * THE DEFECT, MEASURED SHAPE. One POST names the same material twice: line A
 * asks 1.5 kg of a 1 kg balance and is held with cap 1 kg; line B (0.4 kg) then
 * issues. The pre-flight scored A before B ran, so the 200 told the storekeeper
 * "issue 1 kg or less" — and typing 1 kg back was refused, because 0.6 kg was
 * left. A cap printed after the gesture must be the cap after the gesture.
 *
 * So the routes keep the pre-flight's HOLD decision (it is the floor's decision
 * in write order, and it is right), and re-score only the FIGURES of each held
 * row here, INSIDE the transaction, after every write of the gesture — reading
 * current_stock as it now stands, with nothing claimed, because everything the
 * gesture took is already out of the balance. That is exactly the balance the
 * storekeeper's next POST will meet.
 *
 * IF IT NOW FITS — a credit later in the same gesture (an undo, an omitted line
 * on store-process) put stock back after this line's turn — the line was still
 * correctly held (the floor runs in order and would have refused it at its
 * turn), and the row says so and gives the figure that now fits, instead of a
 * refusal sentence that is no longer true.
 */
export function rescoreHeldIssue(
  db: any,
  a: { reqItemId: string; beforeLineQty: number; afterLineQty: number },
): CentralIssueCheck {
  const c = checkCentralIssue(db, a);
  if (!c.debits || !c.ok) return c;
  const pu = c.purchaseUnit ? ` ${c.purchaseUnit}` : '';
  // >= 0.001 ⇔ it is a shown figure (checkCentralIssue carries the shown
  // figure whenever there is one); below that it is a sub-display crumb,
  // printed exactly so it can be typed back.
  const fig = (n: number) => n >= 0.001 ? `${fmtQtyNum(n)}${pu}` : `${puFine(n, c.purchasePackFactor)}${pu}`;
  const cap = fig(c.availablePurchase);
  const ask = fig(c.requestedPurchase);
  return {
    ...c, ok: false,
    message: `${c.materialName}: not issued with the rest of this gesture — when its turn came the central `
      + `store held less than ${ask}. After the gesture it holds ${cap}; issue ${ask} again.`,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE REPLAY, AND WHY IT HAS TO BE RECOGNISED HERE RATHER THAN AT THE INSERT.
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * Layer-2 idempotency used to be recognised by ACCIDENT: a replayed gesture
 * reached insertLedger, collided on uq_req_issue_token_item, and the route read
 * the SQLite constraint message. That worked only while nothing else on the path
 * could refuse first — and the central floor, added in this same change, CAN.
 *
 * MEASURED, and this is the whole reason this class exists. Requisition asks 5,
 * central holds exactly 2, the storekeeper issues 2 and defers the rest, and the
 * same gesture is POSTed twice (a dropped response on a venue LAN — the exact
 * case the token exists for):
 *     3be09af : POST1 200 applied=2 ; POST2 200 success=true applied=0
 *     with the floor and the route pre-flight in front of the insert, and
 *     NOTHING consulting the token:
 *               POST1 200 applied=2 ; POST2 400 code=central_stock_short
 *     "nothing was issued and the requisition is unchanged"
 * The hand-over had completed and central was down to 0, so the floor was
 * telling the truth about the BALANCE and the opposite of the truth about the
 * GESTURE. Final DB state was identical on both trees — the defect was purely
 * what the storekeeper was told, and it trapped him: the client clears its
 * armed panel only on a 2xx, so he retried the same token forever.
 *
 * THE FIX IS ORDERING, NOT A SECOND MESSAGE. The question "has this gesture
 * already been recorded" is answered from requisition_issue_ledger, which is
 * the same table and the same (client_token, req_item_id) pair the unique index
 * is built on — so it can be asked at ANY point, and it is now asked BEFORE
 * either guard can refuse. The index stays exactly where it was and remains the
 * last word (it is the only thing that is atomic against a concurrent first
 * POST), so this is an additional, earlier reading of the same fact — never a
 * replacement for it.
 */
export class IssueTokenReplay extends Error {
  readonly code = 'ISSUE_TOKEN_REPLAY';
  readonly reqItemId: string;
  readonly clientToken: string;
  constructor(reqItemId: string, clientToken: string) {
    super(
      `This issue has already been recorded (gesture ${clientToken} on line ${reqItemId}). ` +
      `Nothing was changed a second time.`,
    );
    this.name = 'IssueTokenReplay';
    this.reqItemId = reqItemId;
    this.clientToken = clientToken;
  }
}

export function isIssueTokenReplayError(e: unknown): e is IssueTokenReplay {
  return e instanceof IssueTokenReplay
    || (typeof e === 'object' && e !== null && (e as { code?: string }).code === 'ISSUE_TOKEN_REPLAY');
}

/**
 * Has (clientToken, reqItemId) already been written to the issue ledger? This
 * is the unique index's own predicate, asked as a question instead of met as a
 * collision.
 *
 * SCOPED TO THE LINE, not to the token, because the index is. One token covers a
 * whole batch, and a SECOND POST under the same token naming a DIFFERENT line
 * genuinely is new work — on 3be09af that line's insert did not collide and the
 * work went through. Answering on the token alone would start refusing it.
 *
 * A blank/absent token is never a replay: the index is partial
 * (WHERE client_token IS NOT NULL) and the 14,149 imported issued lines carry no
 * token at all, so a tokenless gesture must stay freely repeatable.
 */
export function isIssueGestureRecorded(
  db: any, clientToken: string | null | undefined, reqItemId: string,
): boolean {
  const token = String(clientToken ?? '').trim();
  if (!token) return false;
  const row = db.prepare(
    `SELECT 1 FROM requisition_issue_ledger
      WHERE client_token = ? AND req_item_id = ? LIMIT 1`,
  ).get(token, String(reqItemId)) as any;
  return !!row;
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
    // DEBITS ARE STILL NEVER CLAMPED — THEY ARE NOW REFUSED. This sentence used
    // to read "Debits are never clamped — only the giving-back direction", and
    // it was the whole bug: the debit direction had no bound of any kind, so
    // issuing more than the store held drove current_stock negative in silence
    // (measured: central 0 kg -> -1 kg on a 1 kg issue). The floor below does
    // not clamp either — a clamp here would commit a line claiming more than
    // moved — it THROWS, and the caller's transaction unwinds. The clamp
    // immediately after this still governs the credit direction and is
    // untouched.
    const takenRow = db.prepare(
      `SELECT COALESCE(SUM(delta_recipe_qty), 0) AS taken FROM requisition_issue_ledger WHERE req_item_id = ?`,
    ).get(input.reqItemId) as any;
    const taken = Number(takenRow?.taken) || 0;
    if (stockQty < 0 && taken + stockQty < -EPS) stockQty = -taken;
    if (Math.abs(stockQty) < EPS) stockQty = 0;
  }

  // Would this call reach insertLedger at all? ONE expression, read twice — here
  // and by the early return further down that uses it as its own condition.
  // They MUST agree: the replay check below is placed early precisely so it
  // fires in exactly the cases the unique index used to fire in, and if these
  // two tests ever drift that equivalence quietly stops holding.
  const writesLedgerRow = !(recordQty === 0 && stockQty === 0 && !needsReview);

  // ── THE REPLAY IS RECOGNISED HERE, AHEAD OF BOTH GUARDS ───────────────────
  // THIS IS AN ORDERING FIX, AND THE ORDER IS THE WHOLE POINT. Until now the
  // only thing that knew about a spent token was the unique index at
  // insertLedger, which is the LAST write this function makes. Everything that
  // can refuse — the department-reversal guard, and now the central floor —
  // sits in front of it, so whichever of them spoke first got to answer for a
  // replay. The floor did: it reported "the central store holds none of it" for
  // a hand-over that had already completed and taken the balance to zero.
  //
  // IT IS EQUIVALENT TO THE INDEX, NOT MERELY EARLIER THAN IT. The index fires
  // iff a row is inserted, and a row is inserted iff the zero-delta gate above
  // let us through AND `writesLedgerRow`. Both are already decided at this
  // line, so this test fires on exactly the same calls — which is what lets the
  // route keep answering a replay the way it did on 3be09af. In particular a
  // replayed gesture that writes NO row (a reject that keeps what was handed
  // over, an undo of one of the 14,149 pre-ledger lines, a defer) is not a
  // replay for this purpose and still proceeds, exactly as it did before.
  //
  // IT THROWS, like the index did and like both guards do. Every caller has
  // ALREADY written quantity_issued by the time we are reached (store-issue
  // walks its lines, store-process rewrites them absolutely), so returning a
  // quiet skip here would COMMIT that second write — an 'issue' of 2 kg
  // replayed would read 4 kg issued against 2 kg that moved. The throw unwinds
  // the caller's transaction, which is what makes the replay a true no-op.
  //
  // THE INDEX STAYS, AND STAYS THE LAST WORD. This read cannot be atomic
  // against a first POST that has not committed yet; the index can. Both routes
  // still recognise the constraint message.
  if (writesLedgerRow && isIssueGestureRecorded(db, input.clientToken, input.reqItemId)) {
    throw new IssueTokenReplay(String(input.reqItemId), String(input.clientToken || ''));
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
    } else {
      // THE CENTRAL FLOOR — THE MIRROR OF THE REVERSAL GUARD, ON THE OTHER
      // DIRECTION. assertReversible above answers "does the department still
      // hold what we are putting back"; this answers "does central hold what we
      // are taking out". Before this existed the debit had no bound at all and
      // an over-issue simply drove current_stock negative.
      //
      // IT READS THE BALANCE HERE, inside the caller's transaction and one
      // statement before the UPDATE, so it cannot be raced by a concurrent
      // issue: better-sqlite3 is synchronous and no caller awaits inside its
      // transaction, so from this read to that write nothing interleaves.
      //
      // IT THROWS, exactly like assertReversible and for the identical reason —
      // quantity_issued is already written by every caller at this point, so a
      // silent partial debit would commit a line that claims more than moved.
      // The throw unwinds the caller's transaction and the line is untouched.
      //
      // BOTH ROUTES ALREADY REFUSED THIS BEFORE OPENING THEIR TRANSACTION, with
      // every short line named at once (checkCentralIssue, the same rule). So in
      // ordinary use this never fires, and that is the point: it is the bound
      // that makes the no-negative property structural rather than a promise the
      // two routes keep. It is what answers a direct API call, a third issue
      // desk written next year, and the pre-flight/transaction race.
      const c = assertCentralIssue(db, {
        reqItemId: input.reqItemId,
        beforeLineQty: Number(input.beforeLineQty) || 0,
        afterLineQty: Number(input.afterLineQty) || 0,
      });
      // WRITE THE FLOOR'S FIGURE, NOT THE ASK. Same balance read, same rule: an
      // issue of "everything" subtracts the balance itself and lands on exactly
      // 0 instead of -4e-7 (or a 1e-9 crumb). It differs from deltaRecipe by
      // strictly less than one 6-dp step, and only on that "everything" issue.
      // The ledger row, the central movement and the department credit below
      // all carry this one figure, so SUM(delta_recipe_qty) is still exactly
      // what central gave up and the credit clamp above stays honest. It cannot
      // be 0 here: deltaRecipe is 6-dp rounded and > 0, so it is at least one
      // grid step, which a zero balance does not fit.
      stockQty = c.debitRecipe;
      // THE HAND-OVER RECORD FOLLOWS THE SHELF, NOT THE TYPING (round 6). The
      // shown-figure rule can take a balance up to half a 0.001 purchase step
      // away from the figure typed (14,842.5 g for 14.843 kg). Both desks resolve
      // the line to that figure first (issueLineQtyToRecord), so here the two
      // agree on the grid and nothing changes; this is the backstop for a caller
      // that did not, so recorded_recipe_qty never claims a gram the debit did
      // not move. Only when they differ by a whole grid step — on the grid rule
      // alone they never do, so every round-5 row is byte-identical.
      if (qtyGrid(stockQty) !== qtyGrid(recordQty)) recordQty = stockQty;
    }

    // Positive delta = goods left the store.
    db.prepare(`UPDATE raw_materials SET current_stock = current_stock - ? WHERE id = ?`)
      .run(stockQty, line.material_id);

    // MOVEMENT RECORD: the central debit half of an issue. The RECEIVING
    // DEPARTMENT was never on this row — it lived only on the paired department
    // row and on requisition_issue_ledger — so "where did central's stock go"
    // could not be answered from the central rail alone. It can now.
    invTxnId = generateId();
    postCentralTxn(db, {
      id: invTxnId,          // pre-minted: the caller returns and cross-references it
      materialId: line.material_id,
      type: 'requisition_issue',
      quantity: -stockQty,
      referenceId: line.req_id,
      notes: `Requisition issue (${input.reason})`,
      outletId: line.outlet_id || null,
      counterparty: deptParty(db, String(line.department_id || '')),
      actor: String(input.actor || '').trim() || 'system:requisition-issue',
    });
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
  if (!writesLedgerRow) {
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
      // THE SAME FALLBACK AS THE CENTRAL HALF ABOVE, deliberately identical.
      // These two writes are one movement — central loses it, the department
      // gains it — and they used to disagree about a blank actor: central
      // defaulted to 'system:requisition-issue' while this half passed '',
      // which postDeptLedger now REFUSES. A blank-actor issue therefore debited
      // central, wrote both audit rows, and then threw before crediting anyone:
      // 5 kg left the store and reached nobody. Both live callers happen to
      // wrap this in a transaction and pass a session email behind a 401, so it
      // rolls back today — but the asymmetry is the bug, and a symmetric
      // machine actor is a true answer where '' never was.
      user: String(input.actor || '').trim() || 'system:requisition-issue',
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
