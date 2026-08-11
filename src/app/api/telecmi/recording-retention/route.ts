/* eslint-disable @typescript-eslint/no-explicit-any */
import { after } from 'next/server';
import { getDb, logAuditEvent } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import {
  RECORDING_RETENTION_CHOICES,
  RECORDING_RETENTION_DEFAULT_DAYS,
  RECORDING_RETENTION_KEY,
  ctRecordingRetentionDays,
  normalizeRecordingRetentionDays,
  setCtSetting,
} from '@/lib/ct/settings';
import {
  LOCAL_RECORDING_STORE,
  countExpiredRecordings,
  maybeSweepRecordingRetention,
  readSweepWatermark,
  sweepRecordingRetention,
} from '@/lib/ct/retention';

/**
 * GET / PUT /api/telecmi/recording-retention — admin only.
 *
 * The read + write path for how long call recordings stay reachable (7 / 15 /
 * 30 days, default 30). It lives here rather than in /api/crm-calls/settings
 * because that route's PUT allowlist is derived from CT_SETTING_DEFAULTS and
 * every allowed key needs a matching validate() case there; a key added to the
 * map without one makes the PUT answer "Unknown setting", and a key left out
 * of the map is skipped silently, which would make a save look like it worked
 * and change nothing. Both are worse than one small route that owns the
 * setting, validates it against the offered choices, and audits the change.
 * (The setting still READS BACK through /api/crm-calls/settings' GET, which
 * hands over every non-secret ct_settings row — see the release-gate comment
 * there. It is a number of days, so that is fine.)
 *
 * /api/telecmi is in CSRF_REQUIRED_PREFIXES (src/proxy.ts), so the PUT is
 * CSRF-checked; the console posts through @/lib/api, which supplies the header.
 *
 * Both verbs hand the throttled expiry sweep to after() so it runs once the
 * response has been sent and can never add latency to this request.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

function state() {
  const db = getDb();
  const days = ctRecordingRetentionDays(db);

  let stored: string | null = null;
  let sweptTo: string | null = null;
  try {
    const row = db.prepare(
      `SELECT value FROM ct_settings WHERE key = ?`,
    ).get(RECORDING_RETENTION_KEY) as { value?: string } | undefined;
    stored = row ? String(row.value ?? '') : null;
    // Timestamp half only: the watermark can carry a "<time>|<call id>" cursor
    // when a pass stopped mid-window, and the console renders this as a date.
    sweptTo = readSweepWatermark(db).at || null;
  } catch { /* pre-migration DB → defaults below */ }

  const expired = countExpiredRecordings(db);

  return {
    days,
    choices: [...RECORDING_RETENTION_CHOICES],
    default_days: RECORDING_RETENTION_DEFAULT_DAYS,
    // 'default' also covers a stored value that is not one of the choices —
    // the accessor ignores those, and the console should say what is actually
    // in force rather than echo an unusable row back.
    source: normalizeRecordingRetentionDays(stored) == null ? 'default' : 'db',
    /** Where the sweeper has already walked to (a call start timestamp). */
    swept_to: sweptTo,
    /**
     * The literal truth about local storage, so the UI never implies files are
     * being kept and deleted when none are. 'none' = recordings are proxied
     * from TeleCMI per play and nothing is written to disk.
     */
    local_store: LOCAL_RECORDING_STORE,
    stores_audio: LOCAL_RECORDING_STORE !== 'none',
    /** Stored recording URLs already past the window (capped — see the lib). */
    expired_recordings: expired,
  };
}

export async function GET() {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  const payload = state();
  after(() => maybeSweepRecordingRetention());
  return Response.json(payload);
}

export async function PUT(req: Request) {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const days = normalizeRecordingRetentionDays(body?.days);
  if (days == null) {
    return Response.json({
      error: `Retention must be one of ${RECORDING_RETENTION_CHOICES.join(', ')} days`,
    }, { status: 400 });
  }

  const db = getDb();
  const before = ctRecordingRetentionDays(db);
  setCtSetting(db, RECORDING_RETENTION_KEY, String(days));

  if (before !== days) {
    // Shortening a retention window makes recordings unreachable and (once
    // anything is stored locally) deletes them, so who changed it and when is
    // part of the privacy trail, not just a settings tweak.
    logAuditEvent(db, {
      event_type: 'recording.retention.updated',
      entity_type: 'ct_recording_retention',
      entity_id: RECORDING_RETENTION_KEY,
      actor_email: gate.user.email || '',
      before: { days: before },
      after: { days },
      note: `Call-recording retention changed from ${before} to ${days} days`,
    });
  }

  const payload = state();
  // Shortening the window can expire recordings the moment it is saved, so
  // this pass deliberately BYPASSES the 10-minute throttle that the GET uses —
  // an admin who just cut retention should not wait out someone else's sweep.
  // Still after(), so the wait is never theirs.
  after(() => sweepRecordingRetention());
  return Response.json({ ...payload, saved: true, changed: before !== days });
}
