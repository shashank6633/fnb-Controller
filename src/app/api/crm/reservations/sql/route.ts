import { getCurrentUser } from '@/lib/auth';
import {
  validateSelect,
  runSandboxedQuery,
  MAX_ROWS,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
} from '@/lib/sql-sandbox';

/**
 * Reservation CRM — AD-HOC SQL (/crm-calls/database → SQL box).
 *
 * POST /api/crm/reservations/sql  { sql, limit?, timeout_ms? }
 *   → 200 { columns, rows, row_count, truncated, elapsed_ms, total_ms, limit, timeout_ms }
 *
 * POST, not GET, and the SQL travels in the body: a query here filters on guest
 * names and phone numbers, and a URL lands in access logs, proxy logs and
 * browser history.
 *
 * ── THE ONE THING THAT MATTERS HERE ───────────────────────────────────────
 * The query does NOT run in this process. better-sqlite3 is synchronous with
 * no statement timeout, so a runaway SELECT over the 85,558 measured bookings
 * would block the Node main thread — captain tablets, KOT printing, cashier
 * settlement all frozen until it finished. src/lib/sql-sandbox.ts spawns a
 * child that opens the file read-only and gets SIGKILLed on a wall clock
 * (default 5s), so the worst case costs one dead child process and this route
 * returns 408. See that file's header for why SIGKILL and not SIGTERM.
 *
 * ── WHO MAY READ THIS ─────────────────────────────────────────────────────
 * ADMIN ONLY, like every route in this family and the adminOnly catalog entry
 * on /crm-calls/database. Stronger reason than its siblings: an arbitrary
 * SELECT reaches every table in the file — users, sessions, password hashes —
 * not just the reservation tables the page shows. This gate is the ONLY thing
 * scoping that, so it must never be loosened to management.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function POST(request: Request) {
  const started = Date.now();

  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401, headers: NO_STORE });
  if (me.role !== 'admin') return Response.json({ error: 'Admin access required' }, { status: 403, headers: NO_STORE });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'Expected a JSON body.' }, { status: 400, headers: NO_STORE });
  }

  const check = validateSelect(String(body?.sql ?? ''));
  if (!check.ok) {
    return Response.json({ error: check.error }, { status: 400, headers: NO_STORE });
  }

  const limit = clampInt(body?.limit, MAX_ROWS, 1, MAX_ROWS);
  const timeoutMs = clampInt(body?.timeout_ms, DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS);

  let result;
  try {
    result = await runSandboxedQuery(check.sql, { timeoutMs, maxRows: limit });
  } catch (e) {
    // runSandboxedQuery resolves rather than rejects for every path it knows
    // about; reaching here means the sandbox itself broke, and it must not
    // surface as an unhandled rejection.
    console.error('[POST /api/crm/reservations/sql] sandbox threw', e);
    return Response.json({ error: 'The query sandbox failed to run.' }, { status: 500, headers: NO_STORE });
  }

  if (!result.ok) {
    // 408 for the wall-clock kill, 429 for the concurrency guard, 400 for the
    // user's own SQL, 500 only when the sandbox itself failed to run.
    const status =
      result.kind === 'timeout' ? 408 :
      result.kind === 'busy' ? 429 :
      result.kind === 'query' ? 400 : 500;
    if (result.kind === 'sandbox') console.error('[POST /api/crm/reservations/sql]', result.error);
    return Response.json(
      { error: result.error, kind: result.kind, timeout_ms: timeoutMs },
      { status, headers: NO_STORE },
    );
  }

  return Response.json(
    {
      columns: result.columns,
      rows: result.rows,
      row_count: result.rowCount,
      // 'rows' = hit the row cap, 'bytes' = hit the response size cap. Either
      // way the result shown is a PREFIX, not the answer — the caller has to
      // be able to say so rather than quietly under-report a total.
      truncated: result.truncated,
      // Query time inside the child vs. the whole round trip including spawn
      // (~40-80ms). Both, because "why is 12ms of SQL taking 90ms" is the first
      // question anyone asks.
      elapsed_ms: result.elapsedMs,
      total_ms: Date.now() - started,
      limit,
      timeout_ms: timeoutMs,
    },
    { headers: NO_STORE },
  );
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
