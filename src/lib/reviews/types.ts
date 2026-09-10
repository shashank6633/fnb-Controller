/**
 * GOOGLE REVIEWS — shared vocabulary for the ingestion + analysis engine.
 *
 * TWO DESIGN LAWS, and they pull in different directions, which is why the
 * engine is source-agnostic rather than built around one fetcher.
 *
 *   1. AUTOMATIC RETRIEVAL IS THE PRODUCT. The owner's words: "it should
 *      automatically retrieve the reviews data... how can we import every
 *      time?" He is right. The connector (./sources-gbp.ts + ./refresh.ts) is
 *      the primary path and the thing a screen should push him towards.
 *
 *   2. HE MUST NOT BE BLOCKED BY GOOGLE'S APPROVAL PROCESS. API access needs an
 *      application, an approval email on no published timetable, an OAuth
 *      consent screen and a refresh token he mints himself. None of it can be
 *      done on his behalf, and the token can be refused later.
 *
 * So:
 *   • GBP API — the same rows, fetched on a schedule, once connected. PRIMARY.
 *   • MANUAL — a Takeout `reviews.json`, a CSV, or pasted text. No credential,
 *     no approval, no network. This is the BACKFILL (history predating the
 *     connection) and the FALLBACK (the weeks before approval, and any day the
 *     token breaks). Secondary, and permanent.
 *
 * Both write NormalizedReview through one ingest function, deduplicated on one
 * identity key, so a Takeout import and an API pull de-duplicate AGAINST EACH
 * OTHER and can run concurrently without double-counting. That is what lets the
 * fallback stay in place instead of being migrated away from.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *   • No scraping and no paid aggregator. Google's Maps Platform terms carry a
 *     "No Scraping" clause that names user reviews specifically; the exposed
 *     asset is the restaurant's own live listing. Not worth it, and not built.
 *   • No Places API. It returns a hard maximum of 5 reviews, ordered by
 *     relevance rather than recency, with no pagination — it cannot answer a
 *     single question this engine is for.
 *   • No guest-360 join. Google exposes a display name and nothing else — no
 *     phone, no email — and the CRM keys on the last 10 digits of a phone
 *     (src/lib/ct/guest-unify.ts). Display-name matching would manufacture
 *     false joins into guest history. Not attempted.
 */

/* ── Sources ──────────────────────────────────────────────────────────────── */

/** Every writer into gr_reviews. Stored verbatim in gr_reviews.source. */
export const REVIEW_SOURCES = ['takeout_json', 'csv', 'paste', 'gbp_api'] as const;
export type ReviewSourceKey = (typeof REVIEW_SOURCES)[number];

/** How a raw document arrived, for replay. */
export const RAW_KINDS = ['json', 'csv', 'text'] as const;
export type RawKind = (typeof RAW_KINDS)[number];

/**
 * Which basis produced a row's identity key. Stored per row because it decides
 * whether an author's EDIT updates the row or duplicates it, and the page has
 * to be able to say so honestly rather than implying every row is edit-safe.
 *
 *   external_id            — Google's own reviewId. Stable across edits.
 *                            The only fully edit-safe basis.
 *   composite_author_time  — no id in the export, but a named author: keyed on
 *                            (location, author, createTime). Google permits one
 *                            review per user per place, so this is effectively
 *                            unique, and it excludes the review TEXT on purpose
 *                            so an edit updates instead of duplicating.
 *   composite_anon         — anonymous reviewer ("A Google user") with no id.
 *                            Nothing distinguishes two anonymous reviews at the
 *                            same timestamp except their content, so the text
 *                            hash and a stable ordinal enter the key. An
 *                            anonymous author who EDITS their text will land as
 *                            a new row. That is a real, counted limitation —
 *                            ingest reports it — not something to paper over.
 */
export const IDENTITY_BASES = ['external_id', 'composite_author_time', 'composite_anon'] as const;
export type IdentityBasis = (typeof IDENTITY_BASES)[number];

/** Timestamp resolution we actually got. A CSV carrying only `2026-04-11` is
 *  'day'; RFC 3339 `createTime` is 'second'. Day-precision rows are anchored to
 *  00:00 IST, which is fine for daily/weekly/monthly buckets and useless for
 *  "how fast did we reply" — reply-speed maths skips them and says so. */
export type PostedPrecision = 'second' | 'day';

/* ── The normalized row every source produces ─────────────────────────────── */

export interface NormalizedReview {
  source: ReviewSourceKey;
  /** Which listing this belongs to. '' = the single default listing. Kept so a
   *  second outlet can be added later without a migration. */
  location_key: string;
  /** Google's reviewId when the source carried one; '' otherwise. */
  external_id: string;
  author_name: string;
  author_is_anonymous: 0 | 1;
  /** Integer 1..5. Anything else is an error row, never a silent 0. */
  rating: number;
  text: string;
  /** BCP-47-ish tag when the source gave one; '' otherwise. NEVER guessed. */
  language: string;
  /** ISO-8601 UTC, seconds precision: 2026-04-11T13:45:02Z */
  posted_at: string;
  posted_precision: PostedPrecision;
  /** Source updateTime, when present. Drives the stale-import guard. */
  source_updated_at: string;
  reply_text: string;
  replied_at: string;
  /** The single source item, verbatim, as JSON — the raw-first law applied per
   *  row so a parser change can be replayed without re-fetching. */
  raw_item: string;
}

/** A row as stored. */
export interface ReviewRow extends NormalizedReview {
  id: string;
  identity_key: string;
  identity_basis: IdentityBasis;
  text_len: number;
  content_hash: string;
  first_seen_at: string;
  fetched_at: string;
  raw_id: string;
  run_id: string;
  ai_status: string;
  ai_json: string;
  ai_error: string;
  ai_at: string;
  ai_model: string;
}

/** The minimum an analysis function needs. Deliberately narrower than ReviewRow
 *  so every figure below can be recomputed from a hand-written fixture with no
 *  database anywhere near it. */
export interface AnalysisReview {
  id: string;
  rating: number;
  text: string;
  posted_at: string;
  posted_precision?: PostedPrecision;
  reply_text: string;
  replied_at: string;
  author_name?: string;
  language?: string;
}

/* ── Parse results ────────────────────────────────────────────────────────── */

export interface ParseError {
  /** 1-based index within the document, so an owner can find the row. */
  index: number;
  reason: string;
  /** The offending item, truncated — enough to identify it, never the whole file. */
  sample: string;
}

export interface ParseResult {
  reviews: NormalizedReview[];
  errors: ParseError[];
  /** Rows whose date was DD/MM vs MM/DD ambiguous and resolved by the hint.
   *  Surfaced on the run so the owner is told rather than trusting silently. */
  ambiguous_dates: number;
  /** Header → normalized field, for CSV. Shown back to the owner so a
   *  mis-mapped column is visible before it becomes data. */
  column_map: Record<string, string>;
  /** Headers we could not place. Not an error — just unused. */
  unmapped_columns: string[];
  /** What the parser decided the document was. */
  detected: RawKind;
  /**
   * Set when the DOCUMENT ITSELF is unreadable, as opposed to some rows in it
   * being bad. The only value so far is an unbalanced quote, which makes a CSV
   * reader swallow the whole rest of the file into one cell — the file is then
   * 0.4% imported and every row after the fault is gone with no error of its
   * own. A fatal document contributes NO reviews and fails its run.
   */
  fatal: string;
  /** Data rows holding MORE cells than the header — the row is shifted, so the
   *  columns after the shift are read as the wrong field. Refused, not stored. */
  overlong_rows: number;
  /** Data rows holding FEWER cells than the header. Kept (a sloppy export that
   *  omits trailing empties is still readable) but counted, because a run of
   *  them is the fingerprint of a delimiter or quoting problem. */
  short_rows: number;
  /** U+FFFD characters in the payload. Non-zero means the bytes were decoded
   *  with the wrong character set BEFORE this parser ever saw them, and the
   *  original characters are already gone. */
  replacement_chars: number;
  /** Rows whose in-file location/branch column disagreed with the listing the
   *  import was aimed at. The chosen listing wins; this counts the disagreement
   *  so it is reported instead of discovered later. */
  location_overridden: number;
  /** The distinct in-file location values that were overridden, capped. */
  location_values: string[];
}

/* ── Ingestion ────────────────────────────────────────────────────────────── */

export interface IngestCounts {
  rows_seen: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped_stale: number;
  errors: number;
  /** Rows keyed on composite_anon — i.e. rows where an author edit would
   *  duplicate rather than update. Reported, never hidden. */
  weak_identity: number;
}

export interface IngestResult extends IngestCounts {
  run_id: string;
  raw_ids: string[];
  parse_errors: ParseError[];
  ambiguous_dates: number;
  column_map: Record<string, string>;
  unmapped_columns: string[];
  /** Documents refused whole because they were structurally unreadable (see
   *  ParseResult.fatal). Non-zero fails the run: a partial import that closes
   *  green is the failure this counter exists to make impossible. */
  fatal_documents: number;
  /** Rows refused for holding more cells than the header. */
  overlong_rows: number;
  /** Rows kept but short of the header's column count. */
  short_rows: number;
  /** U+FFFD characters seen across the documents — a mis-decoded upload. */
  replacement_chars: number;
  /** Rows whose in-file location/branch column disagreed with the listing this
   *  import was aimed at. The chosen listing wins; this says how often. */
  location_overridden: number;
  /** The distinct in-file location values that were overridden, capped. */
  location_values: string[];
  /**
   * Reconciliation against the count the owner can see on the live listing.
   * Google Takeout has been reported to export incomplete review sets, so the
   * import NEVER silently trusts the file: if the owner supplies the listing's
   * own total, the delta is recorded and shown.
   */
  reconciliation: {
    expected_total: number | null;
    stored_total: number;
    delta: number | null;
  };
}

/* ── Source (provider) abstraction ────────────────────────────────────────── */

export interface SourceStatus {
  /** Can this source produce documents right now? */
  ready: boolean;
  /** Why not — written for the owner, not for a log. */
  reason: string;
  /** Ordered prerequisites the OWNER must complete himself. Empty for manual. */
  prerequisites: string[];
  /** Facts about this source that are documented but NOT verified against a
   *  live credential in this build. Rendered as-is; never presented as tested. */
  unproven: string[];
}

/** One raw document as collected — a whole uploaded file, or one API page. */
export interface RawDocument {
  kind: RawKind;
  /** The bytes exactly as they arrived. */
  payload: string;
  /** Filename, or `page 2 of accounts/x/locations/y`. For the run log. */
  label: string;
  /**
   * Set ONLY on the replay path: the gr_ingest_raw row this document was read
   * back out of. Replayed documents are already in the write-once archive, so
   * they must not be written to it a second time — that is what turned one
   * archived document into sixteen over four replays, with labels nesting as
   * `replay:replay:replay:replay:orig.csv`. The rows this document produces
   * keep pointing at the ORIGINAL raw id, which is where they really came from.
   */
  archived_raw_id?: string;
}

/**
 * The connector interface. A manual source's collect() just hands back what the
 * owner uploaded; the GBP source's collect() does OAuth + paginated HTTP. Both
 * feed the identical parse → ingest pipeline, which is why stage 2 adds a file
 * and changes nothing else.
 */
export interface ReviewSource {
  key: ReviewSourceKey;
  label: string;
  /** 'manual' needs a human with a file; 'api' runs unattended once configured. */
  kind: 'manual' | 'api';
  status(): SourceStatus;
  collect(opts: CollectOptions): Promise<RawDocument[]>;
}

export interface CollectOptions {
  /** Manual sources: the uploaded/pasted documents. */
  documents?: RawDocument[];
  /** API sources: stop after this many pages (safety valve). */
  maxPages?: number;
  /** API sources: an AbortSignal, so a page-side cancel really cancels. */
  signal?: AbortSignal;
}

/** Thrown by an API source that has not been set up. Carries the owner's
 *  to-do list rather than a stack trace, because "not configured" is a
 *  paperwork state, not a bug. */
export class SourceNotConfiguredError extends Error {
  prerequisites: string[];
  constructor(message: string, prerequisites: string[] = []) {
    super(message);
    this.name = 'SourceNotConfiguredError';
    this.prerequisites = prerequisites;
  }
}
