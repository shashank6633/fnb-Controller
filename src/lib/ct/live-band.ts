/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Booking PREFERENCE and the Live Band it resolves to.
 *
 * A preference is what the guest is coming FOR — separate from `occasion`
 * (what they are celebrating) and `section_pref` (where they want to sit). It
 * exists because "is the band playing that night?" is the single most common
 * question on the phone, and the answer has to be pinned to the booking at the
 * moment it is promised, not looked up again later when the calendar has moved.
 *
 * When the preference is Live Band, the booking stores the band that was
 * scheduled for that date: `live_band` is the name AS IT WAS on the night, and
 * `live_band_id` is the ct_bands master id (db.ts § A3/D). Both, deliberately —
 * the id is what makes "Agnee" and "AGNEE" aggregate as one act in a report,
 * and the frozen name is what stops a later rename rewriting what last year's
 * booking says was promised.
 *
 * The calendar (ct_entertainment) says WHO plays on a date; the master
 * (ct_bands) says who that act IS. This module is the one place the two are
 * joined, by name under NOCASE.
 */

/**
 * The two methods this module calls, described structurally rather than by
 * importing better-sqlite3. QuickBookingModal is a client component and reads
 * BOOKING_PREFERENCES from here so there is ONE vocabulary; with no import at
 * all, nothing server-side can be dragged into the client bundle by reaching
 * for it. A real Database satisfies this shape.
 */
interface DB {
  prepare(sql: string): {
    get(...params: any[]): any;
    all(...params: any[]): any[];
    run(...params: any[]): { changes: number };
  };
  exec(sql: string): unknown;
}

export const PREF_LIVE_BAND = 'Live Band';

/** The whole vocabulary. Stored verbatim, so these strings ARE the data. */
export const BOOKING_PREFERENCES = [PREF_LIVE_BAND, 'DJ', 'Dining', 'Other'] as const;
export type BookingPreference = (typeof BOOKING_PREFERENCES)[number];

/**
 * '' (not stated) or one of BOOKING_PREFERENCES — never anything else, and
 * never the caller's casing. A controlled vocabulary is what lets the relink
 * route trust `WHERE preference = 'Live Band'`; a stray "live band" would be
 * invisible to every backfill run forever after.
 *
 * Returns null for a non-empty value that is not in the list, so the caller can
 * refuse it rather than store a typo.
 */
export function normalizeBookingPreference(raw: unknown): BookingPreference | '' | null {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const hit = BOOKING_PREFERENCES.find((p) => p.toLowerCase() === s.toLowerCase());
  return hit ?? null;
}

/* ── schema guard ──────────────────────────────────────────────────────────── */

/** Connections already checked, so the PRAGMA runs once per process. */
const SCHEMA_READY = new WeakSet<object>();

/**
 * The three columns this feature adds, asserted additively.
 *
 * db.ts § A3 already declares live_band and live_band_id with exactly these
 * types, so those two ALTERs are normally a PRAGMA-guarded no-op; `preference`
 * is still declared only here. Both writers (the Quick Booking POST and the
 * relink backfill) throw against a narrower table, and a booking lost to a
 * missing column is a guest turned away at the door — so the guard stays until
 * db.ts adopts the third column too:
 *
 *   ALTER TABLE ct_bookings ADD COLUMN preference   TEXT NOT NULL DEFAULT '';
 *   ALTER TABLE ct_bookings ADD COLUMN live_band    TEXT NOT NULL DEFAULT '';
 *   ALTER TABLE ct_bookings ADD COLUMN live_band_id TEXT NOT NULL DEFAULT '';
 *
 * NOT NULL DEFAULT '' matches the neighbouring occasion / section_pref columns,
 * and it is what keeps `preference = 'Live Band'` a plain equality: in SQL a
 * NULL row answers neither the filter nor its negation, so the 85,558 imported
 * Reservego rows would otherwise need a COALESCE in every consumer.
 *
 * No index on `preference`. The only query that filters on it is the relink
 * backfill, which is manual, bounded by booking_date (already indexed) and
 * scans in tens of milliseconds; an index would pay write cost on every one of
 * those 85,558 rows to serve nothing else.
 */
export function ensureLiveBandSchema(db: DB): void {
  if (SCHEMA_READY.has(db)) return;
  const cols = db.prepare(`PRAGMA table_info(ct_bookings)`).all() as any[];
  const has = (n: string) => cols.some((c: any) => c.name === n);
  for (const col of ['preference', 'live_band', 'live_band_id']) {
    if (!has(col)) db.exec(`ALTER TABLE ct_bookings ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
  }
  SCHEMA_READY.add(db);
}

/* ── resolution ────────────────────────────────────────────────────────────── */

export interface ResolvedBand {
  /**
   * ct_bands.id — what live_band_id stores, and '' when the calendar names an
   * act that is not in the band master. See resolveLiveBand() § UNMASTERED.
   */
  band_id: string;
  /** ct_entertainment.name, spelt as the manager typed it for that night. */
  name: string;
  /** The calendar row itself, for anything that wants to link back to it. */
  calendar_id: string;
  start_time: string;
  end_time: string;
  area: string;
}

/**
 * The Live Band scheduled for `eventDate`, or null if none is.
 *
 * Scoped to (current outlet OR legacy blank) exactly like the What's On board
 * (src/lib/ct/whats-on.ts) — the GRE must not be shown one band and the
 * booking stamped with another. A blank `outletId` therefore matches ONLY
 * blank-outlet rows and never leaks another outlet's band.
 *
 * type = 'band' only. 'dj' and 'live_music' are separate calendar types the
 * manager chooses between, and the guest asking for the Live Band means the
 * band.
 *
 * ORDER BY, in the order the tiebreaks matter:
 *   1. an explicit outlet row beats a legacy blank one (the only non-blank
 *      outlet_id that survives the WHERE is the current outlet, so this rank is
 *      computable client-side too — /crm-calls QuickBookingModal reproduces it
 *      so its warning cannot name a different band than the one we store);
 *   2. a row with a start time beats one without ('' sorts before '18:30' in
 *      plain text, which would otherwise let an untimed entry win);
 *   3. earliest start, then name — with two bands booked, the first on stage is
 *      the one a dinner booking is asking about.
 *
 * ── UNMASTERED ACTS ───────────────────────────────────────────────────────
 * The join to ct_bands is a LEFT JOIN on the name, not an inner one, so band_id
 * comes back '' when the calendar names an act the master does not hold. That
 * happens for calendar rows written before the master existed and for the
 * What's On editor's free-text fallback. A band nobody can look up is still a
 * band the guest was promised, so the NAME is returned and the caller stores
 * it; the id fills itself in later, the first time the relink backfill runs
 * after management adds the act to ct_bands. Refusing to resolve at all would
 * lose the promise; inventing a master row here would let a GRE's booking write
 * management-only data.
 *
 * NOCASE is what makes that join reliable — ct_bands.name is UNIQUE COLLATE
 * NOCASE precisely so 'Agnee' and 'AGNEE' cannot both exist, and the comparison
 * has to use the same collation the uniqueness was enforced under. Stated
 * explicitly rather than inherited from the column so it survives a reorder.
 */
export function resolveLiveBand(db: DB, eventDate: string, outletId: string | null): ResolvedBand | null {
  const oid = (outletId || '').trim();
  const row = db.prepare(`
    SELECT e.id AS calendar_id, e.name, e.start_time, e.end_time, e.area,
           COALESCE(b.id, '') AS band_id
      FROM ct_entertainment e
      LEFT JOIN ct_bands b ON b.name = e.name COLLATE NOCASE
     WHERE e.event_date = ?
       AND e.type = 'band'
       AND TRIM(e.name) <> ''
       AND (e.outlet_id = ? OR e.outlet_id = '')
     ORDER BY (e.outlet_id = '') ASC, (TRIM(e.start_time) = '') ASC, e.start_time ASC, e.name ASC
     LIMIT 1
  `).get(eventDate, oid) as any;
  if (!row) return null;
  return {
    band_id: String(row.band_id || ''),
    name: String(row.name || ''),
    calendar_id: String(row.calendar_id),
    start_time: String(row.start_time || ''),
    end_time: String(row.end_time || ''),
    area: String(row.area || ''),
  };
}
