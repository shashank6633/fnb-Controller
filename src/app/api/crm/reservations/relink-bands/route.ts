/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { ensureLiveBandSchema, resolveLiveBand, PREF_LIVE_BAND } from '@/lib/ct/live-band';

/**
 * Reservation CRM — LIVE BAND BACKFILL (/api/crm/reservations/relink-bands).
 *
 * GET  ?from=&to=[&mode=]  → preview. Reads only; reports what an apply would do.
 * POST { from, to, mode? } → apply.
 *
 * WHY IT EXISTS. A Live Band booking is stamped with the band at the moment it
 * is taken (see the POST in /api/crm-calls/bookings). Bookings therefore run
 * ahead of the calendar: the guest asks for band night in three weeks, the
 * manager fills that date in a fortnight later, and every booking already taken
 * for it holds a blank. This re-runs the same resolution over a date range once
 * the calendar has caught up — including backwards over history, which is the
 * owner's actual use for it.
 *
 * mode = 'fill' (default) touches only bookings with no band recorded — the
 * backfill case, and it can never overwrite what a guest was actually told.
 * mode = 'refresh' also corrects rows whose stored band no longer matches the
 * calendar, for when a wrong entry is fixed after the fact. Nothing is ever
 * cleared: a date that has since lost its calendar entry keeps the band the
 * booking was taken against, because that is what was promised.
 *
 * ── WHO MAY RUN IT ────────────────────────────────────────────────────────
 * ADMIN ONLY, matching every other /api/crm/reservations/* route and the
 * adminOnly catalog entry on /crm-calls/database. This one writes across the
 * whole booking history, so it could not sit any lower.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** True only if `d` is a real calendar date — rejects 2026-13-40, 2026-02-31. */
function isRealDate(d: string): boolean {
  const dt = new Date(`${d}T00:00:00Z`);
  return !isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === d;
}

const DAY_MS = 86_400_000;
/**
 * Five years. The archive is ~85,558 bookings over a few years, so this is
 * "the whole history" with room to spare rather than a throttle — the cap is
 * here so a typo'd year (0202-…) cannot ask SQLite to walk a range that is not
 * a range. The scan itself is cheap: booking_date is indexed, and only rows
 * that carry the Live Band preference are grouped.
 */
const MAX_RANGE_DAYS = 5 * 366;

/** Dates listed back to the caller. Enough to act on; not a second archive. */
const MAX_LISTED_DATES = 200;

const MODES = ['fill', 'refresh'] as const;

interface RelinkResult {
  from: string;
  to: string;
  mode: string;
  applied: boolean;
  /** Distinct booking_dates in range that have Live Band bookings. */
  dates_with_bookings: number;
  /** …of those, how many have a band on the calendar. */
  dates_resolved: number;
  /** Live Band bookings in range, whatever their current band. */
  bookings_matched: number;
  /** Rows this run wrote (or would write). */
  bookings_updated: number;
  /** Live Band bookings still left with no band id after this run. */
  bookings_unresolved: number;
  /** The dates the owner still has to fill in, oldest first (capped). */
  dates_without_band: { date: string; bookings: number }[];
  dates_without_band_total: number;
  /**
   * Dates where the calendar DOES name a band but ct_bands does not hold it —
   * a different job from the list above (add the act to the band master, not
   * to the calendar) and therefore a different list. Reported rather than
   * written, because live_band_id exists to be an id.
   */
  dates_without_band_master: { date: string; band: string; bookings: number }[];
  dates_without_band_master_total: number;
}

/**
 * One pass over the range, either counting or writing.
 *
 * Grouped by date, not per booking: a Saturday with forty Live Band bookings is
 * one calendar lookup and one UPDATE, so the whole history costs one query per
 * distinct date rather than one per row.
 *
 * The whole thing runs in a single transaction. In apply mode that is
 * atomicity; in preview mode it is consistency — the numbers a human reads and
 * then acts on must all describe the same instant.
 */
function relink(db: ReturnType<typeof getDb>, from: string, to: string, mode: string, apply: boolean, outletId: string | null): RelinkResult {
  const now = new Date().toISOString();

  const run = db.transaction((): RelinkResult => {
    ensureLiveBandSchema(db);

    const groups = db.prepare(`
      SELECT booking_date AS d,
             COUNT(*) AS n,
             SUM(CASE WHEN live_band_id = '' THEN 1 ELSE 0 END) AS blanks
        FROM ct_bookings
       WHERE preference = ?
         AND booking_date >= ? AND booking_date <= ?
       GROUP BY booking_date
       ORDER BY booking_date ASC
    `).all(PREF_LIVE_BAND, from, to) as any[];

    const res: RelinkResult = {
      from, to, mode, applied: apply,
      dates_with_bookings: groups.length,
      dates_resolved: 0,
      bookings_matched: 0,
      bookings_updated: 0,
      bookings_unresolved: 0,
      dates_without_band: [],
      dates_without_band_total: 0,
      dates_without_band_master: [],
      dates_without_band_master_total: 0,
    };

    // 'fill' only touches rows with nothing recorded; 'refresh' also corrects a
    // row pointing at a different band. Neither can blank a row out — the
    // resolved id is non-empty by construction whenever this UPDATE runs.
    const whereTail = mode === 'refresh' ? `AND live_band_id <> ?` : `AND live_band_id = ''`;
    const update = db.prepare(`
      UPDATE ct_bookings
         SET live_band = ?, live_band_id = ?, updated_at = ?
       WHERE preference = ? AND booking_date = ? ${whereTail}
    `);
    const countStale = db.prepare(`
      SELECT COUNT(*) AS n FROM ct_bookings
       WHERE preference = ? AND booking_date = ? AND live_band_id <> ?
    `);

    for (const g of groups) {
      const date = String(g.d);
      const n = Number(g.n || 0);
      const blanks = Number(g.blanks || 0);
      res.bookings_matched += n;

      const band = resolveLiveBand(db, date, outletId);
      if (!band) {
        // No calendar entry — the rows keep whatever they hold (usually blank).
        res.bookings_unresolved += blanks;
        res.dates_without_band_total += 1;
        if (res.dates_without_band.length < MAX_LISTED_DATES) {
          res.dates_without_band.push({ date, bookings: n });
        }
        continue;
      }
      if (!band.band_id) {
        // The calendar names an act ct_bands does not hold, so there is no id to
        // write and writing the name alone would leave live_band_id = '' — this
        // same run's work set, found again on every future run, reporting
        // progress that never lands. Reported instead, with the name, because
        // the fix is one click in the band master.
        //
        // The Quick Booking POST and the Reservego importer both DO store the
        // bare name in that situation, and that is not a contradiction: they
        // are recording what was promised on a night as it happens. This is a
        // backfill whose entire product is the id.
        res.bookings_unresolved += blanks;
        res.dates_without_band_master_total += 1;
        if (res.dates_without_band_master.length < MAX_LISTED_DATES) {
          res.dates_without_band_master.push({ date, band: band.name, bookings: n });
        }
        continue;
      }
      res.dates_resolved += 1;

      if (mode === 'refresh') {
        const would = Number((countStale.get(PREF_LIVE_BAND, date, band.band_id) as any)?.n ?? 0);
        res.bookings_updated += apply
          ? update.run(band.name, band.band_id, now, PREF_LIVE_BAND, date, band.band_id).changes
          : would;
      } else {
        res.bookings_updated += apply
          ? update.run(band.name, band.band_id, now, PREF_LIVE_BAND, date).changes
          : blanks;
      }
    }
    return res;
  });

  return run();
}

/** Shared argument parse. Query string and JSON body are both accepted. */
function parse(req: Request, body: Record<string, any>): { ok: true; from: string; to: string; mode: string } | { ok: false; res: Response } {
  const sp = new URL(req.url).searchParams;
  const pick = (k: string) => String(body[k] ?? sp.get(k) ?? '').trim();

  const from = pick('from');
  const to = pick('to');
  for (const [label, v] of [['from', from], ['to', to]] as const) {
    if (!v) return { ok: false, res: Response.json({ error: `${label} is required (YYYY-MM-DD)` }, { status: 400 }) };
    if (!DATE_RE.test(v) || !isRealDate(v)) {
      return { ok: false, res: Response.json({ error: `${label} must be a real YYYY-MM-DD date` }, { status: 400 }) };
    }
  }
  if (from > to) {
    return { ok: false, res: Response.json({ error: 'from must not be after to' }, { status: 400 }) };
  }
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
  if (days > MAX_RANGE_DAYS) {
    return { ok: false, res: Response.json({ error: `Range is ${days} days; the maximum is ${MAX_RANGE_DAYS}` }, { status: 400 }) };
  }

  const rawMode = pick('mode') || 'fill';
  if (!(MODES as readonly string[]).includes(rawMode)) {
    return { ok: false, res: Response.json({ error: `mode must be ${MODES.join(' or ')}` }, { status: 400 }) };
  }
  return { ok: true, from, to, mode: rawMode };
}

async function requireAdmin(): Promise<Response | null> {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (me.role !== 'admin') return Response.json({ error: 'Admin access required' }, { status: 403 });
  return null;
}

export async function GET(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const args = parse(req, {});
  if (!args.ok) return args.res;

  try {
    const out = relink(getDb(), args.from, args.to, args.mode, false, await getCurrentOutletId());
    return Response.json(out, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    console.error('[GET /api/crm/reservations/relink-bands]', e);
    return Response.json({ error: e?.message || 'Preview failed' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    // A POST with no body is a legitimate "use the query string" call; only an
    // actually malformed one is worth refusing, and that is indistinguishable
    // here from empty — so fall through with {} and let parse() do the shouting.
    body = {};
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};

  const args = parse(req, body);
  if (!args.ok) return args.res;

  try {
    const out = relink(getDb(), args.from, args.to, args.mode, true, await getCurrentOutletId());
    return Response.json({ success: true, ...out });
  } catch (e: any) {
    console.error('[POST /api/crm/reservations/relink-bands]', e);
    return Response.json({ error: e?.message || 'Relink failed' }, { status: 500 });
  }
}
