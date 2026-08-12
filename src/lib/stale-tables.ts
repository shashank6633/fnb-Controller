import type Database from 'better-sqlite3';
import { getDb, logAuditEvent } from '@/lib/db';

/**
 * IDLE TABLES — the closer this app has never had.
 * ════════════════════════════════════════════════════════════════════════════
 * Nothing in fnb-controller has ever closed an open order that a human forgot
 * about. Measured on the live database 2026-08-12 11:50 UTC, eleven orders were
 * still 'open', idle (hours since the last item was punched, or since the order
 * was created when it has none):
 *
 *     order 2        1 item     765.3 h   (32 days, takeaway, ₹292.95)
 *     order 1        3 items    527.6 h   (22 days, Ground Floor table 1)
 *     order 942210   0 items     16.8 h
 *     order 924028   0 items     16.8 h   (seven more like it — nine in all)
 *
 * ── TWO PROBLEMS ARE HIDING IN THAT LIST, AND THEY GET OPPOSITE TREATMENT ──
 *
 * A. AN EMPTY TABLE (zero order_items). Opened by mistake, or a guest sat down
 *    and left before ordering. No bill, no money, nothing consumed, nothing to
 *    decide. Past the configured idle window these CLOSE AUTOMATICALLY and the
 *    table frees up. Low risk precisely because there is nothing to get wrong.
 *
 * B. A TABLE WITH ITEMS. This has money attached and A TIMER MUST NEVER DECIDE
 *    ITS FATE. Auto-settling invents revenue nobody collected. Auto-voiding
 *    writes off food that was probably eaten and paid for in cash. Either way
 *    the sales figures become fiction. These are FLAGGED for a human — never
 *    auto-closed, ever, under any setting.
 *
 * The guarantee behind B is not a policy in a caller. It lives in the SQL of
 * the one UPDATE this file performs, as a NOT EXISTS over order_items — see
 * voidEmptyOrders() below, which is the ONLY writer here. A caller cannot
 * bypass it, and re-evaluating it inside the UPDATE is also what makes the
 * close race-safe: an item punched between the list and the close takes the row
 * out of the statement's reach, so a table that just got its first order cannot
 * be closed out from under the captain.
 *
 * ── WHY 'void' AND NOT A NEW STATUS ──
 * orders.status is filtered on all over the app ('open' | 'settled' | 'void' |
 * 'on_hold' | 'pending_approval' | 'merged'); a new value would silently fall
 * out of every query that does not know it — starting with
 * /api/dine-in/tables, which joins orders ON o.status = 'open' for the cashier
 * floor and the captain screens. VOID is the honest existing semantics: nothing
 * was consumed, so "this never happened" is literally true, and it is the same
 * status a manager's own void writes (src/app/api/dine-in/orders/[id]/void).
 * That route refuses once any line was cooked — a condition an EMPTY order can
 * never trip — and carries a standing decision not to build compensating stock
 * movements. Nothing here needs one either: an order with no items moved no
 * stock, fired no KOT (kots are created from items; measured today: 0 kots and
 * 0 order_payments across every empty open order) and wrote no sale.
 *
 * WHAT THE CLOSE TOUCHES, AND WHAT IT DELIBERATELY DOES NOT. Exactly the
 * columns the human void writes — status, voided_at, notes, updated_at — plus
 * orders.auto_close_reason, which is NULL for every human void and 'idle_empty'
 * for one of these. That column exists because two reports COUNT and
 * SUM(orders.total) over status = 'void': the Cancel breakup in
 * src/lib/sales-dashboard.ts and the Voids tile in
 * /api/dine-in/kot-analytics. Without it an automatic close of an abandoned
 * empty table is indistinguishable from a cashier cancelling a real bill.
 * (Those two files belong to other tracks and still count both kinds today —
 * the column is what lets them tell the two apart when they choose to.)
 *
 * Money columns are NOT rewritten. An empty order should carry total 0 —
 * recomputeTotals() in /api/dine-in/orders/[id] recomputes from the surviving
 * lines whenever an item is added or removed — but the nine empty open orders
 * in the live database today each carry a stale subtotal 100 / tax 5 /
 * total 105 with no order_items behind it. Zeroing them on the way out would
 * destroy the only evidence of that anomaly, so the sweep leaves them exactly
 * as it found them and listIdleOpenOrders() reports item_count and items_total
 * beside order_total so a manager can see the discrepancy for himself.
 *
 * ── OFF BY DEFAULT ──
 * The window is settings['stale_table_auto_close_hours'], seeded '0' = OFF in
 * src/lib/db.ts with INSERT OR IGNORE. Nothing starts closing tables the moment
 * this deploys; the owner turns it on after looking at the list. A missing,
 * blank, negative or garbled value also reads as OFF, and OFF is enforced in
 * the SQL (:hours > 0), not merely in an early return — with the window at 0
 * the statement can select nothing at all.
 */

type DB = Database.Database;

/** Settings key for the idle window, in HOURS. '0' (the seeded default) = OFF. */
export const STALE_TABLE_HOURS_KEY = 'stale_table_auto_close_hours';

/** orders.auto_close_reason written by this file. NULL means a human voided it. */
export const AUTO_CLOSE_REASON_IDLE_EMPTY = 'idle_empty';

/** orders.auto_close_reason for an empty table a manager closed from the list. */
export const AUTO_CLOSE_REASON_EMPTY_BY_HAND = 'empty_by_hand';

/** Longest window an admin may set (365 days). Beyond this the setting is noise. */
const MAX_WINDOW_HOURS = 8760;

/**
 * Most ids ONE BY-HAND CALL may act on — a bound on a request body, not on the
 * sweep. The timed sweep is uncapped by design: it closes every eligible order
 * in a single UPDATE, and even a long backlog is one statement over a small
 * table (the whole orders table on this deployment is 37 rows today).
 */
const MAX_CLOSE_BATCH = 200;

/**
 * IDLE IS MEASURED FROM THE LAST ACTIVITY, NOT FROM THE ORDER'S CREATION:
 * MAX(order_items.created_at), falling back to orders.created_at when the order
 * has no items. An order that took an item an hour ago is not idle just because
 * it opened this morning. `alias` is the orders alias in the enclosing query
 * ('o' in the list, 'orders' in the UPDATE) — one definition, both places.
 */
function lastActivitySql(alias: string): string {
  return 'COALESCE((SELECT MAX(oi_a.created_at) FROM order_items oi_a WHERE oi_a.order_id = ' + alias + '.id), ' + alias + '.created_at)';
}

/** Hours since that last activity, as a REAL. */
function idleHoursSql(alias: string): string {
  return "(julianday('now') - julianday(" + lastActivitySql(alias) + ')) * 24.0';
}

/** One open order on the idle list — everything a manager needs to decide
 *  without opening the order. */
export interface IdleOpenOrder {
  id: string;
  order_number: number;
  order_type: string;               // dine-in | takeaway | delivery
  /** null for takeaway / delivery — there is no table to free. */
  table_id: string | null;
  table_number: string | null;
  floor: string | null;             // restaurant_tables.zone
  section: string | null;
  server_id: string;
  server_name: string;
  guest_name: string;
  /** server_name if the order records one, else the guest it was opened for. */
  opened_by: string;
  covers: number;
  origin: string;                   // cloud | offline
  created_at: string;               // UTC 'YYYY-MM-DD HH:MM:SS'
  last_activity_at: string;
  idle_hours: number;
  item_count: number;
  /** SUM(unit_price × quantity) over its lines — the money actually ordered. */
  items_total: number;
  /** orders.total, the header the bill screens show. */
  order_total: number;
  bill_printed_at: string | null;
  bill_requested_at: string | null;
  is_empty: boolean;
  /** True only for an empty order the sweep would close on its next pass. */
  would_auto_close: boolean;
}

export interface IdleTablesReport {
  /** The configured window in hours. 0 = OFF. */
  window_hours: number;
  enabled: boolean;
  /** Rows below this idle age were filtered out of the lists (default 0 = none). */
  min_idle_hours: number;
  generated_at: string;
  /** Zero order_items: the sweep may close these. */
  empty: IdleOpenOrder[];
  /** Has items and therefore money: FLAGGED, never auto-closed. */
  with_items: IdleOpenOrder[];
  counts: {
    open_total: number;
    empty: number;
    with_items: number;
    would_auto_close: number;
  };
}

export interface ClosedOrder {
  id: string;
  order_number: number;
  order_type: string;
  table_id: string | null;
  table_number: string | null;
  floor: string | null;
  order_total: number;
  created_at: string;
  idle_hours: number;
  reason: string;
}

export interface StaleSweepResult {
  enabled: boolean;
  window_hours: number;
  closed: number;
  orders: ClosedOrder[];
  /** Table numbers freed on the floor board, for the log line. */
  freed_tables: string[];
  /** Why a pass did nothing, when that is the reason. */
  skipped?: 'disabled' | 'throttled' | 'error';
}

/**
 * The configured idle window in hours. 0 means OFF — and OFF is what a missing,
 * blank, negative, absurd or non-numeric value reads as, so a garbled setting
 * fails safe (closes nothing) rather than sweeping the floor.
 */
export function getStaleTableWindowHours(dbArg?: DB): number {
  try {
    const db = dbArg || getDb();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(STALE_TABLE_HOURS_KEY) as { value?: string } | undefined;
    return normalizeWindowHours(row?.value);
  } catch {
    return 0;
  }
}

/** Clamp anything a UI might send into a usable window. Junk → 0 (OFF). */
export function normalizeWindowHours(input: unknown): number {
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(Math.min(n, MAX_WINDOW_HOURS) * 100) / 100;
}

/** Persist the window (admin action). Returns the value actually stored. */
export function setStaleTableWindowHours(hours: unknown, dbArg?: DB): number {
  const db = dbArg || getDb();
  const v = normalizeWindowHours(hours);
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(STALE_TABLE_HOURS_KEY, String(v));
  return v;
}

/**
 * Every open order, split into "empty, closeable" and "has items, needs a
 * human", newest-idle last. Never mutates anything.
 *
 * The list does NOT hide rows below the window — the owner has to be able to
 * see the whole floor before he decides what the window should be, and with the
 * setting at its seeded 0 a window-filtered list would be empty forever. Pass
 * minIdleHours to narrow it; every row carries idle_hours and would_auto_close
 * so a screen can sort and label without a second query.
 *
 * outletId scopes the list the way /api/dine-in/tables scopes the floor
 * (rows with a NULL outlet_id are always included); pass null for every outlet.
 */
export function listIdleOpenOrders(opts?: {
  db?: DB;
  outletId?: string | null;
  minIdleHours?: number;
}): IdleTablesReport {
  const db = opts?.db || getDb();
  const windowHours = getStaleTableWindowHours(db);
  const minIdle = Number.isFinite(Number(opts?.minIdleHours)) && Number(opts?.minIdleHours) > 0
    ? Number(opts?.minIdleHours) : 0;
  const outletId = opts?.outletId === undefined ? null : opts.outletId;

  // items_total multiplies unit_price × quantity rather than summing
  // line_total, because that is what recomputeTotals() in
  // /api/dine-in/orders/[id] uses to build the bill the guest is shown.
  // Measured 2026-08-12: the two agree on all 35 order_items rows in the live
  // database, so this is about staying on the app's definition of the money,
  // not about a drift anyone has seen.
  const rows = db.prepare(
    'SELECT o.id, o.order_number, o.order_type, o.table_id,' +
    '       t.table_number AS table_number, t.zone AS floor, t.section AS section,' +
    "       COALESCE(o.server_id,'') AS server_id, COALESCE(o.server_name,'') AS server_name," +
    "       COALESCE(o.guest_name,'') AS guest_name, COALESCE(o.covers,0) AS covers," +
    "       COALESCE(o.origin,'') AS origin," +
    '       o.created_at, o.bill_printed_at, o.bill_requested_at,' +
    '       COALESCE(o.total,0) AS order_total,' +
    '       (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count,' +
    '       (SELECT COALESCE(SUM(oi.unit_price * oi.quantity), 0) FROM order_items oi WHERE oi.order_id = o.id) AS items_total,' +
    '       ' + lastActivitySql('o') + ' AS last_activity_at,' +
    '       ROUND(' + idleHoursSql('o') + ', 2) AS idle_hours' +
    '  FROM orders o' +
    '  LEFT JOIN restaurant_tables t ON t.id = o.table_id' +
    " WHERE o.status = 'open'" +
    '   AND (:outlet IS NULL OR o.outlet_id = :outlet OR o.outlet_id IS NULL)' +
    '   AND ' + idleHoursSql('o') + ' >= :minIdle' +
    ' ORDER BY idle_hours DESC, o.created_at ASC'
  ).all({ outlet: outletId, minIdle }) as any[];

  const empty: IdleOpenOrder[] = [];
  const withItems: IdleOpenOrder[] = [];
  for (const r of rows) {
    const itemCount = Number(r.item_count) || 0;
    const idle = Number(r.idle_hours) || 0;
    const row: IdleOpenOrder = {
      id: String(r.id),
      order_number: Number(r.order_number) || 0,
      order_type: String(r.order_type || ''),
      table_id: r.table_id ? String(r.table_id) : null,
      table_number: r.table_number == null ? null : String(r.table_number),
      floor: r.floor == null ? null : String(r.floor),
      section: r.section == null ? null : String(r.section),
      server_id: String(r.server_id || ''),
      server_name: String(r.server_name || ''),
      guest_name: String(r.guest_name || ''),
      opened_by: String(r.server_name || '').trim() || String(r.guest_name || '').trim(),
      covers: Number(r.covers) || 0,
      origin: String(r.origin || ''),
      created_at: String(r.created_at || ''),
      last_activity_at: String(r.last_activity_at || r.created_at || ''),
      idle_hours: idle,
      item_count: itemCount,
      items_total: Math.round((Number(r.items_total) || 0) * 100) / 100,
      order_total: Math.round((Number(r.order_total) || 0) * 100) / 100,
      bill_printed_at: r.bill_printed_at ? String(r.bill_printed_at) : null,
      bill_requested_at: r.bill_requested_at ? String(r.bill_requested_at) : null,
      is_empty: itemCount === 0,
      // A row with items is never true here, whatever the window says.
      would_auto_close: itemCount === 0 && windowHours > 0 && idle >= windowHours,
    };
    (row.is_empty ? empty : withItems).push(row);
  }

  return {
    window_hours: windowHours,
    enabled: windowHours > 0,
    min_idle_hours: minIdle,
    generated_at: new Date().toISOString(),
    empty,
    with_items: withItems,
    counts: {
      open_total: rows.length,
      empty: empty.length,
      with_items: withItems.length,
      would_auto_close: empty.filter((r) => r.would_auto_close).length,
    },
  };
}

/**
 * ══ THE ONLY WRITER IN THIS FILE ═══════════════════════════════════════════
 *
 * Voids empty open orders and returns the rows it actually changed.
 *
 * THE GUARANTEE, IN ONE PLACE: the NOT EXISTS below is part of the UPDATE, so
 * this statement is incapable of selecting an order that has even one
 * order_items row. Both callers — the timed sweep and the manager's explicit
 * close — go through here, so neither can weaken it, and SQLite re-evaluates it
 * against the current state of order_items at UPDATE time, inside the
 * statement's own transaction. That is the race answer too: an item punched
 * after the list was rendered makes the subquery true, the row drops out, and
 * nothing happens to the captain's table.
 *
 * `idleHours` null = no idle requirement (a human is doing this deliberately).
 * A NUMBER means the timed path, and the ':hours > 0' term makes the disabled
 * setting structurally unable to close anything — with the window at 0 the
 * statement matches no row even though every order is trivially "idle 0 hours".
 *
 * Never call this from anywhere but the two exported closers.
 */
function voidEmptyOrders(
  db: DB,
  opts: { reason: string; idleHours: number | null; ids?: string[]; note: string },
): ClosedOrder[] {
  const ids = (opts.ids || []).map((v) => String(v || '').trim()).filter(Boolean).slice(0, MAX_CLOSE_BATCH);
  if (opts.ids && ids.length === 0) return [];

  const params: Record<string, any> = { reason: opts.reason, note: opts.note };
  let sql =
    'UPDATE orders' +
    "   SET status = 'void'," +
    "       voided_at = datetime('now')," +
    '       auto_close_reason = :reason,' +
    "       notes = TRIM(COALESCE(notes,'') || ' [' || :note || ']')," +
    "       updated_at = datetime('now')" +
    " WHERE status = 'open'" +
    // ── the guarantee ──────────────────────────────────────────────────────
    '   AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = orders.id)';

  if (opts.idleHours !== null) {
    params.hours = opts.idleHours;
    sql += '   AND :hours > 0' +
           '   AND ' + idleHoursSql('orders') + ' >= :hours';
  }
  if (ids.length) {
    const keys = ids.map((_, i) => ':id' + i);
    ids.forEach((v, i) => { params['id' + i] = v; });
    sql += '   AND orders.id IN (' + keys.join(',') + ')';
  }

  // created_at IS the last activity for every row this statement can touch —
  // the NOT EXISTS above guarantees there are no order_items to be newer.
  sql +=
    ' RETURNING id, order_number, order_type, table_id, COALESCE(total,0) AS order_total, created_at,' +
    "           ROUND((julianday('now') - julianday(created_at)) * 24.0, 2) AS idle_hours";

  const stmt = db.prepare(sql);
  const closed = db.transaction(() => {
    const updated = stmt.all(params) as any[];
    for (const r of updated) {
      // Audit rides inside the same transaction as the close, so the trail can
      // never claim a void that rolled back. logAuditEvent never throws.
      logAuditEvent(db, {
        event_type: 'order.auto_void',
        entity_type: 'order',
        entity_id: String(r.id),
        actor_email: 'system',
        note: opts.note,
        after: { status: 'void', auto_close_reason: opts.reason, idle_hours: r.idle_hours },
      });
    }
    return updated;
  })();

  if (!closed.length) return [];

  // Table identity for the caller's log/UI. A read, deliberately after the
  // commit: it must never be able to fail the close.
  const tblStmt = db.prepare('SELECT table_number, zone FROM restaurant_tables WHERE id = ?');
  return closed.map((r) => {
    let tableNumber: string | null = null;
    let floor: string | null = null;
    if (r.table_id) {
      try {
        const t = tblStmt.get(String(r.table_id)) as any;
        if (t) { tableNumber = t.table_number == null ? null : String(t.table_number); floor = t.zone == null ? null : String(t.zone); }
      } catch { /* table row missing — the order still closed */ }
    }
    return {
      id: String(r.id),
      order_number: Number(r.order_number) || 0,
      order_type: String(r.order_type || ''),
      table_id: r.table_id ? String(r.table_id) : null,
      table_number: tableNumber,
      floor,
      order_total: Math.round((Number(r.order_total) || 0) * 100) / 100,
      created_at: String(r.created_at || ''),
      idle_hours: Number(r.idle_hours) || 0,
      reason: opts.reason,
    };
  });
}

/** In-process throttle for the opportunistic (read-triggered) sweep. */
let lastSweepAt = 0;

/**
 * THE TIMED SWEEP. Closes empty open orders idle past the configured window,
 * and nothing else, ever.
 *
 * Wired into src/lib/scheduler.ts so a quiet day still frees its tables — a
 * read-triggered sweep alone would never fire on the day it matters most. It is
 * also cheap enough to call opportunistically when a screen loads the idle
 * list: with the window OFF it costs one settings lookup and touches nothing,
 * and the 60-second throttle keeps a polling board from re-running the UPDATE
 * on every tick. Pass throttleMs: 0 to force a pass (the scheduler's cadence is
 * minutes, so it never trips the throttle either way).
 *
 * BEST-EFFORT by contract: it swallows its own errors and reports
 * skipped: 'error', because it runs on a background tick and inside other
 * people's request paths, where a throw would surface as an unrelated failure.
 */
export function sweepStaleTables(opts?: { db?: DB; throttleMs?: number }): StaleSweepResult {
  const throttleMs = opts?.throttleMs === undefined ? 60_000 : Math.max(0, Number(opts.throttleMs) || 0);
  try {
    const db = opts?.db || getDb();
    const windowHours = getStaleTableWindowHours(db);
    if (windowHours <= 0) {
      return { enabled: false, window_hours: 0, closed: 0, orders: [], freed_tables: [], skipped: 'disabled' };
    }
    const now = Date.now();
    if (throttleMs > 0 && now - lastSweepAt < throttleMs) {
      return { enabled: true, window_hours: windowHours, closed: 0, orders: [], freed_tables: [], skipped: 'throttled' };
    }
    lastSweepAt = now;

    const closed = voidEmptyOrders(db, {
      reason: AUTO_CLOSE_REASON_IDLE_EMPTY,
      idleHours: windowHours,
      note: 'auto-void: empty table idle over ' + windowHours + 'h',
    });
    return {
      enabled: true,
      window_hours: windowHours,
      closed: closed.length,
      orders: closed,
      freed_tables: closed.filter((c) => c.table_number).map((c) => String(c.table_number)),
    };
  } catch (e: any) {
    console.error('[stale-tables] sweep failed:', e?.message || e);
    return { enabled: false, window_hours: 0, closed: 0, orders: [], freed_tables: [], skipped: 'error' };
  }
}

/**
 * A manager closing empty tables he is looking at, by id. Not a timer: no idle
 * requirement, and it works while the window is OFF — which is the state this
 * ships in, so without this the idle screen would be read-only on day one.
 *
 * Still cannot touch an order with items: it goes through the same guarded
 * statement, which re-checks emptiness as it writes. Anything not empty, not
 * open, or not in the list is simply not returned — compare `requested` with
 * `closed` to see what was skipped. At most MAX_CLOSE_BATCH (200) ids act per
 * call; `requested` counts what was asked for, so a truncated batch is visible
 * rather than silent.
 *
 * Unlike the sweep this THROWS on a database error: a person is waiting on the
 * answer and must not be told "closed 0" when the write actually failed.
 */
export function closeEmptyOrdersByHand(
  ids: string[],
  opts?: { db?: DB; actor?: string },
): { closed: number; orders: ClosedOrder[]; freed_tables: string[]; requested: number } {
  const db = opts?.db || getDb();
  const wanted = (ids || []).map((v) => String(v || '').trim()).filter(Boolean);
  if (!wanted.length) return { closed: 0, orders: [], freed_tables: [], requested: 0 };
  const actor = String(opts?.actor || '').trim();
  const closed = voidEmptyOrders(db, {
    reason: AUTO_CLOSE_REASON_EMPTY_BY_HAND,
    idleHours: null,
    ids: wanted,
    note: 'closed as empty' + (actor ? ' by ' + actor : ''),
  });
  return {
    closed: closed.length,
    orders: closed,
    freed_tables: closed.filter((c) => c.table_number).map((c) => String(c.table_number)),
    requested: wanted.length,
  };
}
