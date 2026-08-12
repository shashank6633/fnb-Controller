/**
 * Call-to-Table — SSRF-safe recording fetch (shared by the recording proxy
 * route, the AI analyze lib and the admin recording diagnostic).
 *
 * A recording_url originates in a TeleCMI CDR payload (token-gated, but treated
 * as untrusted). We only ever fetch HTTPS URLs on an allowlisted host
 * (*.telecmi.com by default, extendable via the ct_settings
 * 'recording_host_allowlist' key), and follow redirects MANUALLY, re-validating
 * the host on every hop — so a planted or redirecting URL can never reach an
 * internal address (metadata, localhost, …).
 *
 * ── THE VENDOR PLAYBACK CONTRACT ──────────────────────────────────────────
 * From TeleCMI's own documentation (doc.telecmi.com/chub/docs/play-record):
 *
 *   GET https://rest.telecmi.com/v2/play?appid=<appid>&secret=<secret>&file=<filename>
 *
 *   appid   number, query string, REQUIRED
 *   secret  string, query string, REQUIRED
 *   file    string, query string, REQUIRED — the FILENAME of the recording
 *   200 → the audio itself, streamable (content-type is not documented)
 *   407 → invalid authentication / credentials failed
 *   404 → a required parameter is missing
 *
 * Re-measured against the live endpoint on 12 Aug 2026 with BOGUS credentials,
 * read-only GETs, and it matches the doc exactly:
 *
 *   GET /v2/play?appid=1&secret=x&file=y.wav
 *        → HTTP 200, Content-Type: application/json; charset=utf-8
 *          {"code":407,"error":true,"msg":"Authentication Failed"}
 *   GET /v2/play  (no parameters)
 *        → HTTP 200, application/json
 *          {"code":404,"error":true,"msg":"Parameter missing"}
 *   GET /v2/play/<anything>
 *        → HTTP 404 text/html "Cannot GET /v2/play/…", byte-identical in form
 *          to /v2/definitely-not-a-route. THERE IS NO PATH-SEGMENT PLAY ROUTE.
 *
 * Three consequences, and this file handles all three:
 *
 *  1 THE STORED URL SHAPE IS DEAD ON EVERY EXISTING ROW. ct_calls rows written
 *    before this fix hold https://rest.telecmi.com/v2/play/<filename> — the
 *    path form, which has no route — and some hold a bare filename. ingest is
 *    first-write-wins, so those rows keep their value forever. recordingTarget()
 *    therefore rebuilds BOTH shapes into the documented query form at FETCH
 *    TIME and adds the credentials there: the app secret is never written to
 *    ct_calls.recording_url, and old rows are repaired on read rather than by a
 *    migration. (RECORDING_BASE_URL_DEFAULT in ./settings.ts now builds the
 *    query form directly for NEW rows; that shape passes through here needing
 *    only the credentials.)
 *
 *  2 TELECMI REPORTS ITS ERRORS AS HTTP 200. A status-only check passes them
 *    straight through, and an <audio> element handed JSON renders a silent
 *    0:00/0:00 with a dead grey play button — the exact symptom reported. So a
 *    2xx is only streamed when it is genuinely NOT a vendor error envelope:
 *    checked first by content-type, and then by sniffing the head of the body
 *    (the bytes are put back before streaming — see sniffVendorEnvelope).
 *
 *  3 NOTHING PLAYS WITHOUT REAL CREDENTIALS. appid + secret are required by the
 *    endpoint, so when they are not configured this refuses BEFORE the network
 *    with reason 'not_configured' rather than sending a request the vendor is
 *    documented to reject.
 *
 * ── THE SECRET NEVER LEAVES THIS PROCESS ──────────────────────────────────
 * The credentials are read here, put on the outbound query string, and appear
 * nowhere else. FetchedRecording.finalUrl carries them and is marked ADMIN-ONLY
 * (the diagnostic redacts it; the playback route never touches it). Every
 * message this module THROWS is passed through scrubCredentials() first,
 * because src/lib/ct/analyze.ts persists a failed fetch's message into
 * ct_calls.analysis_error, where it would become a stored, displayable row.
 */
import type Database from 'better-sqlite3';
import { ctSetting, telecmiAppId, telecmiSecret } from './settings';

/** host is allowed if it equals, or is a subdomain of, an allowlist entry. */
export function hostAllowed(host: string, allow: string[]): boolean {
  const h = host.toLowerCase();
  return allow.some(a => {
    const base = a.replace(/^\./, '').toLowerCase();
    return h === base || h.endsWith('.' + base);
  });
}

export function recordingAllowlist(db: Database.Database): string[] {
  const base = ['telecmi.com'];
  try {
    const extra = (ctSetting(db, 'recording_host_allowlist') || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    return [...new Set([...base, ...extra])];
  } catch { return base; }
}

/* ── Failure taxonomy ──────────────────────────────────────────────────────
 *
 * WHY A CODE AND NOT JUST A SENTENCE. Three different callers need to react
 * differently to the same fetch: the proxy picks an HTTP status, the analyzer
 * decides whether retrying could ever help, and the diagnostic groups rows. A
 * sentence is for the human; the reason is for the code. Both travel together.
 */
export type RecordingFailureReason =
  /** appid and/or secret are not configured, so the documented required
   *  parameters cannot be sent. Refused before any network call. */
  | 'not_configured'
  /** The vendor answered 407 / "Authentication Failed" — the configured
   *  appid+secret pair is wrong or not entitled to this recording. */
  | 'credentials_rejected'
  /** Nothing on the row names a recording to fetch. */
  | 'no_filename'
  /** The vendor says there is no such recording (HTTP 404, or a 200 envelope
   *  whose message says so). */
  | 'file_not_found'
  /** The stored value is not a URL and not a usable bare filename. */
  | 'invalid_url'
  /** https-only + host allowlist refused it, on the first request or on a
   *  redirect hop. */
  | 'host_not_allowed'
  /** The upstream did not answer in time (the caller's AbortSignal fired). */
  | 'timeout'
  /** DNS / TLS / connection-level failure. */
  | 'network'
  /** The vendor says a required parameter is missing — the request SHAPE is
   *  wrong, not the credentials and not the file. */
  | 'bad_request'
  /** The vendor answered, but with something we cannot serve as audio. */
  | 'upstream_error';

export class RecordingFetchError extends Error {
  readonly reason: RecordingFailureReason;
  /** The upstream HTTP status, when there was one. */
  readonly upstreamStatus: number | null;
  /**
   * Did the request that produced this failure actually carry an App ID and a
   * secret? null when no request went out. A BOOLEAN, never the values — it
   * exists so the UI can separate "never configured" from "configured and
   * refused", which TeleCMI itself does not distinguish (407 to both).
   */
  readonly credentialed: boolean | null;
  constructor(
    reason: RecordingFailureReason,
    message: string,
    upstreamStatus: number | null = null,
    credentialed: boolean | null = null,
  ) {
    super(message);
    this.name = 'RecordingFetchError';
    this.reason = reason;
    this.upstreamStatus = upstreamStatus;
    this.credentialed = credentialed;
  }
}

/** Narrowing helper — an unknown thrown value → its reason, or a default. */
export function recordingFailureReason(e: unknown, fallback: RecordingFailureReason = 'upstream_error'): RecordingFailureReason {
  return e instanceof RecordingFetchError ? e.reason : fallback;
}

/* ── Credential scrubbing ──────────────────────────────────────────────────*/

/**
 * Remove anything credential-shaped from a string that is about to be thrown,
 * logged, stored or displayed.
 *
 * TWO PASSES, ON PURPOSE. The literal pass catches the configured values even
 * when they turn up somewhere unexpected (a vendor echoing our query string
 * back inside an error body). The pattern pass catches a credential we do NOT
 * hold — an admin-configured pre-signed URL whose token is somebody else's.
 * Values shorter than 6 characters are not matched literally: a 3-character
 * "secret" would redact half the sentence.
 */
export function scrubCredentials(text: string, needles: string[]): string {
  let t = String(text ?? '');
  for (const n of needles) {
    if (n && n.length >= 6) t = t.split(n).join('REDACTED');
  }
  return t.replace(/((?:[?&]|\b)(?:secret|appid|token|apikey|api_key|key|auth)=)[^&\s"'<>]+/gi, '$1REDACTED');
}

/** The configured credentials, for scrubCredentials(). Never returned to a
 *  caller — this is only ever fed straight back into the scrubber. */
function credentialNeedles(db: Database.Database | null): string[] {
  const out: string[] = [];
  try { const a = telecmiAppId(db); if (a) out.push(a); } catch { /* unconfigured */ }
  try { const s = telecmiSecret(db); if (s) out.push(s); } catch { /* unconfigured */ }
  return out;
}

/** Validate a URL string against the allowlist. Returns the URL or throws.
 *  The two message strings are asserted verbatim by the admin recording
 *  diagnostic so its verdict and the proxy's can never disagree — do not
 *  reword them without changing that route too. */
export function assertAllowedRecordingUrl(raw: string, allow: string[]): URL {
  let u: URL;
  try { u = new URL(String(raw)); } catch {
    throw new RecordingFetchError('invalid_url', 'Recording URL is invalid');
  }
  if (u.protocol !== 'https:' || !hostAllowed(u.hostname, allow)) {
    throw new RecordingFetchError('host_not_allowed', 'Recording URL host not allowed');
  }
  return u;
}

/* ── TeleCMI playback-URL normalization ────────────────────────────────────*/

/** The documented play endpoint. Host and path are both fixed by the vendor. */
const TELECMI_PLAY_ORIGIN = 'https://rest.telecmi.com';
const TELECMI_PLAY_PATH = '/v2/play';
/** The dead path-segment shape. Every ct_calls row written before this fix
 *  carries it, because RECORDING_BASE_URL_DEFAULT used to end '/v2/play/' and
 *  ingest appended the filename to it. Captures everything after that slash,
 *  which is exactly the string the base-join appended, so it can be moved into
 *  the ?file= parameter the route actually wants. */
const TELECMI_DEAD_PLAY_PATH_RE = /^\/v2\/play\/(.+)$/;

/**
 * Does this stored value look like a bare recording FILENAME rather than a URL?
 *
 * ct_calls.recording_url is a plain TEXT column and nothing constrains it to a
 * URL: the ct test suite's own CDR fixture stores 'rec-a.mp3' and asserts it
 * survives (scripts/ct-tests.ts, "recording kept"), and any hand-set or
 * re-imported row can hold the same. new URL() rejects every such value, so
 * without this branch they fail as "Recording URL is invalid" and never reach
 * TeleCMI at all. (Today's mapper blanks a filename it cannot join onto a base
 * rather than storing it — this is about the values that DO reach the column,
 * not about that one path.)
 *
 * DELIBERATELY STRICT, because this is the one input that gets composed into a
 * URL rather than validated as one. No slash or backslash (no path traversal,
 * no protocol-relative "//host"), no colon (no scheme, no host:port), no query
 * or fragment delimiter, no control characters, and not a bare dot segment. The
 * result is still handed to assertAllowedRecordingUrl() afterwards, so even a
 * value that slipped through cannot move the request off an allowlisted host.
 */
const BARE_FILENAME_RE = /^[^\u0000-\u001F\u007F/\\:?#]{1,512}$/;
function isBareFilename(v: string): boolean {
  return v !== '.' && v !== '..' && BARE_FILENAME_RE.test(v);
}

export interface PlaybackUrl {
  /** What to actually fetch. Same origin as the input, always. */
  url: URL;
  /** True when this differs from the stored URL. */
  changed: boolean;
  /** True when the outgoing request carries appid + secret. */
  credentialed: boolean;
  /** Credential-FREE explanation of what was done and why. Safe to display. */
  note: string;
  /** Set when the request must NOT go out at all. The caller raises it. */
  problem?: RecordingFailureReason;
}

/**
 * Rewrite a TeleCMI recording URL into the one shape the vendor documents, and
 * attach credentials for the outgoing request only.
 *
 * SCOPE IS DELIBERATELY NARROW. It touches nothing but a TeleCMI host, and on
 * that host nothing but the dead /v2/play/<file> path and the credential
 * parameters of /v2/play. It NEVER changes the origin, so it cannot move a
 * request off the host the allowlist already approved — the caller validates
 * first and this only edits path + query of that same URL. A URL that already
 * carries appid and secret is left alone, and a value the admin pointed at some
 * other host or path is passed through exactly as stored.
 *
 * Rewriting the dead shape cannot make anything worse: /v2/play/<file> is a
 * measured hard 404 on this vendor, so there is no working case to break.
 */
export function telecmiPlaybackUrl(db: Database.Database, input: URL): PlaybackUrl {
  if (!hostAllowed(input.hostname, ['telecmi.com'])) {
    return { url: input, changed: false, credentialed: false, note: 'not a TeleCMI host — fetched exactly as stored' };
  }

  const out = new URL(input.toString());
  const notes: string[] = [];

  // 1 · path form → query form.
  const seg = TELECMI_DEAD_PLAY_PATH_RE.exec(out.pathname);
  if (seg) {
    let file = seg[1];
    // The value was percent-encoded on its way into a path segment;
    // searchParams.set() re-encodes, so decode once to avoid doubling it.
    try { file = decodeURIComponent(file); } catch { /* keep it as-is */ }
    out.pathname = TELECMI_PLAY_PATH;
    if (!out.searchParams.get('file')) out.searchParams.set('file', file);
    notes.push('rewrote the /v2/play/<file> path — TeleCMI documents no such route — to /v2/play?file=<file>');
  }

  const onPlayRoute = out.pathname === TELECMI_PLAY_PATH || out.pathname === `${TELECMI_PLAY_PATH}/`;
  if (!onPlayRoute) {
    // Some other TeleCMI path (a pre-signed CDN link, say). Not ours to touch,
    // and not ours to add credentials to.
    const changed = out.toString() !== input.toString();
    return {
      url: changed ? out : input,
      changed,
      credentialed: false,
      note: notes.length ? notes.join('; ') : 'fetched exactly as stored',
    };
  }
  out.pathname = TELECMI_PLAY_PATH;

  // 2 · the vendor requires all three parameters. Refuse to send a request we
  //     already know is incomplete, and name which part is missing.
  if (!out.searchParams.get('file')) {
    return {
      url: out, changed: true, credentialed: false,
      note: 'the stored recording value names no file, so there is nothing to ask TeleCMI for',
      problem: 'no_filename',
    };
  }

  // 3 · credentials, for THIS request only.
  const hasAppid = !!out.searchParams.get('appid');
  const hasSecret = !!out.searchParams.get('secret');
  if (hasAppid && hasSecret) {
    notes.push('the stored URL already carries credentials — left untouched');
    return { url: out, changed: out.toString() !== input.toString(), credentialed: true, note: notes.join('; ') };
  }

  let appid = '';
  let secret = '';
  try { appid = telecmiAppId(db); secret = telecmiSecret(db); } catch { /* unconfigured */ }
  if (!appid || !secret) {
    return {
      url: out, changed: true, credentialed: false,
      note: 'the TeleCMI App ID and secret are not configured, and /v2/play requires both',
      problem: 'not_configured',
    };
  }
  if (!hasAppid) out.searchParams.set('appid', appid);
  if (!hasSecret) out.searchParams.set('secret', secret);
  notes.push('added the TeleCMI App ID and secret to the request (they are never written to the call row)');
  return { url: out, changed: true, credentialed: true, note: notes.join('; ') };
}

/**
 * The stored recording value → the URL to fetch, with the SSRF guard applied.
 *
 * ORDER IS THE SECURITY PROPERTY. A bare filename is composed onto the vendor's
 * own fixed origin, anything else is parsed as-is, and BOTH then go through
 * assertAllowedRecordingUrl() before telecmiPlaybackUrl() is allowed to edit
 * path and query. So nothing this function returns can be on a host the
 * allowlist has not approved.
 */
export function recordingTarget(db: Database.Database, rawUrl: string, allow: string[]): PlaybackUrl {
  const raw = String(rawUrl ?? '').trim();
  if (!raw) {
    throw new RecordingFetchError('no_filename', 'This call row names no recording to fetch.');
  }

  let stored: URL;
  let fromFilename = false;
  if (isBareFilename(raw)) {
    const built = new URL(TELECMI_PLAY_PATH, TELECMI_PLAY_ORIGIN);
    built.searchParams.set('file', raw);
    stored = assertAllowedRecordingUrl(built.toString(), allow);
    fromFilename = true;
  } else {
    stored = assertAllowedRecordingUrl(raw, allow);
  }

  const playback = telecmiPlaybackUrl(db, stored);
  if (!fromFilename) return playback;
  return {
    ...playback,
    changed: true,
    note: `the stored value is a bare filename, so it was placed on the documented endpoint ${TELECMI_PLAY_ORIGIN}${TELECMI_PLAY_PATH}?file=…`
      + (playback.note && playback.note !== 'fetched exactly as stored' ? `; ${playback.note}` : ''),
  };
}

/* ── Upstream error detection ──────────────────────────────────────────────*/

/**
 * Content types that are never audio. Matched on the ESSENCE only (the part
 * before any ';charset='). Deliberately a small allowlist of TEXTUAL types
 * rather than "anything that is not audio/*": an unknown binary type
 * (application/octet-stream, binary/octet-stream, a bare missing header) is
 * still very plausibly a media file, and those keep streaming — the body sniff
 * below is what protects them.
 */
const TEXTUAL_CONTENT_TYPE_RE = /^(?:text\/|application\/(?:json|xml|problem\+json|xhtml\+xml)\b)/i;

/**
 * The exact stream type a fetch() Response body has under this toolchain's
 * typings, derived rather than spelled out. TypeScript's DOM lib now
 * parameterises Uint8Array by its buffer kind, so a hand-written
 * ReadableStream<Uint8Array> is NOT assignable back to a Response body — which
 * is what sniffVendorEnvelope() has to produce. Deriving it here keeps the
 * rebuilt stream assignable, and keeps working across TypeScript versions.
 */
type ResponseBody = NonNullable<Response['body']>;
type ResponseChunk = ResponseBody extends ReadableStream<infer C> ? C : never;

/** Enough of an error body to name the cause; never enough to be a payload. */
const ERROR_PEEK_BYTES = 2048;
/** How much of an untyped body to inspect before deciding it is really audio.
 *  A vendor error envelope is ~55 bytes; this is generous by two orders. */
const SNIFF_BYTES = 1024;

/** Read at most ERROR_PEEK_BYTES of a body, then cancel the rest. Never throws.
 *  Exported for the admin diagnostic, which shows the first bytes verbatim so
 *  an unrecognised vendor error can still be read by a human. */
export async function peekRecordingBody(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
      if (total >= ERROR_PEEK_BYTES) break;
    }
  } catch { /* a truncated error body is still worth reporting */ }
  try { await reader.cancel(); } catch { /* already closed */ }
  return Buffer.concat(chunks).toString('utf8').slice(0, ERROR_PEEK_BYTES);
}

interface VendorEnvelope { code: number | null; msg: string }

/**
 * Is this text one of TeleCMI's JSON error envelopes?
 *
 * STRICT ON PURPOSE, because this also runs against bodies that ARE audio. It
 * demands a parseable JSON OBJECT carrying at least one of code / msg / message
 * / error. A one-byte range response whose single byte happens to be '{' does
 * not parse, so it is not mistaken for an error; neither is an MP3 frame.
 */
function vendorEnvelope(text: string): VendorEnvelope | null {
  const t = text.replace(/^\uFEFF/, '').trimStart();
  if (!t.startsWith('{')) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(t); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const rawMsg = o.msg ?? o.message ?? (typeof o.error === 'string' ? o.error : '');
  const msg = typeof rawMsg === 'string' ? rawMsg.trim() : '';
  const code = Number.isFinite(Number(o.code)) && o.code !== null && o.code !== '' ? Number(o.code) : null;
  if (code === null && !msg && o.error !== true) return null;
  return { code, msg };
}

/**
 * A vendor envelope → the reason it maps to.
 *
 * 407 and 404 are the two the doc lists, and both were reproduced. What a
 * SUCCESSFUL authentication plus a missing file looks like is NOT verified —
 * we have never held working credentials — so that case is matched on wording
 * and otherwise falls through to 'upstream_error' rather than being guessed at.
 */
function reasonFromEnvelope(env: VendorEnvelope): RecordingFailureReason {
  if (env.code === 407 || /auth/i.test(env.msg)) return 'credentials_rejected';
  // "Parameter missing" cannot mean our doing once we are here: recordingTarget
  // refuses to send the request unless all three documented parameters are on
  // it. So it is the vendor wanting something the doc does not list.
  if (/parameter/i.test(env.msg)) return 'bad_request';
  if (env.code === 404 || /not\s*found|no\s+such|does\s*n[o']?t\s*exist/i.test(env.msg)) return 'file_not_found';
  return 'upstream_error';
}

/** The sentence a GRE reads, built from what the vendor actually said. */
function envelopeMessage(status: number, contentType: string, env: VendorEnvelope | null, bodyText: string): string {
  const essence = contentType.split(';')[0].trim() || 'no content type';
  const head = `The recording source answered ${status} with ${essence} instead of audio`;
  if (!env) {
    // Not JSON (an HTML error page). Collapse it to a single readable line.
    const flat = bodyText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    return flat ? `${head}: "${flat}".` : `${head}.`;
  }
  const reason = reasonFromEnvelope(env);
  const hint =
    reason === 'credentials_rejected'
      ? ' — the TeleCMI App ID and secret in CRM settings are wrong or not entitled to this recording.'
      : reason === 'file_not_found'
        ? ' — TeleCMI no longer holds a recording under that filename.'
        : /parameter/i.test(env.msg)
          ? ' — TeleCMI wants a parameter beyond the documented appid, secret and file.'
          : '';
  const said = env.msg ? `: "${env.msg}"` : '';
  const code = env.code !== null ? ` (code ${env.code})` : '';
  return `${head}${said}${code}${hint}`;
}

export interface UpstreamRefusal {
  reason: RecordingFailureReason;
  /** Credential-free, one sentence, safe to store and display. */
  message: string;
  /** Whether the refused request carried credentials. A boolean, never them. */
  credentialed: boolean;
}

/**
 * Classify a NON-2xx upstream answer, for the proxy's error body.
 *
 * "Recording source responded 404" on its own has sent people hunting the
 * player. The vendor's page for our old dead path literally says
 * "Cannot GET /v2/play/…", which names the fault outright, so the body is read.
 * Consumes at most ERROR_PEEK_BYTES — the caller is discarding it either way.
 */
export async function classifyUpstreamRefusal(
  r: FetchedRecording,
  db: Database.Database | null = null,
): Promise<UpstreamRefusal> {
  const needles = credentialNeedles(db);
  const text = await peekRecordingBody(r.body);
  const env = TEXTUAL_CONTENT_TYPE_RE.test(r.contentType) ? vendorEnvelope(text) : null;

  let reason: RecordingFailureReason;
  if (env) {
    reason = reasonFromEnvelope(env);
  } else if (r.status === 401 || r.status === 403 || r.status === 407) {
    reason = 'credentials_rejected';
  } else if (r.status === 404 || r.status === 410) {
    reason = 'file_not_found';
  } else {
    reason = 'upstream_error';
  }

  const message = TEXTUAL_CONTENT_TYPE_RE.test(r.contentType)
    ? envelopeMessage(r.status, r.contentType, env, text)
    : `The recording source answered ${r.status} and sent no readable reason.`;
  return { reason, message: scrubCredentials(message, needles), credentialed: r.credentialed };
}

export interface FetchedRecording {
  status: number;         // final upstream status (200 / 206)
  contentType: string;
  headers: Headers;       // full upstream headers (for range passthrough in the proxy)
  body: ResponseBody | null;
  /** What was actually requested, after recordingTarget() and redirects.
   *  ADMIN-ONLY: it carries credentials. Never put it in a client response. */
  finalUrl: string;
  /** Credential-free account of what recordingTarget() did. Safe to show. */
  rewriteNote: string;
  /** Whether the outgoing request carried an App ID and secret. A boolean —
   *  never the values. See RecordingFetchError.credentialed. */
  credentialed: boolean;
}

/**
 * Look at the head of an untyped 2xx body and decide whether it is really
 * audio, WITHOUT losing the bytes that were read.
 *
 * This is the second half of the 200-JSON trap. The content-type check above
 * catches TeleCMI's own answer (it sends application/json), but a proxy, a CDN
 * error page or a future vendor change can put the same envelope behind
 * application/octet-stream or no header at all — and that lands in an <audio>
 * element as silence. So the first SNIFF_BYTES are read and tested; if they are
 * not an error envelope, a fresh stream is returned that re-emits exactly those
 * bytes and then continues with the untouched remainder. Nothing is consumed,
 * nothing is buffered beyond the head, and Content-Length stays truthful.
 */
async function sniffVendorEnvelope(
  body: ResponseBody,
): Promise<{ envelope: VendorEnvelope; text: string } | { envelope: null; body: ResponseBody }> {
  const reader = body.getReader();
  const head: ResponseChunk[] = [];
  let total = 0;
  let ended = false;
  try {
    while (total < SNIFF_BYTES) {
      const { done, value } = await reader.read();
      if (done) { ended = true; break; }
      if (value?.byteLength) { head.push(value); total += value.byteLength; }
    }
  } catch (e) {
    try { await reader.cancel(); } catch { /* already closed */ }
    throw e;
  }

  const text = Buffer.concat(head).toString('utf8');
  const env = vendorEnvelope(text);
  if (env) {
    try { await reader.cancel(); } catch { /* already closed */ }
    return { envelope: env, text };
  }

  const rebuilt = new ReadableStream<ResponseChunk>({
    start(controller) {
      for (const c of head) controller.enqueue(c);
      if (ended) controller.close();
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { controller.close(); return; }
        if (value) controller.enqueue(value);
      } catch (e) {
        controller.error(e);
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return { envelope: null, body: rebuilt };
}

/**
 * Fetch a recording as a streaming Response-like object, following redirects
 * MANUALLY (max 3) and re-validating the host on every hop. `rangeHeader` is
 * forwarded when present (for <audio> seeking in the proxy). The caller owns
 * the abort timer via `signal`.
 *
 * ORDER MATTERS: the stored value is resolved and validated against the
 * allowlist FIRST, and only then handed to telecmiPlaybackUrl(), which edits
 * path and query but never the origin. So the vendor rewrite can never widen
 * what the SSRF guard approved. Redirect targets are re-validated exactly as
 * before, and the rewrite is NOT re-applied to them — a Location header is the
 * vendor's own answer and is followed verbatim.
 *
 * THROWS a RecordingFetchError on an upstream 2xx that is really an error (see
 * the header): passing it on would put JSON inside an <audio> element, which
 * fails silently and is the whole bug this module exists to close.
 */
export async function fetchAllowedRecording(
  db: Database.Database,
  rawUrl: string,
  opts: {
    rangeHeader?: string | null;
    signal?: AbortSignal;
    /**
     * DIAGNOSTIC ONLY. Return an error 2xx instead of throwing on it, so the
     * admin probe can report the status, the content type AND the body rather
     * than only the sentence derived from them. Never set this on a playback
     * path: it is what would put JSON inside an <audio> element again.
     */
    allowTextualBody?: boolean;
  } = {},
): Promise<FetchedRecording> {
  const needles = credentialNeedles(db);
  const allow = recordingAllowlist(db);
  const playback = recordingTarget(db, rawUrl, allow);
  if (playback.problem) {
    throw new RecordingFetchError(
      playback.problem,
      playback.problem === 'not_configured'
        ? 'This deployment has no TeleCMI App ID and secret configured, and TeleCMI requires both to release a recording. Add them under CRM Settings.'
        : 'This call row names no recording to fetch.',
      null,
      false,
    );
  }

  let current = playback.url;
  const headers: Record<string, string> = {};
  if (opts.rangeHeader) headers['Range'] = opts.rangeHeader;

  let hops = 0;
  while (true) {
    let res: Response;
    try {
      res = await fetch(current.toString(), { headers, redirect: 'manual', signal: opts.signal });
    } catch (e: unknown) {
      const err = e as { name?: string; message?: string };
      if (err?.name === 'AbortError') {
        throw new RecordingFetchError('timeout', 'The recording source did not answer in time.');
      }
      // A connection-level failure. The message can name the host but never a
      // credential; scrub it anyway — this string is persisted by analyze.ts.
      throw new RecordingFetchError(
        'network',
        scrubCredentials(`The recording source could not be reached over the network (${err?.message || 'connection failed'}).`, needles),
      );
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc || ++hops > 3) {
        throw new RecordingFetchError('upstream_error', 'The recording source redirected too many times.');
      }
      let next: URL;
      try { next = new URL(loc, current); } catch {
        throw new RecordingFetchError('invalid_url', 'The recording redirect target is invalid.');
      }
      if (next.protocol !== 'https:' || !hostAllowed(next.hostname, allow)) {
        throw new RecordingFetchError('host_not_allowed', 'The recording source redirected to a host not allowed by this deployment.');
      }
      current = next;
      continue;
    }

    const contentType = res.headers.get('content-type') || 'audio/mpeg';
    let body = res.body;

    if (!opts.allowTextualBody && res.status >= 200 && res.status < 300) {
      // Pass 1 — the vendor's own answer: application/json at HTTP 200.
      if (TEXTUAL_CONTENT_TYPE_RE.test(contentType)) {
        const text = await peekRecordingBody(body);
        const env = vendorEnvelope(text);
        throw new RecordingFetchError(
          env ? reasonFromEnvelope(env) : 'upstream_error',
          scrubCredentials(envelopeMessage(res.status, contentType, env, text), needles),
          res.status,
          playback.credentialed,
        );
      }
      // Pass 2 — the same envelope behind a binary or absent content-type.
      if (body) {
        const sniffed = await sniffVendorEnvelope(body);
        if (sniffed.envelope) {
          throw new RecordingFetchError(
            reasonFromEnvelope(sniffed.envelope),
            scrubCredentials(envelopeMessage(res.status, contentType, sniffed.envelope, sniffed.text), needles),
            res.status,
            playback.credentialed,
          );
        }
        body = sniffed.body;
      }
    }

    return {
      status: res.status,
      contentType,
      headers: res.headers,
      body,
      finalUrl: current.toString(),
      rewriteNote: playback.note,
      credentialed: playback.credentialed,
    };
  }
}

/**
 * Download a recording fully into a Buffer for AI analysis. Enforces a byte
 * cap (Gemini inline_data ~14MB request limit) using Content-Length when
 * present, and a hard streamed cap as a backstop. Returns the buffer + mime.
 *
 * It inherits every guard above unchanged — in particular it does NOT pass
 * allowTextualBody, so a vendor error envelope raises here rather than being
 * base64'd and posted to Gemini as if it were audio.
 */
export async function fetchRecordingBuffer(
  db: Database.Database,
  rawUrl: string,
  opts: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<{ buffer: Buffer; mimeType: string }> {
  const maxBytes = opts.maxBytes ?? 14 * 1024 * 1024;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  try {
    const r = await fetchAllowedRecording(db, rawUrl, { signal: controller.signal });
    if (r.status !== 200) {
      const refusal = await classifyUpstreamRefusal(r, db);
      throw new RecordingFetchError(refusal.reason, refusal.message, r.status);
    }
    const cl = Number(r.headers.get('content-length') || 0);
    if (cl && cl > maxBytes) {
      throw new RecordingFetchError('upstream_error', `Recording too large for AI analysis (${Math.round(cl / 1_048_576)}MB > ${Math.round(maxBytes / 1_048_576)}MB)`);
    }
    if (!r.body) throw new RecordingFetchError('upstream_error', 'The recording source returned an empty body.');
    // Stream with a RUNNING cap so an absent/lying Content-Length can't OOM the
    // server — abort the moment the accumulated bytes exceed maxBytes.
    const reader = r.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          try { controller.abort(); } catch { /* ignore */ }
          throw new RecordingFetchError('upstream_error', `Recording too large for AI analysis (> ${Math.round(maxBytes / 1_048_576)}MB)`);
        }
        chunks.push(value);
      }
    }
    return { buffer: Buffer.concat(chunks), mimeType: r.contentType.split(';')[0].trim() || 'audio/mpeg' };
  } finally {
    clearTimeout(timer);
  }
}
