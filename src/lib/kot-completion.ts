import type Database from 'better-sqlite3';
import { deductInventoryForSale } from './db';
import { resolveFloorStore } from './store-engine';

/**
 * KOT COMPLETION — the SERVED bump, its undo window, and the DEFERRED consume.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULING THIS FILE IMPLEMENTS (owner, 2026-08-12)
 *
 * "Undo a completed KOT" — and specifically: DEFER THE DEDUCTION, DO NOT
 * REVERSE IT. Both halves matter.
 *
 * WHICH BUTTON IS "COMPLETE". Nothing in this app is labelled "Complete KOT".
 * There are two candidates and only one of them touches stock:
 *   - the captain's per-ITEM "Complete" (orders/[id] complete_item) writes
 *     order_items.completed_at, has an UNLIMITED undo already
 *     (uncomplete_item), and moves no stock. Left alone by this change.
 *   - the KDS board's SERVED bump is the real completion: it used to deduct
 *     every recipe-linked ingredient across the central, department and
 *     (optionally) floor-store rails in one transaction, and that deduction is
 *     what makes the order un-voidable afterwards.
 * This file is about SERVED.
 *
 * WHY DEFER AND NOT REVERSE. src/app/api/dine-in/orders/[id]/void/route.ts
 * carries an explicit, argued decision AGAINST a compensating-credit path for
 * consumption: a second stock-movement direction needs its own negative-balance
 * guard and its own audit type, and "refusing is reversible; a stray credit is
 * not". Reversing an undo would be exactly that second path. So the deduction
 * simply does not happen at the bump: the ticket goes 'served', a short window
 * opens, and only when the window has PASSED does the consume run. An undo
 * inside the window means nothing ever left stock — there is nothing to credit
 * back, and no new movement type exists anywhere in the system.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE WINDOW IS SERVER STATE, NOT A CLIENT TIMER
 *
 * kots.served_at is the anchor. It had to be a NEW column: kots.updated_at is
 * POLLUTED — the reprint route (kds/[id]/reprint) and the resend route
 * (kds/[id]/resend) both bump it, so a chef who re-sends a ticket to the printer
 * would silently re-open (or extend) the undo window on an already-served KOT.
 * created_at is the fire time, not the serve time. Neither can anchor this.
 *
 * Every window test is a SQL predicate evaluated inside the writing statement
 * (see undoServedKot / dueKotIds). A client that lies about the clock, a tab
 * left open past the window, a replayed request — all land on a WHERE clause
 * that is false, so they change zero rows instead of racing. The UI's countdown
 * is a rendering of what the server just said, never the authority.
 *
 * THE TWO PREDICATES ARE EXACT COMPLEMENTS:
 *      undoable   ⇔  served_at >  datetime('now', '-W seconds')
 *      due        ⇔  served_at <= datetime('now', '-W seconds')
 * so there is no instant where a KOT is both undoable and due, and none where
 * it is neither. Keep them complementary if you touch either one.
 *
 * SQLite's datetime() has one-second resolution, so a 10-second window is
 * honoured to within one second (a request landing in the same second as the
 * boundary reads as still-open). That is the actual precision — do not write a
 * comment or a UI label that claims better.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT COMMITS THE DEFERRED CONSUME
 *
 * commitDueKotConsumption() is the single writer. It is called:
 *   - from every KDS bump (any ticket, any transition) — a working kitchen
 *     bumps constantly, so this is the common path;
 *   - from the undo route's GET, which the KDS board polls once a second while
 *     a ticket is inside its window: that lands the commit within about a
 *     second of the window closing;
 *   - from an unref'd one-shot timer scheduled by the bump (scheduleDueSweep),
 *     so a chef who walks away from the screen still gets the commit on time.
 *     The timer is an OPTIMISATION, never the guarantee — a process restart
 *     loses it.
 * The GUARANTEE is the same one this rail always had: settle and hold each
 * re-read order_items.recipe_deducted_at inside their own transaction and
 * deduct anything still unstamped. A bill that settles while a window is open
 * therefore deducts AT SETTLE, exactly once, and the sweep then skips those
 * lines because they are stamped. No ingredient can leave the building with no
 * stock record, and none can be deducted twice.
 *
 * IDEMPOTENCE IS STILL order_items.recipe_deducted_at, LINE BY LINE, STAMPED
 * ONLY ON A SUCCESSFUL DEDUCT. Nothing about that changed — only WHEN it runs.
 * If you ever make the undo clear a stamp, you break settle's backstop too
 * (it would deduct a second time), so: never clear recipe_deducted_at.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * KNOWN, DELIBERATE CONSEQUENCE — THE VOID WINDOW
 *
 * void/route.ts refuses an order once ANY line carries recipe_deducted_at. With
 * the deduction deferred, a ticket bumped 'served' carries no stamp until the
 * window closes, so for those seconds a manager CAN still void it — where
 * before the void was refused the instant the ticket was bumped. This is a real
 * (small, manager-only, window-bounded) widening of an existing hole: an order
 * whose food was cooked but never bumped on the KDS has always been voidable.
 * It is bounded here by clamping the window to MAX_UNDO_WINDOW_SEC. The proper
 * closure is one extra condition in void/route.ts — refuse when the order has a
 * KOT with served_at set — which is NOT this file's to write. It is reported as
 * a handoff. Do not "fix" it by making the sweep deduct for voided orders: that
 * would post consumption against an order the house has declared never happened.
 *
 * Server-only (better-sqlite3 + db.ts). Never import from a "use client" file.
 */

/** Settings key holding the undo window, in seconds. Seeded in db.ts. */
export const UNDO_WINDOW_SETTING = 'kot_undo_window_seconds';
/** The owner asked for exactly this. Matches the db.ts seed. */
export const DEFAULT_UNDO_WINDOW_SEC = 10;
/**
 * Upper clamp. The window is the exact period in which a served ticket is still
 * voidable (see THE VOID WINDOW above) and in which its consumption has not yet
 * been posted, so a hand-edited settings row must not be able to turn 10
 * seconds into an hour.
 */
export const MAX_UNDO_WINDOW_SEC = 120;

/** KOT lifecycle, in order. The KDS bump walks it ONE step at a time. */
export const KOT_FLOW = ['new', 'preparing', 'ready', 'served'] as const;
export type KotStatus = (typeof KOT_FLOW)[number];

/**
 * The status a KOT returns to when its SERVED bump is undone.
 *
 * It is a constant and not a stored "previous status" column because the bump
 * route now derives its target server-side and advances exactly one step, so
 * 'served' is only ever reachable from 'ready'. A KOT written straight to
 * 'served' by the offline replay (orders/replay) has served_at NULL and is
 * therefore never undoable at all — see undoServedKot's predicate.
 */
export const UNDO_TARGET_STATUS: KotStatus = 'ready';

/**
 * The ONE legal move from a given KOT status — the server's own transition
 * table, deliberately not a caller's payload.
 *
 * An unknown or legacy status starts the ticket at the beginning of the flow
 * rather than jumping it to the end; 'served' is terminal and returns itself,
 * which is how the bump route detects "nothing to do".
 */
export function nextKotStatus(current: string): KotStatus {
  const i = (KOT_FLOW as readonly string[]).indexOf(String(current || ''));
  if (i < 0) return KOT_FLOW[0];
  return KOT_FLOW[Math.min(i + 1, KOT_FLOW.length - 1)];
}

/**
 * Complete a ticket: stamp the serve time on the KOT (the undo window's only
 * anchor) and on its lines, and advance both to 'served'.
 *
 * NO STOCK MOVES HERE. That is the whole point of the deferral — the consume is
 * applyKotConsumption(), run later by commitDueKotConsumption() once the window
 * has closed (or inline by the caller when the window is 0).
 *
 * Call inside the caller's transaction. served_at on the KOT is set
 * UNCONDITIONALLY (a re-completion after an undo must start a fresh window),
 * while the LINE's served_at is COALESCE'd so the item-journey keeps the
 * earliest serve time it has ever had.
 */
export function markKotServed(db: Database.Database, kotId: string): void {
  db.prepare("UPDATE kots SET status = 'served', served_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(kotId);
  db.prepare("UPDATE order_items SET status = 'served', served_at = COALESCE(served_at, datetime('now')) WHERE kot_id = ?").run(kotId);
}

/**
 * The configured undo window in seconds, clamped to [0, MAX_UNDO_WINDOW_SEC]
 * and defaulted on anything unparseable.
 *
 * 0 is meaningful and supported: it disables the undo entirely and the bump
 * consumes inline, which is byte-for-byte the behaviour this rail had before
 * the window existed. That is the escape hatch if deferral ever has to be
 * switched off in service without a deploy.
 */
export function getUndoWindowSeconds(db: Database.Database): number {
  let raw: unknown;
  try {
    raw = (db.prepare('SELECT value FROM settings WHERE key = ?').get(UNDO_WINDOW_SETTING) as any)?.value;
  } catch { return DEFAULT_UNDO_WINDOW_SEC; }
  if (raw === null || raw === undefined || String(raw).trim() === '') return DEFAULT_UNDO_WINDOW_SEC;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_UNDO_WINDOW_SEC;
  return Math.min(MAX_UNDO_WINDOW_SEC, Math.round(n));
}

/** The window boundary as a SQLite modifier, e.g. '-10 seconds'. Always BOUND, never interpolated. */
function windowModifier(db: Database.Database): string {
  return `-${getUndoWindowSeconds(db)} seconds`;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * THE CONSUME (moved verbatim from the bump route — same rails, later clock)
 * ───────────────────────────────────────────────────────────────────────────*/

export interface ConsumeResult {
  /** Lines that deducted and were stamped. */
  deducted: number;
  /** Lines that threw inside deductInventoryForSale — left unstamped for settle. */
  failed: number;
  /** Why nothing ran at all, when nothing ran. */
  skipped: '' | 'kot_not_found' | 'order_missing' | 'order_void' | 'no_pending_lines';
}

/**
 * Post the recipe consumption for one KOT's still-unstamped lines.
 *
 * MUST be called inside a transaction owned by the caller — the stamp and the
 * movement have to commit or roll back together, which is what keeps STOCK
 * MOVES EXACTLY ONCE true.
 */
export function applyKotConsumption(db: Database.Database, kotId: string): ConsumeResult {
  const out: ConsumeResult = { deducted: 0, failed: 0, skipped: '' };
  const kot = db.prepare('SELECT id, order_id FROM kots WHERE id = ?').get(kotId) as any;
  if (!kot) { out.skipped = 'kot_not_found'; return out; }

  const order = db.prepare(`
    SELECT o.bill_type, o.status, t.zone AS zone
    FROM orders o
    LEFT JOIN restaurant_tables t ON t.id = o.table_id
    WHERE o.id = ?
  `).get(kot.order_id) as any;
  if (!order) { out.skipped = 'order_missing'; return out; }
  // A voided order is skipped — the house has declared it never happened.
  if (order.status === 'void') { out.skipped = 'order_void'; return out; }

  const cook = db.prepare(`
    SELECT id, recipe_id, quantity, station FROM order_items
    WHERE kot_id = ? AND recipe_id IS NOT NULL AND recipe_id != '' AND recipe_deducted_at IS NULL
  `).all(kotId) as any[];
  if (!cook.length) { out.skipped = 'no_pending_lines'; return out; }

  // FAIL-SAFE floor routing: map this order's table zone → floor bar store once.
  // Any failure (or an unmapped zone) → undefined → central deduct.
  // deductInventoryForSale still gates the store path on tm_floor_autodeduct.
  let floorStoreId: string | undefined;
  try {
    floorStoreId = resolveFloorStore(db, order.zone) || undefined;
  } catch (e) {
    console.error('[kot-completion floor-resolve]', kot.order_id, e);
    floorStoreId = undefined;
  }

  const stamp = db.prepare("UPDATE order_items SET recipe_deducted_at = datetime('now') WHERE id = ?");
  for (const it of cook) {
    try {
      // DEPARTMENT ROUTING READS THE LINE'S station, NEVER kot.station.
      // kot-fire.ts coerces a blank line station to the literal 'kitchen' when
      // it groups lines into tickets, and 'Kitchen' is a REAL department (the
      // main-kitchen roll-up) — so resolving from kot.station would silently
      // debit the whole main kitchen for every station-less item. One ticket can
      // also legitimately carry lines from more than one station, which a
      // per-KOT value cannot express. Pass it.station through even when it is
      // blank or unmapped (sushi, terracegrill): applyDeduct records the skip
      // and its reason and moves nothing, because debiting the WRONG kitchen is
      // worse than debiting none. Do NOT "simplify" this to kot.station, and do
      // NOT add a fallback department here.
      deductInventoryForSale(
        db, it.recipe_id, it.quantity, it.id, order.bill_type || 'normal',
        { storeId: floorStoreId, station: it.station },
      );
      stamp.run(it.id);   // stamp only on success → settle backstops any that threw
      out.deducted++;
    } catch (e) {
      out.failed++;
      console.error('[kot-completion recipe-deduct]', it.id, e);
    }
  }
  return out;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * THE DEFERRED COMMIT
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * KOTs whose undo window has closed and whose consumption has not been posted.
 *
 * served_at IS NOT NULL is load-bearing twice over: it is what makes the window
 * arithmetic possible at all, and it is what keeps this sweep off historical
 * data. Every kots row that existed before the column was added has served_at
 * NULL, as does every ticket the offline replay writes straight to 'served', so
 * this can never reach back and post consumption for last month's service.
 */
function dueKotIds(db: Database.Database, limit = 200): string[] {
  return (db.prepare(`
    SELECT k.id
    FROM kots k
    JOIN orders o ON o.id = k.order_id
    WHERE k.status = 'served'
      AND k.served_at IS NOT NULL
      AND k.served_at <= datetime('now', ?)
      AND o.status != 'void'
      AND EXISTS (
        SELECT 1 FROM order_items oi
        WHERE oi.kot_id = k.id
          AND oi.recipe_id IS NOT NULL AND oi.recipe_id != ''
          AND oi.recipe_deducted_at IS NULL
      )
    ORDER BY k.served_at ASC
    LIMIT ?
  `).all(windowModifier(db), limit) as any[]).map((r) => String(r.id));
}

export interface SweepResult { kots: number; deducted: number; failed: number }

/**
 * Post every consumption whose undo window has closed.
 *
 * ONE TRANSACTION PER KOT, on purpose: a ticket whose deduct throws must not
 * roll back the tickets swept alongside it. Call this OUTSIDE any transaction
 * of your own.
 */
export function commitDueKotConsumption(db: Database.Database): SweepResult {
  const out: SweepResult = { kots: 0, deducted: 0, failed: 0 };
  let ids: string[] = [];
  try { ids = dueKotIds(db); } catch (e) { console.error('[kot-completion sweep-select]', e); return out; }
  for (const id of ids) {
    try {
      const r = db.transaction(() => applyKotConsumption(db, id))();
      if (r.deducted || r.failed) out.kots++;
      out.deducted += r.deducted;
      out.failed += r.failed;
    } catch (e) {
      console.error('[kot-completion sweep-commit]', id, e);
    }
  }
  return out;
}

/**
 * Fire one sweep shortly after the current window would close.
 *
 * A single coalesced, UNREF'd timer for the whole process: unref'd so it can
 * never hold Node open, coalesced so a busy kitchen does not accumulate one
 * timer per ticket. Purely an optimisation for the case where nobody is looking
 * at the KDS — the bump path, the undo route's GET and settle/hold's backstop
 * are what actually guarantee the consume lands.
 */
declare global {
  // eslint-disable-next-line no-var
  var __fnbKotSweepAt__: { at: number; timer: NodeJS.Timeout } | undefined;
}
export function scheduleDueSweep(db: Database.Database, extraMs = 1500): void {
  try {
    const delay = getUndoWindowSeconds(db) * 1000 + extraMs;
    const at = Date.now() + delay;
    const pending = globalThis.__fnbKotSweepAt__;
    if (pending && pending.at <= at) return;          // an earlier sweep already covers this
    if (pending) clearTimeout(pending.timer);
    const timer = setTimeout(() => {
      globalThis.__fnbKotSweepAt__ = undefined;
      try { commitDueKotConsumption(db); } catch (e) { console.error('[kot-completion timer-sweep]', e); }
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
    globalThis.__fnbKotSweepAt__ = { at, timer };
  } catch (e) {
    console.error('[kot-completion schedule]', e);
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * THE UNDO
 * ───────────────────────────────────────────────────────────────────────────*/

export type UndoRefusal =
  /** No such ticket. */
  | 'kot_not_found'
  /** The ticket is not 'served' — nothing to undo. */
  | 'not_served'
  /** Served, but the window has closed: the consumption is posted (or due). */
  | 'window_closed'
  /** A line under this ticket is already stamped — settle/hold beat the sweep to it. */
  | 'already_deducted'
  /** The order is no longer open (settled, held, voided). */
  | 'order_closed';

export interface UndoResult {
  ok: boolean;
  reason: '' | UndoRefusal;
  /** The status the ticket is in AFTER the call, whatever the outcome. */
  status: string;
}

/**
 * Undo a SERVED bump, inside the window, atomically.
 *
 * THE WHOLE GUARD IS THE UPDATE's WHERE CLAUSE. Every reason to refuse — wrong
 * status, expired window, a stamp already written, an order that has since been
 * settled or voided — is a condition on the one statement that changes the row.
 * A late or replayed undo therefore changes zero rows and is a NO-OP, not a
 * race: there is no read-then-write gap for the sweep, a settle or a second
 * undo to slip into. The follow-up SELECT only exists to name the reason for
 * the operator; it never decides anything.
 */
export function undoServedKot(db: Database.Database, kotId: string): UndoResult {
  const run = db.transaction((): UndoResult => {
    const res = db.prepare(`
      UPDATE kots
         SET status = ?, served_at = NULL, updated_at = datetime('now')
       WHERE id = ?
         AND status = 'served'
         AND served_at IS NOT NULL
         AND served_at > datetime('now', ?)
         AND NOT EXISTS (
           SELECT 1 FROM order_items oi
           WHERE oi.kot_id = kots.id AND oi.recipe_deducted_at IS NOT NULL
         )
         AND EXISTS (
           SELECT 1 FROM orders o WHERE o.id = kots.order_id AND o.status = 'open'
         )
    `).run(UNDO_TARGET_STATUS, kotId, windowModifier(db));

    if (res.changes === 1) {
      // Put the LINES back where the bump found them. order_items.served_at is
      // written by exactly one statement in this codebase (the SERVED bump), so
      // clearing it here is exact and cannot erase a scan-out stamp — that is
      // kitchen_sent_at, a different column, and it is what tells us which
      // status each line has to return to. Clearing served_at separately from
      // the KOT's own served_at is what makes a SECOND undo work: leave it set
      // and the next bump's COALESCE keeps the stale time.
      db.prepare(`
        UPDATE order_items
           SET status = CASE
                          WHEN status = 'served' AND kitchen_sent_at IS NOT NULL THEN 'kitchen_sent'
                          WHEN status = 'served' THEN 'fired'
                          ELSE status
                        END,
               served_at = NULL
         WHERE kot_id = ? AND served_at IS NOT NULL
      `).run(kotId);
      return { ok: true, reason: '', status: UNDO_TARGET_STATUS };
    }

    // Nothing changed. Work out which condition failed, for the operator's copy.
    const k = db.prepare(`
      SELECT k.status, k.served_at, o.status AS order_status,
             (SELECT COUNT(*) FROM order_items oi
               WHERE oi.kot_id = k.id AND oi.recipe_deducted_at IS NOT NULL) AS stamped
      FROM kots k LEFT JOIN orders o ON o.id = k.order_id
      WHERE k.id = ?
    `).get(kotId) as any;
    if (!k) return { ok: false, reason: 'kot_not_found', status: '' };
    if (k.status !== 'served' || !k.served_at) return { ok: false, reason: 'not_served', status: String(k.status || '') };
    if (Number(k.stamped) > 0) return { ok: false, reason: 'already_deducted', status: 'served' };
    if (k.order_status !== 'open') return { ok: false, reason: 'order_closed', status: 'served' };
    return { ok: false, reason: 'window_closed', status: 'served' };
  });
  return run();
}

/* ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE BOARD RENDERS
 * ───────────────────────────────────────────────────────────────────────────*/

export interface UndoState {
  kot_id: string;
  /** Is an undo possible RIGHT NOW? The server's answer, not the browser's. */
  undoable: boolean;
  /** Whole seconds left, server-computed, 0 once the window has closed. */
  remaining_sec: number;
  /** The configured window, so the UI can label it honestly. */
  window_sec: number;
  reason: '' | UndoRefusal;
  status: string;
  kot_number: number | null;
  station: string;
  table_number: string | null;
  order_type: string;
  order_number: number | null;
}

/**
 * Everything the KDS needs to draw (or stop drawing) the undo affordance for one
 * ticket. remaining_sec is derived from served_at by SQLite on every call, so a
 * page refresh, a second device or a tab restored from the background all get
 * the same truth — nothing here can be reconstructed from a React state variable.
 */
export function kotUndoState(db: Database.Database, kotId: string): UndoState | null {
  const w = getUndoWindowSeconds(db);
  const row = db.prepare(`
    SELECT k.id, k.status, k.served_at, k.kot_number, k.station,
           o.status AS order_status, o.order_type, o.order_number,
           t.table_number,
           CAST(strftime('%s', k.served_at, ?) - strftime('%s', 'now') AS INTEGER) AS remaining,
           (SELECT COUNT(*) FROM order_items oi
             WHERE oi.kot_id = k.id AND oi.recipe_deducted_at IS NOT NULL) AS stamped
    FROM kots k
    JOIN orders o ON o.id = k.order_id
    LEFT JOIN restaurant_tables t ON t.id = o.table_id
    WHERE k.id = ?
  `).get(`+${w} seconds`, kotId) as any;
  if (!row) return null;

  const remaining = Math.max(0, Number(row.remaining) || 0);
  let reason: '' | UndoRefusal = '';
  if (row.status !== 'served' || !row.served_at) reason = 'not_served';
  else if (Number(row.stamped) > 0) reason = 'already_deducted';
  else if (row.order_status !== 'open') reason = 'order_closed';
  else if (remaining <= 0) reason = 'window_closed';

  return {
    kot_id: String(row.id),
    undoable: reason === '',
    remaining_sec: reason === '' ? remaining : 0,
    window_sec: w,
    reason,
    status: String(row.status || ''),
    kot_number: row.kot_number ?? null,
    station: String(row.station || ''),
    table_number: row.table_number ?? null,
    order_type: String(row.order_type || ''),
    order_number: row.order_number ?? null,
  };
}
