/**
 * VALET arrival operations: check-in, parking, key custody, guest credentials.
 * Every function runs inside withTx (BEGIN IMMEDIATE) and appends to the
 * timeline + custody logs. docs/valet/DESIGN.md §3 (vehicle table).
 */
import type { DB, Actor, OutletValet, SessionRow } from './core';
import {
  fail, newId, logEvent, logCustody, getSession, expectVersion, writeSession, withTx,
  assertCanTakeWork, activeTaskCount,
} from './core';
import { canVehicle, isHeld } from './states';
import {
  nowIso, addMinutes, businessDate, normPlate, normTagCode, cleanMobile, cleanText,
} from './config';
import { sha256, randomToken, crockfordCode, digits } from './credentials';

export interface CheckinInput {
  plate?: string; make?: string; model?: string; colour?: string;
  guest_name?: string; guest_mobile?: string; notes?: string;
  tag_code?: string; ticket_no?: string;
  /** Staff resolution when the plate is already on another active car. */
  duplicate_plate_note?: string;
  /** Confirm a guest's pending self check-in (from the pairing code). */
  request_id?: string;
  is_test?: boolean;
}

interface TagRow { id: string; code: string; status: string; kind: string }

/** Resolve a key tag by its visible code at this outlet. Auto-registers an
 *  unknown code when the outlet allows it, so the core flow needs no setup —
 *  but a disabled/lost/retired tag is always refused. */
function resolveTag(db: DB, outletId: string, code: string, actor: Actor, at: string, autoRegister: boolean): TagRow {
  const norm = normTagCode(code);
  if (!norm) fail(400, 'tag_required', 'Enter or scan the key tag number.');
  let tag = db.prepare('SELECT id, code, status, kind FROM valet_tags WHERE outlet_id = ? AND code_norm = ?').get(outletId, norm) as TagRow | undefined;
  if (!tag) {
    if (!autoRegister) fail(404, 'tag_unknown', `Key tag ${code} is not registered at this outlet. Add it in Valet Settings → Tags.`);
    const id = newId();
    db.prepare(`INSERT INTO valet_tags (id, outlet_id, code, code_norm, kind, status, created_at, updated_at)
                VALUES (?,?,?,?, 'key_tag', 'available', ?, ?)`).run(id, outletId, cleanText(code, 12), norm, at, at);
    logEvent(db, { outlet_id: outletId, event_type: 'tag.auto_registered', actor, data: { tag_id: id, code: norm }, at });
    tag = { id, code: cleanText(code, 12), status: 'available', kind: 'key_tag' };
  }
  if (tag.status === 'in_use') {
    const holder = db.prepare(`SELECT state FROM valet_vehicle_sessions WHERE tag_id = ? AND state NOT IN ('HANDED_OVER','VOIDED')`).get(tag.id) as { state: string } | undefined;
    fail(409, 'tag_in_use', `Key tag ${tag.code} is already on another car${holder ? ` (${holder.state.replace(/_/g, ' ').toLowerCase()})` : ''}. Use a different tag.`);
  }
  if (tag.status !== 'available') fail(409, 'tag_unavailable', `Key tag ${tag.code} is marked ${tag.status}. Use a different tag.`);
  return tag;
}

function requireFields(ov: OutletValet, v: { plate: string; make: string; model: string; colour: string; guest_name: string; guest_mobile: string }): void {
  const r = ov.cfg.required;
  const missing: string[] = [];
  if (r.plate && !v.plate) missing.push('number plate');
  if (r.make && !v.make) missing.push('make');
  if (r.model && !v.model) missing.push('model');
  if (r.colour && !v.colour) missing.push('colour');
  if (r.guest_name && !v.guest_name) missing.push('guest name');
  if (r.guest_mobile && !v.guest_mobile) missing.push('guest mobile');
  if (missing.length) fail(400, 'missing_fields', `Please fill in: ${missing.join(', ')}.`, { missing });
}

/**
 * Staff check-in — staff-assisted, or confirming a guest's pending self
 * check-in. Creates a CHECKED_IN vehicle session, puts the tag in use and the
 * keys in the attendant's custody. The DUPLICATE ACTIVE PLATE rule: refused
 * with the other car named unless staff record why (duplicate_plate_note).
 */
export function checkinCreate(db: DB, ov: OutletValet, actor: Actor, input: CheckinInput, now: Date = new Date()) {
  const at = nowIso(now);
  return withTx(db, () => {
    // The keys go into the checker's custody, so the checker must be on shift
    // HERE — otherwise end-of-shift reconciliation would never see those keys.
    if (!actor.isAdmin) {
      const sh = db.prepare('SELECT outlet_id FROM valet_shifts WHERE user_id = ? AND ended_at IS NULL').get(actor.id) as { outlet_id: string } | undefined;
      if (!sh || sh.outlet_id !== ov.outlet_id) fail(409, 'not_on_shift', 'Start your shift at this outlet before checking a car in.');
    }
    let pending: Record<string, string> | null = null;
    if (input.request_id) {
      pending = db.prepare(`SELECT * FROM valet_checkin_requests WHERE id = ? AND outlet_id = ?`).get(String(input.request_id), ov.outlet_id) as Record<string, string> | null;
      if (!pending) fail(404, 'request_not_found', 'That guest check-in was not found at this outlet.');
      if (pending!.status !== 'pending') fail(409, 'request_closed', `That guest check-in is already ${pending!.status}.`);
      if (pending!.expires_at <= at) fail(409, 'request_expired', 'That guest check-in has expired. Ask the guest to scan again, or check the car in here.');
    }
    // Staff-typed values win; the guest's own entries fill the gaps.
    const pick = (k: keyof CheckinInput, max = 40) => cleanText((input[k] as string) || (pending?.[k as string] ?? ''), max);
    const v = {
      plate: pick('plate', 16).toUpperCase(), make: pick('make', 30), model: pick('model', 30), colour: pick('colour', 20),
      guest_name: pick('guest_name', 60), guest_mobile: cleanMobile(input.guest_mobile || pending?.guest_mobile || ''),
    };
    requireFields(ov, v);
    const plateNorm = normPlate(v.plate);
    const ticket = cleanText(input.ticket_no || pending?.ticket_no || '', 20).toUpperCase();
    if (!input.tag_code && !ticket) fail(400, 'tag_required', 'Enter or scan the key tag number (or the paper ticket number).');
    const tag = input.tag_code ? resolveTag(db, ov.outlet_id, input.tag_code, actor, at, true) : null;

    if (plateNorm) {
      const dup = db.prepare(`SELECT id, tag_code, state FROM valet_vehicle_sessions
                              WHERE outlet_id = ? AND plate_norm = ? AND state NOT IN ('HANDED_OVER','VOIDED')`).all(ov.outlet_id, plateNorm) as
        { id: string; tag_code: string; state: string }[];
      const note = cleanText(input.duplicate_plate_note, 200);
      if (dup.length && note.length < 5) {
        fail(409, 'duplicate_plate', `Plate ${v.plate} is already on an active car (tag ${dup.map(d => d.tag_code || '—').join(', ')}). Check the car, then record why this is a second check-in.`,
          { duplicates: dup.map(d => ({ id: d.id, tag_code: d.tag_code, state: d.state })) });
      }
    }

    const id = newId();
    db.prepare(`INSERT INTO valet_vehicle_sessions (id, outlet_id, business_date, state, checkin_source, tag_id, tag_code, ticket_no,
                  plate, plate_norm, make, model, colour, guest_name, guest_mobile, notes, duplicate_plate_note,
                  checked_in_at, checked_in_by, checked_in_by_name, key_location, key_custodian_id, key_custodian_name,
                  is_test, updated_at)
                VALUES (?,?,?, 'CHECKED_IN', ?,?,?,?, ?,?,?,?,?,?,?,?,?, ?,?,?, 'attendant', ?,?, ?, ?)`).run(
      id, ov.outlet_id, businessDate(now, ov.cfg), pending ? (pending.source || 'guest_qr') : 'staff',
      tag?.id ?? null, tag?.code ?? '', ticket,
      v.plate, plateNorm, v.make, v.model, v.colour, v.guest_name, v.guest_mobile,
      cleanText(input.notes, 300), cleanText(input.duplicate_plate_note, 200),
      at, actor.id, actor.name, actor.id, actor.name, input.is_test ? 1 : 0, at,
    );
    if (tag) db.prepare(`UPDATE valet_tags SET status = 'in_use', updated_at = ? WHERE id = ?`).run(at, tag.id);
    logEvent(db, { outlet_id: ov.outlet_id, session_id: id, event_type: 'checkin', to_state: 'CHECKED_IN', actor, at,
      data: { source: pending ? 'guest_qr' : 'staff', tag: tag?.code ?? '', ticket, duplicate_plate: !!input.duplicate_plate_note } });
    logCustody(db, { outlet_id: ov.outlet_id, session_id: id, kind: 'key', from_desc: 'guest', to_desc: `attendant ${actor.name}`,
      to_user_id: actor.id, actor, at, note: 'keys received at check-in' });

    if (pending) {
      db.prepare(`UPDATE valet_checkin_requests SET status = 'confirmed', resolved_at = ?, resolved_by = ?, session_id = ? WHERE id = ?`)
        .run(at, actor.id, id, pending.id);
      if (pending.device_id) {
        db.prepare(`INSERT INTO valet_pass_grants (id, device_id, session_id, granted_how, created_at) VALUES (?,?,?, 'paired_checkin', ?)`)
          .run(newId(), pending.device_id, id, at);
      }
      logEvent(db, { outlet_id: ov.outlet_id, session_id: id, event_type: 'checkin.paired', actor, at, data: { request_id: pending.id } });
    }
    return { session_id: id, paired: !!pending?.device_id };
  });
}

/** Find a guest's pending self check-in by the pairing code they show. */
export function findPendingByCode(db: DB, ov: OutletValet, code: string, now: Date = new Date()) {
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== 6) fail(400, 'bad_code', 'Pairing codes are 6 digits.');
  const row = db.prepare(`SELECT id, plate, make, model, colour, guest_name, guest_mobile, ticket_no, created_at, expires_at, source
                          FROM valet_checkin_requests WHERE outlet_id = ? AND pairing_code = ? AND status = 'pending'`).get(ov.outlet_id, c) as
    Record<string, string> | undefined;
  if (!row || row.expires_at <= nowIso(now)) fail(404, 'code_not_found', 'No waiting check-in with that code. It may have expired — ask the guest to scan again.');
  // An attendant needs the car details to confirm — the mobile goes no further than "provided".
  const { guest_mobile, ...rest } = row!;
  return { ...rest, has_mobile: !!guest_mobile };
}

/** Expire abandoned guest check-ins (worker + reads). */
export function expirePending(db: DB, now: Date = new Date()): number {
  return db.prepare(`UPDATE valet_checkin_requests SET status = 'expired', resolved_at = ? WHERE status = 'pending' AND expires_at <= ?`)
    .run(nowIso(now), nowIso(now)).changes;
}

/** Guest-led check-in from the venue QR / NFC card: a short-lived pending
 *  request + a 6-digit pairing code. The venue does not hold the car yet. */
export function createPendingCheckin(
  db: DB, ov: OutletValet, deviceId: string,
  input: { plate?: string; make?: string; model?: string; colour?: string; guest_name?: string; guest_mobile?: string; ticket_no?: string; source?: string },
  now: Date = new Date(),
) {
  const at = nowIso(now);
  return withTx(db, () => {
    // One open request per browser per outlet: a retry returns the same code.
    const existing = db.prepare(`SELECT id, pairing_code, expires_at FROM valet_checkin_requests
                                 WHERE outlet_id = ? AND device_id = ? AND status = 'pending' AND expires_at > ?`).get(ov.outlet_id, deviceId, at) as
      { id: string; pairing_code: string; expires_at: string } | undefined;
    if (existing) return { request_id: existing.id, pairing_code: existing.pairing_code, expires_at: existing.expires_at, reused: true };
    const plate = cleanText(input.plate, 16).toUpperCase();
    if (!plate && !cleanText(input.ticket_no, 20)) fail(400, 'plate_required', 'Please enter your number plate.');
    let code = '';
    for (let i = 0; i < 20 && !code; i++) {
      const c = digits(6);
      const clash = db.prepare(`SELECT 1 FROM valet_checkin_requests WHERE outlet_id = ? AND pairing_code = ? AND status = 'pending'`).get(ov.outlet_id, c);
      if (!clash) code = c;
    }
    if (!code) fail(503, 'busy', 'Please try again in a moment.');
    const id = newId();
    const expires = addMinutes(now, ov.cfg.pending_checkin_minutes);
    db.prepare(`INSERT INTO valet_checkin_requests (id, outlet_id, source, pairing_code, device_id, plate, plate_norm, make, model, colour,
                  guest_name, guest_mobile, ticket_no, status, created_at, expires_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending', ?, ?)`).run(
      id, ov.outlet_id, input.source === 'paper' ? 'paper' : 'guest_qr', code, deviceId, plate, normPlate(plate),
      cleanText(input.make, 30), cleanText(input.model, 30), cleanText(input.colour, 20),
      cleanText(input.guest_name, 60), cleanMobile(input.guest_mobile), cleanText(input.ticket_no, 20).toUpperCase(), at, expires);
    return { request_id: id, pairing_code: code, expires_at: expires, reused: false };
  });
}

// ── Parking ─────────────────────────────────────────────────────────────────

export function parkStart(db: DB, ov: OutletValet, actor: Actor, sessionId: string, version: unknown, now: Date = new Date()) {
  const at = nowIso(now);
  return withTx(db, () => {
    const s = getSession(db, sessionId, ov.outlet_id);
    expectVersion(s, version);
    if (!canVehicle(s.state, 'PARKING') || !['CHECKED_IN', 'PARKED'].includes(s.state)) {
      fail(409, 'bad_state', `This car is ${label(s.state)}; it cannot start parking now.`);
    }
    if (s.state === 'PARKED' && !actor.head) fail(403, 'head_only', 'Moving a parked car to another spot needs the Valet Head.');
    assertCanTakeWork(db, actor.id, actor.name, ov.outlet_id, ov.cfg.max_tasks_per_attendant);
    writeSession(db, s, { state: 'PARKING', parking_started_at: at, parking_by: actor.id, parking_by_name: actor.name }, at);
    logEvent(db, { outlet_id: ov.outlet_id, session_id: s.id, event_type: s.state === 'PARKED' ? 'vehicle.relocate_start' : 'park.start',
      from_state: s.state, to_state: 'PARKING', actor, at });
    return { session_id: s.id };
  });
}

export interface ParkInput {
  zone_id?: string; spot?: string;
  key_location?: string; key_rack?: string; key_hook?: string;
  photo_exception?: string;
}

/** Confirm where the car is and where the keys are. Two separate facts, two
 *  custody rows — "track vehicle location and key location separately". */
export function parkConfirm(db: DB, ov: OutletValet, actor: Actor, sessionId: string, version: unknown, input: ParkInput, now: Date = new Date()) {
  const at = nowIso(now);
  return withTx(db, () => {
    const s = getSession(db, sessionId, ov.outlet_id);
    expectVersion(s, version);
    if (!['CHECKED_IN', 'PARKING', 'RELOCATING'].includes(s.state)) fail(409, 'bad_state', `This car is ${label(s.state)}; it cannot be marked parked now.`);
    if (s.state === 'PARKING' && s.parking_by && s.parking_by !== actor.id && !actor.head) {
      fail(403, 'not_yours', `${s.parking_by_name || 'Another attendant'} is parking this car.`);
    }
    const zone = db.prepare(`SELECT id, name, kind FROM valet_zones WHERE id = ? AND outlet_id = ? AND is_active = 1`).get(String(input.zone_id || ''), ov.outlet_id) as
      { id: string; name: string; kind: string } | undefined;
    if (!zone) fail(400, 'zone_required', 'Pick the parking zone.');
    if (zone!.kind !== 'parking') fail(400, 'zone_kind', `${zone!.name} is a ${zone!.kind} area, not a parking zone.`);
    const spot = cleanText(input.spot, 40);
    const keyLoc = ['rack', 'attendant', 'desk'].includes(String(input.key_location)) ? String(input.key_location) : '';
    if (!keyLoc) fail(400, 'key_location_required', 'Say where the keys are: on the rack, with you, or at the desk.');
    const rack = cleanText(input.key_rack, 20), hook = cleanText(input.key_hook, 20);
    if (keyLoc === 'rack' && !rack && !hook) fail(400, 'key_rack_required', 'Enter the key rack or hook.');

    const photoCount = countPhotos(db, s.id);
    let photoException = '';
    if (photoCount < ov.cfg.photos.min) {
      photoException = cleanText(input.photo_exception, 200);
      if (!ov.cfg.photos.allow_exception) fail(400, 'photos_required', `${ov.cfg.photos.min} condition photo(s) are required before parking.`);
      if (photoException.length < 5) fail(400, 'photo_exception_required', `This outlet asks for ${ov.cfg.photos.min} condition photo(s). Add them, or record why they were skipped.`);
    }
    const custodian = keyLoc === 'attendant' ? { id: actor.id, name: actor.name } : { id: null as string | null, name: '' };
    writeSession(db, s, {
      state: 'PARKED', parked_at: at, parked_by: actor.id, parked_by_name: actor.name,
      parking_started_at: s.parking_started_at || at, zone_id: zone!.id, spot,
      key_location: keyLoc, key_rack: keyLoc === 'rack' ? rack : '', key_hook: keyLoc === 'rack' ? hook : '',
      key_custodian_id: custodian.id, key_custodian_name: custodian.name,
      photo_exception: photoException || s.photo_exception, photo_exception_by: photoException ? actor.id : s.photo_exception_by,
      relocating_by: null,
    }, at);
    logEvent(db, { outlet_id: ov.outlet_id, session_id: s.id, event_type: 'park.confirm', from_state: s.state, to_state: 'PARKED', actor, at,
      data: { zone: zone!.name, spot, key_location: keyLoc, photo_exception: !!photoException } });
    logCustody(db, { outlet_id: ov.outlet_id, session_id: s.id, kind: 'vehicle', from_desc: s.zone_id ? 'previous spot' : 'arrival',
      to_desc: `${zone!.name}${spot ? ' · ' + spot : ''}`, zone_id: zone!.id, spot, actor, at });
    if (keyLoc !== s.key_location || keyLoc === 'rack' || custodian.id !== s.key_custodian_id) {
      logCustody(db, { outlet_id: ov.outlet_id, session_id: s.id, kind: 'key', from_desc: keyDesc(s.key_location, s.key_custodian_name, s.key_rack, s.key_hook),
        to_desc: keyDesc(keyLoc, custodian.name, rack, hook), from_user_id: s.key_custodian_id, to_user_id: custodian.id,
        key_rack: rack, key_hook: hook, actor, at });
    }
    return { session_id: s.id };
  });
}

function countPhotos(db: DB, sessionId: string): number {
  try {
    const r = db.prepare(`SELECT COUNT(*) AS n FROM valet_media WHERE session_id = ? AND deleted_at IS NULL`).get(sessionId) as { n: number };
    return r.n;
  } catch { return 0; }   // photos arrive in increment 2; until then nothing is counted
}

export function keyDesc(loc: string, custodian: string, rack: string, hook: string): string {
  if (loc === 'rack') return `rack ${[rack, hook].filter(Boolean).join(' / ') || '?'}`;
  if (loc === 'attendant') return `attendant ${custodian || '?'}`;
  if (loc === 'desk') return 'valet desk';
  if (loc === 'guest') return 'guest';
  return loc;
}

/** Move the KEYS (not the car): to the rack, the desk, or another on-shift
 *  attendant. A transfer to a person is that person's custody from now on. */
export function keyTransfer(
  db: DB, ov: OutletValet, actor: Actor, sessionId: string, version: unknown,
  input: { to?: string; to_user_id?: string; key_rack?: string; key_hook?: string; note?: string }, now: Date = new Date(),
) {
  const at = nowIso(now);
  return withTx(db, () => {
    const s = getSession(db, sessionId, ov.outlet_id);
    expectVersion(s, version);
    if (!isHeld(s.state)) fail(409, 'bad_state', 'The venue no longer holds this car.');
    const to = String(input.to || '');
    if (!['rack', 'desk', 'attendant'].includes(to)) fail(400, 'bad_target', 'Say where the keys go: rack, desk or an attendant.');
    let toUser: { id: string; name: string } | null = null;
    if (to === 'attendant') {
      const uid = String(input.to_user_id || actor.id);
      const sh = db.prepare(`SELECT user_id, user_name FROM valet_shifts WHERE user_id = ? AND outlet_id = ? AND ended_at IS NULL`).get(uid, ov.outlet_id) as
        { user_id: string; user_name: string } | undefined;
      if (!sh) fail(409, 'not_on_shift', 'Keys can only go to someone on shift at this outlet.');
      toUser = { id: sh!.user_id, name: sh!.user_name };
    }
    const rack = cleanText(input.key_rack, 20), hook = cleanText(input.key_hook, 20);
    if (to === 'rack' && !rack && !hook) fail(400, 'key_rack_required', 'Enter the key rack or hook.');
    writeSession(db, s, {
      key_location: to, key_rack: to === 'rack' ? rack : '', key_hook: to === 'rack' ? hook : '',
      key_custodian_id: toUser?.id ?? null, key_custodian_name: toUser?.name ?? '',
    }, at);
    logCustody(db, { outlet_id: ov.outlet_id, session_id: s.id, kind: 'key',
      from_desc: keyDesc(s.key_location, s.key_custodian_name, s.key_rack, s.key_hook),
      to_desc: keyDesc(to, toUser?.name || '', rack, hook), from_user_id: s.key_custodian_id, to_user_id: toUser?.id ?? null,
      key_rack: rack, key_hook: hook, actor, note: cleanText(input.note, 200), at });
    logEvent(db, { outlet_id: ov.outlet_id, session_id: s.id, event_type: 'key.transfer', actor, at, data: { to } });
    return { session_id: s.id };
  });
}

// ── Guest credentials issued by staff ───────────────────────────────────────

/** One-time activation link (shown as a QR on the attendant's phone) that binds
 *  the guest's own browser to this car. 15 minutes, single use. */
export function issueActivationLink(db: DB, ov: OutletValet, actor: Actor, sessionId: string, now: Date = new Date()) {
  const at = nowIso(now);
  return withTx(db, () => {
    const s = getSession(db, sessionId, ov.outlet_id);
    if (!isHeld(s.state)) fail(409, 'bad_state', 'This car has already been handed over.');
    // A new link supersedes any unused one, so only the newest QR works.
    db.prepare(`UPDATE valet_activation_links SET expires_at = ? WHERE session_id = ? AND consumed_at IS NULL AND expires_at > ?`).run(at, s.id, at);
    const token = randomToken(24);
    db.prepare(`INSERT INTO valet_activation_links (id, session_id, token_hash, purpose, created_at, created_by, expires_at)
                VALUES (?,?,?, 'activate', ?,?,?)`).run(newId(), s.id, sha256(token), at, actor.id, addMinutes(now, 15));
    logEvent(db, { outlet_id: ov.outlet_id, session_id: s.id, event_type: 'pass.link_issued', actor, at });
    return { path: `/valet-pass?a=${token}`, expires_at: addMinutes(now, 15) };
  });
}

/** Printed / staff-assisted claim code for a guest without a usable phone.
 *  Returned ONCE in clear (for the receipt); only its hash is kept. Reissuing
 *  revokes the previous code. */
export function issueClaimCode(db: DB, ov: OutletValet, actor: Actor, sessionId: string, now: Date = new Date()) {
  const at = nowIso(now);
  return withTx(db, () => {
    const s = getSession(db, sessionId, ov.outlet_id);
    if (!isHeld(s.state)) fail(409, 'bad_state', 'This car has already been handed over.');
    db.prepare(`UPDATE valet_claim_codes SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL AND consumed_at IS NULL`).run(at, s.id);
    const code = crockfordCode(8);
    db.prepare(`INSERT INTO valet_claim_codes (id, session_id, code_hash, issued_at, issued_by) VALUES (?,?,?,?,?)`)
      .run(newId(), s.id, sha256(code), at, actor.id);
    logEvent(db, { outlet_id: ov.outlet_id, session_id: s.id, event_type: 'claim_code.issued', actor, at });
    return {
      code: `${code.slice(0, 4)}-${code.slice(4)}`, tag_code: s.tag_code, ticket_no: s.ticket_no,
      plate_tail: s.plate_norm.slice(-4), checked_in_at: s.checked_in_at, outlet_name: ov.outlet_name,
      venue_name: ov.cfg.venue_name || ov.outlet_name, gate: ov.cfg.pickup_gate_label,
    };
  });
}

export function label(state: string): string {
  return state.replace(/_/g, ' ').toLowerCase();
}

export { activeTaskCount };
export type { SessionRow };
