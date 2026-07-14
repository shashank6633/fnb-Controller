/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { canManageTasks, canApproveTasks, parseMentions, TASK_STATUSES, TASK_PRIORITIES } from '@/lib/tasks';

/**
 * Single task (/api/tasks/:id) — CORE TASKS slice.
 *
 * GET    → { task, assignees, comments, history, attachments }
 * PUT    → edit the task's editable fields (canManageTasks). If `assignees` is
 *          supplied the task_assignees set is fully replaced and the primary
 *          assignee_email/name mirror is refreshed. A status change here also
 *          writes task_status_history.
 * PATCH  → status transition { status*, note? }. Assignees may advance their own
 *          task (accept/start/pause/complete); managers may set any status;
 *          approve/reopen require canApproveTasks. Writes task_status_history,
 *          maintains started/paused/completed/approved timestamps, notifies the
 *          counterparty, and fans out @mentions in the note.
 * DELETE → archive (is_archived = 1). canManageTasks. No hard delete.
 *
 * CSRF on mutations enforced by proxy.ts (/api/tasks prefix).
 */
export const dynamic = 'force-dynamic';

const VALID_STATUSES = new Set(TASK_STATUSES.map((s) => s.key as string));
const VALID_PRIORITIES = new Set(TASK_PRIORITIES.map((p) => p.key as string));
const APPROVAL_STATUSES = new Set(['approved', 'reopened']);
const MANAGE_ONLY_STATUSES = new Set(['draft', 'assigned', 'cancelled']);

function isAssigneeOf(db: any, task: any, email: string): boolean {
  const e = (email || '').toLowerCase();
  if (!e) return false;
  if ((task.assignee_email || '').toLowerCase() === e) return true;
  const hit = db.prepare(`SELECT 1 FROM task_assignees WHERE task_id = ? AND lower(user_email) = ? LIMIT 1`).get(task.id, e);
  return !!hit;
}

function loadDetail(db: any, id: string) {
  const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as any;
  if (!task) return null;
  const assignees = db.prepare(`SELECT * FROM task_assignees WHERE task_id = ? ORDER BY created_at ASC`).all(id);
  const comments = db.prepare(`SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC, id ASC`).all(id);
  const history = db.prepare(`SELECT * FROM task_status_history WHERE task_id = ? ORDER BY created_at ASC, id ASC`).all(id);
  const attachments = db.prepare(`SELECT * FROM task_attachments WHERE task_id = ? ORDER BY created_at ASC`).all(id);
  return { task, assignees, comments, history, attachments };
}

function normalizeAssignees(body: any): { email: string; name: string }[] {
  const out: { email: string; name: string }[] = [];
  const seen = new Set<string>();
  const push = (email: any, name: any) => {
    const e = String(email ?? '').trim();
    if (!e) return;
    const key = e.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ email: e, name: String(name ?? '').trim() });
  };
  if (Array.isArray(body?.assignees)) {
    for (const a of body.assignees) {
      if (a && typeof a === 'object') push(a.email, a.name);
      else push(a, '');
    }
  }
  return out;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  try {
    const { id } = await params;
    const detail = loadDetail(getDb(), id);
    if (!detail) return Response.json({ error: 'Task not found' }, { status: 404 });
    return Response.json(detail);
  } catch (e: any) {
    console.error('GET /api/tasks/[id] failed:', e);
    return Response.json({ error: e?.message || 'Failed to load task' }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageTasks(me)) return Response.json({ error: 'Not authorised to edit tasks' }, { status: 403 });

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }

  try {
    const { id } = await params;
    const db = getDb();
    const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as any;
    if (!task) return Response.json({ error: 'Task not found' }, { status: 404 });

    const actorEmail = me.email || '';
    const sets: string[] = [];
    const p: any[] = [];
    const setStr = (col: string, v: any) => { sets.push(`${col} = ?`); p.push(String(v ?? '').trim()); };

    if (body.title !== undefined) {
      const t = String(body.title ?? '').trim();
      if (!t) return Response.json({ error: 'title cannot be empty' }, { status: 400 });
      sets.push('title = ?'); p.push(t);
    }
    if (body.description !== undefined) setStr('description', body.description);
    if (body.category !== undefined) setStr('category', body.category);
    if (body.department !== undefined) setStr('department', body.department);
    if (body.priority !== undefined) {
      const pr = String(body.priority ?? '').trim();
      if (!VALID_PRIORITIES.has(pr)) return Response.json({ error: `invalid priority '${pr}'` }, { status: 400 });
      sets.push('priority = ?'); p.push(pr);
    }
    if (body.due_date !== undefined) setStr('due_date', body.due_date);
    if (body.due_time !== undefined) setStr('due_time', body.due_time);
    if (body.estimated_minutes !== undefined) {
      sets.push('estimated_minutes = ?');
      p.push(Number.isFinite(+body.estimated_minutes) ? Math.max(0, Math.trunc(+body.estimated_minutes)) : 0);
    }
    if (body.parent_task_id !== undefined) setStr('parent_task_id', body.parent_task_id);
    if (body.source !== undefined) setStr('source', body.source);
    if (body.sort_order !== undefined) { sets.push('sort_order = ?'); p.push(Number.isFinite(+body.sort_order) ? Math.trunc(+body.sort_order) : 0); }
    if (Array.isArray(body.checklist)) {
      const items = body.checklist
        .map((c: any) => (c && typeof c === 'object')
          ? { label: String(c.label ?? '').trim(), done: !!c.done }
          : { label: String(c ?? '').trim(), done: false })
        .filter((c: any) => c.label);
      sets.push('checklist_json = ?'); p.push(JSON.stringify(items));
    } else if (typeof body.checklist_json === 'string') {
      sets.push('checklist_json = ?'); p.push(body.checklist_json);
    }

    // Optional status change through the edit form.
    let statusChange: { from: string; to: string } | null = null;
    if (body.status !== undefined && String(body.status).trim() && String(body.status).trim() !== task.status) {
      const to = String(body.status).trim();
      if (!VALID_STATUSES.has(to)) return Response.json({ error: `invalid status '${to}'` }, { status: 400 });
      statusChange = { from: task.status, to };
      sets.push('status = ?'); p.push(to);
      if (to === 'approved') { sets.push(`approved_at = datetime('now')`); sets.push('approved_by = ?'); p.push(actorEmail); }
      if (to === 'completed') sets.push(`completed_at = datetime('now')`);
    }

    // Reassign — replace the full set + refresh the primary mirror.
    const reassign = Array.isArray(body.assignees);
    const assignees = reassign ? normalizeAssignees(body) : [];
    if (reassign) {
      const primary = assignees[0] || { email: '', name: '' };
      sets.push('assignee_email = ?'); p.push(primary.email);
      sets.push('assignee_name = ?'); p.push(primary.name);
    }

    if (sets.length === 0 && !reassign) {
      return Response.json({ error: 'nothing to update' }, { status: 400 });
    }

    const tx = db.transaction(() => {
      if (sets.length > 0) {
        sets.push(`updated_at = datetime('now')`);
        db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...p, id);
      }
      if (reassign) {
        db.prepare(`DELETE FROM task_assignees WHERE task_id = ?`).run(id);
        for (const a of assignees) {
          db.prepare(`INSERT INTO task_assignees (id, task_id, user_email, user_name) VALUES (?, ?, ?, ?)`)
            .run(generateId(), id, a.email, a.name);
        }
        // Notify newly-listed assignees.
        for (const a of assignees) {
          if (a.email.toLowerCase() === actorEmail.toLowerCase()) continue;
          db.prepare(`INSERT INTO task_notifications (id, recipient_email, kind, title, body, task_id, href) VALUES (?, ?, 'assigned', ?, ?, ?, '/tasks/my')`)
            .run(generateId(), a.email, `Task assigned: ${task.title}`, `${me.name || actorEmail} assigned you a task.`, id);
        }
      }
      if (statusChange) {
        db.prepare(`INSERT INTO task_status_history (id, task_id, from_status, to_status, changed_by, note) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(generateId(), id, statusChange.from, statusChange.to, actorEmail, String(body?.note ?? '').trim());
      }
    });
    tx();

    const detail = loadDetail(db, id);
    return Response.json(detail);
  } catch (e: any) {
    console.error('PUT /api/tasks/[id] failed:', e);
    return Response.json({ error: e?.message || 'Failed to update task' }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }

  const to = String(body?.status ?? '').trim();
  const note = String(body?.note ?? '').trim();
  if (!to) return Response.json({ error: 'status is required' }, { status: 400 });
  if (!VALID_STATUSES.has(to)) return Response.json({ error: `invalid status '${to}'` }, { status: 400 });

  try {
    const { id } = await params;
    const db = getDb();
    const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as any;
    if (!task) return Response.json({ error: 'Task not found' }, { status: 404 });

    const manage = canManageTasks(me);
    const assignee = isAssigneeOf(db, task, me.email || '');

    // Permission tiers by target status.
    if (APPROVAL_STATUSES.has(to)) {
      if (!canApproveTasks(me)) return Response.json({ error: 'Not authorised to approve/reopen' }, { status: 403 });
    } else if (MANAGE_ONLY_STATUSES.has(to)) {
      if (!manage) return Response.json({ error: 'Only managers may set this status' }, { status: 403 });
    } else {
      if (!manage && !assignee) return Response.json({ error: 'Not authorised to update this task' }, { status: 403 });
    }

    if (to === task.status) {
      return Response.json({ error: `Task is already '${to}'` }, { status: 409 });
    }

    const actorEmail = me.email || '';
    const actorName = me.name || me.email || '';
    const fromStatus = task.status;

    const tx = db.transaction(() => {
      const sets: string[] = ['status = ?'];
      const p: any[] = [to];
      if (to === 'in_progress') {
        if (!task.started_at) sets.push(`started_at = datetime('now')`);
        sets.push(`paused_at = NULL`);
      }
      if (to === 'on_hold') sets.push(`paused_at = datetime('now')`);
      if (to === 'completed') sets.push(`completed_at = datetime('now')`);
      if (to === 'approved') { sets.push(`approved_at = datetime('now')`); sets.push('approved_by = ?'); p.push(actorEmail); }
      sets.push(`updated_at = datetime('now')`);
      db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...p, id);

      db.prepare(`INSERT INTO task_status_history (id, task_id, from_status, to_status, changed_by, note) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(generateId(), id, fromStatus, to, actorEmail, note);

      // Notify the counterparty: assignee-driven moves ping the creator; manager
      // moves ping the assignee.
      const notify = (recipient: string, kind: string, title: string, nbody: string, href: string) => {
        if (!recipient || recipient.toLowerCase() === actorEmail.toLowerCase()) return;
        db.prepare(`INSERT INTO task_notifications (id, recipient_email, kind, title, body, task_id, href) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(generateId(), recipient, kind, title, nbody, id, href);
      };
      if (assignee && !manage) {
        notify(task.created_by, 'status', `Task ${to.replace(/_/g, ' ')}: ${task.title}`, `${actorName} moved the task to ${to.replace(/_/g, ' ')}.`, '/tasks/board');
      } else {
        notify(task.assignee_email, 'status', `Task ${to.replace(/_/g, ' ')}: ${task.title}`, `${actorName} moved your task to ${to.replace(/_/g, ' ')}.`, '/tasks/my');
      }

      // @mentions in the transition note.
      for (const token of parseMentions(note)) {
        db.prepare(`INSERT INTO task_mentions (id, task_id, comment_id, mentioned_email, mentioned_name, mentioned_by) VALUES (?, ?, '', ?, ?, ?)`)
          .run(generateId(), id, token.includes('@') ? token : '', token, actorEmail);
        db.prepare(`INSERT INTO task_notifications (id, recipient_email, kind, title, body, task_id, href) VALUES (?, ?, 'mention', ?, ?, ?, '/tasks/notifications')`)
          .run(generateId(), token, `You were mentioned on: ${task.title}`, `${actorName} mentioned you: ${note}`, id);
      }
    });
    tx();

    const updated = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as any;
    return Response.json({ ok: true, task: updated });
  } catch (e: any) {
    console.error('PATCH /api/tasks/[id] failed:', e);
    return Response.json({ error: e?.message || 'Failed to change status' }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageTasks(me)) return Response.json({ error: 'Not authorised to archive tasks' }, { status: 403 });
  try {
    const { id } = await params;
    const db = getDb();
    const task = db.prepare(`SELECT id FROM tasks WHERE id = ?`).get(id) as any;
    if (!task) return Response.json({ error: 'Task not found' }, { status: 404 });
    db.prepare(`UPDATE tasks SET is_archived = 1, updated_at = datetime('now') WHERE id = ?`).run(id);
    return Response.json({ ok: true });
  } catch (e: any) {
    console.error('DELETE /api/tasks/[id] failed:', e);
    return Response.json({ error: e?.message || 'Failed to archive task' }, { status: 500 });
  }
}
