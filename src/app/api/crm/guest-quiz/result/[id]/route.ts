/**
 * GET /api/crm/guest-quiz/result/[id] — PUBLIC by design (no staff session).
 *
 * Report card for a finished (completed or cheat-terminated) guest session.
 * The id is an unguessable UUID handed out by /start — that is the access key.
 */
import { getDb } from '@/lib/db';
import { buildGuestReport, type GuestSessionRow, type QuizLinkRow } from '@/lib/crm-guest-quiz';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = getDb();

    const session = db
      .prepare("SELECT * FROM crm_guest_quiz_sessions WHERE id = ? AND status != 'active'")
      .get(id) as GuestSessionRow | undefined;

    if (!session) {
      return Response.json({ error: 'Completed quiz session not found' }, { status: 404 });
    }

    const link = db
      .prepare('SELECT * FROM crm_quiz_links WHERE id = ?')
      .get(session.link_id) as QuizLinkRow | undefined;
    if (!link) {
      return Response.json({ error: 'Quiz link not found' }, { status: 404 });
    }

    const report = buildGuestReport(session, link);

    return Response.json({
      ...report,
      guest_name: session.guest_name,
      guest_position: session.guest_position,
      status: session.status,
      time_taken_seconds: session.time_taken_seconds,
      completed_at: session.completed_at,
      quiz_title: link.title,
    });
  } catch (e: any) {
    console.error('[/api/crm/guest-quiz/result GET]', e);
    return Response.json({ error: 'Failed to load result' }, { status: 500 });
  }
}
