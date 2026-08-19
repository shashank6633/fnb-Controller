/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { canManageHr } from '@/lib/hr';
import { currentBusinessDate, recomputeDay } from '@/lib/hr-attendance';
import { HR_EMPLOYEE_SELECT, HR_EMPLOYEE_JOINS, rowToEmployee } from '@/lib/hr-server';
import { reportServerError } from '@/lib/error-alerts';

/**
 * One employee's attendance day (/api/hr/attendance/:employeeId) — Phase 2.
 * Contract: docs/HRMS_DECISIONS.md §8.2/§8.5.
 *
 * GET ?date=YYYY-MM-DD  → { employee, summary, events }
 *   · employee — the Phase 1 list projection (joined department /
 *     sub-department / designation names, linked_user_email, has_photo — no
 *     photo blob on this read).
 *   · summary  — the hr_attendance row for that BUSINESS date. When the day
 *     has no row yet, a virtual NOT_CHECKED_IN summary (id '') is returned so
 *     the client renders uniformly — nothing is written by reading. A stale
 *     open day (status still PRESENT after the business day closed — a
 *     dangling IN left overnight) is recomputed on read, flipping it to
 *     MISSING_CHECKOUT exactly as the register sweep would.
 *   · events   — the day's FULL append-only timeline, chronological,
 *     INCLUDING ignored (debounced) punches — each row carries its own
 *     ignored / ignored_reason flags. `at` values are UTC; render via fmtIST.
 *
 * `date` defaults to the current business date (hr_day_cutoff-shifted).
 *
 * Gate: canManageHr — the proxy does NOT protect API GETs; this handler is
 * the security boundary (HRMS_DECISIONS §2.1). Errors are GENERIC on the
 * wire; details go to the server log only.
 */
export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ employeeId: string }> },
) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }

  try {
    const { employeeId } = await params;
    const sp = new URL(request.url).searchParams;

    const rawDate = String(sp.get('date') ?? '').trim();
    if (rawDate && !DATE_RE.test(rawDate)) {
      return Response.json({ error: 'Invalid date (expected YYYY-MM-DD)' }, { status: 400 });
    }

    const db = getDb();
    const date = rawDate || currentBusinessDate(db);

    const raw = db
      .prepare(`${HR_EMPLOYEE_SELECT} ${HR_EMPLOYEE_JOINS} WHERE e.id = ?`)
      .get(employeeId) as any;
    if (!raw) return Response.json({ error: 'Employee not found' }, { status: 404 });
    const employee = rowToEmployee(raw);

    let summary = db
      .prepare('SELECT * FROM hr_attendance WHERE employee_id = ? AND date = ?')
      .get(employeeId, date) as any;

    // Self-heal a day that flipped from open to closed since it was last
    // computed: PRESENT on a finished business day means a dangling IN was
    // left overnight — recompute flips it to MISSING_CHECKOUT (§8.2.5). Same
    // rule as sweepStaleOpenDays, scoped to the one day being read.
    if (summary && summary.status === 'PRESENT' && date < currentBusinessDate(db)) {
      summary = recomputeDay(db, employeeId, date).summary;
    }

    // No punches and no correction ever touched this day → nothing stored.
    // Hand back a VIRTUAL summary (id '') instead of null so the client shape
    // is constant; deliberately NOT persisted — a read must not write rows.
    if (!summary) {
      summary = {
        id: '',
        employee_id: employeeId,
        outlet_id: '',
        date,
        status: 'NOT_CHECKED_IN',
        first_in: '',
        last_out: '',
        sessions: 0,
        worked_minutes: 0,
        break_minutes: 0,
        outside_minutes: 0,
        overtime_minutes: 0,
        shift_id: '',
        missing_checkout: 0,
        corrected: 0,
        computed_at: '',
      };
    }

    // Chronological, ignored punches INCLUDED (flagged by their own columns)
    // — same ordering the pairing engine walks, so what the reviewer sees is
    // what the summary was computed from.
    const events = db
      .prepare(
        `SELECT * FROM hr_attendance_events
         WHERE employee_id = ? AND business_date = ?
         ORDER BY at, created_at, id`,
      )
      .all(employeeId, date) as any[];

    return Response.json({ employee, summary, events, date });
  } catch (e) {
    console.error('GET /api/hr/attendance/[employeeId] failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to load attendance detail' }, { status: 500 });
  }
}
