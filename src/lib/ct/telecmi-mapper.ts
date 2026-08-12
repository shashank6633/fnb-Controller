/**
 * TeleCMI payload mapper for the Call-to-Table CRM.
 *
 * TeleCMI field names vary by account/region/product (CHUB "notify" live
 * events vs "call report" CDRs), so this is the ONE tolerant mapping layer
 * between raw webhook JSON and our normalized shapes — business logic
 * (src/lib/ct/ingest.ts) never touches raw payloads directly.
 *
 * It also decides, per record, whether there is a GUEST in it at all — a routed
 * inbound call is reported as two records and only one of them has a caller.
 * See CallLeg / classifyLeg() below.
 *
 * Pure functions: no DB, no side effects beyond console.warn on unknown shapes.
 * The single import is a default STRING constant (the recording base URL) —
 * nothing here reads or writes the database, and mapCdrPayload() stays callable
 * with a payload alone. Phone values are returned RAW — ingest normalizes them
 * via normalizePhone() (see src/lib/ct/phone.ts). Timestamps are normalized
 * here to UTC ISO-8601 (accepts epoch seconds, epoch millis, or ISO strings).
 */
import { RECORDING_BASE_URL_DEFAULT } from './settings';

/**
 * WHICH LEG OF A ROUTED CALL a record describes.
 *
 * TeleCMI reports a routed inbound call as TWO records, not one: the guest
 * dialling our virtual number, and the platform then dialling an agent's
 * handset. Only the first has a guest in it. The second is internal plumbing —
 * its `from` is the number our agents' phones see the call arrive from, which
 * is ours, not the caller's — and putting it in front of a GRE as "a caller" is
 * how "79434 46235" ended up on the Live wallboard with its own answered/ended
 * lines. See classifyLeg() for the (deliberately narrow) test.
 *
 *   'guest'    — treat as a real call. THE DEFAULT, and what an unconfigured
 *                install returns for everything, exactly as before this field
 *                existed.
 *   'internal' — the number we would report as the customer is demonstrably
 *                OURS, so there is no guest in this record.
 */
export type CallLeg = 'guest' | 'internal';

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
  /** guest vs internal plumbing — see CallLeg. */
  leg: CallLeg;
  /** WHY `leg` is 'internal', in one sentence. '' whenever leg is 'guest'. */
  legNote: string;
  /**
   * OUR OWN number exactly as this payload named it (`virtual_number`), '' when
   * the payload carried no such field. Callers persist it so later payloads —
   * including live events, which may not repeat it — can be classified too.
   */
  virtualNumber: string;
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
  /**
   * Did TeleCMI say this call was recorded? THREE-STATE — see pickRecordFlag().
   * 'unknown' is not a synonym for 'no': it means the payload never said.
   */
  recordFlag: RecordFlag;
  /** guest vs internal plumbing — see CallLeg. */
  leg: CallLeg;
  /** WHY `leg` is 'internal', in one sentence. '' whenever leg is 'guest'. */
  legNote: string;
  /** OUR OWN number as this payload named it — see MappedLiveEvent.virtualNumber. */
  virtualNumber: string;
}

/**
 * TeleCMI's `record` boolean, kept three-state.
 *
 *   'yes'     — the payload says the call WAS recorded.
 *   'no'      — the payload says it was NOT.
 *   'unknown' — the payload carried no such field, so we have no claim to make.
 *
 * The third state is the point. Without it, "TeleCMI never recorded this call"
 * and "a recording exists but we failed to store its URL" are the same blank,
 * and only the second is a fault worth chasing.
 */
export type RecordFlag = 'yes' | 'no' | 'unknown';

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

// 'cmiuid' FIRST — it is TeleCMI's unique call id on the LIVE ("notify") events,
// and its absence from this list was the whole reason live/CDR correlation did
// not work: pickStr() returned '', ct_calls.telecmi_call_id went in NULL, and the
// CDR that arrives at hangup could never find the ringing row it was meant to
// finalise. Screen-pop matched nothing for the same reason.
//
// CORRECTION, from a 17-field census of REAL CDRs on this account: a CDR carries
// NO 'cmiuid' at all. It carries `cmiuuid` (two u's), `call_id` and
// `conversation_uuid`. normKey() only strips punctuation, so 'cmiuuid' does NOT
// collapse to 'cmiuid' — the CDR resolves its id from `call_id` (which normalizes
// to 'callid'), and it always has. An earlier version of this comment claimed
// cmiuid was "the only one a real payload carries" and "the one that fires in
// production"; that is true of live events and FALSE of CDRs, and it is corrected
// here rather than left to mislead the next reader.
//
// 'cmiuuid' is therefore listed — but LAST, not next to 'cmiuid'. Position is
// load-bearing: today's CDRs carry cmiuuid AND call_id, every existing
// ct_calls.telecmi_call_id was written from call_id, and promoting cmiuuid above
// 'callid' would silently re-key every future CDR — a re-delivery would insert a
// DUPLICATE row instead of updating, and the live events would stop matching. At
// the end it changes nothing for any payload that has one of the other keys, and
// rescues only the payload that carries cmiuuid ALONE, which today maps to an
// EMPTY id and can correlate with nothing.
//
// `conversation_uuid` is deliberately NOT here. It is shared BY BOTH LEGS of one
// routed call, so using it as the call id would merge the guest leg and the agent
// leg into a single ct_calls row — a different behaviour from suppressing the
// agent leg, and not the one asked for.
const ID_KEYS = [
  'cmiuid',
  'id', 'callid', 'calluuid', 'uuid', 'sid', 'callsid', 'uniqueid',
  'callrefid', 'refid', 'requestid', 'cdrid',
  'cmiuuid',
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
// OUR OWN number, as TeleCMI itself names it on the record. `virtual_number` is
// in the measured 17-field CDR census and is the vendor's own word for the DID
// this account rents — so a payload that reports the SAME number as the customer
// is, on its own evidence, not describing a guest.
//
// DELIBERATELY NARROW. It does NOT include 'did'/'didnumber'/'dnis', even though
// those also name our side on an inbound call: they are in TO_KEYS, where they
// are a *guess* at another PBX's spelling of the destination, and a payload that
// put a guest's number in one of them would then get that guest suppressed. The
// whole point of this list is that every key on it is unambiguously ours.
const OWN_NUMBER_KEYS = ['virtualnumber', 'virtualno'];
const AGENT_KEYS = [
  'agentuser', 'agentname', 'agent', 'username', 'user', 'userno',
  'answeredby', 'answeredagent', 'agentid', 'extension', 'ext',
];
// 'team' is TeleCMI's own name for the ring group, and it is the field their
// real CDRs actually carry (observed in the production recording-diagnostic
// capture; none of the other keys here appeared in those payloads). It matters
// most on calls NOBODY answered: TeleCMI names an agent only when someone
// picked up, so on a missed/abandoned CDR the ring group is the ONLY honest
// answer to "who missed this" — a team, never a person.
//
// ORDER: after 'queue'/'queuename', before the rest. pickStr takes the FIRST
// key present, so position only decides a payload carrying two of these.
//  · after queue/queuename — those name the destination column's concept
//    directly and are what every existing payload/mock maps through today;
//    putting 'team' first would change what such a payload resolves to.
//  · before group/groupname/ringgroup/department/ivr — those are defensive
//    aliases for other PBXs, and two of them mean something else entirely (an
//    IVR node is a menu, not the group that rang). A field we have observed on
//    this account outranks a guess at another one.
// 'ivr' was dropped from this list. It used to be harmless: the value was only
// ever shown as a bare label. The Call Log now renders it as an assertion —
// "Rang <value>" — and an IVR node is a MENU, not a group of phones, so that
// sentence would be false. Nothing on this account sends it (a 17-field census
// of real CDRs found only 'team'), so no payload loses a queue by this removal;
// one that carried ivr alone now shows no team rather than a wrong one.
const QUEUE_KEYS = [
  'queue', 'queuename', 'team', 'group', 'groupname', 'ringgroup', 'department',
];
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
// 'duration' (total seconds) is what TeleCMI sends and is listed below; 'billedsec'
// is its companion — the BILLED seconds, spelled with the 'ed' that 'billsec' and
// 'billseconds' both miss, so it was falling through. It sits after 'duration'
// deliberately: billed time excludes ring time and would understate how long the
// guest was actually on the call.
const DURATION_KEYS = [
  'durationsec', 'durationseconds', 'duration', 'billedsec', 'billsec', 'billseconds',
  'callduration', 'talktime', 'talkduration', 'conversationduration',
  'answeredsec', 'answerduration', 'totalduration',
];
// Half of these keys ('filename', 'recordingfile', 'recordingpath',
// 'monitorfilename') are named for a FILE, not a URL — TeleCMI calls the field
// "filename" because on some accounts that is exactly what it is. The picked
// value therefore goes through normalizeRecordingValue() below before it
// becomes MappedCdr.recordingUrl; storing it raw is what made the recording
// proxy answer "Recording URL is invalid" on every real call.
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

/** Digits only, so "+91 79434 46235", "9179434 46235" and 7943446235 compare. */
function digitsOf(v: unknown): string {
  return String(v ?? '').replace(/\D/g, '');
}

/**
 * Are these two strings the same phone number? Exact digits, or the same last
 * TEN digits when BOTH sides have at least ten — which is how "7943446235" and
 * "917943446235" are the one number, and the same rule the rest of this module
 * already joins guests on.
 *
 * The both-sides length floor is the safety catch: without it a 3-digit agent
 * EXTENSION would "match" by suffix and we would suppress a real call.
 */
function sameNumber(a: string, b: string): boolean {
  const x = digitsOf(a);
  const y = digitsOf(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 10 && y.length >= 10) return x.slice(-10) === y.slice(-10);
  return false;
}

/**
 * Is this record the guest's leg, or the internal leg the call was routed over?
 *
 * ONE TEST, AND IT IS DELIBERATELY THE NARROWEST ONE THAT WORKS: the number we
 * are about to report as THE CUSTOMER is one of OUR numbers. A guest's call
 * cannot arrive from our own DID, so when it appears to, we are looking at the
 * platform→agent leg (or an equally useless call-to-ourselves record).
 *
 * "Our numbers" comes from two places, both evidence rather than guesswork:
 *   1. `virtual_number` ON THIS VERY PAYLOAD — TeleCMI naming its own DID. Needs
 *      no configuration at all.
 *   2. `ownNumbers`, passed in by the caller (ct_settings; see ctOwnNumbers() in
 *      src/lib/ct/ingest.ts). EMPTY on an unconfigured install, which is why
 *      such an install behaves here exactly as it did before this function
 *      existed.
 *
 * WHAT IT DELIBERATELY DOES NOT DO, because both would cost us real guest calls:
 *   · It does not compare `to` against virtual_number. That would classify by
 *     where the call was GOING, and a payload that omits or re-spells `to` would
 *     take a genuine guest with it.
 *   · It does not group legs by `conversation_uuid`. Whichever leg arrived first
 *     would win, and if the internal leg won the race the GUEST would be the one
 *     suppressed. Hiding a real caller costs money; showing an internal number is
 *     merely embarrassing, so every uncertain case resolves to 'guest'.
 */
function classifyLeg(
  phone: string,
  virtualNumber: string,
  ownNumbers: string[] | undefined,
): { leg: CallLeg; legNote: string } {
  if (!phone) return { leg: 'guest', legNote: '' };
  if (virtualNumber && sameNumber(phone, virtualNumber)) {
    return {
      leg: 'internal',
      legNote: `the number reported as the customer (${phone}) is this payload's own virtual_number (${virtualNumber})`,
    };
  }
  for (const own of ownNumbers ?? []) {
    if (own && sameNumber(phone, own)) {
      return {
        leg: 'internal',
        legNote: `the number reported as the customer (${phone}) is one of our own numbers (${own})`,
      };
    }
  }
  return { leg: 'guest', legNote: '' };
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

// 'record' is the key TeleCMI actually sends (a JSON boolean). The other two
// are defensive aliases in the style of the lists above — we have not seen them
// from this account.
//
// NOT TO BE CONFUSED with the 'record' in collect()'s envelope-nest list: that
// one is for a payload shaped { record: { ...the cdr... } }, and collect() only
// descends into it when the value is an OBJECT. A boolean fails that test, so
// it stays put as a top-level value here. 'record' is also absent from
// RECORDING_KEYS, so a boolean can never be mistaken for a recording filename.
const RECORD_FLAG_KEYS = ['record', 'isrecorded', 'recorded'];

const TRUEY = ['true', '1', 'yes', 'y', 'on'];
const FALSEY = ['false', '0', 'no', 'n', 'off'];

/**
 * Read the recording flag WITHOUT inventing one. Booleans and 0/1 numbers map
 * straight across; a string maps only if it spells a boolean.
 *
 * Anything else — an object (the envelope case above), a timestamp, a filename
 * parked in a `recorded` field — falls through to the next key and finally to
 * 'unknown'. Guessing here would be worse than not knowing: a wrong 'no' is a
 * claim that TeleCMI never recorded the call, which we would have no basis for.
 */
function pickRecordFlag(m: Norm): RecordFlag {
  for (const k of RECORD_FLAG_KEYS) {
    const v = m[k];
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    if (typeof v === 'number' && Number.isFinite(v)) return v !== 0 ? 'yes' : 'no';
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      if (TRUEY.includes(s)) return 'yes';
      if (FALSEY.includes(s)) return 'no';
    }
  }
  return 'unknown';
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

/** Options for mapLivePayload(). */
export interface MapLiveOptions {
  /**
   * OUR OWN numbers (DIDs / trunk numbers), read from ct_settings by
   * ctOwnNumbers(db) in src/lib/ct/ingest.ts and passed in — this module stays
   * pure and never touches the DB, exactly as MapCdrOptions.recordingBaseUrl
   * already works.
   *
   * OMITTED or [] → nothing is ever classified 'internal' on this evidence, so
   * an unconfigured install is byte-for-byte what it was. (A payload naming its
   * own `virtual_number` is still classified from that, which needs no setting.)
   */
  ownNumbers?: string[];
}

/**
 * Map a live ("notify") webhook payload. Returns null ONLY when the payload
 * carries neither a phone number nor a call id (nothing to key on).
 */
export function mapLivePayload(raw: any, opts: MapLiveOptions = {}): MappedLiveEvent | null {
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
  const virtualNumber = pickStr(m, OWN_NUMBER_KEYS);
  const { leg, legNote } = classifyLeg(phone, virtualNumber, opts.ownNumbers);
  return {
    telecmiCallId,
    phone,
    direction,
    event: pickLiveEvent(m),
    agent: pickAgent(m),
    queue: pickStr(m, QUEUE_KEYS),
    at: pickTime(m, LIVE_AT_KEYS) ?? new Date().toISOString(),
    leg,
    legNote,
    virtualNumber,
  };
}

// ---- recording value normalization ------------------------------------------

/**
 * What normalizeRecordingValue() did with the raw CDR recording field:
 *   absolute   — it was already an http(s) URL; passed through untouched.
 *   empty      — the CDR carried no recording field at all.
 *   joined     — it was a filename/relative path, joined onto the base.
 *   unresolved — there WAS a value but no URL could honestly be built from it
 *                (base blank, base unusable, or a non-http scheme). url is ''.
 */
export type RecordingShape = 'absolute' | 'empty' | 'joined' | 'unresolved';

export interface NormalizedRecording {
  /** Fetchable URL, or '' when we refuse to guess one. */
  url: string;
  shape: RecordingShape;
  /** The raw field value we started from, trimmed. */
  raw: string;
  /** The base actually applied ('' when none was needed or none was usable). */
  base: string;
  /** Plain-English WHY — for the recording diagnostic and the warn log. */
  note: string;
}

const ABSOLUTE_HTTP_RE = /^https?:\/\//i;
// RFC 3986 scheme grammar. Used only to spot a value that is some OTHER kind of
// URI (s3:, file:, ftp:) so we do not paste it onto an http base.
const ANY_SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;

/**
 * Turn whatever TeleCMI put in the recording field into something the recording
 * proxy can actually fetch — without hardcoding a guess at their URL scheme.
 *
 * We have never seen a real CDR from this account, so the field can be any of
 * three shapes and all three must be handled:
 *   (a) a full https URL      → used as-is (this is what the seed rows and the
 *                               current proxy already expect; must not regress)
 *   (b) a bare filename or a
 *       relative path         → joined onto `base` (ct_settings
 *                               'recording_base_url', see ctRecordingBaseUrl())
 *   (c) nothing               → stays empty
 *
 * We never fabricate a URL out of a call id: a made-up URL that 404s makes "no
 * recording" indistinguishable from "recording broken", which is worse than an
 * honest blank. For the same reason, a value we cannot resolve comes back as
 * 'unresolved' with a note rather than as a plausible-looking wrong URL.
 *
 * SECURITY: this only BUILDS a string. Everything still goes through
 * fetchAllowedRecording() (https + host allowlist + manual redirect
 * re-validation) — a base pointing at a non-allowlisted host does not smuggle
 * anything through, the proxy refuses it and says so.
 *
 * Pure: no DB, no network. The caller supplies the base.
 */
export function normalizeRecordingValue(rawValue: string, base: string): NormalizedRecording {
  const raw = String(rawValue ?? '').trim();
  const b = String(base ?? '').trim();

  // (c) nothing to work with.
  if (!raw) {
    return { url: '', shape: 'empty', raw: '', base: '', note: 'CDR carried no recording field' };
  }

  // (a) already absolute. Returned EXACTLY as received, not re-serialized: the
  // proxy is the one place that decides whether a URL is fetchable, and if this
  // one is malformed its "Recording URL is invalid" is a better answer than us
  // blanking the field and reporting "no recording". We still parse it so the
  // note can say which of those two is about to happen.
  if (ABSOLUTE_HTTP_RE.test(raw)) {
    let parses = true;
    try { new URL(raw); } catch { parses = false; }
    return {
      url: raw,
      shape: 'absolute',
      raw,
      base: '',
      note: parses
        ? 'absolute http(s) URL — used unchanged'
        : 'looks absolute but does not parse as a URL — the proxy will refuse it',
    };
  }

  // Some other URI scheme (s3:, file:, ftp:, a Windows drive letter …). Pasting
  // it onto an http base would produce nonsense, so refuse it visibly.
  const scheme = ANY_SCHEME_RE.exec(raw);
  if (scheme) {
    return {
      url: '', shape: 'unresolved', raw, base: b,
      note: `value uses the "${scheme[1]}" scheme, not http(s) — refusing to join it onto the recording base`,
    };
  }

  // (b) filename / relative path — needs a base.
  if (!b) {
    return {
      url: '', shape: 'unresolved', raw, base: '',
      note: 'value is a filename or relative path but recording_base_url is blank — refusing to guess a URL',
    };
  }
  let baseUrl: URL;
  try { baseUrl = new URL(b); } catch {
    return {
      url: '', shape: 'unresolved', raw, base: b,
      note: 'recording_base_url is not a URL — fix it in ct_settings',
    };
  }

  try {
    let built: URL;
    if (b.endsWith('=')) {
      // Query-style endpoint (…/play?file=). The base is a literal prefix, so
      // concatenate and percent-encode — a path join would put the filename in
      // the wrong place entirely. This repo's own simulator already emits that
      // shape (scripts/simulate-call.ts), so it is a real possibility, not a
      // hypothetical.
      built = new URL(b + encodeURIComponent(raw));
    } else if (raw.startsWith('/')) {
      // Root-relative ('/rec/x.mp3') or protocol-relative ('//host/x.mp3'):
      // resolve against the ORIGIN. The base path is a directory prefix and
      // must NOT be prepended to a path that already starts at the root.
      built = new URL(raw, baseUrl.origin);
      // Keep a token/query the admin put on the base — but never overwrite one
      // the VALUE brought with it (a pre-signed link is more specific than our
      // base and must win).
      if (!built.search) built.search = baseUrl.search;
    } else {
      // Directory-style append, with exactly one slash. new URL('x.mp3',
      // 'https://h/v2/play') would resolve to 'https://h/v2/x.mp3' and silently
      // LOSE the 'play' segment, so force the trailing slash first.
      const dir = baseUrl.pathname.endsWith('/') ? baseUrl.pathname : baseUrl.pathname + '/';
      built = new URL(dir + raw, baseUrl.origin);
      if (!built.search) built.search = baseUrl.search; // value's own query wins
    }
    return { url: built.toString(), shape: 'joined', raw, base: b, note: `joined onto ${b}` };
  } catch {
    return {
      url: '', shape: 'unresolved', raw, base: b,
      note: 'value could not be joined onto recording_base_url',
    };
  }
}

/** Options for mapCdrPayload(). */
export interface MapCdrOptions {
  /**
   * Base URL for RELATIVE recording values — ct_settings 'recording_base_url',
   * read with ctRecordingBaseUrl(db) (src/lib/ct/settings.ts).
   *
   * OMITTED   → the shipped default (RECORDING_BASE_URL_DEFAULT), so a caller
   *             that has no DB handle still behaves sanely.
   * ''        → joining is off; a relative value stays empty (see the
   *             'unresolved' shape) instead of becoming an unfetchable URL.
   *
   * Absolute URLs in the payload ignore this entirely.
   */
  recordingBaseUrl?: string;
  /** OUR OWN numbers — see MapLiveOptions.ownNumbers. */
  ownNumbers?: string[];
}

/**
 * Map a CDR ("call report") webhook payload. Returns null ONLY when the
 * payload carries neither a phone number nor a call id. Missing times are
 * reconstructed conservatively (started ← answered ← ended ± duration) so
 * the contract's non-null startedAt/endedAt always hold.
 */
export function mapCdrPayload(raw: any, opts: MapCdrOptions = {}): MappedCdr | null {
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

  // The recording field may be a URL, a bare filename, or absent — see
  // normalizeRecordingValue(). Only 'unresolved' is worth a log line: it is the
  // one case where a recording EXISTS upstream and we are storing nothing for
  // it, which would otherwise be indistinguishable from a call with no
  // recording at all.
  const recording = normalizeRecordingValue(
    pickStr(m, RECORDING_KEYS),
    opts.recordingBaseUrl ?? RECORDING_BASE_URL_DEFAULT,
  );
  if (recording.shape === 'unresolved') {
    console.warn(
      `${WARN} recording "${recording.raw.slice(0, 80)}" on call ${telecmiCallId || phone} — ${recording.note}`,
    );
  }

  const virtualNumber = pickStr(m, OWN_NUMBER_KEYS);
  const { leg, legNote } = classifyLeg(phone, virtualNumber, opts.ownNumbers);

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
    recordingUrl: recording.url,
    recordFlag: pickRecordFlag(m),
    leg,
    legNote,
    virtualNumber,
  };
}
