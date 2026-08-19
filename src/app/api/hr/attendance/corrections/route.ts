/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { canManageHr, canAdminHr, HR_ATTENDANCE_EVENT_TYPES } from '@/lib/hr';
import {
  applyCorrection,
  businessDateOf,
  getHrDayCutoff,
} from '@/lib/hr-attendance';
import { fmtISTDate } from '@/lib/format-date';
import { notifyHrEmployee } from '@/lib/hr-notify';
import { reportServerError } from '@/lib/error-alerts';

/**
 * Attendance corrections (/api/hr/attendance/corrections) — HRMS Phase 2.
 * Contract: docs/HRMS_DECISIONS.md §8.2 — the variance_approvals pattern:
 * frozen original + requested + approved JSON, a partial UNIQUE that allows
 * ONE pending request per employee-day, and decisions that refuse non-pending
 * rows. Approval APPENDS source='manual' events (created_by = the approver)
 * and RECOMPUTES the summary — original events are NEVER rewritten/deleted.
 *
 * GET  ?status=pending|approved|rejected  (default: all)
 *        → { corrections }  (joined employee_code / full_name; newest first)
 *
 * POST { employee_id, date, requested_json, reason } → { correction }
 *      requested_json is { events: [{ event_type, at, reason? }] } (object or
 *      JSON string; a bare array is accepted too). `at` is UTC — the same
 *      basis as hr_attendance_events.at, NOT IST wall time. Everything is
 *      validated NOW so an approver can never hit a malformed request. The
 *      day's current summary + full event timeline are frozen into
 *      original_json. A second pending request for the same employee-day →
 *      409 (pre-checked, and backstopped by idx_hr_att_corr_pending).
 *
 * PATCH { id, action: 'approve'|'reject', review_reason }
 *        → { correction, summary?, events? }
 *      approve: claim (status pending→approved), applyCorrection (append
 *      manual events + recompute + corrected=1), stamp approved_json, audit —
 *      ALL inside ONE db.transaction(), so any failure rolls the whole
 *      decision back. reject: decision metadata only, nothing moves
 *      (review_reason REQUIRED — a silent rejection is not reviewable).
 *
 * Gates: GET/POST canManageHr, PATCH canAdminHr (decisions are admin acts).
 * The proxy does NOT protect API GETs — these handlers are the security
 * boundary (§2.1). Errors are GENERIC on the wire except the engine's
 * caller-safe whitelist; e.message otherwise never leaves the server.
 * Audit: hr.attendance.correction.request / .approve / .reject.
 */
export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = new Set(['pending', 'approved', 'rejected']);
const PENDING_CONFLICT = 'A correction for this employee and day is already pending';
/** Sanity cap — a correction fixes one day's punches, not a bulk import. */
const MAX_EVENTS = 20;

/** Trimmed string from any body value ('' for null/undefined). */
function s(v: unknown): string {
  return String(v ?? '').trim();
}

/** applyCorrection throws CALLER-SAFE messages (documented in
 *  src/lib/hr-attendance.ts). Only this exact whitelist reaches the wire. */
const APPLY_ERROR_STATUS: Record<string, number> = {
  'Correction is missing its employee or date': 400,
  'Correction request is not valid JSON': 400,
  'Correction request contains no events': 400,
  'Correction contains an invalid event type': 400,
  'Correction contains an invalid event time': 400,
  'Employee not found': 404,
};

const CORRECTION_SELECT = `
  SELECT c.*, e.employee_code, e.full_name
  FROM hr_attendance_corrections c
  LEFT JOIN hr_employees e ON e.id = c.employee_id
`;

function loadCorrection(db: any, id: string): any {
  return db.prepare(`${CORRECTION_SELECT} WHERE c.id = ?`).get(id);
}

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }

  try {
    const sp = new URL(request.url).searchParams;
    const status = s(sp.get('status'));
    if (status && !STATUSES.has(status)) {
      return Response.json({ error: 'Invalid status filter' }, { status: 400 });
    }

    const db = getDb();
    const corrections = db
      .prepare(
        `${CORRECTION_SELECT}
         ${status ? 'WHERE c.status = ?' : ''}
         ORDER BY c.created_at DESC, c.id DESC
         LIMIT 500`,
      )
      .all(...(status ? [status] : [])) as any[];

    return Response.json({ corrections });
  } catch (e) {
    console.error('GET /api/hr/attendance/corrections failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to load corrections' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }

  try {
    let body: any = {};
    try { body = await request.json(); } catch { /* handled by field checks below */ }

    const employee_id = s(body?.employee_id);
    if (!employee_id) return Response.json({ error: 'Employee is required' }, { status: 400 });
    const date = s(body?.date);
    if (!DATE_RE.test(date)) {
      return Response.json({ error: 'Invalid date (expected YYYY-MM-DD)' }, { status: 400 });
    }
    const reason = s(body?.reason);
    if (!reason) {
      return Response.json(
        { error: 'A reason for the correction is required' },
        { status: 400 },
      );
    }

    // requested_json arrives as an object or a JSON string; normalise to the
    // canonical { events: [...] } shape applyCorrection expects, and validate
    // EVERY event NOW — a malformed request must fail at submission, never in
    // the approver's face. Timestamps are checked with the engine's own
    // parser (businessDateOf throws on garbage), so POST and approval can
    // never disagree about what "valid" means.
    let parsed: unknown = body?.requested_json;
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed); } catch {
        return Response.json({ error: 'Correction request is not valid JSON' }, { status: 400 });
      }
    }
    const list: unknown = Array.isArray(parsed) ? parsed : (parsed as any)?.events;
    if (!Array.isArray(list) || list.length === 0) {
      return Response.json({ error: 'Correction request contains no events' }, { status: 400 });
    }
    if (list.length > MAX_EVENTS) {
      return Response.json(
        { error: `A correction may contain at most ${MAX_EVENTS} events` },
        { status: 400 },
      );
    }

    const db = getDb();
    const cutoff = getHrDayCutoff(db);
    const events: { event_type: string; at: string; reason?: string }[] = [];
    for (const raw of list) {
      const ev = raw as { event_type?: unknown; at?: unknown; reason?: unknown };
      const event_type = s(ev?.event_type);
      if (!(HR_ATTENDANCE_EVENT_TYPES as readonly string[]).includes(event_type)) {
        return Response.json(
          { error: 'Correction contains an invalid event type' },
          { status: 400 },
        );
      }
      const at = s(ev?.at);
      try {
        businessDateOf(at, cutoff); // engine parser as validator — throws on garbage
      } catch {
        return Response.json(
          { error: 'Correction contains an invalid event time' },
          { status: 400 },
        );
      }
      const evReason = s(ev?.reason);
      events.push(evReason ? { event_type, at, reason: evReason } : { event_type, at });
    }

    const emp = db
      .prepare('SELECT id, full_name FROM hr_employees WHERE id = ?')
      .get(employee_id) as any;
    if (!emp) return Response.json({ error: 'Employee was not found' }, { status: 400 });

    // Friendly pre-check; the partial UNIQUE index idx_hr_att_corr_pending
    // still backstops the race and is caught below.
    const open = db
      .prepare(
        "SELECT id FROM hr_attendance_corrections WHERE employee_id = ? AND date = ? AND status = 'pending'",
      )
      .get(employee_id, date) as any;
    if (open) return Response.json({ error: PENDING_CONFLICT }, { status: 409 });

    // Freeze the day AS IT STANDS (variance pattern: the original is part of
    // the record, so the reviewer sees what the requester saw). Summary may
    // be null (nothing computed yet); events include ignored rows, flagged.
    const originalSummary =
      (db
        .prepare('SELECT * FROM hr_attendance WHERE employee_id = ? AND date = ?')
        .get(employee_id, date) as any) ?? null;
    const originalEvents = db
      .prepare(
        `SELECT id, event_type, source, at, ignored, ignored_reason, reason
         FROM hr_attendance_events
         WHERE employee_id = ? AND business_date = ?
         ORDER BY at, created_at, id`,
      )
      .all(employee_id, date) as any[];

    const actorOutletId = await getCurrentOutletId();

    const id = generateId();
    try {
      db.prepare(
        `INSERT INTO hr_attendance_corrections
           (id, employee_id, date, original_json, requested_json, reason,
            requested_by, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      ).run(
        id,
        employee_id,
        date,
        JSON.stringify({ summary: originalSummary, events: originalEvents }),
        JSON.stringify({ events }),
        reason,
        me.email,
      );
    } catch (e: any) {
      // Race with a concurrent request: the partial UNIQUE is the referee.
      if (
        String(e?.code || '').startsWith('SQLITE_CONSTRAINT') &&
        /idx_hr_att_corr_pending|hr_attendance_corrections/i.test(String(e?.message || ''))
      ) {
        return Response.json({ error: PENDING_CONFLICT }, { status: 409 });
      }
      throw e;
    }

    logAuditEvent(db, {
      event_type: 'hr.attendance.correction.request',
      entity_type: 'hr_attendance_correction',
      entity_id: id,
      actor_email: me.email,
      outlet_id: actorOutletId,
      after: { employee_id, date, events, status: 'pending' },
      note: reason,
    });

    return Response.json({ correction: loadCorrection(db, id) });
  } catch (e) {
    console.error('POST /api/hr/attendance/corrections failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to submit the correction' }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  // Decisions are ADMIN acts (variance pattern: requesting is management,
  // deciding is not).
  if (!canAdminHr(me)) {
    return Response.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    let body: any = {};
    try { body = await request.json(); } catch { /* handled by field checks below */ }

    const id = s(body?.id);
    if (!id) return Response.json({ error: 'Correction id is required' }, { status: 400 });
    const action = s(body?.action);
    if (action !== 'approve' && action !== 'reject') {
      return Response.json({ error: 'Unknown action' }, { status: 400 });
    }
    const review_reason = s(body?.review_reason);
    if (action === 'reject' && !review_reason) {
      return Response.json(
        { error: 'A reason for rejecting is required' },
        { status: 400 },
      );
    }

    // Resolve EVERY await before the transaction — better-sqlite3 is
    // synchronous and an await inside db.transaction() breaks atomicity.
    const actorOutletId = await getCurrentOutletId();

    const db = getDb();
    const row = db
      .prepare('SELECT * FROM hr_attendance_corrections WHERE id = ?')
      .get(id) as any;
    if (!row) return Response.json({ error: 'Correction not found' }, { status: 404 });
    if (row.status !== 'pending') {
      return Response.json({ error: 'Correction has already been decided' }, { status: 409 });
    }

    if (action === 'reject') {
      // Nothing moves: decision metadata only. The status guard in the WHERE
      // makes a lost race (someone decided in between) a 409, not a clobber.
      const res = db
        .prepare(
          `UPDATE hr_attendance_corrections
           SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now'),
               review_reason = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(me.email, review_reason, id);
      if (res.changes !== 1) {
        return Response.json({ error: 'Correction has already been decided' }, { status: 409 });
      }
      logAuditEvent(db, {
        event_type: 'hr.attendance.correction.reject',
        entity_type: 'hr_attendance_correction',
        entity_id: id,
        actor_email: me.email,
        outlet_id: actorOutletId,
        before: { status: 'pending' },
        after: { status: 'rejected', employee_id: row.employee_id, date: row.date },
        note: review_reason,
      });
      // Durable notification + push (best-effort, AFTER the decision landed —
      // a notify failure must never fail the decision).
      try {
        notifyHrEmployee(db, row.employee_id, {
          kind: 'hr.attendance.correction.reject',
          title: `Attendance correction rejected: ${fmtISTDate(row.date)}`,
          body: review_reason,
          href: '/hr/attendance',
        });
      } catch { /* best-effort */ }
      return Response.json({ correction: loadCorrection(db, id) });
    }

    // ---- approve: claim + apply + stamp + audit in ONE transaction ----
    // applyCorrection deliberately opens no transaction of its own (see its
    // doc comment) so a throw ANYWHERE here — bad JSON, invalid event —
    // rolls back the status claim too and the row stays pending.
    const tx = db.transaction(() => {
      const claimed = db
        .prepare(
          `UPDATE hr_attendance_corrections
           SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now'),
               review_reason = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(me.email, review_reason, id);
      if (claimed.changes !== 1) throw new Error('CORRECTION_ALREADY_DECIDED');

      // Appends source='manual' events (created_by = approver, business_date
      // FORCED to the corrected day), recomputes, stamps corrected=1.
      const applied = applyCorrection(
        db,
        {
          id: row.id,
          employee_id: row.employee_id,
          date: row.date,
          requested_json: row.requested_json,
          reason: row.reason,
        },
        me.email,
      );

      db.prepare('UPDATE hr_attendance_corrections SET approved_json = ? WHERE id = ?').run(
        JSON.stringify({
          events: applied.events.map((ev) => ({
            id: ev.id,
            event_type: ev.event_type,
            at: ev.at,
            business_date: ev.business_date,
          })),
          summary: applied.summary,
        }),
        id,
      );

      logAuditEvent(db, {
        event_type: 'hr.attendance.correction.approve',
        entity_type: 'hr_attendance_correction',
        entity_id: id,
        actor_email: me.email,
        outlet_id: actorOutletId,
        before: { status: 'pending' },
        after: {
          status: 'approved',
          employee_id: row.employee_id,
          date: row.date,
          appended_events: applied.events.map((ev) => ({
            event_type: ev.event_type,
            at: ev.at,
          })),
          summary_status: applied.summary.status,
        },
        note: review_reason,
      });

      return applied;
    });

    let applied: ReturnType<typeof applyCorrection>;
    try {
      applied = tx();
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      if (msg === 'CORRECTION_ALREADY_DECIDED') {
        return Response.json({ error: 'Correction has already been decided' }, { status: 409 });
      }
      const status = APPLY_ERROR_STATUS[msg];
      if (status) return Response.json({ error: msg }, { status });
      throw e;
    }

    // Durable notification + push (best-effort, AFTER the transaction
    // committed — a notify failure must never fail the decision).
    try {
      notifyHrEmployee(db, row.employee_id, {
        kind: 'hr.attendance.correction.approve',
        title: `Attendance correction approved: ${fmtISTDate(row.date)}`,
        body: review_reason || 'Your attendance correction was applied.',
        href: '/hr/attendance',
      });
    } catch { /* best-effort */ }

    return Response.json({
      correction: loadCorrection(db, id),
      summary: applied.summary,
      events: applied.events,
    });
  } catch (e) {
    console.error('PATCH /api/hr/attendance/corrections failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to decide the correction' }, { status: 500 });
  }
}
