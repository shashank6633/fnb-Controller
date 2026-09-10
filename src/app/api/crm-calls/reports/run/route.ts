/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { runReportJob, runWaReportJobs, scheduledReportKeys } from '@/lib/wa-report-jobs';
import { reportDef } from '@/lib/wa-report-builders';

/**
 * POST /api/crm-calls/reports/run — send a scheduled report NOW, to its real
 * recipients. ADMIN ONLY: this spends template sends and puts the day's
 * takings in people's chats.
 *
 * Body: { key }        one report
 *       { due: true }  every report whose configured time has passed
 *
 * ── IT DOES NOT DOUBLE-SEND WITH THE SCHEDULE ────────────────────────────
 * A manual run is recorded as trigger_source 'manual', so it does not occupy
 * the day's slot — but every successful send writes an ok:true row naming the
 * report to whatsapp_events_log, and the scheduler consults that log as its
 * second gate. So running the daily ops report by hand at 07:00 means the
 * 08:00 tick claims the slot, sees the delivery in the log, and stands down.
 * Both gates must agree before anything goes out, which is why two gates that
 * could in principle disagree are safe here: they can only ever subtract.
 *
 * `force` is deliberately NOT offered. There is no legitimate "send it twice"
 * button for a report that costs money and lands in an owner's chat; if a send
 * genuinely failed, its ledger row says 'failed' and the next tick retries it.
 */
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (me.role !== 'admin') {
    return Response.json({ error: 'Only an admin may send a report to its real recipients. Use Send Test to message yourself.' }, { status: 403 });
  }

  const body = await req.json().catch(() => null) as any;
  const db = getDb();

  if (body?.due === true) {
    const out = await runWaReportJobs(db, { ignoreTime: false });
    return Response.json({ ok: true, results: out });
  }

  const key = String(body?.key || '').trim();
  const def = reportDef(key);
  if (!def) return Response.json({ error: `"${key}" is not a report this app knows about.` }, { status: 400 });
  if (!scheduledReportKeys().includes(key)) {
    return Response.json({ error: `“${def.label}” is an event alert — it fires from the business action, not from a button.` }, { status: 400 });
  }

  const res = await runReportJob(db, key, { trigger: 'manual', actor: me.email });
  return Response.json({ ok: res.status === 'sent' || res.status === 'partial', result: res });
}
