/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { parseMentions } from '@/lib/tasks';

/**
 * Task comment thread (/api/tasks/:id/comments) — CORE TASKS slice.
 *
 * GET  → { comments, attachments } for the task (chronological). Attachments are
 *        returned alongside so the UI can hang each on its comment_id (task-level
 *        attachments have comment_id = '').
 * POST { body*, attachments?[] }
 *        → inserts a comment; @mentions in the body fan out to task_mentions +
 *          task_notifications (one per mentioned token). Optional attachments
 *          [{ kind, url, filename }] are stored against the new comment.
 *        Any signed-in user may comment. Returns { comment, attachments }.
 *
 * CSRF on POST enforced by proxy.ts (/api/tasks prefix).
 */
export const dynamic = 'force-dynamic';

const VALID_KINDS = new Set(['image', 'video', 'voice', 'file', 'sop_link']);

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  try {
    const { id } = await params;
    const db = getDb();
    const comments = db.prepare(`SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC, id ASC`).all(id);
    const attachments = db.prepare(`SELECT * FROM task_attachments WHERE task_id = ? ORDER BY created_at ASC`).all(id);
    return Response.json({ comments, attachments });
  } catch (e: any) {
    console.error('GET /api/tasks/[id]/comments failed:', e);
    return Response.json({ error: e?.message || 'Failed to load comments' }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }

  const text = String(body?.body ?? '').trim();
  const attachmentsIn = Array.isArray(body?.attachments) ? body.attachments : [];
  if (!text && attachmentsIn.length === 0) {
    return Response.json({ error: 'comment body or an attachment is required' }, { status: 400 });
  }

  try {
    const { id } = await params;
    const db = getDb();
    const task = db.prepare(`SELECT id, title FROM tasks WHERE id = ?`).get(id) as any;
    if (!task) return Response.json({ error: 'Task not found' }, { status: 404 });

    const commentId = generateId();
    const actorEmail = me.email || '';
    const actorName = me.name || me.email || '';

    const tx = db.transaction(() => {
      db.prepare(`INSERT INTO task_comments (id, task_id, author_email, author_name, body) VALUES (?, ?, ?, ?, ?)`)
        .run(commentId, id, actorEmail, actorName, text);

      for (const a of attachmentsIn) {
        const kind = String(a?.kind ?? 'file').trim();
        const url = String(a?.url ?? '').trim();
        if (!url) continue;
        db.prepare(`INSERT INTO task_attachments (id, task_id, comment_id, kind, url, filename, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(generateId(), id, commentId, VALID_KINDS.has(kind) ? kind : 'file', url, String(a?.filename ?? '').trim(), actorEmail);
      }

      for (const token of parseMentions(text)) {
        db.prepare(`INSERT INTO task_mentions (id, task_id, comment_id, mentioned_email, mentioned_name, mentioned_by) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(generateId(), id, commentId, token.includes('@') ? token : '', token, actorEmail);
        db.prepare(`INSERT INTO task_notifications (id, recipient_email, kind, title, body, task_id, href) VALUES (?, ?, 'mention', ?, ?, ?, '/tasks/notifications')`)
          .run(generateId(), token, `You were mentioned on: ${task.title}`, `${actorName}: ${text}`, id);
      }
    });
    tx();

    const comment = db.prepare(`SELECT * FROM task_comments WHERE id = ?`).get(commentId) as any;
    const attachments = db.prepare(`SELECT * FROM task_attachments WHERE comment_id = ? ORDER BY created_at ASC`).all(commentId);
    return Response.json({ comment, attachments }, { status: 201 });
  } catch (e: any) {
    console.error('POST /api/tasks/[id]/comments failed:', e);
    return Response.json({ error: e?.message || 'Failed to add comment' }, { status: 500 });
  }
}
