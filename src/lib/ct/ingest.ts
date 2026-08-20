/**
 * Call-to-Table CRM — THE core ingestion service.
 *
 * Every TeleCMI payload (live websocket-relay webhook + CDR webhook + backfill)
 * funnels through here. Responsibilities:
 *   - Declining the INTERNAL LEG of a routed call — the record whose "caller" is
 *     one of OUR OWN numbers — so our PBX never becomes a guest (see the
 *     own-numbers block below, and classifyLeg() in ./telecmi-mapper.ts).
 *   - Idempotent CDR upsert into ct_calls (keyed on telecmi_call_id — a CDR
 *     re-delivery or a backfill overlap NEVER duplicates a call).
 *   - Missed-call detection → auto-create ct_recoveries with a business-hours
 *     aware SLA deadline (see docs/CRM_DECISIONS.md §5.5A).
 *   - Recovery lifecycle automation: answered inbound auto-resolves open
 *     recoveries for that phone; answered outbound records the callback
 *     attempt; a booking created after a call links + recovers via
 *     attributeBooking().
 *   - Answered-call OWNERSHIP: stamps ct_calls.owner_email when telephony tells
 *     us who picked up, so the screen-pop and the write-up belong to ONE person
 *     (see the ownership block below; the lock itself lives in ./call-owner.ts).
 *   - Safety nets: reconcileLiveEvents (ring seen, CDR never arrived) and
 *     expireOverdueRecoveries (escalate at SLA, expire at 2× SLA).
 *
 * Called from webhook routes — every public function is wrapped in try/catch
 * and NEVER throws (webhooks must always ack 200 fast; errors are logged).
 */
import type Database from 'better-sqlite3';
import { getDb, generateId } from '@/lib/db';
import { mapCdrPayload, mapLivePayload } from './telecmi-mapper';
import { normalizePhone } from './phone';
import { ctSetting, setCtSetting, slaDueAt, ctRecordingBaseUrl } from './settings';
import { emitCt, pushRecentCt, type CtEvent } from './bus';
import {
  getAgentMap, getUserNamesByEmail, resolveAgentLabel, ringingForLabel, type RingingFor,
} from './agents';

/** Resolve a raw TeleCMI agent id to a staff display name for the live feed
 *  (via agent_map). Cheap enough for the low frequency of live/CDR events. */
function agentDisplayName(db: Database.Database, rawAgent: string | undefined | null): string {
  if (!rawAgent) return '';
  try { return resolveAgentLabel(rawAgent, getAgentMap(db), getUserNamesByEmail(db)); }
  catch { return String(rawAgent || ''); }
}

/**
 * WHO IS THIS RING FOR — named extension, else the ring group, else nothing.
 * The ladder itself lives in ringingForLabel() (./agents.ts) so this file, the
 * /api/crm-calls/live snapshot and every renderer share ONE implementation.
 *
 * On a map-read failure both maps come through empty, and resolveAgentLabel's
 * documented fallback then shows the RAW agent id — the same degradation
 * agentDisplayName() above already makes, so a settings/user read that fails
 * costs a nice name, never the fact that somebody's phone is ringing.
 */
function ringingForOf(
  db: Database.Database,
  rawAgent: string | undefined | null,
  queue: string | undefined | null,
): RingingFor | undefined {
  let map: Record<string, string> = {};
  let names: Record<string, string> = {};
  try { map = getAgentMap(db); names = getUserNamesByEmail(db); }
  catch (e) { console.error('[ct-ingest] agent map read failed for a ring', e); }
  return ringingForLabel(rawAgent, queue, map, names) ?? undefined;
}

// ─── OUR OWN NUMBERS — so an internal leg is never mistaken for a guest ─────
//
// TeleCMI reports a routed inbound call as TWO records: the guest dialling our
// virtual number, and the platform then dialling an agent's handset. Only the
// first has a caller in it. The second's `from` is OUR number (the one the
// agents' phones see the call arrive from), and until this existed nothing in
// the system could tell the two apart — so it was ingested as a call in its own
// right and appeared on the Live wallboard, screen-pop included, as if a guest
// had rung. classifyLeg() in ./telecmi-mapper.ts does the deciding; this is
// where it gets its list of what "ours" means.
//
// TWO SOURCES, and NEITHER is a hardcoded number:
//   own_numbers      — set by an admin. Comma / newline / space separated.
//   own_numbers_seen — LEARNED, append-only, from the `virtual_number` field
//                      TeleCMI itself puts on its CDRs.
// They are separate keys on purpose: learning must never overwrite, reorder or
// silently drop what a human typed, and a human must be able to clear the
// learned list on its own if it ever picks up something wrong.
//
// AN UNCONFIGURED INSTALL THAT HAS SEEN NO CDR HAS AN EMPTY LIST, and an empty
// list classifies nothing — behaviour is exactly what it was. That is the
// deliberate bias throughout: showing an internal number is embarrassing,
// swallowing a real guest call costs money, so every uncertainty shows the call.
//
// NOT A SECRET, so deliberately NOT added to SECRET_KEYS in
// /api/crm-calls/settings (read its ⚠ RELEASE GATE comment — a new ct_settings
// key is public to admins by default and must be declared here if it is not).
// These are the outlet's own published phone numbers; an admin's browser may
// see them. Neither key is in CT_SETTING_DEFAULTS either, which — exactly like
// its siblings recording_base_url and recording_host_allowlist — keeps them out
// of that route's ALLOWED_KEYS, so they are DB/auto-configured and cannot be
// written through the ordinary settings PUT.
const OWN_NUMBERS_KEY = 'own_numbers';
const OWN_NUMBERS_SEEN_KEY = 'own_numbers_seen';
/** Cap on the learned list. An account has a handful of DIDs; a runaway list
 *  would be evidence the source field is not what we think it is, and it must
 *  not be able to grow without bound in a settings row. */
const MAX_LEARNED_OWN_NUMBERS = 20;

/** Split a stored list ("9198…, 7943446235\n0891…") into trimmed entries. */
function splitNumbers(raw: string): string[] {
  return String(raw || '')
    .split(/[\s,;]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

/** Every number we have reason to believe is OURS. '' / missing rows → []. */
function ctOwnNumbers(db: Database.Database): string[] {
  try {
    return [
      ...splitNumbers(ctSetting(db, OWN_NUMBERS_KEY)),
      ...splitNumbers(ctSetting(db, OWN_NUMBERS_SEEN_KEY)),
    ];
  } catch (e) {
    console.error('[ct-ingest] own-number list read failed', e);
    return []; // fail OPEN — an unreadable list must never suppress a guest
  }
}

/**
 * Remember a number TeleCMI named as `virtual_number`, so LATER payloads — live
 * events in particular, which need not repeat the field — can be classified
 * from it. Append-only, deduped on digits, capped, and never throws.
 *
 * Only ever called with the value of that one field. It is NOT called with
 * `to`, `did` or anything else that merely tends to be ours: the whole safety
 * argument for suppressing on this list is that every entry came from the
 * vendor's own name for our own DID.
 */
function learnOwnNumber(db: Database.Database, value: string): void {
  const raw = String(value || '').trim();
  if (!raw) return;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 8) return; // not a dialable number — never learn it
  try {
    const known = splitNumbers(ctSetting(db, OWN_NUMBERS_SEEN_KEY));
    if (known.some(k => k.replace(/\D/g, '') === digits)) return;
    if (known.length >= MAX_LEARNED_OWN_NUMBERS) {
      console.warn(
        `[ct-ingest] not learning own number ${raw} — ${OWN_NUMBERS_SEEN_KEY} already holds ${known.length}`,
      );
      return;
    }
    setCtSetting(db, OWN_NUMBERS_SEEN_KEY, [...known, raw].join(', '));
    console.warn(`[ct-ingest] learned own (virtual) number ${raw} from a TeleCMI payload`);
  } catch (e) {
    console.error('[ct-ingest] own-number learn failed', e);
  }
}

// ─── Answered-call OWNERSHIP — the stamping side ────────────────────────────
//
// When a call is ANSWERED it belongs to ONE person: they keep the screen-pop and
// the disposition write-up, and every other browser collapses to a read-only
// strip naming who has it. THE LOCK RULE AND THE ATOMIC FIRST-CLAIM LIVE IN
// src/lib/ct/call-owner.ts AND ARE NOT REPEATED HERE. All this file ever does is
// the one narrow write the telephony side has earned: put an owner on a row that
// is ANSWERED and still UNOWNED. That precondition is strictly narrower than
// anything in call-owner.ts, so the two can never disagree about who holds a call.
//
// WHY NOT JUST IMPORT claimCall():
//   1. claimCall() deliberately also succeeds when the lock has LAPSED — the
//      owner saved a disposition, or the write-up window expired. That is right
//      for a human clicking "take this call" and WRONG here: a re-delivered CDR
//      (ingestCdr is idempotent, so re-delivery is normal) or a backfill run
//      would silently rewrite the owner of a call somebody already wrote up.
//      Ingest may fill a blank; it may never take one over.
//   2. call-owner.ts imports @/lib/auth (for isManagement), which pulls
//      next/headers. Ingest runs from a webhook with NO signed-in user and must
//      not drag session machinery into that path.
//
// MISSED CALLS ARE NEVER OWNED. Nobody picked up, chasing them is the entire job
// of the recovery queue, and an owner on one would lock it away from the people
// meant to chase it. The CDR is the source of truth on answered-vs-missed, so it
// both stamps AND un-stamps — see settleOwnerFromCdr().

/** Set an owner ONLY on an answered, still-unowned row. One conditional UPDATE:
 *  the precondition is the WHERE, so a browser that claimed the call a moment
 *  before this webhook landed keeps it — the database picks the winner, not us.
 *  The answered test matches answeredSql() in call-owner.ts: answered_at is the
 *  primary signal, status covers a row whose answered_at never arrived. */
const STAMP_OWNER_SQL = `
  UPDATE ct_calls
     SET owner_email = ?, owner_claimed_at = ?
   WHERE id = ?
     AND IFNULL(owner_email, '') = ''
     AND (IFNULL(answered_at, '') <> '' OR IFNULL(status, '') = 'answered')
`;

/** Hand a call back to everyone. Used only when the CDR reclassifies a call the
 *  live 'answer' notify had already stamped (see settleOwnerFromCdr). */
const CLEAR_OWNER_SQL = `
  UPDATE ct_calls
     SET owner_email = '', owner_claimed_at = ''
   WHERE id = ? AND IFNULL(owner_email, '') <> ''
`;

interface OwnerInfo {
  /** ct_calls.owner_email — an APP USER's email, '' when unowned. */
  ownerEmail: string;
  /** That user's display name (falls back to the email), '' when unowned. */
  ownerName: string;
}

const NO_OWNER: OwnerInfo = { ownerEmail: '', ownerName: '' };

/**
 * Which APP USER should own a call answered by this raw TeleCMI agent id?
 * Returns null — leave it unowned, first-claim will settle it from the browser —
 * rather than guessing. owner_email MUST always be a real, active app user: it
 * is compared against the signed-in user on every write check, so a value that
 * matches nobody would fail those comparisons silently and lock the call to a
 * ghost until a manager overrode it.
 *
 * The ladder mirrors resolveAgentLabel() in ./agents.ts:
 *   agent_map has this id  → the mapped email (the admin's explicit intent)
 *   no mapping at all      → the raw id itself, because device-dialed callbacks
 *                            store the GRE's own email in agent_user
 * A mapping that exists but does NOT resolve to an active user returns null: the
 * admin's map is authoritative, so we must not second-guess a bad entry with the
 * raw-id fallback. That is the unmapped/mis-mapped case the owner settled as
 * FIRST CLAIM WINS.
 */
function ownerCandidate(
  db: Database.Database,
  rawAgent: string | undefined | null,
): { email: string; name: string } | null {
  const raw = String(rawAgent || '').trim();
  if (!raw) return null;
  try {
    // getAgentMap returns a NULL-prototype object, so a literal '__proto__'
    // agent id cannot reach Object.prototype here.
    const map = getAgentMap(db);
    const mapped = map[raw] || map[raw.toLowerCase()];
    const candidate = typeof mapped === 'string' && mapped.trim() ? mapped.trim() : raw;
    // is_active matters: a mapped agent whose user has since been deactivated
    // cannot sign in, so owning the call would just lock it for the write-up
    // window against the GRE who actually handled it.
    const row = db
      .prepare(`SELECT email, name FROM users WHERE is_active = 1 AND lower(email) = lower(?) LIMIT 1`)
      .get(candidate) as { email: string; name: string } | undefined;
    const email = String(row?.email || '').trim();
    if (!email) return null; // not one of our users → stays unowned by design
    return { email, name: String(row?.name || '').trim() || email };
  } catch (e) {
    console.error('[ct-ingest] owner candidate lookup failed', e);
    return null; // never let ownership resolution break ingestion
  }
}

/**
 * Read the row's CURRENT owner for the outgoing CtEvent. Read back rather than
 * echo what we just tried to write: after a lost race the truthful answer is the
 * OTHER person, and every browser reacts to this event.
 *
 * The name lookup is deliberately local instead of call-owner.ts's
 * ownerDisplayName() — importing that module would pull @/lib/auth →
 * next/headers into the webhook path (see the block comment above). There is no
 * drift risk: this resolves a name, it does not decide anything.
 */
function ownerOf(db: Database.Database, callId: string | undefined | null): OwnerInfo {
  const id = String(callId || '').trim();
  if (!id) return NO_OWNER;
  try {
    const row = db
      .prepare(`SELECT IFNULL(owner_email, '') AS owner_email FROM ct_calls WHERE id = ?`)
      .get(id) as { owner_email: string } | undefined;
    const email = String(row?.owner_email || '').trim();
    if (!email) return NO_OWNER;
    const named = db
      .prepare(`SELECT name FROM users WHERE lower(email) = lower(?) LIMIT 1`)
      .get(email) as { name?: string } | undefined;
    return { ownerEmail: email, ownerName: String(named?.name || '').trim() || email };
  } catch (e) {
    console.error('[ct-ingest] owner read failed', e);
    return NO_OWNER;
  }
}

/** Stamp the answering agent onto an unowned answered call, then report who
 *  actually holds it. `claimedAt` is the moment WE recorded the claim (not the
 *  answer time): it is only ever read as the expiry anchor when ended_at is
 *  blank, and "when ownership started" is what that anchor means. */
function stampAnsweredOwner(
  db: Database.Database,
  callId: string | undefined | null,
  rawAgent: string | undefined | null,
  claimedAt: string,
): OwnerInfo {
  const id = String(callId || '').trim();
  if (!id) return NO_OWNER;
  try {
    const cand = ownerCandidate(db, rawAgent);
    if (cand) db.prepare(STAMP_OWNER_SQL).run(cand.email, claimedAt, id);
  } catch (e) {
    console.error('[ct-ingest] owner stamp failed', e);
  }
  return ownerOf(db, id);
}

/**
 * The CDR is the source of truth on answered-vs-missed, so it settles ownership
 * both ways and returns the row's owner afterwards:
 *   answered → stamp the answering agent if the row is still unowned;
 *   anything else (missed / abandoned / voicemail) → CLEAR any owner. The live
 *     'answer' notify is optimistic — TeleCMI can announce a bridge that the CDR
 *     later reports as failed/busy/cancelled — and that same CDR files the call
 *     into the recovery queue, where it must be visible and writable by everyone.
 *     Leaving the optimistic stamp behind would lock a missed call for the whole
 *     write-up window against the very people meant to chase it.
 *
 * THE CLEAR IS DELIBERATELY NOT GATED ON THE ROW'S OWN answered_at. It is
 * tempting to only un-stamp rows that no longer look answered, but that guard
 * would never fire in the exact case it is meant for: the upsert above keeps a
 * live-notify answered_at (COALESCE) while flipping status to 'missed', so the
 * reclassified row still reads as "answered" to call-owner.ts's answeredSql().
 * The incoming CDR's verdict is the signal here, not the row's leftover flag.
 */
function settleOwnerFromCdr(
  db: Database.Database,
  callId: string,
  cdr: { status: string; agent: string },
  now: string,
): OwnerInfo {
  if (cdr.status === 'answered') return stampAnsweredOwner(db, callId, cdr.agent, now);
  try { db.prepare(CLEAR_OWNER_SQL).run(callId); }
  catch (e) { console.error('[ct-ingest] owner clear failed', e); }
  return ownerOf(db, callId);
}

// ─── Internal helpers ───────────────────────────────────────────────────────

const MISSED_FAMILY = new Set(['missed', 'abandoned', 'voicemail']);
const OPEN_RECOVERY = `('pending', 'attempting')`; // interpolated as a literal, never user input

/**
 * Round-robin auto-assignment pool for new recoveries. Returns '' (unassigned
 * pool) unless auto_assign === 'round_robin' AND a pool exists.
 *
 * Pool, in order of preference:
 *   1. agent_map values — the emails an admin explicitly mapped from TeleCMI
 *      agents (the intended, admin-controlled source).
 *   2. Active users whose page_access EXPLICITLY grants a /crm-calls page —
 *      mirrors the "explicit page list only" rule used by the notification
 *      bell so a follow-role user (page_access NULL) is never auto-assigned
 *      recoveries they didn't opt into.
 * If the pool is empty, returns '' (stays in the unassigned pool). A rotating
 * cursor persisted in ct_settings keeps distribution even.
 */
function nextAssignee(db: Database.Database): string {
  if (ctSetting(db, 'auto_assign') !== 'round_robin') return '';
  let pool: string[] = [];
  try {
    const raw = ctSetting(db, 'agent_map') || '{}';
    const map = JSON.parse(raw);
    if (map && typeof map === 'object') {
      pool = [...new Set(Object.values(map).map(v => String(v || '').trim()).filter(Boolean))];
    }
  } catch { /* malformed agent_map → fall through */ }
  if (pool.length === 0) {
    try {
      const rows = db
        .prepare(`SELECT email, page_access FROM users WHERE is_active = 1 AND page_access IS NOT NULL AND page_access LIKE '%/crm-calls%'`)
        .all() as Array<{ email: string; page_access: string }>;
      pool = rows
        .filter(r => {
          try {
            const pages = JSON.parse(r.page_access) as string[];
            return Array.isArray(pages) && pages.some(p => p === '/crm-calls' || p.startsWith('/crm-calls'));
          } catch { return false; }
        })
        .map(r => String(r.email || '').trim())
        .filter(Boolean);
      pool = [...new Set(pool)].sort(); // stable order so the cursor is meaningful
    } catch { /* users query failed → unassigned */ }
  }
  if (pool.length === 0) return '';
  const cursor = parseInt(ctSetting(db, 'auto_assign_cursor') || '0', 10) || 0;
  const pick = pool[cursor % pool.length];
  try { setCtSetting(db, 'auto_assign_cursor', String((cursor + 1) % 1_000_000)); } catch { /* best-effort */ }
  return pick || '';
}

/** Emit to SSE subscribers AND the poll-fallback ring buffer — always both. */
function emit(evt: CtEvent): void {
  try {
    emitCt(evt);
    pushRecentCt(evt);
  } catch (e) {
    console.error('[ct-ingest] emit failed', e);
  }
}

interface GuestRow {
  id: string;
  name: string;
  tags: string;
  phone_e164: string;
}

function guestByPhone(db: Database.Database, phone: string): GuestRow | undefined {
  if (!phone) return undefined;
  return db
    .prepare(`SELECT id, name, tags, phone_e164 FROM ct_guests WHERE phone_e164 = ?`)
    .get(phone) as GuestRow | undefined;
}

/**
 * Badge-lite guest snapshot for screen-pop events (the full badge logic lives
 * in metrics.ts — this is a cheap approximation with the same rules).
 */
function guestSnapshot(db: Database.Database, phone: string): CtEvent['guest'] {
  const g = guestByPhone(db, phone);
  if (!g) return null;

  let tags: string[] = [];
  try {
    const parsed = JSON.parse(g.tags || '[]');
    if (Array.isArray(parsed)) tags = parsed.map(t => String(t));
  } catch { /* malformed tags → show none */ }

  const totalCalls = (db
    .prepare(`SELECT COUNT(*) AS n FROM ct_calls WHERE guest_id = ? OR phone_e164 = ?`)
    .get(g.id, phone) as { n: number }).n;
  // All four are single index seeks on guest_id (COUNT is covered by
  // idx_ct_bookings_guest — 0.01ms against the 82,128-row copy) and stay that
  // way as the archive grows. is_duplicate = 0 because these counts decide the
  // badge the GRE sees mid-call: metrics.ts computes REPEAT GUEST from deduped
  // rows, and a screen-pop that counted Reservego's same-day re-emissions would
  // promote a two-visit guest that the CRM page then calls a one-visit guest.
  const totalBookings = (db
    .prepare(`SELECT COUNT(*) AS n FROM ct_bookings WHERE guest_id = ? AND is_duplicate = 0`)
    .get(g.id) as { n: number }).n;
  const converted = (db
    .prepare(`SELECT COUNT(*) AS n FROM ct_bookings WHERE guest_id = ? AND is_duplicate = 0 AND status IN ('seated','completed')`)
    .get(g.id) as { n: number }).n;
  const completed = (db
    .prepare(`SELECT COUNT(*) AS n FROM ct_bookings WHERE guest_id = ? AND is_duplicate = 0 AND status = 'completed'`)
    .get(g.id) as { n: number }).n;
  const lastVisit = (db
    .prepare(`
      SELECT MAX(COALESCE(NULLIF(booking_date, ''), updated_at)) AS at
      FROM ct_bookings WHERE guest_id = ? AND is_duplicate = 0 AND status IN ('seated','completed')
    `)
    .get(g.id) as { at: string | null }).at;

  let badge = '';
  if (totalCalls <= 1 && totalBookings === 0) badge = 'NEW CALLER';
  else if (converted >= 1) {
    const lastMs = lastVisit ? new Date(lastVisit).getTime() : NaN;
    if (!isNaN(lastMs) && Date.now() - lastMs > 45 * 86_400_000) badge = 'LAPSED';
    else if (completed >= 2) badge = 'REPEAT GUEST';
    else badge = 'CONVERTED';
  } else badge = 'ENQUIRED–NOT CONVERTED';

  return {
    id: g.id,
    name: g.name,
    tags,
    total_calls: totalCalls,
    total_bookings: totalBookings,
    last_visit_at: lastVisit ?? null,
    badge,
  };
}

function pendingRecoveryCount(db: Database.Database): number {
  return (db
    .prepare(`SELECT COUNT(*) AS n FROM ct_recoveries WHERE status IN ${OPEN_RECOVERY}`)
    .get() as { n: number }).n;
}

function emitRecoveryUpdate(db: Database.Database, phone?: string): void {
  emit({
    type: 'recovery_update',
    phone: phone || undefined,
    recoveryCount: pendingRecoveryCount(db),
    at: new Date().toISOString(),
  });
}

function appendAttempt(attemptsJson: string, attempt: Record<string, unknown>): string {
  let arr: unknown[] = [];
  try {
    const parsed = JSON.parse(attemptsJson || '[]');
    if (Array.isArray(parsed)) arr = parsed;
  } catch { /* corrupt attempts JSON → start fresh, never lose the new attempt */ }
  arr.push(attempt);
  return JSON.stringify(arr);
}

function safeStringify(raw: unknown): string {
  try {
    return JSON.stringify(raw) ?? '{}';
  } catch {
    return '{}';
  }
}

/**
 * Fire-and-forget WhatsApp acknowledgement for a freshly detected missed call.
 *
 * Called ONLY when createRecovery actually inserted a row, so a re-delivered
 * CDR (which resolves to the same ct_calls id and therefore the same UNIQUE
 * ct_recoveries.call_id) never reaches this at all — and even if it did,
 * maybeAckMissedCall claims a one-per-recovery slot before sending.
 *
 * Everything is off by default: with ct_settings.missed_call_whatsapp = '0'
 * AND after_hours_whatsapp = '0', maybeAckMissedCall returns 'disabled'
 * having written nothing. Dynamic import so the webhook path never pays for
 * the WhatsApp module when the feature is off, and so a failure in it can
 * never break ingestion. NEVER throws.
 */
function ackMissedCall(callId: string, phone: string): void {
  try {
    void import('./missed-ack')
      .then(({ maybeAckMissedCall }) => maybeAckMissedCall(callId))
      .then(outcome => {
        // Refresh the Recovery board so the new attempts entry shows up.
        if (outcome === 'sent' || outcome === 'send_failed') {
          try { emitRecoveryUpdate(getDb(), phone); } catch { /* best-effort */ }
        }
      })
      .catch(e => console.error('[ct-ingest] missed-call WhatsApp ack failed', e));
  } catch (e) {
    console.error('[ct-ingest] missed-call WhatsApp ack failed', e);
  }
}

/** INSERT OR IGNORE a recovery for a missed call (call_id UNIQUE = the dedupe). */
function createRecovery(
  db: Database.Database,
  opts: {
    callId: string; phone: string; missedAt: string;
    detectedVia: 'cdr' | 'live_event' | 'backfill';
    /** This leg's conversation_id, '' when the payload named none. See
     *  absorbIntoOpenRecovery() — '' is UNGROUPABLE and falls to the window. */
    conversationId?: string;
    /** This leg's direction. Only a GUEST's unanswered ring may be merged into
     *  an existing chase — see absorbIntoOpenRecovery(). Defaults to inbound,
     *  which is what the mapper falls back to for an unreadable payload. */
    direction?: 'inbound' | 'outbound';
  },
): boolean {
  if (!opts.phone) {
    // No dialable number → nothing to call back. Tracked in ct_calls only.
    console.warn('[ct-ingest] missed call without phone — recovery skipped', opts.callId);
    return false;
  }
  // call_id is UNIQUE — bail early on a re-delivered missed CDR so we never
  // advance the round-robin cursor for a recovery we won't actually create.
  const dupe = db.prepare(`SELECT 1 FROM ct_recoveries WHERE call_id = ? LIMIT 1`).get(opts.callId);
  if (dupe) return false;

  // ...and the same guard for a leg that was ABSORBED into somebody else's row
  // rather than creating its own. ct_recoveries.call_id only ever names the ONE
  // leg that won the INSERT, so without this ledger check a re-delivered
  // webhook, a backfill re-run, or the ordinary late-CDR sequence would absorb
  // the same ring a second time and add +1 to a count the guest never dialled.
  if (alreadyAbsorbedLeg(db, opts.callId)) return false;

  // ALREADY SPOKEN TO? If another leg of THIS routed call was answered, the
  // guest reached us and there is no callback debt to file — even though this
  // leg's own CDR says 'missed'. Without this an answered leg delivered before
  // its missed siblings opens a pending task for a call somebody picked up,
  // and fires a "sorry we missed you" WhatsApp at a guest we just spoke to.
  if (conversationWasAnswered(db, opts)) return false;

  // ONE RECOVERY PER CALL. A hunt group rings agent after agent and files a
  // missed CDR for each, so this is reached once per LEG. If this miss belongs
  // to a call we are already chasing, count it there and file nothing new —
  // which also means ackMissedCall() does not fire again, so the guest is not
  // WhatsApped once per extension that failed to pick up.
  if (absorbIntoOpenRecovery(db, opts)) return false;

  const now = new Date().toISOString();
  const guest = guestByPhone(db, opts.phone);
  const assignee = nextAssignee(db); // '' unless auto_assign=round_robin with a pool
  const info = db
    .prepare(`
      INSERT OR IGNORE INTO ct_recoveries
        (id, call_id, guest_id, phone_e164, missed_at, detected_via, sla_due_at, status,
         assigned_to, attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, '[]', ?, ?)
    `)
    .run(
      generateId(), opts.callId, guest?.id ?? null, opts.phone,
      opts.missedAt, opts.detectedVia, slaDueAt(opts.missedAt, db), assignee, now, now,
    );
  return info.changes > 0;
}

/** How far apart two rings may be and still be treated as ONE call.
 *  Owner's rule, 2026-08-20: "if guest has called 3 times or more in less than
 *  15 min keep it as 1 call; if the duration between 2 calls is more than
 *  15 min keep as 2 different calls and different recovery queues."
 *  The window SLIDES — it is measured from the PREVIOUS ring in the chain, not
 *  from the first — so a guest still trying at minute 30 in ten-minute bursts
 *  is one unanswered problem, which is what he confirmed he wanted. */
const RECOVERY_MERGE_WINDOW_MS = 15 * 60 * 1000;

/** How far apart two legs of ONE routed call may be STAMPED before we refuse to
 *  believe they are the same call. A hunt group's legs are seconds apart (25s
 *  ring each), so hours is already absurdly generous — its whole job is to stop
 *  a conversation_id that is REUSED (or degenerate: TeleCMI's looser aliases
 *  `sessionid`/`sessionuuid` may mean session, and a numeric field stringifies
 *  to "0") from silently swallowing an unrelated call weeks later. Delivery may
 *  be arbitrarily late — this bounds the CLOCK on the ring, not its arrival. */
const CONVERSATION_SPAN_MS = 6 * 60 * 60 * 1000;

/** A recovery whose loop is closed. Everything else — including 'expired' and
 *  'unreachable' — is still a task the queue offers Attempt/WhatsApp on, so it
 *  is still the row a fresh ring belongs to. */
const RESOLVED_RECOVERY = `('recovered', 'auto_resolved')`;

/** Was this exact leg already counted into some other recovery? */
function alreadyAbsorbedLeg(db: Database.Database, callId: string): boolean {
  try {
    return !!db.prepare(`SELECT 1 FROM ct_recovery_legs WHERE call_id = ? LIMIT 1`).get(callId);
  } catch {
    return false; // ledger unavailable → fall through and file/merge as before
  }
}

/**
 * Did another leg of this same routed call get ANSWERED? Then the guest was
 * spoken to and this 'missed' leg carries no callback debt.
 *
 * Bounded exactly like the conversation rung below — same phone, same
 * conversation, same 6-hour stamp span — because an unbounded or phone-free
 * conversation match is how a degenerate id silently mutes the queue.
 * Dormant until TeleCMI actually sends conversation ids on this account.
 */
function conversationWasAnswered(
  db: Database.Database,
  opts: { phone: string; missedAt: string; conversationId?: string },
): boolean {
  try {
    const conversationId = String(opts.conversationId || '').trim();
    if (!conversationId) return false;
    const missedMs = Date.parse(opts.missedAt);
    if (isNaN(missedMs)) return false;
    return !!db.prepare(`
      SELECT 1 FROM ct_calls
       WHERE conversation_id = ?
         AND phone_e164 = ?
         AND status = 'answered'
         AND COALESCE(NULLIF(started_at, ''), created_at) BETWEEN ? AND ?
       LIMIT 1
    `).get(
      conversationId, opts.phone,
      new Date(missedMs - CONVERSATION_SPAN_MS).toISOString(),
      new Date(missedMs + CONVERSATION_SPAN_MS).toISOString(),
    );
  } catch {
    return false; // never suppress a task because a lookup failed
  }
}

/**
 * Is this miss part of a call we are ALREADY chasing? Returns true when it was
 * counted into an existing recovery (so the caller must not file a new one).
 *
 * ONLY A GUEST'S RING MERGES. MISSED_FAMILY is direction-blind and the mapper
 * turns an unanswered OUTBOUND leg into status 'missed' too, so without this a
 * GRE tapping Call Back and getting no answer would land on the guest's own
 * chain: the badge would claim the guest rang again, and — worse — our own
 * dialling would slide the 15-minute window forward and merge two guest rings
 * genuinely 20 minutes apart, in flat violation of the owner's rule.
 *
 * Two rungs, strongest evidence first:
 *
 *  (a) SAME conversation_id — literally the same routed call, so this absorbs
 *      REGARDLESS of the recovery's status: a late-arriving leg CDR must never
 *      open a second task for a call another leg already closed. It is still
 *      bounded by PHONE and by CONVERSATION_SPAN_MS, because "same id" is only
 *      as trustworthy as the PBX field behind it — an id shared by a transfer
 *      leg on a different number, or a constant/degenerate value, would
 *      otherwise suppress the callback task for every other guest. '' is
 *      UNGROUPABLE per the column's contract and never reaches this query.
 *
 *  (b) SAME phone within the sliding window, into any recovery that is not
 *      already resolved. If the loop was closed — we called them back — a fresh
 *      miss is a fresh debt and deserves its own row, so a resolved recovery is
 *      never silently reopened. 'expired' and 'unreachable' DO absorb: the queue
 *      still shows and still works those rows, and a guest ringing again two
 *      minutes after a GRE marked them unreachable is the owner's original
 *      complaint (two rows, two WhatsApps), not a new debt.
 *
 * THE WINDOW IS SYMMETRIC. The test is "this ring is within 15 minutes of the
 * chain", not merely "the chain is recent enough for this ring": the chain's
 * LAST ring must not be older than missedAt - 15min AND its FIRST ring must not
 * be newer than missedAt + 15min. A one-sided lower bound reads as "not more
 * than 15 minutes NEWER than me", which lets any older miss delivered late —
 * webhook retry, or the backfill route replaying up to 5,000 CDRs / 90 days —
 * fold into today's chain and lose its own task, SLA and acknowledgement
 * entirely. It also lets one future-dated stamp keep a row swallowing that
 * number's calls forever.
 *
 * missed_at anchors the SLA to when the guest FIRST tried, so absorbing a later
 * ring never advances it. It IS pulled BACKWARDS (with sla_due_at recomputed)
 * when an out-of-order delivery reveals an earlier ring than the one that
 * happened to arrive first — otherwise "anchored to the first ring" would only
 * hold when the CDRs arrive in order, and the guest would be handed slack they
 * never earned.
 *
 * On ANY failure: false — file the recovery. A duplicate task is a nuisance; a
 * missed guest with no task at all is the thing this module exists to prevent.
 */
function absorbIntoOpenRecovery(
  db: Database.Database,
  opts: {
    callId: string; phone: string; missedAt: string;
    conversationId?: string; direction?: 'inbound' | 'outbound';
  },
): boolean {
  try {
    if (opts.direction === 'outbound') return false;   // our dial, not their ring

    const missedMs = Date.parse(opts.missedAt);
    if (isNaN(missedMs)) return false;                 // unreadable clock → file it
    const conversationId = String(opts.conversationId || '').trim();

    type Target = {
      id: string; missed_at: string; last_missed_at: string | null;
      missed_count: number; sla_due_at: string; guest_id: string | null;
    };
    const COLS = `r.id, r.missed_at, r.last_missed_at, r.missed_count, r.sla_due_at, r.guest_id`;
    // A recovery filed FOR one of our own unanswered callbacks is not a chain
    // of guest rings, so it is not a merge target either. '<> outbound' rather
    // than '= inbound' so a blank/unknown direction still merges — the owner's
    // duplicate-rows complaint matters more than excluding an ambiguous row.
    const NOT_OURS = `c.direction <> 'outbound'`;
    let row: Target | undefined;

    if (conversationId) {
      row = db.prepare(`
        SELECT ${COLS} FROM ct_recoveries r
          JOIN ct_calls c ON c.id = r.call_id
         WHERE c.conversation_id = ?
           AND r.call_id <> ?
           AND r.phone_e164 = ?
           AND ${NOT_OURS}
           AND r.missed_at BETWEEN ? AND ?
      ORDER BY r.missed_at DESC
         LIMIT 1
      `).get(
        conversationId, opts.callId, opts.phone,
        new Date(missedMs - CONVERSATION_SPAN_MS).toISOString(),
        new Date(missedMs + CONVERSATION_SPAN_MS).toISOString(),
      ) as Target | undefined;
    }

    if (!row) {
      row = db.prepare(`
        SELECT ${COLS} FROM ct_recoveries r
          JOIN ct_calls c ON c.id = r.call_id
         WHERE r.phone_e164 = ?
           AND r.call_id <> ?
           AND r.status NOT IN ${RESOLVED_RECOVERY}
           AND ${NOT_OURS}
           AND COALESCE(NULLIF(r.last_missed_at, ''), r.missed_at) >= ?
           AND r.missed_at <= ?
      ORDER BY COALESCE(NULLIF(r.last_missed_at, ''), r.missed_at) DESC
         LIMIT 1
      `).get(
        opts.phone, opts.callId,
        new Date(missedMs - RECOVERY_MERGE_WINDOW_MS).toISOString(),
        new Date(missedMs + RECOVERY_MERGE_WINDOW_MS).toISOString(),
      ) as Target | undefined;
    }

    if (!row) return false;

    const now = new Date().toISOString();

    // RECORD THE LEG, THEN COUNT FROM THE LEDGER. Recomputing beats +1: the
    // same ring re-delivered is an INSERT OR IGNORE no-op, so the count cannot
    // drift, and a count that already drifted repairs itself on the next merge.
    // If the ledger table is missing we still merge (the owner's rule is what
    // matters) and fall back to the blind increment.
    let legs: number | null = null;
    try {
      db.prepare(`
        INSERT OR IGNORE INTO ct_recovery_legs (call_id, recovery_id, missed_at, absorbed_at)
        VALUES (?, ?, ?, ?)
      `).run(opts.callId, row.id, opts.missedAt, now);
      legs = (db
        .prepare(`SELECT COUNT(*) AS n FROM ct_recovery_legs WHERE recovery_id = ?`)
        .get(row.id) as { n: number }).n;
    } catch (e) {
      console.error('[ct-ingest] recovery leg ledger unavailable — counting blind', e);
    }

    // The chain's newest ring: GREATEST-style, so an out-of-order leg cannot
    // drag the sliding window backwards.
    const chainLast = (row.last_missed_at || '').trim() || row.missed_at;
    const chainLastMs = Date.parse(chainLast);
    const newLast = (isNaN(chainLastMs) || missedMs > chainLastMs) ? opts.missedAt : chainLast;

    // The chain's oldest ring: LEAST-style, and the SLA follows it.
    const chainFirstMs = Date.parse(row.missed_at);
    const pullBack = !isNaN(chainFirstMs) && missedMs < chainFirstMs;

    db.prepare(`
      UPDATE ct_recoveries
         SET missed_count   = ?,
             last_missed_at = ?,
             missed_at      = ?,
             sla_due_at     = ?,
             guest_id       = COALESCE(guest_id, ?),
             updated_at     = ?
       WHERE id = ?
    `).run(
      legs === null ? (Number(row.missed_count) || 1) + 1 : 1 + legs,
      newLast,
      pullBack ? opts.missedAt : row.missed_at,
      pullBack ? slaDueAt(opts.missedAt, db) : row.sla_due_at,
      // A leg that arrived before the guest record existed left guest_id NULL
      // and the row reading "Unknown caller"; the merge removed the second
      // chance a later leg used to provide, so take it here.
      row.guest_id ? null : (guestByPhone(db, opts.phone)?.id ?? null),
      now,
      row.id,
    );
    // The board's ×N badge and "last rang" only move on a re-fetch otherwise —
    // an absorbed ring emits no call-level event of its own.
    emitRecoveryUpdate(db, opts.phone);
    return true;
  } catch (e) {
    console.error('[ct-ingest] recovery merge check failed — filing separately', e);
    return false;
  }
}

// ─── IS THIS ENDED LEG THE END OF THE CALL? ─────────────────────────────────
//
// THE BUG THIS EXISTS FOR (owner, 2026-08-17, with TeleCMI's own log as
// evidence): the venue rings a HUNT GROUP, so ONE inbound call rings agent
// after agent and TeleCMI files EVERY leg as its own CDR —
//   07:13:56 Missed by PUSHPA B (ring 25s) · 07:14:21 Missed by Nisha Sharma
//   (ring 25s) · 07:14:46 Picked by Bharath D — one caller, one conversation.
// Ingest emitted `call_ended` for every one of those CDRs, and the screen-pop
// turns any `call_ended` into "CALL ENDED — LOG OUTCOME". So the instant the
// call stopped ringing ONE extension every browser was told the call was over
// and asked to write it up, while it was still ringing the next GRE.
//
// A MISSED CDR MEANS "IT STOPPED RINGING THAT EXTENSION", NOT "THE CALL ENDED".
// This decides which of the two it was, from evidence only, in the order the
// evidence deserves:
//   (a) conversation_id — TeleCMI's `conversation_uuid`, shared by every leg of
//       the one routed call (see CONVERSATION_KEYS in ./telecmi-mapper.ts, and
//       the ct_calls.conversation_id migration in db.ts). Another leg of THIS
//       conversation still up ⇒ 'missed_leg'. When we HAVE this key it is the
//       whole answer, so (b) is not consulted: a conversation with no other live
//       leg genuinely has ended.
//   (b) only when no conversation id is available at all ('' = UNGROUPABLE, per
//       the column's contract — never "same conversation as the other blanks"):
//       a live call from the SAME phone that started in the last 90 seconds is,
//       on a hunt group whose legs ring 25s apart, the next leg of this call.
//   (c) otherwise 'final' — today's behaviour, unchanged.
//
// "STILL UP" IS status IN ('ringing','answered') AND A BLANK ended_at, the same
// bound the live-hangup fallback uses. The status test alone would be wrong in
// the direction that matters: an ANSWERED row keeps status='answered' forever
// after it completes, so yesterday's answered call would make every missed CDR
// from that number look like a live sibling and the pop would never settle.
//
// The current leg is excluded by id — it was just upserted (missed, ended_at
// set), but a row must never be its own evidence.
const LIVE_SIBLING_BY_CONVERSATION_SQL = `
  SELECT 1 FROM ct_calls
   WHERE conversation_id = ?
     AND id <> ?
     AND status IN ('ringing', 'answered')
     AND IFNULL(ended_at, '') = ''
   LIMIT 1
`;

const LIVE_SIBLING_BY_PHONE_SQL = `
  SELECT 1 FROM ct_calls
   WHERE phone_e164 = ?
     AND id <> ?
     AND status IN ('ringing', 'answered')
     AND IFNULL(ended_at, '') = ''
     AND COALESCE(NULLIF(started_at, ''), created_at) >= ?
   LIMIT 1
`;

/** How far back the phone fallback looks. The measured hunt group hands the
 *  call on every 25s; 90s covers three such hops and still cannot reach a
 *  separate call from the same guest minutes later. */
const HUNT_GROUP_PHONE_WINDOW_MS = 90_000;

/**
 * 'missed_leg' when this ended leg may not be the end of the call, 'final' when
 * it is. Only ever asked about a MISSED-family CDR — an answered CDR is always
 * final (somebody picked up; that IS the conversation).
 *
 * ON ANY FAILURE, 'final': the missed-call RECOVERY QUEUE is the safety net for
 * a call wrongly called over, and a pop wrongly left open has none — nothing
 * later retracts a 'missed_leg', so it must be claimed on evidence or not at all.
 */
function missedLegFinality(
  db: Database.Database,
  opts: { callId: string; conversationId: string; phone: string; now: string },
): 'missed_leg' | 'final' {
  try {
    const conversationId = String(opts.conversationId || '').trim();
    if (conversationId) {
      const sibling = db.prepare(LIVE_SIBLING_BY_CONVERSATION_SQL).get(conversationId, opts.callId);
      return sibling ? 'missed_leg' : 'final';
    }
    if (opts.phone) {
      const anchorMs = Date.parse(opts.now);
      const baseMs = isNaN(anchorMs) ? Date.now() : anchorMs;
      const cutoff = new Date(baseMs - HUNT_GROUP_PHONE_WINDOW_MS).toISOString();
      const sibling = db.prepare(LIVE_SIBLING_BY_PHONE_SQL).get(opts.phone, opts.callId, cutoff);
      return sibling ? 'missed_leg' : 'final';
    }
    return 'final';
  } catch (e) {
    console.error('[ct-ingest] leg finality check failed', e);
    return 'final';
  }
}

// ─── CDR ingestion (source of truth) ────────────────────────────────────────

/**
 * Ingest a completed-call CDR (webhook or backfill). Idempotent on
 * telecmi_call_id — re-delivery updates only missing/null fields, never
 * duplicates. Returns the ct_calls id and whether a new row was created.
 */
export function ingestCdr(raw: any): { callId: string | null; created: boolean } {
  try {
    const db = getDb();
    // Pass the configured recording base through. WITHOUT THIS ARGUMENT THE
    // SETTING IS DEAD: mapCdrPayload falls back to its hardcoded default, so
    // `recording_base_url` in ct_settings would have no effect and an admin
    // correcting a wrong base would see nothing change. This is the only
    // production ingest path for a CDR, so it is the only place the wiring can
    // live. See ctRecordingBaseUrl() in ct/settings.ts for what blank means.
    const m = mapCdrPayload(raw, {
      recordingBaseUrl: ctRecordingBaseUrl(db),
      ownNumbers: ctOwnNumbers(db),
    });
    if (!m) return { callId: null, created: false };

    // Learn BEFORE acting on the classification: this payload's own
    // virtual_number is what lets the NEXT one (a live ring/answer/hangup that
    // does not repeat the field) be recognised as the same internal leg.
    learnOwnNumber(db, m.virtualNumber);

    // ── THE INTERNAL LEG STOPS HERE ──────────────────────────────────────
    // No ct_calls row, so it never becomes a call, a recovery task pointing a
    // GRE at our own PBX, or a denominator in the answer rate. Nothing is lost:
    // the CDR webhook route wrote the RAW payload to ct_webhook_log(kind='cdr')
    // before calling us, precisely so ingest is free to decline a record.
    //
    // WHAT THIS COSTS, stated plainly: the internal leg is the record that
    // carries the answering agent and the talk time on some accounts. Suppressing
    // it means "answered by <name>" must come from the GUEST leg's CDR or from
    // the live `answer` event (which now writes agent_user — see ingestLive).
    // If a future account turns out to report the agent ONLY on the internal
    // leg, the fix is to MERGE the two legs on conversation_uuid, not to let
    // this one back into ct_calls.
    if (m.leg === 'internal') {
      console.warn(`[ct-ingest] CDR ignored as an internal leg — ${m.legNote}`);
      return { callId: null, created: false };
    }

    const now = new Date().toISOString();
    const phone = normalizePhone(m.phone);
    const guest = guestByPhone(db, phone);
    const rawJson = safeStringify(raw);
    const telecmiId = (m.telecmiCallId || '').trim();

    let callId: string;
    let created: boolean;

    if (telecmiId) {
      const existing = db
        .prepare(`SELECT id FROM ct_calls WHERE telecmi_call_id = ?`)
        .get(telecmiId) as { id: string } | undefined;
      created = !existing;

      // Upsert: INSERT fresh, or fill only missing/null fields on the existing
      // row (a live-created 'ringing' row gets finalized; a re-delivered CDR
      // becomes a no-op because ended_at is already set).
      //
      // telecmi_recorded follows the same never-downgrade discipline, with
      // 'unknown' playing the part that '' plays for recording_url: a CDR that
      // omits the flag maps to 'unknown' and must not erase a 'yes' an earlier
      // CDR established. Both halves of its CASE are deliberate — the first
      // refuses to write a non-answer over anything, the second keeps the first
      // known answer. The LIVE path (ingestLive) cannot downgrade it at all: it
      // never names the column, so a ring/answer/hangup leaves it untouched and
      // a live-created row simply takes the schema default 'unknown'.
      db.prepare(`
        INSERT INTO ct_calls
          (id, telecmi_call_id, guest_id, phone_e164, direction, status, agent_user, queue,
           started_at, answered_at, ended_at, duration_sec, recording_url, telecmi_recorded,
           conversation_id, raw_payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(telecmi_call_id) DO UPDATE SET
          guest_id      = COALESCE(ct_calls.guest_id, excluded.guest_id),
          phone_e164    = CASE WHEN ct_calls.phone_e164 = '' THEN excluded.phone_e164 ELSE ct_calls.phone_e164 END,
          direction     = CASE WHEN IFNULL(ct_calls.ended_at, '') = '' THEN excluded.direction ELSE ct_calls.direction END,
          status        = CASE WHEN IFNULL(ct_calls.ended_at, '') = '' THEN excluded.status ELSE ct_calls.status END,
          agent_user    = CASE WHEN ct_calls.agent_user = '' THEN excluded.agent_user ELSE ct_calls.agent_user END,
          queue         = CASE WHEN ct_calls.queue = '' THEN excluded.queue ELSE ct_calls.queue END,
          started_at    = COALESCE(NULLIF(ct_calls.started_at, ''), excluded.started_at),
          answered_at   = COALESCE(NULLIF(ct_calls.answered_at, ''), excluded.answered_at),
          ended_at      = COALESCE(NULLIF(ct_calls.ended_at, ''), excluded.ended_at),
          duration_sec  = CASE WHEN IFNULL(ct_calls.duration_sec, 0) = 0 THEN excluded.duration_sec ELSE ct_calls.duration_sec END,
          recording_url = CASE WHEN ct_calls.recording_url = '' THEN excluded.recording_url ELSE ct_calls.recording_url END,
          telecmi_recorded = CASE
            WHEN excluded.telecmi_recorded <> 'unknown' AND ct_calls.telecmi_recorded = 'unknown'
              THEN excluded.telecmi_recorded
            ELSE ct_calls.telecmi_recorded END,
          -- FILL-BLANK ONLY, exactly like agent_user/queue above. A leg's
          -- conversation belongs to it for good: the ring that created this row
          -- may have named it, and a later CDR (or a re-delivery) must not be
          -- able to move a leg into a different conversation. '' stays
          -- UNGROUPABLE, never "the same conversation as the other blanks".
          conversation_id = CASE WHEN IFNULL(ct_calls.conversation_id, '') = '' THEN excluded.conversation_id ELSE ct_calls.conversation_id END,
          raw_payload   = CASE WHEN ct_calls.raw_payload IN ('', '{}') THEN excluded.raw_payload ELSE ct_calls.raw_payload END
      `).run(
        generateId(), telecmiId, guest?.id ?? null, phone, m.direction, m.status,
        m.agent || '', m.queue || '', m.startedAt || now, m.answeredAt,
        m.endedAt || now, m.durationSec || 0, m.recordingUrl || '', m.recordFlag,
        m.conversationId || '', rawJson, now,
      );
      callId = (db.prepare(`SELECT id FROM ct_calls WHERE telecmi_call_id = ?`).get(telecmiId) as { id: string }).id;
    } else {
      // No TeleCMI call id → no dedupe key; store as a standalone row with a
      // NULL telecmi_call_id (empty strings would collide on the UNIQUE index).
      callId = generateId();
      created = true;
      db.prepare(`
        INSERT INTO ct_calls
          (id, telecmi_call_id, guest_id, phone_e164, direction, status, agent_user, queue,
           started_at, answered_at, ended_at, duration_sec, recording_url, telecmi_recorded,
           conversation_id, raw_payload, created_at)
        VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        callId, guest?.id ?? null, phone, m.direction, m.status,
        m.agent || '', m.queue || '', m.startedAt || now, m.answeredAt,
        m.endedAt || now, m.durationSec || 0, m.recordingUrl || '', m.recordFlag,
        m.conversationId || '', rawJson, now,
      );
    }

    // ── Missed-family → recovery workflow (the module's reason to exist) ──
    if (MISSED_FAMILY.has(m.status)) {
      const madeNew = createRecovery(db, {
        callId,
        phone,
        missedAt: m.endedAt || m.startedAt || now,
        detectedVia: 'cdr',
        // The leg's own conversation — how a hunt group's three missed CDRs
        // become one callback task instead of three.
        conversationId: m.conversationId || '',
        // Only a guest's ring may merge; our own unanswered callback is also
        // status 'missed' and must not inflate their chain.
        direction: m.direction,
      });
      if (madeNew) {
        emitRecoveryUpdate(db, phone);
        ackMissedCall(callId, phone);
      }
    }

    // ── Answered inbound → guest reached us themselves → auto-resolve ──
    // Causally bounded: an answered call only resolves misses that happened
    // AT OR BEFORE it. Without this, a re-delivered/backfilled OLDER answered
    // call would silently close a NEWER open recovery. Timestamps are UTC ISO,
    // so the string comparison is chronological.
    //
    // THE BOUND IS THE CHAIN'S LAST RING, NOT missed_at. missed_at is frozen at
    // the FIRST ring so the SLA keeps counting from it, so a merged row is
    // OLDER than rings it legitimately contains. Testing missed_at alone was
    // only safe while one row meant one ring: an answered call that happened
    // BETWEEN two rings — delivered late by a webhook retry or by the backfill
    // route, which this code already anticipates — would otherwise close rings
    // it never answered and empty the queue behind the guest's back.
    if (m.status === 'answered' && m.direction === 'inbound' && phone) {
      const answeredAt = m.answeredAt || m.endedAt || now;
      const res = db
        .prepare(`
          UPDATE ct_recoveries
          SET status = 'auto_resolved',
              resolution_note = 'Guest called back and was answered',
              updated_at = ?
          WHERE phone_e164 = ? AND status IN ${OPEN_RECOVERY}
            AND COALESCE(NULLIF(last_missed_at, ''), missed_at) <= ?
        `)
        .run(now, phone, answeredAt);
      if (res.changes > 0) emitRecoveryUpdate(db, phone);
    }

    // ── Answered outbound → this is (likely) the GRE's callback attempt ──
    // Idempotent on the source call id: if THIS outbound call was already
    // recorded against a recovery, a re-delivery/backfill must not append a
    // second identical attempt (or, worse, mis-append it to a different open
    // recovery for the same phone).
    if (m.status === 'answered' && m.direction === 'outbound' && phone
        && !db.prepare(`SELECT 1 FROM ct_recoveries WHERE recovery_call_id = ? LIMIT 1`).get(callId)) {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const rec = db
        .prepare(`
          SELECT id, attempts, first_attempt_at FROM ct_recoveries
          WHERE phone_e164 = ? AND status IN ${OPEN_RECOVERY} AND missed_at >= ?
          ORDER BY missed_at DESC LIMIT 1
        `)
        .get(phone, sevenDaysAgo) as { id: string; attempts: string; first_attempt_at: string | null } | undefined;
      if (rec) {
        const attemptAt = m.answeredAt || m.endedAt || now;
        db.prepare(`
          UPDATE ct_recoveries
          SET attempts = ?,
              first_attempt_at = COALESCE(first_attempt_at, ?),
              status = 'attempting',
              recovery_call_id = ?,
              updated_at = ?
          WHERE id = ?
        `).run(
          appendAttempt(rec.attempts, { at: attemptAt, by: m.agent || '', method: 'callback', outcome: 'answered' }),
          attemptAt, callId, now, rec.id,
        );
        // Recovery COMPLETES only when the GRE dispositions the callback
        // (booking_made → attributeBooking marks it 'recovered').
        emitRecoveryUpdate(db, phone);
      }
    }

    // OWNERSHIP, settled by the source of truth: an answered call gets the
    // answering agent (if the row is still unowned), anything else is handed
    // back to the recovery queue. Must run BEFORE the emit — the event carries
    // the result to every browser.
    const owner = settleOwnerFromCdr(db, callId, { status: m.status, agent: m.agent || '' }, now);

    // IS THE CALL ACTUALLY OVER? An ANSWERED CDR always is — somebody picked up,
    // and that is the conversation. A MISSED one is only the end of the call if
    // no other leg of it is still up: on this venue's hunt group a missed CDR
    // usually means the call has simply moved to the next extension. See
    // missedLegFinality() above for the evidence ladder and why it fails 'final'.
    const missed = MISSED_FAMILY.has(m.status);
    const leg: 'missed_leg' | 'final' = missed
      ? missedLegFinality(db, { callId, conversationId: m.conversationId || '', phone, now })
      : 'final';

    emit({
      type: 'call_ended',
      callId,
      telecmiCallId: telecmiId || undefined,
      phone: phone || undefined,
      guest: guestSnapshot(db, phone),
      agent: m.agent || undefined,
      // "answered by <name>" only makes sense for answered calls — a missed call
      // was not answered by anyone.
      agentName: m.status === 'answered' ? (agentDisplayName(db, m.agent) || undefined) : undefined,
      // WHICH AGENT JUST LET IT PASS — the other half of the owner's request, and
      // the same CDR supplies it: TeleCMI names the ringing extension on a missed
      // leg ("Missed by Agent PUSHPA B"). Kept in a field of its OWN rather than
      // agentName so no consumer can read "missed by" as "answered by".
      // resolveAgentLabel shows the RAW id when the agent is unmapped — mapping is
      // not done for these ids yet, and a blank would name nobody at all.
      missedByName: missed ? (agentDisplayName(db, m.agent) || undefined) : undefined,
      // 'missed_leg' = DO NOT tell the GRE the call is over (it is still ringing
      // somewhere); 'final' = today's behaviour. Always sent on a call_ended from
      // a CDR so no consumer has to infer it from the status.
      leg,
      // Sent as '' rather than undefined when unowned — DELIBERATE, and the one
      // place this file breaks its own `|| undefined` habit. A browser holding a
      // stale owner has to be able to learn that ownership was cleared (missed
      // CDR after an optimistic live 'answer'), and an absent field reads as "no
      // information", not "nobody". '' means UNOWNED, as documented on CtEvent.
      ownerEmail: owner.ownerEmail,
      ownerName: owner.ownerName,
      queue: m.queue || undefined,
      at: now,
    });

    // Auto AI-analysis (opt-in): when the toggle is on and this CDR carried a
    // recording, kick off the scorecard in the BACKGROUND. Fire-and-forget so
    // the webhook still acks fast — the app runs as a persistent Node server,
    // so the async task completes after the response. Errors are swallowed
    // (analyzeCtCall records its own analysis_status/error).
    if ((m.recordingUrl || '').trim() && ctSetting(db, 'auto_analyze') === '1'
        && ctSetting(db, 'analysis_retention') !== 'ephemeral') {
      void import('./analyze')
        .then(({ analyzeCtCall }) => analyzeCtCall(callId, { actor: 'auto' }))
        .catch(e => console.error('[ct-ingest] auto-analyze failed', e));
    }

    return { callId, created };
  } catch (e) {
    console.error('[ct-ingest] ingestCdr failed', e);
    return { callId: null, created: false };
  }
}

// ─── Live event ingestion (screen-pop) ──────────────────────────────────────

/**
 * Ingest a live TeleCMI event (ring / answer / hangup). Logs every payload to
 * ct_webhook_log; a ring on an inbound call upserts a 'ringing' ct_calls row
 * and fires the screen-pop. The CDR remains the source of truth.
 *
 * NOTHING IS ANNOUNCED THAT IS NOT A TRACKED CALL. All three branches now
 * resolve a ct_calls row first and emit only if they found one. Ring inserts, so
 * it always has one; answer and hangup are UPDATE-only, and before this they
 * emitted regardless — which is exactly how an internal leg with no row of its
 * own got "Call answered" and "Call ended" lines on the wallboard while never
 * appearing in "Ringing now" (it had no ring event, and ring is the only branch
 * that inserts). A guest-facing feed reports calls this system is tracking; an
 * event it cannot attach to one is triage material for ct_webhook_log, not news.
 */
export function ingestLive(raw: any): void {
  try {
    const db = getDb();
    const m = mapLivePayload(raw, { ownNumbers: ctOwnNumbers(db) });
    const now = new Date().toISOString();
    const phone = m ? normalizePhone(m.phone) : '';

    db.prepare(`
      INSERT INTO ct_webhook_log
        (id, kind, telecmi_call_id, phone_e164, event, received_at, payload, processed, error)
      VALUES (?, 'live', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      generateId(), m?.telecmiCallId || '', phone, m?.event || '', now,
      safeStringify(raw), m ? 1 : 0, m ? '' : 'unrecognized live payload shape',
    );
    if (!m) return;

    // Learn our own DID whenever a live payload happens to name it (they often
    // do not — the CDR is the reliable source). Cheap, and it makes the check
    // below self-configuring on accounts whose live events DO carry the field.
    learnOwnNumber(db, m.virtualNumber);

    // ── THE INTERNAL LEG STOPS HERE ──────────────────────────────────────
    // Placed AFTER the ct_webhook_log write above, so the payload is still kept
    // verbatim and stays greppable — we decline to ACT on it, we do not lose it.
    // No ct_calls row, no bus event, so it reaches neither the wallboard feed,
    // nor "Ringing now", nor the screen-pop.
    if (m.leg === 'internal') {
      console.warn(`[ct-ingest] live ${m.event} ignored as an internal leg — ${m.legNote}`);
      return;
    }

    const telecmiId = (m.telecmiCallId || '').trim();

    if (m.event === 'ring' && m.direction === 'inbound') {
      const guest = guestByPhone(db, phone);
      let callId: string | undefined;
      if (telecmiId) {
        db.prepare(`
          INSERT INTO ct_calls
            (id, telecmi_call_id, guest_id, phone_e164, direction, status, agent_user, queue,
             started_at, conversation_id, raw_payload, created_at)
          VALUES (?, ?, ?, ?, 'inbound', 'ringing', ?, ?, ?, ?, ?, ?)
          ON CONFLICT(telecmi_call_id) DO UPDATE SET
            guest_id   = COALESCE(ct_calls.guest_id, excluded.guest_id),
            phone_e164 = CASE WHEN ct_calls.phone_e164 = '' THEN excluded.phone_e164 ELSE ct_calls.phone_e164 END,
            started_at = COALESCE(NULLIF(ct_calls.started_at, ''), excluded.started_at),
            -- THE RING GROUP, FILL-BLANK ONLY. It is the second rung of "who is
            -- this ringing for" (see ringingForOf above), and the /live snapshot
            -- reads it off THIS ROW — so a pop that mounts mid-ring can only
            -- show the group if the row has it. A re-delivered or repeated ring
            -- for the same leg that carries a team when the first one did not
            -- now fills it in. Fill-blank, so it can never move a leg into a
            -- different group.
            queue = CASE WHEN IFNULL(ct_calls.queue, '') = '' THEN excluded.queue ELSE ct_calls.queue END,
            -- agent_user IS DELIBERATELY NOT REFRESHED HERE, and the asymmetry
            -- with queue above is the point. On a RINGING row that column holds
            -- the extension being RUNG; from the answer onward every reader
            -- (Call Log, Guest 360, agent_display on /live) treats it as the
            -- extension that ANSWERED. Those are different agents on a hunt
            -- group. The INSERT above already writes whatever the first ring
            -- named — widening that to later rings would only widen the window
            -- in which a ringing extension can be left sitting in the column and
            -- then be printed as "answered by". A group is safe to fill because
            -- it means the same thing on every path.
            conversation_id = CASE WHEN IFNULL(ct_calls.conversation_id, '') = '' THEN excluded.conversation_id ELSE ct_calls.conversation_id END
        `).run(
          generateId(), telecmiId, guest?.id ?? null, phone,
          m.agent || '', m.queue || '', m.at || now, m.conversationId || '', safeStringify(raw), now,
        );
        callId = (db.prepare(`SELECT id FROM ct_calls WHERE telecmi_call_id = ?`).get(telecmiId) as { id: string } | undefined)?.id;
      } else if (phone) {
        // Id-less ring (malformed/partial payload): still persist a standalone
        // 'ringing' row (NULL telecmi_call_id) so the authoritative /live
        // snapshot keeps the wallboard card and reconcileLiveEvents can later
        // reconcile it. Dedupe on an existing open id-less ring for this phone
        // so repeated id-less rings don't stack duplicate rows.
        const openIdless = db.prepare(
          `SELECT id FROM ct_calls WHERE telecmi_call_id IS NULL AND phone_e164 = ? AND status = 'ringing' ORDER BY started_at DESC LIMIT 1`,
        ).get(phone) as { id: string } | undefined;
        if (openIdless) {
          callId = openIdless.id;
        } else {
          callId = generateId();
          db.prepare(`
            INSERT INTO ct_calls
              (id, telecmi_call_id, guest_id, phone_e164, direction, status, agent_user, queue,
               started_at, conversation_id, raw_payload, created_at)
            VALUES (?, NULL, ?, ?, 'inbound', 'ringing', ?, ?, ?, ?, ?, ?)
          `).run(
            callId, guest?.id ?? null, phone,
            m.agent || '', m.queue || '', m.at || now, m.conversationId || '', safeStringify(raw), now,
          );
        }
      }
      // WHO IS IT RINGING FOR — resolved ONCE, for both fields below, off one
      // agent_map + user-name load (it used to be one load for the name field
      // alone, so this costs nothing extra).
      const ringFor = ringingForOf(db, m.agent, m.queue);

      // WHY THE POP SAYS "trying the next agent" AND NOT A NAME, recorded where
      // whoever asks next will find it. The mapper reads no agent off this live
      // ring — so we log the payload's own KEY NAMES (names only: a value could
      // be a guest's number, and a key name cannot). If TeleCMI does name the
      // ringing extension under a spelling AGENT_KEYS has never heard of, it is
      // in this line, and adding that one spelling turns the group rung into a
      // real name. If the line only ever shows keys that are plainly not an
      // agent, then this account's live ring genuinely does not say who it is
      // ringing, and the group is the most honest answer there is.
      //
      // Bounded by its own condition: it stops the moment a ring names an agent.
      if (!String(m.agent || '').trim()) {
        // ONE LEVEL OF ENVELOPE TOO, exactly the six the mapper's own collect()
        // flattens. A log that printed only the top level would read
        // "Payload keys: event, data" on precisely the WRAPPED payloads that
        // made this question hard, and would name none of the fields the
        // shortlist has to come from — the one mechanism for settling this would
        // fail on the only cases where it matters. Nested keys are prefixed
        // (`data.agent_no`) so the reader can see where to add the spelling.
        const keysOf = (o: unknown, prefix: string): string[] =>
          (o && typeof o === 'object' && !Array.isArray(o))
            ? Object.keys(o as Record<string, unknown>).map(k => prefix + k)
            : [];
        const top = raw as Record<string, unknown> | null | undefined;
        const all = [
          ...keysOf(raw, ''),
          ...['data', 'cdr', 'call', 'payload', 'body', 'record']
            .flatMap(nest => keysOf(top?.[nest], `${nest}.`)),
        ];
        console.warn(
          `[ct-ingest] live ring named NO agent — "ringing for" falls back to `
          + `${ringFor ? `the group "${ringFor.label}"` : 'nothing at all'}. `
          + `Payload keys: ${all.length ? all.join(', ') : '(payload is not an object)'}`,
        );
      }

      emit({
        type: 'incoming_call',
        callId,
        telecmiCallId: telecmiId || undefined,
        phone: phone || undefined,
        guest: guestSnapshot(db, phone),
        agent: m.agent || undefined,
        // WHO IS IT RINGING FOR — asked for alongside the leg fix, because on a
        // hunt group "ringing" without a name tells a GRE nothing about whether
        // it is their phone. Resolved the same way as everywhere else, so an
        // unmapped id shows as the raw id rather than as a blank. STRICTLY FROM
        // THE PAYLOAD: a ring that names no agent sends nothing here — the pop
        // must not invent an extension.
        //
        // UNCHANGED IN MEANING AND IN VALUE: ringingForLabel's 'agent' rung is
        // resolveAgentLabel, which returns a name for every non-blank id and ''
        // for a blank one — exactly what agentDisplayName() returned here before.
        ringingAgentName: ringFor?.kind === 'agent' ? ringFor.label : undefined,
        // THE SECOND RUNG, and set ONLY when the first one is empty. `queue`
        // below still carries the group verbatim for anything that wants the raw
        // fact; this field is the ANSWER to "who is it ringing for" when no
        // person was named, which is why it disappears the moment one is. A
        // renderer reading these two in order cannot print a group beside a
        // named agent, and cannot print a group as if it were a person.
        ringingGroupName: ringFor?.kind === 'group' ? ringFor.label : undefined,
        queue: m.queue || undefined,
        at: m.at || now,
      });
      return;
    }

    if (m.event === 'answer') {
      // THE ROW MUST LEAVE 'ringing', AND THIS IS THE BRANCH THAT KEPT FAILING
      // TO MAKE IT.
      //
      // The UPDATE used to sit inside `if (telecmiId)` and match on
      // telecmi_call_id alone, while the emit() below ran unconditionally — the
      // only one of the three branches with no id-less fallback (ring has one,
      // hangup has one). So an answer whose id was absent, or simply did not
      // match the row the ring created, printed "Call answered" on the wallboard
      // while the DATABASE row stayed 'ringing'. Everything downstream then read
      // that row and was faithfully wrong: "Ringing now" kept the card (its
      // snapshot is WHERE status='ringing'), the screen-pop kept counting ring
      // seconds through a live conversation, today's tiles counted the call in
      // CALLS TODAY and in NEITHER Answered nor Missed — hence ANSWERED 0 /
      // ANSWER RATE 0% beside a call the Call Log calls Answered — and five
      // minutes later reconcileLiveEvents() relabelled the answered call MISSED
      // and filed a recovery task against a guest who had already been served.
      //
      // The fallback mirrors the hangup branch's, and is bounded the same way:
      // the most recent still-'ringing' row for that phone, and nothing else, so
      // it can never reach back and rewrite a completed call.
      let answeredCallId: string | undefined;
      if (telecmiId) {
        db.prepare(`
          UPDATE ct_calls SET status = 'answered', answered_at = COALESCE(answered_at, ?)
          WHERE telecmi_call_id = ? AND status = 'ringing'
        `).run(m.at || now, telecmiId);
        answeredCallId = (db.prepare(`SELECT id FROM ct_calls WHERE telecmi_call_id = ?`).get(telecmiId) as { id: string } | undefined)?.id;
      }
      if (!answeredCallId && phone) {
        const open = db.prepare(`
          SELECT id FROM ct_calls
           WHERE phone_e164 = ? AND status = 'ringing'
           ORDER BY COALESCE(NULLIF(started_at, ''), created_at) DESC
           LIMIT 1
        `).get(phone) as { id: string } | undefined;
        if (open) {
          db.prepare(`
            UPDATE ct_calls SET status = 'answered', answered_at = COALESCE(answered_at, ?)
             WHERE id = ? AND status = 'ringing'
          `).run(m.at || now, open.id);
          answeredCallId = open.id;
        }
      }

      // NOTHING TO ANNOUNCE. No row means this answer belongs to no call this
      // system is tracking — the internal leg's case, and the reason it used to
      // print "Call answered · answered by Sh…" on a guest-facing feed. The
      // payload is already in ct_webhook_log; that is where an unattachable
      // event belongs.
      if (!answeredCallId) {
        console.warn(
          `[ct-ingest] live answer matched no tracked call (telecmi id "${telecmiId}", phone "${phone}") — not announced`,
        );
        return;
      }

      // NAME THE ANSWERER ON THE ROW, NOW. Until this, agent_user was written
      // only by the ring INSERT and the CDR upsert, so "Answered by <name>" —
      // which Guest 360 and the Call Log both derive from agent_user — could not
      // appear until the CDR landed minutes later. Fills BLANKS ONLY, so it can
      // never overwrite what an earlier event or a CDR already established.
      //
      // conversation_id rides along on the SAME blank-fill terms: an answer is
      // often the first payload of the routed call to name it, and the next
      // leg's ended-CDR asks its liveness question by that value.
      const answeringAgent = String(m.agent || '').trim();
      const answerConversation = String(m.conversationId || '').trim();
      if (answeringAgent || m.queue || answerConversation) {
        db.prepare(`
          UPDATE ct_calls
             SET agent_user = CASE WHEN IFNULL(agent_user, '') = '' THEN ? ELSE agent_user END,
                 queue      = CASE WHEN IFNULL(queue, '')      = '' THEN ? ELSE queue      END,
                 conversation_id = CASE WHEN IFNULL(conversation_id, '') = '' THEN ? ELSE conversation_id END
           WHERE id = ?
        `).run(answeringAgent, String(m.queue || ''), answerConversation, answeredCallId);
      }

      // THE MOMENT OWNERSHIP IS DECIDED for a mapped agent: whoever picked up
      // owns the write-up from here. Unmapped agent → stays unowned and the
      // first browser to act claims it. Runs after the status UPDATE above, so
      // the row already reads 'answered' and STAMP_OWNER_SQL's guard passes.
      const owner = stampAnsweredOwner(db, answeredCallId, m.agent, now);
      // Tell the Live wallboard and the screen-pop the call left the ringing
      // state in real time (the 12s ringing re-sync is the backstop; this makes
      // it instant), and WHO picked it up — agentName is what the feed prints as
      // "· answered by X" and what the pop now puts in its header.
      emit({
        type: 'answered',
        callId: answeredCallId,
        telecmiCallId: telecmiId || undefined,
        phone: phone || undefined,
        agent: m.agent || undefined,
        agentName: agentDisplayName(db, m.agent) || undefined,
        // '' = unowned, and every browser needs that fact to decide between
        // keeping the pop and collapsing to the read-only strip. Presentation
        // only — the write is gated server-side by callWriteBlock().
        ownerEmail: owner.ownerEmail,
        ownerName: owner.ownerName,
        at: m.at || now,
      });
      return;
    }

    if (m.event === 'hangup') {
      // RESOLVE THE ROW FIRST, BY EITHER HANDLE. The id lookup is the primary;
      // the phone fallback is the same one the branch already had for its UPDATE,
      // lifted up here so the resolved id is available to the emit() too — it
      // used to send callId: undefined down the id-less path, leaving the
      // screen-pop to match the card on phone alone.
      //
      // The fallback now also accepts an 'answered' row, not just a 'ringing'
      // one. It had to: once the answer branch above reliably flips the row, a
      // hangup arriving with a non-matching id would find nothing, and the pop
      // would never leave its "Incoming call" header. Bounded by an EMPTY
      // ended_at, so it only ever reaches a call still in progress and cannot
      // rewrite a completed one — which is what the old status='ringing' bound
      // achieved and must keep achieving.
      let row = telecmiId
        ? db.prepare(`SELECT id FROM ct_calls WHERE telecmi_call_id = ?`).get(telecmiId) as { id: string } | undefined
        : undefined;
      if (!row && phone) {
        row = db.prepare(`
          SELECT id FROM ct_calls
           WHERE phone_e164 = ? AND status IN ('ringing', 'answered') AND IFNULL(ended_at, '') = ''
           ORDER BY COALESCE(NULLIF(started_at, ''), created_at) DESC
           LIMIT 1
        `).get(phone) as { id: string } | undefined;
      }

      // NOTHING TO ANNOUNCE — see the same guard on the answer branch above.
      if (!row) {
        console.warn(
          `[ct-ingest] live hangup matched no tracked call (telecmi id "${telecmiId}", phone "${phone}") — not announced`,
        );
        return;
      }

      // LEAVE THE RINGING STATE. This branch used to ONLY emit to the wallboard
      // and never touch ct_calls, so status stayed 'ringing' in the database
      // after the caller had already hung up: the Live Calls board kept the card
      // up with its timer climbing, the screen-pop never dismissed, and the feed
      // said "Call ended" directly beside it. Two ghosts were enough to make the
      // board look like it only ever handles two calls.
      //
      // 'ringing' -> 'missed': the caller hung up before anyone picked up, which
      // is the definition of a missed call, and it is what puts the number into
      // the recovery queue. An already-'answered' row only gets its ended_at —
      // it was answered, and re-labelling it missed would be a lie that also
      // corrupts the answer rate.
      //
      // The CDR that follows is still authoritative: it fills in duration,
      // billed seconds and the recording, and can correct the status. This just
      // stops the board lying for the minutes in between.
      //
      // Keyed on the row id resolved above, so it works down BOTH paths — the
      // id-less one included, which previously ran a second, separately-written
      // UPDATE that could drift from this one.
      db.prepare(`
        UPDATE ct_calls
           SET status   = CASE WHEN status = 'ringing' THEN 'missed' ELSE status END,
               ended_at = COALESCE(ended_at, ?),
               conversation_id = CASE WHEN IFNULL(conversation_id, '') = '' THEN ? ELSE conversation_id END
         WHERE id = ?
           AND status IN ('ringing', 'answered')
      `).run(m.at || now, String(m.conversationId || ''), row.id);

      // Hangup does NOT change ownership — it starts the 15-minute write-up
      // window that call-owner.ts measures from ended_at. Nothing is stamped or
      // cleared here: a 'ringing' row can never have had an owner (both the
      // stamp above and claimCall require an answered row), and an answered one
      // keeps its owner precisely so the write-up stays theirs. We only READ it,
      // because this is the browsers' first news that the call ended and they
      // must not lose track of who holds it while the CDR is still minutes away.
      const owner = ownerOf(db, row.id);

      emit({
        type: 'call_ended',
        callId: row.id,
        telecmiCallId: telecmiId || undefined,
        phone: phone || undefined,
        guest: guestSnapshot(db, phone),
        ownerEmail: owner.ownerEmail,
        ownerName: owner.ownerName,
        at: m.at || now,
      });
    }
  } catch (e) {
    console.error('[ct-ingest] ingestLive failed', e);
  }
}

// ─── Safety nets ────────────────────────────────────────────────────────────

/**
 * Ring seen but no CDR ever arrived (webhook delivery gap): any ct_calls row
 * still 'ringing' with no ended_at 5+ minutes after it started is declared
 * missed and enters the recovery workflow (detected_via = 'live_event').
 * Returns how many calls were reconciled.
 */
export function reconcileLiveEvents(): number {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
    const stuck = db
      .prepare(`
        SELECT id, phone_e164, started_at, created_at, conversation_id, direction FROM ct_calls
        WHERE status = 'ringing'
          AND IFNULL(ended_at, '') = ''
          AND COALESCE(NULLIF(started_at, ''), created_at) < ?
      `)
      .all(cutoff) as Array<{
        id: string; phone_e164: string; started_at: string | null;
        created_at: string; conversation_id: string | null; direction: string | null;
      }>;

    let n = 0;
    for (const call of stuck) {
      db.prepare(`UPDATE ct_calls SET status = 'missed', ended_at = ? WHERE id = ?`).run(now, call.id);
      const madeNew = createRecovery(db, {
        callId: call.id,
        phone: call.phone_e164,
        missedAt: call.started_at || call.created_at || now,
        detectedVia: 'live_event',
        // Same merge rule on the safety-net path: a ring the CDR never arrived
        // for is still one leg of its conversation, not a separate call.
        conversationId: call.conversation_id || '',
        direction: call.direction === 'outbound' ? 'outbound' : 'inbound',
      });
      // Same missed call, other detection path — acknowledge it here too, and
      // only on a genuinely new recovery. If the CDR later arrives for this
      // call, createRecovery returns false there, so the guest is messaged once.
      if (madeNew) ackMissedCall(call.id, call.phone_e164);
      n++;
    }
    if (n > 0) emitRecoveryUpdate(db);
    return n;
  } catch (e) {
    console.error('[ct-ingest] reconcileLiveEvents failed', e);
    return 0;
  }
}

/**
 * SLA enforcement (documented simplification: expiry purely by clock):
 *   - pending + past sla_due_at            → escalated=1 (once, keeps status)
 *   - pending + past sla_due_at + SLA mins → status='expired' (2× SLA window)
 * An expired recovery can still be worked — 'expired' is a flag state, the
 * attempt actions on the queue remain available. Returns rows modified.
 */
export function expireOverdueRecoveries(): number {
  try {
    const db = getDb();
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const slaMin = Math.max(1, Number(ctSetting(db, 'sla_minutes')) || 30);

    const overdue = db
      .prepare(`
        SELECT id, sla_due_at, escalated FROM ct_recoveries
        WHERE status = 'pending' AND sla_due_at < ?
      `)
      .all(now) as Array<{ id: string; sla_due_at: string; escalated: number }>;

    let changed = 0;
    for (const rec of overdue) {
      const dueMs = new Date(rec.sla_due_at).getTime();
      const expireMs = isNaN(dueMs) ? nowMs : dueMs + slaMin * 60_000;
      if (nowMs >= expireMs) {
        db.prepare(`
          UPDATE ct_recoveries
          SET status = 'expired', escalated = 1, escalated_at = COALESCE(escalated_at, ?), updated_at = ?
          WHERE id = ? AND status = 'pending'
        `).run(now, now, rec.id);
        changed++;
      } else if (!rec.escalated) {
        db.prepare(`
          UPDATE ct_recoveries
          SET escalated = 1, escalated_at = ?, updated_at = ?
          WHERE id = ? AND escalated = 0
        `).run(now, now, rec.id);
        changed++;
      }
    }
    if (changed > 0) emitRecoveryUpdate(db);
    return changed;
  } catch (e) {
    console.error('[ct-ingest] expireOverdueRecoveries failed', e);
    return 0;
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __fnbCtSweepAt__: number | undefined;
}

/**
 * Cheap combined safety-net pass, invoked opportunistically from recovery /
 * dashboard / inbox GETs. Self-throttles to once per 10s so hot polling
 * endpoints never pay the sweep cost repeatedly.
 */
export function sweep(): void {
  try {
    const last = globalThis.__fnbCtSweepAt__ ?? 0;
    if (Date.now() - last < 10_000) return;
    globalThis.__fnbCtSweepAt__ = Date.now();
    reconcileLiveEvents();
    expireOverdueRecoveries();
  } catch (e) {
    console.error('[ct-ingest] sweep failed', e);
  }
}

// ─── Booking attribution ────────────────────────────────────────────────────

/**
 * Call→booking attribution (run after every booking create):
 *   1. Booking without source_call_id → newest ANSWERED INBOUND call for the
 *      same guest (by guest_id or the guest's phone) within the attribution
 *      window (ct setting, default 48h) → linked as source_call_id.
 *   2. If the source call (as the missed call itself or as the recorded
 *      callback recovery_call_id) belongs to an open recovery for the same
 *      phone → recovery_booking_id linked, status='recovered' ★.
 */
export function attributeBooking(bookingId: string): void {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const booking = db
      .prepare(`SELECT id, guest_id, source_call_id, created_at FROM ct_bookings WHERE id = ?`)
      .get(bookingId) as { id: string; guest_id: string; source_call_id: string | null; created_at: string } | undefined;
    if (!booking) return;

    const guest = db
      .prepare(`SELECT id, phone_e164 FROM ct_guests WHERE id = ?`)
      .get(booking.guest_id) as { id: string; phone_e164: string } | undefined;
    const guestPhone = guest?.phone_e164 || '';

    let sourceCallId = booking.source_call_id || null;

    if (!sourceCallId) {
      const attributionHours = Math.max(1, Number(ctSetting(db, 'attribution_hours')) || 48);
      const bookedAtMs = new Date(booking.created_at).getTime();
      const anchorMs = isNaN(bookedAtMs) ? Date.now() : bookedAtMs;
      const windowStart = new Date(anchorMs - attributionHours * 3_600_000).toISOString();

      const call = db
        .prepare(`
          SELECT id FROM ct_calls
          WHERE (guest_id = ? OR (phone_e164 != '' AND phone_e164 = ?))
            AND direction = 'inbound' AND status = 'answered'
            AND COALESCE(NULLIF(started_at, ''), created_at) >= ?
          ORDER BY COALESCE(NULLIF(started_at, ''), created_at) DESC
          LIMIT 1
        `)
        .get(booking.guest_id, guestPhone, windowStart) as { id: string } | undefined;

      if (call) {
        sourceCallId = call.id;
        db.prepare(`UPDATE ct_bookings SET source_call_id = ?, updated_at = ? WHERE id = ?`)
          .run(sourceCallId, now, bookingId);
      }
    }

    if (!sourceCallId) return;

    // The booking closes the loop on an open recovery: either the source call
    // IS the recovery's callback (recovery_call_id — the GRE called back and
    // booked) or, edge case, the missed call itself (call_id).
    const rec = db
      .prepare(`
        SELECT id FROM ct_recoveries
        WHERE (recovery_call_id = ? OR call_id = ?)
          AND status IN ${OPEN_RECOVERY}
          AND (phone_e164 = '' OR ? = '' OR phone_e164 = ?)
        LIMIT 1
      `)
      .get(sourceCallId, sourceCallId, guestPhone, guestPhone) as { id: string } | undefined;

    if (rec) {
      db.prepare(`
        UPDATE ct_recoveries
        SET recovery_booking_id = ?,
            status = 'recovered',
            recovered_at = ?,
            recovery_call_id = COALESCE(recovery_call_id, ?),
            updated_at = ?
        WHERE id = ?
      `).run(bookingId, now, sourceCallId, now, rec.id);
      emitRecoveryUpdate(db, guestPhone || undefined);
    }
  } catch (e) {
    console.error('[ct-ingest] attributeBooking failed', e);
  }
}
