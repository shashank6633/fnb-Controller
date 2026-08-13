/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Reservation CRM — BOOKING HISTORY (/crm-calls/database → Bookings).
 *
 * GET /api/crm/reservations/bookings
 *       ?q= &status= &from= &to= &guest_id= &import_id= &duplicates= &limit= &offset= &sort= &dir=
 *   → { rows, total, live_total, duplicate_total, duplicates, limit, offset, sort, dir }
 *
 * Rows come from ct_bookings joined to ct_guests for the name and number, so a
 * Reservego row, a phone booking and a walk-in all appear in one history
 * against one guest — the whole point of importing into the existing tables
 * rather than a parallel pair.
 *
 * from/to filter booking_date (the RESERVED date, what a user means by "show me
 * January"), not booking_time (when the booking was created). The two differ
 * whenever someone books ahead, and booking_date is the indexed column.
 *
 * ── WHY IT IS HARD-CAPPED ─────────────────────────────────────────────────
 * limit is clamped to MAX_LIMIT. The owner's ~129 Reservego exports measure
 * 82,088 bookings; an unbounded SELECT serialised to JSON is how this page
 * would die. Bulk extraction is /api/crm/reservations/export, which streams.
 *
 * ── WHO MAY READ IT ───────────────────────────────────────────────────────
 * ADMIN ONLY, matching the adminOnly catalog entry on /crm-calls/database.
 * Tightened from management on the owner's instruction (2026-08-13): reading
 * this list is the same exposure as exporting it, so it carries the same gate
 * rather than sitting one tier below.
 *
 * ── SAME-DAY DUPLICATES: SHOWN, LABELLED, NEVER COUNTED ───────────────────
 * markDuplicateGroups() (src/lib/reservego.ts) decides which stored row IS the
 * visit when a guest was re-booked twice on one evening, and flags the losers
 * is_duplicate = 1. Every metric surface in the CRM already excludes them —
 * ct_guests' lifetime figures, the guest 360, whats-on, winback, ingest — but
 * this list did not, so the Bookings tab said 85,558 while the customer totals
 * behind it added up to 81,982, and the CSV download disagreed with both. Two
 * numbers for one question is worse than either number.
 *
 * The rule, now single: A DUPLICATE IS NEVER COUNTED, AND NEVER HIDDEN FROM A
 * HUMAN READING THE LIST. So the rows keep appearing (with is_duplicate on
 * every row so the screen can label them — hiding a booking the owner can see
 * in Reservego would send him looking for a bug), and the COUNTS are reported
 * separately: `live_total` is the number that means "bookings", `total` is only
 * how many rows this filter paginates over, and `duplicate_total` says how many
 * of them are duplicates. ?duplicates=exclude|only narrows the rows themselves
 * for anyone who wants the clean set or wants to audit the flagged ones; the
 * CSV export takes the identical parameter and ships an "Is Duplicate" column.
 *
 * ── WHY THE TAIL IS FETCHED BACKWARDS, AND WHY IDS COME FIRST ─────────────
 * See readPage() below.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** The live ct_bookings vocabulary — exactly what mapStatus() returns. */
const STATUSES = ['pending', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show'] as const;

/**
 * Sortable columns, as an allowlist keyed to an ORDER BY fragment. The fragment
 * is interpolated into SQL, which is safe ONLY because it can never be anything
 * but one of these literals — never widen this by trusting the query string.
 *
 * booking_date carries slot_time with it: a date alone would shuffle an
 * evening's twenty bookings randomly on every request.
 */
const SORTABLE: Record<string, (dir: string) => string> = {
  booking_date: (d) => `b.booking_date ${d}, b.slot_time ${d}`,
  booking_time: (d) => `b.booking_time ${d}`,
  reserved_time: (d) => `b.reserved_time ${d}`,
  party_size: (d) => `b.party_size ${d}`,
  bill_amount: (d) => `b.bill_amount ${d}`,
  status: (d) => `b.status ${d}`,
  arrived: (d) => `b.arrived ${d}`,
  guest_name: (d) => `g.name ${d}`,
  created_at: (d) => `b.created_at ${d}`,
};
const DEFAULT_SORT = 'booking_date';

/**
 * hasOwnProperty, not a truthiness test on SORTABLE[key]: `?sort=constructor`
 * and `?sort=__proto__` both find something on Object.prototype, and a plain
 * `SORTABLE[sort]` would sail past the allowlist and then throw or emit
 * nonsense SQL. Only keys actually written above are sortable.
 */
const isSortable = (k: string): boolean => Object.prototype.hasOwnProperty.call(SORTABLE, k);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** True only if `d` is a real calendar date — rejects 2026-13-40, 2026-02-31. */
function isRealDate(d: string): boolean {
  const dt = new Date(`${d}T00:00:00Z`);
  return !isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === d;
}

/** Escaped LIKE pattern — see the twin note in ../customers/route.ts. */
function likeContains(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** ASC ⇄ DESC. Used to walk the ordering backwards — see readPage(). */
const flipDir = (d: string): string => (d === 'ASC' ? 'DESC' : 'ASC');

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  // ADMIN ONLY, the whole Reservations Database — owner's decision 2026-08-13,
  // tightened from management. The page holds every guest's phone, email and
  // lifetime spend for ~70,000 people; reading it is the same exposure as
  // exporting it, so the read gate matches the export gate rather than sitting
  // one tier below it.
  if (me.role !== 'admin') return Response.json({ error: 'Admin access required' }, { status: 403 });

  try {
    const db = getDb();
    const sp = new URL(request.url).searchParams;

    const where: string[] = [];
    const params: any[] = [];

    const status = (sp.get('status') || '').trim();
    if (status) {
      if (!(STATUSES as readonly string[]).includes(status)) {
        return Response.json({ error: `status must be one of ${STATUSES.join(', ')}` }, { status: 400 });
      }
      where.push('b.status = ?');
      params.push(status);
    }

    const from = (sp.get('from') || '').trim();
    if (from) {
      if (!DATE_RE.test(from) || !isRealDate(from)) {
        return Response.json({ error: 'from must be a real YYYY-MM-DD date' }, { status: 400 });
      }
      where.push('b.booking_date >= ?');
      params.push(from);
    }
    const to = (sp.get('to') || '').trim();
    if (to) {
      if (!DATE_RE.test(to) || !isRealDate(to)) {
        return Response.json({ error: 'to must be a real YYYY-MM-DD date' }, { status: 400 });
      }
      where.push('b.booking_date <= ?');
      params.push(to);
    }

    const guestId = (sp.get('guest_id') || '').trim();
    if (guestId) { where.push('b.guest_id = ?'); params.push(guestId); }

    // Lets Import History answer "which rows did that upload actually write?"
    // — the reason the importer stamps import_id and indexes it.
    const importId = (sp.get('import_id') || '').trim();
    if (importId) { where.push('b.import_id = ?'); params.push(importId); }

    // include (default) shows every row and labels the duplicates; exclude is
    // the clean set; only is the audit view of what the same-day rule flagged.
    // An unrecognised value is refused rather than silently treated as
    // 'include' — a typo here changes what the numbers mean.
    const dupMode = (sp.get('duplicates') || 'include').trim();
    if (!['include', 'exclude', 'only'].includes(dupMode)) {
      return Response.json({ error: 'duplicates must be include, exclude or only' }, { status: 400 });
    }
    if (dupMode === 'exclude') where.push('COALESCE(b.is_duplicate, 0) = 0');
    if (dupMode === 'only') where.push('COALESCE(b.is_duplicate, 0) = 1');

    const q = (sp.get('q') || '').trim();
    if (q) {
      // Bill number sits alongside the guest columns because the one thing a
      // manager holds in their hand when they come asking is a bill.
      //
      // THE EXPENSIVE FILTER, and the only one worth watching. Measured at
      // 106,000 bookings × 42,000 guests: ~65ms for the page and ~65ms again
      // for its count, so ~130ms of synchronous SQLite per search — every row
      // must be joined to its guest and matched, and no index can serve a
      // leading-wildcard LIKE. Straight after a big import, before SQLite has
      // checkpointed the WAL, the same search measured ~415ms. better-sqlite3
      // is synchronous, so that time is the whole server's: the search box that
      // calls this MUST be debounced, not fired per keystroke.
      const like = likeContains(q);
      where.push(`(g.name LIKE ? ESCAPE '\\' OR g.phone_e164 LIKE ? ESCAPE '\\' OR g.phone10 LIKE ? ESCAPE '\\' OR g.email LIKE ? ESCAPE '\\' OR b.bill_number LIKE ? ESCAPE '\\')`);
      params.push(like, like, like, like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // `sort=-booking_date` is shorthand for sort=booking_date&dir=desc.
    let sortRaw = (sp.get('sort') || '').trim();
    let dirRaw = (sp.get('dir') || '').trim().toLowerCase();
    if (sortRaw.startsWith('-')) { sortRaw = sortRaw.slice(1); if (!dirRaw) dirRaw = 'desc'; }
    const sort = isSortable(sortRaw) ? sortRaw : DEFAULT_SORT;
    const dir = dirRaw === 'asc' ? 'ASC' : dirRaw === 'desc' ? 'DESC' : (sort === 'guest_name' ? 'ASC' : 'DESC');

    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(sp.get('limit') || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT));
    const offset = Math.max(0, parseInt(sp.get('offset') || '0', 10) || 0);

    // The join is needed ONLY when something actually reads a guest column —
    // the `q` search or a sort on the guest's name. ct_guests.id is the primary
    // key, so a LEFT JOIN on it matches at most one row and keeps unmatched
    // bookings: it can neither add nor drop a row, and dropping it when nothing
    // reads g.* is therefore provably the same query. Measured at 82,128
    // bookings: COUNT(*) 17.1ms with the join, 0.0ms without.
    const needsGuestJoin = !!q || sort === 'guest_name';
    const joinSql = needsGuestJoin ? 'LEFT JOIN ct_guests g ON g.id = b.guest_id' : '';

    /**
     * ── THE DEEP-OFFSET FIX ───────────────────────────────────────────────
     * SQLite cannot jump to row 82,000: LIMIT/OFFSET produces every skipped
     * row in sorted order and discards it, so a page costs in proportion to
     * its offset — and better-sqlite3 is synchronous, so that cost is not "a
     * slow page", it is the whole Node process stalled, KOTs and bills
     * included. The pager on /crm-calls/database renders a direct last-page
     * button, which made the worst query on the page a one-click affair.
     *
     * Three changes. Measured end to end through this route on a copy of
     * production seeded to the real Reservego shape (82,128 bookings / 70,324
     * guests), page size 25, before → after in the same run:
     *
     *     last page                    300-420ms → 0.4ms
     *     last page, sort=guest_name   190-230ms →  51ms
     *     midpoint (the new worst case)    ~173ms →  18ms
     *
     * 1. DROP THE JOIN WHEN NOTHING READS IT (see needsGuestJoin above).
     *
     * 2. ONE ID-ONLY PASS, THEN HYDRATE BY PRIMARY KEY. The skipped rows must
     *    still be produced, but as bare ids rather than 40 booking columns
     *    plus four joined guest columns; hydrating the 25 survivors by primary
     *    key costs 0.2ms. Same trick, same reason, as ../export/route.ts.
     *
     * 3. WALK IN FROM WHICHEVER END IS NEARER. `, b.id` makes the ordering
     *    TOTAL, and a total ordering reversed term by term yields exactly the
     *    reversed row sequence. So past the halfway mark the page is read as
     *    the mirror-image page from the far end and flipped back in JS, which
     *    bounds the offset SQLite is ever given at total/2.
     *
     * Why guest_name only falls to 51ms while the default sort falls to 0.4ms:
     * booking_date has an index, so reversed it is walked directly with no
     * temp B-tree at all, whereas g.name has none and must be sorted in full
     * whichever end you start from — the flip saves the rows discarded after
     * the sort, not the sort. That is the floor until someone indexes it, and
     * 51ms is inside budget.
     *
     * An artificial MAX_OFFSET was the other option on the table and was
     * rejected: that pager offers the last page as a single click, so a cap
     * would 400 the exact click this exists to make cheap. Offsets past
     * `total` still cost nothing — the page is empty and no query is issued.
     *
     * All three statements run in ONE deferred read transaction. The flip
     * makes `total` load-bearing (a concurrent insert between the count and
     * the id pass would shift the window and return a page off by one), and it
     * also means the hydrate cannot miss a row the id pass just saw.
     */
    const page = db.transaction(() => {
      // Both counts in ONE pass. A second COUNT(*) would double the cost of the
      // most expensive query on the page (measured at 82k bookings: 17.1ms with
      // the guest join, 0.0ms without), and SUM over a CASE is free once the
      // rows are already being walked.
      const counts = db.prepare(`
        SELECT COUNT(*) AS n,
               SUM(CASE WHEN COALESCE(b.is_duplicate, 0) = 1 THEN 1 ELSE 0 END) AS dups
          FROM ct_bookings b ${joinSql} ${whereSql}
      `).get(...params) as any;
      const n = counts?.n ?? 0;
      const dups = Number(counts?.dups ?? 0);
      if (offset >= n) return { total: n, dups, rows: [] as any[] };

      const fromTail = offset > n / 2;
      const d = fromTail ? flipDir(dir) : dir;
      const tie = fromTail ? 'DESC' : 'ASC';
      // Rows [offset, offset+take) from the front are the same rows as
      // [n-offset-take, n-offset) from the back. `take` shrinks on a partial
      // last page; the clamp stops a page that straddles the head of the
      // reversed order from asking for a negative OFFSET.
      const take = Math.min(limit, n - offset);
      const off = fromTail ? Math.max(0, n - offset - take) : offset;

      // `, b.id` is the tiebreak, load-bearing twice over: a busy Saturday has
      // dozens of bookings sharing a date and slot and SQLite gives no stable
      // order within a tie (page 2 would repeat page 1), and without a total
      // order the reversal above would not be exact.
      const ids = (db.prepare(`
        SELECT b.id FROM ct_bookings b ${joinSql} ${whereSql}
        ORDER BY ${SORTABLE[sort](d)}, b.id ${tie}
        LIMIT ? OFFSET ?
      `).all(...params, take, off) as any[]).map((r) => String(r.id));
      if (fromTail) ids.reverse();
      if (!ids.length) return { total: n, dups, rows: [] as any[] };

      // The guest columns are part of the response shape, so this join is not
      // optional the way the one above is — but here it runs against 25 rows.
      const hydrated = db.prepare(`
        SELECT b.*,
               g.name       AS guest_name,
               g.phone_e164 AS guest_phone,
               g.phone10    AS guest_phone10,
               g.email      AS guest_email
        FROM ct_bookings b
        LEFT JOIN ct_guests g ON g.id = b.guest_id
        WHERE b.id IN (${ids.map(() => '?').join(',')})
      `).all(...ids) as any[];
      // IN (…) returns rows in SQLite's order, not the id list's, so the page
      // is put back into the requested sort order before it is returned.
      const byId = new Map<string, any>(hydrated.map((r) => [String(r.id), r]));
      return { total: n, dups, rows: ids.map((id) => byId.get(id)).filter(Boolean) };
    })();
    const { total, dups, rows } = page;

    return Response.json(
      {
        rows,
        // `total` paginates; `live_total` is what the word "bookings" means.
        // Both are shipped because the pager needs the first and every human
        // reading a number needs the second — and a client that reads only
        // `total` is at least reading the count of the rows it was handed.
        total,
        live_total: total - dups,
        duplicate_total: dups,
        duplicates: dupMode,
        limit, offset, sort, dir: dir.toLowerCase(),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e: any) {
    console.error('[GET /api/crm/reservations/bookings]', e);
    return Response.json({ error: e?.message || 'Failed to load bookings' }, { status: 500 });
  }
}
