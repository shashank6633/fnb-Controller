import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Cancel a requisition (any non-terminal state). Drafter or admin only.
 * If a vendor PO was already linked & is still a draft, leave the PO alone — admin
 * can cancel it separately. We don't want to silently destroy that paper trail.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id } = await params;
    const db = getDb();
    const r = db.prepare('SELECT * FROM requisitions WHERE id = ?').get(id) as any;
    if (!r) return Response.json({ error: 'Not found' }, { status: 404 });
    const TERMINAL = ['fulfilled', 'cancelled', 'chef_rejected'];
    if (TERMINAL.includes(r.status)) {
      return Response.json({ error: `Cannot cancel — requisition is ${r.status}` }, { status: 400 });
    }
    // HOD/admin may cancel any live requisition. The department drafter may cancel
    // ONLY while it is still a draft — once submitted (Chef Inbox) or being issued
    // (Partially Issued / store_processed), only HOD or admin can cancel it.
    const isHodOrAdmin = me.role === 'admin' || !!me.is_head_chef;
    const mayCancel = isHodOrAdmin || (r.drafted_by === me.email && r.status === 'draft');
    if (!mayCancel) {
      return Response.json({
        error: 'Only HOD or admin can cancel a requisition once it has been submitted. The drafter can cancel it only while it is still a draft.',
      }, { status: 403 });
    }
    db.prepare(`
      UPDATE requisitions SET status = 'cancelled', cancelled_at = datetime('now'),
        cancelled_by = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(me.email, id);
    return Response.json({ success: true, status: 'cancelled' });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
