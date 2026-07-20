import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import {
  recordError, maybeNotifyAdmins, listErrors, resolveError, resolveAllOpen,
  unresolvedErrorCount, getAlertPhone, setAlertPhone,
} from '@/lib/error-alerts';

/**
 * Crash-proofing ingest + admin console.
 *
 * POST  /api/error-report   (PUBLIC, rate-limited, never throws)
 *   Body: { message, stack?, source?, url?, userAgent? }. Called by the client
 *   error boundaries + global window error/rejection handlers. Errors can happen
 *   before login, so this accepts unauthenticated reports — but it is capped,
 *   throttled, and write-only, and the payload is clipped server-side.
 *
 * GET   /api/error-report            (ADMIN only) → { errors, unresolved, alert_phone }
 * PATCH /api/error-report            (ADMIN only) → resolve | resolve_all | set_alert_phone
 */
export const dynamic = 'force-dynamic';

// ── In-process rate limits (best-effort; resets on restart) ──────────────────
const MAX_BODY_BYTES = 16 * 1024;
const perIp = new Map<string, number[]>();
const PER_IP_MAX = 20;            // reports…
const PER_IP_WINDOW_MS = 60_000;  // …per minute per IP
const globalHits: number[] = [];
const GLOBAL_MAX = 300;           // reports/min across all clients

function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for') || '';
  const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
  // Our reverse proxy (nginx / Lightsail) APPENDS the real client IP, so the
  // LAST hop is the trustworthy one — the FIRST token is client-spoofable and
  // must not key the per-IP limiter. Fall back to x-real-ip, then a constant
  // (the global cap still applies).
  return parts.length ? parts[parts.length - 1] : (req.headers.get('x-real-ip') || 'unknown').trim();
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  while (globalHits.length && now - globalHits[0] > 60_000) globalHits.shift();
  if (globalHits.length >= GLOBAL_MAX) return true;
  const arr = (perIp.get(ip) || []).filter((t) => now - t < PER_IP_WINDOW_MS);
  if (arr.length >= PER_IP_MAX) { perIp.set(ip, arr); return true; }
  arr.push(now); perIp.set(ip, arr); globalHits.push(now);
  // Opportunistic cleanup so the map can't grow unbounded.
  if (perIp.size > 5000) for (const [k, v] of perIp) if (!v.some((t) => now - t < PER_IP_WINDOW_MS)) perIp.delete(k);
  return false;
}

export async function POST(req: Request) {
  // This endpoint reports crashes — it must never itself 500 in a way that makes
  // the client retry-loop. Any failure returns { ok:false } with 200.
  try {
    if (rateLimited(clientIp(req))) return Response.json({ ok: false, throttled: true });

    // Reject oversized bodies BEFORE buffering them into memory (App Router has
    // no default body-size limit). Content-Length is the cheap pre-check; the
    // byte-length guard is the backstop for chunked requests with no length.
    const declaredLen = Number(req.headers.get('content-length') || 0);
    if (declaredLen > MAX_BODY_BYTES) return Response.json({ ok: false });
    const raw = await req.text();
    if (!raw || Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return Response.json({ ok: false });
    let body: any = {};
    try { body = JSON.parse(raw); } catch { return Response.json({ ok: false }); }
    if (!body || typeof body !== 'object') return Response.json({ ok: false });

    // Best-effort attribution — never block on auth (errors can precede login).
    let userEmail = '';
    let userRole = '';
    try { const me = await getCurrentUser(); if (me) { userEmail = me.email; userRole = me.role; } } catch { /* ignore */ }

    const res = recordError({
      message: body.message,
      stack: body.stack,
      source: body.source,
      url: body.url,
      userEmail,
      userRole,
      userAgent: req.headers.get('user-agent') || body.userAgent || '',
    });

    // Ping the configured admin number only for genuinely new errors (best-effort).
    if (res?.isNew) void maybeNotifyAdmins(res);

    return Response.json({ ok: !!res });
  } catch (e) {
    try { console.error('[/api/error-report POST]', e); } catch { /* ignore */ }
    return Response.json({ ok: false });
  }
}

export async function GET() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (me.role !== 'admin') return Response.json({ error: 'Admins only' }, { status: 403 });
    const db = getDb();
    return Response.json({
      errors: listErrors(db, { limit: 200, includeResolved: true }),
      unresolved: unresolvedErrorCount(db),
      alert_phone: getAlertPhone(db),
    });
  } catch (e: any) {
    console.error('[/api/error-report GET]', e);
    return Response.json({ error: e?.message || 'Failed to load errors' }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (me.role !== 'admin') return Response.json({ error: 'Admins only' }, { status: 403 });
    const db = getDb();
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || '');

    if (action === 'resolve') {
      if (!body?.id) return Response.json({ error: 'id required' }, { status: 400 });
      return Response.json({ ok: resolveError(db, String(body.id), me.email) });
    }
    if (action === 'resolve_all') {
      return Response.json({ ok: true, resolved: resolveAllOpen(db, me.email) });
    }
    if (action === 'set_alert_phone') {
      setAlertPhone(db, String(body?.phone || ''));
      return Response.json({ ok: true, alert_phone: getAlertPhone(db) });
    }
    return Response.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e: any) {
    console.error('[/api/error-report PATCH]', e);
    return Response.json({ error: e?.message || 'Failed' }, { status: 500 });
  }
}
