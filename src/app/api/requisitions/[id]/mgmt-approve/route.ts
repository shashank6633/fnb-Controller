import { getDb } from '@/lib/db';
import { getCurrentUser, canApproveAsMgmt } from '@/lib/auth';

/**
 * Phase 1 §2 — Management approves a chef-approved requisition (2nd gate).
 * Flow:  draft → submitted → chef_approved → mgmt_approved → store_processed
 *
 * Body: { note? }
 * Only admin (or future explicit `is_management` user) can call this.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canApproveAsMgmt(me)) return Response.json({ error: 'Management approval permission required' }, { status: 403 });

    const { id } = await params;
    const db = getDb();
    const r = db.prepare('SELECT * FROM requisitions WHERE id = ?').get(id) as any;
    if (!r) return Response.json({ error: 'Not found' }, { status: 404 });
    if (r.status !== 'chef_approved') {
      return Response.json({ error: `Only chef-approved requisitions can be management-approved (current: ${r.status})` }, { status: 400 });
    }

    const body = await req.json().catch(() => ({}));
    const note: string = body?.note || '';

    db.prepare(`
      UPDATE requisitions
      SET status = 'mgmt_approved', mgmt_approved_at = datetime('now'),
          mgmt_approved_by = ?, mgmt_note = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(me.email, note, id);
    return Response.json({ success: true, status: 'mgmt_approved' });
  } catch (e: any) {
    console.error('[req mgmt-approve]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
