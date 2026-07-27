import { getDb } from '@/lib/db';
import { getCurrentOutletId, getCurrentUser } from '@/lib/auth';

/**
 * Receiving Variance — Phase 1 §4 spec: "There will be scenarios of mismatch
 * between PO & Actual Received qty, it should reflect the same in reports."
 *
 * Per GRN line: ordered (from PO) vs received (physical) vs accepted (after QC).
 * Returns lines where any of these don't match (excluding ad-hoc GRNs which have
 * no parent PO and therefore no "ordered" benchmark).
 *
 * Query: ?from=&to=&vendor_id=
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  try {
    // This GET had no auth of its own. proxy.ts only checks that an fnb_session
    // cookie is PRESENT for a read — it validates the token against the sessions
    // table solely for state-changing methods ("sensitive GETs authenticate
    // in-handler"), and getCurrentOutletId() below returns the default outlet even
    // with no user, so the query still ran. A forged or long-expired cookie value
    // therefore got vendor names, PO numbers, every per-purchase-unit rate and
    // average_price. Same bar as /api/purchase-orders GET: open to any signed-in
    // user, but no further.
    const viewer = await getCurrentUser();
    if (!viewer) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const url = new URL(request.url);
    const from = url.searchParams.get('from');
    const to   = url.searchParams.get('to');
    const vendorId = url.searchParams.get('vendor_id');
    const where: string[] = ['g.po_id IS NOT NULL'];
    const params: any[] = [];
    const outletId = await getCurrentOutletId();
    if (outletId)  { where.push('(g.outlet_id = ? OR g.outlet_id IS NULL)'); params.push(outletId); }
    if (from)      { where.push('g.date >= ?'); params.push(from); }
    if (to)        { where.push('g.date <= ?'); params.push(to); }
    if (vendorId)  { where.push('g.vendor_id = ?'); params.push(vendorId); }

    const rows = db.prepare(`
      WITH v AS (
        SELECT
          g.id            AS grn_id,
          g.grn_number,
          g.date,
          g.vendor,
          po.po_number,
          rm.id           AS material_id,
          rm.name         AS material_name,
          rm.sku          AS material_sku,
          rm.unit         AS material_unit,
          rm.pack_size,
          -- Resolve the PURCHASE unit here, the same expression the PO and GRN
          -- queries use, so the client never has to guess: a material with a blank
          -- or whitespace-only purchase_unit falls back to its recipe unit rather
          -- than rendering an empty label.
          COALESCE(NULLIF(TRIM(rm.purchase_unit), ''), rm.unit) AS purchase_unit,
          gi.quantity_ordered,
          gi.quantity_received,
          gi.quantity_accepted,
          gi.quantity_rejected,
          gi.rejection_reason,
          gi.unit_price,
          rm.average_price,
          (gi.quantity_received - gi.quantity_ordered)  AS receive_delta,
          (gi.quantity_accepted - gi.quantity_ordered)  AS accept_delta,
          -- ONE effective rate for EVERY rupee number in this report (short/excess
          -- value AND the QC-rejected rollup), so two cards can never value the same
          -- line on different bases.
          -- gi.quantity_* are PURCHASE units (kg, BTL, CASE) — the GRN stores the PO's
          -- numbers unchanged — but rm.average_price is Rs per RECIPE unit (Rs/g).
          -- Multiplying the two understated every PACK material's variance by pack_size
          -- (pack_size > 1 AND recipe unit <> purchase unit); a non-pack material —
          -- unit 'pcs' / purchase_unit 'pcs' / pack 1 — was already correct, which is
          -- exactly why the CASE keeps BOTH halves of the guard.
          -- Prefer the line's own rate (gi.unit_price is already Rs per purchase unit);
          -- fall back to the average lifted into purchase units. The fallback matters
          -- for rejections too: receiving blocks a 0 rate only when accepted > 0, so a
          -- FULLY rejected line legally stores unit_price 0 — reading gi.unit_price raw
          -- booked such a consignment as a Rs 0 QC loss while the short-supply card
          -- valued the same line off average_price.
          COALESCE(
            NULLIF(gi.unit_price, 0),
            rm.average_price * CASE
              WHEN COALESCE(rm.pack_size, 1) > 1
               AND LOWER(TRIM(rm.unit)) <> LOWER(TRIM(COALESCE(NULLIF(TRIM(rm.purchase_unit), ''), rm.unit)))
              THEN rm.pack_size ELSE 1 END
          ) AS eff_unit_price
        FROM goods_receipt_note_items gi
        JOIN goods_receipt_notes g ON g.id = gi.grn_id
        LEFT JOIN purchase_orders po ON po.id = g.po_id
        JOIN raw_materials rm ON rm.id = gi.material_id
        WHERE ${where.join(' AND ')}
          AND (gi.quantity_received != gi.quantity_ordered OR gi.quantity_rejected > 0)
      )
      SELECT v.*, (v.accept_delta * COALESCE(v.eff_unit_price, 0)) AS accept_delta_value
      FROM v
      ORDER BY v.date DESC, ABS(accept_delta_value) DESC
    `).all(...params) as any[];

    let net_value_short = 0, net_value_excess = 0, total_rejected_value = 0;
    const reasonStats: Record<string, { count: number; qty: number; value: number }> = {};
    for (const r of rows) {
      if (r.accept_delta < 0) net_value_short += -(r.accept_delta_value || 0);
      else if (r.accept_delta > 0) net_value_excess += r.accept_delta_value || 0;
      // eff_unit_price, NOT gi.unit_price — the same basis accept_delta_value uses.
      // A fully-rejected line can legally carry unit_price 0, which used to book the
      // QC loss at Rs 0 for a delivery the short-supply card valued in full.
      if (r.quantity_rejected > 0) total_rejected_value += (r.quantity_rejected * (r.eff_unit_price || 0));
      if (r.rejection_reason) {
        const slot = reasonStats[r.rejection_reason] || (reasonStats[r.rejection_reason] = { count: 0, qty: 0, value: 0 });
        slot.count += 1; slot.qty += r.quantity_rejected; slot.value += (r.quantity_rejected * (r.eff_unit_price || 0));
      }
    }

    return Response.json({
      range: { from, to },
      summary: {
        lines: rows.length,
        net_value_short, net_value_excess, total_rejected_value,
        reason_stats: reasonStats,
      },
      rows,
    });
  } catch (e: any) {
    console.error('[receiving-variance]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
