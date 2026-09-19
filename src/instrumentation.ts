/**
 * Server-side crash capture. Next.js calls `onRequestError` for any uncaught
 * error in a Server Component, route handler, or server render — the server-side
 * counterpart to the client error boundaries. We funnel it into the same
 * error_reports store so admins are alerted. Defensive: never throws, and only
 * touches the DB in the Node runtime (better-sqlite3 is Node-only).
 */

export async function register(): Promise<void> {
  // ARM THE SCHEDULER AT BOOT.
  //
  // Until this line existed, startSchedulerOnce() was reached ONLY from
  // /api/upcoming-parties and /api/crm-calls/broadcasts. So after every restart
  // nothing ticked until a signed-in user happened to load one of those — and
  // six jobs ride that tick: the Google reviews pull, the parties refresh, GRN
  // kitchen-QC escalation, the WhatsApp broadcast drain, scheduled WhatsApp
  // reports and price-hike alerts. A quiet restart stopped all six silently.
  //
  // The external-cron backstop several of those jobs' own comments point at
  // CANNOT BE REACHED: /api/cron/refresh-parties is absent from proxy.ts's
  // isPublic(), so proxy.ts answers a token-only POST with 401 "Sign in
  // required" before the route's own x-cron-token check can run. Arming here is
  // what actually gives them a driver, and it opens no new public surface.
  //
  // MEASURED, because NODE_ENV=production is also set during `next build` and
  // startSchedulerOnce() gates on that alone: Next.js does NOT call register()
  // during a build (a full `next build` on this tree logged the probe zero
  // times and exited 0), so this cannot arm a timer that stops the deploy's
  // build from exiting. Next 16.2.2's own docs say register() runs "once when a
  // new Next.js server instance is initiated".
  //
  // NON-BLOCKING, which register() must be ("must complete before the server is
  // ready to handle requests"): startSchedulerOnce() only does
  // setTimeout(tick, 30_000) and returns.
  //
  // NODE RUNTIME ONLY — the scheduler reaches better-sqlite3, which is Node-only.
  // Same guard, and same reason, as onRequestError below. The dynamic import is
  // the documented recommendation for register() and keeps a fault in the
  // scheduler from breaking server boot.
  //
  // ON DOUBLE-ARMING: startSchedulerOnce() is idempotent within a process via
  // globalThis.__fnbScheduler__. It does NOT dedupe across pm2 workers — but it
  // never did: whichever worker served /api/upcoming-parties armed its own tick,
  // so N workers already reached N ticks, just gradually instead of at boot.
  // Every job on the tick carries its own cross-process claim (a SQLite
  // transaction with an expiry for reviews, a per-row compare-and-swap for the
  // broadcast drain, qc_escalated_at per row for QC, send-ledger dedupe for
  // reports and price-hikes, a date sentinel for task automation).
  try {
    if (process.env.NEXT_RUNTIME !== 'nodejs') return; // skip edge — no better-sqlite3 there
    const { startSchedulerOnce } = await import('./lib/scheduler');
    startSchedulerOnce();
  } catch {
    // Instrumentation must never throw — swallow.
  }
}

export async function onRequestError(
  err: unknown,
  request: { path?: string; url?: string; method?: string; headers?: Record<string, string> },
  context: { routerKind?: string; routePath?: string; routeType?: string },
): Promise<void> {
  try {
    if (process.env.NEXT_RUNTIME !== 'nodejs') return; // skip edge — no better-sqlite3 there
    const { recordError, maybeNotifyAdmins } = await import('./lib/error-alerts');
    const anyErr = err as { message?: string; stack?: string } | undefined;
    const res = recordError({
      message: anyErr?.message || String(err),
      stack: anyErr?.stack || '',
      source: 'server',
      url: request?.url || request?.path || context?.routePath || '',
    });
    if (res?.isNew) void maybeNotifyAdmins(res);
  } catch {
    // Instrumentation must never throw — swallow.
  }
}
