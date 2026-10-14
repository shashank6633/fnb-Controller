import { getDb } from '@/lib/db';
import {
  rateVarianceForIndent, rateMovementForStore, brandMapById,
  type LqRateVarianceRow,
} from '@/lib/liquor-recon';
import { requireBrandMapAdmin, gateResponse, requireAuditedWrite } from '../_lib/guard';

/**
 * RATE-VS-MASTER VARIANCE — the workbook's Summary §G "rate movement watch",
 * over the RECORDED inward lines (phase L1).
 *
 *   GET  /api/liquor/brand-map/variance
 *          ?store_id=&from=&to=&invoice_ref=&only_variance=1
 *   POST /api/liquor/brand-map/variance   { ledger_id, brand_map_id }
 *          → accept the rate that line actually arrived at INTO the master
 *
 * READ AND WRITE ARE SEPARATE ON PURPOSE. The L0 contract for
 * rateVarianceForIndent says so in as many words: "accepting a new rate into
 * the master is a separate, AUDITED write ... never a side effect of reading."
 * The GET therefore never repairs anything it notices.
 *
 * THE POST NEVER TRUSTS A CLIENT-SENT RATE. It takes a LEDGER LINE id, re-reads
 * that line through the same rateVarianceForIndent() the screen rendered, and
 * writes rate_per_case_master = (that line's ₹/bottle) × bottles_per_case. So
 * the figure accepted is exactly the figure shown, and a crafted request cannot
 * set an arbitrary master price. The mapping must belong to the line's own
 * material, or the request is refused — accepting a rate onto the wrong brand
 * would silently re-price everything else that brand touches.
 *
 * VALUATION IS NOT TOUCHED. The accept writes lq_brand_map.rate_per_case_master
 * and audit_events. It does NOT write raw_materials.average_price,
 * raw_materials.last_purchase_price or store_stock_ledger.unit_cost — plan
 * decision 1(a). What the bar paid is already recorded on the ledger line; this
 * only updates the TGBCL master the line is COMPARED against.
 *
 * Gate: ADMIN + CSRF (../_lib/guard.ts). page-catalog declares
 * /inventory/liquor-brand-map adminOnly and warns that the catalog is never the
 * security boundary — this is the boundary.
 */
export const dynamic = 'force-dynamic';

/**
 * A RATE HAS MOVED WHEN IT HAS MOVED BY AT LEAST A PAISA PER BOTTLE.
 *
 * This was `Math.abs(variance) > 1e-6`, and at that resolution an accepted rate
 * could not always clear its own flag. The master stores ₹ per CASE at 2dp
 * (round2(indentRate × bottles_per_case)) and the watch reads it back as ₹ per
 * BOTTLE (round4(rate_per_case_master ÷ bottles_per_case)); that round trip is
 * exact only when the two divisors agree, and nothing keeps a mapping's
 * bottles_per_case equal to the material's case_size. When they differ, up to
 * 0.005/bottles_per_case of the 2dp rounding survives the division and comes
 * back as a permanent variance — proved at ₹0.0002/bottle, on a line whose
 * varianceValue rounds to ₹0.00. The operator was handed a red row worth
 * nothing that no amount of clicking could clear, and an Accept that replied
 * "the master already holds this rate".
 *
 * The rule is now L5 §G's, character for character (liquor-summary.ts eqPaise):
 * a variance is real when it rounds to at least one paisa. Two screens over one
 * number must not disagree about whether it moved. The page applies the same
 * test (src/app/inventory/liquor-brand-map/page.tsx).
 */
const hasMoved = (variance: number | null): boolean =>
  variance !== null && Math.round((Number(variance) || 0) * 100) !== 0;

export async function GET(request: Request) {
  const gate = await requireBrandMapAdmin(request);
  if (!gate.ok) return gateResponse(gate);
  try {
    const db = getDb();
    const qs = new URL(request.url).searchParams;
    const storeId = (qs.get('store_id') || '').trim();
    const invoiceRef = (qs.get('invoice_ref') || '').trim();
    const from = (qs.get('from') || '').trim();
    const to = (qs.get('to') || '').trim();
    const onlyVariance = qs.get('only_variance') === '1';

    // The stores that actually hold liquor purchase lines, so the page can
    // offer a picker without hardcoding "LIQUOR STORE" (there are floor bars
    // too, and a store is config, never a name in code).
    const stores = db.prepare(`
      SELECT s.id, s.name, s.code
      FROM store_locations s
      WHERE s.is_active = 1
      ORDER BY s.name COLLATE NOCASE
    `).all() as any[];

    let rows: LqRateVarianceRow[] = [];
    if (invoiceRef) {
      rows = rateVarianceForIndent(db, { invoiceRef, storeId: storeId || undefined });
    } else if (storeId) {
      rows = rateMovementForStore(db, storeId, from || undefined, to || undefined);
    } else {
      for (const s of stores) rows.push(...rateMovementForStore(db, String(s.id), from || undefined, to || undefined));
    }

    const moved = rows.filter(r => hasMoved(r.variance));
    const unmapped = rows.filter(r => r.masterRate === null);
    const shown = onlyVariance ? moved : rows;

    return Response.json({
      ok: true,
      stores,
      rows: shown,
      summary: {
        lines: rows.length,
        moved: moved.length,
        unmapped: unmapped.length,
        /** Σ |variance × bottles| — what the rate movement is worth over the range. */
        moved_value: Math.round(moved.reduce((s, r) => s + Math.abs(Number(r.varianceValue) || 0), 0) * 100) / 100,
      },
    });
  } catch (e: any) {
    console.error('[GET /api/liquor/brand-map/variance]', e);
    return Response.json({ error: 'Could not load rate movement.' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const gate = await requireBrandMapAdmin(request);
  if (!gate.ok) return gateResponse(gate);
  try {
    const db = getDb();
    const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const ledgerId = String(b.ledger_id ?? '').trim();
    const brandMapId = String(b.brand_map_id ?? '').trim();
    if (!ledgerId || !brandMapId) {
      return Response.json({ error: 'ledger_id and brand_map_id are required' }, { status: 400 });
    }

    const line = db.prepare(`
      SELECT id, store_id, TRIM(ref) AS invoice_ref, material_id
      FROM store_stock_ledger WHERE id = ? AND txn_type = 'purchase'
    `).get(ledgerId) as any;
    if (!line) return Response.json({ error: 'That inward line no longer exists.' }, { status: 404 });

    const bm = brandMapById(db, brandMapId);
    if (!bm) return Response.json({ error: 'That brand mapping no longer exists.' }, { status: 404 });
    if (String(bm.material_id) !== String(line.material_id)) {
      return Response.json({
        error: 'That mapping is for a different material — accepting the rate would re-price the wrong brand.',
      }, { status: 400 });
    }
    if (!(bm.bottles_per_case > 0)) {
      return Response.json({ error: 'That mapping has no bottles per case, so a rate per case cannot be derived.' }, { status: 400 });
    }

    // Re-read the variance through the SAME function the screen rendered, so
    // the accepted rate is provably the one that was shown.
    const rows = rateVarianceForIndent(db, {
      invoiceRef: String(line.invoice_ref || ''), storeId: String(line.store_id),
    });
    const row = rows.find(r => r.ledgerId === ledgerId);
    if (!row) return Response.json({ error: 'That inward line could not be re-read.' }, { status: 409 });

    // THE PACK, NOT JUST THE MATERIAL. The material check above exists because
    // "accepting a rate onto the wrong brand would silently re-price everything
    // else that brand touches" — and the same is true of the wrong PACK of the
    // right brand: a 750 ml line's ₹/bottle multiplied by a 48-bottle case
    // writes a master no bottle was ever bought at. When the watch resolved a
    // pack for this line, that is the only pack this line can be accepted into.
    // (An 'ambiguous_pack' line resolves to no mapping and brandMapId is '', so
    // an admin can still name the pack deliberately — the screen offers no
    // button there, which is why naming one is an explicit choice.)
    if (row.brandMapId && row.brandMapId !== brandMapId) {
      return Response.json({
        error: `This line resolves to pack ${row.tgbclBrandCode}${row.sizeCode ? '-' + row.sizeCode : ''}. `
          + 'Accepting its rate into a different pack of the same brand would write a rate per case that was never paid.',
      }, { status: 400 });
    }

    const newRatePerCase = Math.round(row.indentRate * bm.bottles_per_case * 100) / 100;
    const oldRatePerCase = Math.round(bm.rate_per_case_master * 100) / 100;
    if (Math.abs(newRatePerCase - oldRatePerCase) < 0.005) {
      return Response.json({
        ok: true, unchanged: true,
        rate_per_case_master: oldRatePerCase,
        message: 'The master already holds this rate — nothing was changed.',
      });
    }

    const run = db.transaction(() => {
      db.prepare(
        "UPDATE lq_brand_map SET rate_per_case_master = ?, updated_at = datetime('now') WHERE id = ?",
      ).run(newRatePerCase, brandMapId);
      requireAuditedWrite(db, {
        event_type: 'liquor.brand_map.rate_accept',
        entity_type: 'lq_brand_map',
        entity_id: brandMapId,
        actor_email: gate.user.email,
        before: { rate_per_case_master: oldRatePerCase, rate_per_bottle: bm.rate_per_bottle_master },
        after: {
          rate_per_case_master: newRatePerCase,
          rate_per_bottle: row.indentRate,
          source: {
            ledger_id: ledgerId, store_id: String(line.store_id),
            invoice_ref: row.invoiceRef, inward_date: row.inwardDate,
            supplier: row.supplier, material_id: row.materialId, material: row.materialName,
            bottles: row.bottles, variance_per_bottle: row.variance,
            variance_value: row.varianceValue,
          },
          tgbcl_brand_code: bm.tgbcl_brand_code, size_code: bm.size_code,
          bottles_per_case: bm.bottles_per_case,
        },
        note: `Accepted the indent rate into the TGBCL master for ${bm.tgbcl_brand_code}`
          + `${bm.size_code ? '-' + bm.size_code : ''} (${row.materialName}): `
          + `₹${oldRatePerCase} → ₹${newRatePerCase} per case, from ${row.invoiceRef || 'an inward line'}`
          + ` dated ${row.inwardDate}. Valuation unchanged (recorded-only).`,
      }, 'this change to the TGBCL master rate');
    });
    run();

    return Response.json({
      ok: true,
      brand_map_id: brandMapId,
      rate_per_case_master: newRatePerCase,
      rate_per_bottle_master: Math.round(row.indentRate * 1e4) / 1e4,
      was: oldRatePerCase,
    });
  } catch (e: any) {
    console.error('[POST /api/liquor/brand-map/variance]', e);
    return Response.json({ error: String(e?.message || 'Could not accept the rate.') }, { status: 500 });
  }
}
