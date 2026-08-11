import type { getDb } from '@/lib/db';

type DB = ReturnType<typeof getDb>;

/**
 * SERVICE REQUESTS — the closers the table-assistance board never had.
 * ────────────────────────────────────────────────────────────────────
 * A guest taps "Call waiter / Refill water / Extra cutlery / Request bill" on
 * the QR menu and a row lands in service_requests as 'pending'. A captain can
 * Accept it and mark it Done — that path exists and works. What did not exist
 * was anything that closes a request WITHOUT a human pressing Done.
 *
 * Why that mattered more than clutter: the guest-side de-duplicator in
 * /api/customer/service-requests refuses to create a new request while one of
 * the SAME TYPE on that table is still pending or accepted — it returns the old
 * one with deduped:true. So one un-Done "Call waiter" silently disables the
 * Call-waiter button for every future guest at that table, with no error and no
 * sign on the guest's phone that anything is wrong. Measured on the live
 * database: both service_requests rows were created 2026-07-03 00:19:30 and
 * cleared by hand on 2026-07-16 01:16:29 — thirteen days open.
 *
 * The close paths here therefore have to actually mutate the row (not merely
 * hide it from the board), because the row's status is what gates the guest.
 *
 * WHAT THESE FUNCTIONS MAY AND MAY NOT TOUCH
 * ------------------------------------------
 * /api/dine-in/captain-performance reads service_requests directly:
 *   · "unattended" = accepted_at IS NULL AND completed_at IS NULL
 *   · per-captain completions + average attend time are grouped by completed_by
 * An automatic close must never write accepted_at, accepted_by, completed_at or
 * completed_by, or the cashier who settled the bill would be credited with
 * attending every bell left open at that table. These functions move only the
 * status column, to 'completed' (which is what drops a row off the board and
 * releases the guest's button), and record the truth in the three new columns:
 * outcome / closed_reason / closed_at.
 * captain-performance therefore reports exactly what it reports today.
 *
 * All exported functions are BEST-EFFORT: they swallow their own errors and
 * return 0. closeServiceRequestsForOrder in particular runs AFTER the settle
 * transaction has committed, where a throw would surface as a failed settle on
 * money already taken.
 */

/** Statuses that keep a request on the board and keep the guest's button locked. */
const OPEN_STATUSES = "('pending','accepted')";

/** How a request ended. '' means still open, or a row that pre-dates this column. */
export type ServiceRequestOutcome = 'attended' | 'not_attended' | 'expired';

/** Settings key for the walk-out safety net. '0' (the seeded default) = OFF. */
export const AUTO_CLOSE_MINUTES_KEY = 'service_request_auto_close_minutes';

/**
 * Minutes after which an untouched request is auto-expired.
 * Returns 0 for OFF, missing, blank, negative or non-numeric — every one of
 * those means "do not sweep", so a garbled setting fails safe rather than
 * closing the whole board.
 */
export function getAutoCloseMinutes(db: DB): number {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(AUTO_CLOSE_MINUTES_KEY) as any;
    const n = Math.floor(Number(row?.value));
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * The bill is paid — close every service request still open on that table.
 *
 * A type='bill' request WAS attended: the guest asked for the bill and got one,
 * so closing it as 'not_attended' would mark the captain down for doing the job.
 * Every other type (waiter / water / cutlery) went unanswered by the time the
 * table paid, and is recorded honestly as 'not_attended'.
 *
 * Only requests raised at or before the settle instant are closed, so a bell
 * rung during the settle round-trip is left standing for the captain.
 *
 * MUST be called AFTER the settle transaction commits. Returns rows closed.
 */
export function closeServiceRequestsForOrder(db: DB, orderId: string): number {
  try {
    const order = db.prepare('SELECT table_id, settled_at FROM orders WHERE id = ?')
      .get(String(orderId || '')) as any;
    const tableId = order ? String(order.table_id || '') : '';
    if (!tableId) return 0; // takeaway / no table — nothing is bound to it
    const cutoff = order.settled_at ? String(order.settled_at) : null;

    // Same statement twice, once per outcome, so the type split is explicit.
    const sql = (typeCond: string) =>
      'UPDATE service_requests' +
      "   SET status = 'completed', outcome = ?, closed_reason = 'bill-settled'," +
      "       closed_at = datetime('now')" +
      ' WHERE table_id = ?' +
      '   AND status IN ' + OPEN_STATUSES +
      "   AND created_at <= COALESCE(?, datetime('now'))" +
      '   AND type ' + typeCond;

    const asked = db.prepare(sql("= 'bill'")).run('attended' as ServiceRequestOutcome, tableId, cutoff);
    const rest = db.prepare(sql("<> 'bill'")).run('not_attended' as ServiceRequestOutcome, tableId, cutoff);
    return (asked.changes || 0) + (rest.changes || 0);
  } catch (e: any) {
    console.warn('[closeServiceRequestsForOrder]', e?.message || e);
    return 0;
  }
}

/**
 * Walk-out safety net: expire requests older than the configured timeout.
 *
 * Off by default. Settling the bill closes a table's bells on the way out, so
 * this only has to catch a table that never reaches a bill. Cheap enough to run
 * on the board's poll: with the setting at 0 it costs one settings lookup and
 * touches nothing.
 *
 * Best-effort. Returns rows expired (0 when the timeout is OFF).
 */
export function expireStaleServiceRequests(db: DB): number {
  try {
    const minutes = getAutoCloseMinutes(db);
    if (minutes <= 0) return 0;
    const r = db.prepare(
      'UPDATE service_requests' +
      "   SET status = 'completed', outcome = 'expired', closed_reason = 'stale-timeout'," +
      "       closed_at = datetime('now')" +
      ' WHERE status IN ' + OPEN_STATUSES +
      "   AND created_at <= datetime('now', ?)"
    ).run('-' + minutes + ' minutes');
    return r.changes || 0;
  } catch (e: any) {
    console.warn('[expireStaleServiceRequests]', e?.message || e);
    return 0;
  }
}
