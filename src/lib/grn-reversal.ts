import type Database from 'better-sqlite3';
import { logAuditEvent, generateId } from './db';
import { packFactor } from './pack-units';
import { getCentralStoreCutoverDate } from './central-cutover';
import { alreadyReturnedByGrnItem } from './returns';
import { centralFlowBlock } from './store-engine';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ THE GRN REVERSAL — ONE COPY, TWO CALLERS.                                ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Until this file existed the reversal lived INLINE in the DELETE handler of
 * src/app/api/grn/[id]/route.ts and nowhere else. A line amendment needs the
 * same five movements — read what actually moved, refuse if taking it back would
 * go negative, snapshot before destroying, delete the cost row and its movement,
 * re-derive last_purchase_price only where this bill owns it — so it either
 * shares this code or becomes a SECOND reversal free to drift from the first.
 * It shares it. Both callers are in this file's contract:
 *
 *   · DELETE /api/grn/[id]  (void)        → reverseGrnMovement({ grnId })
 *   · PATCH  /api/grn/[id]  (line amend)  → amendGrnLines(...), which calls the
 *                                            same primitives per line
 *
 * ── THE FOUR WRITES A RECEIPT MAKES, WHICH ANY CORRECTION MUST UNDO ────────
 * Per accepted line both receiving routes write, in this order:
 *   1. goods_receipt_note_items  — the BILL DOCUMENT (quantities, rate, charges)
 *   2. purchases                 — the COST row (₹, purchase units)
 *   3. raw_materials             — current_stock += qty × packFactor, and
 *                                  last_purchase_price / _date overwritten
 *   4. inventory_transactions    — type 'purchase', reference_id = purchases.id,
 *                                  in RECIPE units. THE ONLY RECORD of what
 *                                  actually moved.
 * …then updateMaterialPrice() rewrites average_price and cascades into every
 * sub-recipe and recipe. That last step does its own writes and MUST run after
 * the commit, never inside the transaction.
 *
 * ── REVERSE BY THE RECORD, NEVER BY A RECOMPUTE ────────────────────────────
 * The debit is inventory_transactions.quantity as recorded, never
 * accepted × pack_size recomputed today. pack_size is mutable (that is what the
 * unit-audit lock exists for), so a recompute can subtract a different number
 * than was added. Where a correction needs BOTH a reversal and a re-credit, the
 * two bases must agree or the correction is refused outright — see
 * `pack_factor_drift` in amendGrnLines.
 *
 * ── REFUSE, NEVER CLAMP ────────────────────────────────────────────────────
 * Stated in src/lib/return-stock.ts and re-stated here because it is the whole
 * doctrine of this rail: a reversal that clamps commits a correction claiming to
 * have moved more than really moved. Refusing is reversible; a stray stock
 * credit is not, and a wrong on-hand silently corrupts every recipe cost and
 * variance figure downstream. Every guard below throws GrnRefused, which rolls
 * the whole transaction back.
 *
 * ── NEVER WRITE A NEGATIVE `purchases` ROW ─────────────────────────────────
 * Also from return-stock.ts: updateMaterialPrice's FIFO branch takes the newest
 * unit_price, so a negative row BECOMES the material's price and cascades a
 * nonsense rate into every recipe. A reversal DELETES the row (snapshotted into
 * the audit event first); a correction REWRITES it in place.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shared primitives
// ─────────────────────────────────────────────────────────────────────────────

/** An error carrying the HTTP status it should surface as, an optional payload,
 *  and an optional machine-readable `code` the modal can branch on. Thrown from
 *  inside db.transaction(), where a Response cannot be returned, and unwrapped
 *  by the route handler's catch — the shape
 *  api/purchase-orders/[id]/receive/route.ts uses.
 *
 *  THE POSITIONAL SIGNATURE IS (status, message, payload) AND MUST STAY THAT WAY:
 *  it is the signature the void and the bill-level amend in api/grn/[id] already
 *  throw with at ~15 call sites, and this class was lifted OUT of that file so
 *  the line-amendment path could share one error type. `code` is appended, never
 *  inserted, so not one of those call sites changes meaning. */
export class GrnRefused extends Error {
  httpStatus: number;
  payload?: Record<string, unknown>;
  code?: string;
  constructor(status: number, message: string, payload?: Record<string, unknown>, code?: string) {
    super(message);
    this.httpStatus = status;
    this.payload = payload;
    this.code = code;
  }
}

/** Build a refusal CODE-FIRST. Every refusal raised inside this file is
 *  addressed to a modal that has to branch on it, so the code is the argument
 *  that must not be forgotten; the exported class keeps the older positional
 *  (status, message, payload) signature its ~15 existing call sites in
 *  api/grn/[id]/route.ts already use. One class, two ergonomics, no drift. */
function refuse(status: number, code: string, message: string, payload?: Record<string, unknown>): GrnRefused {
  return new GrnRefused(status, message, payload, code);
}

export const EPS = 1e-9;
/** Quantity comparison tolerance. Wider than EPS because these numbers arrive
 *  through JSON and through SQLite REALs; 1e-6 is the same tolerance
 *  src/lib/grn-qc.ts uses on the very same columns. */
export const QTY_EPS = 1e-6;
export const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
export const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
export const r4 = (n: number) => Math.round((Number(n) || 0) * 1e4) / 1e4;

/**
 * WRITE THE AUDIT ROW, OR ABORT THE WHOLE OPERATION.
 *
 * logAuditEvent (src/lib/db.ts) is deliberately best-effort — it catches its own
 * error and returns, so an audit failure never breaks the parent operation. That
 * is the right default nearly everywhere and the WRONG one on this rail, because
 * the before_json it writes is THE ONLY COPY of the `purchases` rows, the
 * inventory_transactions rows and the pre-correction price fields that are about
 * to be destroyed. Swallow that insert and the correction still commits: the old
 * figures are gone, there is nothing to rebuild them from, and the caller is told
 * `success: true`. A stock movement with no record is the one outcome that must
 * be impossible.
 *
 * So the insert is VERIFIED rather than trusted: count before, log, count after,
 * throw unless it went up by exactly one. Thrown inside the caller's
 * db.transaction(), which rolls the claim, the stamps and the writes back
 * together. Any failure to even READ the count is also a throw — "cannot prove
 * the record was written" is not "the record was written".
 *
 * MOVED HERE from api/grn/[id]/route.ts unchanged (same three failure messages,
 * same 500) so the void, the bill-level amend and the line amend all record
 * through one implementation.
 */
export function logAuditOrThrow(
  db: Database.Database,
  params: Parameters<typeof logAuditEvent>[1],
  whatWouldBeLost: string,
): void {
  const count = () => (db.prepare(
    `SELECT COUNT(*) AS n FROM audit_events WHERE entity_type = ? AND entity_id = ? AND event_type = ?`
  ).get(params.entity_type, params.entity_id, params.event_type) as any)?.n;
  let before: number;
  try {
    before = Number(count());
    if (!Number.isFinite(before)) throw new Error('audit_events unreadable');
  } catch (e: any) {
    throw refuse(500, 'audit_unreadable',
      `The audit log could not be read (${e?.message || 'unknown error'}), so ${whatWouldBeLost} cannot be recorded. Nothing was changed.`);
  }
  logAuditEvent(db, params);
  let after: number;
  try {
    after = Number(count());
  } catch (e: any) {
    throw refuse(500, 'audit_unverifiable',
      `The audit log could not be verified (${e?.message || 'unknown error'}), so ${whatWouldBeLost} cannot be recorded. Nothing was changed.`);
  }
  if (after !== before + 1) {
    throw refuse(500, 'audit_write_failed',
      `The audit record for this action could not be written, so ${whatWouldBeLost} would leave no trail. Nothing was changed — check the server log for the [audit] error and try again.`);
  }
}

/** Recipe units per purchase unit for a material, through the ONE helper that
 *  carries both halves of the guard (pack_size > 1 AND recipe unit ≠ purchase
 *  unit). Never re-derived locally — a local `pack_size > 1` alone mis-converts
 *  every material whose recipe unit already equals its purchase unit. */
export function packFactorOf(db: Database.Database, materialId: string): number {
  const m = db.prepare(`SELECT pack_size, unit, purchase_unit FROM raw_materials WHERE id = ?`).get(materialId) as any;
  if (!m) return 1;
  return packFactor({ pack_size: m.pack_size, unit: m.unit, purchase_unit: m.purchase_unit } as any);
}

export interface RecordedMove {
  material_id: string;
  material_name: string;
  /** SUM(inventory_transactions.quantity) — RECIPE units, AS RECORDED. */
  qty: number;
  /** raw_materials.current_stock, read under the write lock. */
  current_stock: number;
}

/**
 * WHAT THIS RECEIPT ACTUALLY PUT INTO STOCK, from the recorded rows.
 *
 * Scoped to one material when `materialId` is given — that is how a per-line
 * unwind is expressed, and it is exact because ONE MATERIAL = ONE LINE is
 * enforced on every writer by duplicateLineError (src/lib/line-dedupe.ts).
 * `purchases` has NO grn_item_id, so (grn_id, material_id) is the only per-line
 * key from a cost row back to a GRN line, and the caller proves the match is
 * exactly one row before writing (assertLineReversible below).
 */
export function collectRecordedMoves(
  db: Database.Database,
  grnId: string,
  materialId?: string | null,
): RecordedMove[] {
  const rows = db.prepare(`
    SELECT it.material_id                        AS material_id,
           COALESCE(rm.name, it.material_id)     AS material_name,
           SUM(it.quantity)                      AS qty,
           rm.current_stock                      AS current_stock
    FROM inventory_transactions it
    JOIN purchases p ON p.id = it.reference_id
    LEFT JOIN raw_materials rm ON rm.id = it.material_id
    WHERE it.type = 'purchase' AND p.grn_id = ?
      ${materialId ? 'AND p.material_id = ?' : ''}
    GROUP BY it.material_id
  `).all(...(materialId ? [grnId, materialId] : [grnId])) as any[];
  return rows.map(r => ({
    material_id: String(r.material_id),
    material_name: String(r.material_name),
    qty: Number(r.qty) || 0,
    // A LEFT JOIN miss (the master row was deleted out from under the receipt)
    // must NOT read as an empty pool: Number(null) is 0, which is finite, so it
    // sailed past the material_missing branch below and the guard then treated a
    // material that does not exist as one holding nothing. NaN is what that
    // branch was written to catch, and it is the honest value — "unknown", not
    // "zero". Both callers refuse on it; nothing is silently debited.
    current_stock: r.current_stock == null ? NaN : Number(r.current_stock),
  }));
}

export interface MaterialSnapshot {
  material_id: string;
  material_name: string;
  reversed_qty: number;
  current_stock: number | null;
  average_price: number | null;
  last_purchase_price: number | null;
  last_purchase_date: string | null;
}

/** A VERBATIM audit snapshot of the four price/stock fields a correction
 *  overwrites with no history kept anywhere else.
 *
 *  rate-basis: mixed — NEVER a valuation. raw_materials.last_purchase_price is
 *  stored in mixed bases across live rows (see the LPP trap); nothing here
 *  divides, multiplies, sums or compares it against another material's figure.
 *  It is copied so the pre-correction value is recoverable. */
export function snapshotMaterials(db: Database.Database, moves: RecordedMove[]): MaterialSnapshot[] {
  return moves.map(m => {
    const rm = db.prepare(`
      -- rate-basis: mixed  (verbatim audit snapshot — never valued, never compared)
      SELECT current_stock, average_price, last_purchase_price, last_purchase_date
      FROM raw_materials WHERE id = ?
    `).get(m.material_id) as any;
    return {
      material_id: m.material_id,
      material_name: m.material_name,
      reversed_qty: r6(m.qty),
      current_stock: rm?.current_stock ?? null,
      average_price: rm?.average_price ?? null,
      last_purchase_price: rm?.last_purchase_price ?? null,
      last_purchase_date: rm?.last_purchase_date ?? null,
    };
  });
}

/**
 * THE NEGATIVE-STOCK GUARD. On EVERY material, BEFORE any write.
 *
 * `replacement` is what this correction will PUT BACK in recipe units, keyed by
 * material — 0 for a void, the new credit for a quantity correction. So the test
 * is on the NET delta:
 *
 *     delta = recorded_in − new_in        (> 0 = we are taking stock back out)
 *     refuse if r6(current_stock − delta) < −EPS
 *
 * With replacement 0 this reduces EXACTLY to the void's original guard, which is
 * why the two share it. A correction that takes NOTHING out (delta ≤ 0 — a
 * rate-only correction, or a quantity correction upwards) is not this guard's
 * business at all, and `onlyWhenDebiting` is how the amendment says so; see the
 * parameter note below for why the raw test alone got that case wrong.
 *
 * ── WHAT `current_stock` IS, AND WHAT IT CANNOT SEE ────────────────────────
 * It is the authoritative answer to the only question this guard asks: "is there
 * enough book stock RIGHT NOW to take this back out". It is read fresh inside
 * the transaction, under the write lock the caller's claim already took. It is
 * NOT an observation of the shelf — src/lib/central-cutover.ts states it: a
 * running balance of opening + recorded inflows − recorded outflows, where every
 * term is a RECORDING EVENT and the shelf is never consulted. Four things it
 * therefore cannot see, each of which the caller must not pretend otherwise
 * about:
 *
 *   1. LOT IDENTITY. Nothing anywhere attributes a gram on hand to the receipt
 *      that brought it in. The message may honestly say "the pool now holds only
 *      X"; it must NEVER claim "this bill's goods were consumed", which nothing
 *      in the schema can prove.
 *   2. PRE-LEDGER ISSUES. ~14,149 historical requisition issues were never
 *      debited on the inventory_transactions rail (src/lib/issue-stock.ts) — the
 *      clamp there exists for exactly that reason — so the ledger is not a
 *      substitute for this column.
 *   3. A COMMITTED CENTRAL-STORE CUTOVER re-based current_stock with NO ledger
 *      row at all, so the number after one is not reconstructible from movements.
 *      That is a separate, earlier bar (`cutover_absorbed`), not this one.
 *   4. DEPARTMENT CONSUMPTION. Recipe consumption at KOT-complete does not touch
 *      central at all (db.ts:7505 — the gram left central at the requisition
 *      issue), so it must NOT be counted into this test a second time.
 *
 * And it can be legitimately NEGATIVE before any correction: an incomplete
 * purchase history makes that an ordinary state, not a corruption event
 * (api/inventory/fix-negative-stock). So this guard will refuse a legitimate
 * downward correction on such a material. That is the intended trade — the
 * message names the material, the figures and the remedy, and a stock adjustment
 * is the rail that can move a number the receipt cannot honestly move.
 */
export interface BlockedMaterial {
  material_id: string; material_name: string;
  /** raw_materials.current_stock, recipe units. */
  on_hand: number;
  /** What this receipt actually put in, recipe units, AS RECORDED. */
  recorded_in: number;
  /** What the correction would put back, recipe units. 0 for a void. */
  new_in: number;
  /** recorded_in − new_in. Positive = stock is being taken back out. */
  delta: number;
  /** How far past zero the delta reaches. */
  short_by: number;
  /** The void's original one-line phrasing, kept so its response payload —
   *  `materials: string[]` — does not change shape for a caller already
   *  rendering it. */
  text: string;
}

/**
 * @param verb          how the refusal names the material-missing case
 *                      ("reversed" for a void, "corrected" for an amendment)
 * @param build         builds the refusal message from the blocked list. Passed
 *                      in rather than composed here so the VOID keeps the exact
 *                      sentence and the exact `materials: string[]` payload it
 *                      has always returned, while the line amendment can say the
 *                      more specific thing its modal needs.
 * @param onlyWhenDebiting
 *                      SKIP the test entirely on a material this correction does
 *                      not take stock OUT of (delta ≤ 0). OPT-IN, and the VOID
 *                      DOES NOT PASS IT — its behaviour is byte-unchanged.
 *
 *                      The raw test `current_stock − delta < 0` is exactly right
 *                      for the void, where new_in is always 0 so delta is always
 *                      the full recorded credit and always positive. On an
 *                      AMENDMENT delta can be zero (a rate-only correction) or
 *                      NEGATIVE (a quantity correction UPWARDS), and on a
 *                      material whose current_stock is ALREADY negative —
 *                      an ordinary state on this book, not a corruption event,
 *                      which is why api/inventory/fix-negative-stock exists —
 *                      `cur − delta ≥ cur` still fails the test. The route then
 *                      refused a correction that could not possibly make the
 *                      balance worse, and told the admin that goods had "already
 *                      gone out". That was a wrong bar in the wrong direction:
 *                      the correction that REDUCES a negative balance is the one
 *                      it was blocking. A correction that only adds stock, or
 *                      moves none at all, cannot drive anything below zero and
 *                      is not this guard's business.
 */
export function assertNoNegativeStock(
  moves: RecordedMove[],
  replacement: Map<string, number>,
  opts: {
    code: string; verb: string;
    build: (blocked: BlockedMaterial[]) => { message: string; payload: Record<string, unknown> };
    onlyWhenDebiting?: boolean;
  },
): void {
  const blocked: BlockedMaterial[] = [];
  for (const m of moves) {
    const cur = Number(m.current_stock);
    if (!Number.isFinite(cur)) {
      throw refuse(409, 'material_missing',
        `Material ${m.material_name} no longer exists in the master, so its stock cannot be ${opts.verb}.`);
    }
    const newIn = Number(replacement.get(m.material_id) ?? 0);
    const delta = r6(m.qty - newIn);
    if (opts.onlyWhenDebiting && delta <= EPS) continue;
    if (r6(cur - delta) < -EPS) {
      blocked.push({
        material_id: m.material_id, material_name: m.material_name,
        on_hand: r6(cur), recorded_in: r6(m.qty), new_in: r6(newIn),
        delta, short_by: r6(delta - cur),
        text: `${m.material_name} (on hand ${r6(cur)}, this GRN added ${r6(m.qty)})`,
      });
    }
  }
  if (blocked.length === 0) return;
  const { message, payload } = opts.build(blocked);
  throw refuse(409, opts.code, message, payload);
}

/**
 * WHOSE last_purchase_price IS IT? Decided BEFORE the rows are touched, and it
 * decides whether the field is written at all.
 *
 * The column is a straight overwrite with no history: whoever received last owns
 * it. Re-deriving it unconditionally rewrote materials the bill never set —
 * measured on live data, Sugar's LPP was 10 (a different GRN), the bill's rate
 * was 100, and an unconditional re-derive moved it to 60 (a third GRN). LPP
 * seeds the next PO's rate and is read on the requisition and unit-audit
 * screens. Worse, re-deriving RE-BASES: the newest surviving purchases.unit_price
 * is purchase-basis while ~105 live rows of this column are recipe-basis, so an
 * untouched recipe-basis row could jump 500×.
 *
 * OWNERSHIP IS PROVEN, NOT ASSUMED: a row of THIS receipt must match BOTH the
 * stored last_purchase_date and the stored last_purchase_price (to 6 dp).
 * Anything else — including "cannot tell" — leaves the column exactly as it is.
 *
 * THE CANDIDATE RATE DIFFERS BY ORIGIN, and both are offered here:
 *   · ad-hoc  — POST /api/grn wrote `price`, the same figure as purchases.unit_price
 *   · PO      — receive/route.ts wrote the GROSS gi.unit_price while
 *               purchases.unit_price is NET of the bill discount. decideGrnQc
 *               does the same on both paths ("last_purchase_price keeps the
 *               GROSS rate on BOTH paths"). Seeding it net would ratchet the
 *               ordered rate down every cycle.
 * A match on EITHER proves this receipt wrote the value, because exactly one of
 * them is what its writer used.
 *
 * THIS IS AN IDENTITY TEST, NOT A VALUATION — which is why reading the banned
 * column here is safe. Nothing is converted, scaled, summed or displayed: the
 * stored value is compared ONLY against the very figure that WROTE it, so both
 * sides are the same number in whatever basis that receipt used. A basis
 * mismatch cannot make this comparison wrong; it can only make it not match,
 * which is the fail-safe answer "leave the column alone".
 */
export function proveLppOwnership(
  moves: RecordedMove[],
  snapshot: MaterialSnapshot[],
  candidateRates: Map<string, number[]>,
  candidateDates: Map<string, string[]>,
): Set<string> {
  const prev = new Map(snapshot.map(s => [s.material_id, s]));
  const owned = new Set<string>();
  for (const m of moves) {
    const p = prev.get(m.material_id);
    // rate-basis: mixed — identity test only; compared against the very row that wrote it, never valued.
    if (!p || p.last_purchase_date == null || p.last_purchase_price == null) continue;
    const dates = candidateDates.get(m.material_id) || [];
    const rates = candidateRates.get(m.material_id) || [];
    const dateOk = dates.some(d => String(d ?? '').trim() === String(p.last_purchase_date ?? '').trim());
    // rate-basis: mixed — identity test only; compared against the very row that wrote it, never valued.
    const rateOk = rates.some(v => r6(Number(v)) === r6(Number(p.last_purchase_price)));
    if (dateOk && rateOk) owned.add(m.material_id);
  }
  return owned;
}

/** Newest surviving purchase for a material.
 *
 *  `rowid DESC` is the final tiebreak and it is not decorative: every purchase
 *  row of one delivery shares a `date` and created_at is second-resolution, so
 *  `date DESC, created_at DESC` alone leaves the winner to SQLite's scan order.
 *  rowid is monotonic per insert, so "newest" means newest.
 *
 *  `grossBasis` PICKS A DIFFERENT COLUMN OFF THE SAME WINNING ROW, and it is the
 *  difference between re-seeding last_purchase_price honestly and ratcheting it
 *  down every cycle. last_purchase_price is a GROSS column on both receiving
 *  routes — receive/route.ts writes the bill's list rate into it while
 *  purchases.unit_price is NET of the allocated bill discount, and both that file
 *  and grn-qc.ts say why in the same words: seed it net and the next PO is raised
 *  at the discounted rate, then the rate lock trips when the vendor bills their
 *  unchanged list price. So a caller re-deriving a GROSS column asks for the
 *  winning purchase's BILL-LINE rate (gi.unit_price), not its cost rate. A
 *  purchase with no GRN behind it (a direct /api/purchases row) has no bill line
 *  and no discount netting, so its own unit_price IS the gross rate — that is
 *  what the COALESCE falls back to. DEFAULT FALSE: the void has always re-derived
 *  from purchases.unit_price and this does not change what it does. */
export function newestSurvivingPurchase(
  db: Database.Database, materialId: string, grossBasis = false,
): { unit_price: number; date: string } | null {
  if (!grossBasis) {
    return (db.prepare(
      `SELECT unit_price, date FROM purchases WHERE material_id = ? ORDER BY date DESC, created_at DESC, rowid DESC LIMIT 1`
    ).get(materialId) as any) || null;
  }
  return (db.prepare(`
    -- rate-basis: purchase, GROSS — the bill line's rate, never the netted cost rate.
    SELECT COALESCE(gi.unit_price, p.unit_price) AS unit_price, p.date AS date
      FROM purchases p
      LEFT JOIN goods_receipt_note_items gi
             ON gi.grn_id = p.grn_id AND gi.material_id = p.material_id
     WHERE p.material_id = ?
     ORDER BY p.date DESC, p.created_at DESC, p.rowid DESC
     LIMIT 1
  `).get(materialId) as any) || null;
}

export interface ReversalOutcome {
  materials: Array<{ material_id: string; material_name: string; reversed_qty: number }>;
  purchases_deleted: number;
  transactions_deleted: number;
  purchase_rows: any[];
  transaction_rows: any[];
  material_snapshot: MaterialSnapshot[];
  last_purchase_stale: Array<{ material_id: string; material_name: string }>;
  last_purchase_kept: Array<{ material_id: string; material_name: string }>;
  /** Materials whose last_purchase_price this receipt owned and which were
   *  re-derived from the newest surviving purchase. ADDITIVE — the void does not
   *  read it (its response has always reported only `stale` and `kept`); the line
   *  amendment does, so a removal can say what the rate became instead of leaving
   *  the caller to guess it was silently rewritten. */
  last_purchase_rederived: Array<{ material_id: string; material_name: string; rate: number; date: string }>;
}

/**
 * THE REVERSAL. Snapshot, delete the cost rows and their movements, debit the
 * stock by what was RECORDED, and re-derive last_purchase_price only where this
 * receipt owns it.
 *
 * Called by the void with no `materialId` (the whole receipt) and by a line
 * removal with one (that line's material). The caller has ALREADY taken the
 * write lock with its conditional claim, ALREADY run its own refusal ladder and
 * ALREADY called assertNoNegativeStock — this function does not re-litigate
 * those, it performs the movement.
 */
export function reverseGrnMovement(
  db: Database.Database,
  opts: {
    grnId: string; materialId?: string | null; moves: RecordedMove[];
    /** Also accept the GRN line's GROSS rate as proof this receipt owns
     *  last_purchase_price.
     *
     *  DEFAULT FALSE, ON PURPOSE. The void has always proved ownership against
     *  purchases.unit_price ALONE and this extraction does not change what it
     *  does. On a PO receipt (and on an ad-hoc receipt signed off by decideGrnQc
     *  where the line carried a discount) LPP holds the GROSS rate while
     *  purchases.unit_price is NET, so the narrow test answers "cannot tell" and
     *  the column is left alone and reported in `last_purchase_kept` — a
     *  fail-safe, not a correct answer. The void never meets that case (it
     *  refuses PO receipts outright), so widening it there would be a behaviour
     *  change to a shipped path for no gain. The line amendment DOES meet it and
     *  passes true. */
    includeGrossCandidate?: boolean;
  },
): ReversalOutcome {
  const { grnId, materialId, moves } = opts;
  const scoped = !!materialId;

  const transaction_rows = db.prepare(`
    SELECT it.id, it.material_id, it.type, it.quantity, it.reference_id, it.notes, it.created_at, it.outlet_id
    FROM inventory_transactions it
    JOIN purchases p ON p.id = it.reference_id
    WHERE it.type = 'purchase' AND p.grn_id = ?
      ${scoped ? 'AND p.material_id = ?' : ''}
  `).all(...(scoped ? [grnId, materialId] : [grnId])) as any[];
  const purchase_rows = db.prepare(`
    SELECT * FROM purchases WHERE grn_id = ? ${scoped ? 'AND material_id = ?' : ''}
  `).all(...(scoped ? [grnId, materialId] : [grnId])) as any[];
  const material_snapshot = snapshotMaterials(db, moves);

  // Ownership decided BEFORE the delete — both candidate rates come off the rows
  // about to disappear (see proveLppOwnership for why there are two).
  const rates = new Map<string, number[]>();
  const dates = new Map<string, string[]>();
  for (const p of purchase_rows) {
    const k = String(p.material_id);
    // rate-basis: mixed — identity test only; compared against the very row that wrote it, never valued.
    rates.set(k, [...(rates.get(k) || []), Number(p.unit_price)]);
    dates.set(k, [...(dates.get(k) || []), String(p.date ?? '')]);
  }
  if (opts.includeGrossCandidate) {
    for (const gi of db.prepare(
      `SELECT material_id, unit_price FROM goods_receipt_note_items WHERE grn_id = ? ${scoped ? 'AND material_id = ?' : ''}`
    ).all(...(scoped ? [grnId, materialId] : [grnId])) as any[]) {
      const k = String(gi.material_id);
      // The PO path's LPP candidate: the GROSS rate on the bill line.
      rates.set(k, [...(rates.get(k) || []), Number(gi.unit_price)]);
    }
  }
  const ownsLpp = proveLppOwnership(moves, material_snapshot, rates, dates);

  const out: ReversalOutcome = {
    materials: [], purchases_deleted: 0, transactions_deleted: 0,
    purchase_rows, transaction_rows, material_snapshot,
    last_purchase_stale: [], last_purchase_kept: [], last_purchase_rederived: [],
  };

  // Movements first — the subquery still needs the purchases rows to resolve
  // reference_id. Both use a SUBQUERY rather than an IN list, so a GRN with
  // hundreds of lines can never hit SQLite's 999-variable ceiling.
  out.transactions_deleted = db.prepare(`
    DELETE FROM inventory_transactions
    WHERE type = 'purchase' AND reference_id IN (
      SELECT id FROM purchases WHERE grn_id = ? ${scoped ? 'AND material_id = ?' : ''}
    )
  `).run(...(scoped ? [grnId, materialId] : [grnId])).changes;
  out.purchases_deleted = db.prepare(
    `DELETE FROM purchases WHERE grn_id = ? ${scoped ? 'AND material_id = ?' : ''}`
  ).run(...(scoped ? [grnId, materialId] : [grnId])).changes;

  const debit = db.prepare(
    `UPDATE raw_materials SET current_stock = current_stock - ?, updated_at = datetime('now') WHERE id = ?`
  );
  const setLpp = db.prepare(
    `UPDATE raw_materials SET last_purchase_price = ?, last_purchase_date = ?, updated_at = datetime('now') WHERE id = ?`
  );
  for (const m of moves) {
    debit.run(m.qty, m.material_id);
    if (ownsLpp.has(m.material_id)) {
      // The re-derivation follows the basis the COLUMN is on, not the basis the
      // cost row is on. `includeGrossCandidate` is exactly the flag that says
      // "this caller meets PO receipts", and a PO cost row is NET — re-seeding
      // last_purchase_price from it is the ratchet receive/route.ts warns about.
      const latest = newestSurvivingPurchase(db, m.material_id, !!opts.includeGrossCandidate);
      if (latest) {
        setLpp.run(latest.unit_price, latest.date, m.material_id);
        out.last_purchase_rederived.push({
          material_id: m.material_id, material_name: m.material_name,
          rate: Number(latest.unit_price), date: String(latest.date ?? ''),
        });
      } else out.last_purchase_stale.push({ material_id: m.material_id, material_name: m.material_name });
    } else {
      out.last_purchase_kept.push({ material_id: m.material_id, material_name: m.material_name });
    }
    out.materials.push({ material_id: m.material_id, material_name: m.material_name, reversed_qty: r6(m.qty) });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// LINE AMENDMENT
// ─────────────────────────────────────────────────────────────────────────────

export interface AmendLineInput {
  /** goods_receipt_note_items.id */
  id: string;
  /** Delete the line row outright. Mutually exclusive with the value fields. */
  remove?: boolean;
  quantity_received?: number;
  quantity_accepted?: number;
  unit_price?: number;
  /** The values the caller SAW. The optimistic lock — see the claim below. */
  expect: { quantity_received: number; quantity_accepted: number; unit_price: number };
}

export interface AmendLineChange {
  grn_item_id: string;
  material_id: string;
  material_name: string;
  action: 'updated' | 'removed';
  before: { quantity_received: number; quantity_accepted: number; quantity_rejected: number; unit_price: number; cgst: number; sgst: number; compensation_cess: number };
  after: { quantity_received: number; quantity_accepted: number; quantity_rejected: number; unit_price: number; cgst: number; sgst: number; compensation_cess: number } | null;
  cost_row: 'updated' | 'created' | 'deleted' | 'none';
  /** Recipe units added (+) or taken back (−) from current_stock by this line. */
  stock_delta_recipe: number;
  on_hand_before: number | null;
  on_hand_after: number | null;
}

export interface AmendGrnLinesResult {
  grn_id: string;
  grn_number: string;
  /** 'held' = awaiting_qc, no stock effect existed and none was created.
   *  'inwarded' = the four writes existed and were unwound + reapplied. */
  state: 'held' | 'inwarded';
  status_before: string;
  status_after: string;
  edit_count: number;
  edited_at: string | null;
  edited_by: string;
  changes: AmendLineChange[];
  materials_touched: string[];
  purchases_deleted: number;
  purchases_created: number;
  purchases_updated: number;
  transactions_deleted: number;
  transactions_created: number;
  transactions_updated: number;
  last_purchase_updated: Array<{ material_id: string; material_name: string; rate: number }>;
  last_purchase_kept: Array<{ material_id: string; material_name: string }>;
  last_purchase_stale: Array<{ material_id: string; material_name: string }>;
  po_total_restamped: boolean;
  po_total_cost: number | null;
  warnings: string[];
  /** Lines that, AFTER this correction, no longer match what the purchase order
   *  says — short, over, short-accepted or off-rate. Collected inside the
   *  transaction and raised as the SAME admin alert the receive route raises,
   *  AFTER the commit (see raisePoDeviationAlert). Empty on an ad-hoc receipt. */
  po_deviation: PoDeviationLine[];
  po_number: string | null;
  po_id: string | null;
}

/** One amended PO line measured against the order, in PURCHASE units and
 *  ₹/purchase-unit — the same shape and the same four flags
 *  api/purchase-orders/[id]/receive/route.ts builds for its alert. */
export interface PoDeviationLine {
  material_id: string;
  material_name: string;
  unit_pu: string;
  ordered: number;
  ordered_rate: number;
  received: number;
  accepted: number;
  actual_rate: number;
  qty_short: boolean;
  qty_excess: boolean;
  acc_short: boolean;
  rate_changed: boolean;
  value_impact: number;
  excess_value: number;
  reason: string;
}

/** Every line row this route reads or rewrites, in one place so the SELECT and
 *  the UPDATE can never drift about which columns exist. */
const LINE_COLS = `
  gi.id, gi.grn_id, gi.po_item_id, gi.material_id, gi.quantity_ordered, gi.quantity_received,
  gi.quantity_accepted, gi.quantity_rejected, gi.rejection_reason, gi.unit_price, gi.notes,
  gi.discount, gi.cgst, gi.sgst, gi.compensation_cess, gi.special_excise_cess, gi.tcs,
  gi.delivery_charges, gi.mrp_round_off, gi.gst_rate, gi.cess_rate, gi.cost_vendor, gi.cost_note,
  gi.qc_applied_at
`;

/**
 * THE TAX FOLLOWS THE GOODS — re-derived on every value change.
 *
 * Arithmetic is both receiving routes' and decideGrnQc's, to the paisa:
 *     GST  base = ACCEPTED gross MINUS the discount share  (post-discount)
 *     CESS base = the ACCEPTED gross, BEFORE any discount   (owner ruling 2026-08-07)
 *     taxPaise = round(base × rate)  ·  sgst = floor(tax/2)  ·  odd paisa to CGST
 * `taxable` is already 2-dp rupees, so base × rate IS the tax in whole paise (the
 * ÷100 for percent and the ×100 for paise cancel). Halving in integer paise is
 * what keeps cgst + sgst re-adding to the tax EXACTLY — the house invariant every
 * reader re-adds. A third rounding convention across the purchase paths is how a
 * GST return stops reconciling.
 *
 * THE MANUAL-TAX LINE, which the percent path cannot see: `gst_rate: ''` is a
 * live option on the ad-hoc form and /api/grn then stores the typed rupees with
 * gst_rate 0. There is no rate to recompute from, so the only honest operation is
 * to scale the recorded rupees by the ratio the goods moved by — exactly what
 * grn-qc.ts does on a QC rejection of such a line.
 *
 * AND THE MANUAL LINE THAT IS BOOKING UP FROM ZERO. Scaling by the ACCEPTED base
 * has no ratio when the old accepted was 0 — which is precisely the shape a
 * QC-rejected line, or an ungated line the bay turned away, is left in. Left at
 * "no ratio, keep the rupees verbatim", re-booking that line at a fraction of the
 * delivery kept the FULL typed tax against a smaller goods value: 5 units at ₹100
 * carrying ₹162 of tax, a 32% claim, reported as success with no warning. The
 * typed rupees were entered against the line as RECEIVED (POST /api/grn stores
 * them verbatim regardless of accepted), so the received base is the figure they
 * belong to and is the honest fallback ratio. Only when that is 0 too — nothing
 * arrived and nothing was accepted — is there genuinely nothing to scale by, and
 * the rupees stand as typed.
 *
 * THE VENDOR'S DISCOUNT IS NOT RE-CUT. gi.discount is what the bill says and
 * stays as recorded, the same rule decideGrnQc applies.
 */
function deriveLineTax(
  line: any,
  newAccepted: number,
  newPrice: number,
  oldAccepted: number,
  oldReceived: number,
): { cgst: number; sgst: number; compensation_cess: number } {
  const gstRate = Number(line.gst_rate) || 0;
  const cessRate = Number(line.cess_rate) || 0;
  const discShare = Number(line.discount) || 0;
  if (gstRate > 0 || cessRate > 0) {
    // rate-basis: purchase — quantity_accepted is PURCHASE units and unit_price
    // is ₹/purchase-unit on a GRN line (canon), so the product is ₹.
    const grossTax = r2((newAccepted > 0 ? newAccepted : 0) * newPrice);
    const taxable = r2(grossTax - discShare);
    const taxPaise = gstRate > 0 ? Math.max(0, Math.round(taxable * gstRate)) : 0;
    const sgstPaise = Math.floor(taxPaise / 2);
    const cgstPaise = taxPaise - sgstPaise;   // odd paisa lands in CGST, per the contract
    const cessPaise = cessRate > 0 ? Math.max(0, Math.round(grossTax * cessRate)) : 0;
    return { cgst: cgstPaise / 100, sgst: sgstPaise / 100, compensation_cess: cessPaise / 100 };
  }
  const manualCgst = Number(line.cgst) || 0;
  const manualSgst = Number(line.sgst) || 0;
  const manualCess = Number(line.compensation_cess) || 0;
  const hasManual = (manualCgst + manualSgst + manualCess) > 0;
  if (!hasManual) return { cgst: 0, sgst: 0, compensation_cess: 0 };
  // No rate to recompute from. Scale by how the goods value moved. When the old
  // ACCEPTED base is 0 the line never booked, and the typed rupees belong to what
  // ARRIVED — that is the base POST /api/grn stored them against — so the
  // received base is the fallback ratio rather than "keep them verbatim".
  const oldUnit = Number(line.unit_price) || 0;
  const oldAcceptedBase = r2((oldAccepted > 0 ? oldAccepted : 0) * oldUnit);
  const oldBase = oldAcceptedBase > 0 ? oldAcceptedBase : r2((oldReceived > 0 ? oldReceived : 0) * oldUnit);
  const newBase = r2((newAccepted > 0 ? newAccepted : 0) * newPrice);
  if (oldBase <= 0) return { cgst: manualCgst, sgst: manualSgst, compensation_cess: manualCess };
  const ratio = newBase / oldBase;
  return { cgst: r2(manualCgst * ratio), sgst: r2(manualSgst * ratio), compensation_cess: r2(manualCess * ratio) };
}

/**
 * AMEND LINE ITEMS ON A RECORDED GRN — quantities, rate, or remove the line —
 * unwinding the old stock and cost effect and applying the new one, in ONE
 * transaction, with a before/after audit row that cannot be skipped.
 *
 * ── THE STATE BRANCH, WHICH IS THE WHOLE THING ─────────────────────────────
 * A GRN at 'awaiting_qc' HAS NO STOCK EFFECT YET. The Kitchen QC gate (6a9be28)
 * defers all four writes to sign-off: zero `purchases` rows, zero
 * inventory_transactions rows, quantity_accepted 0 on every line and
 * qc_applied_at NULL on header and lines. Editing it therefore needs NO UNWIND
 * AT ALL — the lines are simply rewritten and decideGrnQc will apply the
 * corrected figures when the kitchen signs. Getting this backwards double-applies
 * or double-reverses stock, so the state is not merely read before the
 * transaction: it is PINNED IN THE CLAIM's WHERE clause, and a sign-off that
 * landed in the millisecond between the read and the lock makes the claim match
 * nothing and the whole amendment roll back with a 409.
 *
 * A GRN at 'void' is not line-editable at all — refused by the caller before we
 * get here, and again by this claim.
 *
 * ── IDEMPOTENCY ────────────────────────────────────────────────────────────
 * Every line carries `expect`: the three values the caller saw. The per-line
 * claim re-asserts them under the write lock, so a double submit, a retry or a
 * replayed request finds the row already at the NEW values, matches nothing and
 * is refused with `line_changed` — nothing is applied twice. It is the same
 * mechanism as a version column, keyed on the three numbers that ARE the
 * movement, and it doubles as the two-admin concurrency guard.
 *
 * ── WHAT IS DELIBERATELY NOT TOUCHED ───────────────────────────────────────
 * · `gi.notes` and `gi.cost_note` — src/lib/purchase-log.ts parses that exact
 *   sentence with an anchored regex to decide `is_mirror`. Re-wording it breaks
 *   the join between a cost row and its bill line. The reason for the amendment
 *   lives in the audit event, which is where a reason belongs.
 * · `gi.discount` and the four recorded-only charges (special_excise_cess, tcs,
 *   delivery_charges, mrp_round_off) — they are what the vendor's bill says, not
 *   a function of quantity, and a correction to a quantity does not re-cut them.
 * · `grn.date` — the valuation date of every cost row and the month
 *   updateMaterialPrice averages over. Unchanged here as it is on PUT.
 * · Valuations already TAKEN at the old average (closing stock, department
 *   variance, party consumption, production batches) are historical snapshots.
 *   A correction does not rewrite history it did not author.
 */
export function amendGrnLines(
  db: Database.Database,
  input: {
    grnId: string;
    actorEmail: string;
    reason: string;
    lines: AmendLineInput[];
    /** The header status the caller read. Pinned in the claim. */
    expectStatus: string;
    expectEditCount: number | null;
  },
): AmendGrnLinesResult {
  const { grnId, actorEmail, reason, lines, expectStatus, expectEditCount } = input;

  const grn = db.prepare(`SELECT * FROM goods_receipt_notes WHERE id = ?`).get(grnId) as any;
  if (!grn) throw refuse(404, 'not_found', 'Not found');
  const grnNumber = String(grn.grn_number || grnId);
  const isPoGrn = !!grn.po_id;
  const held = String(grn.status) === 'awaiting_qc';

  const result: AmendGrnLinesResult = {
    grn_id: grnId, grn_number: grnNumber,
    state: held ? 'held' : 'inwarded',
    status_before: String(grn.status || ''), status_after: String(grn.status || ''),
    edit_count: 0, edited_at: null, edited_by: actorEmail,
    changes: [], materials_touched: [],
    purchases_deleted: 0, purchases_created: 0, purchases_updated: 0,
    transactions_deleted: 0, transactions_created: 0, transactions_updated: 0,
    last_purchase_updated: [], last_purchase_kept: [], last_purchase_stale: [],
    po_total_restamped: false, po_total_cost: null,
    warnings: [],
    po_deviation: [], po_number: null, po_id: isPoGrn ? String(grn.po_id) : null,
  };

  const touched = new Set<string>();
  const auditBefore: any = { grn: {}, lines: [], purchases: [], inventory_transactions: [], materials: [] };
  const auditAfter: any = { lines: [], stock: [] };

  const txn = db.transaction(() => {
    // ── 1. CLAIM FIRST — the write lock, the void interlock and the STATE PIN,
    //       in one statement. The precondition is repeated in the WHERE rather
    //       than trusted from the read above: a void, or a QC sign-off that moved
    //       this receipt from held to inwarded, that landed in between must make
    //       this match nothing rather than be amended over on the wrong branch.
    //       `? = 0 OR qc_applied_at IS NULL` is the second half of that pin —
    //       a held receipt whose apply is halfway through is not editable.
    const claim = db.prepare(`
      UPDATE goods_receipt_notes
         SET edited_at = datetime('now'), edited_by = ?, edit_count = COALESCE(edit_count, 0) + 1
       WHERE id = ?
         AND status <> 'void'
         AND status = ?
         AND (? = 0 OR qc_applied_at IS NULL)
         AND (? < 0 OR COALESCE(edit_count, 0) = ?)
    `).run(actorEmail, grnId, expectStatus, held ? 1 : 0,
           expectEditCount == null ? -1 : expectEditCount,
           expectEditCount == null ? -1 : expectEditCount);
    if (claim.changes === 0) {
      const cur = db.prepare(`SELECT status, edit_count FROM goods_receipt_notes WHERE id = ?`).get(grnId) as any;
      throw refuse(409, 'grn_changed',
        `${grnNumber} changed while this bill was open: it is now "${cur?.status ?? 'gone'}"`
        + (String(cur?.status ?? '') !== String(expectStatus) ? `, not "${expectStatus}" as this form was showing` : '')
        + (expectEditCount != null && Number(cur?.edit_count || 0) !== expectEditCount
            ? `, and it has been amended ${Number(cur?.edit_count || 0)} time(s) — you were looking at ${expectEditCount}` : '')
        + `. Nothing was changed. Reload the bill and try again — a held receipt that has since been signed off, or a receipt that has been voided, is corrected on a different footing.`,
        { current_status: String(cur?.status ?? ''), current_edit_count: Number(cur?.edit_count || 0) });
    }

    // The order behind this receipt, read once — its number composes the cost-row
    // note a re-booked line needs, and its status decides whether total_cost may
    // be restamped at all.
    const poRow = isPoGrn
      ? db.prepare(`SELECT id, po_number, status FROM purchase_orders WHERE id = ?`).get(grn.po_id) as any
      : null;
    result.po_number = poRow?.po_number ? String(poRow.po_number) : null;
    const invoiceTag = String(grn.invoice_number || '').trim();
    const composedCostNote = poRow?.po_number
      ? `Received against ${poRow.po_number} (GRN ${grnNumber})`
      : `Ad-hoc GRN ${grnNumber}${invoiceTag ? ' · invoice ' + invoiceTag : ''}`;

    auditBefore.grn = {
      grn_number: grnNumber, date: grn.date, status: grn.status, po_id: grn.po_id ?? null,
      vendor: grn.vendor, invoice_number: grn.invoice_number, outlet_id: grn.outlet_id ?? null,
      edit_count: Number(grn.edit_count) || 0,
    };

    // ── 2. THE CUTOVER BAR — inwarded receipts only.
    //       A committed central-store cutover SET current_stock outright to a
    //       physical count that already absorbs this receipt, with no ledger row
    //       at all, and variance-report floors purchases_to_date at that date. So
    //       correcting a quantity now would move the book away from the counted
    //       baseline with no offsetting term anywhere. A HELD receipt is exempt
    //       because it has never moved stock and cannot have been absorbed by a
    //       count of the book — its figures will be applied for the first time at
    //       sign-off, on today's book.
    if (!held) {
      const cutover = getCentralStoreCutoverDate(db);
      if (cutover && String(grn.date) <= String(cutover)) {
        throw refuse(409, 'cutover_absorbed',
          `${grnNumber} is dated ${grn.date}, on or before the central-store cutover (${cutover}). The cutover re-based on-hand stock to a physical count that already includes this receipt, so correcting its quantities now would move the same goods twice. Correct it with a stock adjustment instead.`);
      }
    }

    // ── 3. PER-LINE WORK ────────────────────────────────────────────────────
    const getLine = db.prepare(`SELECT ${LINE_COLS} FROM goods_receipt_note_items gi WHERE gi.id = ? AND gi.grn_id = ?`);
    // ONE statement for all three inwarded write paths. Three separate copies of
    // the same UPDATE is how quantity_rejected came to be rewritten in all of
    // them while rejection_reason was rewritten in none.
    const writeLine = db.prepare(`
      UPDATE goods_receipt_note_items
         SET quantity_received = ?, quantity_accepted = ?, quantity_rejected = ?,
             rejection_reason = ?, notes = ?,
             unit_price = ?, cgst = ?, sgst = ?, compensation_cess = ?
       WHERE id = ? AND grn_id = ?
    `);
    const totalLines = Number((db.prepare(
      `SELECT COUNT(*) AS n FROM goods_receipt_note_items WHERE grn_id = ?`).get(grnId) as any)?.n) || 0;
    const removing = lines.filter(l => l.remove).length;
    // THE PO BAR IS ANSWERED FIRST, and the order matters. On a single-line PO
    // receipt both bars are true, and "that would leave the bill empty" sends the
    // admin looking for a second line to keep — when the real answer is that a PO
    // line can never be removed at all and the alternative is to set its accepted
    // quantity to 0. The more specific refusal is the more useful one.
    if (removing > 0 && isPoGrn) {
      const first = lines.find(l => l.remove)!;
      const nm = (db.prepare(`
        SELECT COALESCE(rm.name, gi.material_id) AS n FROM goods_receipt_note_items gi
        LEFT JOIN raw_materials rm ON rm.id = gi.material_id WHERE gi.id = ? AND gi.grn_id = ?`)
        .get(first.id, grnId) as any)?.n;
      throw poLineRemovalRefusal(grnNumber, String(nm || 'That line'));
    }
    if (removing > 0 && removing >= totalLines) {
      throw refuse(400, 'last_line',
        `Removing ${removing === 1 ? 'that line' : 'those lines'} would leave ${grnNumber} with no lines at all. A bill with nothing on it is not an amendment — void the whole receipt instead.`);
    }

    // Already-returned figures for every line in scope, read once. NO try/catch
    // in the helper by design: swallowing a missing material_return_items would
    // report "nothing returned yet" for every line, which is the one wrong answer
    // that lets the same goods be moved twice.
    let returned: Map<string, { returned_recipe_qty: number; returned_purchase_qty: number; lines: number }>;
    try {
      returned = alreadyReturnedByGrnItem(db, lines.map(l => l.id));
    } catch (e: any) {
      throw refuse(409, 'returns_unreadable',
        `Cannot confirm whether anything on ${grnNumber} has already been returned (${e?.message || 'returns ledger unreadable'}). Refusing rather than risk moving the same stock twice.`);
    }

    for (const req of lines) {
      const line = getLine.get(req.id, grnId) as any;
      if (!line) {
        throw refuse(404, 'line_not_found',
          `Line ${req.id} is not on ${grnNumber} — it may already have been removed by this or another amendment. Nothing was changed; reload the bill.`);
      }
      const materialId = String(line.material_id);
      const material = db.prepare(
        `SELECT id, name, current_stock, pack_size, unit, purchase_unit FROM raw_materials WHERE id = ?`
      ).get(materialId) as any;
      if (!material) {
        throw refuse(409, 'material_missing',
          `The material behind one line of ${grnNumber} no longer exists in the master, so its stock cannot be corrected.`);
      }
      const materialName = String(material.name || materialId);

      const oldReceived = Number(line.quantity_received) || 0;
      const oldAccepted = Number(line.quantity_accepted) || 0;
      const oldPrice = Number(line.unit_price) || 0;

      // ── 3a. THE OPTIMISTIC LOCK. Re-asserted here, under the write lock, on
      //        the three numbers that ARE the movement. A replay finds the new
      //        values and is refused. Compared with a tolerance, not with `=`:
      //        these are SQLite REALs round-tripped through JSON.
      const near = (a: number, b: number) => Math.abs(Number(a) - Number(b)) <= QTY_EPS;
      const exp = req.expect;
      if (!exp || !near(exp.quantity_received, oldReceived) || !near(exp.quantity_accepted, oldAccepted) || !near(exp.unit_price, oldPrice)) {
        throw refuse(409, 'line_changed',
          `${materialName} on ${grnNumber} is no longer what this form was showing — it now reads received ${r6(oldReceived)}, accepted ${r6(oldAccepted)}, rate ₹${r6(oldPrice)}`
          + (exp ? `, and you were looking at received ${r6(exp.quantity_received)}, accepted ${r6(exp.quantity_accepted)}, rate ₹${r6(exp.unit_price)}` : '')
          + `. Either this correction has already been applied, or someone else changed it. Nothing was changed — reload the bill and check before re-sending.`,
          { grn_item_id: req.id, current: { quantity_received: r6(oldReceived), quantity_accepted: r6(oldAccepted), unit_price: r6(oldPrice) } });
      }

      // ── 3b. THE RETURNS BAR. material_return_items.grn_item_id has NO foreign
      //        key (db.ts:6101 — index only), so deleting a line row silently
      //        orphans a live return ticket's anchor; and a settled ticket has
      //        ALREADY debited part of this delivery, so reducing the quantity it
      //        was raised against would take the same grams out twice. A settled
      //        return can never be cancelled either (api/returns/[id] refuses:
      //        "a settled stock movement is never undone in place"), so that line
      //        is permanently un-reducible and the message says so rather than
      //        sending an admin round a loop the system itself forbids.
      //        A RATE-ONLY correction is allowed through: it moves no quantity, so
      //        it cannot double-debit anything, and the ticket's anchor survives.
      const ret = returned.get(req.id);
      const openTickets = Number((db.prepare(`
        SELECT COUNT(*) AS n FROM material_returns r
        WHERE r.status NOT IN ('cancelled', 'hod_rejected', 'verified')
          AND (r.id IN (SELECT ri.return_id FROM material_return_items ri WHERE ri.grn_item_id = ?))
      `).get(req.id) as any)?.n) || 0;

      const wantsRemove = !!req.remove;
      const nextReceived = wantsRemove ? 0 : (req.quantity_received != null ? Number(req.quantity_received) : oldReceived);
      let nextAccepted = wantsRemove ? 0 : (req.quantity_accepted != null ? Number(req.quantity_accepted) : oldAccepted);
      const nextPrice = wantsRemove ? oldPrice : (req.unit_price != null ? Number(req.unit_price) : oldPrice);
      // Two different questions, and conflating them was how the pack-drift
      // defect got in. `qtyMoves` is "did ANY quantity on the bill line change"
      // — what the returns bars care about, because a ticket is anchored to the
      // line's figures. `acceptedMoves` is "did the STOCK MOVEMENT change" —
      // only quantity_accepted feeds current_stock and inventory_transactions,
      // so only that recomputes the recipe-unit figure, and only that can be
      // exposed to a pack rebase.
      const qtyMoves = wantsRemove || !near(nextAccepted, oldAccepted) || !near(nextReceived, oldReceived);
      const acceptedMoves = wantsRemove || !near(nextAccepted, oldAccepted);

      if (qtyMoves && (ret?.lines || 0) > 0) {
        throw refuse(409, 'returned_settled',
          `${ret!.lines} settled return ticket(s) have already sent ${r6(ret!.returned_purchase_qty)} of ${materialName} back to the vendor against this line, and that stock is already out of the book. Changing the quantity now — or removing the line — would move the same goods a second time, and a settled return cannot be cancelled to clear the way. Correct the remainder with a stock adjustment instead. (The rate on this line can still be corrected.)`,
          { grn_item_id: req.id, returned_purchase_qty: r6(ret!.returned_purchase_qty), returned_recipe_qty: r6(ret!.returned_recipe_qty) });
      }
      if (qtyMoves && openTickets > 0) {
        throw refuse(409, 'returned_open',
          `${openTickets} open return ticket(s) are anchored to ${materialName} on ${grnNumber}. They were raised against the quantity recorded today, so changing it — or removing the line — would leave them settling against a figure that no longer exists. Cancel those tickets first, then correct the line. (The rate can still be corrected.)`,
          { grn_item_id: req.id, open_return_tickets: openTickets });
      }
      // ── THE ANCHOR BAR, WHICH THE TWO ABOVE BOTH MISS ON ONE SHAPE. ───────
      // alreadyReturnedByGrnItem counts only verified tickets whose lines the
      // store ACCEPTED back (store_rejected = 0), and the open-ticket query
      // above excludes 'verified' outright. A verified ticket every line of
      // which the store rejected therefore appears in NEITHER — it moved no
      // stock, so neither bar has anything to say about it — yet it still
      // ANCHORS to this grn_item_id, and material_return_items.grn_item_id has
      // no foreign key (db.ts:6101 is an index, not a constraint). Deleting the
      // line row leaves that ticket pointing at nothing, with no error and no
      // trace. DELETE /api/grn/[id] already refuses the same ticket at the
      // header level; a per-line removal must refuse it too. Value corrections
      // are untouched — they move no row the ticket points at.
      if (wantsRemove) {
        const anchored = Number((db.prepare(
          `SELECT COUNT(*) AS n FROM material_return_items WHERE grn_item_id = ?`
        ).get(req.id) as any)?.n) || 0;
        if (anchored > 0) {
          throw refuse(409, 'return_anchor',
            `${materialName} on ${grnNumber} cannot be removed: ${anchored} vendor-return line(s) are anchored to it, and that anchor has no foreign key to protect it — deleting this row would leave those return records pointing at a line that no longer exists, with nothing on screen saying so. Set the accepted quantity to 0 instead, which reverses the stock and the cost row while the line (and its returns) stay findable.`,
            { grn_item_id: req.id, anchored_return_lines: anchored });
        }
      }

      // ── 3c. THE HELD BRANCH — rewrite the bill line, move nothing. ─────────
      if (held) {
        // THE HELD BRANCH IS TRUSTED ON `status` ALONE, AND THAT IS NOT ENOUGH.
        // "awaiting_qc" is a claim about the LEDGER — that this receipt made none
        // of its four writes — and the inwarded branch below refuses outright
        // (cost_row_unexpected / cost_row_unidentifiable / movement_unidentifiable)
        // whenever the bill and the ledger disagree, on the reasoning that a
        // correction will not pick a side. The held branch had no such test: a
        // held receipt that somehow carried cost rows would have had its lines
        // rewritten with the stock left standing at the old figures and no
        // refusal at all. I could not reach that state through the app — the
        // sign-off stamps status and qc_applied_at in one UPDATE and this
        // route's claim pins qc_applied_at IS NULL — so this is the assertion
        // that keeps it unreachable rather than a fix for a live defect.
        const heldCostRows = Number((db.prepare(
          `SELECT COUNT(*) AS n FROM purchases WHERE grn_id = ? AND material_id = ?`
        ).get(grnId, materialId) as any)?.n) || 0;
        if (heldCostRows > 0) {
          throw refuse(409, 'cost_row_unexpected',
            `${grnNumber} is recorded as still waiting for a quality check, which means it should have moved no stock at all — but ${heldCostRows} cost row(s) already exist for ${materialName} against it. The bill and the ledger disagree; a correction will not pick a side. Investigate before amending.`,
            { grn_item_id: req.id, cost_rows: heldCostRows });
        }
        if (!wantsRemove && req.quantity_accepted != null && Math.abs(Number(req.quantity_accepted)) > QTY_EPS) {
          throw refuse(400, 'held_accepted',
            `${materialName} on ${grnNumber} is still waiting for a ${String(grn.qc_checker || 'kitchen')} check, so the accepted quantity is not the receiving desk's to set — it stays 0 until the checking department signs. Correct what ARRIVED (received quantity) and the rate; the accepted figure is recorded at sign-off.`);
        }
        nextAccepted = 0;
        if (wantsRemove) {
          if (isPoGrn) throw poLineRemovalRefusal(grnNumber, materialName);
          const del = db.prepare(`DELETE FROM goods_receipt_note_items WHERE id = ? AND grn_id = ?`).run(req.id, grnId);
          if (del.changes !== 1) {
            throw refuse(409, 'line_changed',
              `${materialName} on ${grnNumber} could not be removed — the row changed while this bill was open. Nothing was changed.`);
          }
          auditBefore.lines.push(line);
          result.changes.push({
            grn_item_id: req.id, material_id: materialId, material_name: materialName, action: 'removed',
            before: beforeShape(line), after: null, cost_row: 'none',
            stock_delta_recipe: 0, on_hand_before: Number(material.current_stock), on_hand_after: Number(material.current_stock),
          });
          continue;
        }
        if (nextReceived < 0) {
          throw refuse(400, 'held_negative',
            `${materialName}: a held delivery records what ARRIVED, so its received quantity cannot be negative. A back-correction is a receipt of its own, recorded as a separate GRN.`);
        }
        if (nextPrice < 0) throw negativeRateRefusal(materialName);
        // A ₹0 rate on a HELD line is not harmless just because nothing has moved
        // yet: decideGrnQc replays this stored row at sign-off, so the zero rate
        // becomes a ₹0 cost row and a wiped average_price then. Refused at the
        // point it is typed, for the same reason and in the same words as below.
        if (nextReceived > QTY_EPS && nextPrice <= 0) throw zeroRateRefusal(materialName, true);
        // Tax on a held line is recorded against the RECEIVED quantity (the store
        // may not pre-reject a gated line, so accepted == received at inward and
        // that is the figure both receiving routes taxed). decideGrnQc re-derives
        // it against the kitchen's accepted figure at sign-off.
        const tax = deriveLineTax(line, nextReceived, nextPrice, oldReceived, oldReceived);
        const upd = db.prepare(`
          UPDATE goods_receipt_note_items
             SET quantity_received = ?, quantity_accepted = 0, quantity_rejected = 0,
                 rejection_reason = '', notes = ?,
                 unit_price = ?, cgst = ?, sgst = ?, compensation_cess = ?
           WHERE id = ? AND grn_id = ? AND qc_applied_at IS NULL
        `).run(nextReceived, nextLineNote(line, 0, ''), nextPrice, tax.cgst, tax.sgst, tax.compensation_cess, req.id, grnId);
        // Every other conditional write in this file proves it landed and throws
        // if it did not; this one discarded its result and then reported the line
        // as `updated` with a full before/after. A write that silently did
        // nothing, described as a success, is the shape this whole route exists
        // to make impossible.
        if (upd.changes !== 1) {
          throw refuse(409, 'line_changed',
            `${materialName} on ${grnNumber} could not be corrected — the row changed while this bill was open (it may have been signed off in the meantime). Nothing was changed; reload the bill.`,
            { grn_item_id: req.id });
        }
        auditBefore.lines.push(line);
        const afterLine = { ...line, quantity_received: nextReceived, quantity_accepted: 0, quantity_rejected: 0, unit_price: nextPrice, ...tax };
        auditAfter.lines.push(afterShape(afterLine, materialId, materialName));
        result.changes.push({
          grn_item_id: req.id, material_id: materialId, material_name: materialName, action: 'updated',
          before: beforeShape(line), after: beforeShape(afterLine), cost_row: 'none',
          stock_delta_recipe: 0, on_hand_before: Number(material.current_stock), on_hand_after: Number(material.current_stock),
        });
        continue;
      }

      // ── 3d. THE INWARDED BRANCH — the full unwind and reapply. ─────────────
      if (wantsRemove && isPoGrn) throw poLineRemovalRefusal(grnNumber, materialName);
      if (nextPrice < 0) throw negativeRateRefusal(materialName);

      // ── THE STORE RAIL. A CORRECTION MAY NOT MOVE CENTRAL STOCK FOR A
      //    MATERIAL THAT NOW BELONGS TO A STORE LOCATION. ────────────────────
      // A category can be claimed by the Liquor Store AFTER a delivery was
      // received into Central, and grn-qc.ts says why that matters in the same
      // breath as its own copy of this check: "a material can be store-mapped
      // between the delivery and the sign-off, and crediting central stock for a
      // TGBCL line is exactly what that guard exists to stop." Every other rail
      // enforces it — POST /api/grn 400s, receive/route.ts filters the line out,
      // decideGrnQc 409s at sign-off, /api/purchases refuses outright — and this
      // route was the only writer of raw_materials.current_stock on a purchase
      // that did not, so a line amendment was the one door through which a
      // bottle could end up on the store ledger AND in the central pool at once.
      // REFUSED WHOLESALE, rate-only included: a rate correction re-derives
      // Central average_price for a material that must not have one, which is
      // the same wrong number one step further down.
      const storeMsg = centralFlowBlock(db, materialId);
      if (storeMsg) {
        throw refuse(409, 'store_mapped',
          `${storeMsg} ${grnNumber} recorded ${materialName} into Central Store, and correcting that line here would move central stock (and its weighted average) for goods the store ledger is also tracking — the same bottle on two rails. Correct it on the store's own rail, or un-map the category first if this material really is a Central Store item.`,
          { grn_item_id: req.id, material_id: materialId, material_name: materialName });
      }

      // ── ACCEPTED vs RECEIVED, IN BOTH DIRECTIONS. ────────────────────────
      // The bar used to switch itself OFF whenever the received quantity was
      // negative (`&& nextReceived >= 0`), and there was no lower bound anywhere,
      // so `received −10, accepted 100` was a 200: ninety units of stock
      // conjured, a ₹10,000 cost row and an input credit claimed on goods the
      // same line said had never arrived. A back-correction is a real shape on
      // this rail — POST /api/grn records one as a negative receipt — but there
      // both numbers move IN LOCKSTEP. That is the invariant, stated once and
      // enforced in both directions: accepted may never exceed what arrived,
      // and on a negative (back-correction) line it may never be positive nor
      // reach further than the negative received figure.
      if (!wantsRemove) {
        const overAccepted = nextReceived >= 0
          ? (nextAccepted > nextReceived + QTY_EPS || nextAccepted < -QTY_EPS)
          : (nextAccepted > QTY_EPS || nextAccepted < nextReceived - QTY_EPS);
        if (overAccepted) {
          throw refuse(400, 'accepted_over_received',
            nextReceived >= 0
              ? `${materialName}: accepted (${r6(nextAccepted)}) must be between 0 and received (${r6(nextReceived)}) — a quantity that never arrived cannot be accepted, and a positive delivery cannot accept a negative quantity.`
              : `${materialName}: this line records a back-correction of ${r6(nextReceived)}, so its accepted quantity must be between ${r6(nextReceived)} and 0 — you sent ${r6(nextAccepted)}. On a back-correction the received and accepted figures move in lockstep; they cannot point in opposite directions.`,
            { grn_item_id: req.id, quantity_received: r6(nextReceived), quantity_accepted: r6(nextAccepted) });
        }
      }
      // A ₹0 RATE IS REFUSED WHEREVER GOODS ARE ACCEPTED. Both receiving routes
      // already bar it (receive/route.ts: `effAcc > 0 && effPrice <= 0`; the
      // approve-time twin in po-helpers.ts) and for the reason this file states
      // one guard up about negatives: updateMaterialPrice averages
      // SUM(qty × unit_price) / SUM(qty) into average_price, so a zero rate wipes
      // the weighted average to 0 and cascades a free ingredient through every
      // recipe and sub-recipe — and last_purchase_price then seeds the next PO at
      // ₹0. A rate that is genuinely zero is not a correction, it is a free
      // sample, and it is recorded as one.
      if (nextAccepted > QTY_EPS && nextPrice <= 0) throw zeroRateRefusal(materialName, false);

      // ── A COUNT THAT HAS ALREADY ABSORBED THIS RECEIPT. ───────────────────
      // The cutover bar two blocks up refuses for a reason that is not unique to
      // the cutover: "the cutover re-based on-hand stock to a physical count that
      // already includes this receipt, so correcting its quantities now would
      // move the same goods twice." An APPROVED central variance does exactly the
      // same thing — variance-approval.ts posts (physical − count-time system)
      // straight onto raw_materials.current_stock, which re-bases the book to the
      // counted shelf — and central_store_cutover_at is stamped WRITE-ONCE, so
      // the cutover bar never advances past the first one and every count after
      // it was unprotected. The interlock already exists in the other direction
      // (qcHoldBlockForCount refuses APPROVING a count while a delivery is held);
      // this is the same interlock facing the other way.
      // QUANTITY ONLY. A rate correction moves no stock, so a count cannot have
      // absorbed it — and saying so is what keeps this bar from freezing every
      // bill older than the last stocktake.
      if (acceptedMoves) {
        const absorbed = latestAbsorbingCount(db, materialId, String(grn.date ?? ''));
        if (absorbed) {
          throw refuse(409, 'count_absorbed',
            `${materialName} was physically counted on ${absorbed.date} and that count was approved${absorbed.reviewed_by ? ` by ${absorbed.reviewed_by}` : ''}, which re-based its on-hand stock to what was on the shelf — a figure that already includes whatever ${grnNumber} (dated ${grn.date}) really delivered. Correcting this receipt's quantity now would move the book away from the counted balance with nothing to offset it, so the shortfall would show up on the next variance report as shrinkage that never happened. Correct the bill's RATE here if that is what is wrong; for the quantity, record a fresh physical count instead. (Approved count: ${absorbed.physical_stock} ${absorbed.unit || ''}.)`,
            {
              grn_item_id: req.id, material_id: materialId, material_name: materialName,
              count_date: absorbed.date, counted_physical: absorbed.physical_stock,
              count_unit: absorbed.unit || '', reviewed_by: absorbed.reviewed_by || '',
              remedy: 'physical_count',
            });
        }
      }

      // The line's cost row. `purchases` has NO grn_item_id, so (grn_id,
      // material_id) is the only per-line key — exact only because ONE MATERIAL
      // = ONE LINE is enforced on every writer. The match is PROVEN to be
      // exactly one row before anything is written, the same way the void proves
      // acceptedLines === linkedPurchases before it reverses.
      const costRows = db.prepare(`SELECT * FROM purchases WHERE grn_id = ? AND material_id = ?`).all(grnId, materialId) as any[];
      const hadStock = Math.abs(oldAccepted) > QTY_EPS;
      if (hadStock && costRows.length !== 1) {
        throw refuse(409, 'cost_row_unidentifiable',
          costRows.length === 0
            ? `${materialName} on ${grnNumber} has an accepted quantity of ${r6(oldAccepted)} but no cost row carries this receipt's id, so the row it wrote cannot be identified. This receipt predates purchases.grn_id; a correction will not guess from the note text. Correct the stock with an adjustment instead.`
            : `${materialName} on ${grnNumber} has ${costRows.length} cost rows against one line. Something else has already changed this receipt's cost rows; correcting a set that does not match the bill would corrupt the weighted average. Investigate before amending.`,
          { grn_item_id: req.id, cost_rows: costRows.length });
      }
      if (!hadStock && costRows.length > 0) {
        throw refuse(409, 'cost_row_unexpected',
          `${materialName} on ${grnNumber} has an accepted quantity of 0 but ${costRows.length} cost row(s) behind it. The bill and the ledger disagree; a correction will not pick a side. Investigate before amending.`,
          { grn_item_id: req.id, cost_rows: costRows.length });
      }
      const costRow = costRows[0] || null;

      let txRow: any = null;
      if (costRow) {
        const txRows = db.prepare(
          `SELECT * FROM inventory_transactions WHERE type = 'purchase' AND reference_id = ?`
        ).all(costRow.id) as any[];
        if (txRows.length !== 1) {
          throw refuse(409, 'movement_unidentifiable',
            txRows.length === 0
              ? `The cost row for ${materialName} on ${grnNumber} has no stock movement behind it, so the quantity that actually entered stock is unknown. A correction that guessed the quantity would be a fabricated adjustment.`
              : `The cost row for ${materialName} on ${grnNumber} has ${txRows.length} stock movements behind it. Correcting one of them would leave the others stating a movement that no longer happened.`,
            { grn_item_id: req.id, movements: txRows.length });
        }
        txRow = txRows[0];
      }

      // ── THE TWO BASES MUST AGREE, OR THE CORRECTION IS REFUSED. ───────────
      // The unwind uses the RECORDED movement (pack_size is mutable, so a
      // recompute can subtract a different number than was added). A re-credit
      // has to use TODAY's pack factor, because that is what the receiving route
      // would write today. When the two disagree the material's pack size has
      // been rebased since this receipt, and there is no honest arithmetic that
      // nets them: reversing at the old factor and crediting at the new one would
      // move stock by the difference.
      //
      // A RATE-ONLY CORRECTION IS EXEMPT ONLY BECAUSE IT DOES NOT RECOMPUTE THE
      // MOVEMENT AT ALL. `newIn` is pinned to the RECORDED figure whenever the
      // quantity has not moved — never recomputed as accepted × today's factor.
      // That is not a shortcut, it is the same rule the unwind follows, and
      // dropping it was a live defect: on a material rebased from kg to g×1000
      // after receipt, a pure rate correction recomputed 10 × 1000 = 10,000
      // against a recorded 10 and silently credited 9,990 g of stock that never
      // arrived. A correction that moves no quantity must move no quantity.
      const factor = packFactor({ pack_size: material.pack_size, unit: material.unit, purchase_unit: material.purchase_unit } as any);
      const recordedIn = txRow ? Number(txRow.quantity) || 0 : 0;
      if (acceptedMoves && costRow) {
        const impliedNow = r6(oldAccepted * factor);
        if (Math.abs(r6(recordedIn) - impliedNow) > QTY_EPS) {
          throw refuse(409, 'pack_factor_drift',
            `${materialName}'s pack size has been changed since ${grnNumber} was received: this receipt moved ${r6(recordedIn)} ${material.unit} into stock, but ${r6(oldAccepted)} ${material.purchase_unit || material.unit} at today's pack size would be ${impliedNow} ${material.unit}. Reversing at the old factor and re-crediting at the new one would move stock by the difference. Correct this line with a stock adjustment, or restore the pack size first. (The rate on this line can still be corrected.)`,
            { grn_item_id: req.id, recorded_recipe_qty: r6(recordedIn), implied_recipe_qty: impliedNow });
        }
      }
      const newIn = wantsRemove ? 0 : (acceptedMoves ? r6(nextAccepted * factor) : recordedIn);

      // ── THE NEGATIVE-STOCK GUARD, on the NET delta, before any write. ─────
      if (costRow || Math.abs(newIn) > QTY_EPS) {
        const moves: RecordedMove[] = [{
          material_id: materialId, material_name: materialName,
          qty: recordedIn, current_stock: Number(material.current_stock),
        }];
        assertNoNegativeStock(moves, new Map([[materialId, newIn]]), {
          code: 'would_go_negative',
          verb: 'corrected',
          // Only when stock is actually LEAVING. See the parameter note on
          // assertNoNegativeStock: without this the guard refused rate-only
          // corrections and upward quantity corrections on any material already
          // carrying a negative balance — refusing, with an "already been issued"
          // sentence, the very correction that would have reduced the negative.
          onlyWhenDebiting: true,
          build: (blocked) => {
            const b = blocked[0];
            // ── SPOKEN IN PURCHASE UNITS, WHICH IS WHAT THE ADMIN TYPED. ─────
            // Every figure this guard holds is in RECIPE units, because that is
            // the basis current_stock and inventory_transactions are on. The
            // owner rule is that quantities LEAD with the purchase unit, and the
            // modal's own fields are purchase units — so an admin correcting
            // Olive Oil from 4 litres to 1 was being told "4000 ml in, the
            // correction leaves 1000 ml, 3000 ml has to come back out", where
            // not one number matched anything on his screen and "leaves 1000"
            // read as if he had typed 1000. Both bases are given, purchase
            // first; where they are the same (factor 1) the parenthetical is
            // dropped rather than printing the same number twice.
            const pu = String(material.purchase_unit || material.unit || '');
            const ru = String(material.unit || '');
            const inPu = (recipeQty: number) => r6(factor > 0 ? recipeQty / factor : recipeQty);
            const both = (recipeQty: number) => factor === 1
              ? `${r6(recipeQty)} ${ru}`
              : `${inPu(recipeQty)} ${pu} (${r6(recipeQty)} ${ru})`;
            return {
              message:
                `Correcting ${materialName} on ${grnNumber} would drive its central stock below zero. `
                + `This receipt put ${both(b.recorded_in)} in; the correction leaves ${both(b.new_in)}, so ${both(b.delta)} has to come back out — `
                + `but the central pool holds only ${both(b.on_hand)}, ${both(b.short_by)} short. `
                // WHAT IS AND IS NOT PROVABLE. The old sentence said the shortfall
                // "has already been issued to a department or otherwise gone out
                // since the delivery" — and the book cannot know either half. The
                // pool can be short because it was short BEFORE this receipt
                // (~14,149 historical issues were never put on the ledger), and
                // nothing anywhere attributes a gram on hand to the receipt that
                // brought it in. Stating a cause the schema cannot support sent
                // admins hunting requisitions that do not exist.
                + `Where the difference went is not something the book can answer — there is no lot tracking, and the pool may have been short before this delivery ever arrived. `
                + `Correct the balance with a physical count instead (Inventory → Closing Stock, then approve it on Variance Approvals): a count can move a balance that a receipt can no longer honestly move. Nothing was changed.`,
              payload: {
                materials: blocked.map(x => x.text),
                materials_detail: blocked.map(x => ({
                  ...x,
                  on_hand_purchase: inPu(x.on_hand),
                  recorded_in_purchase: inPu(x.recorded_in),
                  new_in_purchase: inPu(x.new_in),
                  delta_purchase: inPu(x.delta),
                  short_by_purchase: inPu(x.short_by),
                })),
                // The rail that really exists for the CENTRAL pool. There is no
                // stock-adjustment page: /api/stores/[id]/adjust writes
                // store_stock_ledger (liquor and floor bars), never
                // raw_materials.current_stock. The only writer of the central
                // column from a count is approveVariance, reached through
                // /closing-stock → /variance-approvals.
                remedy: 'physical_count',
                remedy_path: '/closing-stock',
                unit: ru,
                purchase_unit: pu,
                pack_factor: factor,
              },
            };
          },
        });
      }

      const onHandBefore = Number(material.current_stock);

      // Basis of the cost row being replaced, proven from the row itself rather
      // than assumed from the origin. The PO path writes purchases.unit_price NET
      // of the allocated bill discount while the GRN line keeps the GROSS rate;
      // the ad-hoc path writes the gross rate on both. Re-deriving the new rate on
      // the WRONG basis would silently re-base the cost row — so the old row is
      // asked which basis it is on, and only where it cannot answer (no row yet)
      // does the origin decide, exactly as its writer would.
      const discShare = Number(line.discount) || 0;
      const rowIsNet = (() => {
        if (!costRow || discShare <= 0 || Math.abs(oldAccepted) <= QTY_EPS) return isPoGrn && discShare > 0;
        const oldGrossTotal = r2(oldAccepted * oldPrice);
        const oldNet = r2((oldGrossTotal - discShare) / oldAccepted);
        return oldNet > 0 && r6(Number(costRow.unit_price)) === r6(oldNet);
      })();

      const grossTotal = r2(nextAccepted * nextPrice);
      const canNet = rowIsNet && discShare > 0 && nextAccepted > QTY_EPS;
      const netCandidate = canNet ? r2((grossTotal - discShare) / nextAccepted) : nextPrice;
      // A zero or negative unit_price cascades a "free" ingredient through
      // average_price into every recipe — the one outcome worse than over-stating
      // the cost by a few rupees — so the gross rate is used where netting would
      // take the rate to or below zero. Same rule, same reason, as grn-qc.ts.
      const costPrice = (canNet && netCandidate > 0) ? netCandidate : nextPrice;
      const costTotal = (canNet && netCandidate > 0) ? r2(grossTotal - discShare) : grossTotal;

      const tax = deriveLineTax(line, nextAccepted, nextPrice, oldAccepted, oldReceived);
      const nextRejected = (nextReceived < 0 || nextAccepted < 0) ? 0 : Math.max(0, r6(nextReceived - nextAccepted));
      // ── THE REJECTED QUANTITY AND THE SENTENCE THAT EXPLAINS IT MOVE
      //    TOGETHER, OR THE DOCUMENT LIES. ───────────────────────────────────
      // quantity_rejected was being rewritten while rejection_reason and the
      // line note were left exactly as they were. Both directions were wrong on
      // the paper: raising received to 12 with accepted left at 10 minted a
      // rejected quantity of 2 with a BLANK reason — on a rail where both
      // receiving routes refuse a turned-away quantity under three characters,
      // because "the reason goes on the receiving-variance report and is what
      // the vendor is answerable to" — and taking rejected back to 0 left
      // "Rejected 2 (spoiled)" standing on a line that now rejects nothing,
      // where /grn/print and /receiving-variance both read it.
      // The amendment's own reason is the honest source: it is the sentence the
      // admin just gave for this very change, and it is already mandatory.
      const nextRejectReason = nextRejected > QTY_EPS
        ? (String(line.rejection_reason || '').trim() && near(nextRejected, Number(line.quantity_rejected) || 0)
            ? String(line.rejection_reason)
            : `Recorded by bill amendment: ${reason}`)
        : '';
      // ── A MANUAL-TAX LINE CANNOT BE UN-ZEROED ─────────────────────────────
      // A line whose gst_rate / cess_rate are 0 carries HAND-TYPED rupees (the
      // ad-hoc form's "Manual" tax option). With no rate to recompute from, the
      // only honest operation is to scale those rupees by how the goods value
      // moved — which is 0 when nothing is accepted, exactly as decideGrnQc
      // scales a fully-rejected line. That is right, and it is also one-way:
      // re-booking the line afterwards has no ₹ left to scale back up. Said out
      // loud, because an input credit that quietly went to zero and never came
      // back is the kind of error an auditor finds, not the kind that washes out.
      const hadManualTax = (Number(line.gst_rate) || 0) <= 0 && (Number(line.cess_rate) || 0) <= 0
        && ((Number(line.cgst) || 0) + (Number(line.sgst) || 0) + (Number(line.compensation_cess) || 0)) > 0;
      if (hadManualTax && (tax.cgst + tax.sgst + tax.compensation_cess) <= 0) {
        result.warnings.push(
          `${materialName}: this line's tax was typed in rupees rather than as a rate, and the correction takes it to ₹0. Re-booking the line later cannot bring that figure back — re-record the receipt if the input credit is still claimable.`
        );
      } else if (hadManualTax && (acceptedMoves || !near(nextPrice, oldPrice))) {
        // SAY WHICH ARITHMETIC RAN. On a line carrying a GST RATE the tax below
        // is re-derived exactly as both receiving routes derive it. On a
        // hand-typed line there is no rate to derive from, so the recorded
        // rupees are RESCALED in proportion to the goods value — which will not
        // reconcile to any percentage, and an accountant reading the register
        // must not have to work that out. Every GRN line in this database today
        // is of the hand-typed kind, so this is the ordinary case, not the edge.
        result.warnings.push(
          `${materialName}: this line's tax was typed in rupees, not as a rate, so it was RESCALED in proportion to the goods value (CGST ₹${r2(Number(line.cgst) || 0)} → ₹${tax.cgst}, SGST ₹${r2(Number(line.sgst) || 0)} → ₹${tax.sgst}), not re-derived from a percentage. Check it against the vendor's bill before claiming the input credit.`
        );
      }

      auditBefore.lines.push(line);
      if (costRow) auditBefore.purchases.push(costRow);
      if (txRow) auditBefore.inventory_transactions.push(txRow);
      auditBefore.materials.push(snapshotMaterials(db, [{
        material_id: materialId, material_name: materialName, qty: recordedIn, current_stock: onHandBefore,
      }])[0]);

      let costAction: AmendLineChange['cost_row'] = 'none';
      let lppRate: number | null = null;

      if (wantsRemove || Math.abs(nextAccepted) <= QTY_EPS) {
        // ── FULL REVERSAL of this line, through the SHARED helper the void uses.
        if (costRow) {
          // ── SAVE THE COST ROW'S PROSE BEFORE IT IS DESTROYED ───────────────
          // cost_vendor and cost_note exist on the GRN line for exactly this
          // purpose — they are the copy taken at inward "so a deferred booking
          // never has to re-compose prose", which is the failure grn_id was added
          // to end. On a receipt older than those columns they are empty, and
          // zeroing a line would then delete the ONLY copy of the sentence
          // src/lib/purchase-log.ts parses with an anchored regex to decide
          // is_mirror: re-book the line later and the cost row comes back with no
          // note, and that rupee is counted twice in the purchase log.
          // Back-filled ONLY where the line has nothing, so a stored value is
          // never overwritten and nothing is invented — the string copied is the
          // one the originating route itself wrote.
          if (!String(line.cost_note || '').trim() && String(costRow.notes || '').trim()) {
            db.prepare(`UPDATE goods_receipt_note_items SET cost_note = ? WHERE id = ? AND grn_id = ? AND COALESCE(TRIM(cost_note), '') = ''`)
              .run(String(costRow.notes), req.id, grnId);
          }
          if (!String(line.cost_vendor || '').trim() && String(costRow.vendor || '').trim()) {
            db.prepare(`UPDATE goods_receipt_note_items SET cost_vendor = ? WHERE id = ? AND grn_id = ? AND COALESCE(TRIM(cost_vendor), '') = ''`)
              .run(String(costRow.vendor), req.id, grnId);
          }
          const moves: RecordedMove[] = [{
            material_id: materialId, material_name: materialName, qty: recordedIn, current_stock: onHandBefore,
          }];
          const rev = reverseGrnMovement(db, { grnId, materialId, moves, includeGrossCandidate: true });
          result.purchases_deleted += rev.purchases_deleted;
          result.transactions_deleted += rev.transactions_deleted;
          result.last_purchase_stale.push(...rev.last_purchase_stale);
          result.last_purchase_kept.push(...rev.last_purchase_kept);
          // A removal re-derives LPP from the newest SURVIVING purchase (the
          // void's rule), so the rate reported here is that row's, not this
          // line's — which is why it is reported at all.
          result.last_purchase_updated.push(...rev.last_purchase_rederived.map(x => ({
            material_id: x.material_id, material_name: x.material_name, rate: x.rate,
          })));
          costAction = 'deleted';
          touched.add(materialId);
        }
        if (wantsRemove) {
          const del = db.prepare(`DELETE FROM goods_receipt_note_items WHERE id = ? AND grn_id = ?`).run(req.id, grnId);
          if (del.changes !== 1) {
            throw refuse(409, 'line_changed',
              `${materialName} on ${grnNumber} could not be removed — the row changed while this bill was open. Nothing was changed.`);
          }
        } else {
          writeLine.run(nextReceived, nextAccepted, nextRejected, nextRejectReason,
                        nextLineNote(line, nextRejected, nextRejectReason),
                        nextPrice, tax.cgst, tax.sgst, tax.compensation_cess, req.id, grnId);
        }
      } else if (costRow) {
        // ── CORRECTION IN PLACE. The cost row is REWRITTEN, never deleted and
        //    re-inserted: every other column on it (vendor, the cost_note
        //    purchase-log.ts parses with an anchored regex, bill_no, discount,
        //    delivery_charges, outlet_id, created_at) is exactly what its
        //    originating route wrote and is not a function of quantity or rate.
        //    The movement row is rewritten for the same reason — reference_id is
        //    the only link back to the cost row, and re-minting it would break the
        //    join the void reverses by. A NEGATIVE `purchases` row is never
        //    written to express the difference (return-stock.ts): FIFO's "latest
        //    purchase" would become the correction itself.
        db.prepare(`UPDATE purchases SET quantity = ?, unit_price = ?, total_price = ? WHERE id = ?`)
          .run(nextAccepted, costPrice, costTotal, costRow.id);
        result.purchases_updated++;
        costAction = 'updated';
        if (txRow) {
          db.prepare(`UPDATE inventory_transactions SET quantity = ? WHERE id = ?`).run(newIn, txRow.id);
          result.transactions_updated++;
        }
        const delta = r6(newIn - recordedIn);
        if (Math.abs(delta) > EPS) {
          db.prepare(`UPDATE raw_materials SET current_stock = current_stock + ?, updated_at = datetime('now') WHERE id = ?`)
            .run(delta, materialId);
        }
        lppRate = nextPrice;   // GROSS on both origins — see proveLppOwnership.
        writeLine.run(nextReceived, nextAccepted, nextRejected, nextRejectReason,
                      nextLineNote(line, nextRejected, nextRejectReason),
                      nextPrice, tax.cgst, tax.sgst, tax.compensation_cess, req.id, grnId);
        touched.add(materialId);
      } else {
        // ── A LINE THAT NEVER BOOKED, NOW BOOKING. Accepted was 0 (fully
        //    rejected at QC, or a zero line) and is being corrected upward, so
        //    the three writes have to be made for the first time. Bound exactly
        //    as the originating route binds them, with every non-quantity value
        //    taken from the STORED LINE — cost_vendor and cost_note were written
        //    at inward precisely so a deferred booking never has to re-compose
        //    prose (that is the failure grn_id was added to end).
        const purchaseId = generateId();
        db.prepare(`
          INSERT INTO purchases (id, material_id, vendor, brand, quantity, unit_price, total_price, date, notes,
                                 bill_no, is_emergency, payment_mode, emergency_reason, outlet_id,
                                 discount, delivery_charges, grn_id, created_at)
          VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, 0, '', '', ?, 0, ?, ?, datetime('now'))
        `).run(purchaseId, materialId, String(line.cost_vendor || grn.vendor || ''),
               nextAccepted, costPrice, costTotal, grn.date,
               // ── THE NOTE IS NOT OPTIONAL PROSE, IT IS THE JOIN. ───────────
               // src/lib/purchase-log.ts decides is_mirror and link_key from
               // purchases.notes TEXT ALONE (`notes GLOB '*GRN-####-#*'`) — never
               // from purchases.grn_id — so a cost row minted with an empty note
               // is reported as a DIRECT purchase "entered with no GRN behind
               // it", beside the very GRN it mirrors, with link_key null. All 31
               // GRN lines in this database carry an empty cost_note (they
               // predate the column), so `line.cost_note || ''` was the ordinary
               // path here, not the edge. The fallback re-composes the exact
               // sentence the ORIGINATING route would have written — nothing
               // invented, the same two shapes, so the anchored regex matches.
               String(line.cost_note || '').trim() || composedCostNote,
               String(grn.invoice_number || '').trim(),
               grn.outlet_id, Number(line.delivery_charges) || 0, grnId);
        db.prepare(`
          INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at, outlet_id)
          VALUES (?, ?, 'purchase', ?, ?, ?, datetime('now'), ?)
        `).run(generateId(), materialId, newIn, purchaseId,
               `Amended ${grnNumber}`, grn.outlet_id);
        db.prepare(`UPDATE raw_materials SET current_stock = current_stock + ?, updated_at = datetime('now') WHERE id = ?`)
          .run(newIn, materialId);
        result.purchases_created++;
        result.transactions_created++;
        costAction = 'created';
        lppRate = nextPrice;
        writeLine.run(nextReceived, nextAccepted, nextRejected, nextRejectReason,
                      nextLineNote(line, nextRejected, nextRejectReason),
                      nextPrice, tax.cgst, tax.sgst, tax.compensation_cess, req.id, grnId);
        touched.add(materialId);
      }

      // ── last_purchase_price, only where THIS receipt owns it. ─────────────
      // The receiving routes overwrite it unconditionally because at receive time
      // the receipt IS the newest purchase. Days later it may not be, and an
      // unconditional write here would rewrite a NEWER receipt's rate — exactly
      // the defect the void's ownership proof was built to stop. So the column is
      // touched only where the stored value provably came from this line, and the
      // material is named in `last_purchase_kept` otherwise.
      if (lppRate != null) {
        const snap = auditBefore.materials[auditBefore.materials.length - 1] as MaterialSnapshot;
        const owned = proveLppOwnership(
          [{ material_id: materialId, material_name: materialName, qty: recordedIn, current_stock: onHandBefore }],
          [snap],
          new Map([[materialId, [oldPrice, Number(costRow?.unit_price ?? oldPrice)]]]),
          new Map([[materialId, [String(grn.date ?? ''), String(costRow?.date ?? grn.date ?? '')]]]),
        );
        // ── AND ONLY WHERE THIS RECEIPT IS STILL THE NEWEST ONE. ─────────────
        // The ownership proof is an identity test — stored rate matches a
        // candidate AND stored date matches a candidate — and it CANNOT separate
        // two receipts of the same staple at the same rate on the same day, which
        // is the ordinary case, not a rarity. It defaults to "owned", so amending
        // the OLDEST of five same-day receipts of Pasta at ₹100 wrote its new
        // ₹110 into a column the NEWEST receipt had written, leaving a figure no
        // current receipt supports and seeding the next PO from it. Ordering is
        // the tiebreak the identity test does not have: if the newest surviving
        // purchase of this material did not come from this bill, this bill is not
        // the one that gets to say what the last purchase price is.
        const newestGrn = String((db.prepare(`
          SELECT COALESCE(grn_id, '') AS grn_id FROM purchases
           WHERE material_id = ? ORDER BY date DESC, created_at DESC, rowid DESC LIMIT 1
        `).get(materialId) as any)?.grn_id ?? '');
        // An empty grn_id means the newest row is a DIRECT /api/purchases entry,
        // which is also not this bill — so it fails the test for the same reason.
        const isNewest = newestGrn === grnId;
        if (owned.has(materialId) && isNewest) {
          db.prepare(`UPDATE raw_materials SET last_purchase_price = ?, last_purchase_date = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(lppRate, grn.date, materialId);
          result.last_purchase_updated.push({ material_id: materialId, material_name: materialName, rate: lppRate });
        } else {
          result.last_purchase_kept.push({ material_id: materialId, material_name: materialName });
        }
      }

      const onHandAfter = Number((db.prepare(`SELECT current_stock FROM raw_materials WHERE id = ?`).get(materialId) as any)?.current_stock);
      const afterLine = wantsRemove ? null : {
        ...line, quantity_received: nextReceived, quantity_accepted: nextAccepted,
        quantity_rejected: nextRejected, unit_price: nextPrice, ...tax,
      };
      if (afterLine) auditAfter.lines.push(afterShape(afterLine, materialId, materialName));
      auditAfter.stock.push({ material_id: materialId, material_name: materialName, current_stock: r6(onHandAfter) });
      result.changes.push({
        grn_item_id: req.id, material_id: materialId, material_name: materialName,
        action: wantsRemove ? 'removed' : 'updated',
        before: beforeShape(line), after: afterLine ? beforeShape(afterLine) : null,
        cost_row: costAction,
        stock_delta_recipe: r6((wantsRemove || Math.abs(nextAccepted) <= QTY_EPS ? 0 : newIn) - recordedIn),
        on_hand_before: r6(onHandBefore), on_hand_after: r6(onHandAfter),
      });
    }

    // ── 4. THE HEADER STATUS, KEPT TRUE. Recomputed with the SAME rule both
    //       receiving routes and decideGrnQc apply, so an amended receipt is
    //       indistinguishable from one recorded correctly the first time:
    //         ad-hoc → 'partial' when any line carries a rejected quantity
    //         PO     → 'partial' when any line is rejected OR short-received
    //         nothing accepted at all → 'rejected'; only corrections → 'received'
    //       NEVER applied to a held or voided receipt: 'partial' would overwrite
    //       'awaiting_qc' and the sign-off's claim would then match nothing,
    //       leaving the delivery stuck, un-inwarded AND un-signable.
    if (!held) {
      const rows = db.prepare(
        `SELECT quantity_ordered, quantity_received, quantity_accepted, quantity_rejected FROM goods_receipt_note_items WHERE grn_id = ?`
      ).all(grnId) as any[];
      const totalAccepted = rows.reduce((s, r) => s + (Number(r.quantity_accepted) || 0), 0);
      const anyRejected = rows.some(r => (Number(r.quantity_rejected) || 0) > QTY_EPS);
      const anyShort = isPoGrn && rows.some(r => (Number(r.quantity_received) || 0) < (Number(r.quantity_ordered) || 0) - QTY_EPS);
      const corrections = rows.filter(r => (Number(r.quantity_accepted) || 0) < -QTY_EPS).length;
      const next = totalAccepted <= QTY_EPS
        ? (corrections > 0 && !anyRejected ? 'received' : 'rejected')
        : ((anyRejected || anyShort) ? 'partial' : 'received');
      if (next !== String(grn.status)) {
        db.prepare(`UPDATE goods_receipt_notes SET status = ? WHERE id = ? AND status <> 'void' AND status <> 'awaiting_qc'`)
          .run(next, grnId);
        result.status_after = next;
      }
    }

    // ── 5. purchase_orders.total_cost — kept in step on a PO receipt. ───────
    //       THE EXACT DERIVATION src/lib/grn-qc.ts:1476-1481 already uses, re-run
    //       rather than restated, so a third copy of this sum cannot drift. ONLY
    //       on a PO that is already 'received': while it is still 'approved' the
    //       column means WHAT WAS ORDERED (recalcTotal is its only other writer)
    //       and every reader assumes exactly that — moving it to the received-so-
    //       far net would show a part-delivered order at less than its order value
    //       with nothing on screen saying why.
    //
    //       THE PER-LINE RECEIPT CLAIM IS UNTOUCHED BY A VALUE CORRECTION:
    //       receivedPoItemIds() keys on the goods_receipt_note_items ROW EXISTING
    //       with its po_item_id, not on its quantities, so changing a quantity or
    //       a rate cannot un-claim a PO line, change received_line_count or move
    //       the completion test. REMOVING a line would, in six unfiltered
    //       derivations, which is why removal is refused on a PO receipt.
    //       po_vendor_bills is likewise untouched: it is keyed on
    //       (po_id, vendor_name, bill_no) and this route changes none of the three.
    //
    //       ── AND IT IS SKIPPED ENTIRELY WHILE ANY DELIVERY ON THIS ORDER IS
    //          STILL ON QC HOLD, INCLUDING THIS ONE. ──────────────────────────
    //       The sum reads quantity_accepted, and a HELD line's accepted quantity
    //       is pinned to 0 by the QC gate — it is the ABSENCE of a decision, not
    //       a decision to accept nothing. grn-qc.ts owns this same derivation and
    //       gets away with it because it can only ever fire FROM a sign-off, the
    //       one moment a GRN's accepted figures were just written; its own note
    //       says the figure "self-heals — the last GRN to clear lands the right
    //       one". An amendment is a trigger with no sign-off in prospect, so
    //       nothing heals it, and it landed two false figures:
    //         · editing a HELD PO receipt restamped total_cost to −Σ discount
    //           (₹900 → −₹100 on a one-line order) and left it there for the
    //           whole life of the hold, while the response said nothing had
    //           moved;
    //         · editing an INWARDED receipt on an order whose SIBLING bill was
    //           held wiped that sibling's whole value out of the order
    //           (₹2,000 → ₹1,100) — a bill in the building, deleted from the
    //           order's total by an edit to a different bill.
    //       There is no honest total to write while a delivery is undecided, so
    //       none is written: the stored figure is left exactly as the receiving
    //       route set it and the caller is TOLD, rather than being handed a
    //       number that is wrong in a way nothing on screen would explain.
    if (isPoGrn && !held) {
      const heldSiblings = Number((db.prepare(
        `SELECT COUNT(*) AS n FROM goods_receipt_notes WHERE po_id = ? AND status = 'awaiting_qc'`
      ).get(grn.po_id) as any)?.n) || 0;
      if (heldSiblings > 0) {
        result.warnings.push(
          `The purchase order's received total was left unchanged: ${heldSiblings} delivery(ies) on ${result.po_number || 'this order'} are still waiting for a quality check, and a held delivery's accepted quantity is 0 until it is signed — re-deriving the total now would delete those goods from the order's value. It will be re-derived correctly when the last held delivery is signed off.`
        );
      } else if (poRow && String(poRow.status) === 'received') {
        const net = Number((db.prepare(`
          SELECT COALESCE(SUM(ROUND(gi.quantity_accepted * gi.unit_price, 2) - gi.discount), 0) AS net
            FROM goods_receipt_note_items gi
            JOIN goods_receipt_notes g ON g.id = gi.grn_id
           WHERE g.po_id = ? AND g.status <> 'void'
        `).get(grn.po_id) as any)?.net) || 0;
        db.prepare(`UPDATE purchase_orders SET total_cost = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(r2(net), grn.po_id);
        result.po_total_restamped = true;
        result.po_total_cost = r2(net);
        // THE DERIVATION CAN GO NEGATIVE, AND THAT IS NOT THIS ROUTE'S DOING.
        // `SUM(ROUND(accepted × rate, 2) − discount)` subtracts the bill discount
        // whatever the accepted quantity is, so zeroing a fully-discounted line
        // lands at −(discount). grn-qc.ts owns this sum and produces the
        // identical figure on a full QC rejection today, so it is not fixed here
        // — that file is not this change's to edit, and a second, differing copy
        // of the derivation is exactly what re-using it was meant to prevent. It
        // self-heals the moment anything is booked against the order again. Said
        // out loud so an admin reading "−₹100" on a purchase order knows it is
        // arithmetic, not a debt.
        if (r2(net) < 0) {
          result.warnings.push(
            `${result.po_number || 'The purchase order'} now shows a received total of ₹${r2(net)}. That is the bill's discount with nothing left accepted to net it against — the same figure a full quality rejection produces — not money owed. It corrects itself as soon as anything is booked against the order again.`
          );
        }
      }
    } else if (isPoGrn && held) {
      result.warnings.push(
        `The purchase order's received total was left unchanged — this delivery has not been signed off yet, so nothing on it has been accepted and there is no received value to derive. It is stamped at sign-off.`
      );
    }

    // ── 5b. THE ORDER STILL HAS TO BE TOLD WHEN A LINE MOVES OFF IT. ────────
    //       api/purchase-orders/[id]/receive/route.ts refuses (400) any receive
    //       whose line differs from the approved PO in quantity or rate unless a
    //       `deviation_reason` is given, and then raises po.received_excess /
    //       po.received_deviation to the admin with that reason attached. The
    //       whole point is that goods arriving off-PO are the admin's call. The
    //       same figures reached through an amendment raised nothing at all: 25
    //       against an ordered 10 was a 400 at the receiving desk and a silent
    //       200 here, with the order's total restamped to ₹2,500 against a ₹1,000
    //       order and only a generic `grn.line_edit` note behind it. The
    //       amendment's own mandatory reason is carried as the deviation reason —
    //       and the ALERT is what closes the gap, because the person amending is
    //       exactly the person the alert is FOR when somebody else amends.
    //       COLLECTED HERE, RAISED AFTER THE COMMIT (raisePoDeviationAlert): a
    //       notification that fails must never roll back a correction that
    //       succeeded.
    if (isPoGrn && !held && result.changes.length > 0) {
      for (const ch of result.changes) {
        if (ch.action === 'removed' || !ch.after) continue;
        const po = db.prepare(`
          SELECT poi.quantity AS ordered, poi.unit_price AS ordered_rate,
                 COALESCE(rm.purchase_unit, rm.unit, '') AS unit_pu
            FROM goods_receipt_note_items gi
            JOIN purchase_order_items poi ON poi.id = gi.po_item_id
            LEFT JOIN raw_materials rm ON rm.id = gi.material_id
           WHERE gi.id = ?
        `).get(ch.grn_item_id) as any;
        if (!po) continue;   // ad-hoc line on a PO receipt: nothing to compare to
        const ordered = Number(po.ordered) || 0;
        const orderedRate = Number(po.ordered_rate) || 0;
        const received = ch.after.quantity_received;
        const accepted = ch.after.quantity_accepted;
        const rate = ch.after.unit_price;
        const qty_short = received < ordered - QTY_EPS;
        const qty_excess = received > ordered + QTY_EPS;
        const acc_short = accepted < ordered - QTY_EPS;
        const rate_changed = Math.abs(rate - orderedRate) > 0.005;
        if (!qty_short && !qty_excess && !acc_short && !rate_changed) continue;
        result.po_deviation.push({
          material_id: ch.material_id, material_name: ch.material_name,
          unit_pu: String(po.unit_pu || ''),
          ordered: r6(ordered), ordered_rate: r2(orderedRate),
          received: r6(received), accepted: r6(accepted), actual_rate: r2(rate),
          qty_short, qty_excess, acc_short, rate_changed,
          value_impact: r2(accepted * rate - ordered * orderedRate),
          excess_value: qty_excess ? r2((received - ordered) * rate) : 0,
          reason: reason,
        });
      }
    }

    // ── 6. THE RECORD. VERIFIED, NOT BEST-EFFORT — before_json below is the ONLY
    //       copy of the pre-correction line rows, cost rows, movements and price
    //       fields. If it cannot be written the whole correction rolls back.
    logAuditOrThrow(db, {
      event_type: 'grn.line_edit',
      entity_type: 'goods_receipt_note',
      entity_id: grnId,
      actor_email: actorEmail,
      outlet_id: grn.outlet_id ?? null,
      before: auditBefore,
      after: {
        ...auditAfter,
        status: result.status_after,
        changes: result.changes,
        po_total_cost: result.po_total_cost,
      },
      note: `Amended line items on ${grnNumber}: `
        + result.changes.map(c => c.action === 'removed'
            ? `removed ${c.material_name}`
            : `${c.material_name} received ${c.before.quantity_received}→${c.after!.quantity_received}, accepted ${c.before.quantity_accepted}→${c.after!.quantity_accepted}, rate ${c.before.unit_price}→${c.after!.unit_price}`).join('; ')
        + ` — ${reason}`,
    }, 'this line correction (this row is the only copy of the replaced cost rows and stock movements)');

    const after = db.prepare(`SELECT edit_count, edited_at, edited_by, status FROM goods_receipt_notes WHERE id = ?`).get(grnId) as any;
    result.edit_count = Number(after?.edit_count) || 0;
    result.edited_at = after?.edited_at || null;
    result.edited_by = after?.edited_by || actorEmail;
    result.status_after = String(after?.status || result.status_after);
    result.materials_touched = [...touched];
  });
  txn();
  return result;
}

function beforeShape(l: any) {
  return {
    quantity_received: Number(l.quantity_received) || 0,
    quantity_accepted: Number(l.quantity_accepted) || 0,
    quantity_rejected: Number(l.quantity_rejected) || 0,
    unit_price: Number(l.unit_price) || 0,
    cgst: Number(l.cgst) || 0,
    sgst: Number(l.sgst) || 0,
    compensation_cess: Number(l.compensation_cess) || 0,
  };
}
function afterShape(l: any, materialId: string, materialName: string) {
  return { material_id: materialId, material_name: materialName, ...beforeShape(l) };
}

/**
 * THE LINE'S OWN SENTENCE, KEPT IN STEP WITH ITS REJECTED QUANTITY.
 *
 * `gi.notes` is TWO things on one column: whatever the receiver typed at the bay
 * (shown on /grn/qc as "what the receiver saw", and used by purchase-log as the
 * GRN branch's note), and — when he typed nothing and turned goods away — a
 * sentence the receiving route GENERATED, `Rejected 4 (damaged on arrival)`.
 * Only the generated shape is rewritten here, matched exactly, so a human's own
 * words are never touched and never invented over. Anything else is left alone:
 * a correction to a quantity is not a licence to edit a person's note.
 */
const GENERATED_REJECT_NOTE = /^Rejected\s+-?[\d.]+\s*\(.*\)\s*$/;
function nextLineNote(line: any, nextRejected: number, nextReason: string): string {
  const cur = String(line.notes ?? '');
  if (cur.trim() !== '' && !GENERATED_REJECT_NOTE.test(cur.trim())) return cur;
  if (nextRejected > QTY_EPS) return `Rejected ${r6(nextRejected)} (${nextReason || 'no reason given'})`;
  // Rejected has gone to zero. The generated sentence must go with it — left
  // standing, /grn/print and /receiving-variance both keep showing a rejection
  // the line no longer records.
  return cur.trim() === '' ? cur : '';
}

/**
 * HAS AN APPROVED PHYSICAL COUNT ALREADY RE-BASED THIS MATERIAL SINCE THE
 * RECEIPT? Central rows only — variance-approval.ts branches on
 * `department_id` being blank, and only that branch writes
 * raw_materials.current_stock.
 *
 * `date >= grn.date` is the same convention the cutover bar uses (`grn.date <=
 * cutover`): a count taken on the delivery day cannot be shown to exclude the
 * delivery, and the safe reading of "cannot tell" on this rail is "it did".
 *
 * A MISSING TABLE IS A PROVEN "NO", NOT AN UNREADABLE ONE. If variance_approvals
 * has never been created then no count has ever been approved and nothing has
 * been re-based — that is an answer, and refusing every amendment on a database
 * that simply has not run the migration would be a bar with no fact behind it.
 * A genuine query FAILURE is different and is allowed to throw, because "cannot
 * tell whether the book was re-based" must not read as "it was not".
 */
function latestAbsorbingCount(
  db: Database.Database, materialId: string, grnDate: string,
): { date: string; physical_stock: number; unit: string; reviewed_by: string } | null {
  if (!grnDate) return null;
  const exists = db.prepare(
    `SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = 'variance_approvals'`
  ).get() as any;
  if (!exists) return null;
  const row = db.prepare(`
    SELECT date, physical_stock, COALESCE(unit, '') AS unit, COALESCE(reviewed_by, '') AS reviewed_by
      FROM variance_approvals
     WHERE status = 'approved'
       AND COALESCE(department_id, '') = ''
       AND material_id = ?
       AND date >= ?
     ORDER BY date DESC, COALESCE(reviewed_at, '') DESC
     LIMIT 1
  `).get(materialId, grnDate) as any;
  if (!row) return null;
  return {
    date: String(row.date ?? ''),
    physical_stock: Number(row.physical_stock) || 0,
    unit: String(row.unit ?? ''),
    reviewed_by: String(row.reviewed_by ?? ''),
  };
}

/**
 * A ₹0 RATE ON ACCEPTED GOODS — refused on both branches.
 *
 * receive/route.ts (`effAcc > 0 && effPrice <= 0`) and its approve-time twin in
 * po-helpers.ts both already refuse this input, in these words: a receive
 * rewrites the material's average price, and updateMaterialPrice wipes
 * average_price to 0, cascading a "free" ingredient through every recipe.
 * last_purchase_price goes to ₹0 with it and then seeds the next purchase order
 * at nothing. PATCH had only a `< 0` bar, so it was the one door on the whole PO
 * rail through which ₹0 could reach a received line.
 */
function zeroRateRefusal(materialName: string, held: boolean): GrnRefused {
  return refuse(400, 'zero_rate',
    `${materialName}: a rate of ₹0 cannot be recorded against goods on this line. `
    + `updateMaterialPrice averages SUM(quantity × unit_price) / SUM(quantity) into average_price, so a zero rate wipes this material's weighted average and cascades a free ingredient through every recipe and sub-recipe that uses it — and last_purchase_price would then seed the next purchase order at ₹0. `
    + (held ? `The rate will be applied when this delivery is signed off, so it is refused now rather than at sign-off. ` : '')
    + `If the goods really were free, record them as a zero-quantity line or as a separate free-sample receipt; a rate of ₹0 on billed goods is a typo the book cannot tell from a gift.`);
}

function negativeRateRefusal(materialName: string): GrnRefused {
  return refuse(400, 'negative_rate',
    `${materialName}: a negative rate cannot be recorded. updateMaterialPrice averages SUM(quantity × unit_price) / SUM(quantity) into average_price, so a negative rate cascades a nonsense cost into every recipe and sub-recipe that uses this material.`);
}

/**
 * LINE REMOVAL ON A PO-SOURCED RECEIPT — REFUSED, AND THIS IS A REAL LIMITATION,
 * NOT AN OVERSIGHT. It is the same knot the void already documents, one direction
 * shallower, and it cannot be solved honestly from this route:
 *
 *   1. receivedPoItemIds() derives "which PO lines are already received" from
 *      goods_receipt_note_items ALONE, with no status filter. Deleting the row
 *      UN-CLAIMS that po_item_id — which is arguably right — but the same
 *      derivation is repeated with no filter in four places in
 *      api/purchase-orders/route.ts (the detail fold, received_line_count, the
 *      per-vendor delivered/outstanding tally) and once in
 *      .../[id]/edit-approved/route.ts, and all of them live in files this
 *      change does not own.
 *   2. If the PO has already flipped to 'received', un-claiming a line leaves a
 *      RECEIVED purchase order with an outstanding line and no way back: reopening
 *      it means rewriting status, received_at, total_cost back to the ORDERED
 *      total and grn_id back to a surviving GRN.
 *   3. The bill's row in po_vendor_bills is keyed UNIQUE(po_id, vendor_name,
 *      bill_no) and nothing here can decide whether removing one line of a
 *      vendor's bill means that bill is still on the order.
 *
 * WHAT REASON (3) USED TO SAY, AND WHY IT WAS WRONG. It claimed a PO that
 * completed a requisition — especially purpose='party', which deducts stock a
 * second time at receive — needed "a second reversal on a different rail". That
 * is not a reason to refuse REMOVAL, because the alternative this very message
 * recommends, setting accepted to 0, reaches that rail identically and performs
 * no second reversal either. Tested: the party consumption row and the fulfilled
 * requisition both stand, the arithmetic is right (the party really did consume
 * those goods from the pool) and the negative-stock guard refuses when the pool
 * cannot bear it. Stating it as a bar would have told the next reader that the
 * party rail is protected by this refusal when it is reachable through the door
 * the same sentence points at.
 *
 * AND SAY WHAT "SET ACCEPTED TO 0" REALLY COSTS. It reverses the stock and the
 * cost row and keeps the PO line claimed — and it also leaves the order CLOSED
 * with nothing booked against that line: status stays 'received', the po_item_id
 * stays claimed, and re-receiving is refused ("Only approved POs can be
 * received"). That is the same end state a full QC rejection produces today, so
 * it is not new, but an admin choosing between two options is entitled to know
 * that this one is a one-way door and the goods must come in on a fresh PO or an
 * ad-hoc GRN.
 *
 * Refusing is reversible; a half-applied correction is not.
 */
function poLineRemovalRefusal(grnNumber: string, materialName: string): GrnRefused {
  return refuse(409, 'po_line_removal',
    `${materialName} cannot be removed from ${grnNumber} because this receipt was booked against a purchase order. Removing the line would un-claim that PO line — making it receivable again — and the same "already received" derivation is repeated in six places that do not filter voided or removed rows, so the order would then disagree with itself about what has been delivered; if the PO has already closed it would also have to be reopened. `
    + `Set the accepted quantity to 0 instead: that reverses the stock and the cost row and keeps the PO line claimed. Be aware it is a one-way door — the order stays closed with nothing booked against that line, and the goods would have to come in on a fresh PO or an ad-hoc GRN. Otherwise, raise a vendor return for the goods.`,
    { grn_number: grnNumber, material_name: materialName, alternative: 'set_accepted_zero' });
}

/**
 * THE OFF-PO ALERT, RAISED AFTER THE CORRECTION HAS COMMITTED.
 *
 * The same three deliveries api/purchase-orders/[id]/receive/route.ts makes when
 * a line arrives off-PO — an audit_event, a notifications row, and an optional
 * Slack ping — with the same event types, the same `excessOnly` rule and the same
 * per-GRN dedup key, so a deviation that reached the admin through the receiving
 * desk and one that reached him through an amendment look the same on /audit.
 *
 * BEST-EFFORT, AND THAT IS DELIBERATE: it runs outside the transaction, on a
 * correction that is already recorded. A failed notification must never present
 * as a failed correction — an admin who believes a correction failed corrects it
 * again by hand, on top of the one that already landed.
 */
export function raisePoDeviationAlert(
  db: Database.Database,
  args: {
    poId: string; poNumber: string | null; grnNumber: string; grnId: string;
    vendor: string; actorEmail: string; reason: string; lines: PoDeviationLine[];
  },
): string | null {
  if (!args.lines.length) return null;
  try {
    const shortLines = args.lines.filter(l => l.qty_short);
    const overLines = args.lines.filter(l => l.qty_excess);
    const rateChangedLines = args.lines.filter(l => l.rate_changed);
    const accShortLines = args.lines.filter(l => l.acc_short && !l.qty_short);
    const money = (n: number) => `${n < 0 ? '-' : '+'}₹${Math.abs(n).toFixed(0)}`;
    const netValueImpact = r2(args.lines.reduce((s, l) => s + l.value_impact, 0));
    const counts: string[] = [];
    if (shortLines.length) counts.push(`${shortLines.length} short`);
    if (overLines.length) counts.push(`${overLines.length} over`);
    if (accShortLines.length) counts.push(`${accShortLines.length} short-accepted`);
    if (rateChangedLines.length) counts.push(`${rateChangedLines.length} rate change`);
    const lineSummary = args.lines.map(l => {
      const what: string[] = [];
      if (l.qty_short) what.push(`SHORT ${r6(l.ordered - l.received)} ${l.unit_pu}`);
      if (l.qty_excess) what.push(`OVER ${r6(l.received - l.ordered)} ${l.unit_pu}`);
      if (l.acc_short && !l.qty_short) what.push(`SHORT-ACCEPTED ${r6(l.ordered - l.accepted)} ${l.unit_pu} (arrived, not accepted)`);
      if (l.rate_changed) what.push(`RATE ₹${l.ordered_rate} → ₹${l.actual_rate} per ${l.unit_pu}`);
      return `• ${l.material_name}: ordered ${l.ordered} ${l.unit_pu} @ ₹${l.ordered_rate}, now recorded ${l.received} ${l.unit_pu} (accepted ${l.accepted}) @ ₹${l.actual_rate}\n    ${what.join(', ')} — value impact ${money(l.value_impact)}`;
    }).join('\n');
    const poLabel = args.poNumber || args.poId;
    const title = `PO ${poLabel}: ${args.lines.length} line(s) now off-PO after a bill correction on ${args.grnNumber} (${counts.join(', ')}; net ${money(netValueImpact)})`;
    const body = `Vendor: ${args.vendor || '—'}\nGRN: ${args.grnNumber}\nCorrected by: ${args.actorEmail}\nReason given: ${args.reason}\n\n${lineSummary}\n\n`
      + `This delivery was corrected AFTER it was received, so these figures did not go through the receiving desk's deviation gate. Review on /purchase-orders or /audit.`;
    const excessOnly = shortLines.length === 0 && rateChangedLines.length === 0 && accShortLines.length === 0;
    const eventType = excessOnly ? 'po.received_excess' : 'po.received_deviation';
    const notifKind = excessOnly ? 'po_received_excess' : 'po_received_deviation';
    logAuditEvent(db, {
      event_type: eventType,
      entity_type: 'purchase_order',
      entity_id: args.poId,
      actor_email: args.actorEmail,
      after: {
        po_number: args.poNumber, grn_number: args.grnNumber,
        source: 'grn_line_amendment',
        amendment_reason: args.reason,
        net_value_impact: netValueImpact,
        excess_value: r2(overLines.reduce((s, l) => s + l.excess_value, 0)),
        short_lines: shortLines.length, over_lines: overLines.length,
        rate_changed_lines: rateChangedLines.length, acc_short_lines: accShortLines.length,
        lines: args.lines,
      },
      note: title,
    });
    db.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL,
        party_unique_id TEXT, fp_id TEXT, event_name TEXT, event_date TEXT,
        channel TEXT NOT NULL DEFAULT 'slack', recipient TEXT DEFAULT '',
        title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        sent_at TEXT, delivery_meta TEXT DEFAULT '',
        UNIQUE (party_unique_id, kind, channel)
      )
    `);
    // Keyed per AMENDMENT, not per GRN: the receive route's key is
    // `po:<id>:grn:<grn_id>` and it is already taken by the original receipt, so
    // reusing it would make UNIQUE(party_unique_id, kind, channel) swallow this
    // alert silently — exactly the failure that key was widened to fix. A second
    // correction to the same bill is a second thing the admin needs to see.
    const notifKey = `po:${args.poId}:grn:${args.grnId}:amend:${Date.now()}`;
    db.prepare(`
      INSERT OR IGNORE INTO notifications
        (id, kind, party_unique_id, channel, recipient, title, body)
      VALUES (?, ?, ?, 'inapp', 'admin', ?, ?)
    `).run(generateId(), notifKind, notifKey, title, body);
    const webhookRow = db.prepare(`SELECT value FROM settings WHERE key = 'slack_webhook_url'`).get() as { value?: string } | undefined;
    const webhook = webhookRow?.value?.trim();
    if (webhook && webhook.startsWith('http')) {
      fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `🚨 *${title}*\n${body}` }),
      }).catch(() => { /* webhook dead — the audit row and the in-app row already wrote */ });
    }
    return eventType;
  } catch (e) {
    console.error('[grn PATCH] PO deviation alert failed:', e);
    return null;
  }
}
