import { getDb, logAuditEvent } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Phase 1 §2 — Final stage: department staff confirms physical receipt of issued goods.
 * Runs on a fulfilled requisition. Drafter (or anyone in the dept; admin) can ack.
 *
 * Body: { note? }
 * Sets dept_acknowledged_at + _by + _note. Status stays 'fulfilled' — this is the
 * "items inward into dept" audit confirmation, not another workflow gate.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id } = await params;
    const db = getDb();
    const r = db.prepare('SELECT * FROM requisitions WHERE id = ?').get(id) as any;
    if (!r) return Response.json({ error: 'Not found' }, { status: 404 });
    if (r.status !== 'fulfilled') {
      return Response.json({ error: `Only fulfilled requisitions can be acknowledged (current: ${r.status})` }, { status: 400 });
    }
    if (r.dept_acknowledged_at) {
      return Response.json({ error: 'Already acknowledged' }, { status: 400 });
    }
    // Permission: drafter, anyone in the same dept, or admin
    if (me.role !== 'admin' && r.drafted_by !== me.email && me.department_id !== r.department_id) {
      return Response.json({ error: 'Only the dept staff or admin can acknowledge' }, { status: 403 });
    }
    const body = await req.json().catch(() => ({}));
    db.prepare(`
      UPDATE requisitions
      SET dept_acknowledged_at = datetime('now'),
          dept_acknowledged_by = ?,
          dept_ack_note        = ?,
          updated_at           = datetime('now')
      WHERE id = ?
    `).run(me.email, String(body?.note || ''), id);
    logAuditEvent(db, {
      event_type: 'requisition.acknowledge',
      entity_type: 'requisition',
      entity_id: id,
      actor_email: me.email,
      note: String(body?.note || ''),
    });
    return Response.json({ success: true });
  } catch (e: any) {
    console.error('[req acknowledge]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
