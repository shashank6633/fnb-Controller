/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import {
  parseReservationFilter,
  runReservationQuery,
  queryOptions,
  ReservationQueryError,
} from '@/lib/reservation-query';

/**
 * Reservation CRM — THE GUIDED QUERY (/crm-calls/database → Query).
 *
 *   GET  /api/crm/reservations/query
 *        → { schema, statuses, meal_periods, dow, sources, outlets, bands,
 *            band_lead_in_minutes, sortable, limits }
 *        Everything the tab needs to BUILD a question: the table and column
 *        names it is filtering, and the values actually present in the data.
 *
 *   POST /api/crm/reservations/query   { dow, mealPeriod, from, to, timeFrom,
 *        timeTo, status[], source[], liveBandId, outlet, duplicates, sort, dir,
 *        limit, offset }
 *        → { rows, total, duplicate_total, aggregates, band, filter, took_ms }
 *
 * ── WHY POST FOR A READ ───────────────────────────────────────────────────
 * The body is a FILTER OBJECT — arrays of weekdays, statuses and sources — and
 * a JSON body is where a nested object belongs; squeezing it into a query
 * string invites the client to invent an encoding and the server to guess at
 * it. It also keeps 70,342 guests' worth of query terms out of URLs, logs and
 * the browser's history. Nothing here writes: force-dynamic + no-store carry
 * the "this is a read" contract instead of the verb.
 *
 * ── NO SQL CROSSES THIS BOUNDARY ──────────────────────────────────────────
 * The client never sends a statement or a fragment of one. parseReservationFilter()
 * refuses anything outside the allowlist and runReservationQuery() assembles
 * the SQL with bound parameters — see src/lib/reservation-query.ts.
 *
 * ── WHO MAY READ IT ───────────────────────────────────────────────────────
 * ADMIN ONLY, identical to the rest of /api/crm/reservations/* and to the
 * adminOnly catalog entry on /crm-calls/database. This route answers with guest
 * names, phone numbers and lifetime spend across the whole archive; if anything
 * it is a wider read than the Bookings list, so it can never sit below its gate.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** The gate, spelt once. Returns a Response when the caller may NOT read. */
async function guard(): Promise<Response | null> {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (me.role !== 'admin') return Response.json({ error: 'Admin access required' }, { status: 403 });
  return null;
}

export async function GET() {
  const denied = await guard();
  if (denied) return denied;
  try {
    return Response.json(queryOptions(getDb()), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    console.error('[GET /api/crm/reservations/query]', e);
    return Response.json({ error: e?.message || 'Failed to load query options' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const denied = await guard();
  if (denied) return denied;
  try {
    // A malformed body is the caller's mistake, not a 500 — and it must not be
    // reported as "no filters", which would answer the whole archive.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'Body must be a JSON filter object' }, { status: 400 });
    }

    const filter = parseReservationFilter(body ?? {});
    return Response.json(runReservationQuery(getDb(), filter), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    // A ReservationQueryError is a message written FOR the person who built the
    // question ("from must not be after to"), so it is passed through verbatim
    // with its own status; anything else is ours and stays a 500.
    if (e instanceof ReservationQueryError) {
      return Response.json({ error: e.message }, { status: e.status });
    }
    console.error('[POST /api/crm/reservations/query]', e);
    return Response.json({ error: e?.message || 'Query failed' }, { status: 500 });
  }
}
