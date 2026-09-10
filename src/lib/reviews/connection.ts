/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * GOOGLE REVIEWS — the connection, and its health.
 *
 * ── THE FAILURE THIS FILE EXISTS TO PREVENT ─────────────────────────────────
 * A token expires. The scheduled fetch starts failing. Nobody is told. The page
 * keeps rendering the reviews it already has, which look exactly like the
 * reviews of a venue nobody has complained about lately. Weeks later someone
 * notices the last import was in August.
 *
 * That is the worst outcome available to this feature — worse than never
 * building it — because it does not look broken. Every field on gr_connection
 * and every branch of connectionHealth() below exists to make that state
 * impossible to hold quietly.
 *
 * The rule the whole file turns on: CONNECTED IS NOT A FACT ABOUT A STORED
 * TOKEN. It is a fact about the last time bytes actually came back from Google.
 * So `last_success_at` outranks `status` everywhere, and a connection with
 * perfect credentials that has not fetched anything in a week reports itself as
 * stale, not as connected.
 *
 * ── WHERE THE SECRETS ARE, AND WHY NOT HERE ─────────────────────────────────
 * The client secret, refresh token and access token live in the shared
 * `settings` table. Their key names match SECRET_KEY_RE (src/lib/secret-keys.ts)
 * by shape — `..._secret`, `..._token` — so /api/settings and the admin SQL
 * console mask and admin-gate them automatically, with nothing added to any
 * list. Duplicating them into this module's own table would mean a second place
 * to get masking wrong, for no gain. What lives here is metadata ABOUT them,
 * all of which the page must be able to render without touching a credential.
 *
 * The client ID is deliberately NOT treated as a secret: in OAuth it is public,
 * and leaving it readable lets a settings screen show what is wired.
 */
import type Database from 'better-sqlite3';
import crypto from 'crypto';
import { getDb } from '@/lib/db';
import { ensureReviewSchema, reviewSetting, setReviewSetting } from './schema';
import { GBP_SCOPE, STATE_TTL_MS } from './oauth';

type DB = Database.Database;

const nowIso = (ms = Date.now()) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/* ── Settings keys (credentials only) ─────────────────────────────────────── */

export const GBP_KEYS = {
  /** Public in OAuth. Left readable on purpose. */
  clientId: 'reviews_gbp_client_id',
  /** matches SECRET_KEY_RE ("secret") -> masked + admin-only by shape */
  clientSecret: 'reviews_gbp_client_secret',
  /** matches SECRET_KEY_RE ("token") -> masked + admin-only by shape */
  refreshToken: 'reviews_gbp_refresh_token',
  /** matches SECRET_KEY_RE ("token"). Cached ~1h access token; its EXPIRY is
   *  metadata and lives on gr_connection, but the token itself is a credential. */
  accessToken: 'reviews_gbp_access_token',
  /** matches SECRET_KEY_RE ("secret"). Generated on first use; signs the OAuth
   *  state parameter. Never leaves the server. */
  stateSecret: 'reviews_gbp_state_secret',
  /** Optional override when the app is behind a proxy whose public origin the
   *  request headers do not reveal. Must match Google Cloud Console exactly. */
  redirectUri: 'reviews_gbp_redirect_uri',
  /** LEGACY, and kept under its original name because other files already read
   *  it. The pre-OAuth build had the owner paste accounts/{a}/locations/{l}
   *  here by hand. Still READ, so an install configured that way keeps
   *  fetching; never WRITTEN by the connect flow, which stores the chosen
   *  listing on gr_connection where it can carry a human-readable label. */
  parent: 'reviews_gbp_location',
} as const;

/* ── Credentials ──────────────────────────────────────────────────────────── */

export interface GbpCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken: string;
}

export function gbpCredentials(dbIn?: DB): GbpCredentials {
  const db = dbIn || getDb();
  return {
    clientId: reviewSetting(db, GBP_KEYS.clientId, process.env.GBP_CLIENT_ID || '').trim(),
    clientSecret: reviewSetting(db, GBP_KEYS.clientSecret, process.env.GBP_CLIENT_SECRET || '').trim(),
    refreshToken: reviewSetting(db, GBP_KEYS.refreshToken, process.env.GBP_REFRESH_TOKEN || '').trim(),
    accessToken: reviewSetting(db, GBP_KEYS.accessToken, '').trim(),
  };
}

/** The OAuth app itself — what an admin registers once in Google Cloud Console.
 *  Separate from "is a listing connected": the app can be configured while no
 *  account has authorised yet, and the page needs to tell those apart. */
export function hasOauthApp(dbIn?: DB): boolean {
  const c = gbpCredentials(dbIn);
  return !!(c.clientId && c.clientSecret);
}

/** Get-or-create the HMAC secret for the state parameter. Generated on first
 *  use so nothing has to be configured for CSRF protection to be on. */
export function stateSecret(dbIn?: DB): string {
  const db = ensureReviewSchema(dbIn || getDb());
  const existing = reviewSetting(db, GBP_KEYS.stateSecret, '').trim();
  if (existing) return existing;
  const fresh = crypto.randomBytes(32).toString('hex');
  setReviewSetting(db, GBP_KEYS.stateSecret, fresh);
  return fresh;
}

/* ── The record ───────────────────────────────────────────────────────────── */

export type ConnectionStatus = 'disconnected' | 'connected' | 'needs_reconnect';

export interface ConnectionRecord {
  location_key: string;
  status: ConnectionStatus;
  google_email: string;
  account_name: string;
  account_label: string;
  location_name: string;
  location_label: string;
  location_address: string;
  scope: string;
  connected_at: string;
  connected_by: string;
  token_expires_at: string;
  last_attempt_at: string;
  last_success_at: string;
  last_error: string;
  last_error_at: string;
  consecutive_failures: number;
  auto_enabled: number;
  interval_minutes: number;
  last_auto_run_at: string;
  lock_until: string;
  updated_at: string;
}

const EMPTY = (locationKey: string): ConnectionRecord => ({
  location_key: locationKey,
  status: 'disconnected',
  google_email: '', account_name: '', account_label: '',
  location_name: '', location_label: '', location_address: '',
  scope: '', connected_at: '', connected_by: '', token_expires_at: '',
  last_attempt_at: '', last_success_at: '', last_error: '', last_error_at: '',
  consecutive_failures: 0, auto_enabled: 0, interval_minutes: DEFAULT_INTERVAL_MIN,
  last_auto_run_at: '', lock_until: '', updated_at: '',
});

/**
 * Six hours. Reviews are not a real-time signal — a guest writes one hours
 * after leaving — and every pull spends quota the owner waited weeks to be
 * granted. Four pulls a day puts a new review on the page the same session it
 * appears, which is what he actually asked for, without hammering an endpoint
 * whose v4 quota Google does not publish.
 */
export const DEFAULT_INTERVAL_MIN = 360;
export const MIN_INTERVAL_MIN = 15;
export const MAX_INTERVAL_MIN = 7 * 24 * 60;

export function getConnection(dbIn: DB | null, locationKey = ''): ConnectionRecord {
  const db = ensureReviewSchema(dbIn || getDb());
  const row = db.prepare('SELECT * FROM gr_connection WHERE location_key = ?').get(locationKey) as any;
  if (!row) {
    // A legacy install had the parent pasted into settings and never had a
    // gr_connection row. Present it as what it is — a working, hand-configured
    // connection — rather than as "never connected", which would invite the
    // owner to reconnect something that is already fetching.
    const legacy = reviewSetting(db, GBP_KEYS.parent, process.env.GBP_LOCATION || '').trim();
    const rec = EMPTY(locationKey);
    if (legacy && reviewSetting(db, GBP_KEYS.refreshToken, process.env.GBP_REFRESH_TOKEN || '').trim()) {
      rec.status = 'connected';
      rec.location_name = legacy;
      rec.location_label = legacy;
      rec.connected_by = 'configured by hand (pre-OAuth)';
      rec.scope = GBP_SCOPE;
    }
    return rec;
  }
  return {
    ...row,
    consecutive_failures: Number(row.consecutive_failures || 0),
    auto_enabled: Number(row.auto_enabled || 0),
    interval_minutes: Number(row.interval_minutes || DEFAULT_INTERVAL_MIN),
  } as ConnectionRecord;
}

const UPSERT_COLS = [
  'status', 'google_email', 'account_name', 'account_label', 'location_name',
  'location_label', 'location_address', 'scope', 'connected_at', 'connected_by',
  'token_expires_at', 'last_attempt_at', 'last_success_at', 'last_error',
  'last_error_at', 'consecutive_failures', 'auto_enabled', 'interval_minutes',
  'last_auto_run_at', 'lock_until',
] as const;

/** Partial update of the connection row, creating it if absent. */
export function saveConnection(
  dbIn: DB | null, locationKey: string, patch: Partial<ConnectionRecord>,
): ConnectionRecord {
  const db = ensureReviewSchema(dbIn || getDb());
  const current = getConnection(db, locationKey);
  const next: ConnectionRecord = { ...current, ...patch, location_key: locationKey, updated_at: nowIso() };

  const cols = ['location_key', ...UPSERT_COLS, 'updated_at'];
  db.prepare(
    `INSERT INTO gr_connection (${cols.join(', ')}) VALUES (${cols.map(c => `@${c}`).join(', ')})
     ON CONFLICT(location_key) DO UPDATE SET
       ${[...UPSERT_COLS, 'updated_at'].map(c => `${c} = @${c}`).join(', ')}`,
  ).run(next as any);
  return next;
}

/* ── Recording what happened ──────────────────────────────────────────────── */

/** Called before a pull, so an attempt that never returns still leaves a trace.
 *  A crash mid-pull must not look like "never tried". */
export function recordAttempt(dbIn: DB | null, locationKey = '', at = Date.now()): void {
  saveConnection(dbIn, locationKey, { last_attempt_at: nowIso(at) });
}

/**
 * A pull came back. This is the ONLY thing that makes a connection healthy —
 * not a stored token, not a successful OAuth six weeks ago. Clears the failure
 * streak and the last error, because a success genuinely does mean the previous
 * failure is over.
 */
export function recordSuccess(
  dbIn: DB | null, locationKey = '',
  opts: { at?: number; tokenExpiresAtMs?: number; auto?: boolean } = {},
): void {
  const at = opts.at ?? Date.now();
  const patch: Partial<ConnectionRecord> = {
    status: 'connected',
    last_success_at: nowIso(at),
    last_attempt_at: nowIso(at),
    last_error: '',
    last_error_at: '',
    consecutive_failures: 0,
  };
  if (opts.tokenExpiresAtMs) patch.token_expires_at = nowIso(opts.tokenExpiresAtMs);
  if (opts.auto) patch.last_auto_run_at = nowIso(at);
  saveConnection(dbIn, locationKey, patch);
}

/**
 * A pull failed. `needsReconnect` marks the terminal kind — Google refused the
 * refresh token itself — which no retry can fix and which must therefore be
 * distinguishable on the page from "the network was down for a minute".
 *
 * The failure STREAK is kept rather than a boolean because one failed pull is
 * noise and five in a row is an outage, and the page should be able to say
 * which it is looking at.
 */
export function recordFailure(
  dbIn: DB | null, locationKey = '',
  opts: { message: string; needsReconnect?: boolean; at?: number; auto?: boolean } = { message: '' },
): void {
  const at = opts.at ?? Date.now();
  const current = getConnection(dbIn, locationKey);
  const patch: Partial<ConnectionRecord> = {
    last_attempt_at: nowIso(at),
    last_error: String(opts.message || 'Unknown error').slice(0, 600),
    last_error_at: nowIso(at),
    consecutive_failures: Number(current.consecutive_failures || 0) + 1,
  };
  if (opts.needsReconnect) patch.status = 'needs_reconnect';
  if (opts.auto) patch.last_auto_run_at = nowIso(at);
  saveConnection(dbIn, locationKey, patch);
}

/* ── The driver heartbeat ─────────────────────────────────────────────────── */

/**
 * The settings key that answers "is anything actually calling the scheduler
 * entry point?".
 *
 * ── WHY A HEARTBEAT AND NOT A FLAG ──────────────────────────────────────────
 * `auto_enabled` records that somebody switched the schedule ON. It says
 * nothing about whether a scheduler exists to honour it, and for this module
 * nothing did: src/lib/scheduler.ts has no reviews hook (it is owned by other
 * work in flight), and the external-cron path is blocked by src/proxy.ts, which
 * 401s any /api/crm-calls request without a session BEFORE the route's
 * x-cron-token check can run. So the page showed a green "Arriving
 * automatically" badge and a concrete promise — "NEXT FETCH: in about 5 hours"
 * — that no code path on the machine could keep.
 *
 * This is the same lesson as the print-agent watchdog: "the bridge is
 * connected" is not "the dispatcher is running". A configuration flag is a
 * statement of intent; only a heartbeat is evidence. runReviewAutoRefresh()
 * stamps this key on EVERY call, including the calls that decide nothing is due
 * — that is the point, because it proves the driver is alive independently of
 * whether it had work.
 *
 * Nothing writes it until a driver exists, so the page tells the truth from the
 * first render, with no migration and no new column.
 */
export const AUTO_DRIVER_TICK_KEY = 'reviews_auto_driver_tick';

/** Stamp the heartbeat. Called by runReviewAutoRefresh on every tick. */
export function recordAutoDriverTick(dbIn: DB | null, at = Date.now()): void {
  const db = ensureReviewSchema(dbIn || getDb());
  setReviewSetting(db, AUTO_DRIVER_TICK_KEY, nowIso(at));
}

/** When a scheduler last called the auto-refresh entry point. '' = never. */
export function autoDriverTickAt(dbIn: DB | null): string {
  const db = ensureReviewSchema(dbIn || getDb());
  return reviewSetting(db, AUTO_DRIVER_TICK_KEY, '');
}

/**
 * How long the driver may be silent before we stop believing in it: two whole
 * intervals, floored at 30 minutes so a 5-minute schedule does not report a
 * dead driver over one slow tick, and capped at 6 hours so a leisurely schedule
 * cannot hide a driver that died this morning.
 */
export function driverStaleAfterMs(rec: Pick<ConnectionRecord, 'interval_minutes'>): number {
  const interval = Math.max(MIN_INTERVAL_MIN, Number(rec.interval_minutes) || DEFAULT_INTERVAL_MIN);
  return Math.min(6 * 60, Math.max(30, interval * 2)) * 60_000;
}

/* ── Health: the pure part ────────────────────────────────────────────────── */

export type HealthState =
  /** No OAuth app configured yet — an admin has not registered the Google
   *  client. Nothing can be connected until that exists. */
  | 'no_app'
  /** App configured, but nobody has authorised a Google account. */
  | 'not_connected'
  /** Google refused the credential. Terminal until a human reconnects. LOUD. */
  | 'needs_reconnect'
  /** Authorised, but no listing chosen — we do not know what to fetch. */
  | 'no_location'
  /** Connected and configured, but the scheduled refresh is switched off, so
   *  nothing arrives on its own. Not broken — but not automatic either, and
   *  the owner asked for automatic. */
  | 'paused'
  /** The schedule is armed, but NOTHING IS DRIVING IT. No scheduler tick has
   *  reached runReviewAutoRefresh() within two intervals, so the interval, the
   *  "next fetch" time and the automatic badge would all be promises about work
   *  that is not going to happen. Distinct from 'stale' on purpose: stale says
   *  "nothing has arrived lately", this says "and here is exactly why". */
  | 'no_driver'
  /** Fetches are failing right now. */
  | 'failing'
  /** Nothing has failed, but nothing has succeeded recently either. */
  | 'stale'
  | 'healthy';

export type HealthSeverity = 'ok' | 'info' | 'warn' | 'error';

export interface ConnectionHealth {
  state: HealthState;
  severity: HealthSeverity;
  /** One sentence, written for the owner. Rendered as-is. */
  headline: string;
  /** What to do about it, or '' when there is nothing to do. */
  action: string;
  connected: boolean;
  /** Is new data arriving without anyone doing anything? The single question
   *  the owner actually cares about. */
  automatic: boolean;
  last_success_at: string;
  hours_since_success: number | null;
  consecutive_failures: number;
  last_error: string;
  google_email: string;
  location_label: string;
  location_name: string;
  /** When the next scheduled pull is due; '' when nothing is scheduled OR when
   *  no driver has been seen — an unkeepable promise is worse than no promise. */
  next_due_at: string;
  /** Threshold used to decide staleness, so the page can explain the verdict. */
  stale_after_hours: number;
  /** Has a scheduler actually called the auto-refresh entry point recently?
   *  Evidence, not configuration — see AUTO_DRIVER_TICK_KEY. */
  driver_alive: boolean;
  /** When it last did. '' means never, which is the state a module with no
   *  scheduler hook and a proxy-blocked cron endpoint sits in. */
  driver_last_tick_at: string;
}

/**
 * How long silence is allowed before it counts as stale.
 *
 * For an AUTOMATIC connection: three missed cycles, floored at 6 hours and
 * capped at 48. Three because one missed cycle is a restart and two is bad
 * luck; capped at 48 because a connector that has said nothing for two days is
 * news regardless of how leisurely its interval is.
 *
 * For a connection whose schedule is OFF, staleness is measured against a week
 * — the same threshold the manual Takeout route uses, because that is what it
 * has effectively become.
 */
export function staleAfterHours(rec: Pick<ConnectionRecord, 'auto_enabled' | 'interval_minutes'>): number {
  if (!rec.auto_enabled) return 168;
  const cycles = (Number(rec.interval_minutes) || DEFAULT_INTERVAL_MIN) * 3 / 60;
  return Math.min(48, Math.max(6, Math.round(cycles)));
}

/**
 * Turn a connection record into something a screen can render, with no
 * database, no clock of its own and no network. Pure, so every branch —
 * including the ones that only happen when something is broken — is testable.
 *
 * ORDER MATTERS and is deliberate: the states are evaluated worst-cause-first,
 * so a connection that is both failing AND stale reports the failure (which has
 * a cause and a cure) rather than the staleness (which is only a symptom).
 */
export function connectionHealth(
  rec: ConnectionRecord,
  opts: { now?: number; hasApp?: boolean; driverTickAt?: string } = {},
): ConnectionHealth {
  const now = opts.now ?? Date.now();
  const hasApp = opts.hasApp !== false;
  const lastSuccessMs = rec.last_success_at ? Date.parse(rec.last_success_at) : NaN;
  const hoursSince = Number.isFinite(lastSuccessMs)
    ? Math.round(((now - lastSuccessMs) / 3_600_000) * 10) / 10
    : null;
  const threshold = staleAfterHours(rec);

  // ── IS ANYTHING DRIVING THE SCHEDULE? ────────────────────────────────────
  // Evidence only. A caller that does not pass driverTickAt is treated as
  // having no evidence, i.e. no driver — the safe direction, because the
  // failure this whole file guards against is claiming automation that is not
  // happening.
  const driverTick = String(opts.driverTickAt || '');
  const driverMs = driverTick ? Date.parse(driverTick) : NaN;
  const driverAlive = Number.isFinite(driverMs) && (now - driverMs) <= driverStaleAfterMs(rec);

  // The next fetch is only a fact if something is going to perform it.
  const nextDue = (driverAlive && rec.auto_enabled && rec.last_success_at && Number.isFinite(lastSuccessMs))
    ? nowIso(lastSuccessMs + (Number(rec.interval_minutes) || DEFAULT_INTERVAL_MIN) * 60_000)
    : '';

  const base = {
    connected: rec.status === 'connected',
    automatic: false,
    last_success_at: rec.last_success_at,
    hours_since_success: hoursSince,
    consecutive_failures: Number(rec.consecutive_failures || 0),
    last_error: rec.last_error,
    google_email: rec.google_email,
    location_label: rec.location_label || rec.location_name,
    location_name: rec.location_name,
    next_due_at: nextDue,
    stale_after_hours: threshold,
    driver_alive: driverAlive,
    driver_last_tick_at: driverTick,
  };

  if (!hasApp) {
    return {
      ...base, state: 'no_app', severity: 'info', connected: false,
      headline: 'Google is not set up yet, so reviews are not arriving automatically.',
      action: 'An admin needs to register a Google Cloud OAuth client and paste its ID and ' +
              'secret in settings. Until then, import a Google Takeout export — it needs no ' +
              'approval and produces the same rows.',
    };
  }

  if (rec.status === 'needs_reconnect') {
    return {
      ...base, state: 'needs_reconnect', severity: 'error', connected: false,
      headline: 'Google has stopped accepting this connection — no new reviews are arriving.',
      action: 'Press Connect Google Business Profile and authorise again as the account that ' +
              'manages the listing. Reviews already imported are safe. ' +
              (rec.last_error ? `Google said: ${rec.last_error}` : ''),
    };
  }

  if (rec.status !== 'connected') {
    return {
      ...base, state: 'not_connected', severity: 'info', connected: false,
      headline: 'No Google account is connected, so reviews are not arriving automatically.',
      action: 'Press Connect Google Business Profile and sign in as the account that MANAGES ' +
              'the listing. Pasting a Google Maps link cannot work — Google only releases ' +
              'review history to an account that owns the listing.',
    };
  }

  if (!rec.location_name) {
    return {
      ...base, state: 'no_location', severity: 'warn',
      headline: 'Connected to Google, but no listing has been chosen yet.',
      action: 'Pick the listing to track from the list of locations on this account.',
    };
  }

  if (base.consecutive_failures > 0) {
    const n = base.consecutive_failures;
    return {
      ...base, state: 'failing', severity: n >= 3 ? 'error' : 'warn',
      headline: n === 1
        ? 'The last attempt to fetch reviews failed.'
        : `The last ${n} attempts to fetch reviews failed — new reviews are not arriving.`,
      action: (rec.last_error ? `Google said: ${rec.last_error}. ` : '') +
              'Press Refresh now to retry. If it keeps failing, reconnect the Google account.',
    };
  }

  if (!rec.auto_enabled) {
    return {
      ...base, state: 'paused', severity: 'warn',
      headline: 'Connected, but the scheduled refresh is switched off — reviews only arrive ' +
                'when someone presses Refresh now.',
      action: 'Turn on the scheduled refresh so new reviews arrive on their own.',
    };
  }

  // ── ARMED, BUT NOTHING IS RUNNING IT ──────────────────────────────────────
  // Checked BEFORE staleness, because it is the cause and staleness is only the
  // symptom: a connection with no driver will go stale on its own in a day or
  // two, and reporting "nothing fetched for 40 hours" instead of "nothing is
  // scheduled to fetch" sends a manager to press Refresh forever.
  if (!driverAlive) {
    return {
      ...base, state: 'no_driver', severity: 'warn',
      headline: driverTick
        ? 'The scheduled refresh is switched on, but nothing has run it recently — reviews are NOT ' +
          'arriving on their own.'
        : 'The scheduled refresh is switched on, but NOTHING IS RUNNING IT — no scheduled fetch has ' +
          'ever taken place, so reviews are not arriving on their own.',
      action: 'Press Refresh now for the latest reviews; that always works. To make it automatic, a ' +
              'developer has to drive it: either add the one-line reviews hook to the app scheduler, ' +
              'or expose the refresh endpoint to an external cron (today the app proxy answers a ' +
              'token-only request with "Sign in required" before the endpoint sees it).',
    };
  }

  // `automatic` stays FALSE in both stale branches, and that is the point of
  // the field. It answers "is new data actually arriving?", not "is a schedule
  // switched on?" — the second question is already answered by auto_enabled on
  // the connection record. A connection that is armed but has fetched nothing
  // for two days is precisely the silent failure this module exists to prevent,
  // and letting it keep the automatic badge would hide it behind a green light.
  if (hoursSince == null) {
    return {
      ...base, state: 'stale', severity: 'warn',
      headline: 'Connected and scheduled, but no fetch has succeeded yet.',
      action: 'Press Refresh now to run the first pull and confirm the connection works.',
    };
  }

  if (hoursSince > threshold) {
    return {
      ...base, state: 'stale', severity: 'warn',
      headline: `No reviews have been fetched for ${hoursSince} hours — this page may be behind ` +
                'what guests can see on Google.',
      action: 'Press Refresh now. If that works, the scheduled refresh is not running — check ' +
              'that the cron trigger is configured.',
    };
  }

  return {
    ...base, state: 'healthy', severity: 'ok', automatic: true,
    headline: `Connected${rec.google_email ? ` as ${rec.google_email}` : ''} — reviews are ` +
              `arriving automatically (last checked ${hoursSince}h ago).`,
    action: '',
  };
}

/* ── The scheduling lock ──────────────────────────────────────────────────── */

/**
 * Is a scheduled pull due? Pure.
 *
 * `auto_enabled` is checked first and on purpose: a connection nobody has armed
 * must never generate traffic, however overdue it looks.
 */
export function isRefreshDue(rec: ConnectionRecord, now = Date.now()): boolean {
  if (!rec.auto_enabled) return false;
  if (rec.status !== 'connected') return false;
  if (!rec.location_name) return false;
  const interval = Math.max(MIN_INTERVAL_MIN, Number(rec.interval_minutes) || DEFAULT_INTERVAL_MIN) * 60_000;
  // Measured from the last ATTEMPT, not the last success. Measuring from
  // success would retry a failing connection on every single tick, turning one
  // broken credential into a few hundred token requests a day.
  const marker = rec.last_auto_run_at || rec.last_attempt_at || '';
  if (!marker) return true;
  const ms = Date.parse(marker);
  if (!Number.isFinite(ms)) return true;
  return now - ms >= interval;
}

/** Lease length for the advisory lock. Longer than any sane pull (200 pages),
 *  short enough that a process killed mid-pull unblocks within the hour. */
export const LOCK_MS = 15 * 60 * 1000;

/**
 * Take the advisory lock, or return false if someone else holds it.
 *
 * Two schedulers exist in this app by design — the in-process tick and an
 * external cron POST — and both may fire within the same minute after a
 * restart. Without this they would run the same pull twice against a quota
 * whose v4 limit Google does not publish.
 *
 * The read and the write are one transaction, so two callers racing cannot both
 * observe a free lock.
 */
export function claimRefreshLock(dbIn: DB | null, locationKey = '', now = Date.now()): boolean {
  const db = ensureReviewSchema(dbIn || getDb());
  const take = db.transaction(() => {
    const row = db.prepare('SELECT lock_until FROM gr_connection WHERE location_key = ?')
      .get(locationKey) as { lock_until?: string } | undefined;
    const until = row?.lock_until ? Date.parse(row.lock_until) : NaN;
    if (Number.isFinite(until) && until > now) return false;
    saveConnection(db, locationKey, { lock_until: nowIso(now + LOCK_MS) });
    return true;
  });
  return take();
}

export function releaseRefreshLock(dbIn: DB | null, locationKey = ''): void {
  saveConnection(dbIn, locationKey, { lock_until: '' });
}

/* ── OAuth state rows: single-use ─────────────────────────────────────────── */

export function createOauthState(
  dbIn: DB | null,
  opts: { nonce: string; redirectUri: string; actor: string; locationKey?: string; now?: number },
): void {
  const db = ensureReviewSchema(dbIn || getDb());
  const now = opts.now ?? Date.now();
  // Opportunistic cleanup: expired attempts have no value and this table should
  // never grow. Cheap, indexed, and it keeps a cron job from being necessary.
  db.prepare('DELETE FROM gr_oauth_state WHERE expires_at < ?').run(nowIso(now));
  db.prepare(
    `INSERT OR REPLACE INTO gr_oauth_state
       (nonce, redirect_uri, actor, location_key, created_at, expires_at, used_at)
     VALUES (?, ?, ?, ?, ?, ?, '')`,
  ).run(opts.nonce, opts.redirectUri, opts.actor || '', opts.locationKey || '',
        nowIso(now), nowIso(now + STATE_TTL_MS));
}

export type ConsumeResult =
  | { ok: true; redirectUri: string; actor: string; locationKey: string }
  | { ok: false; reason: 'unknown' | 'used' | 'expired' };

/**
 * Consume a state nonce exactly once.
 *
 * The check and the mark are one transaction, so a redirect replayed twice in
 * parallel — a double-clicked browser, a retried request — cannot both succeed.
 * A used nonce is reported as 'used' rather than 'unknown' because they mean
 * different things: 'used' is almost always a refresh of the callback page, and
 * telling someone their connection failed when it actually succeeded a second
 * ago is its own bug.
 */
export function consumeOauthState(dbIn: DB | null, nonce: string, now = Date.now()): ConsumeResult {
  const db = ensureReviewSchema(dbIn || getDb());
  const run = db.transaction((): ConsumeResult => {
    const row = db.prepare('SELECT * FROM gr_oauth_state WHERE nonce = ?').get(nonce) as any;
    if (!row) return { ok: false, reason: 'unknown' };
    if (row.used_at) return { ok: false, reason: 'used' };
    const exp = Date.parse(row.expires_at);
    if (Number.isFinite(exp) && exp < now) return { ok: false, reason: 'expired' };
    db.prepare('UPDATE gr_oauth_state SET used_at = ? WHERE nonce = ?').run(nowIso(now), nonce);
    return {
      ok: true,
      redirectUri: String(row.redirect_uri || ''),
      actor: String(row.actor || ''),
      locationKey: String(row.location_key || ''),
    };
  });
  return run();
}

/* ── Disconnect ───────────────────────────────────────────────────────────── */

/**
 * Forget the connection.
 *
 * DELIBERATELY DOES NOT TOUCH gr_reviews. Reviews already imported are history
 * the venue owns; disconnecting an integration is not a request to delete a
 * year of guest feedback, and quietly doing so would be unrecoverable. The
 * OAuth app registration (client id and secret) also survives, so reconnecting
 * is one button and not a re-registration.
 */
export function disconnect(dbIn: DB | null, locationKey = ''): void {
  const db = ensureReviewSchema(dbIn || getDb());
  setReviewSetting(db, GBP_KEYS.refreshToken, '');
  setReviewSetting(db, GBP_KEYS.accessToken, '');
  setReviewSetting(db, GBP_KEYS.parent, '');
  saveConnection(db, locationKey, {
    status: 'disconnected',
    google_email: '', account_name: '', account_label: '',
    location_name: '', location_label: '', location_address: '',
    scope: '', connected_at: '', connected_by: '', token_expires_at: '',
    last_error: '', last_error_at: '', consecutive_failures: 0,
    auto_enabled: 0, lock_until: '',
  });
}
