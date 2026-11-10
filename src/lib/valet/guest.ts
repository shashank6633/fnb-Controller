/**
 * VALET guest layer — the ONLY code reachable without a staff session.
 * proxy.ts lets exactly /valet-pass and three /api/valet-guest/* paths through;
 * everything they can do is decided here.
 *
 * AUTH: an httpOnly `fnb_vp` cookie (32 random bytes; SHA-256 in the table).
 *   A device sees ONLY sessions it holds an unrevoked grant for. Grants come
 *   from (a) an attendant confirming the device's own pairing code, or (b) a
 *   single-use activation link an attendant showed. Nothing else — a tag
 *   number, a plate or a ticket number never grants anything.
 * CSRF: SameSite=Lax cookie + every write must carry `x-valet-guest: 1` (a
 *   custom header a cross-site form cannot send without a CORS preflight this
 *   server never answers) + a same-origin Origin / Sec-Fetch-Site when present.
 * LIMITS: per-IP and per-device database counters on every write.
 * LOGS: tokens and contact details are never logged.
 */
import type { DB, Actor, OutletValet, SessionRow, PickupRow } from './core';
import { fail, guestActor, loadOutletValet, activePickup, notify, withTx, newId, logEvent, getSession } from './core';
import { DEVICE_COOKIE, sha256, randomToken, rateLimit } from './credentials';
import { nowIso, addMinutes, maskPlate, nextClose, cleanText, withinServiceHours } from './config';
import { isHeld } from './states';
import { etaFor, promoteDue } from './queue';
import { createPendingCheckin, expirePending } from './ops-arrival';
import { guestPaperEntry } from './ops-paper';
import { guestTap, deviceTap } from './ops-handoff';
import {
  requestPickup, cancelPickup, reschedulePickup, guestOutside, issueHandoverCode, raiseAlert,
} from './ops-pickup';
import { startLink, linkState } from './notify';
import { buildWaMeLink } from '@/lib/whatsapp';

export interface GuestDevice { id: string; lang: string }

export const COOKIE_MAX_AGE = 60 * 60 * 24 * 2;   // 2 days; a session rarely outlives a night

export function deviceFromCookie(db: DB, token: string | undefined | null): GuestDevice | null {
  if (!token || token.length < 20 || token.length > 100) return null;
  const row = db.prepare('SELECT id, lang FROM valet_guest_devices WHERE token_hash = ? AND revoked_at IS NULL').get(sha256(token)) as GuestDevice | undefined;
  return row ?? null;
}

function createDevice(db: DB, now: Date): { device: GuestDevice; token: string } {
  const token = randomToken(32);
  const id = newId();
  db.prepare('INSERT INTO valet_guest_devices (id, token_hash, created_at, last_seen_at) VALUES (?,?,?,?)').run(id, sha256(token), nowIso(now), nowIso(now));
  return { device: { id, lang: '' }, token };
}

/** Set-Cookie value for a new device token. Secure when served over HTTPS. */
export function deviceCookieHeader(token: string, secure: boolean): string {
  return `${DEVICE_COOKIE}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** The CSRF guard for cookie-authenticated guest writes. */
export function guardGuestWrite(req: Request): void {
  if (req.headers.get('x-valet-guest') !== '1') fail(403, 'csrf', 'Please reload the page.');
  const url = new URL(req.url);
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || url.host;
  const origin = req.headers.get('origin');
  if (origin) {
    let oh = '';
    try { oh = new URL(origin).host; } catch { oh = ''; }
    if (oh !== host) fail(403, 'csrf', 'Please reload the page.');
  }
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') fail(403, 'csrf', 'Please reload the page.');
}

/** The device's sessions, newest first. Only unrevoked grants on cars the venue still holds. */
function grantedSessions(db: DB, deviceId: string): SessionRow[] {
  return db.prepare(`SELECT s.* FROM valet_pass_grants g JOIN valet_vehicle_sessions s ON s.id = g.session_id
                     WHERE g.device_id = ? AND g.revoked_at IS NULL AND s.state NOT IN ('HANDED_OVER','VOIDED')
                     ORDER BY s.checked_in_at DESC`).all(deviceId) as SessionRow[];
}
function requireGrant(db: DB, deviceId: string, sessionId: unknown): SessionRow {
  const s = db.prepare(`SELECT s.* FROM valet_pass_grants g JOIN valet_vehicle_sessions s ON s.id = g.session_id
                        WHERE g.device_id = ? AND g.session_id = ? AND g.revoked_at IS NULL`).get(deviceId, String(sessionId || '')) as SessionRow | undefined;
  // Same answer for "not yours" and "does not exist" — no enumeration oracle.
  if (!s || !isHeld(s.state)) fail(404, 'no_pass', 'This pass is no longer active on this phone.');
  return s!;
}

/** Later-time choices within service hours and the outlet's window. */
export function laterSlots(ov: OutletValet, now: Date): string[] {
  const p = ov.cfg.pickup;
  if (!p.later) return [];
  const step = p.later_step_minutes;
  const first = Math.ceil((now.getTime() + 15 * 60_000) / (step * 60_000)) * step * 60_000;
  const last = Math.min(now.getTime() + p.later_max_minutes * 60_000, nextClose(now, ov.cfg).getTime());
  const out: string[] = [];
  // Offer only times resolveTarget() accepts: inside service hours (so none
  // after closing — when a car is still held past close, and not the closing
  // minute itself, which counts as closed).
  for (let t = first; t <= last && out.length < 48; t += step * 60_000) {
    if (withinServiceHours(new Date(t), ov.cfg)) out.push(new Date(t).toISOString());
  }
  return out;
}

function passView(db: DB, ov: OutletValet, s: SessionRow, now: Date) {
  const p: PickupRow | null = activePickup(db, s.id);
  const eta = p ? etaFor(db, p, s.zone_id, s.state, ov.cfg, now) : null;
  // Queue position only when it means something: a waiting request with others ahead.
  const showPosition = !!eta && p?.state === 'QUEUED' && (eta.ahead ?? 0) >= 1;
  const declined = p?.change_ack_at && p.outcome_note.startsWith('change declined');
  return {
    session_id: s.id,
    venue_name: ov.cfg.venue_name || ov.outlet_name,
    tag_code: s.tag_code || s.ticket_no,
    is_ticket: !s.tag_code && !!s.ticket_no,   // label it "Ticket", not "Tag"
    plate_masked: maskPlate(s.plate),
    vehicle: [s.colour, s.make, s.model].filter(Boolean).join(' '),
    state: s.state,
    gate: ov.cfg.pickup_gate_label,
    dwell_deadline_at: s.state === 'READY_AT_GATE' ? s.dwell_deadline_at : null,
    pickup: p ? {
      id: p.id, state: p.state, requested_at: p.requested_at, target_at: p.target_at,
      scheduled: p.release_at > p.requested_at, guest_outside: !!p.guest_outside_at,
      change_pending: !!p.change_request && !p.change_ack_at, change_declined: !!declined,
      can_change: p.state === 'SCHEDULED' || p.state === 'QUEUED',
      eta: eta ? { low_min: eta.low_min, high_min: eta.high_min, basis: eta.basis, note: eta.note,
        ahead: showPosition ? eta.ahead : null } : null,
    } : null,
    can_request: !p && ['CHECKED_IN', 'PARKING', 'PARKED', 'HOLDING_NEAR_GATE', 'RELOCATING'].includes(s.state),
    can_show_code: s.state === 'READY_AT_GATE' || (!!p && ['ASSIGNED', 'IN_PROGRESS', 'READY'].includes(p.state)),
    options: { now: ov.cfg.pickup.now, in5: ov.cfg.pickup.in5, in10: ov.cfg.pickup.in10, later: laterSlots(ov, now) },
    // WhatsApp updates are offered only when the venue has set its number; the
    // guest's own number is never shown or stored here.
    wa: { available: !!ov.cfg.notifications.whatsapp_number, ...linkState(db, s.id) },
  };
}

/** GET /api/valet-guest/state — this browser's own passes and pending check-in. */
export function guestState(db: DB, device: GuestDevice | null, now: Date = new Date()) {
  if (!device) return { passes: [], pending: null, tap: null, lang: '' };
  db.prepare('UPDATE valet_guest_devices SET last_seen_at = ? WHERE id = ?').run(nowIso(now), device.id);
  expirePending(db, now);
  const passes = [];
  const seenOutlets = new Set<string>();
  for (const s of grantedSessions(db, device.id)) {
    const ov = loadOutletValet(db, s.outlet_id);
    if (!ov) continue;
    if (!seenOutlets.has(ov.outlet_id)) { promoteDue(db, ov.outlet_id, now); seenOutlets.add(ov.outlet_id); }
    passes.push({ ...passView(db, ov, s, now), help_phone: ov.cfg.help_phone });
  }
  const pend = db.prepare(`SELECT r.id, r.pairing_code, r.expires_at, r.status, r.outlet_id, r.source FROM valet_checkin_requests r
                           WHERE r.device_id = ? AND r.status IN ('pending','expired') ORDER BY r.created_at DESC LIMIT 1`).get(device.id) as
    { id: string; pairing_code: string; expires_at: string; status: string; outlet_id: string; source: string } | undefined;
  let pending = null;
  if (pend && (pend.status === 'pending' || pend.expires_at > addMinutes(now, -10))) {
    const ov = loadOutletValet(db, pend.outlet_id);
    pending = { pairing_code: pend.status === 'pending' ? pend.pairing_code : '', expires_at: pend.expires_at, status: pend.status, kind: pend.source,
      venue_name: ov ? (ov.cfg.venue_name || ov.outlet_name) : '' };
  }
  return { passes, pending, tap: deviceTap(db, device.id, now), lang: device.lang };
}

/** GET /api/valet-guest/entry?e= — what the check-in page needs to render. */
export function guestEntry(db: DB, entryToken: string) {
  const ov = outletByEntry(db, entryToken);
  if (!ov) return { ok: false as const };
  return { ok: true as const, venue_name: ov.cfg.venue_name || ov.outlet_name, enabled: ov.enabled, required: ov.cfg.required, language: ov.cfg.language, paper: ov.cfg.paper.enabled };
}

function outletByEntry(db: DB, token: string): OutletValet | null {
  const t = String(token || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (t.length < 12) return null;
  const row = db.prepare('SELECT outlet_id FROM valet_outlet_config WHERE entry_token = ?').get(t) as { outlet_id: string } | undefined;
  return row ? loadOutletValet(db, row.outlet_id) : null;
}

export interface ActResult { body: Record<string, unknown>; setCookie?: string }

/** POST /api/valet-guest/act — every guest write. */
export function guestAct(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON; each command validates what it reads
  db: DB, device: GuestDevice | null, body: Record<string, any>, ip: string, secure: boolean, now: Date = new Date(),
): ActResult {
  const cmd = String(body.cmd || '');
  if (!rateLimit(db, `guest-ip:${ip}`, 120, 600, now)) fail(429, 'slow_down', 'Too many requests. Please wait a few minutes.');

  if (cmd === 'checkin' || cmd === 'activate' || cmd === 'paper' || cmd === 'tap') {
    if (!rateLimit(db, `guest-${cmd}-ip:${ip}`, cmd === 'checkin' ? 10 : 20, 600, now)) fail(429, 'slow_down', 'Too many attempts. Please ask the valet desk.');
    let setCookie: string | undefined;
    let dev = device;
    const ensure = () => {
      if (!dev) {
        const made = createDevice(db, now);
        dev = made.device;
        setCookie = deviceCookieHeader(made.token, secure);
      }
      return dev!;
    };
    if (cmd === 'tap') {
      // Tapped an attendant's card (DESIGN.md §6c): only a waiting request —
      // the pass comes when the attendant confirms the number shown here.
      const r = guestTap(db, ensure().id, String(body.h || ''), now);
      return { body: { ok: true, number: r.number, expires_at: r.expires_at, valet_name: r.valet_name }, setCookie };
    }
    if (cmd === 'paper') {
      const ov = outletByEntry(db, body.e);
      if (!ov || !ov.enabled) fail(404, 'not_available', 'Valet is not available right now. Please see the valet desk.');
      const d = ensure();
      const r = guestPaperEntry(db, ov!, d.id, body, now);
      return { body: { ok: true, pairing_code: r.pairing_code, expires_at: r.expires_at, kind: r.kind }, setCookie };
    }
    if (cmd === 'checkin') {
      const ov = outletByEntry(db, body.e);
      if (!ov || !ov.enabled) fail(404, 'not_available', 'Valet check-in is not available right now. Please see the valet desk.');
      const d = ensure();
      const r = createPendingCheckin(db, ov!, d.id, body, now);
      return { body: { ok: true, pairing_code: r.pairing_code, expires_at: r.expires_at }, setCookie };
    }
    // activate: a single-use link an attendant showed. Same answer for a wrong,
    // used or expired token (no oracle).
    const token = String(body.a || '');
    const link = token.length >= 20 && token.length <= 64
      ? db.prepare(`SELECT id, session_id, expires_at, consumed_at FROM valet_activation_links WHERE token_hash = ?`).get(sha256(token)) as
        { id: string; session_id: string; expires_at: string; consumed_at: string | null } | undefined
      : undefined;
    const at = nowIso(now);
    if (!link || link.consumed_at || link.expires_at <= at) fail(410, 'link_used', 'This link has expired or was already used. Ask the valet for a new one.');
    const s = db.prepare('SELECT id, outlet_id, state FROM valet_vehicle_sessions WHERE id = ?').get(link!.session_id) as { id: string; outlet_id: string; state: string } | undefined;
    if (!s || !isHeld(s.state)) fail(410, 'link_used', 'This link has expired or was already used. Ask the valet for a new one.');
    const d = ensure();
    withTx(db, () => {
      const r = db.prepare('UPDATE valet_activation_links SET consumed_at = ?, device_id = ? WHERE id = ? AND consumed_at IS NULL').run(at, d.id, link!.id);
      if (r.changes !== 1) fail(410, 'link_used', 'This link has expired or was already used. Ask the valet for a new one.');
      const has = db.prepare('SELECT 1 FROM valet_pass_grants WHERE device_id = ? AND session_id = ? AND revoked_at IS NULL').get(d.id, s!.id);
      if (!has) db.prepare(`INSERT INTO valet_pass_grants (id, device_id, session_id, granted_how, created_at) VALUES (?,?,?, 'activation_link', ?)`).run(newId(), d.id, s!.id, at);
      logEvent(db, { outlet_id: s!.outlet_id, session_id: s!.id, event_type: 'pass.activated', actor: guestActor(d.id), at });
    });
    notify(s!.outlet_id, 'pass.activated', { session_id: s!.id });
    return { body: { ok: true, session_id: s!.id }, setCookie };
  }

  if (!device) fail(401, 'no_pass', 'No valet pass on this phone.');
  const dev = device!;
  if (!rateLimit(db, `guest-dev:${dev.id}`, 40, 60, now)) fail(429, 'slow_down', 'Too many taps. Please wait a moment.');
  const actor: Actor = guestActor(dev.id);

  if (cmd === 'lang') {
    const lang = body.lang === 'hi' ? 'hi' : 'en';
    db.prepare('UPDATE valet_guest_devices SET lang = ? WHERE id = ?').run(lang, dev.id);
    return { body: { ok: true, lang } };
  }

  const s = requireGrant(db, dev.id, body.session_id);
  const ov = loadOutletValet(db, s.outlet_id);
  if (!ov) fail(404, 'no_pass', 'This pass is no longer active on this phone.');
  const o = ov!;
  const done = (kind: string, extra: Record<string, unknown> = {}, pickupId: string | null = null): ActResult => {
    notify(o.outlet_id, `guest.${kind}`, { session_id: s.id, pickup_id: pickupId });
    return { body: { ok: true, ...extra } };
  };

  switch (cmd) {
    case 'pickup': {
      if (!o.enabled) fail(409, 'valet_off', 'Please ask the valet desk for your car.');
      const r = requestPickup(db, o, actor, { session_id: s.id, when: body.when, at: body.at, idempotency_key: body.idempotency_key }, 'guest', now);
      return done('pickup', { pickup_id: r.pickup.id, state: r.pickup.state, existing: r.existing }, r.pickup.id);
    }
    case 'cancel': {
      const p = activePickup(db, s.id);
      if (!p) return { body: { ok: true, state: 'none' } };
      const r = cancelPickup(db, o, actor, p.id, 'cancelled by guest', now);
      return done('cancel', r, p.id);
    }
    case 'reschedule': {
      const p = activePickup(db, s.id);
      if (!p) fail(409, 'no_pickup', 'There is no request to change.');
      const r = reschedulePickup(db, o, actor, p!.id, body.when, body.at, now);
      return done('reschedule', r, p!.id);
    }
    case 'outside': {
      guestOutside(db, o, actor, s.id, now);
      return done('outside');
    }
    case 'help': {
      if (!rateLimit(db, `guest-help:${dev.id}`, 3, 600, now)) return { body: { ok: true, already: true } };
      withTx(db, () => {
        raiseAlert(db, o.outlet_id, s.id, null, 'help', `Guest asked for help${body.message ? ': ' + cleanText(body.message, 140) : ''}`, `help:${s.id}`, nowIso(now));
        logEvent(db, { outlet_id: o.outlet_id, session_id: s.id, event_type: 'guest.help', actor, at: nowIso(now) });
      });
      return done('help', { help_phone: o.cfg.help_phone });
    }
    case 'wa_link': {
      if (!o.cfg.notifications.whatsapp_number) fail(409, 'not_available', 'WhatsApp updates are not set up at this venue.');
      if (!rateLimit(db, `guest-walink:${dev.id}`, 6, 600, now)) fail(429, 'slow_down', 'Please wait a moment.');
      const r = startLink(db, o, s.id, now);
      if (r.linked) return { body: { ok: true, linked: true } };
      return { body: { ok: true, linked: false, code: r.code, expires_at: r.expires_at,
        link: buildWaMeLink(o.cfg.notifications.whatsapp_number, `VALET ${r.code}`) } };
    }
    case 'code': {
      const v = passView(db, o, getSession(db, s.id, o.outlet_id), now);
      if (!v.can_show_code) fail(409, 'not_yet', 'Your code appears once your car is on its way.');
      if (!rateLimit(db, `guest-code:${dev.id}:${s.id}`, 8, 60, now)) fail(429, 'slow_down', 'Please wait a moment for a new code.');
      const c = issueHandoverCode(db, s.id, now);
      return { body: { ok: true, code: c.code, expires_at: c.expires_at } };
    }
    default:
      fail(400, 'unknown', 'Unknown action.');
  }
}
