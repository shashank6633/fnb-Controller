/**
 * GET /api/crm/training/history → { history: [...] }
 * Latest 50 training sessions for the signed-in user, newest first,
 * each with running average_score and percentage.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT id, chat_session_id, difficulty, category, language, total_score,
             questions_asked, status, created_at, completed_at
      FROM crm_training_sessions
      WHERE user_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 50
    `).all(me.id) as any[];

    const history = rows.map((s) => {
      const asked = Number(s.questions_asked) || 0;
      const total = Number(s.total_score) || 0;
      return {
        id: s.id,
        chat_session_id: s.chat_session_id,
        difficulty: s.difficulty,
        category: s.category,
        language: s.language,
        total_score: total,
        questions_asked: asked,
        average_score: asked > 0 ? Math.round((total / asked) * 10) / 10 : 0,
        percentage: asked > 0 ? Math.round((total / (asked * 10)) * 100) : 0,
        completed: s.status === 'completed',
        status: s.status,
        created_at: s.created_at,
        completed_at: s.completed_at,
      };
    });

    return Response.json({ history });
  } catch (e: any) {
    console.error('GET /api/crm/training/history failed:', e);
    return Response.json({ error: e?.message || 'Failed to load history' }, { status: 500 });
  }
}
