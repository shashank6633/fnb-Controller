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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Star, StarHalf, MessageSquare, RefreshCw, Lock, Info, ChevronLeft, AlertTriangle,
  CheckCircle2, Loader2, TrendingUp, TrendingDown, Minus, ExternalLink, Copy, Check,
  Upload, Database, Clock, Tag, CloudDownload, X, Link2, Power, PlugZap, MapPin, ShieldAlert,
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
      setRefreshResult({
        tone: 'error',
        message: err,
        needsReconnect: !!(json as { needs_reconnect?: boolean }).needs_reconnect,
        prerequisites: (json as { prerequisites?: string[] }).prerequisites || [],
        detail: res.status === 409
          ? 'This is not a retryable error — pressing Refresh again will not change it.'
          : res.status === 401
            ? 'Only an admin can run a manual fetch.'
            : 'Google could not be reached, or answered with an error. This one is worth retrying.',
      });
      // The health on the page is now out of date whatever happened.
      await load();
    } catch {
      setRefreshResult({ tone: 'error', message: 'Couldn’t reach the server to start a fetch.', detail: '' });
    } finally {
      setRefreshing(false);
    }
  }, [load]);

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

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.major.reviews.filter(r => {
      if (majorOnly && !r.is_major) return false;
      if (ratingFilter === 'low' && r.rating > 2) return false;
      if (ratingFilter !== 'all' && ratingFilter !== 'low' && r.rating !== Number(ratingFilter)) return false;
      if (answeredFilter === 'no' && r.replied) return false;
      if (answeredFilter === 'yes' && !r.replied) return false;
      return true;
    });
  }, [data, majorOnly, ratingFilter, answeredFilter]);

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
            lastResult={refreshResult}
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
            subtitle="Scored, not filtered by star rating alone: a 3-star with no reply outranks a replied 2-star, because a reply is the thing still owed. Worst first."
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

            {/* Filters */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-3 pb-3 border-b border-[#F0E4D6]">
              <FilterGroup label="Rating">
                {([
                  ['all', 'All'], ['low', '1–2★'], ['1', '1★'], ['2', '2★'], ['3', '3★'], ['4', '4★'], ['5', '5★'],
                ] as Array<[RatingFilter, string]>).map(([v, l]) => (
                  <Chip key={v} active={ratingFilter === v} onClick={() => setRatingFilter(v)}>{l}</Chip>
                ))}
              </FilterGroup>
              <FilterGroup label="Reply">
                {([['all', 'All'], ['no', 'Unanswered'], ['yes', 'Answered']] as Array<[AnsweredFilter, string]>).map(([v, l]) => (
                  <Chip key={v} active={answeredFilter === v} onClick={() => setAnsweredFilter(v)}>{l}</Chip>
                ))}
              </FilterGroup>
              <FilterGroup label="Scope">
                <Chip active={majorOnly} onClick={() => setMajorOnly(true)}>Needs attention</Chip>
                <Chip active={!majorOnly} onClick={() => setMajorOnly(false)}>Every review</Chip>
              </FilterGroup>
              <p className="text-[11px] text-[#8B7355] ml-auto">
                {filtered.length} shown of {majorOnly ? data.major.major_count : data.major.total_scored}
                {data.major.truncated && ` · the newest ${data.major.listed} scored reviews were loaded`}
              </p>
            </div>

            {data.reply_link.kind === 'none' && (
              <Note tone="warn">
                No “open on Google” link is configured, so the cards below cannot link out.{' '}
                {data.can_import
                  ? 'Add the listing’s Place ID or URL in the Import panel above.'
                  : 'An admin can add the listing’s Place ID or URL from the Import panel.'}
              </Note>
            )}

            {filtered.length === 0 ? (
              <Empty>
                {data.major.total_scored === 0
                  ? 'No reviews have been imported for this listing yet, so there is nothing to score.'
                  : majorOnly && ratingFilter === 'all' && answeredFilter === 'all'
                    ? 'No review in the imported history reaches the attention threshold. That is a real result over ' +
                      `${data.major.total_scored} reviews, not an empty page.`
                    : 'No review matches these filters. The others are still there — widen the filter.'}
              </Empty>
            ) : (
              <div className="space-y-2.5">
                {filtered.slice(0, 200).map(r => (
                  <ReviewRowCard key={r.id} r={r} link={data.reply_link} />
                ))}
                {filtered.length > 200 && (
                  <Note>Showing the first 200 of {filtered.length} matching reviews. Narrow the filters to see the rest.</Note>
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
                    {themes.themes.map(t => (
                      <tr key={t.key} className="border-b border-[#F7EEE4] last:border-0 align-top">
                        <td className="py-2.5 pr-3 font-semibold">{t.label}</td>
                        <Td>{t.count}</Td>
                        <Td>{t.share_of_text_reviews == null ? '—' : `${Math.round(t.share_of_text_reviews * 1000) / 10}%`}</Td>
                        <Td>
                          {t.average_rating == null ? '—' : (
                            <span className="inline-flex items-center gap-1.5 justify-end">
                              <span>{t.average_rating.toFixed(2)}</span>
                              <Stars value={t.average_rating} size={11} />
                            </span>
                          )}
                        </Td>
                        <Td>{t.low_count}</Td>
                        <td className="py-2.5 pl-3 text-[11px] text-[#8B7355]">
                          {t.top_terms.map(x => `${x.term} (${x.count})`).join(', ') || '—'}
                        </td>
                      </tr>
                    ))}
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

function ReviewRowCard({ r, link }: { r: ReviewCard; link: Report['reply_link'] }) {
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
