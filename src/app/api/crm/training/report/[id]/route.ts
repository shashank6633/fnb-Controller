/**
 * GET /api/crm/training/report/:id → the training report for one of MY
 * sessions (grade, percentage, category_scores, weak_areas, responses).
 */

import { getCurrentUser } from '@/lib/auth';
import { generateTrainingReport } from '@/lib/crm-reports';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  const { id } = await params;

  try {
    const report = generateTrainingReport(id);
    // 404 (not 403) when it isn't mine — don't leak that the session exists.
    if (!report || report.user_id !== me.id) {
      return Response.json({ error: 'Report not found' }, { status: 404 });
    }
    // user_id is an internal ownership field — no need to expose it.
    const pub: Record<string, unknown> = { ...report };
    delete pub.user_id;
    return Response.json(pub);
  } catch (e: unknown) {
    console.error('GET /api/crm/training/report/[id] failed:', e);
    const msg = e instanceof Error ? e.message : 'Failed to load report';
    return Response.json({ error: msg }, { status: 500 });
  }
}
