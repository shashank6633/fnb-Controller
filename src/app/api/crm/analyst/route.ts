/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { callCrmLlm, CrmRateLimitError, type CrmMessage } from '@/lib/crm-llm';
import { ANALYST_VIEWS, type AnalystViewName } from '@/lib/crm-analyst-data';

/**
 * POST /api/crm/analyst
 *   { question, session_id? } →
 *   { session_id, content, views_used, response_time_ms }
 *
 * AI Analyst — natural-language Q&A over LIVE inventory/sales/cost data.
 * No text-to-SQL: a keyword router picks deterministic data-pack views
 * (crm-analyst-data.ts) and the LLM answers ONLY from that JSON.
 *
 * Gate: admin or HOD (is_head_chef) — same audience as party P&L, because the
 * data pack contains revenue/cost/margin figures.
 *
 * Persistence: reuses crm_chat_sessions with mode='analyst' + crm_messages.
 */
export const dynamic = 'force-dynamic';

const ROUTES: { pattern: RegExp; views: AnalystViewName[] }[] = [
  { pattern: /reorder|restock|re-order|stock|order|running (low|out)|out of/, views: ['stockAlerts', 'reorderSuggestions'] },
  { pattern: /cost|expensive|spend|spending|purchas|vendor|price/, views: ['foodCost', 'purchaseTrends'] },
  { pattern: /margin|profit|menu|dish/, views: ['menuMargins', 'salesSummary'] },
  { pattern: /variance|missing|theft|shrink|pilfer/, views: ['varianceReport'] },
  { pattern: /waste|wastage|spoil/, views: ['wastageSummary'] },
  { pattern: /slow|dead|idle|unused/, views: ['slowMovers'] },
  { pattern: /sales|revenue|top|best.?sell|selling/, views: ['salesSummary'] },
];
const DEFAULT_VIEWS: AnalystViewName[] = ['stockAlerts', 'salesSummary', 'foodCost'];
const MAX_VIEWS = 4;

function pickViews(question: string): AnalystViewName[] {
  const q = question.toLowerCase();
  const picked: AnalystViewName[] = [];
  for (const r of ROUTES) {
    if (!r.pattern.test(q)) continue;
    for (const v of r.views) {
      if (!picked.includes(v) && picked.length < MAX_VIEWS) picked.push(v);
    }
    if (picked.length >= MAX_VIEWS) break;
  }
  return picked.length ? picked : DEFAULT_VIEWS;
}

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  // Financial data (costs / revenue / margins) — same gate as party P&L.
  if (!(me.role === 'admin' || me.is_head_chef)) {
    return Response.json({ error: 'Not authorised' }, { status: 403 });
  }

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }
  const question = String(body?.question ?? '').trim();
  let sessionId: string | null = body?.session_id ? String(body.session_id) : null;
  if (!question) return Response.json({ error: 'Question is required' }, { status: 400 });

  try {
    const db = getDb();

    if (sessionId) {
      const session = db.prepare(`
        SELECT id FROM crm_chat_sessions WHERE id = ? AND user_id = ? AND mode = 'analyst'
      `).get(sessionId, me.id);
      if (!session) return Response.json({ error: 'Chat session not found' }, { status: 404 });
    } else {
      sessionId = generateId();
      db.prepare(`
        INSERT INTO crm_chat_sessions (id, user_id, title, mode)
        VALUES (?, ?, ?, 'analyst')
      `).run(sessionId, me.id, question.slice(0, 50));
    }

    // Build the deterministic data pack from the live DB.
    const viewsUsed = pickViews(question);
    const dataPack: Record<string, unknown> = {};
    for (const v of viewsUsed) dataPack[v] = ANALYST_VIEWS[v](db);

    // Chat history (≤10 prior messages, chronological).
    const prior = (db.prepare(`
      SELECT role, content FROM crm_messages
      WHERE session_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 10
    `).all(sessionId) as { role: string; content: string }[]).reverse();
    const history: CrmMessage[] = prior
      .filter(r => r.role === 'user' || r.role === 'assistant')
      .map(r => ({ role: r.role as 'user' | 'assistant', content: r.content }));

    // Save the user question before calling the LLM (mirrors the chat route).
    db.prepare(`
      INSERT INTO crm_messages (id, session_id, role, content)
      VALUES (?, ?, 'user', ?)
    `).run(generateId(), sessionId, question);

    const system =
      `You are the AKAN F&B Controller analyst — an expert restaurant inventory, cost and sales analyst. ` +
      `Answer ONLY from the DATA below; never invent numbers that are not in it. ` +
      `All money is INR (₹). Be specific — quote the actual figures, names and dates from the data. ` +
      `Write concise, actionable markdown: short sections, bullet points, and simple pipe tables where they help. ` +
      `End with a clear recommendation when the question asks for a decision. ` +
      `If the data cannot answer the question, say exactly what data is missing (e.g. "no closing-stock counts recorded"). ` +
      `Today is ${new Date().toISOString().slice(0, 10)}.\n\n` +
      `DATA (JSON, views: ${viewsUsed.join(', ')}):\n` +
      JSON.stringify(dataPack);

    const t0 = Date.now();
    const content = await callCrmLlm({
      messages: [...history, { role: 'user', content: question }],
      system,
      maxTokens: 4096,
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
      views_used: viewsUsed,
      response_time_ms: responseTimeMs,
    });
  } catch (e: any) {
    if (e instanceof CrmRateLimitError) {
      return Response.json({
        error: 'AI is busy right now. Please wait a moment and try again.',
        wait_seconds: e.waitSeconds,
      }, { status: 429 });
    }
    console.error('POST /api/crm/analyst failed:', e);
    return Response.json({ error: e?.message || 'Failed to get a response' }, { status: 500 });
  }
}
