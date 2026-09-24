/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import { getDb } from '@/lib/db';
import { fssaiAuditBestEffort } from '@/lib/fssai-server';
import { FSSAI_PHOTO_RETENTION_MONTHS, fssaiBytesLabel } from '@/lib/fssai';

/**
 * THE 12-MONTH PHOTO RETENTION WINDOW — owner §7 Q13, ruled 2026-09-25.
 *
 *   "In-row, 12-month retention window. Keep photos full-size for 12 months,
 *    then drop the IMAGE but KEEP the record, the fact a photo existed, and its
 *    digest. Never delete the record."
 *
 * ═══ ⚠️ THIS IS NOT ARMED. NOTHING CALLS IT ON A SCHEDULE. ═══════════════════
 *
 * Said plainly because the opposite assumption is the dangerous one: a reader
 * who believes a retention sweep is running will believe the database has a
 * ceiling, and it does not. THIS BRANCH HAS NO SCHEDULER AT ALL — measured, not
 * assumed: `src/instrumentation.ts` `register()` is an empty stub ("nothing to
 * set up here"), and the only route under `src/app/api/cron/` is
 * `refresh-parties`, which is a different module's job and never touches FSSAI.
 * So there is no boot-time arming here to hang a job off, and inventing one
 * would be a behaviour change nobody asked for on a build the owner is about to
 * judge.
 *
 * WHAT THAT MEANS TODAY: images are kept for ever until somebody calls
 * `sweepFssaiPhotoRetention` — from an admin action, a script, or a job armed by
 * whoever owns scheduling on the branch this is merged into. The function is
 * complete, transactional, audited and safe to call repeatedly; only the trigger
 * is missing.
 *
 * TO ARM IT, wherever this lands:
 *   · call `sweepFssaiPhotoRetention(getDb())` once a day (it is idempotent — a
 *     second call the same day finds nothing left to drop and writes nothing);
 *   · call it with `{ dryRun: true }` first and read the report, which names the
 *     rows and the bytes WITHOUT touching anything.
 *
 * ═══ WHAT THE SWEEP MUST NEVER CHANGE, AND WHY ══════════════════════════════
 *
 * `computeFssaiSheetDigest` (src/lib/fssai-server.ts) hashes each photograph as
 * exactly four fields — `id`, `response_id`, `mime`, `size_bytes` — and
 * deliberately NOT `data_uri`. That is what makes this whole feature possible:
 * clearing the image leaves every sheet digest bit-identical, so every signature
 * still covers its sheet and no aged record starts reading as tampered with.
 *
 * Touch any of those four here and you silently invalidate the signature on
 * every aged record in the file at once. In particular `size_bytes` KEEPS THE
 * ORIGINAL SIZE after the drop — it is not reset to 0, both because the digest
 * depends on it and because "there was a 312 KB photograph here" is a more
 * useful sentence than "there was a 0 KB photograph here". The UPDATE below
 * names only the two columns it is allowed to write, so this rule is enforced by
 * the statement itself rather than by remembering it.
 */

/** Rows whose image has aged out and may have it dropped. */
export interface FssaiRetentionCandidate {
  id: string;
  run_id: string;
  response_id: string;
  created_at: string;
  size_bytes: number;
  mime: string;
  filename: string;
  /** '' when the row predates the digest column — reported honestly, never invented. */
  digest_sha256: string;
}

export interface FssaiRetentionReport {
  /** ISO instant: an image created at or before this has aged out. */
  cutoff: string;
  retention_months: number;
  /** How many stored images were older than the cutoff. */
  candidates: number;
  /** How many had their image dropped (0 when dryRun). */
  dropped: number;
  /** Bytes of image text released (estimated from size_bytes). */
  bytes_freed: number;
  bytes_freed_label: string;
  /** Of those dropped, how many had NO digest recorded (uploaded before the column existed). */
  dropped_without_digest: number;
  dry_run: boolean;
  /** Images still held, i.e. inside the window — so a caller can see the steady state. */
  still_held: number;
  rows: FssaiRetentionCandidate[];
}

/**
 * The sha256 an fssai_evidence row should carry for a given data: URI.
 *
 * Hashes the DECODED IMAGE BYTES, not the data: URI string, so the digest is a
 * fingerprint of the picture itself and stays comparable to one taken with any
 * other tool (`sha256sum photo.jpg`). Returns '' for anything that is not a
 * base64 data: URI, so a caller can store '' rather than the hash of a mistake.
 */
export function fssaiImageDigest(dataUri: string | null | undefined): string {
  const s = String(dataUri || '');
  const comma = s.indexOf(',');
  if (comma < 0) return '';
  const b64 = s.slice(comma + 1).replace(/\s+/g, '');
  if (!b64) return '';
  try {
    return createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
  } catch {
    return '';
  }
}

/**
 * The instant an image must have been created AFTER to still be kept.
 *
 * Month arithmetic, not `365 * 86400e3`: the owner said "12 months", and a leap
 * year would make a day-count window drop an image a day early. Date's own
 * month rollover handles the short-month case (e.g. 31 Mar minus 12 months is
 * still 31 Mar; only a 29 Feb start normalises, and one day either way on a
 * 12-month window is immaterial).
 */
export function fssaiRetentionCutoff(now: Date = new Date(), months = FSSAI_PHOTO_RETENTION_MONTHS): string {
  const d = new Date(now.getTime());
  d.setMonth(d.getMonth() - months);
  return d.toISOString();
}

/**
 * DROP THE IMAGES THAT HAVE AGED OUT. Keeps every row.
 *
 * Safe to call at any time and as often as you like: a row is only ever touched
 * once, because the WHERE clause requires `data_uri <> ''` and the UPDATE sets
 * it to ''. A second run the same day finds nothing.
 *
 * `dryRun: true` reports exactly what WOULD go and writes nothing at all — no
 * UPDATE and no audit row.
 */
export function sweepFssaiPhotoRetention(
  db: Database.Database = getDb(),
  opts: { now?: Date; months?: number; dryRun?: boolean; actor?: { email?: string | null; name?: string | null } } = {},
): FssaiRetentionReport {
  const months = opts.months ?? FSSAI_PHOTO_RETENTION_MONTHS;
  const cutoff = fssaiRetentionCutoff(opts.now ?? new Date(), months);
  const dryRun = !!opts.dryRun;
  const actor = opts.actor ?? { email: '', name: 'FSSAI photo retention' };

  /* `created_at` is stored by SQLite's own datetime('now') as
   * 'YYYY-MM-DD HH:MM:SS' (a space, no 'Z'), while an ISO instant uses a 'T'.
   * Comparing the two as strings would be wrong at exactly the character that
   * differs, so the column is normalised to the ISO shape for the comparison
   * rather than the cutoff being loosened to a date. */
  const rows = db.prepare(
    `SELECT id, run_id, response_id, created_at, size_bytes, mime, filename, digest_sha256
       FROM fssai_evidence
      WHERE data_uri <> ''
        AND replace(created_at, ' ', 'T') <= ?
      ORDER BY created_at ASC`,
  ).all(cutoff) as FssaiRetentionCandidate[];

  const stillHeld = (db.prepare(
    `SELECT COUNT(*) AS n FROM fssai_evidence WHERE data_uri <> '' AND replace(created_at, ' ', 'T') > ?`,
  ).get(cutoff) as any).n as number;

  const report: FssaiRetentionReport = {
    cutoff,
    retention_months: months,
    candidates: rows.length,
    dropped: 0,
    bytes_freed: 0,
    bytes_freed_label: '0 KB',
    dropped_without_digest: 0,
    dry_run: dryRun,
    still_held: Number(stillHeld) || 0,
    rows,
  };
  if (dryRun || rows.length === 0) {
    report.bytes_freed = rows.reduce((n, r) => n + (Number(r.size_bytes) || 0), 0);
    report.bytes_freed_label = fssaiBytesLabel(report.bytes_freed);
    report.dropped_without_digest = rows.filter((r) => !String(r.digest_sha256 || '')).length;
    return report;
  }

  const droppedAt = new Date().toISOString();
  /* ⚠️ THIS STATEMENT WRITES TWO COLUMNS AND NO OTHERS. id, response_id, mime
   * and size_bytes are the four the sheet digest is taken over — see the header
   * of this file. Adding a column to this SET is how every signature in the file
   * would quietly stop covering its sheet. */
  const drop = db.prepare(
    `UPDATE fssai_evidence
        SET data_uri = '', image_dropped_at = ?
      WHERE id = ? AND data_uri <> ''`,
  );

  const run = db.transaction(() => {
    for (const r of rows) {
      const res = drop.run(droppedAt, r.id);
      if (res.changes !== 1) continue;   // somebody else dropped it between the SELECT and here
      report.dropped += 1;
      report.bytes_freed += Number(r.size_bytes) || 0;
      if (!String(r.digest_sha256 || '')) report.dropped_without_digest += 1;
      /* WHY THE AUDIT ROW MATTERS MORE THAN USUAL. This is the only trace that
       * an image ever left the file. It records the digest so the fingerprint
       * survives in TWO places (the row and the append-only log), and it is
       * best-effort for the same reason every other FSSAI audit is: losing the
       * log row must not abort a sweep, it must be shouted about in the server
       * log. The evidence row itself keeps image_dropped_at either way, so the
       * record can still say what happened even if this write is lost. */
      fssaiAuditBestEffort(db, {
        entity_table: 'fssai_evidence',
        entity_id: r.id,
        action: 'retention_drop_image',
        field: 'data_uri',
        before: {
          run_id: r.run_id, response_id: r.response_id, filename: r.filename,
          mime: r.mime, size_bytes: r.size_bytes, created_at: r.created_at,
          digest_sha256: r.digest_sha256 || '',
          image_stored: true,
        },
        after: {
          image_stored: false, image_dropped_at: droppedAt,
          // Unchanged, and restated so the log row proves they were unchanged.
          mime: r.mime, size_bytes: r.size_bytes,
          digest_sha256: r.digest_sha256 || '',
        },
        reason:
          `The image passed the ${months}-month retention window (owner §7 Q13). The record, its size and its digest are kept; only the picture is gone.`,
        actor,
        outlet_id: '',
      });
    }
  });
  run();

  report.bytes_freed_label = fssaiBytesLabel(report.bytes_freed);
  return report;
}

/**
 * A one-line answer to "how much of this file is photographs, and how much of
 * that has aged out?" — for an admin screen or a console, without dropping
 * anything. Pure read.
 */
export function fssaiPhotoRetentionStatus(
  db: Database.Database = getDb(),
  opts: { now?: Date; months?: number } = {},
): { held: number; held_bytes: number; held_bytes_label: string; overdue: number; overdue_bytes: number; overdue_bytes_label: string; already_dropped: number; cutoff: string; armed: false } {
  const months = opts.months ?? FSSAI_PHOTO_RETENTION_MONTHS;
  const cutoff = fssaiRetentionCutoff(opts.now ?? new Date(), months);
  const held = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS b FROM fssai_evidence WHERE data_uri <> ''`,
  ).get() as any;
  const overdue = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS b
       FROM fssai_evidence WHERE data_uri <> '' AND replace(created_at, ' ', 'T') <= ?`,
  ).get(cutoff) as any;
  const gone = db.prepare(
    `SELECT COUNT(*) AS n FROM fssai_evidence WHERE image_dropped_at <> ''`,
  ).get() as any;
  return {
    held: Number(held?.n) || 0,
    held_bytes: Number(held?.b) || 0,
    held_bytes_label: fssaiBytesLabel(Number(held?.b) || 0),
    overdue: Number(overdue?.n) || 0,
    overdue_bytes: Number(overdue?.b) || 0,
    overdue_bytes_label: fssaiBytesLabel(Number(overdue?.b) || 0),
    already_dropped: Number(gone?.n) || 0,
    cutoff,
    /* Stated in the payload, not just in a comment, so a screen that shows this
     * cannot imply a sweep is running. Flip it to a real value if and when the
     * sweep is ever armed. */
    armed: false,
  };
}
