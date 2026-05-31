import { readSheet } from '@/lib/sheets-client';
import { mapRowToPartyBooking, PartyBooking } from '@/lib/party-bookings-mapper';
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Party Bookings — reads the "Party Bookings" tab of the AKAN Party Manager
 * Google Sheet. We only care about Party Unique ID + Final Total Amount
 * (col U) so we can compute per-party P&L revenue.
 *
 * GET  /api/party-bookings              → fetch live + cache
 * GET  /api/party-bookings?stale=1      → cache only
 * POST /api/party-bookings              → force refresh
 *
 * Cache key in settings table: 'party_bookings_cache'
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const SHEET_ID = '1VYpxSOjcHHRPkBb7f7s1bfBFcl-M25PnxkjpEdXFbJI';
const TAB_NAME = 'Party Bookings';
const RANGE    = `${TAB_NAME}!A2:U`;   // through col U (Final Total Amount)

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const url = new URL(request.url);
    const useStale = url.searchParams.get('stale') === '1';
    if (useStale) return Response.json(readCache());
    return Response.json(await fetchLiveAndCache());
  } catch (e: any) {
    console.error('[party-bookings GET]', e);
    const cached = readCache();
    if (cached.bookings.length > 0) {
      return Response.json({
        ...cached,
        warning: `Live fetch failed (${e.message || 'unknown'}). Showing cached snapshot.`,
      });
    }
    return Response.json({ error: e.message || 'Failed to fetch sheet' }, { status: 500 });
  }
}

export async function POST() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    return Response.json(await fetchLiveAndCache());
  } catch (e: any) {
    console.error('[party-bookings POST]', e);
    return Response.json({ error: e.message || 'Sheet refresh failed' }, { status: 500 });
  }
}

async function fetchLiveAndCache(): Promise<{
  bookings: PartyBooking[];
  fetched_at: string;
  source: 'live' | 'cache';
}> {
  const rows = await readSheet(SHEET_ID, RANGE);
  const bookings = rows.map(mapRowToPartyBooking).filter((b): b is PartyBooking => b !== null);
  const payload = { bookings, fetched_at: new Date().toISOString(), source: 'live' as const };
  writeCache(payload);
  return payload;
}

function readCache(): { bookings: PartyBooking[]; fetched_at: string; source: 'live' | 'cache' } {
  try {
    const db = getDb();
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'party_bookings_cache'`).get() as { value: string } | undefined;
    if (!row) return { bookings: [], fetched_at: '', source: 'cache' };
    const parsed = JSON.parse(row.value);
    return { ...parsed, source: 'cache' };
  } catch {
    return { bookings: [], fetched_at: '', source: 'cache' };
  }
}

function writeCache(payload: unknown): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO settings (key, value) VALUES ('party_bookings_cache', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(JSON.stringify(payload));
  } catch (e: any) {
    console.warn('[party-bookings] cache write failed:', e?.message);
  }
}
