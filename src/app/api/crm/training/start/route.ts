/**
 * POST /api/crm/training/start
 *   { difficulty?, category?, language? } →
 *   { training_session_id, chat_session_id, question, question_number: 1,
 *     total_questions: 10, difficulty, category, language }
 *
 * Creates a crm_training_sessions row + a linked crm_chat_sessions row
 * (mode 'training'), asks the LLM (role-playing a customer, system =
 * buildTrainingPrompt) for the first question and stores it as the first
 * assistant message. DB rows are created only after the LLM call succeeds
 * so a rate-limited start leaves no orphan sessions.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { callCrmLlm, CrmRateLimitError, getKnowledge } from '@/lib/crm-llm';
import { buildTrainingPrompt, formatKbForPrompt } from '@/lib/crm-prompts';

const TRAINING_QUESTIONS_PER_SESSION = 10; // matches Flask Config.TRAINING_QUESTIONS_PER_SESSION

function titleCase(s: string): string {
  return String(s).replace(/[A-Za-z]+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  let body: any = {};
  try { body = await request.json(); } catch { /* defaults below */ }
  const difficulty = String(body?.difficulty || 'medium');
  const category = String(body?.category || 'random');
  const language = String(body?.language || 'english');

  try {
    const system = buildTrainingPrompt(formatKbForPrompt(getKnowledge()), difficulty, category, language);

    const t0 = Date.now();
    const question = await callCrmLlm({
      messages: [{
        role: 'user',
        content: 'Start the training. Introduce yourself as a customer and ask your first question.',
      }],
      system,
      maxTokens: 4096,
      temperature: 0.8,
    });
    const responseTimeMs = Date.now() - t0;

    const db = getDb();
    const trainingSessionId = generateId();
    const chatSessionId = generateId();
    const title = `Training - ${titleCase(difficulty)} - ${titleCase(category)}`;

    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO crm_chat_sessions (id, user_id, title, mode)
        VALUES (?, ?, ?, 'training')
      `).run(chatSessionId, me.id, title);
      db.prepare(`
        INSERT INTO crm_training_sessions (id, user_id, chat_session_id, difficulty, category, language, status)
        VALUES (?, ?, ?, ?, ?, ?, 'active')
      `).run(trainingSessionId, me.id, chatSessionId, difficulty, category, language);
      db.prepare(`
        INSERT INTO crm_messages (id, session_id, role, content, response_time_ms)
        VALUES (?, ?, 'assistant', ?, ?)
      `).run(generateId(), chatSessionId, question, responseTimeMs);
    });
    tx();

    return Response.json({
      training_session_id: trainingSessionId,
      chat_session_id: chatSessionId,
      question,
      question_number: 1,
      total_questions: TRAINING_QUESTIONS_PER_SESSION,
      difficulty,
      category,
      language,
    });
  } catch (e: any) {
    if (e instanceof CrmRateLimitError) {
      return Response.json({
        error: 'AI is busy right now. Please wait a moment and try again.',
        wait_seconds: e.waitSeconds,
      }, { status: 429 });
    }
    console.error('POST /api/crm/training/start failed:', e);
    return Response.json({ error: e?.message || 'Failed to start training' }, { status: 500 });
  }
}
