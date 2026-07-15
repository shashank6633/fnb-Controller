import type Database from 'better-sqlite3';

/**
 * Print-agent (dispatcher) liveness.
 *
 * The /print/agent page is the always-on DISPATCHER: it listens to every fired
 * KOT (SSE + a 9s backup poll) and hands it to the local bridge to print. The
 * bridge "connected" dot only says the bridge PROCESS is up — it does NOT say a
 * dispatcher is running. If the agent tab is closed while orders flow, KOTs are
 * created but never sent to a printer, silently.
 *
 * This module tracks "is a dispatcher alive?" so:
 *   • the Kitchen board can raise a loud watchdog banner (orders flowing, no
 *     dispatcher) — see src/app/dine-in/kitchen/page.tsx
 *   • the Printers page can show a "Print Agent running / not detected" line
 *     distinct from the bridge health — see src/app/dine-in/offline-print/page.tsx
 */

/** No heartbeat / no print activity for this long ⇒ the dispatcher is considered down. */
export const AGENT_STALE_SECONDS = 90;
/** A KOT fired within this window counts as "live kitchen activity that needs printing". */
export const RECENT_FIRE_SECONDS = 15 * 60;

export interface PrintAgentStatus {
  lastSeen: string | null;   // ISO/SQLite datetime of the most recent liveness signal
  secondsAgo: number | null; // whole seconds since lastSeen, or null if never seen
  online: boolean;           // lastSeen within AGENT_STALE_SECONDS
  bridgeOk: boolean;         // bridge was healthy at the last heartbeat (and agent is online)
  recentFires: number;       // KOTs fired in the last RECENT_FIRE_SECONDS
  watchdog: boolean;         // dispatcher looks DOWN while orders are flowing → warn the kitchen
}

const oid = (outletId: string | null) => outletId || '';

/**
 * Record a heartbeat from an open /print/agent page. Called by any authenticated
 * user (the counter PC agent may be signed in as a station/kitchen user, so this
 * must NOT be gated to admin/manager). Best-effort — never throws into a request.
 */
export function recordAgentHeartbeat(
  db: Database.Database,
  outletId: string | null,
  info: { bridgeOk?: boolean; url?: string; userAgent?: string },
): void {
  try {
    db.prepare(`
      INSERT INTO print_agent_heartbeat (outlet_id, last_seen, bridge_ok, agent_url, user_agent, updated_at)
      VALUES (?, datetime('now'), ?, ?, ?, datetime('now'))
      ON CONFLICT(outlet_id) DO UPDATE SET
        last_seen  = datetime('now'),
        bridge_ok  = excluded.bridge_ok,
        agent_url  = excluded.agent_url,
        user_agent = excluded.user_agent,
        updated_at = datetime('now')
    `).run(oid(outletId), info.bridgeOk ? 1 : 0, (info.url || '').slice(0, 200), (info.userAgent || '').slice(0, 200));
  } catch { /* liveness is best-effort — never break the request it rides on */ }
}

/**
 * Compute dispatcher liveness for the current outlet. Liveness = the freshest of
 * (a) an explicit agent heartbeat, or (b) a print-job journal row — the latter
 * so an OLDER agent build that predates the heartbeat still reads as alive while
 * it's actually printing. Never throws; returns an all-false status on any error.
 */
export function getPrintAgentStatus(db: Database.Database, outletId: string | null): PrintAgentStatus {
  const empty: PrintAgentStatus = { lastSeen: null, secondsAgo: null, online: false, bridgeOk: false, recentFires: 0, watchdog: false };
  try {
    // Liveness compares timestamps as UNIX EPOCHS, never as strings. print_jobs
    // stores printed_at as ISO ("…T…Z") but created_at/heartbeat as SQLite fmt
    // ("… …"); a lexicographic MAX would let a stale ISO row beat a fresher
    // SQLite one ('T' > ' '), so we strftime('%s', …) every candidate first.
    // A print-job row (from ANY dispatcher, incl. an older build without the
    // heartbeat) also counts as "a dispatcher is alive".
    const row = db.prepare(`
      SELECT
        (SELECT bridge_ok FROM print_agent_heartbeat WHERE outlet_id = ?) AS bridge_ok,
        (SELECT MAX(CAST(strftime('%s', last_seen) AS INTEGER))
           FROM print_agent_heartbeat WHERE outlet_id = ?) AS hb_ep,
        (SELECT MAX(CAST(strftime('%s', COALESCE(printed_at, created_at)) AS INTEGER))
           FROM print_jobs WHERE (outlet_id = ? OR outlet_id IS NULL)
             AND created_at >= datetime('now', '-6 hours')) AS job_ep,
        CAST(strftime('%s','now') AS INTEGER) AS now_ep
    `).get(oid(outletId), oid(outletId), outletId) as any;

    const eps = [row?.hb_ep, row?.job_ep]
      .map((x) => (x == null ? null : Number(x)))
      .filter((x): x is number => x != null && Number.isFinite(x));
    const lastEp = eps.length ? Math.max(...eps) : null;
    const nowEp = Number(row?.now_ep);

    const secondsAgo = lastEp != null && Number.isFinite(nowEp) ? Math.max(0, nowEp - lastEp) : null;
    const online = secondsAgo !== null && secondsAgo <= AGENT_STALE_SECONDS;

    let lastSeen: string | null = null;
    if (lastEp != null) {
      const d = db.prepare(`SELECT datetime(?, 'unixepoch') AS s`).get(lastEp) as any;
      lastSeen = d?.s || null;
    }

    const rf = db.prepare(
      `SELECT COUNT(*) AS n FROM kots
       WHERE (outlet_id = ? OR outlet_id IS NULL)
         AND created_at >= datetime('now', ?)`
    ).get(outletId, '-' + RECENT_FIRE_SECONDS + ' seconds') as any;
    const recentFires = Number(rf?.n || 0);

    return {
      lastSeen,
      secondsAgo,
      online,
      bridgeOk: !!(row && Number(row.bridge_ok) === 1 && online),
      recentFires,
      watchdog: !online && recentFires > 0,
    };
  } catch {
    return empty;
  }
}
