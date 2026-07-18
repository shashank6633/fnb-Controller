/**
 * TeleCMI payload mapper for the Call-to-Table CRM.
 *
 * TeleCMI field names vary by account/region/product (CHUB "notify" live
 * events vs "call report" CDRs), so this is the ONE tolerant mapping layer
 * between raw webhook JSON and our normalized shapes — business logic
 * (src/lib/ct/ingest.ts) never touches raw payloads directly.
 *
 * Pure functions: no DB, no imports, no side effects beyond console.warn on
 * unknown shapes. Phone values are returned RAW — ingest normalizes them via
 * normalizePhone() (see src/lib/ct/phone.ts). Timestamps are normalized here
 * to UTC ISO-8601 (accepts epoch seconds, epoch millis, or ISO strings).
 */

/** Normalized live ("notify") webhook event. */
export interface MappedLiveEvent {
  telecmiCallId: string;
  /** Customer phone as sent by TeleCMI (NOT yet E.164-normalized). */
  phone: string;
  direction: 'inbound' | 'outbound';
  event: 'ring' | 'answer' | 'hangup';
  agent: string;
  queue: string;
  /** UTC ISO event time (falls back to now). */
  at: string;
}

/** Normalized CDR ("call report") webhook record. */
export interface MappedCdr {
  telecmiCallId: string;
  /** Customer phone as sent by TeleCMI (NOT yet E.164-normalized). */
  phone: string;
  direction: 'inbound' | 'outbound';
  status: 'answered' | 'missed' | 'abandoned' | 'voicemail';
  agent: string;
  queue: string;
  /** UTC ISO */
  startedAt: string;
  /** UTC ISO, null when the call was never answered */
  answeredAt: string | null;
  /** UTC ISO */
  endedAt: string;
  durationSec: number;
  recordingUrl: string;
}

const WARN = '[ct/telecmi-mapper]';

/** Case/punctuation-insensitive key: "Caller_Id-Number" → "calleridnumber". */
function normKey(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9]/g, '');
}

type Norm = Record<string, unknown>;

/**
 * Flatten a raw payload into a normalized-key lookup. Top-level keys win;
 * one level of common envelope nesting (data/cdr/call/payload/body/record)
 * fills the gaps — TeleCMI sometimes wraps the record in an envelope.
 */
function collect(raw: unknown): Norm | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Norm = {};
  const put = (obj: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(obj)) {
      const nk = normKey(k);
      if (nk && v != null && !(nk in out)) out[nk] = v;
    }
  };
  put(raw as Record<string, unknown>);
  for (const nest of ['data', 'cdr', 'call', 'payload', 'body', 'record']) {
    const v = (raw as Record<string, unknown>)[nest];
    if (v && typeof v === 'object' && !Array.isArray(v)) put(v as Record<string, unknown>);
  }
  return out;
}

/** First non-empty string (numbers stringified) across candidate keys. */
function pickStr(m: Norm, keys: string[]): string {
  for (const k of keys) {
    const v = m[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    if (typeof v === 'bigint') return v.toString();
  }
  return '';
}

/** First finite number (numeric strings accepted) across candidate keys. */
function pickNum(m: Norm, keys: string[]): number | null {
  for (const k of keys) {
    const v = m[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() && !Number.isNaN(Number(v.trim()))) {
      return Number(v.trim());
    }
  }
  return null;
}

/**
 * Normalize a time value to UTC ISO. Accepts epoch SECONDS, epoch MILLIS,
 * epoch MICROS, or a parseable date string. Returns null when not a time.
 */
function toIso(v: unknown): string | null {
  if (v == null || typeof v === 'boolean') return null;
  const asEpoch = (n: number): string | null => {
    if (!Number.isFinite(n) || n <= 0) return null;
    let ms = n;
    if (ms >= 1e14) ms = ms / 1000; // microseconds → millis
    else if (ms < 1e11) ms = ms * 1000; // seconds → millis
    if (ms < 1e11 || ms > 4e12) return null; // sanity window ≈1973–2096
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };
  if (typeof v === 'number') return asEpoch(v);
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    if (/^\d{9,17}(\.\d+)?$/.test(s)) return asEpoch(parseFloat(s));
    const t = Date.parse(s);
    if (Number.isNaN(t)) {
      console.warn(`${WARN} unparseable time value "${s.slice(0, 40)}"`);
      return null;
    }
    return new Date(t).toISOString();
  }
  return null;
}

/** First candidate key that yields a valid time. */
function pickTime(m: Norm, keys: string[]): string | null {
  for (const k of keys) {
    if (!(k in m)) continue;
    const iso = toIso(m[k]);
    if (iso) return iso;
  }
  return null;
}

// ---- candidate key sets (normKey'd: lowercase, punctuation stripped) -------

const ID_KEYS = [
  'id', 'callid', 'calluuid', 'uuid', 'sid', 'callsid', 'uniqueid',
  'callrefid', 'refid', 'requestid', 'cdrid',
];
const CUSTOMER_KEYS = ['customernumber', 'customerno', 'customerphone', 'custnumber'];
const FROM_KEYS = [
  'from', 'caller', 'calleridnumber', 'callerid', 'callernumber', 'callerno',
  'fromnumber', 'src', 'source', 'ani', 'cli',
];
const TO_KEYS = [
  'to', 'tonumber', 'dialednumber', 'callednumber', 'destination', 'dest',
  'did', 'didnumber', 'dnis',
];
const AGENT_KEYS = [
  'agentuser', 'agentname', 'agent', 'username', 'user', 'userno',
  'answeredby', 'answeredagent', 'agentid', 'extension', 'ext',
];
const QUEUE_KEYS = ['queue', 'queuename', 'group', 'groupname', 'ringgroup', 'department', 'ivr'];
const START_KEYS = [
  'starttime', 'startedat', 'startstamp', 'starttimestamp', 'start', 'time',
  'calltime', 'calldate', 'datetime', 'date', 'initiatedat', 'createdat',
];
const ANSWER_KEYS = [
  'answeredtime', 'answertime', 'answeredat', 'answerstamp', 'answered',
  'bridgetime', 'connectedtime', 'connectedat', 'pickuptime',
];
const END_KEYS = [
  'endtime', 'endedat', 'endstamp', 'endtimestamp', 'end', 'hanguptime',
  'hangupat', 'completedat', 'closedat', 'finishtime',
];
const DURATION_KEYS = [
  'durationsec', 'durationseconds', 'duration', 'billsec', 'billseconds',
  'callduration', 'talktime', 'talkduration', 'conversationduration',
  'answeredsec', 'answerduration', 'totalduration',
];
const RECORDING_KEYS = [
  'recordingurl', 'recording', 'recordurl', 'recordingfile', 'filename',
  'fileurl', 'playurl', 'recordingpath', 'monitorfilename',
];
const STATUS_KEYS = [
  'status', 'callstatus', 'callstate', 'disposition', 'callresult', 'result',
  'hanguptype', 'hangupcause', 'legstatus',
];
const DIRECTION_KEYS = ['direction', 'calldirection', 'callmode', 'legtype', 'dir', 'calltype'];
const EVENT_KEYS = [
  'event', 'eventtype', 'callevent', 'calleventtype', 'action', 'state',
  'callstate', 'callstatus', 'status', 'type',
];
const LIVE_AT_KEYS = [
  'eventtime', 'timestamp', 'at', 'time', 'ringtime', 'calltime', 'starttime',
  'datetime', 'date', 'createdat',
];

// ---- status / event / direction vocabularies --------------------------------

const ANSWERED_WORDS = [
  'answered', 'answer', 'ans', 'completed', 'complete', 'connected', 'bridged',
  'success', 'successful', 'talked', 'normalclearing',
];
const MISSED_WORDS = [
  'missed', 'miss', 'noanswer', 'noans', 'unanswered', 'notanswered', 'cancel',
  'cancelled', 'canceled', 'busy', 'userbusy', 'failed', 'fail', 'failure',
  'timeout', 'timedout', 'rejected', 'reject', 'congestion', 'unreachable',
  'notreachable', 'chanunavail', 'originatorcancel',
];
const RING_EVENTS = [
  'ring', 'ringing', 'rings', 'incoming', 'incomingcall', 'callincoming',
  'newcall', 'new', 'start', 'started', 'callstart', 'callstarted',
  'initiated', 'callinitiated', 'calling', 'dialing', 'trying', 'progress',
  'originate',
];
const ANSWER_EVENTS = [
  'answer', 'answered', 'callanswer', 'callanswered', 'bridge', 'bridged',
  'connect', 'connected', 'inprogress', 'ongoing', 'live', 'pickup',
  'pickedup', 'accepted', 'attended',
];
const HANGUP_EVENTS = [
  'hangup', 'hungup', 'hangedup', 'callhangup', 'end', 'ended', 'endcall',
  'callend', 'callended', 'complete', 'completed', 'callcomplete',
  'callcompleted', 'disconnect', 'disconnected', 'close', 'closed', 'bye',
  'finish', 'finished', 'terminate', 'terminated', 'missed', 'callmissed',
  'noanswer', 'cancel', 'cancelled', 'canceled', 'busy', 'failed', 'abandoned',
  'voicemail', 'timeout',
];

/** Truncated JSON snippet for warn logs (full raw is kept in ct_webhook_log). */
function snippet(raw: unknown): string {
  try {
    return JSON.stringify(raw)?.slice(0, 300) ?? String(raw);
  } catch {
    return String(raw);
  }
}

/** Internal: classify without warning; null = unrecognized. */
function statusFamilyOrNull(status: string): MappedCdr['status'] | null {
  const s = (status || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return null;
  if (ANSWERED_WORDS.includes(s)) return 'answered';
  if (s.includes('voicemail') || s === 'vm') return 'voicemail';
  if (s.includes('abandon')) return 'abandoned';
  if (MISSED_WORDS.includes(s)) return 'missed';
  // substring fallbacks — check missed-family markers BEFORE 'answer'
  // ('noanswer' contains 'answer')
  if (
    s.includes('miss') || s.includes('noanswer') || s.includes('cancel') ||
    s.includes('busy') || s.includes('fail') || s.includes('reject') ||
    s.includes('timeout') || s.includes('unreach')
  ) {
    return 'missed';
  }
  if (s.includes('answer') || s.includes('connect') || s.includes('bridge')) return 'answered';
  return null;
}

/**
 * Map any TeleCMI status spelling to our 4-value family:
 * answered/ANSWER/completed → 'answered'; noanswer/cancel/busy/failed/… →
 * 'missed'; abandon* → 'abandoned'; voicemail → 'voicemail'.
 * Unknown values warn and default to 'missed' (safer: a spurious recovery
 * beats a silently lost missed call).
 */
export function statusFamily(status: string): 'answered' | 'missed' | 'abandoned' | 'voicemail' {
  const fam = statusFamilyOrNull(status);
  if (fam) return fam;
  console.warn(`${WARN} unknown call status "${String(status).slice(0, 40)}" — defaulting to 'missed'`);
  return 'missed';
}

function pickDirection(m: Norm): 'inbound' | 'outbound' {
  const raw = pickStr(m, DIRECTION_KEYS);
  if (!raw) return 'inbound'; // single inbound DID is the common case
  const d = raw.toLowerCase().replace(/[^a-z]/g, '');
  if (['in', 'i', 'inb', 'inbound', 'incoming', 'inboundcall', 'incomingcall', 'receive', 'received'].includes(d)) return 'inbound';
  if (['out', 'o', 'ob', 'outb', 'outbound', 'outgoing', 'outboundcall', 'outgoingcall', 'dial', 'dialout', 'clicktocall', 'originate'].includes(d)) return 'outbound';
  // substring fallback — 'out' first ("outgoing" also contains "in")
  if (d.includes('out')) return 'outbound';
  if (d.includes('in')) return 'inbound';
  console.warn(`${WARN} unknown direction "${raw}" — defaulting to 'inbound'`);
  return 'inbound';
}

/**
 * The CUSTOMER's number: explicit customer fields first, then the
 * direction-appropriate side (inbound → from/caller, outbound → to/dialed).
 * We deliberately do NOT fall back to the other side — that would be the
 * business DID and would poison the phone join key.
 */
function pickPhone(m: Norm, direction: 'inbound' | 'outbound'): string {
  return (
    pickStr(m, CUSTOMER_KEYS) ||
    pickStr(m, direction === 'outbound' ? TO_KEYS : FROM_KEYS)
  );
}

function pickAgent(m: Norm): string {
  const direct = pickStr(m, AGENT_KEYS);
  if (direct) return direct;
  // TeleCMI sometimes sends agent/user as an object ({ name, id, ... })
  for (const k of ['agent', 'user']) {
    const v = m[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      for (const f of ['name', 'username', 'user', 'email', 'id']) {
        const s = o[f];
        if (typeof s === 'string' && s.trim()) return s.trim();
        if (typeof s === 'number' && Number.isFinite(s)) return String(s);
      }
    }
  }
  return '';
}

function pickLiveEvent(m: Norm): 'ring' | 'answer' | 'hangup' {
  const raw = pickStr(m, EVENT_KEYS);
  const e = raw.toLowerCase().replace(/[^a-z]/g, '');
  if (e) {
    if (RING_EVENTS.includes(e)) return 'ring';
    if (ANSWER_EVENTS.includes(e)) return 'answer';
    if (HANGUP_EVENTS.includes(e)) return 'hangup';
  }
  // Unknown/absent event name — infer from which call facts are present.
  let inferred: 'ring' | 'answer' | 'hangup';
  if (pickTime(m, END_KEYS) || (pickNum(m, DURATION_KEYS) ?? 0) > 0) inferred = 'hangup';
  else if (pickTime(m, ANSWER_KEYS)) inferred = 'answer';
  else inferred = 'ring';
  console.warn(`${WARN} unknown live event "${raw}" — inferring '${inferred}'`);
  return inferred;
}

/**
 * Map a live ("notify") webhook payload. Returns null ONLY when the payload
 * carries neither a phone number nor a call id (nothing to key on).
 */
export function mapLivePayload(raw: any): MappedLiveEvent | null {
  const m = collect(raw);
  if (!m) {
    console.warn(`${WARN} live payload is not a JSON object — ignoring: ${snippet(raw)}`);
    return null;
  }
  const telecmiCallId = pickStr(m, ID_KEYS);
  const direction = pickDirection(m);
  const phone = pickPhone(m, direction);
  if (!telecmiCallId && !phone) {
    console.warn(`${WARN} live payload has no call id AND no phone — ignoring: ${snippet(raw)}`);
    return null;
  }
  if (!phone) {
    console.warn(`${WARN} live payload has no customer number (call ${telecmiCallId}): ${snippet(raw)}`);
  }
  return {
    telecmiCallId,
    phone,
    direction,
    event: pickLiveEvent(m),
    agent: pickAgent(m),
    queue: pickStr(m, QUEUE_KEYS),
    at: pickTime(m, LIVE_AT_KEYS) ?? new Date().toISOString(),
  };
}

/**
 * Map a CDR ("call report") webhook payload. Returns null ONLY when the
 * payload carries neither a phone number nor a call id. Missing times are
 * reconstructed conservatively (started ← answered ← ended ± duration) so
 * the contract's non-null startedAt/endedAt always hold.
 */
export function mapCdrPayload(raw: any): MappedCdr | null {
  const m = collect(raw);
  if (!m) {
    console.warn(`${WARN} CDR payload is not a JSON object — ignoring: ${snippet(raw)}`);
    return null;
  }
  const telecmiCallId = pickStr(m, ID_KEYS);
  const direction = pickDirection(m);
  const phone = pickPhone(m, direction);
  if (!telecmiCallId && !phone) {
    console.warn(`${WARN} CDR payload has no call id AND no phone — ignoring: ${snippet(raw)}`);
    return null;
  }
  if (!phone) {
    console.warn(`${WARN} CDR has no customer number (call ${telecmiCallId}): ${snippet(raw)}`);
  }

  const answeredAt = pickTime(m, ANSWER_KEYS);
  let startedAt = pickTime(m, START_KEYS);
  let endedAt = pickTime(m, END_KEYS);
  let durationSec = pickNum(m, DURATION_KEYS);
  if (durationSec == null && answeredAt && endedAt) {
    durationSec = (Date.parse(endedAt) - Date.parse(answeredAt)) / 1000;
  }
  durationSec = Math.max(0, Math.round(durationSec ?? 0));
  if (!startedAt) {
    startedAt =
      answeredAt ??
      (endedAt
        ? new Date(Date.parse(endedAt) - durationSec * 1000).toISOString()
        : new Date().toISOString());
  }
  if (!endedAt) {
    endedAt = durationSec
      ? new Date(Date.parse(startedAt) + durationSec * 1000).toISOString()
      : startedAt;
  }

  const statusRaw = pickStr(m, STATUS_KEYS);
  let status = statusFamilyOrNull(statusRaw);
  if (!status) {
    // No/unknown status — infer from evidence of a conversation.
    status = answeredAt || durationSec > 0 ? 'answered' : 'missed';
    console.warn(
      `${WARN} CDR status "${statusRaw}" not recognized — inferring '${status}': ${snippet(raw)}`
    );
  }

  return {
    telecmiCallId,
    phone,
    direction,
    status,
    agent: pickAgent(m),
    queue: pickStr(m, QUEUE_KEYS),
    startedAt,
    answeredAt,
    endedAt,
    durationSec,
    recordingUrl: pickStr(m, RECORDING_KEYS),
  };
}
