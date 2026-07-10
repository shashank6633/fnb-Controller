/**
 * POST /api/crm/guest-quiz/cheat-log — PUBLIC by design (no staff session).
 *
 * The quiz page fires this when the guest switches tabs / apps or blurs the
 * window mid-question. The session is force-completed at its current score
 * with status='cheated' — the mobile-number block in /start then prevents a
 * re-take. Also recorded in crm_cheat_logs (user_id NULL = guest) so managers
 * can see terminations.
 */
import { getDb, generateId } from '@/lib/db';
import { elapsedSeconds, type GuestSessionRow } from '@/lib/crm-guest-quiz';

const CHEAT_TYPES = new Set(['tab_switch', 'window_blur', 'devtools', 'unknown']);

export async function POST(req: Request) {
  try {
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const sessionId = String(body.guest_session_id || '').trim();
    const rawType = String(body.cheat_type || 'unknown').trim();
    const cheatType = CHEAT_TYPES.has(rawType) ? rawType : 'unknown';

    if (!sessionId) {
      return Response.json({ error: 'Missing session ID' }, { status: 400 });
    }

    const db = getDb();
    const session = db
      .prepare('SELECT * FROM crm_guest_quiz_sessions WHERE id = ?')
      .get(sessionId) as GuestSessionRow | undefined;

    if (!session) {
      return Response.json({ error: 'Session not found' }, { status: 404 });
    }

    // Terminate at whatever they've scored so far (cheater keeps their score).
    if (session.status === 'active') {
      const timeTaken = elapsedSeconds(sessionId);
      db.prepare(
        `UPDATE crm_guest_quiz_sessions
           SET status = 'cheated', completed_at = datetime('now'), time_taken_seconds = ?
         WHERE id = ?`,
      ).run(timeTaken, sessionId);

      db.prepare(
        `INSERT INTO crm_cheat_logs (id, user_id, quiz_session_id, cheat_type)
         VALUES (?, NULL, ?, ?)`,
      ).run(generateId(), sessionId, cheatType);
    }

    const answered = (
      db.prepare('SELECT COUNT(*) AS n FROM crm_guest_quiz_responses WHERE guest_session_id = ?').get(sessionId) as {
        n: number;
      }
    ).n;

    return Response.json({
      status: 'logged',
      cheat_type: cheatType,
      score: session.score,
      questions_answered: answered,
      total_questions: session.total_questions,
    });
  } catch (e: any) {
    console.error('[/api/crm/guest-quiz/cheat-log POST]', e);
    return Response.json({ error: 'Failed to log event' }, { status: 500 });
  }
}
