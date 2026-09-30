/**
 * GOOGLE REVIEWS — THE FILTER, THE WINDOW AND THE ORDER FOR ONE LIST.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ONE PREDICATE PRODUCES BOTH THE ROWS AND THE COUNT BESIDE THEM.
 * ══════════════════════════════════════════════════════════════════════════
 * "Showing 27 of 27" is only true if the 27 were counted by the same test that
 * selected them. Two tests that agree today drift the first time one of them is
 * edited, and then the table's own number is what looks wrong. So everything
 * below counts by filtering: `selectReviews` returns the matching rows, their
 * exact total, and how many rows the DATE WINDOW alone excluded — that last
 * number is what lets a screen say "N older not shown" instead of implying the
 * short list is everything.
 *
 * PURE: no database, no network, no clock of its own. Rows and an anchor in,
 * rows and counts out.
 *
 * ── THE WINDOWS ARE NOT INTERCHANGEABLE, ON PURPOSE ─────────────────────────
 * `resolveRange` (the attention list) snaps to IST midnight, so "last 30 days"
 * does not slide out from under a manager working through a queue at 23:00.
 *
 * `themeFloorMs` (the theme drill-down) is a rolling `anchor - days * 86400000`
 * with NO snapping, because that is exactly how the theme table's own counts
 * are computed in the report route. The drill-down under a cell showing 211
 * must reveal those 211 and not 213, so it uses that table's arithmetic rather
 * than a tidier window of its own.
 */
import { matchThemes, compileThemes, type ThemeRule } from './themes';
import { istCivil, istCivilToMs, parseIsoMs } from './time';

const DAY_MS = 86_400_000;

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/* ── The date window for the attention list ───────────────────────────────── */

export type RangeKey = 'today' | 'd7' | 'd30' | 'd90' | 'all' | 'custom';

export const RANGE_KEYS: RangeKey[] = ['today', 'd7', 'd30', 'd90', 'all', 'custom'];

export function isRangeKey(s: string): s is RangeKey {
  return (RANGE_KEYS as string[]).includes(s);
}

export interface ResolvedWindow {
  kind: RangeKey;
  /** Inclusive lower bound, ms. null = unbounded (and undated rows are kept). */
  from_ms: number | null;
  /** Inclusive upper bound, ms. null = unbounded. */
  to_ms: number | null;
  from: string | null;
  to: string | null;
  /** Printed verbatim by the screen, so the control and the rows cannot
   *  disagree about what was ranged over. */
  label: string;
  /** True when the window rejected nothing at all — the only case in which a
   *  list may be described as the whole dataset. */
  unbounded: boolean;
}

/** Start of the IST calendar day that contains `ms`. */
function istDayStart(ms: number): number {
  const c = istCivil(ms);
  return istCivilToMs(c.y, c.m, c.d);
}

/** YYYY-MM-DD -> the instant of its 00:00 IST. */
export function istDayStartOf(day: string): number | null {
  const m = day.trim().match(DAY_RE);
  if (!m) return null;
  return istCivilToMs(Number(m[1]), Number(m[2]), Number(m[3]));
}

/**
 * The window a range chip means, anchored at the server's `now`.
 *
 * Every bounded window starts at an IST MIDNIGHT and ends at the anchor. "The
 * last 30 days" therefore means the 30 IST calendar days ending today,
 * inclusive — a stable set for a day's work, rather than a boundary that walks
 * forward every minute and drops a row the manager was about to open.
 */
export function resolveRange(
  kind: RangeKey,
  anchorMs: number,
  custom: { from?: string; to?: string } = {},
): ResolvedWindow {
  const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
  const done = (k: RangeKey, fromMs: number | null, toMs: number | null, label: string): ResolvedWindow => ({
    kind: k,
    from_ms: fromMs,
    to_ms: toMs,
    from: iso(fromMs),
    to: iso(toMs),
    label,
    unbounded: fromMs == null && toMs == null,
  });

  if (kind === 'all') return done('all', null, null, 'every review held');

  if (kind === 'custom') {
    const f = custom.from ? istDayStartOf(custom.from) : null;
    // An end DATE means the whole of that day, so the bound is its last
    // instant. A bound at 00:00 would silently drop everything posted on the
    // day the manager actually typed.
    const tRaw = custom.to ? istDayStartOf(custom.to) : null;
    const t = tRaw == null ? null : tRaw + DAY_MS - 1;
    if (f == null && t == null) return done('all', null, null, 'every review held');
    // A backwards range would match nothing and read as "no reviews". Swap it.
    if (f != null && t != null && f > t) {
      return done('custom', tRaw, f + DAY_MS - 1,
        `${custom.to} to ${custom.from} (the dates were entered backwards and have been swapped)`);
    }
    return done('custom', f, t,
      f != null && t != null ? `${custom.from} to ${custom.to}`
        : f != null ? `${custom.from} onwards`
          : `everything up to ${custom.to}`);
  }

  const todayStart = istDayStart(anchorMs);
  if (kind === 'today') return done('today', todayStart, anchorMs, 'today');

  const days = kind === 'd7' ? 7 : kind === 'd30' ? 30 : 90;
  // N calendar days INCLUDING today, so d7 is today plus the six before it.
  const from = todayStart - (days - 1) * DAY_MS;
  return done(kind, from, anchorMs, `the last ${days} days`);
}

/* ── The theme drill-down window ──────────────────────────────────────────── */

export type ThemeSpanKey = 'd90' | 'd365' | 'all';

export function isThemeSpanKey(s: string): s is ThemeSpanKey {
  return s === 'd90' || s === 'd365' || s === 'all';
}

export const THEME_SPAN_DAYS: Record<ThemeSpanKey, number | null> = {
  d90: 90, d365: 365, all: null,
};

/**
 * The floor the report route's themeSpan() uses, to the millisecond:
 * `now - days * DAY_MS`, and for 'all' no floor at all — which is why the 'all'
 * theme counts include UNDATED reviews, whose text still mentions things. A
 * drill-down that quietly dropped them would show fewer rows than the number
 * that was clicked.
 */
export function themeFloorMs(span: ThemeSpanKey, anchorMs: number): number | null {
  const days = THEME_SPAN_DAYS[span];
  return days == null ? null : anchorMs - days * DAY_MS;
}

/* ── Selection ────────────────────────────────────────────────────────────── */

export type RatingFilter = 'all' | 'low' | '1' | '2' | '3' | '4' | '5';
export type ReplyFilter = 'all' | 'no' | 'yes';
export type ScopeFilter = 'major' | 'all';
export type SortOrder = 'newest' | 'oldest';

/** The scored fields the engine attaches, joined to the text the row carries. */
export interface SelectableReview {
  id: string;
  rating: number;
  posted_at: string;
  replied: boolean;
  is_major: boolean;
}

export interface SelectFilters {
  rating: RatingFilter;
  reply: ReplyFilter;
  scope: ScopeFilter;
}

export interface SelectResult<T> {
  /** Every matching row, ordered. NOT capped — the caller slices for transport
   *  and reports the total beside it. */
  rows: T[];
  /** Rows matching every filter INCLUDING the window. */
  matched_total: number;
  /** Rows that passed every non-date filter but fell BELOW the window. This is
   *  the "N older not shown" a narrowed list is required to admit to. */
  older_outside: number;
  /** …and above it, for a custom range that ends in the past. */
  newer_outside: number;
  /** Rows that passed every non-date filter and carry no readable date, so no
   *  window can place them. Counted rather than silently dropped. */
  undated_outside: number;
  /** Rows passing the SCOPE filter alone, ignoring rating, reply and dates. */
  scope_total: number;
}

function ratingOk(r: SelectableReview, f: RatingFilter): boolean {
  if (f === 'all') return true;
  if (f === 'low') return r.rating <= 2;
  return r.rating === Number(f);
}

function replyOk(r: SelectableReview, f: ReplyFilter): boolean {
  if (f === 'all') return true;
  return f === 'yes' ? r.replied : !r.replied;
}

/** Newest- or oldest-first, with undated rows last in BOTH orders: a review
 *  with no readable date has no place on a timeline, and letting it sort as
 *  epoch zero would present it as the oldest review the venue ever had. */
function byDate<T extends { id: string; posted_at: string }>(rows: T[], sort: SortOrder): void {
  const dir = sort === 'oldest' ? 1 : -1;
  rows.sort((a, b) => {
    const am = parseIsoMs(a.posted_at);
    const bm = parseIsoMs(b.posted_at);
    if (am == null && bm == null) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    if (am == null) return 1;
    if (bm == null) return -1;
    if (am !== bm) return (am < bm ? -1 : 1) * dir;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Filter, count and order in one pass over the scored set.
 *
 * The date test is applied LAST and its rejections are counted separately,
 * because "3 match" and "3 match, 812 older ones are outside the window you
 * chose" are different sentences and only the second one is honest about a
 * default that hides most of the queue.
 */
export function selectReviews<T extends SelectableReview>(
  scored: T[],
  win: ResolvedWindow,
  filters: SelectFilters,
  sort: SortOrder,
): SelectResult<T> {
  const rows: T[] = [];
  let older = 0, newer = 0, undated = 0, scopeTotal = 0;

  for (const r of scored) {
    if (filters.scope === 'major' && !r.is_major) continue;
    scopeTotal++;
    if (!ratingOk(r, filters.rating)) continue;
    if (!replyOk(r, filters.reply)) continue;

    const ms = parseIsoMs(r.posted_at);
    if (ms == null) {
      // An unbounded window places nothing and excludes nothing, so an undated
      // review belongs in it. Any bounded window cannot place it.
      if (win.unbounded) rows.push(r); else undated++;
      continue;
    }
    if (win.from_ms != null && ms < win.from_ms) { older++; continue; }
    if (win.to_ms != null && ms > win.to_ms) { newer++; continue; }
    rows.push(r);
  }

  byDate(rows, sort);

  return {
    rows,
    matched_total: rows.length,
    older_outside: older,
    newer_outside: newer,
    undated_outside: undated,
    scope_total: scopeTotal,
  };
}

/* ── Theme selection ─────────────────────────────────────────────────────── */

export interface ThemeSelectResult<T> {
  rows: T[];
  matched_total: number;
  /** Rows in the span whose text mentions the theme, before the 1-2★ cut —
   *  i.e. the MENTIONS column. Sent back so the page can assert agreement. */
  theme_total: number;
}

/**
 * Exactly the rows computeThemes() counted for one theme in one span.
 *
 * The predicate is taken from computeThemes()'s own loop, in the same order:
 * skip rows whose TRIMMED text is empty (a rating with no words cannot mention
 * anything, and is not in that function's denominator either), then keep the
 * rows whose matchThemes() hits include this key. `low` then applies the same
 * `rating <= 2` that produced the "1-2★ among them" column.
 *
 * If this ever stops agreeing with computeThemes(), the table's number is the
 * one that will look wrong to the owner, so the agreement is checked on screen
 * rather than assumed: `theme_total` goes back with the rows and the page says
 * so plainly when it differs from the cell that was clicked.
 */
export function selectThemeReviews<
  T extends { id: string; rating: number; posted_at: string; text: string },
>(
  rows: T[],
  themeKey: string,
  span: ThemeSpanKey,
  anchorMs: number,
  opts: { low?: boolean; rules?: ThemeRule[]; sort?: SortOrder } = {},
): ThemeSelectResult<T> {
  const compiled = compileThemes(opts.rules);
  const floor = themeFloorMs(span, anchorMs);
  const out: T[] = [];
  let themeTotal = 0;

  for (const r of rows) {
    if (floor != null) {
      const ms = parseIsoMs(r.posted_at);
      // computeThemes over a dated span never sees an undated row, so neither
      // does this. Over 'all' (floor null) both see them.
      if (ms == null || ms < floor) continue;
    }
    const text = (r.text || '').trim();
    if (!text) continue;
    const hits = matchThemes(text, compiled);
    if (!hits.some(h => h.key === themeKey)) continue;
    themeTotal++;
    if (opts.low && r.rating > 2) continue;
    out.push(r);
  }

  byDate(out, opts.sort || 'newest');
  return { rows: out, matched_total: out.length, theme_total: themeTotal };
}
