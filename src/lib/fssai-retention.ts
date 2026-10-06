/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import { getDb, generateId } from '@/lib/db';
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
 *
 * ═══ TWO TABLES, NOT ONE (added by P10) ═════════════════════════════════════
 *
 * When this file was written there was one photo store. W1 added a second:
 * `fssai_attachments`, because `fssai_evidence.run_id` is TEXT NOT NULL with an
 * FK to `fssai_runs`, so a photograph of a rejected delivery or a rat sighting
 * cannot live there — and widening it would be worse than useless, since the
 * sheet digest hashes a run's evidence and run-less rows would then sit inside a
 * signed set.
 *
 * A sweep that walks only `fssai_evidence` therefore keeps EVERY record-module
 * photograph for ever while reporting success, which is the worst possible
 * failure for an unattended job: a growing database and a green report. Both
 * tables are walked below, the report says how many came from each, and the
 * per-table numbers are what `fssai_retention_runs.evidence_dropped` and
 * `.attachments_dropped` record.
 *
 * `fssai_attachments` is NOT inside any signature, so the same four-column rule
 * is not strictly forced there — it is applied anyway, identically, because one
 * sweep with two different rules about what it may write is how the rule gets
 * lost.
 *
 * ═══ AND IT NOW PROVES WHAT IT DID ══════════════════════════════════════════
 *
 * Every real pass writes one `fssai_retention_runs` row: 'running' before the
 * first drop, 'done' with the counts afterwards, 'failed' with the message if it
 * throws. The row is written OUTSIDE the drop transaction on purpose — a sweep
 * that rolled back must still leave the fact that it ran, and a row left saying
 * 'running' is exactly how an interrupted sweep makes itself visible. A dry run
 * writes nothing at all, not even this row.
 */

/** Which of the two photo stores a candidate came from. */
export type FssaiPhotoStore = 'fssai_evidence' | 'fssai_attachments';

/** Rows whose image has aged out and may have it dropped. */
export interface FssaiRetentionCandidate {
  id: string;
  /** which table this row is in — the two stores are reported separately */
  store: FssaiPhotoStore;
  /** evidence only: the round and the answer. '' for an attachment. */
  run_id: string;
  response_id: string;
  /** attachments only: what the photograph is OF. '' for evidence. */
  entity_table: string;
  entity_id: string;
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
  /** Dropped out of fssai_evidence — a checklist round's photographs. */
  evidence_dropped: number;
  /** Dropped out of fssai_attachments — a delivery, a sighting, a certificate. */
  attachments_dropped: number;
  /**
   * '' on a healthy run. Names a store the sweep could NOT walk — on a database
   * whose last cold start predates it, fssai_attachments does not exist yet, and
   * HARD RULE 7 means that is a real state (initializeSchema swallows schema
   * errors per block) rather than an impossible one. A caller must be able to
   * tell "nothing had aged out" from "half the photographs were never looked at".
   */
  stores_skipped: string;
  /** The fssai_retention_runs row this pass wrote. '' on a dry run. */
  retention_run_id: string;
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

/* ------------------------------------------------------------------ *
 * THE TWO STORES
 * ------------------------------------------------------------------ */

/**
 * Both photo tables, in the order the sweep walks them.
 *
 * A LIST AND NOT TWO CALLS, so that "the sweep forgot a table" becomes
 * impossible to express: every loop below iterates this, the report's skipped
 * field names anything it could not walk, and a third store added later is one
 * line here plus a row in `STORE_COLUMNS`.
 */
export const FSSAI_PHOTO_STORES: readonly FssaiPhotoStore[] = ['fssai_evidence', 'fssai_attachments'] as const;

/**
 * The columns that say what each store's photograph is OF.
 *
 * fssai_evidence hangs off a checklist round (run_id + response_id);
 * fssai_attachments hangs off any record (entity_table + entity_id). Both are
 * selected under the SAME four aliases so one candidate shape covers both and
 * the audit row can name whichever pair is real — the other comes back '' and
 * says so by being ''.
 */
const STORE_COLUMNS: Record<FssaiPhotoStore, string> = {
  fssai_evidence: `run_id, response_id, '' AS entity_table, '' AS entity_id`,
  fssai_attachments: `'' AS run_id, '' AS response_id, entity_table, entity_id`,
};

function storeColumns(store: FssaiPhotoStore): string {
  return STORE_COLUMNS[store];
}

/**
 * Is this store in the database?
 *
 * fssai_attachments arrived with W1, so a database whose last cold start predates
 * it does not have the table — and `initializeSchema` swallows schema errors per
 * block (HARD RULE 7), so even a current build can be missing one. A sweep that
 * threw here would stop before touching the store that DOES exist; a sweep that
 * silently skipped would report success over half the photographs. It is checked,
 * named in the report, and recorded on the fssai_retention_runs row.
 */
function photoTableExists(db: Database.Database, store: FssaiPhotoStore): boolean {
  const r = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(store) as any;
  return !!r;
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

  const skipped: string[] = [];
  const rows: FssaiRetentionCandidate[] = [];
  let stillHeld = 0;

  for (const store of FSSAI_PHOTO_STORES) {
    if (!photoTableExists(db, store)) { skipped.push(store); continue; }
    /* `created_at` is stored by SQLite's own datetime('now') as
     * 'YYYY-MM-DD HH:MM:SS' (a space, no 'Z'), while an ISO instant uses a 'T'.
     * Comparing the two as strings would be wrong at exactly the character that
     * differs, so the column is normalised to the ISO shape for the comparison
     * rather than the cutoff being loosened to a date. */
    const found = db.prepare(
      `SELECT id, ${storeColumns(store)}, created_at, size_bytes, mime, filename, digest_sha256
         FROM ${store}
        WHERE data_uri <> ''
          AND replace(created_at, ' ', 'T') <= ?
        ORDER BY created_at ASC`,
    ).all(cutoff) as any[];
    for (const r of found) rows.push({ ...r, store } as FssaiRetentionCandidate);

    stillHeld += Number((db.prepare(
      `SELECT COUNT(*) AS n FROM ${store} WHERE data_uri <> '' AND replace(created_at, ' ', 'T') > ?`,
    ).get(cutoff) as any)?.n) || 0;
  }

  const report: FssaiRetentionReport = {
    cutoff,
    retention_months: months,
    candidates: rows.length,
    dropped: 0,
    bytes_freed: 0,
    bytes_freed_label: '0 KB',
    dropped_without_digest: 0,
    dry_run: dryRun,
    still_held: stillHeld,
    rows,
    evidence_dropped: 0,
    attachments_dropped: 0,
    stores_skipped: skipped.join(', '),
    retention_run_id: '',
  };
  if (dryRun) {
    report.bytes_freed = rows.reduce((n, r) => n + (Number(r.size_bytes) || 0), 0);
    report.bytes_freed_label = fssaiBytesLabel(report.bytes_freed);
    report.dropped_without_digest = rows.filter((r) => !String(r.digest_sha256 || '')).length;
    return report;
  }

  /* ── THE PROOF ROW ──────────────────────────────────────────────────────────
   * Written BEFORE the first drop and OUTSIDE the drop transaction, so that an
   * interrupted sweep leaves a row saying 'running' rather than no trace at all.
   * A real pass with nothing to drop still writes one: "the job ran and found
   * nothing" and "the job never ran" are different facts about a compliance
   * file, and only one of them is reassuring.
   * Best-effort, like every other audit write on a path that must not be aborted
   * by its own bookkeeping — if this row cannot be written the images are still
   * swept and the server log says so. */
  const runId = generateId();
  try {
    db.prepare(
      `INSERT INTO fssai_retention_runs
         (id, cutoff_date, months_kept, scanned_count, status, detail, triggered_by)
       VALUES (?, ?, ?, ?, 'running', ?, ?)`,
    ).run(
      runId, cutoff, months, rows.length,
      skipped.length ? `Could not walk: ${skipped.join(', ')}` : '',
      actor.email || String(actor.name || 'scheduler'),
    );
    report.retention_run_id = runId;
  } catch (e: any) {
    console.error('[fssai] retention run row could not be written — the sweep continues:', e?.message);
  }

  const droppedAt = new Date().toISOString();
  /* ⚠️ THESE STATEMENTS WRITE TWO COLUMNS AND NO OTHERS. id, response_id, mime
   * and size_bytes are the four the sheet digest is taken over — see the header
   * of this file. Adding a column to this SET is how every signature in the file
   * would quietly stop covering its sheet. The attachment store is held to the
   * same rule even though it carries no signature, so there is one rule and not
   * two. */
  const droppers = new Map<FssaiPhotoStore, Database.Statement<[string, string]>>();
  for (const store of FSSAI_PHOTO_STORES) {
    if (skipped.includes(store)) continue;
    droppers.set(store, db.prepare(
      `UPDATE ${store} SET data_uri = '', image_dropped_at = ? WHERE id = ? AND data_uri <> ''`,
    ));
  }

  const run = db.transaction(() => {
    for (const r of rows) {
      const drop = droppers.get(r.store);
      if (!drop) continue;
      const res = drop.run(droppedAt, r.id);
      if (res.changes !== 1) continue;   // somebody else dropped it between the SELECT and here
      report.dropped += 1;
      if (r.store === 'fssai_evidence') report.evidence_dropped += 1;
      else report.attachments_dropped += 1;
      report.bytes_freed += Number(r.size_bytes) || 0;
      if (!String(r.digest_sha256 || '')) report.dropped_without_digest += 1;
      /* WHY THE AUDIT ROW MATTERS MORE THAN USUAL. This is the only trace that
       * an image ever left the file. It records the digest so the fingerprint
       * survives in TWO places (the row and the append-only log), and it is
       * best-effort for the same reason every other FSSAI audit is: losing the
       * log row must not abort a sweep, it must be shouted about in the server
       * log. The row itself keeps image_dropped_at either way, so the record can
       * still say what happened even if this write is lost. */
      fssaiAuditBestEffort(db, {
        entity_table: r.store,
        entity_id: r.id,
        action: 'retention_drop_image',
        field: 'data_uri',
        before: {
          // Whichever pair this store uses; the other is '' and says so by being ''.
          run_id: r.run_id || '', response_id: r.response_id || '',
          of_table: r.entity_table || '', of_id: r.entity_id || '',
          filename: r.filename,
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

  try {
    run();
  } catch (e: any) {
    if (report.retention_run_id) {
      try {
        db.prepare(
          `UPDATE fssai_retention_runs
              SET status='failed', finished_at=datetime('now'), detail=?
            WHERE id=?`,
        ).run(String(e?.message || 'The sweep failed.').slice(0, 500), report.retention_run_id);
      } catch { /* the throw below is the thing that matters */ }
    }
    throw e;
  }

  report.bytes_freed_label = fssaiBytesLabel(report.bytes_freed);

  if (report.retention_run_id) {
    try {
      db.prepare(
        `UPDATE fssai_retention_runs
            SET status='done', finished_at=datetime('now'),
                dropped_count=?, bytes_freed=?, evidence_dropped=?, attachments_dropped=?, detail=?
          WHERE id=?`,
      ).run(
        report.dropped, report.bytes_freed, report.evidence_dropped, report.attachments_dropped,
        skipped.length ? `Could not walk: ${skipped.join(', ')}` : '',
        report.retention_run_id,
      );
    } catch (e: any) {
      console.error('[fssai] retention run row could not be closed:', e?.message);
    }
  }

  return report;
}

/**
 * A one-line answer to "how much of this file is photographs, and how much of
 * that has aged out?" — for an admin screen or a console, without dropping
 * anything. Pure read.
 */
export interface FssaiPhotoStoreStatus {
  store: FssaiPhotoStore;
  /** false = the table is not in this database (see photoTableExists) */
  present: boolean;
  held: number;
  held_bytes: number;
  overdue: number;
  overdue_bytes: number;
  already_dropped: number;
}

export interface FssaiRetentionStatus {
  /** EVERY store added together — this is what a screen leads with. */
  held: number;
  held_bytes: number;
  held_bytes_label: string;
  overdue: number;
  overdue_bytes: number;
  overdue_bytes_label: string;
  already_dropped: number;
  cutoff: string;
  retention_months: number;
  /** per store, so "which half of the photographs is this" is answerable */
  stores: FssaiPhotoStoreStatus[];
  /** stores this database does not have — '' when both are present */
  stores_missing: string;
  armed: false;
}

/**
 * ⚠️ THE TOTALS NOW COVER BOTH STORES. Before P10 these three numbers were
 * fssai_evidence only, which was all there was. A caller that wants the old
 * meaning reads `stores[]`; a screen that shows `held` is showing every
 * photograph in the module, which is the only number that answers "how big is
 * this file going to get".
 */
export function fssaiPhotoRetentionStatus(
  db: Database.Database = getDb(),
  opts: { now?: Date; months?: number } = {},
): FssaiRetentionStatus {
  const months = opts.months ?? FSSAI_PHOTO_RETENTION_MONTHS;
  const cutoff = fssaiRetentionCutoff(opts.now ?? new Date(), months);

  const stores: FssaiPhotoStoreStatus[] = FSSAI_PHOTO_STORES.map((store) => {
    if (!photoTableExists(db, store)) {
      return { store, present: false, held: 0, held_bytes: 0, overdue: 0, overdue_bytes: 0, already_dropped: 0 };
    }
    const held = db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS b FROM ${store} WHERE data_uri <> ''`,
    ).get() as any;
    const overdue = db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS b
         FROM ${store} WHERE data_uri <> '' AND replace(created_at, ' ', 'T') <= ?`,
    ).get(cutoff) as any;
    const gone = db.prepare(
      `SELECT COUNT(*) AS n FROM ${store} WHERE image_dropped_at <> ''`,
    ).get() as any;
    return {
      store,
      present: true,
      held: Number(held?.n) || 0,
      held_bytes: Number(held?.b) || 0,
      overdue: Number(overdue?.n) || 0,
      overdue_bytes: Number(overdue?.b) || 0,
      already_dropped: Number(gone?.n) || 0,
    };
  });

  const sum = (pick: (s: FssaiPhotoStoreStatus) => number) => stores.reduce((n, s) => n + pick(s), 0);
  const heldBytes = sum((s) => s.held_bytes);
  const overdueBytes = sum((s) => s.overdue_bytes);

  return {
    held: sum((s) => s.held),
    held_bytes: heldBytes,
    held_bytes_label: fssaiBytesLabel(heldBytes),
    overdue: sum((s) => s.overdue),
    overdue_bytes: overdueBytes,
    overdue_bytes_label: fssaiBytesLabel(overdueBytes),
    already_dropped: sum((s) => s.already_dropped),
    cutoff,
    retention_months: months,
    stores,
    stores_missing: stores.filter((s) => !s.present).map((s) => s.store).join(', '),
    /* Stated in the payload, not just in a comment, so a screen that shows this
     * cannot imply a sweep is running. It is still FALSE after P10: the sweep can
     * now be run by an administrator from /fssai/audit-log and it records what it
     * did, but NOTHING calls it on a schedule on this branch. Flip it only when a
     * real job exists. */
    armed: false,
  };
}

/* ------------------------------------------------------------------ *
 * WHAT THE SWEEP DID, LAST TIME AND THE TIMES BEFORE
 * ------------------------------------------------------------------ */

export interface FssaiRetentionRunRow {
  id: string;
  started_at: string;
  finished_at: string;
  cutoff_date: string;
  months_kept: number;
  scanned_count: number;
  dropped_count: number;
  bytes_freed: number;
  bytes_freed_label: string;
  evidence_dropped: number;
  attachments_dropped: number;
  status: string;
  detail: string;
  triggered_by: string;
  /** started and never finished — an interrupted sweep, visible rather than lost */
  interrupted: boolean;
}

/**
 * The sweep's own history, newest first.
 *
 * An unattended job that deletes image data out of a compliance file has to be
 * answerable for it, and "nothing in this list" is itself an answer: it means no
 * sweep has ever run, so every photograph ever taken is still in the database.
 */
export function listFssaiRetentionRuns(
  db: Database.Database = getDb(),
  limit = 20,
): FssaiRetentionRunRow[] {
  const r = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='fssai_retention_runs'`).get() as any;
  if (!r) return [];
  const rows = db.prepare(
    `SELECT * FROM fssai_retention_runs ORDER BY started_at DESC, rowid DESC LIMIT ?`,
  ).all(Math.max(1, Math.min(200, limit))) as any[];
  return rows.map((x) => ({
    id: x.id,
    started_at: x.started_at || '',
    finished_at: x.finished_at || '',
    cutoff_date: x.cutoff_date || '',
    months_kept: Number(x.months_kept) || 0,
    scanned_count: Number(x.scanned_count) || 0,
    dropped_count: Number(x.dropped_count) || 0,
    bytes_freed: Number(x.bytes_freed) || 0,
    bytes_freed_label: fssaiBytesLabel(Number(x.bytes_freed) || 0),
    evidence_dropped: Number(x.evidence_dropped) || 0,
    attachments_dropped: Number(x.attachments_dropped) || 0,
    status: x.status || '',
    detail: x.detail || '',
    triggered_by: x.triggered_by || '',
    interrupted: String(x.status || '') === 'running' && !String(x.finished_at || ''),
  }));
}
