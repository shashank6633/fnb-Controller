/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * GOOGLE BUSINESS PROFILE — the automatic connector. THE PRIMARY PATH.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNPROVEN. NO GOOGLE ENDPOINT WAS CALLED AND NO CREDENTIAL EXERCISED WHILE
 * THIS WAS WRITTEN.
 * ══════════════════════════════════════════════════════════════════════════
 * Everything below is built from Google's published reference and wired end to
 * end, but not one line has round-tripped against a live account, because the
 * account does not exist yet — the owner has to create it. Treat the request
 * shapes as documented-correct and the RESPONSES as untested. The first real
 * pull is the test. Specific unknowns are in UNPROVEN below and are returned by
 * status() so a screen can print them rather than implying this is proven.
 *
 * ── WHAT THE OWNER ASKED FOR, AND WHAT THAT MEANS HERE ──────────────────────
 * "It should automatically retrieve the reviews data... how can we import every
 * time?" So: automatic is the product. This file is the primary path and the
 * CSV/Takeout importer is the backfill and the fallback — history predating the
 * connection, and a way to keep working while Google's approval is pending or
 * after a token breaks. Both write the same rows through the same identity key,
 * so they de-duplicate against each other and can be used together.
 *
 * ── WHERE REVIEWS LIVE, AND WHY IT LOOKS ODD ────────────────────────────────
 * Reviews are on the LEGACY My Business API v4:
 *     GET https://mybusiness.googleapis.com/v4/{parent}/reviews
 * The monolithic v4 API was largely sunset in April 2022, but reviews were never
 * migrated to the newer split APIs and are not on the deprecation schedule. So
 * the endpoint is old, alive and un-replatformed. That is a real long-term risk
 * and the strongest argument for keeping the Takeout path permanently rather
 * than treating it as scaffolding.
 *
 * DISCOVERY, though, is on the NEW APIs — accounts on Account Management v1,
 * locations on Business Information v1. So this connector talks to three hosts
 * with one token. That is not a mistake in the code; it is the shape of Google's
 * migration.
 *
 * ── WHAT ONE PULL BUYS ──────────────────────────────────────────────────────
 * Every review carries `createTime`, the moment it was WRITTEN. So a single full
 * pull reconstructs the entire day/week/month history retroactively. The owner
 * does not connect this and then wait six months for a trend line; he gets his
 * whole history the first time it runs.
 *
 * ── THE ONE THING THAT MUST NEVER HAPPEN ────────────────────────────────────
 * A silent stop. Every path out of this file — success, refusal, network error,
 * a token Google will not renew — writes to the connection record in
 * ./connection.ts, so the page can always say whether data is actually
 * arriving. A connector that fails quietly is worse than no connector, because
 * a stale page looks exactly like a venue with no new complaints.
 */
import type Database from 'better-sqlite3';
import { getDb } from '@/lib/db';
import { scrubCredentials } from '@/lib/ct/recording-fetch';
import { reviewSetting, setReviewSetting, ensureReviewSchema } from './schema';
import {
  GBP_KEYS, gbpCredentials, getConnection, hasOauthApp, recordFailure, saveConnection,
} from './connection';
import { GBP_SCOPE, ReconnectRequiredError, refreshAccessToken } from './oauth';
import type { CollectOptions, RawDocument, ReviewSource, SourceStatus } from './types';
import { SourceNotConfiguredError } from './types';

export { GBP_KEYS, GBP_SCOPE };

const REVIEWS_HOST = 'https://mybusiness.googleapis.com/v4';
const ACCOUNTS_HOST = 'https://mybusinessaccountmanagement.googleapis.com/v1';
const INFO_HOST = 'https://mybusinessbusinessinformation.googleapis.com/v1';

/** Google's documented maximum for the reviews endpoint. Asking for more is
 *  rejected, not clamped. */
export const GBP_PAGE_SIZE = 50;
/** Safety valve. 200 pages x 50 = 10,000 reviews in one pull, far past any
 *  single restaurant, and it stops a pagination bug becoming an infinite loop
 *  against a quota the owner waited weeks to be granted. */
export const GBP_MAX_PAGES = 200;
/** Locations page size for discovery. The owner is picking from a list; a
 *  hundred is more than any single restaurant group will scroll. */
export const GBP_LOCATIONS_PAGE_SIZE = 100;

const nowIso = (ms = Date.now()) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export const PREREQUISITES: string[] = [
  'Confirm whether the Google account that manages the listing is Google Workspace or a plain @gmail.com — Workspace allows the far cheaper Internal consent-screen route.',
  'Confirm the Business Profile is verified and has been active for 60+ days, and that the business has a website (both are Google prerequisites for API access).',
  'Create a Google Cloud project and note its project number.',
  'Submit the Google Business Profile "Application for Basic API Access" from an email listed as an owner or manager on the profile.',
  'Wait for the approval email, then check in Cloud Console that the quota reads 300 QPM and not 0. (Google says: if quota is 0 you have not been granted access — do not request a quota increase, submit the application.)',
  'Enable the Business Profile APIs on the project (Account Management, Business Information, and My Business v4).',
  'Configure the OAuth consent screen. Internal if the account is Workspace; otherwise publish to Production and expect Google verification — leaving it in Testing expires the refresh token every 7 days.',
  'Create an OAuth client of type "Web application" and add this app\'s callback URL to its Authorised redirect URIs, exactly as shown on the connect screen.',
  'Paste the client ID and client secret into settings, then press Connect Google Business Profile and authorise as the account that manages the listing.',
];

export const UNPROVEN: string[] = [
  'No Google endpoint has been called and no credential exercised — every response shape here is from documentation, not from a round trip.',
  'The v4 Reviews endpoint has no separately published quota; the 300 QPM figure Google publishes is for the newer Business Profile APIs. Do not plan against a specific number for v4 reviews.',
  'Google publishes no turnaround time for Basic API Access approval. Third-party estimates of 2-4 weeks are not a commitment and are not a date.',
  'Whether the business.manage scope is classed sensitive or restricted (which decides how heavy consent-screen verification is) has not been confirmed.',
  'Reviews sit on the legacy v4 surface that was otherwise sunset in 2022. It is alive and not on the deprecation schedule, but it is un-replatformed and could move.',
];

/* ── Configuration ────────────────────────────────────────────────────────── */

export interface GbpConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** accounts/{a}/locations/{l} */
  parent: string;
}

/**
 * Resolve what to fetch and with what.
 *
 * The listing comes from the CONNECTION first and the legacy pasted setting
 * second. That order matters: once someone has picked a listing from the
 * discovery list, a stale hand-pasted value must never quietly win and send the
 * pull at a different restaurant.
 */
export function gbpConfig(dbIn?: Database.Database, locationKey = ''): GbpConfig {
  const db = dbIn || getDb();
  const creds = gbpCredentials(db);
  const conn = getConnection(db, locationKey);
  const parent = (conn.location_name || reviewSetting(db, GBP_KEYS.parent, process.env.GBP_LOCATION || '')).trim();
  return {
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    refreshToken: creds.refreshToken,
    parent,
  };
}

/** accounts/123/locations/456 — checked here so a typo fails at configuration
 *  time with a sentence, not at 3am inside a scheduled pull with a 404. */
export function isValidParent(parent: string): boolean {
  return /^accounts\/[A-Za-z0-9_-]+\/locations\/[A-Za-z0-9_-]+$/.test(parent);
}

export function gbpStatus(db?: Database.Database, locationKey = ''): SourceStatus {
  const database = db || getDb();
  const c = gbpConfig(database, locationKey);
  const conn = getConnection(database, locationKey);

  if (!hasOauthApp(database)) {
    return {
      ready: false,
      reason: 'The Google OAuth client is not set up yet. An admin adds the client ID and ' +
              'secret from Google Cloud Console, then presses Connect. Until then, import a ' +
              'Takeout export — it needs no approval and produces the same rows.',
      prerequisites: PREREQUISITES,
      unproven: UNPROVEN,
    };
  }
  if (conn.status === 'needs_reconnect') {
    return {
      ready: false,
      reason: 'Google has stopped accepting this connection — reconnect the account that ' +
              `manages the listing. ${conn.last_error || ''}`.trim(),
      prerequisites: PREREQUISITES,
      unproven: UNPROVEN,
    };
  }
  if (!c.refreshToken) {
    return {
      ready: false,
      reason: 'No Google account is connected yet. Press Connect Google Business Profile and ' +
              'sign in as the account that MANAGES the listing. Pasting a Google Maps link ' +
              'cannot work — Google only releases review history to an account that owns the ' +
              'listing, and the public Places API returns at most 5 reviews with no history.',
      prerequisites: PREREQUISITES,
      unproven: UNPROVEN,
    };
  }
  if (!c.parent) {
    return {
      ready: false,
      reason: 'Connected to Google, but no listing has been chosen yet. Pick the listing to ' +
              'track from the locations on this account.',
      prerequisites: [],
      unproven: UNPROVEN,
    };
  }
  if (!isValidParent(c.parent)) {
    return {
      ready: false,
      reason: `The listing must look like accounts/{accountId}/locations/{locationId}; got ${JSON.stringify(c.parent.slice(0, 60))}.`,
      prerequisites: [],
      unproven: UNPROVEN,
    };
  }
  return {
    ready: true,
    reason: conn.last_success_at
      ? `Connected${conn.google_email ? ` as ${conn.google_email}` : ''}; last successful fetch ${conn.last_success_at}.`
      : 'Connected, but no fetch has succeeded yet — run one pull and check the row count ' +
        'against the total shown on the listing before trusting anything automatic.',
    prerequisites: [],
    unproven: UNPROVEN,
  };
}

/* ── Access tokens: cached, and refreshed before they expire ──────────────── */

/**
 * Return a usable access token, refreshing only when the cached one has expired.
 *
 * The cache is the difference between one token exchange every six hours and
 * one on every page of every pull. It lives in `settings`
 * (reviews_gbp_access_token, masked by shape) with its expiry as metadata on
 * gr_connection, so it survives a process restart — an in-memory cache would be
 * thrown away by every deploy and every cold start.
 *
 * A ReconnectRequiredError from Google is recorded as needs_reconnect BEFORE it
 * propagates. That write is the whole point: this is the exact failure that
 * would otherwise stop the feature silently, and the page reads that flag to
 * shout about it.
 *
 * UNPROVEN against a live credential.
 */
export async function gbpAccessToken(
  cfg: GbpConfig,
  opts: { db?: Database.Database; locationKey?: string; signal?: AbortSignal; now?: number; force?: boolean } = {},
): Promise<string> {
  const db = ensureReviewSchema(opts.db || getDb());
  const locationKey = opts.locationKey || '';
  const now = opts.now ?? Date.now();

  if (!opts.force) {
    const cached = reviewSetting(db, GBP_KEYS.accessToken, '').trim();
    const conn = getConnection(db, locationKey);
    const expMs = conn.token_expires_at ? Date.parse(conn.token_expires_at) : NaN;
    if (cached && Number.isFinite(expMs) && expMs > now) return cached;
  }

  if (!cfg.refreshToken) {
    throw new SourceNotConfiguredError(
      'No Google account is connected. Press Connect Google Business Profile and authorise ' +
      'as the account that manages the listing.',
      PREREQUISITES,
    );
  }

  try {
    const tokens = await refreshAccessToken({
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      refreshToken: cfg.refreshToken,
      now,
      signal: opts.signal,
    });
    setReviewSetting(db, GBP_KEYS.accessToken, tokens.accessToken);
    saveConnection(db, locationKey, { token_expires_at: nowIso(tokens.expiresAtMs) });
    return tokens.accessToken;
  } catch (e: any) {
    if (e instanceof ReconnectRequiredError) {
      // Record BEFORE rethrowing. If this write is skipped the connection looks
      // healthy while being permanently dead — the failure mode this whole
      // module is shaped to prevent.
      recordFailure(db, locationKey, { message: e.message, needsReconnect: true, at: now });
      // The cached access token is worthless once the refresh token is refused.
      setReviewSetting(db, GBP_KEYS.accessToken, '');
    }
    throw e;
  }
}

/* ── Discovery: which accounts, which listings ────────────────────────────── */

export interface GbpAccount {
  /** accounts/{id} */
  name: string;
  label: string;
  type: string;
}

export interface GbpLocation {
  /** accounts/{a}/locations/{l} — what a pull actually needs. */
  name: string;
  label: string;
  address: string;
  /** Google's own review count when the response carries one; null otherwise.
   *  Used to reconcile an import against the live listing. */
  storeCode: string;
}

/** Pure. Split out from the fetch so the response shape can be tested against
 *  a recorded body with no network and no credential. */
export function parseAccountsResponse(body: string): { accounts: GbpAccount[]; nextPageToken: string } {
  let json: any = {};
  try { json = JSON.parse(body); } catch { return { accounts: [], nextPageToken: '' }; }
  const list = Array.isArray(json?.accounts) ? json.accounts : [];
  return {
    accounts: list.map((a: any) => ({
      name: String(a?.name || ''),
      label: String(a?.accountName || a?.name || ''),
      type: String(a?.type || a?.accountType || ''),
    })).filter((a: GbpAccount) => a.name),
    nextPageToken: String(json?.nextPageToken || ''),
  };
}

/**
 * Pure. Note the name join: Business Information v1 returns `locations/{l}`
 * WITHOUT the account prefix, while the v4 reviews endpoint needs
 * `accounts/{a}/locations/{l}`. Getting this wrong produces a 404 at fetch time
 * that looks like a permissions problem, so the join happens once, here, and is
 * tested.
 */
export function parseLocationsResponse(body: string, accountName: string):
  { locations: GbpLocation[]; nextPageToken: string } {
  let json: any = {};
  try { json = JSON.parse(body); } catch { return { locations: [], nextPageToken: '' }; }
  const list = Array.isArray(json?.locations) ? json.locations : [];
  return {
    locations: list.map((l: any) => {
      const bare = String(l?.name || '');
      const full = bare.startsWith('accounts/')
        ? bare
        : (bare && accountName ? `${accountName}/${bare}` : bare);
      const addr = l?.storefrontAddress || {};
      const lines: string[] = Array.isArray(addr?.addressLines) ? addr.addressLines : [];
      const address = [...lines, addr?.locality, addr?.administrativeArea, addr?.postalCode]
        .filter(Boolean).join(', ');
      return {
        name: full,
        label: String(l?.title || l?.locationName || full),
        address,
        storeCode: String(l?.storeCode || ''),
      };
    }).filter((l: GbpLocation) => l.name),
    nextPageToken: String(json?.nextPageToken || ''),
  };
}

async function googleGet(url: string, token: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal });
  const body = await res.text();
  if (!res.ok) {
    let detail = body.slice(0, 400);
    try { detail = JSON.parse(body)?.error?.message || detail; } catch { /* keep the text */ }
    if (res.status === 401 || res.status === 403) {
      throw new SourceNotConfiguredError(
        `Google refused the request (HTTP ${res.status}): ${detail}. A 403 with zero quota ` +
        'means the Business Profile API application has not been approved yet — that is ' +
        'paperwork, not a bug, and a Takeout import works in the meantime.',
        PREREQUISITES,
      );
    }
    throw new Error(scrubCredentials(`Google request failed (HTTP ${res.status}): ${detail}`, [token]));
  }
  return body;
}

/** UNPROVEN. Lists the Business Profile accounts this token can see. */
export async function gbpListAccounts(token: string, signal?: AbortSignal): Promise<GbpAccount[]> {
  const out: GbpAccount[] = [];
  let pageToken = '';
  for (let page = 0; page < 10; page++) {
    const u = new URL(`${ACCOUNTS_HOST}/accounts`);
    u.searchParams.set('pageSize', '20');
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const parsed = parseAccountsResponse(await googleGet(u.toString(), token, signal));
    out.push(...parsed.accounts);
    if (!parsed.nextPageToken) break;
    pageToken = parsed.nextPageToken;
  }
  return out;
}

/**
 * UNPROVEN. Lists the listings under one account.
 *
 * readMask is REQUIRED by Business Information v1 — omitting it is an error,
 * not a default — so the fields the picker shows are named explicitly.
 */
export async function gbpListLocations(
  token: string, accountName: string, signal?: AbortSignal,
): Promise<GbpLocation[]> {
  const out: GbpLocation[] = [];
  let pageToken = '';
  for (let page = 0; page < 10; page++) {
    const u = new URL(`${INFO_HOST}/${accountName}/locations`);
    u.searchParams.set('readMask', 'name,title,storeCode,storefrontAddress');
    u.searchParams.set('pageSize', String(GBP_LOCATIONS_PAGE_SIZE));
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const parsed = parseLocationsResponse(await googleGet(u.toString(), token, signal), accountName);
    out.push(...parsed.locations);
    if (!parsed.nextPageToken) break;
    pageToken = parsed.nextPageToken;
  }
  return out;
}

/** Everything the picker needs, in one call: every account and its listings. */
export async function gbpDiscover(
  dbIn?: Database.Database, opts: { locationKey?: string; signal?: AbortSignal } = {},
): Promise<Array<GbpAccount & { locations: GbpLocation[] }>> {
  const db = ensureReviewSchema(dbIn || getDb());
  const cfg = gbpConfig(db, opts.locationKey || '');
  const token = await gbpAccessToken(cfg, { db, locationKey: opts.locationKey, signal: opts.signal });
  const accounts = await gbpListAccounts(token, opts.signal);
  const out: Array<GbpAccount & { locations: GbpLocation[] }> = [];
  for (const a of accounts) {
    // One bad account must not hide the others — a group can hold an account
    // the token cannot read, and the owner still needs to pick from the rest.
    let locations: GbpLocation[] = [];
    try { locations = await gbpListLocations(token, a.name, opts.signal); } catch { locations = []; }
    out.push({ ...a, locations });
  }
  return out;
}

/* ── The pull ─────────────────────────────────────────────────────────────── */

/**
 * Walk accounts/{a}/locations/{l}/reviews, 50 at a time, and hand back each
 * page's RAW body as its own document.
 *
 * Raw pages, not parsed objects, deliberately: the ingest archives each page
 * before parsing it, so the same replay that repairs a Takeout mis-parse also
 * repairs an API mis-parse — without a second call against a quota the owner
 * waited weeks for.
 *
 * UNPROVEN. Not exercised against Google.
 */
export async function gbpCollect(
  cfg: GbpConfig,
  opts: CollectOptions & { db?: Database.Database; locationKey?: string } = {},
): Promise<RawDocument[]> {
  const maxPages = Math.min(GBP_MAX_PAGES, Math.max(1, opts.maxPages || GBP_MAX_PAGES));
  const db = opts.db;
  let token = await gbpAccessToken(cfg, { db, locationKey: opts.locationKey, signal: opts.signal });
  const docs: RawDocument[] = [];
  const seenPageTokens = new Set<string>();
  let pageToken = '';
  let retriedAuth = false;

  for (let page = 1; page <= maxPages; page++) {
    const url = new URL(`${REVIEWS_HOST}/${cfg.parent}/reviews`);
    url.searchParams.set('pageSize', String(GBP_PAGE_SIZE));
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      signal: opts.signal,
    });
    const body = await res.text();

    if (!res.ok) {
      // A 401 mid-pull is an access token that expired between pages despite
      // the skew — a long pull, a slow network, a clock that drifted. Force one
      // refresh and retry the SAME page once. Without this a nine-page pull can
      // fail on page seven for a reason that fixes itself.
      if (res.status === 401 && !retriedAuth) {
        retriedAuth = true;
        token = await gbpAccessToken(cfg, {
          db, locationKey: opts.locationKey, signal: opts.signal, force: true,
        });
        page--;
        continue;
      }
      let detail = body.slice(0, 400);
      try { detail = JSON.parse(body)?.error?.message || detail; } catch { /* keep the text */ }
      if (res.status === 401 || res.status === 403) {
        throw new SourceNotConfiguredError(
          `Google refused the reviews request (HTTP ${res.status}): ${detail}. ` +
          'A 403 with zero quota means the Business Profile API application has not been ' +
          'approved yet — that is paperwork, not a bug, and a Takeout import works in the ' +
          'meantime.',
          PREREQUISITES,
        );
      }
      throw new Error(scrubCredentials(
        `Google reviews request failed (HTTP ${res.status}): ${detail}`,
        [token, cfg.clientSecret, cfg.refreshToken],
      ));
    }

    docs.push({ kind: 'json', payload: body, label: `${cfg.parent} page ${page}` });

    let next = '';
    try { next = String(JSON.parse(body)?.nextPageToken || ''); } catch { next = ''; }
    if (!next) break;
    // A server that returns the same pageToken forever would otherwise spin
    // until maxPages, re-fetching one page 200 times against the quota.
    if (seenPageTokens.has(next)) break;
    seenPageTokens.add(next);
    pageToken = next;
  }

  return docs;
}

export function gbpSource(db?: Database.Database, locationKey = ''): ReviewSource {
  return {
    key: 'gbp_api',
    label: 'Google Business Profile (automatic)',
    kind: 'api',
    status: () => gbpStatus(db, locationKey),
    async collect(opts: CollectOptions): Promise<RawDocument[]> {
      const st = gbpStatus(db, locationKey);
      if (!st.ready) throw new SourceNotConfiguredError(st.reason, st.prerequisites);
      return gbpCollect(gbpConfig(db, locationKey), { ...opts, db, locationKey });
    },
  };
}

/**
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 * ───────────────────────────────────────────────────────────────────────────
 *  • No replies. Posting an owner reply is a WRITE against a public listing
 *    under the business's name. Read-only analysis does not get to decide that;
 *    it is a separate scope and a separate decision.
 *
 *  • No delete, flag or moderate. Google exposes none of it, and pretending
 *    otherwise on a page would be worse than the absence.
 *
 *  • No scraping fallback, and no paid aggregator. The Maps Platform terms
 *    carry a No Scraping clause that names user reviews specifically; a vendor
 *    marketing "ToS-safe" scraped reviews is describing its own legal position,
 *    not the restaurant's, and the asset at risk is the listing itself. If this
 *    connector cannot run, the answer is the Takeout import.
 *
 *  • No Places API. Hard cap of 5 reviews, ordered by relevance rather than
 *    recency, no pagination, no paid tier that lifts it. It cannot produce a
 *    daily count, a trend, or an unanswered queue — it is not a smaller version
 *    of this, it is a different thing. This is why the connect screen must ask
 *    for an account and never for a Maps URL.
 *
 *  • No guest-360 join. Google exposes a display name and nothing else — no
 *    phone, no email — and the CRM keys on the last 10 digits of a phone
 *    (src/lib/ct/guest-unify.ts). Display-name matching would manufacture false
 *    joins into a named guest's history.
 */
