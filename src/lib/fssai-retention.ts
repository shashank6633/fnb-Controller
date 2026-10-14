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
 * ═══ IT RUNS UNATTENDED NOW — SO ITS SCOPE IS WHAT Q13 RULED, AND NO MORE ═══
 *
 * When this file was written nothing called the sweep on a schedule. That is no
 * longer true: `runFssaiRetentionJob` (src/lib/fssai-jobs.ts) drives it once per
 * IST day from the app scheduler (src/lib/scheduler.ts, armed in
 * instrumentation.ts register()), and an administrator can still run it from
 * /fssai/audit-log. A job that deletes image data with nobody watching must be
 * held to EXACTLY what the owner ruled, so two things changed when it was armed:
 *
 *  1. IT WALKS fssai_evidence ONLY — the photographs on a checklist round, which
 *     is the store Q13 was asked about and answered. fssai_attachments (a
 *     delivery's photo, a pest sighting, a contractor's job sheet, a LICENCE or
 *     CERTIFICATE SCAN, an audit report, closure evidence) is NEVER swept.
 *
 *     ══ OWNER RULING Q22, 2026-10-14 (final) ══════════════════════════════
 *     "Document scans in fssai_attachments (licence, FoSTaC, pest job sheets,
 *      delivery photos) are NEVER auto-deleted. Only checklist photos
 *      (fssai_evidence) follow the 12-month sweep."
 *     ════════════════════════════════════════════════════════════════════════
 *
 *     Why it matters: an FSSAI licence is valid for one to five years, a FoSTaC
 *     certificate for two, and a sweep that treated their scans like a fridge
 *     photo would delete the copy of a licence while the licence is still in
 *     force — the very document an inspector asks for first. Measured on a copy
 *     of the database before the store was taken off the sweep: a licence valid
 *     to 2029 whose scan was two years old lost its scan to one sweep.
 *
 *     Enforced three times, so no single edit can undo the ruling:
 *       (a) FSSAI_RETENTION_SWEPT_STORES names fssai_evidence alone;
 *       (b) FSSAI_RETENTION_NEVER_SWEPT_STORES names fssai_attachments, and the
 *           sweep skips any store on it EVEN IF somebody adds it to (a) — no
 *           drop statement is ever prepared for it;
 *       (c) the scheduler's guard (runFssaiRetentionJob, fssai-jobs.ts) refuses
 *           the whole daily pass if a dry run names any store but fssai_evidence.
 *     A mistaken file in fssai_attachments is VOIDED (status 'void' + reason +
 *     actor), never blanked: recordFssaiManualImageRemoval below refuses that
 *     store, so the old "take the image back within 24 hours" path can no longer
 *     blank one. The status payload reports the store per store (`swept: false`,
 *     `past_window_kept`), never as "past the window" for a button that will
 *     never drop it.
 *
 *  2. ONLY A WELL-FORMED created_at CAN EVER QUALIFY. The old SQL compared
 *     `replace(created_at,' ','T') <= cutoff` AS STRINGS, so '' — and anything
 *     else that sorts before a digit — was "older than every cutoff" and was
 *     swept; so were '2024-02-30 10:00:00' and '2024-06-01 25:00:00', which are
 *     not times at all. Measured on a copy: all three were dropped. Age is now
 *     decided by `fssaiRetentionInstantMs`, which returns NaN unless the value is
 *     a real calendar date and time, and a row whose age cannot be proved is KEPT
 *     and COUNTED (`unprovable_age`) instead. A side effect worth knowing: the
 *     scheduler's own guard used to refuse the WHOLE daily pass when one such row
 *     reached the candidate list, so a single bad timestamp stopped retention for
 *     every photograph for ever; now the bad row is skipped and named, and the
 *     guard stays as the backstop it was meant to be.
 *
 * THE OTHER WAY AN IMAGE CAN LEAVE THE FILE — a manager correcting a checklist
 * photograph attached by mistake — is governed here too
 * (`fssaiManualRemovalRefusal`, `recordFssaiManualImageRemoval`), so the rules
 * about how long a picture lives sit side by side and every image that ever
 * leaves is in ONE ledger, fssai_retention_runs. Since Q22 that path is for
 * fssai_evidence only; an attachment is voided, never removed.
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
 * P10 walked BOTH tables, on the reasoning that a sweep over fssai_evidence
 * alone "keeps every record-module photograph for ever while reporting success".
 * That reasoning assumed Q13 covered both stores. It does not: Q13 was asked and
 * answered about checklist photographs, and the second store is Q22 — which the
 * owner has now RULED: never auto-deleted (see the header). So the sweep walks
 * FSSAI_RETENTION_SWEPT_STORES (fssai_evidence) and the "green report over a
 * growing database" risk is answered by SAYING it: the report names the store it
 * deliberately does not walk (`stores_not_swept`), every run row's detail says
 * so, and the status payload reports fssai_attachments with `swept: false` and
 * how many of its files are past twelve months and kept BY RULING.
 * `attachments_dropped` stays in the report and the run row for the history it
 * already holds; after Q22 nothing raises it.
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
  /**
   * Stores the sweep DELIBERATELY does not walk — 'fssai_attachments', by owner
   * ruling Q22 (never auto-deleted). Distinct from `stores_skipped`, which is a
   * store the sweep wanted to walk and could not.
   */
  stores_not_swept: string;
  /**
   * Images in a swept store whose created_at is not a real date and time ('',
   * '2024-02-30 10:00:00', 'yesterday', …). Their age cannot be proved, so they
   * are KEPT, never treated as older than the cutoff — and counted, so a bad
   * timestamp is visible rather than silently immortal.
   */
  unprovable_age: number;
  /** The first few of those, by store and id, so somebody can go and look. */
  unprovable_rows: { store: FssaiPhotoStore; id: string; created_at: string }[];
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

/**
 * THE AGE OF A STORED IMAGE, OR NaN WHEN IT CANNOT BE PROVED.
 *
 * The ONE place this file decides how old a picture is — the sweep, the status
 * payload and the manual-removal window all call it, so they cannot disagree.
 *
 * Accepts exactly the two shapes this app writes:
 *   · SQLite's datetime('now'):  'YYYY-MM-DD HH:MM:SS'      (UTC, no zone)
 *   · an ISO instant:             'YYYY-MM-DDTHH:MM:SS.sssZ'  (or ±HH:MM)
 * Seconds and up to three fractional digits are optional. Everything else is
 * NaN: '', a bare date, 'yesterday', a locale string — and also values that
 * have the right SHAPE but are not real times ('2024-02-30', '25:00:00'), which
 * Date.parse would quietly roll over into a different, real instant.
 *
 * Deliberately no looser than parseStoredInstant in src/lib/fssai-jobs.ts (the
 * scheduler's own guard): anything this accepts, that accepts with the same
 * value, so a row the sweep calls old is never one the guard calls unprovable.
 *
 * A year before 2000 is also NaN. Nothing in this module was written then, and
 * '0001-01-01 00:00:00' is a placeholder, not an upload time; calling it the
 * oldest photograph in the file would make it the first one dropped.
 */
const STORED_INSTANT = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/;

export function fssaiRetentionInstantMs(v: unknown): number {
  const s = String(v ?? '').trim();
  const m = s.match(STORED_INSTANT);
  if (!m) return NaN;
  const [, ys, mos, ds, hs, mis, ss, frac, zone] = m;
  const y = Number(ys), mo = Number(mos), d = Number(ds), h = Number(hs), mi = Number(mis), sec = Number(ss || 0);
  if (y < 2000 || mo < 1 || mo > 12 || h > 23 || mi > 59 || sec > 59) return NaN;
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d < 1 || d > daysInMonth) return NaN;
  let offsetMin = 0;
  if (zone && zone !== 'Z') {
    const oh = Number(zone.slice(1, 3)), om = Number(zone.slice(4, 6));
    if (oh > 14 || om > 59) return NaN;
    offsetMin = (zone[0] === '-' ? -1 : 1) * (oh * 60 + om);
  }
  const ms = Number(((frac || '') + '000').slice(0, 3));
  return Date.UTC(y, mo - 1, d, h, mi, sec, ms) - offsetMin * 60_000;
}

/* ------------------------------------------------------------------ *
 * WHICH STORES THE SWEEP MAY TOUCH
 * ------------------------------------------------------------------ */

/**
 * THE STORES THE 12-MONTH SWEEP WALKS — what Q13 ruled, and nothing else.
 *
 * ⚠️ 'fssai_attachments' MUST NEVER BE ADDED HERE. Owner ruling Q22
 * (2026-10-14): document scans in that store are NEVER auto-deleted. Adding it
 * would not work anyway — FSSAI_RETENTION_NEVER_SWEPT_STORES below overrides
 * this list, and the scheduler's guard refuses a pass that names it — but the
 * list is the first thing a reader sees, so it says so here too.
 */
export const FSSAI_RETENTION_SWEPT_STORES: readonly FssaiPhotoStore[] = ['fssai_evidence'] as const;

/**
 * THE STORES THE SWEEP MAY NEVER TOUCH, WHATEVER THE LIST ABOVE SAYS — the
 * owner's Q22 ruling as data. The sweep subtracts this from the swept list
 * before it reads a row or prepares a statement, so a store named here has no
 * drop statement in the process at all.
 */
export const FSSAI_RETENTION_NEVER_SWEPT_STORES: readonly FssaiPhotoStore[] = ['fssai_attachments'] as const;

/** The owner's Q22 ruling, word for word — quoted on every report, run row and status. */
export const FSSAI_Q22_RULING =
  'Owner ruling Q22 (2026-10-14): document scans in fssai_attachments (licence, FoSTaC, pest job sheets, delivery photos) are NEVER auto-deleted. Only checklist photos (fssai_evidence) follow the 12-month sweep.';

/** Why each store that is NOT swept is left alone — said on every report and status. */
export const FSSAI_RETENTION_NOT_SWEPT: Readonly<Partial<Record<FssaiPhotoStore, string>>> = {
  fssai_attachments:
    'Register files (deliveries, pest control, documents and certificates, audit reports, closure evidence) are never swept. '
    + FSSAI_Q22_RULING
    + ' A file attached by mistake is voided with a reason, never deleted.',
};

function isNeverSweptStore(store: FssaiPhotoStore | string): boolean {
  return (FSSAI_RETENTION_NEVER_SWEPT_STORES as readonly string[]).includes(String(store));
}

function isSweptStore(store: FssaiPhotoStore): boolean {
  return (FSSAI_RETENTION_SWEPT_STORES as readonly string[]).includes(store) && !isNeverSweptStore(store);
}

/** The stores this process will actually walk: the swept list minus the never-swept one. */
function sweptStoresNow(): FssaiPhotoStore[] {
  return [...FSSAI_RETENTION_SWEPT_STORES].filter((s) => !isNeverSweptStore(s));
}

/* ------------------------------------------------------------------ *
 * THE TWO STORES
 * ------------------------------------------------------------------ */

/**
 * Both photo tables — every image store in the module, in the order the STATUS
 * payload reports them.
 *
 * A LIST AND NOT TWO CALLS, so that "the status forgot a table" becomes
 * impossible to express. The SWEEP does not iterate this: it iterates
 * FSSAI_RETENTION_SWEPT_STORES above, and every store here that is not in that
 * list is named on the report (`stores_not_swept`) with its reason from
 * FSSAI_RETENTION_NOT_SWEPT, so leaving a store out is always said out loud.
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

  const cutoffMs = Date.parse(cutoff);
  const skipped: string[] = [];
  const rows: (FssaiRetentionCandidate & { _ms: number })[] = [];
  const unprovable: { store: FssaiPhotoStore; id: string; created_at: string }[] = [];
  let stillHeld = 0;

  const walk = sweptStoresNow();   // Q22: never includes fssai_attachments, whatever the list says
  for (const store of walk) {
    if (!photoTableExists(db, store)) { skipped.push(store); continue; }
    /* AGE IS DECIDED IN ONE PLACE, AND NOT BY STRING COMPARISON.
     * This used to be `replace(created_at, ' ', 'T') <= ?` in the WHERE clause,
     * which sorts '' and every non-ISO value BEFORE any cutoff — so a blank or
     * malformed timestamp was "older than twelve months" and its image was
     * dropped. Now every row still holding an image is read WITHOUT its image
     * (metadata only), and fssaiRetentionInstantMs decides: a real instant at or
     * before the cutoff qualifies, a real instant after it is still held, and
     * anything that is not a real instant is KEPT and counted as unprovable. */
    const held = db.prepare(
      `SELECT id, ${storeColumns(store)}, created_at, size_bytes, mime, filename, digest_sha256
         FROM ${store}
        WHERE data_uri <> ''`,
    ).all() as any[];
    for (const r of held) {
      const ms = fssaiRetentionInstantMs(r.created_at);
      if (!Number.isFinite(ms) || !Number.isFinite(cutoffMs)) {
        unprovable.push({ store, id: String(r.id), created_at: String(r.created_at ?? '') });
      } else if (ms <= cutoffMs) {
        rows.push({ ...r, store, _ms: ms } as FssaiRetentionCandidate & { _ms: number });
      } else {
        stillHeld += 1;
      }
    }
  }
  // Oldest first, by the parsed instant — never by the raw string.
  rows.sort((a, b) => a._ms - b._ms);
  const candidates: FssaiRetentionCandidate[] = rows.map(({ _ms, ...r }) => { void _ms; return r; });

  const notSwept = FSSAI_PHOTO_STORES.filter((s) => !isSweptStore(s));
  if (unprovable.length && !dryRun) {
    console.error(
      `[fssai] retention: ${unprovable.length} image(s) have no provable age and were KEPT:`,
      unprovable.slice(0, 5).map((u) => `${u.store}:${u.id} ("${u.created_at}")`).join(', '),
    );
  }

  const report: FssaiRetentionReport = {
    cutoff,
    retention_months: months,
    candidates: candidates.length,
    dropped: 0,
    bytes_freed: 0,
    bytes_freed_label: '0 KB',
    dropped_without_digest: 0,
    dry_run: dryRun,
    still_held: stillHeld,
    rows: candidates,
    evidence_dropped: 0,
    attachments_dropped: 0,
    stores_skipped: skipped.join(', '),
    stores_not_swept: notSwept.join(', '),
    unprovable_age: unprovable.length,
    unprovable_rows: unprovable.slice(0, 20),
    retention_run_id: '',
  };
  if (dryRun) {
    report.bytes_freed = candidates.reduce((n, r) => n + (Number(r.size_bytes) || 0), 0);
    report.bytes_freed_label = fssaiBytesLabel(report.bytes_freed);
    report.dropped_without_digest = candidates.filter((r) => !String(r.digest_sha256 || '')).length;
    return report;
  }

  /* What the run row says about everything the pass did NOT drop on purpose —
   * so a reader of /fssai/audit-log sees, on every run, that register files are
   * kept and that a bad timestamp kept an image, rather than inferring both
   * from numbers that do not add up. */
  const keptNotes = [
    skipped.length ? `Could not walk: ${skipped.join(', ')}.` : '',
    unprovable.length
      ? `${unprovable.length} image(s) kept because their created_at is not a real date and time, so their age cannot be proved (first: ${unprovable.slice(0, 3).map((u) => `${u.store}:${u.id}`).join(', ')}).`
      : '',
    notSwept.length ? `Not swept, by owner ruling Q22 (2026-10-14) — never auto-deleted: ${notSwept.join(', ')}.` : '',
  ].filter(Boolean).join(' ');

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
      runId, cutoff, months, candidates.length,
      keptNotes,
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
   * would quietly stop covering its sheet.
   * Prepared ONLY for the swept stores, so even a candidate that somehow named
   * another store would find no statement to run (`if (!drop) continue`). */
  const droppers = new Map<FssaiPhotoStore, Database.Statement<[string, string]>>();
  for (const store of walk) {
    if (skipped.includes(store) || isNeverSweptStore(store)) continue;
    droppers.set(store, db.prepare(
      `UPDATE ${store} SET data_uri = '', image_dropped_at = ? WHERE id = ? AND data_uri <> ''`,
    ));
  }

  const run = db.transaction(() => {
    for (const r of candidates) {
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
        keptNotes,
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
  /** true = the 12-month sweep walks this store (FSSAI_RETENTION_SWEPT_STORES). */
  swept: boolean;
  /** '' for a swept store; otherwise why it is left alone (FSSAI_RETENTION_NOT_SWEPT). */
  not_swept_reason: string;
  held: number;
  held_bytes: number;
  /**
   * Past the window AND going to be dropped by the next sweep. Always 0 for a
   * store the sweep does not walk — a screen that offers a "sweep now" button
   * off this number must not count files the button will never touch.
   */
  overdue: number;
  overdue_bytes: number;
  /** Not-swept stores only: files older than the window that are KEPT on purpose (Q22). */
  past_window_kept: number;
  /** Images whose created_at is not a real date and time — kept, and counted here. */
  unprovable_age: number;
  already_dropped: number;
}

export interface FssaiRetentionStatus {
  /** EVERY store added together — this is what a screen leads with. */
  held: number;
  held_bytes: number;
  held_bytes_label: string;
  /** Swept stores only — see FssaiPhotoStoreStatus.overdue. */
  overdue: number;
  overdue_bytes: number;
  overdue_bytes_label: string;
  /** Files past the window in stores the sweep does not walk — kept for good, by ruling Q22. */
  past_window_kept: number;
  /** Images, in any store, whose age cannot be proved. Never swept. */
  unprovable_age: number;
  already_dropped: number;
  cutoff: string;
  retention_months: number;
  /** per store, so "which half of the photographs is this" is answerable */
  stores: FssaiPhotoStoreStatus[];
  /** stores this database does not have — '' when both are present */
  stores_missing: string;
  /** stores the sweep deliberately leaves alone — '' when it walks every store */
  stores_not_swept: string;
  /**
   * ⚠️ LEGACY FIELD — NOT A STATEMENT ABOUT THE SCHEDULER. It was written when
   * nothing ran this sweep on a schedule. runFssaiRetentionJob (fssai-jobs.ts)
   * now does, once per IST day, and whether that driver is actually ticking is
   * read off its heartbeat (readFssaiJobsHeartbeat), not off this constant. It
   * stays on the wire only because removing a field is a contract change for
   * whoever still reads it; /fssai/audit-log no longer does.
   */
  armed: false;
}

/**
 * ⚠️ `held` COVERS BOTH STORES; `overdue` COVERS ONLY WHAT THE SWEEP WALKS.
 * `held` answers "how big is this file going to get", so it is every image in
 * the module. `overdue` answers "what will the next sweep drop", so since the
 * sweep was restricted to Q13's scope it counts fssai_evidence only, and the
 * register files past twelve months are reported as `past_window_kept` instead
 * — kept for good, by owner ruling Q22.
 * Age is fssaiRetentionInstantMs — the sweep's own rule — never a string
 * comparison, so this payload and the sweep cannot disagree about a row.
 */
export function fssaiPhotoRetentionStatus(
  db: Database.Database = getDb(),
  opts: { now?: Date; months?: number } = {},
): FssaiRetentionStatus {
  const months = opts.months ?? FSSAI_PHOTO_RETENTION_MONTHS;
  const cutoff = fssaiRetentionCutoff(opts.now ?? new Date(), months);
  const cutoffMs = Date.parse(cutoff);

  const stores: FssaiPhotoStoreStatus[] = FSSAI_PHOTO_STORES.map((store) => {
    const swept = isSweptStore(store);
    const notSweptReason = swept ? '' : String(FSSAI_RETENTION_NOT_SWEPT[store] || 'Not swept.');
    const empty: FssaiPhotoStoreStatus = {
      store, present: false, swept, not_swept_reason: notSweptReason,
      held: 0, held_bytes: 0, overdue: 0, overdue_bytes: 0,
      past_window_kept: 0, unprovable_age: 0, already_dropped: 0,
    };
    if (!photoTableExists(db, store)) return empty;
    const out: FssaiPhotoStoreStatus = { ...empty, present: true };
    // Metadata only — the image column is tested, never read.
    const rows = db.prepare(
      `SELECT created_at, size_bytes FROM ${store} WHERE data_uri <> ''`,
    ).all() as { created_at: string; size_bytes: number }[];
    for (const r of rows) {
      const bytes = Number(r.size_bytes) || 0;
      out.held += 1;
      out.held_bytes += bytes;
      const ms = fssaiRetentionInstantMs(r.created_at);
      if (!Number.isFinite(ms) || !Number.isFinite(cutoffMs)) { out.unprovable_age += 1; continue; }
      if (ms > cutoffMs) continue;
      if (swept) { out.overdue += 1; out.overdue_bytes += bytes; }
      else out.past_window_kept += 1;
    }
    const gone = db.prepare(
      `SELECT COUNT(*) AS n FROM ${store} WHERE image_dropped_at <> ''`,
    ).get() as any;
    out.already_dropped = Number(gone?.n) || 0;
    return out;
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
    past_window_kept: sum((s) => s.past_window_kept),
    unprovable_age: sum((s) => s.unprovable_age),
    already_dropped: sum((s) => s.already_dropped),
    cutoff,
    retention_months: months,
    stores,
    stores_missing: stores.filter((s) => !s.present).map((s) => s.store).join(', '),
    stores_not_swept: stores.filter((s) => !s.swept).map((s) => s.store).join(', '),
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

/* ------------------------------------------------------------------ *
 * THE OTHER WAY AN IMAGE LEAVES THE FILE — a manager's correction
 * ------------------------------------------------------------------ */

/**
 * HOW LONG A FILE ON A FILED RECORD CAN BE TAKEN BACK: 24 HOURS FROM UPLOAD.
 *
 * ═══ THE DECISION, AND WHY ══════════════════════════════════════════════════
 *
 * Is a filed record's image removable at all? FSSAI's rule — and this module's
 * (§19) — is VOID, NEVER DELETE, and a pest visit's job sheet, a rat sighting's
 * photograph and a licence scan are exactly the things an inspector asks to see.
 * Before this, a manager could blank ANY of them at ANY age, with nothing in
 * the retention ledger, and — worse — through ANY record's route, because the
 * route never checked that the file belonged to the record it named.
 *
 * Decided: NOT REMOVABLE, with one narrow exception — a CORRECTION of a file
 * attached by mistake, within FSSAI_FILE_CORRECTION_HOURS of its upload. That is
 * the window in which "I attached the wrong photograph" is a correction; after
 * it, the file has been part of the record long enough to be relied on, and the
 * only honest remedies are the ones that leave it in place: attach the right
 * file beside it, or void the whole record with a reason and file it again.
 *
 * Even inside the window, a correction is NOT a deletion: the row, its size and
 * its sha256 stay (the image alone is blanked, exactly as the 12-month sweep
 * does), an fssai_audit_log row names who, when and why, and an
 * fssai_retention_runs row puts it in the SAME ledger as every sweep — so
 * "which images have ever left this file, and why" has one answer. Both writes
 * are mandatory: if either cannot be written, nothing is removed.
 *
 * Refused regardless of age: a file whose created_at is not a real instant (its
 * age cannot be proved, so it cannot be proved to be inside the window), and any
 * file on a record that has been VOIDED (a voided record is closed evidence).
 *
 * ASSUMPTION, REVERSIBLE: 24 hours. It is long enough to catch a mistake made at
 * the end of a shift by the manager on the next one, and short enough that no
 * inspection could have relied on the file in between. Changing it is one line.
 *
 * ⚠️ SINCE OWNER RULING Q22 (2026-10-14) THIS WINDOW IS FOR CHECKLIST
 * PHOTOGRAPHS (fssai_evidence) ONLY. A file in fssai_attachments is never
 * blanked, inside 24 hours or out: it is voided with a reason and stays on file
 * (FSSAI_ATTACHMENT_VOID_ONLY), and recordFssaiManualImageRemoval refuses that
 * store so a removal transaction for it cannot commit.
 */
export const FSSAI_FILE_CORRECTION_HOURS = 24;

/**
 * '' if a file uploaded at `createdAt` may still be corrected at `now`; else the
 * refusal in words. Uses fssaiRetentionInstantMs, so "how old is this image"
 * has the same answer here as in the sweep.
 */
export function fssaiManualRemovalRefusal(
  createdAt: unknown,
  now: Date = new Date(),
  hours: number = FSSAI_FILE_CORRECTION_HOURS,
): string {
  const ms = fssaiRetentionInstantMs(createdAt);
  if (!Number.isFinite(ms)) {
    return 'This file has no readable upload time, so it cannot be shown to be a same-day correction. It stays on the record. If it is the wrong file, attach the right one beside it, or void the record with a reason and file it again.';
  }
  const age = now.getTime() - ms;
  // An upload time in the future (beyond a few minutes of clock skew) is not a
  // recent upload, it is a timestamp nobody can vouch for — and "the future" is
  // always inside any window, so it must not be the way round the window.
  if (age < -5 * 60_000) {
    return 'This file\'s upload time is in the future, so it cannot be shown to be a same-day correction. It stays on the record. If it is the wrong file, attach the right one beside it, or void the record with a reason and file it again.';
  }
  if (age > hours * 3600_000) {
    return `This file was attached on ${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC. A file can only be taken back within ${hours} hours of attaching it; after that it is part of the record (FSSAI: void, never delete). If it is the wrong file, attach the right one beside it, or void the record with a reason and file it again.`;
  }
  return '';
}

/**
 * Write the fssai_retention_runs row for ONE manually removed image.
 *
 * THROWS on failure, deliberately — the opposite of the sweep's best-effort
 * proof row. A sweep must leave a trace even when it fails; a manual removal
 * must not HAPPEN without its trace. Call it inside the same transaction as the
 * UPDATE that blanks the image, so the two commit or roll back together.
 *
 * The row reads on /fssai/audit-log as: scanned 1 · dropped 1 · window 0 months
 * · by <manager>, with the record, the file, its digest and the reason in
 * `detail`. months_kept = 0 is what distinguishes it from any sweep (the sweep
 * never runs with a window under one month), and cutoff_date is the upload time
 * of the file — the only "cutoff" a correction has.
 */
export const FSSAI_MANUAL_REMOVAL_PREFIX = 'Manual correction, not the retention sweep:';

/**
 * THE ANSWER TO "TAKE THIS FILE OFF THE RECORD" FOR AN ATTACHMENT, after Q22.
 * A route that removes files should say this (409) rather than try; the throw
 * below is the backstop for one that still tries.
 */
export const FSSAI_ATTACHMENT_VOID_ONLY =
  'A file on a food-safety record is never removed or blanked (owner ruling Q22, 2026-10-14). If it was attached by mistake, void it with a reason — it stays on file, struck out, with who voided it and why — and attach the right one beside it.';

/** The error code the backstop throws with, so a caller can tell it from a failed write. */
export const FSSAI_Q22_VOID_ONLY_CODE = 'FSSAI_Q22_VOID_ONLY';

export function recordFssaiManualImageRemoval(
  db: Database.Database,
  p: {
    store: FssaiPhotoStore;
    file_id: string;
    /** what the file is ON, in words and by id */
    of_words: string;
    of_table: string;
    of_id: string;
    filename: string;
    size_bytes: number;
    digest_sha256: string;
    created_at: string;
    created_by: string;
    reason: string;
    actor: { email?: string | null; name?: string | null };
    outlet_id?: string;
  },
): string {
  /* Q22 BACKSTOP. This ledger row is MANDATORY for a removal (the caller runs it
   * inside the same transaction as the UPDATE that blanks the image, and a throw
   * here rolls that UPDATE back). Since the owner ruled that attachments are
   * never blanked — a mistaken one is voided — refusing to write the row for
   * that store is what makes any removal path that still exists for it roll
   * back, with the image left exactly where it was. */
  if (p.store === 'fssai_attachments' || isNeverSweptStore(p.store)) {
    const e: any = new Error(FSSAI_ATTACHMENT_VOID_ONLY);
    e.code = FSSAI_Q22_VOID_ONLY_CODE;
    throw e;
  }
  const id = generateId();
  const detail = [
    FSSAI_MANUAL_REMOVAL_PREFIX,
    `one file taken off ${p.of_words} ${p.of_id} (${p.of_table}).`,
    `File ${p.file_id} "${p.filename || 'unnamed'}", ${fssaiBytesLabel(Number(p.size_bytes) || 0)},`,
    `sha256 ${p.digest_sha256 || '(none recorded)'}, attached ${p.created_at} by ${p.created_by || 'unknown'}.`,
    `Reason: "${p.reason}". The row, its size and its digest are kept.`,
  ].join(' ').slice(0, 1000);
  db.prepare(
    `INSERT INTO fssai_retention_runs
       (id, finished_at, cutoff_date, months_kept, scanned_count, dropped_count, bytes_freed,
        evidence_dropped, attachments_dropped, status, detail, triggered_by, outlet_id)
     VALUES (?, datetime('now'), ?, 0, 1, 1, ?, ?, ?, 'done', ?, ?, ?)`,
  ).run(
    id, String(p.created_at || ''), Number(p.size_bytes) || 0,
    // attachments_dropped is always 0 here: an attachment never reaches this line (Q22 backstop above).
    p.store === 'fssai_evidence' ? 1 : 0, 0,
    detail, String(p.actor.email || p.actor.name || 'unknown'), String(p.outlet_id || ''),
  );
  return id;
}
