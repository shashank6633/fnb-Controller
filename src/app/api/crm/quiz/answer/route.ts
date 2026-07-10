/**
 * POST /api/crm/quiz/answer
 *   { quiz_session_id, question_number, selected_index } →
 *   { correct, is_correct, correct_index, explanation, question_number,
 *     total_questions, score, progress, next_question (stripped) | null,
 *     is_completed, report | null }
 *
 * Scores against the questions_json snapshot stored at start (never trusts
 * the client). On the last answer the session flips to completed, seen
 * questions are recorded for future deduplication, and the report
 * (score/percentage/grade/category breakdown/weak areas) is returned.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { recordSeenQuestions, stripQuizQuestion } from '@/lib/crm-question-bank';
import { buildQuizReport } from '@/lib/crm-reports';

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }
  const quizSessionId = String(body?.quiz_session_id || '');
  const questionNumber = Number(body?.question_number);
  const selectedIndex = Number(body?.selected_index);

  if (!quizSessionId || !Number.isInteger(questionNumber) || !Number.isInteger(selectedIndex)) {
    return Response.json({ error: 'Missing required fields' }, { status: 400 });
  }

  try {
    const db = getDb();
    const session = db.prepare(`
      SELECT * FROM crm_quiz_sessions WHERE id = ? AND user_id = ?
    `).get(quizSessionId, me.id) as any;

    if (!session) return Response.json({ error: 'Quiz session not found' }, { status: 404 });
    if (session.status === 'completed') {
      return Response.json({ error: 'Quiz already completed' }, { status: 400 });
    }

    let questions: any[] = [];
    try { questions = JSON.parse(session.questions_json || '[]'); } catch { questions = []; }

    const qIndex = questionNumber - 1;
    if (qIndex < 0 || qIndex >= questions.length) {
      return Response.json({ error: 'Invalid question number' }, { status: 400 });
    }

    const already = db.prepare(`
      SELECT id FROM crm_quiz_responses WHERE quiz_session_id = ? AND question_number = ?
    `).get(quizSessionId, questionNumber);
    if (already) return Response.json({ error: 'Question already answered' }, { status: 400 });

    const question = questions[qIndex];
    const isCorrect = selectedIndex === question.correct_index ? 1 : 0;

    db.prepare(`
      INSERT INTO crm_quiz_responses
        (id, quiz_session_id, question_number, question, options_json, correct_index, selected_index, is_correct, explanation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      generateId(), quizSessionId, questionNumber, question.question,
      JSON.stringify(question.options || []), question.correct_index,
      selectedIndex, isCorrect, question.explanation || ''
    );

    const newScore = (Number(session.score) || 0) + isCorrect;
    const totalQuestions = Number(session.total_questions) || questions.length;
    const answered = (db.prepare(`
      SELECT COUNT(*) AS n FROM crm_quiz_responses WHERE quiz_session_id = ?
    `).get(quizSessionId) as any).n as number;
    const isCompleted = answered >= totalQuestions;

    if (isCompleted) {
      db.prepare(`
        UPDATE crm_quiz_sessions
        SET score = ?, status = 'completed', completed_at = datetime('now')
        WHERE id = ?
      `).run(newScore, quizSessionId);
    } else {
      db.prepare(`UPDATE crm_quiz_sessions SET score = ? WHERE id = ?`).run(newScore, quizSessionId);
    }

    const result: any = {
      correct: !!isCorrect,
      is_correct: !!isCorrect,
      correct_index: question.correct_index,
      explanation: question.explanation || '',
      question_number: questionNumber,
      total_questions: totalQuestions,
      score: newScore,
      progress: { answered, total: totalQuestions },
      is_completed: isCompleted,
      next_question: null,
      report: null,
    };

    if (!isCompleted && qIndex + 1 < questions.length) {
      result.next_question = stripQuizQuestion(questions[qIndex + 1]);
    }

    if (isCompleted) {
      const responses = db.prepare(`
        SELECT question_number, is_correct FROM crm_quiz_responses
        WHERE quiz_session_id = ? ORDER BY question_number
      `).all(quizSessionId) as Array<{ question_number: number; is_correct: number }>;

      result.report = buildQuizReport(questions, responses);

      // Record seen questions for future deduplication (bank questions carry
      // an id; AI questions don't and are skipped). Never fail the response.
      try {
        const byNumber = new Map(responses.map((r) => [r.question_number, r.is_correct]));
        const correctness = questions.map((_q, i) => {
          const v = byNumber.get(i + 1);
          return v == null ? null : v;
        });
        recordSeenQuestions(me.id, questions, correctness);
      } catch (e) {
        console.error('recordSeenQuestions failed:', e);
      }
    }

    return Response.json(result);
  } catch (e: any) {
    console.error('POST /api/crm/quiz/answer failed:', e);
    return Response.json({ error: e?.message || 'Failed to record answer' }, { status: 500 });
  }
}
