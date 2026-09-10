/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import {
  autoDriverTickAt, connectionHealth, ensureReviewSchema, getConnection, hasOauthApp,
  listConnectedLocations, selectLocation,
} from '@/lib/reviews';
import { SourceNotConfiguredError } from '@/lib/reviews/types';

/**
 * CRM — listing discovery. ADMIN ONLY, both verbs.
 *
 *   GET   every Business Profile account this connection can see, and the
 *         listings under each
 *   POST  choose the listing to track
 *
 * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
 * The alternative is asking the owner to paste
 * `accounts/106.../locations/178...`, which he would have to go and find in an
 * API response he has no way to make. He should pick "AKAN, Jubilee Hills" from
 * a list. That is the entire justification for this route.
 *
 * ── AND WHY IT IS NOT A URL BOX ─────────────────────────────────────────────
 * Pasting a Google Maps link cannot work. Review history is released only to an
 * account that MANAGES the listing, via OAuth; the public Places API returns at
 * most five reviews, ordered by relevance rather than recency, with no
 * pagination — no history, no daily counts, no trend. A URL box would be a lie
 * shaped like a feature, so there is no endpoint here that accepts one.
 *
 * UNPROVEN: the Google calls behind GET have never been exercised against a
 * live credential.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });

  const db = ensureReviewSchema(getDb());
  const locationKey = new URL(request.url).searchParams.get('location_key') || '';
  const conn = getConnection(db, locationKey);

  if (conn.status !== 'connected') {
    return Response.json({
      error: 'No Google account is connected yet.',
      health: connectionHealth(conn, { hasApp: hasOauthApp(db), driverTickAt: autoDriverTickAt(db) }),
    }, { status: 409 });
  }

  try {
    const accounts = await listConnectedLocations(db, { locationKey });
    return Response.json({
      accounts,
      total_locations: accounts.reduce((n, a) => n + a.locations.length, 0),
      selected: conn.location_name,
      /* An approved connection with zero listings is a real and confusing
       * state — usually the authorised account can VIEW the listing but does
       * not MANAGE it. Say that, rather than rendering an empty list. */
      note: accounts.length === 0
        ? 'This Google account has no Business Profile accounts the API can see. The account ' +
          'that MANAGES the listing is the one to connect — being able to see the listing on ' +
          'Maps is not the same thing.'
        : '',
    });
  } catch (e: any) {
    // "Not approved yet" is paperwork, not a fault, and deserves the owner's
    // to-do list rather than a 500.
    if (e instanceof SourceNotConfiguredError) {
      return Response.json({ error: e.message, prerequisites: e.prerequisites }, { status: 409 });
    }
    return Response.json({ error: String(e?.message || e) }, { status: 502 });
  }
}

export async function POST(request: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });

  const body = await request.json().catch(() => ({} as any));
  const db = ensureReviewSchema(getDb());
  const locationKey = String(body?.location_key || '');

  try {
    selectLocation(db, {
      locationKey,
      name: String(body?.name || ''),
      label: String(body?.label || ''),
      address: String(body?.address || ''),
    });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e) }, { status: 400 });
  }

  const after = getConnection(db, locationKey);
  return Response.json({
    ok: true,
    selected: after.location_name,
    label: after.location_label,
    health: connectionHealth(after, { hasApp: hasOauthApp(db), driverTickAt: autoDriverTickAt(db) }),
    next: after.auto_enabled
      ? 'Scheduled refresh is on — new reviews will arrive on their own.'
      : 'Now switch on the scheduled refresh so reviews arrive without anyone pressing anything.',
  });
}
