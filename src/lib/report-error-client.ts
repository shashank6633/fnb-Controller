'use client';

/**
 * Client-side error reporter — POSTs to /api/error-report. Best-effort and
 * DEFENSIVE: it exists to report crashes, so it must never itself throw or loop.
 * Session-level dedup keeps a crash loop from spamming the endpoint.
 */
let recent = new Set<string>();

export function reportClientError(input: { message: string; stack?: string; source?: string; url?: string }): void {
  try {
    const path = typeof location !== 'undefined' ? location.pathname : '';
    const source = input.source || (path.startsWith('/captain') ? 'captain' : 'web');
    const message = String(input.message || 'Unknown error').slice(0, 2000);

    const key = `${source}|${message.slice(0, 200)}`;
    if (recent.has(key)) return;                     // already reported this bug this session
    recent.add(key);
    if (recent.size > 50) recent = new Set(Array.from(recent).slice(-25));

    const payload = JSON.stringify({
      message,
      stack: String(input.stack || '').slice(0, 8000),
      source,
      url: input.url || (typeof location !== 'undefined' ? location.href : ''),
    });

    // keepalive: the report must survive the reload/navigation the crash triggers.
    fetch('/api/error-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
      cache: 'no-store',
    }).catch(() => {
      // The request never reached the server (offline / network error) — drop the
      // dedup key so this error can be re-reported when it next occurs. On any
      // server RESPONSE (even non-OK) we keep the key: the server got it and
      // dedups its own way, so we avoid a retry/throttle loop.
      try { recent.delete(key); } catch { /* ignore */ }
    });
  } catch { /* never throw from the reporter */ }
}
