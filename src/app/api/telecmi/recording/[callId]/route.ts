import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { fetchAllowedRecording } from '@/lib/ct/recording-fetch';

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
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: Request, { params }: { params: Promise<{ callId: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  const { callId } = await params;
  const db = getDb();
  const row = db.prepare(
    `SELECT id, recording_url FROM ct_calls WHERE id = ? OR telecmi_call_id = ?`,
  ).get(callId, callId) as any;
  if (!row) return Response.json({ error: 'Call not found' }, { status: 404 });
  if (!row.recording_url) return Response.json({ error: 'No recording for this call' }, { status: 404 });

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
    const msg = e?.name === 'AbortError' ? 'Recording source timed out' : (e?.message || 'Failed to fetch recording');
    return Response.json({ error: msg }, { status: 502 });
  }
  clearTimeout(timer);

  if (upstream.status !== 200 && upstream.status !== 206) {
    return Response.json({ error: `Recording source responded ${upstream.status}` }, { status: 502 });
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
