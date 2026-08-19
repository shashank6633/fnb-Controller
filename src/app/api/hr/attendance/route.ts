/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, logAuditEvent } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { canManageHr, HR_ATTENDANCE_EVENT_TYPES } from '@/lib/hr';
import {
  recordAttendanceEvent,
  currentBusinessDate,
  sweepStaleOpenDays,
  SUSPENDED_PUNCH_MESSAGE,
} from '@/lib/hr-attendance';
import { reportServerError } from '@/lib/error-alerts';

/**
 * Attendance register (/api/hr/attendance) — HRMS Phase 2.
 * Contract: docs/HRMS_DECISIONS.md §8.2/§8.5 (business day, single-gate
 * pairing, debounce, MISSING_CHECKOUT — all enforced in src/lib/hr-attendance).
 *
 * GET  ?date=YYYY-MM-DD&department_id=&q=&page=&pageSize=
 *        → { rows, total, page, pageSize, date }
 *      One row PER EMPLOYEE active that day: hr_employees LEFT JOIN
 *      hr_attendance, so an employee with no punches still appears as
 *      NOT_CHECKED_IN (summary columns COALESCE to their zero values).
 *      Exited employees (resigned/terminated/former) drop off the register
 *      EXCEPT on days where they have a summary row — history stays honest.
 *      `date` is an IST BUSINESS date (default: the current business date per
 *      the hr_day_cutoff setting) — never a raw calendar date. A sweep first
 *      re-closes any stale "PRESENT yesterday" rows (dangling IN overnight)
 *      so the register can never show someone present on a finished day.
 *
 * POST { employee_id, event_type?, at?, reason }  → { event, summary }
 *      MANUAL punch through the recordAttendanceEvent chokepoint
 *      (source 'manual', created_by = me.email). `reason` is REQUIRED — an
 *      unexplained manual punch is not auditable. `event_type` optional:
 *      omitted = single-gate alternation decides IN/OUT; explicit wins.
 *      `at` optional (default now) and is UTC 'YYYY-MM-DD HH:MM[:SS]' — the
 *      same basis as hr_attendance_events.at, NOT IST wall time.
 *      Audited as hr.attendance.manual_punch (imports are deliberately NOT
 *      audited per-row — the event table is its own log; a manual punch is a
 *      human state change and is).
 *
 * Both verbs gate on canManageHr ('@/lib/hr') — the proxy does NOT protect
 * API GETs, so this handler is the security boundary (HRMS_DECISIONS §2.1).
 * Errors are GENERIC on the wire except the engine's own caller-safe
 * whitelist below; e.message otherwise never leaves the server.
 */
export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Trimmed string from any body value ('' for null/undefined). */
function s(v: unknown): string {
  return String(v ?? '').trim();
}

/**
 * The attendance engine throws Errors with CALLER-SAFE messages (documented
 * whitelist in src/lib/hr-attendance.ts — no PII, no schema detail). Only
 * these exact messages are allowed onto the wire; anything else falls through
 * to the generic 500. Statuses: unknown employee → 404, exited/suspended →
 * 409 (state conflict — a routine refusal, not a server fault), the rest
 * → 400. The suspended message is imported from the engine so the two can
 * never drift (§8.4b: a suspended punch is a clean refusal, not a 500).
 */
const ENGINE_ERROR_STATUS: Record<string, number> = {
  'Employee is required': 400,
  'Employee not found': 404,
  'Employee has exited — attendance cannot be recorded': 409,
  [SUSPENDED_PUNCH_MESSAGE]: 409,
  'Invalid attendance source': 400,
  'Invalid punch timestamp': 400,
  'Invalid event type': 400,
};

function engineErrorResponse(e: unknown): Response | null {
  const msg = e instanceof Error ? e.message : '';
  const status = ENGINE_ERROR_STATUS[msg];
  return status ? Response.json({ error: msg }, { status }) : null;
}

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }

  try {
    const sp = new URL(request.url).searchParams;

    const db = getDb();

    // Re-close days left open (dangling IN overnight → MISSING_CHECKOUT).
    // Idempotent, indexed, PRESENT-filtered — cheap enough for every read.
    sweepStaleOpenDays(db);

    const rawDate = s(sp.get('date'));
    if (rawDate && !DATE_RE.test(rawDate)) {
      return Response.json({ error: 'Invalid date (expected YYYY-MM-DD)' }, { status: 400 });
    }
    // Default = the current BUSINESS date (hr_day_cutoff-shifted, §8.2.1) —
    // at 1 AM the register still shows "today's" (yesterday-dated) shift.
    const date = rawDate || currentBusinessDate(db);

    // parseInt (not Number) so a float can't reach LIMIT/OFFSET and trip
    // SQLite's "datatype mismatch" 500 (the crm-calls convention).
    const page = Math.max(1, parseInt(sp.get('page') || '1', 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(sp.get('pageSize') || '50', 10) || 50));

    // Shared WHERE — the SAME clause + params feed the page query and its
    // COUNT(*) so total and rows can never disagree. Exited employees stay
    // visible on days they actually have a summary row for (history), and
    // disappear from later registers. 'suspended' staff still punch the gate
    // (the engine records them), so they remain listed.
    const clauses: string[] = [
      "(e.status NOT IN ('resigned','terminated','former') OR a.id IS NOT NULL)",
    ];
    const whereParams: (string | number)[] = [];

    const q = s(sp.get('q'));
    if (q) {
      const like = `%${q}%`;
      clauses.push(
        '(e.full_name LIKE ? OR e.employee_code LIKE ? OR e.phone10 LIKE ? OR e.email LIKE ?)',
      );
      whereParams.push(like, like, like, like);
    }

    const dept = s(sp.get('department_id'));
    if (dept) {
      clauses.push('(e.department_id = ? OR e.sub_department_id = ?)');
      whereParams.push(dept, dept);
    }

    const where = `WHERE ${clauses.join(' AND ')}`;
    // The summary join is part of the row identity (a.id in the WHERE), so
    // the count query carries the same LEFT JOIN — date binds first.
    const joinAttendance = 'LEFT JOIN hr_attendance a ON a.employee_id = e.id AND a.date = ?';

    const totalRow = db
      .prepare(`SELECT COUNT(*) AS n FROM hr_employees e ${joinAttendance} ${where}`)
      .get(date, ...whereParams) as { n: number };

    const rows = db
      .prepare(
        `SELECT e.id            AS employee_id,
                e.employee_code,
                e.full_name,
                e.department_id,
                e.sub_department_id,
                e.status        AS employee_status,
                d.name          AS department_name,
                sd.name         AS sub_department_name,
                ds.name         AS designation_name,
                COALESCE(a.id, '')                    AS summary_id,
                COALESCE(a.status, 'NOT_CHECKED_IN')  AS status,
                COALESCE(a.first_in, '')              AS first_in,
                COALESCE(a.last_out, '')              AS last_out,
                COALESCE(a.sessions, 0)               AS sessions,
                COALESCE(a.worked_minutes, 0)         AS worked_minutes,
                COALESCE(a.break_minutes, 0)          AS break_minutes,
                COALESCE(a.outside_minutes, 0)        AS outside_minutes,
                COALESCE(a.overtime_minutes, 0)       AS overtime_minutes,
                COALESCE(a.missing_checkout, 0)       AS missing_checkout,
                COALESCE(a.corrected, 0)              AS corrected,
                COALESCE(a.shift_id, '')              AS shift_id,
                COALESCE(a.outlet_id, '')             AS outlet_id,
                COALESCE(a.computed_at, '')           AS computed_at
         FROM hr_employees e
         ${joinAttendance}
         LEFT JOIN departments d      ON d.id  = e.department_id
         LEFT JOIN departments sd     ON sd.id = e.sub_department_id
         LEFT JOIN hr_designations ds ON ds.id = e.designation_id
         ${where}
         ORDER BY e.full_name COLLATE NOCASE, e.id
         LIMIT ? OFFSET ?`,
      )
      .all(date, ...whereParams, pageSize, (page - 1) * pageSize) as any[];

    return Response.json({ rows, total: totalRow.n, page, pageSize, date });
  } catch (e) {
    console.error('GET /api/hr/attendance failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to load attendance' }, { status: 500 });
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
    if (!employee_id) {
      return Response.json({ error: 'Employee is required' }, { status: 400 });
    }
    const reason = s(body?.reason);
    if (!reason) {
      return Response.json(
        { error: 'A reason for the manual punch is required' },
        { status: 400 },
      );
    }
    const event_type = s(body?.event_type);
    if (event_type && !(HR_ATTENDANCE_EVENT_TYPES as readonly string[]).includes(event_type)) {
      return Response.json({ error: 'Invalid event type' }, { status: 400 });
    }
    const at = s(body?.at); // UTC 'YYYY-MM-DD HH:MM[:SS]' or ISO; engine 400s garbage

    // Resolve EVERY await before the transaction — better-sqlite3 is
    // synchronous and an await inside db.transaction() silently breaks
    // atomicity (the Phase 1 rule).
    const actorOutletId = await getCurrentOutletId();

    const db = getDb();

    // Punch + audit are ONE atomic unit. recordAttendanceEvent stamps
    // business_date at write time, debounces (append-only ignored=1), pairs
    // by alternation unless event_type overrides, and recomputes the day.
    const tx = db.transaction(() => {
      const res = recordAttendanceEvent(db, {
        employee_id,
        source: 'manual',
        at: at || undefined,
        event_type: event_type || undefined,
        reason,
        created_by: me.email,
      });
      // Manual punches ARE audited (human state change); import rows are not
      // (per-punch — the event table is its own log). Contract §4/audit note.
      logAuditEvent(db, {
        event_type: 'hr.attendance.manual_punch',
        entity_type: 'hr_attendance_event',
        entity_id: res.event.id,
        actor_email: me.email,
        outlet_id: actorOutletId,
        after: {
          employee_id,
          event_type: res.event.event_type,
          at: res.event.at,
          business_date: res.event.business_date,
          source: 'manual',
          ignored: res.event.ignored,
          ignored_reason: res.event.ignored_reason,
        },
        note: reason,
      });
      return res;
    });

    let result: ReturnType<typeof recordAttendanceEvent>;
    try {
      result = tx();
    } catch (e) {
      const mapped = engineErrorResponse(e);
      if (mapped) return mapped;
      throw e;
    }

    return Response.json({ event: result.event, summary: result.summary });
  } catch (e) {
    console.error('POST /api/hr/attendance failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to record the punch' }, { status: 500 });
  }
}
