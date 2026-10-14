/**
 * Indian Standard Time (IST) date/time formatting helpers.
 *
 * STORAGE: every timestamp on the server is written via SQLite's
 * `datetime('now')` which returns UTC in the format "2026-05-29 14:00:00"
 * (no timezone suffix). When parsed by `new Date(...)` the browser would
 * otherwise treat it as LOCAL time — which is wrong on servers in any zone.
 * `parseDb()` below normalizes that: it appends "Z" so the string is parsed
 * as UTC, then `Intl.DateTimeFormat` with `timeZone: 'Asia/Kolkata'` renders
 * it in IST regardless of where the user's browser thinks it is.
 *
 * USAGE:
 *   fmtIST('2026-05-29 14:00:00')          // "29 May 2026, 7:30 pm IST"
 *   fmtIST('2026-05-29T14:00:00Z', { withTz: false })  // "29 May 2026, 7:30 pm"
 *   fmtISTDate('2026-05-29')               // "29 May 2026"
 *   fmtISTTime('2026-05-29 14:00:00')      // "7:30 pm"
 *   fmtISTRelative('2026-05-29 14:00:00')  // "5 minutes ago"
 *   fmtISTShort('2026-05-29 14:00:00')     // "29 May, 7:30 pm"
 */

const TZ = 'Asia/Kolkata';

/**
 * Parse a value the server gave us into a Date.
 * Accepts SQLite UTC strings ("YYYY-MM-DD HH:mm:ss"), ISO strings, Date
 * instances, and numbers (epoch ms). Returns null for empty / invalid input.
 *
 * SQLite's `datetime('now')` lacks a timezone marker — we MUST treat it as
 * UTC explicitly, otherwise the browser parses it as the user's local zone
 * and IST-rendering then double-shifts the result.
 *
 * FRACTIONAL SECONDS ARE THE SAME UTC STAMP, NOT A DIFFERENT SHAPE.
 * The department ledger (src/lib/dept-ledger.ts nowMs()) writes created_at as
 * `new Date().toISOString()` minus its 'Z' — "2026-10-14 08:15:30.123", UTC
 * to the millisecond. Before 2026-10-14 the pattern below stopped at the
 * seconds, so that string fell through to a bare `new Date(s)`: Chrome and
 * Node read a zone-less date-time as LOCAL time (5 h 30 m early on an IST
 * device — a 13:45 IST transfer printed as 08:15), and Safari rejects the
 * space-separated form outright, so every such stamp printed the fallback.
 * The fraction is now accepted and normalised to exactly three digits (the
 * only width ECMA-262's date-time format defines, which is what Safari holds
 * strings to), then parsed as UTC like every other zone-less stamp.
 *
 * NOTHING ELSE CHANGES. A string the old pattern matched is matched and
 * rebuilt byte-for-byte as before (the fraction group is empty for it). A
 * string carrying its own zone ('Z', '+05:30') never matched and still goes to
 * `new Date(s)` untouched, as do Date instances, epoch numbers and bare dates.
 */
function parseDb(value: unknown): Date | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') return new Date(value);
  const s = String(value).trim();
  if (!s) return null;
  // SQLite UTC without 'Z' — normalize to ISO so parsing is unambiguous.
  // Pattern: "2026-05-29 14:00:00"     → "2026-05-29T14:00:00Z"
  //          "2026-10-14 08:15:30.123" → "2026-10-14T08:15:30.123Z"
  // (a 'T' separator is accepted too: "2026-05-29T14:00" → "2026-05-29T14:00Z")
  let iso = s;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(:\d{2})?)(\.\d+)?$/);
  // Seconds are required before a fraction ("14:00.5" is not a time) — such a
  // string is left to `new Date` exactly as it always was.
  if (m && !(m[4] && !m[3])) {
    const frac = m[4] ? `.${(m[4].slice(1) + '00').slice(0, 3)}` : '';
    iso = `${m[1]}T${m[2]}${frac}Z`;
  }
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

type FmtOpts = {
  /** Append " IST" suffix. Default true. */
  withTz?: boolean;
  /** Default '—' shown when value is empty/invalid. */
  fallback?: string;
};

/** Full date + time in IST. e.g. "29 May 2026, 7:30 pm IST" */
export function fmtIST(value: unknown, opts: FmtOpts = {}): string {
  const d = parseDb(value);
  if (!d) return opts.fallback ?? '—';
  const txt = new Intl.DateTimeFormat('en-IN', {
    timeZone: TZ,
    day: '2-digit', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(d);
  return opts.withTz === false ? txt : `${txt} IST`;
}

/** Short date + time in IST. e.g. "29 May, 7:30 pm" */
export function fmtISTShort(value: unknown, opts: FmtOpts = {}): string {
  const d = parseDb(value);
  if (!d) return opts.fallback ?? '—';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: TZ,
    day: '2-digit', month: 'short',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(d);
}

/** Date only (no time). e.g. "29 May 2026" */
export function fmtISTDate(value: unknown, opts: FmtOpts = {}): string {
  const d = parseDb(value);
  if (!d) return opts.fallback ?? '—';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: TZ,
    day: '2-digit', month: 'short', year: 'numeric',
  }).format(d);
}

/** Time only (no date). e.g. "7:30 pm" */
export function fmtISTTime(value: unknown, opts: FmtOpts = {}): string {
  const d = parseDb(value);
  if (!d) return opts.fallback ?? '—';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: TZ,
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(d);
}

/** Relative time. e.g. "just now", "5 minutes ago", "3 hours ago", "yesterday".
 *  Falls back to fmtIST() for anything older than 7 days. */
export function fmtISTRelative(value: unknown, opts: FmtOpts = {}): string {
  const d = parseDb(value);
  if (!d) return opts.fallback ?? '—';
  const ms = Date.now() - d.getTime();
  if (ms < 0) return fmtIST(d, opts);            // future date — show absolute
  if (ms < 30_000) return 'just now';
  if (ms < 60_000) return `${Math.floor(ms / 1000)} sec ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} hr ago`;
  if (ms < 172_800_000) return 'yesterday';
  if (ms < 604_800_000) return `${Math.floor(ms / 86_400_000)} days ago`;
  return fmtIST(d, opts);
}

/** ISO date in IST zone (YYYY-MM-DD). Useful for grouping/filtering. */
export function fmtISTIsoDate(value: unknown): string {
  const d = parseDb(value);
  if (!d) return '';
  // en-CA happens to format as YYYY-MM-DD which is exactly ISO-date.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/** Today's date as YYYY-MM-DD in IST. Useful for default form values. */
export function todayIST(): string {
  return fmtISTIsoDate(new Date());
}
