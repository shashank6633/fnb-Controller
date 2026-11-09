/**
 * VALET guest notifications — outbox, verified identities, WhatsApp adapter,
 * and the clearly-labelled SIMULATOR (spec §8). docs/valet/NOTIFICATIONS.md.
 *
 * In-app updates never depend on this file: the guest pass polls and staff
 * screens stream. This is the optional second channel.
 *
 * FOUR RULES:
 *   1. VERIFIED IDENTITY ONLY. A message goes only to a number that WhatsApp told
 *      us messaged the venue carrying the pass's link code ("VALET 4F7K2Q").
 *      A typed number is never used. Opt-out ("STOP") ends it.
 *   2. HONEST STATUS. 'sent' = the provider accepted the request; 'delivered' /
 *      'read' / 'failed' come ONLY from the provider's signed webhook.
 *   3. NEVER FAKE A LIVE INTEGRATION. When the venue has not switched real
 *      sending on, WhatsApp is not configured, the template is not named, or the
 *      process is not production (unless VALET_ALLOW_DEV_SEND=1), a message is
 *      recorded as 'simulated' — "nothing was sent" — never as 'sent'.
 *   4. OBSOLETE MESSAGES STOP. A queued "your car is ready" for a car already
 *      handed over is cancelled, not delivered late.
 */
import type { DB, OutletValet } from './core';
import { newId, loadOutletValet, logEvent, SYSTEM, activePickup, withTx } from './core';
import { nowIso, addMinutes, type NotifyKind } from './config';
import { crockfordCode, sha256 } from './credentials';
import { isHeld } from './states';
import { raiseAlert, requestPickup } from './ops-pickup';
import { sendWhatsAppTemplate, isWaConfigured } from '@/lib/whatsapp';

const MAX_ATTEMPTS = 3;
const BACKOFF_MIN = [1, 5, 15];
const LINK_MINUTES = 30;

export type SendFn = typeof sendWhatsAppTemplate;

/** Whether this process may send for real at all. */
export function realSendAllowed(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.VALET_ALLOW_DEV_SEND === '1';
}

/** Why a message to this outlet would be simulated ('' = it would really send). */
export function simulationReason(ov: OutletValet, kind: NotifyKind): string {
  if (!ov.cfg.notifications.whatsapp) return 'Real WhatsApp sending is switched off for this outlet (Valet Settings).';
  if (!realSendAllowed()) return 'This is not the live server — messages are only simulated here.';
  let configured = false;
  try { configured = isWaConfigured(); } catch { configured = false; }
  if (!configured) return 'WhatsApp is not configured (Settings → Integrations → WhatsApp).';
  if (!ov.cfg.notifications.templates[kind]?.name) return `No approved template is named for "${kind}" (Valet Settings → Notifications).`;
  return '';
}

// ── identities ──────────────────────────────────────────────────────────────

/** Guest asked for WhatsApp updates: a link code to send FROM their phone.
 *  Re-asking returns the same unexpired code. */
export function startLink(db: DB, ov: OutletValet, sessionId: string, now: Date = new Date()) {
  const at = nowIso(now);
  return withTx(db, () => {
    const live = db.prepare(`SELECT link_code, link_expires_at FROM valet_msg_identities WHERE session_id = ? AND verified_at IS NULL AND link_expires_at > ?`)
      .get(sessionId, at) as { link_code: string; link_expires_at: string } | undefined;
    const verified = db.prepare(`SELECT 1 FROM valet_msg_identities WHERE session_id = ? AND verified_at IS NOT NULL AND opted_out_at IS NULL`).get(sessionId);
    if (verified) return { linked: true as const, code: '', expires_at: '' };
    if (live) return { linked: false as const, code: live.link_code, expires_at: live.link_expires_at };
    let code = '';
    for (let i = 0; i < 10 && !code; i++) {
      const c = crockfordCode(6);
      if (!db.prepare(`SELECT 1 FROM valet_msg_identities WHERE outlet_id = ? AND link_code = ? AND verified_at IS NULL`).get(ov.outlet_id, c)) code = c;
    }
    const expires = addMinutes(now, LINK_MINUTES);
    db.prepare(`INSERT INTO valet_msg_identities (id, outlet_id, session_id, link_code, link_expires_at, created_at) VALUES (?,?,?,?,?,?)`)
      .run(newId(), ov.outlet_id, sessionId, code, expires, at);
    return { linked: false as const, code, expires_at: expires };
  });
}

function activeIdentity(db: DB, sessionId: string): { id: string; phone: string } | null {
  return (db.prepare(`SELECT id, phone FROM valet_msg_identities WHERE session_id = ? AND verified_at IS NOT NULL
                      AND consent_at IS NOT NULL AND opted_out_at IS NULL ORDER BY verified_at DESC LIMIT 1`).get(sessionId) as { id: string; phone: string }) || null;
}

// ── outbox ──────────────────────────────────────────────────────────────────

/** Queue a guest message, if the guest has a verified, consenting identity.
 *  dedupe makes a repeat (another tick, another worker) a no-op. */
export function enqueue(
  db: DB, input: { outlet_id: string; session_id: string; pickup_id?: string | null; kind: NotifyKind; dedupe: string; params: (string | number)[] },
  now: Date = new Date(),
): boolean {
  const ident = activeIdentity(db, input.session_id);
  if (!ident) return false;
  const at = nowIso(now);
  const r = db.prepare(`INSERT OR IGNORE INTO valet_notifications (id, outlet_id, session_id, pickup_id, identity_id, channel, kind, dedupe_key,
                          params_json, status, next_attempt_at, created_at, updated_at)
                        VALUES (?,?,?,?,?, 'whatsapp', ?,?,?, 'queued', ?, ?, ?)`).run(
    newId(), input.outlet_id, input.session_id, input.pickup_id ?? null, ident.id, input.kind, input.dedupe,
    JSON.stringify(input.params.map(p => String(p).replace(/\s+/g, ' ').slice(0, 120))), at, at, at);
  return r.changes === 1;
}

/** Is this queued message still worth sending? */
function obsolete(db: DB, n: { kind: string; session_id: string | null; pickup_id: string | null }): string {
  const s = n.session_id ? db.prepare('SELECT state FROM valet_vehicle_sessions WHERE id = ?').get(n.session_id) as { state: string } | undefined : undefined;
  if (!s || !isHeld(s.state)) return 'car already handed over or voided';
  if (n.kind === 'ready' && s.state !== 'READY_AT_GATE') return 'car no longer at the gate';
  if (n.kind === 'holding' && s.state !== 'HOLDING_NEAR_GATE') return 'car no longer in holding';
  if (n.kind === 'eta_changed' && n.pickup_id) {
    const p = db.prepare('SELECT state FROM valet_pickups WHERE id = ?').get(n.pickup_id) as { state: string } | undefined;
    if (!p || !['QUEUED', 'ASSIGNED', 'IN_PROGRESS'].includes(p.state)) return 'pickup no longer on its way';
  }
  return '';
}

/** Cancel queued/retrying messages for a session (cancellation / completion). */
export function cancelForSession(db: DB, sessionId: string, why: string, now: Date = new Date()): number {
  return db.prepare(`UPDATE valet_notifications SET status = 'cancelled', last_error = ?, updated_at = ?
                     WHERE session_id = ? AND status IN ('queued')`).run(why, nowIso(now), sessionId).changes;
}

/**
 * Deliver due messages. Each row is CLAIMED with a compare-and-swap (queued →
 * sending + a 2-minute lease) so two workers never send the same row. A failed
 * send retries with bounded backoff (1, 5, 15 min) then stops as 'failed' and
 * appears on the board. Never throws.
 */
export async function deliverDue(db: DB, now: Date = new Date(), send: SendFn = sendWhatsAppTemplate): Promise<{ sent: number; simulated: number; failed: number; cancelled: number }> {
  const out = { sent: 0, simulated: 0, failed: 0, cancelled: 0 };
  const at = nowIso(now);
  // Leases that died with a crashed worker go back to queued.
  db.prepare(`UPDATE valet_notifications SET status = 'queued', lease_until = NULL WHERE status = 'sending' AND lease_until < ?`).run(at);
  const due = db.prepare(`SELECT * FROM valet_notifications WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at LIMIT 25`).all(at) as
    { id: string; outlet_id: string; session_id: string | null; pickup_id: string | null; identity_id: string | null; kind: NotifyKind; params_json: string; attempts: number }[];
  for (const n of due) {
    const claimed = db.prepare(`UPDATE valet_notifications SET status = 'sending', lease_until = ?, updated_at = ? WHERE id = ? AND status = 'queued'`)
      .run(addMinutes(now, 2), at, n.id).changes;
    if (!claimed) continue;
    try {
      const why = obsolete(db, n);
      if (why) {
        db.prepare(`UPDATE valet_notifications SET status = 'cancelled', last_error = ?, lease_until = NULL, updated_at = ? WHERE id = ?`).run(why, at, n.id);
        out.cancelled++; continue;
      }
      const ident = n.identity_id ? db.prepare(`SELECT phone, opted_out_at FROM valet_msg_identities WHERE id = ?`).get(n.identity_id) as { phone: string; opted_out_at: string | null } | undefined : undefined;
      if (!ident || ident.opted_out_at || !ident.phone) {
        db.prepare(`UPDATE valet_notifications SET status = 'cancelled', last_error = 'guest opted out or identity missing', lease_until = NULL, updated_at = ? WHERE id = ?`).run(at, n.id);
        out.cancelled++; continue;
      }
      const ov = loadOutletValet(db, n.outlet_id);
      const sim = ov ? simulationReason(ov, n.kind) : 'outlet closed';
      if (sim) {
        db.prepare(`UPDATE valet_notifications SET status = 'simulated', last_error = ?, lease_until = NULL, updated_at = ? WHERE id = ?`).run(`SIMULATED — nothing was sent. ${sim}`, at, n.id);
        out.simulated++; continue;
      }
      const tpl = ov!.cfg.notifications.templates[n.kind];
      let params: string[] = [];
      try { params = JSON.parse(n.params_json); } catch { params = []; }
      const r = await send(ident.phone, tpl.name, tpl.lang, params);
      if (r.ok) {
        db.prepare(`UPDATE valet_notifications SET status = 'sent', provider_message_id = ?, template_name = ?, sent_at = ?, attempts = attempts + 1,
                      lease_until = NULL, last_error = '', updated_at = ? WHERE id = ?`).run(r.message_id ?? null, tpl.name, at, at, n.id);
        out.sent++;
      } else {
        const attempts = n.attempts + 1;
        const final = attempts >= MAX_ATTEMPTS || r.reason === 'not_configured';
        db.prepare(`UPDATE valet_notifications SET status = ?, attempts = ?, next_attempt_at = ?, failed_at = ?, last_error = ?, lease_until = NULL, updated_at = ? WHERE id = ?`)
          .run(final ? 'failed' : 'queued', attempts, final ? null : addMinutes(now, BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)]),
            final ? at : null, `${r.reason}${r.detail ? ': ' + String(r.detail).slice(0, 200) : ''}`, at, n.id);
        if (final) out.failed++;
      }
    } catch (e) {
      db.prepare(`UPDATE valet_notifications SET status = 'queued', lease_until = NULL, last_error = ?, updated_at = ? WHERE id = ?`)
        .run(`worker error: ${(e as Error)?.message || e}`.slice(0, 200), at, n.id);
    }
  }
  return out;
}

// ── inbound (signed webhook, or the simulator) ─────────────────────────────

/** Only ever called with a payload whose signature was VERIFIED and enforced
 *  (src/app/api/whatsapp/webhook/route.ts), or by the admin simulator with
 *  simulated=true. Dedupes every provider event, so a retry or a replay is a
 *  no-op. Returns what it did, for logs. */
export function ingestWhatsApp(db: DB, payloadJson: string, now: Date = new Date(), opts: { simulated?: boolean } = {}): string[] {
  const did: string[] = [];
  let body: any;
  try { body = JSON.parse(payloadJson); } catch { return did; }
  const at = nowIso(now);
  const seen = (key: string) => db.prepare('INSERT OR IGNORE INTO valet_provider_events (event_key, received_at) VALUES (?, ?)').run(key, at).changes === 0;
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const v = change?.value ?? {};
      for (const st of v.statuses ?? []) {
        const id = String(st?.id || ''); const status = String(st?.status || '');
        if (!id || !['sent', 'delivered', 'read', 'failed'].includes(status)) continue;
        if (seen(`status:${id}:${status}`)) continue;
        const ts = Number(st?.timestamp || 0) * 1000;
        if (ts && now.getTime() - ts > 7 * 86_400_000) continue;   // stale replay
        const col = status === 'delivered' ? 'delivered_at' : status === 'read' ? 'read_at' : status === 'failed' ? 'failed_at' : 'sent_at';
        // Never move backwards (a late 'sent' after 'delivered' changes nothing).
        const order = "CASE status WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 WHEN 'failed' THEN 4 ELSE 0 END";
        const rank = { sent: 1, delivered: 2, read: 3, failed: 4 }[status as 'sent'];
        const r = db.prepare(`UPDATE valet_notifications SET ${col} = COALESCE(${col}, ?), status = CASE WHEN ${order} < ? THEN ? ELSE status END,
                                last_error = CASE WHEN ? = 'failed' THEN ? ELSE last_error END, updated_at = ?
                              WHERE provider_message_id = ?`).run(at, rank, status, status, JSON.stringify(st?.errors ?? '').slice(0, 200), at, id);
        if (r.changes) did.push(`status ${status}`);
      }
      for (const m of v.messages ?? []) {
        const mid = String(m?.id || '');
        if (!mid || seen(`msg:${mid}`)) continue;
        const from = String(m?.from || '').replace(/[^\d]/g, '');
        if (!from) continue;
        const text = String(m?.text?.body ?? m?.button?.text ?? m?.interactive?.button_reply?.title ?? '').trim();
        const payload = String(m?.button?.payload ?? m?.interactive?.button_reply?.id ?? '').trim();
        did.push(handleInbound(db, `+${from}`, text, payload, now, !!opts.simulated));
      }
    }
  }
  return did;
}

function handleInbound(db: DB, phone: string, text: string, payload: string, now: Date, simulated: boolean): string {
  const at = nowIso(now);
  const t = text.toUpperCase().replace(/\s+/g, ' ').trim();
  const link = /^VALET ([0-9A-Z]{6})$/.exec(t);
  if (link) {
    const row = db.prepare(`SELECT id, outlet_id, session_id FROM valet_msg_identities WHERE link_code = ? AND verified_at IS NULL AND link_expires_at > ?`)
      .get(link[1], at) as { id: string; outlet_id: string; session_id: string } | undefined;
    if (!row) return 'link: unknown or expired code';
    // The guest initiated this message after tapping "Get WhatsApp updates" on
    // their own pass: that is the verification AND the recorded consent.
    db.prepare(`UPDATE valet_msg_identities SET phone = ?, verified_at = ?, verified_how = 'inbound_message', consent_at = ?, last_inbound_at = ?, simulated = ?
                WHERE id = ? AND verified_at IS NULL`).run(phone, at, at, at, simulated ? 1 : 0, row.id);
    logEvent(db, { outlet_id: row.outlet_id, session_id: row.session_id, event_type: 'whatsapp.linked', actor: SYSTEM, at, data: { simulated } });
    enqueue(db, { outlet_id: row.outlet_id, session_id: row.session_id, kind: 'linked', dedupe: `linked:${row.id}`, params: [] }, now);
    return 'linked';
  }
  // Everything else needs a known, verified identity for this phone.
  const idents = db.prepare(`SELECT i.id, i.session_id, i.outlet_id FROM valet_msg_identities i JOIN valet_vehicle_sessions s ON s.id = i.session_id
                             WHERE i.phone = ? AND i.verified_at IS NOT NULL AND s.state NOT IN ('HANDED_OVER','VOIDED')`).all(phone) as
    { id: string; session_id: string; outlet_id: string }[];
  if (t === 'STOP' || t === 'STOP ALL' || t === 'UNSUBSCRIBE') {
    const n = db.prepare(`UPDATE valet_msg_identities SET opted_out_at = ? WHERE phone = ? AND opted_out_at IS NULL`).run(at, phone).changes;
    for (const i of idents) cancelForSession(db, i.session_id, 'guest opted out', now);
    return `opt-out (${n})`;
  }
  if (!idents.length) return 'inbound from unknown number — ignored';
  for (const i of idents) db.prepare(`UPDATE valet_msg_identities SET last_inbound_at = ? WHERE id = ?`).run(at, i.id);
  const wantsCar = ['NOW', '1', 'BRING MY CAR', 'GET MY CAR'].includes(t) || payload === 'VALET_NOW';
  if (!wantsCar) return 'inbound text — no action';
  if (idents.length > 1) {
    // More than one car matches this number: never guess. The guest uses the
    // pass (explicit vehicle selection) and the team is told.
    for (const i of idents) raiseAlert(db, i.outlet_id, i.session_id, null, 'whatsapp_ambiguous', 'Guest asked by WhatsApp, but this number has more than one car — ask which', `wa-ambig:${i.session_id}`, at);
    return 'pickup request ambiguous — staff alerted';
  }
  const ov = loadOutletValet(db, idents[0].outlet_id);
  if (!ov || !ov.enabled) return 'outlet closed';
  try {
    const r = requestPickup(db, ov, { ...SYSTEM, kind: 'guest', id: `wa:${idents[0].id}`, name: 'Guest (WhatsApp)' }, { session_id: idents[0].session_id, when: 'now', idempotency_key: `wa:${idents[0].id}:${Math.floor(now.getTime() / 120_000)}` }, 'guest', now);
    return r.existing ? 'pickup already active' : 'pickup requested';
  } catch (e) {
    return `pickup refused: ${(e as Error).message}`;
  }
}

// ── event hooks: what tells the guest something changed ────────────────────

/** Called by the worker each tick: queue messages for state changes the guest
 *  cares about. Idempotent by dedupe key, so re-running never duplicates. */
export function queueStateMessages(db: DB, ov: OutletValet, now: Date = new Date()): number {
  let n = 0;
  const ready = db.prepare(`SELECT s.id, s.tag_code, p.id AS pickup_id FROM valet_vehicle_sessions s LEFT JOIN valet_pickups p ON p.session_id = s.id AND p.state = 'READY'
                            WHERE s.outlet_id = ? AND s.state = 'READY_AT_GATE'`).all(ov.outlet_id) as { id: string; tag_code: string; pickup_id: string | null }[];
  for (const r of ready) if (enqueue(db, { outlet_id: ov.outlet_id, session_id: r.id, pickup_id: r.pickup_id, kind: 'ready', dedupe: `ready:${r.pickup_id || r.id}`, params: [r.tag_code, ov.cfg.pickup_gate_label] }, now)) n++;
  const held = db.prepare(`SELECT id, tag_code, holding_at FROM valet_vehicle_sessions WHERE outlet_id = ? AND state = 'HOLDING_NEAR_GATE'`).all(ov.outlet_id) as { id: string; tag_code: string; holding_at: string }[];
  for (const h of held) if (enqueue(db, { outlet_id: ov.outlet_id, session_id: h.id, kind: 'holding', dedupe: `holding:${h.id}:${h.holding_at}`, params: [h.tag_code, ov.cfg.pickup_gate_label] }, now)) n++;
  return n;
}

/** Guest-pass view of the WhatsApp link state (no phone number ever shown). */
export function linkState(db: DB, sessionId: string): { linked: boolean; opted_out: boolean } {
  const r = db.prepare(`SELECT verified_at, opted_out_at FROM valet_msg_identities WHERE session_id = ? AND verified_at IS NOT NULL ORDER BY verified_at DESC LIMIT 1`).get(sessionId) as
    { verified_at: string; opted_out_at: string | null } | undefined;
  return { linked: !!r && !r.opted_out_at, opted_out: !!r?.opted_out_at };
}

export { activePickup, sha256 };
