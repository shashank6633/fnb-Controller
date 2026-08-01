/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { webhookToken } from '@/lib/ct/settings';
import { normalizePhone } from '@/lib/ct/phone';
import { ingestCdr } from '@/lib/ct/ingest';

export const dynamic = 'force-dynamic';

/**
 * POST — TeleCMI CDR (Call Detail Record) webhook, fired when a call ends.
 * NO session auth: TeleCMI's CHUB dashboard POSTs here directly. TeleCMI
 * signs nothing — no signature header, no shared secret — so the long random
 * [token] path segment is the ONLY protection and must never be weakened.
 *
 * Order of operations (never lose data):
 *   1. Write the RAW payload to ct_webhook_log(kind='cdr') BEFORE ingest —
 *      the schema will evolve and ingest can fail; the log row survives.
 *   2. ingestCdr(row) — upsert ct_calls, recoveries, auto-resolve, bus.
 *   3. Mark the log row processed=1 (or record the error on it).
 * Always ack `{ ok: true }`, even when ingest throws — TeleCMI does NOT retry
 * and drops slow/erroring endpoints, so a 500 here loses the call forever;
 * the log row means nothing is lost.
 *
 * TeleCMI can deliver EITHER a bare event object OR the documented report
 * envelope `{ count, cdr: [ …rows… ], code }`. Each row is logged and ingested
 * independently: one poisoned row must not take the rest of the batch down.
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

  // Unwrap the { count, cdr: [...] } envelope. An envelope that carries no
  // rows still gets logged (unprocessable, but visible) — a silent 200 on an
  // unrecognized shape is how integrations rot unnoticed.
  const rows = extractCdrRows(payload);
  if (rows.length === 0) {
    logCdrRow(db, payload, /* processed */ true);
    return Response.json({ ok: true });
  }

  for (const row of rows) {
    // 1) Never-lose-data layer: raw CDR into ct_webhook_log BEFORE ingest.
    const logId = logCdrRow(db, row, /* processed */ false);

    // 2) Ingest — wrapped so the webhook ALWAYS acks 200.
    try {
      ingestCdr(row);
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
  }

  return Response.json({ ok: true });
}

/**
 * Insert one ct_webhook_log(kind='cdr') row. Returns the row id, or null when
 * the log write itself failed — ingest still runs in that case and ct_calls
 * keeps its own raw_payload copy.
 *
 * NOTE on the columns we DON'T have: a real CDR also carries duration,
 * billedsec, agent, filename (recording), time, record and name. ct_webhook_log
 * has no columns for those, so they are NOT split out here — they survive
 * verbatim in `payload`, and src/lib/ct/telecmi-mapper.ts + ingest.ts are what
 * land them on ct_calls (duration_sec / agent_user / recording_url /
 * started_at). Adding columns here is out of scope and would fork the schema.
 */
function logCdrRow(db: ReturnType<typeof getDb>, row: any, processed: boolean): string | null {
  try {
    const id = generateId();
    db.prepare(
      `INSERT INTO ct_webhook_log
         (id, kind, telecmi_call_id, phone_e164, event, received_at, payload, processed, error)
       VALUES (?, 'cdr', ?, ?, ?, ?, ?, ?, '')`,
    ).run(
      id,
      bestEffortCallId(row),
      bestEffortPhone(row),
      bestEffortEvent(row),
      // Our receive time, deliberately NOT the CDR's `time` — a batched or
      // replayed report must still be greppable by when it actually landed.
      new Date().toISOString(),
      safeStringify(row),
      processed ? 1 : 0,
    );
    return id;
  } catch (err) {
    console.error('[ct] cdr webhook: ct_webhook_log write failed', err);
    return null;
  }
}

/**
 * Split a delivery into individual CDR records.
 *
 * TeleCMI's call-report shape is `{ count, cdr: [ {...}, {...} ], code }`, but
 * a pushed webhook often delivers a single bare record instead. The mapper's
 * envelope unwrapping only looks INSIDE nested objects, not arrays, so without
 * this an array delivery maps to nothing but `count`/`code` and every call in
 * the batch is silently dropped. Returns [] only when a recognized rows array
 * is present but empty.
 */
function extractCdrRows(payload: any): any[] {
  if (Array.isArray(payload)) return payload.filter(isPlainObject);
  if (!isPlainObject(payload)) return [];
  // 'cdr' is the documented key; the rest are tolerated spellings seen from
  // other TeleCMI flows / proxies. First array wins.
  for (const key of ['cdr', 'cdrs', 'records', 'calls', 'data', 'result', 'results']) {
    const v = payload[key];
    if (Array.isArray(v)) return v.filter(isPlainObject);
  }
  return [payload]; // bare event object — the shape that works today
}

function isPlainObject(v: any): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v);
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

// ─── Best-effort field picks for the log row ───────────────────────────────
// Log-row triage only — the real tolerant mapping lives in
// src/lib/ct/telecmi-mapper.ts (used by ingest).
//
// Every value here is picked through pickVal(), which is case/punctuation
// insensitive AND accepts NUMBERS. That second part is not cosmetic: TeleCMI
// sends `from`/`to` as JSON numbers (919000000001, no quotes, no plus), so any
// code path that assumes a string here throws, 500s the webhook, and loses the
// call permanently — TeleCMI never retries.

/** Case/punctuation-insensitive key: "Caller_Id-Number" → "calleridnumber". */
function normKey(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Flatten to normalized keys once, so lookups are spelling-insensitive. */
function flatten(p: any): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  if (!isPlainObject(p)) return flat;
  for (const [k, v] of Object.entries(p)) {
    const nk = normKey(k);
    if (nk && v != null && !(nk in flat)) flat[nk] = v;
  }
  return flat;
}

/** First usable scalar across candidate keys; skips objects, blanks and 0. */
function pickVal(p: any, keys: string[]): string {
  const flat = flatten(p);
  for (const key of keys) {
    const v = flat[normKey(key)];
    if (typeof v === 'string' && v.trim()) return v.trim();
    // Numeric ids/numbers arrive unquoted; 0 is never a real id or number.
    if (typeof v === 'number' && Number.isFinite(v) && v !== 0) return String(v);
    // BigInt(0) rather than a 0n literal: tsconfig targets below ES2020, where
    // the literal is a compile error. JSON.parse never yields a bigint anyway —
    // this arm only exists for a caller that pre-parsed with a bigint reviver.
    if (typeof v === 'bigint' && v !== BigInt(0)) return v.toString();
  }
  return '';
}

function bestEffortCallId(p: any): string {
  // cmiuid FIRST: it is TeleCMI's actual unique call id. Without it a real CDR
  // lands with no id at all, so nothing can correlate the live event, dedupe a
  // re-delivery, or attach the recording. The rest stay as fallbacks for other
  // deployments and the test fixtures.
  return pickVal(p, ['cmiuid', 'id', 'callid', 'call_id', 'callId', 'uuid']).slice(0, 100);
}

function bestEffortPhone(p: any): string {
  return normalizePhone(
    pickVal(p, ['from', 'caller', 'customer_number', 'customerNumber', 'phone', 'to']),
  );
}

function bestEffortEvent(p: any): string {
  const explicit = pickVal(p, ['event', 'type', 'call_status', 'status']);
  if (explicit) return explicit.slice(0, 50);
  // A real TeleCMI CDR has NO status field at all — talk time is the only
  // evidence of what happened. Derive the same answered/missed call the mapper
  // will make, so the log row is triageable instead of blank. Advisory label;
  // ct_calls.status from ingest stays authoritative. (0 is meaningful here —
  // billedsec: 0 IS the missed call — so this cannot go through pickVal.)
  const flat = flatten(p);
  let talked: number | null = null;
  for (const key of ['billedsec', 'duration']) {
    const v = flat[normKey(key)];
    if (typeof v === 'number' && Number.isFinite(v)) { talked = v; break; }
    if (typeof v === 'string' && v.trim() && !Number.isNaN(Number(v.trim()))) {
      talked = Number(v.trim());
      break;
    }
  }
  if (talked == null) return '';
  return talked > 0 ? 'answered' : 'missed';
}

function safeStringify(p: any): string {
  try {
    return JSON.stringify(p) ?? '{}';
  } catch {
    return '{}';
  }
}
