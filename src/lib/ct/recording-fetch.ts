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
 */
import type Database from 'better-sqlite3';
import { ctSetting } from './settings';

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

export interface FetchedRecording {
  status: number;         // final upstream status (200 / 206)
  contentType: string;
  headers: Headers;       // full upstream headers (for range passthrough in the proxy)
  body: ReadableStream<Uint8Array> | null;
}

/**
 * Fetch a recording as a streaming Response-like object, following redirects
 * MANUALLY (max 3) and re-validating the host on every hop. `rangeHeader` is
 * forwarded when present (for <audio> seeking in the proxy). The caller owns
 * the abort timer via `signal`.
 */
export async function fetchAllowedRecording(
  db: Database.Database,
  rawUrl: string,
  opts: { rangeHeader?: string | null; signal?: AbortSignal } = {},
): Promise<FetchedRecording> {
  const allow = recordingAllowlist(db);
  let current = assertAllowedRecordingUrl(rawUrl, allow);
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
    return {
      status: res.status,
      contentType: res.headers.get('content-type') || 'audio/mpeg',
      headers: res.headers,
      body: res.body,
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
