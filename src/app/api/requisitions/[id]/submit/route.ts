import { getDb, logAuditEvent } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Submit a draft requisition → moves to 'submitted'.
 * The head chef will see it in their inbox.
 * Either the drafter or admin can submit.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id } = await params;
    const db = getDb();
    const r = db.prepare('SELECT * FROM requisitions WHERE id = ?').get(id) as any;
    if (!r) return Response.json({ error: 'Not found' }, { status: 404 });
    if (r.status !== 'draft') {
      return Response.json({ error: `Only drafts can be submitted (current: ${r.status})` }, { status: 400 });
    }
    if (r.drafted_by !== me.email && me.role !== 'admin') {
      return Response.json({ error: 'Only the drafter or admin can submit' }, { status: 403 });
    }
    const items = db.prepare('SELECT COUNT(*) AS n FROM requisition_items WHERE req_id = ?').get(id) as any;
    if (!items || items.n === 0) return Response.json({ error: 'Cannot submit an empty requisition' }, { status: 400 });

    // Phase 1 §2 — submission time windows. Each department may declare allowed
    // submission slots ("11:00,18:30") with a grace window. Admins can override
    // with `force_outside_window: true` in the body.
    const body = await req.json().catch(() => ({}));
    const force = body?.force_outside_window === true && me.role === 'admin';
    if (!force) {
      const dept = db.prepare('SELECT submission_windows, submission_grace_minutes, name FROM departments WHERE id = ?').get(r.department_id) as any;
      const windows = String(dept?.submission_windows || '').split(',').map((s: string) => s.trim()).filter(Boolean);
      if (windows.length > 0) {
        const now = new Date();
        const nowMin = now.getHours() * 60 + now.getMinutes();
        const grace = Number(dept?.submission_grace_minutes) || 30;
        const allowed = windows.some((w: string) => {
          const m = w.match(/^(\d{1,2}):(\d{2})$/); if (!m) return false;
          const slotMin = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
          return Math.abs(nowMin - slotMin) <= grace;
        });
        if (!allowed) {
          return Response.json({
            error: `Submission window closed. ${dept.name} accepts requisitions at: ${windows.join(', ')} (±${grace} min). Admin override available.`,
            outside_window: true,
            allowed_windows: windows,
            grace_minutes: grace,
          }, { status: 400 });
        }
      }
    }

    db.prepare(`
      UPDATE requisitions
      SET status = 'submitted', submitted_at = datetime('now'), submitted_by = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(me.email, id);
    // Audit: seed the requisition's timeline at submission so chef edits/approvals chain off a known origin.
    try {
      logAuditEvent(db, {
        event_type: 'requisition.submit',
        entity_type: 'requisition',
        entity_id: id,
        actor_email: me.email,
        before: { status: 'draft' },
        after: { status: 'submitted', items: items.n, force_outside_window: force || false },
      });
    } catch { /* audit must never break the action */ }
    return Response.json({ success: true, status: 'submitted' });
  } catch (e: any) {
    console.error('[req submit]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
