/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { processWebhookEvent } from '@/lib/wa-inbox';

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
 *   POST — inbound event delivery. We ALWAYS 200 (Meta retries + eventually
 *          disables webhooks that error) and archive the raw payload into
 *          whatsapp_events_log for future processors (delivery receipts,
 *          inbound replies, automation triggers) to consume.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge') || '';

    const db = getDb();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'wa_webhook_verify_token'").get() as { value: string } | undefined;
    const expected = row?.value?.trim() || '';

    if (mode === 'subscribe' && expected && token === expected) {
      // Meta expects the raw challenge string back, not JSON.
      return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }
    return new Response('Forbidden', { status: 403, headers: { 'Content-Type': 'text/plain' } });
  } catch (e: any) {
    console.error('[/api/whatsapp/webhook GET]', e);
    return new Response('Forbidden', { status: 403, headers: { 'Content-Type': 'text/plain' } });
  }
}

export async function POST(request: Request) {
  let eventId = 0;
  let payload = '';
  try {
    const raw = await request.text().catch(() => '');
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
  return Response.json({ received: true });
}
