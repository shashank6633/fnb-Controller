/**
 * GOOGLE REVIEWS — the page's decisions, without the page.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * Everything in src/lib/reviews is pinned by a hand-computed suite. The screen
 * that renders it was not, because JSX is awkward to assert against — so the
 * two decisions most likely to mislead a manager were living untested inside a
 * component:
 *
 *   1. ZERO IS NOT A RATING. A period with no reviews has no average. Rendering
 *      it as 0.0 stars reads as the worst month the venue has ever had. The API
 *      already returns `average: null` for this; the page has to be incapable
 *      of turning that null into a number on the way to the screen.
 *
 *   2. "NO REVIEWS" AND "NOT IMPORTED" ARE DIFFERENT FACTS. They produce the
 *      identical empty tile, and reading the second as the first is how a venue
 *      tells itself it had a quiet week about a week nobody looked at. The API
 *      returns `import_covers` precisely so the page can tell them apart, and
 *      that branch is worth a gate rather than a code review.
 *
 * So both decisions are pure functions here, gated in scripts/reviews-tests.js
 * (sections V and W), and the component below only paints what they return.
 *
 * ── WHAT THIS FILE MUST NEVER DO ────────────────────────────────────────────
 * Compute a review figure. It receives what /api/crm-calls/reviews already
 * computed via src/lib/reviews/analysis.ts and decides how to SAY it. There is
 * no averaging, bucketing or scoring below, and there must not be: the engine's
 * suite would not cover a second implementation up here.
 *
 * It also holds no React, no DOM and no clock of its own, which is what lets
 * the failure branches — a refused token, a connector that has fetched nothing
 * for two days — be tested without arranging a broken Google account.
 */

import type { ConnectionHealth } from './connection';
import { bucketEndDay, daysBetweenKeys, istDayKey, type Period } from './time';

/* ── 0. Is the period on this tile actually over? ─────────────────────────── */

export interface PeriodProgress {
  /** The bucket is still running: it holds fewer days than a whole one. */
  partial: boolean;
  /** Days of the period that have happened, counting today. 0 when unknown. */
  elapsed_days: number;
  /** Days the whole period holds. 0 when unknown. */
  total_days: number;
  /** "10 days of 30" — '' when unknown. */
  text: string;
}

const NO_PROGRESS: PeriodProgress = { partial: false, elapsed_days: 0, total_days: 0, text: '' };

/**
 * How much of the current bucket has actually happened.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The last bucket of a live series is ALWAYS a part-period: on the 10th of a
 * 30-day month the "This month" tile holds ten days, and the "last month" tile
 * it is compared against holds thirty-one. A venue whose review rate has not
 * moved at all therefore read as collapsing — "volume -22 vs last month" —
 * every single day of every month, and the chart's last bar was a cliff that
 * did not exist. Nothing on the page said the period was still running.
 *
 * ── DERIVED FROM THE BUCKET, NOT FROM A CLOCK ───────────────────────────────
 * A bucket that stops before its own calendar end IS a bucket still in
 * progress: the series is built dense up to `to`, so a September bucket ending
 * on the 10th can only mean the 10th is as far as the data goes. No clock is
 * needed, no timezone can drift, and a caller that does not supply the dates
 * gets `partial: false` rather than a guess.
 *
 * THE DAILY TILE IS THE ONE EXCEPTION and needs the clock: today's bucket ends
 * on today whether it is 00:05 or 23:55, so a half-finished day looks complete
 * from the dates alone. Pass `now` (the route has it) and a bucket ending on
 * now's IST date is reported as partial with its elapsed hours; omit it and the
 * daily tile is treated as whole, which is the safe direction — it under-claims
 * rather than inventing a partial period.
 */
export function periodProgress(
  b: { period?: string; start_date?: string; end_date?: string },
  opts: { now?: number; todayKey?: string } = {},
): PeriodProgress {
  const period = b.period as Period | undefined;
  const start = String(b.start_date || '');
  const end = String(b.end_date || '');
  if (!period || !start || !end) return NO_PROGRESS;

  const naturalEnd = bucketEndDay(start, period);
  if (!naturalEnd) return NO_PROGRESS;

  const total = daysBetweenKeys(start, naturalEnd);
  const elapsed = daysBetweenKeys(start, end);
  if (total == null || elapsed == null || total <= 0 || elapsed <= 0) return NO_PROGRESS;

  if (end < naturalEnd) {
    return {
      partial: true,
      elapsed_days: elapsed,
      total_days: total,
      text: `${elapsed} day${elapsed === 1 ? '' : 's'} of ${total}`,
    };
  }

  // The bucket has reached its own calendar end. It is still in progress only
  // if that end is TODAY and today is not over — which needs the clock.
  const todayKey = opts.todayKey
    || (opts.now == null ? '' : istDayKey(opts.now));
  if (todayKey && todayKey === naturalEnd) {
    return {
      partial: true,
      elapsed_days: elapsed,
      total_days: total,
      // A one-day bucket has no "N of M" to report — it is simply not over yet,
      // and the heading's "so far" already says that. An empty string here is
      // what stops the tile printing "today, still running — still running".
      text: total === 1 ? '' : `${elapsed} day${elapsed === 1 ? '' : 's'} of ${total}`,
    };
  }

  return { partial: false, elapsed_days: elapsed, total_days: total, text: '' };
}

/* ── 1. A headline tile ───────────────────────────────────────────────────── */

/**
 * not_imported — zero reviews AND the last successful import did not reach this
 *                period. The number is an absence of data, not an absence of
 *                reviews, and the tile must say the first.
 * no_reviews   — zero reviews and the import DID cover the period. A real,
 *                trustworthy zero.
 * has_reviews  — a count and an average that exist.
 */
export type PeriodTileState = 'not_imported' | 'no_reviews' | 'has_reviews';

export interface PeriodTileView {
  state: PeriodTileState;
  /** The count, always a number — a count of zero is honest; only the RATING is
   *  withheld when there is nothing to average. */
  count: number;
  /** What to print where a count goes. */
  countText: string;
  /**
   * The number to feed a star widget. NULL means draw no stars at all.
   * This is the field the 0.0-stars trap lives or dies on, so it is derived
   * from `average` alone and never falls back to 0.
   */
  ratingValue: number | null;
  /** What to print where a rating goes, when ratingValue is null. */
  ratingText: string;
  /** One line under the tile explaining a withheld or untrustworthy figure. */
  note: string;
  /** Is the RAW period-on-period comparison worth showing at all? False when
   *  the current period is still running — a part-period against a whole one is
   *  not a comparison — in which case `deltaNote` carries the honest sentence,
   *  rating move included. */
  showDelta: boolean;
  /** Why the delta is hidden, when it is. */
  deltaNote: string;
  /** The heading to print: the label, plus "so far" while the period runs. */
  headingText: string;
  /** True while the period on this tile is still running. */
  partial: boolean;
  /** "10 days of 30" while it runs, '' otherwise. */
  progressText: string;
}

export interface PeriodTileInput {
  count: number;
  average: number | null;
  import_covers: boolean;
  prev_import_covers: boolean;
  prev_count: number;
  prev_average: number | null;
  label: string;
  /** ── Optional, and only used to decide whether the period is over ──────
   *  Supplied by the API's headline blocks. A caller that omits them gets a
   *  tile that treats the period as complete, which is the old behaviour and
   *  the safe direction. */
  period?: string;
  start_date?: string;
  end_date?: string;
  avg_delta?: number | null;
  count_delta?: number | null;
}

/**
 * Decide what one headline tile is allowed to claim.
 *
 * The order of the branches is the argument: coverage is checked BEFORE the
 * count is described, because "0" means two different things depending on it.
 */
export function periodTileView(
  b: PeriodTileInput,
  opts: { now?: number; todayKey?: string } = {},
): PeriodTileView {
  const covered = !!b.import_covers;
  const count = Number(b.count) || 0;
  const prog = periodProgress(b, opts);
  const unit = b.period === 'daily' ? 'day' : b.period === 'weekly' ? 'week' : 'month';
  const prevWord = b.period === 'daily' ? 'yesterday' : b.period === 'weekly' ? 'last week' : 'last month';
  const heading = prog.partial ? `${b.label} so far` : b.label;
  const shell = { headingText: heading, partial: prog.partial, progressText: prog.text };

  // A rating exists only if the engine produced one. No coalescing, ever —
  // `?? 0` here IS the bug this function was extracted to prevent.
  //
  // The lower bound is not defensive noise. A stored rating is an integer 1..5
  // by the engine's own contract (types.ts: "anything else is an error row,
  // never a silent 0"), so an average below 1 cannot be a real average — it is
  // corruption. Drawing it as stars would put "0.0" over a period, which reads
  // as the worst period in the venue's history. Withhold it and say so.
  const avg = typeof b.average === 'number' && Number.isFinite(b.average) ? b.average : null;
  const ratingValue = avg != null && avg >= 1 ? avg : null;

  if (count === 0 && !covered) {
    return {
      ...shell,
      state: 'not_imported',
      count: 0,
      countText: 'Not imported',
      ratingValue: null,
      ratingText: 'no data',
      note: 'The last import covers nothing inside this period, so this is a gap in the ' +
            'data — not a period without reviews.',
      showDelta: false,
      deltaNote: 'No comparison: this period was never imported.',
    };
  }

  if (count === 0) {
    return {
      ...shell,
      state: 'no_reviews',
      count: 0,
      countText: 'No reviews',
      ratingValue: null,
      ratingText: 'no reviews',
      note: prog.partial
        ? `Imported and empty so far — nobody has reviewed the venue in this ${unit} yet, and the ` +
          `${unit} is only ${prog.text} old.`
        : 'Imported and genuinely empty — nobody reviewed the venue in this period.',
      showDelta: false,
      deltaNote: 'No comparison: there is nothing to average against the period before.',
    };
  }

  // A count with no usable average means the engine returned a contradiction.
  // Say so rather than printing a number that is not there.
  if (ratingValue == null) {
    return {
      ...shell,
      state: 'has_reviews',
      count,
      countText: countWords(count, prog.partial),
      ratingValue: null,
      ratingText: 'no rating',
      note: avg == null
        ? 'These reviews carry no usable star rating, so there is no average to show.'
        : `The stored average (${avg}) is outside the 1–5 range a star rating can take, so it is not ` +
          'shown as one. This is a data fault worth reporting, not a bad month.',
      showDelta: false,
      deltaNote: '',
    };
  }

  // The previous period was never imported: a delta against it would be
  // measuring our own import history, not the venue's reviews.
  if (!b.prev_import_covers && b.prev_count === 0) {
    return {
      ...shell,
      state: 'has_reviews',
      count,
      countText: countWords(count, prog.partial),
      ratingValue,
      ratingText: '',
      note: '',
      showDelta: false,
      deltaNote: 'No comparison: the period before this one was never imported, so a change ' +
                 'against it would be measuring the import, not the reviews.',
    };
  }

  // ── THE PART-PERIOD BRANCH ────────────────────────────────────────────────
  // The current bucket is still running, so a raw volume delta against a whole
  // previous period is arithmetic on two different lengths of time. It is
  // withheld and replaced with the two facts that ARE true: how far into the
  // period we are, and how the RATING compares — a rating is an average, so it
  // is comparable at any point in the period, and it is the figure the owner
  // came for. The raw count_delta stays on the payload for anyone who wants it;
  // it just no longer gets printed as though it were news.
  if (prog.partial) {
    return {
      ...shell,
      state: 'has_reviews',
      count,
      countText: countWords(count, true),
      ratingValue,
      ratingText: '',
      note: '',
      showDelta: false,
      deltaNote: partPeriodComparison({
        unit, prevWord, count, prog,
        avgDelta: typeof b.avg_delta === 'number' && Number.isFinite(b.avg_delta) ? b.avg_delta : null,
        prevCount: Number(b.prev_count) || 0,
        prevAverage: typeof b.prev_average === 'number' && Number.isFinite(b.prev_average) ? b.prev_average : null,
      }),
    };
  }

  return {
    ...shell,
    state: 'has_reviews',
    count,
    countText: countWords(count, false),
    ratingValue,
    ratingText: '',
    note: '',
    showDelta: true,
    deltaNote: '',
  };
}

/** "9 reviews" / "9 reviews so far". The two words that were missing. */
function countWords(count: number, partial: boolean): string {
  return `${count} review${count === 1 ? '' : 's'}${partial ? ' so far' : ''}`;
}

/**
 * The sentence a still-running period is allowed to make.
 *
 * Says the volume figures WITHOUT calling their difference a change, because it
 * is not one: on the 10th of the month, 9-against-31 is ten days against
 * thirty-one, not a collapse. The rating move is stated plainly because an
 * average does not care how many days have elapsed.
 */
function partPeriodComparison(a: {
  unit: string; prevWord: string; count: number; prog: PeriodProgress;
  avgDelta: number | null; prevCount: number; prevAverage: number | null;
}): string {
  const elapsed = a.prog.text
    ? `Only ${a.prog.text} have happened`
    : `The ${a.unit} is not over`;
  const volume = `${elapsed}, so the count cannot be compared with a whole ` +
                 `${a.unit} yet: ${a.count} so far against ${a.prevCount} for the whole of ${a.prevWord}.`;
  const rating = a.avgDelta == null
    ? (a.prevAverage == null
        ? ` There is no rating ${a.prevWord} to compare against.`
        : ` The rating ${a.prevWord} was ${a.prevAverage.toFixed(2)}.`)
    : Math.abs(a.avgDelta) < 0.005
      ? ` The rating is unchanged on ${a.prevWord}${a.prevAverage == null ? '' : ` (${a.prevAverage.toFixed(2)})`}.`
      : ` The rating is ${a.avgDelta > 0 ? 'up' : 'down'} ${Math.abs(a.avgDelta).toFixed(2)} stars on ` +
        `${a.prevWord}${a.prevAverage == null ? '' : ` (${a.prevAverage.toFixed(2)})`}.`;
  return volume + rating;
}

/* ── 1b. What the data we hold actually covers ────────────────────────────── */

export type CoverageBasis =
  | 'never_imported'
  | 'fetched_from_google'
  | 'newest_review_in_file'
  | 'file_held_nothing';

export interface ImportCoverage {
  /** The last instant the loaded data can honestly speak for. '' = none. */
  end_at: string;
  basis: CoverageBasis;
  /** One sentence for the page, explaining the verdict. */
  note: string;
}

/**
 * How far the reviews we hold reach — which is NOT when the import ran.
 *
 * ── THE FAILURE THIS REPLACES ───────────────────────────────────────────────
 * `import_covers` was `last_run.finished_at >= period start`. That is the clock
 * of the IMPORT, and it only coincides with the clock of the DATA for the API
 * connector. Import a Takeout export today whose newest review is the 11th of
 * last month and every empty period since rendered as "No reviews — nothing
 * posted in this period", with no staleness banner anywhere, because the RUN
 * was one minute old. A reader concluded September was quiet. September was
 * simply not in the file. That is the exact comforting lie the module was built
 * to prevent, reachable through the only ingest path that works today.
 *
 * ── THE EVIDENCE DIFFERS BY SOURCE, SO THE RULE DOES TOO ────────────────────
 *   gbp_api  Google was ASKED at finished_at and answered with everything it
 *            had, so silence up to that instant is real silence. finished_at is
 *            genuine coverage.
 *   a file   A file proves only what is in it, and nothing on a Takeout export
 *            or a spreadsheet records when it was taken. The newest review
 *            inside it is therefore the furthest point that can be claimed.
 *
 * The cost is that a file-fed page reads "Not imported" for a genuinely quiet
 * today. That is the right way round: under-claiming coverage is recoverable,
 * inventing a quiet week is not.
 */
export function importCoverage(a: {
  last_success_at: string | null;
  last_success_source: string | null;
  newest_review_at: string | null;
}): ImportCoverage {
  const ran = String(a.last_success_at || '');
  if (!ran) {
    return {
      end_at: '', basis: 'never_imported',
      note: 'Nothing has been imported for this listing yet, so no period can be called quiet.',
    };
  }
  if (String(a.last_success_source || '') === 'gbp_api') {
    return {
      end_at: ran, basis: 'fetched_from_google',
      note: 'Google was asked directly at the last refresh, so an empty period up to that moment ' +
            'really was empty.',
    };
  }
  const newest = String(a.newest_review_at || '');
  if (!newest) {
    return {
      end_at: '', basis: 'file_held_nothing',
      note: 'The last import was a file that held no reviews, so it proves nothing about any period.',
    };
  }
  return {
    end_at: newest, basis: 'newest_review_in_file',
    note: 'The last import was a file, and a file only proves what is in it. Coverage therefore ' +
          'stops at the newest review it carried — after that date an empty period means "not in ' +
          'the file", not "nobody reviewed us".',
  };
}

/* ── 2. The connection banner ─────────────────────────────────────────────── */

/** What the button under the banner should do. '' = nothing actionable here. */
export type ConnectionCta =
  | 'setup' | 'connect' | 'reconnect' | 'choose_location' | 'enable_schedule' | 'refresh' | '';

export interface ConnectionBannerView {
  /** Does a banner appear above the report at all? */
  show: boolean;
  /** LOUD — a red band at the top of the page, above every number. Reserved for
   *  states where new reviews have stopped arriving and a human must act. */
  loud: boolean;
  tone: 'error' | 'warn' | 'info' | 'ok';
  /** Rendered verbatim from the engine. */
  headline: string;
  /** Rendered verbatim from the engine. */
  action: string;
  cta: ConnectionCta;
  ctaLabel: string;
  /** True when the numbers below the banner should be read with suspicion. */
  dataMayBeBehind: boolean;
}

const CTA_LABEL: Record<Exclude<ConnectionCta, ''>, string> = {
  setup: 'How to set this up',
  connect: 'Connect Google Business Profile',
  reconnect: 'Reconnect Google Business Profile',
  choose_location: 'Choose the listing',
  enable_schedule: 'Turn on scheduled refresh',
  refresh: 'Refresh now',
};

/**
 * Turn the engine's health verdict into a banner.
 *
 * The severity is the ENGINE's, not this file's. connectionHealth() already
 * evaluates worst-cause-first and decides how bad each state is; re-deciding it
 * here would give the page a second opinion that could drift from the one the
 * suite tests. All this adds is: how loud, which button, and whether the report
 * underneath deserves a warning.
 */
export function connectionBanner(h: ConnectionHealth): ConnectionBannerView {
  const cta: ConnectionCta = (() => {
    switch (h.state) {
      case 'no_app': return 'setup';
      case 'not_connected': return 'connect';
      case 'needs_reconnect': return 'reconnect';
      case 'no_location': return 'choose_location';
      case 'paused': return 'enable_schedule';
      // A manager cannot start a scheduler. What they CAN do is pull now, and
      // the action text says who has to fix the automation.
      case 'no_driver': return 'refresh';
      case 'failing': return 'refresh';
      case 'stale': return 'refresh';
      default: return '';
    }
  })();

  return {
    show: h.state !== 'healthy',
    // Only the engine's own 'error' severity earns the red band. A paused
    // schedule is a decision someone made; a refused token is a breakage.
    loud: h.severity === 'error',
    tone: h.severity === 'ok' ? 'ok' : h.severity,
    headline: h.headline,
    action: h.action,
    cta,
    ctaLabel: cta ? CTA_LABEL[cta] : '',
    // `automatic` is the engine's answer to "is new data actually arriving?".
    // It is false for stale-but-armed, which is exactly the silent failure the
    // module exists to surface, so it is the right field to key this on.
    dataMayBeBehind: !h.automatic,
  };
}

/* ── 3. Small honest formatters ───────────────────────────────────────────── */

const IST = 'Asia/Kolkata';

/** An ISO instant as IST wall-clock, or a dash. Never throws on junk. */
export function fmtIst(iso: string | null | undefined, withTime = true): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString('en-IN', {
    timeZone: IST,
    day: 'numeric', month: 'short', year: 'numeric',
    ...(withTime ? { hour: 'numeric', minute: '2-digit', hour12: true } : {}),
  });
}

/**
 * "in 42 minutes" / "overdue by 3 hours" for the next scheduled fetch.
 *
 * An overdue schedule is reported as overdue rather than rounded to "due now":
 * a cron that stopped running is one of the two ways this feature fails
 * silently, and the page should be able to show it counting up.
 */
export function nextFetchText(nextDueAt: string, now = Date.now()): string {
  if (!nextDueAt) return 'not scheduled';
  const ms = Date.parse(nextDueAt);
  if (!Number.isFinite(ms)) return 'not scheduled';
  const mins = Math.round((ms - now) / 60_000);
  if (mins <= -60) {
    const h = Math.round(-mins / 60);
    return `overdue by ${h} hour${h === 1 ? '' : 's'}`;
  }
  if (mins < 0) return `overdue by ${-mins} minute${mins === -1 ? '' : 's'}`;
  if (mins === 0) return 'due now';
  if (mins < 60) return `in ${mins} minute${mins === 1 ? '' : 's'}`;
  const h = Math.round(mins / 60);
  return `in about ${h} hour${h === 1 ? '' : 's'}`;
}

/** Hours-ago as prose. Mirrors the page's existing fmtAgo so both read alike. */
export function agoText(hours: number | null | undefined): string {
  if (hours == null || !Number.isFinite(hours)) return 'never';
  if (hours < 1) {
    const m = Math.max(1, Math.round(hours * 60));
    return `${m} minute${m === 1 ? '' : 's'} ago`;
  }
  if (hours < 48) {
    const h = Math.round(hours);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  const d = Math.round(hours / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/** How the page names a schedule interval. */
export function intervalText(minutes: number): string {
  const m = Math.round(Number(minutes) || 0);
  if (m <= 0) return 'off';
  if (m < 60) return `every ${m} minutes`;
  const h = m / 60;
  if (Number.isInteger(h)) return `every ${h} hour${h === 1 ? '' : 's'}`;
  return `every ${m} minutes`;
}
