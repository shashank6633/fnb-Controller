import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * In-app notifications. Mostly read for now; future versions will support
 * per-user inbox (mark read, filter by channel, etc.).
 *
 * GET    /api/notifications?limit=50&channel=inapp
 *        → { notifications: [...] }
 * POST   /api/notifications/mark-read   (future)
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const url = new URL(request.url);
    const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
    const channel = url.searchParams.get('channel');
    const where: string[] = ['1=1'];
    const params: any[] = [];
    if (channel) { where.push('channel = ?'); params.push(channel); }
    const rows = db.prepare(`
      SELECT id, kind, party_unique_id, fp_id, event_name, event_date, channel, title, body, created_at, sent_at
      FROM notifications
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params, limit);
    return Response.json({ notifications: rows });
  } catch (e: any) {
    console.error('[/api/notifications]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
