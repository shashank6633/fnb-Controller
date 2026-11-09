/**
 * VALET paper-ticket compatibility (spec §9).
 *
 * THE RULE: a valid ticket-book number alone never establishes ownership or
 * authorises retrieval. Numbers are printed in sequence and can be guessed.
 *   - Curbside registration DONE (a car is held under that ticket): a guest who
 *     types the ticket at the table gets a pending CLAIM; a staff member must
 *     look at the guest's physical stub before the pass is granted.
 *   - Curbside registration SKIPPED (no car under that ticket yet): the guest's
 *     entry is only a pending VERIFICATION request; staff confirm the issued
 *     stub (and the car) before anything is dispatched — the ordinary check-in.
 * Duplicate active use is refused at the storage layer (uq_valet_active_ticket)
 * and here (one pending request per ticket).
 */
import type { DB, Actor, OutletValet } from './core';
import { fail, newId, logEvent, withTx } from './core';
import { nowIso, addMinutes, cleanText, normPlate } from './config';
import { digits } from './credentials';

/** Split "A123" / "a-0123" into prefix + number. */
export function parseTicket(raw: unknown): { prefix: string; no: number; text: string } | null {
  const t = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = /^([A-Z]{0,3})(\d{1,7})$/.exec(t);
  if (!m) return null;
  return { prefix: m[1], no: Number(m[2]), text: `${m[1]}${Number(m[2])}` };
}

export function addTicketBook(db: DB, ov: OutletValet, actor: Actor, input: { prefix?: string; first_no?: unknown; last_no?: unknown; note?: string }, now: Date = new Date()) {
  const at = nowIso(now);
  const prefix = String(input.prefix || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
  const a = Math.round(Number(input.first_no)), b = Math.round(Number(input.last_no));
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < a || b - a > 9999) fail(400, 'bad_range', 'Give the first and last ticket numbers of the book (up to 10,000).');
  return withTx(db, () => {
    const overlap = db.prepare(`SELECT 1 FROM valet_ticket_books WHERE outlet_id = ? AND prefix = ? AND status = 'active' AND NOT (last_no < ? OR first_no > ?)`)
      .get(ov.outlet_id, prefix, a, b);
    if (overlap) fail(409, 'overlap', 'These numbers overlap a book that is already in use.');
    const id = newId();
    db.prepare(`INSERT INTO valet_ticket_books (id, outlet_id, prefix, first_no, last_no, status, issued_at, issued_by, note) VALUES (?,?,?,?,?, 'active', ?,?,?)`)
      .run(id, ov.outlet_id, prefix, a, b, at, actor.id, cleanText(input.note, 120));
    logEvent(db, { outlet_id: ov.outlet_id, event_type: 'ticket_book.added', actor, at, data: { prefix, first_no: a, last_no: b } });
    return { book_id: id };
  });
}

export function retireTicketBook(db: DB, ov: OutletValet, actor: Actor, bookId: string, now: Date = new Date()) {
  const at = nowIso(now);
  const r = db.prepare(`UPDATE valet_ticket_books SET status = 'retired' WHERE id = ? AND outlet_id = ? AND status = 'active'`).run(String(bookId || ''), ov.outlet_id);
  if (!r.changes) fail(404, 'not_found', 'Book not found or already retired.');
  logEvent(db, { outlet_id: ov.outlet_id, event_type: 'ticket_book.retired', actor, at, data: { book_id: bookId } });
  return { ok: true };
}

/** Is this ticket from an active book of this outlet? Returns the canonical text. */
export function validateTicket(db: DB, outletId: string, raw: unknown): string {
  const t = parseTicket(raw);
  if (!t) fail(400, 'bad_ticket', 'That does not look like a valet ticket number.');
  const book = db.prepare(`SELECT 1 FROM valet_ticket_books WHERE outlet_id = ? AND prefix = ? AND status = 'active' AND ? BETWEEN first_no AND last_no`)
    .get(outletId, t!.prefix, t!.no);
  if (!book) fail(404, 'ticket_unknown', 'That ticket is not from a ticket book issued at this outlet.');
  return t!.text;
}

/**
 * Guest typed a paper ticket at the table / bill folder. Never grants a pass by
 * itself: it creates a pending request that staff resolve by checking the stub.
 */
export function guestPaperEntry(
  db: DB, ov: OutletValet, deviceId: string, input: { ticket_no?: string; plate?: string },
  now: Date = new Date(),
) {
  const at = nowIso(now);
  if (!ov.cfg.paper.enabled) fail(409, 'paper_off', 'Paper tickets are not used at this venue.');
  const ticket = validateTicket(db, ov.outlet_id, input.ticket_no);
  const plate = cleanText(input.plate, 16).toUpperCase();
  return withTx(db, () => {
    const mine = db.prepare(`SELECT id, pairing_code, expires_at, source FROM valet_checkin_requests WHERE outlet_id = ? AND device_id = ? AND ticket_no = ?
                             AND status = 'pending' AND expires_at > ?`).get(ov.outlet_id, deviceId, ticket, at) as
      { id: string; pairing_code: string; expires_at: string; source: string } | undefined;
    if (mine) return { pairing_code: mine.pairing_code, expires_at: mine.expires_at, kind: mine.source, reused: true };
    const other = db.prepare(`SELECT 1 FROM valet_checkin_requests WHERE outlet_id = ? AND ticket_no = ? AND status = 'pending' AND expires_at > ?`).get(ov.outlet_id, ticket, at);
    if (other) fail(409, 'ticket_pending', 'This ticket is already waiting for the valet team. Please show your stub at the valet desk.');
    const held = db.prepare(`SELECT id FROM valet_vehicle_sessions WHERE outlet_id = ? AND ticket_no = ? AND state NOT IN ('HANDED_OVER','VOIDED')`).get(ov.outlet_id, ticket) as { id: string } | undefined;
    let code = '';
    for (let i = 0; i < 20 && !code; i++) {
      const c = digits(6);
      if (!db.prepare(`SELECT 1 FROM valet_checkin_requests WHERE outlet_id = ? AND pairing_code = ? AND status = 'pending'`).get(ov.outlet_id, c)) code = c;
    }
    const id = newId();
    const expires = addMinutes(now, ov.cfg.pending_checkin_minutes);
    db.prepare(`INSERT INTO valet_checkin_requests (id, outlet_id, source, pairing_code, device_id, plate, plate_norm, ticket_no, status, created_at, expires_at, session_id)
                VALUES (?,?,?,?,?,?,?,?, 'pending', ?, ?, ?)`).run(
      id, ov.outlet_id, held ? 'paper_claim' : 'paper', code, deviceId, plate, normPlate(plate), ticket, at, expires, held?.id ?? null);
    return { pairing_code: code, expires_at: expires, kind: held ? 'paper_claim' : 'paper', reused: false };
  });
}

/** Staff checked the guest's PHYSICAL STUB for a car already held under that
 *  ticket: grant this guest's browser the pass. (For a car not yet registered,
 *  staff use the normal check-in with the request instead.) */
export function confirmPaperClaim(db: DB, ov: OutletValet, actor: Actor, requestId: string, stubChecked: boolean, now: Date = new Date()) {
  const at = nowIso(now);
  if (!stubChecked) fail(400, 'stub_required', 'Look at the guest\'s paper stub and tick that it matches before giving the pass.');
  return withTx(db, () => {
    const r = db.prepare(`SELECT * FROM valet_checkin_requests WHERE id = ? AND outlet_id = ?`).get(String(requestId || ''), ov.outlet_id) as
      { id: string; source: string; status: string; expires_at: string; device_id: string | null; session_id: string | null; ticket_no: string } | undefined;
    if (!r) fail(404, 'not_found', 'Request not found at this outlet.');
    if (r!.source !== 'paper_claim') fail(409, 'not_claim', 'This is not a paper claim. Use check-in.');
    if (r!.status !== 'pending' || r!.expires_at <= at) fail(409, 'closed', 'This request is no longer waiting.');
    const s = db.prepare(`SELECT id, state, ticket_no FROM valet_vehicle_sessions WHERE id = ?`).get(r!.session_id) as { id: string; state: string; ticket_no: string } | undefined;
    if (!s || ['HANDED_OVER', 'VOIDED'].includes(s.state) || s.ticket_no !== r!.ticket_no) fail(409, 'changed', 'That car is no longer held under this ticket.');
    db.prepare(`UPDATE valet_checkin_requests SET status = 'confirmed', resolved_at = ?, resolved_by = ? WHERE id = ?`).run(at, actor.id, r!.id);
    if (r!.device_id && !db.prepare('SELECT 1 FROM valet_pass_grants WHERE device_id = ? AND session_id = ? AND revoked_at IS NULL').get(r!.device_id, s!.id)) {
      db.prepare(`INSERT INTO valet_pass_grants (id, device_id, session_id, granted_how, created_at) VALUES (?,?,?, 'paper_stub_checked', ?)`).run(newId(), r!.device_id, s!.id, at);
    }
    logEvent(db, { outlet_id: ov.outlet_id, session_id: s!.id, event_type: 'paper.claim_confirmed', actor, at, data: { ticket: r!.ticket_no } });
    return { session_id: s!.id };
  });
}
