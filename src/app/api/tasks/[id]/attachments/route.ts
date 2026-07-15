/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { canManageTasks } from '@/lib/tasks';

/**
 * Task attachment removal (DELETE /api/tasks/:id/attachments?aid=<attachmentId>).
 *
 * Deletes a single saved `task_attachments` row belonging to task :id. This is
 * an ADDITIVE surface for the media/SOP-link work — an author who attached a
 * video / voice note / SOP link (or a task manager) can detach it again.
 *
 * Gate: signed-in AND (canManageTasks OR the task owner, i.e. tasks.created_by
 * matches the caller's email). The BLOB in task_files (if any) is intentionally
 * NOT hard-deleted here — files are content-addressed by id, may be shared, and
 * the module never hard-deletes; only the attachment reference is removed.
 *
 * CSRF on this mutation is enforced by proxy.ts (/api/tasks prefix).
 *
 *   DELETE /api/tasks/<taskId>/attachments?aid=<attachmentId>  → { ok: true }
 *   400 missing aid · 401 signed out · 403 not owner/manager · 404 not found
 */
export const dynamic = 'force-dynamic';

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  try {
    const { id } = await params;
    const aid = new URL(request.url).searchParams.get('aid');
    if (!aid) return Response.json({ error: 'Missing attachment id (aid)' }, { status: 400 });

    const db = getDb();
    const task = db.prepare(`SELECT id, created_by FROM tasks WHERE id = ?`).get(id) as any;
    if (!task) return Response.json({ error: 'Task not found' }, { status: 404 });

    const isOwner = (task.created_by || '').toLowerCase() === (me.email || '').toLowerCase();
    if (!canManageTasks(me) && !isOwner) {
      return Response.json({ error: 'Not authorised to remove this attachment' }, { status: 403 });
    }

    const att = db
      .prepare(`SELECT id FROM task_attachments WHERE id = ? AND task_id = ?`)
      .get(aid, id) as any;
    if (!att) return Response.json({ error: 'Attachment not found' }, { status: 404 });

    db.prepare(`DELETE FROM task_attachments WHERE id = ? AND task_id = ?`).run(aid, id);
    return Response.json({ ok: true });
  } catch (e: any) {
    console.error('DELETE /api/tasks/[id]/attachments failed:', e);
    return Response.json({ error: e?.message || 'Failed to remove attachment' }, { status: 500 });
  }
}
