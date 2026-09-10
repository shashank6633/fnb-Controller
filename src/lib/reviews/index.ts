/**
 * GOOGLE REVIEWS — the module's front door.
 *
 * Two things live here and nothing else: the one orchestrator that joins a
 * source to the ingest (kept out of both files so neither has to import the
 * other), and the re-exports a caller should use instead of reaching into the
 * internals.
 *
 * THE SHAPE OF THE WHOLE THING, in one line:
 *     source.collect() -> raw documents -> archive -> parse -> upsert -> analyse
 * Every source produces the same raw documents; every document goes through the
 * same parser; every row lands under the same identity key. Which is why a
 * Takeout upload today and an API pull in six weeks de-duplicate against each
 * other instead of doubling the counts.
 */
import type Database from 'better-sqlite3';
import { ingestDocuments, type IngestOptions } from './ingest';
import { reviewSource } from './sources';
import type { CollectOptions, IngestResult, ReviewSourceKey } from './types';

export interface RunIngestOptions extends Omit<IngestOptions, 'source'> {
  source: ReviewSourceKey;
  /** Manual sources: the uploaded/pasted documents. API sources: ignored. */
  collect?: CollectOptions;
  db?: Database.Database;
}

/**
 * Collect from one source and ingest what comes back.
 *
 * A SourceNotConfiguredError from an API source is left to propagate with its
 * prerequisite list intact — the caller should show that list, because "Google
 * has not approved the application yet" is a sentence the owner needs to read,
 * not a 500.
 */
export async function runIngest(opts: RunIngestOptions): Promise<IngestResult> {
  const source = reviewSource(opts.source, opts.db);
  const documents = await source.collect(opts.collect || {});
  return ingestDocuments(opts.db || null, documents, {
    source: opts.source,
    locationKey: opts.locationKey,
    actor: opts.actor,
    label: opts.label,
    dateOrder: opts.dateOrder,
    expectedTotal: opts.expectedTotal,
    now: opts.now,
  });
}

export * from './types';
export { ensureReviewSchema, RAW_PAYLOAD_MAX_BYTES } from './schema';
export {
  analysisRows, archiveRaw, getRun, ingestDocuments, listReviews, listRuns,
  replayRawDocuments, startRun,
} from './ingest';
export {
  assignIdentities, contentHash, coerceRating, mergeReview, parseCsv, parseDocument,
  parseTimestamp, mapColumns,
} from './parse';
export {
  DEFAULT_THRESHOLDS, analyzeReviews, computeMajorReviews, computePeriodAlerts,
  computePeriodSeries, computeReplyMetrics, computeSummary, computeTrend,
} from './analysis';
export {
  DEFAULT_THEME_RULES, KEYWORD_DISCLAIMER, computeThemes, computeThemesByPeriod, matchThemes,
} from './themes';
export {
  AI_DISCLAIMER, REVIEWS_AI_FLAG, aiThemeReport, analyzePendingReviews,
  analyzeReviewWithAi, isReviewAiOn,
} from './ai';
export { reviewSource, reviewSources, sourceReadiness } from './sources';
export {
  GBP_KEYS, GBP_SCOPE, PREREQUISITES as GBP_PREREQUISITES, UNPROVEN as GBP_UNPROVEN,
  gbpConfig, gbpDiscover, gbpStatus, isValidParent,
  type GbpAccount, type GbpLocation,
} from './sources-gbp';
export { PERIODS, type Period } from './time';

/* ── The automatic connector ──────────────────────────────────────────────── */
export {
  autoDriverTickAt, connectionHealth, disconnect, driverStaleAfterMs, getConnection,
  isRefreshDue, recordAutoDriverTick, staleAfterHours,
  DEFAULT_INTERVAL_MIN, MAX_INTERVAL_MIN, MIN_INTERVAL_MIN,
  hasOauthApp, gbpCredentials,
  type ConnectionHealth, type ConnectionRecord, type HealthState,
} from './connection';
export {
  CALLBACK_PATH, beginConnect, callbackUrl, completeConnect, listConnectedLocations,
  selectLocation, setAutoRefresh,
} from './connect-flow';
export {
  runReviewAutoRefresh, runReviewRefresh,
  type AutoRefreshResult, type RefreshResult,
} from './refresh';
export { ReconnectRequiredError } from './oauth';

/* ── The screen's own decisions, kept pure so they can be gated ───────────── */
export {
  agoText, connectionBanner, fmtIst, intervalText, nextFetchText, periodProgress, periodTileView,
  type ConnectionBannerView, type ConnectionCta, type PeriodTileInput,
  type PeriodTileState, type PeriodTileView,
} from './view';
