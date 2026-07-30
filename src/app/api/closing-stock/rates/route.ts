import { getDb } from '@/lib/db';
import { materialRate, rateMap } from '@/lib/closing-valuation';
import { packFactor, type PackMeta } from '@/lib/pack-units';

/**
 * ₹/PURCHASE-unit rate for raw materials, resolved through the shared ladder
 * (last purchase → average cost → none). Read-only; writes nothing.
 *
 * WHY IT EXISTS: a count sheet shows lines that have not been counted yet, so
 * there is no closing_stock row to carry a stored rate. Those lines still need
 * a price to preview a line value. The alternative — each surface fetching
 * `last_purchase_price` itself — is exactly the bug this module exists to
 * prevent: that column is stored in mixed bases (100 PIPERS holds 2.21 where
 * the true rate is ₹1,905.31/BTL). One endpoint, one ladder, no local copies.
 *
 * IMPORTANT: this is TODAY's rate. It is a preview for an uncounted line only.
 * A SAVED count carries its own stored rate (closing_stock.rate_per_purchase_unit)
 * and must be read back from ../route.ts — never repriced from here, or last
 * week's sheet silently changes value.
 *
 *   GET /api/closing-stock/rates                      → every central material
 *   GET /api/closing-stock/rates?material_ids=a,b,c   → just those
 *
 * Value of a counted quantity = toPurchaseQty(recipeQty, meta) × rate.
 * Never hand-roll that divide — import toPurchaseQty from '@/lib/pack-units'.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const idsParam = (url.searchParams.get('material_ids') || '').trim();
    const ids = idsParam ? idsParam.split(',').map(s => s.trim()).filter(Boolean) : [];

    let sql = `
      SELECT rm.id, rm.name, rm.unit, rm.average_price,
             COALESCE(NULLIF(TRIM(rm.purchase_unit),''), rm.unit) AS purchase_unit,
             COALESCE(rm.pack_size, 1) AS pack_size
        FROM raw_materials rm
    `;
    const params: any[] = [];
    if (ids.length > 0) {
      sql += ` WHERE rm.id IN (${ids.map(() => '?').join(',')})`;
      params.push(...ids);
    }

    const mats = db.prepare(sql).all(...params) as any[];

    // ONE purchase query for the whole set, then a pure lookup per material —
    // never a "latest purchase" scan per line.
    const rates = rateMap(db);

    const out: Record<string, {
      rate_per_purchase_unit: number;
      rate_source: string;
      rate_as_of: string | null;
      unit: string;
      purchase_unit: string;
      pack_factor: number;
    }> = {};

    let priced = 0;
    for (const m of mats) {
      const r = materialRate(db, m, rates.get(m.id) ?? null);
      if (r.source !== 'none') priced++;
      out[m.id] = {
        rate_per_purchase_unit: r.ratePerPurchaseUnit,
        rate_source: r.source,
        rate_as_of: r.asOf ?? null,
        unit: m.unit,
        purchase_unit: m.purchase_unit,
        pack_factor: packFactor(m as PackMeta),
      };
    }

    return Response.json({ rates: out, count: mats.length, priced, unpriced: mats.length - priced });
  } catch (e: any) {
    console.error('[closing-stock/rates]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
