import { refreshUpcomingParties } from '@/lib/party-refresh';
import { getCurrentUser } from '@/lib/auth';
import { getSchedulerStatus } from '@/lib/scheduler';

/**
 * Manual / external trigger for the party-sheet refresh + audit + notify
 * pipeline. Same code path the in-process scheduler runs every 15 min.
 *
 *   GET  /api/cron/refresh-parties → status only (last run + result)
 *   POST /api/cron/refresh-parties → run now (admin or CRON_TOKEN header)
 *
 * For external cron (systemd timer, cron job, GCP Cloud Scheduler):
 *   curl -X POST -H "x-cron-token: $CRON_TOKEN" http://server/api/cron/refresh-parties
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ scheduler: getSchedulerStatus() });
}

export async function POST(request: Request) {
  // Either admin session OR matching CRON_TOKEN header (for external schedulers)
  const tokenHeader = request.headers.get('x-cron-token');
  const expectedToken = process.env.CRON_TOKEN;
  const tokenOk = !!(expectedToken && tokenHeader && tokenHeader === expectedToken);

  if (!tokenOk) {
    const me = await getCurrentUser();
    if (!me || me.role !== 'admin') {
      return Response.json({ error: 'Admin or valid x-cron-token required' }, { status: 401 });
    }
  }

  try {
    const result = await refreshUpcomingParties(tokenOk ? 'external_cron' : 'admin_manual');
    return Response.json({ ok: true, result });
  } catch (e: any) {
    console.error('[/api/cron/refresh-parties]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
