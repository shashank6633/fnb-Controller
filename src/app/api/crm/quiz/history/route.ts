/**
 * GET /api/crm/quiz/history → { history: [...] }
 * Latest 50 quiz sessions for the signed-in user, newest first.
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
      SELECT id, category, difficulty, language, source, score, total_questions, status, created_at, completed_at
      FROM crm_quiz_sessions
      WHERE user_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 50
    `).all(me.id) as any[];

    const history = rows.map((s) => {
      const total = Number(s.total_questions) || 10;
      const score = Number(s.score) || 0;
      return {
        id: s.id,
        category: s.category,
        difficulty: s.difficulty || 'medium',
        language: s.language,
        source: s.source,
        score,
        total,
        percentage: total > 0 ? Math.round((score / total) * 100) : 0,
        completed: s.status === 'completed',
        status: s.status,
        created_at: s.created_at,
        completed_at: s.completed_at,
      };
    });

    return Response.json({ history });
  } catch (e: any) {
    console.error('GET /api/crm/quiz/history failed:', e);
    return Response.json({ error: e?.message || 'Failed to load history' }, { status: 500 });
  }
}
