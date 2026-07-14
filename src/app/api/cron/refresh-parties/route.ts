import { refreshUpcomingParties } from '@/lib/party-refresh';
import { checkDeferDueSoon } from '@/lib/defer-due-check';
import { getCurrentUser } from '@/lib/auth';
import { getSchedulerStatus } from '@/lib/scheduler';
import { runWaDailyNotifications } from '@/lib/whatsapp';
import { getDb } from '@/lib/db';
import { runTaskAutomation } from '@/lib/task-automation';

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

  // WhatsApp daily jobs (low-stock summary + owner digest) — each guarded by
  // its Notifications-tab toggle + the master switch, deduped to once per day,
  // and fully best-effort. Runs FIRST so a Sheets refresh failure can never
  // starve the daily pings; equally, these can never fail the refresh.
  let wa_daily: any = null;
  try {
    wa_daily = await runWaDailyNotifications();
  } catch (e: any) {
    console.error('[/api/cron/refresh-parties] whatsapp daily jobs failed:', e?.message);
  }

  // Task Management daily automation (recurring + maintenance generation, overdue
  // sweep + escalation). Idempotent per IST day, fully best-effort, never throws.
  let task_automation: any = null;
  try {
    task_automation = runTaskAutomation(getDb());
  } catch (e: any) {
    console.error('[/api/cron/refresh-parties] task automation failed:', e?.message);
  }

  try {
    const result = await refreshUpcomingParties(tokenOk ? 'external_cron' : 'admin_manual');
    // Feature 4 — same pipeline also checks deferred items coming due. Fully
    // best-effort: never let it fail the refresh response.
    let defer_due: any = null;
    try {
      defer_due = await checkDeferDueSoon(tokenOk ? 'external_cron' : 'admin_manual');
    } catch (e: any) {
      console.error('[/api/cron/refresh-parties] defer-due check failed:', e?.message);
    }
    return Response.json({ ok: true, result, defer_due, wa_daily, task_automation });
  } catch (e: any) {
    console.error('[/api/cron/refresh-parties]', e);
    // wa_daily + task_automation ran before the refresh — report them even on
    // failure so external cron logs show whether the daily jobs dispatched.
    return Response.json({ error: e.message, wa_daily, task_automation }, { status: 500 });
  }
}
