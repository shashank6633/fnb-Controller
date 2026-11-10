/**
 * VALET staff command table — THE permission matrix for every staff write.
 *
 * One endpoint (POST /api/valet/command) dispatches here. Each command states
 * the capability it needs; requireStaff() (core.ts) then checks capability +
 * outlet assignment + outlet switched on BEFORE the handler runs, and the
 * handler re-checks anything that depends on the row (e.g. "your own task").
 * Adding a command without a row here is impossible — there is no other route.
 */
import type { SessionUser } from '@/lib/auth';
import { hasValetCap, type ValetNeed } from './caps';
import type { DB, Actor, OutletValet } from './core';
import { fail, getPickup, notify, staffActor, requireStaff } from './core';
import { rateLimit } from './credentials';
import {
  checkinCreate, findPendingByCode, parkStart, parkConfirm, keyTransfer, issueActivationLink, issueClaimCode, expirePending,
} from './ops-arrival';
import {
  requestPickup, cancelPickup, reschedulePickup, ackChange, takeNext, assignPickup, ackHandoff, unassignPickup,
  startFetch, markReady, guestWentInside, guestReturned, relocateStart, holdConfirm, handover, voidSession,
  setPriority, adjustEta,
} from './ops-pickup';
import {
  shiftStart, shiftBreak, shiftEnd, heartbeat, incidentCreate, incidentResolve, alertUpdate, revealContact,
  setOutletEnabled, saveConfig, rotateEntryToken, zoneSave, tagsAdd, tagSetStatus, tagReplace, staffAssign,
  handoverNoteCreate, handoverNoteAck,
} from './ops-admin';
import { addTicketBook, retireTicketBook, confirmPaperClaim } from './ops-paper';
import { linkDining, unlinkDining } from './ops-dining';
import { issueNfcRef, clearNfcRef } from './ops-nfc';
import { registerReader, rotateReaderToken, setReaderEnabled, setTagEpc, simulateRead } from './ops-rfid';
import { enqueue, cancelForSession } from './notify';

// Untyped JSON from the client: every handler validates the fields it reads.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;
interface Ctx { db: DB; ov: OutletValet; actor: Actor; now: Date; body: Body }
type Result = Record<string, unknown> & { session_id?: string | null; pickup_id?: string | null };

interface CommandDef {
  /** One capability, or any one of several (e.g. attendant OR desk). */
  need: ValetNeed | 'admin' | ValetNeed[];
  /** Settings commands work while the outlet is switched off (that is how it is switched on). */
  allowDisabled?: boolean;
  /** Per-user fixed-window limit: [max, seconds]. */
  limit?: [number, number];
  run: (c: Ctx) => Result;
}

const s = (v: unknown) => String(v ?? '');

/** Only the assigned attendant or a head may act on a claimed pickup. */
function ownOrHead(c: Ctx, pickupId: unknown): void {
  const p = getPickup(c.db, pickupId, c.ov.outlet_id);
  if (!c.actor.head && p.assigned_user_id !== c.actor.id) fail(403, 'not_yours', `This car is with ${p.assigned_name || 'another attendant'}.`);
}

export const COMMANDS: Record<string, CommandDef> = {
  // ── shifts
  'shift.start':  { need: 'attendant', run: c => shiftStart(c.db, c.ov, c.actor, c.now) },
  'shift.break':  { need: 'attendant', run: c => shiftBreak(c.db, c.ov, c.actor, !!c.body.on, c.now) },
  'shift.end':    { need: 'attendant', run: c => shiftEnd(c.db, c.ov, c.actor, c.body.user_id ? s(c.body.user_id) : null, s(c.body.note), c.now) },
  'heartbeat':    { need: 'attendant', limit: [20, 60], run: c => { heartbeat(c.db, c.actor, c.now); return {}; } },

  // ── arrival
  'checkin.create': { need: 'attendant', limit: [30, 60], run: c => {
    const r = checkinCreate(c.db, c.ov, c.actor, c.body, c.now);
    return { ...r, session_id: r.session_id };
  } },
  'checkin.find':   { need: ['attendant', 'host'], limit: [30, 60], run: c => { expirePending(c.db, c.now); return { request: findPendingByCode(c.db, c.ov, s(c.body.code), c.now) }; } },
  'park.start':     { need: 'attendant', run: c => ({ ...parkStart(c.db, c.ov, c.actor, s(c.body.session_id), c.body.version, c.now) }) },
  'park.confirm':   { need: 'attendant', run: c => ({ ...parkConfirm(c.db, c.ov, c.actor, s(c.body.session_id), c.body.version, c.body, c.now) }) },
  'key.transfer':   { need: 'attendant', run: c => ({ ...keyTransfer(c.db, c.ov, c.actor, s(c.body.session_id), c.body.version, c.body, c.now), session_id: s(c.body.session_id) }) },
  'pass.link':      { need: 'attendant', limit: [20, 60], run: c => ({ ...issueActivationLink(c.db, c.ov, c.actor, s(c.body.session_id), c.now), session_id: s(c.body.session_id) }) },
  'claim.issue':    { need: 'attendant', limit: [20, 60], run: c => ({ ...issueClaimCode(c.db, c.ov, c.actor, s(c.body.session_id), c.now), session_id: s(c.body.session_id) }) },

  // ── pickups on a guest's behalf (host desk, attendant, head)
  'pickup.request': { need: 'host', limit: [30, 60], run: c => {
    if (c.body.guest_confirmed !== true) fail(400, 'confirm_required', 'Confirm the guest asked for their car before requesting it.');
    const r = requestPickup(c.db, c.ov, c.actor, { session_id: s(c.body.session_id), when: c.body.when, at: c.body.at, idempotency_key: c.body.idempotency_key, note: c.body.note },
      c.actor.attendant || c.actor.head ? 'staff' : 'host', c.now);
    return { pickup_id: r.pickup.id, session_id: r.pickup.session_id, state: r.pickup.state, existing: r.existing };
  } },
  'pickup.cancel': { need: 'host', run: c => {
    const p = getPickup(c.db, c.body.pickup_id, c.ov.outlet_id);
    if (['ASSIGNED', 'IN_PROGRESS', 'READY'].includes(p.state)) {
      // Claimed work is a staff decision: only a head may stop it, and doing so
      // is an acknowledged change that puts the car somewhere safe.
      if (!c.actor.head) fail(403, 'head_only', 'An attendant is already on this car. Ask the Valet Head to stop it.');
      cancelPickup(c.db, c.ov, c.actor, p.id, s(c.body.reason) || 'cancelled by valet head', c.now);
      const fresh = getPickup(c.db, p.id, c.ov.outlet_id);
      return { ...ackChange(c.db, c.ov, c.actor, p.id, fresh.version, { accept: true, return_to: c.body.return_to, note: c.body.reason }, c.now), pickup_id: p.id, session_id: p.session_id };
    }
    return { ...cancelPickup(c.db, c.ov, c.actor, p.id, s(c.body.reason) || 'cancelled by staff', c.now), pickup_id: p.id, session_id: p.session_id };
  } },
  'pickup.reschedule': { need: 'host', run: c => {
    const p = getPickup(c.db, c.body.pickup_id, c.ov.outlet_id);
    return { ...reschedulePickup(c.db, c.ov, c.actor, p.id, c.body.when, c.body.at, c.now), pickup_id: p.id, session_id: p.session_id };
  } },
  'change.ack': { need: 'attendant', run: c => {
    ownOrHead(c, c.body.pickup_id);
    const p = getPickup(c.db, c.body.pickup_id, c.ov.outlet_id);
    return { ...ackChange(c.db, c.ov, c.actor, p.id, c.body.version, c.body, c.now), pickup_id: p.id, session_id: p.session_id };
  } },

  // ── dispatch
  'take_next':       { need: 'attendant', limit: [30, 60], run: c => takeNext(c.db, c.ov, c.actor, c.now) },
  'pickup.assign':   { need: 'head', run: c => {
    const p = getPickup(c.db, c.body.pickup_id, c.ov.outlet_id);
    return { ...assignPickup(c.db, c.ov, c.actor, p.id, c.body.version, s(c.body.user_id), s(c.body.reason), c.now), pickup_id: p.id, session_id: p.session_id };
  } },
  'handoff.ack':     { need: 'attendant', run: c => {
    const p = getPickup(c.db, c.body.pickup_id, c.ov.outlet_id);
    return { ...ackHandoff(c.db, c.ov, c.actor, p.id, c.now), pickup_id: p.id, session_id: p.session_id };
  } },
  'pickup.unassign': { need: 'attendant', run: c => {
    const p = getPickup(c.db, c.body.pickup_id, c.ov.outlet_id);
    return { ...unassignPickup(c.db, c.ov, c.actor, p.id, c.body.version, s(c.body.reason), c.now), pickup_id: p.id, session_id: p.session_id };
  } },
  'fetch.start':     { need: 'attendant', run: c => {
    const p = getPickup(c.db, c.body.pickup_id, c.ov.outlet_id);
    return { ...startFetch(c.db, c.ov, c.actor, p.id, c.body.version, c.now), session_id: p.session_id };
  } },
  'fetch.ready':     { need: 'attendant', run: c => {
    const p = getPickup(c.db, c.body.pickup_id, c.ov.outlet_id);
    return { ...markReady(c.db, c.ov, c.actor, p.id, c.body.version, c.body, c.now), pickup_id: p.id, session_id: p.session_id };
  } },

  // ── gate
  'guest.inside':    { need: 'attendant', run: c => ({ ...guestWentInside(c.db, c.ov, c.actor, s(c.body.session_id), c.now), session_id: s(c.body.session_id) }) },
  'guest.returned':  { need: 'attendant', run: c => {
    const r = guestReturned(c.db, c.ov, c.actor, s(c.body.session_id), c.now);
    return { pickup_id: r.pickup.id, session_id: r.pickup.session_id, existing: r.existing };
  } },
  'relocate.start':  { need: 'attendant', run: c => ({ ...relocateStart(c.db, c.ov, c.actor, s(c.body.session_id), c.body.version, s(c.body.reason), c.now), session_id: s(c.body.session_id) }) },
  'hold.confirm':    { need: 'attendant', run: c => ({ ...holdConfirm(c.db, c.ov, c.actor, s(c.body.session_id), c.body.version, c.body, c.now), session_id: s(c.body.session_id) }) },
  'handover':        { need: 'attendant', limit: [20, 60], run: c => {
    const r = handover(c.db, c.ov, c.actor, s(c.body.session_id), c.body, c.now);
    cancelForSession(c.db, r.session_id, 'car handed over', c.now);   // stop obsolete guest messages
    return r;
  } },

  // ── head controls
  'session.void':    { need: 'head', run: c => {
    const r = voidSession(c.db, c.ov, c.actor, s(c.body.session_id), c.body.version, s(c.body.reason), !!c.body.is_test, c.now);
    cancelForSession(c.db, s(c.body.session_id), 'record voided', c.now);
    return { ...r, session_id: s(c.body.session_id) };
  } },
  'pickup.priority': { need: 'head', run: c => {
    const p = getPickup(c.db, c.body.pickup_id, c.ov.outlet_id);
    return { ...setPriority(c.db, c.ov, c.actor, p.id, c.body.version, c.body.priority, s(c.body.reason), c.now), pickup_id: p.id, session_id: p.session_id };
  } },
  'pickup.eta':      { need: 'head', run: c => {
    const p = getPickup(c.db, c.body.pickup_id, c.ov.outlet_id);
    const r = adjustEta(c.db, c.ov, c.actor, p.id, c.body.version, c.body, c.now);
    // Tell a WhatsApp-linked guest the new range (only when one was set, not on clear).
    if (!c.body.clear) {
      const tag = (c.db.prepare('SELECT tag_code FROM valet_vehicle_sessions WHERE id = ?').get(p.session_id) as { tag_code: string } | undefined)?.tag_code || '';
      enqueue(c.db, { outlet_id: c.ov.outlet_id, session_id: p.session_id, pickup_id: p.id, kind: 'eta_changed',
        dedupe: `eta:${p.id}:${c.now.getTime()}`, params: [tag, `${Math.round(Number(c.body.low_min))}-${Math.round(Number(c.body.high_min))}`] }, c.now);
    }
    return { ...r, pickup_id: p.id, session_id: p.session_id };
  } },
  'incident.create': { need: 'attendant', limit: [20, 60], run: c => ({ ...incidentCreate(c.db, c.ov, c.actor, c.body, c.now), session_id: c.body.session_id ? s(c.body.session_id) : null }) },
  'incident.resolve':{ need: 'head', run: c => incidentResolve(c.db, c.ov, c.actor, c.body, c.now) },
  'alert.ack':       { need: 'head', run: c => alertUpdate(c.db, c.ov, c.actor, s(c.body.alert_id), 'ack', c.now) },
  'alert.resolve':   { need: 'head', run: c => alertUpdate(c.db, c.ov, c.actor, s(c.body.alert_id), 'resolve', c.now) },
  'contact.reveal':  { need: 'head', limit: [20, 300], run: c => revealContact(c.db, c.ov, c.actor, s(c.body.session_id), s(c.body.reason), c.now) },
  'tag.replace':     { need: 'head', run: c => ({ ...tagReplace(c.db, c.ov, c.actor, c.body, c.now), session_id: s(c.body.session_id) }) },
  'handover_note.create': { need: 'head', run: c => handoverNoteCreate(c.db, c.ov, c.actor, s(c.body.note), c.now) },
  'handover_note.ack':    { need: 'head', run: c => handoverNoteAck(c.db, c.ov, c.actor, s(c.body.note_id), c.now) },

  // ── dining links (optional; never moves a car)
  'dining.link':   { need: ['attendant', 'host'], limit: [30, 60], run: c => { const r = linkDining(c.db, c.ov, c.actor, c.body, c.now); return { ...r }; } },
  'dining.unlink': { need: ['attendant', 'host'], run: c => unlinkDining(c.db, c.ov, c.actor, s(c.body.session_id), c.now) },

  // ── paper tickets
  'ticket_book.add':    { need: 'head', allowDisabled: true, run: c => addTicketBook(c.db, c.ov, c.actor, c.body, c.now) },
  'ticket_book.retire': { need: 'head', allowDisabled: true, run: c => retireTicketBook(c.db, c.ov, c.actor, s(c.body.book_id), c.now) },
  'paper.claim_confirm': { need: ['attendant', 'host'], limit: [30, 60], run: c => confirmPaperClaim(c.db, c.ov, c.actor, s(c.body.request_id), c.body.stub_checked === true, c.now) },

  // ── settings
  'settings.enable':       { need: 'admin', allowDisabled: true, run: c => setOutletEnabled(c.db, c.ov.outlet_id, c.actor, !!c.body.enabled, c.now) },
  'settings.config':       { need: 'admin', allowDisabled: true, run: c => saveConfig(c.db, c.ov.outlet_id, c.actor, c.body.config, c.now) },
  'settings.entry_rotate': { need: 'admin', allowDisabled: true, run: c => rotateEntryToken(c.db, c.ov.outlet_id, c.actor, c.now) },
  'staff.assign':          { need: 'admin', allowDisabled: true, run: c => staffAssign(c.db, c.actor, { ...c.body, outlet_id: c.ov.outlet_id }, c.now) },
  'zone.save':             { need: 'head', allowDisabled: true, run: c => zoneSave(c.db, c.ov, c.actor, c.body, c.now) },
  'tags.add':              { need: 'head', allowDisabled: true, run: c => tagsAdd(c.db, c.ov, c.actor, c.body, c.now) },
  'tag.status':            { need: 'head', allowDisabled: true, run: c => tagSetStatus(c.db, c.ov, c.actor, c.body, c.now) },

  // ── NFC key-tag links + RFID (DESIGN.md §6b). Reader tokens and the simulator are the owner's.
  'tag.nfc_issue':         { need: 'head', allowDisabled: true, limit: [120, 60], run: c => issueNfcRef(c.db, c.ov, c.actor, s(c.body.tag_id), c.now) },
  'tag.nfc_clear':         { need: 'head', allowDisabled: true, run: c => clearNfcRef(c.db, c.ov, c.actor, s(c.body.tag_id), c.now) },
  'tag.rfid_epc':          { need: 'head', allowDisabled: true, run: c => setTagEpc(c.db, c.ov, c.actor, c.body, c.now) },
  'rfid.reader_register':  { need: 'admin', allowDisabled: true, run: c => registerReader(c.db, c.ov, c.actor, c.body, c.now) },
  'rfid.reader_rotate':    { need: 'admin', allowDisabled: true, run: c => rotateReaderToken(c.db, c.ov, c.actor, s(c.body.reader_id), c.now) },
  'rfid.reader_enable':    { need: 'admin', allowDisabled: true, run: c => setReaderEnabled(c.db, c.ov, c.actor, s(c.body.reader_id), c.body.enabled === true, c.now) },
  'rfid.simulate':         { need: 'admin', limit: [120, 60], run: c => ({ ...simulateRead(c.db, c.ov, c.actor, c.body, c.now) }) },
};

/** Run one staff command end to end: look up, authorise, rate-limit, execute,
 *  notify live screens. Throws ValetError for every refusal. */
export function runCommand(db: DB, user: SessionUser | null, body: Body, now: Date = new Date()): Result {
  const name = s(body.cmd);
  const def = Object.prototype.hasOwnProperty.call(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!def) fail(400, 'unknown_command', 'Unknown valet action.');
  const need = Array.isArray(def!.need) ? (def!.need.find(n => hasValetCap(user ?? undefined, n)) ?? def!.need[0]) : def!.need;
  const { actor, ov } = requireStaff(db, user, s(body.outlet_id), need, { allowDisabled: def!.allowDisabled });
  if (def!.limit && !rateLimit(db, `cmd:${name}:${actor.id}`, def!.limit[0], def!.limit[1], now)) {
    fail(429, 'slow_down', 'Too many attempts. Wait a minute and try again.');
  }
  const result = def!.run({ db, ov, actor, now, body });
  if (name !== 'heartbeat') notify(ov.outlet_id, name, { session_id: result.session_id ?? null, pickup_id: result.pickup_id ?? null });
  return result;
}

export { staffActor };
