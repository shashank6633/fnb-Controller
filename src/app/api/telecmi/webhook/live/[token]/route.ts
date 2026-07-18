/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { webhookToken } from '@/lib/ct/settings';
import { normalizePhone } from '@/lib/ct/phone';
import { ingestLive } from '@/lib/ct/ingest';

export const dynamic = 'force-dynamic';

/**
 * POST — TeleCMI LIVE call-event webhook (ring / answer / hangup).
 * NO session auth: TeleCMI's CHUB dashboard POSTs here directly. Security is
 * the long random [token] path segment, validated against webhookToken(db).
 *
 * Contract: always ack `{ ok: true }` fast, even when ingest throws — TeleCMI
 * retries/blacklists slow or erroring endpoints and we never want to lose the
 * real-time feed. ingestLive() itself writes the ct_webhook_log(kind='live')
 * row; the catch block below is a belt-and-braces log so a payload that makes
 * ingest blow up is still captured (never lose data).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const db = getDb();
  if (!token || token !== webhookToken(db)) {
    return Response.json({ error: 'Invalid webhook token' }, { status: 403 });
  }

  const payload = await parseWebhookBody(request);

  try {
    ingestLive(payload); // logs to ct_webhook_log(kind='live') + emits bus events
  } catch (err: any) {
    console.error('[ct] live webhook: ingest failed', err);
    // Never lose the payload: record an error row (ingestLive normally logs
    // its own row before this point; a duplicate on the error path is fine).
    try {
      db.prepare(
        `INSERT INTO ct_webhook_log
           (id, kind, telecmi_call_id, phone_e164, event, received_at, payload, processed, error)
         VALUES (?, 'live', ?, ?, ?, ?, ?, 0, ?)`,
      ).run(
        generateId(),
        bestEffortCallId(payload),
        bestEffortPhone(payload),
        bestEffortEvent(payload),
        new Date().toISOString(),
        safeStringify(payload),
        String(err?.message || err || 'ingest failed').slice(0, 500),
      );
    } catch (logErr) {
      console.error('[ct] live webhook: error-log write failed', logErr);
    }
  }

  return Response.json({ ok: true });
}

// ─── Defensive body parsing ────────────────────────────────────────────────
// TeleCMI webhook nodes usually POST JSON, but some flows send
// application/x-www-form-urlencoded (sometimes with the JSON stuffed into a
// single field). The body can only be read ONCE, so read text() once and
// parse from there. Never throw — a bad body becomes {} and gets ack'd.
async function parseWebhookBody(request: Request): Promise<any> {
  let text = '';
  try {
    text = await request.text();
  } catch {
    return {};
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    /* not plain JSON — try form-encoded below */
  }
  try {
    const form = new URLSearchParams(text);
    const obj: Record<string, any> = {};
    for (const [k, v] of form.entries()) {
      const t = v.trim();
      if (t.startsWith('{') || t.startsWith('[')) {
        try {
          obj[k] = JSON.parse(t);
          continue;
        } catch {
          /* keep raw string */
        }
      }
      obj[k] = v;
    }
    // Whole payload stuffed into one JSON-valued field → unwrap it.
    const keys = Object.keys(obj);
    if (keys.length === 1 && obj[keys[0]] && typeof obj[keys[0]] === 'object') {
      return obj[keys[0]];
    }
    return obj;
  } catch {
    return {};
  }
}

// Best-effort field picks for the log row only — the real tolerant mapping
// lives in src/lib/ct/telecmi-mapper.ts (used by ingest).
function bestEffortCallId(p: any): string {
  if (!p || typeof p !== 'object') return '';
  const v = p.id ?? p.callid ?? p.call_id ?? p.callId ?? p.uuid ?? '';
  return v == null ? '' : String(v).slice(0, 100);
}

function bestEffortPhone(p: any): string {
  if (!p || typeof p !== 'object') return '';
  const v = p.from ?? p.caller ?? p.customer_number ?? p.customerNumber ?? p.phone ?? p.to ?? '';
  return normalizePhone(v);
}

function bestEffortEvent(p: any): string {
  if (!p || typeof p !== 'object') return '';
  const v = p.event ?? p.type ?? p.call_status ?? p.status ?? '';
  return v == null ? '' : String(v).slice(0, 50);
}

function safeStringify(p: any): string {
  try {
    return JSON.stringify(p) ?? '{}';
  } catch {
    return '{}';
  }
}
