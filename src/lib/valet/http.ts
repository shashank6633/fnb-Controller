/**
 * VALET route plumbing: one error shape for every valet API, and the headers
 * that keep guest data out of caches and search engines.
 */
import { ValetError } from './core';

export const NO_STORE: Record<string, string> = {
  'Cache-Control': 'no-store, private, max-age=0',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
};

/** Run a handler; a ValetError becomes {error, code, ...extra} with its status,
 *  anything else a generic 500 (logged by name only — never the request body,
 *  which can carry tokens or a phone number). */
export async function valetJson(fn: () => unknown | Promise<unknown>, headers: Record<string, string> = {}): Promise<Response> {
  try {
    const out = await fn();
    if (out instanceof Response) return out;
    return Response.json(out ?? { ok: true }, { headers: { ...NO_STORE, ...headers } });
  } catch (e) {
    if (e instanceof ValetError) {
      return Response.json({ error: e.message, code: e.code, ...(e.extra || {}) }, { status: e.status, headers: NO_STORE });
    }
    console.error('[valet] unexpected error:', (e as Error)?.name, (e as Error)?.message);
    return Response.json({ error: 'Something went wrong. Please try again.', code: 'server_error' }, { status: 500, headers: NO_STORE });
  }
}

export async function readJson(req: Request, maxBytes = 32_000): Promise<Record<string, any>> {
  const len = Number(req.headers.get('content-length') || 0);
  if (len > maxBytes) throw new ValetError(413, 'too_large', 'Request too large.');
  const text = await req.text();
  if (text.length > maxBytes) throw new ValetError(413, 'too_large', 'Request too large.');
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { throw new ValetError(400, 'bad_json', 'Bad request.'); }
}
