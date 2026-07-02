import { getDb, logAuditEvent } from '@/lib/db';
import { effectiveRole, effectiveActor } from '@/app/api/purchase-orders/route';

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
    const body = await req.json().catch(() => ({}));
    const note = String(body?.approval_note || '').trim();
    const actor = await effectiveActor();
    db.prepare(`
      UPDATE purchase_orders
      SET status = 'approved',
          approved_by = ?,
          approved_at = datetime('now'),
          approval_note = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(actor, note, id);
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
