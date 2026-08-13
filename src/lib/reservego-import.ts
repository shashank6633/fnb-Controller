/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Reservego CSV → ct_guests + ct_bookings: the server side of the import.
 *
 * WHAT LIVES WHERE. Every rule that decides what a row MEANS is in
 * src/lib/reservego.ts and is imported from there, never re-spelt: identity
 * (phone → email → name), the dedupe key, the status map, the same-day
 * duplicate rule, the lifetime metrics. This file is only the part that cannot
 * be pure — resolving a guest against rows already in the database, writing the
 * two tables, and keeping an honest count of what happened. When the Reservego
 * API replaces the CSV, that caller feeds mapped rows to the same functions.
 *
 * WHAT THE REAL FILES LOOK LIKE. Measured over the owner's 129 exports in
 * ~/Downloads (BookingsService_*.zip), 2026-08-13: 45 MB of CSV, 217,805 rows,
 * 0 of which fail to map, carrying 85,558 distinct bookings for 70,315 distinct
 * guests. The exports overlap heavily — a booking appears in 2.5 files on
 * average — which is why the whole design is built around an idempotent key
 * rather than an append.
 *
 * WHY IT IS BATCHED. A 45 MB request body is the constraint; SQLite is not.
 * Measured on this machine (better-sqlite3, WAL, all 129 exports replayed into
 * a copy of production): the whole 217,805-row load costs ~33s of database time
 * at batches of 2,000 and ~37s at batches of 500, against 1.3s of CSV parsing —
 * which the BROWSER does, not this process. So the browser parses and posts
 * batches, and each batch here is ONE transaction with its statements prepared
 * once outside the row loop; both of those are load-bearing.
 *
 * A re-run of the same 129 files takes ~15s and is NOT quite a no-op. Measured
 * on the loaded archive: 130,264 rows are refused by the export-recency guard
 * (they come from an export older than the one that last wrote the row — this
 * is the mechanism working, not an error), and 3,758 rows are rewritten with
 * the value they already hold. Those 3,758 are the WITHIN-FILE repeats: 5,246
 * rows across 102 of the 129 files share a booking key with an earlier row in
 * the SAME file and 4,278 of them say something different, so the second one
 * overwrites the first on every pass. File order is fixed, so the last one
 * always wins and the end state never moves — verified by snapshotting every
 * column of all 85,558 bookings before and after a second full pass: 3,758
 * writes, ZERO stored values changed. That is what idempotent means here.
 *
 * WHAT SURVIVES A BAD ROW. One unreadable row in 217,805 must never cost the
 * other 217,804, so a row that fails to map is collected as {row, error} and
 * the batch carries on; a row that fails to WRITE is caught individually inside
 * the transaction for the same reason. Both land in reservation_imports. (The
 * owner's 129 files currently produce zero of either.)
 *
 * ── THE ONE RULE THIS FILE MUST NOT BREAK ─────────────────────────────────
 * Batching is an HTTP detail and must never change the result. Every mapped row
 * is written and keeps its own key; nothing is dropped or merged while a batch
 * is in flight. The same-day duplicate verdict is taken ONCE, at finishImport,
 * over the affected guests' whole stored history (markDuplicateGroups), so the
 * final is_duplicate set is identical whether the file arrived in one batch of
 * 217,805 or in 436 batches of 500.
 *
 * Verified, not asserted: all 129 exports replayed into two separate copies of
 * production, one at batch 500 and one at batch 2,000. Both end with the same
 * 85,558 bookings, the same 3,576 rows flagged is_duplicate, the same 70,342
 * guests and the same guest metrics — compared by hashing both sets, not by
 * spot check — and with the 40 phone bookings that were already there
 * untouched. A third pass at batch 777 over one of them changed nothing.
 *
 * THREE things had to be fixed before that held, and each is one careless edit
 * away from coming back. All three were a value that varied with WHEN a row was
 * processed rather than with WHAT it said: see backfillGuestPhone10 (a phone
 * mined out of an 'email:' placeholder), markImportDuplicates (a random UUID
 * used as the tiebreak that picks the surviving row), and buildPhonelessIndex
 * (a lookup patched in memory instead of re-read from the table).
 *
 * ── AND THE FOURTH: FILE ORDER ─────────────────────────────────────────────
 * Batch size stopped mattering; the ORDER THE 129 FILES ARE UPLOADED IN did
 * not. Every export is a snapshot of the same history, so one booking appears
 * in several files with different content — Confirmed in January, Cancelled in
 * July — and the engine simply applied whichever arrived last. Measured, all
 * 129 real files, chronological upload versus reverse: 7,563 bookings end on a
 * different status, 5,335 on a different arrived, 10,155 even on a different
 * spelling of the outlet name, and 7,996 guest profiles differ. Uploading the
 * archive after the recent files walked thousands of bookings BACKWARDS.
 *
 * The fix is that every import now carries WHEN ITS EXPORT WAS TAKEN
 * (source_exported_at, read off the Reservego file name — see
 * exportStampFromFileName), the stamp travels onto every booking and guest row
 * it writes, and a row is never overwritten by data from an OLDER export. Those
 * rows are counted as skipped_stale, not silently dropped. Upload order is now
 * a property of the owner's file picker and nothing else: verified by replaying
 * all 129 exports chronologically and in reverse into two copies of production
 * and hashing both tables — identical.
 */
import type Database from 'better-sqlite3';
import {
  BAND_LEAD_IN_KEY,
  computeGuestMetrics,
  dedupeKeyFor,
  exportStampFromFileName,
  isArrived,
  mapRow,
  markDuplicateGroups,
  mealPeriodFor,
  MEAL_CUTOFF_KEY,
  normalizeCutoff,
  normalizeExportStamp,
  normalizeLeadIn,
  phone10,
  pickBandForSlot,
  type BandEvent,
  type BookingStatus,
  type MappedBooking,
  type ReservegoRow,
  type StoredBookingRow,
} from '@/lib/reservego';
import { normalizePhone } from '@/lib/ct/phone';

type DB = Database.Database;

/** One rejected row, as the owner reads it in Import History. */
export interface RowError { row: number; error: string }

/**
 * errors_json keeps the first few hundred rejections, not a second copy of the
 * file. failed_rows stays exact regardless — the count is the alarm, the list
 * is only there to show what KIND of row is failing.
 */
export const MAX_STORED_ERRORS = 200;

/** Where an import's source_exported_at came from. Shown in Import History so
 *  an undated file is visible as such rather than silently trusted. */
export type StampSource = 'filename' | 'file-max-booking-time' | 'none';

export interface ImportRow {
  id: string;
  file_name: string;
  started_at: string | null;
  finished_at: string | null;
  status: 'running' | 'completed' | 'failed';
  rows_total: number;
  rows_processed: number;
  new_bookings: number;
  updated_bookings: number;
  duplicate_rows: number;
  collapsed_rows: number;
  new_customers: number;
  updated_customers: number;
  failed_rows: number;
  /** Rows refused because the stored booking came from a NEWER export. */
  skipped_stale: number;
  /** Rows whose Pax exceeded PAX_MAX and was cut down to it. */
  pax_clamped: number;
  /** When this export was taken, 'YYYY-MM-DD HH:MM:SS', or '' if undatable. */
  source_exported_at: string;
  stamp_source: StampSource;
  /** The lunch/dinner boundary this file was derived with, pinned at start —
   *  see startImport. Blank on sessions that predate the column. */
  meal_cutoff: string;
  errors_json: string;
  imported_by: string;
  created_at: string;
}

/**
 * What ONE batch did. There is deliberately no collapsed_rows here: a batch
 * cannot know whether a row is a same-day duplicate, because the row it loses
 * to may be in another batch, in another file, or already in the table. That
 * verdict is settled once at finishImport and reported on the session row.
 */
export interface BatchTally {
  rows: number;
  new_bookings: number;
  updated_bookings: number;
  duplicate_rows: number;
  new_customers: number;
  failed_rows: number;
  /** Bookings this batch left alone because the stored row came from a newer
   *  export. Reported, never silent: "the file changed nothing" and "the file
   *  was older than what you already had" are different answers. */
  skipped_stale: number;
  pax_clamped: number;
  errors: RowError[];
}

export interface BatchOutcome { summary: ImportRow; batch: BatchTally }

/** Carries the HTTP status the route should answer with. */
export class ImportError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

/* ── small helpers ─────────────────────────────────────────────────────────── */

const nowIso = () => new Date().toISOString();

/**
 * Column-value equality for the "did this row actually change?" test.
 * Everything is compared in its text form because that is what SQLite hands
 * back: a REAL 500 reads as the number 500, a NULL as null, and an untouched
 * TEXT column as ''. Normalising both sides the same way is what stops a
 * re-import of identical files from reporting 217,805 phantom updates.
 */
const norm = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

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

/**
 * Reservego's free-text Tags → the JSON array ct_guests.tags already holds.
 * Split only on separators that are unambiguous (, ; |). Splitting on spaces
 * would turn the real value "Low Music" into two meaningless tags, so a value
 * with no separator is kept whole even when it reads like several.
 *
 * Used ONLY for a guest profile this importer created. See updateGuestFields.
 */
function splitTags(raw: string): string[] {
  return raw.split(/[,;|]/).map((s) => s.trim()).filter(Boolean);
}

/** The ct_guests fields whose provenance identity_from records, in the order it
 *  serialises them. See stringifyIdentity and updateGuestFields. */
const IDENTITY_FIELDS = ['name', 'email', 'preferences'] as const;

/**
 * identity_from, serialised in a FIXED field order.
 *
 * JSON.stringify writes an object's keys in insertion order, so a profile whose
 * email was recorded before its preferences produced a different STRING from
 * the identical profile built the other way round — and the two are compared as
 * strings, both by the no-op check in updateGuestFields and by anyone diffing
 * two databases. Caught by the acceptance test: 68 of 70,342 guests differed
 * between a chronological upload and a reverse one on nothing but key order,
 * with every value the same. Serialising through the field list makes the text
 * a function of the content.
 *
 * Module scope, not inside importBatch: it is called from resolveGuest, which
 * runs inside the batch transaction — and a `const` declared further down that
 * function body would still be in its temporal dead zone at that point.
 */
function stringifyIdentity(from: Record<string, unknown>): string {
  const out: Record<string, string> = {};
  for (const f of IDENTITY_FIELDS) {
    const v = String(from[f] ?? '');
    if (v) out[f] = v;
  }
  return JSON.stringify(out);
}

/**
 * What goes in ct_bookings.status when mapStatus() cannot place the raw string.
 *
 * NOT '' — that was the bug. The bookings API only accepts the six-value
 * vocabulary as a ?status= filter, so a row stored with '' is invisible to
 * every filter on the screen and can only be found by scrolling. Measured in
 * the owner's 129 exports: one unrecognised value, "Unconfirmed", on 314 rows /
 * 28 distinct bookings — a small number of real bookings that would simply have
 * disappeared from the board.
 *
 * 'pending' is the honest placeholder: it is the column's own default, and
 * against isArrived() / computeGuestMetrics it behaves exactly as '' did — it
 * counts as a booking, and as neither an arrival, a cancellation nor a no-show.
 * The raw string is kept verbatim in reservego_status, which is where anyone
 * asking "what did Reservego actually say?" should look.
 */
const UNMAPPED_STATUS: BookingStatus = 'pending';

/* ── schema guard ──────────────────────────────────────────────────────────── */

/** Connections already checked, so the PRAGMAs run once per process. */
const SCHEMA_READY = new WeakSet<object>();

/**
 * The columns this engine cannot run without, asserted additively.
 *
 * OWNERSHIP NOTE. All of this DDL belongs in the migration block in db.ts
 * alongside the other Reservego columns and should be hoisted there; the exact
 * statements are listed in the handover note at the bottom of this file. It is
 * asserted here because the engine cannot behave correctly against a narrower
 * table: an import would throw halfway through an upload and leave a session
 * 'running' forever, or — worse for source_exported_at — appear to work while
 * silently losing the recency guard that stops an old export reverting 5,335
 * bookings. Every ALTER is guarded by PRAGMA table_info, so each becomes a
 * no-op the moment db.ts adopts it.
 *
 * NOT here: the ct_bookings.arrived generated column. That one needs a DROP
 * COLUMN and a table rewrite, which is a migration, not something an import
 * engine may do to a live database mid-upload. This file DETECTS which form the
 * column is in and writes accordingly — see arrivedIsStoredColumn.
 */
function ensureSchema(db: DB): void {
  if (SCHEMA_READY.has(db)) return;
  const add = (table: string, col: string, decl: string) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
    if (!cols.some((c: any) => c.name === col)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
    }
  };
  add('ct_bookings', 'is_duplicate', `INTEGER NOT NULL DEFAULT 0`);
  add('ct_bookings', 'source_exported_at', `TEXT`);
  add('ct_guests', 'identity_from', `TEXT`);
  add('reservation_imports', 'source_exported_at', `TEXT`);
  add('reservation_imports', 'stamp_source', `TEXT NOT NULL DEFAULT 'none'`);
  add('reservation_imports', 'skipped_stale', `INTEGER NOT NULL DEFAULT 0`);
  add('reservation_imports', 'pax_clamped', `INTEGER NOT NULL DEFAULT 0`);
  // The derived set (db.ts § A3 owns these too). Declared identically here so
  // the upsert cannot be prepared against a table that lacks them: SQLite would
  // fail on "no such column" mid-upload, after the session row exists.
  add('ct_bookings', 'reserved_date', `TEXT`);
  add('ct_bookings', 'day_of_week', `TEXT`);
  add('ct_bookings', 'dow', `INTEGER`);
  add('ct_bookings', 'meal_period', `TEXT`);
  add('ct_bookings', 'live_band', `TEXT`);
  add('ct_bookings', 'live_band_id', `TEXT`);
  add('ct_bookings', 'reservego_visit_count', `INTEGER`);
  add('reservation_imports', 'meal_cutoff', `TEXT`);
  SCHEMA_READY.add(db);
}

/* ── the two house rules this engine reads, never hardcodes ────────────────── */

/** A row of the app-wide `settings` table, or '' — where db.ts seeds both
 *  reservation_meal_cutoff and reservation_band_lead_in_minutes. */
function appSetting(db: DB, key: string): string {
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as any;
    return String(row?.value ?? '');
  } catch { return ''; }  // no settings table (a bare test db) → the defaults
}

/**
 * Is `type` a band on this calendar row? ct_entertainment.type is free-ish text
 * ('band' | 'dj' | 'live_music' | …) and only 'band' feeds live_band, per the
 * column's own definition. Matched case-insensitively because the calendar UI
 * and any future import both write it by hand.
 */
const BAND_TYPE = 'band';

/**
 * date → the acts scheduled that night, resolved to ct_bands ids where the
 * master row exists.
 *
 * ONE QUERY PER RANGE, NOT PER BOOKING. An import touching 2,000 rows spans a
 * handful of dates; a per-row lookup would run 2,000 statements to answer the
 * same dozen questions. ct_bands is joined by NAME because ct_entertainment has
 * no band_id column — the name is what the manager typed on the calendar, and
 * ct_bands.name is UNIQUE COLLATE NOCASE, which is exactly what makes 'Agnee'
 * and 'AGNEE' resolve to one id.
 *
 * A name with no master row keeps live_band (the spelling on the night) and
 * gets live_band_id ''. Nothing is inserted into ct_bands from here: the band
 * master is the owner's list, and a typo on one night must not silently become
 * a band. relinkBands() is the tool that fills the ids in afterwards.
 */
function loadBandCalendar(db: DB, from: string, to: string): Map<string, BandEvent[]> {
  const out = new Map<string, BandEvent[]>();
  const sql = (withMaster: boolean) => `
      SELECT e.id, e.event_date, e.name, e.start_time,
             ${withMaster ? `(SELECT b.id FROM ct_bands b WHERE b.name = e.name COLLATE NOCASE)` : `''`} AS band_id
        FROM ct_entertainment e
       WHERE LOWER(TRIM(e.type)) = ? AND e.event_date BETWEEN ? AND ?`;
  let rows: any[] = [];
  try {
    rows = db.prepare(sql(true)).all(BAND_TYPE, from, to) as any[];
  } catch {
    // NO ct_bands YET IS NOT "NO BANDS". Measured on a copy of production
    // (2026-08-13): the live database has ct_entertainment but not ct_bands,
    // which db.ts creates on the next boot — and with the two folded into one
    // statement, "no such table: ct_bands" threw away the CALENDAR too, so
    // live_band stayed empty on every row and the band report read as though
    // nobody had ever played. The name does not need the master table; only the
    // id does. So retry without the join and let live_band_id stay ''.
    try { rows = db.prepare(sql(false)).all(BAND_TYPE, from, to) as any[]; }
    catch { return out; }  // no calendar table either → no bands, never a throw
  }
  for (const r of rows) {
    const date = String(r.event_date || '');
    if (!date) continue;
    const list = out.get(date) || [];
    list.push({
      id: String(r.id || ''),
      name: String(r.name || '').trim(),
      startTime: String(r.start_time || ''),
      bandId: String(r.band_id || ''),
    });
    out.set(date, list);
  }
  return out;
}

/** Connections whose `arrived` shape has been read, with the answer. */
const ARRIVED_SHAPE = new WeakMap<object, boolean>();

/**
 * Is ct_bookings.arrived a column this engine must WRITE, or one the database
 * derives for itself?
 *
 * The intended end state is a VIRTUAL generated column over
 * (status, seated_at) — reservego.ts ARRIVED_SQL — because `arrived` had four
 * writers and three of them never maintained it, so a guest seated from the
 * Seat board read "Arrived: No" until the next import. A generated column
 * cannot be written at all: `UPDATE … SET arrived = 1` fails with "cannot
 * UPDATE generated column", which is the point — the staleness becomes
 * unrepresentable rather than merely discouraged.
 *
 * This engine has to work on both sides of that migration, so it asks. PRAGMA
 * table_xinfo reports hidden = 2 for a VIRTUAL generated column and 3 for a
 * STORED one; a plain column reports 0 and must still be written by hand.
 * Cached per connection: the answer can only change under a migration, and a
 * migration restarts the process.
 */
function arrivedIsStoredColumn(db: DB): boolean {
  const cached = ARRIVED_SHAPE.get(db);
  if (cached !== undefined) return cached;
  const col = (db.prepare(`PRAGMA table_xinfo(ct_bookings)`).all() as any[])
    .find((c: any) => c.name === 'arrived');
  // No column at all → nothing to write. Generated (hidden 2 or 3) → must not
  // be written. Anything else → this engine still owns it.
  const stored = !!col && Number(col.hidden ?? 0) !== 2 && Number(col.hidden ?? 0) !== 3;
  ARRIVED_SHAPE.set(db, stored);
  return stored;
}

/**
 * Run `fn` with a TEMP table holding the guest ids to work on.
 *
 * WHY A TEMP TABLE AND NOT `id IN (…)`. The first import targets all 70,315
 * guests; a literal IN list of that size cannot be prepared (SQLITE_MAX_VARIABLE
 * _NUMBER), and chunking it turns one grouped scan into hundreds of partial
 * ones that then have to be stitched back together in JS. A temp table with a
 * PRIMARY KEY lets the planner choose — probe the small set while scanning
 * bookings, or drive from it — and keeps the metric rollup a single ordered
 * pass whether it is refreshing 3 guests or 70,315.
 *
 * The name carries a UUID because it is per-call, not per-connection: the app
 * holds ONE long-lived better-sqlite3 connection, so a fixed name would let two
 * overlapping finishes silently share (and truncate) each other's target list.
 * The suffix is generated here from randomUUID and stripped to hex, so nothing
 * user-supplied ever reaches the SQL text.
 */
function withTargetTable<T>(db: DB, ids: Iterable<string>, fn: (table: string) => T): T {
  const table = `_resv_targets_${crypto.randomUUID().replace(/-/g, '')}`;
  db.exec(`CREATE TEMP TABLE ${table} (id TEXT PRIMARY KEY)`);
  try {
    const ins = db.prepare(`INSERT OR IGNORE INTO ${table} (id) VALUES (?)`);
    db.transaction((list: string[]) => { for (const id of list) ins.run(id); })([...ids]);
    return fn(table);
  } finally {
    db.exec(`DROP TABLE IF EXISTS temp.${table}`);
  }
}

/* ── the import session ────────────────────────────────────────────────────── */

export function getImport(db: DB, id: string): ImportRow | null {
  const row = db.prepare(`SELECT * FROM reservation_imports WHERE id = ?`).get(id) as any;
  return (row as ImportRow) || null;
}

/**
 * Give every existing guest the last-10-digit key the import joins on.
 *
 * The migration in db.ts deliberately backfills nothing — it only widens the
 * tables. But ct_guests.phone10 IS the join key: a guest whose phone10 is still
 * NULL cannot be found by an incoming row, so the import would create a SECOND
 * profile for a person the CRM already knows, which is precisely the outcome
 * this whole exercise exists to prevent. So the key is filled in once, from the
 * phone_e164 already stored, before the first batch can look anything up.
 *
 * It stays cheap forever: the WHERE matches only rows that lack the key, which
 * after the first run is just whatever other writers (guest-autosave) created
 * since. Runs at import START, not at boot — a migration that rewrote guest
 * rows on every restart is not something a deploy should do.
 *
 * ── IT MUST NOT MINE A PHONE OUT OF A PLACEHOLDER ─────────────────────────
 * A guest with no phone is stored with phone_e164 = 'email:<addr>' or
 * 'name:<name>', and phone10() only strips non-digits: it read
 * 'email:mohammedkaleem8686460485@gmail.com' as the phone 8686460485. Caught in
 * the full replay — one guest in 70,315, and the damage was out of all
 * proportion. The invented number put an email-identified guest into a real
 * customer's same-day group, made them findable by selGuestByPhone10 (so a
 * genuine phone row could have landed on the wrong profile — exactly the merge
 * this design forbids), and re-keyed their later bookings under phone:… , which
 * minted a second copy of a booking that already existed. Only a value that is
 * actually shaped like a dialable number is mined.
 */
const PHONE_SHAPED = /^\+?\d[\d\s()-]*$/;

export function backfillGuestPhone10(db: DB): number {
  const rows = db.prepare(
    `SELECT id, phone_e164 FROM ct_guests
      WHERE COALESCE(phone10, '') = '' AND COALESCE(phone_e164, '') <> ''
        AND phone_e164 NOT LIKE 'email:%' AND phone_e164 NOT LIKE 'name:%'`,
  ).all() as any[];
  if (!rows.length) return 0;
  const upd = db.prepare(`UPDATE ct_guests SET phone10 = ? WHERE id = ?`);
  return db.transaction((rs: any[]) => {
    let n = 0;
    for (const r of rs) {
      if (!PHONE_SHAPED.test(String(r.phone_e164 || ''))) continue;
      const p = phone10(r.phone_e164);
      if (p) { upd.run(p, r.id); n++; }
    }
    return n;
  })(rows);
}

/**
 * THE STAMP LADDER — how an upload learns when its export was taken.
 *
 *   1. THE FILE NAME. BookingsService_DD-MM-YYYY_HH-MM-SS_… is Reservego's own
 *      naming and is the moment the export was generated, which is exactly the
 *      question. It covers 129 of the owner's 129 real files — measured, not
 *      assumed — so in practice this is the only rung that runs.
 *   2. THE FILE'S LARGEST Booking Time, supplied by the caller. The browser
 *      already reads the whole file once to count rows before a session exists
 *      (see the two-pass note in /crm-calls/database), so it costs a running
 *      max and nothing else. It is a weaker proxy — an export is at least as
 *      new as the newest booking in it — but it orders a set of renamed files
 *      correctly, which is what the guard needs.
 *   3. NOTHING. The import is recorded as undated (stamp_source 'none') and the
 *      recency guard cannot judge it: its rows are written, and they carry no
 *      stamp of their own, so they neither override a dated row's provenance
 *      nor pretend to one. Import History shows the file as undated, which is
 *      the prompt to rename it.
 *
 * WHY THE STAMP IS FIXED HERE AND NEVER RAISED MID-UPLOAD. It has to be a
 * property of the FILE, decided before the first row is written. A stamp that
 * grew as batches arrived — "the largest Booking Time seen so far" — would make
 * the skip/write verdict depend on where the file happened to be cut, which is
 * precisely the class of bug (a result that varies with batching) this engine
 * was rewritten to eliminate.
 */
export function startImport(
  db: DB,
  opts: { fileName: string; rowsTotal: number; importedBy: string; sourceExportedAt?: string },
): ImportRow {
  ensureSchema(db);
  backfillGuestPhone10(db);

  const fromName = exportStampFromFileName(opts.fileName);
  const fromCaller = normalizeExportStamp(opts.sourceExportedAt);
  const stamp = fromName || fromCaller || '';
  const stampSource: StampSource =
    fromName ? 'filename' : fromCaller ? 'file-max-booking-time' : 'none';

  // THE MEAL CUTOFF IS PINNED HERE, for the same reason the export stamp is:
  // it must be a property of the FILE, read once, or an owner who edits the
  // setting mid-upload splits one file into a lunch half and a dinner half and
  // the answer starts depending on where the browser cut the batches — the one
  // class of bug this engine exists free of. Re-deriving after a change is a
  // re-import, which is cheap and which the recency guard lets through
  // (equal stamps pass).
  const cutoff = normalizeCutoff(appSetting(db, MEAL_CUTOFF_KEY));

  const id = crypto.randomUUID();
  const at = nowIso();
  db.prepare(`
    INSERT INTO reservation_imports
      (id, file_name, started_at, status, rows_total, errors_json, imported_by, created_at,
       source_exported_at, stamp_source, meal_cutoff)
    VALUES (?, ?, ?, 'running', ?, '[]', ?, ?, ?, ?, ?)
  `).run(id, opts.fileName, at, Math.max(0, Math.round(opts.rowsTotal || 0)), opts.importedBy, at,
         stamp, stampSource, cutoff);
  return getImport(db, id) as ImportRow;
}

export function failImport(db: DB, id: string, reason: string): ImportRow | null {
  const imp = getImport(db, id);
  if (!imp) return null;
  db.prepare(`UPDATE reservation_imports SET status = 'failed', finished_at = ? WHERE id = ?`)
    .run(nowIso(), id);
  appendErrors(db, id, [{ row: 0, error: reason }], 0);
  return getImport(db, id);
}

/** Append to errors_json under the cap. `alreadyFailed` is the pre-existing count. */
function appendErrors(db: DB, importId: string, errors: RowError[], alreadyFailed: number): void {
  if (!errors.length) return;
  const room = MAX_STORED_ERRORS - Math.min(alreadyFailed, MAX_STORED_ERRORS);
  if (room <= 0) return;
  const row = db.prepare(`SELECT errors_json FROM reservation_imports WHERE id = ?`).get(importId) as any;
  const kept = [...parseStoredErrors(row?.errors_json), ...errors.slice(0, room)].slice(0, MAX_STORED_ERRORS);
  db.prepare(`UPDATE reservation_imports SET errors_json = ? WHERE id = ?`)
    .run(JSON.stringify(kept), importId);
}

function parseStoredErrors(text: unknown): RowError[] {
  if (typeof text !== 'string' || !text) return [];
  try { const v = JSON.parse(text); return Array.isArray(v) ? v : []; } catch { return []; }
}

/* ── the batch ─────────────────────────────────────────────────────────────── */

/** The ct_bookings columns this engine owns, plus the row identity. */
interface BookingValues {
  id: string;
  guest_id: string;
  booking_date: string;
  slot_time: string;
  party_size: number;
  status: string;
  created_by: string;
  channel: string;
  seated_at: string | null;
  created_at: string;
  updated_at: string;
  reservego_key: string;
  reservego_status: string;
  booking_time: string;
  reserved_time: string;
  booking_type: string;
  outlet_name: string;
  pax_breakdown: string;
  reserved_by: string;
  sections: string;
  tables_csv: string;
  source: string;
  preferences: string;
  tags: string;
  guest_comments: string;
  outlet_comments: string;
  deletion_type: string;
  deletion_reason: string;
  bill_amount: number | null;
  bill_number: string;
  booking_amount: number | null;
  booking_txn_id: string;
  booking_payment_status: string;
  booking_payment_date: string;
  /** Absent when the database derives it — see arrivedIsStoredColumn. */
  arrived?: number;
  source_exported_at: string;
  import_id: string;
  /* ── the derived night (db.ts § A3) ────────────────────────────────────── */
  reserved_date: string;
  day_of_week: string;
  dow: number | null;
  meal_period: string;
  live_band: string;
  live_band_id: string;
  reservego_visit_count: number | null;
}

/**
 * Every column an existing row is compared on. `id`, `created_at`,
 * `created_by` and `channel` are absent on purpose: they are the row's
 * provenance, they are never rewritten by a later export, and comparing them
 * would report an update that did not happen. `import_id` is absent for the
 * same reason in reverse — it changes on EVERY upload, so comparing it would
 * report all 217,805 rows as updated every time.
 *
 * `source_exported_at` is absent too, and for a third reason: it is not a
 * statement about the booking but about which file last spoke for it, it moves
 * on its own monotone rule inside the upsert, and comparing it would report a
 * data change every time a newer export merely CONFIRMED an unchanged row.
 *
 * `arrived` is appended only when it is a stored column. Once it is generated
 * from status and seated_at — both of which ARE compared — it cannot differ
 * when they agree, so comparing it would add a column and no information.
 */
const COMPARED_BASE: Array<keyof BookingValues> = [
  'guest_id', 'booking_date', 'slot_time', 'party_size', 'status', 'seated_at',
  'reservego_status', 'booking_time', 'reserved_time', 'booking_type', 'outlet_name',
  'pax_breakdown', 'reserved_by', 'sections', 'tables_csv', 'source', 'preferences', 'tags',
  'guest_comments', 'outlet_comments', 'deletion_type', 'deletion_reason',
  'bill_amount', 'bill_number', 'booking_amount', 'booking_txn_id',
  'booking_payment_status', 'booking_payment_date',
  // The derived night is compared so that a row stored before these columns
  // existed — all 85,558 of them — is rewritten by the first export that speaks
  // for it again, instead of being reported unchanged and left NULL forever.
  // It is also what makes a cutoff change visible: re-import and the rows whose
  // meal_period moved come back as updated_bookings.
  'reserved_date', 'day_of_week', 'dow', 'meal_period', 'reservego_visit_count',
  // live_band / live_band_id are deliberately NOT here — see buildUpsertSql.
];

/** Written on the INSERT but never rewritten by a later export: the row's own
 *  provenance. An order can already be linked to a booking through
 *  orders.booking_id, so the row keeps the identity it was inserted with. */
const INSERT_ONLY = new Set(['id', 'created_at', 'created_by', 'channel', 'source_exported_at']);

/** The columns the upsert names, in order. `arrived` is appended only when the
 *  database does not derive it — see arrivedIsStoredColumn. */
function bookingColumns(arrivedIsStored: boolean): Array<keyof BookingValues> {
  const cols: Array<keyof BookingValues> = [
    'id', 'guest_id', 'booking_date', 'slot_time', 'party_size', 'status', 'created_by', 'channel',
    'seated_at', 'created_at', 'updated_at', 'reservego_key', 'reservego_status', 'booking_time',
    'reserved_time', 'booking_type', 'outlet_name', 'pax_breakdown', 'reserved_by', 'sections',
    'tables_csv', 'source', 'preferences', 'tags', 'guest_comments', 'outlet_comments',
    'deletion_type', 'deletion_reason', 'bill_amount', 'bill_number', 'booking_amount',
    'booking_txn_id', 'booking_payment_status', 'booking_payment_date', 'source_exported_at',
    'import_id',
    'reserved_date', 'day_of_week', 'dow', 'meal_period', 'live_band', 'live_band_id',
    'reservego_visit_count',
  ];
  if (arrivedIsStored) cols.push('arrived');
  return cols;
}

/** live_band / live_band_id do not follow the plain `= excluded.x` rule — see
 *  buildUpsertSql. Named once so the SET builder and the reader agree. */
const BAND_COLS = new Set(['live_band', 'live_band_id']);

/**
 * WHY THE UPSERT NAMES THE PARTIAL INDEX' PREDICATE. idx_ct_bookings_resv_key
 * is UNIQUE … WHERE reservego_key IS NOT NULL, and SQLite only resolves a
 * conflict target to a partial index when the statement repeats that predicate.
 * Without the WHERE this INSERT would raise "ON CONFLICT clause does not match
 * any PRIMARY KEY or UNIQUE constraint" — and the point of the whole clause is
 * that re-uploading a file UPDATES its rows instead of doubling them. The
 * owner's 129 exports overlap so heavily that 217,805 rows carry only 85,558
 * distinct bookings; without this the table would be 2.5× the truth.
 *
 * WHY THE STATEMENT IS BUILT AND NOT WRITTEN OUT. Two of its columns depend on
 * the schema in front of it — `arrived` disappears entirely once it is a
 * generated column — and the previous hand-written version spelt every column
 * name three times (insert list, VALUES list, SET list). Three lists that must
 * agree is three chances to disagree; one array cannot.
 *
 * The SET list omits INSERT_ONLY (above), and also notes, section_pref and
 * occasion — those are OUR fields, editable by staff on the bookings screen,
 * and a re-import must not erase what someone typed there. Reservego's own
 * equivalents live in guest_comments / sections and are the columns the
 * reservation UI reads. And it omits is_duplicate, which is not a property of
 * the row at all but of the row's PLACE among the guest's other bookings:
 * markImportDuplicates owns that column and settles it at finish.
 *
 * source_exported_at is set by its own expression rather than from `excluded`,
 * and MONOTONE: the stamp on a row only ever moves forward. A newer export that
 * changes nothing else still advances it (so the row records that the newest
 * file has spoken for it), while an undated import — stamp '' — cannot erase a
 * stamp that is already there. Without the monotone form, an undated file would
 * blank the provenance of every row it touched and re-open the door this whole
 * mechanism closes.
 */
function buildUpsertSql(arrivedIsStored: boolean): string {
  const cols = bookingColumns(arrivedIsStored);
  const sets = cols
    .filter((c) => !INSERT_ONLY.has(c as string) && !BAND_COLS.has(c as string))
    .map((c) => `${c} = excluded.${c}`);
  sets.push(
    `source_exported_at = MAX(COALESCE(ct_bookings.source_exported_at, ''), COALESCE(excluded.source_exported_at, ''))`,
  );
  /**
   * THE BAND LINK IS SEEDED HERE AND OWNED BY relinkBands().
   *
   * A booking is nearly always made BEFORE the act is booked — that is the
   * whole reason relinkBands exists — so at import time most nights resolve to
   * no band at all. A plain `live_band = excluded.live_band` would then let the
   * next re-upload of an old export BLANK a link the relink had just made, and
   * the owner would watch the band report empty itself every time he refreshed
   * the archive. So a blank resolution leaves the stored link alone; only a
   * name actually found on the calendar overwrites one.
   *
   * Both columns key off the NAME so the pair moves together: a band on the
   * calendar with no ct_bands master row must still write live_band_id = '',
   * not keep a stale id from a different act.
   */
  for (const c of ['live_band', 'live_band_id']) {
    sets.push(`${c} = CASE WHEN COALESCE(excluded.live_band, '') <> '' THEN excluded.${c} ELSE ct_bookings.${c} END`);
  }
  return `
INSERT INTO ct_bookings (${cols.join(', ')})
VALUES (${cols.map((c) => `@${c}`).join(', ')})
ON CONFLICT(reservego_key) WHERE reservego_key IS NOT NULL DO UPDATE SET
  ${sets.join(',\n  ')}
`;
}

/** A mapped row with the file line it came from, so a failure can name it. */
interface PendingRow { m: MappedBooking; line: number }

/**
 * Import one batch of raw CSV rows. Returns the running import row plus what
 * THIS batch did, so the upload screen can show both a total and a delta.
 *
 * `rowOffset` is the 0-based index of rows[0] within the file, used only to
 * quote a real line number back to the owner. It defaults to however many rows
 * the session has already processed, which is correct for the sequential
 * upload the UI performs.
 *
 * EVERY MAPPED ROW IS WRITTEN. No same-day collapse happens here — see the
 * header, and markImportDuplicates below.
 */
export function importBatch(
  db: DB,
  importId: string,
  rows: ReservegoRow[],
  rowOffset?: number,
): BatchOutcome {
  const imp = getImport(db, importId);
  if (!imp) throw new ImportError('Unknown import session', 404);
  if (imp.status !== 'running') throw new ImportError(`Import is already ${imp.status}`, 409);
  ensureSchema(db);

  const offset = Number.isFinite(rowOffset as number) ? Math.max(0, Math.round(rowOffset as number)) : imp.rows_processed;
  const importedBy = imp.imported_by || '';
  // Read from the SESSION, not recomputed per batch: the stamp was decided once
  // at startImport from the file name, and it must be the same value for every
  // row of the file whichever way the browser sliced it. '' means undated.
  const exportStamp = String(imp.source_exported_at || '');
  // Pinned on the session at startImport, for the same reason: one file, one
  // cutoff, whatever the browser did with the batches. A session started before
  // the column existed reads '' and normalizeCutoff answers with the default.
  const mealCutoff = normalizeCutoff(imp.meal_cutoff);
  // The band lead-in is read LIVE and not pinned, and the asymmetry is
  // deliberate: meal_period can only be re-derived by re-importing, while
  // live_band has relinkBands() as its owner and repair tool, so a mid-upload
  // change here is self-healing rather than baked into the file's rows.
  const bandLeadIn = normalizeLeadIn(appSetting(db, BAND_LEAD_IN_KEY));
  const arrivedIsStored = arrivedIsStoredColumn(db);

  // ── 1. Map, purely. No database is touched here, so a file of 2,000
  // unreadable rows costs nothing but the parse and never opens a write lock.
  const mapped: PendingRow[] = [];
  const errors: RowError[] = [];
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    const line = offset + i + 1;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push({ row: line, error: 'row is not an object of CSV columns' });
      continue;
    }
    const m = mapRow(raw as ReservegoRow);
    if ('error' in m) errors.push({ row: line, error: m.error });
    else mapped.push({ m, line });
  }

  // The nights this batch covers, in one query — see loadBandCalendar. Bounded
  // by the batch's own min/max so an upload of one month never reads the whole
  // calendar; empty when the batch mapped nothing.
  const nights = mapped.map((p) => p.m.reservedDate).filter(Boolean).sort();
  const bandCalendar = nights.length
    ? loadBandCalendar(db, nights[0], nights[nights.length - 1])
    : new Map<string, BandEvent[]>();

  // ── 2. Statements, prepared ONCE. Re-preparing inside the loop is what turns
  // a one-second import into a minutes-long one.
  const GUEST_FIELDS = `id, name, email, tags, preferences, source, phone10, phone_e164, identity_from`;
  const selGuestByPhone10 = db.prepare(`SELECT ${GUEST_FIELDS} FROM ct_guests WHERE phone10 = ? LIMIT 1`);
  const selGuestByE164 = db.prepare(`SELECT ${GUEST_FIELDS} FROM ct_guests WHERE phone_e164 = ? LIMIT 1`);
  const selGuestById = db.prepare(`SELECT ${GUEST_FIELDS} FROM ct_guests WHERE id = ?`);
  const insGuest = db.prepare(`
    INSERT INTO ct_guests (id, outlet_id, phone_e164, name, email, tags, source, preferences, phone10,
                           identity_from, created_at, updated_at)
    VALUES (?, '', ?, ?, ?, ?, 'reservego', ?, ?, ?, ?, ?)
  `);
  const updGuest = db.prepare(
    `UPDATE ct_guests SET name = ?, email = ?, tags = ?, preferences = ?, phone10 = ?,
                          identity_from = ?, updated_at = ? WHERE id = ?`,
  );
  const COMPARED: Array<keyof BookingValues> =
    arrivedIsStored ? [...COMPARED_BASE, 'arrived'] : COMPARED_BASE;
  const selBooking = db.prepare(
    `SELECT id, import_id, source_exported_at, ${COMPARED.join(', ')} FROM ct_bookings WHERE reservego_key = ?`,
  );
  const upsertBooking = db.prepare(buildUpsertSql(arrivedIsStored));
  /** Advance a row's stamp without touching its data — see writeBooking. */
  const bumpStamp = db.prepare(`UPDATE ct_bookings SET source_exported_at = ? WHERE id = ?`);

  /**
   * The email / name lookup, over PHONE-LESS GUESTS ONLY.
   *
   * A row identified by an email or a name is weak evidence, and it must never
   * be allowed to walk into a profile that has a phone number: the reservation
   * desk types "Guest" and "Walk in" all day, and merging those into a real
   * customer would hand one person somebody else's visit history, spend and
   * arrival rate — silently, and irreversibly once the metrics are rolled up.
   * Measured in the owner's 129 exports: 217,677 of 217,805 rows carry a usable
   * phone, 44 are email-only and 84 are name-only, resolving to 47 phone-less
   * guests. This restriction therefore costs almost nothing and prevents the
   * one outcome nobody could unpick.
   *
   * A guest counts as phone-less only when they have no phone10 AND their
   * phone_e164 is one of this importer's synthetic placeholders (or empty).
   * That second half matters: a CRM guest whose number is too short for
   * phone10() still HAS a phone, and is still off limits.
   *
   * Built lazily and only when a batch actually contains such a row, and it is
   * a small set (47 guests in the whole corpus), so it never costs the 217,677
   * phone rows anything.
   *
   * It is THROWN AWAY, not patched, whenever a phone-less guest is written.
   * Patching it in memory was a second way for batching to change the answer: a
   * guest created from an email row is indexed under their NAME too, so a
   * name-only row for the same person resolved to them when it landed in a
   * later batch and created a second profile when it landed in the same one.
   * Rebuilding costs one small indexed read, and the weak-keyed rows that
   * trigger it number 128 in 217,805.
   */
  let phonelessByEmail: Map<string, string> | null = null;
  let phonelessByName: Map<string, string> | null = null;
  const dropPhonelessIndex = () => { phonelessByEmail = null; phonelessByName = null; };
  const buildPhonelessIndex = () => {
    if (phonelessByEmail && phonelessByName) return;
    phonelessByEmail = new Map(); phonelessByName = new Map();
    const rs = db.prepare(`
      SELECT id, email, name FROM ct_guests
       WHERE (phone10 IS NULL OR phone10 = '')
         AND (COALESCE(phone_e164, '') = '' OR phone_e164 LIKE 'email:%' OR phone_e164 LIKE 'name:%')
       ORDER BY phone_e164
    `).all() as any[];
    for (const g of rs) {
      const e = String(g.email || '').trim().toLowerCase();
      const n = String(g.name || '').replace(/\s+/g, ' ').trim().toLowerCase();
      // ORDER BY phone_e164, not created_at or id, because several phone-less
      // guests can share a NAME (one created from an email row, one from a
      // name-only row) and the winner must not depend on the clock or on a
      // random UUID: created_at is the same value for every guest made in one
      // batch, so which of them was "first" would change with the batch size —
      // the exact class of bug this rewrite exists to remove. phone_e164 is
      // UNIQUE and derived from the data, and it happens to rank correctly too:
      // a real CRM profile ('' ) before an 'email:' placeholder before a
      // weaker 'name:' one.
      if (e && !phonelessByEmail.has(e)) phonelessByEmail.set(e, g.id);
      if (n && !phonelessByName.has(n)) phonelessByName.set(n, g.id);
    }
  };

  const tally: BatchTally = {
    rows: rows.length,
    new_bookings: 0, updated_bookings: 0, duplicate_rows: 0,
    new_customers: 0, failed_rows: errors.length,
    skipped_stale: 0, pax_clamped: mapped.reduce((n, p) => n + (p.m.paxClamped ? 1 : 0), 0),
    errors: [],
  };

  const at = nowIso();

  // ── 3. One transaction for the whole batch. A batch either lands or does
  // not, so a dropped connection can be retried as-is (the reservego_key upsert
  // makes the retry a no-op on anything that already landed).
  db.transaction(() => {
    for (const { m, line } of mapped) {
      try {
        // The guest is resolved BEFORE the booking key is built. See bookingKey.
        const guest = resolveGuest(m);
        writeBooking(m, guest, bookingKey(m, guest.phone10));
      } catch (e: any) {
        // A single row that will not write must not cost the batch.
        tally.failed_rows++;
        errors.push({ row: line, error: `${m.guest.name || m.guest.phone10 || 'guest'} @ ${m.bookingTime}: ${e?.message || e}` });
      }
    }

    db.prepare(`
      UPDATE reservation_imports SET
        rows_processed   = rows_processed   + @rows,
        new_bookings     = new_bookings     + @new_bookings,
        updated_bookings = updated_bookings + @updated_bookings,
        duplicate_rows   = duplicate_rows   + @duplicate_rows,
        new_customers    = new_customers    + @new_customers,
        failed_rows      = failed_rows      + @failed_rows,
        skipped_stale    = skipped_stale    + @skipped_stale,
        pax_clamped      = pax_clamped      + @pax_clamped
      WHERE id = @id
    `).run({
      id: importId,
      rows: tally.rows,
      new_bookings: tally.new_bookings,
      updated_bookings: tally.updated_bookings,
      duplicate_rows: tally.duplicate_rows,
      new_customers: tally.new_customers,
      failed_rows: tally.failed_rows,
      skipped_stale: tally.skipped_stale,
      pax_clamped: tally.pax_clamped,
    });
    appendErrors(db, importId, errors, imp.failed_rows);
  })();

  tally.errors = errors;
  return { summary: getImport(db, importId) as ImportRow, batch: tally };

  /* ── the two writers, closing over the prepared statements ───────────────── */

  /** A resolved customer: the row id, plus the phone that now identifies them. */
  interface ResolvedGuest { id: string; phone10: string }

  function resolveGuest(m: MappedBooking): ResolvedGuest {
    const p10 = m.guest.phone10;
    const email = m.guest.email;
    const name = m.guest.name;

    let existing: any = null;
    if (p10) {
      existing = selGuestByPhone10.get(p10)
        // Belt and braces for a guest another writer created since the start-of-
        // import backfill: found by the stored phone form, then given the key.
        || selGuestByE164.get(normalizePhone(p10));
    } else if (email) {
      buildPhonelessIndex();
      const id = phonelessByEmail!.get(email);
      if (id) existing = selGuestById.get(id);
    } else if (name) {
      buildPhonelessIndex();
      const id = phonelessByName!.get(name.toLowerCase());
      if (id) existing = selGuestById.get(id);
    }

    // The index is rebuilt per batch, so re-assert the rule against the row we
    // actually read rather than trusting a snapshot: a weak key never lands on
    // a guest who has a phone.
    if (existing && !p10 && !isPhoneless(existing)) existing = null;

    if (existing) {
      updateGuestFields(existing, m);
      return { id: existing.id, phone10: String(existing.phone10 || '') };
    }

    const id = crypto.randomUUID();
    // ct_guests.phone_e164 is NOT NULL UNIQUE, so a second phone-less guest
    // would collide on ''. The identity key itself becomes the placeholder:
    // stable (the same row resolves to the same value on every re-import),
    // unique per person, and obviously not a phone number to anyone reading it.
    const e164 = p10 ? normalizePhone(p10) : (email ? `email:${email}` : `name:${name.toLowerCase()}`);
    // identity_from records which booking time supplied each field, so the same
    // rule that governs a later update governs the row that created the
    // profile — see updateGuestFields. A field this row could not fill gets no
    // entry, which is what lets any later row fill it.
    const bornFrom: Record<string, string> = {};
    for (const [f, v] of [['name', name], ['email', email], ['preferences', m.preferences]] as const) {
      if (v) bornFrom[f] = m.bookingTime;
    }
    try {
      insGuest.run(id, e164, name, email, JSON.stringify(splitTags(m.tags).sort()),
        JSON.stringify(m.preferences ? { reservego: m.preferences } : {}), p10,
        stringifyIdentity(bornFrom), at, at);
      tally.new_customers++;
      if (!p10) dropPhonelessIndex();
      return { id, phone10: p10 };
    } catch (e: any) {
      // UNIQUE(phone_e164) — someone else created this guest between the lookup
      // and the insert. Their row is the one to use, and it cannot be a
      // phone-identified profile taken over by a weak key: for a phone-less row
      // the colliding value is our own 'email:'/'name:' placeholder, which only
      // ever belongs to a phone-less guest.
      const dup = selGuestByE164.get(e164) as any;
      if (dup) {
        updateGuestFields(dup, m);
        return { id: dup.id, phone10: String(dup.phone10 || '') };
      }
      throw e;
    }
  }

  /**
   * THE BOOKING KEY IS BUILT FROM THE RESOLVED GUEST, NOT FROM THE ROW.
   *
   * dedupeKeyFor embeds the guest, so anything that changes how a row is
   * identified also changes the booking's identity and mints a second booking
   * for one visit. Resolving the customer first and then keying on the phone
   * THEY are known by means a booking follows the guest, not the spelling of
   * one cell: the CSV's own key is used only for a guest who has no phone at
   * all, whose synthetic identity never changes either.
   *
   * Honest scope, measured: across the 129 real exports no booking ever changes
   * identity kind between files, so this rewrites no key in today's history —
   * the two rows that look like it (priya koyya, krithveek) are two DIFFERENT
   * rows inside one file where Reservego stored a truncated number ("91",
   * "4862641"). It is the direct-API caller, which will resolve guests against
   * a CRM that is already populated, that this ordering protects.
   *
   * m.bookingDate is the reserved date (mapRow passes the same value to
   * dedupeKeyFor), which is the tiebreak the owner chose: without it, Sno 667
   * and Sno 1000 of BookingsService_31-12-2025 — one guest, one Booking Time,
   * two reserved dates — collapse into a single booking. Measured across all
   * 129 exports, the tiebreak keeps 268 real bookings apart.
   */
  function bookingKey(m: MappedBooking, guestPhone: string): string {
    if (!guestPhone) return m.dedupeKey;
    return dedupeKeyFor(m.outlet, { kind: 'phone', key: guestPhone }, m.bookingTime, m.bookingDate);
  }

  /** No phone at all — not merely no phone10. See buildPhonelessIndex. */
  function isPhoneless(g: any): boolean {
    if (String(g.phone10 || '')) return false;
    const e164 = String(g.phone_e164 || '');
    return e164 === '' || e164.startsWith('email:') || e164.startsWith('name:');
  }

  /**
   * ── THE GUEST'S DETAILS COME FROM THEIR MOST RECENT BOOKING THAT GAVE ANY ──
   *
   * name, email and Reservego's Preferences note are all per-BOOKING fields in
   * the export, not per-guest ones. Measured over the owner's 129 files: 4,293
   * (guest, export) pairs carry rows that DISAGREE on the email inside a single
   * file, and 295 guests have an email that appears only on an older booking of
   * theirs. So there is no "the export's value" to take — there are many, and
   * the profile has to choose one.
   *
   * IT CHOOSES BY THE BOOKING TIME OF THE ROW THAT SUPPLIED THE VALUE, per
   * field, keeping the greatest. That is a maximum over a set, so it does not
   * matter which order the rows, the batches or the 129 FILES arrive in — the
   * property the whole round is about. The earlier rule ("whatever the last row
   * processed said") left 1,768 guests with a different name, 352 with a
   * different email and 231 with different preferences between a chronological
   * upload and a reverse one.
   *
   * ct_guests.identity_from records which booking time won each field. Three
   * things fall out of it, and all three are the point:
   *   • A FIELD WITH NO ENTRY IS NOT OURS. A name the phone team typed has no
   *     provenance here, so it is never overwritten — the rule
   *     guest-autosave.ts already follows, now enforced by the absence of a
   *     record rather than by a source='reservego' flag that says nothing about
   *     the individual field.
   *   • A BLANK IS NEVER A VALUE. An empty Guest Email on a walk-in row does
   *     not erase the address a reservation gave us six months ago.
   *   • RE-IMPORTING CONVERGES. The same row always produces the same verdict,
   *     so a second pass over the same files writes nothing.
   *
   * tags are a union rather than a choice — a tag is additive, and one applied
   * in March is not contradicted by an April row that omits it — and the array
   * is SORTED, because a set stored as a list must not depend on the order the
   * files happened to contribute to it.
   *
   * phone10 is fill-only and never overwritten: it is the join key.
   */

  function updateGuestFields(existing: any, m: MappedBooking): void {
    const from = parseJsonObject(existing.identity_from);
    // The row's own booking time is the ranking key: it is the data's answer to
    // "which of these is the most recent thing this guest told us", and unlike
    // the export stamp it does not change when the same booking is re-exported.
    const rowKey = m.bookingTime;

    /**
     * Does this row's value replace the stored one?
     *
     * The tie is broken on the VALUE, not on arrival: two bookings made in the
     * same second (which happens — see dedupeKeyFor's note on Sno 667/1000)
     * would otherwise be settled by whichever row the parser reached first. The
     * greater string is arbitrary but it is a function of the data, which is
     * the only property being asked for here.
     */
    const wins = (field: string, incoming: string, current: string): boolean => {
      if (!incoming) return false;               // a blank never displaces a value
      if (!current) return true;                 // fill an empty field from anywhere
      const held = String(from[field] ?? '');
      if (!held) return false;                   // somebody else's value — leave it alone
      if (rowKey !== held) return rowKey > held;
      return incoming > current;
    };

    const curName = String(existing.name || '');
    const curEmail = String(existing.email || '');
    const nextFrom: Record<string, unknown> = { ...from };

    let nextName = curName;
    if (wins('name', m.guest.name, curName)) { nextName = m.guest.name; nextFrom.name = rowKey; }
    let nextEmail = curEmail;
    if (wins('email', m.guest.email, curEmail)) { nextEmail = m.guest.email; nextFrom.email = rowKey; }

    // preferences is a JSON OBJECT everywhere else in the CRM (the guest API
    // parses and validates it as one), so Reservego's free text goes in under
    // its own key instead of replacing the object with a bare string.
    const curPrefs = String(existing.preferences ?? '');
    const prefs = parseJsonObject(existing.preferences);
    const curPrefText = typeof prefs.reservego === 'string' ? prefs.reservego : '';
    let nextPrefs = curPrefs;
    if (wins('preferences', m.preferences, curPrefText)) {
      prefs.reservego = m.preferences;
      nextPrefs = JSON.stringify(prefs);
      nextFrom.preferences = rowKey;
    }

    const curTags = String(existing.tags ?? '');
    const tagSet = new Set(parseJsonArray(existing.tags));
    for (const t of splitTags(m.tags)) tagSet.add(t);
    const nextTags = JSON.stringify([...tagSet].sort());

    const nextPhone10 = String(existing.phone10 || '') || m.guest.phone10 || '';
    const nextFromJson = stringifyIdentity(nextFrom);

    if (
      nextName === curName && nextEmail === curEmail &&
      nextTags === curTags && nextPrefs === curPrefs &&
      nextPhone10 === String(existing.phone10 || '') &&
      nextFromJson === String(existing.identity_from ?? '')
    ) return;  // nothing to write — do not bump updated_at for a no-op

    updGuest.run(nextName, nextEmail, nextTags, nextPrefs, nextPhone10, nextFromJson, at, existing.id);
    // A rename changes which name the rebuilt index would find this guest
    // under, so the cached one is no longer what the table says.
    if (isPhoneless(existing) && (nextName !== curName || nextEmail !== curEmail)) dropPhonelessIndex();
    existing.name = nextName; existing.email = nextEmail; existing.tags = nextTags;
    existing.preferences = nextPrefs; existing.phone10 = nextPhone10;
    existing.identity_from = nextFromJson;
  }

  function writeBooking(m: MappedBooking, guest: ResolvedGuest, key: string): void {
    const stored = selBooking.get(key) as any;

    /**
     * ── THE EXPORT-RECENCY GUARD ──────────────────────────────────────────
     * An older export may not overwrite a booking that a newer one already
     * spoke for. This is the whole answer to "the owner uploads 129 files in
     * whatever order the picker sorted them": without it the last file wins,
     * and uploading the archive last walked 7,563 bookings back to a stale
     * status and 5,335 to a stale arrival (measured, chronological vs reverse
     * over all 129 real exports).
     *
     * THE TEST IS "CAN THIS FILE PROVE IT IS AT LEAST AS NEW?", and it fails
     * two ways: the incoming export is strictly older, or it carries no stamp
     * at all while the stored row does. The second half is not pedantry —
     * without it an undated upload sails past the guard and overwrites
     * everything it touches, which is the original bug wearing a different
     * hat. Measured: posting the oldest 2024 export with its name stripped and
     * no fallback rewrote 37 bookings with two-year-old content.
     *
     * EQUAL STAMPS PASS. Two files carrying the same stamp are the same export
     * (Reservego splits large ones into _1_1 and _1_2 parts — 5 of the owner's
     * 129 files), and rewriting a row with identical data is a no-op that keeps
     * the retry path simple.
     *
     * A STORED ROW WITH NO STAMP IS FAIR GAME: it predates this mechanism or
     * came from the phone CRM, so there is nothing to be newer than, and the
     * write gives it a provenance it did not have.
     *
     * COUNTED, NEVER SILENT. skipped_stale is its own number in the summary:
     * "your file changed nothing" and "your file could not out-rank what you
     * already had" are different sentences and the owner must be able to tell
     * them apart. Paired with stamp_source in Import History, an undated upload
     * that refused 130,000 rows reads as "name the file properly", not as a
     * failure.
     */
    const storedStamp = String(stored?.source_exported_at ?? '');
    if (stored && storedStamp && (!exportStamp || storedStamp > exportStamp)) {
      tally.skipped_stale++;
      return;
    }

    /**
     * WHO WINS WHEN THE EXPORT IS BLANK.
     *
     * A stored row that carries an import_id was written by this engine from an
     * earlier export, and the export is the venue's record: the NEW file wins
     * outright, blanks included. Falling back to the stored value made
     * corrections impossible — a booking exported as Checked-in and later
     * corrected to No-show kept the old seated stamp forever, and with it
     * arrived=1 against a status of no_show.
     *
     * A stored row with NO import_id was not written from an export. Nothing
     * else writes reservego_key today, so this is defensive rather than a live
     * path, but the intent is fixed: a human's seat-board decision is not
     * overwritten by a file.
     */
    const protectStored = !!stored && !String(stored.import_id ?? '');
    const seatedAt = protectStored ? (m.seatedTime || String(stored.seated_at || '')) : m.seatedTime;
    const status: string =
      (protectStored ? (m.status || String(stored.status || '')) : m.status) || UNMAPPED_STATUS;
    // Re-asked of the pure rule with the EFFECTIVE values rather than re-spelt
    // here: arrived is "completed or seated, or has a seated time, and never
    // cancelled or no-show", and that sentence must exist in exactly one place.
    const arrived = isArrived(status as BookingStatus, seatedAt);

    // The derived night. reserved_date / day_of_week / dow / slot_time come off
    // the mapped row (one rule, in reservego.ts); the meal split and the band
    // need this database's two house settings, which a pure mapper cannot see.
    const meal = mealPeriodFor(m.slotTime, mealCutoff);
    const band = pickBandForSlot(m.slotTime, bandCalendar.get(m.reservedDate) || [], bandLeadIn);

    const values: BookingValues = {
      // Always a fresh id on the insert attempt. On the conflict path it is
      // discarded (id is not in the SET list, so the row keeps the identity
      // orders.booking_id may already point at) — and passing the stored id
      // instead would make the statement violate the PRIMARY KEY as well as the
      // conflict target, which is not a race worth running.
      id: crypto.randomUUID(),
      guest_id: guest.id,
      booking_date: m.bookingDate,
      slot_time: m.slotTime,
      party_size: m.pax,
      status,
      created_by: importedBy,
      channel: 'reservego',
      seated_at: seatedAt || null,
      created_at: at,
      updated_at: at,
      reservego_key: key,
      reservego_status: m.rawStatus,
      booking_time: m.bookingTime,
      reserved_time: m.reservedTime,
      booking_type: m.bookingType,
      outlet_name: m.outlet,
      pax_breakdown: JSON.stringify(m.paxBreakdown),
      reserved_by: m.reservedBy,
      sections: m.sections,
      tables_csv: m.tables,
      source: m.source,
      preferences: m.preferences,
      tags: m.tags,
      guest_comments: m.guestComments,
      outlet_comments: m.outletComments,
      deletion_type: m.deletionType,
      deletion_reason: m.deletionReason,
      bill_amount: m.billAmount,
      bill_number: m.billNumber,
      booking_amount: m.bookingAmount,
      booking_txn_id: m.bookingTxnId,
      booking_payment_status: m.bookingPaymentStatus,
      booking_payment_date: m.bookingPaymentDate,
      source_exported_at: exportStamp,
      import_id: importId,
      reserved_date: m.reservedDate,
      day_of_week: m.dayOfWeek,
      dow: m.dow,
      meal_period: meal,
      live_band: band?.name ?? '',
      live_band_id: band?.bandId ?? '',
      reservego_visit_count: m.visitCount,
    };
    // Only when this database still expects the engine to own the column. Once
    // `arrived` is generated the statement does not name it, and passing the
    // key anyway would fail as an unknown named parameter.
    if (arrivedIsStored) values.arrived = arrived ? 1 : 0;

    if (!stored) {
      upsertBooking.run(values as any);
      tally.new_bookings++;
      return;
    }

    const changed = COMPARED.some((c) => norm(stored[c]) !== norm(values[c]));
    if (!changed) {
      // The same row again — a re-upload, or two months whose exports overlap
      // (measured: the 129 real files carry each booking 2.5 times on average,
      // so this is the COMMON case, not an edge). No DATA is written.
      //
      // The stamp still advances, and it has to. A newer export that agrees
      // with the stored row is still the newest thing said about it; leaving
      // the old stamp would let a middle-aged file overwrite it afterwards and
      // put the result back at the mercy of upload order. Guarded by the
      // comparison, so re-uploading the SAME file writes nothing at all and
      // the import stays a genuine no-op.
      if (exportStamp && exportStamp > storedStamp) bumpStamp.run(exportStamp, String(stored.id));
      tally.duplicate_rows++;
      return;
    }
    // A Confirmed row exported later as Cancelled lands here: the same booking,
    // amended. The upsert updates it in place and the row keeps its id.
    upsertBooking.run(values as any);
    tally.updated_bookings++;
  }
}

/* ── finish: the same-day verdict, then the customer metrics ───────────────── */

/**
 * Apply the owner's same-day rule over STORED HISTORY and set
 * ct_bookings.is_duplicate. This is the only place the rule is applied.
 *
 * WHY NOT PER BATCH. collapseSameDayDuplicates() is pure and will collapse
 * whatever list it is handed, so calling it on each 2,000-row batch made the
 * answer depend on where the file happened to be cut: a pair that sat inside
 * one batch collapsed, and the same pair split across a boundary did not — and
 * because the loser had already been written under its own key, no later import
 * could remove it. ct_bookings and the guest's metrics then disagreed
 * permanently. Here the verdict is taken once, over every stored row the
 * affected guests own, so it converges: any batching of any subset of the files
 * ends in the same is_duplicate set.
 *
 * WHICH ROWS ARE ELIGIBLE. Only rows with an import_id — Reservego's own. The
 * CRM's phone bookings are not exports and two of them on one evening are two
 * real bookings, taken by two different people over the phone. The earlier
 * version swept those into the same rule and deleted genuine history from a
 * module this feature was only supposed to add to.
 *
 * WHICH GUESTS. Those this import wrote a row for, widened to anyone sharing
 * their phone10 — a same-day group is keyed on (outlet, phone, date), so if two
 * profiles ever hold one number the group would otherwise be split in half and
 * both halves would elect a primary.
 *
 * Marking, not deleting: the row stays visible and auditable, the Import
 * History counts add up, and if the rule changes the decision is simply
 * recomputed.
 */
export interface DuplicateVerdict {
  /** Guests whose history was re-decided — the rollup's targets. */
  targets: Set<string>;
  /** Reservego rows examined. */
  scanned: number;
  /** Rows the rule marks as duplicates, over the whole history examined. */
  duplicates: number;
  /** How many rows actually changed flag — 0 on a converged re-import. */
  changed: number;
}

export function markImportDuplicates(db: DB, importId: string): DuplicateVerdict {
  ensureSchema(db);
  const targets = new Set<string>();
  for (const r of db.prepare(
    `SELECT DISTINCT guest_id FROM ct_bookings WHERE import_id = ? AND COALESCE(guest_id, '') <> ''`,
  ).all(importId) as any[]) targets.add(String(r.guest_id));
  if (!targets.size) return { targets, scanned: 0, duplicates: 0, changed: 0 };

  return withTargetTable(db, targets, (t) => {
    const widened: string[] = [];
    for (const r of db.prepare(`
      SELECT DISTINCT sib.id
        FROM ${t} tt
        JOIN ct_guests g   ON g.id = tt.id
        JOIN ct_guests sib ON sib.phone10 = g.phone10
       WHERE COALESCE(g.phone10, '') <> ''
    `).all() as any[]) {
      const id = String(r.id);
      if (!targets.has(id)) { targets.add(id); widened.push(id); }
    }
    if (widened.length) {
      const ins = db.prepare(`INSERT OR IGNORE INTO ${t} (id) VALUES (?)`);
      db.transaction((ids: string[]) => { for (const id of ids) ins.run(id); })(widened);
    }

    const rows = db.prepare(`
      SELECT b.id, b.reservego_key, b.outlet_name, b.booking_date, b.booking_time, b.status,
             b.seated_at, b.bill_amount, b.is_duplicate, g.phone10
        FROM ct_bookings b
        JOIN ${t} tt      ON tt.id = b.guest_id
        LEFT JOIN ct_guests g ON g.id = b.guest_id
       WHERE COALESCE(b.import_id, '') <> ''
    `).all() as any[];
    if (!rows.length) return { targets, scanned: 0, duplicates: 0, changed: 0 };

    /**
     * markDuplicateGroups breaks a final tie on `id`, so the id it is given
     * decides which of two otherwise identical rows is the primary. The
     * ct_bookings id is a random UUID: identical data imported into two
     * databases elected different primaries, which is precisely the
     * batch-independence this rewrite promises. reservego_key is derived from
     * the booking itself and is UNIQUE, so the verdict is a function of the
     * data and nothing else. (The `|| r.id` is for a row that somehow has an
     * import_id and no key; nothing writes one today.)
     */
    const rank = (r: any) => String(r.reservego_key || r.id);
    const byRank = new Map<string, any>(rows.map((r) => [rank(r), r]));

    const stored: StoredBookingRow[] = rows.map((r) => ({
      id: rank(r),
      phone10: String(r.phone10 || ''),
      outlet: String(r.outlet_name || ''),
      bookingDate: String(r.booking_date || ''),
      // Derived, not read from the arrived column: the ranking must obey the
      // rule as it stands now, including rows written before isArrived() was
      // taught that a cancelled booking is never an arrival however stale a
      // Seated Time Reservego left on it.
      arrived: isArrived(
        (r.status ? String(r.status) : null) as BookingStatus | null,
        r.seated_at ? String(r.seated_at) : '',
      ),
      billAmount: r.bill_amount === null || r.bill_amount === undefined ? null : Number(r.bill_amount),
      bookingTime: String(r.booking_time || ''),
    }));

    const { primaryIds, duplicateIds } = markDuplicateGroups(stored);
    const want = new Map<string, number>();
    for (const id of primaryIds) want.set(id, 0);
    for (const id of duplicateIds) want.set(id, 1);

    // Only the rows whose flag actually moves are written. On a re-import of
    // files already loaded that is zero rows, which is what makes finishing an
    // unchanged upload cost nothing.
    const changes: Array<[number, string]> = [];
    for (const [key, next] of want) {
      const r = byRank.get(key);
      if (!r) continue;
      if (Number(r.is_duplicate ?? 0) !== next) changes.push([next, String(r.id)]);
    }
    if (changes.length) {
      const upd = db.prepare(`UPDATE ct_bookings SET is_duplicate = ? WHERE id = ?`);
      db.transaction((cs: Array<[number, string]>) => { for (const c of cs) upd.run(c[0], c[1]); })(changes);
    }
    return { targets, scanned: rows.length, duplicates: duplicateIds.length, changed: changes.length };
  });
}

const METRIC_COLUMNS = `total_bookings, arrived_visits, cancelled_bookings, no_shows, arrival_rate,
  total_pax, total_spend, avg_spend, first_booking, last_booking, booking_sources,
  visit_frequency_days, metrics_updated_at`;

/**
 * Recompute the denormalised lifetime metrics for the guests this import
 * touched — not for all 70,315 of them, and never per page view.
 *
 * WHICH GUESTS. Those with a booking stamped with this import_id (only rows
 * that were inserted or genuinely changed carry it), plus the guests the
 * duplicate pass re-decided, PLUS any guest whose metrics_updated_at is still
 * NULL. The last part is what makes a crashed import recoverable: re-uploading
 * the file finds every row unchanged and touches nothing, so without it a guest
 * created by the crashed run would keep empty metrics forever. It also
 * initialises the phone-CRM guests who existed before this feature, on the
 * first import that runs.
 *
 * WHY IT IS SCOPED AND NOT A FULL SCAN. It used to read every booking and every
 * guest row on every import and then throw away the ones it did not need.
 * Measured against the loaded database: a 50-row correction file (2 customers
 * moved) now costs ~0.3s from startImport to finishImport — less than the ~0.4s
 * the old shape spent merely READING the 85,598 bookings and 70,342 guests it
 * then filtered down to two. Everything below is driven off a temp table of the
 * target ids, so the cost follows what the upload touched.
 *
 * DUPLICATES ARE EXCLUDED, NOT RE-COLLAPSED. markImportDuplicates has already
 * decided which stored row represents each visit, so the metrics simply skip
 * is_duplicate = 1. That is what stops the numbers on the Customers screen from
 * ever disagreeing with the flag on the booking.
 */
export function rollupMetrics(
  db: DB,
  importId: string,
  extraTargets?: Iterable<string>,
): { touchedByImport: number; refreshed: number } {
  ensureSchema(db);
  const touched = new Set<string>();
  for (const r of db.prepare(
    `SELECT DISTINCT guest_id FROM ct_bookings WHERE import_id = ?`,
  ).all(importId) as any[]) {
    if (r.guest_id) touched.add(String(r.guest_id));
  }
  const touchedByImport = touched.size;

  const targets = new Set(touched);
  for (const id of extraTargets || []) if (id) targets.add(String(id));
  for (const r of db.prepare(
    `SELECT id FROM ct_guests WHERE metrics_updated_at IS NULL`,
  ).all() as any[]) targets.add(String(r.id));
  if (!targets.size) return { touchedByImport, refreshed: 0 };

  const pending: any[][] = [];

  withTargetTable(db, targets, (t) => {
    const stored = new Map<string, any>();
    for (const g of db.prepare(
      `SELECT g.id, ${METRIC_COLUMNS} FROM ct_guests g JOIN ${t} tt ON tt.id = g.id`,
    ).all() as any[]) stored.set(g.id, g);

    // One ordered pass over the target guests' bookings, grouped in JS as it
    // streams. The writes are buffered rather than issued inside the cursor:
    // better-sqlite3 keeps the connection busy for the life of an open
    // iterator, and a metric refresh is not worth risking that against.
    const seen = new Set<string>();
    let curId = '';
    let group: Array<{
      status: BookingStatus | null; arrived: boolean; pax: number;
      billAmount: number | null; bookingDate: string; source: string;
    }> = [];

    const flush = () => {
      if (!curId) return;
      seen.add(curId);
      const m = computeGuestMetrics(group);
      const before = stored.get(curId);
      const row = [
        m.total_bookings, m.arrived_visits, m.cancelled_bookings, m.no_shows, m.arrival_rate,
        m.total_pax, m.total_spend, m.avg_spend, m.first_booking, m.last_booking,
        JSON.stringify(m.sources), m.visit_frequency_days,
      ];
      // Skip the write when nothing moved — except for a guest never rolled up,
      // whose NULL metrics_updated_at has to be stamped or every future import
      // will keep picking them up.
      const unchanged = before && before.metrics_updated_at && [
        before.total_bookings, before.arrived_visits, before.cancelled_bookings, before.no_shows,
        before.arrival_rate, before.total_pax, before.total_spend, before.avg_spend,
        before.first_booking, before.last_booking, before.booking_sources, before.visit_frequency_days,
      ].every((v, i) => norm(v) === norm(row[i]));
      if (!unchanged) pending.push([...row, nowIso(), curId]);
      group = [];
    };

    const cursor = db.prepare(`
      SELECT b.guest_id, b.status, b.seated_at, b.party_size, b.bill_amount,
             b.booking_date, b.source
        FROM ct_bookings b
        JOIN ${t} tt ON tt.id = b.guest_id
       WHERE COALESCE(b.is_duplicate, 0) = 0
       ORDER BY b.guest_id
    `).iterate() as IterableIterator<any>;

    for (const r of cursor) {
      const gid = String(r.guest_id || '');
      if (gid !== curId) { flush(); curId = gid; }
      // The column already holds our own status vocabulary, so it is cast rather
      // than re-mapped: mapStatus() reads Reservego's spellings, not ours, and a
      // value outside the vocabulary simply matches none of the comparisons.
      const status = (r.status ? String(r.status) : null) as BookingStatus | null;
      group.push({
        status,
        // Derived from the shared rule, NOT read from the arrived column. The
        // column is a cache this engine writes; trusting it here would let a
        // stale arrived=1 on a cancelled booking (Reservego leaves a Seated
        // Time on rows it later cancels) survive the fix to isArrived and go on
        // reporting a guest who never came as a 100% arrival.
        arrived: isArrived(status, r.seated_at ? String(r.seated_at) : ''),
        pax: Number(r.party_size) || 0,
        billAmount: r.bill_amount === null || r.bill_amount === undefined ? null : Number(r.bill_amount),
        bookingDate: String(r.booking_date || ''),
        source: String(r.source || ''),
      });
    }
    flush();

    // A targeted guest with no countable bookings still needs their metrics
    // initialised — otherwise the Customers list shows blanks where zeros
    // belong. (A guest ALL of whose bookings are duplicates lands here too,
    // which is right: the visit is counted on the guest who owns the primary.)
    for (const id of targets) {
      if (seen.has(id)) continue;
      const before = stored.get(id);
      if (before && before.metrics_updated_at && Number(before.total_bookings) === 0) continue;
      const m = computeGuestMetrics([]);
      pending.push([
        m.total_bookings, m.arrived_visits, m.cancelled_bookings, m.no_shows, m.arrival_rate,
        m.total_pax, m.total_spend, m.avg_spend, m.first_booking, m.last_booking,
        JSON.stringify(m.sources), m.visit_frequency_days, nowIso(), id,
      ]);
    }
  });

  if (pending.length) {
    const upd = db.prepare(`
      UPDATE ct_guests SET
        total_bookings = ?, arrived_visits = ?, cancelled_bookings = ?, no_shows = ?,
        arrival_rate = ?, total_pax = ?, total_spend = ?, avg_spend = ?,
        first_booking = ?, last_booking = ?, booking_sources = ?, visit_frequency_days = ?,
        metrics_updated_at = ?
      WHERE id = ?
    `);
    // updated_at is left alone on purpose: metrics_updated_at exists so that a
    // rollup does not look like someone edited the profile.
    db.transaction((rows: any[][]) => { for (const p of rows) upd.run(...p); })(pending);
  }

  return { touchedByImport, refreshed: pending.length };
}

/**
 * Close the session: decide the duplicates, roll the metrics up, write the
 * final summary. In that order — the metrics read the flag the pass sets.
 *
 * collapsed_rows is SET, not accumulated. It is the whole-history verdict for
 * the guests this file touched: how many of their stored Reservego bookings the
 * same-day rule says are duplicates of another. That is a state, not a count of
 * rows in this upload, so re-running an unchanged file reports the same number
 * rather than doubling it. (Import History's arithmetic is therefore
 * rows_processed = new + updated + duplicate_rows + failed, with collapsed_rows
 * standing beside it rather than inside it.)
 *
 * updated_customers is settled HERE rather than counted per batch, because a
 * guest who appears in eleven batches must count once. It is every customer
 * this import wrote a booking for, less the ones it created — the customers
 * whose lifetime numbers this file moved.
 *
 * skipped_stale and pax_clamped are NOT settled here: they are per-row events
 * that the batches counted as they happened, and a batch that refused 40 rows
 * as older-than-stored has already said so on the session row.
 */
export function finishImport(db: DB, importId: string): ImportRow {
  const imp = getImport(db, importId);
  if (!imp) throw new ImportError('Unknown import session', 404);
  // A retried finish is a no-op, and a session that was marked failed stays
  // failed — finishing it would report a completed import over a broken one.
  if (imp.status !== 'running') return imp;

  const verdict = markImportDuplicates(db, importId);
  const { touchedByImport } = rollupMetrics(db, importId, verdict.targets);
  db.prepare(`
    UPDATE reservation_imports
       SET status = 'completed', finished_at = ?, updated_customers = ?, collapsed_rows = ?
     WHERE id = ?
  `).run(nowIso(), Math.max(0, touchedByImport - imp.new_customers), verdict.duplicates, importId);
  return getImport(db, importId) as ImportRow;
}

/* ── re-linking the band, after the calendar catches up ────────────────────── */

export interface RelinkBandsResult {
  from: string;
  to: string;
  /** Nights in the range that have at least one band on the calendar. */
  dates: number;
  /** Bookings examined. */
  scanned: number;
  /** Rows whose link this pass wrote. */
  changed: number;
  /** …of which gained a band, and …of which lost one. */
  linked: number;
  cleared: number;
  /** Band names on the calendar with no ct_bands master row, so live_band_id
   *  stayed ''. The prompt to add them to the band list and re-run. */
  unresolved: string[];
}

/** 'YYYY-MM-DD' or the given fallback — the range bounds are bound as
 *  parameters, but a malformed bound would silently select nothing. */
function boundDate(raw: unknown, fallback: string): string {
  const s = String(raw ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : fallback;
}

/**
 * Re-resolve ct_bookings.live_band / live_band_id over a date range.
 *
 * ── WHY LINKING AT IMPORT ALONE WOULD LEAVE THE COLUMN EMPTY FOREVER ───────
 * Guests book weeks ahead; the act for that night is put on the calendar days
 * before it. So at the moment a booking is imported there is usually no band
 * scheduled yet, and a link made only then would be blank for most of the
 * archive and never fill in — the band report would answer "nobody played" for
 * a year of live music. This is the pass that runs after the calendar is
 * updated (or after a band is added to ct_bands), and it is the OWNER of the
 * two columns: the importer only seeds them, and its upsert will not blank what
 * this wrote (see buildUpsertSql).
 *
 * IT CLEARS AS WELL AS SETS. A cancelled act removed from the calendar has to
 * take its bookings' links with it, or the report keeps crediting a band that
 * did not play. That is why the pass reads every booking in the range rather
 * than only the ones with a band tonight.
 *
 * PHONE BOOKINGS COUNT TOO. The night is a property of the evening, not of
 * where the reservation came from, so rows are matched on reserved_date falling
 * back to booking_date — which is what the CRM's own bookings carry.
 *
 * The rule itself is pickBandForSlot() in reservego.ts, the same function the
 * importer calls. Deliberately not an UPDATE … FROM: a second, SQL-shaped copy
 * of the lead-in window is exactly the kind of paired definition that drifts.
 */
export function relinkBands(db: DB, range: { from?: string; to?: string } = {}): RelinkBandsResult {
  ensureSchema(db);
  const from = boundDate(range.from, '0000-01-01');
  const to = boundDate(range.to, '9999-12-31');
  const calendar = loadBandCalendar(db, from, to);
  const leadIn = normalizeLeadIn(appSetting(db, BAND_LEAD_IN_KEY));

  const unresolved = new Set<string>();
  for (const events of calendar.values()) {
    for (const e of events) if (e.name && !e.bandId) unresolved.add(e.name);
  }

  const DATE = `COALESCE(NULLIF(reserved_date, ''), booking_date)`;
  const rows = db.prepare(`
    SELECT id, ${DATE} AS night, COALESCE(slot_time, '') AS slot_time,
           COALESCE(live_band, '') AS live_band, COALESCE(live_band_id, '') AS live_band_id
      FROM ct_bookings
     WHERE ${DATE} BETWEEN ? AND ?
  `).all(from, to) as any[];

  const pending: Array<[string, string, string]> = [];
  let linked = 0, cleared = 0;
  for (const r of rows) {
    const pick = pickBandForSlot(String(r.slot_time || ''), calendar.get(String(r.night)) || [], leadIn);
    const name = pick?.name ?? '';
    const bandId = pick?.bandId ?? '';
    if (norm(r.live_band) === name && norm(r.live_band_id) === bandId) continue;
    if (name) linked++; else cleared++;
    pending.push([name, bandId, String(r.id)]);
  }
  if (pending.length) {
    const upd = db.prepare(`UPDATE ct_bookings SET live_band = ?, live_band_id = ? WHERE id = ?`);
    // updated_at is left alone: a relink is not somebody editing the booking,
    // exactly as the metric rollup leaves ct_guests.updated_at alone.
    db.transaction((list: Array<[string, string, string]>) => { for (const p of list) upd.run(...p); })(pending);
  }
  return {
    from, to, dates: calendar.size, scanned: rows.length,
    changed: pending.length, linked, cleared,
    unresolved: [...unresolved].sort(),
  };
}

/* ── SCHEMA THIS ENGINE NEEDS — the handover to src/lib/db.ts ───────────────
 *
 * ensureSchema() above asserts the ADDITIVE half itself so the engine cannot be
 * run against a narrower table, but all of it belongs in the Reservego
 * migration block in db.ts (§ A / § B / § C, around db.ts:4849) where the rest
 * of these columns already live. Verbatim, and each PRAGMA-guarded exactly as
 * the addRB/addG helpers there already do it:
 *
 *   ct_bookings         source_exported_at  TEXT
 *   ct_guests           identity_from       TEXT   -- JSON {field: booking_time}
 *   reservation_imports source_exported_at  TEXT
 *   reservation_imports stamp_source        TEXT NOT NULL DEFAULT 'none'
 *   reservation_imports skipped_stale       INTEGER NOT NULL DEFAULT 0
 *   reservation_imports pax_clamped         INTEGER NOT NULL DEFAULT 0
 *   reservation_imports meal_cutoff         TEXT   -- the cutoff this file was
 *                                          -- derived with, pinned at startImport
 *                                          -- so batching cannot split a file
 *                                          -- across two house rules
 *   ct_bookings         is_duplicate        INTEGER NOT NULL DEFAULT 0   (already there)
 *   ct_bookings         reserved_date / day_of_week / dow / meal_period /
 *                       live_band / live_band_id / reservego_visit_count
 *                                          (db.ts § A3 already declares these)
 *
 * No index on source_exported_at: it is only ever read on a row already found
 * through idx_ct_bookings_resv_key, so an index on it would pay write cost on
 * 85,558 rows to serve no query.
 *
 * ── AND THE ONE PIECE THIS FILE MUST NOT DO ────────────────────────────────
 * ct_bookings.arrived has to become a VIRTUAL GENERATED column. That needs a
 * DROP COLUMN, which rewrites the table — a migration, not something an import
 * engine may do to a live database in the middle of an upload. db.ts, once,
 * guarded on PRAGMA table_xinfo reporting hidden = 0 for `arrived`:
 *
 *   DROP INDEX IF EXISTS idx_ct_bookings_arrived;      -- DROP COLUMN refuses an indexed column
 *   ALTER TABLE ct_bookings DROP COLUMN arrived;
 *   ALTER TABLE ct_bookings ADD COLUMN arrived INTEGER
 *     GENERATED ALWAYS AS (<ARRIVED_SQL from src/lib/reservego.ts>) VIRTUAL;
 *   CREATE INDEX IF NOT EXISTS idx_ct_bookings_arrived ON ct_bookings(arrived);
 *
 * Import ARRIVED_SQL rather than retyping the CASE — the whole point is that
 * one sentence defines arrival, and isArrived() sits directly beside it.
 *
 * AND DELETE THE ct_bookings_arrived_backfill_v1 BLOCK (db.ts ~5026-5076) IN
 * THE SAME CHANGE. It runs `UPDATE ct_bookings SET arrived = 1`, which against
 * a generated column fails with "cannot UPDATE generated column"; its own
 * try/catch would swallow that, its settings flag would never be written, and
 * it would throw on every boot forever. It is also redundant: measured on a
 * copy of production, the generated column reads 1 for exactly the same 23 of
 * 40 pre-import rows (14 completed + 9 seated) that the backfill was written to
 * mark, because both derive from the same rule.
 *
 * Measured cost of the rewrite on a copy of the loaded archive (85,598
 * bookings): see the note in the acceptance run — it is a one-off at boot, and
 * the index is used afterwards (EXPLAIN QUERY PLAN: SEARCH ct_bookings USING
 * INDEX idx_ct_bookings_arrived).
 */
