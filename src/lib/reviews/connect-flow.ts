/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * GOOGLE REVIEWS — the connect flow, start to finish.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNPROVEN. No Google endpoint has been called and no credential exercised.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Three steps, in the order the owner experiences them:
 *
 *   1. beginConnect()     "Connect Google Business Profile" -> a consent URL.
 *   2. completeConnect()  Google redirects back with a code -> tokens stored.
 *   3. selectLocation()   he picks the AKAN listing from the discovered list.
 *
 * Step 3 is separate from step 2 on purpose. Authorising an account and
 * choosing which of its listings to track are different decisions, and an
 * account can hold several. Auto-selecting the only listing when there IS only
 * one is a convenience the caller may apply; silently picking the first of five
 * would be a bug that reports another restaurant's reviews as this one's.
 *
 * ── THE REDIRECT URI IS THE THING THAT BREAKS ───────────────────────────────
 * Google compares redirect_uri as an exact STRING against what is registered on
 * the OAuth client. http vs https, a trailing slash, a proxy rewriting the
 * host — any of these produce redirect_uri_mismatch, which reads like a code
 * bug and is a configuration one. So:
 *   • the value used at step 1 is STORED on the state row and REPLAYED verbatim
 *     at step 2, rather than being recomputed from the callback request (whose
 *     headers may differ);
 *   • an admin can pin it outright with reviews_gbp_redirect_uri when the app
 *     sits behind a proxy;
 *   • callbackUrl() is exported so the connect screen can display the exact
 *     string to paste into Google Cloud Console.
 */
import type Database from 'better-sqlite3';
import { getDb } from '@/lib/db';
import { ensureReviewSchema, reviewSetting, setReviewSetting } from './schema';
import {
  GBP_KEYS, createOauthState, consumeOauthState, gbpCredentials, getConnection,
  hasOauthApp, saveConnection, stateSecret, DEFAULT_INTERVAL_MIN, MAX_INTERVAL_MIN,
  MIN_INTERVAL_MIN,
} from './connection';
import {
  buildAuthUrl, exchangeCode, fetchGoogleEmail, newNonce, signState, verifyState,
} from './oauth';
import { gbpDiscover, isValidParent, type GbpAccount, type GbpLocation } from './sources-gbp';

type DB = Database.Database;

const nowIso = (ms = Date.now()) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** The path Google redirects back to. One constant, because it appears in three
 *  places — the auth request, the token exchange, and the instructions telling
 *  the admin what to register — and they must never drift apart. */
export const CALLBACK_PATH = '/api/crm-calls/reviews/connect/callback';

/**
 * The exact redirect URI to use and to register.
 *
 * `origin` comes from the incoming request. An explicitly configured value wins,
 * because a proxied deployment is exactly the case the request headers get
 * wrong, and a wrong value here fails at Google with a message that sounds like
 * a bug in this app.
 */
export function callbackUrl(dbIn: DB | null, origin: string): string {
  const db = dbIn || getDb();
  const pinned = reviewSetting(db, GBP_KEYS.redirectUri, '').trim();
  if (pinned) return pinned;
  return `${String(origin || '').replace(/\/+$/, '')}${CALLBACK_PATH}`;
}

/* ── Step 1: begin ────────────────────────────────────────────────────────── */

export interface BeginResult {
  authUrl: string;
  redirectUri: string;
}

/**
 * Mint a single-use state and build the consent URL.
 *
 * Fails loudly when the OAuth client is not registered, rather than sending the
 * owner to a Google error page: "you have not set this up yet" is a sentence
 * worth reading, and Google's version of it is not.
 */
export function beginConnect(
  dbIn: DB | null,
  opts: { origin: string; actor: string; locationKey?: string; now?: number },
): BeginResult {
  const db = ensureReviewSchema(dbIn || getDb());
  const creds = gbpCredentials(db);
  if (!creds.clientId || !creds.clientSecret) {
    throw new Error(
      'The Google OAuth client is not set up yet. Add the client ID and client secret from ' +
      'Google Cloud Console first — the connect button cannot do that part.',
    );
  }

  const redirectUri = callbackUrl(db, opts.origin);
  if (!redirectUri.startsWith('http')) {
    throw new Error(`Could not work out this app's callback URL (got ${JSON.stringify(redirectUri)}). Set reviews_gbp_redirect_uri explicitly.`);
  }

  const now = opts.now ?? Date.now();
  const nonce = newNonce();
  createOauthState(db, {
    nonce, redirectUri, actor: opts.actor, locationKey: opts.locationKey || '', now,
  });

  return {
    authUrl: buildAuthUrl({
      clientId: creds.clientId,
      redirectUri,
      state: signState({ nonce, iat: now }, stateSecret(db)),
    }),
    redirectUri,
  };
}

/* ── Step 2: complete ─────────────────────────────────────────────────────── */

export interface CompleteResult {
  googleEmail: string;
  locationKey: string;
  /** Everything the picker needs, fetched immediately so the owner lands on a
   *  list of his own listings rather than on a second button. */
  accounts: Array<GbpAccount & { locations: GbpLocation[] }>;
  /** Set when discovery failed. The connection is still good — the token works
   *  — so this is a warning, not a failure. */
  discoveryError: string;
}

/**
 * Exchange the authorisation code and store the connection.
 *
 * The state is checked TWICE and both checks matter: the signature proves the
 * value came from us (rejecting a forged callback), and consuming the nonce
 * proves it has not been used before (rejecting a replayed one). Either alone
 * leaves a gap.
 *
 * UNPROVEN — the Google calls have never been exercised.
 */
export async function completeConnect(
  dbIn: DB | null,
  opts: { code: string; state: string; actor: string; now?: number; signal?: AbortSignal },
): Promise<CompleteResult> {
  const db = ensureReviewSchema(dbIn || getDb());
  const now = opts.now ?? Date.now();

  if (!opts.code) throw new Error('Google did not return an authorisation code.');

  const verified = verifyState(opts.state, stateSecret(db), now);
  if (!verified.ok) {
    throw new Error(
      verified.reason === 'expired'
        ? 'This connect attempt timed out. Press Connect Google Business Profile again.'
        : 'This sign-in could not be verified as one this app started. Press Connect Google ' +
          'Business Profile again, and do not use a link from anywhere else.',
    );
  }

  const consumed = consumeOauthState(db, verified.payload.nonce, now);
  if (!consumed.ok) {
    throw new Error(
      consumed.reason === 'used'
        ? 'This sign-in link has already been used. If the connection is showing as connected, ' +
          'nothing more is needed.'
        : 'This connect attempt is no longer valid. Press Connect Google Business Profile again.',
    );
  }

  const creds = gbpCredentials(db);
  // The redirect URI is replayed from the state row, NOT recomputed: Google
  // requires the exchange to present the same string the authorisation did.
  const tokens = await exchangeCode({
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    code: opts.code,
    redirectUri: consumed.redirectUri,
    now,
    signal: opts.signal,
  });

  const locationKey = consumed.locationKey || '';
  const email = await fetchGoogleEmail(tokens.accessToken, opts.signal);

  setReviewSetting(db, GBP_KEYS.refreshToken, tokens.refreshToken);
  setReviewSetting(db, GBP_KEYS.accessToken, tokens.accessToken);

  const existing = getConnection(db, locationKey);
  saveConnection(db, locationKey, {
    status: 'connected',
    google_email: email,
    scope: tokens.scope,
    connected_at: nowIso(now),
    connected_by: opts.actor || consumed.actor || '',
    token_expires_at: nowIso(tokens.expiresAtMs),
    last_error: '',
    last_error_at: '',
    consecutive_failures: 0,
    // A RE-connect must not silently re-point at a listing chosen long ago
    // under a different account. Keep the listing only when the same Google
    // account is reconnecting; otherwise clear it and make him pick again.
    location_name: existing.google_email && existing.google_email !== email ? '' : existing.location_name,
    location_label: existing.google_email && existing.google_email !== email ? '' : existing.location_label,
    location_address: existing.google_email && existing.google_email !== email ? '' : existing.location_address,
  });

  let accounts: Array<GbpAccount & { locations: GbpLocation[] }> = [];
  let discoveryError = '';
  try {
    accounts = await gbpDiscover(db, { locationKey, signal: opts.signal });
  } catch (e: any) {
    // Discovery failing does not invalidate the connection — the token works,
    // or the exchange above would have thrown. Most likely the Business Profile
    // API application has not been approved yet, which is paperwork.
    discoveryError = String(e?.message || e).slice(0, 500);
  }

  return { googleEmail: email, locationKey, accounts, discoveryError };
}

/* ── Step 3: choose the listing ───────────────────────────────────────────── */

/**
 * Point the connector at one listing.
 *
 * The name is validated rather than trusted. This value goes straight into a
 * URL path, and an unvalidated one is both a 404 at 3am and a path-traversal
 * shaped hole in a request built by string concatenation.
 */
export function selectLocation(
  dbIn: DB | null,
  opts: { locationKey?: string; name: string; label?: string; address?: string },
): void {
  const db = ensureReviewSchema(dbIn || getDb());
  const name = String(opts.name || '').trim();
  if (!isValidParent(name)) {
    throw new Error(
      `A listing must look like accounts/{accountId}/locations/{locationId}; got ${JSON.stringify(name.slice(0, 80))}.`,
    );
  }
  saveConnection(db, opts.locationKey || '', {
    location_name: name,
    location_label: (opts.label || name).slice(0, 200),
    location_address: (opts.address || '').slice(0, 300),
  });
}

/**
 * Arm or disarm the scheduled refresh.
 *
 * Turning it ON is the moment this feature becomes what was asked for, so the
 * caller should offer it immediately after a listing is chosen. It is still a
 * deliberate act rather than an automatic consequence of connecting: unattended
 * traffic against someone's Google quota should be something a person switched
 * on.
 */
export function setAutoRefresh(
  dbIn: DB | null,
  opts: { locationKey?: string; enabled: boolean; intervalMinutes?: number },
): void {
  const db = ensureReviewSchema(dbIn || getDb());
  const raw = Number(opts.intervalMinutes);
  const interval = Number.isFinite(raw) && raw > 0
    ? Math.min(MAX_INTERVAL_MIN, Math.max(MIN_INTERVAL_MIN, Math.round(raw)))
    : DEFAULT_INTERVAL_MIN;
  saveConnection(db, opts.locationKey || '', {
    auto_enabled: opts.enabled ? 1 : 0,
    interval_minutes: interval,
  });
}

/** Re-run discovery for the picker without re-authorising. */
export async function listConnectedLocations(
  dbIn: DB | null, opts: { locationKey?: string; signal?: AbortSignal } = {},
): Promise<Array<GbpAccount & { locations: GbpLocation[] }>> {
  const db = ensureReviewSchema(dbIn || getDb());
  if (!hasOauthApp(db)) throw new Error('The Google OAuth client is not set up yet.');
  return gbpDiscover(db, opts);
}
