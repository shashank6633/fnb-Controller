/**
 * VALET pickup, dispatch and gate operations. docs/valet/DESIGN.md §3–§5.
 *
 * Three promises this file keeps, each enforced in the SAME transaction as the
 * write it guards:
 *   1. One active pickup per car, and a retry returns it (partial unique index
 *      uq_valet_active_pickup + the lookup in requestPickup).
 *   2. A car is claimed by exactly one attendant (compare-and-swap on
 *      state = 'QUEUED' inside BEGIN IMMEDIATE).
 *   3. Physical work is never cancelled silently: once claimed, a guest's
 *      cancel/reschedule becomes a change request a person must acknowledge.
 */
import type { DB, Actor, OutletValet, PickupRow, SessionRow } from './core';
import {
  fail, newId, logEvent, logCustody, getSession, getPickup, activePickup, expectVersion,
  writeSession, writePickup, withTx, assertCanTakeWork, openShift, activeTaskCount,
} from './core';
import { canPickup, canVehicle, isHeld, RECOVERY_METHODS } from './states';
import { nowIso, addMinutes, withinServiceHours, nextClose, normTagCode, cleanText } from './config';
import { leadMinutes, promoteDue, eligibleQueue, capacityOf } from './queue';
import { sha256, digits, normCode, sameHash } from './credentials';
import { keyDesc, label } from './ops-arrival';

export type When = 'now' | 'in5' | 'in10' | 'at';

/** Resolve a pickup choice to a target instant, enforcing the outlet's options,
 *  service hours and the later-time window. The target is a TARGET, never a
 *  promise — the guest pass says so. */
export function resolveTarget(ov: OutletValet, when: unknown, atIso: unknown, now: Date): Date {
  const p = ov.cfg.pickup;
  const w = String(when || 'now') as When;
  if (w === 'now') { if (!p.now) fail(400, 'option_off', 'Request-now is switched off here.'); return now; }
  if (w === 'in5') { if (!p.in5) fail(400, 'option_off', 'That option is switched off here.'); return new Date(now.getTime() + 5 * 60_000); }
  if (w === 'in10') { if (!p.in10) fail(400, 'option_off', 'That option is switched off here.'); return new Date(now.getTime() + 10 * 60_000); }
  if (w !== 'at') fail(400, 'bad_option', 'Choose when you would like your car.');
  if (!p.later) fail(400, 'option_off', 'Booking a later time is switched off here.');
  const t = new Date(String(atIso || ''));
  if (!Number.isFinite(t.getTime())) fail(400, 'bad_time', 'Choose a valid time.');
  const mins = (t.getTime() - now.getTime()) / 60_000;
  if (mins < 10) fail(400, 'too_soon', 'For anything sooner than 10 minutes, use Request now or In 5/10 minutes.');
  if (mins > p.later_max_minutes) fail(400, 'too_late', `You can book up to ${Math.round(p.later_max_minutes / 60 * 10) / 10} hours ahead.`);
  if (!withinServiceHours(t, ov.cfg) || t.getTime() > nextClose(now, ov.cfg).getTime()) {
    fail(400, 'outside_hours', `That time is outside valet service hours (${ov.cfg.hours.open}–${ov.cfg.hours.close}).`);
  }
  return t;
}

export interface RequestInput { session_id: string; when?: string; at?: string; idempotency_key?: string; note?: string }

/**
 * Create (or return) the car's active pickup. Idempotent twice over: the same
 * idempotency key returns the same row, and any second request while one is
 * active returns that one — "repeated taps and retries must return the same
 * active request". Never touches the vehicle state.
 */
export function requestPickup(
  db: DB, ov: OutletValet, actor: Actor, input: RequestInput, source: 'guest' | 'staff' | 'host', now: Date = new Date(),
) {
  const at = nowIso(now);
  return withTx(db, () => {
    const s = getSession(db, input.session_id, ov.outlet_id);
    const idem = cleanText(input.idempotency_key, 80);
    if (idem) {
      const same = db.prepare('SELECT * FROM valet_pickups WHERE session_id = ? AND idempotency_key = ?').get(s.id, idem) as PickupRow | undefined;
      if (same) return { pickup: same, existing: true };
    }
    const active = activePickup(db, s.id);
    if (active) return { pickup: active, existing: true };
    if (!isHeld(s.state)) fail(409, 'not_held', 'This car has already been handed over.');
    if (s.state === 'READY_AT_GATE' || s.state === 'RETRIEVING') fail(409, 'already_coming', 'This car is already at or on its way to the gate.');
    const target = resolveTarget(ov, input.when, input.at, now);
    const lead = leadMinutes(db, ov.outlet_id, s.zone_id, ov.cfg, now);
    const release = new Date(target.getTime() - lead * 60_000);
    const dueNow = release.getTime() <= now.getTime();
    const state = dueNow ? 'QUEUED' : 'SCHEDULED';
    const seq = (db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM valet_pickups WHERE outlet_id = ?').get(ov.outlet_id) as { n: number }).n;
    const id = newId();
    db.prepare(`INSERT INTO valet_pickups (id, session_id, outlet_id, state, seq, source, requested_by, requested_by_name,
                  requested_at, target_at, release_at, queued_at, lead_minutes, idempotency_key, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, s.id, ov.outlet_id, state, seq, source, actor.id, actor.name,
      at, nowIso(target), nowIso(release), dueNow ? at : null, lead, idem, at, at);
    logEvent(db, { outlet_id: ov.outlet_id, session_id: s.id, pickup_id: id, event_type: 'pickup.requested', to_state: state, actor, at,
      reason: cleanText(input.note, 200), data: { source, when: String(input.when || 'now'), target_at: nowIso(target), lead_minutes: lead } });
    const pickup = db.prepare('SELECT * FROM valet_pickups WHERE id = ?').get(id) as PickupRow;
    return { pickup, existing: false };
  });
}

/** Cancel: immediate before the work is claimed; afterwards a change request
 *  for staff to acknowledge (the guest is told it is waiting on the team). */
export function cancelPickup(db: DB, ov: OutletValet, actor: Actor, pickupId: string, reason: string, now: Date = new Date()) {
  const at = nowIso(now);
  return withTx(db, () => {
    const p = getPickup(db, pickupId, ov.outlet_id);
    if (p.state === 'SCHEDULED' || p.state === 'QUEUED') {
      writePickup(db, p, { state: 'CANCELLED', cancelled_at: at, cancel_reason: cleanText(reason, 200) || 'cancelled' }, at);
      logEvent(db, { outlet_id: ov.outlet_id, session_id: p.session_id, pickup_id: p.id, event_type: 'pickup.cancelled',
        from_state: p.state, to_state: 'CANCELLED', actor, reason, at });
      return { state: 'CANCELLED' as const, pending_ack: false };
    }
    if (['ASSIGNED', 'IN_PROGRESS', 'READY'].includes(p.state)) {
      if (p.change_request !== 'cancel' || p.change_ack_at) {
        writePickup(db, p, { change_request: 'cancel', change_request_at: at, change_ack_at: null, change_ack_by: '' }, at);
        raiseAlert(db, ov.outlet_id, p.session_id, p.id, 'change_request', 'Guest asked to cancel — work already claimed', `change:${p.id}`, at);
        logEvent(db, { outlet_id: ov.outlet_id, session_id: p.session_id, pickup_id: p.id, event_type: 'pickup.change_requested',
          actor, reason: 'cancel', at });
      }
      return { state: p.state, pending_ack: true };
    }
    fail(409, 'closed', 'This pickup is already closed.');
  }) as { state: string; pending_ack: boolean };
}

/** Reschedule before claim; afterwards a change request, like cancel. */
export function reschedulePickup(db: DB, ov: OutletValet, actor: Actor, pickupId: string, when: unknown, atIso: unknown, now: Date = new Date()) {
  const at = nowIso(now);
  return withTx(db, () => {
    const p = getPickup(db, pickupId, ov.outlet_id);
    const s = getSession(db, p.session_id, ov.outlet_id);
    const target = resolveTarget(ov, when, atIso, now);
    if (p.state === 'SCHEDULED' || p.state === 'QUEUED') {
      const lead = leadMinutes(db, ov.outlet_id, s.zone_id, ov.cfg, now);
      const release = new Date(target.getTime() - lead * 60_000);
      const dueNow = release.getTime() <= now.getTime();
      writePickup(db, p, {
        state: dueNow ? 'QUEUED' : 'SCHEDULED', target_at: nowIso(target), release_at: nowIso(release),
        // A request moved LATER loses its old place; one moved earlier keeps a fair
        // place from now. Either way its turn starts when it is due.
        queued_at: dueNow ? at : null, lead_minutes: lead,
      }, at);
      logEvent(db, { outlet_id: ov.outlet_id, session_id: p.session_id, pickup_id: p.id, event_type: 'pickup.rescheduled',
        from_state: p.state, to_state: dueNow ? 'QUEUED' : 'SCHEDULED', actor, at, data: { target_at: nowIso(target) } });
      return { pending_ack: false };
    }
    if (['ASSIGNED', 'IN_PROGRESS', 'READY'].includes(p.state)) {
      writePickup(db, p, { change_request: `reschedule:${nowIso(target)}`, change_request_at: at, change_ack_at: null, change_ack_by: '' }, at);
      raiseAlert(db, ov.outlet_id, p.session_id, p.id, 'change_request', 'Guest asked to change the pickup time — work already claimed', `change:${p.id}`, at);
      logEvent(db, { outlet_id: ov.outlet_id, session_id: p.session_id, pickup_id: p.id, event_type: 'pickup.change_requested',
        actor, reason: 'reschedule', at, data: { target_at: nowIso(target) } });
      return { pending_ack: true };
    }
    fail(409, 'closed', 'This pickup is already closed.');
  }) as { pending_ack: boolean };
}

/**
 * Staff acknowledge a guest's change request on claimed work. Accepting a
 * cancel NEVER closes the vehicle session: a car on its way goes back to
 * PARKING (re-park and record the spot), a car at the gate is re-parked or
 * moved to holding. A reschedule cancels this attempt and books a new one.
 */
export function ackChange(
  db: DB, ov: OutletValet, actor: Actor, pickupId: string, version: unknown,
  input: { accept?: boolean; return_to?: string; note?: string }, now: Date = new Date(),
) {
  const at = nowIso(now);
  return withTx(db, () => {
    const p = getPickup(db, pickupId, ov.outlet_id);
    expectVersion(p, version, 'pickup');
    if (!p.change_request || p.change_ack_at) fail(409, 'no_request', 'There is no open change request on this pickup.');
    const s = getSession(db, p.session_id, ov.outlet_id);
    const note = cleanText(input.note, 200);
    resolveAlert(db, `change:${p.id}`, actor, at);
    if (!input.accept) {
      writePickup(db, p, { change_ack_at: at, change_ack_by: actor.id, outcome_note: `change declined${note ? ': ' + note : ''}` }, at);
      logEvent(db, { outlet_id: ov.outlet_id, session_id: p.session_id, pickup_id: p.id, event_type: 'pickup.change_declined', actor, reason: note, at });
      return { accepted: false };
    }
    writePickup(db, p, { state: 'CANCELLED', cancelled_at: at, cancel_reason: p.change_request.startsWith('reschedule') ? 'rescheduled by guest' : 'cancelled by guest',
      change_ack_at: at, change_ack_by: actor.id }, at);
    logEvent(db, { outlet_id: ov.outlet_id, session_id: p.session_id, pickup_id: p.id, event_type: 'pickup.change_accepted',
      from_state: p.state, to_state: 'CANCELLED', actor, reason: note || p.change_request, at });
    // Put the CAR somewhere safe — a cancellation never ends the session.
    if (s.state === 'RETRIEVING' || s.state === 'READY_AT_GATE') {
      const toHold = s.state === 'READY_AT_GATE' && input.return_to === 'hold';
      const next = toHold ? 'RELOCATING' : 'PARKING';
      const who = p.assigned_user_id || actor.id;
      const whoName = p.assigned_name || actor.name;
      writeSession(db, s, toHold
        ? { state: 'RELOCATING', relocating_at: at, relocating_by: who }
        : { state: 'PARKING', parking_started_at: at, parking_by: who, parking_by_name: whoName, gate_zone_id: null, dwell_deadline_at: null }, at);
      logEvent(db, { outlet_id: ov.outlet_id, session_id: s.id, event_type: 'vehicle.returning', from_state: s.state, to_state: next, actor, at,
        reason: 'guest change accepted — record where the car ends up' });
    }
    let newPickupId: string | null = null;
    if (p.change_request.startsWith('reschedule:')) {
      const target = new Date(p.change_request.slice('reschedule:'.length));
      const lead = leadMinutes(db, ov.outlet_id, s.zone_id, ov.cfg, now);
      const release = new Date(target.getTime() - lead * 60_000);
      const dueNow = release.getTime() <= now.getTime();
      const seq = (db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM valet_pickups WHERE outlet_id = ?').get(ov.outlet_id) as { n: number }).n;
      newPickupId = newId();
      db.prepare(`INSERT INTO valet_pickups (id, session_id, outlet_id, state, seq, source, requested_by, requested_by_name,
                    requested_at, target_at, release_at, queued_at, lead_minutes, created_at, updated_at)
                  VALUES (?,?,?,?,?, 'guest', ?, 'Guest (rescheduled)', ?,?,?,?,?,?,?)`).run(
        newPickupId, s.id, ov.outlet_id, dueNow ? 'QUEUED' : 'SCHEDULED', seq, p.requested_by,
        at, nowIso(target), nowIso(release), dueNow ? at : null, lead, at, at);
      logEvent(db, { outlet_id: ov.outlet_id, session_id: s.id, pickup_id: newPickupId, event_type: 'pickup.requested',
        to_state: dueNow ? 'QUEUED' : 'SCHEDULED', actor, at, data: { source: 'reschedule', replaces: p.id } });
    }
    return { accepted: true, new_pickup_id: newPickupId };
  });
}

// ── Dispatch ────────────────────────────────────────────────────────────────

const CLAIMABLE_VEHICLE = ['PARKED', 'HOLDING_NEAR_GATE'];

/**
 * TAKE NEXT CAR. Atomic: inside BEGIN IMMEDIATE we release due requests, check
 * the attendant may take work, pick the first eligible request whose car is
 * parked, and claim it with a compare-and-swap on state = 'QUEUED'. Two
 * attendants tapping at the same instant serialise on the write lock; the
 * second sees the row already ASSIGNED and moves to the next car.
 */
export function takeNext(db: DB, ov: OutletValet, actor: Actor, now: Date = new Date()) {
  const at = nowIso(now);
  return withTx(db, () => {
    promoteDue(db, ov.outlet_id, now);
    assertCanTakeWork(db, actor.id, actor.name, ov.outlet_id, ov.cfg.max_tasks_per_attendant);
    for (const p of eligibleQueue(db, ov.outlet_id)) {
      const s = db.prepare('SELECT state FROM valet_vehicle_sessions WHERE id = ?').get(p.session_id) as { state: string } | undefined;
      if (!s || !CLAIMABLE_VEHICLE.includes(s.state)) continue;
      const r = db.prepare(`UPDATE valet_pickups SET state = 'ASSIGNED', assigned_user_id = ?, assigned_name = ?, assigned_at = ?,
                              assigned_how = 'take_next', handoff_from_id = NULL, handoff_from_name = '', handoff_ack_at = NULL,
                              version = version + 1, updated_at = ?
                            WHERE id = ? AND state = 'QUEUED'`).run(actor.id, actor.name, at, at, p.id);
      if (r.changes !== 1) continue;
      logEvent(db, { outlet_id: ov.outlet_id, session_id: p.session_id, pickup_id: p.id, event_type: 'pickup.claimed',
        from_state: 'QUEUED', to_state: 'ASSIGNED', actor, at, data: { how: 'take_next' } });
      return { pickup_id: p.id, session_id: p.session_id };
    }
    return { pickup_id: null, session_id: null };
  });
}

/**
 * Head assigns a QUEUED request, or REASSIGNS claimed work, to an attendant —
 * with the same safeguards as Take next car (on shift, under the limit, CAS).
 * Reassignment preserves custody: the keys stay with the old attendant until
 * the new one acknowledges the handoff (ackHandoff).
 */
export function assignPickup(
  db: DB, ov: OutletValet, actor: Actor, pickupId: string, version: unknown, toUserId: string, reason: string, now: Date = new Date(),
) {
  const at = nowIso(now);
  return withTx(db, () => {
    promoteDue(db, ov.outlet_id, now);
    const p = getPickup(db, pickupId, ov.outlet_id);
    expectVersion(p, version, 'pickup');
    const sh = db.prepare('SELECT user_id, user_name FROM valet_shifts WHERE user_id = ? AND outlet_id = ? AND ended_at IS NULL').get(String(toUserId || ''), ov.outlet_id) as
      { user_id: string; user_name: string } | undefined;
    if (!sh) fail(409, 'not_on_shift', 'Pick someone who is on shift at this outlet.');
    if (p.assigned_user_id === sh!.user_id && p.state !== 'QUEUED') fail(409, 'same_person', `${sh!.user_name} already has this car.`);
    assertCanTakeWork(db, sh!.user_id, sh!.user_name, ov.outlet_id, ov.cfg.max_tasks_per_attendant);
    const why = cleanText(reason, 200);
    if (p.state === 'QUEUED') {
      const s = db.prepare('SELECT state FROM valet_vehicle_sessions WHERE id = ?').get(p.session_id) as { state: string };
      if (!CLAIMABLE_VEHICLE.includes(s.state)) fail(409, 'not_parked', 'This car is not parked yet — finish parking first.');
      const r = db.prepare(`UPDATE valet_pickups SET state = 'ASSIGNED', assigned_user_id = ?, assigned_name = ?, assigned_at = ?,
                              assigned_how = 'head_assign', version = version + 1, updated_at = ? WHERE id = ? AND state = 'QUEUED'`)
        .run(sh!.user_id, sh!.user_name, at, at, p.id);
      if (r.changes !== 1) fail(409, 'stale', 'Someone just claimed this car.');
      logEvent(db, { outlet_id: ov.outlet_id, session_id: p.session_id, pickup_id: p.id, event_type: 'pickup.assigned',
        from_state: 'QUEUED', to_state: 'ASSIGNED', actor, reason: why, at, data: { to: sh!.user_name } });
      return { reassigned: false };
    }
    if (p.state !== 'ASSIGNED' && p.state !== 'IN_PROGRESS') fail(409, 'bad_state', `This pickup is ${label(p.state)}; it cannot be reassigned.`);
    if (why.length < 5) fail(400, 'reason_required', 'Say why the car is being reassigned.');
    writePickup(db, p, {
      assigned_user_id: sh!.user_id, assigned_name: sh!.user_name, assigned_at: at, assigned_how: 'head_reassign',
      handoff_from_id: p.assigned_user_id, handoff_from_name: p.assigned_name, handoff_ack_at: null,
    }, at);
    logEvent(db, { outlet_id: ov.outlet_id, session_id: p.session_id, pickup_id: p.id, event_type: 'pickup.reassigned',
      from_state: p.state, to_state: p.state, actor, reason: why, at, data: { from: p.assigned_name, to: sh!.user_name } });
    raiseAlert(db, ov.outlet_id, p.session_id, p.id, 'handoff', `Handoff: ${p.assigned_name} → ${sh!.user_name} must confirm`, `handoff:${p.id}`, at);
    return { reassigned: true };
  });
}

/** The new attendant confirms they have taken over (and, once the car is
 *  moving, the keys). Until then the board shows the handoff as open. */
export function ackHandoff(db: DB, ov: OutletValet, actor: Actor, pickupId: string, now: Date = new Date()) {
  const at = nowIso(now);
  return withTx(db, () => {
    const p = getPickup(db, pickupId, ov.outlet_id);
    if (p.assigned_user_id !== actor.id) fail(403, 'not_yours', 'Only the attendant this car was handed to can confirm the handoff.');
    if (!p.handoff_from_id || p.handoff_ack_at) return { acknowledged: true };
    writePickup(db, p, { handoff_ack_at: at }, at);
    const s = getSession(db, p.session_id, ov.outlet_id);
    if (s.key_location === 'attendant' && s.key_custodian_id && s.key_custodian_id !== actor.id) {
      writeSession(db, s, { key_custodian_id: actor.id, key_custodian_name: actor.name }, at);
      logCustody(db, { outlet_id: ov.outlet_id, session_id: s.id, kind: 'key', from_desc: `attendant ${s.key_custodian_name}`,
        to_desc: `attendant ${actor.name}`, from_user_id: s.key_custodian_id, to_user_id: actor.id, actor, note: 'handoff acknowledged', at });
    }
    resolveAlert(db, `handoff:${p.id}`, actor, at);
    logEvent(db, { outlet_id: ov.outlet_id, session_id: p.session_id, pickup_id: p.id, event_type: 'pickup.handoff_ack', actor, at,
      data: { from: p.handoff_from_name } });
    return { acknowledged: true };
  });
}

/** Put a claimed-but-not-started request back in the queue, keeping its FIFO
 *  place (queued_at is unchanged). The attendant may release their own; the
 *  head may release anyone's with a reason. Never once the car is moving. */
export function unassignPickup(db: DB, ov: OutletValet, actor: Actor, pickupId: string, version: unknown, reason: string, now: Date = new Date()) {
  const at = nowIso(now);
  return withTx(db, () => {
    const p = getPickup(db, pickupId, ov.outlet_id);
    expectVersion(p, version, 'pickup');
    if (p.state !== 'ASSIGNED') fail(409, 'bad_state', p.state === 'IN_PROGRESS'
      ? 'This car is already moving. Reassign it to someone, or ask the attendant to finish.' : `This pickup is ${label(p.state)}.`);
    const own = p.assigned_user_id === actor.id;
    if (!own && !actor.head) fail(403, 'not_yours', 'Only the Valet Head can take a car off another attendant.');
    const why = cleanText(reason, 200);
    if (!own && why.length < 5) fail(400, 'reason_required', 'Say why the car is going back to the queue.');
    writePickup(db, p, { state: 'QUEUED', assigned_user_id: null, assigned_name: '', assigned_at: null, assigned_how: '',
      handoff_from_id: null, handoff_from_name: '', handoff_ack_at: null }, at);
    resolveAlert(db, `handoff:${p.id}`, actor, at);
    logEvent(db, { outlet_id: ov.outlet_id, session_id: p.session_id, pickup_id: p.id, event_type: 'pickup.released_to_queue',
      from_state: 'ASSIGNED', to_state: 'QUEUED', actor, reason: why, at, data: { from: p.assigned_name } });
    return { state: 'QUEUED' };
  });
}

/** The assigned attendant starts moving the car: pickup IN_PROGRESS, vehicle
 *  RETRIEVING, keys into their custody. Refused while a handoff is unconfirmed. */
export function startFetch(db: DB, ov: OutletValet, actor: Actor, pickupId: string, version: unknown, now: Date = new Date()) {
  const at = nowIso(now);
  return withTx(db, () => {
    const p = getPickup(db, pickupId, ov.outlet_id);
    expectVersion(p, version, 'pickup');
    if (p.state !== 'ASSIGNED') fail(409, 'bad_state', `This pickup is ${label(p.state)}.`);
    if (p.assigned_user_id !== actor.id) fail(403, 'not_yours', `This car is assigned to ${p.assigned_name}.`);
    if (p.handoff_from_id && !p.handoff_ack_at) fail(409, 'handoff_open', 'Confirm the handoff first.');
    const s = getSession(db, p.session_id, ov.outlet_id);
    if (!canVehicle(s.state, 'RETRIEVING')) fail(409, 'bad_state', `The car is ${label(s.state)}; it cannot be fetched yet.`);
    writePickup(db, p, { state: 'IN_PROGRESS', started_at: at }, at);
    const keyMoves = !(s.key_location === 'attendant' && s.key_custodian_id === actor.id);
    writeSession(db, s, { state: 'RETRIEVING', retrieving_started_at: at, fetched_by: actor.id, fetched_by_name: actor.name,
      key_location: 'attendant', key_custodian_id: actor.id, key_custodian_name: actor.name, key_rack: '', key_hook: '' }, at);
    if (keyMoves) {
      logCustody(db, { outlet_id: ov.outlet_id, session_id: s.id, kind: 'key', from_desc: keyDesc(s.key_location, s.key_custodian_name, s.key_rack, s.key_hook),
        to_desc: `attendant ${actor.name}`, from_user_id: s.key_custodian_id, to_user_id: actor.id, actor, note: 'collected to fetch the car', at });
    }
    logEvent(db, { outlet_id: ov.outlet_id, session_id: s.id, pickup_id: p.id, event_type: 'fetch.start',
      from_state: s.state, to_state: 'RETRIEVING', actor, at });
    return { pickup_id: p.id };
  });
}

/** The car is at the gate: pickup READY, vehicle READY_AT_GATE, dwell timer
 *  starts. A full gate is refused unless staff record why (a safe exception,
 *  never a silently blocked queue). */
export function markReady(
  db: DB, ov: OutletValet, actor: Actor, pickupId: string, version: unknown,
  input: { gate_zone_id?: string; override_reason?: string }, now: Date = new Date(),
) {
  const at = nowIso(now);
  return withTx(db, () => {
    const p = getPickup(db, pickupId, ov.outlet_id);
    expectVersion(p, version, 'pickup');
    if (p.state !== 'IN_PROGRESS') fail(409, 'bad_state', p.state === 'ASSIGNED' ? 'Tap "Start fetching" first.' : `This pickup is ${label(p.state)}.`);
    if (p.assigned_user_id !== actor.id && !actor.head) fail(403, 'not_yours', `This car is assigned to ${p.assigned_name}.`);
    const s = getSession(db, p.session_id, ov.outlet_id);
    if (s.state !== 'RETRIEVING') fail(409, 'bad_state', `The car is ${label(s.state)}.`);
    const gates = db.prepare(`SELECT id, name FROM valet_zones WHERE outlet_id = ? AND kind = 'gate' AND is_active = 1`).all(ov.outlet_id) as { id: string; name: string }[];
    let gateId: string | null = null;
    if (gates.length) {
      gateId = String(input.gate_zone_id || (gates.length === 1 ? gates[0].id : ''));
      if (!gates.some(g => g.id === gateId)) fail(400, 'gate_required', 'Pick the gate the car is at.');
    }
    const cap = capacityOf(db, ov.outlet_id, 'gate');
    const override = cleanText(input.override_reason, 200);
    if (cap.capacity !== null && cap.occupied >= cap.capacity && override.length < 5) {
      fail(409, 'gate_full', `The gate is full (${cap.occupied}/${cap.capacity}). Move a waiting car to holding first, or record why this car must wait at the gate.`, { capacity: cap });
    }
    writePickup(db, p, { state: 'READY', ready_at: at }, at);
    writeSession(db, s, { state: 'READY_AT_GATE', ready_at: at, gate_zone_id: gateId, dwell_deadline_at: addMinutes(now, ov.cfg.dwell_minutes), guest_inside_at: null }, at);
    logCustody(db, { outlet_id: ov.outlet_id, session_id: s.id, kind: 'vehicle', from_desc: 'parking', to_desc: gateId ? gates.find(g => g.id === gateId)!.name : ov.cfg.pickup_gate_label,
      zone_id: gateId, actor, at, note: override ? `gate over capacity: ${override}` : '' });
    logEvent(db, { outlet_id: ov.outlet_id, session_id: s.id, pickup_id: p.id, event_type: 'vehicle.ready', from_state: 'RETRIEVING', to_state: 'READY_AT_GATE',
      actor, at, reason: override, data: { dwell_minutes: ov.cfg.dwell_minutes, gate_over_capacity: !!override } });
    return { dwell_deadline_at: addMinutes(now, ov.cfg.dwell_minutes) };
  });
}

/** Staff: the guest came out, saw the car was not there yet, and went back in
 *  (or was told the car was ready and has not appeared). Recorded, not moved. */
export function guestWentInside(db: DB, ov: OutletValet, actor: Actor, sessionId: string, now: Date = new Date()) {
  const at = nowIso(now);
  return withTx(db, () => {
    const s = getSession(db, sessionId, ov.outlet_id);
    if (s.state !== 'READY_AT_GATE') fail(409, 'bad_state', 'Only a car waiting at the gate can be marked this way.');
    writeSession(db, s, { guest_inside_at: at }, at);
    const p = activePickup(db, s.id);
    if (p?.guest_outside_at) writePickup(db, p, { guest_outside_at: null }, at);
    logEvent(db, { outlet_id: ov.outlet_id, session_id: s.id, pickup_id: p?.id, event_type: 'guest.went_inside', actor, at });
    return { ok: true };
  });
}

/** Start moving a waiting car off the gate (no-show, guest back inside, gate
 *  full). The move is complete only when staff confirm the new location. */
export function relocateStart(db: DB, ov: OutletValet, actor: Actor, sessionId: string, version: unknown, reason: string, now: Date = new Date()) {
  const at = nowIso(now);
  return withTx(db, () => {
    const s = getSession(db, sessionId, ov.outlet_id);
    expectVersion(s, version);
    if (s.state !== 'READY_AT_GATE') fail(409, 'bad_state', 'Only a car waiting at the gate can be moved to holding.');
    const why = ['dwell_expired', 'guest_inside', 'gate_full', 'other'].includes(reason) ? reason : 'other';
    assertCanTakeWork(db, actor.id, actor.name, ov.outlet_id, ov.cfg.max_tasks_per_attendant);
    writeSession(db, s, { state: 'RELOCATING', relocating_at: at, relocating_by: actor.id }, at);
    logEvent(db, { outlet_id: ov.outlet_id, session_id: s.id, event_type: 'vehicle.relocate_start', from_state: 'READY_AT_GATE',
      to_state: 'RELOCATING', actor, reason: why, at });
    return { ok: true };
  });
}

/** Confirm the car is in the near-gate holding area. The open pickup closes as
 *  a NO_SHOW (history kept); the guest's next request is a new attempt. */
export function holdConfirm(
  db: DB, ov: OutletValet, actor: Actor, sessionId: string, version: unknown,
  input: { zone_id?: string; spot?: string; key_location?: string; key_rack?: string; key_hook?: string; override_reason?: string }, now: Date = new Date(),
) {
  const at = nowIso(now);
  return withTx(db, () => {
    const s = getSession(db, sessionId, ov.outlet_id);
    expectVersion(s, version);
    if (s.state !== 'RELOCATING') fail(409, 'bad_state', 'Tap "Move to holding" first.');
    const zone = db.prepare(`SELECT id, name, kind FROM valet_zones WHERE id = ? AND outlet_id = ? AND is_active = 1`).get(String(input.zone_id || ''), ov.outlet_id) as
      { id: string; name: string; kind: string } | undefined;
    if (!zone || zone.kind !== 'holding') fail(400, 'zone_required', 'Pick the holding area near the gate.');
    const cap = capacityOf(db, ov.outlet_id, 'holding');
    const override = cleanText(input.override_reason, 200);
    if (cap.capacity !== null && cap.occupied >= cap.capacity && override.length < 5) {
      fail(409, 'holding_full', `Holding is full (${cap.occupied}/${cap.capacity}). Park the car back in the main lot instead, or record why it must stay near the gate.`, { capacity: cap });
    }
    const keyLoc = ['rack', 'attendant', 'desk'].includes(String(input.key_location)) ? String(input.key_location) : 'attendant';
    const rack = cleanText(input.key_rack, 20), hook = cleanText(input.key_hook, 20);
    const custodian = keyLoc === 'attendant' ? { id: actor.id, name: actor.name } : { id: null as string | null, name: '' };
    writeSession(db, s, { state: 'HOLDING_NEAR_GATE', holding_at: at, zone_id: zone!.id, spot: cleanText(input.spot, 40),
      gate_zone_id: null, dwell_deadline_at: null, relocating_by: null,
      key_location: keyLoc, key_rack: keyLoc === 'rack' ? rack : '', key_hook: keyLoc === 'rack' ? hook : '',
      key_custodian_id: custodian.id, key_custodian_name: custodian.name }, at);
    logCustody(db, { outlet_id: ov.outlet_id, session_id: s.id, kind: 'vehicle', from_desc: 'gate', to_desc: `${zone!.name}${input.spot ? ' · ' + cleanText(input.spot, 40) : ''}`,
      zone_id: zone!.id, spot: cleanText(input.spot, 40), actor, at, note: override ? `holding over capacity: ${override}` : '' });
    if (keyLoc !== s.key_location || custodian.id !== s.key_custodian_id) {
      logCustody(db, { outlet_id: ov.outlet_id, session_id: s.id, kind: 'key', from_desc: keyDesc(s.key_location, s.key_custodian_name, s.key_rack, s.key_hook),
        to_desc: keyDesc(keyLoc, custodian.name, rack, hook), from_user_id: s.key_custodian_id, to_user_id: custodian.id, key_rack: rack, key_hook: hook, actor, at });
    }
    const p = activePickup(db, s.id);
    if (p && p.state === 'READY') {
      writePickup(db, p, { state: 'NO_SHOW', no_show_at: at, outcome_note: 'moved to holding' }, at);
      logEvent(db, { outlet_id: ov.outlet_id, session_id: s.id, pickup_id: p.id, event_type: 'pickup.no_show', from_state: 'READY', to_state: 'NO_SHOW', actor, at });
    }
    logEvent(db, { outlet_id: ov.outlet_id, session_id: s.id, event_type: 'vehicle.held', from_state: 'RELOCATING', to_state: 'HOLDING_NEAR_GATE', actor, at, reason: override });
    return { ok: true };
  });
}

/** Staff: the guest is back for a car in holding — a NEW pickup attempt that
 *  joins the queue fairly (the head may raise its priority, with a reason). */
export function guestReturned(db: DB, ov: OutletValet, actor: Actor, sessionId: string, now: Date = new Date()) {
  const s = getSession(db, sessionId, ov.outlet_id);
  if (s.state !== 'HOLDING_NEAR_GATE' && s.state !== 'RELOCATING') fail(409, 'bad_state', 'This car is not in holding.');
  const r = requestPickup(db, ov, actor, { session_id: s.id, when: 'now', note: 'guest returned' }, 'staff', now);
  withTx(db, () => logEvent(db, { outlet_id: ov.outlet_id, session_id: s.id, pickup_id: r.pickup.id, event_type: 'guest.returned', actor, at: nowIso(now) }));
  return r;
}

/** The guest says they are outside. Shown on the board; escalated if they wait. */
export function guestOutside(db: DB, ov: OutletValet, actor: Actor, sessionId: string, now: Date = new Date()) {
  const at = nowIso(now);
  return withTx(db, () => {
    const s = getSession(db, sessionId, ov.outlet_id);
    const p = activePickup(db, s.id);
    if (!p) fail(409, 'no_pickup', 'Request your car first.');
    if (!p!.guest_outside_at) {
      writePickup(db, p!, { guest_outside_at: at }, at);
      if (s.guest_inside_at) writeSession(db, s, { guest_inside_at: null }, at);
      logEvent(db, { outlet_id: ov.outlet_id, session_id: s.id, pickup_id: p!.id, event_type: 'guest.outside', actor, at });
    }
    return { ok: true };
  });
}

// ── Handover ────────────────────────────────────────────────────────────────

export const MAX_VERIFY_FAILURES = 5;

/** A superseded code still verifies for this long, so a code that rotated while
 *  the attendant was typing it is not a failed handover. */
export const CODE_ROTATION_GRACE_SEC = 20;

/** Issue a rotating, short-lived, single-use handover code for the guest pass.
 *  Always a NEW code (only hashes are stored, so an old one cannot be shown
 *  again); the guest endpoint rate-limits how often this may be asked. */
export function issueHandoverCode(db: DB, sessionId: string, now: Date = new Date()) {
  const at = nowIso(now);
  return withTx(db, () => {
    db.prepare(`UPDATE valet_handover_codes SET superseded_at = ? WHERE session_id = ? AND consumed_at IS NULL AND superseded_at IS NULL`).run(at, sessionId);
    const code = digits(6);
    const expires = addMinutes(now, 1.5);
    db.prepare(`INSERT INTO valet_handover_codes (id, session_id, code_hash, issued_at, expires_at) VALUES (?,?,?,?,?)`)
      .run(newId(), sessionId, sha256(code), at, expires);
    return { code, expires_at: expires };
  });
}

export interface HandoverInput {
  tag_code?: string; method?: string; code?: string;
  recovery_method?: string; reason?: string; version?: unknown;
}

/**
 * VERIFIED HANDOVER. In ONE transaction: the vehicle is at the gate, the staff
 * member matched the key tag (or paper ticket), and a single-use credential is
 * consumed — the guest's rotating code, the printed claim code, or a Valet Head
 * recovery with a documented reason and method. Closing the session revokes
 * every pass grant and code, so an old pass can never be reused.
 */
export function handover(db: DB, ov: OutletValet, actor: Actor, sessionId: string, input: HandoverInput, now: Date = new Date()) {
  const at = nowIso(now);
  type Out = { ok: true; session_id: string } | { ok: false; code: string; message: string; failures: number };
  const out = withTx(db, (): Out => {
    const s = getSession(db, sessionId, ov.outlet_id);
    expectVersion(s, input.version);
    if (s.state !== 'READY_AT_GATE') fail(409, 'bad_state', `The car is ${label(s.state)}. Bring it to the gate first.`);
    const typed = normTagCode(input.tag_code);
    const matches = typed && (typed === normTagCode(s.tag_code) || (s.ticket_no && typed === normTagCode(s.ticket_no)));
    const method = String(input.method || '');
    const failOnce = (code: string, message: string): Out => {
      db.prepare('UPDATE valet_vehicle_sessions SET verify_failures = verify_failures + 1 WHERE id = ?').run(s.id);
      logEvent(db, { outlet_id: ov.outlet_id, session_id: s.id, event_type: 'handover.verify_failed', actor, reason: code, at });
      return { ok: false, code, message, failures: s.verify_failures + 1 };
    };
    if (!matches) return failOnce('tag_mismatch', 'The key tag does not match this car. Check the tag in your hand.');
    if (method === 'head_recovery') {
      if (!actor.head) fail(403, 'head_only', 'Only the Valet Head can hand over without the guest’s code.');
      const why = cleanText(input.reason, 300);
      if (why.length < 10) fail(400, 'reason_required', 'Write what happened and how you verified the guest (at least a sentence).');
      if (!(RECOVERY_METHODS as readonly string[]).includes(String(input.recovery_method))) fail(400, 'method_required', 'Choose how the guest was verified.');
    } else {
      if (s.verify_failures >= MAX_VERIFY_FAILURES) {
        fail(423, 'locked', 'Too many wrong codes for this car. The Valet Head must complete this handover (recovery).');
      }
      const code = normCode(input.code);
      if (method === 'guest_code') {
        if (!/^\d{6}$/.test(code)) return failOnce('bad_code', 'Enter the 6-digit code shown on the guest’s pass.');
        const rows = db.prepare(`SELECT id, code_hash FROM valet_handover_codes WHERE session_id = ? AND consumed_at IS NULL AND expires_at > ?
                                 AND (superseded_at IS NULL OR superseded_at > ?)`).all(s.id, at, addMinutes(now, -CODE_ROTATION_GRACE_SEC / 60)) as
          { id: string; code_hash: string }[];
        const hit = rows.find(r => sameHash(r.code_hash, sha256(code)));
        if (!hit) return failOnce('code_wrong', 'That code is wrong or has expired. Ask the guest to show the current code.');
        db.prepare('UPDATE valet_handover_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL').run(at, hit.id);
      } else if (method === 'claim_code') {
        if (code.length !== 8) return failOnce('bad_code', 'Enter the 8-character code printed on the claim receipt.');
        const rows = db.prepare(`SELECT id, code_hash FROM valet_claim_codes WHERE session_id = ? AND consumed_at IS NULL AND revoked_at IS NULL`).all(s.id) as
          { id: string; code_hash: string }[];
        const hit = rows.find(r => sameHash(r.code_hash, sha256(code)));
        if (!hit) return failOnce('code_wrong', 'That claim code is wrong or was replaced by a newer receipt.');
        db.prepare('UPDATE valet_claim_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL').run(at, hit.id);
      } else {
        fail(400, 'method_required', 'Choose how the guest is verified.');
      }
    }
    // Close everything in the same transaction as the credential consumption.
    const p = activePickup(db, s.id);
    if (p) {
      writePickup(db, p, { state: 'COMPLETED', completed_at: at, ready_at: p.ready_at || at }, at);
      logEvent(db, { outlet_id: ov.outlet_id, session_id: s.id, pickup_id: p.id, event_type: 'pickup.completed', from_state: p.state, to_state: 'COMPLETED', actor, at });
    }
    writeSession(db, s, { state: 'HANDED_OVER', handed_over_at: at, handed_over_by: actor.id, handed_over_by_name: actor.name,
      handover_method: method, handover_note: method === 'head_recovery' ? `${input.recovery_method}: ${cleanText(input.reason, 300)}` : '',
      key_location: 'guest', key_custodian_id: null, key_custodian_name: '', gate_zone_id: null, dwell_deadline_at: null }, at);
    closeCredentials(db, s, at, 'handed over');
    logCustody(db, { outlet_id: ov.outlet_id, session_id: s.id, kind: 'key', from_desc: keyDesc(s.key_location, s.key_custodian_name, s.key_rack, s.key_hook),
      to_desc: 'guest', from_user_id: s.key_custodian_id, actor, at, note: `handover by ${method}` });
    logEvent(db, { outlet_id: ov.outlet_id, session_id: s.id, event_type: 'handover', from_state: 'READY_AT_GATE', to_state: 'HANDED_OVER', actor, at,
      reason: method === 'head_recovery' ? cleanText(input.reason, 300) : '', data: { method, recovery_method: input.recovery_method || '' } });
    return { ok: true, session_id: s.id };
  });
  if (!out.ok) {
    const locked = out.failures >= MAX_VERIFY_FAILURES;
    fail(locked ? 423 : 409, locked ? 'locked' : out.code,
      locked ? 'Too many wrong attempts for this car. The Valet Head must complete this handover (recovery).' : out.message, { failures: out.failures });
  }
  return out as { ok: true; session_id: string };
}

/** Revoke every guest credential for a closed session and free its tag. */
function closeCredentials(db: DB, s: SessionRow, at: string, why: string): void {
  db.prepare(`UPDATE valet_pass_grants SET revoked_at = ?, revoke_reason = ? WHERE session_id = ? AND revoked_at IS NULL`).run(at, why, s.id);
  db.prepare(`UPDATE valet_handover_codes SET superseded_at = COALESCE(superseded_at, ?) WHERE session_id = ? AND consumed_at IS NULL`).run(at, s.id);
  db.prepare(`UPDATE valet_claim_codes SET revoked_at = ? WHERE session_id = ? AND consumed_at IS NULL AND revoked_at IS NULL`).run(at, s.id);
  db.prepare(`UPDATE valet_activation_links SET expires_at = ? WHERE session_id = ? AND consumed_at IS NULL AND expires_at > ?`).run(at, s.id, at);
  if (s.tag_id) db.prepare(`UPDATE valet_tags SET status = 'available', updated_at = ? WHERE id = ? AND status = 'in_use'`).run(at, s.tag_id);
  db.prepare(`UPDATE valet_alerts SET resolved_at = ?, resolved_by = 'system' WHERE session_id = ? AND resolved_at IS NULL`).run(at, s.id);
}

// ── Valet Head controls ─────────────────────────────────────────────────────

/** Audited void of a test or duplicate record. History stays; the car must
 *  not be one the venue still physically holds unless that is the point. */
export function voidSession(db: DB, ov: OutletValet, actor: Actor, sessionId: string, version: unknown, reason: string, isTest: boolean, now: Date = new Date()) {
  const at = nowIso(now);
  return withTx(db, () => {
    if (!actor.head) fail(403, 'head_only', 'Only the Valet Head can void a record.');
    const s = getSession(db, sessionId, ov.outlet_id);
    expectVersion(s, version);
    if (s.state === 'VOIDED' || s.state === 'HANDED_OVER') fail(409, 'closed', 'This record is already closed.');
    const why = cleanText(reason, 300);
    if (why.length < 5) fail(400, 'reason_required', 'Say why this record is void (e.g. "duplicate of tag 14", "test entry").');
    const p = activePickup(db, s.id);
    if (p) writePickup(db, p, { state: 'CANCELLED', cancelled_at: at, cancel_reason: 'record voided' }, at);
    writeSession(db, s, { state: 'VOIDED', voided_at: at, voided_by: actor.id, void_reason: why, is_test: isTest ? 1 : s.is_test }, at);
    closeCredentials(db, s, at, 'voided');
    logEvent(db, { outlet_id: ov.outlet_id, session_id: s.id, event_type: 'session.voided', from_state: s.state, to_state: 'VOIDED', actor, reason: why, at, data: { is_test: isTest } });
    return { ok: true };
  });
}

export function setPriority(db: DB, ov: OutletValet, actor: Actor, pickupId: string, version: unknown, priority: unknown, reason: string, now: Date = new Date()) {
  const at = nowIso(now);
  return withTx(db, () => {
    if (!actor.head) fail(403, 'head_only', 'Only the Valet Head can change priority.');
    const p = getPickup(db, pickupId, ov.outlet_id);
    expectVersion(p, version, 'pickup');
    if (!['SCHEDULED', 'QUEUED', 'ASSIGNED'].includes(p.state)) fail(409, 'bad_state', 'Priority can only change before the car is moving.');
    const n = Math.max(-1, Math.min(3, Math.round(Number(priority) || 0)));
    const why = cleanText(reason, 200);
    if (why.length < 5) fail(400, 'reason_required', 'Priority changes need a reason (it is recorded).');
    writePickup(db, p, { priority: n, priority_reason: why }, at);
    logEvent(db, { outlet_id: ov.outlet_id, session_id: p.session_id, pickup_id: p.id, event_type: 'pickup.priority', actor, reason: why, at,
      data: { from: p.priority, to: n } });
    return { priority: n };
  });
}

export function adjustEta(
  db: DB, ov: OutletValet, actor: Actor, pickupId: string, version: unknown,
  input: { low_min?: unknown; high_min?: unknown; clear?: boolean; reason?: string }, now: Date = new Date(),
) {
  const at = nowIso(now);
  return withTx(db, () => {
    if (!actor.head) fail(403, 'head_only', 'Only the Valet Head can adjust an ETA.');
    const p = getPickup(db, pickupId, ov.outlet_id);
    expectVersion(p, version, 'pickup');
    if (!['QUEUED', 'ASSIGNED', 'IN_PROGRESS'].includes(p.state)) fail(409, 'bad_state', 'ETA can only be adjusted while the car is on its way.');
    const why = cleanText(input.reason, 200);
    if (why.length < 5) fail(400, 'reason_required', 'ETA changes need a reason (it is recorded).');
    if (input.clear) {
      writePickup(db, p, { eta_override_low: null, eta_override_high: null, eta_override_reason: why }, at);
    } else {
      const lo = Math.round(Number(input.low_min)), hi = Math.round(Number(input.high_min));
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 0 || hi <= lo || hi > 180) fail(400, 'bad_range', 'Give a range in minutes, e.g. 10 to 15.');
      writePickup(db, p, { eta_override_low: addMinutes(now, lo), eta_override_high: addMinutes(now, hi), eta_override_reason: why }, at);
    }
    logEvent(db, { outlet_id: ov.outlet_id, session_id: p.session_id, pickup_id: p.id, event_type: 'pickup.eta_adjusted', actor, reason: why, at,
      data: input.clear ? { cleared: true } : { low_min: input.low_min, high_min: input.high_min } });
    return { ok: true };
  });
}

// ── Alerts (guest help, change requests, handoffs) ──────────────────────────

export function raiseAlert(db: DB, outletId: string, sessionId: string | null, pickupId: string | null, kind: string, message: string, dedupe: string, at: string): void {
  // The partial unique index (dedupe_key WHERE resolved_at IS NULL) makes a
  // repeat a no-op instead of a pile of identical cards.
  db.prepare(`INSERT OR IGNORE INTO valet_alerts (id, outlet_id, session_id, pickup_id, kind, message, dedupe_key, created_at)
              VALUES (?,?,?,?,?,?,?,?)`).run(newId(), outletId, sessionId, pickupId, kind, message, dedupe, at);
}
export function resolveAlert(db: DB, dedupe: string, actor: Actor, at: string): void {
  db.prepare(`UPDATE valet_alerts SET resolved_at = ?, resolved_by = ? WHERE dedupe_key = ? AND resolved_at IS NULL`).run(at, actor.id, dedupe);
}

export { activeTaskCount, openShift, canPickup };
