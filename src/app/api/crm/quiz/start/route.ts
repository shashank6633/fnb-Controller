/**
 * POST /api/crm/quiz/start
 *   { category?, language?, difficulty?, source? } →
 *   { quiz_session_id, total, total_questions, category, difficulty,
 *     question (stripped), question_number: 1, source: 'bank' | 'ai' }
 *
 * Source selection (port of akan-crm/routes/quiz.py start_quiz):
 *  - tier 'staff' (or source==='bank') → question bank (instant, menu-focused)
 *  - otherwise source==='auto' tries the bank first, then AI
 *  - AI generation (buildQuizPrompt + callCrmLlm + parseQuizJson) falls back
 *    to the bank on parse/rate-limit failure; 429 only when both fail.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { callCrmLlm, CrmRateLimitError, getKnowledge } from '@/lib/crm-llm';
import { buildQuizPrompt, parseQuizJson, formatKbForPrompt } from '@/lib/crm-prompts';
import { getQuizFromBank, stripQuizQuestion } from '@/lib/crm-question-bank';

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  let body: any = {};
  try { body = await request.json(); } catch { /* defaults below */ }
  const category = String(body?.category || 'random');
  const language = String(body?.language || 'english');
  const difficulty = String(body?.difficulty || 'medium');
  const source = String(body?.source || 'auto');

  // Flask 'gre' role is gone: tier 'staff' = staff; everything else is
  // gre-equivalent (admin/manager/HOD).
  const role = me.role === 'staff' ? 'staff' : 'gre';
  const bankDifficulty = difficulty !== 'random' ? difficulty : null;

  let questions: any[] | null = null;
  let quizSource: 'bank' | 'ai' = 'ai';

  // Staff always use the question bank; others use it when available.
  const useBank = role === 'staff' || source === 'bank';

  try {
    if (useBank || source === 'auto') {
      try {
        const bank = getQuizFromBank(me.id, 10, bankDifficulty, role);
        if (bank.length >= 5) {
          questions = bank;
          quizSource = 'bank';
        }
      } catch { /* fall through to AI generation */ }
    }

    if (!questions) {
      try {
        const qCount = ({ easy: 8, medium: 10, hard: 12 } as Record<string, number>)[difficulty] ?? 10;
        const kbText = formatKbForPrompt(getKnowledge());
        const system = buildQuizPrompt(kbText, category, difficulty, language, qCount, role);
        const raw = await callCrmLlm({
          messages: [{
            role: 'user',
            content: `Generate ${qCount} ${difficulty} multiple-choice quiz questions covering menu, corporate packages, bar, policies, events, and scenarios.`,
          }],
          system,
          maxTokens: 8192,
          temperature: 0.8,
        });
        const parsed = parseQuizJson(raw);
        for (const q of parsed) {
          if (!q.category) q.category = category !== 'random' ? category : 'General';
        }
        questions = parsed.slice(0, qCount);
        quizSource = 'ai';
      } catch (aiErr: any) {
        // AI failed (rate limit / bad JSON) → fall back to the bank.
        try {
          const bank = getQuizFromBank(me.id, 10, bankDifficulty, role);
          if (bank.length > 0) {
            questions = bank;
            quizSource = 'bank';
          }
        } catch { /* handled below */ }
        if (!questions) {
          if (aiErr instanceof CrmRateLimitError) {
            return Response.json({
              error: 'AI is busy. Please wait and try again.',
              wait_seconds: aiErr.waitSeconds,
            }, { status: 429 });
          }
          return Response.json({ error: `Failed to generate quiz: ${aiErr?.message || aiErr}` }, { status: 500 });
        }
      }
    }

    const storedCategory = quizSource === 'bank' ? 'question_bank' : category;
    const db = getDb();
    const id = generateId();
    db.prepare(`
      INSERT INTO crm_quiz_sessions
        (id, user_id, category, difficulty, language, source, questions_json, total_questions, score, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'active')
    `).run(id, me.id, storedCategory, difficulty, language, quizSource, JSON.stringify(questions), questions.length);

    return Response.json({
      quiz_session_id: id,
      total: questions.length,
      total_questions: questions.length,
      category: storedCategory,
      difficulty,
      question: stripQuizQuestion(questions[0]),
      question_number: 1,
      source: quizSource,
    });
  } catch (e: any) {
    console.error('POST /api/crm/quiz/start failed:', e);
    return Response.json({ error: e?.message || 'Failed to start quiz' }, { status: 500 });
  }
}
