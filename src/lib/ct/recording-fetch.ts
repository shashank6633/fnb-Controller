/**
 * Call-to-Table — SSRF-safe recording fetch (shared by the recording proxy
 * route and the AI analyze lib).
 *
 * A recording_url originates in a TeleCMI CDR payload (token-gated, but treated
 * as untrusted). We only ever fetch HTTPS URLs on an allowlisted host
 * (*.telecmi.com by default, extendable via the ct_settings
 * 'recording_host_allowlist' key), and follow redirects MANUALLY, re-validating
 * the host on every hop — so a planted or redirecting URL can never reach an
 * internal address (metadata, localhost, …).
 *
 * ── THE VENDOR PLAYBACK CONTRACT, MEASURED ────────────────────────────────
 * Two behaviours of rest.telecmi.com decide most of this file. Both were
 * measured directly against the live endpoint on 11 Aug 2026, with bogus
 * credentials, using read-only GETs:
 *
 *   GET /v2/play/<anything>          → 404 text/html, "Cannot GET /v2/play/…"
 *                                      Byte-identical in form to
 *                                      /v2/definitely-not-a-route-xyz, i.e. it
 *                                      is Express's unmatched-route fallback.
 *                                      THERE IS NO PATH-SEGMENT PLAY ROUTE.
 *   GET /v2/play?appid=&secret=&file= → 200 application/json
 *                                      {"code":407,"msg":"Authentication Failed"}
 *                                      Drop or rename ANY one of the three and
 *                                      it answers {"code":404,"msg":"Parameter
 *                                      missing"} instead — so all three are
 *                                      recognised, and credentials ARE required.
 *
 * Two consequences, and this file handles both:
 *
 *  1 A stored URL of the form https://rest.telecmi.com/v2/play/<file>.mp3 can
 *    only ever 404. telecmiPlaybackUrl() rewrites that one measured-dead shape
 *    into the query form at FETCH TIME and adds the credentials there, so the
 *    app secret is never written to ct_calls.recording_url (where only the
 *    admin diagnostic masks it) and rows already carrying the broken shape are
 *    repaired on read rather than needing a migration.
 *  2 TeleCMI returns its ERRORS as HTTP 200 with content-type application/json.
 *    A status-only check therefore passes them straight through, and an <audio>
 *    element that is handed JSON renders a silent 0:00/0:00 with a dead play
 *    button — which is exactly the symptom this chain was reported for. So a
 *    2xx carrying a TEXTUAL content-type is treated as an upstream failure and
 *    the vendor's own message is raised, not streamed.
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

/** Validate a URL string against the allowlist. Returns the URL or throws. */
export function assertAllowedRecordingUrl(raw: string, allow: string[]): URL {
  let u: URL;
  try { u = new URL(String(raw)); } catch { throw new Error('Recording URL is invalid'); }
  if (u.protocol !== 'https:' || !hostAllowed(u.hostname, allow)) {
    throw new Error('Recording URL host not allowed');
  }
  return u;
}

/* ── TeleCMI playback-URL normalization ────────────────────────────────────*/

/** The one play route that exists on rest.telecmi.com. See the header. */
const TELECMI_PLAY_PATH = '/v2/play';
/** The dead path-segment shape our default base used to build. Captures the
 *  filename so it can be moved into the ?file= parameter the route wants. */
const TELECMI_DEAD_PLAY_PATH_RE = /^\/v2\/play\/(.+)$/;

export interface PlaybackUrl {
  /** What to actually fetch. Same origin as the input, always. */
  url: URL;
  /** True when this differs from the stored URL. */
  changed: boolean;
  /** True when the outgoing request carries appid + secret. */
  credentialed: boolean;
  /** Credential-FREE explanation of what was done and why. Safe to display. */
  note: string;
}

/**
 * Rewrite a stored TeleCMI recording URL into one the vendor actually serves,
 * and attach credentials for the outgoing request only.
 *
 * SCOPE IS DELIBERATELY NARROW. It touches nothing but a TeleCMI host, and on
 * that host nothing but the measured-dead /v2/play/<file> path and the
 * credential parameters of /v2/play. It NEVER changes the origin, so it cannot
 * move a request off the host the allowlist already approved — the caller
 * validates first and this only edits path + query of that same URL. A URL that
 * already carries appid and secret is left alone, and a value the admin pointed
 * at some other host or path is passed through exactly as stored.
 *
 * Rewriting the dead shape cannot make anything worse: that shape is a measured
 * hard 404 on this vendor, so there is no working case to break.
 */
export function telecmiPlaybackUrl(db: Database.Database, input: URL): PlaybackUrl {
  const unchanged = (note: string): PlaybackUrl =>
    ({ url: input, changed: false, credentialed: false, note });

  if (!hostAllowed(input.hostname, ['telecmi.com'])) {
    return unchanged('not a TeleCMI host — fetched exactly as stored');
  }

  const out = new URL(input.toString());
  const notes: string[] = [];

  // 1 · path form → query form.
  const seg = TELECMI_DEAD_PLAY_PATH_RE.exec(out.pathname);
  if (seg) {
    let file = seg[1];
    // The stored value was percent-encoded on its way into a path segment;
    // searchParams.set() will re-encode, so decode once to avoid doubling it.
    try { file = decodeURIComponent(file); } catch { /* keep it as-is */ }
    out.pathname = TELECMI_PLAY_PATH;
    if (!out.searchParams.get('file')) out.searchParams.set('file', file);
    notes.push('rewrote the /v2/play/<file> path — TeleCMI has no such route — to /v2/play?file=<file>');
  }

  // 2 · credentials, for THIS request only.
  const onPlayRoute = out.pathname === TELECMI_PLAY_PATH || out.pathname === `${TELECMI_PLAY_PATH}/`;
  let credentialed = false;
  if (onPlayRoute && out.searchParams.get('file')) {
    out.pathname = TELECMI_PLAY_PATH;
    const hasAppid = !!out.searchParams.get('appid');
    const hasSecret = !!out.searchParams.get('secret');
    if (hasAppid && hasSecret) {
      credentialed = true;
      notes.push('the stored URL already carries credentials — left untouched');
    } else {
      let appid = '';
      let secret = '';
      try { appid = telecmiAppId(db); secret = telecmiSecret(db); } catch { /* unconfigured */ }
      if (appid && secret) {
        if (!hasAppid) out.searchParams.set('appid', appid);
        if (!hasSecret) out.searchParams.set('secret', secret);
        credentialed = true;
        notes.push('added the TeleCMI App ID and secret to the request (they are never written to the call row)');
      } else {
        notes.push('the TeleCMI App ID and secret are not configured, so this goes out unauthenticated and TeleCMI will refuse it');
      }
    }
  }

  const changed = out.toString() !== input.toString();
  return {
    url: changed ? out : input,
    changed,
    credentialed,
    note: notes.length ? notes.join('; ') : 'fetched exactly as stored',
  };
}

/* ── Upstream error detection ──────────────────────────────────────────────*/

/**
 * Content types that are never audio. Matched on the ESSENCE only (the part
 * before any ';charset='). Deliberately a small allowlist of TEXTUAL types
 * rather than "anything that is not audio/*": an unknown binary type
 * (application/octet-stream, binary/octet-stream, a bare missing header) is
 * still very plausibly a media file and must keep streaming as it does today.
 */
const TEXTUAL_CONTENT_TYPE_RE = /^(?:text\/|application\/(?:json|xml|problem\+json|xhtml\+xml)\b)/i;

/** Enough of an error body to name the cause; never enough to be a payload. */
const ERROR_PEEK_BYTES = 2048;

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

/**
 * Turn an upstream textual response into one sentence a GRE can act on.
 *
 * TeleCMI answers {"code":407,"error":true,"msg":"Authentication Failed"} —
 * with HTTP 200 — so the vendor's own msg is the most useful thing on the wire
 * and it is quoted verbatim. The hint appended for 407 is the measured meaning
 * of that code on this endpoint, nothing more.
 */
function describeTextualUpstream(status: number, contentType: string, bodyText: string): string {
  const essence = contentType.split(';')[0].trim() || 'an unknown content type';
  let vendorMsg = '';
  let vendorCode: number | null = null;
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed && typeof parsed === 'object') {
      const m = (parsed as any).msg ?? (parsed as any).message ?? (parsed as any).error;
      if (typeof m === 'string' && m.trim()) vendorMsg = m.trim();
      const c = Number((parsed as any).code);
      if (Number.isFinite(c)) vendorCode = c;
    }
  } catch {
    // Not JSON (an HTML error page). Collapse it to a single readable line.
    const flat = bodyText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (flat) vendorMsg = flat.slice(0, 160);
  }

  const head = `The recording source answered ${status} with ${essence} instead of audio`;
  if (!vendorMsg) return `${head}.`;
  const hint =
    vendorCode === 407 || /auth/i.test(vendorMsg)
      ? ' — the TeleCMI App ID and secret in CRM settings are missing or wrong.'
      : vendorCode === 404 && /parameter/i.test(vendorMsg)
        ? ' — the playback URL is missing a parameter TeleCMI requires.'
        : '';
  return `${head}: "${vendorMsg}"${vendorCode !== null ? ` (code ${vendorCode})` : ''}${hint}`;
}

/**
 * One sentence explaining a NON-2xx upstream answer, for the proxy's 502 body.
 * "Recording source responded 404" on its own has sent people hunting the
 * player; the vendor's page for our old dead path literally says
 * "Cannot GET /v2/play/…", which names the fault outright. Consumes at most
 * ERROR_PEEK_BYTES of the body — the caller is discarding it either way.
 */
export async function describeUpstreamRefusal(r: FetchedRecording): Promise<string> {
  const text = await peekRecordingBody(r.body);
  if (TEXTUAL_CONTENT_TYPE_RE.test(r.contentType)) {
    return describeTextualUpstream(r.status, r.contentType, text);
  }
  return `The recording source answered ${r.status} and sent no readable reason.`;
}

export interface FetchedRecording {
  status: number;         // final upstream status (200 / 206)
  contentType: string;
  headers: Headers;       // full upstream headers (for range passthrough in the proxy)
  body: ReadableStream<Uint8Array> | null;
  /** What was actually requested, after telecmiPlaybackUrl() and redirects.
   *  ADMIN-ONLY: it carries credentials. Never put it in a client response. */
  finalUrl: string;
  /** Credential-free account of what telecmiPlaybackUrl() did. Safe to show. */
  rewriteNote: string;
}

/**
 * Fetch a recording as a streaming Response-like object, following redirects
 * MANUALLY (max 3) and re-validating the host on every hop. `rangeHeader` is
 * forwarded when present (for <audio> seeking in the proxy). The caller owns
 * the abort timer via `signal`.
 *
 * ORDER MATTERS: the stored URL is validated against the allowlist FIRST, and
 * only then handed to telecmiPlaybackUrl(), which edits path and query but
 * never the origin. So the vendor rewrite can never widen what the SSRF guard
 * approved. Redirect targets are re-validated exactly as before, and the
 * rewrite is NOT re-applied to them — a Location header is the vendor's own
 * answer and is followed verbatim.
 *
 * THROWS on an upstream 2xx that carries a textual body (see the header): that
 * is TeleCMI reporting an error at HTTP 200, and passing it on would put JSON
 * inside an <audio> element, which fails silently.
 */
export async function fetchAllowedRecording(
  db: Database.Database,
  rawUrl: string,
  opts: {
    rangeHeader?: string | null;
    signal?: AbortSignal;
    /**
     * DIAGNOSTIC ONLY. Return a textual 2xx instead of throwing on it, so the
     * admin probe can report the status, the content type AND the body rather
     * than only the sentence derived from them. Never set this on a playback
     * path: it is what would put JSON inside an <audio> element again.
     */
    allowTextualBody?: boolean;
  } = {},
): Promise<FetchedRecording> {
  const allow = recordingAllowlist(db);
  const stored = assertAllowedRecordingUrl(rawUrl, allow);
  const playback = telecmiPlaybackUrl(db, stored);
  let current = playback.url;
  const headers: Record<string, string> = {};
  if (opts.rangeHeader) headers['Range'] = opts.rangeHeader;

  let hops = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await fetch(current.toString(), { headers, redirect: 'manual', signal: opts.signal });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc || ++hops > 3) throw new Error('Recording source redirected too many times');
      let next: URL;
      try { next = new URL(loc, current); } catch { throw new Error('Recording redirect target is invalid'); }
      if (next.protocol !== 'https:' || !hostAllowed(next.hostname, allow)) {
        throw new Error('Recording redirect host not allowed');
      }
      current = next;
      continue;
    }
    const contentType = res.headers.get('content-type') || 'audio/mpeg';
    if (!opts.allowTextualBody && res.status >= 200 && res.status < 300 && TEXTUAL_CONTENT_TYPE_RE.test(contentType)) {
      throw new Error(describeTextualUpstream(res.status, contentType, await peekRecordingBody(res.body)));
    }
    return {
      status: res.status,
      contentType,
      headers: res.headers,
      body: res.body,
      finalUrl: current.toString(),
      rewriteNote: playback.note,
    };
  }
}

/**
 * Download a recording fully into a Buffer for AI analysis. Enforces a byte
 * cap (Gemini inline_data ~14MB request limit) using Content-Length when
 * present, and a hard streamed cap as a backstop. Returns the buffer + mime.
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
    if (r.status !== 200) throw new Error(`Recording source responded ${r.status}`);
    const cl = Number(r.headers.get('content-length') || 0);
    if (cl && cl > maxBytes) {
      throw new Error(`Recording too large for AI analysis (${Math.round(cl / 1_048_576)}MB > ${Math.round(maxBytes / 1_048_576)}MB)`);
    }
    if (!r.body) throw new Error('Recording source returned an empty body');
    // Stream with a RUNNING cap so an absent/lying Content-Length can't OOM the
    // server — abort the moment the accumulated bytes exceed maxBytes.
    const reader = r.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          try { controller.abort(); } catch { /* ignore */ }
          throw new Error(`Recording too large for AI analysis (> ${Math.round(maxBytes / 1_048_576)}MB)`);
        }
        chunks.push(value);
      }
    }
    return { buffer: Buffer.concat(chunks), mimeType: r.contentType.split(';')[0].trim() || 'audio/mpeg' };
  } finally {
    clearTimeout(timer);
  }
}
