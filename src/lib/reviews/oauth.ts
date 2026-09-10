/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * GOOGLE BUSINESS PROFILE — the OAuth connect flow.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNPROVEN AGAINST GOOGLE. No endpoint here has been called and no credential
 * exercised — the Google account does not exist yet; the owner has to create
 * it. Request shapes are built from Google's published reference. The
 * RESPONSES are untested. The first real connect is the test.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS FILE EXISTS AT ALL — the design law, in the owner's own words:
 * "Better where it can automatically retrieve the data, it is very helpful
 * right." He is right, and a feature that needs a manual export every day is a
 * feature he stops using in week two. So the product is: press one button,
 * authorise as the account that MANAGES the listing, pick the listing from a
 * list, and reviews arrive on their own from then on.
 *
 * ── THE CORRECTION THE UI MUST CARRY ────────────────────────────────────────
 * PASTING A GOOGLE MAPS URL DOES NOT WORK, and no amount of engineering makes
 * it work. Review history is gated behind ownership plus OAuth: only an account
 * that manages the listing can read it. The public Places API returns a hard
 * maximum of FIVE reviews, ordered by relevance rather than recency, with no
 * pagination and no paid tier that lifts it — useless for a daily count, a
 * trend, or an unanswered queue. So the screen must ask him to CONNECT the
 * managing account. A URL box would be a lie shaped like a feature.
 *
 * ── WHAT THIS FILE IS RESPONSIBLE FOR ───────────────────────────────────────
 *   buildAuthUrl()      the consent URL, with the two parameters that decide
 *                       whether this feature works next week
 *   signState/verifyState   CSRF protection across the redirect, pure both ways
 *   exchangeCode()      authorisation code -> refresh token (the durable one)
 *   refreshAccessToken()  refresh token -> access token (the ~1-hour one)
 *
 * Everything except the two fetches is pure, so the interesting parts —
 * "does a tampered state get rejected", "is prompt=consent actually set",
 * "does an expired access token get treated as expired" — are testable with no
 * network and no credential. scripts/reviews-tests.js does exactly that.
 *
 * ── THE TWO PARAMETERS EVERYTHING DEPENDS ON ────────────────────────────────
 * access_type=offline  — without it Google returns NO refresh token, and the
 *                        connection dies the first time the access token
 *                        expires, about an hour later.
 * prompt=consent       — Google returns a refresh token only on the FIRST
 *                        authorisation for a given client/user pair. Re-connect
 *                        without it and the exchange succeeds while handing
 *                        back no refresh token, leaving a connection that looks
 *                        fine and cannot survive an hour. Forcing the consent
 *                        screen every time is the price of a re-connect button
 *                        that actually re-connects.
 * Both are asserted by tests, because both fail SILENTLY and late.
 */
import crypto from 'crypto';

/** The scope that grants read access to the listing's reviews. */
export const GBP_SCOPE = 'https://www.googleapis.com/auth/business.manage';

export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
/** OpenID userinfo, used only to record WHICH Google account is connected so
 *  the page can say "connected as ..." instead of "connected". */
export const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

/** How long an in-flight connect attempt stays valid. Long enough to read a
 *  consent screen carefully, short enough that an abandoned attempt cannot be
 *  completed by someone else tomorrow. */
export const STATE_TTL_MS = 15 * 60 * 1000;

/**
 * Refresh the access token this many milliseconds BEFORE Google says it
 * expires. A token that expires mid-pagination turns page 7 of a 9-page pull
 * into a 401, and the skew between two machines' clocks is real. Two minutes of
 * paranoia costs one extra token exchange an hour at worst.
 */
export const TOKEN_EXPIRY_SKEW_MS = 120_000;

/* ── State: signed AND single-use ─────────────────────────────────────────── */

export interface StatePayload {
  /** Random, and the primary key of the single-use row in gr_oauth_state. */
  nonce: string;
  /** Issued-at, epoch ms. */
  iat: number;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

export function newNonce(): string {
  return b64url(crypto.randomBytes(24));
}

/**
 * state = base64url(payload) + '.' + base64url(HMAC-SHA256(payload, secret)).
 *
 * Signed rather than opaque so a forged or edited state is rejected before it
 * ever reaches the database, and so the failure is distinguishable: a bad
 * signature is an attack or a misconfiguration, an unknown nonce is a replay or
 * an expired attempt, and the two deserve different messages.
 */
export function signState(payload: StatePayload, secret: string): string {
  if (!secret) throw new Error('signState: refusing to sign with an empty secret');
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const mac = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  return `${body}.${mac}`;
}

export type StateFailure = 'malformed' | 'bad_signature' | 'expired';

export type VerifyStateResult =
  | { ok: true; payload: StatePayload }
  | { ok: false; reason: StateFailure };

/**
 * Verify a state parameter. Pure — no database, no clock of its own (pass
 * `now`), so every branch is testable.
 *
 * The signature comparison is timingSafeEqual on equal-length buffers. It is
 * almost certainly unnecessary for a 15-minute CSRF token, and it costs one
 * line.
 */
export function verifyState(state: string, secret: string, now = Date.now()): VerifyStateResult {
  if (!state || !secret) return { ok: false, reason: 'malformed' };
  const dot = state.indexOf('.');
  if (dot <= 0 || dot === state.length - 1) return { ok: false, reason: 'malformed' };

  const body = state.slice(0, dot);
  const mac = state.slice(dot + 1);
  const expected = b64url(crypto.createHmac('sha256', secret).update(body).digest());

  const a = Buffer.from(mac, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload: StatePayload;
  try {
    payload = JSON.parse(fromB64url(body).toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!payload || typeof payload.nonce !== 'string' || !payload.nonce ||
      typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) {
    return { ok: false, reason: 'malformed' };
  }
  if (now - payload.iat > STATE_TTL_MS) return { ok: false, reason: 'expired' };
  // A state issued in the future by more than the skew is a tampered or badly
  // clocked one; treat it as expired rather than trusting it.
  if (payload.iat - now > STATE_TTL_MS) return { ok: false, reason: 'expired' };

  return { ok: true, payload };
}

/* ── The consent URL ──────────────────────────────────────────────────────── */

export interface AuthUrlOptions {
  clientId: string;
  /** Must EXACTLY match a redirect URI registered on the OAuth client in Google
   *  Cloud Console — Google compares it as a string, not as a URL. The same
   *  value must be replayed at code exchange, which is why it is stored on the
   *  state row rather than recomputed later from a different request's host. */
  redirectUri: string;
  state: string;
  /** Override only for a test. */
  scope?: string;
  /** Pre-fill the account chooser. Never a substitute for the user choosing. */
  loginHint?: string;
}

export function buildAuthUrl(opts: AuthUrlOptions): string {
  if (!opts.clientId) throw new Error('buildAuthUrl: missing client id');
  if (!opts.redirectUri) throw new Error('buildAuthUrl: missing redirect URI');
  if (!opts.state) throw new Error('buildAuthUrl: missing state');

  const u = new URL(AUTH_URL);
  u.searchParams.set('client_id', opts.clientId);
  u.searchParams.set('redirect_uri', opts.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', `${opts.scope || GBP_SCOPE} openid email`);
  // See the header: without these two the connection cannot survive an hour,
  // and it fails silently and late.
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('include_granted_scopes', 'true');
  u.searchParams.set('state', opts.state);
  if (opts.loginHint) u.searchParams.set('login_hint', opts.loginHint);
  return u.toString();
}

/* ── Token endpoint ───────────────────────────────────────────────────────── */

export interface TokenSet {
  accessToken: string;
  /** Empty when Google did not return one. On a code exchange that is a FAULT,
   *  not a detail — see exchangeCode(). */
  refreshToken: string;
  /** Epoch ms, already reduced by TOKEN_EXPIRY_SKEW_MS. */
  expiresAtMs: number;
  scope: string;
  idToken: string;
}

/** Raised when Google refuses the refresh token itself. This is the terminal
 *  one: retrying cannot fix it, and the only cure is a human re-authorising. */
export class ReconnectRequiredError extends Error {
  googleError: string;
  constructor(message: string, googleError = 'invalid_grant') {
    super(message);
    this.name = 'ReconnectRequiredError';
    this.googleError = googleError;
  }
}

/** Compute the absolute expiry from Google's relative `expires_in`, minus skew.
 *  Pure, so the clamp is testable. A missing or absurd expires_in is treated as
 *  a short life rather than an infinite one — assuming a token lasts forever is
 *  how a connector starts 401-ing in production. */
export function expiryFromExpiresIn(expiresIn: unknown, now = Date.now()): number {
  const secs = Number(expiresIn);
  const safe = Number.isFinite(secs) && secs > 0 ? Math.min(secs, 24 * 3600) : 300;
  return now + safe * 1000 - TOKEN_EXPIRY_SKEW_MS;
}

async function postToken(params: Record<string, string>, signal?: AbortSignal): Promise<any> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal,
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = String(json?.error || '');
    const desc = String(json?.error_description || `HTTP ${res.status}`);
    if (err === 'invalid_grant') {
      throw new ReconnectRequiredError(
        'Google refused the credential (invalid_grant). The two usual causes are an OAuth ' +
        'consent screen left in Testing — where refresh tokens expire after 7 days — and ' +
        'access revoked in the Google account. Reconnect to fix it. Reviews already ' +
        'imported are unaffected, and a Takeout import still works meanwhile.',
        err,
      );
    }
    // The description can echo request parameters back; never let a secret ride
    // out in an error string.
    throw new Error(`Google token endpoint refused the request: ${err || 'error'} — ${desc}`.slice(0, 400));
  }
  return json;
}

/**
 * Authorisation code -> tokens. The one moment a refresh token is ever issued.
 *
 * A missing refresh_token here is treated as a hard failure rather than
 * shrugged off, and that decision is the difference between a connector that
 * works and one that appears to. Google issues a refresh token only on the
 * first consent for a client/user pair; on a re-authorisation without
 * prompt=consent it returns an access token and no refresh token. Accepting
 * that would store a connection that dies in an hour with no way to renew, and
 * the owner would have no idea why. So: fail here, loudly, at the moment the
 * cause is knowable.
 *
 * UNPROVEN — not exercised against Google.
 */
export async function exchangeCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  now?: number;
  signal?: AbortSignal;
}): Promise<TokenSet> {
  const json = await postToken({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code: opts.code,
    redirect_uri: opts.redirectUri,
    grant_type: 'authorization_code',
  }, opts.signal);

  const refreshToken = String(json?.refresh_token || '');
  if (!refreshToken) {
    throw new Error(
      'Google completed the sign-in but returned no refresh token, so this connection ' +
      'could not renew itself and would stop working within the hour. This happens when ' +
      'the account has already authorised this app and was not asked to consent again. ' +
      'Remove this app at myaccount.google.com/permissions and connect once more.',
    );
  }
  return {
    accessToken: String(json?.access_token || ''),
    refreshToken,
    expiresAtMs: expiryFromExpiresIn(json?.expires_in, opts.now ?? Date.now()),
    scope: String(json?.scope || ''),
    idToken: String(json?.id_token || ''),
  };
}

/**
 * Refresh token -> access token. Runs before every pull whose cached token has
 * expired.
 *
 * UNPROVEN — not exercised against Google.
 */
export async function refreshAccessToken(opts: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  now?: number;
  signal?: AbortSignal;
}): Promise<TokenSet> {
  const json = await postToken({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    refresh_token: opts.refreshToken,
    grant_type: 'refresh_token',
  }, opts.signal);

  const accessToken = String(json?.access_token || '');
  if (!accessToken) throw new Error('Google returned no access_token when refreshing the connection.');
  return {
    accessToken,
    // A refresh response does not re-issue the refresh token; the caller keeps
    // the one it already has.
    refreshToken: '',
    expiresAtMs: expiryFromExpiresIn(json?.expires_in, opts.now ?? Date.now()),
    scope: String(json?.scope || ''),
    idToken: String(json?.id_token || ''),
  };
}

/**
 * Which Google account authorised this, for the "connected as ..." line.
 * Best-effort by design: failing to read an email is not a reason to fail a
 * connection that otherwise works, so this returns '' rather than throwing.
 */
export async function fetchGoogleEmail(accessToken: string, signal?: AbortSignal): Promise<string> {
  try {
    const res = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal,
    });
    if (!res.ok) return '';
    const json: any = await res.json().catch(() => ({}));
    return String(json?.email || '');
  } catch {
    return '';
  }
}

/**
 * Ask Google to forget the token on disconnect.
 *
 * Best-effort: a disconnect must clear OUR stored credential whether or not
 * Google answers. Leaving a revoked-but-stored token would be worse than a
 * live-but-forgotten one, so local deletion never depends on this call.
 */
export async function revokeToken(token: string, signal?: AbortSignal): Promise<boolean> {
  if (!token) return false;
  try {
    const res = await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      signal,
    });
    return res.ok;
  } catch {
    return false;
  }
}
