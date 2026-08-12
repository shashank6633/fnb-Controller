import type Database from 'better-sqlite3';
import { logAuditEvent } from './db';

/**
 * CASHIER FLOOR PRESENCE — who is manning which floor, right now.
 *
 * The owner's rule (the OVERRIDE model — see src/lib/settle-authority.ts): a
 * cashier logs in and says which floor they are on; a captain's bill request
 * goes to THAT floor's cashier; staff may not settle past a live holder; and
 * manager/admin may always settle — recorded as an override when a cashier
 * held the floor. Every one of those needs one answer this database could not
 * previously give — "is there a cashier on this floor?"
 *
 * WHAT A FLOOR IS. restaurant_tables.zone, verbatim. An order reaches a floor
 * through its table_id, so a takeaway/delivery order has NO floor. An empty
 * zone ('') is a real floor — the unzoned tables the captain UI labels "Floor"
 * — never "unset". floorLabel() is the only place that translation happens.
 *
 * WHAT THIS IS NOT. It is a live register, not an audit log. The table holds at
 * most one row per (outlet, floor) and a handover overwrites it, so there is no
 * shift history here by design. Who actually took money is
 * order_payments.created_by, written on every settle.
 *
 * STALENESS IS ONE-WAY. Every read here honours the cashier_presence_timeout_min
 * window, so a cashier who went home stops holding their floor. Note what that
 * can and cannot do downstream (src/lib/settle-authority.ts): an expired floor
 * reads as "nobody is here", which WIDENS who may settle — manager, admin, and
 * the expired cashier themselves. Expiry can never lock the till.
 *
 * Server-only: this file talks to better-sqlite3. Never import it from a
 * "use client" component.
 */

/** Settings key holding the inactivity window, in minutes. Seeded in db.ts. */
export const PRESENCE_TIMEOUT_SETTING = 'cashier_presence_timeout_min';
/** Used when the setting is missing or unreadable. Matches the db.ts seed. */
export const DEFAULT_PRESENCE_TIMEOUT_MIN = 720;
/** Hard bounds on the setting: below 1 minute presence is useless, above 24h it never expires. */
const MIN_TIMEOUT_MIN = 1;
const MAX_TIMEOUT_MIN = 1440;

/** A cashier currently holding a floor. Timestamps are UTC 'YYYY-MM-DD HH:MM:SS'. */
export interface PresentCashier {
  userId: string;
  userName: string;
  /** restaurant_tables.zone. '' = the unzoned "Floor". */
  floor: string;
  /** '' = the NULL/default outlet. */
  outletId: string;
  checkedInAt: string;
  lastSeen: string;
}

/** One row of the owner's floor board — every floor, present cashier or not. */
export interface FloorPresence {
  /** restaurant_tables.zone. '' = the unzoned floor. */
  floor: string;
  /** Display form: '' renders as 'Floor'. */
  label: string;
  /** Active tables on this floor. 0 means the floor only exists as a stale check-in. */
  activeTables: number;
  /** The cashier holding this floor NOW, or null → "No Cashier Logged In". */
  cashier: PresentCashier | null;
  /**
   * A check-in that has gone past the inactivity window. Present so the board
   * can say "Ravi checked in at 09:12, not seen since" instead of pretending
   * nobody was ever here. An expired holder does NOT hold the floor.
   */
  expired: PresentCashier | null;
}

export interface CheckInArgs {
  userId: string;
  userName: string;
  /** restaurant_tables.zone. Pass '' for the unzoned floor. */
  floor: string;
  /** null / undefined / '' all mean the NULL-default outlet. */
  outletId?: string | null;
}

export interface CheckOutArgs {
  floor: string;
  outletId?: string | null;
  /**
   * Self-checkout: release the floor ONLY if this user holds it. Omit to force
   * the floor clear whoever holds it — the manager/admin escape hatch for a
   * cashier who walked off without checking out. Whether the caller MAY do that
   * is the route's decision, not this function's.
   */
  userId?: string | null;
  /**
   * Who performed a FORCE clear (userId omitted). Used only to attribute the
   * audit record when the cleared row belonged to somebody else; a self-clear
   * (clearedBy.userId === the holder) records nothing.
   */
  clearedBy?: { userId: string; userName?: string | null } | null;
}

/**
 * Result of checkInGuarded(). `ok: false` means the floor is held by a LIVE
 * other cashier and the caller was not allowed to evict — the route turns this
 * into a 409 naming the holder. On success, `evicted` names the live holder
 * who was displaced (already recorded in audit_events by checkIn itself), or
 * null when the floor was free / already mine.
 */
export type CheckInAttempt =
  | { ok: true; presence: PresentCashier; evicted: PresentCashier | null }
  | { ok: false; heldBy: PresentCashier };

/* ─────────────────────────────────────────────────────────────────────────────
 * NORMALISATION — one function per concept, used on BOTH sides of every compare
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * Canonical floor string. Trim only — never lowercase: the stored value IS the
 * display value, and both sides of every comparison come from the same
 * restaurant_tables.zone column, so case cannot drift. Trimming exists because
 * a zone typed with a trailing space would otherwise become a second, invisible
 * floor that no check-in could ever match.
 */
export function normalizeFloor(zone: unknown): string {
  return String(zone ?? '').trim();
}

/**
 * Canonical outlet key. Pass whatever getCurrentOutletId() returned; '' stands
 * for null.
 *
 * MEASURED, AND NOT WHAT THE NAME SUGGESTS: all 3 rows of restaurant_tables in
 * this database carry a REAL outlet id ('5795ca16…'), not NULL and not ''. So
 * '' is NOT the ordinary value here — getCurrentOutletId() resolves the default
 * outlet row and only returns null when the outlets table is empty. The only
 * rule that matters is that the SAME value reaches checkIn() and the reads, and
 * every caller gets it from getCurrentOutletId(), so it does.
 */
export function normalizeOutlet(outletId: unknown): string {
  return String(outletId ?? '').trim();
}

/**
 * Outlet predicate for a table/row that may or may not have been assigned one.
 *
 * A scoped read matches the outlet asked for OR a row with no outlet at all.
 * The unassigned row is included DELIBERATELY: this drives the owner's floor
 * board, and a floor that silently disappears because someone created a table
 * without an outlet reads on screen as "that floor needs no cashier" — the one
 * lie this board must not tell. Over-showing a floor is harmless (the worst case
 * is an extra "No Cashier Logged In" row); hiding one is not.
 *
 * This widening is confined to the BOARD. Settle authority goes through
 * cashierOnFloor(), which compares cashier_presence.outlet_id exactly.
 */
function outletClause(column: string): string {
  return '(' + column + " = ? OR " + column + " IS NULL OR " + column + " = '')";
}

/** Display name for a floor. The unzoned floor ('') reads as 'Floor', matching the captain UI. */
export function floorLabel(floor: string): string {
  return normalizeFloor(floor) === '' ? 'Floor' : normalizeFloor(floor);
}

/* ─────────────────────────────────────────────────────────────────────────────
 * THE WINDOW
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * Inactivity window in minutes. Clamped to [1, 1440] and defaulted on anything
 * unparseable, so a hand-edited settings row can never make presence permanent
 * (which would block managers forever) or instant (which would flap).
 */
export function getPresenceTimeoutMinutes(db: Database.Database): number {
  let raw: unknown;
  try {
    raw = (db.prepare('SELECT value FROM settings WHERE key = ?').get(PRESENCE_TIMEOUT_SETTING) as any)?.value;
  } catch { return DEFAULT_PRESENCE_TIMEOUT_MIN; }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PRESENCE_TIMEOUT_MIN;
  return Math.min(MAX_TIMEOUT_MIN, Math.max(MIN_TIMEOUT_MIN, Math.round(n)));
}

/**
 * The SQLite modifier for the freshness cutoff, e.g. '-720 minutes'. Bound as a
 * PARAMETER to datetime('now', ?) — never interpolated — so the window can
 * never carry SQL.
 */
function cutoffModifier(db: Database.Database): string {
  return `-${getPresenceTimeoutMinutes(db)} minutes`;
}

/** The cutoff timestamp itself, in the same UTC text format the columns store. */
export function presenceCutoff(db: Database.Database): string {
  const row = db.prepare("SELECT datetime('now', ?) AS c").get(cutoffModifier(db)) as any;
  return String(row?.c || '');
}

function toPresent(row: any): PresentCashier {
  return {
    userId: String(row.user_id || ''),
    userName: String(row.user_name || ''),
    floor: normalizeFloor(row.floor),
    outletId: normalizeOutlet(row.outlet_id),
    checkedInAt: String(row.checked_in_at || ''),
    lastSeen: String(row.last_seen || ''),
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * READS
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * The cashier holding `floor` right now, or null.
 *
 * `outletId` OMITTED (undefined) matches ANY outlet — the forgiving behaviour a
 * single-outlet install wants, and what makes cashierOnFloor(db, 'Rooftop')
 * do the obvious thing. Pass it EXPLICITLY (a string, or null/'' for the
 * NULL-default outlet) on a multi-outlet database, or a cashier on Branch 2's
 * Rooftop will read as holding Main's Rooftop. settle-authority passes through
 * exactly what its caller supplied — undefined stays undefined (D8) — and every
 * route supplies getCurrentOutletId().
 */
export function cashierOnFloor(
  db: Database.Database,
  floor: string,
  outletId?: string | null,
): PresentCashier | null {
  const f = normalizeFloor(floor);
  const scoped = outletId !== undefined;
  const sql = `
    SELECT outlet_id, floor, user_id, user_name, checked_in_at, last_seen
      FROM cashier_presence
     WHERE floor = ?
       AND checked_out_at = ''
       AND last_seen >= datetime('now', ?)
       ${scoped ? 'AND outlet_id = ?' : ''}
     ORDER BY last_seen DESC
     LIMIT 1
  `;
  const params: unknown[] = [f, cutoffModifier(db)];
  if (scoped) params.push(normalizeOutlet(outletId));
  const row = db.prepare(sql).get(...(params as any[])) as any;
  return row ? toPresent(row) : null;
}

/**
 * Where this user is checked in right now, or null. Drives the post-login "which
 * floor are you on?" prompt: null means ask. An EXPIRED check-in returns null —
 * from the app's point of view that person is not on duty, and re-checking in is
 * one tap.
 *
 * `outletId` follows the same rule as cashierOnFloor (review defect D11):
 * OMITTED (undefined) matches any outlet — right for a single-outlet install —
 * while an explicit value (a string, or null/'' for the NULL-default outlet)
 * scopes the read, so on a multi-outlet database a check-in at Branch 2 never
 * shows up as "where I am" while working Main. buildStatus() in the presence
 * route and settle-authority both pass the outlet they were resolved for.
 */
export function getMyPresence(
  db: Database.Database,
  userId: string,
  outletId?: string | null,
): PresentCashier | null {
  if (!userId) return null;
  const scoped = outletId !== undefined;
  const sql = `
    SELECT outlet_id, floor, user_id, user_name, checked_in_at, last_seen
      FROM cashier_presence
     WHERE user_id = ?
       AND checked_out_at = ''
       AND last_seen >= datetime('now', ?)
       ${scoped ? 'AND outlet_id = ?' : ''}
     ORDER BY last_seen DESC
     LIMIT 1
  `;
  const params: unknown[] = [userId, cutoffModifier(db)];
  if (scoped) params.push(normalizeOutlet(outletId));
  const row = db.prepare(sql).get(...(params as any[])) as any;
  return row ? toPresent(row) : null;
}

/**
 * Every floor the outlet actually has, in display order.
 *
 * Derived from restaurant_tables.zone (active tables only) — NOT from who
 * happens to be checked in — because the owner's board must show the floors
 * with nobody on them. UNIONed with the floors of live check-in rows so a floor
 * that was renamed out from under a cashier still appears and can be cleared.
 */
export function listFloors(db: Database.Database, outletId?: string | null): string[] {
  const scoped = outletId !== undefined;
  const o = normalizeOutlet(outletId);
  const zones = db.prepare(`
    SELECT DISTINCT zone FROM restaurant_tables
     WHERE is_active = 1 ${scoped ? 'AND ' + outletClause('outlet_id') : ''}
  `).all(...(scoped ? [o] : [])) as any[];
  const held = db.prepare(`
    SELECT DISTINCT floor AS zone FROM cashier_presence
     WHERE checked_out_at = '' ${scoped ? 'AND outlet_id = ?' : ''}
  `).all(...(scoped ? [o] : [])) as any[];

  const set = new Set<string>();
  for (const r of [...zones, ...held]) set.add(normalizeFloor(r.zone));
  return [...set].sort((a, b) => floorLabel(a).localeCompare(floorLabel(b), undefined, { sensitivity: 'base' }));
}

/**
 * The owner's floor board: EVERY known floor with its cashier or null.
 *
 * A floor with `cashier: null` is the "No Cashier Logged In" row the owner asked
 * for — and it is also the row that tells a manager they may settle there.
 * `expired` carries a check-in that timed out, so the board can be honest about
 * why the floor reads empty.
 *
 * `outletId` follows the same rule as cashierOnFloor: omit for every outlet,
 * pass explicitly to scope.
 */
export function listPresenceByFloor(db: Database.Database, outletId?: string | null): FloorPresence[] {
  const scoped = outletId !== undefined;
  const o = normalizeOutlet(outletId);
  const floors = listFloors(db, outletId);
  const cutoff = presenceCutoff(db);

  const counts = new Map<string, number>();
  for (const r of db.prepare(`
    SELECT zone, COUNT(*) AS n FROM restaurant_tables
     WHERE is_active = 1 ${scoped ? 'AND ' + outletClause('outlet_id') : ''}
     GROUP BY zone
  `).all(...(scoped ? [o] : [])) as any[]) {
    const f = normalizeFloor(r.zone);
    counts.set(f, (counts.get(f) || 0) + Number(r.n || 0));
  }

  // One row per floor, newest check-in wins (only reachable when unscoped on a
  // multi-outlet database, where two outlets can share a floor NAME).
  const rows = new Map<string, any>();
  for (const r of db.prepare(`
    SELECT outlet_id, floor, user_id, user_name, checked_in_at, last_seen
      FROM cashier_presence
     WHERE checked_out_at = '' ${scoped ? 'AND outlet_id = ?' : ''}
     ORDER BY last_seen ASC
  `).all(...(scoped ? [o] : [])) as any[]) {
    rows.set(normalizeFloor(r.floor), r);
  }

  return floors.map((floor) => {
    const row = rows.get(floor);
    const who = row ? toPresent(row) : null;
    const fresh = !!who && who.lastSeen >= cutoff;
    return {
      floor,
      label: floorLabel(floor),
      activeTables: counts.get(floor) || 0,
      cashier: fresh ? who : null,
      expired: who && !fresh ? who : null,
    };
  });
}

/* ─────────────────────────────────────────────────────────────────────────────
 * WRITES
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * Take a floor.
 *
 * Two invariants, both enforced here rather than left to callers:
 *
 *   ONE PERSON, ONE PLACE. Every other floor this user holds is released first.
 *   Without it a cashier who moved from Ground Floor to Rooftop would still be
 *   "present" on Ground Floor, and a manager standing there would be refused a
 *   settle by someone who is one storey up.
 *
 *   ONE FLOOR, ONE CASHIER. The upsert on (outlet_id, floor) means a handover is
 *   a single write; there is no instant where two people hold the same floor.
 *
 * Re-checking in on a floor you already hold (a page poll, a refresh) keeps your
 * original checked_in_at — same shift. Coming back after the window expired
 * starts a new one, because you were, by the app's definition, away.
 *
 * EVICTIONS ARE RECORDED HERE, IN THE SAME TRANSACTION. When the upsert
 * displaces a LIVE holder (fresh, not checked out, a different user), that is
 * an eviction, and an audit_events row ('cashier.floor_evicted') names who was
 * displaced and who did it. Recording inside checkIn — not in the route — means
 * no caller can take a floor from a live cashier silently, whichever entry
 * point they used. Whether the caller MAY evict at all is checkInGuarded()'s
 * job; this function assumes the caller was already allowed.
 */
export function checkIn(db: Database.Database, args: CheckInArgs): PresentCashier {
  const userId = String(args.userId || '').trim();
  if (!userId) throw new Error('checkIn: userId is required');
  const f = normalizeFloor(args.floor);
  const o = normalizeOutlet(args.outletId);
  const name = String(args.userName || '').trim();
  const cutoff = cutoffModifier(db);

  const run = db.transaction(() => {
    // Who holds (outlet, floor) LIVE right now — read inside the transaction so
    // the eviction record can never name someone the upsert did not displace.
    const prior = db.prepare(`
      SELECT outlet_id, floor, user_id, user_name, checked_in_at, last_seen
        FROM cashier_presence
       WHERE outlet_id = ? AND floor = ?
         AND checked_out_at = ''
         AND last_seen >= datetime('now', ?)
    `).get(o, f, cutoff) as any;

    db.prepare(`
      UPDATE cashier_presence
         SET checked_out_at = datetime('now')
       WHERE user_id = ?
         AND checked_out_at = ''
         AND NOT (outlet_id = ? AND floor = ?)
    `).run(userId, o, f);

    db.prepare(`
      INSERT INTO cashier_presence (outlet_id, floor, user_id, user_name, checked_in_at, last_seen, checked_out_at)
      VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), '')
      ON CONFLICT(outlet_id, floor) DO UPDATE SET
        user_id        = excluded.user_id,
        user_name      = excluded.user_name,
        last_seen      = excluded.last_seen,
        checked_out_at = '',
        checked_in_at  = CASE
                           WHEN cashier_presence.user_id       = excluded.user_id
                            AND cashier_presence.checked_out_at = ''
                            AND cashier_presence.last_seen     >= datetime('now', ?)
                           THEN cashier_presence.checked_in_at
                           ELSE excluded.checked_in_at
                         END
    `).run(o, f, userId, name, cutoff);

    if (prior && String(prior.user_id) !== userId) {
      const evicted = toPresent(prior);
      // logAuditEvent never throws, so this cannot fail the check-in.
      logAuditEvent(db, {
        event_type: 'cashier.floor_evicted',
        entity_type: 'cashier_floor',
        entity_id: f,
        actor_email: name || userId,
        outlet_id: o || null,
        after: {
          floor: f,
          floor_name: floorLabel(f),
          evicted_user_id: evicted.userId,
          evicted_user_name: evicted.userName,
          evicted_checked_in_at: evicted.checkedInAt,
          evicted_last_seen: evicted.lastSeen,
          by_user_id: userId,
          by_user_name: name,
        },
        note:
          (name || userId) + ' took over ' + floorLabel(f) + ' from ' +
          (evicted.userName || evicted.userId) + ', who was still checked in.',
      });
      return evicted;
    }
    return null;
  });
  run();

  const row = db.prepare(`
    SELECT outlet_id, floor, user_id, user_name, checked_in_at, last_seen
      FROM cashier_presence WHERE outlet_id = ? AND floor = ?
  `).get(o, f) as any;
  return toPresent(row);
}

/**
 * checkIn() with the eviction POLICY enforced — the owner's rule made
 * mechanical (review defect D6):
 *
 *   - a floor held by a LIVE other cashier is only taken when `mayEvict` is
 *     true. The route passes isManagementTier(me) — staff may NOT displace a
 *     live holder, whatever the UI shows; management may, and the eviction is
 *     recorded (by checkIn, in the same transaction as the takeover).
 *   - a free floor, my own floor, or an EXPIRED hold needs no privilege:
 *     expiry means "nobody is here", and taking an empty floor is the normal
 *     start of a shift.
 *
 * On refusal the caller gets the holder, so the 409 can name who to ask.
 * The holder lookup scopes to the SAME normalised outlet the check-in would
 * write, so the row tested is exactly the row the upsert would displace.
 */
export function checkInGuarded(
  db: Database.Database,
  args: CheckInArgs & { mayEvict: boolean },
): CheckInAttempt {
  const userId = String(args.userId || '').trim();
  if (!userId) throw new Error('checkInGuarded: userId is required');
  const holder = cashierOnFloor(db, args.floor, args.outletId ?? null);
  if (holder && holder.userId !== userId && !args.mayEvict) {
    return { ok: false, heldBy: holder };
  }
  const presence = checkIn(db, args);
  const evicted = holder && holder.userId !== presence.userId ? holder : null;
  return { ok: true, presence, evicted };
}

/**
 * Keep the current holding alive. This is what makes the inactivity window mean
 * "silence" rather than "shift length" — the cashier console should call it on
 * its normal poll. Bumps whichever floor the user holds; touching nothing is not
 * an error (they simply are not checked in anywhere).
 *
 * Deliberately keyed by user, NOT by floor: a touch must never be able to steal
 * a floor from the person who actually holds it. Only checkIn() changes hands.
 */
export function touchPresence(db: Database.Database, userId: string): PresentCashier | null {
  const id = String(userId || '').trim();
  if (!id) return null;
  db.prepare(`
    UPDATE cashier_presence
       SET last_seen = datetime('now')
     WHERE user_id = ?
       AND checked_out_at = ''
       AND last_seen >= datetime('now', ?)
  `).run(id, cutoffModifier(db));
  return getMyPresence(db, id);
}

/**
 * Release a floor. Returns true if something was actually released.
 *
 * With `userId` it is a self-checkout and only fires if that user holds the
 * floor. Without it, the floor is cleared whoever holds it — the escape hatch
 * for a cashier who walked off without checking out, which is the only way a
 * manager can reach a floor someone else still "holds". Who is permitted to do
 * that is the route's call, not this function's — but WHEN a force clear
 * releases somebody else's hold, it is recorded here ('cashier.floor_force_
 * cleared'), attributed to `clearedBy` when the route supplies it, in the same
 * transaction as the release. A force clear that turns out to release the
 * clearer's OWN row is a self-checkout and records nothing.
 */
export function checkOut(db: Database.Database, args: CheckOutArgs): boolean {
  const f = normalizeFloor(args.floor);
  const o = normalizeOutlet(args.outletId);
  const userId = String(args.userId || '').trim();
  const byId = String(args.clearedBy?.userId || '').trim();
  const byName = String(args.clearedBy?.userName || '').trim();
  const cutoff = cutoffModifier(db);

  const run = db.transaction((): boolean => {
    // Force path only: read what is about to be released, so the record names
    // the person it actually happened to.
    const prior = !userId
      ? (db.prepare(`
          SELECT outlet_id, floor, user_id, user_name, checked_in_at, last_seen
            FROM cashier_presence
           WHERE outlet_id = ? AND floor = ? AND checked_out_at = ''
        `).get(o, f) as any)
      : null;

    const res = db.prepare(`
      UPDATE cashier_presence
         SET checked_out_at = datetime('now')
       WHERE outlet_id = ?
         AND floor = ?
         AND checked_out_at = ''
         ${userId ? 'AND user_id = ?' : ''}
    `).run(...(userId ? [o, f, userId] : [o, f]));

    if (prior && res.changes > 0 && String(prior.user_id) !== byId) {
      const held = toPresent(prior);
      const wasLive = db.prepare("SELECT datetime('now', ?) AS c").get(cutoff) as any;
      logAuditEvent(db, {
        event_type: 'cashier.floor_force_cleared',
        entity_type: 'cashier_floor',
        entity_id: f,
        actor_email: byName || byId,
        outlet_id: o || null,
        after: {
          floor: f,
          floor_name: floorLabel(f),
          cleared_user_id: held.userId,
          cleared_user_name: held.userName,
          cleared_checked_in_at: held.checkedInAt,
          cleared_last_seen: held.lastSeen,
          // Whether the hold was still LIVE when cleared (an eviction in
          // effect) or already expired (housekeeping).
          was_live: held.lastSeen >= String(wasLive?.c || ''),
          by_user_id: byId,
          by_user_name: byName,
        },
        note:
          (byName || byId || 'Someone') + ' force-cleared ' + floorLabel(f) +
          ' — ' + (held.userName || held.userId) + ' was checked in there.',
      });
    }
    return res.changes > 0;
  });
  return run();
}

/**
 * Release every floor this user holds — end of shift, or sign-out. Returns true
 * if anything was released.
 */
export function checkOutUser(db: Database.Database, userId: string): boolean {
  const id = String(userId || '').trim();
  if (!id) return false;
  const res = db.prepare(`
    UPDATE cashier_presence
       SET checked_out_at = datetime('now')
     WHERE user_id = ? AND checked_out_at = ''
  `).run(id);
  return res.changes > 0;
}
