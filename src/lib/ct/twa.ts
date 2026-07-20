'use client';

/**
 * Call-to-Table — AKAN Captain APK (TWA) detection + native call-logger bridge.
 *
 * The Android app is a Trusted Web Activity: Chrome renders this site, so
 * there is no JS bridge. Native features are reached via an intent:// link to
 * CallLoggerActivity (scheme akancall://log) inside the same APK, which
 * places the call, reads the EXACT duration from the device call log, and
 * deep-links back with cb_* query params.
 *
 * Detection: Chrome sets document.referrer to android-app://<package> for the
 * TWA's entry navigation. That referrer only exists on the first document, so
 * we persist a flag in localStorage the moment we see it (markTwaIfReferred is
 * called from the CRM layout + CallbackButton mounts). A cb_* return deep-link
 * is also proof we're in the app.
 */

const PKG = 'com.akanhyd.fnb.captainapp';
const FLAG = 'akan_captain_twa';

export function markTwaIfReferred(): void {
  try {
    if (typeof document === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    // cb_fallback=1 means Chrome could NOT open CallLoggerActivity (the APK was
    // uninstalled or replaced) — the flag is stale, clear it so Call Back goes
    // back to the plain tel:+timer flow instead of dead intent links.
    if (sp.get('cb_fallback') === '1') {
      localStorage.removeItem(FLAG);
      return;
    }
    if (document.referrer.startsWith(`android-app://${PKG}`)) {
      localStorage.setItem(FLAG, '1');
    }
    // A REAL native return deep-link is equally conclusive.
    if (sp.get('cb') === '1') {
      localStorage.setItem(FLAG, '1');
    }
  } catch { /* storage unavailable — detection just stays off */ }
}

export function isCaptainApp(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(FLAG) === '1';
  } catch { return false; }
}

/**
 * intent:// URL that opens CallLoggerActivity in the APK. If (somehow) the
 * activity is missing, Chrome falls back to `fallbackUrl` — we point that at
 * the current page with cb params so the manual sheet still opens.
 */
const CB_PARAMS = ['cb', 'cb_phone', 'cb_duration', 'cb_connected', 'cb_recovery', 'cb_src', 'cb_at', 'cb_fallback'] as const;

/** Drop any lingering cb_* params from a path+query (an unclaimed earlier
 *  return must never be embedded into the NEXT call's return path, where its
 *  stale duplicates would shadow the new exact values). */
function sanitizeReturnPath(raw: string | undefined): string {
  if (!raw || !raw.startsWith('/')) return '/crm-calls/recovery';
  try {
    const u = new URL(raw, 'https://x.invalid');
    for (const k of CB_PARAMS) u.searchParams.delete(k);
    const qs = u.searchParams.toString();
    return u.pathname + (qs ? `?${qs}` : '');
  } catch { return '/crm-calls/recovery'; }
}

export function callLoggerIntentUrl(opts: {
  phone: string;
  recoveryId?: string;
  returnPath?: string; // path+query to reopen after the call (defaults to /crm-calls/recovery)
}): string {
  const ret = sanitizeReturnPath(opts.returnPath);
  const q = new URLSearchParams();
  q.set('phone', opts.phone);
  if (opts.recoveryId) q.set('recovery', opts.recoveryId);
  q.set('ret', ret);

  // cb_fallback=1 marks "the APK's activity was NOT reachable" — the web uses
  // it to clear the stale in-app flag and still open a manual sheet.
  const sep = ret.includes('?') ? '&' : '?';
  const fallback = `${window.location.origin}${ret}${sep}cb=1&cb_fallback=1&cb_src=approx&cb_duration=0&cb_connected=0&cb_phone=${encodeURIComponent(opts.phone)}${opts.recoveryId ? `&cb_recovery=${encodeURIComponent(opts.recoveryId)}` : ''}`;

  return `intent://log?${q.toString()}#Intent;scheme=akancall;package=${PKG};S.browser_fallback_url=${encodeURIComponent(fallback)};end`;
}

/** Parsed native-return params (null when the URL has none). */
export interface CallbackReturn {
  phone: string;
  durationSec: number;
  connected: boolean;
  recoveryId: string;
  source: 'call_log' | 'approx';
  at: string;
}

export function parseCallbackReturn(): CallbackReturn | null {
  try {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get('cb') !== '1') return null;
    const phone = sp.get('cb_phone') || '';
    if (!phone) return null;
    const duration = Math.max(0, parseInt(sp.get('cb_duration') || '0', 10) || 0);
    return {
      phone,
      durationSec: duration,
      connected: sp.get('cb_connected') === '1',
      recoveryId: sp.get('cb_recovery') || '',
      source: sp.get('cb_src') === 'calllog' ? 'call_log' : 'approx',
      at: sp.get('cb_at') || '',
    };
  } catch { return null; }
}

/** Strip the cb_* params so refresh/back doesn't re-open the sheet. */
export function clearCallbackReturnParams(): void {
  try {
    const url = new URL(window.location.href);
    for (const k of CB_PARAMS) url.searchParams.delete(k);
    window.history.replaceState(null, '', url.pathname + (url.search || '') + url.hash);
  } catch { /* non-fatal */ }
}

/** Digit-suffix equality (last 10) — matches how the call log stores numbers. */
export function samePhone(a: string, b: string): boolean {
  const suf = (s: string) => {
    const d = s.replace(/\D/g, '');
    return d.length <= 10 ? d : d.slice(-10);
  };
  const sa = suf(a), sb = suf(b);
  return !!sa && sa === sb;
}
