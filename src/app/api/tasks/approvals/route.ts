/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { canApproveTasks, parseMentions } from '@/lib/tasks';

/**
 * Task Approvals (/api/tasks/approvals).
 *
 * GET  /api/tasks/approvals?q=&department=&priority=
 *        → { rows: Task[] } — tasks sitting in `waiting_verification`, i.e. the
 *          verification queue for approvers. Optional title/description search
 *          and department / priority filters. Ordered urgent-first then by due
 *          date. Non-archived only.
 *
 * POST /api/tasks/approvals  { task_id, decision: 'approved'|'reopened', note? }
 *        approved → status=approved, approved_at/by set.
 *        reopened → status=reopened (bounced back to the assignee to redo).
 *        Both write task_status_history + resolve/insert a task_approvals row +
 *        notify the assignee. @mentions in the note fan out to task_mentions +
 *        task_notifications too.
 *
 * Gate (both verbs): admin, manager tier, head chef, or store manager
 * (canApproveTasks). Signed-out → 401; lacking the gate → 403.
 * CSRF on POST is enforced by proxy.ts (/api/tasks prefix).
 */
export const dynamic = 'force-dynamic';

async function gate(): Promise<{ me: any } | { resp: Response }> {
  const me = await getCurrentUser();
  if (!me) return { resp: Response.json({ error: 'Sign in required' }, { status: 401 }) };
  if (!canApproveTasks(me)) {
    return { resp: Response.json({ error: 'Not authorised to approve tasks' }, { status: 403 }) };
  }
  return { me };
}

export async function GET(request: Request) {
  const g = await gate();
  if ('resp' in g) return g.resp;
  try {
    const db = getDb();
    const url = new URL(request.url);
    const q = (url.searchParams.get('q') || '').trim();
    const department = (url.searchParams.get('department') || '').trim();
    const priority = (url.searchParams.get('priority') || '').trim();

    const where: string[] = [`t.status = 'waiting_verification'`, `t.is_archived = 0`];
    const params: any[] = [];
    if (q) {
      where.push(`(t.title LIKE ? OR t.description LIKE ?)`);
      params.push(`%${q}%`, `%${q}%`);
    }
    if (department) { where.push(`t.department = ?`); params.push(department); }
    if (priority) { where.push(`t.priority = ?`); params.push(priority); }

    const rows = db.prepare(`
      SELECT t.* FROM tasks t
      WHERE ${where.join(' AND ')}
      ORDER BY
        CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        CASE WHEN t.due_date = '' THEN 1 ELSE 0 END, t.due_date ASC,
        t.updated_at DESC
      LIMIT 500
    `).all(...params) as any[];

    return Response.json({ rows });
  } catch (e: any) {
    console.error('GET /api/tasks/approvals failed:', e);
    return Response.json({ error: e?.message || 'Failed to load approval queue' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const g = await gate();
  if ('resp' in g) return g.resp;
  const me = g.me;

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }

  const taskId = String(body?.task_id ?? '').trim();
  const decision = String(body?.decision ?? '').trim();
  const note = String(body?.note ?? '').trim();

  if (!taskId) return Response.json({ error: 'task_id is required' }, { status: 400 });
  if (decision !== 'approved' && decision !== 'reopened') {
    return Response.json({ error: "decision must be 'approved' or 'reopened'" }, { status: 400 });
  }

  try {
    const db = getDb();
    const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as any;
    if (!task) return Response.json({ error: 'Task not found' }, { status: 404 });
    if (task.status !== 'waiting_verification') {
      return Response.json(
        { error: `Task is '${task.status}', not awaiting verification` },
        { status: 409 },
      );
    }

    const fromStatus = task.status;
    const toStatus = decision === 'approved' ? 'approved' : 'reopened';
    const actorEmail = me.email || '';
    const actorName = me.name || me.email || '';

    const tx = db.transaction(() => {
      // 1. Move the task.
      if (decision === 'approved') {
        db.prepare(`
          UPDATE tasks
          SET status = 'approved', approved_at = datetime('now'), approved_by = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(actorEmail, taskId);
      } else {
        db.prepare(`
          UPDATE tasks
          SET status = 'reopened', updated_at = datetime('now')
          WHERE id = ?
        `).run(taskId);
      }

      // 2. Status history.
      db.prepare(`
        INSERT INTO task_status_history (id, task_id, from_status, to_status, changed_by, note)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(generateId(), taskId, fromStatus, toStatus, actorEmail, note);

      // 3. Resolve the pending approval row (or record one if none is open).
      const pending = db.prepare(`
        SELECT id FROM task_approvals WHERE task_id = ? AND decision = 'pending'
        ORDER BY created_at DESC LIMIT 1
      `).get(taskId) as any;
      if (pending) {
        db.prepare(`
          UPDATE task_approvals
          SET decision = ?, approver_email = ?, note = ?, decided_at = datetime('now')
          WHERE id = ?
        `).run(decision, actorEmail, note, pending.id);
      } else {
        db.prepare(`
          INSERT INTO task_approvals (id, task_id, requested_by, approver_email, decision, note, decided_at)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
          generateId(), taskId,
          task.assignee_email || task.created_by || '',
          actorEmail, decision, note,
        );
      }

      // 4. Notify the assignee of the outcome.
      if (task.assignee_email) {
        const title = decision === 'approved'
          ? `Task approved: ${task.title}`
          : `Task reopened: ${task.title}`;
        const nbody = decision === 'approved'
          ? `${actorName} approved your task.${note ? ` Note: ${note}` : ''}`
          : `${actorName} reopened your task for rework.${note ? ` Note: ${note}` : ''}`;
        db.prepare(`
          INSERT INTO task_notifications (id, recipient_email, kind, title, body, task_id, href)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(generateId(), task.assignee_email, decision === 'approved' ? 'approved' : 'reopened',
          title, nbody, taskId, '/tasks/my');
      }

      // 5. @mentions in the approval note → task_mentions + notifications.
      const mentions = parseMentions(note);
      for (const token of mentions) {
        db.prepare(`
          INSERT INTO task_mentions (id, task_id, comment_id, mentioned_email, mentioned_name, mentioned_by)
          VALUES (?, ?, '', ?, ?, ?)
        `).run(generateId(), taskId, token.includes('@') ? token : '', token, actorEmail);
        db.prepare(`
          INSERT INTO task_notifications (id, recipient_email, kind, title, body, task_id, href)
          VALUES (?, ?, 'mention', ?, ?, ?, ?)
        `).run(generateId(), token, `You were mentioned on: ${task.title}`,
          `${actorName} mentioned you: ${note}`, taskId, '/tasks/notifications');
      }
    });
    tx();

    const updated = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as any;
    return Response.json({ ok: true, task: updated });
  } catch (e: any) {
    console.error('POST /api/tasks/approvals failed:', e);
    return Response.json({ error: e?.message || 'Failed to record decision' }, { status: 500 });
  }
}
