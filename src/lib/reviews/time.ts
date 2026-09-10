/**
 * GOOGLE REVIEWS — time, in ONE place.
 *
 * Two decisions this file exists to make once, so parse and analysis can never
 * disagree about what day a review landed on.
 *
 * 1. STORAGE IS UTC, BUCKETING IS IST.
 *    Google timestamps are RFC 3339 UTC. Buckets are the OWNER'S calendar day,
 *    which is Asia/Kolkata. A review posted at 02:00 IST is 20:30 UTC the
 *    PREVIOUS day, so bucketing on the stored string would put a chunk of every
 *    late night into yesterday and quietly bend the daily counts.
 *    IST is a fixed +05:30 with no DST ever, so the shift is exact arithmetic —
 *    no Intl, no timezone database, deterministic in any environment, which is
 *    what makes these functions testable.
 *
 *    NOT the 04:00 business day used by HRMS attendance. A review is posted
 *    whenever the guest feels like it, often days after the visit; there is no
 *    shift to attribute it to. Calendar IST is the honest bucket.
 *
 * 2. THE WEEK KEY MATCHES SQLite strftime('%Y-W%W').
 *    src/app/api/tasks/reports/route.ts already buckets daily/weekly/monthly
 *    that way, and this engine follows the house convention so a future SQL
 *    version of any figure here lands on the same buckets. %W means: Monday is
 *    the first day of the week, and the days of January before the year's first
 *    Monday are week 00.
 *    THE ONE DIFFERENCE, stated because it will bite whoever writes that SQL:
 *    strftime applies %W to the STORED (UTC) timestamp. A SQL reimplementation
 *    must shift to IST first — datetime(posted_at, '+330 minutes') — or it will
 *    disagree with this file on every review posted between 18:30 and 23:59 UTC.
 */

export const IST_OFFSET_MIN = 330;
const MS_PER_MIN = 60_000;
const MS_PER_DAY = 86_400_000;

export type Period = 'daily' | 'weekly' | 'monthly';
export const PERIODS: Period[] = ['daily', 'weekly', 'monthly'];

/** Hard stop on how many days a dense series may walk (~22 years). A single
 *  mistyped 1970 date must not turn a page render into a 20,000-iteration loop.
 *
 *  BOTH CAPS TRIM THE OLD END, NEVER THE NEW ONE. See denseBuckets(): the walk
 *  now STARTS at the newest allowed day rather than stopping at the oldest, so
 *  one implausible-but-parser-legal date can never cost the owner today. */
export const MAX_SCAN_DAYS = 8000;
/** Hard stop on emitted buckets. Beyond this the series is truncated from the
 *  OLD end and the result says so — a truncated chart that admits it beats a
 *  browser that stops responding. */
export const MAX_BUCKETS = 4000;

const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n));

/** ms since epoch for an ISO-8601 string, or null. Rejects anything Date can't
 *  read AND anything absurd (before 2000 / more than a year ahead) — a review
 *  dated 1899 is a parse failure wearing a valid-looking string. */
export function parseIsoMs(iso: string): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return ms;
}

/** 2026-04-11T13:45:02Z — the one storage format. Always seconds, always Z. */
export function toIsoUtc(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}` +
         `T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}Z`;
}

export interface Civil { y: number; m: number; d: number; hh: number; mm: number; ss: number }

/** UTC instant -> the civil clock reading in IST. */
export function istCivil(ms: number): Civil {
  const d = new Date(ms + IST_OFFSET_MIN * MS_PER_MIN);
  return {
    y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
    hh: d.getUTCHours(), mm: d.getUTCMinutes(), ss: d.getUTCSeconds(),
  };
}

/** IST civil clock reading -> the UTC instant. Inverse of istCivil. */
export function istCivilToMs(y: number, m: number, d: number, hh = 0, mm = 0, ss = 0): number {
  return Date.UTC(y, m - 1, d, hh, mm, ss) - IST_OFFSET_MIN * MS_PER_MIN;
}

/** IST calendar date, YYYY-MM-DD. */
export function istDayKey(ms: number): string {
  const c = istCivil(ms);
  return `${c.y}-${pad2(c.m)}-${pad2(c.d)}`;
}

export function istMonthKey(ms: number): string {
  const c = istCivil(ms);
  return `${c.y}-${pad2(c.m)}`;
}

/**
 * strftime('%Y-W%W') over the IST date.
 *   week = floor((dayOfYear0 + 7 - mondayIndex) / 7)
 * where mondayIndex is 0 for Monday .. 6 for Sunday.
 * Checks: 2024-01-01 is a Monday -> W01 (it IS the first Monday).
 *         2023-01-01 is a Sunday -> W00 (precedes the first Monday).
 *         2023-01-02 is a Monday -> W01.
 */
export function istWeekKey(ms: number): string {
  const c = istCivil(ms);
  const startOfYear = Date.UTC(c.y, 0, 1);
  const thisDay = Date.UTC(c.y, c.m - 1, c.d);
  const dayOfYear0 = Math.round((thisDay - startOfYear) / MS_PER_DAY);
  const jsDow = new Date(thisDay).getUTCDay();        // 0 = Sunday
  const mondayIndex = (jsDow + 6) % 7;                // 0 = Monday
  const week = Math.floor((dayOfYear0 + 7 - mondayIndex) / 7);
  return `${c.y}-W${pad2(week)}`;
}

export function bucketKey(ms: number, period: Period): string {
  if (period === 'monthly') return istMonthKey(ms);
  if (period === 'weekly') return istWeekKey(ms);
  return istDayKey(ms);
}

export interface Bucket { key: string; start_date: string; end_date: string }

/**
 * Every bucket between two instants INCLUSIVE, with no gaps.
 *
 * Dense on purpose. A month with zero reviews is a fact the owner needs to see
 * on the trend line and needs counted as the "previous period" when the next
 * month is compared against it; a sparse series silently compares March to
 * January and calls it a week-on-week move.
 *
 * Built by walking IST days and collecting distinct keys in order, so the
 * boundaries can never drift from bucketKey() — the two cannot be implemented
 * inconsistently because there is only one implementation.
 *
 * ── THE WALK IS CLAMPED AT THE OLD END, AND THAT IS THE WHOLE POINT ─────────
 * The scan cap used to be enforced by BREAKING OUT of the loop after
 * MAX_SCAN_DAYS days, which threw away the NEWEST days — the opposite of what
 * both caps are documented to do, and the opposite of what the owner is looking
 * at. One review carrying a parser-legal old date (15/03/2004 is an ordinary
 * DD/MM typo for 2024, and parseTimestamp accepts it) pushed `from` past 8000
 * days and the series then ended in FEBRUARY: Today, This week and This month
 * all read zero while the all-time total still said 31 reviews. The page's own
 * note — "the oldest buckets were dropped" — described the opposite of what had
 * happened.
 *
 * So the window is chosen BEFORE the walk: at most MAX_SCAN_DAYS days ending at
 * `to`. The newest day is never negotiable; the old end is what gives way, and
 * `truncated` says it did.
 */
export function denseBuckets(fromMs: number, toMs: number, period: Period):
    { buckets: Bucket[]; truncated: boolean } {
  if (!(Number.isFinite(fromMs) && Number.isFinite(toMs)) || toMs < fromMs) {
    return { buckets: [], truncated: false };
  }
  const c0 = istCivil(fromMs);
  let cursor = istCivilToMs(c0.y, c0.m, c0.d);        // IST midnight of the first day
  const endCivil = istCivil(toMs);
  const end = istCivilToMs(endCivil.y, endCivil.m, endCivil.d);

  const out: Bucket[] = [];
  const index = new Map<string, Bucket>();
  let truncated = false;

  // IST is a fixed offset with no DST ever, so subtracting whole days from an
  // IST midnight lands on an IST midnight — no re-normalisation needed.
  const earliestAllowed = end - (MAX_SCAN_DAYS - 1) * MS_PER_DAY;
  if (cursor < earliestAllowed) { cursor = earliestAllowed; truncated = true; }

  while (cursor <= end) {
    const key = bucketKey(cursor, period);
    const day = istDayKey(cursor);
    const existing = index.get(key);
    if (existing) {
      existing.end_date = day;
    } else {
      const b: Bucket = { key, start_date: day, end_date: day };
      index.set(key, b);
      out.push(b);
    }
    cursor += MS_PER_DAY;
  }

  if (out.length > MAX_BUCKETS) {
    // Drop the OLDEST buckets: the owner is looking at the recent end.
    return { buckets: out.slice(out.length - MAX_BUCKETS), truncated: true };
  }
  return { buckets: out, truncated };
}

/** IST calendar date (YYYY-MM-DD) -> the UTC instant of its 00:00 IST. null on
 *  anything that is not exactly that shape. */
export function dayKeyToMs(dayKey: string): number | null {
  const m = String(dayKey || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return istCivilToMs(Number(m[1]), Number(m[2]), Number(m[3]));
}

/** Whole IST days from `a` to `b`, counting both ends. null on junk. */
export function daysBetweenKeys(a: string, b: string): number | null {
  const x = dayKeyToMs(a), y = dayKeyToMs(b);
  if (x == null || y == null) return null;
  return Math.round((y - x) / MS_PER_DAY) + 1;
}

/** How far forward bucketEndDay() will look. A month is 31 days; nothing this
 *  file buckets is longer, and an unbounded walk on junk input is a hang. */
const MAX_BUCKET_DAYS = 40;

/**
 * The LAST IST calendar day of the bucket that `dayKey` falls in.
 *
 * Derived by walking forward while bucketKey() keeps returning the same key,
 * for the same reason denseBuckets() walks days: there is exactly ONE
 * implementation of where a bucket ends, so a caller asking "is this period
 * over yet?" cannot disagree with the series it is asking about. That matters
 * most at the edges arithmetic would get wrong — %W week 00 is a two-day stub
 * in some years, and February is not 30 days.
 *
 * Returns '' when the key is not a date.
 */
export function bucketEndDay(dayKey: string, period: Period): string {
  const startMs = dayKeyToMs(dayKey);
  if (startMs == null) return '';
  const key = bucketKey(startMs, period);
  let last = startMs;
  for (let i = 1; i <= MAX_BUCKET_DAYS; i++) {
    const next = startMs + i * MS_PER_DAY;
    if (bucketKey(next, period) !== key) break;
    last = next;
  }
  return istDayKey(last);
}

/** Hours between two ISO instants, or null when either is unusable. Never
 *  negative — a reply stamped before its review is bad data, not a -3h reply. */
export function hoursBetween(fromIso: string, toIso: string): number | null {
  const a = parseIsoMs(fromIso);
  const b = parseIsoMs(toIso);
  if (a == null || b == null) return null;
  const h = (b - a) / 3_600_000;
  return h < 0 ? null : h;
}
