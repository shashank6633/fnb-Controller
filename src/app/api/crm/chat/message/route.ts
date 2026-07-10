import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { callCrmLlm, CrmRateLimitError, getKnowledge, type CrmMessage } from '@/lib/crm-llm';
import { buildAssistantPrompt, formatKbForPrompt, languageSuffix } from '@/lib/crm-prompts';

/**
 * POST /api/crm/chat/message
 *   { session_id?, message, language } →
 *   { session_id, content, response_time_ms }
 *
 * - Auto-creates an assistant session when session_id is missing
 *   (title = first 50 chars of the first message).
 * - Sends ≤20 messages of history (19 prior + the new user message) to the LLM.
 * - 429 passthrough on CrmRateLimitError with wait_seconds.
 */
export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }
  const message = String(body?.message ?? '').trim();
  const language = String(body?.language || 'english');
  let sessionId: string | null = body?.session_id ? String(body.session_id) : null;

  if (!message) return Response.json({ error: 'Message is required' }, { status: 400 });

  try {
    const db = getDb();

    if (sessionId) {
      const session = db.prepare(`
        SELECT id FROM crm_chat_sessions WHERE id = ? AND user_id = ? AND mode = 'assistant'
      `).get(sessionId);
      if (!session) return Response.json({ error: 'Chat session not found' }, { status: 404 });
    } else {
      sessionId = generateId();
      db.prepare(`
        INSERT INTO crm_chat_sessions (id, user_id, title, mode)
        VALUES (?, ?, ?, 'assistant')
      `).run(sessionId, me.id, message.slice(0, 50));
    }

    // Prior history — newest 19, restored to chronological order. Together with
    // the new user message that's a ≤20-message window for the LLM.
    const prior = (db.prepare(`
      SELECT role, content FROM crm_messages
      WHERE session_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 19
    `).all(sessionId) as { role: string; content: string }[]).reverse();

    const history: CrmMessage[] = prior
      .filter(r => r.role === 'user' || r.role === 'assistant')
      .map(r => ({ role: r.role as 'user' | 'assistant', content: r.content }));

    // Save the user message before calling the LLM (mirrors the Flask app).
    db.prepare(`
      INSERT INTO crm_messages (id, session_id, role, content)
      VALUES (?, ?, 'user', ?)
    `).run(generateId(), sessionId, message);

    const system = buildAssistantPrompt(formatKbForPrompt(getKnowledge())) + languageSuffix(language);

    const t0 = Date.now();
    const content = await callCrmLlm({
      messages: [...history, { role: 'user', content: message }],
      system,
      maxTokens: 8192,
      temperature: 0.7,
    });
    const responseTimeMs = Date.now() - t0;

    db.prepare(`
      INSERT INTO crm_messages (id, session_id, role, content, response_time_ms)
      VALUES (?, ?, 'assistant', ?, ?)
    `).run(generateId(), sessionId, content, responseTimeMs);
    db.prepare(`UPDATE crm_chat_sessions SET updated_at = datetime('now') WHERE id = ?`).run(sessionId);

    return Response.json({
      session_id: sessionId,
      content,
      response_time_ms: responseTimeMs,
    });
  } catch (e: any) {
    if (e instanceof CrmRateLimitError) {
      return Response.json({
        error: 'AI is busy right now. Please wait a moment and try again.',
        wait_seconds: e.waitSeconds,
      }, { status: 429 });
    }
    console.error('POST /api/crm/chat/message failed:', e);
    return Response.json({ error: e?.message || 'Failed to get a response' }, { status: 500 });
  }
}
