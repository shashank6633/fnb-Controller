/**
 * POST /api/crm/training/respond
 *   { training_session_id, chat_session_id, response } →
 *   { evaluation, next_question, question_number, total_questions,
 *     is_completed, running_score, running_average, report? }
 *
 * Saves the staff's answer, rebuilds the conversation from crm_messages,
 * asks the LLM (customer role-play + evaluator) for the evaluation + next
 * question, stores the crm_training_responses row (feedback = evaluation
 * JSON string) and the cleaned assistant message, and updates the running
 * total. After 10 answers the session completes and the report is returned.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { callCrmLlm, CrmRateLimitError, getKnowledge, type CrmMessage } from '@/lib/crm-llm';
import { buildTrainingPrompt, parseTrainingReply, formatKbForPrompt } from '@/lib/crm-prompts';
import { generateTrainingReport } from '@/lib/crm-reports';

const TRAINING_QUESTIONS_PER_SESSION = 10; // matches Flask Config.TRAINING_QUESTIONS_PER_SESSION

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }
  const trainingSessionId = String(body?.training_session_id || '');
  const staffResponse = String(body?.response ?? '').trim();

  if (!staffResponse) return Response.json({ error: 'Response is required' }, { status: 400 });
  if (!trainingSessionId) return Response.json({ error: 'Missing training_session_id' }, { status: 400 });

  try {
    const db = getDb();
    const training = db.prepare(`
      SELECT * FROM crm_training_sessions WHERE id = ? AND user_id = ?
    `).get(trainingSessionId, me.id) as any;

    if (!training) return Response.json({ error: 'Training session not found' }, { status: 404 });
    if (training.status === 'completed') {
      return Response.json({ error: 'Training session already completed' }, { status: 400 });
    }

    // Trust the stored link, not the client-sent chat_session_id.
    const chatSessionId = training.chat_session_id || String(body?.chat_session_id || '');
    if (!chatSessionId) return Response.json({ error: 'Chat session not found' }, { status: 404 });

    // Save the staff response first (mirrors the Flask app).
    db.prepare(`
      INSERT INTO crm_messages (id, session_id, role, content)
      VALUES (?, ?, 'user', ?)
    `).run(generateId(), chatSessionId, staffResponse);

    // Rebuild the full conversation for LLM context.
    const rows = db.prepare(`
      SELECT role, content FROM crm_messages
      WHERE session_id = ?
      ORDER BY created_at, rowid
    `).all(chatSessionId) as { role: string; content: string }[];

    const history: CrmMessage[] = rows
      .filter((r) => r.role === 'user' || r.role === 'assistant')
      .map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content }));

    const system = buildTrainingPrompt(
      formatKbForPrompt(getKnowledge()),
      training.difficulty, training.category, training.language
    );

    const t0 = Date.now();
    const raw = await callCrmLlm({ messages: history, system, maxTokens: 4096, temperature: 0.7 });
    const responseTimeMs = Date.now() - t0;

    const parsed = parseTrainingReply(raw);
    const evaluation: any = parsed.evaluation && typeof parsed.evaluation === 'object'
      ? parsed.evaluation
      : {
          score: 5, accuracy: '', good_points: '', missed_points: '',
          ideal_response: '', pro_tip: '', category: training.category || '',
        };
    const score = typeof evaluation.score === 'number' && isFinite(evaluation.score)
      ? Math.max(0, Math.min(10, evaluation.score))
      : 5;
    evaluation.score = score;

    const questionNumber = (Number(training.questions_asked) || 0) + 1;
    // The question the staff just answered = the assistant message right
    // before their reply (history[-2], since history now ends with the reply).
    const questionText = history.length >= 2 ? history[history.length - 2].content : '';

    const newTotal = (Number(training.total_score) || 0) + score;
    const isCompleted = questionNumber >= TRAINING_QUESTIONS_PER_SESSION;

    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO crm_training_responses
          (id, training_session_id, question_number, question, user_response, score, feedback, ideal_answer)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        generateId(), trainingSessionId, questionNumber, questionText, staffResponse,
        score, JSON.stringify(evaluation), String(evaluation.ideal_response || '')
      );

      if (isCompleted) {
        db.prepare(`
          UPDATE crm_training_sessions
          SET questions_asked = ?, total_score = ?, status = 'completed', completed_at = datetime('now')
          WHERE id = ?
        `).run(questionNumber, newTotal, trainingSessionId);
      } else {
        db.prepare(`
          UPDATE crm_training_sessions
          SET questions_asked = ?, total_score = ?
          WHERE id = ?
        `).run(questionNumber, newTotal, trainingSessionId);
      }

      // Save the assistant's reply (cleaned — evaluation block stripped).
      db.prepare(`
        INSERT INTO crm_messages (id, session_id, role, content, response_time_ms)
        VALUES (?, ?, 'assistant', ?, ?)
      `).run(generateId(), chatSessionId, parsed.cleaned || raw, responseTimeMs);
      db.prepare(`UPDATE crm_chat_sessions SET updated_at = datetime('now') WHERE id = ?`).run(chatSessionId);
    });
    tx();

    const responseData: any = {
      evaluation,
      next_question: isCompleted ? '' : parsed.nextQuestion,
      question_number: questionNumber,
      total_questions: TRAINING_QUESTIONS_PER_SESSION,
      is_completed: isCompleted,
      running_score: newTotal,
      running_average: Math.round((newTotal / questionNumber) * 10) / 10,
    };

    if (isCompleted) {
      responseData.report = generateTrainingReport(trainingSessionId);
    }

    return Response.json(responseData);
  } catch (e: any) {
    if (e instanceof CrmRateLimitError) {
      return Response.json({
        error: 'AI is busy right now. Please wait a moment and try again.',
        wait_seconds: e.waitSeconds,
      }, { status: 429 });
    }
    console.error('POST /api/crm/training/respond failed:', e);
    return Response.json({ error: e?.message || 'Failed to evaluate response' }, { status: 500 });
  }
}
