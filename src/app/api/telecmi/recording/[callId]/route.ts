import { after } from 'next/server';
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import {
  classifyUpstreamRefusal,
  fetchAllowedRecording,
  RecordingFetchError,
  type RecordingFailureReason,
} from '@/lib/ct/recording-fetch';
import {
  logRecordingRefusal,
  maybeSweepRecordingRetention,
  recordingRetentionStatus,
} from '@/lib/ct/retention';

/**
 * GET /api/telecmi/recording/[callId] — auth-gated recording proxy.
 *
 * [callId] matches ct_calls.id OR ct_calls.telecmi_call_id. The stored
 * recording_url (a TeleCMI filename, or a URL built from one) is fetched
 * SERVER-SIDE and the audio is streamed back with content-type passthrough —
 * the TeleCMI URL is NEVER exposed and we NEVER redirect the client
 * (recordings are personal data; playback stays behind our session auth).
 * Range headers are forwarded so <audio> can seek.
 *
 * SSRF guard lives in fetchAllowedRecording (src/lib/ct/recording-fetch.ts):
 * HTTPS only, host allowlist (*.telecmi.com + ct_settings override), manual
 * redirect follow re-validating every hop. Shared with the AI analyze lib.
 * That helper also rebuilds the stored value into TeleCMI's documented
 * /v2/play?appid=&secret=&file= form and attaches the credentials for the
 * outgoing request only — see its header for the vendor contract.
 *
 * EVERY FAILURE PATH ANSWERS JSON, AND THE PLAYER READS IT. An <audio> element
 * handed a JSON body renders a silent 0:00/0:00 with a dead grey play button
 * and throws the reason away, which is how a broken playback URL survived
 * unnoticed. The bodies below are therefore written as sentences a GRE can act
 * on, and src/components/ct/RecordingPlayer.tsx fetches and displays them on
 * error. Anything added here must keep the { error } key: that is the whole
 * contract with the player. `fault` and `credentialed` ride alongside it —
 * additive, and both are the fields RecordingPlayer's classifier documents as
 * the machine-readable verdict it prefers over pattern-matching the prose.
 *
 * NO CREDENTIAL EVER REACHES THIS RESPONSE. The App ID and secret exist only on
 * the outbound query string inside the fetch helper; every message that helper
 * raises has been through scrubCredentials(), and upstream.finalUrl — the one
 * value that does carry them — is deliberately never read here.
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

/**
 * Failure reason → HTTP status.
 *
 * These are not cosmetic. 'not_configured' is the server admitting it was never
 * set up (503 — retrying will not help until someone types the credentials in);
 * 'no_filename' is 404 because the row itself names nothing; 'timeout' is 504.
 *
 * 'file_not_found' IS DELIBERATELY 502, NOT 404. The vendor answered — it just
 * answered "no such recording" — so this is an upstream failure, not a missing
 * resource of ours. It also matters to the player: RecordingPlayer's fallback
 * classifier reads a 404 as "the call row is missing", which is a different and
 * wrong story to tell a GRE. 502 keeps that path on the vendor-prose branch,
 * where "Cannot GET …" / "not found" classify as file_missing.
 */
const REASON_STATUS: Record<RecordingFailureReason, number> = {
  not_configured: 503,
  credentials_rejected: 502,
  no_filename: 404,
  file_not_found: 502,
  invalid_url: 502,
  host_not_allowed: 502,
  timeout: 504,
  network: 502,
  bad_request: 502,
  upstream_error: 502,
};

/**
 * Our failure reason → the fault class RecordingPlayer already understands.
 *
 * WHY A SECOND VOCABULARY. src/components/ct/RecordingPlayer.tsx classifies a
 * failure to pick its copy, and it does so by pattern-matching the English
 * sentence — which is guesswork, and it says so: it cannot tell credentials
 * NOT SET from credentials REJECTED, because TeleCMI answers 407 to both. It
 * documents the way out: a `fault` field in the error body wins outright. This
 * map is that field. The names are the player's FaultKind union verbatim, so a
 * rename there must be mirrored here — and the prose below still matches its
 * fallback patterns, so the player keeps working if this field is ever dropped.
 *
 * `reason` is NOT reused for this: the 410 retention body already spends that
 * key on a retention reason ('undated' / …), and two meanings on one key is how
 * a client ends up reading the wrong one.
 */
const REASON_FAULT: Record<RecordingFailureReason, string> = {
  not_configured: 'credentials_missing',
  credentials_rejected: 'credentials_rejected',
  no_filename: 'not_recorded',
  file_not_found: 'file_missing',
  invalid_url: 'blocked',
  host_not_allowed: 'blocked',
  timeout: 'network',
  network: 'network',
  bad_request: 'url_shape',
  upstream_error: 'unknown',
};

/**
 * Content type → file extension, for the download filename.
 *
 * Keyed on the ESSENCE only (the bit before any ';charset='), because vendors
 * and CDNs decorate these freely. Deliberately a small closed list of the audio
 * types a call recording can actually arrive as: an unknown type falls through
 * to the vendor's own filename rather than being labelled with a guess, because
 * a file named .mp3 that is not an mp3 is worse than one named honestly.
 */
const AUDIO_EXT: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/webm': 'webm',
  'audio/aac': 'aac',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
};

/**
 * The name the browser saves a recording under.
 *
 * Two things it has to get right, both of which it previously got wrong:
 *
 *  1. AN EXTENSION, or the file is unopenable. The old header emitted
 *     `recording-<uuid>` bare, so a download landed as an unrecognised document.
 *  2. A NAME THAT TELLS TWO RECORDINGS APART. Downloading a second call gave
 *     `recording-<uuid>` and `recording-<uuid> (1)` — two identical-looking
 *     files with no way to know which call either belonged to. Leading with the
 *     call DATE makes them sort and identify on sight.
 *
 * Everything is passed through a conservative character filter: the call id is
 * ours, but the vendor filename is not, and a quote or a path separator in a
 * Content-Disposition is a header-injection primitive.
 */
function recordingFilename(
  row: { id: string; recording_url: string | null; started_at: string | null; created_at: string | null },
  contentType: string,
): string {
  const essence = String(contentType || '').split(';')[0].trim().toLowerCase();
  const fromVendor = /\.([a-z0-9]{2,5})(?:$|\?)/i.exec(String(row.recording_url || ''))?.[1]?.toLowerCase();
  const ext = AUDIO_EXT[essence]
    || (fromVendor && Object.values(AUDIO_EXT).includes(fromVendor) ? fromVendor : '')
    || 'mp3';
  const day = String(row.started_at || row.created_at || '').slice(0, 10);   // YYYY-MM-DD
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '');
  const stamp = /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}-` : '';
  return `call-${stamp}${safe(String(row.id)).slice(0, 20)}.${safe(ext)}`;
}

/**
 * The error body. `error` is the sentence and is the load-bearing contract;
 * `fault` is the machine class; `credentialed` answers the one question the
 * player cannot answer for itself — did the outgoing request actually carry an
 * App ID and secret, or did it go out (or not go out) without them. It is a
 * BOOLEAN, never the credentials: nothing in this body can be pasted into a
 * TeleCMI request, and nothing in it is worth redacting from a screenshot.
 */
function fail(reason: RecordingFailureReason, error: string, credentialed: boolean | null = null) {
  const body: Record<string, unknown> = { error, fault: REASON_FAULT[reason] };
  // Omitted, not guessed, when no request went out and the answer is unknown.
  if (credentialed !== null) body.credentialed = credentialed;
  return Response.json(body, { status: REASON_STATUS[reason] });
}

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
  ).get(callId, callId) as
    | { id: string; recording_url: string | null; started_at: string | null; created_at: string | null }
    | undefined;
  if (!row) return Response.json({ error: 'Call not found' }, { status: 404 });
  if (!String(row.recording_url || '').trim()) {
    return fail('no_filename', 'There is no recording on this call — TeleCMI sent no recording file for it.');
  }

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
  } catch (e: unknown) {
    clearTimeout(timer);
    // fetchAllowedRecording already maps an abort to reason 'timeout' and has
    // scrubbed every message it raises. The name check below is the backstop
    // for an abort raised outside it (between the timer and the first read).
    if (e instanceof RecordingFetchError) return fail(e.reason, e.message, e.credentialed);
    if ((e as { name?: string } | null)?.name === 'AbortError') {
      return fail('timeout', 'The recording source did not answer within 15 seconds.');
    }
    return fail('upstream_error', 'The recording could not be fetched.');
  }
  clearTimeout(timer);

  if (upstream.status !== 200 && upstream.status !== 206) {
    // Read the refusal instead of just its number. TeleCMI's own body names the
    // fault ("Cannot GET /v2/play/…", "Authentication Failed"), and a bare
    // "responded 404" has already cost one round of hunting the wrong layer.
    // The body is being discarded either way, so peeking it costs nothing.
    const refusal = await classifyUpstreamRefusal(upstream, db);
    return fail(refusal.reason, refusal.message, refusal.credentialed);
  }

  const h = new Headers();
  h.set('Content-Type', upstream.contentType);
  for (const k of ['content-length', 'content-range', 'accept-ranges'] as const) {
    const v = upstream.headers.get(k);
    if (v) h.set(k, v);
  }
  h.set('Cache-Control', 'private, no-store');
  // A DOWNLOADED RECORDING MUST BE OPENABLE. The browser's own audio control has
  // a Download item, and it names the file from this header — which said
  // `recording-<uuid>` with NO EXTENSION. The bytes were fine; the operating
  // system had nothing to identify them by, so the file landed with a blank
  // "?" icon and would not open in any player. That is what the owner hit.
  //
  // The extension is derived from what the recording actually IS, in this order:
  // the content-type we are about to serve (authoritative — the body has already
  // been proven to be audio by fetchAllowedRecording, which rejects TeleCMI's
  // 200-with-JSON errors), then the extension on the vendor's own filename, and
  // only then mp3, which is what TeleCMI serves. Naming an unknown body .mp3 is
  // a guess, so it is the last resort rather than the first.
  h.set('Content-Disposition', `inline; filename="${recordingFilename(row, upstream.contentType)}"`);

  // Stream the body through (200 for full, 206 for range responses).
  return new Response(upstream.body, { status: upstream.status, headers: h });
}
