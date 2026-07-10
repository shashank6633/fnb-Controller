/**
 * CRM Admin — Knowledge Base (single section).
 *
 * GET /api/crm/admin/knowledge/:section       → { section, content } (any signed-in user)
 * PUT /api/crm/admin/knowledge/:section       → { content } saves the section (ADMIN only)
 *
 * `content` may be a JSON object or a JSON string — either way it is validated
 * (400 on bad JSON) before saveKnowledgeSection persists it.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { getCurrentUser, requireRole } from '@/lib/auth';
import { getKnowledgeSection, saveKnowledgeSection, KB_SECTIONS } from '@/lib/crm-llm';

export const dynamic = 'force-dynamic';

function isValidSection(section: string): boolean {
  return (KB_SECTIONS as readonly string[]).includes(section);
}

export async function GET(_req: Request, { params }: { params: Promise<{ section: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  const { section } = await params;
  if (!isValidSection(section)) {
    return Response.json({ error: `Unknown knowledge section "${section}"` }, { status: 400 });
  }
  return Response.json({ section, content: getKnowledgeSection(section) ?? {} });
}

export async function PUT(req: Request, { params }: { params: Promise<{ section: string }> }) {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  const { section } = await params;
  if (!isValidSection(section)) {
    return Response.json({ error: `Unknown knowledge section "${section}"` }, { status: 400 });
  }

  let body: any;
  try { body = await req.json(); } catch {
    return Response.json({ error: 'Request body must be JSON' }, { status: 400 });
  }
  const content = body?.content;
  if (content === undefined || content === null) {
    return Response.json({ error: 'content is required' }, { status: 400 });
  }

  // Validate JSON before persisting — string bodies must parse, objects must stringify.
  let serialized: string;
  try {
    serialized = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    JSON.parse(serialized);
  } catch (e: any) {
    return Response.json({ error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` }, { status: 400 });
  }

  try {
    saveKnowledgeSection(section, serialized, gate.user.email);
  } catch (e: any) {
    return Response.json({ error: e instanceof Error ? e.message : 'Save failed' }, { status: 400 });
  }
  return Response.json({ ok: true, section });
}
