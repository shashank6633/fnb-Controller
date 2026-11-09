/**
 * VALET read models — one per audience, each returning ONLY what that audience
 * may see (spec §2): the head's board masks guest contact (revealContact is the
 * controlled, audited way to see it); the attendant view carries no guest
 * contact and no history; the desk lookup carries a masked plate.
 *
 * Every read first releases due scheduled requests and expires abandoned
 * guest check-ins — so the screens are correct even if the worker is not.
 */
import type { DB, Actor, OutletValet, SessionRow, PickupRow } from './core';
import { laneFor, BOARD_LANES } from './states';
import { nowIso, addMinutes, minutesBetween, businessDate, maskMobile, maskPlate } from './config';
import { promoteDue, eligibleQueue, etaFor, capacityOf, availableAttendants, durationStats, type Eta } from './queue';
import { expirePending, keyDesc } from './ops-arrival';

export interface Card {
  id: string; version: number; state: string; lane: string;
  tag_code: string; ticket_no: string; plate: string; make: string; model: string; colour: string;
  zone_id: string | null; zone_name: string; spot: string; key_location: string; key_desc: string; key_custodian_id: string | null;
  checked_in_at: string; checked_in_by_name: string; parked_at: string | null; parked_by_name: string;
  fetched_by_name: string; ready_at: string | null; dwell_deadline_at: string | null; holding_at: string | null;
  guest_inside_at: string | null; handed_over_at: string | null; handed_over_by_name: string;
  parking_by: string | null; parking_by_name: string; relocating_by: string | null;
  has_guest_name: boolean; guest_name?: string; mobile_masked?: string;
  has_photo_exception: boolean; duplicate_plate_note: string; checkin_source: string; is_test: boolean;
  pickup: null | {
    id: string; version: number; state: string; source: string; requested_at: string; target_at: string;
    queued_at: string | null; priority: number; priority_reason: string; assigned_user_id: string | null; assigned_name: string;
    handoff_open: boolean; handoff_from_name: string; guest_outside_at: string | null; change_request: string; change_open: boolean;
    started_at: string | null; eta: Eta; scheduled: boolean;
  };
  flags: string[];
}

function zoneNames(db: DB, outletId: string): Map<string, { name: string; kind: string }> {
  const rows = db.prepare('SELECT id, name, kind FROM valet_zones WHERE outlet_id = ?').all(outletId) as { id: string; name: string; kind: string }[];
  return new Map(rows.map(r => [r.id, { name: r.name, kind: r.kind }]));
}

function toCard(
  db: DB, ov: OutletValet, s: SessionRow, p: PickupRow | null, zones: Map<string, { name: string; kind: string }>,
  now: Date, ctx: { queue: PickupRow[]; attendants: number; staleUsers: Set<string> }, audience: 'head' | 'attendant' | 'desk',
): Card {
  const at = nowIso(now);
  const cfg = ov.cfg;
  const flags: string[] = [];
  const eta = p ? etaFor(db, p, s.zone_id, s.state, cfg, now, { queue: ctx.queue, attendants: ctx.attendants }) : null;
  if (p) {
    if (p.state === 'QUEUED' && p.queued_at && (minutesBetween(p.queued_at, at) ?? 0) >= cfg.escalation.unclaimed_min) flags.push('unclaimed_overdue');
    if (p.state !== 'READY' && p.target_at < at && (minutesBetween(p.target_at, at) ?? 0) >= cfg.escalation.unclaimed_min && p.release_at < p.target_at) flags.push('scheduled_late');
    if (p.state === 'IN_PROGRESS' && p.started_at && (minutesBetween(p.started_at, at) ?? 0) >= cfg.escalation.fetching_min) flags.push('long_fetch');
    if (p.guest_outside_at && p.state !== 'READY' && (minutesBetween(p.guest_outside_at, at) ?? 0) >= cfg.escalation.outside_wait_min) flags.push('outside_waiting');
    if (p.change_request && !p.change_ack_at) flags.push('change_request');
    if (p.handoff_from_id && !p.handoff_ack_at) flags.push('handoff_open');
    if ((p.state === 'ASSIGNED' || p.state === 'IN_PROGRESS') && p.assigned_user_id && ctx.staleUsers.has(p.assigned_user_id)) flags.push('uncertain');
  }
  if (s.state === 'READY_AT_GATE' && s.dwell_deadline_at && s.dwell_deadline_at <= at) flags.push('dwell_expired');
  if (s.state === 'READY_AT_GATE' && s.dwell_deadline_at && (minutesBetween(s.dwell_deadline_at, at) ?? 0) >= cfg.escalation.dwell_overrun_min) flags.push('dwell_overrun');
  if ((s.state === 'CHECKED_IN' || s.state === 'PARKING') && (minutesBetween(s.checked_in_at, at) ?? 0) >= 15) flags.push('unparked_long');
  if ((s.state === 'PARKED' || s.state === 'HOLDING_NEAR_GATE') && !s.zone_id) flags.push('missing_location');
  if (['PARKED', 'HOLDING_NEAR_GATE'].includes(s.state) && s.key_location === 'rack' && !s.key_rack && !s.key_hook) flags.push('missing_key');
  if (s.key_location === 'attendant' && s.key_custodian_id && ctx.staleUsers.has(s.key_custodian_id) && !['HANDED_OVER', 'VOIDED'].includes(s.state)) flags.push('keys_with_absent');

  const card: Card = {
    id: s.id, version: s.version, state: s.state, lane: laneFor(s.state, p?.state ?? null),
    tag_code: s.tag_code, ticket_no: s.ticket_no,
    plate: audience === 'desk' ? maskPlate(s.plate) : s.plate,
    make: s.make, model: s.model, colour: s.colour,
    zone_id: s.zone_id, zone_name: s.zone_id ? (zones.get(s.zone_id)?.name ?? '') : '', spot: s.spot,
    key_location: s.key_location, key_desc: keyDesc(s.key_location, s.key_custodian_name, s.key_rack, s.key_hook), key_custodian_id: s.key_custodian_id,
    checked_in_at: s.checked_in_at, checked_in_by_name: s.checked_in_by_name, parked_at: s.parked_at, parked_by_name: s.parked_by_name,
    fetched_by_name: s.fetched_by_name, ready_at: s.ready_at, dwell_deadline_at: s.dwell_deadline_at, holding_at: s.holding_at,
    guest_inside_at: s.guest_inside_at, handed_over_at: s.handed_over_at, handed_over_by_name: s.handed_over_by_name,
    parking_by: s.parking_by, parking_by_name: s.parking_by_name, relocating_by: s.relocating_by,
    has_guest_name: !!s.guest_name,
    has_photo_exception: !!s.photo_exception, duplicate_plate_note: audience === 'desk' ? '' : s.duplicate_plate_note,
    checkin_source: s.checkin_source, is_test: s.is_test === 1,
    pickup: p ? {
      id: p.id, version: p.version, state: p.state, source: p.source, requested_at: p.requested_at, target_at: p.target_at,
      queued_at: p.queued_at, priority: p.priority, priority_reason: audience === 'head' ? p.priority_reason : '',
      assigned_user_id: p.assigned_user_id, assigned_name: p.assigned_name,
      handoff_open: !!p.handoff_from_id && !p.handoff_ack_at, handoff_from_name: p.handoff_from_name,
      guest_outside_at: p.guest_outside_at, change_request: p.change_request, change_open: !!p.change_request && !p.change_ack_at,
      started_at: p.started_at, eta: eta!, scheduled: p.release_at > p.requested_at,
    } : null,
    flags,
  };
  // Contact is the head's only, and masked; the full number needs revealContact.
  if (audience === 'head') {
    card.guest_name = s.guest_name;
    card.mobile_masked = maskMobile(s.guest_mobile);
  }
  return card;
}

/** Users whose valet device has gone quiet (or who are not on shift at all). */
function staleUserSet(db: DB, ov: OutletValet, now: Date): Set<string> {
  const cutoff = addMinutes(now, -ov.cfg.stale_device_minutes);
  const open = db.prepare(`SELECT user_id, last_seen_at FROM valet_shifts WHERE outlet_id = ? AND ended_at IS NULL`).all(ov.outlet_id) as
    { user_id: string; last_seen_at: string | null }[];
  const onShift = new Map(open.map(r => [r.user_id, r.last_seen_at]));
  const holders = db.prepare(`SELECT DISTINCT assigned_user_id AS u FROM valet_pickups WHERE outlet_id = ? AND state IN ('ASSIGNED','IN_PROGRESS') AND assigned_user_id IS NOT NULL
                              UNION SELECT DISTINCT key_custodian_id FROM valet_vehicle_sessions WHERE outlet_id = ? AND key_location = 'attendant'
                              AND key_custodian_id IS NOT NULL AND state NOT IN ('HANDED_OVER','VOIDED')`).all(ov.outlet_id, ov.outlet_id) as { u: string }[];
  const stale = new Set<string>();
  for (const { u } of holders) {
    if (!onShift.has(u)) { stale.add(u); continue; }
    const seen = onShift.get(u);
    if (!seen || seen < cutoff) stale.add(u);
  }
  return stale;
}

function loadCards(db: DB, ov: OutletValet, now: Date, audience: 'head' | 'attendant' | 'desk', where: string, params: unknown[]): Card[] {
  const zones = zoneNames(db, ov.outlet_id);
  const queue = eligibleQueue(db, ov.outlet_id);
  const attendants = availableAttendants(db, ov.outlet_id);
  const staleUsers = staleUserSet(db, ov, now);
  const sessions = db.prepare(`SELECT * FROM valet_vehicle_sessions WHERE outlet_id = ? AND ${where}`).all(ov.outlet_id, ...params) as SessionRow[];
  if (!sessions.length) return [];
  const pickups = db.prepare(`SELECT * FROM valet_pickups WHERE outlet_id = ? AND state IN ('SCHEDULED','QUEUED','ASSIGNED','IN_PROGRESS','READY')`).all(ov.outlet_id) as PickupRow[];
  const bySession = new Map(pickups.map(p => [p.session_id, p]));
  return sessions.map(s => toCard(db, ov, s, bySession.get(s.id) ?? null, zones, now, { queue, attendants, staleUsers }, audience));
}

function pct(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] * 10) / 10;
}
function summary(values: number[]) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  return {
    n: v.length,
    avg: v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null,
    p90: pct(v, 0.9),
    max: v.length ? Math.round(v[v.length - 1] * 10) / 10 : null,
  };
}

/**
 * Request-to-ready for the business date. DEFINITIONS (shown on the board):
 *   immediate wait  = ready_at − requested_at, for requests that were due when
 *                     made (Request now / In 5 / In 10 when the lead time covers it);
 *   scheduled late  = ready_at − target_at, for requests booked for a later time
 *                     (negative = early). Intentional scheduled delay is never
 *                     counted as waiting.
 * Denominator: pickups that reached READY this business date; void/test cars
 * excluded.
 */
export function requestToReady(db: DB, ov: OutletValet, date: string) {
  const rows = db.prepare(`
    SELECT p.requested_at, p.release_at, p.target_at, p.ready_at
    FROM valet_pickups p JOIN valet_vehicle_sessions s ON s.id = p.session_id
    WHERE p.outlet_id = ? AND p.ready_at IS NOT NULL AND s.business_date = ? AND s.is_test = 0 AND s.state <> 'VOIDED'`).all(ov.outlet_id, date) as
    { requested_at: string; release_at: string; target_at: string; ready_at: string }[];
  const immediate: number[] = [], late: number[] = [];
  for (const r of rows) {
    if (r.release_at <= r.requested_at) immediate.push(minutesBetween(r.requested_at, r.ready_at) ?? NaN);
    else late.push(minutesBetween(r.target_at, r.ready_at) ?? NaN);
  }
  return { immediate_wait: summary(immediate), scheduled_lateness: summary(late) };
}

export function teamPanel(db: DB, ov: OutletValet, now: Date) {
  const date = businessDate(now, ov.cfg);
  const assigned = db.prepare(`SELECT u.id, u.name FROM valet_staff_outlets s JOIN users u ON u.id = s.user_id AND u.is_active = 1 WHERE s.outlet_id = ?`).all(ov.outlet_id) as
    { id: string; name: string }[];
  const shifts = db.prepare(`SELECT * FROM valet_shifts WHERE outlet_id = ? AND (ended_at IS NULL OR started_at >= ?) ORDER BY started_at DESC`)
    .all(ov.outlet_id, addMinutes(now, -24 * 60)) as { id: string; user_id: string; user_name: string; status: string; started_at: string; break_started_at: string | null; break_seconds: number; last_seen_at: string | null; ended_at: string | null }[];
  const people = new Map<string, { id: string; name: string }>();
  for (const a of assigned) people.set(a.id, a);
  for (const sh of shifts) if (!people.has(sh.user_id)) people.set(sh.user_id, { id: sh.user_id, name: sh.user_name });
  const staleCut = addMinutes(now, -ov.cfg.stale_device_minutes);
  return [...people.values()].map(p => {
    const open = shifts.find(s => s.user_id === p.id && !s.ended_at) || null;
    const tasks = db.prepare(`SELECT p.id, s.tag_code, p.state FROM valet_pickups p JOIN valet_vehicle_sessions s ON s.id = p.session_id
                              WHERE p.assigned_user_id = ? AND p.state IN ('ASSIGNED','IN_PROGRESS')`).all(p.id) as { id: string; tag_code: string; state: string }[];
    const moving = db.prepare(`SELECT COUNT(*) AS n FROM valet_vehicle_sessions WHERE (state = 'PARKING' AND parking_by = ?) OR (state = 'RELOCATING' AND relocating_by = ?)`).get(p.id, p.id) as { n: number };
    const parks = (db.prepare(`SELECT COUNT(*) AS n FROM valet_vehicle_sessions WHERE outlet_id = ? AND parked_by = ? AND business_date = ? AND state <> 'VOIDED'`).get(ov.outlet_id, p.id, date) as { n: number }).n;
    const fetches = (db.prepare(`SELECT COUNT(*) AS n FROM valet_pickups p JOIN valet_vehicle_sessions s ON s.id = p.session_id
                                 WHERE p.outlet_id = ? AND p.assigned_user_id = ? AND p.ready_at IS NOT NULL AND s.business_date = ? AND s.state <> 'VOIDED'`).get(ov.outlet_id, p.id, date) as { n: number }).n;
    const keys = (db.prepare(`SELECT COUNT(*) AS n FROM valet_vehicle_sessions WHERE key_location = 'attendant' AND key_custodian_id = ? AND state NOT IN ('HANDED_OVER','VOIDED')`).get(p.id) as { n: number }).n;
    const breakNow = open?.status === 'break' && open.break_started_at ? (now.getTime() - Date.parse(open.break_started_at)) / 1000 : 0;
    const hours = open ? Math.max(0, ((now.getTime() - Date.parse(open.started_at)) / 1000 - open.break_seconds - breakNow) / 3600) : 0;
    const busy = tasks.length + moving.n > 0;
    const status = !open ? 'off' : open.status === 'break' ? 'break' : busy ? 'busy' : 'available';
    return {
      user_id: p.id, name: p.name, status, shift_id: open?.id ?? null, started_at: open?.started_at ?? null,
      hours: Math.round(hours * 10) / 10, active_tasks: tasks, moving: moving.n, keys_held: keys,
      parks_today: parks, fetches_today: fetches,
      device_quiet: !!open && (!open.last_seen_at || open.last_seen_at < staleCut) && (busy || keys > 0),
      last_seen_at: open?.last_seen_at ?? null,
    };
  }).sort((a, b) => ['available', 'busy', 'break', 'off'].indexOf(a.status) - ['available', 'busy', 'break', 'off'].indexOf(b.status) || a.name.localeCompare(b.name));
}

/** The Valet Head Dashboard payload. */
export function headBoard(db: DB, ov: OutletValet, now: Date = new Date()) {
  const at = nowIso(now);
  promoteDue(db, ov.outlet_id, now);
  expirePending(db, now);
  const date = businessDate(now, ov.cfg);
  const active = loadCards(db, ov, now, 'head', `state NOT IN ('HANDED_OVER','VOIDED')`, []);
  const completed = loadCards(db, ov, now, 'head', `state = 'HANDED_OVER' AND business_date = ? ORDER BY handed_over_at DESC LIMIT 60`, [date]);
  const pending = (db.prepare(`SELECT id, pairing_code, plate, make, model, colour, source, created_at, expires_at, guest_name
                               FROM valet_checkin_requests WHERE outlet_id = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at`).all(ov.outlet_id, at) as Record<string, string>[])
    .map(r => ({ ...r, guest_name: r.guest_name ? r.guest_name.slice(0, 1) + '…' : '' }));
  const team = teamPanel(db, ov, now);
  const gate = capacityOf(db, ov.outlet_id, 'gate'), holding = capacityOf(db, ov.outlet_id, 'holding'), parking = capacityOf(db, ov.outlet_id, 'parking');
  const all = [...active, ...completed];
  const count = (lane: string) => all.filter(c => c.lane === lane).length;
  const arrivals = (db.prepare(`SELECT COUNT(*) AS n FROM valet_vehicle_sessions WHERE outlet_id = ? AND business_date = ? AND state <> 'VOIDED' AND is_test = 0`).get(ov.outlet_id, date) as { n: number }).n;
  const availableStaff = team.filter(t => t.status === 'available').length;
  const queuedCount = active.filter(c => c.pickup?.state === 'QUEUED').length;

  const alerts = db.prepare(`SELECT id, session_id, pickup_id, kind, message, created_at, acknowledged_at FROM valet_alerts
                             WHERE outlet_id = ? AND resolved_at IS NULL ORDER BY created_at`).all(ov.outlet_id) as Record<string, unknown>[];
  const incidents = db.prepare(`SELECT i.id, i.session_id, i.kind, i.description, i.reported_by_name, i.created_at, s.tag_code
                                FROM valet_incidents i LEFT JOIN valet_vehicle_sessions s ON s.id = i.session_id
                                WHERE i.outlet_id = ? AND i.status = 'open' ORDER BY i.created_at`).all(ov.outlet_id) as Record<string, unknown>[];
  const FLAG_WORDS: Record<string, string> = {
    unclaimed_overdue: 'Request waiting with nobody on it', scheduled_late: 'Booked pickup is running late',
    long_fetch: 'Fetch taking too long', outside_waiting: 'Guest outside and waiting', change_request: 'Guest asked to change a claimed pickup',
    handoff_open: 'Reassigned car not yet confirmed', uncertain: 'Attendant holding a car has gone quiet (no handoff)',
    dwell_overrun: 'Car waiting at the gate past its time', dwell_expired: 'Gate time is up — move to holding?',
    unparked_long: 'Arrival not parked after 15 min', missing_location: 'Parked car with no zone',
    missing_key: 'Keys on rack with no rack/hook', keys_with_absent: 'Keys with someone who is off shift or quiet',
  };
  const exceptions: { kind: string; message: string; session_id?: string; pickup_id?: string | null; tag_code?: string; since?: string | null }[] = [];
  for (const c of active) for (const f of c.flags) {
    if (f === 'dwell_expired' && c.flags.includes('dwell_overrun')) continue;
    exceptions.push({ kind: f, message: FLAG_WORDS[f] || f, session_id: c.id, pickup_id: c.pickup?.id ?? null, tag_code: c.tag_code,
      since: f === 'unclaimed_overdue' ? c.pickup?.queued_at : f.startsWith('dwell') ? c.dwell_deadline_at : c.checked_in_at });
  }
  if (queuedCount > 0 && availableStaff === 0 && team.filter(t => t.status !== 'off').length === 0 && ov.cfg.escalation.no_staff) {
    exceptions.unshift({ kind: 'no_staff', message: `${queuedCount} request(s) waiting and nobody is on shift` });
  }
  if (gate.capacity !== null && gate.occupied >= gate.capacity) exceptions.push({ kind: 'gate_full', message: `Gate is full (${gate.occupied}/${gate.capacity}) — readiness estimates are slower` });
  if (holding.capacity !== null && holding.occupied >= holding.capacity) exceptions.push({ kind: 'holding_full', message: `Holding is full (${holding.occupied}/${holding.capacity}) — park extra cars back in the lot` });
  for (const t of team) if (t.status === 'off' && t.keys_held > 0) exceptions.push({ kind: 'staff_unavailable', message: `${t.name} is off shift but still holds keys for ${t.keys_held} car(s)` });

  const durations = durationStats(db, ov.outlet_id, null, ov.cfg, now);
  return {
    outlet: { id: ov.outlet_id, name: ov.outlet_name, venue_name: ov.cfg.venue_name || ov.outlet_name, enabled: ov.enabled },
    business_date: date, server_time: at,
    counts: {
      arrivals, pending_checkin: pending.length, parking: count('parking'), parked: active.filter(c => c.state === 'PARKED').length,
      scheduled: count('scheduled'), unclaimed: queuedCount, retrievals: count('fetching'), at_gate: count('ready'), holding: count('holding'),
      overdue: exceptions.filter(e => ['unclaimed_overdue', 'scheduled_late', 'long_fetch', 'outside_waiting', 'dwell_overrun'].includes(e.kind)).length,
      available_staff: availableStaff, completed_today: completed.length,
    },
    occupancy: { parking, gate, holding },
    metrics: { ...requestToReady(db, ov, date), retrieval_estimate: durations },
    lanes: BOARD_LANES,
    pending, cards: active, completed, exceptions, alerts, incidents, team,
    zones: db.prepare('SELECT id, name, kind, capacity, retrieval_minutes, sort_order, is_active FROM valet_zones WHERE outlet_id = ? ORDER BY kind, sort_order, name').all(ov.outlet_id),
    handover_note: db.prepare(`SELECT id, from_name, note, snapshot_json, created_at, acknowledged_name, acknowledged_at FROM valet_handover_notes
                               WHERE outlet_id = ? ORDER BY created_at DESC LIMIT 1`).get(ov.outlet_id) ?? null,
    config: { dwell_minutes: ov.cfg.dwell_minutes, escalation: ov.cfg.escalation, pickup_gate_label: ov.cfg.pickup_gate_label, stale_device_minutes: ov.cfg.stale_device_minutes },
  };
}

/** The attendant's screen: their shift, their work, what is waiting, the gate.
 *  No guest contact, no history, no other outlet. */
export function attendantView(db: DB, ov: OutletValet, actor: Actor, now: Date = new Date()) {
  const at = nowIso(now);
  promoteDue(db, ov.outlet_id, now);
  expirePending(db, now);
  const shift = db.prepare(`SELECT id, outlet_id, status, started_at, break_started_at FROM valet_shifts WHERE user_id = ? AND ended_at IS NULL`).get(actor.id) ?? null;
  const cards = loadCards(db, ov, now, 'attendant', `state NOT IN ('HANDED_OVER','VOIDED')`, []);
  const mine = cards.filter(c => c.pickup?.assigned_user_id === actor.id && ['ASSIGNED', 'IN_PROGRESS'].includes(c.pickup.state)
    || (c.state === 'PARKING' && c.parking_by === actor.id)
    || (c.state === 'RELOCATING' && c.relocating_by === actor.id));
  const keysWithMe = cards.filter(c => c.key_location === 'attendant' && c.key_custodian_id === actor.id).map(c => ({ id: c.id, tag_code: c.tag_code, state: c.state }));
  return {
    outlet: { id: ov.outlet_id, name: ov.outlet_name, enabled: ov.enabled },
    server_time: at, shift,
    my_tasks: mine,
    unparked: cards.filter(c => c.state === 'CHECKED_IN' || (c.state === 'PARKING' && !mine.includes(c))),
    at_gate: cards.filter(c => c.state === 'READY_AT_GATE' || c.state === 'RELOCATING'),
    holding: cards.filter(c => c.state === 'HOLDING_NEAR_GATE'),
    // For tag lookup (scan a tag → its car). Car details only — no guest contact.
    parked: cards.filter(c => c.state === 'PARKED'),
    queue: { waiting: cards.filter(c => c.pickup?.state === 'QUEUED').length, scheduled: cards.filter(c => c.pickup?.state === 'SCHEDULED').length },
    keys_with_me: keysWithMe,
    zones: db.prepare(`SELECT id, name, kind, capacity FROM valet_zones WHERE outlet_id = ? AND is_active = 1 ORDER BY kind, sort_order, name`).all(ov.outlet_id),
    config: { dwell_minutes: ov.cfg.dwell_minutes, max_tasks: ov.cfg.max_tasks_per_attendant, photos_min: ov.cfg.photos.min,
      photo_exception: ov.cfg.photos.allow_exception, required: ov.cfg.required, gate_label: ov.cfg.pickup_gate_label },
    capacity: { gate: capacityOf(db, ov.outlet_id, 'gate'), holding: capacityOf(db, ov.outlet_id, 'holding') },
  };
}

/** Desk lookup by tag, ticket or plate tail — minimal, masked, rate-limited by
 *  the caller. Never lists cars without a query (no enumeration). */
export function deskLookup(db: DB, ov: OutletValet, q: string, now: Date = new Date()) {
  promoteDue(db, ov.outlet_id, now);
  const t = String(q || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (t.length < 2) return [];
  return loadCards(db, ov, now, 'desk',
    `state NOT IN ('HANDED_OVER','VOIDED') AND (upper(replace(replace(tag_code,'-',''),' ','')) = ? OR upper(ticket_no) = ? OR (length(?) >= 4 AND plate_norm LIKE '%' || ?)) LIMIT 10`,
    [t, t, t, t]);
}

/** One car in full for staff: card + timeline + custody trail. */
export function sessionDetail(db: DB, ov: OutletValet, sessionId: string, audience: 'head' | 'attendant', now: Date = new Date()) {
  const cards = loadCards(db, ov, now, audience, 'id = ?', [sessionId]);
  if (!cards.length) return null;
  const events = db.prepare(`SELECT event_type, from_state, to_state, actor_type, actor_name, reason, created_at FROM valet_events
                             WHERE session_id = ? AND outlet_id = ? ORDER BY created_at, rowid`).all(sessionId, ov.outlet_id);
  const custody = db.prepare(`SELECT kind, from_desc, to_desc, actor_name, note, created_at FROM valet_custody
                              WHERE session_id = ? AND outlet_id = ? ORDER BY created_at, rowid`).all(sessionId, ov.outlet_id);
  const pickups = db.prepare(`SELECT id, state, source, requested_at, target_at, assigned_name, started_at, ready_at, completed_at, cancelled_at, cancel_reason, no_show_at
                              FROM valet_pickups WHERE session_id = ? AND outlet_id = ? ORDER BY seq`).all(sessionId, ov.outlet_id);
  const incidents = db.prepare(`SELECT id, kind, description, status, created_at, resolution FROM valet_incidents WHERE session_id = ? AND outlet_id = ?`).all(sessionId, ov.outlet_id);
  return { card: cards[0], events, custody, pickups, incidents };
}
