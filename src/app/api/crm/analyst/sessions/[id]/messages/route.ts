/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/crm/analyst/sessions/[id]/messages → { messages: [...] }
 * Only the session owner (admin/HOD) may read an analyst session's messages.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!(me.role === 'admin' || me.is_head_chef)) {
      return Response.json({ error: 'Not authorised' }, { status: 403 });
    }

    const { id } = await params;
    const db = getDb();

    const session = db.prepare(`
      SELECT id FROM crm_chat_sessions WHERE id = ? AND user_id = ? AND mode = 'analyst'
    `).get(id, me.id);
    if (!session) return Response.json({ error: 'Chat session not found' }, { status: 404 });

    const messages = db.prepare(`
      SELECT id, role, content, response_time_ms, created_at
      FROM crm_messages
      WHERE session_id = ?
      ORDER BY created_at, rowid
    `).all(id);

    return Response.json({ messages });
  } catch (e: any) {
    console.error('GET /api/crm/analyst/sessions/[id]/messages failed:', e);
    return Response.json({ error: e?.message || 'Failed to load messages' }, { status: 500 });
  }
}
