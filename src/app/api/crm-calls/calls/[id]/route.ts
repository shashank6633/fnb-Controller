import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { emitCt, pushRecentCt, type CtEvent } from '@/lib/ct/bus';

/**
 * PUT /api/crm-calls/calls/[id]   { disposition, disposition_note? }
 *
 * Sets the GRE's post-call disposition on a call. Two side-effects:
 *
 * 1. RECOVERY CLOSE-OUT — if this call maps to an open recovery (either
 *    ct_recoveries.recovery_call_id = this call, i.e. the auto-matched
 *    callback, OR an open pending/attempting recovery on the same phone):
 *      · any disposition EXCEPT follow_up_needed → a human was reached →
 *        status='recovered', recovered_at=now, resolution_note=disposition,
 *        recovery_call_id linked to this call.
 *      · follow_up_needed → contact made but not resolved → recovery stays
 *        in play (pending is bumped to 'attempting'; attempting stays).
 *    (Booking linkage — recovery_booking_id — is attributeBooking()'s job
 *    when the client POSTs the booking after a 'booking_made' disposition.)
 *
 * 2. FOLLOW-UP — disposition 'follow_up_needed' auto-creates a ct_follow_ups
 *    row due in 24h, assigned to the dispositioning user. Requires a guest
 *    (ct_follow_ups.guest_id is NOT NULL): uses the call's linked guest, else
 *    a guest matched by phone; skipped (flagged in the response) for unknown
 *    callers — the GRE can create the guest from the pop and retry.
 */
export const dynamic = 'force-dynamic';

const DISPOSITIONS = [
  'booking_made', 'enquiry', 'event_enquiry', 'complaint',
  'wrong_number', 'follow_up_needed', 'no_action',
] as const;

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: 'Not signed in' }, { status: 401 });
  const { id } = await params;

  let body: any = {};
  try { body = await req.json(); } catch { /* fall through to validation */ }
  const disposition = String(body?.disposition || '').trim();
  const note = body?.disposition_note != null ? String(body.disposition_note) : '';
  if (!(DISPOSITIONS as readonly string[]).includes(disposition)) {
    return Response.json(
      { error: `disposition must be one of: ${DISPOSITIONS.join(', ')}` },
      { status: 400 },
    );
  }

  const db = getDb();
  const call = db.prepare(`
    SELECT id, guest_id, phone_e164, direction, status, disposition
    FROM ct_calls WHERE id = ?
  `).get(id) as any;
  if (!call) return Response.json({ error: 'Call not found' }, { status: 404 });

  const now = new Date().toISOString();
  db.prepare(`UPDATE ct_calls SET disposition = ?, disposition_note = ? WHERE id = ?`)
    .run(disposition, note, id);

  // ── Recovery close-out ───────────────────────────────────────────────────
  // Prefer the explicit callback link (recovery_call_id = this call), else an
  // open recovery on the same phone. Never resurrect already-closed rows.
  const recovery = db.prepare(`
    SELECT id, status, recovery_call_id
    FROM ct_recoveries
    WHERE status NOT IN ('recovered', 'auto_resolved', 'unreachable')
      AND (recovery_call_id = ? OR (phone_e164 = ? AND status IN ('pending', 'attempting')))
    ORDER BY CASE WHEN recovery_call_id = ? THEN 0 ELSE 1 END, missed_at DESC
    LIMIT 1
  `).get(id, call.phone_e164, id) as any;

  let recoveryOutcome: 'recovered' | 'attempting' | null = null;
  if (recovery) {
    if (disposition !== 'follow_up_needed') {
      // Human reached and the matter concluded → recovery is done.
      db.prepare(`
        UPDATE ct_recoveries
        SET status = 'recovered', recovered_at = ?, recovery_call_id = ?,
            resolution_note = ?, updated_at = ?
        WHERE id = ?
      `).run(now, recovery.recovery_call_id || id, disposition, now, recovery.id);
      recoveryOutcome = 'recovered';
    } else if (recovery.status === 'pending' || recovery.status === 'expired') {
      // Contact happened but needs another touch — recovery stays live.
      // (expired is workable per contract: attempting resumes the lifecycle)
      db.prepare(`UPDATE ct_recoveries SET status = 'attempting', updated_at = ? WHERE id = ?`)
        .run(now, recovery.id);
      recoveryOutcome = 'attempting';
    } else {
      recoveryOutcome = 'attempting'; // already attempting; nothing to change
    }
    const pending = db.prepare(
      `SELECT COUNT(*) AS n FROM ct_recoveries WHERE status IN ('pending', 'attempting')`,
    ).get() as { n: number };
    const evt: CtEvent = {
      type: 'recovery_update',
      callId: id,
      phone: call.phone_e164,
      recoveryCount: pending.n,
      at: now,
    };
    emitCt(evt);
    pushRecentCt(evt);
  }

  // ── Auto follow-up (+24h, assigned to me) ────────────────────────────────
  let followUpCreated = false;
  if (disposition === 'follow_up_needed') {
    let guestId: string = call.guest_id || '';
    if (!guestId) {
      const g = db.prepare(`SELECT id FROM ct_guests WHERE phone_e164 = ?`)
        .get(call.phone_e164) as any;
      guestId = g?.id || '';
    }
    if (guestId) {
      // Don't stack duplicates: re-dispositioning the same call as
      // follow_up_needed (or a double-submit) reuses the existing OPEN
      // follow-up for this call instead of creating another.
      const openFu = db.prepare(
        `SELECT id FROM ct_follow_ups WHERE call_id = ? AND status = 'open' LIMIT 1`,
      ).get(id) as any;
      if (!openFu) {
        const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        db.prepare(`
          INSERT INTO ct_follow_ups (id, guest_id, call_id, due_at, assigned_to, status, note, created_at)
          VALUES (?, ?, ?, ?, ?, 'open', ?, ?)
        `).run(generateId(), guestId, id, dueAt, user.email, note || 'Follow-up from call disposition', now);
      }
      followUpCreated = true;
    }
  }

  return Response.json({
    success: true,
    call_id: id,
    disposition,
    recovery: recoveryOutcome ? { id: recovery.id, status: recoveryOutcome } : null,
    follow_up_created: followUpCreated,
    // Unknown caller + follow_up_needed → tell the client why no follow-up
    follow_up_skipped_reason:
      disposition === 'follow_up_needed' && !followUpCreated
        ? 'No guest exists for this phone yet — create the guest first'
        : undefined,
  });
}
