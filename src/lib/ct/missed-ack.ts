/**
 * Call-to-Table CRM — instant WhatsApp acknowledgement of a MISSED call.
 *
 * Today a missed call only creates a ct_recoveries row with a callback SLA and
 * the guest hears nothing until a GRE rings back. This module sends ONE
 * WhatsApp the moment the miss is detected, which does two things:
 *   1. rescues the booking ("we saw you, we're on it"), and
 *   2. if the guest REPLIES, their reply opens Meta's free 24-hour
 *      customer-service window, inside which the GRE can converse in
 *      free-form text at no per-message cost.
 *
 * ── OFF BY DEFAULT ────────────────────────────────────────────────────────
 * Nothing is sent unless an admin turns on one of two ct_settings flags:
 *   missed_call_whatsapp = '1'  → acknowledge EVERY missed call
 *   after_hours_whatsapp = '1'  → acknowledge ONLY calls missed outside
 *                                 business_open..business_close (the
 *                                 pre-existing toggle; it keeps its own
 *                                 after_hours_template copy)
 * Both default to '0'. With both off, maybeAckMissedCall() returns before it
 * reads a message, touches a row, or writes a log line — a missed call behaves
 * byte-identically to today. That is the safety property.
 *
 * ── IDEMPOTENCY: one acknowledgement per missed call, EVER ────────────────
 * Two keys stack:
 *   (a) ct_recoveries.call_id is UNIQUE → exactly one recovery row per missed
 *       call, so "the recovery for this call" is a singleton anchor.
 *   (b) this module CLAIMS its slot with a single conditional UPDATE that
 *       appends an attempts[] entry carrying { "auto": "missed_call_ack" },
 *       and only when no entry with that marker already exists. SQLite
 *       serialises writers, so exactly one caller sees changes === 1 and goes
 *       on to send. A webhook replay, a duplicate CDR, a backfill overlap, a
 *       reconcileLiveEvents pass or a manual re-run all see changes === 0 and
 *       return 'already_acknowledged'.
 * The claim happens BEFORE the network call, so a crash mid-send cannot cause
 * a second send — deliberately biased towards never double-messaging a guest.
 * A doomed attempt (flag on but WhatsApp unconfigured / number unusable) is
 * rejected BEFORE the claim, so it does not burn the slot.
 *
 * ── COMPLIANCE (India / DPDPA / Meta) ─────────────────────────────────────
 * A phone call does NOT open the 24-hour service window — only an inbound
 * WhatsApp *message* from the guest does. So the FIRST outbound message to a
 * guest who has never messaged the venue MUST be an approved template.
 * Point one at this feature with zero new schema: create a whatsapp_templates
 * row named 'ct_missed_call_ack' (existing admin Templates tab) with
 * send_as_template = 1 and the exact provider_template_name Meta approved.
 * Without that row we fall back to free-form text, which Meta delivers only to
 * guests already inside a live 24h window and otherwise rejects — the refusal
 * is logged and never retried. No bypass is invented here.
 */
import type Database from 'better-sqlite3';
import { getDb } from '@/lib/db';
import { ctSetting, isBusinessHours, CT_SETTING_DEFAULTS } from './settings';

/**
 * The idempotency marker written into the claimed attempts[] entry. Machine
 * written only — it lives on the `auto` key, which no human-entered field
 * (`outcome`, `by`, `method`) can ever occupy, so a GRE cannot accidentally
 * type a value that suppresses a real acknowledgement.
 */
export const ACK_MARKER = 'missed_call_ack';

/**
 * Conventional whatsapp_templates.name an admin creates to route this feature
 * through a Meta/Interakt APPROVED template (mirrors notifyEvent's
 * "template by convention: row named after the event" rule).
 */
export const ACK_TEMPLATE_NAME = 'ct_missed_call_ack';

/**
 * db.ts seeds ct_settings.missed_call_wa_text with exactly this. The constant
 * exists only as a fallback for a DB where that seed row is somehow absent —
 * NOT for a row an admin deliberately blanked (see ackText()).
 */
export const DEFAULT_ACK_TEXT = 'Sorry we missed your call. Reply here and we will help you book.';

/** Why a given missed call did or didn't get acknowledged (for logs/tests). */
/**
 * How old a miss may be and still be worth acknowledging. Beyond this the
 * guest has moved on, and — the real reason — /api/telecmi/backfill replays up
 * to 5,000 CDRs over up to 90 days through this same path, so an unbounded
 * window turns a routine backfill into a mass WhatsApp blast that cannot be
 * recalled.
 */
const ACK_MAX_AGE_MIN = 120;

/**
 * One acknowledgement per number per this window. Recoveries dedupe on call_id,
 * so a guest ringing three times in a minute would otherwise get three
 * identical messages.
 */
const ACK_COOLDOWN_MIN = 180;

export type AckOutcome =
  | 'disabled'               // master switch off → clean no-op, nothing written
  | 'in_hours'               // after-hours-only mode and the miss was in hours
  | 'stale_miss'             // older than ACK_MAX_AGE_MIN (e.g. a CDR backfill)
  | 'burst_suppressed'       // same number already acknowledged this window
  | 'outbound'               // we called them; never acknowledge our own dial
  | 'no_recovery'            // no ct_recoveries row for this call
  | 'no_call'                // no ct_calls row → direction unknown → fail closed
  | 'unusable_number'        // missing / too short to dial
  | 'not_configured'         // no WhatsApp provider credentials
  | 'no_text'                // the configured message body is empty
  | 'already_acknowledged'   // the idempotency key did its job
  | 'sent'
  | 'send_failed'
  | 'error';

interface RecoveryRow {
  id: string;
  phone_e164: string;
  missed_at: string;
  attempts: string;
}

/* ── message body ─────────────────────────────────────────────────────────── */

/** '12:00' → '12:00 PM'. Falls back to the raw value for anything odd. */
function prettyOpen(hm: string): string {
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(String(hm || '').trim());
  if (!m) return String(hm || '').trim();
  const h = Number(m[1]);
  if (h > 23) return String(hm).trim();
  const suffix = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]} ${suffix}`;
}

/**
 * {link} for the after-hours template. Resolved from the FIRST non-empty URL
 * in the existing ct_settings.quick_send_links list (the documents a GRE
 * already WhatsApps callers — Menu / Book a table). No new setting invented.
 * Returns '' when the admin has not filled any URL in.
 */
function bookingLink(db: Database.Database): string {
  try {
    const arr = JSON.parse(ctSetting(db, 'quick_send_links') || '[]');
    if (!Array.isArray(arr)) return '';
    for (const it of arr) {
      const url = String((it as { url?: unknown })?.url ?? '').trim();
      if (/^https?:\/\/\S+$/.test(url)) return url;
    }
  } catch { /* malformed list → no link */ }
  return '';
}

/**
 * Substitute the after-hours template's SINGLE-brace {open} / {link} tokens
 * (that template predates the {{var}} convention, so renderTemplate does not
 * apply). If {link} cannot be resolved, the dangling label that introduced it
 * ("… Book a table:") is dropped too, so a guest never receives a stray colon
 * or a literal "{link}". The Settings page shows the exact rendered result.
 */
export function renderAckText(raw: string, vars: { open: string; link: string }): string {
  let out = String(raw ?? '');
  out = out.replace(/\{\s*open\s*\}/gi, vars.open);
  if (vars.link) {
    out = out.replace(/\{\s*link\s*\}/gi, vars.link);
  } else {
    // Drop "<label>: {link}" / "<label> {link}" entirely rather than leaving a
    // half-sentence pointing at nothing.
    out = out.replace(/[^.!?\n]*\{\s*link\s*\}/gi, '');
  }
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

export interface AckDecision {
  /** True only when a message may go out for this missed call. */
  send: boolean;
  /** Why not, when send is false. 'ok' when send is true. */
  reason: 'disabled' | 'in_hours' | 'no_text' | 'ok';
  /** The exact body a guest would receive ('' when send is false). */
  text: string;
  /** Which toggle produced it. */
  mode: 'every_miss' | 'after_hours' | 'none';
}

/**
 * Which body goes out, and whether we're allowed to send at all.
 * Exported so tests exercise the SAME decision the send path uses — there is
 * one implementation of the rule, not two.
 */
export function ackDecision(db: Database.Database, missedAtIso: string): AckDecision {
  const no = (reason: AckDecision['reason']): AckDecision => ({ send: false, reason, text: '', mode: 'none' });

  // ONE master switch, three explicit modes. `missed_call_whatsapp` is the only
  // thing that can arm automatic messaging:
  //     '0'            off (shipped default)
  //     '1'            acknowledge every missed call
  //     'after_hours'  acknowledge only misses outside business hours
  //
  // The legacy `after_hours_whatsapp` toggle is deliberately NOT a trigger. It
  // shipped inert — nothing ever read it — so anyone who flipped it on did so
  // knowing it did nothing. Letting it now start messaging real guests would
  // turn a dead switch live behind the operator's back on the next deploy. It
  // survives only as the UI's way of choosing the 'after_hours' mode, and the
  // settings route maps it onto this key explicitly.
  const mode = ctSetting(db, 'missed_call_whatsapp');
  const everyMiss = mode === '1';
  const afterHoursOnly = mode === 'after_hours';
  if (!everyMiss && !afterHoursOnly) return no('disabled');

  const outsideHours = !isBusinessHours(missedAtIso, db);

  // The after-hours toggle owns after-hours misses (its copy tells the guest
  // when we open, which is the useful thing to say at 2am). The every-miss
  // toggle covers the rest. Neither is a parallel concept — one wins per call.
  if (afterHoursOnly && outsideHours) {
    const text = renderAckText(
      ctSetting(db, 'after_hours_template') || CT_SETTING_DEFAULTS.after_hours_template,
      { open: prettyOpen(ctSetting(db, 'business_open') || CT_SETTING_DEFAULTS.business_open), link: bookingLink(db) },
    );
    return text ? { send: true, reason: 'ok', text, mode: 'after_hours' } : no('no_text');
  }

  if (!everyMiss) return no('in_hours'); // after-hours-only mode, and it's in hours

  const text = ackText(db);
  return text ? { send: true, reason: 'ok', text, mode: 'every_miss' } : no('no_text');
}

/**
 * The every-miss body. A row that EXISTS but is empty means an admin
 * deliberately blanked the copy → stay silent ('no_text'). Only a MISSING row
 * falls back to the seeded default, so behaviour is predictable on a DB where
 * the migration seed never ran.
 */
function ackText(db: Database.Database): string {
  let row: { value?: string } | undefined;
  try {
    row = db.prepare(`SELECT value FROM ct_settings WHERE key = 'missed_call_wa_text'`).get() as { value?: string } | undefined;
  } catch { return ''; }
  return row ? String(row.value ?? '').trim() : DEFAULT_ACK_TEXT;
}

/* ── attempts[] claim + outcome stamp ─────────────────────────────────────── */

/** Mirrors ingest.ts appendAttempt — never loses the new entry to corrupt JSON. */
function appendAttempt(attemptsJson: string, attempt: Record<string, unknown>): string {
  let arr: unknown[] = [];
  try {
    const parsed = JSON.parse(attemptsJson || '[]');
    if (Array.isArray(parsed)) arr = parsed;
  } catch { /* corrupt attempts JSON → start fresh */ }
  arr.push(attempt);
  return JSON.stringify(arr);
}

/** Cheap JS-side read of the marker (exact — matches on the `auto` key only). */
export function hasAck(attemptsJson: string): boolean {
  try {
    const arr = JSON.parse(attemptsJson || '[]');
    if (!Array.isArray(arr)) return false;
    return arr.some(a => a && typeof a === 'object' && (a as { auto?: unknown }).auto === ACK_MARKER);
  } catch { return false; }
}

/**
 * THE idempotency key in SQL form. Appends the acknowledgement entry only when
 * no entry with auto = 'missed_call_ack' exists yet. One statement, so SQLite's
 * write lock makes it atomic across concurrent webhook deliveries and across
 * processes. changes === 1 → we own the send; changes === 0 → somebody already
 * acknowledged this missed call and we must not send again.
 */
const CLAIM_SQL = `
  UPDATE ct_recoveries
     SET attempts = ?, updated_at = ?
   WHERE id = ?
     AND NOT EXISTS (
       SELECT 1
         FROM json_each(CASE WHEN json_valid(ct_recoveries.attempts) THEN ct_recoveries.attempts ELSE '[]' END)
        WHERE json_extract(json_each.value, '$.auto') = '${ACK_MARKER}'
     )
`;

/**
 * Patch the claimed entry in place with the send result. Rewrites the array in
 * ONE statement (json_group_array over json_each) so a GRE attempt logged in
 * the few hundred ms the send takes is preserved rather than clobbered by a
 * read-modify-write.
 */
const STAMP_SQL = `
  UPDATE ct_recoveries
     SET attempts = (
           SELECT json_group_array(
                    CASE WHEN json_extract(je.value, '$.auto') = '${ACK_MARKER}'
                         THEN json_patch(je.value, json(?))
                         ELSE json(je.value) END
                  )
             FROM json_each(CASE WHEN json_valid(ct_recoveries.attempts) THEN ct_recoveries.attempts ELSE '[]' END) je
         ),
         updated_at = ?
   WHERE id = ?
`;

/* ── audit log ────────────────────────────────────────────────────────────── */

/**
 * Same table + shape the WhatsApp lib's own logWaSendAttempt uses
 * (whatsapp_events_log, kind='send_attempt', payload JSON with an "event" key),
 * so this feature shows up in the existing WhatsApp audit trail rather than a
 * private one. Never throws.
 */
function logAck(payload: Record<string, unknown>): void {
  try {
    getDb()
      .prepare(`INSERT INTO whatsapp_events_log (kind, payload) VALUES ('send_attempt', ?)`)
      .run(JSON.stringify({ event: ACK_TEMPLATE_NAME, ...payload }));
  } catch { /* logging must never break the webhook */ }
}

/* ── approved-template lookup ─────────────────────────────────────────────── */

interface AckTemplate { name: string; language: string; params: string[] }

/**
 * The venue's Meta/Interakt APPROVED template for this event, if an admin
 * mapped one. Returns undefined when there is none (→ free-form fallback).
 * Defensive about older DBs that predate the provider_* columns, exactly like
 * notifyEvent() in src/lib/whatsapp.ts.
 */
function ackTemplate(db: Database.Database, vars: Record<string, string>): AckTemplate | undefined {
  type Row = {
    send_as_template?: number;
    provider_template_name?: string;
    provider_language?: string;
    language?: string;
    param_order?: string;
  };
  let row: Row | undefined;
  try {
    row = db.prepare(`
      SELECT COALESCE(send_as_template, 0) AS send_as_template,
             provider_template_name, provider_language, language, param_order
        FROM whatsapp_templates WHERE name = ? AND is_active = 1
    `).get(ACK_TEMPLATE_NAME) as Row | undefined;
  } catch {
    return undefined; // older DB without the provider columns → free-form only
  }
  const name = String(row?.provider_template_name || '').trim();
  if (row?.send_as_template !== 1 || !name) return undefined;

  let params: string[] = [];
  try {
    const parsed = JSON.parse(String(row.param_order || '[]'));
    if (Array.isArray(parsed)) {
      // Meta rejects positional params containing newlines or runs of spaces.
      params = parsed.map(k => String(vars[String(k)] ?? '').replace(/\s+/g, ' ').trim());
    }
  } catch { /* no param_order → a zero-placeholder template, the usual shape */ }

  return { name, language: String(row.provider_language || row.language || 'en').trim() || 'en', params };
}

/* ── the entry point ──────────────────────────────────────────────────────── */

/**
 * Acknowledge a freshly detected missed call on WhatsApp. Call as
 * `void maybeAckMissedCall(callId)` from the ingest path — it NEVER throws and
 * never blocks recovery creation.
 *
 * @param callId ct_calls.id of the missed call (== ct_recoveries.call_id).
 */
export async function maybeAckMissedCall(callId: string): Promise<AckOutcome> {
  try {
    const db = getDb();

    const rec = db
      .prepare(`SELECT id, phone_e164, missed_at, attempts FROM ct_recoveries WHERE call_id = ?`)
      .get(callId) as RecoveryRow | undefined;
    if (!rec) return 'no_recovery';

    // NEVER acknowledge an outbound call — the guest did not call us. A missing
    // ct_calls row means we cannot prove direction, so fail closed and stay quiet.
    const call = db.prepare(`SELECT direction FROM ct_calls WHERE id = ?`).get(callId) as { direction?: string } | undefined;
    if (!call) return 'no_call';
    if (String(call.direction || '').toLowerCase() !== 'inbound') return 'outbound';

    // STALENESS GUARD — the most dangerous path in this feature.
    //
    // POST /api/telecmi/backfill replays up to 5,000 historical CDRs (up to 90
    // days) through the SAME ingestCdr path. Every historical miss without a
    // recovery row reaches madeNew, so without this an operator running a
    // routine backfill would WhatsApp hundreds of guests about calls they made
    // weeks ago. That is unrecoverable — you cannot un-send it.
    //
    // An acknowledgement is only meaningful while the guest still remembers
    // ringing, so anything older than the window is silently skipped. The
    // recovery row is still created; only the message is suppressed.
    const missedMs = Date.parse(String(rec.missed_at || '').replace(' ', 'T') + (String(rec.missed_at || '').includes('Z') ? '' : 'Z'));
    if (!Number.isFinite(missedMs)) return 'stale_miss';
    const ageMin = (Date.now() - missedMs) / 60000;
    if (ageMin > ACK_MAX_AGE_MIN) return 'stale_miss';

    // Flags + business hours + the exact body. Off ⇒ we return here having
    // written nothing at all.
    const decision = ackDecision(db, rec.missed_at);
    if (!decision.send) return decision.reason as AckOutcome;

    // Cheap pre-check before the dynamic import — a replay costs nothing.
    if (hasAck(rec.attempts)) return 'already_acknowledged';

    // PER-GUEST BURST GUARD. createRecovery dedupes on call_id, so a guest who
    // rings three times in ninety seconds produces three calls, three
    // recoveries and — without this — three identical WhatsApps. One
    // acknowledgement per number per cooldown, whichever call triggered it.
    const recent = db.prepare(`
      SELECT 1 FROM whatsapp_events_log
       WHERE kind = 'send_attempt'
         AND payload LIKE '%"event":"ct_missed_call_ack"%'
         AND payload LIKE ?
         AND created_at > datetime('now', ?)
       LIMIT 1
    `).get(`%${rec.phone_e164}%`, `-${ACK_COOLDOWN_MIN} minutes`);
    if (recent) return 'burst_suppressed';

    const { isWaConfigured, normalizeWaNumber, sendWhatsAppMessage, sendWhatsAppTemplate } = await import('@/lib/whatsapp');

    const to = normalizeWaNumber(rec.phone_e164);
    if (!/^\d{10,15}$/.test(to)) {
      logAck({ ok: false, reason: 'unusable_number', call_id: callId, recovery_id: rec.id });
      return 'unusable_number';
    }
    // Rejected BEFORE the claim so a doomed attempt never burns the one slot —
    // once the admin wires credentials, the NEXT missed call sends normally.
    if (!isWaConfigured()) {
      logAck({ ok: false, reason: 'not_configured', call_id: callId, recovery_id: rec.id });
      return 'not_configured';
    }

    const now = new Date().toISOString();
    const tpl = ackTemplate(db, {
      open: prettyOpen(ctSetting(db, 'business_open') || CT_SETTING_DEFAULTS.business_open),
      link: bookingLink(db),
      phone: rec.phone_e164,
    });

    // ── CLAIM (the idempotency key). Exactly one caller wins. ──
    // Re-read attempts immediately before the claim: the `await import` above
    // yields the event loop, and a GRE could have logged a callback attempt in
    // that window — appending to the stale copy would silently drop it.
    const fresh = (db.prepare(`SELECT attempts FROM ct_recoveries WHERE id = ?`).get(rec.id) as { attempts?: string } | undefined)?.attempts
      ?? rec.attempts;
    const claim = db.prepare(CLAIM_SQL).run(
      appendAttempt(fresh, {
        at: now,
        by: 'system',
        // 'whatsapp' is an existing ATTEMPT_METHODS value, so the Recovery
        // board's attempts timeline already renders this with a WhatsApp icon.
        method: 'whatsapp',
        outcome: 'Auto-acknowledgement — sending',
        auto: ACK_MARKER,
        mode: decision.mode,
      }),
      now,
      rec.id,
    );
    if (claim.changes === 0) return 'already_acknowledged';

    // ── SEND (the ONE outbound door — never a hand-rolled HTTP call) ──
    const res = tpl
      ? await sendWhatsAppTemplate(to, tpl.name, tpl.language, tpl.params)
      : await sendWhatsAppMessage(to, decision.text);

    const ok = res.ok === true;
    const detail = ok ? '' : String((res as { detail?: string }).detail || (res as { reason?: string }).reason || '');
    db.prepare(STAMP_SQL).run(
      JSON.stringify({
        outcome: ok
          ? 'Auto-acknowledgement sent on WhatsApp'
          : `Auto-acknowledgement failed — ${detail || 'unknown error'}`,
        ok,
        sent_at: ok ? new Date().toISOString() : null,
        channel: tpl ? `template:${tpl.name}` : 'free_text',
      }),
      new Date().toISOString(),
      rec.id,
    );

    logAck({
      ...res,
      to,
      call_id: callId,
      recovery_id: rec.id,
      mode: decision.mode,
      template_source: tpl ? 'provider_template' : 'free_text',
      template: tpl?.name,
    });

    return ok ? 'sent' : 'send_failed';
  } catch (e) {
    // A WhatsApp problem must NEVER block recovery creation or escape the webhook.
    console.error('[ct-missed-ack] maybeAckMissedCall failed', e);
    return 'error';
  }
}
