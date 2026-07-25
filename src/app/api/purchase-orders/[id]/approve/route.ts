import { getDb, logAuditEvent } from '@/lib/db';
import { effectiveRole, effectiveActor } from '@/lib/po-helpers';

// Admin-only: approve a pending PO.
// Optional body: { approval_note?: string } — recorded for audit when admin overrides flags.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = getDb();
    const role = await effectiveRole();
    if (!role) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (role !== 'admin') {
      return Response.json({ error: 'Only Admin can approve POs' }, { status: 403 });
    }
    const po = db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(id) as any;
    if (!po) return Response.json({ error: 'Not found' }, { status: 404 });
    // Accept first approval (pending) AND re-approval after an edit (pending_reapproval).
    if (po.status !== 'pending' && po.status !== 'pending_reapproval') {
      return Response.json({ error: `Only pending POs can be approved (current: ${po.status})` }, { status: 400 });
    }
    // Zero-rate gate. A 0/blank rate is legal on a DRAFT on purpose (Smart
    // Reorder drafts a line whose ₹/purchase-unit is not known yet — see
    // lineSanityError in /api/purchase-orders/route.ts), but approval is the last
    // decision gate before the vendor ships: [id]/receive rejects a 0 rate on
    // every line it books (a ₹0 purchases row makes updateMaterialPrice wipe the
    // material's average_price to 0 and cascade a "free" ingredient through every
    // recipe), so leaving it to receive strands goods the warehouse is already
    // holding. Same JOIN receive uses, so this blocks exactly the lines receive
    // would process. Number.isFinite first — a bare `<= 0` is false for NaN.
    const rateLines = db.prepare(`
      SELECT poi.unit_price, rm.name AS material_name,
             COALESCE(NULLIF(TRIM(rm.purchase_unit), ''), rm.unit) AS material_purchase_unit
      FROM purchase_order_items poi
      JOIN raw_materials rm ON rm.id = poi.material_id
      WHERE poi.po_id = ?
    `).all(id) as any[];
    for (const line of rateLines) {
      const px = Number(line.unit_price);
      if (!Number.isFinite(px) || px <= 0) {
        // Unit label = the PURCHASE unit: a PO line's rate is ₹ per purchase
        // unit (canon), so "₹/kg" here, never the recipe unit.
        const unit = String(line.material_purchase_unit || '').trim() || 'unit';
        return Response.json({
          error: `Missing or zero rate on "${line.material_name}" (${px}). Approving commits this PO and receiving it would rewrite the material's average price, so the line needs a real ₹/${unit} — reject this PO, revise it with the rate and re-submit.`,
          material: line.material_name,
          field: 'unit_price',
        }, { status: 400 });
      }
    }

    const body = await req.json().catch(() => ({}));
    const note = String(body?.approval_note || '').trim();
    const actor = await effectiveActor();
    // Atomic claim: the status check above is separated from this write by two
    // awaits (req.json + effectiveActor), so a reject/receive that lands in that
    // window would be silently overwritten (lost update). Re-assert the
    // precondition in the WHERE clause and 409 when it no longer holds.
    const claim = db.prepare(`
      UPDATE purchase_orders
      SET status = 'approved',
          approved_by = ?,
          approved_at = datetime('now'),
          approval_note = ?,
          updated_at = datetime('now')
      WHERE id = ? AND status IN ('pending', 'pending_reapproval')
    `).run(actor, note, id);
    if (claim.changes === 0) {
      return Response.json({ error: 'This PO is no longer pending approval (someone else decided it). Reload the page.' }, { status: 409 });
    }
    logAuditEvent(db, {
      event_type: 'po.approve',
      entity_type: 'purchase_order',
      entity_id: id,
      actor_email: actor,
      before: { status: po.status },
      after: { status: 'approved' },
      note,
    });
    return Response.json({ success: true, status: 'approved' });
  } catch (e: any) { return Response.json({ error: e.message }, { status: 500 }); }
}
