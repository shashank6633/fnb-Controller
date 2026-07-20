import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { normalizePhone } from '@/lib/ct/phone';
import { emitCt, pushRecentCt } from '@/lib/ct/bus';

/**
 * POST /api/crm-calls/calls/log-callback  (authed)
 *
 * Device-dialed outbound callback logging — the workaround for TeleCMI plans
 * with NO outbound package. The GRE taps "Call Back" (native dialer places the
 * call from their own SIM); the client times how long they were on the call and
 * posts it here. We synthesize an OUTBOUND ct_calls row (with the talk duration)
 * so it shows up in the Call Log / Guest 360 / leaderboard exactly like a real
 * outbound CDR would — and, when a recovery is supplied, records the callback
 * attempt and advances the recovery.
 *
 * Body: {
 *   phone?, guest_id?, recovery_id?,   // at least one way to resolve the number
 *   duration_sec: number,              // talk time (client timer or manual)
 *   connected?: boolean,               // false = rang, no answer (default: duration>0)
 *   outcome?: string,                  // disposition: booking_made|enquiry|complaint|
 *                                      //   wrong_number|follow_up_needed|no_answer|no_action
 *   note?: string,
 *   at?: string                        // ISO end time; default now
 * }
 * → { ok, call_id, recovery_status }
 */
export const dynamic = 'force-dynamic';

const OUTCOMES = new Set([
  'booking_made', 'enquiry', 'complaint', 'wrong_number',
  'follow_up_needed', 'no_answer', 'no_action',
]);
// Outcomes that mean the RIGHT person was reached & handled → recovery recovered.
// 'wrong_number' is NOT here — reaching a wrong number can't recover the guest;
// it resolves the recovery as 'unreachable' instead (handled below).
const REACHED = new Set(['booking_made', 'enquiry', 'complaint', 'no_action']);
const RESOLVED = new Set(['recovered', 'auto_resolved']); // terminal — never downgrade

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not signed in' }, { status: 401 });

  let body: any = {};
  try { body = await req.json(); } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const db = getDb();

  // ── Resolve the phone + guest + (optional) recovery ─────────────────────
  const recoveryId = String(body.recovery_id || '').trim();
  let recovery: any = null;
  if (recoveryId) {
    recovery = db.prepare('SELECT * FROM ct_recoveries WHERE id = ?').get(recoveryId);
    if (!recovery) return Response.json({ error: 'recovery not found' }, { status: 404 });
  }

  let guestId = String(body.guest_id || '').trim() || (recovery?.guest_id ?? '');
  // A recovery callback ALWAYS logs against the recovery's own number — a stray
  // body.phone must never advance a recovery for a call to a different number.
  let phone = recovery ? normalizePhone(recovery.phone_e164) : '';
  if (!phone) phone = normalizePhone(body.phone);
  if (!phone && guestId) {
    const g = db.prepare('SELECT phone_e164 FROM ct_guests WHERE id = ?').get(guestId) as any;
    phone = normalizePhone(g?.phone_e164);
  }
  if (!phone) return Response.json({ error: 'Could not resolve a phone number to log (pass phone, guest_id, or recovery_id)' }, { status: 400 });
  // Back-link a guest by phone if we still don't have one.
  if (!guestId) {
    const g = db.prepare('SELECT id FROM ct_guests WHERE phone_e164 = ?').get(phone) as any;
    guestId = g?.id ?? '';
  }

  // ── Normalize the call facts ────────────────────────────────────────────
  let duration = Number(body.duration_sec);
  if (!Number.isFinite(duration) || duration < 0) duration = 0;
  duration = Math.min(Math.round(duration), 6 * 60 * 60); // clamp to 6h sanity cap
  const connected = body.connected === undefined ? duration > 0 : !!body.connected;
  const outcome = OUTCOMES.has(String(body.outcome)) ? String(body.outcome) : '';
  const note = String(body.note || '').slice(0, 2000);
  // Where the duration came from: 'call_log' = exact (Captain APK read the
  // device call log), 'approx' = APK wall-time fallback, 'timer' = web
  // time-away timer, 'manual' = typed. Stored for trust/reporting.
  const SOURCES = new Set(['call_log', 'approx', 'timer', 'manual']);
  const source = SOURCES.has(String(body.source)) ? String(body.source) : 'manual';
  const endedAt = (() => {
    const t = body.at ? new Date(body.at) : new Date();
    return isNaN(t.getTime()) ? new Date().toISOString() : t.toISOString();
  })();
  const startedAt = new Date(new Date(endedAt).getTime() - duration * 1000).toISOString();
  const status = connected ? 'answered' : 'missed';

  // Idempotency: a retried submit (network flakiness) must not duplicate the
  // call row + recovery attempt. If this GRE already logged an outbound call to
  // this number in the last 20s, return that instead of inserting again.
  const dupe = db.prepare(
    `SELECT id FROM ct_calls WHERE direction = 'outbound' AND agent_user = ? AND phone_e164 = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1`,
  ).get(me.email, phone, new Date(Date.now() - 20_000).toISOString()) as { id: string } | undefined;
  if (dupe) {
    return Response.json({ ok: true, call_id: dupe.id, recovery_status: recovery?.status ?? null, deduped: true });
  }

  // ── Synthesize the outbound call row (agent = the GRE who dialed) ────────
  const callId = generateId();
  db.prepare(`
    INSERT INTO ct_calls
      (id, telecmi_call_id, guest_id, phone_e164, direction, status, agent_user, queue,
       started_at, answered_at, ended_at, duration_sec, recording_url, raw_payload,
       disposition, disposition_note, created_at)
    VALUES (?, NULL, ?, ?, 'outbound', ?, ?, '', ?, ?, ?, ?, '', ?, ?, ?, ?)
  `).run(
    callId, guestId || null, phone, status, me.email,
    startedAt, connected ? startedAt : null, endedAt, duration,
    JSON.stringify({ source: 'device_manual', duration_source: source, by: me.email }),
    outcome, note, endedAt,
  );

  // ── Advance the recovery (if this was a recovery callback) ──────────────
  let recoveryStatus: string | null = null;
  if (recovery) {
    let attempts: any[] = [];
    try { const a = JSON.parse(recovery.attempts || '[]'); if (Array.isArray(a)) attempts = a; } catch { /* keep [] */ }
    attempts.push({ at: endedAt, by: me.email, method: 'callback', outcome: outcome || (connected ? 'answered' : 'no_answer'), duration_sec: duration, connected, source });
    const now = new Date().toISOString();

    if (RESOLVED.has(recovery.status)) {
      // Already closed by another flow (attributeBooking / answered-inbound
      // auto-resolve). Record the attempt for history but NEVER downgrade or
      // overwrite a resolved recovery (would resurrect closed work + inflate
      // the pending badge). Mirrors the guard in recoveries/[id] PUT.
      db.prepare(`UPDATE ct_recoveries SET attempts = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(attempts), now, recovery.id);
      recoveryStatus = recovery.status;
    } else {
      // Right person reached & dispositioned → recovered; wrong number →
      // unreachable (can't recover the guest on this number); otherwise a
      // genuine attempt was made → attempting.
      const nextStatus = outcome === 'wrong_number' ? 'unreachable'
        : (connected && REACHED.has(outcome)) ? 'recovered'
        : 'attempting';
      const terminal = nextStatus === 'recovered' || nextStatus === 'unreachable';
      db.prepare(`
        UPDATE ct_recoveries SET
          attempts = ?, first_attempt_at = COALESCE(first_attempt_at, ?),
          status = ?, recovery_call_id = COALESCE(recovery_call_id, ?),
          recovered_at = CASE WHEN ? = 'recovered' THEN ? ELSE recovered_at END,
          resolution_note = CASE WHEN ? THEN ? ELSE resolution_note END,
          updated_at = ?
        WHERE id = ?
      `).run(
        JSON.stringify(attempts), endedAt,
        nextStatus, callId,
        nextStatus, now,
        terminal ? 1 : 0, (outcome || 'Reached on callback'),
        now, recovery.id,
      );
      recoveryStatus = nextStatus;
    }

    // Refresh bell/queue badges.
    try {
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM ct_recoveries WHERE status IN ('pending','attempting')`).get() as any)?.n || 0;
      const evt = { type: 'recovery_update' as const, phone, recoveryCount: n, at: now };
      emitCt(evt); pushRecentCt(evt);
    } catch { /* non-fatal */ }
  }

  return Response.json({ ok: true, call_id: callId, recovery_status: recoveryStatus });
}
