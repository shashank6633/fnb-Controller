import { after } from 'next/server';
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { describeUpstreamRefusal, fetchAllowedRecording } from '@/lib/ct/recording-fetch';
import {
  logRecordingRefusal,
  maybeSweepRecordingRetention,
  recordingRetentionStatus,
} from '@/lib/ct/retention';

/**
 * GET /api/telecmi/recording/[callId] — auth-gated recording proxy.
 *
 * [callId] matches ct_calls.id OR ct_calls.telecmi_call_id. The stored
 * recording_url (TeleCMI CDN) is fetched SERVER-SIDE and the audio is streamed
 * back with content-type passthrough — the TeleCMI URL is NEVER exposed to and
 * we NEVER redirect the client (recordings are personal data; playback stays
 * behind our session auth). Range headers are forwarded so <audio> can seek.
 *
 * SSRF guard lives in fetchAllowedRecording (src/lib/ct/recording-fetch.ts):
 * HTTPS only, host allowlist (*.telecmi.com + ct_settings override), manual
 * redirect follow re-validating every hop. Shared with the AI analyze lib.
 * That helper also normalizes the TeleCMI play URL and attaches credentials for
 * the outgoing request only — see its header for the measured vendor contract.
 *
 * EVERY FAILURE PATH ANSWERS JSON, AND THE PLAYER READS IT. An <audio> element
 * handed a JSON body renders a silent 0:00/0:00 with a dead play button and
 * throws the reason away, which is how a broken playback URL survived unnoticed.
 * The bodies below are therefore written as sentences a GRE can act on, and
 * src/components/ct/RecordingPlayer.tsx fetches and displays them on error.
 * Anything added here must keep the { error } key: that is the whole contract.
 *
 * RETENTION. This route is also where the recording-retention window is
 * enforced, and it is the ONLY place that can be: nothing on this deployment
 * stores the audio, so "delete it after N days" has no file to act on, while
 * "stop fetching it after N days" is real and holds even for a call whose URL
 * a later CDR re-import puts back. The check is computed from the call's own
 * timestamp (src/lib/ct/retention.ts) rather than a flag some job has to have
 * set, so it cannot be out of date, and it sits BEFORE the upstream fetch —
 * an expired recording is never pulled from TeleCMI at all.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: Request, { params }: { params: Promise<{ callId: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  // Opportunistic expiry pass, the same shape as sweep() in src/lib/ct/ingest.ts:
  // self-throttled to once per 10 minutes per process, and handed to after() so
  // it runs when this response is finished instead of ahead of the audio. It is
  // armed here rather than at the end so it still fires on the 404 / 410 paths.
  after(() => maybeSweepRecordingRetention());

  const { callId } = await params;
  const db = getDb();
  // started_at / created_at come back for the retention check below. The OR
  // still resolves to a MULTI-INDEX OR over the two unique indexes (id,
  // telecmi_call_id) — verified with EXPLAIN QUERY PLAN — so this stays a
  // point lookup, not a scan, however large ct_calls grows.
  const row = db.prepare(
    `SELECT id, recording_url, started_at, created_at FROM ct_calls WHERE id = ? OR telecmi_call_id = ?`,
  ).get(callId, callId) as any;
  if (!row) return Response.json({ error: 'Call not found' }, { status: 404 });
  if (!row.recording_url) return Response.json({ error: 'No recording for this call' }, { status: 404 });

  // Retention gate — before the upstream fetch, so an expired recording is
  // never pulled from TeleCMI, never cached, never streamed. 410 Gone rather
  // than 404: this recording existed and was withdrawn on purpose, and a
  // client should not retry it.
  const retention = recordingRetentionStatus(db, row);
  if (retention.expired) {
    logRecordingRefusal(db, String(row.id), retention, me.email || '');
    return Response.json({
      error: retention.reason === 'undated'
        ? 'This recording cannot be dated, so it is not served — its age against the retention period cannot be established.'
        : `This recording has passed its ${retention.days}-day retention period and is no longer available.`,
      expired: true,
      reason: retention.reason,
      retention_days: retention.days,
      expired_at: retention.expiresAt || null,
    }, { status: 410 });
  }

  // 15s to reach headers; once the response starts the timer is cleared so a
  // long audio stream is never cut mid-play.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let upstream;
  try {
    upstream = await fetchAllowedRecording(db, String(row.recording_url), {
      rangeHeader: req.headers.get('range'),
      signal: controller.signal,
    });
  } catch (e: any) {
    clearTimeout(timer);
    const msg = e?.name === 'AbortError'
      ? 'The recording source did not answer within 15 seconds.'
      : (e?.message || 'The recording could not be fetched.');
    return Response.json({ error: msg }, { status: 502 });
  }
  clearTimeout(timer);

  if (upstream.status !== 200 && upstream.status !== 206) {
    // Read the refusal instead of just its number. TeleCMI's own body names the
    // fault ("Cannot GET /v2/play/…", "Authentication Failed"), and a bare
    // "responded 404" has already cost one round of hunting the wrong layer.
    // The body is being discarded either way, so peeking it costs nothing.
    return Response.json({ error: await describeUpstreamRefusal(upstream) }, { status: 502 });
  }

  const h = new Headers();
  h.set('Content-Type', upstream.contentType);
  for (const k of ['content-length', 'content-range', 'accept-ranges'] as const) {
    const v = upstream.headers.get(k);
    if (v) h.set(k, v);
  }
  h.set('Cache-Control', 'private, no-store');
  h.set('Content-Disposition', `inline; filename="recording-${row.id}"`);

  // Stream the body through (200 for full, 206 for range responses).
  return new Response(upstream.body, { status: upstream.status, headers: h });
}
