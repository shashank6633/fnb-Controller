/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { webhookToken } from '@/lib/ct/settings';
import { normalizePhone } from '@/lib/ct/phone';
import { ingestCdr } from '@/lib/ct/ingest';

export const dynamic = 'force-dynamic';

/**
 * POST — TeleCMI CDR (Call Detail Record) webhook, fired when a call ends.
 * NO session auth: TeleCMI's CHUB dashboard POSTs here directly. Security is
 * the long random [token] path segment, validated against webhookToken(db).
 *
 * Order of operations (never lose data):
 *   1. Write the RAW payload to ct_webhook_log(kind='cdr') BEFORE ingest —
 *      the schema will evolve and ingest can fail; the log row survives.
 *   2. ingestCdr(payload) — upsert ct_calls, recoveries, auto-resolve, bus.
 *   3. Mark the log row processed=1 (or record the error on it).
 * Always ack `{ ok: true }`, even when ingest throws — TeleCMI retries or
 * drops slow/erroring endpoints and the log row means nothing is lost.
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

  // 1) Never-lose-data layer: raw CDR into ct_webhook_log BEFORE ingest.
  let logId: string | null = null;
  try {
    logId = generateId();
    db.prepare(
      `INSERT INTO ct_webhook_log
         (id, kind, telecmi_call_id, phone_e164, event, received_at, payload, processed, error)
       VALUES (?, 'cdr', ?, ?, ?, ?, ?, 0, '')`,
    ).run(
      logId,
      bestEffortCallId(payload),
      bestEffortPhone(payload),
      bestEffortEvent(payload),
      new Date().toISOString(),
      safeStringify(payload),
    );
  } catch (err) {
    logId = null; // ingest still runs; the call row will carry raw_payload
    console.error('[ct] cdr webhook: ct_webhook_log write failed', err);
  }

  // 2) Ingest — wrapped so the webhook ALWAYS acks 200.
  try {
    ingestCdr(payload);
    if (logId) {
      db.prepare(`UPDATE ct_webhook_log SET processed = 1 WHERE id = ?`).run(logId);
    }
  } catch (err: any) {
    console.error('[ct] cdr webhook: ingest failed', err);
    try {
      if (logId) {
        db.prepare(`UPDATE ct_webhook_log SET error = ? WHERE id = ?`).run(
          String(err?.message || err || 'ingest failed').slice(0, 500),
          logId,
        );
      }
    } catch (logErr) {
      console.error('[ct] cdr webhook: error-log update failed', logErr);
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
