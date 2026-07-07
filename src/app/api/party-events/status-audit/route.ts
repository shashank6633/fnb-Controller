import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Recent status changes detected by the party-refresh scheduler.
 *
 * GET /api/party-events/status-audit?limit=50&days=7
 *   → { changes: [...] }
 *
 * HOD/admin only — mirrors the Party Events page gate so Cooks/Staff can't read
 * the FP status-change audit even by calling the endpoint directly.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!(me.role === 'admin' || me.is_head_chef)) return Response.json({ error: 'Head chef or admin only' }, { status: 403 });
    const db = getDb();
    const url = new URL(request.url);
    const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
    const days = Math.min(Number(url.searchParams.get('days') || 7), 90);
    const rows = db.prepare(`
      SELECT id, party_unique_id, fp_id, event_name, event_date, old_status, new_status, detected_at, source
      FROM party_status_audit
      WHERE detected_at >= datetime('now', ?)
      ORDER BY detected_at DESC
      LIMIT ?
    `).all(`-${days} day`, limit);
    return Response.json({ changes: rows });
  } catch (e: any) {
    console.error('[/api/party-events/status-audit]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
