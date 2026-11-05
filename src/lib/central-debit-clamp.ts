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

/** Round DOWN to the house 6dp: a figure that bounds a balance must never round
 *  itself up past the balance it is bounding. Used ONLY on the two figures
 *  recordCentralDebitClamp REPORTS (wanted and debited) — this file's own
 *  helper, the only one left (issue-stock.ts no longer has a copy). The clamp
 *  itself needs no rounding: clampCentralDelta writes planCentralDebit's
 *  `debit`, which is the balance itself when it bites. */
const floor6 = (n: number) => Math.floor((Number(n) || 0) * 1e6) / 1e6;

/** Below this a delta is float dust, not a movement. The same 1e-9 the sales
 *  reversal already uses on this very arithmetic. It never decides "does this
 *  debit fit"; that is QTY_GRID's job below. In clampCentralDelta it marks the
 *  debits that are written as asked when the shelf covers them — and, since
 *  round 10, never past what the shelf holds (a dust debit over a zero balance
 *  used to land at -1e-9). */
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
 * the ask, so SUM(movements) keeps reconciling to the column. On the grid rule
 * alone the two differ by strictly less than one grid step, and only when the
 * ask was "everything". (The shown-figure rule below can widen that to under
 * one DISPLAY step, and then the caller must record `debit` — see there.)
 *
 * ── THE SHOWN FIGURE IS THE BALANCE (round 6) ───────────────────────────────
 * The grid above is the house precision; it is NOT the precision the operator
 * reads. Both requisition desks print central's balance in the PURCHASE unit at
 * 3 dp, half-up (toPurchaseQty — the "In store" column, U.stockPU on both
 * pages), and the storekeeper types what he reads. MEASURED on the live book,
 * 2 of the 466 materials holding stock: THREE MANGO RED CHILLI POWDER holds
 * 14,842.5 g (g/kg, pack 1000) and the desk shows 14.843 kg; GREEN APPLE holds
 * 8,368.5 g and shows 8.369 kg. On the grid alone:
 *   · typing 14.843 was REFUSED ("holds only 14.842 kg") — production accepted
 *     it and went to −0.5 g;
 *   · clicking the offered 14.842 left a 0.5 g crumb, and the NEXT ask was told
 *     "the central store holds none of it" while it held 0.5 g — escapable only
 *     by typing 0.0005 kg, a figure no screen ever shows.
 *
 * So, ONE rule for every floor whose operator reads a coarser figure than the
 * grid, decided HERE and nowhere else:
 *
 *     the ask's shown figure  ===  the balance's shown figure  >  0
 *       ⇒  the ask IS "everything on the shelf": it fits, and the debit is the
 *          balance itself, so the landing is exactly 0.
 *
 * `shownAs` is the caller's own display converter (for the desks,
 * r ↦ toPurchaseQty(r, material) — literally the function the column uses), so
 * the comparison is made on the very figure the operator was shown and THIS
 * FILE STILL PERFORMS NO UNIT CONVERSION. A caller that passes none gets the
 * grid rule exactly as before, byte for byte.
 *
 * WHY EQUALITY OF SHOWN FIGURES AND NOT "ask ≤ balance + half a display step":
 *   · it is the operator's own question ("is that what the column said?"), so
 *     it holds by construction for every figure any surface prints through the
 *     same converter — no slack to size, no tie at x.xxx5 a float can push the
 *     wrong way, because both sides go through the identical function;
 *   · it is SYMMETRIC, and must be. 14,842.4 g shows 14.842 kg; typing 14.842
 *     is an ordinary partial on the grid and would leave a 0.4 g crumb the
 *     column then shows as "0". The shown figure means "all of it" from below
 *     as much as from above, so it takes the 0.4 g too and lands on 0;
 *   · "> 0" keeps it from ever manufacturing a fit: a balance that shows 0 is
 *     not matched by an ask that also shows 0 (0.0004 kg asked of an empty
 *     shelf stays refused), so a store holding nothing never "issues" anything.
 *
 * WHAT IT COSTS, STATED: a take by the shown figure moves up to half a display
 * step more or less than was typed (≤ 0.5 g on a 1000-pack, 0.375 ml on a
 * 750 ml bottle). That is why `debitIsAsk` exists. When it is FALSE the caller
 * MUST record `debit` — on the requisition line, the movement row, the ledger
 * and the department credit — never the ask: the line then says what left the
 * shelf, which is the only figure that is not phantom stock in one direction or
 * a hole in the other. It can never go below zero, because `debit` is still
 * `available` and `stock − available` is still exactly 0.
 *
 * WHAT IT CANNOT DO: refuse anything the grid accepted. It only ever ADDS fits
 * (an ask whose shown figure equals the balance's), so every ask production or
 * round 5 accepted is still accepted. On every refusal it leaves standing,
 * shownAsk > shownAvailable strictly (ask > balance on the grid, Math.round is
 * monotonic, and the two shown figures differ), so a refusal printed in shown
 * figures can never read "holds only 14.843 kg, so 14.843 kg cannot be issued".
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

/** A quantity moved onto its own 6-dp grid point — the value every floor
 *  decides on. Feed THIS (never the raw stored double) to a display rounding,
 *  so float dust (3.1504999999999996 for 3.1505) cannot move a printed figure.
 *  The identity on any figure already on the grid. */
export function onGrid(n: number): number {
  return qtyGrid(n) / GRID_SCALE;
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
  /** The ask was on (or past) the balance's grid point — or was the balance's
   *  shown figure — so the write takes the balance itself and lands on exactly 0. */
  takesAll: boolean;
  /** shownAs(available), or null when the caller passed no converter. The
   *  figure the operator was shown for the balance; print THIS as the cap. */
  shownAvailable: number | null;
  /** shownAs(ask), or null when the caller passed no converter. */
  shownAsk: number | null;
  /** The ask IS the balance's shown figure (see "THE SHOWN FIGURE IS THE
   *  BALANCE"), so it fits and takes all of it — whether or not the grid alone
   *  would also have accepted it. Always false without a converter. */
  byShownFigure: boolean;
  /** `debit` and `ask` are the same quantity on the house grid, so a caller that
   *  records the ask records the truth. FALSE only when the shown-figure rule
   *  took the balance and it differs from the ask by at least one grid step —
   *  then the caller MUST record `debit`, never the ask. */
  debitIsAsk: boolean;
}

/** A display converter: a RECIPE quantity ↦ the figure the operator is shown
 *  for it. Supplied by the caller (this file converts nothing).
 *
 *  `step`, optional: ONE STEP OF THE SHOWN FIGURE — the smallest non-zero
 *  figure it can print (0.001 of the purchase unit for the desks'
 *  toPurchaseQty) — stated in the SAME units the converter takes. The caller
 *  that builds the converter knows its precision; this file still converts
 *  nothing. Only issuedCoversAsk reads it (THE RULE's shelf arm: "below one
 *  printed step"); planCentralDebit ignores it, so attaching one changes no
 *  debit. Attach with shownWithStep. */
export type ShownAs = ((recipeQty: number) => number) & {
  readonly step?: number;
  /** Other renderings of the SAME balance a screen may still print (round 8):
   *  planCentralDebit's shown-figure match accepts an ask equal to any of them
   *  too, so a screen that has not moved to the converter's own figure is never
   *  refused for typing what it showed. Never printed. */
  readonly alts?: ReadonlyArray<(recipeQty: number) => number>;
};

/** A converter carrying its printed step (see ShownAs), and optionally the
 *  other renderings of a balance its match should also accept (`alts`). */
export function shownWithStep(
  fn: (q: number) => number, step: number, alts?: ReadonlyArray<(q: number) => number>,
): ShownAs {
  return Object.assign(fn, { step: Number(step) || 0, ...(alts && alts.length ? { alts } : {}) });
}

/**
 * DOES THIS DEBIT FIT, AND WHAT EXACTLY DO WE SUBTRACT?
 *
 * Pure: the caller reads `stock` from raw_materials INSIDE its transaction,
 * immediately before the UPDATE (a balance read earlier races), and passes the
 * figure it is about to subtract as `ask` — in RECIPE units, already converted
 * with packFactor where needed. This function converts nothing.
 *
 * `shownAs`, optional: the converter the operator READ the balance through (see
 * "THE SHOWN FIGURE IS THE BALANCE" above). Pass it only on a floor whose
 * operator typed from that figure; without it the grid rule stands alone.
 */
export function planCentralDebit(stock: number, ask: number, shownAs?: ShownAs | null): CentralDebitPlan {
  const s = Number(stock) || 0;
  const a = Number(ask) || 0;
  const available = s > 0 ? s : 0;
  const shown = typeof shownAs === 'function' ? shownAs : null;
  // SNAPPED TO THE GRID BEFORE THE DISPLAY ROUNDING (round 8). Both shown
  // figures are taken of the quantity's 6-dp grid point, never of the raw
  // double: float dust left by an earlier SQL debit must not move a printed
  // figure. MEASURED (WHITE DAL, kg/kg): 5.0005 kg approved 5.001, 1.85 issued
  // leaves 3.1504999999999996 stored; rounded raw to 3 dp that is 3.15, so the
  // desk's own exact outstanding 3.151 was refused "holds only 3.15 kg" over a
  // shelf that IS 3.1505 kg on the grid (shown 3.151). The grid point is the
  // quantity every floor decides on (qtyGrid), so the figure printed for it now
  // follows the decision instead of the dust. The desks' converter is
  // pack-units.ts shownPurchaseQty, which snaps to the grid itself and then
  // rounds in integer arithmetic (the division by the pack can move a figure
  // too: FRESH CREAM 130,125.5 ml rounded raw is 130.125 BTL) — and the desks'
  // "In store" column (U.stockPU on store-requisitions/page.tsx and
  // requisitions/page.tsx) must print that same function. A converter whose
  // input is already on the grid (every 6-dp ask) sees the identical number.
  const shownAvailable = shown ? (Number(shown(onGrid(available))) || 0) : null;
  if (!(a > 0)) {
    // Not a debit — a credit or nothing. Not this rule's business; callers handle
    // credits on their own rails (see clampCentralDelta for why a credit is never
    // touched).
    return {
      stock: s, available, ask: 0, fits: true, debit: 0, short: 0, takesAll: false,
      shownAvailable, shownAsk: shown ? 0 : null, byShownFigure: false, debitIsAsk: true,
    };
  }
  const gAsk = qtyGrid(a);
  const gAvail = qtyGrid(available);
  const shownAsk = shown ? (Number(shown(onGrid(a))) || 0) : null;
  // THE SHOWN-FIGURE RULE, the only place it is written. `> 0` so a balance the
  // operator was shown as nothing is never "matched" by an ask that also shows
  // as nothing — the rule adds fits only where there is stock to take.
  //
  // The grid-point figure above is the one this file PRINTS (the cap, the
  // sentence). The match also accepts the converter's `alts` — the other
  // renderings of the same balance a screen may still print (for the desks,
  // the raw toPurchaseQty figure of round 7), each of the raw balance and of
  // its grid point — so the snap only ADDS fits and never refuses an ask round
  // 7 accepted. Every one of them is within half a printed step (and a float
  // ulp) of the balance, so each means "all of it", and each takes exactly the
  // balance: 4.0005000000000002 kg prints 4.001 raw and 4.001 on its grid point
  // here, while toPurchaseQty of the grid point alone would print 4.
  const renderings: number[] = [];
  if (shown && shownAvailable !== null) {
    renderings.push(shownAvailable, Number(shown(available)) || 0);
    for (const alt of shown.alts || []) {
      renderings.push(Number(alt(available)) || 0, Number(alt(onGrid(available))) || 0);
    }
  }
  const byShownFigure = shownAsk !== null && renderings.some(v => v > 0 && v === shownAsk);
  const fits = gAsk <= gAvail || byShownFigure;
  // On the balance's own grid point or past it ⇒ take the balance itself, which
  // lands on exactly 0 (fits) or is the clamp (does not fit). Below it ⇒ the ask
  // is strictly less than the balance (Math.round is monotonic), so the landing
  // is strictly positive — UNLESS the ask is the balance's shown figure, which
  // means "all of it" from below too (14.842 typed against 14,842.4 g shown as
  // 14.842 kg takes the 0.4 g with it instead of leaving a crumb that shows 0).
  const takesAll = gAsk >= gAvail || byShownFigure;
  const debit = takesAll ? available : a;
  return {
    stock: s, available, ask: a, fits, debit, takesAll,
    // Counted in GRID STEPS, the unit the decision was taken in, so a refusal is
    // never reported as "short 0": 100 asked of 99.999999 is one step over, and
    // floor6(100 − 99.999999) would print 0.000000 (the float difference is
    // 9.99999997e-7). Measured with the unit check in this round.
    short: fits ? 0 : (gAsk - gAvail) / GRID_SCALE,
    shownAvailable, shownAsk, byShownFigure,
    debitIsAsk: qtyGrid(debit) === gAsk,
  };
}

/**
 * THE RULE — IS THIS REQUISITION LINE COMPLETE? (round 8)
 *
 * Decided HERE, once. Every place that asks "is this line done?" — store-issue's
 * defer rule and auto-advance, store-process's final status, the list's
 * lines_owing, the defer-due alert, the Issue Log and both desks — asks this
 * function (the server through issue-stock.ts lineIssueComplete, which feeds it
 * a stored line; the two desks by transcription, because this file imports the
 * database and a page cannot).
 *
 *     COMPLETE  ⇔  issued ≥ approved                       (within 1e-9)
 *               ∨  ( THIS gesture's shelf-rule take emptied the central shelf
 *                    for the material
 *                    ∧  0 < issued
 *                    ∧  approved − issued < ONE printed step )
 *
 * A remainder below one step over a shelf that STILL HOLDS STOCK is NOT
 * complete — it is an ordinary partial issue, and the desk can serve it.
 *
 * ── WHY ROUNDS 6-7 KEPT LEAVING REQUISITIONS WITH NOTHING TO PRESS ──────────
 * "Is this line complete?" was decided in several places by different rules,
 * and every stuck requisition came from two of them disagreeing. Round 7 had
 * three arms here; its second (the issued and approved figures SHOW as the same
 * number) and third (anything owing less than one printed step) closed lines
 * whether or not the shelf had been emptied, and the routes decided status
 * BEFORE the party transfer took its share. MEASURED on the real routes and the
 * real store page (round-7 verifier, r7v-nsl2):
 *   · split-shelf4 — approved 14.843 kg over 14,842.4 g (shown 14.842); the
 *     desk's own "Issue part, defer rest" took the whole shelf (14.8424 kg
 *     recorded), the third arm closed the line, and the defer in the SAME POST
 *     was written anyway: the auto-advance needs `complete && !deferred_until`,
 *     so the requisition sat 'store_processed' with Outstanding 0 and only
 *     [history, undo] to press — for good, even after a restock. WHOLE DHANIYA
 *     (kg/kg, 3.2174 shelf, 3.218 approved) the same.
 *   · pmgmt-party — a party line processed at 14.842 of 14.843: store-process
 *     decided 'store_processed' from the typed figure, THEN the party transfer
 *     took the whole 14,842.4 g and the line became complete, and nobody looked
 *     again. Nothing to press.
 *   · bigpack — MALA MANGO CRUSH 5 LTR approved 1,004 ml (0.2008 BTL), 0.2 BTL
 *     issued with 49 L still on the shelf: the third arm called a deliberate
 *     partial "Fulfilled" while the store could serve the 4 ml.
 *
 * ── THE SECOND ARM NEEDS A MEMORY, AND THE LINE CARRIES IT ──────────────────
 * "This gesture's take emptied the shelf" is a fact about the gesture, not about
 * the line's numbers — 14.8424 kg recorded of 14.843 reads the same whether the
 * take emptied a 14,842.4 g shelf or someone typed 14.8424 over 20 kg. So the
 * writer that took (issue-stock.ts applyIssueDelta for the internal rail, the
 * two party rails after their own debit) decides it AT THE TAKE, from the
 * balance it just wrote, and when THIS rule closes the line by that arm it
 * stamps requisition_items.shelf_emptied_qty = the quantity_issued it closed at.
 * Every later reader — the auto-advance re-scores every line on every gesture,
 * long after a delivery has restocked the shelf — passes `shelfEmptied` as
 * shelfMarkHolds(mark, issued): the mark speaks only for the exact quantity it
 * was written at, so any later write of quantity_issued (an undo, a reject that
 * zeroes, a re-process, a correction) retires it without having to know it
 * exists. Without the memory a line closed by the shelf would re-open the day a
 * delivery arrived, which is the stuck requisition in a new shape.
 *
 * ── WHAT EACH PIECE IS FOR ────────────────────────────────────────────────────
 *   · `issued ≥ approved within 1e-9`: the predicate every desk always used,
 *     widened by one float ulp-ish slack so 14.669999999999998 of 14.67 (a sum of
 *     two typed figures) is done. Nothing that was complete stops being complete.
 *   · `0 < issued`: a line nothing left the shelf for never closes by the shelf.
 *   · ONE PRINTED STEP is 0.001 of the purchase unit (1 g of a kg line, 0.75 ml
 *     of a 750 ml bottle, 5 ml of a 5 L can), supplied by the line's converter as
 *     `shownAs.step` in the LINE's units, compared on the house grid (qtyGrid) so
 *     float noise cannot move it. A remainder of a whole step or more — a figure
 *     the desk prints and a restocked store can issue — is never closed here.
 *
 * WHAT IT CANNOT DO: close a line the store can still serve. The shelf arm needs
 * the take to have left the material holding nothing (holdsAny false), so a
 * remainder below a step over stock is an ordinary open line with Issue Now,
 * Defer and Reject.
 *
 * Pure; reads nothing. `shownAs` without a step, or no `shelfEmptied`, leaves
 * the first arm alone.
 */
export function issuedCoversAsk(
  issued: number, wanted: number, shownAs?: ShownAs | null, shelfEmptied?: boolean,
): boolean {
  const i = Number(issued) || 0;
  const w = Number(wanted) || 0;
  if (i + CLAMP_EPS >= w) return true;
  if (shelfEmptied !== true) return false;
  const step = typeof shownAs === 'function' ? (Number(shownAs.step) || 0) : 0;
  return step > 0 && qtyGrid(i) > 0 && qtyGrid(w - i) < qtyGrid(step);
}

/**
 * DOES A LINE'S SHELF MARK STILL SPEAK FOR IT? — the persisted half of THE
 * RULE's second arm (see "THE SECOND ARM NEEDS A MEMORY" above).
 *
 * `mark` is requisition_items.shelf_emptied_qty; `issued` the line's
 * quantity_issued now. True only when the mark was written at exactly this
 * quantity (within 1e-9 line units — the two are the same double, written by
 * the same transaction), so a later write of quantity_issued by ANY writer
 * retires it. NULL, 0 or a stale figure ⇒ false.
 */
export function shelfMarkHolds(mark: number | null | undefined, issued: number): boolean {
  if (mark == null) return false;
  const m = Number(mark);
  if (!Number.isFinite(m) || !(m > 0)) return false;
  return Math.abs(m - (Number(issued) || 0)) <= CLAMP_EPS;
}

/**
 * DOES THE CENTRAL STORE HOLD ANY OF IT? — the ONE test every floor uses to
 * choose between "holds only X" and "holds none of it".
 *
 * At least one grid step, by the same qtyGrid every comparison above uses. A
 * balance below that (the 7.1e-15 kg float dust two live materials carry) is
 * zero to every floor: no ask of one step or more fits it, so "holds none" is
 * the truth at every precision the app can print or weigh. A balance AT or
 * above one step is never called "none", however small — the round-6 defect
 * was a floor printing "holds none of it" over a 0.5 g balance because its
 * display figure rounded to 0. A refusal over a sub-display balance must name
 * the balance (printableCap below), not deny it.
 */
export function holdsAny(available: number): boolean {
  const x = Number(available) || 0;
  return x > 0 && qtyGrid(x) > 0;
}

/**
 * The cap to PRINT at `dp` decimals: qtyDown(available, dp) — never more than the
 * floor accepts — except that it NEVER PRINTS 0 WHILE holdsAny(available). When
 * `dp` would round a real balance to nothing it falls back to the house grid
 * (6 dp), which qtyDown leaves on the balance's own grid point, so the figure
 * still fits when typed back. Print `value` at `dp` (fmtGridQty prints 6 dp).
 */
export function printableCap(available: number, dp: number): { value: number; dp: number } {
  const x = Math.max(0, Number(available) || 0);
  const v = qtyDown(x, dp);
  if (v > 0 || !holdsAny(x)) return { value: v, dp };
  return { value: qtyDown(x, 6), dp: 6 };
}

/** A quantity at the house grid's 6 dp, trailing zeros dropped, never in
 *  exponent notation (String(1e-6) is "0.000001"; anything that holdsAny is at
 *  least that). For the sub-display figures printableCap can return.
 *
 *  SNAPPED THROUGH qtyGrid, NOT toFixed (round 7). toFixed rounds the double's
 *  exact binary value, Math.round rounds the product — and at a half-grid tie
 *  they disagree: 5e-7 is stored as 4.99999…e-7, so (5e-7).toFixed(6) is
 *  "0.000000" while qtyGrid(5e-7) is 1 and holdsAny(5e-7) is true. Printed
 *  through toFixed, a floor read "holds only 0 g" over a balance it had just
 *  said was there (measured on /api/butchering). Printing the grid point the
 *  decision was taken on cannot disagree with the decision. On any figure
 *  already on the grid (every qtyDown / printableCap result) the string is
 *  identical to the old one. */
export function fmtGridQty(n: number): string {
  return String(qtyGrid(n) / GRID_SCALE);
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
 * DUST IS A DEBIT TOO. A debit of CLAMP_EPS or less is written as asked when
 * the shelf covers it and as what the shelf holds when it does not — never
 * below zero, never clamped, never reported. See the branch below.
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

  // Credits (and nothing at all) pass through untouched.
  if (wantedDelta >= 0) return base;

  // THE ONE RULE (planCentralDebit, above). `debit` is never more than
  // max(0, balance), so the write can never go below zero; when the debit is
  // "everything on the shelf" — on the balance's grid point or past it — it is
  // the balance itself and the landing is exactly 0.
  const plan = planCentralDebit(base.stockRecipe, -wantedDelta);

  // DUST IS STILL A DEBIT (round 10, never-negative). A debit of CLAMP_EPS or
  // less used to return `base` above with the credits, i.e. it was written as
  // asked WITHOUT being weighed — and on a balance below the dust that is a
  // write below zero. MEASURED on the real routes: /api/staff-meals/items with
  // 0.000000001 typed on the real /staff-meals page over a shelf the floor had
  // just emptied landed at -1e-9 (and -5e-10, -4e-10 over 0 and 1e-10); a dated
  // /api/admin/reset whose in-range purchase rows net to 2.78e-17 (0.1 + 0.2 −
  // 0.3) landed at -2.78e-17. Production 62aa895 does the same — it has no
  // floor on either path.
  // Dust is written AS ASKED wherever the shelf covers it (byte-identical to
  // production and to round 9 on every balance at least as large as the dust,
  // which is every balance the app can print), and never as more than
  // planCentralDebit's `debit`, which is at most max(0, balance) — so it can no longer land below
  // zero or dig an existing hole deeper. It always fits on the grid, so it is
  // never `clamped` and never reported: nothing the operator could see was cut.
  // NOT plan.debit itself: on a sub-grid crumb that is the whole crumb, and
  // taking 4e-7 for a 1e-9 ask would change a write production makes for no
  // floor's sake (/api/sales DELETE skips anything ≤ 1e-9 and would start
  // writing it).
  if (wantedDelta >= -CLAMP_EPS) {
    const take = Math.min(plan.ask, plan.debit);
    return take === plan.ask ? base : { ...base, deltaToWrite: take > 0 ? -take : 0 };
  }

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
