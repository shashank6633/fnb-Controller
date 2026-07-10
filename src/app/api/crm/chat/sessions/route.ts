import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * GET  /api/crm/chat/sessions → { sessions: [...] } — my assistant sessions, latest 50
 * POST /api/crm/chat/sessions → { session } — create a new assistant chat session
 */
export async function GET() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const db = getDb();
    const sessions = db.prepare(`
      SELECT id, title, mode, status, created_at, updated_at
      FROM crm_chat_sessions
      WHERE user_id = ? AND mode = 'assistant'
      ORDER BY updated_at DESC
      LIMIT 50
    `).all(me.id);

    return Response.json({ sessions });
  } catch (e: any) {
    console.error('GET /api/crm/chat/sessions failed:', e);
    return Response.json({ error: e?.message || 'Failed to load chat sessions' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    let body: any = {};
    try { body = await request.json(); } catch { /* empty body is fine */ }
    const title = String(body?.title || 'New Chat').slice(0, 100);

    const db = getDb();
    const id = generateId();
    db.prepare(`
      INSERT INTO crm_chat_sessions (id, user_id, title, mode)
      VALUES (?, ?, ?, 'assistant')
    `).run(id, me.id, title);

    const session = db.prepare(`
      SELECT id, title, mode, status, created_at, updated_at
      FROM crm_chat_sessions WHERE id = ?
    `).get(id);

    return Response.json({ session }, { status: 201 });
  } catch (e: any) {
    console.error('POST /api/crm/chat/sessions failed:', e);
    return Response.json({ error: e?.message || 'Failed to create chat session' }, { status: 500 });
  }
}
