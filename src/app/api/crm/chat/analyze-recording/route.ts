import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { CrmRateLimitError } from '@/lib/crm-llm';
import { analyzeCallRecording } from '@/lib/crm-audio';

/**
 * POST /api/crm/chat/analyze-recording  (multipart/form-data)
 *   audio: File, language?: string →
 *   { session_id, content, score, language_detected, response_time_ms }
 *
 * Port of the Flask /api/chat/analyze_recording endpoint: validates the
 * upload, runs the AI call analysis (Gemini audio; Claude coaches on a Gemini
 * transcript when provider=claude), then stores the result as a fresh
 * assistant chat session with a single assistant message.
 */

const MAX_AUDIO_BYTES = 14 * 1024 * 1024; // Gemini inline_data request limit

const EXT_TO_MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
  '.mp4': 'audio/mp4',
  '.aiff': 'audio/aiff',
};

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  // Pre-check via Content-Length: bodies past the proxy cap (10MB default,
  // next.config experimental.proxyClientMaxBodySize) arrive truncated, so
  // formData() below would throw a generic parse error instead.
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_AUDIO_BYTES) {
    return Response.json({
      error: 'Recording too large (max 14MB) — trim or compress it',
    }, { status: 400 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    if (contentLength > 10 * 1024 * 1024) {
      return Response.json({
        error: 'Recording too large for this server (uploads over 10MB are cut off) — trim or compress it',
      }, { status: 400 });
    }
    return Response.json({ error: 'Expected multipart/form-data with an audio file' }, { status: 400 });
  }

  const file = form.get('audio');
  if (!(file instanceof File) || !file.name) {
    return Response.json({ error: 'No audio file uploaded' }, { status: 400 });
  }

  const dot = file.name.lastIndexOf('.');
  const ext = dot === -1 ? '' : file.name.slice(dot).toLowerCase();
  const mimeType = EXT_TO_MIME[ext];
  if (!mimeType) {
    return Response.json({
      error: `Unsupported file format. Use: ${Object.keys(EXT_TO_MIME).join(', ')}`,
    }, { status: 400 });
  }

  if (file.size > MAX_AUDIO_BYTES) {
    return Response.json({
      error: 'Recording too large (max 14MB) — trim or compress it',
    }, { status: 400 });
  }

  const language = String(form.get('language') || 'english');

  try {
    const base64 = Buffer.from(await file.arrayBuffer()).toString('base64');

    const t0 = Date.now();
    const result = await analyzeCallRecording({ base64, mimeType, language });
    const responseTimeMs = Date.now() - t0;

    // Persist only after a successful analysis (no orphan sessions on failure).
    const db = getDb();
    const sessionId = generateId();
    db.prepare(`
      INSERT INTO crm_chat_sessions (id, user_id, title, mode)
      VALUES (?, ?, ?, 'assistant')
    `).run(sessionId, me.id, `Call Analysis — ${file.name}`.slice(0, 50));
    db.prepare(`
      INSERT INTO crm_messages (id, session_id, role, content, response_time_ms)
      VALUES (?, ?, 'assistant', ?, ?)
    `).run(generateId(), sessionId, result.content, responseTimeMs);

    return Response.json({
      session_id: sessionId,
      content: result.content,
      score: result.score,
      language_detected: result.language,
      response_time_ms: responseTimeMs,
    });
  } catch (e: any) {
    if (e instanceof CrmRateLimitError) {
      return Response.json({
        error: 'AI is busy right now. Please wait a moment and try again.',
        wait_seconds: e.waitSeconds,
      }, { status: 429 });
    }
    console.error('POST /api/crm/chat/analyze-recording failed:', e);
    return Response.json({ error: e?.message || 'Failed to analyze recording' }, { status: 500 });
  }
}
