/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * GOOGLE REVIEWS — the automatic refresh.
 *
 * This is the file that makes the feature what the owner actually asked for:
 * "it should automatically retrieve the reviews data... it is very helpful
 * right". Everything else is scaffolding around this one job running on its own
 * and being honest about whether it did.
 *
 * ── TWO ENTRY POINTS, ONE BODY ──────────────────────────────────────────────
 *   runReviewRefresh()      one pull, right now. Behind the "Refresh now"
 *                           button and behind the cron POST. Throws on failure,
 *                           because a human pressed a button and deserves the
 *                           error.
 *   runReviewAutoRefresh()  the SCHEDULED wrapper. Checks whether a pull is
 *                           due, takes the lock, runs, and NEVER THROWS — a
 *                           scheduler tick that dies takes every other job on
 *                           that tick with it.
 *
 * ── NOTHING DRIVES THIS YET. SAY SO OUT LOUD. ───────────────────────────────
 * As of this writing there is NO working automatic driver, and the page is
 * built to admit it rather than imply otherwise:
 *
 *   • src/lib/scheduler.ts has no reviews hook. It is owned by other work in
 *     flight, so this module does not edit it.
 *   • The external-cron path DOES NOT WORK as written. src/proxy.ts protects
 *     the whole /api/crm-calls prefix, so a token-only POST is answered with
 *     401 "Sign in required" by the proxy BEFORE the route's x-cron-token check
 *     runs. (Verified; /api/cron/refresh-parties is blocked identically, so the
 *     parity with it is real but the capability is not.)
 *
 * Until one of those changes, "Refresh now" — an admin session, through the UI
 * — is the only path that pulls from Google, and connectionHealth() reports
 * state 'no_driver' rather than a green automatic badge.
 *
 * TO MAKE IT AUTOMATIC, either:
 *
 *   1. IN-PROCESS — ONE line inside the existing tick in src/lib/scheduler.ts,
 *      in the same best-effort try/catch style as its neighbours:
 *
 *        try { (await import('@/lib/reviews/refresh')).runReviewAutoRefresh(); }
 *        catch (e) { console.error('[scheduler] reviews refresh failed:', e); }
 *
 *      The dynamic import keeps a fault in this module from breaking scheduler
 *      boot, and runReviewAutoRefresh() already swallows its own errors, so the
 *      surrounding catch is belt and braces. It is safe to call on every tick:
 *      it returns 'not_due' in microseconds when nothing is owed, so the
 *      scheduler's 5-minute cadence costs a settings read.
 *
 *   2. EXTERNAL CRON — which additionally needs the refresh endpoint carved out
 *      of the proxy's protected prefixes (isPublic in src/proxy.ts), exactly as
 *      the WhatsApp webhook is, so the route's own x-cron-token check can run.
 *      That is a change to a shared security file and is deliberately NOT made
 *      here.
 *
 * Either one starts the heartbeat (recordAutoDriverTick below), and the page's
 * automatic badge lights up on evidence rather than on configuration.
 *
 * ── WHY THE LOCK EXISTS ─────────────────────────────────────────────────────
 * Both drivers above may be live at once, and after a restart both can fire in
 * the same minute. Without the advisory lock in ./connection.ts they would run
 * the same pull twice against a quota Google does not publish a v4 number for.
 */
import type Database from 'better-sqlite3';
import { getDb } from '@/lib/db';
import { ensureReviewSchema } from './schema';
import { ingestDocuments } from './ingest';
import { gbpCollect, gbpConfig, gbpStatus } from './sources-gbp';
import { ReconnectRequiredError } from './oauth';
import {
  claimRefreshLock, getConnection, isRefreshDue, recordAttempt, recordAutoDriverTick,
  recordFailure, recordSuccess, releaseRefreshLock,
} from './connection';
import { SourceNotConfiguredError } from './types';
import type { IngestResult } from './types';

type DB = Database.Database;

export interface RefreshOptions {
  db?: DB;
  locationKey?: string;
  /** Who or what triggered this, for the run log. */
  actor?: string;
  /** True when a scheduler drove it, false when a person pressed a button.
   *  Only affects bookkeeping, never behaviour. */
  auto?: boolean;
  /** Safety valve passthrough. */
  maxPages?: number;
  signal?: AbortSignal;
  /** The total the owner can read off the live listing, for reconciliation. */
  expectedTotal?: number | null;
  now?: number;
}

export interface RefreshResult {
  ok: true;
  ingest: IngestResult;
  /** How many raw API pages came back. */
  pages: number;
}

/**
 * One pull, now.
 *
 * The order is deliberate: record the ATTEMPT before going anywhere near the
 * network, so a process killed mid-pull leaves evidence rather than looking
 * like it never tried. Then fetch, then ingest, then record the success — and
 * only a completed ingest counts as success, because bytes that arrived and
 * failed to parse are not reviews on the page.
 *
 * UNPROVEN end to end: the Google half has never been exercised against a live
 * credential. The ingest half has a 112-case suite.
 */
export async function runReviewRefresh(opts: RefreshOptions = {}): Promise<RefreshResult> {
  const db = ensureReviewSchema(opts.db || getDb());
  const locationKey = opts.locationKey || '';
  const now = opts.now ?? Date.now();

  const status = gbpStatus(db, locationKey);
  if (!status.ready) throw new SourceNotConfiguredError(status.reason, status.prerequisites);

  const cfg = gbpConfig(db, locationKey);
  recordAttempt(db, locationKey, now);

  try {
    const docs = await gbpCollect(cfg, {
      db, locationKey, maxPages: opts.maxPages, signal: opts.signal,
    });

    const ingest = ingestDocuments(db, docs, {
      source: 'gbp_api',
      locationKey,
      actor: opts.actor || (opts.auto ? 'scheduler' : ''),
      label: `Google pull — ${docs.length} page(s) from ${cfg.parent}`,
      expectedTotal: opts.expectedTotal ?? null,
    });

    recordSuccess(db, locationKey, { at: Date.now(), auto: opts.auto });
    return { ok: true, ingest, pages: docs.length };
  } catch (e: any) {
    // gbpAccessToken already recorded a ReconnectRequiredError with the
    // needs_reconnect flag; recording it again here would double-count the
    // failure streak and make one dead token look like two outages.
    if (!(e instanceof ReconnectRequiredError)) {
      recordFailure(db, locationKey, {
        message: String(e?.message || e).slice(0, 600),
        at: Date.now(),
        auto: opts.auto,
      });
    }
    throw e;
  }
}

export type AutoOutcome =
  | 'not_due'
  | 'not_configured'
  | 'locked'
  | 'refreshed'
  | 'failed';

export interface AutoRefreshResult {
  outcome: AutoOutcome;
  /** Why, in one line, for a scheduler status panel. */
  detail: string;
  inserted?: number;
  updated?: number;
  pages?: number;
}

/**
 * The scheduler entry point. Safe to call on every tick.
 *
 * NEVER THROWS. A scheduler tick runs several unrelated jobs; one of them
 * raising takes the rest of that tick down with it, which is why every job in
 * src/lib/scheduler.ts is individually wrapped. This function keeps that
 * contract on its own side of the boundary too, so a caller cannot forget.
 *
 * The lock is released in a finally, so a crashed pull does not wedge the
 * schedule until the lease expires.
 */
export async function runReviewAutoRefresh(
  opts: { db?: DB; locationKey?: string; now?: number } = {},
): Promise<AutoRefreshResult> {
  try {
    const db = ensureReviewSchema(opts.db || getDb());
    const locationKey = opts.locationKey || '';
    const now = opts.now ?? Date.now();

    // ── THE HEARTBEAT, FIRST AND UNCONDITIONALLY ────────────────────────────
    // Stamped on EVERY call, including the ones that immediately return
    // 'not_due'. That is the whole point: it records that a driver is alive,
    // which is a different fact from whether the driver had anything to do.
    // Without it, "the schedule is on" was the only evidence the page had, and
    // it was evidence of intent rather than of anything happening — the page
    // promised "next fetch in about 5 hours" with no code path able to keep it.
    recordAutoDriverTick(db, now);

    const conn = getConnection(db, locationKey);
    if (!conn.auto_enabled) {
      return { outcome: 'not_due', detail: 'Scheduled refresh is switched off for this listing.' };
    }
    if (conn.status !== 'connected' || !conn.location_name) {
      return {
        outcome: 'not_configured',
        detail: conn.status === 'needs_reconnect'
          ? 'Google refused the connection — it needs to be reconnected by hand.'
          : 'No Google account is connected, or no listing has been chosen.',
      };
    }
    if (!isRefreshDue(conn, now)) {
      return { outcome: 'not_due', detail: `Next pull is not due yet (every ${conn.interval_minutes} min).` };
    }
    if (!claimRefreshLock(db, locationKey, now)) {
      return { outcome: 'locked', detail: 'Another refresh is already running.' };
    }

    try {
      const r = await runReviewRefresh({ db, locationKey, auto: true, actor: 'scheduler', now });
      return {
        outcome: 'refreshed',
        detail: `Fetched ${r.pages} page(s): ${r.ingest.inserted} new, ${r.ingest.updated} updated.`,
        inserted: r.ingest.inserted,
        updated: r.ingest.updated,
        pages: r.pages,
      };
    } finally {
      releaseRefreshLock(db, locationKey);
    }
  } catch (e: any) {
    // The failure is already on the connection record (runReviewRefresh or
    // gbpAccessToken wrote it), which is what the page reads. Returning it
    // rather than throwing keeps the scheduler tick alive.
    return { outcome: 'failed', detail: String(e?.message || e).slice(0, 400) };
  }
}
