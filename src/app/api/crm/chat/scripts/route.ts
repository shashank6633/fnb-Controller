import { getCurrentUser } from '@/lib/auth';
import { getKnowledgeSection } from '@/lib/crm-llm';

export const dynamic = 'force-dynamic';

/**
 * GET /api/crm/chat/scripts → { scripts: [...] }
 * Call scripts from the CRM knowledge base — staff reference for common phone
 * call scenarios. Any signed-in user may read them.
 */
export async function GET() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const section = getKnowledgeSection('call_scripts');
    const scripts = Array.isArray(section?.scripts) ? section.scripts : [];

    return Response.json({ scripts });
  } catch (e: any) {
    console.error('GET /api/crm/chat/scripts failed:', e);
    return Response.json({ error: e?.message || 'Failed to load call scripts' }, { status: 500 });
  }
}
