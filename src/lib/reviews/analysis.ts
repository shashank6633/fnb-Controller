/**
 * GOOGLE REVIEWS — the analysis engine.
 *
 * EVERY FUNCTION IN THIS FILE IS PURE. Rows in, figures out. No database, no
 * fetch, no `new Date()` except through an explicit `now` you pass in. That is
 * not tidiness for its own sake: it is the only way a figure on a page can be
 * checked by recomputing it on paper, which is exactly what
 * scripts/reviews-tests.js does for one period, by hand, against these
 * functions rather than against a re-implementation of them.
 *
 * WHAT THE OWNER ASKED FOR, AND WHERE IT IS
 *   counts per day / week / month ......... computePeriodSeries()
 *   rating average + distribution ......... computeSummary(), and per bucket
 *   trend vs the previous period .......... computeTrend()
 *   MAJOR reviews ......................... computeMajorReviews()   <- definition below
 *   themes ................................ ./themes.ts (keyword) + ./ai.ts (LLM)
 *   reply rate and reply speed ............ computeReplyMetrics()
 *
 * ONE HONESTY RULE RUNS THROUGH ALL OF IT. A reconstructed history is not
 * Google's own historical series: reviews deleted by their authors or removed
 * by Google are simply absent from any export taken today, so a backfilled
 * daily count shows SURVIVORS ONLY and will drift slightly from what the owner
 * saw at the time. Every figure here is computed from the rows we hold, and the
 * page is expected to label it as a reconstruction.
 */
import type { AnalysisReview } from './types';
import {
  type Period, bucketKey, denseBuckets, hoursBetween, istDayKey, parseIsoMs,
} from './time';

/* ── Thresholds. All overridable; all defended in the comment beside them. ── */

export interface AnalysisThresholds {
  /** A rating at or below this is "low". 1-2 stars: on a 5-star scale these are
   *  the ratings a prospective guest reads first and the ones that move the
   *  headline average fastest. */
  lowRatingMax: number;
  /** "Long / detailed" in characters. 400 chars is roughly 70 words — past the
   *  one-line "great food!" and into a review that narrates an actual visit.
   *  Long reviews are the ones prospects read all the way through, whether they
   *  praise or complain, so length earns attention independently of rating. */
  longTextChars: number;
  /** Hours after posting before an unanswered review counts as unanswered.
   *  A review posted an hour ago has not been ignored; one posted three days ago
   *  has. 48h is the grace. */
  unansweredGraceHours: number;
  /** Trailing window used as "the norm" for a single review. 90 days is long
   *  enough to be stable for a venue doing a few reviews a week and short enough
   *  to follow a real change in the kitchen. */
  normBaselineDays: number;
  /** How far below the trailing mean counts as a sharp personal drop.
   *  1.5 stars: for a venue averaging 4.8 that makes a 3-star notable, which is
   *  the whole point — at a high average, a 3 IS the bad news. */
  normDropStars: number;
  /** Minimum reviews in the trailing window before "the norm" means anything.
   *  Below this the baseline is noise and the below-norm reason is not applied. */
  normMinSample: number;
  /** Score at or above which a review is MAJOR. */
  majorScore: number;
  /** Period alert: average fell by at least this much below the trailing norm. */
  periodDropStars: number;
  /** Period alert: minimum reviews in the bucket, and in the baseline behind it,
   *  before a move is a signal rather than one grumpy Tuesday. */
  periodMinSample: number;
  /** Period alert: volume multiple over the trailing norm that counts as a spike. */
  periodSpikeMultiple: number;
  /** How many preceding buckets make up "the norm" a bucket is judged against.
   *  7 = a week of days, or roughly two months of weeks, or half a year of
   *  months. See the comment on computePeriodAlerts for why this is not simply
   *  "the previous bucket". */
  periodBaselineBuckets: number;
  /** Period alert: a spike must also exceed the norm by this many reviews in
   *  absolute terms. Without it, 3 reviews against a norm of 1 is a "200%
   *  spike" and the alert list fills with Tuesdays. */
  periodSpikeMinExcess: number;
}

export const DEFAULT_THRESHOLDS: AnalysisThresholds = {
  lowRatingMax: 2,
  longTextChars: 400,
  unansweredGraceHours: 48,
  normBaselineDays: 90,
  normDropStars: 1.5,
  normMinSample: 10,
  majorScore: 3,
  periodDropStars: 0.75,
  periodMinSample: 3,
  periodSpikeMultiple: 2,
  periodBaselineBuckets: 7,
  periodSpikeMinExcess: 4,
};

/* ── Small shared helpers ─────────────────────────────────────────────────── */

export type Distribution = { 1: number; 2: number; 3: number; 4: number; 5: number };

const emptyDist = (): Distribution => ({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });

/** Round to `dp` decimals, returning a NUMBER. Every average on a page goes
 *  through this so 4.3999999999 never reaches a chart axis. */
export function round(n: number, dp = 2): number {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

function mean(xs: number[]): number | null {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Nearest-rank percentile on a sorted copy. p in [0,1]. */
function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[idx];
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** A review has a reply if there is reply TEXT. A replied_at with no text is a
 *  timestamp without a reply and is not counted as answered. */
export function hasReply(r: AnalysisReview): boolean {
  return !!(r.reply_text && r.reply_text.trim());
}

/** Rows sorted oldest-first, with unparseable dates dropped and counted.
 *  Nothing downstream has to re-sort or re-guard. */
export function prepare(rows: AnalysisReview[]): { rows: Array<AnalysisReview & { ms: number }>; dropped: number } {
  const out: Array<AnalysisReview & { ms: number }> = [];
  let dropped = 0;
  for (const r of rows) {
    const ms = parseIsoMs(r.posted_at);
    if (ms == null) { dropped++; continue; }
    out.push({ ...r, ms });
  }
  out.sort((a, b) => a.ms - b.ms);
  return { rows: out, dropped };
}

/* ── Summary ──────────────────────────────────────────────────────────────── */

export interface ReplyMetrics {
  replied: number;
  unreplied: number;
  /** replied / total, 0..1. null when there are no reviews at all — a reply
   *  rate over zero reviews is not 0%, it is undefined, and showing 0% would
   *  read as a failure that has not happened. */
  reply_rate: number | null;
  /** Unanswered AND past the grace window — the actionable backlog. */
  overdue: number;
  /** Age in hours of the oldest unanswered review. */
  oldest_unanswered_hours: number | null;
  /** How many replies we can actually TIME. A Takeout export may carry the
   *  reply text but no reply timestamp, in which case speed is unknown and this
   *  number — not `replied` — is the denominator for every figure below it. */
  timed: number;
  median_hours: number | null;
  mean_hours: number | null;
  p90_hours: number | null;
  within_24h: number;
  within_72h: number;
}

export interface ReviewSummary {
  total: number;
  /** Rows whose posted_at could not be read. Should be 0; shown so it cannot
   *  hide. */
  undated: number;
  first_at: string | null;
  last_at: string | null;
  average: number | null;
  distribution: Distribution;
  /** Share of each rating, 0..1. */
  distribution_pct: Distribution;
  low_count: number;
  long_count: number;
  with_text: number;
  without_text: number;
  reply: ReplyMetrics;
  languages: Array<{ code: string; count: number }>;
}

export function computeReplyMetrics(
  rows: AnalysisReview[],
  opts: { now?: number; thresholds?: Partial<AnalysisThresholds> } = {},
): ReplyMetrics {
  const t = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds || {}) };
  const now = opts.now ?? Date.now();

  let replied = 0, unreplied = 0, overdue = 0;
  let oldestUnansweredMs: number | null = null;
  const durations: number[] = [];

  for (const r of rows) {
    if (hasReply(r)) {
      replied++;
      const h = r.replied_at ? hoursBetween(r.posted_at, r.replied_at) : null;
      if (h != null) durations.push(h);
    } else {
      unreplied++;
      const ms = parseIsoMs(r.posted_at);
      if (ms != null) {
        const ageH = (now - ms) / 3_600_000;
        if (ageH >= t.unansweredGraceHours) overdue++;
        if (oldestUnansweredMs == null || ms < oldestUnansweredMs) oldestUnansweredMs = ms;
      }
    }
  }

  const total = replied + unreplied;
  const m = mean(durations);
  const md = median(durations);
  const p90 = percentile(durations, 0.9);

  return {
    replied,
    unreplied,
    reply_rate: total ? round(replied / total, 4) : null,
    overdue,
    oldest_unanswered_hours: oldestUnansweredMs == null ? null : round((now - oldestUnansweredMs) / 3_600_000, 1),
    timed: durations.length,
    median_hours: md == null ? null : round(md, 1),
    mean_hours: m == null ? null : round(m, 1),
    p90_hours: p90 == null ? null : round(p90, 1),
    within_24h: durations.filter(h => h <= 24).length,
    within_72h: durations.filter(h => h <= 72).length,
  };
}

export function computeSummary(
  rows: AnalysisReview[],
  opts: { now?: number; thresholds?: Partial<AnalysisThresholds> } = {},
): ReviewSummary {
  const t = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds || {}) };
  const { rows: sorted, dropped } = prepare(rows);

  const dist = emptyDist();
  const pct = emptyDist();
  const langs = new Map<string, number>();
  let low = 0, long = 0, withText = 0;

  for (const r of sorted) {
    const star = Math.min(5, Math.max(1, Math.round(r.rating))) as 1 | 2 | 3 | 4 | 5;
    dist[star]++;
    if (r.rating <= t.lowRatingMax) low++;
    const len = (r.text || '').trim().length;
    if (len >= t.longTextChars) long++;
    if (len > 0) withText++;
    const code = (r.language || '').trim().toLowerCase();
    if (code) langs.set(code, (langs.get(code) || 0) + 1);
  }

  const total = sorted.length;
  if (total) for (const k of [1, 2, 3, 4, 5] as const) pct[k] = round(dist[k] / total, 4);

  return {
    total,
    undated: dropped,
    first_at: total ? sorted[0].posted_at : null,
    last_at: total ? sorted[total - 1].posted_at : null,
    average: total ? round(sorted.reduce((a, r) => a + r.rating, 0) / total, 2) : null,
    distribution: dist,
    distribution_pct: pct,
    low_count: low,
    long_count: long,
    with_text: withText,
    without_text: total - withText,
    reply: computeReplyMetrics(sorted, opts),
    languages: [...langs.entries()].map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
  };
}

/* ── Period series ────────────────────────────────────────────────────────── */

export interface PeriodBucket {
  key: string;
  start_date: string;
  end_date: string;
  count: number;
  average: number | null;
  distribution: Distribution;
  low_count: number;
  long_count: number;
  replied: number;
  reply_rate: number | null;
}

export interface PeriodSeries {
  period: Period;
  buckets: PeriodBucket[];
  /** True when the range was longer than the engine will walk and the OLD end
   *  was dropped. Shown rather than silently rendering a partial chart. */
  truncated: boolean;
}

/**
 * Counts, average and distribution per day / week / month, DENSE — a period
 * with no reviews appears with count 0 rather than vanishing.
 *
 * That matters twice over. On a chart, a missing month reads as continuity when
 * it was actually silence. And in computeTrend(), the "previous period" of a
 * sparse series is whatever bucket happens to be adjacent in the array, which
 * on a quiet month would compare March against January and call it a monthly
 * move.
 */
export function computePeriodSeries(
  rows: AnalysisReview[],
  opts: { period?: Period; from?: string; to?: string; now?: number } = {},
): PeriodSeries {
  const period = opts.period || 'daily';
  const { rows: sorted } = prepare(rows);

  const fromMs = opts.from ? parseIsoMs(opts.from) : (sorted.length ? sorted[0].ms : null);
  const toMs = opts.to ? parseIsoMs(opts.to) : (sorted.length ? sorted[sorted.length - 1].ms : null);
  if (fromMs == null || toMs == null) return { period, buckets: [], truncated: false };

  const { buckets: dense, truncated } = denseBuckets(fromMs, toMs, period);
  const index = new Map<string, PeriodBucket>();
  const out: PeriodBucket[] = dense.map(b => {
    const bucket: PeriodBucket = {
      key: b.key, start_date: b.start_date, end_date: b.end_date,
      count: 0, average: null, distribution: emptyDist(),
      low_count: 0, long_count: 0, replied: 0, reply_rate: null,
    };
    index.set(b.key, bucket);
    return bucket;
  });

  const totals = new Map<string, number>();
  for (const r of sorted) {
    if (r.ms < fromMs || r.ms > toMs) continue;
    const key = bucketKey(r.ms, period);
    const b = index.get(key);
    if (!b) continue;   // outside the (possibly truncated) dense window
    b.count++;
    totals.set(key, (totals.get(key) || 0) + r.rating);
    const star = Math.min(5, Math.max(1, Math.round(r.rating))) as 1 | 2 | 3 | 4 | 5;
    b.distribution[star]++;
    if (r.rating <= DEFAULT_THRESHOLDS.lowRatingMax) b.low_count++;
    if ((r.text || '').trim().length >= DEFAULT_THRESHOLDS.longTextChars) b.long_count++;
    if (hasReply(r)) b.replied++;
  }

  for (const b of out) {
    if (b.count) {
      b.average = round((totals.get(b.key) || 0) / b.count, 2);
      b.reply_rate = round(b.replied / b.count, 4);
    }
  }

  return { period, buckets: out, truncated };
}

/* ── Trend vs the previous period ─────────────────────────────────────────── */

export interface Trend {
  period: Period;
  current: PeriodBucket | null;
  previous: PeriodBucket | null;
  count_delta: number | null;
  /** Percentage change in volume, 0.25 = +25%. null when the previous period
   *  had zero reviews — growth from nothing is not "infinity percent", it is
   *  undefined, and the page should say "no reviews last period" instead. */
  count_pct: number | null;
  avg_delta: number | null;
  /** Direction of the RATING move, which is the one the owner cares about.
   *  'flat' when the move is smaller than 0.05 stars, i.e. rounding. */
  direction: 'up' | 'down' | 'flat' | 'unknown';
}

export function computeTrend(series: PeriodSeries): Trend {
  const n = series.buckets.length;
  const current = n >= 1 ? series.buckets[n - 1] : null;
  const previous = n >= 2 ? series.buckets[n - 2] : null;

  if (!current || !previous) {
    return { period: series.period, current, previous, count_delta: null, count_pct: null, avg_delta: null, direction: 'unknown' };
  }

  const countDelta = current.count - previous.count;
  const countPct = previous.count > 0 ? round(countDelta / previous.count, 4) : null;
  const avgDelta = (current.average != null && previous.average != null)
    ? round(current.average - previous.average, 2) : null;

  let direction: Trend['direction'] = 'unknown';
  if (avgDelta != null) direction = avgDelta > 0.05 ? 'up' : avgDelta < -0.05 ? 'down' : 'flat';

  return { period: series.period, current, previous, count_delta: countDelta, count_pct: countPct, avg_delta: avgDelta, direction };
}

/* ── Period alerts: "a sharp change from the norm" at bucket level ────────── */

export interface PeriodAlert {
  key: string;
  kind: 'rating_drop' | 'volume_spike';
  detail: string;
  current: number;
  /** The trailing norm the bucket was judged against, not the previous bucket. */
  baseline: number;
  /** How many buckets, and how many reviews, that norm was built from. */
  baseline_buckets: number;
  baseline_reviews: number;
}

/**
 * "A sharp change from the norm" at bucket level.
 *
 * JUDGED AGAINST A TRAILING NORM, NOT AGAINST YESTERDAY. This was the first
 * implementation and it was wrong, in a way worth recording because it is the
 * obvious way to write it: comparing each bucket with the single bucket before
 * it. At daily resolution that produces a stream of junk — a venue collecting
 * about one review a day trips "200% volume spike" every time two land on the
 * same Tuesday — while MISSING the case that actually matters, a burst of
 * eleven reviews on a Saturday after a silent Friday, because a multiple of
 * zero is not a multiple and the rule refused to fire at all.
 *
 * So each bucket is compared with the mean of the periodBaselineBuckets buckets
 * before it, and a spike must clear THREE bars, not one:
 *
 *   rating_drop  — the bucket's average is >= periodDropStars below the trailing
 *                  mean rating, the bucket holds >= periodMinSample reviews, and
 *                  the baseline holds >= periodMinSample reviews too. Without
 *                  the second sample test, one review in a quiet week becomes
 *                  "the rating collapsed".
 *
 *   volume_spike — count >= periodMinSample, AND count >= periodSpikeMultiple x
 *                  the trailing mean count, AND count exceeds that mean by at
 *                  least periodSpikeMinExcess reviews in absolute terms. The
 *                  third test is what kills the Tuesday noise: 3-against-1 is a
 *                  tripling and is nothing; 11-against-1 is a Saturday.
 *
 * A bucket with too little history behind it is not judged at all, rather than
 * judged against one neighbour.
 */
export function computePeriodAlerts(
  series: PeriodSeries,
  opts: { thresholds?: Partial<AnalysisThresholds> } = {},
): PeriodAlert[] {
  const t = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds || {}) };
  const out: PeriodAlert[] = [];
  const minHistory = Math.min(3, t.periodBaselineBuckets);

  for (let i = minHistory; i < series.buckets.length; i++) {
    const cur = series.buckets[i];
    const window = series.buckets.slice(Math.max(0, i - t.periodBaselineBuckets), i);
    if (!window.length) continue;

    const baseReviews = window.reduce((a, b) => a + b.count, 0);
    const baseCountMean = baseReviews / window.length;
    // Rating baseline is review-weighted, not bucket-weighted: a month with 40
    // reviews should count for more than a month with 2 when deciding what
    // normal looks like.
    const baseRatingSum = window.reduce((a, b) => a + (b.average ?? 0) * b.count, 0);
    const baseRating = baseReviews ? baseRatingSum / baseReviews : null;

    if (cur.count >= t.periodMinSample && baseReviews >= t.periodMinSample &&
        cur.average != null && baseRating != null &&
        baseRating - cur.average >= t.periodDropStars) {
      out.push({
        key: cur.key, kind: 'rating_drop',
        detail: `average ${cur.average} over ${cur.count} reviews, against a trailing ` +
                `${round(baseRating, 2)} over the previous ${window.length} ${series.period === 'daily' ? 'days' : series.period === 'weekly' ? 'weeks' : 'months'}`,
        current: cur.average,
        baseline: round(baseRating, 2),
        baseline_buckets: window.length,
        baseline_reviews: baseReviews,
      });
    }

    if (cur.count >= t.periodMinSample &&
        cur.count >= baseCountMean * t.periodSpikeMultiple &&
        cur.count - baseCountMean >= t.periodSpikeMinExcess) {
      out.push({
        key: cur.key, kind: 'volume_spike',
        detail: `${cur.count} reviews, against a trailing average of ${round(baseCountMean, 1)}`,
        current: cur.count,
        baseline: round(baseCountMean, 2),
        baseline_buckets: window.length,
        baseline_reviews: baseReviews,
      });
    }
  }
  return out;
}

/* ── MAJOR REVIEWS ────────────────────────────────────────────────────────── */

export type MajorReason =
  | 'low_rating' | 'three_star' | 'unanswered' | 'unanswered_positive'
  | 'long_detailed' | 'below_norm' | 'in_alert_period';

export interface MajorReview {
  id: string;
  rating: number;
  posted_at: string;
  text_len: number;
  replied: boolean;
  score: number;
  reasons: MajorReason[];
  /** The trailing mean this review was judged against; null when the trailing
   *  window held fewer than normMinSample reviews. */
  baseline: number | null;
  is_major: boolean;
}

export interface MajorResult {
  reviews: MajorReview[];
  major: MajorReview[];
  counts: Record<MajorReason, number>;
  major_count: number;
  thresholds: AnalysisThresholds;
  /** The definition, in words, so a page can print it next to the list and the
   *  owner can argue with the actual rule rather than with a black box. */
  definition: string[];
}

/**
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT "MAJOR" MEANS. READ THIS BEFORE CHANGING A NUMBER.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * "Major" is not a rating band. It is "this one is worth the owner's attention
 * today", and four different things can earn that, so it is scored rather than
 * matched. Each reason adds points; MAJOR is score >= majorScore (default 3).
 * Every review carries its reasons, so the list is arguable line by line.
 *
 *   low_rating           1 star  +4   | The ones that cost bookings. A 1-star
 *                        2 stars +3   | alone is major whatever else is true.
 *
 *   three_star           +1           | Not bad, not good. On its own it is not
 *                                     | major; combined with silence or with a
 *                                     | high house average, it is.
 *
 *   unanswered           +2           | No reply, rating <= 3, and older than
 *                                     | the grace window. This is the one that
 *                                     | is genuinely actionable: a reply is
 *                                     | free and public.
 *
 *   unanswered_positive  +1           | No reply, rating >= 4, and long. Not a
 *                                     | problem — an opportunity being wasted.
 *                                     | Deliberately cheap so it can never make
 *                                     | a happy guest "major" on its own.
 *
 *   long_detailed        +1           | >= longTextChars. Length is a proxy for
 *                                     | how much a prospect will read, in both
 *                                     | directions.
 *
 *   below_norm           +2           | At least normDropStars below the venue's
 *                                     | own trailing average (>= normMinSample
 *                                     | reviews in the trailing window, else the
 *                                     | reason is not applied). This is the
 *                                     | "sharp change" test at review level: at
 *                                     | a 4.8 house average a 3-star IS the bad
 *                                     | news, and a fixed 1-2 star rule would
 *                                     | never surface it.
 *
 *   in_alert_period      +1           | The review sits in a day/week/month that
 *                                     | computePeriodAlerts() flagged. One bad
 *                                     | night's reviews rise together, which is
 *                                     | how a service problem actually presents.
 *
 * WORKED CONSEQUENCES, so the shape of the rule is visible:
 *   1-star, replied, short ............ 4        MAJOR
 *   2-star, replied, short ............ 3        MAJOR
 *   3-star, no reply, short ........... 1+2 = 3  MAJOR  (a reply is owed)
 *   3-star, replied, short ............ 1        not major
 *   5-star, no reply, 800 chars ....... 1+1 = 2  not major, listed as an
 *                                                 opportunity
 *   4-star, no reply, short ........... 0        not major
 *
 * THE BASELINE IS TRAILING, NOT GLOBAL. Each review is compared with the
 * normBaselineDays BEFORE it, never with an average that includes itself or the
 * future. A global mean would let one terrible month re-classify the reviews
 * that preceded it, and the list would change meaning every time new data
 * arrived.
 */
export function computeMajorReviews(
  rows: AnalysisReview[],
  opts: {
    now?: number;
    thresholds?: Partial<AnalysisThresholds>;
    /** Bucket keys already flagged by computePeriodAlerts, plus the period they
     *  were computed at. Optional: without it, in_alert_period never fires. */
    alertKeys?: string[];
    alertPeriod?: Period;
  } = {},
): MajorResult {
  const t = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds || {}) };
  const now = opts.now ?? Date.now();
  const { rows: sorted } = prepare(rows);
  const alerts = new Set(opts.alertKeys || []);
  const alertPeriod: Period = opts.alertPeriod || 'daily';

  const counts: Record<MajorReason, number> = {
    low_rating: 0, three_star: 0, unanswered: 0, unanswered_positive: 0,
    long_detailed: 0, below_norm: 0, in_alert_period: 0,
  };

  const baselineMs = t.normBaselineDays * 86_400_000;
  const out: MajorReview[] = [];
  // Sliding trailing window over the sorted rows: O(n) rather than O(n^2), so
  // "recompute the whole history" stays cheap enough to do on every page load.
  let windowStart = 0;
  let windowSum = 0;
  let windowCount = 0;

  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    while (windowStart < i && sorted[windowStart].ms < r.ms - baselineMs) {
      windowSum -= sorted[windowStart].rating;
      windowCount--;
      windowStart++;
    }
    const baseline = windowCount >= t.normMinSample ? round(windowSum / windowCount, 2) : null;

    const textLen = (r.text || '').trim().length;
    const replied = hasReply(r);
    const ageHours = (now - r.ms) / 3_600_000;
    const pastGrace = ageHours >= t.unansweredGraceHours;

    const reasons: MajorReason[] = [];
    let score = 0;

    if (r.rating <= t.lowRatingMax) {
      reasons.push('low_rating');
      score += r.rating <= 1 ? 4 : 3;
    } else if (r.rating === 3) {
      reasons.push('three_star');
      score += 1;
    }

    if (!replied && pastGrace) {
      if (r.rating <= 3) { reasons.push('unanswered'); score += 2; }
      else if (textLen >= t.longTextChars) { reasons.push('unanswered_positive'); score += 1; }
    }

    if (textLen >= t.longTextChars) { reasons.push('long_detailed'); score += 1; }

    if (baseline != null && r.rating <= baseline - t.normDropStars) {
      reasons.push('below_norm');
      score += 2;
    }

    if (alerts.size && alerts.has(bucketKey(r.ms, alertPeriod))) {
      reasons.push('in_alert_period');
      score += 1;
    }

    for (const reason of reasons) counts[reason]++;

    out.push({
      id: r.id,
      rating: r.rating,
      posted_at: r.posted_at,
      text_len: textLen,
      replied,
      score,
      reasons,
      baseline,
      is_major: score >= t.majorScore,
    });

    windowSum += r.rating;
    windowCount++;
  }

  const major = out.filter(m => m.is_major)
    .sort((a, b) => b.score - a.score || (a.posted_at < b.posted_at ? 1 : -1));

  return {
    reviews: out,
    major,
    counts,
    major_count: major.length,
    thresholds: t,
    definition: [
      `A review is MAJOR when its attention score reaches ${t.majorScore}.`,
      `1 star = 4 points; 2 stars = 3; 3 stars = 1.`,
      `No reply after ${t.unansweredGraceHours}h and rated 3 or below = +2.`,
      `No reply after ${t.unansweredGraceHours}h, rated 4-5 and over ${t.longTextChars} characters = +1 (a missed thank-you, not a problem).`,
      `Over ${t.longTextChars} characters = +1.`,
      `At least ${t.normDropStars} stars below our own trailing ${t.normBaselineDays}-day average (needs ${t.normMinSample}+ reviews in that window) = +2.`,
      `Posted inside a period already flagged for a rating drop or a volume spike = +1.`,
    ],
  };
}

/* ── One call for a page ──────────────────────────────────────────────────── */

export interface ReviewAnalysis {
  summary: ReviewSummary;
  series: Record<Period, PeriodSeries>;
  trend: Record<Period, Trend>;
  alerts: PeriodAlert[];
  major: MajorResult;
  /** Standing caveats a page must be able to render next to the numbers. */
  caveats: string[];
}

/**
 * Everything a page needs, computed once from one row set. Still pure — the
 * caller does the fetching and passes `now`.
 */
export function analyzeReviews(
  rows: AnalysisReview[],
  opts: { now?: number; thresholds?: Partial<AnalysisThresholds>; from?: string; to?: string } = {},
): ReviewAnalysis {
  const now = opts.now ?? Date.now();
  const series: Record<Period, PeriodSeries> = {
    daily: computePeriodSeries(rows, { period: 'daily', from: opts.from, to: opts.to, now }),
    weekly: computePeriodSeries(rows, { period: 'weekly', from: opts.from, to: opts.to, now }),
    monthly: computePeriodSeries(rows, { period: 'monthly', from: opts.from, to: opts.to, now }),
  };
  // Alerts are raised at DAILY resolution and fed into review scoring at the
  // same resolution, so "in a flagged period" means "on a flagged day" — a
  // month-level flag would tar four good weeks with one bad one.
  const dailyAlerts = computePeriodAlerts(series.daily, { thresholds: opts.thresholds });
  const weeklyAlerts = computePeriodAlerts(series.weekly, { thresholds: opts.thresholds });
  const monthlyAlerts = computePeriodAlerts(series.monthly, { thresholds: opts.thresholds });

  const major = computeMajorReviews(rows, {
    now,
    thresholds: opts.thresholds,
    alertKeys: dailyAlerts.map(a => a.key),
    alertPeriod: 'daily',
  });

  return {
    summary: computeSummary(rows, { now, thresholds: opts.thresholds }),
    series,
    trend: {
      daily: computeTrend(series.daily),
      weekly: computeTrend(series.weekly),
      monthly: computeTrend(series.monthly),
    },
    alerts: [...dailyAlerts, ...weeklyAlerts, ...monthlyAlerts],
    major,
    caveats: [
      'History is reconstructed from the reviews that still exist. Reviews deleted ' +
      'by their authors or removed by Google are absent from any export taken today, ' +
      'so past daily counts show survivors only and will differ slightly from what ' +
      'was visible at the time.',
      'Buckets are Asia/Kolkata calendar days, weeks (Monday-first) and months.',
      'Reply speed is measured only for replies that carry a timestamp; a source ' +
      'that exports the reply text without a reply time is counted as answered but ' +
      'not timed.',
    ],
  };
}

/** Convenience for a page: the day key a review falls into, so a table row and
 *  a chart bar cannot disagree about which bucket a review belongs to. */
export function dayKeyOf(review: AnalysisReview): string | null {
  const ms = parseIsoMs(review.posted_at);
  return ms == null ? null : istDayKey(ms);
}
