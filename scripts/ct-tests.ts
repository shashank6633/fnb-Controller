/**
 * Call-to-Table CRM — self-contained integration/unit tests (npm run test:ct).
 *
 * Zero impact on the real app database: pure functions are imported directly
 * (phone, telecmi-mapper) and everything that needs a DB runs against a fresh
 * better-sqlite3 :memory: database created here with the same ct_ schema as
 * src/lib/db.ts (statements copied inline).
 *
 * HONEST COVERAGE NOTE — what this file does and does not cover:
 *   COVERED  : normalizePhone matrix, telecmi-mapper live/CDR variants and
 *              status families, slaDueAt/isBusinessHours business-hours math,
 *              and the exact SQL statements used by src/lib/ct/ingest.ts
 *              (idempotent CDR upsert, ringing-row finalization, recovery
 *              INSERT OR IGNORE dedupe, auto-resolve, callback-attempt match,
 *              booking attribution window, escalate/expire) — copied verbatim
 *              and executed against the in-memory schema.
 *   NOT HERE : the ingest functions themselves (ingestCdr/ingestLive/sweep/
 *              attributeBooking) bind to the app DB via getDb() and are NOT
 *              imported. Their end-to-end behaviour (webhook route → ingest →
 *              SSE → UI) is exercised with scripts/simulate-call.ts against a
 *              running dev server.
 *
 * Exit code: 1 when any test fails, 0 when all pass.
 */
import Database from 'better-sqlite3';
import { normalizePhone, formatPhone } from '../src/lib/ct/phone';
import { mapCdrPayload, mapLivePayload, statusFamily } from '../src/lib/ct/telecmi-mapper';
import { slaDueAt, isBusinessHours, setCtSetting, CT_SETTING_DEFAULTS } from '../src/lib/ct/settings';

// ─── tiny harness ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${(e as Error).message}`);
  }
}

function eq(actual: unknown, expected: unknown, label = ''): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label ? label + ': ' : ''}expected ${b}, got ${a}`);
}

function ok(cond: boolean, label: string): void {
  if (!cond) throw new Error(label);
}

/** Run fn with console.warn muted — for cases that INTENTIONALLY hit the
 *  mapper's unknown-shape warnings (the warning itself is the tested path). */
function quiet<T>(fn: () => T): T {
  const orig = console.warn;
  console.warn = () => { /* muted */ };
  try {
    return fn();
  } finally {
    console.warn = orig;
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(1, 66 - title.length))}`);
}

const isoOf = (epochSec: number) => new Date(epochSec * 1000).toISOString();

// ─── A. normalizePhone / formatPhone ─────────────────────────────────────────

section('A. phone normalization (src/lib/ct/phone.ts)');

const PHONE_CASES: Array<[unknown, string, string]> = [
  ['9876543210', '+919876543210', 'bare 10-digit mobile'],
  ['09876543210', '+919876543210', 'trunk-0 prefix'],
  ['919876543210', '+919876543210', '91-prefixed without +'],
  ['+919876543210', '+919876543210', 'already E.164'],
  ['+91 98765 43210', '+919876543210', 'spaces stripped'],
  ['91-9876-543-210', '+919876543210', 'dashes stripped'],
  ['(0891) 234-5678', '+918912345678', 'STD landline with trunk 0'],
  ['+14155552671', '+14155552671', 'US number keeps country code'],
  ['4155552671', '+914155552671', '10 digits assumed Indian (documented best-effort)'],
  [9876543210, '+919876543210', 'numeric input'],
  ['', '', 'empty string'],
  [null, '', 'null'],
  [undefined, '', 'undefined'],
  ['12345', '', 'too short (<8 digits)'],
  ['+1234567', '', 'too short even with +'],
  ['abc', '', 'no digits at all'],
];
for (const [input, expected, label] of PHONE_CASES) {
  test(`normalizePhone ${label}`, () => eq(normalizePhone(input), expected));
}

test('formatPhone Indian grouping', () => eq(formatPhone('+919876543210'), '98765 43210'));
test('formatPhone non-Indian passthrough', () => eq(formatPhone('+14155552671'), '+14155552671'));
test('formatPhone empty', () => eq(formatPhone(''), ''));

// ─── B. statusFamily matrix ──────────────────────────────────────────────────

section('B. status families (src/lib/ct/telecmi-mapper.ts)');

const STATUS_CASES: Array<[string, string]> = [
  ['answered', 'answered'],
  ['ANSWERED', 'answered'],
  ['completed', 'answered'],
  ['connected', 'answered'],
  ['noanswer', 'missed'],
  ['no-answer', 'missed'],
  ['No Answer', 'missed'],
  ['missed', 'missed'],
  ['cancel', 'missed'],
  ['CANCELLED', 'missed'],
  ['busy', 'missed'],
  ['failed', 'missed'],
  ['timeout', 'missed'],
  ['rejected', 'missed'],
  ['unreachable', 'missed'],
  ['abandoned', 'abandoned'],
  ['abandon', 'abandoned'],
  ['voicemail', 'voicemail'],
  ['vm', 'voicemail'],
];
for (const [input, expected] of STATUS_CASES) {
  test(`statusFamily "${input}" → ${expected}`, () => eq(statusFamily(input), expected));
}
test('statusFamily unknown defaults to missed (spurious recovery beats lost call)', () =>
  eq(quiet(() => statusFamily('xyzzy')), 'missed'));

// ─── C. mapCdrPayload variants ───────────────────────────────────────────────

section('C. CDR mapping (src/lib/ct/telecmi-mapper.ts)');

const T0 = 1789000000; // epoch seconds inside the mapper's sanity window

test('CDR: realistic answered inbound (full field extraction)', () => {
  const m = mapCdrPayload({
    id: 'sim-1', from: '9876543210', to: '04066001234', direction: 'inbound',
    status: 'answered', time: T0, end_time: T0 + 53, answeredsec: 45,
    agent_name: 'gre.akan', group: 'reception', record_url: 'https://rest.telecmi.com/play/x.mp3',
  });
  ok(m !== null, 'mapped null');
  eq(m!.telecmiCallId, 'sim-1', 'id');
  eq(m!.phone, '9876543210', 'phone (raw, not yet normalized)');
  eq(m!.direction, 'inbound', 'direction');
  eq(m!.status, 'answered', 'status');
  eq(m!.durationSec, 45, 'duration from answeredsec');
  eq(m!.startedAt, isoOf(T0), 'startedAt from epoch-seconds "time"');
  eq(m!.endedAt, isoOf(T0 + 53), 'endedAt from end_time');
  eq(m!.agent, 'gre.akan', 'agent from agent_name');
  eq(m!.queue, 'reception', 'queue from group');
  eq(m!.recordingUrl, 'https://rest.telecmi.com/play/x.mp3', 'recording from record_url');
});

test('CDR: "noanswer" → missed family', () => {
  const m = mapCdrPayload({ id: 'sim-2', from: '9876543210', status: 'noanswer', time: T0, answeredsec: 0 });
  eq(m?.status, 'missed');
  eq(m?.answeredAt, null, 'answeredAt null on missed');
});

test('CDR: envelope-nested record ({event, data:{...}})', () => {
  const m = mapCdrPayload({
    event: 'cdr',
    data: { callid: 'x1', caller_id_number: '+919812345678', status: 'missed', time: T0 },
  });
  eq(m?.telecmiCallId, 'x1');
  eq(m?.phone, '+919812345678');
  eq(m?.status, 'missed');
});

test('CDR: outbound takes the TO side as the customer phone', () => {
  const m = mapCdrPayload({
    uuid: 'ob1', direction: 'outgoing', from: '04066001234', to: '9876501234',
    status: 'answered', duration: 30,
  });
  eq(m?.direction, 'outbound');
  eq(m?.phone, '9876501234', 'customer = TO side on outbound');
  eq(m?.durationSec, 30);
});

test('CDR: outbound without TO never falls back to FROM (would poison join key)', () => {
  const m = quiet(() => mapCdrPayload({
    id: 'ob2', direction: 'outbound', from: '04066001234', status: 'answered', answeredsec: 10,
  }));
  ok(m !== null, 'still mapped (call id present)');
  eq(m!.phone, '', 'phone stays empty, not the business DID');
});

test('CDR: epoch millis and epoch seconds map to the same instant', () => {
  const a = mapCdrPayload({ id: 'ms1', from: '9876543210', status: 'answered', time: T0, answeredsec: 5 });
  const b = mapCdrPayload({ id: 'ms2', from: '9876543210', status: 'answered', time: T0 * 1000, answeredsec: 5 });
  eq(a?.startedAt, b?.startedAt);
});

test('CDR: duration derived from answered/end times when absent', () => {
  const m = mapCdrPayload({
    id: 'd1', from: '9898989898', status: 'answered',
    answered_time: T0, end_time: T0 + 37,
  });
  eq(m?.durationSec, 37, 'endedAt - answeredAt');
  eq(m?.startedAt, isoOf(T0), 'startedAt reconstructed from answeredAt');
});

test('CDR: unknown status + talk time → inferred answered', () => {
  const m = quiet(() => mapCdrPayload({ id: 'i1', from: '9898989898', answeredsec: 20 }));
  eq(m?.status, 'answered');
});

test('CDR: unknown status + no talk evidence → inferred missed', () => {
  const m = quiet(() => mapCdrPayload({ id: 'i2', from: '9898989898' }));
  eq(m?.status, 'missed');
  ok(!!m?.startedAt && m.startedAt === m.endedAt, 'startedAt/endedAt reconstructed, non-null');
});

test('CDR: only end_time + zero duration → startedAt === endedAt (contract: non-null)', () => {
  const m = mapCdrPayload({ id: 'r1', from: '9898989898', status: 'noanswer', end_time: T0, duration: 0 });
  eq(m?.endedAt, isoOf(T0));
  eq(m?.startedAt, isoOf(T0));
});

test('CDR: punctuated/cased key variants (Call-ID / Caller_Id-Number / Status)', () => {
  const m = mapCdrPayload({ 'Call-ID': 'k1', 'Caller_Id-Number': '9876543210', 'Status': 'ANSWERED', 'time': T0 });
  eq(m?.telecmiCallId, 'k1');
  eq(m?.phone, '9876543210');
  eq(m?.status, 'answered');
});

test('CDR: no phone AND no call id → null', () => {
  eq(quiet(() => mapCdrPayload({ status: 'answered' })), null);
});

test('CDR: non-object payloads → null', () => {
  eq(quiet(() => mapCdrPayload('not-json')), null);
  eq(quiet(() => mapCdrPayload([1, 2, 3])), null);
  eq(quiet(() => mapCdrPayload(null)), null);
});

// ─── D. mapLivePayload variants ──────────────────────────────────────────────

section('D. live event mapping (src/lib/ct/telecmi-mapper.ts)');

test('live: TeleCMI-style ring (event carried in "status")', () => {
  const m = mapLivePayload({
    id: 'l1', from: '9876543210', to: '04066001234', direction: 'inbound',
    status: 'ring', time: T0,
  });
  eq(m?.event, 'ring');
  eq(m?.phone, '9876543210');
  eq(m?.direction, 'inbound');
  eq(m?.at, isoOf(T0), 'at from epoch time');
});

test('live: "incoming" → ring; missing direction defaults to inbound', () => {
  const m = mapLivePayload({ callid: 'l2', caller: '9876543210', event: 'incoming' });
  eq(m?.event, 'ring');
  eq(m?.direction, 'inbound');
});

test('live: "answered" → answer', () => {
  const m = mapLivePayload({ id: 'l3', from: '9876543210', event: 'answered' });
  eq(m?.event, 'answer');
});

test('live: "disconnected" → hangup', () => {
  const m = mapLivePayload({ id: 'l4', from: '9876543210', event: 'disconnected' });
  eq(m?.event, 'hangup');
});

test('live: unknown event name inferred from facts (end time present → hangup)', () => {
  const m = quiet(() => mapLivePayload({ id: 'l5', from: '9876543210', event: 'zzz', end_time: T0 }));
  eq(m?.event, 'hangup');
});

test('live: empty object → null (nothing to key on)', () => {
  eq(quiet(() => mapLivePayload({})), null);
});

// ─── E. slaDueAt business-hours math (fresh :memory: ct_settings) ────────────

section('E. SLA clock (src/lib/ct/settings.ts, in-memory ct_settings)');

const settingsDb = new Database(':memory:');
settingsDb.exec(`
  CREATE TABLE IF NOT EXISTS ct_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );
`);
for (const [k, v] of Object.entries(CT_SETTING_DEFAULTS)) setCtSetting(settingsDb, k, v);
// Defaults: sla 30 min, open 12:00 IST, close 23:30 IST (IST = UTC+5:30)

test('SLA: missed in business hours (14:00 IST) → +30 min', () =>
  eq(slaDueAt('2026-07-18T08:30:00.000Z', settingsDb), '2026-07-18T09:00:00.000Z'));

test('SLA: missed after close (23:45 IST) → next open 12:00 IST + 30 → 12:30 IST next day', () =>
  eq(slaDueAt('2026-07-18T18:15:00.000Z', settingsDb), '2026-07-19T07:00:00.000Z'));

test('SLA: missed before open (09:00 IST) → same-day 12:30 IST', () =>
  eq(slaDueAt('2026-07-18T03:30:00.000Z', settingsDb), '2026-07-18T07:00:00.000Z'));

test('SLA: exactly at open (12:00 IST) counts as in-hours', () =>
  eq(slaDueAt('2026-07-18T06:30:00.000Z', settingsDb), '2026-07-18T07:00:00.000Z'));

test('SLA: exactly at close (23:30 IST) counts as after-hours → next day 12:30 IST', () =>
  eq(slaDueAt('2026-07-18T18:00:00.000Z', settingsDb), '2026-07-19T07:00:00.000Z'));

test('SLA: custom sla_minutes honored', () => {
  setCtSetting(settingsDb, 'sla_minutes', '60');
  try {
    eq(slaDueAt('2026-07-18T08:30:00.000Z', settingsDb), '2026-07-18T09:30:00.000Z');
  } finally {
    setCtSetting(settingsDb, 'sla_minutes', '30');
  }
});

test('SLA: invalid timestamp falls back to now + SLA (±10s tolerance)', () => {
  const due = new Date(slaDueAt('not-a-date', settingsDb)).getTime();
  const expected = Date.now() + 30 * 60_000;
  ok(Math.abs(due - expected) < 10_000, `due ${due} not within 10s of ${expected}`);
});

test('isBusinessHours: 14:00 IST true / 09:00 IST false / 23:30 IST false', () => {
  eq(isBusinessHours('2026-07-18T08:30:00.000Z', settingsDb), true, '14:00 IST');
  eq(isBusinessHours('2026-07-18T03:30:00.000Z', settingsDb), false, '09:00 IST');
  eq(isBusinessHours('2026-07-18T18:00:00.000Z', settingsDb), false, '23:30 IST');
});

// ─── F. ingest SQL semantics against the real ct_ schema (:memory:) ─────────
// Schema below is copied from src/lib/db.ts; the INSERT/UPDATE/SELECT
// statements are copied VERBATIM from src/lib/ct/ingest.ts so what passes here
// is the exact SQL the app executes.

section('F. ingest SQL semantics (in-memory ct_ schema, statements from ingest.ts)');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE IF NOT EXISTS ct_guests (
    id          TEXT PRIMARY KEY,
    outlet_id   TEXT NOT NULL DEFAULT '',
    phone_e164  TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL DEFAULT '',
    alt_phone   TEXT NOT NULL DEFAULT '',
    email       TEXT NOT NULL DEFAULT '',
    tags        TEXT NOT NULL DEFAULT '[]',
    source      TEXT NOT NULL DEFAULT 'call',
    notes       TEXT NOT NULL DEFAULT '',
    dob         TEXT NOT NULL DEFAULT '',
    anniversary TEXT NOT NULL DEFAULT '',
    preferences TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS ct_calls (
    id               TEXT PRIMARY KEY,
    telecmi_call_id  TEXT UNIQUE,
    guest_id         TEXT,
    phone_e164       TEXT NOT NULL DEFAULT '',
    direction        TEXT NOT NULL DEFAULT 'inbound',
    status           TEXT NOT NULL DEFAULT 'ringing',
    agent_user       TEXT NOT NULL DEFAULT '',
    queue            TEXT NOT NULL DEFAULT '',
    started_at       TEXT,
    answered_at      TEXT,
    ended_at         TEXT,
    duration_sec     INTEGER NOT NULL DEFAULT 0,
    recording_url    TEXT NOT NULL DEFAULT '',
    raw_payload      TEXT NOT NULL DEFAULT '{}',
    disposition      TEXT NOT NULL DEFAULT '',
    disposition_note TEXT NOT NULL DEFAULT '',
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS ct_bookings (
    id             TEXT PRIMARY KEY,
    guest_id       TEXT NOT NULL,
    source_call_id TEXT,
    booking_date   TEXT NOT NULL DEFAULT '',
    slot_time      TEXT NOT NULL DEFAULT '',
    party_size     INTEGER NOT NULL DEFAULT 2,
    occasion       TEXT NOT NULL DEFAULT '',
    section_pref   TEXT NOT NULL DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'pending',
    created_by     TEXT NOT NULL DEFAULT '',
    channel        TEXT NOT NULL DEFAULT 'call',
    advance_amount REAL NOT NULL DEFAULT 0,
    notes          TEXT NOT NULL DEFAULT '',
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS ct_recoveries (
    id                  TEXT PRIMARY KEY,
    call_id             TEXT NOT NULL UNIQUE,
    guest_id            TEXT,
    phone_e164          TEXT NOT NULL DEFAULT '',
    missed_at           TEXT NOT NULL,
    detected_via        TEXT NOT NULL DEFAULT 'cdr',
    sla_due_at          TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'pending',
    assigned_to         TEXT NOT NULL DEFAULT '',
    attempts            TEXT NOT NULL DEFAULT '[]',
    first_attempt_at    TEXT,
    recovered_at        TEXT,
    recovery_call_id    TEXT,
    recovery_booking_id TEXT,
    escalated           INTEGER NOT NULL DEFAULT 0,
    escalated_at        TEXT,
    resolution_note     TEXT NOT NULL DEFAULT '',
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

let idSeq = 0;
const genId = () => `t-${++idSeq}`;
const nowIso = () => new Date().toISOString();
const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

// VERBATIM from ingest.ts ingestCdr()
const cdrUpsert = db.prepare(`
  INSERT INTO ct_calls
    (id, telecmi_call_id, guest_id, phone_e164, direction, status, agent_user, queue,
     started_at, answered_at, ended_at, duration_sec, recording_url, raw_payload, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(telecmi_call_id) DO UPDATE SET
    guest_id      = COALESCE(ct_calls.guest_id, excluded.guest_id),
    phone_e164    = CASE WHEN ct_calls.phone_e164 = '' THEN excluded.phone_e164 ELSE ct_calls.phone_e164 END,
    direction     = CASE WHEN IFNULL(ct_calls.ended_at, '') = '' THEN excluded.direction ELSE ct_calls.direction END,
    status        = CASE WHEN IFNULL(ct_calls.ended_at, '') = '' THEN excluded.status ELSE ct_calls.status END,
    agent_user    = CASE WHEN ct_calls.agent_user = '' THEN excluded.agent_user ELSE ct_calls.agent_user END,
    queue         = CASE WHEN ct_calls.queue = '' THEN excluded.queue ELSE ct_calls.queue END,
    started_at    = COALESCE(NULLIF(ct_calls.started_at, ''), excluded.started_at),
    answered_at   = COALESCE(NULLIF(ct_calls.answered_at, ''), excluded.answered_at),
    ended_at      = COALESCE(NULLIF(ct_calls.ended_at, ''), excluded.ended_at),
    duration_sec  = CASE WHEN IFNULL(ct_calls.duration_sec, 0) = 0 THEN excluded.duration_sec ELSE ct_calls.duration_sec END,
    recording_url = CASE WHEN ct_calls.recording_url = '' THEN excluded.recording_url ELSE ct_calls.recording_url END,
    raw_payload   = CASE WHEN ct_calls.raw_payload IN ('', '{}') THEN excluded.raw_payload ELSE ct_calls.raw_payload END
`);

// VERBATIM from ingest.ts ingestLive() ring branch
const liveRingUpsert = db.prepare(`
  INSERT INTO ct_calls
    (id, telecmi_call_id, guest_id, phone_e164, direction, status, agent_user, queue,
     started_at, raw_payload, created_at)
  VALUES (?, ?, ?, ?, 'inbound', 'ringing', ?, ?, ?, ?, ?)
  ON CONFLICT(telecmi_call_id) DO UPDATE SET
    guest_id   = COALESCE(ct_calls.guest_id, excluded.guest_id),
    phone_e164 = CASE WHEN ct_calls.phone_e164 = '' THEN excluded.phone_e164 ELSE ct_calls.phone_e164 END,
    started_at = COALESCE(NULLIF(ct_calls.started_at, ''), excluded.started_at)
`);

// VERBATIM from ingest.ts createRecovery()
const recoveryInsert = db.prepare(`
  INSERT OR IGNORE INTO ct_recoveries
    (id, call_id, guest_id, phone_e164, missed_at, detected_via, sla_due_at, status,
     assigned_to, attempts, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', '', '[]', ?, ?)
`);

// VERBATIM from ingest.ts (answered-inbound auto-resolve)
const autoResolve = db.prepare(`
  UPDATE ct_recoveries
  SET status = 'auto_resolved',
      resolution_note = 'Guest called back and was answered',
      updated_at = ?
  WHERE phone_e164 = ? AND status IN ('pending', 'attempting')
`);

// VERBATIM from ingest.ts (answered-outbound callback match)
const callbackMatch = db.prepare(`
  SELECT id, attempts, first_attempt_at FROM ct_recoveries
  WHERE phone_e164 = ? AND status IN ('pending', 'attempting') AND missed_at >= ?
  ORDER BY missed_at DESC LIMIT 1
`);
const callbackUpdate = db.prepare(`
  UPDATE ct_recoveries
  SET attempts = ?,
      first_attempt_at = COALESCE(first_attempt_at, ?),
      status = 'attempting',
      recovery_call_id = ?,
      updated_at = ?
  WHERE id = ?
`);

// VERBATIM from ingest.ts attributeBooking()
const attributionSelect = db.prepare(`
  SELECT id FROM ct_calls
  WHERE (guest_id = ? OR (phone_e164 != '' AND phone_e164 = ?))
    AND direction = 'inbound' AND status = 'answered'
    AND COALESCE(NULLIF(started_at, ''), created_at) >= ?
  ORDER BY COALESCE(NULLIF(started_at, ''), created_at) DESC
  LIMIT 1
`);
const recoveryCloseSelect = db.prepare(`
  SELECT id FROM ct_recoveries
  WHERE (recovery_call_id = ? OR call_id = ?)
    AND status IN ('pending', 'attempting')
    AND (phone_e164 = '' OR ? = '' OR phone_e164 = ?)
  LIMIT 1
`);
const recoveryCloseUpdate = db.prepare(`
  UPDATE ct_recoveries
  SET recovery_booking_id = ?,
      status = 'recovered',
      recovered_at = ?,
      recovery_call_id = COALESCE(recovery_call_id, ?),
      updated_at = ?
  WHERE id = ?
`);

// VERBATIM from ingest.ts expireOverdueRecoveries()
const expireUpdate = db.prepare(`
  UPDATE ct_recoveries
  SET status = 'expired', escalated = 1, escalated_at = COALESCE(escalated_at, ?), updated_at = ?
  WHERE id = ? AND status = 'pending'
`);
const escalateUpdate = db.prepare(`
  UPDATE ct_recoveries
  SET escalated = 1, escalated_at = ?, updated_at = ?
  WHERE id = ? AND escalated = 0
`);

// Replica of ingest.ts appendAttempt() (private helper, 8 lines)
function appendAttempt(attemptsJson: string, attempt: Record<string, unknown>): string {
  let arr: unknown[] = [];
  try {
    const parsed = JSON.parse(attemptsJson || '[]');
    if (Array.isArray(parsed)) arr = parsed;
  } catch { /* corrupt attempts JSON → start fresh */ }
  arr.push(attempt);
  return JSON.stringify(arr);
}

interface CallRow {
  id: string; telecmi_call_id: string | null; guest_id: string | null; phone_e164: string;
  direction: string; status: string; agent_user: string; started_at: string | null;
  answered_at: string | null; ended_at: string | null; duration_sec: number; recording_url: string;
}
interface RecoveryRow {
  id: string; call_id: string; phone_e164: string; status: string; attempts: string;
  first_attempt_at: string | null; recovery_call_id: string | null;
  recovery_booking_id: string | null; escalated: number; escalated_at: string | null;
  resolution_note: string;
}
const getCall = (tid: string) =>
  db.prepare(`SELECT * FROM ct_calls WHERE telecmi_call_id = ?`).get(tid) as CallRow | undefined;
const callCount = (tid: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ct_calls WHERE telecmi_call_id = ?`).get(tid) as { n: number }).n;
const getRecovery = (id: string) =>
  db.prepare(`SELECT * FROM ct_recoveries WHERE id = ?`).get(id) as RecoveryRow | undefined;

test('F1: CDR upsert is idempotent — redelivery never duplicates or overwrites', () => {
  const t0 = hoursAgo(1);
  const t1 = minsAgo(59);
  cdrUpsert.run(genId(), 'tc-1', null, '+919876543210', 'inbound', 'answered',
    'gre.akan', 'reception', t0, t0, t1, 45, 'rec-a.mp3', '{"n":1}', nowIso());
  const firstId = getCall('tc-1')!.id;
  // Redelivery: different generated id, different agent/duration — must be a no-op
  cdrUpsert.run(genId(), 'tc-1', null, '+919876543210', 'inbound', 'missed',
    'someone.else', 'other', t0, null, t1, 999, 'rec-b.mp3', '{"n":2}', nowIso());
  eq(callCount('tc-1'), 1, 'row count');
  const row = getCall('tc-1')!;
  eq(row.id, firstId, 'primary key stable');
  eq(row.status, 'answered', 'status not clobbered once ended_at set');
  eq(row.agent_user, 'gre.akan', 'agent kept');
  eq(row.duration_sec, 45, 'duration kept');
  eq(row.recording_url, 'rec-a.mp3', 'recording kept');
});

test('F2: live ringing row is finalized (not duplicated) by the CDR', () => {
  const ringAt = minsAgo(3);
  liveRingUpsert.run(genId(), 'tc-2', null, '+919812340000', '', 'reception', ringAt, '{}', nowIso());
  const ringing = getCall('tc-2')!;
  eq(ringing.status, 'ringing', 'precondition: live row is ringing');
  eq(ringing.ended_at, null, 'precondition: no ended_at');
  // CDR arrives (guest has been created meanwhile → guest_id fills the NULL)
  const endAt = minsAgo(1);
  cdrUpsert.run(genId(), 'tc-2', 'g-known', '+919812340000', 'inbound', 'answered',
    'gre.akan', 'reception', minsAgo(2), minsAgo(2), endAt, 60, '', '{"cdr":1}', nowIso());
  eq(callCount('tc-2'), 1, 'still one row');
  const done = getCall('tc-2')!;
  eq(done.id, ringing.id, 'same row updated');
  eq(done.status, 'answered', 'finalized status');
  eq(done.ended_at, endAt, 'ended_at set');
  eq(done.started_at, ringAt, 'earlier ring started_at preserved (COALESCE)');
  eq(done.guest_id, 'g-known', 'null guest_id filled by CDR');
});

test('F3: recovery INSERT OR IGNORE dedupes on call_id', () => {
  const r1 = recoveryInsert.run('rec-1', 'call-3', null, '+919800000001', minsAgo(10), 'cdr',
    minsAgo(-20), nowIso(), nowIso());
  eq(r1.changes, 1, 'first insert lands');
  const r2 = recoveryInsert.run('rec-1b', 'call-3', null, '+919800000001', minsAgo(9), 'cdr',
    minsAgo(-21), nowIso(), nowIso());
  eq(r2.changes, 0, 'duplicate call_id ignored');
  eq((db.prepare(`SELECT COUNT(*) AS n FROM ct_recoveries WHERE call_id = 'call-3'`).get() as { n: number }).n, 1);
});

test('F4: answered inbound auto-resolves OPEN recoveries only', () => {
  const phone = '+919800000002';
  recoveryInsert.run('rec-2', 'call-4', null, phone, minsAgo(20), 'cdr', minsAgo(-10), nowIso(), nowIso());
  recoveryInsert.run('rec-3', 'call-5', null, phone, minsAgo(200), 'cdr', minsAgo(170), nowIso(), nowIso());
  db.prepare(`UPDATE ct_recoveries SET status = 'recovered' WHERE id = 'rec-3'`).run();
  const res = autoResolve.run(nowIso(), phone);
  eq(res.changes, 1, 'only the open one changed');
  eq(getRecovery('rec-2')!.status, 'auto_resolved');
  eq(getRecovery('rec-2')!.resolution_note, 'Guest called back and was answered');
  eq(getRecovery('rec-3')!.status, 'recovered', 'terminal recovery untouched');
});

test('F5: outbound callback matches the LATEST open recovery; attempts append', () => {
  const phone = '+919800000003';
  recoveryInsert.run('rec-4', 'call-6', null, phone, hoursAgo(30), 'cdr', hoursAgo(29), nowIso(), nowIso());
  recoveryInsert.run('rec-5', 'call-7', null, phone, hoursAgo(2), 'cdr', hoursAgo(1), nowIso(), nowIso());
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const match = callbackMatch.get(phone, sevenDaysAgo) as
    { id: string; attempts: string; first_attempt_at: string | null } | undefined;
  eq(match?.id, 'rec-5', 'latest missed_at wins');
  const at1 = nowIso();
  callbackUpdate.run(
    appendAttempt(match!.attempts, { at: at1, by: 'gre.akan', method: 'callback', outcome: 'answered' }),
    at1, 'cb-call-1', nowIso(), match!.id,
  );
  let rec = getRecovery('rec-5')!;
  eq(rec.status, 'attempting');
  eq(rec.first_attempt_at, at1);
  eq(rec.recovery_call_id, 'cb-call-1');
  const attempts1 = JSON.parse(rec.attempts) as unknown[];
  eq(attempts1.length, 1, 'one attempt recorded');
  // Second callback: attempts grow, first_attempt_at stays (COALESCE)
  const at2 = nowIso();
  callbackUpdate.run(
    appendAttempt(rec.attempts, { at: at2, by: 'gre.akan', method: 'callback', outcome: 'answered' }),
    at2, 'cb-call-2', nowIso(), rec.id,
  );
  rec = getRecovery('rec-5')!;
  eq((JSON.parse(rec.attempts) as unknown[]).length, 2, 'attempts appended');
  eq(rec.first_attempt_at, at1, 'first_attempt_at preserved');
});

test('F6a: attribution picks latest ANSWERED INBOUND call inside the window', () => {
  const guestId = 'g-attr';
  const phone = '+919800000004';
  db.prepare(`INSERT INTO ct_guests (id, phone_e164, name) VALUES (?, ?, 'Attr Guest')`).run(guestId, phone);
  const mkCall = (tid: string, dir: string, status: string, startedAt: string) =>
    db.prepare(`
      INSERT INTO ct_calls (id, telecmi_call_id, guest_id, phone_e164, direction, status, started_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(genId(), tid, guestId, phone, dir, status, startedAt, startedAt);
  mkCall('at-old', 'inbound', 'answered', hoursAgo(72));   // outside 48h window
  mkCall('at-win', 'inbound', 'answered', hoursAgo(1));    // ← the expected pick
  mkCall('at-missed', 'inbound', 'missed', minsAgo(30));   // missed → excluded
  mkCall('at-out', 'outbound', 'answered', minsAgo(10));   // outbound → excluded
  const windowStart = hoursAgo(48);
  const picked = attributionSelect.get(guestId, phone, windowStart) as { id: string } | undefined;
  eq(picked?.id, getCall('at-win')!.id, 'latest answered inbound within window');
});

test('F6b: booking closes the loop — open recovery → recovered with booking id', () => {
  const phone = '+919800000004';
  recoveryInsert.run('rec-6', 'call-missed-x', 'g-attr', phone, hoursAgo(3), 'cdr', hoursAgo(2), nowIso(), nowIso());
  db.prepare(`UPDATE ct_recoveries SET status = 'attempting', recovery_call_id = 'cb-x' WHERE id = 'rec-6'`).run();
  db.prepare(`
    INSERT INTO ct_bookings (id, guest_id, source_call_id, booking_date, created_at, updated_at)
    VALUES ('bk-1', 'g-attr', 'cb-x', '2026-07-19', ?, ?)
  `).run(nowIso(), nowIso());
  const rec = recoveryCloseSelect.get('cb-x', 'cb-x', phone, phone) as { id: string } | undefined;
  eq(rec?.id, 'rec-6', 'recovery found via recovery_call_id');
  recoveryCloseUpdate.run('bk-1', nowIso(), 'cb-x', nowIso(), rec!.id);
  const closed = getRecovery('rec-6')!;
  eq(closed.status, 'recovered');
  eq(closed.recovery_booking_id, 'bk-1');
  // A closed recovery is never matched again
  eq(recoveryCloseSelect.get('cb-x', 'cb-x', phone, phone), undefined, 'no re-match once recovered');
});

test('F7: SLA breach escalates at 1× and expires at 2× SLA (30 min default)', () => {
  // 10 min past due → escalate only (within the 2×-SLA grace window)
  recoveryInsert.run('rec-7', 'call-8', null, '+919800000005', minsAgo(60), 'cdr', minsAgo(10), nowIso(), nowIso());
  // 45 min past due → past due + 30 min → expire
  recoveryInsert.run('rec-8', 'call-9', null, '+919800000006', minsAgo(90), 'cdr', minsAgo(45), nowIso(), nowIso());
  const slaMin = 30;
  const nowMs = Date.now();
  const overdue = db.prepare(`
    SELECT id, sla_due_at, escalated FROM ct_recoveries
    WHERE status = 'pending' AND sla_due_at < ?
  `).all(new Date(nowMs).toISOString()) as Array<{ id: string; sla_due_at: string; escalated: number }>;
  ok(overdue.some(r => r.id === 'rec-7') && overdue.some(r => r.id === 'rec-8'), 'both are overdue');
  for (const rec of overdue) {
    const dueMs = new Date(rec.sla_due_at).getTime();
    const expireMs = isNaN(dueMs) ? nowMs : dueMs + slaMin * 60_000;
    if (nowMs >= expireMs) expireUpdate.run(nowIso(), nowIso(), rec.id);
    else if (!rec.escalated) escalateUpdate.run(nowIso(), nowIso(), rec.id);
  }
  const r7 = getRecovery('rec-7')!;
  eq(r7.status, 'pending', 'still pending inside grace window');
  eq(r7.escalated, 1, 'escalated flag set');
  ok(!!r7.escalated_at, 'escalated_at stamped');
  const r8 = getRecovery('rec-8')!;
  eq(r8.status, 'expired', 'expired past 2× SLA');
  eq(r8.escalated, 1, 'expire also sets escalated');
});

// ─── summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(70)}`);
console.log(`${passed + failed} tests · ${passed} passed · ${failed} failed`);
console.log(
  'Coverage note: sections A–E test the pure ct libs directly; section F runs\n' +
  "ingest.ts's exact SQL against an in-memory copy of the ct_ schema. The\n" +
  'ingest/route layer itself (webhook → ingestCdr/ingestLive → SSE) is NOT\n' +
  'exercised here — use scripts/simulate-call.ts against a running dev server\n' +
  'for that end-to-end path.'
);

settingsDb.close();
db.close();
process.exit(failed > 0 ? 1 : 0);
