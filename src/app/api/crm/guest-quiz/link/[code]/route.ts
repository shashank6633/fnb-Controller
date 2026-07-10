/**
 * GET /api/crm/guest-quiz/link/[code] — PUBLIC by design (no staff session).
 *
 * Link metadata that drives the /quiz/link/<code> page: title, difficulty,
 * question count, pass threshold — or a human-readable error for
 * invalid / deactivated / expired / maxed-out links.
 */
import { getLinkByCode, validateLink } from '@/lib/crm-guest-quiz';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  try {
    const { code } = await params;
    const link = getLinkByCode(String(code || '').trim());
    const error = validateLink(link);

    if (error || !link) {
      return Response.json({ ok: false, error: error || 'Quiz link not found.' }, { status: link ? 400 : 404 });
    }

    return Response.json({
      ok: true,
      link: {
        code: link.link_code,
        title: link.title,
        difficulty: link.difficulty,
        question_count: link.question_count,
        pass_threshold: link.pass_threshold,
      },
    });
  } catch (e: any) {
    console.error('[/api/crm/guest-quiz/link GET]', e);
    return Response.json({ ok: false, error: 'Failed to load quiz link.' }, { status: 500 });
  }
}
