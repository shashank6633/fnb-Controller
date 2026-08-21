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
    // ── WHICH RECEIPTS THIS REPORT MAY SPEAK FOR ─────────────────────────────
    // This is the VENDOR-ACCOUNTABILITY report: accept_delta below is
    // (quantity_accepted − quantity_ordered), i.e. "what the vendor still owes
    // us". Two GRN states make that subtraction a lie, and both of them read as
    // the vendor's fault when they are not:
    //
    //   awaiting_qc — a held delivery deliberately carries quantity_accepted = 0
    //     until the kitchen signs (src/lib/grn-qc.ts, "WHAT quantity_accepted
    //     MEANS WHILE A GRN WAITS"). A PO for 100 kg where the vendor delivered
    //     80 was reporting accept_delta −100 and ₹20,000 short instead of −20 and
    //     ₹4,000 — a 5× overstatement, ON THE DAY THE DELIVERY LANDS, which is
    //     the only day anybody can act on it. It self-heals at sign-off, which is
    //     precisely what makes it dangerous: the number is wrong exactly while it
    //     is being read. A delivery that has not been judged yet has no vendor
    //     verdict to report; it belongs in Pending Quality Checks, not here.
    //   void — a cancelled receipt whose stock was reversed. Its LINES survive
    //     (they are the document) and, if it was voided while held, its
    //     quantity_accepted stays 0 for ever, so it reports a permanent phantom
    //     shortfall for a delivery that no longer stands. The same exclusion the
    //     inward register and the anomalies digest already make by name.
    //
    // Applied to `where`, so `receipts_in_range` below counts the same universe
    // — a denominator that includes rows the numerator can never see would make
    // "0 of 5 receipts flagged" unexplainable.
    const where: string[] = ['g.po_id IS NOT NULL', `COALESCE(g.status, '') NOT IN ('void', 'awaiting_qc')`];
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

    // How many PO-linked GRN lines exist in this window AT ALL — variance or not.
    // The page has always read `summary.receipts_in_range` (it is what lets the
    // empty state say "no receipts to compare" instead of wrongly congratulating
    // the buyer on a clean month) but the route never sent it, so the optional
    // field was permanently undefined and the honest branch was dead code.
    // Same WHERE and the same INNER JOIN on raw_materials as the query above, minus
    // only the variance predicate — otherwise a line whose material row is gone
    // would be counted here but could never appear in `rows`, and "0 of 5 receipts
    // flagged" would be unexplainable.
    const receipts_in_range = (db.prepare(`
      SELECT COUNT(*) AS c
      FROM goods_receipt_note_items gi
      JOIN goods_receipt_notes g ON g.id = gi.grn_id
      JOIN raw_materials rm ON rm.id = gi.material_id
      WHERE ${where.join(' AND ')}
    `).get(...params) as { c: number } | undefined)?.c ?? 0;

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
        receipts_in_range,
      },
      rows,
    });
  } catch (e: any) {
    console.error('[receiving-variance]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
