/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { mapCdrPayload } from '@/lib/ct/telecmi-mapper';
import {
  assertAllowedRecordingUrl,
  fetchAllowedRecording,
  peekRecordingBody,
  recordingAllowlist,
} from '@/lib/ct/recording-fetch';
import { recordingRetentionStatus } from '@/lib/ct/retention';
import { isSecretKey, maskSecretValue } from '@/lib/secret-keys';
import { telecmiAppId, telecmiSecret } from '@/lib/ct/settings';

/**
 * GET /api/telecmi/recording-diagnostic — admin-only, READ-ONLY.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Call recordings do not play. The chain is: TeleCMI CDR webhook → mapper
 * (recordingUrl) → ct_calls.recording_url → /api/telecmi/recording/[callId]
 * proxy → <audio>. The proxy refuses anything that is not an HTTPS URL on an
 * allowlisted host, and TeleCMI names its field FILENAME — because on some
 * accounts that is exactly what it is.
 *
 * We have never seen a real CDR from this account, so the field can be any of
 * three shapes and NOBODY CAN SAY WHICH:
 *   (a) a full https URL      → the chain should already work
 *   (b) a bare filename/path  → the mapper joins it onto a recording base
 *                               (normalizeRecordingValue in telecmi-mapper.ts);
 *                               whether the joined URL is the RIGHT one can
 *                               only be settled by a real payload
 *   (c) nothing at all        → recording is off on the account
 * And there is a fourth, likelier-than-all-of-them possibility: no CDR has
 * ever arrived, in which case NO code change to the player would ever have
 * helped. This route answers which one it is, from real data, without anyone
 * having to read raw JSON out of a table.
 *
 * ── WHAT IT REPORTS ────────────────────────────────────────────────────────
 *   webhooks   Are CDRs arriving at all? Count + newest. ZERO is the single
 *              most useful answer here, so it is called out explicitly, and
 *              the LIVE (screen-pop) count sits beside it: live arriving while
 *              cdr is zero pins the fault on the CDR webhook URL specifically,
 *              not on connectivity or the token.
 *   latest_cdr Field-by-field: which keys the MAPPER reads as recording
 *              fields, their raw values, what the mapper produces from them
 *              (unchanged, or joined onto a base), and whether that result
 *              would survive the proxy's validator.
 *   scan       The newest CDR that actually carries a recording value — the
 *              newest CDR overall is often a missed call with no recording,
 *              and reading that as "TeleCMI never sends one" is the obvious
 *              wrong conclusion this prevents.
 *   stored     How many ct_calls rows hold a recording_url, and how many of
 *              those are demo fixtures. Today: every one of them is a fixture.
 *   probe      OPT-IN (?probe=1), and the only part that leaves this server:
 *              it actually ASKS TeleCMI for a stored recording and reports the
 *              status, the content type and the first bytes of anything that is
 *              not audio. Everything else here proves the URL's SHAPE; a URL can
 *              be perfectly shaped and still be a path the vendor does not
 *              serve, which is precisely the failure this module hit. Bounded —
 *              see the comment above probeCall().
 *
 * ── IT MUST NOT WRITE ──────────────────────────────────────────────────────
 * SELECTs only. Note in particular that this route does NOT call
 * webhookToken() to report whether a token is configured: that helper MINTS
 * AND PERSISTS a token when none exists (src/lib/ct/settings.ts), so calling
 * it from a diagnostic would silently create state. The token presence check
 * below is a plain SELECT plus an env read, and the token value is never read
 * into the response.
 *
 * ── IT MUST NOT LEAK ───────────────────────────────────────────────────────
 * A CDR payload can carry account identifiers. The ONLY payload values echoed
 * are those of RECOGNIZED RECORDING FIELDS, and each goes through echoValue():
 * a name that says credential (the shared isSecretKey(), src/lib/secret-keys.ts,
 * plus a small telephony-specific list for what that pattern deliberately does
 * not match) masks the whole value; a credential found INSIDE an
 * innocent-looking value is blanked in place by redactCreds(), which keeps the
 * rest of the string readable.
 *
 * redactCreds() also runs on everything DERIVED from those values on the way
 * out — the normalized URL, the base, the ingest error. It has to: a recording
 * URL can carry a token in its query string, and the normalized URL was
 * printing the app secret in the clear until that was added.
 *
 * Every OTHER field contributes its NAME and a SHAPE only ("string(37) https
 * URL") — never its value. A name and a length cannot leak a credential, and
 * the name is the thing we actually need: if TeleCMI calls the recording
 * something the mapper has never heard of, the name is what tells us.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Longest echoed value. Recording paths are short; a longer string is either a
 *  signed URL whose tail adds nothing to the diagnosis, or not a recording. */
const VALUE_LIMIT = 200;

/** How many recent CDR rows the "find one that actually carries a recording"
 *  scan may walk. Bounded so a diagnostic can never become a table scan. */
const SCAN_LIMIT = 50;

/**
 * Sentinel for mapperReadsAsRecording().
 *
 * WHY IT IS SPELLED LIKE THIS — two deliberate properties:
 *  1. It contains "answer", so when the probe happens to overwrite the payload's
 *     own status field the mapper still classifies it (statusFamilyOrNull's
 *     substring arm) instead of emitting an "unknown status" warning.
 *  2. It reads as what it is. A probe key that lands on a TIME field still
 *     produces one mapper warning ("unparseable time value ..."), and whoever
 *     reads that log line must be able to see instantly that it came from this
 *     diagnostic and is not a real malformed CDR.
 */
const PROBE_VALUE = 'answered-recording-key-probe';

/**
 * Field names that SECRET_KEY_RE deliberately does not match but that a
 * TELEPHONY payload can plausibly carry. This is NOT a copy of that pattern and
 * must never grow into one — secret-keys.ts stays the single rule for settings
 * keys (its own comment says so). This is a second, narrower layer for one
 * payload vocabulary: TeleCMI authenticates with appid + secret, and "secret"
 * is already caught while "appid" is not (api[_-]?key does not match appid).
 * Compared on the punctuation-stripped name so app_id / App-ID all land here.
 */
const TELEPHONY_IDENTITY_KEYS = new Set(['appid', 'apid', 'appsecret', 'key', 'auth', 'authkey']);

/** Punctuation-stripped lowercase name, for the small denylist above ONLY. The
 *  mapper's own key normalization is not reimplemented here — see
 *  mapperReadsAsRecording(), which asks the mapper instead of guessing. */
function bareKey(k: string): string {
  return String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Does the mapper read THIS key, at THIS nesting, as a recording field?
 *
 * WHY WE ASK THE MAPPER INSTEAD OF LISTING ITS KEYS: RECORDING_KEYS lives in
 * src/lib/ct/telecmi-mapper.ts and is not exported, and copying the list here
 * would create exactly the two-lists-one-truth drift this codebase has been
 * burned by before — a key added there next month would silently stop being
 * reported here, and the diagnostic would confidently say "no recording field
 * present" about a payload that has one. So instead we hand the mapper a
 * minimal synthetic CDR carrying only this key set to a sentinel: if the
 * sentinel comes back as recordingUrl, the mapper reads this key. The answer is
 * derived from the mapper itself and cannot drift from it.
 *
 * The nesting is reproduced too (parent = an envelope like data/cdr/call), so a
 * key the mapper would only find at the top level is not reported as readable
 * when it is actually buried where the mapper never looks.
 *
 * The scaffold fields (cmiuid / customer_number / status) exist only to get the
 * payload past mapCdrPayload's "no id AND no phone" rejection quietly. When the
 * probed key collides with one of them the probe still works — the sentinel
 * simply becomes the id, phone or status, none of which is a recording field.
 *
 * CONTAINS, NOT EQUALS. The mapper does not necessarily hand the value back
 * untouched: a filename gets JOINED onto a recording base, so the sentinel
 * comes back embedded in a URL. An equality check silently reported every
 * recording key as "not a recording key" the moment that joining landed — the
 * probe found that drift the same day it appeared, which is the argument for
 * the probe. The sentinel is deliberately free of characters that percent-
 * encoding would rewrite, so it survives every join path intact.
 */
function probeRecordingResult(parent: string | null, key: string): string | null {
  const probe: Record<string, unknown> = {
    cmiuid: 'recording-key-probe',
    customer_number: '910000000000',
    status: 'answered',
  };
  if (parent) probe[parent] = { [key]: PROBE_VALUE };
  else probe[key] = PROBE_VALUE;
  try {
    const out = mapCdrPayload(probe)?.recordingUrl || '';
    return out.includes(PROBE_VALUE) ? out : null;
  } catch {
    return null;
  }
}

function mapperReadsAsRecording(parent: string | null, key: string): boolean {
  return probeRecordingResult(parent, key) !== null;
}

/**
 * The prefix the mapper pastes in front of a bare filename, read back off a
 * probe rather than imported. Empty when the mapper passes values through
 * untouched. Derived for the same reason the key set is: this is another
 * caller's constant, and a copy of it here would be a second truth that can
 * fall out of step without failing.
 */
function appliedBase(parent: string | null, key: string): string {
  const out = probeRecordingResult(parent, key);
  if (!out) return '';
  const at = out.indexOf(PROBE_VALUE);
  return at > 0 ? out.slice(0, at) : '';
}

/**
 * Type + size + a coarse classification, with NO value. This is what every
 * non-recording field contributes, and it is chosen so it cannot leak: a length
 * and the word "https URL" tell you a field holds a link without telling you
 * what the link is. It is also the tell that finds a field spelling the mapper
 * has never seen — an unknown key holding "string(52) https URL" is the answer.
 */
function shapeOf(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `array(${v.length})`;
  if (typeof v === 'object') return `object(${Object.keys(v as any).length} keys)`;
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return 'number';
  const s = String(v);
  let hint = 'text';
  if (/^https:\/\//i.test(s)) hint = 'https URL';
  else if (/^http:\/\//i.test(s)) hint = 'http URL (not https)';
  else if (/\.(mp3|wav|ogg|m4a|gsm|opus|aac)$/i.test(s)) hint = 'audio filename or path';
  else if (/^\/[^\s]*$/.test(s)) hint = 'path';
  else if (/^[+0-9][0-9\s()-]*$/.test(s)) hint = 'digits';
  else if (s === '') hint = 'empty';
  return `string(${s.length}) ${hint}`;
}

/**
 * Blank out any occurrence of a live credential INSIDE a longer string, leaving
 * the rest legible.
 *
 * Whole-masking would be safer-looking and much less useful: a recording URL
 * that happens to carry the app secret as a query token is still the single
 * most informative thing on this page, and "••••••••7f2a" tells the owner
 * nothing about its shape. Blanking only the credential keeps the diagnosis and
 * still cannot leak. Applied to EVERY string this route echoes, not just field
 * values — the normalized URL is built from those values and would otherwise
 * carry straight through the redaction. (It did, until this was added.)
 */
function redactCreds(s: string, creds: string[]): { text: string; redacted: boolean } {
  let out = s;
  let hit = false;
  for (const c of creds) {
    if (!out.includes(c)) continue;
    hit = true;
    out = out.split(c).join('••••');
  }
  return { text: out, redacted: hit };
}

/** Redact-then-truncate. See the leak note in the file header. */
function echoValue(
  key: string,
  v: unknown,
  creds: string[],
): { value: string; redacted: boolean; truncated: boolean } {
  const s = v === null || v === undefined ? '' : String(v);
  // NAME says credential → the value IS the credential, so mask the lot.
  if (isSecretKey(key) || TELEPHONY_IDENTITY_KEYS.has(bareKey(key))) {
    return { value: maskSecretValue(s), redacted: true, truncated: false };
  }
  // VALUE contains a credential under an innocent name → blank that part only.
  // Short creds are excluded by the caller: a 3-character value would match
  // half the payload and redact everything into uselessness.
  const cleaned = redactCreds(s, creds);
  return cleaned.text.length > VALUE_LIMIT
    ? { value: cleaned.text.slice(0, VALUE_LIMIT), redacted: cleaned.redacted, truncated: true }
    : { value: cleaned.text, redacted: cleaned.redacted, truncated: false };
}

interface FieldReport {
  /** Original spelling as TeleCMI sent it, e.g. filename or data.filename. */
  path: string;
  /** The mapper reads this key as a recording field (asked, not assumed). */
  recording_key: boolean;
  /** This is the value the mapper actually used (first recording key wins). */
  winner: boolean;
  /** Set for recording keys only; redacted and truncated. '' for everything else. */
  value: string;
  redacted: boolean;
  truncated: boolean;
  shape: string;
}

interface CdrReport {
  log_id: string;
  received_at: string;
  telecmi_call_id: string;
  processed: boolean;
  ingest_error: string;
  payload_readable: boolean;
  field_count: number;
  recording_fields: FieldReport[];
  other_fields: { path: string; shape: string }[];
  /** What the mapper turns the payload into — the authoritative answer. */
  normalized_recording_url: string;
  /**
   * What the mapper DID to the raw value, worked out by comparing the two:
   *   none        no recording field, or every one of them empty
   *   passthrough the value was already a URL and was kept as-is
   *   joined      the value was a filename/path, pasted onto applied_base
   *   dropped     there WAS a value and the mapper refused to build a URL
   */
  transform: 'none' | 'passthrough' | 'joined' | 'dropped';
  /** The prefix the mapper pastes in front of a filename. '' when none applies. */
  applied_base: string;
  /** Would the proxy accept it? Uses the proxy's OWN validator, not a copy. */
  validation: { checked: boolean; ok: boolean; error: string; host: string };
  headline: string;
}

function safeMapRecordingUrl(payload: unknown): string {
  if (!isPlainObject(payload)) return '';
  try {
    return mapCdrPayload(payload)?.recordingUrl || '';
  } catch {
    return '';
  }
}

/** Full field-by-field report for ONE ct_webhook_log row. */
function describeCdr(row: any, allow: string[], creds: string[]): CdrReport {
  let payload: unknown = null;
  let payloadReadable = false;
  try {
    payload = JSON.parse(String(row?.payload ?? ''));
    payloadReadable = isPlainObject(payload);
  } catch {
    payloadReadable = false;
  }

  const normalized = safeMapRecordingUrl(payload);

  /**
   * Deep copy of `payload` with ONE field deleted, for the winner probe below.
   * Returns undefined when the path cannot be walked or the payload will not
   * round-trip through JSON — the caller then simply skips that probe rather
   * than guessing, which degrades to "first field with a value".
   */
  function payloadWithoutField(src: unknown, ref: { parent: string | null; key: string }): unknown {
    let clone: any;
    try { clone = JSON.parse(JSON.stringify(src)); } catch { return undefined; }
    let node: any = clone;
    if (ref.parent) {
      for (const seg of ref.parent.split('.')) {
        if (!node || typeof node !== 'object') return undefined;
        node = node[seg];
      }
    }
    if (!node || typeof node !== 'object') return undefined;
    delete node[ref.key];
    return clone;
  }

  const recording: FieldReport[] = [];
  const other: { path: string; shape: string }[] = [];
  // Raw (trimmed) values and their key positions, kept OUT of the response —
  // used only to work out which recording key supplied the value the mapper
  // chose, and what it did to it.
  const rawByIndex: string[] = [];
  const refByIndex: { parent: string | null; key: string }[] = [];

  const visit = (parent: string | null, key: string, value: unknown) => {
    const path = parent ? `${parent}.${key}` : key;
    if (mapperReadsAsRecording(parent, key)) {
      const echoed = echoValue(key, value, creds);
      recording.push({
        path,
        recording_key: true,
        winner: false,
        value: echoed.value,
        redacted: echoed.redacted,
        truncated: echoed.truncated,
        shape: shapeOf(value),
      });
      rawByIndex.push(value === null || value === undefined ? '' : String(value).trim());
      refByIndex.push({ parent, key });
    } else {
      other.push({ path, shape: shapeOf(value) });
    }
  };

  let fieldCount = 0;
  if (isPlainObject(payload)) {
    for (const [k, v] of Object.entries(payload)) {
      fieldCount++;
      visit(null, k, v);
      // One level down, mirroring how a CDR can arrive wrapped in an envelope.
      // Every child is probed AT ITS OWN NESTING, so a recording buried under
      // an object the mapper does not treat as an envelope is listed as an
      // ordinary field — which is the truth: the mapper never reads it. Naming
      // it as "recording present" there would send someone hunting a bug in the
      // player when the value never reached it.
      if (isPlainObject(v)) {
        for (const [ck, cv] of Object.entries(v)) {
          fieldCount++;
          visit(k, ck, cv);
        }
      }
    }
  }

  // WHICH RECORDING FIELD WON — decided by REMOVAL, not by string matching.
  //
  // The previous test asked "is this raw value a substring of the final URL?",
  // walking fields in PAYLOAD order. That answers backwards on precisely the
  // case this panel exists to explain: a CDR carrying BOTH
  //   filename:     'REC-1.mp3'
  //   recordingurl: 'https://rest.telecmi.com/v2/play/REC-1.mp3'
  // The filename is a substring of the URL and usually appears first, so it was
  // flagged the winner and the panel announced "TeleCMI sent a FILENAME, we
  // assembled the URL" — when TeleCMI had sent that URL verbatim. The mapper
  // picks by RECORDING_KEYS PRECEDENCE, which is unrelated to payload order.
  //
  // RECORDING_KEYS is deliberately not exported — this whole file asks the
  // mapper rather than duplicating its key list, so that the two cannot drift.
  // Keeping that property: drop ONE recording field, re-run the mapper, and see
  // whether the answer changes. Under first-key-wins exactly one field can
  // change it, and that field is the winner. If two fields carry the SAME value
  // then neither removal changes anything and "which won" is a distinction
  // without a difference — fall back to the first field with a value.
  let winnerRaw = '';
  if (normalized) {
    let found = -1;
    for (let i = 0; i < recording.length; i++) {
      if (!rawByIndex[i]) continue;
      const probe = payloadWithoutField(payload, refByIndex[i]);
      if (probe !== undefined && safeMapRecordingUrl(probe) !== normalized) { found = i; break; }
    }
    if (found < 0) found = rawByIndex.findIndex(r => r !== '');
    if (found >= 0) {
      recording[found].winner = true;
      winnerRaw = rawByIndex[found];
    }
  }
  const anyValuePresent = rawByIndex.some(r => r !== '');

  // Derived by COMPARISON, not by asking the mapper what it did — there is
  // nothing here that can fall out of step with it.
  let transform: CdrReport['transform'] = 'none';
  if (normalized && winnerRaw && normalized === winnerRaw) transform = 'passthrough';
  else if (normalized) transform = 'joined';
  else if (anyValuePresent) transform = 'dropped';

  // The prefix in front of the filename. Read off the real value when there is
  // one; on a dropped value there is no result to read, so probe the same key
  // to report the base that WOULD have applied — that is usually the answer to
  // why it was dropped.
  let base = '';
  if (transform === 'joined' && winnerRaw) {
    let at = normalized.indexOf(winnerRaw);
    if (at < 0) at = normalized.indexOf(encodeURIComponent(winnerRaw));
    base = at > 0 ? normalized.slice(0, at) : '';
  } else if (transform === 'dropped') {
    const firstWithValue = rawByIndex.findIndex(r => r !== '');
    const ref = firstWithValue >= 0 ? refByIndex[firstWithValue] : null;
    if (ref) base = appliedBase(ref.parent, ref.key);
  }

  // EMIT-TIME REDACTION. `normalized` and `base` stay raw above so validation
  // and the winner match see the real strings; only the copies that leave the
  // server are cleaned. A recording URL can legitimately carry a token in its
  // query string, and if that token happens to be our own app secret it would
  // otherwise walk straight past the per-field redaction into this URL.
  const shownUrl = redactCreds(normalized, creds).text.slice(0, VALUE_LIMIT * 2);
  const shownBase = redactCreds(base, creds).text;

  // Validation through the PROXY'S OWN validator (src/lib/ct/recording-fetch.ts),
  // so the verdict here and the 502 the player would show can never disagree —
  // the error strings below are literally the proxy's error strings.
  let validation = { checked: false, ok: false, error: '', host: '' };
  if (normalized) {
    try {
      const u = assertAllowedRecordingUrl(normalized, allow);
      validation = { checked: true, ok: true, error: '', host: u.hostname };
    } catch (e: any) {
      validation = { checked: true, ok: false, error: String(e?.message || 'invalid'), host: '' };
    }
  }

  let headline: string;
  if (!payloadReadable) {
    headline = 'The stored payload for this delivery is not a readable JSON object, so nothing can be read out of it.';
  } else if (recording.length === 0) {
    headline =
      'This CDR carries NO field the mapper recognises as a recording. Either recording is off on the TeleCMI account, or TeleCMI names the field something the mapper has never seen — check the field names listed beside this.';
  } else if (transform === 'none') {
    headline =
      'A recording field IS present but it is empty, so there is nothing to play. That is the shape of a call that was simply not recorded.';
  } else if (transform === 'dropped') {
    headline = shownBase
      ? `TeleCMI sent a value the mapper refused to turn into a URL, so nothing was stored to play. It is not an http(s) URL and it could not be pasted onto ${shownBase} either.`
      : 'TeleCMI sent a value the mapper refused to turn into a URL, so nothing was stored to play. It is not an http(s) URL and there is no usable recording base to join it onto.';
  } else if (transform === 'joined' && validation.ok) {
    headline =
      `TeleCMI sent a FILENAME, not a URL — the shape the field name always hinted at. The mapper built ${shownBase ? `${shownBase}…` : 'a URL'} from it and the result passes the player's check. That proves the SHAPE, not the destination — run the upstream probe to find out whether TeleCMI actually serves the file from there.`;
  } else if (validation.ok) {
    headline =
      'TeleCMI sent a full HTTPS URL on an allowed host, used unchanged. The player should already work for this call — if it does not, the fault is downstream of the URL.';
  } else if (validation.error === 'Recording URL is invalid') {
    headline =
      'The value the mapper produced is not a parseable URL, so the player refuses it with exactly this message.';
  } else {
    headline = `The player refuses the URL the mapper produced: ${validation.error}.`;
  }

  return {
    log_id: String(row?.id ?? ''),
    received_at: String(row?.received_at ?? ''),
    telecmi_call_id: String(row?.telecmi_call_id ?? ''),
    processed: Number(row?.processed ?? 0) === 1,
    ingest_error: redactCreds(String(row?.error ?? ''), creds).text.slice(0, 300),
    payload_readable: payloadReadable,
    field_count: fieldCount,
    recording_fields: recording,
    other_fields: other,
    normalized_recording_url: shownUrl,
    transform,
    applied_base: shownBase,
    validation,
    headline,
  };
}

/* ── The upstream probe (opt-in: ?probe=1) ─────────────────────────────────
 *
 * WHY IT EXISTS. Everything above this line proves the SHAPE of a recording URL
 * and says so out loud ("this panel proves the shape, not the destination").
 * That honesty was the gap: a URL can be a valid HTTPS link on an allowlisted
 * host, inside retention, and still be a path the vendor does not serve — which
 * is exactly what happened. Every check passed and playback 404ed. The only
 * thing that settles a destination is asking for it, so this does, once, on
 * demand, and reports what came back.
 *
 * IT IS STILL READ-ONLY, and it is bounded so it can never become load on
 * TeleCMI: opt-in via a query flag (the panel never probes on load), at most
 * PROBE_MAX_CALLS calls per request, an 8-second timeout each, and a
 * "Range: bytes=0-0" request so a hit costs one byte rather than a whole
 * recording. Expired calls are NOT fetched at all — the retention gate is
 * reported and honoured here exactly as the proxy honours it.
 */

/** Never more than a couple of upstream requests per click. */
const PROBE_MAX_CALLS = 2;
/** Shorter than the proxy's 15s: a diagnostic must answer, not hang. */
const PROBE_TIMEOUT_MS = 8_000;

interface ProbeReport {
  call_id: string;
  started_at: string;
  /** True when this row is demo/simulator data rather than a real recording. */
  fixture: boolean;
  /** As stored on ct_calls, credential-masked. */
  stored_url: string;
  /** What was actually requested after normalization, credential-masked. */
  fetched_url: string;
  rewritten: boolean;
  rewrite_note: string;
  /** True when the outgoing request carried the TeleCMI appid + secret. */
  credentialed: boolean;
  retention: { expired: boolean; reason: string; days: number; expires_at: string };
  /** False when the retention gate refused before any upstream call. */
  attempted: boolean;
  upstream_status: number | null;
  upstream_content_type: string;
  /** First bytes of a NON-audio answer, verbatim and credential-masked. '' for audio. */
  body_preview: string;
  /** True when the upstream answer is playable audio. This is the whole verdict. */
  is_audio: boolean;
  /** Transport/guard failure (timeout, host not allowed, invalid URL). */
  error: string;
  headline: string;
}

/** Mask credentials in a URL by NAME, not by value match: an appid short enough
 *  to fall under the creds-length floor would otherwise print in the clear. */
function displayUrl(raw: string, creds: string[]): string {
  let shown = String(raw || '');
  try {
    const u = new URL(shown);
    for (const k of ['secret', 'appid', 'token', 'key', 'auth']) {
      if (u.searchParams.has(k)) u.searchParams.set(k, 'REDACTED');
    }
    shown = u.toString();
  } catch { /* not a parseable URL — the text redaction below still applies */ }
  return redactCreds(shown, creds).text.slice(0, VALUE_LIMIT * 2);
}

/** One bounded upstream attempt for one call row. Never throws. */
async function probeCall(db: any, row: any, creds: string[]): Promise<ProbeReport> {
  const storedRaw = String(row?.recording_url || '');
  const retention = recordingRetentionStatus(db, row);
  const base: ProbeReport = {
    call_id: String(row?.id || ''),
    started_at: String(row?.started_at || row?.created_at || ''),
    fixture: Number(row?.fixture || 0) === 1,
    stored_url: displayUrl(storedRaw, creds),
    fetched_url: '',
    rewritten: false,
    rewrite_note: '',
    credentialed: false,
    retention: {
      expired: retention.expired,
      reason: retention.reason,
      days: retention.days,
      expires_at: retention.expiresAt,
    },
    attempted: false,
    upstream_status: null,
    upstream_content_type: '',
    body_preview: '',
    is_audio: false,
    error: '',
    headline: '',
  };

  if (retention.expired) {
    base.headline =
      retention.reason === 'undated'
        ? 'Not fetched: this call has no readable timestamp, so the proxy refuses it (410) before any request goes out. That is the retention rule working, not a playback fault.'
        : `Not fetched: this recording is past the ${retention.days}-day retention window, so the proxy refuses it (410) before any request goes out.`;
    return base;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    base.attempted = true;
    const r = await fetchAllowedRecording(db, storedRaw, {
      // One byte. Enough to learn the verdict, not enough to move audio.
      rangeHeader: 'bytes=0-0',
      signal: controller.signal,
      // The whole point of the probe is to SEE a textual error rather than
      // have it raised as a sentence, so this is the one caller that sets it.
      allowTextualBody: true,
    });
    base.upstream_status = r.status;
    base.upstream_content_type = r.contentType;
    base.fetched_url = displayUrl(r.finalUrl, creds);
    base.rewrite_note = r.rewriteNote;
    base.rewritten = r.finalUrl !== storedRaw;
    base.credentialed = /[?&]secret=/.test(r.finalUrl) && /[?&]appid=/.test(r.finalUrl);
    const audio = /^(?:audio|video)\//i.test(r.contentType);
    const ok = (r.status === 200 || r.status === 206) && audio;
    base.is_audio = ok;
    if (ok) {
      // Cancel the byte we asked for — nothing needs it.
      try { await r.body?.cancel(); } catch { /* already closed */ }
      base.headline = `PLAYS. TeleCMI answered ${r.status} with ${r.contentType} — this recording is reachable and the player will work for it.`;
    } else {
      const preview = await peekRecordingBody(r.body);
      base.body_preview = redactCreds(preview.replace(/\s+/g, ' ').trim(), creds).text.slice(0, VALUE_LIMIT);
      base.headline =
        `DOES NOT PLAY. TeleCMI answered ${r.status} with ${r.contentType || 'no content type'} instead of audio` +
        (base.body_preview ? `: ${base.body_preview}` : '.');
    }
  } catch (e: any) {
    base.error = e?.name === 'AbortError'
      ? `The recording source did not answer within ${Math.round(PROBE_TIMEOUT_MS / 1000)} seconds.`
      : String(e?.message || 'The upstream request failed.');
    base.headline = `DOES NOT PLAY. ${base.error}`;
  } finally {
    clearTimeout(timer);
  }
  return base;
}

export async function GET(req: Request) {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  try {
    const db = getDb();
    const allow = recordingAllowlist(db);

    // Read once, keep server-side. These never enter the response — they exist
    // only so echoValue() can recognise a credential that turns up under an
    // innocent-looking field name. Anything shorter than 6 characters is
    // dropped: a 3-character "credential" would match most of the payload.
    const creds = [telecmiAppId(db), telecmiSecret(db)]
      .map(s => String(s || '').trim())
      .filter(s => s.length >= 6);

    // ── 1 · Is anything arriving? ─────────────────────────────────────────
    const tally = (kind: string) =>
      db.prepare(`
        SELECT COUNT(*) AS n,
               SUM(CASE WHEN processed = 1 THEN 1 ELSE 0 END) AS ok,
               SUM(CASE WHEN COALESCE(error, '') <> '' THEN 1 ELSE 0 END) AS errored,
               MAX(received_at) AS newest
          FROM ct_webhook_log
         WHERE kind = ?
      `).get(kind) as any;

    const cdr = tally('cdr');
    const live = tally('live');
    const cdrCount = Number(cdr?.n || 0);
    const liveCount = Number(live?.n || 0);

    // Presence only, by plain SELECT — see the "must not write" note above on
    // why webhookToken() is not called here.
    const tokenRow = db.prepare(`
      SELECT 1 AS present FROM ct_settings WHERE key = 'webhook_token' AND value <> ''
    `).get() as any;
    const tokenConfigured =
      !!tokenRow?.present || String(process.env.TELECMI_WEBHOOK_SECRET || '').length >= 12;

    let webhookHeadline: string;
    if (cdrCount === 0 && liveCount === 0) {
      webhookHeadline =
        'NO TeleCMI webhook of any kind has ever reached this server. Nothing about recordings can be diagnosed until one does, and no change to the player would ever have helped — the CDR webhook is either not configured in TeleCMI or cannot reach us.';
    } else if (cdrCount === 0) {
      webhookHeadline =
        `NO CDR has ever reached this server, although ${liveCount} live event${liveCount === 1 ? ' has' : 's have'}. Live events arriving while CDRs do not points at the CDR webhook specifically — the URL is missing or wrong in TeleCMI, not the token and not connectivity. Recordings only ever arrive on a CDR, so there is nothing here to play and no code change would have helped.`;
    } else {
      webhookHeadline = `${cdrCount} CDR deliver${cdrCount === 1 ? 'y has' : 'ies have'} been logged; the newest arrived at ${String(cdr?.newest || '')}.`;
    }

    // ── 2 · The most recent CDR, field by field ───────────────────────────
    const latestRow = cdrCount
      ? db.prepare(`
          SELECT id, received_at, telecmi_call_id, processed, error, payload
            FROM ct_webhook_log
           WHERE kind = 'cdr'
           ORDER BY received_at DESC, rowid DESC
           LIMIT 1
        `).get() as any
      : null;
    const latest = latestRow ? describeCdr(latestRow, allow, creds) : null;

    // ── 3 · The newest CDR that actually carries a recording ──────────────
    // The newest CDR overall is very often a missed call, which carries no
    // recording by definition. Reading that one row as "TeleCMI never sends a
    // recording" is the wrong conclusion this scan exists to prevent.
    let scanned = 0;
    let withValue = 0;
    let sample: CdrReport | null = null;
    if (cdrCount) {
      const rows = db.prepare(`
        SELECT id, received_at, telecmi_call_id, processed, error, payload
          FROM ct_webhook_log
         WHERE kind = 'cdr'
         ORDER BY received_at DESC, rowid DESC
         LIMIT ?
      `).all(SCAN_LIMIT) as any[];
      for (const r of rows) {
        scanned++;
        let parsed: unknown = null;
        try { parsed = JSON.parse(String(r?.payload ?? '')); } catch { parsed = null; }
        if (!safeMapRecordingUrl(parsed)) continue;
        withValue++;
        // Describe only the first (newest) hit — the per-field probing is the
        // expensive part and one worked example is what answers the question.
        if (!sample) sample = describeCdr(r, allow, creds);
      }
    }
    const sampleIsLatest = !!(sample && latest && sample.log_id === latest.log_id);

    // ── 4 · What is actually stored on ct_calls ───────────────────────────
    // Fixture detection is two-sided on purpose. The demo seeder stamps BOTH a
    // telecmi_call_id of seed-<tag>-<n> and a recording_url ending /play/seed-...,
    // and scripts/simulate-call.ts writes a play?file=sim-... URL. Matching any
    // of the three keeps a hand-edited row from being counted as real.
    const stored = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN COALESCE(recording_url, '') <> '' THEN 1 ELSE 0 END) AS with_url,
             SUM(CASE WHEN COALESCE(recording_url, '') <> ''
                       AND (recording_url LIKE '%/play/seed-%'
                            OR recording_url LIKE '%file=sim-%'
                            OR COALESCE(telecmi_call_id, '') LIKE 'seed-%')
                      THEN 1 ELSE 0 END) AS fixtures
        FROM ct_calls
    `).get() as any;
    const withUrl = Number(stored?.with_url || 0);
    const fixtures = Number(stored?.fixtures || 0);
    const real = Math.max(0, withUrl - fixtures);

    let storedHeadline: string;
    if (withUrl === 0) {
      storedHeadline = 'No call in the log holds a recording URL at all.';
    } else if (real === 0) {
      storedHeadline = `All ${withUrl} recording URL${withUrl === 1 ? '' : 's'} in the call log are demo fixtures. Not one real recording has ever been stored, so anything that appears to play here is seed data.`;
    } else {
      storedHeadline = `${real} real recording URL${real === 1 ? '' : 's'} stored (plus ${fixtures} demo fixture${fixtures === 1 ? '' : 's'}).`;
    }

    // ── 5 · Upstream probe (opt-in) ───────────────────────────────────────
    // Off unless asked for, so opening the Telephony page never touches
    // TeleCMI. See the block comment above probeCall() for the bounds.
    let probe: {
      ran: boolean;
      limit: number;
      candidates: number;
      calls: ProbeReport[];
      headline: string;
    } | null = null;
    if (new URL(req.url).searchParams.get('probe') === '1') {
      // Real recordings first, newest first — a fixture answers the endpoint
      // question too, but only a real row answers the owner's question.
      const candidates = db.prepare(`
        SELECT id, recording_url, started_at, created_at,
               CASE WHEN recording_url LIKE '%/play/seed-%'
                      OR recording_url LIKE '%file=sim-%'
                      OR COALESCE(telecmi_call_id, '') LIKE 'seed-%'
                    THEN 1 ELSE 0 END AS fixture
          FROM ct_calls
         WHERE COALESCE(recording_url, '') <> ''
         ORDER BY fixture ASC, COALESCE(NULLIF(started_at, ''), created_at) DESC
         LIMIT ?
      `).all(PROBE_MAX_CALLS) as any[];

      const reports: ProbeReport[] = [];
      for (const row of candidates) reports.push(await probeCall(db, row, creds));

      let headline: string;
      if (reports.length === 0) {
        headline = 'No call in the log holds a recording URL, so there is nothing to probe. Nothing can be said about playback until a CDR carrying a recording arrives.';
      } else if (reports.some(r => r.is_audio)) {
        headline = 'TeleCMI served audio for at least one stored recording, so the fetch chain works end to end. A recording that still will not play is a fault on that specific call, not on the URL we build.';
      } else if (reports.every(r => r.retention.expired)) {
        headline = 'Every recording old enough to probe is past the retention window, so none was fetched. That is the privacy rule working — widen the window above to test playback.';
      } else if (reports.some(r => r.attempted && !r.credentialed)) {
        headline = 'TeleCMI refused every attempt and the requests went out WITHOUT credentials — set the TeleCMI App ID and secret in CRM settings, then probe again.';
      } else if (reports.every(r => r.fixture)) {
        headline = 'Only demo fixtures were available to probe, so this reports what TeleCMI says about a made-up filename — useful for the endpoint and the credentials, not for a real recording.';
      } else {
        headline = 'TeleCMI did not serve audio for any stored recording. The per-call answer below is the vendor’s own — that is the cause, and it is upstream of the player.';
      }

      probe = {
        ran: true,
        limit: PROBE_MAX_CALLS,
        candidates: candidates.length,
        calls: reports,
        headline,
      };
    }

    return Response.json({
      generated_at: new Date().toISOString(),
      probe,
      webhooks: {
        cdr_count: cdrCount,
        cdr_newest_at: String(cdr?.newest || ''),
        cdr_processed: Number(cdr?.ok || 0),
        cdr_errored: Number(cdr?.errored || 0),
        live_count: liveCount,
        live_newest_at: String(live?.newest || ''),
        token_configured: tokenConfigured,
        headline: webhookHeadline,
      },
      latest_cdr: latest,
      recording_scan: {
        limit: SCAN_LIMIT,
        scanned,
        with_recording_value: withValue,
        sample,
        sample_is_latest: sampleIsLatest,
      },
      // Printed so a "host not allowed" verdict is self-explanatory instead of
      // sending the reader off to find which hosts are allowed.
      allowlist: allow,
      stored: {
        calls_total: Number(stored?.total || 0),
        with_recording_url: withUrl,
        fixture_recordings: fixtures,
        real_recordings: real,
        headline: storedHeadline,
      },
    });
  } catch (e: any) {
    // 200 with an error string, same contract as the other telephony panels: a
    // 500 renders as a broken widget, and the one thing a diagnostic must never
    // do is fail silently about why it cannot diagnose.
    return Response.json({
      generated_at: new Date().toISOString(),
      error: String(e?.message || 'Recording diagnostic failed'),
    });
  }
}
