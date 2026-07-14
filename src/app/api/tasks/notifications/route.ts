/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Task Notifications feed (/api/tasks/notifications).
 *
 * GET  /api/tasks/notifications?filter=all|unread&limit=
 *        → { rows: TaskNotification[], unread } — the CALLER's own feed
 *          (assignments, @mentions, approval outcomes, overdue reminders),
 *          newest first. `unread` is the caller's total unread count.
 *
 * POST /api/tasks/notifications  { ids?: string[], mark_all?: boolean }
 *        Marks the caller's own notifications read. Pass explicit `ids`, or
 *        `mark_all: true` to clear the whole feed. Only rows whose
 *        recipient_email matches the caller are touched. → { updated, unread }
 *
 * Gate: any signed-in user (everyone has a feed). Signed-out → 401.
 * CSRF on POST is enforced by proxy.ts (/api/tasks prefix).
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  try {
    const db = getDb();
    const url = new URL(request.url);
    const filter = (url.searchParams.get('filter') || 'all').trim();
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1), 500);
    const email = me.email || '';

    const where: string[] = [`lower(recipient_email) = lower(?)`];
    const params: any[] = [email];
    if (filter === 'unread') where.push(`is_read = 0`);

    const rows = db.prepare(`
      SELECT * FROM task_notifications
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params, limit) as any[];

    const unread = Number((db.prepare(
      `SELECT COUNT(*) AS n FROM task_notifications WHERE lower(recipient_email) = lower(?) AND is_read = 0`,
    ).get(email) as any)?.n || 0);

    return Response.json({ rows, unread });
  } catch (e: any) {
    console.error('GET /api/tasks/notifications failed:', e);
    return Response.json({ error: e?.message || 'Failed to load notifications' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }

  const markAll = body?.mark_all === true;
  const ids: string[] = Array.isArray(body?.ids)
    ? body.ids.map((x: any) => String(x)).filter(Boolean)
    : [];

  if (!markAll && ids.length === 0) {
    return Response.json({ error: 'Provide ids[] or mark_all: true' }, { status: 400 });
  }

  try {
    const db = getDb();
    const email = me.email || '';
    let updated = 0;
    if (markAll) {
      const r = db.prepare(
        `UPDATE task_notifications SET is_read = 1 WHERE lower(recipient_email) = lower(?) AND is_read = 0`,
      ).run(email);
      updated = r.changes || 0;
    } else {
      const placeholders = ids.map(() => '?').join(',');
      const r = db.prepare(
        `UPDATE task_notifications SET is_read = 1
         WHERE lower(recipient_email) = lower(?) AND id IN (${placeholders})`,
      ).run(email, ...ids);
      updated = r.changes || 0;
    }
    const unread = Number((db.prepare(
      `SELECT COUNT(*) AS n FROM task_notifications WHERE lower(recipient_email) = lower(?) AND is_read = 0`,
    ).get(email) as any)?.n || 0);
    return Response.json({ ok: true, updated, unread });
  } catch (e: any) {
    console.error('POST /api/tasks/notifications failed:', e);
    return Response.json({ error: e?.message || 'Failed to update notifications' }, { status: 500 });
  }
}
