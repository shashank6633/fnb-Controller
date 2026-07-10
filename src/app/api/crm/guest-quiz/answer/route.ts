/**
 * POST /api/crm/guest-quiz/answer — PUBLIC by design (no staff session).
 *
 * Scores one answer against the server-side questions_json snapshot.
 * selected_index === -1 means the 45s timer expired (always wrong).
 * On the last question the session is completed and the report card returned.
 */
import { getDb, generateId } from '@/lib/db';
import {
  buildGuestReport,
  elapsedSeconds,
  stripQuestion,
  type GuestSessionRow,
  type QuizLinkRow,
  type SnapshotQuestion,
} from '@/lib/crm-guest-quiz';

export async function POST(req: Request) {
  try {
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const sessionId = String(body.guest_session_id || '').trim();
    const questionNumber = Number(body.question_number);
    const selectedIndex = Number(body.selected_index);

    if (!sessionId || !Number.isInteger(questionNumber) || !Number.isInteger(selectedIndex)) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const db = getDb();
    const session = db
      .prepare('SELECT * FROM crm_guest_quiz_sessions WHERE id = ?')
      .get(sessionId) as GuestSessionRow | undefined;

    if (!session) {
      return Response.json({ error: 'Quiz session not found' }, { status: 404 });
    }
    if (session.status !== 'active') {
      return Response.json({ error: 'Quiz already completed' }, { status: 400 });
    }

    let questions: SnapshotQuestion[] = [];
    try {
      questions = JSON.parse(session.questions_json);
    } catch {
      questions = [];
    }
    const qIndex = questionNumber - 1;
    if (qIndex < 0 || qIndex >= questions.length) {
      return Response.json({ error: 'Invalid question number' }, { status: 400 });
    }

    // Replay guard — each question can be answered exactly once.
    const already = db
      .prepare('SELECT id FROM crm_guest_quiz_responses WHERE guest_session_id = ? AND question_number = ?')
      .get(sessionId, questionNumber);
    if (already) {
      return Response.json({ error: 'This question was already answered' }, { status: 400 });
    }

    const question = questions[qIndex];
    const validSelection = selectedIndex >= 0 && selectedIndex < question.options.length;
    const isCorrect = validSelection && selectedIndex === question.correct_index ? 1 : 0;

    db.prepare(
      `INSERT INTO crm_guest_quiz_responses
         (id, guest_session_id, question_number, question, options_json,
          correct_index, selected_index, is_correct)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      generateId(),
      sessionId,
      questionNumber,
      question.question,
      JSON.stringify(question.options),
      question.correct_index,
      validSelection ? selectedIndex : null,
      isCorrect,
    );

    const newScore = session.score + isCorrect;
    const answered = (
      db.prepare('SELECT COUNT(*) AS n FROM crm_guest_quiz_responses WHERE guest_session_id = ?').get(sessionId) as {
        n: number;
      }
    ).n;
    const isCompleted = answered >= session.total_questions;

    let timeTaken: number | null = null;
    if (isCompleted) {
      timeTaken = elapsedSeconds(sessionId);
      db.prepare(
        `UPDATE crm_guest_quiz_sessions
           SET score = ?, status = 'completed', completed_at = datetime('now'), time_taken_seconds = ?
         WHERE id = ?`,
      ).run(newScore, timeTaken, sessionId);
    } else {
      db.prepare('UPDATE crm_guest_quiz_sessions SET score = ? WHERE id = ?').run(newScore, sessionId);
    }

    const result: Record<string, unknown> = {
      is_correct: !!isCorrect,
      correct_index: question.correct_index,
      explanation: question.explanation || '',
      question_number: questionNumber,
      total_questions: session.total_questions,
      score: newScore,
      is_completed: isCompleted,
      next_question: null,
      report: null,
    };

    if (!isCompleted && qIndex + 1 < questions.length) {
      result.next_question = stripQuestion(questions[qIndex + 1], questionNumber + 1);
    }

    if (isCompleted) {
      const link = db
        .prepare('SELECT * FROM crm_quiz_links WHERE id = ?')
        .get(session.link_id) as QuizLinkRow | undefined;
      const freshSession = db
        .prepare('SELECT * FROM crm_guest_quiz_sessions WHERE id = ?')
        .get(sessionId) as GuestSessionRow;
      if (link) {
        result.report = {
          ...buildGuestReport(freshSession, link),
          time_taken_seconds: timeTaken,
        };
      }
    }

    return Response.json(result);
  } catch (e: any) {
    console.error('[/api/crm/guest-quiz/answer POST]', e);
    return Response.json({ error: 'Failed to submit answer. Please try again.' }, { status: 500 });
  }
}
