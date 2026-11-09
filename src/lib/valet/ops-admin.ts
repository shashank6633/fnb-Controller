/**
 * VALET shifts, incidents, alerts, contact, settings and shift handover.
 * Permissions are decided by the command table (commands.ts); the functions
 * below re-check only what depends on the row (e.g. "your own shift").
 */
import type { DB, Actor, OutletValet } from './core';
import { fail, newId, logEvent, getSession, withTx, openShift, writeSession, logCustody } from './core';
import { INCIDENT_KINDS, ZONE_KINDS, TAG_STATUSES, isHeld } from './states';
import { nowIso, parseConfig, normTagCode, cleanText, businessDate } from './config';
import { newEntryToken } from './credentials';
import { keyDesc } from './ops-arrival';

// ── Shifts ──────────────────────────────────────────────────────────────────

export function shiftStart(db: DB, ov: OutletValet, actor: Actor, now: Date = new Date()) {
  const at = nowIso(now);
  return withTx(db, () => {
    const sh = openShift(db, actor.id);
    if (sh) {
      if (sh.outlet_id === ov.outlet_id) return { shift_id: sh.id, existing: true };
      fail(409, 'other_outlet', 'You are on shift at another outlet. End that shift first.');
    }
    const id = newId();
    db.prepare(`INSERT INTO valet_shifts (id, outlet_id, user_id, user_name, status, started_at, last_seen_at) VALUES (?,?,?,?, 'on', ?, ?)`)
      .run(id, ov.outlet_id, actor.id, actor.name, at, at);
    logEvent(db, { outlet_id: ov.outlet_id, event_type: 'shift.start', actor, at });
    return { shift_id: id, existing: false };
  });
}

/** Everything a person still holds: claimed cars, cars mid-move, keys. */
export function outstandingCustody(db: DB, userId: string) {
  const pickups = db.prepare(`SELECT p.id, p.state, s.tag_code FROM valet_pickups p JOIN valet_vehicle_sessions s ON s.id = p.session_id
                              WHERE p.assigned_user_id = ? AND p.state IN ('ASSIGNED','IN_PROGRESS')`).all(userId) as { id: string; state: string; tag_code: string }[];
  const moving = db.prepare(`SELECT id, state, tag_code FROM valet_vehicle_sessions
                             WHERE (state = 'PARKING' AND parking_by = ?) OR (state = 'RELOCATING' AND relocating_by = ?)`).all(userId, userId) as
    { id: string; state: string; tag_code: string }[];
  const keys = db.prepare(`SELECT id, state, tag_code FROM valet_vehicle_sessions WHERE key_location = 'attendant' AND key_custodian_id = ?
                           AND state NOT IN ('HANDED_OVER','VOIDED')`).all(userId) as { id: string; state: string; tag_code: string }[];
  return { pickups, moving, keys, total: pickups.length + moving.length + keys.length };
}

export function shiftBreak(db: DB, ov: OutletValet, actor: Actor, onBreak: boolean, now: Date = new Date()) {
  const at = nowIso(now);
  return withTx(db, () => {
    const sh = openShift(db, actor.id);
    if (!sh || sh.outlet_id !== ov.outlet_id) fail(409, 'not_on_shift', 'You are not on shift here.');
    if (onBreak) {
      if (sh!.status === 'break') return { status: 'break' };
      const o = outstandingCustody(db, actor.id);
      if (o.pickups.length || o.moving.length) fail(409, 'busy', 'Finish the car you are moving before taking a break.');
      db.prepare(`UPDATE valet_shifts SET status = 'break', break_started_at = ?, last_seen_at = ? WHERE id = ?`).run(at, at, sh!.id);
    } else {
      if (sh!.status !== 'break') return { status: 'on' };
      const secs = sh!.break_started_at ? Math.max(0, Math.round((now.getTime() - Date.parse(sh!.break_started_at)) / 1000)) : 0;
      db.prepare(`UPDATE valet_shifts SET status = 'on', break_started_at = NULL, break_seconds = break_seconds + ?, last_seen_at = ? WHERE id = ?`)
        .run(secs, at, sh!.id);
    }
    logEvent(db, { outlet_id: ov.outlet_id, event_type: onBreak ? 'shift.break' : 'shift.resume', actor, at });
    return { status: onBreak ? 'break' : 'on' };
  });
}

/**
 * End a shift. Refused while the person still holds anything — the spec's
 * "ending a shift with outstanding custody requires an acknowledged transfer".
 * The refusal lists exactly what to hand over (keys → rack/desk/colleague,
 * claimed cars → reassign, a car mid-park → finish). A head may end someone
 * else's shift (they left), under the same rule.
 */
export function shiftEnd(db: DB, ov: OutletValet, actor: Actor, userId: string | null, note: string, now: Date = new Date()) {
  const at = nowIso(now);
  const target = userId || actor.id;
  return withTx(db, () => {
    if (target !== actor.id && !actor.head) fail(403, 'head_only', 'Only the Valet Head can end another person’s shift.');
    const sh = openShift(db, target);
    if (!sh || sh.outlet_id !== ov.outlet_id) fail(409, 'not_on_shift', 'That person is not on shift here.');
    const o = outstandingCustody(db, target);
    if (o.total > 0) {
      fail(409, 'custody_outstanding',
        `Hand these over before ending the shift: ${[
          o.pickups.length ? `${o.pickups.length} claimed car(s) — ask the head to reassign` : '',
          o.moving.length ? `${o.moving.length} car(s) mid-move — finish parking` : '',
          o.keys.length ? `keys for tag(s) ${o.keys.map(k => k.tag_code || '—').join(', ')} — put them on the rack or give them to a colleague` : '',
        ].filter(Boolean).join('; ')}.`, { custody: o });
    }
    const breakSecs = sh!.status === 'break' && sh!.break_started_at ? Math.round((now.getTime() - Date.parse(sh!.break_started_at)) / 1000) : 0;
    db.prepare(`UPDATE valet_shifts SET ended_at = ?, ended_by = ?, end_note = ?, status = 'ended', break_seconds = break_seconds + ? WHERE id = ?`)
      .run(at, actor.id, cleanText(note, 300), Math.max(0, breakSecs), sh!.id);
    logEvent(db, { outlet_id: ov.outlet_id, event_type: 'shift.end', actor, at, data: { user_id: target, by_head: target !== actor.id } });
    return { ok: true };
  });
}

/** Attendant device ping — the board uses it to flag "uncertain" work. */
export function heartbeat(db: DB, actor: Actor, now: Date = new Date()): void {
  db.prepare('UPDATE valet_shifts SET last_seen_at = ? WHERE user_id = ? AND ended_at IS NULL').run(nowIso(now), actor.id);
}

// ── Incidents, alerts, contact ──────────────────────────────────────────────

export function incidentCreate(db: DB, ov: OutletValet, actor: Actor, input: { session_id?: string; kind?: string; description?: string }, now: Date = new Date()) {
  const at = nowIso(now);
  return withTx(db, () => {
    const kind = (INCIDENT_KINDS as readonly string[]).includes(String(input.kind)) ? String(input.kind) : 'other';
    const desc = cleanText(input.description, 1000);
    if (desc.length < 5) fail(400, 'description_required', 'Describe what happened.');
    let sessionId: string | null = null;
    if (input.session_id) sessionId = getSession(db, input.session_id, ov.outlet_id).id;
    const id = newId();
    db.prepare(`INSERT INTO valet_incidents (id, outlet_id, session_id, kind, description, reported_by, reported_by_name, created_at)
                VALUES (?,?,?,?,?,?,?,?)`).run(id, ov.outlet_id, sessionId, kind, desc, actor.id, actor.name, at);
    logEvent(db, { outlet_id: ov.outlet_id, session_id: sessionId, event_type: 'incident.reported', actor, at, data: { incident_id: id, kind } });
    return { incident_id: id };
  });
}

export function incidentResolve(db: DB, ov: OutletValet, actor: Actor, input: { incident_id?: string; resolution?: string; retention_hold?: boolean }, now: Date = new Date()) {
  const at = nowIso(now);
  return withTx(db, () => {
    const inc = db.prepare('SELECT * FROM valet_incidents WHERE id = ? AND outlet_id = ?').get(String(input.incident_id || ''), ov.outlet_id) as
      { id: string; session_id: string | null; status: string } | undefined;
    if (!inc) fail(404, 'not_found', 'Incident not found at this outlet.');
    const res = cleanText(input.resolution, 1000);
    if (res.length < 5) fail(400, 'resolution_required', 'Write how it was resolved.');
    db.prepare(`UPDATE valet_incidents SET status = 'resolved', resolved_at = ?, resolved_by = ?, resolution = ?, retention_hold = ? WHERE id = ?`)
      .run(at, actor.id, res, input.retention_hold ? 1 : 0, inc!.id);
    logEvent(db, { outlet_id: ov.outlet_id, session_id: inc!.session_id, event_type: 'incident.resolved', actor, at,
      data: { incident_id: inc!.id, retention_hold: !!input.retention_hold } });
    return { ok: true };
  });
}

export function alertUpdate(db: DB, ov: OutletValet, actor: Actor, alertId: string, action: 'ack' | 'resolve', now: Date = new Date()) {
  const at = nowIso(now);
  const col = action === 'ack' ? 'acknowledged' : 'resolved';
  const r = db.prepare(`UPDATE valet_alerts SET ${col}_at = COALESCE(${col}_at, ?), ${col}_by = CASE WHEN ${col}_at IS NULL THEN ? ELSE ${col}_by END
                        WHERE id = ? AND outlet_id = ?`).run(at, actor.id, String(alertId || ''), ov.outlet_id);
  if (r.changes !== 1) fail(404, 'not_found', 'Alert not found at this outlet.');
  withTx(db, () => logEvent(db, { outlet_id: ov.outlet_id, event_type: `alert.${action}`, actor, at, data: { alert_id: alertId } }));
  return { ok: true };
}

/** Controlled contact: the head sees a guest's number only by asking for it,
 *  with a reason, and the ask is recorded (the number itself is not logged). */
export function revealContact(db: DB, ov: OutletValet, actor: Actor, sessionId: string, reason: string, now: Date = new Date()) {
  const at = nowIso(now);
  if (!actor.head) fail(403, 'head_only', 'Only the Valet Head can see a guest’s number.');
  const why = cleanText(reason, 200);
  if (why.length < 5) fail(400, 'reason_required', 'Say why you need to contact the guest (it is recorded).');
  const s = getSession(db, sessionId, ov.outlet_id);
  if (s.redacted_at) fail(410, 'redacted', 'This guest’s details were removed under the retention policy.');
  withTx(db, () => logEvent(db, { outlet_id: ov.outlet_id, session_id: s.id, event_type: 'contact.revealed', actor, reason: why, at }));
  return { guest_name: s.guest_name, guest_mobile: s.guest_mobile };
}

// ── Settings ────────────────────────────────────────────────────────────────

function ensureConfigRow(db: DB, outletId: string, at: string, by: string): void {
  db.prepare(`INSERT OR IGNORE INTO valet_outlet_config (outlet_id, enabled, config_json, entry_token, updated_at, updated_by)
              VALUES (?, 0, '{}', ?, ?, ?)`).run(outletId, newEntryToken(), at, by);
}

export function setOutletEnabled(db: DB, outletId: string, actor: Actor, enabled: boolean, now: Date = new Date()) {
  const at = nowIso(now);
  return withTx(db, () => {
    ensureConfigRow(db, outletId, at, actor.id);
    db.prepare('UPDATE valet_outlet_config SET enabled = ?, updated_at = ?, updated_by = ? WHERE outlet_id = ?').run(enabled ? 1 : 0, at, actor.id, outletId);
    logEvent(db, { outlet_id: outletId, event_type: enabled ? 'outlet.enabled' : 'outlet.disabled', actor, at });
    return { enabled };
  });
}

export function saveConfig(db: DB, outletId: string, actor: Actor, raw: unknown, now: Date = new Date()) {
  const at = nowIso(now);
  return withTx(db, () => {
    ensureConfigRow(db, outletId, at, actor.id);
    const cfg = parseConfig(raw);   // clamps + defaults: nothing malformed is ever stored
    db.prepare('UPDATE valet_outlet_config SET config_json = ?, updated_at = ?, updated_by = ? WHERE outlet_id = ?').run(JSON.stringify(cfg), at, actor.id, outletId);
    logEvent(db, { outlet_id: outletId, event_type: 'config.saved', actor, at });
    return { config: cfg };
  });
}

export function rotateEntryToken(db: DB, outletId: string, actor: Actor, now: Date = new Date()) {
  const at = nowIso(now);
  return withTx(db, () => {
    ensureConfigRow(db, outletId, at, actor.id);
    const t = newEntryToken();
    db.prepare('UPDATE valet_outlet_config SET entry_token = ?, updated_at = ?, updated_by = ? WHERE outlet_id = ?').run(t, at, actor.id, outletId);
    logEvent(db, { outlet_id: outletId, event_type: 'entry_token.rotated', actor, at });
    return { entry_token: t };
  });
}

export function zoneSave(db: DB, ov: OutletValet, actor: Actor, input: Record<string, unknown>, now: Date = new Date()) {
  const at = nowIso(now);
  return withTx(db, () => {
    const name = cleanText(input.name, 40);
    if (!name) fail(400, 'name_required', 'Give the zone a name.');
    const kind = (ZONE_KINDS as readonly string[]).includes(String(input.kind)) ? String(input.kind) : 'parking';
    const capRaw = input.capacity === '' || input.capacity === null || input.capacity === undefined ? null : Math.round(Number(input.capacity));
    const capacity = capRaw === null || !Number.isFinite(capRaw) ? null : Math.max(0, Math.min(2000, capRaw));
    const rmRaw = input.retrieval_minutes === '' || input.retrieval_minutes == null ? null : Math.round(Number(input.retrieval_minutes));
    const retrieval = rmRaw === null || !Number.isFinite(rmRaw) ? null : Math.max(1, Math.min(60, rmRaw));
    const active = input.is_active === false ? 0 : 1;
    if (input.id) {
      const z = db.prepare('SELECT id FROM valet_zones WHERE id = ? AND outlet_id = ?').get(String(input.id), ov.outlet_id);
      if (!z) fail(404, 'not_found', 'Zone not found at this outlet.');
      if (!active) {
        const busy = db.prepare(`SELECT COUNT(*) AS n FROM valet_vehicle_sessions WHERE (zone_id = ? OR gate_zone_id = ?) AND state NOT IN ('HANDED_OVER','VOIDED')`).get(String(input.id), String(input.id)) as { n: number };
        if (busy.n) fail(409, 'zone_in_use', `${busy.n} car(s) are still recorded in this zone. Move them first.`);
      }
      db.prepare(`UPDATE valet_zones SET name = ?, kind = ?, capacity = ?, retrieval_minutes = ?, sort_order = ?, is_active = ? WHERE id = ?`)
        .run(name, kind, capacity, retrieval, Math.round(Number(input.sort_order) || 0), active, String(input.id));
      logEvent(db, { outlet_id: ov.outlet_id, event_type: 'zone.updated', actor, at, data: { zone_id: input.id, name, kind, capacity } });
      return { zone_id: String(input.id) };
    }
    const id = newId();
    db.prepare(`INSERT INTO valet_zones (id, outlet_id, name, kind, capacity, retrieval_minutes, sort_order, is_active, created_at, created_by)
                VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, ov.outlet_id, name, kind, capacity, retrieval, Math.round(Number(input.sort_order) || 0), active, at, actor.id);
    logEvent(db, { outlet_id: ov.outlet_id, event_type: 'zone.created', actor, at, data: { zone_id: id, name, kind, capacity } });
    return { zone_id: id };
  });
}

/** Add key tags: one code, or a numbered range ("1"–"60", padded to the width
 *  of the end number). Existing codes are skipped, never duplicated. */
export function tagsAdd(db: DB, ov: OutletValet, actor: Actor, input: { code?: string; from?: unknown; to?: unknown; prefix?: string }, now: Date = new Date()) {
  const at = nowIso(now);
  return withTx(db, () => {
    const codes: string[] = [];
    if (input.code) codes.push(cleanText(input.code, 12));
    else {
      const a = Math.round(Number(input.from)), b = Math.round(Number(input.to));
      if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < a || b - a > 499) fail(400, 'bad_range', 'Give a range of up to 500 tags, e.g. 1 to 60.');
      const width = String(b).length;
      const prefix = cleanText(input.prefix, 4).toUpperCase();
      for (let n = a; n <= b; n++) codes.push(prefix + String(n).padStart(width, '0'));
    }
    let added = 0, skipped = 0;
    for (const c of codes) {
      const norm = normTagCode(c);
      if (!norm) { skipped++; continue; }
      const r = db.prepare(`INSERT OR IGNORE INTO valet_tags (id, outlet_id, code, code_norm, kind, status, created_at, updated_at)
                            VALUES (?,?,?,?, 'key_tag', 'available', ?, ?)`).run(newId(), ov.outlet_id, c, norm, at, at);
      if (r.changes) added++; else skipped++;
    }
    logEvent(db, { outlet_id: ov.outlet_id, event_type: 'tags.added', actor, at, data: { added, skipped } });
    return { added, skipped };
  });
}

/** Disable / mark lost / retire / re-enable a tag. A tag on a car in the
 *  venue's hands cannot be switched off from here — replace it on the car. */
export function tagSetStatus(db: DB, ov: OutletValet, actor: Actor, input: { tag_id?: string; status?: string; reason?: string }, now: Date = new Date()) {
  const at = nowIso(now);
  return withTx(db, () => {
    const t = db.prepare('SELECT id, code, status FROM valet_tags WHERE id = ? AND outlet_id = ?').get(String(input.tag_id || ''), ov.outlet_id) as
      { id: string; code: string; status: string } | undefined;
    if (!t) fail(404, 'not_found', 'Tag not found at this outlet.');
    const st = String(input.status);
    if (!(TAG_STATUSES as readonly string[]).includes(st) || st === 'in_use') fail(400, 'bad_status', 'Choose available, disabled, lost or retired.');
    if (t!.status === 'in_use') fail(409, 'tag_in_use', `Tag ${t!.code} is on a car right now. Use "Replace tag" on that car instead.`);
    db.prepare('UPDATE valet_tags SET status = ?, notes = ?, updated_at = ? WHERE id = ?').run(st, cleanText(input.reason, 200), at, t!.id);
    logEvent(db, { outlet_id: ov.outlet_id, event_type: 'tag.status', actor, at, reason: cleanText(input.reason, 200), data: { tag: t!.code, from: t!.status, to: st } });
    return { ok: true };
  });
}

/** Swap the key tag on a car the venue holds (old tag damaged or lost). The old
 *  tag gets the given status; the handover must then match the NEW tag. */
export function tagReplace(db: DB, ov: OutletValet, actor: Actor, input: { session_id?: string; new_code?: string; old_status?: string; reason?: string }, now: Date = new Date()) {
  const at = nowIso(now);
  return withTx(db, () => {
    const s = getSession(db, input.session_id, ov.outlet_id);
    if (!isHeld(s.state)) fail(409, 'bad_state', 'This car has already left.');
    const why = cleanText(input.reason, 200);
    if (why.length < 5) fail(400, 'reason_required', 'Say why the tag is being replaced.');
    const norm = normTagCode(input.new_code);
    if (!norm) fail(400, 'tag_required', 'Enter the new tag number.');
    let tag = db.prepare('SELECT id, code, status FROM valet_tags WHERE outlet_id = ? AND code_norm = ?').get(ov.outlet_id, norm) as
      { id: string; code: string; status: string } | undefined;
    if (!tag) {
      const id = newId();
      db.prepare(`INSERT INTO valet_tags (id, outlet_id, code, code_norm, kind, status, created_at, updated_at) VALUES (?,?,?,?, 'key_tag', 'available', ?, ?)`)
        .run(id, ov.outlet_id, cleanText(input.new_code, 12), norm, at, at);
      tag = { id, code: cleanText(input.new_code, 12), status: 'available' };
    }
    if (tag.status !== 'available') fail(409, 'tag_unavailable', `Tag ${tag.code} is ${tag.status}.`);
    const oldStatus = ['lost', 'disabled', 'retired', 'available'].includes(String(input.old_status)) ? String(input.old_status) : 'disabled';
    if (s.tag_id) db.prepare('UPDATE valet_tags SET status = ?, replaced_by = ?, updated_at = ? WHERE id = ?').run(oldStatus, tag.id, at, s.tag_id);
    db.prepare(`UPDATE valet_tags SET status = 'in_use', updated_at = ? WHERE id = ?`).run(at, tag.id);
    writeSession(db, s, { tag_id: tag.id, tag_code: tag.code }, at);
    logEvent(db, { outlet_id: ov.outlet_id, session_id: s.id, event_type: 'tag.replaced', actor, reason: why, at, data: { from: s.tag_code, to: tag.code, old_status: oldStatus } });
    return { tag_code: tag.code };
  });
}

/** Admin: which outlets a person may operate for valet. */
export function staffAssign(db: DB, actor: Actor, input: { user_id?: string; outlet_id?: string; assigned?: boolean }, now: Date = new Date()) {
  const at = nowIso(now);
  return withTx(db, () => {
    const u = db.prepare('SELECT id, name FROM users WHERE id = ? AND is_active = 1').get(String(input.user_id || '')) as { id: string; name: string } | undefined;
    if (!u) fail(404, 'not_found', 'User not found.');
    const o = db.prepare('SELECT id FROM outlets WHERE id = ? AND is_active = 1').get(String(input.outlet_id || ''));
    if (!o) fail(404, 'not_found', 'Outlet not found.');
    if (input.assigned) {
      db.prepare('INSERT OR IGNORE INTO valet_staff_outlets (user_id, outlet_id, created_at, created_by) VALUES (?,?,?,?)').run(u!.id, String(input.outlet_id), at, actor.id);
    } else {
      const sh = openShift(db, u!.id);
      if (sh && sh.outlet_id === input.outlet_id) fail(409, 'on_shift', `${u!.name} is on shift there. End the shift first.`);
      db.prepare('DELETE FROM valet_staff_outlets WHERE user_id = ? AND outlet_id = ?').run(u!.id, String(input.outlet_id));
    }
    logEvent(db, { outlet_id: String(input.outlet_id), event_type: input.assigned ? 'staff.assigned' : 'staff.unassigned', actor, at, data: { user_id: u!.id, name: u!.name } });
    return { ok: true };
  });
}

// ── Shift handover between heads ────────────────────────────────────────────

/** Snapshot what the next head inherits: cars held, where every key is, open
 *  incidents and alerts. The next head acknowledges it. */
export function handoverNoteCreate(db: DB, ov: OutletValet, actor: Actor, note: string, now: Date = new Date()) {
  const at = nowIso(now);
  return withTx(db, () => {
    const cars = db.prepare(`SELECT tag_code, state, key_location, key_custodian_name, key_rack, key_hook FROM valet_vehicle_sessions
                             WHERE outlet_id = ? AND state NOT IN ('HANDED_OVER','VOIDED') ORDER BY checked_in_at`).all(ov.outlet_id) as
      { tag_code: string; state: string; key_location: string; key_custodian_name: string; key_rack: string; key_hook: string }[];
    const incidents = (db.prepare(`SELECT COUNT(*) AS n FROM valet_incidents WHERE outlet_id = ? AND status = 'open'`).get(ov.outlet_id) as { n: number }).n;
    const alerts = (db.prepare(`SELECT COUNT(*) AS n FROM valet_alerts WHERE outlet_id = ? AND resolved_at IS NULL`).get(ov.outlet_id) as { n: number }).n;
    const snapshot = {
      cars: cars.map(c => ({ tag: c.tag_code, state: c.state, keys: keyDesc(c.key_location, c.key_custodian_name, c.key_rack, c.key_hook) })),
      keys_with_people: cars.filter(c => c.key_location === 'attendant').length,
      open_incidents: incidents, open_alerts: alerts,
    };
    const id = newId();
    db.prepare(`INSERT INTO valet_handover_notes (id, outlet_id, business_date, from_user_id, from_name, snapshot_json, note, created_at)
                VALUES (?,?,?,?,?,?,?,?)`).run(id, ov.outlet_id, businessDate(now, ov.cfg), actor.id, actor.name, JSON.stringify(snapshot), cleanText(note, 1000), at);
    logEvent(db, { outlet_id: ov.outlet_id, event_type: 'handover_note.created', actor, at, data: { note_id: id, cars: cars.length } });
    return { note_id: id, snapshot };
  });
}

export function handoverNoteAck(db: DB, ov: OutletValet, actor: Actor, noteId: string, now: Date = new Date()) {
  const at = nowIso(now);
  return withTx(db, () => {
    const n = db.prepare('SELECT id, from_user_id, acknowledged_at FROM valet_handover_notes WHERE id = ? AND outlet_id = ?').get(String(noteId || ''), ov.outlet_id) as
      { id: string; from_user_id: string; acknowledged_at: string | null } | undefined;
    if (!n) fail(404, 'not_found', 'Handover note not found.');
    if (n!.from_user_id === actor.id) fail(409, 'self_ack', 'The incoming head must acknowledge the handover, not the outgoing one.');
    if (n!.acknowledged_at) return { ok: true };
    db.prepare('UPDATE valet_handover_notes SET acknowledged_by = ?, acknowledged_name = ?, acknowledged_at = ? WHERE id = ?').run(actor.id, actor.name, at, n!.id);
    logEvent(db, { outlet_id: ov.outlet_id, event_type: 'handover_note.acknowledged', actor, at, data: { note_id: n!.id } });
    return { ok: true };
  });
}

export { logCustody, writeSession };
