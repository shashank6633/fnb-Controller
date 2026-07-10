/**
 * CRM — Guest attempts for a quiz link (HOD or ADMIN).
 *
 * GET /api/crm/quiz-links/:id/results →
 *   {
 *     link: { id, title, difficulty, pass_threshold, question_count },
 *     results: [{ id, guest_name, guest_mobile, guest_position, score, total,
 *                 percentage, passed, status, time_taken_seconds, started_at,
 *                 completed_at, responses: [{ question_number, question, options,
 *                 correct_index, selected_index, is_correct }] }]
 *   }
 * `responses` powers the per-question guest report drill-down on the client.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { getCurrentUser, type SessionUser } from '@/lib/auth';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

async function requireHod(): Promise<{ ok: true; user: SessionUser } | { ok: false; status: number; message: string }> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, status: 401, message: 'Sign in required' };
  if (me.role !== 'admin' && !me.is_head_chef) {
    return { ok: false, status: 403, message: 'HOD or admin access required' };
  }
  return { ok: true, user: me };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireHod();
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  const { id } = await params;
  const db = getDb();
  const link = db.prepare('SELECT * FROM crm_quiz_links WHERE id = ?').get(id) as any;
  if (!link) return Response.json({ error: 'Quiz link not found' }, { status: 404 });

  const sessions = db.prepare(`
    SELECT * FROM crm_guest_quiz_sessions WHERE link_id = ? ORDER BY started_at DESC
  `).all(id) as any[];

  const respStmt = db.prepare(`
    SELECT question_number, question, options_json, correct_index, selected_index, is_correct
    FROM crm_guest_quiz_responses WHERE guest_session_id = ? ORDER BY question_number
  `);

  const results = sessions.map(s => {
    const total = s.total_questions || 0;
    const score = s.score || 0;
    const percentage = total > 0 ? Math.round((score / total) * 100) : 0;
    const responses = (respStmt.all(s.id) as any[]).map(r => {
      let options: string[] = [];
      try { options = JSON.parse(r.options_json || '[]'); } catch { /* keep [] */ }
      return {
        question_number: r.question_number,
        question: r.question,
        options,
        correct_index: r.correct_index,
        selected_index: r.selected_index,
        is_correct: !!r.is_correct,
      };
    });
    return {
      id: s.id,
      guest_name: s.guest_name,
      guest_mobile: s.guest_mobile,
      guest_position: s.guest_position,
      score,
      total,
      percentage,
      passed: s.status === 'completed' && total > 0 && percentage >= link.pass_threshold,
      status: s.status, // active | completed | cheated
      time_taken_seconds: s.time_taken_seconds,
      started_at: s.started_at,
      completed_at: s.completed_at,
      responses,
    };
  });

  return Response.json({
    link: {
      id: link.id,
      title: link.title,
      difficulty: link.difficulty,
      pass_threshold: link.pass_threshold,
      question_count: link.question_count,
    },
    results,
  });
}
