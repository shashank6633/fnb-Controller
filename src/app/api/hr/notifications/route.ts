/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { reportServerError } from '@/lib/error-alerts';

/**
 * HR Notifications feed (/api/hr/notifications) — Phase 7.
 * Copies the /api/tasks/notifications shape onto hr_notifications: durable
 * per-user rows addressed by EMAIL (a login) — only login holders have a
 * bell; employees without logins are never addressed here (contract D1).
 *
 * GET  /api/hr/notifications?unread=1&limit=
 *        → { rows: HrNotification[], unread } — the CALLER's own feed,
 *          newest first. ?unread=1 filters to unread rows; `unread` is
 *          always the caller's total unread count.
 *
 * POST /api/hr/notifications  { ids?: string[], mark_all?: boolean }
 *        Marks the caller's own notifications read. Only rows whose
 *        recipient_email matches the caller are ever touched — ids
 *        belonging to someone else are silently skipped by the WHERE.
 *        → { ok, updated, unread }
 *
 * Gate: any signed-in user (everyone owns their feed; rows are scoped to
 * me.email so there is nothing cross-user to protect with a tier check).
 * Signed-out → 401. CSRF on POST is enforced by proxy.ts (/api/hr prefix) —
 * clients must mutate via api()/apiJson(). Errors return GENERIC messages.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  try {
    const db = getDb();
    const sp = new URL(request.url).searchParams;
    const limit = Math.min(
      Math.max(parseInt(sp.get('limit') || '100', 10) || 100, 1),
      500,
    );
    const email = me.email || '';

    const where: string[] = ['lower(recipient_email) = lower(?)'];
    const params: any[] = [email];
    if (sp.get('unread') === '1') where.push('is_read = 0');

    const rows = db
      .prepare(
        `SELECT * FROM hr_notifications
         WHERE ${where.join(' AND ')}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...params, limit) as any[];

    const unread = Number(
      (db
        .prepare(
          `SELECT COUNT(*) AS n FROM hr_notifications
           WHERE lower(recipient_email) = lower(?) AND is_read = 0`,
        )
        .get(email) as any)?.n || 0,
    );

    return Response.json({ rows, unread });
  } catch (e) {
    console.error('[hr-notifications] GET failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to load notifications' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }

  const markAll = body?.mark_all === true;
  const ids: string[] = Array.isArray(body?.ids)
    ? body.ids.map((x: any) => String(x)).filter(Boolean).slice(0, 500)
    : [];

  if (!markAll && ids.length === 0) {
    return Response.json({ error: 'Provide ids[] or mark_all: true' }, { status: 400 });
  }

  try {
    const db = getDb();
    const email = me.email || '';
    let updated = 0;
    if (markAll) {
      const r = db
        .prepare(
          `UPDATE hr_notifications SET is_read = 1
           WHERE lower(recipient_email) = lower(?) AND is_read = 0`,
        )
        .run(email);
      updated = r.changes || 0;
    } else {
      const placeholders = ids.map(() => '?').join(',');
      const r = db
        .prepare(
          `UPDATE hr_notifications SET is_read = 1
           WHERE lower(recipient_email) = lower(?) AND id IN (${placeholders})`,
        )
        .run(email, ...ids);
      updated = r.changes || 0;
    }
    const unread = Number(
      (db
        .prepare(
          `SELECT COUNT(*) AS n FROM hr_notifications
           WHERE lower(recipient_email) = lower(?) AND is_read = 0`,
        )
        .get(email) as any)?.n || 0,
    );
    return Response.json({ ok: true, updated, unread });
  } catch (e) {
    console.error('[hr-notifications] POST failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to update notifications' }, { status: 500 });
  }
}
