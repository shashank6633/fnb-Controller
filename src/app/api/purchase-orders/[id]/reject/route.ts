import { getDb, logAuditEvent } from '@/lib/db';
import { effectiveRole, effectiveActor } from '@/app/api/purchase-orders/route';

// Admin-only: reject a pending PO with reason.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = getDb();
    if (await effectiveRole() !== 'admin') {
      return Response.json({ error: 'Only Admin can reject POs' }, { status: 403 });
    }
    const body = await req.json().catch(() => ({}));
    const reason = String(body?.reason || '').trim();
    const po = db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(id) as any;
    if (!po) return Response.json({ error: 'Not found' }, { status: 404 });
    if (po.status !== 'pending') {
      return Response.json({ error: `Only pending POs can be rejected (current: ${po.status})` }, { status: 400 });
    }
    db.prepare(`
      UPDATE purchase_orders SET status = 'rejected', rejected_reason = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(reason, id);
    logAuditEvent(db, {
      event_type: 'po.reject', entity_type: 'purchase_order', entity_id: id,
      actor_email: await effectiveActor(),
      before: { status: po.status }, after: { status: 'rejected' }, note: reason,
    });
    return Response.json({ success: true, status: 'rejected' });
  } catch (e: any) { return Response.json({ error: e.message }, { status: 500 }); }
}
