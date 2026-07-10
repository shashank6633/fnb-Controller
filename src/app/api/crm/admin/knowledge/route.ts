/**
 * CRM Admin — Knowledge Base (all sections).
 *
 * GET /api/crm/admin/knowledge → { sections: { venue_info: {...}, ... } }
 *
 * GET is open to ANY signed-in user (staff read the KB from the assistant +
 * call-scripts pages); editing individual sections is admin-only and lives in
 * ./[section]/route.ts.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { getCurrentUser } from '@/lib/auth';
import { getKnowledgeSection, KB_SECTIONS } from '@/lib/crm-llm';

export const dynamic = 'force-dynamic';

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  const sections: Record<string, any> = {};
  for (const s of KB_SECTIONS) {
    sections[s] = getKnowledgeSection(s) ?? {};
  }
  return Response.json({ sections });
}
