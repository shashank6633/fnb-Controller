import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * POST /api/dine-in/service-requests/[id]   (STAFF)
 * Body: { action: 'accept' | 'complete' }
 *   accept   → pending  → accepted   (a server is on the way)
 *   complete → accepted/pending → completed (drops off the board)
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id } = await params;
    const db = getDb();

    const sr = db.prepare('SELECT * FROM service_requests WHERE id = ?').get(id) as any;
    if (!sr) return Response.json({ error: 'Request not found' }, { status: 404 });

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || '').toLowerCase();
    const who = me.name || me.email;

    if (action === 'accept') {
      db.prepare(`
        UPDATE service_requests SET status = 'accepted', accepted_at = datetime('now'), accepted_by = ?
        WHERE id = ? AND status = 'pending'
      `).run(who, id);
    } else if (action === 'complete') {
      db.prepare(`
        UPDATE service_requests SET status = 'completed', completed_at = datetime('now'), completed_by = ?,
          accepted_at = COALESCE(accepted_at, datetime('now')), accepted_by = COALESCE(NULLIF(accepted_by,''), ?)
        WHERE id = ? AND status IN ('pending','accepted')
      `).run(who, who, id);
    } else {
      return Response.json({ error: 'Unknown action' }, { status: 400 });
    }

    const updated = db.prepare('SELECT id, type, status FROM service_requests WHERE id = ?').get(id);
    return Response.json({ ok: true, request: updated });
  } catch (e: any) {
    console.error('[/api/dine-in/service-requests/[id] POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
