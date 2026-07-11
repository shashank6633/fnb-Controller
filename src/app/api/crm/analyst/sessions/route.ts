/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/crm/analyst/sessions → { sessions: [...] }
 * My AI-Analyst chat sessions (mode='analyst'), latest 50.
 * Gate: admin or HOD — same as POST /api/crm/analyst.
 */
export async function GET() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!(me.role === 'admin' || me.is_head_chef)) {
      return Response.json({ error: 'Not authorised' }, { status: 403 });
    }

    const db = getDb();
    const sessions = db.prepare(`
      SELECT id, title, mode, status, created_at, updated_at
      FROM crm_chat_sessions
      WHERE user_id = ? AND mode = 'analyst'
      ORDER BY updated_at DESC
      LIMIT 50
    `).all(me.id);

    return Response.json({ sessions });
  } catch (e: any) {
    console.error('GET /api/crm/analyst/sessions failed:', e);
    return Response.json({ error: e?.message || 'Failed to load analyst sessions' }, { status: 500 });
  }
}
