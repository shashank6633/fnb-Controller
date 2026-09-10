/**
 * GOOGLE REVIEWS — schema, owned by this module.
 *
 * WHY THE DDL IS HERE AND NOT IN db.ts
 * ────────────────────────────────────
 * initializeSchema() in src/lib/db.ts is a shared, contended file — other work
 * is editing it right now — and this module has to be addable and removable
 * without touching it. So the reviews tables are asserted by
 * ensureReviewSchema(), which every public entry point in this module calls
 * first. It is memoized per database handle, so the cost is one DDL block on
 * the first call per process.
 *
 * Every statement is IF NOT EXISTS. Nothing here drops, rewrites, backfills or
 * recomputes anything — scripts/check-boot-migrations.js exists because a
 * recompute on start silently reverts human decisions, and this module has no
 * reason to write one. Running ensureReviewSchema() a hundred times is a no-op.
 *
 * THE RAW-FIRST LAW (copied from the WhatsApp webhook, deliberately)
 * ──────────────────────────────────────────────────────────────────
 * gr_ingest_raw is written BEFORE anything is parsed, and is never touched
 * again. gr_reviews.raw_id points at the document a row came from and
 * gr_reviews.raw_item holds that single review's own source JSON. So:
 *   - a parser bug is repairable by re-running the parser over stored raw
 *     documents: no re-fetch, no second Takeout export, no re-approval;
 *   - a row can always be traced back to the exact bytes that produced it.
 *
 * TABLES
 *   gr_ingest_raw   one row per raw DOCUMENT (an uploaded file, or one API page)
 *   gr_ingest_runs  one row per import/pull, with honest counters
 *   gr_reviews      the parsed rows, source-agnostic, deduped on identity_key
 *   gr_connection   the Google connection: who is connected, to which listing,
 *                   when it last worked, and how loudly it is currently broken
 *   gr_oauth_state  single-use CSRF nonces for the OAuth round trip
 */
import type Database from 'better-sqlite3';
import { getDb } from '@/lib/db';

type DB = Database.Database;

const SCHEMA_READY = new WeakSet<object>();

/**
 * Cap on a single stored raw document. A Takeout reviews.json for a busy
 * restaurant is measured in hundreds of KB; 8 MB is far past any legitimate
 * one, and storing an unbounded upload in SQLite is how a database gets wedged.
 * Over the cap the payload is stored TRUNCATED with payload_truncated = 1, so
 * the run still has provenance and the page can say the replay is incomplete.
 * Silently dropping it would be the one unacceptable outcome.
 */
export const RAW_PAYLOAD_MAX_BYTES = 8 * 1024 * 1024;

const DDL = `
    CREATE TABLE IF NOT EXISTS gr_ingest_raw (
      id                TEXT PRIMARY KEY,
      run_id            TEXT NOT NULL DEFAULT '',
      source            TEXT NOT NULL,
      /* Which listing this document was imported FOR. Stored on the raw row,
       * not just on the run, because replayRawDocuments() has to re-attribute
       * a document to the location it originally belonged to. Without it a
       * replay silently re-imports every row against the default location and
       * doubles the history. */
      location_key      TEXT NOT NULL DEFAULT '',
      kind              TEXT NOT NULL,
      label             TEXT NOT NULL DEFAULT '',
      payload           TEXT NOT NULL,
      payload_sha256    TEXT NOT NULL DEFAULT '',
      byte_len          INTEGER NOT NULL DEFAULT 0,
      payload_truncated INTEGER NOT NULL DEFAULT 0,
      received_at       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gr_raw_run  ON gr_ingest_raw(run_id);
    CREATE INDEX IF NOT EXISTS idx_gr_raw_hash ON gr_ingest_raw(payload_sha256);

    CREATE TABLE IF NOT EXISTS gr_ingest_runs (
      id              TEXT PRIMARY KEY,
      source          TEXT NOT NULL,
      location_key    TEXT NOT NULL DEFAULT '',
      actor           TEXT NOT NULL DEFAULT '',
      label           TEXT NOT NULL DEFAULT '',
      status          TEXT NOT NULL DEFAULT 'running',
      started_at      TEXT NOT NULL,
      finished_at     TEXT NOT NULL DEFAULT '',
      rows_seen       INTEGER NOT NULL DEFAULT 0,
      inserted        INTEGER NOT NULL DEFAULT 0,
      updated         INTEGER NOT NULL DEFAULT 0,
      unchanged       INTEGER NOT NULL DEFAULT 0,
      skipped_stale   INTEGER NOT NULL DEFAULT 0,
      errors          INTEGER NOT NULL DEFAULT 0,
      weak_identity   INTEGER NOT NULL DEFAULT 0,
      ambiguous_dates INTEGER NOT NULL DEFAULT 0,
      expected_total  INTEGER,
      stored_total    INTEGER NOT NULL DEFAULT 0,
      error_text      TEXT NOT NULL DEFAULT '',
      notes           TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_gr_runs_started ON gr_ingest_runs(started_at DESC);

    CREATE TABLE IF NOT EXISTS gr_reviews (
      id                  TEXT PRIMARY KEY,
      source              TEXT NOT NULL,
      location_key        TEXT NOT NULL DEFAULT '',
      external_id         TEXT NOT NULL DEFAULT '',
      identity_key        TEXT NOT NULL,
      identity_basis      TEXT NOT NULL,
      author_name         TEXT NOT NULL DEFAULT '',
      author_is_anonymous INTEGER NOT NULL DEFAULT 0,
      rating              INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      text                TEXT NOT NULL DEFAULT '',
      text_len            INTEGER NOT NULL DEFAULT 0,
      language            TEXT NOT NULL DEFAULT '',
      posted_at           TEXT NOT NULL,
      posted_precision    TEXT NOT NULL DEFAULT 'second',
      source_updated_at   TEXT NOT NULL DEFAULT '',
      reply_text          TEXT NOT NULL DEFAULT '',
      replied_at          TEXT NOT NULL DEFAULT '',
      content_hash        TEXT NOT NULL DEFAULT '',
      first_seen_at       TEXT NOT NULL,
      fetched_at          TEXT NOT NULL,
      raw_id              TEXT NOT NULL DEFAULT '',
      raw_item            TEXT NOT NULL DEFAULT '',
      run_id              TEXT NOT NULL DEFAULT '',
      ai_status           TEXT NOT NULL DEFAULT '',
      ai_json             TEXT NOT NULL DEFAULT '',
      ai_error            TEXT NOT NULL DEFAULT '',
      ai_at               TEXT NOT NULL DEFAULT '',
      ai_model            TEXT NOT NULL DEFAULT ''
    );

    /* THE IDEMPOTENCY GUARANTEE. Re-importing the same export changes nothing,
     * because every write is an upsert against this one constraint. It is
     * (location_key, identity_key) rather than identity_key alone so a second
     * outlet can never collide with the first on a composite key. */
    CREATE UNIQUE INDEX IF NOT EXISTS uq_gr_reviews_identity
      ON gr_reviews(location_key, identity_key);

    CREATE INDEX IF NOT EXISTS idx_gr_reviews_posted    ON gr_reviews(posted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_gr_reviews_rating    ON gr_reviews(rating);
    CREATE INDEX IF NOT EXISTS idx_gr_reviews_unreplied ON gr_reviews(replied_at, posted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_gr_reviews_run       ON gr_reviews(run_id);
    CREATE INDEX IF NOT EXISTS idx_gr_reviews_external  ON gr_reviews(external_id);

    /* ── THE CONNECTION ──────────────────────────────────────────────────────
     * One row per listing. This table exists because of the single worst
     * failure this feature can have: a token quietly expires, the scheduled
     * fetch stops, nobody is told, and the page keeps rendering last month's
     * reviews as though they were today's. Every field below exists to make
     * that state impossible to hold silently.
     *
     * NO CREDENTIAL IS STORED HERE. The refresh token, access token and client
     * secret live in the shared settings table, whose key names match
     * SECRET_KEY_RE (src/lib/secret-keys.ts) by shape, so they are masked and
     * admin-gated on
     * /api/settings and in the admin SQL console with nothing added to a list.
     * What lives here is METADATA about them — which account, which listing,
     * when the access token expires, when a fetch last SUCCEEDED — all of which
     * the page must be able to show without touching a secret.
     *
     * last_success_at is the one that matters most. "Connected" is not a fact
     * about a stored token; it is a fact about the last time bytes actually
     * came back from Google. */
    CREATE TABLE IF NOT EXISTS gr_connection (
      location_key         TEXT PRIMARY KEY,
      /* disconnected | connected | needs_reconnect
       * needs_reconnect is terminal until a human re-authorises: it means
       * Google refused the refresh token itself (invalid_grant), which no
       * amount of retrying fixes. */
      status               TEXT NOT NULL DEFAULT 'disconnected',
      google_email         TEXT NOT NULL DEFAULT '',
      account_name         TEXT NOT NULL DEFAULT '',
      account_label        TEXT NOT NULL DEFAULT '',
      /* accounts/{a}/locations/{l} — the pull target */
      location_name        TEXT NOT NULL DEFAULT '',
      location_label       TEXT NOT NULL DEFAULT '',
      location_address     TEXT NOT NULL DEFAULT '',
      scope                TEXT NOT NULL DEFAULT '',
      connected_at         TEXT NOT NULL DEFAULT '',
      connected_by         TEXT NOT NULL DEFAULT '',
      /* ACCESS-token expiry (minutes, not months). Metadata, not the token. */
      token_expires_at     TEXT NOT NULL DEFAULT '',
      last_attempt_at      TEXT NOT NULL DEFAULT '',
      last_success_at      TEXT NOT NULL DEFAULT '',
      last_error           TEXT NOT NULL DEFAULT '',
      last_error_at        TEXT NOT NULL DEFAULT '',
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      /* The scheduled refresh. OFF until someone turns it on, so connecting
       * an account never starts unattended traffic by surprise. */
      auto_enabled         INTEGER NOT NULL DEFAULT 0,
      interval_minutes     INTEGER NOT NULL DEFAULT 360,
      last_auto_run_at     TEXT NOT NULL DEFAULT '',
      /* Advisory lock so two schedulers (in-process tick + external cron)
       * cannot run the same pull twice against a quota. */
      lock_until           TEXT NOT NULL DEFAULT '',
      updated_at           TEXT NOT NULL DEFAULT ''
    );

    /* Single-use CSRF nonces for the OAuth redirect. A signed state alone
     * proves the value came from us; it does not stop the same authorised
     * redirect being replayed. Consuming a row makes it one-shot. */
    CREATE TABLE IF NOT EXISTS gr_oauth_state (
      nonce        TEXT PRIMARY KEY,
      redirect_uri TEXT NOT NULL DEFAULT '',
      actor        TEXT NOT NULL DEFAULT '',
      location_key TEXT NOT NULL DEFAULT '',
      created_at   TEXT NOT NULL,
      expires_at   TEXT NOT NULL,
      used_at      TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_gr_oauth_state_exp ON gr_oauth_state(expires_at);
`;

export function ensureReviewSchema(db: DB = getDb()): DB {
  if (SCHEMA_READY.has(db)) return db;
  db.exec(DDL);
  SCHEMA_READY.add(db);
  return db;
}

/** Test hook: forget the memo so a fresh handle re-asserts. Not used in app code. */
export function resetReviewSchemaMemo(db: DB): void {
  SCHEMA_READY.delete(db);
}

/**
 * Read one row of the shared `settings` table THROUGH THE GIVEN HANDLE.
 *
 * This exists rather than reusing crm-llm's getCrmSetting() for one reason: that
 * helper always resolves getDb() internally, so a function that takes a database
 * handle and then reads settings through it would be lying about which database
 * it consulted. Inside a test running against a snapshot that difference is the
 * whole game, and a setting silently read from the wrong file is the kind of bug
 * that only shows up in production.
 *
 * Env is the fallback, not the primary, matching every other integration here:
 * a value an admin sets in the database outranks a deploy-time variable.
 */
export function reviewSetting(db: DB, key: string, fallback = ''): string {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined;
    const v = row?.value;
    if (v !== undefined && v !== null && String(v) !== '') return String(v);
  } catch { /* no settings table (a bare test db) -> fall through */ }
  return fallback;
}

/**
 * Write one row of the shared `settings` table THROUGH THE GIVEN HANDLE, for the
 * same reason reviewSetting() reads through it: a function handed a database
 * must not quietly write to a different one.
 *
 * Used only for the Google credentials (client id/secret, refresh token, access
 * token), which live in `settings` rather than in this module's own tables so
 * that SECRET_KEY_RE masks them by shape. Writing '' DELETES the row rather than
 * storing an empty string — a disconnect must leave no residue for a later read
 * to resurrect as a "present but blank" credential.
 */
export function setReviewSetting(db: DB, key: string, value: string): void {
  ensureSettingsTable(db);
  if (value === '') {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    return;
  }
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

/** A bare test database has no `settings` table. Creating it on demand keeps the
 *  connector testable without dragging in db.ts's whole initializeSchema(). */
function ensureSettingsTable(db: DB): void {
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');
}
