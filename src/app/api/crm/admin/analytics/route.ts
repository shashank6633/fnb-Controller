/**
 * CRM Admin — Analytics dashboard data (ADMIN only).
 *
 * GET /api/crm/admin/analytics →
 *   {
 *     totals: { active_users, chat_sessions, quiz_sessions, training_sessions,
 *               avg_quiz_pct, avg_training_score },
 *     leaderboard: [{ user_id, name, email, quiz_count, quiz_avg_pct,
 *                     training_count, training_avg }],
 *     recent: [{ type, label, user_name, created_at, status }]   // latest 20
 *   }
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { requireRole } from '@/lib/auth';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  const db = getDb();

  // ── totals ────────────────────────────────────────────────────────────
  const activeUsers = (db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT user_id FROM crm_chat_sessions
      UNION SELECT user_id FROM crm_quiz_sessions
      UNION SELECT user_id FROM crm_training_sessions
    )
  `).get() as any).n as number;

  const chatSessions = (db.prepare('SELECT COUNT(*) AS n FROM crm_chat_sessions').get() as any).n as number;
  const quizSessions = (db.prepare('SELECT COUNT(*) AS n FROM crm_quiz_sessions').get() as any).n as number;
  const trainingSessions = (db.prepare('SELECT COUNT(*) AS n FROM crm_training_sessions').get() as any).n as number;

  const avgQuizPct = (db.prepare(`
    SELECT AVG(score * 100.0 / total_questions) AS avg
    FROM crm_quiz_sessions
    WHERE status = 'completed' AND total_questions > 0
  `).get() as any).avg as number | null;

  // Training scores are 0–10 per question → average score out of 10.
  const avgTrainingScore = (db.prepare(`
    SELECT AVG(total_score * 1.0 / questions_asked) AS avg
    FROM crm_training_sessions
    WHERE status = 'completed' AND questions_asked > 0
  `).get() as any).avg as number | null;

  // ── leaderboard (every user with any CRM activity) ────────────────────
  const leaderboard = (db.prepare(`
    SELECT u.id AS user_id, u.name, u.email,
      (SELECT COUNT(*) FROM crm_quiz_sessions q WHERE q.user_id = u.id) AS quiz_count,
      (SELECT AVG(q.score * 100.0 / q.total_questions)
         FROM crm_quiz_sessions q
        WHERE q.user_id = u.id AND q.status = 'completed' AND q.total_questions > 0) AS quiz_avg_pct,
      (SELECT COUNT(*) FROM crm_training_sessions t WHERE t.user_id = u.id) AS training_count,
      (SELECT AVG(t.total_score * 1.0 / t.questions_asked)
         FROM crm_training_sessions t
        WHERE t.user_id = u.id AND t.status = 'completed' AND t.questions_asked > 0) AS training_avg
    FROM users u
    WHERE u.id IN (
      SELECT user_id FROM crm_chat_sessions
      UNION SELECT user_id FROM crm_quiz_sessions
      UNION SELECT user_id FROM crm_training_sessions
    )
    ORDER BY (quiz_avg_pct IS NULL), quiz_avg_pct DESC, quiz_count DESC
  `).all() as any[]).map(r => ({
    ...r,
    quiz_avg_pct: r.quiz_avg_pct != null ? Math.round(r.quiz_avg_pct) : null,
    training_avg: r.training_avg != null ? Math.round(r.training_avg * 10) / 10 : null,
  }));

  // ── recent activity (latest 20 across the three) ──────────────────────
  const chats = db.prepare(`
    SELECT cs.title, cs.mode, cs.status, cs.created_at, u.name AS user_name
    FROM crm_chat_sessions cs JOIN users u ON u.id = cs.user_id
    ORDER BY cs.created_at DESC LIMIT 20
  `).all() as any[];
  const quizzes = db.prepare(`
    SELECT q.category, q.difficulty, q.score, q.total_questions, q.status, q.created_at, u.name AS user_name
    FROM crm_quiz_sessions q JOIN users u ON u.id = q.user_id
    ORDER BY q.created_at DESC LIMIT 20
  `).all() as any[];
  const trainings = db.prepare(`
    SELECT t.category, t.difficulty, t.total_score, t.questions_asked, t.status, t.created_at, u.name AS user_name
    FROM crm_training_sessions t JOIN users u ON u.id = t.user_id
    ORDER BY t.created_at DESC LIMIT 20
  `).all() as any[];

  const recent = [
    ...chats.map(c => ({
      type: 'chat' as const,
      label: c.title || (c.mode === 'training' ? 'Training chat' : 'Assistant chat'),
      user_name: c.user_name, created_at: c.created_at, status: c.status,
    })),
    ...quizzes.map(q => {
      const pct = q.total_questions > 0 ? Math.round((q.score / q.total_questions) * 100) : 0;
      const suffix = q.status === 'completed' ? `${pct}%` : q.status;
      return {
        type: 'quiz' as const,
        label: `Quiz · ${q.difficulty} · ${q.category} (${suffix})`,
        user_name: q.user_name, created_at: q.created_at, status: q.status,
      };
    }),
    ...trainings.map(t => {
      const avg = t.questions_asked > 0 ? Math.round((t.total_score / t.questions_asked) * 10) / 10 : 0;
      const suffix = t.status === 'completed' ? `${avg}/10` : t.status;
      return {
        type: 'training' as const,
        label: `Training · ${t.difficulty} · ${t.category} (${suffix})`,
        user_name: t.user_name, created_at: t.created_at, status: t.status,
      };
    }),
  ]
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, 20);

  return Response.json({
    totals: {
      active_users: activeUsers,
      chat_sessions: chatSessions,
      quiz_sessions: quizSessions,
      training_sessions: trainingSessions,
      avg_quiz_pct: avgQuizPct != null ? Math.round(avgQuizPct) : null,
      avg_training_score: avgTrainingScore != null ? Math.round(avgTrainingScore * 10) / 10 : null,
    },
    leaderboard,
    recent,
  });
}
