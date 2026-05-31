import { getDb, logAuditEvent } from '@/lib/db';
import { getCurrentUser, canApproveAsChef } from '@/lib/auth';

/**
 * Head Chef rejects a submitted requisition → moves to 'chef_rejected'.
 * Body: { reason }   — required (no silent rejections)
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canApproveAsChef(me)) return Response.json({ error: 'Head chef permission required' }, { status: 403 });

    const { id } = await params;
    const db = getDb();
    const r = db.prepare('SELECT * FROM requisitions WHERE id = ?').get(id) as any;
    if (!r) return Response.json({ error: 'Not found' }, { status: 404 });
    if (r.status !== 'submitted') {
      return Response.json({ error: `Only submitted requisitions can be rejected (current: ${r.status})` }, { status: 400 });
    }

    const body = await req.json().catch(() => ({}));
    // Accept `reason` (canonical) or legacy `note` for back-compat with any
    // older client that hasn't been redeployed yet.
    const reason = String(body?.reason || body?.note || '').trim();
    if (!reason) return Response.json({ error: 'reason required' }, { status: 400 });

    db.prepare(`
      UPDATE requisitions
      SET status = 'chef_rejected', rejected_at = datetime('now'),
          rejected_by = ?, rejected_reason = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(me.email, reason, id);
    // Audit: capture chef rejection with reason and prior status for traceability.
    try {
      logAuditEvent(db, {
        event_type: 'requisition.chef_reject',
        entity_type: 'requisition',
        entity_id: id,
        actor_email: me.email,
        before: { status: r.status },
        after: { status: 'chef_rejected', reason },
        note: reason,
      });
    } catch { /* audit must never break the action */ }
    return Response.json({ success: true, status: 'chef_rejected' });
  } catch (e: any) {
    console.error('[req chef-reject]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
