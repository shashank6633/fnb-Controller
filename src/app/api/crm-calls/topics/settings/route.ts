/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { setCtSetting } from '@/lib/ct/settings';
import { TOPIC_TRACKING_KEY, isTopicTrackingOn, alertCount } from '@/lib/ct/topics';

/**
 * CRM — Topic Alerts · master switch (/api/crm-calls/topics/settings).
 *
 * PUT { topic_tracking: '0' | '1' } — ADMIN only, matching the rest of CRM
 * settings (/api/crm-calls/settings is admin-gated too).
 *
 * `topic_tracking` is deliberately NOT in CT_SETTING_DEFAULTS (that file is
 * shared and owned elsewhere): ctSetting() returns '' for an unknown key, so an
 * unset flag reads as OFF. The generic CRM settings PUT ignores keys outside
 * its allowlist, so it can never clobber this one either.
 *
 * Turning the flag OFF stops all future recording immediately; it does NOT
 * delete hits already recorded (they are review history, and silently erasing
 * a queue someone is working would be worse than leaving it). Delete a rule to
 * remove its hits.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function PUT(req: Request) {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json({ error: 'Body must be an object' }, { status: 400 });
  }
  if (body[TOPIC_TRACKING_KEY] === undefined) {
    return Response.json({ error: `topic_tracking required ('0' or '1')` }, { status: 400 });
  }

  const raw = body[TOPIC_TRACKING_KEY];
  const value = raw === true || raw === 1 || raw === '1' ? '1'
    : raw === false || raw === 0 || raw === '0' ? '0' : null;
  if (value === null) return Response.json({ error: "topic_tracking must be '0' or '1'" }, { status: 400 });

  const db = getDb();
  setCtSetting(db, TOPIC_TRACKING_KEY, value);

  return Response.json({
    success: true,
    topic_tracking: isTopicTrackingOn(db) ? '1' : '0',
    alert_count: alertCount(db),
  });
}
