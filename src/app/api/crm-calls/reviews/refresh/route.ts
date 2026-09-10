/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser, isManagement } from '@/lib/auth';
import {
  autoDriverTickAt, connectionHealth, ensureReviewSchema, getConnection, hasOauthApp,
  isRefreshDue, runReviewAutoRefresh, runReviewRefresh,
} from '@/lib/reviews';
import { ReconnectRequiredError } from '@/lib/reviews/oauth';
import { SourceNotConfiguredError } from '@/lib/reviews/types';

/**
 * CRM — fetch reviews from Google.
 *
 *   GET   is a pull due, and is the connection healthy (management)
 *   POST  fetch now (admin session OR x-cron-token header)
 *
 * ── THIS IS THE SCHEDULER'S DOOR, AND NOBODY IS KNOCKING ON IT YET ──────────
 * A previous version of this comment said an external cron "works today,
 * nothing to change". IT DOES NOT, and the correction matters because the page
 * was built on the claim:
 *
 *   src/proxy.ts protects the whole /api/crm-calls prefix. A POST carrying only
 *   x-cron-token has no fnb_session cookie, so the proxy answers 401
 *   {"error":"Sign in required"} at step 2 — its message, not this route's
 *   ("Admin or valid x-cron-token required") — and the handler below never
 *   runs. Adding a junk session cookie fails session validation at step 2c.
 *   /api/cron/refresh-parties is blocked in exactly the same way, so the
 *   header-contract parity with it is real, but neither is reachable.
 *
 * So the ONLY path that works today is an admin session with CSRF, i.e. the
 * "Refresh now" button. connectionHealth() reports state 'no_driver' until a
 * scheduler actually calls runReviewAutoRefresh(), and the page refuses to show
 * a green "arriving automatically" badge or a "next fetch" time until then.
 *
 * TO MAKE IT AUTOMATIC, either:
 *
 *   1. IN-PROCESS — ONE line for whoever owns src/lib/scheduler.ts to add
 *      inside the existing tick, in the same best-effort style as its
 *      neighbours:
 *
 *        try { (await import('@/lib/reviews/refresh')).runReviewAutoRefresh(); }
 *        catch (e) { console.error('[scheduler] reviews refresh failed:', e); }
 *
 *      Safe on every tick: it returns 'not_due' immediately when nothing is
 *      owed, so a 5-minute cadence costs one settings read. This also starts
 *      the driver heartbeat, which is what turns the badge green.
 *
 *   2. EXTERNAL CRON — needs this route carved out of the proxy's protected
 *      prefixes first (isPublic in src/proxy.ts, the way the WhatsApp webhook
 *      is), so the x-cron-token check below can run. That is a change to a
 *      shared security file and is deliberately not made from this module.
 *
 * ── auto=1 vs a bare POST ───────────────────────────────────────────────────
 * A bare POST is "Refresh now": a person pressed a button, so it runs whether
 * or not a pull is due and it reports failure to their face. `?auto=1` is the
 * scheduled path: it respects the interval, takes the advisory lock, and never
 * throws — a cron job that 500s every five minutes is a log nobody reads.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not signed in' }, { status: 401 });
  if (!isManagement(me)) return Response.json({ error: 'Management only' }, { status: 403 });

  const db = ensureReviewSchema(getDb());
  const locationKey = new URL(request.url).searchParams.get('location_key') || '';
  const conn = getConnection(db, locationKey);

  return Response.json({
    health: connectionHealth(conn, { hasApp: hasOauthApp(db), driverTickAt: autoDriverTickAt(db) }),
    due: isRefreshDue(conn),
    auto_enabled: !!conn.auto_enabled,
    interval_minutes: conn.interval_minutes,
    last_auto_run_at: conn.last_auto_run_at,
    last_success_at: conn.last_success_at,
  });
}

export async function POST(request: Request) {
  // Either an admin session OR a matching CRON_TOKEN header, the same contract
  // as /api/cron/refresh-parties so external schedulers configure identically.
  const tokenHeader = request.headers.get('x-cron-token');
  const expectedToken = process.env.CRON_TOKEN;
  const tokenOk = !!(expectedToken && tokenHeader && tokenHeader === expectedToken);

  let actor = 'external_cron';
  if (!tokenOk) {
    const me = await getCurrentUser();
    if (!me || me.role !== 'admin') {
      return Response.json({ error: 'Admin or valid x-cron-token required' }, { status: 401 });
    }
    actor = me.email || me.name || me.id;
  }

  const url = new URL(request.url);
  const locationKey = url.searchParams.get('location_key') || '';
  const auto = url.searchParams.get('auto') === '1';
  const db = ensureReviewSchema(getDb());

  // ── The scheduled path. Never throws; reports what it decided.
  if (auto) {
    const result = await runReviewAutoRefresh({ db, locationKey });
    const conn = getConnection(db, locationKey);
    return Response.json({
      ok: result.outcome !== 'failed',
      ...result,
      health: connectionHealth(conn, { hasApp: hasOauthApp(db), driverTickAt: autoDriverTickAt(db) }),
    });
  }

  // ── "Refresh now". A person is waiting, so the error is the answer.
  try {
    const r = await runReviewRefresh({ db, locationKey, actor, auto: false });
    const conn = getConnection(db, locationKey);
    return Response.json({
      ok: true,
      pages: r.pages,
      ingest: {
        run_id: r.ingest.run_id,
        rows_seen: r.ingest.rows_seen,
        inserted: r.ingest.inserted,
        updated: r.ingest.updated,
        unchanged: r.ingest.unchanged,
        skipped_stale: r.ingest.skipped_stale,
        errors: r.ingest.errors,
        weak_identity: r.ingest.weak_identity,
        // A page Google returned that we could not read in full is a FAILED
        // pull, not a partial one, and the page must be able to say so.
        fatal_documents: r.ingest.fatal_documents,
        reconciliation: r.ingest.reconciliation,
      },
      health: connectionHealth(conn, { hasApp: hasOauthApp(db), driverTickAt: autoDriverTickAt(db) }),
    });
  } catch (e: any) {
    const conn = getConnection(db, locationKey);
    const health = connectionHealth(conn, { hasApp: hasOauthApp(db), driverTickAt: autoDriverTickAt(db) });

    // A refused refresh token is terminal until a human reconnects. 409, not
    // 500: nothing is broken in this app, and the fix is a button, not a retry.
    if (e instanceof ReconnectRequiredError) {
      return Response.json({
        error: e.message, needs_reconnect: true, health,
      }, { status: 409 });
    }
    if (e instanceof SourceNotConfiguredError) {
      return Response.json({
        error: e.message, prerequisites: e.prerequisites, health,
      }, { status: 409 });
    }
    return Response.json({ error: String(e?.message || e), health }, { status: 502 });
  }
}
