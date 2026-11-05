/**
 * SUB-RECIPE INGREDIENT RATE — ₹ per PURCHASE unit, exactly as /closing-stock
 * values the same material. Display only: nothing here is stored or costed.
 *
 * ── WHY THE PAGE STOPPED COMPUTING IT ──────────────────────────────────────
 * The Recipes page used to print purchasePrice(average_price, meta) — that is
 * average_price × packFactor — for every sub-recipe line. /api/sub-recipes has
 * returned the real figure (`rate_per_purchase_unit`, resolved by
 * src/lib/closing-valuation.ts: last priced purchase → average cost → none)
 * since WORK1 shipped, and nothing under src/app/recipes read it. So the same
 * bottle could read one rate on the sub-recipe screen and another on the
 * closing sheet. This module is the one place the page reads that figure.
 *
 * It never re-derives a rate. A row without one is NOT quietly re-priced from
 * average_price — that is the naive figure this exists to replace — it prints
 * an em-dash with the reason, the same as /closing-stock does for "no basis".
 *
 * ── SOURCES ────────────────────────────────────────────────────────────────
 *   1. a saved sub-recipe line: the row /api/sub-recipes served.
 *   2. the editor's picker and a freshly added line (no saved row yet):
 *      /api/closing-stock/rates — the same rateMap() + materialRate() over the
 *      same COALESCEd pack meta, so it is the same number by construction.
 * buildRateIndex() lays (1) over (2), so a line that has a saved figure shows
 * that figure in the editor as well as on the detail screen.
 */

// Type-only: erased at build, so nothing of the valuation module is bundled —
// but the union cannot drift from the one the server resolves.
import type { RateSource } from '@/lib/closing-valuation';

export interface ValuedRate {
  /** ₹ per PURCHASE unit (kg / L / BTL / CASE / PKT). */
  rate: number;
  source: RateSource;
  /** Purchase date behind a last_purchase rate. */
  asOf: string | null;
}

/** The three fields /api/sub-recipes and /api/closing-stock/rates both serve. */
export interface ServedRateFields {
  rate_per_purchase_unit?: number | null;
  rate_source?: string | null;
  rate_as_of?: string | null;
}

// A Record over the union: tsc refuses this if closing-valuation ever adds a source.
const SOURCES: Record<RateSource, true> = { last_purchase: true, average_cost: true, none: true };

/**
 * Read the served rate off a row. null = the server served NO figure (a payload
 * from before the field existed, or a material the rates map does not hold).
 */
export function servedRate(row: ServedRateFields | null | undefined): ValuedRate | null {
  if (!row || row.rate_per_purchase_unit == null) return null;
  const rate = Number(row.rate_per_purchase_unit);
  if (!Number.isFinite(rate)) return null;
  const source: RateSource = Object.prototype.hasOwnProperty.call(SOURCES, String(row.rate_source))
    ? (row.rate_source as RateSource)
    : 'none';
  return { rate, source, asOf: row.rate_as_of ?? null };
}

/** Same test /closing-stock's noBasis() applies: no source, or no positive rate. */
export function hasBasis(v: ValuedRate | null | undefined): v is ValuedRate {
  return !!v && v.source !== 'none' && v.rate > 0;
}

/** "last purchase 12 Jul" / "avg cost" — the label /closing-stock prints. */
export function rateSourceLabel(v: ValuedRate | null | undefined): string | null {
  if (!v) return null;
  if (v.source === 'last_purchase') {
    const d = v.asOf ? new Date(v.asOf) : null;
    return d && !isNaN(d.getTime())
      ? `last purchase ${d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}`
      : 'last purchase';
  }
  if (v.source === 'average_cost') return 'avg cost';
  return null;
}

/** Tooltip for a rate cell. Says what the figure is, and why Qty × Rate may not
 *  equal the Eff. Cost beside it (that column is the costing engine's number). */
export function rateTitle(v: ValuedRate | null | undefined, purchaseUnit: string): string {
  if (!v) return 'No rate served for this material — the rates are still loading or could not be fetched. Not priced locally on purpose.';
  if (!hasBasis(v)) return 'No price basis — no priced purchase and no average cost on record. Shown as an em-dash rather than a false ₹0.';
  const from = v.source === 'last_purchase'
    ? `the last priced purchase${v.asOf ? ` (${v.asOf})` : ''}`
    : 'average cost (no priced purchase on record)';
  return `₹ per ${purchaseUnit || 'purchase unit'}, as /closing-stock values this material — from ${from}. `
    + 'Eff. Cost is the costing engine’s figure, so Qty × Rate can differ from it.';
}

/**
 * material_id → rate for the sub-recipe editor. `catalog` is the
 * /api/closing-stock/rates map (may still be loading → null); every line of
 * every loaded sub-recipe is laid over it, so a saved line keeps the figure its
 * detail screen shows.
 */
export function buildRateIndex(
  subRecipes: Array<{ ingredients?: Array<ServedRateFields & { material_id: string }> }>,
  catalog: Record<string, ServedRateFields> | null,
): Map<string, ValuedRate> {
  const out = new Map<string, ValuedRate>();
  if (catalog) {
    for (const [id, row] of Object.entries(catalog)) {
      const v = servedRate(row);
      if (v) out.set(id, v);
    }
  }
  for (const sr of subRecipes) {
    for (const ing of sr.ingredients || []) {
      const v = servedRate(ing);
      if (v) out.set(ing.material_id, v);
    }
  }
  return out;
}
