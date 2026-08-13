/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ct_guests lifetime metrics — the ONE writer every non-import path calls.
 *
 * ── THE BUG THIS FILE EXISTS TO CLOSE ──────────────────────────────────────
 * The lifetime figures on ct_guests (total_bookings, arrived_visits,
 * arrival_rate, total_spend, first/last_booking …) are a denormalised cache of
 * that guest's ct_bookings rows. Until this module they had exactly ONE writer,
 * rollupMetrics() at finishImport — while FOUR code paths changed the rows the
 * cache summarises:
 *
 *   1. the Reservego importer                     (reservego-import.ts, refreshes)
 *   2. PUT /api/crm-calls/bookings/:id            (status + date + party_size)
 *   3. seatBooking()      → status 'seated'       (src/lib/ct/seating.ts)
 *   4. completeBookingForOrder() → 'completed'    (src/lib/ct/seating.ts, on settle)
 *
 * Paths 2–4 wrote the booking and left the cache. Reproduced on a copy of
 * production loaded with all 129 real Reservego exports (85,598 bookings,
 * 70,342 guests): a guest whose two bookings both arrived reads arrival_rate
 * 1.0; cancel one through the CRM and the stored row STAYS at arrived_visits 2,
 * cancelled_bookings 0, arrival_rate 1.0 — three columns wrong, permanently,
 * because nothing else ever revisits that guest. /crm-calls/database (the
 * Customers list) reads those stored numbers while /crm-calls/guests/[id]
 * aggregates live, so the two screens then report different histories for the
 * same person — the exact failure the invariant at
 * src/app/api/crm/reservations/customers/route.ts:15-24 promises cannot happen
 * ("nothing is re-derived here, so the Customers list can never disagree with
 * the guest 360 or the CSV export"). That promise is only true if every writer
 * of a booking refreshes the cache, so here is the refresher.
 *
 * ── WHY THIS IS NOT SOLVED BY DROPPING THE CACHE ───────────────────────────
 * Because the cache is load-bearing at this size. Measured on the owner's real
 * archive: 85,598 bookings over 70,342 guests. Aggregating that per page view
 * is a full scan and a GROUP BY on every keystroke of the Customers search box
 * (see db.ts § B and the customers route header). The fix is to give the cache
 * a single, cheap, correct writer — not to delete it.
 *
 * ── ONE DEFINITION, NOT A SECOND OPINION ───────────────────────────────────
 * The numbers are produced by computeGuestMetrics() from src/lib/reservego.ts —
 * the same function the importer's rollupMetrics() calls — over the same row
 * set (this guest's bookings, is_duplicate excluded) with `arrived` derived
 * from isArrived(status, seated_at) rather than read from the ct_bookings
 * .arrived column. That last point is not a style choice: `arrived` is itself a
 * cache the importer writes, and Reservego leaves a stale Seated Time on rows
 * it later cancels (reservego.ts:146-156), so trusting the column here would
 * reintroduce the "never came, reads as 100% arrival" bug on the CRM side.
 *
 * Consequence, and the property to test: refreshing a guest through this module
 * must land on exactly what a from-scratch rollup would write for them. The two
 * are held together by sharing computeGuestMetrics and the row filter, so a
 * change to either must be made in reservego.ts where both callers see it.
 *
 * ── WHY A NEW FILE AND NOT src/lib/ct/metrics.ts ───────────────────────────
 * metrics.ts owns a DIFFERENT and unrelated GuestMetrics: the call-CRM's live
 * aggregates (calls, conversion_rate, badge) computed per request and never
 * stored. Adding the stored-lifetime writer there would put two exported types
 * of the same name and two meanings of "guest metrics" in one module. These are
 * the reservation lifetime metrics; they live next door.
 *
 * ── SCHEMA ASSUMPTION ──────────────────────────────────────────────────────
 * The columns written here and the is_duplicate column filtered on are created
 * by the same migration block (src/lib/db.ts:4849-4991, addRB('is_duplicate')
 * and the addG() metric columns), which getDb() runs before any caller can
 * reach this function. They arrive together or not at all, so there is no
 * defensive PRAGMA here — a guard for one would be a lie about the other.
 */
import type Database from 'better-sqlite3';
import { computeGuestMetrics, isArrived, type BookingStatus } from '@/lib/reservego';

type DB = Database.Database;

/** Column-value equality in text form, matching how the importer decides a
 *  metric row is unchanged: SQLite hands REAL/INTEGER/TEXT back in mixed JS
 *  types, and comparing the rendered value is what makes 0 and 0.0 the same
 *  answer instead of a phantom write. */
const same = (a: unknown, b: unknown): boolean =>
  (a === null || a === undefined ? '' : String(a)) === (b === null || b === undefined ? '' : String(b));

/** Guests per statement. Well under the bind ceiling — measured on the bundled
 *  better-sqlite3 12.8.0, an IN list accepts 32,766 parameters and fails at
 *  32,767 — and set to 400 to match listMetricsForGuests() in metrics.ts, so
 *  the two batched guest readers behave alike. Callers in practice pass ONE. */
const CHUNK = 400;

const SELECT_STORED = `
  SELECT id, total_bookings, arrived_visits, cancelled_bookings, no_shows, arrival_rate,
         total_pax, total_spend, avg_spend, first_booking, last_booking, booking_sources,
         visit_frequency_days, metrics_updated_at
    FROM ct_guests`;

const UPDATE_METRICS = `
  UPDATE ct_guests SET
    total_bookings = ?, arrived_visits = ?, cancelled_bookings = ?, no_shows = ?,
    arrival_rate = ?, total_pax = ?, total_spend = ?, avg_spend = ?,
    first_booking = ?, last_booking = ?, booking_sources = ?, visit_frequency_days = ?,
    metrics_updated_at = ?
  WHERE id = ?`;

/**
 * Recompute and store the lifetime metrics for these guests.
 *
 * Call it after ANY write that changes what a guest's bookings say — a status
 * transition, a moved date, a changed party size, a new or removed booking —
 * passing the guest(s) whose rows moved. Returns the number of guest rows
 * actually rewritten (0 when the numbers had not moved, which is the common
 * case for an edit that touched only notes).
 *
 * CHEAP FOR ONE GUEST, which is what paths 2–4 above always pass: one PK read
 * of the stored row plus one index seek on idx_ct_bookings_guest for that
 * guest's bookings. Measured against the 85,598-booking / 70,342-guest copy —
 * 0.043ms for a typical two-booking guest, 0.104ms for the heaviest guest in
 * the whole archive (66 bookings), against 982ms for the equivalent full
 * rollup. That is what makes it affordable on an interactive request instead of
 * a nightly job.
 *
 * NOT A TRANSACTION OF ITS OWN, because the booking write and this refresh
 * belong in ONE — a cache that can half-update is worse than one that never
 * updates, since nothing afterwards signals which half landed. All three
 * callers therefore wrap the pair. (better-sqlite3 would turn an inner
 * transaction into a SAVEPOINT rather than break the outer one, so this is
 * about not pretending to a commit boundary that isn't ours, and about not
 * paying for a savepoint on every call.) The reads here see the caller's
 * uncommitted UPDATE because better-sqlite3 is synchronous and single-
 * connection: same tick, same transaction, same rows.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: re-decide is_duplicate. That verdict is
 * taken over a guest's whole stored Reservego history at import time
 * (markImportDuplicates), and a CRM status edit is not evidence about which of
 * two same-evening Reservego rows was the real visit. The metrics here honour
 * the standing verdict; the next import re-decides it.
 */
export function refreshGuestMetrics(
  db: DB,
  guestIds: Iterable<string> | string | null | undefined,
): number {
  const ids = normalizeIds(guestIds);
  if (!ids.length) return 0;

  let written = 0;
  const upd = db.prepare(UPDATE_METRICS);
  const at = new Date().toISOString();

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const ph = chunk.map(() => '?').join(',');

    const stored = new Map<string, any>();
    for (const g of db.prepare(`${SELECT_STORED} WHERE id IN (${ph})`).all(...chunk) as any[]) {
      stored.set(String(g.id), g);
    }

    // RECONCILE ct_bookings.arrived FIRST, because this function is the only
    // thing in the app that ever puts it right.
    //
    // arrived is a plain cached column with several writers — the importer, the
    // Seat board, order settle, and the status PUT — and none of the last three
    // maintained it, so a booking seated or cancelled through the CRM kept
    // whatever the import decided. The metrics below never noticed, because they
    // re-derive arrival in memory from status + seated_at; the stale value only
    // surfaced downstream, in the Bookings list, the CSV export and the new
    // Query tab, which read the column. Two screens then disagreed about whether
    // the same guest turned up.
    //
    // The CASE mirrors isArrived() in src/lib/reservego.ts exactly — cancelled
    // and no_show are never arrivals however stale a Seated Time looks, because
    // Reservego leaves that stamp behind on rows it later cancels. The rule is
    // written twice, in JS and in SQL, which is the drift risk this repo keeps
    // getting bitten by; it is deliberate here because the alternative is
    // reading every row into JS to write one integer back, and the two live four
    // lines apart. Change one, change the other.
    db.prepare(`
      UPDATE ct_bookings
         SET arrived = CASE
               WHEN status IN ('cancelled', 'no_show')  THEN 0
               WHEN status IN ('completed', 'seated')   THEN 1
               WHEN COALESCE(TRIM(seated_at), '') <> '' THEN 1
               ELSE 0 END
       WHERE guest_id IN (${ph})
         AND arrived IS NOT CASE
               WHEN status IN ('cancelled', 'no_show')  THEN 0
               WHEN status IN ('completed', 'seated')   THEN 1
               WHEN COALESCE(TRIM(seated_at), '') <> '' THEN 1
               ELSE 0 END
    `).run(...chunk);

    // Grouped in JS off one ordered read. .all() rather than the importer's
    // .iterate() on purpose: this set is bounded by CHUNK, and an open
    // better-sqlite3 iterator holds the single app connection busy for its
    // lifetime — a risk worth taking for an 82k-row import pass and not worth
    // taking to refresh one guest mid-request.
    const rows = db.prepare(`
      SELECT b.guest_id, b.status, b.seated_at, b.party_size, b.bill_amount,
             b.booking_date, b.source
        FROM ct_bookings b
       WHERE b.guest_id IN (${ph})
         AND COALESCE(b.is_duplicate, 0) = 0
       ORDER BY b.guest_id
    `).all(...chunk) as any[];

    const grouped = new Map<string, Array<{
      status: BookingStatus | null; arrived: boolean; pax: number;
      billAmount: number | null; bookingDate: string; source: string;
    }>>();
    for (const r of rows) {
      const gid = String(r.guest_id || '');
      if (!gid) continue;
      // The column already holds our own status vocabulary, so it is cast
      // rather than re-mapped: mapStatus() reads Reservego's spellings, not
      // ours, and a value outside the vocabulary simply matches no comparison.
      const status = (r.status ? String(r.status) : null) as BookingStatus | null;
      const g = grouped.get(gid);
      const row = {
        status,
        arrived: isArrived(status, r.seated_at ? String(r.seated_at) : ''),
        pax: Number(r.party_size) || 0,
        billAmount: r.bill_amount === null || r.bill_amount === undefined ? null : Number(r.bill_amount),
        bookingDate: String(r.booking_date || ''),
        source: String(r.source || ''),
      };
      if (g) g.push(row); else grouped.set(gid, [row]);
    }

    for (const id of chunk) {
      // A guest with no countable bookings still gets zeros written, not left
      // blank — a guest whose only booking was just deleted, or whose every row
      // is a duplicate, must read 0 rather than keep yesterday's totals.
      const m = computeGuestMetrics(grouped.get(id) || []);
      const row = [
        m.total_bookings, m.arrived_visits, m.cancelled_bookings, m.no_shows, m.arrival_rate,
        m.total_pax, m.total_spend, m.avg_spend, m.first_booking, m.last_booking,
        JSON.stringify(m.sources), m.visit_frequency_days,
      ];
      const before = stored.get(id);
      if (!before) continue;                       // no such guest row to update
      // Skip the write when nothing moved — except for a guest never rolled up,
      // whose NULL metrics_updated_at must be stamped or the next import will
      // keep picking them up as un-initialised. Same rule as rollupMetrics.
      const unchanged = before.metrics_updated_at && [
        before.total_bookings, before.arrived_visits, before.cancelled_bookings, before.no_shows,
        before.arrival_rate, before.total_pax, before.total_spend, before.avg_spend,
        before.first_booking, before.last_booking, before.booking_sources, before.visit_frequency_days,
      ].every((v, k) => same(v, row[k]));
      if (unchanged) continue;
      // updated_at is left alone on purpose: metrics_updated_at exists so that a
      // refresh does not look like someone edited the profile.
      written += upd.run(...row, at, id).changes;
    }
  }
  return written;
}

/** Accepts one id, a list, or a Set; drops blanks and duplicates. */
function normalizeIds(input: Iterable<string> | string | null | undefined): string[] {
  if (input === null || input === undefined) return [];
  const out = new Set<string>();
  if (typeof input === 'string') {
    const s = input.trim();
    if (s) out.add(s);
  } else {
    for (const v of input) {
      const s = String(v ?? '').trim();
      if (s) out.add(s);
    }
  }
  return [...out];
}
