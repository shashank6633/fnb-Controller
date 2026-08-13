/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Reservation CRM — the CUSTOMER MASTER (/crm-calls/database → Customers).
 *
 * GET /api/crm/reservations/customers?q=&limit=&offset=&sort=&dir=
 *   → { rows, total, limit, offset, sort, dir }
 *
 * One row per ct_guests record, carrying the lifetime metrics the importer
 * denormalised onto the guest (total_bookings, arrived_visits, arrival_rate,
 * total_spend, first/last booking …).
 *
 * ── WHY THE METRICS ARE READ AND NEVER RECOMPUTED HERE ────────────────────
 * The obvious version of this endpoint joins ct_bookings and aggregates per
 * guest on every page view. At the production size — ~106,000 bookings against
 * ~40,000 guests — that is a full scan and a GROUP BY for a screen showing 50
 * rows, repeated on every keystroke of the search box. The importer already
 * computes each guest's figures once, at the end of an import (a full rollup
 * measured at 12ms), and writes them onto ct_guests. This route only reads
 * them. computeGuestMetrics() in src/lib/reservego.ts remains the single
 * definition of what those numbers MEAN; nothing is re-derived here, so the
 * Customers list can never disagree with the guest 360 or the CSV export.
 *
 * ── WHY IT IS HARD-CAPPED ─────────────────────────────────────────────────
 * limit is clamped to MAX_LIMIT. An unbounded SELECT would serialise 70,000
 * guest objects into one JSON body — tens of megabytes the browser then has to
 * parse — which is exactly how this page would die in production. There is no
 * "give me everything" mode: bulk extraction is the CSV export, which streams.
 *
 * ── WHO MAY READ IT ───────────────────────────────────────────────────────
 * ADMIN ONLY, matching the adminOnly catalog entry on /crm-calls/database.
 * Every row is one guest's phone, email and LIFETIME SPEND, and the list runs
 * to ~70,000 of them. Note the deliberate asymmetry with the dine-in guest
 * surfaces, which are open to all staff: a captain seeing the guest in front of
 * them is not a floor phone browsing 70,297 spend profiles. Tightened from
 * management on the owner's instruction (2026-08-13) — reading the master and
 * exporting it are the same exposure, so they carry the same gate.
 *
 * ── WHY THE TAIL IS FETCHED BACKWARDS ─────────────────────────────────────
 * See readPage() below. Short version: the pager on /crm-calls/database renders
 * a direct last-page button, and a plain deep OFFSET makes that click the most
 * expensive query on the page.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Sortable columns, as an allowlist. The chosen name is interpolated straight
 * into the ORDER BY — which is safe ONLY because it can never be anything but
 * one of these literals. Never widen this by trusting the query string.
 */
const SORTABLE = [
  'name', 'phone10', 'total_bookings', 'arrived_visits', 'cancelled_bookings',
  'no_shows', 'arrival_rate', 'total_pax', 'total_spend', 'avg_spend',
  'first_booking', 'last_booking', 'visit_frequency_days', 'metrics_updated_at',
  'created_at', 'updated_at',
] as const;
type Sortable = (typeof SORTABLE)[number];
const DEFAULT_SORT: Sortable = 'last_booking';

/**
 * A LIKE pattern for a search box. The wildcards are escaped rather than passed
 * through: a stray '_' or a guest searching for '50%' would otherwise match
 * every row and the pager would cheerfully report 40,000 hits.
 */
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

    const q = (sp.get('q') || '').trim();
    if (q) {
      // Four columns because the owner searches by whatever they have to hand:
      // a name, the number as typed, the last-10-digit key the importer stores,
      // or an email. Measured at 42,000 guests: 8ms for the page, 6ms for the
      // count — a full scan, but a cheap one, and a leading-wildcard LIKE can
      // use no index anyway.
      const like = likeContains(q);
      where.push(`(name LIKE ? ESCAPE '\\' OR phone_e164 LIKE ? ESCAPE '\\' OR phone10 LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')`);
      params.push(like, like, like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // `sort=-last_booking` is accepted as shorthand for sort=last_booking&dir=desc,
    // because that is how table headers usually encode a direction toggle.
    let sortRaw = (sp.get('sort') || '').trim();
    let dirRaw = (sp.get('dir') || '').trim().toLowerCase();
    if (sortRaw.startsWith('-')) { sortRaw = sortRaw.slice(1); if (!dirRaw) dirRaw = 'desc'; }
    const sort: Sortable = (SORTABLE as readonly string[]).includes(sortRaw)
      ? (sortRaw as Sortable)
      : DEFAULT_SORT;
    // Names read naturally A→Z; every metric and date is interesting from the
    // top down, so they default the other way.
    const dir = dirRaw === 'asc' ? 'ASC' : dirRaw === 'desc' ? 'DESC' : (sort === 'name' || sort === 'phone10' ? 'ASC' : 'DESC');

    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(sp.get('limit') || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT));
    const offset = Math.max(0, parseInt(sp.get('offset') || '0', 10) || 0);

    /**
     * ── THE DEEP-OFFSET FIX ───────────────────────────────────────────────
     * SQLite has no way to jump to row 70,000: LIMIT/OFFSET produces every
     * skipped row in sorted order and throws it away, so the cost of a page
     * grows linearly with its offset. better-sqlite3 is synchronous, so that
     * is not "a slow page" — it is the whole Node process, KOTs and bills
     * included, stalled for the duration.
     *
     * `, id` makes the ordering TOTAL, and a total ordering reversed term by
     * term yields exactly the reversed row sequence. So the last page can be
     * read as the FIRST page of the reversed order and flipped back in JS.
     * Past the halfway mark this route therefore walks in from whichever end
     * is nearer, which bounds the offset actually given to SQLite at total/2.
     * Measured end to end through this route on a copy of production seeded to
     * the real Reservego shape (70,324 guests), page size 25: the last page
     * goes from 70ms to 5.9ms, and the worst case moves to the midpoint
     * instead of sitting on the page every user clicks. The twin fix, with the
     * fuller note and an id-only pass this route does not need (14 columns, no
     * join), is in ../bookings/route.ts.
     *
     * An artificial MAX_OFFSET was the other option and was rejected: the
     * pager in /crm-calls/database renders a direct last-page button, so a cap
     * would 400 the single click this fix exists to make cheap. Absurd offsets
     * still cost nothing — beyond `total` the page is empty and no query runs.
     *
     * count + page run in ONE deferred read transaction because the flip makes
     * `total` load-bearing: a row inserted between the two statements would
     * shift the window and hand back a page that is off by one.
     */
    const page = db.transaction(() => {
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM ct_guests ${whereSql}`).get(...params) as any)?.n ?? 0;
      if (offset >= n) return { total: n, rows: [] as any[] };

      const fromTail = offset > n / 2;
      const d = fromTail ? flipDir(dir) : dir;
      const tie = fromTail ? 'DESC' : 'ASC';
      // Rows [offset, offset+take) counted from the front are the same rows as
      // [n-offset-take, n-offset) counted from the back. `take` shrinks on a
      // partial last page; the OFFSET clamp keeps a page that straddles the
      // head of the reversed order from going negative.
      const take = Math.min(limit, n - offset);
      const off = fromTail ? Math.max(0, n - offset - take) : offset;

      // `, id` is the tiebreak, and it is load-bearing twice over: tens of
      // thousands of guests share a last_booking of '' or a total_spend of 0
      // and SQLite gives no stable order within a tie (page 2 would repeat
      // page 1), and without a total order the reversal above is not exact.
      const r = db.prepare(`
        SELECT * FROM ct_guests
        ${whereSql}
        ORDER BY ${sort} ${d}, id ${tie}
        LIMIT ? OFFSET ?
      `).all(...params, take, off) as any[];

      return { total: n, rows: fromTail ? r.reverse() : r };
    })();
    const { total, rows } = page;

    return Response.json(
      { rows, total, limit, offset, sort, dir: dir.toLowerCase() },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e: any) {
    console.error('[GET /api/crm/reservations/customers]', e);
    return Response.json({ error: e?.message || 'Failed to load customers' }, { status: 500 });
  }
}
