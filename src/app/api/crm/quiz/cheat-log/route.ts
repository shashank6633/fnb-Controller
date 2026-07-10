/**
 * POST /api/crm/quiz/cheat-log
 *   { quiz_session_id?, cheat_type? } → { logged: true }
 * Records tab-switch / focus-loss events fired by the quiz page's
 * visibilitychange handler.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  let body: any = {};
  try { body = await request.json(); } catch { /* defaults below */ }
  const cheatType = String(body?.cheat_type || 'tab_switch').slice(0, 50);
  const quizSessionId = body?.quiz_session_id ? String(body.quiz_session_id) : null;

  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO crm_cheat_logs (id, user_id, quiz_session_id, cheat_type)
      VALUES (?, ?, ?, ?)
    `).run(generateId(), me.id, quizSessionId, cheatType);
    return Response.json({ logged: true });
  } catch (e: any) {
    console.error('POST /api/crm/quiz/cheat-log failed:', e);
    return Response.json({ error: e?.message || 'Failed to log' }, { status: 500 });
  }
}
