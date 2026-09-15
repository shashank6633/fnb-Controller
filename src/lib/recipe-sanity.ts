import { ingredientLineCost, toPaise, type CostableIngredient } from './recipe-cost';
import { UNIT_REGISTRY, dimensionOf, resolveUnit, type Dimension } from './units';

/**
 * UNIT SANITY — CATCH THE MIX-UP AT ENTRY, NOT IN A REPORT.
 * --------------------------------------------------------
 * The costing engine converts an entered quantity into the material's unit. When
 * that conversion is IMPOSSIBLE — 100 pcs of a material priced per kg, with no
 * pack size to bridge count→weight — convert() returns null and the engine falls
 * back to the raw number. "100 pcs" is then multiplied by a ₹/kg rate as though
 * the cook had written 100 kg.
 *
 * That is not hypothetical. It is the recipe LOOSE PRAWNS on this database:
 *
 *     PRAWNS 80/100   100 pcs   →  valued as 100 kg × ₹630/kg  =  ₹63,000.00
 *     + 11 other ingredients                                   =      ₹12.34
 *     ------------------------------------------------------------------------
 *     stored recipes.total_cost                                =  ₹63,012.34
 *
 * Reproduced against the live data to the paise. GONGURA PRAWNS carries the same
 * line and reports a food cost of 9,561% against its ₹659 menu price.
 *
 * TWO INDEPENDENT SIGNALS, because neither alone is enough:
 *
 *   1. UNCONVERTIBLE (deterministic). The units differ and the system cannot
 *      bridge them, so it is provably not valuing what the cook meant. No
 *      threshold, no guess, no false positives. This is the prawns case.
 *
 *      GRADED, because it is not one fault. A count against a weight (pcs vs
 *      kg) is out by whatever one piece weighs — 1,000× on the prawns — and the
 *      money is noise. A weight against a volume that shares its base (g vs ml)
 *      is valued at exactly the figure units.ts's own density-1 rule produces,
 *      so it is out by density: a few percent. That second case is a NOTE, not
 *      a blocker. It was a blocker, and it struck a red line through ASIAN
 *      GREEN SALAD's ₹333.20 — a figure correct to about 1% — on 22 of the 38
 *      recipes this file flagged. A mark that lands on correct numbers is a
 *      mark the reader learns to skip. The classification is
 *      ConversionMismatch in recipe-cost.ts.
 *
 *   2. IMPLAUSIBLE (proportional). The units converted fine but the magnitude is
 *      absurd — 500 kg entered where 500 g was meant converts perfectly and costs
 *      a thousand times too much. Signal 1 cannot see this; only the money can.
 *      Judged against the dish's own selling price, which is the only scale that
 *      means anything here.
 *
 *   3. IMPLAUSIBLE (absolute). MONEY IS NOT ENOUGH, AND MEASURING IT PROVED IT.
 *      Signal 2 is a RATIO to the selling price, so it is blind twice over:
 *
 *        · a bulk quantity of a CHEAP material never clears the bar. ASIAN GREEN
 *          SALAD carries 700 g of SWEET CHILLI SACUCE on one plate — 0.71 of a
 *          980 g bottle, and 14× the largest use of that same material anywhere
 *          else in this book (every other recipe uses 4–50 g). At ₹0.2276/g it
 *          costs ₹159.32 against a ₹449 dish: 35% of the price, so
 *          LINE_OVER_PRICE (1.0 → ₹449) and LINE_DOMINATES (0.9 → ₹404) BOTH
 *          stand down. It would have to reach 1.78 kg on one plate to be seen.
 *        · 48 of the 67 recipes on this database resolve to an effective price of
 *          0, and every proportional signal stands down entirely for all of them.
 *          MUTTON MURAG SOUP led with an ₹8.37 bay-leaf note while a ₹3,890.25
 *          line — 1.5 kg of GREEN CARDMOM on one portion, 76% of the recipe's
 *          cost — went completely unnamed, because pcs→g bridges cleanly through
 *          the pack size and nothing else was looking.
 *
 *      So the QUANTITY is judged on its own, in the base of its own dimension
 *      (g, ml, pieces), with no reference to price at all. A portion is a portion.
 *
 *      THE THRESHOLD IS TAKEN FROM HIS DATA, NOT GUESSED (see PORTION_LIMIT).
 *      A WARNING, NEVER A BLOCKER: batch and party recipes are written for more
 *      than one plate, and striking a red line through a figure that turns out to
 *      be correct is the exact mistake this file was fixed for once already. The
 *      message says the batch case out loud instead of accusing.
 *
 * Every finding names the likely cause in the cook's own terms and states the
 * unit the money is being valued in — because "₹63,012" alone tells a cook
 * nothing about which number to change.
 *
 * Pure module: the entry screen runs it live in the browser, and the save path
 * runs it server-side on the same inputs. One rule, two callers.
 */

export type SanityCode =
  /** Units differ and cannot be bridged — the quantity is being read as the material's unit. */
  | 'unit_unconvertible'
  /**
   * Weighed in grams, stocked in millilitres (or the reverse). The quantity
   * being valued IS the one the engine's own density-1 rule gives, so the money
   * is out by density alone — a few percent, not a factor. A note, never a
   * blocker: 22 of the 38 recipes this file used to flag are this, and striking
   * ₹333.20 through over an 8% density assumption is what teaches a reader to
   * ignore the mark before it reaches the ₹63,012 one.
   */
  | 'unit_density_assumed'
  /** The typed unit is not a unit this system recognises at all. */
  | 'unit_unknown'
  /** One ingredient line costs more than the whole dish sells for. */
  | 'line_over_price'
  /** The recipe's total cost exceeds its selling price. */
  | 'cost_over_price'
  /** Priced material, sane units, but the line is a large share of the dish. */
  | 'line_dominates'
  /**
   * The QUANTITY on one line is too large to be one portion, judged with no
   * reference to price — the only signal that can see 700 g of a cheap sauce, or
   * anything at all on the 48 recipes whose effective price is 0. Warning only:
   * a batch recipe is a legitimate reason to be over the bar.
   */
  | 'line_quantity_implausible'
  /** The line carries no quantity, so it is costed at ₹0 and adds nothing. */
  | 'quantity_zero'
  /** The line carries a NEGATIVE quantity, which subtracts from the dish's cost. */
  | 'quantity_negative';

export type SanitySeverity = 'blocker' | 'warning';

export interface SanityFinding {
  code: SanityCode;
  severity: SanitySeverity;
  /** Index into the ingredient array, or null for whole-recipe findings. */
  index: number | null;
  material_name: string;
  /** One line the cook can act on. */
  message: string;
  /** What most likely went wrong, named plainly. */
  likely_cause: string;
  /** Exactly what the engine is valuing, spelled out. */
  valuing: string;
  line_cost: number;
}

export interface SanityInput extends CostableIngredient {
  material_name?: string | null;
}

export interface SanityReport {
  findings: SanityFinding[];
  /** True when at least one finding is a blocker. */
  has_blocker: boolean;
  /** Ingredient total, ₹, by the one shared formula. */
  total_cost: number;
  /** The price the findings were judged against (0 when unknown). */
  price: number;
}

/**
 * A line costing more than this multiple of the dish's price is not a pricing
 * decision, it is a typo. Set at 1.0 — a SINGLE ingredient costing more than the
 * entire dish sells for is already indefensible, so there is no need to guess at
 * a cleverer threshold. Dishes genuinely sold below food cost exist, but not ones
 * where one line alone clears the whole price.
 */
const LINE_OVER_PRICE = 1.0;

/**
 * Total cost over this multiple of price is flagged. 1.0 would fire on every
 * loss-leader and every dish whose menu price has not been set yet, so it sits
 * at 1.5 — a 150% food cost is past any real-world margin error.
 */
const COST_OVER_PRICE = 1.5;

/** A single line this far above the dish price is called out even when units converted. */
const LINE_DOMINATES = 0.9;

/**
 * ONE PORTION'S WORTH OF ONE INGREDIENT — THE BAR, AND WHERE IT CAME FROM.
 *
 * Measured over all 568 default ingredient lines in the owner's live book, each
 * line expressed in the base of the unit its money is computed in:
 *
 *     weight  491 lines   median   10 g   p90  160 g   p95  300 g
 *     volume   70 lines   median   15 ml  p90   60 ml  p95   75 ml   max 100 ml
 *     count     7 lines   median    1     p90    3               max   3
 *
 * The bar sits at 500, which is 1.7× the weight p95 and 50× its median — and the
 * distribution leaves a CLEAN GAP around it: 36 weight lines exceed 200 g, 24
 * exceed 300 g, and the same 24 exceed 500 g. NOT ONE LINE IN THE BOOK falls
 * between 300 g and 500 g, so the threshold has room on both sides and is not
 * balanced on the edge of the real data. No volume line and no count line reaches
 * its bar at all, so this signal fires on nothing that was not already extreme.
 *
 * Of the 24 weight lines it names, 18 already carry a blocker (pcs valued as kg —
 * the prawns and the garlic). The other SIX are what this exists for, and every
 * one of them was completely silent before: 700 g of sweet chilli sauce in ASIAN
 * GREEN SALAD, 1.5 kg of GREEN CARDMOM in two soups, and 10–15 kg of GREEN CHILLI
 * in three more.
 *
 * Count sits higher (100) because a count unit is also a PACK unit here — BTL,
 * TIN, PKT — and "24 eggs" or "12 bottles" in a batch is ordinary. 100 of
 * anything on one plate is not.
 *
 * These are per-PORTION bounds and a recipe may legitimately be written per
 * batch, which is why crossing one raises a warning and says so rather than
 * condemning the figure.
 */
const PORTION_LIMIT: Record<Dimension, { limit: number; base: string }> = {
  weight: { limit: 500, base: 'g' },
  volume: { limit: 500, base: 'ml' },
  count: { limit: 100, base: '' },
};

function fmt(n: number): string {
  return `₹${toPaise(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Round for reading, not for arithmetic: 1500 → "1.5 kg", 700 → "700 g". */
function readableQty(base: number, dim: Dimension): string {
  const n = (x: number) => Number(x.toFixed(2)).toLocaleString('en-IN');
  if (dim === 'weight') return base >= 1000 ? `${n(base / 1000)} kg` : `${n(base)} g`;
  if (dim === 'volume') return base >= 1000 ? `${n(base / 1000)} L` : `${n(base)} ml`;
  return n(base);
}

/**
 * The quantity this line's money is computed on, expressed in the BASE of its
 * dimension (g / ml / count), or null when the unit is not one this system knows.
 *
 * Deliberately derived from the SAME numbers the cost is: `converted.qty` is the
 * quantity in the material's own unit — the figure multiplied by average_price —
 * and `UNIT_REGISTRY` is the same registry that conversion used, so this can
 * never describe a quantity the money was not computed from. That registry is
 * replaced from the `units` table on the server and hydrated over the built-in
 * values in the browser (see hydrateUnitRegistry in recipe-cost.ts); both sides
 * therefore judge the same quantity they costed.
 */
function baseQuantity(qtyInMaterialUnit: number, materialUnit: string): { base: number; dim: Dimension } | null {
  const key = resolveUnit(materialUnit);
  const dim = dimensionOf(materialUnit);
  if (!key || !dim) return null;
  const def = UNIT_REGISTRY[key];
  if (!def || !Number.isFinite(def.toBase)) return null;
  return { base: qtyInMaterialUnit * def.toBase, dim };
}

/**
 * Judge a set of ingredient lines against the price the dish actually sells for.
 *
 * `price` should be the EFFECTIVE price — the menu price when the recipe is
 * linked to a live listing, resolved by src/lib/recipe-price.ts. Pass 0 when no
 * price is known: the unit signals still fire (they need no price at all), and
 * only the proportional ones stand down.
 */
export function checkRecipeSanity(ings: SanityInput[], price: number): SanityReport {
  const findings: SanityFinding[] = [];
  const sell = Number(price) || 0;
  let total = 0;

  ings.forEach((ing, index) => {
    const name = String(ing.material_name || 'This ingredient').trim();
    const { converted, line_cost, rate } = ingredientLineCost(ing);
    total += line_cost;

    const entered = `${ing.quantity} ${converted.entered_unit || converted.in_unit}`;
    const valuing = `Valuing ${entered} as ${toPaise(converted.qty)} ${converted.in_unit} × ${fmt(rate)}/${converted.in_unit} = ${fmt(line_cost)}`;

    // ── SIGNAL 0: there is no quantity on this line. ─────────────────────────
    //
    // A line with quantity 0 costs ₹0 and the recipe is costed exactly as though
    // it were not there — but the dish STOPS reading "Not linked · ₹0" (honest:
    // no recipe) and starts reading "Recipe · Cost ₹0.00, FC 0%", which is a
    // costed-looking zero, and that zero is what a sale books. A NEGATIVE
    // quantity is worse: it SUBTRACTS from the dish's cost, and a whole recipe
    // made of one negative line stores a negative total_cost.
    //
    // The save is still not refused — refusing would break the importer and
    // every existing edit, the same rule the rest of this file follows — but the
    // report can no longer come back EMPTY on a recipe that stored a meaningless
    // figure, which is what an importer or a script was being told before.
    //
    // Zero rows on the owner's live book carry either state (568 default lines,
    // `SELECT COUNT(*) FROM recipe_ingredients WHERE quantity <= 0` = 0), so
    // nothing that exists today is newly flagged by this.
    const qtyTyped = Number(ing.quantity);
    if (!Number.isFinite(qtyTyped) || qtyTyped === 0) {
      findings.push({
        code: 'quantity_zero',
        severity: 'warning',
        index,
        material_name: name,
        message: `${name} has no quantity on it, so it adds ${fmt(0)} to this dish. The recipe is costed as if this ingredient were not in it.`,
        likely_cause: `Type how much ${name} the dish uses, in ${converted.in_unit}. Until then this line is decoration — and if every line is like it, the dish records no food cost at all while still reading as costed.`,
        valuing,
        line_cost: 0,
      });
      return;
    }
    if (qtyTyped < 0) {
      findings.push({
        code: 'quantity_negative',
        severity: 'blocker',
        index,
        material_name: name,
        message: `${name} carries a negative quantity (${ing.quantity} ${converted.entered_unit || converted.in_unit}), so it SUBTRACTS ${fmt(Math.abs(line_cost))} from this dish's cost instead of adding to it.`,
        likely_cause: `A quantity is how much goes in, so it cannot be less than nothing. Enter a positive number (or remove the line). A negative quantity makes the dish look cheaper to cook than it is.`,
        valuing,
        line_cost: toPaise(line_cost),
      });
      return;
    }

    // ── SIGNAL 1: the conversion failed. Deterministic. ──────────────────────
    //
    // ...but "failed" is not one thing. A pcs-against-kg line is priced 1,000×
    // out and its money is noise; a g-against-ml line is priced at the engine's
    // own density-1 assumption and is out by density alone. Both used to raise
    // the same blocker, which put ASIAN GREEN SALAD's genuine 74% food cost
    // behind a red strike-through. They are graded apart now — see
    // ConversionMismatch in recipe-cost.ts, which classifies by asking
    // units.ts itself what it would have done.
    if (!converted.convertible && converted.mismatch === 'density_assumed') {
      findings.push({
        code: 'unit_density_assumed',
        severity: 'warning',
        index,
        material_name: name,
        message: `${name}: ${entered} is weighed in ${converted.entered_unit}, but ${name} is stocked in ${converted.in_unit}. It is being valued as ${toPaise(converted.qty)} ${converted.in_unit} — the same figure the system uses elsewhere for this pair, so the cost is within a few percent.`,
        likely_cause: `Nothing here is out by a factor — 1 ${converted.entered_unit} is taken as 1 ${converted.in_unit}, which is right for water and out by up to about 10% for oils and creams. Enter the quantity in ${converted.in_unit} to make it exact.`,
        valuing,
        line_cost: toPaise(line_cost),
      });
      // NO early return. This line's money is meaningful, so it still gets
      // graded on size below.
      //
      // AN EARLIER VERSION OF THIS COMMENT CLAIMED THAT "a 700 g line is worth
      // catching whichever unit it was typed in" AND IT WAS FALSE TWICE OVER,
      // which is worth saying plainly because that sentence is what stopped the
      // next reader looking: the grading below was proportional to the selling
      // price ONLY, so no 700 g line was caught at 35% of price in any unit; and
      // the actual 700 g line on this database is g against a g-stocked material,
      // which converts cleanly and never enters this branch at all. Signal 3 is
      // what makes the claim true — it grades the quantity itself.
    } else if (!converted.convertible) {
      if (converted.unknown_unit) {
        findings.push({
          code: 'unit_unknown',
          severity: 'blocker',
          index,
          material_name: name,
          message: `${name}: “${converted.entered_unit}” is not a unit this system knows, so ${entered} is being counted as ${converted.qty} ${converted.in_unit}.`,
          likely_cause: `Pick a unit from the list. ${name} is stocked in ${converted.in_unit}.`,
          valuing,
          line_cost: toPaise(line_cost),
        });
      } else if (converted.mismatch === 'scale_mismatch' && converted.density_qty != null) {
        // Volume against weight AND a size apart: 0.5 kg valued as 0.5 ml where
        // the density rule says 500 ml. The money is out by the whole scale, so
        // this stays a blocker — but the factor is stated, because "1,000×
        // short" is the sentence that gets it fixed.
        const factor = converted.qty !== 0 ? converted.density_qty / converted.qty : 0;
        findings.push({
          code: 'unit_unconvertible',
          severity: 'blocker',
          index,
          material_name: name,
          message: `${name}: ${entered} is being priced as ${converted.qty} ${converted.in_unit}, but ${converted.entered_unit} and ${converted.in_unit} are different sizes — it should be about ${toPaise(converted.density_qty)} ${converted.in_unit}, roughly ${factor >= 1 ? `${Math.round(factor)}× more` : `${Math.round(1 / factor)}× less`}.`,
          likely_cause: `Enter the quantity in ${converted.in_unit}, the unit ${name} is stocked in. ${converted.entered_unit} and ${converted.in_unit} measure the same kind of thing here, but one is ${Math.round(factor >= 1 ? factor : 1 / factor)} times the other.`,
          valuing,
          line_cost: toPaise(line_cost),
        });
      } else {
        findings.push({
          code: 'unit_unconvertible',
          severity: 'blocker',
          index,
          material_name: name,
          message: `${name}: ${converted.entered_unit} cannot be converted to ${converted.in_unit}, so ${entered} is being priced as ${converted.qty} ${converted.in_unit}.`,
          likely_cause: countWeightHint(converted.entered_unit, converted.in_unit, name),
          valuing,
          line_cost: toPaise(line_cost),
        });
      }
      return; // the money on this line is meaningless; don't also grade its size
    }

    // ── SIGNAL 3: the QUANTITY is not one portion's worth. No price involved. ─
    //
    // Runs BEFORE the money tests so that on a line which is both huge and
    // expensive the structural fact is stated first. It is independent of them by
    // design: this is the only signal that survives an unpriced recipe, and 48 of
    // the 67 recipes here are unpriced. See PORTION_LIMIT for the measured bar.
    const bq = baseQuantity(converted.qty, converted.in_unit);
    if (bq && bq.base > PORTION_LIMIT[bq.dim].limit) {
      const { limit, base } = PORTION_LIMIT[bq.dim];
      const shown = readableQty(bq.base, bq.dim);
      const bar = readableQty(limit, bq.dim);
      findings.push({
        code: 'line_quantity_implausible',
        severity: 'warning',
        index,
        material_name: name,
        message: `${name}: ${shown} of it on one portion${line_cost > 0 ? `, costing ${fmt(line_cost)}` : ''}. A single ingredient on one serving is rarely over ${bar}${base ? '' : ' of anything'}.`,
        likely_cause: `Check the quantity and its unit — ${shown} of ${name} for one portion is unusual. If this recipe is written for a BATCH rather than a single portion then this is expected and nothing is wrong. Otherwise it is most often a unit typed one size out (${bq.dim === 'weight' ? 'kg where g was meant' : bq.dim === 'volume' ? 'L where ml was meant' : 'a pack counted as a piece'}) or one digit too many.`,
        valuing,
        line_cost: toPaise(line_cost),
      });
    }

    // ── SIGNAL 2: units fine, magnitude absurd. ──────────────────────────────
    if (sell > 0 && line_cost > sell * LINE_OVER_PRICE) {
      findings.push({
        code: 'line_over_price',
        severity: 'blocker',
        index,
        material_name: name,
        message: `${name} alone costs ${fmt(line_cost)} — more than the ${fmt(sell)} the dish sells for.`,
        likely_cause: magnitudeHint(converted.entered_unit, converted.in_unit, name),
        valuing,
        line_cost: toPaise(line_cost),
      });
    } else if (sell > 0 && line_cost > sell * LINE_DOMINATES) {
      findings.push({
        code: 'line_dominates',
        severity: 'warning',
        index,
        material_name: name,
        message: `${name} is ${Math.round((line_cost / sell) * 100)}% of the ${fmt(sell)} selling price on its own.`,
        likely_cause: magnitudeHint(converted.entered_unit, converted.in_unit, name),
        valuing,
        line_cost: toPaise(line_cost),
      });
    }
  });

  // ── Whole-recipe check. ───────────────────────────────────────────────────
  if (sell > 0 && total > sell * COST_OVER_PRICE && !findings.some(f => f.severity === 'blocker')) {
    findings.push({
      code: 'cost_over_price',
      severity: 'warning',
      index: null,
      material_name: '',
      message: `Total food cost ${fmt(total)} is ${Math.round((total / sell) * 100)}% of the ${fmt(sell)} selling price.`,
      likely_cause: 'Check the quantities and their units — a food cost above 100% is usually a unit entered one size out (g typed as kg, ml as L).',
      valuing: `Ingredients total ${fmt(total)} against a selling price of ${fmt(sell)}`,
      line_cost: toPaise(total),
    });
  }

  return {
    findings,
    has_blocker: findings.some(f => f.severity === 'blocker'),
    total_cost: toPaise(total),
    price: sell,
  };
}

const COUNT_UNITS = new Set(['pcs', 'pc', 'piece', 'pieces', 'nos', 'no', 'each', 'btl', 'bottle', 'can', 'packet', 'pkt']);
const MASS_VOL = new Set(['kg', 'g', 'gm', 'gram', 'grams', 'l', 'ltr', 'litre', 'liter', 'ml']);

/**
 * The pcs-vs-kg message, named the way a cook would name it.
 * Generic wording only when the pair is something else.
 */
function countWeightHint(from: string, to: string, name: string): string {
  const f = from.toLowerCase();
  const t = to.toLowerCase();
  if (COUNT_UNITS.has(f) && MASS_VOL.has(t)) {
    return `${name} is stocked and priced by ${t}, not by the piece. Enter the weight you actually use (e.g. 0.2 ${t}), or set a pack size on the material so the system knows what one ${f} weighs.`;
  }
  if (MASS_VOL.has(f) && COUNT_UNITS.has(t)) {
    return `${name} is stocked by the ${t}, not by weight. Enter how many ${t} the dish uses, or set a pack size on the material so the system knows what one ${t} weighs.`;
  }
  return `${name} is stocked in ${t}. Enter the quantity in ${t}, or set a pack size on the material to bridge ${f} and ${t}.`;
}

/** For a line that converted cleanly but costs far too much. */
function magnitudeHint(from: string, to: string, name: string): string {
  const t = to.toLowerCase();
  if (t === 'kg') return `If you meant grams, enter g — 500 kg of ${name} is half a tonne, 500 g is a portion.`;
  if (t === 'l' || t === 'ltr') return `If you meant millilitres, enter ml — 2 L and 2 ml are a thousand times apart.`;
  if (t === 'g' || t === 'ml') return `Check the quantity: it is being read as ${t}, so a value meant as kg or L will be a thousand times too small, and one meant as a portion count far too large.`;
  return `Check the quantity and its unit against how ${name} is stocked (${t}).`;
}
