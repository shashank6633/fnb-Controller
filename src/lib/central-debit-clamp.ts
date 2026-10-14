/**
 * THE CENTRAL FLOOR FOR THE PATHS THAT MAY NOT THROW.
 *
 * raw_materials.current_stock must not go below zero by any operator-reachable
 * route. There are two ways to honour that, and which one is right is decided by
 * WHO IS STANDING THERE — the owner has ruled on both:
 *
 *   · AN OPERATOR IS PRESENT (a storekeeper mid hand-over, a GRN being typed).
 *     REFUSE, with the figure named, and write nothing. His gesture unwinds, the
 *     sentence lands on his screen, and he fixes the line. That is
 *     src/lib/issue-stock.ts (assertCentralIssue / checkCentralIssue) for a
 *     requisition and a pre-transaction 400 for POST /api/grn. THIS FILE IS NOT
 *     FOR THOSE PATHS.
 *
 *   · NOBODY IS PRESENT (a PO receipt, a QC sign-off, a cascade, an admin bulk
 *     reset unwinding records wholesale). A throw rolls back the HOST
 *     transaction — the delivery that physically arrived, the signature, the
 *     whole reset — to prevent one bad debit, and addresses the refusal to
 *     someone who is not there. "Destroying a correct delivery to prevent a bad
 *     debit is the worse outcome" (owner, and src/lib/po-requisition-fulfil.ts
 *     states the same judgement at length at its own clamp). So on those paths:
 *     CLAMP the debit so central cannot go below zero, and RECORD the shortfall
 *     where he can see it. The clamp removes the arithmetic; the record removes
 *     the word "silently".
 *
 * ── WHY THIS IS A FILE AND NOT THREE COPIES ────────────────────────────────
 * Three rounds of this work each discovered a NEW unfloored writer only after
 * the previous one shipped. A floor that is re-typed per call site is how that
 * happens: the fourth writer gets a near-copy that disagrees in the fourth
 * decimal, or gets none at all. The three unattended writers closed in this
 * round — grn-qc.ts's QC sign-off, /api/admin/reset's purchase unwind and
 * /api/sales DELETE's restore leg — all call clampCentralDelta() and nothing
 * else, so there is ONE implementation of "how far may this debit go" on the
 * unattended side and one on the attended side.
 *
 * NEW EXPORT SURFACE. If a sibling lane also needs a clamp (staff-meals,
 * butchering), it must call THESE functions rather than add its own — this
 * project has a recorded incident where two lanes each created a helper with the
 * same shape and the same name and they silently disagreed. Diff the export
 * surface before merging lanes.
 *
 * ── THE BASIS, STATED ONCE ─────────────────────────────────────────────────
 * Everything here is in RECIPE units, because raw_materials.current_stock is
 * recipe units by canon and that column is the thing the caller's UPDATE writes.
 * THIS FILE PERFORMS NO UNIT CONVERSION AT ALL — no packFactor, no pack_size, no
 * second converter. A caller holding a PURCHASE-unit figure converts it with
 * packFactor() from src/lib/pack-units.ts (the one converter) BEFORE calling,
 * exactly as it already must to write the column. Adding a conversion here would
 * be the second one, and it would silently double-apply for every caller that
 * had already converted.
 *
 * ── READ LATE, INSIDE THE TRANSACTION ──────────────────────────────────────
 * The balance is read HERE, from raw_materials, in the same statement as the
 * material's name — not passed in, and not read before the caller's transaction
 * opened. A balance read earlier races: /api/wastage and src/lib/issue-stock.ts
 * both say so at their own guards, and a clamp computed from a stale balance is
 * the stale-snapshot defect this codebase has recorded before. CALL THIS INSIDE
 * THE CALLER'S TRANSACTION, IMMEDIATELY BEFORE THE DEBIT.
 */
import { logAuditEvent } from '@/lib/db';

/** Round DOWN to the house 6dp. Same definition and same reason as `floor6` in
 *  src/lib/issue-stock.ts: a figure that bounds a balance must never round
 *  itself up past the balance it is bounding. Used only on the REPORTED
 *  shortfall — the clamp itself needs no rounding (see `allowedDebit`). */
const floor6 = (n: number) => Math.floor((Number(n) || 0) * 1e6) / 1e6;

/** Below this a delta is float dust, not a movement. The same 1e-9 the sales
 *  reversal already uses on this very arithmetic. It decides only "is this a
 *  debit at all" — never "does this debit fit"; that is QTY_GRID's job below. */
export const CLAMP_EPS = 1e-9;

/* ════════════════════════════════════════════════════════════════════════════
 * THE ONE RULE FOR "DOES THIS DEBIT FIT, AND WHAT DO WE WRITE".
 *
 * Every central floor in the app — the attended ones that REFUSE (both
 * requisition desks via src/lib/issue-stock.ts, the two party rails,
 * /api/parties/items, /api/wastage, /api/staff-meals/items, /api/butchering,
 * the GRN back-correction, the GRN void/amend guard, the vendor-return verify,
 * the store transfer) and the unattended ones that CLAMP (clampCentralDelta
 * below) — asks this ONE function. Nothing else may compare a debit against
 * current_stock.
 *
 * ── WHY IT EXISTS: TWO DECISIONS THAT DID NOT AGREE ─────────────────────────
 * Rounding the allowance and comparing with a tolerance were made separately,
 * per floor, and they disagreed in both directions. MEASURED on the real route
 * modules against a copy of the live book:
 *   · /api/parties/items rounded the allowance to 6 dp and then compared the RAW
 *     ask with a 1e-9 slack — 500x too small to absorb its own rounding. Stored
 *     14842.500000001 (THREE MANGO RED CHILLI POWDER's 14,842.5 g plus binary
 *     noise), ask 14842.500000001: production answered 201 and landed on 0; the
 *     floor refused it. A storekeeper issuing everything on the shelf was told
 *     he could not.
 *   · The same 6-dp rounding rounds a balance UP: stored 99.9999996 became
 *     100.0, an ordinary ask of 100 passed, and current_stock landed at
 *     -4.0000000467443897e-7 on /api/parties/items, store-issue AND
 *     store-process.
 *
 * ── THE TOLERANCE: QTY_GRID = 1e-6 RECIPE UNITS, APPLIED AS A GRID ───────────
 * The house precision for a recipe quantity is 6 dp: issue-stock.ts rounds every
 * requisition debit to it, the GRN guards judge at it (grn-reversal.ts `r6`),
 * every allowance the app prints is at it or coarser. So the tolerance is ONE
 * STEP OF THAT GRID, and it is applied by SNAPPING BOTH SIDES TO THE GRID rather
 * than by adding a slack to one side:
 *
 *     fits  ⇔  qtyGrid(ask) ≤ qtyGrid(max(0, stock))      qtyGrid(x) = round(x·10⁶)
 *
 * Why the grid and not `ask ≤ stock + ε` — this is the whole point:
 *   · IT IS THE SAME DECISION AS THE ROUNDING, NOT A SECOND ONE. A figure the
 *     app prints for the balance (6-dp rounded, or floored, or anything at a
 *     coarser precision that never rounds UP — see qtyDown) lands on the
 *     balance's own grid point or below it, so typing it back always fits.
 *     That is property (a), and it holds by construction, not by the size of a
 *     slack: there is no tie at x.xxxxxx5 that a float can push the wrong way,
 *     because both sides go through the identical Math.round.
 *   · WHY THIS NUMBER, 1e-6 AND NOT 1e-9. 1e-9 is below the grid: it cannot
 *     absorb a 6-dp rounding (up to 5e-7), which is precisely bug 1 above. Any
 *     slack smaller than half a grid step re-creates it.
 *   · WHY NOT LARGER. A debit that is one whole step over the balance lands on
 *     the NEXT grid point and is refused: 10 kg asked of a carcass holding
 *     9.999999 kg is 1 mg short and /api/butchering measured that it must be
 *     refused. A bigger tolerance would write real stock off. The most an
 *     accepted ask can exceed the balance by is strictly less than one step
 *     (both round to the same micro-unit) — below anything the app can print or
 *     weigh, in every unit the catalogue uses (1 µg of a gram-counted spice,
 *     1 mg of a kg-counted carcass, 1 µl, a millionth of a piece).
 *
 * ── PROPERTY (b) IS GUARANTEED AT THE WRITE, NOT AT THE COMPARISON ──────────
 * Accepting an ask that is up to a grid step OVER the balance is only safe if
 * the write cannot then go below zero. So the plan also says WHAT TO SUBTRACT:
 *
 *     debit = available    when the ask is on the balance's own grid point (it
 *                          means "everything on the shelf") or past it;
 *     debit = ask          otherwise — and then ask < available strictly, so
 *                          the landing is > 0.
 *
 * `current_stock − available` is current_stock − current_stock, which is
 * EXACTLY 0 in IEEE 754 — no rounding, no slack, no -4e-7. That holds as long as
 * `stock` is the value read from the row in the SAME transaction as the UPDATE,
 * which every caller already does for its own race reasons. So:
 *   · 14842.500000001 asked in full → fits, debit = the balance → lands on 0.
 *   · 99.9999996 asked 100          → fits, debit = 99.9999996 → lands on 0.
 *   · an ask that leaves a sub-grid positive crumb (14842.500000001 asked
 *     14842.5, the 6-dp figure the requisition rail itself computes) also takes
 *     the crumb and lands on 0 — the balance an operator would have read as
 *     "0" is now actually 0, not 1e-9 that a later reader rounds differently.
 *   · an ALREADY-NEGATIVE balance has available 0, so the most any debit takes
 *     is 0: the hole is never dug deeper, and is left for
 *     /api/inventory/fix-negative-stock exactly as before.
 * The movement row a caller writes beside the UPDATE should carry `debit`, not
 * the ask, so SUM(movements) keeps reconciling to the column. The two differ by
 * strictly less than one grid step, and only when the ask was "everything".
 * ══════════════════════════════════════════════════════════════════════════ */

/** The house quantity grid for RECIPE units: 6 dp. ONE step of it is the floor's
 *  tolerance — see the block above for why exactly this number. */
export const QTY_GRID = 1e-6;
const GRID_SCALE = 1e6; // 1 / QTY_GRID, written out so the multiply is exact-intent

/** A recipe quantity as an integer count of grid steps. Two quantities with the
 *  same qtyGrid() are the SAME quantity to every floor in the app. */
export function qtyGrid(n: number): number {
  const v = Math.round((Number(n) || 0) * GRID_SCALE);
  return v === 0 ? 0 : v; // normalise -0
}

export interface CentralDebitPlan {
  /** The raw stored balance, as read by the caller inside its transaction. */
  stock: number;
  /** max(0, stock), UNROUNDED. The most that may physically leave. */
  available: number;
  /** The positive debit asked for (0 when the caller passed ≤ 0 — not a debit). */
  ask: number;
  /** THE answer: qtyGrid(ask) ≤ qtyGrid(available). Attended floors refuse on
   *  false; unattended floors clamp to `debit`. */
  fits: boolean;
  /** What to SUBTRACT from current_stock. Never more than `available`, so
   *  `stock − debit` is never below zero (exactly 0 when debit = available). */
  debit: number;
  /** How far past the balance the ask reaches, in whole 6-dp grid steps (so
   *  never 0 on a refusal); 0 when it fit. */
  short: number;
  /** The ask was on (or past) the balance's grid point, so the write takes the
   *  balance itself and lands on exactly 0. */
  takesAll: boolean;
}

/**
 * DOES THIS DEBIT FIT, AND WHAT EXACTLY DO WE SUBTRACT?
 *
 * Pure: the caller reads `stock` from raw_materials INSIDE its transaction,
 * immediately before the UPDATE (a balance read earlier races), and passes the
 * figure it is about to subtract as `ask` — in RECIPE units, already converted
 * with packFactor where needed. This function converts nothing.
 */
export function planCentralDebit(stock: number, ask: number): CentralDebitPlan {
  const s = Number(stock) || 0;
  const a = Number(ask) || 0;
  const available = s > 0 ? s : 0;
  if (!(a > 0)) {
    // Not a debit — a credit or nothing. Not this rule's business; callers handle
    // credits on their own rails (see clampCentralDelta for why a credit is never
    // touched).
    return { stock: s, available, ask: 0, fits: true, debit: 0, short: 0, takesAll: false };
  }
  const gAsk = qtyGrid(a);
  const gAvail = qtyGrid(available);
  const fits = gAsk <= gAvail;
  // On the balance's own grid point or past it ⇒ take the balance itself, which
  // lands on exactly 0 (fits) or is the clamp (does not fit). Below it ⇒ the ask
  // is strictly less than the balance (Math.round is monotonic), so the landing
  // is strictly positive.
  const takesAll = gAsk >= gAvail;
  const debit = takesAll ? available : a;
  return {
    stock: s, available, ask: a, fits, debit, takesAll,
    // Counted in GRID STEPS, the unit the decision was taken in, so a refusal is
    // never reported as "short 0": 100 asked of 99.999999 is one step over, and
    // floor6(100 − 99.999999) would print 0.000000 (the float difference is
    // 9.99999997e-7). Measured with the unit check in this round.
    short: fits ? 0 : (gAsk - gAvail) / GRID_SCALE,
  };
}

/**
 * THE SAME GUARANTEE FOR A GESTURE WHOSE DEBIT IS SPLIT ACROSS STATEMENTS.
 *
 * planCentralDebit's `debit` puts property (b) at the write — but only where ONE
 * statement subtracts ONE figure. Two writers cannot use it that way:
 *   · the GRN void (reverseGrnMovement) DEBITS the whole recorded receipt and
 *     then, on a PO receipt that fed a party requisition, the cascade CREDITS
 *     the party's draw back — the guard judges the NET, and the debit alone is
 *     allowed to pass through a transient negative;
 *   · the GRN line amendment debits the recorded line and re-books the corrected
 *     figure.
 * Taking "the balance itself" on the first leg would be wrong there (50 held,
 * 100 voided, 60 credited back must end at 10, not 60). So these gestures write
 * their legs as they always have and call THIS once at the end, for the
 * materials they debited, after their own floor has accepted the net on the
 * grid. A landing in (−QTY_GRID, 0) is then, by that acceptance, exactly the
 * sub-grid crumb property (b) forbids — and it is set to exactly 0. Nothing at
 * or below −QTY_GRID is touched: that is a real balance, not a crumb, and it
 * stays visible for /api/inventory/fix-negative-stock.
 *
 * Returns the material ids it zeroed (normally none).
 */
export function sweepCentralCrumbs(db: any, materialIds: Iterable<string>): string[] {
  const swept: string[] = [];
  const stmt = db.prepare(
    `UPDATE raw_materials SET current_stock = 0, updated_at = datetime('now')
      WHERE id = ? AND current_stock < 0 AND current_stock > ?`,
  );
  for (const id of new Set(Array.from(materialIds, x => String(x || '')))) {
    if (!id) continue;
    if (stmt.run(id, -QTY_GRID).changes > 0) swept.push(id);
  }
  return swept;
}

/**
 * A figure for an allowance PRINTED at `dp` decimals that never names more than
 * the floor will accept. A refusal that says "holds only 100 g" over a balance of
 * 99.99996 g sends the operator to type 100 and be refused again with the same
 * sentence — the rounding and the rule disagreeing in the message instead of the
 * comparison. Round-then-step, not a bare floor: 2 kg stored as
 * 1.9999999999999998 is ON the 2.000000 grid point, so it prints 2, not 1.999.
 * At dp = 6 this is the identity on the grid.
 */
export function qtyDown(n: number, dp: number): number {
  const x = Number(n) || 0;
  const p = Math.pow(10, dp);
  let r = Math.round(x * p) / p;
  if (qtyGrid(r) > qtyGrid(x)) r = Math.round(r * p - 1) / p;
  return r === 0 ? 0 : r;
}

export interface CentralDeltaClamp {
  materialId: string;
  /** raw_materials.name, read in the same statement as the balance. '' when the
   *  material no longer exists. */
  materialName: string;
  /** The material row was found. FALSE means there is nothing to drive negative
   *  and nothing was clamped — see the note at the read. */
  exists: boolean;
  /** The raw stored balance, negatives included, so nothing is hidden. */
  stockRecipe: number;
  /** The SIGNED delta the caller asked to write. */
  wantedDelta: number;
  /** The SIGNED delta the caller must write INSTEAD. Equal to wantedDelta on
   *  every credit and on every debit the balance can cover. */
  deltaToWrite: number;
  /** RECIPE units the clamp refused to take out. > 0 only when it bit. */
  shortRecipe: number;
  /** The clamp reduced the debit. Nothing else in this result is interesting
   *  when this is false, and an ordinary call is byte-identical to no clamp. */
  clamped: boolean;
}

/**
 * How far may this signed delta actually go against central?
 *
 * A CREDIT IS NEVER TOUCHED. deltaRecipe >= 0 passes straight through — adding
 * stock cannot drive a balance below zero, and an already-negative balance being
 * reduced by a credit is the correction /api/inventory/fix-negative-stock exists
 * for. Clamping a credit would block the one movement that heals the book.
 *
 * A DEBIT IS CAPPED AT WHAT IS THERE, AND AT ZERO. The cap is
 * `max(0, stockRecipe)`, not `stockRecipe`: an ALREADY-NEGATIVE balance must
 * read as "nothing available", never as a negative allowance that lets the next
 * debit dig the hole deeper. src/lib/issue-stock.ts and /api/wastage both floor
 * the balance the same way and for the same reason. WHETHER the debit fits is
 * planCentralDebit's grid test — the same answer every attended floor gets — so
 * a debit within the house grid of the balance is covered (and takes the
 * balance itself, landing on 0), not clamped and not reported.
 *
 * NO ROUNDING IS APPLIED TO THE CLAMPED DEBIT, deliberately. It is
 * `-Math.min(debit, cap)`, so when the cap bites the bound value is the balance
 * itself and `current_stock + (-current_stock)` is exactly 0 in IEEE 754 — the
 * floor holds without a tolerance. Rounding it to 6dp could round the debit UP
 * past the balance and reintroduce a sub-microgram negative, which is the whole
 * class of bug this file exists to end.
 */
export function clampCentralDelta(
  db: any,
  a: { materialId: string; deltaRecipe: number },
): CentralDeltaClamp {
  const materialId = String(a.materialId ?? '');
  const wantedDelta = Number(a.deltaRecipe) || 0;
  // ONE statement for the balance and the name, so the figure and the material
  // it describes can never come from two different reads.
  const row = materialId
    ? db.prepare(
        `SELECT COALESCE(name, '') AS name, COALESCE(current_stock, 0) AS current_stock
           FROM raw_materials WHERE id = ?`,
      ).get(materialId) as { name: string; current_stock: number } | undefined
    : undefined;

  const base: CentralDeltaClamp = {
    materialId,
    materialName: row ? String(row.name) : '',
    exists: !!row,
    stockRecipe: row ? (Number(row.current_stock) || 0) : 0,
    wantedDelta,
    deltaToWrite: wantedDelta,
    shortRecipe: 0,
    clamped: false,
  };

  // A MATERIAL THAT DOES NOT EXIST IS NOT CLAMPED. There is no balance to drive
  // negative: the caller's own UPDATE will match no row and write nothing, and
  // every one of these call sites reaches this function from a stored
  // material_id that the caller then uses verbatim. Refusing or zeroing here
  // would change what the caller writes on a row that does not exist — a
  // behaviour change with no stock behind it. /api/wastage's central floor makes
  // the identical call on the identical reasoning.
  if (!row) return base;

  // Credits, and dust, pass through untouched.
  if (wantedDelta >= -CLAMP_EPS) return base;

  // THE ONE RULE (planCentralDebit, above). `debit` is never more than
  // max(0, balance), so the write can never go below zero; when the debit is
  // "everything on the shelf" — on the balance's grid point or past it — it is
  // the balance itself and the landing is exactly 0.
  const plan = planCentralDebit(base.stockRecipe, -wantedDelta);
  if (plan.fits) {
    // Covered. Byte-identical to no clamp unless the debit was "everything",
    // where it takes the sub-grid crumb with it instead of leaving 1e-9 behind
    // or writing -4e-7. Not a clamp: nothing the operator could see was cut.
    return plan.debit === plan.ask ? base : { ...base, deltaToWrite: -plan.debit };
  }

  return {
    ...base,
    deltaToWrite: -plan.debit,
    shortRecipe: plan.short,
    clamped: true,
  };
}

/**
 * WHAT COULD NOT BE DEBITED, ON ITS OWN AUDIT ROW.
 *
 * A clamped debit is PERMANENT — the host gesture commits and nothing will come
 * back later to finish the debit — so this record is not optional. It is the
 * only thing that will ever say the book and the shelf parted company, and it is
 * what turns "central silently went negative" into "central did not go negative
 * and here is the gram that is missing".
 *
 * ONE EVENT TYPE PER CALLER, passed in, so a reader can tell a clamped QC
 * sign-off from a clamped reset from a clamped sale reversal without parsing a
 * note. Modelled on 'requisition.party_consumption.short'
 * (src/lib/po-requisition-fulfil.ts), which is the first of these and sets the
 * `.short` suffix convention.
 *
 * logAuditEvent swallows its own failure by design, which is right here: a
 * missing audit row must not abort a delivery or a reset. That is the opposite
 * of logAuditOrThrow (src/lib/grn-reversal.ts), which guards the ONLY COPY of
 * rows about to be destroyed. Nothing is destroyed here — the clamp's inputs are
 * all still readable afterwards — so best-effort is the correct strength.
 *
 * Writes NOTHING when no clamp bit, so an ordinary gesture adds no row.
 */
export function recordCentralDebitClamp(
  db: any,
  a: {
    eventType: string;
    entityType: string;
    entityId: string;
    actorEmail?: string;
    outletId?: string | null;
    /** Only the clamps that actually bit. Callers may pass the whole list. */
    clamps: CentralDeltaClamp[];
    /** Prepended to the note so the row says which gesture it came from. */
    note?: string;
  },
): void {
  const bit = (a.clamps || []).filter(c => c && c.clamped);
  if (bit.length === 0) return;
  const lines = bit.map(c => ({
    material_id: c.materialId,
    material_name: c.materialName,
    central_stock_recipe: c.stockRecipe,
    wanted_debit_recipe: floor6(-c.wantedDelta),
    debited_recipe: floor6(-c.deltaToWrite),
    short_recipe: c.shortRecipe,
  }));
  logAuditEvent(db, {
    event_type: a.eventType,
    entity_type: a.entityType,
    entity_id: String(a.entityId),
    actor_email: a.actorEmail || '',
    outlet_id: a.outletId ?? null,
    after: { reason: 'central_floor', clamped_lines: lines },
    note: `${a.note ? `${a.note} — ` : ''}${bit.length} material(s) could not be debited in full from central `
      + `(the debit was clamped at zero, nothing was taken below it): `
      + bit.map(l => `${l.materialName || l.materialId} (short ${l.shortRecipe})`).join(', '),
  });
}
