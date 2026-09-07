/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Undo ONE Reservego import — the engine behind
 * GET/DELETE /api/crm/reservations/imports/[id].
 *
 * WHAT IT IS FOR. The owner is trialling the importer on production: upload a
 * file, look at what landed, and if it is wrong, undo THAT upload, fix the file
 * and go again. That loop is the whole requirement. Everything below is shaped
 * by it, including what it refuses to promise.
 *
 * ── WHAT "DELETE IMPORT X" ACTUALLY MEANS, AND WHY IT IS NOT A TIME MACHINE ──
 * ct_bookings.import_id is stamped on INSERT **and rewritten on every UPDATE**
 * — reservego-import.ts says so at its own line 653-655: "it changes on EVERY
 * upload". So import_id names the LAST import that touched a row, not the one
 * that created it. Deleting `WHERE import_id = X` is therefore exactly right for
 * "I just uploaded X, take it back", and it is NOT right for "rewind X out of a
 * history of ten files": a booking that an earlier file created and X merely
 * AMENDED now carries X's id and is deleted with it.
 *
 * That is not a defect to hide behind a hopeful button label. It is measured and
 * returned: `bookings_from_earlier_imports` counts the rows in the delete set
 * whose own provenance predates this upload, and `notice` states the limit in
 * plain English for the UI to print verbatim. A caller that shows the counts and
 * hides the notice has broken this module's contract.
 *
 * Why the count is NOT taken from source_exported_at alone, even though that is
 * the obvious column: it cannot fire. The upsert writes
 * `source_exported_at = MAX(stored, incoming)` (reservego-import.ts:747) and the
 * export-recency guard (:1231-1234) refuses any row whose stored stamp is NEWER
 * than the incoming file, so every row left carrying import_id = X also carries
 * X's own stamp. A comparison that is structurally always 0 would read as "this
 * undo reaches nothing beyond the file" — a reassurance, not a signal. The
 * count that does fire is created_at: it is INSERT_ONLY (:685), never rewritten
 * by a later export, so `created_at < the import's started_at` is precisely
 * "this row existed before this upload began". Both are computed, both are
 * returned separately, and the headline is their union.
 *
 * ── AND WHEN IT CANNOT TELL, IT SAYS SO ──────────────────────────────────────
 * That whole comparison rests on the session row's `started_at`. Undo an
 * ORPHANED set — bookings still carrying an import id whose reservation_imports
 * row is already gone — and there is nothing to compare against. The earlier
 * version answered that case with "All N bookings were created by this upload —
 * nothing older is caught in it", which is absence of evidence dressed up as
 * evidence of absence, and it fired in exactly the situation where the owner is
 * least able to check.
 *
 * So every answer now carries `provenance`: 'measured' when a session row with a
 * usable started_at backed the comparison, 'unknown' when it did not. On
 * 'unknown' the three provenance counts are left at 0 BECAUSE THEY MEAN NOTHING,
 * the notice says outright that nothing here can tell which rows predate the
 * file, and the UI is required not to render them as measurements.
 *
 * ── DELETE MEANS FULL ────────────────────────────────────────────────────────
 * The owner's ruling, and it overrides any instinct to keep data "for safety":
 * if it came in through that file, deleting the file takes it back out. The loop
 * is upload → inspect → delete → re-upload, so a leftover does not merely linger,
 * it corrupts the very comparison the delete was performed to make.
 *
 * Concretely, beyond the bookings and the import-born guests:
 *   • A guest who existed before this file — a phone-CRM contact, or anyone with
 *     a call or a non-reservego booking — KEEPS THEIR CONTACT RECORD, because
 *     that record was never this file's data. What this file WROTE ONTO them is
 *     still this file's data and is taken back out: the tags it supplied, the
 *     preference note it wrote, and the name/email it filled in.
 *   • name and email cannot be RESTORED, only BLANKED. ct_bookings does not
 *     store the guest's name or email (the CSV columns are consumed for identity
 *     resolution and discarded), there are no history columns and no triggers,
 *     and identity_from records only WHICH BOOKING supplied a value, never what
 *     stood there before. Leaving this upload's value in place would be
 *     pretending the import never happened, so the field is cleared and the
 *     notice says, in those words, that it was blanked and not restored.
 *   • phone10 is the one field this undo will not revert. It is the join key
 *     every other CRM row uses to find the guest, and backfillGuestPhone10
 *     writes it for guests unrelated to any import. Disclosed, not silent.
 * Guests rewritten this way are counted (`guests_profile_cleared`), the fields
 * blanked are counted (`guest_fields_blanked`), and both are stated in `notice`.
 * NOTHING IN THIS MODULE MAY EVER TELL THE OWNER A SURVIVING PROFILE IS
 * "UNTOUCHED" OR "KEEPS THEIR RECORD" while it still carries this file's values.
 *
 * ── THE DUPLICATE VERDICT IS RE-DECIDED, NOT LEFT STANDING ───────────────────
 * is_duplicate is a stored verdict over a (outlet, phone, date) group: one row
 * is the visit, the rest are its duplicates, and every metric surface filters
 * `is_duplicate = 0` (ct/guest-metrics.ts:196). Delete the row that WAS the
 * primary and its loser keeps the flag forever — the booking sits in the table,
 * visible in the Bookings tab, invisible in the guest 360, and its guest reads 0
 * lifetime bookings. markImportDuplicates cannot repair it later: it only ever
 * targets guests holding a row of a NEW import.
 *
 * So the undo re-runs markDuplicateGroups over every group that loses a row,
 * inside the same transaction and BEFORE refreshGuestMetrics — which reads the
 * flag, so running it first would write metrics off the stale verdict. Rows are
 * ranked on reservego_key exactly as reservego-import.ts:1438 ranks them, so
 * undo and the next re-import elect the SAME primary instead of fighting. Moves
 * in both directions are written: refusing to demote a stale 0 would leave a
 * group with two primaries and double-count the visit everywhere. The refresh
 * target is widened to the guests whose flags moved, who may be siblings sharing
 * a phone number and need not hold a row of this import at all.
 *
 * ── THE ROWS THAT MUST BE UNTOUCHABLE ────────────────────────────────────────
 * Measured on a copy of production taken 2026-08-13 (34 MB, sqlite3 .backup off
 * the live file): ct_bookings holds 40 rows and ALL 40 have import_id NULL;
 * ct_guests holds 27 rows, sources call 22 / walk-in 4 / loyalty 1, none
 * 'reservego'; reservation_imports is empty. That is the phone CRM's real
 * history and no undo may ever reach it. Two constructions, not two intentions:
 *
 *   1. Every booking statement carries `AND COALESCE(import_id, '') <> ''`
 *      beside `import_id = ?`. A NULL never equals a parameter in SQL, and the
 *      COALESCE closes the one remaining hole — a caller that somehow passed ''
 *      would otherwise match rows stamped ''. With both, an unstamped row cannot
 *      be selected by this file whatever id it is handed. The route also refuses
 *      a blank id before it gets here; this is the second lock, not the first.
 *   2. A guest is deletable only where `source = 'reservego'` — the literal the
 *      importer's INSERT writes (reservego-import.ts:851) and which
 *      updateGuestFields never rewrites, so it means "this profile was created
 *      by a Reservego import" and nothing else. The 27 real guests fail that
 *      test by their own stored data, so they cannot be deleted even when an
 *      import attaches a booking to them and that booking is their only one.
 *
 * ── AND THE GUESTS THAT SURVIVE ──────────────────────────────────────────────
 * A guest holding BOTH a Reservego booking and a phone booking is the entire
 * point of the feature, so deleting one is deleting real CRM history. A guest is
 * removed only when, AFTER the bookings are gone, they hold zero bookings of any
 * kind (asserted in SQL as NOT EXISTS against ct_bookings, not inferred from the
 * count taken before the delete), were born of an import, and nothing else in
 * the CRM points at them — no call, follow-up, recovery, topic hit or campaign
 * target. A guest kept for one of those reasons is reported as
 * `guests_kept_orphan`, never silently.
 *
 * Everyone who survives is passed to refreshGuestMetrics(), the one owner of the
 * stored ct_guests lifetime numbers: their total_bookings, spend and arrival
 * rate describe rows that no longer exist until it runs. Guests left with no
 * bookings at all get zeros written, which is that module's documented
 * behaviour and the correct answer here.
 *
 * ── ONE TRANSACTION ──────────────────────────────────────────────────────────
 * Bookings, guests, metrics and the session row commit together or not at all. A
 * half-undone import is worse than a bad one: the counts in Import History would
 * describe rows that are gone, and nothing afterwards would say which half
 * landed.
 *
 * ── THE SESSION ROW IS DELETED, NOT FLAGGED ──────────────────────────────────
 * A soft `deleted_at` would be the better audit trail, and it is the wrong
 * choice HERE: the Import History list (GET /api/crm/reservations/imports) does
 * `SELECT * … ORDER BY started_at DESC` and the page renders every row it is
 * given. Neither is in this change's scope, so a flagged row would keep
 * appearing in the owner's history — with its original counts — as though the
 * upload were still there. The visible truth wins: the row goes, the counts of
 * what was removed are returned to the caller, and the deletion is written to
 * the server log with the actor. If a soft-delete is wanted later it is a column
 * plus a WHERE in the list route, and this function is where it changes.
 */
import type Database from 'better-sqlite3';
import { refreshGuestMetrics } from '@/lib/ct/guest-metrics';
import { markDuplicateGroups, isArrived } from '@/lib/reservego';
import type { StoredBookingRow, BookingStatus } from '@/lib/reservego';

type DB = Database.Database;

/**
 * Guest ids per statement. Matches guest-metrics.ts CHUNK for the same reason
 * it gives: well under better-sqlite3's measured 32,766-parameter ceiling, and
 * the two batched guest readers should behave alike. A first-import undo can
 * legitimately name 70,000 guests (the owner's full archive), which is why this
 * file never builds one IN list from the whole set.
 */
const CHUNK = 400;

/**
 * Every scoping predicate in this file, written once.
 *
 * `import_id = ?` alone would already miss a NULL — SQL comparison with NULL is
 * NULL, never true — and the COALESCE also makes a row stamped with the empty
 * string unreachable, so no value of the parameter can select an unstamped
 * booking. This constant is the only place the delete set is defined; if it is
 * ever weakened, the 40 phone-CRM bookings stop being safe by construction.
 */
const inImport = (prefix = '') =>
  `${prefix}import_id = ? AND COALESCE(${prefix}import_id, '') <> ''`;
const IN_IMPORT = inImport();

/**
 * Tables that hold a ct_guests id. A guest referenced by any of them is kept
 * even when their last booking has just been deleted: a call, a follow-up or a
 * recovery is CRM history in its own right, and deleting the profile would
 * leave those rows pointing at nobody.
 *
 * crm_guest_visits.guest_id is deliberately absent — it references crm_guests
 * (db.ts:3490), a different table, and including it would be a join to the
 * wrong master.
 */
const GUEST_LINK_TABLES: Array<[table: string, column: string]> = [
  ['ct_calls', 'guest_id'],
  ['ct_follow_ups', 'guest_id'],
  ['ct_recoveries', 'guest_id'],
  ['ct_topic_hits', 'guest_id'],
  ['ct_campaign_targets', 'guest_id'],
];

/**
 * Columns elsewhere that hold a ct_bookings id. These are NOT blockers — the
 * owner asked to be able to take an upload back, and a link is not a veto — but
 * they are counted and named in the notice, because deleting the booking leaves
 * the link pointing at a row that is gone.
 *
 * Measured on the 2026-08-13 copy: 0 orders carry a booking_id at all, so this
 * count is 0 on today's data and exists for the day it is not.
 *
 * The orders label is 'orders' and NOT 'settled orders': the query has no
 * settlement predicate — it counts every orders row holding a non-empty
 * booking_id, settled or open — and a label that narrows what was actually
 * counted is the same class of lie this repair exists to remove.
 */
const BOOKING_LINK_COLUMNS: Array<[table: string, column: string, label: string]> = [
  ['orders', 'booking_id', 'orders'],
  ['party_menus', 'booking_id', 'party menus'],
  ['ct_recoveries', 'recovery_booking_id', 'call recoveries'],
];

/**
 * The ct_guests fields whose provenance identity_from records, in the order it
 * serialises them. A byte-for-byte mirror of reservego-import.ts:227 — the
 * importer does not export it, and the serialisation must produce the same
 * STRING as the importer's stringifyIdentity or a re-upload would see a change
 * where there is none. Key order is the content, not a detail: see the note at
 * reservego-import.ts:230-243.
 */
const IDENTITY_FIELDS = ['name', 'email', 'preferences'] as const;

/* Local mirrors of reservego-import.ts:199-210 and :221-223. Not exported
 * there, and this module may not edit that file. Kept byte-identical in
 * behaviour so a value written by the importer round-trips through the undo. */

function parseJsonArray(text: unknown): string[] {
  if (typeof text !== 'string' || !text) return [];
  try { const v = JSON.parse(text); return Array.isArray(v) ? v.map((x) => String(x)) : []; }
  catch { return []; }
}

function parseJsonObject(text: unknown): Record<string, unknown> {
  if (typeof text !== 'string' || !text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch { return {}; }
}

/** Reservego's free-text Tags → the JSON array ct_guests.tags holds. */
function splitTags(raw: string): string[] {
  return raw.split(/[,;|]/).map((s) => s.trim()).filter(Boolean);
}

/** identity_from, serialised in the importer's FIXED field order. */
function stringifyIdentity(from: Record<string, unknown>): string {
  const out: Record<string, string> = {};
  for (const f of IDENTITY_FIELDS) {
    const v = String(from[f] ?? '');
    if (v) out[f] = v;
  }
  return JSON.stringify(out);
}

/** Counts, in the same shape for the preview and for the finished delete. */
export interface UndoCounts {
  /** ct_bookings rows carrying this import_id. Predicted, then actual. */
  bookings_to_delete: number;
  /** Guests removed: no bookings left at all, import-born, unreferenced. */
  guests_to_delete: number;
  /** Affected guests that still hold other bookings. */
  guests_to_keep: number;
  /**
   * Of the rows going, how many predate this upload — created before it started
   * OR carrying an older export stamp. The honest signal that this undo reaches
   * past the file. See the header for why the stamp half cannot fire alone.
   */
  bookings_from_earlier_imports: number;
  /** The union above, split so neither half can hide behind the other. */
  bookings_created_before_this_import: number;
  bookings_with_older_export_stamp: number;
  /** Affected = to_delete + to_keep + kept_orphan. Nothing falls between. */
  guests_affected: number;
  /** Zero bookings left, but NOT deleted: not import-born, or still linked. */
  guests_kept_orphan: number;
  /** Rows about to go that something else still points at. */
  bookings_linked_elsewhere: number;
  /**
   * Bookings whose is_duplicate moves 1 → 0 because the row that outranked them
   * is being (or was) deleted. Predicted on the preview, actual on the receipt.
   */
  duplicates_recleared: number;
  /**
   * Bookings whose is_duplicate moves 0 → 1. Only possible where the STORED
   * verdict was already stale; the comparator's total order means a pure
   * deletion can otherwise only move flags the other way.
   */
  duplicates_redemoted: number;
  /** Surviving guests whose ct_guests profile fields this undo rewrites. */
  guests_profile_cleared: number;
  /** Individual name/email fields set to '' because no prior value is recoverable. */
  guest_fields_blanked: number;
}

/**
 * Could the "does this row predate the upload?" question be answered at all?
 *
 * 'measured' — a session row with a usable started_at backed the comparison, so
 *   bookings_created_before_this_import / _with_older_export_stamp /
 *   bookings_from_earlier_imports are real numbers.
 * 'unknown'  — there is no session row (orphaned rows), or its started_at is
 *   blank. The three counts above are left at 0 and MEAN NOTHING. A caller that
 *   renders them as measurements is reporting absence of evidence as evidence of
 *   absence, which is the bug this flag exists to make impossible.
 */
export type UndoProvenance = 'measured' | 'unknown';

export interface UndoPreview {
  /** The session row, minus errors_json (which quotes CSV rows verbatim). */
  import: ImportSummary | null;
  counts: UndoCounts;
  /** Plain-English limits. The UI must print these, not summarise them. */
  notice: string[];
  /** False when a DELETE would be refused right now, with the reason why. */
  deletable: boolean;
  blocked_reason: string;
  provenance: UndoProvenance;
}

export interface UndoResult {
  /** False when there was nothing left to undo — the idempotent second call. */
  found: boolean;
  already_deleted: boolean;
  counts: UndoCounts;
  /** ct_guests rows whose lifetime metrics were actually rewritten. */
  guests_refreshed: number;
  /** Whether a reservation_imports row was removed by this call. */
  import_deleted: boolean;
  notice: string[];
  provenance: UndoProvenance;
}

/** The session row as this module hands it out. */
export interface ImportSummary {
  id: string;
  file_name: string;
  started_at: string | null;
  finished_at: string | null;
  status: string;
  rows_total: number;
  rows_processed: number;
  new_bookings: number;
  updated_bookings: number;
  duplicate_rows: number;
  new_customers: number;
  failed_rows: number;
  imported_by: string;
  source_exported_at: string;
}

/**
 * Thrown with the status the route should answer. Mirrors ImportError.
 *
 * `code` is a STABLE machine token for the one refusal the UI can act on. The
 * page arms its Force affordance off `code === 'import_running'` and never off
 * the message text — the message is prose written for a human and will be
 * reworded; a UI keyed to it would silently stop offering the way past a
 * refusal it is still printing.
 */
export class UndoError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status = 400, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * How long after startImport a 'running' session is presumed to be a live
 * upload rather than a crashed one.
 *
 * Deleting a session while the browser is still posting batches leaves those
 * batches writing bookings under an id that Import History no longer lists —
 * invisible rows only a second undo could find. importBatch answers a missing
 * session with 404 (reservego-import.ts:797), so the upload also dies mid-file.
 *
 * Ten minutes against a measured worst case of ~33s of database time for the
 * whole 217,805-row archive at batches of 2,000, plus the browser's own parse
 * and 53 round trips. A crashed import stays 'running' forever and is exactly
 * the kind one wants to undo, so this is a speed bump with a documented
 * override (force), not a lock.
 */
const ACTIVE_WINDOW_MS = 10 * 60 * 1000;

/* ── reads ─────────────────────────────────────────────────────────────────── */

/** Does this database have the table? Link tables are feature-dependent. */
function hasTable(db: DB, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

/**
 * The session row.
 *
 * Read with SELECT * and shaped in JS because reservation_imports is WIDER on a
 * database that has run an import than on one that has not: source_exported_at,
 * stamp_source, skipped_stale, pax_clamped and meal_cutoff are added by the
 * engine's ensureSchema (reservego-import.ts:295-322), which runs at the top of
 * startImport BEFORE the session row is inserted. So the existence of a row here
 * proves those columns exist — which is also why the queries below may compare
 * ct_bookings.source_exported_at without a PRAGMA guard. Naming the columns in a
 * SELECT list would throw on a database where no import has ever run.
 */
function readImport(db: DB, id: string): ImportSummary | null {
  const r = db.prepare(`SELECT * FROM reservation_imports WHERE id = ?`).get(id) as any;
  if (!r) return null;
  return {
    id: String(r.id),
    file_name: String(r.file_name ?? ''),
    started_at: r.started_at ?? null,
    finished_at: r.finished_at ?? null,
    status: String(r.status ?? ''),
    rows_total: Number(r.rows_total ?? 0),
    rows_processed: Number(r.rows_processed ?? 0),
    new_bookings: Number(r.new_bookings ?? 0),
    updated_bookings: Number(r.updated_bookings ?? 0),
    duplicate_rows: Number(r.duplicate_rows ?? 0),
    new_customers: Number(r.new_customers ?? 0),
    failed_rows: Number(r.failed_rows ?? 0),
    imported_by: String(r.imported_by ?? ''),
    source_exported_at: String(r.source_exported_at ?? ''),
  };
}

function countBookings(db: DB, importId: string): number {
  return Number((db.prepare(
    `SELECT COUNT(*) AS n FROM ct_bookings WHERE ${IN_IMPORT}`,
  ).get(importId) as any)?.n ?? 0);
}

/** Distinct guests holding a row in the delete set. */
function affectedGuests(db: DB, importId: string): string[] {
  const rows = db.prepare(
    `SELECT DISTINCT guest_id FROM ct_bookings
      WHERE ${IN_IMPORT} AND COALESCE(guest_id, '') <> ''`,
  ).all(importId) as any[];
  return rows.map((r) => String(r.guest_id));
}

/**
 * How many rows in the delete set predate this upload.
 *
 * created_at is written by the engine as an ISO string and is never rewritten
 * (INSERT_ONLY, reservego-import.ts:685), so `< started_at` — also an ISO string
 * from the same nowIso() — is a straight lexical comparison of two values in one
 * format. A NULL/blank started_at makes that half inert rather than wrong: no
 * non-empty created_at sorts below ''.
 */
function provenanceCounts(db: DB, imp: ImportSummary): {
  older_created: number; older_stamp: number; either: number;
} {
  const startedAt = String(imp.started_at ?? '');
  const stamp = String(imp.source_exported_at ?? '');
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN ? <> '' AND COALESCE(created_at, '') <> '' AND created_at < ?
               THEN 1 ELSE 0 END) AS older_created,
      SUM(CASE WHEN ? <> '' AND COALESCE(source_exported_at, '') <> '' AND source_exported_at < ?
               THEN 1 ELSE 0 END) AS older_stamp,
      SUM(CASE WHEN (? <> '' AND COALESCE(created_at, '') <> '' AND created_at < ?)
                 OR (? <> '' AND COALESCE(source_exported_at, '') <> '' AND source_exported_at < ?)
               THEN 1 ELSE 0 END) AS either
    FROM ct_bookings WHERE ${IN_IMPORT}
  `).get(startedAt, startedAt, stamp, stamp, startedAt, startedAt, stamp, stamp, imp.id) as any;
  return {
    older_created: Number(row?.older_created ?? 0),
    older_stamp: Number(row?.older_stamp ?? 0),
    either: Number(row?.either ?? 0),
  };
}

/** Rows in the delete set that something else still points at. */
function linkedElsewhere(db: DB, importId: string): { total: number; byLabel: Array<[string, number]> } {
  let total = 0;
  const byLabel: Array<[string, number]> = [];
  for (const [table, column, label] of BOOKING_LINK_COLUMNS) {
    if (!hasTable(db, table)) continue;
    // Scoped by import_id through the EXISTS, so it can only ever count links
    // into the delete set — never a link to a phone-CRM booking. The predicate
    // is spelt with the `b.` prefix because it sits inside a correlated
    // subquery: an unqualified import_id would be free to bind to the OUTER
    // table if one ever gained a column of that name.
    const n = Number((db.prepare(`
      SELECT COUNT(*) AS n FROM ${table} t
       WHERE COALESCE(t.${column}, '') <> ''
         AND EXISTS (SELECT 1 FROM ct_bookings b WHERE b.id = t.${column} AND ${inImport('b.')})
    `).get(importId) as any)?.n ?? 0);
    if (n > 0) { total += n; byLabel.push([label, n]); }
  }
  return { total, byLabel };
}

/* ── guest classification ──────────────────────────────────────────────────── */

function* chunk(ids: string[]): Generator<string[]> {
  for (let i = 0; i < ids.length; i += CHUNK) yield ids.slice(i, i + CHUNK);
}

/**
 * Which of these guests would be left holding NO booking once the delete set is
 * gone? Used for the preview only — the delete path asks the database the same
 * question after the fact, with NOT EXISTS, which is the stronger form.
 *
 * A row with import_id NULL falls to ELSE and counts as a survivor, which is the
 * point: a guest with one phone booking keeps their profile.
 */
function guestsLosingEverything(db: DB, importId: string, ids: string[]): Set<string> {
  const out = new Set<string>(ids);
  for (const part of chunk(ids)) {
    const ph = part.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT guest_id AS id, SUM(CASE WHEN ${IN_IMPORT} THEN 0 ELSE 1 END) AS others
        FROM ct_bookings
       WHERE guest_id IN (${ph})
       GROUP BY guest_id
    `).all(importId, ...part) as any[];
    for (const r of rows) if (Number(r.others ?? 0) > 0) out.delete(String(r.id));
  }
  return out;
}

/**
 * Of these guests, which may actually be deleted.
 *
 * `source = 'reservego'` is the load-bearing clause: it is written only by the
 * importer's own INSERT and never rewritten afterwards, so it says "this profile
 * exists because of an import". Every phone-CRM guest fails it on their own
 * stored data. (The manual guests POST does accept a caller-supplied source, so
 * a hand-made row could in principle carry the word — it would still need zero
 * bookings and zero calls, follow-ups, recoveries, topic hits and campaign
 * targets to be reached here.)
 *
 * `requireNoBookings` is true on the delete path, where the question is asked
 * after the rows are gone and NOT EXISTS is the authority.
 */
function deletableGuests(db: DB, ids: string[], requireNoBookings: boolean): string[] {
  if (!ids.length) return [];
  const links = GUEST_LINK_TABLES
    .filter(([t]) => hasTable(db, t))
    .map(([t, c]) => `AND NOT EXISTS (SELECT 1 FROM ${t} x WHERE x.${c} = g.id)`)
    .join('\n         ');
  const noBookings = requireNoBookings
    ? `AND NOT EXISTS (SELECT 1 FROM ct_bookings b WHERE b.guest_id = g.id)`
    : '';
  const out: string[] = [];
  for (const part of chunk(ids)) {
    const ph = part.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT g.id FROM ct_guests g
       WHERE g.id IN (${ph})
         AND g.source = 'reservego'
         ${noBookings}
         ${links}
    `).all(...part) as any[];
    for (const r of rows) out.push(String(r.id));
  }
  return out;
}

/* ── the duplicate verdict, re-decided ─────────────────────────────────────── */

/** One (outlet, phone10, date) group and the phones that can reach it. */
interface DuplicateGroups {
  /** Distinct phone10 values to chunk the row read by. */
  phones: string[];
  /** `${lower(outlet)}|${phone10}|${date}` for every group that loses a row. */
  keySet: Set<string>;
}

/**
 * STEP 0 — the groups that will lose a row, captured BEFORE anything is deleted.
 *
 * It must run before the guest DELETE as well as before the booking DELETE:
 * ct_bookings has NO phone10 column, so the only source of a group's phone
 * number is ct_guests — and a deleted guest's phone10 is exactly what is needed
 * to find the SIBLING guest whose row must be promoted in their place.
 *
 * Two narrowings, both provably move-preserving rather than merely cheaper:
 *   • A group with one row in total cannot elect a different primary once that
 *     row is gone, so `total > 1` drops it. On the owner's archive shape (82,088
 *     bookings over 70,297 guests) most groups are singletons, and this is the
 *     difference between reading essentially the whole table and reading the
 *     handful of guests whose evening actually had two rows in it.
 *   • Rows with no phone10 or no booking_date are unconditional primaries
 *     (reservego.ts:853), so deleting one cannot unseat anybody.
 */
function captureDuplicateGroups(db: DB, importId: string): DuplicateGroups {
  const rows = db.prepare(`
    SELECT LOWER(COALESCE(b.outlet_name, '')) AS outlet,
           COALESCE(g.phone10, '')            AS phone10,
           COALESCE(b.booking_date, '')       AS bdate,
           SUM(CASE WHEN ${inImport('b.')} THEN 1 ELSE 0 END) AS in_set,
           COUNT(*) AS total
      FROM ct_bookings b
      JOIN ct_guests  g ON g.id = b.guest_id
     WHERE COALESCE(b.import_id, '')    <> ''
       AND COALESCE(g.phone10, '')      <> ''
       AND COALESCE(b.booking_date, '') <> ''
     GROUP BY outlet, phone10, bdate
    HAVING in_set > 0 AND total > 1
  `).all(importId) as any[];

  const phones = new Set<string>();
  const keySet = new Set<string>();
  for (const r of rows) {
    const phone = String(r.phone10 ?? '');
    phones.add(phone);
    keySet.add(`${String(r.outlet ?? '')}|${phone}|${String(r.bdate ?? '')}`);
  }
  return { phones: [...phones], keySet };
}

/** A pending is_duplicate write, and who it belongs to. */
interface DuplicateMove { rowId: string; next: number; guestId: string }

/**
 * STEP 2.5 — re-run the verdict over the post-delete row set.
 *
 * `excludeImport` is what makes one function serve both callers: the preview
 * simulates the delete with `AND NOT (import_id = X)` and writes nothing; the
 * undo runs after the DELETE, where the rows are already gone.
 *
 * CHUNKED BY phone10, NEVER BY guest_id. A same-day group spans every guest
 * holding that number (reservego-import.ts:1373-1376); split one across two
 * statements and each half elects its own primary.
 */
function planDuplicateMoves(
  db: DB, importId: string, groups: DuplicateGroups, excludeImport: boolean,
): { moves: DuplicateMove[]; recleared: number; redemoted: number } {
  const moves: DuplicateMove[] = [];
  let recleared = 0, redemoted = 0;
  if (!groups.phones.length) return { moves, recleared, redemoted };

  for (const part of chunk(groups.phones)) {
    const ph = part.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT b.id, b.reservego_key, b.guest_id, b.outlet_name, b.booking_date, b.booking_time,
             b.status, b.seated_at, b.bill_amount, b.is_duplicate, g.phone10
        FROM ct_bookings b
        JOIN ct_guests  g ON g.id = b.guest_id
       WHERE g.phone10 IN (${ph})
         AND COALESCE(b.import_id, '') <> ''
         ${excludeImport ? `AND NOT (${inImport('b.')})` : ''}
    `).all(...(excludeImport ? [...part, importId] : part)) as any[];

    // Only the affected groups are judged. The key is derived from the row, so
    // filtering on it keeps whole groups — never half of one.
    const inGroup = rows.filter((r) => groups.keySet.has(
      `${String(r.outlet_name ?? '').toLowerCase()}|${String(r.phone10 ?? '')}|${String(r.booking_date ?? '')}`,
    ));
    if (!inGroup.length) continue;

    /**
     * THE RANK IS reservego_key, NOT THE ROW ID. markDuplicateGroups breaks its
     * final tie on the id it is handed, and ct_bookings.id is a random UUID — so
     * ranking on it elects a DIFFERENT primary from the one the next import
     * would elect, and undo and re-upload then flip the flag back and forth
     * forever. Mirrors reservego-import.ts:1438 exactly.
     */
    const rank = (r: any) => String(r.reservego_key || r.id);
    const byRank = new Map<string, any>(inGroup.map((r) => [rank(r), r]));
    const stored: StoredBookingRow[] = inGroup.map((r) => ({
      id: rank(r),
      phone10: String(r.phone10 || ''),
      outlet: String(r.outlet_name || ''),
      bookingDate: String(r.booking_date || ''),
      // Derived, never read from the `arrived` column: the ranking must obey the
      // rule as it stands now, not as it stood when the row was written.
      arrived: isArrived(
        (r.status ? String(r.status) : null) as BookingStatus | null,
        r.seated_at ? String(r.seated_at) : '',
      ),
      billAmount: r.bill_amount === null || r.bill_amount === undefined ? null : Number(r.bill_amount),
      bookingTime: String(r.booking_time || ''),
    }));

    const { primaryIds, duplicateIds } = markDuplicateGroups(stored);
    const want = new Map<string, number>();
    for (const key of primaryIds) want.set(key, 0);
    for (const key of duplicateIds) want.set(key, 1);

    for (const [key, next] of want) {
      const r = byRank.get(key);
      if (!r) continue;
      if (Number(r.is_duplicate ?? 0) === next) continue;
      // NOT CLAMPED TO 1 → 0. Promoting the new winner while refusing to demote
      // the old one leaves the group with TWO primaries and double-counts the
      // visit in every metric surface. A 0 → 1 can only arise where the stored
      // verdict was already stale; a pure deletion cannot produce one.
      moves.push({ rowId: String(r.id), next, guestId: String(r.guest_id ?? '') });
      if (next === 0) recleared++; else redemoted++;
    }
  }
  return { moves, recleared, redemoted };
}

/* ── the guest profile, reverted ───────────────────────────────────────────── */

/** One pending ct_guests rewrite. `identityFrom: null` writes SQL NULL. */
interface ProfileWrite {
  id: string;
  name: string;
  email: string;
  tags: string;
  preferences: string;
  identityFrom: string | null;
}

/**
 * What this import wrote onto guests who SURVIVE the delete, and how to take it
 * back out. The owner's ruling: the contact record stays because it existed
 * before this file; the values this file wrote onto it do not.
 *
 * The lever is ct_guests.identity_from — a JSON `{field: booking_time}` map
 * written ONLY by this importer (reservego-import.ts:1140-1147), naming the
 * booking that supplied the current value of each of name / email / preferences.
 * A field with no entry is somebody else's value and is never touched; a field
 * whose entry names a booking that no longer survives is this file's and is.
 *
 * Applies to EVERY survivor, with no special cases — including an import-born
 * guest kept only because a call points at them. Uniformity is what lets the
 * preview and the delete run the identical planner.
 */
function planProfileReverts(
  db: DB,
  importId: string,
  survivors: string[],
  deletedTags: Map<string, Set<string>>,
  excludeImport: boolean,
): { writes: ProfileWrite[]; blanked: number } {
  const writes: ProfileWrite[] = [];
  let blanked = 0;
  // The early return is also the PRAGMA guard for identity_from. That column is
  // added by the engine's ensureSchema (reservego-import.ts:305) at the top of
  // startImport, so a database on which no import has ever run does not have it
  // — the production copy of 2026-08-13 does not. Nothing reaches this function
  // on such a database: `survivors` derives from bookings carrying an import_id,
  // and a row cannot carry one unless startImport ran and added the column. Same
  // argument the header makes for reservation_imports' wide columns.
  if (!survivors.length) return { writes, blanked };

  for (const part of chunk(survivors)) {
    const ph = part.map(() => '?').join(',');

    // The guest's REMAINING reservego rows. In the preview the delete has not
    // happened, so it is simulated; in the undo the rows are already gone.
    const survivingRows = db.prepare(`
      SELECT guest_id, booking_time, preferences, tags
        FROM ct_bookings
       WHERE guest_id IN (${ph})
         AND COALESCE(import_id, '') <> ''
         ${excludeImport ? `AND NOT (${IN_IMPORT})` : ''}
    `).all(...(excludeImport ? [...part, importId] : part)) as any[];

    const times = new Map<string, Set<string>>();
    const prefRows = new Map<string, Array<{ time: string; text: string }>>();
    const keptTags = new Map<string, Set<string>>();
    for (const r of survivingRows) {
      const gid = String(r.guest_id ?? '');
      if (!gid) continue;
      const t = String(r.booking_time ?? '');
      if (t) {
        const s = times.get(gid); if (s) s.add(t); else times.set(gid, new Set([t]));
      }
      const p = String(r.preferences ?? '');
      if (p) {
        const a = prefRows.get(gid); if (a) a.push({ time: t, text: p }); else prefRows.set(gid, [{ time: t, text: p }]);
      }
      for (const tag of splitTags(String(r.tags ?? ''))) {
        const s = keptTags.get(gid); if (s) s.add(tag); else keptTags.set(gid, new Set([tag]));
      }
    }

    const guests = db.prepare(`
      SELECT id, name, email, tags, preferences, identity_from FROM ct_guests WHERE id IN (${ph})
    `).all(...part) as any[];

    for (const g of guests) {
      const gid = String(g.id);
      const survivingTimes = times.get(gid) ?? new Set<string>();
      const from = parseJsonObject(g.identity_from);
      let fromChanged = false;

      const curName = String(g.name ?? '');
      const curEmail = String(g.email ?? '');
      let nextName = curName, nextEmail = curEmail;

      // name / email — BLANKED, never restored. ct_bookings does not carry them
      // and nothing in this schema records what stood there before, so the only
      // two options are "leave this file's value" and "clear it". The owner
      // chose clear, and the notice says so in those words.
      for (const field of ['name', 'email'] as const) {
        const held = String(from[field] ?? '');
        if (!held || survivingTimes.has(held)) continue;
        delete from[field];
        fromChanged = true;
        const cur = field === 'name' ? curName : curEmail;
        if (cur === '') continue;            // already empty: nothing was blanked
        if (field === 'name') nextName = ''; else nextEmail = '';
        blanked++;
      }

      // preferences — RECOMPUTED, not simply dropped: a remaining booking of
      // this guest may still justify a note, and it is the one field where the
      // prior value IS recoverable. Only the namespaced `reservego` key is ever
      // touched; every other key in the object survives untouched.
      const curPrefs = String(g.preferences ?? '');
      let nextPrefs = curPrefs;
      const heldPref = String(from.preferences ?? '');
      if (heldPref && !survivingTimes.has(heldPref)) {
        const prefs = parseJsonObject(g.preferences);
        // Mirrors wins(): the later booking_time takes it, and an exact tie is
        // broken on the value so the answer is a function of the data.
        let winner: { time: string; text: string } | null = null;
        for (const c of prefRows.get(gid) ?? []) {
          if (!winner || c.time > winner.time || (c.time === winner.time && c.text > winner.text)) winner = c;
        }
        if (winner) { prefs.reservego = winner.text; from.preferences = winner.time; }
        else { delete prefs.reservego; delete from.preferences; }
        nextPrefs = JSON.stringify(prefs);
        fromChanged = true;
      }

      // tags — a union on the way in (reservego-import.ts:1174), so the way out
      // is "remove what only the deleted rows supplied". A tag the team had also
      // typed is removed with it: once stored the two are the same text and
      // nothing records who supplied it. Said out loud in the notice.
      const curTags = String(g.tags ?? '');
      let nextTags = curTags;
      const gone = deletedTags.get(gid);
      if (gone && gone.size) {
        const kept = keptTags.get(gid) ?? new Set<string>();
        const set = new Set(parseJsonArray(g.tags));
        let removedAny = false;
        for (const tag of gone) if (!kept.has(tag) && set.delete(tag)) removedAny = true;
        // Only rewritten when a tag actually left. Re-sorting an untouched array
        // would be a write with no change in it, and updated_at is not free.
        if (removedAny) nextTags = JSON.stringify([...set].sort());
      }

      // identity_from — re-serialised only when an entry was dropped, and NULL
      // rather than '{}' when nothing is left: NULL is the pre-import state of a
      // phone-CRM guest, and a guest left pointing at a booking that no longer
      // exists is the residue probe this repair has to pass.
      let nextFrom: string | null = g.identity_from ?? null;
      if (fromChanged) {
        const s = stringifyIdentity(from);
        nextFrom = s === '{}' ? null : s;
      }

      if (
        nextName === curName && nextEmail === curEmail && nextTags === curTags
        && nextPrefs === curPrefs && nextFrom === (g.identity_from ?? null)
      ) continue;
      writes.push({ id: gid, name: nextName, email: nextEmail, tags: nextTags,
                    preferences: nextPrefs, identityFrom: nextFrom });
    }
  }
  return { writes, blanked };
}

/**
 * Tags the delete set supplied, per guest. Captured BEFORE the delete on the
 * undo path; the rows are still there on the preview path.
 *
 * Only `tags` is read of the deleted rows — it is the only column of theirs the
 * revert plan consumes, and the delete set can be 82,000 rows wide.
 */
function tagsFromDeletedRows(db: DB, importId: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const r of db.prepare(`
    SELECT guest_id, tags FROM ct_bookings
     WHERE ${IN_IMPORT} AND COALESCE(guest_id, '') <> '' AND COALESCE(tags, '') <> ''
  `).all(importId) as any[]) {
    const gid = String(r.guest_id);
    const s = out.get(gid) ?? new Set<string>();
    for (const tag of splitTags(String(r.tags ?? ''))) s.add(tag);
    if (s.size) out.set(gid, s);
  }
  return out;
}

/* ── the notice ────────────────────────────────────────────────────────────── */

/**
 * The sentences the owner has to read before pressing the button. Returned as
 * data rather than baked into a page so the preview and the receipt say the
 * same thing, and so a UI cannot show the numbers without the caveat.
 *
 * EVERY CLAIM-BEARING SENTENCE IN THIS FEATURE IS BUILT HERE. The page renders
 * this array in order, verbatim, and authors no prose of its own about what the
 * delete does. That is not tidiness: the shipped build had the server computing
 * the truth and the page printing a different, hardcoded story beside it.
 *
 * `tense` exists because the same sentences are the receipt. A finished delete
 * reading "This removes…" and "…will point at a booking that no longer exists"
 * is a small lie told at the exact moment the owner is checking what happened.
 */
function buildNotice(
  imp: ImportSummary | null,
  counts: UndoCounts,
  links: Array<[string, number]>,
  opts: { tense: 'will' | 'did'; provenance: UndoProvenance; blocked: boolean },
): string[] {
  const did = opts.tense === 'did';
  const T = did
    ? { removes: 'removed', goes: 'went too', stays: 'stayed', beingRemoved: 'that were removed',
        willBe: 'were', have: 'have had', are: 'were', willPoint: 'now point',
        recalculated: 'have been recalculated' }
    : { removes: 'removes', goes: 'goes too', stays: 'stays', beingRemoved: 'being removed',
        willBe: 'will be', have: 'will have', are: 'are', willPoint: 'will point',
        recalculated: 'will be recalculated' };

  const N = counts.bookings_to_delete;
  const out: string[] = [];

  // S1 — what the delete set actually is. An unchanged re-confirmed row is NOT
  // re-stamped: writeBooking takes the bumpStamp path (reservego-import.ts:
  // 1329-1343) and the row keeps the earlier import's id. The old wording said
  // it went too, overstating the delete set in the owner's favour, which is the
  // wrong direction for a warning to be wrong in.
  out.push(
    `This ${T.removes} the booking rows that carry this import’s id. `
    + 'An import re-stamps its id onto every row it inserted or amended, so a booking an earlier '
    + `file created and this one amended counts as this import’s and ${T.goes}. `
    + `A row this file re-confirmed without changing anything keeps the earlier file’s id and ${T.stays}. `
    + 'It is an undo of the last upload, not a rewind of your whole history.',
  );

  // S2 / S3 / S3U — provenance. The measured split is NOT restated here: the two
  // halves are an SQL OR, so a row satisfying both would be counted once in the
  // headline and twice in the parenthesis, and the stamp half is structurally
  // unreachable (see the header). The split has its own tiles, where a 0 reads
  // as "this half did not fire" rather than as a reassurance.
  if (opts.provenance === 'unknown' && N > 0) {
    out.push(
      imp
        ? `This upload’s record has no start time on it — only ${N} booking rows carrying its id. `
          + 'Without a start time there is no way to tell which of them existed beforehand, so treat '
          + 'every one of them as possibly older than this file.'
        : `There is no record of this upload left — only ${N} booking rows still carrying its id. `
          + 'Without the upload’s own row there is no way to tell which of them existed beforehand, so '
          + 'treat every one of them as possibly older than this file. The still-running check is off '
          + 'for the same reason: nothing here can tell whether a browser is still posting batches '
          + 'under this id.',
    );
  } else if (opts.provenance === 'measured' && counts.bookings_from_earlier_imports > 0) {
    out.push(
      `${counts.bookings_from_earlier_imports} of the ${N} bookings ${T.beingRemoved} existed before `
      + 'this upload started. They come back only if you re-upload the file that created them.',
    );
  } else if (opts.provenance === 'measured' && N > 0) {
    out.push(
      `All ${N} bookings ${T.beingRemoved} were created by this upload — nothing older is caught in it.`,
    );
  }

  // S4 — the rows no id can reach.
  out.push(
    'Bookings that carry no import id — everything the phone CRM created — cannot be '
    + 'matched by this delete.',
  );

  // S5 — guests. The refresh covers the orphans as well as the keepers, and the
  // reasons a guest is kept are all five link tables, not the three the earlier
  // wording named.
  const D = counts.guests_to_delete, K = counts.guests_to_keep, O = counts.guests_kept_orphan;
  if (D > 0 || K > 0 || O > 0) {
    out.push(
      `${D} guest profiles created by this import ${T.willBe} removed; ${K} keep other bookings`
      + (O > 0
        ? `; ${O} are left with no bookings but kept, because they came from the phone CRM or still `
          + 'have a call, follow-up, recovery, topic hit or campaign target attached'
        : '')
      + `. Every guest still standing — all ${K + O} of them — ${T.have} their lifetime totals `
      + 'recalculated.',
    );
  }

  // S5b — the profile revert. The owner ruled that data this file wrote onto a
  // pre-existing guest goes with the file, so the panel must say what was taken
  // back out. "Keeps their record" and "untouched" are banned words here.
  if (counts.guests_profile_cleared > 0) {
    let s =
      `${counts.guests_profile_cleared} guest profiles that survive this delete also had the values `
      + 'this upload wrote onto them taken back out: the preference note and the tags this file '
      + 'supplied are cleared, and each profile keeps only what its remaining bookings still justify. '
      + 'A tag is removed even if your team had also typed the same word — once stored, the two are '
      + 'the same text and nothing records which of you supplied it.';
    if (counts.guest_fields_blanked > 0) {
      s += ` For ${counts.guest_fields_blanked} of those fields a name or email this file filled in has `
        + 'been blanked, not restored: this database does not keep the value that was there '
        + 'beforehand, and leaving this upload’s value in place would be pretending it was never '
        + 'imported.';
    }
    s += ' The contact record itself stays — it existed before this file and is not this file’s data '
      + '— and so does the phone number, because it is how every other row in the CRM finds this guest.';
    out.push(s);
  }

  // S6 — dangling links. Reported, never repaired.
  if (links.length) {
    out.push(
      'Still referenced elsewhere: '
      + links.map(([label, n]) => `${n} in ${label}`).join(', ')
      + `. Those links ${T.willPoint} at a booking that no longer exists.`,
    );
  }

  // S8 — the duplicate verdict moved. Without this the owner sees a guest's
  // lifetime totals change for no reason they were told about.
  const R = counts.duplicates_recleared, X = counts.duplicates_redemoted;
  if (R + X > 0) {
    out.push(
      `${R} bookings that were flagged as a same-evening duplicate ${T.are} counted again, because the `
      + `row that outranked them ${T.goes} with this delete`
      + (X > 0 ? `; ${X} others ${T.are} flagged as duplicates instead` : '')
      + `. Their guests’ lifetime totals ${T.recalculated} on the new verdict.`,
    );
  }

  // S7 — the refusal, LAST, and gated on the same predicate as `deletable` and
  // as the 409. The earlier version fired on the raw status, so a crashed import
  // left 'running' for hours — which deletes without force — was told to force.
  if (opts.blocked) {
    out.push(
      'This import is still marked as running and is inside the ten-minute window. If the upload is '
      + 'genuinely finished or dead, delete it with Force; if the browser is still posting batches, '
      + 'let it finish first.',
    );
  }
  return out;
}

function emptyCounts(): UndoCounts {
  return {
    bookings_to_delete: 0,
    guests_to_delete: 0,
    guests_to_keep: 0,
    bookings_from_earlier_imports: 0,
    bookings_created_before_this_import: 0,
    bookings_with_older_export_stamp: 0,
    guests_affected: 0,
    guests_kept_orphan: 0,
    bookings_linked_elsewhere: 0,
    duplicates_recleared: 0,
    duplicates_redemoted: 0,
    guests_profile_cleared: 0,
    guest_fields_blanked: 0,
  };
}

/**
 * Can the provenance question be answered at all? See UndoProvenance.
 *
 * The source_exported_at half cannot rescue a missing started_at: every row
 * still carrying this import's id also carries this import's own stamp (header,
 * :26-36), so that comparison is structurally 0 whatever it is asked.
 */
function provenanceOf(imp: ImportSummary | null): UndoProvenance {
  return imp && String(imp.started_at ?? '') !== '' ? 'measured' : 'unknown';
}

/** Is this session presumed to be a live upload right now? See ACTIVE_WINDOW_MS. */
function looksActive(imp: ImportSummary): boolean {
  if (imp.status !== 'running') return false;
  const started = Date.parse(String(imp.started_at ?? ''));
  if (!Number.isFinite(started)) return true;   // running with no start time → treat as live
  return Date.now() - started < ACTIVE_WINDOW_MS;
}

/* ── preview ───────────────────────────────────────────────────────────────── */

/**
 * Counts only. Writes nothing — no statement below is anything but a SELECT.
 *
 * Returns null when there is nothing by that id: no session row AND no booking
 * still carrying it. An orphaned set of bookings (a session row deleted while
 * batches were still landing) DOES answer, with import: null, because those rows
 * are exactly what a second undo is for and nothing else in the app can see them.
 */
export function previewImportUndo(db: DB, importId: string): UndoPreview | null {
  const id = String(importId ?? '').trim();
  // A blank id is refused here as well as at the route: with it, IN_IMPORT is
  // still unmatchable, but there is no sense in scanning to prove that.
  if (!id) return null;

  const imp = readImport(db, id);
  if (!imp && !hasAnyBooking(db, id)) return null;

  const counts = emptyCounts();
  counts.bookings_to_delete = countBookings(db, id);

  // Gated on `provenance`, not merely on `imp`. A session row with no start time
  // cannot answer the question, and a 0 returned from an unanswerable comparison
  // is the reassurance this repair exists to remove.
  const provenance = provenanceOf(imp);
  if (imp && provenance === 'measured') {
    const p = provenanceCounts(db, imp);
    counts.bookings_created_before_this_import = p.older_created;
    counts.bookings_with_older_export_stamp = p.older_stamp;
    counts.bookings_from_earlier_imports = p.either;
  }

  const affected = affectedGuests(db, id);
  counts.guests_affected = affected.length;
  const losing = [...guestsLosingEverything(db, id, affected)];
  counts.guests_to_keep = affected.length - losing.length;
  const removable = deletableGuests(db, losing, false);
  counts.guests_to_delete = removable.length;
  counts.guests_kept_orphan = losing.length - removable.length;

  const links = linkedElsewhere(db, id);
  counts.bookings_linked_elsewhere = links.total;

  // The two consequences the owner cannot see in the row counts, predicted by
  // the SAME planners the delete runs — over the simulated post-delete set, and
  // still without writing a byte. Every statement in this function is a SELECT.
  const dup = planDuplicateMoves(db, id, captureDuplicateGroups(db, id), true);
  counts.duplicates_recleared = dup.recleared;
  counts.duplicates_redemoted = dup.redemoted;

  const wouldRemove = new Set(removable);
  const survivors = affected.filter((g) => !wouldRemove.has(g));
  const profile = planProfileReverts(db, id, survivors, tagsFromDeletedRows(db, id), true);
  counts.guests_profile_cleared = profile.writes.length;
  counts.guest_fields_blanked = profile.blanked;

  const active = imp ? looksActive(imp) : false;
  return {
    import: imp,
    counts,
    notice: buildNotice(imp, counts, links.byLabel,
      { tense: 'will', provenance, blocked: active }),
    deletable: !active,
    blocked_reason: active
      ? 'This import is still running. Wait for the upload to finish, or force the undo.'
      : '',
    provenance,
  };
}

/** Cheap existence probe, so the preview does not COUNT a table for a bad id. */
function hasAnyBooking(db: DB, importId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM ct_bookings WHERE ${IN_IMPORT} LIMIT 1`).get(importId);
}

/* ── the undo ──────────────────────────────────────────────────────────────── */

/**
 * Perform the undo. ONE transaction: bookings, guests, metrics and the session
 * row commit together.
 *
 * IDEMPOTENT. Nothing by that id — neither a session row nor a booking — returns
 * found: false, already_deleted: true and zeroed counts with a 200, not a throw.
 * That is the answer the second click of a double-click must get, and it is also
 * the truthful answer for an id that never existed: after this call there is no
 * import by that id, which is what a DELETE promises.
 *
 * REFUSES A LIVE UPLOAD unless force is set — see ACTIVE_WINDOW_MS.
 */
export function undoImport(
  db: DB,
  importId: string,
  opts: { force?: boolean; actor?: string } = {},
): UndoResult {
  const id = String(importId ?? '').trim();
  if (!id) throw new UndoError('An import id is required', 400);

  const imp = readImport(db, id);
  const provenance = provenanceOf(imp);
  if (!imp && !hasAnyBooking(db, id)) {
    return {
      found: false,
      already_deleted: true,
      counts: emptyCounts(),
      guests_refreshed: 0,
      import_deleted: false,
      notice: ['There is no import by that id — nothing to undo.'],
      provenance,
    };
  }
  /**
   * THE ONE REFUSAL. `looksActive` — not the raw status — so a crashed import
   * left 'running' for hours deletes without ceremony, and only a session that
   * could plausibly still be posting batches is stopped. Deleting under a live
   * upload leaves its remaining batches writing bookings beneath an id Import
   * History no longer lists, which only a second undo could ever find.
   *
   * The guard is deliberately NOT extended to the orphan case (`imp === null`):
   * with no session row there is nothing to judge liveness by, and inventing a
   * refusal there would block the one case this feature exists for. That gap is
   * disclosed in the notice rather than guessed at.
   */
  if (imp && looksActive(imp) && !opts.force) {
    throw new UndoError(
      'This import is still running. Wait for the upload to finish, or repeat with force.',
      409,
      'import_running',
    );
  }

  const counts = emptyCounts();
  let guestsRefreshed = 0;
  let importDeleted = false;
  let links: Array<[string, number]> = [];
  const at = new Date().toISOString();

  db.transaction(() => {
    // Provenance and links are measured BEFORE the delete — afterwards the rows
    // they describe are gone and the numbers could only be guessed.
    if (imp && provenance === 'measured') {
      const p = provenanceCounts(db, imp);
      counts.bookings_created_before_this_import = p.older_created;
      counts.bookings_with_older_export_stamp = p.older_stamp;
      counts.bookings_from_earlier_imports = p.either;
    }
    const linked = linkedElsewhere(db, id);
    counts.bookings_linked_elsewhere = linked.total;
    links = linked.byLabel;

    // The affected guests must also be collected first: after the delete their
    // rows no longer name them.
    const affected = affectedGuests(db, id);
    counts.guests_affected = affected.length;

    // 0. Everything the later steps need that the DELETEs are about to destroy.
    //    The groups need ct_guests.phone10, which step 2 removes for some of
    //    them; the tags need the deleted rows themselves, which step 1 removes.
    const groups = captureDuplicateGroups(db, id);
    const deletedTags = tagsFromDeletedRows(db, id);

    // 1. The bookings. Scoped by IN_IMPORT, so an unstamped row cannot be hit.
    counts.bookings_to_delete = db.prepare(
      `DELETE FROM ct_bookings WHERE ${IN_IMPORT}`,
    ).run(id).changes;

    // 2. The guests who are now holding nothing — asked of the database in its
    // post-delete state, not predicted from the count taken above.
    const removable = deletableGuests(db, affected, true);
    const removed = new Set<string>();
    if (removable.length) {
      // Every clause of deletableGuests is repeated in the DELETE itself rather
      // than trusted from the SELECT: this statement is the last thing standing
      // between an undo and a real guest's history, and it must not depend on
      // the correctness of the list it was handed.
      const linkClauses = GUEST_LINK_TABLES
        .filter(([t]) => hasTable(db, t))
        .map(([t, c]) => `AND NOT EXISTS (SELECT 1 FROM ${t} x WHERE x.${c} = ct_guests.id)`)
        .join('\n         ');
      const del = db.prepare(`
        DELETE FROM ct_guests
         WHERE id = ?
           AND source = 'reservego'
           AND NOT EXISTS (SELECT 1 FROM ct_bookings b WHERE b.guest_id = ct_guests.id)
           ${linkClauses}
      `);
      // Membership of `removed` comes from .changes, not from the SELECT that
      // proposed the id: if a repeated clause refuses one, that guest is still
      // there and must be refreshed with the survivors rather than forgotten.
      for (const gid of removable) if (del.run(gid).changes > 0) removed.add(gid);
    }
    counts.guests_to_delete = removed.size;

    // 2.5 THE DUPLICATE VERDICT, RE-DECIDED over the post-delete row set.
    //
    // After step 1 so it sees the rows that are actually left, and BEFORE step 3
    // because refreshGuestMetrics filters `is_duplicate = 0` — run it first and
    // the metrics are written off the stale verdict, which is the bug. Inside
    // this transaction, so the reads see the uncommitted DELETE: better-sqlite3
    // is synchronous and single-connection.
    const changedGuests = new Set<string>();
    const dup = planDuplicateMoves(db, id, groups, false);
    if (dup.moves.length) {
      const upd = db.prepare(`UPDATE ct_bookings SET is_duplicate = ? WHERE id = ?`);
      for (const m of dup.moves) {
        upd.run(m.next, m.rowId);           // by row id — the rank is only a key
        if (m.guestId) changedGuests.add(m.guestId);
      }
    }
    counts.duplicates_recleared = dup.recleared;
    counts.duplicates_redemoted = dup.redemoted;

    // 2.6 THE PROFILE REVERT. The owner's ruling: what this file wrote onto a
    // guest who survives goes with the file. Columns are disjoint from the
    // metric columns written in step 3, so the two cannot fight; the order is
    // fixed anyway so that everyone reads the same sequence.
    const survivors = affected.filter((g) => !removed.has(g));
    const profile = planProfileReverts(db, id, survivors, deletedTags, false);
    if (profile.writes.length) {
      // Deliberately NARROWER than the importer's updGuest: no phone10. It is
      // the join key every other CRM row uses to find this guest, and the
      // backfill writes it for guests unrelated to this import.
      const upd = db.prepare(`
        UPDATE ct_guests
           SET name = ?, email = ?, tags = ?, preferences = ?, identity_from = ?, updated_at = ?
         WHERE id = ?
      `);
      for (const w of profile.writes) {
        upd.run(w.name, w.email, w.tags, w.preferences, w.identityFrom, at, w.id);
      }
    }
    counts.guests_profile_cleared = profile.writes.length;
    counts.guest_fields_blanked = profile.blanked;

    // 3. Everyone still standing. Their stored lifetime numbers describe rows
    // that no longer exist until refreshGuestMetrics rewrites them — including
    // the ones now left at zero, which that module writes as zeros rather than
    // leaving yesterday's totals in place.
    //
    // Of the survivors, the ones that still hold a booking. Counted from the
    // database rather than inferred, so the receipt is what happened, and the
    // three buckets add back up to guests_affected.
    counts.guests_to_keep = countGuestsWithBookings(db, survivors);
    counts.guests_kept_orphan = survivors.length - counts.guests_to_keep;
    // WIDENED by the guests whose duplicate flag moved. A sibling sharing a
    // phone10 can hold the promoted row and never appear in `affected`, which
    // only names guests who held a row of THIS import — leave them out and the
    // stale-cache bug simply moves one table over. refreshGuestMetrics
    // de-duplicates its input, so guests_refreshed keeps its meaning.
    guestsRefreshed = refreshGuestMetrics(db, new Set([...survivors, ...changedGuests]));

    // 4. The session row. Deleted, not flagged — see the header.
    if (imp) importDeleted = db.prepare(`DELETE FROM reservation_imports WHERE id = ?`).run(id).changes > 0;
  })();

  // The audit trail the deleted row can no longer be, kept out of the
  // transaction so a logging failure cannot roll back a completed undo.
  console.warn(
    `[reservego-undo] import ${id} (${imp?.file_name || 'orphaned rows'}) undone by `
    + `${opts.actor || 'unknown'}: ${counts.bookings_to_delete} bookings, `
    + `${counts.guests_to_delete} guests deleted, ${guestsRefreshed} guests refreshed`,
  );

  return {
    found: true,
    already_deleted: false,
    counts,
    guests_refreshed: guestsRefreshed,
    import_deleted: importDeleted,
    // Past tense, and `blocked: false`. This delete has happened — telling the
    // owner afterwards to "delete it with Force" would be advice about an
    // import that is already gone, and on a forced undo it would be absurd.
    notice: buildNotice(imp, counts, links, { tense: 'did', provenance, blocked: false }),
    provenance,
  };
}

/** How many of these guests still hold at least one booking. */
function countGuestsWithBookings(db: DB, ids: string[]): number {
  if (!ids.length) return 0;
  let n = 0;
  for (const part of chunk(ids)) {
    const ph = part.map(() => '?').join(',');
    n += Number((db.prepare(`
      SELECT COUNT(DISTINCT guest_id) AS n FROM ct_bookings WHERE guest_id IN (${ph})
    `).get(...part) as any)?.n ?? 0);
  }
  return n;
}
