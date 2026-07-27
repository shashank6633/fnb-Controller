import { getDb, logAuditEvent } from '@/lib/db';
import { effectiveRole, effectiveActor, zeroRateBlocker } from '@/lib/po-helpers';

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
    // Zero-rate gate — same checks as before, now in po-helpers so the path that
    // skips this route runs them too: with po_require_admin_approval off, submit
    // auto-approves, and turning that switch off must not drop the only thing
    // keeping a ₹0 draft line out of the books (a ₹0 purchases row makes
    // updateMaterialPrice wipe the material's average_price to 0 and cascade a
    // "free" ingredient through every recipe).
    const rateBlocker = zeroRateBlocker(db, id);
    if (rateBlocker) {
      return Response.json({ error: rateBlocker, field: 'unit_price' }, { status: 400 });
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
