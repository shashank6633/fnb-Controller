/**
 * Valuation for closing stock: what one unit is worth, and what a counted
 * quantity is therefore worth.
 *
 * ── WHY THIS EXISTS RATHER THAN READING last_purchase_price ────────────────
 * The obvious implementation of "fetch the last purchase price and multiply"
 * is wrong on this database. raw_materials.last_purchase_price is stored in
 * MIXED bases: of the packed materials that carry both prices, 87 hold Rs per
 * PURCHASE unit (the canon) and 105 hold Rs per RECIPE unit. MALA STRAWBERRY
 * CRUSH 5 LTR stores 0.13 where the real last rate is Rs 674.10 — a 5,000x
 * error that would land straight in a stock valuation.
 *
 * So the rate is DERIVED, cheapest-truth-first:
 *
 *   1. last_purchase  — the unit_price on the most recent `purchases` row.
 *                       Authoritative and unambiguous: purchases.unit_price is
 *                       Rs per PURCHASE unit by canon, and it is what the
 *                       business actually paid. 441 materials have one.
 *   2. average_cost   — average_price x packFactor. average_price is Rs per
 *                       RECIPE unit by canon, so this converts to the same
 *                       per-purchase-unit basis. Always available.
 *   3. none           — no basis at all; rate 0, value 0, and the caller says so
 *                       rather than printing a confident zero.
 *
 * The chosen source travels with the number so the sheet can show WHERE a rate
 * came from. A valuation nobody can trace is a valuation nobody trusts.
 *
 * ── UNITS ──────────────────────────────────────────────────────────────────
 * Counted quantities (closing_stock.physical_stock) are RECIPE units.
 * Rates here are Rs per PURCHASE unit. Value therefore converts the quantity
 * to purchase units first — via toPurchaseQty, never a hand-rolled divide.
 */
import { packFactor, toPurchaseQty, type PackMeta } from '@/lib/pack-units';

export type RateSource = 'last_purchase' | 'average_cost' | 'none';

export interface MaterialRate {
  /** Rs per PURCHASE unit (kg / L / BTL / CASE / PKT). */
  ratePerPurchaseUnit: number;
  source: RateSource;
  /** Date of the purchase the rate came from, when source is 'last_purchase'. */
  asOf?: string | null;
}

export interface ValuedCount extends MaterialRate {
  /** As counted, RECIPE units. */
  recipeQty: number;
  /** The same quantity expressed in purchase units — what the rate multiplies. */
  purchaseQty: number;
  totalValue: number;
}

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Resolve the per-purchase-unit rate for ONE material.
 *
 * `db` is a better-sqlite3 handle. Pass `preloaded` when valuing many rows so
 * the caller can batch the purchase lookup instead of running it per material
 * (see rateMap below) — a closing sheet values several hundred lines at once.
 */
export function materialRate(
  db: any,
  material: { id: string; unit?: string | null; purchase_unit?: string | null; pack_size?: number | null; average_price?: number | null },
  preloaded?: { unit_price: number; date: string } | null,
): MaterialRate {
  const last = preloaded !== undefined
    ? preloaded
    : (db.prepare(`
        SELECT unit_price, date FROM purchases
         WHERE material_id = ? AND COALESCE(unit_price, 0) > 0
         ORDER BY date DESC, created_at DESC LIMIT 1
      `).get(material.id) as any);

  if (last && Number(last.unit_price) > 0) {
    return { ratePerPurchaseUnit: Number(last.unit_price), source: 'last_purchase', asOf: last.date || null };
  }

  const avg = Number(material.average_price) || 0;
  if (avg > 0) {
    const pf = packFactor(material as PackMeta);
    return { ratePerPurchaseUnit: avg * pf, source: 'average_cost', asOf: null };
  }

  return { ratePerPurchaseUnit: 0, source: 'none', asOf: null };
}

/**
 * One SELECT for the whole sheet: the latest priced purchase per material.
 * Returns a Map keyed by material_id; a material with no purchase history is
 * simply absent, and materialRate() falls through to average cost for it.
 */
export function rateMap(db: any): Map<string, { unit_price: number; date: string }> {
  const rows = db.prepare(`
    SELECT p.material_id, p.unit_price, p.date
      FROM purchases p
      JOIN (
        SELECT material_id, MAX(date || '|' || COALESCE(created_at, '')) AS mk
          FROM purchases
         WHERE COALESCE(unit_price, 0) > 0
         GROUP BY material_id
      ) t ON t.material_id = p.material_id
         AND t.mk = p.date || '|' || COALESCE(p.created_at, '')
     WHERE COALESCE(p.unit_price, 0) > 0
  `).all() as any[];

  const m = new Map<string, { unit_price: number; date: string }>();
  for (const r of rows) {
    if (!m.has(r.material_id)) m.set(r.material_id, { unit_price: Number(r.unit_price) || 0, date: r.date });
  }
  return m;
}

/** Value a counted RECIPE quantity of a raw material. */
export function valueCount(
  db: any,
  material: { id: string; unit?: string | null; purchase_unit?: string | null; pack_size?: number | null; average_price?: number | null },
  recipeQty: number,
  preloaded?: { unit_price: number; date: string } | null,
): ValuedCount {
  const rate = materialRate(db, material, preloaded);
  const qty = Number(recipeQty) || 0;
  const purchaseQty = toPurchaseQty(qty, material as PackMeta);
  return {
    ...rate,
    recipeQty: qty,
    purchaseQty,
    totalValue: r2(purchaseQty * rate.ratePerPurchaseUnit),
  };
}

/**
 * Value a counted quantity of a SEMI-FINISHED item (a sub-recipe).
 *
 * Deliberately simpler than the raw-material path and not routed through it:
 * a sub-recipe is counted in its own yield_unit and costed by cost_per_unit
 * (Rs per yield_unit), so there is no purchase unit and no pack factor to
 * apply. Running it through packFactor would be a category error.
 */
export function valueSemiCount(
  sub: { cost_per_unit?: number | null; yield_unit?: string | null },
  qty: number,
): { rate: number; unit: string; totalValue: number; source: RateSource } {
  const rate = Number(sub.cost_per_unit) || 0;
  const q = Number(qty) || 0;
  return {
    rate,
    unit: String(sub.yield_unit || '').trim(),
    totalValue: r2(q * rate),
    source: rate > 0 ? 'average_cost' : 'none',
  };
}
