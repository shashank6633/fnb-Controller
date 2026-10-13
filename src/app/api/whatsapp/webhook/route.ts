/* eslint-disable @typescript-eslint/no-explicit-any */
import { timingSafeEqual } from 'node:crypto';
import { getDb } from '@/lib/db';
import { processWebhookEvent } from '@/lib/wa-inbox';
import {
  applyTemplateStatusWebhook,
  SIGNATURE_HEADER,
  verifyWebhookSignature,
  webhookAppSecretLookup,
  recordWebhookCheck,
} from '@/lib/wa-template-authoring';

/**
 * WhatsApp webhook endpoint — PUBLIC (whitelisted in proxy.ts isPublic).
 * This is the URL you paste into Meta's App Dashboard → WhatsApp → Configuration.
 *
 *   GET  — Meta's verification handshake:
 *          ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
 *          Echoes hub.challenge as plain text when the token matches the
 *          stored wa_webhook_verify_token setting; 403 otherwise (including
 *          when no verify token has been configured yet — never fail open).
 *
 *   POST — inbound event delivery. Meta signs every POST; the signature is
 *          checked FIRST, before anything is read or stored (see
 *          verifyWebhookSignature — raw bytes, constant-time compare). A
 *          request that fails the check is refused with 401 and nothing about
 *          it is recorded. A body larger than MAX_BODY_BYTES is refused with 413
 *          before it is read. When the app secret cannot be LOOKED UP the request
 *          is refused too (Meta retries), because "I cannot tell whether checking
 *          is on" must never resolve to "checking is off".
 *          When no app secret is configured there is nothing to
 *          check against, and the request is accepted exactly as before — see
 *          the note on verifyWebhookSignature for why that is the right default
 *          for a venue whose inbox is already live, and where the state is shown.
 *          Otherwise we ALWAYS 200 (Meta retries + eventually disables webhooks
 *          that error) and archive the raw payload into whatsapp_events_log for
 *          the processors (delivery receipts, inbound replies, automation
 *          triggers) to consume.
 */
export const dynamic = 'force-dynamic';

/**
 * Constant-time string compare for a shared secret. Lengths are compared first
 * BECAUSE timingSafeEqual throws on a length mismatch, and a throw inside a
 * secret check lands in a catch that fails open. (The length itself leaks, which
 * is true of every constant-time comparison of variable-length strings.)
 */
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  if (x.length !== y.length || !x.length) return false;
  try { return timingSafeEqual(x, y); } catch { return false; }
}

/**
 * The biggest body this endpoint will read before it knows who sent it.
 *
 * The signature is over the whole body, so the bytes must be read before they can
 * be checked — which means an unauthenticated stranger decides how much memory
 * this route allocates. Meta's webhook payloads are a few KB; 1 MiB is generous
 * by three orders of magnitude and still bounded. Refused on Content-Length, i.e.
 * before the read, and with 413 rather than 401 so the reason is not mistaken for
 * a signature problem.
 */
const MAX_BODY_BYTES = 1024 * 1024;

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge') || '';

    const db = getDb();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'wa_webhook_verify_token'").get() as { value: string } | undefined;
    const expected = row?.value?.trim() || '';

    // Constant-time, like the POST signature next door. Completing this handshake
    // grants nothing by itself, so the leak is small — but a token compared with
    // === gives up its length and its matching prefix, and there is no reason to
    // hand that over when the fix is one helper.
    if (mode === 'subscribe' && expected && sameSecret(String(token ?? ''), expected)) {
      // Meta expects the raw challenge string back, not JSON.
      return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }
    return new Response('Forbidden', { status: 403, headers: { 'Content-Type': 'text/plain' } });
  } catch (e: any) {
    console.error('[/api/whatsapp/webhook GET]', e);
    return new Response('Forbidden', { status: 403, headers: { 'Content-Type': 'text/plain' } });
  }
}

/** Warn once per process, not once per event — Meta sends a lot of them. */
let unsignedWarned = false;

export async function POST(request: Request) {
  let eventId = 0;
  let payload = '';

  /* ── 1. THE BYTES, EXACTLY AS THEY ARRIVED ──
   * Read as an ArrayBuffer, not as text, because the signature is over the raw
   * bytes: decoding to a string and re-encoding it would be a different digest
   * for any body that is not clean UTF-8, and a signature check that is right
   * "almost always" is not a signature check. */
  const declared = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    console.warn(`[/api/whatsapp/webhook POST] refused: body of ${declared} bytes exceeds ${MAX_BODY_BYTES}`);
    return new Response('Payload Too Large', { status: 413, headers: { 'Content-Type': 'text/plain' } });
  }

  let bytes: Buffer = Buffer.alloc(0);
  try {
    const ab = await request.arrayBuffer();
    bytes = Buffer.from(ab);
  } catch { /* unreadable body — bytes stays empty and fails the check below */ }
  if (bytes.length > MAX_BODY_BYTES) {
    // No Content-Length (chunked): the cap still applies, just one read later.
    return new Response('Payload Too Large', { status: 413, headers: { 'Content-Type': 'text/plain' } });
  }

  /* ── 2. IS IT FROM META? ──
   * Asked BEFORE the archive write, so a forged post leaves no trace at all:
   * a row in whatsapp_events_log is replayable by the admin backlog button, so
   * storing a forgery is storing a forgery that can be applied later.
   *
   * THE LOOKUP IS TRI-STATE, and the reason is a measured hole: folding "the
   * settings read failed" into "no secret is configured" turned enforcement OFF
   * on one SQLITE_BUSY, and an unsigned forgery was then accepted, archived and
   * ingested. "Cannot tell" is refused, not believed. The environment is still
   * read first and does not need the database at all, so a database problem cannot
   * disarm a secret that lives in the environment. */
  let look: ReturnType<typeof webhookAppSecretLookup>;
  try { look = webhookAppSecretLookup(getDb()); }
  catch {
    // getDb() itself failed. Fall back to the environment, and if that has no
    // secret either, say we could not tell rather than "there is none".
    try {
      const env = webhookAppSecretLookup();
      look = env.secret ? env : { secret: '', source: 'none', unreadable: true };
    } catch { look = { secret: '', source: 'none', unreadable: true }; }
  }

  const auth = verifyWebhookSignature(
    bytes, request.headers.get(SIGNATURE_HEADER), look.secret, { unreadable: look.unreadable },
  );
  /* WHAT HAPPENED IS RECORDED (not the payload — just "a signature verified" or
   * "one was turned away, and which check it failed"), because a refusal writes
   * nothing by design and that makes a WRONG app secret invisible: every genuine
   * Meta event 401s while the settings screen still reads "checking is on".
   * Throttled inside recordWebhookCheck, and never able to throw. */
  try { recordWebhookCheck(getDb(), auth); } catch { /* telemetry is never load-bearing */ }

  if (!auth.ok) {
    console.warn(`[/api/whatsapp/webhook POST] refused: ${auth.state}`);
    return new Response('Unauthorized', { status: 401, headers: { 'Content-Type': 'text/plain' } });
  }
  if (!auth.enforced && !unsignedWarned) {
    unsignedWarned = true;
    console.warn('[/api/whatsapp/webhook POST] accepting UNVERIFIED webhooks — no WhatsApp app secret is configured. See Settings → Integrations → WhatsApp.');
  }

  try {
    const raw = bytes.toString('utf8');
    // Store whatever arrived (even non-JSON) — the raw archive is the FIRST,
    // never-fail step; everything downstream can be replayed from it.
    payload = raw;
    try { payload = JSON.stringify(JSON.parse(raw)); } catch { /* keep raw text */ }
    const db = getDb();
    const info = db.prepare('INSERT INTO whatsapp_events_log (kind, payload) VALUES (?, ?)')
      .run('webhook', payload || '{}');
    eventId = Number(info.lastInsertRowid);
  } catch (e: any) {
    // Never bubble an error to Meta — log locally, still 200.
    console.error('[/api/whatsapp/webhook POST]', e);
  }
  // Inbox ingest — its OWN try, so a parser bug can never lose the raw payload
  // archived above (the admin backlog replay re-processes from the log).
  // Idempotent (wamid dedupe), so Meta webhook retries change nothing.
  if (eventId) {
    try {
      await processWebhookEvent(getDb(), eventId, payload || '{}');
    } catch (e: any) {
      console.error('[/api/whatsapp/webhook POST] inbox ingest failed (raw payload archived):', e);
    }
  }

  // Template approval/rejection/pause updates — its OWN try, so it can never
  // affect the inbox ingest above or the archived payload.
  //
  // BONUS PATH, NOT THE CONTRACT. Nothing in this repo proves Meta's
  // `message_template_status_update` field name or value shape, and the field
  // must additionally be subscribed in Meta's App Dashboard. So this only ever
  // acts on an exactly-matching field naming a template already in the
  // lifecycle, and POLLING (POST /api/whatsapp/templates/sync) stays the
  // authoritative reconciliation — a venue that never receives this webhook
  // loses latency, not correctness.
  if (payload) {
    try {
      const r = applyTemplateStatusWebhook(getDb(), payload);
      if (r.changes.length) {
        console.log('[/api/whatsapp/webhook POST] template status changes:',
          r.changes.map(c => `${c.name}: ${c.from || '(none)'} → ${c.to}`).join(', '));
      }
      /* WHY A STATUS DID NOT MOVE, said out loud. A template write requires a
       * request this app could actually check (see applyTemplateStatusWebhook),
       * and with no app secret configured nothing here can be. Silence would
       * look like "Meta never sent it"; polling still reconciles either way. */
      if (r.untrusted) {
        console.warn(`[/api/whatsapp/webhook POST] ${r.untrusted} template status event(s) IGNORED — no WhatsApp app secret is configured, so this request cannot be proven to be Meta's. Press Refresh status on Settings → Integrations → WhatsApp → Templates, or add the app secret to trust these.`);
      }
      if (r.rejected.length) {
        console.warn('[/api/whatsapp/webhook POST] template status event(s) REFUSED — not a status WhatsApp reports:',
          r.rejected.map(x => `${x.name}: "${x.status}"`).join(', '));
      }
    } catch (e: any) {
      console.error('[/api/whatsapp/webhook POST] template status update failed (raw payload archived):', e);
    }
  }
  return Response.json({ received: true });
}
