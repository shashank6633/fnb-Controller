/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser, isManagement } from '@/lib/auth';
import {
  analyzeReviews, autoDriverTickAt, computeThemes, connectionHealth, ensureReviewSchema,
  getConnection, hasOauthApp, listReviews, listRuns, sourceReadiness,
  type AnalysisReview, type ReviewRow,
} from '@/lib/reviews';
// MajorReview is an analysis-layer type; index.ts re-exports the functions but
// not the interfaces. Imported from the submodule rather than widening the
// module's front door for one type.
import type { MajorReview } from '@/lib/reviews/analysis';
import { reviewSetting } from '@/lib/reviews/schema';
// The coverage rule is a pure decision with its own gates (section AE of
// scripts/reviews-tests.js), not arithmetic invented in this route.
import { importCoverage } from '@/lib/reviews/view';
import { istCivilToMs, istDayKey, parseIsoMs, toIsoUtc } from '@/lib/reviews/time';

/**
 * CRM — Google Reviews report (GET /api/crm-calls/reviews). Management only.
 *
 * ── THIS ROUTE COMPUTES NOTHING ─────────────────────────────────────────────
 * Every figure it returns comes out of src/lib/reviews (analyzeReviews,
 * computeThemes) unchanged. The route fetches rows, calls the engine ONCE, and
 * reshapes the result for one screen. That is deliberate and worth keeping: the
 * engine has a 112-case suite asserting hand-computed numbers, and the moment
 * this file starts averaging or bucketing anything itself, the page and the
 * suite are measuring two different things and only one of them is tested.
 *
 * If a number on the page looks wrong, it is wrong in analysis.ts, and it is
 * reproducible with `node scripts/reviews-tests.js` without a browser.
 *
 * ── THE ONE THING THIS PAGE MUST NEVER DO ───────────────────────────────────
 * Look live while being stale. "We had no complaints this week" and "nothing
 * was imported this week" produce the SAME empty list, and the second one read
 * as the first is how a venue reassures itself about a week it never looked at.
 * So every headline block carries `import_covers`: whether the last successful
 * import finished at or after that period began. A zero count with
 * import_covers = false is NOT "no reviews" and the page is required to say so.
 *
 * `average: null` is likewise not 0.0. A period with no reviews has no average;
 * rendering 0.0 stars would read as the worst month in the venue's history.
 *
 * ── GATING ──────────────────────────────────────────────────────────────────
 * getCurrentUser() -> 401, isManagement() -> 403 'Management only', the same
 * gate as /api/crm-calls/missed-attribution. The catalog flag (mgmtOnly) and
 * the Sidebar row are navigation only; this check is the boundary.
 *
 * Why management and not member-open, given the reviews themselves are public
 * on Google: the aggregate is not public. "Our average fell 0.6 stars this
 * month", the theme table, and the venue's own reply-rate are a performance
 * report on the floor's work — the same class as Missed-Call Attribution, which
 * is mgmtOnly for the same reason. Individual reviews stay readable by anyone
 * on Google; this screen is the scoreboard built from them.
 */

export const dynamic = 'force-dynamic';

/** Hard ceiling on rows pulled into memory for one report. Far past any single
 *  restaurant's Google review count (a very busy venue accumulates a few
 *  thousand over a decade). Over it, the OLDEST history is dropped — the recent
 *  end is what the page is for — and `history_truncated` says so rather than
 *  the page quietly reporting an all-time average over a subset. */
const HISTORY_CAP = 10_000;

/** Cap on reviews returned in the list. The page filters this set client-side,
 *  so the cap is disclosed alongside the true totals. */
const LIST_CAP = 500;

/** Buckets sent for the chart, per period. Trimmed from the OLD end; the page
 *  is told how many earlier buckets it is not seeing. `full=1` lifts it. */
const CHART_POINTS: Record<string, number> = { daily: 60, weekly: 52, monthly: 24 };

/** Default staleness threshold, in hours, for a MANUAL route. Seven days: a
 *  Takeout import is a human action, and a week without one means the page is a
 *  week behind whatever Google is showing prospective guests. */
const STALE_HOURS_MANUAL = 168;
/** …and for the API connector, which is supposed to run unattended. Two days
 *  of silence from something that should be automatic is itself the news. */
const STALE_HOURS_API = 48;

const DAY_MS = 86_400_000;

type PeriodKey = 'daily' | 'weekly' | 'monthly';

/** IST calendar date (YYYY-MM-DD) -> the UTC instant of its 00:00 IST. */
function istDayStartMs(day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  return istCivilToMs(Number(m[1]), Number(m[2]), Number(m[3]));
}

/**
 * The link a manager follows to reply. NO EXPORT CARRIES A PER-REVIEW URL —
 * not Takeout, not the v4 API, not any CSV the parser accepts — so this is the
 * listing's review list, and the page labels it as exactly that. Guessing at
 * Google's undocumented maps deep-link format was considered and rejected: an
 * internal format that breaks silently is worse than an honest link to the
 * right page.
 */
function replyLink(db: any): { url: string; kind: 'place_id' | 'custom' | 'none'; note: string } {
  const placeId = reviewSetting(db, 'reviews_place_id').trim();
  if (placeId) {
    return {
      url: `https://search.google.com/local/reviews?placeid=${encodeURIComponent(placeId)}`,
      kind: 'place_id',
      note: 'Opens the listing’s review list on Google, where replies are written. Google exports carry no per-review link, so this is the list, not the single review — the author name and date below identify it.',
    };
  }
  const custom = reviewSetting(db, 'reviews_listing_url').trim();
  if (/^https:\/\//i.test(custom)) {
    return {
      url: custom,
      kind: 'custom',
      note: 'Opens the listing link an admin saved. Google exports carry no per-review link, so this is the list, not the single review.',
    };
  }
  return {
    url: '',
    kind: 'none',
    note: 'No listing link saved yet. An admin can add the Google Place ID or the listing URL from the Import panel on this page.',
  };
}

export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not signed in' }, { status: 401 });
  if (!isManagement(me)) return Response.json({ error: 'Management only' }, { status: 403 });

  const sp = new URL(req.url).searchParams;
  const locationKey = (sp.get('location') || '').trim();
  const periodRaw = (sp.get('period') || 'monthly').trim();
  const period: PeriodKey = periodRaw === 'daily' || periodRaw === 'weekly' ? periodRaw : 'monthly';
  const full = sp.get('full') === '1';

  const db = ensureReviewSchema(getDb());
  const now = Date.now();
  const nowIso = toIsoUtc(now);

  /* ── 1. Rows. One query; the engine takes it from here. ─────────────────── */

  const totalStored = (db.prepare(
    'SELECT COUNT(*) AS n FROM gr_reviews WHERE location_key = ?',
  ).get(locationKey) as { n: number }).n;

  let historyFrom: string | undefined;
  if (totalStored > HISTORY_CAP) {
    const cut = db.prepare(
      `SELECT posted_at FROM gr_reviews WHERE location_key = ?
        ORDER BY posted_at DESC LIMIT 1 OFFSET ?`,
    ).get(locationKey, HISTORY_CAP - 1) as { posted_at?: string } | undefined;
    if (cut?.posted_at) historyFrom = cut.posted_at;
  }

  const rows: ReviewRow[] = listReviews(db, { locationKey, from: historyFrom });
  const analysisInput: AnalysisReview[] = rows;

  /* ── 2. The engine, once. ───────────────────────────────────────────────── */

  // Anchor the series at NOW, not at the newest review. If the last review
  // landed in February, a series that ends in February has no "today" bucket
  // and the page silently reports February's numbers as this month's.
  //
  // The floor of 40 days back guarantees at least two buckets in every period
  // even with an empty table, so "today" and "yesterday" always exist to be
  // reported as zero rather than as null-with-no-label.
  let firstMs = Number.POSITIVE_INFINITY;
  for (const r of rows) {
    const ms = parseIsoMs(r.posted_at);
    if (ms != null && ms < firstMs) firstMs = ms;
  }
  const fromMs = Math.min(Number.isFinite(firstMs) ? firstMs : now, now - 40 * DAY_MS);

  const analysis = analyzeReviews(analysisInput, {
    now,
    from: toIsoUtc(fromMs),
    to: nowIso,
  });

  /* ── 3. Data state — computed BEFORE the headline, because the headline
   *      blocks need to know whether an import even covers them. ─────────── */

  const runs = listRuns(db, 25) as any[];
  const forThisLocation = runs.filter(r => (r.location_key || '') === locationKey);
  const lastRun = forThisLocation[0] || null;
  const lastSuccess = forThisLocation.find(r => r.status === 'done') || null;
  const lastSuccessMs = lastSuccess?.finished_at ? parseIsoMs(lastSuccess.finished_at) : null;

  const staleHours = (() => {
    const override = Number(reviewSetting(db, 'reviews_stale_hours', ''));
    if (Number.isFinite(override) && override > 0) return override;
    return lastSuccess?.source === 'gbp_api' ? STALE_HOURS_API : STALE_HOURS_MANUAL;
  })();

  const hoursSinceIngest = lastSuccessMs == null ? null : (now - lastSuccessMs) / 3_600_000;
  const newestReviewAt = analysis.summary.last_at;
  const newestMs = newestReviewAt ? parseIsoMs(newestReviewAt) : null;

  /* ── WHAT THE DATA ACTUALLY COVERS, WHICH IS NOT WHEN THE RUN FINISHED ────
   * `import_covers` below is measured against this, not against the run's
   * finished_at. An out-of-date file imported one minute ago used to make every
   * empty period since read "No reviews" instead of "Not imported". The rule
   * and its reasoning live in importCoverage() (src/lib/reviews/view.ts, gated
   * in section AE) because it is a decision, not arithmetic this route invents.
   */
  const coverage = importCoverage({
    last_success_at: lastSuccess?.finished_at || null,
    last_success_source: lastSuccess?.source || null,
    newest_review_at: newestReviewAt || null,
  });
  const coverageEndMs = coverage.end_at ? parseIsoMs(coverage.end_at) : null;

  const dataState = {
    never_ingested: lastSuccess == null,
    stale: lastSuccessMs == null ? true : (hoursSinceIngest != null && hoursSinceIngest > staleHours),
    stale_after_hours: staleHours,
    hours_since_ingest: hoursSinceIngest == null ? null : Math.round(hoursSinceIngest * 10) / 10,
    last_success_at: lastSuccess?.finished_at || null,
    last_success_source: lastSuccess?.source || null,
    last_success_actor: lastSuccess?.actor || null,
    last_success_label: lastSuccess?.label || null,
    last_success_counts: lastSuccess ? {
      rows_seen: lastSuccess.rows_seen, inserted: lastSuccess.inserted,
      updated: lastSuccess.updated, unchanged: lastSuccess.unchanged,
      errors: lastSuccess.errors, weak_identity: lastSuccess.weak_identity,
      skipped_stale: lastSuccess.skipped_stale, ambiguous_dates: lastSuccess.ambiguous_dates,
      expected_total: lastSuccess.expected_total ?? null,
      stored_total: lastSuccess.stored_total,
      delta: lastSuccess.expected_total == null ? null
        : Number(lastSuccess.stored_total) - Number(lastSuccess.expected_total),
    } : null,
    /** A run that FAILED after the last good one — the case where the page is
     *  quietly running on old data because the newest attempt threw. */
    last_run_failed: !!(lastRun && lastRun.status === 'error'),
    last_run_at: lastRun?.started_at || null,
    last_run_source: lastRun?.source || null,
    last_run_error: lastRun?.status === 'error' ? String(lastRun.error_text || '').slice(0, 400) : null,
    newest_review_at: newestReviewAt,
    days_since_newest_review: newestMs == null ? null : Math.floor((now - newestMs) / DAY_MS),
    /** How far the data we hold can honestly be said to reach, and why. This is
     *  what every `import_covers` on this payload is measured against. */
    coverage_end_at: coverage.end_at || null,
    coverage_basis: coverage.basis,
    coverage_note: coverage.note,
    /** Days between the end of coverage and now — the size of the blind spot.
     *  null when nothing is covered at all. */
    coverage_gap_days: coverageEndMs == null ? null : Math.max(0, Math.floor((now - coverageEndMs) / DAY_MS)),
    stored_total: totalStored,
    history_truncated: !!historyFrom,
    history_from: historyFrom || null,
    rows_loaded: rows.length,
    recent_runs: forThisLocation.slice(0, 6).map(r => ({
      id: r.id, source: r.source, status: r.status, actor: r.actor, label: r.label,
      started_at: r.started_at, finished_at: r.finished_at,
      inserted: r.inserted, updated: r.updated, unchanged: r.unchanged, errors: r.errors,
    })),
  };

  /* ── 4. Headline blocks. Straight off analysis.trend — no arithmetic here. ─ */

  const headlineFor = (p: PeriodKey, label: string) => {
    const t = analysis.trend[p];
    const cur = t.current;
    const prev = t.previous;
    const curStart = cur ? istDayStartMs(cur.start_date) : null;
    const prevStart = prev ? istDayStartMs(prev.start_date) : null;
    return {
      period: p,
      label,
      key: cur?.key || '',
      start_date: cur?.start_date || '',
      end_date: cur?.end_date || '',
      count: cur?.count ?? 0,
      average: cur?.average ?? null,
      low_count: cur?.low_count ?? 0,
      replied: cur?.replied ?? 0,
      prev_key: prev?.key || '',
      prev_start_date: prev?.start_date || '',
      prev_end_date: prev?.end_date || '',
      prev_count: prev?.count ?? 0,
      prev_average: prev?.average ?? null,
      count_delta: t.count_delta,
      count_pct: t.count_pct,
      avg_delta: t.avg_delta,
      direction: t.direction,
      // Does what we HOLD reach into this period? See coverageEndMs above —
      // this is the coverage of the DATA, not the timestamp of the run.
      import_covers: coverageEndMs != null && curStart != null && coverageEndMs >= curStart,
      prev_import_covers: coverageEndMs != null && prevStart != null && coverageEndMs >= prevStart,
    };
  };

  const headline = {
    today: headlineFor('daily', 'Today'),
    week: headlineFor('weekly', 'This week'),
    month: headlineFor('monthly', 'This month'),
    all_time: {
      total: analysis.summary.total,
      average: analysis.summary.average,
      first_at: analysis.summary.first_at,
      last_at: analysis.summary.last_at,
      distribution: analysis.summary.distribution,
      distribution_pct: analysis.summary.distribution_pct,
      low_count: analysis.summary.low_count,
      undated: analysis.summary.undated,
      // "All time" means all the history LOADED. When the cap bit, say so.
      complete: !historyFrom,
    },
  };

  /* ── 5. Chart series for the requested period. ──────────────────────────── */

  const series = analysis.series[period];
  const cap = full ? series.buckets.length : (CHART_POINTS[period] || 24);
  const shown = series.buckets.slice(-cap);

  /* ── 6. Major reviews — the engine's scored list, joined back to the text. ─ */

  const byId = new Map<string, ReviewRow>(rows.map(r => [r.id, r]));
  const decorate = (m: MajorReview) => {
    const row = byId.get(m.id);
    const ms = parseIsoMs(m.posted_at);
    return {
      id: m.id,
      rating: m.rating,
      posted_at: m.posted_at,
      posted_precision: row?.posted_precision || 'second',
      text: row?.text || '',
      text_len: m.text_len,
      author_name: row?.author_name || '',
      author_is_anonymous: !!row?.author_is_anonymous,
      language: row?.language || '',
      replied: m.replied,
      reply_text: row?.reply_text || '',
      replied_at: row?.replied_at || '',
      score: m.score,
      reasons: m.reasons,
      baseline: m.baseline,
      is_major: m.is_major,
      source: row?.source || '',
      // Which identity basis keyed this row. 'composite_anon' means an edit by
      // that (anonymous) author would land as a NEW row rather than updating
      // this one. The engine counts these; the page marks them.
      identity_basis: row?.identity_basis || '',
      day_key: ms == null ? '' : istDayKey(ms),
    };
  };

  // Major first, then by the score that made them major, then worst rating,
  // then newest. "Low ratings first" falls out of the score: 1 star scores 4,
  // 2 stars score 3, and nothing else reaches 4 on its own.
  const scored = [...analysis.major.reviews].sort((a, b) =>
    Number(b.is_major) - Number(a.is_major) ||
    b.score - a.score ||
    a.rating - b.rating ||
    (a.posted_at < b.posted_at ? 1 : a.posted_at > b.posted_at ? -1 : 0),
  );

  const listed = scored.slice(0, LIST_CAP).map(decorate);

  /* ── 7. Themes, at three spans, so "is this recent?" needs no round trip. ── */

  const spanRows = (days: number | null): AnalysisReview[] => {
    if (days == null) return analysisInput;
    const floor = now - days * DAY_MS;
    return analysisInput.filter(r => {
      const ms = parseIsoMs(r.posted_at);
      return ms != null && ms >= floor;
    });
  };
  const themeSpan = (days: number | null, label: string) => {
    const set = spanRows(days);
    const report = computeThemes(set);
    return {
      span_days: days,
      label,
      reviews_in_span: set.length,
      from: days == null ? analysis.summary.first_at : toIsoUtc(now - days * DAY_MS),
      ...report,
    };
  };

  const themes = {
    d90: themeSpan(90, 'Last 90 days'),
    d365: themeSpan(365, 'Last 12 months'),
    all: themeSpan(null, 'All history held'),
  };

  /* ── 8. Sources / import readiness. Admin-only: the GBP block carries the
   *      owner's prerequisite list, which is operational detail, and the
   *      import controls behind it are admin-gated on their own route. ────── */

  const isAdmin = me.role === 'admin';
  const link = replyLink(db);

  const locations = db.prepare(
    `SELECT location_key AS k, COUNT(*) AS n FROM gr_reviews GROUP BY location_key ORDER BY n DESC`,
  ).all() as Array<{ k: string; n: number }>;

  return Response.json({
    generated_at: nowIso,
    timezone: 'Asia/Kolkata',
    location_key: locationKey,
    locations,
    can_import: isAdmin,
    headline,
    summary: analysis.summary,
    series: {
      period,
      buckets: shown,
      shown: shown.length,
      total_buckets: series.buckets.length,
      hidden_older: Math.max(0, series.buckets.length - shown.length),
      engine_truncated: series.truncated,
    },
    alerts: analysis.alerts,
    major: {
      reviews: listed,
      listed: listed.length,
      total_scored: scored.length,
      major_count: analysis.major.major_count,
      truncated: scored.length > LIST_CAP,
      counts: analysis.major.counts,
      definition: analysis.major.definition,
      thresholds: analysis.major.thresholds,
    },
    themes,
    data_state: dataState,
    /**
     * THE CONNECTION, on the same fetch the page already makes.
     *
     * data_state above answers "how old is the data?" from the ingest runs.
     * This answers the different and more actionable question: "is anything
     * still arriving, and if not, why?" A page that shows only the first can
     * render a confident month-old report; the owner needs to see that the
     * Google connection stopped working on the 3rd.
     *
     * Not admin-gated. A manager reading this report MUST be able to tell a
     * quiet month from a broken connector — that is the difference between a
     * report and a misleading one. It carries no credential: see
     * connectionHealth(), which returns state, timings and counts only.
     */
    connection: connectionHealth(getConnection(db, locationKey), {
      hasApp: hasOauthApp(db),
      // Evidence that a scheduler is alive. Without it the health verdict is
      // 'no_driver' and the page stops promising a next fetch.
      driverTickAt: autoDriverTickAt(db),
    }),
    reply_link: link,
    caveats: analysis.caveats,
    sources: isAdmin ? sourceReadiness(db) : null,
  });
}
