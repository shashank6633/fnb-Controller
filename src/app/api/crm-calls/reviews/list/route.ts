import { getDb } from '@/lib/db';
import { getCurrentUser, isManagement } from '@/lib/auth';
import { analyzeReviews, type AnalysisReview, type ReviewRow } from '@/lib/reviews';
import { analysisWindow, loadHistory } from '@/lib/reviews/history';
import {
  isRangeKey, isThemeSpanKey, resolveRange, selectReviews, selectThemeReviews,
  type RangeKey, type RatingFilter, type ReplyFilter, type ScopeFilter, type SortOrder,
  type ThemeSpanKey,
} from '@/lib/reviews/listing';
import { istDayKey, parseIsoMs, toIsoUtc } from '@/lib/reviews/time';

/**
 * CRM — one filtered, sorted PAGE of the scored reviews
 * (GET /api/crm-calls/reviews/list). Management only, same gate as the report.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS ROUTE EXISTS: THE CLIENT CANNOT HONESTLY DO THIS FILTERING.
 * ══════════════════════════════════════════════════════════════════════════
 * /api/crm-calls/reviews caps its review list at 500 rows, chosen MAJOR-FIRST
 * BY SCORE out of a history that is ten thousand rows deep. That set is the
 * right 500 for "worst first", and the wrong 500 for anything else:
 *
 *   • "Oldest first" over it returns the oldest of the 500 highest-scoring
 *     reviews, which is not the oldest review and never was.
 *   • A date window over it returns the matching rows OF THAT SUBSET. Ask for
 *     March 2024 and you get however many of the top 500 happen to fall in
 *     March — a short, confident, wrong list with no hint that it is wrong.
 *
 * A wrong list is worse than a slow one, so the filter runs where all the rows
 * are. The page asks this route and renders what comes back; it does not filter
 * reviews client-side any more.
 *
 * ── THE SCORES HERE ARE THE REPORT'S SCORES, NOT A SECOND OPINION ───────────
 * `is_major` is a property of a review WITHIN A ROW SET, not of the review:
 * computeMajorReviews() compares each one with the trailing 90 days before it
 * and with the day keys computePeriodAlerts() flagged. So this route scores the
 * FULL history through the shared loadHistory() + analysisWindow() that the
 * report uses, and filters by date only AFTER scoring.
 *
 * Scoring a 30-day slice instead would recompute every baseline from that slice
 * and quietly hand back different badges from the ones in the header beside
 * them. That is the bug this comment exists to prevent someone "optimising"
 * their way into.
 *
 * ── THE ANCHOR IS THE CALLER'S ──────────────────────────────────────────────
 * `at` is the `generated_at` of the report already on the manager's screen. The
 * windows are measured from it so the theme drill-down reveals the rows the
 * theme table counted, rather than a set that shifted by however many seconds
 * passed between the two requests. It moves a window; it grants nothing, and it
 * is clamped to a week either side of the real clock.
 */

export const dynamic = 'force-dynamic';

/** Rows returned in one response. The page grows this when the manager asks for
 *  more, and renders exactly what comes back — no second cap up there — so the
 *  number on screen is always the number of rows on screen. `matched_total`
 *  travels with every response, so a capped page can never read as the whole
 *  result. The ceiling is a transport limit, not an answer: past it the page
 *  says how many it is not showing and offers a narrower span. */
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2_000;

/** How far `at` may sit from this server's clock. A stale tab is legitimate;
 *  a year-old anchor is not, and would silently re-date every window. */
const ANCHOR_SLACK_MS = 7 * 86_400_000;

function clampAnchor(raw: string, now: number): { ms: number; clamped: boolean } {
  const ms = raw ? parseIsoMs(raw) : null;
  if (ms == null) return { ms: now, clamped: false };
  if (ms > now + ANCHOR_SLACK_MS || ms < now - ANCHOR_SLACK_MS) return { ms: now, clamped: true };
  return { ms, clamped: false };
}

const RATINGS = new Set(['all', 'low', '1', '2', '3', '4', '5']);

export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not signed in' }, { status: 401 });
  if (!isManagement(me)) return Response.json({ error: 'Management only' }, { status: 403 });

  const sp = new URL(req.url).searchParams;
  const locationKey = (sp.get('location') || '').trim();

  const now = Date.now();
  const anchor = clampAnchor((sp.get('at') || '').trim(), now);
  const anchorMs = anchor.ms;

  const ratingRaw = (sp.get('rating') || 'all').trim();
  const rating: RatingFilter = (RATINGS.has(ratingRaw) ? ratingRaw : 'all') as RatingFilter;
  const replyRaw = (sp.get('reply') || 'all').trim();
  const reply: ReplyFilter = replyRaw === 'no' || replyRaw === 'yes' ? replyRaw : 'all';
  const scope: ScopeFilter = (sp.get('scope') || 'major').trim() === 'all' ? 'all' : 'major';
  const sort: SortOrder = (sp.get('sort') || 'newest').trim() === 'oldest' ? 'oldest' : 'newest';

  const rangeRaw = (sp.get('range') || 'd30').trim();
  const range: RangeKey = isRangeKey(rangeRaw) ? rangeRaw : 'd30';

  const themeKey = (sp.get('theme') || '').trim();
  const spanRaw = (sp.get('span') || 'd365').trim();
  const span: ThemeSpanKey = isThemeSpanKey(spanRaw) ? spanRaw : 'd365';
  const themeLow = sp.get('theme_low') === '1';

  const limit = (() => {
    const n = Number(sp.get('limit'));
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
    return Math.min(MAX_LIMIT, Math.floor(n));
  })();

  const db = getDb();

  /* ── The row universe and the scoring, both shared with the report. ─────── */

  const history = loadHistory(db, locationKey);
  const rows: ReviewRow[] = history.rows;
  const win = analysisWindow(rows, anchorMs);
  const analysis = analyzeReviews(rows as AnalysisReview[], {
    now: anchorMs, from: win.from, to: win.to,
  });

  const byId = new Map<string, ReviewRow>(rows.map(r => [r.id, r]));
  const scoredById = new Map(analysis.major.reviews.map(m => [m.id, m]));

  /** The card shape the page renders. Identical field-for-field to the report
   *  route's own decorate(), because the SAME component renders both and a card
   *  that silently lost its reason chips in one of the two places would read as
   *  a review that had no reasons. */
  const decorate = (m: {
    id: string; rating: number; posted_at: string; text_len: number;
    replied: boolean; score: number; reasons: string[];
    baseline: number | null; is_major: boolean;
  }) => {
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
      identity_basis: row?.identity_basis || '',
      day_key: ms == null ? '' : istDayKey(ms),
    };
  };

  const universe = {
    total_stored: history.total_stored,
    rows_loaded: rows.length,
    history_truncated: history.truncated,
    history_from: history.history_from,
    /** Every scored review, and the subset the attention rule reaches. Both are
     *  WHOLE-DATASET figures and stay whole-dataset whatever window is chosen —
     *  the page uses them to say what a narrowed list is a fraction OF. */
    total_scored: analysis.major.reviews.length,
    major_count: analysis.major.major_count,
  };

  const base = {
    ok: true,
    generated_at: toIsoUtc(now),
    /** The anchor actually used, and whether the caller's was rejected. */
    anchor_at: toIsoUtc(anchorMs),
    anchor_clamped: anchor.clamped,
    location_key: locationKey,
    limit,
    ...universe,
  };

  /* ── THEME DRILL-DOWN. A cell in "What guests mention" was clicked. ─────── */

  if (themeKey) {
    // The theme table counts over the SPAN ROWS, which for 'all' include
    // undated reviews — their text still mentions things. selectThemeReviews
    // reproduces that loop exactly; see its comment.
    const sel = selectThemeReviews(rows, themeKey, span, anchorMs, {
      low: themeLow, sort,
    });
    const page = sel.rows.slice(0, limit).map(r => {
      const m = scoredById.get(r.id);
      if (m) return decorate(m);
      // No scored entry means prepare() dropped this row for an unreadable
      // date. It is still counted by the 'all' theme span, so it is shown —
      // with no score and no reasons, which is what the engine says about a
      // review it cannot place in time, rather than a score invented here.
      // `replied` is hasReply()'s own test, not a looser one: a reply TIME with
      // no reply TEXT is not an answer.
      return decorate({
        id: r.id,
        rating: r.rating,
        posted_at: r.posted_at,
        text_len: r.text_len,
        replied: !!(r.reply_text && r.reply_text.trim()),
        score: 0,
        reasons: [],
        baseline: null,
        is_major: false,
      });
    });
    return Response.json({
      ...base,
      mode: 'theme',
      theme: themeKey,
      span,
      theme_low: themeLow,
      sort,
      /** The rows the clicked cell counts, and the MENTIONS total behind them.
       *  The page compares these with the cell it rendered and says so if they
       *  differ, rather than quietly showing a shorter list. */
      matched_total: sel.matched_total,
      theme_total: sel.theme_total,
      reviews: page,
      listed: page.length,
      truncated: sel.matched_total > page.length,
    });
  }

  /* ── THE ATTENTION LIST. ───────────────────────────────────────────────── */

  const window = resolveRange(range, anchorMs, {
    from: (sp.get('from') || '').trim(),
    to: (sp.get('to') || '').trim(),
  });

  // Filtered on the SCORED rows themselves — the text lives on the row and is
  // attached by decorate() only for the rows that survive the filter.
  const sel = selectReviews(analysis.major.reviews, window, { rating, reply, scope }, sort);
  const page = sel.rows.slice(0, limit).map(decorate);

  return Response.json({
    ...base,
    mode: 'list',
    window,
    filters: { rating, reply, scope, sort, range },
    /** Exact, over every row held — not over the page below it. */
    matched_total: sel.matched_total,
    /** What the WINDOW alone excluded. `older_outside` is the number the screen
     *  is required to print beside a narrowed default, because a list that
     *  hides 5,000 rows without saying so reads as "this is everything". */
    older_outside: sel.older_outside,
    newer_outside: sel.newer_outside,
    /** Structurally 0 here: computeMajorReviews() scores only rows it can date,
     *  so an undated review never reaches this filter. It is reported anyway
     *  rather than assumed — summary.undated on the report is where the owner
     *  sees how many exist. */
    undated_outside: sel.undated_outside,
    /** Rows passing SCOPE alone — what the window and the rating/reply chips
     *  are a fraction of. */
    scope_total: sel.scope_total,
    reviews: page,
    listed: page.length,
    truncated: sel.matched_total > page.length,
  });
}
