/* eslint-disable @typescript-eslint/no-explicit-any */
import type Database from 'better-sqlite3';
import { getDb, generateId } from '@/lib/db';
import { webhookToken } from '@/lib/ct/settings';
import { normalizePhone } from '@/lib/ct/phone';
import { ingestLive } from '@/lib/ct/ingest';

export const dynamic = 'force-dynamic';

/**
 * POST — TeleCMI LIVE call-event webhook (ring / answer / hangup).
 * NO session auth: TeleCMI ships NO signature, NO shared-secret header and NO
 * source-IP guarantee — their dashboard simply POSTs to whatever URL you put
 * under SETTINGS → WEBHOOKS (type "notify"). The long random [token] path
 * segment validated against webhookToken(db) is therefore the ONLY protection
 * this endpoint has; never weaken it.
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

  for (const event of liveEvents(payload)) {
    ingestOne(db, event);
  }

  return Response.json({ ok: true });
}

/**
 * TeleCMI documents its call-event payload as a WRAPPER — { count, cdr: [ … ],
 * code } — while a pushed "notify" webhook normally delivers one bare event
 * object. Handle both. Without the unwrap a batch is a total loss: the wrapper
 * carries no cmiuid and no phone of its own, so the mapper rejects it and every
 * event inside lands in ct_webhook_log as a single 'unrecognized' row.
 *
 * A bare array body is deliberately NOT unwrapped — that shape is undocumented,
 * and passing it through keeps its existing "unrecognized live payload" record.
 */
function liveEvents(payload: any): any[] {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const batch = payload.cdr;
    if (Array.isArray(batch) && batch.length > 0) return batch;
  }
  return [payload];
}

/** Ingest one live event. NEVER throws — the route must still ack 200. */
function ingestOne(db: Database.Database, payload: any): void {
  try {
    ingestLive(payload); // logs to ct_webhook_log(kind='live') + emits bus events
  } catch (err: any) {
    // ct_webhook_log has no agent/event-time columns, so the two facts that
    // identify a live call — WHICH agent it belongs to and WHEN it happened —
    // ride in the diagnostic line. (Attribution itself is the mapper/ingest
    // path's job; this is what an operator reads when that path fell over.)
    console.error('[ct] live webhook: ingest failed', {
      cmiuid: bestEffortCallId(payload),
      agent: bestEffortAgent(payload),
      at: bestEffortEventAt(payload),
    }, err);
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
        // received_at is OUR receipt clock, not the call clock — TeleCMI can
        // redeliver an hours-old event and the log must stay ordered by when we
        // saw it. The event's own `time` is read by the mapper onto ct_calls.
        new Date().toISOString(),
        safeStringify(payload),
        String(err?.message || err || 'ingest failed').slice(0, 500),
      );
    } catch (logErr) {
      console.error('[ct] live webhook: error-log write failed', logErr);
    }
  }
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

// ─── Best-effort field picks (error-log row + diagnostics only) ─────────────
// The real tolerant mapping lives in src/lib/ct/telecmi-mapper.ts (used by
// ingest). These exist only so the never-lose-data row stays searchable when
// ingest blew up before writing its own.
//
// Precedence rule everywhere below: the REAL TeleCMI field name first, then the
// older alias guesses. The aliases stay because other deployments and the
// fixtures in scripts/ct-tests.ts still send those spellings.

/**
 * Stringify an untrusted payload value without ever throwing. TeleCMI sends
 * from/to/time as JSON NUMBERS, not strings, and String() throws outright on a
 * Symbol — a throw in here would abort the error-log write and lose the only
 * copy of the payload. Objects/arrays/booleans are junk for these fields, so
 * they collapse to '' rather than "[object Object]" / "true".
 */
function asScalar(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  // NaN/Infinity would stringify to "NaN"/"Infinity" and pollute the row.
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'bigint') return v.toString();
  return '';
}

/**
 * cmiuid IS TeleCMI's unique call id ("0a562832-ac7c-…"). It must come first:
 * a real live event carries no `id`/`callid`/`uuid` at all, so without cmiuid
 * the row logs with an EMPTY call id and screen-pop correlation — matching the
 * event to its ct_calls row and to the wallboard card — becomes impossible.
 */
function bestEffortCallId(p: any): string {
  if (!p || typeof p !== 'object') return '';
  for (const k of ['cmiuid', 'id', 'callid', 'call_id', 'callId', 'uuid']) {
    const s = asScalar(p[k]);
    if (s) return s.slice(0, 100);
  }
  return '';
}

/**
 * TeleCMI's `agent` ("201_1111112" — the same id shape as click2call's
 * user_id) is how a live call is attributed to a staff member. ct_webhook_log
 * has no agent column, so this feeds the diagnostic line above; ingest reads
 * the same field through the mapper for the wallboard and screen-pop.
 */
function bestEffortAgent(p: any): string {
  if (!p || typeof p !== 'object') return '';
  for (const k of ['agent', 'agent_id', 'agentId', 'user_id', 'userId', 'user', 'extension']) {
    const v = p[k];
    const s = asScalar(v);
    if (s) return s.slice(0, 100);
    // Some flows send agent/user as an object ({ id, name, … }).
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const f of ['id', 'name', 'username', 'email']) {
        const nested = asScalar((v as Record<string, unknown>)[f]);
        if (nested) return nested.slice(0, 100);
      }
    }
  }
  return '';
}

/**
 * TeleCMI sends from/to as NUMBERS (919000000001 — country code, no plus), so
 * every candidate goes through asScalar before normalizePhone; a raw non-string
 * reaching String() unguarded is how this helper would throw and take the
 * error-log write down with it.
 *
 * We take the first candidate that actually normalizes to a dialable E.164
 * instead of the first key that merely EXISTS — TeleCMI sends from:"" / to:0 on
 * partial events, and stopping there would log the call with no phone at all.
 */
function bestEffortPhone(p: any): string {
  if (!p || typeof p !== 'object') return '';
  for (const k of ['from', 'caller', 'customer_number', 'customerNumber', 'phone', 'to']) {
    let e164 = '';
    try {
      e164 = normalizePhone(asScalar(p[k]));
    } catch {
      /* unusable value → try the next candidate */
    }
    if (e164) return e164;
  }
  return '';
}

/**
 * Live ("notify") events use a looser vocabulary than CDRs and can carry the
 * state in `event`, `type` or `status`. src/lib/ct/telecmi-mapper.ts is the
 * authority for the full list; this is the short canonical set needed to stamp
 * the log row with the SAME three words ingestLive writes, so an operator can
 * filter ct_webhook_log by 'ring'/'answer'/'hangup' regardless of which path
 * produced the row.
 */
const LIVE_EVENT_WORDS: Record<string, 'ring' | 'answer' | 'hangup'> = {
  ring: 'ring', ringing: 'ring', incoming: 'ring', incomingcall: 'ring',
  newcall: 'ring', start: 'ring', started: 'ring', initiated: 'ring',
  calling: 'ring', dialing: 'ring', trying: 'ring',
  answer: 'answer', answered: 'answer', connect: 'answer', connected: 'answer',
  bridged: 'answer', inprogress: 'answer', ongoing: 'answer', live: 'answer',
  pickup: 'answer', pickedup: 'answer',
  hangup: 'hangup', hungup: 'hangup', end: 'hangup', ended: 'hangup',
  complete: 'hangup', completed: 'hangup', disconnect: 'hangup',
  disconnected: 'hangup', missed: 'hangup', noanswer: 'hangup', busy: 'hangup',
  cancel: 'hangup', cancelled: 'hangup', canceled: 'hangup', failed: 'hangup',
  rejected: 'hangup', abandoned: 'hangup', voicemail: 'hangup', timeout: 'hangup',
};

/**
 * An unrecognised value is IGNORED (empty event) and logged, never echoed into
 * the column: a raw "notify" / "call report" / "[object Object]" sitting in
 * ct_webhook_log.event reads as a call state that never happened and would send
 * anyone triaging the live feed down the wrong path. Nothing is lost — the full
 * body is in the payload column right next to it.
 */
function bestEffortEvent(p: any): string {
  if (!p || typeof p !== 'object') return '';
  const unknown: string[] = [];
  for (const k of ['event', 'type', 'call_status', 'status', 'state', 'action']) {
    const s = asScalar(p[k]);
    if (!s) continue;
    const canon = LIVE_EVENT_WORDS[s.toLowerCase().replace(/[^a-z]/g, '')];
    if (canon) return canon;
    unknown.push(s.slice(0, 40));
  }
  if (unknown.length > 0) {
    console.warn(
      `[ct] live webhook: unrecognised live event ${JSON.stringify(unknown)} — logging with an empty event`,
    );
  }
  return '';
}

/**
 * TeleCMI's `time` is epoch MILLISECONDS (1652105272029), not seconds and not
 * ISO. Convert to the UTC ISO string every other ct_ surface stores, tolerating
 * seconds/microseconds/ISO too. Anything outside ≈1973–2096 is rejected rather
 * than converted — a 1970 or year-50000 timestamp on the live feed is worse
 * than no timestamp, because it silently reorders the call timeline.
 */
function bestEffortEventAt(p: any): string {
  if (!p || typeof p !== 'object') return '';
  for (const k of ['time', 'timestamp', 'event_time', 'eventTime', 'at']) {
    const s = asScalar(p[k]);
    if (!s) continue;
    let ms: number;
    if (/^\d{9,17}(\.\d+)?$/.test(s)) {
      ms = Math.trunc(Number(s));
      if (ms < 1e11) ms *= 1000; // epoch seconds
      else if (ms >= 1e14) ms /= 1000; // epoch microseconds
    } else if (/^[\d.]+$/.test(s)) {
      // Digits-only but outside the epoch window (a truncated/garbage value).
      // Must NOT reach Date.parse: Date.parse('5') is a VALID date (year 2005)
      // and would stamp a live call with a timestamp two decades off.
      continue;
    } else {
      ms = Date.parse(s);
    }
    if (!Number.isFinite(ms) || ms < 1e11 || ms > 4e12) continue;
    return new Date(ms).toISOString();
  }
  return '';
}

function safeStringify(p: any): string {
  try {
    return JSON.stringify(p) ?? '{}';
  } catch {
    return '{}';
  }
}
