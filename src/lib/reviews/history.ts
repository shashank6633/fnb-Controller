/**
 * GOOGLE REVIEWS — THE ROW UNIVERSE, AND THE ANCHOR THE ENGINE IS RUN AT.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS: TWO SURFACES MUST SCORE THE SAME ROWS THE SAME WAY.
 * ══════════════════════════════════════════════════════════════════════════
 * /api/crm-calls/reviews returns the report. /api/crm-calls/reviews/list
 * returns one filtered, sorted page of the SAME scored reviews, because the
 * client holds only the first 500 of them and cannot honestly filter or
 * re-order the rest by itself.
 *
 * `is_major`, `score` and `reasons` are NOT properties of a review. They are
 * properties of a review WITHIN A ROW SET: computeMajorReviews() compares each
 * review with the trailing normBaselineDays before it, and feeds in the day
 * keys that computePeriodAlerts() flagged over a series bounded by `from`/`to`.
 * Load a different set of rows, or anchor the series at a different instant,
 * and the same review comes back with a different score.
 *
 * So a second surface that loaded rows its own way would produce a list whose
 * badges disagree with the report's on the same screen — 'Needs attention'
 * showing a review the header does not count. Both surfaces call loadHistory()
 * and analysisWindow() and pass the result to analyzeReviews() unchanged. If
 * the cap or the 40-day floor is ever changed, it changes in one place and both
 * surfaces move together.
 *
 * Nothing here computes a figure. It selects rows and it computes the two
 * timestamps analyzeReviews() is bounded by.
 */
import type Database from 'better-sqlite3';
import { listReviews } from './ingest';
import { ensureReviewSchema } from './schema';
import { parseIsoMs, toIsoUtc } from './time';
import type { ReviewRow } from './types';

type DB = Database.Database;

/** Hard ceiling on rows pulled into memory for one report. Far past any single
 *  restaurant's Google review count (a very busy venue accumulates a few
 *  thousand over a decade). Over it, the OLDEST history is dropped — the recent
 *  end is what the page is for — and `truncated` says so rather than a surface
 *  quietly reporting an all-time figure over a subset. */
export const HISTORY_CAP = 10_000;

const DAY_MS = 86_400_000;

/** The 40-day floor on the series window. It guarantees at least two buckets in
 *  every period even with an empty table, so "today" and "yesterday" always
 *  exist to be reported as zero rather than as null-with-no-label. */
export const SERIES_FLOOR_DAYS = 40;

export interface HistoryLoad {
  /** Newest first, exactly as listReviews orders them. */
  rows: ReviewRow[];
  /** Every row stored for this listing, cap or no cap. */
  total_stored: number;
  /** True when the cap bit and the oldest history was left behind. */
  truncated: boolean;
  /** The posted_at the load starts at when the cap bit; null otherwise. */
  history_from: string | null;
}

/**
 * Every row this module is willing to hold for one listing, oldest end trimmed
 * if the cap bites.
 */
export function loadHistory(dbIn: DB, locationKey: string): HistoryLoad {
  // A default parameter, so an explicit null would NOT fall back to getDb().
  // Both callers already hold a handle; requiring one keeps that trap shut.
  const db = ensureReviewSchema(dbIn);

  const total = (db.prepare(
    'SELECT COUNT(*) AS n FROM gr_reviews WHERE location_key = ?',
  ).get(locationKey) as { n: number }).n;

  let historyFrom: string | undefined;
  if (total > HISTORY_CAP) {
    const cut = db.prepare(
      `SELECT posted_at FROM gr_reviews WHERE location_key = ?
        ORDER BY posted_at DESC LIMIT 1 OFFSET ?`,
    ).get(locationKey, HISTORY_CAP - 1) as { posted_at?: string } | undefined;
    if (cut?.posted_at) historyFrom = cut.posted_at;
  }

  const rows: ReviewRow[] = listReviews(db, { locationKey, from: historyFrom });
  return {
    rows,
    total_stored: total,
    truncated: !!historyFrom,
    history_from: historyFrom || null,
  };
}

/**
 * The `from`/`to` analyzeReviews() is bounded by.
 *
 * Anchored at NOW, not at the newest review. If the last review landed in
 * February, a series that ends in February has no "today" bucket and a page
 * silently reports February's numbers as this month's.
 */
export function analysisWindow(
  rows: Array<{ posted_at: string }>,
  now: number,
): { from: string; to: string } {
  let firstMs = Number.POSITIVE_INFINITY;
  for (const r of rows) {
    const ms = parseIsoMs(r.posted_at);
    if (ms != null && ms < firstMs) firstMs = ms;
  }
  const fromMs = Math.min(
    Number.isFinite(firstMs) ? firstMs : now,
    now - SERIES_FLOOR_DAYS * DAY_MS,
  );
  return { from: toIsoUtc(fromMs), to: toIsoUtc(now) };
}
