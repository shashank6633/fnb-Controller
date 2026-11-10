/**
 * VALET tap-to-pair cards (owner, 2026-11-10; docs/valet/DESIGN.md §6c).
 *
 * Each attendant carries ONE NFC card holding a public link,
 * /valet-pass?h=<opaque ref>. A guest taps it with their phone (an ordinary OS
 * tap — iPhone and Android, no app) and gets a 2-digit number. The attendant's
 * screen shows the same number with the car they just checked in; only when
 * the attendant confirms does that phone receive the pass.
 *
 * The card is NOT a credential: copying it, or a stranger tapping it, only
 * makes a waiting request that the attendant rejects. The number exists so the
 * attendant gives the pass to the phone in front of them when two people tap
 * at once. Requests expire after a few minutes.
 */
import type { DB, Actor, OutletValet } from './core';
import { fail, logEvent, newId, withTx, loadOutletValet, guestActor, notify } from './core';
import { crockfordCode, rateLimit } from './credentials';
import { nowIso, addMinutes } from './config';

export const HANDOFF_REF_LEN = 12;
export const HANDOFF_TAP_MINUTES = 3;
export const HANDOFF_MAX_PENDING = 3;
export const handoffPath = (ref: string) => `/valet-pass?h=${encodeURIComponent(ref)}`;

interface CardRow { id: string; outlet_id: string; user_id: string; ref: string; created_at: string; revoked_at: string | null }
interface TapRow { id: string; outlet_id: string; card_id: string; user_id: string; device_id: string; number: number; status: string; created_at: string; expires_at: string; session_id: string | null }

function expireTaps(db: DB, now: Date) {
  db.prepare(`UPDATE valet_handoff_taps SET status = 'expired', resolved_at = ? WHERE status = 'pending' AND expires_at <= ?`).run(nowIso(now), nowIso(now));
}

/** Valet staff of this outlet who can carry a card (attendant or head), with their card. */
export function handoffCards(db: DB, outletId: string) {
  const rows = db.prepare(`
    SELECT u.id AS user_id, u.name, COALESCE(r.valet_head, 0) AS valet_head, COALESCE(r.valet_attendant, 0) AS valet_attendant,
           c.id AS card_id, c.ref, c.created_at
    FROM valet_staff_outlets so JOIN users u ON u.id = so.user_id AND u.is_active = 1
    LEFT JOIN roles r ON r.id = u.role_id AND r.is_active = 1
    LEFT JOIN valet_handoff_cards c ON c.user_id = u.id AND c.outlet_id = so.outlet_id AND c.revoked_at IS NULL
    WHERE so.outlet_id = ? AND (COALESCE(r.valet_head, 0) + COALESCE(r.valet_attendant, 0) > 0 OR u.role = 'admin')
    ORDER BY u.name`).all(outletId) as { user_id: string; name: string; card_id: string | null; ref: string | null; created_at: string | null }[];
  return rows.map(r => ({ ...r, path: r.ref ? handoffPath(r.ref) : null }));
}

/** Head: give a staff member a card link (or a new one — the old card stops working). */
export function issueHandoffCard(db: DB, ov: OutletValet, actor: Actor, userId: string, now: Date = new Date()) {
  const at = nowIso(now);
  const staff = handoffCards(db, ov.outlet_id).find(s => s.user_id === userId);
  if (!staff) fail(404, 'not_staff', 'That person is not valet staff at this outlet (Valet Settings → Staff).');
  return withTx(db, () => {
    db.prepare('UPDATE valet_handoff_cards SET revoked_at = ? WHERE outlet_id = ? AND user_id = ? AND revoked_at IS NULL').run(at, ov.outlet_id, userId);
    let ref = '';
    for (let i = 0; i < 10 && !ref; i++) {
      const c = crockfordCode(HANDOFF_REF_LEN);
      if (!db.prepare('SELECT 1 FROM valet_handoff_cards WHERE ref = ?').get(c)) ref = c;
    }
    if (!ref) fail(500, 'ref_exhausted', 'Could not make a new link. Try again.');
    db.prepare('INSERT INTO valet_handoff_cards (id, outlet_id, user_id, ref, created_at, created_by) VALUES (?,?,?,?,?,?)')
      .run(newId(), ov.outlet_id, userId, ref, at, actor.id);
    logEvent(db, { outlet_id: ov.outlet_id, event_type: staff!.ref ? 'handoff.card_reissued' : 'handoff.card_issued', actor, at, data: { staff: staff!.name } });
    return { user_id: userId, ref, path: handoffPath(ref), reissued: !!staff!.ref };
  });
}

export function clearHandoffCard(db: DB, ov: OutletValet, actor: Actor, userId: string, now: Date = new Date()) {
  const at = nowIso(now);
  const r = db.prepare('UPDATE valet_handoff_cards SET revoked_at = ? WHERE outlet_id = ? AND user_id = ? AND revoked_at IS NULL').run(at, ov.outlet_id, userId);
  if (r.changes) logEvent(db, { outlet_id: ov.outlet_id, event_type: 'handoff.card_cleared', actor, at, data: { user_id: userId } });
  return { user_id: userId, cleared: r.changes > 0 };
}

/**
 * Guest phone tapped an attendant's card. Returns the number to show. The same
 * phone tapping again while its request waits gets the same number back.
 */
export function guestTap(db: DB, deviceId: string, ref: string, now: Date = new Date()) {
  const at = nowIso(now);
  const r = String(ref || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  const card = r.length === HANDOFF_REF_LEN
    ? db.prepare('SELECT * FROM valet_handoff_cards WHERE ref = ? AND revoked_at IS NULL').get(r) as CardRow | undefined
    : undefined;
  if (!card) fail(404, 'card_unknown', 'This valet card is not in use. Please ask the valet to show you their QR instead.');
  const ov = loadOutletValet(db, card!.outlet_id);
  if (!ov || !ov.enabled) fail(404, 'not_available', 'Valet is not available right now. Please see the valet desk.');
  const onShift = db.prepare('SELECT 1 FROM valet_shifts WHERE user_id = ? AND outlet_id = ? AND ended_at IS NULL').get(card!.user_id, card!.outlet_id);
  if (!onShift) fail(409, 'off_duty', 'This valet is not on duty right now. Please ask the valet to show you their QR instead.');
  if (!rateLimit(db, `handoff-tap:${deviceId}`, 6, 600, now)) fail(429, 'slow_down', 'Too many taps. Please show the valet your phone.');
  return withTx(db, () => {
    expireTaps(db, now);
    const mine = db.prepare(`SELECT * FROM valet_handoff_taps WHERE card_id = ? AND device_id = ? AND status = 'pending'`).get(card!.id, deviceId) as TapRow | undefined;
    const valetName = (db.prepare('SELECT name FROM users WHERE id = ?').get(card!.user_id) as { name: string } | undefined)?.name.split(' ')[0] || '';
    if (mine) return { number: mine.number, expires_at: mine.expires_at, valet_name: valetName, reused: true };
    const open = db.prepare(`SELECT number FROM valet_handoff_taps WHERE user_id = ? AND status = 'pending'`).all(card!.user_id) as { number: number }[];
    if (open.length >= HANDOFF_MAX_PENDING) fail(429, 'valet_busy', 'The valet has other guests waiting to confirm. Please wait a moment and tap again.');
    let number = 0;
    for (let i = 0; i < 50 && !number; i++) {
      const n = 10 + Math.floor(Math.random() * 90);
      if (!open.some(o => o.number === n)) number = n;
    }
    const expires = addMinutes(now, HANDOFF_TAP_MINUTES);
    db.prepare(`INSERT INTO valet_handoff_taps (id, outlet_id, card_id, user_id, device_id, number, status, created_at, expires_at)
                VALUES (?,?,?,?,?,?, 'pending', ?, ?)`).run(newId(), card!.outlet_id, card!.id, card!.user_id, deviceId, number, at, expires);
    logEvent(db, { outlet_id: card!.outlet_id, event_type: 'handoff.tapped', actor: guestActor(deviceId), at, data: { number } });
    notify(card!.outlet_id, 'handoff.tapped', {});
    return { number, expires_at: expires, valet_name: valetName, reused: false };
  });
}

/** This phone's latest tap (for the guest page), within the last 10 minutes. */
export function deviceTap(db: DB, deviceId: string, now: Date = new Date()) {
  expireTaps(db, now);
  const t = db.prepare(`SELECT t.number, t.status, t.expires_at, t.resolved_at, u.name FROM valet_handoff_taps t LEFT JOIN users u ON u.id = t.user_id
                        WHERE t.device_id = ? AND t.created_at > ? ORDER BY t.created_at DESC LIMIT 1`).get(deviceId, addMinutes(now, -10)) as
    { number: number; status: string; expires_at: string; resolved_at: string | null; name: string | null } | undefined;
  return t ? { number: t.number, status: t.status, expires_at: t.expires_at, valet_name: (t.name || '').split(' ')[0] } : null;
}

/** Waiting taps on this attendant's card + the cars they could be for. */
export function attendantTaps(db: DB, outletId: string, userId: string, now: Date = new Date()) {
  expireTaps(db, now);
  const taps = db.prepare(`SELECT id, number, created_at, expires_at FROM valet_handoff_taps WHERE outlet_id = ? AND user_id = ? AND status = 'pending' ORDER BY created_at`)
    .all(outletId, userId) as { id: string; number: number; created_at: string; expires_at: string }[];
  if (!taps.length) return { taps, cars: [] };
  // The cars this attendant checked in during the last 2 hours, newest first.
  const cars = db.prepare(`SELECT s.id, s.tag_code, s.ticket_no, s.plate, s.make, s.model, s.colour, s.checked_in_at,
                             (SELECT COUNT(*) FROM valet_pass_grants g WHERE g.session_id = s.id AND g.revoked_at IS NULL) AS passes
                           FROM valet_vehicle_sessions s
                           WHERE s.outlet_id = ? AND s.checked_in_by = ? AND s.state NOT IN ('HANDED_OVER','VOIDED') AND s.checked_in_at > ?
                           ORDER BY s.checked_in_at DESC LIMIT 6`).all(outletId, userId, addMinutes(now, -120));
  return { taps, cars };
}

/** Attendant confirms: the phone that showed this number gets the pass for this car. */
export function confirmTap(db: DB, ov: OutletValet, actor: Actor, tapId: string, sessionId: string, now: Date = new Date()) {
  const at = nowIso(now);
  return withTx(db, () => {
    expireTaps(db, now);
    const t = db.prepare('SELECT * FROM valet_handoff_taps WHERE id = ? AND outlet_id = ?').get(String(tapId || ''), ov.outlet_id) as TapRow | undefined;
    if (!t) fail(404, 'not_found', 'That tap was not found.');
    if (t!.user_id !== actor.id && !actor.head && !actor.isAdmin) fail(403, 'not_yours', 'That tap was on another valet\'s card.');
    if (t!.status !== 'pending') fail(409, 'tap_closed', t!.status === 'expired' ? 'That tap timed out. Ask the guest to tap your card again.' : 'That tap was already answered.');
    const s = db.prepare(`SELECT id, state, tag_code FROM valet_vehicle_sessions WHERE id = ? AND outlet_id = ?`).get(String(sessionId || ''), ov.outlet_id) as
      { id: string; state: string; tag_code: string } | undefined;
    if (!s || ['HANDED_OVER', 'VOIDED'].includes(s.state)) fail(409, 'car_closed', 'That car is no longer with the valet team.');
    const r = db.prepare(`UPDATE valet_handoff_taps SET status = 'confirmed', resolved_at = ?, resolved_by = ?, session_id = ? WHERE id = ? AND status = 'pending'`)
      .run(at, actor.id, s!.id, t!.id);
    if (r.changes !== 1) fail(409, 'tap_closed', 'That tap was already answered.');
    if (!db.prepare('SELECT 1 FROM valet_pass_grants WHERE device_id = ? AND session_id = ? AND revoked_at IS NULL').get(t!.device_id, s!.id)) {
      db.prepare(`INSERT INTO valet_pass_grants (id, device_id, session_id, granted_how, created_at) VALUES (?,?,?, 'card_tap_confirmed', ?)`).run(newId(), t!.device_id, s!.id, at);
    }
    logEvent(db, { outlet_id: ov.outlet_id, session_id: s!.id, event_type: 'pass.granted_by_tap', actor, at, data: { number: t!.number } });
    return { session_id: s!.id, tag_code: s!.tag_code };
  });
}

export function rejectTap(db: DB, ov: OutletValet, actor: Actor, tapId: string, now: Date = new Date()) {
  const at = nowIso(now);
  const t = db.prepare('SELECT * FROM valet_handoff_taps WHERE id = ? AND outlet_id = ?').get(String(tapId || ''), ov.outlet_id) as TapRow | undefined;
  if (!t) fail(404, 'not_found', 'That tap was not found.');
  if (t!.user_id !== actor.id && !actor.head && !actor.isAdmin) fail(403, 'not_yours', 'That tap was on another valet\'s card.');
  db.prepare(`UPDATE valet_handoff_taps SET status = 'rejected', resolved_at = ?, resolved_by = ? WHERE id = ? AND status = 'pending'`).run(at, actor.id, t!.id);
  logEvent(db, { outlet_id: ov.outlet_id, event_type: 'handoff.rejected', actor, at, data: { number: t!.number } });
  return { ok: true };
}
