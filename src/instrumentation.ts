/**
 * Server-side crash capture. Next.js calls `onRequestError` for any uncaught
 * error in a Server Component, route handler, or server render — the server-side
 * counterpart to the client error boundaries. We funnel it into the same
 * error_reports store so admins are alerted. Defensive: never throws, and only
 * touches the DB in the Node runtime (better-sqlite3 is Node-only).
 */

export async function register(): Promise<void> {
  // Required entrypoint for instrumentation; nothing to set up here.
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
