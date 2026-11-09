/**
 * VALET core — the pieces every command shares: the error type, who is acting,
 * the transaction helper, the append-only logs, outlet config and outlet scope.
 *
 * THE OUTLET RULE (spec §11 "every record and query must respect outlet
 * scope"): no command trusts an id on its own. Every load below takes the
 * outlet the caller was AUTHORISED for and filters on it, so an id from another
 * outlet reads as "not found", never as someone else's car.
 */
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { SessionUser } from '@/lib/auth';
import { hasValetCap, type ValetNeed } from './caps';
import { parseConfig, nowIso, type ValetConfig } from './config';
import { emitValet } from './bus';

export type DB = Database.Database;

export class ValetError extends Error {
  constructor(public status: number, public code: string, message: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}
/** A function DECLARATION on purpose: TypeScript's control-flow analysis only
 *  treats a `never` call as ending a path when the callee is declared like this. */
export function fail(status: number, code: string, message: string, extra?: Record<string, unknown>): never {
  throw new ValetError(status, code, message, extra);
}

export interface Actor {
  kind: 'staff' | 'guest' | 'system';
  id: string;
  name: string;
  isAdmin: boolean;
  head: boolean;
  attendant: boolean;
  host: boolean;
}

export function staffActor(u: SessionUser): Actor {
  return {
    kind: 'staff', id: u.id, name: u.name || u.email, isAdmin: u.role === 'admin',
    head: hasValetCap(u, 'head'), attendant: hasValetCap(u, 'attendant'), host: hasValetCap(u, 'host'),
  };
}
export function guestActor(deviceId: string): Actor {
  return { kind: 'guest', id: deviceId, name: 'Guest', isAdmin: false, head: false, attendant: false, host: false };
}
export const SYSTEM: Actor = { kind: 'system', id: 'system', name: 'System', isAdmin: false, head: false, attendant: false, host: false };

export const newId = () => randomUUID();

/** Run `fn` in a BEGIN IMMEDIATE transaction: the write lock is taken at the
 *  start, so two workers racing for the same car serialise instead of both
 *  reading "free" and both writing. busy_timeout (db.ts) makes the loser wait. */
export function withTx<T>(db: DB, fn: () => T): T {
  return db.transaction(fn).immediate();
}

export interface EventInput {
  outlet_id: string;
  session_id?: string | null;
  pickup_id?: string | null;
  event_type: string;
  from_state?: string;
  to_state?: string;
  actor: Actor;
  reason?: string;
  data?: Record<string, unknown>;
  at: string;
}
/** Append one timeline row. Never updated, never deleted. Holds no contact data. */
export function logEvent(db: DB, e: EventInput): void {
  db.prepare(`INSERT INTO valet_events (id, outlet_id, session_id, pickup_id, event_type, from_state, to_state,
                actor_type, actor_id, actor_name, reason, data_json, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    newId(), e.outlet_id, e.session_id ?? null, e.pickup_id ?? null, e.event_type,
    e.from_state || '', e.to_state || '', e.actor.kind, e.actor.id, e.actor.name,
    (e.reason || '').slice(0, 500), JSON.stringify(e.data || {}), e.at,
  );
}

export interface CustodyInput {
  outlet_id: string;
  session_id: string;
  kind: 'key' | 'vehicle';
  from_desc?: string;
  to_desc?: string;
  from_user_id?: string | null;
  to_user_id?: string | null;
  zone_id?: string | null;
  spot?: string;
  key_rack?: string;
  key_hook?: string;
  actor: Actor;
  note?: string;
  at: string;
}
/** Append one custody/movement row: every key handoff, every physical move. */
export function logCustody(db: DB, c: CustodyInput): void {
  db.prepare(`INSERT INTO valet_custody (id, outlet_id, session_id, kind, from_desc, to_desc, from_user_id, to_user_id,
                zone_id, spot, key_rack, key_hook, actor_id, actor_name, note, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    newId(), c.outlet_id, c.session_id, c.kind, c.from_desc || '', c.to_desc || '',
    c.from_user_id ?? null, c.to_user_id ?? null, c.zone_id ?? null, c.spot || '',
    c.key_rack || '', c.key_hook || '', c.actor.id, c.actor.name, (c.note || '').slice(0, 300), c.at,
  );
}

/** Tell live screens something changed (ids only). Call AFTER the commit. */
export function notify(outlet_id: string, kind: string, ids: { session_id?: string | null; pickup_id?: string | null } = {}): void {
  emitValet({ outlet_id, kind, session_id: ids.session_id ?? null, pickup_id: ids.pickup_id ?? null, at: nowIso() });
}

// ── Outlets and configuration ────────────────────────────────────────────────

export interface OutletValet {
  outlet_id: string;
  outlet_name: string;
  enabled: boolean;
  cfg: ValetConfig;
  entry_token: string;
}

export function loadOutletValet(db: DB, outletId: string): OutletValet | null {
  const o = db.prepare('SELECT id, name, is_active FROM outlets WHERE id = ?').get(outletId) as
    { id: string; name: string; is_active: number } | undefined;
  if (!o || !o.is_active) return null;
  const c = db.prepare('SELECT enabled, config_json, entry_token FROM valet_outlet_config WHERE outlet_id = ?').get(outletId) as
    { enabled: number; config_json: string; entry_token: string } | undefined;
  return {
    outlet_id: o.id, outlet_name: o.name, enabled: c?.enabled === 1,
    cfg: parseConfig(c?.config_json ?? '{}'), entry_token: c?.entry_token || '',
  };
}

/** Outlets this user may operate for valet: all active outlets for an admin,
 *  otherwise exactly their valet_staff_outlets rows. Never "all" by default. */
export function outletsForUser(db: DB, user: SessionUser): { id: string; name: string; enabled: boolean }[] {
  const rows = (user.role === 'admin'
    ? db.prepare(`SELECT o.id, o.name, COALESCE(c.enabled, 0) AS enabled FROM outlets o
                  LEFT JOIN valet_outlet_config c ON c.outlet_id = o.id
                  WHERE o.is_active = 1 ORDER BY o.is_default DESC, o.name`).all()
    : db.prepare(`SELECT o.id, o.name, COALESCE(c.enabled, 0) AS enabled FROM valet_staff_outlets s
                  JOIN outlets o ON o.id = s.outlet_id AND o.is_active = 1
                  LEFT JOIN valet_outlet_config c ON c.outlet_id = o.id
                  WHERE s.user_id = ? ORDER BY o.is_default DESC, o.name`).all(user.id)) as
    { id: string; name: string; enabled: number }[];
  return rows.map(r => ({ id: r.id, name: r.name, enabled: r.enabled === 1 }));
}

const NEED_WORDS: Record<ValetNeed, string> = {
  head: 'Valet Head', attendant: 'Valet Attendant', host: 'Valet Desk',
};

/**
 * THE staff gate for every valet API: capability, outlet assignment, outlet
 * switched on. Returns the actor and the outlet's config. Hiding a button is not
 * an access control — this is.
 */
export function requireStaff(
  db: DB, user: SessionUser | null, outletId: string, need: ValetNeed | 'admin',
  opts: { allowDisabled?: boolean } = {},
): { actor: Actor; ov: OutletValet } {
  if (!user) fail(401, 'sign_in', 'Please sign in again.');
  const u = user as SessionUser;
  if (need === 'admin') {
    if (u.role !== 'admin') fail(403, 'admin_only', 'Only the owner/admin can change this valet setting.');
  } else if (!hasValetCap(u, need)) {
    fail(403, 'no_capability', `Your role does not include ${NEED_WORDS[need]}. Ask the owner to tick it in Settings → Roles.`);
  }
  if (!outletId) fail(400, 'outlet_required', 'Choose an outlet first.');
  const ov = loadOutletValet(db, outletId);
  if (!ov) fail(404, 'outlet_not_found', 'That outlet does not exist or is closed.');
  if (u.role !== 'admin') {
    const assigned = db.prepare('SELECT 1 FROM valet_staff_outlets WHERE user_id = ? AND outlet_id = ?').get(u.id, outletId);
    if (!assigned) fail(403, 'not_assigned', `You are not assigned to ${ov!.outlet_name} for valet. Ask the owner (Valet Settings → Staff).`);
  }
  if (!ov!.enabled && !opts.allowDisabled) fail(409, 'valet_off', `Valet is switched off for ${ov!.outlet_name}.`);
  return { actor: staffActor(u), ov: ov! };
}

// ── Loads with outlet scope and version checks ───────────────────────────────

export interface SessionRow {
  id: string; outlet_id: string; business_date: string; state: string; version: number;
  checkin_source: string; tag_id: string | null; tag_code: string; ticket_no: string;
  plate: string; plate_norm: string; make: string; model: string; colour: string;
  guest_name: string; guest_mobile: string; notes: string; duplicate_plate_note: string;
  checked_in_at: string; checked_in_by: string; checked_in_by_name: string;
  parking_started_at: string | null; parking_by: string | null; parking_by_name: string;
  parked_at: string | null; parked_by: string; parked_by_name: string;
  zone_id: string | null; spot: string;
  key_location: string; key_rack: string; key_hook: string; key_custodian_id: string | null; key_custodian_name: string;
  photo_exception: string; photo_exception_by: string;
  retrieving_started_at: string | null; fetched_by: string; fetched_by_name: string;
  ready_at: string | null; gate_zone_id: string | null; dwell_deadline_at: string | null;
  guest_inside_at: string | null; relocating_at: string | null; relocating_by: string | null; holding_at: string | null;
  handed_over_at: string | null; handed_over_by: string; handed_over_by_name: string;
  handover_method: string; handover_note: string; verify_failures: number;
  voided_at: string | null; voided_by: string; void_reason: string; is_test: number;
  order_id: string | null; table_id: string | null; booking_id: string | null; customer_key: string;
  redacted_at: string | null; updated_at: string;
}

export interface PickupRow {
  id: string; session_id: string; outlet_id: string; state: string; version: number; seq: number;
  source: string; requested_by: string; requested_by_name: string; requested_at: string;
  target_at: string; release_at: string; queued_at: string | null; lead_minutes: number;
  priority: number; priority_reason: string;
  eta_override_low: string | null; eta_override_high: string | null; eta_override_reason: string;
  assigned_user_id: string | null; assigned_name: string; assigned_at: string | null; assigned_how: string;
  handoff_from_id: string | null; handoff_from_name: string; handoff_ack_at: string | null;
  started_at: string | null; ready_at: string | null; completed_at: string | null;
  cancelled_at: string | null; cancel_reason: string; no_show_at: string | null; outcome_note: string;
  guest_outside_at: string | null; change_request: string; change_request_at: string | null;
  change_ack_at: string | null; change_ack_by: string; idempotency_key: string;
  created_at: string; updated_at: string;
}

export function getSession(db: DB, id: unknown, outletId: string): SessionRow {
  const row = db.prepare('SELECT * FROM valet_vehicle_sessions WHERE id = ? AND outlet_id = ?')
    .get(String(id || ''), outletId) as SessionRow | undefined;
  if (!row) fail(404, 'not_found', 'That car was not found at this outlet.');
  return row!;
}
export function getPickup(db: DB, id: unknown, outletId: string): PickupRow {
  const row = db.prepare('SELECT * FROM valet_pickups WHERE id = ? AND outlet_id = ?')
    .get(String(id || ''), outletId) as PickupRow | undefined;
  if (!row) fail(404, 'not_found', 'That pickup request was not found at this outlet.');
  return row!;
}
export function activePickup(db: DB, sessionId: string): PickupRow | null {
  return (db.prepare(`SELECT * FROM valet_pickups WHERE session_id = ?
                      AND state IN ('SCHEDULED','QUEUED','ASSIGNED','IN_PROGRESS','READY')`).get(sessionId) as PickupRow) || null;
}

/** Optimistic concurrency: when the client says which version it saw, a newer
 *  write by someone else is a 409 with the current state — never a silent
 *  overwrite. Omitting `version` is allowed for idempotent commands only. */
export function expectVersion(row: { version: number; state: string }, version: unknown, what = 'car'): void {
  if (version === undefined || version === null || version === '') return;
  if (Number(version) !== row.version) {
    fail(409, 'stale', `Someone else just updated this ${what}. Refresh to see the latest.`, { current_state: row.state, current_version: row.version });
  }
}

/** Write columns on a session row, bumping version under a compare-and-swap. */
export function writeSession(db: DB, row: SessionRow, sets: Record<string, unknown>, at: string): void {
  const keys = Object.keys(sets);
  const sql = `UPDATE valet_vehicle_sessions SET ${keys.map(k => `${k} = ?`).join(', ')}${keys.length ? ', ' : ''}
               version = version + 1, updated_at = ? WHERE id = ? AND version = ?`;
  const r = db.prepare(sql).run(...keys.map(k => sets[k] as never), at, row.id, row.version);
  if (r.changes !== 1) fail(409, 'stale', 'Someone else just updated this car. Refresh to see the latest.');
}
export function writePickup(db: DB, row: PickupRow, sets: Record<string, unknown>, at: string): void {
  const keys = Object.keys(sets);
  const sql = `UPDATE valet_pickups SET ${keys.map(k => `${k} = ?`).join(', ')}${keys.length ? ', ' : ''}
               version = version + 1, updated_at = ? WHERE id = ? AND version = ?`;
  const r = db.prepare(sql).run(...keys.map(k => sets[k] as never), at, row.id, row.version);
  if (r.changes !== 1) fail(409, 'stale', 'Someone else just updated this pickup. Refresh to see the latest.');
}

// ── Shifts and workload ──────────────────────────────────────────────────────

export interface ShiftRow {
  id: string; outlet_id: string; user_id: string; user_name: string; status: string;
  started_at: string; break_started_at: string | null; break_seconds: number;
  last_seen_at: string | null; ended_at: string | null;
}
export function openShift(db: DB, userId: string): ShiftRow | null {
  return (db.prepare('SELECT * FROM valet_shifts WHERE user_id = ? AND ended_at IS NULL').get(userId) as ShiftRow) || null;
}

/** Physical work an attendant is holding right now: claimed pickups that are not
 *  yet at the gate, plus cars they are parking or relocating. */
export function activeTaskCount(db: DB, userId: string): number {
  const p = db.prepare(`SELECT COUNT(*) AS n FROM valet_pickups WHERE assigned_user_id = ? AND state IN ('ASSIGNED','IN_PROGRESS')`).get(userId) as { n: number };
  const s = db.prepare(`SELECT COUNT(*) AS n FROM valet_vehicle_sessions
                        WHERE (state = 'PARKING' AND parking_by = ?) OR (state = 'RELOCATING' AND relocating_by = ?)`).get(userId, userId) as { n: number };
  return p.n + s.n;
}

/** An attendant may take physical work only while on shift (not on break) at
 *  THIS outlet and under the outlet's task limit. */
export function assertCanTakeWork(db: DB, userId: string, userName: string, outletId: string, max: number): ShiftRow {
  const sh = openShift(db, userId);
  if (!sh || sh.outlet_id !== outletId) fail(409, 'not_on_shift', `${userName} is not on shift at this outlet. Start the shift first.`);
  if (sh!.status === 'break') fail(409, 'on_break', `${userName} is on a break. End the break first.`);
  const n = activeTaskCount(db, userId);
  if (n >= max) fail(409, 'busy', `${userName} already has ${n} car${n === 1 ? '' : 's'} in hand. Finish it first (limit ${max}).`);
  return sh!;
}

export function isoNow(now?: Date): string { return nowIso(now); }
