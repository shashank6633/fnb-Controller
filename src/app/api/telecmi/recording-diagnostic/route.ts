/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { mapCdrPayload, mapLivePayload } from '@/lib/ct/telecmi-mapper';
import {
  assertAllowedRecordingUrl,
  fetchAllowedRecording,
  hostAllowed,
  peekRecordingBody,
  recordingAllowlist,
  recordingTarget,
} from '@/lib/ct/recording-fetch';
import { recordingRetentionStatus } from '@/lib/ct/retention';
import { isSecretKey, maskSecretValue } from '@/lib/secret-keys';
import {
  RECORDING_BASE_URL_DEFAULT,
  ctRecordingBaseUrl,
  telecmiAppId,
  telecmiCredentialStatus,
  telecmiSecret,
} from '@/lib/ct/settings';

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
 *   credentials Whether a TeleCMI App ID and app secret are configured at all,
 *              and where each comes from — an environment variable or a stored
 *              row — plus whether an environment variable is SHADOWING a value
 *              somebody saved in Settings. Nothing can play without these, so
 *              this is reported on every load, before any probing. BOOLEANS AND
 *              A SOURCE ONLY: no value, not even a masked tail. (The Settings
 *              screen shows a short fingerprint so an admin can tell which
 *              secret is stored; a diagnostic page that gets screenshotted has
 *              no business repeating even that much.)
 *   recording_base
 *              Which base a bare CDR filename is joined onto, and whether it
 *              is the shipped default or a stored ct_settings row overriding
 *              it. Called out because a stored row silently beats the default:
 *              a deployment still carrying the old dead /v2/play/<file> form
 *              behaves as broken as before any fix, on identical code.
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
 *   live_agent WHO ANSWERED, on the LIVE events — see the block below.
 *   live_ring  WHO IT IS RINGING, on the LIVE ring events. The same evidence
 *              method pointed at the payload the answer panel has never read —
 *              see the block comment above describeLiveRing().
 *   probe      OPT-IN (?probe=1), and the only part that leaves this server:
 *              it actually ASKS TeleCMI for a REAL stored recording and reports
 *              which one of a fixed set of outcomes happened — no credentials,
 *              credentials refused, credentials accepted but no audio for that
 *              file, audio (it plays), or the transport failed. Everything else
 *              here proves the URL's SHAPE; a URL can be perfectly shaped and
 *              still be a path the vendor does not serve, which is precisely
 *              the failure this module hit. Bounded — see the comment above
 *              probeCall().
 *
 * ── WHO ANSWERED, ON THE LIVE EVENTS (the live_agent panel) ────────────────
 * A second question lands on the same table, and it is answered the same way:
 * FROM THE CAPTURED PAYLOADS, not from a guess.
 *
 * The screen-pop shows "Answered by X" only when the live 'answered' event named
 * an agent it could resolve. On this account it often names nobody, so the card
 * reads "ON CALL 0:33" with no name for the whole conversation — and the CDR,
 * which does name the agent, arrives after the hangup and is therefore too late
 * to be any use to the person on the phone.
 *
 * THERE ARE TWO COMPLETELY DIFFERENT CAUSES and they need opposite fixes:
 *   (a) TeleCMI sends the answerer under a key the mapper has never heard of.
 *       AGENT_KEYS in src/lib/ct/telecmi-mapper.ts gains one spelling and the
 *       whole thing starts working, retroactively, for free.
 *   (b) TeleCMI's live answer event genuinely carries no agent at all. Then no
 *       key list will ever help and the answer has to come from somewhere else.
 * Nobody can tell those apart by reading code. This panel settles it by printing
 * the ACTUAL KEYS of the last LIVE_AGENT_LIMIT answered live payloads, the values
 * of the agent-shaped ones, and — asked of the mapper itself, never assumed —
 * whether the mapper reads each of them as the agent.
 *
 * Bounded and read-only like everything else here: one indexed SELECT with a
 * LIMIT, and the key probes are pure calls into the mapper with a synthetic
 * payload. It touches no network and nothing outside ct_webhook_log.
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
 * THE CREDENTIALS THEMSELVES NEVER APPEAR IN ANY FORM. They are read into
 * `creds` purely so redactCreds() can recognise them inside other strings, and
 * the credentials block emits booleans plus the word 'env' / 'db' / 'none' —
 * no value, no masked tail. The probe's `error` strings are redacted for the
 * same reason: a transport error is thrown while a URL carrying appid + secret
 * is in hand, and a fetch implementation that puts the request URL in the
 * message would otherwise walk one straight out of here.
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

/* ── WHO ANSWERED: the live-event agent-key evidence ───────────────────────
 *
 * See "WHO ANSWERED, ON THE LIVE EVENTS" in the file header for why this exists.
 * Everything below is SELECT + pure mapper calls; nothing here leaves the box.
 */

/** How many recent ANSWERED live deliveries the panel reports on. */
const LIVE_AGENT_LIMIT = 20;

/**
 * Sentinel for mapperReadsAsAgent(), spelled on the same two principles as
 * PROBE_VALUE above: it contains "answered" so a probe key that lands on the
 * EVENT field still classifies as an answer instead of logging an
 * "unknown live event" warning, and it reads as what it is so anyone who does
 * see it in a log knows it came from this diagnostic and is not a real payload.
 */
const LIVE_AGENT_PROBE = 'answered-agent-key-probe';

/**
 * Does the MAPPER read THIS key, at THIS nesting, as the answering agent?
 *
 * Asked of the mapper, exactly as mapperReadsAsRecording() asks about recording
 * keys and for exactly the same reason: AGENT_KEYS is not exported from
 * src/lib/ct/telecmi-mapper.ts, and a copy of that list here would be a second
 * truth that falls out of step without ever failing — this panel would then say
 * "the mapper does not read this key" about a key somebody had just added to it,
 * which is precisely the sentence an admin would act on.
 *
 * The scaffold fields exist only to get past mapLivePayload's "no id AND no
 * phone" rejection quietly; `status: 'answered'` keeps the event classification
 * silent. An agent-shaped key cannot collide with any of them.
 *
 * CONTAINS, NOT EQUALS — the mapper trims what it reads, and a future normaliser
 * could do more, so an equality test would start answering "no" about keys that
 * work perfectly well.
 */
function mapperReadsAsAgent(parent: string | null, key: string): boolean {
  const probe: Record<string, unknown> = {
    cmiuid: 'agent-key-probe',
    customer_number: '910000000000',
    status: 'answered',
  };
  if (parent) probe[parent] = { [key]: LIVE_AGENT_PROBE };
  else probe[key] = LIVE_AGENT_PROBE;
  try {
    return String(mapLivePayload(probe)?.agent || '').includes(LIVE_AGENT_PROBE);
  } catch {
    return false;
  }
}

/**
 * Is this field name one whose VALUE the panel prints?
 *
 * Two families, and nothing else on the payload gets a value at all (every other
 * field contributes a name and a shape, the same rule the CDR panel follows):
 *   agent-like  agent / user / ext — the candidates for "who picked up". Their
 *               values ARE the evidence: seeing `ans_by: "5002"` beside
 *               "the mapper read no agent" is the whole point of the panel.
 *   event-like  event / status / state — so the reader can see the vendor's own
 *               word for the event next to the mapper's classification of it.
 * An extension number is not a credential; anything that IS one is masked by
 * echoValue() on its name, exactly as everywhere else on this route.
 *
 * IT IS A NAME TEST, NOT A CLAIM ABOUT WHAT IS THERE. A key TeleCMI spells
 * ans_by or handled_by matches neither family and so shows only its NAME AND
 * SHAPE, like every other field — which is still the answer ("string(4) digits"
 * next to a plausible name is an extension), and the headlines are written to
 * send the reader to that list rather than to conclude past it. Widening these
 * fragments to guess at more spellings would trade that honesty for printing
 * more values, which is the wrong direction on a page that gets screenshotted.
 */
function isAgentLikeKey(key: string): boolean {
  const b = bareKey(key);
  return b.includes('agent') || b.includes('user') || b.includes('ext');
}
function isEventLikeKey(key: string): boolean {
  const b = bareKey(key);
  return b.includes('event') || b.includes('status') || b.includes('state');
}

interface LiveAgentField {
  /** Original spelling as TeleCMI sent it, e.g. agent or data.agent. */
  path: string;
  shape: string;
  /** Name marks it as a candidate for "who answered". */
  agent_like: boolean;
  /** Set for agent-like and event-like names only; redacted and truncated. */
  value: string;
  redacted: boolean;
  truncated: boolean;
  /** Asked of the mapper, not assumed. False for non-agent-shaped names. */
  mapper_reads_as_agent: boolean;
}

interface LiveAnswerReport {
  log_id: string;
  received_at: string;
  telecmi_call_id: string;
  /** ct_webhook_log.event — the mapper's classification AT INGEST TIME. */
  event_at_ingest: string;
  /** The same payload re-run through today's mapper. A difference is drift. */
  event_now: string;
  payload_readable: boolean;
  /** Every top-level key name, verbatim. The list IS the answer when the mapper
   *  reads no agent: one of these is what TeleCMI calls the answerer, or none is. */
  top_level_keys: string[];
  /** What the mapper actually extracts as the agent. '' is the finding. */
  mapper_agent: string;
  fields: LiveAgentField[];
  headline: string;
}

/** Field-by-field agent report for ONE live-answer ct_webhook_log row. */
function describeLiveAnswer(row: any, creds: string[]): LiveAnswerReport {
  let payload: unknown = null;
  let payloadReadable = false;
  try {
    payload = JSON.parse(String(row?.payload ?? ''));
    payloadReadable = isPlainObject(payload);
  } catch {
    payloadReadable = false;
  }

  let mapped: ReturnType<typeof mapLivePayload> = null;
  try {
    mapped = isPlainObject(payload) ? mapLivePayload(payload) : null;
  } catch {
    mapped = null;
  }

  const fields: LiveAgentField[] = [];
  const topKeys: string[] = [];
  const visit = (parent: string | null, key: string, value: unknown) => {
    const agentLike = isAgentLikeKey(key);
    const echoed = agentLike || isEventLikeKey(key) ? echoValue(key, value, creds) : null;
    fields.push({
      path: parent ? `${parent}.${key}` : key,
      shape: shapeOf(value),
      agent_like: agentLike,
      value: echoed?.value ?? '',
      redacted: echoed?.redacted ?? false,
      truncated: echoed?.truncated ?? false,
      mapper_reads_as_agent: agentLike ? mapperReadsAsAgent(parent, key) : false,
    });
  };
  if (isPlainObject(payload)) {
    for (const [k, v] of Object.entries(payload)) {
      topKeys.push(k);
      visit(null, k, v);
      // One level down, mirroring how a live event can arrive wrapped in an
      // envelope — and probed AT ITS OWN NESTING, so a key the mapper would only
      // find at the top level is not reported as readable where it is buried.
      if (isPlainObject(v)) for (const [ck, cv] of Object.entries(v)) visit(k, ck, cv);
    }
  }

  const agentRaw = String(mapped?.agent || '');
  const agentEcho = echoValue('agent', agentRaw, creds);
  const namedCandidates = fields
    .filter(f => f.agent_like && !f.mapper_reads_as_agent && f.value)
    .map(f => f.path);

  let headline: string;
  if (!payloadReadable) {
    headline = 'The stored payload for this delivery is not a readable JSON object, so nothing can be read out of it.';
  } else if (agentRaw) {
    headline =
      `The mapper DOES read an agent off this payload: "${agentEcho.value}". A screen-pop that showed no name for this call did not lose it here — either that id is unmapped in Agent mapping (it would then display as the raw id, not as a blank), or the pop never received this event.`;
  } else if (namedCandidates.length) {
    headline =
      `The mapper read NO agent, but this payload DOES carry agent-shaped field${namedCandidates.length === 1 ? '' : 's'} with a value: ${namedCandidates.join(', ')}. If one of those names the answerer, add its spelling to AGENT_KEYS in src/lib/ct/telecmi-mapper.ts and every future answered event names a person. Nothing else needs changing.`;
  } else {
    // DELIBERATELY NOT "so no key list would help". A field named nothing like
    // agent/user/ext — ans_by, handled_by, a bare extension column — can still
    // be the answerer, and only a human reading the real key names can say. So
    // this points AT the list rather than concluding past it. Every key there
    // carries its shape, and "string(4) digits" beside a name is usually enough
    // to recognise an extension without the value ever being printed.
    headline =
      'The mapper read no agent, and no field whose NAME looks like an agent/user/extension carries a value. Read the key list beside this: if one of those keys is TeleCMI’s own word for the answerer under some other spelling, adding it to AGENT_KEYS in src/lib/ct/telecmi-mapper.ts is the fix. If none of them is, this live answer genuinely does not say who picked up and the CDR (after the call) is the only source of the name.';
  }

  return {
    log_id: String(row?.id ?? ''),
    received_at: String(row?.received_at ?? ''),
    telecmi_call_id: String(row?.telecmi_call_id ?? ''),
    event_at_ingest: String(row?.event ?? ''),
    event_now: String(mapped?.event || ''),
    payload_readable: payloadReadable,
    top_level_keys: topKeys,
    mapper_agent: agentEcho.value,
    fields,
    headline,
  };
}

/* ── RINGING — FOR WHOM: the live-RING agent evidence ──────────────────────
 *
 * ── THE QUESTION ──────────────────────────────────────────────────────────
 * "Didn't Pickup is showing correctly after a call has not been answered by a
 * GRE, but I need FOR WHOM it is ringing as well, which makes better analysis.
 * The agents are already mapped."
 *
 * ── WHAT IS ALREADY SETTLED, SO NOBODY RE-LITIGATES IT HERE ───────────────
 *   · "Pushpa did not pick up" WORKS. That name comes from the PER-LEG MISSED
 *     CDR, resolved through the owner's agent mapping. THE MAPPING IS HEALTHY;
 *     it is not the blocker and this panel says nothing about it.
 *   · "Ringing — for whom" renders "Extension not reported" because the LIVE
 *     RING payload yields no agent: pickAgent() (src/lib/ct/telecmi-mapper.ts)
 *     finds no scalar under any AGENT_KEYS spelling and no agent/user object,
 *     so the name is simply absent and the UI falls back to the ring group.
 *   · There is ONE "incoming call ringing" live event for the whole call, then
 *     missed CDRs as the hunt group hands the call on. So there is no per-leg
 *     RING event to read either.
 *
 * ── WHY WE DID NOT JUST ADD A SPELLING TO AGENT_KEYS ──────────────────────
 * pickAgent() IS EVENT-BLIND. The same function answers for ring, for answer
 * and for the CDR, and its result also drives ownerCandidate(). A speculative
 * spelling added to AGENT_KEYS on a guess would therefore not merely improve a
 * ring label — it would become agentName on ANSWERED calls too and could
 * silently MIS-ATTRIBUTE WHO PICKED UP. That is a worse bug than the missing
 * label, and it is unacceptable. A spelling may only be added ON EVIDENCE.
 *
 * ── SO THIS PANEL PRODUCES THE EVIDENCE ───────────────────────────────────
 * Every live webhook body is stored verbatim in ct_webhook_log (kind='live',
 * event = the mapper's own classification, written by ingestLive()). The ring
 * payloads from this account are already sitting there. The live_agent panel
 * above does a field-by-field report over the ANSWER rows; it has never looked
 * at a RING row, and that blind spot is the entire reason the question is open.
 *
 * This panel reports, over the recent RING rows:
 *   1 HOW MANY were examined and over WHAT PERIOD — and when there are none it
 *     says so in words, because an empty panel reads as "the payload has no
 *     fields", and absence of data is not evidence of absence.
 *   2 THE FIELD NAMES each ring carries, top level AND one level down, each
 *     nested one prefixed (data.agent_no) so the reader can see where it lives.
 *     A field cannot be missed here merely because it arrived wrapped.
 *   3 FOR EACH FIELD whether AGENT_KEYS already matches it, whether QUEUE_KEYS
 *     matches it, and — the point of the exercise — a ranked UNMATCHED
 *     CANDIDATES list: fields we do NOT read whose VALUE is shaped like an
 *     extension or an agent identity, each with the reason it qualified.
 *   4 WHAT THE MAPPER ACTUALLY EXTRACTED from that same payload (agent, queue,
 *     event, direction), so the gap between "the payload holds this" and "we
 *     read that" is visible on one line.
 *
 * READ THE RESULT LIKE THIS. A ranked candidate is a LEAD, not a verdict: it
 * says a field we ignore holds something extension-shaped, not that the field
 * means "the phone that is ringing". Whoever acts on it still has to check that
 * the same key on an ANSWER payload names the answerer, because of the
 * event-blindness above. If the shortlist comes back EMPTY across a decent
 * number of rings, that is the answer too, and the honest thing then is to stop
 * promising a name and let the ring GROUP stand as the best available answer.
 *
 * ── SAFETY: THIS ECHOES A RAW PROVIDER PAYLOAD ────────────────────────────
 * A ring payload carries the GUEST'S PHONE NUMBER. Field names are MOSTLY safe
 * to print and values are not, so:
 *   · field NAMES go through safeName() — credentials blanked and 6+ digit runs
 *     masked, and nothing more. "Names are safe" holds for a record and fails
 *     for a MAP: `legs: { "919876543210": {…} }` puts the guest's number in the
 *     Field-name column and inside the parent's key list, and neither of those
 *     is a value, so neither was covered by any rule below.
 *   · credentials — the SAME scheme as the answer panel, echoValue() plus
 *     redactCreds(). No second scheme is invented here.
 *   · phone numbers and anything else long and numeric — every run of 6 or more
 *     digits in ANY echoed value is replaced by '#' of the same length by
 *     maskLongDigits(). A 10-digit guest number prints as ##########, which is
 *     its shape and nothing else, while a 3- or 4-digit extension — the thing
 *     we are hunting — survives intact. Six is the floor because no Indian
 *     mobile or STD landline is that short and no SIP extension on this account
 *     is that long.
 *   · caller-side fields (caller / from / cli / ani / cnam / customer …) print
 *     NO value at all, only a name and a shape. A caller-name field is guest
 *     identity, it is not going to be the answering agent, and it is not worth
 *     the risk. They are counted so their absence from the shortlist is stated
 *     rather than silent.
 *   · a value shaped like a PERSON'S NAME or an EMAIL prints only where the
 *     field NAME attributes it to staff or to a ring group (isAttributedKey).
 *     The caller-side list can only name the guest spellings somebody thought
 *     of, and the premise here is that the spellings are unknown — `party`,
 *     `whatsapp`, `subscriber`, `a_party` and a bare `email` all walked past it.
 *     Inverting the test closes that by construction; the field is still listed
 *     and still shortlisted, so what is withheld is the person, not the finding.
 *   · a value that turns out to contain one of THIS account's credentials is
 *     masked by the scheme above AND dropped from the shortlist — we know what
 *     that field holds and it is not an agent.
 *   · everything else prints only when it is a MATCHED key or a CANDIDATE, and
 *     any other field contributes a name and a shape, exactly as the CDR and
 *     answer panels already do.
 *
 * Bounded and read-only like everything else on this route: one indexed SELECT
 * with a LIMIT, one small GROUP BY, and pure calls into the mapper with
 * synthetic payloads. No network, no writes, nothing outside ct_webhook_log.
 */

/** How many recent RING deliveries the panel reports on. */
const LIVE_RING_LIMIT = 20;

/**
 * Sentinel for mapperReadsAsQueue() and mapperFlattensEnvelope().
 *
 * It reads as what it is, for the same reason PROBE_VALUE does: if a probe key
 * happens to land on the payload's EVENT field the mapper logs one
 * "unknown live event" warning, and whoever reads that log line must be able to
 * see instantly that it came from this diagnostic rather than from a real
 * malformed payload. (pickLiveEvent() matches its vocabularies EXACTLY, not by
 * substring, so no spelling of a sentinel can suppress that warning on the live
 * path — it can only be made recognisable.)
 */
const LIVE_RING_PROBE = 'ringing-key-probe';

/**
 * Does the MAPPER read THIS key, at THIS nesting, as the QUEUE (the ring group)?
 *
 * Asked of the mapper for the same reason mapperReadsAsAgent() asks about agent
 * keys: QUEUE_KEYS is not exported from src/lib/ct/telecmi-mapper.ts, and a copy
 * of it here would be a second truth that drifts silently. It matters on this
 * panel specifically because the ring group IS the fallback answer — a field
 * reported as "unread" that the mapper is in fact already reading as the queue
 * would send someone to add a spelling that changes nothing.
 */
function mapperReadsAsQueue(parent: string | null, key: string): boolean {
  const probe: Record<string, unknown> = {
    cmiuid: 'queue-key-probe',
    customer_number: '910000000000',
    status: 'ringing',
  };
  if (parent) probe[parent] = { [key]: LIVE_RING_PROBE };
  else probe[key] = LIVE_RING_PROBE;
  try {
    return String(mapLivePayload(probe)?.queue || '').includes(LIVE_RING_PROBE);
  } catch {
    return false;
  }
}

/**
 * Does the MAPPER read THIS key, at THIS nesting, as the CALL ID?
 *
 * Not printed as a finding — used to keep the shortlist honest. TeleCMI's own
 * call id can be a short token, and a short token is exactly what an extension
 * looks like, so without this the id would rank as the strongest "unread agent
 * field" on every single ring. It is not unread and it is not an agent.
 *
 * Note there is deliberately NO cmiuid scaffold in this probe: the sentinel has
 * to be the only id candidate in the payload for the test to mean anything. The
 * phone keeps mapLivePayload from rejecting it.
 */
function mapperReadsAsCallId(parent: string | null, key: string): boolean {
  const probe: Record<string, unknown> = { customer_number: '910000000000', status: 'ringing' };
  if (parent) probe[parent] = { [key]: LIVE_RING_PROBE };
  else probe[key] = LIVE_RING_PROBE;
  try {
    return String(mapLivePayload(probe)?.telecmiCallId || '') === LIVE_RING_PROBE;
  } catch {
    return false;
  }
}

/**
 * Does the mapper's collect() FLATTEN this envelope — i.e. can any key nested
 * under `parent` be reached by the mapper at all?
 *
 * WHY THIS IS ASKED AND NOT LISTED: collect() descends into a fixed set of
 * wrapper names (data / cdr / call / payload / body / record) and that list is
 * private to the mapper. Copying it here would drift. So instead: put a key the
 * mapper unquestionably reads — the call id — INSIDE the envelope, and see
 * whether the mapper comes back with it. If it does, the mapper descends into
 * that wrapper; if it does not, nothing nested there is reachable no matter what
 * spelling is added to AGENT_KEYS, and this panel must say so instead of
 * offering a lead that could never work.
 *
 * The top-level scaffold exists only to get past mapLivePayload's "no id AND no
 * phone" rejection quietly, and is skipped if the envelope name collides with it.
 */
const LIVE_RING_ENVELOPE_PROBE = 'ringing-envelope-probe';
function mapperFlattensEnvelope(parent: string): boolean {
  const probe: Record<string, unknown> = { [parent]: { cmiuid: LIVE_RING_ENVELOPE_PROBE } };
  if (parent !== 'customer_number') probe.customer_number = '910000000000';
  if (parent !== 'status') probe.status = 'ringing';
  try {
    return String(mapLivePayload(probe)?.telecmiCallId || '') === LIVE_RING_ENVELOPE_PROBE;
  } catch {
    return false;
  }
}

/**
 * Field names whose VALUE is never printed on this panel because it describes
 * the CALLER, not the answerer. See the safety block in the header: a caller
 * name or number is guest identity and is not a lead worth any risk.
 *
 * SOFT list. Applied only when the name carries no agent hint, so `agent_number`
 * and `agent_phone` — which contain "number"/"phone" and are exactly the sort of
 * spelling this panel exists to find — are NOT swallowed by it.
 *
 * `name` is on it because it has to be: cnam / caller_name / contact_name were
 * withheld while a bare `name`, `display_name` or `party_name` holding the very
 * same guest printed in full. Three spellings protected and two not is not a
 * rule, it is an accident. Staff-side spellings keep printing through the agent
 * hint (agent_name, member_name, callee_name), and routing containers through
 * ROUTING_NAME_HINTS below.
 */
const CALLER_SIDE_HINTS = [
  'caller', 'from', 'cli', 'ani', 'cnam', 'customer', 'guest', 'contact',
  'msisdn', 'mobile', 'phone', 'number', 'name', 'did', 'dnis', 'virtual', 'source', 'src',
];

/**
 * Guest markers that BEAT an agent hint instead of yielding to it.
 *
 * `isAgentLikeKey` matches the bare substrings agent / user / ext, so a field
 * spelled `guest_user_name` or `customer_ext` carried an "agent hint", escaped
 * the caller-side rule, and printed. Where a name says guest THIS plainly, the
 * guest reading wins and no agent fragment inside it changes that.
 *
 * Kept to four unambiguous words on purpose. Every other caller-side hint stays
 * soft, because `agent_number` / `agent_phone` must keep printing.
 */
const GUEST_ABSOLUTE_HINTS = ['caller', 'cnam', 'customer', 'guest'];

/**
 * Routing containers — a ring GROUP is not a person and is the panel's own
 * fallback answer, so `queue_name` / `group_name` must not disappear behind the
 * `name` entry added to CALLER_SIDE_HINTS above.
 */
const ROUTING_NAME_HINTS = ['queue', 'group', 'team', 'dept', 'hunt', 'skill'];
function isRoutingNameKey(key: string): boolean {
  const b = bareKey(key);
  return ROUTING_NAME_HINTS.some(h => b.includes(h));
}

/**
 * Field names whose value is a secret even though SECRET_KEY_RE does not say so.
 *
 * SEGMENT-ANCHORED, not substring: bare `pin` matches "mapping" and bare `pass`
 * matches "bypass". Anchoring on a non-letter boundary makes agent_pin, sip_key,
 * otp and x-passcode match while ordinary words do not.
 *
 * This is a ring-panel-local widening and deliberately NOT an edit to
 * TELEPHONY_IDENTITY_KEYS: that Set is read by the CDR and answer panels too,
 * and this change has no business altering what they print. secret-keys.ts
 * remains the single rule for settings keys — see its own header.
 */
const RING_SECRET_RE = /(^|[^a-z])(pin|otp|pass|passcode|password|key|secret|token|credential)([^a-z]|$)/i;
function isRingSecretName(key: string): boolean {
  return RING_SECRET_RE.test(String(key)) || isSecretKey(key) || TELEPHONY_IDENTITY_KEYS.has(bareKey(key));
}

/**
 * Name fragments that make a field a plausible "who is this ringing" field even
 * though AGENT_KEYS does not match it. Reuses isAgentLikeKey() (agent / user /
 * ext, the answer panel's test) and widens it with the vocabulary other PBXs and
 * TeleCMI's own click-to-call use.
 *
 * THIS IS A DISPLAY HEURISTIC, NOT A CLAIM. It only decides ranking and whether
 * a value is printed; it never decides what the mapper reads (that is always
 * asked of the mapper). Being incomplete costs a rank, not a truth — a field
 * with no hint at all is still listed, and still becomes a candidate on the
 * strength of its VALUE alone.
 */
const RING_AGENT_HINTS = [
  'member', 'staff', 'employee', 'emp', 'operator', 'answer', 'ansby', 'pick',
  'handle', 'assign', 'peer', 'endpoint', 'device', 'sip', 'desk', 'callee',
  'attendant', 'executive', 'telecaller', 'ringto', 'destuser', 'follow',
];
function hasAgentNameHint(key: string): boolean {
  const b = bareKey(key);
  return isAgentLikeKey(key) || RING_AGENT_HINTS.some(h => b.includes(h));
}
function isCallerSideKey(key: string): boolean {
  const b = bareKey(key);
  // A plain guest word beats everything, including an agent fragment sitting
  // inside it (guest_user_name, customer_ext).
  if (GUEST_ABSOLUTE_HINTS.some(h => b.includes(h))) return true;
  if (hasAgentNameHint(key) || isRoutingNameKey(key)) return false;
  return CALLER_SIDE_HINTS.some(h => b.includes(h));
}

/**
 * Does the field's NAME attribute it to STAFF or to ROUTING?
 *
 * The question the caller-side denylist cannot answer. That list can only name
 * the guest spellings somebody thought of, and the whole premise of this panel
 * is that the payload's spellings are UNKNOWN — so `party`, `whatsapp`,
 * `subscriber`, `originator`, `a_party` and a bare `email` all sailed past it
 * and printed "Ravi Kumar" / "ravi.kumar@gmail.com" in full.
 *
 * Inverting the test closes that by construction: an identity-shaped VALUE is
 * printed only where the NAME says the field belongs to an agent or to a ring
 * group, and everywhere else the shape and the field name are reported without
 * the value. A guest field cannot escape by being spelled in a way nobody
 * predicted, and `agent_name` / `callee_name` / `queue_name` — the fields this
 * panel exists to surface — are unaffected.
 */
function isAttributedKey(key: string): boolean {
  return hasAgentNameHint(key) || isRoutingNameKey(key);
}

/**
 * The same question asked about a field's WHOLE PATH, not just its leaf.
 *
 * THIS IS THE FIX FOR THE HOLE THAT MATTERED MOST. The walk in describeLiveRing
 * descends one level into every nested object, and it passed only the LEAF name
 * to the guard. So `caller.number` was withheld (the leaf spells a hint) while
 * `caller.name` and `customer.email` — the same guest, one key along — printed
 * in full, and the panel's top-ranked "lead" became the guest's name. The
 * envelope is exactly where a vendor puts guest identity, so it is exactly where
 * the guard has to hold.
 *
 * A wrapper that says guest makes the whole subtree guest-side, LEAF HINT AND
 * ALL: `caller.agent_ext` is withheld, because a vendor that nests under
 * `caller` is describing the caller and an `agent` fragment inside that subtree
 * is not enough to bet a guest's identity on. The soft/absolute split above is
 * what decides which wrappers are that final — a SOFT wrapper does yield to a
 * leaf hint, so `phone_info.agent_ext` prints, and so does anything under a
 * neutral wrapper such as `data.agent_ext`.
 */
function isCallerSidePath(parent: string | null, key: string): boolean {
  if (isCallerSideKey(key)) return true;
  if (!parent) return false;
  const pb = bareKey(parent);
  if (GUEST_ABSOLUTE_HINTS.some(h => pb.includes(h))) return true;
  return isCallerSideKey(parent) && !hasAgentNameHint(key);
}

/**
 * Replace every run of 6+ digits with '#', COUNTING ACROSS the punctuation a
 * phone number is normally written with.
 *
 * THE ONE RULE THAT MAKES THIS PANEL SAFE TO PRINT. A guest's 10-digit number
 * becomes ##########  — its shape, and nothing else. An extension (2–5 digits)
 * survives verbatim, which is the whole evidence we are after, and a mixed id
 * like 201_1111112 prints as 201_####### , which still shows the form AND the
 * extension half. Six is the floor because nothing shorter can be an Indian
 * mobile or an STD landline and nothing on this account uses an extension that
 * long.
 *
 * IT USED TO COUNT ONE CONTIGUOUS RUN, and that was a hole with a name:
 * "9876543210" was masked but "+91 98765 43210", "98765-43210" and
 * "(040) 2345-6789" all printed the guest's number verbatim, because no single
 * run reached six. The scan now walks a run THROUGH spaces, dots, brackets,
 * plus and hyphens and totals the digits inside it, so the separator a vendor
 * happens to use stops deciding whether a number is hidden.
 *
 * SEPARATORS SURVIVE, DIGITS DO NOT. Masking in place rather than collapsing to
 * one blob is what keeps the panel useful: "### ### ###" is visibly three short
 * groups (a member list) and "+## ##### #####" is visibly a phone, and neither
 * tells you a single digit. That distinction matters because an extension list
 * written "201 202 203" totals nine digits and is masked by this rule — it stays
 * legible as a shape, and judgeCandidate() still shortlists it on its name.
 */
function maskLongDigits(s: string): { text: string; masked: boolean } {
  let masked = false;
  const text = s.replace(/[0-9](?:[0-9\s().+-]*[0-9])?/g, run => {
    if (run.replace(/\D/g, '').length < 6) return run;
    masked = true;
    return run.replace(/[0-9]/g, '#');
  });
  return { text, masked };
}

/**
 * A field NAME, made safe to print.
 *
 * THE HEADER OF THIS PANEL SAYS "FIELD NAMES ARE SAFE TO PRINT", AND THAT IS
 * ONLY TRUE OF A RECORD. It is false of a MAP, and a per-leg map keyed by the
 * number being dialled — `legs: { "919876543210": { status: "ringing" } }` — is
 * an entirely ordinary shape for exactly the payload this panel is hunting.
 * Every key of such an object reaches the screen twice, as the row's `path` and
 * inside the parent's `{ … }` key list, and neither went through the digit mask
 * that guards every VALUE. A guest's number printed in full in the Field-name
 * column, on the one panel whose footnote promises it cannot.
 *
 * So a name gets the same two passes a value gets — this account's credentials
 * blanked, then every run of 6+ digits masked — and nothing else. Names are not
 * put through the identity rules: an ordinary field spelling like `agent name`
 * is shaped exactly like a person's name, and masking those would blank the
 * column the whole panel is read from. Digits are the objective part of the
 * rule and the part a phone number cannot avoid.
 */
function safeName(name: string, creds: string[]): string {
  return maskLongDigits(redactCreds(String(name), creds).text).text;
}

/** Plainly a telephone number rather than an extension: 7+ digits once
 *  punctuation is stripped, and nothing in it but dialling characters. */
function looksLikePhoneValue(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (!/^[+0-9][0-9\s()+-]*$/.test(t)) return false;
  return t.replace(/\D/g, '').length >= 7;
}

/**
 * Words a value can be that are NOT an identity, so a short token spelling one
 * of them is not offered as an agent candidate. Deliberately a small display
 * list and NOT a copy of the mapper's vocabularies: being incomplete only ever
 * costs a spurious low-ranked lead, never a missed one, so there is nothing here
 * that can drift into a wrong answer.
 */
const NON_IDENTITY_WORDS = new Set([
  'inbound', 'outbound', 'incoming', 'outgoing', 'internal', 'external',
  'ring', 'ringing', 'answer', 'answered', 'missed', 'noanswer', 'busy',
  'hangup', 'ended', 'end', 'start', 'started', 'new', 'call', 'voice', 'sms',
  'true', 'false', 'yes', 'no', 'null', 'none', 'unknown', 'na', 'india', 'in',
  'queue', 'group', 'team', 'ivr', 'did', 'trunk', 'pstn', 'sip', 'webrtc',
]);

/**
 * Inner key names that make a nested container look like it holds an identity.
 *
 * ONE list for both the array branch and the object branch of judgeCandidate().
 * They were two lists and they had drifted by exactly one word — the object
 * branch was missing 'agent' — so `{ target: { ext: '201' } }` ranked 45 and
 * `{ target: { agent: '201' } }` ranked 0. Same nesting, same value, one key
 * name apart. Two lists for one question is how that happens.
 */
const IDENTITY_INNER_KEYS = ['name', 'username', 'user', 'email', 'id', 'ext', 'extension', 'agent'];

/**
 * The two shapes that are BOTH strong agent evidence AND, on a ring payload,
 * the likeliest form of guest identity. Named once and shared by judgeCandidate
 * (which ranks them) and echoRingValue (which decides whether the value may be
 * printed), because the two must agree about what they are looking at — a shape
 * one of them recognises and the other does not is exactly how a guest name
 * ends up ranked as a lead with its value on screen.
 */
const IDENTITY_NAME_RE = /^[A-Za-z][A-Za-z.'’-]*( [A-Za-z.'’-]+){0,3}$/;
const IDENTITY_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** A value shaped like a person's name, and not a word that plainly is not one. */
function looksLikePersonName(s: string): boolean {
  return s.length >= 3 && s.length <= 40 && IDENTITY_NAME_RE.test(s) && !NON_IDENTITY_WORDS.has(bareKey(s));
}

/**
 * How many extensions are in this value if it is a member list written as ONE
 * STRING — 0 if it is not one.
 *
 * ONLY THE UNAMBIGUOUS SPELLINGS ARE CLAIMED, because the alternative reading
 * of a run of short numbers is a telephone number and getting that backwards is
 * the expensive mistake:
 *   · a comma, semicolon, pipe or slash is never used to write a phone number,
 *     so 2-to-5-digit groups joined by one of those are a list. "201,202,203",
 *     "201/202", "201;202;203".
 *   · whitespace is ambiguous — "98765 43210" is a mobile — so it counts only
 *     when there are THREE OR MORE groups and every one of them is 2–3 digits.
 *     That admits "201 202 203" and refuses "040 2345 6789" (a 4-digit group)
 *     and "98765 43210" (two groups).
 * A value this misreads is still digit-masked before it is printed, so the cost
 * of the remaining ambiguity is a wrong label and a rank, never a leaked number.
 */
function extensionListSize(s: string): number {
  if (/^\d{2,5}(\s*[,;|/]\s*\d{2,5})+$/.test(s)) return s.split(/[,;|/]/).length;
  if (/^\d{2,3}(\s+\d{2,3}){2,}$/.test(s)) return s.split(/\s+/).length;
  return 0;
}

/** One field's claim to being the extension the mapper is not reading. */
interface Candidacy {
  /** Why it qualified, in words the panel prints verbatim. */
  why: string[];
  /** Higher sorts first. 0 means "not a candidate". */
  score: number;
}

/**
 * Is this field's VALUE shaped like an extension or an agent identity?
 *
 * SHAPE-BASED ON PURPOSE. The whole reason the question is open is that the
 * NAME we are looking for is unknown, so a name-only test would find nothing by
 * construction. The value decides candidacy; the name only adds rank.
 *
 * A LIST OF SHORT NUMBERS SCORES HIGHEST, and that is not an accident: the owner
 * asked "for whom ALSO is it ringing", a hunt group rings several phones at
 * once, and an array of extensions is the single field that would answer him
 * completely. Nothing on this account has been observed to send one — which is
 * exactly why it must be looked for rather than assumed absent.
 *
 * AN UNRECOGNISED SHAPE UNDER AN AGENT-SOUNDING NAME IS STILL A LEAD. This
 * function used to return early — on an empty value, and on a phone-shaped one —
 * and to gate the name bonus behind `score > 0`. Between them those three exits
 * meant a field literally called `ring_members` holding "201,202,203" scored
 * ZERO: no value printed, not on the shortlist, and — worst of all — the panel
 * then announced "not one field holds a value shaped like an extension" with a
 * comma-separated list of extensions sitting in the table underneath. Six
 * plausible spellings of a hunt-group member list failed the same way
 * (ringing_member "SIP/201", agent_ext "Ext 201", answered_by_ext "201/202",
 * member_extensions, staff "Pushpa (201)"), and so did agent_number holding a
 * follow-me mobile. An unrecognised shape must DOWNGRADE a lead, never erase it,
 * so the name bonus is now unconditional and every path falls through to it.
 */
function judgeCandidate(key: string, value: unknown): Candidacy {
  const why: string[] = [];
  let score = 0;
  /** The value is a phone number. Tracked rather than returned on, so the name
   *  bonus below still sees it — an agent's own mobile is a real ring target. */
  let isPhone = false;

  if (Array.isArray(value)) {
    const scalars = value.filter(v => typeof v === 'string' || typeof v === 'number').map(v => String(v).trim());
    const allShortNumeric = scalars.length > 0 && scalars.length === value.length
      && scalars.every(s => /^\d{2,5}$/.test(s));
    // A MIXED list still counts. The first version demanded that EVERY element
    // be a bare extension, so a perfectly ordinary hunt-group list holding
    // ["201", "919876543210", { name: … }] scored as generic noise and dropped
    // off the shortlist — the exact field the owner's question is about. Now one
    // extension-shaped element, or one entry carrying a name/id, is enough.
    const someIdentityish = value.some(v => (
      ((typeof v === 'string' || typeof v === 'number') && /^\d{2,5}$/.test(String(v).trim()))
      || (isPlainObject(v) && Object.keys(v).map(bareKey).some(k => IDENTITY_INNER_KEYS.includes(k)))
    ));
    if (allShortNumeric) {
      why.push(`a list of ${scalars.length} short numeric value${scalars.length === 1 ? '' : 's'} — the shape of a ring group's member list, which is exactly "for whom is it ringing"`);
      score += 80;
    } else if (someIdentityish) {
      why.push(`a list of ${value.length} item${value.length === 1 ? '' : 's'}, at least one of which is extension-shaped or carries a name/id — the shape of a ring group's member list`);
      score += 55;
    } else if (value.length > 0) {
      why.push(`a list of ${value.length} item${value.length === 1 ? '' : 's'} — the mapper reads no list as an agent, so anything in here is invisible to it`);
      score += 20;
    }
  } else if (isPlainObject(value)) {
    const inner = Object.keys(value).map(bareKey);
    if (inner.some(k => IDENTITY_INNER_KEYS.includes(k))) {
      why.push('an object carrying name/id fields — pickAgent() only ever descends into objects literally named agent or user, so under any other name this is unread');
      score += 45;
    }
  } else {
    const s = value === null || value === undefined ? '' : String(value).trim();
    const attributed = isAttributedKey(key);
    if (!s) {
      // Nothing to judge — but fall through: an EMPTY value under an
      // agent-sounding name is itself a finding (it is what shadows a nested
      // one out of the mapper's collect()), so the name bonus must still see it.
    } else if (s.length > VALUE_LIMIT) {
      // Longer than anything this panel will print. Recognising a shape here
      // would be a claim about a value the reader is only ever shown the first
      // VALUE_LIMIT characters of — and echoValue truncates BEFORE the digit
      // mask sees the string, so a 211-character "email address" printed as
      // "…98765": the tail of a masked 10-digit number, cut down to five digits
      // and therefore no longer long enough to mask. Nothing is characterised
      // at this length; the name bonus below still applies, and the truncation
      // boundary is masked in echoRingValue as a second line of defence.
      why.push(`a ${s.length}-character value — too long for this panel to characterise or to print in full`);
    } else if (extensionListSize(s)) {
      // THE OWNER'S QUESTION IS "FOR WHOM **ALSO**", i.e. a LIST, and a hunt
      // group's member list does not always arrive as a JSON array — the plain
      // string "201,202,203" is at least as likely. It matched no shape at all
      // before this branch existed, so it scored on its NAME alone (40) and
      // ranked BELOW an ordinary `city: "Hyderabad"` (55). The single most
      // on-point field the payload could carry sorted under a place name.
      //
      // TESTED BEFORE looksLikePhoneValue ON PURPOSE: "201 202 203" totals nine
      // digits, so the phone test claimed it and the panel labelled a member
      // list "a telephone number — normally the caller". See extensionListSize
      // for why only unambiguous spellings are claimed here.
      why.push(`${extensionListSize(s)} short numbers written as one delimited string — a ring group's member list, which is exactly "for whom is it ringing"`);
      score += 75;
    } else if (looksLikePhoneValue(s)) {
      isPhone = true;
      why.push('a telephone number — on a ring payload that is normally the caller, not the phone being rung');
    } else if (/^\d{2,5}$/.test(s)) {
      why.push(`a ${s.length}-digit number — the shape of a SIP extension`);
      score += 70;
    } else if (/^\d{2,6}[_-]\d{4,}$/.test(s)) {
      why.push('an id in the click-to-call form <extension>_<number>, whose first half is an extension');
      score += 65;
    } else if (IDENTITY_EMAIL_RE.test(s)) {
      why.push(attributed
        ? 'an email address — an agent identity, and the form the FNB agent mapping is keyed on'
        : 'an email address — the form the FNB agent mapping is keyed on, but nothing in the field NAME says staff or routing, so only its domain is printed and the local part is treated as possible guest identity');
      score += attributed ? 50 : 45;
    } else if (looksLikePersonName(s)) {
      // SPLIT ON ATTRIBUTION, and both halves matter. Unqualified, "a human
      // name" was a false claim printed as a headline: `city: "Hyderabad"`
      // scored 55 and came back as "the strongest is city (a human name)". This
      // panel cannot tell a person from a place, so where the field name does
      // not say staff it no longer pretends to — and the value is withheld in
      // echoRingValue, because the same shape is how a guest's name arrives.
      why.push(attributed
        ? 'a human name, under a field name that reads as staff or routing'
        : 'a value shaped like a person\'s name, though nothing in the field NAME says staff or routing — it could equally be a place, a label or the GUEST, so the value is not printed and the field NAME is the lead');
      score += attributed ? 55 : 45;
    } else if (/^[A-Za-z0-9_.-]{2,16}$/.test(s) && !NON_IDENTITY_WORDS.has(bareKey(s))) {
      why.push('a short identifier');
      score += 25;
    }
  }

  // THE NAME BONUS IS APPLIED TO EVERY SHAPE AND EVERY SCORE, lists, objects and
  // shapes nothing here recognised. `score > 0` used to guard it, which quietly
  // reintroduced the same class of bug the "every shape" note was written about:
  // the bonus was reachable by a list, but not by a value whose shape scored
  // nothing — and the field the owner is actually asking about, a hunt-group
  // member list, is precisely a value with an unrecognised shape.
  //
  // 40 is CANDIDATE_FLOOR exactly, so a name hint alone is the weakest thing that
  // still earns a place on the shortlist. It cannot outrank real evidence, and
  // the reason is printed beside it so nobody reads it as more than it is.
  if (hasAgentNameHint(key)) {
    if (score > 0) {
      why.push('and its NAME reads like an agent/extension field');
    } else if (isPhone) {
      why.push('its NAME reads like an agent/extension field and it holds a telephone number — on a follow-me or mobile-app ring that is the agent\'s own phone, so it is listed; the number itself is masked here');
    } else {
      why.push('its NAME reads like an agent/extension field, though its value is not a shape this panel recognises — the value is printed beside it, read it and judge for yourself');
    }
    score += 40;
  }
  return { why, score };
}

/**
 * Score at or above which a field is offered as a lead.
 *
 * SET ABOVE A BARE "short identifier" (25) ON PURPOSE. At 25 every opaque token
 * on the payload — the call id, a session key, a locale — qualified, and the
 * shortlist the owner is meant to read at a glance was mostly noise. A short
 * token now earns a place only when its NAME also reads like an agent field
 * (25 + 40), while the things that actually look like an extension — a 2-to-5
 * digit number, a name, an email, a list of extensions — clear it on the value
 * alone and keep their place with no name hint at all.
 */
const CANDIDATE_FLOOR = 40;

interface LiveRingField {
  /** Original spelling as TeleCMI sent it, e.g. agent_no or data.agent_no. */
  path: string;
  shape: string;
  /** False when the mapper's collect() cannot reach this nesting at all —
   *  a lead here could not be fixed by adding a spelling to AGENT_KEYS. */
  in_mapper_reach: boolean;
  /** Asked of the mapper, never assumed. */
  matched_agent_key: boolean;
  matched_queue_key: boolean;
  /** The mapper reads this key as the CALL ID. Reported so a short id is not
   *  read as an extension the panel forgot to shortlist. */
  matched_id_key: boolean;
  /** '' whenever `withheld` is set. Credential-masked and digit-masked. */
  value: string;
  /** Why no value is printed. '' when one is. */
  withheld: string;
  redacted: boolean;
  digits_masked: boolean;
  truncated: boolean;
  /** An UNMATCHED field whose value looks like an extension or an identity. */
  candidate: boolean;
  candidate_score: number;
  candidate_why: string[];
}

interface LiveRingReport {
  log_id: string;
  received_at: string;
  telecmi_call_id: string;
  /** ct_webhook_log.event — the mapper's classification AT INGEST TIME. */
  event_at_ingest: string;
  payload_readable: boolean;
  field_count: number;
  /**
   * How many fields this panel refused to read because the PATH is caller-side.
   * Reported so "nothing was found" can be read honestly: a few withheld fields
   * means a few places this panel deliberately did not look. Counted over EVERY
   * field, not only the ones that would otherwise have printed — it used to be
   * the latter, which quietly excluded every phone-shaped caller field and made
   * the hedge understate itself.
   */
  caller_side_withheld: number;
  /** How many values were declined because they were identity-shaped under a
   *  field name that attributes them to nobody. The field is still listed and
   *  still a lead — see isAttributedKey(). */
  identity_withheld: number;
  /** Fields nested one level BELOW where the walk stops. The other half of the
   *  honesty hedge: their contents were never examined. */
  deeper_nesting: number;
  /** Paths the mapper reads as the agent whose value pickStr WOULD read here.
   *  Non-empty while mapper.agent is '' means an earlier spelling is shadowing
   *  one — see mapperCanReadValue() for why "readable" and not "non-empty". */
  shadowed_agent_paths: string[];
  /** The shadowERS: paths the mapper reads as the agent that hold something
   *  pickStr cannot read (blank, object, list, boolean). They occupy the slot in
   *  collect() and stop the search, which is a mapper fix, not a key-list one. */
  blocking_agent_paths: string[];
  /** Non-caller-side paths NAMED like an agent field that carry NOTHING — no
   *  text, no members, no keys. This is the set, and the ONLY set, that "the
   *  vendor sends the key and leaves it blank" may be said about. */
  agent_named_empty_paths: string[];
  /** Non-caller-side paths NAMED like an agent field that DO carry something —
   *  text, list members or object keys — and still did not become a lead.
   *
   *  SPLIT OUT BECAUSE THE HEADLINE WAS LYING ABOUT THEM. Both sets used to be
   *  one list, and the branch that reads it says "TeleCMI is sending the key and
   *  leaving it empty at ring time". On a payload carrying
   *  `agent_list: ["201", "<app id>"]` that sentence was printed with
   *  `[ 201, •••• ]` sitting in the row directly underneath it. "It holds
   *  something we are not offering as a lead" and "it is not there" are
   *  different answers with different next steps. */
  agent_named_filled_paths: string[];
  /** What the mapper extracts from THIS payload today — the other half of the
   *  gap the panel exists to show. */
  mapper: { agent: string; queue: string; event: string; direction: string };
  fields: LiveRingField[];
  /** The unmatched leads on this one payload, best first. */
  candidates: { path: string; score: number; why: string[] }[];
  headline: string;
}

/**
 * Print a ring-payload value, or refuse to.
 *
 * Order matters and each step is load-bearing:
 *   1 caller-side PATH — the leaf name OR the envelope it arrived in → nothing
 *     is printed at all. The envelope half is not decoration: the walk descends
 *     one level, and testing only the leaf let `caller.name` and
 *     `customer.email` print in full while `caller.number` was withheld.
 *   2 a secret-sounding name → the whole value is masked, before any branch
 *     below can render part of it. RING_SECRET_RE catches the short telephony
 *     credentials (agent_pin, otp, sip_key) that SECRET_KEY_RE does not.
 *   3 an OBJECT prints its inner KEY NAMES and no values. A nested object is
 *     offered as a lead because it holds a name/id, and the reader needs to see
 *     which — but String() on it says "[object Object]", which is useless, and
 *     printing its contents would echo values that never went through any of
 *     the tests below. Names only is both more useful and strictly safer.
 *   4 an ARRAY is rendered element by element, each one through the SAME rules
 *     as a scalar, so a phone number inside a list is masked exactly as one
 *     sitting on its own would be. (String() on an array quietly comma-joins
 *     it, which would have slipped a whole list past the per-value guard.)
 *   5 an IDENTITY-SHAPED value under a field name that says NOTHING about staff
 *     or routing → name withheld, email reduced to its domain. See
 *     isAttributedKey(): the caller-side denylist can only catch the guest
 *     spellings somebody thought of, and this panel's whole premise is that the
 *     spellings are unknown.
 *   6 echoValue() → the EXISTING credential scheme, unchanged: a credential
 *     NAME masks the whole value, a credential found inside an innocent value is
 *     blanked in place, and the result is truncated at VALUE_LIMIT.
 *   7 maskLongDigits() → the phone guard, applied AFTER the credential pass so
 *     it cannot reveal anything the credential pass hid, plus a mask of the
 *     truncation boundary itself (step 6 cuts before step 7 can see the whole
 *     string, so a long run sliced down to five digits would otherwise print).
 */
function echoRingValue(
  parent: string | null,
  key: string,
  v: unknown,
  creds: string[],
  /** The field's NAME attributes it to staff or to routing, so an identity-
   *  shaped value in it is evidence rather than possible guest identity. */
  attributed: boolean,
): {
  value: string;
  withheld: string;
  /** Withheld specifically because the NAME is caller-side. Separate from
   *  `withheld` because only this one disqualifies a field as a lead — an
   *  object still IS a lead, it just shows its key names instead of a value. */
  caller_side: boolean;
  /** Withheld under step 5 — identity-shaped, but the field name does not
   *  attribute it. Still a lead; counted so the footnote can say how many
   *  values were declined on that rule rather than leaving it unstated. */
  identity_withheld: boolean;
  redacted: boolean;
  digits_masked: boolean;
  truncated: boolean;
} {
  const nothing = { caller_side: false, identity_withheld: false, redacted: false, digits_masked: false, truncated: false };
  if (isCallerSidePath(parent, key)) {
    return {
      value: '',
      withheld: 'caller-side field — the value is guest identity and is not printed',
      ...nothing,
      caller_side: true,
    };
  }
  // Before ANY branch below, so a secret in a list or an object is masked too.
  if (isRingSecretName(key)) {
    return {
      value: maskSecretValue(v === null || v === undefined ? '' : String(v)),
      withheld: '',
      ...nothing,
      redacted: true,
    };
  }
  if (isPlainObject(v)) {
    // safeName, NOT the raw key: an object can be a MAP keyed by the number
    // being dialled, and its keys are then guest identity. See safeName().
    const names = Object.keys(v).map(n => safeName(n, creds));
    return {
      value: names.length ? `{ ${names.join(', ')} }` : '{ }',
      withheld: 'an object — its field NAMES are shown, its values are not',
      ...nothing,
    };
  }
  if (Array.isArray(v)) {
    let redacted = false;
    let digitsMasked = false;
    let identityWithheld = false;
    let truncated = v.length > 12;
    const parts = v.slice(0, 12).map(item => {
      if (isPlainObject(item)) return `{ ${Object.keys(item).map(n => safeName(n, creds)).join(', ')} }`;
      if (Array.isArray(item)) return `[…]`;
      const one = echoRingValue(parent, key, item, creds, attributed);
      redacted = redacted || one.redacted;
      digitsMasked = digitsMasked || one.digits_masked;
      truncated = truncated || one.truncated;
      identityWithheld = identityWithheld || one.identity_withheld;
      return one.withheld ? '‹withheld›' : one.value;
    });
    const joined = `[ ${parts.join(', ')}${v.length > 12 ? ', …' : ''} ]`;
    return {
      value: joined.length > VALUE_LIMIT ? joined.slice(0, VALUE_LIMIT) : joined,
      withheld: '',
      caller_side: false,
      identity_withheld: identityWithheld,
      redacted,
      digits_masked: digitsMasked,
      truncated: truncated || joined.length > VALUE_LIMIT,
    };
  }
  // IDENTITY SHAPE UNDER AN UNATTRIBUTED NAME. The caller-side list above knows
  // caller / cnam / customer / contact / name; it did not know `party`,
  // `whatsapp`, `profile`, `subscriber`, `originator`, `a_party` or a bare
  // `email`, and every one of those printed "Ravi Kumar" and
  // "ravi.kumar@gmail.com" in full. Enumerating guest spellings is the losing
  // side of that game — the payload's spellings are exactly what is unknown —
  // so the test is inverted here: an identity-shaped value prints only where the
  // NAME says agent or ring group. The field is STILL a lead either way; what is
  // withheld is the person, not the finding.
  if (!attributed) {
    const s = v === null || v === undefined ? '' : String(v).trim();
    if (s.length <= VALUE_LIMIT && IDENTITY_EMAIL_RE.test(s)) {
      // The DOMAIN is the whole discriminator — @a-pbx-host is an agent SIP
      // identity, @gmail.com is a guest — and it names no person, so it is the
      // one part worth printing.
      //
      // IT IS STILL A PIECE OF THE PAYLOAD, so it goes through the same two
      // passes every other echoed string does. It used to be interpolated raw,
      // and that was the one hole in this file that defeated BOTH guards at
      // once: `a_party: "ravi@919876543210.example"` printed the guest's twelve
      // digits in full, and `"ravi@<appid>.io"` printed this account's live App
      // ID in full — inside the very sentence explaining that the value was
      // being withheld for safety. A SIP host that is a bare IP is masked along
      // with them; losing an octet is the right side of that trade.
      const rawDomain = s.slice(s.lastIndexOf('@'));
      const domainCreds = redactCreds(rawDomain, creds);
      const domain = maskLongDigits(domainCreds.text);
      return {
        value: '',
        withheld: `an email address under a field name that says nothing about staff or routing — the local part could be the guest, so only the domain is shown: ${domain.text}`,
        ...nothing,
        identity_withheld: true,
        redacted: domainCreds.redacted,
        digits_masked: domain.masked,
      };
    }
    if (looksLikePersonName(s)) {
      return {
        value: '',
        withheld: 'a value shaped like a person\'s name, under a field name that says nothing about staff or routing — it could be the guest, so it is not printed. The field NAME and the shape are the lead.',
        ...nothing,
        identity_withheld: true,
      };
    }
  }
  const echoed = echoValue(key, v, creds);
  const digits = maskLongDigits(echoed.value);
  let text = digits.text;
  let digitsMaskedOut = digits.masked;
  if (echoed.truncated) {
    // echoValue TRUNCATES BEFORE maskLongDigits ever sees the string, so a run
    // that was long enough to hide can be cut down to a few digits and print.
    // Demonstrated: a 211-character value ending "…9876543210@a.com" came back
    // as "…98765" — five digits of a guest number, and digits_masked false, so
    // the row did not even carry the "(# — a long number, hidden)" marker.
    // Anything still touching the cut is masked whatever its length.
    const cut = text.replace(/[0-9][0-9\s().+-]*$/, run => run.replace(/[0-9]/g, '#'));
    if (cut !== text) {
      text = cut;
      digitsMaskedOut = true;
    }
  }
  return {
    value: text,
    withheld: '',
    caller_side: false,
    identity_withheld: false,
    redacted: echoed.redacted,
    digits_masked: digitsMaskedOut,
    truncated: echoed.truncated,
  };
}

/**
 * One request's memory of what the mapper said about a (nesting, key) pair, and
 * about an envelope name.
 *
 * WHY IT IS HERE AT ALL. Each probe is a real call into the mapper, and the same
 * twenty-odd key names repeat on every ring in the batch. Without this the panel
 * runs the mapper thousands of times per page load and — the part that actually
 * matters — a probe key that lands on a time or direction field makes the mapper
 * log a warning EVERY time, so a single admin page view would bury the server
 * log in hundreds of identical lines about a payload that does not exist.
 *
 * PER REQUEST, not module-level. The answers cannot change inside one request,
 * and a cache with no lifetime is a question nobody should have to answer later.
 */
interface RingProbeMemo {
  keys: Map<string, { agent: boolean; queue: boolean; id: boolean }>;
  envelopes: Map<string, boolean>;
}
function newRingProbeMemo(): RingProbeMemo {
  return { keys: new Map(), envelopes: new Map() };
}
function probeKey(memo: RingProbeMemo, parent: string | null, key: string) {
  const at = `${parent ?? ''}\u0000${key}`;
  let hit = memo.keys.get(at);
  if (!hit) {
    const agent = mapperReadsAsAgent(parent, key);
    hit = {
      agent,
      // Short-circuited: a key the mapper already reads as the agent cannot also
      // be its queue, and skipping the probe skips its log warnings too.
      queue: agent ? false : mapperReadsAsQueue(parent, key),
      id: agent ? false : mapperReadsAsCallId(parent, key),
    };
    memo.keys.set(at, hit);
  }
  return hit;
}
function probeEnvelope(memo: RingProbeMemo, parent: string): boolean {
  let hit = memo.envelopes.get(parent);
  if (hit === undefined) {
    hit = mapperFlattensEnvelope(parent);
    memo.envelopes.set(parent, hit);
  }
  return hit;
}

/**
 * Would the mapper's pickStr() read this raw value as text?
 *
 * MIRRORS pickStr IN src/lib/ct/telecmi-mapper.ts EXACTLY — a non-empty trimmed
 * string, a finite number, a bigint, and nothing else. It cannot be replaced by
 * an "is it empty" test, and that distinction is the whole point:
 *
 *   collect() stores ANY value that is not null (`if (nk && v != null && ...)`),
 *   so an object, a list, a boolean or an empty string sitting on an AGENT_KEYS
 *   spelling OCCUPIES the slot and blocks a filled one nested below — while
 *   pickStr reads none of them and returns ''.
 *
 * So a field like that is the SHADOWER, not something being shadowed, and the
 * two must not be reported as one thing. `String(value).trim() !== ''` was doing
 * exactly that: it called {zzz:1} "carries a value" (String() on an object is
 * "[object Object]") and then explained the payload with "an EMPTY earlier
 * spelling … skip a blank and keep looking" — the wrong instruction for a value
 * that is not blank. It also called [] empty, so an array shadow went unreported
 * altogether. Asking the mapper's own question removes both mistakes.
 */
function mapperCanReadValue(v: unknown): boolean {
  if (typeof v === 'string') return v.trim() !== '';
  if (typeof v === 'number') return Number.isFinite(v);
  return typeof v === 'bigint';
}

/** Field-by-field ring report for ONE live-ring ct_webhook_log row. */
function describeLiveRing(row: any, creds: string[], memo: RingProbeMemo): LiveRingReport {
  let payload: unknown = null;
  let payloadReadable = false;
  try {
    payload = JSON.parse(String(row?.payload ?? ''));
    payloadReadable = isPlainObject(payload);
  } catch {
    payloadReadable = false;
  }

  let mapped: ReturnType<typeof mapLivePayload> = null;
  try {
    mapped = isPlainObject(payload) ? mapLivePayload(payload) : null;
  } catch {
    mapped = null;
  }

  const fields: LiveRingField[] = [];
  let fieldCount = 0;
  let callerSideSkipped = 0;
  /** Values declined under the identity rule in echoRingValue — counted only
   *  where a value WOULD have printed, which is exactly the set the rule bites
   *  on, so this cannot understate the way the caller-side count once did. */
  let identityWithheldCount = 0;
  let deeperNesting = 0;
  /** Paths the mapper READS as the agent whose value pickStr WOULD read. If the
   *  mapper still came back empty, one of these is being shadowed by another —
   *  and the "nothing here" headline would be a lie told over the evidence. */
  const matchedAgentReadable: string[] = [];
  /** Paths the mapper reads as the agent that hold something pickStr CANNOT
   *  read — a blank, an object, a list, a boolean. These are the shadowERS: they
   *  occupy the slot in collect() and stop the mapper looking any further. */
  const matchedAgentBlocking: string[] = [];
  /**
   * Paths named like an agent field, NOT caller-side, and carrying NOTHING.
   *
   * EXISTS TO STOP ONE FALSE SENTENCE. The last headline branch used to say "no
   * field on this ring is named like an agent field" whenever nothing scored,
   * and a payload carrying a literal `agent: ""` reached exactly that branch —
   * the field is MATCHED, so judgeCandidate is short-circuited to 0 and the
   * field vanishes from the reasoning. "TeleCMI sends the key and leaves it
   * blank on a ring" and "TeleCMI has no such key" are different answers with
   * different fixes, and the panel was printing the second for the first.
   */
  const agentNamedEmptyPaths: string[] = [];
  /**
   * Paths named like an agent field, NOT caller-side, that DO carry something —
   * and so cannot be described as empty.
   *
   * THE SECOND HALF OF THE SAME FALSE SENTENCE. The list above used to hold
   * these too, and the branch that reads it announces "TeleCMI is sending the
   * key and leaving it empty at ring time … no addition to AGENT_KEYS would fill
   * it". Run against `{ agent_pin: "9137", sip_key: "abc123", agent_list:
   * ["201", "<app id>"] }` the panel named all three as empty keys — with
   * `[ 201, •••• ]` printed in the table underneath. Every one of them holds a
   * value; the panel is what is not offering it.
   */
  const agentNamedFilledPaths: string[] = [];
  /** Does the field carry ANYTHING at all? The honest test behind "empty" —
   *  wider than mapperCanReadValue (which asks the narrower question "would
   *  pickStr read this", and answers no for a populated object or list). */
  const hasContent = (v: unknown): boolean => {
    if (v === null || v === undefined) return false;
    if (typeof v === 'string') return v.trim() !== '';
    if (Array.isArray(v)) return v.length > 0;
    if (isPlainObject(v)) return Object.keys(v).length > 0;
    return true;
  };

  const visit = (parent: string | null, key: string, value: unknown) => {
    fieldCount++;
    const probed = probeKey(memo, parent, key);
    const matchedAgent = probed.agent;
    const matchedQueue = probed.queue;
    const matchedId = probed.id;
    const inReach = parent === null ? true : probeEnvelope(memo, parent);
    // safeName, NOT the raw spelling: on a per-leg MAP the "field name" is the
    // number being dialled, and this string is printed on screen unmasked in
    // the Field-name column and repeated in every headline that names a path.
    // See safeName(). The probes above are given the RAW key — what the mapper
    // reads must never depend on what the panel is willing to display.
    const path = safeName(parent ? `${parent}.${key}` : key, creds);
    const callerSide = isCallerSidePath(parent, key);
    // COUNTED HERE, not from echoRingValue's answer, because that only ran for
    // fields that already wanted a value. Every phone-shaped caller field scores
    // zero and so was never counted, and the "N caller-side fields were not read"
    // hedge in the headline systematically understated what had been skipped.
    if (callerSide) callerSideSkipped++;
    // The walk stops one level down. An object sitting AT that level has
    // contents nobody looked at, so "nothing was found" has to be qualified.
    if (parent !== null && isPlainObject(value)) deeperNesting++;
    if (matchedAgent) {
      if (mapperCanReadValue(value)) matchedAgentReadable.push(path);
      else if (value !== null && value !== undefined) matchedAgentBlocking.push(path);
    }
    // EMPTY vs MERELY HIDDEN. Only a field that carries nothing may be reported
    // as one the vendor left blank; anything holding a value the panel declines
    // to print belongs in the other list, with the reason said out loud.
    if (!callerSide && (matchedAgent || hasAgentNameHint(key))) {
      if (hasContent(value)) agentNamedFilledPaths.push(path);
      else agentNamedEmptyPaths.push(path);
    }

    // A key the mapper ALREADY reads is not a lead — it is the answer, and its
    // value is printed so the reader can see what the mapper had to work with.
    // The CALL ID is excluded for a different reason: it is read, it is not an
    // agent, and its value is often short enough to look exactly like one.
    const judged = matchedAgent || matchedQueue || matchedId
      ? { why: [], score: 0 }
      : judgeCandidate(key, value);
    // A SECRET-NAMED FIELD IS NEVER A LEAD, however well its value scores. Its
    // value is masked before anything can be read off it, so offering it as
    // something to act on offers evidence nobody can see — and it outranked real
    // leads while doing so: `agent_pin: "9137"` scored 110 and became the
    // headline's top recommendation ("the shape of a SIP extension"), one step
    // away from a live PIN being added to AGENT_KEYS. The field is still listed
    // with its name and shape, which is all a masked value was ever worth.
    const isCandidate = judged.score >= CANDIDATE_FLOOR && !isRingSecretName(key);

    // VALUES ONLY WHERE THEY ARE EVIDENCE: a matched key (what the mapper used)
    // or a candidate (what it is ignoring). Everything else contributes a name
    // and a shape, the same rule the CDR and answer panels follow.
    const wantsValue = matchedAgent || matchedQueue || isCandidate;
    // A key the MAPPER reads as the agent or the ring group is attributed by
    // that fact alone, whatever it is spelled — that is the mapper's own answer,
    // not a guess about the name.
    const attributed = matchedAgent || matchedQueue || isAttributedKey(key);
    const echoed = wantsValue
      ? echoRingValue(parent, key, value, creds, attributed)
      // A caller-side field says so even when no value was wanted anyway. It
      // used to render as a bare "—", indistinguishable from a field this panel
      // simply had no interest in, so the row contradicted the count in the
      // footnote below it: `customer.number` was one of the "N withheld" and
      // showed nothing to say so.
      : {
        value: '',
        withheld: callerSide
          ? 'caller-side field — the value is guest identity and is not printed'
          // AND A SECRET-NAMED ONE SAYS SO TOO. It is skipped by isCandidate
          // above, so nothing called echoRingValue for it and the row rendered a
          // bare "—" — a field literally named agent_pin showing nothing, with no
          // word anywhere about why, while the headline listed it as a key the
          // vendor sends empty. Two silences reading as one wrong fact.
          : isRingSecretName(key)
            ? 'the field NAME says credential — the value is not printed and the field is not offered as a lead'
            : '',
        caller_side: callerSide,
        identity_withheld: false,
        redacted: false,
        digits_masked: false,
        truncated: false,
      };
    if (echoed.identity_withheld) identityWithheldCount++;

    fields.push({
      path,
      shape: shapeOf(value),
      in_mapper_reach: inReach,
      matched_agent_key: matchedAgent,
      matched_queue_key: matchedQueue,
      matched_id_key: matchedId,
      value: echoed.value,
      withheld: echoed.withheld,
      redacted: echoed.redacted,
      digits_masked: echoed.digits_masked,
      truncated: echoed.truncated,
      // A caller-side field never becomes a lead: its value is not printed, so
      // offering it as a shortlist entry would be a lead nobody could read. An
      // OBJECT still is one — it shows its key names, which is the readable part.
      // An IDENTITY-WITHHELD field still is one too: what it lost is the person,
      // not the finding, and its name and shape are the lead.
      //
      // A CREDENTIAL-VALUED FIELD IS NOT. `redacted` here means echoValue found
      // one of THIS account's configured credentials inside the value, so we
      // know exactly what the field holds and it is not an agent. It was ranking
      // top: `agent_tag` carrying the App ID printed "••••" and the headline read
      // "the strongest is agent_tag (a short identifier; and its NAME reads like
      // an agent/extension field)" — a recommendation to wire the App ID in as
      // the agent name, with no readable evidence beside it. Same reasoning as
      // the secret-NAMED exclusion above; the row still shows the name, the shape
      // and the "(masked — looked like a credential)" marker.
      //
      // A LIST IS THE EXCEPTION, and it has to be. `redacted` on an array means
      // ONE ELEMENT contained a credential, not that the field is one — so
      // `agent_list: ["201", "<app id>"]` printed `[ 201, •••• ]`, was struck off
      // the shortlist by a rule written for scalars, and the panel then reported
      // "not one field holds a value shaped like an extension". A hunt-group
      // member list is the exact shape the owner's question is about; it is not
      // allowed to disappear because of what sits beside the extension in it.
      // The masked element stays masked either way — this decides ranking only.
      candidate: isCandidate && !echoed.caller_side && !(echoed.redacted && !Array.isArray(value)),
      candidate_score: judged.score,
      candidate_why: judged.why,
    });
  };

  if (isPlainObject(payload)) {
    for (const [k, v] of Object.entries(payload)) {
      visit(null, k, v);
      // ONE LEVEL DOWN — every nested object, not only the wrappers collect()
      // knows. A field must not be missed here precisely because it arrived
      // wrapped; whether the mapper could ever reach it is reported separately
      // as in_mapper_reach rather than being used to hide it.
      if (isPlainObject(v)) for (const [ck, cv] of Object.entries(v)) visit(k, ck, cv);
    }
  }

  const candidates = fields
    .filter(f => f.candidate)
    .sort((a, b) => b.candidate_score - a.candidate_score || a.path.localeCompare(b.path))
    .map(f => ({ path: f.path, score: f.candidate_score, why: f.candidate_why }));

  // attributed: TRUE — these two are not payload fields, they are what the
  // mapper concluded. The agent name and the ring group are the answer this
  // panel exists to print; withholding them as "possible guest identity" would
  // blank the one line the reader came for.
  const agentEcho = echoRingValue(null, 'agent', String(mapped?.agent || ''), creds, true);
  const queueEcho = echoRingValue(null, 'queue', String(mapped?.queue || ''), creds, true);
  const rawAgent = String(mapped?.agent || '').trim();

  // "Nothing was found here" is the one sentence on this panel that ENDS an
  // investigation, so it is the one that has to be hedged with everything this
  // walk did not look at. Both hedges below are facts about the walk, not
  // guesses about the payload.
  const unlooked = deeperNesting
    ? ` (${deeperNesting} field${deeperNesting === 1 ? ' nests' : 's nest'} deeper than this panel walks, and ${deeperNesting === 1 ? 'its contents were' : 'their contents were'} not examined)`
    : '';
  const notRead = callerSideSkipped
    ? ` (${callerSideSkipped} caller-side field${callerSideSkipped === 1 ? ' was' : 's were'} deliberately not read — those describe the guest)`
    : '';

  let headline: string;
  if (!payloadReadable) {
    headline = 'The stored payload for this delivery is not a readable JSON object, so nothing can be read out of it.';
  } else if (agentEcho.value && looksLikePhoneValue(rawAgent)) {
    // The mapper found SOMETHING, but what it found is a phone number. Saying
    // "this works today" here would send the reader away from a real bug:
    // AGENT_KEYS is ordered, and an earlier spelling holding the caller's or the
    // agent's number wins over a later one holding the extension.
    headline =
      `The mapper reads an agent off this RING payload, but what it reads is a TELEPHONE NUMBER (${agentEcho.value}), not an extension or a name. That is very likely the wrong field winning: AGENT_KEYS is consulted in order, so an earlier spelling holding a number beats a later one holding the extension. Check the field list for a shorter, extension-shaped value the mapper is walking past.`;
  } else if (agentEcho.value) {
    headline =
      `The mapper DOES read an agent off this RING payload: "${agentEcho.value}". "Ringing — <name>" can be shown for a call like this one today; if it was not, the fault is downstream of the mapper, not in the key list.`;
  } else if (matchedAgentReadable.length) {
    // The contradiction case, and it must never be reported as "nothing here":
    // collect() keeps the FIRST spelling it meets, so a value the mapper cannot
    // read as text at the top blocks a populated `data.agent` underneath. The
    // value is sitting in the table below with a "read as agent" badge on it.
    //
    // ONLY pickStr-READABLE PATHS ARE NAMED HERE. The test used to be
    // String(value).trim() !== '', which called an object "a value" and put the
    // BLOCKER in the same breath as the thing it blocks — and then explained the
    // payload as "an EMPTY earlier spelling … skip a blank", which is the wrong
    // instruction whenever the blocker is an object or a list.
    headline =
      `CONTRADICTION, and it is the finding. The mapper read NO agent — yet ${matchedAgentReadable.length === 1 ? 'a field it does read as the agent carries' : `${matchedAgentReadable.length} fields it does read as the agent carry`} a readable value on this very payload (${matchedAgentReadable.join(', ')}). `
      + (matchedAgentBlocking.length
        ? `The blocker is ${matchedAgentBlocking.join(', ')}: the mapper keeps the FIRST key of a given name it meets, and ${matchedAgentBlocking.length === 1 ? 'that one holds' : 'those hold'} something it cannot read as text — a blank, an object or a list — so it stops there. `
        : 'That is the signature of an earlier spelling the mapper cannot read as text — a blank, an object or a list. It keeps the first key of a given name it meets, so that one shadows the filled one below it. ')
      + 'No new spelling in AGENT_KEYS would fix this. The fix is to make the mapper skip a value it cannot read and keep looking, and it belongs to whoever owns src/lib/ct/telecmi-mapper.ts.';
  } else if (candidates.length) {
    const lead = candidates[0];
    headline =
      `The mapper read NO agent here, but this ring carries ${candidates.length} unread field${candidates.length === 1 ? '' : 's'} whose value or name points at an extension or an identity — the strongest is ${lead.path} (${lead.why.join('; ')}). `
      + 'That is a LEAD, not a verdict: before any spelling goes into AGENT_KEYS, check what the same key holds on an ANSWERED payload, because pickAgent() is event-blind and a wrong spelling would mis-attribute who picked up.';
  } else if (agentNamedFilledPaths.length) {
    // THE PAYLOAD HAS THE KEY AND IT IS NOT EMPTY — it just did not become a
    // lead, because the panel masked it (a credential name, a credential inside
    // the value) or because the mapper already reads it. This branch comes
    // FIRST, above the empty one, because saying "the vendor sends it blank"
    // over a field that holds something is the more damaging of the two errors:
    // it closes the question. Send the reader to the row instead.
    headline =
      `The mapper read no agent and nothing here became a lead — but ${agentNamedFilledPaths.length === 1 ? 'a field named like an agent field DOES carry a value' : `${agentNamedFilledPaths.length} fields named like an agent field DO carry values`} on this ring (${agentNamedFilledPaths.join(', ')})${queueEcho.value ? `, alongside a ring group "${queueEcho.value}"` : ''}${notRead}${unlooked}. `
      + `${agentNamedFilledPaths.length === 1 ? 'It is' : 'They are'} not offered as ${agentNamedFilledPaths.length === 1 ? 'a lead' : 'leads'} because the panel will not act on ${agentNamedFilledPaths.length === 1 ? 'it' : 'them'} — a name that reads as a credential, a value carrying one of this account's credentials, or a key the mapper already reads. READ THE ROW: the reason is printed beside each one. This is NOT "TeleCMI sends nothing".`;
  } else if (agentNamedEmptyPaths.length) {
    // THE PAYLOAD HAS THE KEY AND LEAVES IT BLANK. Reported apart from "no such
    // field exists" because the two answers point at different places: this one
    // is a fact about TeleCMI's ring event, and no spelling added to AGENT_KEYS
    // can fill a field the vendor sends empty.
    headline =
      `The mapper read no agent, and no field here holds a value shaped like an extension, an email or a person's name — but this ring DOES carry ${agentNamedEmptyPaths.length === 1 ? 'a field named like an agent field' : `${agentNamedEmptyPaths.length} fields named like an agent field`} (${agentNamedEmptyPaths.join(', ')}) with nothing in ${agentNamedEmptyPaths.length === 1 ? 'it at all' : 'them at all'}${queueEcho.value ? `, and a ring group "${queueEcho.value}"` : ''}${notRead}${unlooked}. `
      + 'That is TeleCMI sending the key and leaving it empty at ring time, not a spelling we are missing — no addition to AGENT_KEYS would fill it. Compare the same key on an ANSWERED payload before concluding anything about the account.';
  } else {
    headline =
      `The mapper read no agent, and no field on this ring is named like an agent field or holds a value shaped like an extension or an agent identity${queueEcho.value ? ` — the only routing fact it carries is the ring group "${queueEcho.value}"` : ''}${notRead}${unlooked}. `
      + 'Read the field list beside this before concluding: every name is printed, and a name nobody recognised is still worth a human eye.';
  }

  return {
    log_id: String(row?.id ?? ''),
    received_at: String(row?.received_at ?? ''),
    // safeName here too. This one is printed in the header of every ring in the
    // collapsed evidence list, and it is the LAST string on the panel derived
    // from the provider that no rule covered. On this account it is a token
    // (ZZHANGUP-1) and masking costs nothing; on a PBX that builds a call id out
    // of the number dialled it is the guest's number, printed beside a footnote
    // promising that cannot happen.
    telecmi_call_id: safeName(String(row?.telecmi_call_id ?? ''), creds),
    event_at_ingest: String(row?.event ?? ''),
    payload_readable: payloadReadable,
    field_count: fieldCount,
    caller_side_withheld: callerSideSkipped,
    identity_withheld: identityWithheldCount,
    deeper_nesting: deeperNesting,
    shadowed_agent_paths: rawAgent ? [] : matchedAgentReadable,
    blocking_agent_paths: rawAgent ? [] : matchedAgentBlocking,
    agent_named_empty_paths: agentNamedEmptyPaths,
    agent_named_filled_paths: agentNamedFilledPaths,
    mapper: {
      agent: agentEcho.value,
      queue: queueEcho.value,
      // Re-run through TODAY's mapper, beside event_at_ingest: a difference
      // between the two is drift in the classifier since the row was stored.
      event: String(mapped?.event || ''),
      direction: String(mapped?.direction || ''),
    },
    fields,
    candidates,
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
 * reported and honoured here exactly as the proxy honours it. Neither is a
 * TeleCMI play request with no credentials to send: that answer is knowable
 * without asking (see 'no_credentials' below), so it is not asked.
 */

/** Never more than a couple of upstream requests per click. */
const PROBE_MAX_CALLS = 2;
/** Shorter than the proxy's 15s: a diagnostic must answer, not hang. */
const PROBE_TIMEOUT_MS = 8_000;
/**
 * How many recent recording rows may be CONSIDERED before picking the ones to
 * ask about. Retention is decided in JS (recordingRetentionStatus), not in SQL,
 * so choosing "the newest one still inside the window" means reading a few rows
 * and filtering them here. Bounded like every other read on this route.
 */
const PROBE_CANDIDATE_POOL = 25;

/**
 * The whole point of the probe: exactly which of these is true.
 *
 *   plays                TeleCMI served audio. Playback works for this file.
 *   no_credentials       No App ID / secret configured, and the request would
 *                        go to TeleCMI's play route, which requires both. Not
 *                        sent — the answer is already known.
 *   credentials_rejected TeleCMI answered its authentication failure (code 407).
 *                        The App ID or the secret is wrong.
 *   request_malformed    TeleCMI answered "Parameter missing" (code 404) — OUR
 *                        request is wrong, not the credentials. That is a bug
 *                        here, not a configuration fault.
 *   not_served           TeleCMI did NOT reject the credentials and still sent
 *                        no audio for this file. On a real recording that reads
 *                        as "no such file on the account".
 *   unknown_answer       Something came back that none of the above describes.
 *                        Quoted verbatim rather than guessed at.
 *   network_error        Timeout, DNS, TLS, redirect refused — never reached.
 *   retention_blocked    Past the retention window; refused before any request.
 *   url_unusable         The stored value is not a URL this app will fetch
 *                        (not https, or a host that is not allowlisted).
 */
type ProbeVerdict =
  | 'plays'
  | 'no_credentials'
  | 'credentials_rejected'
  | 'request_malformed'
  | 'not_served'
  | 'unknown_answer'
  | 'network_error'
  | 'retention_blocked'
  | 'url_unusable';

interface ProbeReport {
  call_id: string;
  started_at: string;
  /** True when this row is demo/simulator data rather than a real recording. */
  fixture: boolean;
  /** As stored on ct_calls, credential-masked. */
  stored_url: string;
  /** What was actually requested after normalization, credential-masked. */
  fetched_url: string;
  /**
   * The recording FILENAME the request asked for — the ?file= parameter, or the
   * last path segment when the URL has no such parameter. Named in the answer
   * on purpose: "TeleCMI has no audio for this" is only actionable if you know
   * WHICH file was asked for, and a filename is not a credential. The
   * credentials are what stay hidden.
   */
  file: string;
  rewritten: boolean;
  rewrite_note: string;
  /** True when the outgoing request carried the TeleCMI appid + secret. */
  credentialed: boolean;
  retention: { expired: boolean; reason: string; days: number; expires_at: string };
  /** False when the retention gate, a missing credential or an unusable URL
   *  settled the answer before any upstream call. */
  attempted: boolean;
  upstream_status: number | null;
  upstream_content_type: string;
  /** First bytes of a NON-audio answer, verbatim and credential-masked. '' for audio. */
  body_preview: string;
  /** The vendor's own error code out of a JSON answer (407 / 404 / …), or null. */
  vendor_code: number | null;
  /** The vendor's own message, verbatim and credential-masked. '' when none. */
  vendor_message: string;
  /** True when the upstream answer is playable audio. */
  is_audio: boolean;
  /** Which of the fixed outcomes happened. */
  verdict: ProbeVerdict;
  /** Transport/guard failure (timeout, host not allowed, invalid URL). */
  error: string;
  headline: string;
}

/**
 * The vendor's own { code, msg } out of a textual answer.
 *
 * This does NOT reimplement describeTextualUpstream() in recording-fetch.ts —
 * that builds the one SENTENCE the player shows, and it stays the single place
 * that wording lives. What the probe needs is the CODE as a value, so it can
 * say "407, so the credentials are wrong" apart from "404 Parameter missing, so
 * OUR request is wrong" apart from "something else entirely". A sentence cannot
 * be branched on; a number can.
 */
function readVendorAnswer(text: string): { code: number | null; msg: string } {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      const m = (parsed as any).msg ?? (parsed as any).message;
      const c = Number((parsed as any).code);
      return {
        code: Number.isFinite(c) ? c : null,
        msg: typeof m === 'string' ? m.trim() : '',
      };
    }
  } catch { /* not JSON — an HTML error page, handled by the caller */ }
  return { code: null, msg: '' };
}

/** The filename a playback URL asks for. Not a credential — see ProbeReport. */
function fileNameOf(u: URL): string {
  const q = u.searchParams.get('file');
  if (q) return q.slice(0, VALUE_LIMIT);
  const seg = u.pathname.split('/').filter(Boolean).pop() || '';
  try { return decodeURIComponent(seg).slice(0, VALUE_LIMIT); } catch { return seg.slice(0, VALUE_LIMIT); }
}

/**
 * Would this request reach TeleCMI's play route with no credentials on it?
 *
 * Asked of the PLANNED url (telecmiPlaybackUrl has already added credentials if
 * there are any), so it is true only when there genuinely are none to add. It
 * is deliberately narrow: a recording served straight off some other host, or
 * off a TeleCMI path that is not the play route, needs no appid/secret and must
 * still be probed for real.
 */
function isUncredentialedPlayRequest(u: URL, credentialed: boolean): boolean {
  if (credentialed) return false;
  if (!hostAllowed(u.hostname, ['telecmi.com'])) return false;
  return !!u.searchParams.get('file');
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
    file: '',
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
    vendor_code: null,
    vendor_message: '',
    is_audio: false,
    verdict: 'unknown_answer',
    error: '',
    headline: '',
  };

  if (retention.expired) {
    base.verdict = 'retention_blocked';
    base.headline =
      retention.reason === 'undated'
        ? 'Not fetched: this call has no readable timestamp, so the proxy refuses it (410) before any request goes out. That is the retention rule working, not a playback fault.'
        : `Not fetched: this recording is past the ${retention.days}-day retention window, so the proxy refuses it (410) before any request goes out.`;
    return base;
  }

  // ── Plan the request WITHOUT touching the network ───────────────────────
  // Exactly what fetchAllowedRecording() is about to do internally. Doing it
  // here first costs nothing (it is pure) and buys two things a fetch cannot:
  // the filename to name in the answer, and the chance to settle "there are no
  // credentials to send" without spending a vendor request on a refusal we can
  // already predict.
  let planned: URL;
  try {
    // recordingTarget(), NOT assertAllowedRecordingUrl + telecmiPlaybackUrl.
    // THE PROBE MUST PLAN THE REQUEST EXACTLY AS THE PROXY DOES or it reports
    // on a different request than the one playback makes — which is worse than
    // no probe at all, because an admin trusts it. The two had already drifted:
    // for a stored BARE FILENAME the proxy composes it onto the vendor origin
    // and the recording plays, while validating the raw string first threw and
    // the probe announced "DOES NOT PLAY … the player refuses it with this same
    // message" about a recording that plays perfectly well.
    const plan = recordingTarget(db, storedRaw, recordingAllowlist(db));
    planned = plan.url;
    base.credentialed = plan.credentialed;
    base.rewrite_note = plan.note;
    base.rewritten = plan.changed;
    // A filename is not a credential — but this one is built from a CDR value
    // and an admin-editable base, so it goes through the same redaction as
    // every other string that leaves here rather than being trusted by type.
    base.file = redactCreds(fileNameOf(planned), creds).text;
    base.fetched_url = displayUrl(planned.toString(), creds);
  } catch (e: any) {
    base.verdict = 'url_unusable';
    // Redacted like every other string that leaves here: these particular
    // throws are fixed sentences, but an error raised while a credentialed URL
    // is in hand is exactly the kind of string that quietly carries one.
    base.error = redactCreds(String(e?.message || 'The stored recording URL cannot be fetched.'), creds).text;
    base.headline = `DOES NOT PLAY. ${base.error} — the player refuses it with this same message, before any request goes out.`;
    return base;
  }

  if (isUncredentialedPlayRequest(planned, base.credentialed)) {
    base.verdict = 'no_credentials';
    base.headline =
      'DOES NOT PLAY, and nothing was asked of TeleCMI. Playback goes to TeleCMI’s /v2/play route, which requires an App ID and an app secret, and neither is configured. '
      + 'Set them in CRM Settings and probe again; until then no recording can play, whatever the URL looks like.';
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
    const named = base.file ? `"${base.file}"` : 'this recording';

    if (ok) {
      // Cancel the byte we asked for — nothing needs it.
      try { await r.body?.cancel(); } catch { /* already closed */ }
      base.verdict = 'plays';
      base.headline = `PLAYS. TeleCMI answered ${r.status} with ${r.contentType} for ${named} — it is reachable and the player will work for it.`;
    } else {
      const preview = await peekRecordingBody(r.body);
      const flat = preview.replace(/\s+/g, ' ').trim();
      base.body_preview = redactCreds(flat, creds).text.slice(0, VALUE_LIMIT);
      const vendor = readVendorAnswer(flat);
      base.vendor_code = vendor.code;
      base.vendor_message = redactCreds(vendor.msg, creds).text.slice(0, VALUE_LIMIT);

      // ── Classify the refusal ────────────────────────────────────────────
      // The two codes below are MEASURED against rest.telecmi.com on 12 Aug
      // 2026 (read-only, junk credentials), and both arrive as HTTP 200 with
      // application/json — which is the whole reason a status-only check let
      // JSON into an <audio> element:
      //     407 "Authentication Failed"  → the appid/secret pair is refused
      //     404 "Parameter missing"      → one of appid/secret/file was absent
      // What a VALID credential plus an unknown filename answers has not been
      // measured — that needs working credentials, which this account does not
      // yet have. So it is not asserted: anything that is not the 407 is
      // reported as "the credentials were not rejected and no audio came back",
      // which is true whatever code the vendor picks for a missing file.
      const msg = base.vendor_message;
      if (vendor.code === 407 || /auth/i.test(msg)) {
        base.verdict = 'credentials_rejected';
        base.headline =
          `DOES NOT PLAY. TeleCMI REFUSED THE CREDENTIALS: "${msg || 'Authentication Failed'}" (code ${vendor.code ?? 407}). `
          + 'The App ID and app secret in CRM Settings are wrong, expired, or belong to another account — nothing will play until they are corrected. '
          + 'This is the vendor’s own answer, not our reading of it.';
      } else if (vendor.code === 404 && /parameter/i.test(msg)) {
        base.verdict = 'request_malformed';
        base.headline =
          `DOES NOT PLAY. TeleCMI says "${msg}" (code 404) — that is TeleCMI rejecting OUR request, not the credentials: `
          + 'its /v2/play route needs appid, secret and file, and one of them did not arrive. This is a fault in this app, not in the settings.';
      } else if (vendor.code !== null || msg) {
        base.verdict = 'not_served';
        base.headline =
          `DOES NOT PLAY. TeleCMI did not reject the credentials — that answer is code 407 and this is not it — but it served no audio for ${named}: `
          + `"${msg || base.body_preview}"${vendor.code !== null ? ` (code ${vendor.code})` : ''}. On a real recording that reads as "the account has no such file".`;
      } else if (r.status === 404 && /cannot\s+get/i.test(base.body_preview)) {
        // Express's unmatched-route page. Measured: /v2/play/<anything> and
        // /v2/definitely-not-a-route answer this identically, so it means the
        // PATH does not exist — not that the file does not.
        base.verdict = 'request_malformed';
        base.headline =
          'DOES NOT PLAY. TeleCMI has no route at the path this URL asks for — "Cannot GET …" is the answer it gives any address that does not exist, and it says nothing about the recording or the credentials. '
          + 'The fault is the playback URL itself: either this app built it wrongly, or the recording_base_url CRM setting points somewhere the vendor does not serve.';
      } else if (r.status === 404) {
        base.verdict = 'not_served';
        base.headline =
          `DOES NOT PLAY. TeleCMI answered 404 for ${named} and sent no machine-readable reason`
          + (base.body_preview ? `: ${base.body_preview}` : '.');
      } else {
        base.verdict = 'unknown_answer';
        base.headline =
          `DOES NOT PLAY. TeleCMI answered ${r.status} with ${r.contentType || 'no content type'} instead of audio for ${named}`
          + (base.body_preview ? `: ${base.body_preview}` : '.')
          + ' Nothing here matches a known TeleCMI answer, so it is quoted rather than interpreted.';
      }
    }
  } catch (e: any) {
    base.verdict = 'network_error';
    // REDACTED, not echoed raw. A transport error is raised while a URL
    // carrying appid + secret is in hand, and some fetch implementations put
    // the request URL in the message — the one place a credential could walk
    // out of this route in plain text.
    base.error = e?.name === 'AbortError'
      ? `The recording source did not answer within ${Math.round(PROBE_TIMEOUT_MS / 1000)} seconds.`
      : redactCreds(String(e?.message || 'The upstream request failed.'), creds).text.slice(0, VALUE_LIMIT * 2);
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

    // ── 0 · Are there credentials at all? ─────────────────────────────────
    // First, because it is first in the causal chain: TeleCMI's playback
    // endpoint requires appid + secret, so with either missing NOTHING can
    // play and every other panel here is describing a URL that was never going
    // to be served. BOOLEANS AND A SOURCE ONLY — see the leak note in the
    // header. telecmiCredentialStatus() also carries a short masked tail for
    // the Settings screen; the block below names the fields it copies one by
    // one precisely so that tail is left behind rather than spread through.
    const credStatus = telecmiCredentialStatus(db);
    let credHeadline: string;
    if (!credStatus.appid.set && !credStatus.secret.set) {
      credHeadline =
        'NEITHER the TeleCMI App ID nor the app secret is configured. TeleCMI’s playback endpoint requires both, so no recording can play — this alone is enough to explain a dead play button. Set them in CRM Settings.';
    } else if (!credStatus.secret.set) {
      credHeadline = 'The TeleCMI App ID is configured but the app secret is NOT. Playback needs both, so nothing can play.';
    } else if (!credStatus.appid.set) {
      credHeadline = 'The TeleCMI app secret is configured but the App ID is NOT. Playback needs both, so nothing can play.';
    } else if (credStatus.overridden) {
      credHeadline =
        'Both credentials are configured — but an ENVIRONMENT VARIABLE is in force and is shadowing a value saved in Settings. Anything typed on the Settings screen is being ignored until that variable is unset and the server restarted. If a freshly-saved credential appears to change nothing, this is why.';
    } else {
      credHeadline = `Both credentials are configured (from ${credStatus.appid.source === 'env' ? 'environment variables' : 'CRM Settings'}). Whether TeleCMI ACCEPTS them is a different question — only the playback probe below can answer that.`;
    }
    const credentials = {
      configured: credStatus.configured,
      appid: { set: credStatus.appid.set, source: credStatus.appid.source, overridden: credStatus.appid.overridden },
      secret: { set: credStatus.secret.set, source: credStatus.secret.source, overridden: credStatus.secret.overridden },
      overridden: credStatus.overridden,
      headline: credHeadline,
    };

    // ── 0b · Which base is a bare filename joined onto? ───────────────────
    // A STORED ct_settings row BEATS the shipped default, silently and
    // permanently. That matters right now: the default was changed from the
    // path form (https://rest.telecmi.com/v2/play/<file>, a route TeleCMI does
    // not have) to the documented query form (…/v2/play?file=<file>), and any
    // deployment carrying a hand-set row still builds the dead shape and will
    // look exactly as broken as before the fix. This says so out loud instead
    // of leaving someone to wonder why the same code behaves differently on
    // two boxes. Not a credential — see the note on the constant in settings.ts.
    const baseRow = db.prepare(`
      SELECT value FROM ct_settings WHERE key = 'recording_base_url'
    `).get() as { value?: string } | undefined;
    const effectiveBase = ctRecordingBaseUrl(db);
    // Measured dead: /v2/play/<anything> is Express's unmatched-route 404. A
    // base with NO query is the one the mapper appends as a path segment, so
    // "ends at /v2/play and carries no ?" is exactly the broken combination.
    const deadPathShape = !effectiveBase.includes('?') && /\/v2\/play\/?$/.test(effectiveBase);
    let baseHeadline: string;
    if (!baseRow) {
      baseHeadline = deadPathShape
        ? 'No recording_base_url row — using the shipped default, and that default is the dead path form. This is a code fault, not a configuration one.'
        : 'No recording_base_url row — using the shipped default, which is TeleCMI’s documented /v2/play?file=<filename> form.';
    } else if (!effectiveBase) {
      baseHeadline = 'recording_base_url is set to BLANK, which deliberately turns joining OFF: a CDR that carries a bare filename is stored with no URL at all and can never play. Delete the row to fall back to the shipped default.';
    } else if (deadPathShape) {
      baseHeadline = 'recording_base_url is set to the /v2/play/<file> PATH form, which TeleCMI does not serve — it answers "Cannot GET" to any such address. This stored row OVERRIDES the shipped default, so fixing the default in code changes nothing here: clear this row (or set it to https://rest.telecmi.com/v2/play?file=) and future recordings will be stored with a URL that works.';
    } else if (effectiveBase !== RECORDING_BASE_URL_DEFAULT) {
      baseHeadline = 'recording_base_url is set to a custom value, which overrides the shipped default. Anything a CDR filename is joined onto still has to pass the host allowlist below.';
    } else {
      baseHeadline = 'recording_base_url is stored, and it matches the shipped default.';
    }
    const recordingBase = {
      // Redacted like every other echoed string: an admin can paste anything
      // here, including a URL with a token in it.
      value: redactCreds(effectiveBase, creds).text.slice(0, VALUE_LIMIT * 2),
      source: !baseRow ? 'default' : effectiveBase ? 'db' : 'blank',
      matches_default: effectiveBase === RECORDING_BASE_URL_DEFAULT,
      dead_path_shape: deadPathShape,
      headline: baseHeadline,
    };

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

    // ── 4b · WHO ANSWERED, on the live events ─────────────────────────────
    // Filtered on the STORED event column, which is the mapper's OWN
    // classification written at ingest (ingestLive() in src/lib/ct/ingest.ts
    // stores m.event) — so "event = 'answer'" IS "this payload parses to an
    // answered event", read back rather than recomputed over the whole table.
    // Each selected row is then re-run through today's mapper anyway, and
    // event_now beside event_at_ingest exposes any drift since it was stored.
    const liveAnswerRows = db.prepare(`
      SELECT id, received_at, telecmi_call_id, event, payload
        FROM ct_webhook_log
       WHERE kind = 'live' AND event = 'answer'
       ORDER BY received_at DESC, rowid DESC
       LIMIT ?
    `).all(LIVE_AGENT_LIMIT) as any[];
    const liveAnswers = liveAnswerRows.map(r => describeLiveAnswer(r, creds));
    const withAgent = liveAnswers.filter(r => !!r.mapper_agent).length;
    const anonymous = liveAnswers.length - withAgent;
    const candidateKeys = Array.from(new Set(
      liveAnswers.flatMap(r => r.fields.filter(f => f.agent_like && !f.mapper_reads_as_agent && f.value).map(f => f.path)),
    ));

    let liveAgentHeadline: string;
    if (liveCount === 0) {
      liveAgentHeadline =
        'No live (screen-pop) event has ever reached this server, so there is nothing to say about who answered. Until live events arrive the pop cannot name anybody, whatever the mapper does.';
    } else if (liveAnswers.length === 0) {
      liveAgentHeadline =
        `${liveCount} live event${liveCount === 1 ? ' has' : 's have'} been logged but NOT ONE of them parsed as an ANSWER. The pop therefore never had an answered event to take a name from — the gap is upstream of the agent key entirely: TeleCMI is not sending an answer event, or it is arriving in a shape the mapper classifies as something else.`;
    } else if (anonymous === 0) {
      liveAgentHeadline =
        `Every one of the last ${liveAnswers.length} answered live event${liveAnswers.length === 1 ? '' : 's'} named an agent the mapper could read. A pop showing no name is therefore NOT a mapping-key fault — look at whether the pop received the event at all.`;
    } else if (candidateKeys.length) {
      liveAgentHeadline =
        `${anonymous} of the last ${liveAnswers.length} answered live events named NO agent the mapper reads — but those payloads DO carry agent-shaped fields the mapper ignores: ${candidateKeys.join(', ')}. If one of those is the answerer, adding its spelling to AGENT_KEYS in src/lib/ct/telecmi-mapper.ts is the entire fix.`;
    } else {
      liveAgentHeadline =
        `${anonymous} of the last ${liveAnswers.length} answered live events named no agent, and none of them carries a field whose NAME looks like an agent/user/extension. Read the per-event key lists below before concluding TeleCMI never sends it: a key called something else entirely (ans_by, handled_by, a bare extension column) would look exactly like this, and adding its spelling to AGENT_KEYS in src/lib/ct/telecmi-mapper.ts would fix every future call. If no key there is the answerer, the live answer genuinely does not carry it and the name can only come from the CDR after the call.`;
    }

    const liveAgent = {
      limit: LIVE_AGENT_LIMIT,
      answered_events: liveAnswers.length,
      with_agent: withAgent,
      without_agent: anonymous,
      /** Agent-shaped keys seen carrying a value that the mapper does NOT read.
       *  This is the shortlist a fix would be chosen from. */
      unread_agent_keys: candidateKeys,
      events: liveAnswers,
      headline: liveAgentHeadline,
    };

    // ── 4c · RINGING — FOR WHOM, on the live RING events ──────────────────
    // Same table, same filter style as 4b, same read-only bounds — only the
    // classification differs: event = 'ring' rather than 'answer'. See the big
    // block comment above describeLiveRing() for why this panel exists and how
    // its answer is meant to be read.
    //
    // The breakdown is taken FIRST and over every live row, because the most
    // likely answer on this account is "there are no ring rows", and that must
    // be reported as a fact about the feed rather than as an empty panel. It is
    // one grouped count over an already-filtered kind, not a scan of anything.
    const liveEventBreakdown = (db.prepare(`
      SELECT COALESCE(NULLIF(event, ''), '(unclassified)') AS event, COUNT(*) AS n
        FROM ct_webhook_log
       WHERE kind = 'live'
       GROUP BY 1
       ORDER BY n DESC
    `).all() as any[]).map(r => ({ event: String(r?.event || ''), n: Number(r?.n || 0) }));
    const ringTotal = Number((db.prepare(`
      SELECT COUNT(*) AS n FROM ct_webhook_log WHERE kind = 'live' AND event = 'ring'
    `).get() as any)?.n || 0);

    const liveRingRows = ringTotal
      ? db.prepare(`
          SELECT id, received_at, telecmi_call_id, event, payload
            FROM ct_webhook_log
           WHERE kind = 'live' AND event = 'ring'
           ORDER BY received_at DESC, rowid DESC
           LIMIT ?
        `).all(LIVE_RING_LIMIT) as any[]
      : [];
    // ONE memo for the whole batch — see RingProbeMemo. The same key names
    // repeat on every ring, and re-asking the mapper about each of them once per
    // row is both wasted work and a wall of duplicate warnings in the log.
    const ringMemo = newRingProbeMemo();
    const liveRings = liveRingRows.map(r => describeLiveRing(r, creds, ringMemo));
    const ringWithAgent = liveRings.filter(r => !!r.mapper.agent).length;
    const ringWithoutAgent = liveRings.length - ringWithAgent;
    const ringWithQueue = liveRings.filter(r => !!r.mapper.queue).length;
    const ringWithheld = liveRings.reduce((n, r) => n + r.caller_side_withheld, 0);
    const ringIdentityWithheld = liveRings.reduce((n, r) => n + r.identity_withheld, 0);
    const ringDeeper = liveRings.reduce((n, r) => n + r.deeper_nesting, 0);
    // Rings where the mapper read nothing while a key it DOES read carried a
    // value — an empty earlier spelling shadowing a filled nested one. It is a
    // different fault from "no spelling matches" and points at a different fix,
    // so it gets its own branch rather than being folded into "nothing found".
    const ringShadowed = liveRings.filter(r => r.shadowed_agent_paths.length > 0);
    const ringShadowPaths = Array.from(new Set(ringShadowed.flatMap(r => r.shadowed_agent_paths)));
    const ringBlockPaths = Array.from(new Set(ringShadowed.flatMap(r => r.blocking_agent_paths)));
    // Agent-NAMED fields across the examined rings, split the same way the
    // per-ring report splits them. Kept apart from the shortlist: these are
    // fields the payload DOES carry under an agent-sounding name, and the last
    // headline branch must not say they do not exist.
    //
    // BOTH OF THESE WERE COMPUTED AND THEN NEVER READ. Every branch below went
    // straight from "no candidates" to "NOT ONE field on any of them holds a
    // value shaped like an extension … Stop promising more than that until a
    // ring payload proves otherwise" — the one sentence on this panel written to
    // END the investigation — while `agent: ""` on every ring said something
    // quite different, and the per-ring headline underneath said it correctly.
    // The headline the owner reads first was the only one that did not know.
    const ringAgentNamedEmpty = Array.from(new Set(liveRings.flatMap(r => r.agent_named_empty_paths)));
    const ringAgentNamedFilled = Array.from(new Set(liveRings.flatMap(r => r.agent_named_filled_paths)));
    // Oldest/newest of the rows ACTUALLY EXAMINED — "over what period", so a
    // shortlist drawn from three rings last March is not read as current.
    const ringDates = liveRings.map(r => r.received_at).filter(Boolean).sort();
    const ringOldest = ringDates[0] || '';
    const ringNewest = ringDates[ringDates.length - 1] || '';

    /**
     * THE SHORTLIST, pooled across every examined ring and ranked.
     *
     * Pooled because one payload is an anecdote: a field that turns up on every
     * ring with an extension-shaped value is a far stronger lead than one that
     * appeared once, and `seen_on` is what lets the reader tell those apart. The
     * score is the best any single row gave it; ties break on how often it was
     * seen, then on the name, so the order is stable between loads.
     */
    const ringCandidatePool = new Map<string, { path: string; score: number; why: Set<string>; seen_on: number; in_mapper_reach: boolean }>();
    for (const ev of liveRings) {
      // seen_on IS RENDERED AS "n of N rings", so it has to count RINGS. Paths
      // are digit-masked (safeName), so two keys of a per-leg map keyed by phone
      // number now share one path — and a per-field += 1 would have printed
      // "seen on 3 of 1". Counted once per ring per path instead.
      const seenThisRing = new Set<string>();
      for (const f of ev.fields) {
        if (!f.candidate) continue;
        const firstHereForPath = !seenThisRing.has(f.path);
        seenThisRing.add(f.path);
        const cur = ringCandidatePool.get(f.path);
        if (cur) {
          cur.score = Math.max(cur.score, f.candidate_score);
          if (firstHereForPath) cur.seen_on += 1;
          for (const w of f.candidate_why) cur.why.add(w);
          cur.in_mapper_reach = cur.in_mapper_reach || f.in_mapper_reach;
        } else {
          ringCandidatePool.set(f.path, {
            path: f.path,
            score: f.candidate_score,
            why: new Set(f.candidate_why),
            seen_on: 1,
            in_mapper_reach: f.in_mapper_reach,
          });
        }
      }
    }
    const ringCandidates = Array.from(ringCandidatePool.values())
      .sort((a, b) => b.score - a.score || b.seen_on - a.seen_on || a.path.localeCompare(b.path))
      .map(c => ({
        path: c.path,
        score: c.score,
        seen_on: c.seen_on,
        in_mapper_reach: c.in_mapper_reach,
        why: Array.from(c.why),
      }));
    // A lead the mapper's collect() could never reach is still shown — but it is
    // NOT the one to act on, because no AGENT_KEYS spelling would pick it up.
    const actionableRingCandidates = ringCandidates.filter(c => c.in_mapper_reach);

    let liveRingHeadline: string;
    if (liveCount === 0) {
      liveRingHeadline =
        'No live (screen-pop) event of any kind has ever reached this server, so there is no ring payload to examine and nothing can be said about who a call is ringing. This is a webhook question, not a mapper question.';
    } else if (ringTotal === 0) {
      liveRingHeadline =
        `${liveCount} live event${liveCount === 1 ? ' has' : 's have'} been logged but NOT ONE is classified as a RING (${liveEventBreakdown.map(b => `${b.event}: ${b.n}`).join(', ') || 'no events'}). `
        + 'THIS IS NOT EVIDENCE THAT A RING PAYLOAD CARRIES NO AGENT — it means none has ever been captured here, so there is nothing to read. Until a ring event arrives, the ring group is the only honest answer to "for whom is it ringing".';
    } else if (liveRings.length === 0) {
      liveRingHeadline =
        `${ringTotal} ring event${ringTotal === 1 ? ' is' : 's are'} logged but none could be read back. That is a fault in this diagnostic or in the stored rows, not an answer about the payload.`;
    } else if (ringWithoutAgent === 0) {
      liveRingHeadline =
        `Every one of the last ${liveRings.length} ring${liveRings.length === 1 ? '' : 's'} DOES name an agent the mapper reads. "Ringing — <name>" is therefore already available on this account: if the screen still says "Extension not reported", the gap is between the mapper and the screen, not in the payload.`;
    } else if (ringShadowed.length) {
      liveRingHeadline =
        `${ringShadowed.length} of the last ${liveRings.length} ring${liveRings.length === 1 ? '' : 's'} CONTRADICT themselves: the mapper read no agent, yet a field it does read as the agent carries a READABLE value on that same payload (${ringShadowPaths.slice(0, 4).join(', ')}${ringShadowPaths.length > 4 ? ', …' : ''}). `
        + (ringBlockPaths.length
          ? `The blocker is ${ringBlockPaths.slice(0, 4).join(', ')}${ringBlockPaths.length > 4 ? ', …' : ''} — ${ringBlockPaths.length === 1 ? 'that key holds' : 'those keys hold'} something the mapper cannot read as text (a blank, an object or a list). `
          : '')
        + 'The mapper keeps the FIRST key of a given name it meets, so an unreadable one at the top of the payload shadows a filled one nested below it, and no spelling added to AGENT_KEYS would change that. The fix is in how the mapper collects keys — skip a value it cannot read and keep looking — and it belongs to whoever owns src/lib/ct/telecmi-mapper.ts.';
    } else if (actionableRingCandidates.length) {
      const top = actionableRingCandidates.slice(0, 3).map(c => `${c.path} (seen on ${c.seen_on} of ${liveRings.length})`).join(', ');
      liveRingHeadline =
        `${ringWithoutAgent} of the last ${liveRings.length} ring${liveRings.length === 1 ? '' : 's'} named NO agent the mapper reads — but the payloads DO carry unread fields whose values are shaped like an extension or an identity. Best first: ${top}. `
        + 'THIS IS A LEAD, NOT A FIX. pickAgent() in src/lib/ct/telecmi-mapper.ts is event-blind — the same function answers for ring, for answer and for the CDR, and its result drives who a call is attributed to. Before any of these spellings goes into AGENT_KEYS, check what that same key holds on an ANSWERED payload (the live_agent block of this same response reports them field by field); a wrong spelling would silently mis-attribute who picked up, which is worse than the missing label.';
    } else if (ringCandidates.length) {
      liveRingHeadline =
        `${ringWithoutAgent} of the last ${liveRings.length} ring${liveRings.length === 1 ? '' : 's'} named no agent. Fields with extension-shaped values DO exist on these payloads, but every one of them is nested somewhere the mapper's collect() never descends into, so NO spelling added to AGENT_KEYS would reach them. Reading them would take a change to the mapper's envelope handling, not to its key list.`;
    } else if (ringAgentNamedFilled.length) {
      // MIRRORS THE PER-RING CHAIN, and it has to. These two branches did not
      // exist here at all: the pooled headline dropped straight from "no
      // candidates" to the closing verdict below, so the card's top line said
      // "not one field holds a value shaped like an extension" while the
      // per-ring headline in the collapsed section underneath said "this ring
      // DOES carry a field named like an agent field". The summary contradicting
      // its own evidence, with the summary read first and believed.
      liveRingHeadline =
        `${ringWithoutAgent} of the last ${liveRings.length} ring${liveRings.length === 1 ? '' : 's'} named no agent and nothing became a lead — but ${ringAgentNamedFilled.length === 1 ? 'a field named like an agent field DOES carry a value' : `${ringAgentNamedFilled.length} fields named like an agent field DO carry values`} on these payloads (${ringAgentNamedFilled.slice(0, 4).join(', ')}${ringAgentNamedFilled.length > 4 ? ', …' : ''}). `
        + `${ringAgentNamedFilled.length === 1 ? 'It was' : 'They were'} left off the shortlist because this panel will not act on ${ringAgentNamedFilled.length === 1 ? 'it' : 'them'} — a name that reads as a credential, a value carrying one of this account's credentials, or a key the mapper already reads. Open "Field-by-field, ring by ring" below: the reason is printed on the row. Do not read this as "TeleCMI sends nothing".`;
    } else if (ringAgentNamedEmpty.length) {
      liveRingHeadline =
        `${ringWithoutAgent} of the last ${liveRings.length} ring${liveRings.length === 1 ? '' : 's'} named no agent, and no field on them holds a value shaped like an extension, an email or a person's name — but the payloads DO carry ${ringAgentNamedEmpty.length === 1 ? 'a field named like an agent field' : `${ringAgentNamedEmpty.length} fields named like an agent field`} (${ringAgentNamedEmpty.slice(0, 4).join(', ')}${ringAgentNamedEmpty.length > 4 ? ', …' : ''}) with nothing in ${ringAgentNamedEmpty.length === 1 ? 'it' : 'them'} at all. `
        + 'That is TeleCMI sending the key and leaving it EMPTY at ring time — a different answer from "we are missing a spelling", and one no addition to AGENT_KEYS could fix. It is worth asking TeleCMI to populate it before anything is changed here.';
    } else {
      liveRingHeadline =
        `${ringWithoutAgent} of the last ${liveRings.length} ring${liveRings.length === 1 ? '' : 's'} named no agent, and NOT ONE field on any of them holds a value shaped like an extension, an email or a person's name`
        + (ringWithheld ? ` (${ringWithheld} caller-side field${ringWithheld === 1 ? ' was' : 's were'} deliberately not read — those describe the guest)` : '')
        // THE SECOND HEDGE, and it was missing here while the per-ring headline
        // carried it. This sentence ends the investigation; every part of the
        // payload the walk did not open has to be named in it.
        + (ringDeeper ? ` (${ringDeeper} field${ringDeeper === 1 ? ' nests' : 's nest'} deeper than this panel walks, and ${ringDeeper === 1 ? 'its contents were' : 'their contents were'} never examined)` : '')
        + `. On this evidence the live ring payload on this account genuinely does not say which phone it is ringing`
        + (ringWithQueue ? `, and the ring GROUP — which ${ringWithQueue} of these rings does carry — is the best answer that exists.` : '. Not even a ring group is carried, so the ring event says nothing about routing at all.')
        + ' The names on "did not pick up" come from the per-leg MISSED CDR after the fact, and that remains the only source of a person\'s name for an unanswered call. Stop promising more than that until a ring payload proves otherwise.';
    }

    const liveRing = {
      limit: LIVE_RING_LIMIT,
      /** Every live row by classification — so "no rings" is a stated fact. */
      live_event_breakdown: liveEventBreakdown,
      ring_events_total: ringTotal,
      examined: liveRings.length,
      /** The period the examined rings span. '' when none were examined. */
      oldest_at: ringOldest,
      newest_at: ringNewest,
      with_agent: ringWithAgent,
      without_agent: ringWithoutAgent,
      with_queue: ringWithQueue,
      caller_side_withheld: ringWithheld,
      /** Values declined because they were identity-shaped under a field name
       *  that attributes them to neither staff nor a ring group. */
      identity_withheld: ringIdentityWithheld,
      /** Fields nested deeper than this panel walks. The second half of the
       *  honesty hedge on "nothing was found". */
      deeper_nesting: ringDeeper,
      /** Agent-NAMED fields the vendor sends with nothing in them, pooled. Named
       *  in the response and not only inside a sentence, because "the key is
       *  there and blank" is the finding somebody has to take to TeleCMI. */
      agent_named_empty: ringAgentNamedEmpty,
      /** Agent-NAMED fields that DO carry something and still are not leads. */
      agent_named_filled: ringAgentNamedFilled,
      /** THE SHORTLIST: unread fields whose value looks like an extension or an
       *  agent identity, pooled across the examined rings and ranked. */
      candidate_keys: ringCandidates,
      events: liveRings,
      headline: liveRingHeadline,
    };

    // ── 5 · Upstream probe (opt-in) ───────────────────────────────────────
    // Off unless asked for, so opening the Telephony page never touches
    // TeleCMI. See the block comment above probeCall() for the bounds.
    let probe: {
      ran: boolean;
      limit: number;
      candidates: number;
      pool: number;
      /** How many of the pool were skipped for being past retention. */
      expired_skipped: number;
      calls: ProbeReport[];
      /** The single outcome the whole probe amounts to. */
      verdict: ProbeVerdict | 'nothing_to_probe';
      headline: string;
    } | null = null;
    if (new URL(req.url).searchParams.get('probe') === '1') {
      /**
       * WHICH ROWS TO ASK ABOUT — real before fake, live before expired.
       *
       * A synthetic filename cannot tell "the credentials are wrong" from "no
       * such file", because both refuse. A REAL recording that is still inside
       * the retention window can, so it is what gets asked about whenever one
       * exists. Retention is decided by recordingRetentionStatus() in JS, not
       * in SQL, so the pool is read here (bounded) and filtered below; probing
       * an expired row would only ever report the 410 the proxy already gives.
       */
      const pool = db.prepare(`
        SELECT id, recording_url, started_at, created_at, telecmi_call_id,
               CASE WHEN recording_url LIKE '%/play/seed-%'
                      OR recording_url LIKE '%file=sim-%'
                      OR COALESCE(telecmi_call_id, '') LIKE 'seed-%'
                    THEN 1 ELSE 0 END AS fixture
          FROM ct_calls
         WHERE COALESCE(recording_url, '') <> ''
         ORDER BY fixture ASC, COALESCE(NULLIF(started_at, ''), created_at) DESC
         LIMIT ?
      `).all(PROBE_CANDIDATE_POOL) as any[];

      const live = pool.filter(r => !recordingRetentionStatus(db, r).expired);
      const expiredSkipped = pool.length - live.length;
      // Prefer live rows (already real-first, newest-first from the query). If
      // EVERY row is expired, still report one so the answer is "retention
      // refused it" rather than a blank panel.
      const candidates = (live.length ? live : pool).slice(0, PROBE_MAX_CALLS);

      const reports: ProbeReport[] = [];
      for (const row of candidates) reports.push(await probeCall(db, row, creds));

      // ONE verdict for the whole run, in the order that matters to the reader:
      // the thing they must fix first wins.
      const has = (v: ProbeVerdict) => reports.some(r => r.verdict === v);
      let verdict: ProbeVerdict | 'nothing_to_probe';
      let headline: string;
      if (reports.length === 0) {
        verdict = 'nothing_to_probe';
        headline = 'No call in the log holds a recording URL, so there is nothing to probe. Nothing can be said about playback until a CDR carrying a recording arrives.';
      } else if (has('plays')) {
        verdict = 'plays';
        headline = 'TeleCMI served audio for at least one stored recording, so the fetch chain works end to end. A recording that still will not play is a fault on that specific call, not on the URL we build.';
      } else if (has('no_credentials')) {
        verdict = 'no_credentials';
        headline = 'NOTHING CAN PLAY: no TeleCMI App ID and app secret are configured, and the vendor’s playback endpoint requires both. Nothing was asked of TeleCMI — that answer needs no request. Set them in CRM Settings and probe again.';
      } else if (has('credentials_rejected')) {
        verdict = 'credentials_rejected';
        headline = 'NOTHING CAN PLAY: TeleCMI REFUSED THE CREDENTIALS (its code 407). The App ID and app secret in CRM Settings are wrong, expired, or belong to a different account. Everything else in the chain is fine — fix these and probe again.';
      } else if (has('request_malformed')) {
        verdict = 'request_malformed';
        headline = 'TeleCMI rejected the shape of OUR request (its code 404, "Parameter missing"), not the credentials. That is a bug in this app’s playback URL, and it is fixed in code, not in settings.';
      } else if (reports.every(r => r.verdict === 'retention_blocked')) {
        verdict = 'retention_blocked';
        headline = 'Every stored recording is past the retention window, so none was fetched. That is the privacy rule working — widen the window above to test playback.';
      } else if (has('network_error')) {
        verdict = 'network_error';
        headline = 'TeleCMI could not be reached at all. This is a network or timeout fault between this server and the vendor, not a credential or URL problem — the per-call line below has the exact error.';
      } else if (has('not_served')) {
        verdict = 'not_served';
        headline = reports.every(r => r.fixture)
          ? 'The credentials were not rejected, but TeleCMI served no audio — and every row available to probe is a DEMO FIXTURE, so it asked for a filename that never existed on the account. That is the expected answer for made-up data, and it proves the endpoint and the credentials are reachable, nothing more. It cannot prove a real recording plays until a real one is stored.'
          : 'The credentials were not rejected, but TeleCMI served no audio for the recording it was asked for. On a real recording that means the account holds no such file — the filename in the call row and the one on the account do not match.';
      } else if (reports.every(r => r.verdict === 'url_unusable')) {
        verdict = 'url_unusable';
        headline = 'Nothing was asked of TeleCMI: the stored recording URLs are not fetchable by this app at all — not HTTPS, or on a host the allowlist does not cover. The per-call line below carries the exact refusal, and it is the same one the player gives.';
      } else {
        verdict = 'unknown_answer';
        headline = 'TeleCMI answered with something that matches none of its known replies. The per-call line below quotes it verbatim rather than guessing at it.';
      }

      probe = {
        ran: true,
        limit: PROBE_MAX_CALLS,
        candidates: candidates.length,
        pool: pool.length,
        expired_skipped: expiredSkipped,
        calls: reports,
        verdict,
        headline,
      };
    }

    return Response.json({
      generated_at: new Date().toISOString(),
      credentials,
      recording_base: recordingBase,
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
      // ADDITIVE: who answered, off the LIVE events. Nothing above it changes.
      live_agent: liveAgent,
      // ADDITIVE: who a call is RINGING, off the LIVE ring events. Same table,
      // same bounds, nothing above it changes.
      live_ring: liveRing,
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
