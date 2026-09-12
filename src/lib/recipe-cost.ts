import { applyRegistryRows, convert, resolveUnit } from './units';

/**
 * THE FORMULA DOES NOT DRIFT. THE UNIT TABLE DID.
 * ----------------------------------------------
 * This module's whole claim is that the number a screen previews is the number the
 * server stores, because both run the same function. That was true of the
 * arithmetic and false of its inputs.
 *
 * src/lib/units.ts ships a BUILT-IN registry and the server replaces it at boot
 * from the `units` table (db.ts calls applyRegistryRows inside getDb()). The
 * browser never does, so the client keeps the built-in values — and they disagree
 * with the owner's database:
 *
 *     units table :  PKT  →  dimension volume, to_base 1000
 *     built-in    :  PKT  →  dimension count,  to_base 1
 *
 * So "1 pkt" of SALAD OIL 500 ML previewed ₹157.50 in the browser and stored
 * ₹315.00; of PERI PERI SPRINKLER it previewed ₹151.40 and stored ₹0.15. Neither
 * side warned, because neither side was wrong about its own registry. 141 active
 * materials are stocked in g/kg with a pack size, so the 500×–1000× shape is the
 * common one.
 *
 * One fetch fixes it for the whole page: pull the same rows the server loaded and
 * apply them to the same registry object. Called by the quick-recipe screen before
 * it prices anything, and by the recipe book's live preview. Once per page load;
 * a failure is left alone rather than guessed at — the built-in values are what
 * the screen had before, and a silent retry loop on a recipe form is worse.
 *
 * ONE MODULE INSTANCE ON THE SERVER — MEASURED IN A REAL BUILD, NOT REASONED ABOUT.
 * This file reaches units.ts through a STATIC `import` (line 1); db.ts reaches the
 * same module through a deferred `require('./units')` inside getDb(). Two
 * specifiers, one registry object — and if the bundler ever resolved them to two
 * instances, the rows getDb() applied would be invisible here and every PKT line
 * would be out by 1000× (built-in count/1 against the units table's volume/1000).
 * That was checked by RUNNING it: a production `next build` on Next 16.2.2 with
 * Turbopack, booted, costing 1 PKT of a ₹1/ml probe material through
 * POST /api/recipes → ₹1,000.00. Two instances would have returned ₹1.00. The
 * alias "PKT(1000ml)", which exists ONLY in the units table, resolved; the alias
 * "packet", which exists ONLY in the built-in registry, did not — mutually
 * exclusive, so the answer is not a coincidence. Same figure through
 * /api/recipes, /api/recipes/recompute-all and /duplicate, and units.ts carries a
 * single module id in every emitted server chunk.
 *
 * That pins TODAY'S toolchain, not a law. A Next or Turbopack upgrade could split
 * the two specifiers again and NOTHING WOULD WARN YOU — costs would simply come
 * out 1000× light on any unit whose `units` row disagrees with the built-in (PKT
 * is the only one on this data today). The cheap regression test is that probe:
 * one PKT of a ₹1-per-ml material must cost ₹1,000.00. Note the measurement
 * covers the SERVER bundle only; the browser chunks genuinely do carry units.ts
 * without db.ts, which is precisely what hydrateUnitRegistry() below exists for,
 * and no money is stored on that path.
 */
let registryHydration: Promise<boolean> | null = null;

export function hydrateUnitRegistry(): Promise<boolean> {
  if (registryHydration) return registryHydration;
  if (typeof fetch !== 'function') return Promise.resolve(false);
  registryHydration = (async () => {
    try {
      const res = await fetch('/api/units');
      if (!res.ok) return false;
      const data = await res.json();
      const rows = Array.isArray(data?.units) ? data.units : [];
      if (!rows.length) return false;
      applyRegistryRows(rows);
      return true;
    } catch {
      return false;
    }
  })();
  return registryHydration;
}

/**
 * WHEN THE CONVERSION FAILS, HOW BADLY IS THE MONEY WRONG?
 *
 * Not a detail. `convertible: false` was being read as one thing — "this cost is
 * meaningless" — and on this data it is two things that are three orders of
 * magnitude apart:
 *
 *   · 100 pcs of PRAWNS 80/100, a material priced per kg, is valued as 100 kg.
 *     ₹63,000 on one line. The number is noise.
 *   · 100 g of SALAD OIL 500 ML, a material tracked in ml, is valued as 100 ml.
 *     ₹31.50 — which is the same ₹31.50 the engine's own density-1 rule gives
 *     for that line everywhere else (units.ts convert(), the volume↔weight
 *     fallback). Oil is ~0.92 g/ml, so the figure is out by about 8%.
 *
 * The second only reaches this code path at all because the material carries a
 * pack_size: units.ts takes the pack-bridge branch when pack_size is set and
 * that branch cannot cross weight and volume, so the density-1 fallback three
 * lines above it never runs. Nothing about the money changes — the same number
 * comes out either way when the two units share a base (g↔ml) — but the FLAG
 * did, and 22 of the 38 flagged recipes on this database are that case.
 *
 * So the failure is classified, by asking units.ts itself what it would have
 * done with no pack context, and comparing that with the number actually used:
 *
 *   density_assumed  volume↔weight, and the quantity being valued IS the
 *                    density-1 quantity (g↔ml). Within a few percent. A note.
 *   scale_mismatch   volume↔weight, but out by the unit scale as well (0.5 kg
 *                    valued as 0.5 ml is 1,000× short). Real money, wrong.
 *   count_vs_measure pcs against kg/ml with no pack bridge. The prawns. Noise.
 *   unknown_unit     the typed unit is not a unit at all.
 *
 * THE NUMBERS DO NOT MOVE. This function returns exactly the quantity it always
 * returned, in every branch — recalculateRecipeCost (db.ts) delegates here and
 * its output is unchanged to the paise on all 67 live recipes. Only the reason
 * travels with it.
 */
export type ConversionMismatch =
  | 'none'
  | 'density_assumed'
  | 'scale_mismatch'
  | 'count_vs_measure'
  | 'unknown_unit';

/**
 * THE INGREDIENT-COST FORMULA — SHARED BY ONE CALL SITE OF SEVEN.
 * --------------------------------------------------------------
 * recalculateRecipeCost (src/lib/db.ts) costs a recipe's raw ingredients with a
 * three-line formula: convert the entered quantity into the material's own unit,
 * inflate it for wastage and yield, multiply by average_price. That formula lived
 * only inside that function, so any screen wanting to show a cost BEFORE saving
 * had two options — save and re-read, or re-type the arithmetic. Re-typing it is
 * how one dish comes to show two different food costs on two screens.
 *
 * So it lives here, once, as a pure function. recalculateRecipeCost calls it; the
 * quick-recipe entry screen calls it to preview the very same number it is about
 * to store. THAT PAIR cannot drift.
 *
 * READ THIS BEFORE YOU TRUST THE WORD "ONE". An earlier version of this header
 * claimed there was "no second calculation to drift". That was never true. SEVEN
 * places in this codebase compute this shape; moving recalculateRecipeCost onto
 * this module moved exactly ONE of them.
 *
 * FIVE still carry the whole thing inline and still divide by a RAW yield:
 *
 *     src/lib/db.ts:8970            recalculateSubRecipeCost
 *     src/lib/db.ts:9498            deductInventoryForSale — stock deduction
 *     src/lib/db.ts:9569            deductInventoryForSale — stock deduction
 *     src/lib/store-engine.ts:1339  explodeRecipeUnit
 *     src/lib/store-engine.ts:1360  explodeRecipeUnit
 *
 * all five `qtyInMatUnit * (1 + ing.wastage_percent / 100) / (ing.yield_percent / 100)`.
 *
 * The SEVENTH is a half-case worth knowing about: engineLineCost in
 * src/app/api/recipes/export/route.ts:22. It shares the CONVERSION — it calls
 * db.ts's convertToMaterialUnit, which now delegates here — but re-types the
 * wastage/yield arithmetic. It already floors a non-positive yield the way this
 * module does, so on any single line it agrees with ingredientLineCost to the
 * paise. It rounds PER LINE, though, where recalculateRecipeCost sums unrounded
 * and rounds once at the end; so an export sheet's line cells and a recipe's
 * stored total are not guaranteed to reconcile to the last paise, and that is a
 * pre-existing difference, not something this refactor introduced.
 *
 * So TWO formulas exist today and they CAN drift. That is a known, accepted state,
 * not an oversight. The five were deliberately left where they are: they sit on
 * the settle and stock rails, where a changed number does not merely look wrong on
 * a screen, it writes a ledger row — so moving them is its own change, with its own
 * approval and its own proof, not a side effect of a costing refactor.
 *
 * WHAT THAT MEANS FOR YOU: if you change the arithmetic below, you have changed
 * the recipe's PREVIEWED and STORED cost and nothing else. The sub-recipe cost and
 * the quantity actually deducted from stock will keep the old behaviour and the
 * two will disagree. Change all of them in one commit, or change none. Line
 * numbers drift; the grep does not —
 *
 *     grep -rnE '^[[:space:]]+const effectiveQty = qtyInMatUnit' src
 *
 * returns 6 today (the five above plus the export route) and must return 0 on the
 * day someone finishes the job. The leading-whitespace anchor is not decoration:
 * it is what stops the pattern matching the prose in this very comment. Grep the
 * bare string "yield_percent / 100" instead and it counts these lines too and
 * tells you 7 — which is how a comment that documents a trap becomes one.
 *
 * src/lib/db.ts:19 repeats the same overstatement in its own header ("a previewed
 * cost and a stored cost can never be two different calculations"). That file is
 * held by other work and was not edited alongside this one. Believe this list.
 *
 * RATE BASIS — raw_materials.average_price is ₹ per RECIPE unit (g / ml / pcs),
 * the same basis `quantity` is converted into. NEVER last_purchase_price: that
 * column is stored in mixed bases and is up to 5,000× off on this data
 * (see src/lib/closing-valuation.ts). This module never reads it.
 *
 * This is NOT stock valuation. Stock is valued in PURCHASE units by
 * src/lib/closing-valuation.ts. Two different, both-correct bases; do not mix.
 */

export interface CostableIngredient {
  quantity: number;
  /** The unit the cook typed on THIS line — recipe_ingredients.unit, per-row. */
  unit?: string | null;
  /** raw_materials.unit — the material's own recipe unit. */
  material_unit: string;
  material_name?: string | null;
  /** raw_materials.pack_size — recipe units per purchase unit. Bridges count↔weight/volume. */
  material_pack_size?: number | null;
  /** raw_materials.average_price — ₹ per recipe unit. */
  average_price?: number | null;
  yield_percent?: number | null;
  wastage_percent?: number | null;
}

export interface ConvertedQty {
  /** The quantity expressed in the material's unit — what the money is computed on. */
  qty: number;
  /** The unit `qty` is expressed in. This is the unit the money is valued in. */
  in_unit: string;
  /** The unit the user actually typed. */
  entered_unit: string;
  /**
   * False when the entered unit could NOT be converted to the material's unit.
   *
   * This is the silent failure that matters. convert() returns null for an
   * impossible pair (100 pcs → kg with no pack bridge) and the costing engine
   * falls back to the RAW NUMBER — so "100 pcs" is multiplied by the ₹/kg rate
   * as though the cook had written 100 kg. That is exactly how LOOSE PRAWNS
   * reached ₹63,012: 100 pcs of PRAWNS 80/100 valued as 100 kg × ₹630.
   *
   * The fall-back is preserved (removing it would zero out costs instead of
   * inflating them, which is not an improvement) but it is now REPORTED, so a
   * screen can say so at entry instead of printing a five-figure dish cost.
   */
  convertible: boolean;
  /** True when no conversion was needed (same unit, or aliases of one unit). */
  same_unit: boolean;
  /** True when the entered unit is not a unit this system knows at all. */
  unknown_unit: boolean;
  /**
   * WHY it could not convert, and therefore how wrong the money is. 'none'
   * whenever `convertible` is true. See ConversionMismatch above.
   */
  mismatch: ConversionMismatch;
  /**
   * For a volume↔weight failure: the quantity the density-1 rule would have
   * used (1 ml ≈ 1 g). Null for every other case. When this equals `qty`, the
   * money already IS the density-1 figure and the only error is density itself.
   */
  density_qty: number | null;
}

const norm = (u: unknown) => String(u ?? '').toLowerCase().trim();

/**
 * Convert an entered quantity into the material's unit, REPORTING whether the
 * conversion actually succeeded.
 *
 * Numerically identical to db.ts's convertToMaterialUnit — that function now
 * delegates here — so nothing about existing costing changes. The only addition
 * is the `convertible` flag, which was previously thrown away.
 */
export function convertForCosting(
  qty: number,
  recipeUnit: string | null | undefined,
  materialUnit: string,
  materialName?: string | null,
  packSize?: number | null,
): ConvertedQty {
  const r = norm(recipeUnit || materialUnit);
  const m = norm(materialUnit);

  if (!r || r === m) {
    return {
      qty, in_unit: m || r, entered_unit: r, convertible: true, same_unit: true,
      unknown_unit: false, mismatch: 'none', density_qty: null,
    };
  }

  const result = convert(qty, r, m, {
    recipe_unit: m,
    pack_size: packSize ?? undefined,
    name: materialName ?? undefined,
  });

  if (result == null) {
    // THE FALL-THROUGH. qty is returned unchanged and will be multiplied by a
    // rate quoted per `m`, not per `r`. Same number db.ts has always used —
    // now flagged, AND classified.
    //
    // The classifier asks units.ts the same question again with NO material
    // context. Without a pack_size its volume↔weight fallback is reachable, so
    // a non-null answer here means "these two are a volume/weight pair" and the
    // answer itself is the density-1 quantity. Deliberately re-using convert()
    // rather than re-deriving dimensions and toBase ratios: one rule, one
    // module, no second copy to drift.
    const densityQty = resolveUnit(r) ? convert(qty, r, m) : null;
    let mismatch: ConversionMismatch;
    if (!resolveUnit(r)) {
      mismatch = 'unknown_unit';
    } else if (densityQty == null) {
      // Volume/weight against COUNT, with no pack bridge. The prawns.
      mismatch = 'count_vs_measure';
    } else if (Math.abs(densityQty - qty) <= Math.abs(qty) * 1e-9) {
      // The quantity being valued already IS the density-1 quantity (g↔ml,
      // which share a base of 1). Only density itself is unaccounted for.
      mismatch = 'density_assumed';
    } else {
      // Volume/weight pair, but the units are different sizes too: 0.5 kg is
      // being valued as 0.5 ml where density-1 says 500 ml. Off by the scale.
      mismatch = 'scale_mismatch';
    }
    return {
      qty,
      in_unit: m,
      entered_unit: r,
      convertible: false,
      same_unit: false,
      unknown_unit: !resolveUnit(r),
      mismatch,
      density_qty: densityQty,
    };
  }

  // convert() returns qty unchanged when both strings resolve to the SAME
  // canonical unit (e.g. "pc" and "pcs"). That is a real no-op, not a failure.
  const sameCanonical = resolveUnit(r) != null && resolveUnit(r) === resolveUnit(m);
  return {
    qty: result, in_unit: m, entered_unit: r, convertible: true,
    same_unit: sameCanonical, unknown_unit: false, mismatch: 'none', density_qty: null,
  };
}

export interface LineCost {
  /** Quantity in the material's unit, and the unit it is valued in. */
  converted: ConvertedQty;
  /** After wastage and yield are applied — the quantity actually paid for. */
  effective_qty: number;
  /** ₹ per recipe unit used for this line. */
  rate: number;
  /** ₹ for this line. */
  line_cost: number;
}

/**
 * Cost ONE ingredient line. The formula, verbatim, from recalculateRecipeCost:
 *
 *   qty → material unit,  × (1 + wastage%),  ÷ (yield%),  × average_price
 *
 * MEASURED, NOT ASSUMED. Before db.ts was moved onto this function, both bodies
 * were loaded and RUN side by side over the live book — 67 recipes, 568 default
 * ingredient lines — and the stored figures came out bit-identical on float64 and
 * equal to the paise: SUM(recipes.total_cost) ₹386,049.67 stored, old and new
 * alike; 0 of 67 rows moved on total_cost, profit or food_cost_percent. The
 * arguments handed to Math.round were captured at full precision and compared too,
 * so the agreement is not an artefact of rounding to 2dp. The risky branch was
 * covered hardest, not skipped: the convert()-returns-null fall-through carries 60
 * of those 568 lines and 95.4% of the book's value.
 *
 * WHY IT HOLDS, AND WHAT WOULD BREAK IT. Every live row has yield_percent 100 and
 * wastage_percent 0, so both formulas collapse to conv(qty) × average_price, and
 * ×1.0 and ÷1.0 are exact in IEEE-754. The equivalence is therefore a fact about
 * TODAY'S DATA, not an identity between the two bodies. The first recipe that
 * carries a real yield is the first one that can tell them apart — see below.
 *
 * THE ONE REAL BEHAVIOURAL DIFFERENCE — COERCION. The old body used ing.quantity,
 * ing.wastage_percent and ing.yield_percent raw. This one runs them through
 * `Number(x) || 0` and floors the yield (safeYield). On a yield_percent of 0 the
 * old body divided by zero and wrote Infinity into recipes.total_cost, profit and
 * food_cost_percent; on a negative yield it wrote a NEGATIVE cost. This one writes
 * a finite number. That is a FIX, not a regression — and it is not hypothetical:
 * db.ts:9352-9359 documents a yield_percent-0 row aborting an entire settle
 * transaction (HTTP 500, no sales row, a bill that could never be closed because
 * every retry threw in the same place). /api/recipes still persists a 0 happily,
 * because `ing.yield_percent ?? 100` catches null and undefined but not 0, which
 * is exactly why the floor is here. 0 of 568 live rows carry one today.
 *
 * The five RAW-YIELD copies listed above do NOT have this floor (the export
 * route's copy does). Until they move, a yield of 0 is finite here and Infinity
 * there. The drift is real; it just happens to point in the safe direction, which
 * is not the same thing as being absent.
 */
export function ingredientLineCost(ing: CostableIngredient): LineCost {
  const converted = convertForCosting(
    Number(ing.quantity) || 0,
    ing.unit,
    ing.material_unit,
    ing.material_name,
    ing.material_pack_size,
  );

  const wastage = Number(ing.wastage_percent) || 0;
  const yieldPct = Number(ing.yield_percent);
  const safeYield = Number.isFinite(yieldPct) && yieldPct > 0 ? yieldPct : 100;

  const effective_qty = (converted.qty * (1 + wastage / 100)) / (safeYield / 100);
  const rate = Number(ing.average_price) || 0;

  return { converted, effective_qty, rate, line_cost: effective_qty * rate };
}

/** Sum of every ingredient line. Sub-recipes are added by the caller (db.ts). */
export function ingredientsCost(ings: CostableIngredient[]): number {
  let total = 0;
  for (const ing of ings) total += ingredientLineCost(ing).line_cost;
  return total;
}

/** Round to paise exactly the way recalculateRecipeCost stores it. */
export function toPaise(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}
