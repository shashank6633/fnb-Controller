import type Database from 'better-sqlite3';
import { settleAuthorityForFloor, type SettleActor } from './settle-authority';
import { floorLabel, normalizeFloor } from './cashier-presence';

/**
 * CAPTAIN REQUESTS THE BILL — the guest asked to pay, and the captain cannot.
 *
 * THE PROBLEM THIS EXISTS FOR. The captain tablet has always shipped a Bill
 * button that opens a full Collect-payment sheet (cash / UPI / card). Settle and
 * hold are now gated by src/lib/settle-authority.ts, so for a captain who is not
 * the floor's checked-in cashier that sheet 403s on the last tap — the worst
 * possible place to fail, with the guest watching. So the captain's action stops
 * being "take the money" and becomes "tell the cashier", and the request has to
 * arrive somewhere a cashier is actually looking.
 *
 * THE OWNER'S WORDS: a captain "can request bill to Cashier where it shows a
 * notification or Different color for table no to print the bill." Both, not
 * either — the colour alone fails a busy counter and a colour-blind cashier, so
 * every coloured tile carries a text label too, and the bell carries a count.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE THE REQUEST LIVES: four stamps on the ORDER row (see the migration in
 * src/lib/db.ts, beside bill_printed_at). Not a requests table, for three
 * reasons that each remove a way this could break:
 *
 *   IDEMPOTENT BY CONSTRUCTION. requestBill() writes
 *   COALESCE(bill_requested_at, datetime('now')), so the fourth impatient tap
 *   writes the same timestamp the first one did. There is one request per bill
 *   because there is one column per bill; no de-duplicator to get wrong.
 *
 *   IT RETIRES ITSELF. Every list here filters orders.status = 'open'. Settling,
 *   holding or voiding the bill removes the request with no cleanup call that a
 *   later change could forget — and the stamps stay on the settled row as a
 *   free record of how long the guest waited.
 *
 *   IT RIDES THE QUERY THE BOARD ALREADY RUNS. /api/dine-in/tables already
 *   selects the open order's columns for the "Bill printed" highlight, so the
 *   marked table costs one more column, not one more query per tile.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHO SEES A REQUEST: the people whose job it is to act on it, decided by
 * settleAuthorityForFloor() — the SAME function that decides settle — with ONE
 * carve-out for the override model:
 *
 *   - the cashier checked in on the bill's floor sees their own floor's
 *     requests ('cashier_on_floor');
 *   - a floor with NO cashier checked in falls through to manager/admin
 *     ('no_cashier_fallback'), so an unmanned floor's request is never
 *     dropped — which is the failure the guest would feel;
 *   - a MANNED floor does NOT badge managers, even though the override model
 *     lets them settle there ('manager_override' is excluded in mayAct below):
 *     the override is an escape path, not a work queue;
 *   - a takeaway or delivery bill has no floor at all, so it reaches everyone
 *     till-capable ('no_floor') — every till can close it, which is the only
 *     correct answer for a bill with no table;
 *   - and nobody is ever notified of work they would be 403'd on.
 *
 * Server-only (better-sqlite3). Never import from a "use client" component.
 */

/** 'requested' = nobody has looked yet; 'seen' = someone who may settle it has. */
export type BillRequestStatus = 'requested' | 'seen';

export interface BillRequest {
  orderId: string;
  orderNumber: number | null;
  orderType: string;
  /** null for takeaway/delivery. */
  tableId: string | null;
  /** '' when the bill has no table (takeaway) or the table row is gone. */
  tableNumber: string;
  /** restaurant_tables.zone, or null when the bill has no floor. */
  floor: string | null;
  /** Display form of `floor` ('' renders as 'Floor'), or null. */
  floorName: string | null;
  total: number;
  status: BillRequestStatus;
  requestedAt: string;
  /** Display name of the captain who asked. */
  requestedBy: string;
  seenAt: string | null;
  /** Display name of the cashier who acknowledged it. */
  seenBy: string;
}

/** Columns every read below needs, with the table joined for floor + number. */
const SELECT_SQL = `
  SELECT o.id, o.order_number, o.order_type, o.table_id, o.total,
         o.bill_requested_at, o.bill_requested_by, o.bill_seen_at, o.bill_seen_by,
         rt.id AS rt_id, rt.zone AS rt_zone, rt.table_number AS rt_number
    FROM orders o
    LEFT JOIN restaurant_tables rt ON rt.id = o.table_id
`;

/**
 * The floor a joined row belongs to, or null.
 *
 * MUST agree with orderFloor() in settle-authority.ts, because the authority
 * this module filters on is computed from it: null when the bill has no table,
 * AND null when the table row has been deleted. The `rt_id` test is what carries
 * the second case — a LEFT JOIN miss yields zone NULL, and normalizeFloor(NULL)
 * is '', which is a REAL floor (the unzoned "Floor"). Reading a deleted table as
 * the unzoned floor would hand an orphaned bill to whoever happens to be checked
 * in there.
 */
function rowFloor(row: any): string | null {
  if (!String(row.table_id ?? '').trim()) return null;
  if (row.rt_id == null) return null;
  return normalizeFloor(row.rt_zone);
}

function toRequest(row: any): BillRequest | null {
  const requestedAt = String(row.bill_requested_at || '');
  if (!requestedAt) return null;
  const floor = rowFloor(row);
  const seenAt = String(row.bill_seen_at || '') || null;
  return {
    orderId: String(row.id),
    orderNumber: row.order_number == null ? null : Number(row.order_number),
    orderType: String(row.order_type || ''),
    tableId: String(row.table_id ?? '').trim() || null,
    tableNumber: String(row.rt_number || ''),
    floor,
    floorName: floor === null ? null : floorLabel(floor),
    total: Number(row.total) || 0,
    status: seenAt ? 'seen' : 'requested',
    requestedAt,
    requestedBy: String(row.bill_requested_by || ''),
    seenAt,
    seenBy: String(row.bill_seen_by || ''),
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * READS
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * The request on one bill, or null if the captain has not asked.
 *
 * Deliberately NOT filtered by status: the captain's own screen has to keep
 * showing "requested" right up to the moment the bill settles, and a settled
 * order still carries its stamps.
 */
export function getBillRequest(db: Database.Database, orderId: string): BillRequest | null {
  const id = String(orderId || '').trim();
  if (!id) return null;
  const row = db.prepare(`${SELECT_SQL} WHERE o.id = ?`).get(id) as any;
  return row ? toRequest(row) : null;
}

/**
 * Every OPEN bill whose captain has asked for the bill, oldest first.
 *
 * Outlet scope follows the lenient convention the rest of the app uses (the
 * current outlet OR a legacy row with no outlet) so a pre-outlet order can never
 * become an invisible request.
 */
export function listOpenBillRequests(db: Database.Database, outletId?: string | null): BillRequest[] {
  const rows = db.prepare(`
    ${SELECT_SQL}
     WHERE o.status = 'open'
       AND o.bill_requested_at IS NOT NULL
       AND (o.outlet_id = ? OR o.outlet_id IS NULL)
     ORDER BY o.bill_requested_at ASC
  `).all(outletId ?? null) as any[];
  return rows.map(toRequest).filter((r): r is BillRequest => r !== null);
}

/**
 * The open requests THIS person could actually act on — the notification feed.
 *
 * `unseenOnly` is what the bell counts: once a cashier has opened the bill the
 * badge must stop nagging, while the table stays marked on the board until the
 * bill is closed. Authority is memoised per floor because a busy service asks
 * the same two or three questions over and over.
 */
export function visibleBillRequests(
  db: Database.Database,
  me: SettleActor | null,
  outletId?: string | null,
  opts?: { unseenOnly?: boolean },
): BillRequest[] {
  if (!me || !me.id) return [];
  const all = listOpenBillRequests(db, outletId);
  if (all.length === 0) return [];
  const allowed = new Map<string, boolean>();
  const mayAct = (floor: string | null): boolean => {
    const key = floor === null ? ' none' : floor;
    let hit = allowed.get(key);
    if (hit === undefined) {
      // Preserve undefined-vs-null into the authority call (its D8 contract):
      // omitted outlet means "any outlet", an explicit value scopes it.
      const a = outletId === undefined
        ? settleAuthorityForFloor(db, me, floor)
        : settleAuthorityForFloor(db, me, floor, outletId);
      // Under the OVERRIDE model management is `allowed` on EVERY floor — but a
      // manned floor's requests belong to ITS cashier. 'manager_override' is an
      // escape path, not a work queue, so it does not put the request in a
      // manager's feed; an UNMANNED floor still falls through to management
      // ('no_cashier_fallback'), so no request is ever silently dropped.
      hit = a.allowed && a.reason !== 'manager_override';
      allowed.set(key, hit);
    }
    return hit;
  };
  return all.filter((r) => (opts?.unseenOnly ? r.status === 'requested' : true) && mayAct(r.floor));
}

/** Badge number for the Action Inbox: unanswered requests this person may act on. */
export function pendingBillRequestCount(
  db: Database.Database,
  me: SettleActor | null,
  outletId?: string | null,
): number {
  return visibleBillRequests(db, me, outletId, { unseenOnly: true }).length;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * WRITES
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * Raise the request. Returns `created: false` when one was already standing —
 * the four-taps case — so the caller can say "already requested" instead of
 * pretending something new happened.
 *
 * The read and the write share one transaction because `created` cannot be
 * derived from UPDATE .changes: SQLite counts a row as changed even when
 * COALESCE wrote back the value that was already there.
 *
 * Only an OPEN bill can be requested. A settled or held bill has left the
 * cashier's board, so a request on it would be a marker nobody could ever clear.
 */
export function requestBill(
  db: Database.Database,
  orderId: string,
  requestedBy: string,
): { ok: boolean; created: boolean; request: BillRequest | null } {
  const id = String(orderId || '').trim();
  if (!id) return { ok: false, created: false, request: null };
  const by = String(requestedBy || '').trim().slice(0, 120);

  const run = db.transaction(() => {
    const cur = db.prepare('SELECT status, bill_requested_at FROM orders WHERE id = ?').get(id) as any;
    if (!cur) return { ok: false, created: false };
    if (cur.status !== 'open') return { ok: false, created: false };
    const already = !!cur.bill_requested_at;
    if (!already) {
      db.prepare(`
        UPDATE orders
           SET bill_requested_at = datetime('now'),
               bill_requested_by = ?,
               bill_seen_at      = NULL,
               bill_seen_by      = '',
               updated_at        = datetime('now')
         WHERE id = ? AND status = 'open' AND bill_requested_at IS NULL
      `).run(by, id);
    }
    return { ok: true, created: !already };
  });

  const res = run();
  return { ...res, request: res.ok ? getBillRequest(db, id) : null };
}

/**
 * Acknowledge it: "a cashier has seen this and is coming."
 *
 * WHO MAY CALL THIS IS THE ROUTE'S JOB and it must be someone whose
 * settleAuthority allows the bill — if any passer-by could mark a request seen,
 * opening the board would silence the bell for a cashier who never looked.
 *
 * Idempotent, and the FIRST acknowledgement is the one that sticks: the guest's
 * wait is measured to whoever actually picked it up, not to the last person who
 * clicked the tile.
 */
export function markBillRequestSeen(
  db: Database.Database,
  orderId: string,
  seenBy: string,
): BillRequest | null {
  const id = String(orderId || '').trim();
  if (!id) return null;
  const by = String(seenBy || '').trim().slice(0, 120);
  db.prepare(`
    UPDATE orders
       SET bill_seen_at = datetime('now'), bill_seen_by = ?
     WHERE id = ?
       AND status = 'open'
       AND bill_requested_at IS NOT NULL
       AND bill_seen_at IS NULL
  `).run(by, id);
  return getBillRequest(db, id);
}

/**
 * Withdraw the request — the mis-tap, or a guest who decided to order more.
 *
 * Without this a wrong tap marks the table until the bill is settled, and the
 * cashier walks to a table that never asked. Clears the acknowledgement too, so
 * a re-request later starts a fresh, un-seen alert rather than arriving
 * pre-silenced.
 */
export function cancelBillRequest(db: Database.Database, orderId: string): boolean {
  const id = String(orderId || '').trim();
  if (!id) return false;
  const res = db.prepare(`
    UPDATE orders
       SET bill_requested_at = NULL, bill_requested_by = '',
           bill_seen_at = NULL, bill_seen_by = '',
           updated_at = datetime('now')
     WHERE id = ? AND status = 'open' AND bill_requested_at IS NOT NULL
  `).run(id);
  return res.changes > 0;
}
