import { getDb } from '@/lib/db';
import { getCurrentOutletId } from '@/lib/auth';

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
        rm.pack_size, rm.purchase_unit,
        gi.quantity_ordered,
        gi.quantity_received,
        gi.quantity_accepted,
        gi.quantity_rejected,
        gi.rejection_reason,
        gi.unit_price,
        rm.average_price,
        (gi.quantity_received - gi.quantity_ordered)  AS receive_delta,
        (gi.quantity_accepted - gi.quantity_ordered)  AS accept_delta,
        ((gi.quantity_accepted - gi.quantity_ordered) * rm.average_price) AS accept_delta_value
      FROM goods_receipt_note_items gi
      JOIN goods_receipt_notes g ON g.id = gi.grn_id
      LEFT JOIN purchase_orders po ON po.id = g.po_id
      JOIN raw_materials rm ON rm.id = gi.material_id
      WHERE ${where.join(' AND ')}
        AND (gi.quantity_received != gi.quantity_ordered OR gi.quantity_rejected > 0)
      ORDER BY g.date DESC, ABS(accept_delta_value) DESC
    `).all(...params) as any[];

    let net_value_short = 0, net_value_excess = 0, total_rejected_value = 0;
    const reasonStats: Record<string, { count: number; qty: number; value: number }> = {};
    for (const r of rows) {
      if (r.accept_delta < 0) net_value_short += -(r.accept_delta_value || 0);
      else if (r.accept_delta > 0) net_value_excess += r.accept_delta_value || 0;
      if (r.quantity_rejected > 0) total_rejected_value += (r.quantity_rejected * (r.unit_price || 0));
      if (r.rejection_reason) {
        const slot = reasonStats[r.rejection_reason] || (reasonStats[r.rejection_reason] = { count: 0, qty: 0, value: 0 });
        slot.count += 1; slot.qty += r.quantity_rejected; slot.value += (r.quantity_rejected * (r.unit_price || 0));
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
