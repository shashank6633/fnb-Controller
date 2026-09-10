/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * GOOGLE REVIEWS — ingestion. The only thing in this module that writes.
 *
 * THE ORDER OF OPERATIONS IS THE DESIGN
 * ─────────────────────────────────────
 *   1. open a run row                    (so a crash leaves evidence, not silence)
 *   2. ARCHIVE THE RAW DOCUMENT, committed on its own
 *   3. parse                             (may produce errors; cannot lose step 2)
 *   4. upsert inside ONE transaction     (all-or-nothing per run)
 *   5. close the run with honest counters
 *
 * Step 2 before step 3 is the raw-first law the WhatsApp webhook already runs
 * on (src/app/api/whatsapp/webhook/route.ts: the raw INSERT is the first,
 * never-fail step, and ingest wraps in its own try). Here it buys something
 * specific and valuable: the owner's Takeout export is a MANUAL act. If the
 * parser mis-reads a column, we must be able to fix the parser and replay —
 * see replayRawDocuments() — rather than asking him to go and export again.
 *
 * IDEMPOTENCY
 * ───────────
 * Every write is an upsert against UNIQUE(location_key, identity_key). Import
 * the same file twice and the second pass reports inserted 0 / updated 0 /
 * unchanged N and writes nothing. That is a gate in scripts/reviews-tests.js,
 * not an aspiration: the test snapshots every column of every row, re-imports,
 * and compares.
 *
 * WHAT COUNTS AS "CHANGED" is parse.ts contentHash(); what an existing row is
 * allowed to lose is parse.ts mergeReview(). Both are pure and both are tested
 * on their own, so this file is only plumbing.
 */
import type Database from 'better-sqlite3';
import { getDb, generateId } from '@/lib/db';
import crypto from 'crypto';
import { scrubCredentials } from '@/lib/ct/recording-fetch';
import { ensureReviewSchema, RAW_PAYLOAD_MAX_BYTES } from './schema';
import {
  assignIdentities, contentHash, mergeReview, parseDocument, type DateOrder,
} from './parse';
import type {
  AnalysisReview, IngestResult, NormalizedReview, ParseError, RawDocument,
  ReviewRow, ReviewSourceKey,
} from './types';

type DB = Database.Database;

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/* ── Runs ─────────────────────────────────────────────────────────────────── */

export interface StartRunOptions {
  source: ReviewSourceKey;
  locationKey?: string;
  actor?: string;
  label?: string;
  expectedTotal?: number | null;
}

export function startRun(db: DB, opts: StartRunOptions): string {
  ensureReviewSchema(db);
  const id = generateId();
  db.prepare(`
    INSERT INTO gr_ingest_runs (id, source, location_key, actor, label, status, started_at, expected_total)
    VALUES (?, ?, ?, ?, ?, 'running', ?, ?)
  `).run(id, opts.source, opts.locationKey || '', opts.actor || '', opts.label || '', nowIso(),
         opts.expectedTotal ?? null);
  return id;
}

/**
 * Archive one raw document. Committed on its own, BEFORE any parsing, and never
 * updated afterwards.
 *
 * Over RAW_PAYLOAD_MAX_BYTES the payload is stored truncated with
 * payload_truncated = 1. Truncated provenance beats no provenance: the run can
 * still say where the rows came from, and the flag tells a future replay that
 * this particular document cannot be fully re-read.
 */
export function archiveRaw(
  db: DB, runId: string, doc: RawDocument, source: ReviewSourceKey, locationKey = '',
): string {
  ensureReviewSchema(db);
  const id = generateId();
  const full = doc.payload ?? '';
  const bytes = Buffer.byteLength(full, 'utf8');
  const truncated = bytes > RAW_PAYLOAD_MAX_BYTES;
  const stored = truncated ? full.slice(0, RAW_PAYLOAD_MAX_BYTES) : full;

  db.prepare(`
    INSERT INTO gr_ingest_raw (id, run_id, source, location_key, kind, label, payload,
                               payload_sha256, byte_len, payload_truncated, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, runId, source, locationKey, doc.kind, doc.label || '', stored, sha256(full), bytes,
         truncated ? 1 : 0, nowIso());
  return id;
}

/* ── The upsert ───────────────────────────────────────────────────────────── */

const SELECT_BY_IDENTITY = `
  SELECT * FROM gr_reviews WHERE location_key = ? AND identity_key = ?
`;

const INSERT_REVIEW = `
  INSERT INTO gr_reviews (
    id, source, location_key, external_id, identity_key, identity_basis,
    author_name, author_is_anonymous, rating, text, text_len, language,
    posted_at, posted_precision, source_updated_at, reply_text, replied_at,
    content_hash, first_seen_at, fetched_at, raw_id, raw_item, run_id
  ) VALUES (
    @id, @source, @location_key, @external_id, @identity_key, @identity_basis,
    @author_name, @author_is_anonymous, @rating, @text, @text_len, @language,
    @posted_at, @posted_precision, @source_updated_at, @reply_text, @replied_at,
    @content_hash, @first_seen_at, @fetched_at, @raw_id, @raw_item, @run_id
  )
`;

const UPDATE_REVIEW = `
  UPDATE gr_reviews SET
    source = @source, external_id = @external_id, identity_basis = @identity_basis,
    author_name = @author_name, author_is_anonymous = @author_is_anonymous,
    rating = @rating, text = @text, text_len = @text_len, language = @language,
    posted_at = @posted_at, posted_precision = @posted_precision,
    source_updated_at = @source_updated_at, reply_text = @reply_text,
    replied_at = @replied_at, content_hash = @content_hash, fetched_at = @fetched_at,
    raw_id = @raw_id, raw_item = @raw_item, run_id = @run_id
  WHERE id = @id
`;

/** Only the timestamp moves when nothing else did, so "when did we last see
 *  this review" stays true without the row counting as changed. */
const TOUCH_REVIEW = `UPDATE gr_reviews SET fetched_at = ?, run_id = ? WHERE id = ?`;

function rowToNormalized(row: any): NormalizedReview {
  return {
    source: row.source,
    location_key: row.location_key,
    external_id: row.external_id,
    author_name: row.author_name,
    author_is_anonymous: row.author_is_anonymous ? 1 : 0,
    rating: row.rating,
    text: row.text,
    language: row.language,
    posted_at: row.posted_at,
    posted_precision: row.posted_precision === 'day' ? 'day' : 'second',
    source_updated_at: row.source_updated_at,
    reply_text: row.reply_text,
    replied_at: row.replied_at,
    raw_item: row.raw_item,
  };
}

export interface IngestOptions {
  source: ReviewSourceKey;
  locationKey?: string;
  actor?: string;
  label?: string;
  dateOrder?: DateOrder;
  /** The total the owner can read off the live Google listing. Optional, and
   *  the single most useful thing he can supply: Google Takeout has been
   *  reported to export incomplete review sets, so a delta between this and
   *  what we stored is the difference between a trustworthy page and a
   *  confidently wrong one. Recorded and shown, never assumed away. */
  expectedTotal?: number | null;
  /** Injectable clock, for tests. */
  now?: number;
  /** Reuse an already-open run (the replay path). */
  runId?: string;
  /**
   * Write each document into gr_ingest_raw. TRUE for every real ingest, and
   * FALSE for a replay, whose documents came OUT of that archive — archiving
   * them again doubles a store the file header calls write-once and makes the
   * next replay re-read its own copies. When false, each document must carry
   * `archived_raw_id`.
   */
  archive?: boolean;
}

/**
 * Parse and store a set of raw documents. Synchronous — better-sqlite3 is —
 * and safe to call inside another transaction only if that caller is prepared
 * for this one to be nested (it uses its own transaction wrapper).
 */
export function ingestDocuments(
  dbIn: DB | null,
  documents: RawDocument[],
  opts: IngestOptions,
): IngestResult {
  const db = ensureReviewSchema(dbIn || getDb());
  const locationKey = (opts.locationKey || '').trim();
  const runId = opts.runId || startRun(db, {
    source: opts.source, locationKey, actor: opts.actor, label: opts.label,
    expectedTotal: opts.expectedTotal ?? null,
  });

  const result: IngestResult = {
    run_id: runId, raw_ids: [],
    rows_seen: 0, inserted: 0, updated: 0, unchanged: 0, skipped_stale: 0, errors: 0,
    weak_identity: 0, parse_errors: [], ambiguous_dates: 0,
    column_map: {}, unmapped_columns: [],
    fatal_documents: 0, overlong_rows: 0, short_rows: 0, replacement_chars: 0,
    location_overridden: 0, location_values: [],
    reconciliation: { expected_total: opts.expectedTotal ?? null, stored_total: 0, delta: null },
  };

  try {
    // ── 1. RAW FIRST. Each document committed before anything reads it,
    // UNLESS the caller is replaying documents that are already in the archive
    // (opts.archive === false) — re-archiving those doubles the write-once
    // provenance store on every replay. See replayRawDocuments().
    const parsedPerDoc: Array<{ rawId: string; reviews: NormalizedReview[]; errors: ParseError[] }> = [];
    for (const doc of documents) {
      const rawId = opts.archive === false
        ? String(doc.archived_raw_id || '')
        : archiveRaw(db, runId, doc, opts.source, locationKey);
      if (opts.archive !== false) result.raw_ids.push(rawId);

      const parsed = parseDocument(doc.payload, {
        source: opts.source,
        defaultLocationKey: locationKey,
        dateOrder: opts.dateOrder,
        now: opts.now,
        kind: doc.kind === 'text' ? undefined : doc.kind,
      });
      // A structurally unreadable document contributes NOTHING and fails the
      // run. Importing the readable prefix of a file that ended inside a quote
      // is how 500 reviews became 2 and still closed green.
      if (parsed.fatal) result.fatal_documents++;
      parsedPerDoc.push({ rawId, reviews: parsed.fatal ? [] : parsed.reviews, errors: parsed.errors });
      result.ambiguous_dates += parsed.ambiguous_dates;
      result.overlong_rows += parsed.overlong_rows;
      result.short_rows += parsed.short_rows;
      result.replacement_chars += parsed.replacement_chars;
      result.location_overridden += parsed.location_overridden;
      for (const v of parsed.location_values) {
        if (!result.location_values.includes(v) && result.location_values.length < 20) {
          result.location_values.push(v);
        }
      }
      result.parse_errors.push(...parsed.errors.map(e => ({ ...e, sample: `[${doc.label}] ${e.sample}` })));
      // The last document's mapping wins for display; in practice one import is
      // one shape, and a multi-page API pull has an identical shape per page.
      if (Object.keys(parsed.column_map).length) {
        result.column_map = parsed.column_map;
        result.unmapped_columns = parsed.unmapped_columns;
      }
    }
    result.errors = result.parse_errors.length;

    // ── 2. IDENTITIES ARE ASSIGNED PER DOCUMENT, which is what parse.ts has
    // always documented ("The ordinal is computed within the DOCUMENT") and
    // what makes a replay idempotent.
    //
    // Numbering across the whole run instead was the bug: replayRawDocuments()
    // merges EVERY archived document for a (source, location) into one run, and
    // real archives overlap — the May export and the June export both contain
    // May's reviews. Run-wide numbering saw the second copy of an anonymous
    // review as "the same content, seen twice, therefore two distinct reviews"
    // and issued it ordinal #1, a brand-new identity key. Three reviews became
    // five, then ten, then twenty: one replay per doubling.
    //
    // Per document, the second copy gets ordinal #0 again — the SAME key — so
    // the upsert recognises it as the review it already holds. Two genuinely
    // distinct anonymous reviews that are identical to the byte within ONE
    // document still get #0 and #1 and stay distinct, which is the case the
    // ordinal exists for.
    const flat: Array<{ rawId: string; review: NormalizedReview; identity_key: string;
                        identity_basis: 'external_id' | 'composite_author_time' | 'composite_anon' }> = [];
    for (const d of parsedPerDoc) {
      for (const it of assignIdentities(d.reviews)) {
        flat.push({ rawId: d.rawId, review: it.review, identity_key: it.identity_key, identity_basis: it.identity_basis });
      }
    }
    result.rows_seen = flat.length;

    const identified = flat;

    // ── 3. One transaction for the whole run.
    const selectStmt = db.prepare(SELECT_BY_IDENTITY);
    const insertStmt = db.prepare(INSERT_REVIEW);
    const updateStmt = db.prepare(UPDATE_REVIEW);
    const touchStmt = db.prepare(TOUCH_REVIEW);
    const fetchedAt = nowIso();

    const apply = db.transaction(() => {
      identified.forEach((item, i) => {
        const incoming = item.review;
        const rawId = flat[i].rawId;
        if (item.identity_basis === 'composite_anon') result.weak_identity++;

        const existingRow: any = selectStmt.get(incoming.location_key, item.identity_key);

        if (!existingRow) {
          insertStmt.run({
            id: generateId(),
            source: incoming.source,
            location_key: incoming.location_key,
            external_id: incoming.external_id,
            identity_key: item.identity_key,
            identity_basis: item.identity_basis,
            author_name: incoming.author_name,
            author_is_anonymous: incoming.author_is_anonymous,
            rating: incoming.rating,
            text: incoming.text,
            text_len: incoming.text.trim().length,
            language: incoming.language,
            posted_at: incoming.posted_at,
            posted_precision: incoming.posted_precision,
            source_updated_at: incoming.source_updated_at,
            reply_text: incoming.reply_text,
            replied_at: incoming.replied_at,
            content_hash: contentHash(incoming),
            first_seen_at: fetchedAt,
            fetched_at: fetchedAt,
            raw_id: rawId,
            raw_item: incoming.raw_item,
            run_id: runId,
          });
          result.inserted++;
          return;
        }

        const decision = mergeReview(rowToNormalized(existingRow), incoming);
        if (decision.action === 'skip_stale') { result.skipped_stale++; return; }
        if (decision.action === 'unchanged') {
          touchStmt.run(fetchedAt, runId, existingRow.id);
          result.unchanged++;
          return;
        }
        const m = decision.merged;
        updateStmt.run({
          id: existingRow.id,
          source: m.source,
          external_id: m.external_id,
          identity_basis: item.identity_basis,
          author_name: m.author_name,
          author_is_anonymous: m.author_is_anonymous,
          rating: m.rating,
          text: m.text,
          text_len: m.text.trim().length,
          language: m.language,
          posted_at: m.posted_at,
          posted_precision: m.posted_precision,
          source_updated_at: m.source_updated_at,
          reply_text: m.reply_text,
          replied_at: m.replied_at,
          content_hash: contentHash(m),
          fetched_at: fetchedAt,
          raw_id: rawId,
          raw_item: m.raw_item,
          run_id: runId,
        });
        result.updated++;
      });
    });
    apply();

    // ── 4. Reconcile against the live listing, if the owner told us its total.
    const stored = db.prepare(
      `SELECT COUNT(*) AS n FROM gr_reviews WHERE location_key = ?`,
    ).get(locationKey) as { n: number };
    result.reconciliation.stored_total = stored.n;
    if (opts.expectedTotal != null) {
      result.reconciliation.delta = stored.n - opts.expectedTotal;
    }

    // A run that read 2 rows out of a 500-row file must not close green. The
    // rows that DID parse are kept (they are real, and the upsert makes a
    // re-import free), but the run is marked FAILED so the page's staleness and
    // coverage logic — which keys on the last SUCCESSFUL run — refuses to treat
    // this import as covering anything.
    if (result.fatal_documents > 0) {
      const why = result.parse_errors.find(e => /ends inside a quoted field|not valid JSON|no recognisable|no data rows/.test(e.reason));
      finishRun(db, runId, result, 'error',
        `${result.fatal_documents} document(s) could not be read in full. ${why ? why.reason : ''}`.slice(0, 800));
      return result;
    }

    finishRun(db, runId, result, 'done', '');
    return result;
  } catch (e: any) {
    const message = scrubCredentials(String(e?.message || e), []).slice(0, 800);
    try { finishRun(db, runId, result, 'error', message); } catch { /* run row is best-effort */ }
    throw e;
  }
}

function finishRun(db: DB, runId: string, r: IngestResult, status: 'done' | 'error', errorText: string): void {
  db.prepare(`
    UPDATE gr_ingest_runs SET
      status = ?, finished_at = ?, rows_seen = ?, inserted = ?, updated = ?, unchanged = ?,
      skipped_stale = ?, errors = ?, weak_identity = ?, ambiguous_dates = ?,
      stored_total = ?, error_text = ?, notes = ?
    WHERE id = ?
  `).run(
    status, nowIso(), r.rows_seen, r.inserted, r.updated, r.unchanged,
    r.skipped_stale, r.errors, r.weak_identity, r.ambiguous_dates,
    r.reconciliation.stored_total, errorText,
    JSON.stringify({
      column_map: r.column_map,
      unmapped_columns: r.unmapped_columns,
      // A sample, not the lot: an unreadable 5,000-row file must not put 5,000
      // error strings into one row of the runs table.
      parse_errors: r.parse_errors.slice(0, 50),
      parse_error_total: r.parse_errors.length,
    }).slice(0, 200_000),
    runId,
  );
}

/* ── Replay: the payoff of storing raw ────────────────────────────────────── */

/**
 * Re-parse documents already archived, through the CURRENT parser, into the
 * same table. This is what raw-first is FOR.
 *
 * When a column turns out to have been mis-read — a date order, a reply column
 * nobody had seen, a rating spelling — the fix is a parser change plus this
 * function. No second Takeout export, no re-approval, no asking the owner to
 * go and do the manual step again. Because every write is still the same
 * idempotent upsert, a replay over unchanged data is a no-op.
 *
 * Documents stored truncated (payload_truncated = 1) are replayed as far as
 * they go and reported, because a partial replay that says so is honest and a
 * silent one is not.
 */
export function replayRawDocuments(
  dbIn: DB | null,
  opts: { rawIds?: string[]; runIds?: string[]; actor?: string; dateOrder?: DateOrder; now?: number } = {},
): IngestResult & { truncated_documents: number } {
  const db = ensureReviewSchema(dbIn || getDb());

  let rows: any[];
  if (opts.rawIds?.length) {
    rows = db.prepare(
      `SELECT * FROM gr_ingest_raw WHERE id IN (${opts.rawIds.map(() => '?').join(',')}) ORDER BY received_at`,
    ).all(...opts.rawIds);
  } else if (opts.runIds?.length) {
    rows = db.prepare(
      `SELECT * FROM gr_ingest_raw WHERE run_id IN (${opts.runIds.map(() => '?').join(',')}) ORDER BY received_at`,
    ).all(...opts.runIds);
  } else {
    rows = db.prepare(`SELECT * FROM gr_ingest_raw ORDER BY received_at`).all();
  }

  if (!rows.length) {
    const runId = startRun(db, { source: 'takeout_json', actor: opts.actor, label: 'replay (no documents)' });
    const empty: IngestResult = {
      run_id: runId, raw_ids: [], rows_seen: 0, inserted: 0, updated: 0, unchanged: 0,
      skipped_stale: 0, errors: 0, weak_identity: 0, parse_errors: [], ambiguous_dates: 0,
      column_map: {}, unmapped_columns: [],
      fatal_documents: 0, overlong_rows: 0, short_rows: 0, replacement_chars: 0,
      location_overridden: 0, location_values: [],
      reconciliation: { expected_total: null, stored_total: 0, delta: null },
    };
    finishRun(db, runId, empty, 'done', '');
    return { ...empty, truncated_documents: 0 };
  }

  // Replay keeps each document's ORIGINAL source AND location, because that is
  // what it actually was. Re-attributing on replay is not a cosmetic slip: the
  // upsert is keyed on (location_key, identity_key), so a document replayed
  // against the wrong location matches nothing and re-inserts every row it
  // holds — a silent doubling of the entire history.
  const groups = new Map<string, { source: ReviewSourceKey; locationKey: string; docs: RawDocument[] }>();
  let truncated = 0;
  for (const r of rows) {
    if (r.payload_truncated) truncated++;
    const locationKey = String(r.location_key ?? '');
    const gk = `${r.source}\u0000${locationKey}`;
    const g = groups.get(gk) || { source: r.source as ReviewSourceKey, locationKey, docs: [] };
    // The label is the ORIGINAL document's, not `replay:` + it. Nesting the
    // prefix on every pass produced `replay:replay:replay:orig.csv`, which is a
    // record of how many times we replayed rather than of where the bytes came
    // from. The run's own label already says it was a replay.
    g.docs.push({ kind: r.kind, payload: r.payload, label: String(r.label || r.id), archived_raw_id: String(r.id) });
    groups.set(gk, g);
  }

  const merged: IngestResult & { truncated_documents: number } = {
    run_id: '', raw_ids: [], rows_seen: 0, inserted: 0, updated: 0, unchanged: 0,
    skipped_stale: 0, errors: 0, weak_identity: 0, parse_errors: [], ambiguous_dates: 0,
    column_map: {}, unmapped_columns: [],
    fatal_documents: 0, overlong_rows: 0, short_rows: 0, replacement_chars: 0,
    location_overridden: 0, location_values: [],
    reconciliation: { expected_total: null, stored_total: 0, delta: null },
    truncated_documents: truncated,
  };

  for (const g of groups.values()) {
    const one = ingestDocuments(db, g.docs, {
      source: g.source,
      locationKey: g.locationKey,
      actor: opts.actor,
      label: `replay of ${g.docs.length} archived document(s)`,
      dateOrder: opts.dateOrder,
      now: opts.now,
      // These documents ARE the archive. Writing them back into it is what made
      // the store double on every replay.
      archive: false,
    });
    merged.run_id = merged.run_id || one.run_id;
    merged.raw_ids.push(...one.raw_ids);
    merged.rows_seen += one.rows_seen;
    merged.inserted += one.inserted;
    merged.updated += one.updated;
    merged.unchanged += one.unchanged;
    merged.skipped_stale += one.skipped_stale;
    merged.errors += one.errors;
    merged.weak_identity += one.weak_identity;
    merged.ambiguous_dates += one.ambiguous_dates;
    merged.fatal_documents += one.fatal_documents;
    merged.overlong_rows += one.overlong_rows;
    merged.short_rows += one.short_rows;
    merged.replacement_chars += one.replacement_chars;
    merged.location_overridden += one.location_overridden;
    for (const v of one.location_values) {
      if (!merged.location_values.includes(v) && merged.location_values.length < 20) merged.location_values.push(v);
    }
    merged.parse_errors.push(...one.parse_errors);
    merged.reconciliation.stored_total = one.reconciliation.stored_total;
  }
  return merged;
}

/* ── Reads (for the page phase and for tests) ─────────────────────────────── */

export interface ListOptions {
  locationKey?: string;
  /** Inclusive ISO bounds on posted_at. */
  from?: string;
  to?: string;
  limit?: number;
}

/** The narrow shape the pure analysis functions take. Nothing here is derived —
 *  every figure is computed by analysis.ts from these columns. */
export function analysisRows(dbIn: DB | null, opts: ListOptions = {}): AnalysisReview[] {
  const db = ensureReviewSchema(dbIn || getDb());
  const where: string[] = [];
  const args: any[] = [];
  if (opts.locationKey !== undefined) { where.push('location_key = ?'); args.push(opts.locationKey); }
  if (opts.from) { where.push('posted_at >= ?'); args.push(opts.from); }
  if (opts.to) { where.push('posted_at <= ?'); args.push(opts.to); }
  const sql = `SELECT id, rating, text, posted_at, posted_precision, reply_text, replied_at,
                      author_name, language
                 FROM gr_reviews
                ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                ORDER BY posted_at ASC
                ${opts.limit ? 'LIMIT ?' : ''}`;
  if (opts.limit) args.push(opts.limit);
  return db.prepare(sql).all(...args) as AnalysisReview[];
}

export function listReviews(dbIn: DB | null, opts: ListOptions = {}): ReviewRow[] {
  const db = ensureReviewSchema(dbIn || getDb());
  const where: string[] = [];
  const args: any[] = [];
  if (opts.locationKey !== undefined) { where.push('location_key = ?'); args.push(opts.locationKey); }
  if (opts.from) { where.push('posted_at >= ?'); args.push(opts.from); }
  if (opts.to) { where.push('posted_at <= ?'); args.push(opts.to); }
  const sql = `SELECT * FROM gr_reviews
               ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY posted_at DESC ${opts.limit ? 'LIMIT ?' : ''}`;
  if (opts.limit) args.push(opts.limit);
  return db.prepare(sql).all(...args) as ReviewRow[];
}

export function listRuns(dbIn: DB | null, limit = 25): any[] {
  const db = ensureReviewSchema(dbIn || getDb());
  return db.prepare(
    `SELECT * FROM gr_ingest_runs ORDER BY started_at DESC LIMIT ?`,
  ).all(Math.min(200, Math.max(1, limit)));
}

export function getRun(dbIn: DB | null, runId: string): any {
  const db = ensureReviewSchema(dbIn || getDb());
  return db.prepare(`SELECT * FROM gr_ingest_runs WHERE id = ?`).get(runId);
}
