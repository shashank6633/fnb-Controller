'use client';

/**
 * CRM — Google Reviews (/crm-calls/reviews). Management only; import is admin.
 *
 * ── THE RULE THIS PAGE EXISTS TO ENFORCE ────────────────────────────────────
 * An empty week and an unimported week look identical, and reading the second
 * as the first is how a venue tells itself "no complaints this week" about a
 * week it never looked at. So:
 *
 *   • The data-state strip is the FIRST thing under the title, before a single
 *     number, and it is never collapsed away. It says when reviews were last
 *     imported, by which route, by whom, and what that import actually did.
 *   • Every headline tile carries `import_covers` from the API. A period with
 *     zero reviews that the last import did not even reach does not say "no
 *     reviews" — it says NOT IMPORTED, in a different colour, with the date of
 *     the last import next to it.
 *   • An average of null is never rendered as 0.0. No reviews means no rating;
 *     0.0 stars would read as the worst month the venue has ever had.
 *
 * ── EVERY NUMBER HERE IS THE ENGINE'S ───────────────────────────────────────
 * This file does no averaging, bucketing or scoring. It formats what
 * /api/crm-calls/reviews returns, which is what src/lib/reviews computed. The
 * only arithmetic below is turning a 0..1 share into a percentage for display.
 * Keep it that way: the engine has a 112-case suite pinned to hand-computed
 * numbers, and a second implementation up here would be untested by all of it.
 *
 * ── THE MAJOR LIST IS ARGUABLE ON PURPOSE ───────────────────────────────────
 * Every row shows the reasons that put it there and the score they add to, and
 * the rule is printed in full under "How this list is chosen". A manager who
 * disagrees with a row can see exactly which clause caught it. Do not replace
 * that with a tidy badge that hides the rule.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Star, StarHalf, MessageSquare, RefreshCw, Lock, Info, ChevronLeft, AlertTriangle,
  CheckCircle2, Loader2, TrendingUp, TrendingDown, Minus, ExternalLink, Copy, Check,
  Upload, Database, Clock, Tag, CloudDownload, X, Link2, Power, PlugZap, MapPin, ShieldAlert,
  Send, Sparkles, Eye, Globe, Pencil,
} from 'lucide-react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
/* Pure view decisions, gated in scripts/reviews-tests.js (sections V–W).
 * Imported from the leaf module, NOT from '@/lib/reviews' — the index pulls in
 * better-sqlite3, which cannot be bundled into a client component. view.ts
 * carries a type-only import of ConnectionHealth, so nothing follows it here. */
import {
  agoText, connectionBanner, fmtIst, intervalText, nextFetchText, periodProgress, periodTileView,
} from '@/lib/reviews/view';
import type { ConnectionHealth } from '@/lib/reviews/connection';
/* CHECK 2 OF 3, running in the browser for the live counter and instant
 * findings. Imported from the leaf module for the same reason view.ts is: it
 * imports only gbp-transport.ts, which imports NOTHING and touches no Node
 * global, so nothing follows it into the client bundle. It is the SAME function
 * the send route runs — one implementation, so what an admin reads here cannot
 * drift from what the server enforces. The server is still the authority: the
 * route re-runs it and refuses on its own verdict. */
import { replyBytes, validateReply, type ReplyFinding } from '@/lib/reviews/reply-validate';
/* Every state-changing request MUST go through api(): middleware rejects a
 * POST/PUT/PATCH/DELETE without the X-CSRF-Token header read from the fnb_csrf
 * cookie. A raw fetch() here fails with "CSRF token missing or mismatched"
 * and no amount of retrying helps. */
import { api } from '@/lib/api';

/* ── Types (mirror the API response) ───────────────────────────────────────── */

type Dist = { 1: number; 2: number; 3: number; 4: number; 5: number };

interface HeadBlock {
  period: 'daily' | 'weekly' | 'monthly';
  label: string;
  key: string; start_date: string; end_date: string;
  count: number; average: number | null; low_count: number; replied: number;
  prev_key: string; prev_start_date: string; prev_end_date: string;
  prev_count: number; prev_average: number | null;
  count_delta: number | null; count_pct: number | null; avg_delta: number | null;
  direction: 'up' | 'down' | 'flat' | 'unknown';
  import_covers: boolean; prev_import_covers: boolean;
}

interface Bucket {
  key: string; start_date: string; end_date: string;
  count: number; average: number | null; distribution: Dist;
  low_count: number; long_count: number; replied: number; reply_rate: number | null;
}

interface ReviewCard {
  id: string; rating: number; posted_at: string; posted_precision: string;
  text: string; text_len: number; author_name: string; author_is_anonymous: boolean;
  language: string; replied: boolean; reply_text: string; replied_at: string;
  score: number; reasons: string[]; baseline: number | null; is_major: boolean;
  source: string; identity_basis: string; day_key: string;
}

interface ThemeTally {
  key: string; label: string; count: number;
  share_of_text_reviews: number | null; average_rating: number | null;
  low_count: number; sample_ids: string[]; top_terms: Array<{ term: string; count: number }>;
}
interface ThemeSpan {
  span_days: number | null; label: string; reviews_in_span: number; from: string | null;
  method: string; disclaimer: string; themes: ThemeTally[];
  text_reviews: number; unmatched: number; rules_used: number;
}

interface DataState {
  never_ingested: boolean; stale: boolean; stale_after_hours: number;
  hours_since_ingest: number | null;
  last_success_at: string | null; last_success_source: string | null;
  last_success_actor: string | null; last_success_label: string | null;
  last_success_counts: {
    rows_seen: number; inserted: number; updated: number; unchanged: number;
    errors: number; weak_identity: number; skipped_stale: number; ambiguous_dates: number;
    expected_total: number | null; stored_total: number; delta: number | null;
  } | null;
  last_run_failed: boolean; last_run_at: string | null; last_run_source: string | null;
  last_run_error: string | null;
  newest_review_at: string | null; days_since_newest_review: number | null;
  /** How far the loaded data can honestly be said to reach, and why. Every
   *  `import_covers` on the payload is measured against coverage_end_at, NOT
   *  against when the import ran. */
  coverage_end_at: string | null;
  coverage_basis: 'never_imported' | 'fetched_from_google' | 'newest_review_in_file' | 'file_held_nothing';
  coverage_note: string;
  coverage_gap_days: number | null;
  stored_total: number; history_truncated: boolean; history_from: string | null;
  rows_loaded: number;
  recent_runs: Array<{
    id: string; source: string; status: string; actor: string; label: string;
    started_at: string; finished_at: string;
    inserted: number; updated: number; unchanged: number; errors: number;
  }>;
}

interface SourceStatusRow {
  key: string; label: string; kind: 'manual' | 'api';
  ready: boolean; reason: string; prerequisites: string[]; unproven: string[];
}

interface Report {
  generated_at: string; timezone: string; location_key: string;
  locations: Array<{ k: string; n: number }>;
  can_import: boolean;
  /** May this session publish a reply on the public Google listing. Admin only,
   *  and the send route re-checks it — this decides what is DRAWN, nothing more.
   *  A manager sees every review and no reply box. */
  can_reply: boolean;
  headline: {
    today: HeadBlock; week: HeadBlock; month: HeadBlock;
    all_time: {
      total: number; average: number | null; first_at: string | null; last_at: string | null;
      distribution: Dist; distribution_pct: Dist; low_count: number; undated: number;
      complete: boolean;
    };
  };
  summary: {
    total: number; undated: number; average: number | null;
    distribution: Dist; distribution_pct: Dist;
    low_count: number; long_count: number; with_text: number; without_text: number;
    reply: {
      replied: number; unreplied: number; reply_rate: number | null; overdue: number;
      oldest_unanswered_hours: number | null; timed: number;
      median_hours: number | null; mean_hours: number | null; p90_hours: number | null;
      within_24h: number; within_72h: number;
    };
    languages: Array<{ code: string; count: number }>;
  };
  series: {
    period: 'daily' | 'weekly' | 'monthly'; buckets: Bucket[];
    shown: number; total_buckets: number; hidden_older: number; engine_truncated: boolean;
  };
  alerts: Array<{
    key: string; kind: 'rating_drop' | 'volume_spike'; detail: string;
    current: number; baseline: number; baseline_buckets: number; baseline_reviews: number;
  }>;
  major: {
    reviews: ReviewCard[]; listed: number; total_scored: number; major_count: number;
    truncated: boolean; counts: Record<string, number>; definition: string[];
    thresholds: Record<string, number>;
  };
  themes: { d90: ThemeSpan; d365: ThemeSpan; all: ThemeSpan };
  data_state: DataState;
  /** Health of the automatic connector, on the same fetch as the report. NOT
   *  admin-gated: a manager must be able to tell a quiet month from a broken
   *  connector, which is the whole difference between a report and a
   *  misleading one. Carries state and timings only, never a credential. */
  connection: ConnectionHealth;
  reply_link: { url: string; kind: 'place_id' | 'custom' | 'none'; note: string };
  caveats: string[];
  sources: SourceStatusRow[] | null;
}

/* ── Connection detail (GET /api/crm-calls/reviews/connect) ─────────────────
 * A second, smaller fetch. The report above carries the HEALTH — enough to
 * render the banner and decide whether the numbers are trustworthy. This adds
 * the setup detail only an admin may see, and only an admin's panel requests. */

interface ConnectionDetail {
  health: ConnectionHealth;
  connection: {
    status: 'disconnected' | 'connected' | 'needs_reconnect';
    google_email: string;
    location_name: string; location_label: string; location_address: string;
    connected_at: string; connected_by: string;
    last_attempt_at: string; last_success_at: string;
    last_error: string; last_error_at: string;
    consecutive_failures: number;
    auto_enabled: boolean; interval_minutes: number; last_auto_run_at: string;
  };
  /** Admin only; null for a manager. Presence flags and public values only —
   *  the client secret and refresh token never leave the server. */
  setup: {
    oauth_app_configured: boolean;
    client_id: string;
    client_secret_set: boolean;
    refresh_token_set: boolean;
    redirect_uri: string;
    callback_path: string;
    prerequisites: string[];
    unproven: string[];
    interval_bounds: { min: number; max: number; default: number };
  } | null;
}

/* ── One filtered page of the scored reviews (GET …/reviews/list) ────────────
 *
 * WHY THE LIST IS A SECOND FETCH AND NOT A FILTER OVER `major.reviews`.
 * The report above caps its review list at 500 rows chosen MAJOR-FIRST BY SCORE
 * out of a history ten thousand deep. Those are the right 500 for "worst first"
 * and the wrong 500 for every other question:
 *
 *   • "Oldest first" over them returns the oldest of the 500 highest-scoring
 *     reviews — not the oldest review, and never was.
 *   • A date window over them returns whichever of the top 500 happen to fall
 *     inside it: a short, confident, WRONG list with nothing on screen to hint
 *     that thousands of matching reviews were never in the browser.
 *
 * So the date window, the sort and the theme drill-down all ask the server,
 * which filters where all the rows are and sends the exact totals back. When
 * that fetch fails this page shows the failure. It does NOT fall back to
 * filtering the 500 it happens to hold — a wrong list is worse than no list.
 */

interface ListWindow {
  kind: RangeKey;
  from_ms: number | null; to_ms: number | null;
  from: string | null; to: string | null;
  /** Printed verbatim: the control and the rows must not disagree about what
   *  was ranged over. */
  label: string;
  unbounded: boolean;
}

interface ListBase {
  ok: true;
  generated_at: string;
  anchor_at: string;
  /** The server rejected our anchor as too far from its own clock. */
  anchor_clamped: boolean;
  location_key: string;
  limit: number;
  total_stored: number; rows_loaded: number;
  history_truncated: boolean; history_from: string | null;
  /** WHOLE-DATASET figures. They do not move when the window narrows. */
  total_scored: number; major_count: number;
  reviews: ReviewCard[]; listed: number; truncated: boolean;
  matched_total: number;
}

interface ListPage extends ListBase {
  mode: 'list';
  window: ListWindow;
  filters: { rating: RatingFilter; reply: AnsweredFilter; scope: 'major' | 'all'; sort: SortOrder; range: RangeKey };
  /** What the DATE WINDOW alone excluded. `older_outside` is the number a
   *  narrowed default is required to print: a list that hides 5,000 rows
   *  without saying so reads as "this is everything". */
  older_outside: number; newer_outside: number; undated_outside: number;
  /** Rows passing SCOPE alone — what the window and the chips are a part of. */
  scope_total: number;
}

interface ThemePage extends ListBase {
  mode: 'theme';
  theme: string;
  span: ThemeSpanKey;
  theme_low: boolean;
  /** The MENTIONS total behind the rows. Compared on screen with the cell that
   *  was clicked, because a drill-down that disagrees with its own row makes the
   *  table's number look wrong. */
  theme_total: number;
}

/** accounts/{a}/locations/{l} — the string a pull actually needs. */
interface GbpLocationRow { name: string; label: string; address: string; storeCode: string }
interface GbpAccountRow { name: string; label: string; type: string; locations: GbpLocationRow[] }

/** The outcome of a manual "Refresh now", kept in the three shapes the route
 *  actually distinguishes rather than collapsed into one "it failed". */
interface RefreshOutcome {
  tone: 'ok' | 'error';
  message: string;
  detail?: string;
  /** 409 + needs_reconnect: terminal until a human re-authorises. */
  needsReconnect?: boolean;
  /** 409 + prerequisites: Google's approval process, not a fault here. */
  prerequisites?: string[];
  /**
   * ERROR OUTCOMES ONLY. The value of `connection.last_success_at` as the SERVER
   * reported it at the instant this failure was raised, in milliseconds — the
   * marker a later success has to pass before this banner may be retired.
   *
   * It is the server's own success clock and nothing else. Using the browser's
   * clock, or `generated_at` from a report that may have been loaded hours
   * earlier, would let a success that happened BEFORE the error retire it, which
   * hides a live failure — the opposite mistake and the worse one.
   *
   * null/undefined means the reply carried no health (the 401 from the proxy or
   * from this route's own admin check, or a body that did not parse). Then there
   * is no marker, and the banner stays until it is dismissed by hand: a stale
   * error is bad, but inventing a success that was never reported is worse.
   */
  successBaselineMs?: number | null;
  ingest?: {
    rows_seen: number; inserted: number; updated: number; unchanged: number;
    skipped_stale: number; errors: number; weak_identity: number;
    /** Pages of Google's reply that could not be read in full. Non-zero means
     *  the pull FAILED; the counts beside it are incomplete. */
    fatal_documents?: number;
  };
}

/* ── Formatting ────────────────────────────────────────────────────────────── */

const IST = 'Asia/Kolkata';

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST, day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(ms));
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST, day: 'numeric', month: 'short', year: 'numeric',
  }).format(new Date(ms));
}

/** A YYYY-MM-DD IST calendar date, printed without pretending to a clock time. */
function fmtDayKey(day: string, opts: { year?: boolean } = {}): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return day || '—';
  const d = new Date(`${day}T12:00:00Z`);
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'UTC', day: 'numeric', month: 'short',
    ...(opts.year === false ? {} : { year: 'numeric' }),
  }).format(d);
}

function fmtAgo(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) return 'never';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min ago`;
  if (hours < 48) return `${Math.round(hours)} h ago`;
  const d = Math.round(hours / 24);
  if (d < 60) return `${d} day${d === 1 ? '' : 's'} ago`;
  return `${Math.round(d / 30)} months ago`;
}

const SOURCE_LABEL: Record<string, string> = {
  takeout_json: 'Google Takeout export',
  csv: 'CSV / spreadsheet upload',
  paste: 'Pasted text',
  gbp_api: 'Business Profile API',
};

const REASON_LABEL: Record<string, string> = {
  low_rating: 'Low rating',
  three_star: '3 stars',
  unanswered: 'Unanswered — a reply is owed',
  unanswered_positive: 'Unanswered thank-you',
  long_detailed: 'Long and detailed',
  below_norm: 'Below our own average',
  in_alert_period: 'In a flagged period',
};

/* ── Page ──────────────────────────────────────────────────────────────────── */

type PeriodKey = 'daily' | 'weekly' | 'monthly';
type RatingFilter = 'all' | 'low' | '1' | '2' | '3' | '4' | '5';
type AnsweredFilter = 'all' | 'no' | 'yes';
type ThemeSpanKey = 'd90' | 'd365' | 'all';
/** The date window for "Reviews that need attention". Resolved SERVER-SIDE so
 *  "today" means an IST calendar day and not the browser's idea of one. */
type RangeKey = 'today' | 'd7' | 'd30' | 'd90' | 'all' | 'custom';
type SortOrder = 'newest' | 'oldest';

/**
 * THE DEFAULT WINDOW IS THE LAST 30 DAYS, AND THAT IS A DELIBERATE NARROWING.
 *
 * The owner's instruction: "from now dont show all the unanswered to answer
 * right now but for the past 1 month it can show and leave the before ones."
 * There are thousands of unanswered reviews going back years. A list of 5,564 is
 * not a work queue, it is a wall, and a wall gets abandoned.
 *
 * NOTHING IS DELETED OR EXCLUDED FROM THE DATA. The older reviews are one chip
 * away, every whole-dataset figure on this page still counts them, and the list
 * is REQUIRED to print how many it is not showing — see the band rendered from
 * `older_outside`. A silently narrowed list reads as "this is everything", which
 * is the same lie as an unimported week reading as a quiet one, and this page
 * exists to refuse that.
 */
const DEFAULT_RANGE: RangeKey = 'd30';

/** Rows asked for at first, and the step each "show more" adds. The page renders
 *  exactly what the server returns — there is no second cap up here — so the
 *  count on screen is always the number of cards on screen. */
const LIST_PAGE = 200;
const LIST_STEP = 500;
/** Matches MAX_LIMIT in /api/crm-calls/reviews/list. A transport ceiling, not an
 *  answer: past it the page says how many it is not showing. */
const LIST_MAX = 2000;

export default function ReviewsPage() {
  const [period, setPeriod] = useState<PeriodKey>('monthly');
  const [fullSeries, setFullSeries] = useState(false);
  const [data, setData] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const [ratingFilter, setRatingFilter] = useState<RatingFilter>('all');
  const [answeredFilter, setAnsweredFilter] = useState<AnsweredFilter>('all');
  const [majorOnly, setMajorOnly] = useState(true);
  const [showRule, setShowRule] = useState(false);
  const [themeSpan, setThemeSpan] = useState<ThemeSpanKey>('d365');
  const [showImport, setShowImport] = useState(false);

  /* The attention list's own controls. These do NOT filter anything in the
   * browser — they are query parameters for …/reviews/list, which filters where
   * all ten thousand rows are. See the ListPage comment above. */
  const [dateRange, setDateRange] = useState<RangeKey>(DEFAULT_RANGE);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest');
  const [listLimit, setListLimit] = useState(LIST_PAGE);
  const [list, setList] = useState<ListPage | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  /** Which theme cell in "What guests mention" is expanded, and whether the
   *  1-2★ column was the one clicked. */
  const [openTheme, setOpenTheme] = useState<{ key: string; low: boolean } | null>(null);
  const [drill, setDrill] = useState<ThemePage | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);
  const [drillError, setDrillError] = useState<string | null>(null);

  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState<RefreshOutcome | null>(null);

  const fetchSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setFetching(true);
    setError(null);
    try {
      const sp = new URLSearchParams({ period });
      if (fullSeries) sp.set('full', '1');
      const res = await fetch(`/api/crm-calls/reviews?${sp.toString()}`);
      if (seq !== fetchSeq.current) return;
      if (res.status === 403) { setForbidden(true); setData(null); return; }
      const json = await res.json().catch(() => ({}));
      if (seq !== fetchSeq.current) return;
      if (!res.ok) { setError(json?.error || `Couldn’t load the report (HTTP ${res.status})`); return; }
      setForbidden(false);
      setData(json as Report);
    } catch {
      if (seq === fetchSeq.current) setError('Couldn’t load the report');
    } finally {
      if (seq === fetchSeq.current) { setFetching(false); setLoading(false); }
    }
  }, [period, fullSeries]);

  useEffect(() => { load(); }, [load]);

  /**
   * "Refresh now" — the manual pull, always available to an admin.
   *
   * The three failure shapes the route distinguishes are kept distinct here on
   * purpose. A 409 with `needs_reconnect` is not a retryable error: nothing in
   * this app is broken and pressing the button again cannot help. A 409 with
   * `prerequisites` is paperwork Google has not finished. Only a 502 is worth
   * retrying. Flattening the three into "refresh failed" is how an owner spends
   * a week re-pressing a button that can never work.
   */
  const refreshNow = useCallback(async () => {
    setRefreshing(true);
    setRefreshResult(null);
    try {
      const res = await api('/api/crm-calls/reviews/refresh', { method: 'POST' });
      const json = await res.json().catch(() => ({} as Record<string, unknown>));

      if (res.ok) {
        const ing = (json as { ingest?: RefreshOutcome['ingest'] }).ingest;
        setRefreshResult({
          tone: 'ok',
          message: ing
            ? `Fetched from Google: ${ing.inserted} new, ${ing.updated} changed, ${ing.unchanged} already known.`
            : 'Fetched from Google.',
          detail: typeof (json as { pages?: number }).pages === 'number'
            ? `${(json as { pages: number }).pages} page${(json as { pages: number }).pages === 1 ? '' : 's'} read.`
            : '',
          ingest: ing,
        });
        await load();
        return;
      }

      const err = String((json as { error?: string }).error || `HTTP ${res.status}`);
      const needsReconnect = !!(json as { needs_reconnect?: boolean }).needs_reconnect;
      // Every failing branch of the refresh route returns fresh `health` beside
      // its error; the page used to throw it away. Its last_success_at is the
      // marker that lets a LATER success retire this banner — see
      // successBaselineMs, and visibleRefreshResult below.
      const health = (json as { health?: { last_success_at?: string } }).health;
      setRefreshResult({
        tone: 'error',
        message: err,
        needsReconnect,
        prerequisites: (json as { prerequisites?: string[] }).prerequisites || [],
        // A 409 is TWO states, and one blanket "not retryable" line was wrong
        // about one of them. A refused refresh token really is terminal. A
        // prerequisites 409 is a setup or approval state on Google's side whose
        // own message now says which one and where it is fixed — asserting
        // non-retryability over the top of it contradicted the message above it.
        detail: res.status === 409
          ? (needsReconnect
            ? 'This is not a retryable error — the connection has to be re-authorised before any fetch can work.'
            : 'This is a setup or approval state on Google’s side, not a fault in this app. The message above says which one, and where it is fixed.')
          : res.status === 401
            ? 'Only an admin can run a manual fetch.'
            : 'Google could not be reached, or answered with an error. This one is worth retrying.',
        successBaselineMs: health
          // '' / missing => never succeeded => 0, which is the true baseline:
          // the first success of all time then passes it.
          ? (Date.parse(String(health.last_success_at || '')) || 0)
          : null,
      });
      // The health on the page is now out of date whatever happened.
      await load();
    } catch {
      // Our own server was unreachable, so nothing reported a success marker.
      // No marker => this one is cleared by hand only.
      setRefreshResult({
        tone: 'error',
        message: 'Couldn’t reach the server to start a fetch.',
        detail: '',
        successBaselineMs: null,
      });
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  /**
   * A SUCCESSFUL FETCH RETIRES A PREVIOUS FAILURE.
   *
   * The failure banner used to be cleared by exactly two things: pressing
   * Refresh again, and pressing its own ×. Nothing else — not a period change,
   * not a reconnect, and above all not the hourly automatic pull — so one
   * transient 504 sat on screen for hours next to "LAST FETCH 1 minute ago" and
   * the two halves of the same panel contradicted each other. The server had
   * already retired the failure (recordSuccess clears last_error and zeroes the
   * failure streak, which is why the "N consecutive failed fetches" line
   * correctly vanished while this banner did not).
   *
   * The rule, stated plainly: a failure is hidden once the server reports a
   * success STRICTLY NEWER than the one that stood when the failure was raised.
   *
   *   · A success that lands after the error retires it — manual or automatic,
   *     visible at the next load() the page performs.
   *   · A real, ongoing failure stays. The load() that runs immediately after a
   *     failed refresh re-reads the same unchanged last_success_at, so the
   *     baseline and the current value are equal and the banner holds. Nothing
   *     here is time-based and nothing auto-dismisses.
   *   · No marker (no health on the reply) => the banner is never hidden by this
   *     rule at all; it waits for the ×, exactly as before.
   *
   * Derived rather than cleared with an effect: the state stays the record of
   * WHAT failed, and what is computed is only whether it is still true.
   */
  const visibleRefreshResult = useMemo(() => {
    if (!refreshResult || refreshResult.tone !== 'error') return refreshResult;
    const baseline = refreshResult.successBaselineMs;
    if (baseline === null || baseline === undefined) return refreshResult;
    const latestSuccess = Date.parse(data?.connection.last_success_at || '');
    if (Number.isFinite(latestSuccess) && latestSuccess > baseline) return null;
    return refreshResult;
  }, [refreshResult, data]);

  const banner = useMemo(
    () => (data ? connectionBanner(data.connection) : null),
    [data],
  );

  const chartData = useMemo(() => {
    if (!data) return [];
    const nowMs = Date.parse(data.generated_at);
    return data.series.buckets.map(b => {
      // The last bar of a live series is a PART period — ten days of a month
      // standing beside three full ones. Unmarked it reads as a cliff that does
      // not exist, which is the same lie the headline tiles used to tell.
      const prog = periodProgress(
        { period: data.series.period, start_date: b.start_date, end_date: b.end_date },
        { now: Number.isFinite(nowMs) ? nowMs : undefined },
      );
      const base = data.series.period === 'monthly'
        ? fmtDayKey(b.start_date).replace(/^\d+\s/, '')
        : fmtDayKey(b.start_date, { year: false });
      return { ...b, partial: prog.partial, progress_text: prog.text, label: prog.partial ? `${base} *` : base };
    });
  }, [data]);

  /** The server's clock, not the browser's — a laptop set to yesterday must not
   *  decide whether "today" is still running. */
  const generatedMs = useMemo(() => {
    const ms = data ? Date.parse(data.generated_at) : NaN;
    return Number.isFinite(ms) ? ms : undefined;
  }, [data]);

  const partialBar = useMemo(
    () => chartData.find(b => (b as { partial?: boolean }).partial) as
      { key: string; progress_text: string; count: number } | undefined,
    [chartData],
  );

  /**
   * THE ATTENTION LIST, FETCHED RATHER THAN FILTERED.
   *
   * This used to be a useMemo filtering `data.major.reviews` in the browser. It
   * cannot be one any more, and the reason is the 500-row cap on that array:
   * those 500 are the top of a SCORE ranking over ten thousand rows, so a date
   * window or an oldest-first sort applied to them answers a different question
   * than the one asked and looks completely certain doing it. The filter goes
   * where the rows are.
   *
   * `at` carries the report's own generated_at, so the window the server
   * resolves is measured from the same instant as every other number the
   * manager is looking at.
   */
  const listSeq = useRef(0);

  const loadList = useCallback(async () => {
    if (!data) return;
    const seq = ++listSeq.current;
    setListLoading(true);
    setListError(null);
    try {
      const sp = new URLSearchParams({
        at: data.generated_at,
        location: data.location_key,
        rating: ratingFilter,
        reply: answeredFilter,
        scope: majorOnly ? 'major' : 'all',
        sort: sortOrder,
        range: dateRange,
        limit: String(listLimit),
      });
      if (dateRange === 'custom') {
        if (customFrom) sp.set('from', customFrom);
        if (customTo) sp.set('to', customTo);
      }
      const res = await fetch(`/api/crm-calls/reviews/list?${sp.toString()}`);
      if (seq !== listSeq.current) return;
      const json = await res.json().catch(() => ({}));
      if (seq !== listSeq.current) return;
      if (!res.ok) {
        // NO FALLBACK to filtering the 500 rows we hold. That would produce a
        // plausible, confident, wrong list. An error is the honest output.
        setListError(json?.error || `Couldn’t load the list (HTTP ${res.status})`);
        setList(null);
        return;
      }
      setList(json as ListPage);
    } catch {
      if (seq === listSeq.current) { setListError('Couldn’t load the list'); setList(null); }
    } finally {
      if (seq === listSeq.current) setListLoading(false);
    }
  }, [data, ratingFilter, answeredFilter, majorOnly, sortOrder, dateRange, customFrom, customTo, listLimit]);

  useEffect(() => { loadList(); }, [loadList]);

  /** Narrowing or re-ordering starts a new question, so the "show more" growth
   *  resets with it. Without this, changing one chip re-requests whatever large
   *  limit the last question had grown to. */
  const refine = useCallback((apply: () => void) => {
    apply();
    setListLimit(LIST_PAGE);
  }, []);

  /**
   * THE THEME DRILL-DOWN.
   *
   * Keyed on the span as well as the clicked cell, so the rows revealed are
   * always the rows the visible table counted. The theme table's numbers are
   * computed over `now - days * 86400000` from the report's own clock; the
   * server reproduces that arithmetic from the `at` we send, which is why
   * `theme_total` comes back and can be compared with the cell that was
   * clicked instead of the agreement merely being hoped for.
   */
  useEffect(() => {
    if (!openTheme || !data) { setDrill(null); setDrillError(null); return; }
    let alive = true;
    // Dropped, not kept, while the new one loads. Changing the span changes the
    // table's counts AND this list; holding the previous span's rows against the
    // new span's number would flash the "these disagree" warning at a
    // disagreement that does not exist.
    setDrill(null);
    setDrillLoading(true);
    setDrillError(null);
    (async () => {
      try {
        const sp = new URLSearchParams({
          at: data.generated_at,
          location: data.location_key,
          theme: openTheme.key,
          span: themeSpan,
          sort: 'newest',
          limit: String(LIST_MAX),
        });
        if (openTheme.low) sp.set('theme_low', '1');
        const res = await fetch(`/api/crm-calls/reviews/list?${sp.toString()}`);
        const json = await res.json().catch(() => ({}));
        if (!alive) return;
        if (!res.ok) {
          setDrillError(json?.error || `Couldn’t load those reviews (HTTP ${res.status})`);
          setDrill(null);
          return;
        }
        setDrill(json as ThemePage);
      } catch {
        if (alive) { setDrillError('Couldn’t load those reviews'); setDrill(null); }
      } finally {
        if (alive) setDrillLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [openTheme, themeSpan, data]);

  if (forbidden) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] flex items-center justify-center p-6">
        <div className="max-w-sm text-center text-[#6B5744]">
          <Lock className="w-10 h-10 mx-auto mb-3 text-[#af4408]" />
          <h1 className="text-lg font-bold text-[#2D1B0E]">Management only</h1>
          <p className="text-sm mt-1">
            The reviews report is restricted to managers, HODs and admins. The reviews themselves are
            public on Google; this page is the venue’s own scoreboard built from them.
          </p>
          <Link href="/crm-calls" className="inline-block mt-4 text-sm font-semibold text-[#af4408] hover:underline">
            Back to CRM
          </Link>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] p-6 animate-pulse">
        <div className="max-w-7xl mx-auto space-y-6">
          <div className="h-9 w-72 bg-[#FFF1E3] rounded-lg" />
          <div className="h-16 w-full bg-[#FFF1E3] rounded-xl" />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[...Array(4)].map((_, i) => <div key={i} className="h-28 bg-white border border-[#E8D5C4] rounded-xl" />)}
          </div>
          <div className="h-72 bg-white border border-[#E8D5C4] rounded-xl" />
        </div>
      </div>
    );
  }

  const ds = data?.data_state;
  const themes = data ? data.themes[themeSpan] : null;

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 py-5 sm:py-6 space-y-4">

        {/* Header */}
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-3">
          <div>
            <Link href="/crm-calls" className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider hover:text-[#af4408]">
              <ChevronLeft className="w-3.5 h-3.5" />CRM — Call-to-Table
            </Link>
            <h1 className="text-2xl sm:text-3xl font-bold mt-0.5 flex items-center gap-2.5">
              <Star className="w-7 h-7 text-[#af4408]" />
              Google Reviews
            </h1>
            <p className="text-sm text-[#8B7355] mt-1">
              What guests are saying publicly, which reviews still need a reply, and when this page was last told the truth.
            </p>
          </div>
          {/* Action bar. The hierarchy here is the point: getting reviews to
              ARRIVE is the primary act, so Connect / Refresh now is the solid
              button. Importing a file is the backfill and the fallback — real,
              permanent, and deliberately quieter. */}
          <div className="flex flex-wrap items-center gap-2 self-start">
            {banner?.cta === 'connect' || banner?.cta === 'reconnect' ? (
              data?.can_import ? (
                <a
                  href="#connection"
                  className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold shadow-sm transition-colors text-white ${
                    banner.loud ? 'bg-red-700 hover:bg-red-800' : 'bg-[#af4408] hover:bg-[#963a06]'
                  }`}
                >
                  <PlugZap className="w-4 h-4" />
                  {banner.ctaLabel}
                </a>
              ) : null
            ) : data?.can_import && data.connection.connected ? (
              <button
                onClick={refreshNow}
                disabled={refreshing}
                className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#963a06] disabled:opacity-60 text-white rounded-xl text-sm font-semibold shadow-sm transition-colors"
              >
                {refreshing ? <Loader2 className="w-4 h-4 animate-spin" /> : <CloudDownload className="w-4 h-4" />}
                {refreshing ? 'Fetching from Google…' : 'Refresh now'}
              </button>
            ) : null}

            <button
              onClick={load}
              disabled={fetching}
              className="flex items-center gap-2 px-4 py-2.5 bg-white border border-[#E0D0BE] hover:bg-[#FFF1E3] disabled:opacity-60 text-[#6B5744] rounded-xl text-sm font-medium shadow-sm transition-colors"
            >
              {fetching ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Reload page
            </button>

            {data?.can_import && (
              <button
                onClick={() => setShowImport(v => !v)}
                className="flex items-center gap-1.5 px-3 py-2 text-[#8B7355] hover:text-[#af4408] hover:bg-[#FFF1E3] rounded-lg text-[12px] font-medium transition-colors"
                title="Backfill history from a Google Takeout export, or paste rows while API access is pending"
              >
                <Upload className="w-3.5 h-3.5" />
                Import a file
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl px-4 py-3 text-sm flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* ── THE LOUD BAND. Above every number on the page, because a number
              read off a dead connector is worse than no number at all. Only the
              engine's own 'error' severity gets here: a refused token or a run
              of failed fetches. A paused schedule is a decision, not a
              breakage, and stays in the panel below. ─────────────────────── */}
        {banner?.loud && (
          <div className="bg-red-600 text-white rounded-xl px-4 py-3.5 shadow-sm">
            <div className="flex flex-col sm:flex-row sm:items-start gap-3">
              <ShieldAlert className="w-6 h-6 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold">{banner.headline}</p>
                {banner.action && <p className="text-[12.5px] text-red-50 mt-1 leading-snug">{banner.action}</p>}
                {/* Careful: this quotes the CONNECTOR's last success, which is
                    not necessarily the last time anything was imported — an
                    admin may have backfilled by hand since. Saying "every
                    figure below is from N days ago" would then understate how
                    fresh the page is. The data-state strip directly beneath
                    answers "when was anything last imported, by which route";
                    this sentence answers only "when did Google last answer". */}
                <p className="text-[11px] text-red-100 mt-1.5">
                  {data?.connection.last_success_at
                    ? `Google last answered ${agoText(data.connection.hours_since_success)}, on ${fmtIst(data.connection.last_success_at)}. `
                    : 'No fetch from Google has ever succeeded. '}
                  Nothing has arrived automatically since. Check the line below for when this page was last
                  told anything, by any route.
                </p>
              </div>
              {data?.can_import && (
                <a
                  href="#connection"
                  className="shrink-0 self-start px-3.5 py-2 bg-white text-red-700 rounded-lg text-[12px] font-bold hover:bg-red-50"
                >
                  {banner.ctaLabel}
                </a>
              )}
            </div>
          </div>
        )}

        {/* ── DATA STATE. First, always, never collapsed. ──────────────────── */}
        {ds && <DataStateStrip ds={ds} />}

        {/* ── CONNECTION. The primary rail: is anything still arriving? ────── */}
        {data && (
          <ConnectionPanel
            health={data.connection}
            locationKey={data.location_key}
            isAdmin={!!data.can_import}
            refreshing={refreshing}
            onRefreshNow={refreshNow}
            onChanged={load}
            lastResult={visibleRefreshResult}
            onDismissResult={() => setRefreshResult(null)}
          />
        )}

        {/* ── Import panel (admin) — the BACKFILL, not the main road. ───────── */}
        {data?.can_import && showImport && (
          <ImportPanel
            sources={data.sources || []}
            locationKey={data.location_key}
            onClose={() => setShowImport(false)}
            onDone={load}
          />
        )}

        {/* ── TOP: today / week / month / all time ─────────────────────────── */}
        {data && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <PeriodTile block={data.headline.today} lastImport={ds?.last_success_at || null} coverageEnd={ds?.coverage_end_at ?? null} now={generatedMs} />
            <PeriodTile block={data.headline.week} lastImport={ds?.last_success_at || null} coverageEnd={ds?.coverage_end_at ?? null} now={generatedMs} />
            <PeriodTile block={data.headline.month} lastImport={ds?.last_success_at || null} coverageEnd={ds?.coverage_end_at ?? null} now={generatedMs} />
            <AllTimeTile all={data.headline.all_time} summary={data.summary} />
          </div>
        )}

        {/* ── TREND ────────────────────────────────────────────────────────── */}
        {data && (
          <Section
            icon={<TrendingUp className="w-4 h-4 text-[#af4408]" />}
            title="Trend"
            subtitle="Review volume with the average rating over it. The rating line breaks where a period had no reviews — there is no rating to draw, and a flat line through the gap would invent one."
            right={
              <div className="flex items-center gap-1.5">
                {(['daily', 'weekly', 'monthly'] as PeriodKey[]).map(p => (
                  <button
                    key={p}
                    onClick={() => { setPeriod(p); setFullSeries(false); }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                      period === p
                        ? 'bg-[#af4408] border-[#af4408] text-white'
                        : 'bg-white border-[#E0D0BE] text-[#6B5744] hover:bg-[#FFF1E3]'
                    }`}
                  >
                    {p === 'daily' ? 'Daily' : p === 'weekly' ? 'Weekly' : 'Monthly'}
                  </button>
                ))}
              </div>
            }
          >
            {chartData.length === 0 ? (
              <Empty>Nothing to plot — no reviews have been imported for this listing yet.</Empty>
            ) : (
              <>
                <div className="-mx-2 sm:mx-0">
                  <ResponsiveContainer width="100%" height={300}>
                    <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#F0E4D6" />
                      <XAxis
                        dataKey="label"
                        tick={{ fontSize: 10, fill: '#8B7355' }}
                        stroke="#D9C5B0"
                        interval="preserveStartEnd"
                        minTickGap={18}
                      />
                      <YAxis
                        yAxisId="left"
                        tick={{ fontSize: 11, fill: '#8B7355' }}
                        stroke="#D9C5B0"
                        allowDecimals={false}
                      />
                      <YAxis
                        yAxisId="right"
                        orientation="right"
                        domain={[1, 5]}
                        ticks={[1, 2, 3, 4, 5]}
                        tick={{ fontSize: 11, fill: '#af4408' }}
                        stroke="#E3B98F"
                        width={28}
                      />
                      <Tooltip content={<TrendTooltip period={data.series.period} />} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar yAxisId="left" dataKey="count" name="Reviews" fill="#E8C9A8" radius={[3, 3, 0, 0]} />
                      <Line
                        yAxisId="right" type="monotone" dataKey="average" name="Average rating"
                        stroke="#af4408" strokeWidth={2} dot={{ r: 2.5 }} connectNulls={false}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 mt-2">
                  <p className="text-[11px] text-[#8B7355]">
                    {data.series.shown} {data.series.period === 'daily' ? 'day' : data.series.period === 'weekly' ? 'week' : 'month'}
                    {data.series.shown === 1 ? '' : 's'} shown, IST calendar buckets, gaps included as zero.
                    {data.series.hidden_older > 0 && ` ${data.series.hidden_older} earlier not shown.`}
                    {partialBar && ` The last bar (${partialBar.key} *) is ${partialBar.progress_text} — it is still filling up, so it is short by design and not a fall.`}
                  </p>
                  {data.series.hidden_older > 0 && !fullSeries && (
                    <button onClick={() => setFullSeries(true)} className="text-[11px] font-semibold text-[#af4408] hover:underline">
                      Show all {data.series.total_buckets}
                    </button>
                  )}
                  {fullSeries && (
                    <button onClick={() => setFullSeries(false)} className="text-[11px] font-semibold text-[#af4408] hover:underline">
                      Show recent only
                    </button>
                  )}
                </div>

                {data.series.engine_truncated && (
                  <Note tone="warn">
                    The history is longer than the chart engine will walk, so the OLDEST buckets were
                    dropped. The recent end — today, this week, this month — is complete; the all-time
                    figures above still count every review held.
                  </Note>
                )}

                {data.alerts.length > 0 && (
                  <div className="mt-3 border-t border-[#F0E4D6] pt-3">
                    <p className="text-[11px] font-semibold text-[#6B5744] uppercase tracking-wider mb-1.5">
                      Periods that moved sharply against their own trailing norm
                    </p>
                    <ul className="space-y-1">
                      {data.alerts.slice(0, 8).map((a, i) => (
                        <li key={`${a.key}-${a.kind}-${i}`} className="text-[12px] text-[#6B5744] flex items-start gap-2">
                          <span className={`mt-0.5 inline-block w-1.5 h-1.5 rounded-full shrink-0 ${a.kind === 'rating_drop' ? 'bg-red-500' : 'bg-amber-500'}`} />
                          <span>
                            <span className="font-semibold text-[#2D1B0E]">{a.key}</span> — {a.detail}
                            <span className="text-[#8B7355]"> (judged against the {a.baseline_buckets} periods before it, {a.baseline_reviews} reviews)</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </Section>
        )}

        {/* ── MAJOR REVIEWS ────────────────────────────────────────────────── */}
        {data && (
          <Section
            icon={<MessageSquare className="w-4 h-4 text-[#af4408]" />}
            title="Reviews that need attention"
            subtitle="Scored, not filtered by star rating alone: a 3-star with no reply outranks a replied 2-star, because a reply is the thing still owed. Opens on the last 30 days — the older ones are still held and one chip away."
            right={
              <button onClick={() => setShowRule(v => !v)} className="text-xs font-semibold text-[#af4408] hover:underline whitespace-nowrap">
                {showRule ? 'Hide the rule' : 'How this list is chosen'}
              </button>
            }
          >
            {showRule && (
              <div className="bg-[#FFFBF5] border border-[#F0E4D6] rounded-lg px-3 py-2.5 mb-3">
                <ul className="space-y-1 text-[12px] text-[#6B5744] list-disc pl-4">
                  {data.major.definition.map((d, i) => <li key={i}>{d}</li>)}
                </ul>
                <p className="text-[11px] text-[#8B7355] mt-2">
                  {data.major.major_count} of {data.major.total_scored} reviews reach the threshold.
                  The reason chips on each card below are the clauses that caught it.
                </p>
              </div>
            )}

            {/* Filters. Every chip here is a QUERY PARAMETER, not a client-side
                filter — see loadList(). */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-3 pb-3 border-b border-[#F0E4D6]">
              <FilterGroup label="Dates">
                {([
                  ['today', 'Today'], ['d7', '7 days'], ['d30', '30 days'], ['d90', '90 days'], ['all', 'All'],
                ] as Array<[RangeKey, string]>).map(([v, l]) => (
                  <Chip key={v} active={dateRange === v} onClick={() => refine(() => setDateRange(v))}>{l}</Chip>
                ))}
                <Chip active={dateRange === 'custom'} onClick={() => refine(() => setDateRange('custom'))}>Range</Chip>
              </FilterGroup>
              <FilterGroup label="Order">
                <Chip active={sortOrder === 'newest'} onClick={() => refine(() => setSortOrder('newest'))}>Newest first</Chip>
                <Chip active={sortOrder === 'oldest'} onClick={() => refine(() => setSortOrder('oldest'))}>Oldest first</Chip>
              </FilterGroup>
              <FilterGroup label="Rating">
                {([
                  ['all', 'All'], ['low', '1–2★'], ['1', '1★'], ['2', '2★'], ['3', '3★'], ['4', '4★'], ['5', '5★'],
                ] as Array<[RatingFilter, string]>).map(([v, l]) => (
                  <Chip key={v} active={ratingFilter === v} onClick={() => refine(() => setRatingFilter(v))}>{l}</Chip>
                ))}
              </FilterGroup>
              <FilterGroup label="Reply">
                {([['all', 'All'], ['no', 'Unanswered'], ['yes', 'Answered']] as Array<[AnsweredFilter, string]>).map(([v, l]) => (
                  <Chip key={v} active={answeredFilter === v} onClick={() => refine(() => setAnsweredFilter(v))}>{l}</Chip>
                ))}
              </FilterGroup>
              <FilterGroup label="Scope">
                <Chip active={majorOnly} onClick={() => refine(() => setMajorOnly(true))}>Needs attention</Chip>
                <Chip active={!majorOnly} onClick={() => refine(() => setMajorOnly(false))}>Every review</Chip>
              </FilterGroup>
            </div>

            {dateRange === 'custom' && (
              <div className="flex flex-wrap items-end gap-3 mb-3 bg-[#FFFBF5] border border-[#F0E4D6] rounded-lg px-3 py-2.5">
                <label className="text-[11px] font-semibold text-[#6B5744] uppercase tracking-wider">
                  From
                  <input
                    type="date"
                    value={customFrom}
                    onChange={e => refine(() => setCustomFrom(e.target.value))}
                    className="block mt-1 px-2.5 py-1.5 rounded-lg border border-[#E0D0BE] bg-white text-[12px] font-normal normal-case tracking-normal text-[#2D1B0E]"
                  />
                </label>
                <label className="text-[11px] font-semibold text-[#6B5744] uppercase tracking-wider">
                  To
                  <input
                    type="date"
                    value={customTo}
                    onChange={e => refine(() => setCustomTo(e.target.value))}
                    className="block mt-1 px-2.5 py-1.5 rounded-lg border border-[#E0D0BE] bg-white text-[12px] font-normal normal-case tracking-normal text-[#2D1B0E]"
                  />
                </label>
                <p className="text-[11px] text-[#8B7355] max-w-md">
                  Whole IST calendar days, both ends included. Leave one side empty for an open-ended
                  range. Empty both and this is every review held.
                </p>
              </div>
            )}

            {/* ── WHAT THIS LIST IS, AND WHAT IT IS NOT ────────────────────────
                The required admission. A list narrowed to 30 days by default,
                with thousands of older rows silently absent, reads as "this is
                everything" — and that is the same class of falsehood as an
                unimported week reading as a quiet one. So the window is named,
                the hidden count is printed, and the control that widens it is
                right here. Amber when something is hidden; plain when the list
                really is the whole of the matching set. ─────────────────────── */}
            {listError ? (
              <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg px-3 py-2.5 text-[12px] flex items-start gap-2 mb-3">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>
                  {listError} — so this list is not being shown at all. It is deliberately not falling
                  back to the {data.major.listed} reviews already on this page: those are the
                  highest-SCORING ones, and filtering or re-ordering them by date would produce a
                  confident, wrong answer. Press Reload page to try again.
                </span>
              </div>
            ) : list && (
              <div
                className={`rounded-lg px-3 py-2.5 text-[12px] border mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 ${
                  list.older_outside + list.newer_outside > 0
                    ? 'bg-amber-50 border-amber-200 text-amber-900'
                    : 'bg-[#FFFBF5] border-[#F0E4D6] text-[#6B5744]'
                }`}
              >
                <span>
                  Showing <span className="font-semibold">{list.window.label}</span>
                  {' — '}
                  {list.matched_total === 0 ? 'no review matches' : (
                    <>
                      <span className="font-semibold tabular-nums">{list.matched_total}</span>
                      {' '}review{list.matched_total === 1 ? '' : 's'} match
                      {list.listed < list.matched_total && <>, {list.listed} on screen</>}
                    </>
                  )}
                  {', '}
                  {list.filters.sort === 'newest' ? 'newest first' : 'oldest first'}.
                </span>
                {list.older_outside > 0 && (
                  <span className="font-semibold tabular-nums">
                    {list.older_outside} older {list.older_outside === 1 ? 'one' : 'ones'} not shown.
                  </span>
                )}
                {list.newer_outside > 0 && (
                  <span className="font-semibold tabular-nums">{list.newer_outside} newer not shown.</span>
                )}
                {list.older_outside + list.newer_outside > 0 && (
                  <button
                    onClick={() => refine(() => { setDateRange('all'); setCustomFrom(''); setCustomTo(''); })}
                    className="font-semibold underline hover:no-underline"
                  >
                    Show every review held
                  </button>
                )}
                {/* Said while a new selection is in flight, because the sentence
                    above it describes the PREVIOUS one until the reply lands.
                    Unlabelled, that is a window label contradicting the chip the
                    manager just pressed. */}
                {listLoading && (
                  <span className="inline-flex items-center gap-1 font-semibold">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />updating…
                  </span>
                )}
                {list.anchor_clamped && (
                  <span className="font-semibold">
                    This page has been open a long time; the dates were measured from the server’s clock
                    instead. Reload for a current view.
                  </span>
                )}
                <span className="ml-auto text-[11px] opacity-80">
                  {list.filters.scope === 'major'
                    ? `${list.scope_total} of ${list.total_scored} reviews held reach the attention threshold.`
                    : `${list.total_scored} scored reviews held.`}
                  {' '}Every other count on this page is over that whole set, not this window.
                </span>
              </div>
            )}

            {data.reply_link.kind === 'none' && (
              <Note tone="warn">
                No “open on Google” link is configured, so the cards below cannot link out.{' '}
                {data.can_import
                  ? 'Add the listing’s Place ID or URL in the Import panel above.'
                  : 'An admin can add the listing’s Place ID or URL from the Import panel.'}
              </Note>
            )}

            {/* Not `listLoading` alone: the first selection is requested in an
                effect AFTER the first paint, so for one frame nothing is loading
                and nothing has loaded. An empty section there reads as "no
                reviews". */}
            {!list && !listError && (
              <div className="flex items-center gap-2 text-[13px] text-[#6B5744] px-3 py-3">
                <Loader2 className="w-4 h-4 animate-spin" />
                Selecting from the {data.data_state.stored_total} reviews held…
              </div>
            )}

            {list && list.reviews.length === 0 ? (
              <Empty>
                {list.total_scored === 0
                  ? 'No reviews have been imported for this listing yet, so there is nothing to score.'
                  : list.older_outside + list.newer_outside > 0
                    // The distinction the date default makes necessary: nothing
                    // matched HERE is not the same as nothing matching.
                    ? `No review matches inside ${list.window.label}, but ${list.older_outside + list.newer_outside} ` +
                      'outside it do. Widen the dates above to see them — nothing has been removed.'
                    : list.filters.scope === 'major' && list.filters.rating === 'all' && list.filters.reply === 'all'
                      ? 'No review in the imported history reaches the attention threshold. That is a real result over ' +
                        `${list.total_scored} reviews, not an empty page.`
                      : 'No review matches these filters. The others are still there — widen the filter.'}
              </Empty>
            ) : list && (
              <div className={`space-y-2.5 transition-opacity ${listLoading ? 'opacity-50' : ''}`}>
                {/* Every row the server returned is rendered. There is no second
                    cap here, so "N on screen" is always literally true. */}
                {list.reviews.map(r => (
                  <ReviewRowCard
                    key={r.id}
                    r={r}
                    link={data.reply_link}
                    canReply={data.can_reply}
                    locationKey={data.location_key}
                    /* A successful send changes the answered/unanswered counts
                       and the reply rate in the header. Reload both rather than
                       patching one card, so nothing on screen disagrees with
                       anything else on screen. */
                    onReplied={() => { load(); loadList(); }}
                  />
                ))}
                {list.truncated && (
                  <div className="flex flex-wrap items-center gap-3 bg-[#FFFBF5] border border-[#F0E4D6] rounded-lg px-3 py-2.5 text-[12px] text-[#6B5744] mt-3">
                    <span>
                      {list.listed} of <span className="font-semibold tabular-nums">{list.matched_total}</span>{' '}
                      matching reviews are on screen.
                    </span>
                    {list.limit < LIST_MAX ? (
                      <button
                        onClick={() => setListLimit(n => Math.min(LIST_MAX, n + LIST_STEP))}
                        disabled={listLoading}
                        className="font-semibold text-[#af4408] hover:underline disabled:opacity-60"
                      >
                        {listLoading ? 'Loading…' : `Show ${Math.min(LIST_STEP, list.matched_total - list.listed)} more`}
                      </button>
                    ) : (
                      <span>
                        That is as many as this page will load at once — narrow the dates or the rating to
                        work through the rest.
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
          </Section>
        )}

        {/* ── THEMES ───────────────────────────────────────────────────────── */}
        {data && themes && (
          <Section
            icon={<Tag className="w-4 h-4 text-[#af4408]" />}
            title="What guests mention"
            subtitle="Counted by matching words in the review text. Not sentiment analysis — the only tone signal here is the guest’s own star rating, shown beside each theme."
            right={
              <div className="flex items-center gap-1.5">
                {([['d90', '90 days'], ['d365', '12 months'], ['all', 'All']] as Array<[ThemeSpanKey, string]>).map(([v, l]) => (
                  <Chip key={v} active={themeSpan === v} onClick={() => setThemeSpan(v)}>{l}</Chip>
                ))}
              </div>
            }
          >
            <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg px-3 py-2.5 text-[12px] text-[#6B5744] flex items-start gap-2 mb-3">
              <Info className="w-4 h-4 mt-0.5 shrink-0 text-[#af4408]" />
              <span>{themes.disclaimer}</span>
            </div>

            {themes.themes.length === 0 ? (
              <Empty>
                {themes.text_reviews === 0
                  ? `No review in ${themes.label.toLowerCase()} carried any text — a rating with no words cannot mention anything.`
                  : `None of the ${themes.rules_used} keyword rules matched any of the ${themes.text_reviews} reviews with text in ${themes.label.toLowerCase()}.`}
              </Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[40rem]">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-wider text-[#6B5744] border-b border-[#F0E4D6]">
                      <Th align="left">Theme</Th>
                      <Th>Mentions</Th>
                      <Th>Share of reviews with text</Th>
                      <Th>Avg rating of those reviews</Th>
                      <Th>1–2★ among them</Th>
                      <Th align="left">Words that matched</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {themes.themes.map(t => {
                      const openHere = openTheme?.key === t.key;
                      return (
                        <Fragment key={t.key}>
                          <tr className={`border-b border-[#F7EEE4] align-top ${openHere ? 'bg-[#FFFBF5]' : ''}`}>
                            <td className="py-2.5 pr-3 font-semibold">{t.label}</td>
                            <Td>
                              <CountButton
                                n={t.count}
                                active={openHere && !openTheme!.low}
                                title={`Show the ${t.count} review${t.count === 1 ? '' : 's'} that mention ${t.label} in ${themes.label.toLowerCase()}`}
                                onClick={() => setOpenTheme(cur =>
                                  cur && cur.key === t.key && !cur.low ? null : { key: t.key, low: false })}
                              />
                            </Td>
                            <Td>{t.share_of_text_reviews == null ? '—' : `${Math.round(t.share_of_text_reviews * 1000) / 10}%`}</Td>
                            <Td>
                              {t.average_rating == null ? '—' : (
                                <span className="inline-flex items-center gap-1.5 justify-end">
                                  <span>{t.average_rating.toFixed(2)}</span>
                                  <Stars value={t.average_rating} size={11} />
                                </span>
                              )}
                            </Td>
                            <Td>
                              {/* Zero opens nothing: a button that reveals an
                                  empty list is a promise the number already
                                  broke. */}
                              {t.low_count === 0 ? '0' : (
                                <CountButton
                                  n={t.low_count}
                                  tone="low"
                                  active={openHere && openTheme!.low}
                                  title={`Show the ${t.low_count} review${t.low_count === 1 ? '' : 's'} rated 1–2★ that mention ${t.label}`}
                                  onClick={() => setOpenTheme(cur =>
                                    cur && cur.key === t.key && cur.low ? null : { key: t.key, low: true })}
                                />
                              )}
                            </Td>
                            <td className="py-2.5 pl-3 text-[11px] text-[#8B7355]">
                              {t.top_terms.map(x => `${x.term} (${x.count})`).join(', ') || '—'}
                            </td>
                          </tr>
                          {openHere && (
                            <tr className="border-b-2 border-[#E8D5C4] bg-[#FFFBF5]">
                              <td colSpan={6} className="px-1 sm:px-3 pb-4 pt-1">
                                <ThemeDrill
                                  label={t.label}
                                  spanLabel={themes.label.toLowerCase()}
                                  low={openTheme!.low}
                                  /* The number the manager actually clicked.
                                     ThemeDrill compares it with the total the
                                     server counted and says so if they differ —
                                     a drill-down that quietly disagrees with its
                                     own row makes the table look wrong. */
                                  expected={openTheme!.low ? t.low_count : t.count}
                                  drill={drill}
                                  loading={drillLoading}
                                  error={drillError}
                                  link={data.reply_link}
                                  canReply={data.can_reply}
                                  locationKey={data.location_key}
                                  onReplied={() => { load(); loadList(); }}
                                  onClose={() => setOpenTheme(null)}
                                />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <Note>
              Over {themes.label.toLowerCase()}: {themes.reviews_in_span} review{themes.reviews_in_span === 1 ? '' : 's'},
              {' '}{themes.text_reviews} with any text, of which <span className="font-semibold">{themes.unmatched}</span>
              {' '}matched none of the {themes.rules_used} rules. A large unmatched count means the rules are missing this
              venue’s vocabulary — it does not mean guests said nothing.
            </Note>
          </Section>
        )}

        {/* ── Reply performance + rating spread ────────────────────────────── */}
        {data && data.summary.total > 0 && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <Section icon={<Star className="w-4 h-4 text-[#af4408]" />} title="Rating spread" subtitle="Every review held, by star rating.">
              <div className="space-y-2">
                {([5, 4, 3, 2, 1] as const).map(star => (
                  <Band
                    key={star}
                    label={`${star} star${star === 1 ? '' : 's'}`}
                    n={data.summary.distribution[star]}
                    total={data.summary.total}
                  />
                ))}
              </div>
              <Note>
                {data.summary.with_text} of {data.summary.total} carry text; {data.summary.without_text} are a rating only.
                {data.summary.undated > 0 && ` ${data.summary.undated} could not be dated and are excluded from every period figure.`}
              </Note>
            </Section>

            <Section icon={<Clock className="w-4 h-4 text-[#af4408]" />} title="Replies" subtitle="Answered, still owed, and how fast — over the replies that carry a timestamp.">
              <div className="space-y-1.5">
                <StatRow label="Answered" value={`${data.summary.reply.replied} of ${data.summary.total}`} strong />
                <StatRow
                  label="Reply rate"
                  value={data.summary.reply.reply_rate == null ? 'no reviews' : `${Math.round(data.summary.reply.reply_rate * 1000) / 10}%`}
                />
                <StatRow label="Unanswered" value={String(data.summary.reply.unreplied)} />
                <StatRow label="Unanswered past 48 h" value={String(data.summary.reply.overdue)} />
                <StatRow
                  label="Oldest unanswered"
                  value={data.summary.reply.oldest_unanswered_hours == null ? 'none' : fmtAgo(data.summary.reply.oldest_unanswered_hours)}
                />
                <StatRow
                  label="Median time to reply"
                  value={data.summary.reply.median_hours == null ? 'not measurable' : `${data.summary.reply.median_hours} h`}
                />
                <StatRow
                  label="Replied within 24 h"
                  value={data.summary.reply.timed === 0 ? '—' : `${data.summary.reply.within_24h} of ${data.summary.reply.timed} timed`}
                />
              </div>
              <Note>
                Speed is measured over the <span className="font-semibold">{data.summary.reply.timed}</span> replies that carry a
                timestamp, not over all {data.summary.reply.replied} answered ones. A Takeout export can hold the reply text
                without a reply time; those count as answered and cannot be timed, so the two denominators differ on purpose.
              </Note>
              {/* ── A NUMBER MUST NOT CHANGE MEANING WITHOUT SAYING SO ────────
                  "Reviews that need attention" above now opens on the last 30
                  days. These figures deliberately did NOT follow it: this panel
                  answers "how are we doing on replies", which is a question about
                  the venue's whole record, and quietly re-basing "Unanswered"
                  onto a month would make the backlog look solved. So the scope
                  is stated instead of being left to be inferred — the same
                  discipline as the NOT IMPORTED tiles. ──────────────────────── */}
              <Note tone="warn">
                Every figure in this panel covers <span className="font-semibold">all {data.summary.total} reviews held</span>,
                not the date window chosen in “Reviews that need attention”. That list opens on the last
                30 days because a queue thousands long cannot be worked; this scoreboard stays whole,
                so the backlog it reports is the real one.
              </Note>
            </Section>
          </div>
        )}

        {/* ── Standing caveats ─────────────────────────────────────────────── */}
        {data && (
          <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl px-4 py-3 text-[12px] text-[#6B5744]">
            <p className="font-semibold text-[#2D1B0E] mb-1.5 flex items-center gap-1.5">
              <Info className="w-3.5 h-3.5 text-[#af4408]" />What these numbers can and cannot say
            </p>
            <ul className="space-y-1 list-disc pl-4">
              {data.caveats.map((c, i) => <li key={i}>{c}</li>)}
              <li>
                Google exports carry no link to an individual review, so “Open on Google” goes to the listing’s review
                list. The author name and date on each card identify the row once you are there.
              </li>
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Data-state strip ──────────────────────────────────────────────────────── */

function DataStateStrip({ ds }: { ds: DataState }) {
  // A blind spot is as much a reason to warn as an old run is. A file imported
  // one minute ago whose newest review is a month old leaves four weeks nobody
  // can see, and the run's own freshness says nothing about it.
  const blindSpot = ds.coverage_basis !== 'fetched_from_google'
    && (ds.coverage_end_at == null || (ds.coverage_gap_days ?? 0) >= 2)
    && !ds.never_ingested;
  const tone = ds.never_ingested || ds.stale || blindSpot ? 'warn' : 'ok';
  const box = tone === 'warn'
    ? 'bg-amber-50 border-amber-300'
    : 'bg-white border-[#E8D5C4]';

  return (
    <div className={`border rounded-xl px-4 py-3 ${box}`}>
      <div className="flex flex-col sm:flex-row sm:items-start gap-3">
        <div className="shrink-0 mt-0.5">
          {tone === 'warn'
            ? <AlertTriangle className="w-5 h-5 text-amber-600" />
            : <Database className="w-5 h-5 text-[#af4408]" />}
        </div>
        <div className="flex-1 min-w-0">
          {ds.never_ingested ? (
            <>
              <p className="text-sm font-bold text-amber-900">No reviews have been imported yet.</p>
              <p className="text-[12px] text-amber-900/80 mt-0.5">
                Every count on this page is zero because nothing has been loaded — not because the venue has no reviews.
                An admin can import a Google Takeout export from the Import panel.
              </p>
            </>
          ) : (
            <>
              <p className={`text-sm font-bold ${tone === 'warn' ? 'text-amber-900' : 'text-[#2D1B0E]'}`}>
                {tone === 'warn' ? 'This page is out of date. ' : ''}
                Last imported {fmtAgo(ds.hours_since_ingest)} — {fmtDateTime(ds.last_success_at)}
              </p>
              <p className={`text-[12px] mt-0.5 ${tone === 'warn' ? 'text-amber-900/80' : 'text-[#6B5744]'}`}>
                via <span className="font-semibold">{SOURCE_LABEL[ds.last_success_source || ''] || ds.last_success_source}</span>
                {ds.last_success_actor ? <> by <span className="font-semibold">{ds.last_success_actor}</span></> : null}
                {ds.last_success_label ? <> ({ds.last_success_label})</> : null}
                {ds.last_success_counts && (
                  <> · added {ds.last_success_counts.inserted}, changed {ds.last_success_counts.updated},
                    already known {ds.last_success_counts.unchanged}
                    {ds.last_success_counts.errors > 0 && <>, refused {ds.last_success_counts.errors}</>}</>
                )}
              </p>
              {tone === 'warn' && (
                <p className="text-[12px] text-amber-900 mt-1 font-medium">
                  Anything posted on Google since then is not on this page. An empty period below means
                  “not imported”, not “no reviews”.
                </p>
              )}
              {blindSpot && (
                <p className="text-[12px] text-amber-900 mt-1 font-medium">
                  This page can only speak for the period up to{' '}
                  {ds.coverage_end_at ? fmtDate(ds.coverage_end_at) : 'nothing at all'}
                  {ds.coverage_gap_days != null && ds.coverage_gap_days > 0
                    ? ` — the last ${ds.coverage_gap_days} day${ds.coverage_gap_days === 1 ? '' : 's'} are a blind spot, not a quiet spell.`
                    : '.'}{' '}
                  {ds.coverage_note}
                </p>
              )}
            </>
          )}

          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-[#6B5744]">
            <span>{ds.stored_total} review{ds.stored_total === 1 ? '' : 's'} held</span>
            <span>
              Newest review: {ds.newest_review_at
                ? `${fmtDate(ds.newest_review_at)} (${ds.days_since_newest_review} day${ds.days_since_newest_review === 1 ? '' : 's'} ago)`
                : 'none'}
            </span>
            <span>Considered stale after {Math.round(ds.stale_after_hours)} h</span>
            <span className={ds.coverage_basis === 'fetched_from_google' ? '' : 'font-semibold text-amber-800'}>
              Data covers up to: {ds.coverage_end_at ? fmtDate(ds.coverage_end_at) : 'nothing'}
              {ds.coverage_basis === 'fetched_from_google' ? ' (asked Google directly)' : ' (the newest review in the file)'}
            </span>
            {ds.last_success_counts?.delta != null && (
              <span className={ds.last_success_counts.delta === 0 ? '' : 'font-semibold text-amber-800'}>
                Against the listing total the owner gave ({ds.last_success_counts.expected_total}):{' '}
                {ds.last_success_counts.delta === 0
                  ? 'matches'
                  : `${ds.last_success_counts.delta > 0 ? '+' : ''}${ds.last_success_counts.delta}`}
              </span>
            )}
            {ds.last_success_counts && ds.last_success_counts.weak_identity > 0 && (
              <span>
                {ds.last_success_counts.weak_identity} anonymous review{ds.last_success_counts.weak_identity === 1 ? '' : 's'} keyed
                on content — an edit by those authors would land as a new row
              </span>
            )}
          </div>

          {ds.history_truncated && (
            <p className="text-[11px] text-amber-800 mt-1.5 font-medium">
              Only the most recent {ds.rows_loaded} of {ds.stored_total} reviews were loaded; “all time” below means those.
            </p>
          )}

          {ds.last_run_failed && (
            <div className="mt-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-[12px] text-red-800">
              <span className="font-semibold">The most recent import attempt failed</span>{' '}
              ({SOURCE_LABEL[ds.last_run_source || ''] || ds.last_run_source}, {fmtDateTime(ds.last_run_at)}).
              The figures above are from the last one that worked.
              {ds.last_run_error && <span className="block mt-0.5 font-mono text-[11px] break-words">{ds.last_run_error}</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Connection panel ──────────────────────────────────────────────────────────
 *
 * THE PRIMARY RAIL. The owner's requirement was "it should automatically
 * retrieve the reviews data" — so the question this panel answers first is not
 * "how do I import a file?" but "is anything arriving, and if not, why?".
 *
 * THERE IS NO URL BOX HERE, AND THAT IS NOT AN OMISSION. Pasting a Google Maps
 * link cannot work: the Places API returns at most 5 reviews, ordered by
 * relevance rather than date, with no pagination — no history, no trend, no
 * unanswered queue. Google releases review history only to an account that
 * MANAGES the listing, through OAuth. selectLocation() actively refuses a
 * pasted Maps URL for the same reason. If someone later "helpfully" adds a URL
 * field to this panel, it will collect links that silently do nothing.
 *
 * WHAT IS SHOWN WITHOUT ADMIN: the health, the account, the listing, when the
 * last fetch succeeded and when the next is due. A manager reading the report
 * must be able to tell a quiet month from a dead connector without asking an
 * admin — that is the difference between a report and a misleading one. What is
 * admin-only is everything that CHANGES the connection, plus the setup detail.
 */

function ConnectionPanel({
  health, locationKey, isAdmin, refreshing, onRefreshNow, onChanged, lastResult, onDismissResult,
}: {
  health: ConnectionHealth;
  locationKey: string;
  isAdmin: boolean;
  refreshing: boolean;
  onRefreshNow: () => void;
  onChanged: () => void;
  lastResult: RefreshOutcome | null;
  onDismissResult: () => void;
}) {
  const [detail, setDetail] = useState<ConnectionDetail | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string; list?: string[] } | null>(null);
  const [consent, setConsent] = useState<{ url: string; note: string; redirect: string } | null>(null);
  const [accounts, setAccounts] = useState<GbpAccountRow[] | null>(null);
  const [copied, setCopied] = useState(false);

  const view = connectionBanner(health);

  const loadDetail = useCallback(async () => {
    try {
      const sp = locationKey ? `?location_key=${encodeURIComponent(locationKey)}` : '';
      const res = await fetch(`/api/crm-calls/reviews/connect${sp}`);
      if (!res.ok) return;
      setDetail(await res.json());
    } catch { /* the health on the report is enough to render the panel */ }
  }, [locationKey]);

  useEffect(() => { loadDetail(); }, [loadDetail]);

  const conn = detail?.connection;
  const setup = detail?.setup || null;

  /* ── Actions (admin only; every route re-checks the role server-side) ───── */

  const beginConnect = async () => {
    setBusy('connect'); setMsg(null);
    try {
      const res = await api('/api/crm-calls/reviews/connect', {
        method: 'POST',
        body: { location_key: locationKey },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ tone: 'error', text: json?.error || `HTTP ${res.status}` }); return; }
      // Deliberately NOT an automatic redirect. The single most common way this
      // fails is signing in as an account that can only VIEW the listing, and
      // the moment before the click is the only moment that warning can land.
      setConsent({ url: json.auth_url, note: json.note || '', redirect: json.redirect_uri || '' });
    } catch {
      setMsg({ tone: 'error', text: 'Couldn’t start the connect flow.' });
    } finally { setBusy(null); }
  };

  const loadLocations = async () => {
    setBusy('locations'); setMsg(null); setAccounts(null);
    try {
      const sp = locationKey ? `?location_key=${encodeURIComponent(locationKey)}` : '';
      const res = await fetch(`/api/crm-calls/reviews/locations${sp}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ tone: 'error', text: json?.error || `HTTP ${res.status}`, list: json?.prerequisites || [] });
        return;
      }
      setAccounts(json.accounts || []);
      if (json.note) setMsg({ tone: 'error', text: json.note });
    } catch {
      setMsg({ tone: 'error', text: 'Couldn’t list the listings on this account.' });
    } finally { setBusy(null); }
  };

  const chooseLocation = async (acc: GbpAccountRow, loc: GbpLocationRow) => {
    setBusy(loc.name); setMsg(null);
    try {
      const res = await api('/api/crm-calls/reviews/locations', {
        method: 'POST',
        body: {
          location_key: locationKey,
          name: loc.name,
          label: loc.label || acc.label,
          address: loc.address || '',
        },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ tone: 'error', text: json?.error || `HTTP ${res.status}` }); return; }
      setAccounts(null);
      setMsg({ tone: 'ok', text: json.next || 'Listing chosen.' });
      await loadDetail(); onChanged();
    } finally { setBusy(null); }
  };

  const setSchedule = async (enabled: boolean, minutes?: number) => {
    setBusy('schedule'); setMsg(null);
    try {
      const body: Record<string, unknown> = { location_key: locationKey, auto_enabled: enabled };
      if (minutes != null) body.interval_minutes = minutes;
      const res = await api('/api/crm-calls/reviews/connect', {
        method: 'PATCH',
        body,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ tone: 'error', text: json?.error || `HTTP ${res.status}` }); return; }
      await loadDetail(); onChanged();
    } finally { setBusy(null); }
  };

  const disconnect = async () => {
    if (!window.confirm(
      'Disconnect the Google account?\n\nReviews already imported are KEPT — this only stops new ones arriving. ' +
      'Reconnecting later needs the OAuth consent screen again.',
    )) return;
    setBusy('disconnect'); setMsg(null);
    try {
      const sp = locationKey ? `?location_key=${encodeURIComponent(locationKey)}` : '';
      const res = await api(`/api/crm-calls/reviews/connect${sp}`, { method: 'DELETE' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ tone: 'error', text: json?.error || `HTTP ${res.status}` }); return; }
      setMsg({ tone: 'ok', text: json.note || 'Disconnected.' });
      await loadDetail(); onChanged();
    } finally { setBusy(null); }
  };

  /* ── Chrome ─────────────────────────────────────────────────────────────── */

  const tone = view.tone;
  const shell =
    tone === 'error' ? 'bg-red-50 border-red-300'
      : tone === 'warn' ? 'bg-amber-50 border-amber-300'
        : tone === 'info' ? 'bg-[#FFF1E3] border-[#E8D5C4]'
          : 'bg-white border-[#E8D5C4]';
  const headText =
    tone === 'error' ? 'text-red-900' : tone === 'warn' ? 'text-amber-900' : 'text-[#2D1B0E]';

  const StatePill = () => (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold ${
      health.automatic ? 'bg-emerald-100 text-emerald-800'
        : tone === 'error' ? 'bg-red-200 text-red-900'
          : tone === 'warn' ? 'bg-amber-200 text-amber-900'
            : 'bg-[#E8D5C4] text-[#6B5744]'
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full ${
        health.automatic ? 'bg-emerald-600' : tone === 'error' ? 'bg-red-600' : tone === 'warn' ? 'bg-amber-600' : 'bg-[#8B7355]'
      }`} />
      {health.automatic ? 'Arriving automatically' : 'Not arriving automatically'}
    </span>
  );

  return (
    <section id="connection" className={`border rounded-xl ${shell}`}>
      <div className="px-4 py-3.5">
        <div className="flex flex-col sm:flex-row sm:items-start gap-3">
          <div className="shrink-0 mt-0.5">
            {tone === 'error' ? <ShieldAlert className="w-5 h-5 text-red-600" />
              : health.automatic ? <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                : <PlugZap className="w-5 h-5 text-[#af4408]" />}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className={`text-sm font-bold ${headText}`}>Google Business Profile</h2>
              <StatePill />
            </div>

            {/* Both sentences are the ENGINE's, rendered verbatim. */}
            <p className={`text-[13px] mt-1 leading-snug ${headText}`}>{health.headline}</p>
            {health.action && (
              <p className={`text-[12px] mt-1 leading-snug ${tone === 'error' ? 'text-red-800' : tone === 'warn' ? 'text-amber-900/85' : 'text-[#6B5744]'}`}>
                {health.action}
              </p>
            )}

            {/* ── The five facts, always visible, admin or not ───────────── */}
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-x-4 gap-y-2 mt-3 pt-3 border-t border-black/5">
              <Fact icon={<Link2 className="w-3.5 h-3.5" />} label="Account">
                {health.google_email || (conn?.google_email) || 'not connected'}
              </Fact>
              <Fact icon={<MapPin className="w-3.5 h-3.5" />} label="Listing">
                {health.location_label || health.location_name || 'not chosen'}
              </Fact>
              <Fact icon={<CloudDownload className="w-3.5 h-3.5" />} label="Last fetch">
                {health.last_success_at
                  ? <>{agoText(health.hours_since_success)}<span className="block text-[10px] text-[#8B7355]">{fmtIst(health.last_success_at)}</span></>
                  : 'never'}
              </Fact>
              <Fact icon={<Clock className="w-3.5 h-3.5" />} label="Next fetch">
                {/* A time here is a PROMISE. It is only printed when a scheduler
                    has actually been seen calling the auto-refresh entry point
                    (health.driver_alive); the engine blanks next_due_at
                    otherwise. The page used to print "in about 5 hours" off the
                    interval alone, with no code path on the machine able to
                    keep it. */}
                {health.next_due_at
                  ? <>{nextFetchText(health.next_due_at)}<span className="block text-[10px] text-[#8B7355]">{fmtIst(health.next_due_at)}</span></>
                  : health.state === 'no_driver'
                    ? <span className="text-amber-800 font-semibold">nothing scheduled to run
                        <span className="block text-[10px] font-normal text-amber-800">
                          {health.driver_last_tick_at
                            ? `the scheduler last ran ${agoText(health.hours_since_success)}`
                            : 'no scheduled fetch has ever run'}
                        </span>
                      </span>
                    : 'not scheduled'}
              </Fact>
              <Fact icon={<Power className="w-3.5 h-3.5" />} label="Schedule">
                {conn
                  ? (conn.auto_enabled
                      ? <>{intervalText(conn.interval_minutes)}
                          {!health.driver_alive && (
                            <span className="block text-[10px] text-amber-800 font-semibold">armed, but nothing runs it</span>
                          )}
                        </>
                      : 'off')
                  : (health.next_due_at ? 'on' : 'off')}
                {/* Deliberately worded differently from the data-state strip's
                    "considered stale after N h". They are two different
                    thresholds measuring two different things — how long since
                    anything was IMPORTED by any route, versus how long this
                    CONNECTOR has been silent — and showing both as bare "stale
                    after" numbers made one screen carry two answers to what
                    looked like the same question. */}
                <span className="block text-[10px] text-[#8B7355]">
                  silent {Math.round(health.stale_after_hours)} h &rarr; flagged
                </span>
              </Fact>
            </div>

            {health.consecutive_failures > 0 && (
              <p className="text-[12px] text-red-800 mt-2 font-medium">
                {health.consecutive_failures} consecutive failed fetch{health.consecutive_failures === 1 ? '' : 'es'}
                {health.last_error && <span className="block font-mono text-[11px] mt-0.5 break-words">{health.last_error}</span>}
              </p>
            )}
          </div>

          {/* ── Actions ──────────────────────────────────────────────────── */}
          {isAdmin && (
            <div className="shrink-0 flex sm:flex-col gap-2 self-start">
              {(view.cta === 'connect' || view.cta === 'reconnect') && (
                <button
                  onClick={beginConnect}
                  disabled={busy === 'connect' || !(setup?.oauth_app_configured ?? true)}
                  className="flex items-center justify-center gap-2 px-3.5 py-2.5 bg-[#af4408] hover:bg-[#963a06] disabled:opacity-50 text-white rounded-lg text-[12.5px] font-bold shadow-sm whitespace-nowrap"
                >
                  {busy === 'connect' ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlugZap className="w-4 h-4" />}
                  {view.ctaLabel}
                </button>
              )}
              {health.connected && (
                <button
                  onClick={onRefreshNow}
                  disabled={refreshing}
                  className="flex items-center justify-center gap-2 px-3.5 py-2.5 bg-white border border-[#E0D0BE] hover:bg-[#FFF1E3] disabled:opacity-60 text-[#6B5744] rounded-lg text-[12.5px] font-semibold whitespace-nowrap"
                >
                  {refreshing ? <Loader2 className="w-4 h-4 animate-spin" /> : <CloudDownload className="w-4 h-4" />}
                  Refresh now
                </button>
              )}
              <button
                onClick={() => setExpanded(v => !v)}
                className="text-[11px] font-semibold text-[#af4408] hover:underline whitespace-nowrap px-1"
              >
                {expanded ? 'Hide setup' : 'Setup & schedule'}
              </button>
            </div>
          )}
        </div>

        {/* ── The result of the last manual fetch ─────────────────────────── */}
        {lastResult && (
          <div className={`mt-3 rounded-lg px-3 py-2.5 text-[12px] flex items-start gap-2 ${
            lastResult.tone === 'ok' ? 'bg-emerald-50 border border-emerald-200 text-emerald-900'
              : 'bg-red-50 border border-red-200 text-red-900'
          }`}>
            {lastResult.tone === 'ok'
              ? <CheckCircle2 className="w-4 h-4 mt-px shrink-0" />
              : <AlertTriangle className="w-4 h-4 mt-px shrink-0" />}
            <div className="flex-1 min-w-0">
              <p className="font-semibold">{lastResult.message}</p>
              {lastResult.detail && <p className="mt-0.5 opacity-90">{lastResult.detail}</p>}
              {/* The other half of "there's an error but it fetched 1 minute
                  ago". A banner that is NOT stale can still sit beside a fresh
                  last-fetch time: one manual attempt timed out while the hourly
                  feed kept working. Both statements are true, and leaving the
                  reader to reconcile them is how a working connector gets read
                  as a broken one. Said only while the feed is inside its own
                  staleness threshold — past that it would be reassurance about
                  nothing. */}
              {lastResult.tone === 'error' && !!health.last_success_at
                && (health.hours_since_success ?? Infinity) < health.stale_after_hours && (
                <p className="mt-0.5 opacity-90">
                  This attempt failed; the feed itself has not. Reviews last arrived{' '}
                  {agoText(health.hours_since_success)} and nothing already fetched was lost.
                </p>
              )}
              {!!lastResult.prerequisites?.length && (
                <ol className="list-decimal pl-4 mt-1.5 space-y-0.5">
                  {lastResult.prerequisites.map((p, i) => <li key={i}>{p}</li>)}
                </ol>
              )}
              {lastResult.ingest && (lastResult.ingest.fatal_documents ?? 0) > 0 && (
                <p className="mt-0.5 font-semibold">
                  {lastResult.ingest.fatal_documents} page{lastResult.ingest.fatal_documents === 1 ? '' : 's'} of the
                  reply from Google could not be read in full, so {lastResult.ingest.fatal_documents === 1 ? 'it was' : 'they were'}{' '}
                  refused whole rather than imported in part. Treat the counts above as incomplete and try again.
                </p>
              )}
              {lastResult.ingest && lastResult.ingest.errors > 0 && (
                <p className="mt-0.5">
                  {lastResult.ingest.errors} item{lastResult.ingest.errors === 1 ? '' : 's'} were refused and counted.
                  Everything that could be read WAS read: the reader now fails a document it cannot separate into rows
                  rather than importing the readable part of it.
                </p>
              )}
            </div>
            <button onClick={onDismissResult} className="shrink-0 opacity-60 hover:opacity-100"><X className="w-3.5 h-3.5" /></button>
          </div>
        )}

        {msg && (
          <div className={`mt-3 rounded-lg px-3 py-2.5 text-[12px] ${
            msg.tone === 'ok' ? 'bg-emerald-50 border border-emerald-200 text-emerald-900'
              : 'bg-red-50 border border-red-200 text-red-900'
          }`}>
            <p className="font-semibold">{msg.text}</p>
            {!!msg.list?.length && (
              <ol className="list-decimal pl-4 mt-1.5 space-y-0.5">
                {msg.list.map((p, i) => <li key={i}>{p}</li>)}
              </ol>
            )}
          </div>
        )}

        {/* ── The consent hand-off. A confirm step, never an auto-redirect. ── */}
        {consent && (
          <div className="mt-3 bg-white border border-[#E0D0BE] rounded-lg px-3.5 py-3">
            <p className="text-[12.5px] font-bold text-[#2D1B0E] flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4 text-[#af4408]" />
              Before you continue to Google
            </p>
            <p className="text-[12px] text-[#6B5744] mt-1 leading-snug">{consent.note}</p>
            <p className="text-[11px] text-[#8B7355] mt-1.5">
              Google will return to <span className="font-mono break-all">{consent.redirect}</span> — that exact string must
              already be listed in the OAuth client&rsquo;s Authorised redirect URIs, or Google will refuse with redirect_uri_mismatch.
            </p>
            <div className="flex flex-wrap gap-2 mt-2.5">
              <a
                href={consent.url}
                className="px-3.5 py-2 bg-[#af4408] hover:bg-[#963a06] text-white rounded-lg text-[12px] font-bold inline-flex items-center gap-1.5"
              >
                Continue to Google <ExternalLink className="w-3.5 h-3.5" />
              </a>
              <button onClick={() => setConsent(null)} className="px-3 py-2 text-[12px] font-semibold text-[#8B7355] hover:text-[#af4408]">
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* ── Choose the listing ──────────────────────────────────────────── */}
        {isAdmin && health.connected && (
          <div className="mt-3">
            {accounts === null ? (
              (view.cta === 'choose_location' || expanded) && (
                <button
                  onClick={loadLocations}
                  disabled={busy === 'locations'}
                  className="inline-flex items-center gap-1.5 px-3 py-2 bg-white border border-[#E0D0BE] hover:bg-[#FFF1E3] rounded-lg text-[12px] font-semibold text-[#6B5744]"
                >
                  {busy === 'locations' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MapPin className="w-3.5 h-3.5" />}
                  {health.location_name ? 'Change the listing' : 'Choose the listing to track'}
                </button>
              )
            ) : (
              <div className="bg-white border border-[#E0D0BE] rounded-lg p-3">
                <p className="text-[12px] font-bold text-[#2D1B0E] mb-2">
                  Listings this Google account manages
                </p>
                {accounts.length === 0 ? (
                  <Empty>
                    This account manages no Business Profile listings the API can see. Being able to see the
                    listing on Maps is not the same as managing it — connect the account that does.
                  </Empty>
                ) : (
                  <div className="space-y-3">
                    {accounts.map(acc => (
                      <div key={acc.name}>
                        <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">
                          {acc.label || acc.name}
                        </p>
                        <div className="mt-1 space-y-1">
                          {acc.locations.map(loc => {
                            const active = loc.name === health.location_name;
                            return (
                              <button
                                key={loc.name}
                                onClick={() => chooseLocation(acc, loc)}
                                disabled={busy === loc.name}
                                className={`w-full text-left px-3 py-2 rounded-lg border text-[12px] transition-colors ${
                                  active
                                    ? 'bg-[#FFF1E3] border-[#af4408]'
                                    : 'bg-white border-[#E8D5C4] hover:bg-[#FFF8F0]'
                                }`}
                              >
                                <span className="font-semibold text-[#2D1B0E]">{loc.label || loc.name}</span>
                                {active && <span className="ml-2 text-[10px] font-bold text-[#af4408]">TRACKED</span>}
                                {loc.address && <span className="block text-[11px] text-[#8B7355]">{loc.address}</span>}
                                <span className="block text-[10px] text-[#B09A82] font-mono break-all mt-0.5">{loc.name}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <button onClick={() => setAccounts(null)} className="mt-2 text-[11px] font-semibold text-[#8B7355] hover:text-[#af4408]">
                  Close
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── Setup & schedule (admin, collapsed by default) ──────────────── */}
        {isAdmin && expanded && (
          <div className="mt-3 bg-white border border-[#E0D0BE] rounded-lg p-3.5 space-y-3">

            {/* Schedule */}
            {health.connected && !!health.location_name && conn && setup && (
              <div>
                <p className="text-[12px] font-bold text-[#2D1B0E]">Scheduled refresh</p>
                <p className="text-[11px] text-[#8B7355] mt-0.5 leading-snug">
                  This is what makes the module automatic. With it off, reviews arrive only when someone
                  presses Refresh now — and nobody presses a button they have no reason to think is needed.
                </p>
                <div className="flex flex-wrap items-center gap-2 mt-2">
                  <button
                    onClick={() => setSchedule(!conn.auto_enabled)}
                    disabled={busy === 'schedule'}
                    className={`px-3.5 py-2 rounded-lg text-[12px] font-bold ${
                      conn.auto_enabled
                        ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                        : 'bg-[#af4408] hover:bg-[#963a06] text-white'
                    }`}
                  >
                    {busy === 'schedule' ? 'Saving…' : conn.auto_enabled ? 'On — switch off' : 'Switch on'}
                  </button>
                  <label className="text-[11px] text-[#6B5744] flex items-center gap-1.5">
                    every
                    <select
                      value={conn.interval_minutes}
                      onChange={e => setSchedule(conn.auto_enabled, Number(e.target.value))}
                      disabled={busy === 'schedule'}
                      className="border border-[#E0D0BE] rounded-md px-2 py-1 bg-white text-[11px]"
                    >
                      {[60, 120, 180, 360, 720, 1440].filter(
                        m => m >= setup.interval_bounds.min && m <= setup.interval_bounds.max,
                      ).map(m => (
                        <option key={m} value={m}>{intervalText(m).replace('every ', '')}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <p className="text-[11px] text-[#8B7355] mt-1.5 leading-snug">
                  The schedule only runs when something ticks it: the app&rsquo;s own scheduler, or an external cron
                  calling <span className="font-mono">POST /api/crm-calls/reviews/refresh?auto=1</span> with the{' '}
                  <span className="font-mono">x-cron-token</span>{' '}header. Switching this on does not by itself
                  prove a tick is happening — the &ldquo;Last fetch&rdquo; time above is the only proof of that.
                </p>
              </div>
            )}

            {/* OAuth app */}
            <div className="border-t border-[#F0E4D6] pt-3">
              <p className="text-[12px] font-bold text-[#2D1B0E]">The Google OAuth client</p>
              {setup ? (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-1.5">
                    <MiniFact label="Client ID" ok={!!setup.client_id}>
                      {setup.client_id ? <span className="font-mono text-[10px] break-all">{setup.client_id}</span> : 'not set'}
                    </MiniFact>
                    <MiniFact label="Client secret" ok={setup.client_secret_set}>
                      {setup.client_secret_set ? 'set (never shown)' : 'not set'}
                    </MiniFact>
                    <MiniFact label="Refresh token" ok={setup.refresh_token_set}>
                      {setup.refresh_token_set ? 'held (never shown)' : 'not held'}
                    </MiniFact>
                  </div>

                  <div className="mt-2.5">
                    <p className="text-[11px] font-semibold text-[#6B5744]">Authorised redirect URI — paste this into the OAuth client, exactly</p>
                    <div className="flex items-center gap-2 mt-1">
                      <code className="flex-1 min-w-0 text-[11px] bg-[#FFF8F0] border border-[#E8D5C4] rounded-md px-2 py-1.5 break-all">
                        {setup.redirect_uri}
                      </code>
                      <button
                        onClick={() => {
                          navigator.clipboard?.writeText(setup.redirect_uri).then(
                            () => { setCopied(true); setTimeout(() => setCopied(false), 1800); },
                            () => {},
                          );
                        }}
                        className="shrink-0 p-1.5 border border-[#E0D0BE] rounded-md hover:bg-[#FFF1E3]"
                        title="Copy"
                      >
                        {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5 text-[#8B7355]" />}
                      </button>
                    </div>
                  </div>

                  {!setup.oauth_app_configured && (
                    <p className="text-[11px] text-amber-800 mt-2 font-medium">
                      The client ID and secret are set in Settings, not here — this page will not ask for a secret
                      it would then have to display. Until both are saved, Connect stays disabled.
                    </p>
                  )}

                  <details className="mt-2.5">
                    <summary className="text-[11px] font-semibold text-[#af4408] cursor-pointer">
                      What the owner must do at Google, in order ({setup.prerequisites.length} steps)
                    </summary>
                    <ol className="list-decimal pl-4 mt-1.5 space-y-1 text-[11px] text-[#6B5744]">
                      {setup.prerequisites.map((p, i) => <li key={i}>{p}</li>)}
                    </ol>
                  </details>

                  <div className="mt-2.5 bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg px-3 py-2">
                    <p className="text-[11px] font-bold text-[#2D1B0E] flex items-center gap-1.5">
                      <Info className="w-3.5 h-3.5 text-[#af4408]" />
                      Not yet proven against a live Google account
                    </p>
                    <ul className="list-disc pl-4 mt-1 space-y-0.5 text-[11px] text-[#6B5744]">
                      {setup.unproven.map((u, i) => <li key={i}>{u}</li>)}
                    </ul>
                  </div>

                  {health.connected && (
                    <button
                      onClick={disconnect}
                      disabled={busy === 'disconnect'}
                      className="mt-3 px-3 py-1.5 border border-red-300 text-red-700 hover:bg-red-50 rounded-lg text-[11px] font-semibold"
                    >
                      {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect Google account'}
                    </button>
                  )}
                </>
              ) : (
                <p className="text-[11px] text-[#8B7355] mt-1">Loading setup detail…</p>
              )}
            </div>
          </div>
        )}

        {/* ── The sentence that keeps a URL box from being added later ─────── */}
        {!health.connected && (
          <p className="text-[11px] text-[#8B7355] mt-3 pt-3 border-t border-black/5 leading-snug">
            There is no box here for a Google Maps link, and that is deliberate. Google only releases a
            listing&rsquo;s review history to an account that <span className="font-semibold">manages</span> it, through the
            consent screen above. The public Places API caps out at five reviews, ordered by relevance rather
            than date — it cannot answer a single question this page asks. Until the connection is live, use{' '}
            <span className="font-semibold">Import a file</span> to backfill from a Google Takeout export; it needs no
            approval and produces the same rows.
          </p>
        )}
      </div>
    </section>
  );
}

function Fact({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-semibold text-[#8B7355] uppercase tracking-wider flex items-center gap-1">
        {icon}{label}
      </p>
      <div className="text-[12px] font-semibold text-[#2D1B0E] mt-0.5 break-words">{children}</div>
    </div>
  );
}

function MiniFact({ label, ok, children }: { label: string; ok: boolean; children: React.ReactNode }) {
  return (
    <div className={`rounded-md border px-2 py-1.5 ${ok ? 'bg-emerald-50 border-emerald-200' : 'bg-[#FFF8F0] border-[#E8D5C4]'}`}>
      <p className="text-[10px] font-semibold text-[#8B7355] uppercase tracking-wider">{label}</p>
      <div className="text-[11px] font-semibold text-[#2D1B0E] mt-0.5">{children}</div>
    </div>
  );
}

/* ── Headline tiles ────────────────────────────────────────────────────────── */

/**
 * One headline tile.
 *
 * The three-way decision — a gap in the data, a genuinely quiet period, or a
 * real average — is NOT made here. It comes from periodTileView() in
 * src/lib/reviews/view.ts, which is pure and gated (sections V and W of
 * scripts/reviews-tests.js). This component paints the verdict and nothing
 * more, which is what stops the "0.0 stars" and "no complaints this week"
 * failures from creeping back in behind a UI tweak.
 */
function PeriodTile({ block, lastImport, coverageEnd, now }: {
  block: HeadBlock; lastImport: string | null; coverageEnd?: string | null; now?: number;
}) {
  const v = periodTileView(block, { now });
  const unitWord = block.period === 'daily' ? 'day' : block.period === 'weekly' ? 'week' : 'month';
  const rangeLabel = block.period === 'daily'
    ? fmtDayKey(block.start_date)
    : `${fmtDayKey(block.start_date, { year: false })} – ${fmtDayKey(block.end_date)}`;
  const gap = v.state === 'not_imported';

  return (
    <div className={`bg-white border rounded-xl p-3.5 ${gap ? 'border-amber-300' : 'border-[#E8D5C4]'}`}>
      <div className="flex items-baseline justify-between gap-2">
        {/* "so far" comes from the view layer, not from a ternary up here — the
            same function decides the heading and the comparison, so the tile can
            never say "This month" over a part-period comparison. */}
        <p className="text-[11px] font-semibold text-[#6B5744] uppercase tracking-wider">{v.headingText}</p>
        <p className="text-[10px] text-[#8B7355]">{rangeLabel}</p>
      </div>
      {v.partial && v.progressText && (
        <p className="text-[10px] text-amber-700 mt-0.5">{v.progressText} — still running</p>
      )}

      {gap ? (
        <>
          <p className="text-lg font-bold mt-1.5 text-amber-700">{v.countText}</p>
          <p className="text-[11px] text-amber-800 mt-1 leading-snug">
            {coverageEnd
              ? `What we hold reaches only to ${fmtDate(coverageEnd)}, before this ${unitWord} began.`
              : lastImport
                ? `Nothing we hold reaches into this ${unitWord}.`
                : 'Nothing has ever been imported for this listing.'}
            {' '}Zero here is a gap in the data, not a quiet {unitWord}.
          </p>
        </>
      ) : v.state === 'no_reviews' ? (
        <>
          <p className="text-2xl font-bold mt-1 text-[#8B7355]">{v.countText}</p>
          <p className="text-[11px] text-[#8B7355] mt-1 leading-snug">
            Nothing posted in this period. No rating to average.
            {block.prev_count > 0 && block.prev_average != null &&
              ` Previous: ${block.prev_count} at ${block.prev_average.toFixed(2)}.`}
          </p>
        </>
      ) : (
        <>
          <div className="flex items-baseline gap-2 mt-1">
            <p className="text-2xl font-bold text-[#2D1B0E] tabular-nums">{v.count}</p>
            <span className="text-[11px] text-[#8B7355]">review{v.count === 1 ? '' : 's'}</span>
          </div>
          <div className="flex items-center gap-1.5 mt-1">
            {/* ratingValue is null unless the engine produced a real average.
                No `?? 0`, no `|| 0` — that coalesce IS the bug. */}
            {v.ratingValue == null ? (
              <span className="text-[12px] font-semibold text-[#8B7355]">{v.ratingText}</span>
            ) : (
              <>
                <span className="text-base font-bold text-[#af4408] tabular-nums">{v.ratingValue.toFixed(2)}</span>
                <Stars value={v.ratingValue} size={12} />
              </>
            )}
          </div>
          <div className="mt-1.5">
            {v.showDelta
              ? <Delta block={block} />
              : <p className="text-[11px] text-[#8B7355] leading-snug">{v.deltaNote || v.note}</p>}
          </div>
        </>
      )}
    </div>
  );
}

function Delta({ block }: { block: HeadBlock }) {
  const prevLabel = block.period === 'daily' ? 'yesterday' : block.period === 'weekly' ? 'last week' : 'last month';

  if (block.prev_count === 0) {
    return (
      <p className="text-[11px] text-[#8B7355] leading-snug">
        {block.prev_import_covers
          ? `No reviews ${prevLabel}, so there is nothing to compare against.`
          : `Nothing imported covering ${prevLabel}, so no comparison is possible.`}
      </p>
    );
  }

  const up = block.direction === 'up';
  const down = block.direction === 'down';
  const Icon = up ? TrendingUp : down ? TrendingDown : Minus;
  const cls = up ? 'text-emerald-700' : down ? 'text-red-700' : 'text-[#8B7355]';

  return (
    <p className={`text-[11px] leading-snug flex items-start gap-1 ${cls}`}>
      <Icon className="w-3.5 h-3.5 mt-px shrink-0" />
      <span>
        {block.avg_delta == null
          ? 'Rating change not comparable'
          : `${block.avg_delta > 0 ? '+' : ''}${block.avg_delta.toFixed(2)} stars`}
        {' '}vs {prevLabel}
        <span className="text-[#8B7355]">
          {' '}({block.prev_count} at {block.prev_average?.toFixed(2)}
          {block.count_delta != null && <>, volume {block.count_delta > 0 ? '+' : ''}{block.count_delta}</>})
        </span>
      </span>
    </p>
  );
}

function AllTimeTile({ all, summary }: { all: Report['headline']['all_time']; summary: Report['summary'] }) {
  return (
    <div className="bg-[#2D1B0E] text-[#FFF8F0] border border-[#2D1B0E] rounded-xl p-3.5">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-[#E8C9A8]">
        {all.complete ? 'All time' : 'All history held'}
      </p>
      {all.total === 0 ? (
        <>
          <p className="text-2xl font-bold mt-1">No reviews</p>
          <p className="text-[11px] text-[#E8C9A8] mt-1">Nothing has been imported for this listing.</p>
        </>
      ) : all.average == null ? (
        // A stored total with no average would be a contradiction in the
        // engine's output. Say that, rather than printing "0.00" over stars.
        <>
          <p className="text-2xl font-bold mt-1">No rating</p>
          <p className="text-[11px] text-[#E8C9A8] mt-1">
            {all.total} review{all.total === 1 ? '' : 's'} held, none carrying a usable star rating.
          </p>
        </>
      ) : (
        <>
          <div className="flex items-baseline gap-2 mt-1">
            <p className="text-3xl font-bold tabular-nums">{all.average.toFixed(2)}</p>
            <Stars value={all.average} size={13} dark />
          </div>
          <p className="text-[12px] text-[#E8C9A8] mt-1">
            over {all.total} review{all.total === 1 ? '' : 's'}
            {all.first_at && <> since {fmtDate(all.first_at)}</>}
          </p>
          <p className="text-[11px] text-[#C9AE93] mt-1.5 leading-snug">
            {all.low_count} at 1–2 stars ({all.total ? Math.round((all.low_count / all.total) * 100) : 0}%)
            {summary.reply.reply_rate != null && <> · {Math.round(summary.reply.reply_rate * 100)}% answered</>}
          </p>
        </>
      )}
    </div>
  );
}

/* ── Review card ───────────────────────────────────────────────────────────── */

/* ── Reply composer (admin) ────────────────────────────────────────────────────
 *
 * THE THREE CHECKS, AS A SCREEN. The owner asked for "2-3 checks before
 * Submiting to google so can check any mistakes before submitting to google",
 * and they are the ONLY undo that exists: a reply is public the instant Google's
 * PUT returns, under the business's own name, and Google offers no way to take
 * it back.
 *
 *   1. PREVIEW  — stage 'preview' shows the exact words that will appear
 *                 publicly, directly beside the review being answered, so a
 *                 mismatch is visible rather than imagined.
 *   2. VALIDATE — validateReply() runs here as the admin types (live byte
 *                 counter, instant findings) AND on the server when the preview
 *                 opens, which adds the two things a browser cannot know:
 *                 whether the review is addressable on Google at all, and
 *                 whether this reply nearly repeats a recently published one.
 *   3. CONFIRM  — stage 'confirm' names the business out loud and posts nothing
 *                 until it is pressed. The business name is echoed back to the
 *                 route, which refuses a send that cannot name it — that is what
 *                 makes this a check instead of a checkbox.
 *
 * WHY THREE STAGES AND NOT ONE FORM WITH A BUTTON: the failure this prevents is
 * an admin with 5,564 unanswered reviews building muscle memory. A single Send
 * button next to a textarea becomes one click; three stages that each show
 * something different cannot be completed without reading.
 *
 * THE AI DRAFT IS A STARTING POINT AND NOTHING MORE. It lands in the same
 * textarea as typed text, it is validated by the same function, and it goes
 * through the same three stages. If AI is off or the model fails, everything
 * here still works by typing — a drafting feature that breaks sending when it is
 * unavailable would be worse than no drafting feature.
 */

interface ReplyCheckResponse {
  ok?: boolean;
  error?: string;
  can_send?: boolean;
  validation?: { ok: boolean; blocking: ReplyFinding[]; warnings: ReplyFinding[]; bytes: number; chars: number };
  target?: { review_name: string; basis: string } | null;
  target_error?: { code: string; message: string } | null;
  is_edit?: boolean;
  existing_reply?: string;
  business_label?: string;
  max_bytes?: number;
  history?: Array<{
    id: string; comment: string; actor: string; origin: string; status: string;
    reply_state: string; is_edit: number; error: string; started_at: string;
  }>;
}

interface DraftResponse {
  ok?: boolean;
  status?: string;
  message?: string;
  model?: string;
  draft?: { reply: string; answers: string[]; return_reason: string; cautions: string[] };
  disclaimer?: string;
}

interface SendResponse {
  ok?: boolean;
  error?: string;
  code?: string;
  findings?: ReplyFinding[];
  published?: 'no' | 'unknown';
  published_note?: string;
  note?: string;
  reply_state?: string;
  live?: boolean;
}

function ReplyComposer({ r, locationKey, onSent }: {
  r: ReviewCard; locationKey: string; onSent: () => void;
}) {
  const [stage, setStage] = useState<'closed' | 'compose' | 'preview' | 'confirm' | 'done'>('closed');
  const [text, setText] = useState('');
  /** Whether a model wrote the text currently in the box, and whether the admin
   *  has edited it since. Recorded with the send: worth knowing, in six months,
   *  which replies on the listing a model wrote. Gates nothing. */
  const [draftedText, setDraftedText] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftResponse | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [check, setCheck] = useState<ReplyCheckResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [acked, setAcked] = useState<Record<string, boolean>>({});
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<SendResponse | null>(null);
  const [err, setErr] = useState('');

  /* Check 2, live, from the same function the server runs. The counter has to be
   * in BYTES: Google's 4096 is a byte limit, and a Telugu character is three
   * bytes, so a character counter would lie at exactly the wrong moment. */
  const local = useMemo(() => validateReply({
    comment: text,
    review: {
      text: r.text, rating: r.rating,
      author_name: r.author_name, author_is_anonymous: r.author_is_anonymous,
      language: r.language,
    },
  }), [text, r.text, r.rating, r.author_name, r.author_is_anonymous, r.language]);

  const maxBytes = check?.max_bytes ?? 4096;
  const bytes = replyBytes(text);

  const reset = () => {
    setStage('closed'); setText(''); setDraft(null); setDraftedText(null);
    setCheck(null); setAcked({}); setSent(null); setErr('');
  };

  const runCheck = async (): Promise<ReplyCheckResponse | null> => {
    setChecking(true); setErr('');
    try {
      const res = await api('/api/crm-calls/reviews/reply/check', {
        method: 'POST',
        body: { review_id: r.id, comment: text, location_key: locationKey },
      });
      const j: ReplyCheckResponse = await res.json();
      if (!res.ok) { setErr(j.error || `Check failed (HTTP ${res.status})`); setCheck(null); return null; }
      setCheck(j);
      return j;
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not reach the server to check the reply');
      return null;
    } finally { setChecking(false); }
  };

  const getDraft = async () => {
    setDrafting(true); setErr(''); setDraft(null);
    try {
      const res = await api('/api/crm-calls/reviews/reply/draft', {
        method: 'POST',
        body: { review_id: r.id, location_key: locationKey },
      });
      const j: DraftResponse = await res.json();
      setDraft(j);
      if (j.ok && j.draft?.reply) {
        setText(j.draft.reply);
        setDraftedText(j.draft.reply);
        // A new draft invalidates any acknowledgement made about the old text.
        setAcked({});
      }
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not reach the server for a draft');
    } finally { setDrafting(false); }
  };

  const send = async () => {
    if (!check) return;
    setSending(true); setErr('');
    try {
      const res = await api('/api/crm-calls/reviews/reply', {
        method: 'POST',
        body: {
          review_id: r.id,
          comment: text,
          location_key: locationKey,
          origin: draftedText == null ? 'typed'
            : draftedText === text ? 'ai_draft_unchanged' : 'ai_draft_edited',
          confirm: {
            public: true,
            business: check.business_label || '',
            acknowledged: (check.validation?.warnings || []).map(w => w.code).filter(c => acked[c]),
            overwrite: !!check.is_edit,
          },
        },
      });
      const j: SendResponse = await res.json();
      setSent(j);
      if (res.ok) { setStage('done'); onSent(); }
      else setErr(j.error || `Send failed (HTTP ${res.status})`);
    } catch (e: unknown) {
      // A network error here is the ambiguous case: the request may have reached
      // Google. Say so rather than implying nothing happened.
      setErr((e instanceof Error ? e.message : 'The request failed')
        + ' — the connection dropped, so it is not certain whether the reply reached Google. '
        + 'Check the review on Google before sending again.');
    } finally { setSending(false); }
  };

  /* ── Closed: one button, and it says which of the two things it does. ───── */
  if (stage === 'closed') {
    return (
      <div className="mt-2.5">
        <button
          onClick={() => { setStage('compose'); setText(r.replied ? r.reply_text : ''); }}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border border-[#E0D0BE] bg-white hover:bg-[#FFF1E3] text-[#6B5744]"
        >
          {r.replied ? <><Pencil className="w-3.5 h-3.5" /> Edit the public reply</>
            : <><MessageSquare className="w-3.5 h-3.5" /> Reply from here</>}
        </button>
      </div>
    );
  }

  /* ── Sent. ──────────────────────────────────────────────────────────────── */
  if (stage === 'done' && sent) {
    const rejected = sent.reply_state === 'REJECTED';
    return (
      <div className={`mt-2.5 rounded-lg border p-3 ${rejected
        ? 'border-red-300 bg-red-50' : sent.live ? 'border-emerald-300 bg-emerald-50' : 'border-amber-300 bg-amber-50'}`}>
        <p className="text-[12px] font-semibold flex items-center gap-1.5">
          {rejected ? <><ShieldAlert className="w-4 h-4 text-red-600" /> Google rejected it</>
            : sent.live ? <><Globe className="w-4 h-4 text-emerald-700" /> Published on Google</>
            : <><Clock className="w-4 h-4 text-amber-700" /> Sent — Google is holding it</>}
        </p>
        <p className="text-[12px] text-[#3D2A1A] mt-1">{sent.note}</p>
        <button onClick={reset} className="mt-2 text-[11px] font-semibold text-[#af4408] underline">Close</button>
      </div>
    );
  }

  const warnings = check?.validation?.warnings || [];
  const unacked = warnings.filter(w => !acked[w.code]);
  const serverBlocking = check?.validation?.blocking || [];
  const canContinue = !!check && !!check.target && serverBlocking.length === 0 && unacked.length === 0;

  return (
    <div className="mt-2.5 rounded-lg border border-[#E0D0BE] bg-[#FFFDFB] p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <p className="text-[11px] font-bold text-[#2D1B0E] uppercase tracking-wide">
          {stage === 'compose' ? 'Step 1 of 3 · Write' : stage === 'preview' ? 'Step 2 of 3 · Check' : 'Step 3 of 3 · Confirm'}
        </p>
        <button onClick={reset} title="Cancel" className="text-[#8B7355] hover:text-[#2D1B0E]">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* ── STAGE 1: WRITE ── */}
      {stage === 'compose' && (
        <>
          {r.replied && (
            <Note tone="warn">
              A reply is already public on this review. Sending replaces it — the text below is what
              guests are reading now, and Google keeps no history of what it replaced.
            </Note>
          )}
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            rows={6}
            placeholder="Write the reply this guest will read. Answer what they actually said, and give them a reason to come back."
            className="w-full mt-2 px-3 py-2 text-[13px] rounded-lg border border-[#E0D0BE] bg-white focus:outline-none focus:border-[#af4408] resize-y"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 mt-1.5">
            <span className={`text-[11px] tabular-nums ${bytes > maxBytes ? 'text-red-600 font-bold' : 'text-[#8B7355]'}`}>
              {bytes} / {maxBytes} bytes
              <span className="text-[#A89480]"> · {[...text].length} characters</span>
            </span>
            <button
              onClick={getDraft}
              disabled={drafting}
              title="Ask the model for a first draft written to bring this guest back. You edit it; nothing is sent."
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border border-[#E0D0BE] bg-white hover:bg-[#FFF1E3] text-[#6B5744] disabled:opacity-50"
            >
              {drafting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              {drafting ? 'Drafting…' : 'AI draft'}
            </button>
          </div>

          {/* The draft's own account of itself. `answers` is the accountability
              field: if it is empty for a review with real content, the model did
              not engage with what the guest wrote. */}
          {draft && !draft.ok && (
            <Note tone="warn">
              {draft.message || 'The draft is not available.'}
              {' '}Type the reply instead — sending does not need the draft.
            </Note>
          )}
          {draft?.ok && draft.draft && (
            <div className="mt-2 rounded-lg border border-[#D9C3AC] bg-[#FFF8F0] p-2.5">
              <p className="text-[10.5px] font-bold uppercase tracking-wide text-[#8B6B45] flex items-center gap-1">
                <Sparkles className="w-3 h-3" /> AI draft{draft.model ? ` · ${draft.model}` : ''}
              </p>
              <p className="text-[11px] text-[#6B5744] mt-1">{draft.disclaimer}</p>
              {draft.draft.answers.length > 0 ? (
                <p className="text-[11px] text-[#3D2A1A] mt-1.5">
                  <span className="font-semibold">It answers:</span> {draft.draft.answers.join(' · ')}
                </p>
              ) : r.text.trim().length > 40 && (
                <p className="text-[11px] text-red-700 mt-1.5 font-semibold">
                  It did not name one specific thing from this review. A reply that could sit under any
                  review convinces nobody — rewrite it or draft again.
                </p>
              )}
              {draft.draft.return_reason && (
                <p className="text-[11px] text-[#3D2A1A] mt-1">
                  <span className="font-semibold">Reason to come back:</span> {draft.draft.return_reason}
                  <span className="text-[#8B7355]"> — check this is something the restaurant really offers.</span>
                </p>
              )}
              {draft.draft.cautions.length > 0 && (
                <p className="text-[11px] text-amber-800 mt-1">
                  <span className="font-semibold">For you to decide:</span> {draft.draft.cautions.join(' · ')}
                </p>
              )}
            </div>
          )}

          <FindingList findings={[...local.blocking, ...local.warnings]} />

          <div className="flex items-center gap-2 mt-2.5">
            <button
              onClick={async () => { const j = await runCheck(); if (j) setStage('preview'); }}
              disabled={!local.ok || checking}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold bg-[#af4408] text-white hover:bg-[#963a06] disabled:opacity-40"
            >
              {checking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}
              Preview what guests will see
            </button>
            {!local.ok && (
              <span className="text-[11px] text-red-700 font-semibold">Fix the items above first.</span>
            )}
          </div>
        </>
      )}

      {/* ── STAGE 2: CHECK — the exact words, beside the review ── */}
      {stage === 'preview' && (
        <>
          <div className="grid gap-2.5 md:grid-cols-2">
            <div className="rounded-lg border border-[#E8D5C4] bg-white p-2.5">
              <p className="text-[10.5px] font-bold uppercase tracking-wide text-[#8B7355]">
                {r.author_is_anonymous || !r.author_name ? 'A Google user' : r.author_name} · {r.rating}★
              </p>
              <p className="text-[12px] text-[#3D2A1A] mt-1 whitespace-pre-wrap">
                {r.text || 'Rating only — the guest left no words.'}
              </p>
            </div>
            <div className="rounded-lg border-2 border-[#af4408] bg-white p-2.5">
              <p className="text-[10.5px] font-bold uppercase tracking-wide text-[#af4408]">
                Your reply, exactly as it will appear
              </p>
              <p className="text-[12px] text-[#2D1B0E] mt-1 whitespace-pre-wrap">{text}</p>
            </div>
          </div>

          {check?.target_error && (
            <Note tone="warn">{check.target_error.message}</Note>
          )}

          <FindingList findings={serverBlocking} />

          {/* Warnings are acknowledged ONE BY ONE. A single "I understand" box
              would be ticked without reading; a box per finding makes the admin
              look at each one. The route re-checks every code. */}
          {warnings.length > 0 && (
            <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-2.5">
              <p className="text-[11px] font-bold text-amber-900 uppercase tracking-wide">
                Accept each of these before it can be published
              </p>
              {warnings.map(w => (
                <label key={w.code} className="flex items-start gap-2 mt-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!acked[w.code]}
                    onChange={e => setAcked(a => ({ ...a, [w.code]: e.target.checked }))}
                    className="mt-0.5 shrink-0"
                  />
                  <span className="text-[11.5px] text-[#3D2A1A]">
                    <span className="font-bold">{w.label}.</span> {w.detail}
                  </span>
                </label>
              ))}
            </div>
          )}

          {check?.history && check.history.length > 0 && (
            <div className="mt-2 rounded-lg border border-[#E8D5C4] bg-white p-2.5">
              <p className="text-[10.5px] font-bold uppercase tracking-wide text-[#8B7355]">
                Already sent from this app
              </p>
              {check.history.slice(0, 3).map(h => (
                <p key={h.id} className="text-[11px] text-[#6B5744] mt-1">
                  {fmtDateTime(h.started_at)} · {h.actor || 'unknown'} · {h.status}
                  {h.reply_state ? ` (${h.reply_state})` : ''}
                  {h.is_edit ? ' · replaced an earlier public reply' : ''}
                </p>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 mt-2.5">
            <button
              onClick={() => setStage('compose')}
              className="px-3 py-1.5 rounded-lg text-[11px] font-semibold border border-[#E0D0BE] bg-white text-[#6B5744]"
            >
              Back to editing
            </button>
            <button
              onClick={() => setStage('confirm')}
              disabled={!canContinue}
              className="px-3 py-1.5 rounded-lg text-[11px] font-bold bg-[#af4408] text-white hover:bg-[#963a06] disabled:opacity-40"
            >
              This is right — continue
            </button>
            {!check?.target && !check?.target_error && (
              <span className="text-[11px] text-[#8B7355]">Checking whether this review can be answered…</span>
            )}
          </div>
        </>
      )}

      {/* ── STAGE 3: CONFIRM — name the business out loud ── */}
      {stage === 'confirm' && (
        <>
          <div className="rounded-lg border-2 border-red-400 bg-red-50 p-3">
            <p className="text-[12px] font-bold text-red-900 flex items-center gap-1.5">
              <Globe className="w-4 h-4" /> This becomes public immediately
            </p>
            <p className="text-[12px] text-[#3D2A1A] mt-1.5">
              The reply below will be posted on Google as{' '}
              <span className="font-bold">{check?.business_label || 'the connected business'}</span>,
              where every future guest reading this review will see it.{' '}
              <span className="font-bold">Google has no undo</span> — it cannot be withdrawn from here
              or anywhere else. {check?.is_edit
                ? 'It replaces the reply that is on the listing now, which guests have already been reading.'
                : ''}
            </p>
            <p className="text-[12px] text-[#2D1B0E] mt-2 p-2 bg-white rounded border border-red-200 whitespace-pre-wrap">
              {text}
            </p>
          </div>

          {err && <Note tone="warn">{err}</Note>}
          {sent?.published === 'unknown' && (
            <Note tone="warn">{sent.published_note}</Note>
          )}

          <div className="flex flex-wrap items-center gap-2 mt-2.5">
            <button
              onClick={() => setStage('preview')}
              className="px-3 py-1.5 rounded-lg text-[11px] font-semibold border border-[#E0D0BE] bg-white text-[#6B5744]"
            >
              Back
            </button>
            <button
              onClick={send}
              disabled={sending}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[11.5px] font-bold bg-red-700 text-white hover:bg-red-800 disabled:opacity-50"
            >
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              {sending ? 'Posting…' : `Post publicly to Google as ${check?.business_label || 'this business'}`}
            </button>
          </div>
        </>
      )}

      {err && stage !== 'confirm' && <Note tone="warn">{err}</Note>}
    </div>
  );
}

/** Findings, each naming itself. "Invalid" at the moment of publishing tells an
 *  admin nothing about what to change, which is why every code carries its own
 *  label and sentence. */
function FindingList({ findings }: { findings: ReplyFinding[] }) {
  if (!findings.length) return null;
  return (
    <div className="mt-2 space-y-1.5">
      {findings.map(f => (
        <div
          key={f.code}
          className={`text-[11.5px] rounded-lg px-2.5 py-1.5 border ${f.severity === 'blocking'
            ? 'border-red-300 bg-red-50 text-red-900' : 'border-amber-300 bg-amber-50 text-amber-900'}`}
        >
          <span className="font-bold">
            {f.severity === 'blocking' ? 'Cannot send' : 'Check'} · {f.label}.
          </span>{' '}
          {f.detail}
        </div>
      ))}
    </div>
  );
}

function ReviewRowCard({ r, link, canReply, locationKey, onReplied }: {
  r: ReviewCard; link: Report['reply_link'];
  /** Admin only. False for a manager, who sees the review and nothing actionable. */
  canReply?: boolean;
  locationKey?: string;
  onReplied?: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const author = r.author_is_anonymous || !r.author_name ? 'A Google user' : r.author_name;
    const blob = `${author} · ${r.rating}★ · ${fmtDate(r.posted_at)}\n\n${r.text}`;
    try {
      await navigator.clipboard.writeText(blob);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard blocked — the text is on screen anyway */ }
  };

  const border = r.rating <= 2 ? 'border-l-4 border-l-red-500'
    : r.rating === 3 ? 'border-l-4 border-l-amber-500'
    : 'border-l-4 border-l-[#E8D5C4]';

  return (
    <div className={`bg-white border border-[#E8D5C4] rounded-xl p-3.5 ${border}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold tabular-nums">{r.rating}</span>
            <Stars value={r.rating} size={13} />
            <span className="text-sm font-semibold text-[#2D1B0E] truncate">
              {r.author_is_anonymous || !r.author_name
                ? <span className="italic font-normal text-[#8B7355]">A Google user</span>
                : r.author_name}
            </span>
            <span className="text-[11px] text-[#8B7355]">
              {r.posted_precision === 'day' ? fmtDate(r.posted_at) : fmtDateTime(r.posted_at)}
              {r.posted_precision === 'day' && <span title="The source gave a date but no time"> (date only)</span>}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
            {r.is_major && <Badge tone="red">Needs attention · score {r.score}</Badge>}
            {!r.replied && <Badge tone="amber">Unanswered</Badge>}
            {r.replied && <Badge tone="green">Answered</Badge>}
            {r.reasons.map(x => (
              <Badge key={x} tone="plain">
                {REASON_LABEL[x] || x}
                {x === 'below_norm' && r.baseline != null && ` (${r.baseline.toFixed(2)} trailing)`}
              </Badge>
            ))}
            {r.identity_basis === 'composite_anon' && (
              <Badge tone="plain" title="Anonymous author with no review id: an edit to this review would arrive as a new row rather than updating this one.">
                Weak identity
              </Badge>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={copy}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border border-[#E0D0BE] bg-white hover:bg-[#FFF1E3] text-[#6B5744]"
            title="Copy the author, rating, date and text — enough to find this review in Google’s list"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          {link.url && (
            <a
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              title={link.note}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border border-[#af4408] bg-[#af4408] text-white hover:bg-[#963a06]"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Reply on Google
            </a>
          )}
        </div>
      </div>

      {r.text ? (
        <p className="text-[13px] text-[#3D2A1A] mt-2.5 whitespace-pre-wrap leading-relaxed">{r.text}</p>
      ) : (
        <p className="text-[13px] text-[#8B7355] italic mt-2.5">Rating only — the guest left no words.</p>
      )}

      {r.replied && (
        <div className="mt-2.5 border-l-2 border-[#E8D5C4] pl-3">
          <p className="text-[11px] font-semibold text-[#6B5744]">
            Our reply
            {r.replied_at
              ? <span className="font-normal text-[#8B7355]"> · {fmtDateTime(r.replied_at)}</span>
              : <span className="font-normal text-[#8B7355]"> · the export carried no reply time</span>}
          </p>
          <p className="text-[12px] text-[#6B5744] mt-0.5 whitespace-pre-wrap">{r.reply_text || '—'}</p>
        </div>
      )}

      {/* ADMIN ONLY. A manager gets the card above and nothing below it: reading
          the reviews is management work, publishing under the business's name is
          the owner's. The route enforces the same rule — this only decides what
          is drawn. */}
      {canReply && (
        <ReplyComposer
          r={r}
          locationKey={locationKey || ''}
          onSent={() => onReplied?.()}
        />
      )}
    </div>
  );
}

/* ── Import panel (admin) ──────────────────────────────────────────────────── */

interface ImportResultShape {
  ok: boolean; source: string; source_label: string; documents: number;
  /** Per-file encoding verdicts from the route's byte sniffing. */
  encodings?: Array<{ file: string; encoding: string; fell_back: boolean; replacement_chars: number }>;
  result: {
    run_id: string; rows_seen: number; inserted: number; updated: number; unchanged: number;
    skipped_stale: number; errors: number; weak_identity: number; ambiguous_dates: number;
    /** Documents refused whole because they were structurally unreadable. */
    fatal_documents: number;
    overlong_rows: number; short_rows: number; replacement_chars: number;
    location_overridden: number; location_values: string[];
    parse_errors: Array<{ index: number; reason: string; sample: string }>;
    column_map: Record<string, string>; unmapped_columns: string[];
    reconciliation: { expected_total: number | null; stored_total: number; delta: number | null };
  };
}

function ImportPanel({ sources, locationKey, onClose, onDone }: {
  sources: SourceStatusRow[]; locationKey: string; onClose: () => void; onDone: () => void;
}) {
  const [source, setSource] = useState('takeout_json');
  const [text, setText] = useState('');
  const [files, setFiles] = useState<FileList | null>(null);
  const [expected, setExpected] = useState('');
  const [dateOrder, setDateOrder] = useState<'dmy' | 'mdy'>('dmy');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResultShape | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [prereqs, setPrereqs] = useState<string[] | null>(null);

  const [placeId, setPlaceId] = useState('');
  const [listingUrl, setListingUrl] = useState('');
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsMsg, setSettingsMsg] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch('/api/crm-calls/reviews/settings')
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (!live || !j) return;
        setPlaceId(j.settings?.reviews_place_id || '');
        setListingUrl(j.settings?.reviews_listing_url || '');
      })
      .catch(() => { /* the panel still works without it */ });
    return () => { live = false; };
  }, []);

  const gbp = sources.find(s => s.key === 'gbp_api');
  const isApi = source === 'gbp_api';

  const submit = async () => {
    setBusy(true); setErr(null); setResult(null); setPrereqs(null);
    try {
      let res: Response;
      if (isApi) {
        res = await api('/api/crm-calls/reviews/import', {
          method: 'POST',
          body: { source, location: locationKey, expected_total: expected || null },
        });
      } else {
        const fd = new FormData();
        fd.set('source', source);
        fd.set('location', locationKey);
        fd.set('date_order', dateOrder);
        if (expected) fd.set('expected_total', expected);
        if (text.trim()) fd.set('text', text);
        if (files) for (const f of Array.from(files)) fd.append('file', f);
        res = await api('/api/crm-calls/reviews/import', { method: 'POST', body: fd });
      }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(json?.error || `The import failed (HTTP ${res.status})`);
        if (Array.isArray(json?.prerequisites)) setPrereqs(json.prerequisites);
        return;
      }
      setResult(json as ImportResultShape);
      onDone();
    } catch {
      setErr('The import could not be sent.');
    } finally {
      setBusy(false);
    }
  };

  const saveSettings = async () => {
    setSettingsBusy(true); setSettingsMsg(null);
    try {
      const res = await api('/api/crm-calls/reviews/settings', {
        method: 'PUT',
        body: { settings: { reviews_place_id: placeId, reviews_listing_url: listingUrl } },
      });
      const json = await res.json().catch(() => ({}));
      setSettingsMsg(res.ok ? 'Saved.' : (json?.error || 'Could not save.'));
      if (res.ok) onDone();
    } catch {
      setSettingsMsg('Could not save.');
    } finally {
      setSettingsBusy(false);
    }
  };

  return (
    <div className="bg-white border border-[#af4408] rounded-xl p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h2 className="text-base font-bold flex items-center gap-2">
            <Upload className="w-4 h-4 text-[#af4408]" />Import reviews
          </h2>
          <p className="text-[12px] text-[#8B7355] mt-1 max-w-3xl">
            Importing the same export twice is safe. Every row is written against one identity key, so a
            re-import counts as <span className="font-semibold">already known</span> rather than doubling anything.
          </p>
        </div>
        <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[#FFF1E3] text-[#8B7355]" aria-label="Close import panel">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="space-y-3">
          <div>
            <label htmlFor="rv-source" className="block text-[11px] font-semibold text-[#6B5744] uppercase tracking-wider mb-1">Where the reviews come from</label>
            <select
              id="rv-source" value={source} onChange={e => { setSource(e.target.value); setResult(null); setErr(null); setPrereqs(null); }}
              className="w-full px-3 py-2 border border-[#E0D0BE] rounded-lg text-sm bg-white"
            >
              {sources.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
            <p className="text-[11px] text-[#8B7355] mt-1">{sources.find(s => s.key === source)?.reason}</p>
          </div>

          {!isApi && (
            <>
              <div>
                <label htmlFor="rv-file" className="block text-[11px] font-semibold text-[#6B5744] uppercase tracking-wider mb-1">File</label>
                <input
                  id="rv-file" type="file" multiple accept=".json,.csv,.tsv,.txt,application/json,text/csv,text/plain"
                  onChange={e => setFiles(e.target.files)}
                  className="w-full text-sm text-[#6B5744] file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border file:border-[#E0D0BE] file:bg-[#FFF1E3] file:text-[#6B5744] file:text-xs file:font-semibold"
                />
              </div>
              <div>
                <label htmlFor="rv-text" className="block text-[11px] font-semibold text-[#6B5744] uppercase tracking-wider mb-1">…or paste rows</label>
                <textarea
                  id="rv-text" value={text} onChange={e => setText(e.target.value)} rows={4}
                  placeholder="Paste JSON, CSV or tab-separated rows copied out of a sheet."
                  className="w-full px-3 py-2 border border-[#E0D0BE] rounded-lg text-sm bg-white font-mono text-[12px]"
                />
              </div>
              <div className="flex flex-wrap gap-3">
                <div>
                  <label htmlFor="rv-order" className="block text-[11px] font-semibold text-[#6B5744] uppercase tracking-wider mb-1">Ambiguous dates</label>
                  <select
                    id="rv-order" value={dateOrder} onChange={e => setDateOrder(e.target.value as 'dmy' | 'mdy')}
                    className="px-3 py-2 border border-[#E0D0BE] rounded-lg text-sm bg-white"
                  >
                    <option value="dmy">Read 03/04 as 3 April (day first)</option>
                    <option value="mdy">Read 03/04 as 4 March (month first)</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="rv-expected" className="block text-[11px] font-semibold text-[#6B5744] uppercase tracking-wider mb-1">Total on the live listing</label>
                  <input
                    id="rv-expected" type="number" min={0} value={expected} onChange={e => setExpected(e.target.value)}
                    placeholder="optional"
                    className="px-3 py-2 border border-[#E0D0BE] rounded-lg text-sm bg-white w-40"
                  />
                </div>
              </div>
              <p className="text-[11px] text-[#8B7355]">
                The listing total is the single most useful thing to fill in: Takeout exports have been reported to come
                out incomplete, so the difference between that number and what we stored is recorded and shown on this
                page rather than assumed away.
              </p>
            </>
          )}

          {isApi && gbp && (
            <div className={`rounded-lg border px-3 py-2.5 text-[12px] ${gbp.ready ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-amber-50 border-amber-200 text-amber-900'}`}>
              <p className="font-semibold">{gbp.ready ? 'Connector configured.' : 'Connector not configured yet.'}</p>
              <p className="mt-0.5">{gbp.reason}</p>
              {!gbp.ready && gbp.prerequisites.length > 0 && (
                <>
                  <p className="font-semibold mt-2">What has to happen first, in order:</p>
                  <ol className="list-decimal pl-4 mt-1 space-y-0.5">
                    {gbp.prerequisites.map((p, i) => <li key={i}>{p}</li>)}
                  </ol>
                </>
              )}
              {gbp.unproven.length > 0 && (
                <>
                  <p className="font-semibold mt-2">Not verified against a live Google credential:</p>
                  <ul className="list-disc pl-4 mt-1 space-y-0.5">
                    {gbp.unproven.map((p, i) => <li key={i}>{p}</li>)}
                  </ul>
                </>
              )}
            </div>
          )}

          <button
            onClick={submit}
            disabled={busy}
            className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#963a06] disabled:opacity-60 text-white rounded-xl text-sm font-semibold shadow-sm"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : isApi ? <CloudDownload className="w-4 h-4" /> : <Upload className="w-4 h-4" />}
            {isApi ? 'Refresh now from Google' : 'Import'}
          </button>

          {err && (
            <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg px-3 py-2.5 text-[12px]">
              <p className="font-semibold">{err}</p>
              {prereqs && prereqs.length > 0 && (
                <ol className="list-decimal pl-4 mt-1.5 space-y-0.5">
                  {prereqs.map((p, i) => <li key={i}>{p}</li>)}
                </ol>
              )}
            </div>
          )}

          {result && <ImportResult r={result} />}
        </div>

        {/* Listing link settings */}
        <div className="space-y-3 lg:border-l lg:border-[#F0E4D6] lg:pl-4">
          <div>
            <h3 className="text-sm font-bold flex items-center gap-1.5">
              <ExternalLink className="w-3.5 h-3.5 text-[#af4408]" />Where “Reply on Google” goes
            </h3>
            <p className="text-[11px] text-[#8B7355] mt-1">
              No Google export carries a link to an individual review, so the buttons on this page open the listing’s
              review list. Give it a Place ID or a URL and those buttons start working.
            </p>
          </div>
          <div>
            <label htmlFor="rv-place" className="block text-[11px] font-semibold text-[#6B5744] uppercase tracking-wider mb-1">Google Place ID</label>
            <input
              id="rv-place" value={placeId} onChange={e => setPlaceId(e.target.value)}
              placeholder="ChIJ…"
              className="w-full px-3 py-2 border border-[#E0D0BE] rounded-lg text-sm bg-white font-mono text-[12px]"
            />
          </div>
          <div>
            <label htmlFor="rv-listing" className="block text-[11px] font-semibold text-[#6B5744] uppercase tracking-wider mb-1">…or the listing URL</label>
            <input
              id="rv-listing" value={listingUrl} onChange={e => setListingUrl(e.target.value)}
              placeholder="https://…"
              className="w-full px-3 py-2 border border-[#E0D0BE] rounded-lg text-sm bg-white text-[12px]"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={saveSettings} disabled={settingsBusy}
              className="flex items-center gap-2 px-3 py-2 bg-white border border-[#E0D0BE] hover:bg-[#FFF1E3] disabled:opacity-60 text-[#6B5744] rounded-lg text-xs font-semibold"
            >
              {settingsBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              Save link
            </button>
            {settingsMsg && <span className="text-[11px] text-[#6B5744]">{settingsMsg}</span>}
          </div>
          <p className="text-[11px] text-[#8B7355]">
            The Google API credentials are not entered here. They are settings keys
            (<span className="font-mono">reviews_gbp_client_secret</span>, <span className="font-mono">reviews_gbp_refresh_token</span>)
            already masked and admin-gated by the main settings surface; a second door for the same secrets would only be
            a second place to get masking wrong.
          </p>
        </div>
      </div>
    </div>
  );
}

function ImportResult({ r }: { r: ImportResultShape }) {
  const c = r.result;
  // A file the parser could not read in full is a FAILED import, not a partial
  // success, and it must never be introduced by a green tick. This is the whole
  // difference between "Rows read 2 · Added 2" over a 500-row file and being
  // told the file is broken.
  const failed = (c.fatal_documents ?? 0) > 0;
  return (
    <div className={`border rounded-lg px-3 py-3 text-[12px] ${
      failed ? 'bg-red-50 border-red-300 text-red-900' : 'bg-[#FFFBF5] border-[#E8D5C4] text-[#6B5744]'
    }`}>
      {failed ? (
        <>
          <p className="font-bold text-red-900 flex items-center gap-1.5">
            <ShieldAlert className="w-4 h-4 text-red-600" />
            {c.fatal_documents === 1 ? 'That file could not be read' : `${c.fatal_documents} files could not be read`} — nothing from
            {c.fatal_documents === 1 ? ' it' : ' them'} was imported
          </p>
          <p className="mt-1 font-medium">
            The reason is below. Importing only the part that did read would have looked like a complete
            history while missing most of it, so the whole file was refused and this import is recorded as
            failed.
          </p>
        </>
      ) : (
        <p className="font-bold text-[#2D1B0E] flex items-center gap-1.5">
          <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          Imported from {r.source_label}
        </p>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 mt-2">
        <ResultStat label="Rows read" value={c.rows_seen} />
        <ResultStat label="Added" value={c.inserted} tone={c.inserted > 0 ? 'good' : 'plain'} />
        <ResultStat label="Already known" value={c.unchanged} />
        <ResultStat label="Changed" value={c.updated} />
        <ResultStat label="Refused" value={c.errors} tone={c.errors > 0 ? 'warn' : 'plain'} />
        <ResultStat label="Ignored as stale" value={c.skipped_stale} />
      </div>

      {(c.location_overridden ?? 0) > 0 && (
        <p className="mt-2 font-semibold text-amber-800">
          {c.location_overridden} row{c.location_overridden === 1 ? '' : 's'} carried a different branch/outlet name
          inside the file ({c.location_values.join(', ')}). They were imported under the listing you chose, which is
          what you asked for — but if those rows belong to another outlet, delete them and import that file against
          that listing instead.
        </p>
      )}
      {(c.overlong_rows ?? 0) > 0 && (
        <p className="mt-2 font-semibold text-amber-800">
          {c.overlong_rows} row{c.overlong_rows === 1 ? ' had' : 's had'} more values than the header has columns, so
          the values were shifted out of their fields. Those rows were refused rather than read into the wrong
          columns — usually an unescaped comma inside a review.
        </p>
      )}
      {(c.short_rows ?? 0) > 0 && (
        <p className="mt-2">
          {c.short_rows} row{c.short_rows === 1 ? '' : 's'} stopped short of the header&rsquo;s last column. They were read
          (the missing cells were treated as empty), but a lot of these usually means the file uses a different
          separator than the parser picked.
        </p>
      )}
      {(r.encodings || []).some(e => e.fell_back || e.replacement_chars > 0) && (
        <p className="mt-2">
          {(r.encodings || []).filter(e => e.fell_back || e.replacement_chars > 0).map(e => (
            e.replacement_chars > 0
              ? `“${e.file}” arrived with ${e.replacement_chars} unreadable character(s) already lost — check the accented names.`
              : `“${e.file}” was not UTF-8; it was read as ${e.encoding} (Excel's default). Accented names should be correct — spot-check one.`
          )).join(' ')}
        </p>
      )}
      {c.weak_identity > 0 && (
        <p className="mt-2">
          <span className="font-semibold">{c.weak_identity}</span> row{c.weak_identity === 1 ? ' was' : 's were'} keyed on
          content because the reviewer is anonymous and the export carried no review id. If one of those authors edits
          their text, it will arrive as a new review rather than an update. That is a limitation of the export, and it is
          counted rather than hidden.
        </p>
      )}
      {c.ambiguous_dates > 0 && (
        <p className="mt-2">
          <span className="font-semibold">{c.ambiguous_dates}</span> date{c.ambiguous_dates === 1 ? ' was' : 's were'} ambiguous
          (03/04 could be either order) and were read using the setting above. Check a few against Google before trusting
          the daily counts.
        </p>
      )}
      {c.reconciliation.expected_total != null && (
        <p className={`mt-2 ${c.reconciliation.delta === 0 ? '' : 'font-semibold text-amber-800'}`}>
          The listing shows {c.reconciliation.expected_total}; we now hold {c.reconciliation.stored_total}
          {c.reconciliation.delta === 0
            ? ' — they match.'
            : ` — a difference of ${c.reconciliation.delta! > 0 ? '+' : ''}${c.reconciliation.delta}. Exports have been reported to come out incomplete; treat the smaller number as the one to explain.`}
        </p>
      )}
      {Object.keys(c.column_map).length > 0 && (
        <p className="mt-2">
          <span className="font-semibold">Columns read as:</span>{' '}
          {Object.entries(c.column_map).map(([from, to]) => `${from} → ${to}`).join(', ')}
          {c.unmapped_columns.length > 0 && <> · ignored: {c.unmapped_columns.join(', ')}</>}
        </p>
      )}
      {c.parse_errors.length > 0 && (
        <div className="mt-2">
          <p className={`font-semibold ${failed ? 'text-red-900' : 'text-amber-800'}`}>
            {failed
              ? 'Why the file was refused:'
              : `${c.parse_errors.length} row${c.parse_errors.length === 1 ? '' : 's'} refused:`}
          </p>
          <ul className="list-disc pl-4 mt-1 space-y-0.5">
            {c.parse_errors.slice(0, 8).map((e, i) => (
              <li key={i}><span className="font-mono">row {e.index}</span> — {e.reason}: <span className="text-[#8B7355]">{e.sample}</span></li>
            ))}
          </ul>
          {c.parse_errors.length > 8 && <p className="mt-1 text-[#8B7355]">…and {c.parse_errors.length - 8} more.</p>}
        </div>
      )}
    </div>
  );
}

function ResultStat({ label, value, tone = 'plain' }: { label: string; value: number; tone?: 'plain' | 'good' | 'warn' }) {
  const cls = tone === 'good' ? 'text-emerald-700' : tone === 'warn' ? 'text-amber-800' : 'text-[#2D1B0E]';
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span>{label}</span>
      <span className={`font-bold tabular-nums ${cls}`}>{value}</span>
    </div>
  );
}

/* ── Presentational bits ───────────────────────────────────────────────────── */

function Stars({ value, size = 14, dark = false }: { value: number | null; size?: number; dark?: boolean }) {
  if (value == null) return null;
  const rounded = Math.round(value * 2) / 2;
  const empty = dark ? 'text-[#6B5744]' : 'text-[#E0D0BE]';
  return (
    <span className="inline-flex items-center gap-px align-middle" aria-label={`${value} out of 5`}>
      {[1, 2, 3, 4, 5].map(i => {
        const style = { width: size, height: size } as const;
        if (rounded >= i) return <Star key={i} style={style} className="fill-[#E8A33D] text-[#E8A33D]" />;
        if (rounded >= i - 0.5) return <StarHalf key={i} style={style} className="fill-[#E8A33D] text-[#E8A33D]" />;
        return <Star key={i} style={style} className={empty} />;
      })}
    </span>
  );
}

/** Recharts hands `content` a loose props bag; only these three are used, and
 *  the bucket comes back out of it exactly as it went in. */
interface TrendTooltipProps {
  active?: boolean;
  /** The chart rows carry the bucket plus the two part-period fields the page
   *  derived for the bar label. */
  payload?: Array<{ payload: Bucket & { partial?: boolean; progress_text?: string } }>;
  period?: PeriodKey;
}

function TrendTooltip({ active, payload, period }: TrendTooltipProps) {
  if (!active || !payload || !payload.length) return null;
  const b = payload[0].payload;
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-lg shadow-md px-3 py-2 text-[12px]">
      <p className="font-bold text-[#2D1B0E]">
        {period === 'daily'
          ? fmtDayKey(b.start_date)
          : `${fmtDayKey(b.start_date, { year: false })} – ${fmtDayKey(b.end_date)}`}
        <span className="font-normal text-[#8B7355]"> · {b.key}</span>
      </p>
      {b.partial && (
        <p className="text-[11px] text-amber-700 mt-0.5">
          Still running — {b.progress_text} so far, so this bar is not comparable with a whole one.
        </p>
      )}
      {b.count === 0 ? (
        <p className="text-[#8B7355] mt-0.5">
          {b.partial ? 'Nothing posted yet in this period.' : 'No reviews in this period — no rating to average.'}
        </p>
      ) : (
        <div className="mt-0.5 space-y-0.5 text-[#6B5744]">
          <p>{b.count} review{b.count === 1 ? '' : 's'}</p>
          <p className="flex items-center gap-1.5">
            Average <span className="font-bold text-[#af4408]">{b.average?.toFixed(2)}</span>
            <Stars value={b.average} size={11} />
          </p>
          <p>{b.low_count} at 1–2 stars · {b.replied} answered</p>
        </div>
      )}
    </div>
  );
}

function Section({ icon, title, subtitle, right, children }: {
  icon: React.ReactNode; title: string; subtitle: string;
  right?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 sm:p-5">
      <div className="mb-3 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
        <div>
          <h2 className="text-base font-bold flex items-center gap-2">{icon}{title}</h2>
          <p className="text-[12px] text-[#8B7355] mt-1 max-w-3xl">{subtitle}</p>
        </div>
        {right && <div className="shrink-0">{right}</div>}
      </div>
      {children}
    </div>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-[11px] font-semibold text-[#6B5744] uppercase tracking-wider">{label}</span>
      {children}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition-colors ${
        active ? 'bg-[#af4408] border-[#af4408] text-white' : 'bg-white border-[#E0D0BE] text-[#6B5744] hover:bg-[#FFF1E3]'
      }`}
    >
      {children}
    </button>
  );
}

function Badge({ tone, children, title }: { tone: 'red' | 'amber' | 'green' | 'plain'; children: React.ReactNode; title?: string }) {
  const cls = tone === 'red' ? 'bg-red-50 border-red-200 text-red-800'
    : tone === 'amber' ? 'bg-amber-50 border-amber-200 text-amber-800'
    : tone === 'green' ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
    : 'bg-[#FFF1E3] border-[#E8D5C4] text-[#6B5744]';
  return <span title={title} className={`inline-block px-2 py-0.5 rounded-md border text-[10px] font-semibold ${cls}`}>{children}</span>;
}

/**
 * A count in the theme table that opens the reviews behind it.
 *
 * Looks like a number, because it is one — underlined on hover rather than
 * dressed as a button, so the column still reads as a column of figures.
 */
function CountButton({ n, active, onClick, title, tone = 'plain' }: {
  n: number; active: boolean; onClick: () => void; title: string; tone?: 'plain' | 'low';
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-expanded={active}
      className={`tabular-nums font-semibold rounded-md px-1.5 py-0.5 -mr-1.5 transition-colors ${
        active
          ? 'bg-[#af4408] text-white'
          : `${tone === 'low' && n > 0 ? 'text-red-700' : 'text-[#2D1B0E]'} hover:bg-[#FFF1E3] hover:underline decoration-[#af4408] underline-offset-2`
      }`}
    >
      {n}
    </button>
  );
}

/**
 * THE REVIEWS BEHIND ONE THEME COUNT.
 *
 * ── THE RULE THIS COMPONENT EXISTS TO KEEP ──────────────────────────────────
 * The rows shown must be exactly the rows counted. If clicking 27 revealed 24,
 * the table's own 27 is what would look wrong, and every other number on the
 * page would come under suspicion with it. So:
 *
 *   • The server re-runs the theme table's OWN predicate over the same span
 *     anchored at the same instant, and returns `theme_total` — the MENTIONS
 *     figure it counted.
 *   • `expected` is the number the manager pressed.
 *   • When those disagree, this says so, loudly, instead of quietly rendering
 *     the shorter list. A visible contradiction is a bug report; a silent one is
 *     a page that lies.
 *
 * The usual cause of a disagreement would be the report and the drill-down
 * having landed on different data — an import between the two requests. That is
 * worth a sentence on screen, not a hidden discrepancy.
 */
function ThemeDrill({
  label, spanLabel, low, expected, drill, loading, error, link,
  canReply, locationKey, onReplied, onClose,
}: {
  label: string; spanLabel: string; low: boolean; expected: number;
  drill: ThemePage | null; loading: boolean; error: string | null;
  link: Report['reply_link'];
  /* Passed through so a review opened from a theme count is answerable in the
     same place it was found. A theme drill-down is exactly where an owner
     notices five people complaining about the same thing. */
  canReply?: boolean; locationKey?: string; onReplied?: () => void;
  onClose: () => void;
}) {
  const heading = low
    ? `The ${expected} review${expected === 1 ? '' : 's'} rated 1–2★ that mention ${label}`
    : `The ${expected} review${expected === 1 ? '' : 's'} that mention ${label}`;

  const shownTotal = drill?.matched_total ?? null;
  const disagrees = shownTotal != null && shownTotal !== expected;

  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 sm:p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2 mb-2.5">
        <div className="min-w-0">
          <p className="text-[13px] font-bold">{heading}</p>
          <p className="text-[11px] text-[#8B7355] mt-0.5">
            Over {spanLabel}, matched on the words in the review text — the same counting that produced
            the number you clicked.
          </p>
        </div>
        <button
          onClick={onClose}
          className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold border border-[#E0D0BE] bg-white hover:bg-[#FFF1E3] text-[#6B5744]"
        >
          <X className="w-3.5 h-3.5" />Close
        </button>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-[12px] text-[#6B5744] py-2">
          <Loader2 className="w-4 h-4 animate-spin" />Finding those reviews…
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg px-3 py-2 text-[12px] flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}. The count of {expected} in the row above still stands — it was computed from
            every review held. Only this list failed to load.</span>
        </div>
      )}

      {drill && (
        <>
          {disagrees && (
            <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-lg px-3 py-2 text-[12px] flex items-start gap-2 mb-2.5">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>
                The table says <span className="font-semibold">{expected}</span> and this selection
                found <span className="font-semibold">{shownTotal}</span>. They are counted the same way
                over the same window, so a difference means the data moved between the two requests —
                most likely a fetch from Google landed just now. Reload the page to bring both onto the
                same snapshot.
              </span>
            </div>
          )}

          {drill.reviews.length === 0 ? (
            <Empty>No review came back for this theme, although the table counted {expected}. Reload
              the page — the two halves are looking at different snapshots.</Empty>
          ) : (
            <div className="space-y-2.5">
              {drill.reviews.map(r => (
                <ReviewRowCard
                  key={r.id} r={r} link={link}
                  canReply={canReply} locationKey={locationKey} onReplied={onReplied}
                />
              ))}
            </div>
          )}

          <p className="text-[11px] text-[#8B7355] mt-2.5">
            {drill.truncated
              ? `${drill.listed} of ${drill.matched_total} shown — that is as many as this page loads at once. Narrow the span above to work through the rest.`
              : `All ${drill.listed} shown.`}
            {low && ` These are the 1–2★ subset of the ${drill.theme_total} reviews that mention ${label}.`}
          </p>
        </>
      )}
    </div>
  );
}

function Th({ children, align = 'right' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return <th className={`py-2 ${align === 'left' ? 'text-left pr-3' : 'text-right pl-3'} font-semibold`}>{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="py-2.5 pl-3 text-right tabular-nums">{children}</td>;
}

function StatRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-[#F7EEE4] pb-1.5 last:border-0">
      <span className="text-[13px] text-[#6B5744]">{label}</span>
      <span className={strong ? 'text-base font-bold' : 'text-sm font-semibold'}>{value}</span>
    </div>
  );
}

function Band({ label, n, total }: { label: string; n: number; total: number }) {
  const width = total > 0 ? Math.round((n / total) * 100) : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-[12px] text-[#6B5744]">
        <span>{label}</span>
        <span className="tabular-nums font-semibold text-[#2D1B0E]">{n} <span className="text-[#8B7355] font-normal">({width}%)</span></span>
      </div>
      <div className="h-1.5 bg-[#F7EEE4] rounded-full overflow-hidden mt-0.5">
        <div className="h-full bg-[#af4408] rounded-full" style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-[13px] text-[#6B5744] bg-[#FFFBF5] border border-[#F0E4D6] rounded-lg px-3 py-2.5">
      <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-[#8B7355]" />
      <span>{children}</span>
    </div>
  );
}

function Note({ children, tone = 'plain' }: { children: React.ReactNode; tone?: 'plain' | 'warn' }) {
  const cls = tone === 'warn'
    ? 'bg-amber-50 border-amber-200 text-amber-900'
    : 'bg-[#FFFBF5] border-[#F0E4D6] text-[#6B5744]';
  return <p className={`text-[12px] border rounded-lg px-3 py-2 mt-3 ${cls}`}>{children}</p>;
}
