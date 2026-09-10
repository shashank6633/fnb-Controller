/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser, isManagement, requireRole } from '@/lib/auth';
import {
  CALLBACK_PATH, GBP_PREREQUISITES, GBP_UNPROVEN, autoDriverTickAt, beginConnect, callbackUrl,
  connectionHealth, disconnect, ensureReviewSchema, gbpCredentials, getConnection,
  hasOauthApp, setAutoRefresh, DEFAULT_INTERVAL_MIN, MAX_INTERVAL_MIN, MIN_INTERVAL_MIN,
} from '@/lib/reviews';
import { revokeToken } from '@/lib/reviews/oauth';

/**
 * CRM — the Google Business Profile CONNECTION.
 *
 *   GET    connection health (management) + setup detail (admin only)
 *   POST   start the OAuth connect flow -> returns the Google consent URL (admin)
 *   PATCH  arm / disarm the scheduled refresh, set its interval (admin)
 *   DELETE disconnect (admin)
 *
 * ── WHY GET IS MANAGEMENT AND EVERYTHING ELSE IS ADMIN ──────────────────────
 * Health is not a credential, and it is the one thing a manager MUST be able to
 * see: "these reviews are 9 days old" is the difference between a report and a
 * misleading one. So GET returns health to anyone who can read the reviews page.
 *
 * Mutations touch an OAuth client, a refresh token and unattended traffic
 * against the venue's own Google account, which is admin work — the same gate
 * as /api/crm-calls/reviews/settings and /api/crm-calls/settings.
 *
 * ── NO SECRET IS EVER RETURNED BY ANY VERB HERE ─────────────────────────────
 * Not the client secret, not the refresh token, not the access token, not a
 * prefix or a length of any of them. The admin block reports PRESENCE only. The
 * client ID is returned because in OAuth it is public by construction, and an
 * admin comparing what is wired against Google Cloud Console needs to see it.
 */

export const dynamic = 'force-dynamic';

/** The app's public origin, for building the redirect URI.
 *
 *  x-forwarded-* is read FIRST and deliberately: this app runs behind a proxy in
 *  both deployments, where request.url is the internal address. Getting this
 *  wrong produces redirect_uri_mismatch at Google, which reads like a code bug
 *  and is a configuration one. An admin can pin the whole URI outright with the
 *  reviews_gbp_redirect_uri setting, which overrides all of this. */
function originOf(request: Request): string {
  const h = request.headers;
  const proto = (h.get('x-forwarded-proto') || '').split(',')[0].trim();
  const host = (h.get('x-forwarded-host') || h.get('host') || '').split(',')[0].trim();
  if (host) return `${proto || 'https'}://${host}`;
  try { return new URL(request.url).origin; } catch { return ''; }
}

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not signed in' }, { status: 401 });
  if (!isManagement(me)) return Response.json({ error: 'Management only' }, { status: 403 });

  const db = ensureReviewSchema(getDb());
  const locationKey = new URL(request.url).searchParams.get('location_key') || '';
  const conn = getConnection(db, locationKey);
  const appReady = hasOauthApp(db);
  const health = connectionHealth(conn, { hasApp: appReady, driverTickAt: autoDriverTickAt(db) });

  const isAdmin = me.role === 'admin';
  const creds = isAdmin ? gbpCredentials(db) : null;

  return Response.json({
    health,
    connection: {
      status: conn.status,
      google_email: conn.google_email,
      location_name: conn.location_name,
      location_label: conn.location_label,
      location_address: conn.location_address,
      connected_at: conn.connected_at,
      connected_by: conn.connected_by,
      last_attempt_at: conn.last_attempt_at,
      last_success_at: conn.last_success_at,
      last_error: conn.last_error,
      last_error_at: conn.last_error_at,
      consecutive_failures: conn.consecutive_failures,
      auto_enabled: !!conn.auto_enabled,
      interval_minutes: conn.interval_minutes,
      last_auto_run_at: conn.last_auto_run_at,
    },
    /* Admin-only setup detail. Presence flags, never values. */
    setup: isAdmin && creds ? {
      oauth_app_configured: appReady,
      client_id: creds.clientId,
      client_secret_set: !!creds.clientSecret,
      refresh_token_set: !!creds.refreshToken,
      /* The exact string to paste into the OAuth client's Authorised redirect
       * URIs. Shown rather than described, because "add your callback URL" is
       * where this goes wrong. */
      redirect_uri: callbackUrl(db, originOf(request)),
      callback_path: CALLBACK_PATH,
      prerequisites: GBP_PREREQUISITES,
      unproven: GBP_UNPROVEN,
      interval_bounds: { min: MIN_INTERVAL_MIN, max: MAX_INTERVAL_MIN, default: DEFAULT_INTERVAL_MIN },
    } : null,
  });
}

/** Start the connect flow. Returns a URL for the browser to visit; this route
 *  does not redirect, so the caller can show the account-choice warning first. */
export async function POST(request: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });

  const body = await request.json().catch(() => ({} as any));
  const locationKey = String(body?.location_key || '');

  try {
    const { authUrl, redirectUri } = beginConnect(ensureReviewSchema(getDb()), {
      origin: originOf(request),
      actor: auth.user.email || auth.user.name || auth.user.id,
      locationKey,
    });
    return Response.json({
      auth_url: authUrl,
      redirect_uri: redirectUri,
      /* Repeated here because it is the single most common way this fails, and
       * the moment the admin is about to click is the moment to say it. */
      note: 'Sign in as the Google account that MANAGES this listing. An account that can only ' +
            'view the listing on Maps cannot release its review history.',
    });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e) }, { status: 400 });
  }
}

/** Arm or disarm the scheduled refresh. */
export async function PATCH(request: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });

  const body = await request.json().catch(() => ({} as any));
  const db = ensureReviewSchema(getDb());
  const locationKey = String(body?.location_key || '');

  if (typeof body?.auto_enabled !== 'boolean' && body?.interval_minutes === undefined) {
    return Response.json({ error: 'Nothing to change: send auto_enabled and/or interval_minutes.' }, { status: 400 });
  }

  const conn = getConnection(db, locationKey);
  const enabled = typeof body?.auto_enabled === 'boolean' ? body.auto_enabled : !!conn.auto_enabled;

  // Arming a schedule against a connection that cannot fetch would produce a
  // page that says "automatic" and a job that fails every cycle.
  if (enabled && (conn.status !== 'connected' || !conn.location_name)) {
    return Response.json({
      error: 'Connect a Google account and choose a listing before switching on the scheduled refresh.',
    }, { status: 400 });
  }

  setAutoRefresh(db, {
    locationKey,
    enabled,
    intervalMinutes: body?.interval_minutes === undefined ? conn.interval_minutes : Number(body.interval_minutes),
  });

  const after = getConnection(db, locationKey);
  return Response.json({
    ok: true,
    auto_enabled: !!after.auto_enabled,
    interval_minutes: after.interval_minutes,
    health: connectionHealth(after, { hasApp: hasOauthApp(db), driverTickAt: autoDriverTickAt(db) }),
  });
}

/** Disconnect. Reviews already imported are NOT deleted — see disconnect(). */
export async function DELETE(request: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });

  const db = ensureReviewSchema(getDb());
  const locationKey = new URL(request.url).searchParams.get('location_key') || '';

  // Ask Google to forget the token too, best-effort. Local state is cleared
  // whether or not Google answers: a stored credential we believe is gone is a
  // worse outcome than a revoked one Google still lists.
  const creds = gbpCredentials(db);
  if (creds.refreshToken) {
    try { await revokeToken(creds.refreshToken); } catch { /* best-effort by design */ }
  }

  disconnect(db, locationKey);
  return Response.json({
    ok: true,
    note: 'Disconnected. Reviews already imported are kept — disconnecting an integration is ' +
          'not a request to delete the venue\'s review history.',
  });
}
