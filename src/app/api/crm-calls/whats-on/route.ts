import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { todayIST } from '@/lib/format-date';
import { buildWhatsOn } from '@/lib/ct/whats-on';

/**
 * GRE "What's On" board — read-only aggregate for a single date.
 *
 * GET /api/crm-calls/whats-on?date=YYYY-MM-DD  (defaults to today, IST)
 * Any signed-in user. Never throws — buildWhatsOn degrades each source to empty.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });

  const sp = new URL(req.url).searchParams;
  const raw = (sp.get('date') || '').trim();
  const date = DATE_RE.test(raw) ? raw : todayIST();

  const db = getDb();
  const outletId = await getCurrentOutletId().catch(() => null);
  const result = buildWhatsOn(db, date, outletId);
  return Response.json(result);
}
