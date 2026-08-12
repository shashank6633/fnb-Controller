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
 *
 * NOT A TRUST SIGNAL. Everything in here is client state a GRE can set by
 * typing a URL — isCaptainApp() only decides HOW to dial, and the cb_* return
 * params are a claim, not evidence. The one fact that cannot be typed is the
 * server-issued call token this module round-trips (mintCallToken below); the
 * server decides what it proves.
 */
import { api } from '@/lib/api';

const PKG = 'com.akanhyd.fnb.captainapp';
const FLAG = 'akan_captain_twa';

/**
 * How long a TAP may wait for a call token before we dial without one.
 *
 * The Captain-APK path is the only one that has to block: the token has to be
 * inside the intent URL, because the APK is what navigates back. 1.2s is long
 * enough to cover an ordinary same-origin round trip and short enough that a GRE
 * never concludes the button is broken and taps it twice. It is a ceiling, not a
 * delay — the endpoint does one insert and returns, so the dial normally starts
 * without a perceptible pause.
 *
 * IT ALSO HAS TO STAY SHORT FOR A SECOND REASON: Chrome honours an intent://
 * navigation only while the tap's transient user activation is still live (a
 * few seconds). Waiting on the network past that would not just feel broken, it
 * could get the dial itself blocked. Do not raise this into seconds.
 */
export const TOKEN_MINT_TAP_BUDGET_MS = 1200;

/**
 * The budget when nothing is waiting on the answer. The tel: path navigates to
 * the dialer immediately and only needs the token minutes later, when the log
 * sheet is saved, so the request can take as long as a bad mobile connection
 * needs. It still has a ceiling so the promise ALWAYS settles and a save can
 * never hang on it.
 */
export const TOKEN_MINT_IDLE_BUDGET_MS = 8000;

/** crypto.randomUUID() from the server; refuse anything that is not id-shaped. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Ask the server for a call token — its private record of WHEN this GRE started
 * dialling this number, which log-callback later uses to clamp the claimed talk
 * time to the wall time that has actually elapsed.
 *
 * NEVER THROWS, AND MUST NEVER BE MADE TO BLOCK. Offline, server down, slow
 * link, aborted by the budget, garbage response, or the endpoint's own per-agent
 * burst ceiling (429): every one of those returns '' and the caller dials
 * anyway, logging the call unverified. Losing a real guest call back to protect
 * a statistic would be a far worse bug than the one the token exists to fix. Do
 * not "tidy" the callers into awaiting this without a timeout, and do not turn
 * an empty result into an error path — in particular, do NOT surface the 429 to
 * the GRE: there is nothing for them to do about it and the call is unaffected.
 */
export async function mintCallToken(
  opts: { phone?: string; guestId?: string; recoveryId?: string },
  cfg?: { timeoutMs?: number },
): Promise<string> {
  const timeoutMs = cfg?.timeoutMs ?? TOKEN_MINT_TAP_BUDGET_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (ctl) timer = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await api('/api/crm-calls/calls/call-token', {
      method: 'POST',
      body: { phone: opts.phone, guest_id: opts.guestId, recovery_id: opts.recoveryId },
      ...(ctl ? { signal: ctl.signal } : {}),
    });
    if (!r.ok) return '';
    const j = await r.json().catch(() => null);
    const t = typeof j?.token === 'string' ? j.token.trim() : '';
    return TOKEN_SHAPE.test(t) ? t : '';
  } catch {
    return ''; // dial anyway — see the contract above
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
    // A native return deep-link also implies the app — with the caveat in the
    // header: cb=1 is a query param, so a typed URL sets this flag too. It only
    // ever decides HOW to dial. Nothing may treat it as evidence about a call.
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
const CB_PARAMS = ['cb', 'cb_phone', 'cb_duration', 'cb_connected', 'cb_recovery', 'cb_src', 'cb_at', 'cb_fallback', 'cb_token'] as const;

/** Drop any lingering cb_* params from a path+query (an unclaimed earlier
 *  return must never be embedded into the NEXT call's return path, where its
 *  stale duplicates would shadow the new exact values). cb_token is in that
 *  list, so a token from an earlier, unclaimed return cannot ride along and be
 *  spent on a later call — the only token in the outgoing ret is the fresh one
 *  callLoggerIntentUrl appends below. */
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
  token?: string;      // call token to carry through the round trip (optional)
}): string {
  const retBase = sanitizeReturnPath(opts.returnPath);

  // THE TOKEN RIDES HOME IN `ret`. The APK takes ret verbatim and appends its
  // own cb_* params to it, so anything we put here comes back with the exact
  // duration — no APK change needed for any of this (1.3.0 already round-trips
  // an arbitrary path+query). An absent token is normal and survivable: an
  // older APK, or a mint that failed while the GRE dialled anyway.
  const tokenQs = opts.token ? `cb_token=${encodeURIComponent(opts.token)}` : '';
  const ret = tokenQs ? `${retBase}${retBase.includes('?') ? '&' : '?'}${tokenQs}` : retBase;

  const q = new URLSearchParams();
  q.set('phone', opts.phone);
  if (opts.recoveryId) q.set('recovery', opts.recoveryId);
  q.set('ret', ret);

  // cb_fallback=1 marks "the APK's activity was NOT reachable" — the web uses
  // it to clear the stale in-app flag and still open a log sheet. Built from
  // retBase, WITHOUT the token: on this branch no call was ever placed, so
  // there is nothing for a wall-clock bound to be about. Carrying the token
  // here would let a duration typed into that sheet be clamped to the couple of
  // seconds since the tap and then filed as verified, which is the exact
  // species of false confidence the token exists to prevent.
  //
  // cb_src=manual, not approx: nothing measured or estimated anything on this
  // branch — the activity never ran. The sheet must ask the GRE to type the
  // time and record it as typed.
  const sep = retBase.includes('?') ? '&' : '?';
  const fallback = `${window.location.origin}${retBase}${sep}cb=1&cb_fallback=1&cb_src=manual&cb_duration=0&cb_connected=0&cb_phone=${encodeURIComponent(opts.phone)}${opts.recoveryId ? `&cb_recovery=${encodeURIComponent(opts.recoveryId)}` : ''}`;

  return `intent://log?${q.toString()}#Intent;scheme=akancall;package=${PKG};S.browser_fallback_url=${encodeURIComponent(fallback)};end`;
}

/**
 * Parsed native-return params (null when the URL has none).
 *
 * A CLAIM, NOT EVIDENCE — every field here is a query param, and a query param
 * can be typed. `token` is the one thing that is worth anything, and only
 * because the server minted it and will decide for itself what it proves.
 */
export interface CallbackReturn {
  phone: string;
  durationSec: number;
  connected: boolean;
  recoveryId: string;
  /** call_log = the APK read the device call log (the only measurement);
   *  approx = the APK's own wall time, when the log could not be read;
   *  manual = the browser-fallback link, where nothing ran and nothing was
   *  measured, so the sheet must be a typed entry. */
  source: 'call_log' | 'approx' | 'manual';
  at: string;
  /** The call token we sent out in `ret`, handed back by the APK. '' if none. */
  token: string;
}

export function parseCallbackReturn(): CallbackReturn | null {
  try {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get('cb') !== '1') return null;
    const phone = sp.get('cb_phone') || '';
    if (!phone) return null;
    const duration = Math.max(0, parseInt(sp.get('cb_duration') || '0', 10) || 0);
    const token = (sp.get('cb_token') || '').trim();
    const src = sp.get('cb_src');
    return {
      phone,
      durationSec: duration,
      connected: sp.get('cb_connected') === '1',
      recoveryId: sp.get('cb_recovery') || '',
      // Exactly three values are ever emitted: the APK sends 'calllog' or
      // 'approx', and our own browser-fallback link sends 'manual'. Anything
      // else (including nothing at all) can only be a hand-edited URL, so it
      // falls to 'manual' — the weakest claim, which keeps the duration
      // editable and captioned as typed instead of dressing it up as the app's
      // own estimate.
      source: src === 'calllog' ? 'call_log' : src === 'approx' ? 'approx' : 'manual',
      at: sp.get('cb_at') || '',
      // Shape-checked here so an edited URL cannot push junk into the log body;
      // whether the id is real, unspent, this agent's and this number's is the
      // server's call, not ours.
      token: TOKEN_SHAPE.test(token) ? token : '',
    };
  } catch { return null; }
}

/** Strip the cb_* params so refresh/back doesn't re-open the sheet. cb_token
 *  goes with them (it is in CB_PARAMS): the claiming component has taken it
 *  into memory by now, and leaving it in the address bar would let a refresh,
 *  a back-navigation or a copied link present a stale token again. */
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
