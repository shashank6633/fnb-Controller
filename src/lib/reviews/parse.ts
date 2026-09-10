/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * GOOGLE REVIEWS — the parser. PURE: no database, no network, no clock except
 * an injectable "now" for the sanity window. Everything in this file can be
 * proved with a string literal and an assertion.
 *
 * IT HAS TO BE TOLERANT, BECAUSE THE INPUT IS NOT ONE FORMAT
 * ─────────────────────────────────────────────────────────
 * The guaranteed path is the owner running Google Takeout and handing over a
 * file. Takeout emits JSON only — there is no CSV or Excel option — but the
 * owner may equally paste a sheet a manager keeps, or export from whatever tool
 * he tried last year. So this parser accepts:
 *
 *   - a Business Profile v4 list response  { reviews: [...], averageRating, ... }
 *   - a Takeout reviews.json               (bare array, or nested under a location)
 *   - newline-delimited JSON
 *   - CSV / TSV with almost any spelling of the columns
 *   - the same CSV pasted as text
 *
 * and normalizes all of them to NormalizedReview. Anything it cannot read
 * becomes a counted ParseError carrying a sample — never a silent skip, and
 * never a zero-star row invented to keep the loop going.
 *
 * WHAT IT REFUSES, ON PURPOSE
 * ───────────────────────────
 * Relative dates ("2 months ago", "a year ago"). Those come from scraped
 * SERP-style exports, and they are unusable for the thing this engine is FOR:
 * you cannot build a daily count out of "a month ago". Rejecting them loudly
 * is also the honest answer to "can we just buy the data" — quite apart from
 * the Maps Platform no-scraping clause, the timestamps come back too coarse
 * to trend.
 */
import crypto from 'crypto';
import type {
  NormalizedReview, ParseError, ParseResult, RawKind, ReviewSourceKey, PostedPrecision,
} from './types';
import { istCivilToMs, parseIsoMs, toIsoUtc } from './time';

/* ── Limits ───────────────────────────────────────────────────────────────── */

/** No legitimate Google review is longer than this; the cap stops a malformed
 *  file (one giant unquoted field) from becoming one giant row. Truncated, not
 *  dropped — the rating and the date are still worth having. */
export const MAX_TEXT_CHARS = 20_000;
export const MAX_AUTHOR_CHARS = 200;
/** Reviews before this are a parse failure wearing a valid-looking date.
 *  Google Maps reviews did not exist in 1899, and a 1970 row destroys every
 *  trend axis it lands on. */
export const MIN_PLAUSIBLE_YEAR = 2004;
/** Tolerance for clock skew, or for a zone we read one way and they meant the
 *  other. Beyond it the date is wrong, not early. */
export const FUTURE_TOLERANCE_MS = 2 * 86_400_000;
/** Hard ceiling on items read from one document. */
export const MAX_ITEMS = 100_000;

/* ── Anonymous reviewers ──────────────────────────────────────────────────── */

/**
 * Google shows an unnamed reviewer as "A Google user" (and localized variants).
 * These names are NOT identities: every anonymous review shares them, so they
 * cannot enter a dedupe key the way a real display name can. Detected here,
 * flagged on the row, and handled by assignIdentities().
 */
const ANON_NAMES = [
  'a google user', 'google user', 'anonymous', 'anonyme', 'unknown', 'n/a', '-', '--',
];
export function isAnonymousAuthor(name: string): boolean {
  const n = (name || '').trim().toLowerCase();
  if (!n) return true;
  return ANON_NAMES.includes(n);
}

/* ── Rating coercion ──────────────────────────────────────────────────────── */

const WORD_RATINGS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  starratingone: 1, starratingtwo: 2, starratingthree: 3,
  starratingfour: 4, starratingfive: 5,
};

/**
 * Every rating spelling that has actually turned up in an export, mapped to an
 * integer 1-5. Returns null rather than guessing.
 *
 * Fractional ratings are REFUSED (except x.0). A "4.3" in a reviews file is an
 * AVERAGE that has leaked into a per-review column — accepting it would fold a
 * summary row into the review set and quietly lift every mean it touches.
 * STAR_RATING_UNSPECIFIED is refused for the same reason: it means Google does
 * not know, and inventing a 3 to fill the hole is worse than one error row.
 */
export function coerceRating(raw: any): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number') return intStar(raw);

  const s = String(raw).trim();
  if (!s) return null;

  const lower = s.toLowerCase();
  if (lower === 'star_rating_unspecified' || lower === 'unspecified') return null;
  const key = lower.replace(/[^a-z]/g, '');
  if (key in WORD_RATINGS) return WORD_RATINGS[key];

  // Star glyphs: 4 filled stars, or 4 filled + 1 hollow.
  const stars = (s.match(/[★⭐]/g) || []).length;
  if (stars >= 1 && stars <= 5 && !/\d/.test(s)) return stars;

  // "5", "5.0", "4 stars", "4/5", "4 out of 5"
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  return intStar(Number(m[0]));
}

function intStar(n: number): number | null {
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (Math.abs(n - rounded) > 1e-6) return null;   // 4.3 is an average, not a review
  if (rounded < 1 || rounded > 5) return null;
  return rounded;
}

/* ── Timestamp coercion ───────────────────────────────────────────────────── */

export type DateOrder = 'dmy' | 'mdy';

export interface TimestampResult {
  iso: string;
  precision: PostedPrecision;
  /** True when the string was DD/MM vs MM/DD ambiguous and the hint decided it.
   *  Counted onto the ingest run so the owner is told, not trusted silently. */
  ambiguous: boolean;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const RELATIVE_RE = /\b(ago|hace|vor)\b/i;

/**
 * Parse whatever the export called a date.
 *
 * THE ZONE RULE, stated because it decides which day a late-night review lands
 * on: a string carrying an explicit zone (Z or +05:30) is believed. A string
 * with NO zone is read as IST — the owner's clock. Google always stamps Z, so
 * a zoneless string came from a spreadsheet or a local export, and reading it
 * as UTC would shove every evening review back into the previous day.
 *
 * DD/MM vs MM/DD: if either component is > 12 the order is decided by the data.
 * If not (03/04/2026), it is genuinely undecidable from the string, the
 * `dateOrder` hint decides — defaulting to dmy, which is what an Indian export
 * produces — and the row is flagged `ambiguous` so the count reaches the owner.
 */
export function parseTimestamp(
  raw: any,
  opts: { dateOrder?: DateOrder; now?: number } = {},
): TimestampResult | { error: string } {
  const dateOrder = opts.dateOrder || 'dmy';
  const now = opts.now ?? Date.now();

  if (raw == null || raw === '') return { error: 'missing date' };

  // Epoch numbers (seconds or milliseconds).
  if (typeof raw === 'number' || /^\d{10}$|^\d{13}$/.test(String(raw).trim())) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return { error: 'unreadable date' };
    const ms = String(Math.trunc(Math.abs(n))).length <= 10 ? n * 1000 : n;
    return finishTs(ms, 'second', false, now);
  }

  const s = String(raw).trim();
  if (!s) return { error: 'missing date' };

  if (RELATIVE_RE.test(s)) {
    return {
      error: `relative date ${JSON.stringify(s.slice(0, 40))} cannot be dated — ` +
             'relative timestamps come from scraped exports and cannot produce a daily count',
    };
  }

  // RFC 3339 / ISO with an explicit zone — Google's own shape.
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const ms = parseIsoMs(s.replace(' ', 'T'));
    if (ms == null) return { error: `unreadable date ${JSON.stringify(s.slice(0, 40))}` };
    return finishTs(ms, 'second', false, now);
  }

  // Zoneless date+time -> IST.
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const ms = istCivilToMs(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0));
    return finishTs(ms, 'second', false, now);
  }

  // Bare ISO date -> IST midnight, day precision.
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return finishTs(istCivilToMs(+m[1], +m[2], +m[3]), 'day', false, now);

  // Slash / dot / dash civil dates, with an optional time.
  m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/);
  if (m) {
    const a = +m[1], b = +m[2], y = +m[3];
    let day: number, mon: number, ambiguous = false;
    if (a > 12 && b <= 12) { day = a; mon = b; }
    else if (b > 12 && a <= 12) { mon = a; day = b; }
    else if (a > 12 && b > 12) return { error: `unreadable date ${JSON.stringify(s.slice(0, 40))}` };
    else { ambiguous = true; if (dateOrder === 'mdy') { mon = a; day = b; } else { day = a; mon = b; } }
    if (mon < 1 || mon > 12 || day < 1 || day > 31) {
      return { error: `unreadable date ${JSON.stringify(s.slice(0, 40))}` };
    }
    const { hh, mm, ss } = clockParts(m[4], m[5], m[6], m[7]);
    const precision: PostedPrecision = m[4] ? 'second' : 'day';
    return finishTs(istCivilToMs(y, mon, day, hh, mm, ss), precision, ambiguous, now);
  }

  // "12 Apr 2026" / "Apr 12, 2026" / "April 12 2026", optional time.
  let parts: string[] | null = null;
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/);
  if (m) parts = [m[1], m[2], m[3], m[4], m[5], m[6], m[7]];
  else {
    const m2 = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/);
    if (m2) parts = [m2[2], m2[1], m2[3], m2[4], m2[5], m2[6], m2[7]];
  }
  if (parts) {
    const mon = MONTHS[parts[1].toLowerCase().slice(0, 3)];
    if (!mon) return { error: `unknown month in ${JSON.stringify(s.slice(0, 40))}` };
    const { hh, mm, ss } = clockParts(parts[3], parts[4], parts[5], parts[6]);
    const precision: PostedPrecision = parts[3] ? 'second' : 'day';
    return finishTs(istCivilToMs(+parts[2], mon, +parts[0], hh, mm, ss), precision, false, now);
  }

  return { error: `unreadable date ${JSON.stringify(s.slice(0, 40))}` };
}

function clockParts(h?: string, mi?: string, se?: string, ampm?: string) {
  let hh = h ? +h : 0;
  const mm = mi ? +mi : 0;
  const ss = se ? +se : 0;
  if (ampm) {
    const pm = /p/i.test(ampm);
    if (pm && hh < 12) hh += 12;
    if (!pm && hh === 12) hh = 0;
  }
  return { hh, mm, ss };
}

function finishTs(ms: number, precision: PostedPrecision, ambiguous: boolean, now: number):
    TimestampResult | { error: string } {
  if (!Number.isFinite(ms)) return { error: 'unreadable date' };
  const year = new Date(ms).getUTCFullYear();
  if (!Number.isFinite(year) || year < MIN_PLAUSIBLE_YEAR) {
    return { error: `date ${Number.isFinite(ms) ? toIsoUtc(ms) : '?'} is before Google reviews existed` };
  }
  if (ms > now + FUTURE_TOLERANCE_MS) return { error: `date ${toIsoUtc(ms)} is in the future` };
  return { iso: toIsoUtc(ms), precision, ambiguous };
}

/* ── Column mapping ───────────────────────────────────────────────────────── */

/** 'Reviewer Name' / 'reviewer.displayName' / 'REVIEWER_NAME' all collapse to
 *  'reviewername', so the synonym table stays readable. */
export function normalizeHeader(h: string): string {
  return String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Header synonyms, most specific first WITHIN each field. The order across
 * fields matters too: `name` is claimed by external_id first, and mapRecord()
 * then rejects a value that is not a v4 resource path, so a bare `name` column
 * holding "Priya S" does not become an id. That one rule is why an export whose
 * only author column is called "name" still parses.
 */
const FIELD_SYNONYMS: Record<string, string[]> = {
  external_id: ['reviewid', 'googlereviewid', 'reviewidentifier', 'id', 'name'],
  author_name: ['reviewername', 'reviewerdisplayname', 'authorname', 'author', 'reviewer',
                'username', 'customername', 'guestname', 'displayname', 'name'],
  rating: ['starrating', 'stars', 'rating', 'reviewrating', 'score', 'ratingvalue'],
  text: ['comment', 'reviewtext', 'reviewcomment', 'text', 'review', 'content', 'body',
         'snippet', 'description', 'feedback'],
  posted_at: ['createtime', 'reviewcreatetime', 'createdat', 'created', 'postedat',
              'publishedatdate', 'publishedat', 'reviewdate', 'datetime', 'date', 'time', 'timestamp'],
  source_updated_at: ['updatetime', 'updatedat', 'lastupdated', 'editedat', 'modifiedat'],
  reply_text: ['reviewreplycomment', 'replycomment', 'ownerreply', 'ownerresponse',
               'responsefromownertext', 'reply', 'replytext', 'response', 'owneranswer',
               'businessreply', 'managementresponse'],
  replied_at: ['reviewreplyupdatetime', 'replyupdatetime', 'repliedat', 'replytime', 'replydate',
               'responsefromownerdate', 'ownerreplytime', 'responsedate'],
  language: ['languagecode', 'originallanguage', 'reviewlanguage', 'language', 'lang'],
  location_key: ['locationname', 'locationid', 'placeid', 'location', 'store', 'outlet',
                 'branch', 'listing'],
};

const RESOURCE_PATH_RE = /(^|\/)reviews\/[^/]+$/;

/** Map a set of headers to fields. First synonym match wins per field, and a
 *  header is consumed by at most one field so `name` cannot be both. */
export function mapColumns(headers: string[]): { map: Record<string, string>; unmapped: string[] } {
  const norm = headers.map(h => ({ raw: h, n: normalizeHeader(h) }));
  const map: Record<string, string> = {};
  const taken = new Set<string>();

  for (const field of Object.keys(FIELD_SYNONYMS)) {
    for (const syn of FIELD_SYNONYMS[field]) {
      const hit = norm.find(h => h.n === syn && !taken.has(h.raw));
      if (hit) { map[hit.raw] = field; taken.add(hit.raw); break; }
    }
  }
  const unmapped = norm.filter(h => !taken.has(h.raw)).map(h => h.raw);
  return { map, unmapped };
}

/* ── CSV ──────────────────────────────────────────────────────────────────── */

/**
 * RFC 4180 CSV/TSV, written here rather than pulled in from papaparse because
 * this module has to run identically inside Next, inside a plain node test
 * script and inside a future worker, with no bundler in the middle. Handles
 * quoted fields, doubled quotes, embedded newlines (review text is FULL of
 * them), CRLF and a UTF-8 BOM.
 */
export function parseCsv(input: string): string[][] {
  return parseCsvWithDiagnostics(input).rows;
}

export interface CsvScan {
  rows: string[][];
  /**
   * The scan ended while still inside a quoted field.
   *
   * THIS IS THE MOST DESTRUCTIVE THING A CSV CAN DO AND IT USED TO BE THROWN
   * AWAY. One stray quote — `"He said "great" and left`, exactly what a
   * reviewer who typed a " produces — leaves an odd number of quotes, so from
   * that cell onwards every delimiter and every newline in the REST OF THE FILE
   * is swallowed as literal text. A 500-row export came back as 2 rows, was
   * stored as 2 rows, and the run closed green with "Rows read 2 · Added 2".
   * The reader had no way to tell that 497 reviews were missing.
   *
   * The scanner always knew; nobody asked it. Now it says so, and
   * parseDocument() refuses the document rather than importing 0.4% of it.
   */
  unterminated_quote: boolean;
  /** 1-based line on which the unterminated quote was opened, 0 when none. */
  unterminated_line: number;
}

/** parseCsv, plus the structural facts a caller needs in order to know whether
 *  what came back is the whole file. */
export function parseCsvWithDiagnostics(input: string): CsvScan {
  const text = input.replace(/^﻿/, '');
  const delim = pickDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let quoteOpenedLine = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; quoteOpenedLine = line; continue; }
    if (ch === delim) { row.push(field); field = ''; continue; }
    if (ch === '\r') { if (text[i + 1] === '\n') i++; line++; row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (ch === '\n') { line++; row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return {
    rows: rows.filter(r => r.length > 1 || (r[0] ?? '').trim() !== ''),
    unterminated_quote: inQuotes,
    unterminated_line: inQuotes ? quoteOpenedLine : 0,
  };
}

/* ── Bytes -> text ────────────────────────────────────────────────────────── */

export interface DecodedUpload {
  text: string;
  /** The encoding actually used. */
  encoding: 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'windows-1252';
  /** True when the bytes were NOT valid UTF-8 and a fallback was used. Worth
   *  showing: it is the owner's cue that the file came out of Excel. */
  fell_back: boolean;
  /** U+FFFD characters left in the decoded text. Should be 0 after this
   *  function; anything else means the bytes were damaged before we got them. */
  replacement_chars: number;
}

/**
 * Decode an uploaded file's BYTES into text.
 *
 * ── WHY THIS IS NOT `await file.text()` ─────────────────────────────────────
 * `File.text()` is UTF-8 only, and it does not fail on non-UTF-8 input — it
 * substitutes U+FFFD for every byte it cannot read. Excel's "CSV" on a Windows
 * machine is CP1252, so a perfectly ordinary export landed as `Priy� Reddy` and
 * `Caf� was tr�s bon` with ZERO errors reported. Three things then went wrong at
 * once: the mangled text was stored, the mangled text was ARCHIVED (so the
 * raw-first replay could never repair it — the original bytes were gone before
 * the archive saw them), and because the author name is part of the identity
 * key, re-importing the same reviews correctly encoded produced a second set of
 * rows instead of correcting the first.
 *
 * ── THE ORDER, AND WHY ──────────────────────────────────────────────────────
 * 1. A UTF-16 byte-order mark is unambiguous — Excel's "Unicode Text" export
 *    writes one — so it is honoured first and the BOM is dropped.
 * 2. A UTF-8 BOM is dropped and the rest decoded as UTF-8.
 * 3. Otherwise UTF-8 is tried STRICTLY (fatal: true). Valid UTF-8 is
 *    self-checking: a byte sequence that decodes cleanly as UTF-8 essentially
 *    never is anything else, so a clean strict decode is proof, not a guess.
 * 4. Only when that throws do we fall back to windows-1252, which is the
 *    encoding Excel writes on a Western Windows install and a superset of
 *    Latin-1. It cannot fail — every byte maps to something — so this is the
 *    end of the line, and `fell_back` records that a guess was made.
 *
 * Devanagari/Telugu text is multi-byte UTF-8 and passes step 3, so this never
 * downgrades an Indian-language export to CP1252.
 */
export function decodeUpload(bytes: Uint8Array): DecodedUpload {
  const finish = (text: string, encoding: DecodedUpload['encoding'], fellBack: boolean): DecodedUpload => ({
    text, encoding, fell_back: fellBack, replacement_chars: countReplacementChars(text),
  });

  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return finish(new TextDecoder('utf-16le').decode(bytes.subarray(2)), 'utf-16le', true);
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return finish(new TextDecoder('utf-16be').decode(bytes.subarray(2)), 'utf-16be', true);
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return finish(new TextDecoder('utf-8').decode(bytes.subarray(3)), 'utf-8-bom', false);
  }
  try {
    return finish(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'utf-8', false);
  } catch {
    // Not UTF-8. windows-1252 is the overwhelmingly likely alternative for a
    // spreadsheet export and never throws.
    try {
      return finish(new TextDecoder('windows-1252').decode(bytes), 'windows-1252', true);
    } catch {
      // A runtime built without the 1252 table. Lossy UTF-8 is still better
      // than refusing the import, and replacement_chars will say what happened.
      return finish(new TextDecoder('utf-8').decode(bytes), 'utf-8', true);
    }
  }
}

/** How many U+FFFD replacement characters a payload carries. Non-zero means the
 *  bytes were decoded with the wrong character set upstream and the original
 *  characters no longer exist anywhere in this string. */
export function countReplacementChars(payload: string): number {
  let n = 0;
  for (let i = 0; i < payload.length; i++) if (payload.charCodeAt(i) === 0xfffd) n++;
  return n;
}

/** Tab wins when the header line has more tabs than commas — a "CSV" pasted out
 *  of a spreadsheet is usually tab-separated and would otherwise land as one
 *  giant column. Semicolon covers European exports. */
function pickDelimiter(text: string): string {
  const nl = text.indexOf('\n');
  const head = nl === -1 ? text.slice(0, 4000) : text.slice(0, nl);
  const counts: Array<[string, number]> = [
    [',', (head.match(/,/g) || []).length],
    ['\t', (head.match(/\t/g) || []).length],
    [';', (head.match(/;/g) || []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

/* ── JSON discovery ───────────────────────────────────────────────────────── */

/** Does this object look like a review? Used to FIND the review array in a
 *  Takeout archive whose nesting we have not seen. A thing with a rating-ish
 *  key plus a time-ish or text-ish key is a review; a thing with neither is not. */
function looksLikeReview(o: any): boolean {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const keys = Object.keys(flattenReviewObject(o)).map(normalizeHeader);
  const hasRating = keys.some(k => FIELD_SYNONYMS.rating.includes(k));
  const hasTime = keys.some(k => FIELD_SYNONYMS.posted_at.includes(k));
  const hasText = keys.some(k => FIELD_SYNONYMS.text.includes(k));
  return hasRating && (hasTime || hasText);
}

/**
 * Walk any JSON and return the largest array of review-shaped objects.
 * `reviews` is preferred by name when it exists, so a v4 response is read
 * exactly, and the search is a fallback for a shape nobody has documented.
 */
export function findReviewItems(root: any, depth = 0): any[] {
  if (depth > 8 || root == null) return [];
  if (Array.isArray(root)) {
    if (root.some(looksLikeReview)) return root;
    let best: any[] = [];
    for (const child of root) {
      const found = findReviewItems(child, depth + 1);
      if (found.length > best.length) best = found;
    }
    return best;
  }
  if (typeof root !== 'object') return [];

  for (const preferred of ['reviews', 'result', 'data', 'items']) {
    const v = (root as any)[preferred];
    if (Array.isArray(v) && v.some(looksLikeReview)) return v;
  }
  let best: any[] = [];
  for (const k of Object.keys(root)) {
    const found = findReviewItems((root as any)[k], depth + 1);
    if (found.length > best.length) best = found;
  }
  return best;
}

/** JSON, JSON-lines, or nothing. */
function readJsonDocument(payload: string): { items: any[]; ok: boolean } {
  const trimmed = payload.trim();
  if (!trimmed) return { items: [], ok: false };
  try {
    return { items: findReviewItems(JSON.parse(trimmed)), ok: true };
  } catch { /* try NDJSON */ }

  const lines = trimmed.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const items: any[] = [];
  let parsedAny = false;
  for (const line of lines) {
    try {
      const o = JSON.parse(line);
      parsedAny = true;
      if (Array.isArray(o)) items.push(...o);
      else items.push(o);
    } catch { /* not NDJSON either */ }
  }
  return { items: parsedAny ? items : [], ok: parsedAny };
}

/* ── Record -> NormalizedReview ───────────────────────────────────────────── */

/** Read a possibly-nested key: reviewer.displayName, reviewReply.comment. */
function dig(obj: any, path: string[]): any {
  let cur = obj;
  for (const p of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * Flatten a v4-shaped review object into the flat record the column mapper
 * understands, so ONE mapping table serves JSON and CSV alike. The nested
 * paths Google actually uses are lifted explicitly; scalar keys are copied
 * through and matched by name.
 */
export function flattenReviewObject(o: any): Record<string, any> {
  const flat: Record<string, any> = {};
  for (const [k, v] of Object.entries(o || {})) {
    if (v != null && typeof v === 'object') continue;   // nested — handled below
    flat[k] = v;
  }
  const nested: Array<[string, string[]]> = [
    ['reviewerDisplayName', ['reviewer', 'displayName']],
    ['reviewerIsAnonymous', ['reviewer', 'isAnonymous']],
    ['reviewReplyComment', ['reviewReply', 'comment']],
    ['reviewReplyUpdateTime', ['reviewReply', 'updateTime']],
    ['reviewReplyComment', ['review_reply', 'comment']],
    ['reviewReplyUpdateTime', ['review_reply', 'update_time']],
    ['authorName', ['author', 'name']],
    ['authorName', ['author', 'displayName']],
  ];
  for (const [key, path] of nested) {
    const v = dig(o, path);
    if (v !== undefined && v !== null && flat[key] === undefined) flat[key] = v;
  }
  return flat;
}

interface MapOpts {
  source: ReviewSourceKey;
  defaultLocationKey?: string;
  dateOrder?: DateOrder;
  now?: number;
  /** Called with the in-file location value whenever it disagreed with the
   *  listing the import was aimed at. See the location_key note in mapRecord. */
  onLocationOverride?: (fileValue: string) => void;
}

/** One flat record -> one NormalizedReview, or an error string. */
export function mapRecord(
  record: Record<string, any>,
  columnMap: Record<string, string>,
  opts: MapOpts,
  rawItem: string,
): NormalizedReview | { error: string } {
  /** The cell AND the header it came from — the header matters for the `name`
   *  disambiguation below, which cannot be decided from the value alone. */
  const getCell = (field: string): { value: any; header: string } | undefined => {
    for (const [header, mapped] of Object.entries(columnMap)) {
      if (mapped === field) {
        const v = record[header];
        if (v !== undefined && v !== null && String(v).trim() !== '') return { value: v, header };
      }
    }
    return undefined;
  };
  const get = (field: string): any => getCell(field)?.value;

  const rating = coerceRating(get('rating'));
  if (rating == null) {
    const shown = get('rating');
    return {
      error: shown === undefined
        ? 'no rating column, or the rating cell is empty'
        : `unusable rating ${JSON.stringify(String(shown).slice(0, 30))}`,
    };
  }

  const ts = parseTimestamp(get('posted_at'), { dateOrder: opts.dateOrder, now: opts.now });
  if ('error' in ts) return { error: ts.error };

  // THE `name` COLUMN, which is two different things depending on the export.
  // In a v4 review it is the resource path accounts/x/locations/y/reviews/ID and
  // the ID is the identity we want. In a hand-kept spreadsheet it is the guest's
  // name. mapColumns() claims it for external_id (deterministically, so the
  // mapping is stable), and the value decides here: a resource path keeps only
  // its id; anything else from a column literally called "name" is a PERSON and
  // is handed to the author field instead of becoming a fake identity.
  const idCell = getCell('external_id');
  let externalId = idCell ? String(idCell.value).trim() : '';
  let nameColumnFallback = '';
  if (RESOURCE_PATH_RE.test(externalId)) {
    externalId = externalId.split('/').pop() || '';
  } else if (idCell && normalizeHeader(idCell.header) === 'name') {
    nameColumnFallback = externalId;
    externalId = '';
  } else if (externalId.includes('/')) {
    externalId = externalId.split('/').pop() || '';
  }
  // An id never contains whitespace and is never a paragraph. Length is NOT a
  // test: Google's ids are long, but an export or a test fixture may legitimately
  // use short ones, and rejecting those would silently drop the only edit-safe
  // identity a row has.
  if (externalId && (/\s/.test(externalId) || externalId.length > 200)) externalId = '';

  let author = String(get('author_name') ?? nameColumnFallback).trim().slice(0, MAX_AUTHOR_CHARS);
  if (RESOURCE_PATH_RE.test(author) || author.startsWith('accounts/')) author = '';

  const explicitAnon = record.reviewerIsAnonymous;
  const anon = (explicitAnon === true || explicitAnon === 'true')
    ? 1
    : (isAnonymousAuthor(author) ? 1 : 0);

  const text = String(get('text') ?? '').slice(0, MAX_TEXT_CHARS);

  const updRaw = get('source_updated_at');
  const upd = updRaw ? parseTimestamp(updRaw, { dateOrder: opts.dateOrder, now: opts.now }) : null;
  const sourceUpdatedAt = upd && !('error' in upd) ? upd.iso : '';

  const replyText = String(get('reply_text') ?? '').slice(0, MAX_TEXT_CHARS);
  const repRaw = get('replied_at');
  const rep = repRaw ? parseTimestamp(repRaw, { dateOrder: opts.dateOrder, now: opts.now }) : null;
  let repliedAt = rep && !('error' in rep) ? rep.iso : '';
  // A reply stamped before its review is bad data. Keep the reply (it exists),
  // drop the impossible timestamp, so reply-SPEED maths excludes it instead of
  // averaging in a negative.
  if (repliedAt) {
    const a = parseIsoMs(ts.iso), b = parseIsoMs(repliedAt);
    if (a != null && b != null && b < a) repliedAt = '';
  }

  // ── WHICH LISTING THIS ROW BELONGS TO ─────────────────────────────────────
  // THE IMPORT TARGET WINS. It used to be the other way round — the cell won —
  // and the result was silent and total: a manager's sheet whose first column
  // is `Branch` (a location synonym) sent every row to location_key
  // 'AKAN Jubilee Hills' while the import panel reported "2 added" and the page,
  // which reads location_key '', showed nothing. The rows were not lost, they
  // were invisible, and no screen explained where they had gone.
  //
  // The person importing chose a listing from a list. That choice is an
  // instruction, not a default to be overridden by a spelling inside the file.
  // The in-file value is still read — so the disagreement can be REPORTED
  // rather than discovered months later — but it does not decide anything.
  //
  // When no target was supplied at all (defaultLocationKey undefined, i.e. a
  // caller that genuinely does not know), the cell is still the best available
  // answer and is used.
  const fileLocation = String(get('location_key') ?? '').trim();
  let locationKey: string;
  if (opts.defaultLocationKey === undefined) {
    locationKey = fileLocation;
  } else {
    locationKey = String(opts.defaultLocationKey).trim();
    if (fileLocation && fileLocation !== locationKey) opts.onLocationOverride?.(fileLocation);
  }

  return {
    source: opts.source,
    location_key: locationKey,
    external_id: externalId,
    author_name: anon ? '' : author,
    author_is_anonymous: anon as 0 | 1,
    rating,
    text,
    language: String(get('language') ?? '').trim().slice(0, 20),
    posted_at: ts.iso,
    posted_precision: ts.precision,
    source_updated_at: sourceUpdatedAt,
    reply_text: replyText,
    replied_at: repliedAt,
    raw_item: rawItem,
  };
}

/* ── Document parsing ─────────────────────────────────────────────────────── */

export interface ParseOptions {
  source: ReviewSourceKey;
  /** Which listing these rows belong to when the document does not say. */
  defaultLocationKey?: string;
  dateOrder?: DateOrder;
  /** Injectable clock so the future-date guard is testable. */
  now?: number;
  /** Force the reader instead of sniffing. */
  kind?: RawKind;
}

/** Sniff JSON vs delimited text. A payload starting with { or [ is JSON. */
export function detectKind(payload: string): RawKind {
  const t = payload.replace(/^﻿/, '').trim();
  if (!t) return 'text';
  if (t[0] === '{' || t[0] === '[') return 'json';
  return 'csv';
}

/**
 * ONE document -> normalized reviews + counted errors. Never throws for bad
 * content: an unreadable file comes back as zero reviews and one error, so the
 * raw payload is still archived and the run still closes honestly.
 */
export function parseDocument(payload: string, opts: ParseOptions): ParseResult {
  const kind = opts.kind || detectKind(payload);
  const errors: ParseError[] = [];
  const reviews: NormalizedReview[] = [];
  let ambiguous = 0;
  let columnMap: Record<string, string> = {};
  let unmapped: string[] = [];
  let overlong = 0;
  let short = 0;

  // A mis-decoded upload cannot be repaired here — the bytes are already gone —
  // but it can be COUNTED, so nobody reads "Priy\uFFFD Reddy" off the page and
  // assumes it is how the guest spells their name. The route that owns the
  // bytes sniffs the encoding; this is the backstop for every other caller.
  const replacementChars = countReplacementChars(payload);

  /** In-file location values that disagreed with the import target. A Set, so
   *  a 500-row sheet with one wrong branch name reports one name, not 500. */
  const overriddenLocations = new Set<string>();
  let locationOverridden = 0;
  const mapOpts: ParseOptions & { onLocationOverride: (v: string) => void } = {
    ...opts,
    onLocationOverride: (v: string) => {
      locationOverridden++;
      if (overriddenLocations.size < 20) overriddenLocations.add(v.slice(0, 120));
    },
  };

  const done = (over: Partial<ParseResult> = {}): ParseResult => ({
    reviews, errors, ambiguous_dates: ambiguous, column_map: columnMap,
    unmapped_columns: unmapped, detected: kind, fatal: '',
    overlong_rows: overlong, short_rows: short, replacement_chars: replacementChars,
    location_overridden: locationOverridden, location_values: [...overriddenLocations],
    ...over,
  });

  const push = (rec: Record<string, any>, map: Record<string, string>, index: number, rawItem: string) => {
    const mapped = mapRecord(rec, map, mapOpts, rawItem);
    if ('error' in mapped) {
      errors.push({ index, reason: mapped.error, sample: rawItem.slice(0, 300) });
      return false;
    }
    reviews.push(mapped);
    return true;
  };

  const countAmbiguous = (rec: Record<string, any>, map: Record<string, string>) => {
    const ts = parseTimestamp(pickMapped(rec, map, 'posted_at'), { dateOrder: opts.dateOrder, now: opts.now });
    if (!('error' in ts) && ts.ambiguous) ambiguous++;
  };

  if (kind === 'json' || (opts.kind === undefined && detectKind(payload) === 'json')) {
    const { items, ok } = readJsonDocument(payload);
    if (!ok) {
      errors.push({ index: 1, reason: 'not valid JSON or JSON-lines', sample: payload.slice(0, 300) });
      return done({ ambiguous_dates: 0, column_map: {}, unmapped_columns: [], detected: 'json',
                    fatal: 'The file is not valid JSON or JSON-lines, so nothing in it could be read.' });
    }
    if (!items.length) {
      errors.push({
        index: 1,
        reason: 'valid JSON, but no review-shaped objects found — a Takeout archive holds ' +
                'one reviews.json per location; upload that file rather than the archive index',
        sample: payload.slice(0, 300),
      });
      return done({ ambiguous_dates: 0, column_map: {}, unmapped_columns: [], detected: 'json',
                    fatal: 'The file is valid JSON but holds no reviews.' });
    }

    const capped = items.slice(0, MAX_ITEMS);
    // Union of keys across a sample, so an item missing `reviewReply` does not
    // cost every other item its reply column.
    const keySet = new Set<string>();
    for (const it of capped.slice(0, 500)) {
      for (const k of Object.keys(flattenReviewObject(it))) keySet.add(k);
    }
    const mappedCols = mapColumns([...keySet]);
    columnMap = mappedCols.map; unmapped = mappedCols.unmapped;

    capped.forEach((item, i) => {
      const flat = flattenReviewObject(item);
      if (push(flat, columnMap, i + 1, safeJson(item))) countAmbiguous(flat, columnMap);
    });
    return done({ detected: 'json' });
  }

  // CSV / pasted text
  const scan = parseCsvWithDiagnostics(payload);
  const rows = scan.rows;

  // ── THE FILE ENDED INSIDE A QUOTE. Refuse the whole document. ────────────
  // Everything after the unbalanced quote was swallowed into one cell, so the
  // rows that DID come back are a prefix of the file and nothing here can tell
  // how much is missing. Importing that prefix is worse than importing nothing:
  // it looks like a complete history and every count computed from it is wrong.
  if (scan.unterminated_quote) {
    // The row that derailed it is the LAST one the reader produced: everything
    // from there to the end of the file went into a single cell of that row. It
    // is a far more useful pointer than the line the surviving open quote sits
    // on, which is wherever the last stray " happens to be, often the last line.
    const faultRow = Math.max(1, scan.rows.length - 1);
    const fatal =
      `This file has an unbalanced quotation mark and could not be read. Row ${faultRow} opens a ` +
      `quote that is never closed, so everything after it — every remaining row — was read as one ` +
      `long cell instead of as rows. NOTHING from this file was imported; importing the part that ` +
      `did read would have looked like a complete history while missing most of it. ` +
      `This is almost always a review whose text contains a " character: open the file, fix the ` +
      `quoting on row ${faultRow}, and import it again.`;
    errors.push({ index: faultRow, reason: fatal, sample: payload.slice(0, 300) });
    return done({ reviews: [], ambiguous_dates: 0, column_map: {}, unmapped_columns: [], detected: kind, fatal });
  }

  if (rows.length < 2) {
    errors.push({ index: 1, reason: 'no data rows found below the header', sample: payload.slice(0, 300) });
    return done({ ambiguous_dates: 0, column_map: {}, unmapped_columns: [], detected: kind,
                  fatal: 'No data rows were found below the header row.' });
  }
  const headers = rows[0].map(h => h.trim());
  const mappedCols = mapColumns(headers);
  columnMap = mappedCols.map; unmapped = mappedCols.unmapped;

  const fields = Object.values(columnMap);
  if (!fields.includes('rating') || !fields.includes('posted_at')) {
    const why = `header has no recognisable ${!fields.includes('rating') ? 'rating' : 'date'} column ` +
                `(saw: ${headers.slice(0, 12).join(', ')})`;
    errors.push({ index: 1, reason: why, sample: rows[0].join(',') });
    return done({ ambiguous_dates: 0, detected: kind, fatal: why });
  }

  for (let r = 1; r < rows.length && r <= MAX_ITEMS; r++) {
    const cells = rows[r];
    if (cells.length === 1 && String(cells[0] ?? '').trim() === '') continue;   // blank line

    // ── A ROW MUST HAVE THE HEADER'S SHAPE ────────────────────────────────
    // More cells than headers means the row is SHIFTED: an unescaped delimiter
    // has pushed every later value one column left, so the date column now
    // holds text and the text column holds a date. Reading it by position
    // stores confident nonsense, so the row is refused and counted instead.
    if (cells.length > headers.length) {
      overlong++;
      errors.push({
        index: r,
        reason: `row has ${cells.length} values but the header has ${headers.length} columns — ` +
                'the values are shifted, so the row was refused rather than read into the wrong ' +
                'fields. Usually an unescaped comma inside a review.',
        sample: cells.join(',').slice(0, 300),
      });
      continue;
    }
    // Fewer cells is common in hand-kept sheets that simply stop at the last
    // filled column. Readable, so it is kept — but counted, because a run of
    // them is what a wrong delimiter looks like.
    if (cells.length < headers.length) short++;

    const rec: Record<string, any> = {};
    headers.forEach((h, c) => { rec[h] = cells[c] ?? ''; });
    if (headers.every(h => String(rec[h] ?? '').trim() === '')) continue;   // blank line
    if (push(rec, columnMap, r, safeJson(rec))) countAmbiguous(rec, columnMap);
  }

  return done({ detected: kind });
}

function pickMapped(rec: Record<string, any>, map: Record<string, string>, field: string): any {
  for (const [header, mapped] of Object.entries(map)) {
    if (mapped === field) {
      const v = rec[header];
      if (v !== undefined && v !== null && String(v).trim() !== '') return v;
    }
  }
  return undefined;
}

function safeJson(v: any): string {
  try { return JSON.stringify(v) ?? ''; } catch { return String(v).slice(0, 1000); }
}

/* ── Identity: the dedupe key ─────────────────────────────────────────────── */

export function sha1(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex');
}

/**
 * WHICH KEY, AND WHY — this is the whole idempotency story, so it is spelled
 * out rather than left to the reader.
 *
 * 1. external_id (Google's reviewId) when the export carries one. It is stable
 *    across edits, so an author rewriting their review UPDATES the row. This is
 *    the only fully edit-safe basis, and both the v4 API and a Takeout export
 *    normally provide it.
 *
 * 2. No id, named author -> sha1(location | author | createTime).
 *    Google permits ONE review per user per place, so (place, author) is already
 *    close to unique; the creation time makes a delete-and-repost distinct.
 *    THE REVIEW TEXT IS DELIBERATELY EXCLUDED. Putting it in would make an edit
 *    look like a new review and double-count it — exactly the failure the gate
 *    "a review edited by its author updates rather than duplicating" tests for.
 *    Note createTime, not updateTime: an edit changes updateTime, so keying on
 *    that would break the same way.
 *
 * 3. No id, anonymous author -> sha1(location | createTime | rating | textHash)
 *    plus a stable ordinal among identical rows.
 *    "A Google user" is not an identity — every anonymous reviewer shares it —
 *    so bases 1 and 2 are both unavailable, and the CONTENT is the only thing
 *    separating two anonymous reviews at the same instant. The cost is real and
 *    is reported, never hidden: if an anonymous author edits their text, the
 *    edit lands as a NEW row (counted as weak_identity on the run). The ordinal
 *    stops two genuinely distinct but identical anonymous reviews — same day,
 *    same rating, no text — from collapsing into one, which is the opposite
 *    error and the more likely one.
 *
 * The ordinal is computed within the DOCUMENT, not against the database, so it
 * is deterministic: the same file always yields the same keys, and a later file
 * containing one extra identical row appends rather than renumbering.
 */
export function assignIdentities(reviews: NormalizedReview[]):
    Array<{ review: NormalizedReview; identity_key: string; identity_basis: 'external_id' | 'composite_author_time' | 'composite_anon' }> {
  const anonSeen = new Map<string, number>();

  return reviews.map(r => {
    if (r.external_id) {
      return { review: r, identity_key: `id:${r.external_id}`, identity_basis: 'external_id' as const };
    }
    if (!r.author_is_anonymous && r.author_name) {
      const author = r.author_name.trim().toLowerCase().replace(/\s+/g, ' ');
      const key = `au:${sha1([r.location_key, author, r.posted_at].join('|'))}`;
      return { review: r, identity_key: key, identity_basis: 'composite_author_time' as const };
    }
    const base = sha1([r.location_key, r.posted_at, String(r.rating), sha1(r.text)].join('|'));
    const n = anonSeen.get(base) ?? 0;
    anonSeen.set(base, n + 1);
    return { review: r, identity_key: `an:${base}#${n}`, identity_basis: 'composite_anon' as const };
  });
}

/** Everything an owner would call "the review changed". posted_at is in here
 *  because a corrected date IS a change worth writing; the identity key is not,
 *  because that is the thing saying the two rows are the same review. */
export function contentHash(r: Pick<NormalizedReview,
  'rating' | 'text' | 'reply_text' | 'replied_at' | 'author_name' | 'language' | 'posted_at'>): string {
  return sha1(JSON.stringify([
    r.rating, r.text, r.reply_text, r.replied_at, r.author_name, r.language, r.posted_at,
  ]));
}

/* ── Merge: what an existing row keeps ────────────────────────────────────── */

export interface MergeDecision {
  action: 'update' | 'unchanged' | 'skip_stale';
  merged: NormalizedReview;
  reason: string;
}

/**
 * Reconcile an incoming row against the one already stored.
 *
 * TWO RULES, both learned from the Reservego importer, both about the same
 * failure: an OLD export must never be able to undo a NEWER one.
 *
 *   STALE GUARD. If both sides carry a source updateTime and the incoming one
 *   is older, the incoming row is refused outright (skip_stale). Re-uploading
 *   last month's Takeout after this month's cannot roll a reply back off a row.
 *
 *   NEVER-BLANK. Without update times there is no ordering to appeal to, so the
 *   merge is conservative: a non-empty stored reply, text, language or author is
 *   never overwritten with an empty incoming one. New information is accepted;
 *   the ABSENCE of information is not treated as news.
 *
 * When the incoming row IS authoritative (a newer updateTime), it wins
 * field-for-field including deletions — an author who edits their review down to
 * a bare rating really has removed the text, and pretending otherwise would keep
 * a quote on the page that no longer exists.
 */
export function mergeReview(existing: NormalizedReview, incoming: NormalizedReview): MergeDecision {
  const eUpd = existing.source_updated_at;
  const iUpd = incoming.source_updated_at;

  if (eUpd && iUpd && iUpd < eUpd) {
    return { action: 'skip_stale', merged: existing, reason: `incoming updateTime ${iUpd} is older than stored ${eUpd}` };
  }

  const authoritative = !!iUpd && (!eUpd || iUpd >= eUpd);
  const keep = (inc: string, exi: string) => (authoritative ? inc : (inc || exi));

  const merged: NormalizedReview = {
    ...existing,
    source: incoming.source,
    external_id: incoming.external_id || existing.external_id,
    author_name: keep(incoming.author_name, existing.author_name),
    author_is_anonymous: incoming.author_is_anonymous,
    rating: incoming.rating,
    text: keep(incoming.text, existing.text),
    language: keep(incoming.language, existing.language),
    posted_at: incoming.posted_at || existing.posted_at,
    posted_precision: incoming.posted_precision,
    source_updated_at: iUpd || eUpd,
    reply_text: keep(incoming.reply_text, existing.reply_text),
    replied_at: keep(incoming.replied_at, existing.replied_at),
    raw_item: incoming.raw_item || existing.raw_item,
    location_key: existing.location_key,
  };

  // A day-precision incoming date must not overwrite a second-precision stored
  // one: a CSV re-export at 00:00 would otherwise erase the real posting time
  // and, with it, every reply-speed figure computed from it.
  if (existing.posted_precision === 'second' && incoming.posted_precision === 'day') {
    merged.posted_at = existing.posted_at;
    merged.posted_precision = 'second';
  }

  const same = contentHash(merged) === contentHash(existing);
  return {
    action: same ? 'unchanged' : 'update',
    merged,
    reason: same ? 'identical content' : 'content differs',
  };
}
