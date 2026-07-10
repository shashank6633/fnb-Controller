/**
 * CRM Admin — Knowledge Base AI Assist (ADMIN only).
 *
 * POST /api/crm/admin/kb-assist  { section, instruction }
 *   → { updated, summary }
 *
 * PREVIEW ONLY — nothing is saved here. The client shows the proposed JSON +
 * summary and applies it via PUT /api/crm/admin/knowledge/:section.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { requireRole } from '@/lib/auth';
import { callCrmLlm, CrmRateLimitError, getKnowledgeSection, KB_SECTIONS } from '@/lib/crm-llm';
import { buildKbAssistSystemPrompt, buildKbAssistUserMessage, parseKbAssistReply } from '@/lib/crm-prompts';

export async function POST(req: Request) {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  let body: any;
  try { body = await req.json(); } catch {
    return Response.json({ error: 'Request body must be JSON' }, { status: 400 });
  }
  const section = String(body?.section || '').trim();
  const instruction = String(body?.instruction || '').trim();
  if (!section || !instruction) {
    return Response.json({ error: 'Section and instruction are required' }, { status: 400 });
  }
  if (!(KB_SECTIONS as readonly string[]).includes(section)) {
    return Response.json({ error: `Unknown knowledge section "${section}"` }, { status: 400 });
  }

  const current = getKnowledgeSection(section) ?? {};

  try {
    const raw = await callCrmLlm({
      system: buildKbAssistSystemPrompt(section),
      messages: [{ role: 'user', content: buildKbAssistUserMessage(section, current, instruction) }],
      // KB sections (menu_info especially) are large — the model must echo the
      // COMPLETE updated JSON, and gemini-2.5-flash also spends tokens thinking.
      maxTokens: 16384,
      temperature: 0.4,
    });
    const { updated, summary } = parseKbAssistReply(raw);
    return Response.json({ updated, summary });
  } catch (e: any) {
    if (e instanceof CrmRateLimitError) {
      return Response.json({ error: e.message, wait_seconds: e.waitSeconds }, { status: 429 });
    }
    const msg = e instanceof Error ? e.message : 'AI assist failed';
    // Parse failures ("AI did not return valid JSON") are 400s the admin can
    // retry with a clearer instruction; anything else is a 500.
    const status = /valid JSON|invalid JSON/i.test(msg) ? 400 : 500;
    return Response.json({ error: msg }, { status });
  }
}
