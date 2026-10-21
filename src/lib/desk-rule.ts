/**
 * THE RULE, AS THE TWO ISSUE DESKS RUN IT (round 8).
 *
 * "Is this requisition line complete?" and "what will this issue take off the
 * central shelf?" are decided on the SERVER, once:
 *   · src/lib/central-debit-clamp.ts — issuedCoversAsk (THE RULE),
 *     shelfMarkHolds, planCentralDebit (the shown-figure rule), qtyGrid/onGrid;
 *   · src/lib/issue-stock.ts — lineFactor, lineShownAs (the line's converter and
 *     its printed step), lineIssueComplete (THE RULE read from a stored line),
 *     checkCentralIssue (what an issue records when the shelf rule takes a
 *     balance that is not the ask), applyIssueDelta (the take, and the shelf
 *     mark it stamps).
 * Both of those files import the database, so a page cannot bundle them. This
 * file is the desks' ONE transcription of them: it imports only pack-units
 * (pure), and BOTH desks (store-requisitions/page.tsx, requisitions/page.tsx)
 * import it instead of each keeping its own copy — rounds 6-7 kept a copy per
 * page, and every stuck requisition came from two copies of "is this line
 * done?" disagreeing. scripts/desk-rule-tests.ts runs every function here
 * against the server function it transcribes, on every shape (units, packs,
 * line bases, half steps, float dust, sub-step remainders, shelf marks), and
 * fails on a single disagreement. CHANGE THE SERVER RULE, CHANGE THIS FILE, RUN
 * THAT TEST.
 *
 * The names are deliberately NOT the server's (deskLineComplete, not
 * lineIssueComplete): the same name for two implementations is the rival-helper
 * trap this project has recorded, and a reader must always be able to tell
 * which side of the wire a call is on.
 *
 *     COMPLETE  ⇔  issued + 1e-9 ≥ approved
 *               ∨  ( shelfMarkHolds(line.shelf_emptied_qty, issued)
 *                    ∧ step > 0 ∧ grid(issued) > 0
 *                    ∧ grid(approved − issued) < grid(step) )
 *
 * The shelf mark is written by the server AT THE TAKE (issue-stock.ts
 * stampShelfClose) and reaches the desks on the line (`ri.*`). A desk never
 * infers it: 14.8424 kg recorded of 14.843 reads the same whether the take
 * emptied a 14,842.4 g shelf or someone typed 14.8424 over 20 kg, and only the
 * first is complete. A remainder below one step over a shelf that still holds
 * stock is an ordinary partial, with Issue Now, Defer and Reject.
 *
 * FORECASTS ARE COURTESIES. forecastDeskTake says before the click what the
 * server's take will record; it decides nothing, disables nothing and changes
 * no POST. A liquor / store-mapped material is never floored by the server
 * (store-engine.ts centralFlowBlock); since round 8b the ?id= payload says
 * which lines those are (central_flow_blocked) and every forecast here says
 * nothing about them. A payload without the flag reads every line as floored,
 * the round-8 blind spot.
 */
import { packFactor, shownPurchaseQty, toPurchaseQty, type PackMeta } from './pack-units';

/** central-debit-clamp.ts CLAMP_EPS: the slack on "issued ≥ approved", and
 *  shelfMarkHolds' tolerance. */
export const DESK_RULE_EPS = 1e-9;

/** central-debit-clamp.ts qtyGrid: a RECIPE (or line) quantity as an integer
 *  count of 6-dp steps, -0 normalised. */
export function deskGrid(n: number): number {
  const v = Math.round((Number(n) || 0) * 1e6);
  return v === 0 ? 0 : v;
}

/** central-debit-clamp.ts onGrid: the quantity moved onto its 6-dp grid point. */
export function deskOnGrid(n: number): number {
  return deskGrid(n) / 1e6;
}

/** central-debit-clamp.ts shelfMarkHolds, verbatim: the line's shelf mark
 *  (requisition_items.shelf_emptied_qty) speaks only for the exact quantity it
 *  was stamped at. NULL, 0, non-finite or a stale figure ⇒ false. */
export function deskShelfMarkHolds(mark: number | null | undefined, issued: number): boolean {
  if (mark == null) return false;
  const m = Number(mark);
  if (!Number.isFinite(m) || !(m > 0)) return false;
  return Math.abs(m - (Number(issued) || 0)) <= DESK_RULE_EPS;
}

/** central-debit-clamp.ts issuedCoversAsk, verbatim, with the converter's step
 *  passed as a number (0 / NaN = no converter: the first arm alone). */
export function deskCovers(issued: number, approved: number, step: number, shelfEmptied: boolean): boolean {
  const i = Number(issued) || 0;
  const w = Number(approved) || 0;
  if (i + DESK_RULE_EPS >= w) return true;
  if (shelfEmptied !== true) return false;
  const s = Number(step) || 0;
  return s > 0 && deskGrid(i) > 0 && deskGrid(w - i) < deskGrid(s);
}

/** The unit fields a desk line carries (api/requisitions ?id= detail SELECT). */
export interface DeskLineUnits {
  /** requisition_items.unit — the LINE's own unit (option B). */
  unit?: string | null;
  /** rm.unit AS material_unit — the recipe unit. */
  material_unit?: string | null;
  /** COALESCE(NULLIF(TRIM(rm.purchase_unit), ''), rm.unit). */
  material_purchase_unit?: string | null;
  /** COALESCE(rm.pack_size, 1). */
  material_pack_size?: number | null;
  /** 1 for a liquor / store-mapped material (api/requisitions ?id=, round 8b
   *  — store-engine.ts centralFlowBlock): the central floor never applies to
   *  it, so there is no central take to forecast. */
  central_flow_blocked?: number | boolean | null;
}

export interface DeskLineBasis {
  /** The material's pack meta, exactly as the server builds it. */
  meta: PackMeta;
  /** packFactor(meta): recipe units per purchase unit. */
  pf: number;
  /** issue-stock.ts lineFactor: recipe units per LINE unit. */
  factor: number;
  /** ONE printed step (0.001 purchase unit) in the LINE's units — the step
   *  issue-stock.ts lineShownAs carries: 0.001 × pf ÷ factor. */
  step: number;
}

/**
 * issue-stock.ts lineFactor + lineShownAs's step, for a desk line. null exactly
 * where lineFactor says needsReview (a blank or unrecognised unit on a packed
 * material): nobody can say what such a line shows, and only the exact
 * comparison applies — as on the server, whose lineShownAs is null there.
 */
export function deskLineBasis(l: DeskLineUnits): DeskLineBasis | null {
  const meta: PackMeta = {
    unit: l.material_unit ?? '',
    purchase_unit: l.material_purchase_unit,
    pack_size: l.material_pack_size,
  };
  const pf = packFactor(meta);
  let factor = 1;
  if (pf > 1) {
    const lu = String(l.unit ?? '').toLowerCase().trim();
    const pu = String(l.material_purchase_unit ?? '').toLowerCase().trim();
    const ru = String(l.material_unit ?? '').toLowerCase().trim();
    if (lu === '') return null;
    if (lu === pu) factor = pf;
    else if (lu === ru) factor = 1;
    else return null;
  }
  return { meta, pf, factor, step: (0.001 * pf) / factor };
}

/**
 * THE RULE for a desk line — issue-stock.ts lineIssueComplete. `approved` is
 * passed by the caller (each desk keeps its own effectiveQty: the store desk
 * reads a chef-rejected line as 0); `issued` is quantity_issued; the line
 * carries its units and its shelf mark.
 */
export function deskLineComplete(
  issued: number, approved: number,
  l: DeskLineUnits & { shelf_emptied_qty?: number | null },
): boolean {
  const got = Number(issued) || 0;
  const step = deskLineBasis(l)?.step ?? 0;
  return deskCovers(got, approved, step, deskShelfMarkHolds(l.shelf_emptied_qty, got));
}

/** The figure both desks print for a central balance ("In store" / "In Stock",
 *  U.stockPU): pack-units.ts shownPurchaseQty — the 6-dp grid point, then
 *  integer half-up — the same function the server's shown-figure rule prints. */
export function deskStockPU(recipeQty: number, meta: PackMeta): number {
  return shownPurchaseQty(recipeQty, meta);
}

export interface DeskDebitPlan {
  /** max(0, stock). */
  available: number;
  fits: boolean;
  /** The take is the balance itself (lands on exactly 0). */
  takesAll: boolean;
  /** What the floor subtracts. */
  debit: number;
  /** The ask is the balance's shown figure. */
  byShownFigure: boolean;
  /** debit and ask are the same quantity on the grid. */
  debitIsAsk: boolean;
  /** shownPurchaseQty of the balance's grid point (the printed cap). */
  shownAvailable: number;
}

/**
 * central-debit-clamp.ts planCentralDebit with the converter issue-stock.ts
 * checkCentralIssue hands it: shownPurchaseQty (printed), plus the `alts`
 * toPurchaseQty of the raw balance and of its grid point (still matched, so a
 * screen printing round 7's figure is never refused). RECIPE units in.
 */
export function planDeskDebit(stock: number, ask: number, meta: PackMeta): DeskDebitPlan {
  const s = Number(stock) || 0;
  const a = Number(ask) || 0;
  const available = s > 0 ? s : 0;
  const shownAvailable = Number(shownPurchaseQty(deskOnGrid(available), meta)) || 0;
  if (!(a > 0)) {
    return { available, fits: true, takesAll: false, debit: 0, byShownFigure: false, debitIsAsk: true, shownAvailable };
  }
  const gAsk = deskGrid(a);
  const gAvail = deskGrid(available);
  const shownAsk = Number(shownPurchaseQty(deskOnGrid(a), meta)) || 0;
  const renderings = [
    shownAvailable,
    Number(shownPurchaseQty(available, meta)) || 0,
    Number(toPurchaseQty(available, meta)) || 0,
    Number(toPurchaseQty(deskOnGrid(available), meta)) || 0,
  ];
  const byShownFigure = renderings.some(v => v > 0 && v === shownAsk);
  const fits = gAsk <= gAvail || byShownFigure;
  const takesAll = gAsk >= gAvail || byShownFigure;
  const debit = takesAll ? available : a;
  return { available, fits, takesAll, debit, byShownFigure, debitIsAsk: deskGrid(debit) === gAsk, shownAvailable };
}

export interface DeskTakeForecast {
  plan: DeskDebitPlan;
  basis: DeskLineBasis;
  /** RECIPE units the gesture asks of the shelf (6-dp, as checkCentralIssue). */
  askRecipe: number;
  /** quantity_issued after the gesture, as the server will RECORD it:
   *  before + debit ÷ factor when the shelf rule took a balance that is not the
   *  ask (checkCentralIssue recordAfterLineQty), else before + typed. */
  recordedLine: number;
  /** What this gesture adds to the line, in LINE units (recordedLine − before). */
  addedLine: number;
  /** RECIPE units that leave the shelf (the debit). */
  takeRecipe: number;
  /** The take differs from the typed figure by a grid step or more. */
  changed: boolean;
  /** The take leaves the material holding nothing (applyIssueDelta → stampShelfClose's `emptied`). */
  emptied: boolean;
  /** THE RULE after the take. */
  complete: boolean;
  /** Complete ONLY by the shelf arm (issued < approved). */
  byShelf: boolean;
  /** Still owed after the gesture, LINE units (0 when complete). */
  owingLine: number;
  /** 'party' when this is the party TRANSFER's take (forecastDeskPartyTransfer):
   *  it moves the line's WHOLE quantity once, not the gesture's increment, so a
   *  screen says "the party transfer moves …" rather than "Issue Now takes …".
   *  Absent on the internal rail. */
  rail?: 'party';
  /** Party rail only: the whole quantity the transfer asks for the line (LINE
   *  units) — quantity_issued after the gesture, before the shelf rule. */
  totalLine?: number;
  /** Party rail only (round 9): the part of the line an earlier transfer
   *  already moved (LINE units, 0 on a first transfer). The take is what the
   *  line holds above it, so a screen says "the line's remaining …". */
  movedLine?: number;
}

/**
 * WHAT WILL THIS ISSUE TAKE, RECORD AND LEAVE? — the internal rail of
 * /store-issue and /store-process (checkCentralIssue → applyIssueDelta →
 * stampShelfClose → lineIssueComplete), asked before the click.
 *
 * null for every carve-out the server does not floor (a PARTY requisition — the
 * internal rail moves no central stock for it; an unknown balance; a line whose
 * unit cannot be resolved; a zero or credit delta) and for a line the floor
 * would HOLD (it does not fit — the hold forecasts say that). `claimedRecipe` is
 * what earlier lines of the SAME gesture take from the same material.
 */
export function forecastDeskTake(a: {
  line: DeskLineUnits & { quantity_issued?: number | null; current_stock?: number | null };
  purpose?: string | null;
  approved: number;
  /** The figure the gesture POSTs for this line, in its own unit (a delta). */
  deltaLine: number;
  claimedRecipe?: number;
}): DeskTakeForecast | null {
  if (String(a.purpose || '') === 'party') return null;
  // A liquor / store-mapped line: checkCentralIssue's 'store_mapped' carve-out.
  if (Number(a.line.central_flow_blocked || 0)) return null;
  const raw = a.line.current_stock;
  if (raw == null || !Number.isFinite(Number(raw))) return null;
  const basis = deskLineBasis(a.line);
  if (!basis) return null;
  const q = Number(a.deltaLine);
  if (!Number.isFinite(q) || q <= 0) return null;
  const before = Number(a.line.quantity_issued) || 0;
  const after = before + q;
  const askRecipe = Math.round((after - before) * basis.factor * 1e6) / 1e6;
  if (askRecipe <= DESK_RULE_EPS) return null;
  const plan = planDeskDebit((Number(raw) || 0) - (Number(a.claimedRecipe) || 0), askRecipe, basis.meta);
  if (!plan.fits) return null;
  const changed = !plan.debitIsAsk;
  const recordedLine = changed ? before + plan.debit / (basis.factor || 1) : after;
  const left = plan.available - plan.debit;
  const emptied = plan.debit > 0 && !(left > 0 && deskGrid(left) > 0);
  const inFull = deskCovers(recordedLine, a.approved, basis.step, false);
  const complete = inFull || deskCovers(recordedLine, a.approved, basis.step, emptied);
  return {
    plan, basis, askRecipe, recordedLine,
    addedLine: recordedLine - before,
    takeRecipe: plan.debit,
    changed, emptied, complete,
    byShelf: complete && !inFull,
    owingLine: complete ? 0 : Math.max(0, (Number(a.approved) || 0) - recordedLine),
  };
}

/* ── THE PARTY RAIL: THE TRANSFER IS THE TAKE (round 8b) ────────────────────
   On a PARTY requisition an issue moves no central stock (the internal rail's
   party carve-out). The take is the store → department TRANSFER
   (party-fulfillment.ts applyPartyFulfillment): it moves each line's WHOLE
   quantity_issued once, from 0, line by line in the requisition's order, under
   the same shown-figure rule (checkCentralIssue rail 'party' → the debit →
   recordPartyShelfTake → stampShelfClose). It is all-or-nothing: one line the
   shelf cannot cover throws, and the whole gesture is refused.
   ROUND 9 — A LATER RUN IS A TOP-UP. A short /store-process submit moves part
   of a line; the next run moves only what each line holds above what already
   moved for its material (`party_moved_recipe`, the transfer's own party rows
   summed per material), from that figure rather than from 0. A line with
   nothing above it is skipped. Everything else here is unchanged.

   WHEN IT RUNS ON /store-issue — the route's two branches, transcribed:
     · 'certain' — every line reads complete by THE RULE after the gesture's
       issue entries (and none is deferred): the transfer MUST run, and a line
       it cannot move refuses the WHOLE POST, every other line included;
     · 'closes'  — not every line is complete yet, but the transfer, tried
       inside a savepoint, takes the shelf and THE RULE then closes every line
       (a defer on a line this gesture touched and the transfer completed is
       dropped): the route keeps it and the requisition is fulfilled. Without
       this a party line over a short shelf could never close on this desk —
       the transfer waited for a completeness only the transfer could give;
     · 'none'    — anything else (the savepoint is unwound): no stock moves and
       nothing is refused.
   /store-process runs the transfer on every submit that raises no PO, drops
   no purchase line on a line still owed and holds no line — 'certain' there
   whenever the PO box is unticked (requisitions/page.tsx asks with `always`).

   A COURTESY, like every forecast in this file: the balance is the one the
   page loaded. A liquor / store-mapped line (never floored) is declined by the
   transfer, as the server declines it, once the payload says which it is
   (central_flow_blocked). */

/** A requisition line as the party forecast reads it — the desks' payload. */
export interface DeskPartyLine extends DeskLineUnits {
  id: string;
  material_id?: string | null;
  quantity_issued?: number | null;
  current_stock?: number | null;
  shelf_emptied_qty?: number | null;
  deferred_until?: string | null;
  /** RECIPE units the party transfer already moved for this line's MATERIAL
   *  on this requisition (api/requisitions ?id= `party_moved_recipe`, round 9).
   *  A later run moves only what the line holds above it. */
  party_moved_recipe?: number | null;
}

/** A line the transfer cannot move (the floor would throw on it). */
export interface DeskPartyShort {
  id: string;
  /** The whole quantity the transfer asks for the line, LINE units. */
  totalLine: number;
  /** What an earlier transfer already moved for the line (round 9), LINE
   *  units — the transfer asks totalLine − movedLine of the shelf. */
  movedLine: number;
  /** The server's cap on the line's TOTAL — checkCentralIssue maxIssueLineQty
   *  with beforeLineQty 0: the shown figure of what is left for this line (after
   *  earlier lines of the same material), LINE units; a crumb's grid point. */
  capTotalLine: number;
  /** What is left for this line, exactly, in LINE units (the raw balance less
   *  earlier lines' takes, ÷ the line factor) — what the transfer would take
   *  and record were the line lowered to take everything. */
  exactLeftLine: number;
  /** availablePurchase — the shown figure of what is left (purchase units). */
  availPU: number;
  /** holdsAny() is false for what is left. */
  empty: boolean;
}

export interface DeskPartyForecast {
  runs: 'certain' | 'closes' | 'none';
  /** The transfer's take per line it moves (runs !== 'none'). */
  takes: Record<string, DeskTakeForecast>;
  /** Lines it cannot move (runs === 'certain' only): the WHOLE gesture is
   *  refused when this is not empty. */
  short: DeskPartyShort[];
  /** A line's balance or unit is unknown to the page: nothing is claimed. */
  unknown: boolean;
}

/**
 * WHAT WILL THE PARTY TRANSFER DO ON THIS GESTURE? — /store-issue's party
 * branches (and, with `always`, /store-process's), asked before the click.
 * `lines` is every line of the requisition in the order the transfer walks
 * them; `after` the quantity_issued each line will hold once the gesture's
 * issue entries have run (absent = untouched); `deferIds` the lines the
 * gesture writes a defer on.
 */
export function forecastDeskPartyTransfer(a: {
  lines: DeskPartyLine[];
  approvedOf: (l: DeskPartyLine) => number;
  /** Chef- or store-rejected: complete for the status, moved only if it still
   *  carries a quantity (the transfer has no rejection filter). */
  rejectedOf: (l: DeskPartyLine) => boolean;
  after: Map<string, number>;
  deferIds?: Set<string>;
  /** The transfer already ran on this requisition. Since round 9 it is NOT
   *  one-shot: a later run moves what each line holds above what already moved
   *  (`party_moved_recipe` on the lines). Kept for a caller whose payload
   *  carries no such figure: then nothing can be forecast, as before. */
  transferred?: boolean;
  /** /store-process: it runs on this submit whatever the lines read. */
  always?: boolean;
}): DeskPartyForecast {
  const none: DeskPartyForecast = { runs: 'none', takes: {}, short: [], unknown: false };
  if (a.transferred && !a.lines.some(l => l.party_moved_recipe != null)) return none;
  const deferIds = a.deferIds || new Set<string>();
  // THE LINES AS THE GESTURE'S ENTRIES LEAVE THEM, before the transfer. An
  // issue on a party line moves nothing and clears its shelf mark
  // (applyIssueDelta → stampShelfClose with nothing emptied), so only the
  // first arm can complete it; a defer survives an issue that does not.
  const pre = a.lines.map(l => {
    const approved = Number(a.approvedOf(l)) || 0;
    const touched = a.after.has(l.id) || deferIds.has(l.id);
    const qty = a.after.has(l.id) ? (Number(a.after.get(l.id)) || 0) : (Number(l.quantity_issued) || 0);
    const complete = a.after.has(l.id)
      ? qty + DESK_RULE_EPS >= approved
      : deskLineComplete(qty, approved, l);
    const deferred = !complete && (!!l.deferred_until || deferIds.has(l.id));
    return { l, approved, touched, qty, complete, deferred, rejected: !!a.rejectedOf(l) };
  });
  const certain = a.always || pre.every(p => p.rejected || (p.complete && !p.deferred));
  if (!certain) {
    // The route tries the transfer only where it could close every line: each
    // open line carries a quantity, and a deferred one is touched by this
    // gesture (its defer is dropped once the take completes it).
    const could = pre.every(p => p.rejected || (p.complete && !p.deferred)
      || (p.qty > 0 && (!p.deferred || p.touched)));
    if (!could) return none;
  }
  // THE TRANSFER, LINE BY LINE (applyPartyFulfillment's loop).
  const claimed = new Map<string, number>();
  const takes: Record<string, DeskTakeForecast> = {};
  const short: DeskPartyShort[] = [];
  let unknown = false;
  // What already moved, per material, handed to its lines in this walk's
  // order, each line taking at most what it records (round 9 — the
  // transfer's own allocation; 0 everywhere until a transfer has run).
  const movedLeft = new Map<string, number>();
  for (const p of pre) {
    const mat = String(p.l.material_id || '');
    if (!movedLeft.has(mat)) movedLeft.set(mat, Math.max(0, Number(p.l.party_moved_recipe) || 0));
  }
  const anyMoved = [...movedLeft.values()].some(v => v > 0);
  for (const p of pre) {
    if (!(p.qty > 0)) continue;
    const mat = String(p.l.material_id || '');
    // THE TOP-UP: the part already moved, in the line's unit (the floor's
    // beforeLineQty); a line with nothing above it is skipped outright, as
    // the transfer skips it — before any carve-out, so it is not declined.
    let movedLine = 0;
    if (anyMoved) {
      const b = deskLineBasis(p.l);
      const f = b ? b.factor || 1 : 1;
      const pool = movedLeft.get(mat) || 0;
      const lineRecipe = Math.round(p.qty * f * 1e6) / 1e6;
      const movedRecipe = Math.min(pool, lineRecipe);
      movedLeft.set(mat, Math.max(0, pool - movedRecipe));
      if (Math.round((lineRecipe - movedRecipe) * 1e6) <= 0) continue;
      movedLine = movedRecipe / f;
    }
    const basis = deskLineBasis(p.l);
    if (!basis) continue;                       // unit_review: declined, nothing moves
    if (Number(p.l.central_flow_blocked || 0)) continue;   // store_mapped: declined too
    const raw = p.l.current_stock;
    if (raw == null || !Number.isFinite(Number(raw))) { unknown = true; continue; }
    const already = claimed.get(mat) || 0;
    const askRecipe = Math.round((p.qty - movedLine) * basis.factor * 1e6) / 1e6;
    if (askRecipe <= DESK_RULE_EPS) continue;
    const plan = planDeskDebit((Number(raw) || 0) - already, askRecipe, basis.meta);
    if (!plan.fits) {
      const gAvail = deskGrid(plan.available);
      const shownLine = plan.shownAvailable > 0
        ? Math.round((plan.shownAvailable * basis.pf / (basis.factor || 1)) * 1e6) / 1e6 : 0;
      // Caps on the line's TOTAL: what already moved plus what the shelf
      // holds for it now (the server's maxIssueLineQty from beforeLineQty).
      short.push({
        id: p.l.id, totalLine: p.qty, movedLine,
        capTotalLine: shownLine > 0 ? movedLine + shownLine
          : gAvail > 0 ? movedLine + (gAvail / 1e6) / (basis.factor || 1) : movedLine,
        exactLeftLine: gAvail > 0 ? movedLine + plan.available / (basis.factor || 1) : 0,
        availPU: plan.shownAvailable > 0 ? plan.shownAvailable : gAvail > 0 ? (gAvail / 1e6) / basis.pf : 0,
        empty: !(gAvail > 0),
      });
      continue;
    }
    claimed.set(mat, already + plan.debit);
    const changed = !plan.debitIsAsk;
    const recordedLine = changed ? movedLine + plan.debit / (basis.factor || 1) : p.qty;
    const left = plan.available - plan.debit;
    const emptied = plan.debit > 0 && !(left > 0 && deskGrid(left) > 0);
    const inFull = deskCovers(recordedLine, p.approved, basis.step, false);
    const complete = inFull || deskCovers(recordedLine, p.approved, basis.step, emptied);
    const before = Number(p.l.quantity_issued) || 0;
    takes[p.l.id] = {
      plan, basis, askRecipe, recordedLine,
      addedLine: recordedLine - before,
      takeRecipe: plan.debit,
      changed, emptied, complete,
      byShelf: complete && !inFull,
      owingLine: complete ? 0 : Math.max(0, p.approved - recordedLine),
      rail: 'party', totalLine: p.qty, movedLine,
    };
  }
  if (certain) return { runs: 'certain', takes, short, unknown };
  // Tried in a savepoint: a line it cannot move unwinds it, and so does a line
  // still open (or still deferred and not touched) once it has taken.
  if (short.length > 0) return none;
  const closes = pre.every(p => {
    if (p.rejected) return true;
    const tk = takes[p.l.id];
    const done = tk ? tk.complete : p.complete;
    const deferred = p.deferred && !(p.touched && done);
    return done && !deferred;
  });
  return closes ? { runs: 'closes', takes, short: [], unknown } : none;
}

/**
 * THE MOST A STORE-DESK BOX CAN ADD TO A PARTY LINE so the transfer takes it
 * — a DELTA in LINE units on top of quantity_issued (the store desk's box adds
 * to what is issued; the transfer moves the line's whole total). The server's
 * cap is on the TOTAL (`capTotalLine`, its max_issue_qty), so the delta is the
 * cap less what the line already holds; when the line already holds the shown
 * cap (14.842 kg recorded over a 14,842.4 g shelf) the only figure left that
 * takes everything is the shelf's own grid point less that (0.0004 kg), the
 * crumb the store desk prints at full precision. 0 when nothing fits.
 */
export function deskPartyHeadroom(before: number, capTotalLine: number, exactLeftLine: number): number {
  const b = Number(before) || 0;
  const snap = (n: number) => Math.round(n * 1e9) / 1e9;
  const byCap = snap((Number(capTotalLine) || 0) - b);
  if (byCap > DESK_RULE_EPS) return byCap;
  const byShelf = snap((Number(exactLeftLine) || 0) - b);
  return byShelf > DESK_RULE_EPS ? byShelf : 0;
}
