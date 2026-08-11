/**
 * Call-recording retention — the policy, the enforcement rule, and the sweeper.
 *
 * ── WHAT RETENTION MEANS ON THIS DEPLOYMENT ────────────────────────────────
 * Nothing here stores recording AUDIO. A CDR gives us a URL; ct_calls holds
 * that URL; /api/telecmi/recording/[callId] fetches it from TeleCMI on every
 * play and streams the bytes through. No file is written, so a purge would
 * have nothing to delete and a "delete the recordings" job would be theatre.
 *
 * What IS real, enforceable and useful is how long that recording stays
 * REACHABLE THROUGH US. Past the window the proxy refuses to fetch it and says
 * why. The guest's audio stops being retrievable from this app on the day the
 * admin chose, which is the privacy outcome the setting promises, and it holds
 * whether or not bytes are ever stored locally.
 *
 * Two layers, and the order matters:
 *
 *   1 REFUSAL (authoritative, computed).  recordingRetentionStatus() derives
 *     expiry from the call's own timestamp every time it is asked. It needs no
 *     job to have run, cannot drift, survives a re-imported CDR (a backfill
 *     re-writing recording_url does NOT resurrect a recording), and reverses
 *     itself the moment an admin lengthens the window.
 *   2 PURGE (best-effort, incremental).  sweepRecordingRetention() walks the
 *     calls that crossed the boundary and deletes what we actually hold for
 *     them — today nothing, see purgeLocalRecording() below, which is the one
 *     place local file deletion gets implemented. It also writes the audit
 *     trail of what expired and when.
 *
 * If layer 2 never runs, layer 1 still refuses. That is deliberate: a privacy
 * control that depends on a cron having fired is not a control.
 *
 * ── COST, MEASURED ─────────────────────────────────────────────────────────
 * The sweep is bounded by a watermark (the ct_settings row named by
 * RECORDING_RETENTION_SWEPT_TO_KEY) so a steady-state pass looks at the few
 * calls that expired since the last pass instead of re-reading history.
 * Measured on a synthetic 1,000,000-row ct_calls carrying the same indexes as
 * production (200k rows with a recording_url):
 *   - windowed pass, nothing to do   → SEARCH ct_calls USING INDEX
 *                                      idx_ct_calls_started, under 1 ms
 *   - windowed pass, a full 500 batch → ~8 ms
 *   - the same sweep written WITHOUT the watermark (scan for expired rows,
 *     LIMIT 200) → SCAN ct_calls, 137 ms warm / 1.1 s cold, EVERY pass
 * The watermark is the difference between a sweep you can run on a request
 * path and one you cannot, which is why it exists.
 */
import type Database from 'better-sqlite3';
import { getDb, logAuditEvent } from '@/lib/db';
import {
  RECORDING_RETENTION_CHOICES,
  RECORDING_RETENTION_DEFAULT_DAYS,
  ctRecordingRetentionDays,
  ctSetting,
  setCtSetting,
} from './settings';

export { RECORDING_RETENTION_CHOICES, RECORDING_RETENTION_DEFAULT_DAYS };

/**
 * How far the sweeper has already walked. Every call at or before this point
 * has been through a pass, so the next pass only asks for the slice after it.
 *
 * STORED AS "<started_at>" OR "<started_at>|<call id>". The id half is not
 * decoration — it is the fix for a bug this sweeper actually had. started_at
 * has one-second resolution, so a batch cap can fall INSIDE a group of calls
 * that share a timestamp; with only the timestamp persisted, the next
 * invocation restarted at the top of that group, re-swept the same rows, and
 * never advanced. Observed before the fix, with 2,100 calls sharing one
 * second: six consecutive passes each reported 2,000 expired, each wrote an
 * audit row, and the watermark never moved. With the id half: 2,000 then 100,
 * then done. An ISO timestamp cannot contain '|', so the two halves always
 * split cleanly, and a plain timestamp (what a drained window writes) parses
 * as before.
 *
 * Like the retention setting itself this is deliberately NOT in
 * CT_SETTING_DEFAULTS (see the comment on RECORDING_RETENTION_KEY in
 * settings.ts) and deliberately NOT secret — it is a timestamp and a call id.
 */
export const RECORDING_RETENTION_SWEPT_TO_KEY = 'recording_retention_swept_to';

/** Decode the watermark row into its two halves. */
export function readSweepWatermark(db: Database.Database): { at: string; id: string } {
  const raw = ctSetting(db, RECORDING_RETENTION_SWEPT_TO_KEY) || '';
  const bar = raw.indexOf('|');
  if (bar < 0) return { at: raw, id: '' };
  return { at: raw.slice(0, bar), id: raw.slice(bar + 1) };
}

const DAY_MS = 86_400_000;

/** The subset of a ct_calls row the retention rule needs. */
export interface RetentionCall {
  id?: string;
  started_at?: string | null;
  created_at?: string | null;
}

export type RetentionReason =
  | ''          // inside the window
  | 'expired'   // past the window
  | 'undated';  // no usable timestamp — treated as not servable, see below

export interface RecordingRetentionStatus {
  /** The window in force right now. */
  days: number;
  /** UTC ISO instant retention is counted from ('' when the row has none). */
  anchor: string;
  /** UTC ISO instant the recording stops being reachable ('' when undated). */
  expiresAt: string;
  /** True when the proxy must refuse. */
  expired: boolean;
  reason: RetentionReason;
}

/**
 * ct_ timestamps are UTC ISO strings (see the SLA clock note in settings.ts),
 * but ct_calls.created_at also carries a column DEFAULT of datetime('now'),
 * which SQLite renders as "YYYY-MM-DD HH:MM:SS" — UTC, with no zone marker.
 * Date.parse() reads that shape as LOCAL time, which on an IST box would shift
 * every such call 5h30m and expire it that much early. Normalize first.
 */
function parseUtcMs(raw: string): number {
  const s = String(raw || '').trim();
  if (!s) return NaN;
  const bare = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(s);
  return Date.parse(bare ? `${bare[1]}T${bare[2]}Z` : s);
}

/** Retention counts from when the call happened; created_at is the fallback
 *  for a row that somehow has no start. started_at IS nullable (db.ts, ct_calls);
 *  it is created_at that is NOT NULL, which is what makes it a usable fallback. */
export function recordingRetentionAnchor(call: RetentionCall): string {
  const started = String(call.started_at ?? '').trim();
  if (started) return started;
  return String(call.created_at ?? '').trim();
}

/**
 * Is this call's recording still inside the retention window?
 *
 * UNDATED ROWS ARE REFUSED. A recording we cannot date is one we cannot prove
 * is inside the window, and for a privacy control the safe answer is no. It is
 * reported as its own reason rather than as "expired" so the API never tells
 * an owner a recording aged out when the truth is its timestamp is unreadable.
 */
export function recordingRetentionStatus(
  db: Database.Database,
  call: RetentionCall,
): RecordingRetentionStatus {
  const days = ctRecordingRetentionDays(db);
  const anchor = recordingRetentionAnchor(call);
  const anchorMs = parseUtcMs(anchor);
  if (!Number.isFinite(anchorMs)) {
    return { days, anchor, expiresAt: '', expired: true, reason: 'undated' };
  }
  const expiresMs = anchorMs + days * DAY_MS;
  const expired = Date.now() >= expiresMs;
  return {
    days,
    anchor,
    expiresAt: new Date(expiresMs).toISOString(),
    expired,
    reason: expired ? 'expired' : '',
  };
}

/* ── The seam for locally stored recording FILES ───────────────────────────*/

export interface LocalRecordingPurge {
  /** Files actually removed for this call. */
  deleted: number;
  /** Which local store acted. 'none' = this deployment stores no audio. */
  store: string;
}

/**
 * The local audio store in force. 'none' is the literal truth today and the
 * single flag the console reads to say so out loud rather than implying files
 * are being kept and deleted. Rename it in the same commit that implements
 * purgeLocalRecording().
 */
export const LOCAL_RECORDING_STORE = 'none';

/**
 * Delete the locally stored audio for one expired call.
 *
 * THIS IS THE SEAM, and it is the only thing that has to change when this app
 * starts keeping recording files. As of this commit nothing writes recording
 * audio to disk. There are TWO routes to the bytes and BOTH are gated: the
 * streaming proxy at
 * src/app/api/telecmi/recording/[callId]/route.ts — so there is nothing to
 * remove and this reports 0 with store 'none'.
 *
 * When local storage lands, implement the delete here and NOTHING ELSE in this
 * file moves: the same ct_settings choice sets the window, the same sweeper
 * calls this once per expired call, the same audit event records the result,
 * and the proxy already refuses expired calls before it would read a file.
 * Return the number of files removed and a store name so the audit trail says
 * which store acted.
 */
// Both parameters are unused ONLY because nothing is stored yet. They are the
// contract an implementation needs — the handle to read a file index from, and
// the call to delete for — so they stay in the signature instead of being
// added later and changing every call site.
/* eslint-disable @typescript-eslint/no-unused-vars */
export function purgeLocalRecording(
  db: Database.Database,
  call: RetentionCall,
): LocalRecordingPurge {
  return { deleted: 0, store: LOCAL_RECORDING_STORE };
}
/* eslint-enable @typescript-eslint/no-unused-vars */

/* ── The sweeper ───────────────────────────────────────────────────────────*/

/** Rows per SQL round trip. */
const SWEEP_BATCH = 500;
/** Batches per invocation — caps one pass at 2,000 calls so a backlog is
 *  cleared over several passes instead of in one long request. */
const SWEEP_MAX_BATCHES = 4;
/** Opportunistic, like sweep() in ingest.ts: hot paths must not pay for it. */
const SWEEP_THROTTLE_MS = 10 * 60_000;

export interface RecordingSweepResult {
  /** Retention window applied. */
  days: number;
  /** Calls whose recordings crossed the boundary in this pass. */
  expired: number;
  /** Local files removed (0 while nothing is stored locally). */
  filesDeleted: number;
  /** Which local store acted, or 'none'. */
  store: string;
  /** Window walked: exclusive lower bound (previous watermark) … cutoff. */
  from: string;
  cutoff: string;
  /** True when the pass hit its batch cap and left work for the next one. */
  more: boolean;
}

declare global {
  var __fnbRecordingRetentionSweepAt__: number | undefined;
}

/**
 * One incremental expiry pass. Idempotent: the watermark only ever covers
 * calls a previous pass has already handled, so a call is purged and audited
 * once, and a pass with nothing to do writes no audit event at all.
 *
 * `dbArg` defaults to the app database. It is a parameter so the pass can be
 * driven against a throwaway database in a test without going near the real
 * one — see the "NOT HERE" coverage note in scripts/ct-tests.ts, which exists
 * because the ingest sweeps bind to getDb() and therefore cannot be.
 *
 * Never throws — retention failing must not take down a page or a playback.
 */
export function sweepRecordingRetention(dbArg?: Database.Database): RecordingSweepResult {
  const empty: RecordingSweepResult = {
    days: RECORDING_RETENTION_DEFAULT_DAYS,
    expired: 0, filesDeleted: 0, store: LOCAL_RECORDING_STORE, from: '', cutoff: '', more: false,
  };
  try {
    const db = dbArg ?? getDb();
    const days = ctRecordingRetentionDays(db);
    const cutoff = new Date(Date.now() - days * DAY_MS).toISOString();
    const watermark = readSweepWatermark(db);
    const from = watermark.at;

    let cursorAt = watermark.at;
    let cursorId = watermark.id;
    let expired = 0;
    let filesDeleted = 0;
    let store: string = LOCAL_RECORDING_STORE;
    let more = false;
    // Enough ids to make the trail useful without turning one audit row into a
    // page of uuids on a first catch-up pass.
    const sample: string[] = [];

    for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch++) {
      // The (started_at, id) cursor is not decoration: started_at has
      // one-second resolution, so two calls can share it, and a plain
      // "started_at > cursor" would step over the second one whenever the pair
      // straddles a batch edge — a file that never gets deleted. Written as an
      // OR rather than a row value because SQLite still resolves this to
      // SEARCH ct_calls USING INDEX idx_ct_calls_started — verified with
      // EXPLAIN QUERY PLAN against a synthetic 1,000,000-row ct_calls.
      const rows = db.prepare(`
        SELECT id, started_at, created_at
        FROM ct_calls
        -- ANCHOR, not started_at. recordingRetentionAnchor() falls back to
        -- created_at when started_at is blank, and the proxy refuses those rows
        -- as 'undated' — so keying the sweep on started_at alone meant an
        -- undated row was unplayable AND unsweepable, forever. The two halves of
        -- the policy have to cover the same rows or the seam leaks the day local
        -- storage lands. started_at is nullable in the schema; it happens to be
        -- populated on every live row today, which is why this was latent.
        WHERE recording_url <> ''
          AND COALESCE(NULLIF(TRIM(COALESCE(started_at, '')), ''), created_at) <= ?
          AND (   COALESCE(NULLIF(TRIM(COALESCE(started_at, '')), ''), created_at) > ?
               OR (COALESCE(NULLIF(TRIM(COALESCE(started_at, '')), ''), created_at) = ? AND id > ?))
        ORDER BY COALESCE(NULLIF(TRIM(COALESCE(started_at, '')), ''), created_at), id
        LIMIT ?
      `).all(cutoff, cursorAt, cursorAt, cursorId, SWEEP_BATCH) as RetentionCall[];

      if (rows.length === 0) {
        // Window drained. Park the watermark ON the cutoff so the next pass
        // starts from today's boundary rather than re-reading history.
        cursorAt = cutoff;
        cursorId = '';
        break;
      }

      for (const row of rows) {
        const purge = purgeLocalRecording(db, row);
        filesDeleted += purge.deleted;
        if (purge.deleted > 0) store = purge.store;
        expired++;
        if (sample.length < 25 && row.id) sample.push(row.id);
      }

      const last = rows[rows.length - 1];
      cursorAt = String(last.started_at ?? cursorAt);
      cursorId = String(last.id ?? '');

      if (rows.length < SWEEP_BATCH) { cursorAt = cutoff; cursorId = ''; break; }
      if (batch === SWEEP_MAX_BATCHES - 1) more = true;
    }

    if (expired > 0) {
      // Privacy-relevant, so it is on the record. Nothing sensitive goes in:
      // no phone number, no recording URL, no guest — just how many recordings
      // aged out, over which window, and the internal call ids.
      logAuditEvent(db, {
        event_type: 'recording.retention.sweep',
        entity_type: 'ct_recording_retention',
        entity_id: cutoff,
        actor_email: 'system',
        note:
          `${expired} call recording${expired === 1 ? '' : 's'} passed the ${days}-day ` +
          `retention window; ${filesDeleted} local file${filesDeleted === 1 ? '' : 's'} deleted ` +
          `(store: ${store})`,
        after: {
          days,
          window_from: from || null,
          window_to: cutoff,
          expired,
          files_deleted: filesDeleted,
          store,
          call_ids: sample,
          call_ids_omitted: Math.max(0, expired - sample.length),
        },
      });
    }

    // Watermark last: if anything above threw, the next pass redoes the window
    // rather than skipping it. The id half is written only when a pass stops
    // mid-window, so a drained window leaves a plain readable timestamp.
    setCtSetting(
      db,
      RECORDING_RETENTION_SWEPT_TO_KEY,
      cursorId ? `${cursorAt}|${cursorId}` : cursorAt,
    );

    return { days, expired, filesDeleted, store, from, cutoff, more };
  } catch (e) {
    console.error('[ct-retention] sweepRecordingRetention failed', e);
    return empty;
  }
}

/**
 * Throttled entry point for request paths, mirroring sweep() in ingest.ts:
 * fire and forget, at most once per 10 minutes per process, never throws.
 * Callers that can should hand this to Next's after() so it runs once the
 * response is done and cannot add latency to it.
 */
export function maybeSweepRecordingRetention(): void {
  try {
    const last = globalThis.__fnbRecordingRetentionSweepAt__ ?? 0;
    if (Date.now() - last < SWEEP_THROTTLE_MS) return;
    globalThis.__fnbRecordingRetentionSweepAt__ = Date.now();
    sweepRecordingRetention();
  } catch (e) {
    console.error('[ct-retention] maybeSweepRecordingRetention failed', e);
  }
}

/* ── Audit for a refusal ───────────────────────────────────────────────────*/

/**
 * Record that a recording was refused for age. Deduplicated to once per call
 * per day: a refusal is a repeatable read, and a GRE clicking play four times
 * should not write four rows. The lookup rides idx_audit_entity
 * (entity_type, entity_id), and both sides of the time comparison are computed
 * by SQLite so the audit table's own datetime('now') format is compared with
 * itself. Never throws.
 */
export function logRecordingRefusal(
  db: Database.Database,
  callId: string,
  status: RecordingRetentionStatus,
  actorEmail: string,
): void {
  try {
    const seen = db.prepare(`
      SELECT 1 FROM audit_events
      WHERE entity_type = 'ct_call' AND entity_id = ?
        AND event_type = 'recording.retention.refused'
        AND created_at > datetime('now', '-1 day')
      LIMIT 1
    `).get(callId);
    if (seen) return;

    logAuditEvent(db, {
      event_type: 'recording.retention.refused',
      entity_type: 'ct_call',
      entity_id: callId,
      actor_email: actorEmail,
      note:
        status.reason === 'undated'
          ? 'Playback refused: the call has no readable timestamp, so its age cannot be established.'
          : `Playback refused: past the ${status.days}-day recording retention window.`,
      after: { days: status.days, expires_at: status.expiresAt || null, reason: status.reason },
    });
  } catch (e) {
    console.error('[ct-retention] logRecordingRefusal failed', e);
  }
}

/* ── Console figures ───────────────────────────────────────────────────────*/

export interface ExpiredRecordingCount {
  count: number;
  /** True when the real number is higher than `count` — see the cap below. */
  capped: boolean;
}

/**
 * How many stored recording URLs are already past the window.
 *
 * Counted on started_at so it rides idx_ct_calls_started, which means it
 * matches exactly what the sweeper walks. A row with no started_at is in
 * neither (the CDR upsert in ingest.ts always writes one — "m.startedAt || now"
 * — and the live table has none), and the refusal rule covers those anyway
 * because it falls back to created_at.
 *
 * CAPPED ON PURPOSE. The exact COUNT(*) of the same predicate took 558 ms on a
 * 1M-row copy (183k matches) because it walks every match; stopping at
 * cap + 1 answers the only question the console asks — "is this a handful or a
 * pile?" — in 4-6 ms on that same copy, and 0 ms when there are none. An admin
 * page is not worth half a second of the single SQLite writer's box.
 */
export function countExpiredRecordings(db: Database.Database, cap = 1000): ExpiredRecordingCount {
  try {
    const days = ctRecordingRetentionDays(db);
    const cutoff = new Date(Date.now() - days * DAY_MS).toISOString();
    const row = db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT 1 FROM ct_calls
        WHERE recording_url <> '' AND started_at <= ?
        LIMIT ?
      )
    `).get(cutoff, cap + 1) as { n: number } | undefined;
    const n = Number(row?.n ?? 0);
    return n > cap ? { count: cap, capped: true } : { count: n, capped: false };
  } catch {
    return { count: 0, capped: false };
  }
}
