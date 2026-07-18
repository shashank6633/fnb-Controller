/**
 * Call-to-Table CRM — THE core ingestion service.
 *
 * Every TeleCMI payload (live websocket-relay webhook + CDR webhook + backfill)
 * funnels through here. Responsibilities:
 *   - Idempotent CDR upsert into ct_calls (keyed on telecmi_call_id — a CDR
 *     re-delivery or a backfill overlap NEVER duplicates a call).
 *   - Missed-call detection → auto-create ct_recoveries with a business-hours
 *     aware SLA deadline (see docs/CRM_DECISIONS.md §5.5A).
 *   - Recovery lifecycle automation: answered inbound auto-resolves open
 *     recoveries for that phone; answered outbound records the callback
 *     attempt; a booking created after a call links + recovers via
 *     attributeBooking().
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
import { ctSetting, setCtSetting, slaDueAt } from './settings';
import { emitCt, pushRecentCt, type CtEvent } from './bus';
import { getAgentMap, getUserNamesByEmail, resolveAgentLabel } from './agents';

/** Resolve a raw TeleCMI agent id to a staff display name for the live feed
 *  (via agent_map). Cheap enough for the low frequency of live/CDR events. */
function agentDisplayName(db: Database.Database, rawAgent: string | undefined | null): string {
  if (!rawAgent) return '';
  try { return resolveAgentLabel(rawAgent, getAgentMap(db), getUserNamesByEmail(db)); }
  catch { return String(rawAgent || ''); }
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
  const totalBookings = (db
    .prepare(`SELECT COUNT(*) AS n FROM ct_bookings WHERE guest_id = ?`)
    .get(g.id) as { n: number }).n;
  const converted = (db
    .prepare(`SELECT COUNT(*) AS n FROM ct_bookings WHERE guest_id = ? AND status IN ('seated','completed')`)
    .get(g.id) as { n: number }).n;
  const completed = (db
    .prepare(`SELECT COUNT(*) AS n FROM ct_bookings WHERE guest_id = ? AND status = 'completed'`)
    .get(g.id) as { n: number }).n;
  const lastVisit = (db
    .prepare(`
      SELECT MAX(COALESCE(NULLIF(booking_date, ''), updated_at)) AS at
      FROM ct_bookings WHERE guest_id = ? AND status IN ('seated','completed')
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

/** INSERT OR IGNORE a recovery for a missed call (call_id UNIQUE = the dedupe). */
function createRecovery(
  db: Database.Database,
  opts: { callId: string; phone: string; missedAt: string; detectedVia: 'cdr' | 'live_event' | 'backfill' },
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

// ─── CDR ingestion (source of truth) ────────────────────────────────────────

/**
 * Ingest a completed-call CDR (webhook or backfill). Idempotent on
 * telecmi_call_id — re-delivery updates only missing/null fields, never
 * duplicates. Returns the ct_calls id and whether a new row was created.
 */
export function ingestCdr(raw: any): { callId: string | null; created: boolean } {
  try {
    const db = getDb();
    const m = mapCdrPayload(raw);
    if (!m) return { callId: null, created: false };

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
      db.prepare(`
        INSERT INTO ct_calls
          (id, telecmi_call_id, guest_id, phone_e164, direction, status, agent_user, queue,
           started_at, answered_at, ended_at, duration_sec, recording_url, raw_payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          raw_payload   = CASE WHEN ct_calls.raw_payload IN ('', '{}') THEN excluded.raw_payload ELSE ct_calls.raw_payload END
      `).run(
        generateId(), telecmiId, guest?.id ?? null, phone, m.direction, m.status,
        m.agent || '', m.queue || '', m.startedAt || now, m.answeredAt,
        m.endedAt || now, m.durationSec || 0, m.recordingUrl || '', rawJson, now,
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
           started_at, answered_at, ended_at, duration_sec, recording_url, raw_payload, created_at)
        VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        callId, guest?.id ?? null, phone, m.direction, m.status,
        m.agent || '', m.queue || '', m.startedAt || now, m.answeredAt,
        m.endedAt || now, m.durationSec || 0, m.recordingUrl || '', rawJson, now,
      );
    }

    // ── Missed-family → recovery workflow (the module's reason to exist) ──
    if (MISSED_FAMILY.has(m.status)) {
      const madeNew = createRecovery(db, {
        callId,
        phone,
        missedAt: m.endedAt || m.startedAt || now,
        detectedVia: 'cdr',
      });
      if (madeNew) emitRecoveryUpdate(db, phone);
    }

    // ── Answered inbound → guest reached us themselves → auto-resolve ──
    // Causally bounded: an answered call only resolves misses that happened
    // AT OR BEFORE it. Without this, a re-delivered/backfilled OLDER answered
    // call would silently close a NEWER open recovery. Timestamps are UTC ISO,
    // so the string comparison is chronological.
    if (m.status === 'answered' && m.direction === 'inbound' && phone) {
      const answeredAt = m.answeredAt || m.endedAt || now;
      const res = db
        .prepare(`
          UPDATE ct_recoveries
          SET status = 'auto_resolved',
              resolution_note = 'Guest called back and was answered',
              updated_at = ?
          WHERE phone_e164 = ? AND status IN ${OPEN_RECOVERY} AND missed_at <= ?
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
 */
export function ingestLive(raw: any): void {
  try {
    const db = getDb();
    const m = mapLivePayload(raw);
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

    const telecmiId = (m.telecmiCallId || '').trim();

    if (m.event === 'ring' && m.direction === 'inbound') {
      const guest = guestByPhone(db, phone);
      let callId: string | undefined;
      if (telecmiId) {
        db.prepare(`
          INSERT INTO ct_calls
            (id, telecmi_call_id, guest_id, phone_e164, direction, status, agent_user, queue,
             started_at, raw_payload, created_at)
          VALUES (?, ?, ?, ?, 'inbound', 'ringing', ?, ?, ?, ?, ?)
          ON CONFLICT(telecmi_call_id) DO UPDATE SET
            guest_id   = COALESCE(ct_calls.guest_id, excluded.guest_id),
            phone_e164 = CASE WHEN ct_calls.phone_e164 = '' THEN excluded.phone_e164 ELSE ct_calls.phone_e164 END,
            started_at = COALESCE(NULLIF(ct_calls.started_at, ''), excluded.started_at)
        `).run(
          generateId(), telecmiId, guest?.id ?? null, phone,
          m.agent || '', m.queue || '', m.at || now, safeStringify(raw), now,
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
               started_at, raw_payload, created_at)
            VALUES (?, NULL, ?, ?, 'inbound', 'ringing', ?, ?, ?, ?, ?)
          `).run(
            callId, guest?.id ?? null, phone,
            m.agent || '', m.queue || '', m.at || now, safeStringify(raw), now,
          );
        }
      }
      emit({
        type: 'incoming_call',
        callId,
        telecmiCallId: telecmiId || undefined,
        phone: phone || undefined,
        guest: guestSnapshot(db, phone),
        agent: m.agent || undefined,
        queue: m.queue || undefined,
        at: m.at || now,
      });
      return;
    }

    if (m.event === 'answer') {
      // Not contractually required, but marking the live answer prevents
      // reconcileLiveEvents from mis-flagging a long in-progress call as
      // missed while its CDR is still minutes away.
      let answeredCallId: string | undefined;
      if (telecmiId) {
        db.prepare(`
          UPDATE ct_calls SET status = 'answered', answered_at = COALESCE(answered_at, ?)
          WHERE telecmi_call_id = ? AND status = 'ringing'
        `).run(m.at || now, telecmiId);
        answeredCallId = (db.prepare(`SELECT id FROM ct_calls WHERE telecmi_call_id = ?`).get(telecmiId) as { id: string } | undefined)?.id;
      }
      // Tell the Live wallboard the call left the ringing state in real time
      // (the 12s ringing re-sync is the backstop; this makes it instant).
      emit({
        type: 'answered',
        callId: answeredCallId,
        telecmiCallId: telecmiId || undefined,
        phone: phone || undefined,
        agent: m.agent || undefined,
        agentName: agentDisplayName(db, m.agent) || undefined,
        at: m.at || now,
      });
      return;
    }

    if (m.event === 'hangup') {
      const row = telecmiId
        ? db.prepare(`SELECT id FROM ct_calls WHERE telecmi_call_id = ?`).get(telecmiId) as { id: string } | undefined
        : undefined;
      emit({
        type: 'call_ended',
        callId: row?.id,
        telecmiCallId: telecmiId || undefined,
        phone: phone || undefined,
        guest: guestSnapshot(db, phone),
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
        SELECT id, phone_e164, started_at, created_at FROM ct_calls
        WHERE status = 'ringing'
          AND IFNULL(ended_at, '') = ''
          AND COALESCE(NULLIF(started_at, ''), created_at) < ?
      `)
      .all(cutoff) as Array<{ id: string; phone_e164: string; started_at: string | null; created_at: string }>;

    let n = 0;
    for (const call of stuck) {
      db.prepare(`UPDATE ct_calls SET status = 'missed', ended_at = ? WHERE id = ?`).run(now, call.id);
      createRecovery(db, {
        callId: call.id,
        phone: call.phone_e164,
        missedAt: call.started_at || call.created_at || now,
        detectedVia: 'live_event',
      });
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
